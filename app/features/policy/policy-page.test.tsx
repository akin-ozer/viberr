// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { MembershipView } from "~/features/project-settings/membership.server";
import type { TransitionView } from "./policy-query.server";
import { AgentCapability, HumanAccess, WorkflowRules, type PcapProfile } from "./policy-page";

afterEach(cleanup);

const MEMBERS: MembershipView[] = [
  { userId: "u_elif", role: "admin", status: "active", name: "Elif Demir", email: "elif@viberr.dev", initials: "ED", tone: "rose" },
  { userId: "u_arda", role: "admin", status: "active", name: "Arda Kaya", email: "arda@viberr.dev", initials: "AK", tone: "" },
  { userId: "u_murat", role: "maintainer", status: "active", name: "Murat Yıldız", email: "murat@viberr.dev", initials: "MY", tone: "teal" },
  { userId: "u_selin", role: "contributor", status: "active", name: "Selin Aksoy", email: "selin@viberr.dev", initials: "SA", tone: "violet" },
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
    // Grant rows (derived from PROJECT_CAP_MATRIX).
    expect(container.querySelectorAll(".rbac-table tbody tr")).toHaveLength(11);
    expect(getByText("Release any task owner")).toBeTruthy();
    expect(getByText("Create tasks")).toBeTruthy();

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
