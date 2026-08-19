import path from "node:path";
import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { watch, type FSWatcher } from "chokidar";
import { z } from "zod";
import { getDb } from "~/server/db/sqlite.server";
import { logger } from "~/server/logging/logger.server";
import { reindexKnowledgeBaseByDir } from "~/server/org/resources.server";
import { getDataRoot, kbRootDir } from "./file-store-root.server";

/**
 * Watches ${dataRoot}/kb and re-indexes a knowledge base when its store files
 * change (R-D / P11-60). Mirrors the file-native model the rest of the store
 * uses: no scheduler, no "nightly" cadence — a KB in "on change" mode simply
 * re-indexes (its `last_indexed_at` moves and its doc count is recomputed) the
 * moment a doc under it is added, edited, or removed. A KB pinned to "manual"
 * is skipped (handled inside `reindexKnowledgeBaseByDir`).
 *
 * The event source is chokidar (typed events, atomic-write coalescing,
 * portable recursion); debounce and re-index dispatch stay Viberr code.
 *
 * - 250 ms trailing debounce per KB dir (editors fire event bursts);
 * - the changed path's FIRST segment under kb/ names the KB dir to re-index;
 * - `ignoreInitial: true`: existing docs are already indexed (indexing happens
 *   at KB save/refresh), so the initial scan must not bump `last_indexed_at`
 *   on every boot. An external edit landing inside the sub-second scan window
 *   is picked up on that KB's next touch or a manual refresh.
 * - HMR-safe: the handle lives behind a global symbol, so a reload reuses the
 *   running watcher instead of stacking duplicates.
 */

export const KB_WATCH_DEBOUNCE_MS = 250;

/** Node hangs its errno off `code`; a watcher error without one is not a
 *  condition this module branches on. */
const errnoSchema = z.object({
  code: z.string().optional().catch(undefined),
});

const KB_WATCHER_KEY = Symbol.for("viberr.kbWatcher");

interface KbWatcherHandle {
  watcher: FSWatcher;
  timers: Map<string, ReturnType<typeof setTimeout>>;
  root: string;
}

/** The single `globalThis` slot this module owns — the handle survives an HMR
 *  module reload, which a module-level variable would not. */
interface KbWatcherHost {
  [KB_WATCHER_KEY]?: KbWatcherHandle;
}

function kbWatcherHost(): KbWatcherHost {
  // SAFETY: `KB_WATCHER_KEY` is a registry symbol under a viberr-namespaced
  // name that only the functions in this module read or write, so the slot
  // holds either the handle they put there or nothing at all.
  return globalThis as KbWatcherHost;
}

/** The top-level KB dir a changed path belongs to, or null when out of tree. */
export function kbDirOfChange(kbRoot: string, changedRel: string): string | null {
  if (!changedRel) return null;
  const rel = path.relative(kbRoot, path.resolve(kbRoot, changedRel));
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  const first = rel.split(path.sep)[0];
  if (!first || first.startsWith(".")) return null;
  return first;
}

