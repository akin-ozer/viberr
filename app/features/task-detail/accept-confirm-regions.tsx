import { checksPill, gatesPill, type PillView } from "~/features/github/github-pills";
import type { PrRef, Validation } from "~/schemas/task-file.schema";
import type { AcceptanceDisclosure } from "~/shared/acceptance-disclosure";
import type { PrChecksRender } from "~/shared/mapping/task.server";
import type { PrOverlap } from "~/shared/pr-overlaps";
import type { GatesView } from "~/shared/project-gates";
import type { RevisionDriftDescription } from "~/shared/revision-drift";
import { Icon, type IconName } from "~/ui/icon";
import { Pill, ValidationPill } from "~/ui/pill";
import type { AcceptConfirmTask } from "./accept-confirm";
import { GateResults } from "./gate-results";

/**
 * The acceptance ceremony's rows and its foot (ruling 13(b), the split of
 * `accept-confirm.tsx` along the task-page recipe). Each takes the slot its
 * markup held in `AcceptConfirm`'s row list and calls no hook: the dialog owns
 * `useDialog` and hands the foot its `close` and `commit`, so the markup, and
 * every id React derives from its place in the tree, are what they were.
 */

/** The Blocked row's id, so the disabled confirm can be described by it. */
const BLOCKED_ROW_ID = "accept-confirm-blocked";

/** Paths named per colliding PR before the rest are counted. */
const COLLIDES_PATHS_SHOWN = 3;

/** What merges: the pull request (and its checks), or the reason nothing does. */
export function MergesRow({
  task,
  prPill,
  defaultBranch,
  noChanges,
  filesDeliveredAt,
  noPullRequest,
  force,
}: {
  task: AcceptConfirmTask;
  prPill: PillView | null;
  defaultBranch: string;
  noChanges: boolean;
  filesDeliveredAt: string | null;
  noPullRequest: boolean;
  force: boolean;
}) {
  const pr = task.pr;
  return (
    <div className="obs">
      <span className="k">Merges</span>
      <span>
        {pr && prPill ? (
          <PrMerges pr={pr} prPill={prPill} defaultBranch={defaultBranch} prChecks={task.prChecks} />
        ) : noChanges ? (
          // F19-21 opened a SECOND no-change shape and this row asserted
          // the first one's cause at both: a verification-only task never
          // had a branch to be empty, so "the branch is empty" was simply
          // false on the dialog that authorizes the close. Say what is
          // true of the task in hand — the branch when there is one, its
          // absence when there is not. Ruling 316: and no outcome name,
          // since "no changes" is false of a task that corrected a
          // knowledge base; this row says only what merges.
          <NoChangeMerges taskKey={task.key} branch={task.branch} />
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
          <AutoDetectMerges branch={task.branch} />
        ) : (
          <>No linked pull request. The task closes without a merge.</>
        )}
      </span>
    </div>
  );
}

function PrMerges({
  pr,
  prPill,
  defaultBranch,
  prChecks,
}: {
  pr: PrRef;
  prPill: PillView;
  defaultBranch: string;
  prChecks: PrChecksRender | null;
}) {
  return (
    <>
      <Pill kind={prPill.kind} sm>
        PR #{pr.number} · {prPill.label}
      </Pill>{" "}
      into <span className="mono">{defaultBranch}</span>
      {/* Ruling 97: this row names the door; ruling 260's rule is
          that it also says whether the door is open. The checks
          pill was one panel up on the page and absent from the
          dialog that authorizes an irreversible merge. */}
      {prChecks && prChecks.state !== "passing" ? (
        <>
          {" "}
          <Pill kind={checksPill(prChecks).kind} sm>
            {checksPill(prChecks).label}
          </Pill>{" "}
          <span className="pol-note">
            {prChecks.state === "failing"
              ? "Checks are not a gate here, the review verdicts are, so this merge is not blocked by them. Merging anyway is your call."
              : prChecks.state === "pending"
                ? "Checks have not finished. Merging now does not wait for them."
                : "GitHub reported no conclusive check result for this head."}
          </span>
        </>
      ) : null}
    </>
  );
}

function NoChangeMerges({ taskKey, branch }: { taskKey: string; branch: string | null }) {
  return (
    <>
      Nothing.{" "}
      {branch ? (
        <>
          <span className="mono">{branch}</span> carries no
          commits, so no pull request was opened.
        </>
      ) : (
        <>
          {taskKey} never opened a branch or a pull request.
          Nothing merges.
        </>
      )}
    </>
  );
}

