// @vitest-environment jsdom
import { useState, type ComponentProps, type ReactNode } from "react";
import type { AcceptanceAffordance } from "~/server/tasks/task-actions.server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { PacketRender, TaskSummary } from "~/shared/mapping/task.server";
import type { TaskDetail } from "~/server/projections/task-query.server";
import type {
  PacketOption,
  PrRef,
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
import { GithubTrace } from "./task-side-panels";
import { MoveBackConfirm } from "./move-back-confirm";
import { DiagnosticsPanel, TaskHero } from "./task-main-sections";
import type { DiagnosticRecord } from "~/server/projections/task-query.server";
import { ReleaseConfirm } from "./release-confirm";
import { ArchiveConfirm } from "./archive-confirm";
import type { ActionResult } from "./task-detail-hooks";
import { TimelineItem } from "./timeline";
import {
  ExecutionProfile,
  type DeployedSpecialistView,
  type TaskMemberView,
} from "./execution-profile";
import type { TaskRunPrincipalView } from "./run-principal-view";

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
    { kind: "accept_completion", t: "Accept completion", d: "Mark task done.", rec: true },
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
    attachments: null,
    ...partial,
  };
}

/* ------------------------------------------------------ DecisionPacket */

describe("DecisionPacket", () => {
  it("renders the packet card: tint, kind pill, observations, options, rec tag", () => {
    const { container } = render(
      <DecisionPacket packet={packet142} busy={false} canResolve={true} canResolveCompletion={true} canEditGoal={true} canArchive={true} onResolveCustom={() => {}} onResolve={() => {}} onAsk={() => {}} />,
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
    // Three authored options plus the composed custom-directive choice (P21).
    expect(opts).toHaveLength(4);
    expect(opts[3]!.classList.contains("opt-custom")).toBe(true);
    // Recommended option: default selection + recommend class + operator pick.
    expect(opts[0]!.getAttribute("aria-checked")).toBe("true");
    expect(opts[0]!.classList.contains("recommend")).toBe(true);
    expect(opts[0]!.querySelector(".rec-tag")!.textContent).toContain(
      "operator pick",
    );
  });

  it("ruling 319: states what else the confirm answers, above the options", () => {
    /**
     * The reach has to be visible while the person is CHOOSING, not reported
     * after the click — a confirm that quietly answers four other tasks is the
     * undisclosed one-way write ruling 20 exists to stop, and this card is the
     * only place it can be said first.
     *
     * CANARY: drop the `alsoAnswers` prop from the card, or move the paragraph
     * below the radiogroup.
     */
    const line = "The same failure stopped 2 other tasks: SHOP-12 and SHOP-19.";
    const { container } = render(
      <DecisionPacket
        packet={packet142}
        busy={false}
        canResolve
        canResolveCompletion
        canEditGoal
        canArchive
        alsoAnswers={line}
        onResolveCustom={() => {}}
        onResolve={() => {}}
        onAsk={() => {}}
      />,
    );
    const note = container.querySelector("[data-also-answers]")!;
    expect(note.textContent).toContain(line);
    // Above the options, in document order.
    const options = container.querySelector(".options")!;
    expect(note.compareDocumentPosition(options) & Node.DOCUMENT_POSITION_FOLLOWING).
      toBeTruthy();
    // ...and absent entirely when the decision answers only this task.
    const plain = render(
      <DecisionPacket
        packet={packet142}
        busy={false}
        canResolve
        canResolveCompletion
        canEditGoal
        canArchive
        onResolveCustom={() => {}}
        onResolve={() => {}}
        onAsk={() => {}}
      />,
    );
    expect(plain.container.querySelector("[data-also-answers]")).toBeNull();
  });

  it("ruling 324: a create_task option names what already looks like it", () => {
    /**
     * The controller, unprompted, on what a reader of the final board would not
     * learn: "SHOP-27's decision packet was one confirmation away from creating
     * a duplicate of SHOP-29 — same three route modules, same pattern, already
     * written and sitting at Triage." Both near-misses were caught by a person
     * recognising the work, and a task that was never created leaves no trace.
     *
     * CANARY: render the echoes unconditionally (not keyed on the selection),
     * or drop the block entirely.
     */
    const packet: PacketRender = {
      ...packet142,
      options: [
        { kind: "custom", t: "Answer in your own words", d: "", rec: false },
        {
          kind: "create_task",
          t: "Create the gateway routes task",
          d: "",
          rec: false,
          newTask: {
            title: "Gateway routes for orders, cart and inventory",
            goal: "Expose the write side through the public edge.",
          },
        },
      ],
    };
    const echoes = {
      1: [{ key: "SHOP-29", title: "Gateway routes for inventory, cart and checkout", stage: "Triage" }],
    };
    const { container } = render(
      <DecisionPacket
        packet={packet}
        busy={false}
        canResolve
        canResolveCompletion
        canEditGoal
        canArchive
        createTaskEchoes={echoes}
        onResolveCustom={() => {}}
        onResolve={() => {}}
        onAsk={() => {}}
      />,
    );
    // Silent while a different option is selected: this is information about
    // THAT choice, not about the packet.
    expect(container.querySelector("[data-create-task-echoes]")).toBeNull();

    const radios = container.querySelectorAll('.options [role="radio"]');
    fireEvent.click(radios[1]!);
    const note = container.querySelector("[data-create-task-echoes]")!;
    expect(note).toBeTruthy();
    expect(note.textContent).toContain("SHOP-29");
    expect(note.textContent).toContain("Gateway routes for inventory, cart and checkout");
    expect(note.textContent).toContain("Triage");
    // It discloses, it does not refuse: the confirm still stands.
    expect(note.textContent).toContain("Confirming still creates a new one");
  });

  it("primary button confirms the selected option by index (concise stable label)", () => {
    const onResolve = vi.fn();
    const { container } = render(
      <DecisionPacket packet={packet142} busy={false} canResolve={true} canResolveCompletion={true} canEditGoal={true} canArchive={true} onResolveCustom={() => {}} onResolve={onResolve} onAsk={() => {}} />,
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
        onResolveCustom={() => {}} onResolve={onResolve}
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
      <DecisionPacket packet={blocked} busy={false} canResolve={true} canResolveCompletion={true} canEditGoal={true} canArchive={true} onResolveCustom={() => {}} onResolve={() => {}} onAsk={onAsk} />,
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
      ["quality", "quality", "Review verdict"],
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
    priority: "normal",
    labels: [],
    dueDate: null,
    blockedBy: [],
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
    otherCommits: [],
    changed: null,
    unownedPr: null,
    foreignHead: null,
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
      "Agent work in progress. No boundary is waiting",
    );
    expect(obs[2]!.textContent).toContain("Unowned: review & acceptance stall");
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
      "Admin release. Recorded as a typed event and in the audit trail.",
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
  {
    id: "developer", name: "Developer", role: "Implementation", backend: "codex", model: "codex-large",
    capabilities: { delivery: true, verdict: false, askHuman: false, browser: false },
  },
  {
    id: "reviewer", name: "Reviewer", role: "Code review", backend: "claude", model: "claude-sonnet",
    capabilities: { delivery: false, verdict: true, askHuman: false, browser: false },
  },
];

function execTask(patch: Partial<TaskSummary> = {}): TaskSummary {
  return { ...taskFixture("u-arda", "Arda Kaya"), ...patch };
}

/** Ruling 127: the fixture task's OWNER (`u-arda`, who is also the viewer) and
 *  what their accounts can run. A run on this task bills them, so this — not a
 *  deployment probe — is what every run control here answers from. */
function connectedPrincipal(
  patch: Partial<TaskRunPrincipalView> = {},
): TaskRunPrincipalView {
  return {
    ownerUserId: "u-arda",
    ownerName: "Arda Kaya",
    claude: { available: true, detail: null },
    codex: { available: true, detail: null },
    ...patch,
  };
}

/** Renders the rebuilt panel (dynamic-dispatch rework 2026-08-29): the operator
 *  run control, the run-an-agent combobox + prompt, the engaged-agents ledger
 *  and the owner cell — every mutation callback spied so a pin can assert the
 *  exact submit. */
/** U36-10: the board the run control resolves eligibility against. */
const EXEC_STAGES = [
  { id: "triage", name: "Triage" },
  { id: "impl", name: "Building" },
  { id: "review", name: "Review" },
  { id: "done", name: "Done" },
];
const EXEC_WORKFLOW = [
  { from: "triage", to: "impl" },
  { from: "impl", to: "review" },
  { from: "review", to: "done" },
];

function renderExec(
  task: TaskSummary,
  props: Partial<ComponentProps<typeof ExecutionProfile>> = {},
) {
  const onRunAgent = vi.fn();
  const onReleaseAgent = vi.fn();
  const onRunOperator = vi.fn();
  const onCancelSchedule = vi.fn();
  const utils = render(
    <MemoryRouter>
      <ExecutionProfile
        task={task}
        meId="u-arda"
        myRole="admin"
        busy={false}
        onOwner={() => {}}
        deployedSpecialists={deployedFixture}
        stages={EXEC_STAGES}
        workflow={EXEC_WORKFLOW}
        operatorBackend="claude"
        operatorAutonomy="supervised"
        runPrincipal={connectedPrincipal()}
        canRunAgents
        liveAgentRuns={[]}
        operatorRunActive={false}
        runInFlight={null}
        onRunAgent={onRunAgent}
        releaseBusy={false}
        onReleaseAgent={onReleaseAgent}
        operatorInFlight={null}
        onRunOperator={onRunOperator}
        schedules={[]}
        scheduleBusy={false}
        onCancelSchedule={onCancelSchedule}
        {...props}
      />
    </MemoryRouter>,
  );
  return { ...utils, onRunAgent, onReleaseAgent, onRunOperator, onCancelSchedule };
}

/* Scoped selectors — both run controls share classes (`.op-run`, `.op-steer`),
   so every query is addressed by aria-label or by the control's own span. */
const agentInput = (container: HTMLElement) =>
  container.querySelector<HTMLInputElement>(
    'input[aria-label="Choose an agent to run"]',
  );
const agentMenu = (container: HTMLElement) =>
  container.querySelector(".agent-select-menu");
const agentOptions = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')];
const agentPrompt = (container: HTMLElement) =>
  container.querySelector<HTMLInputElement>(
    'input[aria-label="Prompt for this agent run (optional)"]',
  )!;
const agentRunBtn = (container: HTMLElement) =>
  container.querySelector<HTMLButtonElement>(".agent-run > button.btn")!;
const agentDelay = (container: HTMLElement) =>
  container.querySelector<HTMLSelectElement>(
    'select[aria-label="When the agent run starts"]',
  )!;
const operatorSteer = (container: HTMLElement) =>
  container.querySelector<HTMLInputElement>(
    'input[aria-label="Steer this run (optional)"]',
  )!;
const operatorRunBtn = (container: HTMLElement) =>
  container.querySelector<HTMLButtonElement>(
    ".op-run:not(.agent-run) > button.btn",
  )!;
const operatorDelay = (container: HTMLElement) =>
  container.querySelector<HTMLSelectElement>(
    'select[aria-label="When the operator run starts"]',
  )!;
/** Picks an agent the way a pointer user does: open on focus, click the row. */
function pickAgent(container: HTMLElement, name: string) {
  fireEvent.focus(agentInput(container)!);
  const row = agentOptions(container).find((o) => o.textContent?.includes(name))!;
  expect(row).toBeDefined();
  fireEvent.click(row);
}

// The "assign menu + run button" describe covered the DELETED slot controls
// (assign/engage menus, per-row Run). Its replacement below pins the manual
// dispatch that superseded them: the AgentSelect combobox + prompt + Run.
describe("ExecutionProfile — the AgentSelect combobox", () => {
  it("opens on FOCUS with the whole deployed roster (no sigil, no minimum query)", () => {
    const { container } = renderExec(execTask());
    expect(agentMenu(container)).toBeNull();
    fireEvent.focus(agentInput(container)!);
    const menu = agentMenu(container)!;
    expect(menu.getAttribute("role")).toBe("listbox");
    const rows = agentOptions(container);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("Developer");
    expect(rows[0]!.textContent).toContain("Implementation · Codex");
    expect(rows[1]!.textContent).toContain("Reviewer");
    expect(rows[1]!.textContent).toContain("Code review · Claude");
  });

  it("type-to-filter narrows the roster and highlights the typed substring", () => {
    const { container } = renderExec(execTask());
    fireEvent.change(agentInput(container)!, { target: { value: "rev" } });
    const rows = agentOptions(container);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain("Reviewer");
    expect(rows[0]!.querySelector(".mention-match")!.textContent).toBe("Rev");
    // A query nothing matches keeps the menu up and says so, listing no rows.
    fireEvent.change(agentInput(container)!, { target: { value: "zzz" } });
    expect(agentOptions(container)).toHaveLength(0);
    expect(agentMenu(container)!.textContent).toContain(
      "No deployed agent matches.",
    );
  });

  it("keyboard: arrows arm and move the active row, Enter picks it, the input takes the name", () => {
    const { container } = renderExec(execTask());
    const input = agentInput(container)!;
    fireEvent.focus(input);
    // Hunt 2026-08-29: a focus-open starts UNARMED — no row highlighted, so a
    // pass-through Tab (or reflexive Enter) can commit nothing.
    expect(
      agentOptions(container).some(
        (o) => o.getAttribute("aria-selected") === "true",
      ),
    ).toBe(false);
    // The first arrow ARMS row 0; the second moves to row 1.
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(agentOptions(container)[0]!.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(agentOptions(container)[1]!.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(agentMenu(container)).toBeNull();
    expect(input.value).toBe("Reviewer");
    // The pick armed the run control.
    expect(agentRunBtn(container).disabled).toBe(false);
  });

  it("a bare Tab through the focus-opened menu commits NOTHING (hunt 2026-08-29)", () => {
    // The menu opens on focus with the whole roster; row 0 used to start
    // active, so tabbing THROUGH the control silently selected the
    // first-deployed agent — typically the repo-write deliverer — and the next
    // Enter in the prompt input dispatched a billable run nobody chose.
    // Ruling 147 moved the proof off `disabled`: the start stays clickable with
    // nothing picked, so what must hold is that no pick was made and a click
    // dispatches nothing.
    const { container, onRunAgent } = renderExec(execTask());
    const input = agentInput(container)!;
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: "Tab" });
    fireEvent.blur(input);
    expect(input.value).toBe("");
    fireEvent.click(agentRunBtn(container));
    expect(onRunAgent).not.toHaveBeenCalled();
    // Enter on the fresh focus-open likewise picks nothing — it just closes.
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(agentMenu(container)).toBeNull();
    expect(input.value).toBe("");
  });

  it("an Enter that only confirms an IME candidate does NOT pick a row", () => {
    const { container } = renderExec(execTask());
    const input = agentInput(container)!;
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    // Menu still open, nothing picked — a multibyte commit is not a selection.
    expect(agentMenu(container)).not.toBeNull();
    expect(input.value).toBe("");
  });

  it("rows carry the capability marks — running / no repo write / gates acceptance / model unavailable", () => {
    const marked: DeployedSpecialistView[] = [
      deployedFixture[0]!,
      {
        ...deployedFixture[1]!,
        modelUnavailable: "The requested model is not available on this account.",
      },
    ];
    const { container } = renderExec(execTask(), {
      deployedSpecialists: marked,
      liveAgentRuns: [{ profileId: "developer", lifecycle: "running" }],
    });
    fireEvent.focus(agentInput(container)!);
    const rows = agentOptions(container);
    expect(rows[0]!.textContent).toContain("Implementation · Codex · running");
    expect(rows[1]!.textContent).toContain(
      "Code review · Claude · no repo write · gates acceptance · model unavailable",
    );
    // The marks are claims about capability — the delivery-capable row wears none.
    expect(rows[0]!.textContent).not.toContain("no repo write");
  });

  it("typing invalidates a settled pick — the id is what submits, never free text", () => {
    const { container, onRunAgent } = renderExec(execTask());
    pickAgent(container, "Developer");
    expect(agentInput(container)!.value).toBe("Developer");
    fireEvent.change(agentInput(container)!, { target: { value: "Rev" } });
    // The selection is cleared until a row is picked again, so the start has
    // nothing to submit: ruling 147 keeps it enabled, and it dispatches nothing.
    fireEvent.click(agentRunBtn(container));
    expect(onRunAgent).not.toHaveBeenCalled();
  });
});

describe("ExecutionProfile — run an agent (prompt + Run/Schedule)", () => {
  it("Run submits onRunAgent(profileId, trimmed prompt, null) and clears the prompt", () => {
    const { container, onRunAgent } = renderExec(execTask());
    pickAgent(container, "Developer");
    fireEvent.change(agentPrompt(container), {
      target: { value: "  ship the fix  " },
    });
    fireEvent.click(agentRunBtn(container));
    expect(onRunAgent).toHaveBeenCalledWith("developer", "ship the fix", null);
    expect(agentPrompt(container).value).toBe("");
  });

  it("Enter in the prompt input submits the same run (search/chat convention)", () => {
    const { container, onRunAgent } = renderExec(execTask());
    pickAgent(container, "Developer");
    fireEvent.change(agentPrompt(container), { target: { value: "fix it" } });
    fireEvent.keyDown(agentPrompt(container), { key: "Enter" });
    expect(onRunAgent).toHaveBeenCalledWith("developer", "fix it", null);
  });

  /**
   * Ruling 147: an empty picker is validation, not availability, so the start
   * stays ENABLED and refuses the click — a dead button explained only by a
   * `title` no browser opens on a disabled control was the defect.
   */
  it("Run stays enabled with no pick and REFUSES the click, naming and focusing the picker", () => {
    const { container, onRunAgent } = renderExec(execTask());
    const btn = agentRunBtn(container);
    expect(btn.disabled).toBe(false);
    expect(btn.title).toContain("Choose an agent first");
    // 147(c): a pristine control is never accused.
    expect(agentInput(container)!.getAttribute("aria-invalid")).toBeNull();
    expect(container.querySelector('.agent-run [role="alert"]')).toBeNull();

    fireEvent.click(btn);
    expect(onRunAgent).not.toHaveBeenCalled();
    const alert = container.querySelector('.agent-run [role="alert"]')!;
    expect(alert.textContent).toContain("Choose an agent first");
    const input = agentInput(container)!;
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toBe(alert.id);
    expect(document.activeElement).toBe(input);

    // A second refusal re-INSERTS the alert (a new element, not a role flip on
    // unchanged text) so a reader announces it again.
    const first = alert;
    fireEvent.click(btn);
    expect(container.querySelector('.agent-run [role="alert"]')).not.toBe(first);
    expect(onRunAgent).not.toHaveBeenCalled();

    // Picking retires the accusation and arms the real dispatch.
    pickAgent(container, "Developer");
    expect(container.querySelector('.agent-run [role="alert"]')).toBeNull();
    expect(agentInput(container)!.getAttribute("aria-invalid")).toBeNull();
    fireEvent.click(agentRunBtn(container));
    expect(onRunAgent).toHaveBeenCalledWith("developer", "", null);
  });

  it("a live run on the SELECTED profile disables Run-now, but scheduling stays open", () => {
    const { container, onRunAgent } = renderExec(execTask(), {
      liveAgentRuns: [{ profileId: "developer", lifecycle: "running" }],
    });
    pickAgent(container, "Developer");
    expect(agentRunBtn(container).disabled).toBe(true);
    expect(agentRunBtn(container).title).toContain("already has a run in progress");
    // A deferred run is not a second concurrent run — the picker re-arms it.
    fireEvent.change(agentDelay(container), { target: { value: "5" } });
    expect(agentRunBtn(container).disabled).toBe(false);
    fireEvent.click(agentRunBtn(container));
    expect(onRunAgent).toHaveBeenCalledWith("developer", "", 5);
  });

  it("the DelayPicker turns Run into Schedule and submits delayMinutes", () => {
    const { container, onRunAgent } = renderExec(execTask());
    pickAgent(container, "Developer");
    expect(agentRunBtn(container).textContent).toContain("Run");
    fireEvent.change(agentDelay(container), { target: { value: "60" } });
    expect(agentRunBtn(container).textContent).toContain("Schedule");
    fireEvent.click(agentRunBtn(container));
    expect(onRunAgent).toHaveBeenCalledWith("developer", "", 60);
    // The control resets to run-now after the submit.
    expect(agentRunBtn(container).textContent).toContain("Run");
    expect(agentDelay(container).value).toBe("now");
  });

  it("names the posture the pick will take, BEFORE the run is spent", () => {
    // Delivery-capable pick on a task with no deliverer → it becomes the deliverer.
    const first = renderExec(execTask());
    pickAgent(first.container, "Developer");
    expect(first.container.querySelector(".agent-run")!.textContent).toContain(
      "Runs as the delivering agent: it owns the branch and PR.",
    );
    cleanup();

    // Verdict-capable, no repo write → reviewer, and the claim says what gates.
    const second = renderExec(execTask());
    pickAgent(second.container, "Reviewer");
    expect(second.container.querySelector(".agent-run")!.textContent).toContain(
      "Runs as a reviewer: its verdict gates acceptance.",
    );
    cleanup();

    // Delivery-capable while ANOTHER agent owns delivery → supporting.
    const third = renderExec(
      execTask({
        specialist: {
          kind: "agent",
          profileId: "other",
          backend: "codex",
          name: "Codex",
          role: "Implementation",
        },
      }),
    );
    pickAgent(third.container, "Developer");
    expect(third.container.querySelector(".agent-run")!.textContent).toContain(
      "Runs as a supporting agent (another agent owns delivery).",
    );
    cleanup();

    // No repo write AND no verdict → plain supporting.
    const docs: DeployedSpecialistView = {
      id: "docs", name: "Docs Writer", role: "Documentation", backend: "claude", model: "claude-sonnet",
      capabilities: { delivery: false, verdict: false, askHuman: false, browser: false },
    };
    const fourth = renderExec(execTask(), {
      deployedSpecialists: [...deployedFixture, docs],
    });
    pickAgent(fourth.container, "Docs Writer");
    expect(fourth.container.querySelector(".agent-run")!.textContent).toContain(
      "Runs as a supporting agent (no repo write).",
    );
  });

  it("discloses the dispatch-completion contract where the run starts", () => {
    const { container } = renderExec(execTask());
    expect(container.querySelector(".agent-run")!.textContent).toContain(
      "The run reports back tagging you and the operator",
    );
  });

  it("hunt 2026-08-29: an ALREADY-ENGAGED supporting profile's posture says so — the server keeps its shape", () => {
    // A repo-write profile engaged as SUPPORTING on a deliverer-less task used
    // to be promised delivery ("it owns the branch and PR") while the dispatch
    // honors the existing engagement and runs it read-only — producing no
    // branch and no PR against the panel's own claim.
    const { container } = renderExec(
      execTask({
        reviewers: [
          {
            kind: "agent",
            profileId: "developer",
            backend: "codex",
            name: "Codex",
            role: "Implementation",
          },
        ],
      }),
    );
    pickAgent(container, "Developer");
    expect(container.querySelector(".agent-run")!.textContent).toContain(
      "Runs as a supporting agent (already engaged).",
    );
    cleanup();
    // A verdict-capable engaged reviewer keeps the gating claim.
    const second = renderExec(
      execTask({
        reviewers: [
          {
            kind: "agent",
            profileId: "reviewer",
            backend: "claude",
            name: "Claude",
            role: "Code review",
          },
        ],
      }),
    );
    pickAgent(second.container, "Reviewer");
    expect(second.container.querySelector(".agent-run")!.textContent).toContain(
      "Runs as a reviewer (already engaged): its verdict gates acceptance.",
    );
  });

  it("hunt 2026-08-29: pending agent schedules stay visible (and cancellable) on a CLOSED task and an EMPTY roster", () => {
    // The closed/no-agents early returns used to swallow the schedule rows —
    // and the deleted Scheduled-re-runs panel was the only other surface that
    // listed them, so a pre-existing entry became invisible and uncancellable
    // while the runner still counted it due.
    const pending = [
      schedule({ id: "sch-ag", action: "run-agent", profileId: "reviewer", prompt: "recheck" }),
    ];
    const closed = renderExec(
      execTask({ displayReadiness: "accepted" }),
      { schedules: pending },
    );
    expect(closed.container.textContent).toContain(
      "Task closed. Reopen it to run an agent.",
    );
    expect(closed.container.querySelector(".agent-run .sched-list")).not.toBeNull();
    expect(closed.container.querySelector(".agent-run")!.textContent).toContain(
      "Reviewer run · recheck",
    );
    // Ruling 177 (U36-13, live 2026-09-12): visible is not enough — a pending
    // entry on a CLOSED task will be SKIPPED when it comes due, never run, and
    // the page said nothing while the control beside it said "Task closed".
    // The controller read two such entries on shipped HLC-19 and could not
    // tell whether they would fire. Canary: drop the `moot` prop at either
    // call site.
    expect(closed.container.querySelector("[data-sched-moot]")?.textContent).toContain(
      "will be skipped, not run: the task is closed",
    );
    cleanup();
    const bare = renderExec(execTask(), {
      deployedSpecialists: [],
      schedules: pending,
    });
    expect(bare.container.querySelector(".agent-run .sched-list")).not.toBeNull();
    // …and an OPEN task says nothing of the kind.
    expect(bare.container.querySelector("[data-sched-moot]")).toBeNull();
  });

  it("ruling 177 (U36-13): the OPERATOR control's pending entries say the same thing on a closed task", () => {
    const pending = [schedule({ id: "sch-op", action: "run-operator", prompt: "check in" })];
    const { container } = renderExec(execTask({ displayReadiness: "merged" }), {
      schedules: pending,
    });
    const moot = container.querySelector(".op-run:not(.agent-run) [data-sched-moot]");
    expect(moot?.textContent).toContain("This scheduled run will be");
    expect(moot?.textContent).toContain("skipped, not run: the task is closed");
  });

  it("zero deployed agents: the cell says so and points at the Agents page", () => {
    const { container } = renderExec(execTask(), { deployedSpecialists: [] });
    expect(container.textContent).toContain(
      "No agents deployed. Deploy one on the Agents page first.",
    );
    expect(agentInput(container)).toBeNull();
  });

  it("non-privileged role: no run control — the read-only tier copy instead (RBAC-gated)", () => {
    const { container } = renderExec(execTask(), {
      myRole: "contributor",
      canRunAgents: false,
    });
    expect(agentInput(container)).toBeNull();
    expect(operatorRunBtn(container)).toBeNull();
    expect(container.textContent).toContain(
      "The operator dispatches agents as the task moves.",
    );
    expect(container.textContent).toContain("needs the run-agents tier");
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

  // Owner request 2026-08-21: the run control SHOWS the profile's backend and
  // takes an optional steer — no per-run backend/autonomy pickers.
  it("shows the operator's backend as text and runs with the optional steer", () => {
    const { container, onRunOperator } = renderExec(
      execTask({ operator: attachedOperator }),
    );
    // No pickers — the backend is stated, not chosen.
    expect(
      container.querySelector('select[aria-label="Operator backend"]'),
    ).toBeNull();
    expect(
      container.querySelector('select[aria-label="Operator autonomy"]'),
    ).toBeNull();
    expect(container.querySelector(".op-backend")!.textContent).toBe("Claude");
    const steer = operatorSteer(container);
    fireEvent.change(steer, { target: { value: "  focus on the login page  " } });
    fireEvent.click(operatorRunBtn(container));
    // Trimmed steer reaches the submit (delay "Now" rides as null); the input
    // clears for the next run.
    expect(onRunOperator).toHaveBeenCalledWith("focus on the login page", null);
    expect(steer.value).toBe("");
  });

  it("the baked-in DelayPicker turns Run operator into Schedule and submits the minutes", () => {
    const { container, onRunOperator } = renderExec(
      execTask({ operator: attachedOperator }),
    );
    expect(operatorRunBtn(container).textContent).toContain("Run operator");
    fireEvent.change(operatorDelay(container), { target: { value: "1440" } });
    expect(operatorRunBtn(container).textContent).toContain("Schedule");
    fireEvent.change(operatorSteer(container), { target: { value: "check back" } });
    fireEvent.click(operatorRunBtn(container));
    expect(onRunOperator).toHaveBeenCalledWith("check back", 1440);
    // Reset for the next run: back to run-now.
    expect(operatorDelay(container).value).toBe("now");
    expect(operatorRunBtn(container).textContent).toContain("Run operator");
  });

  it("F20-5: an open decision packet disables the manual run, with the reason as rendered copy", () => {
    const { container, onRunOperator } = renderExec(
      execTask({ operator: attachedOperator, packet: packet142 }),
    );
    const run = operatorRunBtn(container);
    expect(run.disabled).toBe(true);
    fireEvent.click(run);
    expect(onRunOperator).not.toHaveBeenCalled();
    // A `title` never opens on a disabled control (P14) — the reason renders.
    expect(container.textContent).toContain(
      "Open decision. Resolve it before running the operator.",
    );
  });

  it("hunt 2026-08-29: the open-packet refusal blocks running NOW — scheduling stays alive (the packet resolves before it fires)", () => {
    // F20-5 refuses a paid no-op RIGHT NOW; scheduleTaskAction refuses no such
    // thing. The single `off` flag used to kill the picker and the button
    // together, blocking the one action that still works.
    const { container, onRunOperator } = renderExec(
      execTask({ operator: attachedOperator, packet: packet142 }),
    );
    expect(operatorRunBtn(container).disabled).toBe(true);
    fireEvent.change(operatorDelay(container), { target: { value: "60" } });
    const run = operatorRunBtn(container);
    expect(run.disabled).toBe(false);
    expect(run.textContent).toContain("Schedule");
    fireEvent.change(operatorSteer(container), { target: { value: "revisit" } });
    fireEvent.click(run);
    expect(onRunOperator).toHaveBeenCalledWith("revisit", 60);
    // Same split for a backend the OWNER has not connected (P11-41, ruling
    // 127): schedule-later stays alive — the fired run resolves the live
    // profile, and the live owner, anyway (R22).
    cleanup();
    const missing = renderExec(execTask({ operator: attachedOperator }), {
      operatorBackend: "codex",
      runPrincipal: connectedPrincipal({
        codex: { available: false, detail: null },
      }),
    });
    expect(operatorRunBtn(missing.container).disabled).toBe(true);
    fireEvent.change(operatorDelay(missing.container), { target: { value: "60" } });
    expect(operatorRunBtn(missing.container).disabled).toBe(false);
  });

  it("U36-10 (pass 36): a stage-ineligible pick is refused before the click, with the dispatch gate's sentence and no delivering posture", () => {
    // Live: the Code Reviewer (scoped to Agent Review) was listed as runnable
    // on an Intake task with "Runs as the delivering agent: it owns the branch
    // and PR."; the server refused after the click. Canary: delete the
    // `ineligible` computation in AgentRunControl.
    const scoped: DeployedSpecialistView[] = [
      { ...deployedFixture[1]!, stages: ["review"], spanAll: false },
    ];
    const { container } = renderExec(execTask({ stage: "triage" }), {
      deployedSpecialists: scoped,
    });
    const combo = container.querySelector<HTMLInputElement>('input[role="combobox"]')!;
    fireEvent.focus(combo);
    const option = container.querySelector<HTMLButtonElement>('[role="option"]')!;
    fireEvent.click(option);
    expect(container.textContent).toContain(
      "Reviewer is not eligible for the Triage stage; its profile is scoped to Review. Change the task's stage or the profile's eligible stages.",
    );
    expect(container.textContent).not.toContain("Runs as the delivering agent");
    const runBtn = [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Run")!;
    expect(runBtn.disabled).toBe(true);
  });

  it("a closed task disables the operator run and no longer advertises an @operator side door (N20-17 → ruling 177)", () => {
    const { container, onRunOperator } = renderExec(
      execTask({ operator: attachedOperator, displayReadiness: "accepted" }),
    );
    const run = operatorRunBtn(container);
    expect(run.disabled).toBe(true);
    fireEvent.click(run);
    expect(onRunOperator).not.toHaveBeenCalled();
    expect(container.textContent).toContain(
      "Task closed. Reopen it to run the operator.",
    );
    // Ruling 177 (pass 36): every door refuses a closed task, so the N20-17
    // disclosure that an @operator comment "still runs it" would now lie.
    expect(container.textContent).not.toContain("still runs it");
  });

  it("P11-41 without a picker: an operator backend the owner cannot run disables Run and says so", () => {
    const { container, onRunOperator } = renderExec(
      execTask({ operator: attachedOperator }),
      {
        operatorBackend: "codex",
        // Ruling 127: the question is the task OWNER's Codex account, not a
        // deployment credential probe — and the viewer here IS the owner, so
        // the store's own second-person sentence is what they read.
        meId: "u-arda",
        runPrincipal: connectedPrincipal({
          codex: {
            available: false,
            detail:
              "Codex isn't connected. Connect it on your Profile → Agent accounts.",
          },
        }),
      },
    );
    expect(container.querySelector(".op-backend")!.textContent).toBe("Codex");
    const run = operatorRunBtn(container);
    expect(run.hasAttribute("disabled")).toBe(true);
    fireEvent.click(run);
    expect(onRunOperator).not.toHaveBeenCalled();
    // The reason is rendered copy, not a title on a dead control (P14).
    expect(container.textContent).toContain(
      "Codex isn't connected. Connect it on your Profile → Agent accounts.",
    );
    expect(container.textContent).toContain(
      "Runs on this task use your own account",
    );
    // No instance credential is named: since ruling 127 there is none to name.
    expect(container.textContent).not.toContain("on this instance");
  });

  it("F20-9 mirror: full autonomy announces itself on the run surface", () => {
    const { container } = renderExec(execTask({ operator: attachedOperator }), {
      operatorBackend: "claude",
      operatorAutonomy: "full" as const,
      // F37-65: the acceptance half of this caption is now conditional on the
      // GRANT resolving to direct, which is what the runtime gate asks.
      acceptsDirectly: true,
      runPrincipal: connectedPrincipal(),
    });
    expect(container.textContent).toContain(
      "Full autonomy: this run can move the task and accept completion",
    );
  });

  it("F37-65: full autonomy WITHOUT a direct acceptance grant does not promise acceptance", () => {
    // `gate()` holds `completion-for-acceptance` at `recommend` whatever the
    // autonomy unless the grant says direct (owner ruling Q1). This caption read
    // autonomy alone, so on shopify-clone-platform — `autonomy: full`,
    // `completion-for-acceptance: recommend` — every task page promised an
    // acceptance the operator could not perform, while every acceptance in the
    // pass was a person pressing the button.
    // CANARY: render the old single sentence unconditionally.
    const { container } = renderExec(execTask({ operator: attachedOperator }), {
      operatorBackend: "claude",
      operatorAutonomy: "full" as const,
      acceptsDirectly: false,
      runPrincipal: connectedPrincipal(),
    });
    expect(container.textContent).toContain("Full autonomy: this run can move the task.");
    expect(container.textContent).toContain("Accepting completion still needs a person");
    expect(container.textContent).not.toContain("accept completion itself");
  });

  it("states the operator's dispatch mandate on the cell", () => {
    // The rework's one-line contract: the operator decides who runs at each
    // stage, reading the current stage AND the one the task arrived from.
    const { container } = renderExec(execTask({ operator: attachedOperator }));
    expect(container.textContent).toContain(
      "Decides which agent runs at each stage",
    );
    expect(container.textContent).toContain("the one it came from");
  });
});

// The "reviewers" describe covered the DELETED engage menu and per-reviewer Run
// buttons. Its replacement pins the ENGAGED AGENTS ledger: the honest record of
// who is attached (delivers / gates acceptance / running…), read-only except
// releasing a supporting engagement.
describe("ExecutionProfile — engaged agents ledger", () => {
  const engagedTask = () =>
    execTask({
      specialist: {
        kind: "agent",
        profileId: "developer",
        backend: "codex",
        name: "Codex",
        role: "Implementation",
      },
      reviewers: [
        { kind: "agent", profileId: "reviewer", backend: "claude", name: "Claude", role: "Code review" },
      ],
    });

  it("the delivering row is marked 'delivers' and offers no release", () => {
    const { container } = renderExec(engagedTask());
    const rows = [...container.querySelectorAll(".rev-agent")];
    expect(rows).toHaveLength(2);
    // The row shows the DEPLOYED profile's display name, not the runtime label.
    expect(rows[0]!.querySelector(".nm")!.textContent).toBe("Developer");
    expect(rows[0]!.textContent).toContain("Implementation · Codex · delivers");
    // Delivery is not releasable from the ledger — no ✕ on the delivering row.
    expect(rows[0]!.querySelector(".rev-x")).toBeNull();
  });

  it("a verdict-capable supporting row says 'gates acceptance'; its ✕ releases (UC-13/F21-6)", () => {
    const { container, onReleaseAgent } = renderExec(engagedTask());
    const row = [...container.querySelectorAll(".rev-agent")][1]!;
    expect(row.textContent).toContain("Code review · Claude · gates acceptance");
    // The claim is about verdict authority — the delivering row must not wear it.
    expect(
      [...container.querySelectorAll(".rev-agent")][0]!.textContent,
    ).not.toContain("gates acceptance");
    const x = row.querySelector<HTMLButtonElement>(".rev-x")!;
    expect(x.getAttribute("aria-label")).toBe("Release Code review agent");
    fireEvent.click(x);
    expect(onReleaseAgent).toHaveBeenCalledWith("reviewer");
  });

  it("a live run marks its own row 'running…' and no other", () => {
    const { container } = renderExec(engagedTask(), {
      liveAgentRuns: [{ profileId: "reviewer", lifecycle: "running" }],
    });
    const rows = [...container.querySelectorAll(".rev-agent")];
    expect(rows[1]!.textContent).toContain("running…");
    expect(rows[0]!.textContent).not.toContain("running…");
  });

  it("an engagement whose profile left the roster ghosts, with the recovery note (UX19-12)", () => {
    const task = execTask({
      reviewers: [
        { kind: "agent", profileId: "gone", backend: "claude", name: "Claude", role: "Code review" },
      ],
    });
    const { container } = renderExec(task);
    const row = container.querySelector(".rev-agent")!;
    expect(row.querySelector(".nm")!.textContent).toBe("profile no longer here");
    expect(row.textContent).toContain(
      "Not deployed on this project any more. Release it, or re-deploy the profile on the Agents page.",
    );
  });

  it("empty ledger: the operator is the picker, and runners are told about the manual path", () => {
    const priv = renderExec(execTask());
    expect(priv.container.textContent).toContain(
      "None yet. The operator picks who runs at each stage, or run one yourself above.",
    );
    cleanup();
    // Without the run-agents tier the manual-path clause would advertise a
    // control the panel does not render for this reader.
    const ro = renderExec(execTask(), { myRole: "contributor", canRunAgents: false });
    expect(ro.container.textContent).toContain(
      "None yet. The operator picks who runs at each stage.",
    );
    expect(ro.container.textContent).not.toContain("run one yourself");
  });

  it("non-privileged role: ledger rows render read-only (no release ✕)", () => {
    const { container } = renderExec(engagedTask(), {
      myRole: "contributor",
      canRunAgents: false,
    });
    expect(container.querySelectorAll(".rev-agent")).toHaveLength(2);
    expect(container.querySelector(".rev-agent .rev-x")).toBeNull();
  });
});

// P14-WL-07's invariant survives the rework re-shaped: a closed (merged/
// accepted/archived) task must not advertise ways to start runs. The controls
// it must withdraw are now the run-an-agent combobox and the operator Run.
describe("ExecutionProfile — a closed task offers no run controls (P14-WL-07)", () => {
  const closedTask = () => execTask({ displayReadiness: "merged" });

  it("replaces the run-an-agent control with the reason", () => {
    const { container, getByText } = renderExec(closedTask());
    expect(agentInput(container)).toBeNull();
    expect(getByText("Task closed. Reopen it to run an agent.")).toBeTruthy();
  });

  it("an ARCHIVED task is out of the flow too (F15-11)", () => {
    const { container, getByText } = renderExec(execTask({ archived: true }));
    expect(agentInput(container)).toBeNull();
    expect(getByText("Task closed. Reopen it to run an agent.")).toBeTruthy();
    expect(container.textContent).toContain("task closed"); // the head pill
  });

  it("still offers both run controls on an OPEN task", () => {
    const { container } = renderExec(execTask());
    expect(agentInput(container)).not.toBeNull();
    expect(operatorRunBtn(container)).not.toBeNull();
    expect(operatorRunBtn(container).disabled).toBe(false);
  });
});

/**
 * F33-10 (UI half) — the release ✕ was the last runtime affordance a closed
 * task still offered. The panel head wears the "task closed" pill, the
 * run-an-agent cell has replaced itself with "Task closed. Reopen it to run an
 * agent.", the operator Run is disabled with its reason rendered — and one row
 * down the ledger sat an ENABLED ✕ titled "Release this agent from the task",
 * which the server refuses at the terminal stage. Ruling 37 settles the shape
 * of the fix: a WITHDRAWN affordance is honest, a disabled one just invites the
 * support question. The ledger ROW keeps rendering either way — it is the
 * record of who was engaged, and a closed task has the most reason to keep it.
 */
describe("ExecutionProfile — a closed task withholds the release ✕ (F33-10)", () => {
  const withSupporting = (patch: Partial<TaskSummary> = {}) =>
    execTask({
      reviewers: [
        {
          kind: "agent",
          profileId: "reviewer",
          backend: "claude",
          name: "Claude",
          role: "Code review",
        },
      ],
      ...patch,
    });

  it("an OPEN task still offers it (withheld on closed, not deleted outright)", () => {
    const { container } = renderExec(withSupporting());
    expect(container.querySelectorAll(".rev-agent")).toHaveLength(1);
    expect(container.querySelector(".rev-agent .rev-x")).not.toBeNull();
  });

  it("a MERGED task keeps the ledger row and drops the ✕", () => {
    const { container } = renderExec(withSupporting({ displayReadiness: "merged" }));
    expect(container.querySelectorAll(".rev-agent")).toHaveLength(1);
    expect(container.querySelector(".rev-agent .rev-x")).toBeNull();
  });

  it("an ACCEPTED task drops it too", () => {
    const { container } = renderExec(
      withSupporting({ displayReadiness: "accepted" }),
    );
    expect(container.querySelectorAll(".rev-agent")).toHaveLength(1);
    expect(container.querySelector(".rev-agent .rev-x")).toBeNull();
  });

  it("an ARCHIVED task drops it too (F15-11)", () => {
    const { container } = renderExec(withSupporting({ archived: true }));
    expect(container.querySelectorAll(".rev-agent")).toHaveLength(1);
    expect(container.querySelector(".rev-agent .rev-x")).toBeNull();
  });
});

describe("ExecutionProfile — owner cell (owner request 2026-08-21)", () => {
  it("an OWNED task shows the owner chip alone — no Manage popover", () => {
    // Release stays one panel away on the Current-state Owner row (own-x); a
    // hand-off is release + take. This cell only states who owns the task.
    const { container } = renderExec(execTask());
    expect(container.querySelector(".rev-chip")!.textContent).toContain(
      "Arda Kaya · you",
    );
    expect(
      Array.from(container.querySelectorAll(".own-btn")).some((b) =>
        b.textContent?.includes("Manage"),
      ),
    ).toBe(false);
    expect(
      container.querySelector('[aria-label="Manage task ownership"]'),
    ).toBeNull();
  });

  it("an UNOWNED task keeps the Assign-me affordance (unchanged half)", () => {
    const { container } = renderExec(execTask({ owner: null }));
    expect(container.textContent).toContain(
      "Unowned. Any contributor or above can take it",
    );
    expect(
      Array.from(container.querySelectorAll(".rev-add")).some((b) =>
        b.textContent?.includes("Assign me"),
      ),
    ).toBe(true);
  });
});

/* ------------------------------------------- popover dismissal (AgentSelect) */

/**
 * Pass 16 asserted the shared dismiss contract on the panel's assign/engage
 * menus; both menus are gone with the slot ceremony. The one popover left on
 * the panel is the AgentSelect listbox, a focus-scoped combobox — its dismissal
 * is Escape (restoring the settled selection) and blur, not the use-dismiss
 * outside-press hook, so these pin THAT contract.
 */
describe("ExecutionProfile — the agent listbox dismisses cleanly", () => {
  it("Escape closes the menu; a still-settled selection's name comes back", () => {
    const { container, onRunAgent } = renderExec(execTask());
    pickAgent(container, "Developer");
    const input = agentInput(container)!;
    // Reopen from the settled pick: the query starts empty (full roster).
    fireEvent.focus(input);
    expect(agentMenu(container)).not.toBeNull();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(agentMenu(container)).toBeNull();
    // No typing happened, so the pick still stands and the input shows it.
    expect(input.value).toBe("Developer");
    // Typing INVALIDATES the pick (the id is what submits), so an Escape after
    // a query empties the input instead of resurrecting a cleared selection.
    fireEvent.change(input, { target: { value: "rev" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(agentMenu(container)).toBeNull();
    expect(input.value).toBe("");
    // Nothing is picked, so the start (enabled since ruling 147) submits nothing.
    fireEvent.click(agentRunBtn(container));
    expect(onRunAgent).not.toHaveBeenCalled();
  });

  it("blur closes the menu; a row's mousedown is prevented so blur can't beat the pick", () => {
    const { container, onRunAgent } = renderExec(execTask());
    const input = agentInput(container)!;
    fireEvent.focus(input);
    expect(agentMenu(container)).not.toBeNull();
    // The option rows preventDefault their mousedown, keeping focus in the
    // input, so the click that follows still lands on a live row.
    const row = agentOptions(container)[0]!;
    const mousedown = fireEvent.mouseDown(row);
    expect(mousedown).toBe(false); // preventDefault() was called
    fireEvent.blur(input);
    expect(agentMenu(container)).toBeNull();
    expect(onRunAgent).not.toHaveBeenCalled();
  });
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
    workflow: [],
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

describe("GithubTrace — branch collision framing (F31-1)", () => {
  it("names the unowned PR as a collision instead of leaving the branch to read as this task's", () => {
    const { container } = render(
      <MemoryRouter>
        <GithubTrace
          githubHost={GH_HOST}
          task={traceTask({ unownedPr: 232 })}
          acceptance={traceAcceptance()}
        />
      </MemoryRouter>,
    );
    const row = Array.from(container.querySelectorAll(".kv-row")).find((r) =>
      r.textContent?.includes("Collision"),
    )!;
    expect(row).toBeDefined();
    expect(row.textContent).toContain("#232");
    expect(row.textContent).toContain("not this task");
  });

  it("ruling 360: the PR card names a read GitHub refused, and a summary outranks it", () => {
    // CANARY: drop the `prChecksUnread` pill from the card.
    const refused = {
      status: 403,
      message: "Resource not accessible by personal access token",
      at: "2026-09-18T08:00:00.000Z",
    };
    const pr = { number: 10, state: "review" as const, title: "[VIB-151] work" };
    const { container } = render(
      <MemoryRouter>
        <GithubTrace
          githubHost={GH_HOST}
          task={traceTask({ pr, prChecks: null, prChecksUnread: refused })}
          acceptance={traceAcceptance()}
        />
      </MemoryRouter>,
    );
    const pill = container.querySelector("[data-checks-unread]");
    expect(pill).not.toBeNull();
    expect(pill!.textContent).toContain("checks not readable");
    expect(pill!.getAttribute("title")).toContain("(HTTP 403)");

    const { container: read } = render(
      <MemoryRouter>
        <GithubTrace
          githubHost={GH_HOST}
          task={traceTask({
            pr,
            prChecks: { total: 2, passing: 2, failing: 0, pending: 0, state: "passing" },
            prChecksUnread: refused,
          })}
          acceptance={traceAcceptance()}
        />
      </MemoryRouter>,
    );
    expect(read.querySelector("[data-checks-unread]")).toBeNull();
  });

  it("renders no collision row when nothing squats on the branch", () => {
    const { container } = render(
      <MemoryRouter>
        <GithubTrace
          githubHost={GH_HOST}
          task={traceTask({ unownedPr: null })}
          acceptance={traceAcceptance()}
        />
      </MemoryRouter>,
    );
    expect(
      Array.from(container.querySelectorAll(".kv-row")).some((r) =>
        r.textContent?.includes("Collision"),
      ),
    ).toBe(false);
  });
});

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

  it("ruling 124: NO force-accept on a task with nothing to accept and no wedge", () => {
    // The standing offer this removes: a task created seconds ago — no branch,
    // no PR, no revision, no blocked packet — showed an admin "skips the
    // remaining stages and the review gate" directly above "No branch yet"
    // (pass 33, Q33-2). Ruling 59's escape hatch is kept by the case above.
    const { container, getByText } = render(
      <MemoryRouter>
        <GithubTrace
          githubHost={GH_HOST}
          task={traceTask({ branch: null, pr: null, blockReason: null, packet: null })}
          acceptance={traceAcceptance({
            atBoundary: false,
            blockedReason: "VIB-142 is at Triage, not Review.",
          })}
          onForceAccept={vi.fn()}
        />
      </MemoryRouter>,
    );
    expect(getByText(/No branch yet/)).toBeTruthy();
    expect(
      Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
        b.textContent?.includes("Force accept"),
      ),
    ).toBeUndefined();
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
      "The Checked row above says when GitHub was last read",
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
        onResolveCustom={() => {}} onResolve={() => {}}
        onAsk={() => {}}
      />,
    );
    const obs = container.querySelectorAll(".packet-obs .obs");
    expect(obs[0]!.textContent).toContain("unassigned");
    expect(obs[0]!.textContent).not.toContain("null");
    expect(obs[1]!.textContent).toContain("none");
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

  it("ruling 138 / F35-6: a DECIDED edit_goal packet renders the chosen option locked, no Confirm, the requested goal itself, and one 'Edit the goal' control that opens that same draft", () => {
    // Canary: ignore `p.awaiting`/`p.decided` in the card and the radiogroup +
    // Confirm come back. F35-6 canary: drop the `.goal-draft` figure and the
    // draft assert is red; hand the button `goalDraftForOption(chosen)` again
    // instead of `p.goalDraft` and the call assert is red (the mapping's
    // draft, not the card's own composition, is what the editor opens with).
    const onEditGoal = vi.fn();
    const onResolve = vi.fn();
    const decidedPacket: PacketRender = {
      ...goalPacket,
      awaiting: "goal_edit",
      decided: { optionIndex: 0, at: "2026-09-04T10:00:00.000Z", byUserId: "u-arda" },
      goalDraft: "Deliverable: the search page.\n\nAcceptance: results render.",
    };
    const { container, queryByRole, getByRole } = render(
      <DecisionPacket
        packet={decidedPacket}
        busy={false}
        canResolve
        canResolveCompletion
        canEditGoal
        canArchive
        onResolveCustom={() => {}}
        onResolve={onResolve}
        onAsk={() => {}}
        onEditGoal={onEditGoal}
      />,
    );
    expect(container.querySelector(".packet[data-decided]")).not.toBeNull();
    expect(queryByRole("radiogroup")).toBeNull();
    expect(queryByRole("button", { name: /^Confirm decision/ })).toBeNull();
    const chosen = container.querySelector<HTMLButtonElement>(".opt[data-chosen]")!;
    expect(chosen.textContent).toContain("A human refines the goal");
    expect(chosen.textContent).toContain("chosen");
    expect(chosen.disabled).toBe(true);
    expect(container.querySelector("[data-decided-note]")?.textContent).toContain(
      "Decision made · save the edited goal to clear this packet",
    );
    // F35-6: the requested goal is ON the page after a reload, not only inside
    // the editor's prefill, so a person sees what "save the edited goal" means.
    const figure = container.querySelector(".goal-draft")!;
    expect(figure.querySelector("figcaption")?.textContent).toBe(
      "Requested goal (opens in the editor)",
    );
    expect(figure.querySelector("pre.goal-draft-text")?.textContent).toBe(
      "Deliverable: the search page.\n\nAcceptance: results render.",
    );
    fireEvent.click(getByRole("button", { name: "Edit the goal" }));
    expect(onEditGoal).toHaveBeenCalledWith(
      "Deliverable: the search page.\n\nAcceptance: results render.",
    );
    expect(onResolve).not.toHaveBeenCalled();
  });

  it("ruling 138: an awaiting packet WITHOUT a recorded decision renders nothing special", () => {
    const { queryByRole } = render(
      <DecisionPacket
        packet={{ ...goalPacket, awaiting: "goal_edit" }}
        busy={false}
        canResolve
        canResolveCompletion
        canEditGoal
        canArchive
        onResolveCustom={() => {}}
        onResolve={() => {}}
        onAsk={() => {}}
      />,
    );
    expect(queryByRole("radiogroup")).not.toBeNull();
  });

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
        onResolveCustom={() => {}} onResolve={onResolve}
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

  it("leaves the refusal's dim to the sheet, which also stills its hover and press (ruling 459)", () => {
    // The blocked option and the refused Confirm each carried an inline .55
    // of their own, off the house .45 step, and the sheet's `:not(:disabled)`
    // hover and press still matched both. The attribute is now the whole
    // contract: `.opt[aria-disabled="true"]` and `.btn[aria-disabled="true"]`
    // dim them in app.css, which pins those rules.
    const { container } = render(
      <DecisionPacket
        packet={goalPacket}
        busy={false}
        canResolve
        canResolveCompletion={false}
        canEditGoal={false}
        canArchive
        onResolveCustom={() => {}} onResolve={() => {}}
        onAsk={() => {}}
      />,
    );
    const blocked = container.querySelectorAll<HTMLButtonElement>(".options .opt")[0]!;
    const confirm = container.querySelector<HTMLButtonElement>(
      ".packet-actions .btn.primary",
    )!;
    for (const el of [blocked, confirm]) {
      expect(el.getAttribute("aria-disabled")).toBe("true");
      expect(el.getAttribute("style")).toBeNull();
    }
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
        onResolveCustom={() => {}} onResolve={() => {}}
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
        onResolveCustom={() => {}} onResolve={() => {}}
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
        onResolveCustom={() => {}} onResolve={() => {}}
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
        onResolveCustom={() => {}} onResolve={() => {}}
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
  /** The task the closed-PR recovery is about HAS a branch — that fact, not
   *  the option shape, is what the paragraph describes (U36-2). */
  const RECOVERY_DISCLOSURE = {
    taskKey: "VIB-142",
    branch: "vib-142",
    pendingRecommendations: 0,
    unownedPr: null,
    foreignHead: null,
    openPr: null,
  };

  it("U36-2 (pass 36): a branchless task renders no re-delivery paragraph, whatever the options say", () => {
    // Live: an `input` packet on HLC-9 (no branch, no PR, no closure) rendered
    // the closed-PR recovery paragraph. Canary: drop the
    // `archiveDisclosure?.branch != null` half of `branchDiscardOffered`.
    const packetView = render(
      <DecisionPacket
        packet={recoveryPacket}
        busy={false}
        canResolve
        canResolveCompletion
        canEditGoal
        canArchive
        archiveDisclosure={{ ...RECOVERY_DISCLOSURE, branch: null }}
        onResolveCustom={() => {}} onResolve={() => {}}
        onAsk={() => {}}
      />,
    );
    expect(noteOf(packetView.container)).toBeUndefined();
  });

  it("points at the SAME control the GitHub panel renders beside it", () => {
    const packetView = render(
      <DecisionPacket
        packet={recoveryPacket}
        busy={false}
        canResolve
        canResolveCompletion
        canEditGoal
        canArchive
        archiveDisclosure={RECOVERY_DISCLOSURE}
        onResolveCustom={() => {}} onResolve={() => {}}
        onAsk={() => {}}
      />,
    );
    const note = noteOf(packetView.container)!;
    expect(note).toBeTruthy();
    expect(note.textContent).toContain(DELIVER_LABEL);
    // Ruling 160: the door is REFUSED while the closure is unanswered, and this
    // packet is what answers it — so the note must name the refusal and make
    // resolving the precondition, never a click the reader can skip to.
    expect(note.textContent).toContain("refused while this decision stands");
    expect(note.textContent).toContain("Answering here is what lifts it");
    // Still true, and still the reason this is the in-app path: the fresh PR is
    // a new one, never a reopen this app cannot perform.
    expect(note.textContent).toContain("opens a new review pull request");
    expect(note.textContent).toContain("never reopens a closed one");
    // The promise the packet body makes about GitHub travels here honestly now.
    expect(note.textContent).toContain("Reopening the pull request on GitHub");
    // The old copy told the reader delivering did NOT resolve the packet, which
    // under ruling 160 reads as "click it and skip this decision" — the one
    // path that always fails.
    expect(note.textContent).not.toContain("does not resolve this packet");

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
    // Ruling 160: and that control refuses, so it says so on itself rather than
    // 409-ing after the click. The refusal names the PR and is readable, not
    // parked in `title` alone.
    expect(deliver!.disabled).toBe(true);
    const refusal = panel.container.querySelector("#deliver-closed-refusal");
    expect(refusal?.textContent).toContain("PR #143 was closed without merging");
    expect(refusal?.textContent).toContain("closed-PR decision is answered");
    expect(deliver!.getAttribute("aria-describedby")).toBe("deliver-closed-refusal");
  });

  it("names the closer, and lets go once a person has answered the closure", () => {
    // The unlock is `pr.closure.answered`, the same record `openTaskPr` reads:
    // an answered closure returns the control to its normal promise. Canary:
    // drop `!task.pr.closure?.answered` from `closedRefusal` and the answered
    // case stays refused.
    const closed = (closure: PrRef["closure"]) =>
      render(
        <MemoryRouter>
          <GithubTrace
            githubHost={GH_HOST}
            task={traceTask({
              pr: { number: 143, state: "closed", title: "x", closure },
            })}
            acceptance={traceAcceptance({})}
            onDeliver={() => {}}
          />
        </MemoryRouter>,
      );
    const unanswered = closed({
      at: "2026-09-06T19:33:00.000Z",
      by: "akin-ozer",
      answered: null,
    });
    expect(
      unanswered.container.querySelector("#deliver-closed-refusal")?.textContent,
    ).toContain("closed without merging by akin-ozer");

    const answered = closed({
      at: "2026-09-06T19:33:00.000Z",
      by: "akin-ozer",
      answered: { at: "2026-09-06T20:00:00.000Z", byUserId: "u1" },
    });
    expect(answered.container.querySelector("#deliver-closed-refusal")).toBeNull();
    const btn = [
      ...answered.container.querySelectorAll<HTMLButtonElement>("button"),
    ].find((b) => b.textContent?.includes(DELIVER_LABEL));
    expect(btn?.disabled).toBe(false);
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
        onResolveCustom={() => {}} onResolve={() => {}}
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
        onResolveCustom={() => {}} onResolve={() => {}}
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
        onResolveCustom={() => {}} onResolve={onResolve}
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
        archiveDisclosure={{ taskKey: "VIB-1", branch: "vib-1", pendingRecommendations: 0, unownedPr: null, openPr: null, foreignHead: null }}
        onResolveCustom={() => {}} onResolve={onResolve}
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

  it("F31-6: a resolve_remote_collision option asks first, names the deletes/keeps split, then resolves by index", () => {
    const onResolve = vi.fn();
    const { container } = render(
      <DecisionPacket
        packet={withOptions([
          {
            kind: "resolve_remote_collision",
            t: "Delete the stale remote branch, then redeliver",
            d: "The remote vib-1 is unrelated to this task's work.",
            rec: true,
          },
        ])}
        busy={false}
        canResolve
        canResolveCompletion
        canEditGoal
        canArchive
        canDiscardBranch
        archiveDisclosure={{
          taskKey: "VIB-1",
          branch: "vib-1",
          pendingRecommendations: 0,
          unownedPr: 232,
          foreignHead: null,
          openPr: null,
        }}
        onResolveCustom={() => {}} onResolve={onResolve}
        onAsk={() => {}}
      />,
    );
    fireEvent.click(container.querySelector(".packet-actions .btn.primary")!);
    // Nothing resolved on the first click — the ceremony interposes.
    expect(onResolve).not.toHaveBeenCalled();
    const dialog = container.ownerDocument.querySelector(
      'dialog[data-screen-label="Packet collision dialog"]',
    )!;
    expect(dialog).toBeTruthy();
    // The three-row truth: deletes the REMOTE ref + closes the unowned PR,
    // KEEPS the local delivery.
    expect(dialog.textContent).toContain("vib-1");
    expect(dialog.textContent).toContain("#232");
    expect(dialog.textContent).toContain("cannot be undone");
    expect(dialog.textContent).toContain("local delivery");
    fireEvent.click(
      Array.from(dialog.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("Clear collision"),
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
        onResolveCustom={() => {}} onResolve={() => {}}
        onAsk={() => {}}
      />,
    );
    const opts = container.querySelectorAll<HTMLButtonElement>(".options .opt");
    expect(opts[0]!.getAttribute("aria-disabled")).toBe("true");
    expect(opts[0]!.textContent).toContain("your role can't discard the branch");
  });

  /**
   * V16 — `resolve_remote_collision` was dimmed, `aria-disabled` and hover-
   * titled below `approve-transition`, but the per-option DESCRIPTION chain
   * (which its three siblings all appear in) had no arm for it. A `title` needs
   * a pointer, so a keyboard or touch user got an inert option and no reason at
   * all. The gate table is what closes it: one row per kind, read by the option
   * row, the hover title AND the card-level refusal.
   */
  it("V16: a blocked resolve_remote_collision states its tier in the description, the title and the deny note", () => {
    const { container } = render(
      <DecisionPacket
        packet={withOptions([
          {
            kind: "resolve_remote_collision",
            t: "Delete the stale remote branch, then redeliver",
            d: "The remote vib-1 is unrelated to this task's work.",
            rec: true,
          },
          { kind: "request_edit", t: "Send it back", d: "", rec: false },
        ])}
        busy={false}
        canResolve
        canResolveCompletion
        canEditGoal
        canArchive
        canDiscardBranch={false}
        onResolveCustom={() => {}} onResolve={() => {}}
        onAsk={() => {}}
      />,
    );
    const opts = container.querySelectorAll<HTMLButtonElement>(".options .opt");
    expect(opts[0]!.getAttribute("aria-disabled")).toBe("true");
    // Canary: drop the collision row's `option` from PACKET_TIER_GATES (or the
    // `note` off it) and this goes red — that was the shipped state.
    expect(opts[0]!.querySelector(".od")!.textContent).toContain(
      "your role can't clear the collision",
    );
    expect(opts[0]!.title).toContain(
      "Clearing a branch collision is reserved for maintainers and admins",
    );
    // The un-gated sibling stays live, so the ONE deny note is the tier refusal
    // for the selected option (not the every-option-forbidden escalation).
    expect(opts[1]!.getAttribute("aria-disabled")).toBeNull();
    const denies = container.querySelectorAll(".deny-note");
    expect(denies).toHaveLength(1);
    expect(denies[0]!.textContent).toContain(
      "Clearing a branch collision is reserved for maintainers and admins.",
    );
  });

  /**
   * Ruling 164 (pass 35, F35-14): the two new kinds carry the tier of the
   * control they perform, in the same table every other gated kind reads. A
   * maintainer holds `approve-transition` (the stage picker) but not
   * `force-accept-completion` (admin), so one option is live and one is not.
   */
  it("ruling 164: force_accept takes the admin tier and move_stage the stage picker's, each with its own sentence", () => {
    // Canary: drop either row from PACKET_TIER_GATES and a maintainer is
    // offered a click the server answers with a 403.
    const { container } = render(
      <DecisionPacket
        packet={withOptions([
          {
            kind: "force_accept",
            t: "Force-accept without a fresh verdict",
            d: "",
            rec: true,
          },
          {
            kind: "move_stage",
            t: "Move VIB-1 back to Review",
            d: "",
            toStage: "review",
          },
        ])}
        busy={false}
        canResolve
        canResolveCompletion
        canEditGoal
        canArchive
        canDiscardBranch
        canForceAccept={false}
        canMoveStage
        onResolveCustom={() => {}}
        onResolve={() => {}}
        onAsk={() => {}}
      />,
    );
    const opts = container.querySelectorAll<HTMLButtonElement>(".options .opt");
    expect(opts[0]!.getAttribute("aria-disabled")).toBe("true");
    expect(opts[0]!.querySelector(".od")!.textContent).toContain(
      "your role can't force-accept",
    );
    // The move stays live for the same viewer: it is the picker's own tier.
    expect(opts[1]!.getAttribute("aria-disabled")).toBeNull();
    const denies = container.querySelectorAll(".deny-note");
    expect(denies).toHaveLength(1);
    expect(denies[0]!.textContent).toContain(
      "Force-accepting past the review gate is reserved for admins.",
    );
  });

  /**
   * Ruling 161 (pass 35, U35-8): the delete-branch ceremony says what origin
   * holds when the reconciler recorded a foreign head. Live (KNC-21) the
   * dialog promised to delete "this task's" branch while the ref held a
   * foreign fixture commit the packet itself called "not ours".
   */
  it("U35-8: the archive + deleteBranch dialog names the foreign remote head and its PR before the button", () => {
    // Canary: drop the `foreignHead` block from `PacketArchiveConfirm` and
    // the sentence is gone.
    const renderWith = (foreignHead: { sha: string | null; prNumber: number | null } | null) =>
      render(
        <DecisionPacket
          packet={withOptions([
            {
              kind: "archive_task",
              t: "Abandon VIB-1 and delete the branch",
              d: "",
              rec: true,
              deleteBranch: true,
            },
          ])}
          busy={false}
          canResolve
          canResolveCompletion
          canEditGoal
          canArchive
          canDiscardBranch
          archiveDisclosure={{
            taskKey: "VIB-1",
            branch: "knc-21",
            pendingRecommendations: 0,
            unownedPr: foreignHead?.prNumber ?? null,
            openPr: null,
            foreignHead,
          }}
          onResolveCustom={() => {}} onResolve={() => {}}
          onAsk={() => {}}
        />,
      );
    const dialogOf = (container: HTMLElement) =>
      container.ownerDocument.querySelector('dialog[data-screen-label="Packet archive dialog"]')!;

    const foreign = renderWith({ sha: "d5f23aa".padEnd(40, "1"), prNumber: 33 });
    fireEvent.click(foreign.container.querySelector(".packet-actions .btn.primary")!);
    const text = dialogOf(foreign.container).textContent!;
    expect(text).toContain("carries commits this task did not author");
    expect(text).toContain("d5f23aa");
    expect(text).toContain("#33");
    expect(text).toContain("deleting it removes them too");
    foreign.unmount();

    const own = renderWith(null);
    fireEvent.click(own.container.querySelector(".packet-actions .btn.primary")!);
    expect(dialogOf(own.container).textContent).not.toContain("did not author");
  });

  /**
   * V16 — the three ask-first ceremonies are ONE shell with three sets of rows
   * (`PacketDestructiveConfirm`). They were three shell-for-shell copies of the
   * standard rulings 20 (R15-1) and 53 (R18-7) hold every one-way write to, so
   * a change to the shared half landed on whichever copy was open. This pins
   * the shell on all three at once: the same alertdialog contract, the same
   * close affordance, the same obs body, the same "Not yet" beside one danger
   * commit whose label names the outcome.
   */
  it("V16: all three destructive ceremonies render the same alertdialog shell", () => {
    const shells: {
      option: OptionDraft;
      screenLabel: string;
      confirm: string;
    }[] = [
      {
        option: {
          kind: "archive_task",
          t: "Archive and delete the branch",
          d: "",
          rec: true,
          deleteBranch: true,
        },
        screenLabel: "Packet archive dialog",
        confirm: "Archive & delete vib-1",
      },
      {
        option: {
          kind: "discard_branch",
          t: "Discard the workspace branch",
          d: "",
          rec: true,
        },
        screenLabel: "Packet discard dialog",
        confirm: "Discard vib-1",
      },
      {
        option: {
          kind: "resolve_remote_collision",
          t: "Delete the stale remote branch, then redeliver",
          d: "",
          rec: true,
        },
        screenLabel: "Packet collision dialog",
        confirm: "Clear collision & redeliver",
      },
    ];
    for (const shell of shells) {
      const { container } = render(
        <DecisionPacket
          packet={withOptions([shell.option])}
          busy={false}
          canResolve
          canResolveCompletion
          canEditGoal
          canArchive
          canDiscardBranch
          archiveDisclosure={{
            taskKey: "VIB-1",
            branch: "vib-1",
            pendingRecommendations: 0,
            unownedPr: 232,
            foreignHead: null,
          openPr: null,
          }}
          onResolveCustom={() => {}} onResolve={() => {}}
          onAsk={() => {}}
        />,
      );
      fireEvent.click(container.querySelector(".packet-actions .btn.primary")!);
      const dialog = container.ownerDocument.querySelector(
        `dialog[data-screen-label="${shell.screenLabel}"]`,
      );
      expect(dialog, shell.screenLabel).toBeTruthy();
      expect(dialog!.className).toBe("modal-card release-card");
      expect(dialog!.getAttribute("role")).toBe("alertdialog");
      expect(dialog!.getAttribute("aria-label")).toBeTruthy();
      expect(dialog!.querySelector(".modal-head .agent-glyph.lg.warn")).toBeTruthy();
      expect(dialog!.querySelector(".mh-main h2")!.textContent).toBeTruthy();
      expect(
        dialog!.querySelector('.icon-btn.modal-close[aria-label="Close"]'),
      ).toBeTruthy();
      expect(
        dialog!.querySelector(".modal-body.tight .packet-obs.flush"),
      ).toBeTruthy();
      expect(dialog!.querySelector(".modal-foot .foot-hint")!.textContent).toBeTruthy();
      const foot = [
        ...dialog!.querySelectorAll<HTMLButtonElement>(".modal-foot button"),
      ];
      expect(foot.map((b) => b.className)).toEqual(["btn ghost", "btn danger"]);
      expect(foot[0]!.textContent).toBe("Not yet");
      // The commit names the outcome, not "Confirm".
      expect(foot[1]!.textContent).toContain(shell.confirm);
      cleanup();
    }
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
        onResolveCustom={() => {}} onResolve={onResolve}
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
        archiveDisclosure={{ taskKey: "VIB-5", branch: null, pendingRecommendations: 0, unownedPr: null, openPr: null, foreignHead: null }}
        onResolveCustom={() => {}} onResolve={() => {}}
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

  // Ruling 368: the escalation in flight shows itself on its button. It was
  // never even disabled for its own request (only the resolve fetcher's), so a
  // second click re-posted it and nothing said it was on its way.
  // Canary: stop passing `escalating: escalateBusy` in task-detail-page.tsx
  // (this renders the card directly, so drop `aria-busy` on the button instead).
  it("ruling 368: an escalation in flight reads Sending…, busy, the loader spinning", () => {
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
        archiveDisclosure={{ taskKey: "VIB-5", branch: null, pendingRecommendations: 0, unownedPr: null, openPr: null, foreignHead: null }}
        onResolveCustom={() => {}} onResolve={() => {}}
        onRequestMaintainer={() => {}}
        escalating
        onAsk={() => {}}
      />,
    );
    const send = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
      b.textContent?.includes("Sending…"),
    )!;
    expect(send.getAttribute("aria-busy")).toBe("true");
    expect(send.disabled).toBe(true);
    expect(send.querySelector(".copy-glyph[data-copied] > svg.ico.spin")).not.toBeNull();
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
        onResolveCustom={() => {}} onResolve={() => {}}
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
      <DecisionPacket packet={packet142} busy={false} canResolve canResolveCompletion canEditGoal canArchive onResolveCustom={() => {}} onResolve={() => {}} onAsk={() => {}} />,
    );
    expect(op.container.querySelector(".rec-tag")!.textContent).toContain(
      "operator pick",
    );
    cleanup();
    // A developer's own ask_human packet is authored by the agent, not the
    // operator — crediting "operator pick" there was the mislabel.
    const dev = render(
      <DecisionPacket packet={{ ...packet142, from: "Developer" }} busy={false} canResolve canResolveCompletion canEditGoal canArchive onResolveCustom={() => {}} onResolve={() => {}} onAsk={() => {}} />,
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
      <DecisionPacket packet={dupe} busy={false} canResolve canResolveCompletion canEditGoal canArchive onResolveCustom={() => {}} onResolve={() => {}} onAsk={() => {}} />,
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

  it("C7: splits camelCase and caps length", () => {
    // A camelCase key no longer renders as one screaming token ("NOCHANGES").
    expect(observationLabel("noChanges")).toBe("no Changes");
    // An over-long key is capped so it cannot blow out the row.
    expect(observationLabel("x".repeat(60)).length).toBeLessThanOrEqual(40);
  });

  it("ruling 470: a path-shaped key is the agent's label and is shown, never replaced", () => {
    // Live on WEB-1 (pass 40) the operator keyed a row `origin/main`, the git
    // ref it had read; the card said "DETAIL" and lost what the row was about.
    expect(observationLabel("origin/main")).toBe("origin/main");
    expect(observationLabel("CI/CD")).toBe("CI/CD");
    // A path is not humanised (no camelCase split, no underscore rewrite) and
    // is still capped like any key.
    expect(observationLabel("src/pages/rssFeed_v2.xml.ts")).toBe("src/pages/rssFeed_v2.xml.ts");
    const long = observationLabel("origin/main test-artifacts/pass20-vib1.txt and more");
    expect(long.length).toBeLessThanOrEqual(40);
    expect(long.startsWith("origin/main test-artifacts/")).toBe(true);
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
    workflow: [],
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
    profileId: null,
    prompt: "",
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

// The standalone ScheduledActions panel (and its P13-D-38 head pin) is DELETED:
// scheduling is baked into the two run controls, so pending entries render
// INSIDE the execution profile, each under the control that would fire it.
describe("pending schedules render inside the execution profile", () => {
  const bothKinds = () => [
    schedule({ id: "sch-op", prompt: "recheck the PR" }),
    schedule({
      id: "sch-ag",
      action: "run-agent",
      profileId: "developer",
      prompt: "polish the diff",
      createdByLabel: "Murat Yıldız",
    }),
  ];

  it("splits the entries per control and names agent, prompt and scheduler", () => {
    const { container } = renderExec(execTask(), { schedules: bothKinds() });
    const opRow = container.querySelector(
      ".op-run:not(.agent-run) .sched-list .sched-row",
    )!;
    expect(opRow.textContent).toContain("operator re-run");
    expect(opRow.textContent).toContain("recheck the PR");
    expect(opRow.textContent).toContain("by Arda Kaya");
    const agRow = container.querySelector(".agent-run .sched-list .sched-row")!;
    // R22: the row pins the PROFILE (resolved to its live display name), never
    // a backend/model frozen at schedule time.
    expect(agRow.textContent).toContain("Developer run");
    expect(agRow.textContent).toContain("polish the diff");
    expect(agRow.textContent).toContain("by Murat Yıldız");
    // Each list holds exactly its own kind.
    expect(
      container.querySelectorAll(".op-run:not(.agent-run) .sched-row"),
    ).toHaveLength(1);
    expect(container.querySelectorAll(".agent-run .sched-row")).toHaveLength(1);
  });

  it("Cancel asks first (D6 ConfirmDialog), then submits cancel-schedule", () => {
    const { container, onCancelSchedule } = renderExec(execTask(), {
      schedules: bothKinds(),
    });
    const cancelBtn = container.querySelector<HTMLButtonElement>(
      ".agent-run .sched-cancel",
    )!;
    fireEvent.click(cancelBtn);
    // Nothing cancelled yet — the confirm is up, naming the consequence.
    expect(onCancelSchedule).not.toHaveBeenCalled();
    const dialog = container.querySelector(
      'dialog[aria-label="Cancel this scheduled run?"]',
    )!;
    expect(dialog).not.toBeNull();
    expect(dialog.textContent).toContain("will not fire");
    fireEvent.click(
      [...dialog.querySelectorAll("button")].find((b) =>
        b.textContent?.includes("Cancel run"),
      )!,
    );
    expect(onCancelSchedule).toHaveBeenCalledWith("sch-ag");
  });
});

describe("undefined CTA / utility classes (P13-D-19)", () => {
  it("uses `btn primary` and `btn ghost`, never the undefined hyphenated forms", () => {
    // Re-pointed at the execution profile (the ScheduledActions panel that
    // carried the original defect is deleted; its buttons live here now).
    const { container } = renderExec(execTask(), {
      schedules: [schedule({ id: "sch-op", prompt: "recheck" })],
    });
    const buttons = [...container.querySelectorAll("button")];
    // `btn-primary` / `btn-ghost` exist in no stylesheet: a CTA wearing one
    // falls back to the plain grey `.btn`.
    for (const b of buttons) {
      expect(b.className).not.toMatch(/\bbtn-(primary|ghost)\b/);
    }
    // Pass 30: routine starters are secondary — the page's one solid primary
    // is the decision-stakes commit of the current state.
    const run = operatorRunBtn(container);
    expect(run.classList.contains("btn")).toBe(true);
    expect(run.classList.contains("primary")).toBe(false);
    const cancel = container.querySelector<HTMLButtonElement>(".sched-cancel")!;
    expect(cancel.classList.contains("ghost")).toBe(true);
    // Ruling 149: the trigger takes the danger label its own confirm commits
    // with, so the row does not read neutral up to the last click.
    expect(cancel.classList.contains("danger")).toBe(true);
  });

  it("ruling 131: the hero links each wait entry (task page, or the Controller page for a goal link) with its state when not open", () => {
    // Canary: drop the `Link` wrapper (no anchors) or the state suffix.
    const { container } = renderWithRouter(
      <TaskHero
        task={heroTask({
          blockedBy: [
            { ref: "JC-3", label: "JC-3", state: "done", taskKey: "JC-3", goalId: null },
            { ref: "goal-1 link 3", label: "goal-1 link 3", state: "open", taskKey: null, goalId: "goal-1" },
            { ref: "JC-6", label: "JC-6", state: "failed", taskKey: "JC-6", goalId: null },
          ],
        })}
        stage={undefined}
        canEditGoal
      />,
    );
    const chips = [...container.querySelectorAll<HTMLAnchorElement>("a[data-wait-state]")];
    expect(chips.map((a) => [a.textContent, a.getAttribute("href"), a.dataset.waitState])).toEqual([
      ["JC-3 · done", "/projects/viberr-core/tasks/JC-3", "done"],
      // Ruling 419(h): a goal link lands on its chain, opened on the rail.
      ["goal-1 link 3", "/projects/viberr-core/controller#goal-1", "open"],
      ["JC-6 · archived", "/projects/viberr-core/tasks/JC-6", "failed"],
    ]);
    for (const a of chips) expect(a.className).toContain("neutral");
  });

  it("ruling 419(h): the chain chip lands on THIS chain on the Controller page", () => {
    // CANARY: link the chip to the bare Controller page again.
    const { container } = renderWithRouter(
      <TaskHero
        task={heroTask({ goalRef: { goalId: "goal-2", linkIndex: 3 } })}
        stage={undefined}
        canEditGoal
      />,
    );
    const chip = [...container.querySelectorAll<HTMLAnchorElement>("a.hero-goal-chip")].find((a) =>
      a.textContent?.includes("goal-2 · link 3"),
    );
    expect(chip?.getAttribute("href")).toBe("/projects/viberr-core/controller#goal-2");
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

  // Ruling 147: the 3-character floor stops disabling Save goal. The primary
  // stays enabled, a short draft is refused in place with the sentence the
  // surface already carried, and the refusal never becomes a request.
  it("ruling 147: Save goal stays enabled and refuses a draft under the floor", async () => {
    let saves = 0;
    const { container, getByText, queryByRole } = renderWithRouter(
      <TaskHero task={heroTask()} stage={undefined} canEditGoal />,
      () => {
        saves += 1;
        return { ok: true };
      },
    );
    fireEvent.click(getByText("Edit"));
    const ta = container.querySelector<HTMLTextAreaElement>(
      "textarea.goal-textarea",
    )!;
    const save = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Save goal",
    )!;

    // A pristine open editor is never accused: the sentence is a hint, not an
    // alert, and the field carries no mark.
    fireEvent.change(ta, { target: { value: "" } });
    expect(queryByRole("alert")).toBeNull();
    expect(ta.getAttribute("aria-invalid")).toBeNull();
    expect(save.hasAttribute("disabled")).toBe(false);

    fireEvent.click(save);
    await act(async () => {});
    expect(saves).toBe(0);
    const first = queryByRole("alert")!;
    expect(first.textContent).toContain("A goal needs at least 3 characters.");
    expect(ta.getAttribute("aria-invalid")).toBe("true");
    expect(ta.getAttribute("aria-describedby")).toBe("goal-err");
    expect(first.id).toBe("goal-err");
    expect(document.activeElement).toBe(ta);

    // A second refusal inserts a NEW element, not a role flip on the same one.
    fireEvent.click(save);
    await act(async () => {});
    expect(saves).toBe(0);
    expect(queryByRole("alert")).not.toBe(first);

    // Typing past the floor clears the mark and the save goes through.
    fireEvent.change(ta, { target: { value: "Bound the payload" } });
    expect(queryByRole("alert")).toBeNull();
    expect(ta.getAttribute("aria-invalid")).toBeNull();
    fireEvent.click(save);
    await act(async () => {});
    expect(saves).toBe(1);
  });

  it("ruling 451(g): the goal refusal shakes per refused click, never on a keystroke", async () => {
    // Found in review: after a refused "ab", typing "abc" and then a backspace
    // mounted the same refusal's box again, and it shook with no click.
    // CANARY: put `.refused` back on the box whenever `refused` is set.
    const { container, getByText, queryByRole } = renderWithRouter(
      <TaskHero task={heroTask()} stage={undefined} canEditGoal />,
    );
    fireEvent.click(getByText("Edit"));
    const ta = container.querySelector<HTMLTextAreaElement>("textarea.goal-textarea")!;
    const save = [...container.querySelectorAll("button")].find((b) => b.textContent === "Save goal")!;
    fireEvent.change(ta, { target: { value: "ab" } });
    fireEvent.click(save);
    await act(async () => {});
    const refusal = queryByRole("alert")!;
    expect(refusal.classList.contains("refused")).toBe(true);
    fireEvent.animationEnd(refusal);
    fireEvent.change(ta, { target: { value: "abc" } });
    expect(queryByRole("alert")).toBeNull();
    fireEvent.change(ta, { target: { value: "ab" } });
    expect(queryByRole("alert")).not.toBeNull();
    expect(queryByRole("alert")!.classList.contains("refused")).toBe(false);
    // The next refused click shakes again.
    fireEvent.click(save);
    await act(async () => {});
    expect(queryByRole("alert")!.classList.contains("refused")).toBe(true);
  });

  it("ruling 147: a re-opened editor is pristine, never still marked", async () => {
    const { container, getByText, queryByRole } = renderWithRouter(
      <TaskHero task={heroTask()} stage={undefined} canEditGoal />,
    );
    fireEvent.click(getByText("Edit"));
    const ta = container.querySelector<HTMLTextAreaElement>(
      "textarea.goal-textarea",
    )!;
    fireEvent.change(ta, { target: { value: "" } });
    fireEvent.click(
      [...container.querySelectorAll("button")].find(
        (b) => b.textContent === "Save goal",
      )!,
    );
    await act(async () => {});
    expect(queryByRole("alert")).toBeTruthy();

    fireEvent.click(getByText("Cancel"));
    fireEvent.click(getByText("Edit"));
    expect(queryByRole("alert")).toBeNull();
    expect(
      container.querySelector("textarea.goal-textarea")!.getAttribute("aria-invalid"),
    ).toBeNull();
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
        stage={{ id: "review", name: "Review", color: "blue" }}
        canEditGoal
      />,
    );
    const liveText = live.container.querySelector(".hero-meta")!.textContent!;
    expect(liveText).toContain("Review");
    // Ruling 169: the live obligation IS the status — a `ready` task whose
    // revision awaits a verdict says "awaiting verdict", not "ready" as well.
    expect(liveText).toContain("awaiting verdict");
    expect(liveText).not.toMatch(/\bready\b/);
    live.unmount();

    const archived = renderWithRouter(
      <TaskHero
        task={heroTask({ displayReadiness: "ready", validation: "changed" })}
        stage={{ id: "review", name: "Review", color: "blue" }}
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

  // F35-6 (live, KNC-4 14:56Z): after a reload the hero's Edit under the goal
  // is the door a person takes, and it seeded the ORIGINAL goal while a decided
  // edit_goal packet waited for the draft; saving that unchanged text answered
  // "Goal updated" over a packet that still said "save the edited goal".
  // Canary: seed `task.goal` in the Edit click again and the first assert is red.
  it("F35-6: while a decided edit_goal packet waits, the hero's own Edit opens with the pending draft", () => {
    const { container, getByRole } = renderWithRouter(
      <TaskHero
        task={heroTask()}
        stage={undefined}
        canEditGoal
        pendingGoalDraft={"Deliverable: the search page.\n\nAcceptance: results render."}
      />,
    );
    fireEvent.click(getByRole("button", { name: "Edit" }));
    const ta = container.querySelector<HTMLTextAreaElement>("textarea.goal-textarea")!;
    expect(ta.value).toBe("Deliverable: the search page.\n\nAcceptance: results render.");
    expect(ta.value).not.toContain("Bound the timeline payload");
  });

  it("F35-6: with no pending draft the hero's Edit opens with the current goal", () => {
    const { container, getByRole } = renderWithRouter(
      <TaskHero task={heroTask()} stage={undefined} canEditGoal pendingGoalDraft={null} />,
    );
    fireEvent.click(getByRole("button", { name: "Edit" }));
    const ta = container.querySelector<HTMLTextAreaElement>("textarea.goal-textarea")!;
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
        stage={{ id: "done", name: "Done", color: "green" }}
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
        stage={{ id: "done", name: "Done", color: "green" }}
        canEditGoal
      />,
    );
    const meta = container.querySelector(".hero-meta")!.textContent!;
    expect(meta).toContain("accepted");
    expect(meta).not.toContain("awaiting verdict");
    expect(meta).not.toContain("gate bypassed");
  });

  // R21-8 (supersedes C3, owner-ruled 2026-08-21): while an agent carries the
  // task the slot says so instead of claiming a human is needed or painting a
  // green all-clear. The DECISION moved to `deriveDisplayReadiness` (one
  // server-side derivation; its own tests pin every input combination), so the
  // hero's contract here is narrower and sharper: render the derived value,
  // never re-decide it.
  it("R21-8: renders 'agent working' when the derivation says an agent carries it", () => {
    const { container } = renderWithRouter(
      <TaskHero
        task={heroTask({ displayReadiness: "agent_working", validation: "none" })}
        stage={{ id: "impl", name: "In Progress", color: "violet" }}
        canEditGoal
      />,
    );
    const meta = container.querySelector(".hero-meta")!.textContent!;
    expect(meta).toContain("agent working");
    // Neither of the two states that yield may leak through beside it.
    expect(meta).not.toContain("input required");
    expect(meta).not.toContain("ready");
  });

  it("R21-8: the hero does NOT re-derive the yield from its own props", () => {
    // The bug this guards: three surfaces each re-deriving "is an agent
    // carrying this?" is how `ready` kept its green pill for four passes while
    // `input_required` was fixed. A task whose derived value is `input_required`
    // renders input_required — even though `waiting` says "agent" — because the
    // server already had the last word.
    const { container } = renderWithRouter(
      <TaskHero
        task={heroTask({
          displayReadiness: "input_required",
          validation: "none",
          waiting: "agent",
        })}
        stage={{ id: "impl", name: "In Progress", color: "violet" }}
        canEditGoal
      />,
    );
    const meta = container.querySelector(".hero-meta")!.textContent!;
    expect(meta).toContain("input required");
    expect(meta).not.toContain("agent working");
  });

  it("R21-8: 'blocked' never yields", () => {
    const { container } = renderWithRouter(
      <TaskHero
        task={heroTask({ displayReadiness: "blocked", validation: "none" })}
        stage={{ id: "impl", name: "In Progress", color: "violet" }}
        canEditGoal
      />,
    );
    const meta = container.querySelector(".hero-meta")!.textContent!;
    expect(meta).toContain("blocked"); // a run does not answer a blocked state
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
        stage={{ id: "impl", name: "In Progress", color: "violet" }}
        canEditGoal
      />,
    );
    const meta = container.querySelector(".hero-meta")!;
    expect(meta.textContent).toContain("unknown");
    // The greenwash the fix forbids: a malformed value read as healthy.
    expect(meta.querySelector(".pill.ready")).toBeNull();
  });
});

/**
 * Ruling 169 (owner, 2026-09-09): "a task can't be blocked, ready, and awaiting
 * verdict at the same time. What does ready mean?" — the hero read the Ready
 * STAGE as a status word beside a readiness pill and a validation pill drawn as
 * peers. The stage and the status are labelled fields now, and the status is
 * one word; validation appears on its own only as a problem.
 */
describe("ruling 169: the hero's stage and status are labelled fields, and the status is one word", () => {
  const ready = { id: "ready", name: "Ready", color: "emerald" };
  const meta = (el: HTMLElement) => el.querySelector(".hero-meta")!;
  const fields = (el: HTMLElement) =>
    [...meta(el).querySelectorAll(".hero-field")].map((f) => ({
      label: f.querySelector(".hero-field-lbl")!.textContent,
      value: f.querySelector(".pill")!.textContent!.trim(),
    }));

  it("names the stage as the stage and the readiness as the status", () => {
    const { container } = renderWithRouter(
      <TaskHero
        task={heroTask({ displayReadiness: "blocked", validation: "changed" })}
        stage={ready}
        canEditGoal
      />,
    );
    expect(fields(container)).toEqual([
      { label: "Stage", value: "Ready" },
      { label: "Status", value: "blocked" },
    ]);
    // A held task is not up for a verdict: the quiet validation value does not
    // compete with the status word.
    expect(meta(container).textContent).not.toContain("awaiting verdict");
  });

  it("a `ready` task whose revision awaits a verdict says so, once", () => {
    const { container } = renderWithRouter(
      <TaskHero
        task={heroTask({ displayReadiness: "ready", validation: "changed" })}
        stage={{ id: "review", name: "Review", color: "blue" }}
        canEditGoal
      />,
    );
    expect(fields(container)).toEqual([
      { label: "Stage", value: "Review" },
      { label: "Status", value: "awaiting verdict" },
    ]);
    expect(meta(container).querySelectorAll(".pill.ready")).toHaveLength(0);
  });

  it("the other quiet validation values stay off the hero; a failing one keeps its own pill", () => {
    for (const v of ["healthy", "none"] as const) {
      const { container, unmount } = renderWithRouter(
        <TaskHero task={heroTask({ displayReadiness: "ready", validation: v })} stage={ready} canEditGoal />,
      );
      expect(fields(container).map((f) => f.value)).toEqual(["Ready", "ready"]);
      expect(meta(container).textContent).not.toContain("validation");
      unmount();
    }
    const { container } = renderWithRouter(
      <TaskHero
        task={heroTask({ displayReadiness: "input_required", validation: "failing" })}
        stage={ready}
        canEditGoal
      />,
    );
    expect(fields(container).map((f) => f.value)).toEqual(["Ready", "input required"]);
    expect(meta(container).textContent).toContain("validation failing");
  });

  it("an archived task keeps its stage field and has no status field", () => {
    const { container } = renderWithRouter(
      <TaskHero
        task={heroTask({ displayReadiness: "ready", validation: "changed" })}
        stage={ready}
        canEditGoal
        archived
      />,
    );
    expect(fields(container)).toEqual([{ label: "Stage", value: "Ready" }]);
    expect(meta(container).textContent).toContain("archived");
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

describe("U39-21: a packet option renders its inline code", () => {
  it("renders `code` in an option's title and description instead of printing the backticks", () => {
    // Live on AX-22's deadlock packet: "It answered this on `7920943` in this
    // streak". CANARY: render `o.d` as plain text again.
    const { container } = render(
      <DecisionPacket
        packet={{
          ...packet142,
          options: [
            { kind: "question_reviewer", t: "Ask `reviewer` again", d: "It answered this on `7920943` in this streak.", rec: false },
            ...packet142.options,
          ],
        }}
        busy={false}
        canResolve={true}
        canResolveCompletion={true}
        canEditGoal={true}
        canArchive={true}
        onResolveCustom={() => {}}
        onResolve={() => {}}
        onAsk={() => {}}
      />,
    );
    const first = container.querySelector(".options .opt")!;
    expect(first.querySelector(".od code")?.textContent).toBe("7920943");
    expect(first.querySelector(".ot code")?.textContent).toBe("reviewer");
    expect(first.textContent).not.toContain("`");
  });
});

describe("DecisionPacket questionnaire custom answer (P21)", () => {
  it("offers 'Write your own directive', reveals the input, and resolves through onResolveCustom", () => {
    const onResolveCustom = vi.fn();
    const { getByText, getByLabelText } = render(
      <DecisionPacket
        packet={packet142}
        busy={false}
        canResolve={true}
        canResolveCompletion={true}
        canEditGoal={true}
        canArchive={true}
        onResolveCustom={onResolveCustom}
        onResolve={() => {}}
        onAsk={() => {}}
      />,
    );
    // The composed choice renders after the authored options.
    const custom = getByText("Write your own directive").closest("button")!;
    expect(custom.getAttribute("role")).toBe("radio");
    // Ruling 271: `list_decisions` numbers this choice `options.length + 1` so
    // a person reading the controller's briefing finds the same one here. Pin
    // the position the briefing promises. CANARY: render the composed choice
    // before the authored options and the two stop agreeing.
    const choices = [...custom.parentElement!.querySelectorAll('[role="radio"]')];
    expect(choices.indexOf(custom)).toBe(packet142.options.length);
    // No input until the choice is selected; the note field shows instead.
    expect(document.querySelector("#pkt-custom")).toBeNull();
    expect(document.querySelector("#pkt-note")).not.toBeNull();
    // U39-7: the note's example fits every packet, not only a closed PR's.
    expect(document.querySelector("#pkt-note")!.getAttribute("placeholder")).toBe(
      "e.g. anything the operator should also know",
    );

    fireEvent.click(custom);
    expect(custom.getAttribute("aria-checked")).toBe("true");
    // The directive input replaces the note field (one message, one box).
    expect(document.querySelector("#pkt-note")).toBeNull();
    const input = document.querySelector<HTMLTextAreaElement>("#pkt-custom")!;
    expect(input).not.toBeNull();

    // Ruling 147: Confirm stays ENABLED with the directive still empty, and the
    // click is refused in place instead of going dead.
    // SAFETY: the aria-label belongs to the packet's Confirm <button>
    // (decision-packet.tsx); the bound query cannot state the element type.
    const confirm = getByLabelText(
      "Confirm decision: your custom directive",
    ) as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
    expect(document.querySelector('[role="alert"]')).toBeNull();
    fireEvent.click(confirm);
    expect(onResolveCustom).not.toHaveBeenCalled();
    const first = document.querySelector('[role="alert"]')!;
    expect(first.textContent).toContain("Write the directive first.");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toBe("pkt-custom-err");
    expect(first.id).toBe("pkt-custom-err");
    expect(document.activeElement).toBe(input);

    // A second refusal inserts a NEW element.
    fireEvent.click(confirm);
    expect(document.querySelector('[role="alert"]')).not.toBe(first);

    fireEvent.change(input, {
      target: { value: "Rebase onto main, then re-run the reviewer." },
    });
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(input.getAttribute("aria-invalid")).toBeNull();
    fireEvent.click(confirm);
    expect(onResolveCustom).toHaveBeenCalledWith(
      "Rebase onto main, then re-run the reviewer.",
    );
  });

  // Ruling 147: a pristine form is never accused — leaving the directive and
  // coming back drops the standing refusal.
  it("ruling 147: changing choice clears a standing directive refusal", () => {
    const { getByText, getByLabelText } = render(
      <DecisionPacket
        packet={packet142}
        busy={false}
        canResolve={true}
        canResolveCompletion={true}
        canEditGoal={true}
        canArchive={true}
        onResolveCustom={() => {}}
        onResolve={() => {}}
        onAsk={() => {}}
      />,
    );
    const custom = getByText("Write your own directive").closest("button")!;
    fireEvent.click(custom);
    // SAFETY: the aria-label belongs to the packet's Confirm <button>.
    const confirm = getByLabelText(
      "Confirm decision: your custom directive",
    ) as HTMLButtonElement;
    fireEvent.click(confirm);
    expect(document.querySelector('[role="alert"]')).toBeTruthy();

    // Pick an authored option, then come back: the directive is pristine again.
    fireEvent.click(
      document.querySelectorAll<HTMLButtonElement>('[role="radio"]')[0]!,
    );
    fireEvent.click(custom);
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(
      document.querySelector("#pkt-custom")!.getAttribute("aria-invalid"),
    ).toBeNull();
  });

  // Ruling 147 dropped `choiceCount === 0` from Confirm's `disabled`, which
  // raises the question of what an options-less packet does now. Nothing bad:
  // the composed directive IS a choice, and it is offered to exactly the
  // viewers who get the Confirm button (`customOffered = canResolve`), so the
  // count is never zero while the button renders. With no authored option to
  // select, `sel` lands on the directive, and an empty one is REFUSED — the
  // button never reaches `onResolve` with an index that has no option.
  //
  // Canary: hand the custom choice a different condition from the button's and
  // the click resolves option 0 of an empty list — this goes red.
  it("a packet with no options refuses; it never resolves a missing index", () => {
    const onResolve = vi.fn();
    const onResolveCustom = vi.fn();
    const { getByLabelText, queryByText } = render(
      <DecisionPacket
        packet={{ ...packet142, options: [] }}
        busy={false}
        canResolve={true}
        canResolveCompletion={true}
        canEditGoal={true}
        canArchive={true}
        onResolveCustom={onResolveCustom}
        onResolve={onResolve}
        onAsk={() => {}}
      />,
    );
    // SAFETY: the aria-label belongs to the packet's Confirm <button>.
    const confirm = getByLabelText(
      "Confirm decision: your custom directive",
    ) as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    expect(onResolve).not.toHaveBeenCalled();
    expect(onResolveCustom).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')!.textContent).toContain(
      "Write the directive first.",
    );
    // And the directive really is the only choice on offer.
    expect(document.querySelectorAll('[role="radio"]')).toHaveLength(1);
    expect(queryByText("Accept completion")).toBeNull();
  });

  it("a viewer who cannot resolve gets no Confirm on an options-less packet", () => {
    // The other half of the same guarantee: without `canResolve` there is no
    // custom choice AND no Confirm, so nothing can be clicked into a resolve.
    const onResolve = vi.fn();
    const { queryByText } = render(
      <DecisionPacket
        packet={{ ...packet142, options: [] }}
        busy={false}
        canResolve={false}
        canResolveCompletion={false}
        canEditGoal={false}
        canArchive={false}
        onResolveCustom={() => {}}
        onResolve={onResolve}
        onAsk={() => {}}
      />,
    );
    expect(queryByText("Confirm decision")).toBeNull();
    expect(document.querySelectorAll('[role="radio"]')).toHaveLength(0);
  });

  it("digit shortcuts select choices, and the chips advertise them", () => {
    const { container } = render(
      <DecisionPacket
        packet={packet142}
        busy={false}
        canResolve={true}
        canResolveCompletion={true}
        canEditGoal={true}
        canArchive={true}
        onResolveCustom={() => {}}
        onResolve={() => {}}
        onAsk={() => {}}
      />,
    );
    const group = container.querySelector('[role="radiogroup"]')!;
    const chips = [...container.querySelectorAll(".opt-kbd")].map(
      (k) => k.textContent,
    );
    // Three authored options + the custom choice.
    expect(chips).toEqual(["1", "2", "3", "4"]);
    fireEvent.keyDown(group, { key: "2" });
    const options = [...container.querySelectorAll('[role="radio"]')];
    expect(options[1]?.getAttribute("aria-checked")).toBe("true");
    fireEvent.keyDown(group, { key: "4" });
    expect(options[3]?.getAttribute("aria-checked")).toBe("true");
  });

  it("hides the custom choice from viewers who cannot resolve", () => {
    const { queryByText } = render(
      <DecisionPacket
        packet={packet142}
        busy={false}
        canResolve={false}
        canResolveCompletion={false}
        canEditGoal={false}
        canArchive={false}
        onResolveCustom={() => {}}
        onResolve={() => {}}
        onAsk={() => {}}
      />,
    );
    expect(queryByText("Write your own directive")).toBeNull();
  });
});

/* ------------------------------------------ ruling 459: primary-action exits */

/**
 * Ruling 459: a dialog's primary action leaves the way Cancel does, through
 * `useDialog`'s `commit`: the action runs, the dialog plays its exit, and only
 * then its onCancel unmounts it. jsdom reads no stylesheet, so each test gives
 * the dialog the sheet's closing clock itself; the exit then waits for the
 * dialog's own transitionend, as it does in a browser.
 */
describe("ruling 459: a confirm's primary action plays the same exit as Cancel", () => {
  const slow = (dialog: HTMLElement) => {
    dialog.style.transitionDuration = "0.15s";
  };

  it("the hand-written confirms commit, then leave, then unmount", () => {
    // CANARY: put any of these primaries back on the raw `onConfirm` (or the
    // hand-off chip back on `onCancel(); onOwner(...)`): nothing is marked
    // closing, and the order below breaks.
    const task = taskFixture("u-arda", "Arda Kaya");
    const cases: { name: string; primary: string; ui: (log: string[]) => ReactNode }[] = [
      {
        name: "ArchiveConfirm",
        primary: "Archive VIB-151",
        ui: (log) => (
          <ArchiveConfirm
            task={heroTask()}
            pendingRecommendations={0}
            busy={false}
            onCancel={() => log.push("cancel")}
            onConfirm={() => log.push("confirm")}
          />
        ),
      },
      {
        name: "ReleaseConfirm",
        primary: "Release",
        ui: (log) => (
          <ReleaseConfirm
            task={task}
            me={{ id: "u-arda", name: "Arda Kaya" }}
            members={membersFixture}
            busy={false}
            onCancel={() => log.push("cancel")}
            onConfirm={() => log.push("confirm")}
            onOwner={() => log.push("owner")}
          />
        ),
      },
    ];
    for (const c of cases) {
      const log: string[] = [];
      const { container, unmount } = render(<>{c.ui(log)}</>);
      const dialog = container.querySelector("dialog")!;
      slow(dialog);
      const button = [...dialog.querySelectorAll("button")].find(
        (b) => b.textContent?.trim() === c.primary,
      )!;
      expect(button, c.name).toBeTruthy();
      fireEvent.click(button);
      expect(log, c.name).toEqual(["confirm"]);
      expect(dialog.hasAttribute("data-closing"), c.name).toBe(true);
      fireEvent.transitionEnd(dialog);
      expect(log, c.name).toEqual(["confirm", "cancel"]);
      unmount();
    }
  });

  it("the release dialog's hand-off chip hands off, then leaves the same way", () => {
    const log: string[] = [];
    const { container } = render(
      <ReleaseConfirm
        task={taskFixture("u-selin", "Selin Aksoy")}
        me={{ id: "u-arda", name: "Arda Kaya" }}
        members={membersFixture}
        busy={false}
        onCancel={() => log.push("cancel")}
        onConfirm={() => log.push("confirm")}
        onOwner={(action) => log.push("owner:" + action)}
      />,
    );
    const dialog = container.querySelector("dialog")!;
    slow(dialog);
    fireEvent.click(container.querySelector(".handoff-chip")!);
    expect(log).toEqual(["owner:take"]);
    expect(dialog.hasAttribute("data-closing")).toBe(true);
    fireEvent.transitionEnd(dialog);
    expect(log).toEqual(["owner:take", "cancel"]);
  });

  it("the move-back confirm sends its reason once, even on a second click during the exit", () => {
    const log: string[] = [];
    const { container, getByText } = render(
      <MoveBackConfirm
        taskKey="VIB-151"
        taskTitle="Compress long-running task timelines"
        fromStageName="Review"
        toStageName="Build"
        busy={false}
        onCancel={() => log.push("cancel")}
        onConfirm={(reason) => log.push("confirm:" + reason)}
      />,
    );
    const dialog = container.querySelector("dialog")!;
    slow(dialog);
    fireEvent.change(container.querySelector("textarea")!, {
      target: { value: "  add the race test  " },
    });
    fireEvent.click(getByText("Move back"));
    fireEvent.click(getByText("Move back"));
    expect(log).toEqual(["confirm:add the race test"]);
    fireEvent.transitionEnd(dialog);
    expect(log).toEqual(["confirm:add the race test", "cancel"]);
  });

  it("a caller leaves the unmount to the dialog: the schedule confirm stays up through its exit", () => {
    // CANARY: put `setConfirmCancel(null)` back in execution-profile's
    // onConfirm, and the card is gone in the same commit as the click.
    const { container, onCancelSchedule } = renderExec(execTask(), {
      schedules: [
        schedule({ id: "sch-ag", action: "run-agent", profileId: "developer", prompt: "polish the diff" }),
      ],
    });
    fireEvent.click(container.querySelector<HTMLButtonElement>(".agent-run .sched-cancel")!);
    const dialog = container.querySelector<HTMLDialogElement>('dialog[aria-label="Cancel this scheduled run?"]')!;
    slow(dialog);
    fireEvent.click(
      [...dialog.querySelectorAll("button")].find((b) => b.textContent?.includes("Cancel run"))!,
    );
    expect(onCancelSchedule).toHaveBeenCalledWith("sch-ag");
    expect(dialog.isConnected).toBe(true);
    expect(dialog.hasAttribute("data-closing")).toBe(true);
    fireEvent.transitionEnd(dialog);
    expect(dialog.isConnected).toBe(false);
    expect(onCancelSchedule).toHaveBeenCalledTimes(1);
  });
});

/**
 * Ruling 368 on the GitHub trace: Complete merge and Force accept share the
 * task page's run fetcher with interrupt and retry, so both went `disabled`
 * (the .45 refused step) for ANY of them, their own included, with their
 * resting labels. Deliver named its work but kept the branch glyph at .45.
 * Ruling 459: each glyph trades for the loader in its GlyphSwap cell, where the
 * loader is always drawn (spinning, paused while it rests hidden), so "the
 * loader shows" is the cell's `data-copied`, not the presence of a `.spin`.
 * Canary: drop `aria-busy={forcing || undefined}` in task-side-panels.tsx.
 */
describe("ruling 368: the GitHub trace's requests in flight", () => {
  const blocked = traceAcceptance({ blockedReason: "Waiting on a verdict." });
  const trace = (props: Partial<ComponentProps<typeof GithubTrace>>) =>
    render(
      <MemoryRouter>
        <GithubTrace
          githubHost={GH_HOST}
          task={traceTask()}
          acceptance={blocked}
          onForceAccept={() => {}}
          {...props}
        />
      </MemoryRouter>,
    ).container;
  const button = (c: HTMLElement, text: string) =>
    Array.from(c.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
      b.textContent?.includes(text),
    );
  /** The spinning loader, shown: its cell has traded the resting glyph for it. */
  const loaderShown = (b: HTMLElement) =>
    b.querySelector(".copy-glyph[data-copied] > svg.ico.spin:last-child") !== null;

  it("a force-accept in flight reads Force-accepting…", () => {
    const c = trace({ runIntent: "force-accept" });
    const b = button(c, "Force-accepting…")!;
    expect(b.getAttribute("aria-busy")).toBe("true");
    expect(b.disabled).toBe(true);
    expect(loaderShown(b)).toBe(true);
  });

  it("an interrupt in flight leaves Force accept waiting, claiming nothing", () => {
    const c = trace({ runIntent: "run-interrupt" });
    const b = button(c, "Force accept")!;
    expect(b.disabled).toBe(true);
    expect(b.hasAttribute("aria-busy")).toBe(false);
    // The shield stays; the loader rests hidden in its cell.
    expect(loaderShown(b)).toBe(false);
    expect(b.querySelector(".copy-glyph")!.hasAttribute("data-copied")).toBe(false);
  });

  it("a delivery in flight reads Delivering…, busy, the loader spinning", () => {
    const c = trace({ onDeliver: () => {}, delivering: true });
    const b = button(c, "Delivering…")!;
    expect(b.getAttribute("aria-busy")).toBe("true");
    expect(loaderShown(b)).toBe(true);
  });
});

/**
 * Ruling 368's other half: a control that merely waits claims nothing. Both
 * callers close the move-back dialog on the click, so its busy step is always
 * another move in flight; the button used to read "Moving…" for it.
 * Canary: put `{busy ? "Moving…" : "Move back"}` back in move-back-confirm.tsx.
 */
describe("ruling 368: the move-back dialog waits without claiming the move", () => {
  it("busy: disabled, still reads Move back, no busy mark", () => {
    const { getByText } = render(
      <MoveBackConfirm
        taskKey="VIB-151"
        taskTitle="Compress long-running task timelines"
        fromStageName="Review"
        toStageName="In progress"
        busy
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    );
    const b = getByText("Move back").closest("button")!;
    expect(b.disabled).toBe(true);
    expect(b.hasAttribute("aria-busy")).toBe(false);
  });
});

/**
 * Ruling 459 over ruling 368: a run start's glyph changes twice (Run → Schedule
 * with the when-picker, resting → loader while its own request is in flight),
 * and both go through one cell. The resting mark and the clock trade in the
 * inner GlyphSwap; that whole resting cell trades for the one spinning loader
 * on the outer cell's `data-copied`. Nothing is swapped in a frame, and the
 * button never draws two loaders.
 * Canary: put a start back on `<Icon name={busy ? "loader" : delay === "now" ? "bolt" : "clock"} …/>`.
 */
describe("ruling 459 over 368: a run start trades its glyphs in one cell", () => {
  const starts = (c: HTMLElement) => [
    ["When the operator run starts", c.querySelector<HTMLButtonElement>(".op-run:not(.agent-run) > .run-go")!],
    ["When the agent run starts", c.querySelector<HTMLButtonElement>(".op-run.agent-run > .run-go")!],
  ] as const;
  const cells = (b: HTMLButtonElement) => {
    const outer = b.querySelector(":scope > .copy-glyph")!;
    return { outer, inner: outer.firstElementChild!, loader: outer.lastElementChild! };
  };

  it("at rest the mark shows, and Schedule trades it for the clock in place, the loader resting hidden", () => {
    const { container } = renderExec(execTask());
    for (const [picker, b] of starts(container)) {
      const { outer, inner, loader } = cells(b);
      expect(outer.hasAttribute("data-copied"), picker).toBe(false);
      expect(inner.matches(".copy-glyph:not([data-copied])"), picker).toBe(true);
      expect(loader.matches("svg.ico.spin"), picker).toBe(true);
      expect(b.querySelectorAll(".spin"), picker).toHaveLength(1);
      fireEvent.change(container.querySelector<HTMLSelectElement>(`select[aria-label="${picker}"]`)!, {
        target: { value: "60" },
      });
      expect(b.textContent, picker).toBe("Schedule");
      // The same cells; only the inner mark moved.
      expect(cells(b).outer, picker).toBe(outer);
      expect(cells(b).inner, picker).toBe(inner);
      expect(inner.getAttribute("data-copied"), picker).toBe("true");
      expect(outer.hasAttribute("data-copied"), picker).toBe(false);
    }
  });

  it("the start whose request is in flight shows the loader, busy, with its work's name", () => {
    const { container } = renderExec(execTask(), { operatorInFlight: "schedule", runInFlight: "run" });
    const [[, operator], [, agent]] = starts(container);
    expect(operator.textContent).toBe("Scheduling…");
    expect(agent.textContent).toBe("Starting…");
    for (const b of [operator, agent]) {
      expect(b.getAttribute("aria-busy")).toBe("true");
      const { outer, loader } = cells(b);
      expect(outer.getAttribute("data-copied")).toBe("true");
      expect(loader.matches("svg.ico.spin")).toBe(true);
      expect(b.querySelectorAll(".spin")).toHaveLength(1);
    }
  });
});
