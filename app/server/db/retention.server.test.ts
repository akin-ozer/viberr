import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  applyRetention,
  AUDIT_RETENTION_DAYS,
  NOTIFICATION_MAX_PER_USER,
  RUN_LOG_RETENTION_DAYS,
} from "./retention.server";

const ctx = createTestDbContext();

/* `.get()`/`.all()` hand back untyped SQLite cells, so every row below is
 * parsed on read — the SELECT names the column, the schema pins its type. */
const countRowSchema = z.object({ c: z.number() });
const seqRowSchema = z.object({ seq: z.number() });
const idRowsSchema = z.array(z.object({ id: z.string() }));

function iso(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 86_400_000).toISOString();
}

describe("applyRetention (F10-29)", () => {
  it("prunes old run logs + audit events past their windows, keeps recent", () => {
    const db = ctx.makeDb();
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

    const audit = (id: string, at: string) =>
      db
        .prepare(
          `INSERT INTO audit_events (id, occurred_at, actor_user_id, actor_label,
             action, subject_kind, subject_id, project_slug, task_key, details_json)
           VALUES (?, ?, null, 'system', 'a', 'task', 'VIB-1', 'p', 'VIB-1', '{}')`,
        )
        .run(id, at);
    audit("aud_old", iso(AUDIT_RETENTION_DAYS + 5)); // pruned
    audit("aud_new", iso(5)); // kept

    const res = applyRetention(db);
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

    const res = applyRetention(db);
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
});

describe("idempotency-keyed audit rows survive retention (B-FD10)", () => {
  it("keeps the recovery marker actions past the window and prunes the rest", () => {
    const db = ctx.makeDb();
    const audit = (id: string, action: string, at: string) =>
      db
        .prepare(
          `INSERT INTO audit_events (id, occurred_at, actor_user_id, actor_label,
             action, subject_kind, subject_id, project_slug, task_key, details_json)
           VALUES (?, ?, null, 'system', ?, 'task', 'VIB-1', 'p', 'VIB-1', '{}')`,
        )
        .run(id, at, action);
    const ancient = iso(AUDIT_RETENTION_DAYS + 30);
    // Boot recovery asks "does this row exist?" to decide whether the effect
    // already happened — pruning it makes the next boot repost the reply.
    audit("keep_reply", "task.agent.replied", ancient);
    audit("keep_plan", "runtime.operator.plan_executed", ancient);
    // Ordinary history, and a rolling-window counter that is never consulted
    // beyond 30 minutes: both prune normally.
    audit("prune_plain", "task.comment", ancient);
    audit("prune_counter", "run.recovery.reinvoked", ancient);

    expect(applyRetention(db).auditEvents).toBe(2);
    expect(
      idRowsSchema
        .parse(db.prepare(`SELECT id FROM audit_events ORDER BY id`).all())
        .map((r) => r.id),
    ).toEqual(["keep_plan", "keep_reply"]);
  });
});
