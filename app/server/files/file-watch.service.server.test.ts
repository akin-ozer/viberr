import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
} from "../../../test-support/test-store";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { projectDir, projectsDir, taskDir } from "./file-store-root.server";
import {
  isFileWatcherAlive,
  shouldPruneSubtree,
  startFileWatcher,
  stopFileWatcherForTests,
} from "./file-watch.service.server";

/**
 * Real-chokidar watcher tests (temp store, injected test db — the watcher
 * must never touch the env-default database from a test).
 */

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
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 2000); // safety net if already ready
    watcher.once("ready", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  // chokidar's "ready" fires when the initial scan completes, but there is a
  // small gap before the OS-level watches on the just-scanned subdirectories are
  // fully established. A recursive rm that lands in that gap can miss the
  // unlinkDir event — the source of an intermittent flake in the rm tests. A
  // short settle after ready closes the window deterministically.
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
    // Store paths that MUST be watched (they project).
    expect(shouldPruneSubtree(root, `${root}/p/project.md`)).toBe(false);
    expect(shouldPruneSubtree(root, `${root}/p/tasks/VIB-1/task.md`)).toBe(false);
    expect(shouldPruneSubtree(root, `${root}/p/tasks`, { isDirectory: () => true })).toBe(false);
    expect(shouldPruneSubtree(root, `${root}/p/tasks/VIB-1`, { isDirectory: () => true })).toBe(false);
    // The workspace dir (and anything below it) is runtime scratch — prune it so
    // chokidar never opens an fd per cloned-repo file.
    expect(shouldPruneSubtree(root, `${root}/p/tasks/VIB-1/workspace`, { isDirectory: () => true })).toBe(true);
    expect(shouldPruneSubtree(root, `${root}/p/tasks/VIB-1/workspace/repo/src/index.ts`)).toBe(true);
    expect(shouldPruneSubtree(root, `${root}/p/tasks/VIB-1/workspace/repo/package.json`)).toBe(true);
  });

  it("prunes a directory named workspace even before stats resolve", () => {
    expect(shouldPruneSubtree(root, `${root}/p/tasks/VIB-1/workspace`)).toBe(true);
  });

  it("does not prune outside the watch root", () => {
    expect(shouldPruneSubtree(root, root)).toBe(false);
    expect(shouldPruneSubtree(root, "/somewhere/else")).toBe(false);
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
    // pruning is what keeps chokidar from opening an fd per cloned-repo file).
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
  it("a chokidar error clears the cached handle — health reports the truth", async () => {
    const store = setupTestStore(ctx);
    const watcher = await startWatcherReady(store);
    expect(isFileWatcherAlive()).toBe(true);

    watcher.emit("error", new Error("EMFILE: too many open files"));
    expect(isFileWatcherAlive()).toBe(false);
  }, 15000);
});
