// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "@testing-library/react";
import { startTransition, type ComponentProps, type ReactElement } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { createRoutesStub } from "react-router";
import type { TaskDetailPage } from "./task-detail-page";
import type { TaskDetail } from "~/server/projections/task-query.server";
import type { AcceptanceAffordance } from "~/server/tasks/task-actions.server";
import type { TaskSchedule } from "~/schemas/task-file.schema";
import type { PacketRender } from "~/shared/mapping/task.server";
import type { TimelineEventRender } from "~/shared/mapping/task-event.server";
import type { LogLine, RunView } from "~/features/runtime/runtime-types";
import { NO_RUN_CACHE } from "~/features/runtime/runtime-types";
import type { DeployedSpecialistView } from "./execution-profile";
import type { RecommendationView } from "./operator-recommendations";

/**
 * The task page's hydration determinism gate (pass 34, C6 + C8, closes U34-2).
 *
 * A real `renderToString` of the page in the SERVER's environment, then a real
 * `hydrateRoot` of that markup in the VIEWER's, with React's recoverable-error
 * collector wired in: a "server rendered text didn't match the client" (the
 * minified `#418` with `args[]=text` both live sightings carried) lands in
 * `recoverable`, and the assertion prints it — including, on React's DEV
 * build, the diff that names the text.
 *
 * The two environments are deliberately as far apart as the product runs them:
 *
 *   - ZONE: the server renders in UTC (the container has no `TZ`); the viewer
 *     hydrates in Pacific/Auckland, UTC+12, which pushes most UTC stamps across
 *     a calendar-day boundary. The zone is applied per environment with
 *     `vi.resetModules()` + a dynamic import, because the module-level
 *     `Intl.DateTimeFormat` instances in `shared/dates/format.ts` resolve their
 *     zone at IMPORT — a bare `process.env.TZ` flip between two renders in one
 *     process re-zones `Date` but not those formatters, and would prove
 *     nothing about them.
 *   - CLOCK: the server's "now" is 23:59:59Z and the viewer's 00:00:01Z, the
 *     UTC-midnight pair on which a first pass that samples the clock ("Today",
 *     "Yesterday") disagrees on every stamp at once.
 *
 * Over the two live shapes U34-2 was sighted on: a RUNNING run with a
 * streaming console, and an `accept_completion` card at the acceptance
 * boundary. The interrupted case mirrors `app/entry.client.tsx` exactly:
 * hydration inside `startTransition`, a discrete event landing on the
 * server-rendered console before that transition has flushed (React 19
 * answers it by hydrating synchronously, ahead of the transition), and then a
 * `run.log-appended` update of the shape `useRunLogStream` produces, delivered
 * through the workspace layout's live stream (the tab's one EventSource,
 * ruling 457) and the console's `/resources/run-log` tail fetch.
 */

type PageProps = ComponentProps<typeof TaskDetailPage>;
type PageModule = typeof import("./task-detail-page");
type ToastModule = typeof import("~/ui/toast");
type LiveModule = typeof import("~/features/live-updates/use-live-updates");

/** The container's zone: no `TZ` at all in the shipped image. */
const SERVER_ZONE = "UTC";
/** The e2e viewer zone (`06-activity-hydration.spec.ts`): UTC+12. */
const VIEWER_ZONE = "Pacific/Auckland";
/** The UTC-midnight pair. */
const SERVER_NOW = "2026-07-03T23:59:59.000Z";
const VIEWER_NOW = "2026-07-04T00:00:01.000Z";

const SYSTEM_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

/* ----------------------------------------------------------- fixtures */

const STAGES = [
  { id: "triage", name: "Triage", color: "slate" },
  { id: "review", name: "Review", color: "blue" },
  { id: "done", name: "Done", color: "green" },
];

const ARDA = { kind: "human" as const, userId: "u-arda", name: "Arda Kaya", initials: "AK", tone: "" };
const DEVELOPER = { kind: "agent" as const, backend: "claude" as const, name: "Developer", role: "Developer" };

function event(patch: Partial<TimelineEventRender>): TimelineEventRender {
  return {
    id: 1,
    type: "comment",
    occurredAt: "2026-07-03T23:30:00.000Z",
    actor: ARDA,
    title: null,
    text: "hello",
    toAgent: false,
    evidence: null,
    attachments: null,
    ...patch,
  };
}

