import type { DatabaseSync } from "node:sqlite";
import {
  boardWritesRepo,
  changeProjectRepo,
} from "~/features/project-settings/settings-actions.server";
import { findUserById } from "~/server/auth/user-store.server";
import { createConversation } from "~/server/controller/controller-conversations.server";
import {
  runControllerTurn,
  type ControllerTurnInput,
} from "~/server/controller/controller-run.server";
import { AppError } from "~/server/errors/app-error.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import { logger } from "~/server/logging/logger.server";
import {
  noRepositoryRuling,
  recordNoRepositoryRuling,
  removeNoRepositoryRuling,
  type NoRepositoryRuling,
} from "~/server/org/repository-ruling.server";
import { userBackendHealth } from "~/server/runtimes/backend-credentials.server";
import { errorMessage, toError } from "~/shared/errors";
import type { ResolvedPacketOption } from "~/shared/packet-server-outcome";
import { repositoryAskCause } from "~/shared/repository-ask";
import { endSentence } from "~/shared/text/sentence";
import { siblingPacketsSharingCause } from "./packet-fanout.server";
import { resolvePacket } from "./packet-resolution.server";
import { autoInvokeOperator, type TaskActionContext } from "./task-action-core.server";
import { appendPolicyNote, taskRef, type TaskActor } from "./task-mutation.server";

/**
 * Ruling 672: what answering the operator's repository question does, and
 * what a repository connected any other way settles.
 *
 * The owner, 2026-10-06: "operator creates a packet to remind to user to
 * connect a repo. If they refuse that's stored as a ruling on project kb never
 * asked again. If they decide to connect a repo, controller spawns on board
 * level and reverts the ruling on kb."
 *
 * The question is about the board, and it is asked on a task. So each answer
 * is carried out once, on the task a person answered, and every other task on
 * the board that asked takes the same answer through ruling 319's fan-out
 * (`answeredElsewhere` below): nothing is attached or written twice.
 */

function projectRepo(ctx: TaskActionContext, projectSlug: string): string | null {
  return readProjectFile({ projectSlug, dataRoot: ctx.dataRoot })?.parsed.frontmatter.repo ?? null;
}

/** What a `connect_repository` answer settled. */
export interface ConnectedFromPacket {
  repo: string;
  /** What the decision's entry says after the option's title. */
  sentence: string;
  /** Whether this answer attached the repository itself. */
  attached: boolean;
}

/**
 * Carry out "Connect a repository": attach what the person typed through the
 * Change door (ruling 669), as a repository the board delivers through, so the
 * token has to be able to push. The door's refusals are thrown as they are and
 * leave the packet open. A board that already has a repository is answered
 * already, by whoever connected it.
 */
export async function connectRepositoryFromPacket(
  db: DatabaseSync,
  ctx: TaskActionContext,
  input: { projectSlug: string; typed: string; answeredElsewhere: boolean },
  actor: TaskActor,
): Promise<ConnectedFromPacket> {
  const current = projectRepo(ctx, input.projectSlug);
  if (current) {
    return { repo: current, attached: false, sentence: `\`${current}\` is connected to this board.` };
  }
  if (input.answeredElsewhere) {
    throw AppError.conflict(
      "No repository is connected to this board, so the question here still stands.",
    );
  }
  const options: Parameters<typeof changeProjectRepo>[4] = { settle: false };
  if (ctx.fetchImpl) options.fetchImpl = ctx.fetchImpl;
  const result = await changeProjectRepo(
    db,
    { projectSlug: input.projectSlug, repo: input.typed, delivers: true },
    actor,
    { dataRoot: ctx.dataRoot },
    options,
  );
  // None stands while the question is open; a person may have put the
  // document back by hand, and a connected board must not go on saying it.
  removeNoRepositoryRuling(
    db,
    { projectSlug: input.projectSlug, repo: result.repo },
    { userId: actor.userId, label: actor.label },
    ctx,
  );
  return { repo: result.repo, attached: true, sentence: endSentence(result.toast) };
}

/**
 * Carry out "Keep this board without one": write the decision into the
 * project's rulings knowledge base, where it stops the question being asked
 * again. Refused once the board has a repository, which a ruling that it
 * connects none would contradict.
 */
export async function keepWithoutRepositoryFromPacket(
  db: DatabaseSync,
  ctx: TaskActionContext,
  input: {
    projectSlug: string;
    taskKey: string;
    byName: string;
    at: string;
    answeredElsewhere: boolean;
  },
  actor: TaskActor,
): Promise<NoRepositoryRuling> {
  const current = projectRepo(ctx, input.projectSlug);
  if (current) {
    throw AppError.conflict(
      `This board has ${current} now, so there is nothing to keep it without. Remove it in the project's settings if the board should have none.`,
    );
  }
  if (input.answeredElsewhere) {
    const standing = noRepositoryRuling(input.projectSlug, ctx);
    if (standing) return standing;
    throw AppError.conflict(
      "The project's rulings hold no decision about a repository, so the question here still stands.",
    );
  }
  return recordNoRepositoryRuling(
    db,
    { projectSlug: input.projectSlug, byName: input.byName, taskKey: input.taskKey, at: input.at },
    { userId: actor.userId, label: actor.label },
    ctx,
  );
}

