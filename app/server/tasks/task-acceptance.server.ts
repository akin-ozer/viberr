/**
 * Accepting a task's delivery (ruling 654): the acceptance gate every surface
 * reads (`acceptanceStanding`, `acceptanceRefusalFor`, the PR-head check and
 * the force-accept disclosure), the accept, force-accept and complete-merge
 * ceremonies that write it, and the acceptance-time branch refresh and merge
 * (`attemptAcceptanceMerge`, `refreshAndReview`).
 */

import { revisionDriftNote as sharedRevisionDriftNote } from "~/shared/revision-drift";
import { requiredReviewerRefusals, type RequiredReviewerView } from "./required-reviewers.server";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { isMissingCommitAnswer, isMissingRefAnswer } from "~/server/github/github-client.server";
import {
  acceptanceBlockedReason,
  activeWorkRevision,
  archivedTaskBlockedReason,
  closedPrBlockedReason,
  conflictingPrBlockedReason,
  deriveValidation,
  type PacketOption,
  reviewSubjectAuthor,
  type TaskFileEvent,
  type TaskFrontmatter,
  type TaskPacket,
  unpushedRevisionBlockedReason,
  type Validation,
} from "~/schemas/task-file.schema";
// Ruling 482: the gates' view and refusal, one pure home for every surface.
import { type GatesView, projectGatesRefusal, projectGatesView } from "~/shared/project-gates";
// R19-B: a LEAF module (zod + task-file types only), so the acceptance gate can
// consult the human GitHub approval synchronously without the dynamic-import
// dance the rest of the github/ surface needs to stay cycle-free.
import {
  humanVerdictApproval,
  humanVerdictNote,
  verdictGateReason,
} from "~/server/github/pr-human-approval.server";
import { roleCan } from "~/shared/rbac";
import { maybeContinueController } from "./controller-continuation.server";
import { maybeReleaseDependents } from "./dependencies.server";
import { canAcceptFromStage } from "~/shared/workflow/stage-roles";
import {
  type AuditEventInput,
  recordAudit,
  SYSTEM_ACTOR,
} from "~/server/audit/audit-recorder.server";
import {
  type AcceptanceNoChangeCheck,
  acceptanceNoChangeCheck,
  assertVerifiedNoChangeStillApplies,
  noChangeCompletionEvent,
  standingKbCorrections,
} from "./no-change-completion.server";
import { newId } from "~/shared/ids/new-id.server";
import { AppError } from "~/server/errors/app-error.server";
import { ERROR_CODES } from "~/server/errors/error-codes";
// OBS-11: R15-6's post-merge branch-cleanup switch. A leaf module (one
// projection read + the guardrail schema), so no dynamic import is needed.
import { branchCleanupOnMerge } from "~/server/github/branch-cleanup.server";
// Ruling 88 (F21-2): the acceptance disclosure contract — one definition the
// ceremony writes and the server reads (see the module's docblock).
import {
  type AcceptanceDisclosure,
  acceptanceDisclosureDrift,
} from "~/shared/acceptance-disclosure";
// Ruling 471: which open-decision option a direct acceptance answers — the one
// predicate the write below and the accept dialog's loader both read.
import { acceptanceAnswerOf } from "~/shared/packet-acceptance-answer";
import {
  appendPolicyNote,
  loadProjectContext,
  type ProjectContext,
  reprojectTask,
  summaryOrThrow,
  type TaskActor,
  type TaskMutationContext,
  taskRef,
} from "./task-mutation.server";
import { readTaskFile, updateTaskFile } from "~/server/files/task-writer.server";
import { maybeNoteEpicComplete } from "./epic-actions.server";
import {
  type ClosedDecision,
  followClosedDecision,
  markTaskPacketApprovalRead,
} from "~/server/projections/notifications.server";
import type { GithubActionContext } from "~/server/github/github-reconciler.server";
import type { GithubContextOptions } from "~/server/github/github-context.server";
import type { TaskSummary } from "~/shared/mapping/task.server";
import { logger } from "~/server/logging/logger.server";
import { errorMessage, toError } from "~/shared/errors";
import {
  autoInvokeOperator,
  humanActorRef,
  interruptLiveRunsOnClosure,
  OPERATOR_TASK_ACTOR,
  requireAcceptCompletion,
  requireAction,
  stageName,
  stageRolesOf,
  type TaskActionContext,
  terminalStageIdOf,
} from "./task-action-core.server";

/**
 * The outcome of the acceptance-time merge attempt (P14-LV-07).
 *
 * `pending` used to be the ONLY failure shape and it was rendered with one
 * hardcoded sentence — "no reachable GitHub merge — merge it manually or
 * reconcile once credentials are set" — which VM-4 showed to a human whose
 * GitHub was reachable, whose PAT was fine, and whose PR simply CONFLICTED. The
 * three shapes are now distinct: a merge that happened, a merge that CANNOT
 * happen (acceptance is refused — the task must not close on a merge that did
 * not run), and a merge that could not be REACHED (accepted, merge pending,
 * with the real cause named in the timeline).
 */
export type AcceptanceMergeOutcome =
  | { kind: "merged" }
  | { kind: "no_pr" }
  /** GitHub itself refuses this merge — a rework signal, not a pending state.
   *  `reason` is the refusal shown to whoever tried to accept; `cause` is the
   *  short form for the timeline of an admin who forced it through anyway. */
  | { kind: "unmergeable"; reason: string; cause: string }
  /** The merge could not be attempted/completed; `cause` names why, honestly. */
  | { kind: "pending"; cause: string };

/** The historical (and still correct) cause for an offline/unconfigured store. */
const UNREACHABLE_MERGE_CAUSE =
  "no reachable GitHub merge; merge it manually or reconcile once credentials are set";

/**
 * Ruling 162 / G35-5(d) (pass 35): the ONE base refresh of an acceptance.
 *
 * Runs the same workspace merge the operator's `update_branch_from_base`
 * performs, from the acceptance ceremony itself, immediately before the gate
 * re-check and the merge. Returns null when the merge may proceed (the branch
 * was refreshed, was already current, or could not be refreshed from here: no
 * workspace, no credential, a diverged origin, a git failure; GitHub stays the
 * authority on those) and an `unmergeable` outcome when the refresh met a
 * CONFLICT: the file then carries `pr.mergeable: conflicting`, so the gate
 * function prints the same sentence on every surface, and the timeline names
 * the conflicting paths so the resolver starts from the list, not a clean tree.
 */
async function refreshBranchForAcceptance(
  db: DatabaseSync,
  ctx: TaskActionContext,
  projectSlug: string,
  taskKey: string,
  actor: TaskActor,
): Promise<AcceptanceMergeOutcome | null> {
  return (await refreshBranchAsPerson(db, ctx, projectSlug, taskKey, actor, ACCEPTANCE_REFRESH))
    .outcome;
}

/** What a person's branch refresh is for, in the words its record uses. */
interface PersonRefreshPurpose {
  /** The refresh sentence's lead (`recordBranchRefresh`). */
  lead: string;
  /** What the conflict note says did not happen. */
  refused: string;
}

const ACCEPTANCE_REFRESH: PersonRefreshPurpose = {
  lead: "Accepting the completion brought",
  refused: "the acceptance was refused",
};

/**
 * A person's refresh of the task branch from its base: the acceptance
 * ceremony's, and ruling 449's "bring it up to date and re-review first".
 * Returns the refresh's own status (null when there was nothing to refresh)
 * and, on a conflict, the acceptance outcome that names it.
 */
async function refreshBranchAsPerson(
  db: DatabaseSync,
  ctx: TaskActionContext,
  projectSlug: string,
  taskKey: string,
  actor: TaskActor,
  purpose: PersonRefreshPurpose,
): Promise<{ status: string | null; outcome: AcceptanceMergeOutcome | null }> {
  const ref = taskRef(ctx, projectSlug, taskKey);
  const before = readTaskFile(ref)?.parsed.frontmatter ?? null;
  // Nothing to refresh without an open PR on a branch: no-change completions
  // and merged PRs never reach here with work to move.
  if (!before?.pr || !before.branch) return { status: null, outcome: null };
  if (before.pr.state !== "review" && before.pr.state !== "accepted") {
    return { status: null, outcome: null };
  }
  const updateBranch =
    ctx.deps?.updateBranchFromBase ??
    (await import("~/server/github/update-branch.server")).updateWorkspaceBranchFromBase;
  const input: Parameters<typeof updateBranch>[0] = { db, projectSlug, taskKey };
  if (ctx.dataRoot) input.dataRoot = ctx.dataRoot;
  const result = await updateBranch(input);
  const details: NonNullable<AuditEventInput["details"]> = { status: result.status };
  if (result.status === "updated") {
    details.commits = result.commits;
    details.mergeSha = result.mergeSha;
  }
  // Ruling 159(b): a refusal that names paths puts them on the record, whether
  // it was a merge conflict or the store layout the refresh will not publish.
  if (result.status === "conflict" || result.status === "store_layout") {
    details.files = result.files;
  }
  recordAudit(db, {
    action: "github.branch_update.acceptance",
    actor: { userId: actor.userId, label: actor.label },
    subjectKind: "branch",
    subjectId: before.branch,
    projectSlug,
    taskKey,
    details,
  });
  if (result.status === "updated") {
    const { recordBranchRefresh } = await import(
      "~/server/github/update-branch-operator.server"
    );
    const reconcileCtx: GithubActionContext = { dataRoot: ctx.dataRoot };
    if (ctx.fetchImpl) reconcileCtx.fetchImpl = ctx.fetchImpl;
    await recordBranchRefresh(db, reconcileCtx, { projectSlug, taskKey }, result, {
      timelineActor: humanActorRef(db, actor),
      reconcileActor: { userId: actor.userId, label: actor.label },
      lead: purpose.lead,
    });
    return { status: result.status, outcome: null };
  }
  if (result.status !== "conflict") return { status: result.status, outcome: null };
  await updateTaskFile(ref, (parsed) => {
    const pr = parsed.frontmatter.pr;
    if (pr && pr.number === before.pr!.number) pr.mergeable = "conflicting";
    parsed.timeline.unshift({
      occurredAt: new Date().toISOString(),
      type: "github",
      actor: humanActorRef(db, actor),
      title: null,
      text:
        `The acceptance-time refresh found \`${result.branch}\` in CONFLICT with \`${result.base}\`` +
        (result.files.length ? ` in ${result.files.join(", ")}` : "") +
        `. The merge was aborted, the branch is untouched and ${purpose.refused}.` +
        (result.detail ? `\n\n\`\`\`\n${result.detail}\n\`\`\`` : ""),
      toAgent: false,
      evidence: null,
    });
  });
  reprojectTask(db, ctx, projectSlug, taskKey);
  /**
   * Ruling 332: hand it to the operator. This refusal used to wake nobody.
   *
   * It stamps `pr.mergeable = "conflicting"`, writes a note, and returns a 409
   * — and that is all. No packet, no run, no notification. Meanwhile the
   * operator's byte-identical door (`update_branch_from_base` meeting the same
   * `conflict` status) opens a blocking decision packet whose recommended
   * option is the deliverer's own workspace merge.
   *
   * Two things make the silence worse than it looks. That stamp is exactly the
   * key to the operator's door — `acceptanceBoundaryRefusal` denies the branch
   * tool at the acceptance boundary EXCEPT while `mergeable === "conflicting"`
   * — so this path creates the one state in which the in-product resolver is
   * permitted and then schedules nothing. And because the flag is already set,
   * the reconciler's `flippedToConflict` can never fire afterwards, so ruling
   * 162(d)'s withdrawal of the standing `accept_completion` offer never runs:
   * the card invites a click its own gate refuses, for as long as the task
   * sits.
   *
   * Live, twice, and they are the two longest dead stops on the board. SHOP-12:
   * refused 08:06:45, then NOTHING for 10h45m while the board logged 8-66
   * events an hour elsewhere, until the owner typed "@operator SHOP-12 is the
   * last thing standing between this board and a runnable catalog service, and
   * it is stuck on me rather than on anyone doing work" — packet 28 seconds
   * later, and the operator's own reply: "It was never a click you were
   * withholding." SHOP-3: the same shape, 7h45m, same exit.
   *
   * Ruling 226's words sit sixty lines below this arm: "A refusal with no exit
   * is its own defect." Ruling 235 gave exactly this hand-off to the sibling
   * refusal (an unpushed reviewed revision) because only the operator may push;
   * the same is true of the merge, and this arm was left out.
   *
   * Fire-and-forget, like every other `autoInvokeOperator` caller: the person's
   * 409 is the answer to their click and must not wait on a coordination turn.
   */
  void autoInvokeOperator(db, ctx, projectSlug, taskKey, "pr-conflicting").catch(() => {});
  const after = readTaskFile(ref)?.parsed.frontmatter ?? null;
  const reason = after ? mergeReadinessRefusal(after, taskKey) : null;
  return { status: result.status, outcome: {
    kind: "unmergeable",
    reason:
      reason ??
      // Ruling 291: the same sentence as `conflictingPrBlockedReason`, and for
      // the same reason — the remedy viberr actually implements is a merge.
      `${taskKey}'s review PR #${before.pr.number} conflicts with the base branch. GitHub can't merge it, so it can't be accepted. Resolve the conflict on the branch by merging the base INTO it (never by rebasing, which rewrites commits the pull request already published), then re-review, or archive the task.`,
    // Ruling 291: the short cause, in the same voice as the long reason above.
    cause: "the PR conflicts with the base branch; merge the base into it, then merge",
  } };
}

/** Ruling 449: the refresh a person asks for before a re-review. */
const RE_REVIEW_REFRESH: PersonRefreshPurpose = {
  lead: "Asked for a re-review before accepting, brought",
  refused: "no re-review was started",
};

