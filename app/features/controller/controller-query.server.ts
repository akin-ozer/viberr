import type { DatabaseSync } from "node:sqlite";
import type { TaskLinks } from "~/shared/task-key-links";
import { data } from "react-router";
import { isOrgAdmin } from "~/server/auth/project-authority.server";
import { getProject } from "~/server/projections/board-query.server";
import { isBackendAvailableFor } from "~/server/runtimes/backend-credentials.server";
import {
  canAccessConversation,
  getConversation,
  listConversations,
  listMessages,
  type ControllerConversation,
  type ControllerMessage,
  type ListConversationsInput,
} from "~/server/controller/controller-conversations.server";
import { resolveControllerConfig } from "~/server/controller/controller-profile.server";
import {
  conversationTurnState,
  type ConversationTurnState,
} from "~/server/controller/controller-run.server";
import { listRunsForTask } from "~/server/runtimes/run-service.server";
import type { RunView } from "~/features/runtime/runtime-types";
import { listGoals, readGoalHistory, type GoalView } from "~/server/tasks/goal-actions.server";
import { userDisplayName } from "~/server/tasks/user-display-name.server";
import { controllerTaskLinks } from "~/server/controller/controller-task-links.server";

/**
 * Loader data for the controller surfaces (ruling 99): the viewer's own
 * conversations (org admins may ask for everyone's), the active transcript,
 * live turn state, and — on the project surface — the goal chains.
 *
 * Ruling 121: the project surface lists the board's threads AND the threads
 * anchored to its tasks (each item carries `taskKey`, rendered as a chip);
 * the instance surface lists instance threads only, as before.
 */

export interface ControllerSurfaceView {
  available: boolean;
  controllerName: string;
  /** The bound project's display name (project surface only). */
  projectName: string | null;
  conversations: ConversationListItem[];
  conversation: ControllerConversation | null;
  messages: ControllerMessage[];
  /** U39-29: the task keys the transcript names that this viewer can open,
   *  key to path. */
  taskLinks: TaskLinks;
  /** Ruling 250: `phase`/`step` say what the live turn is doing, for the row
   *  the person is watching. */
  turn: ConversationTurnState;
  /**
   * The open conversation's controller runs, projected the way the task page's
   * runtime is: one console entry (every turn of a thread resumes the same
   * agent, so the group carries the `run N of M` boundaries) with the bounded
   * window of its newest lines and the cursor for the rest. Feeds the Live-run
   * strip and the Agent-logs console. Empty with no conversation open.
   */
  runtime: RunView[];
  /** The viewer may stop the working turn: the conversation's owner or an org
   *  admin (`canInterruptControllerRun`, re-checked by the engine on submit). */
  canInterruptTurn: boolean;
  /** Project surface only. */
  goals: GoalView[] | null;
  viewerOwnsActive: boolean;
  /** Org admin reading every conversation (?all=1). */
  showingAll: boolean;
  viewerIsOrgAdmin: boolean;
  /** Ruling 260: who is looking, so a goal's own creator gets its controls. */
  viewerId: string;
}

export interface ConversationListItem {
  id: string;
  title: string;
  ownerLabel: string;
  own: boolean;
  lastMessageAt: string | null;
  projectSlug: string | null;
  /** Ruling 121: the task this thread is anchored to, when it is. */
  taskKey: string | null;
}

