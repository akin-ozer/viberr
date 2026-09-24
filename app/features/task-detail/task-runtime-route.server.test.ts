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

/** The seeded users this file drives the route with. */
interface SeedUserIds {
  arda: string;
  selin: string;
  deniz: string;
}

let app: AppTestContext;
let ids: SeedUserIds;
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
    // Registered, but a member of NO project — the UI-30 gate subject.
    deniz: findUserByEmail(app.db, "deniz@viberr.dev")!.id,
  };

  // Ruling 127: these runs bill arda (the demo tasks' owner), so he needs the
  // backend connected — the same thing that makes a real dispatch reach an
  // adapter.
  const { connectFakeBackend } = await import(
    "../../../test-support/backend-credentials"
  );
  await connectFakeBackend(app.db, ids.arda, "claude");
  await connectFakeBackend(app.db, ids.arda, "codex");
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
    credentialUserId: ids.arda,
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
    credentialUserId: ids.arda,
    backend: "claude",
    model: "claude-sonnet-4-5",
    prompt: "work",
    dataRoot: app.dataRoot,
  });
  runningRunId = running.runId;

  // Both runs settle through async timers — wait for their target states.
  // SAFETY: the SELECT names one column, and 0001_baseline declares
  // `agent_runs.state` TEXT NOT NULL — so a matched row carries exactly this
  // shape, and `get` returns undefined when the id matches nothing.
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
  // SAFETY: the loader reads only `request` and `params.{slug,key}`; the rest of
  // the generated `Route.LoaderArgs` (the router context provider, its matches)
  // is untouched on every path this file exercises.
  return await loader({
    request: app.request(`/projects/viberr-core/tasks/${key}`, { cookie }),
    params: { slug: "viberr-core", key },
    context: {},
  } as never);
}

async function postIntent(
  key: string,
  userId: string,
  fields: Record<string, string>,
): Promise<ActionData> {
  const { action } = await import("~/routes/project.task");
  const { cookie, sessionId } = await app.cookieFor(userId);
  const csrf = await app.csrfFor(sessionId);
  // SAFETY: as in `runLoader` — the action reads only `request` and
  // `params.{slug,key}` out of the generated `Route.ActionArgs`.
  return await action({
    request: app.request(`/projects/viberr-core/tasks/${key}`, {
      method: "POST",
      cookie,
      body: new URLSearchParams({ _csrf: csrf, ...fields }),
    }),
    params: { slug: "viberr-core", key },
    context: {},
  } as never);
}

describe("loader — runtime projection shape", () => {
  it("VIB-142: the finished run projects with lines and real usage; its envelopes wait for the raw view", async () => {
    const { runtime } = await runLoader("VIB-142", ids.arda);
    const run = runtime.find((r) => r.serverRunId === finishedRunId)!;
    expect(run).toMatchObject({ backend: "codex", state: "done" });
    expect(run.lines.length).toBeGreaterThan(0);
    // Ruling 454 (owner decision 2, 2026-09-24): a document load carries the
    // shown agent's display lines, each with its key, and no stored envelope;
    // the console loads the envelopes when its raw view opens.
    expect(run.lineKeys).toHaveLength(run.lines.length);
    expect(run.raw).toEqual([]);
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

  /**
   * UI-30: raw run logs, the `{ } raw` wire envelopes and the provider session
   * id were served to ANY signed-in user, while `/resources/run-log` and
   * `/resources/session-export` — which serve the same material — require
   * project membership. The surface was simultaneously more permissive than its
   * own data routes AND broken (the live tail silently 403'd, Export downloaded
   * a 403 body). One policy: members see the console, everyone else keeps the
   * honest run summary.
   */
  it("R15-4: a NON-MEMBER does not reach the task page at all", async () => {
    // This used to assert the reduced projection a non-member received (UI-30's
    // summary-without-console). R15-4 moved the boundary one step out: a
    // non-member cannot open a project's task, so there is no projection to
    // reduce. The refusal is the layout's byte-identical unknown-slug 404, and
    // it has to live on THIS loader too — single-fetch honors `?_routes=`, so
    // the child loader can be invoked without its parent's gate.
    await expect(runLoader("VIB-142", ids.deniz)).rejects.toMatchObject({
      init: { status: 404 },
      data: "No project at projects/viberr-core.",
    });
  });

  it("UI-30: a project MEMBER still gets the full console", async () => {
    const { runtime, runsVisible } = await runLoader("VIB-142", ids.selin);
    expect(runsVisible).toBe(true);
    const run = runtime.find((r) => r.serverRunId === finishedRunId)!;
    expect(run.lines.length).toBeGreaterThan(0);
    expect(run.sid).toBe("sess-142");
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
    // D32-18 (pass 32): the task's own record says a PERSON stopped the run —
    // a note authored by the interrupter, naming the run. Before, the audit
    // row and the run row knew and the timeline showed silence. Canary: drop
    // the `noteInterrupt` call in interruptRun.
    const note = after.task.timeline.find(
      (e) => e.type === "note" && e.text.includes(`Interrupted the`) && e.text.includes(runningRunId),
    );
    expect(note, "the interrupt must leave a timeline note").toBeTruthy();
    expect(note!.actor).toMatchObject({ kind: "human", userId: ids.arda });
    expect(note!.text).toContain("The thread stays resumable");
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
