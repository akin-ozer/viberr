import { existsSync, rmSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { recordAudit } from "~/server/audit/audit-recorder.server";
import { createUser } from "~/server/auth/user-admin.server";
import { findUserByEmail } from "~/server/auth/user-store.server";
import { AppError } from "~/server/errors/app-error.server";
import { assertProjectAction } from "~/server/auth/project-authority.server";
import type { RbacAction } from "~/shared/rbac";
import {
  projectDir,
  projectFilePath,
} from "~/server/files/file-store-root.server";
import {
  readProjectFile,
  updateProjectFile,
} from "~/server/files/project-writer.server";
import { getProjectGithubContext } from "~/server/github/github-context.server";
import { invalidateRepoAccess } from "~/features/github/github-query.server";
import { rebuildAll, rebuildPath } from "~/server/projections/rebuilder.server";
import { newId } from "~/shared/ids/new-id.server";
import { stageLockReason } from "~/shared/workflow/stage-roles";
import {
  realignChainToStages,
  rejoinChainAroundStage,
  spliceStageIntoChain,
} from "~/shared/workflow/transitions";
import { countLiveAdmins, removedAccountLabel } from "./membership.server";

/**
 * Project-settings mutations (project-settings spec §5): identity, the
 * workflow-stages editor, membership CRUD, and the danger-zone delete. Every
 * mutation follows the canonical order file write → incremental reproject →
 * audit (SSE `project.updated` rides the rebuild — open Boards re-render
 * columns via the shell's project scope).
 *
 * The stage editor also OWNS the transition chain (P13-D-1): every stage
 * mutation leaves `frontmatter.workflow` wired to the new stage order, because
 * a stage no rule reaches is a board column no governed flow can enter or
 * leave. See app/shared/workflow/transitions.ts for the splice/re-join rules.
 *
 * RBAC (contracts §3.2, enforced HERE): identity/stages/delete =
 * `edit-policy` ("Edit workflow & policy") → admin; membership CRUD =
 * `manage-members` ("Manage members & roles") → admin — each mutation names
 * its honest action id (pass-7 seam 4). (Grant-scope stays admin|maintainer
 * in the route, matching the GitHub view.) Guards the mock did client-side
 * (locked stages, non-empty stages, self-removal, last-admin) are re-checked
 * server-side with the spec-verbatim toast copy as the error message.
 */

export interface SettingsActor {
  userId: string;
  label: string;
}

export interface SettingsMutationContext {
  dataRoot?: string;
}

export const NEW_STAGE_COLORS = [
  "var(--blue)",
  "var(--yellow-dark)",
  "var(--agent)",
  "var(--teal-dark)",
] as const;

function requireProjectAction(
  db: DatabaseSync,
  ctx: SettingsMutationContext,
  action: RbacAction,
  projectSlug: string,
  actor: SettingsActor,
  what: string,
  opts: { allowArchived?: boolean } = {},
): { projectName: string } {
  // Single canonical guard (project-authority.server): settings mutations name
  // their honest action id — `edit-policy` for identity/stages/repo/archive/
  // delete, `manage-members` for membership CRUD (both admin tier today).
  return assertProjectAction(db, action, projectSlug, actor, what, {
    dataRoot: ctx.dataRoot,
    ...(opts.allowArchived ? { allowArchived: true } : {}),
  });
}

function projectRef(ctx: SettingsMutationContext, projectSlug: string) {
  return {
    projectSlug,
    dataRoot: ctx.dataRoot,
  };
}

function reprojectProject(
  db: DatabaseSync,
  ctx: SettingsMutationContext,
  projectSlug: string,
): void {
  rebuildPath(db, projectFilePath(projectSlug, ctx.dataRoot), {
    dataRoot: ctx.dataRoot,
  });
}

// ----------------------------------------------------------------- identity

export async function updateProjectIdentity(
  db: DatabaseSync,
  input: { projectSlug: string; name: string; prefix: string; description: string },
  actor: SettingsActor,
  ctx: SettingsMutationContext = {},
): Promise<{ toast: string; changed: boolean }> {
  requireProjectAction(db, ctx, "edit-policy", input.projectSlug, actor, "change project settings");

  const name = input.name.trim();
  const prefix = input.prefix.trim().toUpperCase().slice(0, 4);
  if (!name) throw AppError.validation("Project name is required.");
  if (!/^[A-Z]{1,4}$/.test(prefix)) {
    throw AppError.validation("Task prefix must be 1–4 letters.");
  }
  const description = input.description.trim();

  const changedFields: string[] = [];
  await updateProjectFile(projectRef(ctx, input.projectSlug), (parsed) => {
    if (parsed.frontmatter.name !== name) {
      parsed.frontmatter.name = name;
      changedFields.push("name");
    }
    // Prefix changes affect FUTURE keys only — existing task keys/dirs are
    // immutable (spec §5.1).
    if (parsed.frontmatter.taskPrefix !== prefix) {
      parsed.frontmatter.taskPrefix = prefix;
      changedFields.push("prefix");
    }
    if (parsed.description !== description) {
      parsed.description = description;
      changedFields.push("description");
    }
  });

  if (changedFields.length === 0) {
    return { toast: "Project settings saved", changed: false };
  }
  reprojectProject(db, ctx, input.projectSlug);
  recordAudit(db, {
    action: "project.settings.updated",
    actor: { userId: actor.userId, label: actor.label },
    subjectKind: "project",
    subjectId: input.projectSlug,
    projectSlug: input.projectSlug,
    details: { fields: changedFields },
  });
  return { toast: "Project settings saved", changed: true };
}

// -------------------------------------------------------------- repo repair

/** `owner/name` from free input — tolerates a pasted GitHub URL and a
 * trailing `.git`, refuses anything that is not exactly one owner + one
 * name. */
export function normalizeRepoInput(raw: string): string | null {
  let s = raw.trim();
  s = s.replace(/^https?:\/\/(www\.)?github\.com\//i, "");
  s = s.replace(/^github\.com\//i, "");
  s = s.replace(/\.git$/i, "").replace(/\/+$/, "");
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/.test(s)
    ? s
    : null;
}

/** Tasks whose GitHub records point at the CURRENT repo: a linked PR, or
 * commits observed on a pushed branch. A truly misconfigured repo has zero
 * (every push failed), which is what keeps its repair friction-free. */
export function repoFootprintTasks(db: DatabaseSync, projectSlug: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM task_projections
       WHERE project_slug = ?
         AND (pr_json IS NOT NULL
              OR COALESCE(json_array_length(json_extract(github_json, '$.commits')), 0) > 0)`,
    )
    .get(projectSlug) as { n: number };
  return row.n;
}

/**
 * Owner ruling 2026-07-26 — the repository identity stays ONE-per-project and
 * is deliberately not editable in place; this is the explicit REPAIR path for
 * the one legitimate case: the repo was misconfigured at creation (wrong
 * owner, wrong name, or both) and every sync has been failing since.
 *
 * Contract:
 *  - the human TYPES the corrected `owner/name` — nothing is inferred from
 *    the connection owner and there is no automatic failover;
 *  - when a credential is bound, the new repo is probed live and a miss
 *    REFUSES the repair (a repair must not install the next
 *    misconfiguration); a hit also refreshes `defaultBranch` from GitHub;
 *  - a project whose tasks already carry PRs or pushed commits demands
 *    `confirmFootprint` — those records keep pointing at the old repo;
 *  - `edit-policy` tier (admin), audited from → to.
 */
export async function repairProjectRepo(
  db: DatabaseSync,
  input: { projectSlug: string; repo: string; confirmFootprint?: boolean },
  actor: SettingsActor,
  ctx: SettingsMutationContext = {},
  options: { fetchImpl?: typeof fetch } = {},
): Promise<{ toast: string; changed: boolean; repo: string }> {
  requireProjectAction(
    db,
    ctx,
    "edit-policy",
    input.projectSlug,
    actor,
    "repair the project repository",
  );

  const repo = normalizeRepoInput(input.repo);
  if (!repo) {
    throw AppError.validation(
      "Enter the repository as owner/name (a pasted GitHub URL works too).",
    );
  }

  const current = readProjectFile(projectRef(ctx, input.projectSlug));
  if (!current) throw AppError.notFound(`Project not found: ${input.projectSlug}`);
  const from = current.parsed.frontmatter.repo ?? null;
  if (from === repo) {
    return {
      toast: `The project already points at ${repo}`,
      changed: false,
      repo,
    };
  }

  const footprint = repoFootprintTasks(db, input.projectSlug);
  if (footprint > 0 && !input.confirmFootprint) {
    throw AppError.validation(
      `${footprint} task${footprint === 1 ? "" : "s"} in this project carry branch/PR records against ${from ?? "the current repo"} — confirm the repair to proceed; those records keep their history but future sync runs against ${repo}.`,
    );
  }

  // Verify the target with the BOUND credential before anything is written.
  // No credential → nothing to probe with; the repair applies and the
  // credential card keeps saying so.
  const gh = getProjectGithubContext(db, input.projectSlug, {
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  let probed = false;
  let defaultBranch: string | null = null;
  if (gh.status === "ok") {
    const res = await gh.client.request<{ default_branch?: string }>(
      "GET",
      `/repos/${repo}`,
    );
    if (res.ok) {
      probed = true;
      defaultBranch =
        typeof res.data.default_branch === "string" && res.data.default_branch
          ? res.data.default_branch
          : null;
    } else if (res.kind === "network") {
      throw AppError.validation(
        `GitHub is unreachable (${res.message}) — the repair was NOT applied. Try again when it is.`,
      );
    } else if (res.status === 404) {
      throw AppError.validation(
        `The attached credential cannot see ${repo} — check the owner/name, the token's repository access, or a pending organization approval. Nothing was changed.`,
      );
    } else if (res.status === 401) {
      throw AppError.validation(
        "GitHub rejected the attached credential — update the token in org settings, then repair again. Nothing was changed.",
      );
    } else {
      throw AppError.validation(
        `GitHub refused the check on ${repo} (${res.status}${res.kind === "http" ? `: ${res.message}` : ""}) — nothing was changed.`,
      );
    }
  }

  await updateProjectFile(projectRef(ctx, input.projectSlug), (parsed) => {
    parsed.frontmatter.repo = repo;
    if (defaultBranch) parsed.frontmatter.defaultBranch = defaultBranch;
  });
  reprojectProject(db, ctx, input.projectSlug);
  // The 30 s memoized repo-access probe still describes the OLD repo.
  invalidateRepoAccess(db, input.projectSlug);
  recordAudit(db, {
    action: "project.repo.updated",
    actor: { userId: actor.userId, label: actor.label },
    subjectKind: "project",
    subjectId: input.projectSlug,
    projectSlug: input.projectSlug,
    details: {
      from,
      to: repo,
      probed,
      ...(defaultBranch ? { defaultBranch } : {}),
      ...(footprint > 0 ? { footprintTasks: footprint } : {}),
    },
  });

  return {
    toast: probed
      ? `Repository repaired — ${from ?? "unset"} → ${repo}${defaultBranch ? ` (default branch ${defaultBranch})` : ""}`
      : `Repository set to ${repo} — attach a credential to verify access`,
    changed: true,
    repo,
  };
}

