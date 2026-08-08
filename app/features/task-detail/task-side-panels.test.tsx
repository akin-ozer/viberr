// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import type { TaskDetail } from "~/server/projections/task-query.server";
import type { AcceptanceAffordance } from "~/server/tasks/task-actions.server";
import { CurrentStatePanel } from "./task-side-panels";

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
    readiness: "in_review",
    displayReadiness: "in_review",
    waiting: "agent",
    urgent: false,
    archived: false,
    validation: "healthy",
    blockReason: null,
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
    quiet: false,
    ...patch,
  } as unknown as TaskDetail;
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
          onAcceptViaStage={() => {}}
          acceptBusy={false}
          dispositionBusy={false}
        />
      ),
    },
  ]);
  return render(<Stub initialEntries={["/"]} />);
}

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
