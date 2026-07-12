import path from "node:path";
import type Database from "better-sqlite3";
import { watch, type ChokidarOptions, type FSWatcher } from "chokidar";
import { getDb } from "~/server/db/sqlite.server";
import { logger } from "~/server/logging/logger.server";
import { rebuildPath, rebuildTaskFile } from "~/server/projections/rebuilder.server";
import { getDataRoot, projectFilePath, projectsDir, taskFilePath } from "./file-store-root.server";
import {
  createPathDebouncer,
  type PathDebouncer,
  type TimerScheduler,
} from "./path-debounce.server";

/**
 * File watcher: chokidar (v5) on the data-root projects tree, driving
 * single-file incremental projection rebuilds.
 *
 * The lifecycle is generation-bound. A replaced or stopped generation may
 * still emit a late chokidar event, but it cannot clear, retry, or otherwise
 * mutate the current watcher. Retry timers and debounce timers use the same
 * injectable clock and are always cancelled by stop/replacement.
 */

export const WATCH_DEBOUNCE_MS = 250;
export const WATCH_RETRY_MS = 2_000;

const WATCHER_LIFECYCLE_KEY = Symbol.for("viberr.fileWatcher.lifecycle.v2");
const TRANSIENT_WATCH_ERRORS = new Set([
  "EMFILE",
  "ENFILE",
  "ENOSPC",
  "EPERM",
  "EACCES",
]);

export interface FileWatcherRuntime {
  createWatcher?: (watchedDir: string, options: ChokidarOptions) => FSWatcher;
  timers?: TimerScheduler;
  retryDelayMs?: number;
}

export interface FileWatcherOptions {
  dataRoot?: string;
  db?: Database.Database;
  /** Environment seams for deterministic lifecycle tests. */
  runtime?: FileWatcherRuntime;
}

export interface FileWatcherReadyOptions extends FileWatcherOptions {
  /** Readiness never resolves by timeout: expiry rejects with a diagnostic. */
  readyTimeoutMs?: number;
}

interface ResolvedRuntime {
  createWatcher: (watchedDir: string, options: ChokidarOptions) => FSWatcher;
  timers: TimerScheduler;
  retryDelayMs: number;
}

interface WatcherHandle {
  watcher: FSWatcher;
  debouncer: PathDebouncer;
  dirDebouncer: PathDebouncer;
  root: string;
  generation: number;
  runtime: ResolvedRuntime;
  ready: Promise<FSWatcher>;
  resolveReady: (watcher: FSWatcher) => void;
  rejectReady: (error: Error) => void;
  readinessSettled: boolean;
}

interface WatcherLifecycle {
  generation: number;
  handle?: WatcherHandle;
  desiredOptions?: FileWatcherOptions;
  retryTimer: unknown | null;
  retryTimers?: TimerScheduler;
  closing: Set<Promise<void>>;
}

const systemTimers: TimerScheduler = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

function lifecycle(): WatcherLifecycle {
  const cache = globalThis as unknown as Record<symbol, WatcherLifecycle | undefined>;
  return (cache[WATCHER_LIFECYCLE_KEY] ??= {
    generation: 0,
    retryTimer: null,
    closing: new Set<Promise<void>>(),
  });
}

function resolveRuntime(runtime: FileWatcherRuntime | undefined): ResolvedRuntime {
  return {
    createWatcher: runtime?.createWatcher ?? ((dir, options) => watch(dir, options)),
    timers: runtime?.timers ?? systemTimers,
    retryDelayMs: runtime?.retryDelayMs ?? WATCH_RETRY_MS,
  };
}

function cancelRetry(state: WatcherLifecycle): void {
  if (state.retryTimer !== null) {
    state.retryTimers?.clearTimeout(state.retryTimer);
  }
  state.retryTimer = null;
  state.retryTimers = undefined;
}

function rejectReadiness(handle: WatcherHandle, error: Error): void {
  if (handle.readinessSettled) return;
  handle.readinessSettled = true;
  handle.rejectReady(error);
}

