import { holdEntriesSentence, holdRefusal, type DependencyRender } from "~/shared/dependencies";
import type { ActorRender } from "~/shared/mapping/actor.server";
import type { TaskSummary } from "~/shared/mapping/task.server";
import {
  resolveDeclaredStages,
  stageEligible,
  stageIneligibilitySentence,
} from "~/shared/workflow/stage-eligibility";
import { stageName } from "~/shared/workflow/stage-roles";
import type { DeployedSpecialistView, RunDelay, RunInFlight } from "./execution-profile";
import { backendRunRefusal, type TaskRunPrincipalView } from "./run-principal-view";

/**
 * What the execution profile reads off its props before it draws (ruling
 * 689(e), the split of `execution-profile.tsx` along the task page's recipe):
 * who owns the task, what holds the operator's manual run, what a pick on the
 * run-an-agent control would meet (its refusal, its posture, its button's
 * title) and the words on both run buttons. Pure functions of the panel's
 * props and the controls' state, no React; each component calls them at most
 * once per render.
 */

/**
 * Ruling 368: the run button's words. While the control's own request is in
 * flight they say which one it sent, a run now or a scheduled one, because
 * the picker resets to Now on the click; at rest, `runNow` for a run now and
 * "Schedule" once the when-picker leaves Now.
 */
export function runButtonLabel(inFlight: RunInFlight, delay: RunDelay, runNow: string): string {
  return inFlight === "schedule"
    ? "Scheduling…"
    : inFlight === "run"
      ? "Starting…"
      : delay === "now"
        ? runNow
        : "Schedule";
}

/** The task's human owner, or null for an unowned task (or a seat that is not
 *  a person's). */
export function humanOwner(task: TaskSummary): Extract<ActorRender, { kind: "human" }> | null {
  return task.owner && task.owner.kind === "human" ? task.owner : null;
}

/** Ruling 131(d): the run control's hold copy. */
function holdNoteFor(entries: readonly DependencyRender[]): string {
  // Ruling 356: a done entry reads as done, not as still waited on.
  return `Waiting on other work (${holdEntriesSentence(entries)}). A manual run still answers you; the operator will not advance the task or dispatch delivery while it waits.`;
}

/** What holds the operator's manual run on an open task, as the control's
 *  optional props: a key is present only when it holds. */
export interface OperatorRunHold {
  blockedReason?: string;
  holdNote?: string;
}

/**
 * F20-5 (R20-1): the server refuses a MANUAL operator run while a decision
 * packet is open — coordination is paused by the packet, so a run would burn
 * several turns and take no action. Ruling 131(d): a task that waits on other
 * work only notes it beside an enabled Run; an open packet keeps precedence. A
 * closed task's control withdraws instead, so neither applies there.
 */
export function operatorRunHold(task: TaskSummary, closed: boolean): OperatorRunHold {
  const packetOpen = !!task.packet;
  if (packetOpen && !closed) {
    return { blockedReason: "Open decision. Resolve it before running the operator." };
  }
  if (!packetOpen && !closed && task.blockedBy.length > 0) {
    return { holdNote: holdNoteFor(task.blockedBy) };
  }
  return {};
}

/** The operator run button's title: the open packet's refusal, or what the
 *  button does. */
export function operatorRunTitle(blockedReason: string | undefined, delay: RunDelay): string {
  return (
    blockedReason ??
    (delay === "now"
      ? "Run the operator to coordinate this task"
      : "Schedule this operator run")
  );
}

/** The run-an-agent control's pick and the task facts the dispatch gate
 *  answers it from (`AgentRunControl`'s props and state). */
export interface AgentPick {
  /** The picked profile, as the roster holds it now (null = none, or a pick
   *  whose profile left the roster). */
  selected: DeployedSpecialistView | null;
  selectedId: string | null;
  delay: RunDelay;
  /** The run-agent fetcher's request is in flight. */
  busy: boolean;
  taskKey: string;
  blockedBy: readonly DependencyRender[];
  stage: string;
  stages: { id: string; name: string }[];
  workflow: { from: string; to: string }[];
  activeProfileIds: string[];
  runPrincipal: TaskRunPrincipalView | null;
  meId: string;
  deliveringProfileId: string | null;
  engagedSupportingIds: string[];
}

/** What the run-an-agent control says and allows for the pick. */
export interface AgentDispatch {
  /** Why a run NOW would be refused (the hold, the stage, the owner's
   *  backend), or null. */
  runRefusal: string | null;
  /** Ruling 147(a): the start is unavailable. */
  off: boolean;
  /** The posture the dispatch will give the pick, or null. */
  posture: string | null;
  /** The start button's title. */
  title: string;
}

/** U36-10 (pass 36): the refusal the dispatch gate would give the pick at
 *  the task's stage, in the server's own sentence (ruling 133), or null when
 *  the pick's stage scope is unknown or admits the stage. */
