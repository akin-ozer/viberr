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
 * Parsing goes through the shared span-finder with the users' display names as
 * known handles, so "@Arda Kaya" matches the whole name rather than only its
 * first token (P13-LV-11). Reserved agent handles never notify a person.
 *
 * ROUTING (B-FD2). Matching used to be a flat OR of local-part / first name /
 * full name, so on a team with two Ardas "@arda" notified BOTH — and neither
 * could tell whether the message was for them. A mention is addressed to one
 * person, so resolution is a priority ladder and a tie routes nowhere:
 *
 *   1. exact email local-part  (`@arda-kaya` for arda-kaya@…)
 *   2. exact full display name (`@Arda Kaya`, or its dashed form `@arda-kaya`)
 *   3. a first name that is UNIQUE among enabled users
 *
 * The first tier with any candidate decides; more than one candidate in that
 * tier is AMBIGUOUS and notifies nobody, because guessing is worse than a
 * visible non-delivery. {@link MentionFanout.ambiguous} carries those handles
 * so a human's comment can say so on the timeline instead of the mention
 * silently going nowhere. A person tagged twice in one comment (by handle and
 * by name) is notified once.
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

export interface MentionableUser {
  id: string;
  email: string;
  name: string;
}

export interface MentionResolution {
  /** Users to notify, in the input (users-table) order, deduplicated. */
  userIds: string[];
  /** Handles that matched more than one person and so notified NOBODY. */
  ambiguous: string[];
}

function localPart(email: string): string {
  return email.split("@")[0]?.toLowerCase() ?? "";
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
}

/** Both written forms of a display name: "arda kaya" (the span-finder's known
 *  name match) and "arda-kaya" (the single-token grammar's dashed form). */
function fullNameKeys(name: string): string[] {
  const full = name.trim().toLowerCase().replace(/\s+/g, " ");
  return full.length === 0 ? [] : [full, full.replace(/ /g, "-")];
}

/**
 * Resolve every @handle in `text` against `users` (already filtered to those
 * eligible to be notified). Pure — the fan-out below and any caller that wants
 * the ambiguity report without writing notifications share this one ladder.
 */
export function resolveMentionTargets(
  users: readonly MentionableUser[],
  text: string,
): MentionResolution {
  const handles = new Set(
    extractMentions(
      text,
      users.map((u) => u.name),
    ).filter((h) => !RESERVED_HANDLES.has(h)),
  );
  if (handles.size === 0) return { userIds: [], ambiguous: [] };

  const matched = new Set<string>();
  const ambiguous: string[] = [];
  for (const handle of handles) {
    // Tiers in priority order; the FIRST non-empty tier decides, so a person
    // whose local-part is someone else's first name still wins their own handle.
    const tiers = [
      users.filter((u) => localPart(u.email) === handle),
      users.filter((u) => fullNameKeys(u.name).includes(handle)),
      users.filter((u) => firstName(u.name) === handle),
    ];
    const tier = tiers.find((candidates) => candidates.length > 0);
    if (!tier) continue;
    if (tier.length > 1) {
      ambiguous.push(handle);
      continue;
    }
    matched.add(tier[0]!.id);
  }

  return {
    userIds: users.filter((u) => matched.has(u.id)).map((u) => u.id),
    ambiguous,
  };
}

/**
 * The timeline note a HUMAN comment carries when one of its @handles matched
 * several people. Non-delivery has to be visible: the author is the only one
 * who can retag, and they are still looking at the task.
 */
export function ambiguousMentionNote(handles: readonly string[]): string {
  if (handles.length === 0) return "";
  const list = handles.map((h) => `@${h}`).join(", ");
  const subject = handles.length === 1 ? "matches" : "match";
  return `_${list} ${subject} more than one person here, so nobody was notified — mention the full name (“@First Last”) or the email handle._`;
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

export interface MentionFanout {
  /** Users actually notified (users-table order). */
  mentioned: string[];
  /** Handles that matched several people and therefore notified nobody. */
  ambiguous: string[];
}

/**
 * Notify every enabled user the text unambiguously @mentions, and report the
 * handles that were too ambiguous to route. Routing prefs are respected via
 * `createNotification` (a user who silenced the `mention` category is skipped
 * there).
 *
 * Ambiguity is judged over ALL enabled users, before the author exclusion: a
 * comment by one Arda tagging "@arda" on a team of two is still ambiguous —
 * dropping the author would silently redirect it to the other one.
 */
export function fanOutMentions(
  db: DatabaseSync,
  input: NotifyMentionsInput,
): MentionFanout {
  const users = db
    .prepare(`SELECT id, email, name FROM users WHERE disabled = 0`)
    .all() as unknown as MentionableUser[];

  const { userIds, ambiguous } = resolveMentionTargets(users, input.text);
  const mentioned: string[] = [];
  for (const userId of userIds) {
    if (input.excludeUserId && userId === input.excludeUserId) continue;
    mentioned.push(userId);
    createNotification(db, {
      userId,
      kind: "mention",
      text: `mentioned you — “${clip(input.text)}”`,
      from: input.from,
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
    });
  }
  return { mentioned, ambiguous };
}

/**
 * Notified user ids only — the shape every existing comment writer consumes.
 * Callers that surface the non-delivery note (human comments) use
 * {@link fanOutMentions} instead.
 */
export function notifyMentionedUsers(
  db: DatabaseSync,
  input: NotifyMentionsInput,
): string[] {
  return fanOutMentions(db, input).mentioned;
}
