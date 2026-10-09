import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { withTransaction } from "~/server/db/transaction.server";
import { countLabel } from "~/shared/text/plural";

/**
 * Ruling 252: which user message each controller row answers, for the rows
 * written before `reply_to` existed, and which old user messages are earlier
 * history that boot recovery owes nothing.
 *
 * The writers of that era named no message, so a link can only come from the
 * order they wrote in. That order is exact while the walk knows the in-memory
 * queue: turns ran in FIFO order, one at a time, and every refusal was written
 * right after the message it refused. It stops being exact wherever a queued
 * message was lost without a row saying so: a restart while messages waited
 * (the old recovery noted only the dead turn), and a first turn whose start
 * failed while a message queued behind it. A FIFO walk that does not see the
 * loss gives every later reply the message before its own, for good.
 *
 * So the walk links only what the order PROVES, and never guesses past a loss:
 *
 * - a reply that carries a run answers the oldest waiting message, and only
 *   when the walk is in step with the queue and that message was recorded
 *   before the run started;
 * - a run-less refusal (no Claude, a full queue) answers the user message
 *   directly before it, the only one it can be;
 * - the start failures answer the head of the queue (the queued-start one's
 *   count of dropped messages has to match the walk's, or it links nothing),
 *   and each "I dropped this message" row after them the next message behind;
 * - a restart note answers the dead turn's message (its run's), a message the
 *   note already names that was still waiting, or the message directly before
 *   the notes, which nothing had answered; a released project's note answers
 *   nothing.
 *
 * Every event that empties the real queue puts the walk back in step: a start
 * failure (the lease died with it), a group of restart notes, and any boot
 * another conversation's restart note dates (a boot empties every queue, noted
 * or not). What was still waiting then was lost: it is marked
 * `unlinked_history`, earlier history with no linked answer, which boot
 * recovery never notes as unanswered. So is everything waiting while the walk
 * is out of step (a reply it could not place, a note it did not recognise). The
 * messages still waiting at the end, after the last boot any row dates, are
 * the ones THIS boot interrupted, and recovery notes them.
 *
 * The walk recomputes every controller row's link, so on a root an earlier
 * version of this backfill already linked (it replayed FIFO without seeing a
 * loss), it corrects those links too: the healer runs it once, when it adds
 * `unlinked_history`. The only stored links it reads are the targets of
 * restart notes, which recovery wrote knowing the message; one whose message
 * the walk shows answered or lost (a note the earlier backfill caused) is
 * left unlinked, never moved. Running it again gives the same result.
 */

/** Boot recovery's note (`recoverControllerConversations`). */
export const RESTART_NOTE =
  "This turn was interrupted by a server restart before I could answer. Say it again and I will pick it up.";

/** A first turn that could not start (`runControllerTurn`). */
export function startFailedNote(reason: string): string {
  return `${START_FAILED}${reason}`;
}

/** A queued turn that could not start (`settleTurn`), with how many messages
 *  behind it died with the lease. */
export function queuedStartFailedNote(dropped: number): string {
  return dropped === 0
    ? `${QUEUED_START_FAILED}. Say it again to retry.`
    : `${QUEUED_START_FAILED}, and I dropped the ${countLabel(dropped, "message")} you sent after it. Say them again to retry.`;
}

/** The note under each message a failed start dropped. */
export const DROPPED_AFTER_QUEUED_START =
  "I dropped this message: the queued turn before it could not start. Say it again to retry.";
export const DROPPED_AFTER_START =
  "I dropped this message: the turn before it could not start. Say it again to retry.";

const START_FAILED = "I could not start this turn: ";
const QUEUED_START_FAILED = "I could not start the queued turn";
const DROPPED = "I dropped this message";
const DROPPED_COUNT = /^I could not start the queued turn, and I dropped the (\d+) messages? you sent after it\./;
const RELEASED_NOTE = /^The project ".*" was deleted, so this conversation is no longer bound to it\./s;

