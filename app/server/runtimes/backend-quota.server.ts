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
const CREDENTIAL_REFUSED_KEY_PREFIX = "backendCredentialRefused.";

export const BACKENDS = ["claude", "codex"] as const;
export type QuotaBackend = (typeof BACKENDS)[number];

/** Ruling 130(d) (pass 34): WHOSE account a record is about. Under ruling 127
 *  a run bills one person's credential, so an instance-wide row that named no
 *  principal presented one person's refusal as everyone's. Stripped from the
 *  unauthenticated health body (`stripQuotaPrincipals`); shown to org admins
 *  on Insights, to the asker on `instance_health`, and to the person on their
 *  own Profile card. */
const principalFields = {
  credentialUserId: z.string().nullable().default(null),
  credentialLabel: z.string().nullable().default(null),
};

const readingSchema = z.object({
  ...principalFields,
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
  ...principalFields,
  /** Unix seconds when the provider said the window reopens; null when its
   *  message named no date (then only `observedAt` bounds the claim). */
  resetsAt: z.number().nullable(),
  /** How `resetsAt` was derived — `"exact"` for a machine instant the provider
   *  emitted (or the SDK's own `resetsAt`), `"prose"` for one reconstructed
   *  from wall-clock words whose timezone it never named, `"clock"` (ruling
   *  130(d)) for a UTC wall-clock time ("resets 11:50am (UTC)") resolved to the
   *  next occurrence at or after the observation. Records written before this
   *  field existed parse as null and are treated exactly like `"prose"`:
   *  unknown provenance gets the conservative handling, never the precise one. */
  resetsAtPrecision: z.enum(["exact", "prose", "clock"]).nullable().default(null),
  /** The provider's own already-redacted sentence — the whole evidence. */
  providerText: z.string(),
  /** The failed run this was read off. */
  runId: z.string(),
  /** ISO instant of the failure line that carried it. */
  observedAt: z.string(),
});
export type BackendQuotaExhaustion = z.infer<typeof exhaustionSchema>;

/**
 * F32-4 (pass 32): the provider REFUSED a run on this backend for its
 * CREDENTIAL — an expired refresh token, a revoked key, a 401. The connection
 * counts on the health probe and `userBackendHealth` judge row/file PRESENCE
 * only (ruling 78: no synthetic token probe; ruling 127 made the reading
 * per-person without changing that), so after a real refusal both kept
 * answering "connected" and the controller told the admin the credential was
 * fine ten minutes after a run had died on it. Same shape as
 * exhaustion: derived from the failed run, carrying its id and the provider's
 * own sentence; retired by the next run that COMPLETES on the backend (the real
 * run is the re-probe) or by the person it names changing that credential
 * (ruling 165, `retireBackendRecordsFor`), and by nothing else — a dead
 * credential does not heal with time.
 */
const credentialRefusalSchema = z.object({
  ...principalFields,
  /** The provider's own already-redacted sentence — the whole evidence. */
  providerText: z.string(),
  /** The failed run this was read off. */
  runId: z.string(),
  /** ISO instant of the failure line that carried it. */
  observedAt: z.string(),
});
export type BackendCredentialRefusal = z.infer<typeof credentialRefusalSchema>;

export interface BackendQuotaRow {
  backend: QuotaBackend;
  /** Null until a run on this backend has ever reported a reading. */
  reading: BackendRateLimitReading | null;
  /**
   * F32-4: set while the last thing this backend told us was "your credential
   * is not accepted". Cleared by a run that completes on the backend, or by the
   * person it names changing their credential on it (ruling 165).
   */
  credentialRefused: BackendCredentialRefusal | null;
  /**
   * D5: set while the last thing this backend told us was "you are over your
   * limit". Cleared by the only honest re-probe there is — a real run that
   * completes (the same rule model availability uses, ruling 19) — by the
   * person it names changing their credential on the backend (ruling 165), by
   * the packet option that states the window has reset (ruling 152(c)), and
   * dropped by the reader once the provider's own reset instant has passed
   * (plus a grace window for a prose-derived one) or, for a record that named
   * no reset at all, once it is older than `UNDATED_EXHAUSTION_TTL_MS`.
   */
  exhausted: BackendQuotaExhaustion | null;
  /**
   * Ruling 481(d) (F40-50): the window `reading` describes has reset since it
   * was read (`readingWindowReset`). The reading is kept, as history, but no
   * surface presents its utilization as current: Profile and Insights word it
   * in the past tense and draw no bar. Optional so row fixtures that predate
   * it stay valid (absent reads as false); `latestBackendRateLimits` always
   * sets it.
   */
  readingWindowReset?: boolean;
}

