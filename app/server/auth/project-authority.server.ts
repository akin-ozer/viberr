import type { DatabaseSync } from "node:sqlite";
import type { ProjectRole } from "~/schemas/project-file.schema";
import { recordAudit } from "~/server/audit/audit-recorder.server";
import { AppError } from "~/server/errors/app-error.server";
import { ERROR_CODES } from "~/server/errors/error-codes";
import { readProjectFile } from "~/server/files/project-writer.server";
import { type RbacAction, ROLE_LABEL, rolesForAction } from "~/shared/rbac";

/**
 * THE single project-authority resolution path (pass-7 R7-1 consolidation).
 *
 * Every server guard — task mutations (`requireAction`), config surfaces
 * (`assertProjectAction`), runtime triggers, and the route membership gate —
 * resolves "what may this actor do on this project" through
 * `resolveProjectAuthority` below. It owns two rules:
 *
 * 1. MEMBERSHIP ROLE: the actor's live role from project.md members[] is
 *    checked against the single-source `ACTION_ROLES` map (app/shared/rbac.ts —
 *    the same object the Policy page renders).
 *
 * 2. ORG-ADMIN EMERGENCY OVERRIDE (owner ruling D2, implemented per R7-1): an
 *    ORG admin whose membership role would be denied (non-member, or a member
 *    below the required tier) is granted project-admin-equivalent authority —
 *    and EVERY such grant writes a `project.org_admin.override` audit row
 *    naming the action and project, so the override is visible, never silent.
 *    An org admin whose own membership suffices is NOT an override (no row).
 *    The `"any-member"` gate is rate-collapsed rather than exempt (F19-30 —
 *    see the override branch): it authorizes real mutations, not just reads.
 *
 * 3. DENIAL (P13-D-8): every refusal writes a `project.authority.denied` row —
 *    NFR10's "unauthorized action attempts" category, previously the only one
 *    of its four with no audit trace anywhere in the app. See the deny branch.
 *
 * The archived read-only gate (R6-3) also lives here (`requireProjectMutable`)
 * so there is exactly one implementation and one message string.
 */

export interface AuthorityActor {
  userId: string;
  /** Human-readable audit label, e.g. the email. */
  label: string;
}

/** The minimal project shape authority resolution needs. Callers with a loaded
 *  project context pass it directly; slug-only callers use
 *  `assertProjectAction`, which reads project.md fresh. */
export interface AuthorityProject {
  slug: string;
  memberRoles: Map<string, ProjectRole>;
  /** Whether the project is archived (read-only). Required so every authority
   *  call carries it — the agent-runtime path (`requireRunAgents`) used to omit
   *  the archived read-only gate that config surfaces enforce, letting agents run
   *  on an archived project (F17). */
  archived: boolean;
}

export interface ProjectAuthority {
  /** The EFFECTIVE role the grant was made under ("admin" for an override). */
  role: ProjectRole;
  /** True when the grant came from the D2 org-admin emergency override. */
  isOrgAdminOverride: boolean;
}

/** What a passing {@link assertProjectAction} tells its caller. */
export interface ProjectActionGrant extends ProjectAuthority {
  projectName: string;
}

export type AuthorityDecision =
  | ({ allowed: true } & ProjectAuthority)
  | { allowed: false; memberRole: ProjectRole | null };

/** What the resolver records about the attempt (both the override grant and,
 *  since P13-D-8, the denial). */
export interface AuthorityAudit {
  action: RbacAction | "any-member";
  /** The guard's own copy fragment, e.g. "start an agent run". */
  what: string;
  /**
   * P13-D-8: skip the denial row. Reserved for probes whose refusal is a
   * NORMAL, UI-gated state rather than an attempt to exceed a role — today
   * exactly one: `canRunAgents`, the @mention path where a lower-role
   * commenter's comment is kept and the run is silently skipped by design.
   */
  silentDeny?: boolean;
}

