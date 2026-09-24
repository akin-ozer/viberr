// @vitest-environment jsdom
import { Profiler, useState, type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { createRoutesStub, Outlet } from "react-router";
import { ToastProvider } from "~/ui/toast";
import { useLiveUpdates } from "~/features/live-updates/use-live-updates";
import { sseScopes } from "~/features/live-updates/event-types";
import {
  NO_RUN_CACHE,
  type LogLine,
  type RunView,
} from "~/features/runtime/runtime-types";
import type { TaskDetail } from "~/server/projections/task-query.server";
import { TaskDetailPage } from "./task-detail-page";
import { expectWithinBudget } from "../../../test-support/perf-ratchet";
import { createRenderCounter, observeMutations } from "../../../test-support/render-counter";

/**
 * Ruling 454, journey `live-run`: what the browser does per console line, per
 * revalidation, per "load older" and per clock tick on a task page whose agent
 * is streaming.
 *
 * Fixture: TaskDetailPage under a routes stub beside the workspace layout's
 * live stream (`useLiveUpdates` on project + task + user, as
 * `routes/project.tsx` holds it), inside one Profiler. The developer's run is
 * running with a 40-row or a 400-row console (a 400-line window of 600 stored
 * lines; text, Bash calls, multi-line output and thoughts in turn), beside a
 * finished operator run of 50 lines; no timeline events (the timeline is not
 * this cluster's). A fake EventSource delivers each frame to every open
 * connection holding the task's scope, as the broker does; a fake
 * `/resources/run-log` answers a tail with the one new line and a backward
 * page with the lines asked for. Timers are fake, so nothing but the measured
 * event runs.
 */

type PageProps = ComponentProps<typeof TaskDetailPage>;

const SLUG = "viberr-core";
const KEY = "VIB-151";
const TASK_SCOPE = encodeURIComponent(sseScopes.task(SLUG, KEY));

class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];
  readonly url: string;
  readyState = FakeEventSource.OPEN;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly listeners = new Map<string, ((event: MessageEvent<string>) => void)[]>();
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  removeEventListener(): void {}
  close(): void {
    this.readyState = FakeEventSource.CLOSED;
  }
  static open(): FakeEventSource[] {
    return FakeEventSource.instances.filter((es) => es.readyState !== FakeEventSource.CLOSED);
  }
}

/** A `run.log-appended` frame body, as the broker puts it on the wire. */
interface RunLineFrame {
  projectSlug: string;
  taskKey: string;
  runId: string;
  threadId: string;
  seq: number;
}

let nextEventId = 100;
/** The broker's fan-out: one frame, the same id, to every connection holding
 *  the task's scope. */
function deliver(type: string, data: RunLineFrame): void {
  const id = String(nextEventId++);
  for (const es of FakeEventSource.open()) {
    if (!es.url.includes(TASK_SCOPE)) continue;
    for (const listener of es.listeners.get(type) ?? []) {
      listener(new MessageEvent(type, { data: JSON.stringify({ data }), lastEventId: id }));
    }
  }
}

/** One stored console line: its display projection and its wire envelope. */
interface StoredLine {
  display: LogLine;
  raw: string;
}

/** One stored console line, cycling through the kinds the console draws. */
function logLine(runId: string, seq: number): StoredLine {
  const kind = seq % 5;
  const display: LogLine =
    kind === 1
      ? { t: "10:00:01", ev: "tool", tag: "tool_use", name: "Bash", text: `npm test -- ${seq}`, input: { command: `npm test -- ${seq}` } }
      : kind === 2
        ? { t: "10:00:02", ev: "out", tag: "tool_result", text: `ok ${seq}\nTests 12 passed\nDuration 1.2s` }
        : kind === 3
          ? { t: "10:00:03", ev: "think", tag: "thinking", text: `Considering step ${seq}.` }
          : { t: "10:00:04", ev: "text", tag: "assistant", text: `${runId} line ${seq}: reading the failing test.` };
  return { display, raw: JSON.stringify({ type: display.tag, seq, text: display.text }) };
}

