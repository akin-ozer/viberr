import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { logger } from "~/server/logging/logger.server";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  applyRetention,
  AUDIT_RETENTION_DAYS,
  NOTIFICATION_MAX_PER_USER,
  RUN_LOG_RETENTION_DAYS,
} from "./retention.server";

const ctx = createTestDbContext();

afterEach(() => {
  vi.restoreAllMocks();
  ctx.cleanup();
});

/* `.get()`/`.all()` hand back untyped SQLite cells, so every row below is
 * parsed on read — the SELECT names the column, the schema pins its type. */
const countRowSchema = z.object({ c: z.number() });
const seqRowSchema = z.object({ seq: z.number() });
const idRowsSchema = z.array(z.object({ id: z.string() }));
/* One exported JSONL line. `looseObject` so the assertions below read the
 * columns they care about without the schema claiming the line has no others —
 * the export's whole promise is that it carries every column. */
const exportedRowSchema = z.looseObject({
  id: z.string(),
  occurred_at: z.string(),
  actor_label: z.string(),
  action: z.string(),
  details_json: z.string().nullable(),
});
const tableInfoSchema = z.array(z.object({ name: z.string() }));

function iso(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 86_400_000).toISOString();
}

/**
 * The export path as the module DOCUMENTS it, rebuilt independently here: a test
 * that imported the path helper would agree with a wrong helper.
 */
function exportFile(root: string, now: Date): string {
  return path.join(
    root,
    "audit-exports",
    `audit-events-${now.toISOString().slice(0, 10)}.jsonl`,
  );
}

