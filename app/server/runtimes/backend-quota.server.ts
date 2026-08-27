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
 */

const KEY_PREFIX = "backendRateLimit.";

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

export interface BackendQuotaRow {
  backend: QuotaBackend;
  /** Null until a run on this backend has ever reported a reading. */
  reading: BackendRateLimitReading | null;
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

const rowSchema = z.object({ value_json: z.string() });

/** The latest reading per backend; `reading: null` when none was ever seen. */
export function latestBackendRateLimits(db: DatabaseSync): BackendQuotaRow[] {
  return BACKENDS.map((backend) => {
    const row = rowSchema.safeParse(
      db
        .prepare(`SELECT value_json FROM instance_settings WHERE key = ?`)
        .get(`${KEY_PREFIX}${backend}`),
    );
    if (!row.success) return { backend, reading: null };
    let value: unknown;
    try {
      value = JSON.parse(row.data.value_json);
    } catch {
      return { backend, reading: null }; // tolerant: corrupt row reads as none
    }
    const parsed = readingSchema.safeParse(value);
    return { backend, reading: parsed.success ? parsed.data : null };
  });
}