/**
 * Stamps chosen against the two clocks: 23:30Z is the server's "today" and
 * the viewer's "yesterday"; Jul 2 is the server's "yesterday" and the viewer's
 * day before; Jun 30 is plain for both. A first pass that reads the clock
 * rewrites the first two differently on each side.
 */
const TIMELINE: TimelineEventRender[] = [
  event({
    id: 4,
    occurredAt: "2026-07-03T23:30:00.000Z",
    text: "@Developer the tests pass here, finish the attach flow.",
    toAgent: true,
  }),
  event({
    id: 3,
    type: "completion",
    occurredAt: "2026-07-03T09:41:00.000Z",
    actor: DEVELOPER,
    title: "Completion report",
    text: "Implemented repo attach.",
    evidence: [
      { label: "unit/policy_gate_test", result: "6 passed", status: "pass" },
      { label: "screenshot-1.png", result: "", status: "info" },
    ],
    attachments: ["screenshot-1.png"],
  }),
  event({
    id: 2,
    type: "github",
    occurredAt: "2026-07-02T16:04:00.000Z",
    actor: { kind: "system", name: "GitHub" },
    text: "Opened PR #147 for review.",
  }),
  event({
    id: 1,
    type: "note",
    occurredAt: "2026-06-30T08:15:00.000Z",
    actor: { kind: "system", name: "Operator" },
    text: "Branch vib-151 allocated.",
  }),
];

function detail(patch: Partial<TaskDetail> = {}): TaskDetail {
  return {
    projectSlug: "viberr-core",
    key: "VIB-151",
    title: "Compress long-running task timelines",
    stage: "review",
    readiness: "ready",
    displayReadiness: "ready",
    waiting: "human",
    urgent: false,
    priority: "high",
    labels: ["runtime"],
    dueDate: "2026-07-03",
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
    eventCount: TIMELINE.length,
    commentCount: 1,
    diagnosticCount: 0,
    createdAt: "2026-06-30T08:00:00.000Z",
    updatedAt: "2026-07-03T23:30:00.000Z",
    boardRank: null,
    filePath: "projects/viberr-core/tasks/VIB-151/task.md",
    timeline: TIMELINE,
    diagnostics: [],
    stages: STAGES,
    workflow: [],
    lastActivityAt: "2026-07-03T23:30:00.000Z",
    quiet: false,
    ...patch,
  };
}

/** A console the way a real run fills it: every line kind the panel folds,
 *  hoists or colours, with the stored envelope beside each. */
const CONSOLE: LogLine[] = [
  { t: "23:31:05", ev: "init", tag: "system·init", text: "session 51d8f0e2 · claude-sonnet-4-5" },
  { t: "23:31:07", ev: "text", tag: "assistant", text: "Reading the task file and the failing test." },
  { t: "23:31:09", ev: "tool", tag: "tool_use", name: "Bash", text: "npm test", input: { command: "npm test" } },
  { t: "23:31:20", ev: "out", tag: "tool_result", text: "Tests  12 passed (12)\nDuration  1.2s" },
  { t: "23:31:21", ev: "err", tag: "tool_result", text: "warning: deprecated option --legacy" },
  { t: "23:31:22", ev: "think", tag: "thinking", text: "Considering the diff." },
  { t: "23:31:23", ev: "think", tag: "thinking", text: "Checking the attach path." },
  { t: "23:31:24", ev: "meta", tag: "usage", text: "input 1200 · output 300" },
  { t: "23:59:40", ev: "text", tag: "assistant", text: "Attach flow implemented; running the sweep." },
];
const CONSOLE_RAW = CONSOLE.map((line) => JSON.stringify({ type: line.tag, text: line.text }));

function run(patch: Partial<RunView>): RunView {
  return {
    id: "primary",
    serverRunId: "run_1",
    role: "Primary specialist",
    kind: "primary",
    profileId: "developer",
    who: { kind: "agent", backend: "claude", name: "Developer", role: "Developer" },
    backend: "claude",
    sdk: "Claude Agent SDK",
    model: "claude-sonnet-4-5",
    sid: "51d8f0e2-3a7b-4c1d-9e0f-1234567890ab",
    exportable: true,
    state: "running",
    lifecycle: "running",
    interruptedBy: null,
    phase: "Running validation sweep",
    step: "Bash · npm test",
    startedAt: "2026-07-03T23:31:00.000Z",
    finished: null,
    turns: 4,
    // F35-1: a live Claude run carries the adapter's estimate until the result.
    tokens: 1500,
    tokensEstimated: true,
    cache: NO_RUN_CACHE,
    lines: CONSOLE,
    raw: CONSOLE_RAW,
    lineCount: CONSOLE.length,
    logWindow: {
      totalLines: CONSOLE.length,
      hasMore: false,
      runIds: ["run_1"],
      oldest: null,
      headSeq: CONSOLE.length - 1,
    },
    ...patch,
  };
}