// ------------------------------------------------------------------- stages

export async function renameStage(
  db: DatabaseSync,
  input: { projectSlug: string; stageId: string; name: string },
  actor: SettingsActor,
  ctx: SettingsMutationContext = {},
): Promise<{ toast: string; changed: boolean }> {
  requireProjectAction(db, ctx, "edit-policy", input.projectSlug, actor, "edit workflow stages");
  const name = input.name.trim();
  if (!name) throw AppError.validation("Stage name is required.");
  // P13-D-1: renaming touches the DISPLAY name only — `frontmatter.workflow`
  // references stage ids, which are immutable once minted, so no rule can
  // dangle here. (Auto-wired rules carry no stage names in their `by` copy for
  // the same reason — see defaultTransitionBy.)

  let changed = false;
  await updateProjectFile(projectRef(ctx, input.projectSlug), (parsed) => {
    const stage = parsed.frontmatter.stages.find((s) => s.id === input.stageId);
    if (!stage) throw AppError.notFound(`No stage ${input.stageId}.`);
    if (stage.name === name) return;
    stage.name = name;
    changed = true;
  });

  const toast = `Stage renamed to "${name}" — board and policy follow`;
  if (!changed) return { toast, changed: false };
  reprojectProject(db, ctx, input.projectSlug);
  recordAudit(db, {
    action: "project.stage.renamed",
    actor: { userId: actor.userId, label: actor.label },
    subjectKind: "stage",
    subjectId: input.stageId,
    projectSlug: input.projectSlug,
    details: { name },
  });
  return { toast, changed: true };
}

