// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
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
    // F19-27: the projected stage gate. "In Progress" is the stage with the
    // edge into Done in STAGES above, so the default card really is at the
    // boundary — an off-boundary case sets this false alongside its stage.
    atAcceptanceBoundary: true,
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

/** The board subtitle as ONE string. WL-04 gave the stat a scope clause and JSX
 *  wraps the sentence, so it spans several text nodes and `getByText` can't see
 *  it whole. */
function subtitle(container: HTMLElement): string {
  return container.querySelector(".board-head .sub")!.textContent!.replace(/\s+/g, " ").trim();
}

describe("LV-20 family: the board subtitle counts what the projection says", () => {
  it("does not count a done task whose projected waiting is none", () => {
    const { container } = renderBoard([
      task({ key: "VIB-1", stage: "done", waiting: "none" }),
      task({ key: "VIB-2", stage: "impl", waiting: "human" }),
    ]);
    // WL-04: the stat now names its scope ("…in this project"), and JSX line
    // wrapping splits the sentence across text nodes — match the whole line.
    expect(subtitle(container)).toBe(
      "2 tasks · 1 waiting on a human decision in this project",
    );
  });
});

describe("P13-D-6: the card and the list row draw validation status (FR24)", () => {
  it("renders the ValidationPill on a card whose validation is failing", () => {
    // Before the fix `grep -c validation board-page.tsx` was 0: a reviewer's
    // request_changes set validation:"failing" and touched nothing the card
    // drew, so a rejected revision looked identical to a healthy one — while
    // the "Blocked or waiting" filter matched on exactly that field.
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
      "The 1 task here is hidden by the “Blocked or waiting” filter and the search “zzz”.",
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
    const { container } = renderBoard(
      [
        task({ key: "VIB-1", stage: "impl", waiting: "human" }),
        task({ key: "VIB-2", stage: "impl", waiting: "none" }),
      ],
      { search: "filter=agent" },
    );
    expect(subtitle(container)).toBe(
      "0 of 2 tasks · 1 waiting on a human decision in this project",
    );
  });

  it("offers one Clear affordance that resets the filter AND the search", () => {
    const { container, getByTitle, queryByText } = renderBoard(
      [task({ key: "VIB-1", stage: "impl" })],
      { search: "filter=risk&q=zzz" },
    );
    const clear = getByTitle(
      "Show every task again — clears the board filter and the search",
    );
    fireEvent.click(clear);
    // Both hiding mechanisms are gone: the card is back and the chip retires.
    expect(subtitle(container)).toBe(
      "1 task · 0 waiting on a human decision in this project",
    );
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
    // B1: a move into the FINAL stage is an acceptance (a real merge attempt),
    // so it now asks first — the request is only sent once confirmed.
    fireEvent.click(getByRole("button", { name: /^Accept → Done$/ }));
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
    fireEvent.click(getByRole("button", { name: /^Accept → Done$/ })); // B1
    await waitFor(() =>
      expect(container.querySelector(".toast")).not.toBeNull(),
    );
    expect(container.querySelector(".toast")!.getAttribute("data-kind")).toBe(
      "success",
    );
  });
});

/**
 * B1 — a board move into the final stage is an ACCEPTANCE: the server routes it
 * through `acceptCompletion`, which attempts a real PR merge. Task detail has
 * always confirmed that; the board committed it straight from the gesture, so
 * the most irreversible action in the product was its most casual one.
 */
