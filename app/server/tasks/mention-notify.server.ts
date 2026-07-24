import type { DatabaseSync } from "node:sqlite";
import { createNotification } from "~/server/projections/notifications.server";
import type { ActorRender } from "~/shared/mapping/actor.server";

/**
 * @mention → `mention`-notification fan-out, shared by EVERY comment writer
 * (NEW-4). Historically only the HUMAN comment path (`appendComment`) fanned
 * out, so an agent or operator reply that tagged a person ("@Arda …") notified
 * no one — the tag was decorative. Agents are now instructed to tag the human
 * they're answering (agent-reply directives + operator turn instruction), and
 * every agent-authored comment writer (operator narration, specialist reply,
 * mid-run agent comments) funnels through this helper so those tags actually
 * reach the person's inbox.
 *
 * Matching is the SAME rule the human path always used: a single-token
 * `@handle` resolves against enabled users by email local-part or first name,
 * case-insensitively. A multi-word display-name mention ("@Arda Kaya") matches
 * via its first token — MENTION_RE captures "Arda", which is the first-name
 * rule. Reserved agent handles never notify a person.
 */

/** All @handles in a comment (single-token grammar — the server routing rule). */
export const MENTION_RE = /@([A-Za-z][\w-]*)/g;

/** Handles that route to agents, never to a person named e.g. "Claude". */
export const RESERVED_HANDLES = new Set(["agent", "operator", "codex", "claude"]);

/** Cap the quoted comment inside the notification text — an agent reply can be
 *  a full report; the inbox row needs the gist, the timeline has the rest. */
const NOTIFY_QUOTE_MAX = 240;

function clip(text: string): string {
  const t = text.trim();
  return t.length <= NOTIFY_QUOTE_MAX ? t : `${t.slice(0, NOTIFY_QUOTE_MAX - 1).trimEnd()}…`;
}

export interface NotifyMentionsInput {
  /** The comment text to scan for @handles. */
  text: string;
  projectSlug: string;
  taskKey: string;
  /** Who wrote the comment — rendered as the notification's `from` chip. */
  from: ActorRender;
  /** The author's user id (human comments) — never notify the author. */
  excludeUserId?: string | null;
  occurredAt?: string;
}

/**
 * Notify every enabled user the text @mentions. Returns the matched user ids
 * (users-table order — the shape `appendComment` has always returned). Routing
 * prefs are respected via `createNotification` (a user who silenced the
 * `mention` category is skipped there).
 */
export function notifyMentionedUsers(
  db: DatabaseSync,
  input: NotifyMentionsInput,
): string[] {
  const handles = new Set<string>();
  for (const match of input.text.matchAll(MENTION_RE)) {
    const handle = match[1]!.toLowerCase();
    if (!RESERVED_HANDLES.has(handle)) handles.add(handle);
  }
  if (handles.size === 0) return [];

  const users = db
    .prepare(`SELECT id, email, name FROM users WHERE disabled = 0`)
    .all() as { id: string; email: string; name: string }[];

  const mentioned: string[] = [];
  for (const user of users) {
    if (input.excludeUserId && user.id === input.excludeUserId) continue;
    const local = user.email.split("@")[0]?.toLowerCase() ?? "";
    const first = user.name.split(/\s+/)[0]?.toLowerCase() ?? "";
    if (!handles.has(local) && !handles.has(first)) continue;
    mentioned.push(user.id);
    createNotification(db, {
      userId: user.id,
      kind: "mention",
      text: `mentioned you — “${clip(input.text)}”`,
      from: input.from,
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
    });
  }
  return mentioned;
}
