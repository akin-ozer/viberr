import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  type CreateNotificationInput,
  createNotification,
} from "~/server/projections/notifications.server";
import type { ActorRender } from "~/shared/mapping/actor.server";
import { extractMentions, findMentionSpans } from "~/ui/mention-spans";

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
 * so the comment can say so on the timeline instead of the mention silently
 * going nowhere — a human comment gets a policy note, a machine-authored one
 * carries {@link withAmbiguityDisclosure}. A person tagged twice in one comment
 * (by handle and by name) is notified once.
 *
 * SCOPE (F33-9). The ladder resolves over every enabled user, but only a MEMBER
 * of the project is ever notified. The fan-out used to write a `mention` row for
 * any enabled account, so tagging someone who belongs to a different project put
 * a row in their inbox naming this project, this task and the comment text — and
 * the link then served them the members-only 404. That is ruling 25 read
 * backwards: the layout loader and every action return the SAME bytes for a
 * non-member as for an unknown slug precisely so "a probe cannot learn a project
 * exists", and the notification told them. A handle that resolves to exactly one
 * real, enabled NON-member is therefore reported as {@link
 * MentionResolution.nonMembers} rather than silently dropped — same reasoning as
 * ambiguity: the author must be able to see that their tag reached nobody.
 * Membership, not the tier ladder, is what changes; resolution still runs over
 * all enabled users so a non-member who shares a first name with a member still
 * makes the handle ambiguous (guessing stays worse than a visible non-delivery).
 */

/** Single-token mention grammar. Kept exported for callers that only need the
 *  raw token shape; routing itself goes through `extractMentions`. */
export const MENTION_RE = /@([A-Za-z][\w-]*)/g;

/** Handles that route to agents, never to a person named e.g. "Claude". */
// "controller" (ruling 99): the instance controller's handle never maps to a human.
export const RESERVED_HANDLES = new Set(["agent", "operator", "codex", "claude", "controller"]);

/** Cap the quoted comment inside the notification text — an agent reply can be
 *  a full report; the inbox row needs the gist, the timeline has the rest. */
const NOTIFY_QUOTE_MAX = 240;
/** Run-up kept before the mention when the window has to move off the head, so
 *  the quote opens on the sentence the handle sits in rather than on the handle. */
const QUOTE_LEAD = 80;
/** How far the window start may slide forward to land after a space instead of
 *  inside a word. Past this it is cheaper to begin mid-word than to lose text. */
const QUOTE_SNAP = 24;

function clip(text: string): string {
  const t = text.trim();
  return t.length <= NOTIFY_QUOTE_MAX ? t : `${t.slice(0, NOTIFY_QUOTE_MAX - 1).trimEnd()}…`;
}

/**
 * Ruling 233 — the quote a mention notification carries must contain the
 * mention that caused it.
 *
 * `clip` takes the head of the comment, which is the right window only when the
 * handle is near the top. It often is not: an operator directive opens by naming
 * the agent it is dispatching and reaches the person hundreds of characters
 * later, and an agent's report reaches them later still. Measured on pass 37's
 * live instance, 19 of 49 mention notifications (39%) quoted a window that
 * excluded the handle they were sent for, so the row read "mentioned you"
 * above a sentence addressed to somebody else and the recipient had to open the
 * task and search it for their own name — the work the notification exists to
 * save.
 *
 * `at` is an index into `text` (a span start from `findMentionSpans`). The head
 * window is kept whenever it already covers the mention, so the common case is
 * byte-for-byte what it was; only a mention past the cap moves the window.
 */
