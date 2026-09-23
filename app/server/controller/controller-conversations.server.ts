import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { AppError } from "~/server/errors/app-error.server";
import { isOrgAdmin } from "~/server/auth/project-authority.server";
import { publishSseEvent } from "~/server/events/sse-broker.server";
import { newId } from "~/shared/ids/new-id.server";

/**
 * Controller conversation store (ruling 99; scope extended by ruling 121).
 *
 * App-owned SQLite, the notifications/sessions family (file-formats §5): a
 * transcript is single-writer app collaboration state, not board truth, so it
 * does not ride the file-canonical machinery. The DEEP record of each
 * controller turn (tool calls, token usage, raw stream) lives on that turn's
 * `agent_runs` row + NDJSON exactly like every other run; these tables hold
 * what a human reads back — the messages.
 *
 * SCOPE (ruling 121): a conversation is bound, at creation and forever, to
 * one of three places — the instance (`projectSlug` and `taskKey` both null),
 * one board (`projectSlug` alone) or one task (`projectSlug` + `taskKey`).
 * The binding is what the toolkit defaults to and what the server reads into
 * every turn (controller-context.server.ts); the dock lists one scope at a
 * time. A task binding without a project is refused here and by the CHECK.
 *
 * VISIBILITY: a conversation belongs to the user who started it — the one
 * person whose authority every action inside it is evaluated against — and is
 * readable by that user and org admins (supervision). Project members do NOT
 * see each other's conversations: a transcript is scoped to what ITS user was
 * entitled to hear, which is not a project-level entitlement.
 */

export interface ControllerConversation {
  id: string;
  userId: string;
  userLabel: string;
  /** Null = instance scope; a slug binds board-scope context. */
  projectSlug: string | null;
  /** Ruling 121: with `projectSlug`, anchors the conversation to ONE task. */
  taskKey: string | null;
  title: string;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string | null;
}

/**
 * O39-d: the owner has now seen this conversation up to its newest message.
 * Called by the two surfaces that show a transcript, when its owner is the
 * one looking. Monotonic and silent (it publishes nothing), like R19-15's
 * task read-marking, so the revalidation a reply triggers can run it again
 * and change nothing.
 */
export function markConversationSeen(
  db: DatabaseSync,
  conversationId: string,
  userId: string,
): void {
  db.prepare(
    `UPDATE controller_conversations
        SET seen_seq = MAX(seen_seq, COALESCE(
          (SELECT MAX(seq) FROM controller_messages WHERE conversation_id = ?), 0))
      WHERE id = ? AND user_id = ?`,
  ).run(conversationId, conversationId, userId);
}

/** O39-d: one of the viewer's conversations holding a reply they have not seen. */
export interface UnseenReply {
  id: string;
  title: string;
  projectSlug: string | null;
  taskKey: string | null;
}

/**
 * O39-d: the viewer's own conversations whose controller wrote after the
 * owner last looked, newest first. A turn runs one to five minutes; a person
 * who left the page had no way to learn its answer had landed.
 */
export function listUnseenReplies(db: DatabaseSync, userId: string): UnseenReply[] {
  // SAFETY: the four columns are selected by name; `id` and `title` are NOT
  // NULL in 0001_baseline and the two scope columns are nullable TEXT.
  const rows = db
    .prepare(
      `SELECT c.id, c.title, c.project_slug, c.task_key
         FROM controller_conversations c
        WHERE c.user_id = ?
          AND EXISTS (SELECT 1 FROM controller_messages m
                       WHERE m.conversation_id = c.id
                         AND m.author = 'controller'
                         AND m.seq > c.seen_seq)
        ORDER BY c.last_message_at DESC, c.rowid DESC
        LIMIT 20`,
    )
    .all(userId) as {
    id: string;
    title: string;
    project_slug: string | null;
    task_key: string | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    title: r.title || "New conversation",
    projectSlug: r.project_slug,
    taskKey: r.task_key,
  }));
}

export interface ControllerMessage {
  id: string;
  conversationId: string;
  seq: number;
  author: "user" | "controller";
  userId: string | null;
  text: string;
  runId: string | null;
  /** Ruling 121: the page a USER message was sent from (pathname + query);
   *  null on controller rows and on messages that predate the dock. */
  surface: string | null;
  createdAt: string;
}