/** Ruling 449: the directive each re-run reviewer receives. */
function reReviewDirective(branch: string, base: string, mergeSha: string | null): string {
  return (
    `A person asked for a re-review before accepting. \`${branch}\` was brought up to date ` +
    `with \`${base}\`${mergeSha ? ` (merge commit \`${mergeSha.slice(0, 7)}\`)` : ""}, so the ` +
    "head that will merge is the reviewed work on the current base, and no review has run on " +
    "that combination. Run the gates on the head you are given and give your verdict on it."
  );
}

export interface RefreshAndReviewResult {
  /** `refreshed`: reviewers started · `current`: nothing to re-review ·
   *  `conflict`: the refresh met one · `unavailable`: it could not run. */
  status: "refreshed" | "current" | "conflict" | "unavailable";
  /** The reviewers whose re-review started, by display name. */
  reviewers: string[];
  message: string;
}

/**
 * Ruling 449 (O39-c; default, owner may revisit): "bring it up to date and
 * re-review first", the safe answer to U39-32's "N commits behind … No review
 * has run on that combination".
 *
 * Live on ax-clone, two green pull requests merged a minute apart left main
 * red. Each passed its gates and review on its own base; the acceptance
 * ceremony merged the newer base into the second and merged the result, a
 * head nobody had run. The owner's own method afterwards was to test the
 * merged combination in a container before accepting. This is that method as
 * one click: the branch is brought up to date as the person (the ceremony's
 * own refresh, `refreshBranchAsPerson`), and every reviewer whose verdict
 * stands on the revision re-reviews the refreshed head (ruling 439 keeps the
 * revision and moves the review subject to the chain's end). Acceptance then
 * merges the head the re-review ran on.
 */
export async function refreshAndReview(
  db: DatabaseSync,
  input: { projectSlug: string; taskKey: string },
  actor: TaskActor,
  ctx: TaskActionContext = {},
): Promise<RefreshAndReviewResult> {
  const project = loadProjectContext(ctx, input.projectSlug);
  const ref = taskRef(ctx, input.projectSlug, input.taskKey);
  const existing = readTaskFile(ref);
  if (!existing) throw AppError.notFound(`Task ${input.taskKey} not found.`);
  const fm = existing.parsed.frontmatter;
  requireAcceptCompletion(
    db,
    project,
    actor,
    fm.ownerUserId,
    "bring the branch up to date and re-review it before accepting",
  );
  const revision = activeWorkRevision(fm.workRevision);
  const reviewers = [
    ...new Set(
      fm.verdicts.filter((v) => revision && v.revisionId === revision.id).map((v) => v.profileId),
    ),
  ];
  if (reviewers.length === 0) {
    return {
      status: "unavailable",
      reviewers: [],
      message: `No reviewer's verdict stands on ${input.taskKey}'s delivered revision, so there is no review to run again. Nothing was changed.`,
    };
  }
  const { status, outcome } = await refreshBranchAsPerson(
    db,
    ctx,
    input.projectSlug,
    input.taskKey,
    actor,
    RE_REVIEW_REFRESH,
  );
  if (outcome?.kind === "unmergeable") {
    return { status: "conflict", reviewers: [], message: outcome.reason };
  }
  if (status === "already_current") {
    return {
      status: "current",
      reviewers: [],
      message: `\`${fm.branch}\` already carries the base branch, so the reviewed head merges as it is. Nothing was started.`,
    };
  }
  if (status !== "updated") {
    return {
      status: "unavailable",
      reviewers: [],
      message: `\`${fm.branch ?? input.taskKey}\` could not be brought up to date here (${status ?? "no open pull request"}). Nothing was started.`,
    };
  }
  const after = readTaskFile(ref)?.parsed.frontmatter ?? fm;
  const refresh = after.baseRefreshes.at(-1) ?? null;
  const base = refresh?.base ?? "the base branch";
  const directive = reReviewDirective(after.branch ?? "", base, refresh?.mergeSha ?? null);
  const startAgentRun =
    ctx.deps?.startAgentRun ?? (await import("./specialist-run.server")).startAgentRun;
  const opCtx: TaskActionContext = { ...ctx, operatorAuthorized: true };
  const started: string[] = [];
  const failed: string[] = [];
  for (const profileId of reviewers) {
    const name =
      after.engagements.find((e) => e.profileId === profileId)?.role ?? profileId;
    try {
      await startAgentRun(
        db,
        {
          projectSlug: input.projectSlug,
          taskKey: input.taskKey,
          profileId,
          directive,
          directiveFrom: actor.label,
        },
        OPERATOR_TASK_ACTOR,
        opCtx,
      );
      started.push(name);
    } catch (error) {
      failed.push(`${name} (${errorMessage(error)})`);
    }
  }
  const message =
    `Brought \`${after.branch}\` up to date with \`${base}\`` +
    (started.length ? `; re-review started: ${started.join(", ")}.` : ".") +
    (failed.length ? ` Could not start: ${failed.join("; ")}.` : "");
  return { status: "refreshed", reviewers: started, message };
}

/**
 * Attempt the REAL GitHub merge of the task's review PR (FR31, human-authorized)
 * and classify the outcome. Never throws: an unexpected failure degrades to
 * `pending` so acceptance still records honestly. Only meaningful for a human
 * actor.
 */
export async function attemptAcceptanceMerge(
  db: DatabaseSync,
  ctx: TaskActionContext,
  projectSlug: string,
  taskKey: string,
  actor: TaskActor,
  /** P14-GV-05: last check before the irreversible side effect. Runs AFTER the
   *  module import (an await of its own) and immediately before the merge call,
   *  which is the narrowest point the caller can still refuse from. Anything it
   *  throws propagates — it is a decision, not a GitHub failure. */
  beforeMerge?: () => void,
): Promise<AcceptanceMergeOutcome> {
  if (!actor.userId) return { kind: "pending", cause: UNREACHABLE_MERGE_CAUSE };
  try {
    const mergeTaskPr =
      ctx.deps?.mergeTaskPr ??
      (await import("~/server/github/github-reconciler.server")).mergeTaskPr;
    // Ruling 162 / G35-5(d) (pass 35): the base refresh happens ONCE, here, as
    // part of the acceptance ceremony. Live (19:35Z to 20:08Z) the operators
    // refreshed every open branch on every turn while fifteen PRs shared one
    // small repository, and each merge commit they pushed conflicted again
    // minutes later; six conflict packets in thirty minutes. The refresh now
    // runs when a person accepts: update the branch from base, re-run the
    // gate (`beforeMerge`), merge. A conflict found here refuses the acceptance
    // with the gate's own sentence and records `mergeable: conflicting` so
    // every surface says the same thing before the next click.
    // P14-GV-05, applied to the refresh: the refresh is itself an external,
    // irreversible publish (a workspace merge PUSHED to origin), so the
    // caller's last check runs BEFORE it as well as after. Without the first
    // call a packet replaced during the await, or a verdict that flipped to
    // request_changes, moved the PR head, re-triggered CI and wrote
    // "Accepting the completion brought ..." on the timeline, and only then
    // refused the acceptance. The callback is a pure throwing re-read, so
    // running it twice is safe; the second call is still needed because the
    // refresh changes the facts it reads.
    beforeMerge?.();
    const refresh = await refreshBranchForAcceptance(db, ctx, projectSlug, taskKey, actor);
    if (refresh) return refresh;
    beforeMerge?.();
    const mergeCtx: GithubActionContext = { dataRoot: ctx.dataRoot };
    if (ctx.fetchImpl) mergeCtx.fetchImpl = ctx.fetchImpl;
    const result = await mergeTaskPr(
      db,
      { projectSlug, taskKey },
      { userId: actor.userId, label: actor.label },
      mergeCtx,
    );
    switch (result.status) {
      case "merged":
        return { kind: "merged" };
      case "no_pr":
      case "task_not_found":
        return { kind: "no_pr" };
      case "not_mergeable": {
        // Ruling 162 (pass 35, F35-12 (a0)): the post-gate refusal reads the
        // SAME function the gate does. `mergeTaskPr` records what GitHub said
        // (`mergeable: conflicting`, on the 405 as well as on the detail read)
        // before answering, so the re-read file carries the fact and
        // `mergeReadinessRefusal` prints the gate's sentence with its way out.
        // Ruling 135 still ranks first inside it: when the delivered revision
        // never reached the PR, the push is the remedy, never "rebase".
        // A merge answer that names the conflict lands on the file HERE when the
        // merge path did not record it (the test seam, or a write that failed),
        // so the sentence below is the gate's own on every route.
        if (result.mergeable === "conflicting") {
          let recorded = false;
          await updateTaskFile(taskRef(ctx, projectSlug, taskKey), (parsed) => {
            const pr = parsed.frontmatter.pr;
            if (pr && pr.number === result.prNumber && pr.mergeable !== "conflicting") {
              pr.mergeable = "conflicting";
              recorded = true;
            }
          });
          if (recorded) reprojectTask(db, ctx, projectSlug, taskKey);
        }
        const fmNow = readTaskFile(taskRef(ctx, projectSlug, taskKey))?.parsed.frontmatter ?? null;
        const gateReason = fmNow ? mergeReadinessRefusal(fmNow, taskKey) : null;
        if (gateReason) {
          const unpushed =
            fmNow !== null &&
            unpushedRevisionBlockedReason(
              fmNow.pr,
              activeWorkRevision(fmNow.workRevision)?.headSha ?? null,
              taskKey,
            ) !== null;
          return {
            kind: "unmergeable",
            reason: gateReason,
            cause: unpushed
              ? "the delivered revision is not on the PR; deliver the branch to push it, then merge"
              // Ruling 291: never "rebase it" — see `conflictingPrBlockedReason`.
              : "the PR conflicts with the base branch; merge the base into it, then merge",
          };
        }
        return {
          kind: "unmergeable",
          reason: `GitHub refuses to merge ${taskKey}'s review PR #${result.prNumber}: ${result.message}`,
          cause: `GitHub refuses the merge: ${result.message}`,
        };
      }
      case "head_changed":
        return {
          kind: "unmergeable",
          reason: `PR #${result.prNumber}'s head changed on GitHub while it was being accepted. Re-review the new head, then accept. (${result.message})`,
          cause: "the PR head changed on GitHub; re-review the new head, then merge",
        };
      case "scope_violation":
        return {
          kind: "pending",
          cause:
            "the project credential is missing `pull_request:write`; grant the scope, then complete the merge",
        };
      case "auth_failed":
        return { kind: "pending", cause: "GitHub rejected the project credential" };
      case "no_pat_configured":
      case "no_repo_configured":
        return {
          kind: "pending",
          cause: "this project has no GitHub repo/credential configured",
        };
      case "pr_not_found":
        return {
          kind: "pending",
          cause: `GitHub no longer has PR #${result.prNumber}`,
        };
      default:
        return { kind: "pending", cause: "GitHub was unreachable" };
    }
  } catch (error) {
    // A refusal raised by `beforeMerge` is a governance decision, not a GitHub
    // outage — it must not degrade into "accepted, merge pending".
    if (error instanceof AppError) throw error;
    logger.warn("PR merge on acceptance failed", {
      taskKey,
      err: toError(error),
    });
    return { kind: "pending", cause: UNREACHABLE_MERGE_CAUSE };
  }
}

/**
 * P14-LV-02 — is Done a LEGAL next stage for where this task actually sits?
 *
 * Live-proven hole: VM-2 sat at Triage (no branch, no PR, no reviewer, no
 * verdict) and its operator recommended "Accept completion"; one click moved it
 * straight to Done. `acceptCompletion` checked reviewer verdicts, blocked
 * packets and closed PRs — and never once consulted the task's current stage,
 * the project's transition graph, or the `review → done` boundary the template
 * declares `human` + `locked`. Acceptance is the human authority AT that
 * boundary, so it may only be exercised FROM it: the resolved review stage, or
 * any stage with a declared workflow edge into the terminal one (a custom board
 * may have several). Everything else must walk the graph first — or take the
 * audited admin force-accept.
 */
function acceptanceStageBlockedReason(
  project: ProjectContext,
  fromStageId: string,
  taskKey: string,
): string | null {
  const roles = stageRolesOf(project);
  const terminalId =
    roles.terminalId ?? project.stages[project.stages.length - 1]?.id ?? null;
  // U36-12: the rule itself is `canAcceptFromStage` in the shared stage-roles
  // module, so the reconciler's divergence note asks the SAME question before
  // it tells a human to accept. Everything below is only how this caller says no.
  if (canAcceptFromStage(fromStageId, project.stages, project.workflow)) return null;
  const reviewName = roles.reviewId
    ? stageName(project, roles.reviewId)
    : "the review stage";
  // No force-accept suggestion here: the DG-2 override exists for a WEDGED
  // acceptance (a verdict that can no longer be recorded, a stale blocked
  // packet), and the task page only offers it for those. A task that simply
  // has not reached the boundary yet is not wedged — it has stages left to
  // cross — so naming an escape hatch that is neither offered nor appropriate
  // just sends the reader looking for a button that is not there.
  return `${taskKey} is at ${stageName(project, fromStageId)}, not ${reviewName}. A completion can only be accepted from the boundary the workflow puts before ${stageName(project, terminalId)}. Move the task through the workflow first.`;
}

/**
 * Every gate a human acceptance must clear, in one place (P14-LV-02).
 *
 * The three writers to Done each grew their own subset of these checks, which is
 * how the graph gate came to be missing from all of them. Returns the first
 * refusal reason or null. `blockedPacket` is passed by the caller because the
 * packet-resolution path is RESOLVING the very packet that would otherwise
 * block it.
 */
export function acceptanceRefusalReason(
  project: ProjectContext,
  fm: TaskFrontmatter,
  taskKey: string,
  opts: AcceptanceRefusalOptions,
): string | null {
  return acceptanceRefusalReasons(project, fm, taskKey, opts)[0] ?? null;
}

/** The caller-owned facts the acceptance gate stack cannot read from the file:
 *  whether the open blocked packet is the very one being resolved, and the
 *  live no-change probe when the caller already ran it. */
interface AcceptanceRefusalOptions {
  blockedPacket: boolean;
  noChange?: AcceptanceNoChangeCheck;
  /** Ruling 556: who made the review subject, read from the timeline. */
  subjectAuthor: string | null;
}

/**
 * U35-3 (pass 35): EVERY gate that stands, in the order the single-reason
 * helper above consults them. The force-accept dialog enumerates the skipped
 * stages, the review gate and the standing refusal from client state, while
 * the audit row recorded only the FIRST refusal sentence (KNC-10: the record
 * said a stage boundary was skipped and never that a failing verdict was
 * overridden). The force record now carries the same list the screen showed.
 */