function quoteAround(text: string, at: number): string {
  const t = text.trim();
  if (t.length <= NOTIFY_QUOTE_MAX) return t;
  // `at` indexes the untrimmed text; every offset below is on the trimmed one.
  const mark = Math.max(0, at - (text.length - text.trimStart().length));
  if (mark < NOTIFY_QUOTE_MAX) return clip(text);
  let start = Math.max(0, mark - QUOTE_LEAD);
  const space = t.indexOf(" ", start);
  if (space !== -1 && space - start < QUOTE_SNAP) start = space + 1;
  const end = Math.min(t.length, start + NOTIFY_QUOTE_MAX - 2);
  return `${start > 0 ? "…" : ""}${t.slice(start, end).trim()}${end < t.length ? "…" : ""}`;
}

/**
 * The quote for ONE recipient: windowed on the first handle in the text that
 * resolved to them, or the head when none did (a caller that notified them for
 * another reason). `matchedBy` is the resolver's handle-to-user map, so "which
 * span is theirs" is answered by the same ladder that decided to notify them.
 */
function quoteForUser(
  text: string,
  userId: string,
  matchedBy: ReadonlyMap<string, string>,
  knownNames: readonly string[],
): string {
  for (const span of findMentionSpans(text, [...knownNames])) {
    if (matchedBy.get(span.handle) === userId) return quoteAround(text, span.start);
  }
  return clip(text);
}

export interface MentionableUser {
  id: string;
  email: string;
  name: string;
}

export interface MentionResolution {
  /** Users to notify, in the input (users-table) order, deduplicated. */
  userIds: string[];
  /** Which handle won which user, for a caller that needs to point at the
   *  mention itself rather than just know that one happened (ruling 233). */
  matchedBy: Map<string, string>;
  /** Handles that matched more than one person and so notified NOBODY. */
  ambiguous: string[];
  /** Handles that matched exactly one real, enabled user who is NOT a member of
   *  this project, and so notified NOBODY (F33-9). Always empty when the caller
   *  resolved without a membership set. */
  nonMembers: string[];
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
 *
 * `memberIds`, when given, is the project's membership: a handle that resolves
 * to one user outside it notifies nobody and lands in `nonMembers` (F33-9).
 * Omitting it resolves app-wide, which is only correct for a caller that has no
 * project in hand — every project-scoped caller passes the set.
 */
export function resolveMentionTargets(
  users: readonly MentionableUser[],
  text: string,
  memberIds?: ReadonlySet<string>,
): MentionResolution {
  const handles = new Set(
    extractMentions(
      text,
      users.map((u) => u.name),
    ).filter((h) => !RESERVED_HANDLES.has(h)),
  );
  const matchedBy = new Map<string, string>();
  if (handles.size === 0) {
    return { userIds: [], matchedBy, ambiguous: [], nonMembers: [] };
  }

  const matched = new Set<string>();
  const ambiguous: string[] = [];
  const nonMembers: string[] = [];
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
    const target = tier[0]!;
    // F33-9: the handle names a real person, just not one who can open this
    // project. Reported, never delivered — see the SCOPE note at the top.
    if (memberIds && !memberIds.has(target.id)) {
      nonMembers.push(handle);
      continue;
    }
    matched.add(target.id);
    matchedBy.set(handle, target.id);
  }

  return {
    userIds: users.filter((u) => matched.has(u.id)).map((u) => u.id),
    matchedBy,
    ambiguous,
    nonMembers,
  };
}

/**
 * The timeline note a comment carries when one of its @handles matched several
 * people. Non-delivery has to be visible: on a human comment the author is the
 * only one who can retag and is still looking at the task; on a machine-authored
 * comment (agent / operator) nobody would ever learn the tag reached no one.
 */
export function ambiguousMentionNote(handles: readonly string[]): string {
  if (handles.length === 0) return "";
  const list = handles.map((h) => `@${h}`).join(", ");
  const subject = handles.length === 1 ? "matches" : "match";
  return `_${list} ${subject} more than one person here, so nobody was notified — mention the full name (“@First Last”) or the email handle._`;
}

