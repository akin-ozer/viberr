import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type {
  AgentDeployment,
  AgentDeploymentDefinition,
  ProjectFrontmatter,
  WorkflowBoundary,
} from "~/schemas/project-file.schema";
import {
  buildLibraryDeployment,
  readLibraryTemplate,
  type DeployOverrides,
} from "~/features/agents/agent-profile-actions.server";
import {
  effectiveProfileView,
  VIEW_WITHOUT_POLICY,
} from "~/features/agents/agents-query.server";
import { deploymentRuntimeIdentity } from "~/server/agents/deployment-view.server";
import {
  assertEffortForBackend,
  assertModelForBackend,
  defaultModelFor,
  foreignModelBackend,
  modelDisplayName,
} from "~/server/runtimes/model-catalog.server";
import type { RealBackend } from "~/server/runtimes/runtime-registry.server";
import { BACKEND_LABEL } from "~/shared/text/backend-label";
import type { BoardDelivers } from "~/shared/board-delivers";
import { SCOPED_DELIVERY_CAPABILITY_IDS } from "~/shared/capabilities";
import { withActionWatchdog } from "~/server/actions/action-watchdog.server";
import { recordAudit, type AuditDetails } from "~/server/audit/audit-recorder.server";
import { AppError } from "~/server/errors/app-error.server";
import { ERROR_CODES } from "~/server/errors/error-codes";
import { getDataRoot } from "~/server/files/file-store-root.server";
import { createProjectFile } from "~/server/files/project-writer.server";
import {
  isReservedTaskPrefix,
  RESERVED_TASK_PREFIX_REFUSAL,
} from "~/shared/dependencies";
import {
  getConnection,
  recordCreatedRepositoryInReach,
} from "~/server/org/connections.server";
import { getProject } from "~/server/projections/board-query.server";
import { reprojectProject } from "~/server/projections/rebuilder.server";
import { recordRepoAccess } from "~/server/github/repo-health.server";
import {
  repositoryIsEmpty,
  type RepoAccessResult,
} from "~/server/github/repo-access-check.server";
import {
  getPatMetadata,
  getPatToken,
  setProjectCredential,
} from "~/server/secrets/pat-store.server";
import {
  createGithubClient,
  githubFailureMessage,
  type GithubClientOptions,
  type GithubResponse,
} from "~/server/github/github-client.server";
import {
  repoPermissionsSchema,
  repoWritable,
} from "~/server/secrets/pat-validator.server";
import { proveAttachedCredential } from "~/features/github/github-actions.server";
import {
  DEFAULT_GUARDRAILS,
  GOVERNED_TEMPLATE,
} from "~/shared/workflow/templates";
import { defaultTransitionBy } from "~/shared/workflow/transitions";
import { defaultAgentDeployments } from "~/server/seed/agent-catalog.server";
import { findUserByEmail } from "~/server/auth/user-store.server";
import type { ProjectRole, StageDef } from "~/schemas/project-file.schema";
import { slugify } from "~/shared/ids/slugify";
import {
  isStageColor,
  STAGE_COLOR_LIST,
  stageColorAt,
  TERMINAL_STAGE_COLOR,
} from "~/shared/workflow/stage-colors";
import { stageName } from "~/shared/workflow/stage-roles";

export type PolicyPreset = "strict" | "balanced" | "auto";

/**
 * The policy preset shapes REAL governance, not just copy:
 *
 * - **strict** — a human gates every stage: the operator does NOT auto-advance
 *   before work starts. Every `auto` boundary short of the last stage becomes
 *   `approval`, so a human must approve triage→ready (and ready→impl) before an
 *   agent touches the repo, and the move into review too (ruling 91 made that
 *   one automatic everywhere else). Operator stays supervised.
 * - **balanced** — the template defaults (the operator advances every boundary
 *   up to review under a supervised operator; review→done human).
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

/** The grants that let an agent change a repository: the headline, and the
 *  scoped steps it gates. */
const REPO_WRITE_CAPABILITY_IDS: readonly string[] = [
  "execute-code-or-write-repo",
  ...SCOPED_DELIVERY_CAPABILITY_IDS,
];

/**
 * Ruling 199: the roster of a board that delivers results. Every specialist
 * is deployed with its repo-write grants explicitly off, the grants the AWS
 * calculator board's agents were built with, so its deliverer hands back the
 * files it saves on the task (ruling 128) and stays that way if a repository
 * is attached later for the agents to read. An explicit `off` is the one mode
 * no layer reinterprets (B-AG1). The operator's own row is left alone.
 */
