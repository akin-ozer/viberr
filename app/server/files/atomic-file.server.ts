import { randomBytes } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Atomic file write: write to a sibling `*.tmp` file, then rename over the
 * target. Readers and the file watcher never observe a half-written
 * file; the watcher explicitly ignores `*.tmp`.
 */
export function writeFileAtomic(absPath: string, content: string): void {
  mkdirSync(path.dirname(absPath), { recursive: true });
  const tmpPath = `${absPath}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmpPath, content, "utf8");
    renameSync(tmpPath, absPath);
  } catch (error) {
    // Gap 16: a failed write used to leak its staging file into the store
    // forever — the watcher ignores `*.tmp` and nothing sweeps them, so a full
    // volume left permanent litter behind every failed write. Clean up first,
    // then name the one cause an operator can act on: ENOSPC during a task-file
    // write is the corruption scenario this store cannot afford, so it gets a
    // sentence instead of a bare errno.
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      // Already gone, or the volume will not even allow the unlink — either way
      // the original error below is the useful one.
    }
    if ((error as NodeJS.ErrnoException).code === "ENOSPC") {
      throw new Error(
        `No space left on the data root — ${absPath} was not written`,
        { cause: error },
      );
    }
    throw error;
  }
}
