// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { PacketRender, TaskSummary } from "~/shared/mapping/task.server";
import type { TimelineEventRender } from "~/shared/mapping/task-event.server";
import { MemoryRouter } from "react-router";
import { DecisionPacket } from "./decision-packet";
import { ReleaseConfirm } from "./release-confirm";
import { TimelineItem } from "./timeline";
import {
  ExecutionProfile,
  type DeployedSpecialistView,
  type TaskMemberView,
} from "./execution-profile";

afterEach(cleanup);

/* ----------------------------------------------------------- fixtures */

const todayIso = (h: number, m: number) => {
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.toISOString();
};
const yesterdayIso = (h: number, m: number) => {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
};

const packet142: PacketRender = {
  type: "input",
  kind: "Completion report",
  from: "Operator",
  title: "Accept completion, or send back for one fix?",
  body: "The developer specialist reports the workspace attach flow is implemented.",
  observations: [
    { k: "Changed", v: "9 files · +412 / −87", code: true },
    { k: "Validation", v: "unit + integration green", code: false },
  ],
  options: [
    { kind: "accept_completion", t: "Accept completion", d: "Mark task done.", rec: true, accept: true },
    { kind: "request_edit", t: "Request one edit", d: "Ask the developer.", rec: false },
    { kind: "block_on_policy", t: "Block on policy", d: "Hold until policy updates.", rec: false },
  ],
};

function ev(partial: Partial<TimelineEventRender>): TimelineEventRender {
  return {
    id: 1,
    type: "comment",
    occurredAt: todayIso(9, 41),
    actor: { kind: "human", userId: "u1", name: "Arda Kaya", initials: "AK", tone: "" },
    title: null,
    text: "hello",
    toAgent: false,
    evidence: null,
    ...partial,
  };
}

/* ------------------------------------------------------ DecisionPacket */

