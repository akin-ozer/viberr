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
  listUnseenReplies,
  markConversationSeen,
  type ConversationActor,
  type ControllerConversation,
  type ControllerMessage,
  type ListConversationsInput,
} from "~/server/controller/controller-conversations.server";
import { resolveControllerName } from "~/server/controller/controller-profile.server";
import {
  conversationTurnState,
  IDLE_TURN,
  type ConversationTurnState,
} from "~/server/controller/controller-run.server";
import { listRunsForTask } from "~/server/runtimes/run-service.server";
import type { ConsoleShipping } from "~/server/runtimes/run-projection.server";
import type { RunView } from "~/features/runtime/runtime-types";
import {
  listGoals,
  readGoalFileFacts,
  type GoalView,
  type LinkTaskStatus,
} from "~/server/tasks/goal-actions.server";
import { userDisplayName } from "~/server/tasks/user-display-name.server";
import { taskKeyLinks } from "~/server/projections/task-key-links.server";
import type { TaskActivitySummary } from "~/server/projections/board-query.server";
import { waitingOnViewer } from "~/server/projections/decisions.server";
import { liveRunStateByTask } from "~/server/runtimes/run-store.server";
import { withLiveRun } from "~/shared/mapping/task.server";
import { toBoardCard } from "~/features/board/board-card";
import { cardStatus } from "~/features/board/card-status";
import { NEW_CONVERSATION_PARAM } from "./conversation-param";
import { projectRulingsKb } from "~/server/files/project-rulings.server";
import { kbDocHref, listProjectKbProposals } from "~/server/org/kb-proposals.server";
import { listKbCorrections } from "~/server/org/kb-corrections.server";

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
  goals: ControllerGoalView[] | null;
  /**
   * Ruling 476(h) (F40-61): the conversations this board's chains were planned
   * in that its rail does not already list (an instance thread, most often),
   * each naming the chains it planned. Only ones the viewer can open.
   */
  plannedElsewhere?: PlannedElsewhere[];
  /** Ruling 483 (F40-59): the open knowledge-base proposals agents filed from
   *  this project's tasks before ruling 497. Project surface only. */
  proposals: KbProposalView[] | null;
  /** Ruling 497: the knowledge-base corrections agents on this project's
   *  tasks wrote, newest first. Project surface only. */
  corrections: KbCorrectionsView | null;
  viewerOwnsActive: boolean;
  /** Org admin reading every conversation (?all=1). */
  showingAll: boolean;
  viewerIsOrgAdmin: boolean;
  /** Ruling 260: who is looking, so a goal's own creator gets its controls. */
  viewerId: string;
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

/** Ruling 497: one knowledge-base correction an agent wrote, as the project
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
}

/** Ruling 476(h): a conversation a chain was planned in, as the page links it. */
export interface PlannedConversation {
  id: string;
  title: string;
  /** Its own scope's controller page, opened on it. */
  href: string;
  /** Where it lives: "Instance", the task it is anchored to, or its board. */
  scopeLabel: string;
}

/** Ruling 476(h): a planning conversation the rail lists, with its chains. */
export interface PlannedElsewhere extends PlannedConversation {
  goalIds: string[];
}

/** A chain as the Controller page reads it. */
export type ControllerGoalView = GoalView & {
  /** Ruling 476(h): where the chain was planned, when the viewer can open it. */
  plannedIn?: PlannedConversation;
};

/**
 * Ruling 476(g) (F40-56): the board card's status word for every task of the
 * board, keyed by task, computed exactly as the board loader computes it: the
 * card's `waitingOnMe` from `waitingOnViewer` over the same review queue, the
 * run row's queued state (`withLiveRun`), then `cardStatus`. The goal rail
 * called a link whose task waited on its owner "active", in the colour of an
 * agent at work, while the board said "waiting on you".
 */
