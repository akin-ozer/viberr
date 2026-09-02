import type { DatabaseSync } from "node:sqlite";
import { data } from "react-router";
import { isOrgAdmin } from "~/server/auth/project-authority.server";
import { isBackendAvailable } from "~/server/runtimes/runtime-registry.server";
import { getProject } from "~/server/projections/board-query.server";
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
import { conversationTurnState } from "~/server/controller/controller-run.server";
import { listGoals, type GoalView } from "~/server/tasks/goal-actions.server";

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
  turn: { working: boolean; runId: string | null };
  /** Project surface only. */
  goals: GoalView[] | null;
  viewerOwnsActive: boolean;
  /** Org admin reading every conversation (?all=1). */
  showingAll: boolean;
  viewerIsOrgAdmin: boolean;
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
  return {
    available: isBackendAvailable("claude"),
    controllerName: config.name,
    projectName: scope ? (getProject(db, scope)?.name ?? scope) : null,
    conversations: rows.map((c) => ({
      id: c.id,
      title: c.title || "New conversation",
      ownerLabel: c.userLabel,
      own: c.userId === viewer.id,
      lastMessageAt: c.lastMessageAt,
      projectSlug: c.projectSlug,
      taskKey: c.taskKey,
    })),
    conversation,
    messages: conversation ? listMessages(db, conversation.id) : [],
    turn: conversation
      ? conversationTurnState(db, conversation.id)
      : { working: false, runId: null },
    goals: scope ? listGoals(db, scope) : null,
    viewerOwnsActive: conversation ? conversation.userId === viewer.id : false,
    showingAll,
    viewerIsOrgAdmin: admin,
  };
}