describe("B1: accepting from the board asks first", () => {
  it("a move into Done opens a confirm and sends nothing until it is accepted", async () => {
    const submitted: string[] = [];
    const { getByLabelText, getByRole, getByText } = renderBoard(
      [task({ key: "VIB-1", stage: "impl" })],
      {
        action: () => {
          submitted.push("POST");
          return { ok: true as const, toast: "VIB-1 moved to Done" };
        },
      },
    );
    fireEvent.click(getByLabelText("Change stage (currently In Progress)"));
    fireEvent.click(getByRole("menuitemradio", { name: "Done" }));

    // The dialog states the consequence — and NOTHING has been posted yet.
    expect(getByText(/Merging is one-way/)).toBeTruthy();
    expect(submitted).toHaveLength(0);

    fireEvent.click(getByRole("button", { name: /^Accept → Done$/ }));
    await waitFor(() => expect(submitted.length).toBeGreaterThan(0));
  });

  it("cancelling the confirm never posts the acceptance", async () => {
    const submitted: string[] = [];
    const { getByLabelText, getByRole } = renderBoard(
      [task({ key: "VIB-1", stage: "impl" })],
      {
        action: () => {
          submitted.push("POST");
          return { ok: true as const, toast: "moved" };
        },
      },
    );
    fireEvent.click(getByLabelText("Change stage (currently In Progress)"));
    fireEvent.click(getByRole("menuitemradio", { name: "Done" }));
    fireEvent.click(getByRole("button", { name: "Not yet" }));
    await new Promise((r) => setTimeout(r, 50));
    expect(submitted).toHaveLength(0);
  });

  it("a move to a NON-final stage still commits straight from the gesture", async () => {
    const submitted: string[] = [];
    const { getByLabelText, getByRole } = renderBoard(
      [task({ key: "VIB-1", stage: "triage" })],
      {
        action: () => {
          submitted.push("POST");
          return { ok: true as const, toast: "moved" };
        },
      },
    );
    fireEvent.click(getByLabelText("Change stage (currently Triage)"));
    fireEvent.click(getByRole("menuitemradio", { name: "In Progress" }));
    await waitFor(() => expect(submitted.length).toBeGreaterThan(0));
  });
});

describe("F15-09: the 'agent working' badge renders once per card", () => {
  it("keeps the readiness pill in the card top and the wait tag in the foot", () => {
    const { container } = renderBoard([
      task({ waiting: "agent", readiness: "input_required", displayReadiness: "input_required" }),
    ]);
    // Before the fix the card top swapped in a SECOND "agent working" pill for
    // exactly this state, so the card said it twice and dropped the readiness.
    const working = [...container.querySelectorAll(".card .pill, .card .wait-tag")]
      .filter((el) => el.textContent!.trim() === "agent working");
    expect(working).toHaveLength(1);
    expect(container.querySelector(".card-top .pill")!.textContent).toBe(
      "input required",
    );
  });

  it("does the same in the list view", () => {
    const { container } = renderBoard(
      [task({ waiting: "agent", readiness: "input_required", displayReadiness: "input_required" })],
      { view: "list" },
    );
    const working = [...container.querySelectorAll(".pill, .wait-tag")].filter(
      (el) => el.textContent!.trim() === "agent working",
    );
    expect(working).toHaveLength(1);
  });
});

describe("R15-5: the board owns its own filter box", () => {
  it("renders a board-scoped field that writes ?q= (the topbar now opens the palette)", async () => {
    const { getByLabelText, queryByText } = renderBoard([
      task({ key: "VIB-1", title: "Attach a project credential" }),
      task({ key: "VIB-2", title: "Rotate the PAT" }),
    ]);
    const input = getByLabelText("Filter this board") as HTMLInputElement;
    // The placeholder no longer promises a global "tasks, branches, agents"
    // search it never performed.
    expect(input.getAttribute("placeholder")).toBe("Filter this board…");
    fireEvent.change(input, { target: { value: "rotate" } });
    await waitFor(() => expect(queryByText("Attach a project credential")).toBeNull());
    expect(queryByText("Rotate the PAT")).toBeTruthy();
  });
});

/**
 * R16-2 (owner ruling). Live in pass 16, the board drew an amber "input
 * required" chip on a card and its own attention filter matched 0 of 4 tasks —
 * the state the card flagged was the one state the predicate omitted. The chip
 * is renamed to what it selects, and this binds the two: the label on the chip
 * and the tasks that survive the click are asserted in the same test, so a
 * future edit cannot rename one without the other.
 */