function acceptanceRefusalReasons(
  project: ProjectContext,
  fm: TaskFrontmatter,
  taskKey: string,
  opts: AcceptanceRefusalOptions,
): string[] {
  const noChangeWorkRefusal: string | null =
    opts.noChange?.probe === "has_work" ? opts.noChange.probeRefusal ?? null : null;
  const gates: (string | null)[] = [
    // R14-3: an archived task is out of the flow entirely.
    archivedTaskBlockedReason(fm, taskKey),
    // R16-3 (owner ruling 2026-08-04): a TERMINAL GitHub fact outranks every
    // process gate below it. Live (H10): a task whose PR had been closed
    // unmerged carried a correct "PR #124 closed — choose a recovery path"
    // packet, and the acceptance box beside it read "no approving verdict yet —
    // run a review for a verdict, or an admin can force-accept". Both sentences
    // came from this function; the verdict gate simply matched first. Running a
    // review is not the path when the PR is gone, and neither is force-accept —
    // so the closed PR is named first and nothing below it can speak over it.
    closedPrBlockedReason(fm, taskKey),
    acceptanceStageBlockedReason(project, fm.stage, taskKey),
    // F10-15: every required reviewer must have approved the CURRENT revision.
    acceptanceBlockedReason(fm, opts.subjectAuthor),
    // Ruling 178 (pass 36, G36-3): the reviewers the PROJECT declares must have
    // approved it too, engaged or not. F10-15's set is emergent (whoever the
    // operator engaged), so a task whose operator never ran the project's
    // reviewer was acceptable on another agent's verdict. Same order in the
    // projection's `acceptanceBlockReason`.
    ...requiredReviewerRefusals(project.requiredReviewers, fm, opts.subjectAuthor),
    // R20-2 / F20-6: when the live probe already looked at the branch and found
    // WORK, its sentence wins — it names the branch and the commit count.
    // `verdictGateReason`'s "deliver the branch & open the PR" is right for a
    // branch with work and was catastrophically wrong for an EMPTY one (it
    // advised opening an empty PR); the has-work case now says how many commits.
    noChangeWorkRefusal,
    // R15-1: delivered work needs a healthy verdict on the delivered revision.
    // F28-L1: the R20-2 AUTO-DETECT — a probe that REALLY checked the branch and
    // found nothing to deliver (`branch_empty` or `no_branch`) — clears the "no
    // review pull request" gate for an unclaimed task, exactly like an explicit
    // `noChanges` claim. The `no_repo` basis is EXCLUDED: it verifies by the mere
    // absence of a repo (which keeps repo-less planning projects acceptable when
    // a human CLAIMED no-change via `fm.noChanges`), and must never AUTO-accept a
    // task carrying a delivered work revision it could not actually inspect.
    verdictGateReason(
      fm,
      deriveValidation(fm),
      taskKey,
      opts.noChange?.applies === true &&
        opts.noChange.refusal == null &&
        opts.noChange.verification?.basis !== "no_repo",
    ),
    // Ruling 482 (F40-52): the project's gates, run by Viberr on the revision
    // under review, must all have exited 0 there. Evidence that is missing,
    // stale or still running refuses too; force accept bypasses it on the
    // record like every gate here. Same position in the projection's
    // `acceptanceBlockReason`.
    projectGatesRefusal(project.gates, fm, taskKey),
    // F7-VAL1/F7-PKT1: an operator-raised blocked decision is still open —
    // accepting would bury it. Resolving the packet clears readiness.
    opts.blockedPacket
      ? "This task has an open blocked decision. Resolve the operator's packet before accepting it."
      : null,
    // Ruling 162 (pass 35, F35-12): the GitHub-fact half of the gate, ONE
    // function shared with the operator's Merge-entry check and the accept-time
    // merge failure, so the three cannot drift.
    mergeReadinessRefusal(fm, taskKey),
  ];
  return gates.filter((gate): gate is string => gate !== null);
}

/**
 * Ruling 162 (pass 35, F35-12): why the review pull request cannot be merged
 * as it stands, or null. The GitHub-fact half of the acceptance gate, kept as
 * ONE function because three surfaces read it: the acceptance refusal stack,
 * the operator's move INTO the acceptance stage (Merge means mergeable: a task
 * whose PR conflicts stays at the work stage where the conflict packet is the
 * path) and the post-gate merge failure (KNC-16: GitHub refused a merge the
 * cached `clean` had let through, and the second sentence for the same fact
 * had no way out).
 *
 * Ruling 135 (pass 34, F34-11): an unpushed delivered revision OUTRANKS the
 * conflict, whose `mergeable` describes the head GitHub has, not the one that
 * was reviewed; while it stands, the conflict sentence ("rebase") is not a
 * gate a person should be told about, on the force record or anywhere else.
 */
export function mergeReadinessRefusal(
  fm: Pick<TaskFrontmatter, "pr" | "workRevision">,
  taskKey: string,
): string | null {
  return (
    unpushedRevisionBlockedReason(
      fm.pr,
      activeWorkRevision(fm.workRevision)?.headSha ?? null,
      taskKey,
    ) ?? conflictingPrBlockedReason(fm, taskKey)
  );
}

/** What a force-accept bypasses, as the dialog enumerated it (U35-3). */
export interface ForceAcceptDisclosure {
  /** Every standing refusal sentence, in gate order; empty when acceptable. */
  gates: string[];
  /** Stage ids strictly between the task's stage and the terminal one, when
   *  the task is not at the acceptance boundary (R19-5: force may skip them). */
  skippedStageIds: string[];
  validation: Validation;
  /** The open decision packet the acceptance withdraws unanswered, by title.
   *  Null when there is none, and (ruling 471) when the forced acceptance
   *  ANSWERS it instead, because it offers `force_accept` or
   *  `accept_completion`. */
  withdrawnPacket: string | null;
}

/**
 * U35-3 (pass 35): ONE builder for the force record, read by the audit row and
 * by the forced `completion` event, so the timeline, the audit log and the
 * confirm dialog list the same bypasses. `gates` keeps every sentence the
 * single-reason gate would have picked first; `skippedStageIds` mirrors the
 * dialog's "Skips <stages>" row; `withdrawnPacket` its "Withdraws" row.
 */
function forceAcceptDisclosure(
  project: ProjectContext,
  parsed: { frontmatter: TaskFrontmatter; packet: TaskPacket | null; timeline: readonly TaskFileEvent[] },
  taskKey: string,
  opts: { noChange?: AcceptanceNoChangeCheck } = {},
): ForceAcceptDisclosure {
  const fm = parsed.frontmatter;
  const refusalOpts: AcceptanceRefusalOptions = {
    blockedPacket: fm.readiness === "blocked" && parsed.packet?.type === "blocked",
    subjectAuthor: reviewSubjectAuthor(fm, parsed.timeline),
  };
  if (opts.noChange) refusalOpts.noChange = opts.noChange;
  const gates = acceptanceRefusalReasons(project, fm, taskKey, refusalOpts);
  const terminalId = terminalStageIdOf(project);
  const stageIndex = project.stages.findIndex((s) => s.id === fm.stage);
  const atBoundary = acceptanceStageBlockedReason(project, fm.stage, taskKey) === null;
  const skippedStageIds =
    !atBoundary && stageIndex >= 0 && terminalId !== null
      ? project.stages
          .slice(stageIndex + 1)
          .map((s) => s.id)
          .filter((id) => id !== terminalId)
      : [];
  return {
    gates,
    skippedStageIds,
    validation: deriveValidation(fm),
    // Ruling 471: a decision this force answers is not withdrawn, so neither
    // the forced completion event nor the `task.acceptance.forced` row may say
    // it died unanswered.
    withdrawnPacket:
      parsed.packet && !acceptanceAnswerOf(parsed.packet, "force")
        ? parsed.packet.title
        : null,
  };
}

/**
 * A gate's own words, without its remedy. The gates are multi-sentence
 * REFUSALS ("… not Review. A completion can only be accepted from the boundary
 * the workflow puts before Done. Move the task through the workflow first."),
 * written for someone deciding whether to accept. Spliced whole into the
 * bypass list they produced `.;` seams and three imperatives telling the reader
 * to do things the acceptance had just made impossible. The audit panel already
 * ruled on this shape (`activity-feed.server.ts`, `task.acceptance.forced`:
 * "the reader is looking at a record of an override that already happened"), so
 * the clause takes the same first sentence; `details.bypassedGates` keeps every
 * sentence for a reader that wants the remedy text.
 */
function gateClaim(gate: string): string {
  return gate.split(/(?<=\.)\s/)[0]!.replace(/\.$/, "");
}

/** The clause the forced `completion` event appends (U35-3). Empty when the
 *  force bypassed nothing. */
function forceBypassClause(project: ProjectContext, disclosure: ForceAcceptDisclosure): string {
  const parts: string[] = [];
  if (disclosure.skippedStageIds.length > 0) {
    parts.push(
      `${disclosure.skippedStageIds.map((id) => stageName(project, id)).join(" to ")} skipped`,
    );
    parts.push("the review gate");
  }
  parts.push(...disclosure.gates.map(gateClaim));
  if (disclosure.withdrawnPacket) {
    parts.push(`the open decision "${disclosure.withdrawnPacket}" withdrawn unanswered`);
  }
  // Ruling 471: the list ends its sentence, because the answered-decision
  // clause `applyAcceptanceWrite` may append starts a new one.
  return parts.length > 0 ? ` Bypassed: ${parts.join("; ")}.` : "";
}

/**
 * R16-3 — is acceptance blocked by a TERMINAL GitHub fact rather than a process
 * gate? A closed, unmerged PR is not something a verdict, a stage move or an
 * admin override can fix: the work has no pull request to merge. Force-accept
 * exists for a WEDGED gate (a verdict that can no longer be recorded, a stale
 * packet) — offering it here would move the task to Done over a rejection and
 * stamp `pr.state: accepted` on a PR GitHub has already closed.
 *
 * The predicate is server-side so the rail cannot re-derive it differently, and
 * separate from the refusal SENTENCE so the two can never disagree.
 */
export function acceptanceTerminallyBlocked(fm: TaskFrontmatter): boolean {
  return fm.pr?.state === "closed";
}

/**
 * F19-25 (pass 19) — the ONE gate the audited admin FORCE-accept may NOT
 * bypass, or null when a forced acceptance is legal.
 *
 * `force` is the DG-2 override for a WEDGED process gate: a verdict that can no
 * longer be recorded, a stale blocked packet, a conflicting PR a maintainer
 * accepts as merge-pending. It was implemented as "skip `acceptanceRefusalReason`
 * entirely", which handed it one power nobody ruled on: **a terminal GitHub
 * fact** (R16-3, ruling 37). A PR closed unmerged has nothing to merge, so
 * forcing it stamped `pr.state: accepted` on a PR GitHub had already closed and
 * moved the task to Done over a rejection — verbatim the harm ruling 37 names.
 * The withdrawal shipped CLIENT-side only (the task page hides the button), so
 * every non-UI caller — and any UI state the client had not refreshed — still
 * wrote it. That is what this function refuses.
 *
 * **R19-5 (owner ruling 2026-08-06): the WORKFLOW GRAPH is deliberately NOT
 * here.** A pass-19 implementer added a second arm refusing an off-boundary
 * force-accept ("move the task to the boundary first"); the owner reverted it.
 * Force-accept MAY skip the remaining stages AND the review gate — that is what
 * the override is for. The burden it carries is HONESTY, not refusal: the
 * affordance says it skips them and the confirm dialog enumerates exactly which
 * stages are being skipped (`accept-confirm.tsx`). A server 409 here would have
 * turned the one escape hatch for a wedged board into another wall.
 *
 * Everything else `acceptanceRefusalReason` returns stays force-bypassable.
 */
export function forceIrreducibleRefusal(
  fm: TaskFrontmatter,
  taskKey: string,
): string | null {
  const closed = closedPrBlockedReason(fm, taskKey);
  if (closed) {
    return (
      `${closed} Force-accept cannot override that: it exists for a wedged review gate, ` +
      `not for a pull request GitHub has already closed.`
    );
  }
  // Ruling 123: the archive is the second thing force may not jump. Everywhere
  // else archive is terminal — `transitionStage` refuses an archived task with a
  // 409 and the lifecycle doc says "an archived task cannot be moved" — but
  // `force` skips the shared refusal helper that holds the archived gate, so an
  // admin could accept an archived task straight to Done and leave it both
  // archived AND accepted (pass 33, F33-6, proven live on SBX-1). The confirm
  // dialog already told them to restore it first; this makes that sentence true.
  const archived = archivedTaskBlockedReason(fm, taskKey);
  if (archived) {
    return (
      `${archived} Force-accept cannot override that: restore the task first, then ` +
      `accept it. Force exists for a wedged review gate, not for a disposition a ` +
      `human already made.`
    );
  }
  return null;
}

/**
 * One head verification, and the exact (PR, revision) pair it was performed
 * against (A2).
 *
 * The check is a live network read, so it cannot run inside the write lock. The
 * pair is what makes it safe anyway: every Done writer re-asserts, under the
 * lock, that the state it is about to close is still the state that was
 * verified (`assertVerifiedHeadStillApplies`). A PR or revision that changed
 * during the await refuses instead of riding a stale verification through.
 */
export interface AcceptancePrHeadCheck {
  /** The refusal sentence, or null when the head is verified or unverifiable
   *  in a way that cannot reach the base branch (see `verification`). */
  refusal: string | null;
  /**
   * A9 (pass 23): WHY `refusal` is null — the two cases used to be
   * indistinguishable. `verified` = a live read confirmed the PR head contains
   * the delivered revision. `unverifiable` = the check could not run (GitHub
   * unreachable, the PR read or compare failed). `not-applicable` = nothing to
   * verify (no PR, no revision, or the PR is already merged).
   *
   * Ruling 226 amends what `unverifiable` permits. A9 allowed it through on the
   * reasoning that "the merge's own honesty covers unreachability" — true when
   * GitHub is unreachable, because then the merge fails too. It is false in the
   * one case where GitHub answered the pull request and refused only the
   * comparison: the repository is reachable, the merge will succeed, and the
   * containment check simply did not run. That case now carries a `refusal` and
   * a `liveHeadSha`; the rest still pass with the A9 disclosure on the record.
   */
  verification: "verified" | "unverifiable" | "not-applicable";
  prNumber: number | null;
  revisionHeadSha: string | null;
  /**
   * Ruling 226: the head GitHub reported for the PR, when it reported one.
   * Present only on the refusing `unverifiable` case — the packet that offers
   * the way out names both SHAs, and the waiver that takes it is pinned to this
   * exact head so it cannot be spent on a different one.
   */
  liveHeadSha: string | null;
}

/** The timeline title ruling 235's record carries, and the idempotence key. */
const UNPUSHED_HEAD_TITLE = "Acceptance refused: the reviewed revision is not on the pull request";

/**
 * Ruling 235 (F37-55) — record a refused acceptance whose cause is a KNOWN head
 * mismatch, and hand the delivery to the operator.
 *
 * Measured live: SHOP-2's two required reviewers approved `ea5f2ffd7493`, PR #13's
 * head was `913ce9d`, and pressing Accept refused with an exact sentence naming
 * both. That sentence went to one browser's toast and nowhere else — no audit
 * row, no timeline event, nothing in `task.md`. The person then pressed "Run
 * operator" to get the branch pushed; the operator re-anchored on a file that
 * said nothing about any refusal and filed the SAME acceptance recommendation
 * again. Accept, refuse, run operator, be re-recommended the same accept.
 *
 * Idempotent by note text, like `noteDeadDependency`: pressing Accept five times
 * writes one note and hands off once, because the second press finds its own
 * sentence already newest and does neither again.
 */
async function recordUnpushedHeadRefusal(
  db: DatabaseSync,
  ctx: TaskActionContext,
  projectSlug: string,
  taskKey: string,
  check: AcceptancePrHeadCheck,
  refusal: string,
): Promise<void> {
  try {
    // The TITLE already says "Acceptance refused"; the renderer prints both, so
    // a prefix here reads as "Acceptance refused: ... Acceptance refused: ...".
    // Seen on the live Activity feed the first time this row rendered.
    const text = refusal;
    const existing = readTaskFile(taskRef(ctx, projectSlug, taskKey));
    const newest = existing?.parsed.timeline.find(
      (e) => e.type === "github" && e.title === UNPUSHED_HEAD_TITLE,
    );
    // Already on the record for this exact pair: say nothing and, crucially,
    // do not start another paid operator run for a button pressed twice.
    if (newest?.text === text) return;
    await updateTaskFile(taskRef(ctx, projectSlug, taskKey), (parsed) => {
      parsed.timeline.unshift({
        occurredAt: new Date().toISOString(),
        type: "github",
        actor: { kind: "system", systemId: "policy-engine" },
        title: UNPUSHED_HEAD_TITLE,
        text,
        toAgent: false,
        evidence: null,
      });
    });
    reprojectTask(db, ctx, projectSlug, taskKey);
    recordAudit(db, {
      action: "task.acceptance.head_unpushed",
      actor: SYSTEM_ACTOR,
      subjectKind: "task",
      subjectId: taskKey,
      projectSlug,
      taskKey,
      details: {
        prNumber: check.prNumber,
        revisionHeadSha: check.revisionHeadSha,
        liveHeadSha: check.liveHeadSha,
      },
    });
    // Fire-and-forget, like every other operator hand-off in this module: the
    // refusal is the caller's answer and must not wait on a paid run, nor be
    // turned into a 500 by one that fails.
    void autoInvokeOperator(db, ctx, projectSlug, taskKey, "head-unpushed").catch((error) => {
      logger.error("head-unpushed operator handoff failed", {
        taskKey,
        err: toError(error),
      });
    });
  } catch (error) {
    // The refusal is the point; failing to record it must not turn a refused
    // acceptance into a thrown-away one.
    logger.warn("could not record the unpushed-head acceptance refusal", {
      taskKey,
      err: toError(error),
    });
  }
}

