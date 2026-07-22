import { randomBytes } from "node:crypto";
import {
  hashPassword,
  verifyPassword as verifyBetterAuthPassword,
} from "better-auth/crypto";
import { MIN_PASSWORD_LENGTH } from "~/shared/auth/password-policy";

export { hashPassword, MIN_PASSWORD_LENGTH };

export async function verifyPassword(
  password: string,
  stored: string | null | undefined,
): Promise<boolean> {
  if (!stored) return false;
  try {
    return await verifyBetterAuthPassword({ hash: stored, password });
  } catch {
    return false;
  }
}

export function generateTempPassword(): string {
  return randomBytes(9).toString("base64url");
}
