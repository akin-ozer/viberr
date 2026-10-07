import { AcceptConfirm } from "~/features/task-detail/accept-confirm";
import {
  archivedTaskBlockedReason,
  closedPrBlockedReason,
  conflictingPrBlockedReason,
  unpushedRevisionBlockedReason,
} from "~/schemas/task-file.schema";
import type { AcceptanceDisclosure } from "~/shared/acceptance-disclosure";
import type { PrOverlap } from "~/shared/pr-overlaps";
import type { BoardStage, BoardTask } from "./board-page";

/**
 * The board's acceptance ceremony (ruling 689(e), the split of
 * `board-page.tsx`): the ONE shared `AcceptConfirm` a board move into the final
 * stage opens, and the refusals a board summary can answer. Its own module so
 * the page's move hooks (`useMoveConfirms`, board-page-actions.tsx) can place
 * it; it exports only the component.
 */

/**
 * D3 (rulings 14 + 53) — as much of `acceptanceRefusalReason`
 * (task-acceptance.server.ts) as a board SUMMARY can answer, composed into the one
 * `blockedReason` the shared ceremony renders.
 *
 * `blockReason` alone is not "the" refusal: it is the projected revision gate
 * (`acceptanceBlockReason`, rebuilder.server.ts), whose own docstring names the
 * refusals it leaves OUT because they are per-reader state its consumers filter
 * on first — the ARCHIVED task and the STAGE boundary. This dialog can rely on
 * neither filter (it re-reads its task from the live payload, and the Move menu
 * offers the terminal stage from ANY stage), so it asks them here, through the
 * server's own shared predicates so the sentence cannot drift:
 *   - `archivedTaskBlockedReason` — the SAME function the server calls;
 *   - `closedPrBlockedReason` — asked ahead of `blockReason` only for R16-3
 *     precedence (a terminal GitHub fact outranks every process gate);
 *   - the STAGE gate — `acceptanceStageBlockedReason`, the one the task file
 *     cannot answer (it turns on the PROJECT's workflow edges). Not guessed from
 *     column ORDER (rulings 12/14): `TaskSummary.atAcceptanceBoundary` carries
 *     the graph's answer, derived server-side through the same `resolveStageRoles`;
 *   - the blocked-packet and conflicting-PR gates — belt-and-braces so a stale
 *     projection fails CLOSED rather than opening a confident dialog on a click
 *     the server refuses.
 *
 * A refusal shown here is final — the board has no force-accept to bypass it.
 */
function boardAcceptRefusal(
  task: BoardTask,
  fromStageName: string,
  terminalName: string,
): string | null {
  return (
    archivedTaskBlockedReason(task, task.key) ??
    closedPrBlockedReason(task, task.key) ??
    (task.atAcceptanceBoundary
      ? null
      : // The server's own sentence names the resolved review stage; a summary
        // holds no stage roles, and "the boundary" is the truer phrasing anyway
        // for a graph with several edges into the terminal stage.
        `${task.key} is at ${fromStageName}, not the boundary the workflow puts before ${terminalName}. A completion can only be accepted from there. Move the task through the workflow first.`) ??
    task.blockReason ??
    (task.readiness === "blocked" && task.packet?.type === "blocked"
      ? "An open blocked decision is holding this task."
      : null) ??
    // Ruling 135: the delivered revision is not on the PR, above the conflict.
    unpushedRevisionBlockedReason(task.pr, task.workRevisionSha ?? null, task.key) ??
    conflictingPrBlockedReason(task, task.key)
  );
}

