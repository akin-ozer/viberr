import { statSync } from "node:fs";
import { logger } from "../logging/logger.server";

/**
 * Read-your-own-writes repair for cached bind mounts — ONE implementation for
 * every canonical file writer (task.md, project.md, epics/*.md).
 *
 * On Docker Desktop (VirtioFS), a read milliseconds after this process's own
 * atomic rename can return the PREVIOUS file content — observed live (VIB-1,
 * 2026-07-17): the reviewer's reply comment landed on disk, the next locked
 * read-modify-write (the verdict, 2 ms later) read the stale pre-comment
 * content, and its write erased the comment permanently. Remember the last
 * content THIS process wrote per path; when a locked read disagrees and the
 * file's mtime has not advanced past our write (i.e. no EXTERNAL writer touched
 * it since), trust our own write. An external edit (a human editing the file,
 * another process) bumps mtime past the recorded write time and wins as before.
 *
 * C01-A2 (pass 32): the task and project writers each carried a private copy
 * of this and the goal writer had none — pass-31 gotcha 10 predicted that two
 * back-to-back link-status writes on VirtioFS could lose one. One module now,
 * three callers (the epic writer took the goal writer's place, ruling 503).
 */
const lastWritten = new Map<string, { content: string; wroteAtMs: number }>();
const LAST_WRITTEN_MAX_ENTRIES = 500;

/** 100 ms slack for mtime granularity/clock skew between the write and the
 *  rename's recorded time. An external writer lands AFTER our write, so its
 *  mtime exceeds `wroteAtMs + slack` and disk wins. */
const MTIME_SLACK_MS = 100;

export function rememberWrite(absPath: string, content: string): void {
  if (lastWritten.size >= LAST_WRITTEN_MAX_ENTRIES && !lastWritten.has(absPath)) {
    // Crude bound: drop the oldest entry (Map preserves insertion order).
    const oldest = lastWritten.keys().next().value;
    if (oldest !== undefined) lastWritten.delete(oldest);
  }
  lastWritten.delete(absPath); // re-insert at the tail (freshest last)
  lastWritten.set(absPath, { content, wroteAtMs: Date.now() });
}

/**
 * The freshest content for a locked read: `diskContent`, unless it is provably
 * a stale cache of our own earlier write — then that write. `describe` names
 * the file for the warn line (the caller knows its kind and key).
 */
export function freshestContent(
  absPath: string,
  diskContent: string,
  describe: { kind: string; id: string },
): string {
  const remembered = lastWritten.get(absPath);
  if (!remembered || diskContent === remembered.content) return diskContent;
  let mtimeMs: number;
  try {
    mtimeMs = statSync(absPath).mtimeMs;
  } catch {
    return diskContent;
  }
  if (mtimeMs > remembered.wroteAtMs + MTIME_SLACK_MS) return diskContent;
  logger.warn(`stale ${describe.kind} read repaired from the in-process write cache`, {
    [describe.kind === "task-file" ? "taskKey" : describe.kind === "project-file" ? "projectSlug" : "epicId"]:
      describe.id,
    absPath,
  });
  return remembered.content;
}

/** test-only: forget every remembered write. */
export function resetWriteCacheForTests(): void {
  lastWritten.clear();
}