/**
 * Ruling 481(d) (F40-50): has the window this reading was read in reset?
 *
 * Only an exhaustion used to age against its reset (`exhaustionExpired`); a
 * reading was returned untouched, so on an idle instance Profile said "The
 * window resets 03:30" and Insights drew "92% of five hour · resets 03:30"
 * hours after that window closed, which reads as a nearly spent window about
 * to reset. A reading's `resetsAt` is the provider's own epoch, so no grace
 * applies. A reading that named no reset, or a clock we could not read,
 * answers "no": nothing is aged on a guess.
 */
export function readingWindowReset(
  reading: Pick<BackendRateLimitReading, "resetsAt"> | null,
  nowMs: number,
): boolean {
  if (!reading || reading.resetsAt == null || !Number.isFinite(nowMs)) return false;
  return reading.resetsAt * 1000 <= nowMs;
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
  /usage limit|usage quota|\bquota\b|session limit|weekly limit|monthly limit|subscription limit|plan limit|out of credits|credit balance/i;

// The marker both adapters append the provider's own redacted sentence behind.
// P07-C (pass 32): imported from the leaf `~/shared/provider-marker` module —
// no edge into the task layer (the import cycle the old private copy avoided),
// and no second literal to drift.
import { PROVIDER_TEXT_MARKER } from "~/shared/provider-marker";
import { toError } from "~/shared/errors";

/**
 * The provider's OWN sentence inside a failure line, or the whole line when the
 * adapter had none to add. The canonical half of the line ("Codex usage limit
 * was reached…") is the adapter's role-neutral prose and says "usage limit" for
 * every member of the class, transient ones included — so judging the whole
 * line would defeat `USAGE_LIMIT_RE` entirely.
 */
export function providerSentence(text: string): string {
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
  precision: "exact" | "prose" | "clock";
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
 *  - Codex, five-hour window: "… or try again at 6:18 PM." — a time with no
 *    date, printed in the local zone of the process that ran the CLI
 *    (G35-4). Resolved with the process's own local setters to the next
 *    occurrence at or after the observation; precision `clock`.
 *
 * The returned `precision` says which of those happened, so the reader can be
 * conservative about the derived one and the panel can render it honestly.
 *
 * Exported for its test: this is a parse of PROVIDER prose, so it is the part
 * most likely to drift, and a wrong answer here would put a confident wrong
 * date on the card. Null is always an acceptable answer — the card falls back
 * to "observed <when>".
 */
export function parseQuotaResetAt(text: string, observedAtIso?: string): QuotaReset | null {
  const epoch = /usage limit reached\|(\d{9,13})/i.exec(text);
  if (epoch) {
    const n = Number(epoch[1]);
    if (!Number.isFinite(n)) return null;
    // 13 digits is milliseconds (the shape Claude has also emitted); 10 is
    // seconds. Normalize to seconds, which is what `resetsAt` means here.
    const at = epoch[1]!.length >= 12 ? Math.round(n / 1000) : Math.round(n);
    return { at, precision: "exact" };
  }
  // Ruling 130(d): the UTC wall-clock shape Claude's session-limit refusal
  // uses ("resets 11:50am (UTC)"): the next occurrence at or after the
  // observation, precision `clock` (a real UTC time, rendered to the minute,
  // retired with the prose grace because the day is inferred).
  const clock = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(UTC\)/i.exec(text);
  if (clock) {
    const hour12 = Number(clock[1]);
    const minute = clock[2] ? Number(clock[2]) : 0;
    const pm = clock[3]!.toLowerCase() === "pm";
    if (hour12 >= 1 && hour12 <= 12 && minute >= 0 && minute < 60) {
      const hour = (hour12 % 12) + (pm ? 12 : 0);
      const observedMs = observedAtIso ? Date.parse(observedAtIso) : Date.now();
      const base = Number.isFinite(observedMs) ? new Date(observedMs) : new Date();
      let at = Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), hour, minute);
      if (at < base.getTime()) at += 24 * 60 * 60 * 1000;
      return { at: Math.round(at / 1000), precision: "clock" };
    }
  }
  const phrase = /try again(?:\s+(?:at|on))?\s+([^.\n]+)/i.exec(text);
  if (!phrase) return null;
  const ms = proseInstantMs(phrase[1]!);
  if (ms != null && Number.isFinite(ms)) {
    return { at: Math.round(ms / 1000), precision: "prose" };
  }
  // G35-4 (pass 35, ruling 152(c)): the TIME-ONLY shape a five-hour Codex
  // window refuses with ("try again at 6:18 PM"): no month, no day, no zone.
  // The Codex CLI prints the wall clock of the PROCESS that ran it (verified
  // live: "6:18 PM" in a UTC container was 18:18Z), so the hour is resolved
  // with the process's own local setters, never `Date.UTC`, at the next
  // occurrence at or after the observation. Precision `clock`: a real
  // to-the-minute time on an inferred day.
  const timeOnly = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i.exec(phrase[1]!.trim());
  if (!timeOnly) return null;
  const hourRaw = Number(timeOnly[1]);
  const minute = timeOnly[2] ? Number(timeOnly[2]) : 0;
  const meridiem = timeOnly[3]?.toLowerCase() ?? null;
  const hourOk = meridiem ? hourRaw >= 1 && hourRaw <= 12 : hourRaw >= 0 && hourRaw <= 23;
  if (!hourOk || minute < 0 || minute > 59) return null;
  const hour = meridiem ? (hourRaw % 12) + (meridiem === "pm" ? 12 : 0) : hourRaw;
  const observedMs = observedAtIso ? Date.parse(observedAtIso) : Date.now();
  const base = Number.isFinite(observedMs) ? new Date(observedMs) : new Date();
  const local = new Date(base.getTime());
  local.setHours(hour, minute, 0, 0);
  if (local.getTime() < base.getTime()) local.setDate(local.getDate() + 1);
  return { at: Math.round(local.getTime() / 1000), precision: "clock" };
}

