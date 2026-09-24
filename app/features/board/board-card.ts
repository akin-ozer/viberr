import type { TaskSummary } from "~/shared/mapping/task.server";

/**
 * Ruling 457 (BOARD-3): what the board ships for one card. The board route
 * used to hand every card the whole 49-field `TaskSummary` (the full decision
 * packet, the goal, commits, file path, timestamps and counts), of which the
 * card face (ruling 365), `card-status.ts`, `board-filters.ts`, the list view
 * and the acceptance ceremony (`AcceptOnBoardConfirm`, rulings 53 and 88) read
 * under thirty; half the board's payload was fields nothing drew. This is that
 * read set, built by `toBoardCard` in the board loader; the board's types
 * accept nothing wider, so a field a new board feature reads has to be added
 * here, where the typecheck sends it.
 *
 * Kept on purpose: the acceptance ceremony re-reads the summary from the live
 * payload (F19-27, ruling 42), so `pr`, `prChecks`, `prChecksUnread`,
 * `workRevisionSha`, the packet's type and title (and the option the
 * acceptance answers it with, ruling 471), `blockReason`,
 * `atAcceptanceBoundary` and `archived` stay; `waitingOnMe` (R8-3) and `quiet`
 * (Gap-10) are the loader's viewer and activity annotations.
 */
export interface BoardCard
  extends Pick<
    TaskSummary,
    | "projectSlug"
    | "key"
    | "title"
    | "stage"
    | "readiness"
    | "displayReadiness"
    | "waiting"
    | "waitingOnMe"
    | "liveRun"
    | "resumesAt"
    | "urgent"
    | "labels"
    | "archived"
    | "validation"
    | "blockReason"
    | "atAcceptanceBoundary"
    | "owner"
    | "specialist"
    | "reviewers"
    | "branch"
    | "pr"
    | "prChecks"
    | "prChecksUnread"
    | "prReview"
    | "continuity"
    | "workRevisionSha"
  > {
  /** Only the operator's presence is drawn ("awaiting owner"). */
  operator: Pick<NonNullable<TaskSummary["operator"]>, "name"> | null;
  /** The open decision's kind and title: the readiness word and the
   *  acceptance ceremony's open-packet row. Ruling 471: plus the option the
   *  board's acceptance (a move into the terminal stage) answers it with, when
   *  it answers one; the row then reads "Answers" instead of "Withdraws". */
  packet: Pick<NonNullable<TaskSummary["packet"]>, "type" | "title" | "acceptAnswersWith"> | null;
  /** Gap-10: gone quiet (resolved server-side, see `TaskActivitySummary`). */
  quiet: boolean;
}

/** The card a board ships for `task`: its read set and nothing else. */
export function toBoardCard(task: TaskSummary & { quiet: boolean }): BoardCard {
  return {
    projectSlug: task.projectSlug,
    key: task.key,
    title: task.title,
    stage: task.stage,
    readiness: task.readiness,
    displayReadiness: task.displayReadiness,
    waiting: task.waiting,
    waitingOnMe: task.waitingOnMe,
    liveRun: task.liveRun,
    resumesAt: task.resumesAt,
    urgent: task.urgent,
    labels: task.labels,
    archived: task.archived,
    validation: task.validation,
    blockReason: task.blockReason,
    atAcceptanceBoundary: task.atAcceptanceBoundary,
    owner: task.owner,
    specialist: task.specialist,
    reviewers: task.reviewers,
    branch: task.branch,
    pr: task.pr,
    prChecks: task.prChecks,
    prChecksUnread: task.prChecksUnread,
    prReview: task.prReview,
    continuity: task.continuity,
    workRevisionSha: task.workRevisionSha,
    operator: task.operator ? { name: task.operator.name } : null,
    packet: task.packet ? boardPacket(task.packet) : null,
    quiet: task.quiet,
  };
}

/** The card's slice of the open decision. `acceptAnswersWith` rides only when
 *  set, so a decision the board's acceptance withdraws costs no extra bytes. */
function boardPacket(
  packet: NonNullable<TaskSummary["packet"]>,
): NonNullable<BoardCard["packet"]> {
  const slice: NonNullable<BoardCard["packet"]> = { type: packet.type, title: packet.title };
  if (packet.acceptAnswersWith) slice.acceptAnswersWith = packet.acceptAnswersWith;
  return slice;
}
