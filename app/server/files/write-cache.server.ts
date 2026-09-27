import { statSync } from "node:fs";
import { logger } from "../logging/logger.server";
import { writeFileAtomic } from "./atomic-file.server";

/**
 * Read-your-own-writes repair for cached bind mounts — ONE implementation for
 * every canonical file writer (task.md, project.md, epics/*.md).
 *
 * On Docker Desktop (VirtioFS), a read milliseconds after this process's own
 * atomic rename can return the PREVIOUS file content — observed live (VIB-1,
 * 2026-07-17): the reviewer's reply comment landed on disk, the next locked
 * read-modify-write (the verdict, 2 ms later) read the stale pre-comment
 * content, and its write erased the comment permanently. Remember the last
 * content THIS process wrote per path; when a locked read disagrees with it,
 * trust our own write only while the read is provably a stale view of it.
 *
 * Ruling 513: "provably" is the file's IDENTITY, never a clock.
 * `writeFileAtomic` renames a fresh temp file over the path, so every write
 * puts a new inode there. `writeAndRemember` stats the path just before the
 * write (the file it replaces) and right after the rename (the file it put
 * there), because a cached mount can show either: the old file itself, or
 * fresh attributes over the old bytes. The repair holds only while the path
 * still shows one of those two. Any other identity is another writer (a
 * restore, a person's editor, a re-seed, a second process) and wins, however
 * soon after ours it landed. The 100 ms mtime window this replaced reverted
 * every such writer inside it, and it compared the file system's clock with
 * this process's, so a skew past 100 ms either widened that window or switched
 * the repair off.
 *
 * What an identity cannot tell apart, stated so nobody mistakes it for a
 * guarantee: an in-place rewrite of exactly our file's size inside the same
 * timestamp tick as our write (the blind spot of any stat key; parse-memo
 * names it too), and a new file that carries exactly the identity of the file
 * ours replaced: its size, its mtime and its freed inode number, which ext4
 * hands to the very next file it creates. A copy put back with its old mtime
 * preserved (`cp -p`, `rsync -a`, `tar`) can do that, and so can a re-seed of
 * the same bytes inside the tick that file was stamped in (Linux stamps files
 * from a coarse clock, a few milliseconds a tick). The app's own restore
 * (`restoreStoreFile`) stamps a fresh mtime.
 *
 * C01-A2 (pass 32): the task and project writers each carried a private copy
 * of this and the goal writer had none — pass-31 gotcha 10 predicted that two
 * back-to-back link-status writes on VirtioFS could lose one. One module now,
 * three callers (the epic writer took the goal writer's place, ruling 503).
 */

/** What a file IS rather than what it holds, as one stat reports it. */
interface FileIdentity {
  ino: number;
  size: number;
  mtimeMs: number;
}

const lastWritten = new Map<string, { content: string; identities: FileIdentity[] }>();
const LAST_WRITTEN_MAX_ENTRIES = 500;

function identityOf(absPath: string): FileIdentity | null {
  try {
    const { ino, size, mtimeMs } = statSync(absPath);
    return { ino, size, mtimeMs };
  } catch {
    return null;
  }
}

function sameFile(a: FileIdentity, b: FileIdentity): boolean {
  return a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

/**
 * Write a canonical file through `writeFileAtomic` and remember the write, so
 * a stale read of it can be repaired (see above).
 */
export function writeAndRemember(absPath: string, content: string): void {
  const replaced = identityOf(absPath);
  writeFileAtomic(absPath, content);
  const written = identityOf(absPath);
  if (lastWritten.size >= LAST_WRITTEN_MAX_ENTRIES && !lastWritten.has(absPath)) {
    // Crude bound: drop the oldest entry (Map preserves insertion order).
    const oldest = lastWritten.keys().next().value;
    if (oldest !== undefined) lastWritten.delete(oldest);
  }
  lastWritten.delete(absPath); // re-insert at the tail (freshest last)
  const identities = [written, replaced].filter((id): id is FileIdentity => id !== null);
  lastWritten.set(absPath, { content, identities });
}

/**
 * The freshest content for a locked read: `diskContent`, unless it is provably
 * a stale view of our own earlier write — the path still shows the file that
 * write put there or the one it replaced — then that write. `describe` names
 * the file for the warn line (the caller knows its kind and key).
 */
export function freshestContent(
  absPath: string,
  diskContent: string,
  describe: { kind: string; id: string },
): string {
  const remembered = lastWritten.get(absPath);
  if (!remembered || diskContent === remembered.content) return diskContent;
  const onDisk = identityOf(absPath);
  if (!onDisk || !remembered.identities.some((known) => sameFile(known, onDisk))) {
    return diskContent;
  }
  logger.warn(`stale ${describe.kind} read repaired from the in-process write cache`, {
    [describe.kind === "task-file" ? "taskKey" : describe.kind === "project-file" ? "projectSlug" : "epicId"]:
      describe.id,
    absPath,
  });
  return remembered.content;
}