const FINISHED_OPERATOR = run({
  id: "op",
  serverRunId: "run_op",
  op: true,
  role: "Operator",
  kind: "operator",
  profileId: "operator",
  who: { kind: "agent", name: "Operator" },
  state: "done",
  lifecycle: "finished",
  phase: null,
  step: null,
  startedAt: "2026-07-03T23:20:00.000Z",
  finished: "2026-07-03T23:29:30.000Z",
  turns: 2,
  tokens: 800,
  tokensEstimated: false,
  cache: NO_RUN_CACHE,
  lines: [
    { t: "23:20:01", ev: "init", tag: "system·init", text: "session op-1" },
    { t: "23:29:30", ev: "result", tag: "result", text: "success · 2 turns", stats: { subtype: "success", dur: 569, api: 400, turns: 2, cost: 0.02, in: 500, cached: 0, out: 300 } },
  ],
  raw: ['{"type":"system","subtype":"init"}', '{"type":"result","subtype":"success"}'],
  lineCount: 2,
  logWindow: { totalLines: 2, hasMore: false, runIds: ["run_op"], oldest: null, headSeq: 1 },
});

const DEPLOYED: DeployedSpecialistView[] = [
  { id: "developer", name: "Developer", role: "Developer", backend: "claude", model: "claude-sonnet-4-5", capabilities: { delivery: true, verdict: false, askHuman: true, browser: true } },
  { id: "reviewer", name: "Reviewer", role: "Reviewer", backend: "codex", model: "gpt-5-codex", capabilities: { delivery: false, verdict: true, askHuman: false, browser: false } },
];

const SCHEDULE: TaskSchedule = {
  id: "s-1",
  action: "run-operator",
  dueAt: "2026-07-04T01:00:00.000Z",
  profileId: null,
  prompt: "",
  createdBy: "u-selin",
  createdByLabel: "Selin",
  createdAt: "2026-07-03T20:00:00.000Z",
  status: "pending",
  firedAt: null,
  claimedAt: null,
  retries: 0,
};

const ACCEPT_PACKET: PacketRender = {
  type: "input",
  kind: "Completion report",
  from: "Operator",
  title: "Accept completion, or send back for one fix?",
  body: "The developer specialist reports the attach flow is implemented and the review PR is open.",
  observations: [
    { k: "Changed", v: "9 files · +412 / −87", code: true },
    { k: "Validation", v: "unit + integration green", code: false },
  ],
  options: [
    { kind: "accept_completion", t: "Accept completion", d: "Mark task done and merge the review PR.", rec: true },
    { kind: "request_edit", t: "Request one edit", d: "Ask the developer to widen the PAT scope.", rec: false },
  ],
};

const ACCEPT_RECOMMENDATION: RecommendationView = {
  id: "rec_1",
  kind: "accept_completion",
  label: "Accept completion and move VIB-151 to Done",
  detail: "The review is clean and the work meets the goal.",
};

const ACCEPTANCE: AcceptanceAffordance = {
  hasAuthority: true,
  atBoundary: true,
  blockedReason: null,
  blockedGates: [],
  blockedReasonViaPacket: null,
  canAccept: true,
  terminallyBlocked: false,
};

