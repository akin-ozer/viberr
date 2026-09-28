import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { newId } from "~/shared/ids/new-id.server";
import type { UserRecord } from "~/shared/mapping/user.server";
import { recordAudit, SYSTEM_ACTOR } from "../audit/audit-recorder.server";
import { logger } from "../logging/logger.server";
import { provisionIdentity } from "./identity.server";
import { hashPassword } from "./password.server";
import { countUsers, insertUser } from "./user-store.server";

/**
 * Boot-time bootstrap: when the users table is EMPTY, create the initial
 * admin from VIBERR_SEED_ADMIN_EMAIL / VIBERR_SEED_ADMIN_PASSWORD.
 * Without env credentials it falls back to admin@viberr.dev with a random
 * generated password that is logged ONCE (clearly marked) and must be
 * changed at first login (pwreset_required = 1). The seed CLI runs the same
 * bootstrap with a known default password (seed.server.ts).
 */

export const DEFAULT_SEED_ADMIN_EMAIL = "admin@viberr.dev";

/**
 * Ruling 532: the account this bootstrap made, in `users` as `listUsers`
 * orders it (oldest first). It is the first row an instance ever holds, made by
 * nobody (`created_by` null) with a password of its own (`idp` local); an
 * account an admin makes names its maker, and one a GitHub or Google sign-in
 * makes carries that provider. The email is no test: the environment names it,
 * and the environment may have changed since the table was empty. Null once
 * that account is gone.
 */
export function bootstrapAdminOf(users: readonly UserRecord[]): UserRecord | null {
  const first = users[0];
  return first && first.createdBy === null && first.idp === "local" ? first : null;
}

export interface SeedAdminResult {
  created: boolean;
  email?: string;
  /** Set only when no env password was provided. Never persisted. */
  generatedPassword?: string;
}

function nameForEmail(email: string): string {
  const local = email.split("@")[0] ?? "Admin";
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(" ");
}

export async function seedInitialAdmin(
  db: DatabaseSync,
  options: { email?: string; password?: string } = {},
): Promise<SeedAdminResult> {
  if (countUsers(db) > 0) return { created: false };

  const email = (options.email ?? DEFAULT_SEED_ADMIN_EMAIL).toLowerCase();
  const generated = !options.password;
  const password = options.password ?? randomBytes(12).toString("base64url");

  const passwordHash = await hashPassword(password);
  const user = insertUser(db, {
    id: newId("u"),
    email,
    name: nameForEmail(email),
    role: "admin",
    // A generated password is unknown to the human — force a reset.
    pwresetRequired: generated,
    idp: "local",
    avatarTone: "",
    createdBy: null,
  });
  // Provision the better-auth identity so the bootstrap admin can sign in.
  provisionIdentity(db, {
    id: user.id,
    email: user.email,
    name: user.name,
    passwordHash,
  });

  recordAudit(db, {
    action: "org.user.created",
    actor: SYSTEM_ACTOR,
    subjectKind: "user",
    subjectId: user.id,
    details: { email, role: "admin", bootstrap: true },
  });

  if (generated) {
    // The ONE place this password ever appears. Marked so it's easy to find.
    logger.warn(
      `VIBERR BOOTSTRAP ADMIN, email: ${email} password: ${password} ` +
        `(one-time credentials; you must set a new password at first sign-in)`,
      { bootstrap: true },
    );
  } else {
    logger.info("seed admin created from environment", { email });
  }

  const result: SeedAdminResult = { created: true, email };
  // The caller only ever hears a password we made up ourselves.
  if (generated) result.generatedPassword = password;
  return result;
}