function trackClose(state: WatcherLifecycle, handle: WatcherHandle): Promise<void> {
  handle.debouncer.cancelAll();
  handle.dirDebouncer.cancelAll();
  rejectReadiness(handle, new Error("File watcher stopped before it became ready."));

  let closePromise: Promise<void>;
  try {
    closePromise = Promise.resolve(handle.watcher.close());
  } catch (error) {
    closePromise = Promise.reject(error);
  }
  const tracked = closePromise
    .catch((error) => {
      logger.error("file watcher close failed", {
        err: error instanceof Error ? error : new Error(String(error)),
      });
    })
    .finally(() => state.closing.delete(tracked));
  state.closing.add(tracked);
  return tracked;
}

function shouldIgnore(candidate: string): boolean {
  const base = path.basename(candidate);
  return base.startsWith(".") || base.endsWith(".tmp");
}

/** Starts (or returns the already-running) projects-tree watcher. */
export function startFileWatcher(options: FileWatcherOptions = {}): FSWatcher {
  const state = lifecycle();
  const root = getDataRoot(options.dataRoot);
  const existing = state.handle;
  if (existing && existing.root === root) return existing.watcher;

  // A direct start supersedes both a pending transient retry and an older
  // generation. Late events from the retired watcher are ignored below.
  cancelRetry(state);
  state.desiredOptions = options;
  state.generation += 1;
  const generation = state.generation;
  if (existing) {
    state.handle = undefined;
    void trackClose(state, existing);
  }

  const runtime = resolveRuntime(options.runtime);
  const resolveDb = () => options.db ?? getDb();
  const watchedDir = projectsDir(options.dataRoot);
  const debouncer = createPathDebouncer(
    WATCH_DEBOUNCE_MS,
    (absPath) => {
      try {
        const result = rebuildPath(resolveDb(), absPath, { dataRoot: root });
        if (result.action !== "ignored" && result.action !== "unchanged") {
          logger.info("watcher reprojected file", {
            path: absPath,
            action: result.action,
            projectSlug: result.projectSlug,
            taskKey: result.taskKey,
          });
        }
      } catch (error) {
        logger.error("watcher rebuild failed", {
          path: absPath,
          err: error instanceof Error ? error : new Error(String(error)),
        });
      }
    },
    runtime.timers,
  );

  /**
   * A directory vanished. Map it onto the projection rows it backed:
   * projects/<slug>, projects/<slug>/tasks -> reconcile project;
   * projects/<slug>/tasks/<KEY> -> reproject that task as removed.
   */
  const dirDebouncer = createPathDebouncer(
    WATCH_DEBOUNCE_MS,
    (absDir) => {
      try {
        const db = resolveDb();
        const rel = path.relative(watchedDir, absDir);
        if (rel.startsWith("..")) return;
        const segments = rel === "" ? [] : rel.split(path.sep);

        const reconcileProject = (slug: string) => {
          rebuildPath(db, projectFilePath(slug, root), { dataRoot: root });
          const tasks = db
            .prepare(`SELECT task_key FROM task_projections WHERE project_slug = ?`)
            .all(slug) as { task_key: string }[];
          for (const task of tasks) {
            rebuildTaskFile(db, slug, task.task_key, { dataRoot: root });
          }
          logger.info("watcher reconciled removed directory", {
            path: absDir,
            projectSlug: slug,
          });
        };

        if (segments.length === 0) {
          const slugs = db.prepare(`SELECT slug FROM projects`).all() as {
            slug: string;
          }[];
          for (const row of slugs) reconcileProject(row.slug);
          return;
        }
        const slug = segments[0]!;
        if (segments.length === 1) return reconcileProject(slug);
        if (segments[1] !== "tasks") return;
        if (segments.length === 2) return reconcileProject(slug);
        if (segments.length === 3) {
          debouncer.schedule(path.resolve(taskFilePath(slug, segments[2]!, root)));
        }
      } catch (error) {
        logger.error("watcher directory reconcile failed", {
          path: absDir,
          err: error instanceof Error ? error : new Error(String(error)),
        });
      }
    },
    runtime.timers,
  );

  const watcher = runtime.createWatcher(watchedDir, {
    ignoreInitial: true,
    ignored: (candidate: string) => shouldIgnore(candidate),
  });

  let resolveReady!: (watcher: FSWatcher) => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<FSWatcher>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // startFileWatcher() does not itself await readiness. Install a rejection
  // observer so a boot-time error is logged/handled without an unhandled
  // promise while startFileWatcherReady() callers still receive rejection.
  void ready.catch(() => undefined);

  const handle: WatcherHandle = {
    watcher,
    debouncer,
    dirDebouncer,
    root,
    generation,
    runtime,
    ready,
    resolveReady,
    rejectReady,
    readinessSettled: false,
  };
  state.handle = handle;

  const isCurrent = () =>
    state.generation === generation && state.handle === handle;

  const schedule = (absPath: string) => {
    if (!isCurrent() || shouldIgnore(absPath)) return;
    const base = path.basename(absPath);
    if (base !== "project.md" && base !== "task.md") return;
    debouncer.schedule(path.resolve(absPath));
  };

  watcher.on("ready", () => {
    if (!isCurrent() || handle.readinessSettled) return;
    handle.readinessSettled = true;
    handle.resolveReady(watcher);
  });
  watcher.on("add", schedule);
  watcher.on("change", schedule);
  watcher.on("unlink", schedule);
  watcher.on("unlinkDir", (absDir: string) => {
    if (!isCurrent() || shouldIgnore(absDir)) return;
    dirDebouncer.schedule(path.resolve(absDir));
  });
  watcher.on("error", (error) => {
    // A retired generation may emit after close; it has no authority over the
    // current handle and, critically, may not schedule a resurrection.
    if (!isCurrent()) return;
    const normalized = error instanceof Error ? error : new Error(String(error));
    const code = (error as { code?: string } | null)?.code;
    logger.error("file watcher error — retiring watcher generation", {
      err: normalized,
      code,
      generation,
    });

    state.handle = undefined;
    rejectReadiness(handle, normalized);
    void trackClose(state, handle);

    if (!code || !TRANSIENT_WATCH_ERRORS.has(code)) return;
    const retryGeneration = generation;
    state.retryTimers = runtime.timers;
    const timer = runtime.timers.setTimeout(() => {
      if (state.retryTimer !== timer) return;
      state.retryTimer = null;
      state.retryTimers = undefined;
      if (
        state.generation !== retryGeneration ||
        state.handle !== undefined ||
        state.desiredOptions === undefined
      ) {
        return;
      }
      logger.info("file watcher re-arming after a transient error", { code });
      try {
        startFileWatcher(state.desiredOptions);
      } catch (retryError) {
        logger.error("file watcher re-arm failed", {
          err:
            retryError instanceof Error
              ? retryError
              : new Error(String(retryError)),
        });
      }
    }, runtime.retryDelayMs);
    state.retryTimer = timer;
  });

  logger.info("file watcher started", {
    dir: watchedDir,
    debounceMs: WATCH_DEBOUNCE_MS,
    generation,
  });
  return watcher;
}

