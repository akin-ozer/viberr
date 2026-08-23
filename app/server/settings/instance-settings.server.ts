import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { openSecret, sealSecret } from "~/server/secrets/secret-box.server";
import { logger } from "~/server/logging/logger.server";
import type { S3Config } from "~/server/audit/s3-put.server";

/**
 * Instance-wide admin settings (one deployment): a small JSON key-value store an
 * org admin edits, read process-side. Distinct from `user_prefs` (per-user) and
 * project.md (per-project) — these are instance config with no natural owner row.
 *
 * The only setting today is the run concurrency cap; the store is generic so the
 * next instance knob is a key, not a column.
 */

/** The JSON-serializable shapes an instance setting may hold. Named so the
 *  writer parses a domain type at its boundary rather than taking `unknown`. */
type InstanceSettingValue =
  | number
  | string
  | boolean
  | Record<string, string | number | boolean>;

const rowSchema = z.object({ value_json: z.string() });

function getSetting<S extends z.ZodType>(
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

function setSetting(
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

// ------------------------------------------------- S3 audit export target

const S3_AUDIT_KEY = "s3AuditExport";

/** The stored S3 config: everything but the secret in the clear, the secret
 *  access key SEALED (AES-256-GCM, secret-box) so it is never at rest plaintext
 *  and never leaves the box on a read path that renders the config. */
const s3StoredSchema = z.object({
  bucket: z.string(),
  region: z.string(),
  prefix: z.string().default(""),
  endpoint: z.string().default(""),
  accessKeyId: z.string(),
  secretBox: z.string(),
});

/** The non-secret view for rendering the settings form — never carries the key. */
export interface S3AuditConfigView {
  bucket: string;
  region: string;
  prefix: string;
  endpoint: string;
  accessKeyId: string;
  /** A secret is on file (the field renders a placeholder, not the value). */
  hasSecret: boolean;
}

export function getS3AuditConfigView(db: DatabaseSync): S3AuditConfigView | null {
  const stored = getSetting(db, S3_AUDIT_KEY, s3StoredSchema);
  if (!stored) return null;
  return {
    bucket: stored.bucket,
    region: stored.region,
    prefix: stored.prefix,
    endpoint: stored.endpoint,
    accessKeyId: stored.accessKeyId,
    hasSecret: stored.secretBox.length > 0,
  };
}

/** The full config with the secret DECRYPTED, for an export run. Null when
 *  unconfigured or the secret cannot be opened (bad/rotated key). */
export function getS3AuditConfigForUse(db: DatabaseSync): S3Config | null {
  const stored = getSetting(db, S3_AUDIT_KEY, s3StoredSchema);
  if (!stored || !stored.secretBox) return null;
  let secretAccessKey: string;
  try {
    secretAccessKey = openSecret(stored.secretBox);
  } catch (error) {
    logger.error("S3 audit secret could not be opened", {
      err: error instanceof Error ? error : new Error(String(error)),
    });
    return null;
  }
  const config: S3Config = {
    bucket: stored.bucket,
    region: stored.region,
    accessKeyId: stored.accessKeyId,
    secretAccessKey,
  };
  if (stored.prefix) config.prefix = stored.prefix;
  if (stored.endpoint) config.endpoint = stored.endpoint;
  return config;
}

/**
 * Save (or update) the S3 audit-export target. A blank `secretAccessKey` KEEPS
 * the existing sealed secret (so an admin can edit the bucket without re-typing
 * the key); a non-blank value re-seals. Bucket, region and access key id are
 * required to configure a target.
 */
export function setS3AuditConfig(
  db: DatabaseSync,
  input: {
    bucket: string;
    region: string;
    prefix?: string;
    endpoint?: string;
    accessKeyId: string;
    secretAccessKey?: string;
  },
): void {
  const bucket = input.bucket.trim();
  const region = input.region.trim();
  const accessKeyId = input.accessKeyId.trim();
  if (!bucket || !region || !accessKeyId) {
    throw new Error("Bucket, region and access key id are required.");
  }
  const existing = getSetting(db, S3_AUDIT_KEY, s3StoredSchema);
  let secretBox = existing?.secretBox ?? "";
  const newSecret = input.secretAccessKey?.trim();
  if (newSecret) {
    secretBox = sealSecret(newSecret);
  }
  if (!secretBox) {
    throw new Error("A secret access key is required the first time.");
  }
  setSetting(db, S3_AUDIT_KEY, {
    bucket,
    region,
    prefix: input.prefix?.trim() ?? "",
    endpoint: input.endpoint?.trim() ?? "",
    accessKeyId,
    secretBox,
  });
}

/** Remove the S3 target entirely. */
export function clearS3AuditConfig(db: DatabaseSync): void {
  db.prepare(`DELETE FROM instance_settings WHERE key = ?`).run(S3_AUDIT_KEY);
}
