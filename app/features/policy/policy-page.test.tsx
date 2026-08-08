// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { MembershipView } from "~/features/project-settings/membership.server";
import type { TransitionView } from "./policy-query.server";
import { AgentCapability, HumanAccess, WorkflowRules, type PcapProfile } from "./policy-page";
import { ROLE_IDS } from "./policy-data";

afterEach(cleanup);

const MEMBERS: MembershipView[] = [
  { userId: "u_elif", role: "admin", name: "Elif Demir", email: "elif@viberr.dev", initials: "ED", tone: "rose", missing: false, disabled: false },
  { userId: "u_arda", role: "admin", name: "Arda Kaya", email: "arda@viberr.dev", initials: "AK", tone: "", missing: false, disabled: false },
  { userId: "u_murat", role: "maintainer", name: "Murat Yıldız", email: "murat@viberr.dev", initials: "MY", tone: "teal", missing: false, disabled: false },
  { userId: "u_selin", role: "contributor", name: "Selin Aksoy", email: "selin@viberr.dev", initials: "SA", tone: "violet", missing: false, disabled: false },
];

const STAGES = [
  { id: "triage", name: "Triage", color: "#a5a8b5" },
  { id: "ready", name: "Ready", color: "#187574" },
  { id: "impl", name: "In Progress", color: "#7b61ff" },
  { id: "review", name: "Review", color: "#5b76fe" },
  { id: "done", name: "Done", color: "#00b473" },
];

const TRANSITIONS: TransitionView[] = [
  { from: "triage", to: "ready", by: "Human, after the quality gate — agents may flag underspecified tasks", boundary: "approval", locked: false },
  { from: "ready", to: "impl", by: "Operator, when a primary specialist is assigned", boundary: "auto", locked: false },
  { from: "impl", to: "review", by: "Operator transition request, with evidence attached", boundary: "approval", locked: false },
  { from: "review", to: "done", by: "Human acceptance of the completion report", boundary: "human", locked: true },
];

const PROFILES: PcapProfile[] = [
  {
    id: "operator", kind: "operator", name: "Operator", icon: "shield", role: "Task coordinator",
    actions: { direct: ["a", "b", "c", "d", "e"], recommend: ["f", "g", "h"], forbidden: ["i", "j", "k"] },
  },
  {
    id: "developer", kind: "specialist", name: "Developer", icon: "branch", role: "Implementation",
    actions: { direct: ["a", "b", "c", "d"], recommend: ["e", "f"], forbidden: ["g", "h", "i"] },
  },
];

