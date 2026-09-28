import type { DatabaseSync } from "node:sqlite";
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
  type UpdateUserPatch,
} from "~/server/auth/user-admin.server";
import {
  deleteIdentity,
  syncIdentityEmail,
} from "~/server/auth/identity.server";
import {
  countActiveAdmins,
  findUserByEmail,
  findUserById,
  insertUser,
  listUsers,
  normalizeEmail,
  otherEnabledGithubHandleHolders,
  updateUserFields,
} from "~/server/auth/user-store.server";
import { AppError } from "~/server/errors/app-error.server";
import {
  retireUserBackends,
  type BackendBinaries,
} from "~/server/runtimes/backend-credentials.server";
import {
  readProjectFile,
  updateProjectFile,
} from "~/server/files/project-writer.server";
import { listProjects } from "~/server/projections/board-query.server";
import { reprojectProject } from "~/server/projections/rebuilder.server";
import { releaseTasksOwnedBy } from "~/server/tasks/task-actions.server";
import { isValidGithubHandle, normalizeHandle } from "~/shared/github-handle";
import { newId } from "~/shared/ids/new-id.server";
import { initialsOf } from "~/ui/initials";
import type { UserRecord, UserRole } from "~/shared/mapping/user.server";
import { countLabel } from "~/shared/text/plural";
import { refreshRepoAccess } from "~/features/github/github-query.server";

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
 *                          first sign-in syncs the real identity — the GitHub
 *                          OAuth sign-in claims the placeholder live via
 *                          applyOAuthUser (oauth-provision.server), wired into
 *                          better-auth databaseHooks in lib/auth.server
 * - google domains       → google_domain_allowlist rows (managed here;
 *                          findDomainAllowlistRole is the hook the live OAuth
 *                          provisioning calls to map a domain to its role)
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
  /** Ruling 154: the GitHub login whose PR approval counts as this person's
   *  review verdict (ruling 68). Synced from the provider for a GitHub
   *  account; linked by an org admin for a local or Google one. */
  githubHandle: string | null;
}

function idpOf(user: UserRecord): "github" | "google" | "local" {
  return user.idp === "github" || user.idp === "google" ? user.idp : "local";
}

function statusOf(user: UserRecord): OrgUserStatus {
  if (!user.lastLoginAt) {
    const idp = idpOf(user);
    if (idp === "github" || idp === "google") return "whitelisted";
    // F20-12: a LOCAL account with no password can never sign in (no credential,
    // and OAuth is a different idp) — surface it as setup-pending, not a healthy
    // "active" row indistinguishable from a working account. `pwresetRequired`
    // catches temp-password accounts; `!hasPassword` catches the passwordless
    // ones the old invite path minted (e.g. the live `probe.nobody@viberr.dev`).
    if (user.pwresetRequired || !user.hasPassword) return "invited";
  }
  return "active";
}

function toOrgUserView(user: UserRecord): OrgUserView {
  const status = statusOf(user);
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    initials: initialsOf(user.name),
    tone: user.avatarTone ?? "",
    role: user.role,
    status,
    idp: idpOf(user),
    pwreset: user.pwresetRequired && status !== "invited",
    disabled: user.disabled,
    githubHandle: user.githubHandle,
  };
}

export function listOrgUsers(db: DatabaseSync): OrgUserView[] {
  return listUsers(db).map(toOrgUserView);
}

// ------------------------------------------------------------- whitelists

/** GitHub-handle placeholder email (mock display contract). Also consumed
 * by the GitHub OAuth callback to claim the row at first sign-in. */
export function githubPlaceholderEmail(handle: string): string {
  return `github.com/${handle.toLowerCase()}`;
}

/** What a whitelist call hands back: the new row plus the toast copy. */
export interface WhitelistedUser {
  user: OrgUserView;
  toast: string;
}

