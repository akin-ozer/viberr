import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
} from "../../../test-support/test-store";
import { taskFilePath } from "~/server/files/file-store-root.server";
import { onProjectionEvent } from "~/server/events/projection-events.server";
import { rebuildAll, rebuildPath } from "./rebuilder.server";
import { getBoard, listProjectTasks } from "./board-query.server";
import { getTaskDetail } from "./task-query.server";

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

describe("rebuilder", () => {
  it("full rescan projects projects, members and tasks", () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", { stage: "ready" }),
    });
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-2"),
    });

    const summary = rebuildAll(store.db, { dataRoot: store.dataRoot });
    expect(summary.projects).toBe(1);
    expect(summary.tasks).toBe(2);
    expect(summary.changed).toBe(3);
    expect(summary.errors).toBe(0);

    const board = getBoard(store.db, store.slug);
    expect(board?.project.name).toBe("Viberr Core");
    expect(board?.members).toHaveLength(4);
    expect(board?.columns.map((c) => c.tasks.length)).toEqual([1, 1, 0, 0, 0]);
    // Store-relative display path (ruling 3).
    const task = board?.columns[1]?.tasks[0];
    expect(task?.filePath).toBe("projects/viberr-core/tasks/VIB-1/task.md");
  });

  it("content-hash short-circuit: unchanged files are not re-projected", () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1"),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const provenanceBefore = store.db
      .prepare(`SELECT count(*) AS c FROM provenance`)
      .get() as { c: number };

    const second = rebuildAll(store.db, { dataRoot: store.dataRoot });
    expect(second.changed).toBe(0);
    expect(second.unchanged).toBe(2); // project + task

    // Unchanged files record no per-file provenance; only the rescan summary row.
    const provenanceAfter = store.db
      .prepare(`SELECT count(*) AS c FROM provenance`)
      .get() as { c: number };
    expect(provenanceAfter.c).toBe(provenanceBefore.c + 1);
  });

  it("single-file incremental rebuild picks up an external edit", () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1"),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    const events: string[] = [];
    const off = onProjectionEvent((e) => events.push(e.type));

    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        title: "Edited directly on disk",
        stage: "impl",
      }),
    });
    const absPath = taskFilePath(store.slug, "VIB-1", store.dataRoot);
    const result = rebuildPath(store.db, absPath, { dataRoot: store.dataRoot });
    off();

    expect(result.action).toBe("projected");
    const detail = getTaskDetail(store.db, store.slug, "VIB-1");
    expect(detail?.title).toBe("Edited directly on disk");
    expect(detail?.stage).toBe("impl");
    expect(events).toContain("task.updated");
  });

  it("deleting a task file removes its projection rows + records provenance", () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1"),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    const absPath = taskFilePath(store.slug, "VIB-1", store.dataRoot);
    rmSync(absPath);
    const result = rebuildPath(store.db, absPath, { dataRoot: store.dataRoot });
    expect(result.action).toBe("removed");
    expect(listProjectTasks(store.db, store.slug)).toEqual([]);
    const removedRow = store.db
      .prepare(`SELECT action FROM provenance ORDER BY id DESC LIMIT 1`)
      .get() as { action: string };
    expect(removedRow.action).toBe("removed");
  });

  it("malformed file → diagnostics + readiness downgrade, task never dropped", () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "no-such-stage",
        readiness: "ready",
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    const detail = getTaskDetail(store.db, store.slug, "VIB-1");
    expect(detail).not.toBeNull();
    // unknown stage reference → warning → floors input_required
    expect(detail?.readiness).toBe("input_required");
    expect(
      detail?.diagnostics.some((d) => d.code === "reference.unknown_stage"),
    ).toBe(true);
    // ends up in the orphan bucket, not silently dropped
    const board = getBoard(store.db, store.slug);
    expect(board?.orphanTasks.map((t) => t.key)).toEqual(["VIB-1"]);
  });

  it("resolves human actors and flags non-member commenters as guests", () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1"),
      timeline: [
        { occurredAt: "2026-07-04T07:12:00.000Z", type: "comment",
          actor: { kind: "human", userId: store.users.deniz.id, nameHint: null },
          title: null, text: "Following from the platform team.", toAgent: false, evidence: null },
        { occurredAt: "2026-07-04T07:00:00.000Z", type: "comment",
          actor: { kind: "human", userId: store.users.arda.id, nameHint: null },
          title: null, text: "Member comment.", toAgent: false, evidence: null },
      ],
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    const detail = getTaskDetail(store.db, store.slug, "VIB-1");
    const [guest, member] = detail!.timeline;
    expect(guest?.actor).toMatchObject({ kind: "human", guest: true });
    expect(member?.actor.kind).toBe("human");
    expect("guest" in (member?.actor ?? {})).toBe(false);
    // Denormalized snapshot: name resolved from the users table.
    expect(guest?.actor).toMatchObject({ name: "Deniz Test" });
  });

  it("membership change in project.md cascades guest flags onto tasks", async () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1"),
      timeline: [
        { occurredAt: "2026-07-04T07:00:00.000Z", type: "comment",
          actor: { kind: "human", userId: store.users.elif.id, nameHint: null },
          title: null, text: "Was a member when written.", toAgent: false, evidence: null },
      ],
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    let detail = getTaskDetail(store.db, store.slug, "VIB-1");
    expect("guest" in (detail!.timeline[0]!.actor as object)).toBe(false);

    // Remove elif from the project file → her events re-render as guest.
    const { readProjectFile } = await import("~/server/files/project-writer.server");
    const project = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
    project.parsed.frontmatter.members = project.parsed.frontmatter.members.filter(
      (m) => m.userId !== store.users.elif.id,
    );
    const { writeFileAtomic } = await import("~/server/files/atomic-file.server");
    const { serializeProjectFile } = await import("~/server/files/project-file.server");
    writeFileAtomic(project.absPath, serializeProjectFile(project.parsed));

    rebuildPath(store.db, project.absPath, { dataRoot: store.dataRoot });
    detail = getTaskDetail(store.db, store.slug, "VIB-1");
    expect(detail!.timeline[0]!.actor).toMatchObject({ guest: true });
  });
});