/**
 * The same note for the OTHER non-delivery (F33-9): the handle names exactly one
 * real person, who is not on this project. Silence would be worse here than for
 * ambiguity — the author has no way to tell "nobody by that name" from "someone
 * by that name who cannot see this task", and the old behaviour (notify them
 * anyway) is the boundary crossing this fix closes. Deliberately says nothing
 * about the person beyond the handle the author already typed.
 */
export function nonMemberMentionNote(handles: readonly string[]): string {
  if (handles.length === 0) return "";
  const list = handles.map((h) => `@${h}`).join(", ");
  const subject = handles.length === 1 ? "is not a member" : "are not members";
  return `_${list} ${subject} of this project, so nobody was notified — add them to the project first, or mention a member._`;
}

/** `users.id` is the TEXT primary key; `email` and `name` are TEXT NOT NULL. */
const mentionableUserRowsSchema = z.array(
  z.object({ id: z.string(), email: z.string(), name: z.string() }),
);

/** The enabled users the fan-out and the ambiguity report both resolve against. */
function enabledUsers(db: DatabaseSync): MentionableUser[] {
  return mentionableUserRowsSchema.parse(
    db.prepare(`SELECT id, email, name FROM users WHERE disabled = 0`).all(),
  );
}

/** `project_members.user_id` is TEXT NOT NULL (0001_baseline). */
const memberIdRowsSchema = z.array(z.object({ user_id: z.string() }));
/** `projects.slug` is the TEXT primary key. */
const projectSlugRowSchema = z.object({ slug: z.string() }).nullable();

/**
 * The project's member ids — the boundary a mention may not cross (F33-9) — or
 * `null` when this store cannot answer the question.
 *
 * Read from the `project_members` projection rather than project.md because the
 * fan-out's contract is `(db, input)`: it has no data root to resolve the file
 * with, and defaulting one would read `VIBERR_DATA_ROOT`, i.e. a DIFFERENT store
 * from the one its caller is writing. The projection is rewritten from
 * project.md by `rebuildProjectFile` on every project write, and it is the same
 * source the board and review-queue reads already trust for membership.
 *
 * "Cannot answer" is a distinct answer from "has no members", and the `projects`
 * row is what separates them: a real project always has at least the admin who
 * created it, so an EMPTY member list on a projected project means every mention
 * is a non-delivery, while a MISSING project row means nothing here has ever
 * been projected (a file-store-only unit fixture, or a store read before the
 * boot rebuild). Scoping to an empty set in that second case would silently stop
 * every mention in the app; leaving the scope off keeps the pre-F33-9 app-wide
 * behaviour for a store that has no membership to enforce with. Every running
 * instance rebuilds at boot and reprojects on every project write, so the live
 * fan-out is always in the first case.
 */
function projectMemberIds(
  db: DatabaseSync,
  projectSlug: string,
): ReadonlySet<string> | null {
  const projected = projectSlugRowSchema.parse(
    db.prepare(`SELECT slug FROM projects WHERE slug = ?`).get(projectSlug) ??
      null,
  );
  if (!projected) return null;
  const rows = memberIdRowsSchema.parse(
    db
      .prepare(`SELECT user_id FROM project_members WHERE project_slug = ?`)
      .all(projectSlug),
  );
  return new Set(rows.map((r) => r.user_id));
}

/**
 * One resolution seam for every db-backed reader below. With a `projectSlug` the
 * ladder is scoped to that project's members (F33-9); without one it resolves
 * app-wide, which is what a caller with no project in hand gets.
 */
function resolveIn(
  db: DatabaseSync,
  text: string,
  projectSlug: string | undefined,
): MentionResolution {
  const users = enabledUsers(db);
  if (projectSlug === undefined) return resolveMentionTargets(users, text);
  const members = projectMemberIds(db, projectSlug);
  if (members === null) return resolveMentionTargets(users, text);
  return resolveMentionTargets(users, text, members);
}

