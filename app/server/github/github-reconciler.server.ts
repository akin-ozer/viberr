import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type {
  GithubCache,
  PrMergeable,
  PrRef,
  TaskFrontmatter,
} from "~/schemas/task-file.schema";
import {
  recordAudit,
  type AuditActor,
} from "~/server/audit/audit-recorder.server";
import {
  appendTimelineEvent,
  patchTaskFrontmatter,
  readTaskFile,
  resolveTaskFilePath,
  updateTaskFile,
} from "~/server/files/task-writer.server";
import { storeRelativePath } from "~/server/files/file-store-root.server";
import {
  readProjectFile,
  type ProjectFileRef,
} from "~/server/files/project-writer.server";
import {
  findOpenScopeViolation,
} from "~/server/projections/policy-violations.server";
import { rebuildPath } from "~/server/projections/rebuilder.server";
import {
  deriveSyncState,
  getBranchCompare,
  taskCommits,
  type BranchCompare,
  type BranchSyncState,
} from "./branch-sync.server";
import { encodeRefPath, GITHUB_API_BASE, isMissingRefAnswer } from "./github-client.server";

/** Ruling 135: the one field the never-pushed probe reads. */
const commitShaSchema = z.object({ sha: z.string() }).loose();
import {
  getProjectGithubContext,
  type GithubContextFailure,
  type GithubContextOptions,
} from "./github-context.server";
import { branchCleanupOnMerge } from "./branch-cleanup.server";
import { decidePrAdoption, prAdoptionRefusalNote } from "./pr-adoption.server";
import { deriveMergeable, findPrForBranch, type PrFacts } from "./pr-linker.server";
import {
  derivePrHumanApproval,
  readPrHumanApproval,
  PR_HUMAN_APPROVAL_KEY,
  type PrHumanApproval,
} from "./pr-human-approval.server";
import { getProject } from "~/server/projections/board-query.server";
import { logger } from "~/server/logging/logger.server";
import { isTerminalStage } from "~/shared/workflow/stage-roles";
import {
  POLICY_ENGINE_ACTOR,
  flagScopeViolation,
  policyViolationText,
  resolveScopeViolationWithEvent,
} from "./scope-flag.server";
import { markWriteScopeProven } from "~/server/secrets/pat-store.server";

/**
 * GitHub reconciler (Phase 7): given a task, fetches live GitHub facts
 * (branch compare, PR state, task-key commits, change stats), writes them
 * into the task.md `pr`/`github` frontmatter CACHE via the phase-3
 * frontmatter writers (files stay canonical, GitHub stays a projection —
 * format doc §"pr/github cache"), triggers incremental reprojection,
 * records provenance, and opens/resolves scope violations on 403-scope
 * failures (ruling 5 — violation rows carry their task).
 *
 * Plus mergeTaskPr — the real merge behind accept_completion (ruling 7):
 * PUT /pulls/{n}/merge with 405/409/403-scope mapped to typed results.
 * The VIB-142 scenario: a 403 opens (or reuses) the `pull_request:write`
 * violation and the caller renders the typed failure; the merge does NOT
 * transition the task — stage/readiness orchestration stays with the
 * accept_completion action (Phase 5 wiring).
 *
 * Everything returns typed results (degraded contract): no_pat_configured
 * / no_repo_configured / network_unavailable are values, not throws.
 */

/**
 * The operator wake a divergence fires: `autoInvokeOperator` narrowed to the one
 * trigger this module ever passes. Typed here rather than imported so the
 * task-actions dependency stays the runtime-only dynamic import it already is.
 */
export type OperatorWake = (
  db: DatabaseSync,
  ctx: { dataRoot?: string },
  projectSlug: string,
  taskKey: string,
  trigger: "pr-diverged",
) => Promise<void>;

export interface GithubActionContext {
  dataRoot?: string;
  /** Mock-transport hook for tests. */
  fetchImpl?: typeof fetch;
  /** The pr-diverged operator wake below; injection hook for tests, same shape
   *  as `fetchImpl`. Defaults to the real `autoInvokeOperator`. */
  wakeOperator?: OperatorWake;
  /** P11-14: the background poller reconciles every active project every 5 min;
   *  it suppresses the per-project summary audit (a human clicking "Update
   *  status" still audits) so poller ticks don't spam the audit log. The
   *  meaningful per-task divergence EVENTS/notifications still fire. */
  skipProjectAudit?: boolean;
  /** DG-3: a no-change reconcile records a provenance "observation" row — fine
   *  for a human-triggered reconcile, but the 5-min poller would grow provenance
   *  unboundedly with heartbeats. When set, poller ticks record provenance ONLY
   *  when the task cache actually changed. */
  skipUnchangedProvenance?: boolean;
  /** B-GH5: cap the tasks ONE `reconcileProject` pass may reconcile. The
   *  background poller sets it (the rest carry over to the next tick); a
   *  human-triggered "Update status" leaves it unset — someone is waiting for
   *  the whole board's truth, not a slice of it. */
  taskBudget?: number;
}

function taskRefOf(
  input: { projectSlug: string; taskKey: string },
  ctx: GithubActionContext,
) {
  return {
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    dataRoot: ctx.dataRoot,
  };
}

/** `fetchImpl` is an OPTIONAL key: the context reads it with a truthiness check,
 *  so the hook is set only when a caller supplied one. */
function githubOptionsOf(ctx: GithubActionContext): GithubContextOptions {
  const options: GithubContextOptions = {};
  if (ctx.fetchImpl) options.fetchImpl = ctx.fetchImpl;
  return options;
}

/**
 * What ONE GitHub observation row records. `details_json` is this object
 * JSON-serialized, so the interface is the whole contract a later reader gets:
 * each action fills the facts it actually observed and omits the rest.
 */
interface GithubProvenanceDetails {
  repo: string;
  branch?: string;
  changed?: boolean;
  sync?: BranchSyncState;
  aheadBy?: number | null;
  behindBy?: number | null;
  prNumber?: number | null;
  prState?: PrFacts["state"] | null;
  prReview?: PrRef["review"];
  prChecks?: PrRef["checks"];
  commits?: number | null;
  /** F21-8: compare entries GitHub sent that did not decode. Written only when
   *  non-zero, so a complete list leaves no key at all. */
  commitsDropped?: number;
  sha?: string | null;
  /** A pass over a project with no branched task at all (F15-02). */
  heartbeat?: boolean;
  tasks?: number;
}

interface GithubProvenanceRow {
  absPath: string;
  dataRoot?: string;
  action: string;
  details: GithubProvenanceDetails;
}

function recordGithubProvenance(
  db: DatabaseSync,
  input: GithubProvenanceRow,
): void {
  db.prepare(
    `INSERT INTO provenance (source_path, content_hash, observed_at, action, details_json)
     VALUES (?, NULL, ?, ?, ?)`,
  ).run(
    storeRelativePath(input.absPath, input.dataRoot),
    new Date().toISOString(),
    input.action,
    JSON.stringify(input.details),
  );
}

/** `users.name` is NOT NULL, so a row that fails this parse is a missing user —
 *  the id is then the honest display fallback. */
const userNameRow = z.object({ name: z.string() });

function userName(db: DatabaseSync, userId: string): string {
  const row = userNameRow.safeParse(
    db.prepare(`SELECT name FROM users WHERE id = ?`).get(userId),
  );
  return row.success ? row.data.name : userId;
}

// ------------------------------------------------------------- reconcile

export type TaskReconcileResult =
  | {
      status: "reconciled";
      taskKey: string;
      repo: string;
      branch: string;
      /** True when the task.md cache actually changed (and re-projected). */
      changed: boolean;
      sync: BranchSyncState;
      compare: { aheadBy: number; behindBy: number } | null;
      pr: PrFacts | null;
      /** Task-key-prefixed commits found on the branch. */
      commits: number;
    }
  | { status: "no_branch"; taskKey: string }
  | { status: "task_not_found"; taskKey: string }
  | GithubContextFailure
  | { status: "scope_violation"; taskKey: string; scope: string; violationId: string }
  | { status: "auth_failed"; message: string }
  | { status: "network_unavailable"; message: string }
  /**
   * F21-9 — this ONE task's pass threw. Every expected degradation above is a
   * value, so reaching here means something no reader anticipated (a payload
   * shape, a file, the db). It is a per-task FAILURE, not the pass's: the
   * sweep finishes the remaining tasks and the human's Reconcile button answers
   * with an honest count instead of a 500.
   */
  | { status: "task_error"; taskKey: string; message: string };

/** Notification sender for R8-6 GitHub divergence alerts (an `ActorRender`
 * system identity, matching the "Policy engine" timeline actor). */
const POLICY_ENGINE_NOTIFY_FROM = {
  kind: "system" as const,
  name: "Policy engine",
};

