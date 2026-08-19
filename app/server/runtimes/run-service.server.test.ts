import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { createTestDbContext, type TestDbContext } from "../../../test-support/test-db";
import { setupTestStore, writeTask, baseTaskFrontmatter, type TestStore } from "../../../test-support/test-store";
import { AppError } from "~/server/errors/app-error.server";
import { listAuditEvents } from "../../../test-support/audit-log";
import {
  backendUnavailableMessage,
  chainRunCompletion,
  configureRunServiceForTests,
  getRunLog,
  interruptRun,
  listRunsForTask,
  registerRunCompletion,
  repoWriteWithheldFromDenylist,
  resumeRun,
  startRun,
} from "./run-service.server";
import { getRun, listRunLines } from "./run-store.server";
import { resetSseBrokerForTests } from "~/server/events/sse-broker.server";
import type { LogLine } from "~/features/runtime/runtime-types";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { RunSpec, RuntimeAdapter } from "./adapter.server";
import { setBackendAvailability, type AdapterSet } from "./runtime-registry.server";
import {
  installFakeRuntime,
  queueFakeRun,
  type FakeRun,
} from "../../../test-support/fake-runtime";

// SAFETY: stands in for a live `createSdkMcpServer(...)` config. The tests
// mounting it assert how the service ROUTES the dictionary — key-derived
// auto-approval and verbatim carry onto the resumed spec — through capture
// adapters that never connect, so the instance-bearing fields are never
// dereferenced and the toEqual fixtures stay byte-identical.
const sdkServerStub = { type: "sdk" } as McpSdkServerConfigWithInstance;
/** A portable stdio mount, shaped as `resolveSpecialistMcpServers` builds it. */
const stdioServerStub = { command: "npx", args: ["-y", "example-mcp"] };

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
  installFakeRuntime();
});

afterEach(() => {
  resetSseBrokerForTests();
  ctx.cleanup();
});

function instantScript(lines: LogLine[], backend: "claude" | "codex" = "claude"): FakeRun {
  return {
    lines,
    occurredAt: lines.map(() => new Date().toISOString()),
    sessionId: "sess-test",
    backend,
    keepRunning: false,
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0));
}

type TestRunInput = Omit<Parameters<typeof startRun>[1], "agentProfileId"> & {
  agentProfileId?: string;
};

function startTestRun(
  db: Parameters<typeof startRun>[0],
  input: TestRunInput,
): ReturnType<typeof startRun> {
  const agentProfileId =
    input.agentProfileId ??
    (input.kind === "operator"
      ? "operator"
      : input.kind === "reviewer"
        ? "reviewer"
        : "developer");
  return startRun(db, { ...input, agentProfileId });
}

