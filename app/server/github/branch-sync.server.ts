import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { AuditActor } from "~/server/audit/audit-recorder.server";
import { recordAudit } from "~/server/audit/audit-recorder.server";
import {
  patchTaskFrontmatter,
  readTaskFile,
  resolveTaskFilePath,
  appendTimelineEvent,
} from "~/server/files/task-writer.server";
import { rebuildPath } from "~/server/projections/rebuilder.server";
import { logger } from "~/server/logging/logger.server";
import {
  encodeRefPath,
  githubFailureMessage,
  isMissingRefAnswer,
  type GithubClient,
} from "./github-client.server";
import { ensureDefaultBranch } from "./repo-bootstrap.server";
export { isMissingRefAnswer };
import {
  getProjectGithubContext,
  type GithubContextFailure,
  type GithubContextOptions,
} from "./github-context.server";
import { flagScopeViolation, policyViolationText } from "./scope-flag.server";
import { errorMessage, toError } from "~/shared/errors";

/**
 * Branch sync (Phase 7): task-key execution branches
 * (`vib-142-attach-workspace`) created from the project default branch via
 * the git refs API, plus the real compare data (ahead/behind) the sync
 * pill derives from (ruling 12: merged > behind > synced — never from
 * `validation === "failing"` like the mock).
 *
 * Idempotent by design: an existing branch is SUCCESS (`created: false`);
 * a 422 "Reference already exists" race is success too.
 */

// --------------------------------------------------------------- naming

/**
 * The task's ONE branch: the lowercased key and nothing else —
 * taskBranchName("VIB-142") → "vib-142". The old `<key>-<title-slug>` form
 * (owner ruling 2026-07-17) added no identity (the key IS the identifier)
 * and produced awkward truncations like "vib-1-list-files-in-the"; one
 * task, one predictable branch. Existing tasks keep whatever `branch:`
 * their frontmatter already stores — this only defaults NEW branches.
 */
export function taskBranchName(taskKey: string): string {
  return taskKey.toLowerCase();
}

/**
 * Ruling 122 — how many names the allocator will try before giving up. The
 * first is the canonical key; the rest carry a random suffix, so six is far
 * past the point where a collision is chance rather than a bug.
 */
const BRANCH_NAME_ATTEMPTS = 6;

/**
 * Ruling 122 — the suffix that makes a reused task key harmless. Four hex
 * characters off `randomBytes`, not a counter: a counter has to READ the
 * neighbours to know it is next, and the thing being avoided is precisely a
 * name whose history this data root cannot see.
 */
function branchNameSuffix(): string {
  return randomBytes(2).toString("hex");
}

/** The n-th candidate name for a task: canonical first, then suffixed. */
export function taskBranchCandidate(taskKey: string, attempt: number): string {
  const canonical = taskBranchName(taskKey);
  return attempt === 0 ? canonical : `${canonical}-${branchNameSuffix()}`;
}

/**
 * Ruling 122 — is this branch name already spoken for on the remote?
 *
 * "Taken" is a REF **or any pull request ever opened on the name** (owner,
 * 2026-09-03). The PR half is the load-bearing one: task keys restart at 1 on a
 * new data root (ruling 34), so `vib-1` on GitHub can still carry a previous
 * instance's merged PR while no ref exists at all — which is exactly the state
 * that used to raise a branch collision, stop the operator and demand a human
 * decision for a delivery that then succeeded on the first press (pass 33,
 * F33-1, reproduced on VIB-1 and VIB-2).
 */
type BranchNameProbe =
  | { kind: "free" }
  | { kind: "taken" }
  | { kind: "forbidden"; what: string }
  | { kind: "auth"; message: string }
  | { kind: "network"; message: string };