/**
 * F19-19: ONE reconcile pass per task at a time.
 *
 * `reconcileTask` reads task.md, then awaits two to four GitHub round trips
 * before it writes. Every out-of-band transition guard below —
 * `prJustMerged`, `prJustClosed`, `prJustReopened`, `acceptedClosedExternally`
 * — compares the LIVE PR against that PRE-AWAIT snapshot, and nothing
 * serialized two passes: the poller runs a boot pass plus a 5-minute interval,
 * `runReconcile` takes no lock, and the "Update status" button's disabled state
 * is per-fetcher, so two tabs (or a maintainer clicking during the boot pass)
 * race. Both passes then read `pr.state: review`, both learn GitHub says
 * merged, and one merge produces two divergence notes and two identical inbox
 * alerts for every supervisor — which is exactly the chatter NFR16 forbids.
 *
 * A QUEUE, not a coalescer. The second pass runs its own read AFTER the first
 * has written, so it sees the new `fm.pr` and correctly reports nothing new.
 * Coalescing would hand whoever pressed "Update status" the answer computed
 * before they pressed it — a freshness lie on the one surface whose entire job
 * is freshness.
 *
 * Not `runSingleFlight`: that is a synchronous per-key COOLDOWN whose stated
 * contract is "a skipped run is acceptable", and a reconcile dropped right
 * after a real merge is precisely the one that must not be skipped.
 *
 * In-process, matching the single-node deployment (the same scope as the
 * operator lease). Keyed per task, so `reconcileProject`'s fan-out is
 * unaffected: different tasks never wait on each other.
 */
const taskReconcileChain = new Map<string, Promise<void>>();

function withTaskReconcileLock<T>(
  key: string,
  work: () => Promise<T>,
): Promise<T> {
  // Whatever is in the map is a `tail` (below), which by construction NEVER
  // rejects — so waiting on it needs no rejection handler.
  const previous = taskReconcileChain.get(key) ?? Promise.resolve();
  const run = previous.then(work);
  // The failure is absorbed HERE, in the link the successor waits on. One
  // task's failed reconcile — the network drops mid-pass — must not strand
  // every later pass on that task, which is exactly what a rejected chain link
  // would do: the poller and the "Update status" button would both go quiet
  // forever, with nothing but an unhandled rejection to say why. The caller
  // still gets `run`, so the failure itself is never swallowed.
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  taskReconcileChain.set(key, tail);
  void tail.then(() => {
    // Only the CURRENT tail may clear the entry; a later pass that already
    // replaced it owns the key now.
    if (taskReconcileChain.get(key) === tail) taskReconcileChain.delete(key);
  });
  return run;
}

/**
 * R19-B — the project's member user ids, from the CANONICAL project file (the
 * same source `loadProjectContext` reads for every RBAC decision), so "a
 * project member approved it" can never be answered from a stale projection.
 * `db` is unused here on purpose: membership is file truth.
 */
function projectMemberIds(
  _db: DatabaseSync,
  projectSlug: string,
  dataRoot: string | undefined,
): ReadonlySet<string> {
  const file = readProjectFile({ projectSlug, dataRoot });
  if (!file) return new Set();
  return new Set(file.parsed.frontmatter.members.map((m) => m.userId));
}

