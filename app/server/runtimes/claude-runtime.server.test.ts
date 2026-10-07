import { EventEmitter } from "node:events";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createTempDirs } from "../../../test-support/temp-dirs";
import { resetEnvCacheForTests } from "../config/env.server";
import {
  RUN_PHASE,
  type EmittedLine,
  type RunExit,
  type RunSpec,
  type RunSteering,
} from "./adapter.server";
import {
  AUTO_MEMORY_OFF_ENV,
  createClaudeAdapter,
  resetSessionTotalsForTests,
  INTERRUPT_ABORT_GRACE_MS,
  INTERRUPT_GRACE_MS,
  resolveClaudeModel,
  type ClaudePreToolUseHook,
  type ClaudeQuery,
  type ClaudeQueryFn,
  type ClaudeQueryOptions,
} from "./claude-runtime.server";
import type { ReapTargets } from "./run-processes.server";
import { claudeReportedTotals } from "./wire-format.server";
import type { SDKControlGetUsageResponse } from "@anthropic-ai/claude-agent-sdk";
import { filteredSpawnEnv } from "./runtime-registry.server";
import { resolveSpecialistDisallowedTools } from "~/server/tasks/specialist-tool-policy";
import type { JsonValue } from "~/features/runtime/runtime-types";

const temp = createTempDirs();
afterEach(temp.cleanup);

describe("resolveClaudeModel", () => {
  it("maps friendly family labels to CLI aliases", () => {
    expect(resolveClaudeModel("claude-sonnet")).toBe("sonnet");
    expect(resolveClaudeModel("claude-opus")).toBe("opus");
    expect(resolveClaudeModel("claude-haiku")).toBe("haiku");
  });
  it("passes real dated ids through unchanged", () => {
    expect(resolveClaudeModel("claude-sonnet-4-5")).toBe("claude-sonnet-4-5");
  });
  it("returns undefined for unknown/empty so the SDK uses its default", () => {
    expect(resolveClaudeModel("")).toBeUndefined();
    expect(resolveClaudeModel(undefined)).toBeUndefined();
    expect(resolveClaudeModel("codex-large")).toBeUndefined();
  });

  it("pass 34 (F34-7): a bracketed context-window variant is split off first and re-appended verbatim", () => {
    // Live: the JC-2 operator's run row said `opus[1m]` and the SDK got `opus`.
    // Canary: put `if (m.includes("opus")) return "opus"` ahead of the split.
    expect(resolveClaudeModel("opus[1m]")).toBe("opus[1m]");
    expect(resolveClaudeModel("claude-opus[1m]")).toBe("opus[1m]");
    expect(resolveClaudeModel("claude-sonnet-4-5[1m]")).toBe("claude-sonnet-4-5[1m]");
    expect(resolveClaudeModel("sonnet")).toBe("sonnet");
    expect(resolveClaudeModel("codex-large[1m]")).toBeUndefined();
  });
});

/** A fake Query: yields the given messages, records interrupt() calls.
 *  `rejectWith` fails the stream on its first pull, before any message — what
 *  the SDK does when the request itself never gets off the ground. */
function fakeQuery(
  messages: unknown[],
  opts: {
    throwAfter?: number;
    rejectWith?: Error;
    /** Ruling 611: the SDK's experimental `/usage` control request. */
    usage?: (opts?: { skipBehaviors?: boolean }) => Promise<SDKControlGetUsageResponse>;
  } = {},
) {
  let interrupted = false;
  const gen = (async function* () {
    if (opts.rejectWith) throw opts.rejectWith;
    let i = 0;
    for (const m of messages) {
      if (interrupted) return;
      if (opts.throwAfter !== undefined && i === opts.throwAfter) {
        throw new Error("stream error");
      }
      yield m;
      i += 1;
    }
  })();
  const q: ClaudeQuery = Object.assign(gen, {
    interrupt: async () => {
      interrupted = true;
    },
  });
  if (opts.usage) q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET = opts.usage;
  return { q, wasInterrupted: () => interrupted };
}

/** The subset of SDK options these tests inspect. */
interface CapturedOptions {
  settingSources?: string[];
  skills?: string[];
  plugins?: unknown[];
  strictMcpConfig?: boolean;
  disallowedTools?: string[];
  /** The system prompt as the adapter handed it over (preset+append for a
   *  specialist) — read through a zod parse where a test needs its text. */
  systemPrompt?: unknown;
  /** The model id as forwarded to the SDK. */
  model?: string;
  effort?: string;
  env?: Record<string, string>;
}

/**
 * A run's skill plugin as `mountGrantedSkills` builds it beside the checkout
 * (ruling 180): the manifest the CLI reads plus one folder per granted skill.
 */
