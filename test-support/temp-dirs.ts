import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Temp directories a test makes, removed together. For a test with no
 * database; `createTestDbContext` keeps its own directories through this too.
 * Usage:
 *   const temp = createTempDirs();
 *   afterAll(temp.cleanup);
 *   const dataRoot = temp.make("viberr-kb-");
 *
 * `afterAll` suits a file whose `describe` bodies make a directory at
 * collection time and share it across their cases; `afterEach` removes a
 * test's directories as soon as it ends.
 */
export interface TempDirs {
  /** A fresh `mkdtemp` directory under the OS temp dir, `<prefix>` plus six
   *  random characters. */
  make(prefix: string): string;
  /** Removes every directory `make` returned since the last cleanup. */
  cleanup(): void;
}

export function createTempDirs(): TempDirs {
  let dirs: string[] = [];
  return {
    make(prefix: string): string {
      const dir = mkdtempSync(path.join(tmpdir(), prefix));
      dirs.push(dir);
      return dir;
    },
    cleanup(): void {
      for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
      dirs = [];
    },
  };
}
