import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type {
  CodexOptions,
  RunStreamedResult,
  ThreadOptions,
} from "@openai/codex-sdk";
import type { EmittedLine, RunExit, RunSpec } from "./adapter.server";
import {
  CODEX_SDK_VERIFIED_VERSION,
  createCodexAdapter,
  resolveCodexReasoningEffort,
  resolveCodexSandboxMode,
  type CodexClient,
  type CodexThread,
} from "./codex-runtime.server";
import { createTestDbContext } from "../../../test-support/test-db";
import { insertRunLine, upsertRun } from "./run-store.server";
import { runFailureReason } from "../tasks/agent-reply.server";
import { resetEnvCacheForTests } from "../config/env.server";

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

describe("resolveCodexReasoningEffort", () => {
  it("accepts only values supported by the installed SDK", () => {
    expect(resolveCodexReasoningEffort("minimal")).toBe("minimal");
    expect(resolveCodexReasoningEffort("xhigh")).toBe("xhigh");
    expect(resolveCodexReasoningEffort("max")).toBeUndefined();
    expect(resolveCodexReasoningEffort("")).toBeUndefined();
  });
});

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

  it("threads spec.effort into startThread modelReasoningEffort (omits when absent)", async () => {
    const events = [
      { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
    ];

    const withEffort = fakeCodex(events);
    createCodexAdapter({ codexFactory: withEffort.factory }).start(
      { ...SPEC, effort: "high" },
      { onLine: () => {}, onExit: () => {} },
    );
    await drain();
    expect(withEffort.startOptions()).toMatchObject({
      model: "gpt-5.4-codex",
      modelReasoningEffort: "high",
    });

    const noEffort = fakeCodex(events);
    createCodexAdapter({ codexFactory: noEffort.factory }).start(SPEC, {
      onLine: () => {},
      onExit: () => {},
    });
    await drain();
    expect(noEffort.startOptions()?.modelReasoningEffort).toBeUndefined();

    const unsupported = fakeCodex(events);
    createCodexAdapter({ codexFactory: unsupported.factory }).start(
      { ...SPEC, effort: "max" },
      { onLine: () => {}, onExit: () => {} },
    );
    await drain();
    expect(unsupported.startOptions()?.modelReasoningEffort).toBeUndefined();
  });

  it("uses the same supported options for start/resume and confines operators", async () => {
    const events = [
      { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
    ];

    const resumed = fakeCodex(events);
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

    const operator = fakeCodex(events);
    createCodexAdapter({ codexFactory: operator.factory }).start(
      { ...SPEC, kind: "operator" },
      { onLine: () => {}, onExit: () => {} },
    );
    await drain();
    expect(operator.startOptions()).toMatchObject({
      sandboxMode: "read-only",
      approvalPolicy: "never",
      networkAccessEnabled: false,
      webSearchMode: "disabled",
    });

    // F10-12/F10-04: a supporting/reviewing run is read-only for the workspace
    // (only the delivering engagement mutates), but — unlike the operator — it
    // keeps network access for declared MCP resources.
    const reviewer = fakeCodex(events);
    createCodexAdapter({ codexFactory: reviewer.factory }).start(
      { ...SPEC, kind: "reviewer" },
      { onLine: () => {}, onExit: () => {} },
    );
    await drain();
    const revOpts = reviewer.startOptions()!;
    expect(revOpts.sandboxMode).toBe("read-only");
    expect(revOpts.networkAccessEnabled).toBeUndefined();
  });

  // P14-RT-06: `use-web-search-fetch` withheld was enforced on Claude (the
  // WebFetch/WebSearch denial) and on NOTHING on Codex — although the option
  // that enforces it was already being set, two lines away, for the operator.
  it("disables web search for a specialist whose web-egress grant is withheld", async () => {
    const events = [
      { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
    ];

    const withheld = fakeCodex(events);
    createCodexAdapter({ codexFactory: withheld.factory }).start(
      { ...SPEC, webSearchWithheld: true },
      { onLine: () => {}, onExit: () => {} },
    );
    await drain();
    const withheldOpts = withheld.startOptions()!;
    expect(withheldOpts.webSearchMode).toBe("disabled");
    // Only the WEB SEARCH tool goes: declared MCP servers and the workspace's
    // own tooling still need the network, and a delivering run still writes.
    expect(withheldOpts.networkAccessEnabled).toBeUndefined();
    expect(withheldOpts.sandboxMode).toBe("danger-full-access");

    const granted = fakeCodex(events);
    createCodexAdapter({ codexFactory: granted.factory }).start(SPEC, {
      onLine: () => {},
      onExit: () => {},
    });
    await drain();
    expect(granted.startOptions()!.webSearchMode).toBeUndefined();
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
    });
  });

  it("overlays spec.env on a COMPLETE base env, never on {} (#3)", async () => {
    // The Codex SDK replaces the child env wholesale. Per-run env (e.g.
    // GIT_CEILING_DIRECTORIES) must land on top of a full process.env snapshot
    // so PATH/HOME survive — overlaying onto {} would break the spawned binary.
    const events = [
      { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
    ];
    let factoryOpts: CodexOptions | undefined;
    const client: CodexClient = {
      startThread: (o) => {
        void o;
        return {
          id: "t",
          async runStreamed() {
            return {
              events: asSdkEvents(
                (async function* () {
                  for (const e of events) yield e;
                })(),
              ),
            };
          },
        };
      },
      resumeThread: () => ({
        id: "t",
        async runStreamed() {
          return { events: asSdkEvents((async function* () {})()) };
        },
      }),
    };
    const factory = (opts?: CodexOptions) => {
      factoryOpts = opts;
      return client;
    };
    createCodexAdapter({ codexFactory: factory }).start(
      { ...SPEC, env: { GIT_CEILING_DIRECTORIES: "/ceil" } },
      { onLine: () => {}, onExit: () => {} },
    );
    await drain();
    expect(factoryOpts?.env?.GIT_CEILING_DIRECTORIES).toBe("/ceil");
    // PATH from the real process.env must have survived the overlay.
    expect(factoryOpts?.env?.PATH).toBe(process.env.PATH);
  });

  it("passes no env override when neither deps.env nor spec.env is set (#3)", async () => {
    const events = [
      { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
    ];
    const seen: (CodexOptions | undefined)[] = [];
    const client: CodexClient = {
      startThread: () => ({
        id: "t",
        async runStreamed() {
          return {
            events: asSdkEvents(
              (async function* () {
                for (const e of events) yield e;
              })(),
            ),
          };
        },
      }),
      resumeThread: () => ({
        id: "t",
        async runStreamed() {
          return { events: asSdkEvents((async function* () {})()) };
        },
      }),
    };
    const factory = (opts?: CodexOptions) => {
      seen.push(opts);
      return client;
    };
    createCodexAdapter({ codexFactory: factory }).start(SPEC, {
      onLine: () => {},
      onExit: () => {},
    });
    await drain();
    const factoryOpts = seen.at(-1);
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

  it("retains a safe auth category while redacting the raw SDK failure", async () => {
    const thread: CodexThread = {
      id: "thread-1",
      async runStreamed() {
        return {
          events: failingEvents(
            new Error("401 unauthorized for token sk-secretsentinel0123456789"),
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

    const errText = lines.at(-1)?.display?.text ?? "";
    expect(errText).toContain(
      "Codex authentication failed. Review the configured subscription credential.",
    );
    // R20-3: the provider's sentence surfaces with the token redacted by shape.
    expect(errText).toContain("401 unauthorized for token [redacted]");
    expect(errText).not.toContain("sk-secretsentinel0123456789");
    expect(lines.at(-1)?.raw).not.toContain("sk-secretsentinel0123456789");
  });

  it("retains a safe quota category while redacting the raw SDK failure", async () => {
    const thread: CodexThread = {
      id: "thread-1",
      async runStreamed() {
        return {
          events: failingEvents(
            new Error(
              "429 rate limit: internal request id sk-secretsentinel0123456789",
            ),
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

    const errText = lines.at(-1)?.display?.text ?? "";
    expect(errText).toContain(
      "Codex usage limit was reached. Retry after the subscription limit resets.",
    );
    expect(errText).toContain("The provider reported:");
    expect(errText).not.toContain("sk-secretsentinel0123456789");
    expect(lines.at(-1)?.raw).not.toContain("sk-secretsentinel0123456789");
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

describe("codex sandbox enforces the withheld repo-write grant (P13-RT-02)", () => {
  it("a delivering run whose repo-write grant is withheld is read-only", () => {
    // `autonomous` stays TRUE — it also drives Claude's permissionMode, and
    // flipping it would hang a server run on an unanswerable approval.
    expect(
      resolveCodexSandboxMode({
        ...SPEC,
        kind: "primary",
        autonomous: true,
        repoWriteWithheld: true,
      }),
    ).toBe("read-only");
  });

  it("a fully-granted delivering run still gets full access", () => {
    expect(
      resolveCodexSandboxMode({ ...SPEC, kind: "primary", autonomous: true }),
    ).toBe("danger-full-access");
    expect(
      resolveCodexSandboxMode({
        ...SPEC,
        kind: "primary",
        autonomous: true,
        repoWriteWithheld: false,
      }),
    ).toBe("danger-full-access");
  });

  it("operators and supporting runs stay read-only regardless", () => {
    expect(resolveCodexSandboxMode({ ...SPEC, kind: "operator" })).toBe("read-only");
    expect(resolveCodexSandboxMode({ ...SPEC, kind: "reviewer" })).toBe("read-only");
  });

  it("reaches the SDK thread options", async () => {
    const run = fakeCodex([
      { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
    ]);
    createCodexAdapter({ codexFactory: run.factory }).start(
      { ...SPEC, repoWriteWithheld: true },
      { onLine: () => {}, onExit: () => {} },
    );
    await drain();
    expect(run.startOptions()?.sandboxMode).toBe("read-only");
  });

  /** Owner ask 2026-08-20 — the attachments drop. The task's attachments dir
   * joins the sandbox as an additional writable directory ONLY at
   * workspace-write: full access can already write it, and widening a
   * read-only run would break the P13-RT-02 honesty rule this describe pins
   * (the matrix said closed, the sandbox stayed closed). */
  it("widens only the workspace-write sandbox with the attachments dir", async () => {
    const DIR = "/data/projects/p/tasks/T-1/attachments";
    const done = [
      { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
    ];

    const ws = fakeCodex(done);
    createCodexAdapter({ codexFactory: ws.factory }).start(
      { ...SPEC, autonomous: false, attachmentsWritableDir: DIR },
      { onLine: () => {}, onExit: () => {} },
    );
    await drain();
    expect(ws.startOptions()).toMatchObject({
      sandboxMode: "workspace-write",
      additionalDirectories: [DIR],
    });

    const ro = fakeCodex(done);
    createCodexAdapter({ codexFactory: ro.factory }).start(
      { ...SPEC, repoWriteWithheld: true, attachmentsWritableDir: DIR },
      { onLine: () => {}, onExit: () => {} },
    );
    await drain();
    expect(ro.startOptions()?.sandboxMode).toBe("read-only");
    expect(ro.startOptions()?.additionalDirectories).toBeUndefined();

    const full = fakeCodex(done);
    createCodexAdapter({ codexFactory: full.factory }).start(
      { ...SPEC, attachmentsWritableDir: DIR },
      { onLine: () => {}, onExit: () => {} },
    );
    await drain();
    expect(full.startOptions()?.sandboxMode).toBe("danger-full-access");
    expect(full.startOptions()?.additionalDirectories).toBeUndefined();
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

  it("is the version the adapter header quotes", async () => {
    const { readFileSync } = await import("node:fs");
    const header = readFileSync(
      new URL("./codex-runtime.server.ts", import.meta.url),
      "utf8",
    ).slice(0, 3000);
    expect(header).toContain(`v${CODEX_SDK_VERIFIED_VERSION}`);
  });
});

/**
 * UC-16 — the Codex half of the two DISCLOSED MCP/skills asymmetries.
 *
 * The capability-matrix modal tells an admin two things about this backend:
 * "Org MCP credentials are sent on Claude runs only — Codex mounts a declared
 * server unauthenticated, because its MCP config travels in argv", and that
 * granted skills arrive as prompt text here because there is no native channel.
 * A disclosure that drifts from the adapter is worse than none, so both claims
 * are pinned against what the adapter actually hands the SDK. The Claude halves
 * live in `claude-runtime.server.test.ts`; the paired assertions in
 * `runtime-registry.server.test.ts`.
 */
describe("UC-16 disclosed asymmetries — the Codex side", () => {
  const SECRET = "sentinel-org-mcp-credential";

  /** The exact shapes `resolveSpecialistMcpServers` builds for a granted org
   *  MCP server that carries a credential (specialist-mcp.server.ts). */
  const CREDENTIALED_SERVERS = {
    "everything-http": {
      type: "http",
      url: "https://mcp.example.test/mcp",
      headers: { Authorization: `Bearer ${SECRET}` },
    },
    "everything-stdio": {
      command: "npx",
      args: ["-y", "example-mcp"],
      env: { MCP_CREDENTIAL: SECRET },
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

  it("mounts a credentialed org MCP server UNAUTHENTICATED — the token is dropped, not the server", async () => {
    const config = await configWith({ mcpServers: CREDENTIALED_SERVERS });
    // SAFETY: `mcp_servers` is a leaf the ADAPTER writes — one table per
    // declared server (see the mcpServers translation in codex-runtime.server) —
    // so reading it back as a config table is the shape it was written as. The
    // assertions below check the whole table, so nothing may be stripped here.
    const servers = (config?.mcp_servers ?? {}) as NonNullable<
      CodexOptions["config"]
    >;

    // The server still mounts (dropping it silently would be the dishonest fix).
    expect(Object.keys(servers).sort()).toEqual([
      "everything-http",
      "everything-stdio",
    ]);
    expect(servers["everything-http"]).toEqual({
      url: "https://mcp.example.test/mcp",
      default_tools_approval_mode: "approve",
    });
    expect(servers["everything-stdio"]).toEqual({
      command: "npx",
      args: ["-y", "example-mcp"],
      default_tools_approval_mode: "approve",
    });
    // …with NO credential carrier of any kind, on either transport.
    expect(servers["everything-http"]).not.toHaveProperty("headers");
    expect(servers["everything-stdio"]).not.toHaveProperty("env");
    // The reason it is dropped rather than translated: this config becomes
    // `--config key=value` argv on the spawned codex binary, where a literal
    // secret is readable in `ps auxww`. Nothing in the config may echo it.
    expect(JSON.stringify(config)).not.toContain(SECRET);
  });

  it("has no in-process tool channel: the mid-run comment/ask-human toolkit is dropped, never serialized", async () => {
    const config = await configWith({ mcpServers: CREDENTIALED_SERVERS });
    // `{ type: "sdk" }` is a live JS object with no CLI equivalent — serializing
    // it would produce invalid config instead of an honest omission. This is why
    // "Post mid-run comments" is disclosed as having no Codex channel: a Codex
    // agent's report posts when the run ENDS, through the outcome envelope.
    expect(config?.mcp_servers).not.toHaveProperty("viberr_agent");
    expect(JSON.stringify(config)).not.toContain("viberr_agent");
  });

  it("passes the DECLARED server name through unchanged (the rename is the CLI's, not Viberr's)", async () => {
    // P13-LV-15: the codex binary lowercases hyphens to underscores when it
    // derives a tool prefix (`mcp__everything_http__…`). Viberr must not
    // pre-normalize to match it — the same declaration has to keep working on
    // Claude, where the hyphen survives. The disclosure tells personas never to
    // name an MCP tool literally; this pins that Viberr itself stays neutral.
    const config = await configWith({ mcpServers: CREDENTIALED_SERVERS });
    expect(Object.keys(config?.mcp_servers ?? {})).toContain("everything-http");
    expect(Object.keys(config?.mcp_servers ?? {})).not.toContain(
      "everything_http",
    );
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