function AutoDetectMerges({ branch }: { branch: string | null }) {
  return (
    <>
      <strong>Nothing to merge yet.</strong> This task has no review
      pull request. Accepting re-checks{" "}
      {branch ? (
        <span className="mono">{branch}</span>
      ) : (
        "the branch"
      )}{" "}
      on GitHub: if it carries no commits the task closes with
      nothing merged; if it carries work the acceptance is refused
      and says how many commits.
    </>
  );
}

/** The base refresh this click performs on the branch (ruling 95). */
export function BranchRow({
  branch,
  defaultBranch,
  baseBehindBy,
  refreshFirstOffered,
}: {
  branch: string;
  defaultBranch: string;
  baseBehindBy: number | null;
  refreshFirstOffered: boolean;
}) {
  return (
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
            <span className="mono">{branch}</span> carried{" "}
            <span className="mono">{defaultBranch}</span> at the last
            GitHub check, so the reviewed head merges as it is. If{" "}
            <span className="mono">{defaultBranch}</span> moves before
            you confirm, the merge that brings it in is pushed to the
            branch first.
          </>
        ) : baseBehindBy !== null && baseBehindBy > 0 ? (
          <>
            <span className="mono">{branch}</span> is{" "}
            {baseBehindBy === 1 ? "1 commit" : `${baseBehindBy} commits`}{" "}
            behind <span className="mono">{defaultBranch}</span> at the
            last GitHub check. Accepting merges{" "}
            {baseBehindBy === 1 ? "it" : "them"} into the branch first
            and pushes that merge commit, which becomes the merge head.
            No review has run on that combination.
            {refreshFirstOffered
              ? " Update the branch and re-review first runs the review on it before anything merges."
              : ""}
          </>
        ) : (
          <>
            <span className="mono">{branch}</span> is brought up to
            date with <span className="mono">{defaultBranch}</span> first.
            If the base has moved, that merge commit is pushed to the
            branch and becomes the merge head.
          </>
        )}
      </span>
    </div>
  );
}

/**
 * Ruling 244 (F40-55 (c)): "Merging this will likely put WEB-2's PR #3 in
 * conflict on `package.json`." Live on akinozer-com the owner accepted WEB-4
 * while WEB-2's open PR changed the same file; Viberr knew, the dialog was
 * silent, and WEB-2's acceptance was refused a minute later. The row names
 * each PR and the shared paths, and what Viberr does after the merge.
 */
