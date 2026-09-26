import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Ruling 301 counts the SSE streams a visible page holds against HTTP/1.1's
 * six connections per origin. Ruling 457 (TASK-6 / LIVE-5) took the task page
 * from two streams to one: the run console reads its frames off the layout's
 * stream (`onLiveFrame`) instead of opening its own. Every stream is the
 * live-updates hook's, so exactly one module may open an EventSource.
 */
const root = process.cwd();

describe("one module opens an EventSource (ruling 457)", () => {
  it("finds exactly one non-test module under app/ that calls `new EventSource(`", () => {
    const openers = readdirSync(path.join(root, "app"), { recursive: true })
      .map(String)
      .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
      .filter((f) => readFileSync(path.join(root, "app", f), "utf8").includes("new EventSource("));
    expect(openers, openers.join(", ")).toHaveLength(1);
  });
});
