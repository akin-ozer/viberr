import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PERF_BUDGETS } from "../../../test-support/perf-budgets";

/**
 * Ruling 454: the performance ratchet stays honest. A ceiling no test measures
 * would pass forever, so every budget id must be asserted by some
 * `*.perf.test.ts(x)` under app/, every such file must assert at least one
 * budget, and every bundle budget must name a route the build has.
 */
const root = process.cwd();

const perfTests = readdirSync(path.join(root, "app"), { recursive: true })
  .map(String)
  .filter((f) => /\.perf\.test\.tsx?$/.test(f))
  .map((f) => ({ file: f, text: readFileSync(path.join(root, "app", f), "utf8") }));

describe("perf budgets are measured (ruling 454)", () => {
  it("every budget id is asserted by a *.perf.test file", () => {
    const orphans = Object.keys(PERF_BUDGETS).filter(
      (id) => !perfTests.some((t) => t.text.includes(`"${id}"`)),
    );
    expect(orphans).toEqual([]);
  });

  it("every *.perf.test file asserts a budget", () => {
    const idle = perfTests
      .filter((t) => !t.text.includes("expectWithinBudget("))
      .map((t) => t.file);
    expect(idle).toEqual([]);
  });

  it("every *.perf.test file that loads through the server pins the clock", () => {
    // The demo seed dates its events from the wall clock in local time and
    // loaders derive from the hour, so a figure measured on the real clock
    // moves with the time of day and the zone: `writes:comment.sql` read 16
    // before 09:58 and 15 after (test-support/perf-clock.ts).
    const unpinned = perfTests
      .filter((t) => /\b(setupAppTest|runDemoSeed)\(/.test(t.text))
      .filter((t) => !t.text.includes("pinPerfClock()"))
      .map((t) => t.file);
    expect(unpinned).toEqual([]);
  });

  it("every bundle budget names a route module", () => {
    // SAFETY: bundle.json is the committed budget table; the assertions below
    // check the one field this test reads.
    const bundle = JSON.parse(
      readFileSync(path.join(root, "test-support/perf-budgets/bundle.json"), "utf8"),
    ) as Record<string, { unit: string }>;
    const missing = Object.keys(bundle).filter((id) => {
      if (!id.startsWith("bundle:")) return true;
      const target = id.slice("bundle:".length);
      if (target === "root" || target === "root.css") return false;
      return !["tsx", "ts"].some((ext) =>
        existsSync(path.join(root, "app", `${target}.${ext}`)),
      );
    });
    expect(missing).toEqual([]);
    expect(Object.values(bundle).every((b) => b.unit === "bytes")).toBe(true);
  });

  it("the performance page documents the check", () => {
    const doc = readFileSync(path.join(root, "docs/development/performance.md"), "utf8");
    expect(doc).toContain("node scripts/measure-routes.mjs --check");
    expect(doc).toContain("test-support/perf-budgets/");
  });
});
