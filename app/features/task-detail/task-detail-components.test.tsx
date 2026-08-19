// @vitest-environment jsdom
import { useState, type ComponentProps, type ReactNode } from "react";
import type { AcceptanceAffordance } from "~/server/tasks/task-actions.server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { PacketRender, TaskSummary } from "~/shared/mapping/task.server";
import type { TaskDetail } from "~/server/projections/task-query.server";
import type {
  PacketOption,
  PrState,
  TaskSchedule,
} from "~/schemas/task-file.schema";
import type { TimelineEventRender } from "~/shared/mapping/task-event.server";
import { MemoryRouter, createRoutesStub } from "react-router";
import { ToastProvider } from "~/ui/toast";
import {
  DELIVER_LABEL,
  DecisionPacket,
  observationLabel,
} from "./decision-packet";
import { GithubTrace, PolicyPanel } from "./task-side-panels";
import { DiagnosticsPanel, ScheduledActions, TaskHero } from "./task-main-sections";
import type { DiagnosticRecord } from "~/server/projections/task-query.server";
import { ReleaseConfirm } from "./release-confirm";
import type { ActionResult } from "./task-detail-hooks";
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
      <DecisionPacket packet={packet142} busy={false} canResolve={true} canResolveCompletion={true} canEditGoal={true} canArchive={true} onResolve={() => {}} onAsk={() => {}} />,
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
      <DecisionPacket packet={packet142} busy={false} canResolve={true} canResolveCompletion={true} canEditGoal={true} canArchive={true} onResolve={onResolve} onAsk={() => {}} />,
    );
    const primary = container.querySelector(".packet-actions .btn.primary")!;
    // F-UI1: the button no longer echoes the (often long, multi-line) option
    // title — it shows a concise, stable label; the selection lives in the radios.
    expect(primary.textContent).toContain("Confirm decision");
    const radios = container.querySelectorAll('.options [role="radio"]');
    expect(radios[0]!.getAttribute("aria-checked")).toBe("true"); // rec preselected
    // F17-L8: the accessible name echoes the CURRENTLY selected option even
    // though the visible label stays "Confirm decision" (F-UI1 overflow fix).
    expect(primary.getAttribute("aria-label")).toContain(packet142.options[0]!.t);
    fireEvent.click(radios[1]!);
    expect(radios[1]!.getAttribute("aria-checked")).toBe("true");
    expect(primary.getAttribute("aria-label")).toContain(packet142.options[1]!.t);
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
        canArchive
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
      <DecisionPacket packet={blocked} busy={false} canResolve={true} canResolveCompletion={true} canEditGoal={true} canArchive={true} onResolve={() => {}} onAsk={onAsk} />,
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
    expect(container.querySelector(".tl-time")!.textContent).toBe("09:41");
    // Comments render as GFM markdown (multi-line agent replies + user
    // comments), and @mentions inside a comment are re-chipped by the
    // rehypeMentions pass so they get the shared `.mention` highlight back.
    const body = container.querySelector(".comment-card .md-body")!;
    expect(body).not.toBeNull();
    const chip = container.querySelector(".comment-card .mention")!;
    expect(chip).not.toBeNull();
    expect(chip.textContent).toBe("@operator");
  });

  it("F20: typed-event text chips known names whole and leaves unknown @words prose", () => {
    // The typed-event branch used to render through RichText's own `@word`
    // regex, so it chipped `@nobody` (routes nowhere) and chipped only "@Arda"
    // out of the known name "@Arda Kaya". It now shares the comment renderer's
    // known-name list, so the two branches cannot disagree.
    const { container } = render(
      <TimelineItem
        ev={ev({
          type: "handoff",
          text: "Assigned to @Arda Kaya — @nobody was asked",
        })}
        mentionNames={["Arda Kaya"]}
      />,
    );
    const mentions = [...container.querySelectorAll(".tl-text .mention")].map(
      (m) => m.textContent,
    );
    expect(mentions).toEqual(["@Arda Kaya"]);
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

  it("E1: a comment from someone no longer in the project says exactly that", () => {
    // The pill read "app user · not in project", from the era when any
    // registered user could comment on any task. Members-only enforcement
    // (R15) killed that path — a non-member 404s on the page and on the POST —
    // so the only way to see this flag now is an author who has LEFT, and the
    // old wording described a route into the product that no longer exists.
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
    expect(pills).toContain("no longer a member");
    expect(pills).not.toContain("app user · not in project");
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

  it("all 11 types map to their node class + pill label (contracts §1.3)", () => {
    const table: [string, string, string | null][] = [
      ["comment", "", null],
      ["completion", "completion", "Completion report"],
      ["github", "github", "GitHub"],
      ["policy", "policy", "Policy violation"],
      // P13-LV-03: neutral lifecycle notes (goal edits, divergence, scheduling)
      // no longer borrow the coral "Policy violation" shield.
      ["note", "note", "Note"],
      ["quality", "quality", "Quality flag"],
      // G8: continuity reset — amber warning tone, its own label; borrows the
      // quality node styling (both are the amber/attention family).
      ["continuity", "quality", "Continuity reset"],
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

/* --------------------------------------------------- DiagnosticsPanel (G2) */

describe("DiagnosticsPanel state semantics (G2)", () => {
  const diag = (over: Partial<DiagnosticRecord>): DiagnosticRecord => ({
    id: 1,
    severity: "error",
    code: "frontmatter.invalid",
    path: null,
    message: "Something is off.",
    hardStop: false,
    readinessEffect: "inconsistency_risk_detected",
    observedAt: "2026-08-04T00:00:00.000Z",
    ...over,
  });

  /** The finding's pill: the `.k` cell holds exactly one status pill. */
  function pill(container: HTMLElement): HTMLElement {
    return container.querySelector<HTMLElement>(".obs .k .pill")!;
  }

  it("a SOFT error paints amber 'inconsistency risk' (like the hero), NOT crimson 'blocked'", () => {
    const { container } = render(
      <DiagnosticsPanel
        diagnostics={[diag({ hardStop: false, severity: "error", readinessEffect: "inconsistency_risk_detected" })]}
      />,
    );
    const p = pill(container);
    expect(p.classList.contains("risk")).toBe(true);
    expect(p.classList.contains("blocked")).toBe(false);
    expect(p.textContent).toContain("inconsistency risk");
  });

  it("a hardStop finding paints crimson 'blocked' even when its severity is only a warning", () => {
    const { container } = render(
      <DiagnosticsPanel
        diagnostics={[diag({ hardStop: true, severity: "warning", readinessEffect: "blocked" })]}
      />,
    );
    const p = pill(container);
    expect(p.classList.contains("blocked")).toBe(true);
    expect(p.textContent).toContain("blocked");
  });

  it("a warning shows 'input required'; an info finding is a neutral heads-up", () => {
    const { container } = render(
      <DiagnosticsPanel
        diagnostics={[
          diag({ id: 1, severity: "warning", readinessEffect: "input_required" }),
          diag({ id: 2, severity: "info", readinessEffect: null }),
        ]}
      />,
    );
    const pills = container.querySelectorAll(".obs .k .pill");
    expect(pills[0].classList.contains("input")).toBe(true);
    expect(pills[0].textContent).toContain("input required");
    expect(pills[1].classList.contains("neutral")).toBe(true);
    expect(pills[1].textContent).toContain("heads-up");
  });
});

/* ------------------------------------------------------ ReleaseConfirm */

const membersFixture: TaskMemberView[] = [
  { userId: "u-elif", role: "admin", user: { name: "Elif Demir", initials: "ED", tone: "rose" } },
  { userId: "u-arda", role: "admin", user: { name: "Arda Kaya", initials: "AK", tone: "" } },
  { userId: "u-murat", role: "maintainer", user: { name: "Murat Yıldız", initials: "MY", tone: "teal" } },
  { userId: "u-selin", role: "contributor", user: { name: "Selin Aksoy", initials: "SA", tone: "violet" } },
];

/** VIB-151 as the projection hands it over. The panels below read a handful of
 *  these fields; the rest carry the neutral values an open, un-delivered task
 *  has, so no panel branches on a field the fixture forgot. */
function taskFixture(ownerId: string, ownerName: string): TaskSummary {
  return {
    projectSlug: "viberr-core",
    key: "VIB-151",
    title: "Compress long-running task timelines",
    stage: "review",
    readiness: "ready",
    displayReadiness: "ready",
    waiting: "agent",
    urgent: false,
    archived: false,
    validation: "none",
    continuity: null,
    blockReason: null,
    atAcceptanceBoundary: false,
    owner: {
      kind: "human",
      userId: ownerId,
      name: ownerName,
      initials: "XX",
      tone: "",
    },
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
    goal: "Bound the timeline payload and add a Show-older affordance.",
    packet: null,
    eventCount: 0,
    commentCount: 0,
    diagnosticCount: 0,
    createdAt: null,
    updatedAt: null,
    boardRank: null,
    filePath: "projects/viberr-core/tasks/VIB-151.md",
  };
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
    const task: TaskSummary = {
      ...taskFixture("u-arda", "Arda Kaya"),
      waiting: "human",
      packet: packet142,
    };
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
  return { ...taskFixture("u-arda", "Arda Kaya"), ...patch };
}

function renderExec(
  task: TaskSummary,
  props: Partial<ComponentProps<typeof ExecutionProfile>> = {},
) {
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
          operatorAutonomy="supervised"
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
    const btn = Array.from(container.querySelectorAll<HTMLButtonElement>(".own-btn")).find((b) =>
      b.textContent?.includes("Assign delivering agent"),
    )!;
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
    const assignBtn = Array.from(container.querySelectorAll<HTMLButtonElement>(".own-btn")).find((b) =>
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
    });
    const { container, onRun } = renderExec(task);
    // The primary specialist's Run button — not the operator "Run operator" one.
    const runBtn = Array.from(container.querySelectorAll<HTMLButtonElement>("button.btn.primary")).find(
      (b) => b.textContent?.includes("Run") && !b.textContent?.includes("operator"),
    )!;
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
    });
    const { container } = renderExec(task, { deliveringActive: true });
    const runBtn = Array.from(container.querySelectorAll<HTMLButtonElement>("button.btn.primary")).find(
      (b) => b.textContent?.includes("Running"),
    )!;
    expect(runBtn.disabled).toBe(true);
  });

  it("non-privileged role: no assign/run affordances (RBAC-gated)", () => {
    const { container } = renderExec(execTask(), {
      myRole: "contributor",
      canRunAgents: false,
    });
    const assignBtn = Array.from(container.querySelectorAll<HTMLButtonElement>(".own-btn")).find((b) =>
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
      }),
    );
    expect(container.textContent).toContain("task closed");
    expect(container.textContent).not.toContain("operator active");
  });

  it("P11-41: the operator backend picker disables an unconfigured backend and defaults to an available one", () => {
    const { container } = renderExec(execTask({ operator: attachedOperator }), {
      operatorBackend: "codex",
    operatorAutonomy: "supervised" as const, // configured backend...
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
    });

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
    const addBtn = Array.from(container.querySelectorAll<HTMLButtonElement>(".rev-add")).find((b) =>
      b.textContent?.includes("Engage reviewer"),
    )!;
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
    });
    const { container } = renderExec(task);
    const addBtn = Array.from(container.querySelectorAll<HTMLButtonElement>(".rev-add")).find((b) =>
      b.textContent?.includes("Engage reviewer"),
    )!;
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
    const runBtn = container.querySelector<HTMLButtonElement>(
      ".rev-agent .btn.primary",
    )!;
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
    const runBtn = container.querySelector<HTMLButtonElement>(
      ".rev-agent .btn.primary",
    )!;
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

// P14-WL-07: PST-1 was Done+merged and wore the "task closed" pill while the
// panel still offered "Assign delivering agent" and "Engage reviewer" — G9
// disabled the RUN buttons and stopped there, so a closed task could still take
// an engagement that had nothing left to run.
describe("ExecutionProfile — a closed task offers no new engagements (P14-WL-07)", () => {
  const closedTask = () =>
    execTask({ displayReadiness: "merged" });

  it("replaces the assign menu with the reason", () => {
    const { container, getByText } = renderExec(closedTask());
    expect(
      Array.from(container.querySelectorAll(".own-btn")).some((b) =>
        b.textContent?.includes("Assign delivering agent"),
      ),
    ).toBe(false);
    expect(getByText(/Task closed — reopen it from Current state/)).toBeTruthy();
  });

  it("replaces the reviewer menu with the reason", () => {
    const { container, getByText } = renderExec(closedTask());
    expect(
      Array.from(container.querySelectorAll(".rev-add")).some((b) =>
        b.textContent?.includes("Engage reviewer"),
      ),
    ).toBe(false);
    expect(getByText("Task closed — no new reviewer engagements.")).toBeTruthy();
  });

  it("still offers both on an OPEN task", () => {
    const { container } = renderExec(execTask());
    expect(
      Array.from(container.querySelectorAll(".own-btn")).some((b) =>
        b.textContent?.includes("Assign delivering agent"),
      ),
    ).toBe(true);
    expect(
      Array.from(container.querySelectorAll(".rev-add")).some((b) =>
        b.textContent?.includes("Engage reviewer"),
      ),
    ).toBe(true);
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
    const manageBtn = Array.from(container.querySelectorAll<HTMLButtonElement>(".own-btn")).find((b) =>
      b.textContent?.includes("Manage"),
    )!;
    expect(manageBtn).toBeDefined();
    fireEvent.click(manageBtn);
    const menu = container.querySelector('[aria-label="Manage task ownership"]')!;
    const names = [...menu.querySelectorAll(".menu-item")].map((i) => i.textContent);
    expect(names.join(" ")).not.toContain("Barış Koç"); // viewer — cannot own
    expect(names.join(" ")).toContain("Murat Yıldız"); // maintainer — can own
    expect(names.join(" ")).toContain("Selin Aksoy"); // contributor — can own
  });
});

/* ------------------------------------------- popover dismissal (shared hook) */

/**
 * Pass 16: the three menus on this panel each carried their own copy of the
 * "Escape + outside mousedown closes me" effect, and none of them was covered —
 * so the behaviour could quietly diverge between them (it already had, app-wide:
 * `window` vs `document`, some popovers with no outside-close at all). They now
 * share `use-dismiss.ts`, and this asserts the shared contract on all three at
 * once so a future divergence is a test failure.
 */
describe("ExecutionProfile — every menu dismisses the same way", () => {
  const menus: [label: string, trigger: string, panel: string][] = [
    ["owner", "Manage", "Manage task ownership"],
    ["delivering agent", "Assign delivering agent", "Assign a delivering agent"],
    ["reviewer", "Engage reviewer", "Engage a reviewer"],
  ];

  for (const [name, trigger, panel] of menus) {
    it(`${name} menu: Escape closes it`, () => {
      const { container } = renderExec(execTask());
      const btn = Array.from(container.querySelectorAll<HTMLButtonElement>(".own-btn, .rev-add")).find(
        (b) => b.textContent?.includes(trigger),
      )!;
      expect(btn).toBeDefined();
      fireEvent.click(btn);
      expect(container.querySelector(`[aria-label="${panel}"]`)).not.toBeNull();
      fireEvent.keyDown(document, { key: "Escape" });
      expect(container.querySelector(`[aria-label="${panel}"]`)).toBeNull();
    });

    it(`${name} menu: a press outside closes it, a press inside does not`, () => {
      const { container } = renderExec(execTask());
      const btn = Array.from(container.querySelectorAll<HTMLButtonElement>(".own-btn, .rev-add")).find(
        (b) => b.textContent?.includes(trigger),
      )!;
      fireEvent.click(btn);
      const open = () => container.querySelector(`[aria-label="${panel}"]`);
      fireEvent.mouseDown(open()!);
      expect(open()).not.toBeNull();
      fireEvent.mouseDown(document.body);
      expect(open()).toBeNull();
    });
  }
});

/* -------------------------------------------------- GithubTrace force-accept */

/** P14-UI-11: the browse host is the loader's, always — the component no longer
 *  carries its own `github.com` fallback, so every caller passes one. */
const GH_HOST = "https://github.com";

function traceTask(patch: Partial<TaskDetail> = {}): TaskDetail {
  return {
    ...taskFixture("u-arda", "Arda Kaya"),
    branch: "vib-151",
    timeline: [],
    diagnostics: [],
    stages: [],
    lastActivityAt: null,
    quiet: false,
    ...patch,
  };
}

/** UX19-2: the panel reads the acceptance gate from the SAME live affordance the
 *  Current-state panel renders, never from the projection's `blockReason`. */
function traceAcceptance(
  patch: Partial<
    Pick<
      AcceptanceAffordance,
      "atBoundary" | "blockedReason" | "terminallyBlocked"
    >
  > = {},
): Pick<
  AcceptanceAffordance,
  "atBoundary" | "blockedReason" | "terminallyBlocked"
> {
  return {
    atBoundary: true,
    blockedReason: null,
    terminallyBlocked: false,
    ...patch,
  };
}

describe("GithubTrace — admin force-accept (DG-2)", () => {
  it("renders the Force-accept button when blocked AND onForceAccept is provided", () => {
    // C1: the block REASON no longer renders here — it has one owner, the
    // Current-state panel. This panel carries only the GitHub-side fact: the
    // admin override button itself, whose label already names what it does.
    // Canary: bring back the `.force-accept .hint` sentence and this reads its
    // absence (the duplicate returns).
    const onForceAccept = vi.fn();
    const { container, queryByText } = render(
      <MemoryRouter>
        <GithubTrace
          githubHost={GH_HOST}
          task={traceTask()}
          acceptance={traceAcceptance({
            blockedReason:
              "Waiting on 1 required reviewer approval of the current revision.",
          })}
          onForceAccept={onForceAccept}
        />
      </MemoryRouter>,
    );
    // The reason sentence stays out of this panel (it lives in Current state).
    expect(queryByText(/Waiting on 1 required reviewer approval/)).toBeNull();
    const btn = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
      b.textContent?.includes("Force accept"),
    )!;
    expect(btn).toBeDefined();
    fireEvent.click(btn);
    expect(onForceAccept).toHaveBeenCalled();
  });

  it("UX19-2 / C1: the override button reads the LIVE affordance, and the reason stays with Current state", () => {
    // The button's label/title come from the live `acceptance` (atBoundary),
    // never the projection's revision-only `blockReason` — so a pre-boundary
    // force-accept names the stages it skips. C1: the REFUSAL SENTENCE is not
    // rendered here at all any more (one owner: Current-state); this panel only
    // carries the GitHub-side override. Canary: read `task.blockReason` into a
    // hint here again and both sentences reappear as a duplicate.
    const { container, queryByText } = render(
      <MemoryRouter>
        <GithubTrace
          githubHost={GH_HOST}
          task={traceTask({
            blockReason:
              "VIB-151's delivered revision has no approving verdict yet.",
          })}
          acceptance={traceAcceptance({
            atBoundary: false,
            blockedReason:
              "VIB-151 is at In Progress, not Review — a completion can only be accepted from the boundary the workflow puts before Done.",
          })}
          onForceAccept={vi.fn()}
        />
      </MemoryRouter>,
    );
    // Neither the live refusal nor the projection's blockReason renders here.
    expect(queryByText(/at In Progress, not Review/)).toBeNull();
    expect(queryByText(/no approving verdict yet/)).toBeNull();
    // The override button, though, still reads the live affordance: from before
    // the boundary it skips the remaining stages too, and says so.
    const btn = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
      b.textContent?.includes("Force accept"),
    )!;
    expect(btn.textContent).toContain("skips the remaining stages");
    expect(btn.title).toContain("skipping the remaining stages");
  });

  it("UX19-2: at the review boundary the label stays the plain review-gate override", () => {
    const { container } = render(
      <MemoryRouter>
        <GithubTrace
          githubHost={GH_HOST}
          task={traceTask()}
          acceptance={traceAcceptance({
            atBoundary: true,
            blockedReason:
              "VIB-151's delivered revision has no approving verdict yet.",
          })}
          onForceAccept={vi.fn()}
        />
      </MemoryRouter>,
    );
    const btn = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
      b.textContent?.includes("Force accept"),
    )!;
    expect(btn.textContent).toContain("override review gate");
    expect(btn.textContent).not.toContain("skips the remaining stages");
  });

  it("R16-3: a terminally blocked acceptance (closed PR) withdraws the row entirely", () => {
    const { container, queryByText } = render(
      <MemoryRouter>
        <GithubTrace
          githubHost={GH_HOST}
          task={traceTask({
            pr: { number: 124, state: "closed", title: "x" },
          })}
          acceptance={traceAcceptance({
            terminallyBlocked: true,
            blockedReason:
              "VIB-151's review PR was closed on GitHub without merging — it can't be accepted.",
          })}
          onForceAccept={vi.fn()}
        />
      </MemoryRouter>,
    );
    // The Current-state panel frames this one as "Acceptance is closed."; a
    // second, softer "Acceptance is blocked … Force accept" beside it is the
    // exact contradiction R16-3 removed from the rail.
    expect(queryByText(/Acceptance is blocked/)).toBeNull();
    expect(
      Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
        b.textContent?.includes("Force accept"),
      ),
    ).toBeUndefined();
  });

  it("surfaces force-accept for a blocked-packet wedge (no acceptance refusal) even with no branch/PR", () => {
    const onForceAccept = vi.fn();
    const { container, getByText } = render(
      <MemoryRouter>
        <GithubTrace
          githubHost={GH_HOST}
          task={traceTask({
            branch: null,
            pr: null,
            blockReason: null,
            packet: { ...packet142, type: "blocked" },
          })}
          acceptance={traceAcceptance()}
          onForceAccept={onForceAccept}
        />
      </MemoryRouter>,
    );
    // No branch → the GitHub panel shows the empty state, but the admin escape
    // hatch is still rendered (a crashed pre-work wedge must be escapable).
    expect(getByText(/No branch yet/)).toBeTruthy();
    const btn = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
      b.textContent?.includes("Force accept"),
    )!;
    expect(btn).toBeDefined();
    fireEvent.click(btn);
    expect(onForceAccept).toHaveBeenCalled();
  });

  it("shows NO force-accept control for a non-admin (onForceAccept undefined), even when blocked", () => {
    const { container } = render(
      <MemoryRouter>
        <GithubTrace
          githubHost={GH_HOST}
          task={traceTask()}
          acceptance={traceAcceptance({
            blockedReason: "Waiting on 1 required reviewer approval.",
          })}
        />
      </MemoryRouter>,
    );
    const btn = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
      b.textContent?.includes("Force accept"),
    );
    expect(btn).toBeUndefined();
  });

  it("F18-13: renders NO force-accept + no 'Acceptance is blocked' on a terminal (accepted/merged) task, even for an admin whose refusal still lingers", () => {
    // Force-accept BYPASSES the verdict gate rather than satisfying it, so a
    // task force-accepted into Done keeps a non-null refusal. The card used
    // to keep offering "Force accept" on a task with nothing left to accept.
    for (const terminal of ["accepted", "merged"] as const) {
      const onForceAccept = vi.fn();
      const { container, queryByText } = render(
        <MemoryRouter>
          <GithubTrace
            githubHost={GH_HOST}
            task={traceTask({ displayReadiness: terminal })}
            acceptance={traceAcceptance({
              blockedReason:
                "Waiting on 1 required reviewer approval of the current revision.",
            })}
            onForceAccept={onForceAccept}
          />
        </MemoryRouter>,
      );
      const btn = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
        b.textContent?.includes("Force accept"),
      );
      expect(btn).toBeUndefined();
      expect(queryByText(/Acceptance is blocked/)).toBeNull();
    }
  });

  it("F19-24: the Complete-merge button OPENS the ceremony — it never submits the merge itself", () => {
    // It is the mandatory human half of every full-autonomy operator acceptance
    // (R16-6) and the only acceptance-family control that merged on a bare
    // click. The panel hands the click up; the page owns the dialog.
    const onCompleteMerge = vi.fn();
    const { container } = render(
      <MemoryRouter>
        <GithubTrace
          githubHost={GH_HOST}
          task={traceTask({
            pr: { number: 147, state: "accepted", title: "x" },
          })}
          acceptance={traceAcceptance()}
          onCompleteMerge={onCompleteMerge}
        />
      </MemoryRouter>,
    );
    const btn = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
      b.textContent?.includes("Complete merge"),
    )!;
    expect(btn).toBeDefined();
    // The hover title names the PR the click is about (it named none before).
    expect(btn.title).toContain("PR #147");
    fireEvent.click(btn);
    expect(onCompleteMerge).toHaveBeenCalled();
  });
})