describe("R16-2: the attention chip says what it selects", () => {
  const chip = (container: HTMLElement) =>
    [...container.querySelectorAll(".fchip, .chip, button")].find(
      (el) => el.textContent!.trim() === "Blocked or waiting",
    );

  it('is labelled "Blocked or waiting", not "Needs attention"', () => {
    const { container } = renderBoard([task()]);
    expect(chip(container)).toBeTruthy();
    expect(container.textContent).not.toContain("Needs attention");
  });

  it("keeps an input_required card visible under that filter", async () => {
    const { container, queryByText } = renderBoard([
      task({
        key: "VIB-1",
        title: "Waiting on an answer",
        readiness: "input_required",
        displayReadiness: "input_required",
        waiting: "human",
      }),
      task({ key: "VIB-2", title: "Perfectly fine", readiness: "ready" }),
    ]);
    fireEvent.click(chip(container)!);
    await waitFor(() => expect(queryByText("Perfectly fine")).toBeNull());
    expect(queryByText("Waiting on an answer")).toBeTruthy();
  });
});

describe("the new-task dialog does not accuse an untouched form", () => {
  const openDialog = () => {
    const r = renderBoard([task()]);
    const btn = [...r.container.querySelectorAll("button")].find((b) =>
      b.textContent!.includes("New task"),
    )!;
    fireEvent.click(btn);
    return r;
  };

  it("offers guidance, not an error, before the title is touched", () => {
    const { container } = openDialog();
    const hint = container.querySelector(".foot-hint")!;
    expect(hint.textContent).toBe("The task key is assigned on create.");
    expect(hint.className).not.toContain("err");
  });

  it("states the requirement once the field is left empty", () => {
    const { container } = openDialog();
    fireEvent.blur(container.querySelector("#new-task-title")!);
    const hint = container.querySelector(".foot-hint")!;
    expect(hint.textContent).toBe("A title is required.");
    expect(hint.className).toContain("err");
  });

  it("clears the error once a valid title is typed", () => {
    const { container } = openDialog();
    const input = container.querySelector("#new-task-title")!;
    fireEvent.blur(input);
    fireEvent.change(input, { target: { value: "A real title" } });
    const hint = container.querySelector(".foot-hint")!;
    expect(hint.textContent).toBe("The task key is assigned on create.");
    expect(hint.className).not.toContain("err");
  });
});

describe("R16-6: the card says when Done still needs a human", () => {
  // Owner ruling 2026-08-04: `merge-pull-request` stays human-only, so a
  // full-autonomy task reaches the done stage with its PR open. `pr.state`
  // already carries that as "accepted" ("a human accepted the completion but
  // the real merge is still pending") — the card just never drew it, so a
  // merge-pending task and a merged one looked the same.

  it("draws `merge pending` on an accepted-but-unmerged PR", () => {
    const { getByText, queryByText } = renderBoard([
      task({
        stage: "done",
        displayReadiness: "accepted",
        pr: { number: 124, state: "accepted", title: "Attach a credential" },
      }),
    ]);
    expect(getByText("merge pending")).toBeTruthy();
    // The PR chip still names the PR; the pill is the addition, not a swap.
    expect(getByText("#124")).toBeTruthy();
    expect(queryByText("closed")).toBeNull();
  });

  it("draws the shared `closed` pill on a PR closed without merging (H10)", () => {
    const { getByText, queryByText } = renderBoard([
      task({
        pr: { number: 124, state: "closed", title: "Attach a credential" },
      }),
    ]);
    expect(getByText("closed")).toBeTruthy();
    expect(queryByText("merge pending")).toBeNull();
  });

  it("stays silent for a merged PR and for one still under review", () => {
    // Density rule: only ACTIONABLE state earns a pill. The readiness pill and
    // the PR chip already carry these two.
    for (const state of ["merged", "review"] as const) {
      const { queryByText, unmount } = renderBoard([
        task({ pr: { number: 124, state, title: "Attach a credential" } }),
      ]);
      expect(queryByText("merge pending"), state).toBeNull();
      expect(queryByText("closed"), state).toBeNull();
      unmount();
    }
  });
});

