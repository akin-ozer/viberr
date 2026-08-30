import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { AppError } from "~/server/errors/app-error.server";
import { isOrgAdmin } from "~/server/auth/project-authority.server";
import { publishSseEvent } from "~/server/events/sse-broker.server";
import { newId } from "~/shared/ids/new-id.server";

/**
 * Controller conversation store (ruling 99).
 *
 * App-owned SQLite, the notifications/sessions family (file-formats §5): a
 * transcript is single-writer app collaboration state, not board truth, so it
 * does not ride the file-canonical machinery. The DEEP record of each
 * controller turn (tool calls, token usage, raw stream) lives on that turn's
 * `agent_runs` row + NDJSON exactly like every other run; these tables hold
 * what a human reads back — the messages.
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
  title: string;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string | null;
}

export interface ControllerMessage {
  id: string;
  conversationId: string;
  seq: number;
  author: "user" | "controller";
  userId: string | null;
  text: string;
  runId: string | null;
  createdAt: string;
}

const conversationRowSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  user_label: z.string(),
  project_slug: z.string().nullable(),
  title: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  last_message_at: z.string().nullable(),
});

const messageRowSchema = z.object({
  id: z.string(),
  conversation_id: z.string(),
  seq: z.number(),
  author: z.enum(["user", "controller"]),
  user_id: z.string().nullable(),
  text: z.string(),
  run_id: z.string().nullable(),
  created_at: z.string(),
});

function toConversation(row: unknown): ControllerConversation {
  const r = conversationRowSchema.parse(row);
  return {
    id: r.id,
    userId: r.user_id,
    userLabel: r.user_label,
    projectSlug: r.project_slug,
    title: r.title,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastMessageAt: r.last_message_at,
  };
}

function toMessage(row: unknown): ControllerMessage {
  const r = messageRowSchema.parse(row);
  return {
    id: r.id,
    conversationId: r.conversation_id,
    seq: r.seq,
    author: r.author,
    userId: r.user_id,
    text: r.text,
    runId: r.run_id,
    createdAt: r.created_at,
  };
}

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

export function getConversation(
  db: DatabaseSync,
  id: string,
): ControllerConversation | null {
  const row = db
    .prepare(`SELECT * FROM controller_conversations WHERE id = ?`)
    .get(id);
  return row ? toConversation(row) : null;
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

export interface CreateConversationInput {
  userId: string;
  userLabel: string;
  projectSlug?: string | null;
}

export function createConversation(
  db: DatabaseSync,
  input: CreateConversationInput,
): ControllerConversation {
  const now = new Date().toISOString();
  const id = newId("cnv");
  db.prepare(
    `INSERT INTO controller_conversations
       (id, user_id, user_label, project_slug, title, created_at, updated_at, last_message_at)
     VALUES (?, ?, ?, ?, '', ?, ?, NULL)`,
  ).run(id, input.userId, input.userLabel, input.projectSlug ?? null, now, now);
  // SAFETY: the row was just inserted under this id.
  return getConversation(db, id)!;
}

export interface ListConversationsInput {
  /** Owner filter (the normal list). */
  userId?: string;
  /** Scope filter: undefined = all scopes; null = instance-only; slug = that
   *  project's conversations. */
  projectSlug?: string | null;
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
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const rows = db
    .prepare(
      `SELECT * FROM controller_conversations
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY COALESCE(last_message_at, created_at) DESC
       LIMIT ${limit}`,
    )
    .all(...params);
  return rows.map(toConversation);
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
  return rows.map(toMessage);
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
  return rows.map(toMessage).reverse();
}

export interface AppendMessageInput {
  conversationId: string;
  author: "user" | "controller";
  userId?: string | null;
  text: string;
  runId?: string | null;
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
  db.prepare(
    `INSERT INTO controller_messages
       (id, conversation_id, seq, author, user_id, text, run_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.conversationId,
    seqRow.next,
    input.author,
    input.userId ?? null,
    input.text,
    input.runId ?? null,
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
  // SAFETY: inserted above under this id.
  return toMessage(
    db.prepare(`SELECT * FROM controller_messages WHERE id = ?`).get(id),
  );
}

/** First user message, flattened and clipped, as the conversation title. */
export function deriveTitle(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 80 ? `${flat.slice(0, 79)}…` : flat;
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