/** Parses one `controller_conversations` row at the DB boundary. */
const conversationRowSchema = z
  .object({
    id: z.string(),
    user_id: z.string(),
    user_label: z.string(),
    project_slug: z.string().nullable(),
    task_key: z.string().nullable(),
    title: z.string(),
    created_at: z.string(),
    updated_at: z.string(),
    last_message_at: z.string().nullable(),
  })
  .transform(
    (r): ControllerConversation => ({
      id: r.id,
      userId: r.user_id,
      userLabel: r.user_label,
      projectSlug: r.project_slug,
      taskKey: r.task_key,
      title: r.title,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      lastMessageAt: r.last_message_at,
    }),
  );

/** Parses one `controller_messages` row at the DB boundary. */
const messageRowSchema = z
  .object({
    id: z.string(),
    conversation_id: z.string(),
    seq: z.number(),
    author: z.enum(["user", "controller"]),
    user_id: z.string().nullable(),
    text: z.string(),
    run_id: z.string().nullable(),
    surface: z.string().nullable(),
    created_at: z.string(),
  })
  .transform(
    (r): ControllerMessage => ({
      id: r.id,
      conversationId: r.conversation_id,
      seq: r.seq,
      author: r.author,
      userId: r.user_id,
      text: r.text,
      runId: r.run_id,
      surface: r.surface,
      createdAt: r.created_at,
    }),
  );

/** Reader/actor identity every access check runs against. */
export interface ConversationActor {
  userId: string;
  orgRole: "admin" | "member";
}

/** May this user read (and, when owner, write into) the conversation? */
export function canAccessConversation(
  db: DatabaseSync,
  conversation: ControllerConversation,
  actor: ConversationActor,
): boolean {
  if (conversation.userId === actor.userId) return true;
  // Org admins read every conversation (supervision). Resolve LIVE — a role
  // revoked mid-session must bind — and treat the session's own claim as a
  // hint only.
  return actor.orgRole === "admin" && isOrgAdmin(db, actor.userId);
}

/** May this user read this run's log? Controller runs authorize by conversation
 *  ownership (or live org-admin supervision), never by project membership — a
 *  transcript is scoped to what ITS user was entitled to hear.
 *
 *  It lives beside `canAccessConversation` rather than in the run engine
 *  (ruling 107): the run-log route, the session export and the controller's own
 *  `viberr_ops` diagnostics all ask it, and importing the engine to answer a
 *  conversation-access question made a cycle out of a lookup. */
export function canReadControllerRunLog(
  db: DatabaseSync,
  run: { kind: string; task_key: string },
  user: { id: string },
): boolean {
  return ownsOrSupervisesControllerRun(db, run, user);
}

/** May this user STOP this controller turn? The same two people who may read
 *  its log: the owner, whose turn and whose Claude account it is, and a live
 *  org admin (supervision). Its own name, because stopping is not reading: a
 *  later widening of one must be a decision about that one, never a side
 *  effect of the other. The run engine's `interruptRun` asks this for a
 *  controller run instead of the project membership a controller run has none
 *  of. */
export function canInterruptControllerRun(
  db: DatabaseSync,
  run: { kind: string; task_key: string },
  user: { id: string },
): boolean {
  return ownsOrSupervisesControllerRun(db, run, user);
}

function ownsOrSupervisesControllerRun(
  db: DatabaseSync,
  run: { kind: string; task_key: string },
  user: { id: string },
): boolean {
  if (run.kind !== "controller") return false;
  const conversation = getConversation(db, run.task_key);
  if (!conversation) return false;
  if (conversation.userId === user.id) return true;
  return isOrgAdmin(db, user.id);
}

/** Where a controller run's LIVE frames go: its conversation, and the owner
 *  whose `user` stream carries them. */
export interface ControllerRunRoute {
  conversationId: string;
  userId: string;
}