export async function addStage(
  db: DatabaseSync,
  input: { projectSlug: string },
  actor: SettingsActor,
  ctx: SettingsMutationContext = {},
): Promise<{ toast: string; stageId: string }> {
  requireProjectAction(db, ctx, "edit-policy", input.projectSlug, actor, "edit workflow stages");

  // Server-generated id (spec §5.2 — never the mock's Date.now scheme).
  const stageId = newId("stage").toLowerCase().replace(/_/g, "-");
  await updateProjectFile(projectRef(ctx, input.projectSlug), (parsed) => {
    const stages = parsed.frontmatter.stages;
    const stage = {
      id: stageId,
      name: "New stage",
      color: NEW_STAGE_COLORS[stages.length % NEW_STAGE_COLORS.length]!,
    };
    // Inserted immediately before the terminal (last) stage so Done stays last,
    // whatever its id.
    const insertIdx = stages.length > 0 ? stages.length - 1 : 0;
    stages.splice(insertIdx, 0, stage);
    // P13-D-1: splice the stage into the transition chain too. Without this the
    // new column was unreachable — `transitionStage` refused it except as a
    // manual admin/maintainer move and the operator's `nextStages` (built purely
    // from `workflow`) was empty for it, so no agent could enter or leave it.
    // prev→next becomes prev→new + new→next, both inheriting the replaced
    // edge's boundary so the gate that guarded the hop is not loosened.
    parsed.frontmatter.workflow = spliceStageIntoChain(
      stages,
      parsed.frontmatter.workflow,
      stageId,
    );
  });

  reprojectProject(db, ctx, input.projectSlug);
  recordAudit(db, {
    action: "project.stage.added",
    actor: { userId: actor.userId, label: actor.label },
    subjectKind: "stage",
    subjectId: stageId,
    projectSlug: input.projectSlug,
    details: {},
  });
  return { toast: "Stage added — it appears on the board immediately", stageId };
}

