import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { logger } from "~/server/logging/logger.server";
import {
  deleteSetting,
  getSetting,
  setSetting,
} from "~/server/settings/instance-settings.server";

/**
 * Backend quota/rate-limit visibility (pass 29, critique gap 3.2 — owner
 * "build it now").
 *
 * Quota exhaustion used to be PURELY reactive: the first anyone learned that a
 * subscription was running dry was a failed run classified `"quota"` and a
 * "Work stalled" recovery packet — after the run was already spent. Yet the
 * Claude SDK reports utilization LIVE on every run (`rate_limit_event`
 * envelopes carrying `rate_limit_info`), and those already flow through the
 * run sink; they were persisted into run-log lines and read by no one.
 *
 * This module keeps the LATEST observed rate-limit reading per backend in the
 * generic `instance_settings` KV store ("the next instance knob is a key, not
 * a column" — instance-settings.server.ts, whose get/set/delete accessors this
 * module uses rather than re-deriving the same tolerant parse and upsert). The
 * sink records; Insights reads.
 *
 * Honesty rules, same shape as `backends` on /resources/health (R17-5):
 *  - a backend with NO reading renders neutral ("no reading yet"), never as
 *    healthy or alarming — this is an observation log, not a probe;
 *  - readings carry `observedAt` so a stale one is visibly stale, not current;
 *  - recording is best-effort and never fails a run line.
 *
 * ## D5 (pass 31): the exhaustion the card could not see
 *
 * The live `rate_limit_event` channel is CLAUDE-only. A Codex subscription that
 * is already spent never emits one — it fails the run with a sentence naming
 * the limit and the date it reopens ("You've hit your usage limit … try again
 * at Sep 18th, 2026 5:20 PM"). So the panel read "no reading yet" for codex on
 * an instance where every codex run had been refused for days, with the reset
 * date sitting in the failed run's own timeline.
 *
 * A run failure is NOT a utilization reading, and this module refuses to
 * pretend otherwise: exhaustion is recorded under its OWN key with the run id
 * and the provider's sentence that produced it, and the panel labels it as
 * derived from a failed run. It is a second, weaker kind of evidence rendered
 * as itself — never folded into `utilization`, which would invent a number the
 * provider never reported.
 */

const KEY_PREFIX = "backendRateLimit.";
const EXHAUSTED_KEY_PREFIX = "backendQuotaExhausted.";

export const BACKENDS = ["claude", "codex"] as const;
export type QuotaBackend = (typeof BACKENDS)[number];

const readingSchema = z.object({
  /** Provider's own status word (e.g. "allowed", "allowed_warning"). */
  status: z.string(),
  /** e.g. "seven_day" | "five_hour" — the window the reading is about. */
  rateLimitType: z.string(),
  /** 0..1 fraction of the window consumed; null when the provider omits it. */
  utilization: z.number().nullable(),
  /** Unix seconds when the window resets; null when omitted. */
  resetsAt: z.number().nullable(),
  isUsingOverage: z.boolean(),
  /** ISO instant of the run line that carried this reading. */
  observedAt: z.string(),
});
export type BackendRateLimitReading = z.infer<typeof readingSchema>;

/**
 * D5: the provider REFUSED a run on this backend for being over its limit.
 * Derived from that failure, never from a utilization reading — so it carries
 * the run it came from and the provider's own sentence as its evidence.
 */
const exhaustionSchema = z.object({
  /** Unix seconds when the provider said the window reopens; null when its
   *  message named no date (then only `observedAt` bounds the claim). */
  resetsAt: z.number().nullable(),
  /** How `resetsAt` was derived — `"exact"` for a machine instant the provider
   *  emitted, `"prose"` for one reconstructed from wall-clock words whose
   *  timezone it never named. Records written before this field existed parse
   *  as null and are treated exactly like `"prose"`: unknown provenance gets
   *  the conservative handling, never the precise one. */
  resetsAtPrecision: z.enum(["exact", "prose"]).nullable().default(null),
  /** The provider's own already-redacted sentence — the whole evidence. */
  providerText: z.string(),
  /** The failed run this was read off. */
  runId: z.string(),
  /** ISO instant of the failure line that carried it. */
  observedAt: z.string(),
});
export type BackendQuotaExhaustion = z.infer<typeof exhaustionSchema>;