/** Body of `reconcileTask` — only ever entered through the per-task lock. */
async function reconcileTaskUnlocked(
  db: DatabaseSync,
  input: { projectSlug: string; taskKey: string },
  actor: AuditActor,
  ctx: GithubActionContext = {},
): Promise<TaskReconcileResult> {
  const ref = taskRefOf(input, ctx);
  const file = readTaskFile(ref);
  if (!file) return { status: "task_not_found", taskKey: input.taskKey };
  const fm = file.parsed.frontmatter;
  if (!fm.branch) return { status: "no_branch", taskKey: input.taskKey };
  const branch = fm.branch;

  // P13-D-5: this passed `repoOverride: fm.repo` — the task-level repo override,
  // deleted by owner ruling this pass. One project, one repo.
  const gh = getProjectGithubContext(db, input.projectSlug, githubOptionsOf(ctx));
  if (gh.status !== "ok") return gh;

  // 1. Compare vs the default branch (sync pill + commit association).
  const compareResult = await getBranchCompare(
    gh.client,
    gh.repo,
    gh.defaultBranch,
    branch,
  );
  if (compareResult.status === "network_unavailable") {
    return { status: "network_unavailable", message: compareResult.message };
  }
  if (compareResult.status === "auth_failed") {
    return { status: "auth_failed", message: compareResult.message };
  }
  if (compareResult.status === "rate_limited") {
    // Transient — a rate-limit 403 is NOT a missing scope (DG-3). Skip this
    // task's reconcile without opening a bogus `repo` scope violation; the next
    // poll tick (or a manual Update status) retries once the window resets.
    return { status: "network_unavailable", message: compareResult.message };
  }
  if (compareResult.status === "forbidden") {
    const { violation } = await flagScopeViolation(
      db,
      {
        projectSlug: input.projectSlug,
        taskKey: input.taskKey,
        scope: "repo",
        detail: policyViolationText(
          "repo",
          `Reading branch \`${branch}\` was refused during reconcile.`,
        ),
        actor,
      },
      { dataRoot: ctx.dataRoot },
    );
    return {
      status: "scope_violation",
      taskKey: input.taskKey,
      scope: "repo",
      violationId: violation.id,
    };
  }
  const compare: BranchCompare | null =
    compareResult.status === "ok" ? compareResult.compare : null;

  // 2. PR lookup (state/draft/merged + checks + change stats).
  const prResult = await findPrForBranch(gh.client, gh.repo, branch);
  if (prResult.status === "network_unavailable") {
    return { status: "network_unavailable", message: prResult.message };
  }
  if (prResult.status === "auth_failed") {
    return { status: "auth_failed", message: prResult.message };
  }
  // A forbidden PR read degrades to "no PR facts" — reads are best-effort;
  // only WRITE failures open violations (an unproven read 403 could also
  // be repo visibility).
  const pr: PrFacts | null = prResult.status === "found" ? prResult.pr : null;

  // 3. Build the new frontmatter cache. A human-set "accepted" (merge-pending,
  // D3/S2) must NOT be downgraded to "review" just because the PR is still open
  // on GitHub — that would silently hide the "Complete merge" affordance. Keep
  // "accepted" until GitHub reports a real terminal state (merged/closed).
  const liveState =
    fm.pr?.state === "accepted" && pr && pr.state === "review"
      ? "accepted"
      : pr?.state;
  const prState = liveState ?? pr?.state;
  // P13-D-28: CI health and review state are now CONSUMED facts (checks fed one
  // API call per pass into nothing before this). Two rules keep them honest:
  //  1. a FAILED read is UNKNOWN, not "no checks" / "nobody reviewed" — carry
  //     the last-known value forward for the SAME PR rather than blanking a pill
  //     on a transient GitHub hiccup;
  //  2. a settled PR (merged/closed) drops `review` — "review required" frozen
  //     on a merged PR is a lie, and the linker deliberately stops paying for
  //     the reviews call once the PR is terminal.
  const cachedPr = pr && fm.pr?.number === pr.number ? fm.pr : null;
  const checks = pr ? (pr.checks ?? cachedPr?.checks ?? null) : null;
  const reviewLive = pr?.review !== undefined ? pr.review : (cachedPr?.review ?? null);
  const review = prState === "review" || prState === "accepted" ? reviewLive : null;
  // P14-LV-07: mergeability follows the SAME two rules as review state — an
  // unread value keeps the last-known one for the same PR, and a settled
  // (merged/closed) PR drops it, because "conflicting" frozen on a merged PR is
  // a lie. This is the fact that told the human the truth about VM-4's failed
  // merge instead of blaming their credentials.
  const mergeableLive =
    pr?.mergeable !== undefined ? pr.mergeable : (cachedPr?.mergeable ?? null);
  const mergeable =
    prState === "review" || prState === "accepted" ? mergeableLive : null;
  // R15-15 / R16-1 — OWNERSHIP. `findPrForBranch` matches on branch NAME alone,
  // and a task-key branch is not a unique identifier: task keys restart at 1 on
  // a new data root, so a brand-new VIB-1 gets branch `vib-1` — which on GitHub
  // may still carry the PR of a PREVIOUS VIB-1 that has nothing to do with it.
  //
  // Live: a fresh instance's VIB-1 adopted merged PR #109 from a wiped
  // instance, the divergence rule fired "PR #109 was merged but VIB-1 hasn't
  // been accepted", and the operator recommended moving a task to Review while
  // its developer was still writing code. The task's own delivered revision was
  // not in that PR and never had been.
  //
  // Two distinct jobs, so two rules:
  //  · KEEPING AN OWNED LINK HONEST — the discovery is the SAME number the task
  //    already references, so its live facts (state, checks, review) are this
  //    task's news whatever they say. R15-15 stopped at `fm.pr != null`, which
  //    let a name-matched STRANGER overwrite the owned link with its own number;
  //  · ADOPTING — a different (or first) PR may become this task's only under
  //    R16-1: open, and its head IS the delivered revision. That still covers the
  //    healing case below (a human closed our PR and opened a fresh one on the
  //    same branch) without letting a foreign merged PR in.
  const sameAsCached = pr != null && fm.pr?.number === pr.number;
  const adoption =
    pr != null && !sameAsCached
      ? decidePrAdoption({
          state: pr.state,
          prHeadSha: pr.headSha,
          revisionHeadSha: fm.workRevision?.headSha ?? null,
        })
      : null;
  const ownsAPr = sameAsCached || adoption?.adopt === true;
  const unownedPr = pr && !ownsAPr ? pr : null;
  // R17-1 (F17-L12): when this task's OWNED, live PR head is STRICTLY AHEAD of
  // the delivered/reviewed revision, record the drift so the accept/force
  // dialogs, the review-queue subline and the completion record can SURFACE the
  // commits that would ship unreviewed. Acceptance still merges an ahead head
  // (owner ruling R17-1 — keep "ahead"), but honestly. Only a PR whose head
  // actually differs from the reviewed revision needs the extra compare call; a
  // "diverged" head (delivered revision NOT an ancestor) is a REFUSAL handled by
  // `acceptancePrHeadMismatch`, so we record drift only for a clean "ahead".
  const reviewedSha = fm.workRevision?.headSha ?? null;
  // F21-17 (residual): drift is only MEASURABLE on a live PR — a settled one
  // gets no compare call, deliberately. But unlike `review` or `mergeable`, the
  // fact does not stop being TRUE when the PR settles: those extra commits were
  // on the head and the review never saw them, and a merged PR shipped them.
  // The PR-closed recovery packet is precisely where a human needs to read it,
  // so a pass that cannot measure carries the last measurement forward instead
  // of erasing it (see `owned.revisionDrift` below). While the PR IS measurable
  // the computed answer is authoritative — including "no drift", which is how a
  // re-delivery that catches the head up clears a stale record.
  const driftMeasurable = prState === "review" || prState === "accepted";
  let revisionDrift: PrRef["revisionDrift"] = null;
  // Ruling 135 (pass 34, F34-11): the MIRROR of drift. `unpushed` is the record
  // measured this pass (null = the delivered revision IS on the head);
  // `unpushedMeasured` false means the pass could not tell, and the cached
  // record for the SAME PR is carried forward instead of erased. A `verified`
  // revision never qualifies: a no-change verification has nothing to push.
  //
  // The compare's base is a LOCAL workspace sha. GitHub answering 404 to it
  // (`missing_ref`) is exactly what a never-pushed revision looks like, so that
  // is the PRIMARY arm; one direct commit read confirms it before the record
  // says GitHub has no such commit. A `behind`/`diverged` compare (the revision
  // was pushed once and the head moved elsewhere) keeps the three-way mapping.
  let unpushed: PrRef["unpushedRevision"] = null;
  let unpushedMeasured = false;
  const verifiedRevision = fm.workRevision?.kind === "verified";
  if (pr && ownsAPr && reviewedSha && pr.headSha && driftMeasurable) {
    if (pr.headSha === reviewedSha) {
      unpushedMeasured = true;
    } else {
      const driftCompare = await getBranchCompare(
        gh.client,
        gh.repo,
        reviewedSha,
        pr.headSha,
      );
      if (driftCompare.status === "ok") {
        const status = driftCompare.compare.status;
        if (status === "ahead" && driftCompare.compare.aheadBy > 0) {
          revisionDrift = {
            headSha: pr.headSha,
            authored: driftCompare.compare.aheadBy,
            baseRefresh: null,
          };
          unpushedMeasured = true;
        } else if (status === "identical") {
          unpushedMeasured = true;
        } else if (status === "behind" || status === "diverged") {
          unpushedMeasured = true;
          if (!verifiedRevision) {
            unpushed = { revisionSha: reviewedSha, prHeadSha: pr.headSha, relation: status };
          }
        }
      } else if (driftCompare.status === "missing_ref") {
        const probe = await gh.client.request(
          "GET",
          `/repos/${gh.repo}/commits/${reviewedSha}`,
          commitShaSchema,
        );
        if (!probe.ok && isMissingRefAnswer(probe)) {
          unpushedMeasured = true;
          if (!verifiedRevision) {
            unpushed = { revisionSha: reviewedSha, prHeadSha: pr.headSha, relation: "unknown" };
          }
        }
      }
    }
  }
  // R19-B (owner ruling): a project member's GitHub approval on the PR IS the
  // approving verdict. Derived from the SAME `/reviews` payload the pill
  // already costs, mapped to a Viberr member through `users.github_handle`, and
  // bound to the DELIVERED revision.
  //
  // The unknown/stale rule is the same one `checks`, `review` and `mergeable`
  // follow above, and it is what keeps an unreachable GitHub from flipping a
  // satisfied gate red: `approvals` ABSENT means the reviews call did not run
  // (terminal PR, failed request), so the last-known record is carried forward
  // for the SAME PR rather than erased. A re-delivery still revokes it
  // instantly — `humanVerdictApproval` re-checks the binding against the
  // current `workRevision` on every read, with no GitHub round-trip.
  let humanApproval: PrHumanApproval | null = null;
  if (pr && ownsAPr) {
    humanApproval =
      pr.approvals !== undefined
        ? derivePrHumanApproval({
            approvals: pr.approvals,
            deliveredSha: reviewedSha,
            memberUserIds: projectMemberIds(db, input.projectSlug, ctx.dataRoot),
            db,
          })
        : readPrHumanApproval(cachedPr);
  }
  let newPr: PrRef | null = fm.pr ?? null; // keep last-known PR when lookup was refused/none
  if (pr && ownsAPr) {
    // Each fact below is an OPTIONAL KEY, never a null one: absent means "not
    // read this pass" (so the writer omits it and the reader keeps the cached
    // value), which is a different claim from "read, and there is nothing".
    const owned: PrRef = {
      number: pr.number,
      state: prState ?? pr.state,
      title: pr.title,
    };
    if (checks) owned.checks = checks;
    if (review) owned.review = review;
    if (mergeable) owned.mergeable = mergeable;
    // A measured drift wins; on a settled PR (nothing measured this pass) the
    // last measurement is carried forward for the SAME PR — see `driftMeasurable`.
    const carriedDrift =
      revisionDrift ?? (driftMeasurable ? null : (cachedPr?.revisionDrift ?? null));
    if (carriedDrift) owned.revisionDrift = carriedDrift;
    // Ruling 135: the head as GitHub reported it on THIS read, and the
    // unpushed record: measured this pass, else the SAME PR's cached record.
    // `unpushedRevisionOf` refuses a record for a revision that is no longer
    // current, so carrying is never a lie about a later revision.
    if (pr.headSha) owned.headSha = pr.headSha;
    const carriedUnpushed = unpushedMeasured
      ? unpushed
      : (cachedPr?.unpushedRevision ?? null);
    if (carriedUnpushed) owned.unpushedRevision = carriedUnpushed;
    if (humanApproval) owned[PR_HUMAN_APPROVAL_KEY] = humanApproval;
    newPr = owned;
  }

  const existingGithub: GithubCache | null = fm.github;
  // F31-1 — PROVENANCE. `compare` and the discovered PR's `changed` describe
  // whatever currently sits under the task's branch NAME on GitHub, and a name
  // is not an identity (R15-15). The prefix filter cannot save the commits half
  // — a wiped instance's `[VIB-1]` commits match a fresh VIB-1's prefix — so
  // live, a task whose agent had errored before creating any branch showed
  // "14 files · +313 −30" with two foreign commits, and the completion evidence
  // later claimed "2 commit(s) delivered" it never made.
  //
  // V5 — the test is POSITIVE evidence that the branch head is this task's
  // work, not the absence of an unowned PR. `unownedPr` is only ever non-null
  // when `findPrForBranch` found a PR at all, so a stale remote branch carrying
  // foreign `[KEY]`-prefixed commits and NO pr passed the old absence test and
  // told the same lie with no collision row to explain it.
  //
  // Two questions, two answers:
  //  · `deliveredThisBranch` — does the task's OWN record say it delivered
  //    here? An owned PR (live or cached) or a work revision minted on this
  //    branch. That record is also what makes an EXISTING cache honest: the
  //    workspace-delivery path writes `github.commits` and `workRevision`
  //    together, so a cache with no such record behind it is compare-derived,
  //    and possibly derived before the collision was visible;
  //  · `provenBranchHead` — may THIS pass record what the branch head shows?
  //    Only when the record holds AND no stranger's PR stands on it.
  //
  // So while a collision stands the compare/PR footprint records nothing new,
  // the honestly-captured workspace cache survives, and a footprint with no
  // provenance at all is DROPPED rather than carried forward forever.
  const deliveredThisBranch =
    ownsAPr || fm.pr !== null || fm.workRevision?.branch === branch;
  const provenBranchHead = deliveredThisBranch && !unownedPr;
  // Commit association: `[KEY]`-prefixed commits on the branch. Agents don't
  // always follow the prefix convention, so an EMPTY filtered list must not
  // wipe a non-empty cache captured from the run workspace for this same
  // branch — keep what we honestly recorded rather than zeroing it. `null` is
  // "not derived this pass", which leaves the cache below standing.
  const prefixCommits =
    compare && provenBranchHead ? taskCommits(compare.commits, fm.key) : null;
  const existingCommits = existingGithub?.commits ?? [];
  const branchCommits =
    prefixCommits !== null && prefixCommits.length === 0 && existingCommits.length > 0
      ? existingCommits
      : prefixCommits;
  const ownedChanged = pr && ownsAPr ? pr.changed : undefined;
  // The cache a pass that derived nothing falls back to — empty when the task
  // has no delivery record for this branch, because then the cache describes
  // somebody else's work.
  const cachedCommits = deliveredThisBranch ? existingCommits : [];
  const cachedChanged = deliveredThisBranch
    ? (existingGithub?.changed ?? null)
    : null;
  const newGithub: GithubCache | null =
    branchCommits !== null || ownedChanged || existingGithub || unownedPr
      ? {
          commits: branchCommits ?? cachedCommits,
          changed: ownedChanged ?? cachedChanged,
          // Part of the compared snapshot below, so the collision note fires on
          // the tick it appears and stays quiet on the ~288 that follow.
          unownedPr: unownedPr?.number ?? null,
        }
      : null;
  const unownedPrIsNew =
    !!unownedPr && existingGithub?.unownedPr !== unownedPr.number;
  // The collision is not a divergence and must not read like one: nothing about
  // THIS task changed on GitHub. Say plainly whose PR it is not, WHY the
  // adoption rule refused it, and point at the same remedy the non-fast-forward
  // push already gives.
  const collisionNote =
    unownedPr && adoption && !adoption.adopt
      ? prAdoptionRefusalNote({
          refusal: adoption.refusal,
          taskKey: fm.key,
          branch,
          prNumber: unownedPr.number,
          revisionHeadSha: fm.workRevision?.headSha ?? null,
        })
      : null;

  // An accepted (merge-pending) PR closed on GitHub WITHOUT merging drops the
  // Complete-merge affordance with no path back — explain why, typed `policy`.
  const acceptedClosedExternally =
    fm.pr?.state === "accepted" &&
    newPr?.state === "closed" &&
    fm.pr.number === newPr.number;
  // P14-GV-09: ONE text for the timeline note and the inbox alert below.
  const acceptedClosedText = acceptedClosedExternally
    ? `**Note:** accepted PR #${newPr!.number} was closed on GitHub without merging, so the pending merge can no longer be completed from Viberr.`
    : null;

  // R8-6: out-of-band GitHub actions that leave the governed task stranded. A
  // PR merged or closed DIRECTLY on GitHub (not through Viberr's accept flow)
  // diverges from the task's stage. We SURFACE it (typed timeline event +
  // notification to the humans who govern the task) so a human can close the
  // loop — we NEVER auto-advance the task (files stay canonical).
  const project = getProject(db, input.projectSlug);
  const taskTerminal = isTerminalStage(fm.stage, project?.stages ?? []);
  // Fire only on the TRANSITION into the terminal PR state (newly merged/closed
  // since the last cache), so a persistent divergence isn't re-announced each
  // reconcile.
  const prJustMerged = newPr?.state === "merged" && fm.pr?.state !== "merged";
  const prJustClosed =
    newPr?.state === "closed" &&
    fm.pr?.state !== "closed" &&
    !acceptedClosedExternally;
  const mergedButNotDone = prJustMerged && !taskTerminal;
  const closedButActive = prJustClosed && !taskTerminal;
  // The divergence HEALING transition: a closed PR went live again — the same
  // number reopened, or a fresh PR now tracks the branch. Without this the
  // closed-PR alarm (and the operator's recovery packet below) had no
  // counter-event: a human who fixed the situation ON GITHUB left Viberr
  // holding a stale "needs a decision" state forever.
  const prJustReopened = fm.pr?.state === "closed" && newPr?.state === "review";
  const reopenedText = prJustReopened
    ? fm.pr!.number === newPr!.number
      ? `**Note:** PR #${newPr!.number} was reopened on GitHub. ${fm.key}'s review is live again and the closed-PR block is lifted.`
      : `**Note:** PR #${newPr!.number} now tracks ${fm.key}'s branch on GitHub, replacing closed PR #${fm.pr!.number}, so the closed-PR block is lifted.`
    : null;

  const changed =
    JSON.stringify({ pr: fm.pr, github: fm.github }) !==
    JSON.stringify({ pr: newPr, github: newGithub });

  if (changed) {
    const patch: Partial<TaskFrontmatter> = { pr: newPr, github: newGithub };
    // R8-6: surface a merged/closed-out-of-band divergence (typed event now, a
    // notification below). Never auto-advances the STAGE — a human closes the loop.
    const divergenceText = mergedButNotDone
      ? `**Divergence:** PR #${newPr!.number} was merged on GitHub, but ${fm.key} hasn't been accepted through Viberr, so its stage is unchanged. Accept the completion (or move it to Done) so the task reflects the merge.`
      : closedButActive
        ? `**Divergence:** PR #${newPr!.number} was closed on GitHub without merging, but ${fm.key} is still active. Decide whether to rework and reopen, or archive the task.`
        : null;
    // Owner decision 2026-07-18: a divergence WITHDRAWS the now-moot pending
    // recommendations that assumed the prior delivery could be moved forward as-is
    // — otherwise a human is nudged to "Move to Review" a task whose PR is gone.
    //  · `transition` recs are moot on ANY divergence (the PR state changed under
    //    the premise for advancing).
    //  · `accept_completion` is moot ONLY when the PR was CLOSED (nothing to
    //    accept); when the PR MERGED out-of-band, accepting is exactly the right
    //    action, so that rec SURVIVES (the divergence text points the human at it).
    //  · assign_/run_ recs SURVIVE — doing more work is compatible with "rework".
    const supersededRecs = divergenceText
      ? fm.recommendations.filter(
          (r) =>
            r.kind === "transition" ||
            (r.kind === "accept_completion" && closedButActive),
        )
      : [];
    const supersededIds = new Set(supersededRecs.map((r) => r.id));
    // Everything above was decided from a snapshot taken BEFORE several awaited
    // GitHub round trips, and this is a blind whole-key assign. Another writer
    // can land in that window — an acceptance stamping `pr.state: "accepted"`
    // (merge pending), or a merge stamping `"merged"` — and a plain patch would
    // overwrite it with the "review" this pass set out with. The `accepted`
    // case never recovers: only an acceptance writes it, and the task is
    // already in Done, so "Complete merge" would refuse forever.
    //
    // So re-apply the same two decisions against the file as it is NOW, under
    // the lock: the local lifecycle state wins over a stale remote `review`,
    // and the superseded-recommendation filter runs on the live list.
    await updateTaskFile(ref, (parsed) => {
      const applied: Partial<TaskFrontmatter> = { ...patch };
      const current = parsed.frontmatter.pr;
      if (current) {
        if (!applied.pr) {
          // The snapshot carried no PR, but one exists NOW — a delivery linked
          // it during this pass's awaited round trips. Do not null it back out.
          if ("pr" in applied) delete applied.pr;
        } else if (current.number === applied.pr.number) {
          // A concurrent writer can advance the PR lifecycle during this pass's
          // awaited GitHub round trips; the blind assign below must not regress
          // what it committed:
          //  · MERGED is irreversible — never let any pass (an `accepted` one
          //    whose GitHub lookup was refused and fell back to the snapshot, or
          //    a stale `review`) stamp it back down and re-offer "Complete
          //    merge" on a merged PR.
          //  · a local ACCEPT must survive a pass that only re-read the PR as
          //    still-open (`review`) — the acceptance never recovers otherwise
          //    (only an acceptance writes it, and the task is already in Done) —
          //    but a REAL GitHub close/merge still advances it (accepted→closed
          //    / accepted→merged both land).
          const keepCurrent =
            (current.state === "merged" && applied.pr.state !== "merged") ||
            (current.state === "accepted" && applied.pr.state === "review");
          if (keepCurrent) {
            applied.pr = { ...applied.pr, state: current.state };
          }
        }
      }
      if (supersededIds.size > 0) {
        applied.recommendations = parsed.frontmatter.recommendations.filter(
          (r) => !supersededIds.has(r.id),
        );
      }
      Object.assign(parsed.frontmatter, applied);
    });
    if (unownedPrIsNew && collisionNote) {
      await appendTimelineEvent(ref, {
        occurredAt: new Date().toISOString(),
        type: "note",
        actor: POLICY_ENGINE_ACTOR,
        title: null,
        text: collisionNote,
        toAgent: false,
        evidence: null,
      });
    }
    if (acceptedClosedText) {
      await appendTimelineEvent(ref, {
        occurredAt: new Date().toISOString(),
        // Neutral divergence note, not a violation (P13-LV-03).
        type: "note",
        actor: POLICY_ENGINE_ACTOR,
        title: null,
        text: acceptedClosedText,
        toAgent: false,
        evidence: null,
      });
    }
    if (divergenceText) {
      const supersededNote =
        supersededRecs.length > 0
          ? ` The now-moot ${supersededRecs
              .map((r) => `“${r.label}”`)
              .join(", ")} recommendation${supersededRecs.length === 1 ? " was" : "s were"} withdrawn.`
          : "";
      await appendTimelineEvent(ref, {
        occurredAt: new Date().toISOString(),
        // A GitHub-side divergence is a neutral note the human must act on, not
        // a governance violation by an agent (P13-LV-03).
        type: "note",
        actor: POLICY_ENGINE_ACTOR,
        title: null,
        text: divergenceText + supersededNote,
        toAgent: false,
        evidence: null,
      });
    }
    if (reopenedText) {
      await appendTimelineEvent(ref, {
        occurredAt: new Date().toISOString(),
        type: "note",
        actor: POLICY_ENGINE_ACTOR,
        title: null,
        text: reopenedText,
        toAgent: false,
        evidence: null,
      });
    }
    rebuildPath(db, resolveTaskFilePath(ref), {
      dataRoot: ctx.dataRoot,
    });
    // Notify the task's supervisors (owner + admins/maintainers) so the
    // divergence reaches an inbox, not just the timeline. Dynamic import keeps
    // the reconciler free of a static task-actions cycle (mirrors mergeTaskPr).
    //
    // P14-GV-09: the accepted-then-closed-externally case is a divergence too —
    // it silently REMOVES the "Complete merge" affordance from an accepted task
    // (pr.state → closed), so only a visitor to the task page ever learned that
    // the promised merge can no longer happen. It gets the same inbox alert as
    // the other two branches.
    const noticeText = divergenceText ?? acceptedClosedText ?? reopenedText;
    if (noticeText) {
      const { notifyTaskWatchers } = await import(
        "~/server/tasks/task-actions.server"
      );
      notifyTaskWatchers(
        db,
        {
          projectSlug: input.projectSlug,
          taskKey: input.taskKey,
          kind: "policy",
          title: mergedButNotDone
            ? `PR #${newPr!.number} merged on GitHub: accept ${fm.key}`
            : divergenceText
              ? `PR #${newPr!.number} closed on GitHub: ${fm.key} needs a decision`
              : acceptedClosedText
                ? `Accepted PR #${newPr!.number} closed on GitHub: ${fm.key}'s merge can't complete`
                : `PR #${newPr!.number} live again on GitHub: ${fm.key} resumes`,
          text: noticeText,
          from: POLICY_ENGINE_NOTIFY_FROM,
        },
        { dataRoot: ctx.dataRoot },
      );
    }
    // The out-of-band PR transition is a COORDINATION event, so it wakes the
    // task's operator like any other (create/transition/agent-reply already
    // do). On closed-but-active the operator turns the prose above into a real
    // decision packet (rework / archive / archive+delete-branch); on
    // merged-but-not-done it proposes acceptance per policy; on reopen it
    // withdraws the now-moot recovery packet. Fire-and-forget on the same
    // transition edge as the notes — a persistent divergence never re-fires,
    // and a project with no operator deployed is a no-op inside.
    if (
      mergedButNotDone ||
      closedButActive ||
      acceptedClosedExternally ||
      prJustReopened
    ) {
      const wake =
        ctx.wakeOperator ??
        (await import("~/server/tasks/task-actions.server")).autoInvokeOperator;
      void wake(
        db,
        { dataRoot: ctx.dataRoot },
        input.projectSlug,
        input.taskKey,
        "pr-diverged",
      );
    }
  }

  const sync = deriveSyncState({
    prMerged: (pr?.state ?? fm.pr?.state) === "merged",
    behindBy: compare?.behindBy ?? 0,
  });

  // DG-3: skip the no-change heartbeat row on poller ticks so provenance doesn't
  // grow unboundedly; still record every observation for a human-triggered reconcile.
  if (changed || !ctx.skipUnchangedProvenance) {
    const details: GithubProvenanceDetails = {
      repo: gh.repo,
      branch,
      changed,
      sync,
      aheadBy: compare?.aheadBy ?? null,
      behindBy: compare?.behindBy ?? null,
      prNumber: pr?.number ?? null,
      prState: pr?.state ?? null,
      // P13-D-28: the two newly-consumed GitHub facts, on the observation row.
      prReview: review ?? null,
      prChecks: checks,
      commits: branchCommits?.length ?? null,
    };
    // F21-8: an incomplete commit list is recorded as such — the observation row
    // is where a later reader learns the footprint it shows is short.
    if (compare && compare.droppedCommits > 0) {
      details.commitsDropped = compare.droppedCommits;
    }
    recordGithubProvenance(db, {
      absPath: resolveTaskFilePath(ref),
      dataRoot: ctx.dataRoot,
      action: "github.reconcile",
      details,
    });
  }
  recordAudit(db, {
    action: "github.reconcile.task",
    actor,
    subjectKind: "task",
    subjectId: input.taskKey,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: { repo: gh.repo, branch, changed, sync },
  });

  return {
    status: "reconciled",
    taskKey: input.taskKey,
    repo: gh.repo,
    branch,
    changed,
    sync,
    compare: compare
      ? { aheadBy: compare.aheadBy, behindBy: compare.behindBy }
      : null,
    pr,
    commits: branchCommits?.length ?? 0,
  };
}

