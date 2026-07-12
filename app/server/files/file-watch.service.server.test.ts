import { EventEmitter } from "node:events";
import { rmSync } from "node:fs";
import type { ChokidarOptions, FSWatcher } from "chokidar";
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
  startFileWatcher,
  startFileWatcherReady,
  stopFileWatcherForTests,
  WATCH_DEBOUNCE_MS,
  type FileWatcherRuntime,
} from "./file-watch.service.server";
import type { TimerScheduler } from "./path-debounce.server";

/** A deterministic clock: these tests never leave a native timer behind. */
class ManualClock implements TimerScheduler {
  private now = 0;
  private nextId = 1;
  private jobs = new Map<number, { at: number; callback: () => void }>();

  setTimeout(callback: () => void, delayMs: number): unknown {
    const id = this.nextId++;
    this.jobs.set(id, { at: this.now + delayMs, callback });
    return id;
  }

  clearTimeout(timer: unknown): void {
    this.jobs.delete(timer as number);
  }

  advance(ms: number): void {
    const target = this.now + ms;
    while (true) {
      const next = [...this.jobs.entries()]
        .filter(([, job]) => job.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      const [id, job] = next;
      this.jobs.delete(id);
      this.now = job.at;
      job.callback();
    }
    this.now = target;
  }

  get pendingCount(): number {
    return this.jobs.size;
  }
}

class FakeWatcher extends EventEmitter {
  close = vi.fn<() => Promise<void>>(() => Promise.resolve());
}

function watcherHarness() {
  const clock = new ManualClock();
  const watchers: FakeWatcher[] = [];
  const watched: { dir: string; options: ChokidarOptions }[] = [];
  const runtime: FileWatcherRuntime = {
    timers: clock,
    retryDelayMs: 2_000,
    createWatcher: (dir, options) => {
      watched.push({ dir, options });
      const watcher = new FakeWatcher();
      watchers.push(watcher);
      return watcher as unknown as FSWatcher;
    },
  };
  return { clock, watchers, watched, runtime };
}

const ctx = createTestDbContext();
afterEach(async () => {
  await stopFileWatcherForTests();
  ctx.cleanup();
});

function taskCount(store: ReturnType<typeof setupTestStore>): number {
  return (
    store.db
      .prepare(`SELECT count(*) AS c FROM task_projections WHERE project_slug = ?`)
      .get(store.slug) as { c: number }
  ).c;
}

describe("directory projection handling", () => {
  it("a recursive task-dir removal prunes that task without a native watcher", () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1"),
    });
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-2"),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const harness = watcherHarness();
    startFileWatcher({
      dataRoot: store.dataRoot,
      db: store.db,
      runtime: harness.runtime,
    });

    const removedDir = taskDir(store.slug, "VIB-1", store.dataRoot);
    rmSync(removedDir, { recursive: true, force: true });
    harness.watchers[0]!.emit("unlinkDir", removedDir);
    // unlinkDir maps the directory onto task.md, then the file debounce fires.
    harness.clock.advance(WATCH_DEBOUNCE_MS * 2);

    expect(taskCount(store)).toBe(1);
    const left = store.db
      .prepare(`SELECT task_key FROM task_projections WHERE project_slug = ?`)
      .all(store.slug) as { task_key: string }[];
    expect(left.map((row) => row.task_key)).toEqual(["VIB-2"]);
  });

  it("a recursive project removal reconciles project and task rows", () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1"),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const harness = watcherHarness();
    startFileWatcher({
      dataRoot: store.dataRoot,
      db: store.db,
      runtime: harness.runtime,
    });

    const removedDir = projectDir(store.slug, store.dataRoot);
    rmSync(removedDir, { recursive: true, force: true });
    harness.watchers[0]!.emit("unlinkDir", removedDir);
    harness.clock.advance(WATCH_DEBOUNCE_MS);

    expect(
      store.db.prepare(`SELECT slug FROM projects WHERE slug = ?`).get(store.slug),
    ).toBeUndefined();
    expect(taskCount(store)).toBe(0);
  });
});