function pluginDir(skills: string[]): string {
  const dir = temp.make("viberr-claude-plugin-");
  mkdirSync(path.join(dir, ".claude-plugin"), { recursive: true });
  writeFileSync(
    path.join(dir, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "viberr", description: "test", version: "1.0.0" }),
  );
  for (const name of skills) {
    mkdirSync(path.join(dir, "skills", name), { recursive: true });
    writeFileSync(
      path.join(dir, "skills", name, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${name}\n---\n\nbody\n`,
    );
  }
  return dir;
}

const SPEC: RunSpec = {
  runId: "r1",
  projectSlug: "viberr-core",
  taskKey: "VIB-1",
  threadId: "primary",
  kind: "primary",
  backend: "claude",
  model: "claude-sonnet-4-5",
  prompt: "do the thing",
  workdir: "/tmp/x",
  autonomous: true,
};

async function drain(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

describe("claude adapter (SDK, injected fake query)", () => {
  it("streams every SDK message → EmittedLine and finishes on a success result", async () => {
    const messages = [
      { type: "system", subtype: "init", session_id: "sess-1", model: "claude-sonnet-4-5", tools: ["Bash"], mcp_servers: [] },
      { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } },
      { type: "result", subtype: "success", is_error: false, num_turns: 2, usage: { input_tokens: 10, output_tokens: 3 }, total_cost_usd: 0.05 },
    ];
    const { q } = fakeQuery(messages);
    const adapter = createClaudeAdapter({ queryFn: () => q });
    const lines: EmittedLine[] = [];
    let exit: RunExit | null = null;
    adapter.start(SPEC, { onLine: (l) => lines.push(l), onExit: (e) => (exit = e) });
    await drain();

    expect(lines).toHaveLength(3);
    // raw_json is the exact stringified SDK message.
    expect(JSON.parse(lines[0]!.raw).type).toBe("system");
    expect(lines[0]!.facts.sessionId).toBe("sess-1");
    expect(exit).toMatchObject({ outcome: "finished", effectiveBackend: "claude", sessionId: "sess-1" });
  });

  /**
   * The live fold, on the stream's real shape (taken from a stored run): the SDK
   * yields one `assistant` envelope per content block, every block of one API
   * message repeating that message's `message_start` usage under the same
   * `message.id`; the prompt figures are final for the call and `output_tokens`
   * is a placeholder of a few tokens. The fold used to count every envelope as
   * a turn, max the uncached input slice (two tokens per call) and sum the
   * placeholders, so the live strip read a few hundred tokens while the run was
   * at a few million, and Turns over-counted on every multi-turn run.
   */
  it("live usage sums each API message's whole prompt once, and turns follow the SDK's counter", async () => {
    const usage = (cc: number, cr: number, out: number) => ({
      input_tokens: 2,
      cache_creation_input_tokens: cc,
      cache_read_input_tokens: cr,
      output_tokens: out,
    });
    const messages = [
      { type: "system", subtype: "init", session_id: "s", model: "claude-sonnet-4-5", tools: [], mcp_servers: [] },
      // One API message, two content blocks: identical usage, same id.
      { type: "assistant", message: { id: "msg_1", content: [{ type: "thinking", thinking: "…" }], usage: usage(2796, 10300, 8) } },
      { type: "assistant", message: { id: "msg_1", content: [{ type: "tool_use", name: "Bash", input: {} }], usage: usage(2796, 10300, 8) } },
      { type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } },
      { type: "assistant", message: { id: "msg_2", content: [{ type: "tool_use", name: "Read", input: {} }], usage: usage(861, 13096, 25) } },
      { type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } },
      // A user message the SDK injected (a skill body): the SDK counts it too.
      { type: "user", message: { content: [{ type: "text", text: "Base directory for this skill: …" }] } },
      // A subagent's message: outside the result's `usage`, so outside the fold.
      { type: "assistant", parent_tool_use_id: "toolu_sub", message: { id: "msg_sub", content: [{ type: "text", text: "sub" }], usage: usage(0, 5000, 4) } },
      { type: "assistant", message: { id: "msg_3", content: [{ type: "text", text: "done" }], usage: usage(4438, 13957, 3) } },
      { type: "result", subtype: "success", is_error: false, num_turns: 4, duration_ms: 12000, usage: { input_tokens: 6, cache_creation_input_tokens: 8095, cache_read_input_tokens: 37353, output_tokens: 900 }, total_cost_usd: 0.05 },
    ];
    const { q } = fakeQuery(messages);
    const adapter = createClaudeAdapter({ queryFn: () => q });
    const lines: EmittedLine[] = [];
    adapter.start(SPEC, { onLine: (l) => lines.push(l), onExit: () => {} });
    await drain();

    expect(lines[0]!.facts.usage).toBeUndefined();
    // msg_1: its whole prompt (2 + 2796 + 10300), cache reads as the subset;
    // the SDK's counter starts at one. Output is the ESTIMATE from the block
    // (F35-1): one thinking character rounds up to one token, and the
    // placeholder 8 is nowhere in the facts.
    expect(lines[1]!.facts.usage).toEqual({ input_tokens: 13098, cached_input_tokens: 10300, output_tokens: 1, outputEstimated: true });
    expect(lines[1]!.facts.turns).toBe(1);
    // The second block of the SAME message adds its own output (the `{}` tool
    // input, one token) and nothing on the prompt side. Canary: drop the
    // `seenMessages` dedupe and the prompt doubles.
    expect(lines[2]!.facts.usage).toEqual({ input_tokens: 13098, cached_input_tokens: 10300, output_tokens: 2, outputEstimated: true });
    // A tool result is one more turn, on the user line itself.
    expect(lines[3]!.facts.turns).toBe(2);
    // msg_2 adds its own whole prompt: 13098 + (2 + 861 + 13096).
    expect(lines[4]!.facts.usage).toEqual({ input_tokens: 27057, cached_input_tokens: 23396, output_tokens: 3, outputEstimated: true });
    expect(lines[4]!.facts.turns).toBe(2);
    expect(lines[5]!.facts.turns).toBe(3);
    expect(lines[6]!.facts.turns).toBe(4);
    // The subagent envelope carries no usage facts and moves nothing.
    expect(lines[7]!.facts.usage).toBeUndefined();
    // msg_3: 27057 + (2 + 4438 + 13957) — and the live prompt figures now EQUAL
    // the result's (6 + 8095 + 37353), so the sink's max fold has nothing to
    // correct on the input side; "done" is one more estimated token.
    expect(lines[8]!.facts.usage).toEqual({ input_tokens: 45454, cached_input_tokens: 37353, output_tokens: 4, outputEstimated: true });
    expect(lines[8]!.facts.turns).toBe(4);
    // Result: the SDK's totals in the same terms, untouched by the accumulator,
    // and marked as the provider's figure.
    expect(lines[9]!.facts.usage).toEqual({ input_tokens: 45454, cached_input_tokens: 37353, output_tokens: 900, outputEstimated: false });
    expect(lines[9]!.facts.turns).toBe(4);
  });

  /**
   * F35-1 (pass 35): the live output figure. The SDK's per-envelope
   * `usage.output_tokens` is the `message_start` placeholder (1 to 3 per API
   * message), and summing it read "49 tokens" for twelve minutes of Opus
   * writing ~20k characters of files, then jumped to 54,759 at the result. The
   * fold now estimates output from the streamed content (text, thinking and
   * tool-call input at ~4 characters per token) and marks the figure as an
   * estimate; the result's total lands unmarked and replaces it in the sink.
   */
  it("F35-1: live output is estimated from the streamed text, and the result's figure is exact", async () => {
    const text = "x".repeat(2000);
    const messages = [
      { type: "system", subtype: "init", session_id: "s", model: "claude-opus-4-1", tools: [], mcp_servers: [] },
      {
        type: "assistant",
        message: {
          id: "msg_1",
          content: [{ type: "text", text }],
          usage: { input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: 0, output_tokens: 2 },
        },
      },
      // A tool call's arguments are output too: 1200 characters of file body.
      {
        type: "assistant",
        message: {
          id: "msg_2",
          content: [{ type: "tool_use", name: "Write", input: { file_path: "/w/a.md", content: "y".repeat(1200) } }],
          usage: { input_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 100, output_tokens: 3 },
        },
      },
      { type: "result", subtype: "success", is_error: false, num_turns: 1, duration_ms: 1000, usage: { input_tokens: 4, cache_creation_input_tokens: 100, cache_read_input_tokens: 100, output_tokens: 900 }, total_cost_usd: 0.01 },
    ];
    const { q } = fakeQuery(messages);
    const adapter = createClaudeAdapter({ queryFn: () => q });
    const lines: EmittedLine[] = [];
    adapter.start(SPEC, { onLine: (l) => lines.push(l), onExit: () => {} });
    await drain();

    // 2000 characters of prose: at least 500 tokens, marked as an estimate.
    // Canary: restore `liveOut += u.output_tokens` and this reads 2.
    const first = lines[1]!.facts.usage!;
    expect(first.output_tokens).toBeGreaterThanOrEqual(500);
    expect(first.outputEstimated).toBe(true);
    // The tool call's JSON (over 1200 characters) grows the estimate by 300+.
    const second = lines[2]!.facts.usage!;
    expect(second.output_tokens).toBeGreaterThanOrEqual(first.output_tokens + 300);
    expect(second.outputEstimated).toBe(true);
    // The result: exactly the provider's figure, not an estimate.
    expect(lines[3]!.facts.usage).toEqual({ input_tokens: 204, cached_input_tokens: 100, output_tokens: 900, outputEstimated: false });
  });

  it("a turn-capped run emits a classified run·error·max_turns reason line (cut off ≠ failed)", async () => {
    const { q } = fakeQuery([
      { type: "result", subtype: "error_max_turns", is_error: true, num_turns: 51, usage: {} },
    ]);
    const adapter = createClaudeAdapter({ queryFn: () => q });
    const lines: EmittedLine[] = [];
    let exit: RunExit | null = null;
    adapter.start(SPEC, { onLine: (l) => lines.push(l), onExit: (e) => (exit = e) });
    await drain();
    expect(exit).toMatchObject({ outcome: "error" });
    const reason = lines.find((l) => l.display?.tag === "run·error·max_turns");
    expect(reason).toBeTruthy();
    const display = reason!.display!;
    expect(display.ev).toBe("err");
    expect(display.text).toContain("turn cap");
    expect(display.text).toContain("VIBERR_CLAUDE_MAX_TURNS");
    // Its OWN copy, not the generic classifier's as well.
    expect(lines.some((l) => l.display?.tag === "run·error·unknown")).toBe(false);
  });

  // P14-RT-10: an `is_error` RESULT (anything but the max-turns subtype) used to
  // settle `error` carrying no classified line at all — the result line's own
  // tag is `result`, which `runFailureReason` never matches — so a quota failure
  // delivered this way lost its `retry_other_backend` recovery option and got
  // the generic "run ended in an error" copy. Thrown stream errors never had
  // that problem, which is exactly the asymmetry.
  it("classifies an is_error RESULT the same way a thrown stream error is classified", async () => {
    const { q } = fakeQuery([
      {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        num_turns: 3,
        usage: {},
        result:
          "Claude AI usage limit reached|1750000000 sk-secretsentinel0123456789",
      },
    ]);
    const adapter = createClaudeAdapter({ queryFn: () => q });
    const lines: EmittedLine[] = [];
    let exit: RunExit | null = null;
    adapter.start(SPEC, { onLine: (l) => lines.push(l), onExit: (e) => (exit = e) });
    await drain();

    expect(exit).toMatchObject({ outcome: "error" });
    const reason = lines.find((l) => l.display?.tag === "run·error·quota");
    expect(reason).toBeTruthy();
    expect(reason!.display!.ev).toBe("err");
    // R20-3 (F20-4): the canonical sentence leads, and the provider's OWN words
    // now ride behind the marker — with a token-shaped secret redacted by shape.
    expect(reason!.display!.text).toContain("usage quota");
    expect(reason!.display!.text).toContain("The provider reported:");
    expect(reason!.display!.text).toContain("Claude AI usage limit reached");
    expect(reason!.display!.text).not.toContain("sk-secretsentinel0123456789");
  });

  it("an is_error result with no recognizable cause still lands a tagged line", async () => {
    const { q } = fakeQuery([
      { type: "result", subtype: "error_during_execution", is_error: true, num_turns: 1, usage: {} },
    ]);
    const adapter = createClaudeAdapter({ queryFn: () => q });
    const lines: EmittedLine[] = [];
    adapter.start(SPEC, { onLine: (l) => lines.push(l), onExit: () => {} });
    await drain();
    expect(lines.some((l) => l.display?.tag === "run·error·unknown")).toBe(true);
  });

  it("classifies a swept transcript as run·error·session_missing, not auth (P13-D-2)", async () => {
    // What `claude --resume <id>` prints once the provider has swept the
    // transcript (~30-day retention) — the exact string the export installer
    // warns about. BEFORE it hit no regex and landed as `unknown`, which the
    // escalation narrates as "review the runtime configuration".
    const { q } = fakeQuery([], {
      rejectWith: new Error(
        "No conversation found with session ID 8a1f-dead-beef",
      ),
    });
    const lines: EmittedLine[] = [];
    let exit: RunExit | null = null;
    createClaudeAdapter({ queryFn: () => q }).start(
      { ...SPEC, resumeSessionId: "8a1f-dead-beef" },
      { onLine: (l) => lines.push(l), onExit: (e) => (exit = e) },
    );
    await drain();
    expect(exit).toMatchObject({ outcome: "error" });
    const reason = lines.find(
      (l) => l.display?.tag === "run·error·session_missing",
    );
    expect(reason).toBeTruthy();
    expect(reason!.display!.text).toContain("transcript no longer exists");
    expect(reason!.display!.text).not.toMatch(/credential was rejected/i);
    // Redaction invariant: the raw error text never reaches the console.
    expect(reason!.display!.text).not.toContain("8a1f-dead-beef");
  });

  it("errors when the stream ends with no result envelope (aborted)", async () => {
    const { q } = fakeQuery([{ type: "assistant", message: { content: [{ type: "text", text: "partial" }] } }]);
    const adapter = createClaudeAdapter({ queryFn: () => q });
    let exit: RunExit | null = null;
    adapter.start(SPEC, { onLine: () => {}, onExit: (e) => (exit = e) });
    await drain();
    expect(exit).toMatchObject({ outcome: "error" });
  });

  it("a spawn-time crash emits a redaction-safe 'could not start' err line (A3)", async () => {
    // The queryFn itself throws with an fd-exhaustion code — the exact
    // spawn-EBADF class that killed runs silently before A3.
    const boom = () => {
      throw Object.assign(new Error("spawn EBADF"), { code: "EBADF" });
    };
    const adapter = createClaudeAdapter({ queryFn: boom });
    const lines: EmittedLine[] = [];
    let exit: RunExit | null = null;
    adapter.start(SPEC, { onLine: (l) => lines.push(l), onExit: (e) => (exit = e) });
    await drain();
    expect(exit).toMatchObject({ outcome: "error" });
    const errLine = lines.find((l) => l.display?.ev === "err");
    expect(errLine?.display?.text).toContain("could not be started");
    // The raw error text (which can echo argv/creds) is NEVER surfaced.
    expect(errLine?.display?.text).not.toContain("EBADF");
  });

  it("classifies a quota failure into a redaction-safe reason line (A3)", async () => {
    const boom = () => {
      throw new Error("429 usage limit reached for this org");
    };
    const adapter = createClaudeAdapter({ queryFn: boom });
    const lines: EmittedLine[] = [];
    adapter.start(SPEC, { onLine: (l) => lines.push(l), onExit: () => {} });
    await drain();
    const errLine = lines.find((l) => l.display?.ev === "err");
    expect(errLine?.display?.text).toContain("usage quota");
  });

  /** Capture the options one run was started with. */
  async function optionsFor(spec: RunSpec): Promise<CapturedOptions> {
    const result = [{ type: "result", subtype: "success", is_error: false, num_turns: 1, usage: {} }];
    let captured: CapturedOptions | undefined;
    const queryFn: ClaudeQueryFn = (params) => {
      captured = params.options;
      const { q } = fakeQuery(result);
      return q;
    };
    createClaudeAdapter({ queryFn }).start(spec, {
      onLine: () => {},
      onExit: () => {},
    });
    await drain();
    return captured ?? {};
  }

  // P13-RT-08: only the tiers the Claude SDK's effort union allows are
  // forwarded; anything else is dropped so the SDK applies its own default.
  // "minimal" is a CODEX tier. A profile created on Codex and later switched
  // to Claude keeps its stored effort (the modal only refetches the catalog on
  // backend change), so this value really does reach the adapter. Canary:
  // forward `spec.effort` unresolved and the "minimal" row fails.
  it.each([
    ["low", "low"],
    ["max", "max"],
    ["xhigh", "xhigh"],
    ["minimal", undefined],
    ["", undefined],
    [undefined, undefined],
  ] as const)("effort %j reaches options.effort as %j", async (effort, expected) => {
    expect((await optionsFor(effort === undefined ? SPEC : { ...SPEC, effort })).effort).toBe(expected);
  });

  it("pass 34 (F34-7): the context-window variant reaches the SDK options verbatim", async () => {
    // Canary: the same resolver edit as above; the run would start on `opus`.
    // The spec names the family label, so an adapter that forwarded
    // `spec.model` unresolved would start it on `claude-opus[1m]`.
    const captured = await optionsFor({ ...SPEC, model: "claude-opus[1m]" });
    expect(captured.model).toBe("opus[1m]");
  });

  it("isolates a run with NO granted skills from the host ~/.claude (settingSources + skills empty, strict MCP)", async () => {
    const captured = await optionsFor(SPEC);
    // Empty settingSources = no host settings tiers AND no project source at
    // all; empty skills = the model sees NONE of the operator-user's personal
    // Claude Code skills, and none of the ~16 the SDK compiles into its binary.
    expect(captured.settingSources).toEqual([]);
    expect(captured.skills).toEqual([]);
    expect(captured.plugins).toEqual([]);
    // …so the `Skill` tool stays denied — the only fence left when we list no
    // skills of our own (the bundled set loads regardless: docker-verified).
    expect(captured.disallowedTools).toContain("Skill");
    // R18-3: only Viberr-granted MCP servers reach a run (ignore ambient MCP).
    expect(captured.strictMcpConfig).toBe(true);
  });

  it("ruling 180: a run whose skills Viberr mounted as a plugin gets `plugins` + `plugin:`-qualified skill names, and NO settings source", async () => {
    // F36-9 (pass 36): the skills used to ride `<cwd>/.claude/skills` behind
    // `settingSources: ['project']`, which put Viberr files inside the tree the
    // project's own tools scan. They now ride a local plugin OUTSIDE cwd —
    // canaried inside the image 2026-09-11: the CLI lists `viberr:<name>` and
    // the model invokes it. Three things move together, or the skills are
    // listed and uninvokable: the plugin, the qualified filter, and the
    // `Skill` deny lifting.
    // Canary: drop any one of `plugins`, the `${name}:` prefix, or the Skill
    // filter on BASE_DENIED_BUILTINS and one assertion below fails.
    const plugin = pluginDir(["conventional-commits", "terraform-review"]);
    const captured = await optionsFor({
      ...SPEC,
      skills: ["conventional-commits", "terraform-review"],
      skillPlugin: { path: plugin, name: "viberr" },
    });

    expect(captured.plugins).toEqual([{ type: "local", path: plugin, skipMcpDiscovery: true }]);
    expect(captured.skills).toEqual(["viberr:conventional-commits", "viberr:terraform-review"]);
    // No project source, ever: cwd's `.claude` and CLAUDE.md stay unread.
    expect(captured.settingSources).toEqual([]);
    expect(captured.disallowedTools).not.toContain("Skill");
    expect(captured.strictMcpConfig).toBe(true);
  });

  it("ruling 180: a plugin that went missing before the start enables NO skill and corrects the persona", async () => {
    // The plugin is built beside the checkout moments before the spawn, and
    // that neighbourhood is writable by any live run's agent. A spec whose
    // plugin is gone must not hand the SDK a `--plugin-dir` that resolves to
    // nothing while the persona announces skills the model cannot invoke: the
    // run keeps the fully isolated shape and the persona is corrected.
    //
    // Canary: drop the `skillPluginInPlace` gate from `nativeSkillsOutcome`
    // and `plugins` names the dead directory with its skills listed.
    const gone = path.join(temp.make("viberr-claude-gone-"), "run_x");

    const captured = await optionsFor({
      ...SPEC,
      skills: ["conventional-commits"],
      skillPlugin: { path: gone, name: "viberr" },
      systemPrompt: "You are the Developer. Attached skills: conventional-commits.",
    });

    expect(captured.settingSources).toEqual([]);
    expect(captured.skills).toEqual([]);
    expect(captured.plugins).toEqual([]);
    // …and the fence that replaces the `skills` filter comes back with it: a
    // run listing no skill of its own must not keep the `Skill` tool, or the
    // SDK's ~16 bundled skills are invokable.
    expect(captured.disallowedTools).toContain("Skill");
    // C02-R7 (pass 32): the persona was written on the mount's word, so the
    // adapter corrects it in the same prompt — the agent is told which named
    // skills are NOT available instead of invoking a name that never loads.
    // Canary: drop the `droppedSkillsNotice` append.
    const persona = z.object({ append: z.string() }).parse(captured.systemPrompt).append;
    expect(persona).toContain("could NOT be enabled");
    expect(persona).toContain("conventional-commits");
  });

  it("never lets a skill name the SDK would throw on reach query()", async () => {
    // The TS SDK throws BEFORE STARTING on a name that cannot be an exact skill
    // name. The mount already filters, so this is the adapter-boundary belt:
    // no caller can turn a bad store folder name into a dead run.
    //
    // Canary: drop the `nativeSkillNames` call and the first expectation gets
    // the raw list back, wildcard included.
    const plugin = pluginDir(["good-skill"]);
    const mixed = await optionsFor({
      ...SPEC,
      skills: ["good-skill", "my skill (v2)", "*", "good-skill"],
      skillPlugin: { path: plugin, name: "viberr" },
    });
    expect(mixed.skills).toEqual(["viberr:good-skill"]);
    expect(mixed.plugins).toEqual([{ type: "local", path: plugin, skipMcpDiscovery: true }]);

    // ALL unsafe ⇒ nothing to enable ⇒ the run falls back to the fully isolated
    // shape rather than loading a plugin for zero skills.
    const none = await optionsFor({
      ...SPEC,
      skills: ["a,b", ""],
      skillPlugin: { path: plugin, name: "viberr" },
    });
    expect(none.skills).toEqual([]);
    expect(none.plugins).toEqual([]);
    expect(none.settingSources).toEqual([]);
    expect(none.disallowedTools).toContain("Skill");
  });

  it("denies the SDK bundled parity/governance tools on every run (keeps ToolSearch + coding tools), plus repo-mutation for operators", async () => {
    const result = [{ type: "result", subtype: "success", is_error: false, num_turns: 1, usage: {} }];
    // Capture each run's options by index (no reassignment → clean typing).
    const seen: ({ disallowedTools?: string[] } | undefined)[] = [];
    const queryFn: ClaudeQueryFn = (params) => {
      seen.push(params.options);
      const { q } = fakeQuery(result);
      return q;
    };
    const run = async (spec: RunSpec) => {
      createClaudeAdapter({ queryFn }).start(spec, { onLine: () => {}, onExit: () => {} });
      await drain();
      return seen[seen.length - 1];
    };

    // EVERY run denies the SDK-bundled tools that break Codex/Claude parity or
    // bypass viberr governance (docker-verified they load despite skills:[]):
    // Task (subagents), Workflow, Cron*, ScheduleWakeup, RemoteTrigger,
    // Monitor, Push/SendMessage, DesignSync, Enter/ExitWorktree — plus `Skill`
    // for every run that mounts no granted skill of its own (a run that DOES
    // trades the deny for the `skills` context filter; see the native-skills
    // test above). These specs carry no `skills`, so `Skill` is denied here.
    const primaryDenied = (await run({ ...SPEC, kind: "primary" }))?.disallowedTools ?? [];
    expect(primaryDenied).toEqual(
      expect.arrayContaining([
        "Skill",
        // The whole subagent-spawn family — sync `Task` AND the async
        // `TaskCreate`/`TaskGet`/… variants (both leak past the SDK in the
        // production docker init; either can spawn an unrestricted subagent).
        "Task",
        "TaskCreate",
        "TaskGet",
        "TaskList",
        "TaskOutput",
        "TaskStop",
        "TaskUpdate",
        "Workflow",
        "CronCreate",
        "ScheduleWakeup",
        "Monitor",
        "PushNotification",
        "EnterWorktree",
      ]),
    );
    // But NOT ToolSearch (the operator loads its deferred mcp__viberr__* tools
    // through it), and NOT the coding/web toolset — specialists do real work.
    expect(primaryDenied).not.toContain("ToolSearch");
    expect(primaryDenied).not.toContain("Bash");
    expect(primaryDenied).not.toContain("WebFetch");

    // Operator ADDS the repo-mutation built-ins on top of the base list, but must
    // keep ToolSearch (it can't reach its mcp__viberr__* governance tools without it).
    const opDenied = (await run({ ...SPEC, kind: "operator" }))?.disallowedTools ?? [];
    expect(opDenied).toEqual(
      expect.arrayContaining(["Skill", "Task", "Bash", "Edit", "Write", "NotebookEdit"]),
    );
    expect(opDenied).not.toContain("ToolSearch");

    // A specialist WITH withheld caps gets the base list PLUS those.
    const withheld =
      (await run({ ...SPEC, kind: "primary", disallowedTools: ["Bash(git push:*)"] }))
        ?.disallowedTools ?? [];
    expect(withheld).toContain("Bash(git push:*)");
    expect(withheld).toContain("Skill");

    // Parity ruling (2026-08-31, narrowing F10-12): a SUPPORTING run's
    // kind-based denies are the DELIVERY commands only — reaching the remote
    // belongs to the delivers:true engagement (the VIB-30 class), whatever the
    // grants say. Its LOCAL write posture is grants-derived: the spec's
    // disallowedTools carry Edit/Write/... exactly when the profile withholds
    // execute-code-or-write-repo, so a write-GRANTED supporting agent may edit
    // its own isolated checkout.
    const reviewerDenied = (await run({ ...SPEC, kind: "reviewer" }))?.disallowedTools ?? [];
    expect(reviewerDenied).toEqual(
      expect.arrayContaining([
        "Bash(git push:*)",
        "Bash(gh pr create:*)",
        "Bash(gh pr merge:*)",
      ]),
    );
    // No grant-derived denies on this spec ⇒ the local write tools stay.
    expect(reviewerDenied).not.toContain("Edit");
    expect(reviewerDenied).not.toContain("Write");
    expect(reviewerDenied).not.toContain("Bash(git commit:*)");
    // A WITHHELD supporting run gets the local-write denies from its grants
    // (the same channel every specialist run uses).
    const reviewerWithheld =
      (
        await run({
          ...SPEC,
          kind: "reviewer",
          disallowedTools: ["Edit", "MultiEdit", "Write", "NotebookEdit", "Bash(git commit:*)"],
        })
      )?.disallowedTools ?? [];
    expect(reviewerWithheld).toEqual(
      expect.arrayContaining([
        "Edit",
        "Write",
        "Bash(git commit:*)",
        "Bash(git push:*)",
        "Bash(gh pr create:*)",
      ]),
    );
    // A delivering (primary) run is NOT read-only — it must be able to write.
    expect(primaryDenied).not.toContain("Write");
    expect(primaryDenied).not.toContain("Bash(git commit:*)");
  });

  // D4/D5: `allowedTools` is the run's APPROVAL list and it has to reach the
  // SDK — an `mcp__*` tool with no entry stalls on a permission prompt no human
  // is there to answer. And there is no `tools` option: `disallowedTools` is the
  // only restriction channel, which is what the interface docstring now says.
  it("forwards the approval list, and has no `tools` restriction channel", async () => {
    const result = [{ type: "result", subtype: "success", is_error: false, num_turns: 1, usage: {} }];
    let captured: ClaudeQueryOptions | undefined;
    const queryFn: ClaudeQueryFn = (params) => {
      captured = params.options;
      const { q } = fakeQuery(result);
      return q;
    };
    createClaudeAdapter({ queryFn }).start(
      { ...SPEC, allowedTools: ["mcp__viberr_agent", "mcp__everything__echo"] },
      { onLine: () => {}, onExit: () => {} },
    );
    await drain();
    // Ruling 370: in name order, whatever order the caller listed them.
    expect(captured?.allowedTools).toEqual([
      "mcp__everything__echo",
      "mcp__viberr_agent",
    ]);
    expect(captured).not.toHaveProperty("tools");
  });

  it("interrupt() calls the SDK interrupt and ends interrupted (no result line)", async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ type: "assistant", message: { content: [{ type: "text", text: "line " + i }] } }));
    const { q, wasInterrupted } = fakeQuery(many);
    const adapter = createClaudeAdapter({ queryFn: () => q });
    let exit: RunExit | null = null;
    const handle = adapter.start(SPEC, { onLine: () => {}, onExit: (e) => (exit = e) });
    handle.interrupt();
    await drain();
    expect(wasInterrupted()).toBe(true);
    expect(exit).toMatchObject({ outcome: "interrupted" });
  });

  /**
   * `interrupt()` is a cooperative control request, and a CLI wedged mid
   * tool-call never answers it — while the same call disarms the idle guard,
   * whose own callback also returns early once `interrupted` is set. The earlier
   * fix SETTLED the run after the grace but never stopped the child, so a still
   * -live CLI could keep writing the workspace under a successor run or a
   * reclaim rmSync. The stop must ABORT the SDK subprocess: after the grace the
   * adapter aborts `options.abortController`, which tears the child down
   * (SIGTERM→SIGKILL); the ended stream then settles the run.
   */
  it("aborts the subprocess when the CLI never answers the cooperative interrupt", async () => {
    vi.useFakeTimers();
    try {
      let captured: AbortController | undefined;
      // Ignores the cooperative interrupt; ends ONLY when the abort signal
      // fires — exactly how the real SDK tears the spawned CLI down.
      const queryFn: ClaudeQueryFn = ({ options }) => {
        captured = options?.abortController;
        const gen = (async function* () {
          await new Promise<void>((_resolve, reject) => {
            captured?.signal.addEventListener("abort", () =>
              reject(new Error("Claude Code process aborted by user")),
            );
          });
          // Unreachable (the promise above only rejects); it makes this a
          // generator that yields nothing rather than a function with no yield.
          const none: never[] = [];
          yield* none;
        })();
        return Object.assign(gen, {
          interrupt: async () => new Promise<void>(() => {}),
        });
      };
      const adapter = createClaudeAdapter({ queryFn });
      let exit: RunExit | null = null;
      const handle = adapter.start(SPEC, {
        onLine: () => {},
        onExit: (e) => (exit = e),
      });

      handle.interrupt();
      expect(exit).toBeNull(); // nothing settles it on its own
      expect(captured?.signal.aborted).toBe(false); // cooperative window first

      await vi.advanceTimersByTimeAsync(INTERRUPT_GRACE_MS + 1);
      // The subprocess kill switch fired, and the ended stream settled the run.
      expect(captured?.signal.aborted).toBe(true);
      expect(exit).toMatchObject({ outcome: "interrupted" });
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * Backstop: even a child that ignores the abort (survives SIGTERM/SIGKILL,
   * or a fake that never reacts) must not leave the row `running` forever — a
   * second deadline force-settles it after the abort window.
   */
  it("force-settles if even the abort never ends the stream", async () => {
    vi.useFakeTimers();
    try {
      // Yields nothing, answers neither the cooperative interrupt nor the abort.
      const wedged: ClaudeQuery = Object.assign(
        (async function* () {
          await new Promise(() => {});
          // Unreachable (the promise never settles); see above.
          const none: never[] = [];
          yield* none;
        })(),
        { interrupt: async () => new Promise<void>(() => {}) },
      );
      const adapter = createClaudeAdapter({ queryFn: () => wedged });
      let exit: RunExit | null = null;
      const handle = adapter.start(SPEC, {
        onLine: () => {},
        onExit: (e) => (exit = e),
      });

      handle.interrupt();
      await vi.advanceTimersByTimeAsync(INTERRUPT_GRACE_MS + 1);
      expect(exit).toBeNull(); // aborted, but the stream still hasn't ended

      await vi.advanceTimersByTimeAsync(INTERRUPT_ABORT_GRACE_MS + 1);
      expect(exit).toMatchObject({ outcome: "interrupted" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("claude idle hang guard (P13-RT-11)", () => {
  /**
   * BEFORE: the Claude adapter had NO timer of any kind. `maxTurns` bounds
   * turns, not wall-clock or idle time, and a `for await` over a stalled SDK
   * stream never settles — so a hung stdio MCP or a mid-tool-call network
   * partition left the run `running` forever, the task `waiting: agent`, the
   * delivering single-flight refusing every later delivering run on that task,
   * and the board showing "agent working" until the next process restart.
   */
  it("settles a stalled stream as `error` with a classified reason line", async () => {
    process.env.VIBERR_CLAUDE_IDLE_TIMEOUT_MS = "10";
    // C3 (pass 31): the guard reads the CACHED validated env now.
    resetEnvCacheForTests();
    let interrupted = false;
    const stalled: ClaudeQuery = Object.assign(
      (async function* () {
        yield { type: "system", subtype: "init", session_id: "s-1" };
        // Never yields again; only interrupt() ends it.
        await new Promise<void>((resolve) => {
          const timer = setInterval(() => {
            if (interrupted) {
              clearInterval(timer);
              resolve();
            }
          }, 1);
        });
      })(),
      {
        interrupt: async () => {
          interrupted = true;
        },
      },
    );

    const lines: EmittedLine[] = [];
    let exit: RunExit | null = null;
    createClaudeAdapter({ queryFn: () => stalled }).start(SPEC, {
      onLine: (l) => lines.push(l),
      onExit: (e) => (exit = e),
    });
    for (let i = 0; i < 60; i++) await new Promise((r) => setTimeout(r, 2));

    expect(interrupted).toBe(true);
    expect(exit).toMatchObject({ outcome: "error", effectiveBackend: "claude" });
    // Distinct from a task failure: the copy has to say "hung", and the tag has
    // to carry a class `runFailureReason` can route on.
    expect(lines.at(-1)?.display?.tag).toBe("run·error·idle_timeout");
    expect(lines.at(-1)?.display?.text).toContain("no output");
    delete process.env.VIBERR_CLAUDE_IDLE_TIMEOUT_MS;
    resetEnvCacheForTests();
  });

  it("a normal run never trips the guard", async () => {
    process.env.VIBERR_CLAUDE_IDLE_TIMEOUT_MS = "200";
    resetEnvCacheForTests();
    const { q } = fakeQuery([
      { type: "system", subtype: "init", session_id: "s-2" },
      { type: "result", subtype: "success", is_error: false },
    ]);
    let exit: RunExit | null = null;
    createClaudeAdapter({ queryFn: () => q }).start(SPEC, {
      onLine: () => {},
      onExit: (e) => (exit = e),
    });
    await drain();
    expect(exit).toMatchObject({ outcome: "finished" });
    delete process.env.VIBERR_CLAUDE_IDLE_TIMEOUT_MS;
    resetEnvCacheForTests();
  });
});

/**
 * UC-16 — the Claude half of the disclosed MCP asymmetries, plus ruling 49.
 *
 * The capability matrix tells an admin that org MCP credentials travel on
 * CLAUDE runs only, and that the mid-run comment / ask-human channel exists here
 * and nowhere else. Both are properties of what this adapter hands the SDK, so
 * they are pinned here; the Codex halves (credential dropped, in-process server
 * dropped) live in `codex-runtime.server.test.ts`, and the paired cross-backend
 * assertions in `runtime-registry.server.test.ts`.
 */
describe("UC-16 MCP channel + strict MCP config (ruling 49)", () => {
  async function optionsFor(spec: RunSpec): Promise<ClaudeQueryOptions> {
    const result = [
      { type: "result", subtype: "success", is_error: false, num_turns: 1, usage: {} },
    ];
    let captured: ClaudeQueryOptions | undefined;
    const queryFn: ClaudeQueryFn = (params) => {
      captured = params.options;
      const { q } = fakeQuery(result);
      return q;
    };
    createClaudeAdapter({ queryFn }).start(spec, {
      onLine: () => {},
      onExit: () => {},
    });
    await drain();
    return captured ?? {};
  }

  it("sets strictMcpConfig on EVERY run — kind, resume and skills change nothing", async () => {
    // R18-3 / ruling 49: only Viberr-granted MCP servers reach a run. Without
    // this the SDK also picks up a repo `.mcp.json`, the user's MCP config and
    // plugin MCP — an ambient tool channel no capability grant authorized, on
    // the backend whose whole isolation story is "settingSources: []". The
    // existing isolation tests cover a delivering run; an operator or a resumed
    // run must not be able to lose it.
    for (const spec of [
      { ...SPEC, kind: "primary" as const },
      { ...SPEC, kind: "operator" as const },
      { ...SPEC, kind: "reviewer" as const },
      { ...SPEC, resumeSessionId: "sess-9" },
      { ...SPEC, skills: ["developer-expertise"] },
      { ...SPEC, mcpServers: { docs: { type: "http", url: "https://x.test" } } },
    ]) {
      expect(
        (await optionsFor(spec)).strictMcpConfig,
        `strictMcpConfig for ${JSON.stringify({ kind: spec.kind, resume: spec.resumeSessionId, skills: spec.skills })}`,
      ).toBe(true);
    }
  });

  it("declares `permissionPrompts: 'none'` on EVERY run — there is never anyone at the CLI to answer one", async () => {
    // Agent SDK 0.3.259: who answers a permission prompt. Viberr passes no
    // `canUseTool`, so the honest answer is "nobody", stated so that a tool the
    // permission mode would ASK about is denied at once with a reason the
    // model can act on. It binds only on the `default` seam (a non-autonomous
    // spec); `bypassPermissions` never prompts, and deny rules are untouched.
    // Canary: drop the option from `start` and every spec below reads undefined.
    for (const spec of [
      { ...SPEC, kind: "primary" as const },
      { ...SPEC, kind: "operator" as const },
      { ...SPEC, kind: "controller" as const },
      { ...SPEC, autonomous: false },
      { ...SPEC, resumeSessionId: "sess-9" },
    ]) {
      const options = await optionsFor(spec);
      expect(
        options.permissionPrompts,
        `permissionPrompts for ${JSON.stringify({ kind: spec.kind, autonomous: spec.autonomous })}`,
      ).toBe("none");
      expect(options.permissionMode).toBe(spec.autonomous ? "bypassPermissions" : "default");
    }
  });

  it("acknowledges bypass exactly where it is asked for, and spawns the CLI itself on every run (ruling 174)", async () => {
    // The SDK: `allowDangerouslySkipPermissions` "must be set to `true` when
    // using `permissionMode: 'bypassPermissions'`", defaulting to false. The
    // pinned CLI does not enforce it; one that does would drop every run to
    // `default` + `permissionPrompts: 'none'` and deny every tool. Canary:
    // drop the line from `start` and the autonomous specs read undefined.
    for (const spec of [
      { ...SPEC, kind: "primary" as const },
      { ...SPEC, kind: "operator" as const },
      { ...SPEC, kind: "controller" as const },
      { ...SPEC, autonomous: false },
      { ...SPEC, resumeSessionId: "sess-9" },
    ]) {
      const options = await optionsFor(spec);
      const label = JSON.stringify({ kind: spec.kind, autonomous: spec.autonomous });
      if (spec.autonomous) {
        expect(options.allowDangerouslySkipPermissions, label).toBe(true);
      } else {
        expect(options, label).not.toHaveProperty("allowDangerouslySkipPermissions");
      }
      expect(options.spawnClaudeCodeProcess, label).toBeInstanceOf(Function);
    }
  });

  it("hands the SDK the granted servers verbatim — a gateway mount's run token and the in-process toolkit included", async () => {
    // The shapes a run's spec carries after `startRun` bound it to Viberr's
    // MCP gateway (ruling 461): a credentialed server as a gateway mount with
    // the RUN's token as its Authorization header (never the credential, which
    // stays in the gateway), an uncredentialed stdio server, and the
    // in-process `{ type: "sdk" }` toolkit that carries post_comment /
    // ask_human / report_outcome. Codex gets the same gateway mount (as
    // `http_headers`) and has no in-process channel at all, which is what the
    // matrix's "Post mid-run comments has no Codex channel" note describes.
    const servers = {
      "everything-http": {
        type: "http",
        url: "http://127.0.0.1:43111/mcp/everything-http",
        headers: { Authorization: "Bearer sentinel-run-token" },
      },
      "everything-stdio": {
        command: "npx",
        args: ["-y", "example-mcp"],
      },
      viberr_agent: { type: "sdk", instance: {} },
    };
    const captured = await optionsFor({
      ...SPEC,
      mcpServers: servers,
      allowedTools: ["mcp__viberr_agent"],
    });

    // Verbatim: nothing filtered, nothing renamed. The hyphen in the declared
    // name survives here — Viberr never pre-normalizes it to match the codex
    // CLI's underscore transform (P14-LV-03).
    expect(captured.mcpServers).toEqual(servers);
    // …and every mounted server is auto-approved, or an `mcp__*` call stalls on
    // a permission prompt no human is there to answer. `withMcpAutoApproval`
    // derives the missing entries upstream; the caller-named one is preserved.
    expect(captured.allowedTools).toContain("mcp__viberr_agent");
  });

  it("ruling 176: an HTTP server's per-tool deny policy and the denied names reach the SDK unchanged", async () => {
    // The resolver puts `always_deny` on the HTTP config and `startRun` adds the
    // `mcp__<server>__<tool>` names to the denylist; the adapter must forward
    // both as they are, beside the base denies.
    const servers = {
      "gh-http": {
        type: "http",
        url: "https://mcp.example.test/gh",
        tools: [{ name: "merge_pull_request", permission_policy: "always_deny" }],
      },
    };
    const captured = await optionsFor({
      ...SPEC,
      kind: "reviewer",
      mcpServers: servers,
      disallowedTools: ["Edit", "mcp__gh-http__merge_pull_request"],
    });
    expect(captured.mcpServers).toEqual(servers);
    expect(captured.disallowedTools).toEqual(
      expect.arrayContaining(["Edit", "mcp__gh-http__merge_pull_request"]),
    );
  });
});

/**
 * R21-4a / G5 (FR28) — the Live-run strip's phase rows.
 *
 * `onPhase` had been declared on `RunCallbacks` and wired through
 * `run-service.launch` since the phase-6 build, and NO adapter ever called it.
 * `agent_runs.phase`/`.step` therefore stayed null for the whole life of every
 * run, and the strip rendered two empty rows next to a spinner while an agent
 * worked — the FR28 progress row existed as markup and as a column, with
 * nothing in between.
 */
describe("claude adapter run phases (R21-4a / FR28)", () => {
  /** Every (phase, step) pair the adapter emitted, oldest first. */
  function capturePhases(messages: unknown[]) {
    const { q } = fakeQuery(messages);
    const adapter = createClaudeAdapter({ queryFn: () => q });
    const phases: [string | null, string | null][] = [];
    adapter.start(SPEC, {
      onLine: () => {},
      onExit: () => {},
      onPhase: (phase, step) => phases.push([phase, step]),
    });
    return phases;
  }

  it("emits starting → working → finishing across a run", async () => {
    const phases = capturePhases([
      { type: "system", subtype: "init", session_id: "s", model: "claude-sonnet-4-5", tools: [], mcp_servers: [] },
      { type: "assistant", message: { content: [{ type: "text", text: "hi" }], usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0 } } },
      { type: "result", subtype: "success", is_error: false, num_turns: 1, usage: { input_tokens: 10, output_tokens: 2 }, total_cost_usd: 0 },
    ]);
    await drain();

    expect(phases[0]).toEqual(["Starting", null]);
    expect(phases.map(([p]) => p)).toContain("Working");
    expect(phases.at(-1)).toEqual(["Finishing", null]);
  });

  it("names the tool the run is inside, and keeps naming it while the model thinks", async () => {
    const phases = capturePhases([
      { type: "system", subtype: "init", session_id: "s", model: "claude-sonnet-4-5", tools: [], mcp_servers: [] },
      { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "npm test" } }] } },
      // A plain text turn AFTER the tool: the step must not blank out.
      { type: "assistant", message: { content: [{ type: "text", text: "thinking" }] } },
      { type: "result", subtype: "success", is_error: false, num_turns: 2, usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0 },
    ]);
    await drain();

    const steps = phases.filter(([p]) => p === "Working").map(([, s]) => s);
    expect(steps[1]).toContain("Bash");
    expect(steps[1]).toContain("npm test");
    // Sticky: the next (non-tool) message still reports the tool in flight.
    expect(steps[2]).toBe(steps[1]);
  });

  it("names the tool as answered once its result lands, so the thinking after it does not read as the tool running (ruling 348)", async () => {
    const phases = capturePhases([
      { type: "system", subtype: "init", session_id: "s", model: "claude-sonnet-4-5", tools: [], mcp_servers: [] },
      { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "npm test" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", content: "12 passed" }] } },
      // The model thinks and writes after the result: the finished call must
      // not be shown as the thing the run is doing.
      { type: "assistant", message: { content: [{ type: "text", text: "thinking" }] } },
      { type: "result", subtype: "success", is_error: false, num_turns: 2, usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0 },
    ]);
    await drain();

    const steps = phases.filter(([p]) => p === "Working").map(([, s]) => s);
    expect(steps[1]).toBe("Bash · npm test");
    // CANARY: keep `lastStep` untouched on a `tool_result` line.
    expect(steps[2]).toBe("composing · Bash · npm test answered");
    expect(steps[3]).toBe("composing · Bash · npm test answered");
  });

  it("falls back to the SDK's turn count before the first tool call", async () => {
    // Two assistant envelopes with no user message between them are blocks of
    // ONE turn (the SDK's `num_turns` is one plus the user messages that flow
    // through its loop); the tool result is what starts the next. The fallback
    // used to count envelopes, and over-counted on every multi-turn run.
    const phases = capturePhases([
      { type: "system", subtype: "init", session_id: "s", model: "claude-sonnet-4-5", tools: [], mcp_servers: [] },
      { type: "assistant", message: { content: [{ type: "text", text: "one" }], usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 } } },
      { type: "assistant", message: { content: [{ type: "text", text: "two" }], usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 } } },
      { type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "three" }], usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 } } },
      { type: "result", subtype: "success", is_error: false, num_turns: 2, usage: { input_tokens: 3, output_tokens: 3 }, total_cost_usd: 0 },
    ]);
    await drain();

    const steps = phases.filter(([p]) => p === "Working").map(([, s]) => s);
    expect(steps[1]).toBe("turn 1");
    expect(steps[2]).toBe("turn 1");
    expect(steps[3]).toBe("turn 2");
    expect(steps[4]).toBe("turn 2");
  });
});

/**
 * Ruling 130(a): refusals are classified from the structured envelope first
 * and the terminal line carries the typed facts. Canaries: remove the
 * structured arms (`quotaByEvidence` / `authByEvidence`); drop the
 * `windowRejected` gate in `failureFacts`; require evidence for the quota arm.
 */
describe("ruling 130(a): structured classification", () => {
  const run = async (messages: unknown[], opts: { throwAfter?: number } = {}) => {
    const { q } = fakeQuery(messages, opts);
    const adapter = createClaudeAdapter({ queryFn: () => q });
    const lines: EmittedLine[] = [];
    let exit: RunExit | null = null;
    adapter.start(SPEC, { onLine: (l) => lines.push(l), onExit: (e) => (exit = e) });
    await drain();
    return { lines, exit, terminal: lines.find((l) => (l.display?.tag ?? "").startsWith("run·error·")) };
  };

  it("a 403 `oauth_org_not_allowed` classifies `run·error·auth` from the envelope and names Profile → Agent accounts", async () => {
    const { lines, terminal } = await run([
      { type: "assistant", error: "oauth_org_not_allowed", message: { content: [{ type: "text", text: "You are not allowed here." }], usage: {} } },
      { type: "result", subtype: "success", is_error: true, num_turns: 1, usage: {}, api_error_status: 403, terminal_reason: "api_error", result: "" },
    ]);
    expect(terminal?.display?.tag).toBe("run·error·auth");
    expect(terminal?.display?.text).toContain("oauth_org_not_allowed");
    expect(terminal?.display?.text).toContain("Profile → Agent accounts");
    expect(terminal?.display?.failure).toEqual({
      kind: "auth", resetsAt: null, window: null, windowRejected: false,
      apiError: "oauth_org_not_allowed", apiErrorStatus: 403, terminalReason: "api_error", origin: null,
    });
    // The banner is an error line, never the reply.
    expect(lines.find((l) => l.display?.tag === "assistant·oauth_org_not_allowed")?.display?.ev).toBe("err");
    expect(lines.some((l) => l.display?.ev === "text")).toBe(false);
  });

  it("a session-limit refusal after a REJECTED rate-limit reading classifies quota with the exact reset; an ALLOWED reading carries none", async () => {
    const rejected = await run([
      { type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour", utilization: null, resetsAt: 1_788_781_800, isUsingOverage: false } },
      { type: "result", subtype: "success", is_error: true, num_turns: 1, usage: {}, api_error_status: 429, result: "You've hit your session limit." },
    ]);
    expect(rejected.terminal?.display?.tag).toBe("run·error·quota");
    expect(rejected.terminal?.display?.failure).toMatchObject({
      kind: "quota", windowRejected: true, window: "five_hour", resetsAt: "2026-09-07T11:50:00.000Z", apiErrorStatus: 429,
    });
    expect(rejected.terminal?.display?.text).toContain("five hour window is spent");
    expect(rejected.terminal?.display?.text).toContain("reopens at 2026-09-07 11:50 UTC");

    // No prose at all: the structured facts alone classify quota (a 429
    // status with a rejected reading), so the class never depends on the
    // provider's wording.
    const structuredOnly = await run([
      { type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour", utilization: null, resetsAt: 1_788_781_800, isUsingOverage: false } },
      { type: "result", subtype: "success", is_error: true, num_turns: 1, usage: {}, api_error_status: 429, result: "" },
    ]);
    expect(structuredOnly.terminal?.display?.tag).toBe("run·error·quota");
    expect(structuredOnly.terminal?.display?.failure).toMatchObject({ kind: "quota", windowRejected: true, apiErrorStatus: 429 });

    const allowed = await run([
      { type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "five_hour", utilization: 0.5, resetsAt: 1_788_781_800, isUsingOverage: false } },
      { type: "result", subtype: "error_during_execution", is_error: true, num_turns: 1, usage: {}, result: "429 too many requests" },
    ]);
    expect(allowed.terminal?.display?.tag).toBe("run·error·quota");
    expect(allowed.terminal?.display?.failure).toMatchObject({ windowRejected: false, resetsAt: null, window: null });
  });

  it("a thrown stream error with no envelope evidence still classifies by prose", async () => {
    const { q } = fakeQuery([], { rejectWith: new Error("Claude AI weekly limit reached") });
    const adapter = createClaudeAdapter({ queryFn: () => q });
    const lines: EmittedLine[] = [];
    adapter.start(SPEC, { onLine: (l) => lines.push(l), onExit: () => {} });
    await drain();
    const terminal = lines.find((l) => (l.display?.tag ?? "").startsWith("run·error·"));
    expect(terminal?.display?.tag).toBe("run·error·quota");
    expect(terminal?.display?.failure).toMatchObject({ kind: "quota", windowRejected: false, apiError: null });
  });

  /**
   * Agent SDK 0.3.261 upgrade. Since 0.3.223 a run the SDK gives up on after
   * repeated 529s ends with `api_error_status: 529`, so an overload is read
   * from that fact, not from prose. It used to land on `unknown` and tell the
   * human to "review the runtime configuration" for a failure that was the
   * provider's — and, being classified, it lost the retry-on-the-other-backend
   * offer the raw "overloaded" scan would have given an unclassified run.
   *
   * Canary: remove the `overloadByEvidence` arm and every case below falls to
   * `run·error·unknown`.
   */
  it("a 529 result classifies `run·error·overloaded` structurally, names the provider (not the account) and a retry", async () => {
    const { terminal } = await run([
      { type: "result", subtype: "success", is_error: true, num_turns: 3, usage: {}, api_error_status: 529, terminal_reason: "api_error", result: "" },
    ]);
    expect(terminal?.display?.tag).toBe("run·error·overloaded");
    expect(terminal?.display?.text).toBe(
      "Claude could not serve this run: the provider was overloaded (HTTP 529). Nothing about the account or the task is wrong; retry in a few minutes.",
    );
    expect(terminal?.display?.text).not.toContain("Profile → Agent accounts");
    expect(terminal?.display?.failure).toEqual({
      kind: "overloaded", resetsAt: null, window: null, windowRejected: false,
      apiError: null, apiErrorStatus: 529, terminalReason: "api_error", origin: "provider",
    });
  });

  /**
   * U35-11 (pass 35): live, nine runs died on the CLI's "API Error: Unable to
   * connect to API (UNKNOWN_CERTIFICATE_VERIFICATION_ERROR)" under a
   * `server_error` banner with no HTTP status, while the container's own
   * fetch was the thing failing; the overload arm narrated it as "the
   * provider failed on its own side". Same class and retry, its own origin
   * and sentence. Canary: delete the local-network arm and the first case
   * falls to the overload arm's "failed on its own side".
   */
  it("a connection that failed before the provider answered classifies `overloaded` with origin `local` and names this deployment, not the provider", async () => {
    const tls = await run([
      { type: "assistant", error: "server_error", message: { content: [{ type: "text", text: "API Error: Unable to connect to API (UNKNOWN_CERTIFICATE_VERIFICATION_ERROR)" }], usage: {} } },
      { type: "result", subtype: "success", is_error: true, num_turns: 1, usage: {}, api_error_status: null, terminal_reason: "api_error", result: "API Error: Unable to connect to API (UNKNOWN_CERTIFICATE_VERIFICATION_ERROR)" },
    ]);
    expect(tls.terminal?.display?.tag).toBe("run·error·overloaded");
    expect(tls.terminal?.display?.text).toContain(
      "Claude could not be reached from this deployment: the connection failed before the provider answered (UNKNOWN_CERTIFICATE_VERIFICATION_ERROR). Nothing about the account or the task is wrong; check this deployment's network path (TLS, DNS, proxy) and retry in a few minutes.",
    );
    expect(tls.terminal?.display?.text).not.toContain("failed on its own side");
    expect(tls.terminal?.display?.failure).toMatchObject({ kind: "overloaded", origin: "local", apiError: "server_error", apiErrorStatus: null });

    // A thrown stream error with the same shape, no envelope evidence at all.
    for (const text of ["fetch failed", "connect ECONNREFUSED 10.0.0.1:443", "getaddrinfo ENOTFOUND api.anthropic.com"]) {
      const { q } = fakeQuery([], { rejectWith: new Error(text) });
      const adapter = createClaudeAdapter({ queryFn: () => q });
      const lines: EmittedLine[] = [];
      adapter.start(SPEC, { onLine: (l) => lines.push(l), onExit: () => {} });
      await drain();
      const terminal = lines.find((l) => (l.display?.tag ?? "").startsWith("run·error·"));
      expect(terminal?.display?.tag, text).toBe("run·error·overloaded");
      expect(terminal?.display?.failure?.origin, text).toBe("local");
    }

    // The provider DID answer with a 5xx: never local, whatever the prose says.
    const answered = await run([
      { type: "assistant", error: "server_error", message: { content: [{ type: "text", text: "connection error upstream" }], usage: {} } },
      { type: "result", subtype: "success", is_error: true, num_turns: 1, usage: {}, api_error_status: 502, terminal_reason: "api_error", result: "" },
    ]);
    expect(answered.terminal?.display?.failure).toMatchObject({ kind: "overloaded", origin: "provider", apiErrorStatus: 502 });
    expect(answered.terminal?.display?.text).toContain("failed on its own side (HTTP 502)");
  });

  it("the assistant banner's `overloaded` / `server_error` codes classify the same class; a plain 5xx reads as the provider's own failure", async () => {
    const banner = await run([
      { type: "assistant", error: "overloaded", message: { content: [{ type: "text" , text: "Overloaded" }], usage: {} } },
      { type: "result", subtype: "error_during_execution", is_error: true, num_turns: 1, usage: {}, result: "" },
    ]);
    expect(banner.terminal?.display?.tag).toBe("run·error·overloaded");
    expect(banner.terminal?.display?.text).toContain("the provider was overloaded.");
    expect(banner.terminal?.display?.failure).toMatchObject({ kind: "overloaded", apiError: "overloaded", apiErrorStatus: null });

    const serverError = await run([
      { type: "assistant", error: "server_error", message: { content: [{ type: "text", text: "Internal server error" }], usage: {} } },
      { type: "result", subtype: "success", is_error: true, num_turns: 1, usage: {}, api_error_status: 500, terminal_reason: "api_error", result: "" },
    ]);
    expect(serverError.terminal?.display?.tag).toBe("run·error·overloaded");
    expect(serverError.terminal?.display?.text).toContain("the provider failed on its own side (HTTP 500).");
    expect(serverError.terminal?.display?.failure).toMatchObject({ kind: "overloaded", apiError: "server_error", apiErrorStatus: 500 });
  });

  it("a provider-side status is where the run ENDED: an earlier `rate_limit` banner the SDK retried through does not re-route it to quota — a REJECTED reading still does", async () => {
    const retriedThrough = await run([
      { type: "assistant", error: "rate_limit", message: { content: [{ type: "text", text: "Rate limited, retrying" }], usage: {} } },
      { type: "result", subtype: "success", is_error: true, num_turns: 2, usage: {}, api_error_status: 529, terminal_reason: "api_error", result: "" },
    ]);
    expect(retriedThrough.terminal?.display?.tag).toBe("run·error·overloaded");
    expect(retriedThrough.terminal?.display?.failure).toMatchObject({ kind: "overloaded", apiError: "rate_limit", apiErrorStatus: 529 });

    const rejected = await run([
      { type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour", utilization: null, resetsAt: 1_788_781_800, isUsingOverage: false } },
      { type: "result", subtype: "success", is_error: true, num_turns: 2, usage: {}, api_error_status: 529, terminal_reason: "api_error", result: "" },
    ]);
    expect(rejected.terminal?.display?.tag).toBe("run·error·quota");
    expect(rejected.terminal?.display?.failure).toMatchObject({ kind: "quota", windowRejected: true, window: "five_hour" });
  });

  it("a thrown stream error naming a 529 / overload classifies `overloaded` by prose, never quota or unknown", async () => {
    // Ruling 659: a provider's "model is at capacity" is the same busy provider.
    // CANARY: drop `at capacity` from the overload pattern and the last is `unknown`.
    for (const text of [
      "API Error: 529 Overloaded",
      "The upstream service is temporarily unavailable",
      "503 Service Unavailable",
      "Selected model is at capacity. Please try a different model.",
    ]) {
      const { q } = fakeQuery([], { rejectWith: new Error(text) });
      const adapter = createClaudeAdapter({ queryFn: () => q });
      const lines: EmittedLine[] = [];
      adapter.start(SPEC, { onLine: (l) => lines.push(l), onExit: () => {} });
      await drain();
      const terminal = lines.find((l) => (l.display?.tag ?? "").startsWith("run·error·"));
      expect(terminal?.display?.tag, text).toBe("run·error·overloaded");
      expect(terminal?.display?.failure).toMatchObject({ kind: "overloaded", apiErrorStatus: null });
    }
  });

  it("`account_on_hold` (new in the SDK's error union) is an account refusal: `run·error·auth`, naming the hold and Profile → Agent accounts", async () => {
    const { terminal } = await run([
      { type: "assistant", error: "account_on_hold", message: { content: [{ type: "text", text: "Your account is on hold." }], usage: {} } },
      { type: "result", subtype: "success", is_error: true, num_turns: 1, usage: {}, api_error_status: 403, terminal_reason: "api_error", result: "" },
    ]);
    expect(terminal?.display?.tag).toBe("run·error·auth");
    expect(terminal?.display?.text).toContain("(403 account_on_hold): the account itself is on hold");
    expect(terminal?.display?.text).toContain("Profile → Agent accounts");
    expect(terminal?.display?.failure).toMatchObject({ kind: "auth", apiError: "account_on_hold", apiErrorStatus: 403 });
  });
});

/**
 * Ruling 611: a run asks its own CLI for the account's plan windows (the data
 * behind `/usage`), because a `rate_limit_event` gives a percentage only once
 * the provider warns. Live on 2026-10-01 the events read "five_hour · allowed ·
 * utilization not reported" while the account's week stood at 71%.
 */
describe("ruling 611: a Claude run reads its account's plan windows", () => {
  // The live answer's resets, floored to the second.
  const FIVE_HOUR_RESET = 1_790_833_199; // 2026-10-01T05:39:59Z
  const WEEK_RESET = 1_790_855_999; // 2026-10-01T11:59:59Z
  const iso = (epoch: number) => new Date(epoch * 1000).toISOString();
  const init = { type: "system", subtype: "init", session_id: "s", model: "claude-opus-5-5", tools: [], mcp_servers: [] };
  const text = (t: string) => ({ type: "assistant", message: { content: [{ type: "text", text: t }] } });
  const event = (status: string, rateLimitType: string, utilization: number | null, resetsAt: number) => ({
    type: "rate_limit_event",
    rate_limit_info: { status, rateLimitType, utilization, resetsAt, isUsingOverage: false },
  });
  const result = { type: "result", subtype: "success", is_error: false, num_turns: 1, usage: {}, total_cost_usd: 0.01 };
  const answer = (rateLimits: SDKControlGetUsageResponse["rate_limits"]): SDKControlGetUsageResponse => ({
    session: { total_cost_usd: 0, total_api_duration_ms: 0, total_duration_ms: 0, total_lines_added: 0, total_lines_removed: 0, model_usage: {} },
    subscription_type: rateLimits ? "max" : null,
    rate_limits_available: rateLimits !== null,
    rate_limits: rateLimits,
    behaviors: null,
  });
  // The windows as the bundled CLI gave them live: percentages 0 to 100,
  // ISO resets with microseconds, a window that does not apply as null.
  const usageAnswer = answer({
    five_hour: { utilization: 1, resets_at: "2026-10-01T05:39:59.634177+00:00" },
    seven_day: { utilization: 71, resets_at: "2026-10-01T11:59:59.634218+00:00" },
    seven_day_opus: null,
    model_scoped: [{ display_name: "Fable", utilization: 12.5, resets_at: iso(WEEK_RESET) }],
  });

  const run = async (messages: unknown[], usage?: (opts?: { skipBehaviors?: boolean }) => Promise<SDKControlGetUsageResponse>) => {
    const { q } = fakeQuery(messages, usage ? { usage } : {});
    const lines: EmittedLine[] = [];
    let exit: RunExit | null = null;
    createClaudeAdapter({ queryFn: () => q }).start(SPEC, { onLine: (l) => lines.push(l), onExit: (e) => (exit = e) });
    await drain();
    return { lines, exit, readings: lines.flatMap((l) => (l.facts.rateLimit ? [l.facts.rateLimit] : [])) };
  };

  it("records every plan window, and a later event beside them with the provider's warning kept", async () => {
    const asked: unknown[] = [];
    const { lines, exit, readings } = await run(
      [
        init,
        text("reading the board"),
        text("still reading"),
        event("allowed", "five_hour", null, FIVE_HOUR_RESET),
        text("working"),
        event("allowed_warning", "seven_day", 0.94, WEEK_RESET),
        result,
      ],
      async (opts) => {
        asked.push(opts);
        return usageAnswer;
      },
    );
    expect(exit).toMatchObject({ outcome: "finished" });
    // CANARY: drop the ask at `system/init` and no line carries the windows.
    // One ask per run, without the scan of local transcripts.
    expect(asked).toEqual([{ skipBehaviors: true }]);
    const windows = [
      { rateLimitType: "five_hour", utilization: 0.01, resetsAt: FIVE_HOUR_RESET },
      // CANARY: read the percentage as a fraction and this reads 1 (clamped).
      { rateLimitType: "seven_day", utilization: 0.71, resetsAt: WEEK_RESET },
      { rateLimitType: "seven_day_fable", utilization: 0.125, resetsAt: WEEK_RESET },
    ];
    // The windows ride a line before the first event: the week, closest to
    // its limit, is the binding window.
    expect(readings[0]).toEqual({
      status: "allowed", rateLimitType: "seven_day", utilization: 0.71, resetsAt: WEEK_RESET, isUsingOverage: false, windows,
    });
    // CANARY: record the event as it came once the windows are known, and this
    // reading falls back to "five_hour, utilization null" with no week in it.
    expect(readings[1]).toEqual(readings[0]);
    expect(lines.find((l) => l.facts.rateLimit === readings[1])?.display?.tag).toBe("rate_limit_event");
    // A warning is the provider's live word: its window binds with its
    // status and its newer percentage, the other windows kept.
    expect(readings[2]).toEqual({
      status: "allowed_warning",
      rateLimitType: "seven_day",
      utilization: 0.94,
      resetsAt: WEEK_RESET,
      isUsingOverage: false,
      windows: [windows[0], { ...windows[1], utilization: 0.94 }, windows[2]],
    });
    expect(readings).toHaveLength(3);
  });

  it.each([
    ["an SDK without the request", undefined],
    ["an API-key session", async () => answer(null)],
    ["a request that fails", async () => Promise.reject(new Error("control request failed"))],
  ])("%s records the event as it came and finishes the run", async (_name, usage) => {
    const { exit, readings } = await run(
      [init, text("one"), text("two"), event("allowed", "five_hour", null, FIVE_HOUR_RESET), result],
      usage,
    );
    expect(exit).toMatchObject({ outcome: "finished" });
    expect(readings).toEqual([
      { status: "allowed", rateLimitType: "five_hour", utilization: null, resetsAt: FIVE_HOUR_RESET, isUsingOverage: false },
    ]);
  });
});

/**
 * Ruling 174: the CLI leads its own process group, and a settled run leaves no
 * live process. A fake `queryFn` never spawns anything, so these drive the SDK's
 * side of the contract themselves: they call `options.spawnClaudeCodeProcess`
 * the way the SDK does, with a stand-in child the adapter's seam accepts.
 */
describe("claude CLI process lifecycle (ruling 174)", () => {
  const CLI_PID = 4242;

  function standInChild() {
    return Object.assign(new EventEmitter(), {
      pid: CLI_PID,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      killed: false,
      exitCode: null,
      signalCode: null,
      kill: () => true,
    });
  }

  function harness() {
    const child = standInChild();
    const signals: [number, NodeJS.Signals | 0][] = [];
    const reaped: ReapTargets[] = [];
    const deps = {
      spawnCli: () => child,
      signalProcess: (pid: number, signal: NodeJS.Signals | 0) => {
        signals.push([pid, signal]);
      },
      reapProcesses: async (targets: ReapTargets) => {
        reaped.push(targets);
        return { terminated: 0, killed: 0 };
      },
    };
    /** What the SDK does first: spawn the CLI through the custom function. */
    const spawnThrough = (options: ClaudeQueryOptions | undefined) =>
      options?.spawnClaudeCodeProcess?.({ command: "claude", args: [], env: {} });
    /** The CLI exits and its stderr closes, as a real one does after the result. */
    const exitCli = (code = 0) => {
      child.stderr.end();
      child.emit("exit", code, null);
    };
    return { child, signals, reaped, deps, spawnThrough, exitCli };
  }

  const SUCCESS = { type: "result", subtype: "success", is_error: false, num_turns: 1, usage: {} };

  it("once the run settles and the CLI has exited, sweeps its group and every process carrying the run's marker", async () => {
    const h = harness();
    const adapter = createClaudeAdapter({
      ...h.deps,
      queryFn: ({ options }) => {
        h.spawnThrough(options);
        return fakeQuery([SUCCESS]).q;
      },
    });
    let exit: RunExit | null = null;
    adapter.start(
      { ...SPEC, runId: "run_marked", env: { VIBERR_RUN_ID: "run_marked" } },
      { onLine: () => {}, onExit: (e) => (exit = e) },
    );
    await drain();
    expect(exit).toMatchObject({ outcome: "finished" });
    // Settled, but the CLI is still closing: the sweep waits for its own exit
    // first, so its shutdown gets to stop what it tracks.
    expect(h.reaped).toEqual([]);

    h.exitCli();
    await drain();
    expect(h.reaped).toEqual([{ runIds: ["run_marked"], groupLeader: CLI_PID }]);
  });

  /**
   * Ruling 460: a run carrying an agent launch spawns the LAUNCHER, detached,
   * as the principal's uid — never the CLI as the server's user — with the
   * SDK's argv untouched and nothing of the server's own secrets in its env.
   */
  describe("as the principal's own OS user (ruling 460)", () => {
    const LAUNCH = {
      uid: 20001,
      launcher: "/usr/local/libexec/viberr-launch",
      launchHome: "/data/runtimes/users/u_ada/claude-home",
      home: "/data/runtimes/users/u_ada/home",
    };
    const SDK_ARGS = ["--output-format", "stream-json", "--verbose", "--input-format", "stream-json"];

    function launchedHarness() {
      const h = harness();
      const spawned: { command: string; args: readonly string[]; env: NodeJS.ProcessEnv | undefined; detached: boolean | undefined }[] = [];
      const deps = {
        ...h.deps,
        // What production hands the adapter: the credential-free base env.
        env: filteredSpawnEnv(),
        spawnCli: (command: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv; detached?: boolean }) => {
          spawned.push({ command, args, env: options.env, detached: options.detached });
          return h.child;
        },
      };
      return { ...h, deps, spawned };
    }

    const LAUNCHED_SPEC: RunSpec = {
      ...SPEC,
      runId: "run_launched",
      agent: LAUNCH,
      env: {
        CLAUDE_CONFIG_DIR: LAUNCH.launchHome,
        ANTHROPIC_API_KEY: "sk-ant-the-persons-own",
        HOME: LAUNCH.home,
        VIBERR_RUN_ID: "run_launched",
      },
    };

    it("spawns the launcher with the real binary, the principal's uid and the SDK's argv untouched", async () => {
      const h = launchedHarness();
      let processForSdk: ReturnType<NonNullable<ClaudeQueryOptions["spawnClaudeCodeProcess"]>> | undefined;
      const adapter = createClaudeAdapter({
        ...h.deps,
        queryFn: ({ options }) => {
          processForSdk = options?.spawnClaudeCodeProcess?.({
            command: "/opt/claude/claude",
            args: SDK_ARGS,
            env: options.env ?? {},
          });
          return fakeQuery([SUCCESS]).q;
        },
      });
      adapter.start(LAUNCHED_SPEC, { onLine: () => {}, onExit: () => {} });
      await drain();

      expect(h.spawned).toHaveLength(1);
      const [spawn] = h.spawned;
      expect(spawn?.command).toBe(LAUNCH.launcher);
      expect(spawn?.args).toEqual(SDK_ARGS);
      expect(spawn?.detached).toBe(true);
      expect(spawn?.env?.VIBERR_LAUNCH_EXEC).toBe("/opt/claude/claude");
      expect(spawn?.env?.VIBERR_LAUNCH_UID).toBe("20001");
      expect(spawn?.env?.VIBERR_LAUNCH_HOME).toBe(LAUNCH.launchHome);
      expect(spawn?.env?.HOME).toBe(LAUNCH.home);
      // The one credential a run may carry is its principal's own (ruling 127);
      // the server's secrets are in this process's env and must not follow.
      expect(spawn?.env?.ANTHROPIC_API_KEY).toBe("sk-ant-the-persons-own");
      expect(process.env.VIBERR_SECRET_ENCRYPTION_KEY).toBeTruthy();
      expect(spawn?.env?.VIBERR_SECRET_ENCRYPTION_KEY).toBeUndefined();
      expect(spawn?.env?.VIBERR_SESSION_SECRET).toBeUndefined();

      // The SDK's hard kill reaches the agent's group as the launcher's SIGUSR2;
      // a SIGKILL of the launcher would orphan processes the server cannot signal.
      processForSdk?.kill("SIGKILL");
      processForSdk?.kill("SIGTERM");
      expect(h.signals).toEqual([
        [-CLI_PID, "SIGUSR2"],
        [-CLI_PID, "SIGTERM"],
      ]);

      h.exitCli();
      await drain();
      expect(h.reaped).toEqual([
        { runIds: ["run_launched"], groupLeader: CLI_PID, launched: true },
      ]);
    });

    it("resolves a bare command on PATH: the launcher execs absolute paths only", async () => {
      const h = launchedHarness();
      const adapter = createClaudeAdapter({
        ...h.deps,
        queryFn: ({ options }) => {
          options?.spawnClaudeCodeProcess?.({ command: "node", args: ["cli.js"], env: options.env ?? {} });
          return fakeQuery([SUCCESS]).q;
        },
      });
      adapter.start(LAUNCHED_SPEC, { onLine: () => {}, onExit: () => {} });
      await drain();
      const exec = h.spawned[0]?.env?.VIBERR_LAUNCH_EXEC ?? "";
      expect(path.isAbsolute(exec)).toBe(true);
      expect(path.basename(exec)).toBe("node");
      expect(h.spawned[0]?.args).toEqual(["cli.js"]);
    });

    it("the completion compaction's CLI is launched as the principal too", async () => {
      const h = launchedHarness();
      const adapter = createClaudeAdapter({
        ...h.deps,
        queryFn: ({ options }) => {
          options?.spawnClaudeCodeProcess?.({ command: "/opt/claude/claude", args: SDK_ARGS, env: options.env ?? {} });
          return fakeQuery([SUCCESS]).q;
        },
      });
      await adapter.compact?.(LAUNCHED_SPEC, "sess-1", { onLine: () => {} });
      expect(h.spawned[0]?.command).toBe(LAUNCH.launcher);
      expect(h.spawned[0]?.env?.VIBERR_LAUNCH_UID).toBe("20001");
    });

    it("without a launch, the CLI itself is spawned, exactly as before", async () => {
      const h = launchedHarness();
      const adapter = createClaudeAdapter({
        ...h.deps,
        queryFn: ({ options }) => {
          options?.spawnClaudeCodeProcess?.({ command: "/opt/claude/claude", args: SDK_ARGS, env: options.env ?? {} });
          return fakeQuery([SUCCESS]).q;
        },
      });
      adapter.start(SPEC, { onLine: () => {}, onExit: () => {} });
      await drain();
      expect(h.spawned[0]?.command).toBe("/opt/claude/claude");
      expect(h.spawned[0]?.env?.VIBERR_LAUNCH_UID).toBeUndefined();
    });
  });

  it("a run the service did not mark still has its group swept, and sweeps by no marker", async () => {
    const h = harness();
    const adapter = createClaudeAdapter({
      ...h.deps,
      queryFn: ({ options }) => {
        h.spawnThrough(options);
        return fakeQuery([SUCCESS]).q;
      },
    });
    adapter.start(SPEC, { onLine: () => {}, onExit: () => {} });
    await drain();
    h.exitCli();
    await drain();
    expect(h.reaped).toEqual([{ runIds: [], groupLeader: CLI_PID }]);
  });

  it("sweeps nothing when the SDK never spawned a CLI", async () => {
    const h = harness();
    const adapter = createClaudeAdapter({ ...h.deps, queryFn: () => fakeQuery([SUCCESS]).q });
    adapter.start(
      { ...SPEC, env: { VIBERR_RUN_ID: "r1" } },
      { onLine: () => {}, onExit: () => {} },
    );
    await drain();
    expect(h.reaped).toEqual([]);
  });

  it("a stop the CLI never answers SIGTERMs the CLI's whole group as it aborts", async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      let captured: AbortController | undefined;
      const adapter = createClaudeAdapter({
        ...h.deps,
        queryFn: ({ options }) => {
          h.spawnThrough(options);
          captured = options?.abortController;
          const gen = (async function* () {
            await new Promise<void>((_resolve, reject) => {
              captured?.signal.addEventListener("abort", () =>
                reject(new Error("Claude Code process aborted by user")),
              );
            });
            const none: never[] = [];
            yield* none;
          })();
          return Object.assign(gen, { interrupt: async () => new Promise<void>(() => {}) });
        },
      });
      const handle = adapter.start(SPEC, { onLine: () => {}, onExit: () => {} });
      await vi.advanceTimersByTimeAsync(0);

      handle.interrupt();
      expect(h.signals).toEqual([]); // the cooperative window comes first

      await vi.advanceTimersByTimeAsync(INTERRUPT_GRACE_MS + 1);
      expect(captured?.signal.aborted).toBe(true);
      expect(h.signals).toContainEqual([-CLI_PID, "SIGTERM"]);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * Ruling 687: Claude Code 2.1.292 keeps an SDK run open after its final
   * result while a command the agent backgrounded still runs, and a dev server
   * never ends. The run used to sit past its result for the whole idle window
   * and then settle `run·error·idle_timeout`, holding its slot, and a run cut
   * off by a cap or failed by its provider lost that class to the hang. A line
   * that still arrives after the result is read as before, and does not extend
   * the grace.
   */
  describe("ruling 687: a CLI still open after the run's result", () => {
    const INIT = { type: "system", subtype: "init", session_id: "s-683", model: "claude-opus-5-5", tools: ["Bash"], mcp_servers: [] };
    /** Well short of the default 15-minute idle window. */
    const A_MINUTE = 60_000;

    /** A line a CLI that waits on a background command may still send. */
    const RATE_LIMIT = { type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "five_hour", resetsAt: 1_791_400_000 } };
    /** A line the CLI sends, after a pause in ms. */
    type Step = readonly [pause: number, line: object];
    /** That line once a second for ten seconds. */
    const CHATTER: Step[] = Array.from({ length: 10 }, () => [1_000, RATE_LIMIT]);
    /** Ruling 175: the turn cap's cut-off. */
    const MAX_TURNS = { type: "result", subtype: "error_max_turns", is_error: true, num_turns: 2000, usage: {} };
    /** A failure only the result's own words classify: the abort's throw names none. */
    const QUOTA = { type: "result", subtype: "error_during_execution", is_error: true, num_turns: 9, usage: {}, result: "429 too many requests" };

    beforeEach(() => {
      vi.useFakeTimers();
      // An idle window shorter than the grace: past a result the grace
      // decides, not the idle guard.
      process.env.VIBERR_CLAUDE_IDLE_TIMEOUT_MS = "500";
      resetEnvCacheForTests();
    });
    afterEach(() => {
      vi.useRealTimers();
      delete process.env.VIBERR_CLAUDE_IDLE_TIMEOUT_MS;
      resetEnvCacheForTests();
    });

    /**
     * Start a run on a CLI that sends `script` and stops sending once the
     * abort lands. Its stream then ends where the script does (`closes`),
     * throws on the abort as the SDK's does (`throws`), stays open past it
     * (`hangs`), or ends or throws 30 s after it (`ends-late`,
     * `throws-late`). `late` is whatever reached the run's callbacks after it
     * exited; `interrupts` counts the cooperative requests the run sent.
     */
    function startOnOpenCli(
      script: readonly Step[],
      ending: "closes" | "throws" | "hangs" | "ends-late" | "throws-late",
    ) {
      const h = harness();
      let signal: AbortSignal | undefined;
      let interrupts = 0;
      const queryFn: ClaudeQueryFn = ({ options }) => {
        h.spawnThrough(options);
        signal = options?.abortController?.signal;
        const gen = (async function* () {
          for (const [pause, line] of script) {
            if (pause > 0) await new Promise((r) => setTimeout(r, pause));
            if (signal?.aborted) break;
            yield line;
          }
          if (ending === "closes") return;
          if (ending === "hangs") await new Promise(() => {});
          if (!signal?.aborted) await new Promise((r) => signal?.addEventListener("abort", r));
          if (ending !== "throws") await new Promise((r) => setTimeout(r, 30_000));
          if (ending === "ends-late") return;
          throw new Error("Claude Code process aborted by user");
        })();
        return Object.assign(gen, {
          interrupt: async () => {
            interrupts += 1;
          },
        });
      };
      const lines: EmittedLine[] = [];
      const late: string[] = [];
      let exit: RunExit | null = null;
      const handle = createClaudeAdapter({ ...h.deps, queryFn }).start(
        { ...SPEC, runId: "run_683", env: { VIBERR_RUN_ID: "run_683" } },
        {
          onLine: (l) => {
            if (exit) late.push(`line ${l.display?.tag ?? ""}`);
            lines.push(l);
          },
          onPhase: (name) => {
            if (exit) late.push(`phase ${name}`);
          },
          onExit: (e) => (exit = e),
        },
      );
      return {
        h,
        handle,
        lines,
        late,
        exit: () => exit,
        aborted: () => signal?.aborted,
        interrupts: () => interrupts,
        /** Ruling 174: the stop reached the CLI's whole group. */
        groupSignalled: () => h.signals.some(([pid, sig]) => pid === -CLI_PID && sig === "SIGTERM"),
      };
    }

    it.each([
      ["closes on its own 4 s after it", "closes"],
      ["stays open until the abort ends its stream, as the SDK's does", "throws"],
      ["stays open even past the abort", "hangs"],
    ] as const)("a successful result, and a CLI that %s: the CLI gets 5 s from the result and the run settles `finished`", async (_, ending) => {
      // CANARY: drop `armResultGrace()` and the run settles idle_timeout;
      // settle at the result itself and the run has exited before the late
      // line arrives; skip `stoppedAfterResult` in the catch and a transport
      // line reports a drop that was Viberr's own stop; let a late line re-arm
      // the idle guard and the short window settles idle_timeout; extend the
      // grace on each line and a chatty CLI is never stopped; a grace of 4 s
      // or less stops the CLI that was closing, and one past 6 s has not
      // stopped the others when checked.
      // The result, then a line every second until the CLI closes or the
      // abort lands.
      const run = startOnOpenCli([[0, INIT], [0, SUCCESS], ...(ending === "closes" ? CHATTER.slice(0, 4) : CHATTER)], ending);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(run.exit()).toBeNull();
      expect(run.aborted()).toBe(false);
      expect(run.lines.map((l) => JSON.parse(l.raw).type)).toEqual(["system", "result", "rate_limit_event"]);

      // 6 s after the result: a CLI still open has been stopped, and one
      // that closed inside the grace never was.
      await vi.advanceTimersByTimeAsync(5_000);
      const stopped = ending !== "closes";
      expect(run.aborted()).toBe(stopped);
      expect(run.groupSignalled()).toBe(stopped);

      await vi.advanceTimersByTimeAsync(A_MINUTE);
      expect(run.exit()).toMatchObject({ outcome: "finished", sessionId: "s-683" });
      // Nothing but the CLI's own lines: no err line, no transport line.
      expect(new Set(run.lines.map((l) => l.raw && JSON.parse(l.raw).type))).toEqual(
        new Set(["system", "result", "rate_limit_event"]),
      );
      // Ruling 174: the settle sweep takes what the run left running.
      expect(run.h.reaped).toEqual([{ runIds: ["run_683"], groupLeader: CLI_PID }]);
    });

    it.each([
      ["a cut-off (ruling 175), and a CLI that throws on the abort", [[0, MAX_TURNS]], "throws", "error", ["run·error·max_turns"]],
      ["a failure only its words name, and a CLI that throws on the abort", [[0, QUOTA]], "throws", "error", ["run·error·quota"]],
      ["a success, that failure 2 s later, and a CLI that throws on the abort", [[0, SUCCESS], [2_000, QUOTA]], "throws", "error", ["run·error·quota"]],
      ["that failure, a success 2 s later, and a CLI that throws on the abort", [[0, QUOTA], [2_000, SUCCESS]], "throws", "finished", []],
      ["a cut-off, and a CLI whose stream ends 30 s after the abort", [[0, MAX_TURNS]], "ends-late", "error", ["run·error·max_turns"]],
      ["a cut-off, and a CLI whose stream throws 30 s after the abort", [[0, MAX_TURNS]], "throws-late", "error", ["run·error·max_turns"]],
    ] as const)("%s: the CLI gets 5 s from the first result, and the run settles from the last one, once", async (_, results, ending, outcome, tags) => {
      // CANARY: arm the grace for a successful result only and every row but
      // the third settles idle_timeout; skip `stoppedAfterResult` in the
      // catch and the failure is classified from the abort's throw (`unknown`)
      // and the late throw writes the cut-off a second time; settle from the
      // first result and the third row is `finished` and the fourth `error`;
      // keep an error result once a later success has come and the fourth row
      // is `error`; drop the settle-once check from `settleEnded` and the late
      // throw writes a second cut-off line; drop the `settled` check before
      // the Finishing phase and the late end puts that phase on a settled run.
      const run = startOnOpenCli([[0, INIT], ...results], ending);

      await vi.advanceTimersByTimeAsync(4_000);
      expect(run.exit()).toBeNull();
      expect(run.aborted()).toBe(false);

      await vi.advanceTimersByTimeAsync(2_000);
      expect(run.aborted()).toBe(true);
      expect(run.groupSignalled()).toBe(true);

      // 16 s: settled by the abort's throw, or by the backstop 10 s after it.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(run.exit()).toMatchObject({ outcome, sessionId: "s-683" });

      // A late end or throw has come and gone, and added nothing.
      await vi.advanceTimersByTimeAsync(A_MINUTE);
      const viberrLines = run.lines.filter((l) => (l.display?.tag ?? "").startsWith("run·"));
      expect(viberrLines.map((l) => l.display?.tag)).toEqual(tags);
      expect(run.late).toEqual([]);
      expect(run.h.reaped).toEqual([{ runIds: ["run_683"], groupLeader: CLI_PID }]);
    });

    it("a Stop pressed inside the grace asks the CLI to stop and keeps the grace's clock: the CLI is stopped 5 s after the result and the run settles `interrupted`", async () => {
      // CANARY: let the Stop arm the 20 s cooperative window in place of the
      // grace and the CLI is still running 6 s after the result; abort on the
      // Stop itself and the CLI is stopped 1 s after the result, with no time
      // to answer the request; skip the cooperative request inside the grace
      // and the CLI is never asked.
      const run = startOnOpenCli([[0, INIT], [0, SUCCESS], ...CHATTER], "throws");
      await vi.advanceTimersByTimeAsync(1_000);
      run.handle.interrupt();
      expect(run.interrupts()).toBe(1);

      // 4 s after the result the CLI may still stop on its own.
      await vi.advanceTimersByTimeAsync(3_000);
      expect(run.aborted()).toBe(false);
      expect(run.exit()).toBeNull();

      await vi.advanceTimersByTimeAsync(2_000);
      expect(run.aborted()).toBe(true);
      expect(run.groupSignalled()).toBe(true);
      expect(run.exit()).toMatchObject({ outcome: "interrupted", sessionId: "s-683" });
    });
  });

  it("classifies a CLI exit by the stderr the SDK no longer sees: a vanished resume session is `session_missing`", async () => {
    // With the SDK's own spawn, the exit error read "…exited with code 1.
    // stderr: No conversation found…", and the classifier routed it to
    // session_missing. A custom spawn leaves the SDK blind to stderr; the
    // adapter restores the same sentence from the tail it kept.
    const classify = async (stderr: string | null) => {
      const h = harness();
      const adapter = createClaudeAdapter({
        ...h.deps,
        queryFn: ({ options }) => {
          h.spawnThrough(options);
          const gen = (async function* () {
            if (stderr) h.child.stderr.write(stderr);
            await new Promise((r) => setImmediate(r));
            h.exitCli(1);
            // A stream that fails without a message: it yields nothing.
            const none: never[] = [];
            yield* none;
            throw new Error("Claude Code process exited with code 1");
          })();
          return Object.assign(gen, { interrupt: async () => {} });
        },
      });
      const lines: EmittedLine[] = [];
      adapter.start(
        { ...SPEC, resumeSessionId: "s-gone" },
        { onLine: (l) => lines.push(l), onExit: () => {} },
      );
      await drain();
      await drain();
      return lines.find((l) => (l.display?.tag ?? "").startsWith("run·error·"))?.display?.tag;
    };

    expect(await classify("No conversation found with session ID: s-gone\n")).toBe(
      "run·error·session_missing",
    );
    // Control: the same exit with nothing on stderr is not a missing session.
    expect(await classify(null)).not.toBe("run·error·session_missing");
  });
});

/**
 * Ruling 175: the instance's spending cap reaches the SDK as `maxBudgetUsd`,
 * and the SDK's `error_max_budget_usd` result is the `max_budget` cut-off —
 * a typed record carrying the cap and the spend, so the packet names both.
 */
describe("claude spending cap (ruling 175)", () => {
  async function optionsFor(spec: RunSpec): Promise<ClaudeQueryOptions> {
    let captured: ClaudeQueryOptions | undefined;
    const adapter = createClaudeAdapter({
      queryFn: ({ options }) => {
        captured = options;
        return fakeQuery([{ type: "result", subtype: "success", is_error: false, num_turns: 1, usage: {} }]).q;
      },
    });
    adapter.start(spec, { onLine: () => {}, onExit: () => {} });
    await drain();
    return captured ?? {};
  }

  it("passes the cap as maxBudgetUsd when the run carries one, and names none otherwise", async () => {
    expect((await optionsFor({ ...SPEC, maxSpendUsd: 2.5 })).maxBudgetUsd).toBe(2.5);
    expect(await optionsFor(SPEC)).not.toHaveProperty("maxBudgetUsd");
  });

  it("an `error_max_budget_usd` result is the `max_budget` cut-off, carrying the cap and the spend", async () => {
    // Canary: drop the branch and the run ends `run·error·unknown` with the
    // generic "review the runtime" copy — a cap reads as a broken setup.
    const lines: EmittedLine[] = [];
    let exit: RunExit | null = null;
    const adapter = createClaudeAdapter({
      queryFn: () =>
        fakeQuery([
          { type: "system", subtype: "init", session_id: "s-b", model: "claude-opus-4-8", tools: [], mcp_servers: [] },
          {
            type: "result",
            subtype: "error_max_budget_usd",
            is_error: true,
            num_turns: 7,
            usage: { input_tokens: 5, output_tokens: 10 },
            total_cost_usd: 0.51,
            modelUsage: {
              "claude-opus-4-8": { inputTokens: 5, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.51 },
            },
          },
        ]).q,
    });
    adapter.start({ ...SPEC, maxSpendUsd: 0.5 }, { onLine: (l) => lines.push(l), onExit: (e) => (exit = e) });
    await drain();

    const terminal = lines.find((l) => (l.display?.tag ?? "").startsWith("run·error·"));
    expect(terminal?.display?.tag).toBe("run·error·max_budget");
    expect(terminal?.display?.failure).toMatchObject({ kind: "max_budget", spendCapUsd: 0.5, spentUsd: 0.51 });
    expect(terminal?.display?.text).toContain("its $0.50 spending cap after spending $0.51");
    expect(terminal?.display?.text).toContain("Instance settings (Max spend per Claude run)");
    expect(exit).toMatchObject({ outcome: "error", sessionId: "s-b" });
  });
});

/**
 * Measured live (2026-09-11, the ruling-175 canary): the pinned SDK yields an
 * error result and THEN throws — the CLI exits non-zero after it, and
 * `readMessages` swaps that exit error for "Claude Code returned an error
 * result: <text>". The catch used to classify the throw, so a spending-cap
 * cut-off ended `run·error·unknown` ("review the runtime configuration"), and
 * so did the turn cap. The result is the truth for a cut-off.
 */
describe("a cut-off result followed by the SDK's throw stays a cut-off", () => {
  function resultThenThrow(result: Record<string, JsonValue>, thrown: string): ClaudeQuery {
    const gen = (async function* () {
      yield { type: "system", subtype: "init", session_id: "s-t", model: "claude-haiku-4-5", tools: [], mcp_servers: [] };
      yield result;
      throw new Error(`Claude Code returned an error result: ${thrown}`);
    })();
    return Object.assign(gen, { interrupt: async () => {} });
  }

  async function terminalTag(spec: RunSpec, q: ClaudeQuery): Promise<EmittedLine | undefined> {
    const lines: EmittedLine[] = [];
    createClaudeAdapter({ queryFn: () => q }).start(spec, { onLine: (l) => lines.push(l), onExit: () => {} });
    await drain();
    await drain();
    return lines.find((l) => (l.display?.tag ?? "").startsWith("run·error·"));
  }

  it("the spending cap: `max_budget` with the cap and the spend, as the live run produced it", async () => {
    // Canary: drop the `emitCutOff` arm from the catch and this reads
    // `run·error·unknown` — exactly what the live canary showed.
    const line = await terminalTag(
      { ...SPEC, maxSpendUsd: 0.01 },
      resultThenThrow(
        {
          type: "result",
          subtype: "error_max_budget_usd",
          is_error: true,
          num_turns: 1,
          usage: { input_tokens: 5160, output_tokens: 148 },
          total_cost_usd: 0.010119,
          terminal_reason: "budget_exhausted",
          modelUsage: {
            "claude-haiku-4-5-20251001": { inputTokens: 5160, outputTokens: 148, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.010119 },
          },
        },
        "Reached maximum budget ($0.01)",
      ),
    );
    expect(line?.display?.tag).toBe("run·error·max_budget");
    expect(line?.display?.failure).toMatchObject({ kind: "max_budget", spendCapUsd: 0.01, spentUsd: 0.010119 });
  });

  it("the turn cap: `max_turns`, not `unknown`", async () => {
    const line = await terminalTag(
      SPEC,
      resultThenThrow(
        { type: "result", subtype: "error_max_turns", is_error: true, num_turns: 2000, usage: {} },
        "Reached maximum number of turns (2000)",
      ),
    );
    expect(line?.display?.tag).toBe("run·error·max_turns");
  });

  it("any other error result that ends in a throw is still classified from the throw", async () => {
    const line = await terminalTag(
      SPEC,
      resultThenThrow(
        { type: "result", subtype: "error_during_execution", is_error: true, num_turns: 1, usage: {} },
        "API Error: 529 Overloaded",
      ),
    );
    expect(line?.display?.tag).toBe("run·error·overloaded");
  });
});

/**
 * Ruling 101(e), amended by Option D PR 5: argument-level denies carry a
 * model-visible reason and cover wrapped command shapes; the denylist remains
 * the fence. Measured live on 2026-09-11 (the PR's spike): the hook ran before
 * the rules, its reason came back as the tool result, and every wrapped push
 * shape was refused, where without it `git -C . push` and `sh -c 'git push'`
 * both landed on a local remote.
 */
describe("the PreToolUse capability hook (ruling 101(e), Option D PR 5)", () => {
  const RESULT = [{ type: "result", subtype: "success", is_error: false, num_turns: 1, usage: {} }];
  /** A Developer whose commit-push grant is withheld, as the resolver denies it. */
  const PUSH_WITHHELD = resolveSpecialistDisallowedTools([
    { capabilityId: "execute-code-or-write-repo", mode: "direct" },
    { capabilityId: "create-task-branch", mode: "direct" },
    { capabilityId: "commit-push-branch", mode: "off" },
    { capabilityId: "open-review-pr", mode: "off" },
  ]);

  async function started(spec: RunSpec) {
    const lines: EmittedLine[] = [];
    let options: ClaudeQueryOptions = {};
    const queryFn: ClaudeQueryFn = (params) => {
      options = params.options ?? {};
      return fakeQuery(RESULT).q;
    };
    createClaudeAdapter({ queryFn }).start(spec, { onLine: (l) => lines.push(l), onExit: () => {} });
    await drain();
    return { options, lines };
  }

  const hookOf = (options: ClaudeQueryOptions): ClaudePreToolUseHook | undefined =>
    options.hooks?.PreToolUse?.find((m) => m.matcher === "Bash")?.hooks[0];

  const bash = (hook: ClaudePreToolUseHook, command: string) =>
    hook({ hook_event_name: "PreToolUse", tool_input: { command } }, "toolu_1", {
      signal: new AbortController().signal,
    });

  it("is installed only on a run with argument-level denies whose Bash is not denied outright", async () => {
    // Canary: drop the `bashPrefixes.length` guard and the plain run grows a hook.
    expect(hookOf((await started({ ...SPEC, disallowedTools: PUSH_WITHHELD })).options)).toBeDefined();
    // Ruling 371: every run carries the PreCompact observer, so the absence
    // under test is the PreToolUse matcher's, not the whole hooks map's.
    expect((await started(SPEC)).options.hooks?.PreToolUse).toBeUndefined();
    // The operator's Bash is denied outright: nothing for a hook to add.
    expect((await started({ ...SPEC, kind: "operator" })).options.hooks?.PreToolUse).toBeUndefined();
    // A supporting run carries the kind-based delivery denies even with no grant denies.
    expect(hookOf((await started({ ...SPEC, kind: "reviewer" })).options)).toBeDefined();
  });

  it("refuses the wrapped shapes with a reason naming the capability, and writes the console line", async () => {
    // Canary: return `{}` from the hook and both expectations on the answer fail.
    const { options, lines } = await started({ ...SPEC, disallowedTools: PUSH_WITHHELD });
    const hook = hookOf(options)!;
    for (const command of [
      "git -C . push origin HEAD:refs/heads/x",
      "sh -c 'git push origin main'",
      "cd repo && git push",
    ]) {
      const answer = await bash(hook, command);
      expect(answer.hookSpecificOutput?.permissionDecision, command).toBe("deny");
      expect(answer.hookSpecificOutput?.permissionDecisionReason, command).toBe(
        'Withheld by capability policy: "Commit & push to the branch" (commit-push-branch) is not granted on this run, so `git push` is refused however it is wrapped. Say what you needed in your report instead.',
      );
    }
    const denials = lines.filter((l) => l.display?.tag === "permission_denied");
    expect(denials).toHaveLength(3);
    expect(denials[0]!.display).toMatchObject({
      ev: "err",
      name: "Bash",
      text: expect.stringMatching(/^denied by hook: Withheld by capability policy/),
    });
    // Viberr's own frame, told apart from the SDK's.
    expect(JSON.parse(denials[0]!.raw)).toMatchObject({ source: "viberr", subtype: "permission_denied" });

    // A command that reaches no denied prefix is left to the mode and the rules.
    expect(await bash(hook, "npm test && git status")).toEqual({});
    expect(lines.filter((l) => l.display?.tag === "permission_denied")).toHaveLength(3);
  });

  it("names the supporting-run delivery deny when no capability explains it", async () => {
    const { options } = await started({ ...SPEC, kind: "reviewer" });
    const answer = await bash(hookOf(options)!, "git -C . push");
    expect(answer.hookSpecificOutput?.permissionDecisionReason).toBe(
      "A supporting engagement never delivers: `git push` belongs to the delivering agent and Viberr's server. Say what should be delivered in your report instead.",
    );
  });
});

/**
 * Ruling 564: a run that posts files keeps its file tools, confined by a
 * PreToolUse hook to the attachments folder and the temp directory. Live on
 * AWSC-4..7 every Claude run of the AWS calculator board read "No such tool
 * available: Write" and wrote its deliverable through a shell heredoc. The
 * folder and checkout below do not exist: the hook decides on the path, so a
 * directory outside the temp root needs no disk.
 */
describe("Claude Code's auto-memory (ruling 577)", () => {
  it("is off on every run, over the base env and the run's own", async () => {
    // Live on 2026-09-28, 13 of 138 Claude runs spent turns writing notes
    // into the account home's auto-memory, where ruling 564's hook refuses
    // every write. CANARY: drop the switch from the run env and this goes red.
    const RESULT = [{ type: "result", subtype: "success", is_error: false, num_turns: 1, usage: {} }];
    for (const spec of [SPEC, { ...SPEC, kind: "operator" as const }]) {
      let options: ClaudeQueryOptions = {};
      const queryFn: ClaudeQueryFn = (params) => {
        options = params.options ?? {};
        return fakeQuery(RESULT).q;
      };
      createClaudeAdapter({ queryFn, env: { PATH: "/usr/bin", [AUTO_MEMORY_OFF_ENV]: "0" } }).start(
        { ...spec, env: { VIBERR_RUN_ID: "r1" } },
        { onLine: () => {}, onExit: () => {} },
      );
      await drain();
      expect(options.env?.[AUTO_MEMORY_OFF_ENV]).toBe("1");
      expect(options.env?.PATH).toBe("/usr/bin");
      expect(options.env?.VIBERR_RUN_ID).toBe("r1");
    }
  });
});

describe("the file tools of a run that posts files (ruling 564)", () => {
  const RESULT = [{ type: "result", subtype: "success", is_error: false, num_turns: 1, usage: {} }];
  /** A result-maker as the resolver denies it: evidence granted, repo-write withheld. */
  const WRITE_WITHHELD = resolveSpecialistDisallowedTools([
    { capabilityId: "attach-evidence-references", mode: "direct" },
  ]);
  const DROP = "/srv/vib564/tasks/VIB-1/attachments";
  const CHECKOUT = "/srv/vib564/tasks/VIB-1/workspace/repo";
  const POSTS_FILES: RunSpec = {
    ...SPEC,
    disallowedTools: WRITE_WITHHELD,
    attachmentsWritableDir: DROP,
  };

  async function started(spec: RunSpec) {
    const lines: EmittedLine[] = [];
    let options: ClaudeQueryOptions = {};
    const queryFn: ClaudeQueryFn = (params) => {
      options = params.options ?? {};
      return fakeQuery(RESULT).q;
    };
    createClaudeAdapter({ queryFn }).start(spec, { onLine: (l) => lines.push(l), onExit: () => {} });
    await drain();
    return { options, lines };
  }

  const fileHookOf = (options: ClaudeQueryOptions): ClaudePreToolUseHook | undefined =>
    options.hooks?.PreToolUse?.find((m) => m.matcher === "Edit|MultiEdit|Write")?.hooks[0];

  const call = (hook: ClaudePreToolUseHook, tool: string, filePath: string) =>
    hook(
      { hook_event_name: "PreToolUse", tool_name: tool, tool_input: { file_path: filePath } },
      "toolu_1",
      { signal: new AbortController().signal },
    );

  it("keeps Edit, MultiEdit and Write on the run, confined, and still denies NotebookEdit", async () => {
    // Canary: hand the SDK `denied` instead of `sdkDenied` and the three stay denied.
    const { options } = await started(POSTS_FILES);
    expect(options.disallowedTools).not.toEqual(expect.arrayContaining(["Write"]));
    expect(options.disallowedTools).not.toEqual(expect.arrayContaining(["Edit"]));
    expect(options.disallowedTools).not.toEqual(expect.arrayContaining(["MultiEdit"]));
    expect(options.disallowedTools).toEqual(
      expect.arrayContaining(["NotebookEdit", "Bash(git commit:*)"]),
    );
    expect(fileHookOf(options)).toBeDefined();
  });

  it("writes the attachments folder and the temp directory, and refuses everything else with a reason", async () => {
    // Canary: return `{}` from the file hook and every refusal below passes through.
    const { options, lines } = await started(POSTS_FILES);
    const hook = fileHookOf(options)!;
    for (const [tool, filePath] of [
      ["Write", `${DROP}/mapping.md`],
      ["Edit", `${DROP}/estimate/summary.md`],
      ["MultiEdit", `${DROP}/assumptions.md`],
      ["Write", path.join(tmpdir(), "vib564", "scratch.mjs")],
      // The temp root spelled through its symlink (macOS: /var → /private/var)
      // is the same directory. Canary: compare without `realpathSync`.
      ["Write", path.join(realpathSync(tmpdir()), "vib564.md")],
    ] as const) {
      expect(await call(hook, tool, filePath), filePath).toEqual({});
    }
    for (const filePath of [
      `${CHECKOUT}/mapping.md`,
      `${DROP}/../task.md`,
      `${DROP}-evil/mapping.md`,
      DROP,
      "mapping.md",
    ]) {
      const answer = await call(hook, "Write", filePath);
      expect(answer.hookSpecificOutput?.permissionDecision, filePath).toBe("deny");
    }
    expect((await call(hook, "Edit", `${CHECKOUT}/mapping.md`)).hookSpecificOutput?.permissionDecisionReason).toBe(
      'Withheld by capability policy: "Write to the repository" (execute-code-or-write-repo) ' +
        `is not granted on this run, so Edit writes only into the task's attachments folder \`${DROP}\`, ` +
        `where the files you post on the task go, and \`${tmpdir()}\` for scratch. ` +
        `\`${CHECKOUT}/mapping.md\` is outside both: write the file there by its absolute path, and ` +
        "leave everything else as it is. This confines Edit, MultiEdit and Write and nothing else: " +
        "your shell still runs commands.",
    );
    const denials = lines.filter((l) => l.display?.tag === "permission_denied");
    expect(denials).toHaveLength(6);
    expect(denials[5]!.display).toMatchObject({ ev: "err", name: "Edit" });
    // A tool the matcher should never have sent is left alone.
    expect(await call(hook, "Read", `${CHECKOUT}/mapping.md`)).toEqual({});
  });

  it("changes nothing without a folder, with repo-write granted, or on an operator", async () => {
    // No attachments folder: the grants' deny stands and no hook is added.
    const noDrop = (await started({ ...SPEC, disallowedTools: WRITE_WITHHELD })).options;
    expect(noDrop.disallowedTools).toEqual(expect.arrayContaining(["Write", "Edit", "MultiEdit"]));
    expect(fileHookOf(noDrop)).toBeUndefined();
    // Repo-write granted: the tools were never denied, so nothing confines them.
    const writer = (
      await started({
        ...POSTS_FILES,
        disallowedTools: resolveSpecialistDisallowedTools([
          { capabilityId: "execute-code-or-write-repo", mode: "direct" },
          { capabilityId: "attach-evidence-references", mode: "direct" },
        ]),
      })
    ).options;
    expect(fileHookOf(writer)).toBeUndefined();
    // Canary: drop the kind check and the operator's own Write deny is stripped.
    const operator = (await started({ ...POSTS_FILES, kind: "operator" })).options;
    expect(operator.disallowedTools).toEqual(expect.arrayContaining(["Write", "Edit"]));
    expect(fileHookOf(operator)).toBeUndefined();
  });

  it("still names the withheld repo-write grant when git commit is refused", async () => {
    // Canary: name Bash refusals from `sdkDenied` and the repo-write grant
    // leaves the sentence (its rule no longer reads as wholly withheld).
    const { options } = await started(POSTS_FILES);
    const bashHook = options.hooks?.PreToolUse?.find((m) => m.matcher === "Bash")?.hooks[0];
    const answer = await bashHook!(
      { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git commit -m x" } },
      "toolu_2",
      { signal: new AbortController().signal },
    );
    expect(answer.hookSpecificOutput?.permissionDecisionReason).toContain(
      '"Write to the repository" (execute-code-or-write-repo)',
    );
  });
});