/**
 * Reconciles ONE task with GitHub. Idempotent: unchanged facts produce no
 * file write and no reprojection (`changed: false`), but always record a
 * provenance row for the observation. Serialized per task — see
 * `withTaskReconcileLock` (F19-19).
 */
export function reconcileTask(
  db: DatabaseSync,
  input: { projectSlug: string; taskKey: string },
  actor: AuditActor,
  ctx: GithubActionContext = {},
): Promise<TaskReconcileResult> {
  return withTaskReconcileLock(
    // The data root is part of the key so two test stores that happen to share
    // a project slug do not serialize against each other.
    `${ctx.dataRoot ?? ""}::${input.projectSlug}/${input.taskKey}`,
    async () => {
      try {
        return await reconcileTaskUnlocked(db, input, actor, ctx);
      } catch (error) {
        // F21-9: the outermost per-task boundary. One task's unexpected failure
        // used to abort the whole project sweep (and 500 the Reconcile button),
        // taking every task after it with it — the poller's next tick then hit
        // the same task first and lost the board again.
        const message = error instanceof Error ? error.message : String(error);
        logger.error("task reconcile failed unexpectedly", {
          projectSlug: input.projectSlug,
          taskKey: input.taskKey,
          err: message,
        });
        return { status: "task_error", taskKey: input.taskKey, message };
      }
    },
  );
}