async function probeBranchName(
  client: GithubClient,
  repo: string,
  branch: string,
): Promise<BranchNameProbe> {
  const ref = await client.request(
    "GET",
    `/repos/${repo}/git/ref/${encodeRefPath(`heads/${branch}`)}`,
    z.unknown(),
  );
  if (ref.ok) return { kind: "taken" };
  if (ref.kind === "network") return { kind: "network", message: ref.message };
  if (ref.kind === "http" && ref.status === 401) {
    return { kind: "auth", message: ref.message };
  }
  if (ref.kind === "http" && ref.status === 403) {
    return { kind: "forbidden", what: `Reading branch \`${branch}\` was refused.` };
  }
  if (!isMissingRefAnswer(ref)) {
    return { kind: "network", message: githubFailureMessage(ref) };
  }

  // No ref. Any pull request that ever used the name still makes it taken.
  const owner = repo.split("/")[0] ?? repo;
  const pulls = await client.request(
    "GET",
    `/repos/${repo}/pulls`,
    z.array(z.unknown()),
    { searchParams: { head: `${owner}:${branch}`, state: "all", per_page: 1 } },
  );
  if (pulls.ok) return pulls.data.length > 0 ? { kind: "taken" } : { kind: "free" };
  if (pulls.kind === "network") {
    return { kind: "network", message: pulls.message };
  }
  if (pulls.kind === "http" && pulls.status === 401) {
    return { kind: "auth", message: pulls.message };
  }
  if (pulls.kind === "http" && pulls.status === 403) {
    return {
      kind: "forbidden",
      what: `Listing pull requests on \`${branch}\` was refused.`,
    };
  }
  return { kind: "network", message: githubFailureMessage(pulls) };
}

/** The outcome of picking a name for a task that has never had one. */
export type BranchAllocation =
  | { status: "ok"; branch: string; suffixed: boolean }
  | { status: "forbidden"; what: string }
  | { status: "auth_failed"; message: string }
  | { status: "network_unavailable"; message: string };

/**
 * Ruling 122 — pick the task's branch name once, on first creation.
 *
 * The canonical `taskBranchName` wins whenever it is free. When it is not, the
 * task gets `<key>-<4 hex>` instead of colliding, and the caller persists the
 * choice into `task.md` `branch:` — the field every reader already prefers over
 * the derived name (`pr-open`, `push-workspace`, this module). The remedy that
 * used to be a human decision is now a name nobody has to think about.
 */
async function allocateTaskBranchName(
  client: GithubClient,
  repo: string,
  taskKey: string,
): Promise<BranchAllocation> {
  for (let attempt = 0; attempt < BRANCH_NAME_ATTEMPTS; attempt += 1) {
    const candidate = taskBranchCandidate(taskKey, attempt);
    const probe = await probeBranchName(client, repo, candidate);
    if (probe.kind === "free") {
      return { status: "ok", branch: candidate, suffixed: attempt > 0 };
    }
    if (probe.kind === "forbidden") {
      return { status: "forbidden", what: probe.what };
    }
    if (probe.kind === "auth") {
      return { status: "auth_failed", message: probe.message };
    }
    if (probe.kind === "network") {
      return { status: "network_unavailable", message: probe.message };
    }
  }
  return {
    status: "network_unavailable",
    message: `Could not find a free branch name for ${taskKey} after ${BRANCH_NAME_ATTEMPTS} tries.`,
  };
}

// -------------------------------------------------------------- compare

/** One compare commit: the short sha and first line the file records, plus
 *  (ruling 132) the full sha and parents the drift classifier reads. */
export interface BranchCompareCommit {
  sha: string;
  fullSha: string;
  msg: string;
  parents: string[];
}

export interface BranchCompare {
  aheadBy: number;
  behindBy: number;
  /** GitHub compare status: "ahead" | "behind" | "identical" | "diverged". */
  status: string;
  /** Commits the branch is ahead by (short sha + first message line, full
   *  sha and parents). `taskCommits` projects the `{sha, msg}` pair the task
   *  file keeps, so `github.commits` never changes shape. */
  commits: BranchCompareCommit[];
  /**
   * F21-8 — how many entries of that list GitHub sent and this reader could not
   * decode. `commits` is consumed as the branch's FOOTPRINT (task-key commit
   * association, the branch panel, delivery evidence), so a dropped entry is a
   * fact the caller has to be able to see: 0 means the list is complete.
   */
  droppedCommits: number;
}