function withoutRepoWrite(agents: AgentDeployment[]): AgentDeployment[] {
  return agents.map((a) =>
    a.profileId === OPERATOR_PROFILE_ID
      ? a
      : {
          ...a,
          capabilities: [
            ...a.capabilities.filter((c) => !REPO_WRITE_CAPABILITY_IDS.includes(c.capabilityId)),
            ...REPO_WRITE_CAPABILITY_IDS.map((capabilityId) => ({ capabilityId, mode: "off" as const })),
          ],
        },
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
 * much later, when the first agent delivery could not push. The outcome was
 * REPORTED and creation went on, so a project could be made before its
 * repository existed. Ruling 225 (owner, 2026-10-06): a creation GitHub does
 * not confirm is refused (`reachProjectRepository`). The branch such a project
 * was written with was a guess, and `defaultBranch` is what keeps a push off
 * the repository's real default branch. A 10s timeout keeps the action from
 * hanging on a blackholed network.
 */
type RepoProbe =
  | {
      status: "ok";
      defaultBranch: string | null;
      empty: boolean;
      /** `repoWritable`: true, or null when GitHub sent no permissions block. */
      canPush: boolean | null;
    }
  | { status: "read_only"; defaultBranch: string | null; empty: boolean }
  | { status: "not_found" }
  /** 401: GitHub rejected the token. 403: it refused the read for a reason of
   *  its own (single sign-on, an approval still pending, a rate limit), which
   *  `said` carries. */
  | { status: "forbidden"; code: 401 | 403; said: string | null }
  | { status: "unreachable" };

/** The `/repos/{owner}/{repo}` fields this probe reads. Every field is
 *  individually tolerant and the object itself falls back to empty: an
 *  unreadable `permissions` or `size` reads as "unknown" and passes, and an
 *  unreadable `default_branch` reads as none, which creation refuses (ruling
 *  225). The `permissions` block (F20-15, the read-only
 *  proof of write access; only a PROVEN read-only repo is called out) is
 *  decoded and judged by pat-validator.server.ts's `repoPermissionsSchema` /
 *  `repoWritable`. */
const repoResponseSchema = z
  .object({
    default_branch: z.string().optional().catch(undefined),
    permissions: repoPermissionsSchema.optional().catch(undefined),
    // Ruling 227: the cue for the empty-repository read below.
    size: z.number().optional().catch(undefined),
  })
  .catch({ default_branch: undefined, permissions: undefined, size: undefined });

/** GitHub's own sentence on a refusal, when the body carries one. */
const githubMessageSchema = z
  .object({ message: z.string().trim().min(1).nullable().catch(null) })
  .catch({ message: null });

async function probeRemoteRepo(
  token: string,
  repo: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RepoProbe> {
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${repo}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "viberr",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 404) return { status: "not_found" };
    if (res.status === 401 || res.status === 403) {
      const said = githubMessageSchema.parse(await res.json().catch(() => null)).message;
      return { status: "forbidden", code: res.status, said };
    }
    if (!res.ok) return { status: "unreachable" };
    const data = repoResponseSchema.parse(await res.json());
    const defaultBranch = data.default_branch ?? null;
    // Ruling 227 (F40-12): an EXISTING repository with no commit. Live,
    // `akin-ozer/website` was accepted as `ok` with `default_branch: main`, and
    // the first operator run found an unborn `main` and asked the owner to push
    // a README. `size: 0` is the cue, the 409 on the commits read the proof.
    const empty = await repositoryIsEmpty(createGithubClient({ token, fetchImpl }), repo, data.size);
    // F20-14/F20-15: Change repository refuses a repo the credential can only
    // read where the board writes it (ruling 226); the same check belongs at
    // create time (live: creating against a read-only-visible repo was
    // silently accepted and failed only at first delivery).
    const canPush = repoWritable(data.permissions);
    if (canPush === false) {
      return { status: "read_only", defaultBranch, empty };
    }
    return { status: "ok", defaultBranch, empty, canPush };
  } catch {
    return { status: "unreachable" };
  }
}

/** The characters GitHub keeps in a repository name. Anything else it rewrites
 *  to `-` on creation, which would bind the project to a name that does not
 *  exist, so a creation is refused before any call instead. */
const GITHUB_REPO_NAME = /^[A-Za-z0-9._-]+$/;

/** The `POST /user/repos` and `POST /orgs/{org}/repos` fields Viberr sends. */
interface RepositoryCreateBody {
  name: string;
  private: boolean;
  /** The default branch exists from the first moment, so the project can
   *  adopt it and a task branch has something to start from. */
  auto_init: true;
  description?: string;
}

/** GitHub's 422 body names each failed field in `errors[].message` beside the
 *  top-level "Repository creation failed."; any other shape reads as none. */
const githubFieldErrorsSchema = z
  .object({ errors: z.array(z.object({ message: z.string() })).catch([]) })
  .catch({ errors: [] });

/**
 * Ruling 225: why GitHub would not create the repository, in words a person
 * can act on. Every branch is thrown before `project.md` is written, so each
 * one can say that no project exists yet. Only the 422 also says nothing was
 * created: a 5xx or a dropped connection may have landed on GitHub's side, so
 * those promise only the project.
 */
function repositoryRefusal(
  result: Extract<GithubResponse<unknown>, { ok: false }>,
  owner: string,
  repo: string,
  personal: boolean,
): string {
  if (result.kind === "network") {
    return `Couldn't reach GitHub to create ${repo}. No project was written; ask again once GitHub answers.`;
  }
  if (result.status === 401 || result.status === 403) {
    return `The ${owner} connection's token cannot create repositories. A fine-grained token needs Administration: Read and write for All repositories (a classic token needs \`repo\`). Create ${repo} on GitHub, or widen the token, and ask again.`;
  }
  if (result.status === 422) {
    const fields = githubFieldErrorsSchema.parse(result.data).errors.map((e) => e.message);
    const said = githubFailureMessage(result).replace(/\.$/, "");
    return `GitHub refused to create ${repo}: ${said}${fields.length > 0 ? ` (${fields.join("; ")})` : ""}. Nothing was created.`;
  }
  if (result.status === 404 && !personal) {
    return `GitHub has no organization ${owner} that this token can create repositories in. If ${owner} is a personal account, only that account's own token can create repositories there. Create ${repo} on GitHub, or connect ${owner} with a token that can, and ask again.`;
  }
  return `GitHub answered ${result.status} when asked to create ${repo}: ${githubFailureMessage(result).replace(/\.$/, "")}. No project was written; ask again.`;
}

/**
 * Ruling 225: create the repository a project is about to be bound to, when
 * the probe found none, through the connection's own token on the server.
 *
 * The account decides the endpoint: `POST /user/repos` when the connection's
 * owner is the token's own login (as its stored validation recorded it), else
 * `POST /orgs/{owner}/repos`. `auto_init` gives the repository its default
 * branch, so the re-probe that follows adopts it the way an existing
 * repository's is adopted. A repository that already exists is used as it is,
 * and a probe that could not tell (a refused token, an unreachable GitHub)
 * refuses rather than creating a project whose repository nobody made: asked
 * again, that project would only answer "already exists".
 */
async function createRepositoryWhenMissing(
  db: DatabaseSync,
  target: {
    probe: RepoProbe;
    token: string;
    patId: string;
    /** The connection whose token makes it: its stored reach gains it. */
    connectionId: string;
    owner: string;
    repoName: string;
    slug: string;
    request: CreateRepositoryRequest;
  },
  actor: { userId: string; label: string },
  fetchImpl: typeof fetch | undefined,
): Promise<{ probe: RepoProbe; note: string; made: boolean }> {
  const { probe, token, owner, repoName, request } = target;
  const repo = `${owner}/${repoName}`;
  if (probe.status === "ok" || probe.status === "read_only") {
    return { probe, note: `${repo} already exists on GitHub, so the project uses it as it is.`, made: false };
  }
  if (probe.status === "forbidden") {
    throw AppError.validation(
      `The ${owner} connection's token was refused for ${repo}, so Viberr cannot tell whether it exists or create it. Replace the token in Instance settings → GitHub connections and ask again.`,
    );
  }
  if (probe.status === "unreachable") {
    throw AppError.validation(
      `Couldn't reach GitHub to check whether ${repo} exists, so nothing was created. Ask again once GitHub answers.`,
    );
  }
  const login = getPatMetadata(db, target.patId)?.validation?.login ?? null;
  const personal = login !== null && login.toLowerCase() === owner.toLowerCase();
  const clientOptions: GithubClientOptions = { token };
  if (fetchImpl) clientOptions.fetchImpl = fetchImpl;
  const body: RepositoryCreateBody = {
    name: repoName,
    private: request.private,
    auto_init: true,
  };
  const description = request.description?.trim();
  if (description) body.description = description;
  // Sent once: the client's 5xx retry would turn a create GitHub made before
  // failing into a 422 "name already exists", and so into "Nothing was
  // created" (R-repo-1).
  const created = await createGithubClient(clientOptions).request(
    "POST",
    personal ? "/user/repos" : `/orgs/${encodeURIComponent(owner)}/repos`,
    z.unknown(),
    { body, retryServerError: false },
  );
  const made = `Created ${repo} on GitHub (${request.private ? "private" : "public"})`;
  // Ruling 222's dated note (R-seams-4): the token that made the repository
  // reaches it, so the connection's stored reach lists it from now on.
  const reachIt = (after: RepoProbe) =>
    recordCreatedRepositoryInReach(db, target.connectionId, {
      fullName: repo,
      private: request.private,
      canPush: after.status === "ok" ? after.canPush : after.status === "read_only" ? false : null,
    });
  if (created.ok) {
    recordRepositoryCreated(db, target.slug, repo, request.private, actor);
    const after = await probeRemoteRepo(token, repo, fetchImpl);
    reachIt(after);
    return { probe: after, note: `${made}.`, made: true };
  }
  // A 5xx or a dropped connection does not say whether GitHub made it (a slow
  // `auto_init` create can outlive the gateway), so GitHub is asked. The probe
  // said 404 a moment ago; a repository there now is the one this call made.
  const unanswered =
    created.kind === "network" || (created.kind === "http" && created.status >= 500);
  if (unanswered) {
    const after = await probeRemoteRepo(token, repo, fetchImpl);
    if (after.status === "ok" || after.status === "read_only") {
      recordRepositoryCreated(db, target.slug, repo, request.private, actor);
      reachIt(after);
      const answer =
        created.kind === "network"
          ? "the connection dropped before GitHub answered"
          : `GitHub answered ${created.status}`;
      return { probe: after, note: `${made}: ${answer}, but the repository is there now.`, made: true };
    }
  }
  throw AppError.validation(repositoryRefusal(created, owner, repo, personal));
}

/** A GitHub-side write the person asked for: audited the moment GitHub is
 *  known to have made it, so a project write that fails after it still leaves
 *  the repository on the record. */
function recordRepositoryCreated(
  db: DatabaseSync,
  slug: string,
  repo: string,
  isPrivate: boolean,
  actor: { userId: string; label: string },
): void {
  recordAudit(db, {
    action: "project.repository.created",
    actor,
    subjectKind: "project",
    subjectId: slug,
    projectSlug: slug,
    details: { repo, private: isPrivate },
  });
}

/**
 * "New project" action (home spec §5.9/§5.10, §6.1): writes
 * projects/<slug>/project.md from the workflow template (ruling 47),
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
  /** Ruling 224: what the board delivers; `software` when left out. The
   *  agents of a board that delivers results are deployed with repo-write
   *  withheld. Ruling 224: either kind may start with no repository, `owner`
   *  and `repoName` both empty; a software board's agents keep repo-write for
   *  the one it connects later. */
  delivers?: BoardDelivers;
  /** Connection owner (repo account) — Phase-4 stand-in list. Empty for a
   *  project that starts with no repository. */
  owner: string;
  /** Repo name under the owner (already slugified by the modal). */
  repoName: string;
  policy: "strict" | "balanced" | "auto";
  /** Ruling 247: the whole custom shape in one request (the controller's
   *  create-project path; the New-project modal never sets it). Everything
   *  here composes BEFORE the single project.md write, so a refused shape
   *  creates nothing. */
  custom?: CustomProjectBlueprint;
  /** Ruling 225: create `<owner>/<repoName>` on GitHub through the
   *  connection's token when the probe finds no such repository. Both doors
   *  (the controller's `create_project` and the New project modal) set it the
   *  same way; an existing repository makes it a no-op. */
  createRepository?: CreateRepositoryRequest;
  /** Ruling 266: the roster a controller designed. Given, the project is
   *  written with the operator plus exactly these deployments and no base
   *  Developer or Reviewer; absent (the New project modal), the base roster.
   *  Every entry is checked before anything is written. */
  agents?: RosterEntry[];
  /** Ruling 266: the operator's own model and effort, checked the same way.
   *  Ruling 266: and the backend they run on. */
  operator?: OperatorOverrides;
}