export interface ProjectReconcileSummary {
  status: "ok" | "no_pat_configured" | "no_repo_configured";
  /** Per-task results for every task that has a branch. */
  results: TaskReconcileResult[];
  reconciled: number;
  changed: number;
  failed: number;
  /** B-GH5: branched tasks this pass deliberately deferred to the next tick
   *  (budgeted passes only — a human-triggered sweep never skips). */
  skipped: number;
}

/**
 * B-GH5: how many task reconciles may be in flight at once. Each task costs
 * 3-6 GitHub calls, and `Promise.all` over the whole board fired every one of
 * them simultaneously against a SINGLE PAT's rate limit — every five minutes,
 * for every project. Four in flight keeps a human-triggered sweep fast without
 * spending the hour's budget in one burst.
 */
export const RECONCILE_TASK_CONCURRENCY = 4;

/**
 * Per-project task budget for one BUDGETED pass (the background poller).
 * The remainder is not dropped: the cursor below resumes the next pass where
 * this one stopped, so a 200-task board is still fully visited — just spread
 * across ticks instead of burning the rate limit in one.
 */
export const RECONCILE_POLL_TASK_BUDGET = 20;

/**
 * projectSlug → the task key the next budgeted pass starts at. In-memory by
 * design: losing it (restart, HMR) costs one pass that begins at the first key
 * again, never correctness.
 */
const reconcileCursors = new Map<string, string>();

/** The cursor map is module-global, so a second budgeted test in the same file
 *  would otherwise inherit the first one's resume point. */
export function resetReconcileCursorsForTests(): void {
  reconcileCursors.clear();
  // F19-19: the per-task lock keys off the data root, which is unique per test
  // store — but a leaked chain would still hold a settled promise, so drop them
  // with the cursors.
  taskReconcileChain.clear();
}

/** One branched task the pass may visit. `terminal` is sqlite's 0/1 answer to
 *  the archived-or-merged test the SELECT computes. */
const reconcileQueueRows = z
  .object({ task_key: z.string(), terminal: z.number() })
  .array();

/**
 * Reconciles every task of the project that has a branch (the GitHub
 * view's Reconcile button). Configuration gaps short-circuit before any
 * network call.
 */