/**
 * Ruling 226 (F37-43): refuse the acceptance AND leave the human a way forward.
 *
 * A refusal with no exit is its own defect, and this one could otherwise strand
 * a task permanently — the cause is GitHub declining a comparison, which no
 * amount of re-delivering necessarily fixes. So the gate does not just throw a
 * sentence into a toast: it records the question on the task, with both shas in
 * it, and the three real answers.
 *
 * Written from the ONE gate all four Done writers share, so the packet appears
 * whichever door was tried. Never clobbers an open decision (one packet slot per
 * task), and never re-writes itself while its own packet is standing — a human
 * pressing Accept twice gets one question, not two.
 */
export async function refuseUnverifiedHead(
  db: DatabaseSync,
  ctx: TaskActionContext,
  projectSlug: string,
  taskKey: string,
  check: AcceptancePrHeadCheck,
): Promise<never> {
  const refusal = check.refusal ?? "";
  // Ruling 235 (F37-55): a KNOWN mismatch is not a decision. The reviewed
  // revision simply is not on the pull request, the only remedy is to push it,
  // and ruling 134 reserves pushing for the operator — so there is nothing to
  // ask a person. It gets a record and a hand-off instead of a packet; only the
  // UNVERIFIABLE case (ruling 226), where a maintainer really must choose
  // between re-delivering and merging unchecked, opens one.
  if (
    check.verification !== "unverifiable" &&
    check.liveHeadSha &&
    check.prNumber !== null &&
    check.revisionHeadSha
  ) {
    await recordUnpushedHeadRefusal(db, ctx, projectSlug, taskKey, check, refusal);
    throw AppError.conflict(refusal);
  }
  if (check.liveHeadSha && check.prNumber !== null && check.revisionHeadSha) {
    try {
      await updateTaskFile(taskRef(ctx, projectSlug, taskKey), (parsed) => {
        if (parsed.packet) return;
        const head = check.liveHeadSha!.slice(0, 7);
        const delivered = check.revisionHeadSha!.slice(0, 7);
        parsed.packet = {
          id: newId("pkt"),
          type: "blocked",
          kind: "Blocked decision",
          from: "policy-engine",
          title: `PR #${check.prNumber}'s head could not be checked before merging`,
          body:
            `Press Accept again to re-run the check; this decision does not block it.\n\n` +
            `GitHub answered the pull request and then refused to compare its head ` +
            `\`${head}\` against the delivered revision \`${delivered}\` that your reviewers ` +
            `were pinned to.\n\nThe repository is reachable, so the merge itself would ` +
            `succeed. What is unknown is WHAT would be merged: if the PR carries something ` +
            `other than the reviewed revision, accepting puts code no reviewer approved on ` +
            `the base branch. That is not hypothetical: it is how SHOP-17 merged a revision ` +
            `its Code Reviewer had rejected.`,
          observations: [],
          // Two options, and deliberately NOT a third "try the check again".
          // That one would have to be a `custom`, whose resolution sends the
          // task back to the agent side and re-queues the operator — which
          // would re-run this very gate, refuse again, and open this very
          // packet again. Answering the decision would re-create it, which is
          // ruling 224's fourth half repeating. Re-checking needs no option at
          // all: this packet does not block acceptance, so pressing Accept is
          // the re-check, and a successful acceptance withdraws the packet on
          // its own.
          options: [
            {
              kind: "request_edit",
              t: "Send it back to be re-delivered",
              d:
                "Returns the task for rework so the branch is pushed again from the " +
                "workspace. Use this when you suspect the remote branch is not what was " +
                "reviewed. To simply re-run the check instead, press Accept again: a " +
                "refused comparison is usually transient, and this decision does not " +
                "block the acceptance.",
              rec: true,
            },
            {
              kind: "accept_unverified_head",
              t: "Merge it anyway, without the check",
              d:
                `Records, with your name on it, that PR #${check.prNumber} may be merged at ` +
                `head \`${head}\` without confirming it contains \`${delivered}\`. Then press ` +
                `Accept again: the merge stays your act, not a side effect of answering this. ` +
                `It applies to this head only, so if the branch moves the check is required ` +
                `again. Code no reviewer approved may reach the base branch.`,
              rec: false,
            },
          ],
        };
        parsed.frontmatter.waiting = "human";
        parsed.timeline.unshift({
          occurredAt: new Date().toISOString(),
          type: "blocked",
          actor: { kind: "system", systemId: "policy-engine" },
          title: `PR #${check.prNumber}'s head could not be checked before merging`,
          text: `**Acceptance refused:** ${refusal}`,
          toAgent: false,
          evidence: null,
        });
      });
      // `updateTaskFile` writes the file and nothing else — every other writer
      // in this module reprojects after it, and a packet that exists only in
      // the markdown is one the board does not show until the watcher happens
      // to notice. The person is being told, in the same breath, that a
      // decision is waiting for them.
      reprojectTask(db, ctx, projectSlug, taskKey);
    } catch (error) {
      // The refusal is the point; failing to RECORD it must not turn a refused
      // merge into a thrown-away one. Log and refuse anyway.
      logger.warn("could not record the unverified-head decision packet", {
        taskKey,
        err: toError(error),
      });
    }
  }
  throw AppError.conflict(refusal);
}

/**
 * R15-1 gate 2 (F15-15): the PR head must CONTAIN the delivered revision, or
 * the acceptance would merge content the delivery never produced (the live
 * failure: a PR opened over stale remote junk, approved from the local tree).
 * A live GitHub read; `refusal: null` when it cannot be verified (offline / no
 * PR / no revision / PR already merged) — the merge attempt's own honesty
 * covers those.
 *
 * This is the ONE acceptance gate force-accept can never bypass — and, since
 * A2, the one every Done writer runs: it used to be called by two of the four,
 * so a full-autonomy operator accept followed by a human "Complete merge"
 * merged a stale-head PR through the two doors that skipped it.
 */
export async function acceptancePrHeadCheck(
  db: DatabaseSync,
  ctx: TaskActionContext,
  projectSlug: string,
  taskKey: string,
): Promise<AcceptancePrHeadCheck> {
  const file = readTaskFile(taskRef(ctx, projectSlug, taskKey));
  const fm = file?.parsed.frontmatter;
  const verdict = await evaluateAcceptancePrHead(db, ctx, projectSlug, taskKey);
  return {
    refusal: verdict.refusal,
    verification: verdict.verification,
    prNumber: fm?.pr?.number ?? null,
    revisionHeadSha: activeWorkRevision(fm?.workRevision)?.headSha ?? null,
    liveHeadSha: verdict.liveHeadSha ?? null,
  };
}

/**
 * The in-lock half of the head gate (A2). The verification above is bound to
 * one (PR, revision) pair; if the task no longer carries that pair, the write
 * is closing over something nobody verified — refuse rather than proceed.
 * `force` does not relax this: it is the head gate, not a process gate.
 */
export function assertVerifiedHeadStillApplies(
  fm: TaskFrontmatter,
  check: AcceptancePrHeadCheck,
  taskKey: string,
): void {
  const prNumber = fm.pr?.number ?? null;
  const revisionHeadSha = activeWorkRevision(fm.workRevision)?.headSha ?? null;
  if (prNumber === check.prNumber && revisionHeadSha === check.revisionHeadSha) {
    return;
  }
  throw AppError.conflict(
    `${taskKey}'s pull request or delivered revision changed while the acceptance was being ` +
      `verified. The PR head was never checked against what would be closed now. Refresh the ` +
      `task and accept again.`,
  );
}

/** The one field this check reads off GitHub's pull JSON — `null` when the
 *  body doesn't carry it (treated as unknown below, never a refusal). */
const pullHeadShaSchema = z
  .object({ head: z.object({ sha: z.string().min(1) }) })
  .nullable()
  .catch(null);

/** `GET /compare/…` — only `status` is read; a body that doesn't carry a
 *  string one degrades to "no status", exactly as the raw read did. */
const compareStatusSchema = z.object({ status: z.string().optional() }).catch({});
/** Ruling 135: the one field the never-pushed probe reads. */
const commitShaSchema = z.object({ sha: z.string() }).loose();

/**
 * The one live PR-head evaluation, reporting BOTH the refusal (a KNOWN mismatch)
 * and WHY a null refusal is null — `verified` (containment confirmed) vs
 * `unverifiable` (the check could not run) vs `not-applicable` (nothing to
 * verify). A9 split these apart so the acceptance record can disclose an
 * unverified head instead of reading like a verified one. Never throws.
 */
async function evaluateAcceptancePrHead(
  db: DatabaseSync,
  ctx: TaskActionContext,
  projectSlug: string,
  taskKey: string,
): Promise<{
  refusal: string | null;
  verification: "verified" | "unverifiable" | "not-applicable";
  /** Ruling 226: the live PR head, when GitHub reported one. */
  liveHeadSha?: string | null;
}> {
  try {
    const file = readTaskFile(taskRef(ctx, projectSlug, taskKey));
    const fm = file?.parsed.frontmatter;
    const pr = fm?.pr ?? null;
    const rev = activeWorkRevision(fm?.workRevision);
    if (!pr || !rev || pr.state === "merged") {
      return { refusal: null, verification: "not-applicable" };
    }
    const { getProjectGithubContext } = await import(
      "~/server/github/github-context.server"
    );
    // Optional key: set only when a caller supplied a transport (tests).
    const ghOptions: GithubContextOptions = {};
    if (ctx.fetchImpl) ghOptions.fetchImpl = ctx.fetchImpl;
    const gh = getProjectGithubContext(db, projectSlug, ghOptions);
    if (gh.status !== "ok") {
      return { refusal: null, verification: "unverifiable" };
    }
    const live = await gh.client.request(
      "GET",
      `/repos/${gh.repo}/pulls/${pr.number}`,
      pullHeadShaSchema,
    );
    if (!live.ok || !live.data) {
      return { refusal: null, verification: "unverifiable" };
    }
    const headSha = live.data.head.sha;
    if (headSha === rev.headSha) {
      return { refusal: null, verification: "verified" };
    }
    // Not identical — a head that CONTAINS the delivered commit (e.g. the
    // delivery plus an auto-commit) is still reviewing the delivered work.
    const cmp = await gh.client.request(
      "GET",
      `/repos/${gh.repo}/compare/${rev.headSha}...${headSha}`,
      compareStatusSchema,
    );
    if (!cmp.ok) {
      // Ruling 135: the compare's base is the LOCAL delivered sha, so a 404
      // is what a never-pushed revision looks like. One direct commit read
      // confirms it, and that is a KNOWN mismatch, not an unverifiable head.
      if (isMissingRefAnswer(cmp)) {
        const probe = await gh.client.request(
          "GET",
          `/repos/${gh.repo}/commits/${rev.headSha}`,
          commitShaSchema,
        );
        // Ruling 223: the COMMIT read's own vocabulary — GitHub answers a
        // well-formed but unknown 40-char SHA with 422 "No commit found for
        // SHA", never 404, so `isMissingRefAnswer` here confirmed nothing and
        // this refusal was unreachable on the real API.
        if (!probe.ok && isMissingCommitAnswer(probe)) {
          return {
            refusal:
              `${taskKey}'s delivered revision \`${rev.headSha.slice(0, 7)}\` is not on GitHub: ` +
              `PR #${pr.number}'s head is \`${headSha.slice(0, 7)}\`. Deliver the branch to push it; ` +
              `it cannot be accepted until the PR carries the reviewed revision.`,
            verification: "verified",
            // Ruling 235 (F37-55): the live head travels with the refusal so the
            // recorder below can write what was refused and why. Without it
            // `refuseUnverifiedHead`'s guard saw a null and recorded NOTHING —
            // the refusal reached one browser's toast and never the task file,
            // so the operator (the only actor allowed to push) could not learn
            // it and re-filed the same acceptance recommendation.
            liveHeadSha: headSha,
          };
        }
      }
      // Ruling 226 (F37-43's surviving half): GitHub ANSWERED the pull request
      // and then would not answer the comparison. Both SHAs are in hand, the
      // repository is reachable, and the merge that follows this check would
      // therefore succeed — so "unknown" here is not the offline case A9's
      // disclosure was written for. It is the case where viberr is about to
      // merge a head it cannot tell apart from one its reviewers rejected,
      // which is what it did to SHOP-17 live: two reviewers approved
      // `1f99f68`, that revision was never pushed, and PR #12 merged at
      // `9104562` with a note saying only that the head "could not be
      // verified".
      //
      // So it refuses, and the sentence names the consequence rather than the
      // check. The way out is the packet the refused acceptance opens
      // (`unverified_head`), where a maintainer can re-check, send the branch
      // back, or take the merge deliberately with their name on it.
      // The waiver a maintainer granted for exactly this triple (ruling 226).
      // Re-read live, never trusted from the moment it was written: the head
      // below is what GitHub reports NOW, so a branch that moved after the
      // waiver no longer matches and the refusal returns.
      const waiver = fm?.headCheckWaiver ?? null;
      if (
        waiver &&
        waiver.prNumber === pr.number &&
        waiver.revisionHeadSha === rev.headSha &&
        waiver.liveHeadSha === headSha
      ) {
        return { refusal: null, verification: "unverifiable", liveHeadSha: headSha };
      }
      return {
        refusal:
          `PR #${pr.number}'s head (${headSha.slice(0, 7)}) could not be checked against the ` +
          `delivered revision ${rev.headSha.slice(0, 7)}: GitHub answered the pull request and ` +
          `then refused the comparison. Accepting now would merge without knowing whether the ` +
          `PR carries the revision your reviewers approved, so code no reviewer approved could ` +
          `reach the base branch. Re-check it, or re-deliver the branch.`,
        verification: "unverifiable",
        liveHeadSha: headSha,
      };
    }
    if (cmp.data.status === "ahead" || cmp.data.status === "identical") {
      return { refusal: null, verification: "verified" };
    }
    return {
      refusal:
        `PR #${pr.number}'s head (${headSha.slice(0, 7)}) does not contain the delivered ` +
        `revision ${rev.headSha.slice(0, 7)}: the PR carries different content than was ` +
        `delivered. Re-deliver the branch (or fix the remote branch), then re-review.`,
      verification: "verified",
    };
  } catch (error) {
    logger.warn("PR-head verification failed (treated as unknown)", {
      taskKey,
      err: toError(error),
    });
    return { refusal: null, verification: "unverifiable" };
  }
}