export interface BackendQuotaRow {
  backend: QuotaBackend;
  /** Null until a run on this backend has ever reported a reading. */
  reading: BackendRateLimitReading | null;
  /**
   * D5: set while the last thing this backend told us was "you are over your
   * limit". Cleared by the only honest re-probe there is — a real run that
   * completes (the same rule model availability uses, ruling 19) — and dropped
   * by the reader once the provider's own reset instant has passed (plus a
   * grace window for a prose-derived one) or, for a record that named no reset
   * at all, once it is older than `UNDATED_EXHAUSTION_TTL_MS`.
   */
  exhausted: BackendQuotaExhaustion | null;
}

/**
 * V4 (pass 31): the sentence a `·quota` failure line carries is only sometimes
 * evidence of an EXHAUSTED subscription window.
 *
 * Both runtime classifiers fold four different situations into one `quota`
 * class — `usage limit`, `quota`, `rate limit`, `too many requests`/`429` — and
 * the last two are transient back-pressure that clears in seconds. A momentary
 * 429 recorded as exhaustion has no reset instant to retire it, so /insights
 * showed "usage limit reached" at 100% until some later run happened to finish.
 *
 * So the record is written only when the PROVIDER's own words name a usage or
 * quota window. Generic rate-limit wording is deliberately absent from this
 * pattern: it is the exact text this gate exists to reject.
 */
const USAGE_LIMIT_RE =
  /usage limit|usage quota|\bquota\b|weekly limit|monthly limit|subscription limit|plan limit|out of credits|credit balance/i;

/**
 * The marker both adapters append the provider's own redacted sentence behind
 * (`PROVIDER_TEXT_MARKER` in agent-reply.server, written as this literal by
 * each runtime). Matched here rather than imported: this module rides the
 * run-line persist path, and a static edge into the task layer would close an
 * import cycle (agent-reply → task-actions → operator-run → run-service → the
 * sink → here).
 */
const PROVIDER_TEXT_MARKER = "\n\nThe provider reported: ";

/**
 * The provider's OWN sentence inside a failure line, or the whole line when the
 * adapter had none to add. The canonical half of the line ("Codex usage limit
 * was reached…") is the adapter's role-neutral prose and says "usage limit" for
 * every member of the class, transient ones included — so judging the whole
 * line would defeat `USAGE_LIMIT_RE` entirely.
 */
function providerSentence(text: string): string {
  const idx = text.indexOf(PROVIDER_TEXT_MARKER);
  return idx >= 0 ? text.slice(idx + PROVIDER_TEXT_MARKER.length).trim() : text.trim();
}

/** The provider's sentence when it evidences a SPENT usage window, else null —
 *  the one call the recording seam makes, so a caller cannot accidentally judge
 *  the adapter's canonical prose instead of the provider's own words. */
export function quotaExhaustionEvidence(text: string): string | null {
  const sentence = providerSentence(text);
  return USAGE_LIMIT_RE.test(sentence) ? sentence : null;
}

/** The reset instant a provider named, and how much the number is worth. */
export interface QuotaReset {
  /** Unix SECONDS. */
  at: number;
  /**
   * `"exact"` — the provider emitted a machine instant (a unix epoch), so this
   * IS the moment the window reopens.
   *
   * `"prose"` — reconstructed from wall-clock words ("Sep 18th, 2026 5:20 PM")
   * whose timezone the provider never states; the docstring for the Codex shape
   * says it is the ACCOUNT's timezone, which this process does not know. The
   * components are resolved as if they were UTC, which places the derived
   * instant at most 12 hours BEFORE the true one (UTC-12 is the westernmost
   * real offset) and up to 14 hours after it. Only the early side can retire a
   * still-open exhaustion record, so `QUOTA_RESET_GRACE_MS` covers it — and the
   * panel renders a prose reset as a calendar DATE, never as a wall-clock time
   * we would be stating with unearned confidence.
   */
  precision: "exact" | "prose";
}

const MONTHS = [
  "jan", "feb", "mar", "apr", "may", "jun",
  "jul", "aug", "sep", "oct", "nov", "dec",
] as const;