describe("generation-bound watcher lifecycle", () => {
  it("readiness resolves only on ready and rejects the underlying error", async () => {
    const store = setupTestStore(ctx);
    const harness = watcherHarness();
    const ready = startFileWatcherReady({
      dataRoot: store.dataRoot,
      db: store.db,
      runtime: harness.runtime,
      readyTimeoutMs: 100,
    });
    const error = new Error("watch setup failed");
    harness.watchers[0]!.emit("error", error);

    await expect(ready).rejects.toBe(error);
    expect(isFileWatcherAlive()).toBe(false);
  });

  it("a readiness timeout rejects instead of pretending the watcher is ready", async () => {
    const store = setupTestStore(ctx);
    const harness = watcherHarness();
    const ready = startFileWatcherReady({
      dataRoot: store.dataRoot,
      db: store.db,
      runtime: harness.runtime,
      readyTimeoutMs: 75,
    });

    harness.clock.advance(75);
    await expect(ready).rejects.toThrow("did not become ready within 75 ms");
  });

  it("a real ready event resolves and cancels the readiness timeout", async () => {
    const store = setupTestStore(ctx);
    const harness = watcherHarness();
    const ready = startFileWatcherReady({
      dataRoot: store.dataRoot,
      db: store.db,
      runtime: harness.runtime,
      readyTimeoutMs: 75,
    });
    harness.watchers[0]!.emit("ready");

    await expect(ready).resolves.toBe(harness.watchers[0]);
    expect(harness.clock.pendingCount).toBe(0);
  });

  it("stop cancels a transient retry and prevents resurrection", async () => {
    const store = setupTestStore(ctx);
    const harness = watcherHarness();
    startFileWatcher({
      dataRoot: store.dataRoot,
      db: store.db,
      runtime: harness.runtime,
    });
    const transient = Object.assign(new Error("too many files"), { code: "EMFILE" });
    harness.watchers[0]!.emit("error", transient);
    expect(isFileWatcherAlive()).toBe(false);
    expect(harness.clock.pendingCount).toBe(1);

    await stopFileWatcherForTests();
    harness.clock.advance(10_000);
    expect(harness.watchers).toHaveLength(1);
    expect(harness.clock.pendingCount).toBe(0);
  });

  it("a transient error re-arms once, while late old-generation errors are inert", () => {
    const store = setupTestStore(ctx);
    const harness = watcherHarness();
    startFileWatcher({
      dataRoot: store.dataRoot,
      db: store.db,
      runtime: harness.runtime,
    });
    const transient = Object.assign(new Error("too many files"), { code: "EMFILE" });
    harness.watchers[0]!.emit("error", transient);
    harness.clock.advance(1_999);
    expect(harness.watchers).toHaveLength(1);
    harness.clock.advance(1);
    expect(harness.watchers).toHaveLength(2);
    expect(isFileWatcherAlive()).toBe(true);

    harness.watchers[0]!.emit("error", transient);
    harness.clock.advance(2_000);
    expect(harness.watchers).toHaveLength(2);
  });

  it("root replacement retires the old generation and awaits close on stop", async () => {
    const first = setupTestStore(ctx);
    const second = setupTestStore(ctx);
    const harness = watcherHarness();
    startFileWatcher({
      dataRoot: first.dataRoot,
      db: first.db,
      runtime: harness.runtime,
    });
    startFileWatcher({
      dataRoot: second.dataRoot,
      db: second.db,
      runtime: harness.runtime,
    });

    expect(harness.watchers).toHaveLength(2);
    expect(harness.watchers[0]!.close).toHaveBeenCalledTimes(1);
    await stopFileWatcherForTests();
    expect(harness.watchers[1]!.close).toHaveBeenCalledTimes(1);
  });
});