/**
 * F19-13 — the two board layouts are one board. The card foot drew the
 * PR-state, failing-checks and changes-requested pills; the list row drew none
 * of them, so a task whose Done still owes a human merge (R16-6 / ruling 40)
 * read "merge pending" under Board and looked finished under List — one toggle
 * apart, same stored state.
 */
describe("F19-13: the list row reads the same state the card does", () => {
  const listRow = (tasks: TaskSummary[]) =>
    renderBoard(tasks, { view: "list" }).container.querySelector(".list-row")!
      .textContent!;

  it("draws `merge pending` on an accepted-but-unmerged PR", () => {
    expect(
      listRow([
        task({
          stage: "done",
          displayReadiness: "accepted",
          pr: { number: 124, state: "accepted", title: "Attach a credential" },
        }),
      ]),
    ).toContain("merge pending");
  });

  it("draws the `closed` pill on a PR closed without merging", () => {
    expect(
      listRow([task({ pr: { number: 124, state: "closed", title: "t" } })]),
    ).toContain("closed");
  });

  it("draws failing checks and a changes-requested review", () => {
    const text = listRow([
      task({
        pr: { number: 124, state: "review", title: "t" },
        prChecks: { total: 3, passing: 2, failing: 1, pending: 0, state: "failing" },
        prReview: "changes_requested",
      }),
    ]);
    expect(text).toContain("1/3 checks failing");
    expect(text).toContain("changes requested");
  });

  it("keeps the same silences — merged and in-review earn no pill in either view", () => {
    for (const view of [undefined, "list"] as const) {
      for (const state of ["merged", "review"] as const) {
        const { queryByText, unmount } = renderBoard(
          [task({ pr: { number: 124, state, title: "t" } })],
          view ? { view } : {},
        );
        expect(queryByText("merge pending"), `${view}/${state}`).toBeNull();
        expect(queryByText("closed"), `${view}/${state}`).toBeNull();
        unmount();
      }
    }
  });
});

/**
 * F19-8 — an ARCHIVED card kept every live control and every live claim under a
 * banner calling the work abandoned: the readiness pill still said someone owed
 * a verdict, the validation pill and wait tag still asserted obligations, and
 * the Move menu still offered to walk the task into Done — where the same click
 * runs the full acceptance contract and a real merge (R18-7). UXO-1 made
 * exactly this cut on the task hero; the board is the surface that shows
 * archived work by name.
 */
