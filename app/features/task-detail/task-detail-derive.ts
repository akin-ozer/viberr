import type { TaskDetail } from "~/server/projections/task-query.server";
import type { AcceptanceAffordance } from "~/server/tasks/task-acceptance.server";
import type { CompletionView } from "~/server/tasks/completion-packet.server";
import type { TaskSummary } from "~/shared/mapping/task.server";
import { asProjectRole, roleCan } from "~/shared/rbac";
import { isRepositoryOptionKind } from "~/shared/repository-ask";
import type { EpicOption } from "~/ui/epic-chip";
import type { CompletionDiff, CompletionResult } from "./completion-packet";
import type { PacketArchiveDisclosure } from "./decision-packet";
import type { DeployedSpecialistView } from "./execution-profile";
import type { RecommendationView } from "./operator-recommendations";
import { reachesAcceptance } from "./reaches-acceptance";
import type { OpenCeremony } from "./task-detail-actions";

/**
 * What the task page reads off its props before it draws (ruling 13(b), the
 * pilot split of `task-detail-page.tsx`): the viewer's authority on this task,
 * whether it is closed for work, where the completion packet stands and which
 * surface carries the delivered changes, and the GitHub panel's doors. Pure
 * functions of the loader data, no React; the page or one of its regions
 * calls each at most once per render.
 */

/** Ruling 325: the task's epic, read from the project's list the loader
 *  ships (one statement); a stale id no epic answers to draws no field. */
export function epicOf(task: TaskDetail, epics: EpicOption[]): EpicOption | null {
  return task.epicId ? (epics.find((e) => e.id === task.epicId) ?? null) : null;
}

/** The workflow's last stage: a move into it, or a recommendation that reaches
 *  it, is an acceptance (F19-37, F19-3). Null for a task with no stages. */
export function lastStageId(task: TaskDetail): string | null {
  return task.stages.length > 0 ? task.stages[task.stages.length - 1]!.id : null;
}

/** Terminal-stage OR archived task — closed for new work (comments stay open,
 *  R7-6). F15-11: archived tasks used to keep every live control. The task
 *  page and the execution profile's controls (G9) both read it. */
export function isClosedForWork(task: TaskSummary, archived: boolean): boolean {
  return (
    task.displayReadiness === "accepted" ||
    task.displayReadiness === "merged" ||
    archived
  );
}

/**
 * Ruling 228: a task whose deliverer cannot write the repository is
 * delivered as files and has no branch, before the delivery as after it.
 * Ruling 199: and so is every task of a project with no repository, before
 * anyone is engaged on it.
 */
export function filesDeliveryOf(
  task: TaskDetail,
  filesDeliveredAt: string | null,
  deployedSpecialists: DeployedSpecialistView[],
): "delivered" | "expected" | null {
  const deliverer = deployedSpecialists.find((s) => s.id === task.specialist?.profileId);
  return filesDeliveredAt
    ? ("delivered" as const)
    : task.repo === null || deliverer?.capabilities?.delivery === false
      ? ("expected" as const)
      : null;
}

/** The viewer's authority on THIS task, each flag asking for the action the
 *  server enforces; the server re-checks every one. */
export interface TaskPermissions {
  /** Agent affordances and the recommendations (contracts §3.2). */
  canRunAgents: boolean;
  /** E3: `update-goal`, the grant `updateTaskGoal` enforces. */
  canEditGoal: boolean;
  canEditMeta: boolean;
  /** M2 / R14-2: admin|maintainer OR the task owner. */
  canResolvePacket: boolean;
  /** P14-GV-01/R14-2: the owner governs every decision on their own task. */
  canDecideOwned: boolean;
  /** The `archive_task` (and `discard_branch`, `move_stage`) option's tier. */
  canArchiveViaPacket: boolean;
  /** Ruling 131: the `force_accept` option's tier. */
  canForceAcceptViaPacket: boolean;
  /** Ruling 65: the repository question's tier. */
  canEditPolicy: boolean;
  /** F20-18 / ruling 65: hand the decision up instead of being stranded. */
  canEscalatePacket: boolean;
  /** F39-6 / ruling 76: attach a file; an archived task takes no edits. */
  canAttach: boolean;
  canRemoveFromRecord: boolean;
}