/**
 * P13-D-8: NFR10 ("unauthorized action attempts must be recorded") was the one
 * audited category with NO row anywhere — across every non-test `recordAudit`
 * site there was no `*.denied` / `*.forbidden` / `*.unauthorized` action, so a
 * session probing above its role produced a clean log. Every throwing guard in
 * the app funnels through `resolveProjectAuthority`, so one write here covers
 * denied task mutations, runtime starts, policy edits and merges.
 *
 * Identical denials collapse inside this window: the membership gate also
 * guards POLLED resource routes (run-log, session-export) and a client that
 * keeps retrying a 403 would otherwise write a row per poll, burying the single
 * deliberate probe this row exists to make visible. F19-30 reuses the same
 * window for the `"any-member"` ORG-ADMIN OVERRIDE row (see the override
 * branch), which is why the key is caller-supplied and prefixed by kind.
 * Keyed per database handle so parallel test DBs never share state.
 */
const AUDIT_DEDUPE_MS = 60_000;
const MAX_TRACKED_AUDIT_KEYS = 500;
const auditSeen = new WeakMap<DatabaseSync, Map<string, number>>();

function shouldRecordOnce(db: DatabaseSync, key: string, now: number): boolean {
  let seen = auditSeen.get(db);
  if (!seen) {
    seen = new Map();
    auditSeen.set(db, seen);
  }
  const last = seen.get(key);
  if (last !== undefined && now - last < AUDIT_DEDUPE_MS) return false;
  if (seen.size >= MAX_TRACKED_AUDIT_KEYS) {
    for (const [k, at] of seen) {
      if (now - at >= AUDIT_DEDUPE_MS) seen.delete(k);
    }
    if (seen.size >= MAX_TRACKED_AUDIT_KEYS) seen.clear();
  }
  seen.set(key, now);
  return true;
}

/**
 * Archived projects are read-only (owner ruling R6-3): a project moved to the
 * Home "Archived" section refuses every governed mutation (tasks, comments,
 * agent runs, policy, settings) until an admin restores it — timelines and
 * audit stay readable. Throws a 409 with actionable copy. The ONE exemption is
 * the restore action itself (setProjectArchived passes `allowArchived`), so an
 * archived project can be brought back. Reads never call this. This is the
 * SINGLE implementation — `requireAction` (task-actions), `assertProjectAction`
 * (config surfaces) and the explicit comment-path call all share it.
 */
export function requireProjectMutable(
  project: { archived: boolean },
  what: string,
): void {
  if (project.archived) {
    throw new AppError({
      code: ERROR_CODES.CONFLICT,
      status: 409,
      userMessage: `This project is archived (read-only) — restore it before you ${what}.`,
    });
  }
}

/** Whether this user holds the ORG admin role. `users.role` is the sole
 *  authority — there is no better-auth membership plugin; this reads the
 *  `users` row directly. Disabled users never qualify. */
export function isOrgAdmin(db: DatabaseSync, userId: string): boolean {
  const row = db
    .prepare(`SELECT role FROM users WHERE id = ? AND disabled = 0`)
    .get(userId);
  return row?.role === "admin";
}

/**
 * THE membership + role resolution every guard consults (non-throwing).
 *
 * - A member whose role satisfies `allowed` (or any member for "any-member")
 *   is granted under their OWN role — never marked as an override.
 * - Otherwise an ORG admin is granted project-admin authority as the D2
 *   emergency override, and the grant is audited (`project.org_admin.override`
 *   with details {action, what, projectSlug}) — EVERY use leaves a row, with
 *   repeats of the same `"any-member"` gate collapsed into one row per minute
 *   (F19-30; the RbacAction gates are never collapsed).
 * - Everyone else is denied; the caller formats its own 403 copy from
 *   `memberRole` (null = not a member). The denial is audited
 *   (`project.authority.denied`, P13-D-8) unless the caller sets `silentDeny`.
 */
