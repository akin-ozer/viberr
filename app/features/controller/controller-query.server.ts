import type { DatabaseSync } from "node:sqlite";
import type { TaskLinks } from "~/shared/task-key-links";
import { data } from "react-router";
import { isOrgAdmin } from "~/server/auth/project-authority.server";
import { getProject, listProjectMembers } from "~/server/projections/board-query.server";
import { isBackendAvailableFor } from "~/server/runtimes/backend-credentials.server";
import {
  canAccessConversation,
  getConversation,
  listConversations,
  listMessages,
  listUnseenReplies,
  markConversationSeen,
  type ControllerConversation,
  type ControllerMessage,
  type ListConversationsInput,
} from "~/server/controller/controller-conversations.server";
import { resolveControllerName } from "~/server/controller/controller-profile.server";
import { mayDeleteConversation } from "~/server/controller/controller-deletion.server";
import { roleCan, ROLE_LABEL } from "~/shared/rbac";
import {
  conversationTurnState,
  IDLE_TURN,
  liveTurnConversationIds,
  type ConversationTurnState,
} from "~/server/controller/controller-run.server";
import { listRunsForTask } from "~/server/runtimes/run-service.server";
import type { ConsoleShipping } from "~/server/runtimes/run-projection.server";
import type { RunView } from "~/features/runtime/runtime-types";
import { userDisplayName } from "~/server/tasks/user-display-name.server";
import { taskKeyLinks } from "~/server/projections/task-key-links.server";
import { NEW_CONVERSATION_PARAM } from "./conversation-param";
import { projectRulingsKb } from "~/server/files/project-rulings.server";
import { kbDocHref, listProjectKbProposals } from "~/server/org/kb-proposals.server";
import { listKbCorrections } from "~/server/org/kb-corrections.server";
import { isDocumentNavigation } from "~/server/http/single-fetch.server";

/**
 * Loader data for the controller surfaces (ruling 99): the viewer's own
 * conversations (org admins may ask for everyone's, and so, ruling 525, may a
 * project admin on their project's page, as threads they can delete but not
 * read), the active transcript, live turn state, and — on the project surface
 * — the knowledge-base panel.
 * The goal chains it also carried became epics (ruling 503), which the Epics
 * pages read (`features/epics/epics-query.server.ts`).
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
  /** Ruling 483 (F40-59): the open knowledge-base proposals agents filed from
   *  this project's tasks before ruling 498. Project surface only. */
  proposals: KbProposalView[] | null;
  /** Ruling 498: the knowledge-base corrections agents on this project's
   *  tasks wrote, newest first. Project surface only. */
  corrections: KbCorrectionsView | null;
  viewerOwnsActive: boolean;
  /** Reading every conversation of this scope (?all=1): an org admin, or
   *  (ruling 525) a holder of `delete-controller-conversations` on this page's
   *  project. */
  showingAll: boolean;
  /** Ruling 525: who the "Show everyone's" link says the viewer is reading
   *  as ("org admin", "project admin"); null when they may not. */
  showAllAs: string | null;
  viewerIsOrgAdmin: boolean;
}

/** One open knowledge-base proposal, as the project controller page lists it. */
export interface KbProposalView {
  id: string;
  kb: string;
  doc: string;
  /** It stands in the project's rulings knowledge base. */
  rulings: boolean;
  taskKey: string | null;
  filedOn: string | null;
  filedBy: string | null;
  line: string | null;
  correction: string;
  evidence: string | null;
  /** Where an org admin opens the document (Instance settings); null for
   *  everyone else, who cannot open that page. */
  docHref: string | null;
}

/** Ruling 498: one knowledge-base correction an agent wrote, as the project
 *  controller page lists it. The passages are clipped for the page; the
 *  document and the record hold them whole. */
export interface KbCorrectionView {
  id: string;
  kb: string;
  doc: string;
  /** It was written into the project's rulings knowledge base. */
  rulings: boolean;
  /** The passage it replaced; null when it added text. */
  replaced: string | null;
  text: string;
  evidence: string;
  taskKey: string;
  filedBy: string;
  at: string;
  undone: { at: string; by: string; reason: string | null } | null;
  /** Where an org admin opens the document; null for everyone else. */
  docHref: string | null;
}

