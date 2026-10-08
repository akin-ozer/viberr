import type { TaskDetail } from "~/server/projections/task-query.server";
import type { AcceptanceAffordance } from "~/server/tasks/task-acceptance.server";
import type { TookCard } from "~/server/tasks/what-it-took.server";
import { TASK_DECISION_ANCHOR } from "~/shared/page-anchors";
import type { PrOverlap } from "~/shared/pr-overlaps";
import { AcceptConfirm, type AcceptCeremony } from "./accept-confirm";
import { CompletionPacket, type CompletionDiff } from "./completion-packet";
import { DecisionPacket } from "./decision-packet";
import type {
  AcceptCompletion,
  PacketResolution,
  PendingAccept,
  RecommendationActions,
  RunConsole,
  StageTransition,
} from "./task-detail-actions";
import {
  acceptedResult,
  packetArchiveDisclosure,
  type CompletionPlacement,
  type TaskPermissions,
} from "./task-detail-derive";

/**
 * The task page's regions that stand only some of the time (ruling 700(d), the
 * pilot split of `task-detail-page.tsx`): the decision region and the
 * acceptance ceremony. Each takes the slot its markup held in the page and
 * calls no hook, so the page's markup, and every id React derives from its
 * place in the tree, are what they were.
 */

/**
 * U35-2: `.detail-packet`, the open decision packet, the page's most important
 * object, with the completion packet inside it or under it (ruling 521); with
 * no packet open, the completion packet on its own. The page renders this only
 * while one of the two shows.
 */
export function TaskDecisionRegion({
  task,
  targeted,
  placement,
  diff,
  attachmentsBase,
  sourcesBase,
  took,
  githubHost,
  acceptance,
  resolution,
  can,
  alsoAnswers,
  createTaskEchoes,
  pendingRecommendations,
  onRequestMaintainer,
  escalateBusy,
  onAsk,
}: {
  task: TaskDetail;
  /** Ruling 497: a notification's link landed here. */
  targeted: boolean;
  placement: CompletionPlacement;
  /** The Changes panel's reader, riding inside the completion packet. */
  diff: CompletionDiff | null;
  attachmentsBase: string | null;
  /** Ruling 690: the sources route, or null to draw no source as a link. */
  sourcesBase: string | null;
  /** Ruling 693: what the task took, or null when the loader shipped none. */
  took: TookCard | null;
  githubHost: string;
  acceptance: AcceptanceAffordance;
  resolution: PacketResolution;
  can: TaskPermissions;
  alsoAnswers: string | null;
  createTaskEchoes: Record<number, { key: string; title: string; stage: string }[]>;
  pendingRecommendations: number;
  onRequestMaintainer: () => void;
  escalateBusy: boolean;
  onAsk: () => void;
}) {
  const { acceptanceDecision, resultShown, card } = placement;
  const completionPacket = card ? (
    <CompletionPacket
      view={card}
      attachmentsBase={attachmentsBase}
      sourcesBase={sourcesBase}
      verdictSatisfiedBy={acceptance.verdictSatisfiedBy}
      diff={diff}
      standalone={!acceptanceDecision}
      took={took}
      result={resultShown ? acceptedResult(task, githubHost) : null}
    />
  ) : null;
  return task.packet ? (
    <div
      className="detail-packet"
      id={TASK_DECISION_ANCHOR}
      tabIndex={-1}
      data-targeted={targeted || undefined}
    >
      <DecisionPacket
        // F10-09: not keyed on the packet. A replacement re-seeds the card's
        // own state in place, so the `completion` slot below keeps its reader
        // and unsent notes, and the person keeps their focus.
        packet={task.packet}
        busy={resolution.busy}
        completion={acceptanceDecision ? completionPacket : null}
        // Ruling 529: a question the work does not wait on, because an
        // agent keeps working beside it (the wait the board card and the
        // Waiting on row read). A block never is.
        aside={task.packet.type === "input" && task.waiting === "agent"}
        // Ruling 319: a packet keyed to an account failure answers its
        // siblings too — the card says so before the confirm, not after.
        alsoAnswers={alsoAnswers}
        // Ruling 324: a create_task confirm names what already looks like it.
        createTaskEchoes={createTaskEchoes}
        canResolve={can.canResolvePacket}
        canResolveCompletion={can.canDecideOwned}
        // UI-42: an owner-only resolver must not be offered a decision they
        // cannot then carry out — so this asks for `update-goal`, the grant
        // `updateTaskGoal` itself enforces (E3).
        canEditGoal={can.canEditGoal}
        canArchive={can.canArchiveViaPacket}
        // F20-6: discard_branch re-checks the same `approve-transition` tier
        // the archive-with-branch-deletion needs (it destroys commits).
        canDiscardBranch={can.canArchiveViaPacket}
        // Ruling 164 (pass 35, F35-14): a `force_accept` option runs the
        // admin override, and a `move_stage` option runs the stage
        // picker's move, so each carries that control's own tier.
        canForceAccept={can.canForceAcceptViaPacket}
        canMoveStage={can.canArchiveViaPacket}
        // Ruling 672: both answers to the repository question decide the
        // board, on the tier its repository setting holds.
        canEditPolicy={can.canEditPolicy}
        archiveDisclosure={packetArchiveDisclosure(task, pendingRecommendations)}
        onResolve={resolution.onResolve}
        onResolveCustom={resolution.submitResolveCustom}
        // F20-18: only the contributor-owner-who-cannot-resolve-directly
        // gets the escalation affordance (the card shows it only when EVERY
        // option is above their tier).
        {...(can.canEscalatePacket ? { onRequestMaintainer, escalating: escalateBusy } : {})}
        onAsk={onAsk}
        onEditGoal={resolution.onEditGoal}
      />
      {acceptanceDecision ? null : completionPacket}
    </div>
  ) : (
    <div className="detail-packet">{completionPacket}</div>
  );
}