/** Ruling 266: the operator's overrides at creation, ruling 266's model and
 *  effort plus the backend they run on (the operator's own when omitted). */
export interface OperatorOverrides extends DeployOverrides {
  backend?: RealBackend;
}

/** Ruling 266: one deployment of a designed roster — a global template by its
 *  store key (as `deploy_agent` takes it), with optional model and effort. */
export interface RosterEntry extends DeployOverrides {
  profileId: string;
}

/** Ruling 225: how a repository created with its project is made. */
export interface CreateRepositoryRequest {
  private: boolean;
  /** The repository's description on GitHub. */
  description?: string;
}

/** The optional custom blueprint a controller-driven creation carries. */
export interface CustomProjectBlueprint {
  /** Project description prose (defaults to the preset blurb). */
  description?: string;
  /** Ordered stage list, entry FIRST, terminal LAST (2..8 stages). Replaces
   *  the Standard template's stages; ids are minted from the names. */
  stages?: { name: string; color?: string }[];
  /** Boundary overrides by stage NAME pair (adjacent chain edges only). The
   *  edge into the terminal stage stays human and locked, whatever is asked. */
  boundaries?: { from: string; to: string; boundary: "auto" | "approval" | "human" }[];
  /** Additional members by email — every email must already be a Viberr user
   *  (the controller creates users first, org-admin gated). The creator is
   *  always seeded admin, whatever this lists. */
  members?: { email: string; role: "admin" | "maintainer" | "contributor" | "viewer" }[];
}

