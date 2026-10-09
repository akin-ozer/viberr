// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import type { Route } from "./+types/project.review";
import ReviewView from "./project.review";

/**
 * Interface review 2026-09-24 (writ-3): the queue's "waiting on you" is the
 * board's own answer. Both loaders call `waitingOnViewer` (decisions.server.ts;
 * ruling 11 took the board's columns out of the workspace layout), and the
 * review loader ships the keys as `waitingOnMe`, so the queue and the board
 * cannot disagree about the same task.
 */

afterEach(cleanup);

type Row = Route.ComponentProps["loaderData"]["decisions"][number];

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
  recommendations: 1,
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
  completions: [],
  decisions: [row("VIB-150"), row("VIB-151"), row("VIB-153")],
  stageNames: { review: "Review", terminal: "Done" },
  acceptance: { operatorCanAccept: false, operatorName: "Operator" },
  waitingOnMe: [],
};

function renderReview(waitingOnMe: string[]) {
  // SAFETY: ReviewView reads only `loaderData` (typed in full above); the
  // route-module props it never touches (params, matches) are left out.
  const props = {
    loaderData: { ...LOADER_DATA, waitingOnMe },
  } as Route.ComponentProps;
  const Stub = createRoutesStub([
    { path: "/projects/:slug/review", Component: () => <ReviewView {...props} /> },
  ]);
  return render(<Stub initialEntries={["/projects/viberr-core/review"]} />);
}

const tagOf = (container: HTMLElement, key: string) =>
  [...container.querySelectorAll(".rq-row")]
    .find((r) => r.querySelector(".rq-key")!.textContent === key)!
    .querySelector(".chip.st")!.textContent;

describe("ReviewView: the row tag reads the board's waitingOnMe", () => {
  it("tags exactly the keys the loader says wait on this viewer", async () => {
    const { container } = renderReview(["VIB-150", "VIB-153"]);
    await waitFor(() =>
      expect(container.querySelectorAll(".rq-row")).toHaveLength(3),
    );
    expect(tagOf(container, "VIB-150")).toContain("waiting on you");
    expect(tagOf(container, "VIB-151")).toContain("waiting on a human");
    expect(tagOf(container, "VIB-153")).toContain("waiting on you");
  });
});
