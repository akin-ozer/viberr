import path from "node:path";
import { DATA_ROOT_LOCK_FILENAME } from "~/server/db/data-root-lock.server";

/** Where the single-writer lock (B-FD1) sits under `dataRoot`: `state/`. */
export function lockPath(dataRoot: string): string {
  return path.join(dataRoot, "state", DATA_ROOT_LOCK_FILENAME);
}