/**
 * Rulings 370, 371 and 373: how each kind's prompt reaches the SDK, what the
 * run is handed back after a compaction, and the byte-stability of every
 * list the adapter sends. Driven through the real adapter with a fake query,
 * so what is asserted is exactly what the SDK was handed.
 */
describe("prompt forms, compaction hooks and sorted lists (rulings 370/371/373)", () => {
  const RESULT = [{ type: "result", subtype: "success", is_error: false, num_turns: 1, usage: {} }];
  const PREFIX = { static: ["# Persona\n", "# Skills\n"], dynamic: ["\n# This task\n"] };

  async function sent(spec: RunSpec, messages: unknown[] = RESULT) {
    let options: ClaudeQueryOptions = {};
    let promptSeen = "";
    const phases: (string | null)[] = [];
    const lines: EmittedLine[] = [];
    const queryFn: ClaudeQueryFn = (params) => {
      options = params.options ?? {};
      void (async () => {
        const plain = z.string().safeParse(params.prompt);
        if (plain.success) {
          promptSeen = plain.data;
          return;
        }
        // SAFETY: the adapter's only prompt shape is `singlePrompt`, an async
        // iterable of one SDK user message; a string was ruled out just above.
        for await (const m of params.prompt as AsyncIterable<unknown>) {
          promptSeen = z.object({ message: z.object({ content: z.string() }) }).parse(m).message.content;
        }
      })();
      return fakeQuery(messages).q;
    };
    createClaudeAdapter({ queryFn }).start(spec, {
      onLine: (l) => lines.push(l),
      onExit: () => {},
      onPhase: (phase) => phases.push(phase),
    });
    await drain();
    return { options, prompt: promptSeen, phases, lines };
  }

  it("a specialist gets the preset with the static block appended, dynamic sections excluded and the prompt recorded; the dynamic tail opens its first message", async () => {
    const { options, prompt } = await sent({ ...SPEC, systemPrompt: PREFIX });
    expect(options.systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
      append: "# Persona\n# Skills\n",
      excludeDynamicSections: true,
      snapshot: true,
    });
    // Canary: drop `withDynamicTail` and the task section is nowhere.
    expect(prompt).toContain("# This run's context (Viberr, this run only)");
    expect(prompt).toContain("# This task");
    expect(prompt.endsWith("do the thing")).toBe(true);
    expect(prompt.indexOf("# This task")).toBeLessThan(prompt.indexOf("do the thing"));
  });

  it("a specialist with a plain-string persona keeps the same preset shape and an untouched prompt", async () => {
    const { options, prompt } = await sent({ ...SPEC, systemPrompt: "You are the Developer." });
    expect(options.systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
      append: "You are the Developer.",
      excludeDynamicSections: true,
      snapshot: true,
    });
    expect(prompt).toBe("do the thing");
  });

  it("the operator gets the static block, the SDK's boundary, then the dynamic block, as a string array", async () => {
    const { options, prompt } = await sent({ ...SPEC, kind: "operator", systemPrompt: PREFIX });
    expect(options.systemPrompt).toEqual([
      "# Persona\n",
      "# Skills\n",
      "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__",
      "\n# This task\n",
    ]);
    expect(prompt).toBe("do the thing");
    // A plain string stays a plain string: nothing invents a boundary.
    expect((await sent({ ...SPEC, kind: "operator", systemPrompt: "op" })).options.systemPrompt).toBe("op");
  });

  it("the controller gets the same blocks as a RECORDED custom prompt", async () => {
    const { options } = await sent({ ...SPEC, kind: "controller", systemPrompt: PREFIX });
    expect(options.systemPrompt).toEqual({
      type: "custom",
      prompt: ["# Persona\n", "# Skills\n", "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__", "\n# This task\n"],
      snapshot: true,
    });
  });

  it("a run with an anchor carries a SessionStart hook on the compact source that hands it back", async () => {
    const { options } = await sent({ ...SPEC, systemPrompt: PREFIX, compactAnchor: "# Context compacted\nTask VIB-1" });
    const matcher = options.hooks?.SessionStart?.[0];
    expect(matcher?.matcher).toBe("compact");
    const answer = await matcher!.hooks[0]!(
      { hook_event_name: "SessionStart", source: "compact" },
      undefined,
      { signal: new AbortController().signal },
    );
    expect(answer).toEqual({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "# Context compacted\nTask VIB-1" },
    });
    // No anchor, no hook: nothing is pinned that the caller did not write.
    expect((await sent({ ...SPEC, systemPrompt: PREFIX })).options.hooks?.SessionStart).toBeUndefined();
  });

  it("every run carries a PreCompact observer that names the wait on the strip", async () => {
    const { options, phases } = await sent(SPEC);
    const hook = options.hooks?.PreCompact?.[0]?.hooks[0];
    expect(hook).toBeDefined();
    await hook!({ hook_event_name: "PreCompact", trigger: "auto" }, undefined, {
      signal: new AbortController().signal,
    });
    expect(phases).toContain(RUN_PHASE.compacting);
  });

  it("ruling 527: a steered run hands the model what waits after each tool batch, logs it, and closes when the model stops", async () => {
    const text = "selin@viberr.dev sent this while you were working on this turn.\n\nThe KB is gone too.";
    const waiting = [{ text, count: 1 }];
    let closes = 0;
    const steering: RunSteering = {
      take: () => waiting.shift() ?? null,
      close: () => {
        closes += 1;
      },
    };
    const { options, lines } = await sent({ ...SPEC, kind: "controller", steering });
    const signal = { signal: new AbortController().signal };
    const deliver = options.hooks?.PostToolBatch?.[0]?.hooks[0];
    // CANARY: drop the hook's `additionalContext` and the model never reads
    // the message the host has already marked steered.
    expect(await deliver!({ hook_event_name: "PostToolBatch" }, undefined, signal)).toEqual({
      hookSpecificOutput: { hookEventName: "PostToolBatch", additionalContext: text },
    });
    // The SDK echoes nothing for a hook's context, so the console says where it went in.
    expect(lines.at(-1)?.display).toMatchObject({
      ev: "meta",
      tag: "run·steered",
      text: "1 new message from the person went into this turn here",
    });
    // Nothing waiting: the boundary adds nothing, and logs nothing.
    const logged = lines.length;
    expect(await deliver!({ hook_event_name: "PostToolBatch" }, undefined, signal)).toEqual({});
    expect(lines).toHaveLength(logged);
    // CANARY: drop the `Stop` hook and a message sent during the final answer
    // waits on a turn that will never read it.
    await options.hooks?.Stop?.[0]?.hooks[0]!({ hook_event_name: "Stop" }, undefined, signal);
    expect(closes).toBe(1);
    // A run with no steering carries neither hook.
    const plain = await sent({ ...SPEC, kind: "controller" });
    expect(plain.options.hooks?.PostToolBatch).toBeUndefined();
    expect(plain.options.hooks?.Stop).toBeUndefined();
  });

  it("skills, servers, the approval list and the denylist reach the SDK in name order, deduplicated", async () => {
    const plugin = temp.make("viberr-sorted-");
    for (const name of ["zeta", "alpha"]) {
      mkdirSync(path.join(plugin, "skills", name), { recursive: true });
      writeFileSync(path.join(plugin, "skills", name, "SKILL.md"), `---\nname: ${name}\n---\nbody\n`);
    }
    mkdirSync(path.join(plugin, ".claude-plugin"), { recursive: true });
    writeFileSync(path.join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "viberr" }));
    const { options } = await sent({
      ...SPEC,
      skills: ["zeta", "alpha"],
      skillPlugin: { path: plugin, name: "viberr" },
      mcpServers: { zulu: { type: "http", url: "https://z" }, alpha: { type: "http", url: "https://a" } },
      allowedTools: ["mcp__zulu", "mcp__alpha", "mcp__alpha"],
      disallowedTools: ["Write", "Edit", "Write"],
    });
    expect(options.skills).toEqual(["viberr:alpha", "viberr:zeta"]);
    expect(Object.keys(options.mcpServers ?? {})).toEqual(["alpha", "zulu"]);
    expect(options.allowedTools).toEqual(["mcp__alpha", "mcp__zulu"]);
    const denied = options.disallowedTools ?? [];
    expect(denied).toEqual([...denied].sort());
    expect(denied.filter((t) => t === "Write")).toHaveLength(1);
  });

  it("keeps one cache fact per API message: a message's repeat envelopes are stripped before the sink", async () => {
    const usage = { input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: 900 };
    const { lines } = await sent(SPEC, [
      { type: "assistant", parent_tool_use_id: null, message: { id: "msg_a", content: [{ type: "text", text: "one" }], usage } },
      { type: "assistant", parent_tool_use_id: null, message: { id: "msg_a", content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }], usage } },
      { type: "assistant", parent_tool_use_id: null, message: { id: "msg_b", content: [{ type: "text", text: "two" }], usage } },
      ...RESULT,
    ]);
    const facts = lines.filter((l) => l.facts.cache).map((l) => l.facts.cache!.messageId);
    expect(facts).toEqual(["msg_a", "msg_b"]);
    // …and the live prompt sum counts each message once.
    const live = lines
      .filter((l) => l.facts.usage?.outputEstimated)
      .map((l) => l.facts.usage!.input_tokens);
    expect(live.at(-1)).toBe(2 * 1002);
  });
});

