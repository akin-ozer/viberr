import { existsSync, readdirSync } from "node:fs";
import type Database from "better-sqlite3";
import { z } from "zod";
import {
  recordAudit,
  type AuditActor,
} from "~/server/audit/audit-recorder.server";
import { generateTempPassword } from "~/server/auth/password.server";
import {
  createUser,
  resetPassword,
  updateUser,
} from "~/server/auth/user-admin.server";
import {
  deleteIdentity,
  revokeUserSessions,
  syncIdentityEmail,
} from "~/server/auth/identity.server";
import {
  countActiveAdmins,
  findUserByEmail,
  findUserById,
  insertUser,
  listUsers,
  normalizeEmail,
  updateUserFields,
} from "~/server/auth/user-store.server";
import { AppError } from "~/server/errors/app-error.server";
import { ERROR_CODES } from "~/server/errors/error-codes";
import {
  projectFilePath,
  projectsDir,
} from "~/server/files/file-store-root.server";
import {
  readProjectFile,
  updateProjectFile,
} from "~/server/files/project-writer.server";
import { rebuildPath } from "~/server/projections/rebuilder.server";
import {
  convergeProjectOwnershipCleanup,
  markProjectOwnershipCleanupCommitted,
  stageProjectOwnershipCleanup,
} from "~/server/tasks/ownership-cleanup.server";
import { newId } from "~/shared/ids/new-id.server";
import { initialsOfName } from "~/shared/mapping/actor.server";
import type { UserRecord, UserRole } from "~/shared/mapping/user.server";

/**
 * Org "Users & access" server layer (org-settings spec §4.2) — thin
 * composition over the PHASE-2 user-admin API (whitelist = account
 * existence; creating a user row IS the whitelist entry):
 *
 * - local accounts       → createUser / resetPassword (temp password is
 *                          surfaced ONCE to the admin — no mailer in V1,
 *                          spec open question §8.8 resolved as an inline
 *                          cred-ok notice)
 * - google accounts      → createUser (passwordless) + idp flip; the row's
 *                          email is what the OAuth callback whitelists
 * - github handles       → placeholder identity row (mock §4.2: name
 *                          "@handle", email "github.com/handle") until
 *                          first sign-in syncs the real identity — claiming
 *                          the placeholder in the GitHub callback is a
 *                          documented later-phase wiring
 * - google domains       → google_domain_allowlist rows (managed here;
 *                          callback wiring documented, findDomainAllowlistRole
 *                          is the one-line hook)
 *
 * Route-level RBAC (requireRole("admin")) is the access control; these
 * functions trust their caller and audit via `actor` (phase-2 pattern).
 */

export type OrgUserStatus = "active" | "whitelisted" | "invited";

export interface OrgUserView {
  id: string;
  name: string;
  email: string;
  initials: string;
  tone: string;
  role: UserRole;
  status: OrgUserStatus;
  idp: "github" | "google" | "local";
  /** Password-reset pending (local; distinct from initial "invited"). */
  pwreset: boolean;
  disabled: boolean;
}

function conflict(userMessage: string): AppError {
  return new AppError({
    code: ERROR_CODES.CONFLICT,
    status: 409,
    userMessage,
    kind: "user",
  });
}

function idpOf(user: UserRecord): "github" | "google" | "local" {
  return user.idp === "github" || user.idp === "google" ? user.idp : "local";
}

function statusOf(user: UserRecord): OrgUserStatus {
  if (!user.lastLoginAt) {
    const idp = idpOf(user);
    if (idp === "github" || idp === "google") return "whitelisted";
    if (user.pwresetRequired) return "invited";
  }
  return "active";
}

export function toOrgUserView(user: UserRecord): OrgUserView {
  const status = statusOf(user);
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    initials: initialsOfName(user.name),
    tone: user.avatarTone ?? "",
    role: user.role,
    status,
    idp: idpOf(user),
    pwreset: user.pwresetRequired && status !== "invited",
    disabled: user.disabled,
  };
}

export function listOrgUsers(db: Database.Database): OrgUserView[] {
  return listUsers(db).map(toOrgUserView);
}

// ------------------------------------------------------------- whitelists

/** GitHub-handle placeholder email (mock display contract). Also consumed
 * by the GitHub OAuth callback to claim the row at first sign-in. */
export function githubPlaceholderEmail(handle: string): string {
  return `github.com/${handle.toLowerCase()}`;
}