export function getControllerSurface(
  db: DatabaseSync,
  viewer: { id: string; email: string },
  input: {
    projectSlug?: string | null;
    conversationId?: string | null;
    all?: boolean;
    dataRoot?: string;
  },
): ControllerSurfaceView {
  const admin = isOrgAdmin(db, viewer.id);
  const showingAll = Boolean(input.all && admin);
  const scope = input.projectSlug ?? null;
  const listInput: ListConversationsInput = { projectSlug: scope };
  if (!showingAll) listInput.userId = viewer.id;
  const rows = listConversations(db, listInput);

  let conversation: ControllerConversation | null = null;
  if (input.conversationId) {
    const found = getConversation(db, input.conversationId);
    if (
      !found ||
      !canAccessConversation(db, found, {
        userId: viewer.id,
        orgRole: admin ? "admin" : "member",
      })
    ) {
      // A thrown Response, not an AppError: both callers are LOADERS, and the
      // root boundary only reads a route error response. An AppError reached it
      // as an unhandled throw, so this deliberate 404 rendered as the generic
      // "Something went wrong" page at HTTP 500 instead.
      throw data("Conversation not found.", { status: 404 });
    }
    // Ruling 121 (review finding 22, and the page half of finding 3): a page
    // only opens the threads of its OWN scope. The instance page rendered a
    // task-anchored thread as "on the null board" and, worse, its composer
    // drove a turn whose context read belongs to a project this page never
    // gated. The project page still opens both its board and its task threads
    // — same projectSlug — which is what its list offers.
    if (found.projectSlug !== scope) {
      throw data("Conversation not found.", { status: 404 });
    }
    conversation = found;
  }

  const config = resolveControllerConfig(input.dataRoot);
  // Ruling 419(f): a person is named on this page the way the rest of the app
  // names them. A conversation stores its owner's EMAIL at creation (the
  // controller's prompt keeps it: an address is unambiguous to a model), and
  // the transcript and the rail printed that address beside every message
  // where the task timeline says "Arda". Read at render time, so a rename
  // shows at once; an owner with no row keeps the stored label.
  const names = new Map<string, string>();
  const nameOf = (userId: string, stored: string): string => {
    let name = names.get(userId);
    if (name === undefined) {
      const found = userDisplayName(db, userId);
      name = found === userId || !found.trim() ? stored : found;
      names.set(userId, name);
    }
    return name;
  };
  if (conversation) {
    conversation = { ...conversation, userLabel: nameOf(conversation.userId, conversation.userLabel) };
  }
  const messages = conversation ? listMessages(db, conversation.id) : [];
  return {
    // Ruling 127: a controller turn runs on the ASKER's own Claude account, so
    // "is the controller available" is a question about the person looking at
    // it — not about this deployment. Another member with Claude connected can
    // still converse while this viewer cannot.
    available: isBackendAvailableFor(db, viewer.id, "claude", {
      dataRoot: input.dataRoot,
    }),
    controllerName: config.name,
    projectName: scope ? (getProject(db, scope)?.name ?? scope) : null,
    conversations: rows.map((c) => ({
      id: c.id,
      title: c.title || "New conversation",
      ownerLabel: nameOf(c.userId, c.userLabel),
      own: c.userId === viewer.id,
      lastMessageAt: c.lastMessageAt,
      projectSlug: c.projectSlug,
      taskKey: c.taskKey,
    })),
    conversation,
    messages,
    taskLinks: controllerTaskLinks(
      db,
      messages.map((m) => m.text),
      { projectSlug: scope, viewerId: viewer.id },
    ),
    turn: conversation
      ? conversationTurnState(db, conversation.id)
      : { working: false, runId: null, phase: null, step: null },
    // Ruling 99: a controller run is stored at `project_slug = ''` with the
    // conversation id for its task key, which is the scope the grouping
    // projection is asked for here.
    runtime: conversation ? listRunsForTask(db, "", conversation.id) : [],
    canInterruptTurn: conversation
      ? conversation.userId === viewer.id || admin
      : false,
    // Ruling 419(h): each chain carries its history from its own file, so the
    // page can show why it paused and what a person said when they cancelled it.
    goals: scope
      ? listGoals(db, scope).map((goal) => ({
          ...goal,
          history: readGoalHistory(scope, goal.id, { dataRoot: input.dataRoot }),
        }))
      : null,
    // Ruling 260 (pass 37, F37-91): the goal-redirect gate is a DISJUNCTION —
    // the chain's creator, or run-agents. The page knew only the role half, so
    // it hid Pause, Resume, Cancel, Retry and Skip from the person who created
    // the chain. Carry the viewer so the other half can be answered per goal.
    viewerId: viewer.id,
    viewerOwnsActive: conversation ? conversation.userId === viewer.id : false,
    showingAll,
    viewerIsOrgAdmin: admin,
  };
}