export async function removeStage(
  db: DatabaseSync,
  input: { projectSlug: string; stageId: string },
  actor: SettingsActor,
  ctx: SettingsMutationContext = {},
): Promise<{ toast: string }> {
  requireProjectAction(db, ctx, "edit-policy", input.projectSlug, actor, "edit workflow stages");

  // Non-empty guard re-checked at ACTION time from projections (spec §5.2 —
  // client counts can be stale).
  const count = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM task_projections
          WHERE project_slug = ? AND stage = ?`,
      )
      .get(input.projectSlug, input.stageId) as { n: number }
  ).n;

  let stageName = input.stageId;
  await updateProjectFile(projectRef(ctx, input.projectSlug), (parsed) => {
    const stage = parsed.frontmatter.stages.find((s) => s.id === input.stageId);
    if (!stage) throw AppError.notFound(`No stage ${input.stageId}.`);
    stageName = stage.name;
    const locked = stageLockReason(input.stageId, parsed.frontmatter.stages);
    if (locked) {
      throw AppError.conflict(`${stage.name} can't be removed — ${locked}`);
    }
    if (count > 0) {
      throw AppError.conflict(
        `Move ${count} ${count === 1 ? "task" : "tasks"} out of ${stage.name} first`,
      );
    }
    // P13-D-1: rules referencing the removed stage still go (spec §7.4 — nothing
    // may point at a stage that no longer exists), but the neighbours are now
    // RE-JOINED instead of left with a hole in the chain: prev→next takes their
    // place, carrying the stricter of the two boundaries it replaces so a
    // column edit cannot delete an approval gate as a side effect. Computed
    // against the pre-removal stage list, which still knows who the neighbours
    // were.
    parsed.frontmatter.workflow = rejoinChainAroundStage(
      parsed.frontmatter.stages,
      parsed.frontmatter.workflow,
      input.stageId,
    );
    parsed.frontmatter.stages = parsed.frontmatter.stages.filter(
      (s) => s.id !== input.stageId,
    );
    // UI-50: agent-profile stage grants referencing the removed stage go too.
    // They used to survive, so the Agents page counted a stage the project no
    // longer has — "Eligible stages · 5 of 4", with an invisible chip that could
    // not be unchecked, and the stale id was re-persisted on every profile save.
    parsed.frontmatter.agents = parsed.frontmatter.agents.map((deployment) => {
      const stages = deployment.definition?.stages;
      if (!stages || !stages.includes(input.stageId)) return deployment;
      return {
        ...deployment,
        definition: {
          ...deployment.definition,
          stages: stages.filter((id) => id !== input.stageId),
        },
      };
    });
  });

  reprojectProject(db, ctx, input.projectSlug);
  recordAudit(db, {
    action: "project.stage.removed",
    actor: { userId: actor.userId, label: actor.label },
    subjectKind: "stage",
    subjectId: input.stageId,
    projectSlug: input.projectSlug,
    details: { name: stageName },
  });
  return { toast: `Stage "${stageName}" removed` };
}