function stageRefusal(
  selected: DeployedSpecialistView | null,
  stage: string,
  stages: { id: string; name: string }[],
  workflow: { from: string; to: string }[],
): string | null {
  return selected &&
    selected.stages !== undefined &&
    !stageEligible({ stages: selected.stages, spanAll: selected.spanAll ?? false }, stage, stages, workflow)
    ? stageIneligibilitySentence(
        selected.name,
        stageName(stages, stage),
        resolveDeclaredStages(selected.stages, stages, workflow)
          .map((id) => stageName(stages, id))
          .join(", "),
      )
    : null;
}

/**
 * What the dispatch will make of the pick — said BEFORE the run is spent.
 * An EXISTING engagement keeps its shape server-side, so it decides first
 * (hunt 2026-08-29); capability derivation covers only the unengaged case.
 */
function dispatchPosture(
  selected: DeployedSpecialistView | null,
  ineligible: string | null,
  deliveringProfileId: string | null,
  engagedSupportingIds: string[],
): string | null {
  return !selected
    ? null
    : ineligible
      ? null
      : selected.id === deliveringProfileId
      ? // Ruling 665: a deliverer that cannot write the repository owns no
        // branch. Its delivery is the files it saves (ruling 535).
        selected.capabilities?.delivery === false
        ? "Runs as the delivering agent: its delivery is the files it saves on the task."
        : "Runs as the delivering agent: it owns the branch and PR."
      : engagedSupportingIds.includes(selected.id)
        ? selected.capabilities?.verdict
          ? "Runs as a reviewer (already engaged): its verdict gates acceptance."
          : "Runs as a supporting agent (already engaged)."
        : selected.capabilities?.delivery === false || selected.requiredReviewer
          ? selected.capabilities?.verdict
            ? "Runs as a reviewer: its verdict gates acceptance."
            : "Runs as a supporting agent (no repo write)."
          : deliveringProfileId === null
            ? "Runs as the delivering agent: it owns the branch and PR."
            : "Runs as a supporting agent (another agent owns delivery).";
}

/** The start button's title: what a press would do, or why it cannot. */
function agentRunTitle(
  selected: DeployedSpecialistView | null,
  selectedRunning: boolean,
  delay: RunDelay,
  runRefusal: string | null,
): string {
  return !selected
    ? "Choose an agent first"
    : selectedRunning
      ? "This agent already has a run in progress on this task"
      : delay === "now"
        ? runRefusal ?? `Run ${selected.name} on this task`
        : `Schedule ${selected.name} on this task`;
}

/** The run-an-agent control's refusal, availability, posture and title for
 *  the pick. */
export function agentDispatch(pick: AgentPick): AgentDispatch {
  const { selected, selectedId, delay } = pick;
  const selectedRunning =
    !!selectedId && delay === "now" && pick.activeProfileIds.includes(selectedId);
  // Ruling 127: the picked profile runs on ITS backend, billed to the task
  // owner — so the refusal is per-pick, not per-page. Same split the operator
  // control makes: a run NOW is refused, a SCHEDULED one is not (the owner can
  // connect the backend, or the seat can change hands, before it fires).
  // U36-10 (pass 36): eligibility is resolved here, from the same predicate
  // the dispatch gate applies, so the refusal a person would meet after the
  // click is the one they read before it.
  const ineligible = stageRefusal(selected, pick.stage, pick.stages, pick.workflow);
  // Ruling 186 (pass 37, F37-2): a held task refuses EVERY dispatch server-side,
  // so the control says so before the click. Unlike the per-pick refusals this
  // one does not depend on which agent is chosen — the hold is a fact about the
  // task — so it stands even with nothing picked.
  const held =
    pick.blockedBy.length > 0
      ? // Rulings 355 and 356: the entries carry their states, so the sentence
        // names a dead one as dead and a done one as done.
        holdRefusal(pick.taskKey, pick.blockedBy, "running an agent on it")
      : null;
  const runRefusal = selected
    ? (held ?? ineligible ?? backendRunRefusal(pick.runPrincipal, selected.backend, pick.meId))
    : held;
  // Ruling 147(a): only AVAILABILITY disables the start — a run in flight, a
  // live run on this very profile, or the owner-credential refusal (ruling 127),
  // each of which renders its own reason. An empty pick is validation, so it is
  // refused on the click instead (147(b)); `selectedRunning` and `runRefusal`
  // are both false with nothing picked, so this collapses to `busy` there.
  // `held` rides `runRefusal`, which only bites for a run NOW: a hold can clear
  // on its own (Viberr releases it when the entries finish), so a SCHEDULED run
  // stays offerable exactly as it does for an unconnected backend. If the hold
  // still stands when it fires, `startAgentRun` refuses it there.
  const off =
    pick.busy || selectedRunning || (delay === "now" && !!runRefusal) || !!ineligible;
  return {
    runRefusal,
    off,
    posture: dispatchPosture(selected, ineligible, pick.deliveringProfileId, pick.engagedSupportingIds),
    title: agentRunTitle(selected, selectedRunning, delay, runRefusal),
  };
}
