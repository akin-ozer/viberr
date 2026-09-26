// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import type { TaskDetail } from "~/server/projections/task-query.server";
import type { AcceptanceAffordance } from "~/server/tasks/task-actions.server";
import { ToastProvider } from "~/ui/toast";
import { toISODate } from "~/ui/calendar";
import { CurrentStatePanel } from "./task-side-panels";
import { TaskDetailsPanel } from "./task-details-panel";

/**
 * Pass-19 gap 10 — the task page showed stage, readiness, validation, owner and
 * repo, and nowhere in the app could a supervisor find out WHEN anything last
 * happened on a task. `TaskSummary.updatedAt` was projected and read by nothing
 * at task level, and it would have been the wrong answer anyway (see the essay
 * in app/server/projections/task-activity.server.ts).
 */

afterEach(cleanup);

const STAGES = [
  { id: "triage", name: "Triage", color: "slate" },
  { id: "review", name: "Review", color: "blue" },
  { id: "done", name: "Done", color: "green" },
];

const ACCEPTANCE: AcceptanceAffordance = {
  hasAuthority: false,
  atBoundary: false,
  blockedReason: null,
  blockedGates: [],
  blockedReasonViaPacket: null,
  canAccept: false,
  terminallyBlocked: false,
};

function detail(patch: Partial<TaskDetail> = {}): TaskDetail {
  return {
    projectSlug: "viberr-core",
    key: "VIB-151",
    title: "Compress long-running task timelines",
    stage: "review",
    readiness: "ready",
    displayReadiness: "ready",
    waiting: "agent",
    urgent: false,
    priority: "normal",
    labels: [],
    dueDate: null,
    blockedBy: [],
    archived: false,
    validation: "healthy",
    blockReason: null,
    continuity: null,
    owner: null,
    specialist: null,
    reviewers: [],
    operator: null,
    branch: "vib-151",
    repo: "akin-ozer/viberr",
    pr: null,
    prChecks: null,
    prReview: null,
    commits: [],
    otherCommits: [],
    changed: null,
    unownedPr: null,
    foreignHead: null,
    goal: "Keep the timeline readable.",
    packet: null,
    eventCount: 0,
    commentCount: 0,
    diagnosticCount: 0,
    createdAt: null,
    // The file-write stamp is deliberately FRESH in every fixture here: it is
    // the value the panel must NOT be reading.
    updatedAt: new Date().toISOString(),
    boardRank: null,
    filePath: "projects/viberr-core/tasks/VIB-151/task.md",
    timeline: [],
    diagnostics: [],
    stages: STAGES,
    workflow: [],
    lastActivityAt: null,
    atAcceptanceBoundary: false,
    quiet: false,
    ...patch,
  };
}

function renderPanel(patch: Partial<TaskDetail> = {}) {
  const task = detail(patch);
  const Stub = createRoutesStub([
    {
      path: "/",
      Component: () => (
        <CurrentStatePanel
          task={task}
          stage={STAGES[1]}
          meId="u-arda"
          myRole="viewer"
          archived={task.archived === true}
          acceptance={ACCEPTANCE}
          ownerBusy={false}
          onOwner={() => {}}
          onRelease={() => {}}
          onArchive={() => {}}
          onAccept={() => {}}
          onTransition={() => {}}
          transitionBusy={false}
          acceptInFlight={null}
          dispositionBusy={false}
        />
      ),
    },
  ]);
  return render(<Stub initialEntries={["/"]} />);
}

/** Same panel, as a CONTRIBUTOR (the tier that may take the owner seat) — or
 *  any role passed in. */