/**
 * F19-22 — the panel's freshness cue reported the last CHANGING reconcile as
 * though it were the last successful one.
 *
 * `reconciledAt` is `MAX(observed_at)` over `github.reconcile` PROVENANCE, and
 * the reconciler deliberately skips that row on an unchanged poller tick (DG-3,
 * `github-reconciler.server.ts`: `if (changed || !ctx.skipUnchangedProvenance)`)
 * so the table cannot grow without bound. Under the label "Synced" it therefore
 * drifted to "Synced 1h ago / 3h ago / yesterday" on a perfectly healthy task —
 * live-proven: the panel read "Synced 1h ago" at 12:42Z while `audit_events`
 * held successful `github.reconcile.task` passes at 12:07/12:12/12:21/12:26/
 * 12:31/12:36/12:42 and the last provenance row sat at 12:01:55. Its own tooltip
 * said "a background poller refreshes it every 5 minutes", so the one cell
 * contradicted itself.
 *
 * DG-3 stays. This component owns the NAME of the number it renders — and, since
 * `checkedAt` was wired through the loader, the second fact beside it: the
 * per-tick `github.reconcile.task` audit row, which is written after every early
 * return in `reconcileTaskExclusive` and is therefore the app's only evidence
 * that a pass ran at all. `server/audit/audit-query.server.test.ts` proves the
 * two clocks diverge against the real reconciler; these pin what the human sees.
 */
