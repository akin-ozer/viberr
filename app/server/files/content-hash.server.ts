import { createHash } from "node:crypto";

/**
 * The hex SHA-256 of a string (hashed as UTF-8, `update`'s default) or of raw
 * bytes. One home for the projection rebuilder's content hash, the seeded-asset
 * manifest's hash and the S3 signer's payload hash; a leaf, so none of them
 * imports another's domain module just to hash.
 */
export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}
