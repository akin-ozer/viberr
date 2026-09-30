import { afterEach, describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { z } from "zod";
import type {
  CodexOptions,
  RunStreamedResult,
  ThreadOptions,
} from "@openai/codex-sdk";
import type { EmittedLine, RunExit, RunSpec } from "./adapter.server";
import { RUN_PHASE } from "./adapter.server";
import {
  CODEX_SDK_VERIFIED_VERSION,
  createCodexAdapter,
  INTERRUPT_SETTLE_GRACE_MS,
  shareOutputSchemaWithAgent,
  type CodexClient,
  type CodexThread,
} from "./codex-runtime.server";
import { shareFileForAgentsToRead } from "./agent-isolation.server";
import { createTestDbContext } from "../../../test-support/test-db";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { codexVendor } from "./codex-app-server.server";
import path from "node:path";
import { backendAccountHome, ensureUserBackendHome } from "./user-homes.server";
import { insertRunLine, upsertRun } from "./run-store.server";
import { runFailureReason } from "../tasks/agent-reply.server";
import { resetEnvCacheForTests } from "../config/env.server";
import type { ReapTargets } from "./run-processes.server";

/**
 * The seam that lets a fake stream carry events the SDK's own type forbids.
 * That is the point: the adapter consumes a stream it did not write, so these
 * tests feed it malformed, unknown and never-yielding streams on purpose.
 */
function asSdkEvents(
  events: AsyncIterable<unknown>,
): RunStreamedResult["events"] {
  // SAFETY: nothing in this file dereferences an event as a `ThreadEvent` —
  // every one is handed straight to the adapter, whose whole job is to decode
  // (or survive) whatever the provider streamed.
  return events as RunStreamedResult["events"];
}

/**
 * A stream that rejects on its first pull: the SDK's shape when the request
 * fails before a single event arrives. Written as an explicit iterator because
 * a stream that only ever throws is not a generator — it has nothing to yield.
 */
function failingEvents(error: Error): RunStreamedResult["events"] {
  return asSdkEvents({
    [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(error) }),
  });
}

/**
 * A stream whose first pull never settles until `signal` aborts — the idle
 * guard is the only thing that can end the run.
 */