export function linkTaskStatuses(
  db: DatabaseSync,
  viewerId: string,
  projectSlug: string,
  tasks: readonly TaskActivitySummary[],
  readyKeys: Iterable<string>,
): Map<string, LinkTaskStatus> {
  const mine = waitingOnViewer(db, viewerId, projectSlug, readyKeys);
  const live = liveRunStateByTask(db, projectSlug);
  const out = new Map<string, LinkTaskStatus>();
  for (const task of tasks) {
    const status = cardStatus(
      toBoardCard(withLiveRun({ ...task, waitingOnMe: mine.has(task.key) }, live.get(task.key) ?? null)),
    );
    if (status) {
      out.set(task.key, { kind: status.kind, label: status.label, resumesAt: status.resumesAt ?? null });
    }
  }
  return out;
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
export function selectedConversationId(
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

/** Ruling 497: corrections the page lists before the rest are left to the
 *  audit log and to `get_project`. */
const CORRECTIONS_SHOWN = 20;

/** What the page shows of one side of a correction. */
function clipped(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max).trimEnd()}…` : value;
}

/**
 * Ruling 497: what the board's agents changed in the knowledge every run
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
  viewer: { id: string; email: string },
  input: {
    projectSlug?: string | null;
    conversationId?: string | null;
    all?: boolean;
    dataRoot?: string;
    /** Ruling 457 (owner decision 2): how much of the open thread's console
     *  window to carry. The routes pass `shown` for a document load and
     *  `none` for a `.data` request; omitted, every window is carried. */
    console?: ConsoleShipping;
    /** Ruling 476(g): the board card's status per task (`linkTaskStatuses`),
     *  asked for only when a chain has a started link to show it on. */
    taskStatuses?: () => ReadonlyMap<string, LinkTaskStatus>;
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

  // O39-d: the transcript this page opens is seen by its owner now, before the
  // list is marked, so the thread being read is never flagged.
  if (conversation && conversation.userId === viewer.id) {
    markConversationSeen(db, conversation.id, viewer.id);
  }
  const unseen = new Set(listUnseenReplies(db, viewer.id).map((r) => r.id));
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
  const goals = scope
    ? projectGoals(db, scope, {
        viewer: { userId: viewer.id, orgRole: admin ? "admin" : "member" },
        dataRoot: input.dataRoot,
        taskStatuses: input.taskStatuses,
      })
    : null;
  const listed = new Set(rows.map((c) => c.id));
  const plannedElsewhere = new Map<string, PlannedElsewhere>();
  for (const goal of goals ?? []) {
    const planned = goal.plannedIn;
    if (!planned || listed.has(planned.id)) continue;
    const entry = plannedElsewhere.get(planned.id) ?? { ...planned, goalIds: [] };
    entry.goalIds.push(goal.id);
    plannedElsewhere.set(planned.id, entry);
  }
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
    conversations: rows.map((c) => ({
      id: c.id,
      title: c.title || "New conversation",
      ownerLabel: nameOf(c.userId, c.userLabel),
      own: c.userId === viewer.id,
      lastMessageAt: c.lastMessageAt,
      projectSlug: c.projectSlug,
      taskKey: c.taskKey,
      unread: c.userId === viewer.id && unseen.has(c.id),
    })),
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
    goals,
    plannedElsewhere: [...plannedElsewhere.values()],
    proposals: scope ? projectProposals(db, scope, admin, input.dataRoot) : null,
    corrections: scope ? projectCorrections(db, scope, admin) : null,
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

/**
 * A board's chains as its Controller page reads them (ruling 99): the
 * projection, plus from each chain's own file its history (ruling 419(h): why
 * it paused, what a person said when they cancelled it) and the conversation
 * it was planned in (ruling 476(h)), plus each started link's board status
 * (ruling 476(g)).
 */
function projectGoals(
  db: DatabaseSync,
  projectSlug: string,
  opts: {
    viewer: ConversationActor;
    dataRoot: string | undefined;
    taskStatuses: (() => ReadonlyMap<string, LinkTaskStatus>) | undefined;
  },
): ControllerGoalView[] {
  const goals = listGoals(db, projectSlug);
  const started = goals.some((g) => g.links.some((l) => l.status === "active" && l.taskKey));
  const statuses = started && opts.taskStatuses ? opts.taskStatuses() : null;
  const planned = plannedConversationReader(db, opts.viewer, projectSlug);
  return goals.map((goal) => {
    const facts = readGoalFileFacts(projectSlug, goal.id, { dataRoot: opts.dataRoot });
    const view: ControllerGoalView = {
      ...goal,
      history: facts.history,
      conversationId: facts.conversationId,
      links: goal.links.map((link) => {
        const status = link.status === "active" && link.taskKey ? statuses?.get(link.taskKey) : undefined;
        return status ? { ...link, taskStatus: status } : link;
      }),
    };
    const plannedIn = planned(facts.conversationId);
    if (plannedIn) view.plannedIn = plannedIn;
    return view;
  });
}

/**
 * Ruling 476(h): the conversation a chain was planned in, as a link, when the
 * viewer may open it (its owner, or an org admin: `canAccessConversation`).
 * Conversations belong to the person who had them, so a member who did not
 * plan the chain is shown no link and no title. Each id is read once.
 */
function plannedConversationReader(
  db: DatabaseSync,
  viewer: ConversationActor,
  projectSlug: string,
): (conversationId: string | null) => PlannedConversation | null {
  const seen = new Map<string, PlannedConversation | null>();
  return (conversationId) => {
    if (!conversationId) return null;
    const known = seen.get(conversationId);
    if (known !== undefined) return known;
    const found = getConversation(db, conversationId);
    const planned =
      found && canAccessConversation(db, found, viewer)
        ? {
            id: found.id,
            title: found.title || "New conversation",
            href: `${found.projectSlug ? `/projects/${found.projectSlug}` : ""}/controller?c=${encodeURIComponent(found.id)}`,
            scopeLabel:
              found.projectSlug === null
                ? "Instance"
                : (found.taskKey ?? (found.projectSlug === projectSlug ? "This board" : found.projectSlug)),
          }
        : null;
    seen.set(conversationId, planned);
    return planned;
  };
}