/**
 * The acceptance refusal for a task by key, or null when it could be accepted
 * right now (P14-LV-02). The entry point for the writers that live OUTSIDE this
 * module — the operator's own acceptance path and its `accept_completion`
 * recommendation — so every proposer and writer reads the same gate as the two
 * human paths do. Returns null for an unreadable project/task; the caller's own
 * notFound handling owns that case.
 */
export function acceptanceRefusalFor(
  input: { projectSlug: string; taskKey: string },
  ctx: TaskMutationContext = {},
  // F28-L1: the SYNC display callers (the acceptance affordance) can't run the
  // live probe, so they pass nothing and stay conservative — an unclaimed-empty
  // task reads "not ready" until accept time proves it empty (safe direction).
  // A RUNTIME caller that HAS run the probe (operatorAcceptCompletion) passes it
  // so a verified-empty completion isn't refused "no review pull request".
  noChange?: AcceptanceNoChangeCheck,
): string | null {
  let project: ProjectContext;
  try {
    project = loadProjectContext(ctx, input.projectSlug);
  } catch {
    return null;
  }
  const existing = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  if (!existing) return null;
  return acceptanceRefusalReason(
    project,
    existing.parsed.frontmatter,
    input.taskKey,
    {
      blockedPacket:
        existing.parsed.frontmatter.readiness === "blocked" &&
        existing.parsed.packet?.type === "blocked",
      noChange,
      subjectAuthor: reviewSubjectAuthor(existing.parsed.frontmatter, existing.parsed.timeline),
    },
  );
}

/** What a viewer may do about accepting ONE task, right now (P14-LV-06). */
export interface AcceptanceAffordance {
  /** The viewer holds acceptance authority here: maintainer+ or the task owner. */
  hasAuthority: boolean;
  /** The task sits where a completion CAN be accepted from (the review boundary). */
  atBoundary: boolean;
  /** null when acceptance would succeed right now; else the exact refusal. */
  blockedReason: string | null;
  /**
   * Ruling 393 (F39-20): EVERY standing refusal, in gate order — what a
   * force-accept would bypass, whole.
   *
   * `blockedReason` is the first one, which is right for the one-line "Not
   * acceptable yet" summary and wrong for the force dialog: U35-3 made the
   * audit row and the forced completion event name every gate precisely so the
   * record could not under-report an override, and its own docstring says "the
   * timeline, the audit log and the confirm dialog list the same bypasses" —
   * but the dialog only ever received the first. Live on ax-clone AX-12 a human
   * confirmed "Bypassing: Waiting on 1 required reviewer approval of the
   * current revision." and the audit row recorded that gate AND the project's
   * required-reviewer rule.
   */
  blockedGates: string[];
  /**
   * F19-7: the refusal a PACKET `accept_completion` resolution would hit.
   *
   * `resolvePacket` evaluates the same contract with `blockedPacket: false` —
   * the open packet IS what the resolution clears, so it cannot also be the
   * reason to refuse it. A packet's confirm must therefore name THIS refusal,
   * never `blockedReason`, or it would warn about a block the server is not
   * going to apply (or, worse, stay silent about one it will).
   */
  blockedReasonViaPacket: string | null;
  /** Render an acceptance control iff true. */
  canAccept: boolean;
  /** R16-3: the blocker is a terminal GitHub fact (a closed, unmerged PR), not a
   *  process gate — so no override may be offered against it. */
  terminallyBlocked: boolean;
  /**
   * R19-B — when the R15-1 verdict gate is satisfied by a HUMAN's GitHub
   * approval rather than an agent verdict, the sentence naming them and the
   * commit they approved. Null otherwise (no approval, or an agent verdict
   * cleared the gate).
   *
   * The acceptance surface must RENDER this: a gate that a person satisfied
   * cannot just go green, or the human who accepts has no idea whose judgement
   * they are standing on — the same "a chip is evidence, never a pseudo-check"
   * rule (ruling 19) that this pass has been applying everywhere else.
   *
   * Optional on the interface only so hand-built affordance literals in the
   * component tests keep compiling; every server path sets it explicitly.
   */
  verdictSatisfiedBy?: string | null;
  /**
   * Ruling 482 (F40-52): the project's gates on the revision under review, as
   * Viberr ran them — the line the PR card and the accept dialog print
   * ("Gates on a95c337: 4/4 exit 0 (run by Viberr)") and each result. Absent
   * when the project declares no gates or nothing is delivered (the resolver
   * never sets it to null, so a project without gates ships no key).
   */
  gates?: GatesView | null;
}

/** The affordance, and the project's required-reviewer rules it was read with. */
export interface AcceptanceStanding {
  affordance: AcceptanceAffordance;
  /** Ruling 178's rules, resolved; empty when the project cannot be read. */
  requiredReviewers: RequiredReviewerView[];
}

/**
 * P14-LV-06 — the ONE predicate behind "can this human accept this task".
 *
 * Live-proven mismatch: the review queue listed VM-4 under "Waiting on your
 * acceptance (1 of 1)" while the task page offered no acceptance affordance at
 * all — the divergence had withdrawn the operator's recommendation, and the task
 * page only ever rendered acceptance as a recommendation card. Acceptance is a
 * standing human authority at the boundary, not something an agent has to
 * suggest first, so both surfaces read it from here.
 *
 * A pure READ: it classifies by project role + ownership exactly like
 * `decisionsRequiring`, and never calls the audited authority path.
 *
 * Ruling 521: it answers with the required-reviewer rules it read. The task
 * page's completion packet marks a rule's reviewer required whether or not
 * anyone engaged it, and taking the rules from this read of project.md keeps
 * the page's revalidation at its store-read budget (ruling 457).
 *
 * Deliberately DB-free: membership and ownership both live in the canonical
 * files, so this resolves on a loader path without a projection read (and
 * mirrors the review queue's own role+owner test).
 */
export function acceptanceStanding(
  input: { projectSlug: string; taskKey: string; viewerUserId: string },
  ctx: TaskMutationContext = {},
): AcceptanceStanding {
  let project: ProjectContext;
  try {
    project = loadProjectContext(ctx, input.projectSlug);
  } catch {
    return { affordance: deniedAffordance(), requiredReviewers: [] };
  }
  return {
    affordance: affordanceIn(project, input, ctx),
    requiredReviewers: project.requiredReviewers,
  };
}

function deniedAffordance(): AcceptanceAffordance {
  return {
    hasAuthority: false,
    atBoundary: false,
    blockedReason: null,
    blockedGates: [],
    blockedReasonViaPacket: null,
    canAccept: false,
    terminallyBlocked: false,
    verdictSatisfiedBy: null,
  };
}

function affordanceIn(
  project: ProjectContext,
  input: { projectSlug: string; taskKey: string; viewerUserId: string },
  ctx: TaskMutationContext,
): AcceptanceAffordance {
  const denied = deniedAffordance();
  const existing = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  if (!existing) return denied;
  const fm = existing.parsed.frontmatter;
  // Ruling 482: shown whatever the viewer may do and wherever the task sits,
  // so the evidence reads the same on a Done task as it did at the boundary.
  // Absent (not null) when there is nothing to show: the task page's payload
  // is budgeted (ruling 457), and a project with no gates ships no key.
  const gates = projectGatesView(project.gates, fm);
  if (gates) denied.gates = gates;
  const role = project.memberRoles.get(input.viewerUserId) ?? null;
  const hasAuthority =
    roleCan(role, "accept-completion") ||
    (fm.ownerUserId === input.viewerUserId && roleCan(role, "own-task"));
  // An archived project is read-only (R6-3) — no acceptance from any role.
  if (project.archived) return { ...denied, hasAuthority };
  // F15-11: a task ALREADY at the terminal stage has nothing to accept — the
  // stage gate returns null for "already Done" (the writers' idempotent return
  // owns that), which used to render a live Accept button on closed tasks.
  const terminalId =
    stageRolesOf(project).terminalId ??
    project.stages[project.stages.length - 1]?.id ??
    null;
  if (terminalId !== null && fm.stage === terminalId) {
    return { ...denied, hasAuthority };
  }
  // Ruling 123: an archived task is terminally blocked for acceptance, so the
  // force-accept affordance is WITHDRAWN rather than disabled (ruling 37's
  // precedent). The server refuses it too — `forceIrreducibleRefusal`.
  if (fm.archived) {
    return { ...denied, hasAuthority, terminallyBlocked: true };
  }
  const atBoundary =
    !fm.archived && acceptanceStageBlockedReason(project, fm.stage, input.taskKey) === null;
  // Ruling 393: the WHOLE list once, and the first of it is `blockedReason`.
  // Computing them separately is how the dialog and the audit row came to
  // disagree about what an override was bypassing.
  const blockedGates = acceptanceRefusalReasons(project, fm, input.taskKey, {
    blockedPacket: fm.readiness === "blocked" && existing.parsed.packet?.type === "blocked",
    subjectAuthor: reviewSubjectAuthor(fm, existing.parsed.timeline),
  });
  const blockedReason = blockedGates[0] ?? null;
  const affordance: AcceptanceAffordance = {
    hasAuthority,
    atBoundary,
    blockedReason,
    blockedGates,
    // F19-7: what a packet resolution would hit — see the field's docstring.
    blockedReasonViaPacket: acceptanceRefusalReason(project, fm, input.taskKey, {
      blockedPacket: false,
      subjectAuthor: reviewSubjectAuthor(fm, existing.parsed.timeline),
    }),
    canAccept: hasAuthority && atBoundary && blockedReason === null,
    terminallyBlocked: acceptanceTerminallyBlocked(fm),
    // R19-B: name the human whose GitHub approval cleared the verdict gate.
    verdictSatisfiedBy: humanVerdictSentence(fm),
  };
  if (gates) affordance.gates = gates;
  return affordance;
}

/** R19-B — "Approved on GitHub by Arda (@arda) on the delivered revision
 *  `abc1234`", or null when no human approval is carrying the gate. Exported
 *  shape lives in `pr-human-approval.server.ts`; this is the one adapter every
 *  acceptance surface reads. */
function humanVerdictSentence(fm: TaskFrontmatter): string | null {
  const approval = humanVerdictApproval(fm);
  return approval ? humanVerdictNote(approval) : null;
}

/** The parenthetical after "accepted, merge pending" — the honest cause
 *  (P14-LV-07). A forced acceptance past an `unmergeable` verdict names THAT
 *  reason rather than the offline copy. */
export function mergePendingCause(merge: AcceptanceMergeOutcome): string {
  if (merge.kind === "pending" || merge.kind === "unmergeable") return merge.cause;
  return UNREACHABLE_MERGE_CAUSE;
}

/**
 * R17-1 (F17-L12): a completion-event suffix naming the reviewed-revision drift,
 * or "" when the PR head equals the reviewed revision. The reconciler records
 * `pr.revisionDrift` when the head moved AHEAD of the reviewed revision (commits
 * pushed after the review). Acceptance still merges an ahead head — the owner
 * ruling keeps "ahead" — but the completion record must name the commits that
 * ship (or shipped) outside the reviewed revision, so a Done task's own timeline
 * is honest about what merged. Every acceptance path appends this.
 */
export function revisionDriftNote(fm: TaskFrontmatter): string {
  // Ruling 132 (pass 34, F34-14): the permanent record uses the SAME words as
  // every live surface — authored commits were added outside the reviewed
  // revision; a base refresh is recorded as a base refresh and never as
  // unreviewed work (JC-8's timeline said "5 commits were added" for 4 base
  // commits and Viberr's own merge). F19-23's noun/verb agreement rides along.
  return sharedRevisionDriftNote(fm.pr?.revisionDrift);
}

/**
 * OBS-11 / OBS-13 — what a no-change acceptance does about the task branch that
 * the accept-time probe just found EMPTY.
 *
 * OBS-11 (live, vib-3): the acceptance verified "carries no commits ahead of
 * main" and then left the branch sitting on GitHub forever. Merged branches are
 * cleaned up by R15-6's post-merge policy; a branch that closes WITHOUT a merge
 * had no such path, so the one outcome that produces a guaranteed-empty branch
 * was also the one that never removed it.
 *
 * OBS-13 (live, vib-5) is why this is not simply "delete it": the probe falls
 * back to the DERIVED branch name when the task never recorded one, so it can
 * read — and the completion copy can then claim — a same-name branch from a
 * previous life that this task never created. Deleting someone else's branch on
 * a name match is exactly the branch-COLLISION harm rulings 34/35 refuse
 * elsewhere. So deletion is restricted to the branch the task itself recorded
 * (`fm.branch`), which is also all `deleteTaskRemoteBranch` will act on, and a
 * name-only match is disclosed as the collision it is instead.
 *
 * The remaining safety fact is supplied by the probe itself: `branch_empty`
 * means a live `compare(default…branch)` returned `aheadBy: 0`, i.e. the tip is
 * reachable from the default branch. Nothing unique is lost by deleting it. An
 * ahead/diverged branch never reaches here at all (it is refused, by name and
 * commit count, before acceptance).
 */
export type EmptyBranchDisposition =
  | { kind: "none" }
  /** The task's OWN empty branch, and the project keeps branch cleanup on. */
  | { kind: "delete"; branch: string }
  /** The task's OWN empty branch, cleanup switched off — left, and said so. */
  | { kind: "keep"; branch: string }
  /** A branch that only matches by NAME — not this task's, never deleted. */
  | { kind: "collision"; branch: string };

export function emptyBranchDisposition(
  db: DatabaseSync,
  fm: TaskFrontmatter,
  check: AcceptanceNoChangeCheck,
  projectSlug: string,
): EmptyBranchDisposition {
  const verification = check.verification;
  if (!check.applies || verification?.basis !== "branch_empty") return { kind: "none" };
  const branch = verification.branch;
  if (!branch) return { kind: "none" };
  // The task never recorded THIS branch — the probe matched a name, not a
  // delivery. (`fm.branch === null` is the live vib-5 shape; a different value
  // means the task's own branch is elsewhere and this one is a stranger too.)
  if (fm.branch !== branch) return { kind: "collision", branch };
  return branchCleanupOnMerge(db, projectSlug)
    ? { kind: "delete", branch }
    : { kind: "keep", branch };
}

/** The sentence a no-change completion event carries about the branch it left
 *  behind — "" when there is nothing to disclose (the deletion writes its own
 *  `github` event, so a promise here would only race it). */
export function emptyBranchNote(
  disposition: EmptyBranchDisposition,
  taskKey: string,
): string {
  switch (disposition.kind) {
    case "keep":
      return (
        ` The empty branch \`${disposition.branch}\` was left on GitHub because this project's ` +
        `"delete the branch after merge" setting is off.`
      );
    case "collision":
      return (
        ` A branch named \`${disposition.branch}\` exists on the remote, but ${taskKey} never ` +
        `recorded a branch of its own. The name matches, the work does not. It was left ` +
        `untouched, and nothing here describes what is on it.`
      );
    default:
      return "";
  }
}