export async function reconcileProject(
  db: DatabaseSync,
  projectSlug: string,
  actor: AuditActor,
  ctx: GithubActionContext = {},
): Promise<ProjectReconcileSummary> {
  const gh = getProjectGithubContext(db, projectSlug, githubOptionsOf(ctx));
  if (gh.status !== "ok") {
    return {
      status: gh.status,
      results: [],
      reconciled: 0,
      changed: 0,
      failed: 0,
      skipped: 0,
    };
  }

  const rows = reconcileQueueRows.parse(
    db
      .prepare(
        `SELECT task_key,
              (archived = 1
               OR COALESCE(json_extract(pr_json, '$.state'), '') = 'merged')
              AS terminal
       FROM task_projections
       WHERE project_slug = ? AND branch IS NOT NULL
       ORDER BY task_key ASC`,
      )
      .all(projectSlug),
  );

  const budget = ctx.taskBudget ?? 0;
  // R15-6 + B-GH5: cleanup deletes the remote ref but `branch:` stays in the
  // task file (it is the historical record of where the work was delivered), so
  // a merged-and-cleaned task keeps matching `branch IS NOT NULL` and keeps
  // buying a guaranteed 404 compare every pass — forever. Under the poll budget
  // those zombies also eat the rotation: 100 merged + 5 live tasks meant the
  // live PRs were visited every fifth tick. A terminal task has nothing left to
  // learn from GitHub, so a BUDGETED pass skips it outright. Manual "Update
  // status" carries no budget and still re-checks the whole board, which is the
  // way back if a terminal task's GitHub state ever needs re-reading.
  //
  // "Terminal" is archived-or-MERGED, deliberately not closed: GitHub lets a
  // closed PR be reopened, and this reconciler is the only thing that notices —
  // it writes the "PR live again" note, alerts the watchers, and re-invokes the
  // operator to WITHDRAW the now-moot recovery packet. The poller is the only
  // budgeted caller, so folding `closed` into terminal would have made all
  // three unreachable from the only automatic path.
  const allKeys = rows
    .filter((row) => budget === 0 || row.terminal !== 1)
    .map((row) => row.task_key);
  const terminal = rows.length - allKeys.length;
  let selected = allKeys;
  if (budget > 0 && allKeys.length > budget) {
    // Resume where the last budgeted pass stopped and wrap — every task gets
    // its turn instead of the first N being reconciled forever.
    const cursor = reconcileCursors.get(projectSlug);
    const at = cursor ? allKeys.findIndex((key) => key >= cursor) : 0;
    const start = at < 0 ? 0 : at;
    const rotated = [...allKeys.slice(start), ...allKeys.slice(0, start)];
    selected = rotated.slice(0, budget);
    reconcileCursors.set(projectSlug, rotated[budget] ?? allKeys[0]!);
  } else if (budget > 0) {
    reconcileCursors.delete(projectSlug);
  }
  const skipped = allKeys.length - selected.length;

  // Bounded worker pool, not Promise.all — see RECONCILE_TASK_CONCURRENCY. Each
  // worker writes its own index, so the finished array is in `selected` order
  // however the passes interleaved.
  const results: TaskReconcileResult[] = [];
  let cursorIndex = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursorIndex++;
      const taskKey = selected[index];
      if (taskKey === undefined) return;
      results[index] = await reconcileTask(
        db,
        { projectSlug, taskKey },
        actor,
        ctx,
      );
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(RECONCILE_TASK_CONCURRENCY, selected.length) },
      worker,
    ),
  );
  let reconciled = 0;
  let changed = 0;
  let failed = 0;
  for (const result of results) {
    if (result.status === "reconciled") {
      reconciled += 1;
      if (result.changed) changed += 1;
    } else if (result.status !== "no_branch") {
      failed += 1;
    }
  }

  if (!ctx.skipProjectAudit) {
    recordAudit(db, {
      action: "github.reconcile.project",
      actor,
      subjectKind: "project",
      subjectId: projectSlug,
      projectSlug,
      details: {
        tasks: rows.length,
        reconciled,
        changed,
        failed,
        skipped,
        terminal,
      },
    });
  }
  // F15-02: a successful pass over ZERO branched tasks is still an observation
  // — without a heartbeat row the GitHub page reads "not yet synced" forever on
  // a young project, while the button's toast claims success. Task-level passes
  // already write their own `github.reconcile` rows.
  if (rows.length === 0) {
    const { resolveProjectFilePath } = await import(
      "~/server/files/project-writer.server"
    );
    const projectRef: ProjectFileRef = { projectSlug };
    if (ctx.dataRoot) projectRef.dataRoot = ctx.dataRoot;
    const heartbeat: GithubProvenanceRow = {
      absPath: resolveProjectFilePath(projectRef),
      action: "github.reconcile",
      details: { repo: gh.repo, heartbeat: true, tasks: 0 },
    };
    if (ctx.dataRoot) heartbeat.dataRoot = ctx.dataRoot;
    recordGithubProvenance(db, heartbeat);
  }
  return { status: "ok", results, reconciled, changed, failed, skipped };
}

// ------------------------------------------------------------------ merge

export type MergeTaskPrResult =
  | { status: "merged"; prNumber: number; sha: string | null }
  | { status: "task_not_found"; taskKey: string }
  | { status: "no_pr"; taskKey: string }
  | GithubContextFailure
  | {
      status: "not_mergeable";
      prNumber: number;
      message: string;
      /** P14-LV-07: set when GitHub told us WHY — a head/base conflict. Lets the
       *  caller name the real cause instead of blaming credentials. */
      mergeable?: PrMergeable;
    }
  | { status: "head_changed"; prNumber: number; message: string }
  | {
      status: "scope_violation";
      prNumber: number;
      scope: "pull_request:write";
      violationId: string;
      message: string;
    }
  | { status: "pr_not_found"; prNumber: number }
  | { status: "auth_failed"; message: string }
  | { status: "network_unavailable"; message: string };

/** `PUT /pulls/{n}/merge` — only the merge sha is read, and with `??`
 *  tolerance, so it parses to `undefined` on drift (recorded as null). */
const ghMergeResponseSchema = z
  .object({ sha: z.string().nullable().optional().catch(undefined) })
  .catch({});

/** The PR-detail slice the merge path reads (draft/un-draft + mergeability).
 *  Every read is optional-chained or `=== true`-guarded, so every field
 *  degrades to `undefined` on drift instead of voiding the response. */
const ghPrViewSchema = z
  .object({
    draft: z.boolean().optional().catch(undefined),
    node_id: z.string().optional().catch(undefined),
    mergeable: z.boolean().nullable().optional().catch(undefined),
    mergeable_state: z.string().optional().catch(undefined),
  })
  .catch({});

/**
 * THE real merge behind accept_completion (ruling 7). Merges the task's
 * cached PR via PUT /repos/{repo}/pulls/{n}/merge and returns typed
 * results — the caller (Phase 5 resolvePacket integration) renders
 * failures explicitly and must NOT flip the task to done unless this
 * returns `merged`.
 *
 * Side effects on success: task.md `pr.state` → "merged" + a `github`
 * timeline event authored by the accepting human ("Merged **PR #N** into
 * `main`.") + reprojection + audit; an open `pull_request:write` violation
 * for this task is resolved (the successful write is the proof) with its
 * typed policy-update event.
 *
 * Side effects on 403: opens (or reuses — idempotent) the
 * `pull_request:write` scope violation carried by this task, with its
 * typed `policy` timeline event + owner notification (the VIB-142
 * scenario; the seeded violation row is simply reused).
 */
