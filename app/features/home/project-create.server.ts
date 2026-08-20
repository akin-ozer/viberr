import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type {
  AgentDeployment,
  ProjectFrontmatter,
  WorkflowBoundary,
} from "~/schemas/project-file.schema";
import { withActionWatchdog } from "~/server/actions/action-watchdog.server";
import { recordAudit } from "~/server/audit/audit-recorder.server";
import { AppError } from "~/server/errors/app-error.server";
import { ERROR_CODES } from "~/server/errors/error-codes";
import {
  getDataRoot,
  projectFilePath,
} from "~/server/files/file-store-root.server";
import { createProjectFile } from "~/server/files/project-writer.server";
import { getConnection } from "~/server/org/connections.server";
import { getProject } from "~/server/projections/board-query.server";
import { rebuildPath } from "~/server/projections/rebuilder.server";
import { getPatToken, setProjectCredential } from "~/server/secrets/pat-store.server";
import { proveAttachedCredential } from "~/features/github/github-actions.server";
import {
  DEFAULT_GUARDRAILS,
  GOVERNED_TEMPLATE,
} from "~/shared/workflow/templates";
import { defaultAgentDeployments } from "~/server/seed/agent-catalog.server";
import { slugifyProjectName } from "./project-name";

export type PolicyPreset = "strict" | "balanced" | "auto";

/**
 * The policy preset shapes REAL governance, not just copy:
 *
 * - **strict** — a human gates every stage: the operator does NOT auto-advance
 *   before work starts. Every pre-work `auto` boundary becomes `approval`, so a
 *   human must approve triage→ready (and ready→impl) before an agent touches the
 *   repo. Operator stays supervised.
 * - **balanced** — the template defaults (pre-work boundaries auto-advance under
 *   a supervised operator; impl→review approval; review→done human).
 * - **auto** — the operator runs at FULL autonomy: it crosses the governed
 *   boundaries itself and accepts completion (review→done stays human-locked,
 *   an invariant no preset can grant).
 */
function presetWorkflow(
  preset: PolicyPreset,
  workflow: readonly WorkflowBoundary[],
  lastStageId: string | undefined,
): WorkflowBoundary[] {
  if (preset !== "strict") return workflow.map((b) => ({ ...b }));
  return workflow.map((b) =>
    // Human-gate the pre-work auto boundaries; never touch the locked
    // review→done (into the last stage) boundary.
    b.boundary === "auto" && b.to !== lastStageId
      ? {
          ...b,
          boundary: "approval",
          by: "Human approval (strict policy) before work advances",
        }
      : { ...b },
  );
}

/**
 * `auto` preset → the operator deployment runs at full autonomy AND is
 * explicitly granted `completion-for-acceptance: direct`. The explicit grant
 * matters: acceptance-to-Done is the one capability full autonomy does NOT
 * promote from `recommend` (owner ruling Q1 — the human-only-Done exception
 * requires an explicit `direct`), so the autonomous preset states it outright.
 */
function presetAgents(
  preset: PolicyPreset,
  agents: AgentDeployment[],
): AgentDeployment[] {
  // `strict` preset -> delivery (push + review PR) is recommend-only: the
  // preset whose point is a human gating every advance must not ship an
  // operator that pushes branches at its own discretion (R15-2; the shipped
  // template default is `direct` for the balanced/auto presets).
  if (preset === "strict") {
    return agents.map((a) =>
      a.profileId === "operator"
        ? {
            ...a,
            capabilities: [
              ...a.capabilities.filter(
                (c) => c.capabilityId !== "deliver-review-pr",
              ),
              { capabilityId: "deliver-review-pr", mode: "recommend" as const },
            ],
          }
        : a,
    );
  }
  if (preset !== "auto") return agents;
  return agents.map((a) =>
    a.profileId === "operator"
      ? {
          ...a,
          capabilities: [
            ...a.capabilities.filter(
              (c) => c.capabilityId !== "completion-for-acceptance",
            ),
            { capabilityId: "completion-for-acceptance", mode: "direct" as const },
          ],
          definition: {
            ...a.definition,
            autonomy: "full" as const,
          },
        }
      : a,
  );
}