function renderAsContributor(patch: Partial<TaskDetail> = {}, myRole = "contributor") {
  const task = detail(patch);
  const Stub = createRoutesStub([
    {
      path: "/",
      Component: () => (
        <CurrentStatePanel
          task={task}
          stage={STAGES[1]}
          meId="u-arda"
          myRole={myRole}
          archived={task.archived === true}
          acceptance={ACCEPTANCE}
          ownerBusy={false}
          onOwner={() => {}}
          onRelease={() => {}}
          onArchive={() => {}}
          onAccept={() => {}}
          onTransition={() => {}}
          transitionBusy={false}
          acceptInFlight={null}
          dispositionBusy={false}
        />
      ),
    },
  ]);
  return render(<Stub initialEntries={["/"]} />);
}

/**
 * Ruling 127 — the owner seat is also the RUN PRINCIPAL: every agent run on a
 * task bills the owner's own Claude and Codex accounts. The Current-state row
 * is where a person sees and releases that seat, so it is where the widened
 * meaning has to be stated; the run controls in the execution profile then
 * name the owner when a backend of theirs is not connected.
 */
describe("the owner row states what the seat now means (ruling 127)", () => {
  it("names the acceptance authority AND whose accounts the agents run on", () => {
    const { container } = renderPanel({
      owner: {
        kind: "human",
        userId: "u-arda",
        name: "Arda Kaya",
        initials: "AK",
        tone: "",
      },
    });
    const seat = container.querySelector(".rev-stack")!;
    expect(seat.getAttribute("title")).toBe(
      "Human owner: reviews and accepts this task, and its agent runs use their own Claude and Codex accounts",
    );
  });
});

describe("owner seat on closed and archived tasks (D32-16 / E32-9)", () => {
  it("offers Assign me on an open unowned task, withholds it once closed or archived", () => {
    const open = renderAsContributor({ owner: null });
    expect(open.queryByText("Assign me")).not.toBeNull();
    open.unmount();
    // Canary: drop `!closed` from the owner cell and the accepted task offers it.
    const accepted = renderAsContributor({ owner: null, displayReadiness: "accepted" });
    expect(accepted.queryByText("Assign me")).toBeNull();
    accepted.unmount();
    const merged = renderAsContributor({ owner: null, displayReadiness: "merged" });
    expect(merged.queryByText("Assign me")).toBeNull();
    merged.unmount();
    const archived = renderAsContributor({ owner: null, archived: true });
    expect(archived.queryByText("Assign me")).toBeNull();
  });

  it("ruling 118: an ADMIN may still take a closed seat for the record, never an archived one", () => {
    const closedAsAdmin = renderAsContributor({ owner: null, displayReadiness: "accepted" }, "admin");
    expect(closedAsAdmin.queryByText("Assign me")).not.toBeNull();
    closedAsAdmin.unmount();
    const archivedAsAdmin = renderAsContributor({ owner: null, archived: true }, "admin");
    expect(archivedAsAdmin.queryByText("Assign me")).toBeNull();
  });
});

/** The kv-row value for a given label. */
function kv(container: HTMLElement, label: string): string {
  const row = [...container.querySelectorAll(".kv-row")].find(
    (r) => r.querySelector(".k")?.textContent === label,
  );
  if (!row) throw new Error(`no "${label}" row in the Current state panel`);
  return row.querySelector(".v")!.textContent!.trim();
}

describe("gap-10: Current state shows when anything last happened", () => {
  it("renders a Last activity row from the newest timeline stamp", () => {
    const { container } = renderPanel({
      lastActivityAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
    });
    // LocalRelative fills in after hydration; the row exists and is not blank.
    expect(kv(container, "Last activity")).toMatch(/ago|yesterday|just now/);
  });

  it("says so plainly when the timeline is empty rather than guessing", () => {
    const { container } = renderPanel({ lastActivityAt: null });
    expect(kv(container, "Last activity")).toBe("Nothing on the timeline yet");
  });

  it("adds the quiet note only once the task has crossed its threshold", () => {
    const at = new Date(Date.now() - 4 * 60 * 60_000).toISOString();
    const quiet = renderPanel({ lastActivityAt: at, quiet: true });
    expect(quiet.container.textContent).toContain("No activity");
    // Stated as the two facts the detector actually has.
    expect(quiet.container.textContent).toContain("no run is in flight");
    cleanup();

    const moving = renderPanel({ lastActivityAt: at, quiet: false });
    // Same stamp on screen, no cue — the threshold, not the timestamp, is what
    // makes it a signal.
    expect(moving.container.textContent).not.toContain("No activity");
    expect(kv(moving.container, "Last activity")).toMatch(
      /ago|yesterday|just now/,
    );
  });
});

