// @vitest-environment jsdom
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import type { TaskSummary } from "~/shared/mapping/task.server";
import { rolesForAction } from "~/shared/rbac";
import {
  ExecutionProfile,
  type DeployedSpecialistView,
} from "./execution-profile";

afterEach(cleanup);

/**
 * F19-11 — the human-owner cell described ownership as "open to any project
 * member" while the control rendered beside it, in the SAME cell, said "a
 * contributor or above can take it". `own-task` is admin/maintainer/contributor
 * (app/shared/rbac.ts) and a viewer IS a project member, so the first line
 * misdescribed the matrix — and a viewer saw both sentences at once.
 */

const deployedFixture: DeployedSpecialistView[] = [
  { id: "developer", name: "Developer", role: "Implementation", backend: "codex", model: "codex-large" },
];

/** An UNOWNED task — `owner: null` is the branch this finding lives in. The
 *  rest is a neutral projection row: nothing here is accepted/merged/archived,
 *  so the section renders its live controls. */
function unownedTask(): TaskSummary {
  return {
    key: "VIB-151",
    title: "Compress long-running task timelines",
    projectSlug: "viberr-core",
    stage: "impl",
    readiness: "ready",
    displayReadiness: "ready",
    waiting: "agent",
    urgent: false,
    priority: "normal",
    labels: [],
    dueDate: null,
    archived: false,
    validation: "healthy",
    continuity: null,
    blockReason: null,
    atAcceptanceBoundary: false,
    packet: null,
    owner: null,
    specialist: null,
    reviewers: [],
    operator: null,
    branch: null,
    repo: null,
    pr: null,
    prChecks: null,
    prReview: null,
    commits: [],
    changed: null,
    goal: "Keep the console readable on long runs.",
    eventCount: 0,
    commentCount: 0,
    diagnosticCount: 0,
    createdAt: null,
    updatedAt: null,
    boardRank: null,
    filePath: "projects/viberr-core/tasks/VIB-151/task.md",
  };
}

function renderExec(props: Partial<ComponentProps<typeof ExecutionProfile>> = {}) {
  return render(
    <MemoryRouter>
      <ExecutionProfile
        task={unownedTask()}
        meId="u-arda"
        myRole="admin"
        busy={false}
        onOwner={() => {}}
        deployedSpecialists={deployedFixture}
        operatorBackend="claude"
        operatorAutonomy="supervised"
        backendAvailable={{ claude: true, codex: true }}
        canRunAgents
        deliveringActive={false}
        activeReviewerIds={[]}
        operatorRunActive={false}
        runBusy={false}
        onAssignSpecialist={() => {}}
        onRunSpecialist={() => {}}
        reviewerBusy={false}
        onAssignReviewer={() => {}}
        onRunReviewer={() => {}}
        onRemoveReviewer={() => {}}
        operatorBusy={false}
        onRunOperator={() => {}}
        {...props}
      />
    </MemoryRouter>,
  );
}

// The unowned-eligibility line as the merged component actually ships it
// (execution-profile.tsx took Session B's file per RECONCILE §1.1). B words it
// "any contributor or above"; A's earlier copy said "a contributor or above".
// Both are TRUE against the RBAC matrix — `own-task` is admin/maintainer/
// contributor, viewer excluded (asserted directly below) — so F19-11's
// invariant (one eligibility line, matching the matrix, no contradicting
// sibling) holds under B's wording; the test tracks the shipped sentence.
const OWNERSHIP_COPY = "Unowned. Any contributor or above can take it";

describe("ExecutionProfile — unowned copy matches the RBAC matrix (F19-11)", () => {
  it("the matrix this copy claims: own-task excludes viewer", () => {
    // The copy says "a contributor or above". If the matrix ever widens
    // `own-task` to viewers (or narrows it past contributor), this test fails
    // FIRST and the sentence gets rewritten with it.
    const roles = rolesForAction("own-task");
    expect([...roles].sort()).toEqual(["admin", "contributor", "maintainer"]);
    expect(roles).not.toContain("viewer");
  });

  it("an unowned task never claims ownership is open to any project member", () => {
    const { container } = renderExec();
    expect(container.textContent).not.toContain("open to any project member");
  });

  it("admin: the eligibility line is stated once, next to the take affordance", () => {
    const { container, getAllByText } = renderExec({ myRole: "admin" });
    expect(getAllByText(OWNERSHIP_COPY)).toHaveLength(1);
    // The affordance itself is still offered to a role that holds `own-task`.
    expect(
      [...container.querySelectorAll("button")].some((b) =>
        b.textContent?.includes("Assign me"),
      ),
    ).toBe(true);
  });

  it("viewer: same single line, no take affordance, no contradicting sibling", () => {
    const { container, getAllByText } = renderExec({
      myRole: "viewer",
      canRunAgents: false,
    });
    expect(getAllByText(OWNERSHIP_COPY)).toHaveLength(1);
    // And it is the ONLY ownership sentence: the pre-fix render printed the
    // (wrong) cell copy AND the control's own sentence — two claims about who
    // may own, disagreeing, side by side in one cell.
    expect(getAllByText(/^Unowned/)).toHaveLength(1);
    expect(
      [...container.querySelectorAll("button")].some((b) =>
        b.textContent?.includes("Assign me"),
      ),
    ).toBe(false);
  });
});