export function whitelistGithubUser(
  db: Database.Database,
  input: { handle: string; role: UserRole },
  actor: AuditActor,
): { user: OrgUserView; toast: string } {
  const handle = input.handle.trim().replace(/^@/, "");
  if (!/^[\w.-]{2,}$/.test(handle)) {
    throw AppError.validation("Enter a GitHub username.");
  }
  if (findUserByEmail(db, githubPlaceholderEmail(handle))) {
    throw conflict(`@${handle} is already whitelisted.`);
  }
  // Placeholder identity until first sign-in; insertUser (not createUser)
  // because the placeholder "email" is deliberately not an email address.
  const user = insertUser(db, {
    id: newId("u"),
    email: githubPlaceholderEmail(handle),
    name: `@${handle}`,
    role: input.role,
    passwordHash: null,
    idp: "github",
    avatarTone: "teal",
    createdBy: actor.userId,
  });
  recordAudit(db, {
    action: "org.user.whitelisted",
    actor,
    subjectKind: "user",
    subjectId: user.id,
    details: { idp: "github", handle, role: input.role },
  });
  return {
    user: toOrgUserView(user),
    toast: `@${handle} whitelisted — allowed at first GitHub sign-in`,
  };
}

export function whitelistGoogleAccount(
  db: Database.Database,
  input: { email: string; role: UserRole },
  actor: AuditActor,
): { user: OrgUserView; toast: string } {
  const email = normalizeEmail(input.email);
  const name = email.split("@")[0] || email;
  // Phase-2 API: the row IS the whitelist; passwordless = OAuth-only.
  const record = createUser(
    db,
    { email, name, role: input.role, tempPassword: null },
    actor,
  );
  const flipped = updateUserFields(db, record.id, { idp: "google" }) ?? record;
  recordAudit(db, {
    action: "org.user.whitelisted",
    actor,
    subjectKind: "user",
    subjectId: record.id,
    details: { idp: "google", email, role: input.role },
  });
  return {
    user: toOrgUserView(flipped),
    toast: `${email} whitelisted — allowed at first Google sign-in`,
  };
}

export function createLocalAccount(
  db: Database.Database,
  input: { name: string; email: string; role: UserRole },
  actor: AuditActor,
): { user: OrgUserView; tempPassword: string; toast: string } {
  const tempPassword = generateTempPassword();
  const record = createUser(
    db,
    {
      email: input.email,
      name: input.name,
      role: input.role,
      tempPassword,
    },
    actor,
  );
  return {
    user: toOrgUserView(record),
    // Surfaced ONCE to the admin (no mailer in V1) — they hand it over
    // out-of-band; first sign-in forces a new password (phase-2 gate).
    tempPassword,
    toast: `Account created — temp sign-in password ready for ${record.email}`,
  };
}

// ------------------------------------------------------------- edit/reset

export interface UpdateOrgUserInput {
  userId: string;
  name: string;
  email: string;
  role: UserRole;
}

/**
 * EditUserModal save: local accounts may change name/email; idp accounts
 * sync identity from the provider (role only). Last-admin guard lives in
 * the phase-2 updateUser.
 */
export function updateOrgUser(
  db: Database.Database,
  input: UpdateOrgUserInput,
  actor: AuditActor,
): OrgUserView {
  const existing = findUserById(db, input.userId);
  if (!existing) throw AppError.notFound("No such user.");
  const isLocal = idpOf(existing) === "local";

  if (isLocal) {
    const email = normalizeEmail(input.email);
    if (!z.email().safeParse(email).success) {
      throw AppError.validation("Enter a valid email address.");
    }
    if (email !== existing.email) {
      if (findUserByEmail(db, email)) {
        throw conflict(`A user with email ${email} already exists.`);
      }
      db.prepare(`UPDATE users SET email = ?, updated_at = ? WHERE id = ?`).run(
        email,
        new Date().toISOString(),
        existing.id,
      );
      // Sync the better-auth identity too — credential sign-in resolves the
      // email in better-auth's own `user` table, so updating only `users`
      // locked the account out of sign-in entirely (pass-4 WI-2).
      syncIdentityEmail(db, existing.id, email);
      recordAudit(db, {
        action: "org.user.updated",
        actor,
        subjectKind: "user",
        subjectId: existing.id,
        details: {
          fields: ["email"],
          emailFrom: existing.email,
          emailTo: email,
        },
      });
    }
  }

  const updated = updateUser(
    db,
    existing.id,
    {
      ...(isLocal ? { name: input.name } : {}),
      ...(input.role !== existing.role ? { role: input.role } : {}),
    },
    actor,
  );
  return toOrgUserView(updated);
}

export function setOrgUserRole(
  db: Database.Database,
  input: { userId: string; role: UserRole },
  actor: AuditActor,
): OrgUserView {
  const updated = updateUser(db, input.userId, { role: input.role }, actor);
  return toOrgUserView(updated);
}