/**
 * Starts the watcher and waits for chokidar's real `ready` event. Errors and
 * timeouts reject; a timeout is never treated as a successful ready state.
 */
export async function startFileWatcherReady(
  options: FileWatcherReadyOptions = {},
): Promise<FSWatcher> {
  const watcher = startFileWatcher(options);
  const state = lifecycle();
  const handle = state.handle;
  if (!handle || handle.watcher !== watcher) {
    throw new Error("File watcher was retired while waiting for readiness.");
  }

  const timeoutMs = options.readyTimeoutMs ?? 10_000;
  let timeout: unknown | null = null;
  try {
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = handle.runtime.timers.setTimeout(
        () => reject(new Error(`File watcher did not become ready within ${timeoutMs} ms.`)),
        timeoutMs,
      );
    });
    return await Promise.race([handle.ready, timeoutPromise]);
  } finally {
    if (timeout !== null) handle.runtime.timers.clearTimeout(timeout);
  }
}

/** True while the current generation has a trusted watcher handle. */
export function isFileWatcherAlive(): boolean {
  return lifecycle().handle !== undefined;
}

/** Test-only: stop, cancel retries/debounces, and await every watcher close. */
export async function stopFileWatcherForTests(): Promise<void> {
  const state = lifecycle();
  state.generation += 1;
  state.desiredOptions = undefined;
  cancelRetry(state);
  const existing = state.handle;
  state.handle = undefined;
  if (existing) void trackClose(state, existing);
  await Promise.all([...state.closing]);
}
