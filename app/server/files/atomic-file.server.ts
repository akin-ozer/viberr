import { randomBytes } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { AppError } from "~/server/errors/app-error.server";
import { ERROR_CODES } from "~/server/errors/error-codes";

/** Node hangs its errno off `code`; anything else thrown by a write carries
 *  none, and a non-string `code` is not an errno we branch on. */
const errnoSchema = z.object({
  code: z.string().optional().catch(undefined),
});

/** The four node:fs calls the atomic write performs — injectable (`fsImpl`)
 *  so the failure classes this module translates (ENOSPC, ESTALE, EIO) are
 *  testable without a volume that can actually produce them. */
export interface AtomicFileFsOps {
  mkdirSync: (dir: string, options: { recursive: true }) => string | undefined;
  writeFileSync: (file: string, data: string, encoding: "utf8") => void;
  renameSync: (oldPath: string, newPath: string) => void;
  rmSync: (target: string, options: { force: true }) => void;
}

const REAL_FS: AtomicFileFsOps = { mkdirSync, writeFileSync, renameSync, rmSync };

/**
 * Atomic file write: write to a sibling `*.tmp` file, then rename over the
 * target. Readers and the file watcher never observe a half-written
 * file; the watcher explicitly ignores `*.tmp`.
 */
export function writeFileAtomic(
  absPath: string,
  content: string,
  opts: { fsImpl?: AtomicFileFsOps } = {},
): void {
  const fs = opts.fsImpl ?? REAL_FS;
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  const tmpPath = `${absPath}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tmpPath, content, "utf8");
    fs.renameSync(tmpPath, absPath);
  } catch (error) {
    // Gap 16: a failed write used to leak its staging file into the store
    // forever — the watcher ignores `*.tmp` and nothing sweeps them, so a full
    // volume left permanent litter behind every failed write. Clean up first,
    // then name the one cause an operator can act on: ENOSPC during a task-file
    // write is the corruption scenario this store cannot afford, so it gets a
    // sentence instead of a bare errno.
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // Already gone, or the volume will not even allow the unlink — either way
      // the original error below is the useful one.
    }
    const errno = errnoSchema.safeParse(error);
    const code = errno.success ? errno.data.code : undefined;
    if (code === "ENOSPC") {
      throw new Error(
        `No space left on the data root — ${absPath} was not written`,
        { cause: error },
      );
    }
    // F20-1: a data-root mount that goes stale under a running container (a
    // deleted VirtioFS bind-mount inode) fails writes/renames with ESTALE or
    // EIO. This is the class that took the whole app down — the failing action
    // pegged the event loop rather than erroring. Fail the write with a typed
    // AppError naming the data root as unreachable; never retry or spin. The
    // fix's job is to convert a silent hang into an honest, action-scoped error.
    if (code === "ESTALE" || code === "EIO") {
      throw new AppError({
        code: ERROR_CODES.INTERNAL,
        status: 503,
        message: `${code} writing ${absPath} — data root unreachable`,
        userMessage: `The data root is unreachable (${code}) — ${absPath} was not written. Check that the storage mount is healthy, then try again.`,
        cause: error,
      });
    }
    throw error;
  }
}