describe("F19-8: an archived card is inert and honest", () => {
  const ARCHIVED = "filter=archived";
  const archivedTask = (patch: Partial<TaskSummary> = {}) =>
    task({
      key: "VIB-9",
      title: "Abandoned mid-review",
      stage: "impl",
      archived: true,
      displayReadiness: "ready",
      validation: "changed",
      waiting: "agent",
      urgent: true,
      branch: "VIB-9-abandoned",
      pr: { number: 124, state: "accepted", title: "Abandoned" },
      ...patch,
    } as Partial<TaskSummary>);

  it("says `archived` instead of a readiness anyone owes", () => {
    const { container } = renderBoard([archivedTask()], { search: ARCHIVED });
    const top = container.querySelector(".card-top")!.textContent!;
    expect(top).toContain("archived");
    // The live claims: "ready" (someone will act) and "awaiting verdict"
    // (someone owes a verdict) — nobody does on abandoned work.
    expect(top).not.toMatch(/\bready\b/);
    expect(container.textContent).not.toContain("awaiting verdict");
  });

  it("drops every obligation pill and the wait tag, keeps the traceability chips", () => {
    const { container } = renderBoard([archivedTask()], { search: ARCHIVED });
    const card = container.querySelector(".card")!.textContent!;
    expect(card).not.toContain("merge pending");
    expect(card).not.toContain("awaiting verdict");
    expect(container.querySelector(".wait-tag")).toBeNull();
    // "How far did this get?" stays answerable — the hero keeps its stage pill
    // for the same reason.
    expect(card).toContain("VIB-9");
    expect(card).toContain("#124");
    expect(card).toContain("VIB-9-abandoned");
  });

  it("keeps the urgent/waiting card treatment off an archived card", () => {
    const { container } = renderBoard([archivedTask()], { search: ARCHIVED });
    const card = container.querySelector(".card")!;
    expect(card.classList.contains("urgent")).toBe(false);
    expect(card.classList.contains("wait-human")).toBe(false);
  });

  it("offers no Move control and no drag, even to a maintainer", () => {
    const { container } = renderBoard([archivedTask()], {
      search: ARCHIVED,
      canTransition: true,
    });
    // The keyboard path into Done (an acceptance + real merge, R18-7).
    expect(container.querySelector(".card-move")).toBeNull();
    expect(
      container.querySelector('[aria-label^="Change stage"]'),
    ).toBeNull();
    // The pointer path — the wrapper stops advertising itself as draggable.
    expect(
      container.querySelector(".card-wrap")!.classList.contains("draggable"),
    ).toBe(false);
  });

  it("still lets a live card next to it move", () => {
    // The guard is per-card, not a board-wide freeze.
    const { container } = renderBoard([task({ key: "VIB-1" })]);
    expect(container.querySelector(".card-move")).toBeTruthy();
    expect(
      container.querySelector(".card-wrap")!.classList.contains("draggable"),
    ).toBe(true);
  });

  it("makes the same cut in the list view", () => {
    const { container } = renderBoard([archivedTask()], {
      search: ARCHIVED,
      view: "list",
    });
    const row = container.querySelector(".list-row")!;
    expect(row.textContent).toContain("archived");
    expect(row.textContent).not.toContain("merge pending");
    expect(row.textContent).not.toContain("awaiting verdict");
    expect(container.querySelector(".wait-tag")).toBeNull();
    // The row falls back to the static stage pill, like a viewer who cannot
    // move tasks sees.
    expect(container.querySelector('[aria-label^="Change stage"]')).toBeNull();
    expect(row.textContent).toContain("In Progress");
  });
});

/**
 * F19-27 — the board acceptance confirm received `taskKey` + `stageName` and
 * disclosed neither the PR it merges, the head it merges, nor the verdict it
 * merges over, on a card whose own summary carries all three. Ruling 42 wants
 * the divergence surfaced on "the accept dialog" and R18-7 says this IS an
 * accept dialog — board acceptance runs the identical contract.
 */
describe("F19-27: the board accept confirm discloses what it merges", () => {
  const openConfirm = (patch: Partial<TaskSummary>) => {
    const r = renderBoard([task({ key: "VIB-1", stage: "impl", ...patch })], {
      action: () => ({ ok: true as const, toast: "moved" }),
    });
    fireEvent.click(r.getByLabelText("Change stage (currently In Progress)"));
    fireEvent.click(r.getByRole("menuitemradio", { name: "Done" }));
    return r.container.querySelector("dialog")!.textContent!.replace(/\s+/g, " ");
  };

  it("names the pull request and its state through the one PR-state map", () => {
    expect(
      openConfirm({
        pr: { number: 124, state: "review", title: "Attach a credential" },
      }),
    ).toContain("PR #124 · in review");
  });

  it("warns that commits added since the review merge unreviewed (ruling 42)", () => {
    const text = openConfirm({
      pr: {
        number: 124,
        state: "review",
        title: "Attach a credential",
        revisionDrift: { aheadBy: 2, headSha: "a4c790ce63efbeef" },
      },
    });
    expect(text).toContain("a4c790ce63ef");
    expect(text).toContain("2 commits added since review");
    expect(text).toContain("they merge unreviewed");
  });

  // F19-23: the noun was already switched here; the VERB was not, so a single
  // drifted commit read "1 commit added since review; they merge unreviewed."
  // Assert the whole clause — the old assertion stopped before the bug.
  it("uses the singular for a single added commit, verb included", () => {
    const text = openConfirm({
      pr: {
        number: 124,
        state: "review",
        title: "t",
        revisionDrift: { aheadBy: 1, headSha: "a4c790ce63efbeef" },
      },
    });
    expect(text).toContain("1 commit added since review");
    expect(text).toContain("it merges unreviewed");
    expect(text).not.toContain("they merge unreviewed");
  });

  it("shows the verdict it is about to accept over", () => {
    expect(openConfirm({ validation: "changed" })).toContain("awaiting verdict");
  });

  it("states the standing refusal instead of spending the click on an error", () => {
    expect(
      openConfirm({ blockReason: "No reviewer verdict on the delivered revision." }),
    ).toContain("No reviewer verdict on the delivered revision.");
  });

  it("says so honestly when there is no pull request to merge", () => {
    const text = openConfirm({ pr: null });
    expect(text).toContain("No linked pull request");
    expect(text).not.toContain("PR #");
  });
});

