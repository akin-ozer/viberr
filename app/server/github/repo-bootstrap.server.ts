import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { recordAudit, type AuditActor } from "~/server/audit/audit-recorder.server";
import {
  appendTimelineEvent,
  readTaskFile,
  resolveTaskFilePath,
} from "~/server/files/task-writer.server";
import { rebuildPath } from "~/server/projections/rebuilder.server";
import { logger } from "~/server/logging/logger.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import { markWriteScopeProven } from "~/server/secrets/pat-store.server";
import {
  githubFailureMessage,
  isMissingRefAnswer,
  type GithubResponse,
  encodeRefPath,
} from "./github-client.server";
import type { GithubContext } from "./github-context.server";
import { flagScopeViolation, policyViolationText } from "./scope-flag.server";

/**
 * Ruling 128 (pass 34, Q34-2 / F34-4): Viberr bootstraps the default branch
 * of an empty repository itself, BEFORE a task's first branch.
 *
 * Live (JC-1 on an empty `akin-ozer/jira-clone`): the pre-dispatch branch hook
 * found no `main` and said nothing; the delivery push created `jc-1` as the
 * repository's FIRST ref, GitHub made it the default branch, `POST /pulls`
 * failed 422 `base: invalid`, and every surface said "GitHub was unreachable
 * (network error). Fix the repository/credential settings". Nothing in the
 * product could create `main`.
 *
 * Two shapes, both disclosed on the task timeline and audited as
 * `github.repo.bootstrapped`:
 *   - a repository with NO refs at all: author an initial commit
 *     (`README.md` naming the project) through the Contents API, which GitHub
 *     accepts on an empty repository where the Git Data ref/commit endpoints
 *     answer 409, on the configured default branch;
 *   - a repository whose only refs are task branches pushed before this
 *     ruling: create the default branch at the FIRST commit of GitHub's current
 *     default branch and restore the configured name as the repository default
 *     (the repair the owner approved live, Q34-3).
 *
 * GitHub answers, recorded for the fakes (see the live-validation step in
 * TESTPLAN V2; update these lines from the observed answers before merge):
 *   GET  /repos/{r}/git/ref/heads/main   → 404 `Not Found` when the ref is
 *        missing on a non-empty repository; 409 `Git Repository is empty.` on a
 *        repository with no refs at all — both are "no ref", never a network
 *        failure (`isMissingRefAnswer`).
 *   GET  /repos/{r}/branches?per_page=1  → `[]` on an empty repository.
 *   PUT  /repos/{r}/contents/README.md   → 201 `{ commit: { sha } }`, and the
 *        `branch` field names the branch the commit lands on (created if absent).
 *   GET  /repos/{r}/git/commits/{sha}    → `{ message, parents }`; read only when
 *        the PUT's answer said nothing (a 5xx, a dropped connection), to tell
 *        Viberr's own first commit (no parents, its message) from another's.
 *   GET  /repos/{r}/commits?sha=<b>      → newest first, paginated by `Link`.
 *   POST /repos/{r}/git/refs             → 201, or 422 "Reference already
 *        exists", which is success here.
 *   PATCH /repos/{r} { default_branch }  → 200 (a refusal is disclosed, not fatal).
 */

export type EnsureDefaultBranchResult =
  | { status: "exists"; defaultBranch: string }
  | {
      status: "bootstrapped";
      defaultBranch: string;
      how: "initial_commit" | "ref_from_branch_root";
      sha: string;
      /** `ref_from_branch_root`: the branch whose root commit became the base. */
      from?: string;
      /** `ref_from_branch_root`: whether the repository default was restored. */
      defaultRestored?: boolean;
    }
  | { status: "scope_violation"; scope: string; violationId: string }
  | { status: "auth_failed"; message: string }
  | { status: "network_unavailable"; message: string }
  | { status: "bootstrap_failed"; defaultBranch: string; reason: string };

export interface EnsureDefaultBranchContext {
  dataRoot?: string;
  /** Ruling 468: what waited on the base, for the timeline line. Omitted,
   *  the task's branch (ruling 128's first caller). */
  before?: "task-branch" | "operator-checkout";
}

const ghRefSchema = z.object({ object: z.object({ sha: z.string() }) });
const ghBranchesSchema = z.array(z.unknown());
const ghRepoSchema = z.object({ default_branch: z.string().nullable().optional() }).loose();
const ghContentsSchema = z.object({ commit: z.object({ sha: z.string() }) }).loose();
const ghCommitsSchema = z.array(z.object({ sha: z.string() }).loose());

