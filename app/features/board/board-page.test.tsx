// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { ToastProvider } from "~/ui/toast";
import type { TaskSummary } from "~/shared/mapping/task.server";
import type { BoardColumn } from "~/server/projections/board-query.server";
import { BoardPage } from "./board-page";

/**
 * UI-26: `board-page.tsx` (1000+ lines) had no component test at all — only the
 * pure `board-filters.ts` was covered. These pin the pass-13 fixes and give the
 * render path a smoke test.
 */

afterEach(cleanup);

const STAGES = [
  { id: "triage", name: "Triage", color: "#a5a8b5" },
  { id: "impl", name: "In Progress", color: "#7b61ff" },
  { id: "done", name: "Done", color: "#00b473" },
];

function task(patch: Partial<TaskSummary> = {}): TaskSummary {
  return {
    projectSlug: "viberr-core",
    key: "VIB-142",
    title: "Attach a project credential",
    stage: "impl",
    readiness: "on_track",
    displayReadiness: "on_track",
    waiting: "none",
    waitingOnMe: false,
    urgent: false,
    validation: "none",
    blockReason: null,
    owner: null,
    specialist: null,
    reviewers: [],
    operator: null,
    branch: null,
    repo: "akin-ozer/viberr",
    pr: null,
    commits: [],
    changed: null,
    goal: "",
    packet: null,
    recommendationCount: 0,
    eventCount: 0,
    commentCount: 0,
    diagnosticCount: 0,
    createdAt: "2026-07-01T09:00:00.000Z",
    updatedAt: "2026-07-01T09:00:00.000Z",
    boardRank: null,
    filePath: "projects/viberr-core/tasks/VIB-142/task.md",
    ...patch,
  } as TaskSummary;
}

function columns(tasks: TaskSummary[]): BoardColumn[] {
  return STAGES.map((stage) => ({
    stage,
    tasks: tasks.filter((t) => t.stage === stage.id),
  }));
}

function renderBoard(
  tasks: TaskSummary[],
  opts: { view?: "list"; canTransition?: boolean } = {},
) {
  const Stub = createRoutesStub([
    {
      path: "/projects/:slug/board",
      Component: () => (
        <ToastProvider>
          <BoardPage
            columns={columns(tasks)}
            orphanTasks={[]}
            canCreate
            canTransition={opts.canTransition ?? true}
            canRescan
          />
        </ToastProvider>
      ),
    },
  ]);
  return render(
    <Stub
      initialEntries={[
        `/projects/viberr-core/board${opts.view === "list" ? "?view=list" : ""}`,
      ]}
    />,
  );
}

describe("UI-58: the Board/List seg carries its selected state", () => {
  it("marks the active layout with aria-pressed", () => {
    const { getByRole } = renderBoard([task()]);
    const seg = getByRole("group", { name: "Board layout" });
    const buttons = seg.querySelectorAll("button");
    expect(buttons[0]!.getAttribute("aria-pressed")).toBe("true");
    expect(buttons[1]!.getAttribute("aria-pressed")).toBe("false");
  });
});

describe("UI-58: the list view has a keyboard move control", () => {
  it("renders the StageMenu per row when the viewer can move tasks", () => {
    const { container } = renderBoard([task()], { view: "list" });
    // Before the fix ListView rendered a static stage pill and nothing else —
    // drag-and-drop had no keyboard equivalent outside the board layout.
    expect(container.querySelector(".stage-menu-btn, button.stage-static, .own-btn")).toBeTruthy();
  });

  it("falls back to a static pill for a viewer who cannot move tasks", () => {
    const { container } = renderBoard([task()], {
      view: "list",
      canTransition: false,
    });
    expect(container.querySelector(".pill.neutral.sm")!.textContent).toBe(
      "In Progress",
    );
  });
});

describe("LV-20 family: the board subtitle counts what the projection says", () => {
  it("does not count a done task whose projected waiting is none", () => {
    const { getByText } = renderBoard([
      task({ key: "VIB-1", stage: "done", waiting: "none" }),
      task({ key: "VIB-2", stage: "impl", waiting: "human" }),
    ]);
    expect(getByText("2 tasks · 1 waiting on a human decision")).toBeTruthy();
  });
});
