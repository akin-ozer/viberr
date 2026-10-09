import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { RouteConfigEntry } from "@react-router/dev/routes";
import routes from "~/routes";
import { standalonePageLabel, WORKSPACE_NAV } from "./nav";

describe("workspace rail order (A00-9, pass 32)", () => {
  it("the codebase map names the rail's views in nav.ts order", () => {
    // The docs claimed the order lives in nav.ts "with no test pinning it";
    // a reordered rail would silently contradict the codebase map. Pinned
    // here, against the map's own sentence; the rendered rail's order is the
    // rail's own test (`shell-components.test.tsx`, ruling 224).
    const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "..");
    const map = readFileSync(path.join(root, "docs", "architecture", "codebase-map.md"), "utf8");
    expect(map).toContain(
      `\`nav.ts\` order: ${WORKSPACE_NAV.map((n) => n.label).join(", ")}`,
    );
  });
});

/**
 * Ruling 294 — which routes carry the app header.
 *
 * The header is mounted once by the `palette-shell` layout and this map is the
 * whole decision, so a route added to that layout gets a header only when it is
 * added here too. Both halves are pinned: the answer per path, and the fact that
 * every route it names is actually under the layout that renders it.
 */
describe("standalone pages carry the app header (ruling 294)", () => {
  it("answers on the path alone — a tab is not a page", () => {
    // The header names the SURFACE; which tab is open is the tab rail's job
    // (`aria-current`), and the search string never reaches this.
    expect(standalonePageLabel("/org/settings")).toBe("Instance settings");
    expect(standalonePageLabel("/org/settings/")).toBe("Instance settings");
    expect(standalonePageLabel("/insights")).toBe("Insights");
  });

  it("leaves the overlay routes and the workspace alone", () => {
    // /profile and /notifications render their whole surface inside a
    // showModal() dialog that covers the viewport; the workspace, the board's
    // own controller page included, has the topbar.
    for (const path of [
      "/profile",
      "/notifications",
      "/projects/viberr-core/controller",
      "/",
      "/projects/viberr-core/settings",
      "/org/settings/audit-export",
    ]) {
      expect(standalonePageLabel(path), path).toBeNull();
    }
  });

  it("only names routes the layout that renders the header actually wraps", () => {
    // A label for a route mounted somewhere else is a header nobody ever sees.
    // Read from the route config the framework builds the app from.
    const pages: { path: string; wrapped: boolean }[] = [];
    const walk = (entries: readonly RouteConfigEntry[], base: string, wrapped: boolean) => {
      for (const entry of entries) {
        const at = entry.path ? `${base}/${entry.path}` : base;
        const under = wrapped || entry.file === "routes/palette-shell.tsx";
        if (entry.path) pages.push({ path: at, wrapped: under });
        walk(entry.children ?? [], at, under);
      }
    };
    walk(routes, "", false);
    const named = pages.filter((page) => standalonePageLabel(page.path) !== null);
    expect(named.map((page) => page.path)).toContain("/org/settings");
    expect(named.filter((page) => !page.wrapped)).toEqual([]);
  });
});