/**
 * Ruling 88 (F21-2) — the disclosure the ceremony WOULD state for this task
 * right now: what merges, what was delivered, what the review said.
 *
 * Derived from the canonical file, never from the projection, and `verdict`
 * runs through `deriveValidation` (validation's ONE writer, F10-15) so the
 * comparison can never disagree with the pill the dialog rendered.
 */
export function acceptanceDisclosureOf(
  fm: TaskFrontmatter,
): AcceptanceDisclosure {
  return {
    pr: fm.pr?.state ?? "none",
    revision: activeWorkRevision(fm.workRevision)?.headSha ?? "none",
    verdict: deriveValidation(fm),
  };
}

/**
 * Ruling 88 (F21-2) — the server-side half of the acceptance ceremony.
 *
 * `ack` is deliberately three-state, and the distinction is the whole design:
 *
 *  - an `AcceptanceDisclosure` — the human confirmed the ceremony, and the echo
 *    is compared against the live task (below). This is what every HTTP
 *    acceptance door sends.
 *  - `null` — the caller IS a disclosure-bearing door and the request carried
 *    no echo: a bare POST. Refused. This is the case F21-2 found live: the
 *    ceremony was client architecture only, so anything that skipped the dialog
 *    merged to the default branch on an unadorned request.
 *  - omitted — an IN-PROCESS caller whose own path carries the disclosure and
 *    its own identity re-check (the packet resolution's packet-identity pin,
 *    `applyRecommendation`, the full-autonomy operator, the tests). Threading a
 *    server-built echo through those would be the server acknowledging itself,
 *    which proves nothing; they are gated by their own contracts instead.
 *
 * A stale echo is refused as hard as a missing one, and that is the R17-1
 * hardening: until now the dialog SURFACED head drift while the server enforced
 * nothing, so a tab left open across a re-delivery accepted a revision the human
 * never saw.
 */
export function assertAcceptanceDisclosure(
  fm: TaskFrontmatter,
  ack: AcceptanceDisclosure | null | undefined,
  taskKey: string,
  scope: "full" | "in-lock",
): void {
  if (ack === undefined) return;
  if (ack === null) {
    throw new AppError({
      code: ERROR_CODES.ACCEPT_DISCLOSURE_MISSING,
      status: 400,
      message: `acceptance of ${taskKey} carried no disclosure acknowledgment`,
      userMessage:
        `Accepting ${taskKey} needs the confirmation dialog: this request carried no record of ` +
        `what was shown (which pull request merges, which delivered revision, and what the ` +
        `review said). Open the task and accept from the dialog.`,
      details: { taskKey },
    });
  }
  const drift = acceptanceDisclosureDrift(acceptanceDisclosureOf(fm), ack, scope);
  if (drift.length === 0) return;
  throw new AppError({
    code: ERROR_CODES.ACCEPT_DISCLOSURE_STALE,
    status: 409,
    message: `acceptance of ${taskKey} was confirmed against stale state: ${drift.join("; ")}`,
    userMessage:
      `${taskKey} changed after the accept dialog was opened: ${drift.join("; ")}. Nothing was ` +
      `accepted or merged. Close the dialog, re-open it, and accept what is true now.`,
    details: { taskKey, scope },
  });
}

/** F32-11: the open decision an acceptance closed unanswered, captured inside
 *  the file lock (a ref, because the capture happens in the write callback). */
interface WithdrawnPacket {
  title: string;
  kind: string;
  type: TaskPacket["type"];
}
interface WithdrawnPacketRef {
  current: WithdrawnPacket | null;
}
/** Ruling 471: the open decision a direct human acceptance ANSWERED, and the
 *  option it answered with, captured inside the file lock like its sibling. */
interface AnsweredPacketRef {
  current: { packetKind: string; option: PacketOption } | null;
}
/** Ruling 547: the decision an acceptance closed, answered or withdrawn, and
 *  the entry that records it. */
interface ClosedDecisionRef {
  current: ClosedDecision | null;
}

/**
 * Ruling 686: what follows every acceptance, once the task stands at the
 * board's last stage. Two writes set that stage: `applyAcceptanceWrite` below
 * (a person's Accept or board move, a recommendation card, a force-accept,
 * the operator's own acceptance) and the decision packet's "accept
 * completion" option, which writes the stage itself. Both end here, so a
 * step added for one is not forgotten for the other: the packet's option ran
 * none of these until ruling 685 gave it the third, and an epic whose last
 * task was accepted from a decision was never told it was done.
 *
 * Each is fire-and-forget and reads the store as it stands, so a call that
 * finds nothing to do costs a read.
 */
export function afterAcceptance(db: DatabaseSync, ctx: TaskActionContext, projectSlug: string, taskKey: string): void {
  // Ruling 503: an acceptance is the usual way an epic's last task is done.
  maybeNoteEpicComplete(db, ctx, projectSlug, taskKey);
  // Ruling 131(e): and the usual way a waited-on task is done. The runner's
  // minute tick would release its dependents too; this does it now.
  maybeReleaseDependents(db, ctx, projectSlug);
  // Ruling 685: and the moment a controller conversation that waited for
  // this task takes its next step.
  maybeContinueController(db, ctx, projectSlug, taskKey);
}

/**
 * The ONE Done write every acceptance path shares (B-WF6). Exported for
 * `operatorAcceptCompletion`, whose full-autonomy branch historically
 * re-implemented this block inline and drifted gate by gate.
 *
 * Unless `skipInLockRecheck` (the audited force override), the acceptance
 * refusal gates are re-evaluated INSIDE the write lock against the freshly
 * parsed state (B-WF1): the direct human path awaits a real GitHub merge
 * between its gate check and this write, and a verdict/revision/packet change
 * in that window used to be accepted anyway.
 *
 * A2: the PR-head gate runs HERE, for every caller, and `skipInLockRecheck`
 * does not relax it. `operatorAcceptCompletion` reached this write without ever
 * checking the head — so a full-autonomy operator could stamp "merge pending"
 * on a PR carrying content its task never delivered. Callers that already
 * verified pass their `headCheck` through rather than paying a second read.
 */
export async function applyAcceptanceWrite(
  db: DatabaseSync,
  ctx: TaskActionContext,
  input: {
    projectSlug: string;
    taskKey: string;
    doneStageId: string;
    /** What the linked PR is stamped to (ignored when the task has no PR). */
    prState: "merged" | "accepted";
    event: TaskFileEvent;
    skipInLockRecheck?: boolean;
    /** A verification already performed by the caller; re-read when absent. */
    headCheck?: AcceptancePrHeadCheck;
    /** R19-8: the live no-change verification (re-read when absent). Bypassed by
     *  `skipInLockRecheck` — the audited force override — because this path
     *  merges nothing; the head gate above is never bypassed. */
    noChangeCheck?: AcceptanceNoChangeCheck;
    /** N20-14 (§5c): this acceptance is a force-accept — the human deliberately
     *  bypassed the verdict gate. Recorded as a DURABLE frontmatter fact so the
     *  hero/card don't recompute the pre-accept "awaiting verdict" state onto a
     *  Done task. The `task.acceptance.forced` audit row stays; this is the
     *  additional durable field. */
    forced?: boolean;
    /** Ruling 88 (F21-2): the disclosure the human acknowledged, re-compared
     *  under the lock. See `assertAcceptanceDisclosure` for the three states. */
    ack?: AcceptanceDisclosure | null;
    /** Ruling 471: the PERSON whose direct acceptance this is. Set by every
     *  human door (`acceptCompletion`, plain or forced), and then an open
     *  decision that offers the option this acceptance performs
     *  (`acceptanceAnswerOf`) is ANSWERED with it: the `task.packet.resolved`
     *  row the packet door writes, under this person, marked `via`, and no
     *  withdrawal. Absent on the operator's own acceptance, which answers no
     *  question put to a person, so every open decision is withdrawn as
     *  before (F32-11). */
    answerer?: TaskActor;
  },
): Promise<{ accepted: boolean }> {
  const project = loadProjectContext(ctx, input.projectSlug);
  const headCheck =
    input.headCheck ??
    (await acceptancePrHeadCheck(db, ctx, input.projectSlug, input.taskKey));
  if (headCheck.refusal) {
    await refuseUnverifiedHead(db, ctx, input.projectSlug, input.taskKey, headCheck);
  }
  // R19-8: the SECOND layer of the no-change gate. Every writer to Done funnels
  // through here, so a caller that forgets the check still cannot close a task
  // on a stale `noChanges` flag (F19-21).
  const noChange =
    input.noChangeCheck ??
    (await acceptanceNoChangeCheck(db, ctx, input.projectSlug, input.taskKey));
  if (noChange.refusal && !input.skipInLockRecheck) {
    throw AppError.conflict(noChange.refusal);
  }
  let accepted = false;
  // F32-11 (pass 32): the open decision this acceptance closes unanswered —
  // captured inside the lock so the note and the audit row name the packet
  // that was actually there, not the one the caller read before waiting.
  const withdrawn: WithdrawnPacketRef = { current: null };
  // Ruling 471: or the open decision this acceptance ANSWERS, captured in the
  // same place for the same reason.
  const answered: AnsweredPacketRef = { current: null };
  const closedPacket: ClosedDecisionRef = { current: null };
  await updateTaskFile(taskRef(ctx, input.projectSlug, input.taskKey), (parsed) => {
    // U3 (NFR16) — the callers' "already Done → return" check reads the file
    // OUTSIDE this lock, so two concurrent acceptances of one task both passed
    // it and both wrote: two `completion` events on the canonical timeline and
    // two audit rows for one human act, on the single most consequential action
    // the product has. The check re-runs HERE, where it is a decision rather
    // than a guess, and the write is skipped whole — the racing acceptance
    // already recorded the completion, the merge, and the audit.
    if (parsed.frontmatter.stage === input.doneStageId) return;
    assertVerifiedHeadStillApplies(parsed.frontmatter, headCheck, input.taskKey);
    assertVerifiedNoChangeStillApplies(parsed.frontmatter, noChange, input.taskKey);
    // Ruling 88: the disclosure is re-compared against the state actually being
    // closed. `skipInLockRecheck` (force) does NOT relax it — force bypasses
    // process GATES, and this is not a gate: it is the record of what the human
    // was shown. Scope `in-lock` skips the PR fact, which this very acceptance
    // may already have merged; the revision and the verdict are re-compared
    // because nothing on this path writes them before this point.
    assertAcceptanceDisclosure(
      parsed.frontmatter,
      input.ack,
      input.taskKey,
      "in-lock",
    );
    if (!input.skipInLockRecheck) {
      const refusal = acceptanceRefusalReason(
        project,
        parsed.frontmatter,
        input.taskKey,
        {
          blockedPacket:
            parsed.frontmatter.readiness === "blocked" &&
            parsed.packet?.type === "blocked",
          // R20-2: so a has-work branch refuses with the counted sentence.
          noChange,
          subjectAuthor: reviewSubjectAuthor(parsed.frontmatter, parsed.timeline),
        },
      );
      if (refusal) throw AppError.conflict(refusal);
    } else {
      // F19-25: `skipInLockRecheck` is the forced acceptance, and force is NOT a
      // licence to write Done over a terminal GitHub fact. Re-assert that one
      // under the lock, so a PR GitHub closed during the merge attempt cannot be
      // stamped "accepted" by a check that ran before it. (R19-5: the workflow
      // graph is deliberately NOT re-asserted — force may skip stages.)
      const irreducible = forceIrreducibleRefusal(parsed.frontmatter, input.taskKey);
      if (irreducible) throw AppError.conflict(irreducible);
    }
    // R20-2 (F20-6): the outcome the server PROVED becomes the durable record.
    // Without this the task closes as "no changes" while its frontmatter still
    // says otherwise, and every later reader (the rebuilder, deriveValidation,
    // the pill) re-derives the pre-acceptance answer. Set BEFORE deriveValidation
    // below, which reads `noChanges`.
    if (noChange.applies && noChange.autoDetected) {
      parsed.frontmatter.noChanges = true;
    }
    // N20-14 (§5c): a force-accept records the durable bypass fact. Set BEFORE
    // deriveValidation below — the C-VOCAB display arm reads this to render
    // "accepted · gate bypassed" instead of the recomputed "awaiting verdict".
    if (input.forced) {
      parsed.frontmatter.acceptance = "forced";
    }
    // Ruling 98: EVERY stage write records where the task came from — the
    // acceptance writer is a stage writer too (hunt 2026-08-29: it skipped the
    // field, so a Done task's previousStageId still named the stage before
    // review, and a reopen fed the operator a false "arrived from").
    if (parsed.frontmatter.stage !== input.doneStageId) {
      parsed.frontmatter.previousStageId = parsed.frontmatter.stage;
    }
    parsed.frontmatter.stage = input.doneStageId;
    // V18: every stage writer clears the deliberate-hold marker (same "every
    // stage write records..." rule as previousStageId above).
    parsed.frontmatter.heldAtStage = null;
    parsed.frontmatter.readiness = "ready";
    parsed.frontmatter.waiting = "none";
    // P14-LV-02: acceptance used to stamp `validation: healthy` with the comment
    // "accepted work is validated (FR24)" — untrue for work no reviewer ever
    // saw. `validation` has ONE writer (deriveValidation, F10-15); recompute it
    // and let the cache say what actually happened.
    parsed.frontmatter.validation = deriveValidation(parsed.frontmatter);
    if (parsed.frontmatter.pr) {
      // Never downgrade an already-merged PR to "accepted" (F15-13).
      const next =
        parsed.frontmatter.pr.state === "merged" ? "merged" : input.prState;
      parsed.frontmatter.pr = { ...parsed.frontmatter.pr, state: next };
    }
    // A Done task carries NO standing recommendation cards at all — not just
    // the transition/acceptance/delivery kinds. A leftover run/assign card on a
    // closed task is an offer the server would honor later (start a run on a
    // Done task); acceptance consumes every open offer, matching the packet
    // resolution path's long-standing behavior.
    parsed.frontmatter.recommendations = [];
    // Ruling 471: a person's direct acceptance ANSWERS the open decision when
    // it offers the option this acceptance performs. Live on WEB-1 the
    // operator recommended "Accept WEB-1 and merge PR #1", the owner pressed
    // Accept, and the note below said the decision "was never answered". The
    // packet door choosing that same option recorded an answer.
    const answer =
      parsed.packet && input.answerer
        ? acceptanceAnswerOf(parsed.packet, input.forced ? "force" : "accept")
        : null;
    if (parsed.packet && answer) {
      answered.current = { packetKind: parsed.packet.kind, option: answer.option };
      closedPacket.current = { packetId: parsed.packet.id, closedAt: input.event.occurredAt };
      // The packet door's own `accept_completion` answer IS its completion
      // event, so the answer rides this one as a single clause (it needs
      // saying here: the person pressed Accept, not the decision's option).
      input.event.text +=
        ` This acceptance answers the open decision "${parsed.packet.title}" with ` +
        `"${answer.option.t}".`;
    } else if (parsed.packet) {
      withdrawn.current = {
        title: parsed.packet.title,
        kind: parsed.packet.kind,
        type: parsed.packet.type,
      };
      // Live (VIB-3): force-accepting a task at Triage with an open decision
      // cleared it with no trace — the question simply vanished. The note is
      // the human-readable record; the audit row below is the durable one.
      const closedAt = new Date().toISOString();
      closedPacket.current = { packetId: parsed.packet.id, closedAt };
      parsed.timeline.unshift({
        occurredAt: closedAt,
        type: "note",
        actor: { kind: "system", systemId: "policy-engine" },
        title: null,
        text:
          `Withdrew the open decision "${parsed.packet.title}": this acceptance closed the task, ` +
          `so the decision was never answered.`,
        toAgent: false,
        evidence: null,
      });
    }
    parsed.packet = null;
    // A9 (pass 23): the PR head could NOT be verified against the delivered
    // revision (GitHub unreachable / the compare failed), yet an irreversible
    // merge still closed this task. The head gate refuses a KNOWN mismatch; an
    // UNVERIFIABLE head is allowed through (the merge's own honesty covers
    // unreachability) — but the completion record must SAY the containment check
    // did not run, or a verified accept and an unverified one read identically on
    // the most consequential action the product has. Only when a merge actually
    // landed (an "accepted, merge pending" outcome already discloses the
    // unreachability itself, so no double note).
    if (
      headCheck.verification === "unverifiable" &&
      headCheck.prNumber !== null &&
      parsed.frontmatter.pr?.state === "merged"
    ) {
      // Ruling 226: two different things reach this line now, and they are not
      // the same admission. A9's original case is GitHub being unreachable, and
      // its sentence is right for that. The other is a maintainer who was shown
      // the refusal and took the merge anyway — there the record must name what
      // was risked, not the procedure that was skipped, and it must name who
      // decided. "The check did not run" reads as a formality; "code no
      // reviewer approved may be on the base branch" is what it means.
      const waiver = parsed.frontmatter.headCheckWaiver ?? null;
      const waived =
        waiver !== null &&
        waiver.prNumber === headCheck.prNumber &&
        waiver.liveHeadSha === headCheck.liveHeadSha;
      input.event.text += waived
        ? `\n\nNote: PR #${headCheck.prNumber} was merged at head ` +
          `\`${(headCheck.liveHeadSha ?? "").slice(0, 7)}\` without confirming it contains the ` +
          `reviewed revision \`${(headCheck.revisionHeadSha ?? "").slice(0, 7)}\`. GitHub ` +
          `refused the comparison and ${waiver.byLabel || waiver.byUserId} accepted it anyway. ` +
          `Code no reviewer approved may be on the base branch.`
        : `\n\nNote: PR #${headCheck.prNumber}'s head could not be verified against the ` +
          `delivered revision before the merge (GitHub could not be reached for the check). ` +
          `It was accepted without that containment check.`;
    }
    parsed.timeline.unshift(input.event);
    accepted = true;
  });
  reprojectTask(db, ctx, input.projectSlug, input.taskKey);
  if (accepted && closedPacket.current) {
    followClosedDecision(db, input.projectSlug, input.taskKey, closedPacket.current);
  }
  if (accepted && withdrawn.current) {
    // The acceptance's own audit row (forced or not) names the human; this one
    // records that a decision died with it, and which.
    recordAudit(db, {
      action: "task.packet.withdrawn",
      actor: SYSTEM_ACTOR,
      subjectKind: "task",
      subjectId: input.taskKey,
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      details: {
        title: withdrawn.current.title,
        kind: withdrawn.current.kind,
        type: withdrawn.current.type,
        by: input.forced ? "force-accept" : "accept",
      },
    });
  }
  if (accepted && answered.current && input.answerer) {
    // Ruling 471: the row the packet door writes when a person resolves this
    // option (same action, actor and fields), plus `via`, the direct
    // acceptance it came through, in the vocabulary of the withdrawal row's
    // `by`. The operator hand-off the packet door skips for both kinds
    // (`NO_REQUEUE`: the task is Done) is skipped here by never being made.
    recordAudit(db, {
      action: "task.packet.resolved",
      actor: { userId: input.answerer.userId, label: input.answerer.label },
      subjectKind: "task",
      subjectId: input.taskKey,
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      details: {
        optionKind: answered.current.option.kind,
        optionTitle: answered.current.option.t,
        packetKind: answered.current.packetKind,
        via: input.forced ? "force-accept" : "accept",
      },
    });
  }
  if (accepted) {
    // Ruling 600: an acceptance closes the packet (answered or withdrawn) and
    // consumes every recommendation card, so no decision is left on the task,
    // and its decision rows are read for everyone, as the packet door and
    // archiving read theirs. Live on AWSC-12 a direct Accept consumed the
    // operator's "Accept completion" card; its row stayed unread, and every
    // tab's title counted that decision for a day and a half.
    markTaskPacketApprovalRead(db, input.projectSlug, input.taskKey);
    afterAcceptance(db, ctx, input.projectSlug, input.taskKey);
  }
  // U3: `false` means a concurrent acceptance had already closed this task —
  // the caller's audit row and follow-up effects belong to THAT write, not to
  // this one.
  return { accepted };
}