/** Starts (or returns the already-running) kb-tree watcher. */
export function startKbWatcher(
  options: { dataRoot?: string; db?: DatabaseSync } = {},
): FSWatcher | null {
  const cache = kbWatcherHost();
  const root = getDataRoot(options.dataRoot);
  const kbRoot = kbRootDir(options.dataRoot);
  const existing = cache[KB_WATCHER_KEY];
  if (existing && existing.root === root) return existing.watcher;
  if (existing) {
    for (const t of existing.timers.values()) clearTimeout(t);
    void existing.watcher.close();
    cache[KB_WATCHER_KEY] = undefined;
  }
  if (!existsSync(kbRoot)) return null;

  const resolveDb = () => options.db ?? getDb();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const reindex = (dir: string) => {
    try {
      const result = reindexKnowledgeBaseByDir(resolveDb(), dir, { dataRoot: root });
      if (result) {
        logger.info("kb watcher re-indexed", {
          dir,
          name: result.name,
          docCount: result.docCount,
        });
      }
    } catch (error) {
      logger.error("kb watcher re-index failed", {
        dir,
        err: error instanceof Error ? error : new Error(String(error)),
      });
    }
  };

  const onEvent = (eventPath: string) => {
    const dir = kbDirOfChange(kbRoot, path.relative(kbRoot, path.resolve(kbRoot, eventPath)));
    if (!dir) return;
    const pending = timers.get(dir);
    if (pending) clearTimeout(pending);
    timers.set(
      dir,
      setTimeout(() => {
        timers.delete(dir);
        reindex(dir);
      }, KB_WATCH_DEBOUNCE_MS),
    );
  };

  let watcher: FSWatcher;
  try {
    watcher = watch(kbRoot, {
      ignoreInitial: true,
      followSymlinks: false,
      atomic: true,
    });
    watcher
      .on("add", onEvent)
      .on("change", onEvent)
      .on("unlink", onEvent)
      .on("addDir", onEvent)
      .on("unlinkDir", onEvent);
  } catch (error) {
    logger.error("kb watcher failed to start", {
      kbRoot,
      err: error instanceof Error ? error : new Error(String(error)),
    });
    return null;
  }

  watcher.on("error", (err) => {
    const errno = errnoSchema.safeParse(err);
    const code = errno.success ? errno.data.code : undefined;
    // A vanished path is NOT a broken watcher (mirrors the store watcher):
    // deleting a watched KB subtree can race into a spurious ENOENT while its
    // debounced re-index is still queued. Keep watching.
    if (code === "ENOENT") {
      logger.debug("kb watcher ignored ENOENT for a removed path", { code });
      return;
    }
    // DM-2: a zombie watcher stops delivering events but stayed cached forever —
    // isKbWatcherAlive() (and /resources/health) then lied. Clear the handle so
    // health reports the truth, then re-arm on transient FS-pressure errors
    // (mirrors the store file watcher) so a blip doesn't permanently stop KB
    // re-indexing until a restart.
    logger.error("kb watcher error — clearing watcher handle", {
      err: err instanceof Error ? err : new Error(String(err)),
      code,
    });
    const current = cache[KB_WATCHER_KEY];
    if (current && current.watcher === watcher) {
      for (const t of current.timers.values()) clearTimeout(t);
      cache[KB_WATCHER_KEY] = undefined;
    }
    void watcher.close();
    const TRANSIENT = new Set(["EMFILE", "ENFILE", "ENOSPC", "EPERM", "EACCES"]);
    if (code && TRANSIENT.has(code)) {
      setTimeout(() => {
        if (cache[KB_WATCHER_KEY] !== undefined) return; // someone re-armed already
        logger.info("kb watcher re-arming after a transient error", { code });
        try {
          startKbWatcher(options);
        } catch (reErr) {
          logger.error("kb watcher re-arm failed", {
            err: reErr instanceof Error ? reErr : new Error(String(reErr)),
          });
        }
      }, 1000).unref?.();
    }
  });

  cache[KB_WATCHER_KEY] = { watcher, timers, root };
  logger.info("kb watcher started", { kbRoot });
  return watcher;
}

/** True while the KB watcher handle is live — /resources/health parity (DM-2).
 *  A watcher error clears the handle, so `false` is REAL (dead/never-started),
 *  not a zombie. */
export function isKbWatcherAlive(): boolean {
  return kbWatcherHost()[KB_WATCHER_KEY] !== undefined;
}

/** Stops the kb watcher (process shutdown + test teardown). The native close
 *  is fire-and-forget: clearing timers/handle is what stops domain work. */
export function stopKbWatcher(): void {
  const cache = kbWatcherHost();
  const existing = cache[KB_WATCHER_KEY];
  if (!existing) return;
  for (const t of existing.timers.values()) clearTimeout(t);
  void existing.watcher.close();
  cache[KB_WATCHER_KEY] = undefined;
}
