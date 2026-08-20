// @vitest-environment jsdom
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import type { TaskSummary } from "~/shared/mapping/task.server";
import { rolesForAction } from "~/shared/rbac";
import {
  ExecutionProfile,
  type DeployedSpecialistView,
  type TaskMemberView,
} from "./execution-profile";

afterEach(cleanup);

/**
 * F19-11 — the human-owner cell described ownership as "open to any project
 * member" while the control rendered beside it, in the SAME cell, said "a
 * contributor or above can take it". `own-task` is admin/maintainer/contributor
 * (app/shared/rbac.ts) and a viewer IS a project member, so the first line
 * misdescribed the matrix — and a viewer saw both sentences at once.
 */

const membersFixture: TaskMemberView[] = [
  { userId: "u-elif", role: "admin", user: { name: "Elif Demir", initials: "ED", tone: "rose" } },
  { userId: "u-arda", role: "viewer", user: { name: "Arda Kaya", initials: "AK", tone: "" } },
];

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
        members={membersFixture}
        busy={false}
        onOwner={() => {}}
        onRelease={() => {}}
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
