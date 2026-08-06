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
 * F19-8 / F19-13 — the board's archived contract, and one vocabulary across both
 * views.
 *
 * Under the "Archived" filter the board rendered archived tasks through the
 * ordinary card: live readiness, live validation, "waiting on a human", a drag
 * handle and a working Move menu — directly beneath a banner calling the work
 * abandoned and out of the review queue. UXO-1 had removed exactly those pills
 * from the task hero one commit earlier, for exactly this reason: an archived
 * task owes nobody a verdict. The list row carried the same defect and, on top
 * of it, silently dropped the PR-state pills the card draws (H10 re-opened in
 * one of two views).
 */
describe("F19-8: an archived task states that it is archived, and nothing else", () => {
  const archived = () =>
    task({
      archived: true,
      displayReadiness: "ready",
      validation: "healthy",
      waiting: "human",
    });

  it("replaces the live readiness/validation/wait signals on the card", () => {
    const { container } = renderBoard([archived()], {
      search: "filter=archived",
    });
    // Scope to the card: the board SUBTITLE legitimately says "0 ready", and a
    // page-wide text query would match that instead of the card's pills.
    const card = container.querySelector(".card")!;
    expect(card).toBeTruthy();
    expect(card.textContent).toContain("archived");
    expect(card.textContent).not.toContain("ready");
    expect(card.textContent).not.toContain("healthy");
    expect(card.textContent).not.toMatch(/waiting on a human/i);
  });

  it("offers no Move control on an archived card, even to a viewer who can move tasks", () => {
    const { queryByLabelText } = renderBoard([archived()], {
      search: "filter=archived",
      canTransition: true,
    });
    expect(queryByLabelText(/change stage/i)).toBeNull();
  });

  it("keeps the Move control on a LIVE card — the gate is `archived`, not the filter", () => {
    const { getByLabelText } = renderBoard([task()], { canTransition: true });
    expect(getByLabelText(/change stage/i)).toBeTruthy();
  });

  it("applies the same contract to the list row", () => {
    const { container } = renderBoard([archived()], {
      view: "list",
      search: "filter=archived",
    });
    const row = container.querySelector(".list-row")!;
    expect(row).toBeTruthy();
    expect(row.textContent).toContain("archived");
    expect(row.textContent).not.toContain("ready");
    expect(row.textContent).not.toContain("healthy");
  });
});

describe("F19-13: the list row draws the PR-state pills the card draws", () => {
  it("names a merge-pending PR in the list view too", () => {
    const { getByText } = renderBoard(
      [task({ pr: { number: 124, state: "accepted", title: "Attach a credential" } })],
      { view: "list" },
    );
    expect(getByText("merge pending")).toBeTruthy();
  });

  it("names a closed PR in the list view too", () => {
    const { getByText } = renderBoard(
      [task({ pr: { number: 124, state: "closed", title: "Attach a credential" } })],
      { view: "list" },
    );
    expect(getByText("closed")).toBeTruthy();
  });
});
