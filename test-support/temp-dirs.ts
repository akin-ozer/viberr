import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

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
 *
 * Whatever no cleanup removed goes when the test file's tests finish, so a
 * file that never calls `cleanup` still leaves nothing in the OS temp folder.
 */
export interface TempDirs {
  /** A fresh `mkdtemp` directory under the OS temp dir, `<prefix>` plus six
   *  random characters. */
  make(prefix: string): string;
  /** Removes every directory `make` returned since the last cleanup. */
  cleanup(): void;
}

/** Every `createTempDirs` this test file made. */
const made: TempDirs[] = [];

// This module loads once per test file, while the file's imports are
// collected, so this is the file's own hook, registered before any the file
// declares; `afterAll` hooks run last-registered first, so it runs after them.
// On 2026-10-02 a full run left 34 `viberr-test-` directories behind, from
// three files that never cleaned their `createTestDbContext`.
afterAll(() => {
  for (const temp of made) temp.cleanup();
});

export function createTempDirs(): TempDirs {
  let dirs: string[] = [];
  const temp: TempDirs = {
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
  made.push(temp);
  return temp;
}
