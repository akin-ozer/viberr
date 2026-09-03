import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DOCK_SELF_STREAM_ROUTE_IDS,
  dockContextFromMatches,
  dockScopeKey,
  dockViewUrl,
  type DockRouteMatch,
} from "./controller-dock-context";

/**
 * Ruling 121 — where the dock thinks the person is standing, from the
 * matched routes alone.
 */

const root = { id: "root", params: {} };
function workspace(slug: string): DockRouteMatch {
  return { id: "routes/project", params: { slug } };
}

describe("dockContextFromMatches", () => {
  it("is instance scope on Home and the top-level pages", () => {
    for (const id of ["routes/_index", "routes/insights", "routes/org.settings"]) {
      const ctx = dockContextFromMatches([root, { id, params: {} }], { pathname: "/x", search: "" });
      expect(ctx).toMatchObject({
        hidden: false,
        projectSlug: null,
        taskKey: null,
        projectName: null,
        surface: "/x",
        key: "|",
      });
    }
  });

  /**
   * Review finding 5: /profile and /notifications render their whole page
   * inside a showModal() PageOverlay, which makes everything outside the
   * dialog inert — the dock painted there as a dimmed button that could not be
   * clicked, and a click on it closed the overlay.
   */
  it("stays off the two page-as-overlay routes", () => {
    for (const id of ["routes/profile", "routes/notifications"]) {
      expect(
        dockContextFromMatches([root, { id, params: {} }], { pathname: "/x", search: "" }).hidden,
      ).toBe(true);
    }
  });

  /**
   * Review finding 24: everywhere else already subscribes to the `user` scope,
   * so a second stream would only duplicate revalidations. This asserts the
   * list against the modules that really call the hook, so a surface that
   * gains or loses its own stream cannot leave the list stale.
   */
  it("asks for its own stream only where no ancestor already streams", () => {
    const insights = dockContextFromMatches([root, { id: "routes/insights", params: {} }], {
      pathname: "/insights",
      search: "",
    });
    expect(insights.needsOwnStream).toBe(true);
    for (const id of ["routes/_index", "routes/org.settings"]) {
      expect(
        dockContextFromMatches([root, { id, params: {} }], { pathname: "/x", search: "" })
          .needsOwnStream,
      ).toBe(false);
    }
    expect(
      dockContextFromMatches([root, workspace("viberr"), { id: "routes/project.board", params: { slug: "viberr" } }], {
        pathname: "/projects/viberr/board",
        search: "",
      }).needsOwnStream,
    ).toBe(false);

    // …and the claim behind the list: those modules mount the hook, /insights
    // does not.
    const read = (rel: string) =>
      readFileSync(path.join(import.meta.dirname, "..", "..", rel), "utf8");
    expect(read("routes/_index.tsx")).toContain("useLiveUpdates");
    expect(read("routes/project.tsx")).toContain("useLiveUpdates");
    expect(read("features/org-settings/org-settings-page.tsx")).toContain("useLiveUpdates");
    expect(read("routes/insights.tsx")).not.toContain("useLiveUpdates");
    expect(DOCK_SELF_STREAM_ROUTE_IDS).toEqual(["routes/insights"]);
  });

  /** Review finding 17: the trigger is named the same before and after the
   *  first open, because the workspace loader already carries the name. */
  it("carries the project's display name when the workspace loader has one", () => {
    const matches = [
      root,
      workspace("viberr"),
      { id: "routes/project.board", params: { slug: "viberr" } },
    ];
    const at = { pathname: "/projects/viberr/board", search: "" };
    expect(dockContextFromMatches(matches, at, "Viberr Core").projectName).toBe("Viberr Core");
    // No name yet (SSR before the payload, or an unrecognized shape): the
    // caller falls back to the slug rather than rendering nothing.
    expect(dockContextFromMatches(matches, at).projectName).toBeNull();
    // A name without a bound project is meaningless and is dropped.
    expect(
      dockContextFromMatches([root, { id: "routes/_index", params: {} }], { pathname: "/", search: "" }, "Stray")
        .projectName,
    ).toBeNull();
  });

  it("hides on the two controller pages and the login page", () => {
    expect(dockContextFromMatches([root, { id: "routes/controller", params: {} }], { pathname: "/controller", search: "" }).hidden).toBe(true);
    expect(
      dockContextFromMatches(
        [root, workspace("viberr"), { id: "routes/project.controller", params: { slug: "viberr" } }],
        { pathname: "/projects/viberr/controller", search: "" },
      ).hidden,
    ).toBe(true);
    expect(dockContextFromMatches([root, { id: "routes/login", params: {} }], { pathname: "/login", search: "" }).hidden).toBe(true);
  });

  it("never takes a task key without its workspace match", () => {
    const ctx = dockContextFromMatches(
      [root, { id: "routes/project.task", params: { slug: "viberr", key: "VIB-1" } }],
      { pathname: "/projects/viberr/tasks/VIB-1", search: "" },
    );
    expect(ctx.projectSlug).toBeNull();
    expect(ctx.taskKey).toBeNull();
  });
});

describe("dockViewUrl and dockScopeKey", () => {
  it("encode the scope and the selection", () => {
    expect(dockViewUrl({ projectSlug: null, taskKey: null }, null)).toBe("/resources/controller");
    expect(dockViewUrl({ projectSlug: "viberr", taskKey: null }, "new")).toBe("/resources/controller?project=viberr&c=new");
    expect(dockViewUrl({ projectSlug: "viberr", taskKey: "VIB-1" }, "cnv_1")).toBe(
      "/resources/controller?project=viberr&task=VIB-1&c=cnv_1",
    );
    // A task never rides without its project.
    expect(dockViewUrl({ projectSlug: null, taskKey: "VIB-1" }, null)).toBe("/resources/controller");
    expect(dockScopeKey({ projectSlug: "viberr", taskKey: "VIB-1" })).toBe("viberr|VIB-1");
  });
});
