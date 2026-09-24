import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

/**
 * Ruling 465: give the controller replies that predate `reply_to` the message
 * each one answers, once, when the column is added to an older data root.
 *
 * Without it every old user message would read as unanswered: the transcript
 * would show replies at their `seq` as before, but boot recovery, which now
 * notes every user message no reply names, would write a restart note under
 * each one. The walk replays the rules the writers followed, per conversation
 * in `seq` order, with the user messages not yet answered in FIFO order:
 *
 * - a reply that carries a `run_id` is a turn's answer (or the restart note a
 *   run settled with), and turns ran in FIFO order, so it answers the OLDEST
 *   waiting message;
 * - a run-less note (a refused start, a full queue, a missing Claude account,
 *   the restart note for a conversation whose newest message was a user's) was
 *   written right after the message it refused, so it answers the NEWEST;
 * - the queued-start failure answered the message it tried to start and
 *   dropped every one behind it, which stay unanswered (it said so);
 * - a released project's note answers nothing.
 *
 * The last two are recognised by their text: these are the only two notes
 * whose meaning differs from their shape, and their wording predates this
 * ruling. Idempotent by construction: it only fills a NULL, and the healer
 * runs it once, right after adding the column.
 */
const RELEASED_NOTE = /^The project ".*" was deleted, so this conversation is no longer bound to it\./s;
const QUEUED_START_FAILED = "I could not start the queued turn";

/** The five columns the walk reads, parsed at the DB boundary. */
const messageRows = z.array(
  z.object({
    id: z.string(),
    conversation_id: z.string(),
    author: z.string(),
    run_id: z.string().nullable(),
    text: z.string(),
  }),
);

export function backfillControllerReplyLinks(db: DatabaseSync): number {
  const rows = messageRows.parse(
    db
      .prepare(
        `SELECT id, conversation_id, author, run_id, text FROM controller_messages
          WHERE author = 'user' OR reply_to IS NULL
          ORDER BY conversation_id, seq`,
      )
      .all(),
  );
  const link = db.prepare(`UPDATE controller_messages SET reply_to = ? WHERE id = ?`);
  let conversation: string | null = null;
  let waiting: string[] = [];
  let linked = 0;
  for (const row of rows) {
    if (row.conversation_id !== conversation) {
      conversation = row.conversation_id;
      waiting = [];
    }
    if (row.author === "user") {
      waiting.push(row.id);
      continue;
    }
    if (RELEASED_NOTE.test(row.text)) continue;
    let answered: string | undefined;
    if (row.run_id) {
      answered = waiting.shift();
    } else if (row.text.startsWith(QUEUED_START_FAILED)) {
      answered = waiting.shift();
      waiting = [];
    } else {
      answered = waiting.pop();
    }
    if (answered) {
      link.run(answered, row.id);
      linked += 1;
    }
  }
  return linked;
}