/** ONE compare commit. `sha` is the identity — an entry without one names no
 *  commit — so the entry is dropped WHOLE (and counted, below) rather than
 *  admitted with a blank sha. The message carries its reader's `??`-tolerance. */
const ghCompareCommitSchema = z.object({
  sha: z.string(),
  commit: z
    .object({ message: z.string().optional().catch(undefined) })
    .optional()
    .catch(undefined),
  /** Ruling 132: the parent shas, so a merge commit can be told from an
   *  authored one. Tolerated entry by entry; an unreadable list reads as none. */
  parents: z
    .array(z.object({ sha: z.string() }).nullable().catch(null))
    .optional()
    .catch(undefined),
});

/**
 * The compare payload's read slice, with the readers' own `??`-tolerance baked
 * in — every field degrades to the caller's fallback on drift, so a mangled
 * response yields the same "identical / 0 / 0" answer the raw reads produced.
 *
 * The commit entries are tolerated ONE BY ONE (`null` = undecodable). Voiding
 * the array on a single bad entry emptied the whole list while `ahead_by`
 * survived — a branch that reads "4 commits ahead" with no commits to show,
 * and a delivery footprint silently reduced to nothing.
 */
const ghCompareSchema = z
  .object({
    ahead_by: z.number().optional().catch(undefined),
    behind_by: z.number().optional().catch(undefined),
    status: z.string().optional().catch(undefined),
    commits: z
      .array(ghCompareCommitSchema.nullable().catch(null))
      .optional()
      .catch(undefined),
  })
  .catch({});

export type BranchCompareResult =
  | { status: "ok"; compare: BranchCompare }
  | { status: "missing_ref" }
  | { status: "forbidden"; message: string }
  // A 403 caused by RATE LIMITING, not a missing scope (DG-3). GitHub returns
  // 403 for both; conflating them lets a transient rate-limit blip auto-open a
  // bogus `repo` scope violation. Callers treat this as transient (skip/retry),
  // never as a permissions failure.
  | { status: "rate_limited"; message: string }
  | { status: "auth_failed"; message: string }
  | { status: "network_unavailable"; message: string };