/**
 * F19-27 (residual) — the confirm's "Blocked" row read `task.blockReason` alone
 * and presented it as THE acceptance gate. It is the projected REVISION gate
 * only: `acceptanceBlockReason` (rebuilder.server.ts) names four refusals it
 * deliberately leaves to the reader — archived task, stage boundary, blocked
 * packet, conflicting PR — while the server's `acceptanceRefusalReason`
 * (task-actions.server.ts) enforces all of them on this exact click. Three are
 * answerable from the summary the dialog already holds, so a task with an open
 * blocked decision (or a PR GitHub cannot merge) used to open a confident
 * dialog with no blocked row, and the server refused the click afterwards.
 */
describe("F19-27: the board confirm asks the server's own refusal questions", () => {
  const openConfirm = (patch: Partial<TaskSummary>) => {
    const r = renderBoard([task({ key: "VIB-1", stage: "impl", ...patch })], {
      action: () => ({ ok: true as const, toast: "moved" }),
    });
    fireEvent.click(r.getByLabelText("Change stage (currently In Progress)"));
    fireEvent.click(r.getByRole("menuitemradio", { name: "Done" }));
    return r.container.querySelector("dialog")!.textContent!.replace(/\s+/g, " ");
  };

  const blockedPacket = {
    type: "blocked" as const,
    kind: "Blocked decision",
    from: "Operator",
    title: "Credential missing",
    body: "",
    observations: [],
    options: [],
  };

  it("names an open blocked decision the server refuses on", () => {
    // Same predicate the acceptance writers pass as `blockedPacket`, and the
    // same sentence the task page shows for it.
    expect(
      openConfirm({
        readiness: "blocked",
        packet: blockedPacket,
        blockReason: null,
      }),
    ).toContain("An open blocked decision is holding this task.");
  });

  it("leaves an INPUT packet alone — only a blocked one gates acceptance", () => {
    expect(
      openConfirm({
        readiness: "input_required",
        packet: { ...blockedPacket, type: "input", kind: "Completion report" },
        blockReason: null,
      }),
    ).not.toContain("blocked decision");
  });

  it("names a conflicting PR through the server's own predicate", () => {
    const text = openConfirm({
      blockReason: null,
      pr: {
        number: 124,
        state: "review",
        title: "Attach a credential",
        mergeable: "conflicting",
      },
    });
    expect(text).toContain("conflicts with the base branch");
    expect(text).toContain("Rebase the branch and re-review");
  });

  it("stays silent on a PR that merges cleanly", () => {
    expect(
      openConfirm({
        blockReason: null,
        pr: {
          number: 124,
          state: "review",
          title: "t",
          mergeable: "clean",
        },
      }),
    ).not.toContain("conflicts with the base branch");
  });

  it("keeps the server's precedence — the revision gate speaks first", () => {
    const text = openConfirm({
      blockReason: "VIB-1's delivered revision has no approving verdict yet.",
      readiness: "blocked",
      packet: blockedPacket,
      pr: { number: 124, state: "review", title: "t", mergeable: "conflicting" },
    });
    expect(text).toContain("no approving verdict yet");
    expect(text).not.toContain("blocked decision");
    expect(text).not.toContain("conflicts with the base branch");
  });

});