/** The columns the walk reads, parsed at the DB boundary. */
const messageRows = z.array(
  z.object({
    id: z.string(),
    conversation_id: z.string(),
    author: z.string(),
    run_id: z.string().nullable(),
    text: z.string(),
    reply_to: z.string().nullable(),
    created_at: z.string(),
  }),
);
type Row = z.infer<typeof messageRows>[number];

const runRows = z.array(z.object({ id: z.string(), created_at: z.string() }));

/** A user message the walk holds as waiting, with when it was recorded. */
interface Waiting {
  id: string;
  at: number | null;
}

interface WalkFacts {
  /** When each controller run started, by id. */
  runStarts: Map<string, number>;
  /** When each boot the data can date happened (a restart note's time). */
  boots: number[];
}

interface WalkResult {
  links: Map<string, string | null>;
  history: Set<string>;
}

function timeOf(value: string): number | null {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function isRestartNote(row: Row): boolean {
  return row.author !== "user" && row.text === RESTART_NOTE;
}

function isFailureNote(row: Row): boolean {
  return (
    row.author !== "user" &&
    row.run_id === null &&
    (row.text.startsWith(START_FAILED) || row.text.startsWith(QUEUED_START_FAILED))
  );
}

function isDroppedNote(row: Row | undefined): row is Row {
  return row !== undefined && row.author !== "user" && row.run_id === null && row.text.startsWith(DROPPED);
}

/** How many messages a queued-start failure note says it dropped, or null
 *  when its text does not say (the first-turn note, and the earliest queued
 *  one, which dropped the rest without counting them). */
function droppedCount(text: string): number | null {
  const match = DROPPED_COUNT.exec(text);
  return match ? Number(match[1]) : null;
}

/** Whether a boot happened after `from` and no later than `to`. */
function bootBetween(boots: number[], from: number | null, to: number | null): boolean {
  if (from === null || to === null) return false;
  return boots.some((boot) => boot > from && boot <= to);
}

function controllerRunStarts(db: DatabaseSync): Map<string, number> {
  const starts = new Map<string, number>();
  const rows = runRows.parse(
    db.prepare(`SELECT id, created_at FROM agent_runs WHERE kind = 'controller'`).all(),
  );
  for (const row of rows) {
    const at = timeOf(row.created_at);
    if (at !== null) starts.set(row.id, at);
  }
  return starts;
}

/** One conversation, oldest row first. */
function walkConversation(rows: Row[], facts: WalkFacts, out: WalkResult): void {
  let waiting: Waiting[] = [];
  let unsure = false;
  let lastAt: number | null = null;
  const runAnswers = new Map<string, string>();

  const link = (row: Row, target: string | null) => {
    out.links.set(row.id, target);
  };
  const isWaiting = (id: string | null | undefined): id is string =>
    id != null && waiting.some((w) => w.id === id);
  const take = (id: string) => {
    waiting = waiting.filter((w) => w.id !== id);
  };
  /** The queue is empty now: whatever the walk still held was lost. */
  const lost = () => {
    for (const w of waiting) out.history.add(w.id);
    waiting = [];
    unsure = false;
  };
  /** A run answers the oldest waiting message, if the walk is in step and
   *  that message was recorded before the run started. */
  const headFor = (runId: string): Waiting | null => {
    const head = waiting[0];
    if (unsure || !head) return null;
    const started = facts.runStarts.get(runId);
    if (started !== undefined && head.at !== null && head.at > started) return null;
    return head;
  };

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]!;
    const at = timeOf(row.created_at);

    if (isRestartNote(row)) {
      let end = i;
      while (end + 1 < rows.length && isRestartNote(rows[end + 1]!)) end += 1;
      const group = rows.slice(i, end + 1);
      const runNotes = group.filter((note) => note.run_id !== null).length;
      const before = rows[i - 1];
      group.forEach((note, k) => {
        if (note.run_id !== null) {
          // The dead turn's message was the head of the queue, provable only
          // for the one turn a conversation can have running.
          const head = runNotes === 1 && k === 0 ? headFor(note.run_id) : null;
          if (head) {
            link(note, head.id);
            take(head.id);
          } else {
            link(note, null);
          }
          return;
        }
        if (!unsure && isWaiting(note.reply_to)) {
          link(note, note.reply_to);
          take(note.reply_to);
        } else if (k === 0 && before?.author === "user" && isWaiting(before.id)) {
          // The newest row at the restart was this message: nothing had
          // answered it.
          link(note, before.id);
          take(before.id);
        } else {
          link(note, null);
        }
      });
      lost();
      lastAt = timeOf(rows[end]!.created_at) ?? lastAt;
      i = end;
      continue;
    }

    // A boot another conversation dates emptied this queue too.
    if (bootBetween(facts.boots, lastAt, at)) lost();
    if (at !== null) lastAt = at;

    if (row.author === "user") {
      waiting.push({ id: row.id, at });
      continue;
    }
    if (RELEASED_NOTE.test(row.text)) {
      link(row, null);
      continue;
    }

    if (isFailureNote(row)) {
      let end = i;
      while (isDroppedNote(rows[end + 1])) end += 1;
      const drops = rows.slice(i + 1, end + 1);
      const count = droppedCount(row.text);
      const behind = waiting.length - 1;
      const inStep =
        !unsure &&
        waiting.length > 0 &&
        (drops.length > 0
          ? behind === drops.length && (count === null || count === drops.length)
          : count === null || count === behind);
      if (inStep) {
        link(row, waiting.shift()!.id);
        for (const drop of drops) link(drop, waiting.shift()!.id);
      } else {
        link(row, null);
        for (const drop of drops) link(drop, null);
      }
      // The lease died with the failure; what it still held was dropped, and
      // the note said so or said nothing.
      lost();
      const endAt = timeOf(rows[end]!.created_at);
      if (endAt !== null) lastAt = endAt;
      i = end;
      continue;
    }

    if (row.run_id !== null) {
      const answered = runAnswers.get(row.run_id);
      if (answered !== undefined) {
        link(row, answered);
        continue;
      }
      const head = headFor(row.run_id);
      if (!head) {
        link(row, null);
        unsure = true;
        continue;
      }
      link(row, head.id);
      take(head.id);
      runAnswers.set(row.run_id, head.id);
      continue;
    }

    // A run-less refusal was written right after the message it refused.
    const before = rows[i - 1];
    if (before?.author === "user" && isWaiting(before.id)) {
      link(row, before.id);
      take(before.id);
      continue;
    }
    link(row, null);
    unsure = true;
  }

  // Waiting still: interrupted by THIS boot, which recovery notes, unless the
  // walk lost step or a later boot another conversation dates had already
  // emptied the queue.
  if (unsure || bootBetween(facts.boots, lastAt, Number.POSITIVE_INFINITY)) lost();
}