/** "Sep 18th, 2026" / "September 18 2026" — month first, the Codex shape. */
const MONTH_FIRST_RE = /\b([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/i;
/** "18 Sep 2026" — the same date the other way round. */
const DAY_FIRST_RE = /\b(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})\.?,?\s+(\d{4})\b/i;
/** A bare calendar date, already unambiguous. */
const ISO_DATE_RE = /\b(\d{4})-(\d{2})-(\d{2})\b/;
/** "5:20 PM" / "17:20" — optional; a date with no time resolves to midnight. */
const TIME_RE = /\b(\d{1,2}):(\d{2})\s*(am|pm)?/i;

function monthIndex(name: string): number {
  const key = name.slice(0, 3).toLowerCase();
  return MONTHS.findIndex((m) => m === key);
}

/** The named wall clock as an instant, resolving its components in UTC. Null
 *  when the phrase names no date this understands — always an acceptable
 *  answer, and far better than a confident wrong one. */
function proseInstantMs(phrase: string): number | null {
  let year: number;
  let month: number;
  let day: number;
  const monthFirst = MONTH_FIRST_RE.exec(phrase);
  const dayFirst = monthFirst ? null : DAY_FIRST_RE.exec(phrase);
  const iso = monthFirst || dayFirst ? null : ISO_DATE_RE.exec(phrase);
  if (monthFirst) {
    month = monthIndex(monthFirst[1]!);
    day = Number(monthFirst[2]);
    year = Number(monthFirst[3]);
  } else if (dayFirst) {
    day = Number(dayFirst[1]);
    month = monthIndex(dayFirst[2]!);
    year = Number(dayFirst[3]);
  } else if (iso) {
    year = Number(iso[1]);
    month = Number(iso[2]) - 1;
    day = Number(iso[3]);
  } else {
    return null;
  }
  // A word in a month's position that is not a month (the regexes match any
  // 3-9 letter run) is not a date at all.
  if (month < 0 || month > 11 || day < 1 || day > 31) return null;

  let hours = 0;
  let minutes = 0;
  const time = TIME_RE.exec(phrase);
  if (time) {
    hours = Number(time[1]);
    minutes = Number(time[2]);
    const meridiem = time[3]?.toLowerCase();
    if (meridiem === "pm" && hours < 12) hours += 12;
    if (meridiem === "am" && hours === 12) hours = 0;
    if (hours > 23 || minutes > 59) return null;
  }
  return Date.UTC(year, month, day, hours, minutes);
}

/**
 * The reset instant a provider's usage-limit sentence names, or null when it
 * names none. Two shapes are in the wild:
 *
 *  - Codex: "… or try again at Sep 18th, 2026 5:20 PM." — English, in the
 *    ACCOUNT's own timezone, with an ordinal suffix `Date.parse` chokes on.
 *    Resolved component-by-component in UTC (never `Date.parse`, which would
 *    silently answer in whatever timezone the SERVER happens to run in — a
 *    container is usually UTC, a laptop is not, and the same message would
 *    retire the record at different moments on the two).
 *  - Claude: "Claude AI usage limit reached|1750000000" — a bare unix epoch
 *    after a pipe, which needs no interpretation at all.
 *
 * The returned `precision` says which of those happened, so the reader can be
 * conservative about the derived one and the panel can render it honestly.
 *
 * Exported for its test: this is a parse of PROVIDER prose, so it is the part
 * most likely to drift, and a wrong answer here would put a confident wrong
 * date on the card. Null is always an acceptable answer — the card falls back
 * to "observed <when>".
 */
export function parseQuotaResetAt(text: string): QuotaReset | null {
  const epoch = /usage limit reached\|(\d{9,13})/i.exec(text);
  if (epoch) {
    const n = Number(epoch[1]);
    if (!Number.isFinite(n)) return null;
    // 13 digits is milliseconds (the shape Claude has also emitted); 10 is
    // seconds. Normalize to seconds, which is what `resetsAt` means here.
    const at = epoch[1]!.length >= 12 ? Math.round(n / 1000) : Math.round(n);
    return { at, precision: "exact" };
  }
  const phrase = /try again(?:\s+(?:at|on))?\s+([^.\n]+)/i.exec(text);
  if (!phrase) return null;
  const ms = proseInstantMs(phrase[1]!);
  if (ms == null || !Number.isFinite(ms)) return null;
  return { at: Math.round(ms / 1000), precision: "prose" };
}

/** Store the latest reading for a backend. Best-effort: a failure is logged and
 *  swallowed — quota telemetry must never break the run-line persist path. */
export function recordBackendRateLimit(
  db: DatabaseSync,
  backend: QuotaBackend,
  reading: BackendRateLimitReading,
): void {
  try {
    setSetting(db, `${KEY_PREFIX}${backend}`, reading);
  } catch (error) {
    logger.warn("backend rate-limit reading not recorded", {
      backend,
      err: error instanceof Error ? error : new Error(String(error)),
    });
  }
}

/** D5: a run on this backend was REFUSED for being over its limit. Best-effort,
 *  exactly like `recordBackendRateLimit` — this rides the run-line persist path
 *  and must never be able to fail it. */
export function recordBackendQuotaExhaustion(
  db: DatabaseSync,
  backend: QuotaBackend,
  exhaustion: BackendQuotaExhaustion,
): void {
  try {
    setSetting(db, `${EXHAUSTED_KEY_PREFIX}${backend}`, exhaustion);
  } catch (error) {
    logger.warn("backend quota exhaustion not recorded", {
      backend,
      err: error instanceof Error ? error : new Error(String(error)),
    });
  }
}

/**
 * D5: a run on this backend just COMPLETED, so the account is demonstrably not
 * refusing work any more. That real run is the re-probe (ruling 19's rule for
 * model availability, applied to the same kind of claim) — there is no synthetic
 * check, and none is wanted. Best-effort.
 */
export function clearBackendQuotaExhaustion(
  db: DatabaseSync,
  backend: QuotaBackend,
): void {
  try {
    deleteSetting(db, `${EXHAUSTED_KEY_PREFIX}${backend}`);
  } catch (error) {
    logger.warn("backend quota exhaustion not cleared", {
      backend,
      err: error instanceof Error ? error : new Error(String(error)),
    });
  }
}

/**
 * How long a PROSE-derived reset instant is trusted past the moment it names.
 *
 * The named wall clock is resolved in UTC (see `QuotaReset`), which can place
 * the derived instant up to 12 hours before the true one. Retiring the record
 * early is the failure that matters — it says "the window reopened" while the
 * provider is still refusing every run — so a full day of slack is bought for
 * the cost of showing a spent window slightly too long.
 */
const QUOTA_RESET_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * How long an exhaustion record that named NO reset instant is trusted.
 *
 * V4: the recording gate keeps transient back-pressure out of this store, but a
 * record with no reset instant used to be retired by nothing except a later
 * COMPLETED run on the same backend — so on an instance where the next run
 * never happened, one refusal claimed a spent window forever. Provider windows
 * are hours, not days; past this age the record is stale evidence and the panel
 * falls back to whatever the backend has actually reported since.
 */
const UNDATED_EXHAUSTION_TTL_MS = 6 * 60 * 60 * 1000;

/** Is this record no longer evidence of anything? A non-finite `nowMs` (an
 *  unparseable caller instant) answers "no": nothing is dropped on a clock we
 *  could not read. */
function exhaustionExpired(
  stored: BackendQuotaExhaustion,
  nowMs: number,
): boolean {
  if (!Number.isFinite(nowMs)) return false;
  if (stored.resetsAt != null) {
    const grace =
      stored.resetsAtPrecision === "exact" ? 0 : QUOTA_RESET_GRACE_MS;
    return stored.resetsAt * 1000 + grace <= nowMs;
  }
  const observedMs = Date.parse(stored.observedAt);
  return (
    Number.isFinite(observedMs) && observedMs + UNDATED_EXHAUSTION_TTL_MS <= nowMs
  );
}

/**
 * The latest reading per backend; `reading: null` when none was ever seen.
 *
 * `nowIso` (the caller's generated-at instant) retires an exhaustion record once
 * the provider's OWN reset instant has passed: the window it named is over, so
 * continuing to show it would be a claim the evidence no longer supports. A
 * prose-derived instant gets `QUOTA_RESET_GRACE_MS` first (its timezone is
 * unknown), and a record that named no instant at all expires on age
 * (`UNDATED_EXHAUSTION_TTL_MS`) rather than waiting for a completed run.
 */
export function latestBackendRateLimits(
  db: DatabaseSync,
  nowIso?: string,
): BackendQuotaRow[] {
  const nowMs = nowIso ? Date.parse(nowIso) : Date.now();
  return BACKENDS.map((backend) => {
    const reading = getSetting(db, `${KEY_PREFIX}${backend}`, readingSchema);
    const stored = getSetting(
      db,
      `${EXHAUSTED_KEY_PREFIX}${backend}`,
      exhaustionSchema,
    );
    const expired = stored != null && exhaustionExpired(stored, nowMs);
    return { backend, reading, exhausted: expired ? null : stored };
  });
}