const BASE_PROPS: Omit<PageProps, "task" | "runtime"> = {
  labelSuggestions: ["runtime", "github"],
  attachments: [{ name: "screenshot-1.png", size: 48_213, modifiedAt: "2026-07-03T23:45:00.000Z" }],
  attachmentsTotal: 1,
  attachmentProducers: { "screenshot-1.png": { actor: "Developer", occurredAt: "2026-07-03T23:45:00.000Z" } },
  attachmentsBase: "/projects/viberr-core/tasks/VIB-151/attachments",
  deployedSpecialists: DEPLOYED,
  operatorBackend: "claude",
  operatorAutonomy: "supervised",
  runPrincipal: {
    ownerUserId: "u-arda",
    ownerName: "Arda Kaya",
    claude: { available: true, detail: null },
    codex: { available: true, detail: null },
  },
  liveAgentRuns: [],
  runsVisible: true,
  timelineHasMore: true,
  timelineRemaining: 12,
  timelineNextLimit: 50,
  tlDefault: "all",
  members: [
    { userId: "u-arda", role: "admin", user: { name: "Arda Kaya", initials: "AK", tone: "" } },
    { userId: "u-selin", role: "contributor", user: { name: "Selin Aksoy", initials: "SA", tone: "" } },
  ],
  me: { id: "u-arda", name: "Arda Kaya" },
  myRole: "admin",
  mentionables: {
    agents: [{ handle: "developer", name: "Developer", role: "Developer", backend: "claude" }],
    users: [{ handle: "selin", name: "Selin Aksoy", email: "selin@viberr.dev" }],
    reserved: [],
  },
  recommendations: [],
  schedules: [SCHEDULE],
  archived: false,
  acceptance: { ...ACCEPTANCE, atBoundary: false, canAccept: false },
  githubHost: "https://github.com",
  githubReconciledAt: "2026-07-03T23:50:00.000Z",
  githubCheckedAt: "2026-07-03T23:58:00.000Z",
  workRevisionSha: "aaaaaaaaaaaabbbbbbbbbbbb",
  defaultBranch: "main",
  canDeliver: false,
};

/** Arda's sighting: a live run with a streaming console. */
function duringLiveRun(): PageProps {
  return {
    ...BASE_PROPS,
    task: detail({ waiting: "agent", displayReadiness: "agent_working" }),
    runtime: [run({}), FINISHED_OPERATOR],
    liveAgentRuns: [{ profileId: "developer", lifecycle: "running" }],
  };
}

/** Maya's sighting: an `accept_completion` card at the acceptance boundary, on
 *  a task whose runs have finished (the console still renders). */
function withAcceptCard(): PageProps {
  return {
    ...BASE_PROPS,
    task: detail({
      pr: { number: 147, state: "review", title: "[VIB-151] Compress timelines", headSha: "aaaaaaaaaaaabbbbbbbbbbbb" },
      packet: ACCEPT_PACKET,
      atAcceptanceBoundary: true,
    }),
    runtime: [
      run({ state: "done", lifecycle: "finished", phase: null, step: null, finished: "2026-07-03T23:59:50.000Z" }),
      FINISHED_OPERATOR,
    ],
    recommendations: [ACCEPT_RECOMMENDATION],
    acceptance: ACCEPTANCE,
  };
}

/* ------------------------------------------------------------ harness */

/** Load the page in one environment: the zone is applied BEFORE the import so
 *  the module-level formatters resolve it (see the header). */
async function pageIn(zone: string, entry = "/"): Promise<(props: PageProps) => ReactElement> {
  process.env.TZ = zone;
  vi.resetModules();
  const page: PageModule = await import("./task-detail-page");
  const toast: ToastModule = await import("~/ui/toast");
  const live: LiveModule = await import("~/features/live-updates/use-live-updates");
  // The workspace layout's stream (`routes/project.tsx`): it carries the
  // console's frames to the page (ruling 457).
  const LayoutStream = ({ slug, taskKey }: { slug: string; taskKey: string }) => {
    live.useLiveUpdates([`project:${slug}`, `task:${slug}/${taskKey}`]);
    return null;
  };
  return (props) => {
    const Stub = createRoutesStub([
      {
        path: "/",
        Component: () => (
          <toast.ToastProvider>
            <LayoutStream slug={props.task.projectSlug} taskKey={props.task.key} />
            <page.TaskDetailPage {...props} />
          </toast.ToastProvider>
        ),
        action: async () => ({ ok: true }),
      },
    ]);
    return <Stub initialEntries={[entry]} />;
  };
}

function messageOf(error: Error | string): string {
  return error instanceof Error ? error.message : String(error);
}

/** Everything React reports while hydrating: the recoverable errors (a text
 *  mismatch is one) and the DEV build's console warnings (an ATTRIBUTE mismatch
 *  is only ever one of those — React neither patches nor throws for it). */
interface HydrationReport {
  recoverable: string[];
  warnings: string[];
}

const roots: Root[] = [];
const containers: HTMLElement[] = [];

/** The server pass, in the server's zone and at the server's clock. */
async function serverHtml(sighting: () => PageProps): Promise<string> {
  vi.setSystemTime(new Date(SERVER_NOW));
  const element = await pageIn(SERVER_ZONE);
  return renderToString(element(sighting()));
}

/** The viewer pass: the same page hydrated over the server's markup, in the
 *  viewer's zone and at the viewer's clock, the way `entry.client.tsx` does
 *  it — inside `startTransition`. `interrupt` runs between the `hydrateRoot`
 *  call and the flush. */
