import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
} from "../../../test-support/test-store";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { projectDir, taskDir } from "./file-store-root.server";
import {
  isFileWatcherAlive,
  shouldIgnoreWatchPath,
  startFileWatcher,
  stopFileWatcherForTests,
} from "./file-watch.service.server";

const ctx = createTestDbContext();
afterEach(() => {
  stopFileWatcherForTests();
  ctx.cleanup();
});

const WAIT_TIMEOUT_MS = 8000;

async function waitFor(cond: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

async function startWatcherReady(store: ReturnType<typeof setupTestStore>) {
  const watcher = startFileWatcher({ dataRoot: store.dataRoot, db: store.db });
  await new Promise((r) => setTimeout(r, 250));
  return watcher;
}

function taskCount(store: ReturnType<typeof setupTestStore>): number {
  return (
    store.db
      .prepare(`SELECT count(*) AS c FROM task_projections WHERE project_slug = ?`)
      .get(store.slug) as { c: number }
  ).c;
}

describe("unlinkDir handling (E13)", () => {
  it("a recursive task-dir rm prunes that task's projection rows", async () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, { frontmatter: baseTaskFrontmatter("VIB-1") });
    writeTask(store.dataRoot, store.slug, { frontmatter: baseTaskFrontmatter("VIB-2") });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    expect(taskCount(store)).toBe(2);

    await startWatcherReady(store);
    rmSync(taskDir(store.slug, "VIB-1", store.dataRoot), {
      recursive: true,
      force: true,
    });

    await waitFor(() => taskCount(store) === 1, "VIB-1 rows pruned");
    const left = store.db
      .prepare(`SELECT task_key FROM task_projections WHERE project_slug = ?`)
      .all(store.slug) as { task_key: string }[];
    expect(left.map((r) => r.task_key)).toEqual(["VIB-2"]);
  }, 15000);

  it("a recursive PROJECT rm reconciles the whole project (no orphan rows)", async () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, { frontmatter: baseTaskFrontmatter("VIB-1") });
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    await startWatcherReady(store);
    rmSync(projectDir(store.slug, store.dataRoot), { recursive: true, force: true });

    await waitFor(
      () =>
        store.db.prepare(`SELECT slug FROM projects WHERE slug = ?`).get(store.slug) ===
          undefined && taskCount(store) === 0,
      "project + task rows pruned",
    );
  }, 15000);
});

describe("subtree pruning (F-SPAWN1 — fd explosion)", () => {
  const root = "/data/projects";
  it("keeps project.md and task.md, prunes workspace clones", () => {
    expect(shouldIgnoreWatchPath(root, `${root}/p/project.md`)).toBe(false);
    expect(shouldIgnoreWatchPath(root, `${root}/p/tasks/VIB-1/task.md`)).toBe(false);
    expect(shouldIgnoreWatchPath(root, `${root}/p/tasks`)).toBe(false);
    expect(shouldIgnoreWatchPath(root, `${root}/p/tasks/VIB-1`)).toBe(false);
    expect(shouldIgnoreWatchPath(root, `${root}/p/tasks/VIB-1/workspace`)).toBe(true);
    expect(shouldIgnoreWatchPath(root, `${root}/p/tasks/VIB-1/workspace/repo/src/index.ts`)).toBe(true);
  });

  it("does not prune outside the watch root", () => {
    expect(shouldIgnoreWatchPath(root, root)).toBe(false);
    expect(shouldIgnoreWatchPath(root, "/somewhere/else")).toBe(false);
  });

  it("integration: a workspace-file write never reprojects; task.md edits still do", async () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, { frontmatter: baseTaskFrontmatter("VIB-1") });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const projectedTitle = () =>
      (store.db
        .prepare(`SELECT title FROM task_projections WHERE project_slug = ? AND task_key = ?`)
        .get(store.slug, "VIB-1") as { title: string }).title;
    const originalTitle = projectedTitle();

    await startWatcherReady(store);

    // Write a file deep inside the task's workspace clone — must be ignored (the
    // pruning keeps the recursive watcher out of cloned-repo files).
    const wsDir = path.join(taskDir(store.slug, "VIB-1", store.dataRoot), "workspace", "repo", "src");
    mkdirSync(wsDir, { recursive: true });
    writeFileSync(path.join(wsDir, "index.ts"), "export const x = 1;\n");
    // Give the watcher a beat; the workspace write must NOT reproject.
    await new Promise((r) => setTimeout(r, 600));
    expect(projectedTitle()).toBe(originalTitle);

    // A real task.md edit still reprojects (proves pruning didn't kill watching).
    writeTask(store.dataRoot, store.slug, {
      frontmatter: { ...baseTaskFrontmatter("VIB-1"), title: "Edited title after pruning" },
    });
    await waitFor(
      () => projectedTitle() === "Edited title after pruning",
      "task.md reprojected after edit",
    );
  }, 15000);
});

describe("watcher liveness (E8)", () => {
  it("an fs watcher error clears the cached handle", async () => {
    const store = setupTestStore(ctx);
    const watcher = await startWatcherReady(store);
    expect(isFileWatcherAlive()).toBe(true);

    watcher.emit("error", new Error("EMFILE: too many open files"));
    expect(isFileWatcherAlive()).toBe(false);
  }, 15000);
});

describe("watcher re-arm lifecycle (F10-08)", () => {
  it("teardown cancels a pending transient re-arm — it cannot resurrect the watcher", async () => {
    const store = setupTestStore(ctx);
    const watcher = await startWatcherReady(store);
    expect(isFileWatcherAlive()).toBe(true);

    // Only fake timers so the native watcher stays real.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      // A transient error WITH a code schedules the 2s self-heal re-arm.
      watcher.emit(
        "error",
        Object.assign(new Error("EMFILE"), { code: "EMFILE" }),
      );
      expect(isFileWatcherAlive()).toBe(false);
      // Teardown must cancel that pending re-arm and bump the generation, so
      // advancing well past the backoff never brings a watcher back (the old
      // untracked timer re-fired on `cache === undefined` — exactly what
      // teardown creates — resurrecting a watcher against a deleted root).
      stopFileWatcherForTests();
      vi.advanceTimersByTime(10_000);
      expect(isFileWatcherAlive()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  }, 15000);
});