/** What the ceremony says about the decision it settles, and what it is. */
interface CeremonyDecision {
  openPacketTitle: string | null;
  answersWith: string | null;
  ceremony: AcceptCeremony;
  blockedGates: readonly string[];
}

function ceremonyDecision(
  pending: PendingAccept,
  forced: boolean,
  task: TaskDetail,
  acceptance: AcceptanceAffordance,
): CeremonyDecision {
  return {
    // F32-11: the open decision this acceptance withdraws, if any.
    // Ruling 164 + F19-7, applied to the sibling row: a PACKET resolution
    // (the `accept_completion` option, and the `force_accept` one ruling
    // 164 added) ANSWERS the open decision, so nothing is withdrawn. The
    // row used to name that packet and say it "closes unanswered", while
    // `task.acceptance.forced` recorded `withdrawnPacket: null` — the
    // disclosure is read after the packet path has cleared it. The direct
    // doors (Accept, Force accept, a recommendation, a stage move) close a
    // standing decision too.
    openPacketTitle: pending.mode === "packet" ? null : (task.packet?.title ?? null),
    // Ruling 471: and a direct door ANSWERS it when it offers the option
    // that door performs. The loader names that option per door (the
    // packet render's `forceAnswersWith` for Force accept, and
    // `acceptAnswersWith` for every plain acceptance); without one the
    // row stays "Withdraws".
    answersWith:
      pending.mode === "force"
        ? (task.packet?.forceAnswersWith ?? null)
        : pending.mode === "packet"
          ? null
          : (task.packet?.acceptAnswersWith ?? null),
    ceremony:
      "label" in pending
        ? {
            // Ruling 164: the `force_accept` option is a packet
            // resolution that performs the override, so it wears the
            // force ceremony and keeps the option's title as its subject.
            mode: forced ? "force" : pending.mode,
            label: pending.label,
          }
        : { mode: pending.mode },
    // Ruling 393 (F39-20): the gate LIST, for the force path only — the
    // dialog's "Bypassing" row and the audit row must name the same set.
    // The packet and clean paths keep their single refusal, which is the
    // right sentence for each: one is about a click the server will
    // refuse, the other about a gate the resolution clears.
    blockedGates: pending.mode === "force" && !forced ? acceptance.blockedGates : [],
  };
}

function ceremonyRefusal(
  pending: PendingAccept,
  forced: boolean,
  task: TaskDetail,
  acceptance: AcceptanceAffordance,
): string | null {
  return (
    // Ruling 164 + F19-7: the `force_accept` option is a PACKET
    // resolution, so it clears the packet before the override runs.
    // `task.blockReason` and `acceptance.blockedReason` both fold in
    // the open-blocked-packet sentence, and that packet is the one this
    // very click is answering — printing it under "Bypassing" would name
    // the decision as the gate it bypasses, tell the admin to resolve
    // the packet the button resolves, and disagree with the
    // `task.acceptance.forced` record, which is computed after the
    // packet is gone. The packet path's own refusal is the honest one.
    forced
      ? acceptance.blockedReasonViaPacket
      : pending.mode === "force"
        ? (task.blockReason ??
          acceptance.blockedReason ??
          (task.packet?.type === "blocked"
            ? "An open blocked decision is holding this task."
            : null))
        : // The merge is the SECOND half of an acceptance that already
        // happened (R16-6), so the acceptance gate has nothing left to
        // say about it — quoting a stale refusal here would read as a
        // block on a merge nothing is blocking.
        pending.mode === "complete-merge"
        ? null
        : // F19-7 (B's correctness win): a packet resolution evaluates
          // the acceptance contract with `blockedPacket: false` — the
          // open packet is what this resolution CLEARS, so it cannot
          // also be the reason to refuse it. Name the refusal the PACKET
          // path would hit, never the open-packet one.
          pending.mode === "packet"
          ? acceptance.blockedReasonViaPacket
          : acceptance.blockedReason
  );
}