function stalledEvents(signal?: AbortSignal): RunStreamedResult["events"] {
  return asSdkEvents({
    [Symbol.asyncIterator]: () => ({
      next: () =>
        new Promise<IteratorResult<unknown>>((_resolve, reject) => {
          signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    }),
  });
}

/** A fake Codex client plus the options each entry point recorded. */
interface FakeCodex {
  factory: (options?: CodexOptions) => CodexClient;
  startOptions: () => ThreadOptions | undefined;
  resumeOptions: () => ThreadOptions | undefined;
  factoryOptions: () => CodexOptions | undefined;
}

/** A fake Codex client: yields the given ThreadEvents, honors abort signal,
 *  and records the options passed to startThread. */
function fakeCodex(events: unknown[]): FakeCodex {
  let startOpts: ThreadOptions | undefined;
  let resumeOpts: ThreadOptions | undefined;
  let factoryOpts: CodexOptions | undefined;
  const makeThread = (): CodexThread => ({
    id: "0199a1f3-4c02-7d31",
    async runStreamed(_input, turnOptions) {
      const signal = turnOptions?.signal;
      const gen = (async function* () {
        for (const e of events) {
          if (signal?.aborted) throw new DOMException("aborted", "AbortError");
          yield e;
          // Yield to the event loop so an abort between events takes effect.
          await new Promise((r) => setTimeout(r, 0));
        }
      })();
      return { events: asSdkEvents(gen) };
    },
  });
  const client: CodexClient = {
    startThread: (opts) => {
      startOpts = opts;
      return makeThread();
    },
    resumeThread: (_id, opts) => {
      resumeOpts = opts;
      return makeThread();
    },
  };
  return {
    factory: (options) => {
      factoryOpts = options;
      return client;
    },
    startOptions: () => startOpts,
    resumeOptions: () => resumeOpts,
    factoryOptions: () => factoryOpts,
  };
}

const SPEC: RunSpec = {
  runId: "r1",
  projectSlug: "viberr-core",
  taskKey: "VIB-1",
  threadId: "primary",
  role: "Primary specialist",
  kind: "primary",
  backend: "codex",
  model: "gpt-5.4-codex",
  prompt: "advise",
  workdir: "/tmp/x",
  autonomous: true,
};

async function drain(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
}

describe("codex adapter (SDK, injected fake client)", () => {
  it("streams ThreadEvents → EmittedLine and finishes on turn.completed", async () => {
    const events = [
      { type: "thread.started", thread_id: "0199abc" },
      { type: "turn.started" },
      {
        type: "item.completed",
        item: { type: "agent_message", text: "advice" },
      },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 100,
          cached_input_tokens: 80,
          output_tokens: 20,
        },
      },
    ];
    const { factory } = fakeCodex(events);
    const adapter = createCodexAdapter({ codexFactory: factory });
    const lines: EmittedLine[] = [];
    let exit: RunExit | null = null;
    adapter.start(SPEC, {
      onLine: (l) => lines.push(l),
      onExit: (e) => (exit = e),
    });
    await drain();

    expect(lines.length).toBe(4);
    expect(JSON.parse(lines[0]!.raw).type).toBe("thread.started");
    expect(lines[0]!.facts.sessionId).toBe("0199abc");
    expect(exit).toMatchObject({
      outcome: "finished",
      effectiveBackend: "codex",
    });
  });

  // SDK 0.153.4: `max` joined the union and the bundled catalog lists it on
  // every current model, so it is forwarded. In the union too, deliberately
  // NOT forwarded: `ultra` is automatic task delegation (sub-agents, the
  // operator's job); `persistent` is supported by no bundled model. Canary: add
  // either case to the switch. A tier Viberr does not forward, or none at all,
  // is omitted, so the CLI applies its own default instead of running a mode
  // the deployment never chose.
  it.each([
    ["high", "high"],
    ["max", "max"],
    ["minimal", "minimal"],
    ["xhigh", "xhigh"],
    ["ultra", undefined],
    ["persistent", undefined],
    ["", undefined],
    [undefined, undefined],
  ] as const)("effort %j reaches startThread as %j", async (effort, expected) => {
    const run = fakeCodex([
      { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
    ]);
    createCodexAdapter({ codexFactory: run.factory }).start(
      effort === undefined ? SPEC : { ...SPEC, effort },
      { onLine: () => {}, onExit: () => {} },
    );
    await drain();
    expect(run.startOptions()?.model).toBe("gpt-5.4-codex");
    expect(run.startOptions()?.modelReasoningEffort).toBe(expected);
  });

  it("resume uses the same supported thread options as start (model, effort, sandbox, workdir, approval)", async () => {
    const resumed = fakeCodex([
      { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
    ]);
    createCodexAdapter({ codexFactory: resumed.factory }).start(
      { ...SPEC, resumeSessionId: "thread-1", effort: "high" },
      { onLine: () => {}, onExit: () => {} },
    );
    await drain();
    expect(resumed.resumeOptions()).toMatchObject({
      model: SPEC.model,
      modelReasoningEffort: "high",
      sandboxMode: "danger-full-access",
      workingDirectory: SPEC.workdir,
      skipGitRepoCheck: true,
      approvalPolicy: "never",
    });
  });

  it("keeps subscription auth in the CLI env but out of generated shells", async () => {
    const run = fakeCodex([
      { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
    ]);
    createCodexAdapter({
      codexFactory: run.factory,
      env: {
        PATH: "/usr/bin",
        CODEX_ACCESS_TOKEN: "sentinel-subscription-token",
      },
    }).start(
      {
        ...SPEC,
        systemPrompt: "Act as the deployed specialist.",
        env: { GIT_CEILING_DIRECTORIES: "/safe/task" },
        mcpServers: {
          docs: { type: "http", url: "https://mcp.example.test" },
          local: { command: "npx", args: ["-y", "example-mcp"] },
          viberr: { type: "sdk", instance: {} },
          malformed: { command: "npx", args: ["ok", 42] },
          viberr_browser: { command: "node", args: ["browser-supervisor.server.ts", "cli.js"] },
        },
      },
      { onLine: () => {}, onExit: () => {} },
    );
    await drain();

    const options = run.factoryOptions();
    expect(options?.env?.CODEX_ACCESS_TOKEN).toBe(
      "sentinel-subscription-token",
    );
    expect(options?.config).toMatchObject({
      developer_instructions: "Act as the deployed specialist.",
      allow_login_shell: false,
      features: { apps: false },
      memories: {
        generate_memories: false,
        use_memories: false,
        dedicated_tools: false,
      },
      mcp_servers: {
        docs: {
          url: "https://mcp.example.test",
          default_tools_approval_mode: "approve",
        },
        local: {
          command: "npx",
          args: ["-y", "example-mcp"],
          default_tools_approval_mode: "approve",
        },
      },
      shell_environment_policy: {
        inherit: "core",
        ignore_default_excludes: false,
        set: { GIT_CEILING_DIRECTORIES: "/safe/task" },
      },
    });
    expect(JSON.stringify(options?.config)).not.toContain(
      "sentinel-subscription-token",
    );
    expect(options?.config?.mcp_servers).toEqual({
      docs: {
        url: "https://mcp.example.test",
        default_tools_approval_mode: "approve",
      },
      local: {
        command: "npx",
        args: ["-y", "example-mcp"],
        default_tools_approval_mode: "approve",
      },
      // Ruling 554: Codex waits past the supervisor's deadline, so the model
      // reads the supervisor's "restarted" answer rather than a bare timeout.
      // CANARY: drop the browser's `tool_timeout_sec` and Codex gives up first.
      viberr_browser: {
        command: "node",
        args: ["browser-supervisor.server.ts", "cli.js"],
        default_tools_approval_mode: "approve",
        tool_timeout_sec: 120,
      },
    });
  });

  it("overlays spec.env on a COMPLETE base env, never on {} (#3)", async () => {
    // The Codex SDK replaces the child env wholesale. Per-run env (e.g.
    // GIT_CEILING_DIRECTORIES) must land on top of a full process.env snapshot
    // so PATH/HOME survive — overlaying onto {} would break the spawned binary.
    const run = fakeCodex([
      { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
    ]);
    createCodexAdapter({ codexFactory: run.factory }).start(
      { ...SPEC, env: { GIT_CEILING_DIRECTORIES: "/ceil" } },
      { onLine: () => {}, onExit: () => {} },
    );
    await drain();
    expect(run.factoryOptions()?.env?.GIT_CEILING_DIRECTORIES).toBe("/ceil");
    // PATH from the real process.env must have survived the overlay.
    expect(run.factoryOptions()?.env?.PATH).toBe(process.env.PATH);
  });

  it("passes no env override when neither deps.env nor spec.env is set (#3)", async () => {
    const run = fakeCodex([
      { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
    ]);
    createCodexAdapter({ codexFactory: run.factory }).start(SPEC, {
      onLine: () => {},
      onExit: () => {},
    });
    await drain();
    const factoryOpts = run.factoryOptions();
    // Config is always present to enforce shell isolation, but no child-env
    // override is fabricated; the SDK can inherit the real process env.
    expect(factoryOpts).toMatchObject({
      config: {
        allow_login_shell: false,
        features: { apps: false },
        shell_environment_policy: {
          inherit: "core",
          ignore_default_excludes: false,
        },
      },
    });
    expect(factoryOpts?.env).toBeUndefined();
  });

  it("errors on turn.failed", async () => {
    const { factory } = fakeCodex([
      { type: "turn.started" },
      { type: "turn.failed", error: { message: "model stream ended" } },
    ]);
    const adapter = createCodexAdapter({ codexFactory: factory });
    let exit: RunExit | null = null;
    adapter.start(SPEC, { onLine: () => {}, onExit: (e) => (exit = e) });
    await drain();
    expect(exit).toMatchObject({ outcome: "error" });
  });

  it("does not fail a completed turn for a non-fatal ErrorItem", async () => {
    const { factory } = fakeCodex([
      {
        type: "item.completed",
        item: { id: "err-1", type: "error", message: "tool retry warning" },
      },
      {
        type: "turn.completed",
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    ]);
    const lines: EmittedLine[] = [];
    let exit: RunExit | null = null;
    createCodexAdapter({ codexFactory: factory }).start(SPEC, {
      onLine: (line) => lines.push(line),
      onExit: (value) => (exit = value),
    });
    await drain();

    expect(lines[0]?.display).toMatchObject({ ev: "err", tag: "error" });
    expect(lines[0]?.facts.isError).toBeUndefined();
    expect(exit).toMatchObject({ outcome: "finished" });
  });

  it("errors when the stream ends with no turn.completed", async () => {
    const { factory } = fakeCodex([
      { type: "thread.started", thread_id: "x" },
      { type: "turn.started" },
    ]);
    const adapter = createCodexAdapter({ codexFactory: factory });
    let exit: RunExit | null = null;
    const lines: EmittedLine[] = [];
    adapter.start(SPEC, {
      onLine: (line) => lines.push(line),
      onExit: (e) => (exit = e),
    });
    await drain();
    expect(exit).toMatchObject({ outcome: "error" });
    expect(lines.at(-1)?.display).toMatchObject({
      ev: "err",
      text: "Codex ended before reporting turn completion.",
    });
  });

  it("persists a sanitized fatal event when the SDK stream throws", async () => {
    const thread: CodexThread = {
      id: "thread-1",
      async runStreamed() {
        return {
          events: failingEvents(
            new Error("request failed with sk-secretsentinel0123456789"),
          ),
        };
      },
    };
    const client: CodexClient = {
      startThread: () => thread,
      resumeThread: () => thread,
    };
    const lines: EmittedLine[] = [];
    let exit: RunExit | null = null;
    createCodexAdapter({ codexFactory: () => client }).start(SPEC, {
      onLine: (line) => lines.push(line),
      onExit: (value) => (exit = value),
    });
    await drain();

    expect(exit).toMatchObject({ outcome: "error" });
    // R20-3 (F20-4): the canonical sentence still leads, but the provider's own
    // words now ride behind the marker — with a token-shaped secret redacted.
    const errText = lines.at(-1)?.display?.text ?? "";
    expect(errText).toContain(
      "Codex execution failed. Review its authentication and runtime configuration.",
    );
    expect(errText).toContain("The provider reported:");
    expect(errText).toContain("request failed with [redacted]");
    expect(errText).not.toContain("sk-secretsentinel0123456789");
    expect(lines.at(-1)?.raw).not.toContain("sk-secretsentinel0123456789");
  });

  it("F22-08: classifies a usage-limit reported ONLY in a turn.failed event, not the exit banner", async () => {
    // The real Codex quota failure: the SDK streams the actionable reason as a
    // `turn.failed` event, THEN the iterator throws a bare exit banner that
    // carries none of it. Classifying on the thrown banner alone (the old
    // behavior) routed this to the generic auth/config branch and dropped the
    // retry date. The adapter must read the reason from the event.
    const usageLimit =
      "You've hit your usage limit. To continue using Codex, start a free trial of Plus today, or try again at Sep 18th, 2026 5:20 PM.";
    const exitBanner = new Error(
      "Codex Exec exited with code 1: Reading prompt from stdin...",
    );
    const thread: CodexThread = {
      id: "thread-quota",
      async runStreamed() {
        return {
          events: asSdkEvents({
            async *[Symbol.asyncIterator]() {
              yield { type: "thread.started", thread_id: "thread-quota" };
              yield { type: "turn.failed", error: { message: usageLimit } };
              throw exitBanner;
            },
          }),
        };
      },
    };
    const client: CodexClient = {
      startThread: () => thread,
      resumeThread: () => thread,
    };
    const lines: EmittedLine[] = [];
    let exit: RunExit | null = null;
    createCodexAdapter({ codexFactory: () => client }).start(SPEC, {
      onLine: (line) => lines.push(line),
      onExit: (value) => (exit = value),
    });
    await drain();

    expect(exit).toMatchObject({ outcome: "error" });
    const err = lines.at(-1);
    // Quota class + its canonical sentence, NOT the generic "review its
    // authentication and runtime configuration".
    expect(err?.display).toMatchObject({ ev: "err", tag: "error·quota" });
    const errText = err?.display?.text ?? "";
    expect(errText).toContain(
      "Codex usage limit was reached. Retry after the subscription limit resets.",
    );
    expect(errText).not.toContain("runtime configuration");
    // The provider's own actionable words (incl. the retry date) ride behind
    // the marker — sourced from the event, not the exit banner.
    expect(errText).toContain("Sep 18th, 2026");
    expect(errText).not.toContain("Reading prompt from stdin");
  });

  it("F22-08: surfaces a fatal turn.failed even when the iterator does NOT throw", async () => {
    // A `turn.failed` can arrive and the stream then end cleanly. The old code
    // settled `error` silently (no message) in that path.
    const reason = "Model gpt-5.6-terra is not available for this account.";
    const thread: CodexThread = {
      id: "thread-clean",
      async runStreamed() {
        return {
          events: asSdkEvents({
            async *[Symbol.asyncIterator]() {
              yield { type: "thread.started", thread_id: "thread-clean" };
              yield { type: "turn.failed", error: { message: reason } };
              // stream ends without throwing
            },
          }),
        };
      },
    };
    const client: CodexClient = {
      startThread: () => thread,
      resumeThread: () => thread,
    };
    const lines: EmittedLine[] = [];
    let exit: RunExit | null = null;
    createCodexAdapter({ codexFactory: () => client }).start(SPEC, {
      onLine: (line) => lines.push(line),
      onExit: (value) => (exit = value),
    });
    await drain();

    expect(exit).toMatchObject({ outcome: "error" });
    const errText = lines.at(-1)?.display?.text ?? "";
    // Not the "ended before reporting turn completion" fallback — the real
    // reason is surfaced.
    expect(errText).not.toContain("ended before reporting turn completion");
    expect(errText).toContain("The provider reported:");
    expect(errText).toContain("not available for this account");
  });

  it("interrupt() aborts the signal and ends interrupted", async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      type: "item.completed",
      item: { type: "agent_message", text: "m" + i },
    }));
    const { factory } = fakeCodex([
      { type: "thread.started", thread_id: "x" },
      ...many,
    ]);
    const adapter = createCodexAdapter({ codexFactory: factory });
    let exit: RunExit | null = null;
    const handle = adapter.start(SPEC, {
      onLine: () => {},
      onExit: (e) => (exit = e),
    });
    // Let it start, then interrupt mid-stream.
    await new Promise((r) => setTimeout(r, 1));
    handle.interrupt();
    await drain();
    expect(exit).toMatchObject({ outcome: "interrupted" });
  });

  /**
   * bug-sweep #11: the interrupt grace-timer sibling of the Claude fix. Codex's
   * abort SIGTERMs the child, but a child that SURVIVES SIGTERM (trapped signal,
   * a grandchild holding the stdout pipe) never ends the iterator, so the run
   * would sit `running` until the next restart's orphan sweep. A deadline
   * force-settles it instead.
   */
  it("force-settles an interrupt the codex child never answers (bug-sweep #11)", async () => {
    vi.useFakeTimers();
    try {
      // A thread that IGNORES the abort signal — hangs forever even after it.
      const wedgedThread: CodexThread = {
        id: "wedged",
        async runStreamed() {
          const gen = (async function* () {
            yield { type: "thread.started", thread_id: "wedged" };
            await new Promise<void>(() => {}); // never resolves; ignores abort
          })();
          return { events: asSdkEvents(gen) };
        },
      };
      const client: CodexClient = {
        startThread: () => wedgedThread,
        resumeThread: () => wedgedThread,
      };
      const adapter = createCodexAdapter({ codexFactory: () => client });
      let exit: RunExit | null = null;
      const handle = adapter.start(SPEC, {
        onLine: () => {},
        onExit: (e) => (exit = e),
      });
      await vi.advanceTimersByTimeAsync(1); // let the stream start
      handle.interrupt();
      expect(exit).toBeNull(); // abort sent, but the wedged child ignores it

      await vi.advanceTimersByTimeAsync(INTERRUPT_SETTLE_GRACE_MS + 1);
      expect(exit).toMatchObject({ outcome: "interrupted" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("idle-timeout settles error (not interrupted) on a hung stream (A8)", async () => {
    process.env.VIBERR_CODEX_IDLE_TIMEOUT_MS = "20"; // 20ms idle window
    // codexIdleTimeoutMs now reads the cached validated env, so re-parse it.
    resetEnvCacheForTests();
    try {
      // A stream whose first event lands, then it hangs (never yields again,
      // never turn.completes). The idle timer must abort → outcome "error".
      const hangingThread: CodexThread = {
        id: "hang",
        async runStreamed(_input, turnOptions) {
          const signal = turnOptions?.signal;
          const gen = (async function* () {
            yield { type: "thread.started", thread_id: "hang" };
            // Now hang until aborted.
            await new Promise<void>((_, reject) => {
              signal?.addEventListener("abort", () =>
                reject(new DOMException("aborted", "AbortError")),
              );
            });
          })();
          return { events: asSdkEvents(gen) };
        },
      };
      const client: CodexClient = {
        startThread: () => hangingThread,
        resumeThread: () => hangingThread,
      };
      const adapter = createCodexAdapter({ codexFactory: () => client });
      let exit: RunExit | null = null;
      adapter.start(SPEC, { onLine: () => {}, onExit: (e) => (exit = e) });
      await new Promise((r) => setTimeout(r, 120));
      expect(exit).toMatchObject({ outcome: "error" });
    } finally {
      delete process.env.VIBERR_CODEX_IDLE_TIMEOUT_MS;
      resetEnvCacheForTests();
    }
  });
});

describe("codex failure classification survives redaction into runFailureReason (F7-RUN1)", () => {
  const ctx = createTestDbContext();
  afterEach(ctx.cleanup);

  /** Drive the adapter through an SDK stream that throws `message`, collect the
   *  emitted lines, and persist them to a fresh run so `runFailureReason` can
   *  read them exactly as production would (via the display_json round-trip). */
  async function classifyThrownFailure(
    message: string,
  ): Promise<{ kind: string; text: string; providerText?: string } | null> {
    const thread: CodexThread = {
      id: "thread-1",
      async runStreamed() {
        return {
          events: failingEvents(new Error(message)),
        };
      },
    };
    const client: CodexClient = {
      startThread: () => thread,
      resumeThread: () => thread,
    };
    const lines: EmittedLine[] = [];
    createCodexAdapter({ codexFactory: () => client }).start(SPEC, {
      onLine: (line) => lines.push(line),
      onExit: () => {},
    });
    await drain();

    const db = ctx.makeDb();
    const runId = "run-" + Math.random().toString(36).slice(2);
    upsertRun(db, {
      id: runId,
      projectSlug: SPEC.projectSlug,
      taskKey: SPEC.taskKey,
      threadId: SPEC.threadId,
      role: SPEC.role,
      kind: SPEC.kind,
      agentProfileId: "developer",
      backend: "codex",
      model: SPEC.model,
      sdk: "codex-sdk",
      state: "error",
    });
    lines.forEach((line, seq) => {
      if (!line.display) return;
      insertRunLine(db, {
        runId,
        seq,
        occurredAt: line.occurredAt,
        raw: line.raw,
        display: line.display,
      });
    });
    return runFailureReason(db, runId);
  }

  it("a redacted quota failure classifies as 'quota'", async () => {
    const reason = await classifyThrownFailure(
      "429 rate limit: internal request id sk-secretsentinel0123456789",
    );
    expect(reason?.kind).toBe("quota");
    // R20-3: `text` is the redaction-safe canonical message with the provider's
    // sentence split back OFF onto `providerText`, so it never carries stderr.
    expect(reason?.text).toBe(
      "Codex usage limit was reached. Retry after the subscription limit resets.",
    );
    expect(reason?.text).not.toContain("secretsentinel");
    // The provider's own words ride separately, with the token redacted.
    expect(reason?.providerText).toContain("429 rate limit");
    expect(reason?.providerText).not.toContain("sk-secretsentinel0123456789");
  });

  it("a redacted auth failure classifies as 'auth' (the prose alone would not)", async () => {
    const reason = await classifyThrownFailure(
      "401 unauthorized for token sk-secretsentinel0123456789",
    );
    expect(reason?.kind).toBe("auth");
    expect(reason?.text).toBe(
      "Codex authentication failed. Review the configured subscription credential.",
    );
    expect(reason?.text).not.toContain("secretsentinel");
    expect(reason?.providerText).toContain("401 unauthorized for token [redacted]");
  });

  it("ruling 434: a torn rollout classifies as 'session_missing' with its own sentence, not 'unknown'", async () => {
    // Live on AX-5: "Codex execution failed. Review its authentication and
    // runtime configuration", for a session whose rollout head was torn.
    // CANARY: drop the SESSION_DAMAGED_RE branch.
    const reason = await classifyThrownFailure(
      "rollout at /data/runtimes/users/u_1/codex-home/sessions/2026/09/23/rollout-2026-09-23T01-25-02-01a0cbdd.jsonl does not start with session metadata (code -32603)",
    );
    expect(reason?.kind).toBe("session_missing");
    expect(reason?.text).toContain("Its rollout is damaged");
    expect(reason?.text).toContain("Nothing is wrong with the credential");
    expect(reason?.text).not.toMatch(/review .*(authentication|credential)/i);
    expect(reason?.text).not.toContain("/data/runtimes");
  });

  it("a vanished rollout classifies as 'session_missing', not 'auth' (P13-D-2)", async () => {
    const reason = await classifyThrownFailure(
      "session not found: 0199a2c4-7b31-7802 (no rollout under /data/codex/sessions)",
    );
    // BEFORE: this fell through to `unknown` and the escalation told the human
    // to "review its authentication and runtime configuration" — the one thing
    // that is definitely fine when a transcript has been swept.
    expect(reason?.kind).toBe("session_missing");
    expect(reason?.text).toContain("rollout no longer exists");
    // It must not send the human at the credential — it says the opposite.
    expect(reason?.text).not.toMatch(/review .*(authentication|credential)/i);
    expect(reason?.text).toContain("Nothing is wrong with the credential");
    // Redaction invariant holds: the path from the raw error never surfaces.
    expect(reason?.text).not.toContain("/data/codex/sessions");
  });

  /**
   * Ruling 221 (F37-41). Live on pass 37, after the host corrupted a SQLite
   * file under load, the Codex CLI said its own thread-history database was
   * `file is not a database`. That matched nothing, fell through to the auth
   * branch, and viberr told the owner to "review its authentication and runtime
   * configuration" — with "redirect with sharper guidance" as the RECOMMENDED
   * remedy, for a corrupt file on this host's disk. Every resume failed on it
   * while fresh runs kept working, which is the shape `session_missing` already
   * names and whose remedy is already the right one.
   */
  it("a session store that cannot be OPENED classifies 'session_missing', not 'auth' (ruling 221)", async () => {
    const reason = await classifyThrownFailure(
      "internal error: failed to open thread history database: failed to open thread history DB at " +
        "/data/runtimes/users/u_x/codex-home/thread_history_1.sqlite: error returned from database: " +
        "(code: 26) file is not a database (code -32603)",
    );
    // CANARY: drop the SESSION_STORE_UNREADABLE_RE arm and this is `unknown`
    // — which is what it WAS live, and `unknown`'s sentence is the credential
    // one ("Review its authentication and runtime configuration"), the same
    // fallthrough F37-32 found for a DNS failure.
    expect(reason?.kind).toBe("session_missing");
    expect(reason?.text).toContain("session store on this host could not be opened");
    // The two things the old sentence got wrong, asserted as the opposite.
    expect(reason?.text).not.toMatch(/review .*(authentication|credential)/i);
    expect(reason?.text).toContain("no rewritten directive changes it");
    // And it says what IS true of this one and not of a vanished session:
    // fresh runs still work, so the task is not dead.
    expect(reason?.text).toContain("fresh runs still work");
    // Redaction invariant: the store path never reaches the human sentence.
    expect(reason?.text).not.toContain("/data/runtimes/users");
  });

  it("an agent's OWN corrupt database is not a session failure (ruling 221)", async () => {
    // The clone this pass built is SQLite-backed. A run whose agent hit a bad
    // file in its own work must not be reported as a session problem — which
    // is why the pattern is anchored on the store's nouns, not on "not a
    // database" alone.
    const reason = await classifyThrownFailure(
      "the migration failed: services/inventory/.data/inventory.sqlite: file is not a database",
    );
    expect(reason?.kind).not.toBe("session_missing");
  });

  it("U35-11: a connection that failed before the provider answered classifies 'overloaded' with origin local and names this deployment", async () => {
    // Canary: delete the local-network arm and the sentence blames the
    // provider's own side (or, for `fetch failed`, falls to `unknown`).
    for (const text of [
      "error sending request: Unable to connect to API (UNKNOWN_CERTIFICATE_VERIFICATION_ERROR)",
      "fetch failed: connect ECONNREFUSED 10.0.0.1:443",
    ]) {
      const reason = await classifyThrownFailure(text);
      expect(reason?.kind, text).toBe("overloaded");
      expect(reason?.text, text).toContain("Codex could not be reached from this deployment: the connection failed before the provider answered");
      expect(reason?.text, text).not.toContain("failed on its own side");
    }
    const tls = await classifyThrownFailure("Unable to connect to API (UNKNOWN_CERTIFICATE_VERIFICATION_ERROR)");
    expect(tls?.text).toContain("(UNKNOWN_CERTIFICATE_VERIFICATION_ERROR)");
  });

  /**
   * Ruling 212, live on SHOP-10 and SHOP-16. The local-network patterns were
   * written against Node's error codes and Node's prose; the Codex CLI is Rust
   * and says it differently, so a NAME RESOLUTION failure matched nothing and
   * fell through to `unknown` — whose sentence is "Review its authentication
   * and runtime configuration", sending the owner at a credential that was
   * never at fault, for a DNS problem. Its TLS sibling matched only by
   * accident, through `\btls\b` inside a `close_notify` message.
   */
  it("ruling 212: the Codex CLI's own transport prose is a LOCAL network failure, not an auth problem", async () => {
    for (const text of [
      // Verbatim from the live packet on SHOP-10.
      "Reconnecting... 2/5 (stream disconnected before completion: failed to lookup address information: Name does not resolve)",
      "stream error: temporary failure in name resolution",
      "IO error: peer closed connection without sending TLS close_notify",
      // Ruling 389 (F39-16), verbatim from the live packet on ax-clone AX-11.
      // reqwest's own transport failure, which the Rust CLI surfaces unchanged.
      // The list had "connection error" and not "connection failed", so this
      // classified `unknown`: the packet told the owner to review their
      // authentication one line above the provider saying the network dropped,
      // and it came out as a stalled-work packet recommending a re-prompt
      // instead of the backend-failure packet that offers waiting.
      "Reconnecting... waiting for network (Connection failed: error sending request)",
      // Ruling 394's sibling, verbatim from the live packet on ax-clone AX-3
      // the same morning: the SAME "Reconnecting..." banner with the other
      // wording the CLI uses for it. "connection timed out" was on the list and
      // "request timed out" was not, so this one still classified `unknown` and
      // still told the owner to review their authentication.
      "Reconnecting... 5/5 (request timed out)",
    ]) {
      // CANARY: drop the new alternatives from LOCAL_NETWORK_FAILURE_RE and the
      // first two classify `unknown` and tell the reader to check their auth.
      const reason = await classifyThrownFailure(text);
      expect(reason?.kind, text).toBe("overloaded");
      expect(reason?.text, text).toContain(
        "Codex could not be reached from this deployment",
      );
      expect(reason?.text, text).not.toMatch(/review .*(authentication|runtime configuration)/i);
    }
  });

  it("a provider overload / 5xx classifies as 'overloaded' (parity with the Claude adapter's structural class), never 'unknown'", async () => {
    // Codex streams no structured status, so the leg is prose-only, on the
    // signatures the run projection has always read as backend unavailability.
    // BEFORE: `unknown`, whose sentence sends the human to "review its
    // authentication and runtime configuration" for the provider's own outage.
    for (const text of [
      "server_error: The server is currently overloaded, please try again later",
      "503 Service Unavailable from api.openai.com",
    ]) {
      const reason = await classifyThrownFailure(text);
      expect(reason?.kind, text).toBe("overloaded");
      expect(reason?.text).toBe(
        "Codex could not serve this run: the provider was overloaded or failed on its own side. Nothing about the account or the task is wrong; retry in a few minutes.",
      );
      expect(reason?.text).not.toMatch(/review .*(authentication|credential)/i);
    }
  });

  it("an unclassifiable failure classifies as 'unknown'", async () => {
    const reason = await classifyThrownFailure(
      "segmentation fault in /opt/codex/bin during run",
    );
    expect(reason?.kind).toBe("unknown");
    expect(reason?.text).toBe(
      "Codex execution failed. Review its authentication and runtime configuration.",
    );
  });

  it("tags the terminal err line with the classified kind (structured signal)", async () => {
    const thread: CodexThread = {
      id: "thread-1",
      async runStreamed() {
        return {
          events: failingEvents(
            new Error("usage limit exceeded — sk-secretsentinel0123456789"),
          ),
        };
      },
    };
    const client: CodexClient = {
      startThread: () => thread,
      resumeThread: () => thread,
    };
    const lines: EmittedLine[] = [];
    createCodexAdapter({ codexFactory: () => client }).start(SPEC, {
      onLine: (line) => lines.push(line),
      onExit: () => {},
    });
    await drain();

    // Redaction invariant: the projected display tag carries the safe-to-persist
    // class, and R20-3's surfaced provider sentence redacts a token by shape.
    expect(lines.at(-1)?.display).toMatchObject({ ev: "err", tag: "error·quota" });
    expect(lines.at(-1)?.raw).not.toContain("sk-secretsentinel0123456789");
  });
});

// ---------------------------------------------- P13: run isolation + sandbox

describe("codex run isolation (P13-LV-13 / LV-14 / RT-04)", () => {
  /**
   * Live-proven 2026-07-24: a Codex scout whose profile granted exactly ONE
   * skill reported 20+ host skills (`imagegen`, `skill-installer`,
   * `github:yeet`, `openai-developers:*`, …) and a host MCP server
   * (`openai_api_key_local_confirmation`) Viberr never granted. Root cause
   * verified against codex-cli 0.144.6: the CLI merges `--config` per dotted
   * leaf key into `$CODEX_HOME/config.toml` (so `mcp_servers` overrides ADD to
   * the host's table rather than replacing it), and re-installs its five
   * bundled `.system` skills into every home on startup.
   */
  async function configFor(spec: Partial<RunSpec>): Promise<CodexOptions["config"]> {
    const run = fakeCodex([
      { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
    ]);
    createCodexAdapter({ codexFactory: run.factory }).start(
      { ...SPEC, ...spec },
      { onLine: () => {}, onExit: () => {} },
    );
    await drain();
    return run.factoryOptions()?.config;
  }

  it("closes the CLI's own skills channel (bundled + user-installed)", async () => {
    const config = await configFor({});
    // `bundled` is a STRUCT in the CLI's config schema — a bare
    // `skills.bundled = false` makes it refuse to load its configuration at all
    // ("invalid type: boolean, expected struct BundledSkillsConfig"), which
    // would fail EVERY run. Verified against codex-cli 0.144.6.
    expect(config?.skills).toEqual({
      include_instructions: false,
      bundled: { enabled: false },
    });
  });

  it("refuses the checked-out repo's AGENTS.md (RT-04 — Claude loads no CLAUDE.md)", async () => {
    const config = await configFor({});
    expect(config?.project_doc_max_bytes).toBe(0);
  });

  it("disables the plugin + hook channels that carry host skills and MCP servers", async () => {
    const config = await configFor({});
    expect(config?.features).toMatchObject({
      apps: false,
      plugins: false,
      hooks: false,
    });
  });

  it("cannot be re-opened by a deployment's base config override", async () => {
    const run = fakeCodex([
      { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
    ]);
    createCodexAdapter({
      codexFactory: run.factory,
      config: {
        project_doc_max_bytes: 32_000,
        skills: { include_instructions: true, bundled: { enabled: true } },
        features: { apps: true, plugins: true, hooks: true },
      },
    }).start(SPEC, { onLine: () => {}, onExit: () => {} });
    await drain();
    const config = run.factoryOptions()?.config;
    expect(config?.project_doc_max_bytes).toBe(0);
    expect(config?.skills).toEqual({
      include_instructions: false,
      bundled: { enabled: false },
    });
    expect(config?.features).toMatchObject({
      apps: false,
      plugins: false,
      hooks: false,
    });
  });
});

describe("ruling 185: Viberr never OS-confines a Codex run", () => {
  const KINDS = ["primary", "reviewer", "operator", "controller"] as const;

  it("every kind, every grant shape, reaches the SDK as `danger-full-access` with no extra dirs or network switch, and web search follows the grant", async () => {
    // Canary: put ANY other mode back on one arm (a read-only operator, a
    // workspace-write withheld run) and one of these fails. The owner removed
    // the sandbox because every confined mode was a dead run on the compose
    // deployment — bubblewrap's namespace refusal (F36-1) and the network-off
    // seccomp filter's EPERM on every synchronous child process (F36-11).
    const DIR = "/data/projects/p/tasks/T-1/attachments";
    const postures = [
      { label: "autonomous deliverer", spec: { kind: "primary", autonomous: true } },
      { label: "supervised deliverer", spec: { kind: "primary", autonomous: false } },
      { label: "write-withheld", spec: { kind: "reviewer", autonomous: true, repoWriteWithheld: true } },
      { label: "egress-withheld deliverer", spec: { kind: "primary", autonomous: true, webSearchWithheld: true } },
      { label: "egress-withheld operator", spec: { kind: "operator", autonomous: true, webSearchWithheld: true } },
      {
        label: "evidence-granted, write-withheld",
        spec: { kind: "reviewer", autonomous: true, repoWriteWithheld: true, attachmentsWritableDir: DIR },
      },
    ] as const;
    // `networkAccessEnabled` only ever bound below full access; keeping it
    // would be a setting that reads as enforcement and is not one. Web SEARCH
    // is the CLI's own tool and still follows the grant on every kind.
    // Canary: set `networkAccessEnabled = false` for the operator again, or
    // drop the `webSearchWithheld` arm, and a row below fails.
    for (const posture of postures) {
      const run = fakeCodex([
        { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
      ]);
      createCodexAdapter({ codexFactory: run.factory }).start(
        { ...SPEC, ...posture.spec },
        { onLine: () => {}, onExit: () => {} },
      );
      await drain();
      expect(run.startOptions()?.sandboxMode, posture.label).toBe("danger-full-access");
      // No `--add-dir`: full access already writes the attachments drop.
      expect(run.startOptions()?.additionalDirectories, posture.label).toBeUndefined();
      expect(run.startOptions()?.networkAccessEnabled, posture.label).toBeUndefined();
      expect(run.startOptions()?.webSearchMode, posture.label).toBe(
        "webSearchWithheld" in posture.spec ? "disabled" : undefined,
      );
    }
    for (const kind of KINDS) {
      const run = fakeCodex([
        { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
      ]);
      createCodexAdapter({ codexFactory: run.factory }).start(
        { ...SPEC, kind, autonomous: true },
        { onLine: () => {}, onExit: () => {} },
      );
      await drain();
      expect(run.startOptions()?.sandboxMode, kind).toBe("danger-full-access");
      expect(run.startOptions()?.networkAccessEnabled, kind).toBeUndefined();
      expect(run.startOptions()?.webSearchMode, kind).toBeUndefined();
    }
  });
});

describe("git identity reaches the model's shell (P13-RT-10)", () => {
  it("exports GIT_AUTHOR_*/GIT_COMMITTER_* alongside the git ceiling", async () => {
    const run = fakeCodex([
      { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
    ]);
    createCodexAdapter({ codexFactory: run.factory }).start(
      {
        ...SPEC,
        env: {
          GIT_CEILING_DIRECTORIES: "/safe/task",
          GIT_AUTHOR_NAME: "Docs Writer",
          GIT_AUTHOR_EMAIL: "docs-writer@agents.viberr.local",
          GIT_COMMITTER_NAME: "Docs Writer",
          GIT_COMMITTER_EMAIL: "docs-writer@agents.viberr.local",
          UNRELATED_SECRETISH: "must-not-cross",
        },
      },
      { onLine: () => {}, onExit: () => {} },
    );
    await drain();
    // SAFETY: the SDK types every config leaf as its recursive value union, but
    // this leaf is one the ADAPTER writes: `codexConfigForRun` builds
    // `shell_environment_policy` and names `set` only when there is something to
    // export, as a string table (`ShellExportedEnv`).
    const policy = run.factoryOptions()?.config?.shell_environment_policy as {
      set?: Record<string, string>;
    };
    expect(policy.set).toEqual({
      GIT_CEILING_DIRECTORIES: "/safe/task",
      GIT_AUTHOR_NAME: "Docs Writer",
      GIT_AUTHOR_EMAIL: "docs-writer@agents.viberr.local",
      GIT_COMMITTER_NAME: "Docs Writer",
      GIT_COMMITTER_EMAIL: "docs-writer@agents.viberr.local",
    });
    // Only the named keys cross the boundary — everything else stays in the
    // CLI's own process env (where the subscription credential lives).
    expect(policy.set?.UNRELATED_SECRETISH).toBeUndefined();
  });
});

describe("codex idle timeout classifies as a hang, not a generic failure (P13-RT-11)", () => {
  it("tags the terminal line `error·idle_timeout`", async () => {
    process.env.VIBERR_CODEX_IDLE_TIMEOUT_MS = "5";
    resetEnvCacheForTests();
    const thread: CodexThread = {
      id: "t",
      async runStreamed(_input, turnOptions) {
        const signal = turnOptions?.signal;
        return {
          // Never emits — the idle guard is the only thing that settles it.
          events: stalledEvents(signal),
        };
      },
    };
    const client: CodexClient = {
      startThread: () => thread,
      resumeThread: () => thread,
    };
    const lines: EmittedLine[] = [];
    let exit: RunExit | null = null;
    createCodexAdapter({ codexFactory: () => client }).start(SPEC, {
      onLine: (l) => lines.push(l),
      onExit: (e) => (exit = e),
    });
    await drain();
    expect(exit).toMatchObject({ outcome: "error" });
    expect(lines.at(-1)?.display?.tag).toBe("error·idle_timeout");
    delete process.env.VIBERR_CODEX_IDLE_TIMEOUT_MS;
    resetEnvCacheForTests();
  });
});

/* -------------------- D5: the docstring cannot outlive the SDK ------------- */

describe("D5 — the verified SDK version is a fact, not a claim", () => {
  /** The repo's DECLARED `@openai/codex-sdk` range, base version only. */
  async function declaredSdkVersion(): Promise<string> {
    const { readFileSync } = await import("node:fs");
    const pkg = z
      .object({ dependencies: z.record(z.string(), z.string()) })
      .parse(
        JSON.parse(
          readFileSync(
            new URL("../../../package.json", import.meta.url),
            "utf8",
          ),
        ),
      );
    return pkg.dependencies["@openai/codex-sdk"]!.replace(/^[\^~]/, "");
  }

  // The header claimed v0.144.1 for two releases while the dependency had moved
  // to 0.146.0, and nothing could tell: a version claim in prose is
  // unfalsifiable. Bumping the dependency now fails HERE — which is the moment
  // to re-read the adapter — instead of quietly rotting the docstring.
  it("matches the @openai/codex-sdk the app depends on", async () => {
    expect(CODEX_SDK_VERIFIED_VERSION).toBe(await declaredSdkVersion());
  });
});

/**
 * UC-16 — the Codex half of the DISCLOSED MCP/skills asymmetries, and (ruling
 * 461) the parity that replaced one of them.
 *
 * The capability-matrix modal used to say "Org MCP credentials are sent on
 * Claude runs only — Codex mounts a declared server unauthenticated". Since
 * ruling 461 a credentialed server is a gateway mount on both backends, so
 * the modal says the credential stays in Viberr, and this pins the Codex half
 * of that: the run token reaches the CLI as the server's `http_headers`.
 * Granted skills still arrive as prompt text here because there is no native
 * channel. The Claude halves live in `claude-runtime.server.test.ts`.
 */
describe("UC-16 disclosed asymmetries — the Codex side", () => {
  const RUN_TOKEN = "sentinel-run-token";

  /** The shapes a run's spec carries after `startRun` bound it to the gateway
   *  (specialist-mcp.server.ts, gateway.server.ts): a gateway mount with the
   *  run's token, an uncredentialed stdio server, the in-process toolkit. */
  const MOUNTED_SERVERS = {
    "everything-http": {
      type: "http",
      url: "http://127.0.0.1:43111/mcp/everything-http",
      headers: { Authorization: `Bearer ${RUN_TOKEN}` },
    },
    "everything-stdio": {
      command: "npx",
      args: ["-y", "example-mcp"],
    },
    // The in-process toolkit (post_comment / ask_human / report_outcome).
    viberr_agent: { type: "sdk", instance: {} },
  };

  async function configWith(
    spec: Partial<RunSpec>,
  ): Promise<CodexOptions["config"]> {
    const run = fakeCodex([
      { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
    ]);
    createCodexAdapter({ codexFactory: run.factory }).start(
      { ...SPEC, ...spec },
      { onLine: () => {}, onExit: () => {} },
    );
    await drain();
    return run.factoryOptions()?.config;
  }

  it("ruling 461: a gateway mount reaches the CLI with the run's token as its http_headers", async () => {
    const config = await configWith({ mcpServers: MOUNTED_SERVERS });
    // SAFETY: `mcp_servers` is a leaf the ADAPTER writes — one table per
    // declared server (see the mcpServers translation in codex-runtime.server) —
    // so reading it back as a config table is the shape it was written as. The
    // assertions below check the whole table, so nothing may be stripped here.
    const servers = (config?.mcp_servers ?? {}) as NonNullable<
      CodexOptions["config"]
    >;

    // P13-LV-15: the DECLARED (hyphenated) names pass through; the codex
    // binary's rename to `everything_http` for its tool prefix is its own.
    expect(Object.keys(servers).sort()).toEqual([
      "everything-http",
      "everything-stdio",
    ]);
    // CANARY: drop the `http_headers` translation and the Codex run reaches
    // the gateway without its token — the 401s F40-3 was about.
    expect(servers["everything-http"]).toEqual({
      url: "http://127.0.0.1:43111/mcp/everything-http",
      default_tools_approval_mode: "approve",
      http_headers: { Authorization: `Bearer ${RUN_TOKEN}` },
    });
    expect(servers["everything-stdio"]).toEqual({
      command: "npx",
      args: ["-y", "example-mcp"],
      default_tools_approval_mode: "approve",
    });
  });

  it("has no in-process tool channel: the mid-run comment/ask-human toolkit is dropped, never serialized", async () => {
    const config = await configWith({ mcpServers: MOUNTED_SERVERS });
    // `{ type: "sdk" }` is a live JS object with no CLI equivalent — serializing
    // it would produce invalid config instead of an honest omission. This is why
    // "Post mid-run comments" is disclosed as having no Codex channel: a Codex
    // agent's report posts when the run ENDS, through the outcome envelope.
    expect(config?.mcp_servers).not.toHaveProperty("viberr_agent");
    expect(JSON.stringify(config)).not.toContain("viberr_agent");
  });

  it("has no native skills channel — `spec.skills` changes nothing about the run", async () => {
    // R18-5: granted skills reach a CLAUDE run through the SDK's native skills
    // mechanism. Codex has no equivalent to switch on, so its whole skills
    // channel stays severed and the grants ride the system prompt as text
    // (built upstream in `buildSpecialistPersona`). If a future edit forwarded
    // `spec.skills` into this config it would be re-opening the channel that
    // re-installs the CLI's own five bundled `.system` skills into any home.
    const withSkills = await configWith({
      skills: ["developer-expertise", "conventional-commits"],
    });
    const without = await configWith({});
    expect(withSkills).toEqual(without);
    expect(withSkills?.skills).toEqual({
      include_instructions: false,
      bundled: { enabled: false },
    });
    expect(JSON.stringify(withSkills)).not.toContain("developer-expertise");
  });
});

/**
 * R21-4a / G5 (FR28) — the Codex half of the Live-run strip's phase rows.
 *
 * Same defect, same fix, and deliberately the same vocabulary as the Claude
 * adapter: the strip must read identically whichever backend is running, so the
 * step is derived from the PROJECTED display line (which both backends already
 * compute) rather than from each backend's own envelope shape.
 */
describe("codex adapter run phases (R21-4a / FR28)", () => {
  function capturePhases(events: unknown[]) {
    const { factory } = fakeCodex(events);
    const adapter = createCodexAdapter({ codexFactory: factory });
    const phases: [string | null, string | null][] = [];
    adapter.start(SPEC, {
      onLine: () => {},
      onExit: () => {},
      onPhase: (phase, step) => phases.push([phase, step]),
    });
    return phases;
  }

  it("emits starting → working → finishing across a turn", async () => {
    const phases = capturePhases([
      { type: "thread.started", thread_id: "0199abc" },
      { type: "item.completed", item: { type: "agent_message", text: "advice" } },
      { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } },
    ]);
    await drain();

    expect(phases[0]).toEqual(["Starting", null]);
    expect(phases.map(([p]) => p)).toContain("Working");
    expect(phases.at(-1)).toEqual(["Finishing", null]);
  });

  it("names the command the run is inside — the same 'Tool · detail' shape Claude emits", async () => {
    const phases = capturePhases([
      { type: "thread.started", thread_id: "0199abc" },
      {
        type: "item.started",
        item: { type: "command_execution", command: "npm test", aggregated_output: "", status: "in_progress" },
      },
      { type: "item.completed", item: { type: "agent_message", text: "done" } },
      { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } },
    ]);
    await drain();

    const steps = phases.filter(([p]) => p === "Working").map(([, s]) => s);
    expect(steps[1]).toContain("exec");
    expect(steps[1]).toContain("npm test");
    // Sticky through the following agent message, like the Claude adapter.
    expect(steps[2]).toBe(steps[1]);
  });

  it("names the command as answered once it completes, through the reasoning that follows (ruling 348)", async () => {
    const phases = capturePhases([
      { type: "thread.started", thread_id: "0199abc" },
      { type: "item.started", item: { type: "command_execution", command: "npm test", aggregated_output: "", status: "in_progress" } },
      { type: "item.completed", item: { type: "command_execution", command: "npm test", aggregated_output: "12 passed\n", exit_code: 0, status: "completed" } },
      { type: "item.completed", item: { type: "reasoning", text: "next…" } },
      { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } },
    ]);
    await drain();

    const steps = phases.filter(([p]) => p === "Working").map(([, s]) => s);
    expect(steps[1]).toBe("exec · npm test");
    // CANARY: keep `lastStep` untouched on an `aggregated_output` line.
    expect(steps[2]).toBe("composing · exec · npm test answered");
    expect(steps[3]).toBe("composing · exec · npm test answered");
  });

  it("names a succeeding MCP call as answered although its completion projects no row (ruling 348)", async () => {
    const phases = capturePhases([
      { type: "thread.started", thread_id: "0199abc" },
      { type: "item.started", item: { id: "mcp-1", type: "mcp_tool_call", server: "viberr", tool: "get_task", arguments: { taskKey: "BNB-1" }, status: "in_progress" } },
      { type: "item.completed", item: { id: "mcp-1", type: "mcp_tool_call", server: "viberr", tool: "get_task", arguments: { taskKey: "BNB-1" }, status: "completed" } },
      { type: "item.completed", item: { type: "reasoning", text: "next…" } },
      { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } },
    ]);
    await drain();

    const steps = phases.filter(([p]) => p === "Working").map(([, s]) => s);
    expect(steps[1]).toContain("viberr.get_task");
    // CANARY: drop `facts.toolAnswered` from the completed branch in wire-format.
    expect(steps[2]).toBe(`composing · ${steps[1]} answered`);
    expect(steps[3]).toBe(steps[2]);
  });

  it("falls back to the in-flight turn number before the first tool call", async () => {
    const phases = capturePhases([
      { type: "thread.started", thread_id: "0199abc" },
      { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } },
    ]);
    await drain();

    const steps = phases.filter(([p]) => p === "Working").map(([, s]) => s);
    expect(steps[0]).toBe("turn 1");
  });
});

/** Ruling 130(a): the Codex adapter attaches the same typed record to its
 *  terminal line (every fact but the kind unknown). Canary: omit `failure`. */
describe("ruling 130(a): failure record parity", () => {
  it("the terminal err line carries `failure` with the classified kind", async () => {
    const { factory } = fakeCodex([
      { type: "turn.started" },
      { type: "turn.failed", error: { message: "You've hit your usage limit. Try again later." } },
    ]);
    const adapter = createCodexAdapter({ codexFactory: factory });
    const lines: EmittedLine[] = [];
    adapter.start(SPEC, { onLine: (l) => lines.push(l), onExit: () => {} });
    await drain();
    const terminal = lines.find((l) => (l.display?.tag ?? "").endsWith("·quota"));
    expect(terminal?.display?.failure).toEqual({
      kind: "quota", resetsAt: null, window: null, windowRejected: false, apiError: null, apiErrorStatus: null, terminalReason: null, origin: null,
    });
  });
});

/**
 * Ruling 176: Codex has no denylist channel, so an org server's marked write
 * tools travel as that server's own `disabled_tools` (the pinned CLI reads it
 * per `mcp_servers.<name>`, beside `enabled_tools`), by the server's raw names.
 */
describe("codex MCP write-tool denials (ruling 176)", () => {
  const COMPLETED = { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } };
  const serversSchema = z.record(
    z.string(),
    z.looseObject({ disabled_tools: z.array(z.string()).optional() }),
  );

  it("sends each server's denials as its disabled_tools, on stdio and HTTP alike", async () => {
    // Canary: drop the `disabled_tools` writes in codexMcpServers.
    const run = fakeCodex([COMPLETED]);
    createCodexAdapter({ codexFactory: run.factory }).start(
      {
        ...SPEC,
        mcpServers: {
          github: { command: "npx", args: ["-y", "gh-mcp"] },
          "gh-http": {
            type: "http",
            url: "https://mcp.example.test/gh",
            // The Claude per-tool policy rides the portable config; Codex's
            // schema drops it and reads the denials instead.
            tools: [{ name: "merge_pull_request", permission_policy: "always_deny" }],
          },
          docs: { command: "npx", args: ["-y", "docs-mcp"] },
        },
        mcpToolDenials: [
          { server: "github", tools: ["create_pull_request", "repo.merge"] },
          { server: "gh-http", tools: ["merge_pull_request"] },
        ],
      },
      { onLine: () => {}, onExit: () => {} },
    );
    await drain();
    const servers = serversSchema.parse(run.factoryOptions()?.config?.mcp_servers);
    expect(servers.github?.disabled_tools).toEqual(["create_pull_request", "repo.merge"]);
    expect(servers["gh-http"]?.disabled_tools).toEqual(["merge_pull_request"]);
    expect(servers["gh-http"]).not.toHaveProperty("tools");
    // A server with no marks is translated exactly as before.
    expect(servers.docs).not.toHaveProperty("disabled_tools");
  });
});

/**
 * Ruling 174: the Codex SDK spawns the CLI itself and signals only it, SIGTERM
 * and never SIGKILL, so a settled run is swept by the marker every process it
 * started carries. The CLI inherits its full env; the model's shell and each
 * stdio server get only what is declared, so the marker is declared for both.
 */
describe("per-run CODEX_HOME (ruling 181)", () => {
  const homes = createTestDbContext();
  afterEach(homes.cleanup);

  /** A fake whose stream waits for `release()` before it completes, so a test
   *  can look at the run home WHILE the CLI would be running. */
  function gatedCodex() {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let factoryOpts: CodexOptions | undefined;
    const thread: CodexThread = {
      id: "0199a1f3-4c02-7d31",
      async runStreamed() {
        const gen = (async function* () {
          await gate;
          yield { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } };
        })();
        return { events: asSdkEvents(gen) };
      },
    };
    const client: CodexClient = {
      startThread: () => thread,
      resumeThread: () => thread,
    };
    return {
      factory: (options?: CodexOptions) => {
        factoryOpts = options;
        return client;
      },
      factoryOptions: () => factoryOpts,
      release: () => release(),
    };
  }

  it("spawns the CLI in a private run home seeded from the person's home, shares the state db, and carries the refreshed sign-in back when the run settles", async () => {
    // F36-3 / Q36-11 (a): the person's shared codex-home is what
    // `runCredentialFor` puts on spec.env; the adapter forks a per-run home
    // off it so concurrent runs never share the CLI's `tmp/arg0` helper dir.
    // Canary: hand the SDK `spec.env.CODEX_HOME` unchanged and the first
    // expectation reads the shared home back.
    const shared = ensureUserBackendHome("u_arda", "codex", homes.makeTempDir());
    writeFileSync(path.join(shared, "auth.json"), '{"tokens":"before"}');
    const run = gatedCodex();
    let exit: RunExit | undefined;
    createCodexAdapter({ codexFactory: run.factory, env: { PATH: "/usr/bin" } }).start(
      {
        ...SPEC,
        runId: "run_home1",
        env: { CODEX_HOME: shared, VIBERR_RUN_ID: "run_home1" },
      },
      { onLine: () => {}, onExit: (e) => { exit = e; } },
    );
    await new Promise((r) => setTimeout(r, 0));

    const env = run.factoryOptions()?.env;
    const runHome = path.join(shared, "runs", "run_home1");
    expect(env?.CODEX_HOME).toBe(runHome);
    // The CLI's thread/state db stays the person's, so resume and history
    // keep working across runs.
    expect(env?.CODEX_SQLITE_HOME).toBe(shared);
    expect(env?.VIBERR_RUN_ID).toBe("run_home1");
    expect(env?.PATH).toBe("/usr/bin");
    // Live: the run home exists, seeded from the shared one.
    expect(existsSync(runHome)).toBe(true);
    expect(readFileSync(path.join(runHome, "auth.json"), "utf8")).toBe('{"tokens":"before"}');
    // The CLI refreshes its token inside the run home…
    writeFileSync(path.join(runHome, "auth.json"), '{"tokens":"after"}');

    run.release();
    await drain();
    expect(exit?.outcome).toBe("finished");
    // …and the settle carried it back and removed the run home.
    expect(existsSync(runHome)).toBe(false);
    expect(readFileSync(path.join(shared, "auth.json"), "utf8")).toBe('{"tokens":"after"}');
  });

  it("takes the sign-in from the billed ACCOUNT's home and hands the refresh back there, never to another account (ruling 507)", async () => {
    // Two accounts of one person: an older one whose sign-in sits in the
    // shared home, and the one this run bills, in a home of its own. Canary:
    // seed the fork from `spec.env.CODEX_HOME` again and the run reads the
    // wrong account's token.
    const dataRoot = homes.makeTempDir();
    const shared = ensureUserBackendHome("u_arda", "codex", dataRoot);
    writeFileSync(path.join(shared, "auth.json"), '{"tokens":"other-account"}');
    const accountHome = backendAccountHome("u_arda", "codex", { id: "ubc_billed", legacyHome: false }, dataRoot);
    mkdirSync(accountHome, { recursive: true });
    writeFileSync(path.join(accountHome, "auth.json"), '{"tokens":"billed-before"}');
    const run = gatedCodex();
    let exit: RunExit | undefined;
    createCodexAdapter({ codexFactory: run.factory, env: { PATH: "/usr/bin" } }).start(
      {
        ...SPEC,
        runId: "run_account1",
        env: { CODEX_HOME: shared, VIBERR_RUN_ID: "run_account1" },
        accountHome,
      },
      { onLine: () => {}, onExit: (e) => { exit = e; } },
    );
    await new Promise((r) => setTimeout(r, 0));

    const runHome = path.join(shared, "runs", "run_account1");
    expect(run.factoryOptions()?.env?.CODEX_HOME).toBe(runHome);
    expect(run.factoryOptions()?.env?.CODEX_SQLITE_HOME).toBe(shared);
    expect(readFileSync(path.join(runHome, "auth.json"), "utf8")).toBe('{"tokens":"billed-before"}');
    writeFileSync(path.join(runHome, "auth.json"), '{"tokens":"billed-after"}');

    run.release();
    await drain();
    expect(exit?.outcome).toBe("finished");
    expect(existsSync(runHome)).toBe(false);
    expect(readFileSync(path.join(accountHome, "auth.json"), "utf8")).toBe('{"tokens":"billed-after"}');
    // The other account's sign-in is exactly as it was.
    expect(readFileSync(path.join(shared, "auth.json"), "utf8")).toBe('{"tokens":"other-account"}');
  });

  it("a pasted-key account's run inherits no sign-in at all, even with another account's in the shared home (ruling 507)", async () => {
    const dataRoot = homes.makeTempDir();
    const shared = ensureUserBackendHome("u_arda", "codex", dataRoot);
    writeFileSync(path.join(shared, "auth.json"), '{"tokens":"other-account"}');
    const accountHome = backendAccountHome("u_arda", "codex", { id: "ubc_key", legacyHome: false }, dataRoot);
    mkdirSync(accountHome, { recursive: true });
    const run = gatedCodex();
    createCodexAdapter({ codexFactory: run.factory, env: { PATH: "/usr/bin" } }).start(
      {
        ...SPEC,
        runId: "run_account2",
        env: { CODEX_HOME: shared, CODEX_API_KEY: "sk-proj-key", VIBERR_RUN_ID: "run_account2" },
        accountHome,
      },
      { onLine: () => {}, onExit: () => {} },
    );
    await new Promise((r) => setTimeout(r, 0));
    const runHome = path.join(shared, "runs", "run_account2");
    expect(existsSync(runHome)).toBe(true);
    expect(existsSync(path.join(runHome, "auth.json"))).toBe(false);
    run.release();
    await drain();
  });

  /**
   * Ruling 460: the SDK spawns `codexPathOverride` with its own argv, so the
   * launcher stands in for the CLI and execs the SDK's vendored binary as the
   * principal's uid. The run home the server forks is handed to that uid
   * before the CLI starts, and handed back (with the written-back sign-in) at
   * the settle, through the launcher's `--prepare-home`.
   */
  it("launches the vendored CLI through the launcher as the principal's uid, and hands the run home to it (ruling 460)", async () => {
    const dir = homes.makeTempDir("viberr-launcher-");
    const log = path.join(dir, "calls.log");
    const launcher = path.join(dir, "viberr-launch");
    writeFileSync(launcher, `#!/bin/sh\necho "$*" >> '${log}'\nexit 0\n`);
    chmodSync(launcher, 0o755);
    const shared = ensureUserBackendHome("u_arda", "codex", homes.makeTempDir());
    writeFileSync(path.join(shared, "auth.json"), '{"tokens":"before"}');
    const run = gatedCodex();
    let exit: RunExit | undefined;
    createCodexAdapter({ codexFactory: run.factory, env: { PATH: "/usr/bin" } }).start(
      {
        ...SPEC,
        runId: "run_launched",
        agent: { uid: 20001, launcher, launchHome: shared, home: "/data/runtimes/users/u_arda/home" },
        env: { CODEX_HOME: shared, VIBERR_RUN_ID: "run_launched" },
      },
      { onLine: () => {}, onExit: (e) => { exit = e; } },
    );
    await new Promise((r) => setTimeout(r, 0));

    const options = run.factoryOptions();
    const runHome = path.join(shared, "runs", "run_launched");
    const vendor = codexVendor();
    expect(options?.codexPathOverride).toBe(launcher);
    expect(options?.env?.VIBERR_LAUNCH_EXEC).toBe(vendor.binary);
    expect(path.isAbsolute(options?.env?.VIBERR_LAUNCH_EXEC ?? "")).toBe(true);
    // The SDK's own layout (its resolveNativePackage): <package>/vendor/<triple>/bin/codex.
    expect(vendor.binary).toMatch(/\/vendor\/[a-z0-9_-]+\/bin\/codex$/);
    expect(options?.env?.VIBERR_LAUNCH_UID).toBe("20001");
    expect(options?.env?.VIBERR_LAUNCH_HOME).toBe(shared);
    // The run's own env still reaches the CLI through the launcher.
    expect(options?.env?.CODEX_HOME).toBe(runHome);
    expect(options?.env?.VIBERR_RUN_ID).toBe("run_launched");
    // The SDK adds its helper directories to PATH only for its own lookup.
    expect(options?.env?.PATH?.split(path.delimiter)).toEqual([...vendor.pathDirs, "/usr/bin"]);
    // The run home the server just forked belongs to the principal's uid
    // before the CLI (running as that uid) reads its copied sign-in.
    expect(readFileSync(log, "utf8")).toContain(`--prepare-home 20001 ${runHome}`);

    writeFileSync(path.join(runHome, "auth.json"), '{"tokens":"after"}');
    run.release();
    await drain();
    expect(exit?.outcome).toBe("finished");
    // The written-back sign-in is the server's file: handed back to the uid.
    expect(readFileSync(log, "utf8")).toContain(`--prepare-home 20001 ${path.join(shared, "auth.json")}`);
  });

  it("removes the run home when the run is interrupted, too", async () => {
    const shared = ensureUserBackendHome("u_arda", "codex", homes.makeTempDir());
    const client: CodexClient = {
      startThread: () => ({
        id: "t",
        async runStreamed(_input, turnOptions) {
          return { events: stalledEvents(turnOptions?.signal) };
        },
      }),
      resumeThread: () => {
        throw new Error("not resumed");
      },
    };
    let exit: RunExit | undefined;
    const handle = createCodexAdapter({ codexFactory: () => client }).start(
      { ...SPEC, runId: "run_home2", env: { CODEX_HOME: shared } },
      { onLine: () => {}, onExit: (e) => { exit = e; } },
    );
    await new Promise((r) => setTimeout(r, 0));
    const runHome = path.join(shared, "runs", "run_home2");
    expect(existsSync(runHome)).toBe(true);
    handle.interrupt();
    await drain();
    expect(exit?.outcome).toBe("interrupted");
    expect(existsSync(runHome)).toBe(false);
  });

  it("a run whose spec carries no home (no principal env) forks nothing", async () => {
    const run = fakeCodex([
      { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
    ]);
    createCodexAdapter({ codexFactory: run.factory, env: { PATH: "/usr/bin" } }).start(SPEC, {
      onLine: () => {},
      onExit: () => {},
    });
    await drain();
    expect(run.factoryOptions()?.env?.CODEX_HOME).toBeUndefined();
    expect(run.factoryOptions()?.env?.CODEX_SQLITE_HOME).toBeUndefined();
  });
});

/**
 * Ruling 541: a Viberr run is one Codex turn, and the SDK streams that turn's
 * usage once, at its end, so the Live run strip read Turns 0 and Tokens
 * "pending" for twenty minutes of a working run. The pinned CLI writes a
 * `token_usage_record` into the rollout as each model call completes; these
 * fakes write the rollout the way it does (shapes and figures from a real
 * 0.156.0 run against a scripted model), into the person's shared home.
 */
describe("ruling 541: a Codex run's Turns and Tokens while it works", () => {
  const homes = createTestDbContext();
  afterEach(homes.cleanup);
  const THREAD = "01a0e71b-194e-75c1-a7bd-b59033305da2";

  /** One record: the turn's running total and the thread's, as [input,
   *  cached, output]. */
  const record = (turn: [number, number, number], thread = turn) => {
    const usage = ([input, cached, output]: [number, number, number]) => ({
      input_tokens: input,
      cached_input_tokens: cached,
      cache_write_input_tokens: 0,
      output_tokens: output,
      reasoning_output_tokens: 0,
      total_tokens: input + output,
    });
    return `${JSON.stringify({
      timestamp: "2026-09-28T08:21:48.487Z",
      type: "token_usage_record",
      payload: { thread_id: THREAD, turn_token_usage: usage(turn), thread_token_usage: usage(thread) },
    })}\n`;
  };

  /** A fake whose stream appends `write` steps to the rollout before it
   *  yields the event after them, in the person's shared codex home. */
  function rolloutCodex(shared: string, steps: ({ write: string } | { event: unknown })[]) {
    const dir = path.join(shared, "sessions", "2026", "09", "28");
    const rollout = path.join(dir, `rollout-2026-09-28T08-21-47-${THREAD}.jsonl`);
    const thread: CodexThread = {
      id: THREAD,
      async runStreamed() {
        const gen = (async function* () {
          for (const step of steps) {
            if ("write" in step) {
              mkdirSync(dir, { recursive: true });
              appendFileSync(rollout, step.write);
              continue;
            }
            yield step.event;
            await new Promise((r) => setTimeout(r, 0));
          }
        })();
        return { events: asSdkEvents(gen) };
      },
    };
    const client: CodexClient = { startThread: () => thread, resumeThread: () => thread };
    return { factory: () => client, rollout, dir };
  }

  async function linesOf(shared: string, steps: Parameters<typeof rolloutCodex>[1], spec: Partial<RunSpec> = {}) {
    const run = rolloutCodex(shared, steps);
    const lines: EmittedLine[] = [];
    createCodexAdapter({ codexFactory: run.factory, env: { PATH: "/usr/bin" } }).start(
      { ...SPEC, runId: "run_live", env: { CODEX_HOME: shared }, ...spec },
      { onLine: (l) => lines.push(l), onExit: () => {} },
    );
    await drain();
    return lines;
  }

  const TOOL = { type: "item.started", item: { type: "command_execution", command: "npm test", aggregated_output: "", status: "in_progress" } };
  const TOOL_DONE = { type: "item.completed", item: { type: "command_execution", command: "npm test", aggregated_output: "ok\n", exit_code: 0, status: "completed" } };

  it("each call's record reaches the line that follows it: Turns counts the calls, Tokens is the turn's running total", async () => {
    const shared = ensureUserBackendHome("u_arda", "codex", homes.makeTempDir());
    const second = record([23_000, 11_000, 300]);
    const lines = await linesOf(shared, [
      { event: { type: "thread.started", thread_id: THREAD } },
      { write: `${JSON.stringify({ type: "session_meta", payload: { id: THREAD } })}\n${record([11_000, 0, 100])}` },
      { event: TOOL },
      { event: TOOL_DONE },
      // The CLI is mid-write on the second call's record.
      { write: second.slice(0, 90) },
      { event: TOOL },
      { write: second.slice(90) },
      { event: TOOL_DONE },
      { write: record([36_000, 23_000, 600]) },
      { event: { type: "item.completed", item: { type: "agent_message", text: "done" } } },
      { event: { type: "turn.completed", usage: { input_tokens: 36_000, cached_input_tokens: 23_000, output_tokens: 600 } } },
    ]);

    // CANARY: read the rollout at turn.completed only (or not at all) and
    // every line before it carries nothing: Turns 0, Tokens "pending".
    // CANARY: parse the unterminated tail instead of reading it again whole
    // and the second call never counts (Turns 2 at the end).
    expect(lines.map((l) => [l.facts.turns ?? null, l.facts.usage?.input_tokens ?? null])).toEqual([
      [null, null],
      [1, 11_000],
      [1, null],
      [1, null],
      [2, 23_000],
      [3, 36_000],
      [3, 36_000],
    ]);
    // The provider's own figures, so the strip prints them plain from the
    // first call on.
    expect(lines[1]!.facts.usage).toEqual({ input_tokens: 11_000, cached_input_tokens: 0, output_tokens: 100, outputEstimated: false });
  });

  it("a resumed thread counts only this run's calls, and its turn.completed carries the turn's total, not the thread's", async () => {
    // Measured on the real 0.156.0 CLI: a first run of two calls (23k input),
    // then a resume of one call (13k), whose `turn.completed` said 36k.
    const shared = ensureUserBackendHome("u_arda", "codex", homes.makeTempDir());
    const earlier = rolloutCodex(shared, []);
    mkdirSync(earlier.dir, { recursive: true });
    writeFileSync(
      earlier.rollout,
      `${JSON.stringify({ type: "session_meta", payload: { id: THREAD } })}\n${record([11_000, 0, 100])}${record([23_000, 11_000, 300])}`,
    );
    const lines = await linesOf(
      shared,
      [
        { event: { type: "thread.started", thread_id: THREAD } },
        { write: record([13_000, 12_000, 300], [36_000, 23_000, 600]) },
        { event: { type: "item.completed", item: { type: "agent_message", text: "done" } } },
        { event: { type: "turn.completed", usage: { input_tokens: 36_000, cached_input_tokens: 23_000, output_tokens: 600 } } },
      ],
      { resumeSessionId: THREAD },
    );

    // CANARY: read a resumed rollout from its start and the earlier run's two
    // calls are this run's (Turns 3).
    expect(lines.map((l) => l.facts.turns ?? null)).toEqual([null, 1, 1]);
    // CANARY: keep the SDK's figure and the run stores the thread's 36k.
    const done = lines.at(-1)!;
    expect(done.facts.usage).toEqual({ input_tokens: 13_000, cached_input_tokens: 12_000, output_tokens: 300, outputEstimated: false });
    expect(done.display?.usage).toEqual({ input_tokens: 13_000, cached_input_tokens: 12_000, output_tokens: 300 });
    // The raw line is what the CLI said.
    expect(z.object({ usage: z.object({ input_tokens: z.number() }) }).parse(JSON.parse(done.raw)).usage.input_tokens).toBe(36_000);
  });

  /**
   * Ruling 604: each `token_count` event in the same rollout carries the
   * account's rate-limit snapshot, which Viberr never read, so Profile and
   * Insights showed no Codex usage until a run was refused. Shapes and figures
   * from AWSC-52's rollout on 2026-09-30 (the five-hour window spent, resetting
   * 15:32:58Z; the weekly one at 37%).
   */
  describe("ruling 604: the account's usage window rides the lines", () => {
    type RateWindow = { used_percent: number; window_minutes: number; resets_at: number };
    type RateLimits = {
      limit_id: string;
      primary: RateWindow | null;
      secondary: RateWindow | null;
      rate_limit_reached_type: string | null;
    };
    const tokenCount = (rateLimits: RateLimits) =>
      `${JSON.stringify({
        timestamp: "2026-09-30T13:20:32.219Z",
        type: "event_msg",
        payload: { type: "token_count", info: null, rate_limits: rateLimits },
      })}\n`;
    const codex = (primary: number | null, secondary: number | null) => ({
      limit_id: "codex",
      limit_name: null,
      primary: primary === null ? null : { used_percent: primary, window_minutes: 300, resets_at: 1_790_782_378 },
      secondary:
        secondary === null ? null : { used_percent: secondary, window_minutes: 10_080, resets_at: 1_791_333_093 },
      credits: { has_credits: false, unlimited: false, balance: "0" },
      plan_type: "plus",
      rate_limit_reached_type: null,
    });
    const readings = (lines: EmittedLine[]) =>
      lines.flatMap((l) => (l.facts.rateLimit ? [[z.object({ type: z.string() }).parse(JSON.parse(l.raw)).type, l.facts.rateLimit]] : []));

    it("records the window closest to its limit when it changes, through sparse updates, until it is spent", async () => {
      const shared = ensureUserBackendHome("u_arda", "codex", homes.makeTempDir());
      const lines = await linesOf(shared, [
        { event: { type: "thread.started", thread_id: THREAD } },
        {
          write: `${JSON.stringify({ type: "session_meta", payload: { id: THREAD } })}\n${record([11_000, 0, 100])}${tokenCount(codex(64, 37))}`,
        },
        { event: TOOL },
        // The same reading again, a sparse update that leaves the five-hour
        // window out, and a limit with no windows at all: nothing new.
        { write: tokenCount(codex(64, 37)) + tokenCount(codex(null, 38)) },
        { event: TOOL_DONE },
        { write: tokenCount({ limit_id: "premium", primary: null, secondary: null, rate_limit_reached_type: null }) },
        { event: TOOL },
        { write: tokenCount(codex(100, 38)) },
        { event: TOOL_DONE },
        { event: { type: "turn.completed", usage: { input_tokens: 11_000, cached_input_tokens: 0, output_tokens: 100 } } },
      ]);

      // CANARY: never read the rate limits and no Codex line carries one.
      // CANARY: let a null window clear the last one and the sparse update
      // records the weekly 38% as the account's usage.
      expect(readings(lines)).toEqual([
        ["item.started", { status: "allowed", rateLimitType: "five_hour", utilization: 0.64, resetsAt: 1_790_782_378, isUsingOverage: false }],
        ["item.completed", { status: "rejected", rateLimitType: "five_hour", utilization: 1, resetsAt: 1_790_782_378, isUsingOverage: false }],
      ]);
    });

    it("names the weekly window when it is the one closer to its limit", async () => {
      const shared = ensureUserBackendHome("u_arda", "codex", homes.makeTempDir());
      const lines = await linesOf(shared, [
        { event: { type: "thread.started", thread_id: THREAD } },
        {
          write: `${JSON.stringify({ type: "session_meta", payload: { id: THREAD } })}\n${record([11_000, 0, 100])}${tokenCount(codex(20, 37))}`,
        },
        { event: { type: "item.completed", item: { type: "agent_message", text: "done" } } },
        { event: { type: "turn.completed", usage: { input_tokens: 11_000, cached_input_tokens: 0, output_tokens: 100 } } },
      ]);
      expect(readings(lines)).toEqual([
        ["item.completed", { status: "allowed", rateLimitType: "seven_day", utilization: 0.37, resetsAt: 1_791_333_093, isUsingOverage: false }],
      ]);
    });
  });
});

/**
 * Ruling 595: the Codex CLI streams no event for a reasoning step whose
 * summary is empty, and at a high effort one model call reasons in such steps
 * for many minutes, each one a line in the rollout. Live, two Inventory
 * Analysts on `gpt-6-luna` wrote a reasoning step every ten seconds for
 * fifteen minutes and the idle guard stopped them as hung. The guard now reads
 * the rollout before it calls a quiet stream a hang.
 */
describe("ruling 595: a Codex run still writing its rollout is working, not hung", () => {
  const homes = createTestDbContext();
  afterEach(() => {
    vi.useRealTimers();
    delete process.env.VIBERR_CODEX_IDLE_TIMEOUT_MS;
    resetEnvCacheForTests();
    homes.cleanup();
  });
  const THREAD = "01a0ee9e-fd2a-71f1-aa50-c6a95e1f51bc";

  it("a quiet stream over a growing rollout keeps running, and the window runs from the last write", async () => {
    process.env.VIBERR_CODEX_IDLE_TIMEOUT_MS = "1000";
    resetEnvCacheForTests();
    vi.useFakeTimers({ now: Date.parse("2026-09-29T19:25:56.000Z") });
    const shared = ensureUserBackendHome("u_arda", "codex", homes.makeTempDir());
    const dir = path.join(shared, "sessions", "2026", "09", "29");
    const rollout = path.join(dir, `rollout-2026-09-29T19-23-12-${THREAD}.jsonl`);
    /** The CLI finishing one reasoning step: a line, written now. */
    const reasoningStep = () => {
      mkdirSync(dir, { recursive: true });
      const now = new Date();
      appendFileSync(
        rollout,
        `${JSON.stringify({ timestamp: now.toISOString(), type: "response_item", payload: { type: "reasoning", summary: [] } })}\n`,
      );
      utimesSync(rollout, now, now); // the file's clock is the faked one
    };
    const thread: CodexThread = {
      id: THREAD,
      async runStreamed(_input, turnOptions) {
        const signal = turnOptions?.signal;
        const gen = (async function* () {
          yield { type: "thread.started", thread_id: THREAD };
          // The model reasons: nothing more on the stream until the abort.
          await new Promise<void>((_, reject) => {
            signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          });
        })();
        return { events: asSdkEvents(gen) };
      },
    };
    const client: CodexClient = { startThread: () => thread, resumeThread: () => thread };
    const lines: EmittedLine[] = [];
    let exit: RunExit | null = null;
    createCodexAdapter({ codexFactory: () => client, env: { PATH: "/usr/bin" } }).start(
      { ...SPEC, runId: "run_reasoning", env: { CODEX_HOME: shared } },
      { onLine: (l) => lines.push(l), onExit: (e) => (exit = e) },
    );
    await vi.advanceTimersByTimeAsync(1);

    // Four windows of reasoning steps, one every 400 ms, and no stream event.
    for (let step = 0; step < 10; step++) {
      reasoningStep();
      await vi.advanceTimersByTimeAsync(400);
    }
    // CANARY: drop the rollout check and the guard stops the run in its
    // first window, as it did live.
    expect(exit).toBeNull();

    // The steps stop. The run is hung one window after the last write, 400 ms
    // of which have already passed.
    await vi.advanceTimersByTimeAsync(500);
    expect(exit).toBeNull();
    // CANARY: re-arm a whole window from the check instead of from the last
    // write and the run is still standing here.
    await vi.advanceTimersByTimeAsync(200);
    expect(exit).toMatchObject({ outcome: "error" });
    const last = lines.at(-1)?.display;
    expect(last?.tag).toBe("error·idle_timeout");
    expect(last?.text).toBe("Codex stopped after 1000 ms without producing an event or writing to its session.");
  });
});

describe("codex run marker and settle sweep (ruling 174)", () => {
  const COMPLETED = { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } };
  const MARKED: RunSpec = { ...SPEC, runId: "run_marked", env: { VIBERR_RUN_ID: "run_marked" } };
  /** The two config leaves the adapter writes, read back through their shape. */
  const shellPolicySchema = z.object({ set: z.record(z.string(), z.string()).optional() });
  const mcpServersSchema = z.record(
    z.string(),
    z.object({
      command: z.string().optional(),
      args: z.array(z.string()).optional(),
      url: z.string().optional(),
      default_tools_approval_mode: z.string(),
      env: z.record(z.string(), z.string()).optional(),
    }),
  );

  function recordReaps() {
    const reaped: ReapTargets[] = [];
    const reapProcesses = async (targets: ReapTargets) => {
      reaped.push(targets);
      return { terminated: 0, killed: 0 };
    };
    return { reaped, reapProcesses };
  }

  it("declares the marker for the model's shell and every stdio MCP server, and nowhere it has no job", async () => {
    const run = fakeCodex([COMPLETED]);
    createCodexAdapter({ codexFactory: run.factory, ...recordReaps() }).start(
      {
        ...MARKED,
        mcpServers: {
          files: { command: "npx", args: ["-y", "@example/files"] },
          docs: { type: "http", url: "https://docs.example.test/mcp" },
        },
      },
      { onLine: () => {}, onExit: () => {} },
    );
    await drain();
    const options = run.factoryOptions();
    // The CLI's own process env: the SDK passes it whole.
    expect(options?.env?.VIBERR_RUN_ID).toBe("run_marked");
    const policy = shellPolicySchema.parse(options?.config?.shell_environment_policy);
    expect(policy.set).toEqual({ VIBERR_RUN_ID: "run_marked" });
    const servers = mcpServersSchema.parse(options?.config?.mcp_servers);
    expect(servers.files).toEqual({
      command: "npx",
      args: ["-y", "@example/files"],
      default_tools_approval_mode: "approve",
      env: { VIBERR_RUN_ID: "run_marked" },
    });
    // An HTTP server is no process of the run's: nothing to mark.
    expect(servers.docs).not.toHaveProperty("env");
  });

  it("a run the service did not mark declares no marker", async () => {
    const run = fakeCodex([COMPLETED]);
    createCodexAdapter({ codexFactory: run.factory, ...recordReaps() }).start(
      { ...SPEC, mcpServers: { files: { command: "npx", args: [] } } },
      { onLine: () => {}, onExit: () => {} },
    );
    await drain();
    const config = run.factoryOptions()?.config;
    expect(shellPolicySchema.parse(config?.shell_environment_policy).set).toBeUndefined();
    expect(mcpServersSchema.parse(config?.mcp_servers).files).not.toHaveProperty("env");
  });

  it("sweeps the run's marked processes once it settles — finished, failed or stopped", async () => {
    // Finished.
    const finished = recordReaps();
    createCodexAdapter({ codexFactory: fakeCodex([COMPLETED]).factory, ...finished }).start(
      MARKED,
      { onLine: () => {}, onExit: () => {} },
    );
    await drain();
    expect(finished.reaped).toEqual([{ runIds: ["run_marked"] }]);

    // Failed: the stream rejects before a single event.
    const failed = recordReaps();
    const failingClient: CodexClient = {
      startThread: () => ({
        id: null,
        runStreamed: async () => ({ events: failingEvents(new Error("Codex Exec exited with code 1")) }),
      }),
      resumeThread: () => ({ id: null, runStreamed: async () => ({ events: failingEvents(new Error("x")) }) }),
    };
    createCodexAdapter({ codexFactory: () => failingClient, ...failed }).start(MARKED, {
      onLine: () => {},
      onExit: () => {},
    });
    await drain();
    expect(failed.reaped).toEqual([{ runIds: ["run_marked"] }]);

    // Stopped: the abort ends the stream, and the settle sweeps what the
    // SDK's lone SIGTERM did not reach.
    const stopped = recordReaps();
    let exit: RunExit | null = null;
    const stalledClient: CodexClient = {
      startThread: () => ({
        id: null,
        runStreamed: async (_input, turnOptions) => ({ events: stalledEvents(turnOptions?.signal) }),
      }),
      resumeThread: () => ({ id: null, runStreamed: async () => ({ events: stalledEvents() }) }),
    };
    const handle = createCodexAdapter({ codexFactory: () => stalledClient, ...stopped }).start(
      MARKED,
      { onLine: () => {}, onExit: (e) => (exit = e) },
    );
    await drain();
    expect(stopped.reaped).toEqual([]);
    handle.interrupt();
    await drain();
    expect(exit).toMatchObject({ outcome: "interrupted" });
    expect(stopped.reaped).toEqual([{ runIds: ["run_marked"] }]);
  });

  it("sweeps nothing for a run the service did not mark — it started nothing that could be found", async () => {
    const { reaped, reapProcesses } = recordReaps();
    createCodexAdapter({ codexFactory: fakeCodex([COMPLETED]).factory, reapProcesses }).start(
      SPEC,
      { onLine: () => {}, onExit: () => {} },
    );
    await drain();
    expect(reaped).toEqual([]);
  });
});

/**
 * Rulings 370 and 371 on the Codex side: the prompt split joins into
 * `developer_instructions` in the same order, a specialist's config carries
 * the compaction window with the shared summarizer prompt (and the operator's
 * does not), and the server table reaches the CLI in name order.
 */
describe("ruling 370/371: the joined prompt, the compaction keys and sorted servers", () => {
  it("joins a prompt split into developer_instructions and sets the specialist's summarizer prompt (no limit since ruling 376)", async () => {
    const run = fakeCodex([{ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }]);
    createCodexAdapter({ codexFactory: run.factory, env: { PATH: "/usr/bin" } }).start(
      { ...SPEC, systemPrompt: { static: ["# Persona\n"], dynamic: ["# This task\n"] } },
      { onLine: () => {}, onExit: () => {} },
    );
    await drain();
    expect(run.factoryOptions()?.config).toMatchObject({
      developer_instructions: "# Persona\n# This task\n",
    });
    const prompt = z.string().parse(run.factoryOptions()?.config?.compact_prompt);
    expect(prompt).toContain("task.md");
    expect(prompt).toContain("read_knowledge_doc");
  });

  it("an operator run sets none of the compaction keys and keeps the CLI's default", async () => {
    const run = fakeCodex([{ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }]);
    createCodexAdapter({ codexFactory: run.factory, env: { PATH: "/usr/bin" } }).start(
      { ...SPEC, kind: "operator", systemPrompt: "op" },
      { onLine: () => {}, onExit: () => {} },
    );
    await drain();
    const config = run.factoryOptions()?.config ?? {};
    expect(config.developer_instructions).toBe("op");
    expect("model_auto_compact_token_limit" in config).toBe(false);
    expect("compact_prompt" in config).toBe(false);
  });

  it("servers and their withheld tools reach the CLI in name order", async () => {
    const run = fakeCodex([{ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }]);
    createCodexAdapter({ codexFactory: run.factory, env: { PATH: "/usr/bin" } }).start(
      {
        ...SPEC,
        mcpServers: {
          zulu: { type: "http", url: "https://z" },
          alpha: { command: "npx", args: ["-y", "a"] },
        },
        mcpToolDenials: [{ server: "alpha", tools: ["write_b", "write_a"] }],
      },
      { onLine: () => {}, onExit: () => {} },
    );
    await drain();
    const servers = z.record(z.string(), z.object({ disabled_tools: z.array(z.string()).optional() })).parse(
      run.factoryOptions()?.config?.mcp_servers,
    );
    expect(Object.keys(servers)).toEqual(["alpha", "zulu"]);
    expect(servers.alpha?.disabled_tools).toEqual(["write_a", "write_b"]);
  });
});

/**
 * Ruling 376: the Codex completion compaction goes through the app-server,
 * in the principal's shared home with the run's credential overlay, the
 * thread's model and the shared summarizer prompt.
 */
describe("codex adapter compact() (ruling 376)", () => {
  const compactHomes = createTestDbContext();
  afterEach(() => compactHomes.cleanup());
  interface ServerLine {
    id?: number | undefined;
    method?: string;
    params?: { threadId: string; turnId: string };
    result?: { thread?: { id: string } };
    error?: { code: number; message: string };
  }
  interface ClientRequest {
    id?: number;
    method: string;
    params?: { threadId?: string; cwd?: string; model?: string; config?: { compact_prompt?: string } };
  }
  const requestSchema = z.object({
    id: z.number().optional(),
    method: z.string(),
    params: z
      .object({
        threadId: z.string().optional(),
        cwd: z.string().optional(),
        model: z.string().optional(),
        config: z.object({ compact_prompt: z.string().optional() }).optional(),
      })
      .optional(),
  });
  const scripted = (reply: (method: string, id: number | undefined, write: (line: ServerLine) => void) => void) => {
    const stdout = new PassThrough();
    const stdin = new PassThrough();
    const requests: ClientRequest[] = [];
    const spawned: { binary: string; args: readonly string[]; env: Record<string, string> | undefined }[] = [];
    const write = (line: ServerLine) => stdout.write(`${JSON.stringify(line)}\n`);
    let buffer = "";
    stdin.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      let nl = buffer.indexOf("\n");
      while (nl >= 0) {
        const request: ClientRequest = requestSchema.parse(JSON.parse(buffer.slice(0, nl)));
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf("\n");
        requests.push(request);
        reply(request.method, request.id, write);
      }
    });
    const process = { stdin, stdout, stderr: null, kill: () => true, once: () => process, on: () => process };
    return {
      requests,
      spawned,
      spawn: (binary: string, args: readonly string[], env: Record<string, string> | undefined) => {
        spawned.push({ binary, args, env });
        return process;
      },
    };
  };

  it("resumes the thread in a private fork of the shared home with the model and the summarizer prompt, then starts the compaction", async () => {
    // Ruling 507: the fork is seeded with the sign-in of the account the run
    // billed, and settled like a run's — its refresh goes back to that account.
    const dataRoot = compactHomes.makeTempDir();
    const shared = ensureUserBackendHome("u_arda", "codex", dataRoot);
    const accountHome = backendAccountHome("u_arda", "codex", { id: "ubc_billed", legacyHome: false }, dataRoot);
    mkdirSync(accountHome, { recursive: true });
    writeFileSync(path.join(accountHome, "auth.json"), '{"tokens":"before"}');
    const forkHome = path.join(shared, "runs", `${SPEC.runId}-compaction`);
    let seededWith: string | null = null;
    const server = scripted((method, id, write) => {
      if (method === "initialize") {
        seededWith = readFileSync(path.join(forkHome, "auth.json"), "utf8");
        // The CLI refreshes the token inside the fork while it works.
        writeFileSync(path.join(forkHome, "auth.json"), '{"tokens":"after"}');
      }
      if (method === "initialize" || method === "thread/resume") write({ id, result: {} });
      if (method === "thread/compact/start") {
        write({ id, result: {} });
        write({ method: "thread/compacted", params: { threadId: "thread-1", turnId: "t" } });
      }
    });
    const adapter = createCodexAdapter({ env: { PATH: "/usr/bin" }, spawnAppServer: server.spawn });
    const phases: string[] = [];
    const lines: EmittedLine[] = [];
    const outcome = await adapter.compact!(
      {
        ...SPEC,
        model: "gpt-5.6-terra",
        env: { CODEX_HOME: shared, VIBERR_RUN_ID: "run_1" },
        accountHome,
      },
      "thread-1",
      { onLine: (l) => lines.push(l), onPhase: (phase) => phases.push(phase ?? "") },
    );
    expect(outcome).toEqual({ compacted: true, preTokens: null, postTokens: null });
    expect(phases[0]).toBe(RUN_PHASE.compacting);
    // The run's credential overlay and its own fork of the home, under the
    // epilogue's OWN marker (the run's settle sweep reaps `r1`; this process
    // must outlive it). The state db stays the person's shared one.
    expect(server.spawned[0]).toMatchObject({
      args: ["app-server"],
      env: {
        PATH: "/usr/bin",
        CODEX_HOME: forkHome,
        CODEX_SQLITE_HOME: shared,
        VIBERR_RUN_ID: `${SPEC.runId}:compaction`,
      },
    });
    expect(seededWith).toBe('{"tokens":"before"}');
    // Settled: the refresh went back to the billed account, the fork is gone.
    expect(existsSync(forkHome)).toBe(false);
    expect(readFileSync(path.join(accountHome, "auth.json"), "utf8")).toBe('{"tokens":"after"}');
    expect(server.requests.map((r) => r.method)).toEqual(["initialize", "initialized", "thread/resume", "thread/compact/start"]);
    expect(server.requests[2]?.params).toMatchObject({
      threadId: "thread-1",
      cwd: SPEC.workdir,
      model: "gpt-5.6-terra",
      config: { compact_prompt: expect.stringContaining("task.md") },
    });
    // The sizes come off the rollout in the run service; the adapter says nothing here.
    expect(lines).toHaveLength(0);
  });

  it("a refusal lands on the log as one line and the outcome's reason", async () => {
    const server = scripted((method, id, write) => {
      if (method === "initialize") write({ id, result: {} });
      if (method === "thread/resume") write({ id, error: { code: 1, message: "thread not found" } });
    });
    const adapter = createCodexAdapter({ env: {}, spawnAppServer: server.spawn });
    const lines: EmittedLine[] = [];
    const shared = ensureUserBackendHome("u_arda", "codex", compactHomes.makeTempDir());
    const outcome = await adapter.compact!({ ...SPEC, env: { CODEX_HOME: shared } }, "gone", { onLine: (l) => lines.push(l) });
    expect(outcome).toEqual({ compacted: false, reason: "thread/resume refused: thread not found" });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.display?.tag).toBe("run·compaction·failed");
    expect(lines[0]!.display?.text).toContain("thread not found");
  });
});


/**
 * Ruling 394 (F39-21) — a completed turn is a completed turn.
 *
 * Live on the ax-clone board, twice inside ten minutes: a Codex developer run
 * emitted a complete outcome envelope, the provider emitted `turn.completed`,
 * and THEN the socket died while Viberr ran its own end-of-run compaction. The
 * adapter's gate read `sawTurnCompleted && !sawFatalError` — a conjunction over
 * the whole stream with no regard for ORDER — so the drop settled the run
 * `error`. AX-2 had 1,531 lines of committed Go across seven files in its
 * workspace and AX-3 two commits; both tasks were parked `waiting: human`
 * under a packet whose RECOMMENDED option was to re-run the agent that had
 * already finished.
 *
 * What the provider actually streamed, in this order (run_Ys0uzCRS_twA):
 *   item.completed(agent_message, the envelope) -> turn.completed -> error
 */
function fakeCodexThenThrow(
  events: unknown[],
  error: Error,
): (options?: CodexOptions) => CodexClient {
  const makeThread = (): CodexThread => ({
    id: "0199a1f3-4c02-7d31",
    async runStreamed() {
      const gen = (async function* () {
        for (const e of events) {
          yield e;
          await new Promise((r) => setTimeout(r, 0));
        }
        throw error;
      })();
      return { events: asSdkEvents(gen) };
    },
  });
  const client: CodexClient = {
    startThread: () => makeThread(),
    resumeThread: () => makeThread(),
  };
  return () => client;
}

describe("ruling 394: the transport died after the turn completed", () => {
  const ENVELOPE = {
    type: "item.completed",
    item: {
      type: "agent_message",
      text: '{"evidence":[],"summary":"@operator Done on branch `ax-2`, commit `3e0396ab`.","verdict":null,"question":null}',
    },
  };
  const TURN_DONE = {
    type: "turn.completed",
    usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 20 },
  };
  const DROP =
    "Reconnecting... waiting for network (Connection failed: error sending request)";

  async function runWith(
    factory: (options?: CodexOptions) => CodexClient,
  ): Promise<{ lines: EmittedLine[]; exit: RunExit | null }> {
    const lines: EmittedLine[] = [];
    let exit: RunExit | null = null;
    createCodexAdapter({ codexFactory: factory }).start(SPEC, {
      onLine: (l) => lines.push(l),
      onExit: (e) => (exit = e),
    });
    await drain();
    return { lines, exit };
  }

  it("finishes the run when the STREAM THROWS after turn.completed", async () => {
    // CANARY: drop the `turnStoodComplete()` branch from the catch and this
    // run settles `error` again, which is the live defect verbatim.
    const { lines, exit } = await runWith(
      fakeCodexThenThrow(
        [{ type: "turn.started" }, ENVELOPE, TURN_DONE],
        new Error(DROP),
      ),
    );
    expect(exit).toMatchObject({ outcome: "finished" });
    // The agent's own final message survives for the completion pipeline.
    expect(lines.some((l) => l.raw.includes("3e0396ab"))).toBe(true);
    // The drop is recorded, and NOT as the run's cause.
    const note = lines.at(-1)!;
    expect(note.display?.tag).toBe("run·transport·after-turn");
    expect(note.display?.ev).toBe("meta");
    expect(note.display?.text).toContain(
      "the connection dropped after the agent's turn had completed",
    );
    expect(lines.some((l) => l.display?.ev === "err")).toBe(false);
  });

  it("finishes the run when a fatal ERROR EVENT lands after turn.completed", async () => {
    const { lines, exit } = await runWith(
      fakeCodex([
        { type: "turn.started" },
        ENVELOPE,
        TURN_DONE,
        { type: "error", message: DROP },
      ]).factory,
    );
    expect(exit).toMatchObject({ outcome: "finished" });
    expect(
      lines.some((l) => l.display?.tag === "run·transport·after-turn"),
    ).toBe(true);
  });

  it("finishes when the provider RECOVERED from a blip and then completed the turn", async () => {
    // Live on ax-clone AX-4 (run_PmefJ4iUKtTQ), the third occurrence of this
    // shape in one morning and the sharpest: the CLI printed its reconnect
    // banner mid-turn, recovered, emitted a complete operator decision plan
    // (engage the reviewer on revision ed4a600 — the one action that would
    // have cleared AX-4's review gate), and completed the turn. `sawFatalError`
    // is sticky, so the old gate could never settle this finished however the
    // stream ended, and Viberr threw the plan away and asked a human to
    // "Re-run the operator now".
    const { lines, exit } = await runWith(
      fakeCodexThenThrow(
        [
          { type: "turn.started" },
          { type: "error", message: DROP },
          ENVELOPE,
          TURN_DONE,
        ],
        new Error(DROP),
      ),
    );
    expect(exit).toMatchObject({ outcome: "finished" });
    expect(lines.some((l) => l.raw.includes("3e0396ab"))).toBe(true);
  });

  it("still FAILS a run cut off while work was in flight", async () => {
    // The whole point of the order test: turn 1 completed, the agent started
    // another item, and THAT is what the drop cut. Nothing stands finished.
    const { exit } = await runWith(
      fakeCodexThenThrow(
        [
          { type: "turn.started" },
          TURN_DONE,
          { type: "item.started", item: { type: "command_execution" } },
        ],
        new Error(DROP),
      ),
    );
    expect(exit).toMatchObject({ outcome: "error" });
  });

  it("still FAILS a run that never completed a turn at all", async () => {
    const { exit } = await runWith(
      fakeCodexThenThrow([{ type: "turn.started" }], new Error(DROP)),
    );
    expect(exit).toMatchObject({ outcome: "error" });
  });

  it("still FAILS when a fatal error event leaves work in flight and no completed turn", async () => {
    // A fatal event, then more work, then the stream ends: no turn stands
    // complete, so the run fails (ruling 394). An error followed by a
    // completed turn is a recovery and finishes; see the RECOVERED test above.
    const { exit } = await runWith(
      fakeCodex([
        { type: "turn.started" },
        { type: "error", message: "You've hit your usage limit" },
        { type: "item.started", item: { type: "command_execution" } },
      ]).factory,
    );
    expect(exit).toMatchObject({ outcome: "error" });
  });
});

/**
 * Ruling 534: the Codex SDK writes a turn's output schema into a 0700
 * directory of the server's own, and the CLI behind the launcher runs as the
 * person's agent uid (ruling 460). Live, every Codex run given a schema
 * failed before its first turn: "Failed to read output schema file ...
 * Permission denied". Driven through the REAL SDK class, so an SDK whose exec
 * no longer takes the hook fails here rather than on the board.
 */
describe("ruling 534: a turn's output schema is readable by the agent the launcher runs", () => {
  const homes = createTestDbContext();
  afterEach(() => homes.cleanup());

  it("shares the SDK's schema file with the agent group before the CLI starts", async () => {
    // CANARY: drop `share(args.outputSchemaFile)` in shareOutputSchemaWithAgent
    // and the CLI finds a 0700 directory it cannot enter.
    const { Codex } = await import("@openai/codex-sdk");
    const dir = homes.makeTempDir("viberr-schema-");
    const seen = path.join(dir, "seen.json");
    const cli = path.join(dir, "codex");
    writeFileSync(
      cli,
      `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const file = args[args.indexOf("--output-schema") + 1];
const st = (p) => { const s = fs.statSync(p); return { mode: s.mode & 0o7777, gid: s.gid }; };
fs.writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ dir: st(path.dirname(file)), file: st(file), schema: JSON.parse(fs.readFileSync(file, "utf8")) }));
const out = (e) => process.stdout.write(JSON.stringify(e) + "\\n");
out({ type: "thread.started", thread_id: "th_534" });
out({ type: "turn.started" });
out({ type: "item.completed", item: { id: "i1", type: "agent_message", text: "{}" } });
out({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } });
`,
    );
    chmodSync(cli, 0o755);
    const codex = new Codex({ codexPathOverride: cli, env: { PATH: process.env.PATH ?? "" } });
    const gid = process.getgid?.() ?? 0;
    shareOutputSchemaWithAgent(codex, (file) => shareFileForAgentsToRead(file, { gid }));
    const { events } = await codex
      .startThread()
      .runStreamed("hello", { outputSchema: { type: "object", properties: {}, additionalProperties: false } });
    for await (const event of events) expect(event.type).toBeTruthy();
    const recorded = z
      .object({
        dir: z.object({ mode: z.number(), gid: z.number() }),
        file: z.object({ mode: z.number(), gid: z.number() }),
        schema: z.object({ type: z.string() }),
      })
      .parse(JSON.parse(readFileSync(seen, "utf8")));
    expect(recorded.dir).toEqual({ mode: 0o710, gid });
    expect(recorded.file).toEqual({ mode: 0o640, gid });
    expect(recorded.schema.type).toBe("object");
  });
});