/** `resolvePacket`'s `fanOutOrigin` for an answer that came from no task: a
 *  repository connected in the project's settings or by the controller. */
const ANSWERED_OUTSIDE_A_TASK = "project settings";

/** What connecting a repository outside a packet settled on the board. */
export interface RepositoryConnectedOutcome {
  /** The "connects no repository" ruling it removed, or null. */
  rulingRemoved: NoRepositoryRuling | null;
  /** The tasks whose open question it answered. */
  answered: string[];
  /** The tasks whose question is still open, and why. */
  missed: { taskKey: string; why: string }[];
  /** Whether the answered tasks' operators were started again. False when
   *  the controller made the connection on a board no agent may write yet:
   *  it starts them once it has switched the board. */
  operatorsStarted: boolean;
}

/**
 * A repository was connected from the project's settings or by the
 * controller. The ruling that the board connects none is no longer true, and
 * every task still asking whether to connect one has its answer: each is
 * resolved through the real `resolvePacket`, and handed back to its operator
 * by {@link carryOnAfterConnection}. Best-effort per task; a miss is
 * reported, not thrown.
 */
export async function afterRepositoryConnected(
  db: DatabaseSync,
  ctx: TaskActionContext,
  input: {
    projectSlug: string;
    repo: string;
    /** True when the controller made the connection in a turn of its own. */
    byController: boolean;
  },
  actor: TaskActor,
): Promise<RepositoryConnectedOutcome> {
  const rulingRemoved = removeNoRepositoryRuling(
    db,
    input,
    { userId: actor.userId, label: actor.label },
    ctx,
  );
  const cause = repositoryAskCause(input.projectSlug);
  const outcome: RepositoryConnectedOutcome = {
    rulingRemoved,
    answered: [],
    missed: [],
    operatorsStarted: true,
  };
  let answeredWith: ResolvedPacketOption | null = null;
  // No task of its own to leave out: the answer came from outside every task.
  const asking = siblingPacketsSharingCause(db, cause, { projectSlug: input.projectSlug, taskKey: "" });
  for (const task of asking) {
    const live = readTaskFile(taskRef(ctx, task.projectSlug, task.taskKey))?.parsed.packet;
    if (!live || live.cause !== cause || live.awaiting || live.decided) continue;
    const at = live.options.findIndex((o) => o.kind === "connect_repository");
    if (at < 0) continue;
    try {
      await resolvePacket(
        db,
        {
          projectSlug: task.projectSlug,
          taskKey: task.taskKey,
          optionIndex: at,
          note: input.repo,
          fanOutOrigin: ANSWERED_OUTSIDE_A_TASK,
        },
        actor,
        ctx,
      );
      await appendPolicyNote(db, ctx, task.projectSlug, task.taskKey, {
        text: `Answered outside this task: ${actor.label} connected \`${input.repo}\` to the board, so the question here is settled.`,
      });
      outcome.answered.push(task.taskKey);
      answeredWith = { kind: "connect_repository", title: live.options[at]?.t ?? "Connect a repository", note: input.repo };
    } catch (error) {
      logger.warn("repository question could not be answered after the connection", {
        taskKey: task.taskKey,
        err: toError(error),
      });
      outcome.missed.push({ taskKey: task.taskKey, why: endSentence(errorMessage(error)) });
    }
  }
  if (answeredWith) {
    const carried = await carryOnAfterConnection(db, ctx, {
      projectSlug: input.projectSlug,
      repo: input.repo,
      taskKeys: outcome.answered,
      switchFrom: null,
      controllerSwitches: input.byController,
      resolvedOption: answeredWith,
    });
    outcome.operatorsStarted = carried.operatorsStarted;
  }
  return outcome;
}

/**
 * Hand each task whose question a connection answered back to its operator,
 * at the moment the operator can do something with it.
 *
 * `connect_repository` starts no operator from `resolvePacket` (its
 * `NO_REQUEUE`), because the answer alone does not make the board able to
 * deliver: on a board made to deliver results nobody may write the repository
 * until the controller gives an agent repo-write back. An operator started
 * before that would find the same gap and open a packet about it, the moment a
 * person had just answered one. So:
 *
 *  - a board that can write its repository now: the operators start now;
 *  - one that cannot, with a controller on it (started here from the packet,
 *    or the one that made the connection): they wait, and the controller
 *    starts each when it has switched the board. Ruling 330's sweep starts a
 *    task nothing moved for fifteen minutes, so a controller that forgets
 *    leaves no task stopped;
 *  - one that cannot, with no controller coming: they start now and say what
 *    is missing, which is then the true state of the board.
 */
