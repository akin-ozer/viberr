import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Ruling 301's diagnosis, as the operations pages state it, counts the SSE
 * streams a visible page holds against HTTP/1.1's six connections per origin.
 * Ruling 454 (TASK-6 / LIVE-5) took the task page from two streams to one: the
 * run console reads its frames off the layout's stream (`onLiveFrame`) instead
 * of opening its own. The runbook and the deployment page kept saying "two",
 * which sends an operator closing twice the tabs the pool needs.
 */
const root = process.cwd();
const PAGES = ["docs/operations/runbook.md", "docs/operations/deployment.md"];

describe("the operations pages count the SSE streams a page holds (ruling 454)", () => {
  it("one module opens an EventSource: the live-updates hook", () => {
    const openers = readdirSync(path.join(root, "app"), { recursive: true })
      .map(String)
      .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
      .filter((f) => readFileSync(path.join(root, "app", f), "utf8").includes("new EventSource("));
    expect(openers).toEqual([path.join("features", "live-updates", "use-live-updates.ts")]);
  });

  it.each(PAGES)("%s says one stream per page, and names the page with two", (page) => {
    const text = readFileSync(path.join(root, page), "utf8").replace(/\s+/g, " ");
    expect(text.includes("task page holds two SSE streams"), "the pre-454 count").toBe(false);
    expect(
      text.includes("holds at most one SSE stream, except the project controller page"),
      "the one-stream sentence",
    ).toBe(true);
  });
});