const ghGitCommitSchema = z
  .object({ message: z.string(), parents: z.array(z.unknown()) })
  .loose();

/** Whether `sha` is a first commit carrying `message`, the one this module's
 *  Contents write makes. Any failure to read it is "not shown". */
async function isInitialCommit(gh: GithubContext, sha: string, message: string): Promise<boolean> {
  const commit = await gh.client.request(
    "GET",
    `/repos/${gh.repo}/git/commits/${encodeURIComponent(sha)}`,
    ghGitCommitSchema,
  );
  return commit.ok && commit.data.parents.length === 0 && commit.data.message.trim() === message;
}

/** Page through `branch`'s commits, 100 a page and at most 10 pages, and return
 *  its OLDEST commit sha, or the failure when GitHub could not be read. */
async function rootCommitOf(
  gh: GithubContext,
  branch: string,
): Promise<{ sha: string } | { failure: GithubResponse<unknown> }> {
  let page = 1;
  let oldest: string | null = null;
  for (; page <= 10; page += 1) {
    const result = await gh.client.request("GET", `/repos/${gh.repo}/commits`, ghCommitsSchema, {
      searchParams: { sha: branch, per_page: 100, page },
    });
    if (!result.ok) return { failure: result };
    const last = result.data[result.data.length - 1];
    if (!last) break;
    oldest = last.sha;
    if (result.data.length < 100) break;
  }
  return oldest ? { sha: oldest } : { failure: { ok: false, kind: "network", message: "no commits" } };
}

/**
 * Ruling 128 splits by EVIDENCE, not by failure: only a positive "there is no
 * default ref and Viberr could not create it" refuses the push. A READ that did
 * not answer proves nothing about the repository's state, so it degrades to
 * `network_unavailable` — the status the pre-push gate lets through — and never
 * tells a person their repository has no default branch.
 *
 * Pass 34 review: a READ used to send every non-network, non-401 failure to
 * `bootstrap_failed`, so a GitHub 500 on `GET /git/ref/heads/main` refused the
 * delivery of a task whose `main` was healthy and sent the person to create a
 * branch that already existed. A 5xx, a 429 and a body the schema refuses are
 * all unread probes. A CREATE is the other half of the split: a PUT or PATCH
 * that failed means the base does not exist and could not be made, whatever
 * the status, so it keeps refusing the push.
 */
function failureOf(
  result: GithubResponse<unknown>,
  defaultBranch: string,
  what: string,
  evidence: "read" | "create",
): EnsureDefaultBranchResult {
  if (!result.ok && result.kind === "network") {
    return { status: "network_unavailable", message: result.message };
  }
  if (!result.ok && result.kind === "http" && result.status === 401) {
    return { status: "auth_failed", message: result.message };
  }
  const unread =
    !result.ok &&
    (result.kind === "decode" ||
      (result.kind === "http" && (result.status >= 500 || result.status === 429)));
  if (evidence === "read" && unread) {
    return { status: "network_unavailable", message: githubFailureMessage(result) };
  }
  return {
    status: "bootstrap_failed",
    defaultBranch,
    reason: `${what}: ${result.ok ? "unexpected success" : githubFailureMessage(result)}`,
  };
}

/**
 * Make sure `gh.defaultBranch` has a ref, creating it when the repository has
 * none. Idempotent: an existing ref writes nothing. With a task key, a
 * bootstrap is disclosed on that task's timeline; without one (a project-level
 * caller) only the audit row is written.
 */