export function whitelistGithubUser(
  db: DatabaseSync,
  input: { handle: string; role: UserRole },
  actor: AuditActor,
): WhitelistedUser {
  const handle = input.handle.trim().replace(/^@/, "");
  if (!/^[\w.-]{2,}$/.test(handle)) {
    throw AppError.validation("Enter a GitHub username.");
  }
  if (findUserByEmail(db, githubPlaceholderEmail(handle))) {
    throw AppError.conflict(`@${handle} is already whitelisted.`);
  }
  // Placeholder identity until first sign-in; insertUser (not createUser)
  // because the placeholder "email" is deliberately not an email address.
  const user = insertUser(db, {
    id: newId("u"),
    email: githubPlaceholderEmail(handle),
    name: `@${handle}`,
    role: input.role,
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
    toast: `@${handle} whitelisted: allowed at first GitHub sign-in`,
  };
}

export async function whitelistGoogleAccount(
  db: DatabaseSync,
  input: { email: string; role: UserRole },
  actor: AuditActor,
): Promise<WhitelistedUser> {
  const email = normalizeEmail(input.email);
  const name = email.split("@")[0] || email;
  // Phase-2 API: the row IS the whitelist; passwordless = OAuth-only.
  const record = await createUser(
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
    toast: `${email} whitelisted: allowed at first Google sign-in`,
  };
}

export async function createLocalAccount(
  db: DatabaseSync,
  input: { name: string; email: string; role: UserRole },
  actor: AuditActor,
): Promise<{ user: OrgUserView; tempPassword: string; toast: string }> {
  const tempPassword = generateTempPassword();
  const record = await createUser(
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
    toast: `Account created; temp sign-in password ready for ${record.email}`,
  };
}

// ------------------------------------------------------------- edit/reset

export interface UpdateOrgUserInput {
  userId: string;
  name: string;
  email: string;
  role: UserRole;
  /** Ruling 154: the GitHub handle to link. Omitted leaves the stored handle
   *  alone (the controller's `update_user` never sends one); blank or null
   *  clears it; a value is normalized and must be free among enabled users. A
   *  GitHub-signed-in account refuses a value, since its handle syncs from the
   *  provider at each sign-in. */
  githubHandle?: string | null;
}

/**
 * Ruling 154: who else, still enabled, carries this handle. The verdict path
 * (`resolveGithubHandle`) fails closed on a duplicate, so the writer refuses
 * to create one; a disabled account's handle is not counted, mirroring the
 * `disabled = 0` filter the reader applies.
 */
function otherHandleHolder(
  db: DatabaseSync,
  handle: string,
  exceptUserId: string,
): { id: string; name: string } | null {
  return otherEnabledGithubHandleHolders(db, handle, exceptUserId)[0] ?? null;
}

/**
 * Ruling 154: the org admin's door to `users.github_handle`. Before it the
 * column had one writer, GitHub OAuth sign-in, so on a deployment without
 * GitHub sign-in a member's PR approval could only ever land as
 * `unlinked_handle` and ruling 68 was unreachable. Checks first, so a refused
 * handle writes nothing; the returned closure performs the write and audit
 * once the rest of the edit has passed its own guards. `null` = no change.
 */
function planGithubHandle(
  db: DatabaseSync,
  existing: UserRecord,
  input: string | null,
  actor: AuditActor,
): (() => void) | null {
  const handle = normalizeHandle(input);
  if (idpOf(existing) === "github") {
    if (handle === null) return null;
    throw AppError.validation(
      "This account signs in with GitHub; its handle syncs at each sign-in and cannot be set here.",
    );
  }
  const previous = existing.githubHandle;
  if (handle === previous) return null;
  if (handle !== null) {
    if (!isValidGithubHandle(handle)) {
      throw AppError.validation("Enter a GitHub username.");
    }
    const holder = otherHandleHolder(db, handle, existing.id);
    if (holder) {
      throw AppError.conflict(`@${handle} is already linked to ${holder.name}.`);
    }
  }
  return () => {
    updateUserFields(db, existing.id, { githubHandle: handle });
    recordAudit(db, {
      action:
        handle === null
          ? "org.user.github_handle.cleared"
          : "org.user.github_handle.set",
      actor,
      subjectKind: "user",
      subjectId: existing.id,
      details: { handle, previous },
    });
  };
}

/**
 * EditUserModal save: local accounts may change name/email; idp accounts
 * sync identity from the provider (role only). Last-admin guard lives in
 * the phase-2 updateUser. Ruling 154: a local or Google account may also
 * carry an admin-linked GitHub handle.
 */
export function updateOrgUser(
  db: DatabaseSync,
  input: UpdateOrgUserInput,
  actor: AuditActor,
): OrgUserView {
  const existing = findUserById(db, input.userId);
  if (!existing) throw AppError.notFound("No such user.");
  const isLocal = idpOf(existing) === "local";
  const writeHandle =
    input.githubHandle === undefined
      ? null
      : planGithubHandle(db, existing, input.githubHandle, actor);

  if (isLocal) {
    const email = normalizeEmail(input.email);
    if (!z.email().safeParse(email).success) {
      throw AppError.validation("Enter a valid email address.");
    }
    if (email !== existing.email) {
      if (findUserByEmail(db, email)) {
        throw AppError.conflict(`A user with email ${email} already exists.`);
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
        details: { fields: ["email"], emailFrom: existing.email, emailTo: email },
      });
    }
  }

  // Only what actually changed reaches the phase-2 API: an idp account's name
  // belongs to the provider, and an unchanged role must not read as a role edit.
  const patch: UpdateUserPatch = {};
  if (isLocal) patch.name = input.name;
  if (input.role !== existing.role) patch.role = input.role;
  const updated = updateUser(db, existing.id, patch, actor);
  if (!writeHandle) return toOrgUserView(updated);
  writeHandle();
  return toOrgUserView(findUserById(db, existing.id) ?? updated);
}

