import { describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  applyRetention,
  AUDIT_RETENTION_DAYS,
  NOTIFICATION_MAX_PER_USER,
  RUN_LOG_RETENTION_DAYS,
} from "./retention.server";

const ctx = createTestDbContext();

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
      db.prepare(`SELECT COUNT(*) c FROM run_log_lines`).get() as { c: number },
    ).toEqual({ c: 1 });
    expect(
      (db.prepare(`SELECT seq FROM run_log_lines`).get() as { seq: number }).seq,
    ).toBe(2);
    expect(
      db.prepare(`SELECT COUNT(*) c FROM audit_events`).get() as { c: number },
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
      (db.prepare(`SELECT COUNT(*) c FROM notifications WHERE user_id='u1'`).get() as {
        c: number;
      }).c,
    ).toBe(NOTIFICATION_MAX_PER_USER);
    expect(
      (db.prepare(`SELECT COUNT(*) c FROM notifications WHERE user_id!='u1'`).get() as {
        c: number;
      }).c,
    ).toBe(1);
  });
});
