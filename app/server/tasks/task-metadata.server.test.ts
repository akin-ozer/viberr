import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  actorOf,
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import { getTaskDetail } from "~/server/projections/task-query.server";
import { listAuditEvents } from "../../../test-support/audit-log";
import { createTask, setTaskMetadata } from "./task-actions.server";
import type { TaskFrontmatter } from "~/schemas/task-file.schema";

/**
 * The lightweight-metadata feature (pass 25): priority / labels / due date.
 * Covers the server action's validation, normalization, the derived `urgent`
 * mirror, the no-op short-circuit, the audit + timeline trail, and the
 * projection surfacing so the board/hero read what the action wrote.
 */

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

function prepared(): TestStore {
  const store = setupTestStore(ctx);
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-1"),
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot });
  return store;
}

function readFm(store: TestStore, key = "VIB-1"): TaskFrontmatter {
  return readTaskFile({
    projectSlug: store.slug,
    taskKey: key,
    dataRoot: store.dataRoot,
  })!.parsed.frontmatter;
}

describe("setTaskMetadata", () => {
  it("sets priority and mirrors the derived `urgent` rung", async () => {
    const store = prepared();
    await setTaskMetadata(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", priority: "high" },
      actorOf(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    let fm = readFm(store);
    expect(fm.priority).toBe("high");
    // `high` is NOT the urgent rung — the board highlight stays off.
    expect(fm.urgent).toBe(false);

    await setTaskMetadata(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", priority: "urgent" },
      actorOf(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    fm = readFm(store);
    expect(fm.priority).toBe("urgent");
    // urgent priority lights the board highlight the `.urgent` card class reads.
    expect(fm.urgent).toBe(true);

    // Dropping back off urgent clears the mirror.
    await setTaskMetadata(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", priority: "low" },
      actorOf(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(readFm(store).urgent).toBe(false);
  });

  // F26-13: an archived task's planning metadata is frozen (the Details editor is
  // hidden on the client too, but the server is the belt that must fail closed).
  it("refuses to edit an archived task's metadata", async () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        archived: true,
        priority: "high",
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    await expect(
      setTaskMetadata(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", priority: "urgent" },
        actorOf(store.users.arda),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toThrow(/archived/i);
    // Nothing was written — the frozen value stands.
    expect(readFm(store).priority).toBe("high");
  });

  it("normalizes labels: trims, drops empties, dedupes case-insensitively, caps", async () => {
    const store = prepared();
    await setTaskMetadata(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        labels: ["  Runtime ", "runtime", "", "GitHub", "github "],
      },
      actorOf(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    // "Runtime"/"runtime" collapse to one (first-seen casing kept); empties gone.
    expect(readFm(store).labels).toEqual(["Runtime", "GitHub"]);

    // Cap at 12 (MAX_TASK_LABELS): 20 distinct labels → 12 kept.
    await setTaskMetadata(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        labels: Array.from({ length: 20 }, (_, i) => `l${i}`),
      },
      actorOf(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(readFm(store).labels).toHaveLength(12);
  });

  it("accepts a valid due date and rejects a malformed / impossible one", async () => {
    const store = prepared();
    await setTaskMetadata(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", dueDate: "2026-09-01" },
      actorOf(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(readFm(store).dueDate).toBe("2026-09-01");

    for (const bad of ["2026-13-01", "2026-02-31", "not-a-date", "2026/09/01"]) {
      await expect(
        setTaskMetadata(
          store.db,
          { projectSlug: store.slug, taskKey: "VIB-1", dueDate: bad },
          actorOf(store.users.arda),
          { dataRoot: store.dataRoot },
        ),
      ).rejects.toMatchObject({ status: 400 });
    }
    // The bad writes never landed — the good value is still there.
    expect(readFm(store).dueDate).toBe("2026-09-01");

    // An empty string clears it.
    await setTaskMetadata(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", dueDate: "" },
      actorOf(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(readFm(store).dueDate).toBeNull();
  });

  it("rejects an unknown priority before any write", async () => {
    const store = prepared();
    await expect(
      setTaskMetadata(
        store.db,
        // @ts-expect-error — deliberately off-enum, the runtime guard must catch it
        { projectSlug: store.slug, taskKey: "VIB-1", priority: "critical" },
        actorOf(store.users.arda),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(readFm(store).priority).toBe("normal");
  });

  it("is a no-op when nothing changes — no audit row, no timeline note", async () => {
    const store = prepared();
    await setTaskMetadata(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", priority: "high" },
      actorOf(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    const before = listAuditEvents(store.db, {
      action: "task.metadata.updated",
    }).length;
    const timelineBefore = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed.timeline.length;

    // Same value again → short-circuits.
    await setTaskMetadata(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", priority: "high" },
      actorOf(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    const after = listAuditEvents(store.db, {
      action: "task.metadata.updated",
    }).length;
    const timelineAfter = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed.timeline.length;
    expect(after).toBe(before);
    expect(timelineAfter).toBe(timelineBefore);
  });

  it("writes an audit row and a timeline note naming what changed", async () => {
    const store = prepared();
    await setTaskMetadata(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        priority: "urgent",
        labels: ["security"],
        dueDate: "2026-09-05",
      },
      actorOf(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    const audit = listAuditEvents(store.db, {
      action: "task.metadata.updated",
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.taskKey).toBe("VIB-1");

    const note = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed.timeline.find((e) => e.title === "Task metadata updated");
    expect(note).toBeTruthy();
    expect(note?.text).toContain("priority");
  });

  it("surfaces the metadata in the task projection the board/hero read", async () => {
    const store = prepared();
    await setTaskMetadata(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        priority: "high",
        labels: ["runtime"],
        dueDate: "2026-09-10",
      },
      actorOf(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    const detail = getTaskDetail(store.db, store.slug, "VIB-1");
    expect(detail?.priority).toBe("high");
    expect(detail?.labels).toEqual(["runtime"]);
    expect(detail?.dueDate).toBe("2026-09-10");
  });

  it("RBAC: a contributor may edit metadata; a viewer may not", async () => {
    const store = prepared();
    // selin is a project contributor — the grant holds.
    await expect(
      setTaskMetadata(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", priority: "high" },
        actorOf(store.users.selin),
        { dataRoot: store.dataRoot },
      ),
    ).resolves.toBeTruthy();
    // elif is a viewer — denied.
    await expect(
      setTaskMetadata(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", priority: "low" },
        actorOf(store.users.elif),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe("createTask metadata", () => {
  it("derives urgent from an urgent priority at creation", async () => {
    const store = prepared();
    const { key } = await createTask(
      store.db,
      { projectSlug: store.slug, title: "Urgent new task", priority: "urgent" },
      actorOf(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    const fm = readFm(store, key);
    expect(fm.priority).toBe("urgent");
    expect(fm.urgent).toBe(true);
  });

  // F26-16: `urgent` is derived PURELY from priority — there is no separate
  // `urgent` input that could desync from the graded scale.
  it("leaves urgent off for any non-urgent priority", async () => {
    const store = prepared();
    for (const priority of ["low", "normal", "high"] as const) {
      const { key } = await createTask(
        store.db,
        { projectSlug: store.slug, title: `A ${priority} task`, priority },
        actorOf(store.users.arda),
        { dataRoot: store.dataRoot },
      );
      const fm = readFm(store, key);
      expect(fm.priority).toBe(priority);
      expect(fm.urgent).toBe(false);
    }
  });

  it("normalizes create-time labels and validates a create-time due date", async () => {
    const store = prepared();
    const { key } = await createTask(
      store.db,
      {
        projectSlug: store.slug,
        title: "Task with metadata",
        labels: ["  a ", "a", "b"],
        dueDate: "2026-10-01",
      },
      actorOf(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    const fm = readFm(store, key);
    expect(fm.labels).toEqual(["a", "b"]);
    expect(fm.dueDate).toBe("2026-10-01");

    await expect(
      createTask(
        store.db,
        {
          projectSlug: store.slug,
          title: "Bad due date",
          dueDate: "2026-02-31",
        },
        actorOf(store.users.arda),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects an unknown create-time priority", async () => {
    const store = prepared();
    await expect(
      createTask(
        store.db,
        // @ts-expect-error — off-enum priority
        { projectSlug: store.slug, title: "Bad priority", priority: "nope" },
        actorOf(store.users.arda),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
});