export async function ensureDefaultBranch(
  db: DatabaseSync,
  gh: GithubContext,
  scope: { projectSlug: string; taskKey?: string | null },
  actor: AuditActor,
  ctx: EnsureDefaultBranchContext = {},
): Promise<EnsureDefaultBranchResult> {
  const base = gh.defaultBranch;
  const refPath = `/repos/${gh.repo}/git/ref/${encodeRefPath(`heads/${base}`)}`;
  const ref = await gh.client.request("GET", refPath, ghRefSchema);
  if (ref.ok) return { status: "exists", defaultBranch: base };
  if (!isMissingRefAnswer(ref)) {
    if (ref.kind === "http" && ref.status === 403) {
      return await violation(db, scope, actor, ctx, `Reading branch \`${base}\` was refused.`);
    }
    return failureOf(ref, base, `reading branch \`${base}\``, "read");
  }

  // No ref. Empty repository, or a repository whose refs are task branches?
  const branches = await gh.client.request("GET", `/repos/${gh.repo}/branches`, ghBranchesSchema, {
    searchParams: { per_page: 1 },
  });
  // Pass 34 review: an EMPTY repository answers this read with the same
  // 409 `Git Repository is empty.` the ref read gets — the answer this module
  // exists to act on. Reading it as a failure would refuse the very bootstrap
  // it is the evidence for, so it counts as ZERO branches.
  let branchCount: number;
  if (branches.ok) {
    branchCount = branches.data.length;
  } else if (branches.kind === "http" && branches.status === 403) {
    return await violation(db, scope, actor, ctx, "Listing branches was refused.");
  } else if (isMissingRefAnswer(branches)) {
    branchCount = 0;
  } else {
    return failureOf(branches, base, "listing branches", "read");
  }

  let outcome: Extract<EnsureDefaultBranchResult, { status: "bootstrapped" }>;
  if (branchCount === 0) {
    const projectName =
      readProjectFile({ projectSlug: scope.projectSlug, dataRoot: ctx.dataRoot })?.parsed
        .frontmatter.name ?? scope.projectSlug;
    const content = Buffer.from(`# ${projectName}\n\nInitialized by Viberr.\n`, "utf8").toString(
      "base64",
    );
    const message = `Initialize ${projectName}`;
    // Sent once: the client's 5xx retry would meet the file this PUT had
    // already made ("sha wasn't supplied"), and the race arm below would then
    // file Viberr's own first commit as another call's (R-repo-1).
    const put = await gh.client.request(
      "PUT",
      `/repos/${gh.repo}/contents/README.md`,
      ghContentsSchema,
      {
        body: {
          message,
          content,
          branch: base,
        },
        retryServerError: false,
      },
    );
    let sha: string;
    if (put.ok) {
      // Re-probe: the ref must exist now, or the bootstrap did not take.
      const again = await gh.client.request("GET", refPath, ghRefSchema);
      if (!again.ok) {
        // The commit landed; this is the confirming READ. A 5xx here proves
        // nothing about the ref, so it degrades rather than claiming the
        // bootstrap did not take.
        return failureOf(again, base, `confirming branch \`${base}\` after the initial commit`, "read");
      }
      sha = put.data.commit.sha;
    } else {
      if (put.kind === "http" && put.status === 403) {
        return await violation(
          db,
          scope,
          actor,
          ctx,
          `Creating the initial commit on \`${base}\` was refused.`,
        );
      }
      // Ruling 468: idempotent under a race. Two paths now bootstrap (the
      // branch preparation and the operator's first checkout), and a second
      // PUT that lost to the first is refused by GitHub (the file exists, or
      // the branch moved). The branch existing is the outcome both wanted,
      // so a refused create that finds it answers `exists` and writes nothing.
      const raced = await gh.client.request("GET", refPath, ghRefSchema);
      if (!raced.ok) {
        return failureOf(put, base, `creating the initial commit on \`${base}\``, "create");
      }
      // A 5xx, a dropped connection or an undecodable 2xx did not say whether
      // THIS write landed. The branch's head being a root commit with this
      // write's message is Viberr's first commit, recorded as one.
      const unanswered =
        put.kind === "network" || put.kind === "decode" || (put.kind === "http" && put.status >= 500);
      const head = raced.data.object.sha;
      if (!unanswered || !(await isInitialCommit(gh, head, message))) {
        return { status: "exists", defaultBranch: base };
      }
      sha = head;
    }
    outcome = { status: "bootstrapped", defaultBranch: base, how: "initial_commit", sha };
  } else {
    const repoInfo = await gh.client.request("GET", `/repos/${gh.repo}`, ghRepoSchema);
    if (!repoInfo.ok) return failureOf(repoInfo, base, "reading the repository", "read");
    const from = repoInfo.data.default_branch;
    if (!from) {
      return {
        status: "bootstrap_failed",
        defaultBranch: base,
        reason: `GitHub reports no default branch for \`${gh.repo}\` although it has refs.`,
      };
    }
    const root = await rootCommitOf(gh, from);
    // Walking history is a READ of the repository's commits.
    if ("failure" in root) return failureOf(root.failure, base, `walking \`${from}\`'s history`, "read");
    const create = await gh.client.request("POST", `/repos/${gh.repo}/git/refs`, z.unknown(), {
      body: { ref: `refs/heads/${base}`, sha: root.sha },
    });
    const alreadyExists =
      !create.ok && create.kind === "http" && create.status === 422 && /already exists/i.test(create.message);
    if (!create.ok && !alreadyExists) {
      if (create.kind === "http" && create.status === 403) {
        return await violation(db, scope, actor, ctx, `Creating branch \`${base}\` was refused.`);
      }
      return failureOf(create, base, `creating branch \`${base}\``, "create");
    }
    const patch = await gh.client.request("PATCH", `/repos/${gh.repo}`, z.unknown(), {
      body: { default_branch: base },
    });
    if (!patch.ok) {
      logger.warn("could not restore the repository default branch after bootstrapping it", {
        repo: gh.repo,
        defaultBranch: base,
        message: patch.ok ? "" : githubFailureMessage(patch),
      });
    }
    outcome = {
      status: "bootstrapped",
      defaultBranch: base,
      how: "ref_from_branch_root",
      sha: root.sha,
      from,
      defaultRestored: patch.ok,
    };
  }

  const details =
    outcome.how === "ref_from_branch_root"
      ? {
          repo: gh.repo,
          defaultBranch: base,
          how: outcome.how,
          sha: outcome.sha,
          from: outcome.from ?? "",
          defaultRestored: outcome.defaultRestored ?? false,
        }
      : { repo: gh.repo, defaultBranch: base, how: outcome.how, sha: outcome.sha };
  const audit: Parameters<typeof recordAudit>[1] = {
    action: "github.repo.bootstrapped",
    actor,
    subjectKind: "repository",
    subjectId: gh.repo,
    projectSlug: scope.projectSlug,
    details,
  };
  if (scope.taskKey) audit.taskKey = scope.taskKey;
  recordAudit(db, audit);
  // Ruling 480: the commit or the ref just made is a write through this token,
  // so it proves `repo` on this repository.
  markWriteScopeProven(
    db,
    gh.patId,
    gh.repo,
    outcome.how === "initial_commit" ? "initial_commit" : "branch",
  );
  if (scope.taskKey) {
    const ref = { projectSlug: scope.projectSlug, taskKey: scope.taskKey, dataRoot: ctx.dataRoot };
    if (readTaskFile(ref)) {
      await appendTimelineEvent(ref, {
        occurredAt: new Date().toISOString(),
        type: "github",
        actor: { kind: "system", systemId: "delivery" },
        title: null,
        text:
          outcome.how === "initial_commit"
            ? `Bootstrapped the repository: \`${gh.repo}\` had no branches, so Viberr created **${base}** with an initial commit \`${outcome.sha.slice(0, 7)}\` (a README naming the project) ${
                ctx.before === "operator-checkout"
                  ? "before the operator's first checkout of it, so nobody has to push one"
                  : "before cutting this task's branch"
              }.`
            : `Bootstrapped the repository: \`${gh.repo}\` had no **${base}** (GitHub had made \`${outcome.from}\` the default), so Viberr created **${base}** at that branch's first commit \`${outcome.sha.slice(0, 7)}\`${
                outcome.defaultRestored
                  ? ` and restored it as the repository default.`
                  : `; restoring it as the repository default was refused, so set it by hand on GitHub.`
              }`,
        toAgent: false,
        evidence: null,
      });
      rebuildPath(db, resolveTaskFilePath(ref), { dataRoot: ctx.dataRoot });
    }
  }
  return outcome;
}

async function violation(
  db: DatabaseSync,
  scope: { projectSlug: string; taskKey?: string | null },
  actor: AuditActor,
  ctx: EnsureDefaultBranchContext,
  what: string,
): Promise<EnsureDefaultBranchResult> {
  const { violation } = await flagScopeViolation(
    db,
    {
      projectSlug: scope.projectSlug,
      taskKey: scope.taskKey ?? null,
      scope: "repo",
      detail: policyViolationText("repo", what),
      actor,
    },
    { dataRoot: ctx.dataRoot },
  );
  return { status: "scope_violation", scope: "repo", violationId: violation.id };
}