function runView(patch: Partial<RunView>, seqs: number[], runId: string): RunView {
  const lines = seqs.map((seq) => logLine(runId, seq));
  return {
    id: "primary",
    serverRunId: runId,
    role: "Primary specialist",
    kind: "primary",
    profileId: "developer",
    who: { kind: "agent", backend: "claude", name: "Developer", role: "Developer" },
    backend: "claude",
    sdk: "Claude Agent SDK",
    model: "claude-sonnet-4-5",
    sid: "51d8f0e2-3a7b-4c1d-9e0f-1234567890ab",
    exportable: false,
    state: "running",
    lifecycle: "running",
    interruptedBy: null,
    phase: "Implementing",
    step: "Bash · npm test",
    startedAt: "2026-09-24T09:00:00.000Z",
    finished: null,
    turns: 4,
    tokens: 1500,
    tokensEstimated: true,
    cache: NO_RUN_CACHE,
    lines: lines.map((l) => l.display),
    raw: lines.map((l) => l.raw),
    lineCount: seqs.length,
    logWindow: {
      totalLines: seqs.length,
      hasMore: false,
      runIds: [runId],
      oldest: null,
      headSeq: seqs.at(-1) ?? -1,
    },
    ...patch,
  };
}

const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);

/** The streaming developer: `rows` lines on screen; with 400, a window of 600. */
function developer(rows: 40 | 400): RunView {
  if (rows === 40) return runView({}, range(0, 40), "run_1");
  return runView(
    {
      lineCount: 600,
      logWindow: {
        totalLines: 600,
        hasMore: true,
        runIds: ["run_1"],
        oldest: { runId: "run_1", seq: 200 },
        headSeq: 599,
      },
    },
    range(200, 600),
    "run_1",
  );
}

const OPERATOR = runView(
  {
    id: "op",
    op: true,
    role: "Operator",
    kind: "operator",
    profileId: "operator",
    who: { kind: "agent", name: "Operator" },
    state: "done",
    lifecycle: "finished",
    phase: null,
    step: null,
    finished: "2026-09-24T08:59:00.000Z",
    tokensEstimated: false,
  },
  range(0, 50),
  "run_op",
);

function detail(): TaskDetail {
  return {
    projectSlug: SLUG,
    key: KEY,
    title: "Compress long-running task timelines",
    stage: "impl",
    readiness: "ready",
    displayReadiness: "agent_working",
    waiting: "agent",
    urgent: false,
    priority: "high",
    labels: [],
    dueDate: null,
    blockedBy: [],
    archived: false,
    validation: "healthy",
    continuity: null,
    blockReason: null,
    atAcceptanceBoundary: false,
    owner: { kind: "human", userId: "u-arda", name: "Arda Kaya", initials: "AK", tone: "" },
    specialist: null,
    reviewers: [],
    operator: null,
    branch: "vib-151",
    repo: "akin-ozer/viberr",
    pr: null,
    prChecks: null,
    prReview: null,
    commits: [],
    otherCommits: [],
    changed: null,
    unownedPr: null,
    foreignHead: null,
    goal: "Keep the timeline readable on long tasks.",
    packet: null,
    eventCount: 0,
    commentCount: 0,
    diagnosticCount: 0,
    createdAt: "2026-09-20T08:00:00.000Z",
    updatedAt: "2026-09-24T09:00:00.000Z",
    boardRank: null,
    filePath: `projects/${SLUG}/tasks/${KEY}/task.md`,
    timeline: [],
    diagnostics: [],
    stages: [
      { id: "triage", name: "Triage", color: "slate" },
      { id: "impl", name: "In Progress", color: "violet" },
      { id: "done", name: "Done", color: "green" },
    ],
    workflow: [],
    lastActivityAt: "2026-09-24T09:00:00.000Z",
    quiet: false,
  };
}

function pageProps(rows: 40 | 400): PageProps {
  return {
    task: detail(),
    runtime: [OPERATOR, developer(rows)],
    deployedSpecialists: [],
    operatorBackend: "claude",
    operatorAutonomy: "supervised",
    runPrincipal: null,
    liveAgentRuns: [{ profileId: "developer", lifecycle: "running" }],
    runsVisible: true,
    timelineHasMore: false,
    timelineRemaining: 0,
    timelineNextLimit: 30,
    tlDefault: "all",
    members: [{ userId: "u-arda", role: "admin", user: { name: "Arda Kaya", initials: "AK", tone: "" } }],
    me: { id: "u-arda", name: "Arda Kaya" },
    myRole: "admin",
    mentionables: { agents: [], users: [], reserved: [] },
    recommendations: [],
    schedules: [],
    acceptance: {
      hasAuthority: true,
      atBoundary: false,
      blockedReason: null,
      blockedGates: [],
      blockedReasonViaPacket: null,
      canAccept: false,
      terminallyBlocked: false,
    },
    githubHost: "https://github.com",
  };
}

