import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { STANDALONE_PAGES, standalonePageLabel, WORKSPACE_NAV } from "./nav";

describe("workspace rail order (A00-9, pass 32)", () => {
  it("is the nine project views in the documented order — and the codebase map says the same", () => {
    // The docs claimed the order lives in nav.ts "with no test pinning it";
    // a reordered rail would silently contradict every screenshot and the
    // codebase map. Pinned here, against the map's own sentence. Ruling 503
    // put Epics after Board: the board's work, grouped.
    expect(WORKSPACE_NAV.map((n) => n.id)).toEqual([
      "board",
      "epics",
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

/**
 * Ruling 145 — which routes carry the app header.
 *
 * The header is mounted once by the `palette-shell` layout and this map is the
 * whole decision, so a route added to that layout gets a header only when it is
 * added here too. Both halves are pinned: the answer per path, and the fact that
 * every path on the list is actually under the layout that renders it.
 */
describe("standalone pages carry the app header (ruling 145)", () => {
  it("answers on the path alone — a tab is not a page", () => {
    // The header names the SURFACE; which tab is open is the tab rail's job
    // (`aria-current`), and the search string never reaches this.
    expect(standalonePageLabel("/org/settings")).toBe("Instance settings");
    expect(standalonePageLabel("/org/settings/")).toBe("Instance settings");
    expect(standalonePageLabel("/insights")).toBe("Insights");
  });

  it("leaves the overlay routes, the controller and the workspace alone", () => {
    // /profile and /notifications render their whole surface inside a
    // showModal() dialog that covers the viewport; /controller carries its own
    // identity header; the workspace has the topbar.
    for (const path of [
      "/profile",
      "/notifications",
      "/controller",
      "/",
      "/projects/viberr-core/settings",
      "/org/settings/audit-export",
    ]) {
      expect(standalonePageLabel(path), path).toBeNull();
    }
  });

  it("only names routes the layout that renders the header actually wraps", () => {
    // A label for a route mounted somewhere else is a header nobody ever sees.
    const root = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      "..",
      "..",
      "..",
    );
    const routes = readFileSync(path.join(root, "app", "routes.ts"), "utf8");
    const layout = routes.slice(
      routes.indexOf('layout("routes/palette-shell.tsx"'),
    );
    const wrapped = layout.slice(0, layout.indexOf("]),"));
    for (const page of STANDALONE_PAGES) {
      expect(wrapped, page.path).toContain(`route("${page.path.slice(1)}"`);
    }
  });
});