export interface CreateProjectResult {
  slug: string;
  key: string;
  name: string;
  /** Display path for the toast (ruling 15(a) — real store path). */
  storePath: string;
  /** Ruling 224: `<owner>/<name>`, or null for a project with no repository. */
  repo: string | null;
  /**
   * UI-09: what the repository probe found that a person has to act on, or
   * null. Since ruling 225 that is one case: a repository the token can read
   * and cannot push to, which is created against all the same. The caller
   * states it instead of reporting a plain success.
   */
  repoWarning: string | null;
  /**
   * Ruling 225: what a requested repository creation did, as a sentence (the
   * repository was created, or it already existed and was used as it is);
   * null when no creation was asked for.
   */
  repoNote: string | null;
  /** Ruling 266: every deployment written, the operator first, with the model
   *  and effort each resolves to, so a reply can list what was deployed. */
  agents: DeployedAgentSummary[];
}

/** One deployment a creation wrote, as its reply names it. */
export interface DeployedAgentSummary {
  profileId: string;
  name: string;
  model: string;
  effort: string;
}

/** The system operator's profile id; every roster carries it. */
const OPERATOR_PROFILE_ID = "operator";

/** The data root and GitHub transport a caller threads through (the
 *  controller's `create_project` passes both). */
export interface CreateProjectContext {
  dataRoot?: string;
  fetchImpl?: typeof fetch;
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

/**
 * Ruling 32: what a new project is called, its key, and the repository it
 * is bound to, checked before anything else is judged or written. The New
 * project modal, the controller's `create_project` and a board import all
 * start here, so the three are refused for the same reasons in the same words.
 */
export interface NewProjectIdentity {
  name: string;
  key: string;
  owner: string;
  repoName: string;
  /** `<owner>/<repoName>`, or null for a project that starts with no
   *  repository (ruling 224). */
  repo: string | null;
  /** What the board delivers, `software` when the request did not say. */
  delivers: BoardDelivers;
  slug: string;
}

/** The fields {@link checkNewProjectIdentity} reads. */
export type NewProjectIdentityInput = Pick<
  CreateProjectInput,
  "name" | "key" | "delivers" | "owner" | "repoName" | "createRepository"
>;

export function checkNewProjectIdentity(
  db: DatabaseSync,
  input: NewProjectIdentityInput,
): NewProjectIdentity {
  const name = input.name.trim();
  if (name.length < 2) {
    throw AppError.validation("A project name of at least 2 characters is required.");
  }
  const key = input.key.trim().toUpperCase();
  if (!/^[A-Z]{2,4}$/.test(key)) {
    throw AppError.validation("Task key must be 2-4 letters.");
  }
  if (isReservedTaskPrefix(key)) throw AppError.validation(RESERVED_TASK_PREFIX_REFUSAL);
  const owner = input.owner.trim();
  const repoName = input.repoName.trim();
  // Every project took a repository once (owner ruling 2026-07-17, which
  // reversed F10): a board that delivers software hands its work over through
  // GitHub, "and a repo-less one dead-ends the moment execution starts".
  // Ruling 224 let a board that delivers results go without. Ruling 224
  // (owner, 2026-10-06: "repoless boards should exist … at creation") lets
  // every board start without: the dead end is gone, because the operator
  // asks for a repository the first time a task needs one. So a repository is
  // named whole, connection and name, or not at all.
  if (Boolean(owner) !== Boolean(repoName)) {
    throw AppError.validation(
      "Give both a GitHub connection and a repository name, or neither: a board can start without a repository and connect one later.",
    );
  }
  const repo = owner && repoName ? `${owner}/${repoName}` : null;
  if (input.createRepository && repo === null) {
    throw AppError.validation(
      "There is no repository to create: name the GitHub connection and the repository, or leave `createRepository` out.",
    );
  }
  // Ruling 225: for every repository, not only one to create. GitHub answers
  // `website?tab=readme` as `website`, so the probe would confirm one name and
  // the project be written with another.
  if (repo !== null && !GITHUB_REPO_NAME.test(repoName)) {
    throw AppError.validation(
      `GitHub repository names use letters, digits, ".", "-" and "_" only, so "${repoName}" ${input.createRepository ? "cannot be created" : "is not one"}. Pick a name in that alphabet and ask again.`,
    );
  }
  const slug = slugify(name);
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
  return { name, key, owner, repoName, repo, delivers: input.delivers ?? "software", slug };
}

async function createProjectImpl(
  db: DatabaseSync,
  input: CreateProjectInput,
  actor: { userId: string; label: string },
  ctx: CreateProjectContext = {},
): Promise<CreateProjectResult> {
  const identity = checkNewProjectIdentity(db, input);
  const { name } = identity;
  // P13-AP-04 / P13 owner decision 2: the Standard 5-stage board is the ONLY preset.
  // The "Lightweight · 3 stages" template was deleted — it created a board
  // (`todo`/`doing`/`done`) that the preinstalled roster's governed stage ids
  // could never match, so no specialist was assignable. Custom boards are
  // edited in project settings, after creation, where the stage grants can be
  // adjusted alongside them.
  //
  // Ruling 247: the controller's create-project path may carry the WHOLE custom
  // shape (stages, boundaries, members, description) in one request. The shape
  // is validated and composed here, before the single project.md write, so a
  // refused shape creates nothing. The template stays the default.
  const template = GOVERNED_TEMPLATE;
  const blueprint = resolveProjectBlueprint(db, input.custom, actor.userId);
  // Ruling 266: the roster, every template and model/effort judged BEFORE the
  // repository probe and creation below (ruling 225), so a refused roster
  // leaves nothing on GitHub or on disk.
  const roster = resolveRoster(input, name, ctx.dataRoot);
  const reached = await reachProjectRepository(db, identity, input.createRepository, actor, ctx);

  // Synthesized description — verbatim mock mapping (home spec §5.10), unless
  // the custom shape brought its own prose. The board-shape half has to follow
  // the stages actually written below: a custom list described as the
  // "Standard 5-stage workflow" is a stored, projected and rendered claim
  // about a board that does not exist.
  const policyPhrase =
    input.policy === "strict"
      ? "strict human-gate policy."
      : input.policy === "auto"
        ? "agents act within policy."
        : "balanced agent policy.";
  const boardPhrase = blueprint?.stages?.length
    ? `Custom ${blueprint.stages.length}-stage workflow · `
    : "Standard 5-stage workflow · ";
  const desc = blueprint?.description ?? boardPhrase + policyPhrase;

  const stages = blueprint?.stages ?? template.stages;
  const baseWorkflow = blueprint?.workflow ?? template.workflow;
  const frontmatter: ProjectFrontmatter = {
    ...newProjectFrontmatter(identity, reached),
    stages,
    // The policy preset shapes REAL governance (not just the description):
    // strict human-gates the pre-work boundaries; auto runs the operator at
    // full autonomy. See presetWorkflow / presetAgents. A custom shape's
    // explicit boundary choices are applied AFTER the preset, so they win —
    // except the edge into the terminal stage, which stays human and locked
    // whatever anyone asks (resolveProjectBlueprint enforces it).
    workflow: applyBoundaryOverrides(
      presetWorkflow(input.policy, baseWorkflow, stages[stages.length - 1]?.id),
      blueprint?.boundaryOverrides ?? [],
      stages,
    ),
    members: [
      { userId: actor.userId, role: "admin" },
      ...(blueprint?.members ?? []).filter((m) => m.userId !== actor.userId),
    ],
    // Preinstall the default agent roster — the operator plus the base
    // specialists it can assign — so every project can run governed agent work.
    // Ruling 266: a designed roster replaces the base specialists. Ruling
    // 199: on a board that delivers results none of them may write a repository.
    agents: presetAgents(
      input.policy,
      input.delivers === "results" ? withoutRepoWrite(roster) : roster,
    ),
    // Ship the anti-noise guardrails ON — timeline compaction + chatter
    // rejection are product defaults (PRD's #1 risk), not opt-in.
    guardrails: DEFAULT_GUARDRAILS,
    // Ruling 89: no required reviewer until a person or the controller
    // declares one; required-ness stays emergent (engaged verdict-capable
    // agents) until then.
    requiredReviewers: [],
  };

  return writeNewProject(
    db,
    {
      identity,
      reached,
      frontmatter,
      description: desc,
      details: {
        template: blueprint?.stages ? "custom" : template.id,
        delivers: input.delivers ?? "software",
        policy: input.policy,
        customStages: blueprint?.stages?.length ?? 0,
        customMembers: blueprint?.members.length ?? 0,
      },
    },
    actor,
    ctx,
  );
}

/**
 * Ruling 224: the way on from a repository GitHub does not confirm (ruling
 * 225). Creation still refuses to write one, and the person is not stopped:
 * the same project can be made with no repository now.
 */
const START_WITHOUT_REPOSITORY =
  "A project can also start without a repository and connect it later.";

/**
 * Ruling 224: what a board that delivers software is told when it is made
 * with no repository. Its agents keep repo-write, so connecting one is all it
 * takes for tasks to ship as pull requests.
 */
const SOFTWARE_WITHOUT_REPOSITORY_NOTE =
  "It has no repository yet: tasks come back as files until one is connected. The operator asks for it the first time a task needs a pull request, and it can be attached any time in the project's settings.";

/** What the repository probe (and, asked for, its creation) settled before
 *  anything is written: ruling 32 shares it with a board import. */
export interface ReachedRepository {
  /** The connection whose PAT the project is bound to; null for a project
   *  with no repository (ruling 224), which binds none. */
  patId: string | null;
  defaultBranch: string;
  /** UI-09: what the probe found when it was not clean, or null. */
  repoWarning: string | null;
  /** Ruling 225: what a requested creation did; ruling 227: an empty repository. */
  repoNote: string | null;
  /** U33-2: the probe's reading, remembered once the project exists. */
  repoAccess: RepoAccessResult | null;
}

/**
 * Resolve the selected connection, probe the repository with its token and,
 * when asked (ruling 225), create it. Everything here happens BEFORE any file
 * is written, so a refusal leaves nothing on disk.
 */
export async function reachProjectRepository(
  db: DatabaseSync,
  identity: NewProjectIdentity,
  createRepository: CreateRepositoryRequest | undefined,
  actor: { userId: string; label: string },
  ctx: CreateProjectContext = {},
): Promise<ReachedRepository> {
  const { owner, repoName, repo, slug } = identity;
  // Ruling 224: no repository, so no connection to resolve and nothing to
  // probe. `defaultBranch` keeps the schema's own fallback and names nothing.
  // Ruling 224: a software board made with none says what that means, on
  // every door that reports a creation.
  if (repo === null) {
    return {
      patId: null,
      defaultBranch: "main",
      repoWarning: null,
      repoNote: identity.delivers === "results" ? null : SOFTWARE_WITHOUT_REPOSITORY_NOTE,
      repoAccess: null,
    };
  }
  // Resolve the selected connection so we can (a) fetch the repo's real
  // default branch and (b) bind its PAT to the project — a project isn't
  // "connected" to GitHub just by holding a repo string; branch/PR sync and
  // credential health need the credential bound (project_github_credentials).
  // The connection is REQUIRED (same ruling as above): an owner string without
  // a PAT behind it can't deliver anything.
  const connection = getConnection(db, slugify(owner));
  if (!connection) {
    throw AppError.validation(
      `No GitHub connection for "${owner}". Add a PAT for that owner in Instance settings → GitHub connections first.`,
    );
  }
  let repoWarning: string | null = null;
  let repoNote: string | null = null;
  // U33-2: the SAME probe, remembered. Creation is the other place that already
  // knows whether GitHub can serve this repository, and until pass 33 it threw
  // the answer away after one toast — so a project pointed at a repository that
  // does not exist looked healthy on every surface except its GitHub page while
  // every agent run in it died on the clone. Recorded after the project exists,
  // below; mapped onto the shape the board and the home card already read.
  const token = getPatToken(db, connection.patId);
  if (!token) {
    throw AppError.validation(
      `The ${owner} connection has no token Viberr can read, so ${repo} cannot be ${createRepository ? "created" : "confirmed"}. Replace the token in Instance settings → GitHub connections and ask again.`,
    );
  }
  let probe = await probeRemoteRepo(token, repo, ctx.fetchImpl);
  // Ruling 225: BEFORE project.md, so a refusal leaves nothing behind; the
  // probe it hands back (the re-probe of a repository it just made) is the
  // one recorded below.
  let madeNow = false;
  if (createRepository) {
    const made = await createRepositoryWhenMissing(
      db,
      {
        probe,
        token,
        patId: connection.patId,
        connectionId: connection.id,
        owner,
        repoName,
        slug,
        request: createRepository,
      },
      actor,
      ctx.fetchImpl,
    );
    probe = made.probe;
    repoNote = made.note;
    madeNow = made.made;
  }
  // Ruling 225: a repository GitHub did not confirm is not created against.
  // Each refusal is thrown before `project.md` is written, so each can say no
  // project exists. One Viberr made a moment ago is said to be there: asked
  // again, the project uses it as it is.
  const confirmed = (probe.status === "ok" || probe.status === "read_only") && Boolean(probe.defaultBranch);
  if (madeNow && !confirmed) {
    throw AppError.validation(
      `${repoNote} GitHub did not confirm it when asked again, so no project was written. Ask again: the repository is there now, and the project will use it as it is.`,
    );
  }
  if (probe.status === "not_found") {
    throw AppError.validation(
      `GitHub has no repository ${repo} that the ${owner} connection can see. Check the owner and the name, give the connection's token access to it, or have Viberr create it with the project. No project was created. ${START_WITHOUT_REPOSITORY}`,
    );
  }
  if (probe.status === "forbidden") {
    throw AppError.validation(
      probe.code === 401
        ? `GitHub rejected the ${owner} connection's token, so Viberr cannot confirm ${repo}. Replace the token in Instance settings → GitHub connections, then create the project. No project was created. ${START_WITHOUT_REPOSITORY}`
        : `GitHub refused the ${owner} connection's token for ${repo}${probe.said ? ` (${probe.said.replace(/\.$/, "")})` : ""}, so Viberr cannot confirm the repository. Clear what GitHub names, then create the project. No project was created. ${START_WITHOUT_REPOSITORY}`,
    );
  }
  if (probe.status === "unreachable") {
    throw AppError.validation(
      `Couldn't reach GitHub to confirm ${repo}, so no project was created. Try again once GitHub answers. ${START_WITHOUT_REPOSITORY}`,
    );
  }
  if (!probe.defaultBranch) {
    throw AppError.validation(
      `GitHub named no default branch for ${repo}, so Viberr cannot tell which branch tasks start from. Check the repository on GitHub, then try again. No project was created. ${START_WITHOUT_REPOSITORY}`,
    );
  }
  const defaultBranch = probe.defaultBranch;
  // U33-2: the SAME probe, remembered: the board and the home card read it
  // from the project's first moment. Readable but not writable is a DELIVERY
  // problem, not an unreachable repository: the board stays quiet (the GitHub
  // page owns the scope story) and the connection reads as connected.
  const repoAccess: RepoAccessResult = {
    status: "connected",
    repo,
    remoteDefaultBranch: defaultBranch,
    private: false,
  };
  if (probe.empty) repoAccess.empty = true;
  if (probe.status === "read_only") {
    repoAccess.readOnly = true;
    repoWarning = `The ${owner} connection's token can read ${repo} but cannot push to it. Agents won't be able to open branches or PRs there until it's granted write access.`;
  }

  // Ruling 227: an empty repository is stated, not warned about: Viberr makes
  // its first commit (ruling 227's bootstrap) before the first task branch.
  // Its dated note (R-repo-2): not with a token that can only read, which
  // GitHub refuses that commit; the fix is the token, and the note says so.
  if (repoAccess.status === "connected" && repoAccess.empty) {
    const empty = repoAccess.readOnly
      ? `${repo} is empty, and this connection's token can only read it, so Viberr cannot create its first commit on ${defaultBranch} yet. Once the token can push, Viberr makes that commit before the first task branch.`
      : `${repo} is empty: Viberr will create its first commit on ${defaultBranch} before the first task branch, so nobody needs to push one.`;
    repoNote = repoNote ? `${repoNote} ${empty}` : empty;
  }
  return { patId: connection.patId, defaultBranch, repoWarning, repoNote, repoAccess };
}

/** The frontmatter keys every new project starts with, whatever its board:
 *  its identity and repository, a fresh key counter, and nothing that belongs
 *  to work (no credential policy, no leases). */
export function newProjectFrontmatter(
  identity: NewProjectIdentity,
  reached: ReachedRepository,
): Pick<
  ProjectFrontmatter,
  "name" | "slug" | "repo" | "defaultBranch" | "taskPrefix" | "nextTaskNumber" | "credentialPolicy" | "fileLeases"
> {
  return {
    name: identity.name,
    slug: identity.slug,
    repo: identity.repo,
    defaultBranch: reached.defaultBranch,
    taskPrefix: identity.key,
    nextTaskNumber: 1,
    credentialPolicy: null,
    fileLeases: [],
  };
}

/**
 * Write the new project.md, project it, bind the connection's PAT and prove
 * it, remember the repository reading, and record `project.created`. The one
 * place a project comes into existence, whichever door it came through.
 */
export async function writeNewProject(
  db: DatabaseSync,
  project: {
    identity: NewProjectIdentity;
    reached: ReachedRepository;
    frontmatter: ProjectFrontmatter;
    description: string;
    /** What `project.created` records beyond the name, key, repository and
     *  roster every creation records. */
    details: AuditDetails;
  },
  actor: { userId: string; label: string },
  ctx: CreateProjectContext = {},
): Promise<CreateProjectResult> {
  const { identity, reached, frontmatter } = project;
  const { slug, key, name } = identity;
  await createProjectFile(
    { projectSlug: slug, dataRoot: ctx.dataRoot },
    { frontmatter, description: project.description },
  );
  reprojectProject(db, ctx, slug);

  // Bind the selected connection's PAT to the project so credential health,
  // branch creation, and PR sync work against the real repo. Ruling 224: a
  // project with no repository has no connection to bind.
  if (reached.patId !== null) {
    setProjectCredential(db, { projectSlug: slug, patId: reached.patId }, actor);
    // F15-01: creation is the first moment this PAT meets the project's REAL
    // repository, and a fine-grained token's chips stay `assumed` until something
    // probes it. Attach/rotate has always followed the bind with that
    // revalidation; creation did not, which is why a brand-new project showed a
    // credential card affirming scopes nothing had proven. Best-effort by
    // contract — the bind has already happened, and a degraded GitHub must not
    // fail the creation.
    await proveAttachedCredential(db, slug, actor, ctx);
  }

  if (reached.repoAccess) recordRepoAccess(db, slug, reached.repoAccess);
  recordAudit(db, {
    action: "project.created",
    actor,
    subjectKind: "project",
    subjectId: slug,
    projectSlug: slug,
    details: {
      name,
      key,
      repo: frontmatter.repo,
      ...project.details,
      // Ruling 266: which roster was written, the base one or a designed one.
      agents: frontmatter.agents.map((a) => a.profileId),
    },
  });

  return {
    slug,
    key,
    name,
    storePath: `${getDataRoot(ctx.dataRoot)}/projects/${slug}`,
    repo: frontmatter.repo,
    repoWarning: reached.repoWarning,
    repoNote: reached.repoNote,
    agents: frontmatter.agents.map((a) => {
      const view = effectiveProfileView(a, ctx.dataRoot, VIEW_WITHOUT_POLICY);
      return { profileId: a.profileId, name: view.name, model: view.model, effort: view.effort };
    }),
  };
}

/**
 * Ruling 266 (pass 40, F40-7): the roster a project is written with. Absent
 * `agents`, the base one (operator, Developer, Reviewer), as every project
 * got before. Given, the operator plus exactly the listed deployments: a
 * controller that designed six specialists used to get the generic Developer
 * and Reviewer beside them, dispatchable, with no tool to take them off.
 *
 * Every entry is the deployment `deploy_agent` would write for that template
 * (`buildLibraryDeployment`), refused by name here, before any write: an
 * unknown or non-specialist template, a model or effort its backend does not
 * offer, an entry listed twice, and an empty list, which boot would refill
 * with the base specialists (`ensureBaseAgentsDeployed` backfills a project
 * with no specialist at all).
 */
function resolveRoster(
  input: CreateProjectInput,
  projectName: string,
  dataRoot: string | undefined,
): AgentDeployment[] {
  const base = defaultAgentDeployments();
  const operator = withOperatorOverrides(
    base.find((a) => a.profileId === OPERATOR_PROFILE_ID),
    input.operator,
    dataRoot,
  );
  const withOperator = (rest: AgentDeployment[]) => (operator ? [operator, ...rest] : rest);
  const specialists = base.filter((a) => a.profileId !== OPERATOR_PROFILE_ID);
  if (!input.agents) return withOperator(specialists);
  if (input.agents.length === 0) {
    throw AppError.validation(
      "Name at least one agent in `agents`, or leave it out for the base Developer and Reviewer: a project with no specialist gets the base ones back at the next restart. Nothing was created.",
    );
  }
  const seen = new Set<string>();
  const designed = input.agents.map((entry) => {
    const id = entry.profileId.trim();
    if (seen.has(id)) {
      throw AppError.validation(`\`${id}\` is listed twice in \`agents\`. Nothing was created.`);
    }
    seen.add(id);
    const overrides: DeployOverrides = {};
    if (entry.model !== undefined) overrides.model = entry.model;
    if (entry.effort !== undefined) overrides.effort = entry.effort;
    return buildLibraryDeployment(readLibraryTemplate(id, dataRoot), overrides, projectName)
      .deployment;
  });
  return withOperator(designed);
}

/** The operator's deployment with ruling 266's `operator: { model?, effort? }`
 *  applied, each judged by name against the backend it will run on before
 *  anything is written. Only the fields given are written.
 *
 *  Ruling 266: that backend is the one asked for, else the operator's own.
 *  Without the choice here a controller that designed a Codex operator was
 *  refused ("GPT-6 Luna is a Codex model. Claude cannot run it. Pick a model
 *  from the Claude list.") and had to create the project and switch the
 *  backend with `update_agent_deployment`, which the refusal never named. */
function withOperatorOverrides(
  operator: AgentDeployment | undefined,
  overrides: OperatorOverrides | undefined,
  dataRoot: string | undefined,
): AgentDeployment | undefined {
  const model = overrides?.model?.trim() ?? "";
  const effort = overrides?.effort?.trim() ?? "";
  const asked = overrides?.backend;
  if (!operator || (!model && !effort && !asked)) return operator;
  const own: RealBackend =
    deploymentRuntimeIdentity(operator, dataRoot).backends[0] === "codex" ? "codex" : "claude";
  const backend = asked ?? own;
  const foreign = model && !asked ? foreignModelBackend(backend, model) : null;
  if (foreign) {
    throw AppError.validation(
      `${modelDisplayName(foreign, model)} is a ${BACKEND_LABEL[foreign]} model and the operator runs on ` +
        `${BACKEND_LABEL[backend]}. Pass \`backend: "${foreign}"\` in \`operator\` to run it on ` +
        `${BACKEND_LABEL[foreign]}, or pick a ${BACKEND_LABEL[backend]} model. Nothing was created.`,
    );
  }
  if (model) assertModelForBackend(backend, model);
  if (effort) assertEffortForBackend(backend, effort);
  const definition: AgentDeploymentDefinition = { ...operator.definition };
  if (backend !== own) {
    // What `update_agent_deployment` writes for a backend switch: the new
    // backend with its own default model, and no effort carried across.
    definition.backends = [backend];
    definition.model = defaultModelFor(backend);
    delete definition.effort;
  }
  if (model) definition.model = model;
  if (effort) definition.effort = effort;
  return { ...operator, definition };
}

// ------------------------------------------------- custom shape (ruling 247)

/** The composed, validated custom blueprint ready for the frontmatter write. */
interface ResolvedBlueprint {
  description?: string;
  stages?: StageDef[];
  workflow?: WorkflowBoundary[];
  boundaryOverrides: { fromId: string; toId: string; boundary: "auto" | "approval" | "human" }[];
  members: { userId: string; role: ProjectRole }[];
}

const CUSTOM_STAGE_MIN = 2;
const CUSTOM_STAGE_MAX = 8;
/**
 * Validate + compose the custom blueprint (controller create path). Everything
 * throws `AppError.validation` with the offending item named, BEFORE any
 * write. The terminal edge is forced `human` + locked whatever was asked —
 * the same invariant `realignChainToStages` recomputes on every stage edit.
 */
function resolveProjectBlueprint(
  db: DatabaseSync,
  custom: CustomProjectBlueprint | undefined,
  creatorUserId: string,
): ResolvedBlueprint | null {
  if (!custom) return null;
  const out: ResolvedBlueprint = { boundaryOverrides: [], members: [] };
  if (custom.description?.trim()) out.description = custom.description.trim();

  let stages: StageDef[] | null = null;
  if (custom.stages && custom.stages.length > 0) {
    const names = custom.stages.map((s) => s.name.trim()).filter(Boolean);
    if (names.length !== custom.stages.length) {
      throw AppError.validation("Every custom stage needs a name.");
    }
    if (names.length < CUSTOM_STAGE_MIN || names.length > CUSTOM_STAGE_MAX) {
      throw AppError.validation(
        `A custom board carries ${CUSTOM_STAGE_MIN} to ${CUSTOM_STAGE_MAX} stages (got ${names.length}).`,
      );
    }
    // Ruling 279: a colour is one of twenty preset NAMES or nothing. The name is
    // the whole value — the file stores it and the stylesheet paints it — so
    // the door checks the name; ruling 279's hex/token contract is gone with
    // the stored `slate`/`amber` it left drawing nothing.
    for (const s of custom.stages) {
      const color = s.color?.trim();
      if (color && !isStageColor(color)) {
        throw AppError.validation(
          `Stage "${s.name.trim()}" names the colour "${color}", which is not a stage colour preset. Pick one of: ${STAGE_COLOR_LIST}, or omit it for the palette.`,
        );
      }
    }
    const seen = new Set<string>();
    stages = custom.stages.map((s, i) => {
      const name = s.name.trim();
      let id = slugify(name) || `stage-${i + 1}`;
      while (seen.has(id)) id = `${id}-${i + 1}`;
      seen.add(id);
      const isTerminal = i === custom.stages!.length - 1;
      // The loop above refused any non-preset name, so the guard here only
      // narrows the type; an omitted colour walks the default sequence, the
      // terminal lane keeping green.
      const asked = s.color?.trim();
      const color =
        asked && isStageColor(asked)
          ? asked
          : isTerminal
            ? TERMINAL_STAGE_COLOR
            : stageColorAt(i);
      return { id, name, color };
    });
    out.stages = stages;
    // The default chain over a custom list mirrors the Standard template's
    // structure: every pre-work edge auto, the edge into the stage before
    // terminal approval, the edge into terminal human + locked.
    const chain: WorkflowBoundary[] = [];
    for (let i = 0; i < stages.length - 1; i += 1) {
      const to = stages[i + 1]!;
      const intoTerminal = i + 1 === stages.length - 1;
      const intoReview = i + 1 === stages.length - 2;
      const boundary = intoTerminal ? "human" : intoReview ? "approval" : "auto";
      chain.push({
        from: stages[i]!.id,
        to: to.id,
        boundary,
        by: defaultTransitionBy(boundary),
        locked: intoTerminal,
      });
    }
    out.workflow = chain;
  }

  if (custom.boundaries && custom.boundaries.length > 0) {
    const list = stages ?? GOVERNED_TEMPLATE.stages;
    const byName = new Map(list.map((s) => [s.name.toLowerCase(), s.id]));
    const byId = new Map(list.map((s) => [s.id, s.id]));
    const resolve = (name: string): string => {
      const id = byName.get(name.trim().toLowerCase()) ?? byId.get(name.trim());
      if (!id) {
        throw AppError.validation(`No stage named "${name}" in the custom board.`);
      }
      return id;
    };
    const terminalId = list[list.length - 1]?.id;
    for (const b of custom.boundaries) {
      const fromId = resolve(b.from);
      const toId = resolve(b.to);
      if (toId === terminalId && b.boundary !== "human") {
        throw AppError.validation(
          "The move into the final stage is decided by a human. That boundary cannot be loosened.",
        );
      }
      out.boundaryOverrides.push({ fromId, toId, boundary: b.boundary });
    }
  }

  if (custom.members && custom.members.length > 0) {
    const seen = new Set<string>();
    for (const m of custom.members) {
      const user = findUserByEmail(db, m.email.trim().toLowerCase());
      if (!user) {
        throw AppError.validation(
          `No Viberr user with the email ${m.email}. Create the user first, then create the project.`,
        );
      }
      if (user.id === creatorUserId || seen.has(user.id)) continue;
      seen.add(user.id);
      out.members.push({ userId: user.id, role: m.role });
    }
  }
  return out;
}

/** Apply explicit boundary choices over the (preset-shaped) chain. Only
 *  declared adjacent edges can match — an override naming a non-edge pair is
 *  refused so a silent no-op cannot read as applied. */
function applyBoundaryOverrides(
  workflow: WorkflowBoundary[],
  overrides: ResolvedBlueprint["boundaryOverrides"],
  stages: readonly StageDef[],
): WorkflowBoundary[] {
  if (overrides.length === 0) return workflow;
  const out = workflow.map((w) => ({ ...w }));
  for (const o of overrides) {
    const edge = out.find((w) => w.from === o.fromId && w.to === o.toId);
    if (!edge) {
      throw AppError.validation(
        `There is no workflow edge from "${stageName(stages, o.fromId)}" to "${stageName(stages, o.toId)}": boundaries exist between adjacent stages only.`,
      );
    }
    if (edge.locked) continue; // terminal edge: human, locked, non-negotiable
    edge.boundary = o.boundary;
    edge.by = defaultTransitionBy(o.boundary);
  }
  return out;
}