/** Ruling 130(d): the rows without their principal, for the unauthenticated
 *  health body (which documents "never data"). */
export function stripQuotaPrincipals(rows: BackendQuotaRow[]): BackendQuotaRow[] {
  const strip = <T extends { credentialUserId: string | null; credentialLabel: string | null }>(
    record: T | null,
  ): T | null => (record ? { ...record, credentialUserId: null, credentialLabel: null } : null);
  return rows.map((row) => ({
    ...row,
    reading: strip(row.reading),
    exhausted: strip(row.exhausted),
    credentialRefused: strip(row.credentialRefused),
  }));
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
      err: toError(error),
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
      err: toError(error),
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
      err: toError(error),
    });
  }
}

/** F32-4: a run on this backend was REFUSED for its credential. Best-effort,
 *  exactly like the quota writers — this rides the run-line persist path. */
export function recordBackendCredentialRefusal(
  db: DatabaseSync,
  backend: QuotaBackend,
  refusal: BackendCredentialRefusal,
): void {
  try {
    setSetting(db, `${CREDENTIAL_REFUSED_KEY_PREFIX}${backend}`, refusal);
  } catch (error) {
    logger.warn("backend credential refusal not recorded", {
      backend,
      err: toError(error),
    });
  }
}

/** F32-4: a run COMPLETED on this backend, so its credential is demonstrably
 *  accepted again. Best-effort. */
export function clearBackendCredentialRefusal(
  db: DatabaseSync,
  backend: QuotaBackend,
): void {
  try {
    deleteSetting(db, `${CREDENTIAL_REFUSED_KEY_PREFIX}${backend}`);
  } catch (error) {
    logger.warn("backend credential refusal not cleared", {
      backend,
      err: toError(error),
    });
  }
}

/**
 * Ruling 165: the person the records name changed their credential slot on
 * this backend — a confirmed sign-in, a pasted key, a disconnect, an account
 * removal — so an exhaustion or credential refusal observed on the PREVIOUS
 * credential is no longer evidence about the one that bills the next run.
 * Live (2026-09-07) a Claude card kept "usage window spent · reopens 21:30"
 * after its owner signed the backend into another account: the runs went
 * through and the notice contradicted them, because a completed run was the
 * record's only retirement short of the instant the OLD account had named.
 *
 * Scoped like the dispatch hold (ruling 146): only a record naming THIS person
 * is retired. A record naming somebody else, or nobody (a row older than
 * ruling 130(d)), is untouched — nothing here knows whose account it was
 * about. Signing back into the SAME spent account retires it too: Viberr never
 * stores the vendor identity behind a sign-in (ruling 127), so it cannot tell,
 * and one refused run re-records the window, which is cheaper than a notice
 * that lies about a new account. The dispatch hold rests on the same record,
 * so it lifts with it: the next run on the new credential is the real probe.
 *
 * Best-effort, like every writer here: a credential change must never fail on
 * observation housekeeping.
 */