function readExported(root: string, now: Date) {
  return readFileSync(exportFile(root, now), "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => exportedRowSchema.parse(JSON.parse(line)));
}

function insertAudit(
  db: DatabaseSync,
  input: { id: string; at: string; action?: string; details?: string },
): void {
  db.prepare(
    `INSERT INTO audit_events (id, occurred_at, actor_user_id, actor_label,
       action, subject_kind, subject_id, project_slug, task_key, details_json)
     VALUES (?, ?, null, 'system', ?, 'task', 'VIB-1', 'p', 'VIB-1', ?)`,
  ).run(input.id, input.at, input.action ?? "a", input.details ?? "{}");
}

function auditIds(db: DatabaseSync): string[] {
  return idRowsSchema
    .parse(db.prepare(`SELECT id FROM audit_events ORDER BY id`).all())
    .map((r) => r.id);
}

describe("applyRetention (F10-29)", () => {
  it("prunes old run logs + audit events past their windows, keeps recent", () => {
    const db = ctx.makeDb();
    const root = ctx.makeTempDir();
    // A run row (run_log_lines FK references it).
    db.prepare(
      `INSERT INTO agent_runs (id, task_key, project_slug, thread_id, role, kind,
         backend, model, sdk, state, turns, input_tokens,
         cached_input_tokens, output_tokens, created_at, updated_at, agent_profile_id)
       VALUES ('run_1','VIB-1','p','t','r','primary','claude','m','s','finished',
         0,0,0,0,?,?,'developer')`,
    ).run(iso(400), iso(400));

    const line = (seq: number, at: string) =>
      db
        .prepare(
          `INSERT INTO run_log_lines (run_id, seq, occurred_at, raw_json, display_json, created_at)
           VALUES ('run_1', ?, ?, '{}', '{}', ?)`,
        )
        .run(seq, at, at);
    line(1, iso(RUN_LOG_RETENTION_DAYS + 5)); // old → pruned
    line(2, iso(1)); // recent → kept

    insertAudit(db, { id: "aud_old", at: iso(AUDIT_RETENTION_DAYS + 5) }); // pruned
    insertAudit(db, { id: "aud_new", at: iso(5) }); // kept

    const res = applyRetention(db, new Date(), { dataRoot: root });
    expect(res.runLogLines).toBe(1);
    expect(res.auditEvents).toBe(1);

    expect(
      countRowSchema.parse(
        db.prepare(`SELECT COUNT(*) c FROM run_log_lines`).get(),
      ),
    ).toEqual({ c: 1 });
    expect(
      seqRowSchema.parse(db.prepare(`SELECT seq FROM run_log_lines`).get()).seq,
    ).toBe(2);
    expect(
      countRowSchema.parse(
        db.prepare(`SELECT COUNT(*) c FROM audit_events`).get(),
      ),
    ).toEqual({ c: 1 });
  });

  it("keeps only the newest N notifications per user", () => {
    const db = ctx.makeDb();
    const total = NOTIFICATION_MAX_PER_USER + 20;
    const insert = db.prepare(
      `INSERT INTO notifications (id, user_id, kind, title, text, project_slug,
         task_key, occurred_at, read_at, created_at)
       VALUES (?, 'u1', 'mention', 't', 'b', 'p', 'VIB-1', ?, null, ?)`,
    );
    for (let i = 0; i < total; i++) {
      const at = iso(total - i); // newest = highest i
      insert.run(`n_${String(i).padStart(4, "0")}`, at, at);
    }
    // A second user is unaffected.
    db.prepare(
      `INSERT INTO notifications (id, user_id, kind, title, text, project_slug,
         task_key, occurred_at, read_at, created_at)
       VALUES ('n_other', 'u2', 'mention', 't', 'b', 'p', 'VIB-1', ?, null, ?)`,
    ).run(iso(1), iso(1));

    const res = applyRetention(db, new Date(), { dataRoot: ctx.makeTempDir() });
    expect(res.notifications).toBe(20);
    expect(
      countRowSchema.parse(
        db.prepare(`SELECT COUNT(*) c FROM notifications WHERE user_id='u1'`).get(),
      ).c,
    ).toBe(NOTIFICATION_MAX_PER_USER);
    expect(
      countRowSchema.parse(
        db.prepare(`SELECT COUNT(*) c FROM notifications WHERE user_id!='u1'`).get(),
      ).c,
    ).toBe(1);
  });

  it("a same-instant tie keeps the notification written LAST, not the one with the luckier id", () => {
    // Notification ids are 72 random bits (`newId("ntf")`), so the old
    // `ORDER BY occurred_at DESC, id DESC` tie-break decided by coin flip WHICH
    // row retention deleted — for rows stamped in the same millisecond, the
    // newer one could be the one that went. Insertion order (`rowid`) is the
    // only thing that knows. Canary: put `id DESC` back and the surviving id
    // flips to the `zzz` one every time (these ids sort against their
    // insertion order on purpose).
    const db = ctx.makeDb();
    const at = iso(9);
    const insert = db.prepare(
      `INSERT INTO notifications (id, user_id, kind, title, text, project_slug,
         task_key, occurred_at, read_at, created_at)
       VALUES (?, 'u3', 'mention', 't', 'b', 'p', 'VIB-1', ?, null, ?)`,
    );
    // The tied pair has to STRADDLE the cap: fill it with NEWER rows, then
    // write the two tied (older) ones, so exactly one of them is pruned and
    // the tie-break is what picks it.
    for (let i = 0; i < NOTIFICATION_MAX_PER_USER - 1; i++) {
      const newer = iso(1);
      insert.run(`n_new_${String(i).padStart(4, "0")}`, newer, newer);
    }
    insert.run("ntf_zzzzzzzzzzzz", at, at);
    insert.run("ntf_aaaaaaaaaaaa", at, at);

    applyRetention(db, new Date(), { dataRoot: ctx.makeTempDir() });
    // SAFETY: the SELECT names one column of a table this test just wrote, and
    // `id` is NOT NULL on `notifications` in 0001_baseline.
    const kept = db
      .prepare(
        `SELECT id FROM notifications WHERE user_id='u3' AND occurred_at=? ORDER BY rowid`,
      )
      .all(at) as { id: string }[];
    expect(kept.map((r) => r.id)).toEqual(["ntf_aaaaaaaaaaaa"]);
  });
});

describe("idempotency-keyed audit rows survive retention (B-FD10)", () => {
  it("keeps the recovery marker actions past the window and prunes the rest", () => {
    const db = ctx.makeDb();
    const root = ctx.makeTempDir();
    const now = new Date();
    const ancient = iso(AUDIT_RETENTION_DAYS + 30);
    // Boot recovery asks "does this row exist?" to decide whether the effect
    // already happened — pruning it makes the next boot repost the reply.
    insertAudit(db, { id: "keep_reply", at: ancient, action: "task.agent.replied" });
    insertAudit(db, {
      id: "keep_plan",
      at: ancient,
      action: "runtime.operator.plan_executed",
    });
    // Ordinary history, and a rolling-window counter that is never consulted
    // beyond 30 minutes: both prune normally.
    insertAudit(db, { id: "prune_plain", at: ancient, action: "task.comment" });
    insertAudit(db, {
      id: "prune_counter",
      at: ancient,
      action: "run.recovery.reinvoked",
    });

    expect(applyRetention(db, now, { dataRoot: root }).auditEvents).toBe(2);
    expect(auditIds(db)).toEqual(["keep_plan", "keep_reply"]);
    // The exemption is an exemption from BOTH halves: an exempt row is still in
    // the table, so exporting it would publish a row nobody deleted.
    expect(readExported(root, now).map((r) => r.id).sort()).toEqual([
      "prune_counter",
      "prune_plain",
    ]);
  });
});

/**
 * Owner decision, 2026-08-31: the FR33 purge exports expiring rows before it
 * deletes them, so the 90-day sweep leaves a durable record instead of trusting
 * whatever a backup schedule happened to capture.
 */
describe("audit purge exports expiring rows before deleting them", () => {
  it("writes exactly the deleted rows as JSONL and leaves the table without them", () => {
    const db = ctx.makeDb();
    const root = ctx.makeTempDir();
    const now = new Date();
    const ancient = iso(AUDIT_RETENTION_DAYS + 5);
    insertAudit(db, { id: "aud_a", at: ancient, details: '{"who":"a"}' });
    insertAudit(db, { id: "aud_b", at: ancient, action: "user.disabled" });
    insertAudit(db, { id: "aud_c", at: ancient });
    insertAudit(db, { id: "aud_keep", at: iso(1) });

    expect(applyRetention(db, now, { dataRoot: root }).auditEvents).toBe(3);

    const exported = readExported(root, now);
    expect(exported.map((r) => r.id).sort()).toEqual(["aud_a", "aud_b", "aud_c"]);
    // Verbatim as stored: the raw details string and the action, not a
    // reshaped projection of them.
    expect(exported.find((r) => r.id === "aud_a")?.details_json).toBe('{"who":"a"}');
    expect(exported.find((r) => r.id === "aud_b")?.action).toBe("user.disabled");
    expect(exported.find((r) => r.id === "aud_c")?.occurred_at).toBe(ancient);
    // Only the surviving row is left in the table.
    expect(auditIds(db)).toEqual(["aud_keep"]);
  });

  it("carries every column the table has, so the record can be replayed", () => {
    const db = ctx.makeDb();
    const root = ctx.makeTempDir();
    const now = new Date();
    insertAudit(db, { id: "aud_a", at: iso(AUDIT_RETENTION_DAYS + 5) });

    applyRetention(db, now, { dataRoot: root });

    const columns = tableInfoSchema
      .parse(db.prepare(`PRAGMA table_info(audit_events)`).all())
      .map((c) => c.name)
      .sort();
    // A migration that adds a column and forgets this export fails HERE, rather
    // than silently dropping the column from every purge record.
    expect(Object.keys(readExported(root, now)[0]!).sort()).toEqual(columns);
  });

  it("neither exports nor deletes a row still inside the window", () => {
    const db = ctx.makeDb();
    const root = ctx.makeTempDir();
    const now = new Date();
    insertAudit(db, { id: "aud_fresh", at: iso(1) });
    insertAudit(db, { id: "aud_edge", at: iso(AUDIT_RETENTION_DAYS - 1) });

    expect(applyRetention(db, now, { dataRoot: root }).auditEvents).toBe(0);

    expect(auditIds(db)).toEqual(["aud_edge", "aud_fresh"]);
    // No rows expiring means no file at all: an empty pass leaves no record to
    // read as "three purges happened today and removed nothing".
    expect(existsSync(exportFile(root, now))).toBe(false);
  });

  it("FAILS CLOSED: an unwritable export leaves the rows in the table", () => {
    const db = ctx.makeDb();
    const root = ctx.makeTempDir();
    const now = new Date();
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    // A FILE where the export directory belongs: mkdir cannot create it.
    writeFileSync(path.join(root, "audit-exports"), "not a dir\n");
    insertAudit(db, { id: "aud_a", at: iso(AUDIT_RETENTION_DAYS + 5) });
    insertAudit(db, { id: "aud_b", at: iso(AUDIT_RETENTION_DAYS + 5) });
    // Notifications past the per-user cap, to prove the sibling sweeps still run.
    const insert = db.prepare(
      `INSERT INTO notifications (id, user_id, kind, title, text, project_slug,
         task_key, occurred_at, read_at, created_at)
       VALUES (?, 'u1', 'mention', 't', 'b', 'p', 'VIB-1', ?, null, ?)`,
    );
    for (let i = 0; i < NOTIFICATION_MAX_PER_USER + 3; i++) {
      const at = iso(i + 1);
      insert.run(`n_${String(i).padStart(4, "0")}`, at, at);
    }

    const res = applyRetention(db, now, { dataRoot: root });

    // Losing the purge for a tick is recoverable; losing the rows is not.
    expect(res.auditEvents).toBe(0);
    expect(auditIds(db)).toEqual(["aud_a", "aud_b"]);
    expect(warn.mock.calls.map(([message]) => message)).toContain(
      "audit purge skipped: expiring rows could not be exported",
    );
    // The failure is scoped to the audit half — the other sweeps are untouched.
    expect(res.notifications).toBe(3);
  });

  it("appends: two purges on the same day accumulate in one file", () => {
    const db = ctx.makeDb();
    const root = ctx.makeTempDir();
    const now = new Date();
    insertAudit(db, { id: "aud_first", at: iso(AUDIT_RETENTION_DAYS + 5) });
    expect(applyRetention(db, now, { dataRoot: root }).auditEvents).toBe(1);

    // A later pass the same day (boot, the interval tick, a disk-pressure sweep)
    // finds rows the first one could not have seen.
    insertAudit(db, { id: "aud_second", at: iso(AUDIT_RETENTION_DAYS + 6) });
    expect(applyRetention(db, now, { dataRoot: root }).auditEvents).toBe(1);

    expect(readdirSync(path.join(root, "audit-exports"))).toEqual([
      path.basename(exportFile(root, now)),
    ]);
    expect(readExported(root, now).map((r) => r.id)).toEqual([
      "aud_first",
      "aud_second",
    ]);
  });
});
