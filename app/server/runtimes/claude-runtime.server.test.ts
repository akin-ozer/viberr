import { describe, expect, it } from "vitest";
import type { EmittedLine, RunExit, RunSpec } from "./adapter.server";
import {
  createClaudeAdapter,
  resolveClaudeModel,
  type ClaudeQuery,
} from "./claude-runtime.server";

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
});

/** A fake Query: yields the given messages, records interrupt() calls. */
function fakeQuery(messages: unknown[], opts: { throwAfter?: number } = {}) {
  let interrupted = false;
  const gen = (async function* () {
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
  const q = gen as unknown as ClaudeQuery;
  (q as { interrupt: () => Promise<void> }).interrupt = async () => {
    interrupted = true;
  };
  return { q, wasInterrupted: () => interrupted };
}

const SPEC: RunSpec = {
  runId: "r1",
  projectSlug: "viberr-core",
  taskKey: "VIB-1",
  threadId: "primary",
  role: "Primary specialist",
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
    expect(exit).toMatchObject({ outcome: "finished", simulated: false, effectiveBackend: "claude", sessionId: "sess-1" });
  });

  it("errors when the result envelope is is_error", async () => {
    const { q } = fakeQuery([
      { type: "result", subtype: "error_max_turns", is_error: true, num_turns: 50, usage: {} },
    ]);
    const adapter = createClaudeAdapter({ queryFn: () => q });
    let exit: RunExit | null = null;
    adapter.start(SPEC, { onLine: () => {}, onExit: (e) => (exit = e) });
    await drain();
    expect(exit).toMatchObject({ outcome: "error" });
  });

  it("errors when the stream ends with no result envelope (aborted)", async () => {
    const { q } = fakeQuery([{ type: "assistant", message: { content: [{ type: "text", text: "partial" }] } }]);
    const adapter = createClaudeAdapter({ queryFn: () => q });
    let exit: RunExit | null = null;
    adapter.start(SPEC, { onLine: () => {}, onExit: (e) => (exit = e) });
    await drain();
    expect(exit).toMatchObject({ outcome: "error" });
  });

  it("threads spec.effort into options.effort (and omits it when absent)", async () => {
    const result = [
      { type: "result", subtype: "success", is_error: false, num_turns: 1, usage: {} },
    ];
    let captured: { model?: string; effort?: string } | undefined;
    const queryFn = (params: { options?: { model?: string; effort?: string } }) => {
      captured = params.options;
      const { q } = fakeQuery(result);
      return q;
    };

    // With effort set.
    createClaudeAdapter({ queryFn: queryFn as never }).start(
      { ...SPEC, model: "sonnet", effort: "xhigh" },
      { onLine: () => {}, onExit: () => {} },
    );
    await drain();
    expect(captured?.effort).toBe("xhigh");
    expect(captured?.model).toBe("sonnet");

    // Without effort → options.effort is absent (SDK default applies).
    createClaudeAdapter({ queryFn: queryFn as never }).start(
      { ...SPEC, model: "sonnet" },
      { onLine: () => {}, onExit: () => {} },
    );
    await drain();
    expect(captured?.effort).toBeUndefined();
  });

  it("interrupt() calls the SDK interrupt and ends interrupted (no result line)", async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ type: "assistant", message: { content: [{ type: "text", text: "line " + i }] } }));
    const { q, wasInterrupted } = fakeQuery(many);
    const adapter = createClaudeAdapter({ queryFn: () => q });
    let exit: RunExit | null = null;
    const handle = adapter.start(SPEC, { onLine: () => {}, onExit: (e) => (exit = e) });
    handle.interrupt("u1", "arda");
    await drain();
    expect(wasInterrupted()).toBe(true);
    expect(exit).toMatchObject({ outcome: "interrupted" });
  });
});