/**
 * Ruling 99: a controller turn has no task scope (`project_slug = ''`), so its
 * console lines and lifecycle flips cannot ride the task-routed run stream.
 * They route to the conversation's owner instead: the one person whose page
 * is tailing them (a supervising org admin reads the same console off the
 * loader's poll). Null for every other run kind, and for a controller run
 * whose conversation is gone, which then publishes to nobody, as before.
 */
export function controllerRunRoute(
  db: DatabaseSync,
  run: { kind: string; task_key: string },
): ControllerRunRoute | null {
  if (run.kind !== "controller") return null;
  const conversation = getConversation(db, run.task_key);
  return conversation
    ? { conversationId: conversation.id, userId: conversation.userId }
    : null;
}

export function getConversation(
  db: DatabaseSync,
  id: string,
): ControllerConversation | null {
  const row = db
    .prepare(`SELECT * FROM controller_conversations WHERE id = ?`)
    .get(id);
  return row ? conversationRowSchema.parse(row) : null;
}

/** The conversation, with access enforced (404-shape for the invisible). */
export function requireConversation(
  db: DatabaseSync,
  id: string,
  actor: ConversationActor,
): ControllerConversation {
  const conversation = getConversation(db, id);
  if (!conversation || !canAccessConversation(db, conversation, actor)) {
    // Indistinguishable from "never existed" for non-owners, the same posture
    // as members-only projects (R15-4).
    throw AppError.notFound("Conversation not found.");
  }
  return conversation;
}

/** The three shapes a conversation can be bound to (ruling 121). */
export type ConversationScope = "instance" | "board" | "task";

export function conversationScopeOf(binding: {
  projectSlug: string | null;
  taskKey: string | null;
}): ConversationScope {
  if (binding.taskKey) return "task";
  if (binding.projectSlug) return "board";
  return "instance";
}

export interface CreateConversationInput {
  userId: string;
  userLabel: string;
  projectSlug?: string | null;
  /** Ruling 121: anchors the conversation to one task of `projectSlug`. */
  taskKey?: string | null;
}

export function createConversation(
  db: DatabaseSync,
  input: CreateConversationInput,
): ControllerConversation {
  const projectSlug = input.projectSlug?.trim() || null;
  const taskKey = input.taskKey?.trim() || null;
  if (taskKey && !projectSlug) {
    // THIS is the enforcement, not the schema: a fresh root also carries the
    // CHECK, but a root upgraded by the additive backstop (sqlite.server.ts,
    // review G1) cannot — ALTER TABLE adds columns, never constraints.
    throw AppError.validation(
      "A conversation anchored to a task must name the task's project.",
    );
  }
  const now = new Date().toISOString();
  const id = newId("cnv");
  db.prepare(
    `INSERT INTO controller_conversations
       (id, user_id, user_label, project_slug, task_key, title, created_at, updated_at, last_message_at)
     VALUES (?, ?, ?, ?, ?, '', ?, ?, NULL)`,
  ).run(id, input.userId, input.userLabel, projectSlug, taskKey, now, now);
  // SAFETY: the row was just inserted under this id.
  return getConversation(db, id)!;
}

export interface ListConversationsInput {
  /** Owner filter (the normal list). */
  userId?: string;
  /** Scope filter: undefined = all scopes; null = instance-only; slug = that
   *  project's conversations (board AND task ones, unless `taskKey` narrows). */
  projectSlug?: string | null;
  /** Ruling 121: undefined = any binding under `projectSlug`; null = the
   *  board's own threads only; a key = that task's threads only. */
  taskKey?: string | null;
  limit?: number;
}