/**
 * Probe the repository with the connection's token.
 *
 * UI-09: this used to be a silent best-effort default-branch fetch — a 404 (a
 * typo'd repo name, or one the token cannot see) was swallowed, the branch fell
 * back to `main`, and the toast reported plain success. The failure surfaced
 * much later, when the first agent delivery could not push. The outcome is
 * REPORTED now so creation can disclose it; creation itself is deliberately not
 * blocked (creating the Viberr project before the GitHub repo exists is a real
 * flow), and a 10s timeout keeps the action from hanging on a blackholed
 * network.
 */
type RepoProbe =
  | { status: "ok"; defaultBranch: string | null }
  | { status: "read_only"; defaultBranch: string | null }
  | { status: "not_found" }
  | { status: "forbidden" }
  | { status: "unreachable" };

/**
 * F20-15: `/repos/{owner}/{repo}` returns the `permissions` block computed for
 * THIS token — the read-only proof of write access. A project exists to push
 * branches and open PRs, so a repo the credential can only READ is not
 * deliverable. Tri-state: `null` (permissions absent) is "unknown" and passes;
 * only a PROVEN read-only repo (push === false) is called out. Mirrors the
 * (module-private) `repoWritable` in pat-validator.server.ts.
 */
const repoPermissionsSchema = z.object({
  admin: z.boolean().optional().catch(undefined),
  maintain: z.boolean().optional().catch(undefined),
  push: z.boolean().optional().catch(undefined),
});
type RepoPermissions = z.infer<typeof repoPermissionsSchema>;

/** The `/repos/{owner}/{repo}` fields this probe reads. Every field is
 *  individually tolerant and the object itself falls back to empty: GitHub
 *  answering in an unexpected shape must read as "unknown" (the probe passes),
 *  never as a failed creation. */
const repoResponseSchema = z
  .object({
    default_branch: z.string().optional().catch(undefined),
    permissions: repoPermissionsSchema.optional().catch(undefined),
  })
  .catch({ default_branch: undefined, permissions: undefined });

function repoPushable(permissions: RepoPermissions | undefined): boolean | null {
  if (!permissions) return null;
  if (permissions.admin === true || permissions.maintain === true || permissions.push === true) {
    return true;
  }
  if (permissions.push === false) return false;
  return null;
}

/** The optional overrides `proveAttachedCredential` accepts, named so the call
 *  below can be built one key at a time. */
interface ProveCredentialContext {
  dataRoot?: string;
  fetchImpl?: typeof fetch;
}

async function probeRemoteRepo(
  token: string,
  repo: string,
): Promise<RepoProbe> {
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "viberr",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 404) return { status: "not_found" };
    if (res.status === 401 || res.status === 403) return { status: "forbidden" };
    if (!res.ok) return { status: "unreachable" };
    const data = repoResponseSchema.parse(await res.json());
    const defaultBranch = data.default_branch ?? null;
    // F20-14/F20-15: Repair refuses a repo the credential can only read; the same
    // check belongs at create time (live: creating against a read-only-visible
    // repo was silently accepted and failed only at first delivery).
    if (repoPushable(data.permissions) === false) {
      return { status: "read_only", defaultBranch };
    }
    return { status: "ok", defaultBranch };
  } catch {
    return { status: "unreachable" };
  }
}

/**
 * "New project" action (home spec §5.9/§5.10, §6.1): writes
 * projects/<slug>/project.md from the workflow template (ruling 15),
 * projects it, audits. The creator joins as project admin.
 *
 * The policy preset shapes REAL governance (S1): `strict` human-gates the
 * pre-work boundaries, `auto` runs the operator at full autonomy + grants it
 * completion-for-acceptance — see presetWorkflow / presetAgents. review→done
 * stays human-locked in every preset.
 */

export interface CreateProjectInput {
  name: string;
  /** Task key prefix, 2–4 uppercase letters. */
  key: string;
  /** Connection owner (repo account) — Phase-4 stand-in list. */
  owner: string;
  /** Repo name under the owner (already slugified by the modal). */
  repoName: string;
  policy: "strict" | "balanced" | "auto";
}

