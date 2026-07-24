import type { DatabaseSync } from "node:sqlite";
import { createNotification } from "~/server/projections/notifications.server";
import type { ActorRender } from "~/shared/mapping/actor.server";
import { extractMentions } from "~/ui/mention-spans";

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
 * Matching resolves an `@handle` against enabled users by email local-part,
 * first name, or FULL display name, case-insensitively. Parsing goes through the
 * shared span-finder with the users' display names as known handles, so
 * "@Arda Kaya" matches the whole name rather than only its first token
 * (P13-LV-11). Reserved agent handles never notify a person.
 */

/** Single-token mention grammar. Kept exported for callers that only need the
 *  raw token shape; routing itself goes through `extractMentions`. */
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
  const users = db
    .prepare(`SELECT id, email, name FROM users WHERE disabled = 0`)
    .all() as { id: string; email: string; name: string }[];

  // Parse with the users' FULL display names as known handles so "@Arda Kaya"
  // matches the whole name (P13-LV-11), not just its first token.
  const handles = new Set(
    extractMentions(
      input.text,
      users.map((u) => u.name),
    ).filter((h) => !RESERVED_HANDLES.has(h)),
  );
  if (handles.size === 0) return [];

  const mentioned: string[] = [];
  for (const user of users) {
    if (input.excludeUserId && user.id === input.excludeUserId) continue;
    const local = user.email.split("@")[0]?.toLowerCase() ?? "";
    const first = user.name.split(/\s+/)[0]?.toLowerCase() ?? "";
    const full = user.name.trim().toLowerCase();
    if (!handles.has(local) && !handles.has(first) && !handles.has(full)) continue;
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