function renderDetails(
  patch: Partial<TaskDetail>,
  canEdit: boolean,
  queuedQuestions: { id: string; profileId: string; decidedByLabel: string }[] = [],
) {
  const task = detail(patch);
  const Stub = createRoutesStub([
    {
      path: "/",
      Component: () => (
        <ToastProvider>
          <TaskDetailsPanel
            task={task}
            canEdit={canEdit}
            queuedQuestions={queuedQuestions}
          />
        </ToastProvider>
      ),
      action: async () => ({ ok: true }),
    },
  ]);
  return render(<Stub initialEntries={["/"]} />);
}

describe("ruling 131: the Current-state Waiting-on row names the other work", () => {
  it("reads 'Other work: …' while waiting is none and the list is non-empty; 'Nothing' otherwise", () => {
    // Canary: drop the `blockedBy` arm and the row reads "Nothing".
    const { container } = renderPanel({
      waiting: "none",
      blockedBy: [
        { ref: "goal-1 link 2", label: "goal-1 link 2", state: "open", taskKey: null, goalId: "goal-1" },
        { ref: "JC-3", label: "JC-3", state: "done", taskKey: "JC-3", goalId: null },
      ],
    });
    // Ruling 356: JC-3 is done in the fixture, and reads as done (CANARY:
    // print the bare labels again).
    expect(kv(container, "Waiting on")).toBe("Other work: goal-1 link 2 and JC-3 (done)");
    const row = [...container.querySelectorAll(".kv-row")].find((r) => r.querySelector(".k")?.textContent === "Waiting on")!;
    expect(row.querySelector(".v span")?.getAttribute("title")).toBe("goal-1 link 2 · open · JC-3 · done");
    // A human still owed something wins over the wait.
    const { container: human } = renderPanel({ waiting: "human", blockedBy: [{ ref: "JC-3", label: "JC-3", state: "open", taskKey: "JC-3", goalId: null }] });
    expect(kv(human, "Waiting on")).toBe("a human");
    const { container: none } = renderPanel({ waiting: "none" });
    expect(kv(none, "Waiting on")).toBe("Nothing");
  });
});

/** The Details panel, capturing every form it posts. */
function renderCapturing(patch: Partial<TaskDetail>, canEdit: boolean) {
  const task = detail(patch);
  const posted: Record<string, string>[] = [];
  const Stub = createRoutesStub([
    {
      path: "/",
      Component: () => (
        <ToastProvider>
          <TaskDetailsPanel task={task} canEdit={canEdit} labelSuggestions={["qa", "codex"]} />
        </ToastProvider>
      ),
      action: async ({ request }) => {
        const fd = await request.formData();
        posted.push(Object.fromEntries([...fd.entries()].map(([k, v]) => [k, String(v)])));
        return { ok: true };
      },
    },
  ]);
  return { ...render(<Stub initialEntries={["/"]} />), posted };
}

/** A property's trigger: named by its row's label and its value. */
const trigger = (view: { getByRole: ReturnType<typeof render>["getByRole"] }, label: string) =>
  view.getByRole("button", { name: new RegExp(`^${label} `) });

