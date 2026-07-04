import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * Password hashing: scrypt via node:crypto (N=16384, r=8, p=1, 32-byte salt,
 * 64-byte derived key). Stored self-describing as
 *   scrypt$N$r$p$<salt base64>$<hash base64>
 * verifyPassword re-derives with the STORED parameters (within sane bounds)
 * so future parameter bumps keep old hashes verifiable. Anything that is not
 * a well-formed scrypt string (plaintext, bcrypt, tampered params) is
 * rejected — legacy formats never verify.
 */

import { MIN_PASSWORD_LENGTH } from "~/shared/auth/password-policy";

export const SCRYPT_N = 16384;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
const SALT_BYTES = 32;
const KEY_BYTES = 64;

/** Re-exported for server modules; the constant lives in shared/ so client
 * form validation can import it without touching server code. */
export { MIN_PASSWORD_LENGTH };

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_BYTES);
  const hash = scryptSync(password, salt, KEY_BYTES, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return [
    "scrypt",
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString("base64"),
    hash.toString("base64"),
  ].join("$");
}

function parseIntStrict(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * Constant-time verification. Returns false (never throws) for wrong
 * passwords, null/empty hashes and malformed/legacy stored formats.
 */
export function verifyPassword(
  password: string,
  stored: string | null | undefined,
): boolean {
  if (!stored || typeof stored !== "string") return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const N = parseIntStrict(parts[1]);
  const r = parseIntStrict(parts[2]);
  const p = parseIntStrict(parts[3]);
  if (N === null || r === null || p === null) return false;
  // Sane bounds: N a power of two in [2^10, 2^20], r in [1,32], p in [1,16].
  if (N < 1024 || N > 1 << 20 || (N & (N - 1)) !== 0) return false;
  if (r < 1 || r > 32 || p < 1 || p > 16) return false;

  const saltB64 = parts[4];
  const hashB64 = parts[5];
  if (!BASE64_RE.test(saltB64) || !BASE64_RE.test(hashB64)) return false;
  const salt = Buffer.from(saltB64, "base64");
  const expected = Buffer.from(hashB64, "base64");
  if (salt.byteLength < 16 || expected.byteLength < 32) return false;

  let derived: Buffer;
  try {
    derived = scryptSync(password, salt, expected.byteLength, {
      N,
      r,
      p,
      maxmem: 256 * N * r + 1024 * 1024,
    });
  } catch {
    return false;
  }
  return timingSafeEqual(derived, expected);
}

/** Random temp password that satisfies MIN_PASSWORD_LENGTH (12 chars). */
export function generateTempPassword(): string {
  return randomBytes(9).toString("base64url");
}