export function setOrgUserRole(
  db: DatabaseSync,
  input: { userId: string; role: UserRole },
  actor: AuditActor,
): OrgUserView {
  const updated = updateUser(db, input.userId, { role: input.role }, actor);
  return toOrgUserView(updated);
}

/** Local password reset: temp password surfaced once; sessions killed;
 * the phase-2 forced-reset gate prompts at next sign-in. */
export async function resetLocalPassword(
  db: DatabaseSync,
  userId: string,
  actor: AuditActor,
): Promise<{ user: OrgUserView; tempPassword: string; toast: string }> {
  const existing = findUserById(db, userId);
  if (!existing) throw AppError.notFound("No such user.");
  if (idpOf(existing) !== "local") {
    throw AppError.validation(
      `${existing.name} signs in with ${idpOf(existing) === "github" ? "GitHub" : "Google"}; there is no local password to reset.`,
    );
  }
  const tempPassword = generateTempPassword();
  const updated = await resetPassword(db, userId, tempPassword, actor);
  return {
    user: toOrgUserView(updated),
    tempPassword,
    toast: `Password reset; ${existing.name} sets a new password at next sign-in`,
  };
}

/**
 * UI-29: drop `userId` from every project.md membership list.
 *
 * `deleteOrgUser` used to delete the identity and the `users` row and stop
 * there, leaving the account in each project's canonical membership store. The
 * result was a GOVERNANCE HOLE, not just cosmetics: the settings/policy panels
 * rendered a row named `usr_9f3a…` with a live role radiogroup, and
 * `setMemberRole`'s last-admin guard counted the ghost as an admin — so the
 * only real admin could demote themselves and leave a project whose sole
 * "admin" is a deleted account, with nobody able to change policy, manage
 * members or delete the project.
 *
 * Membership is stored in project.md (the projection is derived), so the prune
 * writes the file through the shared writer and re-projects each project it
 * touched. Returns the slugs it changed.
 */
async function pruneUserFromProjects(
  db: DatabaseSync,
  userId: string,
  actor: AuditActor,
  ctx: { dataRoot?: string } = {},
): Promise<string[]> {
  const changed: string[] = [];
  // A3 (pass 23): the removed member's display name for the ownership-release
  // timeline note. Prune runs BEFORE the `users` row is deleted, so the name is
  // present; a fallback covers any future caller that prunes post-deletion.
  const removedName = findUserById(db, userId)?.name ?? "A removed member";
  for (const project of listProjects(db)) {
    const ref = { projectSlug: project.slug, dataRoot: ctx.dataRoot };
    const file = readProjectFile(ref);
    if (!file) continue;
    const isMember = file.parsed.frontmatter.members.some(
      (m) => m.userId === userId,
    );
    if (isMember) {
      await updateProjectFile(ref, (parsed) => {
        parsed.frontmatter.members = parsed.frontmatter.members.filter(
          (m) => m.userId !== userId,
        );
      });
      reprojectProject(db, ctx, project.slug);
    }
    // A3: release the tasks this user OWNED before their account disappears, so no
    // task strands on a ghost owner. Mirrors the project-level removeMember path —
    // the org dialog's "Task assignments return … for reassignment" promise.
    //
    // E-1 (pass 24): release in EVERY project, not only member ones. An org admin
    // can take ownership of a task in a project they are NOT a member of (the
    // audited D2 override), so gating the release on membership left those tasks
    // on a deleted `ownerUserId` (a board ghost, acceptance stalled) while the
    // dialog said they were released. `releaseTasksOwnedBy` is a no-op where the
    // user owns nothing and audits each release itself.
    const released = await releaseTasksOwnedBy(
      db,
      { projectSlug: project.slug, userId, removedName },
      actor,
      { dataRoot: ctx.dataRoot },
    );
    // A project the user neither belonged to nor owned a task in is untouched.
    if (!isMember && released === 0) continue;
    if (isMember) {
      recordAudit(db, {
        action: "project.member.removed",
        actor,
        subjectKind: "user",
        subjectId: userId,
        projectSlug: project.slug,
        details: {
          reason: "org account removed",
          targetUserId: userId,
          tasksReleased: released,
        },
      });
    }
    changed.push(project.slug);
  }
  return changed;
}