export interface KbCorrectionsView {
  /** The newest {@link CORRECTIONS_SHOWN}. */
  shown: KbCorrectionView[];
  /** How many are on record for the project (audit retention bounds it). */
  total: number;
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
  /** O39-d: the viewer's own thread holds a controller reply they have not
   *  seen. Never set on someone else's thread (?all=1). */
  unread: boolean;
  /** The viewer may open it: its starter, or an org admin. Ruling 525: a
   *  project admin's everyone's list also holds threads they may only
   *  delete, which carry no title and open nothing. */
  readable: boolean;
  /** Ruling 525: the viewer may delete it (`mayDeleteConversation`). */
  canDelete: boolean;
  /** Ruling 525: a turn of it is running, which deleting it stops first. */
  working: boolean;
}

/**
 * U33-8: which thread a visit to either controller page opens.
 *
 * The dock's continuity rule (ruling 121) is "the newest thread of the scope
 * you are standing in"; the pages answered a blank composer instead, so one
 * person on one scope got two different answers from the two entry points.
 * Same rule here: no `?c=` opens this scope's newest thread, `?c=new` is the
 * blank composer the New link asks for, and an explicit id still wins —
 * `getControllerSurface` is what judges whether that id is theirs and in
 * scope, and still 404s when it belongs to another scope or another person.
 *
 * "This scope" is what the rail lists: `projectSlug: null` is the instance's
 * threads; a slug is the board's threads AND the threads anchored to its
 * tasks — same `projectSlug`, which is the boundary the query enforces. The
 * default is drawn from the viewer's OWN threads, exactly as the dock's is:
 * an org admin reading everyone's (`?all=1`) lands on a thread they can
 * actually talk in rather than on someone else's read-only transcript.
 */
function selectedConversationId(
  db: DatabaseSync,
  url: URL,
  binding: { userId: string; projectSlug: string | null },
): string | null {
  const requested = url.searchParams.get("c");
  if (requested === NEW_CONVERSATION_PARAM) return null;
  if (requested !== null) return requested;
  const newest = listConversations(db, {
    userId: binding.userId,
    projectSlug: binding.projectSlug,
    limit: 1,
  })[0];
  return newest?.id ?? null;
}

/**
 * Ruling 483 (F40-59): what the owner is asked to decide about the project's
 * knowledge. Live on WEB-1 the two proposals the operator filed were visible
 * only as timeline events that scrolled away, so nothing brought them back.
 */
function projectProposals(
  db: DatabaseSync,
  projectSlug: string,
  viewerIsOrgAdmin: boolean,
  dataRoot?: string,
): KbProposalView[] {
  const rulingsKb = projectRulingsKb(projectSlug, dataRoot ? { dataRoot } : {});
  return listProjectKbProposals(db, projectSlug, dataRoot).map((p) => ({
    id: p.id,
    kb: p.kb,
    doc: p.doc,
    rulings: p.kb === rulingsKb,
    taskKey: p.taskKey,
    filedOn: p.filedOn,
    filedBy: p.filedBy,
    line: p.line,
    correction: p.correction,
    evidence: p.evidence,
    docHref: viewerIsOrgAdmin ? kbDocHref(p) : null,
  }));
}

/** Ruling 498: corrections the page lists before the rest are left to the
 *  audit log and to `get_project`. */
const CORRECTIONS_SHOWN = 20;

