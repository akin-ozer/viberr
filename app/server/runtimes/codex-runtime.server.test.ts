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
  resolveCodexReasoningEffort,
  type CodexClient,
  type CodexThread,
} from "./codex-runtime.server";
import { createTestDbContext } from "../../../test-support/test-db";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ensureUserBackendHome } from "./user-homes.server";
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

describe("resolveCodexReasoningEffort", () => {
  it("accepts only values supported by the installed SDK that Viberr offers", () => {
    expect(resolveCodexReasoningEffort("minimal")).toBe("minimal");
    expect(resolveCodexReasoningEffort("xhigh")).toBe("xhigh");
    // SDK 0.153.4: `max` joined the union and the bundled catalog lists it on
    // every current model, so it is forwarded.
    expect(resolveCodexReasoningEffort("max")).toBe("max");
    // In the union too, deliberately NOT forwarded: `ultra` is automatic task
    // delegation (sub-agents, the operator's job); `persistent` is supported by
    // no bundled model. Canary: add either case to the switch.
    expect(resolveCodexReasoningEffort("ultra")).toBeUndefined();
    expect(resolveCodexReasoningEffort("persistent")).toBeUndefined();
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

    // `max` is a tier the pinned SDK accepts and the catalog offers (0.153.4).
    const max = fakeCodex(events);
    createCodexAdapter({ codexFactory: max.factory }).start(
      { ...SPEC, effort: "max" },
      { onLine: () => {}, onExit: () => {} },
    );
    await drain();
    expect(max.startOptions()?.modelReasoningEffort).toBe("max");

    // A tier Viberr does not forward (`ultra`: automatic delegation) is omitted,
    // so the CLI applies its own default instead of running a mode the
    // deployment never chose.
    const unsupported = fakeCodex(events);
    createCodexAdapter({ codexFactory: unsupported.factory }).start(
      { ...SPEC, effort: "ultra" },
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
    const opOpts = operator.startOptions()!;
    expect(opOpts).toMatchObject({
      // Ruling 185: no kind is OS-confined any more, the operator included —
      // it holds no shell tool at all, so its confinement was never the thing
      // that bound it. Its OS network is no longer forced off either.
      sandboxMode: "danger-full-access",
      approvalPolicy: "never",
    });
    expect(opOpts.networkAccessEnabled).toBeUndefined();
    // B-2 (pass 24, owner ruling): web SEARCH now follows the grant on the
    // operator exactly as on a specialist. This SPEC does not withhold it, so web
    // search is ENABLED (option unset) — the operator honors `use-web-search-fetch`
    // on Codex, matching Claude. (The unconditional `webSearchMode:"disabled"`
    // here used to dishonour a granted operator while the matrix showed it green.)
    expect(opOpts.webSearchMode).toBeUndefined();

    // …and an operator whose web grant IS withheld disables web search, like a
    // specialist — the OS-sandbox network stays off either way.
    const opWithheld = fakeCodex(events);
    createCodexAdapter({ codexFactory: opWithheld.factory }).start(
      { ...SPEC, kind: "operator", webSearchWithheld: true },
      { onLine: () => {}, onExit: () => {} },
    );
    await drain();
    const opWithheldOpts = opWithheld.startOptions()!;
    expect(opWithheldOpts.webSearchMode).toBe("disabled");
    expect(opWithheldOpts.networkAccessEnabled).toBeUndefined();

    // A supporting run is not confined for its role's name either (R22's core,
    // now the whole rule — ruling 185).
    const reviewer = fakeCodex(events);
    createCodexAdapter({ codexFactory: reviewer.factory }).start(
      { ...SPEC, kind: "reviewer" },
      { onLine: () => {}, onExit: () => {} },
    );
    await drain();
    const revOpts = reviewer.startOptions()!;
    expect(revOpts.sandboxMode).toBe("danger-full-access");
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
    expect(withheldOpts.networkAccessEnabled).toBeUndefined();
    // Ruling 185: the run is not confined, so `webSearchMode` — the CLI's own
    // tool switch — is the whole of what withheld egress binds on Codex. The
    // OS-level network gate is gone with the sandbox, and the capability
    // surfaces say what each half enforces.
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

  it("every kind, every grant shape, reaches the SDK as `danger-full-access` with no extra dirs", async () => {
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
      {
        label: "evidence-granted, write-withheld",
        spec: { kind: "reviewer", autonomous: true, repoWriteWithheld: true, attachmentsWritableDir: DIR },
      },
    ] as const;
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
    }
  });

  it("the operator's OS network is no longer forced off, and withheld web search still binds", async () => {
    // `networkAccessEnabled` only ever bound below full access; keeping it
    // would be a setting that reads as enforcement and is not one. Web SEARCH
    // is the CLI's own tool and still follows the grant on BOTH kinds.
    // Canary: set `networkAccessEnabled = false` for the operator again and the
    // first assertion fails; drop the `webSearchWithheld` arm and the last does.
    const op = fakeCodex([{ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }]);
    createCodexAdapter({ codexFactory: op.factory }).start(
      { ...SPEC, kind: "operator", autonomous: true },
      { onLine: () => {}, onExit: () => {} },
    );
    await drain();
    expect(op.startOptions()?.networkAccessEnabled).toBeUndefined();
    expect(op.startOptions()?.webSearchMode).toBeUndefined();

    const withheld = fakeCodex([{ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }]);
    createCodexAdapter({ codexFactory: withheld.factory }).start(
      { ...SPEC, kind: "operator", autonomous: true, webSearchWithheld: true },
      { onLine: () => {}, onExit: () => {} },
    );
    await drain();
    expect(withheld.startOptions()?.webSearchMode).toBe("disabled");
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

  it("resumes the thread in the shared home with the model and the summarizer prompt, then starts the compaction", async () => {
    const server = scripted((method, id, write) => {
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
      { ...SPEC, model: "gpt-5.6-terra", env: { CODEX_HOME: "/homes/arda/codex", VIBERR_RUN_ID: "run_1" } },
      "thread-1",
      { onLine: (l) => lines.push(l), onPhase: (phase) => phases.push(phase ?? "") },
    );
    expect(outcome).toEqual({ compacted: true, preTokens: null, postTokens: null });
    expect(phases[0]).toBe(RUN_PHASE.compacting);
    // The run's credential overlay and home, under the epilogue's OWN marker
    // (the run's settle sweep reaps `r1`; this process must outlive it).
    expect(server.spawned[0]).toMatchObject({
      args: ["app-server"],
      env: { PATH: "/usr/bin", CODEX_HOME: "/homes/arda/codex", VIBERR_RUN_ID: `${SPEC.runId}:compaction` },
    });
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
    const outcome = await adapter.compact!({ ...SPEC, env: { CODEX_HOME: "/h" } }, "gone", { onLine: (l) => lines.push(l) });
    expect(outcome).toEqual({ compacted: false, reason: "thread/resume refused: thread not found" });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.display?.tag).toBe("run·compaction·failed");
    expect(lines[0]!.display?.text).toContain("thread not found");
  });
});