describe("F19-22: the GitHub panel names the last CHANGE, not the last check", () => {
  /** The panel's freshness rows, addressed by their label — never by index, so
   *  adding a row can't silently repoint an assertion at a different fact. */
  const freshnessRows = (
    task: TaskDetail,
    reconciledAt: string | null,
    checkedAt: string | null = null,
  ) => {
    const { container } = render(
      <MemoryRouter>
        <GithubTrace
          githubHost={GH_HOST}
          task={task}
          acceptance={traceAcceptance()}
          reconciledAt={reconciledAt}
          checkedAt={checkedAt}
        />
      </MemoryRouter>,
    );
    const rows = [...container.querySelectorAll(".gh-body .kv-row")];
    const byKey = (k: string) => {
      const row = rows.find((r) => r.querySelector(".k")?.textContent === k);
      if (!row) throw new Error(`no "${k}" row in the GitHub panel`);
      return row;
    };
    return { checked: byKey("Checked"), change: byKey("Last change") };
  };
  const freshnessRow = (task: TaskDetail, reconciledAt: string | null) =>
    freshnessRows(task, reconciledAt).change;

  it("labels the row 'Last change' — never 'Synced'", () => {
    const row = freshnessRow(
      traceTask({ pr: { number: 147, state: "review", title: "x" } }),
      "2026-08-06T12:01:55.000Z",
    );
    expect(row.querySelector(".k")!.textContent).toBe("Last change");
    expect(row.textContent).not.toContain("Synced");
  });

  it("its tooltip says a pass finding nothing new records nothing", () => {
    // The old title asserted the OPPOSITE of the code it described: "a
    // background poller refreshes it every 5 minutes" next to an hours-old
    // number. Both halves have to be here, and they have to agree.
    const title = freshnessRow(
      traceTask({ pr: { number: 147, state: "review", title: "x" } }),
      "2026-08-06T12:01:55.000Z",
    )
      .querySelector(".v")!
      .getAttribute("title")!;
    expect(title).toContain("every 5 minutes");
    expect(title).toContain("records nothing on a pass that finds nothing new");
    expect(title).not.toContain("a background poller refreshes it every 5 minutes.");
  });

  it("never claims 'not yet synced' from an absent provenance row", () => {
    // An absent row is silent about whether a pass ran — it only says none of
    // them found anything to write. The old copy read that silence as "GitHub
    // has never been contacted", which is the same lie the "Synced Nh ago"
    // label told, pointing the other way.
    const bare = freshnessRow(traceTask(), null);
    expect(bare.textContent).toContain("nothing recorded yet");
    expect(bare.textContent).not.toContain("not yet synced");
    cleanup();

    // F15-02's case survives: PR/commit facts written at delivery time, no
    // change recorded by a pass since.
    const delivered = freshnessRow(
      traceTask({ pr: { number: 147, state: "review", title: "x" } }),
      null,
    );
    expect(delivered.textContent).toContain("recorded at delivery");
    expect(delivered.textContent).toContain("nothing has changed since");
  });

  it("renders the last CHECK as its own row, off the per-tick audit fact", () => {
    // The live case, exactly: the provenance row froze at 12:01:55 while passes
    // kept completing through 12:42. Both instants are on screen, each under
    // its own label, so neither can be read as the other.
    const { checked, change } = freshnessRows(
      traceTask({ pr: { number: 147, state: "review", title: "x" } }),
      "2026-08-06T12:01:55.000Z",
      "2026-08-06T12:42:00.000Z",
    );
    expect(checked.querySelector("time")!.getAttribute("dateTime")).toBe(
      "2026-08-06T12:42:00.000Z",
    );
    expect(change.querySelector("time")!.getAttribute("dateTime")).toBe(
      "2026-08-06T12:01:55.000Z",
    );
    // The row that says "we looked" must not inherit the change row's caveat…
    expect(checked.textContent).not.toContain("no completed pass on record");
    // …and its tooltip has to explain WHY the two differ, or the panel is back
    // to looking self-contradictory.
    expect(checked.querySelector(".v")!.getAttribute("title")).toContain(
      "a pass that finds nothing new is still a check",
    );
    // The change row now points at the check row instead of ending on a bare
    // "not an unchecked one" the panel could not previously substantiate.
    expect(change.querySelector(".v")!.getAttribute("title")).toContain(
      "the Checked row above says when GitHub was last read",
    );
  });

  it("says 'no completed pass on record' — never 'never synced' — with no audit row", () => {
    // Null here means the app cannot prove when it last looked (audit rows are
    // kept 90 days). Claiming GitHub was never contacted is the same class of
    // lie F19-22 is about, and ruling 46/R17-5 keeps this neutral either way.
    const { checked } = freshnessRows(
      traceTask({ pr: { number: 147, state: "review", title: "x" } }),
      "2026-08-06T12:01:55.000Z",
      null,
    );
    expect(checked.textContent).toContain("no completed pass on record");
    expect(checked.querySelector("time")).toBeNull();
    expect(checked.textContent).not.toMatch(/never synced|not yet synced/i);
  });

  it("keeps the two facts independent — a fresh check over an ancient change", () => {
    const { checked, change } = freshnessRows(
      traceTask({ pr: { number: 147, state: "review", title: "x" } }),
      null,
      "2026-08-06T12:42:00.000Z",
    );
    // Nothing has ever changed, yet a pass completed 2 minutes ago: the panel
    // must be able to hold both at once.
    expect(checked.querySelector("time")).not.toBeNull();
    expect(change.textContent).toContain("recorded at delivery");
  });
});

