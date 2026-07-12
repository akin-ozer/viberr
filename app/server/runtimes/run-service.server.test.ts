import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { createTestDbContext, type TestDbContext } from "../../../test-support/test-db";
import { setupTestStore, writeTask, baseTaskFrontmatter, type TestStore } from "../../../test-support/test-store";
import { AppError } from "~/server/errors/app-error.server";
import { listAuditEvents } from "../../../test-support/audit-log";
import {
  configureRunServiceForTests,
  disposeRunsForDatabaseForTests,
  getRunLog,
  interruptRun,
  interruptRunAndWait,
  listRunsForTask,
  resumeRun,
  startRun,
} from "./run-service.server";
import { getRun, listRunLines } from "./run-store.server";
import { resetSseBrokerForTests } from "~/server/events/sse-broker.server";
import type { SimulatedScript } from "./simulated-runtime.server";
import type { LogLine } from "~/features/runtime/runtime-types";
import type { RunSpec, RuntimeAdapter } from "./adapter.server";
import type { AdapterSet } from "./runtime-registry.server";
import {
  getBackendHealth,
  setBackendAvailability,
} from "./runtime-registry.server";

let ctx: TestDbContext;
let store: TestStore;

beforeEach(() => {
  ctx = createTestDbContext();
  store = setupTestStore(ctx);
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-1", { stage: "impl", ownerUserId: store.users.arda.id }),
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
  resetSseBrokerForTests();
  configureRunServiceForTests(); // no real backend keys → simulated engine
});

afterEach(() => {
  resetSseBrokerForTests();
  ctx.cleanup();
});

function instantScript(lines: LogLine[], backend: "claude" | "codex" = "claude"): SimulatedScript {
  return {
    lines,
    occurredAt: lines.map(() => new Date().toISOString()),
    sessionId: "sess-test",
    backend,
    model: "claude-sonnet-4-5",
    op: false,
    keepRunning: false,
    instant: true,
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0));
}