/**
 * The operator run's steer input (pass 22). It is a SINGLE-LINE input, so Enter
 * submits (the search/chat convention) — deliberately NOT ⌘/Ctrl+Enter, which
 * the multi-line composer needs only because Enter is a newline there. The one
 * hazard is IME composition: an Enter that merely confirms a multibyte
 * candidate must not launch the billable operator run.
 */
describe("OperatorRunControl steer input — Enter submits, IME-guarded", () => {
  function renderWithRunSpy() {
    const calls: string[] = [];
    const utils = renderExec({ onRunOperator: (s) => calls.push(s) });
    const input = utils.container.querySelector<HTMLInputElement>(".op-steer")!;
    return { calls, input };
  }

  it("a bare Enter runs the operator with the trimmed steer text", () => {
    const { calls, input } = renderWithRunSpy();
    fireEvent.change(input, { target: { value: "  focus on the flaky test  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(calls).toEqual(["focus on the flaky test"]);
  });

  it("an Enter that only confirms an IME candidate does NOT launch the run (Chrome + Safari)", () => {
    const { calls, input } = renderWithRunSpy();
    fireEvent.change(input, { target: { value: "日本語" } });
    // Chrome/Firefox: the committing keydown carries isComposing = true.
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    // Safari/WebKit: compositionend fires FIRST, so isComposing is already
    // false and only the legacy keyCode 229 marks the composition commit.
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    expect(calls).toEqual([]);
    // A real Enter after composition ends still submits.
    fireEvent.keyDown(input, { key: "Enter" });
    expect(calls).toEqual(["日本語"]);
  });
});

/**
 * F3 (owner ruling 2026-08-21): a real run can show the delivering agent's model
 * is not runnable on the account (model_availability). Surface it at the run
 * control — BEFORE another run is spent — not only as a run failure.
 */
describe("run control warns when the delivering agent's model is unavailable", () => {
  const withDeveloper = (): TaskSummary => ({
    ...unownedTask(),
    specialist: {
      kind: "agent",
      profileId: "developer",
      backend: "codex",
      name: "Codex",
      role: "Implementation",
    },
  });
  const unavailNote = (container: HTMLElement) =>
    [...container.querySelectorAll(".deny-note")].find((n) =>
      /reported this model unavailable/.test(n.textContent ?? ""),
    );

  it("renders the provider's reason on the delivering-agent card", () => {
    const { container } = renderExec({
      task: withDeveloper(),
      deployedSpecialists: [
        {
          ...deployedFixture[0]!,
          id: "developer",
          backend: "codex",
          modelUnavailable: "The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account.",
        },
      ],
    });
    const note = unavailNote(container);
    expect(note).toBeTruthy();
    expect(note!.textContent).toContain("Codex reported this model unavailable");
    expect(note!.textContent).toContain("not supported when using Codex");
  });

  it("shows NO warning when the model is available (the common case)", () => {
    const { container } = renderExec({
      task: withDeveloper(),
      deployedSpecialists: [
        { ...deployedFixture[0]!, id: "developer", backend: "codex" },
      ],
    });
    expect(unavailNote(container)).toBeUndefined();
  });

  it("warns on a REVIEWER row too, not only the delivering agent", () => {
    const task: TaskSummary = {
      ...withDeveloper(),
      reviewers: [
        {
          kind: "agent",
          profileId: "reviewer",
          backend: "claude",
          name: "Claude",
          role: "Review & validation",
        },
      ],
    };
    const { container } = renderExec({
      task,
      deployedSpecialists: [
        { ...deployedFixture[0]!, id: "developer", backend: "codex" },
        {
          ...deployedFixture[0]!,
          id: "reviewer",
          backend: "claude",
          role: "Review & validation",
          modelUnavailable:
            "The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account.",
        },
      ],
    });
    // The reviewer's own run-spending control carries the same pre-spend warning.
    const revNote = [...container.querySelectorAll(".rev-agent .deny-note")].find(
      (n) => /reported this model unavailable/.test(n.textContent ?? ""),
    );
    expect(revNote).toBeTruthy();
    expect(revNote!.textContent).toContain("not supported when using Codex");
  });
});