describe("run-service lifecycle", () => {
  it("startRun materializes a run + persists lines + reaches finished", async () => {
    const script = instantScript([
      { t: "1", ev: "init", tag: "system·init", text: "session x" },
      { t: "2", ev: "text", tag: "assistant", text: "hello" },
      { t: "3", ev: "result", tag: "result", text: "done", stats: { dur: 100, api: 90, turns: 2, cost: 0.1, in: 5, cached: 2, out: 3 } },
    ]);
    queueFakeRun(script);
    const { runId } = await startTestRun(store.db, {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      role: "Primary specialist",
      kind: "primary",
      backend: "claude",
      model: "claude-sonnet-4-5",
      prompt: "go",
      dataRoot: store.dataRoot,
    });
    await settle();

    const run = getRun(store.db, runId)!;
    expect(run.state).toBe("finished");
    expect(run.backend).toBe("claude");
    const lines = listRunLines(store.db, runId);
    expect(lines.length).toBe(3);
    // Tokens/cost derived from the REAL result envelope, not fabricated.
    expect(run.total_cost_usd).toBe(0.1);
    expect(run.output_tokens).toBe(3);
  });

  it("F10-05: a second concurrent delivering run is rejected atomically (409)", async () => {
    const script = instantScript([
      { t: "1", ev: "init", tag: "system·init", text: "session" },
    ]);
    queueFakeRun(script);
    const primary = {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      role: "Primary specialist",
      kind: "primary" as const,
      backend: "claude" as const,
      model: "claude-sonnet-4-5",
      prompt: "go",
      dataRoot: store.dataRoot,
    };
    // First delivering run — left in flight (NOT settled), so its row is still
    // queued/running when the second dispatch races in.
    const first = await startTestRun(store.db, primary);
    expect(first.runId).toBeTruthy();

    // A second delivering start for the SAME task must 409 (partial unique index
    // idx_agent_runs__one_delivering) — this is the atomic guard behind the
    // service's preflight check.
    await expect(startTestRun(store.db, { ...primary, prompt: "go2" })).rejects.toMatchObject({
      status: 409,
    });

    // A reviewer (supporting) run for the same task is NOT constrained.
    const reviewer = await startTestRun(store.db, {
      ...primary,
      role: "Reviewer",
      kind: "reviewer",
      prompt: "review",
    });
    expect(reviewer.runId).toBeTruthy();
    await settle();
  });

  it("a run settling after the DB closed logs instead of throwing (teardown race)", async () => {
    const script = instantScript([
      { t: "1", ev: "init", tag: "system·init", text: "session x" },
      { t: "2", ev: "text", tag: "assistant", text: "hello" },
      { t: "3", ev: "result", tag: "result", text: "done" },
    ]);
    queueFakeRun(script);
    const { runId } = await startTestRun(store.db, {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      role: "Primary specialist",
      kind: "primary",
      backend: "claude",
      model: "claude-sonnet-4-5",
      prompt: "go",
      dataRoot: store.dataRoot,
    });
    // The CI teardown race: a test's DB closes while the adapter's timers are
    // still driving lines + the exit. Every sink write inside an adapter
    // callback must be caught-and-logged — an uncaught throw on a timer is an
    // unhandled error that fails the whole suite (vitest "Errors: 1 error")
    // even with every test green. (cleanup() tolerates the early close.)
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
    queueFakeRun(script);
    const { runId } = await startTestRun(store.db, {
      projectSlug: store.slug, taskKey: "VIB-1", role: "R", kind: "primary",
      backend: "claude", model: "m", prompt: "go", dataRoot: store.dataRoot,
    });
    await settle();
    const run = getRun(store.db, runId)!;
    expect(run.input_tokens).toBe(0);
    expect(run.output_tokens).toBe(0);
    expect(run.total_cost_usd).toBeNull();
  });

  it("listRunsForTask returns a RunView with derived render state + raw envelopes", async () => {
    queueFakeRun(
      instantScript(
        [{ t: "1", ev: "init", tag: "thread.started", text: "thread x" }, { t: "2", ev: "result", tag: "turn.completed", text: "done", usage: { input_tokens: 5, cached_input_tokens: 2, output_tokens: 3 } }],
        "codex",
      ),
      "codex",
    );
    const { runId } = await startTestRun(store.db, {
      projectSlug: store.slug, taskKey: "VIB-1", role: "Primary specialist", kind: "primary",
      backend: "codex", model: "gpt-5.4-codex", prompt: "go",
      dataRoot: store.dataRoot,
    });
    await settle();
    const runs = listRunsForTask(store.db, store.slug, "VIB-1");
    const run = runs.find((r) => r.serverRunId === runId)!;
    expect(run.state).toBe("done");
    expect(run.backend).toBe("codex");
    expect(run.raw.length).toBe(run.lines.length);
    expect(JSON.parse(run.raw[0]!).line.ev).toBe("init");
  });

  it("getRunLog tails lines since a seq", async () => {
    queueFakeRun(instantScript([
      { t: "1", ev: "text", tag: "assistant", text: "a" },
      { t: "2", ev: "text", tag: "assistant", text: "b" },
      { t: "3", ev: "text", tag: "assistant", text: "c" },
    ]));
    const { runId } = await startTestRun(store.db, {
      projectSlug: store.slug, taskKey: "VIB-1", role: "R", kind: "primary",
      backend: "claude", model: "m", prompt: "go",
      dataRoot: store.dataRoot,
    });
    await settle();
    const tail = getRunLog(store.db, runId, { since: 0 })!;
    expect(tail.lines.map((l) => l.display.text)).toEqual(["b", "c"]);
    expect(tail.headSeq).toBe(2);
  });

  it("forwards input.effort onto the RunSpec handed to the adapter", async () => {
    const specs: RunSpec[] = [];
    const capture: RuntimeAdapter = {
      backend: "claude",
      start(spec, cb) {
        specs.push(spec);
        cb.onExit({ outcome: "finished", effectiveBackend: "claude", sessionId: null });
        return { runId: spec.runId, interrupt() {} };
      },
    };
    const adapters: AdapterSet = { claude: capture, codex: capture };
    configureRunServiceForTests(adapters);

    await startTestRun(store.db, {
      projectSlug: store.slug, taskKey: "VIB-1", role: "R", kind: "primary",
      backend: "claude", model: "sonnet", effort: "xhigh", prompt: "go",
      dataRoot: store.dataRoot,
    });
    await settle();
    expect(specs[0]?.effort).toBe("xhigh");
    expect(specs[0]?.model).toBe("sonnet");

    // Omitting effort leaves spec.effort undefined (SDK default applies).
    await startTestRun(store.db, {
      projectSlug: store.slug, taskKey: "VIB-1", threadId: "t2", role: "R", kind: "primary",
      backend: "claude", model: "sonnet", prompt: "go", dataRoot: store.dataRoot,
    });
    await settle();
    expect(specs[1]?.effort).toBeUndefined();
  });
});