/**
 * The Triage → Done drag. The board's own StageMenu offers it, the server
 * refuses it (`acceptanceStageBlockedReason`, task-actions.server.ts) — and the
 * dialog in between used to show no blocked row at all, because the gate turns
 * on the PROJECT's workflow graph and nothing on the card carried it. The
 * summary carries `atAcceptanceBoundary` now (shared/mapping/task.server.ts),
 * derived server-side through the same `resolveStageRoles` the writers gate on.
 */
describe("F19-27: the confirm names the stage gate the server will refuse on", () => {
  const fromTriage = (patch: Partial<TaskSummary> = {}) => {
    const r = renderBoard([task({ key: "VIB-1", stage: "triage", ...patch })], {
      action: () => ({ ok: true as const, toast: "moved" }),
    });
    fireEvent.click(r.getByLabelText("Change stage (currently Triage)"));
    fireEvent.click(r.getByRole("menuitemradio", { name: "Done" }));
    return r.container.querySelector("dialog")!.textContent!.replace(/\s+/g, " ");
  };

  const fromBoundary = (patch: Partial<TaskSummary> = {}) => {
    const r = renderBoard([task({ key: "VIB-1", stage: "impl", ...patch })], {
      action: () => ({ ok: true as const, toast: "moved" }),
    });
    fireEvent.click(r.getByLabelText("Change stage (currently In Progress)"));
    fireEvent.click(r.getByRole("menuitemradio", { name: "Done" }));
    return r.container.querySelector("dialog")!.textContent!.replace(/\s+/g, " ");
  };

  it("still names the stage the card is leaving in the head sentence", () => {
    const text = fromTriage({ atAcceptanceBoundary: false });
    expect(text).toContain("Moving VIB-1 from Triage into Done");
    // The one-way warning the whole dialog exists for stays put.
    expect(text).toContain("Merging is one-way");
  });

  it("blocks an off-boundary accept and says which stage the task is at", () => {
    const text = fromTriage({ atAcceptanceBoundary: false });
    expect(text).toContain("Blocked");
    expect(text).toContain(
      "VIB-1 is at Triage, not the boundary the workflow puts before Done",
    );
    expect(text).toContain("Move the task through the workflow first.");
  });

  it("leaves a boundary accept unblocked — the graph really allows that edge", () => {
    const text = fromBoundary();
    expect(text).not.toContain("the boundary the workflow puts before");
    expect(text).not.toContain("Blocked");
  });

  /**
   * The flag is the GRAPH's answer, not the column order's: a project whose
   * workflow declares triage → done really can be accepted from Triage, and
   * refusing it here would be the forked mapping rulings 12/14 ban.
   */
  it("trusts the projected flag over the card's column position", () => {
    expect(fromTriage({ atAcceptanceBoundary: true })).not.toContain(
      "the boundary the workflow puts before",
    );
  });

  it("keeps R16-3's precedence — a closed PR outranks the stage gate", () => {
    // The server names the terminal GitHub fact first; running the workflow is
    // not the path when the PR is gone.
    const text = fromTriage({
      atAcceptanceBoundary: false,
      pr: { number: 124, state: "closed", title: "t" },
    });
    expect(text).toContain("closed on GitHub without merging");
    expect(text).not.toContain("the boundary the workflow puts before");
  });

  it("keeps the stage gate above the revision gate, like the server", () => {
    const text = fromTriage({
      atAcceptanceBoundary: false,
      blockReason: "VIB-1's delivered revision has no approving verdict yet.",
    });
    expect(text).toContain("the boundary the workflow puts before Done");
    expect(text).not.toContain("no approving verdict yet");
  });
});

/**
 * A board whose payload CHANGES under a pending gesture — the revalidation the
 * static `renderBoard` helper cannot express. The confirm resolves its task
 * from the CURRENT payload on every render (F19-27), which is what keeps the
 * disclosed PR head fresh; this is the harness for what happens when that
 * lookup misses.
 */