export async function carryOnAfterConnection(
  db: DatabaseSync,
  ctx: TaskActionContext,
  input: {
    projectSlug: string;
    repo: string;
    /** The tasks whose question the connection answered. */
    taskKeys: readonly string[];
    /** The packet answer that attached the repository, which starts the
     *  controller on the board as the person who gave it; null when the
     *  repository was connected any other way. */
    switchFrom: { userId: string; taskKey: string } | null;
    /** The controller made the connection, in a turn that goes on to switch
     *  the board. */
    controllerSwitches: boolean;
    resolvedOption: ResolvedPacketOption;
  },
): Promise<{ turn: BoardSwitchTurn | null; operatorsStarted: boolean }> {
  const writes = boardWritesRepo(input.projectSlug, ctx.dataRoot ? { dataRoot: ctx.dataRoot } : {});
  let turn: BoardSwitchTurn | null = null;
  if (input.switchFrom) {
    try {
      turn = await startBoardSwitchTurn(
        db,
        {
          projectSlug: input.projectSlug,
          repo: input.repo,
          taskKey: input.switchFrom.taskKey,
          userId: input.switchFrom.userId,
          waiting: writes ? [] : input.taskKeys,
        },
        ctx,
      );
    } catch (error) {
      logger.warn("board switch turn could not be started", {
        taskKey: input.switchFrom.taskKey,
        err: toError(error),
      });
      turn = { started: false, why: endSentence(errorMessage(error)) };
    }
    await appendPolicyNote(db, ctx, input.projectSlug, input.switchFrom.taskKey, {
      text: boardSwitchNote(turn, writes),
    });
  }
  const held = !writes && (turn?.started === true || input.controllerSwitches);
  if (!held) {
    for (const taskKey of input.taskKeys) {
      void autoInvokeOperator(db, ctx, input.projectSlug, taskKey, "packet-resolved", {
        resolvedOption: input.resolvedOption,
      });
    }
  }
  return { turn, operatorsStarted: !held };
}

/** What the answered task's record says about the controller's turn. */
function boardSwitchNote(turn: BoardSwitchTurn, writes: boolean): string {
  if (turn.started) {
    return (
      "The controller was started on this board to switch it to pull requests. Its answer is in the board's Controller conversation." +
      (writes
        ? ""
        : " No agent here may write the repository yet, so the operator starts again when the controller has switched the board.")
    );
  }
  return (
    `The controller was not started on this board: ${turn.why}` +
    (writes
      ? ""
      : " No agent here may write the repository yet: ask the controller to switch the board to pull requests, or grant repo-write on the Agents page.")
  );
}

/** The words the board-level controller turn is started with: the person's
 *  own request, as their answer to the packet made it. */
export function boardSwitchRequest(input: {
  repo: string;
  taskKey: string;
  /** The tasks whose operators wait for the switch; empty when none does. */
  waiting: readonly string[];
}): string {
  return (
    `I connected \`${input.repo}\` to this board from ${input.taskKey}'s decision packet, so its tasks should ship as pull requests from here on. ` +
    "Switch the board to pull requests: give the agent that delivers its work repo-write back, correct any ruling that still says tasks here are delivered as files, and tell me what you changed and what is left for me to decide." +
    (input.waiting.length > 0
      ? ` When the board is switched, start the operator again on ${input.waiting.join(", ")} with \`run_agent_on_task\`: ${input.waiting.length === 1 ? "it waits" : "they wait"} for that.`
      : "")
  );
}

export type BoardSwitchTurn =
  | { started: true; conversationId: string }
  | { started: false; why: string };

/**
 * Start the controller on the board, as the person who connected the
 * repository: a new board conversation of theirs, opened with
 * {@link boardSwitchRequest}. A controller turn runs on the asker's own Claude
 * account (ruling 127), so with none connected nothing is started and the
 * reason comes back for the task's record.
 */
export async function startBoardSwitchTurn(
  db: DatabaseSync,
  input: {
    projectSlug: string;
    repo: string;
    taskKey: string;
    userId: string;
    waiting: readonly string[];
  },
  ctx: Pick<TaskActionContext, "dataRoot" | "deps"> = {},
): Promise<BoardSwitchTurn> {
  const user = findUserById(db, input.userId);
  if (!user || user.disabled) {
    return { started: false, why: "The person who connected it has no active account." };
  }
  const health = ctx.dataRoot
    ? userBackendHealth(db, user.id, "claude", { dataRoot: ctx.dataRoot })
    : userBackendHealth(db, user.id, "claude");
  if (!health.available) {
    return {
      started: false,
      why: `Claude is not connected on ${user.name}'s account, and the controller runs on the account of the person who asks it.`,
    };
  }
  const conversation = createConversation(db, {
    userId: user.id,
    userLabel: user.email,
    projectSlug: input.projectSlug,
  });
  const turn: ControllerTurnInput = {
    conversationId: conversation.id,
    text: boardSwitchRequest(input),
    user: { id: user.id, email: user.email, name: user.name, orgRole: user.role },
    surface: `/projects/${input.projectSlug}/tasks/${input.taskKey}`,
  };
  if (ctx.dataRoot) turn.dataRoot = ctx.dataRoot;
  const result = await (ctx.deps?.runControllerTurn ?? runControllerTurn)(db, turn);
  if (result.state === "refused") return { started: false, why: endSentence(result.reason) };
  return { started: true, conversationId: conversation.id };
}
