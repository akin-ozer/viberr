import { describeRevisionDrift } from "~/shared/revision-drift";
import type { PrRef, Validation } from "~/schemas/task-file.schema";
import type { AcceptanceDisclosure } from "~/shared/acceptance-disclosure";
import { prStatePill } from "~/features/github/github-pills";
import { Icon } from "~/ui/icon";
import { Pill, ValidationPill } from "~/ui/pill";
import { useDialog } from "~/ui/use-dialog";

/**
 * R15-1/F15-10 — the ONE acceptance ceremony.
 *
 * Accepting a completion MERGES the review PR into the default branch — a
 * one-way write to the shared repository that used to fire on a bare click
 * (removing a credential asked first; merging to main did not). The dialog
 * states exactly what merges — PR number, the delivered revision (head sha),
 * the actual merge head when it has drifted ahead of the reviewed revision
 * (R17-1), the verdict state, and the target branch — plus any missing signal
 * the acceptance would carry past (force-accept). Same useDialog contract as
 * ArchiveConfirm / ReleaseConfirm.
 *
 * Pass 19: ruling 20 says EVERY accept confirms, and the acceptance-writer
 * matrix found three writers that never did — then a fourth (`stage-move`) that
 * the matrix itself had missed. They are modes of this dialog rather than four
 * new ones — one ceremony, one disclosure, one place to keep honest (rulings
 * 12/14: never fork a mapping per surface):
 *
 * - `complete-merge` (F19-24) — the mandatory human half of every full-autonomy
 *   operator acceptance (R16-6); it performs the real, irreversible merge.
 * - `apply-recommendation` (F19-3/F19-26) — applying an operator recommendation
 *   whose TARGET is the terminal stage, whatever its `kind` says.
 * - `packet` (F19-7) — resolving a decision packet's `accept_completion`
 *   option, whose "Confirm decision" button names no merge at all.
 * - `stage-move` (F19-37) — the Current-state stage menu picking the LAST
 *   stage, which the server reads as an acceptance ("A HUMAN manually moving a
 *   task INTO the final stage IS accepting completion" → acceptCompletion). The
 *   sixth writer, and the last surface where a card reaching Done merged
 *   silently — the board's identical menu has confirmed since R18-7.
 *
 * Pass 21 (F21-2 / ruling 88): all of that was CLIENT architecture. A POST that
 * skipped this dialog accepted and merged with no disclosure at all, so the
 * whole ceremony held only for callers who chose to run it. The confirmed click
 * now hands its caller an `AcceptanceDisclosure` — the three facts THIS RENDER
 * put on screen, read off the same values the rows below display — and the
 * server refuses an acceptance that arrives without one, or with one that no
 * longer matches the live task (a head that moved, a PR merged out of band, a
 * verdict that landed while the dialog sat open). The echo is deliberately
 * taken from the rendered props rather than re-derived at submit time: a
 * disclosure the human did not see would prove nothing.
 */

export type AcceptCeremonyMode =
  | "accept"
  | "force"
  | "complete-merge"
  | "apply-recommendation"
  | "packet"
  | "stage-move";

export interface AcceptCeremony {
  mode: AcceptCeremonyMode;
  /** What the human actually clicked on the indirect paths: the operator's
   *  recommendation label, the packet option's title, or the stage move they
   *  picked. Rendered first, so the dialog answers "why am I being asked this?"
   *  before it answers "what merges?". */
  label?: string;
}

/**
 * D3 (rulings 14/53) — the exact task facts this one ceremony reads, declared
 * STRUCTURALLY so BOTH acceptance surfaces render this single component instead
 * of forking it. The task page passes its full `TaskDetail` (a superset); the
 * board passes a projection `TaskSummary` plus the board's own stage list — the
 * board summary carries every field below except `stages`, which it supplies
 * from its columns. Ruling 14 forbids a per-surface fork; keeping the param a
 * subset is what lets one implementation serve both without a cast.
 */
export interface AcceptConfirmTask {
  key: string;
  title: string;
  /** Current stage id — positions the task within `stages`. */
  stage: string;
  /** Project stages in order (id + display name). */
  stages: { id: string; name: string }[];
  validation: Validation;
  branch: string | null;
  pr: PrRef | null;
}

function headingFor(mode: AcceptCeremonyMode, terminalName: string): string {
  switch (mode) {
    case "force":
      return "Force-accept this completion?";
    // The task is already accepted here (merge pending, R16-6) — what is left,
    // and what this button does, is the merge itself.
    case "complete-merge":
      return "Run the merge now?";
    case "apply-recommendation":
      return "Apply this recommendation?";
    // F19-37: the human asked for a stage move; the heading has to name what a
    // move to the LAST stage actually is, in the project's own stage name.
    case "stage-move":
      return `Moving to ${terminalName} accepts this completion`;
    default:
      return "Accept this completion?";
  }
}

