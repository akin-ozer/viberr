import { chmodSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setMaxRunSpendUsd } from "~/server/settings/instance-settings.server";
import { AGENT_UID_FLOOR, resetAgentIsolationForTests } from "./agent-isolation.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { closeDb, shutdownDatabase } from "~/server/db/sqlite.server";
import { logger } from "~/server/logging/logger.server";
import { createTestDbContext, type TestDbContext } from "../../../test-support/test-db";
import { setupTestStore, writeTask, baseTaskFrontmatter, type TestStore } from "../../../test-support/test-store";
import { AppError } from "~/server/errors/app-error.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import { listAuditEvents } from "../../../test-support/audit-log";
import {
  backendUnavailableMessage,
  chainRunCompletion,
  configureRunServiceForTests,
  getRunLog,
  interruptRun,
  listRunsForTask,
  MODEL_SUBSTITUTED_TAG,
  noteCompletionEffectsLost,
  registerRunAnswered,
  registerRunCompletion,
  repoWriteWithheldFromDenylist,
  reserveRun,
  resumeRun,
  startRun,
} from "./run-service.server";
import * as runServiceModule from "./run-service.server";
import {
  getRun,
  insertRunLine,
  listRunLines,
  listRunsForTaskRows,
  upsertRun,
  patchRun,
} from "./run-store.server";
import { defaultModelFor } from "./model-catalog.server";
import { RUN_PHASE } from "./adapter.server";
import { resetSseBrokerForTests } from "~/server/events/sse-broker.server";
import type { LogLine } from "~/features/runtime/runtime-types";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { RunCallbacks, RunSpec, RuntimeAdapter } from "./adapter.server";
import type { AdapterSet } from "./runtime-registry.server";
import {
  connectFakeBackend,
  disconnectFakeBackend,
  fakeBackendSecret,
} from "../../../test-support/backend-credentials";
import {
  compactedRunSpecs,
  installFakeRuntime,
  lastRunSpec,
  queueFakeCompaction,
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

beforeEach(async () => {
  ctx = createTestDbContext();
  store = setupTestStore(ctx);
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-1", { stage: "impl", ownerUserId: store.users.arda.id }),
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
  resetSseBrokerForTests();
  installFakeRuntime();
  // Ruling 127: a run bills a PERSON, so "this backend can run" is a fact about
  // the principal. Arda owns VIB-1 in this file and is every run's principal
  // unless a test says otherwise; connecting both backends for him is the
  // ordinary state of somebody using the product.
  await connectFakeBackend(store.db, store.users.arda.id, "claude");
  await connectFakeBackend(store.db, store.users.arda.id, "codex");
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

type TestRunInput = Omit<
  Parameters<typeof startRun>[1],
  "agentProfileId" | "credentialUserId"
> & {
  agentProfileId?: string;
  /** Ruling 127: defaults to arda, VIB-1's owner. Pass `null` for the refused
   *  run these tests exercise separately. */
  credentialUserId?: string | null;
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
  const credentialUserId =
    input.credentialUserId === undefined
      ? store.users.arda.id
      : input.credentialUserId;
  return startRun(db, { ...input, agentProfileId, credentialUserId });
}

/** The `event_msg` payload fields the Codex rollout reader looks at (ruling 414). */
interface RolloutEventPayload {
  type: string;
  turn_id?: string;
  item?: { type: string; id: string };
  info?: {
    last_token_usage: { input_tokens: number; cached_input_tokens: number; total_tokens: number };
  };
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
    // keepRunning — the first run must still be LIVE when the second insert
    // lands, or the partial index has nothing to enforce. (Hunt 2026-08-29:
    // without it the fake run finished on a microtask, and this test's 409 was
    // really the THREAD-uniqueness index firing on a shared default thread —
    // the column-discriminating translator exposed the rotten pin.)
    queueFakeRun({
      lines: [{ t: "1", ev: "init", tag: "system·init", text: "session" }],
      sessionId: "sess-test",
      keepRunning: true,
    });
    const primary = {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      role: "Primary specialist",
      kind: "primary" as const,
      backend: "claude" as const,
      model: "claude-sonnet-4-5",
      prompt: "go",
      // Real dispatches mint a distinct thread per run (`primary-…` suffixed),
      // so the SINGLE-FLIGHT index is what a race actually hits — a shared
      // default thread id would trip the thread-uniqueness index instead and
      // test the wrong guard (hunt 2026-08-29: the translator now tells the
      // two apart by the violated columns).
      threadId: "primary-a",
      dataRoot: store.dataRoot,
    };
    // First delivering run — left in flight (NOT settled), so its row is still
    // queued/running when the second dispatch races in.
    const first = await startTestRun(store.db, primary);
    expect(first.runId).toBeTruthy();

    // A second delivering start for the SAME task must 409 (partial unique index
    // idx_agent_runs__one_delivering) — this is the atomic guard behind the
    // service's preflight check.
    await expect(
      startTestRun(store.db, { ...primary, prompt: "go2", threadId: "primary-b" }),
    ).rejects.toMatchObject({
      status: 409,
    });

    // A reviewer (supporting) run for the same task is NOT constrained.
    queueFakeRun(
      instantScript([{ t: "1", ev: "init", tag: "system·init", text: "s2" }]),
    );
    const reviewer = await startTestRun(store.db, {
      ...primary,
      role: "Reviewer",
      kind: "reviewer",
      prompt: "review",
      threadId: "r0-a",
    });
    expect(reviewer.runId).toBeTruthy();
    await interruptRun(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot, runId: first.runId },
      { userId: store.users.arda.id, label: store.users.arda.email },
    );
    await settle();
  });

  it("hunt 2026-08-29: a second concurrent SUPPORTING run of the same profile is rejected atomically (409)", async () => {
    // P8 gave each supporting engagement one destructively re-cloned checkout,
    // so two live runs of the same profile are exactly as unsafe as two
    // delivering runs — the second clone rm-rfs the first run's working tree
    // mid-run. The JS preflight in dispatchAgentRun has the identical
    // check-then-await window F10-05 closed for primary; this pins its DB
    // backstop (idx_agent_runs__one_live_per_support).
    queueFakeRun({
      lines: [{ t: "1", ev: "init", tag: "system·init", text: "session" }],
      sessionId: "sess-test",
      keepRunning: true,
    });
    const supporting = {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      role: "Reviewer",
      kind: "reviewer" as const,
      backend: "claude" as const,
      model: "claude-sonnet-4-5",
      prompt: "review",
      agentProfileId: "rev",
      // Distinct threads per dispatch, as the real thread naming mints them —
      // the SUPPORT single-flight index is the guard under test.
      threadId: "r0-a",
      dataRoot: store.dataRoot,
    };
    const first = await startTestRun(store.db, supporting);
    expect(first.runId).toBeTruthy();
    await expect(
      startTestRun(store.db, { ...supporting, prompt: "review again", threadId: "r0-b" }),
    ).rejects.toMatchObject({ status: 409 });
    // A DIFFERENT supporting profile still runs concurrently — the profile id
    // is in the index key, so per-agent isolation is exactly what survives.
    queueFakeRun(
      instantScript([{ t: "1", ev: "init", tag: "system·init", text: "s2" }]),
    );
    const other = await startTestRun(store.db, {
      ...supporting,
      agentProfileId: "qa",
      prompt: "verify",
      threadId: "r1-a",
    });
    expect(other.runId).toBeTruthy();
    await interruptRun(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot, runId: first.runId },
      { userId: store.users.arda.id, label: store.users.arda.email },
    );
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

describe("a run with no credential principal (ruling 127)", () => {
  /** The owner has not connected the backend — the ordinary refusal. */
  async function startWithoutCredential() {
    await disconnectFakeBackend(store.db, store.users.arda.id, "claude");
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
  const startUnavailable = startWithoutCredential;

  it("startRun finalizes a principal with no credential as a classified error", async () => {
    const { runId } = await startUnavailable();
    const run = getRun(store.db, runId)!;
    expect(run.state).toBe("error"); // fail-fast: terminal synchronously
    expect(run.backend).toBe("claude");
    // The principal IS recorded: the run knows whose account it tried to bill,
    // which is what makes the refusal auditable rather than anonymous.
    expect(run.credential_user_id).toBe(store.users.arda.id);
    const lines = listRunLines(store.db, runId);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.display.ev).toBe("err");
    // The copy names the person and where THEY fix it — no environment
    // variable, because there is none to set.
    expect(lines[0]!.display.text).toContain("Profile → Agent accounts");
    expect(lines[0]!.display.text).toContain("No agent process was started.");
    expect(lines[0]!.display.text).not.toContain("ANTHROPIC_API_KEY");
    const { runFailureReason } = await import("~/server/tasks/agent-reply.server");
    expect(runFailureReason(store.db, runId)?.kind).toBe("unavailable");
  });

  it("an unowned task refuses with the owner sentence and a NULL principal", async () => {
    const { runId } = await startTestRun(store.db, {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      role: "Primary specialist",
      kind: "primary",
      backend: "codex",
      model: defaultModelFor("codex"),
      prompt: "go",
      dataRoot: store.dataRoot,
      credentialUserId: null,
      principalRefusal: { kind: "unowned", taskKey: "VIB-1" },
    });
    const run = getRun(store.db, runId)!;
    expect(run.state).toBe("error");
    // Null only here: a run that ever spawned a process has a principal.
    expect(run.credential_user_id).toBeNull();
    const text = listRunLines(store.db, runId)[0]!.display.text ?? "";
    expect(text).toContain("Codex runs on VIB-1 need a task owner");
    expect(text).toContain("Assign me");
    expect(text).toContain("No agent process was started.");
  });

  it("records the principal on a run that DOES start, and audits it", async () => {
    queueFakeRun(
      instantScript([
        { t: "1", ev: "result", tag: "result", text: "done" },
      ]),
    );
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
    expect(getRun(store.db, runId)!.credential_user_id).toBe(
      store.users.arda.id,
    );
    const audit = listAuditEvents(store.db, { action: "runtime.run.started" });
    expect(audit[0]?.details).toMatchObject({
      credentialUserId: store.users.arda.id,
    });
  });

  it("hands the principal's credential to the adapter and redacts it from the log", async () => {
    // The two halves of ruling 127's spawn hygiene, on one run: the child env
    // carries this person's key, and the sink scrubs that same value out of
    // every persisted line — the run console is visible to every project
    // member, and the key is not theirs.
    const secret = fakeBackendSecret("claude");
    queueFakeRun(
      instantScript([
        { t: "1", ev: "text", tag: "assistant", text: `env says ${secret}` },
        { t: "2", ev: "result", tag: "result", text: "done" },
      ]),
    );
    const { runId } = await startTestRun(store.db, {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      role: "Primary specialist",
      kind: "primary",
      backend: "claude",
      model: "claude-sonnet-4-5",
      prompt: "go",
      dataRoot: store.dataRoot,
      env: { GIT_CEILING_DIRECTORIES: "/tmp/ceiling" },
    });
    await settle();
    const spec = lastRunSpec()!;
    expect(spec.env?.ANTHROPIC_API_KEY).toBe(secret);
    expect(spec.env?.CLAUDE_CONFIG_DIR).toContain(store.users.arda.id);
    // The caller's own overlay still lands beside it.
    expect(spec.env?.GIT_CEILING_DIRECTORIES).toBe("/tmp/ceiling");
    for (const line of listRunLines(store.db, runId)) {
      expect(line.display.text ?? "").not.toContain(secret);
    }
    expect(
      listRunLines(store.db, runId).some((l) =>
        (l.display.text ?? "").includes("[redacted]"),
      ),
    ).toBe(true);
  });

  it("marks every process the run starts with the run's own id, over any caller overlay (ruling 174)", async () => {
    // The settle sweep finds what a run left behind by this one variable, so
    // it must name THIS run: a caller overlay cannot rename the processes, and
    // the credential and the workspace overlay still land beside it.
    queueFakeRun(instantScript([{ t: "1", ev: "result", tag: "result", text: "done" }]));
    const { runId } = await startTestRun(store.db, {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      role: "Primary specialist",
      kind: "primary",
      backend: "claude",
      model: "claude-sonnet-4-5",
      prompt: "go",
      dataRoot: store.dataRoot,
      env: { GIT_CEILING_DIRECTORIES: "/tmp/ceiling", VIBERR_RUN_ID: "run_someone-else" },
    });
    await settle();
    const spec = lastRunSpec()!;
    expect(spec.runId).toBe(runId);
    expect(spec.env?.VIBERR_RUN_ID).toBe(runId);
    expect(spec.env?.GIT_CEILING_DIRECTORIES).toBe("/tmp/ceiling");
    expect(spec.env?.CLAUDE_CONFIG_DIR).toContain(store.users.arda.id);
  });

  it("refuses a per-run env overlay that would decide whose account pays", async () => {
    // A caller bug, not a user error: silently letting either side win would
    // let a workspace overlay swap the credential of the person being billed.
    await expect(
      startTestRun(store.db, {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        role: "Primary specialist",
        kind: "primary",
        backend: "claude",
        model: "claude-sonnet-4-5",
        prompt: "go",
        dataRoot: store.dataRoot,
        env: { ANTHROPIC_API_KEY: "someone-elses-key" },
      }),
    ).rejects.toThrow(/collides with the credential env/);
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

/**
 * Ruling 185 (owner Q36-14, 2026-09-12): Viberr does not confine a Codex run
 * with the CLI's OS sandbox, so there is no host condition left to refuse one
 * over. Rulings 182(d) and 184 are gone with it.
 */
describe("ruling 185: no Codex run is refused for a sandbox", () => {
  it("a write-withheld reviewer — the shape ruling 182 refused — starts normally", async () => {
    // Canary: re-introduce `codexSandboxRefusal` in `startRun` and this run
    // ends `error` with `run·unavailable` instead of finishing. The refusal
    // existed because bubblewrap could not start under Docker's default
    // seccomp profile (F36-1); nothing asks bubblewrap any more.
    queueFakeRun(
      instantScript([{ t: "1", ev: "result", tag: "result", text: "done" }], "codex"),
    );
    const { runId } = await startTestRun(store.db, {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      role: "Code reviewer",
      kind: "reviewer",
      backend: "codex",
      model: defaultModelFor("codex"),
      prompt: "go",
      dataRoot: store.dataRoot,
      repoWriteWithheld: true,
    });
    await settle();
    expect(getRun(store.db, runId)!.state).toBe("finished");
    const lines = listRunLines(store.db, runId).map((l) => l.raw);
    expect(lines.join("\n")).not.toContain("Codex sandbox unavailable");
    // And the spec the adapter got carries the withheld grant, which is what
    // the prompt and the delivery gate read (the advisory posture).
    expect(lastRunSpec()?.repoWriteWithheld).toBe(true);
  });
});

/**
 * Ruling 460: when this server launches agents, every run executes as its
 * credential principal's own OS user — decided in `startRun`, the one funnel —
 * and a launch that cannot be prepared refuses the run; it never quietly runs
 * as the server's user.
 */
describe("ruling 460: a run executes as its principal's own OS user", () => {
  afterEach(() => resetAgentIsolationForTests());

  function launcherScript(body: string): string {
    const file = path.join(ctx.makeTempDir("viberr-launcher-"), "viberr-launch");
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
    return file;
  }

  const input = () => ({
    projectSlug: store.slug,
    taskKey: "VIB-1",
    role: "Primary specialist",
    kind: "primary" as const,
    backend: "claude" as const,
    model: "claude-sonnet-4-5",
    prompt: "go",
    dataRoot: store.dataRoot,
  });

  it("carries the principal's agent uid, the launcher and their own $HOME on the spec", async () => {
    const launcher = launcherScript("exit 0");
    resetAgentIsolationForTests(
      { status: "on", uidFloor: AGENT_UID_FLOOR, reason: null },
      { launcher },
    );
    queueFakeRun(instantScript([{ t: "1", ev: "result", tag: "result", text: "done" }]));
    const { runId } = await startTestRun(store.db, input());
    await settle();
    expect(getRun(store.db, runId)!.state).toBe("finished");
    const userRoot = path.join(store.dataRoot, "runtimes", "users", store.users.arda.id);
    const spec = lastRunSpec();
    expect(spec?.agent).toEqual({
      uid: AGENT_UID_FLOOR,
      launcher,
      launchHome: path.join(userRoot, "claude-home"),
      home: path.join(userRoot, "home"),
    });
    expect(spec?.env?.HOME).toBe(path.join(userRoot, "home"));
    expect(spec?.env?.CLAUDE_CONFIG_DIR).toBe(path.join(userRoot, "claude-home"));
  });

  it("refuses the run, naming the launch, when the principal's home cannot be handed over", async () => {
    const launcher = launcherScript(
      "echo 'viberr-launch: a directory on the path belongs to someone else' >&2; exit 126",
    );
    resetAgentIsolationForTests(
      { status: "on", uidFloor: AGENT_UID_FLOOR, reason: null },
      { launcher },
    );
    const result = await startTestRun(store.db, input());
    await settle();
    expect(result.outcome).toBe("refused");
    expect(result.refusal).toMatch(/as its person's own user \(ruling 460\)/);
    expect(result.refusal).toMatch(/belongs to someone else/);
    expect(result.refusal).toMatch(/nothing falls back to the server's own user/);
    // No process: the adapter never saw a spec.
    expect(lastRunSpec()).toBeUndefined();
    const run = getRun(store.db, result.runId)!;
    expect(run.state).toBe("error");
    const tags = listRunLines(store.db, result.runId).map((line) => line.display.tag);
    expect(tags).toContain("run·unavailable");
  });

  it("launches nothing on a host with no launcher: the spec carries no agent", async () => {
    resetAgentIsolationForTests(null, { launcher: path.join(ctx.makeTempDir(), "absent") });
    queueFakeRun(instantScript([{ t: "1", ev: "result", tag: "result", text: "done" }]));
    const { runId, outcome } = await startTestRun(store.db, input());
    await settle();
    // It ran — as before, as the server's own user.
    expect(outcome).toBe("started");
    expect(getRun(store.db, runId)!.state).toBe("finished");
    const spec = lastRunSpec();
    expect(spec).toBeDefined();
    expect(spec?.agent).toBeUndefined();
    expect(spec?.env?.HOME).toBeUndefined();
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
    const result = await interruptRun(store.db, { projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot, runId }, { userId: store.users.arda.id, label: store.users.arda.email });
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
    const result = await interruptRun(store.db, { projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot, runId }, { userId: store.users.murat.id, label: store.users.murat.email });
    expect(result.outcome).toBe("interrupted");
  });

  it("reviewer / viewer / non-member cannot interrupt (403)", async () => {
    const runId = await startRunning();
    for (const u of [store.users.selin, store.users.elif, store.users.deniz]) {
      await expect(
        interruptRun(store.db, { projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot, runId }, { userId: u.id, label: u.email }),
      ).rejects.toThrow(AppError);
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

    const result = await interruptRun(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot, runId: older.runId },
      { userId: store.users.arda.id, label: store.users.arda.email },
    );
    expect(result.outcome).toBe("already-terminal");
    expect(result.run).not.toBeNull();
    expect(result.run!.kind).toBe("primary");
    expect(result.run!.profileId).toBe("dev");
    // The group's identity is its representative — the NEWEST run of the agent.
    expect(result.run!.serverRunId).toBe(newer.runId);
  });

  it("review F6: a second interrupt in the adapter's exit window is a no-op", async () => {
    // The live-handle arm stamps `interrupted_by` at once but leaves the row
    // `running` until the adapter's onExit; the button re-enables as soon as
    // the action returns. Simulate that window and click again.
    const runId = await startRunning();
    patchRun(store.db, runId, { interruptedBy: store.users.arda.id });
    const before = listAuditEvents(store.db, { action: "runtime.run.interrupted" }).length;
    const result = await interruptRun(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot, runId },
      { userId: store.users.arda.id, label: store.users.arda.email },
    );
    // Canary: drop the `run.interrupted_by` guard in interruptRun and this
    // writes a second audit row (and a second timeline note).
    expect(result.outcome).toBe("already-terminal");
    expect(listAuditEvents(store.db, { action: "runtime.run.interrupted" })).toHaveLength(before);
  });

  it("interrupting a finished run is an idempotent no-op (not an error)", async () => {
    const { runId } = await startTestRun(store.db, {
      projectSlug: store.slug, taskKey: "VIB-1", role: "R", kind: "primary",
      backend: "claude", model: "m", prompt: "go",
      dataRoot: store.dataRoot,
    });
    await settle();
    expect(getRun(store.db, runId)!.state).toBe("finished");
    const result = await interruptRun(store.db, { projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot, runId }, { userId: store.users.arda.id, label: store.users.arda.email });
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
      credentialUserId: store.users.arda.id,
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
  it("ruling 175: the instance's spending cap rides every run, fresh and resumed, and is absent when none is set", async () => {
    // Canary: drop the `getMaxRunSpendUsd` stamp from `startRun` and the
    // capped specs read undefined — every builder funnels through it, so no
    // path can start a run without the cap.
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
    const run = (threadId: string) =>
      startTestRun(store.db, {
        projectSlug: store.slug, taskKey: "VIB-1", role: "Primary specialist", kind: "primary",
        backend: "claude", model: "m", prompt: "go", dataRoot: store.dataRoot, threadId,
      });

    const uncapped = await run("t-uncapped");
    await settle();
    expect(specs.find((s) => s.runId === uncapped.runId)).not.toHaveProperty("maxSpendUsd");

    setMaxRunSpendUsd(store.db, 1.25, { userId: null, label: "test" });
    const capped = await run("t-capped");
    await settle();
    expect(specs.find((s) => s.runId === capped.runId)?.maxSpendUsd).toBe(1.25);
    const resumed = await resumeRun(store.db, {
      runId: capped.runId,
      prompt: "follow up",
      credentialUserId: store.users.arda.id,
      dataRoot: store.dataRoot,
    });
    await settle();
    expect(specs.find((s) => s.runId === resumed.runId)?.maxSpendUsd).toBe(1.25);
  });

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
      credentialUserId: store.users.arda.id,
      disallowedTools: ["Bash(gh pr merge:*)", "Edit"],
      skills: ["conventional-commits"],
      env: { GIT_CEILING_DIRECTORIES: "/data/projects/x/tasks/VIB-1" },
      mcpServers: { viberr: sdkServerStub },
      systemPrompt: "You are the Developer.",
      // C02-R3 (pass 32): the attachments drop is confinement too — the Codex
      // sandbox's extra writable root, and what the evidence carve-out keys on.
      attachmentsWritableDir: "/data/projects/x/tasks/VIB-1/attachments",
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
    // Canary: drop the `attachmentsWritableDir` line from carryResumeOptions.
    expect(resumeSpec.attachmentsWritableDir).toBe(
      "/data/projects/x/tasks/VIB-1/attachments",
    );
  });

  it("C02-R12 (pass 32): a forward read can be bounded in the SELECT itself", () => {
    upsertRun(store.db, {
      id: "run_fwd",
      projectSlug: store.slug,
      taskKey: "VIB-1",
      threadId: "t-fwd",
      role: "Primary specialist",
      kind: "primary",
      backend: "claude",
      model: "m",
      sdk: "s",
      agentProfileId: "developer",
      state: "finished",
    });
    for (let seq = 0; seq < 6; seq += 1) {
      insertRunLine(store.db, {
        runId: "run_fwd",
        seq,
        occurredAt: new Date().toISOString(),
        raw: "{}",
        display: { t: "1", ev: "text", tag: "assistant", text: `line ${seq}` },
      });
    }
    // Unbounded stays the console's live tail…
    expect(listRunLines(store.db, "run_fwd", 1).map((l) => l.seq)).toEqual([2, 3, 4, 5]);
    // …and the bound is applied by SQL, ascending from the cursor.
    expect(listRunLines(store.db, "run_fwd", 1, 2).map((l) => l.seq)).toEqual([2, 3]);
    expect(listRunLines(store.db, "run_fwd", -1, 0)).toEqual([]);
    // `getRunLog` threads it as `forwardLimit`, never as the backward `limit`.
    const { getRunLog } = runServiceModule;
    const page = getRunLog(store.db, "run_fwd", { since: 1, forwardLimit: 3 })!;
    expect(page.lines.map((l) => l.seq)).toEqual([2, 3, 4]);
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
      credentialUserId: store.users.arda.id,
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

/* ----------- ruling 176: an org server's marked write tools, denied --------- */

describe("ruling 176 — marked MCP write tools reach the denylist", () => {
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

  it("denies each marked tool by its Claude name AFTER the server's auto-approval", async () => {
    // Canary: drop the `mcpToolDenials` fold in startRun and the names never
    // reach `disallowedTools`.
    const specs: RunSpec[] = [];
    configureRunServiceForTests({ claude: captureAdapter(specs), codex: captureAdapter(specs) });

    await startTestRun(store.db, {
      projectSlug: store.slug, taskKey: "VIB-1", role: "Reviewer", kind: "reviewer",
      backend: "claude", model: "m", prompt: "go",
      mcpServers: { github: stdioServerStub },
      disallowedTools: ["Edit", "Write"],
      mcpToolDenials: [
        { server: "github", tools: ["create_pull_request", "repo.merge"] },
        // A server this run does not mount names nothing, so it is not carried.
        { server: "dropped", tools: ["push_files"] },
      ],
      dataRoot: store.dataRoot,
    });
    await settle();

    const spec = specs[0]!;
    // The D4 approval entry stays: a deny rule wins over it.
    expect(spec.allowedTools).toEqual(["mcp__github"]);
    expect(spec.disallowedTools).toEqual([
      "Edit",
      "Write",
      "mcp__github__create_pull_request",
      // The CLI's own normalization: outside [A-Za-z0-9_-] becomes `_`.
      "mcp__github__repo_merge",
    ]);
    // Codex reads the raw names off the spec (`disabled_tools`).
    expect(spec.mcpToolDenials).toEqual([
      { server: "github", tools: ["create_pull_request", "repo.merge"] },
    ]);
  });

  it("carries the denials onto a resumed run", async () => {
    const specs: RunSpec[] = [];
    configureRunServiceForTests({ claude: captureAdapter(specs), codex: captureAdapter(specs) });
    const { runId } = await startTestRun(store.db, {
      projectSlug: store.slug, taskKey: "VIB-1", role: "Reviewer", kind: "reviewer",
      backend: "claude", model: "m", prompt: "go", dataRoot: store.dataRoot,
    });
    await settle();

    const resumed = await resumeRun(store.db, {
      runId,
      prompt: "follow up",
      credentialUserId: store.users.arda.id,
      mcpServers: { github: stdioServerStub },
      mcpToolDenials: [{ server: "github", tools: ["merge_pull_request"] }],
      dataRoot: store.dataRoot,
    });
    await settle();

    const spec = specs.find((s) => s.runId === resumed.runId)!;
    expect(spec.disallowedTools).toEqual(["mcp__github__merge_pull_request"]);
    expect(spec.mcpToolDenials).toEqual([{ server: "github", tools: ["merge_pull_request"] }]);
  });
});

/* ---------------- runtime continuity recovery (P13-D-2 / FR22) ------------- */

describe("resumeRun — continuity recovery", () => {
  /**
   * Ruling 127: the transcript store is the PRINCIPAL's own runtime home, not a
   * deployment-wide `CLAUDE_CONFIG_DIR` — so the probe reads
   * `<dataRoot>/runtimes/users/<owner>/claude-home/projects`. The consequence
   * the ruling makes explicit is exercised at the bottom of this block: an
   * owner change since the original run reads as a missing session and takes
   * this same continuity-reset path, rather than resuming one person's
   * conversation inside another's account.
   */
  async function withTranscriptStore(sid?: string, userId?: string): Promise<void> {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const path = (await import("node:path")).default;
    const { userBackendHome } = await import("./user-homes.server");
    const home = userBackendHome(
      userId ?? store.users.arda.id,
      "claude",
      store.dataRoot,
    );
    const projects = path.join(home, "projects", "-w-x");
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
          credentialUserId: store.users.arda.id,
          dataRoot: store.dataRoot,
          ...extra,
        }),
    };
  }

  it("ruling 434: a Codex rollout whose head is torn starts a fresh session, not a resume that fails", async () => {
    /**
     * Live on AX-5 at 01:49: the resume went to the CLI, which answered "does
     * not start with session metadata", and Viberr called it a failed run
     * ("Review its authentication and runtime configuration"). The dead
     * session was never marked, so every recovery option resumed it again.
     *
     * CANARY: treat `damaged` as `present` in `resumeRun`.
     */
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const path = (await import("node:path")).default;
    const { userBackendHome } = await import("./user-homes.server");
    const sid = "01a0cbdd-c151-75b2-a067-e047586b9a72";
    const specs: RunSpec[] = [];
    const capture: RuntimeAdapter = {
      backend: "codex",
      start(spec, cb) {
        specs.push(spec);
        cb.onExit({ outcome: "finished", effectiveBackend: "codex", sessionId: sid });
        return { runId: spec.runId, interrupt() {} };
      },
    };
    configureRunServiceForTests({ claude: capture, codex: capture });
    const { runId } = await startTestRun(store.db, {
      projectSlug: store.slug, taskKey: "VIB-1", role: "Primary specialist",
      kind: "primary", backend: "codex", model: "m", agentName: "dev",
      agentProfileId: "dev", prompt: "go", dataRoot: store.dataRoot,
    });
    await settle();
    const dir = path.join(
      userBackendHome(store.users.arda.id, "codex", store.dataRoot),
      "sessions", "2026", "09", "23",
    );
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, `rollout-2026-09-23T01-25-02-${sid}.jsonl`),
      [
        JSON.stringify({ ordinal: 1, type: "event_msg", payload: { type: "task_started" } }),
        'e_roots":["/data/projects/ax-clone/tasks/AX-5/workspace/ax-clone"]}}',
      ].join("\n") + "\n",
    );

    const resumed = await resumeRun(store.db, {
      runId,
      prompt: "follow up",
      credentialUserId: store.users.arda.id,
      dataRoot: store.dataRoot,
    });
    await settle();

    expect(resumed.continuityLossReason).toBe("transcript_damaged");
    expect(specs.find((s) => s.runId === resumed.runId)!.resumeSessionId).toBeNull();
    // Marked like a vanished session, so no later dispatch selects it again.
    const marker = listRunLines(store.db, runId).find(
      (l) => l.display.tag === "run·session_missing",
    );
    expect(marker!.display.text).toContain("its provider transcript is damaged");
    const { runFailureReason } = await import("~/server/tasks/agent-reply.server");
    expect(runFailureReason(store.db, runId)?.kind).toBe("session_missing");
    const timeline = readTaskFile({
      projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot,
    })!.parsed.timeline;
    const note = timeline.find((e) => e.text.includes("continuity was lost"));
    expect(note?.text).toContain("damaged provider transcript");
    expect(note?.text).not.toContain("no longer has a provider transcript");
  });

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

  /**
   * Ruling 127, stated as behaviour: a resumed turn bills the task owner AS OF
   * NOW, and the continuity probe reads THAT person's home. So a seat that
   * changed hands between the original run and the reply cannot resume the
   * previous owner's conversation inside the new owner's account — the
   * transcript is not in their home, and the existing continuity-reset path
   * (one fresh run re-anchored on task.md) is the honest outcome.
   */
  it("a resume for a DIFFERENT principal re-anchors instead of borrowing the session", async () => {
    const { specs, resume, firstRunId } = await startThenResume();
    // The session IS on disk — in the ORIGINAL owner's home.
    await withTranscriptStore("sess-gone");
    // This new owner HAS run agents here before (their store exists). The
    // change of seat is what decides it, so the never-run case below reaches
    // the same place.
    await withTranscriptStore(undefined, store.users.murat.id);
    await connectFakeBackend(store.db, store.users.murat.id, "claude");

    const resumed = await resume({ credentialUserId: store.users.murat.id });
    await settle();

    expect(resumed.continuityReset).toBe(true);
    const spec = specs.find((s) => s.runId === resumed.runId)!;
    expect(spec.resumeSessionId).toBeNull();
    expect(spec.prompt).toContain("[continuity notice]");
    // …and the fresh run bills the NEW owner, which is the whole point.
    expect(getRun(store.db, resumed.runId)!.credential_user_id).toBe(
      store.users.murat.id,
    );
    expect(spec.env?.CLAUDE_CONFIG_DIR).toContain(store.users.murat.id);

    // Ruling 207(j): and the record says WHY. The owner-change branch decides
    // continuity before any filesystem is consulted, so the transcript is
    // intact in the previous owner's home — reporting it as "no longer has a
    // provider transcript … retention sweep or a wiped runtime volume" sent an
    // admin hunting a storage fault that does not exist, for a condition viberr
    // chose.
    // CANARY: emit the single transcript-gone sentence (the shipped note) and
    // both of these fail.
    const { readTaskFile: readTask } = await import("~/server/files/task-writer.server");
    const note = readTask({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed.timeline.find((e) => e.type === "continuity");
    expect(note!.text).toContain("belongs to the account that held the seat");
    expect(note!.text).toContain("The transcript is not missing");
    expect(note!.text).not.toMatch(/retention sweep|wiped runtime volume/);

    const marker = listRunLines(store.db, firstRunId).find(
      (l) => l.display.tag === "run·session_missing",
    );
    expect(marker!.display.text).toMatch(/belongs to the account that owned this task/);
  });

  /**
   * The hole a probe-only version of the rule above leaves open, and the reason
   * `resumeRun` decides an owner change from the CHANGE rather than from disk:
   * a new owner who has connected the backend but never had a run on this
   * server has no `claude-home/projects/` yet, so the probe answers `unknown`
   * — whose contract is "resume as before". The previous owner's session id
   * then went to the SDK inside the new owner's home and failed at the vendor
   * ("No conversation found with session ID …"), producing a blocked packet
   * instead of the one fresh re-anchored run ruling 127 promises.
   */
  it("re-anchors for a new principal who has never had a run here", async () => {
    const { specs, resume } = await startThenResume();
    // The session is on disk in the ORIGINAL owner's home; the new owner has no
    // transcript store at all, which is what used to read as `unknown`.
    await withTranscriptStore("sess-gone");
    await connectFakeBackend(store.db, store.users.murat.id, "claude");

    const resumed = await resume({ credentialUserId: store.users.murat.id });
    await settle();

    expect(resumed.continuityReset).toBe(true);
    const spec = specs.find((s) => s.runId === resumed.runId)!;
    expect(spec.resumeSessionId).toBeNull();
    expect(spec.prompt).toContain("[continuity notice]");
    expect(getRun(store.db, resumed.runId)!.credential_user_id).toBe(
      store.users.murat.id,
    );
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

describe("backendUnavailableMessage (ruling 127)", () => {
  it("renders the resolver's own refusal sentence for a refusal", () => {
    // ONE builder for the error-run line, the packet body and the disabled
    // control, so a person cannot be told three stories about one refusal.
    const msg = backendUnavailableMessage("codex", {
      kind: "refusal",
      refusal: { kind: "unowned", taskKey: "VIB-9" },
    });
    expect(msg).toContain("Codex runs on VIB-9 need a task owner");
    expect(msg).toContain("No agent process was started.");
  });

  it("passes a credential-store detail through, and still promises nothing ran", () => {
    const msg = backendUnavailableMessage("claude", {
      kind: "detail",
      detail: "Your Claude sign-in file is missing from this server.",
    });
    expect(msg).toBe(
      "Your Claude sign-in file is missing from this server. No agent process was started.",
    );
  });

  it("names no environment variable — there is none left to set", () => {
    const msg = backendUnavailableMessage("codex", {
      kind: "refusal",
      refusal: { kind: "owner-missing", ownerUserId: "u_gone" },
    });
    for (const gone of [
      "ANTHROPIC_API_KEY",
      "CODEX_API_KEY",
      "OPENAI_API_KEY",
      "CODEX_HOME",
      "VIBERR_CODEX_USE_CLI_AUTH",
      "VIBERR_CLAUDE_USE_CLI_AUTH",
    ]) {
      expect({ gone, named: msg.includes(gone) }).toEqual({ gone, named: false });
    }
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

    // "ultra" is a Codex-only SDK tier Viberr does not offer (automatic delegation);
    // a run stored with it gets the nearest offered Codex tier. (`max` itself is
    // offered on both backends since Codex CLI 0.153, so it no longer translates.)
    await startTestRun(store.db, {
      projectSlug: store.slug, taskKey: "VIB-1", threadId: "t-codex", role: "R", kind: "primary",
      backend: "codex", model: "gpt-5.6-sol", effort: "ultra", prompt: "go",
      dataRoot: store.dataRoot,
    });
    await settle();
    expect(specs[1]?.effort).toBe("max");

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

/**
 * R21-4 — the run row exists (and renders) BEFORE the provider process does.
 *
 * OBS-8, live: a create-trigger run spent 3+ minutes inside `git clone --depth 1`
 * on a 113 MB repository BEFORE anything appeared on the task page — empty
 * timeline, no Live-run strip, no phase, nothing moving. The work WAS underway;
 * the product simply had no row to render it on, because the run row was only
 * minted after the workspace was ready.
 */
describe("reserveRun — a live row while the workspace is prepared (R21-4)", () => {
  it("renders as a running row with its preparation phase before any adapter starts", () => {
    const reservation = reserveRun(store.db, {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      threadId: "primary-abc",
      role: "developer",
      kind: "primary",
      backend: "claude",
      model: "sonnet",
      agentName: "dev",
      credentialUserId: store.users.arda.id,
      agentProfileId: "developer",
      phase: RUN_PHASE.preparing,
      step: "Cloning acme/app",
    })!;
    expect(reservation).not.toBeNull();

    const [view] = listRunsForTask(store.db, store.slug, "VIB-1");
    // `state: "running"` is what the Live-run strip filters on — a queued row
    // would have kept the page blank, which is the defect.
    expect(view).toMatchObject({
      state: "running",
      lifecycle: "running",
      phase: "Preparing workspace",
      step: "Cloning acme/app",
    });
    expect(view!.startedAt).toBe(reservation.startedAt);
  });

  it("startRun ADOPTS the reservation — one row, one thread, the original clock", async () => {
    const reservation = reserveRun(store.db, {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      threadId: "primary-abc",
      role: "developer",
      kind: "primary",
      backend: "claude",
      model: "sonnet",
      credentialUserId: store.users.arda.id,
      agentProfileId: "developer",
      phase: RUN_PHASE.preparing,
    })!;
    queueFakeRun(instantScript([{ t: "1", ev: "text", tag: "assistant", text: "hi" }]));

    const { runId } = await startTestRun(store.db, {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      role: "developer",
      kind: "primary",
      backend: "claude",
      model: "sonnet",
      prompt: "go",
      dataRoot: store.dataRoot,
      reservation,
    });
    await settle();

    expect(runId).toBe(reservation.runId);
    // ONE row: a second would show up beside the strip the human was watching.
    expect(listRunsForTaskRows(store.db, store.slug, "VIB-1")).toHaveLength(1);
    const row = getRun(store.db, runId)!;
    expect(row.thread_id).toBe("primary-abc");
    // Elapsed covers the preparation the human already sat through.
    expect(row.started_at).toBe(reservation.startedAt);
    expect(row.state).toBe("finished");
  });

  it("abandon() releases the row (and the delivering single-flight slot) when preparation throws", () => {
    const reservation = reserveRun(store.db, {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      threadId: "primary-abc",
      role: "developer",
      kind: "primary",
      backend: "claude",
      model: "sonnet",
      credentialUserId: store.users.arda.id,
      agentProfileId: "developer",
      phase: RUN_PHASE.preparing,
    })!;

    reservation.abandon("clone blew up");

    const row = getRun(store.db, reservation.runId)!;
    expect(row.state).toBe("error");
    expect(row.phase).toBeNull();
    expect(row.finished_at).not.toBeNull();
    // The unique index only binds on queued|running, so a second delivering run
    // is startable again — the whole reason abandoning matters.
    expect(
      listRunsForTaskRows(store.db, store.slug, "VIB-1").filter(
        (r) => r.kind === "primary" && (r.state === "running" || r.state === "queued"),
      ),
    ).toHaveLength(0);
  });
});

/**
 * C4-opres — a reserved row is INTERRUPTIBLE, and an interrupt is final.
 *
 * The reservation renders a `running` row minutes before the provider process
 * exists, and the Live-run strip's Stop button acts on exactly that row: there is
 * no adapter yet, so `interruptRun` takes its no-live-handle arm and writes the
 * terminal state directly. The adoption then ran an upsert written for a row it
 * believed only it could touch — reviving the run, spawning the process the human
 * had just stopped, and erasing the recorded intervention.
 */
describe("a reservation interrupted while the workspace is prepared", () => {
  function reserve() {
    return reserveRun(store.db, {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      threadId: "primary-abc",
      role: "developer",
      kind: "primary",
      backend: "claude",
      model: "sonnet",
      credentialUserId: store.users.arda.id,
      agentProfileId: "developer",
      phase: RUN_PHASE.preparing,
      step: "Cloning acme/app",
    })!;
  }

  const stop = async (runId: string) =>
    await interruptRun(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot, runId },
      { userId: store.users.arda.id, label: store.users.arda.email },
    );

  it("startRun REFUSES the adoption instead of resurrecting the run", async () => {
    // Canary: drop `assertRunReservationLive` from startRun and this goes green
    // on a run that is `running` again with a live adapter behind it.
    const reservation = reserve();
    expect((await stop(reservation.runId)).outcome).toBe("interrupted");

    queueFakeRun(instantScript([{ t: "1", ev: "text", tag: "assistant", text: "hi" }]));
    await expect(
      startTestRun(store.db, {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        role: "developer",
        kind: "primary",
        backend: "claude",
        model: "sonnet",
        prompt: "go",
        dataRoot: store.dataRoot,
        reservation,
      }),
    ).rejects.toMatchObject({ status: 409 });
    await settle();

    const row = getRun(store.db, reservation.runId)!;
    // The human's stop stands, with the interrupter still recorded on it.
    expect(row.state).toBe("interrupted");
    expect(row.interrupted_by).toBe(store.users.arda.id);
    // Nothing was spawned, and no second row appeared beside it.
    expect(lastRunSpec()).toBeUndefined();
    expect(listRunsForTaskRows(store.db, store.slug, "VIB-1")).toHaveLength(1);
  });

  /**
   * The row reached `interrupted` with no adapter to report it, so nothing
   * else can ever fire the completion callback the starter registered:
   * `launch`'s onExit is its only other trigger and there is no process to
   * exit. A queued controller turn stopped this way never settled — its lease
   * held, the conversation read "working" until a restart — and a reserved
   * specialist's completion effects were lost the same way.
   */
  it("fires the registered completion callback, once, with the interrupted row", async () => {
    // Canary: drop the `fireIfAlreadyTerminal` call from interruptRun's
    // no-live-handle arm and `fired` stays null.
    const reservation = reserve();
    let fired: string | null = null;
    let count = 0;
    registerRunCompletion(reservation.runId, (finished) => {
      fired = finished.state;
      count += 1;
    }, store.db);
    expect(fired).toBeNull();

    expect((await stop(reservation.runId)).outcome).toBe("interrupted");
    expect(fired).toBe("interrupted");
    expect(count).toBe(1);
    // Consumed on fire: the reservation's later abandon() finds no callback to
    // fire a second time.
    reservation.abandon("preparation stopped");
    expect(count).toBe(1);
  });

  it("abandon() leaves the recorded interrupt alone", async () => {
    // The wrapper's catch releases the reservation when preparation throws —
    // and the refusal above IS such a throw. Stamping `error` over `interrupted`
    // would erase the one fact a human put there.
    // Canary: drop the terminal check in `abandon` and the state reads "error".
    const reservation = reserve();
    await stop(reservation.runId);

    reservation.abandon("preparation stopped");

    const row = getRun(store.db, reservation.runId)!;
    expect(row.state).toBe("interrupted");
    expect(row.interrupted_by).toBe(store.users.arda.id);
  });
});

/**
 * F21-24 (phase half) — a shutdown drain is not one fault per phase message.
 *
 * The line path already collapsed to a single warning; `phase` did not, so
 * `docker restart` mid-run still sprayed "run phase persist failed" from
 * `launch`'s own catch — one per stream message, saying the same thing the line
 * path had just stopped saying. Nothing is retryable: the database will not
 * reopen, and boot finalization recovers the run.
 */
describe("run phases during a shutdown drain (F21-24)", () => {
  it("collapses to ONE warning with no per-phase errors", async () => {
    // Canary: drop the drain guard from `sink.phase` and this reports 5 errors.
    let callbacks: RunCallbacks | null = null;
    const capture: RuntimeAdapter = {
      backend: "claude",
      start(spec, cb) {
        callbacks = cb;
        return { runId: spec.runId, interrupt() {} };
      },
    };
    configureRunServiceForTests({ claude: capture, codex: capture });
    await startTestRun(store.db, {
      projectSlug: store.slug, taskKey: "VIB-1", role: "R", kind: "primary",
      backend: "claude", model: "sonnet", prompt: "go", dataRoot: store.dataRoot,
    });
    const cb = callbacks!;

    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const error = vi.spyOn(logger, "error").mockImplementation(() => {});
    try {
      shutdownDatabase();
      // The live shape: SIGTERM closes the very handle this run is writing
      // through, so every write from here throws rather than quietly no-opping.
      store.db.close();
      // Distinct phases so the 1s step throttle cannot swallow them. `onPhase`
      // is optional on the callback type; `launch` always supplies it, and a
      // run-service that stopped doing so is itself the regression.
      const onPhase = cb.onPhase!;
      for (let i = 0; i < 5; i++) onPhase(`phase-${i}`, `step-${i}`);
      // …and the exit that follows the drain is silent for the same reason.
      cb.onExit({ outcome: "finished", effectiveBackend: "claude", sessionId: null });

      expect(
        error.mock.calls.filter(([msg]) => msg.includes("run phase persist failed")),
      ).toHaveLength(0);
      expect(
        error.mock.calls.filter(([msg]) => msg.includes("run finalize persist failed")),
      ).toHaveLength(0);
      expect(
        warn.mock.calls.filter(([msg]) => msg.includes("the database closed mid-run")),
      ).toHaveLength(1);
    } finally {
      warn.mockRestore();
      error.mockRestore();
      closeDb(); // clears the shutdown latch for the rest of the suite
    }
  });
});

/**
 * F21-13 (run half) — a model belonging to the OTHER backend must not run
 * silently on this one.
 *
 * Live: `backends: [claude]` + `model: gpt-5.6-terra` (saved through the
 * editor race) ran the whole task on Claude's default model. Graceful, but
 * silent: the agents page named Terra, the provider ran Sonnet, and no surface
 * anywhere said a substitution had happened.
 */
describe("startRun — foreign model substitution is disclosed (F21-13)", () => {
  it("runs the backend's default, records it, and opens the run log with the swap", async () => {
    queueFakeRun(instantScript([{ t: "1", ev: "text", tag: "assistant", text: "hi" }]));
    const { runId } = await startTestRun(store.db, {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      role: "developer",
      kind: "primary",
      backend: "claude",
      model: "gpt-5.6-terra", // a Codex id on a Claude run
      prompt: "go",
      dataRoot: store.dataRoot,
    });
    await settle();

    // The row names what ACTUALLY ran — a header naming a model the provider
    // never saw is the lie this closes.
    expect(getRun(store.db, runId)!.model).toBe(defaultModelFor("claude"));
    const first = listRunLines(store.db, runId)[0]!;
    expect(first.display.tag).toBe(MODEL_SUBSTITUTED_TAG);
    expect(first.display.text).toContain("gpt-5.6-terra");
    expect(first.display.text).toContain("Codex");
    expect(first.display.text).toContain("Claude");
    // And the spec the adapter received carries the substituted model, so the
    // provider and the row can never disagree.
    expect(lastRunSpec()!.model).toBe(defaultModelFor("claude"));
  });

  it("leaves a model the backend DOES know completely alone (no notice, no swap)", async () => {
    queueFakeRun(instantScript([{ t: "1", ev: "text", tag: "assistant", text: "hi" }]));
    const { runId } = await startTestRun(store.db, {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      role: "developer",
      kind: "primary",
      backend: "claude",
      model: "claude-sonnet-4-5",
      prompt: "go",
      dataRoot: store.dataRoot,
    });
    await settle();

    expect(getRun(store.db, runId)!.model).toBe("claude-sonnet-4-5");
    expect(
      listRunLines(store.db, runId).some(
        (l) => l.display.tag === MODEL_SUBSTITUTED_TAG,
      ),
    ).toBe(false);
  });
});

/**
 * R21-4 — phase writes are throttled. Adapters emit one per stream message; the
 * strip only ever renders the latest, so a chatty run must not turn into one
 * UPDATE per message.
 */
describe("run phase throttling (R21-4)", () => {
  it("writes a step the window suppressed when the window closes, and nothing once the run has settled (ruling 348)", async () => {
    let callbacks: Parameters<RuntimeAdapter["start"]>[1] | null = null;
    const captureAdapter: RuntimeAdapter = {
      backend: "claude",
      start(spec, cb) {
        callbacks = cb;
        return { runId: spec.runId, interrupt() {} };
      },
    };
    configureRunServiceForTests({ claude: captureAdapter, codex: captureAdapter });
    const { runId } = await startTestRun(store.db, {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      role: "developer",
      kind: "primary",
      backend: "claude",
      model: "sonnet",
      prompt: "go",
      dataRoot: store.dataRoot,
    });
    const cb = callbacks!;
    vi.useFakeTimers();
    try {
      cb.onPhase?.("Working", "Bash · npm test");
      expect(getRun(store.db, runId)!.step).toBe("Bash · npm test");
      // The result lands 200 ms later, inside the window, and the run then
      // goes quiet — the Codex shape, where nothing is emitted until the
      // reasoning item completes.
      vi.advanceTimersByTime(200);
      cb.onPhase?.("Working", "composing · Bash · npm test answered");
      expect(getRun(store.db, runId)!.step).toBe("Bash · npm test");
      // CANARY: return from the throttle without deferring, and the strip keeps
      // the finished call through the whole silence.
      vi.advanceTimersByTime(800);
      expect(getRun(store.db, runId)!.step).toBe("composing · Bash · npm test answered");

      // A step still deferred when the run settles never lands on the row.
      // CANARY: drop `settled = true` and the clearTimeout in onExit.
      vi.advanceTimersByTime(1000);
      cb.onPhase?.("Working", "Bash · one");
      vi.advanceTimersByTime(100);
      cb.onPhase?.("Working", "late");
      cb.onExit({ outcome: "finished", effectiveBackend: "claude", sessionId: null });
      vi.advanceTimersByTime(2000);
      expect(getRun(store.db, runId)!.step).not.toBe("late");
    } finally {
      vi.useRealTimers();
    }
    await settle();
  });

  it("writes a CHANGED phase immediately and rate-limits step-only churn", async () => {
    // A live handle the test drives — the run never exits, so `finalize` never
    // nulls the phase and the row IS the observable.
    let callbacks: Parameters<RuntimeAdapter["start"]>[1] | null = null;
    const captureAdapter: RuntimeAdapter = {
      backend: "claude",
      start(spec, cb) {
        callbacks = cb;
        return { runId: spec.runId, interrupt() {} };
      },
    };
    const adapters: AdapterSet = { claude: captureAdapter, codex: captureAdapter };
    configureRunServiceForTests(adapters);

    const { runId } = await startTestRun(store.db, {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      role: "developer",
      kind: "primary",
      backend: "claude",
      model: "sonnet",
      prompt: "go",
      dataRoot: store.dataRoot,
    });
    const cb = callbacks!;

    cb.onPhase?.("Working", "Bash · one");
    expect(getRun(store.db, runId)).toMatchObject({
      phase: "Working",
      step: "Bash · one",
    });

    // Same phase, immediately after: throttled — the row keeps the first step.
    cb.onPhase?.("Working", "Bash · two");
    expect(getRun(store.db, runId)!.step).toBe("Bash · one");

    // A CHANGED phase is never swallowed by the throttle: the transitions are
    // the informative part, and dropping "Finishing" would strand the strip on
    // a step that already ended.
    cb.onPhase?.("Finishing", null);
    expect(getRun(store.db, runId)).toMatchObject({ phase: "Finishing", step: null });

    await interruptRun(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot, runId },
      { userId: store.users.arda.id, label: store.users.arda.email },
    );
    await settle();
  });
});

describe("C4: noteCompletionEffectsLost (a lost completion callback)", () => {
  /** A task being worked, and a finished primary run on it whose completion
   *  effects are about to be reported lost. */
  function seedLostRun(taskKey: string, runId: string): void {
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter(taskKey, {
        stage: "impl",
        waiting: "agent",
        ownerUserId: store.users.arda.id,
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    upsertRun(store.db, {
      id: runId,
      projectSlug: store.slug,
      taskKey,
      threadId: "primary",
      role: "developer",
      kind: "primary",
      backend: "claude",
      model: "sonnet",
      sdk: "claude",
      agentName: "dev",
      agentProfileId: "dev",
      state: "finished",
    });
  }

  async function noteOn(taskKey: string) {
    const { readTaskFile } = await import("~/server/files/task-writer.server");
    return readTaskFile({ projectSlug: store.slug, taskKey, dataRoot: store.dataRoot })!
      .parsed.timeline[0]!;
  }

  async function sweep(): Promise<void> {
    const { recoverUnreactedAgentRuns } = await import("./run-recovery.server");
    await recoverUnreactedAgentRuns(store.db, { dataRoot: store.dataRoot });
  }

  /** The sweep records this row BEFORE running the effects, so it is the one
   *  observable that means "picked up" rather than "picked up and succeeded". */
  function replayAttempted(runId: string): boolean {
    return listAuditEvents(store.db, { action: "run.recovery.reply_replayed" }).some((a) =>
      JSON.stringify(a.details ?? {}).includes(runId),
    );
  }

  it("stamps a continuity warning and flips the task off 'agent working'", async () => {
    // The task was being worked (waiting: agent) when its run finished, but the
    // completion callback threw so nothing flipped it back — the board would show
    // "agent working" forever until a restart replays the effects.
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-2", {
        stage: "impl",
        waiting: "agent",
        ownerUserId: store.users.arda.id,
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    upsertRun(store.db, {
      id: "run_effects_lost",
      projectSlug: store.slug,
      taskKey: "VIB-2",
      threadId: "primary",
      role: "developer",
      kind: "primary",
      backend: "claude",
      model: "sonnet",
      sdk: "claude",
      agentName: "dev",
      agentProfileId: "dev",
      state: "finished",
    });
    const run = getRun(store.db, "run_effects_lost")!;

    await noteCompletionEffectsLost(store.db, run, store.dataRoot);

    const { readTaskFile } = await import("~/server/files/task-writer.server");
    const parsed = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-2",
      dataRoot: store.dataRoot,
    })!.parsed;
    // No longer stuck reading "agent working": a human is asked to look.
    expect(parsed.frontmatter.waiting).toBe("human");
    // A visible continuity warning (not a neutral note buried mid-timeline).
    expect(parsed.timeline[0]).toMatchObject({ type: "continuity" });
    expect(parsed.timeline[0]!.text).toContain("completion effects");
  });

  /**
   * F37-67 (pass 37): the note makes two claims, and both are false in the case
   * that actually produces it.
   *
   * The real failure path is `applyAgentCompletionEffects` REJECTING (the C4
   * pass-24 comment in `registerAgentCompletion` says so: the synchronous guard
   * in `fireIfAlreadyTerminal` "can never catch an async rejection here"). That
   * function posts the reply, the verdict and any question ATOMICALLY in step 1,
   * then reconciles delivery in step 2 and reacts in step 4. A rejection in
   * steps 2 or 4 leaves step 1's writes on the record — so "none of them landed"
   * is false about the one effect a person can see.
   *
   * And step 1's write is what makes the second claim false: it records the
   * `task.agent.replied` audit row, and `recoverUnreactedAgentRuns` selects
   * `NOT EXISTS` that row. The run is excluded from the sweep forever. "Run
   * recovery replays the effects on the next restart" names a mechanism that
   * has already decided, permanently, not to.
   */
  it("F37-67: does not promise a replay the recovery sweep will never run", async () => {
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-3", {
        stage: "impl",
        waiting: "agent",
        ownerUserId: store.users.arda.id,
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    upsertRun(store.db, {
      id: "run_replied_then_lost",
      projectSlug: store.slug,
      taskKey: "VIB-3",
      threadId: "primary",
      role: "developer",
      kind: "primary",
      backend: "claude",
      model: "sonnet",
      sdk: "claude",
      agentName: "dev",
      agentProfileId: "dev",
      state: "finished",
    });
    // Step 1 happened: the reply is on the record, and its idempotency row with
    // it. This is the exact row `recoverUnreactedAgentRuns` excludes on.
    const { recordAudit } = await import("~/server/audit/audit-recorder.server");
    recordAudit(store.db, {
      action: "task.agent.replied",
      actor: { userId: null, label: "operator" },
      subjectKind: "task",
      subjectId: "VIB-3",
      projectSlug: store.slug,
      taskKey: "VIB-3",
      details: { runId: "run_replied_then_lost" },
    });
    const run = getRun(store.db, "run_replied_then_lost")!;

    await noteCompletionEffectsLost(store.db, run, store.dataRoot);

    // The sweep's own verdict on this run, run for real rather than asserted.
    await sweep();
    // Never even picked up: the sweep records its attempt row BEFORE replaying
    // anything, so no row for this run means it was never replayed.
    expect(replayAttempted("run_replied_then_lost")).toBe(false);

    const { readTaskFile } = await import("~/server/files/task-writer.server");
    const note = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-3",
      dataRoot: store.dataRoot,
    })!.parsed.timeline[0]!;
    // CANARY: restore either sentence and the note is telling a person to wait
    // for a restart that will skip this run, about effects it says never landed.
    expect(note.text).not.toContain("none of them landed");
    expect(note.text).not.toContain("recovery replays the effects");
    // It has to say something true instead, not merely say less: the reply is
    // there, the rest is not, and re-running the agent is the way forward.
    expect(note.text).toContain("re-run the agent");
  });

  it("F37-67: a run the sweep WILL replay still gets the promise", async () => {
    // The other arm. Honesty must not be bought by deleting a true promise:
    // this run's reply never landed and it has readable reply text, which is
    // every condition the sweep acts on.
    seedLostRun("VIB-4", "run_never_replied");
    insertRunLine(store.db, {
      runId: "run_never_replied",
      seq: 0,
      occurredAt: new Date().toISOString(),
      raw: "{}",
      display: { t: "1", ev: "text", tag: "assistant", text: "Implemented the parser." },
    });
    await noteCompletionEffectsLost(store.db, getRun(store.db, "run_never_replied")!, store.dataRoot);

    expect((await noteOn("VIB-4")).text).toContain("Run recovery replays the effects");
    await sweep();
    expect(replayAttempted("run_never_replied")).toBe(true);
  });

  it("F37-67: a run with no readable reply is selected and then dropped, and says so", async () => {
    // The sweep's SELECT takes this run — the "recovering dropped agent-reply
    // reactions" log line counts it — and its loop then `continue`s on the
    // missing reply text before recording any attempt. A promise keyed on the
    // query alone would be wrong here with nothing downstream to correct it.
    seedLostRun("VIB-5", "run_no_reply_text");
    await noteCompletionEffectsLost(store.db, getRun(store.db, "run_no_reply_text")!, store.dataRoot);

    expect((await noteOn("VIB-5")).text).not.toContain("recovery replays the effects");
    expect((await noteOn("VIB-5")).text).toContain("re-run the agent");
    await sweep();
    expect(replayAttempted("run_no_reply_text")).toBe(false);
  });
});

/**
 * Rulings 369, 371 and 372 on the run service: every run stamps the kind of
 * credential it bills and carries its kind's context window; a resume of a
 * session that is BOTH idle past its cache TTL AND larger than the replay
 * threshold starts fresh on task.md and the last report, under its own reason,
 * on both backends and for the controller. Every clock is pinned.
 */
describe("ruling 372: the resume policy, and the window and credential kind a run carries", () => {
  const NOW = "2026-09-21T12:00:00.000Z";
  const minutesBefore = (m: number) => new Date(Date.parse(NOW) - m * 60_000).toISOString();

  /** The principal's transcript store, with the session present. */
  async function withSession(backend: "claude" | "codex", sid: string, usageLines: object[] = []): Promise<void> {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const path = (await import("node:path")).default;
    const { userBackendHome } = await import("./user-homes.server");
    const home = userBackendHome(store.users.arda.id, backend, store.dataRoot);
    if (backend === "claude") {
      const dir = path.join(home, "projects", "-w-x");
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, `${sid}.jsonl`), usageLines.map((l) => JSON.stringify(l)).join("\n") + "\n");
      return;
    }
    const dir = path.join(home, "sessions", "2026", "09", "21");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, `rollout-2026-09-21T10-00-00-${sid}.jsonl`),
      [{ timestamp: minutesBefore(120), type: "session_meta", payload: { id: sid } }, ...usageLines]
        .map((l) => JSON.stringify(l))
        .join("\n") + "\n",
    );
  }

  /** A run that answered once and finished; then the prior row is shaped. */
  async function priorRun(input: {
    backend?: "claude" | "codex";
    kind?: "primary" | "controller";
    finishedMinutesAgo: number;
    lastPromptTokens: number;
    credentialKind?: "login" | "api_key" | null;
    transcript?: object[];
  }) {
    const backend = input.backend ?? "claude";
    const sid = `sess-${Math.random().toString(36).slice(2, 8)}`;
    const specs: RunSpec[] = [];
    const capture: RuntimeAdapter = {
      backend,
      start(spec, cb) {
        specs.push(spec);
        cb.onLine({
          raw: JSON.stringify({ type: "assistant" }),
          display: { t: "00:00:00", ev: "text", tag: "assistant", text: "Implemented the attach flow; tests green." },
          facts: {},
          occurredAt: NOW,
        });
        cb.onExit({ outcome: "finished", effectiveBackend: backend, sessionId: sid });
        return { runId: spec.runId, interrupt() {} };
      },
    };
    configureRunServiceForTests({ claude: capture, codex: capture });
    const kind = input.kind ?? "primary";
    // One thread per prior run: a test that shapes two priors on one task
    // must not collide on the (project, task, thread) key.
    const threadId = `t-${sid.slice(5)}`;
    const startInput: TestRunInput = {
      projectSlug: kind === "controller" ? "" : store.slug,
      taskKey: kind === "controller" ? "cnv_test" : "VIB-1",
      threadId,
      role: kind === "controller" ? "Controller" : "Primary specialist",
      // A supporting kind, so two priors on one task never hit the
      // one-delivering-run index either.
      kind: kind === "controller" ? "controller" : "reviewer",
      backend,
      model: "m",
      agentName: kind === "controller" ? "Controller" : "dev",
      agentProfileId: kind === "controller" ? "controller" : `dev-${threadId}`,
      prompt: "go",
      dataRoot: store.dataRoot,
    };
    if (kind === "controller") startInput.workdir = store.dataRoot;
    const { runId } = await startTestRun(store.db, startInput);
    await settle();
    patchRun(store.db, runId, {
      finishedAt: minutesBefore(input.finishedMinutesAgo),
      lastPromptTokens: input.lastPromptTokens,
      credentialKind: input.credentialKind === undefined ? "login" : input.credentialKind,
    });
    await withSession(backend, sid, input.transcript ?? []);
    return {
      runId,
      sid,
      specs,
      resume: (extra: Partial<Parameters<typeof resumeRun>[1]> = {}) =>
        resumeRun(store.db, {
          runId,
          prompt: "follow up",
          credentialUserId: store.users.arda.id,
          dataRoot: store.dataRoot,
          nowIso: NOW,
          ...extra,
        }),
    };
  }

  it("startRun stamps the credential kind and the kind's window on both backends", async () => {
    installFakeRuntime();
    const { runId } = await startTestRun(store.db, {
      projectSlug: store.slug, taskKey: "VIB-1", role: "Primary specialist", kind: "primary",
      backend: "claude", model: "m", prompt: "go", dataRoot: store.dataRoot,
    });
    await settle();
    // Ruling 376: no mid-run window rides the env on any kind.
    expect(lastRunSpec()?.env?.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined();
    // SAFETY: `credential_kind` is a nullable TEXT column of agent_runs.
    const row = store.db.prepare(`SELECT credential_kind FROM agent_runs WHERE id = ?`).get(runId) as { credential_kind: string | null };
    expect(row.credential_kind).toBe("api_key");
    // No kind carries a window (ruling 376); the credential kind still lands.
    await startTestRun(store.db, {
      projectSlug: store.slug, taskKey: "VIB-1", threadId: "op", role: "Operator", kind: "operator",
      backend: "claude", model: "m", prompt: "go", dataRoot: store.dataRoot,
    });
    await settle();
    expect(lastRunSpec()?.env?.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined();
    await startTestRun(store.db, {
      projectSlug: "", taskKey: "cnv_w", threadId: "cnv_w", role: "Controller", kind: "controller",
      backend: "claude", model: "m", prompt: "go", dataRoot: store.dataRoot, workdir: store.dataRoot,
      agentProfileId: "controller",
    });
    await settle();
    expect(lastRunSpec()?.env?.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined();
    await startTestRun(store.db, {
      projectSlug: store.slug, taskKey: "VIB-1", threadId: "r1", role: "Reviewer", kind: "reviewer",
      backend: "codex", model: "m", prompt: "go", dataRoot: store.dataRoot,
    });
    await settle();
    expect(lastRunSpec()?.env?.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined();
  });

  it("a session idle past its TTL AND large starts fresh on task.md and the last report, under its own reason", async () => {
    const prior = await priorRun({ finishedMinutesAgo: 74, lastPromptTokens: 298_000 });
    const resumed = await prior.resume();
    await settle();
    expect(resumed).toMatchObject({ continuityReset: true, continuityLossReason: "stale_large_session" });
    const spec = prior.specs.find((s) => s.runId === resumed.runId)!;
    expect(spec.resumeSessionId).toBeNull();
    expect(spec.prompt).toContain("set aside on purpose");
    expect(spec.prompt).toContain("298k tokens");
    expect(spec.prompt).toContain("idle 1 hour 14 minutes");
    expect(spec.prompt).toContain("Implemented the attach flow; tests green.");
    expect(spec.prompt.endsWith("follow up")).toBe(true);
    // The set-aside session's last run carries a meta line, not a failure.
    const lines = listRunLines(store.db, prior.runId);
    const marker = lines.find((l) => l.display.tag === "run·session_stale");
    expect(marker?.display.ev).toBe("meta");
    expect(marker?.display.text).toContain("not resumed on purpose");
    expect(lines.some((l) => l.display.tag.endsWith("session_missing"))).toBe(false);
    // The timeline says a fresh session was started, and why.
    const task = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot })!;
    const note = task.parsed.timeline.find((e) => e.type === "continuity");
    expect(note?.text).toContain("Started a fresh session");
    expect(note?.text).toContain("298k tokens and 1 hour 14 minutes old");
    // …and the fresh row's start audit records the reason.
    const started = listAuditEvents(store.db, { action: "runtime.run.started" }).find(
      (e) => e.subjectId === resumed.runId,
    );
    expect(started?.details).toMatchObject({ continuityReset: "stale_large_session", resumed: false });
  });

  it("warm and large, or stale and small, resumes the stored session", async () => {
    const warm = await priorRun({ finishedMinutesAgo: 16, lastPromptTokens: 298_000 });
    const resumedWarm = await warm.resume();
    await settle();
    expect(resumedWarm.continuityReset).toBeUndefined();
    expect(warm.specs.find((s) => s.runId === resumedWarm.runId)?.resumeSessionId).toBe(warm.sid);
    const small = await priorRun({ finishedMinutesAgo: 600, lastPromptTokens: 100_000 });
    const resumedSmall = await small.resume();
    await settle();
    expect(resumedSmall.continuityReset).toBeUndefined();
    expect(small.specs.find((s) => s.runId === resumedSmall.runId)?.resumeSessionId).toBe(small.sid);
  });

  it("an API key's TTL is five minutes; a row with no kind reads as a sign-in", async () => {
    const key = await priorRun({ finishedMinutesAgo: 6, lastPromptTokens: 200_000, credentialKind: "api_key" });
    expect((await key.resume()).continuityLossReason).toBe("stale_large_session");
    await settle();
    const unknown = await priorRun({ finishedMinutesAgo: 6, lastPromptTokens: 200_000, credentialKind: null });
    expect((await unknown.resume()).continuityReset).toBeUndefined();
    await settle();
  });

  it("reads the size off the provider's transcript when the row never folded one", async () => {
    const usage = (write: number, read: number) => ({
      type: "assistant",
      isSidechain: false,
      message: { usage: { input_tokens: 2, cache_creation_input_tokens: write, cache_read_input_tokens: read } },
    });
    const prior = await priorRun({
      finishedMinutesAgo: 74,
      lastPromptTokens: 0,
      transcript: [usage(100, 0), usage(500, 199_000)],
    });
    const resumed = await prior.resume();
    await settle();
    expect(resumed.continuityLossReason).toBe("stale_large_session");
    expect(prior.specs.find((s) => s.runId === resumed.runId)?.prompt).toContain("200k tokens");
  });

  it("Codex: ten minutes idle on a large thread starts fresh; nine resumes", async () => {
    const token = (input: number) => ({
      timestamp: minutesBefore(100),
      type: "event_msg",
      payload: { type: "token_count", info: { last_token_usage: { input_tokens: input, cached_input_tokens: 0 } } },
    });
    const stale = await priorRun({ backend: "codex", finishedMinutesAgo: 11, lastPromptTokens: 0, transcript: [token(200_000)] });
    const fresh = await stale.resume();
    await settle();
    expect(fresh.continuityLossReason).toBe("stale_large_session");
    expect(stale.specs.find((s) => s.runId === fresh.runId)?.prompt).toContain("Your previous Codex session");
    const recent = await priorRun({ backend: "codex", finishedMinutesAgo: 9, lastPromptTokens: 200_000 });
    const kept = await recent.resume();
    await settle();
    expect(kept.continuityReset).toBeUndefined();
  });

  it("the controller follows the same rule, and its fresh turn points at the digest it carries", async () => {
    const prior = await priorRun({ kind: "controller", finishedMinutesAgo: 71, lastPromptTokens: 945_000 });
    const resumed = await prior.resume({ workdir: store.dataRoot });
    await settle();
    expect(resumed.continuityLossReason).toBe("stale_large_session");
    const spec = prior.specs.find((s) => s.runId === resumed.runId)!;
    expect(spec.resumeSessionId).toBeNull();
    expect(spec.prompt).toContain("session for this conversation was set aside on purpose");
    expect(spec.prompt).toContain("945k tokens");
    expect(spec.prompt).toContain("recent-conversation digest");
    // No task file to note on: the run's own meta line is the record.
    expect(listRunLines(store.db, prior.runId).some((l) => l.display.tag === "run·session_stale")).toBe(true);
  });
});

/**
 * Ruling 376: a session larger than the completion threshold is compacted
 * at the end of its run, while its cache is warm, and the run's record says
 * so; a small session, an interrupted run and a backend that cannot compact
 * are left alone.
 */
describe("compaction at completion (ruling 376)", () => {
  const bigCall = {
    cache: {
      messageId: "m1",
      promptTokens: 120_000,
      cacheWrite: 2_000,
      cacheRead: 118_000,
      perCall: true,
      ttl: { fiveMinute: 0, oneHour: 2_000 },
      missReason: null,
    },
  };
  const finished = (sessionId: string, promptTokens: number): FakeRun => ({
    sessionId,
    lines: [
      { t: "1", ev: "init", tag: "system·init", text: "session" },
      { t: "2", ev: "text", tag: "assistant", text: "read a lot" },
      { t: "3", ev: "result", tag: "result", text: "done", stats: { dur: 100, api: 90, turns: 2, cost: 4, in: promptTokens, cached: 0, out: 500 } },
    ],
    extraFacts: [undefined, { cache: { ...bigCall.cache, promptTokens } }, undefined],
  });

  it("compacts a finished run above 100k and folds the result", async () => {
    const before = compactedRunSpecs().length;
    queueFakeRun(finished("sess-big", 120_000));
    queueFakeCompaction("claude", { compacted: true, preTokens: 120_000, postTokens: 18_000 });
    const { runId } = await startTestRun(store.db, {
      projectSlug: store.slug, taskKey: "VIB-1", role: "Primary specialist", kind: "primary",
      backend: "claude", model: "claude-sonnet-4-5", prompt: "go", dataRoot: store.dataRoot,
    });
    await settle();
    await settle();
    const asked = compactedRunSpecs().slice(before);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ sessionId: "sess-big", spec: { runId } });
    const run = getRun(store.db, runId)!;
    expect(run.state).toBe("finished");
    expect(run.phase).toBeNull();
    expect(run.compactions).toBe(1);
    // What a resume replays now (ruling 372 reads it): the summary.
    expect(run.last_prompt_tokens).toBe(18_000);
    expect(run.peak_prompt_tokens).toBe(120_000);
    // The compaction's own cost rides the run's total.
    expect(run.total_cost_usd).toBeCloseTo(4.5, 5);
    expect(JSON.stringify(listRunLines(store.db, runId))).toContain("run·compacted·completion");
    const audit = listAuditEvents(store.db, { action: "task.agent.compaction" }).filter((e) => e.subjectId === runId);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.details).toMatchObject({ trigger: "completion", preTokens: 120_000, postTokens: 18_000 });
  });

  it("U39-30: tells a caller the answer is written before it compacts, and only then", async () => {
    // Live on ax-clone a controller reply sat behind a 27-second completion
    // compaction. CANARY: drop the `answered()` call and nothing fires.
    const before = compactedRunSpecs().length;
    let open!: () => void;
    queueFakeRun({ ...finished("sess-answered", 120_000), gate: new Promise<void>((r) => (open = r)) });
    queueFakeCompaction("claude", { compacted: true, preTokens: 120_000, postTokens: 18_000 });
    const { runId } = await startTestRun(store.db, {
      projectSlug: store.slug, taskKey: "VIB-1", role: "Primary specialist", kind: "primary",
      backend: "claude", model: "claude-sonnet-4-5", prompt: "go", dataRoot: store.dataRoot,
    });
    const order: string[] = [];
    registerRunAnswered(runId, () => {
      order.push(`answered:${compactedRunSpecs().length - before}`);
      // The answer is already in the run's lines.
      expect(JSON.stringify(listRunLines(store.db, runId))).toContain("read a lot");
    });
    registerRunCompletion(runId, () => order.push(`completed:${compactedRunSpecs().length - before}`));
    open();
    await settle();
    await settle();
    expect(order).toEqual(["answered:0", "completed:1"]);
  });

  it("U39-30: a run that is not compacted never fires the answered callback", async () => {
    let open!: () => void;
    queueFakeRun({ ...finished("sess-small-answer", 60_000), gate: new Promise<void>((r) => (open = r)) });
    const { runId } = await startTestRun(store.db, {
      projectSlug: store.slug, taskKey: "VIB-1", role: "Primary specialist", kind: "primary",
      backend: "claude", model: "claude-sonnet-4-5", prompt: "go", dataRoot: store.dataRoot,
    });
    const order: string[] = [];
    registerRunAnswered(runId, () => order.push("answered"));
    registerRunCompletion(runId, () => order.push("completed"));
    open();
    await settle();
    await settle();
    expect(order).toEqual(["completed"]);
  });

  it("leaves a run under the threshold alone", async () => {
    const before = compactedRunSpecs().length;
    queueFakeRun(finished("sess-small", 60_000));
    queueFakeCompaction("claude", { compacted: true, preTokens: 60_000, postTokens: 9_000 });
    const { runId } = await startTestRun(store.db, {
      projectSlug: store.slug, taskKey: "VIB-1", role: "Primary specialist", kind: "primary",
      backend: "claude", model: "claude-sonnet-4-5", prompt: "go", dataRoot: store.dataRoot,
    });
    await settle();
    await settle();
    expect(compactedRunSpecs().length).toBe(before);
    expect(getRun(store.db, runId)!.compactions).toBe(0);
    expect(getRun(store.db, runId)!.last_prompt_tokens).toBe(60_000);
  });

  it("leaves an interrupted run alone, whatever its size", async () => {
    const before = compactedRunSpecs().length;
    queueFakeRun({ ...finished("sess-stopped", 150_000), keepRunning: true });
    queueFakeCompaction("claude", { compacted: true, preTokens: 150_000, postTokens: 20_000 });
    const { runId } = await startTestRun(store.db, {
      projectSlug: store.slug, taskKey: "VIB-1", role: "Primary specialist", kind: "primary",
      backend: "claude", model: "claude-sonnet-4-5", prompt: "go", dataRoot: store.dataRoot,
    });
    await settle();
    await interruptRun(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot, runId },
      { userId: store.users.arda.id, label: store.users.arda.email },
    );
    await settle();
    expect(compactedRunSpecs().length).toBe(before);
    expect(getRun(store.db, runId)!.state).toBe("interrupted");
    expect(getRun(store.db, runId)!.compactions).toBe(0);
  });

  it("on Codex the rollout is the truth: a compaction the app-server did not announce still counts", async () => {
    // The fake adapter answers "not compacted"; the rollout on disk says otherwise.
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const path = await import("node:path");
    const sid = "01a0c4e5-dcff-7cd2-b82f-251a14792b47";
    const dir = path.join(store.dataRoot, "runtimes", "users", store.users.arda.id, "codex-home", "sessions", "2026", "09", "21");
    mkdirSync(dir, { recursive: true });
    // The reader windows the rollout by the run's start, so the lines sit
    // just AFTER this test's clock (the run starts below).
    const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
    const line = (ts: string, input: number) =>
      JSON.stringify({ timestamp: ts, type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: input, cached_input_tokens: 0 } } } });
    const rollout = path.join(dir, `rollout-2026-09-21T17-00-00-${sid}.jsonl`);
    // At the run's exit the rollout holds the calls and no compaction.
    writeFileSync(
      rollout,
      [
        JSON.stringify({ timestamp: at(60_000), type: "session_meta", payload: { id: sid } }),
        line(at(60_100), 60_000),
        line(at(60_200), 123_508),
      ].join("\n") + "\n",
    );
    const { codexRolloutRunStats } = await import("./session-export.server");
    expect(codexRolloutRunStats(store.users.arda.id, sid, null, store.dataRoot)).toMatchObject({ calls: 2, compactions: 0 });
    const { appendFileSync } = await import("node:fs");
    const before = compactedRunSpecs().length;
    queueFakeRun({
      ...finished(sid, 123_508),
      backend: "codex",
      lines: [
        { t: "1", ev: "init", tag: "thread.started", text: "thread" },
        { t: "2", ev: "result", tag: "turn.completed", text: "done", stats: { dur: 100, api: 90, turns: 1, cost: 0, in: 123_508, cached: 0, out: 200 } },
      ],
      extraFacts: [undefined, undefined],
    });
    // The "app-server" compacts the thread — the rollout gains the line and
    // the post-size call — but its reply never reaches the client in time.
    queueFakeCompaction(
      "codex",
      { compacted: false, reason: "the app-server did not report a compaction within 300s" },
      () => {
        appendFileSync(
          rollout,
          [
            JSON.stringify({ timestamp: at(60_300), type: "compacted", payload: { message: "", replacement_history: [] } }),
            line(at(60_400), 6_914),
          ].join("\n") + "\n",
        );
      },
    );
    const { runId } = await startTestRun(store.db, {
      projectSlug: store.slug, taskKey: "VIB-1", role: "Primary specialist", kind: "primary",
      backend: "codex", model: "gpt-5.6-terra", prompt: "go", dataRoot: store.dataRoot,
    });
    await settle();
    await settle();
    for (let i = 0; i < 30; i += 1) await new Promise((r) => setTimeout(r, 0));
    expect(compactedRunSpecs().length).toBe(before + 1);
    const run = getRun(store.db, runId)!;
    expect(run.state).toBe("finished");
    expect(run.compactions).toBe(1);
    expect(run.last_prompt_tokens).toBe(6_914);
    expect(run.peak_prompt_tokens).toBe(123_508);
    const audit = listAuditEvents(store.db, { action: "task.agent.compaction" }).filter((e) => e.subjectId === runId);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.details).toMatchObject({ trigger: "completion", backend: "codex", preTokens: 123_508, postTokens: 6_914 });
  });

  /**
   * Ruling 414 (F39-40). The CLI writes ONE compaction as two spellings with
   * its own size line between them. Live on ax-clone, every one of the 69
   * completion compactions left TWO timeline notes and two audit rows 2-11 ms
   * apart: "Viberr summarized ... at the end of the run" and "the provider
   * summarized ... (auto)", the second a compaction that never happened. Both
   * printed the phantom's missing size ("to 0k tokens", then "to a summary")
   * while the rollout had measured the real one.
   */
  it("on Codex one completion compaction is ONE audit row, with the size the rollout measured", async () => {
    const { writeFileSync, mkdirSync, appendFileSync } = await import("node:fs");
    const path = await import("node:path");
    const sid = "01a0ca89-0673-71c3-93c8-208b9564c414";
    const dir = path.join(store.dataRoot, "runtimes", "users", store.users.arda.id, "codex-home", "sessions", "2026", "09", "22");
    mkdirSync(dir, { recursive: true });
    const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
    const ev = (ts: string, payload: RolloutEventPayload) =>
      JSON.stringify({ timestamp: ts, type: "event_msg", payload });
    const usage = (input: number, total: number) => ({
      type: "token_count",
      info: { last_token_usage: { input_tokens: input, cached_input_tokens: 0, total_tokens: total } },
    });
    const rollout = path.join(dir, `rollout-2026-09-22T19-12-52-${sid}.jsonl`);
    writeFileSync(
      rollout,
      [
        JSON.stringify({ timestamp: at(60_000), type: "session_meta", payload: { id: sid } }),
        ev(at(60_100), usage(190_309, 191_202)),
      ].join("\n") + "\n",
    );
    queueFakeRun({
      ...finished(sid, 190_309),
      backend: "codex",
      lines: [
        { t: "1", ev: "init", tag: "thread.started", text: "thread" },
        { t: "2", ev: "result", tag: "turn.completed", text: "done", stats: { dur: 100, api: 90, turns: 1, cost: 0, in: 190_309, cached: 0, out: 200 } },
      ],
      extraFacts: [undefined, undefined],
    });
    // The app-server compacts the thread and the CLI writes exactly what it
    // wrote for AX-24 at 19:28:58.
    queueFakeCompaction("codex", { compacted: true, preTokens: null, postTokens: null }, () => {
      appendFileSync(
        rollout,
        [
          JSON.stringify({ timestamp: at(60_300), type: "compacted", payload: { message: "", replacement_history: [] } }),
          ev(at(60_301), { type: "thread_settings_applied" }),
          ev(at(60_302), usage(0, 9_083)),
          ev(at(60_303), { type: "item_completed", item: { type: "ContextCompaction", id: "c1" } }),
        ].join("\n") + "\n",
      );
    });
    const { runId } = await startTestRun(store.db, {
      projectSlug: store.slug, taskKey: "VIB-1", role: "Primary specialist", kind: "primary",
      backend: "codex", model: "gpt-5.6-luna", prompt: "go", dataRoot: store.dataRoot,
    });
    await settle();
    await settle();
    for (let i = 0; i < 30; i += 1) await new Promise((r) => setTimeout(r, 0));
    const run = getRun(store.db, runId)!;
    expect(run.compactions).toBe(1);
    expect(run.last_prompt_tokens).toBe(9_083);
    const audit = listAuditEvents(store.db, { action: "task.agent.compaction" }).filter((e) => e.subjectId === runId);
    // Canary: the phantom second event is a second row, trigger "auto".
    expect(audit.map((e) => e.details)).toEqual([
      expect.objectContaining({ trigger: "completion", preTokens: 190_309, postTokens: 9_083 }),
    ]);
  });

  it("a refused compaction leaves the run finished with its size, and says why on the log", async () => {
    const before = compactedRunSpecs().length;
    queueFakeRun(finished("sess-refused", 130_000));
    queueFakeCompaction("claude", { compacted: false, reason: "Not enough messages to compact." });
    const { runId } = await startTestRun(store.db, {
      projectSlug: store.slug, taskKey: "VIB-1", role: "Primary specialist", kind: "primary",
      backend: "claude", model: "claude-sonnet-4-5", prompt: "go", dataRoot: store.dataRoot,
    });
    await settle();
    await settle();
    expect(compactedRunSpecs().length).toBe(before + 1);
    const run = getRun(store.db, runId)!;
    expect(run.state).toBe("finished");
    expect(run.compactions).toBe(0);
    expect(run.last_prompt_tokens).toBe(130_000);
  });
});