export function listConversations(
  db: DatabaseSync,
  input: ListConversationsInput,
): ControllerConversation[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (input.userId !== undefined) {
    where.push("user_id = ?");
    params.push(input.userId);
  }
  if (input.projectSlug !== undefined) {
    if (input.projectSlug === null) where.push("project_slug IS NULL");
    else {
      where.push("project_slug = ?");
      params.push(input.projectSlug);
    }
  }
  if (input.taskKey !== undefined) {
    if (input.taskKey === null) where.push("task_key IS NULL");
    else {
      where.push("task_key = ?");
      params.push(input.taskKey);
    }
  }
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const rows = db
    .prepare(
      // Ruling 121 hangs "the newest thread of this scope" on rows[0], and
      // `created_at` has millisecond resolution: two threads made in the same
      // millisecond tie, and the sort index then breaks the tie by insertion
      // order ASCENDING — returning the OLDER one first. `rowid DESC` is the
      // repo's own tie-break (operator-actions.server.ts:1627) and makes the
      // promise a property of the store rather than of the clock.
      `SELECT * FROM controller_conversations
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY COALESCE(last_message_at, created_at) DESC, rowid DESC
       LIMIT ${limit}`,
    )
    .all(...params);
  return rows.map((row) => conversationRowSchema.parse(row));
}

export function listMessages(
  db: DatabaseSync,
  conversationId: string,
): ControllerMessage[] {
  const rows = db
    .prepare(
      `SELECT * FROM controller_messages WHERE conversation_id = ? ORDER BY seq ASC`,
    )
    .all(conversationId);
  return rows.map((row) => messageRowSchema.parse(row));
}

/** The newest N messages in chronological order (prompt-context slice). */
export function recentMessages(
  db: DatabaseSync,
  conversationId: string,
  limit: number,
): ControllerMessage[] {
  const rows = db
    .prepare(
      `SELECT * FROM controller_messages WHERE conversation_id = ?
       ORDER BY seq DESC LIMIT ?`,
    )
    .all(conversationId, limit);
  return rows.map((row) => messageRowSchema.parse(row)).reverse();
}

/** The longest surface string a message keeps (a pathname plus a query). */
export const MESSAGE_SURFACE_MAX_CHARS = 400;

/** Ruling 121: a surface is an in-app path (`/…`) and nothing else — a stray
 *  absolute URL, a protocol-relative one or control characters never reach
 *  the row or the prompt. */
export function normalizeSurface(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) return null;
  for (const ch of trimmed) {
    const code = ch.charCodeAt(0);
    if (code < 32 || code === 127) return null;
  }
  return trimmed.slice(0, MESSAGE_SURFACE_MAX_CHARS);
}

export interface AppendMessageInput {
  conversationId: string;
  author: "user" | "controller";
  userId?: string | null;
  text: string;
  runId?: string | null;
  /** Stored on USER rows only; a controller row never carries one. */
  surface?: string | null;
}

/** Append one message; bumps the conversation clock and derives a title from
 *  the first user message. Publishes the owner-routed `controller.updated`
 *  reference so every open surface of the owner revalidates. */
