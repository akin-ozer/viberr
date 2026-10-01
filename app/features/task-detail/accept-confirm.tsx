import { describeRevisionDrift } from "~/shared/revision-drift";
import type { PrRef, Validation } from "~/schemas/task-file.schema";
import type { AcceptanceDisclosure } from "~/shared/acceptance-disclosure";
import type { PrOverlap } from "~/shared/pr-overlaps";
import type { PrChecksRender } from "~/shared/mapping/task.server";
import { checksPill, gatesPill, prStatePill } from "~/features/github/github-pills";
import type { GatesView } from "~/shared/project-gates";
import { Icon } from "~/ui/icon";
import { Pill, ValidationPill } from "~/ui/pill";
import { useDialog } from "~/ui/use-dialog";
import { GateResults } from "./gate-results";

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
  /**
   * Ruling 304: the CI state of the pull request this click MERGES.
   *
   * Checks are deliberately not an acceptance gate -- the reviewers' verdicts
   * are -- which is exactly why the person deciding has to be told. Null when
   * nothing has reported, which reads as "not reported" and never as "green".
   */
  prChecks: PrChecksRender | null;
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
    // Ruling 164 (pass 35, F35-14): force-accepting is an indirect path now
    // too. The task page's own button passes no label, so the row still does
    // not render for it; a `force_accept` packet option passes its title.
    case "force":
      return "Decision";
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

/** Paths named per colliding PR before the rest are counted. */
const COLLIDES_PATHS_SHOWN = 3;

/**
 * Ruling 475 (F40-55 (c)): "Merging this will likely put WEB-2's PR #3 in
 * conflict on `package.json`." Live on akinozer-com the owner accepted WEB-4
 * while WEB-2's open PR changed the same file; Viberr knew, the dialog was
 * silent, and WEB-2's acceptance was refused a minute later. The row names
 * each PR and the shared paths, and what Viberr does after the merge.
 */
function CollidesRow({ collisions }: { collisions: readonly PrOverlap[] }) {
  const partial = collisions.some((c) => c.partial);
  const one = collisions.length === 1;
  return (
    <div className="obs warn" data-merge-collisions>
      <span className="k">Collides</span>
      <span>
        {one
          ? "Merging this will likely put "
          : `Merging this will likely put ${collisions.length} open pull requests in conflict: `}
        {collisions.map((c, i) => {
          const shown = c.paths.slice(0, COLLIDES_PATHS_SHOWN);
          const more = c.paths.length - shown.length;
          return (
            <span key={c.taskKey}>
              {i > 0 ? "; " : ""}
              {c.taskKey}'s PR #{c.prNumber}
              {one ? " in conflict" : ""} on{" "}
              {shown.map((path, j) => (
                <span key={path}>
                  {j > 0 ? ", " : ""}
                  <span className="mono">{path}</span>
                </span>
              ))}
              {more > 0 ? ` and ${more === 1 ? "1 more file" : `${more} more files`}` : ""}
            </span>
          );
        })}
        . Viberr re-checks {one ? "it" : "them"} right after the merge, and the operator hands a
        conflict to the delivering agent.
        {partial ? " A changed-file list was capped, so the overlap may be larger." : ""}
      </span>
    </div>
  );
}