export async function reorderStages(
  db: DatabaseSync,
  input: { projectSlug: string; orderedIds: string[] },
  actor: SettingsActor,
  ctx: SettingsMutationContext = {},
): Promise<{ toast: string }> {
  requireProjectAction(db, ctx, "edit-policy", input.projectSlug, actor, "edit workflow stages");

  await updateProjectFile(projectRef(ctx, input.projectSlug), (parsed) => {
    const stages = parsed.frontmatter.stages;
    const byId = new Map(stages.map((s) => [s.id, s]));
    if (
      input.orderedIds.length !== stages.length ||
      input.orderedIds.some((id) => !byId.has(id))
    ) {
      throw AppError.validation("Stage order is out of date — try again.");
    }
    const next = input.orderedIds.map((id) => byId.get(id)!);
    // Server re-applies the normalization — never trust client order
    // (spec §5.2): the entry stage stays first and the terminal stage stays
    // last, pinned by their CURRENT identity (not the literal ids
    // "triage"/"done") so custom/lightweight boards are protected too.
    const entryId = stages[0]!.id;
    const terminalId = stages[stages.length - 1]!.id;
    const middle = next.filter(
      (s) => s.id !== entryId && s.id !== terminalId,
    );
    parsed.frontmatter.stages = [
      byId.get(entryId)!,
      ...middle,
      byId.get(terminalId)!,
    ];
    // P13-D-1: the chain follows the columns. Leaving `workflow` describing the
    // OLD order would (a) make Policy's flow map disagree with the board and
    // (b) break the next addStage, which looks up the rule between the new
    // stage's positional neighbours. Each stage keeps the boundary that guarded
    // ENTRY into it, so re-ordering columns never hands a human-gated stage an
    // auto hop.
    parsed.frontmatter.workflow = realignChainToStages(
      parsed.frontmatter.stages,
      parsed.frontmatter.workflow,
    );
  });

  reprojectProject(db, ctx, input.projectSlug);
  recordAudit(db, {
    action: "project.stage.reordered",
    actor: { userId: actor.userId, label: actor.label },
    subjectKind: "project",
    subjectId: input.projectSlug,
    projectSlug: input.projectSlug,
    details: { order: input.orderedIds },
  });
  return { toast: "Stage order updated — board columns follow" };
}

