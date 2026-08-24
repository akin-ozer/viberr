import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  openSecretRotating,
  sealSecret,
} from "~/server/secrets/secret-box.server";
import { logger } from "~/server/logging/logger.server";
import type { S3Config } from "./s3-put.server";

/**
 * The S3 audit-export target: at most one row (`id = 'default'`). The secret
 * access key is SEALED in its own `secret_box` column — a dedicated column, not
 * a JSON blob, so `key-rotation`'s SEALED_STORES machinery rescans and reseals
 * it on a key rotation (an unregistered sealed secret would silently outlive a
 * rotation and become unreadable — the exact hazard that gate guards).
 */

const ROW_ID = "default";

const rowSchema = z.object({
  bucket: z.string(),
  region: z.string(),
  prefix: z.string(),
  endpoint: z.string(),
  access_key_id: z.string(),
  secret_box: z.string(),
});

/** The non-secret view for rendering the settings form — never the key. */
export interface S3AuditConfigView {
  bucket: string;
  region: string;
  prefix: string;
  endpoint: string;
  accessKeyId: string;
  /** A secret is on file (the field renders a placeholder, not the value). */
  hasSecret: boolean;
}

function readRow(db: DatabaseSync): z.infer<typeof rowSchema> | null {
  const parsed = rowSchema.safeParse(
    db
      .prepare(
        `SELECT bucket, region, prefix, endpoint, access_key_id, secret_box
         FROM s3_audit_config WHERE id = ?`,
      )
      .get(ROW_ID),
  );
  return parsed.success ? parsed.data : null;
}

export function getS3AuditConfigView(db: DatabaseSync): S3AuditConfigView | null {
  const row = readRow(db);
  if (!row) return null;
  return {
    bucket: row.bucket,
    region: row.region,
    prefix: row.prefix,
    endpoint: row.endpoint,
    accessKeyId: row.access_key_id,
    hasSecret: row.secret_box.length > 0,
  };
}

/** The full config with the secret DECRYPTED, for an export run. Null when
 *  unconfigured or the secret cannot be opened (bad/rotated key). */
export function getS3AuditConfigForUse(db: DatabaseSync): S3Config | null {
  const row = readRow(db);
  if (!row || !row.secret_box) return null;
  let secretAccessKey: string;
  try {
    // F26-8: open through the ROTATING path (+ lazy re-seal), exactly like the PAT
    // and OAuth stores. `openSecret` alone bricked the S3 secret after a
    // VIBERR_SECRET_ENCRYPTION_KEY rotation — export silently failed with a
    // misleading "No S3 target configured" until an operator ran the reseal CLI.
    const opened = openSecretRotating(row.secret_box);
    secretAccessKey = opened.plaintext;
    if (opened.staleKey) {
      try {
        db.prepare(`UPDATE s3_audit_config SET secret_box = ? WHERE id = ?`).run(
          sealSecret(opened.plaintext),
          ROW_ID,
        );
        logger.info("re-sealed the S3 audit secret under the current encryption key");
      } catch (error) {
        // The read succeeded — a failed re-seal only costs the next read another
        // fallback, so never fail the export over it.
        logger.warn("could not re-seal the S3 audit secret under the current key", {
          err: error instanceof Error ? error : new Error(String(error)),
        });
      }
    }
  } catch (error) {
    logger.error("S3 audit secret could not be opened", {
      err: error instanceof Error ? error : new Error(String(error)),
    });
    return null;
  }
  const config: S3Config = {
    bucket: row.bucket,
    region: row.region,
    accessKeyId: row.access_key_id,
    secretAccessKey,
  };
  if (row.prefix) config.prefix = row.prefix;
  if (row.endpoint) config.endpoint = row.endpoint;
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
  const existing = readRow(db);
  let secretBox = existing?.secret_box ?? "";
  const newSecret = input.secretAccessKey?.trim();
  if (newSecret) secretBox = sealSecret(newSecret);
  if (!secretBox) {
    throw new Error("A secret access key is required the first time.");
  }
  db.prepare(
    `INSERT INTO s3_audit_config
       (id, bucket, region, prefix, endpoint, access_key_id, secret_box, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       bucket = excluded.bucket, region = excluded.region,
       prefix = excluded.prefix, endpoint = excluded.endpoint,
       access_key_id = excluded.access_key_id, secret_box = excluded.secret_box,
       updated_at = excluded.updated_at`,
  ).run(
    ROW_ID,
    bucket,
    region,
    input.prefix?.trim() ?? "",
    input.endpoint?.trim() ?? "",
    accessKeyId,
    secretBox,
    new Date().toISOString(),
  );
}

/** Remove the S3 target entirely. */
export function clearS3AuditConfig(db: DatabaseSync): void {
  db.prepare(`DELETE FROM s3_audit_config WHERE id = ?`).run(ROW_ID);
}
