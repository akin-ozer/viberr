import { describe, expect, it } from "vitest";
import { boardHref, workspaceViewFromPathname } from "./nav";

/**
 * P13-D-35 (UX-7): the board's filter, layout and search live ONLY in URL
 * params, and every in-app return path was written as a bare
 * `/projects/:slug/board` — which React Router resolves with an empty `search`.
 * `boardHref` is the one place that decides when carrying the current query
 * string forward is meaningful.
 */

describe("boardHref", () => {
  it("carries the board's own filter/view/search forward", () => {
    expect(
      boardHref("viberr-core", {
        pathname: "/projects/viberr-core/board",
        search: "?filter=risk&view=list&q=auth",
      }),
    ).toBe("/projects/viberr-core/board?filter=risk&view=list&q=auth");
  });

  it("returns the bare path from the board with no params", () => {
    expect(
      boardHref("viberr-core", {
        pathname: "/projects/viberr-core/board",
        search: "",
      }),
    ).toBe("/projects/viberr-core/board");
  });

  it("never pastes a task route's query onto the board link", () => {
    // The warned-against case: `?tab=…` on a task page describes something
    // else entirely and would invent board state the user never chose.
    expect(
      boardHref("viberr-core", {
        pathname: "/projects/viberr-core/tasks/VIB-1",
        search: "?tab=runs",
      }),
    ).toBe("/projects/viberr-core/board");
    // …even though the rail still treats the task view as "inside" Board.
    expect(workspaceViewFromPathname("/projects/viberr-core/tasks/VIB-1")).toBe(
      "board",
    );
  });

  it("never carries ANOTHER project's board query", () => {
    expect(
      boardHref("viberr-core", {
        pathname: "/projects/other/board",
        search: "?filter=agent",
      }),
    ).toBe("/projects/viberr-core/board");
  });

  it("does not carry a non-board workspace view's query", () => {
    expect(
      boardHref("viberr-core", {
        pathname: "/projects/viberr-core/review",
        search: "?q=x",
      }),
    ).toBe("/projects/viberr-core/board");
  });
});
