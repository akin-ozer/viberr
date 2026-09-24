// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { ToastProvider } from "~/ui/toast";
import { ControllerPage } from "./controller-page";
import type { ControllerSurfaceView } from "./controller-query.server";
import { NO_RUN_CACHE, type RunView } from "~/features/runtime/runtime-types";
import { expectWithinBudget } from "../../../test-support/perf-ratchet";

/**
 * Ruling 454, journey `controller` (CTL-2, the page half): what a working turn
 * costs the project controller page while nothing but its step moves. Every
 * revalidation re-runs root, the workspace layout and the page loader, whose
 * payload carries the transcript, the goals and the console window.
 *
 * Fixture: ControllerPage on a routes stub under a root with a loader (both
 * loaders count their runs), a conversation whose controller turn is running
 * with a one-line console, fake timers and a fake EventSource that delivers
 * nothing. Thirty seconds of a steady turn pass.
 */

// jsdom's Element carries no `scrollIntoView`; the transcript calls it on mount.
Element.prototype.scrollIntoView = () => {};

class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readonly url: string;
  readyState = FakeEventSource.OPEN;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(url: string) {
    this.url = url;
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {
    this.readyState = FakeEventSource.CLOSED;
  }
}

const run: RunView = {
  id: "controller",
  serverRunId: "run_ctl",
  role: "Controller",
  kind: "controller",
  profileId: "controller",
  who: { kind: "agent", backend: "claude", name: "Controller", role: "Controller" },
  backend: "claude",
  sdk: "Claude Agent SDK",
  model: "claude-opus-4-8",
  sid: "sess-ctl",
  exportable: false,
  state: "running",
  lifecycle: "running",
  interruptedBy: null,
  phase: "Working",
  step: "viberr_controller · list_tasks",
  startedAt: "2026-09-24T09:59:00.000Z",
  finished: null,
  turns: 3,
  tokens: 1200,
  tokensEstimated: false,
  cache: NO_RUN_CACHE,
  lines: [{ t: "10:00:01", ev: "text", tag: "assistant", text: "Reading the board." }],
  raw: ['{"type":"assistant"}'],
  lineCount: 1,
  logWindow: { totalLines: 1, hasMore: false, runIds: ["run_ctl"], oldest: null, headSeq: 0 },
};

const VIEW: ControllerSurfaceView = {
  available: true,
  controllerName: "Controller",
  projectName: "Viberr Core",
  viewerId: "u1",
  conversations: [
    { id: "cnv_b", title: "Board thread", ownerLabel: "arda@viberr.dev", own: true, lastMessageAt: "2026-09-24T10:00:00.000Z", projectSlug: "viberr-core", taskKey: null, unread: false },
  ],
  conversation: {
    id: "cnv_b",
    userId: "u1",
    userLabel: "arda@viberr.dev",
    projectSlug: "viberr-core",
    taskKey: null,
    title: "Board thread",
    createdAt: "2026-09-24T10:00:00.000Z",
    updatedAt: "2026-09-24T10:00:00.000Z",
    lastMessageAt: "2026-09-24T10:00:00.000Z",
  },
  messages: [],
  taskLinks: {},
  turn: { working: true, runId: "run_ctl", phase: null, step: "viberr_controller · list_tasks" },
  runtime: [run],
  canInterruptTurn: true,
  goals: [],
  viewerOwnsActive: true,
  showingAll: false,
  viewerIsOrgAdmin: true,
};

let loaderRuns = 0;
const fetches: string[] = [];

beforeEach(() => {
  loaderRuns = 0;
  fetches.length = 0;
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("fetch", (input: string | URL | Request) => {
    fetches.push(input instanceof Request ? input.url : String(input));
    const body = {
      data: {
        runId: "run_ctl",
        threadId: "controller",
        state: "running",
        lines: [],
        headSeq: 0,
        oldestSeq: -1,
        hasMore: false,
        facts: {
          phase: "Working",
          step: "viberr_controller · list_tasks",
          turns: 3,
          tokens: 1200,
          tokensEstimated: false,
          cache: NO_RUN_CACHE,
        },
      },
    };
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

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe("the controller page during a working turn (ruling 454, CTL-2)", () => {
  it("re-runs no loader while only the turn's step moves", async () => {
    const Stub = createRoutesStub([
      {
        id: "root",
        path: "/",
        loader: () => {
          loaderRuns += 1;
          return { csrf: "tok", theme: "system" };
        },
        children: [
          {
            path: "projects/:slug/controller",
            loader: () => {
              loaderRuns += 1;
              return null;
            },
            Component: () => (
              <ToastProvider>
                <ControllerPage view={VIEW} projectSlug="viberr-core" canRedirectGoals={false} />
              </ToastProvider>
            ),
          },
        ],
      },
    ]);
    const { container } = render(<Stub initialEntries={["/projects/viberr-core/controller?c=cnv_b"]} />);
    await act(async () => {
      await settle();
    });
    // The working row is up and names the step.
    expect(container.querySelector(".ctl-working-step")).not.toBeNull();
    loaderRuns = 0;
    for (let s = 0; s < 30; s++) {
      await act(async () => {
        vi.advanceTimersByTime(1000);
        await settle();
      });
    }
    expectWithinBudget("console:controller-page.loader-runs-per-30s-turn", loaderRuns);
  });
});