async function hydrate(
  html: string,
  sighting: () => PageProps,
  interrupt?: (container: HTMLElement) => void,
  /** The URL the viewer opened (ruling 497: its hash never reaches the server). */
  entry = "/",
): Promise<{ container: HTMLElement; report: HydrationReport }> {
  vi.setSystemTime(new Date(VIEWER_NOW));
  const element = await pageIn(VIEWER_ZONE, entry);
  const container = document.createElement("div");
  container.innerHTML = html;
  document.body.appendChild(container);
  containers.push(container);
  const report: HydrationReport = { recoverable: [], warnings: [] };
  const consoleError = vi
    .spyOn(console, "error")
    .mockImplementation((...args: (Error | string)[]) => {
      report.warnings.push(args.map(messageOf).join(" "));
    });
  try {
    await act(async () => {
      startTransition(() => {
        roots.push(
          hydrateRoot(container, element(sighting()), {
            onRecoverableError: (error) => {
              report.recoverable.push(messageOf(error instanceof Error ? error : String(error)));
            },
          }),
        );
      });
      interrupt?.(container);
    });
    // The passive effects of the hydration commit (`useHydrated` flips, the
    // EventSource opens) — a second, ordinary render, never a hydration.
    await act(async () => {});
  } finally {
    consoleError.mockRestore();
  }
  return { container, report };
}

function timelineStamps(root: ParentNode): string[] {
  return [...root.querySelectorAll(".tl-time")].map((el) => el.textContent ?? "");
}

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  for (const container of containers.splice(0)) container.remove();
  vi.useRealTimers();
  process.env.TZ = SYSTEM_ZONE;
  vi.resetModules();
});

function freezeClock() {
  // Only `Date` is faked: React's scheduler keeps its real timers.
  vi.useFakeTimers({ toFake: ["Date"] });
}

/* ------------------------------------------------------------- cases */

