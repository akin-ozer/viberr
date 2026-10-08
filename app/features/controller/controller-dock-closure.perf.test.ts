import { describe, expect, it } from "vitest";
import { expectWithinBudget } from "../../../test-support/perf-ratchet";
import { staticModulesOf } from "../../../test-support/static-imports";

/**
 * Ruling 457, FL-1 / CTL-1: root mounts the controller dock on every signed-in
 * page, so whatever the dock imports STATICALLY is in every route's first
 * download, closed or not. The figure is the dock module's static import
 * closure from source (client modules plus npm packages, `import type` and
 * `import()` excluded), read by `test-support/static-imports.ts`, the walk the
 * route package checks use too, so it needs no build;
 * `node scripts/measure-routes.mjs` gives the gzip bytes after one.
 */

describe("the closed controller dock's static import closure (ruling 457, FL-1)", () => {
  it("stays small, because root ships it to every page", () => {
    const closure = staticModulesOf("app/features/controller/controller-dock.tsx");
    expectWithinBudget("controller:closed-dock.static-modules", closure.size);
  });

  it("keeps the markdown pipeline and the run console out of root", () => {
    // CANARY: import `Markdown` in controller-dock.tsx again, or take
    // `NotConnectedNote` from controller-page.tsx, and root carries them.
    const root = staticModulesOf("app/root.tsx");
    const heavy = [
      "npm:react-markdown",
      "npm:remark-gfm",
      "npm:@number-flow/react",
      "ui/markdown.tsx",
      "features/controller/controller-page.tsx",
      "features/controller/controller-dock-panel.tsx",
      "features/runtime/runs-panels.tsx",
      "features/runtime/runs-panels-derive.ts",
      "features/runtime/console-blocks.tsx",
      "features/runtime/use-run-log-stream.ts",
      "features/runtime/run-log-store.ts",
      "features/runtime/console-fold.ts",
    ];
    expect(heavy.filter((id) => root.has(id))).toEqual([]);
  });

  it("walks what the client build ships: root reaches no server module", () => {
    // A walker of this file's own followed server modules, so root's closure
    // held 121 of them and the packages only they import; the route package
    // checks' walk skips them. One walk now answers both.
    const root = [...staticModulesOf("app/root.tsx")];
    expect(root.filter((id) => /^server\/|\.server\.tsx?$/.test(id))).toEqual([]);
    const serverPackages = ["npm:better-auth", "npm:chokidar", "npm:yaml", "npm:@anthropic-ai/claude-agent-sdk"];
    expect(root.filter((id) => serverPackages.includes(id))).toEqual([]);
  });
});
