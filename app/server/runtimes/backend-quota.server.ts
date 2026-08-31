import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { logger } from "~/server/logging/logger.server";

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
 * a column" — instance-settings.server.ts). The sink records; Insights reads.
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
   * by the reader once the provider's own reset instant has passed.
   */
  exhausted: BackendQuotaExhaustion | null;
}

/**
 * The reset instant a provider's usage-limit sentence names, as unix SECONDS,
 * or null when it names none. Two shapes are in the wild:
 *
 *  - Codex: "… or try again at Sep 18th, 2026 5:20 PM." — English, in the
 *    account's own timezone, with an ordinal suffix `Date.parse` chokes on.
 *  - Claude: "Claude AI usage limit reached|1750000000" — a bare unix epoch
 *    after a pipe.
 *
 * Exported for its test: this is a parse of PROVIDER prose, so it is the part
 * most likely to drift, and a wrong answer here would put a confident wrong
 * date on the card. Null is always an acceptable answer — the card falls back
 * to "observed <when>".
 */
export function parseQuotaResetAt(text: string): number | null {
  const epoch = /usage limit reached\|(\d{9,13})/i.exec(text);
  if (epoch) {
    const n = Number(epoch[1]);
    if (!Number.isFinite(n)) return null;
    // 13 digits is milliseconds (the shape Claude has also emitted); 10 is
    // seconds. Normalize to seconds, which is what `resetsAt` means here.
    return epoch[1]!.length >= 12 ? Math.round(n / 1000) : Math.round(n);
  }
  const phrase = /try again(?:\s+(?:at|on))?\s+([^.\n]+)/i.exec(text);
  if (!phrase) return null;
  // "Sep 18th" → "Sep 18": Date.parse rejects the ordinal suffix outright.
  const cleaned = phrase[1]!.replace(/(\d{1,2})(st|nd|rd|th)\b/gi, "$1").trim();
  const ms = Date.parse(cleaned);
  if (!Number.isFinite(ms)) return null;
  return Math.round(ms / 1000);
}

/** Store the latest reading for a backend. Best-effort: a failure is logged and
 *  swallowed — quota telemetry must never break the run-line persist path. */
export function recordBackendRateLimit(
  db: DatabaseSync,
  backend: QuotaBackend,
  reading: BackendRateLimitReading,
): void {
  try {
    db.prepare(
      `INSERT INTO instance_settings (key, value_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET
         value_json = excluded.value_json, updated_at = excluded.updated_at`,
    ).run(
      `${KEY_PREFIX}${backend}`,
      JSON.stringify(reading),
      new Date().toISOString(),
    );
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
    db.prepare(
      `INSERT INTO instance_settings (key, value_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET
         value_json = excluded.value_json, updated_at = excluded.updated_at`,
    ).run(
      `${EXHAUSTED_KEY_PREFIX}${backend}`,
      JSON.stringify(exhaustion),
      new Date().toISOString(),
    );
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
    db.prepare(`DELETE FROM instance_settings WHERE key = ?`).run(
      `${EXHAUSTED_KEY_PREFIX}${backend}`,
    );
  } catch (error) {
    logger.warn("backend quota exhaustion not cleared", {
      backend,
      err: error instanceof Error ? error : new Error(String(error)),
    });
  }
}

const rowSchema = z.object({ value_json: z.string() });

/** One `instance_settings` value, parsed by `schema`; null when the key is
 *  absent, the JSON is corrupt, or the value no longer matches the schema —
 *  a tolerant read, because none of these are worth failing /insights over. */
function readSetting<T>(
  db: DatabaseSync,
  key: string,
  schema: z.ZodType<T>,
): T | null {
  const row = rowSchema.safeParse(
    db.prepare(`SELECT value_json FROM instance_settings WHERE key = ?`).get(key),
  );
  if (!row.success) return null;
  let value: unknown;
  try {
    value = JSON.parse(row.data.value_json);
  } catch {
    return null;
  }
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * The latest reading per backend; `reading: null` when none was ever seen.
 *
 * `nowIso` (the caller's generated-at instant) retires an exhaustion record the
 * moment the provider's OWN reset instant has passed: the window it named is
 * over, so continuing to show it would be a claim the evidence no longer
 * supports. A record naming no reset instant survives on its `observedAt`
 * alone, which the panel renders — until a completed run clears it.
 */
export function latestBackendRateLimits(
  db: DatabaseSync,
  nowIso?: string,
): BackendQuotaRow[] {
  const nowMs = nowIso ? Date.parse(nowIso) : Date.now();
  return BACKENDS.map((backend) => {
    const reading = readSetting(db, `${KEY_PREFIX}${backend}`, readingSchema);
    const stored = readSetting(
      db,
      `${EXHAUSTED_KEY_PREFIX}${backend}`,
      exhaustionSchema,
    );
    const expired =
      stored?.resetsAt != null &&
      Number.isFinite(nowMs) &&
      stored.resetsAt * 1000 <= nowMs;
    return { backend, reading, exhausted: expired ? null : stored };
  });
}
