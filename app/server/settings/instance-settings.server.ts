import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

/**
 * Instance-wide admin settings (one deployment): a small JSON key-value store an
 * org admin edits, read process-side. Distinct from `user_prefs` (per-user) and
 * project.md (per-project) — these are instance config with no natural owner row.
 *
 * The store is generic so the next instance knob is a key, not a column — the
 * concurrency cap below is one such knob, and the backend-quota observations
 * (backend-quota.server) are another. The three accessors are EXPORTED for that
 * reason: every other keyed reader/writer of this table goes through them, so
 * the tolerant-parse and upsert rules live in exactly one place.
 */

/** The JSON-serializable shapes an instance setting may hold. Named so the
 *  writer parses a domain type at its boundary rather than taking `unknown`.
 *  Recursive because a knob can be a record (a backend's latest quota reading),
 *  not just a scalar. Secrets NEVER go here — a sealed secret needs a dedicated
 *  column for key rotation (see s3_audit_config). */
export type InstanceSettingValue =
  | number
  | string
  | boolean
  | null
  | InstanceSettingValue[]
  | { [key: string]: InstanceSettingValue };

const rowSchema = z.object({ value_json: z.string() });

/** One setting, parsed by `schema`; null when the key is absent, the JSON is
 *  corrupt, or the stored value no longer matches the schema. Tolerant by
 *  design: none of those are worth failing a page over, and every caller has a
 *  default. */
export function getSetting<S extends z.ZodType>(
  db: DatabaseSync,
  key: string,
  schema: S,
): z.infer<S> | null {
  const row = rowSchema.safeParse(
    db
      .prepare(`SELECT value_json FROM instance_settings WHERE key = ?`)
      .get(key),
  );
  if (!row.success) return null;
  let value: unknown;
  try {
    value = JSON.parse(row.data.value_json);
  } catch {
    return null; // tolerant: a corrupt row falls back to the caller's default
  }
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function setSetting(
  db: DatabaseSync,
  key: string,
  value: InstanceSettingValue,
): void {
  db.prepare(
    `INSERT INTO instance_settings (key, value_json, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET
       value_json = excluded.value_json, updated_at = excluded.updated_at`,
  ).run(key, JSON.stringify(value), new Date().toISOString());
}

/** Drop a setting entirely. Absence is a meaningful state for an observation
 *  key (backend-quota's "nothing is refusing work any more"), which is why this
 *  is a delete rather than a write of a falsy value. */
export function deleteSetting(db: DatabaseSync, key: string): void {
  db.prepare(`DELETE FROM instance_settings WHERE key = ?`).run(key);
}

const MAX_CONCURRENT_RUNS_KEY = "maxConcurrentRuns";

/** Upper bound accepted for the cap — a guard against a fat-fingered value that
 *  would let the machine spawn hundreds of provider processes. 0 = unlimited. */
export const MAX_CONCURRENT_RUNS_CEILING = 64;

const concurrencySchema = z.number().int().min(0).max(MAX_CONCURRENT_RUNS_CEILING);

/**
 * Max simultaneously-executing agent runs. 0 (the default) means UNLIMITED —
 * the historical behavior, so an untouched deployment is unchanged. A positive
 * N caps live adapter processes at N and queues the rest (run-service gate).
 */
export function getMaxConcurrentRuns(db: DatabaseSync): number {
  return getSetting(db, MAX_CONCURRENT_RUNS_KEY, concurrencySchema) ?? 0;
}

/**
 * Ruling 152(b): the coordination lane a cap carries. Operator and controller
 * turns are admitted up to `cap + lane` slots, one extra per four of the cap
 * (minimum one), so a decision never queues behind the delivery runs it is
 * deciding about. Derived from the cap rather than stored beside it: there is
 * ONE knob (`maxConcurrentRuns`), and the org-settings copy, the run-service
 * gate and the health snapshot all read the same arithmetic. 0 when the cap is
 * 0, where the gate is off and no lane is needed.
 */
export function coordinationLane(cap: number): number {
  if (cap <= 0) return 0;
  return Math.max(1, Math.ceil(cap / 4));
}

/** Persist the cap. Clamps into [0, ceiling]; a non-integer/NaN is refused so a
 *  bad form value can never disable the gate silently. */
export function setMaxConcurrentRuns(db: DatabaseSync, value: number): number {
  if (!Number.isFinite(value)) {
    throw new Error("Concurrency cap must be a number.");
  }
  const clamped = Math.max(0, Math.min(MAX_CONCURRENT_RUNS_CEILING, Math.floor(value)));
  setSetting(db, MAX_CONCURRENT_RUNS_KEY, clamped);
  return clamped;
}