export function taskPermissions(
  myRole: string | null,
  task: TaskDetail,
  meId: string,
  archived: boolean,
): TaskPermissions {
  // Agent affordances (assign/run specialist, reviewers, operator, apply
  // recommendation) are admin|maintainer (contracts §3.2); server re-checks
  // RBAC. The execution mutations live in ExecutionSection; applying a
  // recommendation is page-owned (F19-3 — an Apply can be an acceptance).
  const role = asProjectRole(myRole);
  const canRunAgents = roleCan(role, "run-agents");
  const canOwn = roleCan(role, "own-task");
  // E3: ask for the action the SERVER enforces, not a neighbouring one.
  // `updateTaskGoal` requires `update-goal`; this read `run-agents`, which
  // agrees today only because the matrix happens to line up — a role change to
  // either row silently desyncs the button from the endpoint behind it.
  const canEditGoal = roleCan(role, "update-goal");
  const canEditMeta = roleCan(role, "edit-task-meta");
  // The viewer may resolve THIS packet when they're admin|maintainer OR the
  // task owner (M2 / owner ruling Q2, WIDENED by R14-2). The owner bypass
  // requires `own-task` (contributor+): the server's owner check does too, so a
  // demoted viewer-owner must NOT be shown resolve options that would 403
  // (matches releaseOwner's own-task gate).
  const isOwner =
    task.owner?.kind === "human" && task.owner.userId === meId && canOwn;
  const canResolvePacket = canRunAgents || isOwner;
  // P14-GV-01/R14-2: acceptance carries the owner exception (R6-2) on the
  // server, and since R14-2 so do apply/dismiss — the owner governs EVERY
  // decision on their own task. This flag used to be `canRunAgents` alone, so a
  // contributor-owner was counted "waiting on you" by the decisions inbox and
  // then shown a blocked Accept option and disabled recommendation buttons.
  const canDecideOwned = canRunAgents || isOwner;
  // An `archive_task` packet option runs the R14-3 archive, whose authority is
  // the board-management tier (`approve-transition`) — NOT the packet-resolver
  // set. A contributor-owner may resolve the packet but not this option, so the
  // card blocks it with the reason instead of 403ing on click (same treatment
  // as edit_goal / accept_completion).
  const canArchiveViaPacket = roleCan(role, "approve-transition");
  // Ruling 131 (pass 35, F35-14): a `force_accept` packet option performs the
  // admin override itself, whose tier is `force-accept-completion` (admin) —
  // NOT the packet-resolver set and not the archive tier. Same treatment as its
  // siblings: the card blocks the option with the reason instead of letting a
  // maintainer click into the server's refusal.
  const canForceAcceptViaPacket = roleCan(role, "force-accept-completion");
  const canEditPolicy = roleCan(role, "edit-policy");
  // F20-18: a contributor-OWNER may open the packet (owner exception) but every
  // option re-checks a higher tier — hand the decision UP to a maintainer/admin
  // instead of stranding them. The server (requestPacketMaintainerDecision)
  // refuses when the caller already holds `resolve-packet`, so this is wired
  // only for the owner-who-cannot-resolve-directly case.
  // Ruling 65: the repository question is a project admin's, so a maintainer
  // is stranded on it too, and sends it up the same way.
  const packetOptions = task.packet?.options ?? [];
  const boardDecision =
    packetOptions.length > 0 && packetOptions.every((o) => isRepositoryOptionKind(o.kind));
  const canEscalatePacket = boardDecision
    ? canResolvePacket && !canEditPolicy
    : isOwner && !canRunAgents;
  return {
    canRunAgents,
    canEditGoal,
    canEditMeta,
    canResolvePacket,
    canDecideOwned,
    canArchiveViaPacket,
    canForceAcceptViaPacket,
    canEditPolicy,
    canEscalatePacket,
    // F39-6: a contributor and above may attach a file, and an archived task
    // takes no edits (the server refuses either way — this is what stops a
    // person meeting the refusal).
    canAttach: roleCan(role, "attach-file") && !archived,
    canRemoveFromRecord: roleCan(role, "remove-from-record"),
  };
}

/** Ruling 316: where the completion packet stands on the page. */
export interface CompletionPlacement {
  /** The open packet offers the acceptance, so the card rides inside it. */
  acceptanceDecision: boolean;
  /** Ruling 103: the accepted task's card, shown as its result. */
  resultShown: boolean;
  /** The completion while its card shows, else null. */
  card: CompletionView | null;
}

/**
 * Ruling 316: the completion packet stands where the task is offered for
 * acceptance: inside the decision whose option offers it, else on its own
 * card at the top of the main column while an acceptance card waits below
 * or the task stands at the boundary with a packet written. Ruling 103: and
 * on an accepted task it stays there as the result, archived or not.
 */
export function completionPlacement(
  task: TaskDetail,
  completion: CompletionView | null,
  recommendations: RecommendationView[],
  acceptance: AcceptanceAffordance,
  taskClosed: boolean,
  terminalStageId: string | null,
): CompletionPlacement {
  const acceptanceDecision =
    task.packet?.options.some((o) => o.kind === "accept_completion") ?? false;
  const resultShown =
    terminalStageId !== null && task.stage === terminalStageId && completion?.packet != null;
  const completionShown =
    resultShown ||
    (completion !== null &&
      !taskClosed &&
      (acceptanceDecision ||
        recommendations.some((r) => reachesAcceptance(r, terminalStageId)) ||
        (acceptance.atBoundary && completion.packet !== null)));
  return { acceptanceDecision, resultShown, card: completionShown ? completion : null };
}

