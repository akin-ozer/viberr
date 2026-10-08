import { afterEach, describe, it } from "vitest";
import type { TaskFileEvent } from "~/schemas/task-file.schema";
import { projectFilePath, taskFilePath } from "~/server/files/file-store-root.server";
import { allocateTaskKey } from "~/server/files/project-writer.server";
import { updateTaskFile } from "~/server/files/task-writer.server";
import { countSql } from "../../../test-support/perf-counters";
import { expectWithinBudget } from "../../../test-support/perf-ratchet";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import { rebuildAll, rebuildPath, rebuildTaskFile } from "./rebuilder.server";

/**
 * Ruling 457: the write path's projection cost, counted in SQL statements
 * and WAL commits (findings SRV-3, SRV-4, CS-6).
 */

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

/** `count` timeline events, newest first, alternating a human comment and a
 *  system note, one minute apart. */
function timeline(store: TestStore, count: number): TaskFileEvent[] {
  const events: TaskFileEvent[] = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const at = new Date(Date.UTC(2026, 6, 1, 9, 0) + i * 60_000).toISOString();
    events.push(
      i % 2 === 0
        ? {
            occurredAt: at,
            type: "comment",
            actor: { kind: "human", userId: store.users.arda.id, nameHint: null },
            title: null,
            text: `Comment ${i}`,
            toAgent: false,
            evidence: null,
          }
        : {
            occurredAt: at,
            type: "note",
            actor: { kind: "system", systemId: "policy-engine" },
            title: null,
            text: `Note ${i}`,
            toAgent: false,
            evidence: null,
          },
    );
  }
  return events;
}


describe("projection write cost (ruling 457)", () => {
  it("SRV-3: the project.md rebuild after a task-key allocation", async () => {
    const store = setupTestStore(ctx);
    for (let n = 1; n <= 30; n += 1) {
      writeTask(store.dataRoot, store.slug, {
        frontmatter: baseTaskFrontmatter(`VIB-${n}`),
        timeline: timeline(store, 4),
      });
    }
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    await allocateTaskKey({ projectSlug: store.slug, dataRoot: store.dataRoot });
    const probe = countSql(store.db);
    rebuildPath(store.db, projectFilePath(store.slug, store.dataRoot), {
      dataRoot: store.dataRoot,
    });
    const sql = probe.stop();

    expectWithinBudget("writes:task-create.sql", sql.statements);
    expectWithinBudget("writes:task-create.commits", sql.commits);
  });

  it("SRV-4: re-projecting a 300-event task is one commit", () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1"),
      timeline: timeline(store, 300),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    const probe = countSql(store.db);
    rebuildTaskFile(store.db, store.slug, "VIB-1", {
      dataRoot: store.dataRoot,
      force: true,
    });
    expectWithinBudget("writes:reproject-300.commits", probe.stop().commits);
  });

  it("CS-6: appending one comment to a 100-event task shifts and inserts", async () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1"),
      timeline: timeline(store, 100),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    await updateTaskFile(
      { projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot },
      (parsed) => {
        parsed.timeline.unshift({
          occurredAt: "2026-07-02T09:00:00.000Z",
          type: "comment",
          actor: { kind: "human", userId: store.users.murat.id, nameHint: null },
          title: null,
          text: "One more comment.",
          toAgent: false,
          evidence: null,
        });
      },
    );
    const probe = countSql(store.db);
    rebuildPath(store.db, taskFilePath(store.slug, "VIB-1", store.dataRoot), {
      dataRoot: store.dataRoot,
    });
    const sql = probe.stop();

    expectWithinBudget(
      "writes:comment-append.task-event-writes",
      sql.sql.filter((s) => /^\s*(insert into|update|delete from) task_events\b/i.test(s))
        .length,
    );
  });
});