export async function mergeTaskPr(
  db: DatabaseSync,
  input: { projectSlug: string; taskKey: string },
  actor: AuditActor & { userId: string },
  ctx: GithubActionContext = {},
): Promise<MergeTaskPrResult> {
  const ref = taskRefOf(input, ctx);
  const file = readTaskFile(ref);
  if (!file) return { status: "task_not_found", taskKey: input.taskKey };
  const fm = file.parsed.frontmatter;
  if (!fm.pr) return { status: "no_pr", taskKey: input.taskKey };
  const prNumber = fm.pr.number;

  // P13-D-5: task-level repo override deleted (owner ruling) — project repo only.
  const gh = getProjectGithubContext(db, input.projectSlug, githubOptionsOf(ctx));
  if (gh.status !== "ok") return gh;

  // F7-GH5: an agent that opened the PR via `gh pr create --draft` (or the
  // account default) leaves it a DRAFT, which GitHub refuses to merge (405
  // "Pull Request is still a draft") — acceptance then dead-ends with no fix.
  // A draft can only be cleared through GraphQL (`markPullRequestReadyForReview`,
  // REST can't unset `draft`), so mark it ready with the project PAT before the
  // merge. Best-effort: if the un-draft fails, the merge attempt below still
  // returns GitHub's own actionable message.
  const prView = await gh.client.request(
    "GET",
    `/repos/${gh.repo}/pulls/${prNumber}`,
    ghPrViewSchema,
  );

  // P14-LV-07: the SAME detail call already carries GitHub's mergeability, and
  // a conflicting PR cannot be merged by anyone. Refuse before the merge attempt
  // and RECORD the conflict in the task's PR cache, so the acceptance copy, the
  // task card and the GitHub page all name the real cause instead of the
  // catch-all "no reachable GitHub merge — … once credentials are set" that
  // VM-4 shipped while its PR sat open and conflicting.
  if (prView.ok) {
    const mergeable = deriveMergeable(prView.data);
    // Only a DEFINITE answer is worth persisting — "unknown" means GitHub is
    // still computing, and writing it would churn the file (and blank the pill)
    // on every merge attempt right after a push.
    if (mergeable !== "unknown" && mergeable !== (fm.pr.mergeable ?? null)) {
      await patchTaskFrontmatter(ref, { pr: { ...fm.pr, mergeable } });
      rebuildPath(db, resolveTaskFilePath(ref), { dataRoot: ctx.dataRoot });
    }
    if (mergeable === "conflicting") {
      return {
        status: "not_mergeable",
        prNumber,
        message: `PR #${prNumber} conflicts with \`${gh.defaultBranch}\`. Rebase the branch, then merge.`,
        mergeable,
      };
    }
  }

  if (prView.ok && prView.data.draft === true && prView.data.node_id) {
    await gh.client
      // P11-16: derive the GraphQL endpoint from the SAME base the REST client
      // uses instead of a separate literal, so the two layers agree on the host.
      // V1 is github.com-only (no non-default baseUrl is ever wired), so this
      // resolves to api.github.com/graphql; a GHE base would need the different
      // `/api/graphql` path, which V1 does not claim to support.
      .request("POST", `${GITHUB_API_BASE}/graphql`, z.unknown(), {
        body: {
          query:
            "mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){clientMutationId}}",
          variables: { id: prView.data.node_id },
        },
      })
      .catch(() => undefined);
  }

  const merge = await gh.client.request(
    "PUT",
    `/repos/${gh.repo}/pulls/${prNumber}/merge`,
    ghMergeResponseSchema,
    { body: {} },
  );

  if (merge.ok) {
    const sha = merge.data.sha ?? null;
    // File write: cache flips to merged + human-authored github event. P14-LV-07:
    // a settled PR carries no mergeability — drop the key rather than freeze the
    // pre-merge answer (which would also re-write a conflict the merge just
    // disproved, since `fm` predates the mergeability patch above).
    const { mergeable: _settled, ...prBase } = fm.pr;
    await patchTaskFrontmatter(ref, { pr: { ...prBase, state: "merged" } });
    await appendTimelineEvent(ref, {
      occurredAt: new Date().toISOString(),
      type: "github",
      actor: {
        kind: "human",
        userId: actor.userId,
        nameHint: userName(db, actor.userId),
      },
      title: null,
      text: `Merged **PR #${prNumber}** into \`${gh.defaultBranch}\`.`,
      toAgent: false,
      evidence: null,
    });
    rebuildPath(db, resolveTaskFilePath(ref), {
      dataRoot: ctx.dataRoot,
    });
    recordGithubProvenance(db, {
      absPath: resolveTaskFilePath(ref),
      dataRoot: ctx.dataRoot,
      action: "github.merge",
      details: { repo: gh.repo, prNumber, sha },
    });
    recordAudit(db, {
      action: "github.pr.merged",
      actor,
      subjectKind: "pull_request",
      subjectId: `${gh.repo}#${prNumber}`,
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      details: { repo: gh.repo, prNumber, sha },
    });
    // The successful write PROVES pull_request:write — resolve an open
    // violation for this task (typed policy-update event included).
    const open = findOpenScopeViolation(
      db,
      input.projectSlug,
      "pull_request:write",
      input.taskKey,
    );
    if (open) {
      await resolveScopeViolationWithEvent(
        db,
        open.id,
        actor,
        { dataRoot: ctx.dataRoot },
      );
    }
    // F28-U2a: a real merge is a solicited write just like opening a PR, so it
    // must also flip the cached scope to proven. Resolving a violation above
    // only helps when one was OPEN; a PR the agent opened with its OWN git
    // credentials (bypassing viberr's PAT) leaves no violation, so without this
    // the merge — the FIRST real use of the bound PAT — never clears "unproven".
    // Prove it on the credential that made THIS merge call (F28-U2b), by id.
    markWriteScopeProven(db, gh.patId);
    // R15-6: post-merge branch cleanup, per project policy (default ON). The
    // merge is done and recorded above — cleanup is housekeeping that must
    // never turn a successful merge into a failed one, so every outcome
    // (including a refusal) lands as a plain-words note and the result stays
    // `merged`. `deleteTaskRemoteBranch` re-reads the task, so it sees the
    // `merged` state just written and its open-PR refusal correctly stands down.
    // The try/catch is the contract, not caution: the DB read, the file append
    // and the reprojection below can all THROW after GitHub has already merged,
    // and an acceptance that reported failure over a completed merge is the one
    // outcome this block must never produce.
    try {
      if (branchCleanupOnMerge(db, input.projectSlug)) {
        const cleanup = await deleteTaskRemoteBranch(db, input, actor, ctx);
        const note =
          cleanup.status === "deleted" || cleanup.status === "no_branch"
            ? null
            : cleanup.status === "already_gone"
              ? `Branch \`${cleanup.branch}\` was already gone on GitHub. Nothing was left to clean up.`
              : cleanup.status === "refused"
                ? `Branch \`${cleanup.branch}\` was **not** deleted after the merge. ${cleanup.message}`
                : "The merged branch was **not** deleted because this project has no GitHub repo or credential configured.";
        if (note) {
          await appendTimelineEvent(ref, {
            occurredAt: new Date().toISOString(),
            type: "note",
            actor: POLICY_ENGINE_ACTOR,
            title: null,
            text: note,
            toAgent: false,
            evidence: null,
          });
          rebuildPath(db, resolveTaskFilePath(ref), { dataRoot: ctx.dataRoot });
        }
      }
    } catch {
      // The branch survives; the next manual cleanup (or archive) can retry.
    }
    return { status: "merged", prNumber, sha };
  }

  if (merge.kind === "network") {
    return { status: "network_unavailable", message: merge.message };
  }
  // http failures
  if (merge.status === 405) {
    return { status: "not_mergeable", prNumber, message: merge.message };
  }
  if (merge.status === 409) {
    return { status: "head_changed", prNumber, message: merge.message };
  }
  if (merge.status === 403) {
    const { violation } = await flagScopeViolation(
      db,
      {
        projectSlug: input.projectSlug,
        taskKey: input.taskKey,
        scope: "pull_request:write",
        detail: policyViolationText(
          "pull_request:write",
          `Merging PR #${prNumber} was refused.`,
        ),
        actor,
      },
      { dataRoot: ctx.dataRoot },
    );
    recordAudit(db, {
      action: "github.pr.merge_refused",
      actor,
      subjectKind: "pull_request",
      subjectId: `${gh.repo}#${prNumber}`,
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      details: { scope: "pull_request:write", violationId: violation.id },
    });
    return {
      status: "scope_violation",
      prNumber,
      scope: "pull_request:write",
      violationId: violation.id,
      message: merge.message,
    };
  }
  if (merge.status === 404) {
    return { status: "pr_not_found", prNumber };
  }
  if (merge.status === 401) {
    return { status: "auth_failed", message: merge.message };
  }
  return {
    status: "network_unavailable",
    message: merge.kind === "http" ? merge.message : `GitHub ${merge.status}`,
  };
}

// ------------------------------------------------------- branch deletion

export type BranchDeleteResult =
  | { status: "deleted"; branch: string }
  /** GitHub reports the ref no longer exists — the cleanup already happened. */
  | { status: "already_gone"; branch: string }
  | { status: "no_branch" }
  /** Structural refusals (open PR / base branch) and GitHub failures alike:
   *  the branch stays, `message` says why in human terms. */
  | { status: "refused"; branch: string; message: string };

/**
 * Delete the task's remote branch — the discard half of the
 * `archive_task` + `deleteBranch` packet option (a human chose to abandon
 * work whose PR was closed without merging).
 *
 * Deliberate refusals, not just failures:
 *  - while the task's PR is OPEN (`review`/`accepted`): deleting the head
 *    branch makes GitHub silently close the PR — that decision belongs to a
 *    human on the PR, not to a cleanup side effect;
 *  - when the branch IS the project's default branch (a misconfigured task
 *    must never take out `main`).
 *
 * Never throws: callers record the typed outcome on the timeline and move on —
 * an archive whose branch cleanup failed is still an archive.
 */