describe("ruling 131: the Details panel's Blocked by row and its own form", () => {
  const entries = [
    { ref: "goal-1 link 2", label: "goal-1 link 2 (JC-3)", state: "done" as const, taskKey: "JC-3", goalId: "goal-1" },
    { ref: "JC-6", label: "JC-6", state: "failed" as const, taskKey: "JC-6", goalId: null },
    { ref: "JC-7", label: "JC-7", state: "open" as const, taskKey: "JC-7", goalId: null },
  ];

  it("reads the wait as a kv row with each entry's state, and its status ring", () => {
    const { container } = renderCapturing({ blockedBy: entries }, false);
    expect(kv(container, "Blocked by")).toBe("goal-1 link 2 (JC-3) · doneJC-6 · archivedJC-7");
    // Ruling 501: each entry is a chip carrying its state for the sheet's ring.
    // CANARY: drop `data-wait-state` and the done and dead rings lose their tone.
    const chips = [...container.querySelectorAll(".wait-chip")];
    expect(chips.map((c) => c.getAttribute("data-wait-state"))).toEqual(["done", "failed", "open"]);
    expect(chips.every((c) => c.querySelector("svg.ico"))).toBe(true);
    const { container: bare } = renderCapturing({}, false);
    expect(kv(bare, "Blocked by")).toBe("Nothing");
  });

  it("edits through its OWN form and intent: the submitted list is the field's text, and an empty field clears", async () => {
    // Canary: remove the dependency editor from the Blocked by trigger, or
    // route it through the metadata form's intent.
    const view = renderCapturing({ blockedBy: entries }, true);
    fireEvent.click(trigger(view, "Blocked by"));
    const form = view.container.querySelector<HTMLFormElement>("form[data-dependency-form]")!;
    expect(form).toBeTruthy();
    const input = form.querySelector<HTMLInputElement>('input[name="blockedBy"]')!;
    // Prefilled with the CANONICAL refs, not the display labels.
    expect(input.value).toBe("goal-1 link 2, JC-6, JC-7");
    fireEvent.change(input, { target: { value: "JC-7, goal-2 link 1" } });
    fireEvent.click(form.querySelector('button[type="submit"]')!);
    await waitFor(() => expect(view.posted).toHaveLength(1));
    expect(view.posted[0]).toMatchObject({ intent: "set-task-dependencies", blockedBy: "JC-7, goal-2 link 1" });
    expect(view.posted[0]!.priority).toBeUndefined();
    // A saved wait closes its editor.
    await waitFor(() => expect(view.container.querySelector("form[data-dependency-form]")).toBeNull());
  });

  it("an archived task offers no dependency editor", () => {
    const { queryByRole } = renderCapturing({ blockedBy: entries, archived: true }, true);
    expect(queryByRole("button", { name: /^Blocked by/ })).toBeNull();
  });
});

