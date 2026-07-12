import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import {
  checkDatabaseIntegrity,
  ProjectionIntegrityError,
} from "./database-integrity.server";
import {
  createTestDbContext,
  type TestDbContext,
} from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { insertRunLine, upsertRun } from "~/server/runtimes/run-store.server";

describe("projection database integrity", () => {
  let ctx: TestDbContext;
  let store: TestStore;

  beforeEach(() => {
    ctx = createTestDbContext();
    store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1"),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
  });

  afterEach(() => ctx.cleanup());

  it("reports structural faults instead of treating a readable handle as healthy", () => {
    const fake = {
      pragma() {
        return [{ quick_check: "*** in database main ***\nPage 4: btree mismatch" }];
      },
    } as unknown as Database.Database;
    const report = checkDatabaseIntegrity(fake);
    expect(report.ok).toBe(false);
    expect(report.messages[0]).toContain("btree mismatch");
    expect(new ProjectionIntegrityError(report).message).toContain(
      "preserve state/projection.sqlite",
    );
  });

  it("stays clean under a single-process high-rate run-log transaction", () => {
    const runId = "run_integrity_stress";
    upsertRun(store.db, {
      id: runId,
      projectSlug: store.slug,
      taskKey: "VIB-1",
      threadId: "stress",
      role: "Test Engineer",
      kind: "primary",
      backend: "codex",
      simulated: false,
      model: "stress",
      sdk: "test",
      state: "running",
    });
    const writeBurst = store.db.transaction(() => {
      for (let seq = 0; seq < 5_000; seq += 1) {
        insertRunLine(store.db, {
          runId,
          seq,
          occurredAt: "2026-07-13T00:00:00.000Z",
          raw: JSON.stringify({ seq }),
          display: {
            t: "00:00:00",
            ev: "text",
            tag: "stress",
            text: `line ${seq}`,
          },
        });
      }
    });
    writeBurst();

    expect(checkDatabaseIntegrity(store.db)).toEqual({
      ok: true,
      messages: ["ok"],
    });
    expect(
      (
        store.db
          .prepare(`SELECT count(*) AS n FROM run_log_lines WHERE run_id = ?`)
          .get(runId) as { n: number }
      ).n,
    ).toBe(5_000);
  });
});
