// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { ToastProvider } from "~/ui/toast";
import { BoardPage, type BoardColumnData, type BoardTask } from "./board-page";

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

function task(patch: Partial<BoardTask> = {}): BoardTask {
  return {
    projectSlug: "viberr-core",
    key: "VIB-142",
    title: "Attach a project credential",
    stage: "impl",
    // C12: a canonical readiness value. This fixture used the non-enum
    // "on_track", which rode the ReadinessPill's old `ready` fallback; the
    // fallback is now a neutral "unknown" pill (never green "ready"), so the
    // default card must carry a real value to render a real readiness chip.
    readiness: "ready",
    displayReadiness: "ready",
    waiting: "none",
    waitingOnMe: false,
    urgent: false,
    priority: "normal",
    labels: [],
    dueDate: null,
    archived: false,
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
    prChecks: null,
    prReview: null,
    commits: [],
    changed: null,
    goal: "",
    packet: null,
    eventCount: 0,
    commentCount: 0,
    diagnosticCount: 0,
    createdAt: "2026-07-01T09:00:00.000Z",
    updatedAt: "2026-07-01T09:00:00.000Z",
    boardRank: null,
    filePath: "projects/viberr-core/tasks/VIB-142/task.md",
    // Gap-10: `listProjectTasks` annotates every summary with these two.
    lastActivityAt: null,
    quiet: false,
    // D4: projected runtime-continuity fact (null = healthy).
    continuity: null,
    ...patch,
  };
}

function columns(tasks: BoardTask[]): BoardColumnData[] {
  return STAGES.map((stage) => ({
    stage,
    tasks: tasks.filter((t) => t.stage === stage.id),
  }));
}

/** One entry of the route table `createRoutesStub` builds a router from. */
type StubRoute = Parameters<typeof createRoutesStub>[0][number];