/** The Changes panel's reader rides inside the packet while it shows, so the
 *  page carries one reader (and one set of unsent notes), not two. */
export function completionReader(
  task: TaskDetail,
  cardShown: boolean,
  changesUrl: string | null,
  workRevisionSha: string | null,
  githubHost: string,
): CompletionDiff | null {
  const diffReadable = changesUrl !== null && task.pr?.state === "review" && workRevisionSha !== null;
  return cardShown && diffReadable && task.pr
    ? {
        url: changesUrl,
        githubHost,
        prNumber: task.pr.number,
        revisionSha: workRevisionSha,
        delivererName: task.specialist?.profileName ?? null,
      }
    : null;
}

/**
 * Ruling 315 (F40-54): the delivered revision's files and patches, with a
 * note on any line going to the deliverer as one comment. Only while the
 * review PR is open and carries a delivered revision; the reader is its own
 * chunk, loaded when the panel opens. Ruling 316: not while the completion
 * packet carries the same reader.
 */
export function changesPanelReader(
  task: TaskDetail,
  changesUrl: string | null,
  workRevisionSha: string | null,
  githubHost: string,
  completionDiff: CompletionDiff | null,
): CompletionDiff | null {
  return changesUrl && task.pr?.state === "review" && workRevisionSha && !completionDiff
    ? {
        url: changesUrl,
        githubHost,
        prNumber: task.pr.number,
        revisionSha: workRevisionSha,
        delivererName: task.specialist?.profileName ?? null,
      }
    : null;
}

/** Ruling 103: the completion card as the accepted task's result. */
export function acceptedResult(task: TaskDetail, githubHost: string): CompletionResult {
  return {
    pr: task.pr
      ? {
          number: task.pr.number,
          url: task.repo ? `${githubHost}/${task.repo}/pull/${task.pr.number}` : null,
          merged: task.pr.state === "merged",
        }
      : null,
  };
}

/**
 * UX19-9: what an `archive_task` resolution destroys — the branch
 * its `deleteBranch` variant deletes permanently, and the
 * recommendations the archive withdraws. The same two facts
 * ArchiveConfirm is handed. F31-6 adds the unowned PR the
 * `resolve_remote_collision` ceremony closes, which lives on the
 * same task the other three are read off.
 */
export function packetArchiveDisclosure(
  task: TaskDetail,
  pendingRecommendations: number,
): PacketArchiveDisclosure {
  return {
    taskKey: task.key,
    branch: task.branch,
    pendingRecommendations,
    unownedPr: task.unownedPr,
    // C3 (pass 34, U34-8): the SAME predicate `deleteTaskRemoteBranch`
    // refuses on, so the dialog warns before the click instead of the
    // server refusing after it.
    openPr:
      task.pr && (task.pr.state === "review" || task.pr.state === "accepted")
        ? task.pr.number
        : null,
    // Ruling 234 (U35-8): what origin's branch holds when it is not
    // this task's work, so the delete-branch row says so.
    foreignHead: task.foreignHead,
  };
}

/** The GitHub panel's optional doors; an absent one draws no button. */
export interface GithubTraceDoors {
  onCompleteMerge?: () => void;
  onForceAccept?: () => void;
  onRunGates?: () => void;
  onDeliver?: () => void;
}

/**
 * The GitHub panel's doors. Complete merge and Force accept open the one
 * acceptance ceremony (F19-24: the panel never holds the submit itself); Run
 * gates (ruling 104) and Deliver (R15-2 safety net (b)) post straight away,
 * for a viewer who may deliver while the task is open.
 */
export function githubTraceDoors(inputs: {
  canCompleteMerge: boolean;
  canForceAccept: boolean;
  canDeliver: boolean;
  taskClosed: boolean;
  filesDeliveredAt: string | null;
  openCeremony: OpenCeremony;
  onRunGates: () => void;
  onDeliver: () => void;
}): GithubTraceDoors {
  const { openCeremony } = inputs;
  const doors: GithubTraceDoors = {};
  if (inputs.canCompleteMerge) {
    doors.onCompleteMerge = () => openCeremony({ mode: "complete-merge" });
  }
  if (inputs.canForceAccept) doors.onForceAccept = () => openCeremony({ mode: "force" });
  if (inputs.canDeliver && !inputs.taskClosed) doors.onRunGates = inputs.onRunGates;
  // Ruling 102: a delivery that is files has no branch to push.
  if (inputs.canDeliver && !inputs.taskClosed && !inputs.filesDeliveredAt) {
    doors.onDeliver = inputs.onDeliver;
  }
  return doors;
}
