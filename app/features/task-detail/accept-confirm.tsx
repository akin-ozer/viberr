import type { PrRef, Validation } from "~/schemas/task-file.schema";
import type { AcceptanceDisclosure } from "~/shared/acceptance-disclosure";
import type { PrOverlap } from "~/shared/pr-overlaps";
import type { PrChecksRender } from "~/shared/mapping/task.server";
import type { GatesView } from "~/shared/project-gates";
import { Icon } from "~/ui/icon";
import { useDialog } from "~/ui/use-dialog";
import {
  ceremonyFacts,
  ceremonyLabel,
  confirmLabel,
  footHint,
  headingFor,
} from "./accept-confirm-derive";
import {
  BranchRow,
  CeremonyFoot,
  CeremonyVerdictRow,
  CollidesRow,
  GatesRow,
  MergeHeadRow,
  MergesRow,
  OpenDecisionRow,
  RefusalRow,
  RevisionRow,
  SkipsRow,
} from "./accept-confirm-regions";

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

/** Ruling 696(e): the two list defaults, each the same array on every render.
 *  The rows that read them live in accept-confirm-regions.tsx now; none of
 *  them is memoised, but from here a `[]` built per render would read as one
 *  that defeats a memo (react-doctor's rerender-memo-with-default-value). */
const NO_BLOCKED_GATES: readonly string[] = [];
const NO_MERGE_COLLISIONS: readonly PrOverlap[] = [];

/**
 * Ruling 696(e): the ceremony's props, declared apart from the destructuring
 * that gives them their defaults, so the component body is the ceremony.
 */
interface AcceptConfirmProps {
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
   *  `acceptanceStanding`), so a dialog quoting it may disable its own
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
  blockedGates = NO_BLOCKED_GATES,
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
  mergeCollisions = NO_MERGE_COLLISIONS,
  gates = null,
  onRefreshFirst,
  busy,
  onCancel,
  onConfirm,
}: AcceptConfirmProps) {
  // Ruling 459: both commits leave the way Cancel does (`commit`), and the
  // callers leave the unmount to onCancel.
  const { ref: panelRef, close, commit } = useDialog(onCancel);
  // What the dialog reads off these props (accept-confirm-derive.ts): the
  // writer asking, the stages a force jumps, the PR's state, the branch the
  // click refreshes, and the disclosure the confirmed click echoes (ruling 88).
  const facts = ceremonyFacts({
    task,
    ceremony,
    atBoundary,
    blockedReason,
    blockedReasonAuthoritative,
    workRevisionSha,
    baseBehindBy,
    onRefreshFirst,
  });
  const { force, terminalName, subjectKey, drift } = facts;
  const pr = task.pr;
  return (
    <dialog
      className="modal-card release-card"
      role="alertdialog"
      aria-label={ceremonyLabel(facts, task.key)}
      data-screen-label="Accept completion dialog"
      ref={panelRef}
    >
      <div className="modal-head">
        <span className={"agent-glyph lg" + (force ? " warn" : "")}>
          <Icon name={facts.glyph} />
        </span>
        <div className="mh-main">
          <h2>{headingFor(facts.mode, terminalName)}</h2>
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
          <MergesRow
            task={task}
            prPill={facts.prPill}
            defaultBranch={defaultBranch}
            noChanges={noChanges}
            filesDeliveredAt={filesDeliveredAt}
            noPullRequest={noPullRequest}
            force={force}
          />
          {/* Ruling 162 / G35-5(d): the acceptance ceremony now runs the base
              refresh itself (`refreshBranchForAcceptance`) immediately before
              the gate re-check and the merge — the same workspace merge
              `update_branch_from_base` performs, pushed to origin. That is a
              WRITE to the person's branch on GitHub, made by this click, and
              the dialog is the ruling-88 disclosure: it may not stay silent
              about it, and the "Merge head" row below is the sha the refresh
              supersedes when the base has moved. `complete-merge` is excluded
              because its path (`completeTaskMerge`) merges the PR without the
              ceremony, so nothing refreshes there (`refreshedBranch`). */}
          {facts.refreshedBranch && (
            <BranchRow
              branch={facts.refreshedBranch}
              defaultBranch={defaultBranch}
              baseBehindBy={baseBehindBy}
              refreshFirstOffered={facts.refreshFirst !== null}
            />
          )}
          {/* Ruling 475 (F40-55 (c)): the pull requests this merge will
              likely put in conflict, named before the click rather than found
              by the next person's refused Accept. Only where a merge happens. */}
          {pr && !facts.alreadyMerged && mergeCollisions.length > 0 && (
            <CollidesRow collisions={mergeCollisions} />
          )}
          <RevisionRow workRevisionSha={workRevisionSha} filesDeliveredAt={filesDeliveredAt} />
          {/* R17-1 (F17-L12): the PR head moved AHEAD of the reviewed revision
              since the review — accepting still merges an ahead head, but the
              human must see that those extra commits ship unreviewed and that
              the merge head is NOT the revision pinned above. F19-24: this is
              the disclosure the bare "Complete merge" click never made, on the
              path that merges LAST — the one most likely to have drifted. */}
          {drift.kind !== "none" && pr?.revisionDrift && (
            <MergeHeadRow headSha={pr.revisionDrift.headSha} drift={drift} />
          )}
          <CeremonyVerdictRow validation={task.validation} verdictSatisfiedBy={verdictSatisfiedBy} />
          {/* Ruling 482 (F40-52): the owner accepted two production deploys on
              agents' reports of the gate exit codes. This row is the server's
              own run, bound to the sha on the Revision row above. A failure
              also stands in the Blocked row below, because it refuses a plain
              acceptance; force accept records it as bypassed. */}
          {gates && <GatesRow gates={gates} />}
          {/* R19-5: the skip is allowed — being quiet about it is not. Name the
              stages this jump goes past, in order, plus the review gate; the
              Force accept button that opened this dialog says the same thing in
              short form ("skips the remaining stages and the review gate").
              Force-only by construction (see `skipsStages` in
              accept-confirm-derive.ts): no other mode can jump, so no other mode
              may print this row. */}
          {facts.skipsStages && (
            <SkipsRow
              skippedStages={facts.skippedStages}
              taskKey={task.key}
              terminalName={terminalName}
              pr={pr}
            />
          )}
          {blockedReason && (
            <RefusalRow force={force} blockedReason={blockedReason} blockedGates={blockedGates} />
          )}
          {openPacketTitle && <OpenDecisionRow title={openPacketTitle} answersWith={answersWith} />}
        </div>
      </div>
      <CeremonyFoot
        hint={footHint(facts, blockedGates, pr)}
        confirmLabel={confirmLabel(facts, task.key, pr, defaultBranch)}
        glyph={facts.glyph}
        force={force}
        interlocked={facts.interlocked}
        blockedReason={blockedReason}
        busy={busy}
        refreshFirst={facts.refreshFirst}
        disclosure={facts.disclosure}
        onConfirm={onConfirm}
        close={close}
        commit={commit}
      />
    </dialog>
  );
}