/**
 * Apply human acceptance through the shared Done transition and merge path.
 *
 * Returns whether THIS call performed the acceptance: `false` means the task
 * was already Done — either before the call (the idempotent early return) or by
 * the time the write lock was taken (U3's concurrent double-submit) — so the
 * caller must not record an audit row for a write it did not make.
 */
export async function acceptCompletion(
  db: DatabaseSync,
  input: {
    projectSlug: string;
    taskKey: string;
    force?: boolean;
    /** Ruling 88 (F21-2) — the acceptance disclosure the human acknowledged.
     *  Three states, documented on `assertAcceptanceDisclosure`: an echo to
     *  verify, an explicit `null` from a door whose request carried none (a
     *  bare POST — refused), or omitted by an in-process caller carrying its
     *  own disclosure contract. */
    ack?: AcceptanceDisclosure | null;
  },
  actor: TaskActor,
  ctx: TaskActionContext = {},
): Promise<boolean> {
  const project = loadProjectContext(ctx, input.projectSlug);
  const existing = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  if (!existing) throw AppError.notFound(`Task ${input.taskKey} not found.`);
  // R6-2: maintainer+ OR the task's human owner (even a Contributor) may accept.
  requireAcceptCompletion(
    db,
    project,
    actor,
    existing.parsed.frontmatter.ownerUserId,
    "accept completion into Done",
  );

  const doneStageId =
    terminalStageIdOf(project) ??
    project.stages[project.stages.length - 1]?.id ??
    "done";

  if (existing.parsed.frontmatter.stage === doneStageId) return false; // already Done.

  // Ruling 88 (F21-2): the disclosure is checked HERE — after the authority
  // gate (a caller who may not accept hears about their role, not their
  // dialog) and BEFORE the merge, so a stale or missing acknowledgment can
  // never be discovered on the far side of an irreversible GitHub write. It is
  // re-compared inside the write lock as well (`applyAcceptanceWrite`).
  assertAcceptanceDisclosure(
    existing.parsed.frontmatter,
    input.ack,
    input.taskKey,
    "full",
  );

  // F28-L1: run the live no-change probe BEFORE the gates so its verified-empty
  // verdict can reach them. It is cheap for a task WITH a PR (fails
  // `noChangeCandidate` — no GitHub call); for a PR-less delivered task it
  // decides whether the branch is truly empty (the R20-2 AUTO-DETECT of an
  // outcome the deliverer never explicitly claimed). Passing it into the sync
  // gate lets an unclaimed-but-proven-empty completion through — the "no review
  // pull request" refusal used to throw here first, so the probe (and the
  // auto-detect built to accept exactly this) never ran. R19-8 still holds: a
  // stale `noChanges` claim on a branch that has since gained commits fails
  // closed via `noChange.refusal` below.
  const noChange = await acceptanceNoChangeCheck(
    db,
    ctx,
    input.projectSlug,
    input.taskKey,
  );

  // Every acceptance gate — graph position, required reviewers, the R15-1
  // verdict gate, blocked packet, closed/conflicting PR, archived task — comes
  // from ONE shared helper, so a fourth writer to Done can't quietly ship with
  // a subset again. `force` is the audited admin override (DG-2).
  if (!input.force) {
    const refusal = acceptanceRefusalReason(
      project,
      existing.parsed.frontmatter,
      input.taskKey,
      {
        blockedPacket:
          existing.parsed.frontmatter.readiness === "blocked" &&
          existing.parsed.packet?.type === "blocked",
        noChange,
        subjectAuthor: reviewSubjectAuthor(existing.parsed.frontmatter, existing.parsed.timeline),
      },
    );
    if (refusal) throw AppError.conflict(refusal);
  } else {
    // F19-25: force skips the PROCESS gates — including, per R19-5, the workflow
    // graph and the review gate — but never the terminal GitHub fact (R16-3).
    // Checked here as well as in the write so `acceptCompletion(force)` is safe
    // for any future caller, not only through `forceAcceptCompletion`.
    const irreducible = forceIrreducibleRefusal(
      existing.parsed.frontmatter,
      input.taskKey,
    );
    if (irreducible) throw AppError.conflict(irreducible);
  }

  // R15-1 gate 2: the PR head must contain the delivered revision. Checked for
  // FORCED acceptance too — force bypasses missing/failed verdicts and stale
  // packets, never a PR that carries different content than was delivered
  // (F15-15: that is how junk would merge with a green review attached). The
  // verification is threaded into the write below so the shared Done write does
  // not pay for a second read (A2).
  const headCheck = await acceptancePrHeadCheck(
    db,
    ctx,
    input.projectSlug,
    input.taskKey,
  );
  if (headCheck.refusal) {
    await refuseUnverifiedHead(db, ctx, input.projectSlug, input.taskKey, headCheck);
  }

  // R19-8: a `noChanges` task closes WITHOUT a merge, so its basis is re-proved
  // LIVE — a flag set at some past delivery attempt must never close a task whose
  // branch has since gained commits (F19-21). The probe (hoisted above the gates
  // for F28-L1) fails closed: an unreachable or uncredentialed remote refuses;
  // `force` MAY bypass it (this path merges nothing), and the completion event
  // then says the check did not pass instead of claiming a verification.
  if (noChange.refusal && !input.force) throw AppError.conflict(noChange.refusal);

  // F15-13: a PR already merged on GitHub (out of band, reconciled into the
  // cache) needs no merge attempt — and the completion event must not claim the
  // merge as this human's act.
  const alreadyMerged = existing.parsed.frontmatter.pr?.state === "merged";

  // Human acceptance merges the review PR (FR31: "accepting a completion merges
  // its PR"). Attempt the REAL merge first when a PR + reachable GitHub exist —
  // mergeTaskPr writes state=merged + a `github` event + audit on success. When
  // GitHub REFUSES the merge (conflict, moved head) the task must NOT close:
  // acceptance is refused naming the true cause (P14-LV-07). When the merge
  // could not be REACHED we still do NOT claim "merged" — we record "accepted"
  // (merge pending) with the real reason, so the task record never diverges
  // from GitHub truth (NFR15).
  //
  // P14-GV-05/B-WF1: the merge is an EXTERNAL, irreversible side effect —
  // re-check the refusal gates at the narrowest point before it (the packet
  // path has had this since P14-GV-05; the direct path did not).
  const merge: AcceptanceMergeOutcome = alreadyMerged
    ? { kind: "merged" }
    : await attemptAcceptanceMerge(
        db,
        ctx,
        input.projectSlug,
        input.taskKey,
        actor,
        input.force
          ? undefined
          : () => {
              const fresh = readTaskFile(
                taskRef(ctx, input.projectSlug, input.taskKey),
              );
              if (!fresh) {
                throw AppError.notFound(`Task ${input.taskKey} not found.`);
              }
              const refusal = acceptanceRefusalReason(
                project,
                fresh.parsed.frontmatter,
                input.taskKey,
                {
                  blockedPacket:
                    fresh.parsed.frontmatter.readiness === "blocked" &&
                    fresh.parsed.packet?.type === "blocked",
                  // F28-L1: the same verified-empty result the outer gates saw.
                  noChange,
                  subjectAuthor: reviewSubjectAuthor(fresh.parsed.frontmatter, fresh.parsed.timeline),
                },
              );
              if (refusal) throw AppError.conflict(refusal);
            },
      );
  if (merge.kind === "unmergeable" && !input.force) {
    throw AppError.conflict(merge.reason);
  }
  const reallyMerged = merge.kind === "merged";
  const hasPr = !!existing.parsed.frontmatter.pr;

  // R17-1: name any reviewed-revision drift on the completion record.
  /**
   * Ruling 318: computed AFTER the merge, because the merge is what moves the
   * branch. `existing` was read before `attemptAcceptanceMerge`, which runs
   * `refreshBranchForAcceptance` → `recordBranchRefresh`: it brings the branch
   * up to date with the base, pushes that merge commit, re-measures the drift
   * and REWRITES the file. So on every task whose ceremony refreshed the base,
   * the permanent Done record either named a head that was never merged or
   * omitted the refresh the acceptance itself created.
   *
   * Live on SHOP-81, three consecutive entries: the github note says "base
   * refreshed · 2 merge commits · 9 base commits", the branch-deletion note
   * says the head was `75786d012de9`, and the completion record — the permanent
   * one — names the pre-refresh head instead.
   *
   * R17-1's whole purpose is that the permanent record names the commits that
   * shipped outside the reviewed revision, and the acceptance is the thing that
   * ships them.
   */
  const driftNote = revisionDriftNote(
    readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey))?.parsed.frontmatter ??
      existing.parsed.frontmatter,
  );
  // OBS-11 / OBS-13: decided BEFORE the write (it reads the pre-acceptance
  // frontmatter and the project policy) so the completion event can state the
  // branch's fate; the deletion itself runs after the task is really Done.
  const branchDisposition = emptyBranchDisposition(
    db,
    existing.parsed.frontmatter,
    noChange,
    input.projectSlug,
  );
  // R19-8: the no-change outcome has its OWN completion event, from the one
  // shared builder — it must never borrow the merge path's title or wording.
  const event: TaskFileEvent = noChange.applies
    ? noChangeCompletionEvent({
        taskKey: input.taskKey,
        actor: humanActorRef(db, actor),
        occurredAt: new Date().toISOString(),
        by: "human",
        verification: noChange.verification,
        forcedRefusal: noChange.refusal,
        autoDetected: noChange.autoDetected,
        kbCorrections: standingKbCorrections(db, input.projectSlug, input.taskKey),
      })
    : {
        occurredAt: new Date().toISOString(),
        type: "completion",
        actor: humanActorRef(db, actor),
        title: "Completion accepted",
        text:
          // U36-9 (pass 36): the board's terminal stage has a name; "Done" was
          // a literal on a board whose last stage is called Shipped.
          (!hasPr
            ? `Human acceptance recorded. ${input.taskKey} transitioned to **${stageName(project, doneStageId)}** (no linked pull request).`
            : alreadyMerged
              ? `Human acceptance recorded. ${input.taskKey} transitioned to **${stageName(project, doneStageId)}**; the review PR had already been merged on GitHub (out of band).`
              : reallyMerged
                ? `Human acceptance recorded. ${input.taskKey} transitioned to **${stageName(project, doneStageId)}** and the review PR was merged.`
                : `Human acceptance recorded. ${input.taskKey} transitioned to **${stageName(project, doneStageId)}**; the review PR is **accepted, merge pending** (${mergePendingCause(merge)}).`) +
          driftNote,
        toAgent: false,
        evidence: null,
      };
  // OBS-11 / OBS-13: the branch sentence rides on the no-change event only —
  // the merge path's copy is about a pull request, and a task WITH a PR never
  // reaches a `branch_empty` verification.
  if (noChange.applies) {
    event.text += emptyBranchNote(branchDisposition, input.taskKey);
  }
  // U35-3 (pass 35): a forced acceptance says on the record what it jumped,
  // the same list the confirm dialog showed and the audit row carries.
  if (input.force) {
    event.text += forceBypassClause(
      project,
      forceAcceptDisclosure(project, existing.parsed, input.taskKey, { noChange }),
    );
  }
  const acceptance: Parameters<typeof applyAcceptanceWrite>[2] = {
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    doneStageId,
    prState: reallyMerged ? "merged" : "accepted",
    event,
    headCheck,
    noChangeCheck: noChange,
    // Ruling 471: every door into this function is a person's acceptance
    // (Accept, Force accept, a stage move into the terminal stage, an applied
    // acceptance card), so it answers the open decision it performs.
    answerer: actor,
  };
  // Ruling 88: the same acknowledgment is re-compared under the write lock.
  if ("ack" in input) acceptance.ack = input.ack ?? null;
  if (input.force) {
    acceptance.skipInLockRecheck = true;
    acceptance.forced = true;
  }
  const { accepted } = await applyAcceptanceWrite(db, ctx, acceptance);
  // Ruling 177 (pass 36, F36-5): the task just closed — end its live runs so a
  // Shipped task spends nothing more and no completion re-invokes the operator
  // on it. One note names every run; each run's own audit row carries the cause.
  if (accepted) {
    await interruptLiveRunsOnClosure(db, ctx, input.projectSlug, input.taskKey, actor, {
      cause: input.force ? "force-accept" : "accept",
    });
  }
  // U3: a concurrent acceptance closed this task first — its write carries the
  // completion event and the audit row. Recording a second row here is exactly
  // the "two audit rows for one human act" NFR18 forbids.
  if (!accepted) return false;

  recordAudit(db, {
    action: "task.transition",
    actor: { userId: actor.userId, label: actor.label },
    subjectKind: "task",
    subjectId: input.taskKey,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: { to: doneStageId, boundary: "human", via: "accept_completion" },
  });

  await cleanUpEmptyTaskBranch(db, ctx, input, branchDisposition, actor);
  return true;
}

