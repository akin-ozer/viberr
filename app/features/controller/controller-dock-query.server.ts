import type { DatabaseSync } from "node:sqlite";
import type { TaskLinks } from "~/shared/task-key-links";
import { taskKeyLinks } from "~/server/projections/task-key-links.server";
import { isOrgAdmin } from "~/server/auth/project-authority.server";
import { isBackendAvailableFor } from "~/server/runtimes/backend-credentials.server";
import { getProject } from "~/server/projections/board-query.server";
import { taskExists } from "~/server/projections/task-query.server";
import {
  canAccessConversation,
  conversationScopeOf,
  getConversation,
  listConversations,
  listMessages,
  listUnseenReplies,
  markConversationSeen,
  type ControllerConversation,
  type ControllerMessage,
  type ConversationScope,
} from "~/server/controller/controller-conversations.server";
import { resolveControllerName } from "~/server/controller/controller-profile.server";
import { NEW_CONVERSATION_PARAM } from "./conversation-param";
import {
  conversationTurnState,
  IDLE_TURN,
  type ConversationTurnState,
} from "~/server/controller/controller-run.server";

/**
 * The controller DOCK's view (ruling 121): what the floating panel shows for
 * the place the person is standing. One scope at a time — the instance, one
 * board, or one task — with that scope's own threads, the active transcript,
 * and the one-line disclosure of what the controller knows here.
 *
 * The scope is resolved and authorized by the resource route BEFORE this runs;
 * this module only reads.
 *
 * NOTHING HERE THROWS (review finding 2). The dock's view is a root-owned
 * `fetcher.load`, and React Router routes a fetcher loader's thrown response to
 * the boundary of the route that owns the fetcher — root — so a throw here
 * replaces the WHOLE page with the root error page, which is exactly the hazard
 * ruling 121(f) named for CSRF and fixed there. A selection that is stale,
 * unreadable or out of scope is therefore not an error: the view answers the
 * scope's newest thread and reports `staleSelection`, and the client drops the
 * id it asked for. A scope the person cannot reach answers `unavailable`. Neither
 * leaks anything: both are the same benign shape for a missing project and a
 * forbidden one, and the page routes still 404 on their own.
 */

export interface ControllerDockScope {
  kind: ConversationScope;
  projectSlug: string | null;
  taskKey: string | null;
  /** Display name of the bound project (null at instance scope). */
  projectName: string | null;
  /** The pill in the panel header: `Instance`, `<project>`, `<KEY> · <project>`. */
  label: string;
  /** What the controller knows here, in one sentence. */
  contextLine: string;
  /** Where the full surface for this scope lives. */
  pageHref: string;
}

export interface ControllerDockThread {
  id: string;
  title: string;
  lastMessageAt: string | null;
  /** O39-d: holds a controller reply its owner has not seen. */
  unread: boolean;
}

export interface ControllerDockView {
  available: boolean;
  controllerName: string;
  /** The scope is not this person's to talk in here (unknown or forbidden
   *  project, unknown task). The panel says so instead of the page dying. */
  unavailable: boolean;
  /** The `c` the client asked for could not be honoured; it dropped back to
   *  this scope's newest thread and the client forgets the id it asked for. */
  staleSelection: boolean;
  scope: ControllerDockScope;
  conversation: ControllerConversation | null;
  messages: ControllerMessage[];
  /** U39-29: the task keys the transcript names that this viewer can open,
   *  key to path. */
  taskLinks: TaskLinks;
  /** Ruling 250: `phase`/`step` say what the live turn is doing, for the row
   *  the person is watching. */
  turn: ConversationTurnState;
  threads: ControllerDockThread[];
  viewerOwnsActive: boolean;
  /** Ruling 457: the caller is not signed in. Only the view
   *  `/resources/controller` answers with its 401 carries it, `unavailable`
   *  with it, and the panel then asks for a sign-in instead of blaming the
   *  scope or the person's Claude account. */
  signedOut?: boolean;
}