/**
 * UX19-1 — the Permissions panel's intro cited "the owner authority R6-2 adds":
 * an internal decisions.md ruling id in copy an end user reads. Nobody outside
 * the repo can look it up, and knowing the number changes nothing they can do —
 * so the sentence has to say what the ruling MEANS. (The same citations in this
 * file's CODE COMMENTS are correct and stay; only the render layer is in scope.)
 */
describe("UX19-1: no internal ruling ids in Permissions copy", () => {
  const intro = (myRole: string, ownsTask = false) => {
    const { container } = render(
      <MemoryRouter>
        <PolicyPanel
          projectSlug="viberr-core"
          myRole={myRole}
          stages={[
            { id: "review", name: "Review", color: "#5b76fe" },
            { id: "done", name: "Done", color: "#00b473" },
          ]}
          ownsTask={ownsTask}
        />
      </MemoryRouter>,
    );
    return container.querySelector(".perm-intro")!;
  };

  it("names the owner's authority in words, not by ruling number", () => {
    const p = intro("contributor", true);
    expect(p.textContent).toContain(
      "plus the authority that comes with owning this task",
    );
    expect(p.textContent).not.toMatch(/\bR\d{1,2}-\d+\b/);
  });

  it("holds for every role the panel renders", () => {
    for (const role of ["viewer", "contributor", "maintainer", "admin"]) {
      const { container } = render(
        <MemoryRouter>
          <PolicyPanel
            projectSlug="viberr-core"
            myRole={role}
            stages={[
              { id: "review", name: "Review", color: "#5b76fe" },
              { id: "done", name: "Done", color: "#00b473" },
            ]}
            ownsTask={role === "contributor"}
          />
        </MemoryRouter>,
      );
      expect(container.textContent).not.toMatch(/\bR\d{1,2}-\d+\b/);
      cleanup();
    }
  });
});