/**
 * Removes an instance account (the mock's row X). The phase-2 API has no
 * delete (only disable) — this is the 9B addition: audit history keeps the
 * denormalized actor snapshots (contracts §1.3, events survive member
 * removal), sessions/prefs/PATs cascade via FK.
 *
 * Async since UI-29: project.md memberships are pruned in the same call, and
 * the project-file writer is lock-based.
 */
export async function deleteOrgUser(
  db: DatabaseSync,
  userId: string,
  actor: AuditActor,
  ctx: {
    dataRoot?: string;
    /** Ruling 127: the vendor binaries, when the caller already holds them.
     *  Omitted, `retireUserBackends` resolves them itself; a test hands fakes
     *  so removing an account never spawns a real `claude auth logout`. */
    binaries?: BackendBinaries;
  } = {},
): Promise<{ user: OrgUserView; toast: string; projectsPruned: string[] }> {
  const existing = findUserById(db, userId);
  if (!existing) throw AppError.notFound("No such user.");
  if (
    existing.role === "admin" &&
    !existing.disabled &&
    countActiveAdmins(db) <= 1
  ) {
    throw AppError.conflict("Cannot remove the last active admin.");
  }
  // UI-29: prune BEFORE the identity/user rows go, so a failure here leaves the
  // account intact rather than half-deleted with live memberships.
  const projectsPruned = await pruneUserFromProjects(db, userId, actor, ctx);
  // Ruling 127: the `user_backend_credentials` rows cascade with the account,
  // but the vendor's own sign-in FILE in this person's runtime home does not —
  // and nothing else on any path would ever remove it. Retire the accounts
  // first (vendor logout, then the credential file, then the row), or removing
  // somebody would leave their live Claude.ai / ChatGPT credential on this
  // server forever, unrevokable by them and copied into every backup that
  // includes the runtime volume. Transcripts are the run record and stay.
  const backendsRetired = await retireUserBackends(db, userId, ctx);
  // The user delete cascades WIDER than this function used to admit:
  // `users` → `github_pats` (ON DELETE CASCADE) → `github_connections` AND
  // `project_github_credentials` (both ON DELETE CASCADE on `pat_id`). A
  // connection is an INSTANCE-level resource keyed by owner, so removing one
  // person can disconnect the org's DEFAULT GitHub connection and unbind
  // projects that person had nothing to do with — and `removeConnection`
  // refuses exactly that ("Set another connection as default first"), a
  // refusal this path walked straight past. Read what is about to go while the
  // rows still exist, so the audit and the toast name it instead of leaving an
  // admin to discover it when the next delivery fails.
  // SAFETY: both SELECTs name exactly the columns destructured below; `owner`
  // and `project_slug` are TEXT NOT NULL and `is_default` INTEGER NOT NULL.
  const connectionsRemoved = db
    .prepare(
      `SELECT c.owner AS owner, c.is_default AS isDefault
         FROM github_connections c
         JOIN github_pats p ON p.id = c.pat_id
        WHERE p.user_id = ?
        ORDER BY c.owner ASC`,
    )
    .all(userId) as { owner: string; isDefault: number }[];
  // SAFETY: as above — one TEXT NOT NULL column.
  const projectsUnbound = db
    .prepare(
      `SELECT g.project_slug AS slug
         FROM project_github_credentials g
         JOIN github_pats p ON p.id = g.pat_id
        WHERE p.user_id = ?
        ORDER BY g.project_slug ASC`,
    )
    .all(userId) as { slug: string }[];
  const connectionsLost = connectionsRemoved.map((c) => c.owner);
  const defaultConnectionLost =
    connectionsRemoved.find((c) => c.isDefault === 1)?.owner ?? null;
  const projectsUnboundSlugs = projectsUnbound.map((r) => r.slug);
  // Remove the better-auth identity too — otherwise the orphaned `user` row
  // (email is UNIQUE NOT NULL) makes re-creating the same email throw a raw
  // constraint mid-flow (pass-4 WI-3). Deleting the `user` row cascades its
  // `session` and `account` rows (FK ON DELETE CASCADE, 0001_baseline.sql), so
  // an explicit session revoke here would be a no-op prelude (rbac #5).
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
      projectsPruned,
      // Ruling 127: which agent accounts were retired with this one, so the
      // revocation is auditable rather than silent.
      backendsRetired,
      // …and the GitHub side of the same cascade, on the same principle.
      connectionsLost,
      defaultConnectionLost,
      projectsUnbound: projectsUnboundSlugs,
    },
  });
  // Ruling 540: an unbound project has no credential now, so its board stops
  // describing the token that went with this person. No GitHub call is needed.
  for (const slug of projectsUnboundSlugs) await refreshRepoAccess(db, slug);
  const extras = [
    ...(projectsPruned.length > 0
      ? [
          `dropped from ${countLabel(projectsPruned.length, "project")}`,
        ]
      : []),
    // Named, not counted: which GitHub owner stopped working matters more than
    // how many did, and the default one is the org-wide outage.
    ...(connectionsLost.length > 0
      ? [
          `disconnected ${connectionsLost.join(", ")}${defaultConnectionLost ? ` (the DEFAULT connection)` : ""}`,
        ]
      : []),
    ...(projectsUnboundSlugs.length > 0
      ? [
          `unbound the repo credential on ${countLabel(projectsUnboundSlugs.length, "project")}`,
        ]
      : []),
  ];
  return {
    user: toOrgUserView(existing),
    toast:
      extras.length > 0
        ? `${existing.name} removed: also ${extras.join("; ")}`
        : `${existing.name} removed`,
    projectsPruned,
  };
}