function describeDockScope(
  db: DatabaseSync,
  binding: { projectSlug: string | null; taskKey: string | null },
): ControllerDockScope {
  const kind = conversationScopeOf(binding);
  const project = binding.projectSlug ? getProject(db, binding.projectSlug) : null;
  const projectName = project?.name ?? binding.projectSlug;
  const acts = "acts with your permissions";
  if (kind === "task") {
    return {
      kind,
      projectSlug: binding.projectSlug,
      taskKey: binding.taskKey,
      projectName,
      label: `${binding.taskKey} · ${projectName}`,
      contextLine: `Knows the ${binding.taskKey} task file and its place in the ${projectName} workflow · ${acts}`,
      pageHref: `/projects/${binding.projectSlug}/controller`,
    };
  }
  if (kind === "board") {
    return {
      kind,
      projectSlug: binding.projectSlug,
      taskKey: null,
      projectName,
      label: projectName ?? "Board",
      contextLine: `Knows the ${projectName} board: stages, members, open tasks, epics · ${acts}`,
      pageHref: `/projects/${binding.projectSlug}/controller`,
    };
  }
  return {
    kind,
    projectSlug: null,
    taskKey: null,
    projectName: null,
    label: "Instance",
    contextLine: `Knows your projects and org role · ${acts}`,
    pageHref: "/controller",
  };
}

/** Whether a conversation belongs to exactly this scope (never a looser or a
 *  neighbouring one): the dock shows one place's threads and nothing else. */
export function conversationMatchesScope(
  conversation: ControllerConversation,
  scope: { projectSlug: string | null; taskKey: string | null },
): boolean {
  return (
    conversation.projectSlug === scope.projectSlug &&
    conversation.taskKey === scope.taskKey
  );
}

export function getControllerDock(
  db: DatabaseSync,
  viewer: { id: string; email: string },
  input: {
    projectSlug: string | null;
    taskKey: string | null;
    /** A conversation id, `NEW_CONVERSATION_PARAM` (none), or null for the
     *  newest thread here. */
    conversationId: string | null;
    /**
     * O39-d: the panel is OPEN and shows this transcript, so its owner has
     * seen it. A load without it reads nothing: a load nobody looked at must
     * not mark the reply it fetched as read. (Since ruling 457 the dock loads
     * this view only while the panel is open; the closed button reads the
     * dock's status instead.)
     */
    markSeen?: boolean;
    dataRoot?: string;
  },
): ControllerDockView {
  const binding = { projectSlug: input.projectSlug, taskKey: input.taskKey };
  const scope = describeDockScope(db, binding);
  // The dock lists the VIEWER's own threads for this exact scope: a board
  // scope excludes task threads (`taskKey: null`), a task scope is that task.
  const rows = listConversations(db, {
    userId: viewer.id,
    projectSlug: binding.projectSlug,
    taskKey: binding.taskKey,
    limit: 30,
  });
  let conversation: ControllerConversation | null = null;
  let staleSelection = false;
  if (input.conversationId === null) {
    conversation = rows[0] ?? null;
  } else if (input.conversationId !== NEW_CONVERSATION_PARAM) {
    const found = getConversation(db, input.conversationId);
    const admin = isOrgAdmin(db, viewer.id);
    if (
      !found ||
      !canAccessConversation(db, found, {
        userId: viewer.id,
        orgRole: admin ? "admin" : "member",
      }) ||
      !conversationMatchesScope(found, binding)
    ) {
      // Not an error — see the module note. The id names a thread that is
      // gone, another user's or another scope's; fall back to this scope's
      // newest thread and tell the client to forget it.
      staleSelection = true;
      conversation = rows[0] ?? null;
    } else {
      conversation = found;
    }
  }
  // O39-d: the open panel shows this transcript to its owner, so it is seen.
  if (input.markSeen === true && conversation && conversation.userId === viewer.id) {
    markConversationSeen(db, conversation.id, viewer.id);
  }
  const unseen = new Set(listUnseenReplies(db, viewer.id).map((r) => r.id));
  const messages = conversation ? listMessages(db, conversation.id) : [];
  return {
    // Ruling 127: a controller turn runs on the ASKER's own Claude account, so
    // the dock's "available" is a fact about the person the panel is open for,
    // never about this deployment.
    available: isBackendAvailableFor(db, viewer.id, "claude", {
      dataRoot: input.dataRoot,
    }),
    controllerName: resolveControllerName(input.dataRoot),
    unavailable: false,
    staleSelection,
    scope,
    conversation,
    messages,
    taskLinks: taskKeyLinks(
      db,
      messages.map((m) => m.text),
      { projectSlug: binding.projectSlug, viewerId: viewer.id },
    ),
    turn: conversation
      ? conversationTurnState(db, conversation.id)
      : IDLE_TURN,
    threads: rows.map((c) => ({
      id: c.id,
      title: c.title || "New conversation",
      lastMessageAt: c.lastMessageAt,
      unread: unseen.has(c.id),
    })),
    viewerOwnsActive: conversation ? conversation.userId === viewer.id : false,
  };
}