export function resolveProjectAuthority(
  db: DatabaseSync,
  project: AuthorityProject,
  actor: AuthorityActor,
  allowed: readonly ProjectRole[] | "any-member",
  audit: AuthorityAudit,
): AuthorityDecision {
  const memberRole = project.memberRoles.get(actor.userId) ?? null;
  if (
    memberRole &&
    (allowed === "any-member" || allowed.includes(memberRole))
  ) {
    return { allowed: true, role: memberRole, isOrgAdminOverride: false };
  }
  if (isOrgAdmin(db, actor.userId)) {
    // F19-30: the `"any-member"` gate used to be exempt from the override row,
    // justified as "config-surface route READs plus a couple of idempotent
    // no-ops — every real mutation the override enables names a concrete
    // RbacAction and IS audited". That claim was false. COMMENTING is a real,
    // visible, deliberately role-free mutation: `appendComment` never calls
    // `requireAction`, so its ONLY authority is this gate (reached through
    // `requireVisibleProject`). An org-admin NON-MEMBER could therefore write
    // into a members-only project and leave no `project.org_admin.override` row
    // at all — a direct contradiction of D2's "EVERY such grant leaves a row"
    // invariant at the top of this file.
    //
    // So the any-member override is audited now, and the F7-pass7 complaint it
    // was exempted for ("a row on every page load an org-admin non-member
    // opened") is answered by collapsing repeats inside the same 60s window the
    // denial rows use — NOT by silence. The key carries the caller's `what`, so
    // a READ gate ("view this project's policy", "read this project") can never
    // mask a WRITE gate ("act on this project"): the comment leaves its own row
    // even when the same admin loaded the page a second earlier. Residual: two
    // comments inside one window share one row — the row still names the actor,
    // the project and the write intent, which is what D2 exists to surface.
    const record =
      audit.action !== "any-member" ||
      shouldRecordOnce(
        db,
        `ovr|${actor.userId}|${project.slug}|${audit.what}`,
        Date.now(),
      );
    if (record) {
      recordAudit(db, {
        action: "project.org_admin.override",
        actor: { userId: actor.userId, label: actor.label },
        subjectKind: "project",
        subjectId: project.slug,
        projectSlug: project.slug,
        details: {
          action: audit.action,
          what: audit.what,
          projectSlug: project.slug,
          memberRole,
        },
      });
    }
    return { allowed: true, role: "admin", isOrgAdminOverride: true };
  }
  // P13-D-8: the attempt is refused — record it. `details` carries the
  // attempted action and the caller's live project role (null = not a member),
  // which is what "who probed above their role, and at what" needs.
  if (
    !audit.silentDeny &&
    shouldRecordOnce(
      db,
      `deny|${actor.userId}|${project.slug}|${audit.action}`,
      Date.now(),
    )
  ) {
    recordAudit(db, {
      action: "project.authority.denied",
      actor: { userId: actor.userId, label: actor.label },
      subjectKind: "project",
      subjectId: project.slug,
      projectSlug: project.slug,
      details: {
        action: audit.action,
        what: audit.what,
        projectSlug: project.slug,
        memberRole,
      },
    });
  }
  return { allowed: false, memberRole };
}

/**
 * Throwing wrapper over {@link resolveProjectAuthority} with the canonical
 * task-guard 403 copy ("Only project members can …" / "Your project role (x)
 * cannot …"). Used by the task-actions guards and every inline runtime check.
 */
export function requireProjectAuthority(
  db: DatabaseSync,
  project: AuthorityProject,
  actor: AuthorityActor,
  allowed: readonly ProjectRole[] | "any-member",
  audit: AuthorityAudit,
): ProjectAuthority {
  const decision = resolveProjectAuthority(db, project, actor, allowed, audit);
  if (decision.allowed) {
    return { role: decision.role, isOrgAdminOverride: decision.isOrgAdminOverride };
  }
  if (!decision.memberRole) {
    throw AppError.forbidden(`Only project members can ${audit.what}.`);
  }
  throw AppError.forbidden(
    `Your project role (${decision.memberRole}) cannot ${audit.what}.`,
  );
}