/**
 * The @handles in `text` that route to nobody, resolved against the same user
 * set the fan-out uses. Callers that must disclose the non-delivery need the
 * handles BEFORE anything is written, so the disclosure and the comment land in
 * one write.
 *
 * `projectSlug` is optional only because the call sites predate F33-9; pass it
 * whenever the comment belongs to a project, or a non-member tag is dropped
 * without the author being told (see {@link mentionNonDeliveryNote}).
 */
export function ambiguousMentionHandles(
  db: DatabaseSync,
  text: string,
  projectSlug?: string,
): string[] {
  return resolveIn(db, text, projectSlug).ambiguous;
}

/**
 * The whole non-delivery report for one comment, already rendered — "" when
 * every handle routed. The human comment path writes this as its policy note,
 * so ONE call covers both reasons a tag reaches nobody (ambiguous, F33-9
 * non-member) and a third reason added later lands here rather than at each
 * caller.
 */
export function mentionNonDeliveryNote(
  db: DatabaseSync,
  text: string,
  projectSlug: string,
): string {
  const { ambiguous, nonMembers } = resolveIn(db, text, projectSlug);
  return [ambiguousMentionNote(ambiguous), nonMemberMentionNote(nonMembers)]
    .filter((note) => note.length > 0)
    .join("\n\n");
}

/**
 * Would `text`'s @handles actually notify `userId`? The dispatch-completion
 * contract's cc-append asks this with the SAME ladder the fan-out uses (hunt
 * 2026-08-29): its old raw first-name substring check was satisfied by a tag
 * of a DIFFERENT person sharing the dispatcher's first name — a handle this
 * ladder rules ambiguous and delivers to nobody — so the one notification the
 * contract guarantees was silently lost. One resolver, one answer.
 */
export function mentionNotifiesUser(
  db: DatabaseSync,
  text: string,
  userId: string,
  projectSlug?: string,
): boolean {
  return resolveIn(db, text, projectSlug).userIds.includes(userId);
}

/**
 * `text` with the non-delivery disclosure appended when one of its @handles
 * reached nobody — ambiguous, or (with a `projectSlug`) a non-member (F33-9).
 * The form MACHINE authors (agents, the operator) use.
 *
 * B-FD2 dropped the ambiguous handle for every caller, but only a human comment
 * was ever going to carry a note about it: an agent or operator tag that matched
 * two people notified nobody and left no trace anywhere, which is a quieter
 * version of the NEW-4 gap the fan-out exists to close. A machine author cannot
 * retag itself and its comment is the only surface a human reads, so the
 * disclosure rides the comment. Idempotent: the appended line's own `@handle` is
 * the ambiguous one, which still routes to nobody.
 */