/**
 * Ruling 376: the completion compaction. `/compact` on the run's own session,
 * built from the run's spec so the request shares its prefix, folded as the
 * run's own compaction fact and cost increment, refusals as reasons.
 */
describe("claude adapter compact() (ruling 376)", () => {
  const promptMessage = z.object({ message: z.object({ content: z.string() }) });
  /** The adapter hands the SDK an async iterable of one user message; this
   *  reads that one message's text back. */
  const readPrompt = async (prompt: Parameters<ClaudeQueryFn>[0]["prompt"]): Promise<string> => {
    const literal = z.string().safeParse(prompt);
    if (literal.success) return literal.data;
    // SAFETY: the adapter never hands the SDK a string (`singlePrompt` wraps
    // every prompt in an async iterable of one user message), and the string
    // arm above returned; what is left is that iterable.
    for await (const message of prompt as AsyncIterable<unknown>) {
      return promptMessage.parse(message).message.content;
    }
    return "";
  };

  it("resumes the session with the run's options, one turn, and folds the boundary as this run's completion compaction", async () => {
    const messages = [
      { type: "system", subtype: "init", session_id: "sess-1", model: "claude-sonnet-4-5", tools: ["Bash"], mcp_servers: [] },
      { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual", pre_tokens: 120_000, post_tokens: 18_000 } },
      { type: "user", message: { role: "user", content: "This session is being continued from a previous conversation…" } },
      { type: "result", subtype: "success", is_error: false, num_turns: 1, usage: { input_tokens: 2_000, cache_read_input_tokens: 118_000, output_tokens: 4_000 }, total_cost_usd: 0.7 },
    ];
    const { q } = fakeQuery(messages);
    let captured: {
      prompt: Parameters<ClaudeQueryFn>[0]["prompt"];
      options: CapturedOptions & { resume?: string; maxTurns?: number };
    } | null = null;
    const adapter = createClaudeAdapter({
      queryFn: (args) => {
        // SAFETY: the test reads the handful of option fields it asserts on;
        // the adapter's own type is wider and the SDK-typed shape is irrelevant here.
        captured = { prompt: args.prompt, options: (args.options ?? {}) as CapturedOptions & { resume?: string; maxTurns?: number } };
        return q;
      },
    });
    const lines: EmittedLine[] = [];
    const phases: string[] = [];
    const outcome = await adapter.compact!(
      { ...SPEC, env: { VIBERR_RUN_ID: "r1" }, systemPrompt: { static: ["persona"], dynamic: ["tail"] } },
      "sess-1",
      { onLine: (l) => lines.push(l), onPhase: (phase) => phases.push(phase ?? "") },
    );
    expect(outcome).toEqual({ compacted: true, preTokens: 120_000, postTokens: 18_000 });
    expect(captured!.options.resume).toBe("sess-1");
    expect(captured!.options.maxTurns).toBe(1);
    // The epilogue's own marker: the run's settle sweep reaps `r1`, not this.
    expect(captured!.options.env?.VIBERR_RUN_ID).toBe("r1:compaction");
    // Ruling 577: the compaction builds its options as the run did.
    expect(captured!.options.env?.[AUTO_MEMORY_OFF_ENV]).toBe("1");
    // The same system prompt shape the run used: the preset with the static append.
    expect(captured!.options.systemPrompt).toMatchObject({ type: "preset", preset: "claude_code", append: "persona" });
    const prompt = await readPrompt(captured!.prompt);
    expect(prompt.startsWith("/compact ")).toBe(true);
    expect(prompt).toContain("task.md");
    expect(phases[0]).toBe(RUN_PHASE.compacting);
    // Two lines: the boundary as a completion compaction, the request's cost.
    // The init and the summary the CLI writes as a user message stay on the transcript.
    expect(lines.map((l) => l.display?.tag)).toEqual(["run·compacted·completion", "run·compaction·request"]);
    expect(lines[0]!.facts).toEqual({ compaction: { trigger: "completion", preTokens: 120_000, postTokens: 18_000 } });
    expect(lines[0]!.display?.text).toContain("120k → 18k tokens");
    expect(lines[1]!.facts.costAddUsd).toBe(0.7);
    expect(lines[1]!.facts.usageAdd).toMatchObject({ output_tokens: 4_000 });
    expect(lines[1]!.facts.isResult).toBeUndefined();
    expect(lines[1]!.facts.cache).toBeUndefined();
  });

  it("ruling 536: records the compaction's own share when the resumed session reports its totals", async () => {
    // The live controller turn of 2026-09-28: the run's result, then the
    // `/compact` on its resumed session, whose result carried the SESSION's
    // totals (the CLI restores a session's cost state on resume).
    // CANARY: project the compaction's result without the session's totals
    // and the compaction adds $1.98, recording the $1.87 run twice.
    const opus = (inputTokens: number, outputTokens: number, cacheRead: number, cacheWrite: number, costUSD: number) => ({
      "claude-opus-5-5[1m]": {
        inputTokens,
        outputTokens,
        cacheReadInputTokens: cacheRead,
        cacheCreationInputTokens: cacheWrite,
        costUSD,
      },
    });
    const run = fakeQuery([
      { type: "system", subtype: "init", session_id: "sess-536", model: "claude-opus-5-5", tools: [], mcp_servers: [] },
      { type: "result", subtype: "success", is_error: false, num_turns: 60, usage: { input_tokens: 60, output_tokens: 28_716 }, total_cost_usd: 1.8710, modelUsage: opus(60, 28_716, 2_222_775, 106_480, 1.8710) },
    ]);
    const compaction = fakeQuery([
      { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual", pre_tokens: 108_628, post_tokens: 4_166 } },
      { type: "result", subtype: "success", is_error: false, num_turns: 0, usage: { input_tokens: 0, output_tokens: 0 }, total_cost_usd: 1.9779, modelUsage: opus(2_889, 32_390, 2_328_378, 106_679, 1.9779) },
    ]);
    const queries = [run.q, compaction.q];
    const adapter = createClaudeAdapter({ queryFn: () => queries.shift()! });
    const spec = { ...SPEC, runId: "run_536" };
    adapter.start(spec, { onLine: () => {}, onExit: () => {} });
    await drain();
    const lines: EmittedLine[] = [];
    await adapter.compact!(spec, "sess-536", { onLine: (l) => lines.push(l) });
    const request = lines.find((l) => l.display?.tag === "run·compaction·request")!;
    expect(request.facts.costAddUsd).toBeCloseTo(0.1069, 4);
    expect(request.facts.usageAdd).toEqual({
      input_tokens: 2_889 + 2_328_378 + 106_679 - (60 + 2_222_775 + 106_480),
      cached_input_tokens: 2_328_378 - 2_222_775,
      output_tokens: 32_390 - 28_716,
    });
    expect(request.display?.text).toBe("compaction request · $0.11 · 109k in (cached 106k), 4k out");
  });

  it("ruling 542: a resumed run records its own share, and its spending cap starts from what the session had spent", async () => {
    // The live controller of 2026-09-28: its second turn, resumed on the same
    // session, reported "$2.51 · in 2627.6k · out 35.2k" where its own four
    // calls read 188k tokens in, because the CLI restores a session's cost
    // state on resume.
    // CANARY: project the resumed result without the session's totals
    // (`projectEnvelope(..., null)`) and the turn records the first one again.
    resetSessionTotalsForTests();
    const opus = (inputTokens: number, outputTokens: number, cacheRead: number, cacheWrite: number, costUSD: number) => ({
      "claude-opus-5-5[1m]": { inputTokens, outputTokens, cacheReadInputTokens: cacheRead, cacheCreationInputTokens: cacheWrite, costUSD },
    });
    const first = fakeQuery([
      { type: "system", subtype: "init", session_id: "sess-542", model: "claude-opus-5-5", tools: [], mcp_servers: [] },
      { type: "result", subtype: "success", is_error: false, num_turns: 60, duration_ms: 331_000, usage: { input_tokens: 60, output_tokens: 28_716 }, total_cost_usd: 1.9779, modelUsage: opus(2_889, 32_390, 2_328_378, 106_679, 1.9779) },
    ]);
    const second = fakeQuery([
      { type: "system", subtype: "init", session_id: "sess-542", model: "claude-opus-5-5", tools: [], mcp_servers: [] },
      { type: "result", subtype: "success", is_error: false, num_turns: 8, duration_ms: 29_000, usage: { input_tokens: 8, cache_read_input_tokens: 132_029, cache_creation_input_tokens: 56_088, output_tokens: 2_757 }, total_cost_usd: 2.5097, modelUsage: opus(4_383, 35_162, 2_460_407, 162_767, 2.5097) },
    ]);
    const options: ClaudeQueryOptions[] = [];
    const queries = [first.q, second.q];
    const adapter = createClaudeAdapter({
      queryFn: ({ options: o }) => {
        options.push(o ?? {});
        return queries.shift()!;
      },
    });
    adapter.start({ ...SPEC, runId: "run_turn1", maxSpendUsd: 5 }, { onLine: () => {}, onExit: () => {} });
    await drain();
    const lines: EmittedLine[] = [];
    adapter.start(
      { ...SPEC, runId: "run_turn2", resumeSessionId: "sess-542", maxSpendUsd: 5, costStateRestored: true },
      { onLine: (l) => lines.push(l), onExit: () => {} },
    );
    await drain();
    const result = lines.find((l) => l.facts.isResult)!;
    expect(result.facts.costUsd).toBeCloseTo(2.5097 - 1.9779, 4);
    expect(result.facts.usage).toMatchObject({
      input_tokens: 4_383 + 2_460_407 + 162_767 - (2_889 + 2_328_378 + 106_679),
      cached_input_tokens: 2_460_407 - 2_328_378,
      output_tokens: 35_162 - 32_390,
    });
    expect(result.display?.text).toMatch(/^success · 8 turns · 29s · \$0\.53 · in 189\.6k \(cached 132\.0k\) · out 2\.8k tokens$/);
    expect(options.map((o) => o.maxBudgetUsd)).toEqual([5, 5 + 1.9779]);
  });

  it("ruling 559: after a restart, a resumed run takes its share from the result its run log recalls", async () => {
    // Live on the AWS calculator board, the first controller turn after a
    // deploy recorded $3.36, the whole session's spend, because the restart
    // had emptied the adapter's memory of the session. CANARY: drop
    // `recallReported(spec)` in start() and the turn records $2.51 again.
    resetSessionTotalsForTests();
    const opus = (inputTokens: number, outputTokens: number, cacheRead: number, cacheWrite: number, costUSD: number) => ({
      "claude-opus-5-5[1m]": { inputTokens, outputTokens, cacheReadInputTokens: cacheRead, cacheCreationInputTokens: cacheWrite, costUSD },
    });
    const before = claudeReportedTotals({
      type: "result", subtype: "success", is_error: false, num_turns: 60, duration_ms: 331_000,
      usage: { input_tokens: 60, output_tokens: 28_716 }, total_cost_usd: 1.9779,
      modelUsage: opus(2_889, 32_390, 2_328_378, 106_679, 1.9779),
    })!;
    const resumed = fakeQuery([
      { type: "system", subtype: "init", session_id: "sess-559", model: "claude-opus-5-5", tools: [], mcp_servers: [] },
      { type: "result", subtype: "success", is_error: false, num_turns: 8, duration_ms: 29_000, usage: { input_tokens: 8, cache_read_input_tokens: 132_029, cache_creation_input_tokens: 56_088, output_tokens: 2_757 }, total_cost_usd: 2.5097, modelUsage: opus(4_383, 35_162, 2_460_407, 162_767, 2.5097) },
    ]);
    const options: ClaudeQueryOptions[] = [];
    const adapter = createClaudeAdapter({
      queryFn: ({ options: o }) => {
        options.push(o ?? {});
        return resumed.q;
      },
    });
    const lines: EmittedLine[] = [];
    adapter.start(
      {
        ...SPEC,
        runId: "run_after_restart",
        resumeSessionId: "sess-559",
        resumedSessionReported: before,
        maxSpendUsd: 5,
        costStateRestored: true,
      },
      { onLine: (l) => lines.push(l), onExit: () => {} },
    );
    await drain();
    const result = lines.find((l) => l.facts.isResult)!;
    expect(result.facts.costUsd).toBeCloseTo(2.5097 - 1.9779, 4);
    expect(options.map((o) => o.maxBudgetUsd)).toEqual([5 + 1.9779]);
  });

  it("ruling 553: a resume the CLI will not restore keeps the cap at the run's own", async () => {
    // Every controller conversation shares one scratch folder, so a turn of
    // another conversation in between means the CLI restores nothing, and a
    // cap raised by the session's old spend was spend the run could overrun
    // by. CANARY: raise the cap whenever the session has totals, and this
    // reads 5 + 1.9779.
    resetSessionTotalsForTests();
    const before = claudeReportedTotals({
      type: "result", subtype: "success", is_error: false, num_turns: 60, duration_ms: 331_000,
      usage: { input_tokens: 60, output_tokens: 28_716 }, total_cost_usd: 1.9779, modelUsage: {},
    })!;
    const resumed = fakeQuery([
      { type: "system", subtype: "init", session_id: "sess-553", model: "claude-opus-5-5", tools: [], mcp_servers: [] },
      { type: "result", subtype: "success", is_error: false, num_turns: 2, duration_ms: 9_000, usage: { input_tokens: 8, output_tokens: 100 }, total_cost_usd: 0.2 },
    ]);
    const options: ClaudeQueryOptions[] = [];
    const adapter = createClaudeAdapter({
      queryFn: ({ options: o }) => {
        options.push(o ?? {});
        return resumed.q;
      },
    });
    adapter.start(
      { ...SPEC, runId: "run_other_conversation_between", resumeSessionId: "sess-553", resumedSessionReported: before, maxSpendUsd: 5 },
      { onLine: () => {}, onExit: () => {} },
    );
    await drain();
    expect(options.map((o) => o.maxBudgetUsd)).toEqual([5]);
  });

  it("a refusal is the outcome's reason: the CLI had nothing to compact", async () => {
    const messages = [
      { type: "system", subtype: "init", session_id: "sess-2", model: "claude-sonnet-4-5", tools: [], mcp_servers: [] },
      { type: "result", subtype: "success", is_error: false, num_turns: 0, result: "Not enough messages to compact.", usage: { input_tokens: 0, output_tokens: 0 }, total_cost_usd: 0 },
    ];
    const { q } = fakeQuery(messages);
    const adapter = createClaudeAdapter({ queryFn: () => q });
    const lines: EmittedLine[] = [];
    const outcome = await adapter.compact!(SPEC, "sess-2", { onLine: (l) => lines.push(l) });
    expect(outcome).toEqual({ compacted: false, reason: "Not enough messages to compact." });
    expect(lines.map((l) => l.display?.tag)).toEqual(["run·compaction·request"]);
  });

  it("a stream that dies is a reason and one line, never a throw", async () => {
    const { q } = fakeQuery([], { rejectWith: new Error("socket hang up") });
    const adapter = createClaudeAdapter({ queryFn: () => q });
    const lines: EmittedLine[] = [];
    const outcome = await adapter.compact!(SPEC, "sess-3", { onLine: (l) => lines.push(l) });
    expect(outcome).toEqual({ compacted: false, reason: "socket hang up" });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.display?.tag).toBe("run·compaction·failed");
  });
});


/**
 * Ruling 394 (F39-21) — the Claude half of "a completed turn is a completed
 * turn".
 *
 * The defect was demonstrated live on Codex (see that adapter's suite), but the
 * gate here had the same shape: a terminal non-error `result` followed by a
 * thrown stream error fell straight through to `settleError`, and the run that
 * the SDK had just told us succeeded was reported as a failure. `sawResult` is
 * the stronger evidence of the two: the result closes the run's own work, and a
 * turn a background command's completion wakes behind it (Claude Code 2.1.292)
 * is cut by the result grace (ruling 687).
 */
describe("ruling 394: the stream threw after the query's own result", () => {
  const MESSAGES = [
    { type: "system", subtype: "init", session_id: "sess-1", model: "claude-sonnet-4-5", tools: ["Bash"], mcp_servers: [] },
    { type: "assistant", message: { content: [{ type: "text", text: "@operator Done on branch `ax-2`." }] } },
    { type: "result", subtype: "success", is_error: false, num_turns: 2, usage: { input_tokens: 10, output_tokens: 3 }, total_cost_usd: 0.05 },
    { type: "system", subtype: "never-reached" },
  ];

  async function run(messages: unknown[], throwAfter: number) {
    const { q } = fakeQuery(messages, { throwAfter });
    const lines: EmittedLine[] = [];
    let exit: RunExit | null = null;
    createClaudeAdapter({ queryFn: () => q }).start(SPEC, {
      onLine: (l) => lines.push(l),
      onExit: (e) => (exit = e),
    });
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
    return { lines, exit };
  }

  it("finishes, and records the drop as transport rather than a cause", async () => {
    // CANARY: delete the `sawResult && !resultIsError` branch from the catch
    // and this settles `error` — a successful run reported as a failed one.
    const { lines, exit } = await run(MESSAGES, 3);
    expect(exit).toMatchObject({ outcome: "finished" });
    const note = lines.at(-1)!;
    expect(note.display?.tag).toBe("run·transport·after-turn");
    expect(note.display?.ev).toBe("meta");
    expect(note.display?.text).toContain("the run's own result stands");
    expect(lines.some((l) => l.display?.ev === "err")).toBe(false);
  });

  it("still FAILS when the stream throws before any result", async () => {
    const { exit } = await run(MESSAGES, 2);
    expect(exit).toMatchObject({ outcome: "error" });
  });

  it("still FAILS when the result itself was an error", async () => {
    const errored = [
      MESSAGES[0],
      MESSAGES[1],
      { type: "result", subtype: "error_during_execution", is_error: true, num_turns: 2, usage: { input_tokens: 10, output_tokens: 3 }, result: "boom" },
      MESSAGES[3],
    ];
    const { exit } = await run(errored, 3);
    expect(exit).toMatchObject({ outcome: "error" });
  });
});