export function backfillControllerReplyLinks(db: DatabaseSync): void {
  const rows = messageRows.parse(
    db
      .prepare(
        `SELECT id, conversation_id, author, run_id, text, reply_to, created_at
           FROM controller_messages ORDER BY conversation_id, seq`,
      )
      .all(),
  );
  const facts: WalkFacts = {
    runStarts: controllerRunStarts(db),
    boots: rows
      .filter(isRestartNote)
      .map((row) => timeOf(row.created_at))
      .filter((at): at is number => at !== null),
  };
  const out: WalkResult = { links: new Map(), history: new Set() };
  let start = 0;
  for (let i = 1; i <= rows.length; i += 1) {
    if (i === rows.length || rows[i]!.conversation_id !== rows[start]!.conversation_id) {
      walkConversation(rows.slice(start, i), facts, out);
      start = i;
    }
  }

  const write = () => {
    const setLink = db.prepare(`UPDATE controller_messages SET reply_to = ? WHERE id = ?`);
    const setHistory = db.prepare(`UPDATE controller_messages SET unlinked_history = ? WHERE id = ?`);
    for (const row of rows) {
      if (row.author === "user") {
        setHistory.run(out.history.has(row.id) ? 1 : 0, row.id);
        continue;
      }
      const target = out.links.get(row.id) ?? null;
      if (target !== row.reply_to) setLink.run(target, row.id);
    }
  };
  if (db.isTransaction) write();
  else withTransaction(db, write);
}
