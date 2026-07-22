import { randomBytes } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Atomic file write: write to a sibling `*.tmp` file, then rename over the
 * target. Readers and the file watcher never observe a half-written
 * file; the watcher explicitly ignores `*.tmp`.
 */
export function writeFileAtomic(absPath: string, content: string): void {
  mkdirSync(path.dirname(absPath), { recursive: true });
  const tmpPath = `${absPath}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmpPath, content, "utf8");
  renameSync(tmpPath, absPath);
}
