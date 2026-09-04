import { existsSync, rmSync } from "node:fs";
import { PROJECT_ROLES, ROLE_LABEL } from "~/shared/rbac";
import {
  isReservedTaskPrefix,
  RESERVED_TASK_PREFIX_REFUSAL,
} from "~/shared/dependencies";
import { deleteProjectNotifications } from "~/server/projections/notifications.server";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  recordAudit,
  type AuditDetails,
} from "~/server/audit/audit-recorder.server";
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
import {
  BRANCH_CLEANUP_GUARDRAIL_DESC,
  BRANCH_CLEANUP_GUARDRAIL_ID,
} from "~/server/github/branch-cleanup.server";
import {
  getProjectGithubContext,
  type GithubContextOptions,
} from "~/server/github/github-context.server";
import { invalidateRepoAccess } from "~/features/github/github-query.server";
import { rebuildAll, rebuildPath } from "~/server/projections/rebuilder.server";
import { newId } from "~/shared/ids/new-id.server";
import { generateTempPassword } from "~/server/auth/password.server";
import { stageLockReason } from "~/shared/workflow/stage-roles";
import type { Boundary } from "~/schemas/project-file.schema";
import {
  realignChainToStages,
  rejoinChainAroundStage,
  spliceStageIntoChain,
} from "~/shared/workflow/transitions";
import { countLiveAdmins, removedAccountLabel } from "./membership.server";
import { releaseTasksOwnedBy } from "~/server/tasks/task-actions.server";

/**
 * F20-15: GitHub's `/repos/{owner}/{repo}` returns the `permissions` block it
 * computed for THIS token — the read-only proof of write access. A project
 * exists to push branches and open PRs, so a repo the credential can only READ
 * is not deliverable. Mirrors the (module-private) `repoWritable` in
 * pat-validator.server.ts; kept local so this file stays decoupled from it.
 *
 * `push` stays tri-state on purpose: absent or unreadable is "unknown", never a
 * refusal — only a PROVEN read-only repo (push === false) is rejected. `admin`
 * and `maintain` need no third state: either GitHub asserted one or it did not.
 */
const repoPermissionsSchema = z.object({
  admin: z.boolean().catch(false),
  maintain: z.boolean().catch(false),
  push: z.boolean().nullable().catch(null),
});
type RepoPermissions = z.infer<typeof repoPermissionsSchema>;

/**
 * The two `GET /repos/{owner}/{repo}` fields the repair reads. `request<T>`
 * names an expected payload, it does not check one, so it is decoded here.
 * Tolerant at every level — an unreadable field reads as "unknown" and the
 * repair falls back to the same behaviour it had before the probe existed.
 */
const repoProbeSchema = z
  .object({
    default_branch: z.string().min(1).nullable().catch(null),
    permissions: repoPermissionsSchema.nullable().catch(null),
  })
  .catch({ default_branch: null, permissions: null });

function repoPushable(permissions: RepoPermissions | null): boolean | null {
  if (!permissions) return null;
  if (permissions.admin || permissions.maintain || permissions.push === true) {
    return true;
  }
  if (permissions.push === false) return false;
  return null;
}

/** `SELECT COUNT(*) AS n` — an aggregate with no GROUP BY, so sqlite answers
 *  with exactly one row carrying the single integer column `n`. */
const countRow = z.object({ n: z.number() });

/** The two `users` reads this file makes. Both columns are NOT NULL in
 *  0001_baseline.sql, so a row that does not decode is no row at all — which is
 *  exactly how a deleted account has to read here (see removeMember). */
const memberNameRow = z.object({ name: z.string() });
const disabledFlagRow = z.object({ disabled: z.number() });

/** Boundary → the label the Policy page uses (policy-data.ts BOUNDARIES). */
const BOUNDARY_LABEL = {
  auto: "Auto-advance",
  approval: "Human approval",
  human: "Human only",
} satisfies Record<Boundary, string>;
const BOUNDARY_RANK = {
  auto: 0,
  approval: 1,
  human: 2,
} satisfies Record<Boundary, number>;

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

