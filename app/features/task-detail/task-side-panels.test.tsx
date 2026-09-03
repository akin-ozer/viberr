// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import type { TaskDetail } from "~/server/projections/task-query.server";
import type { AcceptanceAffordance } from "~/server/tasks/task-actions.server";
import { ToastProvider } from "~/ui/toast";
import { CurrentStatePanel, TaskDetailsPanel } from "./task-side-panels";

/**
 * Pass-19 gap 10 — the task page showed stage, readiness, validation, owner and
 * repo, and nowhere in the app could a supervisor find out WHEN anything last
 * happened on a task. `TaskSummary.updatedAt` was projected and read by nothing
 * at task level, and it would have been the wrong answer anyway (see the essay
 * in app/server/projections/task-activity.server.ts).
 */

afterEach(cleanup);

const STAGES = [
  { id: "triage", name: "Triage", color: "#a5a8b5" },
  { id: "review", name: "Review", color: "#5b76fe" },
  { id: "done", name: "Done", color: "#00b473" },
];

const ACCEPTANCE: AcceptanceAffordance = {
  hasAuthority: false,
  atBoundary: false,
  blockedReason: null,
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
    changed: null,
    unownedPr: null,
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
          acceptBusy={false}
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
          acceptBusy={false}
          dispositionBusy={false}
        />
      ),
    },
  ]);
  return render(<Stub initialEntries={["/"]} />);
}

/**
 * Ruling 121 — the owner seat is also the RUN PRINCIPAL: every agent run on a
 * task bills the owner's own Claude and Codex accounts. The Current-state row
 * is where a person sees and releases that seat, so it is where the widened
 * meaning has to be stated; the run controls in the execution profile then
 * name the owner when a backend of theirs is not connected.
 */
describe("the owner row states what the seat now means (ruling 121)", () => {
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

function renderDetails(patch: Partial<TaskDetail>, canEdit: boolean) {
  const task = detail(patch);
  const Stub = createRoutesStub([
    {
      path: "/",
      Component: () => (
        <ToastProvider>
          <TaskDetailsPanel task={task} canEdit={canEdit} />
        </ToastProvider>
      ),
      action: async () => ({ ok: true }),
    },
  ]);
  return render(<Stub initialEntries={["/"]} />);
}

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

  it("shows 'Normal / None / None' for a bare task", () => {
    const { container } = renderDetails({}, false);
    expect(kv(container, "Priority")).toContain("Normal");
    expect(kv(container, "Labels")).toContain("None");
    expect(kv(container, "Due date")).toContain("None");
  });

  it("offers the editor only to an editor, and opening it reveals the form", () => {
    const viewer = renderDetails({}, false);
    expect(viewer.queryByRole("button", { name: /Edit details/ })).toBeNull();
    cleanup();

    const editor = renderDetails({ priority: "high" }, true);
    const edit = editor.getByRole("button", { name: /Edit details/ });
    fireEvent.click(edit);
    // The inline form appears with the priority select, the token label input,
    // and the calendar date-picker trigger.
    expect(editor.getByLabelText(/Add a label/)).toBeTruthy();
    expect(editor.container.querySelector(".datepick-trigger")).toBeTruthy();
    expect(editor.getByRole("button", { name: "Save" })).toBeTruthy();
  });
});