export async function getBranchCompare(
  client: GithubClient,
  repo: string,
  base: string,
  head: string,
): Promise<BranchCompareResult> {
  const result = await client.request(
    "GET",
    `/repos/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
    ghCompareSchema,
    { searchParams: { per_page: 250 } },
  );
  if (result.ok) {
    const entries = result.data.commits ?? [];
    const commits = entries.flatMap((c) =>
      c === null
        ? []
        : [
            {
              sha: c.sha.slice(0, 7),
              fullSha: c.sha,
              msg: (c.commit?.message ?? "").split("\n", 1)[0] ?? "",
              parents: (c.parents ?? []).flatMap((p) => (p ? [p.sha] : [])),
            },
          ],
    );
    const droppedCommits = entries.length - commits.length;
    if (droppedCommits > 0) {
      // The diagnostic half of the tolerant read: the surviving commits are
      // still returned, and the count says the list is short.
      logger.warn("compare payload dropped undecodable commit entries", {
        repo,
        base,
        head,
        kept: commits.length,
        dropped: droppedCommits,
      });
    }
    return {
      status: "ok",
      compare: {
        aheadBy: result.data.ahead_by ?? 0,
        behindBy: result.data.behind_by ?? 0,
        status: result.data.status ?? "identical",
        commits,
        droppedCommits,
      },
    };
  }
  if (result.kind === "network") {
    return { status: "network_unavailable", message: result.message };
  }
  if (result.kind === "http" && result.status === 404) {
    return { status: "missing_ref" };
  }
  if (result.kind === "http" && result.status === 401) {
    return { status: "auth_failed", message: result.message };
  }
  if (result.kind === "http" && result.status === 403) {
    // Rate-limit 403 vs scope 403 (DG-3): GitHub zeroes x-ratelimit-remaining on
    // a primary limit, and secondary limits carry a "rate limit" message.
    const isRateLimited =
      result.rateLimit.remaining === 0 ||
      /rate limit/i.test(result.message);
    if (isRateLimited) {
      return { status: "rate_limited", message: result.message };
    }
    return { status: "forbidden", message: result.message };
  }
  // Residual — including a payload that did not decode, which names itself
  // rather than degrading to "unknown".
  return {
    status: "network_unavailable",
    message:
      result.kind === "http"
        ? `GitHub ${result.status}`
        : githubFailureMessage(result),
  };
}

/**
 * Commit association: branch commits carrying the `[VIB-n]` task-key
 * prefix convention.
 */
export function taskCommits(
  commits: readonly { sha: string; msg: string }[],
  taskKey: string,
): { sha: string; msg: string }[] {
  const prefix = `[${taskKey.toLowerCase()}]`;
  // Ruling 132: the `{sha, msg}` projection lives HERE, so `github.commits`
  // keeps its shape while the compare itself carries `fullSha` and `parents`.
  return commits
    .filter((c) => c.msg.toLowerCase().startsWith(prefix))
    .map((c) => ({ sha: c.sha, msg: c.msg }));
}

/** Sync pill derivation (ruling 12): merged > behind > synced. */
export type BranchSyncState = "merged" | "behind_main" | "synced";

export function deriveSyncState(input: {
  prMerged: boolean;
  behindBy: number;
}): BranchSyncState {
  if (input.prMerged) return "merged";
  if (input.behindBy > 0) return "behind_main";
  return "synced";
}

// -------------------------------------------------------- ensure branch

/**
 * The delivery spine's pre-dispatch hook (FR31), shared by the operator's
 * dispatch and a human's: make sure the task owns a branch name before anyone
 * is told what to check out. Non-fatal by design — a task that cannot reach
 * GitHub still runs, and delivery re-checks the name.
 */
export type BranchPrepareResult =
  | EnsureBranchResult
  /** `ensureTaskBranch` threw: something no typed arm anticipated. */
  | { status: "threw"; message: string };

/** Repeats of the SAME prepare failure within this window write no second
 *  line (the operator's hook runs on every delivering dispatch, and JC-1 took
 *  three attempts in four minutes); the log still says every attempt. */
const PREPARE_FAILURE_REPEAT_MS = 60 * 60 * 1000;

/**
 * F34-3 (pass 34): the pre-dispatch hook used to be `try { … } catch {}`
 * returning void, so every typed non-`synced` result was discarded, a throw was
 * swallowed, and no surface said the repository could not take a task branch
 * (live, JC-1's allocation failed on the missing base and nothing said so).
 * The result is now returned, and the failures a person can act on are
 * disclosed ONCE on the timeline, audited, and logged: `auth_failed`,
 * `network_unavailable`, `bootstrap_failed`, `threw`. `synced` and
 * `scope_violation` write nothing new (the flag already wrote the event, the
 * notification and the audit row); `no_pat_configured`, `no_repo_configured`
 * and `task_not_found` are standing project states and only log. Never throws:
 * coordination proceeds without a branch when GitHub is absent.
 */
export async function ensureTaskBranchBestEffort(
  db: DatabaseSync,
  input: { projectSlug: string; taskKey: string },
  actor: AuditActor,
  ctx: EnsureBranchContext = {},
): Promise<BranchPrepareResult> {
  let result: BranchPrepareResult;
  try {
    result = await ensureTaskBranch(db, input, actor, ctx);
  } catch (error) {
    result = {
      status: "threw",
      message: errorMessage(error),
    };
  }
  try {
    await disclosePrepareFailure(db, input, result, ctx);
  } catch (error) {
    logger.warn("branch preparation failure could not be disclosed", {
      taskKey: input.taskKey,
      err: toError(error),
    });
  }
  return result;
}

/** The half of the disclosure that depends on the failure kind. */
function prepareFailureDetail(result: BranchPrepareResult): string | null {
  switch (result.status) {
    case "auth_failed":
      return `GitHub rejected the project credential (${result.message})`;
    case "network_unavailable":
      return `GitHub was unreachable (${result.message})`;
    case "bootstrap_failed":
      return `the repository has no \`${result.defaultBranch}\` branch and Viberr could not create it (${result.reason})`;
    case "threw":
      return `the branch preparation failed unexpectedly (${result.message})`;
    default:
      return null;
  }
}