// N20-10: hex, never a CSS token. project.md is the canonical, human-readable
// governance record — read by agents and off-browser tooling — and every seeded
// stage stores a hex (app/shared/workflow/templates.ts). A `var(--yellow-dark)`
// here is meaningless outside a stylesheet. These are the light-theme values the
// old tokens resolved to (app.css): --blue/--yellow-dark/--agent/--teal-dark.
export const NEW_STAGE_COLORS = [
  "#5b76fe",
  "#746019",
  "#7b61ff",
  "#187574",
] as const;

/** The option bag `assertProjectAction` takes. Named here so `allowArchived`
 *  can be set only when it was asked for — the guard reads its ABSENCE as
 *  "archived projects are refused". */
interface ProjectAuthorityOptions {
  dataRoot?: string;
  allowArchived?: boolean;
}

function requireProjectAction(
  db: DatabaseSync,
  ctx: SettingsMutationContext,
  action: RbacAction,
  projectSlug: string,
  actor: SettingsActor,
  what: string,
  opts: { allowArchived?: boolean } = {},
): { projectName: string } {
  const authorityOpts: ProjectAuthorityOptions = { dataRoot: ctx.dataRoot };
  if (opts.allowArchived) authorityOpts.allowArchived = true;
  // Single canonical guard (project-authority.server): settings mutations name
  // their honest action id — `edit-policy` for identity/stages/repo/archive/
  // delete, `manage-members` for membership CRUD (both admin tier today).
  return assertProjectAction(db, action, projectSlug, actor, what, authorityOpts);
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
    throw AppError.validation("Task prefix must be 1 to 4 letters.");
  }
  if (isReservedTaskPrefix(prefix)) throw AppError.validation(RESERVED_TASK_PREFIX_REFUSAL);
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

// ----------------------------------------------------------- branch cleanup

/**
 * R15-6: "delete the task branch after its review PR merges", per project,
 * default ON. Persisted as the `delete-branch-after-merge` guardrail row in
 * project.md (see branch-cleanup.server.ts for why that home and why absence
 * means ON) — writing the row explicitly either way keeps the file a statement
 * of the project's actual policy rather than a silence to interpret.
 *
 * `edit-policy` tier: this decides what Viberr does to a GitHub repository
 * after every merge, which is policy, not credential hygiene.
 */