export function AcceptConfirm({
  task,
  workRevisionSha,
  noChanges = false,
  noPullRequest = false,
  filesDeliveredAt = null,
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
  /**
   * Ruling 393 (F39-20): EVERY gate a force-accept would bypass, in gate order.
   *
   * U35-3 made the audit row and the forced completion event name all of them
   * so the record could not under-report an override; its docstring says "the
   * timeline, the audit log and the confirm dialog list the same bypasses", and
   * the dialog was the one that never got the list. Live on ax-clone AX-12 a
   * human confirmed one bypassed gate and the audit recorded two. Empty (or
   * absent, for the packet mode, which has its own single refusal) falls back
   * to `blockedReason` alone.
   */
  blockedGates = [],
  blockedReasonAuthoritative = true,
  /** F32-11 (pass 32): the OPEN decision packet this acceptance closes (its
   *  title), or null. Accepting a task with an open packet used to clear
   *  it silently — no row here, no timeline note, no audit — so the human
   *  never learned a question died with the acceptance. */
  openPacketTitle = null,
  /** Ruling 471: the title of the option this acceptance ANSWERS that
   *  decision with, or null when it withdraws it. The loader decides
   *  (`acceptAnswersWith` / `forceAnswersWith` on the packet render, from the
   *  predicate the server's write uses); this component only says which. */
  answersWith = null,
  baseBehindBy = null,
  mergeCollisions = [],
  gates = null,
  onRefreshFirst,
  busy,
  onCancel,
  onConfirm,
}: {
  task: AcceptConfirmTask;
  /** Ruling 475 (F40-55 (c)): the other open pull requests that change a
   *  path this one changes, so merging it will likely put them in conflict.
   *  Both doors pass it: the task page from its loader, the board from the
   *  cards it holds (`mergeCollisions` in `~/shared/pr-overlaps`). */
  mergeCollisions?: readonly PrOverlap[];
  /** U39-32: how many base commits the branch lacked at the reconciler's last
   *  compare, or null when that was never measured (the board door). */
  baseBehindBy?: number | null;
  /** Ruling 482 (F40-52): the project's gates as Viberr ran them on the
   *  revision this click accepts, or null (no gates declared, or the board
   *  door, whose refusal row already carries the gate's sentence). */
  gates?: GatesView | null;
  /** Ruling 449 (O39-c): bring the branch up to date and re-review it before
   *  accepting. Offered only where the caller passes it (the task page's
   *  direct Accept) and only while the branch is behind its base. */
  onRefreshFirst?: () => void;
  openPacketTitle?: string | null;
  answersWith?: string | null;
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
  /** Ruling 550: the task's delivery is the files saved on it, delivered at
   *  this instant. Nothing merges and nothing is re-checked on GitHub. */
  filesDeliveredAt?: string | null;
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
  /** Ruling 393: every gate a force-accept bypasses, in gate order. */
  blockedGates?: readonly string[];
  /** Ruling 162's interlock applies to the refusal the SERVER will re-decide
   *  from the same facts (the task page reads the live task file through
   *  `resolveAcceptanceAffordance`), so a dialog quoting it may disable its own
   *  confirm. The board composes its refusal from a projection summary instead
   *  (`boardAcceptRefusal`, deliberately belt-and-braces so a stale row fails
   *  CLOSED), and it has no force path: disabling there would dead-end the only
   *  control on a row the server may well accept. Such a caller passes false —
   *  the reason is still disclosed above the confirm, and the confirmed click
   *  lets the server answer. Default true: the interlock is the rule, opting
   *  out is the exception that has to say so. */
  blockedReasonAuthoritative?: boolean;
  busy: boolean;
  onCancel: () => void;
  /** Ruling 88: receives the disclosure this dialog just made, for the submit
   *  to echo back to the server. Callers that reach a path with no server-side
   *  disclosure contract (the packet resolution, an applied recommendation)
   *  simply ignore the argument. */
  onConfirm: (disclosure: AcceptanceDisclosure) => void;
}) {
  // Ruling 459: both commits leave the way Cancel does (`commit`), and the
  // callers leave the unmount to onCancel.
  const { ref: panelRef, close, commit } = useDialog(onCancel);
  const mode = ceremony.mode;
  const force = mode === "force";
  // Ruling 162's interlock, and only where the quoted refusal is the one the
  // server will re-decide (see `blockedReasonAuthoritative`).
  const interlocked = blockedReason !== null && blockedReasonAuthoritative;
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
  // The exact shape `refreshBranchForAcceptance` acts on: an open (or
  // accepted-pending) pull request on a branch. A no-change completion and a
  // merged PR reach the ceremony with nothing to refresh.
  const refreshedPr = pr !== null && (pr.state === "review" || pr.state === "accepted");
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
            <span className="key">{task.key}</span> · {task.title}
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
                  {/* Ruling 304: this row names the door; ruling 246's rule is
                      that it also says whether the door is open. The checks
                      pill was one panel up on the page and absent from the
                      dialog that authorizes an irreversible merge. */}
                  {task.prChecks && task.prChecks.state !== "passing" ? (
                    <>
                      {" "}
                      <Pill kind={checksPill(task.prChecks).kind} sm>
                        {checksPill(task.prChecks).label}
                      </Pill>{" "}
                      <span className="pol-note">
                        {task.prChecks.state === "failing"
                          ? "Checks are not a gate here, the review verdicts are, so this merge is not blocked by them. Merging anyway is your call."
                          : task.prChecks.state === "pending"
                            ? "Checks have not finished. Merging now does not wait for them."
                            : "GitHub reported no conclusive check result for this head."}
                      </span>
                    </>
                  ) : null}
                </>
              ) : noChanges ? (
                // F19-21 opened a SECOND no-change shape and this row asserted
                // the first one's cause at both: a verification-only task never
                // had a branch to be empty, so "the branch is empty" was simply
                // false on the dialog that authorizes the close. Say what is
                // true of the task in hand — the branch when there is one, its
                // absence when there is not. Ruling 576: and no outcome name,
                // since "no changes" is false of a task that corrected a
                // knowledge base; this row says only what merges.
                <>
                  Nothing.{" "}
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
              ) : filesDeliveredAt ? (
                <>
                  Nothing: the delivery is the files saved on this task, so no
                  pull request merges.
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
                  on GitHub: if it carries no commits the task closes with
                  nothing merged; if it carries work the acceptance is refused
                  and says how many commits.
                </>
              ) : (
                <>No linked pull request. The task closes without a merge.</>
              )}
            </span>
          </div>
          {/* Ruling 162 / G35-5(d): the acceptance ceremony now runs the base
              refresh itself (`refreshBranchForAcceptance`) immediately before
              the gate re-check and the merge — the same workspace merge
              `update_branch_from_base` performs, pushed to origin. That is a
              WRITE to the person's branch on GitHub, made by this click, and
              the dialog is the ruling-88 disclosure: it may not stay silent
              about it, and the "Merge head" row below is the sha the refresh
              supersedes when the base has moved. `complete-merge` is excluded
              because its path (`completeTaskMerge`) merges the PR without the
              ceremony, so nothing refreshes there. */}
          {!mergeOnly && task.branch && refreshedPr && (
            <div className="obs">
              <span className="k">Branch</span>
              <span>
                {/* U39-32: the reconciler's last compare says which case this
                    click is. Live on ax-clone the same conditional sentence
                    sat over a branch that already carried main (AX-28) and one
                    four commits behind it (AX-29), and the person had to go to
                    GitHub to learn which, and whether the head that would
                    merge had ever been reviewed. */}
                {baseBehindBy === 0 ? (
                  <>
                    <span className="mono">{task.branch}</span> carried{" "}
                    <span className="mono">{defaultBranch}</span> at the last
                    GitHub check, so the reviewed head merges as it is. If{" "}
                    <span className="mono">{defaultBranch}</span> moves before
                    you confirm, the merge that brings it in is pushed to the
                    branch first.
                  </>
                ) : baseBehindBy !== null && baseBehindBy > 0 ? (
                  <>
                    <span className="mono">{task.branch}</span> is{" "}
                    {baseBehindBy === 1 ? "1 commit" : `${baseBehindBy} commits`}{" "}
                    behind <span className="mono">{defaultBranch}</span> at the
                    last GitHub check. Accepting merges{" "}
                    {baseBehindBy === 1 ? "it" : "them"} into the branch first
                    and pushes that merge commit, which becomes the merge head.
                    No review has run on that combination.
                    {onRefreshFirst && !force && !mergeOnly
                      ? " Update the branch and re-review first runs the review on it before anything merges."
                      : ""}
                  </>
                ) : (
                  <>
                    <span className="mono">{task.branch}</span> is brought up to
                    date with <span className="mono">{defaultBranch}</span> first.
                    If the base has moved, that merge commit is pushed to the
                    branch and becomes the merge head.
                  </>
                )}
              </span>
            </div>
          )}
          {/* Ruling 475 (F40-55 (c)): the pull requests this merge will
              likely put in conflict, named before the click rather than found
              by the next person's refused Accept. Only where a merge happens. */}
          {pr && !alreadyMerged && mergeCollisions.length > 0 && (
            <CollidesRow collisions={mergeCollisions} />
          )}
          <div className="obs">
            <span className="k">Revision</span>
            <span>
              {workRevisionSha ? (
                <span className="mono">{workRevisionSha.slice(0, 12)}</span>
              ) : filesDeliveredAt ? (
                // The stored ISO instant, as `formatAbsoluteUTC` writes it.
                `The files delivered on this task at ${filesDeliveredAt.slice(0, 16).replace("T", " ")} UTC.`
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
                <span className="fine"> · {verdictSatisfiedBy}</span>
              )}
            </span>
          </div>
          {/* Ruling 482 (F40-52): the owner accepted two production deploys on
              agents' reports of the gate exit codes. This row is the server's
              own run, bound to the sha on the Revision row above. A failure
              also stands in the Blocked row below, because it refuses a plain
              acceptance; force accept records it as bypassed. */}
          {gates && (
            <div className={gates.state === "passed" ? "obs" : "obs warn"}>
              <span className="k">Gates</span>
              <div>
                <Pill kind={gatesPill(gates.state).kind} sm>
                  {gatesPill(gates.state).label}
                </Pill>{" "}
                {gates.line}
                {gates.rows.some((r) => !r.ok) && (
                  <GateResults rows={gates.rows.filter((r) => !r.ok)} compact />
                )}
              </div>
            </div>
          )}
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
              {/* Ruling 393: on the FORCE path every gate, because that is what
                  the audit row and the completion event will say it bypassed.
                  Everywhere else the first one is the refusal, and a list would
                  be noise about a click the server is going to refuse anyway. */}
              {force && blockedGates.length > 1 ? (
                <ul className="tight">
                  {blockedGates.map((gate) => (
                    <li key={gate}>{gate}</li>
                  ))}
                </ul>
              ) : (
                <span>{blockedReason}</span>
              )}
            </div>
          )}
          {openPacketTitle &&
            (answersWith ? (
              <div className="obs">
                {/* Ruling 471: the decision offers the option this acceptance
                    performs, so the acceptance IS its answer, recorded the way
                    the packet's own confirm records it. */}
                <span className="k">Answers</span>
                <span>
                  the open decision "{openPacketTitle}" with "{answersWith}". The
                  answer is recorded on the timeline and in the audit trail.
                </span>
              </div>
            ) : (
              <div className="obs warn">
                {/* F32-11: a decision that offers neither acceptance option is
                    withdrawn unanswered when the acceptance closes the task.
                    Said here, and recorded on the timeline and in the audit
                    trail when it happens. */}
                <span className="k">Withdraws</span>
                <span>
                  the open decision "{openPacketTitle}". It closes unanswered with the
                  task; a timeline note and an audit row record the withdrawal.
                </span>
              </div>
            ))}
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
          {onRefreshFirst && !force && !mergeOnly && baseBehindBy !== null && baseBehindBy > 0 && (
            // Ruling 449 (O39-c): the head that merges would be one no review
            // ran on. This runs the review on it first; acceptance comes after.
            <button type="button" className="btn" disabled={busy} onClick={() => commit(onRefreshFirst)}>
              <Icon name="refresh" />
              Update the branch and re-review first
            </button>
          )}
          <button
            type="button"
            className={"btn " + (force ? "danger" : "primary")}
            // Ruling 162 (pass 35, F35-12 (c)): no surface offers an acceptance
            // the gate will refuse. A standing refusal disables the confirm on
            // every mode but force (the one that bypasses it); the reason sits
            // in the Blocked row above and describes the control. This is a
            // server-side interlock, not form validation, so ruling 147's
            // enabled-until-busy rule does not apply — which is exactly why it
            // needs the refusal to BE the server's own (`blockedReasonAuthoritative`).
            disabled={busy || (interlocked && !force)}
            aria-describedby={blockedReason && !force ? BLOCKED_ROW_ID : undefined}
            onClick={() => commit(() => onConfirm(disclosure))}
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