describe("TaskDetailsPanel", () => {
  it("reads the metadata as kv rows, matching the side-panel style", () => {
    // A due date in the FUTURE relative to now, so the row always reads "due …"
    // (a hardcoded past date rots into "overdue · …" once that day passes).
    const future = new Date(Date.now() + 30 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const { container } = renderDetails(
      { priority: "high", labels: ["qa", "codex"], dueDate: future },
      false,
    );
    // Panel head + the three rows.
    expect(container.querySelector(".panel-head h2")?.textContent).toBe("Details");
    expect(kv(container, "Priority")).toContain("high");
    expect(kv(container, "Labels")).toContain("qa");
    expect(kv(container, "Labels")).toContain("codex");
    // "due <Mon> <day>", never the "overdue · …" a past date would render.
    expect(kv(container, "Due date")).toMatch(/^due /);
  });

  /**
   * Ruling 241 (F37-68): a question the hold refused is put when the hold
   * lifts, and the wait has to say so. Without this the only trace is one
   * timeline note, and a promise a person made and cannot see is the defect
   * this pass kept finding.
   */
  it("names the queued question under the wait, by the reviewer's NAME", () => {
    const { container } = renderDetails(
      {
        blockedBy: [{ ref: "VIB-9", label: "VIB-9", state: "open", taskKey: "VIB-9", goalId: null }],
        reviewers: [
          {
            kind: "agent",
            profileId: "rev",
            backend: "codex",
            name: "Codex",
            role: "Code review",
            profileName: "Integration Verifier",
          },
        ],
      },
      false,
      [{ id: "qq_1", profileId: "rev", decidedByLabel: "Arda" }],
    );
    // Ruling 232: a handle is a NAME. CANARY: fall back to `q.profileId` first
    // and this reads "rev", which names nobody a person can search for.
    expect(kv(container, "When it clears")).toContain("Integration Verifier");
    expect(kv(container, "When it clears")).toContain("Arda");
    expect(kv(container, "When it clears")).toContain("before the operator gets the task back");
  });

  it("says nothing about queued questions when there are none", () => {
    // CANARY: render the row unconditionally and every task grows a "When it
    // clears" line about a question nobody asked for.
    const { container } = renderDetails({}, false);
    expect(container.querySelector("[data-queued-questions]")).toBeNull();
  });

  it("shows 'Normal / None / None' for a bare task, quietly", () => {
    const { container } = renderDetails({}, false);
    expect(kv(container, "Priority")).toContain("Normal");
    expect(kv(container, "Labels")).toContain("None");
    expect(kv(container, "Due date")).toContain("None");
    // Ruling 501: an empty value is the quiet line, never the bold fact the
    // owner's screenshot showed four times. CANARY: print them bare in `.v`.
    expect(container.querySelectorAll(".kv-row .prop-empty")).toHaveLength(4);
  });
});

/**
 * Ruling 501: the Details panel draws its properties the way Linear's and
 * GitHub's issue sidebars do. Each value is its own control, which edits that
 * one property in a popover and posts only its own field; the "Edit details"
 * and "Edit what it waits on" buttons, and the three-field form, are gone.
 */
describe("ruling 501: each Details property is its own control", () => {
  it("gives a viewer text, and an editor one trigger per property, with the empty ones as invitations", () => {
    // CANARY: render the triggers for a viewer, or bring back the footer buttons.
    const viewer = renderCapturing({}, false);
    expect(viewer.container.querySelectorAll("button")).toHaveLength(0);
    cleanup();
    const editor = renderCapturing({}, true);
    for (const [label, value] of [
      ["Priority", "Normal"],
      ["Labels", "Add labels"],
      ["Due date", "Set due date"],
      ["Blocked by", "Add dependency"],
    ] as const) {
      const btn = trigger(editor, label);
      expect(btn.getAttribute("aria-expanded"), label).toBe("false");
      expect(kv(editor.container, label), label).toBe(value);
    }
    expect(editor.container.querySelectorAll("button")).toHaveLength(4);
    expect(editor.queryByText(/Edit details|Edit what it waits on/)).toBeNull();
  });

  it("sets the priority from a menu, posting that field alone", async () => {
    // CANARY: post the whole metadata triple again, and `labels` rides along.
    const view = renderCapturing({ labels: ["qa"] }, true);
    fireEvent.click(trigger(view, "Priority"));
    const menu = view.getByRole("menu");
    const items = within(menu).getAllByRole("menuitemradio");
    // Most urgent first; the current one checked, and focused as it opens.
    expect(items.map((i) => i.textContent)).toEqual(["Urgent", "High", "Normal", "Low"]);
    expect(items.map((i) => i.getAttribute("aria-checked"))).toEqual(["false", "false", "true", "false"]);
    expect(document.activeElement).toBe(items[2]);
    // Arrow keys rove the menu.
    fireEvent.keyDown(items[2]!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(items[1]);
    // Picking the current priority closes it and posts nothing.
    fireEvent.click(items[2]!);
    expect(view.queryByRole("menu")).toBeNull();
    fireEvent.click(trigger(view, "Priority"));
    fireEvent.click(within(view.getByRole("menu")).getByRole("menuitemradio", { name: "High" }));
    expect(view.queryByRole("menu")).toBeNull();
    await waitFor(() => expect(view.posted).toHaveLength(1));
    expect(view.posted[0]).toMatchObject({ intent: "set-task-metadata", priority: "high" });
    expect(Object.keys(view.posted[0]!).sort()).toEqual(["_csrf", "intent", "priority"]);
  });

  it("closes on Escape and hands focus back to the trigger", () => {
    const view = renderCapturing({}, true);
    const btn = trigger(view, "Priority");
    fireEvent.click(btn);
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(view.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(btn);
  });

  it("edits the labels in their own popover, posting the labels alone, and a Save with no change posts nothing", async () => {
    // CANARY: drop the unchanged check and the first Save posts a no-op.
    const view = renderCapturing({ labels: ["qa"], priority: "high" }, true);
    fireEvent.click(trigger(view, "Labels"));
    const dialog = view.getByRole("dialog", { name: "Labels" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(view.queryByRole("dialog")).toBeNull();
    expect(view.posted).toHaveLength(0);
    fireEvent.click(trigger(view, "Labels"));
    const field = within(view.getByRole("dialog", { name: "Labels" })).getByLabelText(/Add a label/);
    fireEvent.change(field, { target: { value: "codex" } });
    fireEvent.keyDown(field, { key: "Enter" });
    fireEvent.click(within(view.getByRole("dialog", { name: "Labels" })).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(view.posted).toHaveLength(1));
    expect(view.posted[0]).toMatchObject({ intent: "set-task-metadata", labels: "qa,codex" });
    expect(view.posted[0]!.priority).toBeUndefined();
    expect(view.posted[0]!.dueDate).toBeUndefined();
    await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
  });

  it("picks the due date on a calendar and clears it from there, posting the date alone", async () => {
    const view = renderCapturing({}, true);
    fireEvent.click(trigger(view, "Due date"));
    const dialog = view.getByRole("dialog", { name: "Due date" });
    const now = new Date();
    const iso = toISODate(new Date(now.getFullYear(), now.getMonth(), 15));
    fireEvent.click(dialog.querySelector<HTMLButtonElement>(`button[data-iso="${iso}"]`)!);
    expect(view.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(view.posted).toHaveLength(1));
    expect(Object.keys(view.posted[0]!).sort()).toEqual(["_csrf", "dueDate", "intent"]);
    expect(view.posted[0]!.dueDate).toBe(iso);
    cleanup();
    const dated = renderCapturing({ dueDate: iso }, true);
    fireEvent.click(trigger(dated, "Due date"));
    fireEvent.click(within(dated.getByRole("dialog", { name: "Due date" })).getByRole("button", { name: /Clear due date/ }));
    await waitFor(() => expect(dated.posted).toHaveLength(1));
    expect(dated.posted[0]).toMatchObject({ intent: "set-task-metadata", dueDate: "" });
  });

  it("an archived task's values are text, with the reason under them", () => {
    const { container, getByText } = renderCapturing({ archived: true, priority: "urgent" }, true);
    expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(getByText("Archived. Restore this task to edit its details.")).toBeTruthy();
    expect(kv(container, "Priority")).toContain("urgent");
  });
});

/** Ruling 138: the rail says a goal edit is owed on a decided edit_goal packet. */
describe("ruling 138: Waiting on · a decided edit_goal packet", () => {
  it("reads 'a goal edit' instead of 'a human'", () => {
    // Canary: remove the `awaiting === "goal_edit"` branch.
    const { container } = renderPanel({
      waiting: "human",
      packet: {
        type: "blocked",
        kind: "Blocked decision",
        from: "Operator",
        title: "Scope needed",
        body: "",
        observations: [],
        options: [{ kind: "edit_goal", t: "Specify the goal", d: "", rec: true }],
        awaiting: "goal_edit",
        decided: { optionIndex: 0, at: "2026-09-04T10:00:00.000Z", byUserId: "u-arda" },
      },
    });
    expect(kv(container, "Waiting on")).toBe("a goal edit");
  });
});
