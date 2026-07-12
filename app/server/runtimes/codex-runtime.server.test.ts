import { describe, expect, it } from "vitest";
import type {
  CodexOptions,
  RunStreamedResult,
  ThreadOptions,
} from "@openai/codex-sdk";
import type { EmittedLine, RunExit, RunSpec } from "./adapter.server";
import {
  createCodexAdapter,
  resolveCodexReasoningEffort,
  type CodexClient,
  type CodexThread,
} from "./codex-runtime.server";

function asSdkEvents(
  events: AsyncGenerator<unknown, void>,
): RunStreamedResult["events"] {
  return events as RunStreamedResult["events"];
}

/** A fake Codex client: yields the given ThreadEvents, honors abort signal,
 *  and records the options passed to startThread. */
function fakeCodex(events: unknown[]): {
  factory: (options?: CodexOptions) => CodexClient;
  startOptions: () => ThreadOptions | undefined;
  resumeOptions: () => ThreadOptions | undefined;
  factoryOptions: () => CodexOptions | undefined;
} {
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
      simulated: false,
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
    let factoryOpts: { env?: Record<string, string> } | undefined;
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
    const factory = (opts?: unknown) => {
      factoryOpts = opts as { env?: Record<string, string> } | undefined;
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
          events: asSdkEvents(
            (async function* () {
              throw new Error("request failed with sk-secret-sentinel");
            })(),
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
    expect(lines.at(-1)?.display).toMatchObject({
      ev: "err",
      text: "Codex execution failed. Review its authentication and runtime configuration.",
    });
    expect(lines.at(-1)?.raw).not.toContain("sk-secret-sentinel");
  });

  it("retains a safe auth category while redacting the raw SDK failure", async () => {
    const thread: CodexThread = {
      id: "thread-1",
      async runStreamed() {
        return {
          events: asSdkEvents(
            (async function* () {
              throw new Error("401 unauthorized for token sk-secret-sentinel");
            })(),
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

    expect(lines.at(-1)?.display).toMatchObject({
      ev: "err",
      text: "Codex authentication failed. Review the configured subscription credential.",
    });
    expect(lines.at(-1)?.raw).not.toContain("sk-secret-sentinel");
  });

  it("retains a safe quota category while redacting the raw SDK failure", async () => {
    const thread: CodexThread = {
      id: "thread-1",
      async runStreamed() {
        return {
          events: asSdkEvents(
            (async function* () {
              throw new Error("429 rate limit: internal request id secret-sentinel");
            })(),
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

    expect(lines.at(-1)?.display).toMatchObject({
      ev: "err",
      text: "Codex usage limit was reached. Retry after the subscription limit resets.",
    });
    expect(lines.at(-1)?.raw).not.toContain("secret-sentinel");
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
    handle.interrupt("u1", "arda");
    await drain();
    expect(exit).toMatchObject({ outcome: "interrupted" });
  });

  it("idle-timeout settles error (not interrupted) on a hung stream (A8)", async () => {
    process.env.VIBERR_CODEX_IDLE_TIMEOUT_MS = "20"; // 20ms idle window
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
    }
  });
});