/* ------------------------------------------------ pass-13 honesty fixes */

describe("UI-36: a rejected PR must not look like an open one", () => {
  const withPr = (state: PrState): TaskDetail => ({
    ...traceTask(),
    repo: "akin-ozer/viberr",
    changed: null,
    pr: { number: 14, state, title: "PR" },
  });

  it("renders a CLOSED (rejected) PR distinctly from one in review", () => {
    const closed = render(<GithubTrace githubHost={GH_HOST} task={withPr("closed")} acceptance={traceAcceptance()} />);
    const closedPill = closed.container.querySelector(".gh-bar .pill")!;
    // Before the fix this branch didn't exist: a rejected PR rendered as the
    // blue `info` "PR #14", identical to a PR still under review.
    expect(closedPill.textContent).toContain("closed");
    expect(closedPill.className).toContain("risk");
    cleanup();

    const review = render(<GithubTrace githubHost={GH_HOST} task={withPr("review")} acceptance={traceAcceptance()} />);
    const reviewPill = review.container.querySelector(".gh-bar .pill")!;
    expect(reviewPill.textContent).toContain("PR #14");
    expect(reviewPill.className).toContain("info");
  });

  it("keeps merged and merge-pending distinct", () => {
    const merged = render(<GithubTrace githubHost={GH_HOST} task={withPr("merged")} acceptance={traceAcceptance()} />);
    expect(merged.container.querySelector(".gh-bar .pill")!.textContent).toBe(
      "merged",
    );
    cleanup();
    const accepted = render(<GithubTrace githubHost={GH_HOST} task={withPr("accepted")} acceptance={traceAcceptance()} />);
    expect(
      accepted.container.querySelector(".gh-bar .pill")!.textContent,
    ).toContain("merge pending");
  });
});