describe("run-service lifecycle (simulated)", () => {
  it("startRun materializes a run + persists lines + reaches finished", async () => {
    const script = instantScript([
      { t: "1", ev: "init", tag: "system·init", text: "session x" },
      { t: "2", ev: "text", tag: "assistant", text: "hello" },
      { t: "3", ev: "result", tag: "result", text: "done", stats: { dur: 100, api: 90, turns: 2, cost: 0.1, in: 5, cached: 2, out: 3 } },
    ]);
    const { runId, simulated } = await startRun(store.db, {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      role: "Primary specialist",
      kind: "primary",
      backend: "claude",
      model: "claude-sonnet-4-5",
      prompt: "go",
      script,
      dataRoot: store.dataRoot,
    });
    expect(simulated).toBe(true); // no real key
    await settle();

    const run = getRun(store.db, runId)!;
    expect(run.state).toBe("finished");
    expect(run.simulated).toBe(1);
    expect(run.backend).toBe("claude"); // requested backend kept for glyph fidelity
    const lines = listRunLines(store.db, runId);
    expect(lines.length).toBe(3);
    // Tokens/cost derived from the REAL result envelope, not fabricated.
    expect(run.total_cost_usd).toBe(0.1);
    expect(run.output_tokens).toBe(3);
  });

  it("store teardown cancels callbacks before the DB closes", async () => {
    const script = instantScript([
      { t: "1", ev: "init", tag: "system·init", text: "session x" },
      { t: "2", ev: "text", tag: "assistant", text: "hello" },
      { t: "3", ev: "result", tag: "result", text: "done" },
    ]);
    const { runId } = await startRun(store.db, {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      role: "Primary specialist",
      kind: "primary",
      backend: "claude",
      model: "claude-sonnet-4-5",
      prompt: "go",
      script,
      dataRoot: store.dataRoot,
    });
    disposeRunsForDatabaseForTests(store.db);
    store.db.close();
    await settle();
    expect(runId).toMatch(/^run_/);
  });

  it("derives NO tokens/cost when no usage envelope is produced (no fabrication)", async () => {
    const script = instantScript([
      { t: "1", ev: "init", tag: "system·init", text: "s" },
      { t: "2", ev: "tool", tag: "tool_use", name: "Bash", text: "ls" },
      { t: "3", ev: "out", tag: "tool_result", text: "ok" },
    ]);
    const { runId } = await startRun(store.db, {
      projectSlug: store.slug, taskKey: "VIB-1", role: "R", kind: "primary",
      backend: "claude", model: "m", prompt: "go", script, dataRoot: store.dataRoot,
    });
    await settle();
    const run = getRun(store.db, runId)!;
    expect(run.input_tokens).toBe(0);
    expect(run.output_tokens).toBe(0);
    expect(run.total_cost_usd).toBeNull();
  });

  it("listRunsForTask returns a RunView with derived render state + raw envelopes", async () => {
    const { runId } = await startRun(store.db, {
      projectSlug: store.slug, taskKey: "VIB-1", role: "Primary specialist", kind: "primary",
      backend: "codex", model: "gpt-5.4-codex", prompt: "go",
      script: instantScript(
        [{ t: "1", ev: "init", tag: "thread.started", text: "thread x" }, { t: "2", ev: "result", tag: "turn.completed", text: "done", usage: { input_tokens: 5, cached_input_tokens: 2, output_tokens: 3 } }],
        "codex",
      ),
      dataRoot: store.dataRoot,
    });
    await settle();
    const runs = listRunsForTask(store.db, store.slug, "VIB-1");
    const run = runs.find((r) => r.serverRunId === runId)!;
    expect(run.state).toBe("done");
    expect(run.backend).toBe("codex");
    expect(run.raw.length).toBe(run.lines.length);
    expect(JSON.parse(run.raw[0]!).type).toBe("thread.started");
  });

  it("getRunLog tails lines since a seq", async () => {
    const { runId } = await startRun(store.db, {
      projectSlug: store.slug, taskKey: "VIB-1", role: "R", kind: "primary",
      backend: "claude", model: "m", prompt: "go",
      script: instantScript([
        { t: "1", ev: "text", tag: "assistant", text: "a" },
        { t: "2", ev: "text", tag: "assistant", text: "b" },
        { t: "3", ev: "text", tag: "assistant", text: "c" },
      ]),
      dataRoot: store.dataRoot,
    });
    await settle();
    const tail = getRunLog(store.db, runId, 0)!;
    expect(tail.lines.map((l) => l.display.text)).toEqual(["b", "c"]);
    expect(tail.headSeq).toBe(2);
  });

  it("forwards input.effort onto the RunSpec handed to the adapter", async () => {
    const specs: RunSpec[] = [];
    const capture: RuntimeAdapter = {
      backend: "simulated",
      start(spec, cb) {
        specs.push(spec);
        cb.onExit({ outcome: "finished", effectiveBackend: "simulated", simulated: true, sessionId: null });
        return { runId: spec.runId, interrupt() {} };
      },
    };
    const adapters: AdapterSet = { claude: capture, codex: capture, simulated: capture };
    configureRunServiceForTests(adapters);

    await startRun(store.db, {
      projectSlug: store.slug, taskKey: "VIB-1", role: "R", kind: "primary",
      backend: "claude", model: "sonnet", effort: "xhigh", prompt: "go",
      dataRoot: store.dataRoot,
    });
    await settle();
    expect(specs[0]?.effort).toBe("xhigh");
    expect(specs[0]?.model).toBe("sonnet");

    // Omitting effort leaves spec.effort undefined (SDK default applies).
    await startRun(store.db, {
      projectSlug: store.slug, taskKey: "VIB-1", threadId: "t2", role: "R", kind: "primary",
      backend: "claude", model: "sonnet", prompt: "go", dataRoot: store.dataRoot,
    });
    await settle();
    expect(specs[1]?.effort).toBeUndefined();
  });

  it("feeds provider health from real success/failure, but not simulated runs", async () => {
    let outcome: "finished" | "error" = "finished";
    const realClaude: RuntimeAdapter = {
      backend: "claude",
      start(spec, cb) {
        cb.onExit({
          outcome,
          effectiveBackend: "claude",
          simulated: false,
          sessionId: "real-session",
        });
        return { runId: spec.runId, interrupt() {} };
      },
    };
    const simulated: RuntimeAdapter = {
      backend: "simulated",
      start(spec, cb) {
        cb.onExit({
          outcome: "finished",
          effectiveBackend: "simulated",
          simulated: true,
          sessionId: "sim-session",
        });
        return { runId: spec.runId, interrupt() {} };
      },
    };
    configureRunServiceForTests({
      claude: realClaude,
      codex: realClaude,
      simulated,
    });
    setBackendAvailability("claude", true);

    await startRun(store.db, {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      threadId: "health-success",
      role: "R",
      kind: "primary",
      backend: "claude",
      model: "sonnet",
      prompt: "go",
      dataRoot: store.dataRoot,
    });
    expect(getBackendHealth("claude")).toMatchObject({
      status: "verified",
      verified: true,
    });

    outcome = "error";
    await startRun(store.db, {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      threadId: "health-failure",
      role: "R",
      kind: "primary",
      backend: "claude",
      model: "sonnet",
      prompt: "go",
      dataRoot: store.dataRoot,
    });
    expect(getBackendHealth("claude")).toMatchObject({
      status: "degraded",
      verified: false,
      degraded: true,
    });
  });
});