describe.each([
  ["a running run with a streaming console", duringLiveRun],
  ["an accept_completion card at the acceptance boundary", withAcceptCard],
])("the task page hydrates clean across the zone and midnight pair: %s", (_name, sighting) => {
  it("the server's markup depends on the timestamps alone", async () => {
    freezeClock();
    const html = await serverHtml(sighting);
    // Every timeline stamp is the absolute UTC day + UTC clock, whatever
    // "today" is on the server: 23:30Z is the server's own day and still
    // renders as a date.
    expect(html).toContain('class="tl-time">Jul 3 · 23:30<');
    expect(html).toContain('class="tl-time">Jul 3 · 09:41<');
    expect(html).toContain('class="tl-time">Jul 2 · 16:04<');
    expect(html).toContain('class="tl-time">Jun 30 · 08:15<');
    expect(html).not.toMatch(/Today|Yesterday/);
    // The console keeps the stored UTC wall clock until hydration.
    expect(html).toContain(">23:31:05<");
    // A calendar-shaped date never renders host-zone on the first pass.
    expect(html).not.toMatch(/Jul \d{1,2}, 2026/);
  });

  /**
   * Ruling 497: a notification's link names an event by the URL's hash, which a
   * browser never sends. A document load of that link (a refresh, a pasted
   * URL, the router's reload after a deploy) is rendered by the server with no
   * mark, so the mark is drawn after hydration, never during it. CANARY: read
   * `location.hash` in `useHashTarget` without `useHydrated` and the item's
   * `tabIndex` and `data-targeted` come back as attribute-mismatch warnings.
   */
  it("hydrates a link to an event cleanly and marks the event after hydration", async () => {
    freezeClock();
    const html = await serverHtml(sighting);
    const { container, report } = await hydrate(
      html,
      sighting,
      undefined,
      "/#event-2026-07-03T09:41:00.000Z",
    );
    expect(report.recoverable, report.recoverable.join("\n\n")).toEqual([]);
    expect(report.warnings, report.warnings.join("\n\n")).toEqual([]);
    const marked = [...container.querySelectorAll(".tl-item[data-targeted]")].map((el) => el.id);
    expect(marked).toEqual(["event-2026-07-03T09:41:00.000Z"]);
  });

  it("hydrates the server's markup in the viewer's zone with no recoverable error", async () => {
    freezeClock();
    const html = await serverHtml(sighting);
    const { container, report } = await hydrate(html, sighting);
    expect(report.recoverable, report.recoverable.join("\n\n")).toEqual([]);
    expect(report.warnings, report.warnings.join("\n\n")).toEqual([]);
    // The effect swapped in the viewer-local forms: 23:30Z on Jul 3 is 11:30 on
    // Jul 4 in Auckland — the viewer's "today" at 00:00:01Z — so the newest
    // row now reads the bare clock; 09:41Z on Jul 3 is 21:41 the same day and
    // 16:04Z on Jul 2 is 04:04 on Jul 3, both the viewer's "yesterday".
    expect(timelineStamps(container)).toEqual([
      "11:30",
      "Yesterday · 21:41",
      "Yesterday · 04:04",
      "Jun 30 · 20:15",
    ]);
    // The console re-anchored its clocks to the viewer's zone too.
    expect(container.textContent).toContain("11:31:05");
  });

  it("stays clean when hydration is INTERRUPTED the way entry.client.tsx allows: a discrete event before the transition flushes, then a run-log update", async () => {
    freezeClock();
    const html = await serverHtml(sighting);

    /** The frame the run sink publishes per console line (`sse-event.schema.ts`). */
    interface RunLogAppendedFrame {
      projectSlug: string;
      taskKey: string;
      runId: string;
      threadId: string;
      seq: number;
    }
    // The page's own live-tail plumbing, so the update takes the real path:
    // The layout's `useLiveUpdates` opens THIS EventSource in its effect, and
    // the console answers a `run.log-appended` frame on it with a
    // `/resources/run-log` tail fetch.
    class FakeEventSource {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 2;
      static instances: FakeEventSource[] = [];
      readonly url: string;
      readyState = FakeEventSource.OPEN;
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      private readonly listeners = new Map<string, ((event: MessageEvent) => void)[]>();
      constructor(url: string) {
        this.url = url;
        FakeEventSource.instances.push(this);
      }
      addEventListener(type: string, listener: (event: MessageEvent) => void): void {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
      }
      close(): void {
        this.readyState = FakeEventSource.CLOSED;
      }
      emit(type: string, data: RunLogAppendedFrame): void {
        for (const listener of this.listeners.get(type) ?? []) {
          listener(new MessageEvent(type, { data: JSON.stringify({ data }) }));
        }
      }
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    const tailRequests: string[] = [];
    const APPENDED = "Sweep finished: 12 passed. Delivering the branch.";
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      tailRequests.push(url);
      const since = Number(new URL(url, "http://viberr.test").searchParams.get("since"));
      return new Response(
        JSON.stringify({
          data: {
            threadId: "primary",
            lines: [
              {
                seq: since + 1,
                display: { t: "00:00:02", ev: "text", tag: "assistant", text: APPENDED },
                raw: JSON.stringify({ type: "assistant", text: APPENDED }),
              },
            ],
            headSeq: since + 1,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const { container, report } = await hydrate(html, sighting, (root) => {
      // A person acting before hydration finishes: a discrete event on the
      // server-rendered console (the `{ } raw` toggle). It reaches React's
      // root listener while the root is still dehydrated, and React 19
      // hydrates synchronously to answer it — ahead of the transition the
      // root was scheduled in, exactly the interruption entry.client.tsx
      // makes possible.
      const rawToggle = root.querySelector('button[title="Show raw stream events"]');
      expect(rawToggle).not.toBeNull();
      rawToggle!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(report.recoverable, report.recoverable.join("\n\n")).toEqual([]);
    expect(report.warnings, report.warnings.join("\n\n")).toEqual([]);
    // The click was not lost to the interruption: React hydrated synchronously
    // and then dispatched it to the freshly hydrated toggle.
    expect(
      container.querySelector('button[title="Show raw stream events"]')!.getAttribute("aria-pressed"),
    ).toBe("true");

    // The hydration effects opened the layout's stream on the task scope; the
    // appended line then arrives the way the run sink publishes it.
    const source = FakeEventSource.instances[0];
    expect(source).toBeDefined();
    expect(source!.url).toContain("task");
    await act(async () => {
      source!.emit("run.log-appended", {
        projectSlug: "viberr-core",
        taskKey: "VIB-151",
        runId: "run_1",
        threadId: "primary",
        seq: CONSOLE.length,
      });
    });
    expect(tailRequests).toHaveLength(1);
    expect(tailRequests[0]).toContain(`runId=run_1&since=${CONSOLE.length - 1}`);
    expect(container.textContent).toContain(APPENDED);
    expect(report.recoverable).toEqual([]);
    expect(report.warnings).toEqual([]);
  });
});