describe("unavailable backend", () => {
  async function startUnavailable() {
    setBackendAvailability("claude", false);
    return startTestRun(store.db, {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      role: "Primary specialist",
      kind: "primary",
      backend: "claude",
      model: "claude-sonnet-4-5",
      prompt: "go",
      dataRoot: store.dataRoot,
    });
  }

  it("startRun finalizes an unavailable backend as a classified error", async () => {
    const { runId } = await startUnavailable();
    const run = getRun(store.db, runId)!;
    expect(run.state).toBe("error"); // fail-fast: terminal synchronously
    expect(run.backend).toBe("claude");
    const lines = listRunLines(store.db, runId);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.display.ev).toBe("err");
    // The copy is actionable and classifies as the "unavailable" failure class.
    expect(lines[0]!.display.text).toContain("no usable credential");
    expect(lines[0]!.display.text).toContain("ANTHROPIC_API_KEY");
    const { runFailureReason } = await import("~/server/tasks/agent-reply.server");
    expect(runFailureReason(store.db, runId)?.kind).toBe("unavailable");
  });

  it("a completion callback registered after the fail-fast still fires (F8 escalation path)", async () => {
    const { runId } = await startUnavailable();
    let fired: string | null = null;
    registerRunCompletion(runId, (finished) => { fired = finished.state; }, store.db);
    expect(fired).toBe("error");
  });

  it("audits runtime.run.started with the failedUnavailable marker", async () => {
    await startUnavailable();
    const audits = listAuditEvents(store.db, { action: "runtime.run.started" });
    expect(audits.length).toBe(1);
    expect(audits[0]!.details).toMatchObject({
      backend: "claude",
      failedUnavailable: true,
    });
  });

});

describe("completion callbacks — already-terminal race (F-SPAWN2)", () => {
  // An adapter that finalizes SYNCHRONOUSLY inside start() models a run that
  // crashes at spawn (spawn EBADF): its onExit fires — and finds no callback —
  // before the caller can attach one. The fix must fire the late callback.
  function instantExitAdapter(outcome: "finished" | "error"): RuntimeAdapter {
    return {
      backend: "claude",
      start(spec, cb) {
        cb.onExit({ outcome, effectiveBackend: "claude", sessionId: null });
        return { runId: spec.runId, interrupt() {} };
      },
    };
  }

  it("chainRunCompletion fires immediately when the run already finalized", async () => {
    const a = instantExitAdapter("error");
    configureRunServiceForTests({ claude: a, codex: a });
    const { runId } = await startTestRun(store.db, {
      projectSlug: store.slug, taskKey: "VIB-1", role: "Operator", kind: "operator",
      backend: "claude", model: "sonnet", prompt: "go", dataRoot: store.dataRoot,
    });
    // At this point the run is already `error` and has no live handle.
    expect(getRun(store.db, runId)?.state).toBe("error");
    let fired: string | null = null;
    chainRunCompletion(runId, (f) => { fired = f.state; }, store.db);
    expect(fired).toBe("error");
  });

  it("registerRunCompletion fires immediately when the run already finalized", async () => {
    const a = instantExitAdapter("finished");
    configureRunServiceForTests({ claude: a, codex: a });
    const { runId } = await startTestRun(store.db, {
      projectSlug: store.slug, taskKey: "VIB-1", role: "R", kind: "primary",
      backend: "claude", model: "sonnet", prompt: "go", dataRoot: store.dataRoot,
    });
    let count = 0;
    registerRunCompletion(runId, () => { count += 1; }, store.db);
    expect(count).toBe(1);
    // Not double-fired: the callback was consumed on immediate fire.
    expect(count).toBe(1);
  });

  it("does not fire twice when the run is still in flight then finishes", async () => {
    queueFakeRun({
      lines: [{ t: "1", ev: "text", tag: "assistant", text: "a" }],
      occurredAt: [new Date().toISOString()],
      sessionId: "s",
    });
    const { runId } = await startTestRun(store.db, {
      projectSlug: store.slug, taskKey: "VIB-1", role: "R", kind: "primary",
      backend: "claude", model: "sonnet", prompt: "go",
      dataRoot: store.dataRoot,
    });
    let count = 0;
    registerRunCompletion(runId, () => { count += 1; }, store.db);
    await settle();
    expect(count).toBe(1);
  });
});

