import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * P32-T20 (pass 32): the suite's per-test budget is a stated number in
 * vitest.config.ts, not the runner's 5 s default — the fs-heavy suites
 * (self-heal, store-check, the route harnesses) flaked on CI's cold disks with
 * no budget declared anywhere. This pins the declaration so a config rewrite
 * cannot silently drop it back to the default.
 */
describe("vitest.config.ts declares the test budget (P32-T20)", () => {
  const config = readFileSync(
    path.join(process.cwd(), "vitest.config.ts"),
    "utf8",
  );

  it("sets testTimeout to 20 s, globally", () => {
    const m = /testTimeout:\s*([\d_]+)/.exec(config);
    expect(m, "testTimeout must be declared").toBeTruthy();
    expect(Number(m![1]!.replace(/_/g, ""))).toBe(20_000);
  });
});