async function disclosePrepareFailure(
  db: DatabaseSync,
  input: { projectSlug: string; taskKey: string },
  result: BranchPrepareResult,
  ctx: EnsureBranchContext,
): Promise<void> {
  if (result.status === "synced" || result.status === "scope_violation") return;
  const detail = prepareFailureDetail(result);
  if (detail === null) {
    logger.info("branch preparation skipped: standing project state", {
      taskKey: input.taskKey,
      status: result.status,
    });
    return;
  }
  const taskRef = { projectSlug: input.projectSlug, taskKey: input.taskKey, dataRoot: ctx.dataRoot };
  const file = readTaskFile(taskRef);
  const branch = file?.parsed.frontmatter.branch ?? null;
  const text = branch
    ? `Branch \`${branch}\` could not be confirmed on GitHub before dispatch: ${detail}. The run proceeds in the workspace; delivery retries the branch.`
    : `No task branch could be allocated on GitHub before dispatch: ${detail}. The run proceeds in the workspace; delivery retries the branch.`;
  logger.warn("branch preparation failed before dispatch", {
    taskKey: input.taskKey,
    status: result.status,
    branch,
  });
  if (!file) return;
  // Deduped: the same status for the same branch within the repeat window
  // writes no second line and no second audit row.
  const newest = file.parsed.timeline.find((e) => e.type === "github");
  if (
    newest &&
    newest.text === text &&
    Date.now() - Date.parse(newest.occurredAt) < PREPARE_FAILURE_REPEAT_MS
  ) {
    return;
  }
  await appendTimelineEvent(taskRef, {
    occurredAt: new Date().toISOString(),
    type: "github",
    actor: { kind: "system", systemId: "delivery" },
    title: null,
    text,
    toAgent: false,
    evidence: null,
  });
  rebuildPath(db, resolveTaskFilePath(taskRef), { dataRoot: ctx.dataRoot });
  recordAudit(db, {
    action: "github.branch.prepare_failed",
    actor: { userId: null, label: "system:delivery" },
    subjectKind: "task",
    subjectId: input.taskKey,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: { branch, status: result.status, detail },
  });
}

export type EnsureBranchResult =
  | {
      status: "synced";
      branch: string;
      /** True when this call created the ref on GitHub. */
      created: boolean;
      /** Compare vs the default branch (null when the compare failed). */
      compare: BranchCompare | null;
    }
  | GithubContextFailure
  | { status: "task_not_found" }
  /** Ruling 128: the default branch had no ref and Viberr could not create
   *  it. A positive "no base" — the delivery gate refuses to push on it. */
  | { status: "bootstrap_failed"; defaultBranch: string; reason: string }
  | { status: "scope_violation"; scope: string; violationId: string }
  | { status: "auth_failed"; message: string }
  | { status: "network_unavailable"; message: string };

export interface EnsureBranchContext {
  dataRoot?: string;
  fetchImpl?: typeof fetch;
}

/**
 * `GET git/ref` — read only where the base head is resolved, and that sha
 * feeds straight into the ref-create call, so it stays strict: an answer
 * without `object.sha` must fail loudly, never create a branch from nothing.
 */
const ghRefSchema = z.object({ object: z.object({ sha: z.string() }) });

/**
 * Creates (or confirms) the task-key branch from the project default
 * branch, writes the branch name into task.md when it was absent, and
 * returns fresh compare data. Every failure mode is a typed result; a 403
 * creating the ref opens a `repo` scope violation carried by the task.
 */