describe("interruptRun — RBAC + audit + idempotency", () => {
  async function startRunning() {
    // A never-ending running run (keepRunning): interrupt is meaningful.
    const script: SimulatedScript = {
      lines: [{ t: "1", ev: "text", tag: "assistant", text: "working" }],
      sessionId: "s", backend: "claude", model: "m", op: false, keepRunning: true, instant: true,
    };
    const { runId } = await startRun(store.db, {
      projectSlug: store.slug, taskKey: "VIB-1", role: "R", kind: "primary",
      backend: "claude", model: "m", prompt: "go", script, dataRoot: store.dataRoot,
    });
    await settle();
    return runId;
  }

  it("admin interrupts → interrupted state + interrupted_by + audit event", async () => {
    const runId = await startRunning();
    expect(getRun(store.db, runId)!.state).toBe("running");
    const result = interruptRun(store.db, { projectSlug: store.slug, taskKey: "VIB-1", runId }, { userId: store.users.arda.id, label: store.users.arda.email });
    await settle();
    expect(result.outcome).toBe("interrupted");
    const run = getRun(store.db, runId)!;
    expect(run.state).toBe("interrupted");
    expect(run.interrupted_by).toBe(store.users.arda.id);
    const audits = listAuditEvents(store.db, { action: "runtime.run.interrupted" });
    expect(audits[0]?.actorUserId).toBe(store.users.arda.id);
  });

  it("maintainer may interrupt", async () => {
    const runId = await startRunning();
    const result = interruptRun(store.db, { projectSlug: store.slug, taskKey: "VIB-1", runId }, { userId: store.users.murat.id, label: store.users.murat.email });
    expect(result.outcome).toBe("interrupted");
  });

  it("reviewer / viewer / non-member cannot interrupt (403)", async () => {
    const runId = await startRunning();
    for (const u of [store.users.selin, store.users.elif, store.users.deniz]) {
      expect(() =>
        interruptRun(store.db, { projectSlug: store.slug, taskKey: "VIB-1", runId }, { userId: u.id, label: u.email }),
      ).toThrow(AppError);
    }
  });

  it("interrupting a finished run is an idempotent no-op (not an error)", async () => {
    const { runId } = await startRun(store.db, {
      projectSlug: store.slug, taskKey: "VIB-1", role: "R", kind: "primary",
      backend: "claude", model: "m", prompt: "go",
      script: instantScript([{ t: "1", ev: "text", tag: "assistant", text: "x" }]),
      dataRoot: store.dataRoot,
    });
    await settle();
    expect(getRun(store.db, runId)!.state).toBe("finished");
    const result = interruptRun(store.db, { projectSlug: store.slug, taskKey: "VIB-1", runId }, { userId: store.users.arda.id, label: store.users.arda.email });
    expect(result.outcome).toBe("already-terminal");
    expect(getRun(store.db, runId)!.state).toBe("finished");
  });

  it("waits for the exact provider run to acknowledge interruption", async () => {
    let interrupted = false;
    const delayed: RuntimeAdapter = {
      backend: "simulated",
      start(spec, cb) {
        return {
          runId: spec.runId,
          interrupt() {
            interrupted = true;
            setTimeout(
              () =>
                cb.onExit({
                  outcome: "interrupted",
                  effectiveBackend: "simulated",
                  simulated: true,
                  sessionId: "delayed-session",
                }),
              8,
            );
          },
        };
      },
    };
    configureRunServiceForTests({
      claude: delayed,
      codex: delayed,
      simulated: delayed,
    });
    const { runId } = await startRun(store.db, {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      role: "R",
      kind: "primary",
      backend: "claude",
      model: "m",
      prompt: "go",
      dataRoot: store.dataRoot,
    });

    const result = await interruptRunAndWait(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", runId },
      { userId: store.users.arda.id, label: store.users.arda.email },
      { timeoutMs: 200, pollMs: 2 },
    );

    expect(interrupted).toBe(true);
    expect(result.outcome).toBe("interrupted");
    expect(result.run?.serverRunId).toBe(runId);
    expect(getRun(store.db, runId)?.state).toBe("interrupted");
  });

  it("reports a pending acknowledgement instead of false success", async () => {
    const slow: RuntimeAdapter = {
      backend: "simulated",
      start(spec) {
        return { runId: spec.runId, interrupt() {} };
      },
    };
    configureRunServiceForTests({
      claude: slow,
      codex: slow,
      simulated: slow,
    });
    const { runId } = await startRun(store.db, {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      role: "R",
      kind: "primary",
      backend: "claude",
      model: "m",
      prompt: "go",
      dataRoot: store.dataRoot,
    });

    const result = await interruptRunAndWait(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", runId },
      { userId: store.users.arda.id, label: store.users.arda.email },
      { timeoutMs: 5, pollMs: 1 },
    );

    expect(result.outcome).toBe("interrupting");
    expect(result.run?.serverRunId).toBe(runId);
    expect(getRun(store.db, runId)?.state).toBe("running");
  });
});