/** `/resources/run-log`, answered from the fixture's numbering. */
function runLogResponse(url: string) {
  const params = new URL(url, "http://viberr.test").searchParams;
  const runId = params.get("runId") ?? "run_1";
  const facts = {
    phase: "Implementing",
    step: "Bash · npm test",
    turns: 4,
    tokens: 1500,
    tokensEstimated: true,
    cache: NO_RUN_CACHE,
  };
  if (params.has("before") || params.has("limit")) {
    const before = Number(params.get("before") ?? "600");
    const limit = Number(params.get("limit") ?? "200");
    const from = Math.max(0, before - limit);
    const seqs = range(from, before);
    return {
      data: {
        runId,
        threadId: "primary",
        state: "running",
        lines: seqs.map((seq) => ({ seq, occurredAt: "", ...logLine(runId, seq) })),
        headSeq: seqs.at(-1) ?? -1,
        oldestSeq: seqs[0] ?? -1,
        hasMore: from > 0,
        facts,
      },
    };
  }
  const since = Number(params.get("since") ?? "-1");
  return {
    data: {
      runId,
      threadId: "primary",
      state: "running",
      lines: [{ seq: since + 1, occurredAt: "", ...logLine(runId, since + 1) }],
      headSeq: since + 1,
      oldestSeq: since + 1,
      hasMore: true,
      facts,
    },
  };
}

let fetches: string[] = [];