/** Does this task exist in this project? (The dock asks before binding a
 *  thread to it; the answer is the same for "gone" and "never was".) */
export function dockTaskExists(
  db: DatabaseSync,
  projectSlug: string,
  taskKey: string,
): boolean {
  return taskExists(db, projectSlug, taskKey);
}

/** What the two refusal views below share: no thread, no composer, and a
 *  scope that names nothing but what the person's page asked about.
 *
 *  F35-4 (pass 35): the unavailable view used to spread `describeDockScope`,
 *  which reads the project's display name out of the projection into
 *  `projectName`, `label` and `contextLine`, so a non-member learned a
 *  project's name from a slug they guessed while every other door (board,
 *  task, `.data`, attachments, run-log, the controller's own tools) answers
 *  the slug alone. The projection is not read for a refusal at all. */
function refusedDockView(
  binding: { projectSlug: string | null; taskKey: string | null },
  says: { label: string; contextLine: string },
): Omit<ControllerDockView, "available" | "controllerName"> {
  return {
    unavailable: true,
    staleSelection: false,
    scope: {
      kind: conversationScopeOf(binding),
      projectSlug: binding.projectSlug,
      taskKey: binding.taskKey,
      projectName: null,
      label: says.label,
      contextLine: says.contextLine,
      // A place to go, built from the slug the person typed (the page route
      // answers its own 404 there), never from the projection.
      pageHref: binding.projectSlug
        ? `/projects/${binding.projectSlug}/controller`
        : "/controller",
    },
    conversation: null,
    messages: [],
    taskLinks: {},
    turn: IDLE_TURN,
    threads: [],
    viewerOwnsActive: false,
  };
}

/** The view for a scope this person cannot talk in here: the panel explains
 *  itself and offers no composer, and the page it sits on is untouched. */
export function unavailableDockView(
  db: DatabaseSync,
  /** Ruling 127: even the refusal view answers availability for THIS person. */
  viewer: { id: string },
  binding: { projectSlug: string | null; taskKey: string | null },
  dataRoot?: string,
): ControllerDockView {
  return {
    available: isBackendAvailableFor(db, viewer.id, "claude", { dataRoot }),
    controllerName: resolveControllerName(dataRoot),
    ...refusedDockView(binding, {
      label: "Not available here",
      contextLine: "Not available here: this project or task is not open to you.",
    }),
  };
}

/** Ruling 457 (test audit L14-29): the view for a caller who is not signed in
 *  (no session, or a forced password reset pending), which
 *  `/resources/controller` answers with its 401 instead of a login redirect.
 *  Nothing is read for it, not even the controller's configured name: nobody
 *  is asking. The name is the one the dock shows before any view lands. */
export function signedOutDockView(binding: {
  projectSlug: string | null;
  taskKey: string | null;
}): ControllerDockView {
  return {
    available: false,
    controllerName: "Controller",
    signedOut: true,
    ...refusedDockView(binding, {
      label: "Signed out",
      contextLine: "Signed out: sign in again to talk to the controller.",
    }),
  };
}