describe("agent identity — startRun persists + resumeRun carries (BUG 2)", () => {
  it("startRun persists agent_name + agent_profile_id on the run row", async () => {
    const { runId } = await startRun(store.db, {
      projectSlug: store.slug, taskKey: "VIB-1", role: "Primary specialist", kind: "primary",
      backend: "claude", model: "m", agentName: "dev", agentProfileId: "dev", prompt: "go",
      script: instantScript([{ t: "1", ev: "text", tag: "assistant", text: "x" }]),
      dataRoot: store.dataRoot,
    });
    await settle();
    const row = getRun(store.db, runId)!;
    expect(row.agent_name).toBe("dev");
    expect(row.agent_profile_id).toBe("dev");
  });

  it("resumeRun carries the prior run's agent identity onto the new row by default", async () => {
    const { runId } = await startRun(store.db, {
      projectSlug: store.slug, taskKey: "VIB-1", role: "Primary specialist", kind: "primary",
      backend: "claude", model: "m", agentName: "dev", agentProfileId: "dev", prompt: "go",
      script: instantScript([{ t: "1", ev: "init", tag: "system·init", text: "s" }, { t: "2", ev: "text", tag: "assistant", text: "x" }]),
      dataRoot: store.dataRoot,
    });
    await settle();

    const resumed = await resumeRun(store.db, {
      runId,
      prompt: "follow up",
      script: instantScript([{ t: "1", ev: "text", tag: "assistant", text: "reply" }]),
      dataRoot: store.dataRoot,
    });
    await settle();
    const newRow = getRun(store.db, resumed.runId)!;
    expect(newRow.id).not.toBe(runId); // a NEW row
    expect(newRow.agent_name).toBe("dev");
    expect(newRow.agent_profile_id).toBe("dev");

    // Both runs group into ONE Agent-logs entry labeled by the agent name.
    const views = listRunsForTask(store.db, store.slug, "VIB-1");
    const devViews = views.filter((v) => v.who.name === "dev");
    expect(devViews.length).toBe(1);
  });

  // XS-1: a resumed specialist must be re-confined by its denylist / git ceiling
  // / MCP set / persona — the resume path used to drop all of them.
  it("resumeRun forwards the run confinement onto the resumed RunSpec", async () => {
    const specs: RunSpec[] = [];
    const capture: RuntimeAdapter = {
      backend: "simulated",
      start(spec, cb) {
        specs.push(spec);
        cb.onExit({ outcome: "finished", effectiveBackend: "simulated", simulated: true, sessionId: null });
        return { runId: spec.runId, interrupt() {} };
      },
    };
    configureRunServiceForTests({ claude: capture, codex: capture, simulated: capture });

    const { runId } = await startRun(store.db, {
      projectSlug: store.slug, taskKey: "VIB-1", role: "Primary specialist", kind: "primary",
      backend: "claude", model: "m", prompt: "go", dataRoot: store.dataRoot,
    });
    await settle();

    const resumed = await resumeRun(store.db, {
      runId,
      prompt: "follow up",
      disallowedTools: ["Bash(gh pr merge:*)", "Edit"],
      env: { GIT_CEILING_DIRECTORIES: "/data/projects/x/tasks/VIB-1" },
      mcpServers: { viberr: { type: "sdk" } },
      systemPrompt: "You are the Developer.",
      dataRoot: store.dataRoot,
    });
    await settle();

    const resumeSpec = specs.find((s) => s.runId === resumed.runId)!;
    expect(resumeSpec.disallowedTools).toEqual(["Bash(gh pr merge:*)", "Edit"]);
    expect(resumeSpec.env?.GIT_CEILING_DIRECTORIES).toBe(
      "/data/projects/x/tasks/VIB-1",
    );
    expect(resumeSpec.mcpServers).toEqual({ viberr: { type: "sdk" } });
    expect(resumeSpec.systemPrompt).toBe("You are the Developer.");
  });
});