export async function setBranchCleanup(
  db: DatabaseSync,
  input: { projectSlug: string; enabled: boolean },
  actor: SettingsActor,
  ctx: SettingsMutationContext = {},
): Promise<{ toast: string; enabled: boolean }> {
  requireProjectAction(
    db,
    ctx,
    "edit-policy",
    input.projectSlug,
    actor,
    "change project settings",
  );
  await updateProjectFile(projectRef(ctx, input.projectSlug), (parsed) => {
    parsed.frontmatter.guardrails = [
      ...parsed.frontmatter.guardrails.filter(
        (g) => g.id !== BRANCH_CLEANUP_GUARDRAIL_ID,
      ),
      {
        id: BRANCH_CLEANUP_GUARDRAIL_ID,
        desc: BRANCH_CLEANUP_GUARDRAIL_DESC,
        on: input.enabled,
      },
    ];
  });
  reprojectProject(db, ctx, input.projectSlug);
  recordAudit(db, {
    action: "project.settings.updated",
    actor: { userId: actor.userId, label: actor.label },
    subjectKind: "project",
    subjectId: input.projectSlug,
    projectSlug: input.projectSlug,
    details: { fields: ["branchCleanup"], enabled: input.enabled },
  });
  return {
    toast: input.enabled
      ? "Merged task branches will be deleted on GitHub"
      : "Merged task branches will be kept on GitHub",
    enabled: input.enabled,
  };
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
    .get(projectSlug);
  return countRow.parse(row).n;
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
      `${footprint} task${footprint === 1 ? "" : "s"} in this project carry branch/PR records against ${from ?? "the current repo"}. Confirm the repair to proceed; those records keep their history but future sync runs against ${repo}.`,
    );
  }

  // Verify the target with the BOUND credential before anything is written.
  // No credential → nothing to probe with; the repair applies and the
  // credential card keeps saying so.
  const ghOptions: GithubContextOptions = {};
  if (options.fetchImpl) ghOptions.fetchImpl = options.fetchImpl;
  const gh = getProjectGithubContext(db, input.projectSlug, ghOptions);
  let probed = false;
  let defaultBranch: string | null = null;
  if (gh.status === "ok") {
    const res = await gh.client.request("GET", `/repos/${repo}`);
    if (res.ok) {
      const probe = repoProbeSchema.parse(res.data);
      // F20-15: `res.ok` proves the credential can SEE the repo, not push to it.
      // Adopting a read-only-visible repo silently defers the failure to first
      // delivery (live: repairing to a foreign public repo succeeded). Refuse a
      // PROVEN read-only target; an unknown/absent permissions block still passes.
      if (repoPushable(probe.permissions) === false) {
        throw AppError.validation(
          `The attached credential can see ${repo} but cannot push to it. A project needs write access to open branches and PRs. Grant the token write access (or pick a repo you own), then repair again. Nothing was changed.`,
        );
      }
      probed = true;
      defaultBranch = probe.default_branch;
    } else if (res.kind === "network") {
      throw AppError.validation(
        `GitHub is unreachable (${res.message}). The repair was NOT applied. Try again when it is.`,
      );
    } else if (res.status === 404) {
      throw AppError.validation(
        `The attached credential cannot see ${repo}. Check the owner/name, the token's repository access, or a pending organization approval. Nothing was changed.`,
      );
    } else if (res.status === 401) {
      throw AppError.validation(
        "GitHub rejected the attached credential. Update the token in Instance settings, then repair again. Nothing was changed.",
      );
    } else {
      throw AppError.validation(
        `GitHub refused the check on ${repo} (${res.status}${res.kind === "http" ? `: ${res.message}` : ""}). Nothing was changed.`,
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
  const details: AuditDetails = { from, to: repo, probed };
  if (defaultBranch) details.defaultBranch = defaultBranch;
  if (footprint > 0) details.footprintTasks = footprint;
  recordAudit(db, {
    action: "project.repo.updated",
    actor: { userId: actor.userId, label: actor.label },
    subjectKind: "project",
    subjectId: input.projectSlug,
    projectSlug: input.projectSlug,
    details,
  });

  return {
    toast: probed
      ? `Repository repaired: ${from ?? "unset"} → ${repo}${defaultBranch ? ` (default branch ${defaultBranch})` : ""}`
      : `Repository set to ${repo}. Attach a credential to verify access`,
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

  const toast = `Stage renamed to "${name}". Board and policy follow`;
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
  input: { projectSlug: string; name: string },
  actor: SettingsActor,
  ctx: SettingsMutationContext = {},
): Promise<{ toast: string; stageId: string }> {
  requireProjectAction(db, ctx, "edit-policy", input.projectSlug, actor, "edit workflow stages");
  // Name-FIRST (2026-07-28 UX ruling): the button used to commit a stage called
  // "New stage" on the click, so a stray press wrote a workflow stage — a
  // governed edge in the transition chain — that then had to be removed. The
  // name is the request now, and an empty one is not a request.
  const name = input.name.trim();
  if (!name) throw AppError.validation("Stage name is required.");

  // Server-generated id (spec §5.2 — never the mock's Date.now scheme).
  const stageId = newId("stage").toLowerCase().replace(/_/g, "-");
  await updateProjectFile(projectRef(ctx, input.projectSlug), (parsed) => {
    const stages = parsed.frontmatter.stages;
    const stage = {
      id: stageId,
      name,
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
    // F20-27: record the stage NAME so the activity renderer prints it (it reads
    // `d.name`) instead of the generic "added a workflow stage." Contract shared
    // with the renderer (C-WORKFLOW-POLICY): `{ id, name }`.
    details: { id: stageId, name },
  });
  return {
    toast: `"${name}" added. It appears on the board immediately`,
    stageId,
  };
}

/** What a stage removal has to disclose besides the removal itself (F20-13):
 *  the re-joined hop, in stage NAMES, and the boundary it now carries. */
interface StageRemovalOutcome {
  tightening: { from: string; to: string; boundary: Boundary } | null;
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
  const countRowValue = db
    .prepare(
      `SELECT COUNT(*) AS n FROM task_projections
          WHERE project_slug = ? AND stage = ?`,
    )
    .get(input.projectSlug, input.stageId);
  const count = countRow.parse(countRowValue).n;

  let stageName = input.stageId;
  // F20-13: removing a stage collapses its two edges into one that carries the
  // STRICTER boundary (rejoinChainAroundStage) — deliberate, so a column edit
  // cannot silently delete an approval gate, but historically UNDISCLOSED: the
  // toast/audit said only "Stage X removed" while a hop that used to
  // auto-advance now needs a human. Capture the composite tightening so both
  // can name it.
  // Assigned inside the closure below; a holder keeps TS control-flow from
  // narrowing a closure-only-assigned `let` back to its `null` initializer at
  // the outer use sites (which made the `tightening ? …` branch `never`).
  const removal: StageRemovalOutcome = { tightening: null };
  await updateProjectFile(projectRef(ctx, input.projectSlug), (parsed) => {
    const stagesBefore = parsed.frontmatter.stages;
    const idx = stagesBefore.findIndex((s) => s.id === input.stageId);
    const stage = idx === -1 ? undefined : stagesBefore[idx];
    if (!stage) throw AppError.notFound(`No stage ${input.stageId}.`);
    stageName = stage.name;
    const locked = stageLockReason(input.stageId, parsed.frontmatter.stages);
    if (locked) {
      throw AppError.conflict(`${stage.name} can't be removed: ${locked}`);
    }
    if (count > 0) {
      throw AppError.conflict(
        `Move ${count} ${count === 1 ? "task" : "tasks"} out of ${stage.name} first`,
      );
    }
    // Neighbours + the edges about to be merged, read from the PRE-removal state.
    const prevStage = idx > 0 ? stagesBefore[idx - 1] : null;
    const nextStage = idx < stagesBefore.length - 1 ? stagesBefore[idx + 1] : null;
    const workflowBefore = parsed.frontmatter.workflow;
    const inEdge = prevStage
      ? workflowBefore.find((w) => w.from === prevStage.id && w.to === input.stageId)
      : undefined;
    const outEdge = nextStage
      ? workflowBefore.find((w) => w.from === input.stageId && w.to === nextStage.id)
      : undefined;
    const hadDirect = Boolean(
      prevStage &&
        nextStage &&
        workflowBefore.some(
          (w) => w.from === prevStage.id && w.to === nextStage.id,
        ),
    );
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
    // The merged hop is stricter than at least one of the edges it replaced when
    // the two differed (or the terminal invariant forced it up). Disclose that.
    if (!hadDirect && prevStage && nextStage && inEdge && outEdge) {
      const merged = parsed.frontmatter.workflow.find(
        (w) => w.from === prevStage.id && w.to === nextStage.id,
      );
      if (
        merged &&
        BOUNDARY_RANK[merged.boundary] >
          Math.min(BOUNDARY_RANK[inEdge.boundary], BOUNDARY_RANK[outEdge.boundary])
      ) {
        removal.tightening = {
          from: prevStage.name,
          to: nextStage.name,
          boundary: merged.boundary,
        };
      }
    }
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
  // F20-27: `{ id, name }` is the contract the activity renderer reads
  // (`d.name`). F20-13: when the removal retightened a hop, also record
  // `tightened: { from, to, boundary }` — stage NAMES + boundary id — what the
  // renderer (C-WORKFLOW-POLICY, activity-feed.server.ts) reads to disclose it.
  // `{ id, name }` stays always-present.
  const details: AuditDetails = { id: input.stageId, name: stageName };
  if (removal.tightening) {
    details.tightened = {
      from: removal.tightening.from,
      to: removal.tightening.to,
      boundary: removal.tightening.boundary,
    };
  }
  recordAudit(db, {
    action: "project.stage.removed",
    actor: { userId: actor.userId, label: actor.label },
    subjectKind: "stage",
    subjectId: input.stageId,
    projectSlug: input.projectSlug,
    details,
  });
  return {
    toast: removal.tightening
      ? `Stage "${stageName}" removed. ${removal.tightening.from} → ${removal.tightening.to} now needs ${BOUNDARY_LABEL[removal.tightening.boundary]} (the removed stage's stricter gate was kept)`
      : `Stage "${stageName}" removed`,
  };
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
    // Length and membership alone let a REPEATED id through, and a repeat of
    // the right length necessarily omits another stage — so the board would
    // gain a duplicated column and silently lose one, taking `removeStage`'s
    // "move its tasks out first" guard with it and stranding every task in the
    // dropped stage in a column the project no longer defines. A reorder is a
    // permutation: same length, same set, no repeats.
    if (
      input.orderedIds.length !== stages.length ||
      new Set(input.orderedIds).size !== input.orderedIds.length ||
      input.orderedIds.some((id) => !byId.has(id))
    ) {
      throw AppError.validation("Stage order is out of date. Try again.");
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
  return { toast: "Stage order updated. Board columns follow" };
}

// ------------------------------------------------------------------ members

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface InviteMemberResult {
  toast: string;
  userId: string;
  /** Present ONLY when the invite minted the account (F20-12) — its absence is
   *  how a caller tells "existing user added" from "new account, credential
   *  still to hand over". */
  tempPassword?: string;
}

/**
 * Invite (spec §5.3): registered email → membership entry (role viewer).
 * Unregistered email → a NEW account is minted first, then the entry.
 *
 * F20-12: that account used to be minted PASSWORDLESS (`tempPassword: null`) on
 * the phase-2 "the row IS the whitelist, they sign in via OAuth" assumption. On
 * a deployment with no SSO that mints an account that can never sign in — no
 * credential, no OAuth path — yet `statusOf` showed it healthy, and the invitee
 * hit a flat "no local account" wall at /login. Now the mint carries a temp
 * password (the same ceremony Allow-access uses), so the account is usable via
 * Users & access → Reset password and `statusOf` marks it setup-pending. The
 * temp password itself is generated but not surfaced on the members card (that
 * lives in Users & access, where the credential is handed over out-of-band — no
 * mailer, ruling 13); it is returned for a caller that wants to surface it.
 */
export async function inviteMember(
  db: DatabaseSync,
  input: { projectSlug: string; name: string; email: string; role?: string },
  actor: SettingsActor,
  ctx: SettingsMutationContext = {},
): Promise<InviteMemberResult> {
  // Honest action id (pass-7 seam 4): inviting IS member management, not a
  // policy edit — `manage-members`, same admin tier as before.
  requireProjectAction(db, ctx, "manage-members", input.projectSlug, actor, "manage members & roles");

  const name = input.name.trim();
  const email = input.email.trim().toLowerCase();
  if (!name || !EMAIL_RE.test(email)) {
    throw AppError.validation("Enter a name and a valid email");
  }
  // C4 (pass 34, U34-5): the seat the invite takes. Parsed HERE, against the
  // same single enum `setMemberRole` uses, because a caller that bypasses a
  // tool schema (the controller tests call the handler directly) would
  // otherwise push an arbitrary string into project.md, where the tolerant
  // per-row parse drops the member SILENTLY. Absent stays `viewer`: the
  // narrowest seat is what an unstated invite has always meant.
  const roleParse = z.enum(PROJECT_ROLES).safeParse(input.role ?? "viewer");
  if (!roleParse.success) throw AppError.validation("Unknown project role.");
  const role = roleParse.data;

  const auditActor = { userId: actor.userId, label: actor.label };
  let user = findUserByEmail(db, email);
  let tempPassword: string | undefined;
  if (!user) {
    // F20-12: mint WITH a temp password so the account can actually sign in
    // (createUser stamps pwresetRequired=true → statusOf reads "setup pending").
    tempPassword = generateTempPassword();
    user = await createUser(
      db,
      { email, name, role: "member", tempPassword },
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
    // anything. C4: the seat is the one the caller asked for (viewer unless
    // stated), editable in Policy afterwards — it used to be viewer whatever
    // was asked, which cost a second write and a second audit row per person.
    parsed.frontmatter.members.push({ userId, role });
  });

  reprojectProject(db, ctx, input.projectSlug);
  recordAudit(db, {
    action: "project.member.invited",
    actor: auditActor,
    subjectKind: "user",
    subjectId: userId,
    projectSlug: input.projectSlug,
    details: { email, role },
  });
  // N20-6: no mailer exists (ruling 13) — do NOT claim an invite was sent. Name
  // what actually happened, and for a freshly minted account point at where the
  // sign-in credential is completed.
  const toast = tempPassword
    ? `Added ${email}, who joins as ${ROLE_LABEL[role]}. Set their sign-in password in Users & access.`
    : `Added ${email}, who joins as ${ROLE_LABEL[role]}`;
  const result: InviteMemberResult = { toast, userId };
  if (tempPassword) result.tempPassword = tempPassword;
  return result;
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

  const userRow = memberNameRow.safeParse(
    db.prepare(`SELECT name, email FROM users WHERE id = ?`).get(input.targetUserId),
  );
  // LV-04: an org-deleted member is named honestly in the toast instead of
  // echoing the raw `u_…` id back at the admin removing it.
  const displayName = userRow.success
    ? userRow.data.name
    : removedAccountLabel(input.targetUserId);

  await updateProjectFile(projectRef(ctx, input.projectSlug), (parsed) => {
    const member = parsed.frontmatter.members.find(
      (m) => m.userId === input.targetUserId,
    );
    if (!member) {
      throw AppError.notFound("That user is not a member of this project.");
    }
    if (member.role === "admin") {
      // UI-29: only LIVE, enabled accounts count — see countLiveAdmins.
      // F18-6: guard the LAST LIVE admin only. A GHOST admin (its org account was
      // deleted, so it's not counted live) removal never reduces the live-admin
      // count — blocking it deadlocked the one recovery path (Members refused the
      // removal, Policy pointed back to Members to do it). `targetLive` is false
      // for a deleted/disabled account, so a ghost admin is always removable; a
      // real last live admin is still protected.
      const targetRow = disabledFlagRow.safeParse(
        db.prepare(`SELECT disabled FROM users WHERE id = ?`).get(input.targetUserId),
      );
      const targetLive = targetRow.success && targetRow.data.disabled !== 1;
      const admins = countLiveAdmins(db, parsed.frontmatter.members);
      if (targetLive && admins <= 1) {
        throw AppError.conflict(
          `${displayName} is the only admin. Assign another admin in Policy first`,
        );
      }
    }
    parsed.frontmatter.members = parsed.frontmatter.members.filter(
      (m) => m.userId !== input.targetUserId,
    );
  });

  reprojectProject(db, ctx, input.projectSlug);
  // A3 (pass 23): a removed member must not stay the OWNER of tasks they can no
  // longer reach. Release each seat (clear → null + a system timeline note) so a
  // contributor+ can take it — the honest form of the dialog's promise that
  // "any task they own returns … for reassignment", which nothing did before.
  const released = await releaseTasksOwnedBy(
    db,
    {
      projectSlug: input.projectSlug,
      userId: input.targetUserId,
      removedName: displayName,
    },
    actor,
    { dataRoot: ctx.dataRoot },
  );
  recordAudit(db, {
    action: "project.member.removed",
    actor: { userId: actor.userId, label: actor.label },
    subjectKind: "user",
    subjectId: input.targetUserId,
    projectSlug: input.projectSlug,
    details: { tasksReleased: released },
  });
  return {
    toast:
      released > 0
        ? `${displayName} removed from ${projectName}. ${released} owned task${released === 1 ? "" : "s"} released for reassignment.`
        : `${displayName} removed from ${projectName}`,
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
      ? `Project "${projectName}" archived. Find it under Archived on Home`
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
  // 404 when opened (F2). Clean them up with the project — through the store
  // module that owns the table (C01-A12).
  deleteProjectNotifications(db, input.projectSlug);

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
