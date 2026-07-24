import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupAppTest, type AppTestContext } from "../../../test-support/test-app";
import { listAuditEvents } from "../../../test-support/audit-log";
import {
  installFakeRuntime,
  queueFakeRun,
} from "../../../test-support/fake-runtime";
import type { loader as taskLoader, action as taskAction } from "~/routes/project.task";

/**
 * Route-level tests for the Phase-8 runtime wiring on routes/project.task:
 * the loader's `runtime` projection shape and the `run-interrupt` action's
 * RBAC + audit through a real Request.
 *
 * R7-2: the demo seed ships ZERO fabricated runs, so this file creates its
 * own runs through the run-service (the gated deterministic test engine —
 * vitest is inside the gate) instead of reading seeded run history:
 *   - a finished run on VIB-142 (persisted lines + raw envelopes),
 *   - a keepRunning run on VIB-151 (the interrupt target).
 * One seed per file; read-only assertions before the mutating interrupt.
 */

let app: AppTestContext;
let ids: { arda: string; selin: string };
let finishedRunId: string;
let runningRunId: string;

type LoaderData = Awaited<ReturnType<typeof taskLoader>>;
type ActionData = Awaited<ReturnType<typeof taskAction>>;

beforeAll(async () => {
  app = await setupAppTest();
  const { runDemoSeed } = await import("../../../test-support/demo-seed");
  await runDemoSeed(app.db, { dataRoot: app.dataRoot });
  const { findUserByEmail } = await import("~/server/auth/user-store.server");
  ids = {
    arda: findUserByEmail(app.db, "arda@viberr.dev")!.id,
    selin: findUserByEmail(app.db, "selin@viberr.dev")!.id,
  };

  const { startRun } = await import("~/server/runtimes/run-service.server");
  installFakeRuntime();

  queueFakeRun(
    {
      lines: [
        { t: "", ev: "init", tag: "thread.started", text: "thread x" },
        { t: "", ev: "text", tag: "agent_message", text: "analysis done" },
        {
          t: "",
          ev: "result",
          tag: "turn.completed",
          text: "done",
          usage: { input_tokens: 128034, cached_input_tokens: 0, output_tokens: 6188 },
        },
      ],
      occurredAt: [
        new Date().toISOString(),
        new Date().toISOString(),
        new Date().toISOString(),
      ],
      sessionId: "sess-142",
    },
    "codex",
  );
  const finished = await startRun(app.db, {
    projectSlug: "viberr-core",
    taskKey: "VIB-142",
    threadId: "primary-test",
    role: "Primary specialist",
    kind: "primary",
    agentProfileId: "developer",
    backend: "codex",
    model: "gpt-5.4-codex",
    prompt: "analyze",
    dataRoot: app.dataRoot,
  });
  finishedRunId = finished.runId;

  queueFakeRun({
    lines: [{ t: "", ev: "text", tag: "assistant", text: "working" }],
    occurredAt: [new Date().toISOString()],
    sessionId: "sess-151",
    keepRunning: true,
  });
  const running = await startRun(app.db, {
    projectSlug: "viberr-core",
    taskKey: "VIB-151",
    threadId: "primary-live",
    role: "Primary specialist",
    kind: "primary",
    agentProfileId: "developer",
    backend: "claude",
    model: "claude-sonnet-4-5",
    prompt: "work",
    dataRoot: app.dataRoot,
  });
  runningRunId = running.runId;

  // Both runs settle through async timers — wait for their target states.
  const state = (id: string) =>
    (app.db.prepare(`SELECT state FROM agent_runs WHERE id = ?`).get(id) as
      | { state: string }
      | undefined)?.state;
  for (let i = 0; i < 200; i++) {
    if (state(finishedRunId) === "finished" && state(runningRunId) === "running") break;
    await new Promise((r) => setTimeout(r, 25));
  }
  expect(state(finishedRunId)).toBe("finished");
  expect(state(runningRunId)).toBe("running");
});
afterAll(() => app.cleanup());

async function runLoader(key: string, userId: string): Promise<LoaderData> {
  const { loader } = await import("~/routes/project.task");
  const { cookie } = await app.cookieFor(userId);
  return (await loader({
    request: app.request(`/projects/viberr-core/tasks/${key}`, { cookie }),
    params: { slug: "viberr-core", key },
    context: {},
  } as never)) as LoaderData;
}

async function postIntent(key: string, userId: string, fields: Record<string, string>) {
  const { action } = await import("~/routes/project.task");
  const { cookie, sessionId } = await app.cookieFor(userId);
  const csrf = await app.csrfFor(sessionId);
  return (await action({
    request: app.request(`/projects/viberr-core/tasks/${key}`, {
      method: "POST",
      cookie,
      body: new URLSearchParams({ _csrf: csrf, ...fields }),
    }),
    params: { slug: "viberr-core", key },
    context: {},
  } as never)) as ActionData | { data: { ok: false; error: string }; init: { status: number } };
}

describe("loader — runtime projection shape", () => {
  it("VIB-142: the finished run projects with lines, raw envelopes, and real usage", async () => {
    const { runtime } = await runLoader("VIB-142", ids.arda);
    const run = runtime.find((r) => r.serverRunId === finishedRunId)!;
    expect(run).toMatchObject({ backend: "codex", state: "done" });
    expect(run.lines.length).toBeGreaterThan(0);
    expect(run.raw.length).toBe(run.lines.length);
    // Real usage — codex turn.completed in+out tokens (no fabrication).
    expect(run.tokens).toBe(128034 + 6188);
  });

  it("VIB-151: the live run projects as running", async () => {
    const { runtime } = await runLoader("VIB-151", ids.arda);
    const run = runtime.find((r) => r.serverRunId === runningRunId)!;
    expect(run.state).toBe("running");
  });

  it("VIB-166: no runtime threads (the seed fabricates NO run history — R7-2)", async () => {
    const { runtime } = await runLoader("VIB-166", ids.arda);
    expect(runtime).toEqual([]);
  });
});

describe("action — run-interrupt RBAC + audit", () => {
  it("reviewer (selin) is denied (403)", async () => {
    const result = await postIntent("VIB-151", ids.selin, {
      intent: "run-interrupt",
      runId: runningRunId,
    });
    expect("init" in result && result.init?.status).toBe(403);
  });

  it("admin (arda) interrupts a running run → interrupted + audit event", async () => {
    const result = await postIntent("VIB-151", ids.arda, {
      intent: "run-interrupt",
      runId: runningRunId,
    });
    expect("ok" in result && result.ok).toBe(true);

    const after = await runLoader("VIB-151", ids.arda);
    const interrupted = after.runtime.find((r) => r.serverRunId === runningRunId)!;
    expect(interrupted.lifecycle).toBe("interrupted");
    expect(interrupted.interruptedBy?.userId).toBe(ids.arda);

    const audits = listAuditEvents(app.db, { action: "runtime.run.interrupted" });
    expect(audits[0]?.actorUserId).toBe(ids.arda);
    expect(audits[0]?.taskKey).toBe("VIB-151");
  });

  it("interrupting an already-terminal run is a friendly no-op", async () => {
    const result = await postIntent("VIB-142", ids.arda, {
      intent: "run-interrupt",
      runId: finishedRunId,
    });
    expect("ok" in result && result.ok).toBe(true);
    // "already finished" toast copy.
    expect("toast" in result && String(result.toast)).toContain("already finished");
  });
});
