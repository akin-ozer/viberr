import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WORKSPACE_NAV } from "./nav";

describe("workspace rail order (A00-9, pass 32)", () => {
  it("is the eight project views in the documented order — and the codebase map says the same", () => {
    // The docs claimed the order lives in nav.ts "with no test pinning it";
    // a reordered rail would silently contradict every screenshot and the
    // codebase map. Pinned here, against the map's own sentence.
    expect(WORKSPACE_NAV.map((n) => n.id)).toEqual([
      "board",
      "review",
      "controller",
      "agents",
      "policy",
      "github",
      "activity",
      "settings",
    ]);
    const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "..");
    const map = readFileSync(path.join(root, "docs", "architecture", "codebase-map.md"), "utf8");
    expect(map).toContain(
      `\`nav.ts\` order: ${WORKSPACE_NAV.map((n) => n.label).join(", ")}`,
    );
  });
});