export function appendMessage(
  db: DatabaseSync,
  input: AppendMessageInput,
): ControllerMessage {
  const conversation = getConversation(db, input.conversationId);
  if (!conversation) {
    throw AppError.notFound("Conversation not found.");
  }
  const now = new Date().toISOString();
  const id = newId("cmsg");
  // Next seq under the SQLite write lock — single-writer per data root, so a
  // MAX+1 read-then-insert cannot interleave across processes, and the UNIQUE
  // (conversation_id, seq) index backstops a same-process race.
  const seqRow = z
    .object({ next: z.number() })
    .parse(
      db
        .prepare(
          `SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM controller_messages
           WHERE conversation_id = ?`,
        )
        .get(input.conversationId),
    );
  const surface =
    input.author === "user" ? normalizeSurface(input.surface) : null;
  db.prepare(
    `INSERT INTO controller_messages
       (id, conversation_id, seq, author, user_id, text, run_id, surface, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.conversationId,
    seqRow.next,
    input.author,
    input.userId ?? null,
    input.text,
    input.runId ?? null,
    surface,
    now,
  );
  const title =
    conversation.title ||
    (input.author === "user" ? deriveTitle(input.text) : "");
  db.prepare(
    `UPDATE controller_conversations
     SET updated_at = ?, last_message_at = ?, title = ?
     WHERE id = ?`,
  ).run(now, now, title, input.conversationId);
  publishConversationUpdated(conversation.id, conversation.userId);
  // The row was inserted above under this id.
  return messageRowSchema.parse(
    db.prepare(`SELECT * FROM controller_messages WHERE id = ?`).get(id),
  );
}

/**
 * Ruling 274 (pass 37, F37-107): a deleted project releases its conversations
 * instead of leaving them bound to a slug that no longer exists.
 *
 * `controller_conversations` is app-owned state with no FK cascade, the same
 * family as the notification, credential-binding and repo-health rows
 * `deleteProject` already clears — and it was the one that kept its binding. A
 * conversation left pointing at a deleted project is not merely stale: the
 * binding is what `slugOf()` DEFAULTS to, so the next message typed into it
 * acts on that slug. Create a project with the same name — slugs are derived
 * from the name, so this is the ordinary way a slug comes back — and the old
 * conversation silently becomes a conversation about the NEW board, carrying a
 * transcript about work that has nothing to do with it, with every tool call
 * aimed at a project its author never chose.
 *
 * Released, not deleted: the transcript is the record of what somebody asked
 * and what the controller did, and this product does not destroy records
 * (ruling 17's posture, and `update_goal`'s "completed and cancelled chains
 * stay readable"). The conversation becomes instance-scoped, which is a real
 * scope, and carries a message saying why so its author is not left wondering
 * where the board went.
 */
export function releaseProjectConversations(
  db: DatabaseSync,
  projectSlug: string,
  projectName: string,
): number {
  // SAFETY: `id` is the TEXT PRIMARY KEY of `controller_conversations`
  // (0001_baseline), so every row answers this single-column select.
  const rows = db
    .prepare(`SELECT id FROM controller_conversations WHERE project_slug = ?`)
    .all(projectSlug) as { id: string }[];
  for (const row of rows) {
    // The note goes on BEFORE the unbind, so a reader sees the last thing that
    // happened while the conversation was still about that board.
    appendMessage(db, {
      conversationId: row.id,
      author: "controller",
      text:
        `The project "${projectName}" was deleted, so this conversation is no longer bound to ` +
        `it. Everything above stays on the record. From here it is an instance conversation: ` +
        `name a project on any board tool, or start a new conversation on the board you mean.`,
    });
    // Both columns, because a task key without a project is not a scope (the
    // table's own CHECK says so).
    db.prepare(
      `UPDATE controller_conversations
       SET project_slug = NULL, task_key = NULL, updated_at = ?
       WHERE id = ?`,
    ).run(new Date().toISOString(), row.id);
  }
  return rows.length;
}

/** The longest title the rail and the thread switcher show whole. */
const TITLE_MAX = 80;
/** A first sentence shorter than this ("Good graph.") names nothing. */
const TITLE_SENTENCE_MIN = 20;

/**
 * First user message, as the conversation title.
 *
 * U39-19 (pass 39): it was the first 79 characters, cut mid-word. The rail
 * and the phone's thread switcher read "Knowledge base check, please. Since the
 * ax-clone knowledge bases were last writ…" and "AX-20 has to land before
 * AX-22. AX-21, AX-5 and goal-6 wait o…". A person's first sentence is usually
 * the ask, so it is the title when it is long enough to name something and
 * short enough to show whole. Otherwise the text is clipped at a word.
 */
export function deriveTitle(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  // A sentence ends at . ! or ? (after any closing quote or bracket) followed
  // by a space: "(PR #19)." ends one, "0.19.0" and "e.g" do not.
  const first = /^(.+?[.!?]["'”’)\]]*)(?= )/.exec(flat)?.[1];
  if (first && first.length >= TITLE_SENTENCE_MIN && first.length <= TITLE_MAX) return first;
  if (flat.length <= TITLE_MAX) return flat;
  const cut = flat.slice(0, TITLE_MAX - 1);
  const space = cut.lastIndexOf(" ");
  return `${space >= TITLE_MAX / 2 ? cut.slice(0, space) : cut}…`;
}

/** Owner-routed compact reference — the conversation surface revalidates. */
export function publishConversationUpdated(
  conversationId: string,
  ownerUserId: string,
): void {
  publishSseEvent(
    {
      type: "controller.updated",
      entityId: conversationId,
      occurredAt: new Date().toISOString(),
      data: { conversationId, userId: ownerUserId },
    },
    { userId: ownerUserId },
  );
}