export async function deleteTaskRemoteBranch(
  db: DatabaseSync,
  input: { projectSlug: string; taskKey: string },
  actor: AuditActor,
  ctx: GithubActionContext = {},
): Promise<BranchDeleteResult | GithubContextFailure> {
  const ref = taskRefOf(input, ctx);
  const file = readTaskFile(ref);
  if (!file?.parsed.frontmatter.branch) return { status: "no_branch" };
  const fm = file.parsed.frontmatter;
  const branch = fm.branch!;
  const userId = actor.userId;
  if (!userId) {
    // Branch deletion is a HUMAN decision (an archive_task packet option) —
    // there is no system path to it, so an anonymous actor is refused.
    return { status: "refused", branch, message: "No acting user." };
  }

  const gh = getProjectGithubContext(db, input.projectSlug, githubOptionsOf(ctx));
  if (gh.status !== "ok") return gh;

  if (branch === gh.defaultBranch) {
    return {
      status: "refused",
      branch,
      message: `\`${branch}\` is the project's default branch. Viberr never deletes it.`,
    };
  }
  if (fm.pr && (fm.pr.state === "review" || fm.pr.state === "accepted")) {
    return {
      status: "refused",
      branch,
      message: `PR #${fm.pr.number} is still open on \`${branch}\`, and deleting the branch would silently close it. Close or merge the PR first.`,
    };
  }

  // B11: this interpolated the branch raw, so it was correct only for
  // `vib-142`-shaped names — a `#`, `?` or space addressed a different ref, or
  // none at all. Encoded PER SEGMENT because `heads/<branch>` is a path and a
  // branch may legitimately contain `/` (`feature/x`), which has to stay a
  // separator. For today's task-key branches this is byte-identical to what it
  // already sent, so the working path cannot regress.
  const refPath = encodeRefPath(`heads/${branch}`);
  const del = await gh.client.request(
    "DELETE",
    `/repos/${gh.repo}/git/refs/${refPath}`,
    z.unknown(),
  );

  if (del.ok) {
    await appendTimelineEvent(ref, {
      occurredAt: new Date().toISOString(),
      type: "github",
      actor: {
        kind: "human",
        userId,
        nameHint: userName(db, userId),
      },
      title: null,
      text: `Deleted branch \`${branch}\` from GitHub.`,
      toAgent: false,
      evidence: null,
    });
    rebuildPath(db, resolveTaskFilePath(ref), { dataRoot: ctx.dataRoot });
    recordGithubProvenance(db, {
      absPath: resolveTaskFilePath(ref),
      dataRoot: ctx.dataRoot,
      action: "github.branch_delete",
      details: { repo: gh.repo, branch },
    });
    recordAudit(db, {
      action: "github.branch.deleted",
      actor,
      subjectKind: "branch",
      subjectId: `${gh.repo}:${branch}`,
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      details: { repo: gh.repo, branch },
    });
    return { status: "deleted", branch };
  }

  // GitHub answers "Reference does not exist" with a 422 — someone already
  // cleaned it up. That is the state the human asked for, reported honestly.
  if (del.kind === "http" && del.status === 422) {
    return { status: "already_gone", branch };
  }
  return {
    status: "refused",
    branch,
    message:
      del.kind === "network"
        ? `GitHub is unreachable (${del.message}).`
        : del.kind === "http"
          ? `GitHub refused the deletion (${del.message}).`
          : `GitHub gave an unexpected response (${del.status}).`,
  };
}

/** Outcome of the F31-6 branch-collision remedy. `cleared` means the stale
 *  remote ref is gone (and the recorded unowned PR is closed or closing) —
 *  the caller may re-deliver; `refused` names the step that stood in the way. */
export type RemoteCollisionResult =
  | { status: "cleared"; branch: string; closedUnownedPr: number | null }
  | { status: "refused"; message: string };

/**
 * F31-6 — clear a task-key branch collision: the remote holds an unrelated
 * branch (usually with an unowned PR, R15-15) under this task's branch name,
 * so delivery push-conflicts. Steps, each honest on the timeline:
 *   1. close the recorded unowned PR (best-effort — deleting its head branch
 *      would close it anyway; closing first records the intent),
 *   2. delete the stale REMOTE branch (all of `deleteTaskRemoteBranch`'s
 *      refusals still bind — the task's OWN open PR or the default branch is
 *      never deleted this way),
 * The LOCAL workspace branch — this task's actual delivery — is untouched;
 * the caller re-delivers it once the name is free.
 */
export async function resolveRemoteBranchCollision(
  db: DatabaseSync,
  input: { projectSlug: string; taskKey: string },
  actor: AuditActor,
  ctx: GithubActionContext = {},
): Promise<RemoteCollisionResult> {
  const ref = taskRefOf(input, ctx);
  const file = readTaskFile(ref);
  const branch = file?.parsed.frontmatter.branch;
  if (!file || !branch) {
    return { status: "refused", message: "The task has no workspace branch." };
  }
  const unowned = file.parsed.frontmatter.github?.unownedPr ?? null;
  // C05-C (pass 32): closing someone else's PR is a HUMAN decision, exactly as
  // `deleteTaskRemoteBranch` says of the ref below — enforced here rather than
  // asserted (`actor.userId!`), so a system actor reaching this exported
  // function is refused before any GitHub write, not after one.
  const userId = actor.userId;
  if (!userId) {
    return { status: "refused", message: "No acting user." };
  }

  const gh = getProjectGithubContext(db, input.projectSlug, githubOptionsOf(ctx));
  if (gh.status !== "ok") {
    return {
      status: "refused",
      message: "This project has no GitHub repo or credential configured.",
    };
  }

  // C05-B (pass 32): the DELETE goes first. The old order closed the unowned
  // PR and then, when the branch delete refused (default branch, own PR open on
  // it, a non-422 answer), reported "the branch collision was not cleared …
  // nothing was re-delivered" — true words that said nothing about the PR it
  // had just closed. Deleting the head ref first means a refusal leaves
  // GitHub exactly as it was; and a deleted head branch closes its PR on
  // GitHub's side anyway, so the explicit close below is the audited record of
  // an outcome the delete already produced.
  const del = await deleteTaskRemoteBranch(db, input, actor, ctx);
  if (del.status === "deleted" || del.status === "already_gone") {
    let closedUnownedPr: number | null = null;
    if (unowned !== null) {
      const close = await gh.client.request(
        "PATCH",
        `/repos/${gh.repo}/pulls/${unowned}`,
        z.unknown(),
        { body: { state: "closed" } },
      );
      // Best-effort by design: a PR that is already closed (which the ref
      // delete just did) answers 200. Only a SUCCESS is recorded.
      if (close.ok) {
        closedUnownedPr = unowned;
        await appendTimelineEvent(ref, {
          occurredAt: new Date().toISOString(),
          type: "github",
          actor: { kind: "human", userId, nameHint: userName(db, userId) },
          title: null,
          text: `Closed unrelated PR #${unowned} that stood on branch \`${branch}\` (it was not ${input.taskKey}'s review PR).`,
          toAgent: false,
          evidence: null,
        });
        recordAudit(db, {
          action: "github.pr.closed_unowned",
          actor,
          subjectKind: "pull_request",
          subjectId: `${gh.repo}#${unowned}`,
          projectSlug: input.projectSlug,
          taskKey: input.taskKey,
          details: { repo: gh.repo, branch, prNumber: unowned },
        });
      } else if (close.kind === "http" && close.status === 403) {
        // C05-D (pass 32): a 403 here is the SAME fact `openTaskPr` and
        // `mergeTaskPr` flag — the credential lacks pull_request:write — and
        // it used to vanish into the best-effort silence. The half-remedy
        // (ref gone, PR left to GitHub's auto-close) is honest; the missing
        // scope is what the human has to fix, so it gets its chip.
        await flagScopeViolation(
          db,
          {
            projectSlug: input.projectSlug,
            taskKey: input.taskKey,
            scope: "pull_request:write",
            detail: policyViolationText(
              "pull_request:write",
              `closing the unrelated pull request #${unowned} that stood on branch \`${branch}\``,
            ),
            actor,
          },
          { dataRoot: ctx.dataRoot },
        );
      }
    }
    // The R15-15 record is stale the moment the ref is gone — clear it so the
    // GitHub card and the policy engine stop reporting a collision that no
    // longer exists (the next reconcile would clear it too; this is sooner).
    await updateTaskFile(ref, (parsed) => {
      if (parsed.frontmatter.github?.unownedPr != null) {
        parsed.frontmatter.github.unownedPr = null;
      }
    });
    rebuildPath(db, resolveTaskFilePath(ref), { dataRoot: ctx.dataRoot });
    return { status: "cleared", branch, closedUnownedPr };
  }
  if (del.status === "no_branch") {
    return { status: "refused", message: "The task has no workspace branch." };
  }
  if (del.status === "refused") {
    return { status: "refused", message: del.message };
  }
  // GithubContextFailure — the context vanished between the check above and
  // the delete (credential detached mid-flight). Same words as the up-front
  // refusal: the human's remedy is identical.
  return {
    status: "refused",
    message: "This project has no GitHub repo or credential configured.",
  };
}
