import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createTestDbContext } from "../../../test-support/test-db";
import { backfillControllerReplyLinks, RESTART_NOTE } from "./controller-reply-links.server";
import { recoverControllerConversations } from "./controller-run.server";

/**
 * Ruling 252 (dated note 2026-09-25): the backfill gives an old controller
 * row the message it answers only where the writers' order PROVES it, and
 * marks the rest earlier history that boot recovery never notes.
 *
 * Every conversation here is written the way the writers before `reply_to`
 * wrote it (no link on any row), then walked, then handed to boot recovery on
 * the same root, as the first boot after the column arrives does. The first
 * version of the backfill replayed FIFO without seeing a lost message: every
 * later reply landed under the message before its own, and recovery wrote a
 * restart note under a message that had its answer.
 */

const ctx = createTestDbContext();
afterEach(() => ctx.cleanup());

const at = (minute: number, second = 0) =>
  new Date(Date.UTC(2026, 8, 20, 10, minute, second)).toISOString();

interface Row {
  id: string;
  author: "user" | "controller";
  text?: string;
  runId?: string;
  replyTo?: string;
  createdAt: string;
}

function conversation(db: DatabaseSync, id: string, rows: Row[]): void {
  db.prepare(
    `INSERT INTO controller_conversations (id, user_id, user_label, title, created_at, updated_at, last_message_at)
     VALUES (?, 'u1', 'selin@viberr.dev', '', ?, ?, ?)`,
  ).run(id, rows[0]!.createdAt, rows[0]!.createdAt, rows[rows.length - 1]!.createdAt);
  const insert = db.prepare(
    `INSERT INTO controller_messages
       (id, conversation_id, seq, author, user_id, text, run_id, reply_to, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  rows.forEach((row, i) =>
    insert.run(
      row.id,
      id,
      i + 1,
      row.author,
      row.author === "user" ? "u1" : null,
      row.text ?? (row.author === "user" ? `message ${row.id}` : `reply ${row.id}`),
      row.runId ?? null,
      row.replyTo ?? null,
      row.createdAt,
    ),
  );
}

/** A controller turn's run row, started at `createdAt`. */
function run(
  db: DatabaseSync,
  id: string,
  conversationId: string,
  createdAt: string,
  state: "finished" | "error" | "interrupted" = "finished",
): void {
  db.prepare(
    `INSERT INTO agent_runs
       (id, task_key, project_slug, thread_id, role, kind, backend, model, state,
        agent_profile_id, created_at, updated_at)
     VALUES (?, ?, '', ?, 'Controller', 'controller', 'claude', 'claude-sonnet', ?, 'controller', ?, ?)`,
  ).run(id, conversationId, `controller-${id}`, state, createdAt, createdAt);
}

const linkRows = z.array(z.object({ id: z.string(), reply_to: z.string().nullable() }));
const historyRows = z.array(z.object({ id: z.string() }));
const noteRows = z.array(z.object({ reply_to: z.string().nullable(), run_id: z.string().nullable() }));

function links(db: DatabaseSync, conversationId: string): Record<string, string | null> {
  return Object.fromEntries(
    linkRows
      .parse(
        db
          .prepare(
            `SELECT id, reply_to FROM controller_messages
              WHERE conversation_id = ? AND author = 'controller' ORDER BY seq`,
          )
          .all(conversationId),
      )
      .map((r) => [r.id, r.reply_to]),
  );
}

function history(db: DatabaseSync, conversationId: string): string[] {
  return historyRows
    .parse(
      db
        .prepare(
          `SELECT id FROM controller_messages
            WHERE conversation_id = ? AND unlinked_history = 1 ORDER BY seq`,
        )
        .all(conversationId),
    )
    .map((r) => r.id);
}

/** The restart notes recovery wrote into a conversation, oldest first. */
function recoveryNotes(db: DatabaseSync, conversationId: string, after: string) {
  return noteRows.parse(
    db
      .prepare(
        `SELECT reply_to, run_id FROM controller_messages
          WHERE conversation_id = ? AND text = ? AND created_at >= ? ORDER BY seq`,
      )
      .all(conversationId, RESTART_NOTE, after),
  );
}

describe("ruling 252: the reply-link backfill links only what the order proves", () => {
  it("a restart that lost a queued message does not shift every later reply onto the message before it", () => {
    const db = ctx.makeDb();
    // A ran; B waited behind it. The restart noted A's dead turn (the old
    // recovery named only the run) and B was lost without a row.
    run(db, "run_1", "c1", at(0, 1), "interrupted");
    run(db, "run_3", "c1", at(40, 1));
    run(db, "run_4", "c1", at(50, 1));
    conversation(db, "c1", [
      { id: "A", author: "user", createdAt: at(0) },
      { id: "B", author: "user", createdAt: at(1) },
      { id: "n1", author: "controller", text: RESTART_NOTE, runId: "run_1", createdAt: at(30) },
      { id: "C", author: "user", createdAt: at(40) },
      { id: "rC", author: "controller", runId: "run_3", createdAt: at(41) },
      { id: "D", author: "user", createdAt: at(50) },
      { id: "rD", author: "controller", runId: "run_4", createdAt: at(51) },
    ]);

    backfillControllerReplyLinks(db);

    // CANARY: restore the first backfill (no reset at a restart note) and rC
    // lands under B, rD under C, and D reads as unanswered.
    expect(links(db, "c1")).toEqual({ n1: "A", rC: "C", rD: "D" });
    expect(history(db, "c1")).toEqual(["B"]);
    // The same boot's recovery owes this thread nothing: D was answered, and
    // B is history.
    const boot = new Date().toISOString();
    recoverControllerConversations(db);
    expect(recoveryNotes(db, "c1", boot)).toEqual([]);
  });

  it("a first turn whose start failed with a message queued behind it links the failure to the head", () => {
    const db = ctx.makeDb();
    run(db, "run_c", "c1", at(5, 1));
    conversation(db, "c1", [
      { id: "A", author: "user", createdAt: at(0) },
      { id: "B", author: "user", createdAt: at(0, 30) },
      {
        id: "fail",
        author: "controller",
        text: "I could not start this turn: the adapter refused.",
        createdAt: at(0, 40),
      },
      { id: "C", author: "user", createdAt: at(5) },
      { id: "rC", author: "controller", runId: "run_c", createdAt: at(6) },
    ]);

    backfillControllerReplyLinks(db);

    // CANARY: take the NEWEST waiting message for the start-failure note (the
    // first backfill's pop) and it names B while rC names A.
    expect(links(db, "c1")).toEqual({ fail: "A", rC: "C" });
    expect(history(db, "c1")).toEqual(["B"]);
    const boot = new Date().toISOString();
    recoverControllerConversations(db);
    expect(recoveryNotes(db, "c1", boot)).toEqual([]);
  });

  it("the messages an old queued-start failure dropped are history, and recovery writes no restart note under them", () => {
    const db = ctx.makeDb();
    run(db, "run_a", "c1", at(0, 1));
    conversation(db, "c1", [
      { id: "q1", author: "user", createdAt: at(0) },
      { id: "q2", author: "user", createdAt: at(1) },
      { id: "q3", author: "user", createdAt: at(2) },
      { id: "ra", author: "controller", runId: "run_a", createdAt: at(3) },
      {
        id: "fail",
        author: "controller",
        text: "I could not start the queued turn, and I dropped the 1 message you sent after it. Say them again to retry.",
        createdAt: at(3, 1),
      },
    ]);

    backfillControllerReplyLinks(db);

    expect(links(db, "c1")).toEqual({ ra: "q1", fail: "q2" });
    // CANARY: skip marking what a failure dropped and q3 gets a false
    // "interrupted by a server restart" note below.
    expect(history(db, "c1")).toEqual(["q3"]);
    const boot = new Date().toISOString();
    recoverControllerConversations(db);
    expect(recoveryNotes(db, "c1", boot)).toEqual([]);
  });

  it("a boot another conversation dates empties this conversation's queue too", () => {
    const db = ctx.makeDb();
    // c1: B waited behind A while A's reply landed; the restart came while B
    // was starting, so c1 got no note of its own. c2's note dates the boot.
    run(db, "run_a", "c1", at(0, 1));
    run(db, "run_c", "c1", at(40, 1));
    conversation(db, "c1", [
      { id: "A", author: "user", createdAt: at(0) },
      { id: "B", author: "user", createdAt: at(1) },
      { id: "rA", author: "controller", runId: "run_a", createdAt: at(2) },
      { id: "C", author: "user", createdAt: at(40) },
      { id: "rC", author: "controller", runId: "run_c", createdAt: at(41) },
    ]);
    conversation(db, "c2", [
      { id: "M", author: "user", createdAt: at(20) },
      { id: "nM", author: "controller", text: RESTART_NOTE, createdAt: at(30) },
    ]);

    backfillControllerReplyLinks(db);

    // CANARY: drop the cross-conversation boot reset and rC names B.
    expect(links(db, "c1")).toEqual({ rA: "A", rC: "C" });
    expect(history(db, "c1")).toEqual(["B"]);
    expect(links(db, "c2")).toEqual({ nM: "M" });
    expect(history(db, "c2")).toEqual([]);
  });

  it("a reply the walk cannot place stops it linking until the queue is provably empty again", () => {
    const db = ctx.makeDb();
    // rX's run started BEFORE the oldest waiting message was recorded, so the
    // walk has lost step; nothing after it is linked by FIFO until the start
    // failure empties the queue.
    run(db, "run_x", "c1", at(0, 30));
    run(db, "run_y", "c1", at(2, 1));
    run(db, "run_z", "c1", at(10, 1));
    conversation(db, "c1", [
      { id: "A", author: "user", createdAt: at(1) },
      { id: "rX", author: "controller", runId: "run_x", createdAt: at(1, 30) },
      { id: "B", author: "user", createdAt: at(2) },
      { id: "rY", author: "controller", runId: "run_y", createdAt: at(3) },
      { id: "C", author: "user", createdAt: at(4) },
      { id: "fail", author: "controller", text: "I could not start this turn: no.", createdAt: at(4, 1) },
      { id: "Z", author: "user", createdAt: at(10) },
      { id: "rZ", author: "controller", runId: "run_z", createdAt: at(11) },
    ]);

    backfillControllerReplyLinks(db);

    expect(links(db, "c1")).toEqual({ rX: null, rY: null, fail: null, rZ: "Z" });
    expect(history(db, "c1")).toEqual(["A", "B", "C"]);
  });

  it("the messages THIS boot interrupted stay unanswered, and recovery notes them", () => {
    const db = ctx.makeDb();
    run(db, "run_a", "c1", at(0, 1));
    run(db, "run_e", "c1", at(10, 1), "interrupted");
    conversation(db, "c1", [
      { id: "A", author: "user", createdAt: at(0) },
      { id: "rA", author: "controller", runId: "run_a", createdAt: at(1) },
      { id: "E", author: "user", createdAt: at(10) },
      { id: "F", author: "user", createdAt: at(11) },
    ]);

    backfillControllerReplyLinks(db);

    expect(links(db, "c1")).toEqual({ rA: "A" });
    expect(history(db, "c1")).toEqual([]);
    const boot = new Date().toISOString();
    recoverControllerConversations(db);
    // The dead turn's note answers E and settles its run; F gets its own.
    expect(recoveryNotes(db, "c1", boot)).toEqual([
      { reply_to: "E", run_id: "run_e" },
      { reply_to: "F", run_id: null },
    ]);
  });

  it("corrects a root the first backfill already linked, and leaves the notes it caused unlinked", () => {
    const db = ctx.makeDb();
    // The shape of the first test after the first backfill and its boot: rC
    // and rD shifted onto B and C, and recovery wrote a restart note under D,
    // which had its answer. Recovery's own notes name their message.
    run(db, "run_1", "c1", at(0, 1), "interrupted");
    run(db, "run_3", "c1", at(40, 1));
    run(db, "run_4", "c1", at(50, 1));
    conversation(db, "c1", [
      { id: "A", author: "user", createdAt: at(0) },
      { id: "B", author: "user", createdAt: at(1) },
      { id: "n1", author: "controller", text: RESTART_NOTE, runId: "run_1", replyTo: "A", createdAt: at(30) },
      { id: "C", author: "user", createdAt: at(40) },
      { id: "rC", author: "controller", runId: "run_3", replyTo: "B", createdAt: at(41) },
      { id: "D", author: "user", createdAt: at(50) },
      { id: "rD", author: "controller", runId: "run_4", replyTo: "C", createdAt: at(51) },
      { id: "false", author: "controller", text: RESTART_NOTE, replyTo: "D", createdAt: at(59) },
      // Written after that boot by the exact writers.
      { id: "G", author: "user", createdAt: at(59, 30) },
      { id: "rG", author: "controller", runId: "run_g", replyTo: "G", createdAt: at(59, 40) },
    ]);
    run(db, "run_g", "c1", at(59, 31));

    backfillControllerReplyLinks(db);

    // CANARY: trust a restart note's stored link without checking the message
    // was still waiting and `false` stays under D beside rD.
    const corrected = { n1: "A", rC: "C", rD: "D", false: null, rG: "G" };
    expect(links(db, "c1")).toEqual(corrected);
    expect(history(db, "c1")).toEqual(["B"]);
    // Idempotent: a second walk changes nothing.
    backfillControllerReplyLinks(db);
    expect(links(db, "c1")).toEqual(corrected);
    expect(history(db, "c1")).toEqual(["B"]);
  });
});
