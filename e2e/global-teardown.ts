import { rmSync } from "node:fs";
import path from "node:path";

/** Removes the isolated e2e data root after the run. */
export default function globalTeardown(): void {
  rmSync(path.resolve(import.meta.dirname, ".tmp-data"), {
    recursive: true,
    force: true,
  });
}