/** What the page shows of one side of a correction. */
function clipped(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max).trimEnd()}…` : value;
}

/**
 * Ruling 498: what the board's agents changed in the knowledge every run
 * reads, where the owner looks, with Undo. The owner stopped approving each
 * correction ("No human can approve all of these while inspecting them
 * thoroughly"); this list is what they read afterwards instead.
 */
function projectCorrections(
  db: DatabaseSync,
  projectSlug: string,
  viewerIsOrgAdmin: boolean,
): KbCorrectionsView {
  const all = listKbCorrections(db, { projectSlug });
  return {
    total: all.length,
    shown: all.slice(0, CORRECTIONS_SHOWN).map((c) => ({
      id: c.id,
      kb: c.kb,
      doc: c.doc,
      rulings: c.rulings,
      replaced: c.replaced === null ? null : clipped(c.replaced, 1200),
      text: clipped(c.text, 1200),
      evidence: clipped(c.evidence, 600),
      taskKey: c.taskKey,
      filedBy: c.filedBy,
      at: c.at,
      undone: c.undone,
      docHref: viewerIsOrgAdmin ? kbDocHref(c) : null,
    })),
  };
}

export function getControllerSurface(
  db: DatabaseSync,
  viewer: { id: string },
  input: {
    projectSlug?: string | null;
    conversationId?: string | null;
    all?: boolean;
    dataRoot?: string;
    /** Ruling 457 (owner decision 2): how much of the open thread's console
     *  window to carry. The routes pass `shown` for a document load and
     *  `none` for a `.data` request; omitted, every window is carried. */
    console?: ConsoleShipping;
  },
): ControllerSurfaceView {
  const admin = isOrgAdmin(db, viewer.id);
  const scope = input.projectSlug ?? null;
  // Ruling 525: the viewer's role on this page's project decides whether they
  // may delete other people's threads about it, and so list them.
  const projectRole = scope
    ? (listProjectMembers(db, scope).find((m) => m.userId === viewer.id)?.role ?? null)
    : null;
  const deletesOthers = roleCan(projectRole, "delete-controller-conversations");
  const showAllAs = admin
    ? "org admin"
    : deletesOthers && projectRole
      ? `project ${ROLE_LABEL[projectRole].toLowerCase()}`
      : null;
  const showingAll = Boolean(input.all && showAllAs);
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

  // O39-d: the transcript this page opens is seen by its owner now, before the
  // list is marked, so the thread being read is never flagged.
  if (conversation && conversation.userId === viewer.id) {
    markConversationSeen(db, conversation.id, viewer.id);
  }
  const unseen = new Set(listUnseenReplies(db, viewer.id).map((r) => r.id));
  const working = new Set(liveTurnConversationIds());
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
    controllerName: resolveControllerName(input.dataRoot),
    projectName: scope ? (getProject(db, scope)?.name ?? scope) : null,
    conversations: rows.map((c) => {
      const readable = c.userId === viewer.id || admin;
      const ownerLabel = nameOf(c.userId, c.userLabel);
      return {
        id: c.id,
        // Ruling 525: a title is its starter's first words, which a project
        // admin who may delete the thread may not read (ruling 99(d)).
        title: readable ? c.title || "New conversation" : `${ownerLabel}'s conversation`,
        ownerLabel,
        own: c.userId === viewer.id,
        lastMessageAt: c.lastMessageAt,
        projectSlug: c.projectSlug,
        taskKey: c.taskKey,
        unread: c.userId === viewer.id && unseen.has(c.id),
        readable,
        canDelete: mayDeleteConversation(c, { userId: viewer.id, orgAdmin: admin, projectRole }),
        working: working.has(c.id),
      };
    }),
    conversation,
    messages,
    taskLinks: taskKeyLinks(
      db,
      messages.map((m) => m.text),
      { projectSlug: scope, viewerId: viewer.id },
    ),
    turn: conversation
      ? conversationTurnState(db, conversation.id)
      : IDLE_TURN,
    // Ruling 99: a controller run is stored at `project_slug = ''` with the
    // conversation id for its task key, which is the scope the grouping
    // projection is asked for here.
    runtime: conversation
      ? listRunsForTask(db, "", conversation.id, input.console ? { console: input.console } : {})
      : [],
    canInterruptTurn: conversation
      ? conversation.userId === viewer.id || admin
      : false,
    proposals: scope ? projectProposals(db, scope, admin, input.dataRoot) : null,
    corrections: scope ? projectCorrections(db, scope, admin) : null,
    viewerOwnsActive: conversation ? conversation.userId === viewer.id : false,
    showingAll,
    showAllAs,
    viewerIsOrgAdmin: admin,
  };
}

/** What both Controller pages load (ruling 99): `/controller` with
 *  `projectSlug` null, `/projects/:slug/controller` with its slug. */
export function controllerPageView(
  db: DatabaseSync,
  request: Request,
  viewer: { id: string },
  projectSlug: string | null,
): ControllerSurfaceView {
  const url = new URL(request.url);
  return getControllerSurface(db, viewer, {
    projectSlug,
    conversationId: selectedConversationId(db, url, { userId: viewer.id, projectSlug }),
    all: url.searchParams.get("all") === "1",
    // Ruling 457 (owner decision 2): console lines on a document load only.
    console: isDocumentNavigation(request) ? "shown" : "none",
  });
}
