import { randomBytes } from "node:crypto";

/**
 * Short collision-safe id: `<prefix>_<12 base64url chars>` (72 random bits).
 * Used for users (`u_…`), audit events (`evt_…`), etc. Session ids are NOT
 * created here — they are sha256 hashes of the opaque session token.
 */
export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString("base64url")}`;
}