export interface CreateProjectResult {
  slug: string;
  key: string;
  name: string;
  /** Display path for the toast (ruling 3 — real store path). */
  storePath: string;
  /**
   * UI-09: what the repository probe found, or null when no token was
   * available to probe with. A non-`ok` value means the project was created but
   * agents will not be able to deliver until it's resolved — the caller states
   * that instead of reporting a plain success.
   */
  repoWarning: string | null;
}

/** Test overrides; production leaves every key off. `createProjectFileImpl`
 *  stands in for the project.md write (F20-1 fault injection), defaulting to
 *  the real `createProjectFile`. */
interface CreateProjectContext {
  dataRoot?: string;
  fetchImpl?: typeof fetch;
  createProjectFileImpl?: typeof createProjectFile;
}

export async function createProject(
  db: DatabaseSync,
  input: CreateProjectInput,
  actor: { userId: string; label: string },
  ctx: CreateProjectContext = {},
): Promise<CreateProjectResult> {
  // F20-1: guard the whole mutating action behind the data-root watchdog, so a
  // hung/unreachable mount fails THIS action with a typed error instead of
  // wedging the request. The real work lives in createProjectImpl — later
  // edits (create-time repo probe, C-PROJECT-SETTINGS) go there, unwrapped.
  // See action-watchdog.server.ts for what the guard can and cannot interrupt.
  return withActionWatchdog(
    `create-project:${input.key || "?"}`,
    () => createProjectImpl(db, input, actor, ctx),
  );
}