// ------------------------------------------------------------------ members

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Invite (spec §5.3): registered email → membership entry (role viewer,
 * status invited). Unregistered email → a passwordless whitelist user row
 * is created first (phase-2 model: the user row IS the whitelist entry;
 * they sign in via OAuth — no mailer in V1, ruling 13), then the entry.
 */
export async function inviteMember(
  db: DatabaseSync,
  input: { projectSlug: string; name: string; email: string },
  actor: SettingsActor,
  ctx: SettingsMutationContext = {},
): Promise<{ toast: string; userId: string }> {
  // Honest action id (pass-7 seam 4): inviting IS member management, not a
  // policy edit — `manage-members`, same admin tier as before.
  requireProjectAction(db, ctx, "manage-members", input.projectSlug, actor, "manage members & roles");

  const name = input.name.trim();
  const email = input.email.trim().toLowerCase();
  if (!name || !EMAIL_RE.test(email)) {
    throw AppError.validation("Enter a name and a valid email");
  }

  const auditActor = { userId: actor.userId, label: actor.label };
  let user = findUserByEmail(db, email);
  if (!user) {
    user = await createUser(
      db,
      { email, name, role: "member", tempPassword: null },
      auditActor,
    );
  }
  const userId = user.id;

  await updateProjectFile(projectRef(ctx, input.projectSlug), (parsed) => {
    if (parsed.frontmatter.members.some((m) => m.userId === userId)) {
      throw AppError.conflict(`${email} is already a member`);
    }
    // An invite IS the membership (X15): viberr uses a whitelist auth model with
    // no separate accept-invite step, so the member gets access immediately and
    // we no longer stamp a decorative `status: invited` that never gated
    // anything. The member joins as a viewer, editable in Policy afterwards.
    parsed.frontmatter.members.push({ userId, role: "viewer" as const });
  });

  reprojectProject(db, ctx, input.projectSlug);
  recordAudit(db, {
    action: "project.member.invited",
    actor: auditActor,
    subjectKind: "user",
    subjectId: userId,
    projectSlug: input.projectSlug,
    details: { email, role: "viewer" },
  });
  return { toast: `Invite sent to ${email} · joins as Viewer`, userId };
}

export async function removeMember(
  db: DatabaseSync,
  input: { projectSlug: string; targetUserId: string },
  actor: SettingsActor,
  ctx: SettingsMutationContext = {},
): Promise<{ toast: string }> {
  // Honest action id (pass-7 seam 4): removal IS member management —
  // `manage-members`, same admin tier as before.
  const { projectName } = requireProjectAction(
    db,
    ctx,
    "manage-members",
    input.projectSlug,
    actor,
    "manage members & roles",
  );

  if (input.targetUserId === actor.userId) {
    throw AppError.conflict(`You can't remove yourself from ${projectName}`);
  }

  const userRow = db
    .prepare(`SELECT name, email FROM users WHERE id = ?`)
    .get(input.targetUserId) as { name: string; email: string } | undefined;
  // LV-04: an org-deleted member is named honestly in the toast instead of
  // echoing the raw `u_…` id back at the admin removing it.
  const displayName = userRow?.name ?? removedAccountLabel(input.targetUserId);

  await updateProjectFile(projectRef(ctx, input.projectSlug), (parsed) => {
    const member = parsed.frontmatter.members.find(
      (m) => m.userId === input.targetUserId,
    );
    if (!member) {
      throw AppError.notFound("That user is not a member of this project.");
    }
    if (member.role === "admin") {
      // UI-29: only LIVE, enabled accounts count — see countLiveAdmins.
      const admins = countLiveAdmins(db, parsed.frontmatter.members);
      if (admins <= 1) {
        throw AppError.conflict(
          `${displayName} is the only admin — assign another admin in Policy first`,
        );
      }
    }
    parsed.frontmatter.members = parsed.frontmatter.members.filter(
      (m) => m.userId !== input.targetUserId,
    );
  });

  reprojectProject(db, ctx, input.projectSlug);
  recordAudit(db, {
    action: "project.member.removed",
    actor: { userId: actor.userId, label: actor.label },
    subjectKind: "user",
    subjectId: input.targetUserId,
    projectSlug: input.projectSlug,
    details: {},
  });
  return {
    toast: `${displayName} removed from ${projectName}`,
  };
}