export function withAmbiguityDisclosure(
  db: DatabaseSync,
  text: string,
  projectSlug?: string,
  /**
   * Ruling 232 amendment: a comment whose declared audience is the agent
   * notifies nobody, so BOTH disclosures below become misleading on it. Each
   * one names a remedy — "mention the full name", "add them to the project
   * first" — that assumes a correctly-spelled tag would have notified. On a
   * directive it would not, however it is spelled and whoever is a member, so
   * the note would send a reader to fix something that is not the reason.
   * Found by reviewing ruling 232 against the disclosure it did not touch.
   */
  audience?: "agent" | "open",
): string {
  if (audience === "agent") return text;
  const { ambiguous, nonMembers } = resolveIn(db, text, projectSlug);
  const note = [ambiguousMentionNote(ambiguous), nonMemberMentionNote(nonMembers)]
    .filter((line) => line.length > 0)
    .join("\n\n");
  if (note.length === 0) return text;
  // Balance an unclosed ``` fence before appending, or the note renders as
  // code (and the reader never sees the disclosure as prose). This was done by
  // the operator-brevity truncation until ruling 104 removed it; the append
  // site is the one place a tail is added to author text, so it owns the check.
  const fenceCount = (text.match(/^```/gm) ?? []).length;
  const closed = fenceCount % 2 === 1 ? `${text}\n\`\`\`` : text;
  return `${closed}\n\n${note}`;
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
  /** Users a PRIOR comment already notified for the same content — skipped so a
   *  reply whose body duplicates an earlier comment but adds new @tags (the
   *  dispatch-completion cc line, ruling 98) pings only the added handles,
   *  never re-notifying anyone the earlier comment already reached. */
  skipUserIds?: ReadonlySet<string>;
  /**
   * Ruling 232 (owner, 2026-09-14) — the comment's DECLARED audience.
   *
   * `"agent"` is a machine-authored directive handed to a specialist: its
   * handles address that agent, and a person named inside it is being described
   * TO the agent, not addressed. Such a comment notifies no person. Default
   * `"open"` keeps every other writer exactly as it was.
   *
   * Declared, not inferred: `appendComment` DERIVES its `toAgent` from the
   * presence of an agent handle, so a human writing "@dev do X, @Bora look at
   * the schema first" would lose Bora's ping under a blanket rule — and a human
   * has one comment box, not a second human-directed channel to fall back on.
   * The gate is therefore for writers that set the audience themselves.
   */
  audience?: "agent" | "open";
}

export interface MentionFanout {
  /** Users actually notified (users-table order). */
  mentioned: string[];
  /** Handles that matched several people and therefore notified nobody. */
  ambiguous: string[];
  /** Handles that named one real person who is not a member of this project,
   *  and therefore notified nobody (F33-9). */
  nonMembers: string[];
}

/**
 * Notify every MEMBER of `input.projectSlug` the text unambiguously @mentions,
 * and report the handles that reached nobody. Routing prefs are respected via
 * `createNotification` (a user who silenced the `mention` category is skipped
 * there).
 *
 * Ambiguity is judged over ALL enabled users, before the author exclusion: a
 * comment by one Arda tagging "@arda" on a team of two is still ambiguous —
 * dropping the author would silently redirect it to the other one. Membership is
 * applied to the WINNER of that ladder (F33-9): a resolved non-member is not a
 * notification, it is a `nonMembers` handle the author is shown.
 */
export function fanOutMentions(
  db: DatabaseSync,
  input: NotifyMentionsInput,
): MentionFanout {
  const { userIds, matchedBy, ambiguous, nonMembers } = resolveIn(
    db,
    input.text,
    input.projectSlug,
  );
  // Ruling 232: a directive addressed to an agent notifies no person. The
  // handles that reached nobody are still reported, because they are facts
  // about the text and the author's disclosure is written from them.
  if (input.audience === "agent") return { mentioned: [], ambiguous, nonMembers };
  const knownNames = enabledUsers(db).map((u) => u.name);
  const mentioned: string[] = [];
  for (const userId of userIds) {
    if (input.excludeUserId && userId === input.excludeUserId) continue;
    if (input.skipUserIds?.has(userId)) continue;
    mentioned.push(userId);
    const notification: CreateNotificationInput = {
      userId,
      kind: "mention",
      text: `mentioned you — “${quoteForUser(input.text, userId, matchedBy, knownNames)}”`,
      from: input.from,
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
    };
    // No caller timestamp ⇒ leave the key off and let the writer stamp `now`.
    if (input.occurredAt) notification.occurredAt = input.occurredAt;
    createNotification(db, notification);
  }
  return { mentioned, ambiguous, nonMembers };
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

/** The enabled users a text unambiguously @mentions — for diffing a reply's
 *  mentions against the comment it duplicates (see `skipUserIds`). Pass the
 *  `projectSlug` to match the fan-out's members-only scope (F33-9); without it
 *  the set can only be too WIDE, which costs a skip, never a stray notification. */
export function mentionedUserIdsOf(
  db: DatabaseSync,
  text: string,
  projectSlug?: string,
): Set<string> {
  return new Set(resolveIn(db, text, projectSlug).userIds);
}
