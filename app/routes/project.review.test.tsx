// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { createRoutesStub, Outlet } from "react-router";
import type { Route } from "./+types/project.review";
import ReviewView from "./project.review";

/**
 * Interface review 2026-09-24 (writ-3): the queue's "waiting on you" is the
 * board's own flag. The route reads it from the workspace layout's loader
 * data (`routes/project`, which annotates every task with `waitingOnMe`), so
 * the queue and the board cannot disagree about the same task.
 */

afterEach(cleanup);

type Row = Route.ComponentProps["loaderData"]["working"][number];

const row = (key: string): Row => ({
  key,
  title: "Human-waiting review task",
  stageName: "Review",
  atAcceptanceBoundary: true,
  priority: "normal",
  labels: [],
  dueDate: null,
  waiting: "human",
  resumesAt: null,
  packet: null,
  goalEditPending: false,
  latestEventText: null,
  pr: null,
  validation: "healthy",
  blockReason: null,
  lastActivityAt: null,
  quiet: false,
  continuity: null,
});

const LOADER_DATA: Route.ComponentProps["loaderData"] = {
  slug: "viberr-core",
  ready: [],
  working: [row("VIB-150"), row("VIB-151"), row("VIB-153")],
  total: 3,
  stageNames: { review: "Review", terminal: "Done" },
  acceptance: { operatorCanAccept: false, operatorName: "Operator" },
};

/** The slice of the workspace layout's loader data `ReviewView` reads. */
interface LayoutSlice {
  board: {
    columns: { tasks: { key: string; waitingOnMe: boolean }[] }[];
    orphanTasks: { key: string; waitingOnMe: boolean }[];
  };
}

function renderReview(layout: LayoutSlice | null) {
  // SAFETY: `ReviewView` destructures `loaderData` and reads nothing else off
  // its props, so the remainder the router supplies at runtime is unobservable.
  const props = { loaderData: LOADER_DATA } as Route.ComponentProps;
  const Stub = createRoutesStub([
    {
      id: "routes/project",
      path: "/projects/:slug",
      loader: () => layout,
      Component: () => <Outlet />,
      children: [
        { path: "review", Component: () => <ReviewView {...props} /> },
      ],
    },
  ]);
  return render(<Stub initialEntries={["/projects/viberr-core/review"]} />);
}

const tagOf = (container: HTMLElement, key: string) =>
  [...container.querySelectorAll(".rq-row")]
    .find((r) => r.querySelector(".rq-key")!.textContent === key)!
    .querySelector(".wait-tag")!.textContent;

describe("ReviewView: the row tag reads the board's waitingOnMe", () => {
  it("tags the tasks the layout flags, from the columns and the orphans alike", async () => {
    const { container } = renderReview({
      board: {
        columns: [
          {
            tasks: [
              { key: "VIB-150", waitingOnMe: true },
              { key: "VIB-151", waitingOnMe: false },
            ],
          },
        ],
        orphanTasks: [{ key: "VIB-153", waitingOnMe: true }],
      },
    });
    await waitFor(() =>
      expect(container.querySelectorAll(".rq-row")).toHaveLength(3),
    );
    expect(tagOf(container, "VIB-150")).toContain("waiting on you");
    expect(tagOf(container, "VIB-151")).toContain("waiting on a human");
    expect(tagOf(container, "VIB-153")).toContain("waiting on you");
  });

  it("claims nothing for the viewer when the layout carries no board", async () => {
    const { container } = renderReview(null);
    await waitFor(() =>
      expect(container.querySelectorAll(".rq-row")).toHaveLength(3),
    );
    for (const key of ["VIB-150", "VIB-151", "VIB-153"]) {
      expect(tagOf(container, key)).toContain("waiting on a human");
    }
  });
});