// P13-D-5 (owner ruling 2026-07-25): `setRepoOverride` lived here. It persisted
// a `taskRepoOverride` flag and audited `project.repo_override.changed`, and
// NOTHING consulted either — no writer ever set `task.repo`, so the admin
// flipped a governance switch, got a toast and an audit row, and nothing
// changed in either direction. The feature is deleted, not finished: one
// project, one repository.

// -------------------------------------------------------------- danger zone

/**
 * Archive / restore a project (admin-only). Archiving flips the `archived`
 * frontmatter flag; the project is then hidden from the active workspace and
 * moved to the home "Archived" section, restorable anytime. Canonical truth is
 * the file, so the change persists via reproject like every other setting.
 */
export async function setProjectArchived(
  db: DatabaseSync,
  input: { projectSlug: string; archived: boolean },
  actor: SettingsActor,
  ctx: SettingsMutationContext = {},
): Promise<{ toast: string; archived: boolean }> {
  const { projectName } = requireProjectAction(
    db,
    ctx,
    "edit-policy",
    input.projectSlug,
    actor,
    input.archived ? "archive this project" : "restore this project",
    // Restore must run ON an archived project — exempt it from the read-only gate.
    { allowArchived: !input.archived },
  );

  await updateProjectFile(projectRef(ctx, input.projectSlug), (parsed) => {
    parsed.frontmatter.archived = input.archived;
  });

  reprojectProject(db, ctx, input.projectSlug);
  recordAudit(db, {
    action: input.archived ? "project.archived" : "project.unarchived",
    actor: { userId: actor.userId, label: actor.label },
    subjectKind: "project",
    subjectId: input.projectSlug,
    projectSlug: input.projectSlug,
    details: { name: projectName },
  });
  return {
    toast: input.archived
      ? `Project "${projectName}" archived — find it under Archived on Home`
      : `Project "${projectName}" restored`,
    archived: input.archived,
  };
}

/**
 * Delete project (spec §5.6): destructive, typed-name confirmation
 * required, admin-only. Removes the project directory (project.md + every
 * task file), then a full rescan prunes all derived rows. Audit logs keep
 * the trail (audit_events are app-owned, not store-derived).
 */
export async function deleteProject(
  db: DatabaseSync,
  input: { projectSlug: string; confirmName: string },
  actor: SettingsActor,
  ctx: SettingsMutationContext = {},
): Promise<{ toast: string }> {
  const { projectName } = requireProjectAction(
    db,
    ctx,
    "edit-policy",
    input.projectSlug,
    actor,
    "delete this project",
    // Deleting an archived project is a valid terminal action — don't block it.
    { allowArchived: true },
  );
  if (input.confirmName.trim() !== projectName) {
    throw AppError.validation("Type the project name to confirm deletion.");
  }

  const dir = projectDir(input.projectSlug, ctx.dataRoot);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  rebuildAll(db, {
    dataRoot: ctx.dataRoot,
  });
  // Notifications are app-owned (no FK cascade to projects), so a deleted
  // project used to leave orphaned "waiting on you" rows that dead-ended on a
  // 404 when opened (F2). Clean them up with the project.
  db.prepare(`DELETE FROM notifications WHERE project_slug = ?`).run(
    input.projectSlug,
  );

  recordAudit(db, {
    action: "project.deleted",
    actor: { userId: actor.userId, label: actor.label },
    subjectKind: "project",
    subjectId: input.projectSlug,
    projectSlug: input.projectSlug,
    details: { name: projectName },
  });
  return { toast: `Project "${projectName}" deleted` };
}