export function retireBackendRecordsFor(
  db: DatabaseSync,
  backend: QuotaBackend,
  credentialUserId: string,
): void {
  try {
    const exhausted = getSetting(db, `${EXHAUSTED_KEY_PREFIX}${backend}`, exhaustionSchema);
    if (exhausted?.credentialUserId === credentialUserId) {
      deleteSetting(db, `${EXHAUSTED_KEY_PREFIX}${backend}`);
    }
    const refused = getSetting(
      db,
      `${CREDENTIAL_REFUSED_KEY_PREFIX}${backend}`,
      credentialRefusalSchema,
    );
    if (refused?.credentialUserId === credentialUserId) {
      deleteSetting(db, `${CREDENTIAL_REFUSED_KEY_PREFIX}${backend}`);
    }
    // Ruling 294 (F37-129): the UTILIZATION READING goes with the account too,
    // and it did not. Ruling 165's own sentence is "the refusal Viberr observed
    // on the slot goes with it" — and a reading is an observation ABOUT that
    // slot in exactly the same way. It was applied to two of the three records
    // this module keeps and not the third, which is this pass's shape a fourth
    // time.
    //
    // What that cost, live and visible while this was written: the owner
    // connected a Claude account with a fresh window, and /insights went on
    // reading "claude · 95% of seven day · resets Sep 17" — a number about an
    // account no longer connected, on the surface a person checks precisely to
    // decide whether there is room to run. The refusal beside it retired
    // correctly; only the percentage lied.
    //
    // A reading is never "stale but roughly right" after a credential change:
    // a new account's window has no relationship to the old one's. There is
    // nothing to degrade to, so it is deleted rather than aged — the card and
    // the panel both read an ABSENT reading as "nothing observed yet", which is
    // the truth until the first run on the new account reports one.
    const reading = getSetting(db, `${KEY_PREFIX}${backend}`, readingSchema);
    if (reading?.credentialUserId === credentialUserId) {
      deleteSetting(db, `${KEY_PREFIX}${backend}`);
    }
  } catch (error) {
    logger.warn("backend refusal records not retired on credential change", {
      backend,
      err: toError(error),
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
 * (`UNDATED_EXHAUSTION_TTL_MS`) rather than waiting for a completed run. The
 * same instant marks a reading whose own window has reset
 * (`readingWindowReset`, ruling 481(d)): the one home Profile and Insights
 * both read, so neither presents a closed window as current.
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
    const credentialRefused = getSetting(
      db,
      `${CREDENTIAL_REFUSED_KEY_PREFIX}${backend}`,
      credentialRefusalSchema,
    );
    return {
      backend,
      reading,
      credentialRefused,
      exhausted: expired ? null : stored,
      readingWindowReset: readingWindowReset(reading, nowMs),
    };
  });
}

/**
 * G35-4 / ruling 152(c) (pass 35): the hold a dispatch must honour.
 *
 * Live, nine Codex deliveries were dispatched one after another into a window
 * the instance had already recorded as spent: each paid a clone, an adapter
 * spawn, a refused run, an operator turn and a "Work stalled" packet for a
 * failure the health body was already displaying. This is the ONE read a
 * dispatch makes before it spends anything.
 *
 * A hold stands while the stored exhaustion has not passed the instant the
 * provider named (`resetsAt`), or, when the provider named none, for
 * `UNDATED_HOLD_MS` after the observation. No grace window: the hold trusts
 * the provider's instant (the Insights card keeps its grace, because
 * SHOWING a spent window too long is cheap and holding a dispatch too long
 * is not).
 *
 * Ruling 146: a refusal is a statement about ONE person's account, so a hold
 * applies to the account it names. Pass the principal the dispatch would
 * bill: a record naming a different person holds nothing for this one, and a
 * record naming nobody (an older row) holds every dispatch on the backend.
 */
export interface BackendDispatchHold {
  /** Unix MILLISECONDS the window reopens; null when the provider named none
   *  (then the hold ends `UNDATED_HOLD_MS` after `observedAt`). */
  until: number | null;
  /** The provider's own sentence, for the note a human reads. */
  providerText: string;
  /** ISO instant of the refusal the hold rests on. */
  observedAt: string;
}

/** How long a dispatch is held on an exhaustion that named no reset instant:
 *  long enough to stop the live cascade, short enough that a transient
 *  reading never parks a task for the afternoon. */
export const UNDATED_HOLD_MS = 30 * 60_000;

export function backendDispatchHold(
  db: DatabaseSync,
  backend: QuotaBackend,
  input: {
    nowMs?: number;
    /** The user the dispatch bills (ruling 127); the hold is scoped to it. */
    credentialUserId: string;
  },
): BackendDispatchHold | null {
  const stored = getSetting(db, `${EXHAUSTED_KEY_PREFIX}${backend}`, exhaustionSchema);
  if (!stored) return null;
  if (stored.credentialUserId !== null && stored.credentialUserId !== input.credentialUserId) {
    return null;
  }
  const nowMs = input.nowMs ?? Date.now();
  if (!Number.isFinite(nowMs)) return null;
  if (stored.resetsAt != null) {
    const until = stored.resetsAt * 1000;
    if (until <= nowMs) return null;
    return { until, providerText: stored.providerText, observedAt: stored.observedAt };
  }
  const observedMs = Date.parse(stored.observedAt);
  if (!Number.isFinite(observedMs) || observedMs + UNDATED_HOLD_MS <= nowMs) return null;
  return { until: null, providerText: stored.providerText, observedAt: stored.observedAt };
}
