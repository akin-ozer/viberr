import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { getEnv } from "~/server/config/env.server";
import { AppError } from "~/server/errors/app-error.server";
import { ERROR_CODES } from "~/server/errors/error-codes";

/**
 * Secret box: AES-256-GCM encrypt/decrypt for secrets at rest (GitHub
 * PATs). Keyed from env VIBERR_SECRET_ENCRYPTION_KEY (a 32-byte Buffer,
 * validated at boot by env.server.ts).
 *
 * Box format (stable storage contract):
 *
 *   v1$<iv base64>$<ciphertext base64>$<auth tag base64>
 *
 * - iv: 12 random bytes per seal (never reused; GCM requirement).
 * - tag: 16-byte GCM auth tag — any tamper of iv/ciphertext/tag fails
 *   decryption with a typed AppError, never garbage plaintext.
 * - Error messages never include plaintext or key material.
 *
 * Pass an explicit `key` only in tests; production callers use the env key.
 *
 * KEY ROTATION (A9). Rotating `VIBERR_SECRET_ENCRYPTION_KEY` used to be
 * unimplemented, and the consequences were silent: every stored PAT became
 * unreadable and every authenticated MCP server quietly downgraded to
 * unauthenticated on the next run. Rotation is now real and lazy — set
 * `VIBERR_SECRET_ENCRYPTION_KEY_PREVIOUS` to the old key (or a comma-separated
 * list of old keys) alongside the new one and every read tries the current key
 * first, then each retired key; a box that opened under a retired key is
 * RE-SEALED in place by its caller, so the store converges on the new key with
 * no migration and no downtime. Once nothing opens under a retired key any
 * more, drop it from the env.
 */

const VERSION = "v1";
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;

function envKey(): Buffer {
  return getEnv().VIBERR_SECRET_ENCRYPTION_KEY;
}

/**
 * Retired keys still accepted for READS, newest first.
 *
 * Read from the raw env rather than `getEnv()`: `getEnv()` is a validated,
 * process-lifetime cache and this is an operational, rotation-window-only
 * value. A malformed entry is skipped with no detail — a key list must never
 * produce an error message that hints at key material.
 */
export function previousSecretKeys(
  env: NodeJS.ProcessEnv = process.env,
): Buffer[] {
  const raw = env.VIBERR_SECRET_ENCRYPTION_KEY_PREVIOUS;
  if (!raw) return [];
  const keys: Buffer[] = [];
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    try {
      const key = Buffer.from(trimmed, "base64");
      if (key.byteLength === 32) keys.push(key);
    } catch {
      // unusable entry — skipped in silence (never echo key material)
    }
  }
  return keys;
}

export interface OpenedSecret {
  plaintext: string;
  /**
   * True when the box opened under a RETIRED key. The caller owes the store a
   * re-seal under the current key — that lazy rewrite is what makes rotation
   * converge without a migration.
   */
  staleKey: boolean;
}

/**
 * Open a box under the current key, falling back to each retired key (A9).
 * Throws the same typed AppError as {@link openSecret} when no key opens it.
 */
export function openSecretRotating(
  box: string,
  key: Buffer = envKey(),
  previous: Buffer[] = previousSecretKeys(),
): OpenedSecret {
  try {
    return { plaintext: openSecret(box, key), staleKey: false };
  } catch (error) {
    for (const old of previous) {
      try {
        return { plaintext: openSecret(box, old), staleKey: true };
      } catch {
        // try the next retired key
      }
    }
    throw error;
  }
}

function invalidBox(message: string, cause?: unknown): AppError {
  return new AppError({
    code: ERROR_CODES.SECRET_BOX_INVALID,
    status: 500,
    message: `secret box: ${message}`,
    userMessage: "A stored secret could not be read.",
    cause,
  });
}

/** Encrypts `plaintext` into the v1 box format. */
export function sealSecret(plaintext: string, key: Buffer = envKey()): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString("base64"),
    ciphertext.toString("base64"),
    tag.toString("base64"),
  ].join("$");
}

/** True when `value` looks like a v1 secret box (format check only). */
export function isSecretBox(value: string): boolean {
  const parts = value.split("$");
  return parts.length === 4 && parts[0] === VERSION;
}

/**
 * Decrypts a v1 box. Throws a typed AppError (`secret_box_invalid`) on any
 * malformed input, unknown version, wrong key, or tampered content.
 */
export function openSecret(box: string, key: Buffer = envKey()): string {
  const parts = box.split("$");
  if (parts.length !== 4) {
    throw invalidBox("malformed box (expected 4 $-separated segments)");
  }
  const [version, ivB64, ciphertextB64, tagB64] = parts;
  if (version !== VERSION) {
    throw invalidBox(`unsupported box version "${version}"`);
  }
  const iv = Buffer.from(ivB64, "base64");
  const ciphertext = Buffer.from(ciphertextB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  if (iv.byteLength !== IV_BYTES) {
    throw invalidBox(`bad iv length ${iv.byteLength}`);
  }
  if (tag.byteLength !== TAG_BYTES) {
    throw invalidBox(`bad auth tag length ${tag.byteLength}`);
  }
  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
  } catch (error) {
    throw invalidBox("decryption failed (wrong key or tampered data)", error);
  }
}
