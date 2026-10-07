import { prStatePill, type PillView } from "~/features/github/github-pills";
import type { PrRef } from "~/schemas/task-file.schema";
import type { AcceptanceDisclosure } from "~/shared/acceptance-disclosure";
import { describeRevisionDrift, type RevisionDriftDescription } from "~/shared/revision-drift";
import type { IconName } from "~/ui/icon";
import type { AcceptCeremony, AcceptCeremonyMode, AcceptConfirmTask } from "./accept-confirm";

/**
 * What the acceptance ceremony reads off its props before it draws (ruling
 * 695(e), the split of `accept-confirm.tsx` along the task-page recipe): which
 * writer is asking, what the click jumps, what merges, what it refreshes, and
 * the sentences its heading, footer and confirm say. Pure functions of the
 * props, no React; `AcceptConfirm` calls each once per render.
 */

export function headingFor(mode: AcceptCeremonyMode, terminalName: string): string {
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

export interface CeremonyFacts {
  mode: AcceptCeremonyMode;
  force: boolean;
  /** `complete-merge`: the merge-pending half of an acceptance (R16-6). */
  mergeOnly: boolean;
  interlocked: boolean;
  /** The project's last stage by name, "Done" for a workflow with none. */
  terminalName: string;
  subjectKey: string | undefined;
  skipsStages: boolean;
  skippedStages: string[];
  drift: RevisionDriftDescription;
  prPill: PillView | null;
  alreadyMerged: boolean;
  /** The branch this click brings up to date with its base, or null. */
  refreshedBranch: string | null;
  /** Ruling 449's handler, where the dialog offers it, or null. */
  refreshFirst: (() => void) | null;
  disclosure: AcceptanceDisclosure;
  /** The glyph the head and the confirm both draw. */
  glyph: IconName;
}

export function ceremonyFacts({
  task,
  ceremony,
  atBoundary,
  blockedReason,
  blockedReasonAuthoritative,
  workRevisionSha,
  baseBehindBy,
  onRefreshFirst,
}: {
  task: AcceptConfirmTask;
  ceremony: AcceptCeremony;
  atBoundary: boolean;
  blockedReason: string | null;
  blockedReasonAuthoritative: boolean;
  workRevisionSha: string | null;
  baseBehindBy: number | null;
  onRefreshFirst: (() => void) | undefined;
}): CeremonyFacts {
  const mode = ceremony.mode;
  const force = mode === "force";
  // Ruling 162's interlock, and only where the quoted refusal is the one the
  // server will re-decide (see `blockedReasonAuthoritative`).
  const interlocked = blockedReason !== null && blockedReasonAuthoritative;
  const mergeOnly = mode === "complete-merge";
  const terminalName =
    task.stages.length > 0 ? task.stages[task.stages.length - 1]!.name : "Done";
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
  // off-boundary task is REFUSED, not jumped — the dialog's "Blocked" row is
  // what actually happens — so claiming a skip would promise a power the click
  // does not have. Two earlier rounds got this wrong in two different ways, both of
  // them false in 100% of the cases they fired:
  // - `mode === "stage-move" && !atBoundary`: a stage move READS like a jump and
  //   is not one. `transitionStage` routes a manual move into the LAST stage to
  //   `acceptCompletion` WITHOUT `force`, so `acceptanceStageBlockedReason`
  //   refuses any off-boundary stage with a 409 and the task stays where it was
  //   (proven by the standing server test `acceptance-graph.server.test.ts` →
  //   "refuses a manual board move from Triage straight to Done"). `atBoundary`
  //   is literally that same predicate (`acceptanceStanding` sets it
  //   from `acceptanceStageBlockedReason === null`), so the disjunct rendered
  //   "goes straight to Done" directly beside the "Blocked" row quoting the
  //   refusal that contradicts it.
  // - a bare `!atBoundary`: `complete-merge` is the sharpest case, because
  //   `acceptanceStanding` returns its `denied` shape (`atBoundary:
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
  return {
    mode,
    force,
    mergeOnly,
    interlocked,
    terminalName,
    subjectKey: subjectKeyFor(mode),
    skipsStages,
    skippedStages,
    // Ruling 132: the one canonical sentence for what moved on the PR head.
    drift: describeRevisionDrift(pr?.revisionDrift),
    // F19-14: the raw internal token ("accepted", "review") leaked into this
    // dialog while every other surface renders the canonical label through the one
    // PR-state map (ruling 12). "PR #12 accepted" and "PR #12 merge pending" are
    // the same fact under two vocabularies, on the screen that decides the merge.
    prPill: pr ? prStatePill(pr.state) : null,
    alreadyMerged,
    // Ruling 162 / G35-5(d): the branch the ceremony's base refresh writes to,
    // which the Branch row names (its slot in `AcceptConfirm` says why);
    // never on `complete-merge`, whose path refreshes nothing.
    refreshedBranch: !mergeOnly && task.branch && refreshedPr ? task.branch : null,
    // Ruling 449 (O39-c): offered only where the caller passes it (the task
    // page's direct Accept), never on force or the merge-only path, and only
    // while the branch is behind its base.
    refreshFirst:
      onRefreshFirst && !force && !mergeOnly && baseBehindBy !== null && baseBehindBy > 0
        ? onRefreshFirst
        : null,
    // Ruling 88 (F21-2): exactly what three of the dialog's rows state — the
    // PR behind the "Merges" pill, the sha on the "Revision" row, the value the
    // "Verdict" pill renders. Built here, from the rendered props, so the
    // acknowledgment the server verifies is the disclosure the human actually
    // read.
    disclosure: {
      pr: pr?.state ?? "none",
      revision: workRevisionSha ?? "none",
      verdict: task.validation,
    },
    glyph: force ? "shield" : mergeOnly ? "github" : "check",
  };
}

/** The dialog's accessible name: which writer is asking, about which task. */
export function ceremonyLabel(facts: CeremonyFacts, taskKey: string): string {
  return (
    (facts.force
      ? "Force-accept "
      : facts.mergeOnly
        ? "Complete the merge for "
        : facts.mode === "stage-move"
          ? `Accept by moving to ${facts.terminalName}: `
          : "Accept ") + taskKey
  );
}

/** The foot's one sentence: what the click records, and whether it merges. */
export function footHint(
  facts: CeremonyFacts,
  blockedGates: readonly string[],
  pr: PrRef | null,
): string {
  return facts.force
    ? // Ruling 638: the count the Bypassing row above lists.
      blockedGates.length > 1
      ? "Admin override. The bypassed gates are recorded to the audit log."
      : "Admin override. The bypassed gate is recorded to the audit log."
    : // F21-23: before the one-way warning, because a PR GitHub already
      // merged is not one-way from HERE — there is nothing left to do
      // that could be undone, and warning about it invents a decision.
      facts.alreadyMerged
      ? // The `complete-merge` arm is the one where nothing at all is
        // left: its task was already accepted (that is what stamped the
        // PR "accepted"), so the completion is already on the timeline
        // and the server settles this click as a no-op. Every OTHER mode
        // still performs the acceptance itself — it just performs it
        // without a merge — so only this arm may say nothing is written.
        facts.mergeOnly
        ? "Nothing merges: the pull request was already merged on GitHub. Nothing is written either, because this task's completion is already on the timeline."
        : "Nothing merges: the pull request was already merged on GitHub. The completion event is recorded on the timeline."
      : facts.mergeOnly
        ? "Merging is one-way. The merge and its result are recorded on the timeline."
        : pr
          ? "Merging is one-way. The completion event and the merge are recorded on the timeline."
          : "The completion event is recorded on the timeline. Nothing is merged: this task has no pull request.";
}

/** The confirm's label: the writer's verb, and the merge it performs. */
export function confirmLabel(
  facts: CeremonyFacts,
  taskKey: string,
  pr: PrRef | null,
  defaultBranch: string,
): string {
  return facts.force
    ? `Force-accept ${taskKey}`
    : facts.mergeOnly
      ? // F21-23: the merge-pending path can find the PR merged out of
        // band between the recommendation and this click. "Merge PR
        // #172 into main" would name work GitHub has already done.
        facts.alreadyMerged
        ? `Finish accepting ${taskKey}`
        : pr
          ? `Merge PR #${pr.number} into ${defaultBranch}`
          : "Run the merge"
      : `${
          facts.mode === "apply-recommendation"
            ? "Apply"
            : facts.mode === "stage-move"
              ? "Move"
              : "Accept"
        } → ${facts.terminalName}${pr && !facts.alreadyMerged ? " & merge" : ""}`;
}
