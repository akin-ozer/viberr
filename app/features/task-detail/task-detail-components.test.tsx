// @vitest-environment jsdom
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { PacketRender, TaskSummary } from "~/shared/mapping/task.server";
import type { TaskDetail } from "~/server/projections/task-query.server";
import type { TaskSchedule } from "~/schemas/task-file.schema";
import type { TimelineEventRender } from "~/shared/mapping/task-event.server";
import { MemoryRouter, createRoutesStub } from "react-router";
import { ToastProvider } from "~/ui/toast";
import { DecisionPacket, observationLabel } from "./decision-packet";
import { GithubTrace, ScheduledActions, TaskHero } from "./task-detail-page";
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
      <DecisionPacket packet={packet142} busy={false} canResolve={true} canResolveCompletion={true} canEditGoal={true} onResolve={() => {}} onAsk={() => {}} />,
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
      <DecisionPacket packet={packet142} busy={false} canResolve={true} canResolveCompletion={true} canEditGoal={true} onResolve={onResolve} onAsk={() => {}} />,
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
        canEditGoal
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
      <DecisionPacket packet={blocked} busy={false} canResolve={true} canResolveCompletion={true} canEditGoal={true} onResolve={() => {}} onAsk={onAsk} />,
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
          // NEW-5: the actor name is the agent's OWN name (resolved server-side),
          // and the timeline shows the NAME ONLY — never the runtime label or a
          // trailing "· role".
          actor: { kind: "agent", backend: "claude", name: "Reviewer", role: "Review & validation" },
          text: "Re-checked the parser — the edge case is handled now.",
          toAgent: false,
        })}
      />,
    );
    // Renders in the comment area (a comment-card), NOT the toagent tint.
    expect(container.querySelector(".comment-card")).not.toBeNull();
    expect(container.querySelector(".comment-card.toagent")).toBeNull();
    // Shows the agent's NAME ONLY — no runtime label, no "· role" suffix.
    expect(container.querySelector(".tl-actor")!.textContent).toBe("Reviewer");
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
          // NEW-5: agent identity is its own name ("Developer"), shown alone.
          actor: { kind: "agent", backend: "codex", name: "Developer", role: "Implementation" },
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
    expect(container.querySelector(".tl-actor")!.textContent).toBe("Developer");
    const pills = [...container.querySelectorAll(".tl-meta .pill")].map(
      (p) => p.textContent,
    );
    // NEW-6: a typed event carries only its category pill — the "agent" badge
    // is comment-only now (the colored node + category pill already say it's an
    // agent action, so the badge was redundant on events).
    expect(pills).toEqual(["Completion report"]);
    const rows = container.querySelectorAll(".tl-card.evidence .ev-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.querySelector(".add")!.textContent).toBe("+14");
    expect(rows[1]!.querySelector(".del")!.textContent).toBe("−4");
    expect(container.querySelector(".tl-time")!.textContent).toBe(
      "Yesterday · 15:12",
    );
  });

  it("all 10 types map to their node class + pill label (contracts §1.3)", () => {
    const table: [string, string, string | null][] = [
      ["comment", "", null],
      ["completion", "completion", "Completion report"],
      ["github", "github", "GitHub"],
      ["policy", "policy", "Policy violation"],
      // P13-LV-03: neutral lifecycle notes (goal edits, divergence, scheduling)
      // no longer borrow the coral "Policy violation" shield.
      ["note", "note", "Note"],
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

  // UI-57: REWRITTEN — this test pinned the bug. The tolerant fallback reused
  // the COMMENT meta, but the renderer takes the typed branch for anything that
  // is not literally `comment`, so an unknown type rendered a pill labelled
  // "commented" — a row asserting it was a comment when it was not one. The
  // fallback now names the raw type instead.
  it("unknown event types render a neutral pill naming the raw type", () => {
    const { container } = render(<TimelineItem ev={ev({ type: "mystery" })} />);
    expect(container.querySelector(".comment-card")).toBeNull(); // not a comment…
    expect(container.querySelector(".tl-meta .pill")!.textContent).toBe("mystery");
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

/* -------------------------------------------------- GithubTrace force-accept */

function traceTask(patch: Record<string, unknown> = {}): TaskDetail {
  return {
    ...taskFixture("u-arda", "Arda Kaya"),
    projectSlug: "viberr-core",
    branch: "vib-151",
    pr: null,
    blockReason: null,
    commits: [],
    timeline: [],
    diagnostics: [],
    stages: [],
    ...patch,
  } as unknown as TaskDetail;
}

describe("GithubTrace — admin force-accept (DG-2)", () => {
  it("renders the block reason + Force-accept button when blocked AND onForceAccept is provided", () => {
    const onForceAccept = vi.fn();
    const { container, getByText } = render(
      <MemoryRouter>
        <GithubTrace
          task={traceTask({
            blockReason: "Waiting on 1 required reviewer approval of the current revision.",
          })}
          onForceAccept={onForceAccept}
        />
      </MemoryRouter>,
    );
    expect(getByText(/Waiting on 1 required reviewer approval/)).toBeTruthy();
    const btn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Force accept"),
    ) as HTMLButtonElement;
    expect(btn).toBeDefined();
    fireEvent.click(btn);
    expect(onForceAccept).toHaveBeenCalled();
  });

  it("surfaces force-accept for a blocked-packet wedge (null blockReason) even with no branch/PR", () => {
    const onForceAccept = vi.fn();
    const { container, getByText } = render(
      <MemoryRouter>
        <GithubTrace
          task={traceTask({
            branch: null,
            pr: null,
            blockReason: null,
            packet: { type: "blocked" },
          })}
          onForceAccept={onForceAccept}
        />
      </MemoryRouter>,
    );
    // No branch → the GitHub panel shows the empty state, but the admin escape
    // hatch is still rendered (a crashed pre-work wedge must be escapable).
    expect(getByText(/No branch yet/)).toBeTruthy();
    const btn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Force accept"),
    ) as HTMLButtonElement;
    expect(btn).toBeDefined();
    fireEvent.click(btn);
    expect(onForceAccept).toHaveBeenCalled();
  });

  it("shows NO force-accept control for a non-admin (onForceAccept undefined), even when blocked", () => {
    const { container } = render(
      <MemoryRouter>
        <GithubTrace
          task={traceTask({ blockReason: "Waiting on 1 required reviewer approval." })}
        />
      </MemoryRouter>,
    );
    const btn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Force accept"),
    );
    expect(btn).toBeUndefined();
  });
})

/* ------------------------------------------------ pass-13 honesty fixes */

describe("UI-36: a rejected PR must not look like an open one", () => {
  const withPr = (state: string): TaskDetail =>
    ({
      ...taskFixture("u-arda", "Arda Kaya"),
      repo: "akin-ozer/viberr",
      branch: "vib-151",
      commits: [],
      changed: null,
      pr: { number: 14, state, title: "PR" },
    }) as unknown as TaskDetail;

  it("renders a CLOSED (rejected) PR distinctly from one in review", () => {
    const closed = render(<GithubTrace task={withPr("closed")} />);
    const closedPill = closed.container.querySelector(".gh-bar .pill")!;
    // Before the fix this branch didn't exist: a rejected PR rendered as the
    // blue `info` "PR #14", identical to a PR still under review.
    expect(closedPill.textContent).toContain("closed");
    expect(closedPill.className).toContain("risk");
    cleanup();

    const review = render(<GithubTrace task={withPr("review")} />);
    const reviewPill = review.container.querySelector(".gh-bar .pill")!;
    expect(reviewPill.textContent).toContain("PR #14");
    expect(reviewPill.className).toContain("info");
  });

  it("keeps merged and merge-pending distinct", () => {
    const merged = render(<GithubTrace task={withPr("merged")} />);
    expect(merged.container.querySelector(".gh-bar .pill")!.textContent).toBe(
      "merged",
    );
    cleanup();
    const accepted = render(<GithubTrace task={withPr("accepted")} />);
    expect(
      accepted.container.querySelector(".gh-bar .pill")!.textContent,
    ).toContain("merge pending");
  });
});

describe("LV-09: pluralization + null-ish packet observations", () => {
  it("says 'Diff 1 file', not '1 files'", () => {
    const task = {
      ...taskFixture("u-arda", "Arda Kaya"),
      repo: "akin-ozer/viberr",
      branch: "vib-151",
      commits: [],
      pr: null,
      changed: { files: 1, add: 3, del: 1 },
    } as unknown as TaskDetail;
    const { container } = render(<GithubTrace task={task} />);
    const diff = [...container.querySelectorAll(".kv-row")].find((r) =>
      r.textContent?.startsWith("Diff"),
    )!;
    expect(diff.textContent).toContain("1 file ·");
    expect(diff.textContent).not.toContain("1 files");
  });

  it("prints 'unassigned' instead of the operator's literal 'null'", () => {
    const packet: PacketRender = {
      ...packet142,
      observations: [
        { k: "OWNER", v: "null", code: false },
        { k: "Signal", v: "", code: false },
      ],
    };
    const { container } = render(
      <DecisionPacket
        packet={packet}
        busy={false}
        canResolve
        canResolveCompletion
        canEditGoal
        onResolve={() => {}}
        onAsk={() => {}}
      />,
    );
    const obs = container.querySelectorAll(".packet-obs .obs");
    expect(obs[0]!.textContent).toContain("unassigned");
    expect(obs[0]!.textContent).not.toContain("null");
    expect(obs[1]!.textContent).toContain("—");
  });
});

describe("UI-42/UI-44: the decision packet", () => {
  const goalPacket: PacketRender = {
    ...packet142,
    options: [
      { kind: "edit_goal", t: "A human refines the goal", d: "Rewrite it.", rec: true },
      { kind: "request_edit", t: "Request one edit", d: "Ask the developer.", rec: false },
    ],
  };

  it("blocks edit_goal for a resolver who cannot edit the goal", () => {
    const onResolve = vi.fn();
    const { container } = render(
      <DecisionPacket
        packet={goalPacket}
        busy={false}
        canResolve
        canResolveCompletion={false}
        canEditGoal={false}
        onResolve={onResolve}
        onAsk={() => {}}
      />,
    );
    const first = container.querySelectorAll<HTMLButtonElement>(".options .opt")[0]!;
    expect(first.getAttribute("aria-disabled")).toBe("true");
    expect(first.textContent).toContain("your role can't edit the goal");
    // The Confirm button refuses too — before the fix an owner-contributor
    // recorded the decision, got "type the new goal", and found no editor.
    const confirm = container.querySelector<HTMLButtonElement>(
      ".packet-actions .btn.primary",
    )!;
    expect(confirm.disabled).toBe(true);
  });

  it("offers edit_goal normally to a maintainer", () => {
    const { container } = render(
      <DecisionPacket
        packet={goalPacket}
        busy={false}
        canResolve
        canResolveCompletion
        canEditGoal
        onResolve={() => {}}
        onAsk={() => {}}
      />,
    );
    const first = container.querySelectorAll<HTMLButtonElement>(".options .opt")[0]!;
    expect(first.getAttribute("aria-disabled")).toBeNull();
    expect(
      container.querySelector<HTMLButtonElement>(".packet-actions .btn.primary")!
        .disabled,
    ).toBe(false);
  });

  it("UI-44: uses a roving tabindex so Tab does not walk every option", () => {
    const { container } = render(
      <DecisionPacket
        packet={packet142}
        busy={false}
        canResolve
        canResolveCompletion
        canEditGoal
        onResolve={() => {}}
        onAsk={() => {}}
      />,
    );
    const opts = [
      ...container.querySelectorAll<HTMLButtonElement>(".options .opt"),
    ];
    const tabbable = opts.filter((o) => o.tabIndex === 0);
    expect(tabbable).toHaveLength(1);
    expect(tabbable[0]!.getAttribute("aria-checked")).toBe("true");
  });
});

describe("UI-41: the release dialog only offers members who can OWN a task", () => {
  it("filters out viewers, which setOwner would reject", () => {
    const members: TaskMemberView[] = [
      ...membersFixture,
      { userId: "u-viewer", role: "viewer", user: { name: "Viewer Person", initials: "VP", tone: "" } },
    ];
    const { container } = render(
      <ReleaseConfirm
        task={taskFixture("u-arda", "Arda Kaya")}
        me={{ id: "u-arda", name: "Arda Kaya" }}
        members={members}
        busy={false}
        onCancel={() => {}}
        onConfirm={() => {}}
        onOwner={() => {}}
      />,
    );
    const chips = [...container.querySelectorAll(".handoff-chip")];
    expect(chips.map((c) => c.textContent)).not.toContain(
      expect.stringContaining("Viewer"),
    );
    expect(chips.some((c) => c.textContent?.includes("Viewer"))).toBe(false);
  });

  it("disables the chips while an owner mutation is in flight", () => {
    const { container } = render(
      <ReleaseConfirm
        task={taskFixture("u-arda", "Arda Kaya")}
        me={{ id: "u-arda", name: "Arda Kaya" }}
        members={membersFixture}
        busy
        onCancel={() => {}}
        onConfirm={() => {}}
        onOwner={() => {}}
      />,
    );
    const chips = [
      ...container.querySelectorAll<HTMLButtonElement>(".handoff-chip"),
    ];
    expect(chips.length).toBeGreaterThan(0);
    expect(chips.every((c) => c.disabled)).toBe(true);
  });
});

/* ------------- packet observation key humanising (P13) ------------- */

describe("observationLabel", () => {
  it("turns the operator's machine-ish keys into readable ones", () => {
    // Live packet rendered "PROMPT_AGENT ERROR" at a human (the row uppercases).
    expect(observationLabel("prompt_agent error")).toBe("prompt agent error");
    expect(observationLabel("stage")).toBe("stage");
  });
});

/* ------------- panel-head / CTA / toast-kind regressions (pass 13) ------------- */

/** The Scheduled re-runs panel and the goal editor both need a data router
 *  (`useFetcher`) and the toast context, so they render inside a route stub. */
function renderWithRouter(
  ui: ReactNode,
  action: () => unknown = () => ({ ok: true }),
) {
  const Stub = createRoutesStub([
    {
      path: "/t",
      Component: () => <ToastProvider>{ui}</ToastProvider>,
      action: async () => action(),
    },
  ]);
  return render(<Stub initialEntries={["/t"]} />);
}

function heroTask(patch: Record<string, unknown> = {}): TaskDetail {
  return {
    key: "VIB-151",
    title: "Compress long-running task timelines",
    goal: "Bound the timeline payload and add a Show-older affordance.",
    filePath: "projects/viberr-core/tasks/VIB-151.md",
    displayReadiness: "ready",
    validation: "pass",
    stages: [],
    ...patch,
  } as unknown as TaskDetail;
}

function schedule(patch: Record<string, unknown> = {}): TaskSchedule {
  return {
    id: "sch-1",
    action: "operator-run",
    dueAt: new Date(Date.now() + 3_600_000).toISOString(),
    backend: "claude",
    autonomy: "supervised",
    note: "",
    createdBy: "u-arda",
    createdByLabel: "Arda Kaya",
    createdAt: new Date().toISOString(),
    status: "pending",
    firedAt: null,
    claimedAt: null,
    retries: 0,
    ...patch,
  } as unknown as TaskSchedule;
}

describe("ScheduledActions panel head (P13-D-38)", () => {
  it("renders the icon as a SIBLING of the <h2>, not nested inside it", () => {
    // `.panel-head` is a flex row with `gap: .6rem` and `.panel-head h2 {flex:1}`.
    // Nesting collapsed the gap to a JSX space and baseline-aligned the SVG —
    // this was the only one of ~48 panel heads that did it.
    const { container } = renderWithRouter(
      <ScheduledActions schedules={[schedule()]} canRunAgents taskClosed={false} />,
    );
    const head = container.querySelector(
      '[data-testid="scheduled-actions"] .panel-head',
    )!;
    expect(head.querySelector("h2")!.querySelector("svg")).toBeNull();
    expect(head.querySelector(":scope > svg.ico")).toBeTruthy();
    expect(head.querySelector("h2")!.textContent!.trim()).toBe("Scheduled re-runs");
  });
});

describe("undefined CTA / utility classes (P13-D-19)", () => {
  it("uses `btn primary` and `btn ghost`, never the undefined hyphenated forms", () => {
    const { container } = renderWithRouter(
      <ScheduledActions schedules={[schedule()]} canRunAgents taskClosed={false} />,
    );
    const buttons = [...container.querySelectorAll("button")];
    // `btn-primary` / `btn-ghost` exist in no stylesheet: both CTAs fell back
    // to the plain grey `.btn`.
    for (const b of buttons) {
      expect(b.className).not.toMatch(/\bbtn-(primary|ghost)\b/);
    }
    const submit = buttons.find((b) => b.textContent?.includes("Schedule operator re-run"))!;
    expect(submit.classList.contains("primary")).toBe(true);
    const cancel = buttons.find((b) => b.textContent?.trim() === "Cancel")!;
    expect(cancel.classList.contains("ghost")).toBe(true);
  });

  it("makes Save goal a primary CTA, visually distinct from Cancel", () => {
    const { container, getByText } = renderWithRouter(
      <TaskHero task={heroTask()} stage={undefined} canEditGoal />,
    );
    fireEvent.click(getByText("Edit"));
    const buttons = [...container.querySelectorAll(".goal-edit-actions button")];
    const save = buttons.find((b) => b.textContent === "Save goal")!;
    const cancel = buttons.find((b) => b.textContent === "Cancel")!;
    expect(save.className).not.toMatch(/\bbtn-primary\b/);
    expect(save.classList.contains("primary")).toBe(true);
    // The defect: both resolved to identical rules and rendered the same.
    expect(save.className).not.toBe(cancel.className);
  });
});

describe("failure toasts use the error kind (P13-D-10)", () => {
  it("renders the alert glyph, not the success tick, when an action fails", async () => {
    const { container, getByText } = renderWithRouter(
      <TaskHero task={heroTask()} stage={undefined} canEditGoal />,
      () => ({ ok: false, error: "Nope." }),
    );
    fireEvent.click(getByText("Edit"));
    const form = container.querySelector("form.goal-edit") as HTMLFormElement;
    fireEvent.submit(form);
    await waitFor(() => expect(document.querySelector(".toast")).toBeTruthy());
    const toast = document.querySelector(".toast")!;
    expect(toast.textContent).toContain("Nope.");
    // `alert` is the triangle path; `check` is the tick. `push` defaults to
    // "success", so this failure used to render under a green tick.
    expect(toast.querySelector("svg.ico")!.innerHTML).toContain("M12 4l9 16H3z");
  });
});