/**
 * OBS-11: the empty branch goes, once the task is genuinely Done.
 *
 * Lives here rather than inside one acceptance path because a no-change task
 * can be closed through the Accept button OR through an operator decision
 * packet, and a cleanup only one door runs makes the same branch's fate depend
 * on which button the human pressed.
 *
 * Called AFTER the write on purpose: a deletion in front of a refusal (a
 * verdict that landed mid-flight, a head that moved) would have removed a
 * branch from a task that stayed open. Best-effort — a failed cleanup never
 * un-accepts a completion, and `deleteTaskRemoteBranch` writes its own `github`
 * timeline event and audit row on success, keeps its own refusals (never the
 * default branch, never a branch with an open PR), and never throws.
 */
export async function cleanUpEmptyTaskBranch(
  db: DatabaseSync,
  ctx: TaskActionContext,
  input: { projectSlug: string; taskKey: string },
  branchDisposition: EmptyBranchDisposition,
  actor: TaskActor,
): Promise<void> {
  if (branchDisposition.kind === "delete" && actor.userId) {
    try {
      const { deleteTaskRemoteBranch } = await import(
        "~/server/github/github-reconciler.server"
      );
      // Same optional-key discipline as every other GitHub call on this path:
      // the transport hook is threaded only when the caller supplied one.
      const deleteCtx: GithubActionContext = { dataRoot: ctx.dataRoot };
      if (ctx.fetchImpl) deleteCtx.fetchImpl = ctx.fetchImpl;
      const outcome = await deleteTaskRemoteBranch(
        db,
        { projectSlug: input.projectSlug, taskKey: input.taskKey },
        { userId: actor.userId, label: actor.label },
        deleteCtx,
      );
      // "deleted" already speaks for itself on the timeline; "already gone" is
      // the state that was asked for. Only a genuine failure needs a sentence,
      // so the record never implies a cleanup that did not happen.
      const refusedText =
        outcome.status === "refused"
          ? `The empty branch \`${outcome.branch}\` was **not** deleted: ${outcome.message}`
          : outcome.status === "deleted" || outcome.status === "already_gone" ||
              outcome.status === "no_branch"
            ? null
            : `The empty branch \`${branchDisposition.branch}\` was **not** deleted: this ` +
              `project has no reachable GitHub repository or credential.`;
      if (refusedText) {
        await updateTaskFile(
          taskRef(ctx, input.projectSlug, input.taskKey),
          (parsed) => {
            parsed.timeline.unshift({
              occurredAt: new Date().toISOString(),
              type: "note",
              actor: { kind: "system", systemId: "policy-engine" },
              title: null,
              text: refusedText,
              toAgent: false,
              evidence: null,
            });
          },
        );
      }
      reprojectTask(db, ctx, input.projectSlug, input.taskKey);
    } catch (error) {
      logger.warn("empty task branch cleanup failed after a no-change acceptance", {
        taskKey: input.taskKey,
        err: toError(error),
      });
      // C10.3 (pass 25): `deleteTaskRemoteBranch` never throws, so a throw here is
      // the note-write / reproject failing — which would leave the empty branch
      // quietly standing with no record that the cleanup was attempted and lost.
      // Surface it, guarded so a second failure can never escape this handler.
      try {
        await appendPolicyNote(db, ctx, input.projectSlug, input.taskKey, {
          text:
            `The empty branch \`${branchDisposition.branch}\` may not have been ` +
            "deleted: the cleanup step failed. Remove it on GitHub if it is still there.",
        });
      } catch {
        // Already logged above; nothing more we can safely do here.
      }
    }
  }
}

/**
 * Admin-only override of the acceptance gate (DG-2). When a task is wedged —
 * a required reviewer that can no longer record a verdict, or a stale blocked
 * packet — a plain accept throws forever. An admin may force it: we record the
 * exact reason being bypassed to the audit log, then accept with `force: true`.
 */
export async function forceAcceptCompletion(
  db: DatabaseSync,
  input: {
    projectSlug: string;
    taskKey: string;
    /** Ruling 88 (F21-2): force is an override of the GATES, never of the
     *  disclosure — the `force` ceremony states everything the ordinary one
     *  does plus the stages and the refusal it bypasses, so its echo is
     *  demanded on exactly the same terms. See `acceptCompletion`. */
    ack?: AcceptanceDisclosure | null;
  },
  actor: TaskActor,
  ctx: TaskActionContext = {},
): Promise<{ task: TaskSummary }> {
  const project = loadProjectContext(ctx, input.projectSlug);
  requireAction(
    db,
    project,
    actor,
    "force-accept-completion",
    "force-accept past the review gate",
  );
  const existing = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  if (!existing) throw AppError.notFound(`Task ${input.taskKey} not found.`);
  // Already Done → acceptCompletion is a no-op; don't record a misleading
  // "forced" audit for an override that overrode nothing.
  const doneStageId =
    terminalStageIdOf(project) ??
    project.stages[project.stages.length - 1]?.id ??
    "done";
  if (existing.parsed.frontmatter.stage === doneStageId) {
    return { task: summaryOrThrow(db, input.projectSlug, input.taskKey) };
  }
  // F19-25 (R16-3): refuse the one gate force may not bypass BEFORE the audit
  // row — a `task.acceptance.forced` row for an override that was refused would
  // read as a completed bypass in the log. Ruling 37 has the task page WITHDRAW
  // (hide) the button while the PR is closed, but that withdrawal is client-only
  // and depends on state the client may not have refreshed; this is the server
  // saying no. R19-5: an off-boundary task is NOT refused here — force-accept
  // may skip the remaining stages and the review gate, and the honesty burden
  // lives on the confirm dialog that enumerates them.
  const irreducible = forceIrreducibleRefusal(
    existing.parsed.frontmatter,
    input.taskKey,
  );
  if (irreducible) throw AppError.conflict(irreducible);
  // Ruling 88: and refuse a missing/stale disclosure before the audit row for
  // the same reason — `acceptCompletion` checks it again, but by then a
  // "forced" row would already claim a bypass that never happened.
  assertAcceptanceDisclosure(
    existing.parsed.frontmatter,
    input.ack,
    input.taskKey,
    "full",
  );
  // P13-D-4 / P14-LV-02: the audit names the EXACT gate being overridden —
  // including the graph gate and the conflicting-PR gate, both of which a forced
  // accept can now bypass. Same shared helper the gate itself uses, so the audit
  // can never name a stale reason.
  // U35-3 (pass 35): the row names EVERY gate the dialog listed, not the first
  // one the single-reason helper happened to pick (KNC-10: the record said a
  // stage boundary was skipped and never that a failing verdict was
  // overridden). `bypassed` stays a string for its existing readers.
  const disclosure = forceAcceptDisclosure(project, existing.parsed, input.taskKey);
  const bypassed =
    disclosure.gates.length > 0
      ? disclosure.gates.join(" | ")
      : existing.parsed.frontmatter.readiness === "blocked"
        ? "an open blocked decision packet"
        : "no gate (already acceptable)";
  const forced: Parameters<typeof acceptCompletion>[1] = {
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    force: true,
  };
  if ("ack" in input) forced.ack = input.ack ?? null;
  const accepted = await acceptCompletion(db, forced, actor, ctx);
  // U3 (NFR16): the row follows the WRITE. It used to be recorded before the
  // acceptance, so a double-submitted force left two `task.acceptance.forced`
  // rows for one click — and any refusal thrown below it (a head that moved, a
  // verdict that landed) left a row claiming a bypass that never happened. The
  // one thing the ordering must preserve is that `bypassed` names the gate as
  // it stood BEFORE the write, which is why it is computed above.
  if (accepted) {
    recordAudit(db, {
      action: "task.acceptance.forced",
      actor: { userId: actor.userId, label: actor.label },
      subjectKind: "task",
      subjectId: input.taskKey,
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      details: {
        bypassed,
        bypassedGates: disclosure.gates,
        skippedStages: disclosure.skippedStageIds,
        validation: disclosure.validation,
        withdrawnPacket: disclosure.withdrawnPacket,
      },
    });
  }
  return { task: summaryOrThrow(db, input.projectSlug, input.taskKey) };
}

/** Complete a real GitHub merge after an offline acceptance left it pending. */
export async function completeTaskMerge(
  db: DatabaseSync,
  input: { projectSlug: string; taskKey: string },
  actor: TaskActor,
  ctx: TaskActionContext = {},
): Promise<{ task: TaskSummary; merged: boolean; message: string }> {
  const project = loadProjectContext(ctx, input.projectSlug);
  if (!actor.userId) {
    throw AppError.validation("A signed-in user is required to merge a PR.");
  }

  const existing = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  if (!existing) throw AppError.notFound(`Task ${input.taskKey} not found.`);
  // Completing a merge-pending acceptance is part of the same acceptance
  // authority — maintainer+ OR the task's owner (R6-2).
  requireAcceptCompletion(
    db,
    project,
    actor,
    existing.parsed.frontmatter.ownerUserId,
    "complete a PR merge",
  );
  const pr = existing.parsed.frontmatter.pr;
  if (!pr) {
    throw AppError.validation("This task has no linked pull request to merge.");
  }
  // F21-23 (live, UC-15): a human merged the PR on GitHub while the merge-pending
  // ceremony sat open. The poller adopted `state: merged`, the dialog re-rendered
  // — correctly — as "Nothing merges … Finish accepting VIB-x", and this door
  // then threw a 409 at the button it had just relabelled. The dialog promised
  // what the server refused.
  //
  // An already-merged PR is not a conflict, it is the OUTCOME this call exists to
  // reach: there is nothing left to merge and nothing to undo. So it settles as a
  // no-op success that reports both facts — merged on GitHub, nothing merged now.
  // Deliberately WRITES NOTHING: the acceptance that stamped this PR "accepted"
  // already recorded its completion on the timeline, and minting a second
  // completion for a click that changed no state would be exactly the invented
  // record ruling 88 exists to prevent. `merged` answers "is the PR merged when
  // this returns", not "did this call merge it" — which is why the honest message
  // rides alongside it and the caller renders that, not a verb of its own.
  if (pr.state === "merged") {
    return {
      task: summaryOrThrow(db, input.projectSlug, input.taskKey),
      merged: true,
      message: `PR #${pr.number} was already merged on GitHub; nothing merged now.`,
    };
  }
  // Every other state is still refused, unchanged: a PR in review has not been
  // accepted yet, and a closed one can never be merged (R16-3).
  if (pr.state !== "accepted") {
    throw AppError.conflict(
      `This PR is "${pr.state}", not an accepted merge-pending PR.`,
    );
  }

  // A2: this is a Done writer too — it finishes the acceptance by performing
  // the irreversible merge — and it ran the head gate on neither side. The
  // merge-pending nudge sends a human straight at this button, so an acceptance
  // that stamped "merge pending" before the PR head moved (or an operator
  // acceptance that never checked it at all) merged whatever the PR carries.
  const headCheck = await acceptancePrHeadCheck(
    db,
    ctx,
    input.projectSlug,
    input.taskKey,
  );
  if (headCheck.refusal) {
    await refuseUnverifiedHead(db, ctx, input.projectSlug, input.taskKey, headCheck);
  }

  const mergeTaskPr =
    ctx.deps?.mergeTaskPr ??
    (await import("~/server/github/github-reconciler.server")).mergeTaskPr;
  const mergeCtx: GithubActionContext = { dataRoot: ctx.dataRoot };
  if (ctx.fetchImpl) mergeCtx.fetchImpl = ctx.fetchImpl;
  const result = await mergeTaskPr(
    db,
    { projectSlug: input.projectSlug, taskKey: input.taskKey },
    { userId: actor.userId, label: actor.label },
    mergeCtx,
  );

  if (result.status === "merged") {
    // mergeTaskPr already wrote pr.state="merged" + a github event + audit.
    reprojectTask(db, ctx, input.projectSlug, input.taskKey);
    return {
      task: summaryOrThrow(db, input.projectSlug, input.taskKey),
      merged: true,
      message: `PR #${result.prNumber} merged.`,
    };
  }

  const message =
    result.status === "no_repo_configured" || result.status === "no_pat_configured"
      ? "Configure a GitHub credential for this project first, then try again."
      : result.status === "scope_violation"
        ? "The credential is missing `pull_request:write`. Grant the scope, then retry."
        : result.status === "not_mergeable" || result.status === "head_changed"
          ? `GitHub can't merge it yet: ${result.message}`
          : "The PR could not be merged. It may be closed or already merged on GitHub.";
  return {
    task: summaryOrThrow(db, input.projectSlug, input.taskKey),
    merged: false,
    message,
  };
}