async function createProjectImpl(
  db: DatabaseSync,
  input: CreateProjectInput,
  actor: { userId: string; label: string },
  ctx: CreateProjectContext = {},
): Promise<CreateProjectResult> {
  const name = input.name.trim();
  if (name.length < 2) {
    throw AppError.validation("A project name of at least 2 characters is required.");
  }
  const key = input.key.trim().toUpperCase();
  if (!/^[A-Z]{2,4}$/.test(key)) {
    throw AppError.validation("Task key must be 2-4 letters.");
  }
  const owner = input.owner.trim();
  const repoName = input.repoName.trim();
  // Repo-bound projects only (owner ruling 2026-07-17, reverses F10): every
  // project needs `<owner>/<name>` — agents deliver through GitHub, so a
  // repo-less project dead-ends the moment execution starts. Creation is
  // therefore gated behind adding a PAT connection.
  if (!owner || !repoName) {
    throw AppError.validation(
      "A GitHub repository is required. Pick a GitHub connection and a repository name. Add a PAT in Instance settings → GitHub connections first.",
    );
  }
  const slug = slugifyProjectName(name);
  if (!slug) {
    throw AppError.validation("The project name must contain letters or digits.");
  }
  if (getProject(db, slug)) {
    throw new AppError({
      code: ERROR_CODES.CONFLICT,
      status: 409,
      userMessage: `A project at projects/${slug} already exists.`,
    });
  }
  // P13-AP-04 / owner ruling 2: the Standard 5-stage board is the ONLY preset.
  // The "Lightweight · 3 stages" template was deleted — it created a board
  // (`todo`/`doing`/`done`) that the preinstalled roster's governed stage ids
  // could never match, so no specialist was assignable. Custom boards are
  // edited in project settings, after creation, where the stage grants can be
  // adjusted alongside them.
  const template = GOVERNED_TEMPLATE;
  const repo = `${owner}/${repoName}`;

  // Resolve the selected connection so we can (a) fetch the repo's real
  // default branch and (b) bind its PAT to the project — a project isn't
  // "connected" to GitHub just by holding a repo string; branch/PR sync and
  // credential health need the credential bound (project_github_credentials).
  // The connection is REQUIRED (same ruling as above): an owner string without
  // a PAT behind it can't deliver anything.
  const connection = getConnection(db, owner);
  if (!connection) {
    throw AppError.validation(
      `No GitHub connection for "${owner}". Add a PAT for that owner in Instance settings → GitHub connections first.`,
    );
  }
  let defaultBranch = "main";
  let repoWarning: string | null = null;
  {
    const token = getPatToken(db, connection.patId);
    if (token) {
      const probe = await probeRemoteRepo(token, repo);
      if (probe.status === "ok") {
        if (probe.defaultBranch) defaultBranch = probe.defaultBranch;
      } else if (probe.status === "read_only") {
        // The repo exists and is visible, so we can adopt its default branch —
        // but the token can't push, so delivery will fail until it's fixed.
        if (probe.defaultBranch) defaultBranch = probe.defaultBranch;
        repoWarning = `The ${owner} connection's token can read ${repo} but cannot push to it. Agents won't be able to open branches or PRs there until it's granted write access.`;
      } else if (probe.status === "not_found") {
        repoWarning = `GitHub has no repository ${repo} that this connection can see. Check the name, or create it before agents start delivering.`;
      } else if (probe.status === "forbidden") {
        repoWarning = `The ${owner} connection's token was refused for ${repo}. Agents won't be able to deliver until it's replaced.`;
      } else {
        repoWarning = `Couldn't reach GitHub to verify ${repo}. The project was created with the default branch "main".`;
      }
    }
  }

  // Synthesized description — verbatim mock mapping (home spec §5.10).
  const desc =
    "Standard 5-stage workflow · " +
    (input.policy === "strict"
      ? "strict human-gate policy."
      : input.policy === "auto"
        ? "agents act within policy."
        : "balanced agent policy.");

  const frontmatter: ProjectFrontmatter = {
    name,
    slug,
    repo,
    defaultBranch,
    taskPrefix: key,
    nextTaskNumber: 1,
    stages: template.stages,
    // The policy preset shapes REAL governance (not just the description):
    // strict human-gates the pre-work boundaries; auto runs the operator at
    // full autonomy. See presetWorkflow / presetAgents.
    workflow: presetWorkflow(
      input.policy,
      template.workflow,
      template.stages[template.stages.length - 1]?.id,
    ),
    members: [{ userId: actor.userId, role: "admin" }],
    // Preinstall the default agent roster — the operator plus the base
    // specialists it can assign — so every project can run governed agent work.
    agents: presetAgents(input.policy, defaultAgentDeployments()),
    credentialPolicy: null,
    // Ship the anti-noise guardrails ON — timeline compaction + operator brevity
    // are product defaults (PRD's #1 risk), not opt-in.
    guardrails: DEFAULT_GUARDRAILS,
  };

  await (ctx.createProjectFileImpl ?? createProjectFile)(
    { projectSlug: slug, dataRoot: ctx.dataRoot },
    { frontmatter, description: desc },
  );
  rebuildPath(db, projectFilePath(slug, ctx.dataRoot), {
    dataRoot: ctx.dataRoot,
  });

  // Bind the selected connection's PAT to the project so credential health,
  // branch creation, and PR sync work against the real repo.
  setProjectCredential(db, { projectSlug: slug, patId: connection.patId }, actor);
  // F15-01: creation is the first moment this PAT meets the project's REAL
  // repository, and a fine-grained token's chips stay `assumed` until something
  // probes it. Attach/rotate has always followed the bind with that
  // revalidation; creation did not, which is why a brand-new project showed a
  // credential card affirming scopes nothing had proven. Best-effort by
  // contract — the bind has already happened, and a degraded GitHub must not
  // fail the creation.
  // Only the overrides this caller actually has: a key present with `undefined`
  // is not the same as an absent one to the credential prover's own defaults.
  const proveCtx: ProveCredentialContext = {};
  if (ctx.dataRoot) proveCtx.dataRoot = ctx.dataRoot;
  if (ctx.fetchImpl) proveCtx.fetchImpl = ctx.fetchImpl;
  await proveAttachedCredential(db, slug, actor, proveCtx);

  recordAudit(db, {
    action: "project.created",
    actor,
    subjectKind: "project",
    subjectId: slug,
    projectSlug: slug,
    details: { name, key, repo: frontmatter.repo, template: template.id, policy: input.policy },
  });

  return {
    slug,
    key,
    name,
    storePath: `${getDataRoot(ctx.dataRoot)}/projects/${slug}`,
    repoWarning,
  };
}