describe("LV-09: pluralization + null-ish packet observations", () => {
  it("says 'Diff 1 file', not '1 files'", () => {
    const task: TaskDetail = {
      ...traceTask(),
      repo: "akin-ozer/viberr",
      changed: { files: 1, add: 3, del: 1 },
    };
    const { container } = render(<GithubTrace githubHost={GH_HOST} task={task} acceptance={traceAcceptance()} />);
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
        canArchive
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
        canArchive
        onResolve={onResolve}
        onAsk={() => {}}
      />,
    );
    const first = container.querySelectorAll<HTMLButtonElement>(".options .opt")[0]!;
    expect(first.getAttribute("aria-disabled")).toBe("true");
    expect(first.textContent).toContain("your role can't edit the goal");
    // The Confirm button refuses too — before the fix an owner-contributor
    // recorded the decision, got "type the new goal", and found no editor.
    // E4: the refusal is `aria-disabled`, not `disabled`, so the reason it
    // points at is reachable; the click handler is what actually refuses.
    const confirm = container.querySelector<HTMLButtonElement>(
      ".packet-actions .btn.primary",
    )!;
    expect(confirm.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(confirm);
    expect(onResolve).not.toHaveBeenCalled();
  });

  it("offers edit_goal normally to a maintainer", () => {
    const { container } = render(
      <DecisionPacket
        packet={goalPacket}
        busy={false}
        canResolve
        canResolveCompletion
        canEditGoal
        canArchive
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

  // The pr-diverged recovery packet: archive_task options carry the R14-3
  // authority (approve-transition), and the deleteBranch variant must be LOUD.
  const recoveryPacket: PacketRender = {
    ...packet142,
    options: [
      { kind: "custom", t: "Rework and re-run the Developer", d: "", rec: true },
      { kind: "archive_task", t: "Archive the task", d: "Keeps the branch.", rec: false },
      { kind: "archive_task", t: "Archive and delete the branch", d: "Discards the work.", rec: false, deleteBranch: true },
    ],
  };

  it("blocks archive_task for a resolver below approve-transition, with the reason", () => {
    const { container } = render(
      <DecisionPacket
        packet={recoveryPacket}
        busy={false}
        canResolve
        canResolveCompletion
        canEditGoal
        canArchive={false}
        onResolve={() => {}}
        onAsk={() => {}}
      />,
    );
    const opts = container.querySelectorAll<HTMLButtonElement>(".options .opt");
    expect(opts[0]!.getAttribute("aria-disabled")).toBeNull(); // rework stays open
    expect(opts[1]!.getAttribute("aria-disabled")).toBe("true");
    expect(opts[1]!.textContent).toContain("your role can't archive");
    // Selecting the blocked option is refused, so Confirm stays on the open one.
    fireEvent.click(opts[1]!);
    expect(opts[0]!.getAttribute("aria-checked")).toBe("true");
  });

  it("tags the deleteBranch variant 'deletes branch' and offers it to a maintainer", () => {
    const { container } = render(
      <DecisionPacket
        packet={recoveryPacket}
        busy={false}
        canResolve
        canResolveCompletion
        canEditGoal
        canArchive
        onResolve={() => {}}
        onAsk={() => {}}
      />,
    );
    const opts = container.querySelectorAll<HTMLButtonElement>(".options .opt");
    expect(opts[1]!.getAttribute("aria-disabled")).toBeNull();
    expect(opts[1]!.textContent).not.toContain("deletes branch");
    expect(opts[2]!.textContent).toContain("deletes branch");
  });

  it("UI-44: uses a roving tabindex so Tab does not walk every option", () => {
    const { container } = render(
      <DecisionPacket
        packet={packet142}
        busy={false}
        canResolve
        canResolveCompletion
        canEditGoal
        canArchive
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

// UX19-4: the closed-PR recovery packet enumerated rework / archive / archive +
// delete-the-branch and told the reader that reopening the PR on GitHub was
// "also a valid path" — while the one-click in-app path sat directly ABOVE the
// card in the GitHub panel. A human was sent to GitHub for something this page
// does. The note names that control, and these tests pin the claim to the
// component that actually renders it.
describe("UX19-4: the recovery packet names the in-app re-delivery path", () => {
  /** The pr-diverged recovery packet the operator authors for a CLOSED review
   *  PR on a still-active task (operator-run.server.ts, `pr-diverged`): rework,
   *  archive, archive + delete the remote branch. */
  const recoveryPacket: PacketRender = {
    ...packet142,
    kind: "Blocked decision",
    title: "PR #143 was closed without merging — what now?",
    body: "Reopening the pull request on GitHub is also a valid path.",
    options: [
      { kind: "custom", t: "Rework and re-run the Developer", d: "", rec: true },
      { kind: "archive_task", t: "Archive the task", d: "Keeps the branch.", rec: false },
      {
        kind: "archive_task",
        t: "Archive and delete the branch",
        d: "Discards the work.",
        rec: false,
        deleteBranch: true,
      },
    ],
  };

  const noteOf = (container: HTMLElement) =>
    [...container.querySelectorAll(".packet-body > .packet-lede")].find((p) =>
      p.textContent?.includes("Not in this list"),
    );

  it("points at the SAME control the GitHub panel renders beside it", () => {
    const packetView = render(
      <DecisionPacket
        packet={recoveryPacket}
        busy={false}
        canResolve
        canResolveCompletion
        canEditGoal
        canArchive
        onResolve={() => {}}
        onAsk={() => {}}
      />,
    );
    const note = noteOf(packetView.container)!;
    expect(note).toBeTruthy();
    expect(note.textContent).toContain(DELIVER_LABEL);
    // The honesty the trace bought: `openTaskPr` treats a CLOSED cached PR as
    // terminal and falls through to the CREATE path, so the note must promise a
    // new PR — never a reopen this app cannot perform.
    expect(note.textContent).toContain("opens a new review pull request");
    expect(note.textContent).toContain("never reopens a closed one");
    // Nothing on the delivery path touches the packet (recordDeliveredNextStep
    // returns early *because* one is open), while the packet body above promises
    // that a GitHub reopen withdraws it — so the note must not let that promise
    // travel to the in-app door.
    expect(note.textContent).toContain("does not resolve this packet");

    // The pin: the panel one column over must actually render a button with
    // this exact label, for the same task shape (PR closed, deliverer present).
    const panel = render(
      <MemoryRouter>
        <GithubTrace
          githubHost={GH_HOST}
          task={traceTask({ pr: { number: 143, state: "closed", title: "x" } })}
          acceptance={traceAcceptance({
            terminallyBlocked: true,
            blockedReason: "PR #143 was closed on GitHub without merging.",
          })}
          onDeliver={() => {}}
        />
      </MemoryRouter>,
    );
    const deliver = [
      ...panel.container.querySelectorAll<HTMLButtonElement>("button"),
    ].find((b) => b.textContent?.includes(DELIVER_LABEL));
    expect(deliver).toBeTruthy();
    expect(deliver!.textContent?.trim()).toBe(DELIVER_LABEL);
  });

  it("stays silent on a packet that is not the closed-PR recovery", () => {
    // Keyed on the archive + `deleteBranch` option: the operator authors it only
    // for a task whose PR a human closed and whose branch still stands, and
    // resolution refuses it while a PR is open — so its presence is also the
    // proof that no live PR blocks the panel's button.
    const { container } = render(
      <DecisionPacket
        packet={packet142}
        busy={false}
        canResolve
        canResolveCompletion
        canEditGoal
        canArchive
        onResolve={() => {}}
        onAsk={() => {}}
      />,
    );
    expect(noteOf(container)).toBeUndefined();
  });

  it("withholds the note from a viewer who could not press that button", () => {
    // `canResolve` is the packet-resolver set (run-agents OR this task's own
    // owner), and `canDeliver` on the route is that same set — so a viewer
    // without it sees neither the button nor a note advertising it.
    const { container } = render(
      <DecisionPacket
        packet={recoveryPacket}
        busy={false}
        canResolve={false}
        canResolveCompletion={false}
        canEditGoal={false}
        canArchive={false}
        onResolve={() => {}}
        onAsk={() => {}}
      />,
    );
    expect(noteOf(container)).toBeUndefined();
  });
});

// E4: the Confirm button used to park its refusal reason in `title` on a
// `disabled` element — the one attribute+state combination that guarantees
// nobody reads it: no hover, no focus, absent from the a11y tree. The reason
// has to be on screen AND announced.
describe("E4: the blocked Confirm button gives its reason to everybody", () => {
  const completionPacket: PacketRender = {
    ...packet142,
    options: [
      { kind: "accept_completion", t: "Accept the completion", d: "Move to Done.", rec: true },
      { kind: "request_edit", t: "Request one edit", d: "Ask the developer.", rec: false },
    ],
  };

  const renderBlocked = (onResolve = vi.fn()) =>
    render(
      <DecisionPacket
        packet={completionPacket}
        busy={false}
        canResolve
        canResolveCompletion={false}
        canEditGoal
        canArchive
        onResolve={onResolve}
        onAsk={() => {}}
      />,
    );

  it("renders the reason as visible text wired to the button by aria-describedby", () => {
    const { container } = renderBlocked();
    const confirm = container.querySelector<HTMLButtonElement>(
      ".packet-actions .btn.primary",
    )!;
    const described = confirm.getAttribute("aria-describedby");
    expect(described).toBeTruthy();
    const reason = container.querySelector(`#${described}`)!;
    // In the document, not in a tooltip — this is the whole finding.
    expect(reason).not.toBeNull();
    expect(reason.textContent).toContain("Accepting completion is reserved");
    // And no `title`, which is where it used to hide.
    expect(confirm.getAttribute("title")).toBeNull();
  });

  it("stays focusable (aria-disabled, not disabled) yet still refuses the click", () => {
    const onResolve = vi.fn();
    const { container } = renderBlocked(onResolve);
    const confirm = container.querySelector<HTMLButtonElement>(
      ".packet-actions .btn.primary",
    )!;
    // `disabled` would drop it out of the tab order and out of the a11y tree,
    // taking the description with it.
    expect(confirm.disabled).toBe(false);
    expect(confirm.getAttribute("aria-disabled")).toBe("true");
    confirm.focus();
    expect(document.activeElement).toBe(confirm);
    fireEvent.click(confirm);
    expect(onResolve).not.toHaveBeenCalled();
  });

  it("drops the reason — and resolves — the moment an allowed option is selected", () => {
    const onResolve = vi.fn();
    const { container } = renderBlocked(onResolve);
    expect(container.querySelector(".deny-note")).not.toBeNull();
    // Arrow to `request_edit`, which needs no extra grant.
    fireEvent.keyDown(container.querySelector(".options")!, { key: "ArrowDown" });
    const confirm = container.querySelector<HTMLButtonElement>(
      ".packet-actions .btn.primary",
    )!;
    expect(confirm.getAttribute("aria-disabled")).toBeNull();
    expect(confirm.getAttribute("aria-describedby")).toBeNull();
    expect(container.querySelector(".deny-note")).toBeNull();
    fireEvent.click(confirm);
    expect(onResolve).toHaveBeenCalledWith(1, "");
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

/* ------------- pass-20 packet governance (F20-6 / F20-17 / F20-18 / N20-16 / C7) --- */

describe("DecisionPacket — pass-20 governance", () => {
  /** An option as these tests author it — everything but `rec`, which the helper
   *  fills with the default the parser applies. Spelled with `Pick` because
   *  `PacketOption` is a loose schema type: its index signature makes `Omit`
   *  drop the named keys along with `rec`. */
  type OptionDraft = Partial<PacketOption> &
    Pick<PacketOption, "kind" | "t" | "d">;

  const withOptions = (
    options: OptionDraft[],
    over: Partial<PacketRender> = {},
  ): PacketRender => ({
    ...packet142,
    ...over,
    options: options.map((o) => ({ ...o, rec: o.rec ?? false })),
  });

  const discardDialog = (container: HTMLElement) =>
    container.ownerDocument.querySelector(
      'dialog[data-screen-label="Packet discard dialog"]',
    );

  it("F20-6: a discard_branch option asks first, names the branch, then resolves by index", () => {
    const onResolve = vi.fn();
    const { container } = render(
      <DecisionPacket
        packet={withOptions([
          { kind: "discard_branch", t: "Discard the workspace branch", d: "Never pushed.", rec: true },
        ])}
        busy={false}
        canResolve
        canResolveCompletion
        canEditGoal
        canArchive
        canDiscardBranch
        archiveDisclosure={{ taskKey: "VIB-1", branch: "vib-1", pendingRecommendations: 0 }}
        onResolve={onResolve}
        onAsk={() => {}}
      />,
    );
    fireEvent.click(container.querySelector(".packet-actions .btn.primary")!);
    // Nothing resolved on the first click — the confirm is up, naming the branch.
    expect(onResolve).not.toHaveBeenCalled();
    const dialog = discardDialog(container)!;
    expect(dialog).toBeTruthy();
    expect(dialog.textContent).toContain("vib-1");
    expect(dialog.textContent).toContain("cannot be undone");
    expect(dialog.textContent).toContain("Nothing on GitHub changes");
    fireEvent.click(
      Array.from(dialog.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("Discard vib-1"),
      )!,
    );
    expect(onResolve).toHaveBeenCalledWith(0, "");
  });

  it("F20-6: discard_branch is blocked-with-reason below approve-transition", () => {
    const { container } = render(
      <DecisionPacket
        packet={withOptions([
          { kind: "discard_branch", t: "Discard the workspace branch", d: "Never pushed.", rec: true },
          { kind: "request_edit", t: "Send it back", d: "", rec: false },
        ])}
        busy={false}
        canResolve
        canResolveCompletion
        canEditGoal
        canArchive
        canDiscardBranch={false}
        onResolve={() => {}}
        onAsk={() => {}}
      />,
    );
    const opts = container.querySelectorAll<HTMLButtonElement>(".options .opt");
    expect(opts[0]!.getAttribute("aria-disabled")).toBe("true");
    expect(opts[0]!.textContent).toContain("your role can't discard the branch");
  });

  it("F20-17: a viewer who cannot resolve sees every option inert + one card-level deny note", () => {
    const onResolve = vi.fn();
    const { container } = render(
      <DecisionPacket
        packet={packet142}
        busy={false}
        canResolve={false}
        canResolveCompletion={false}
        canEditGoal={false}
        canArchive={false}
        onResolve={onResolve}
        onAsk={() => {}}
      />,
    );
    const opts = container.querySelectorAll<HTMLButtonElement>(".options .opt");
    expect(opts.length).toBeGreaterThan(0);
    // Canary: drop `|| !canResolve` from the option `blocked` and the un-gated
    // options go interactive again with no Confirm behind them.
    expect(
      Array.from(opts).every((o) => o.getAttribute("aria-disabled") === "true"),
    ).toBe(true);
    const denies = container.querySelectorAll(".deny-note");
    expect(denies).toHaveLength(1);
    expect(denies[0]!.textContent).toContain(
      "a maintainer, an admin, or this task",
    );
    // No Confirm (can't resolve), but Ask operator stays open to everyone.
    expect(container.querySelector(".packet-actions .btn.primary")).toBeNull();
    expect(container.querySelector(".packet-actions .btn.ghost")).not.toBeNull();
  });

  it("F20-18: an owner with EVERY option above their tier gets a 'Send to a maintainer' path", () => {
    const onRequestMaintainer = vi.fn();
    const { container } = render(
      <DecisionPacket
        packet={withOptions([
          { kind: "edit_goal", t: "Refine the goal", d: "", rec: true },
          { kind: "archive_task", t: "Archive the task", d: "" },
        ])}
        busy={false}
        canResolve
        canResolveCompletion={false}
        canEditGoal={false}
        canArchive={false}
        canDiscardBranch={false}
        archiveDisclosure={{ taskKey: "VIB-5", branch: null, pendingRecommendations: 0 }}
        onResolve={() => {}}
        onRequestMaintainer={onRequestMaintainer}
        onAsk={() => {}}
      />,
    );
    expect(container.textContent).toContain("needs maintainer or admin authority");
    const send = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
      b.textContent?.includes("Send to a maintainer"),
    )!;
    expect(send).toBeDefined();
    fireEvent.click(send);
    expect(onRequestMaintainer).toHaveBeenCalled();
  });

  it("F20-18: no escalation when at least one option is within reach", () => {
    const { container } = render(
      <DecisionPacket
        packet={withOptions([
          { kind: "custom", t: "Rework and re-run", d: "", rec: true },
          { kind: "archive_task", t: "Archive the task", d: "" },
        ])}
        busy={false}
        canResolve
        canResolveCompletion={false}
        canEditGoal={false}
        canArchive={false}
        onResolve={() => {}}
        onRequestMaintainer={vi.fn()}
        onAsk={() => {}}
      />,
    );
    expect(
      Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
        b.textContent?.includes("Send to a maintainer"),
      ),
    ).toBeUndefined();
  });

  it("N20-16: the rec pill credits whoever RAISED the packet", () => {
    const op = render(
      <DecisionPacket packet={packet142} busy={false} canResolve canResolveCompletion canEditGoal canArchive onResolve={() => {}} onAsk={() => {}} />,
    );
    expect(op.container.querySelector(".rec-tag")!.textContent).toContain(
      "operator pick",
    );
    cleanup();
    // A developer's own ask_human packet is authored by the agent, not the
    // operator — crediting "operator pick" there was the mislabel.
    const dev = render(
      <DecisionPacket packet={{ ...packet142, from: "Developer" }} busy={false} canResolve canResolveCompletion canEditGoal canArchive onResolve={() => {}} onAsk={() => {}} />,
    );
    const tag = dev.container.querySelector(".rec-tag")!;
    expect(tag.textContent).toContain("recommended");
    expect(tag.textContent).not.toContain("operator pick");
  });

  it("C7: drops an observation that only repeats the body sentence", () => {
    const dupe = withOptions(packet142.options, {
      body: "PR #143 was closed on GitHub without merging.",
      observations: [
        { k: "Signal", v: "PR #143 was closed on GitHub without merging.", code: false },
        { k: "Stage", v: "Review", code: false },
      ],
    });
    const { container } = render(
      <DecisionPacket packet={dupe} busy={false} canResolve canResolveCompletion canEditGoal canArchive onResolve={() => {}} onAsk={() => {}} />,
    );
    const obs = container.querySelectorAll(".packet-obs .obs");
    // The Signal row (byte-identical to the body) is gone; Stage remains.
    expect(obs).toHaveLength(1);
    expect(obs[0]!.textContent).toContain("Review");
    // The body still renders exactly once.
    expect(container.querySelector(".packet-lede")!.textContent).toContain(
      "PR #143 was closed on GitHub without merging.",
    );
  });
});

/* ------------- packet observation key humanising (P13 / C7) ------------- */

describe("observationLabel", () => {
  it("turns the operator's machine-ish keys into readable ones", () => {
    // Live packet rendered "PROMPT_AGENT ERROR" at a human (the row uppercases).
    expect(observationLabel("prompt_agent error")).toBe("prompt agent error");
    expect(observationLabel("stage")).toBe("stage");
  });

  it("C7: splits camelCase, rejects path-shaped keys, and caps length", () => {
    // A camelCase key no longer renders as one screaming token ("NOCHANGES").
    expect(observationLabel("noChanges")).toBe("no Changes");
    // A file path used as a field label is not a label — neutralised.
    expect(observationLabel("origin/main test-artifacts/pass20-vib1.txt")).toBe(
      "detail",
    );
    // An over-long key is capped so it cannot blow out the row.
    expect(observationLabel("x".repeat(60)).length).toBeLessThanOrEqual(40);
  });
});

/* ------------- panel-head / CTA / toast-kind regressions (pass 13) ------------- */

/** The Scheduled re-runs panel and the goal editor both need a data router
 *  (`useFetcher`) and the toast context, so they render inside a route stub. */
function renderWithRouter(
  ui: ReactNode,
  action: () => ActionResult = () => ({ ok: true }),
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

function heroTask(patch: Partial<TaskDetail> = {}): TaskDetail {
  return {
    ...taskFixture("u-arda", "Arda Kaya"),
    timeline: [],
    diagnostics: [],
    stages: [],
    lastActivityAt: null,
    quiet: false,
    ...patch,
  };
}

function schedule(patch: Partial<TaskSchedule> = {}): TaskSchedule {
  return {
    id: "sch-1",
    action: "run-operator",
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
  };
}

describe("ScheduledActions panel head (P13-D-38)", () => {
  it("renders the icon as a SIBLING of the <h2>, not nested inside it", () => {
    // `.panel-head` is a flex row with `gap: .6rem` and `.panel-head h2 {flex:1}`.
    // Nesting collapsed the gap to a JSX space and baseline-aligned the SVG —
    // this was the only one of ~48 panel heads that did it.
    const { container } = renderWithRouter(
      <ScheduledActions
        schedules={[schedule()]}
        canRunAgents
        taskClosed={false}
        configuredAutonomy="supervised"
      />,
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
      <ScheduledActions
        schedules={[schedule()]}
        canRunAgents
        taskClosed={false}
        configuredAutonomy="supervised"
      />,
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

  // UXO-1 (live-caught, pass 18): a task archived MID-REVIEW kept rendering its
  // readiness + validation pills, so the hero read "archived · ready · awaiting
  // verdict" — asserting that someone still owes a verdict when the task is out
  // of the flow and nobody does. The STAGE pill stays (it answers "how far did
  // this get?"); the two ACTIONABLE signals must drop.
  it("UXO-1: an archived task drops the readiness + validation pills, keeps the stage", () => {
    const live = renderWithRouter(
      <TaskHero
        task={heroTask({ displayReadiness: "ready", validation: "changed" })}
        stage={{ id: "review", name: "Review", color: "#5b76fe" }}
        canEditGoal
      />,
    );
    const liveText = live.container.querySelector(".hero-meta")!.textContent!;
    expect(liveText).toContain("Review");
    expect(liveText).toContain("ready");
    expect(liveText).toContain("awaiting verdict"); // the live obligation
    live.unmount();

    const archived = renderWithRouter(
      <TaskHero
        task={heroTask({ displayReadiness: "ready", validation: "changed" })}
        stage={{ id: "review", name: "Review", color: "#5b76fe" }}
        canEditGoal
        archived
      />,
    );
    const meta = archived.container.querySelector(".hero-meta")!.textContent!;
    expect(meta).toContain("archived");
    expect(meta).toContain("Review"); // how far it got — still true
    // No live obligation is asserted for a task nobody owes anything on.
    expect(meta).not.toContain("awaiting verdict");
    expect(meta).not.toMatch(/\bready\b/);
  });

  // A wrapper that bumps editGoalSignal on click, mimicking a confirmed
  // edit_goal decision — keeps the router/toast context stable across the bump.
  function EditGoalHarness({ draft }: { draft: string | null }) {
    const [sig, setSig] = useState(0);
    return (
      <>
        <button type="button" onClick={() => setSig((n) => n + 1)}>
          bump
        </button>
        <TaskHero
          task={heroTask()}
          stage={undefined}
          canEditGoal
          editGoalSignal={sig}
          editGoalDraft={draft}
        />
      </>
    );
  }

  it("F17-L3: a scoping decision opens the editor PREFILLED with the chosen deliverable, not the old goal", () => {
    const { container, getByText } = renderWithRouter(
      <EditGoalHarness draft={"Diagnostics: improve failure output\n\nDeliverable: name the failing step."} />,
    );
    fireEvent.click(getByText("bump"));
    const ta = container.querySelector<HTMLTextAreaElement>(
      "textarea.goal-textarea",
    )!;
    expect(ta).toBeTruthy();
    expect(ta.value).toContain("Diagnostics: improve failure output");
    expect(ta.value).not.toContain("Bound the timeline payload"); // NOT the old goal
  });

  it("F17-L3: a scoping decision with NO draft falls back to the current goal", () => {
    const { container, getByText } = renderWithRouter(
      <EditGoalHarness draft={null} />,
    );
    fireEvent.click(getByText("bump"));
    const ta = container.querySelector<HTMLTextAreaElement>(
      "textarea.goal-textarea",
    )!;
    expect(ta.value).toContain("Bound the timeline payload");
  });
});

describe("C2/C3/C12: the hero's readiness + validation vocabulary", () => {
  // C2 (⇄ N20-14/UXO-1): UXO-1 withdrew the live-obligation pills on archived
  // tasks; the same is true of any TERMINAL task. An accepted, Done task owes
  // nobody a verdict, so its validation pill (a live obligation) drops — while
  // the readiness pill stays, because "accepted" is a terminal STATUS, not a
  // live claim.
  it("C2: an accepted (terminal) task withdraws the validation pill, keeps its stage + readiness", () => {
    const { container } = renderWithRouter(
      <TaskHero
        task={heroTask({ displayReadiness: "accepted", validation: "changed" })}
        stage={{ id: "done", name: "Done", color: "#00b473" }}
        canEditGoal
      />,
    );
    const meta = container.querySelector(".hero-meta")!.textContent!;
    expect(meta).toContain("Done"); // stage stays — "how far did this get?"
    expect(meta).toContain("accepted"); // the readiness pill is a terminal status
    expect(meta).not.toContain("awaiting verdict"); // the withdrawn obligation
  });

  it("C2/N20-14: a force-accepted task never wears 'awaiting verdict' or a redundant bypass pill on the hero", () => {
    // deriveValidation projects `bypassed` for a force-accept; the hero withdraws
    // the validation pill for the terminal task, so neither the stale "awaiting
    // verdict" nor a redundant "gate bypassed" sits next to "accepted".
    const { container } = renderWithRouter(
      <TaskHero
        task={heroTask({ displayReadiness: "accepted", validation: "bypassed" })}
        stage={{ id: "done", name: "Done", color: "#00b473" }}
        canEditGoal
      />,
    );
    const meta = container.querySelector(".hero-meta")!.textContent!;
    expect(meta).toContain("accepted");
    expect(meta).not.toContain("awaiting verdict");
    expect(meta).not.toContain("gate bypassed");
  });

  // C3: a live run gives "agent working" its OWN slot instead of replacing the
  // readiness pill — the old swap hid `input_required`, the value that most needs
  // a human, so the board and the hero disagreed mid-run.
  it("C3: a live run shows 'agent working' BESIDE the input-required readiness, not in its place", () => {
    const { container } = renderWithRouter(
      <TaskHero
        task={heroTask({ displayReadiness: "input_required", validation: "none" })}
        stage={{ id: "impl", name: "In Progress", color: "#7b61ff" }}
        canEditGoal
        agentWorking
      />,
    );
    const meta = container.querySelector(".hero-meta")!.textContent!;
    expect(meta).toContain("input required"); // no longer suppressed by the run
    expect(meta).toContain("agent working"); // the live-run cue, in its own slot
  });

  // C12: an unrecognised readiness value must not greenwash. The lookup used to
  // fall back to a green "ready" pill; it now falls back to a neutral "unknown".
  it("C12: an unrecognised readiness value renders a neutral 'unknown' pill, never green 'ready'", () => {
    const malformedReadiness: string = "in_review";
    const { container } = renderWithRouter(
      <TaskHero
        task={heroTask({
          // SAFETY: deliberately outside the Readiness enum — a hand-edited task
          // file can hold any string, and this test asserts the pill refuses to
          // read an unrecognised one as green "ready".
          displayReadiness: malformedReadiness as TaskDetail["displayReadiness"],
          validation: "none",
        })}
        stage={{ id: "impl", name: "In Progress", color: "#7b61ff" }}
        canEditGoal
      />,
    );
    const meta = container.querySelector(".hero-meta")!;
    expect(meta.textContent).toContain("unknown");
    // The greenwash the fix forbids: a malformed value read as healthy.
    expect(meta.querySelector(".pill.ready")).toBeNull();
  });
});

describe("failure toasts use the error kind (P13-D-10)", () => {
  it("renders the alert glyph, not the success tick, when an action fails", async () => {
    const { container, getByText } = renderWithRouter(
      <TaskHero task={heroTask()} stage={undefined} canEditGoal />,
      () => ({ ok: false, error: "Nope." }),
    );
    fireEvent.click(getByText("Edit"));
    const form = container.querySelector<HTMLFormElement>("form.goal-edit")!;
    fireEvent.submit(form);
    await waitFor(() => expect(document.querySelector(".toast")).toBeTruthy());
    const toast = document.querySelector(".toast")!;
    expect(toast.textContent).toContain("Nope.");
    // `alert` is the triangle path; `check` is the tick. `push` defaults to
    // "success", so this failure used to render under a green tick.
    expect(toast.querySelector("svg.ico")!.innerHTML).toContain("M12 4l9 16H3z");
  });
});