export function CollidesRow({ collisions }: { collisions: readonly PrOverlap[] }) {
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

/** The delivered revision the acceptance is made against. */
export function RevisionRow({
  workRevisionSha,
  filesDeliveredAt,
}: {
  workRevisionSha: string | null;
  filesDeliveredAt: string | null;
}) {
  return (
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
  );
}

/** R17-1: the PR head that actually merges, where it moved past the review. */
export function MergeHeadRow({
  headSha,
  drift,
}: {
  headSha: string;
  drift: RevisionDriftDescription;
}) {
  return (
    // Ruling 239 (pass 34, F34-14): ONE sentence, printed verbatim from
    // `describeRevisionDrift` — a base refresh reads as a base refresh
    // (`obs`, not `warn`), only authored commits read as unreviewed.
    <div className={drift.unreviewed ? "obs warn" : "obs"}>
      <span className="k">Merge head</span>
      <span>
        <span className="mono">
          {headSha.slice(0, 12)}
        </span>{" "}
        · {drift.sentence}
      </span>
    </div>
  );
}

/** The verdict the acceptance carries, and whose approval cleared it. */
export function CeremonyVerdictRow({
  validation,
  verdictSatisfiedBy,
}: {
  validation: Validation;
  verdictSatisfiedBy: string | null;
}) {
  return (
    <div className="obs">
      <span className="k">Verdict</span>
      <span>
        <ValidationPill value={validation} />
        {/* R19-B: the R15-1 verdict gate can be cleared by a human's
            GitHub approval rather than an agent verdict. The pill goes
            green either way, so name the person and the commit they
            approved — a gate a human satisfied cannot pass silently
            (ruling 220). */}
        {verdictSatisfiedBy && (
          <span className="fine"> · {verdictSatisfiedBy}</span>
        )}
      </span>
    </div>
  );
}

/** Ruling 315 (F40-52): Viberr's own gate run on the accepted revision. */
export function GatesRow({ gates }: { gates: GatesView }) {
  return (
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
  );
}

/** R19-5: the stages and the review gate a force-accept jumps. */
export function SkipsRow({
  skippedStages,
  taskKey,
  terminalName,
  pr,
}: {
  skippedStages: string[];
  taskKey: string;
  terminalName: string;
  pr: PrRef | null;
}) {
  return (
    <div className="obs warn">
      <span className="k">Skips</span>
      <span>
        {skippedStages.length > 0 && (
          <>
            <strong>{skippedStages.join(" → ")}</strong>, and{" "}
          </>
        )}
        {skippedStages.length > 0 ? "the" : "The"} review gate:{" "}
        {taskKey} goes straight to {terminalName}
        {pr ? " and the pull request merges" : ""}.
      </span>
    </div>
  );
}

/** The standing refusal: what force bypasses, or what blocks every other mode. */
export function RefusalRow({
  force,
  blockedReason,
  blockedGates,
}: {
  force: boolean;
  blockedReason: string;
  blockedGates: readonly string[];
}) {
  return (
    <div className="obs" id={BLOCKED_ROW_ID}>
      {/* Only force-accept BYPASSES a refusal. On every other path a
          standing refusal means the server will refuse this click —
          saying "Bypassing" there would promise an override nobody has.
          Ruling 95 (pass 35): that click is not offered either; the
          confirm below is disabled and described by this row. */}
      <span className="k">{force ? "Bypassing" : "Blocked"}</span>
      {/* Ruling 98: on the FORCE path every gate, because that is what
          the audit row and the completion event will say it bypassed.
          Everywhere else the first one is the refusal, and a list would
          be noise about a click the server is going to refuse anyway. */}
      {force && blockedGates.length > 1 ? (
        <ul>
          {blockedGates.map((gate) => (
            <li key={gate}>{gate}</li>
          ))}
        </ul>
      ) : (
        <span>{blockedReason}</span>
      )}
    </div>
  );
}

/** The open decision this acceptance answers (ruling 316) or withdraws (F32-11). */
export function OpenDecisionRow({
  title,
  answersWith,
}: {
  title: string;
  answersWith: string | null;
}) {
  return answersWith ? (
    <div className="obs">
      {/* Ruling 316: the decision offers the option this acceptance
          performs, so the acceptance IS its answer, recorded the way
          the packet's own confirm records it. */}
      <span className="k">Answers</span>
      <span>
        the open decision "{title}" with "{answersWith}". The
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
        the open decision "{title}". It closes unanswered with the
        task; a timeline note and an audit row record the withdrawal.
      </span>
    </div>
  );
}

/** `.modal-foot`: the sentence on what the click records, and its buttons. */
export function CeremonyFoot({
  hint,
  confirmLabel,
  glyph,
  force,
  interlocked,
  blockedReason,
  busy,
  refreshFirst,
  disclosure,
  onConfirm,
  close,
  commit,
}: {
  hint: string;
  confirmLabel: string;
  glyph: IconName;
  force: boolean;
  interlocked: boolean;
  blockedReason: string | null;
  busy: boolean;
  refreshFirst: (() => void) | null;
  disclosure: AcceptanceDisclosure;
  onConfirm: (disclosure: AcceptanceDisclosure) => void;
  close: () => void;
  commit: (action: () => void) => void;
}) {
  return (
    <div className="modal-foot">
      <span className="foot-hint">{hint}</span>
      <div className="foot-actions">
        <button type="button" className="btn ghost" onClick={close}>
          Not yet
        </button>
        {refreshFirst && (
          // Ruling 97 (O39-c): the head that merges would be one no review
          // ran on. This runs the review on it first; acceptance comes after.
          <button type="button" className="btn" disabled={busy} onClick={() => commit(refreshFirst)}>
            <Icon name="refresh" />
            Update the branch and re-review first
          </button>
        )}
        <button
          type="button"
          className={"btn " + (force ? "danger" : "primary")}
          // Ruling 95 (pass 35, F35-12 (c)): no surface offers an acceptance
          // the gate will refuse. A standing refusal disables the confirm on
          // every mode but force (the one that bypasses it); the reason sits
          // in the Blocked row above and describes the control. This is a
          // server-side interlock, not form validation, so ruling 288's
          // enabled-until-busy rule does not apply — which is exactly why it
          // needs the refusal to BE the server's own (`blockedReasonAuthoritative`).
          disabled={busy || (interlocked && !force)}
          aria-describedby={blockedReason && !force ? BLOCKED_ROW_ID : undefined}
          onClick={() => commit(() => onConfirm(disclosure))}
        >
          <Icon name={glyph} />
          {confirmLabel}
        </button>
      </div>
    </div>
  );
}