// ---------------------------------------------------------------- domains

export interface DomainRecord {
  id: string;
  domain: string;
  role: UserRole;
  createdAt: string;
}

type DomainRow = {
  id: string;
  domain: string;
  role: string;
  created_at: string;
};

function mapDomain(row: DomainRow): DomainRecord {
  return {
    id: row.id,
    domain: row.domain,
    role: row.role === "admin" ? "admin" : "member",
    createdAt: row.created_at,
  };
}

export function listDomains(db: DatabaseSync): DomainRecord[] {
  // SAFETY: the SELECT names exactly DomainRow's four columns, and in
  // 0001_baseline every one of them is TEXT NOT NULL on
  // `google_domain_allowlist`.
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
  db: DatabaseSync,
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
    toast: `Anyone with ${domain} can now sign in with Google (joins as ${input.role})`,
  };
}

/** What a removal hands back: the row that is gone plus the toast copy. */
export interface RemovedDomain {
  domain: DomainRecord;
  toast: string;
}

export function removeDomain(
  db: DatabaseSync,
  id: string,
  actor: AuditActor,
): RemovedDomain {
  // SAFETY: the same four TEXT NOT NULL columns `listDomains` reads, and `id`
  // is the primary key, so at most one row comes back.
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
 * The hook the live Google OAuth provisioning calls (oauth-provision.server,
 * wired into better-auth databaseHooks in lib/auth.server): the role a fresh
 * Google sign-in from this email's domain joins with, or null when the domain
 * is not allowlisted.
 */
export function findDomainAllowlistRole(
  db: DatabaseSync,
  email: string,
): UserRole | null {
  const at = email.lastIndexOf("@");
  if (at === -1) return null;
  const domain = `@${email.slice(at + 1).toLowerCase()}`;
  const row = db
    .prepare(`SELECT role FROM google_domain_allowlist WHERE domain = ?`)
    .get(domain);
  // `role` carries the CHECK-constrained pair; anything else joins as a member.
  return row ? (row.role === "admin" ? "admin" : "member") : null;
}
