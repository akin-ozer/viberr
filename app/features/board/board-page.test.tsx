// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
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
  opts: {
    view?: "list";
    canTransition?: boolean;
    search?: string;
    /** Server result for the board's own fetchers (reorder / rescan). */
    action?: () => { ok: boolean; toast?: string; error?: string };
  } = {},
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
      ...(opts.action ? { action: opts.action } : {}),
    },
  ]);
  const params = new URLSearchParams(opts.search ?? "");
  if (opts.view === "list") params.set("view", "list");
  const qs = params.toString();
  return render(
    <Stub
      initialEntries={[`/projects/viberr-core/board${qs ? `?${qs}` : ""}`]}
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

describe("P13-D-6: the card and the list row draw validation status (FR24)", () => {
  it("renders the ValidationPill on a card whose validation is failing", () => {
    // Before the fix `grep -c validation board-page.tsx` was 0: a reviewer's
    // request_changes set validation:"failing" and touched nothing the card
    // drew, so a rejected revision looked identical to a healthy one — while
    // the "Needs attention" filter matched on exactly that field.
    const { container } = renderBoard([
      task({ key: "VIB-1", validation: "failing" }),
    ]);
    const card = container.querySelector(".card")!;
    expect(card.textContent).toContain("validation failing");
    expect(card.querySelector(".card-foot .pill.blocked")).toBeTruthy();
  });

  it("stays silent when there is no validation signal at all", () => {
    const { container } = renderBoard([
      task({ key: "VIB-1", validation: "none" }),
    ]);
    expect(container.querySelector(".card")!.textContent).not.toContain(
      "validation",
    );
    expect(container.querySelector(".card")!.textContent).not.toContain(
      "no validation",
    );
  });

  it("renders it in the list row too", () => {
    const { container } = renderBoard(
      [task({ key: "VIB-1", validation: "healthy" })],
      { view: "list" },
    );
    expect(container.querySelector(".card")!.textContent).toContain(
      "validation healthy",
    );
  });

  it("draws the pill for a card the readiness pill reports as ready", () => {
    // The readiness pill cannot stand in: displayReadiness only adds
    // accepted/merged and deriveReadiness folds only parse diagnostics.
    const { container } = renderBoard([
      task({ key: "VIB-1", displayReadiness: "ready", validation: "failing" }),
    ]);
    const card = container.querySelector(".card")!;
    expect(card.querySelector(".pill.ready")!.textContent).toBe("ready");
    expect(card.textContent).toContain("validation failing");
  });
});

describe("P13-D-34: the board empty state names the filter that is hiding tasks", () => {
  it("keeps the bare copy for a genuinely empty column", () => {
    const { container } = renderBoard([task({ key: "VIB-1", stage: "impl" })]);
    const empties = [...container.querySelectorAll(".column .empty")].map(
      (n) => n.textContent,
    );
    // Triage and Done hold nothing at all, with no filter on.
    expect(empties).toEqual(["No tasks", "No tasks"]);
  });

  it("explains a filter that hides every card in the column", () => {
    const { container } = renderBoard(
      [
        task({ key: "VIB-1", stage: "impl", waiting: "none" }),
        task({ key: "VIB-2", stage: "impl", waiting: "none" }),
      ],
      { search: "filter=human" },
    );
    const implEmpty = [...container.querySelectorAll(".column")].find((c) =>
      c.querySelector(".col-head .nm")!.textContent!.includes("In Progress"),
    )!;
    expect(implEmpty.querySelector(".empty")!.textContent).toBe(
      "All 2 tasks here are hidden by the “Waiting on me” filter.",
    );
  });

  it("explains a search, and names both when filter and search are on", () => {
    const { container } = renderBoard([task({ key: "VIB-1", stage: "impl" })], {
      search: "q=zzz",
    });
    const impl = [...container.querySelectorAll(".column")].find((c) =>
      c.querySelector(".col-head .nm")!.textContent!.includes("In Progress"),
    )!;
    expect(impl.querySelector(".empty")!.textContent).toBe(
      "The 1 task here is hidden by the search “zzz”.",
    );

    cleanup();
    const both = renderBoard([task({ key: "VIB-1", stage: "impl" })], {
      search: "filter=risk&q=zzz",
    });
    const implBoth = [...both.container.querySelectorAll(".column")].find((c) =>
      c.querySelector(".col-head .nm")!.textContent!.includes("In Progress"),
    )!;
    expect(implBoth.querySelector(".empty")!.textContent).toBe(
      "The 1 task here is hidden by the “Needs attention” filter and the search “zzz”.",
    );
  });

  it("carries the same copy into the list view", () => {
    const { container } = renderBoard([task({ key: "VIB-1", stage: "impl" })], {
      view: "list",
      search: "q=nothing",
    });
    expect(container.querySelector(".empty")!.textContent).toBe(
      "The 1 task here is hidden by the search “nothing”.",
    );
  });

  it("makes the header count agree with what the columns draw", () => {
    // The header used to print the UNFILTERED total over columns that all said
    // "No tasks".
    const { getByText } = renderBoard(
      [
        task({ key: "VIB-1", stage: "impl", waiting: "human" }),
        task({ key: "VIB-2", stage: "impl", waiting: "none" }),
      ],
      { search: "filter=agent" },
    );
    expect(getByText("0 of 2 tasks · 1 waiting on a human decision")).toBeTruthy();
  });

  it("offers one Clear affordance that resets the filter AND the search", () => {
    const { getByTitle, getByText, queryByText } = renderBoard(
      [task({ key: "VIB-1", stage: "impl" })],
      { search: "filter=risk&q=zzz" },
    );
    const clear = getByTitle(
      "Show every task again — clears the board filter and the search",
    );
    fireEvent.click(clear);
    // Both hiding mechanisms are gone: the card is back and the chip retires.
    expect(getByText("1 task · 0 waiting on a human decision")).toBeTruthy();
    expect(queryByText("Clear")).toBeNull();
  });

  it("hides the Clear chip when nothing is filtered", () => {
    const { queryByText } = renderBoard([task({ key: "VIB-1" })]);
    expect(queryByText("Clear")).toBeNull();
  });
});

describe("P13-D-10: a rejected board action must not render the success tick", () => {
  it("toasts a refused stage transition as an error", async () => {
    // The worst instance of the class: the governed transition is refused, the
    // card snaps back — and the toast said "done" with a green check.
    const { container, getByLabelText, getByRole } = renderBoard(
      [task({ key: "VIB-1", stage: "impl" })],
      {
        action: () => ({
          ok: false as const,
          error: "Review → Done is locked to humans.",
        }),
      },
    );
    fireEvent.click(getByLabelText("Change stage (currently In Progress)"));
    fireEvent.click(getByRole("menuitemradio", { name: "Done" }));
    await waitFor(() =>
      expect(container.querySelector(".toast")).not.toBeNull(),
    );
    const toast = container.querySelector(".toast")!;
    expect(toast.textContent).toContain("Review → Done is locked to humans.");
    expect(toast.getAttribute("data-kind")).toBe("error");
  });

  it("toasts a refused re-scan as an error", async () => {
    const { container, getByText } = renderBoard([task()], {
      action: () => ({ ok: false as const, error: "Maintainer or admin only." }),
    });
    fireEvent.click(getByText("Re-scan"));
    await waitFor(() =>
      expect(
        [...container.querySelectorAll(".toast")].some((t) =>
          t.textContent!.includes("Maintainer or admin only."),
        ),
      ).toBe(true),
    );
    const failure = [...container.querySelectorAll(".toast")].find((t) =>
      t.textContent!.includes("Maintainer or admin only."),
    )!;
    expect(failure.getAttribute("data-kind")).toBe("error");
    // The optimistic "Re-scanning…" toast stays a success-kind progress note.
    const progress = [...container.querySelectorAll(".toast")].find((t) =>
      t.textContent!.includes("Re-scanning"),
    )!;
    expect(progress.getAttribute("data-kind")).toBe("success");
  });

  it("keeps the success tick on an accepted transition", async () => {
    const { container, getByLabelText, getByRole } = renderBoard(
      [task({ key: "VIB-1", stage: "impl" })],
      { action: () => ({ ok: true as const, toast: "VIB-1 moved to Done" }) },
    );
    fireEvent.click(getByLabelText("Change stage (currently In Progress)"));
    fireEvent.click(getByRole("menuitemradio", { name: "Done" }));
    await waitFor(() =>
      expect(container.querySelector(".toast")).not.toBeNull(),
    );
    expect(container.querySelector(".toast")!.getAttribute("data-kind")).toBe(
      "success",
    );
  });
});