function renderMutableBoard(
  initial: TaskSummary[],
  opts: { action?: () => { ok: boolean; toast?: string; error?: string } } = {},
) {
  let set!: (next: TaskSummary[]) => void;
  const Stub = createRoutesStub([
    {
      path: "/projects/:slug/board",
      Component: () => {
        const [tasks, setTasks] = useState(initial);
        set = setTasks;
        return (
          <ToastProvider>
            <BoardPage
              columns={columns(tasks)}
              orphanTasks={[]}
              canCreate
              canTransition
              canRescan
            />
          </ToastProvider>
        );
      },
      ...(opts.action ? { action: opts.action } : {}),
    },
  ]);
  const r = render(<Stub initialEntries={["/projects/viberr-core/board"]} />);
  return {
    ...r,
    /** The revalidation: hand the board a different task payload. */
    reproject: (next: TaskSummary[]) => act(() => set(next)),
  };
}

/**
 * F19-27 (residual, LOW) — resolving the pending task late costs one failure
 * mode: if the task leaves the payload between the gesture and the render
 * (archived elsewhere, file deleted, reprojected away), the dialog rendered
 * nothing while `pendingAccept` stayed set. No dialog, no toast, no cancel —
 * the human's drag vanished and the state stayed wedged.
 */
describe("F19-27: a pending acceptance is never stranded", () => {
  const live = task({ key: "VIB-1", stage: "impl" });

  const openConfirm = (r: ReturnType<typeof renderMutableBoard>) => {
    fireEvent.click(r.getByLabelText("Change stage (currently In Progress)"));
    fireEvent.click(r.getByRole("menuitemradio", { name: "Done" }));
    expect(r.container.querySelector("dialog")).not.toBeNull();
  };

  it("says so when the task leaves the board mid-gesture", async () => {
    const r = renderMutableBoard([live]);
    openConfirm(r);
    r.reproject([]);

    expect(r.container.querySelector("dialog")).toBeNull();
    await waitFor(() =>
      expect(r.container.querySelector(".toast")).not.toBeNull(),
    );
    const toast = r.container.querySelector(".toast")!;
    expect(toast.textContent).toContain(
      "VIB-1 left the board before its acceptance was confirmed",
    );
    expect(toast.getAttribute("data-kind")).toBe("error");
  });

  it("really clears the pending state — the dialog does not come back", async () => {
    // The proof the gesture was ABANDONED and not merely hidden: put the task
    // back. A still-set `pendingAccept` would re-render the confirm from a
    // gesture the human made minutes ago.
    const r = renderMutableBoard([live]);
    openConfirm(r);
    r.reproject([]);
    r.reproject([live]);
    expect(r.container.querySelector("dialog")).toBeNull();
    expect(r.getByLabelText("Change stage (currently In Progress)")).toBeTruthy();
  });

  it("posts nothing — an abandoned gesture is not an acceptance", async () => {
    const submitted: string[] = [];
    const r = renderMutableBoard([live], {
      action: () => {
        submitted.push("POST");
        return { ok: true as const, toast: "moved" };
      },
    });
    openConfirm(r);
    r.reproject([]);
    await new Promise((res) => setTimeout(res, 50));
    expect(submitted).toHaveLength(0);
  });

  it("keeps the dialog open and re-reads it when the task merely CHANGES", async () => {
    // The other half of the fresh lookup: the task is still there, so the
    // gesture stands — and the dialog now discloses the archived refusal the
    // server would answer with (`archivedTaskBlockedReason`, the same function
    // `acceptanceRefusalReason` calls).
    const r = renderMutableBoard([live]);
    openConfirm(r);
    r.reproject([{ ...live, archived: true }]);
    const dialog = r.container.querySelector("dialog");
    expect(dialog).not.toBeNull();
    expect(dialog!.textContent!.replace(/\s+/g, " ")).toContain(
      "VIB-1 is archived — restore it before accepting the completion.",
    );
  });
});