/** Local password reset: temp password surfaced once; sessions killed;
 * the phase-2 forced-reset gate prompts at next sign-in. */
export function resetLocalPassword(
  db: Database.Database,
  userId: string,
  actor: AuditActor,
): { user: OrgUserView; tempPassword: string; toast: string } {
  const existing = findUserById(db, userId);
  if (!existing) throw AppError.notFound("No such user.");
  if (idpOf(existing) !== "local") {
    throw AppError.validation(
      `${existing.name} signs in with ${idpOf(existing) === "github" ? "GitHub" : "Google"} — there is no local password to reset.`,
    );
  }
  const tempPassword = generateTempPassword();
  const updated = resetPassword(db, userId, tempPassword, actor);
  return {
    user: toOrgUserView(updated),
    tempPassword,
    toast: `Password reset — ${existing.name} sets a new password at next sign-in`,
  };
}

/**
 * Removes an instance account (the mock's row X). The phase-2 API has no
 * delete (only disable) — this is the 9B addition: audit history keeps the
 * denormalized actor snapshots (contracts §1.3, events survive member
 * removal), sessions/prefs/PATs cascade via FK.
 */
export async function deleteOrgUser(
  db: Database.Database,
  userId: string,
  actor: AuditActor,
  ctx: { dataRoot?: string } = {},
): Promise<{ user: OrgUserView; toast: string }> {
  const existing = findUserById(db, userId);
  if (!existing) throw AppError.notFound("No such user.");
  if (
    existing.role === "admin" &&
    !existing.disabled &&
    countActiveAdmins(db) <= 1
  ) {
    throw conflict("Cannot remove the last active admin.");
  }

  // Canonical project files outlive SQLite identities. Preflight every
  // membership before mutating anything so deleting an account can never leave
  // a project with no explicit project admin. Emergency org authority is a
  // recovery backstop, not a substitute for the project's normal owner.
  const root = projectsDir(ctx.dataRoot);
  const memberships = existsSync(root)
    ? readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
        if (!entry.isDirectory()) return [];
        const file = readProjectFile({
          projectSlug: entry.name,
          ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
        });
        if (!file) return [];
        const member = file.parsed.frontmatter.members.find(
          (candidate) => candidate.userId === userId,
        );
        return member
          ? [
              {
                slug: file.parsed.frontmatter.slug,
                name: file.parsed.frontmatter.name,
                role: member.role,
                adminCount: file.parsed.frontmatter.members.filter(
                  (candidate) => candidate.role === "admin",
                ).length,
              },
            ]
          : [];
      })
    : [];
  const soleAdminProjects = memberships.filter(
    (membership) => membership.role === "admin" && membership.adminCount <= 1,
  );
  if (soleAdminProjects.length > 0) {
    throw conflict(
      `Promote another project admin before removing ${existing.name}: ${soleAdminProjects
        .map((project) => project.name)
        .join(", ")}.`,
    );
  }

  // Files first, identity last. If one file write fails, the user can still
  // sign in and an admin can retry; no ghost membership/owner is created.
  for (const membership of memberships) {
    const ownershipCleanup = await stageProjectOwnershipCleanup(
      db,
      {
        projectSlug: membership.slug,
        targetUserId: userId,
        targetName: existing.name,
        reason: "org_user_removed",
      },
      { userId: actor.userId ?? "system", label: actor.label ?? "system" },
      ctx,
    );
    await updateProjectFile(
      {
        projectSlug: membership.slug,
        ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
      },
      (parsed) => {
        markProjectOwnershipCleanupCommitted(parsed, ownershipCleanup);
        parsed.frontmatter.members = parsed.frontmatter.members.filter(
          (member) => member.userId !== userId,
        );
      },
    );
    rebuildPath(db, projectFilePath(membership.slug, ctx.dataRoot), {
      ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
    });
    const releasedTaskKeys = await convergeProjectOwnershipCleanup(
      db,
      ownershipCleanup,
      ctx,
    );
    recordAudit(db, {
      action: "project.member.removed",
      actor,
      subjectKind: "project_member",
      subjectId: userId,
      projectSlug: membership.slug,
      details: {
        reason: "org_user_removed",
        previousRole: membership.role,
        releasedTaskKeys,
      },
    });
  }

  // Remove the better-auth identity too (user/account/member/session cascade) —
  // otherwise the orphaned `user` row (email is UNIQUE NOT NULL) makes
  // re-creating the same email throw a raw constraint mid-flow (pass-4 WI-3).
  revokeUserSessions(db, userId);
  deleteIdentity(db, userId);
  db.prepare(`DELETE FROM users WHERE id = ?`).run(userId);
  recordAudit(db, {
    action: "org.user.removed",
    actor,
    subjectKind: "user",
    subjectId: userId,
    details: {
      email: existing.email,
      name: existing.name,
      removedFromProjects: memberships.map((membership) => membership.slug),
    },
  });
  return { user: toOrgUserView(existing), toast: `${existing.name} removed` };
}