/**
 * The `run-agents` authority check (start/interrupt runs, @mention triggers),
 * centralized so the action id + audit copy live in ONE place. The runtime call
 * sites — @mention trigger (task-actions), specialist/reviewer dispatch
 * (specialist-run), interrupt (run-service), run-operator (route) — each build
 * the `memberRoles` map from wherever they have it (file store or DB projection)
 * and delegate the tier + audit here (pass-8 rbac-audit §4g dedup). Throws on
 * deny with the canonical 403 copy.
 */
export function requireRunAgents(
  db: DatabaseSync,
  project: AuthorityProject,
  actor: AuthorityActor,
  what: string,
): ProjectAuthority {
  // F17: an archived project is read-only for EVERYONE — the agent runtime is a
  // mutation surface (it writes branches, commits, timeline events), so gate it
  // exactly like the config surfaces do, before the role tier check.
  requireProjectMutable({ archived: project.archived }, what);
  return requireProjectAuthority(db, project, actor, rolesForAction("run-agents"), {
    action: "run-agents",
    what,
  });
}

/** Non-throwing sibling of {@link requireRunAgents} for the @mention path: a
 *  lower-role commenter's mention is recorded, but the run is silently skipped. */
export function canRunAgents(
  db: DatabaseSync,
  project: AuthorityProject,
  actor: AuthorityActor,
  what: string,
): boolean {
  // F17: no runtime sessions on an archived (read-only) project.
  if (project.archived) return false;
  return resolveProjectAuthority(db, project, actor, rolesForAction("run-agents"), {
    action: "run-agents",
    what,
    // P13-D-8: NOT an unauthorized attempt. The comment carrying the @mention
    // is a legitimate action for any role; only the run is gated, and the UI
    // never offered it. Auditing here would write a row per commented mention.
    silentDeny: true,
  }).allowed;
}

/**
 * The server-side guard for callers that have only a project SLUG (config
 * surfaces, route gates): reads the canonical project.md fresh, applies the
 * archived read-only gate (unless `allowArchived`), and resolves authority
 * against `ACTION_ROLES` — org-admin override included. `"any-member"` is the
 * route membership gate (view surfaces, kept for FR4 read-scoping).
 * 403 copy keeps the config-surface shape ("Only project admins can …").
 */
export function assertProjectAction(
  db: DatabaseSync,
  action: RbacAction | "any-member",
  projectSlug: string,
  actor: AuthorityActor,
  what: string,
  opts: { dataRoot?: string; allowArchived?: boolean } = {},
): ProjectActionGrant {
  const file = readProjectFile({
    projectSlug,
    dataRoot: opts.dataRoot,
  });
  if (!file) {
    throw new AppError({
      code: ERROR_CODES.NOT_FOUND,
      status: 404,
      userMessage: `Project ${projectSlug} not found.`,
    });
  }
  // Archived projects are read-only (R6-3): refuse config-surface mutations
  // until restored. Restore/delete and route READ gates pass allowArchived.
  if (!opts.allowArchived) {
    requireProjectMutable(
      { archived: file.parsed.frontmatter.archived === true },
      what,
    );
  }
  const project: AuthorityProject = {
    slug: projectSlug,
    memberRoles: new Map(
      file.parsed.frontmatter.members.map((m) => [m.userId, m.role]),
    ),
    archived: file.parsed.frontmatter.archived === true,
  };
  const allowed = action === "any-member" ? "any-member" : rolesForAction(action);
  const decision = resolveProjectAuthority(db, project, actor, allowed, {
    action,
    what,
  });
  if (decision.allowed) {
    return {
      projectName: file.parsed.frontmatter.name,
      role: decision.role,
      isOrgAdminOverride: decision.isOrgAdminOverride,
    };
  }
  const label =
    allowed === "any-member"
      ? "members"
      : allowed.length === 1
        ? `${ROLE_LABEL[allowed[0]!].toLowerCase()}s`
        : "members with the right role";
  throw AppError.forbidden(`Only project ${label} can ${what}.`);
}