describe("HumanAccess", () => {
  it("renders member rows with role radios and the derived grant table with live counts", () => {
    const onSetRole = vi.fn();
    const { container, getByText } = render(
      <HumanAccess
        projectName="Viberr Core"
        members={MEMBERS}
        canManage
        busy={false}
        onSetRole={onSetRole}
      />,
    );
    expect(getByText("Human access · RBAC")).toBeTruthy();
    expect(getByText("4 members")).toBeTruthy();
    expect(container.querySelectorAll(".member-row")).toHaveLength(4);
    // Header counts derive live from the same member array.
    expect(getByText("Admin · 2")).toBeTruthy();
    expect(getByText("Maintainer · 1")).toBeTruthy();
    // Grant rows (derived from PROJECT_CAP_MATRIX) — total table, every enforced action.
    expect(container.querySelectorAll(".rbac-table tbody tr")).toHaveLength(18);
    expect(getByText("Release any task owner")).toBeTruthy();
    expect(getByText("Create tasks")).toBeTruthy();
    expect(getByText("Re-scan project files & projections")).toBeTruthy();
    // Newly-surfaced enforced actions (were hidden before the total-table fix).
    expect(getByText("Reconcile GitHub state")).toBeTruthy();
    expect(getByText("Manage agent profiles")).toBeTruthy();
    // E1: EVERY row is a per-role row — the merged "Any signed-in user ·
    // membership not required" cell is gone, because enforcement 404s a
    // signed-in non-member on every page of the project (board, task, policy)
    // and on a comment POST. The View row now reads as four role grants.
    for (const row of container.querySelectorAll(".rbac-table tbody tr")) {
      expect(row.querySelectorAll("td")).toHaveLength(1 + ROLE_IDS.length);
      expect(row.querySelector("[colspan]")).toBeNull();
    }
    const viewRow = [...container.querySelectorAll(".rbac-table tbody tr")].find(
      (r) => r.querySelector(".act")!.textContent === "View board, tasks & timelines",
    )!;
    expect(viewRow.querySelectorAll(".rbac-yes")).toHaveLength(4);
    // The claim that made display contradict enforcement must not survive
    // anywhere on the surface — cell copy or footnote.
    expect(container.textContent).not.toContain("membership not required");
    expect(container.textContent).not.toContain("member or not");
    expect(container.textContent).toContain("this project is members-only");

    // Selecting a new role dispatches; re-selecting the current one no-ops.
    const selinSeg = container.querySelectorAll(".mini-seg")[3]!;
    fireEvent.click(selinSeg.querySelector('[aria-checked="true"]')!);
    expect(onSetRole).not.toHaveBeenCalled();
    fireEvent.click(Array.from(selinSeg.querySelectorAll("button")).find((b) => b.textContent === "Viewer")!);
    expect(onSetRole).toHaveBeenCalledWith(MEMBERS[3], "viewer");
  });

  it("blocks demoting the last admin client-side (server re-checks)", () => {
    const onSetRole = vi.fn();
    const oneAdmin = MEMBERS.map((m) =>
      m.userId === "u_elif" ? { ...m, role: "maintainer" as const } : m,
    );
    const { container } = render(
      <HumanAccess
        projectName="Viberr Core"
        members={oneAdmin}
        canManage
        busy={false}
        onSetRole={onSetRole}
      />,
    );
    const ardaSeg = container.querySelectorAll(".mini-seg")[1]!;
    fireEvent.click(Array.from(ardaSeg.querySelectorAll("button")).find((b) => b.textContent === "Viewer")!);
    expect(onSetRole).not.toHaveBeenCalled();
  });

  it("disables the role picker for non-admins", () => {
    const { container } = render(
      <HumanAccess
        projectName="Viberr Core"
        members={MEMBERS}
        canManage={false}
        busy={false}
        onSetRole={() => {}}
      />,
    );
    const buttons = container.querySelectorAll(".mini-seg button");
    expect(Array.from(buttons).every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
  });
});

describe("AgentCapability", () => {
  it("renders per-profile counts, the invariant list, and profile deep-links", () => {
    const onOpenProfile = vi.fn();
    const { container, getByText, getAllByText } = render(
      <AgentCapability
        profiles={PROFILES}
        onOpenProfile={onOpenProfile}
        onManageProfiles={() => {}}
        onMatrix={() => {}}
      />,
    );
    expect(getByText("2 profiles")).toBeTruthy();
    expect(getByText("5 direct")).toBeTruthy();
    expect(getAllByText("3 human")).toHaveLength(2); // operator + developer
    // Always-human list comes from the server invariant catalog (ruling 2).
    expect(getByText("Merge a pull request")).toBeTruthy();
    expect(getByText("Transition a task to Done")).toBeTruthy();
    expect(getByText("Change project policy")).toBeTruthy();
    expect(container.querySelectorAll(".ho-row")).toHaveLength(3);

    fireEvent.click(container.querySelectorAll(".pcap-row")[1]!);
    expect(onOpenProfile).toHaveBeenCalledWith("developer");
  });

  // P14-WL-05: the library deploy copies the NAME into `role` when a template
  // declares none, and this row printed it raw — the deployed "Org Docs Writer"
  // read "Org Docs Writer · Org Docs Writer" here.
  it("a role that only repeats the name renders as what the profile IS", () => {
    const { container } = render(
      <AgentCapability
        profiles={[
          { ...PROFILES[1]!, id: "docs", name: "Org Docs Writer", role: "Org Docs Writer" },
        ]}
        onOpenProfile={() => {}}
        onManageProfiles={() => {}}
        onMatrix={() => {}}
      />,
    );
    const row = container.querySelector(".pcap-main")!;
    expect(row.querySelector(".nm")!.textContent).toBe("Org Docs Writer");
    expect(row.querySelector(".sub")!.textContent).toBe("Specialist");
  });

  it("keeps a real role verbatim", () => {
    const { container } = render(
      <AgentCapability
        profiles={[PROFILES[1]!]}
        onOpenProfile={() => {}}
        onManageProfiles={() => {}}
        onMatrix={() => {}}
      />,
    );
    expect(
      container.querySelector(".pcap-main .sub")!.textContent,
    ).toBe("Implementation");
  });
});

describe("WorkflowRules", () => {
  it("renders the flow map, boundary segs with the BCLS classes, and the locked row", () => {
    const onSetBoundary = vi.fn();
    const { container, getByText } = render(
      <WorkflowRules
        stages={STAGES}
        transitions={TRANSITIONS}
        canManage
        busy={false}
        onSetBoundary={onSetBoundary}
      />,
    );
    expect(getByText("5 stages · 4 transition rules")).toBeTruthy();
    expect(container.querySelectorAll(".flow-map .stage-chip")).toHaveLength(5);
    expect(container.querySelectorAll(".trans-row")).toHaveLength(4);

    // Locked review→done row: cap-seg.locked + disabled buttons + badge.
    const locked = container.querySelector(".cap-seg.locked")!;
    expect(locked).not.toBeNull();
    expect(
      Array.from(locked.querySelectorAll("button")).every(
        (b) => (b as HTMLButtonElement).disabled,
      ),
    ).toBe(true);
    expect(getByText("locked · V1")).toBeTruthy();

    // BCLS visual language: auto→direct, approval→recommend, human→human.
    const rows = container.querySelectorAll(".trans-row");
    expect(rows[1]!.querySelector(".cap-seg button.direct.on")).not.toBeNull();
    expect(rows[0]!.querySelector(".cap-seg button.recommend.on")).not.toBeNull();
    expect(rows[3]!.querySelector(".cap-seg button.human.on")).not.toBeNull();

    // Changing an unlocked boundary dispatches with from/to ids.
    fireEvent.click(
      Array.from(rows[2]!.querySelectorAll(".cap-seg button")).find(
        (b) => b.textContent === "Auto-advance",
      )!,
    );
    expect(onSetBoundary).toHaveBeenCalledWith(TRANSITIONS[2], "auto");

    // Clicking a locked boundary never dispatches.
    fireEvent.click(
      Array.from(rows[3]!.querySelectorAll(".cap-seg button")).find(
        (b) => b.textContent === "Auto-advance",
      )!,
    );
    expect(onSetBoundary).toHaveBeenCalledTimes(1);
  });

  // P13-D-1: the flow map used to draw an arrow between every consecutive stage
  // POSITION, so it depicted a governed path the project did not have.
  it("draws the flow map from the transition rules, not the column order", () => {
    const { container } = render(
      <WorkflowRules
        // Columns reordered; the rules still describe the governed path.
        stages={[STAGES[0]!, STAGES[3]!, STAGES[2]!, STAGES[1]!, STAGES[4]!]}
        transitions={TRANSITIONS}
        canManage={false}
        busy={false}
        onSetBoundary={() => {}}
      />,
    );
    expect(
      Array.from(container.querySelectorAll(".flow-map .stage-chip")).map((c) =>
        c.textContent?.trim(),
      ),
    ).toEqual(["Triage", "Ready", "In Progress", "Review", "Done"]);
  });

  it("marks a stage no rule reaches as off the governed path instead of drawing it mid-flow", () => {
    const { container, getByText } = render(
      <WorkflowRules
        stages={[
          ...STAGES.slice(0, 4),
          { id: "qa", name: "QA", color: "#7b61ff" },
          STAGES[4]!,
        ]}
        transitions={TRANSITIONS}
        canManage={false}
        busy={false}
        onSetBoundary={() => {}}
      />,
    );
    expect(getByText("6 stages · 4 transition rules")).toBeTruthy();
    // 5 on-chain chips (.elig) + 1 off-chain chip, and the arrows only span the
    // real chain (4 hops), never the orphan.
    expect(container.querySelectorAll(".flow-map .stage-chip")).toHaveLength(6);
    expect(container.querySelectorAll(".flow-map .stage-chip.elig")).toHaveLength(5);
    expect(container.querySelectorAll(".flow-map .flow-arr")).toHaveLength(4);
    const orphan = container.querySelector(
      ".flow-map .stage-chip:not(.elig)",
    )!;
    expect(orphan.textContent?.trim()).toBe("QA");
    expect(orphan.getAttribute("title")).toBe(
      "No transition rule reaches this stage",
    );
    // …and the panel says so in words, naming the stage.
    // F18-14: the copy avoids the banned "governed" word.
    expect(container.textContent).toContain("Off the workflow path:");
    expect(container.textContent).not.toContain("Off the governed path:");
    expect(container.querySelector(".pol-note strong")!.textContent).toBe("QA");
  });

  it("survives a transition referencing an unknown stage id (defensive lookup)", () => {
    const { getByText } = render(
      <WorkflowRules
        stages={STAGES.filter((s) => s.id !== "review")}
        transitions={TRANSITIONS}
        canManage={false}
        busy={false}
        onSetBoundary={() => {}}
      />,
    );
    // Falls back to rendering the raw id instead of crashing.
    expect(getByText("Human acceptance of the completion report")).toBeTruthy();
  });
});

// E4: a disabled boundary radio used to be the whole message — dimmed, inert,
// and silent. `locked` had a chip on its row; "your role may not change this"
// had nothing anywhere, and a `title` would never have opened on a disabled
// button. These pin the visible reason and the two cases staying distinct.
describe("WorkflowRules — the not-permitted case says why", () => {
  const render1 = (canManage: boolean) =>
    render(
      <WorkflowRules
        stages={STAGES}
        transitions={TRANSITIONS}
        canManage={canManage}
        busy={false}
        onSetBoundary={() => {}}
      />,
    );

  it("a non-manager gets every radio disabled AND a visible reason", () => {
    const { container } = render1(false);
    expect(
      Array.from(container.querySelectorAll(".cap-seg button")).every(
        (b) => (b as HTMLButtonElement).disabled,
      ),
    ).toBe(true);
    const note = container.querySelector(".deny-note");
    expect(note).not.toBeNull();
    // Names the grant, not just "no permission" — the reader has to know what
    // to ask for.
    expect(note!.textContent).toContain("Edit workflow & policy");
  });

  it("a manager gets no denial note, and `locked` keeps its own separate chip", () => {
    const { container, getByText } = render1(true);
    expect(container.querySelector(".deny-note")).toBeNull();
    // The V1 lock is a different reason and must survive independently: it
    // still applies to a manager.
    expect(getByText("locked · V1")).toBeTruthy();
  });
});

/* F19-33: all three panel heads on this page took their count's type scale from
   a private `PANEL_COUNT_STYLE = { fontSize: ".76rem", color: "var(--faint)" }`
   — a byte copy of the sheet's `.fine` (app.css:230) that seven other panel
   heads already opt into by name, and that github-view.tsx and settings-page.tsx
   each kept their own copy of. app.css.test.ts holds the structural gate (no
   style object, hoisted or inline, may restate a utility rule); these assert
   what this surface actually renders. Ruling 14: never fork per surface. */
describe("policy panel heads take their count styling from the sheet (F19-33)", () => {
  const expectSheetStyledCount = (container: HTMLElement) => {
    const count = container.querySelector(".panel-head .right")!;
    expect(count.className.split(/\s+/)).toEqual(["right", "sub", "fine"]);
    expect(count.getAttribute("style")).toBeNull();
  };

  it("Human access · RBAC", () => {
    const { container } = render(
      <HumanAccess
        projectName="Viberr Core"
        members={MEMBERS}
        canManage
        busy={false}
        onSetRole={() => {}}
      />,
    );
    expectSheetStyledCount(container);
  });

  it("Agent capability", () => {
    const { container } = render(
      <AgentCapability
        profiles={PROFILES}
        onOpenProfile={() => {}}
        onManageProfiles={() => {}}
        onMatrix={() => {}}
      />,
    );
    expectSheetStyledCount(container);
  });

  it("Workflow rules", () => {
    const { container } = render(
      <WorkflowRules
        stages={STAGES}
        transitions={TRANSITIONS}
        canManage
        busy={false}
        onSetBoundary={() => {}}
      />,
    );
    expectSheetStyledCount(container);
  });
});
