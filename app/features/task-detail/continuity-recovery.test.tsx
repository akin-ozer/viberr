// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import type { TaskDetail } from "~/server/projections/task-query.server";
import type { AcceptanceAffordance } from "~/server/tasks/task-actions.server";
import type { TimelineEventRender } from "~/shared/mapping/task-event.server";
import type { LogLine, RunView } from "~/features/runtime/runtime-types";
import { NO_RUN_CACHE } from "~/features/runtime/runtime-types";
import { ToastProvider } from "~/ui/toast";
import {
  CONTINUITY_EVENT_TYPE,
  ContinuityRecoveryPanel,
  EXECUTION_PANEL_LABEL,
  deriveContinuityLoss,
} from "./continuity-recovery";
import { TaskDetailPage } from "./task-detail-page";

/** Ruling 127: the task owner whose accounts a run bills, both backends
 *  connected — the ordinary case, so the run controls render live and these
 *  tests keep testing what they are about. The refusal states are covered in
 *  execution-profile.test.tsx. */
const CONNECTED_PRINCIPAL = {
  ownerUserId: "u-arda",
  ownerName: "Arda Kaya",
  claude: { available: true, detail: null },
  codex: { available: true, detail: null },
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// jsdom's Element carries no `scrollIntoView`; the panel's console door calls
// it a frame after the click.
Element.prototype.scrollIntoView = () => {};

/**
 * D18 — the Continuity Recovery Panel, the fifth custom component and the only
 * one the product never had. What these tests hold down:
 *
 *  - it appears ONLY when there is a real break to report (no permanent empty
 *    panel), and it reports one from EITHER canonical source alone;
 *  - the identity it names comes from structured data — the run group and the
 *    stored wire envelope — never from scraping display text;
 *  - it leads with what survived, then what was lost (spec content guideline);
 *  - warning and recovery stay distinguishable in TEXT, not colour alone;
 *  - the consequential state change is announced to a screen reader;
 *  - it points at controls that exist, and at NO control that does not.
 */

/* ------------------------------------------------------------- fixtures */

const DEAD_SESSION = "0f8b2b1e-9a44-4a1d-bb2f-7d9c2f1a55c1";

/** The err line `recordSessionMissing` projects onto the dead run. */
const missingLine: LogLine = {
  t: "09:41:02",
  ev: "err",
  tag: "run·session_missing",
  text: "The Claude session no longer exists on this machine.",
};

const plainLine: LogLine = {
  t: "09:40:00",
  ev: "text",
  tag: "assistant",
  text: "Reading the task file.",
};

function run(patch: Partial<RunView> = {}): RunView {
  return {
    id: "primary",
    serverRunId: "r_1",
    role: "developer",
    kind: "primary",
    profileId: "dev-1",
    who: { kind: "agent", backend: "claude", name: "Dana", role: "developer" },
    backend: "claude",
    sdk: "claude-code",
    model: "claude-opus-5",
    sid: "fresh-session-id",
    exportable: true,
    state: "done",
    lifecycle: "finished",
    phase: null,
    step: null,
    startedAt: "2026-08-06T09:40:00.000Z",
    finished: "9:41",
    turns: 3,
    tokens: 1200,
    tokensEstimated: false,
    cache: NO_RUN_CACHE,
    lines: [plainLine],
    raw: ["{}"],
    lineCount: 1,
    logWindow: {
      totalLines: 1,
      hasMore: false,
      runIds: ["r_1"],
      oldest: null,
      headSeq: 0,
    },
    ...patch,
  };
}

/**
 * A run group whose console window holds the dead-session marker (dead run +
 * fresh run). Ruling 457: the projection reports the marker as `sessionMissing`
 * (the page no longer carries every window's lines to scan); how it finds it
 * is pinned in `run-projection.server.test.ts`.
 */
function brokenRun(patch: Partial<RunView> = {}): RunView {
  return run({
    lines: [plainLine, missingLine, plainLine],
    raw: [],
    lineCount: 3,
    sessionMissing: { sessionId: DEAD_SESSION },
    ...patch,
  });
}

function ev(patch: Partial<TimelineEventRender> = {}): TimelineEventRender {
  return {
    id: 1,
    type: "comment",
    occurredAt: "2026-08-06T09:41:00.000Z",
    actor: { kind: "human", userId: "u1", name: "Murat Deniz", initials: "MD", tone: "" },
    title: null,
    text: "looking into it",
    toAgent: false,
    attachments: null,
    evidence: null,
    ...patch,
  };
}

const continuityEvent = ev({
  id: 9,
  type: CONTINUITY_EVENT_TYPE,
  occurredAt: "2026-08-06T09:41:05.000Z",
  actor: { kind: "system", name: "Viberr" },
  text: "Runtime continuity was lost: the Claude session behind Dana's thread no longer has a provider transcript.",
});

/* -------------------------------------------------- deriveContinuityLoss */

describe("deriveContinuityLoss", () => {
  it("returns null when nothing was lost — the panel is never a standing empty card", () => {
    expect(
      deriveContinuityLoss({ timeline: [ev()], runtime: [run()] }),
    ).toBeNull();
    expect(deriveContinuityLoss({ timeline: [], runtime: [] })).toBeNull();
  });

  it("names the affected thread from the run group and the session from the WIRE envelope", () => {
    const loss = deriveContinuityLoss({
      timeline: [continuityEvent],
      runtime: [run({ id: "op", kind: "operator", op: true }), brokenRun()],
    });
    expect(loss).not.toBeNull();
    expect(loss!.occurredAt).toBe("2026-08-06T09:41:05.000Z");
    expect(loss!.agents).toHaveLength(1);
    expect(loss!.agents[0]).toMatchObject({
      threadId: "primary",
      name: "Dana",
      roleLabel: "Delivering agent",
      backendLabel: "Claude",
      sessionId: DEAD_SESSION,
    });
  });

  it("says nothing about a session the marker's envelope did not carry", () => {
    const noId = deriveContinuityLoss({
      timeline: [],
      runtime: [brokenRun({ sessionMissing: { sessionId: null } })],
    });
    expect(noId!.agents[0]!.sessionId).toBeNull();
    // …and it still reports the break: the id is a detail, the loss is the fact.
    expect(noId!.agents[0]!.name).toBe("Dana");
  });

  it("reads the projection's report, not the lines a payload may not carry (ruling 457)", () => {
    // A `.data` revalidation carries no console lines; the marker is still
    // reported. CANARY: scan `run.lines` again and this returns null.
    const loss = deriveContinuityLoss({
      timeline: [],
      runtime: [brokenRun({ lines: [], raw: [] })],
    });
    expect(loss!.agents).toHaveLength(1);
    // A window that holds no marker reports none, whatever its lines say.
    expect(
      deriveContinuityLoss({ timeline: [], runtime: [run({ lines: [missingLine], sessionMissing: null })] }),
    ).toBeNull();
  });

  it("labels the engagement the way the UI names it", () => {
    const roleOf = (patch: Partial<RunView>) =>
      deriveContinuityLoss({ timeline: [], runtime: [brokenRun(patch)] })!.agents[0]!
        .roleLabel;
    expect(roleOf({ kind: "operator", op: true })).toBe("Operator");
    expect(roleOf({ kind: "reviewer" })).toBe("Reviewer");
    expect(roleOf({ kind: "primary" })).toBe("Delivering agent");
  });

  it("reads where recovery stands off the group's representative run", () => {
    const progressOf = (lifecycle: RunView["lifecycle"]) =>
      deriveContinuityLoss({ timeline: [], runtime: [brokenRun({ lifecycle })] })!
        .agents[0]!.progress;
    expect(progressOf("running")).toBe("running");
    expect(progressOf("queued")).toBe("running");
    expect(progressOf("finished")).toBe("recovered");
    expect(progressOf("error")).toBe("stalled");
    expect(progressOf("interrupted")).toBe("stalled");
  });

  it("reports from either source alone — neither is the sole trigger", () => {
    // Canonical event only (the console window has paged the marker out).
    const eventOnly = deriveContinuityLoss({
      timeline: [continuityEvent],
      runtime: [run()],
    });
    expect(eventOnly!.agents).toEqual([]);
    expect(eventOnly!.occurredAt).toBe("2026-08-06T09:41:05.000Z");
    // Run marker only (the 30-event timeline slice has scrolled past it).
    const runOnly = deriveContinuityLoss({ timeline: [ev()], runtime: [brokenRun()] });
    expect(runOnly!.occurredAt).toBeNull();
    expect(runOnly!.agents).toHaveLength(1);
  });

  it("takes the NEWEST continuity event — the slice is newest-first", () => {
    const older = { ...continuityEvent, id: 2, occurredAt: "2026-08-01T00:00:00.000Z" };
    const loss = deriveContinuityLoss({
      timeline: [continuityEvent, ev(), older],
      runtime: [],
    });
    expect(loss!.occurredAt).toBe("2026-08-06T09:41:05.000Z");
  });
});

/* ------------------------------------------------- ContinuityRecoveryPanel */

function renderPanel(props: Partial<Parameters<typeof ContinuityRecoveryPanel>[0]> = {}) {
  return render(
    <ContinuityRecoveryPanel
      timeline={[continuityEvent]}
      runtime={[brokenRun()]}
      {...props}
    />,
  );
}

describe("ContinuityRecoveryPanel", () => {
  it("renders nothing when there is no degradation to report", () => {
    const { container } = render(
      <ContinuityRecoveryPanel timeline={[ev()]} runtime={[run()]} />,
    );
    expect(container.querySelector(".continuity-panel")).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("leads with what remains authoritative, then what was lost", () => {
    const { container } = renderPanel();
    const panel = container.querySelector(".continuity-panel")!;
    expect(panel.querySelector("h2")!.textContent).toBe("Continuity recovery");
    // The lede is the FIRST prose, and it is about the record, not the provider.
    expect(panel.querySelector(".packet-lede")!.textContent).toContain(
      "This task record is still the authority",
    );
    const rows = Array.from(panel.querySelectorAll(".packet-obs .obs"));
    const keys = rows.map((r) => r.querySelector(".k")!.textContent);
    expect(keys[0]).toBe("still authoritative");
    expect(keys[1]).toBe("lost");
    // What was lost is named concretely: engagement, agent, backend, session.
    expect(rows[1]!.textContent).toContain("Delivering agent");
    expect(rows[1]!.textContent).toContain("Dana");
    expect(rows[1]!.textContent).toContain("Claude");
    expect(rows[1]!.querySelector("code")!.textContent).toBe(DEAD_SESSION);
    // …and the panel is honest that the run log it already produced survives.
    expect(rows[1]!.textContent).toContain("run log it already produced is unchanged");
    expect(panel.textContent).toContain("continuity lost");
  });

  it("carries the state in TEXT, distinguishing recovery from failure", () => {
    const label = (lifecycle: RunView["lifecycle"]) => {
      const { container } = renderPanel({ runtime: [brokenRun({ lifecycle })] });
      const pill = container.querySelector(".continuity-panel .panel-head .pill")!;
      const text = container.querySelector(".continuity-panel")!.textContent!;
      const out = { pill: pill.textContent, ready: pill.classList.contains("ready"), text };
      cleanup();
      return out;
    };
    const recovered = label("finished");
    expect(recovered.pill).toBe("re-anchored · recovered");
    expect(recovered.ready).toBe(true);
    expect(recovered.text).toContain("Dana has completed a run since");

    const running = label("running");
    expect(running.pill).toBe("re-anchored · running");
    expect(running.ready).toBe(false);
    expect(running.text).toContain("Dana is running again now");

    const stalled = label("error");
    expect(stalled.pill).toBe("re-anchored · no run since");
    expect(stalled.ready).toBe(false);
    expect(stalled.text).toContain("Dana has not completed a run since");
  });

  it("still reports the break when only the canonical event survives", () => {
    const { container } = renderPanel({ timeline: [continuityEvent], runtime: [run()] });
    const panel = container.querySelector(".continuity-panel")!;
    expect(panel.querySelector(".panel-head .pill")!.textContent).toBe("context lost");
    expect(panel.textContent).toContain("An agent thread lost its provider-side");
    expect(panel.textContent).toContain("One agent thread");
    // Nothing to open a console for, so no console button is offered.
    const labels = Array.from(panel.querySelectorAll("button")).map((b) => b.textContent!);
    expect(labels.some((l) => l.includes("console"))).toBe(false);
  });

  it("announces the state change through a live region that mounts empty", async () => {
    const { container } = renderPanel();
    const live = container.querySelector(".cont-live")!;
    expect(live.getAttribute("role")).toBe("status");
    expect(live.getAttribute("aria-live")).toBe("polite");
    // The region has to EXIST before it carries text or nothing is spoken —
    // so it mounts EMPTY and is filled on a later frame. Text rendered
    // synchronously into a fresh live region is not reliably announced.
    expect(live.textContent).toBe("");
    await waitFor(() =>
      expect(live.textContent).toContain("Continuity notice: Dana's runtime history was lost"),
    );
    expect(live.textContent).toContain("The task record is intact.");
  });

  it("names the region for assistive tech", () => {
    const { container } = renderPanel();
    const panel = container.querySelector(".continuity-panel")!;
    const labelledBy = panel.getAttribute("aria-labelledby")!;
    expect(panel.querySelector(`#${labelledBy}`)!.textContent).toBe("Continuity recovery");
  });

  it("routes to the console and to the operator — both real buttons, both keyboard reachable", () => {
    const opened: string[] = [];
    let asked = 0;
    const { container } = renderPanel({
      onOpenConsole: (id) => opened.push(id),
      onAsk: () => (asked += 1),
    });
    const buttons = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".continuity-panel button"),
    );
    // `button` elements, not click-handling divs: keyboard reach is structural.
    expect(buttons.every((b) => b.tagName === "BUTTON" && b.type === "button")).toBe(true);
    const console_ = buttons.find((b) => b.textContent!.includes("console"))!;
    expect(console_.textContent).toContain("Open Dana’s console");
    fireEvent.click(console_);
    expect(opened).toEqual(["primary"]);
    const ask = buttons.find((b) => b.textContent!.includes("Ask operator"))!;
    fireEvent.click(ask);
    expect(asked).toBe(1);
  });

  it("withholds the console door from a non-member, and still reports the break", () => {
    const { container } = renderPanel({
      runsVisible: false,
      onOpenConsole: () => {},
      onAsk: () => {},
    });
    const panel = container.querySelector(".continuity-panel")!;
    expect(panel).not.toBeNull();
    const labels = Array.from(panel.querySelectorAll("button")).map((b) => b.textContent);
    expect(labels.some((l) => l!.includes("console"))).toBe(false);
    expect(labels.some((l) => l!.includes("Ask operator"))).toBe(true);
  });

  it("names the continuation path in text, and only the one the viewer has", () => {
    const { container } = renderPanel({ canRunAgents: false });
    const hint = container.querySelector(".continuity-panel .hint")!;
    expect(hint.textContent).toContain("@mention");
    expect(hint.textContent).toContain("Dana");
    expect(hint.textContent).toContain("The lost conversation is not restored");
    expect(hint.textContent).not.toContain(EXECUTION_PANEL_LABEL);
    cleanup();

    const runner = renderPanel({ canRunAgents: true });
    expect(
      runner.container.querySelector(".continuity-panel .hint")!.textContent,
    ).toContain(EXECUTION_PANEL_LABEL);
  });

  it("the panel it names by heading is really called that (UX19-4)", () => {
    // Naming a control a reader then cannot find is worse than naming none, so
    // the string is not allowed to drift out from under this note.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(path.join(here, "execution-profile.tsx"), "utf8");
    expect(src).toContain(`<h2>${EXECUTION_PANEL_LABEL}</h2>`);
  });

  it("offers no control the server cannot honour — there is no resume door", () => {
    // `resumeRun` probes the session and, on `missing`, does the fresh start
    // ITSELF; no route intent asks a human to choose. A "Resume session" button
    // here would name an outcome nothing can deliver.
    const { container } = renderPanel({ onOpenConsole: () => {}, onAsk: () => {} });
    const labels = Array.from(container.querySelectorAll("button"))
      .map((b) => b.textContent!.toLowerCase())
      .join(" | ");
    expect(labels).not.toContain("resume");
    expect(labels).not.toContain("restore");
    expect(labels).not.toContain("start fresh");
  });
});

/* ------------------------------------------------------------ page wiring */

const STAGES = [
  { id: "triage", name: "Triage", color: "slate" },
  { id: "review", name: "Review", color: "blue" },
  { id: "done", name: "Done", color: "green" },
];

const ACCEPTANCE: AcceptanceAffordance = {
  hasAuthority: true,
  atBoundary: true,
  blockedReason: null,
  blockedGates: [],
  blockedReasonViaPacket: null,
  canAccept: true,
  terminallyBlocked: false,
};

function detail(patch: Partial<TaskDetail> = {}): TaskDetail {
  return {
    projectSlug: "viberr-core",
    key: "VIB-160",
    title: "Rehydrate a specialist after a lost session",
    stage: "review",
    readiness: "ready",
    displayReadiness: "ready",
    waiting: "human",
    urgent: false,
    priority: "normal",
    labels: [],
    dueDate: null,
    blockedBy: [],
    validation: "healthy",
    blockReason: null,
    owner: null,
    specialist: null,
    reviewers: [],
    operator: null,
    branch: "vib-160",
    repo: "akin-ozer/viberr",
    pr: null,
    prChecks: null,
    prReview: null,
    commits: [],
    otherCommits: [],
    changed: null,
    unownedPr: null,
    foreignHead: null,
    goal: "Keep going from the record.",
    packet: {
      type: "input",
      kind: "Completion report",
      from: "Operator",
      title: "Accept completion?",
      body: "The specialist reports done.",
      observations: [],
      options: [
        { kind: "request_edit", t: "Request one edit", d: "Ask again.", rec: true },
      ],
    },
    eventCount: 1,
    commentCount: 0,
    diagnosticCount: 0,
    createdAt: null,
    updatedAt: null,
    boardRank: null,
    filePath: "projects/viberr-core/tasks/VIB-160/task.md",
    archived: false,
    continuity: null,
    atAcceptanceBoundary: false,
    lastActivityAt: null,
    quiet: false,
    timeline: [continuityEvent],
    diagnostics: [],
    stages: STAGES,
    workflow: [],
    ...patch,
  };
}

function renderPage(task: Partial<TaskDetail> = {}, runtime: RunView[] = [brokenRun()]) {
  const Stub = createRoutesStub([
    {
      path: "/",
      Component: () => (
        <ToastProvider>
          <TaskDetailPage
            task={detail(task)}
            runtime={runtime}
            deployedSpecialists={[]}
            operatorBackend="claude"
            operatorAutonomy="supervised"
            runPrincipal={CONNECTED_PRINCIPAL}
            liveAgentRuns={[]}
            timelineHasMore={false}
            timelineRemaining={0}
            timelineNextLimit={50}
            tlDefault="all"
            members={[]}
            me={{ id: "u-arda", name: "Arda Kaya" }}
            myRole="admin"
            mentionables={{ agents: [], users: [], reserved: [] }}
            recommendations={[]}
            schedules={[]}
            acceptance={ACCEPTANCE}
            githubHost="https://github.com"
          />
        </ToastProvider>
      ),
      action: async () => ({ ok: true }),
    },
  ]);
  return render(<Stub initialEntries={["/"]} />);
}

describe("task detail wiring", () => {
  it("puts the panel in the main column, under the decision packet the head carries, and above the timeline", () => {
    const { container } = renderPage();
    const panel = container.querySelector(".continuity-panel")!;
    const packet = container.querySelector(".packet")!;
    // The timeline's own rows — the "history" half of "status before history".
    const firstEventRow = container.querySelector(".tl-item")!;
    expect(panel).not.toBeNull();
    expect(packet).not.toBeNull();
    expect(firstEventRow).not.toBeNull();
    // U35-2 (pass 35): the open packet is the page's most important object and
    // follows the title directly — its own `.detail-packet` region (owner,
    // 2026-09-08) right after the head, ahead of every column, so a phone
    // reads the question before the metadata. D18 kept execution TRUTH ahead
    // of the decision it may explain; that is now the packet-then-main order
    // the whole page follows, and the panel still precedes every steering
    // action and history — "status before history / decisions before
    // discussion".
    expect(packet.closest(".detail-packet")).not.toBeNull();
    expect(packet.closest(".detail-head")).toBeNull();
    expect(panel.closest(".detail-main")).not.toBeNull();
    expect(
      packet.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      panel.compareDocumentPosition(firstEventRow) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("stays away when the task has no continuity break", () => {
    const { container } = renderPage({ timeline: [ev()] }, [run()]);
    expect(container.querySelector(".continuity-panel")).toBeNull();
  });

  it("hands the panel the page's own console selector and Ask-operator signal", () => {
    const { container } = renderPage();
    const buttons = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".continuity-panel button"),
    ).map((b) => b.textContent);
    expect(buttons.some((b) => b!.includes("Open Dana’s console"))).toBe(true);
    expect(buttons.some((b) => b!.includes("Ask operator"))).toBe(true);
  });

  /** A second agent, so the console has a thread to show before the click. */
  const eli = (patch: Partial<RunView> = {}): RunView =>
    run({
      id: "reviewer",
      serverRunId: "r_2",
      kind: "reviewer",
      profileId: "rev-1",
      who: { kind: "agent", backend: "claude", name: "Eli", role: "reviewer" },
      logWindow: { totalLines: 1, hasMore: false, runIds: ["r_2"], oldest: null, headSeq: 0 },
      ...patch,
    });
  const live = { state: "running", lifecycle: "running", finished: null } as const;
  /** The thread the console shows, read off its own picker. */
  const shownThread = (root: ParentNode) =>
    root.querySelector('[aria-label="Select agent log stream"]')?.textContent ?? "";

  it("opens the named thread's console and leaves an open console open (ruling 380)", async () => {
    const intoView = vi.spyOn(Element.prototype, "scrollIntoView");
    // "re-anchored · running": Dana's re-anchored run streams, so the console
    // is disclosed on the run card, open by default, on the first running
    // thread, which is Eli's.
    const { container } = renderPage({}, [eli(live), brokenRun(live)]);
    const panel = container.querySelector<HTMLElement>(".continuity-panel")!;
    expect(panel.textContent).toContain("re-anchored · running");
    const cardToggle = () =>
      container.querySelector<HTMLButtonElement>(".runbar .run-actions button[aria-expanded]")!;
    const inlineConsole = () => container.querySelector(".runbar-console");
    expect(cardToggle().getAttribute("aria-expanded")).toBe("true");
    expect(shownThread(inlineConsole()!)).toContain("Eli");

    fireEvent.click(within(panel).getByRole("button", { name: /Open Dana’s console/ }));

    // CANARY: hand the panel the card's `onViewLogs` toggle again and the
    // console this door names closes.
    expect(cardToggle().getAttribute("aria-expanded")).toBe("true");
    expect(cardToggle().textContent).toContain("Hide console");
    expect(inlineConsole()).not.toBeNull();
    expect(shownThread(inlineConsole()!)).toContain("Dana");
    await waitFor(() => expect(intoView).toHaveBeenCalledTimes(1));
    expect(intoView.mock.contexts[0]).toBe(
      inlineConsole()!.querySelector('[data-comment-anchor="agent-logs"]'),
    );
  });

  it("with no run streaming, selects the thread in the archive and brings it into view", async () => {
    const intoView = vi.spyOn(Element.prototype, "scrollIntoView");
    const { container } = renderPage({}, [eli(), brokenRun()]);
    const archive = () => container.querySelector('[data-comment-anchor="agent-logs"]')!;
    expect(container.querySelector(".runbar")).toBeNull();
    expect(shownThread(archive())).toContain("Eli");

    fireEvent.click(
      within(container.querySelector<HTMLElement>(".continuity-panel")!).getByRole("button", {
        name: /Open Dana’s console/,
      }),
    );

    expect(shownThread(archive())).toContain("Dana");
    await waitFor(() => expect(intoView).toHaveBeenCalledTimes(1));
    expect(intoView.mock.contexts[0]).toBe(archive());
  });
});
