// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { MembershipView } from "~/features/project-settings/membership.server";
import type { TransitionView } from "./policy-query.server";
import { AgentCapability, Guardrails, HumanAccess, RequiredReviewers, WorkflowRules, type PcapProfile } from "./policy-page";
import type { GuardrailView } from "./policy-query.server";
import type { RequiredReviewerView } from "~/server/tasks/required-reviewers.server";
import { ROLE_IDS, operatorAutonomyState } from "./policy-data";

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
  { from: "ready", to: "impl", by: "Operator, when a delivering agent is assigned", boundary: "auto", locked: false },
  { from: "impl", to: "review", by: "Operator transition request, with evidence attached", boundary: "approval", locked: false },
  { from: "review", to: "done", by: "Human acceptance of the completion report", boundary: "human", locked: true },
];

// D-2 (pass 24): the policy counts now sum only GOVERNED capability labels (the
// same partition the profile detail uses), so these fixtures carry REAL governed
// labels — an advisory/group-null label would (correctly) not be counted.
const PROFILES: PcapProfile[] = [
  {
    id: "operator", kind: "operator", name: "Operator", icon: "shield", role: "Task coordinator",
    backends: ["claude"],
    capabilities: [],
    actions: {
      direct: [
        // Dynamic-dispatch rework (2026-08-29): the retired assign/summon slot
        // labels collapsed into the one `dispatch-agents` label below.
        "Select & run agents",
        "Generate decision & blocking packets",
        "Append typed important events",
        "Deliver the branch & open the review PR",
      ],
      recommend: [
        "Stage transitions",
        "Accept completion into Done",
        "Bring the task branch up to date",
      ],
      forbidden: [
        "Merge a pull request",
        "Transition a task to Done",
        "Change project policy",
      ],
    },
  },
  {
    id: "developer", kind: "specialist", name: "Developer", icon: "branch", role: "Implementation",
    backends: ["claude"],
    capabilities: [],
    actions: {
      direct: [
        "Post mid-run comments",
        "Ask the human a question",
        "Search & fetch from the web",
        "Attach evidence references",
      ],
      recommend: ["Read GitHub repository & PR data", "Drive a live web browser"],
      forbidden: [
        "Merge a pull request",
        "Transition a task to Done",
        "Report a validation verdict",
      ],
    },
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
    expect(container.querySelectorAll(".rbac-table tbody tr")).toHaveLength(19);
    expect(getByText("Release any task owner")).toBeTruthy();
    expect(getByText("Edit task priority, labels & due date")).toBeTruthy();
    // Ruling 309(a): two grants gate more than their name says. The name stays
    // short because sentences elsewhere on this page read it inline ("needs the
    // Edit workflow & policy grant"), so the SCOPE lives in the table — which is
    // the surface a person opens to learn what a role can do. Without it, "who
    // can unarchive this project?" has no answer anywhere in the product, and a
    // contributor reads that they may tidy metadata when they may also release
    // a held task onto the board.
    // CANARY: stop threading `covers` into RBAC_ROWS and both lines vanish.
    expect(
      getByText("and what a task waits on, which releases it when cleared"),
    ).toBeTruthy();
    expect(getByText("and archiving or restoring the project itself")).toBeTruthy();
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
    // Ruling 148: the same words as the profile page's "Your access" list —
    // the check is aria-hidden, so a glyph-only cell was silent.
    expect(container.querySelector(".rbac-yes")!.textContent).toContain("yes");
    expect(container.querySelector(".rbac-no")!.textContent).toBe("no");
    expect(
      container.querySelector(".rbac-table")!.textContent,
    ).not.toContain("−");
    // The claim that made display contradict enforcement must not survive
    // anywhere on the surface — cell copy or footnote.
    expect(container.textContent).not.toContain("membership not required");
    expect(container.textContent).not.toContain("member or not");
    // D32-10 (pass 32): the cross-role rules are a four-item list, not a
    // paragraph — same facts, scannable.
    expect(container.textContent).toContain("This project is members-only");
    expect(container.querySelectorAll(".pol-rules li")).toHaveLength(4);
    // Review F12: a <ul> is flow content — its wrapper must not be a <span>.
    expect(container.querySelector(".pol-rules")!.parentElement!.tagName).toBe("DIV");
    // N20-7: the owner authority footnote now also documents that an owner may
    // resolve the operator's non-acceptance packet options, not just accept.
    expect(container.textContent).toContain(
      "may resolve the non-acceptance options on a decision packet",
    );

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

  /* U33-4 (owner, 2026-09-03): this used to assert the sixteen role buttons
     were `disabled` — and it would have kept passing forever once they were
     gone, because `[].every()` is true. It now pins the shape the owner ruled
     (ruling 65's withdrawn-not-disabled precedent): no picker at all for a
     reader, the member's role as a value, and the grant still named. */
  it("withdraws the role picker for a reader and renders the role as a value (U33-4)", () => {
    const { container, getAllByText, queryByText } = render(
      <HumanAccess
        projectName="Viberr Core"
        members={MEMBERS}
        canManage={false}
        busy={false}
        onSetRole={() => {}}
      />,
    );
    // No control of any kind: not a disabled one, not an empty radiogroup.
    expect(container.querySelectorAll(".mini-seg")).toHaveLength(0);
    expect(container.querySelectorAll('[role="radiogroup"]')).toHaveLength(0);
    expect(container.querySelectorAll(".member-row button")).toHaveLength(0);
    // …and the page stays the explanation: every row still states its role.
    const values = Array.from(container.querySelectorAll(".member-row .fine")).map(
      (v) => v.textContent,
    );
    expect(values).toEqual(["Admin", "Admin", "Maintainer", "Contributor"]);
    // The role words are the VALUES, not the table headers (those read "Admin · 2").
    expect(getAllByText("Admin")).toHaveLength(2);
    expect(queryByText("Viewer")).toBeNull(); // no member holds it → no dead chip
    // The note that used to explain a dimmed control now explains its absence,
    // and still names the grant the reader would have to ask for.
    const note = Array.from(container.querySelectorAll(".pol-note")).find((n) =>
      n.textContent!.includes("Read-only:"),
    );
    expect(note!.textContent).toContain("Manage members & roles");
  });

  // The reader's row loses the control, never the fact: a ghost membership
  // still reports the role it stores, exactly as a manager's view does.
  it("states the stored role for a removed account too (U33-4)", () => {
    const { container } = render(
      <HumanAccess
        projectName="Viberr Core"
        members={[{ ...MEMBERS[2]!, missing: true }]}
        canManage={false}
        busy={false}
        onSetRole={() => {}}
      />,
    );
    expect(container.querySelector(".member-row .fine")!.textContent).toBe(
      "Maintainer",
    );
  });

  it("keeps the full editable picker for a role that can manage members", () => {
    const { container } = render(
      <HumanAccess
        projectName="Viberr Core"
        members={MEMBERS}
        canManage
        busy={false}
        onSetRole={() => {}}
      />,
    );
    // 4 members × 4 roles, live — and the a11y shape UXA-7 fixed is intact.
    expect(container.querySelectorAll(".mini-seg")).toHaveLength(4);
    const buttons = container.querySelectorAll<HTMLButtonElement>(".mini-seg button");
    expect(buttons).toHaveLength(16);
    expect(Array.from(buttons).some((b) => b.disabled)).toBe(false);
    expect(
      container.querySelector('.mini-seg[aria-label="Role for Elif Demir"]'),
    ).not.toBeNull();
    expect(container.querySelectorAll('.mini-seg [aria-checked="true"]')).toHaveLength(4);
    // No denial note for someone who can act.
    expect(container.textContent).not.toContain("Read-only:");
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
      />,
    );
    expect(getByText("2 profiles")).toBeTruthy();
    // Both fixtures now count 4 governed direct labels (the operator's
    // collapsed `dispatch-agents` grant took its slot pair down to one row).
    expect(getAllByText("4 acts directly")).toHaveLength(2);
    expect(getAllByText("3 human-only")).toHaveLength(2); // operator + developer
    // Always-human list comes from the server invariant catalog (ruling 2).
    expect(getByText("Merge a pull request")).toBeTruthy();
    expect(getByText("Transition a task to Done")).toBeTruthy();
    expect(getByText("Change project policy")).toBeTruthy();
    expect(container.querySelectorAll(".ho-row")).toHaveLength(3);

    fireEvent.click(container.querySelectorAll(".pcap-row")[1]!);
    expect(onOpenProfile).toHaveBeenCalledWith("developer");
  });

  // F-P2 (pass 25): a Codex-primary profile's direct/recommend counts can
  // include grants that only BIND on Claude (e.g. "Post mid-run comments" —
  // comment-on-task is in CLAUDE_ONLY_ENFORCED_CAPABILITY_IDS) — advisory only
  // on Codex. Two identically-configured profiles differing only in backend
  // must not render identical counts with no way to tell them apart.
  it("F-P2: flags a Codex-primary profile whose counted grants are advisory there", () => {
    const codexDeveloper: PcapProfile = { ...PROFILES[1]!, id: "codex-dev", backends: ["codex"] };
    const { container, getAllByText } = render(
      <AgentCapability
        profiles={[codexDeveloper]}
        onOpenProfile={() => {}}
        onManageProfiles={() => {}}
      />,
    );
    expect(getAllByText("advisory on Codex")).toHaveLength(1);
    expect(container.textContent).toContain("advisory on Codex");
  });

  it("F-P2: a Claude-primary profile with the same grants shows no caveat", () => {
    const { container } = render(
      <AgentCapability
        profiles={[PROFILES[1]!]}
        onOpenProfile={() => {}}
        onManageProfiles={() => {}}
      />,
    );
    expect(container.textContent).not.toContain("advisory on Codex");
  });

  it("D6: a single profile reads '1 profile', not '1 profiles'", () => {
    const { getByText } = render(
      <AgentCapability
        profiles={[PROFILES[0]!]}
        onOpenProfile={() => {}}
        onManageProfiles={() => {}}
      />,
    );
    expect(getByText("1 profile")).toBeTruthy();
  });

  // P14-WL-05: the library deploy copies the NAME into `role` when a template
  // declares none, and this row printed it raw — the deployed "Org Docs Writer"
  // read "Org Docs Writer · Org Docs Writer" here.
  // U12 residual: the fallback said "Specialist", the retired third name for
  // this object (`DEFAULT_PROFILE_ROLE_LABEL`, agent-types.ts).
  it("a role that only repeats the name renders as what the profile IS", () => {
    const { container } = render(
      <AgentCapability
        profiles={[
          { ...PROFILES[1]!, id: "docs", name: "Org Docs Writer", role: "Org Docs Writer" },
        ]}
        onOpenProfile={() => {}}
        onManageProfiles={() => {}}
      />,
    );
    const row = container.querySelector(".pcap-main")!;
    expect(row.querySelector(".nm")!.textContent).toBe("Org Docs Writer");
    expect(row.querySelector(".sub")!.textContent).toBe("Agent profile");
  });

  it("keeps a real role verbatim", () => {
    const { container } = render(
      <AgentCapability
        profiles={[PROFILES[1]!]}
        onOpenProfile={() => {}}
        onManageProfiles={() => {}}
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
      Array.from(locked.querySelectorAll("button")).every((b) => b.disabled),
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
      Array.from(
        container.querySelectorAll<HTMLButtonElement>(".cap-seg button"),
      ).every((b) => b.disabled),
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

// F20-19: the human-accepts-completion note must state whether the always-human
// -Done exception is actually live on THIS project (configured operator
// autonomy + the Direct accept grant), so the conditional prose is no longer
// byte-identical whether the exception is active or not.
describe("WorkflowRules — states the project's operator autonomy (F20-19)", () => {
  const renderWith = (operator: Parameters<typeof WorkflowRules>[0]["operator"]) =>
    render(
      <WorkflowRules
        stages={STAGES}
        transitions={TRANSITIONS}
        canManage={false}
        busy={false}
        onSetBoundary={() => {}}
        operator={operator}
      />,
    );

  it("reads the exception as ACTIVE for a full-autonomy operator with the Direct grant", () => {
    const { container } = renderWith({
      present: true,
      autonomy: "full",
      directDoneLive: true,
      operatorName: "Operator",
    });
    const note = container.querySelector(".pol-note.after")!;
    expect(note.textContent).toContain("On this project:");
    expect(note.textContent).toContain("(Operator)");
    expect(note.textContent).toContain("is active");
    expect(note.textContent).not.toContain("not active");
  });

  it("reads the exception as NOT active for a supervised operator", () => {
    const { container } = renderWith({
      present: true,
      autonomy: "supervised",
      directDoneLive: false,
      operatorName: "Operator",
    });
    const note = container.querySelector(".pol-note.after")!;
    expect(note.textContent).toContain("supervised");
    expect(note.textContent).toContain("not active");
  });

  it("reads NOT active for full autonomy that lacks the Direct accept grant", () => {
    const { container } = renderWith({
      present: true,
      autonomy: "full",
      directDoneLive: false,
      operatorName: "Operator",
    });
    const note = container.querySelector(".pol-note.after")!;
    expect(note.textContent).toContain("without the Direct accept grant");
    expect(note.textContent).toContain("not active");
  });

  // Ruling 151 (pass 35): the closing sentence used to tell every reader that a
  // Direct-grant operator crosses the approval and human boundaries itself. The
  // engine refuses that now, so the note has to say the shipped rule.
  it("says the boundaries bind the operator too (ruling 151)", () => {
    const { container } = renderWith(undefined);
    const note = container.querySelector(".pol-note.after")!;
    expect(note.textContent).toContain("bind every actor, the operator included");
    expect(note.textContent).toContain("crosses Auto-advance boundaries only");
    expect(note.textContent).toContain("is refused to the operator");
    expect(note.textContent).not.toContain("crosses them itself");
    expect(note.textContent).not.toContain("the rule for people");
  });

  it("keeps the generic invariant (no per-project clause) when no roster is supplied", () => {
    const { container } = renderWith(undefined);
    const note = container.querySelector(".pol-note.after")!;
    expect(note.textContent).not.toContain("On this project:");
    // The canonical exception sentence still renders.
    expect(note.textContent).toContain("full autonomy");
  });
});

// F20-19 derivation: operatorAutonomyState reads the shared roster the same way
// the runtime gate does (full autonomy + `completion-for-acceptance: direct`).
describe("operatorAutonomyState (F20-19)", () => {
  const operator = (
    autonomy: "supervised" | "full",
    acceptMode: "direct" | "recommend" | "human" | "off",
  ) => ({
    kind: "operator" as const,
    name: "Operator",
    autonomy,
    capabilities: [
      { capabilityId: "completion-for-acceptance", mode: acceptMode },
    ],
  });

  it("is live only for full autonomy AND completion-for-acceptance direct", () => {
    expect(operatorAutonomyState([operator("full", "direct")])).toEqual({
      present: true,
      autonomy: "full",
      directDoneLive: true,
      operatorName: "Operator",
    });
    expect(operatorAutonomyState([operator("full", "recommend")]).directDoneLive).toBe(false);
    expect(operatorAutonomyState([operator("supervised", "direct")]).directDoneLive).toBe(false);
  });

  it("reports absent when no operator profile is deployed", () => {
    const specialist = {
      kind: "specialist" as const,
      name: "Developer",
      autonomy: undefined,
      capabilities: [],
    };
    expect(operatorAutonomyState([specialist])).toEqual({
      present: false,
      autonomy: null,
      directDoneLive: false,
      operatorName: null,
    });
  });

  it("prefers the operator that makes the exception live", () => {
    const state = operatorAutonomyState([
      operator("supervised", "off"),
      operator("full", "direct"),
    ]);
    expect(state.directDoneLive).toBe(true);
    expect(state.autonomy).toBe("full");
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

describe("Guardrails card (E32-6, pass 32)", () => {
  const rows: GuardrailView[] = [
    { id: "meaningful-comment", label: "Meaningful comments", desc: "Chatter is rejected.", on: true, value: null, unit: null, kind: "default", present: true },
    { id: "compression-threshold", label: "Compression threshold", desc: "Long timelines compress.", on: true, value: 40, unit: "events", kind: "default", present: true },
    { id: "evidence-separation", label: "Evidence separation", desc: "Raw output stays in evidence.", on: false, value: null, unit: null, kind: "default", present: false },
    { id: "delete-branch-after-merge", label: "Delete the task branch after merge", desc: "", on: true, value: null, unit: null, kind: "github", present: true },
    { id: "operator-brevity", label: "operator-brevity", desc: "", on: true, value: null, unit: null, kind: "unknown", present: true },
  ];

  /** Each row's read-only value spans, in order — the reading a role without
   *  `edit-policy` gets instead of the controls (U33-4). */
  const rowValues = (container: HTMLElement) =>
    Array.from(container.querySelectorAll(".guard-row")).map((r) =>
      Array.from(r.querySelectorAll(".guard-ctl"))
        .map((c) => c.textContent!.replace(/\s+/g, " ").trim())
        .join(" | "),
    );

  it("renders one row per guardrail with the right control per kind", () => {
    const onSet = vi.fn();
    const { container, getByText, getByLabelText } = render(
      <Guardrails guardrails={rows} canManage busy={false} onSet={onSet} />,
    );
    expect(getByText("2 of 3 enforced guardrails on")).toBeTruthy();
    expect(container.querySelectorAll(".guard-row")).toHaveLength(5);
    // Enforced rows toggle; the one with a unit also carries a number field.
    // SAFETY: the card renders the enforced-row toggle as an <input type="checkbox">
    // with exactly this aria-label.
    const toggle = getByLabelText("Meaningful comments guardrail") as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    expect(onSet).toHaveBeenCalledWith("meaningful-comment", "off");
    // SAFETY: the unit-carrying row renders an <input type="number"> with this label.
    const value = getByLabelText("Compression threshold value (events)") as HTMLInputElement;
    expect(value.value).toBe("40");
    // Ruling 147(d): Apply is inert only until the draft DIFFERS. Validity is
    // refused on the click (below), never folded into this gate.
    const apply = getByText("Apply").closest("button")!;
    expect(apply.disabled).toBe(true);
    fireEvent.change(value, { target: { value: "60" } });
    expect(apply.disabled).toBe(false);
    fireEvent.click(apply);
    expect(onSet).toHaveBeenCalledWith("compression-threshold", "value", 60);
    // A default the file lacks says so and reads OFF.
    expect(getByText("not in project.md")).toBeTruthy();
    // SAFETY: same checkbox contract as the toggle above.
    expect((getByLabelText("Evidence separation guardrail") as HTMLInputElement).checked).toBe(false);
    // The GitHub-owned row is inert with a pointer; the unknown row is removable.
    expect(getByText(/managed on Settings → GitHub/)).toBeTruthy();
    expect(getByText("nothing reads this")).toBeTruthy();
    fireEvent.click(getByText("Remove").closest("button")!);
    expect(onSet).toHaveBeenCalledWith("operator-brevity", "remove");
    expect(container.querySelectorAll(".guard-row.inert")).toHaveLength(2);
  });

  // Ruling 147: a changed-but-unusable threshold ("0", "-3", "2.5", or an
  // emptied box) used to leave Apply dead with no explanation. Apply now stays
  // enabled and the click is refused with the sentence the server throws.
  it("ruling 147: an unusable guardrail draft is refused on the click, not by a dead Apply", () => {
    const onSet = vi.fn();
    const { container, getByText, getByLabelText } = render(
      <Guardrails guardrails={rows} canManage busy={false} onSet={onSet} />,
    );
    // SAFETY: the unit-carrying row renders an <input type="number"> with this label.
    const value = getByLabelText("Compression threshold value (events)") as HTMLInputElement;
    const apply = getByText("Apply").closest("button")!;

    fireEvent.change(value, { target: { value: "0" } });
    expect(apply.disabled).toBe(false);
    expect(container.querySelector('[role="alert"]')).toBeNull();

    fireEvent.click(apply);
    expect(onSet).not.toHaveBeenCalled();
    const first = container.querySelector('[role="alert"]')!;
    expect(first.textContent).toBe(
      "Compression threshold needs a whole number above zero.",
    );
    expect(value.getAttribute("aria-invalid")).toBe("true");
    expect(value.getAttribute("aria-describedby")).toBe(first.id);
    expect(first.id).toBe("guard-compression-threshold-err");
    expect(document.activeElement).toBe(value);

    // Each refusal is a fresh element, so a repeat press is announced again.
    fireEvent.click(apply);
    expect(onSet).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')).not.toBe(first);

    // A usable draft clears the mark and applies.
    fireEvent.change(value, { target: { value: "60" } });
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(value.getAttribute("aria-invalid")).toBeNull();
    fireEvent.click(apply);
    expect(onSet).toHaveBeenCalledWith("compression-threshold", "value", 60);
  });

  it("ruling 147: an emptied threshold is refused, never written as a change", () => {
    const onSet = vi.fn();
    const { container, getByText, getByLabelText } = render(
      <Guardrails guardrails={rows} canManage busy={false} onSet={onSet} />,
    );
    // SAFETY: the unit-carrying row renders an <input type="number"> with this label.
    const value = getByLabelText("Compression threshold value (events)") as HTMLInputElement;
    fireEvent.change(value, { target: { value: "" } });
    fireEvent.click(getByText("Apply").closest("button")!);
    expect(onSet).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')).toBeTruthy();
  });

  /* U33-4 (owner, 2026-09-03): the predecessor of this test walked
     `querySelectorAll("input, button")` asserting each was disabled — a loop
     that passes vacuously the moment the controls are withdrawn, so it could
     never have told the two shapes apart. It now asserts the withdrawal AND
     that no state went with it: every row still reads its own value. */
  it("withdraws every guardrail control for a reader and reads the state as values (U33-4)", () => {
    const { container, getByText, queryByText } = render(
      <Guardrails guardrails={rows} canManage={false} busy={false} onSet={() => {}} />,
    );
    expect(getByText(/Read-only: changing a guardrail needs the/)).toBeTruthy();
    // Not one control survives — no dimmed toggle, number field, Apply or Remove.
    expect(container.querySelectorAll("input")).toHaveLength(0);
    expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(queryByText("Apply")).toBeNull();
    expect(queryByText("Remove")).toBeNull();
    // …and every row still says what it is set to, threshold and unit included.
    expect(rowValues(container)).toEqual([
      "on",
      "on | 40 events",
      "off",
      "on · managed on Settings → GitHub",
      "on",
    ]);
    // The stale-row diagnosis stays legible to the reader; only the destructive
    // control is reserved for who can act.
    expect(getByText("nothing reads this")).toBeTruthy();
    expect(getByText("not in project.md")).toBeTruthy();
  });

  // A hand-edited project.md can carry the unit with no number. The editable
  // field renders that as an empty box; the reading has to say it in words.
  it("reads a unit-carrying guardrail with no stored number as 'not set' (U33-4)", () => {
    const { container } = render(
      <Guardrails
        guardrails={[{ ...rows[1]!, value: null }]}
        canManage={false}
        busy={false}
        onSet={() => {}}
      />,
    );
    // The unit is dropped with the number: "40 events" measures something,
    // "not set events" measures nothing.
    expect(rowValues(container)).toEqual(["on | not set"]);
  });

  it("keeps every control for a role that can edit policy", () => {
    const { container, getByText } = render(
      <Guardrails guardrails={rows} canManage busy={false} onSet={() => {}} />,
    );
    expect(container.querySelectorAll("input")).toHaveLength(4); // 3 toggles + 1 number
    expect(getByText("Apply")).toBeTruthy();
    expect(getByText("Remove")).toBeTruthy();
    expect(container.textContent).not.toContain("Read-only:");
  });
});

/**
 * Ruling 178 (pass 36, G36-3): the Policy page READS the project's required
 * reviewers (stage → agent) beside the other acceptance rules; the list is
 * edited on Settings, where the stage and agent pickers live.
 */
describe("Required reviewers card (ruling 178)", () => {
  const rules: RequiredReviewerView[] = [
    { stageId: "review", stageName: "Review", profileId: "reviewer", agentName: "Code Reviewer" },
    { stageId: "qa", stageName: "QA", profileId: "qa-bot", agentName: "QA Bot" },
  ];

  it("renders one row per rule as agent → stage, counts them, and points a manager at Settings", () => {
    const onOpenSettings = vi.fn();
    const { container, getByText } = render(
      <RequiredReviewers rules={rules} canManage onOpenSettings={onOpenSettings} />,
    );
    expect(getByText("Required reviewers")).toBeTruthy();
    expect(getByText("2 rules")).toBeTruthy();
    const rows = Array.from(container.querySelectorAll(".guard-row")).map((r) => [
      r.querySelector(".guard-name")!.textContent,
      r.querySelector(".guard-desc")!.textContent,
    ]);
    expect(rows).toEqual([
      ["Code Reviewer", "Reviews at Review"],
      ["QA Bot", "Reviews at QA"],
    ]);
    fireEvent.click(getByText("Settings → Required reviewers"));
    expect(onOpenSettings).toHaveBeenCalled();
    expect(container.textContent).not.toContain("Read-only");
  });

  it("says when no rule is declared, and reads only for a role without edit-policy", () => {
    const { container, getByText } = render(
      <RequiredReviewers rules={[]} canManage={false} onOpenSettings={() => {}} />,
    );
    expect(getByText("0 rules")).toBeTruthy();
    expect(container.textContent).toContain("No required reviewers declared");
    expect(container.textContent).toContain("Read-only");
    expect(container.querySelector("button")).toBeNull();
  });
});