// ---------------------------------------------------------------- domains

export interface DomainRecord {
  id: string;
  domain: string;
  role: UserRole;
  createdAt: string;
}

interface DomainRow {
  id: string;
  domain: string;
  role: string;
  created_at: string;
}

function mapDomain(row: DomainRow): DomainRecord {
  return {
    id: row.id,
    domain: row.domain,
    role: (row.role === "admin" ? "admin" : "member") as UserRole,
    createdAt: row.created_at,
  };
}

export function listDomains(db: Database.Database): DomainRecord[] {
  const rows = db
    .prepare(
      `SELECT id, domain, role, created_at FROM google_domain_allowlist
       ORDER BY created_at ASC, id ASC`,
    )
    .all() as DomainRow[];
  return rows.map(mapDomain);
}

/** "@viberr.dev" from "@viberr.dev" or "someone@viberr.dev". */
export function normalizeDomain(input: string): string | null {
  const raw = input.trim().toLowerCase();
  const domainPart = raw.startsWith("@")
    ? raw.slice(1)
    : raw.includes("@")
      ? raw.split("@")[1]
      : raw;
  if (!domainPart || !domainPart.includes(".")) return null;
  if (!/^[a-z0-9.-]+$/.test(domainPart)) return null;
  return `@${domainPart}`;
}

export type AddDomainResult =
  | { status: "added"; domain: DomainRecord; toast: string }
  | { status: "duplicate"; message: string }
  | { status: "invalid"; message: string };

export function addDomain(
  db: Database.Database,
  input: { domain: string; role: UserRole },
  actor: AuditActor,
): AddDomainResult {
  const domain = normalizeDomain(input.domain);
  if (!domain) {
    return {
      status: "invalid",
      message: "Enter a domain like @company.dev.",
    };
  }
  const exists = db
    .prepare(`SELECT id FROM google_domain_allowlist WHERE domain = ?`)
    .get(domain);
  if (exists) {
    return { status: "duplicate", message: `${domain} is already whitelisted` };
  }
  const record: DomainRecord = {
    id: newId("dom"),
    domain,
    role: input.role,
    createdAt: new Date().toISOString(),
  };
  db.prepare(
    `INSERT INTO google_domain_allowlist (id, domain, role, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(record.id, record.domain, record.role, record.createdAt);
  recordAudit(db, {
    action: "org.domain.whitelisted",
    actor,
    subjectKind: "google_domain",
    subjectId: record.id,
    details: { domain, role: input.role },
  });
  return {
    status: "added",
    domain: record,
    toast: `Anyone with ${domain} can now sign in with Google — joins as ${input.role}`,
  };
}

export function removeDomain(
  db: Database.Database,
  id: string,
  actor: AuditActor,
): { domain: DomainRecord; toast: string } {
  const row = db
    .prepare(
      `SELECT id, domain, role, created_at FROM google_domain_allowlist
       WHERE id = ?`,
    )
    .get(id) as DomainRow | undefined;
  if (!row) throw AppError.notFound("No such domain.");
  db.prepare(`DELETE FROM google_domain_allowlist WHERE id = ?`).run(id);
  const record = mapDomain(row);
  recordAudit(db, {
    action: "org.domain.removed",
    actor,
    subjectKind: "google_domain",
    subjectId: id,
    details: { domain: record.domain },
  });
  return {
    domain: record,
    toast: `${record.domain} removed from the allowlist`,
  };
}

/**
 * The one-line hook for the Google OAuth callback (later-phase wiring —
 * the callback modules are outside 9B ownership): the role a fresh Google
 * sign-in from this email's domain would join with, or null when the
 * domain is not allowlisted.
 */
export function findDomainAllowlistRole(
  db: Database.Database,
  email: string,
): UserRole | null {
  const at = email.lastIndexOf("@");
  if (at === -1) return null;
  const domain = `@${email.slice(at + 1).toLowerCase()}`;
  const row = db
    .prepare(`SELECT role FROM google_domain_allowlist WHERE domain = ?`)
    .get(domain) as { role: string } | undefined;
  return row ? ((row.role === "admin" ? "admin" : "member") as UserRole) : null;
}