export async function ensureTaskBranch(
  db: DatabaseSync,
  input: { projectSlug: string; taskKey: string },
  actor: AuditActor,
  ctx: EnsureBranchContext = {},
): Promise<EnsureBranchResult> {
  const taskRef = {
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    dataRoot: ctx.dataRoot,
  };
  const file = readTaskFile(taskRef);
  if (!file) return { status: "task_not_found" };

  // P13-D-5: passed `repoOverride: file.parsed.frontmatter.repo` until the
  // task-level repo override was deleted (owner ruling) — project repo only.
  // `fetchImpl` is an OPTIONAL key: the context reads it with a truthiness
  // check, so the hook is set only when a caller supplied one.
  const ghOptions: GithubContextOptions = {};
  if (ctx.fetchImpl) ghOptions.fetchImpl = ctx.fetchImpl;
  const gh = getProjectGithubContext(db, input.projectSlug, ghOptions);
  if (gh.status !== "ok") return gh;

  // Ruling 122: a task that has never had a branch gets one ALLOCATED here —
  // the canonical key when it is free, `<key>-<4 hex>` when a ref or any past
  // pull request already speaks for that name. A task that already carries a
  // `branch:` keeps it verbatim, so nothing in flight is renamed.
  const recorded = file.parsed.frontmatter.branch;
  const canonical = taskBranchName(input.taskKey);
  let branch = recorded ?? canonical;
  // U36-6 (pass 36): a suffixed allocation is DISCLOSED — on the audit row and
  // as a policy note — instead of being a name nobody can explain (live,
  // `hlc-10-0c88` appeared with nothing saying `hlc-10` was taken).
  let suffixed = false;
  if (!recorded) {
    const allocated = await allocateTaskBranchName(
      gh.client,
      gh.repo,
      input.taskKey,
    );
    if (allocated.status === "forbidden") {
      const { violation } = await flagScopeViolation(
        db,
        {
          projectSlug: input.projectSlug,
          taskKey: input.taskKey,
          scope: "repo",
          detail: policyViolationText("repo", allocated.what),
          actor,
        },
        { dataRoot: ctx.dataRoot },
      );
      return {
        status: "scope_violation",
        scope: "repo",
        violationId: violation.id,
      };
    }
    if (allocated.status !== "ok") return allocated;
    branch = allocated.branch;
    suffixed = allocated.suffixed;
  }

  // 1. Does the ref already exist? (idempotency first)
  const existing = await gh.client.request(
    "GET",
    `/repos/${gh.repo}/git/ref/${encodeRefPath(`heads/${branch}`)}`,
    z.unknown(),
  );
  let created = false;
  if (!existing.ok) {
    if (existing.kind === "network") {
      return { status: "network_unavailable", message: existing.message };
    }
    if (existing.kind === "http" && existing.status === 401) {
      return { status: "auth_failed", message: existing.message };
    }
    if (isMissingRefAnswer(existing)) {
      // 2. Resolve the default branch head… Ruling 128: when it has no ref
      //    (an empty repository, or one whose only refs are task branches),
      //    Viberr creates it FIRST, so a task branch is never the repository's
      //    first ref. Only a positive "could not create it" refuses; a probe
      //    that could not be read degrades exactly as before.
      let baseRef = await gh.client.request(
        "GET",
        `/repos/${gh.repo}/git/ref/${encodeRefPath(`heads/${gh.defaultBranch}`)}`,
        ghRefSchema,
      );
      if (!baseRef.ok && isMissingRefAnswer(baseRef)) {
        const bootstrap = await ensureDefaultBranch(
          db,
          gh,
          { projectSlug: input.projectSlug, taskKey: input.taskKey },
          actor,
          { dataRoot: ctx.dataRoot },
        );
        if (bootstrap.status === "bootstrap_failed") return bootstrap;
        if (bootstrap.status === "scope_violation") return bootstrap;
        if (bootstrap.status === "auth_failed") return bootstrap;
        if (bootstrap.status === "network_unavailable") return bootstrap;
        baseRef = await gh.client.request(
          "GET",
          `/repos/${gh.repo}/git/ref/${encodeRefPath(`heads/${gh.defaultBranch}`)}`,
          ghRefSchema,
        );
      }
      if (!baseRef.ok) {
        if (isMissingRefAnswer(baseRef)) {
          return {
            status: "bootstrap_failed",
            defaultBranch: gh.defaultBranch,
            reason: `\`${gh.defaultBranch}\` still has no ref after the bootstrap`,
          };
        }
        if (baseRef.kind === "network") {
          return { status: "network_unavailable", message: baseRef.message };
        }
        return {
          status: "network_unavailable",
          // Includes the strict-schema `decode` failure: a ref answer without
          // `object.sha` never creates a branch from nothing, and now says so
          // as a value instead of throwing out of the call.
          message: githubFailureMessage(baseRef),
        };
      }
      // 3. …and create the branch ref from it.
      const createRef = await gh.client.request(
        "POST",
        `/repos/${gh.repo}/git/refs`,
        z.unknown(),
        { body: { ref: `refs/heads/${branch}`, sha: baseRef.data.object.sha } },
      );
      if (createRef.ok) {
        created = true;
      } else if (
        createRef.kind === "http" &&
        createRef.status === 422 &&
        /already exists/i.test(createRef.message)
      ) {
        created = false; // concurrent creation — idempotent success
      } else if (createRef.kind === "http" && createRef.status === 403) {
        const { violation } = await flagScopeViolation(
          db,
          {
            projectSlug: input.projectSlug,
            taskKey: input.taskKey,
            scope: "repo",
            detail: policyViolationText(
              "repo",
              `Creating branch \`${branch}\` was refused.`,
            ),
            actor,
          },
          { dataRoot: ctx.dataRoot },
        );
        return {
          status: "scope_violation",
          scope: "repo",
          violationId: violation.id,
        };
      } else if (createRef.kind === "network") {
        return { status: "network_unavailable", message: createRef.message };
      } else {
        return {
          status: "network_unavailable",
          message: githubFailureMessage(createRef),
        };
      }
    } else if (existing.kind === "http" && existing.status === 403) {
      const { violation } = await flagScopeViolation(
        db,
        {
          projectSlug: input.projectSlug,
          taskKey: input.taskKey,
          scope: "repo",
          detail: policyViolationText(
            "repo",
            `Reading branch \`${branch}\` was refused.`,
          ),
          actor,
        },
        { dataRoot: ctx.dataRoot },
      );
      return {
        status: "scope_violation",
        scope: "repo",
        violationId: violation.id,
      };
    } else {
      return {
        status: "network_unavailable",
        message: githubFailureMessage(existing),
      };
    }
  }

  // Persist the branch name into task.md when it wasn't recorded yet
  // (file write → reproject; canonical truth stays in the file).
  if (file.parsed.frontmatter.branch !== branch) {
    if (suffixed) {
      // The note and the `branch:` write land in ONE file write, so a reader
      // never sees the suffixed name without the sentence that explains it.
      await appendTimelineEvent(
        taskRef,
        {
          occurredAt: new Date().toISOString(),
          type: "note",
          actor: { kind: "system", systemId: "policy-engine" },
          title: null,
          text: `Branch \`${branch}\` allocated: \`${canonical}\` is already spoken for on GitHub (a ref or a past pull request), ruling 122.`,
          toAgent: false,
          evidence: null,
        },
        { branch },
      );
    } else {
      await patchTaskFrontmatter(taskRef, { branch });
    }
    rebuildPath(db, resolveTaskFilePath(taskRef), {
      dataRoot: ctx.dataRoot,
    });
  }

  if (created) {
    recordAudit(db, {
      action: "github.branch.created",
      actor,
      subjectKind: "branch",
      subjectId: branch,
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      details: { repo: gh.repo, from: gh.defaultBranch, canonical, branch, suffixed },
    });
  }

  const compareResult = await getBranchCompare(
    gh.client,
    gh.repo,
    gh.defaultBranch,
    branch,
  );
  return {
    status: "synced",
    branch,
    created,
    compare: compareResult.status === "ok" ? compareResult.compare : null,
  };
}