/**
 * The one acceptance ceremony, open on whichever door asked (`PendingAccept`).
 * It waits on every fetcher its confirm can post through.
 */
export function TaskAcceptConfirm({
  pending,
  task,
  acceptance,
  workRevisionSha,
  baseBehindBy,
  mergeCollisions,
  noChanges,
  filesDeliveredAt,
  defaultBranch,
  accept,
  run,
  recs,
  resolution,
  transition,
  onCancel,
}: {
  pending: PendingAccept;
  task: TaskDetail;
  acceptance: AcceptanceAffordance;
  workRevisionSha: string | null;
  baseBehindBy: number | null;
  mergeCollisions: readonly PrOverlap[];
  noChanges: boolean;
  filesDeliveredAt: string | null;
  defaultBranch: string;
  accept: AcceptCompletion;
  run: RunConsole;
  recs: RecommendationActions;
  resolution: PacketResolution;
  transition: StageTransition;
  onCancel: () => void;
}) {
  // Ruling 164 (pass 35, F35-14): the pending decision is the `force_accept`
  // option, so the one ceremony opens in its force form (heading, bypass row,
  // danger confirm) while the confirmed click still travels as a packet
  // resolution. Derived once: the dialog reads it for BOTH the mode it renders
  // and the refusal that mode is allowed to bypass.
  const forced = pending.mode === "packet" && pending.force === true;
  const decision = ceremonyDecision(pending, forced, task, acceptance);
  return (
    <AcceptConfirm
      task={task}
      workRevisionSha={workRevisionSha}
      baseBehindBy={baseBehindBy}
      mergeCollisions={mergeCollisions}
      noChanges={noChanges}
      filesDeliveredAt={filesDeliveredAt}
      openPacketTitle={decision.openPacketTitle}
      answersWith={decision.answersWith}
      // F20-6 (R20-2): no PR + the completion never claimed no-change → the
      // accept path auto-detects it by re-probing the branch. The dialog
      // states that instead of promising a merge. `noChanges` (the flagged
      // shape) still takes precedence when the completion DID claim it.
      noPullRequest={!task.pr && !noChanges && !filesDeliveredAt}
      defaultBranch={defaultBranch}
      // R19-5: a force-accept from before the boundary MAY skip the
      // remaining stages and the review gate — the dialog has to name which.
      atBoundary={acceptance.atBoundary}
      // R19-B: the human GitHub approval carrying the verdict gate, rendered
      // on the verdict row (null when an agent verdict cleared it).
      verdictSatisfiedBy={acceptance.verdictSatisfiedBy}
      // Ruling 482: Viberr's own gate run on the revision this accepts.
      gates={acceptance.gates ?? null}
      ceremony={decision.ceremony}
      blockedGates={decision.blockedGates}
      blockedReason={ceremonyRefusal(pending, forced, task, acceptance)}
      busy={accept.busy || run.runBusy || recs.busy || resolution.busy || transition.busy}
      // Ruling 449: only the direct Accept offers the re-review first; the
      // other doors are answering a decision someone already framed.
      {...(pending.mode === "accept"
        ? {
            onRefreshFirst: accept.submitRefreshFirst,
          }
        : {})}
      onCancel={onCancel}
      onConfirm={(disclosure) => {
        // Ruling 88: EVERY acceptance intent carries this dialog's own echo
        // of what it displayed. `apply-recommendation` and `resolve-packet`
        // included: their server-side pins (the recommendation id, the
        // packet identity) prove WHICH decision is being settled, never that
        // the human saw what merges — so they are held to the ceremony on
        // the same terms as the direct Accept. `complete-merge` is the one
        // exception: the acceptance already happened (R16-6) and its own
        // path re-verifies the PR head, so there is no acceptance state left
        // to echo.
        if (pending.mode === "force") run.onForceAccept?.(disclosure);
        else if (pending.mode === "complete-merge") run.onCompleteMerge?.();
        else if (pending.mode === "apply-recommendation")
          recs.submitApply(pending.recId, disclosure);
        else if (pending.mode === "packet")
          resolution.submitResolve(pending.option, pending.note, disclosure);
        else if (pending.mode === "stage-move")
          transition.submitTransition(pending.toStageId, disclosure);
        else accept.submitAccept(disclosure);
      }}
    />
  );
}