beforeEach(() => {
  FakeEventSource.instances = [];
  fetches = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("fetch", (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    fetches.push(url);
    const body = runLogResponse(url);
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(new Date("2026-09-24T10:00:00.000Z"));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Settles the microtask chain a tail fetch resolves through. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function LayoutStream() {
  useLiveUpdates([sseScopes.project(SLUG), sseScopes.task(SLUG, KEY), sseScopes.user()]);
  return null;
}

let showProps: (props: PageProps) => void = () => {};

async function mountPage(rows: 40 | 400) {
  const counter = createRenderCounter();
  const initial = pageProps(rows);
  const Host = () => {
    const [props, setProps] = useState(initial);
    showProps = setProps;
    return (
      <Profiler id="task-page" onRender={counter.onRender}>
        <ToastProvider>
          <LayoutStream />
          <TaskDetailPage {...props} />
        </ToastProvider>
      </Profiler>
    );
  };
  const Stub = createRoutesStub([{ path: "/t", Component: Host, action: async () => ({ ok: true }) }]);
  const { container } = render(<Stub initialEntries={["/t"]} />);
  await act(async () => {
    await settle();
  });
  counter.attach(container);
  const mutations = observeMutations(container);
  return { container, counter, mutations, initial };
}

/** One console line: the frame, the tail fetch, the commit it causes. */
async function appendLine(seq: number) {
  await act(async () => {
    deliver("run.log-appended", { projectSlug: SLUG, taskKey: KEY, runId: "run_1", threadId: "primary", seq });
    await settle();
  });
}

function consoleRows(container: HTMLElement): number {
  return container.querySelectorAll(".console > .log-line").length;
}

describe("the task page per console line (ruling 454)", () => {
  it("holds one live connection, the layout's", async () => {
    await mountPage(40);
    expectWithinBudget("console:task-page.event-sources", FakeEventSource.open().length);
  });

  it.each([40, 400] as const)("appending one line to a %i-row console", async (rows) => {
    const { container, counter, mutations } = await mountPage(rows);
    const before = consoleRows(container);
    const head = rows === 40 ? 39 : 599;
    counter.reset();
    mutations.take();
    await appendLine(head + 1);
    // The line arrived, once.
    expect(container.textContent).toContain(`run_1 line ${head + 1}`);
    expect(consoleRows(container)).toBe(before + 1);
    expectWithinBudget(
      rows === 40 ? "console:task-page.renders-per-line-40" : "console:task-page.renders-per-line-400",
      counter.total(),
    );
    expectWithinBudget(
      rows === 40
        ? "console:task-page.dom-writes-per-line-40"
        : "console:task-page.dom-writes-per-line-400",
      mutations.take().length,
    );
    expectWithinBudget("console:task-page.page-renders-per-line", counter.renders("TaskDetailPage"));
  });

  it("a revalidation that brings the same data back", async () => {
    const { counter, mutations, initial } = await mountPage(400);
    counter.reset();
    mutations.take();
    await act(async () => {
      showProps(structuredClone(initial));
      await settle();
    });
    expectWithinBudget("console:task-page.renders-per-noop-revalidation", counter.total());
    expectWithinBudget("console:task-page.dom-writes-per-noop-revalidation", mutations.take().length);
  });

  it("a revalidation after five lines, whose window slid by those five", async () => {
    const { container, counter, mutations, initial } = await mountPage(400);
    for (let seq = 600; seq < 605; seq++) await appendLine(seq);
    const slid = structuredClone(initial);
    const dev = runView(
      {
        lineCount: 605,
        logWindow: {
          totalLines: 605,
          hasMore: true,
          runIds: ["run_1"],
          oldest: { runId: "run_1", seq: 205 },
          headSeq: 604,
        },
      },
      range(205, 605),
      "run_1",
    );
    slid.runtime = [slid.runtime[0]!, dev];
    counter.reset();
    mutations.take();
    await act(async () => {
      showProps(slid);
      await settle();
    });
    expect(container.textContent).toContain("run_1 line 604");
    expectWithinBudget("console:task-page.commits-per-sliding-revalidation-400", counter.commits());
    expectWithinBudget("console:task-page.dom-writes-per-sliding-revalidation-400", mutations.take().length);
  });

  it("loading 200 older lines into a 400-row console", async () => {
    const { container, mutations } = await mountPage(400);
    const button = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "load older lines",
    );
    expect(button).toBeDefined();
    const before = consoleRows(container);
    mutations.take();
    await act(async () => {
      button!.click();
      await settle();
    });
    expect(container.textContent).toContain("run_1 line 0:");
    expect(consoleRows(container)).toBeGreaterThan(before + 100);
    expectWithinBudget("console:task-page.dom-writes-per-load-older-400", mutations.take().length);
  });

  it("the Live run clock's one-second tick", async () => {
    const { counter, mutations } = await mountPage(40);
    counter.reset();
    mutations.take();
    await act(async () => {
      vi.advanceTimersByTime(1000);
      await settle();
    });
    expectWithinBudget("console:task-page.renders-per-clock-tick", counter.total());
  });
});

describe("loaders a live run re-runs on the task page (ruling 454, LIVE-1 / RF-2)", () => {
  it("a line every half second for 19.5 s (short of the F22 safety tick)", async () => {
    let loaderRuns = 0;
    const count = () => {
      loaderRuns += 1;
      return null;
    };
    const initial = pageProps(40);
    const Layout = () => (
      <>
        <LayoutStream />
        <Outlet />
      </>
    );
    const Task = () => (
      <ToastProvider>
        <TaskDetailPage {...initial} />
      </ToastProvider>
    );
    const Stub = createRoutesStub([
      {
        id: "root",
        path: "/",
        loader: count,
        children: [
          {
            path: "p",
            loader: count,
            Component: Layout,
            children: [{ path: "t", loader: count, Component: Task }],
          },
        ],
      },
    ]);
    const { container } = render(<Stub initialEntries={["/p/t"]} />);
    await act(async () => {
      await settle();
    });
    loaderRuns = 0;
    for (let i = 1; i <= 39; i++) {
      await act(async () => {
        deliver("run.log-appended", {
          projectSlug: SLUG,
          taskKey: KEY,
          runId: "run_1",
          threadId: "primary",
          seq: 39 + i,
        });
        vi.advanceTimersByTime(500);
        await settle();
      });
    }
    // Every line reached the console.
    expect(container.textContent).toContain("Considering step 78.");
    expectWithinBudget("console:task-page.loader-runs-per-20s-of-lines", loaderRuns);
  });
});
