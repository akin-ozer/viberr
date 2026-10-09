import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { recordAudit, type AuditActor } from "~/server/audit/audit-recorder.server";

/**
 * Instance-wide admin settings (one deployment): a small JSON key-value store an
 * org admin edits, read process-side. Distinct from `user_prefs` (per-user) and
 * project.md (per-project) — these are instance config with no natural owner row.
 *
 * The store is generic so the next instance knob is a key, not a column — the
 * concurrency cap below is one such knob, and the backend-quota observations
 * (backend-quota.server) are another. The four accessors are EXPORTED for that
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

/** Every setting whose key starts with `prefix`, parsed by `schema`, for a
 *  family of keys (backend-quota's one record per account, ruling 160(a)).
 *  Tolerant the way `getSetting` is: a corrupt or mismatched row is skipped. */
export function listSettings<S extends z.ZodType>(
  db: DatabaseSync,
  prefix: string,
  schema: S,
): z.infer<S>[] {
  const rows = z.array(rowSchema).parse(
    db
      .prepare(`SELECT value_json FROM instance_settings WHERE substr(key, 1, ?) = ?`)
      .all(prefix.length, prefix),
  );
  const values: z.infer<S>[] = [];
  for (const row of rows) {
    let value: unknown;
    try {
      value = JSON.parse(row.value_json);
    } catch {
      continue;
    }
    const parsed = schema.safeParse(value);
    if (parsed.success) values.push(parsed.data);
  }
  return values;
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
const MAX_CONCURRENT_RUNS_CEILING = 64;

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
 * Ruling 150: the coordination lane a cap carries. Operator and controller
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
 *  bad form value can never disable the gate silently. How many runs the
 *  instance admits is instance policy (ruling 31), so every change is audited
 *  with the stored value before and after, as the spending cap is. */
export function setMaxConcurrentRuns(
  db: DatabaseSync,
  value: number,
  actor: AuditActor,
): number {
  if (!Number.isFinite(value)) {
    throw new Error("Concurrency cap must be a number.");
  }
  const clamped = Math.max(0, Math.min(MAX_CONCURRENT_RUNS_CEILING, Math.floor(value)));
  const before = getMaxConcurrentRuns(db);
  setSetting(db, MAX_CONCURRENT_RUNS_KEY, clamped);
  recordAudit(db, {
    action: "org.run_concurrency_cap.changed",
    actor,
    subjectKind: "instance_setting",
    subjectId: MAX_CONCURRENT_RUNS_KEY,
    details: { before, after: clamped },
  });
  return clamped;
}

const MAX_RUN_SPEND_USD_KEY = "maxRunSpendUsd";

/** A stored cap is a positive dollar amount; anything else reads as no cap. */
const runSpendSchema = z.number().positive();

/**
 * Ruling 159: the instance's spending cap per Claude run, in USD, or null when
 * none is set (the default — a side project does not want a surprise cut-off).
 * `startRun` hands it to every run as `RunSpec.maxSpendUsd`, and the Claude
 * adapter passes it to the SDK as `maxBudgetUsd`; the SDK ends a run that
 * exceeds it with `error_max_budget_usd`. Codex has no budget option, so the
 * cap binds Claude runs only (owner decision D4: an instance ceiling, no
 * profile field).
 */
export function getMaxRunSpendUsd(db: DatabaseSync): number | null {
  return getSetting(db, MAX_RUN_SPEND_USD_KEY, runSpendSchema);
}

/** A dollar amount the cap accepts: above zero, at most two decimals. */
export function isRunSpendAmount(value: number): boolean {
  return Number.isFinite(value) && value > 0 && Math.abs(value * 100 - Math.round(value * 100)) < 1e-9;
}

/**
 * Set or clear the cap. `null` clears it; any other value must pass
 * {@link isRunSpendAmount}, or this throws and nothing is written. Changing
 * what a run may spend is an instance-policy change, so it is audited with the
 * value before and after.
 */
export function setMaxRunSpendUsd(
  db: DatabaseSync,
  value: number | null,
  actor: AuditActor,
): number | null {
  if (value !== null && !isRunSpendAmount(value)) {
    throw new Error("A spending cap is a dollar amount above zero with at most two decimals.");
  }
  const before = getMaxRunSpendUsd(db);
  if (value === null) deleteSetting(db, MAX_RUN_SPEND_USD_KEY);
  else setSetting(db, MAX_RUN_SPEND_USD_KEY, value);
  recordAudit(db, {
    action: "org.run_spend_cap.changed",
    actor,
    subjectKind: "instance_setting",
    subjectId: MAX_RUN_SPEND_USD_KEY,
    details: { before, after: value },
  });
  return value;
}
