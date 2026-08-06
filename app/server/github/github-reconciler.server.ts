import type { DatabaseSync } from "node:sqlite";
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
} from "~/server/files/task-writer.server";
import { storeRelativePath } from "~/server/files/file-store-root.server";
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
import { encodeRefPath, GITHUB_API_BASE } from "./github-client.server";
import {
  getProjectGithubContext,
  type GithubContextFailure,
} from "./github-context.server";
import { branchCleanupOnMerge } from "./branch-cleanup.server";
import { decidePrAdoption, prAdoptionRefusalNote } from "./pr-adoption.server";
import { deriveMergeable, findPrForBranch, type PrFacts } from "./pr-linker.server";
import { getProject } from "~/server/projections/board-query.server";
import { isTerminalStage } from "~/shared/workflow/stage-roles";
import {
  POLICY_ENGINE_ACTOR,
  flagScopeViolation,
  policyViolationText,
  resolveScopeViolationWithEvent,
} from "./scope-flag.server";

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

export interface GithubActionContext {
  dataRoot?: string;
  /** Mock-transport hook for tests. */
  fetchImpl?: typeof fetch;
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

function recordGithubProvenance(
  db: DatabaseSync,
  input: {
    absPath: string;
    dataRoot?: string;
    action: string;
    details: Record<string, unknown>;
  },
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

function userName(db: DatabaseSync, userId: string): string {
  const row = db.prepare(`SELECT name FROM users WHERE id = ?`).get(userId) as
    | { name: string }
    | undefined;
  return row?.name ?? userId;
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
  | { status: "network_unavailable"; message: string };

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
  const gh = getProjectGithubContext(db, input.projectSlug, {
    ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
  });
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
  let revisionDrift: PrRef["revisionDrift"] = null;
  if (
    pr &&
    ownsAPr &&
    reviewedSha &&
    pr.headSha &&
    pr.headSha !== reviewedSha &&
    (prState === "review" || prState === "accepted")
  ) {
    const driftCompare = await getBranchCompare(
      gh.client,
      gh.repo,
      reviewedSha,
      pr.headSha,
    );
    if (
      driftCompare.status === "ok" &&
      driftCompare.compare.status === "ahead" &&
      driftCompare.compare.aheadBy > 0
    ) {
      revisionDrift = { aheadBy: driftCompare.compare.aheadBy, headSha: pr.headSha };
    }
  }
  const newPr: PrRef | null =
    pr && ownsAPr
      ? {
          number: pr.number,
          state: prState ?? pr.state,
          title: pr.title,
          ...(checks ? { checks } : {}),
          ...(review ? { review } : {}),
          ...(mergeable ? { mergeable } : {}),
          ...(revisionDrift ? { revisionDrift } : {}),
        }
      : (fm.pr ?? null); // keep last-known PR when lookup was refused/none

  const existingGithub: GithubCache | null = fm.github;
  // Commit association: `[KEY]`-prefixed commits on the branch. Agents don't
  // always follow the prefix convention, so an EMPTY filtered list must not
  // wipe a non-empty cache captured from the run workspace for this same
  // branch — keep what we honestly recorded rather than zeroing it.
  const prefixCommits = compare ? taskCommits(compare.commits, fm.key) : null;
  const existingCommits = existingGithub?.commits ?? [];
  const branchCommits =
    prefixCommits !== null && prefixCommits.length === 0 && existingCommits.length > 0
      ? existingCommits
      : prefixCommits;
  const newGithub: GithubCache | null =
    branchCommits !== null || pr?.changed || existingGithub || unownedPr
      ? {
          commits: branchCommits ?? existingCommits,
          changed: pr?.changed ?? existingGithub?.changed ?? null,
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
    ? `**Note:** accepted PR #${newPr!.number} was closed on GitHub without merging — the pending merge can no longer be completed from Viberr.`
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
      ? `**Note:** PR #${newPr!.number} was reopened on GitHub — ${fm.key}'s review is live again and the closed-PR block is lifted.`
      : `**Note:** PR #${newPr!.number} now tracks ${fm.key}'s branch on GitHub, replacing closed PR #${fm.pr!.number} — the closed-PR block is lifted.`
    : null;

  const changed =
    JSON.stringify({ pr: fm.pr, github: fm.github }) !==
    JSON.stringify({ pr: newPr, github: newGithub });

  if (changed) {
    const patch: Partial<TaskFrontmatter> = { pr: newPr, github: newGithub };
    // R8-6: surface a merged/closed-out-of-band divergence (typed event now, a
    // notification below). Never auto-advances the STAGE — a human closes the loop.
    const divergenceText = mergedButNotDone
      ? `**Divergence:** PR #${newPr!.number} was merged on GitHub, but ${fm.key} hasn't been accepted through Viberr — its stage is unchanged. Accept the completion (or move it to Done) so the task reflects the merge.`
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
    if (supersededRecs.length > 0) {
      const supersededIds = new Set(supersededRecs.map((r) => r.id));
      patch.recommendations = fm.recommendations.filter(
        (r) => !supersededIds.has(r.id),
      );
    }
    await patchTaskFrontmatter(ref, patch);
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
            ? `PR #${newPr!.number} merged on GitHub — accept ${fm.key}`
            : divergenceText
              ? `PR #${newPr!.number} closed on GitHub — ${fm.key} needs a decision`
              : acceptedClosedText
                ? `Accepted PR #${newPr!.number} closed on GitHub — ${fm.key}'s merge can't complete`
                : `PR #${newPr!.number} live again on GitHub — ${fm.key} resumes`,
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
      const { autoInvokeOperator } = await import(
        "~/server/tasks/task-actions.server"
      );
      void autoInvokeOperator(
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
  if (changed || !ctx.skipUnchangedProvenance)
  recordGithubProvenance(db, {
    absPath: resolveTaskFilePath(ref),
    dataRoot: ctx.dataRoot,
    action: "github.reconcile",
    details: {
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
    },
  });
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
    () => reconcileTaskUnlocked(db, input, actor, ctx),
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
}

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
  const gh = getProjectGithubContext(db, projectSlug, {
    ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
  });
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

  const rows = db
    .prepare(
      `SELECT task_key,
              (archived = 1
               OR COALESCE(json_extract(pr_json, '$.state'), '') = 'merged')
              AS terminal
       FROM task_projections
       WHERE project_slug = ? AND branch IS NOT NULL
       ORDER BY task_key ASC`,
    )
    .all(projectSlug) as { task_key: string; terminal: number }[];

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

  // Bounded worker pool, not Promise.all — see RECONCILE_TASK_CONCURRENCY.
  const results: TaskReconcileResult[] = new Array(selected.length);
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
    recordGithubProvenance(db, {
      absPath: resolveProjectFilePath({
        projectSlug,
        ...(ctx.dataRoot ? { dataRoot: ctx.dataRoot } : {}),
      }),
      ...(ctx.dataRoot ? { dataRoot: ctx.dataRoot } : {}),
      action: "github.reconcile",
      details: { repo: gh.repo, heartbeat: true, tasks: 0 },
    });
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

interface GhMergeResponse {
  merged: boolean;
  sha: string | null;
  message?: string;
}

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
  const gh = getProjectGithubContext(db, input.projectSlug, {
    ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
  });
  if (gh.status !== "ok") return gh;

  // F7-GH5: an agent that opened the PR via `gh pr create --draft` (or the
  // account default) leaves it a DRAFT, which GitHub refuses to merge (405
  // "Pull Request is still a draft") — acceptance then dead-ends with no fix.
  // A draft can only be cleared through GraphQL (`markPullRequestReadyForReview`,
  // REST can't unset `draft`), so mark it ready with the project PAT before the
  // merge. Best-effort: if the un-draft fails, the merge attempt below still
  // returns GitHub's own actionable message.
  const prView = await gh.client.request<{
    draft?: boolean;
    node_id?: string;
    mergeable?: boolean | null;
    mergeable_state?: string;
  }>("GET", `/repos/${gh.repo}/pulls/${prNumber}`);

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
        message: `PR #${prNumber} conflicts with \`${gh.defaultBranch}\` — rebase the branch, then merge.`,
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
      .request<unknown>("POST", `${GITHUB_API_BASE}/graphql`, {
        body: {
          query:
            "mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){clientMutationId}}",
          variables: { id: prView.data.node_id },
        },
      })
      .catch(() => undefined);
  }

  const merge = await gh.client.request<GhMergeResponse>(
    "PUT",
    `/repos/${gh.repo}/pulls/${prNumber}/merge`,
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
              ? `Branch \`${cleanup.branch}\` was already gone on GitHub — nothing left to clean up.`
              : cleanup.status === "refused"
                ? `Branch \`${cleanup.branch}\` was **not** deleted after the merge — ${cleanup.message}`
                : "The merged branch was **not** deleted — this project has no GitHub repo or credential configured.";
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

  const gh = getProjectGithubContext(db, input.projectSlug, {
    ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
  });
  if (gh.status !== "ok") return gh;

  if (branch === gh.defaultBranch) {
    return {
      status: "refused",
      branch,
      message: `\`${branch}\` is the project's default branch — Viberr never deletes it.`,
    };
  }
  if (fm.pr && (fm.pr.state === "review" || fm.pr.state === "accepted")) {
    return {
      status: "refused",
      branch,
      message: `PR #${fm.pr.number} is still open on \`${branch}\` — deleting the branch would silently close it. Close or merge the PR first.`,
    };
  }

  // B11: this interpolated the branch raw, so it was correct only for
  // `vib-142`-shaped names — a `#`, `?` or space addressed a different ref, or
  // none at all. Encoded PER SEGMENT because `heads/<branch>` is a path and a
  // branch may legitimately contain `/` (`feature/x`), which has to stay a
  // separator. For today's task-key branches this is byte-identical to what it
  // already sent, so the working path cannot regress.
  const refPath = encodeRefPath(`heads/${branch}`);
  const del = await gh.client.request<unknown>(
    "DELETE",
    `/repos/${gh.repo}/git/refs/${refPath}`,
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