describe("interruptRun — RBAC + audit + idempotency", () => {
  async function startRunning() {
    queueFakeRun({
      lines: [{ t: "1", ev: "text", tag: "assistant", text: "working" }],
      sessionId: "s",
      keepRunning: true,
    });
    const { runId } = await startTestRun(store.db, {
      projectSlug: store.slug, taskKey: "VIB-1", role: "R", kind: "primary",
      backend: "claude", model: "m", prompt: "go", dataRoot: store.dataRoot,
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

  // P14-RT-11: the response view matched `RunView.id === run.thread_id`, but a
  // group's id is its REPRESENTATIVE's thread id — so interrupting any older run
  // of a resumed agent fell through to `projectRunsForTask(...)[0]!` and
  // returned an unrelated group's view (and threw outright on an empty one).
  it("returns THIS run's group, not the first group, for a non-representative run", async () => {
    // Group 1: the operator. It is created first, so it is `[0]` — what the
    // broken fallback returned for everything.
    await startTestRun(store.db, {
      projectSlug: store.slug, taskKey: "VIB-1", threadId: "op-1", role: "Operator",
      kind: "operator", backend: "claude", model: "m", prompt: "go", dataRoot: store.dataRoot,
    });
    await settle();
    // Group 2: one agent, two runs — the newer one is the representative.
    const older = await startTestRun(store.db, {
      projectSlug: store.slug, taskKey: "VIB-1", threadId: "primary-a", role: "R",
      kind: "primary", backend: "claude", model: "m", agentProfileId: "dev",
      prompt: "go", dataRoot: store.dataRoot,
    });
    await settle();
    const newer = await startTestRun(store.db, {
      projectSlug: store.slug, taskKey: "VIB-1", threadId: "primary-b", role: "R",
      kind: "primary", backend: "claude", model: "m", agentProfileId: "dev",
      prompt: "go", dataRoot: store.dataRoot,
    });
    await settle();

    const result = interruptRun(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", runId: older.runId },
      { userId: store.users.arda.id, label: store.users.arda.email },
    );
    expect(result.outcome).toBe("already-terminal");
    expect(result.run).not.toBeNull();
    expect(result.run!.kind).toBe("primary");
    expect(result.run!.profileId).toBe("dev");
    // The group's identity is its representative — the NEWEST run of the agent.
    expect(result.run!.serverRunId).toBe(newer.runId);
  });

  it("interrupting a finished run is an idempotent no-op (not an error)", async () => {
    const { runId } = await startTestRun(store.db, {
      projectSlug: store.slug, taskKey: "VIB-1", role: "R", kind: "primary",
      backend: "claude", model: "m", prompt: "go",
      dataRoot: store.dataRoot,
    });
    await settle();
    expect(getRun(store.db, runId)!.state).toBe("finished");
    const result = interruptRun(store.db, { projectSlug: store.slug, taskKey: "VIB-1", runId }, { userId: store.users.arda.id, label: store.users.arda.email });
    expect(result.outcome).toBe("already-terminal");
    expect(getRun(store.db, runId)!.state).toBe("finished");
  });
});

describe("agent identity — startRun persists + resumeRun carries (BUG 2)", () => {
  it("startRun persists agent_name + agent_profile_id on the run row", async () => {
    const { runId } = await startTestRun(store.db, {
      projectSlug: store.slug, taskKey: "VIB-1", role: "Primary specialist", kind: "primary",
      backend: "claude", model: "m", agentName: "dev", agentProfileId: "dev", prompt: "go",
      dataRoot: store.dataRoot,
    });
    await settle();
    const row = getRun(store.db, runId)!;
    expect(row.agent_name).toBe("dev");
    expect(row.agent_profile_id).toBe("dev");
  });

  it("resumeRun carries the prior run's agent identity onto the new row by default", async () => {
    const { runId } = await startTestRun(store.db, {
      projectSlug: store.slug, taskKey: "VIB-1", role: "Primary specialist", kind: "primary",
      backend: "claude", model: "m", agentName: "dev", agentProfileId: "dev", prompt: "go",
      dataRoot: store.dataRoot,
    });
    await settle();

    const resumed = await resumeRun(store.db, {
      runId,
      prompt: "follow up",
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
  // / MCP set / persona — the resume path used to drop all of them. pass-18 adds
  // the native `skills` filter to that list: the workspace mount survives
  // between runs but the SDK options do not, and the persona built by the same
  // call already leaves a mounted skill's body out — so dropping it here would
  // strip the agent's granted craft mid-thread with nothing in its place.
  it("resumeRun forwards the run confinement (skills included) onto the resumed RunSpec", async () => {
    const specs: RunSpec[] = [];
    const capture: RuntimeAdapter = {
      backend: "claude",
      start(spec, cb) {
        specs.push(spec);
        cb.onExit({ outcome: "finished", effectiveBackend: "claude", sessionId: null });
        return { runId: spec.runId, interrupt() {} };
      },
    };
    configureRunServiceForTests({ claude: capture, codex: capture });

    const { runId } = await startTestRun(store.db, {
      projectSlug: store.slug, taskKey: "VIB-1", role: "Primary specialist", kind: "primary",
      backend: "claude", model: "m", prompt: "go", skills: ["conventional-commits"],
      dataRoot: store.dataRoot,
    });
    await settle();
    // The fresh run carries them too (the mount → SDK hand-off).
    expect(specs.find((s) => s.runId === runId)!.skills).toEqual([
      "conventional-commits",
    ]);

    const resumed = await resumeRun(store.db, {
      runId,
      prompt: "follow up",
      disallowedTools: ["Bash(gh pr merge:*)", "Edit"],
      skills: ["conventional-commits"],
      env: { GIT_CEILING_DIRECTORIES: "/data/projects/x/tasks/VIB-1" },
      mcpServers: { viberr: sdkServerStub },
      systemPrompt: "You are the Developer.",
      dataRoot: store.dataRoot,
    });
    await settle();

    const resumeSpec = specs.find((s) => s.runId === resumed.runId)!;
    expect(resumeSpec.disallowedTools).toEqual(["Bash(gh pr merge:*)", "Edit"]);
    expect(resumeSpec.skills).toEqual(["conventional-commits"]);
    expect(resumeSpec.env?.GIT_CEILING_DIRECTORIES).toBe(
      "/data/projects/x/tasks/VIB-1",
    );
    expect(resumeSpec.mcpServers).toEqual({ viberr: { type: "sdk" } });
    expect(resumeSpec.systemPrompt).toBe("You are the Developer.");
  });
});

/* ------------------------- D4: the tool APPROVAL list --------------------- */

describe("D4 — allowedTools reaches the run and survives a resume", () => {
  function captureAdapter(specs: RunSpec[]): RuntimeAdapter {
    return {
      backend: "claude",
      start(spec, cb) {
        specs.push(spec);
        cb.onExit({ outcome: "finished", effectiveBackend: "claude", sessionId: "sess-a" });
        return { runId: spec.runId, interrupt() {} };
      },
    };
  }

  // The specialist path passed NO allowedTools at all, so a granted org MCP and
  // the in-process collaboration toolkit (post_comment / ask_human /
  // report_outcome) were usable only because every run happens to be autonomous
  // ⇒ bypassPermissions. That made a permission MODE load-bearing for a
  // capability GRANT.
  it("auto-approves every mounted MCP server without the caller asking", async () => {
    const specs: RunSpec[] = [];
    configureRunServiceForTests({ claude: captureAdapter(specs), codex: captureAdapter(specs) });

    await startTestRun(store.db, {
      projectSlug: store.slug, taskKey: "VIB-1", role: "Primary specialist",
      kind: "primary", backend: "claude", model: "m", prompt: "go",
      mcpServers: { viberr_agent: sdkServerStub, everything: stdioServerStub },
      dataRoot: store.dataRoot,
    });
    await settle();

    expect(specs[0]?.allowedTools).toEqual(["mcp__viberr_agent", "mcp__everything"]);
  });

  // The operator lists its governance tools ONE BY ONE so the approval list
  // mirrors its capability policy — a blanket `mcp__viberr` would paper over it.
  it("leaves a server the caller curated per-tool alone", async () => {
    const specs: RunSpec[] = [];
    configureRunServiceForTests({ claude: captureAdapter(specs), codex: captureAdapter(specs) });

    await startTestRun(store.db, {
      projectSlug: store.slug, taskKey: "VIB-1", role: "Operator", kind: "operator",
      backend: "claude", model: "m", prompt: "go",
      mcpServers: { viberr: sdkServerStub, everything: stdioServerStub },
      allowedTools: ["mcp__viberr__post_comment", "mcp__viberr__open_packet"],
      dataRoot: store.dataRoot,
    });
    await settle();

    expect(specs[0]?.allowedTools).toEqual([
      "mcp__viberr__post_comment",
      "mcp__viberr__open_packet",
      "mcp__everything",
    ]);
  });

  it("carries the approval list — curated and derived — onto a resumed run", async () => {
    const specs: RunSpec[] = [];
    configureRunServiceForTests({ claude: captureAdapter(specs), codex: captureAdapter(specs) });

    const { runId } = await startTestRun(store.db, {
      projectSlug: store.slug, taskKey: "VIB-1", role: "Primary specialist",
      kind: "primary", backend: "claude", model: "m", prompt: "go",
      dataRoot: store.dataRoot,
    });
    await settle();

    const resumed = await resumeRun(store.db, {
      runId,
      prompt: "follow up",
      allowedTools: ["mcp__viberr__report_outcome"],
      mcpServers: { viberr_agent: sdkServerStub, everything: stdioServerStub },
      dataRoot: store.dataRoot,
    });
    await settle();

    // BEFORE: `resumeRun`'s input type had no `allowedTools` at all, so the
    // curated entry could not even be expressed, and nothing derived the
    // mounted servers' entries either.
    expect(specs.find((s) => s.runId === resumed.runId)!.allowedTools).toEqual([
      "mcp__viberr__report_outcome",
      "mcp__viberr_agent",
      "mcp__everything",
    ]);
  });
});

/* ---------------- runtime continuity recovery (P13-D-2 / FR22) ------------- */

describe("resumeRun — continuity recovery", () => {
  const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
  let claudeHome: string;

  beforeEach(async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = (await import("node:path")).default;
    claudeHome = mkdtempSync(path.join(tmpdir(), "viberr-continuity-"));
    process.env.CLAUDE_CONFIG_DIR = claudeHome;
    const { resetEnvCacheForTests } = await import("~/server/config/env.server");
    resetEnvCacheForTests();
  });

  afterEach(async () => {
    const { rmSync } = await import("node:fs");
    rmSync(claudeHome, { recursive: true, force: true });
    if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
    const { resetEnvCacheForTests } = await import("~/server/config/env.server");
    resetEnvCacheForTests();
  });

  /** Make `<CLAUDE_CONFIG_DIR>/projects` exist so absence is CONCLUSIVE. */
  async function withTranscriptStore(sid?: string): Promise<void> {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const path = (await import("node:path")).default;
    const projects = path.join(claudeHome, "projects", "-w-x");
    mkdirSync(projects, { recursive: true });
    if (sid) writeFileSync(path.join(projects, `${sid}.jsonl`), "{}\n");
  }

  /** Start a run, then resume it, capturing every RunSpec the adapter saw. */
  async function startThenResume(): Promise<{
    specs: RunSpec[];
    firstRunId: string;
    resume: (
      extra?: Partial<Parameters<typeof resumeRun>[1]>,
    ) => Promise<{ runId: string; continuityReset?: true }>;
  }> {
    const specs: RunSpec[] = [];
    const capture: RuntimeAdapter = {
      backend: "claude",
      start(spec, cb) {
        specs.push(spec);
        cb.onExit({
          outcome: "finished",
          effectiveBackend: "claude",
          sessionId: "sess-gone",
        });
        return { runId: spec.runId, interrupt() {} };
      },
    };
    configureRunServiceForTests({ claude: capture, codex: capture });
    const { runId } = await startTestRun(store.db, {
      projectSlug: store.slug, taskKey: "VIB-1", role: "Primary specialist",
      kind: "primary", backend: "claude", model: "m", agentName: "dev",
      agentProfileId: "dev", prompt: "go", dataRoot: store.dataRoot,
    });
    await settle();
    return {
      specs,
      firstRunId: runId,
      resume: (extra) =>
        resumeRun(store.db, {
          runId,
          prompt: "follow up",
          dataRoot: store.dataRoot,
          ...extra,
        }),
    };
  }

  it("retries the turn as a FRESH canonical-anchored run when the transcript is gone", async () => {
    const { specs, firstRunId, resume } = await startThenResume();
    expect(getRun(store.db, firstRunId)!.session_id).toBe("sess-gone");
    await withTranscriptStore(); // store exists, this session is NOT in it

    const resumed = await resume();
    await settle();

    // BEFORE: the dead id went straight to the SDK (`resumeSessionId:
    // prev.session_id`), the run failed as a generic "review its authentication
    // and runtime configuration", and the packet offered no recovery.
    expect(resumed.continuityReset).toBe(true);
    const spec = specs.find((s) => s.runId === resumed.runId)!;
    expect(spec.resumeSessionId).toBeNull();
    // …and the turn is re-anchored on the canonical artifact (PRD-1).
    expect(spec.prompt).toContain("[continuity notice]");
    expect(spec.prompt).toContain("task.md");
    expect(spec.prompt).toContain("follow up"); // the human's actual request

    // The DEAD run is stamped so it is never selected again (the stranding half).
    const marker = listRunLines(store.db, firstRunId).find(
      (l) => l.display.tag === "run·session_missing",
    );
    expect(marker).toBeDefined();
    expect(marker!.display.text).not.toMatch(/authentication|credential/i);
    const { runFailureReason } = await import("~/server/tasks/agent-reply.server");
    expect(runFailureReason(store.db, firstRunId)?.kind).toBe("session_missing");

    // …and the timeline says what happened, in plain words.
    const { readTaskFile } = await import("~/server/files/task-writer.server");
    const timeline = readTaskFile({
      projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot,
    })!.parsed.timeline;
    const note = timeline.find((e) => e.text.includes("continuity was lost"));
    expect(note).toBeDefined();
    // G8: a WARNING-toned typed `continuity` event (amber), NOT a neutral
    // `note` that a scanning supervisor never sees. It is a typed event, so it
    // survives the "Important events" filter and is never folded by compaction.
    expect(note!.type).toBe("continuity");
    expect(note!.text).toContain("task.md");
  });

  // D5: `rawLogPath` documented a `<sessionOrRunId>` key — "the provider session
  // id when known, else the run id" — that no caller has ever produced. The CODE
  // is the honest half and this pins it: a resume SHARES the provider session id
  // with its parent, so keying the raw .jsonl by session would interleave two
  // runs' envelopes into one file. The session-missing marker is written by the
  // one caller the docstring most implicated (run-service, not the sink).
  it("keys the raw transcript by RUN id — never by the shared session id", async () => {
    const { existsSync, readFileSync, rmSync } = await import("node:fs");
    const { rawLogPath } = await import("./run-store.server");
    const { firstRunId, resume } = await startThenResume();
    // Raw transcripts live under the AMBIENT data root, which outlives the test
    // db — clear the session-keyed name so a stale file can't fake the verdict.
    rmSync(rawLogPath("claude", "sess-gone"), { force: true });
    await withTranscriptStore(); // the session is gone

    await resume();
    await settle();

    const perRun = rawLogPath("claude", firstRunId);
    expect(readFileSync(perRun, "utf8")).toContain("session_missing");
    expect(existsSync(rawLogPath("claude", "sess-gone"))).toBe(false);
  });

  // D4: the continuity reset re-enters `startRun` by hand, so every field the
  // resume carries has to be listed there a SECOND time — the approval list was
  // the one that wasn't, which would have stripped the toolkit from exactly the
  // run that just lost its session and needs to report what happened.
  it("keeps the tool approval list across a continuity reset", async () => {
    const { specs, resume } = await startThenResume();
    await withTranscriptStore(); // the session is gone

    const resumed = await resume({
      allowedTools: ["mcp__viberr__report_outcome"],
      mcpServers: { viberr_agent: sdkServerStub },
    });
    await settle();

    expect(resumed.continuityReset).toBe(true);
    expect(specs.find((s) => s.runId === resumed.runId)!.allowedTools).toEqual([
      "mcp__viberr__report_outcome",
      "mcp__viberr_agent",
    ]);
  });

  it("resumes normally when the transcript is still there", async () => {
    const { specs, resume } = await startThenResume();
    await withTranscriptStore("sess-gone"); // …it is not gone after all
    const resumed = await resume();
    await settle();
    expect(resumed.continuityReset).toBeUndefined();
    const spec = specs.find((s) => s.runId === resumed.runId)!;
    expect(spec.resumeSessionId).toBe("sess-gone");
    expect(spec.prompt).toBe("follow up");
  });

  it("resumes normally when there is NO transcript store to look in (unknown)", async () => {
    // No `<config>/projects` dir at all. Absence proves nothing here, and
    // treating it as "gone" would throw away every live session on any
    // deployment whose transcripts this process cannot see.
    const { specs, firstRunId, resume } = await startThenResume();
    const resumed = await resume();
    await settle();
    expect(resumed.continuityReset).toBeUndefined();
    expect(specs.find((s) => s.runId === resumed.runId)!.resumeSessionId).toBe(
      "sess-gone",
    );
    expect(
      listRunLines(store.db, firstRunId).some(
        (l) => l.display.tag === "run·session_missing",
      ),
    ).toBe(false);
  });
});

/* -------------- backward paging for the console (P13-D-11) ---------------- */

describe("getRunLog paging", () => {
  async function runWithLines(count: number): Promise<string> {
    queueFakeRun(
      instantScript(
        Array.from({ length: count }, (_, i) => ({
          t: String(i),
          ev: "text" as const,
          tag: "assistant",
          text: `l${i}`,
        })),
      ),
    );
    const { runId } = await startTestRun(store.db, {
      projectSlug: store.slug, taskKey: "VIB-1", role: "R", kind: "primary",
      backend: "claude", model: "m", prompt: "go", dataRoot: store.dataRoot,
    });
    await settle();
    return runId;
  }

  it("pages BACKWARDS from a cursor, newest-first, oldest-first within the page", async () => {
    const runId = await runWithLines(10);
    // The loader shipped the tail; the console asks for what came before seq 7.
    const page = getRunLog(store.db, runId, { before: 7, limit: 3 })!;
    expect(page.lines.map((l) => l.display.text)).toEqual(["l4", "l5", "l6"]);
    expect(page.oldestSeq).toBe(4);
    expect(page.hasMore).toBe(true); // seq 0..3 are still older

    const older = getRunLog(store.db, runId, { before: page.oldestSeq, limit: 10 })!;
    expect(older.lines.map((l) => l.display.text)).toEqual(["l0", "l1", "l2", "l3"]);
    // Reached the start of this run — the console steps to the PREVIOUS run id
    // in the group's logWindow.runIds from here.
    expect(older.hasMore).toBe(false);
  });

  it("a bare `limit` pages a run's newest lines (how the console enters an older run)", async () => {
    const runId = await runWithLines(10);
    const page = getRunLog(store.db, runId, { limit: 2 })!;
    expect(page.lines.map((l) => l.display.text)).toEqual(["l8", "l9"]);
    expect(page.hasMore).toBe(true);
  });

  it("keeps the forward `since` tail working unchanged", async () => {
    const runId = await runWithLines(4);
    const tail = getRunLog(store.db, runId, { since: 1 })!;
    expect(tail.lines.map((l) => l.display.text)).toEqual(["l2", "l3"]);
    expect(tail.headSeq).toBe(3);
    expect(tail.hasMore).toBe(true); // seq 0..1 exist below this page
  });
});

describe("backendUnavailableMessage — state-aware codex copy", () => {
  const cleanupDirs: string[] = [];
  afterEach(async () => {
    delete process.env.VIBERR_CODEX_USE_CLI_AUTH;
    delete process.env.CODEX_HOME;
    const { rmSync } = await import("node:fs");
    for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("names the missing auth.json + the docker copy command when the CLI-auth opt-in IS set", async () => {
    // The docker volume-wipe trap: flag on (from .env), file gone. Re-suggesting
    // the flag the user already set is what made the breakage look mysterious.
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = (await import("node:path")).default;
    const home = mkdtempSync(path.join(tmpdir(), "viberr-codex-msg-"));
    cleanupDirs.push(home);
    process.env.VIBERR_CODEX_USE_CLI_AUTH = "1";
    process.env.CODEX_HOME = home; // empty — no auth.json
    const msg = backendUnavailableMessage("codex");
    expect(msg).toContain(`missing at ${path.join(home, "auth.json")}`);
    expect(msg).toContain("docker compose cp");
    expect(msg).toContain("without a restart");
    expect(msg).not.toContain("opt in with VIBERR_CODEX_USE_CLI_AUTH"); // flag is already set
  });

  it("keeps the generic no-credential copy when the opt-in is NOT set", () => {
    const msg = backendUnavailableMessage("codex");
    expect(msg).toContain("no usable credential");
    expect(msg).toContain("opt in with VIBERR_CODEX_USE_CLI_AUTH=1");
  });
});

describe("repoWriteWithheldFromDenylist (P13-RT-02)", () => {
  it("recognises exactly the denylist a withheld repo-write grant produces", () => {
    // The rule set is specialist-tool-policy's `execute-code-or-write-repo`
    // entry. It is computed for EVERY run backend-agnostically — it just had no
    // effect on Codex, which has no denylist channel.
    expect(
      repoWriteWithheldFromDenylist([
        "Edit",
        "MultiEdit",
        "Write",
        "NotebookEdit",
        "Bash(git commit:*)",
      ]),
    ).toBe(true);
  });

  it("does not fire for the narrower delivery capabilities", () => {
    // Withholding branch/push/PR must NOT make the whole workspace read-only:
    // the agent still has to be able to edit files and run its validation.
    expect(
      repoWriteWithheldFromDenylist([
        "Bash(git push:*)",
        "Bash(git commit:*)",
        "Bash(gh pr create:*)",
        "Bash(git checkout -b:*)",
      ]),
    ).toBe(false);
    expect(repoWriteWithheldFromDenylist([])).toBe(false);
    expect(repoWriteWithheldFromDenylist(undefined)).toBe(false);
  });
});

describe("startRun spec derivation (P13-RT-02 / P13-RT-08)", () => {
  function captureSpecs() {
    const specs: RunSpec[] = [];
    const capture: RuntimeAdapter = {
      backend: "claude",
      start(spec, cb) {
        specs.push(spec);
        cb.onExit({ outcome: "finished", effectiveBackend: spec.backend, sessionId: null });
        return { runId: spec.runId, interrupt() {} };
      },
    };
    configureRunServiceForTests({ claude: capture, codex: capture });
    return { specs };
  }

  it("marks repoWriteWithheld from the capability denylist so Codex can enforce it", async () => {
    const { specs } = captureSpecs();
    await startTestRun(store.db, {
      projectSlug: store.slug, taskKey: "VIB-1", role: "R", kind: "primary",
      backend: "codex", model: "gpt-5.6-sol", prompt: "go", dataRoot: store.dataRoot,
      disallowedTools: ["Edit", "MultiEdit", "Write", "NotebookEdit", "Bash(git commit:*)"],
    });
    await settle();
    expect(specs[0]?.repoWriteWithheld).toBe(true);

    await startTestRun(store.db, {
      projectSlug: store.slug, taskKey: "VIB-1", threadId: "t-granted", role: "R", kind: "primary",
      backend: "codex", model: "gpt-5.6-sol", prompt: "go", dataRoot: store.dataRoot,
      disallowedTools: ["Bash(gh pr merge:*)"],
    });
    await settle();
    expect(specs[1]?.repoWriteWithheld).toBeUndefined();
  });

  // P14-RT-06: the web-egress grant travels the same way, so a Codex specialist
  // finally enforces it (webSearchMode) instead of only Claude.
  it("marks webSearchWithheld from the capability denylist", async () => {
    const { specs } = captureSpecs();
    await startTestRun(store.db, {
      projectSlug: store.slug, taskKey: "VIB-1", role: "R", kind: "primary",
      backend: "codex", model: "gpt-5.6-sol", prompt: "go", dataRoot: store.dataRoot,
      disallowedTools: ["WebFetch", "WebSearch"],
    });
    await settle();
    expect(specs[0]?.webSearchWithheld).toBe(true);

    // Withholding repo write must not silently take web egress with it — the
    // two capabilities are separate rows in the matrix.
    await startTestRun(store.db, {
      projectSlug: store.slug, taskKey: "VIB-1", threadId: "t-web-ok", role: "R", kind: "primary",
      backend: "codex", model: "gpt-5.6-sol", prompt: "go", dataRoot: store.dataRoot,
      disallowedTools: ["Edit", "MultiEdit", "Write", "NotebookEdit"],
    });
    await settle();
    expect(specs[1]?.webSearchWithheld).toBeUndefined();
  });

  it("an explicit caller value wins over the derivation", async () => {
    const { specs } = captureSpecs();
    await startTestRun(store.db, {
      projectSlug: store.slug, taskKey: "VIB-1", role: "R", kind: "primary",
      backend: "codex", model: "gpt-5.6-sol", prompt: "go", dataRoot: store.dataRoot,
      repoWriteWithheld: true,
    });
    await settle();
    expect(specs[0]?.repoWriteWithheld).toBe(true);
  });

  it("normalizes a stored effort from the OTHER backend's tier scale", async () => {
    const { specs } = captureSpecs();
    // "minimal" is a Codex tier; a profile switched to Claude keeps it stored.
    // Before, this shipped verbatim into an SDK union that has no such value.
    await startTestRun(store.db, {
      projectSlug: store.slug, taskKey: "VIB-1", role: "R", kind: "primary",
      backend: "claude", model: "sonnet", effort: "minimal", prompt: "go",
      dataRoot: store.dataRoot,
    });
    await settle();
    expect(specs[0]?.effort).toBe("low");

    // "max" is a Claude-only tier; a Codex run gets the nearest Codex tier.
    await startTestRun(store.db, {
      projectSlug: store.slug, taskKey: "VIB-1", threadId: "t-codex", role: "R", kind: "primary",
      backend: "codex", model: "gpt-5.6-sol", effort: "max", prompt: "go",
      dataRoot: store.dataRoot,
    });
    await settle();
    expect(specs[1]?.effort).toBe("xhigh");

    // A valid same-backend tier is untouched; an unset one stays unset.
    await startTestRun(store.db, {
      projectSlug: store.slug, taskKey: "VIB-1", threadId: "t-ok", role: "R", kind: "primary",
      backend: "claude", model: "sonnet", effort: "xhigh", prompt: "go",
      dataRoot: store.dataRoot,
    });
    await settle();
    expect(specs[2]?.effort).toBe("xhigh");
  });
});