/** Row key for the clicked affordance — only the indirect paths have one, so
 *  the direct modes answer with nothing and the row does not render. */
function subjectKeyFor(mode: AcceptCeremonyMode): string | undefined {
  switch (mode) {
    case "apply-recommendation":
      return "Applying";
    case "packet":
      return "Decision";
    case "stage-move":
      return "Moving";
    default:
      return undefined;
  }
}

/** The Blocked row's id, so the disabled confirm can be described by it. */
const BLOCKED_ROW_ID = "accept-confirm-blocked";

export function AcceptConfirm({
  task,
  workRevisionSha,
  noChanges = false,
  noPullRequest = false,
  defaultBranch,
  atBoundary = true,
  ceremony,
  /** R19-B: when a HUMAN's GitHub approval cleared the verdict gate, the
   *  sentence naming them and the commit they approved — rendered on the verdict
   *  row so the human accepting knows whose judgement they stand on (ruling 19:
   *  a chip is evidence, never a pseudo-check). Null when an agent verdict
   *  cleared the gate, or nothing has. */
  verdictSatisfiedBy = null,
  /** The refusal a force-accept bypasses (null for a clean accept). For the
   *  packet mode the page passes `blockedReasonViaPacket` here — the refusal a
   *  packet resolution would hit, never the open packet it clears (F19-7). */
  blockedReason,
  /** F32-11 (pass 32): the OPEN decision packet this acceptance withdraws
   *  (its title), or null. Accepting a task with an open packet used to clear
   *  it silently — no row here, no timeline note, no audit — so the human
   *  never learned a question died with the acceptance. */
  openPacketTitle = null,
  busy,
  onCancel,
  onConfirm,
}: {
  task: AcceptConfirmTask;
  openPacketTitle?: string | null;
  /** The delivered revision's head sha (task file), or null before delivery. */
  workRevisionSha: string | null;
  /** R17-2: a verified no-change completion. TWO shapes reach this, and the
   *  row below distinguishes them — a delivered branch that turned out empty
   *  (F17-L9), and a verification-only task that never branched at all
   *  (F19-21). Neither has a PR. */
  noChanges?: boolean;
  /** F20-6 (R20-2): the task has no review PR AND the completion did not claim
   *  `noChanges` — so accepting will AUTO-DETECT a no-change completion by
   *  re-probing the branch on GitHub (empty → closes with no changes; has work
   *  → refused with the commit count). The dialog states exactly that instead
   *  of promising a merge. Threaded as a prop (not derived from `!task.pr`) so
   *  an ordinary PR-less accept still reads "closes without a merge" — the loader
   *  decides which shape this is. */
  noPullRequest?: boolean;
  /** The merge target — the project's default branch. */
  defaultBranch: string;
  /** `acceptance.atBoundary` — the task stands at the stage a completion is
   *  normally accepted from. False means a force-accept from here jumps the
   *  stages in between (R19-5); the dialog then names them. */
  atBoundary?: boolean;
  /** Which acceptance writer is asking (plus what the human clicked). */
  ceremony: AcceptCeremony;
  /** R19-B: the human GitHub approval carrying the verdict gate, or null. */
  verdictSatisfiedBy?: string | null;
  blockedReason: string | null;
  busy: boolean;
  onCancel: () => void;
  /** Ruling 88: receives the disclosure this dialog just made, for the submit
   *  to echo back to the server. Callers that reach a path with no server-side
   *  disclosure contract (the packet resolution, an applied recommendation)
   *  simply ignore the argument. */
  onConfirm: (disclosure: AcceptanceDisclosure) => void;
}) {
  const { ref: panelRef, close } = useDialog(onCancel);
  const mode = ceremony.mode;
  const force = mode === "force";
  const mergeOnly = mode === "complete-merge";
  const terminalName =
    task.stages.length > 0 ? task.stages[task.stages.length - 1]!.name : "Done";
  const subjectKey = subjectKeyFor(mode);
  // R19-5: force-accept MAY skip the remaining stages AND the review gate — the
  // owner ruled the skip legal and the SILENCE about it the defect. So enumerate
  // exactly what is being jumped: every stage between where the task stands and
  // the terminal one, by name, in order.
  //
  // `force && !atBoundary` — and the `force` half is not decoration. FORCE is
  // the ONLY mode that jumps, so it is the only one that may say so: it is the
  // one path where the server skips the gate stack outright (`acceptCompletion`
  // runs `acceptanceRefusalReason` under `if (!input.force)`, and only
  // `forceAcceptCompletion` ever passes `force: true`). On every OTHER mode an
  // off-boundary task is REFUSED, not jumped — the "Blocked" row below is what
  // actually happens — so claiming a skip would promise a power the click does
  // not have. Two earlier rounds got this wrong in two different ways, both of
  // them false in 100% of the cases they fired:
  // - `mode === "stage-move" && !atBoundary`: a stage move READS like a jump and
  //   is not one. `transitionStage` routes a manual move into the LAST stage to
  //   `acceptCompletion` WITHOUT `force`, so `acceptanceStageBlockedReason`
  //   refuses any off-boundary stage with a 409 and the task stays where it was
  //   (proven by the standing server test `acceptance-graph.server.test.ts` →
  //   "refuses a manual board move from Triage straight to Done"). `atBoundary`
  //   is literally that same predicate (`resolveAcceptanceAffordance` sets it
  //   from `acceptanceStageBlockedReason === null`), so the disjunct rendered
  //   "goes straight to Done" directly beside the "Blocked" row quoting the
  //   refusal that contradicts it.
  // - a bare `!atBoundary`: `complete-merge` is the sharpest case, because
  //   `resolveAcceptanceAffordance` returns its `denied` shape (`atBoundary:
  //   false`) for a task ALREADY at the terminal stage — which every
  //   merge-pending task is (accepted, merge pending, R16-6). So it announced
  //   "goes straight to Done" about a task already at Done, on the dialog that
  //   authorizes the irreversible merge. `packet` / `apply-recommendation` carry
  //   no override either — both run the same refusal helper unforced.
  const stageIndex = task.stages.findIndex((s) => s.id === task.stage);
  const skipsStages = force && !atBoundary;
  // stageIndex < 0 = the task sits on a stage this workflow no longer has; the
  // gate is still skipped, but naming stages it never passes would be a guess.
  const skippedStages =
    skipsStages && stageIndex >= 0
      ? task.stages
          .slice(stageIndex + 1, Math.max(task.stages.length - 1, 0))
          .map((s) => s.name)
      : [];
  const pr = task.pr;
  // Ruling 132: the one canonical sentence for what moved on the PR head.
  const drift = describeRevisionDrift(pr?.revisionDrift);
  // F19-14: the raw internal token ("accepted", "review") leaked into this
  // dialog while every other surface renders the canonical label through the one
  // PR-state map (ruling 12). "PR #12 accepted" and "PR #12 merge pending" are
  // the same fact under two vocabularies, on the screen that decides the merge.
  const prPill = pr ? prStatePill(pr.state) : null;
  // F21-23 (live, UC-15): a human merged PR #172 on GitHub, the poller adopted
  // `state: merged`, the reviewer verdict still ran and the ceremony correctly
  // showed "PR #172 · merged into main" — while the button underneath still read
  // "Apply → Done & merge" and the footer "Merging is one-way". The dialog KNEW
  // the merge had already happened and promised to perform it anyway. Nothing
  // merges on this path. Every disclosure row stays; only the two lines that
  // predict a merge change.
  //
  // F21-23 residual: relabelling the button was half a fix — `completeTaskMerge`
  // still threw a 409 ("This PR is already merged.") at the click "Finish
  // accepting VIB-x" invites, so the dialog promised what the server refused.
  // That door now settles an already-merged PR as a no-op success, and the
  // footer here says what the click really does: nothing merges, and nothing is
  // written either — the acceptance that stamped this PR "accepted" put the
  // completion on the timeline already (applyAcceptanceWrite), and the only
  // ceremony that reaches `complete-merge` opens from that state.
  const alreadyMerged = pr?.state === "merged";
  // Ruling 88 (F21-2): exactly what the three rows below state — the PR behind
  // the "Merges" pill, the sha on the "Revision" row, the value the "Verdict"
  // pill renders. Built here, from the rendered props, so the acknowledgment
  // the server verifies is the disclosure the human actually read.
  const disclosure: AcceptanceDisclosure = {
    pr: pr?.state ?? "none",
    revision: workRevisionSha ?? "none",
    verdict: task.validation,
  };
  return (
    <dialog
      className="modal-card release-card"
      role="alertdialog"
      aria-label={
        (force
          ? "Force-accept "
          : mergeOnly
            ? "Complete the merge for "
            : mode === "stage-move"
              ? `Accept by moving to ${terminalName}: `
              : "Accept ") + task.key
      }
      data-screen-label="Accept completion dialog"
      ref={panelRef}
    >
      <div className="modal-head">
        <span className={"agent-glyph lg" + (force ? " warn" : "")}>
          <Icon name={force ? "shield" : mergeOnly ? "github" : "check"} />
        </span>
        <div className="mh-main">
          <h2>{headingFor(mode, terminalName)}</h2>
          <div className="mh-sub">
            <span className="mono">{task.key}</span> · {task.title}
          </div>
        </div>
        <button
          type="button"
          className="icon-btn modal-close"
          onClick={close}
          aria-label="Close"
        >
          <Icon name="x" />
        </button>
      </div>
      <div className="modal-body tight">
        <div className="packet-obs flush">
          {subjectKey && ceremony.label && (
            <div className="obs">
              <span className="k">{subjectKey}</span>
              <span>{ceremony.label}</span>
            </div>
          )}
          <div className="obs">
            <span className="k">Merges</span>
            <span>
              {pr && prPill ? (
                <>
                  <Pill kind={prPill.kind} sm>
                    PR #{pr.number} · {prPill.label}
                  </Pill>{" "}
                  into <span className="mono">{defaultBranch}</span>
                </>
              ) : noChanges ? (
                // F19-21 opened a SECOND no-change shape and this row asserted
                // the first one's cause at both: a verification-only task never
                // had a branch to be empty, so "the branch is empty" was simply
                // false on the dialog that authorizes the close. Say what is
                // true of the task in hand — the branch when there is one, its
                // absence when there is not.
                <>
                  Nothing: <strong>completed with no changes</strong>.{" "}
                  {task.branch ? (
                    <>
                      <span className="mono">{task.branch}</span> carries no
                      commits, so no pull request was opened.
                    </>
                  ) : (
                    <>
                      {task.key} never opened a branch or a pull request.
                      Nothing merges.
                    </>
                  )}
                </>
              ) : noPullRequest && !force ? (
                // F20-6 (R20-2): no PR, and the completion never claimed "no
                // changes" — the server auto-detects it by re-probing the branch
                // AT acceptance. State what the click actually does; a loader-
                // time GitHub probe on every task open is unaffordable, so this
                // honest sentence is the alternative (it promises no merge).
                // Not on the FORCE path — force bypasses the very refusal this
                // sentence describes (its own Skips/Bypassing rows say what it
                // does), so the "refused if commits" clause would contradict it.
                <>
                  <strong>Nothing to merge yet.</strong> This task has no review
                  pull request. Accepting re-checks{" "}
                  {task.branch ? (
                    <span className="mono">{task.branch}</span>
                  ) : (
                    "the branch"
                  )}{" "}
                  on GitHub: if it carries no commits the task closes as{" "}
                  <strong>completed with no changes</strong>; if it carries work
                  the acceptance is refused and says how many commits.
                </>
              ) : (
                <>No linked pull request. The task closes without a merge.</>
              )}
            </span>
          </div>
          <div className="obs">
            <span className="k">Revision</span>
            <span>
              {workRevisionSha ? (
                <span className="mono">{workRevisionSha.slice(0, 12)}</span>
              ) : (
                "No delivered revision recorded."
              )}
            </span>
          </div>
          {/* R17-1 (F17-L12): the PR head moved AHEAD of the reviewed revision
              since the review — accepting still merges an ahead head, but the
              human must see that those extra commits ship unreviewed and that
              the merge head is NOT the revision pinned above. F19-24: this is
              the disclosure the bare "Complete merge" click never made, on the
              path that merges LAST — the one most likely to have drifted. */}
          {drift.kind !== "none" && pr?.revisionDrift && (
            // Ruling 132 (pass 34, F34-14): ONE sentence, printed verbatim from
            // `describeRevisionDrift` — a base refresh reads as a base refresh
            // (`obs`, not `warn`), only authored commits read as unreviewed.
            <div className={drift.unreviewed ? "obs warn" : "obs"}>
              <span className="k">Merge head</span>
              <span>
                <span className="mono">
                  {pr.revisionDrift.headSha.slice(0, 12)}
                </span>{" "}
                · {drift.sentence}
              </span>
            </div>
          )}
          <div className="obs">
            <span className="k">Verdict</span>
            <span>
              <ValidationPill value={task.validation} />
              {/* R19-B: the R15-1 verdict gate can be cleared by a human's
                  GitHub approval rather than an agent verdict. The pill goes
                  green either way, so name the person and the commit they
                  approved — a gate a human satisfied cannot pass silently
                  (ruling 19). */}
              {verdictSatisfiedBy && (
                <span className="fine xs"> · {verdictSatisfiedBy}</span>
              )}
            </span>
          </div>
          {/* R19-5: the skip is allowed — being quiet about it is not. Name the
              stages this jump goes past, in order, plus the review gate; the
              Force accept button that opened this dialog says the same thing in
              short form ("skips the remaining stages and the review gate").
              Force-only by construction (see `skipsStages` above): no other mode
              can jump, so no other mode may print this row. */}
          {skipsStages && (
            <div className="obs warn">
              <span className="k">Skips</span>
              <span>
                {skippedStages.length > 0 && (
                  <>
                    <strong>{skippedStages.join(" → ")}</strong>, and{" "}
                  </>
                )}
                {skippedStages.length > 0 ? "the" : "The"} review gate:{" "}
                {task.key} goes straight to {terminalName}
                {pr ? " and the pull request merges" : ""}.
              </span>
            </div>
          )}
          {blockedReason && (
            <div className="obs" id={BLOCKED_ROW_ID}>
              {/* Only force-accept BYPASSES a refusal. On every other path a
                  standing refusal means the server will refuse this click —
                  saying "Bypassing" there would promise an override nobody has.
                  Ruling 162 (pass 35): that click is not offered either; the
                  confirm below is disabled and described by this row. */}
              <span className="k">{force ? "Bypassing" : "Blocked"}</span>
              <span>{blockedReason}</span>
            </div>
          )}
          {openPacketTitle && (
            <div className="obs warn">
              {/* F32-11: the acceptance closes the task, so the open decision is
                  withdrawn unanswered — said here, and recorded on the timeline
                  and in the audit trail when it happens. */}
              <span className="k">Withdraws</span>
              <span>
                the open decision "{openPacketTitle}". It closes unanswered with the
                task; a timeline note and an audit row record the withdrawal.
              </span>
            </div>
          )}
        </div>
      </div>
      <div className="modal-foot">
        <span className="foot-hint">
          {force
            ? "Admin override. The bypassed gate is recorded to the audit log."
            : // F21-23: before the one-way warning, because a PR GitHub already
              // merged is not one-way from HERE — there is nothing left to do
              // that could be undone, and warning about it invents a decision.
              alreadyMerged
              ? // The `complete-merge` arm is the one where nothing at all is
                // left: its task was already accepted (that is what stamped the
                // PR "accepted"), so the completion is already on the timeline
                // and the server settles this click as a no-op. Every OTHER mode
                // still performs the acceptance itself — it just performs it
                // without a merge — so only this arm may say nothing is written.
                mergeOnly
                ? "Nothing merges: the pull request was already merged on GitHub. Nothing is written either, because this task's completion is already on the timeline."
                : "Nothing merges: the pull request was already merged on GitHub. The completion event is recorded on the timeline."
              : mergeOnly
                ? "Merging is one-way. The merge and its result are recorded on the timeline."
                : pr
                  ? "Merging is one-way. The completion event and the merge are recorded on the timeline."
                  : "The completion event is recorded on the timeline. Nothing is merged: this task has no pull request."}
        </span>
        <div className="foot-actions">
          <button type="button" className="btn ghost" onClick={close}>
            Not yet
          </button>
          <button
            type="button"
            className={"btn " + (force ? "danger" : "primary")}
            // Ruling 162 (pass 35, F35-12 (c)): no surface offers an acceptance
            // the gate will refuse. A standing refusal disables the confirm on
            // every mode but force (the one that bypasses it); the reason sits
            // in the Blocked row above and describes the control. This is a
            // server-side interlock, not form validation, so ruling 147's
            // enabled-until-busy rule does not apply.
            disabled={busy || (blockedReason !== null && !force)}
            aria-describedby={blockedReason && !force ? BLOCKED_ROW_ID : undefined}
            onClick={() => onConfirm(disclosure)}
          >
            <Icon name={force ? "shield" : mergeOnly ? "github" : "check"} />
            {force
              ? `Force-accept ${task.key}`
              : mergeOnly
                ? // F21-23: the merge-pending path can find the PR merged out of
                  // band between the recommendation and this click. "Merge PR
                  // #172 into main" would name work GitHub has already done.
                  alreadyMerged
                  ? `Finish accepting ${task.key}`
                  : pr
                    ? `Merge PR #${pr.number} into ${defaultBranch}`
                    : "Run the merge"
                : `${
                    mode === "apply-recommendation"
                      ? "Apply"
                      : mode === "stage-move"
                        ? "Move"
                        : "Accept"
                  } → ${terminalName}${pr && !alreadyMerged ? " & merge" : ""}`}
          </button>
        </div>
      </div>
    </dialog>
  );
}