describe("DecisionPacket", () => {
  it("renders the packet card: tint, kind pill, observations, options, rec tag", () => {
    const { container } = render(
      <DecisionPacket packet={packet142} busy={false} canResolve={true} canResolveCompletion={true} onResolve={() => {}} onAsk={() => {}} />,
    );
    const card = container.querySelector(".packet")!;
    expect(card.classList.contains("input")).toBe(true);
    expect(container.querySelector(".packet-top .pill")!.textContent).toContain(
      "Completion report",
    );
    expect(container.querySelector(".packet-body h2")!.textContent).toBe(
      packet142.title,
    );
    expect(container.querySelectorAll(".packet-obs .obs")).toHaveLength(2);
    // code:true wraps the value in <code>.
    expect(
      container.querySelectorAll(".packet-obs .obs")[0]!.querySelector("code")!
        .textContent,
    ).toBe("9 files · +412 / −87");
    const opts = container.querySelectorAll('.options [role="radio"]');
    expect(opts).toHaveLength(3);
    // Recommended option: default selection + recommend class + operator pick.
    expect(opts[0]!.getAttribute("aria-checked")).toBe("true");
    expect(opts[0]!.classList.contains("recommend")).toBe(true);
    expect(opts[0]!.querySelector(".rec-tag")!.textContent).toContain(
      "operator pick",
    );
  });

  it("primary button confirms the selected option by index (concise stable label)", () => {
    const onResolve = vi.fn();
    const { container } = render(
      <DecisionPacket packet={packet142} busy={false} canResolve={true} canResolveCompletion={true} onResolve={onResolve} onAsk={() => {}} />,
    );
    const primary = container.querySelector(".packet-actions .btn.primary")!;
    // F-UI1: the button no longer echoes the (often long, multi-line) option
    // title — it shows a concise, stable label; the selection lives in the radios.
    expect(primary.textContent).toContain("Confirm decision");
    const radios = container.querySelectorAll('.options [role="radio"]');
    expect(radios[0]!.getAttribute("aria-checked")).toBe("true"); // rec preselected
    fireEvent.click(radios[1]!);
    expect(radios[1]!.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(primary);
    // P11-71: resolve carries the (optional, here empty) note as a second arg.
    expect(onResolve).toHaveBeenCalledWith(1, "");
  });

  it("P11-71: passes a typed note to onResolve", () => {
    const onResolve = vi.fn();
    const { container } = render(
      <DecisionPacket
        packet={packet142}
        busy={false}
        canResolve
        canResolveCompletion
        onResolve={onResolve}
        onAsk={() => {}}
      />,
    );
    const note = container.querySelector<HTMLTextAreaElement>("textarea.packet-note")!;
    fireEvent.change(note, { target: { value: "Gate the /health/scripts route" } });
    fireEvent.click(container.querySelector(".packet-actions .btn.primary")!);
    expect(onResolve).toHaveBeenCalledWith(
      expect.any(Number),
      "Gate the /health/scripts route",
    );
  });

  it("blocked packets tint blocked; no rec → first option preselected; Ask fires", () => {
    const onAsk = vi.fn();
    const blocked: PacketRender = {
      ...packet142,
      type: "blocked",
      kind: "Blocked decision",
      options: packet142.options.map((o) => ({ ...o, rec: false })),
    };
    const { container } = render(
      <DecisionPacket packet={blocked} busy={false} canResolve={true} canResolveCompletion={true} onResolve={() => {}} onAsk={onAsk} />,
    );
    expect(container.querySelector(".packet")!.classList.contains("blocked")).toBe(true);
    expect(
      container.querySelector('.options [role="radio"]')!.getAttribute("aria-checked"),
    ).toBe("true");
    fireEvent.click(container.querySelector(".packet-actions .btn.ghost")!);
    expect(onAsk).toHaveBeenCalledOnce();
  });
});

/* -------------------------------------------------------- TimelineItem */

describe("TimelineItem", () => {
  it("comment: markdown body card, no type pill, today time, @mention chip restored", () => {
    const { container } = render(
      <TimelineItem ev={ev({ text: "ping @operator now" })} />,
    );
    expect(container.querySelector(".comment-card")).not.toBeNull();
    expect(container.querySelector(".comment-card.toagent")).toBeNull();
    expect(container.querySelector(".tl-meta .pill")).toBeNull();
    expect(container.querySelector(".tl-time")!.textContent).toBe("9:41");
    // Comments render as GFM markdown (multi-line agent replies + user
    // comments), and @mentions inside a comment are re-chipped by the
    // rehypeMentions pass so they get the shared `.mention` highlight back.
    const body = container.querySelector(".comment-card .md-body")!;
    expect(body).not.toBeNull();
    const chip = container.querySelector(".comment-card .mention")!;
    expect(chip).not.toBeNull();
    expect(chip.textContent).toBe("@operator");
  });

  it("agent-routed comment gets the toagent tint", () => {
    const { container } = render(<TimelineItem ev={ev({ toAgent: true })} />);
    expect(container.querySelector(".comment-card.toagent")).not.toBeNull();
  });

  it("agent-authored comment renders the agent identity + pill in a comment card", () => {
    // The reply an agent posts back: a `comment` event whose actor is an agent.
    const { container } = render(
      <TimelineItem
        ev={ev({
          type: "comment",
          actor: { kind: "agent", backend: "claude", name: "Claude Code", role: "developer" },
          text: "Re-checked the parser — the edge case is handled now.",
          toAgent: false,
        })}
      />,
    );
    // Renders in the comment area (a comment-card), NOT the toagent tint.
    expect(container.querySelector(".comment-card")).not.toBeNull();
    expect(container.querySelector(".comment-card.toagent")).toBeNull();
    // Shows the agent identity (name · role) and the agent pill.
    expect(container.querySelector(".tl-actor")!.textContent).toBe(
      "Claude Code · developer",
    );
    const pills = [...container.querySelectorAll(".tl-meta .pill")].map(
      (p) => p.textContent,
    );
    expect(pills).toEqual(["agent"]); // no type pill for comments; just the agent pill
    expect(container.querySelector(".tl-text")!.textContent).toContain(
      "Re-checked the parser",
    );
  });

  it("guest commenter renders the app-user pill (Deniz on VIB-153)", () => {
    const { container } = render(
      <TimelineItem
        ev={ev({
          actor: {
            kind: "human",
            userId: "u9",
            name: "Deniz Şahin",
            initials: "DŞ",
            tone: "violet",
            guest: true,
          },
        })}
      />,
    );
    const pills = [...container.querySelectorAll(".tl-meta .pill")].map(
      (p) => p.textContent,
    );
    expect(pills).toContain("app user · not in project");
  });

  it("completion: title, done pill, evidence rows with add/del", () => {
    const { container } = render(
      <TimelineItem
        ev={ev({
          type: "completion",
          actor: { kind: "agent", backend: "codex", name: "Codex", role: "Developer" },
          title: "Completion report",
          text: "Implemented repo attach.",
          evidence: [
            { label: "unit/policy_gate_test", add: "+14", del: "0" },
            { label: "integration/pr_sync_test", add: "+38", del: "−4" },
          ],
          occurredAt: yesterdayIso(15, 12),
        })}
      />,
    );
    expect(container.querySelector(".tl-node.completion")).not.toBeNull();
    expect(container.querySelector(".tl-body strong")!.textContent).toBe(
      "Completion report",
    );
    expect(container.querySelector(".tl-actor")!.textContent).toBe(
      "Codex · Developer",
    );
    const pills = [...container.querySelectorAll(".tl-meta .pill")].map(
      (p) => p.textContent,
    );
    expect(pills).toEqual(["Completion report", "agent"]);
    const rows = container.querySelectorAll(".tl-card.evidence .ev-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.querySelector(".add")!.textContent).toBe("+14");
    expect(rows[1]!.querySelector(".del")!.textContent).toBe("−4");
    expect(container.querySelector(".tl-time")!.textContent).toBe(
      "Yesterday · 15:12",
    );
  });

  it("all 9 types map to their node class + pill label (contracts §1.3)", () => {
    const table: [string, string, string | null][] = [
      ["comment", "", null],
      ["completion", "completion", "Completion report"],
      ["github", "github", "GitHub"],
      ["policy", "policy", "Policy violation"],
      ["quality", "quality", "Quality flag"],
      ["transition", "transition", "Transition request"],
      ["blocked", "blocked", "Blocked decision"],
      ["agent", "agent", "Operator"],
      ["assign", "transition", "Ownership"],
    ];
    for (const [type, node, label] of table) {
      const { container, unmount } = render(<TimelineItem ev={ev({ type })} />);
      const nodeEl = container.querySelector(".tl-node")!;
      expect(nodeEl.className.trim()).toBe(("tl-node " + node).trim());
      const pill = container.querySelector(".tl-meta .pill");
      if (label === null) expect(pill).toBeNull();
      else expect(pill!.textContent).toBe(label);
      unmount();
    }
  });

  it("unknown event types fall back to comment rendering (tolerant)", () => {
    const { container } = render(<TimelineItem ev={ev({ type: "mystery" })} />);
    expect(container.querySelector(".comment-card")).toBeNull(); // not a comment…
    // …but gets the neutral typed pill with comment meta's dead label.
    expect(container.querySelector(".tl-meta .pill")!.textContent).toBe("commented");
  });
});

/* ------------------------------------------------------ ReleaseConfirm */

const membersFixture: TaskMemberView[] = [
  { userId: "u-elif", role: "admin", user: { name: "Elif Demir", initials: "ED", tone: "rose" } },
  { userId: "u-arda", role: "admin", user: { name: "Arda Kaya", initials: "AK", tone: "" } },
  { userId: "u-murat", role: "maintainer", user: { name: "Murat Yıldız", initials: "MY", tone: "teal" } },
  { userId: "u-selin", role: "contributor", user: { name: "Selin Aksoy", initials: "SA", tone: "violet" } },
];

function taskFixture(ownerId: string, ownerName: string): TaskSummary {
  return {
    key: "VIB-151",
    title: "Compress long-running task timelines",
    waiting: "agent",
    packet: null,
    owner: {
      kind: "human",
      userId: ownerId,
      name: ownerName,
      initials: "XX",
      tone: "",
    },
  } as unknown as TaskSummary;
}

describe("ReleaseConfirm", () => {
  it("self release: observed-state rows, me-first handoff chips, self copy", () => {
    const { container } = render(
      <ReleaseConfirm
        task={taskFixture("u-arda", "Arda Kaya")}
        me={{ id: "u-arda", name: "Arda Kaya" }}
        members={membersFixture}
        busy={false}
        onCancel={() => {}}
        onConfirm={() => {}}
        onOwner={() => {}}
      />,
    );
    const dialog = container.querySelector('[role="alertdialog"]')!;
    expect(dialog.getAttribute("aria-label")).toBe("Release ownership of VIB-151");
    const obs = container.querySelectorAll(".packet-obs .obs");
    expect(obs).toHaveLength(3);
    expect(obs[0]!.textContent).toContain("Arda Kaya");
    expect(obs[0]!.textContent).toContain("· you");
    expect(obs[1]!.textContent).toContain(
      "Agent work in progress — no boundary is waiting",
    );
    expect(obs[2]!.textContent).toContain("Unowned — review & acceptance stall");
    // No admin-release pill on a self release.
    expect(container.querySelector(".rel-owner .pill")).toBeNull();
    // Candidates exclude the owner (me) → 3 chips, none marked "· you".
    const chips = container.querySelectorAll(".handoff-chip");
    expect(chips).toHaveLength(3);
    expect(container.querySelector(".foot-hint")!.textContent).toBe(
      "Recorded as a typed ownership event on the timeline.",
    );
    expect(container.querySelector(".btn.danger")!.textContent).toContain("Release");
    expect(container.querySelector(".btn.ghost")!.textContent).toBe("Keep ownership");
  });

  it("admin release: pill, distinct hint, named danger button, my chip first", () => {
    const onOwner = vi.fn();
    const onCancel = vi.fn();
    const { container } = render(
      <ReleaseConfirm
        task={taskFixture("u-selin", "Selin Aksoy")}
        me={{ id: "u-arda", name: "Arda Kaya" }}
        members={membersFixture}
        busy={false}
        onCancel={onCancel}
        onConfirm={() => {}}
        onOwner={onOwner}
      />,
    );
    expect(container.querySelector(".rel-owner .pill")!.textContent).toBe(
      "admin release",
    );
    expect(container.querySelector(".foot-hint")!.textContent).toBe(
      "Admin release — recorded as a typed event and in the audit trail.",
    );
    expect(container.querySelector(".btn.danger")!.textContent).toContain(
      "Release Selin",
    );
    expect(container.querySelector(".modal-foot .btn.ghost")!.textContent).toBe(
      "Cancel",
    );
    // Candidates include me, sorted me-first; my chip performs a take-over.
    const chips = container.querySelectorAll(".handoff-chip");
    expect(chips).toHaveLength(3);
    expect(chips[0]!.textContent).toContain("Arda · you");
    fireEvent.click(chips[0]!);
    expect(onCancel).toHaveBeenCalled();
    expect(onOwner).toHaveBeenCalledWith(
      "take",
      expect.objectContaining({ userId: "u-arda" }),
    );
  });

  it("open packet renders the packet-kind row and cancel (Escape) closes", () => {
    const onCancel = vi.fn();
    const task = {
      ...taskFixture("u-arda", "Arda Kaya"),
      waiting: "human",
      packet: { type: "input", kind: "Completion report" },
    } as unknown as TaskSummary;
    const { container } = render(
      <ReleaseConfirm
        task={task}
        me={{ id: "u-arda", name: "Arda Kaya" }}
        members={membersFixture}
        busy={false}
        onCancel={onCancel}
        onConfirm={() => {}}
        onOwner={() => {}}
      />,
    );
    expect(container.querySelector(".rel-open")!.textContent).toContain(
      "Completion report",
    );
    expect(container.querySelector(".rel-open")!.textContent).toContain(
      "waiting on the owner",
    );
    // Native <dialog>: Escape fires the `cancel` event, which useDialog
    // intercepts and routes to onCancel.
    fireEvent(
      container.querySelector("dialog")!,
      new Event("cancel", { cancelable: true }),
    );
    expect(onCancel).toHaveBeenCalled();
  });
});

/* -------------------------------------------------- ExecutionProfile */

const deployedFixture: DeployedSpecialistView[] = [
  { id: "developer", name: "Developer", role: "Implementation", backend: "codex", model: "codex-large" },
  { id: "reviewer", name: "Reviewer", role: "Code review", backend: "claude", model: "claude-sonnet" },
];

function execTask(patch: Partial<TaskSummary> = {}): TaskSummary {
  return {
    ...taskFixture("u-arda", "Arda Kaya"),
    projectSlug: "viberr-core",
    specialist: null,
    reviewers: [],
    operator: null,
    ...patch,
  } as unknown as TaskSummary;
}

function renderExec(task: TaskSummary, props: Partial<Record<string, unknown>> = {}) {
  const onAssign = vi.fn();
  const onRun = vi.fn();
  const utils = render(
    <MemoryRouter>
      <ExecutionProfile
        task={task}
        meId="u-arda"
        myRole="admin"
        members={membersFixture}
        busy={false}
        onOwner={() => {}}
        onRelease={() => {}}
        deployedSpecialists={deployedFixture}
        operatorBackend="claude"
        backendAvailable={{ claude: true, codex: true }}
        canRunAgents
        deliveringActive={false}
        activeReviewerIds={[]}
        operatorRunActive={false}
        runBusy={false}
        onAssignSpecialist={onAssign}
        onRunSpecialist={onRun}
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
  return { ...utils, onAssign, onRun };
}

describe("ExecutionProfile — assign menu + run button", () => {
  it("no specialist + admin: assign menu lists deployed specialists; picking submits", () => {
    const { container, onAssign } = renderExec(execTask());
    const btn = Array.from(container.querySelectorAll(".own-btn")).find((b) =>
      b.textContent?.includes("Assign delivering agent"),
    ) as HTMLButtonElement;
    expect(btn).toBeDefined();
    fireEvent.click(btn);
    const menu = container.querySelector('[aria-label="Assign a delivering agent"]')!;
    const items = menu.querySelectorAll(".menu-item");
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toContain("Developer");
    expect(items[0]!.textContent).toContain("Implementation");
    fireEvent.click(items[0]!);
    expect(onAssign).toHaveBeenCalledWith("developer");
  });

  it("no deployed specialists: hint links to the Agents page", () => {
    const { container } = renderExec(execTask(), { deployedSpecialists: [] });
    const link = container.querySelector('a[href="/projects/viberr-core/agents"]');
    expect(link).not.toBeNull();
    // No "Assign delivering agent" trigger when there is nothing to assign (the
    // owner "Manage" button is a separate .own-btn and may still be present).
    const assignBtn = Array.from(container.querySelectorAll(".own-btn")).find((b) =>
      b.textContent?.includes("Assign delivering agent"),
    );
    expect(assignBtn).toBeUndefined();
  });

  it("specialist assigned: a primary Run button submits run-specialist", () => {
    const task = execTask({
      specialist: {
        kind: "agent",
        profileId: "developer",
        backend: "codex",
        name: "Codex",
        role: "Implementation",
      },
    } as unknown as Partial<TaskSummary>);
    const { container, onRun } = renderExec(task);
    // The primary specialist's Run button — not the operator "Run operator" one.
    const runBtn = Array.from(container.querySelectorAll("button.btn.primary")).find(
      (b) => b.textContent?.includes("Run") && !b.textContent?.includes("operator"),
    ) as HTMLButtonElement;
    expect(runBtn).toBeDefined();
    expect(runBtn.disabled).toBe(false);
    fireEvent.click(runBtn);
    expect(onRun).toHaveBeenCalled();
  });

  it("delivering Run button is disabled while a delivering run is active", () => {
    const task = execTask({
      specialist: {
        kind: "agent",
        profileId: "developer",
        backend: "codex",
        name: "Codex",
        role: "Implementation",
      },
    } as unknown as Partial<TaskSummary>);
    const { container } = renderExec(task, { deliveringActive: true });
    const runBtn = Array.from(container.querySelectorAll("button.btn.primary")).find(
      (b) => b.textContent?.includes("Running"),
    ) as HTMLButtonElement;
    expect(runBtn.disabled).toBe(true);
  });

  it("non-privileged role: no assign/run affordances (RBAC-gated)", () => {
    const { container } = renderExec(execTask(), {
      myRole: "contributor",
      canRunAgents: false,
    });
    const assignBtn = Array.from(container.querySelectorAll(".own-btn")).find((b) =>
      b.textContent?.includes("Assign delivering agent"),
    );
    expect(assignBtn).toBeUndefined();
    expect(
      Array.from(container.querySelectorAll("button.btn.primary")).some((b) =>
        b.textContent?.includes("Run"),
      ),
    ).toBe(false);
    // The read-only "None yet …" copy is shown instead.
    expect(container.textContent).toContain("the operator assigns one");
  });
});

describe("ExecutionProfile — 'operator active' pill honesty (F7-UI1)", () => {
  const attachedOperator = {
    name: "Operator" as const,
    assignedAtStageId: "impl",
    sinceStageIndex: 3,
    sinceLabel: "since In Progress",
  };

  it("an attached-but-idle operator shows NO pill (attachment ≠ activity)", () => {
    const { container } = renderExec(execTask({ operator: attachedOperator }));
    expect(container.textContent).not.toContain("operator active");
  });

  it("a live operator run shows the pill", () => {
    const { container } = renderExec(execTask({ operator: attachedOperator }), {
      operatorRunActive: true,
    });
    expect(container.textContent).toContain("operator active");
  });

  it("a closed task keeps its 'task closed' pill without a phantom 'operator active'", () => {
    const { container } = renderExec(
      execTask({
        operator: attachedOperator,
        displayReadiness: "accepted",
      } as unknown as Partial<TaskSummary>),
    );
    expect(container.textContent).toContain("task closed");
    expect(container.textContent).not.toContain("operator active");
  });

  it("P11-41: the operator backend picker disables an unconfigured backend and defaults to an available one", () => {
    const { container } = renderExec(execTask({ operator: attachedOperator }), {
      operatorBackend: "codex", // configured backend...
      backendAvailable: { claude: true, codex: false }, // ...but NOT available
    });
    const sel = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Operator backend"]',
    )!;
    const codexOpt = Array.from(sel.options).find((o) => o.value === "codex")!;
    const claudeOpt = Array.from(sel.options).find((o) => o.value === "claude")!;
    expect(codexOpt.disabled).toBe(true);
    expect(codexOpt.textContent).toContain("not configured");
    expect(claudeOpt.disabled).toBe(false);
    // Defaults to the available backend, not the unconfigured configured one.
    expect(sel.value).toBe("claude");
  });
});

describe("ExecutionProfile — reviewers", () => {
  const reviewerTask = () =>
    execTask({
      reviewers: [
        { kind: "agent", profileId: "reviewer", backend: "claude", name: "Claude Code", role: "Code review" },
      ],
    } as unknown as Partial<TaskSummary>);

  it("labels the cell 'Reviewing agents' and renders a row with Run + remove", () => {
    const onRunReviewer = vi.fn();
    const onRemoveReviewer = vi.fn();
    const { container } = renderExec(reviewerTask(), { onRunReviewer, onRemoveReviewer });
    expect(container.textContent).toContain("Reviewing agents");
    const chip = container.querySelector(".rev-agent")!;
    expect(chip).not.toBeNull();
    expect(chip.textContent).toContain("Code review");
    fireEvent.click(chip.querySelector(".btn.primary")!);
    expect(onRunReviewer).toHaveBeenCalledWith("reviewer");
    fireEvent.click(chip.querySelector(".rev-x")!);
    expect(onRemoveReviewer).toHaveBeenCalledWith("reviewer");
  });

  it("'Engage reviewer' menu offers specialists not already engaged; picking submits", () => {
    const onAssignReviewer = vi.fn();
    // 'reviewer' is already engaged → only 'developer' remains available.
    const { container } = renderExec(reviewerTask(), { onAssignReviewer });
    const addBtn = Array.from(container.querySelectorAll(".rev-add")).find((b) =>
      b.textContent?.includes("Engage reviewer"),
    ) as HTMLButtonElement;
    expect(addBtn).toBeDefined();
    fireEvent.click(addBtn);
    const menu = container.querySelector('[aria-label="Engage a reviewer"]')!;
    const items = menu.querySelectorAll(".menu-item");
    expect(items).toHaveLength(1);
    expect(items[0]!.textContent).toContain("Developer");
    fireEvent.click(items[0]!);
    expect(onAssignReviewer).toHaveBeenCalledWith("developer");
  });

  it("'Engage reviewer' menu excludes the DELIVERING agent (F10-13)", () => {
    // F10-13: a reviewer must not review its own delivery — engaging the
    // delivering profile as a reviewer was a server no-op that answered with a
    // misleading "is already a reviewer" toast. The picker must not offer it.
    const task = execTask({
      specialist: {
        kind: "agent",
        profileId: "developer",
        backend: "codex",
        name: "Codex",
        role: "Implementation",
      },
      reviewers: [],
    } as unknown as Partial<TaskSummary>);
    const { container } = renderExec(task);
    const addBtn = Array.from(container.querySelectorAll(".rev-add")).find((b) =>
      b.textContent?.includes("Engage reviewer"),
    ) as HTMLButtonElement;
    fireEvent.click(addBtn);
    const menu = container.querySelector('[aria-label="Engage a reviewer"]')!;
    const items = [...menu.querySelectorAll(".menu-item")].map((i) => i.textContent);
    // 'developer' is delivering → only the other deployed agent is offered.
    expect(items).toHaveLength(1);
    expect(items[0]).toContain("Reviewer");
    expect(items.join(" ")).not.toContain("Developer");
  });

  it("a reviewer Run button is disabled only while THAT reviewer's run is active", () => {
    // F10-04: per-engagement gating — this reviewer ("reviewer") has an active
    // run, so its button reads Running/disabled.
    const { container } = renderExec(reviewerTask(), {
      activeReviewerIds: ["reviewer"],
    });
    const runBtn = container.querySelector(".rev-agent .btn.primary") as HTMLButtonElement;
    expect(runBtn.disabled).toBe(true);
    expect(runBtn.textContent).toContain("Running");
  });

  it("a reviewer Run button stays enabled when a DIFFERENT run is active", () => {
    // A delivering run (or another reviewer) being active must NOT disable this
    // read-only reviewer's Run button (F10-04).
    const { container } = renderExec(reviewerTask(), {
      deliveringActive: true,
      activeReviewerIds: ["some-other-reviewer"],
    });
    const runBtn = container.querySelector(".rev-agent .btn.primary") as HTMLButtonElement;
    expect(runBtn.disabled).toBe(false);
    expect(runBtn.textContent).toContain("Run");
  });

  it("non-privileged role: chips render read-only (no Run/remove/Add)", () => {
    const { container } = renderExec(reviewerTask(), {
      myRole: "contributor",
      canRunAgents: false,
    });
    expect(container.querySelector(".rev-agent")).not.toBeNull();
    expect(container.querySelector(".rev-agent .btn.primary")).toBeNull();
    expect(container.querySelector(".rev-agent .rev-x")).toBeNull();
    expect(
      Array.from(container.querySelectorAll(".rev-add")).some((b) =>
        b.textContent?.includes("Engage reviewer"),
      ),
    ).toBe(false);
  });
});

describe("ExecutionProfile — owner hand-off candidates", () => {
  it("hand-off list offers only members who can own a task (F10-13)", () => {
    // F10-13: viewers are read + comment only — the server rejects a hand-off to
    // one ("own-task"), so the picker must not offer a candidate that 403s.
    const withViewer: TaskMemberView[] = [
      ...membersFixture,
      { userId: "u-baris", role: "viewer", user: { name: "Barış Koç", initials: "BK", tone: "amber" } },
    ];
    // Owner is me (u-arda) → candidates are every OTHER member who can own.
    const { container } = renderExec(execTask(), { members: withViewer });
    const manageBtn = Array.from(container.querySelectorAll(".own-btn")).find((b) =>
      b.textContent?.includes("Manage"),
    ) as HTMLButtonElement;
    expect(manageBtn).toBeDefined();
    fireEvent.click(manageBtn);
    const menu = container.querySelector('[aria-label="Manage task ownership"]')!;
    const names = [...menu.querySelectorAll(".menu-item")].map((i) => i.textContent);
    expect(names.join(" ")).not.toContain("Barış Koç"); // viewer — cannot own
    expect(names.join(" ")).toContain("Murat Yıldız"); // maintainer — can own
    expect(names.join(" ")).toContain("Selin Aksoy"); // contributor — can own
  });
});