function renderBoard(
  tasks: BoardTask[],
  opts: {
    view?: "list";
    canTransition?: boolean;
    search?: string;
    /** D3: the merge target the shared acceptance ceremony names. */
    defaultBranch?: string;
    /** Server result for the board's own fetchers (reorder / rescan). The
     *  request is handed through so a case can read what the board actually
     *  POSTed (ruling 88's acknowledgment fields). */
    action?: (args: { request: Request }) =>
      | { ok: boolean; toast?: string; error?: string }
      | Promise<{ ok: boolean; toast?: string; error?: string }>;
  } = {},
) {
  // The route carries an `action` key only when a case supplies one: leaving it
  // absent, rather than setting it to undefined, hands the stub router the same
  // route object it has always been given.
  const boardRoute: StubRoute = {
    path: "/projects/:slug/board",
    Component: () => (
      <ToastProvider>
        <BoardPage
          columns={columns(tasks)}
          orphanTasks={[]}
          canCreate
          canTransition={opts.canTransition ?? true}
          canRescan
          {...(opts.defaultBranch ? { defaultBranch: opts.defaultBranch } : {})}
        />
      </ToastProvider>
    ),
  };
  if (opts.action) boardRoute.action = opts.action;
  const Stub = createRoutesStub([
    boardRoute,
    // D19: the destination a card face navigates to, so "Enter opens the
    // focused task" can be asserted as a real navigation rather than a spy.
    {
      path: "/projects/:slug/tasks/:key",
      Component: () => <div>task page</div>,
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

  it("falls back to the task page's read-only stage rendering (dot + name)", () => {
    // Pass 30: same fact, same treatment — the read-only stage shows the
    // stage-colored dot + name (`.stage-static`), not a bare neutral pill.
    const { container } = renderBoard([task()], {
      view: "list",
      canTransition: false,
    });
    const stage = container.querySelector(".stage-static")!;
    expect(stage.textContent).toBe("In Progress");
    expect(stage.querySelector(".col-stage-dot")).toBeTruthy();
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
    // C4: the phrase is the project-scope canonical "waiting on a human" (the
    // trailing "decision" was collapsed away in this pass).
    expect(subtitle(container)).toBe(
      "2 tasks · 1 waiting on a human in this project",
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

describe("D4: degraded continuity reaches the board (card + filter)", () => {
  it("draws a warning-toned continuity cue on a card whose continuity is degraded", () => {
    // Before D4 this state lived ONLY on the task page's Continuity Recovery
    // panel; a supervisor scanning the board could not see it. The card now
    // carries the same state, warning tone (risk pill), refresh glyph.
    const { container } = renderBoard([
      task({ key: "VIB-1", continuity: "degraded" }),
    ]);
    const card = container.querySelector('[data-board-card="VIB-1"]')!;
    expect(card.textContent).toContain("degraded continuity");
    expect(card.querySelector(".card-foot .pill.risk")).toBeTruthy();
  });

  it("stays silent on a card whose continuity is healthy", () => {
    const { container } = renderBoard([task({ key: "VIB-1", continuity: null })]);
    expect(container.querySelector('[data-board-card="VIB-1"]')!.textContent).not.toContain(
      "continuity",
    );
  });

  it("draws the same cue in the list row", () => {
    const { container } = renderBoard(
      [task({ key: "VIB-1", continuity: "degraded" })],
      { view: "list" },
    );
    const row = container.querySelector(".card.list-row")!;
    expect(row.textContent).toContain("degraded continuity");
    expect(row.querySelector(".pill.risk")).toBeTruthy();
  });

  it("shows the 'Degraded continuity' filter chip (with a tally) only when a degraded task exists", () => {
    const withDegraded = renderBoard([
      task({ key: "VIB-1", stage: "impl", continuity: "degraded" }),
      task({ key: "VIB-2", stage: "impl", continuity: null }),
    ]);
    const chip = [...withDegraded.container.querySelectorAll(".filter-bar .fchip")].find(
      (b) => b.textContent!.includes("Degraded continuity"),
    );
    expect(chip).toBeTruthy();
    expect(chip!.textContent).toContain("· 1"); // the tally counts the one degraded task
    cleanup();

    // A board with no degraded task does not carry the (near-always-empty) chip.
    const noneDegraded = renderBoard([task({ key: "VIB-1", continuity: null })]);
    expect(
      [...noneDegraded.container.querySelectorAll(".filter-bar .fchip")].some((b) =>
        b.textContent!.includes("Degraded continuity"),
      ),
    ).toBe(false);
  });

  it("filters the board to only degraded-continuity tasks (canary for the filter clause)", () => {
    const { container } = renderBoard(
      [
        task({ key: "VIB-1", stage: "impl", continuity: "degraded" }),
        task({ key: "VIB-2", stage: "impl", continuity: null }),
      ],
      { search: "filter=continuity" },
    );
    // Only the degraded card survives the filter.
    expect(container.querySelector('[data-board-card="VIB-1"]')).toBeTruthy();
    expect(container.querySelector('[data-board-card="VIB-2"]')).toBeNull();
    // The healthy card is accounted for by the empty-state copy, not vanished.
    const implEmpty = [...container.querySelectorAll(".column")].find((c) =>
      c.querySelector(".col-head .nm")!.textContent!.includes("In Progress"),
    );
    // (Both cards were in the same column, so the column still shows the survivor
    // — the count check above is the real assertion; this just proves no crash.)
    expect(implEmpty).toBeTruthy();
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
      "0 of 2 tasks · 1 waiting on a human in this project",
    );
  });

  // F26-12 / R26-2: the board label filter (`?label=`) narrows to tasks carrying
  // that label, and the chip for it renders from the project's label vocabulary.
  it("filters the board to a single label", () => {
    const { container, getByTitle } = renderBoard(
      [
        task({ key: "VIB-1", stage: "impl", labels: ["security"] }),
        task({ key: "VIB-2", stage: "impl", labels: ["docs"] }),
      ],
      { search: "label=security" },
    );
    // Only the security-labelled task is shown; the other is hidden by the label.
    expect(subtitle(container)).toBe(
      "1 of 2 tasks · 0 waiting on a human in this project",
    );
    // The active label chip flips to its "click to clear" title.
    getByTitle('Showing only “security”. Click to clear.');
    // The other project label is offered as an (inactive) filter chip.
    getByTitle('Show only tasks labelled “docs”');
  });

  it("offers one Clear affordance that resets the filter AND the search", () => {
    const { container, getByTitle, queryByText } = renderBoard(
      [task({ key: "VIB-1", stage: "impl" })],
      { search: "filter=risk&q=zzz" },
    );
    const clear = getByTitle(
      "Show every task again. Clears the board filter, the label filter and the search",
    );
    fireEvent.click(clear);
    // Both hiding mechanisms are gone: the card is back and the chip retires.
    expect(subtitle(container)).toBe(
      "1 task · 0 waiting on a human in this project",
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
    fireEvent.click(getByRole("button", { name: /^Move → Done$/ }));
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
    fireEvent.click(getByRole("button", { name: /^Move → Done$/ })); // B1
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
    // D3: the board renders the ONE shared ceremony now, whose heading names the
    // move-into-terminal-stage acceptance ("Merging is one-way" appears only when
    // a PR is attached; this default task has none — the foot says nothing merges).
    expect(getByText("Moving to Done accepts this completion")).toBeTruthy();
    expect(submitted).toHaveLength(0);

    fireEvent.click(getByRole("button", { name: /^Move → Done$/ }));
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

describe("F15-09/R21-8: 'agent working' renders once, and input-required yields to it", () => {
  it("the card top goes quiet while an agent carries an input-required task", () => {
    const { container } = renderBoard([
      task({ waiting: "agent", readiness: "input_required", displayReadiness: "input_required" }),
    ]);
    // F15-09's half: the claim is made ONCE — the foot's WaitTag, never a
    // duplicate pill in the top slot.
    const working = [...container.querySelectorAll(".card .pill, .card .wait-tag")]
      .filter((el) => el.textContent!.trim() === "agent working");
    expect(working).toHaveLength(1);
    // R21-8's half: "input required" claims a human is needed right now —
    // false while the agent works, so the top slot draws nothing at all.
    expect(container.querySelector(".card-top .pill")).toBeNull();
    expect(container.textContent).not.toContain("input required");
  });

  it("'input required' reasserts in the card top the moment waiting flips to human", () => {
    const { container } = renderBoard([
      task({
        waiting: "human",
        readiness: "input_required",
        displayReadiness: "input_required",
      }),
    ]);
    expect(container.querySelector(".card-top .pill")!.textContent).toBe(
      "input required",
    );
  });

  it("'blocked' never yields — it stays in the card top beside a working agent", () => {
    const { container } = renderBoard([
      task({ waiting: "agent", readiness: "blocked", displayReadiness: "blocked" }),
    ]);
    expect(container.querySelector(".card-top .pill")!.textContent).toBe("blocked");
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
    expect(container.textContent).not.toContain("input required");
  });
});

describe("R15-5: the board owns its own filter box", () => {
  it("renders a board-scoped field that writes ?q= (the topbar now opens the palette)", async () => {
    const { getByLabelText, queryByText } = renderBoard([
      task({ key: "VIB-1", title: "Attach a project credential" }),
      task({ key: "VIB-2", title: "Rotate the PAT" }),
    ]);
    const input = getByLabelText("Filter this board");
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
    expect(hint.textContent).toBe("The task key is assigned automatically.");
    expect(hint.className).not.toContain("err");
  });

  it("keeps guidance neutral on an empty blur (showModal steals focus at open)", () => {
    // dialog.showModal() moves focus right after the title's autoFocus, so an
    // unconditional blur handler fired on FIRST PAINT and the footer opened
    // red — the exact premature error this dialog exists to avoid. An empty
    // blur therefore stays quiet; only real interaction may accuse.
    const { container } = openDialog();
    fireEvent.blur(container.querySelector("#new-task-title")!);
    const hint = container.querySelector(".foot-hint")!;
    expect(hint.textContent).toBe("The task key is assigned automatically.");
    expect(hint.className).not.toContain("err");
  });

  it("states the requirement on a submit attempt with no title", () => {
    const { container } = openDialog();
    fireEvent.keyDown(container.querySelector("#new-task-title")!, {
      key: "Enter",
    });
    const hint = container.querySelector(".foot-hint")!;
    expect(hint.textContent).toBe("A title is required.");
    expect(hint.className).toContain("err");
  });

  it("states the requirement when typed content is left behind", () => {
    const { container } = openDialog();
    const input = container.querySelector("#new-task-title")!;
    fireEvent.change(input, { target: { value: "ab" } });
    fireEvent.blur(input);
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
    expect(hint.textContent).toBe("The task key is assigned automatically.");
    expect(hint.className).not.toContain("err");
  });

  it("offers priority, a date picker and a label input — matching the Details panel", () => {
    const { container } = openDialog();
    expect(container.querySelector("#new-task-priority")).toBeTruthy();
    // The due field is the custom calendar date-picker trigger (a button), not a
    // native date input; the labels field is the token-chip input.
    const due = container.querySelector("#new-task-due");
    expect(due?.tagName).toBe("BUTTON");
    expect(due?.classList.contains("datepick-trigger")).toBe(true);
    expect(container.querySelector(".label-input")).toBeTruthy();
  });
});

/**
 * R19-14 (owner ruling): new tasks are created at the entry stage ONLY — every
 * task passes the triage quality gate, so a per-lane "+" on Ready/In Progress
 * was an invitation the server now refuses.
 */
describe("R19-14: only the entry lane offers task creation", () => {
  it("renders the per-lane + on the entry column and nowhere else", () => {
    const { container } = renderBoard([task()]);
    const cols = [...container.querySelectorAll(".column")];
    expect(cols).toHaveLength(3);
    expect(cols[0]!.querySelector("button.add")).toBeTruthy();
    // Before the ruling every non-Done lane drew one.
    expect(cols[1]!.querySelector("button.add")).toBeNull();
    expect(cols[2]!.querySelector("button.add")).toBeNull();
  });

  it("opens a dialog that names the entry stage instead of offering a picker", () => {
    const { container } = renderBoard([task()]);
    fireEvent.click(container.querySelector("button.add")!);
    // The stage chips are gone — the dialog states where the task lands.
    expect(container.querySelector(".pick-chip")).toBeNull();
    expect(container.textContent).toContain("Starts in Triage");
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
  const listRow = (tasks: BoardTask[]) =>
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
  const archivedTask = (patch: Partial<BoardTask> = {}) =>
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
    });

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
 * N20-14 / C2 — a force-accepted (terminal) card WITHDRAWS the validation pill,
 * matching the task hero (task-detail-components.test.tsx "a force-accepted task
 * never wears 'awaiting verdict' or a redundant bypass pill on the hero"). The
 * projection still carries the honest `bypassed` value (`deriveValidation` from
 * the durable `acceptance: "forced"` fact); the card simply does not RENDER a
 * live-obligation pill on terminal work — an accepted completion owes nobody a
 * verdict. The readiness pill stays, because "accepted" IS the terminal status,
 * not a live claim.
 *
 * (This moved from a "carries the gate-bypassed validation" assertion once C2's
 * card-side withdrawal landed — the exact hand-off C-VOCAB flagged. The
 * bypassed→risk pill mapping is still exercised, by the non-terminal case below.)
 */
describe("N20-14/C2: a force-accepted card withdraws the validation pill", () => {
  it("shows the terminal readiness but no 'awaiting verdict' or 'gate bypassed' chip", () => {
    const { container } = renderBoard([
      task({
        key: "VIB-2",
        stage: "done",
        displayReadiness: "accepted",
        validation: "bypassed",
      }),
    ]);
    const card = container.querySelector(".card")!;
    // The terminal status stays (the readiness pill); the live obligation goes.
    expect(card.querySelector(".card-top")!.textContent).toContain("accepted");
    expect(card.textContent).not.toContain("awaiting verdict");
    // C2 (canary): revert the `!terminal` guard in StateSignals and the
    // withdrawn validation pill returns — this assertion goes red.
    expect(card.textContent).not.toContain("gate bypassed");
  });

  it("still draws the bypassed pill on a NON-terminal card — the mapping is intact, only withheld on terminal work", () => {
    const { container } = renderBoard([
      task({
        key: "VIB-3",
        stage: "impl",
        displayReadiness: "ready",
        validation: "bypassed",
      }),
    ]);
    const card = container.querySelector(".card")!;
    expect(card.textContent).toContain("accepted · gate bypassed");
    // `risk`-toned: an override, not a clean pass.
    expect(card.querySelector(".pill.risk")).toBeTruthy();
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

/**
 * F19-27 — the board acceptance confirm received `taskKey` + `stageName` and
 * disclosed neither the PR it merges, the head it merges, nor the verdict it
 * merges over, on a card whose own summary carries all three. Ruling 42 wants
 * the divergence surfaced on "the accept dialog" and R18-7 says this IS an
 * accept dialog — board acceptance runs the identical contract.
 */
describe("F19-27: the board accept confirm discloses what it merges", () => {
  const openConfirm = (patch: Partial<BoardTask>) => {
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
  const openConfirm = (patch: Partial<BoardTask>) => {
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
  const fromTriage = (patch: Partial<BoardTask> = {}) => {
    const r = renderBoard([task({ key: "VIB-1", stage: "triage", ...patch })], {
      action: () => ({ ok: true as const, toast: "moved" }),
    });
    fireEvent.click(r.getByLabelText("Change stage (currently Triage)"));
    fireEvent.click(r.getByRole("menuitemradio", { name: "Done" }));
    return r.container.querySelector("dialog")!.textContent!.replace(/\s+/g, " ");
  };

  const fromBoundary = (patch: Partial<BoardTask> = {}) => {
    const r = renderBoard([task({ key: "VIB-1", stage: "impl", ...patch })], {
      action: () => ({ ok: true as const, toast: "moved" }),
    });
    fireEvent.click(r.getByLabelText("Change stage (currently In Progress)"));
    fireEvent.click(r.getByRole("menuitemradio", { name: "Done" }));
    return r.container.querySelector("dialog")!.textContent!.replace(/\s+/g, " ");
  };

  it("still names the stage the card is leaving in the head sentence", () => {
    const text = fromTriage({ atAcceptanceBoundary: false });
    // D3: the shared ceremony's heading names the acceptance, and its "Moving"
    // row names the move — from the leaving stage to the terminal one — so the
    // shape of a Triage→Done jump is still visible before the Blocked row.
    expect(text).toContain("Moving to Done accepts this completion");
    expect(text).toContain("Triage → Done");
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
  initial: BoardTask[],
  opts: { action?: () => { ok: boolean; toast?: string; error?: string } } = {},
) {
  let set!: (next: BoardTask[]) => void;
  const boardRoute: StubRoute = {
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
  };
  // As in `renderBoard`: no action supplied means no `action` key at all.
  if (opts.action) boardRoute.action = opts.action;
  const Stub = createRoutesStub([boardRoute]);
  const r = render(<Stub initialEntries={["/projects/viberr-core/board"]} />);
  return {
    ...r,
    /** The revalidation: hand the board a different task payload. */
    reproject: (next: BoardTask[]) => act(() => set(next)),
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
      "VIB-1 is archived. Restore it before accepting the completion.",
    );
  });
});

/**
 * D19 (owner ruling R19-10) — arrow-key traversal on the board.
 *
 * The UX spec put full arrow traversal on the Task Status Card; it was never
 * built. Before this the file's only `onKeyDown` was the new-task dialog's
 * Enter, so a keyboard user met 2N tab stops (a card face and a Move trigger
 * per card) and had no sideways move at all. INTENT §4 asks for keyboard access
 * to every packet action — "inaccessible state is untrustworthy state".
 */
describe("D19: arrow-key traversal over the board (R19-10)", () => {
  const cards = (c: HTMLElement) => [
    ...c.querySelectorAll<HTMLElement>("[data-board-card]"),
  ];
  const cardFor = (c: HTMLElement, key: string) =>
    cards(c).find((el) => el.dataset.boardCard === key)!;
  const focused = () => {
    const active = document.activeElement;
    return active instanceof HTMLElement
      ? (active.dataset.boardCard ?? null)
      : null;
  };
  /** Press `key` on a card face, the way the roving focus reaches it. */
  const press = (el: HTMLElement, key: string) => {
    el.focus();
    fireEvent.keyDown(el, { key });
  };
  // SAFETY: every case focuses a card face before pressing, and jsdom's
  // `activeElement` falls back to <body> — an HTMLElement either way, so a lost
  // focus lands the press somewhere inert and the case's own assertion reports
  // it, rather than this helper throwing first.
  const pressFocused = (key: string) =>
    press(document.activeElement as HTMLElement, key);

  it("puts ONE card in the tab order, not one per card", () => {
    const { container } = renderBoard([
      task({ key: "VIB-1", stage: "triage" }),
      task({ key: "VIB-2", stage: "triage" }),
      task({ key: "VIB-3", stage: "impl" }),
    ]);
    expect(cards(container).map((el) => el.tabIndex)).toEqual([0, -1, -1]);
  });

  it("moves the tab stop with the focus, so Tab re-enters where the human left", () => {
    const { container } = renderBoard([
      task({ key: "VIB-1", stage: "triage" }),
      task({ key: "VIB-2", stage: "triage" }),
    ]);
    press(cardFor(container, "VIB-1"), "ArrowDown");
    expect(cards(container).map((el) => el.tabIndex)).toEqual([-1, 0]);
  });

  it("walks Up and Down within a lane", () => {
    const { container } = renderBoard([
      task({ key: "VIB-1", stage: "impl" }),
      task({ key: "VIB-2", stage: "impl" }),
      task({ key: "VIB-3", stage: "impl" }),
    ]);
    press(cardFor(container, "VIB-1"), "ArrowDown");
    expect(focused()).toBe("VIB-2");
    pressFocused("ArrowDown");
    expect(focused()).toBe("VIB-3");
    pressFocused("ArrowUp");
    expect(focused()).toBe("VIB-2");
  });

  it("holds still at the ends of a lane instead of wrapping", () => {
    const { container } = renderBoard([
      task({ key: "VIB-1", stage: "impl" }),
      task({ key: "VIB-2", stage: "impl" }),
    ]);
    press(cardFor(container, "VIB-1"), "ArrowUp");
    expect(focused()).toBe("VIB-1");
    press(cardFor(container, "VIB-2"), "ArrowDown");
    expect(focused()).toBe("VIB-2");
  });

  it("crosses lanes with Left/Right, landing at the same index", () => {
    const { container } = renderBoard([
      task({ key: "VIB-1", stage: "triage" }),
      task({ key: "VIB-2", stage: "triage" }),
      task({ key: "VIB-3", stage: "impl" }),
      task({ key: "VIB-4", stage: "impl" }),
    ]);
    press(cardFor(container, "VIB-2"), "ArrowRight");
    expect(focused()).toBe("VIB-4");
    pressFocused("ArrowLeft");
    expect(focused()).toBe("VIB-2");
  });

  it("lands on the target lane's first card when that lane is shorter", () => {
    const { container } = renderBoard([
      task({ key: "VIB-1", stage: "triage" }),
      task({ key: "VIB-2", stage: "triage" }),
      task({ key: "VIB-3", stage: "triage" }),
      task({ key: "VIB-4", stage: "impl" }),
    ]);
    // Index 2 in Triage; In Progress holds one card, so the nearest-by-index
    // rule falls back to that lane's first card rather than to nothing.
    press(cardFor(container, "VIB-3"), "ArrowRight");
    expect(focused()).toBe("VIB-4");
  });

  it("never strands the focus on an empty lane", () => {
    // In Progress draws no card at all, so Right from Triage must reach Done.
    const { container } = renderBoard([
      task({ key: "VIB-1", stage: "triage" }),
      task({ key: "VIB-9", stage: "done" }),
    ]);
    press(cardFor(container, "VIB-1"), "ArrowRight");
    expect(focused()).toBe("VIB-9");
    pressFocused("ArrowLeft");
    expect(focused()).toBe("VIB-1");
  });

  it("stays put when there is no lane in that direction — no wrap-around", () => {
    // Two lanes, so a wrapping implementation would jump the leftmost card to
    // the rightmost lane instead of holding still.
    const { container } = renderBoard([
      task({ key: "VIB-1", stage: "triage" }),
      task({ key: "VIB-2", stage: "impl" }),
    ]);
    press(cardFor(container, "VIB-1"), "ArrowLeft");
    expect(focused()).toBe("VIB-1");
    press(cardFor(container, "VIB-2"), "ArrowRight");
    expect(focused()).toBe("VIB-2");
  });

  it("opens the focused task on Enter and on Space", async () => {
    for (const key of ["Enter", " "]) {
      const { container, unmount } = renderBoard([
        task({ key: "VIB-1", stage: "impl" }),
      ]);
      press(cardFor(container, "VIB-1"), key);
      await waitFor(() =>
        expect(container.textContent, key).toContain("task page"),
      );
      unmount();
    }
  });

  it("keeps the Move menu reachable from the focused card — and only that one", () => {
    const { container } = renderBoard([
      task({ key: "VIB-1", stage: "triage" }),
      task({ key: "VIB-2", stage: "triage" }),
    ]);
    const triggers = () =>
      [
        ...container.querySelectorAll<HTMLButtonElement>("button.stage-menu-btn"),
      ].map((b) => b.tabIndex);
    // Without this the board would still hold N tab stops: every card's
    // StageMenu button stayed tabbable while its face went to -1.
    expect(triggers()).toEqual([0, -1]);
    press(cardFor(container, "VIB-1"), "ArrowDown");
    expect(triggers()).toEqual([-1, 0]);
  });

  it("leaves the arrows alone on a control that is not a card face", () => {
    // The StageMenu trigger sits inside the board and owns Arrow Up/Down for
    // its own menu; traversal must not answer for it.
    const { container } = renderBoard([
      task({ key: "VIB-1", stage: "impl" }),
      task({ key: "VIB-2", stage: "impl" }),
    ]);
    const trigger = container.querySelector<HTMLButtonElement>(
      "button.stage-menu-btn",
    )!;
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(document.activeElement).toBe(trigger);
  });

  it("does not answer for the open Move menu's own arrows", () => {
    // The StageMenu popover is `createPortal`ed to <body>, but React bubbles
    // synthetic events along the REACT tree — so its Arrow Up/Down really does
    // reach the board's handler. Two independent gates keep it the menu's:
    // the menu preventDefaults, and the event target is not a card face.
    const { container, getByRole } = renderBoard([
      task({ key: "VIB-1", stage: "impl" }),
      task({ key: "VIB-2", stage: "impl" }),
    ]);
    fireEvent.click(
      container.querySelector<HTMLButtonElement>("button.stage-menu-btn")!,
    );
    const item = getByRole("menuitemradio", { name: "Triage" });
    item.focus();
    fireEvent.keyDown(item, { key: "ArrowDown" });
    expect(document.activeElement).not.toBe(cardFor(container, "VIB-2"));
    expect(document.activeElement!.closest(".stage-menu-pop")).not.toBeNull();
  });

  it("names each lane as a list so a reader is told where focus landed", () => {
    const { container, getByRole } = renderBoard([
      task({ key: "VIB-1", stage: "impl" }),
    ]);
    const lane = getByRole("list", { name: "In Progress tasks" });
    expect(lane.querySelectorAll('[role="listitem"]')).toHaveLength(1);
    // The two empty lanes draw no list role: their only child is the
    // empty-state sentence, and a `list` without `listitem` children is what
    // aria-required-children fails on.
    expect(container.querySelectorAll('[role="list"]')).toHaveLength(1);
  });

  it("walks the list layout too, where the whole board is one lane", () => {
    const { container } = renderBoard(
      [
        task({ key: "VIB-1", stage: "triage" }),
        task({ key: "VIB-2", stage: "impl" }),
      ],
      { view: "list" },
    );
    press(cardFor(container, "VIB-1"), "ArrowDown");
    expect(focused()).toBe("VIB-2");
    // One lane — sideways has nowhere to go, and does not silently jump.
    pressFocused("ArrowRight");
    expect(focused()).toBe("VIB-2");
    expect(
      container.querySelector('[role="list"]')!.getAttribute("aria-label"),
    ).toBe("All tasks");
  });

  it("re-anchors the tab stop when its card is filtered off the board", async () => {
    const { container, getByLabelText } = renderBoard([
      task({ key: "VIB-1", title: "Attach a credential", stage: "impl" }),
      task({ key: "VIB-2", title: "Rotate the PAT", stage: "impl" }),
    ]);
    press(cardFor(container, "VIB-2"), "ArrowUp");
    expect(focused()).toBe("VIB-1");
    // A tab stop pinned to a card the board no longer draws is a board with no
    // keyboard way in.
    fireEvent.change(getByLabelText("Filter this board"), {
      target: { value: "rotate" },
    });
    await waitFor(() => expect(cards(container)).toHaveLength(1));
    expect(cards(container)[0]!.tabIndex).toBe(0);
  });
});

/**
 * UXV19-6 — the other half of F19-13. Board and List are two views of ONE
 * surface, and the card foot draws two more pills under its actionable-state
 * rule: a failing build, and a teammate asking for changes on the PR. The list
 * row drew neither, so switching the segmented control made a broken build
 * invisible — and nothing else on the row covers it (validation is task-row
 * state with no CI input, and "Blocked or waiting" does not filter on either).
 *
 * Canary: delete the two pills from ListView's non-archived branch and the
 * three list-view expectations below fail while the card ones stay green.
 */
describe("UXV19-6: the list row draws the ACTIONABLE PR-check/review pills the card draws", () => {
  const broken = () =>
    task({
      pr: { number: 124, state: "review", title: "Attach a credential" },
      prChecks: { total: 5, passing: 2, failing: 3, pending: 0, state: "failing" },
      prReview: "changes_requested",
    });

  it("a failing build and a changes-requested review survive the Board→List switch", () => {
    const card = renderBoard([broken()]);
    expect(card.getByText("3/5 checks failing")).toBeTruthy();
    expect(card.getByText("changes requested")).toBeTruthy();
    cleanup();

    const { container, getByText } = renderBoard([broken()], { view: "list" });
    const row = container.querySelector(".list-row")!;
    expect(getByText("3/5 checks failing")).toBeTruthy();
    expect(getByText("changes requested")).toBeTruthy();
    // Both live on the row itself, not somewhere else on the page.
    expect(row.textContent).toContain("3/5 checks failing");
    expect(row.textContent).toContain("changes requested");
  });

  it("stays silent when the checks pass and nobody asked for changes — same density rule as the card", () => {
    const { container } = renderBoard(
      [
        task({
          pr: { number: 124, state: "review", title: "Attach a credential" },
          prChecks: { total: 5, passing: 5, failing: 0, pending: 0, state: "passing" },
          prReview: "approved",
        }),
      ],
      { view: "list" },
    );
    const row = container.querySelector(".list-row")!;
    expect(row.textContent).not.toContain("checks");
    expect(row.textContent).not.toContain("approved");
  });

  it("an archived row still states only that it is archived", () => {
    const { container } = renderBoard(
      [{ ...broken(), archived: true }],
      { view: "list", search: "filter=archived" },
    );
    const row = container.querySelector(".list-row")!;
    expect(row.textContent).toContain("archived");
    expect(row.textContent).not.toContain("checks failing");
    expect(row.textContent).not.toContain("changes requested");
  });
});

/**
 * Pass-19 gap 10 — a task that quietly stopped moving looked exactly like one
 * being worked, right down to the pulsing "agent working" dot.
 *
 * `quiet` arrives resolved from the server (board-query.server.ts): it is what
 * the chip selects on and what three surfaces draw, so it must be the SAME value
 * in the SSR pass and in hydration. The relative TEXT beside it is the
 * time-dependent part, and that goes through `LocalRelative`.
 */
describe("gap-10: the board says when a task has gone quiet", () => {
  const quietTask = (patch: Partial<BoardTask> = {}) =>
    task({
      waiting: "agent",
      lastActivityAt: new Date(Date.now() - 4 * 60 * 60_000).toISOString(),
      quiet: true,
      ...patch,
    });

  it("draws the cue on the card, and nothing at all on a moving task", () => {
    const { container } = renderBoard([quietTask()]);
    const foot = container.querySelector(".card-foot")!;
    expect(foot.textContent).toContain("no activity");
    // The neutral pill, not one of the loud state colours (risk/blocked/input).
    expect(container.querySelector(".card-foot .pill.neutral")).toBeTruthy();
    // The wait tag stays — "agent working" and "no activity 4h" together are the
    // whole point: the badge alone was the lie.
    expect(foot.textContent).toContain("agent working");
    cleanup();

    const moving = renderBoard([task({ waiting: "agent" })]);
    expect(
      moving.container.querySelector(".card-foot")!.textContent,
    ).not.toContain("no activity");
  });

  it("draws the same cue on the list row — one board, two views, one vocabulary", () => {
    const { container } = renderBoard([quietTask()], { view: "list" });
    expect(container.querySelector(".list-row")!.textContent).toContain(
      "no activity",
    );
  });

  it("never draws it on an archived card", () => {
    // R14-3 / F19-8: archived work is out of the flow and owes nobody anything.
    // The server's `isQuiet` refuses archived tasks outright; this pins the
    // second belt, so a stale annotation can never light up an archived card.
    const { container } = renderBoard(
      [quietTask({ archived: true })],
      { search: "filter=archived" },
    );
    const card = container.querySelector(".card")!;
    expect(card.textContent).toContain("archived");
    expect(card.textContent).not.toContain("no activity");
  });

  it("gives the board a 'No activity' chip that selects exactly those tasks", () => {
    const tasks = [
      quietTask({ key: "VIB-142" }),
      task({ key: "VIB-143", waiting: "agent" }),
      task({ key: "VIB-144", waiting: "human" }),
    ];
    const chipOff = renderBoard(tasks);
    const chip = chipOff.getByRole("button", { name: /No activity/ });
    // The tally discloses the count before anyone clicks it.
    expect(chip.textContent).toContain("· 1");
    expect(chipOff.container.textContent).toContain("VIB-143");
    cleanup();

    const { container } = renderBoard(tasks, { search: "filter=quiet" });
    expect(container.textContent).toContain("VIB-142");
    expect(container.textContent).not.toContain("VIB-143");
    expect(container.textContent).not.toContain("VIB-144");
  });

  it("hides the chip's tally when nothing is quiet", () => {
    const { getByRole } = renderBoard([task({ waiting: "agent" })]);
    expect(
      getByRole("button", { name: /No activity/ }).textContent,
    ).not.toContain("·");
  });
});

/**
 * D3 (rulings 14 + 53) — the board raised its OWN acceptance dialog, forked from
 * the task page's and disclosing less: no merge target, no delivered-revision
 * row, no verdict attribution, no no-change disposition. Ruling 14 forbids the
 * fork; ruling 53 (R18-7) required the board ceremony to "match the task-detail
 * dialog". The board now renders the ONE shared `AcceptConfirm` in its
 * `stage-move` mode.
 *
 * Canary: point the call site back at a board-only dialog and every assertion
 * that reads a shared-ceremony row (the merge target, the delivered-revision
 * row, the `data-screen-label`) goes red.
 */
describe("D3: the board renders the shared acceptance ceremony", () => {
  const openConfirm = (
    patch: Partial<BoardTask>,
    opts: { defaultBranch?: string } = {},
  ) => {
    const r = renderBoard([task({ key: "VIB-1", stage: "impl", ...patch })], {
      action: () => ({ ok: true as const, toast: "moved" }),
      ...opts,
    });
    fireEvent.click(r.getByLabelText("Change stage (currently In Progress)"));
    fireEvent.click(r.getByRole("menuitemradio", { name: "Done" }));
    return r;
  };

  it("is the ONE shared dialog (its screen label), not a board-only fork", () => {
    const r = openConfirm({});
    expect(
      r.container.querySelector(
        'dialog[data-screen-label="Accept completion dialog"]',
      ),
    ).toBeTruthy();
  });

  it("names the merge target — the project default branch the fork could not", () => {
    const text = openConfirm(
      { pr: { number: 124, state: "review", title: "t" } },
      { defaultBranch: "trunk" },
    )
      .container.querySelector("dialog")!
      .textContent!.replace(/\s+/g, " ");
    expect(text).toContain("PR #124");
    expect(text).toContain("into trunk");
  });

  it("carries the delivered-revision row the fork omitted — honest absence when nothing was delivered", () => {
    expect(
      openConfirm({}).container.querySelector("dialog")!.textContent,
    ).toContain("No delivered revision recorded.");
  });

  it("discloses the DELIVERED revision the projection now carries (ruling 53)", () => {
    // The row used to be hardcoded absent (`workRevisionSha={null}`), so the
    // board's ceremony disclosed "nothing delivered" about every task — and once
    // ruling 88 made the confirmed click echo that disclosure back, the server
    // refused the resulting `"none"` against any task that HAD delivered. The
    // summary carries the sha now (TaskSummary.workRevisionSha).
    // CANARY: put `workRevisionSha={null}` back in AcceptOnBoardConfirm.
    const text = openConfirm({ workRevisionSha: "a4c790ce63ef" + "0".repeat(28) })
      .container.querySelector("dialog")!
      .textContent!.replace(/\s+/g, " ");
    expect(text).toContain("a4c790ce63ef");
    expect(text).not.toContain("No delivered revision recorded.");
  });

  it("names the acceptance and the move it performs, in the shared vocabulary", () => {
    const text = openConfirm({})
      .container.querySelector("dialog")!
      .textContent!.replace(/\s+/g, " ");
    expect(text).toContain("Moving to Done accepts this completion");
    // The `stage-move` ceremony's Moving row names leaving + terminal stage.
    expect(text).toContain("In Progress → Done");
  });

  it("ruling 88: the confirmed drop POSTs the ceremony's own acknowledgment", async () => {
    // F21-2: the board's ceremony was client architecture — the reorder POST
    // behind it carried nothing back from the dialog, so the server accepted
    // (and merged) a drop whose confirmation was never rendered. CANARY: drop
    // the disclosure argument from `submitReorder` and the three ack fields
    // vanish from the body while every other assertion here still passes.
    const submitted: Record<string, string>[] = [];
    const r = renderBoard(
      [
        task({
          key: "VIB-1",
          stage: "impl",
          validation: "changed",
          pr: { number: 124, state: "review", title: "t" },
        }),
      ],
      {
        action: async ({ request }) => {
          const fd = await request.formData();
          const row: Record<string, string> = {};
          for (const [k, v] of fd.entries()) if (!(v instanceof File)) row[k] = v;
          submitted.push(row);
          return { ok: true as const, toast: "moved" };
        },
      },
    );
    fireEvent.click(r.getByLabelText("Change stage (currently In Progress)"));
    fireEvent.click(r.getByRole("menuitemradio", { name: "Done" }));
    expect(submitted).toHaveLength(0); // the ceremony still comes first
    fireEvent.click(
      Array.from(r.container.ownerDocument.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("Move → Done"),
      )!,
    );
    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted[0]!.intent).toBe("reorder");
    expect(submitted[0]!.to).toBe("done");
    // The three facts the rows above stated, as they were rendered: this task
    // has delivered nothing, and the dialog's revision row said so.
    expect(submitted[0]!.ackPr).toBe("review");
    expect(submitted[0]!.ackRevision).toBe("none");
    expect(submitted[0]!.ackVerdict).toBe("changed");
  });

  it("ruling 53/88: a DELIVERED task echoes its revision, not a blanket 'none'", async () => {
    // The half of the echo the board could not tell the truth about. With the
    // revision hardcoded absent, this POST carried `ackRevision=none` for a task
    // whose live head was a real sha — the server compares the echo against the
    // task and refused it as stale, so a drop onto Done could never accept
    // delivered work (proved on the door in task-actions.server.test.ts).
    // CANARY: put `workRevisionSha={null}` back in AcceptOnBoardConfirm.
    const sha = "a4c790ce63ef" + "0".repeat(28);
    const submitted: Record<string, string>[] = [];
    const r = renderBoard(
      [
        task({
          key: "VIB-1",
          stage: "impl",
          validation: "healthy",
          workRevisionSha: sha,
          pr: { number: 124, state: "review", title: "t" },
        }),
      ],
      {
        action: async ({ request }) => {
          const fd = await request.formData();
          const row: Record<string, string> = {};
          for (const [k, v] of fd.entries()) if (!(v instanceof File)) row[k] = v;
          submitted.push(row);
          return { ok: true as const, toast: "moved" };
        },
      },
    );
    fireEvent.click(r.getByLabelText("Change stage (currently In Progress)"));
    fireEvent.click(r.getByRole("menuitemradio", { name: "Done" }));
    fireEvent.click(
      Array.from(r.container.ownerDocument.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("Move → Done"),
      )!,
    );
    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted[0]!.ackRevision).toBe(sha);
  });

  it("still discloses the PR, its drift and the verdict it accepts over", () => {
    const text = openConfirm({
      validation: "changed",
      pr: {
        number: 124,
        state: "review",
        title: "t",
        revisionDrift: { aheadBy: 2, headSha: "a4c790ce63efbeef" },
      },
    })
      .container.querySelector("dialog")!
      .textContent!.replace(/\s+/g, " ");
    expect(text).toContain("PR #124 · in review");
    expect(text).toContain("a4c790ce63ef");
    expect(text).toContain("2 commits added since review");
    expect(text).toContain("awaiting verdict"); // the ValidationPill verdict row
  });
});

/**
 * D9 (WCAG 2.2 / UX spec §Accessibility Strategy) — board moves were announced
 * to no one. Drag is pointer-only and keyboard users move via the StageMenu, but
 * nothing spoke a requested move, a completed one, or a refusal (including the
 * server's 409 on an off-boundary move). A polite `aria-live` region owned by
 * the board now speaks all three.
 *
 * Canary: delete `announceMove` / the effect's `setAnnounce` calls and these
 * outcome/request assertions go red.
 */
describe("D9: the board announces moves to a screen reader", () => {
  // Scope to the board's own region — the ToastProvider host is also a polite
  // status region, but it lives OUTSIDE `.board-wrap`.
  const region = (c: HTMLElement) =>
    c.querySelector('.board-wrap [aria-live="polite"]');

  it("mounts an empty polite status region", () => {
    const { container } = renderBoard([task()]);
    const live = region(container)!;
    expect(live).toBeTruthy();
    expect(live.getAttribute("role")).toBe("status");
    expect(live.textContent).toBe("");
  });

  it("announces the request, then the server's own outcome sentence", async () => {
    const { container, getByLabelText, getByRole } = renderBoard(
      [task({ key: "VIB-1", stage: "triage" })],
      { action: () => ({ ok: true as const, toast: "Moved VIB-1 to In Progress" }) },
    );
    // A NON-final move commits straight from the gesture (no confirm dialog).
    fireEvent.click(getByLabelText("Change stage (currently Triage)"));
    fireEvent.click(getByRole("menuitemradio", { name: "In Progress" }));
    expect(region(container)!.textContent).toBe(
      "Move requested: VIB-1 to In Progress.",
    );
    await waitFor(() =>
      expect(region(container)!.textContent).toBe("Moved VIB-1 to In Progress"),
    );
  });

  it("announces a refusal — the class the 409 on an off-boundary move falls into", async () => {
    const { container, getByLabelText, getByRole } = renderBoard(
      [task({ key: "VIB-1", stage: "triage" })],
      {
        action: () => ({
          ok: false as const,
          error: "Triage → In Progress is not an allowed edge.",
        }),
      },
    );
    fireEvent.click(getByLabelText("Change stage (currently Triage)"));
    fireEvent.click(getByRole("menuitemradio", { name: "In Progress" }));
    await waitFor(() =>
      expect(region(container)!.textContent).toContain("Move refused:"),
    );
    expect(region(container)!.textContent).toContain(
      "Triage → In Progress is not an allowed edge.",
    );
  });

  it("announces the outcome of a confirmed acceptance from the board", async () => {
    const { container, getByLabelText, getByRole } = renderBoard(
      [task({ key: "VIB-1", stage: "impl" })],
      { action: () => ({ ok: true as const, toast: "Accepted VIB-1, moved to Done" }) },
    );
    fireEvent.click(getByLabelText("Change stage (currently In Progress)"));
    fireEvent.click(getByRole("menuitemradio", { name: "Done" }));
    // The acceptance waits for the confirm; the request fires on confirm.
    fireEvent.click(getByRole("button", { name: /^Move → Done$/ }));
    expect(region(container)!.textContent).toBe("Move requested: VIB-1 to Done.");
    await waitFor(() =>
      expect(region(container)!.textContent).toBe(
        "Accepted VIB-1, moved to Done",
      ),
    );
  });
});