/**
 * D3 (rulings 14 + 53) — the board's acceptance ceremony.
 *
 * A human moving a card into the FINAL stage is not a bare move: the server
 * routes it through the full acceptance contract, which attempts a real PR
 * merge (`reorderTask` → `acceptCompletion`, task-transitions.server.ts and
 * task-acceptance.server.ts). Ruling 53 (R18-7) required this confirmation to
 * "match the task-detail dialog"; ruling 14 forbids forking a shared surface
 * per screen. The board nonetheless carried `AcceptOnBoardConfirm`, its OWN
 * dialog, disclosing LESS than the task page: no merge target, no
 * delivered-revision row, no verdict attribution, no no-change disposition.
 *
 * This renders the ONE shared `AcceptConfirm` (task-detail/accept-confirm), in
 * its `stage-move` ceremony mode — the mode written for exactly this path (a
 * human move into the terminal stage IS accepting completion, F19-37). The board
 * maps its projection summary onto the component's structural `task` shape and
 * supplies the stage list from its columns. The task-FILE facts a board summary
 * does not carry are passed honestly rather than invented:
 *   - `defaultBranch` → the merge target, threaded from the project record —
 *     the fact the fork could not name and sent people to the task page for;
 *   - `noChanges` / `noPullRequest: false` → the board cannot run the accept-time
 *     branch re-probe the task-detail loader drives, so it keeps the plain no-PR
 *     sentence rather than promising an auto-detect it can't perform.
 * The refusals a board summary CAN answer are composed by `boardAcceptRefusal`.
 *
 * The delivered REVISION used to be in that list — hardcoded `null`, so the
 * ceremony always drew "No delivered revision recorded." — and once ruling 88
 * made the confirmed click echo its own disclosure back, that hardcoded absence
 * stopped being merely a thinner disclosure and became a dead door: the server
 * compares the echo against the live task, so every board drop onto the terminal
 * stage of a task that had actually DELIVERED was refused as stale. The revision
 * is projected now (`TaskSummary.workRevisionSha`) and disclosed like every
 * other fact — which is also what ruling 53 asked for. `?? null` keeps the
 * honest-absence row for a task with nothing delivered.
 */
export function AcceptOnBoardConfirm({
  task,
  stages,
  fromStageName,
  defaultBranch,
  mergeCollisions,
  busy,
  onCancel,
  onConfirm,
}: {
  task: BoardTask;
  /** Ruling 475 (F40-55 (c)): the other open PRs on this board that change a
   *  path this task's PR changes, from the cards the board already holds. */
  mergeCollisions: readonly PrOverlap[];
  /** Project stages in order — supplies the shared ceremony's stage list and
   *  names the terminal (merge) stage. */
  stages: BoardStage[];
  /** The stage the card is leaving — named in the ceremony's Moving row. */
  fromStageName: string;
  /** The merge target (project default branch) — the fact a board summary lacks
   *  and the fork could not name. */
  defaultBranch: string;
  busy: boolean;
  onCancel: () => void;
  /** Ruling 88: the shared ceremony hands the confirmed click its own
   *  disclosure — the board POSTs it, exactly like the task page. */
  onConfirm: (disclosure: AcceptanceDisclosure) => void;
}) {
  const terminalName = stages[stages.length - 1]?.name ?? "Done";
  return (
    <AcceptConfirm
      task={{
        key: task.key,
        title: task.title,
        stage: task.stage,
        stages: stages.map((s) => ({ id: s.id, name: s.name })),
        validation: task.validation,
        branch: task.branch,
        pr: task.pr,
        // Ruling 304: the board summary carries the checks too, so the same
        // dialog says the same thing from either door.
        prChecks: task.prChecks ?? null,
      }}
      workRevisionSha={task.workRevisionSha ?? null}
      mergeCollisions={mergeCollisions}
      noChanges={false}
      noPullRequest={false}
      // F32-11: the board summary carries the open packet too.
      openPacketTitle={task.packet?.title ?? null}
      // Ruling 471: and, from the loader, the option this move answers it with.
      answersWith={task.packet?.acceptAnswersWith ?? null}
      defaultBranch={defaultBranch}
      // The STAGE gate the summary CAN answer (F19-27). The board never
      // force-accepts, so this jumps no stage on its own — the off-boundary
      // sentence rides `blockedReason` below — but it keeps the shared
      // component's own boundary reasoning honest.
      atBoundary={task.atAcceptanceBoundary}
      ceremony={{
        mode: "stage-move",
        label: `${fromStageName} → ${terminalName}`,
      }}
      verdictSatisfiedBy={null}
      blockedReason={boardAcceptRefusal(task, fromStageName, terminalName)}
      // Ruling 162's interlock is for the refusal the server re-decides. This
      // one is composed from a projection SUMMARY on purpose (see
      // `boardAcceptRefusal`), so it is a disclosure, not a verdict: the board
      // discloses it and lets the confirmed move be answered by the server,
      // which is also the only door here — the board has no force-accept.
      blockedReasonAuthoritative={false}
      busy={busy}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}
