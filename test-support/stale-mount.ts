import { linkSync, renameSync } from "node:fs";

/**
 * The view a stale cached mount (Docker Desktop's VirtioFS, VIB-1) hands a
 * reader after a write: the path still names the file that write replaced,
 * with its old bytes and its old stamp. Call this before the write; `serve()`
 * after it puts that file back at the path.
 *
 * A hard link keeps the old inode alive across the write's rename, and
 * renaming it back changes neither its inode number, its size nor its mtime,
 * so the path shows exactly the file the write replaced (ruling 513).
 */
export function staleViewOf(absPath: string) {
  const kept = `${absPath}.stale-view`;
  linkSync(absPath, kept);
  return {
    serve() {
      renameSync(kept, absPath);
    },
  };
}
