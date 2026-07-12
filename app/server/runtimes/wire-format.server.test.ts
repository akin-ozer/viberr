import { describe, expect, it } from "vitest";
import type { LogLine } from "~/features/runtime/runtime-types";
import { projectEnvelope, rawLineFromDisplay } from "./wire-format.server";

const CTX = { backend: "claude" as const, sid: "sess-1234abcd", model: "claude-sonnet-4-5", op: false };
const CTX_OP = { ...CTX, op: true };
const CTX_CODEX = { backend: "codex" as const, sid: "0199a1f3-4c02-7d31", model: "gpt-5.4-codex", op: false };

describe("projectEnvelope — Claude stream-json", () => {
  it("system·init → init line with session/model/tools/mcp facts", () => {
    const raw = {
      type: "system",
      subtype: "init",
      session_id: "51d8f0e2-3a7b",
      model: "claude-sonnet-4-5",
      tools: ["Bash", "Read", "Edit"],
      mcp_servers: [{ name: "github", status: "connected" }],
      cwd: "/work/viberr",
    };
    const { display, facts } = projectEnvelope("claude", raw);
    expect(display?.ev).toBe("init");
    expect(display?.tag).toBe("system·init");
    expect(display?.text).toContain("51d8f0e2");
    expect(display?.text).toContain("mcp: github");
    expect(facts.sessionId).toBe("51d8f0e2-3a7b");
    expect(facts.model).toBe("claude-sonnet-4-5");
  });

  it("assistant tool_use → tool line with name + input", () => {
    const raw = {
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Bash", input: { command: "npm test" } }] },
    };
    const { display } = projectEnvelope("claude", raw);
    expect(display?.ev).toBe("tool");
    expect(display?.name).toBe("Bash");
    expect(display?.text).toBe("npm test");
  });

  it("assistant text → text line", () => {
    const raw = { type: "assistant", message: { content: [{ type: "text", text: "Running tests." }] } };
    expect(projectEnvelope("claude", raw).display).toMatchObject({ ev: "text", text: "Running tests." });
  });

  it("user tool_result (ok / error) → out / err lines", () => {
    const ok = { type: "user", message: { content: [{ type: "tool_result", content: "290 passing", is_error: false }] } };
    const err = { type: "user", message: { content: [{ type: "tool_result", content: "boom", is_error: true }] } };
    expect(projectEnvelope("claude", ok).display?.ev).toBe("out");
    expect(projectEnvelope("claude", err).display?.ev).toBe("err");
  });

  it("result → result line + usage/cost/turns facts, is_error honored", () => {
    const raw = {
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 4,
      duration_ms: 132400,
      duration_api_ms: 98120,
      total_cost_usd: 0.31,
      usage: { input_tokens: 812, cache_read_input_tokens: 38210, output_tokens: 2140 },
    };
    const { display, facts } = projectEnvelope("claude", raw);
    expect(display?.ev).toBe("result");
    expect(facts.isResult).toBe(true);
    expect(facts.isError).toBe(false);
    expect(facts.costUsd).toBe(0.31);
    expect(facts.turns).toBe(4);
    expect(facts.usage).toEqual({ input_tokens: 812, cached_input_tokens: 38210, output_tokens: 2140 });
  });

  it("result with error subtype → isError true", () => {
    const raw = { type: "result", subtype: "error_during_execution", is_error: true, num_turns: 5, usage: {} };
    expect(projectEnvelope("claude", raw).facts.isError).toBe(true);
  });

  it("unknown type → meta line, never throws", () => {
    expect(projectEnvelope("claude", { type: "system", subtype: "api_retry", error: "overloaded" }).display?.ev).toBe("meta");
    expect(projectEnvelope("claude", { type: "brand_new_2027" }).display?.ev).toBe("meta");
  });
});

describe("projectEnvelope — Codex JSONL", () => {
  it("thread.started → init + sessionId fact", () => {
    const { display, facts } = projectEnvelope("codex", { type: "thread.started", thread_id: "0199a1f3-4c02-7d31" });
    expect(display?.ev).toBe("init");
    expect(facts.sessionId).toBe("0199a1f3-4c02-7d31");
  });

  it("turn.completed → result line with usage facts (tokens, no cost)", () => {
    const raw = { type: "turn.completed", usage: { input_tokens: 51234, cached_input_tokens: 38912, output_tokens: 1954 } };
    const { display, facts } = projectEnvelope("codex", raw);
    expect(display?.ev).toBe("result");
    expect(facts.usage).toEqual({ input_tokens: 51234, cached_input_tokens: 38912, output_tokens: 1954 });
    expect(facts.costUsd).toBeUndefined();
  });

  it("item.completed reasoning/agent_message/file_change map to think/text/diff", () => {
    expect(projectEnvelope("codex", { type: "item.completed", item: { type: "reasoning", text: "think" } }).display?.ev).toBe("think");
    expect(projectEnvelope("codex", { type: "item.completed", item: { type: "agent_message", text: "hi" } }).display?.ev).toBe("text");
    expect(
      projectEnvelope("codex", { type: "item.completed", item: { type: "file_change", changes: [{ path: "a.ts", kind: "add" }] } }).display?.ev,
    ).toBe("diff");
  });

  it("command_execution started → tool; completed exit 0 → out, non-zero → err", () => {
    expect(projectEnvelope("codex", { type: "item.started", item: { type: "command_execution", command: 'bash -lc "ls"' } }).display?.ev).toBe("tool");
    expect(projectEnvelope("codex", { type: "item.completed", item: { type: "command_execution", exit_code: 0, aggregated_output: "ok\n" } }).display?.ev).toBe("out");
    const err = projectEnvelope("codex", { type: "item.completed", item: { type: "command_execution", exit_code: 2, aggregated_output: "fail\n" } });
    expect(err.display?.ev).toBe("err");
    expect(err.display?.exit).toBe(2);
  });

  it("turn.failed / error → err line + isError fact", () => {
    expect(projectEnvelope("codex", { type: "turn.failed", error: { message: "stream ended" } }).facts.isError).toBe(true);
    expect(projectEnvelope("codex", { type: "error", message: "broken pipe" }).facts.isError).toBe(true);
  });

  it("ErrorItem is visible but non-fatal", () => {
    const { display, facts } = projectEnvelope("codex", {
      type: "item.completed",
      item: { id: "err-1", type: "error", message: "retry warning" },
    });
    expect(display).toMatchObject({ ev: "err", tag: "error", text: "retry warning" });
    expect(facts.isError).toBeUndefined();
  });

  it("in-progress items other than command_execution yield no line", () => {
    expect(projectEnvelope("codex", { type: "item.started", item: { type: "reasoning", text: "x" } }).display).toBeNull();
  });
});

describe("rawLineFromDisplay → projectEnvelope round-trip", () => {
  const roundTrip = (
    ctx: { backend: "claude" | "codex"; sid: string; model: string; op: boolean },
    lines: LogLine[],
  ) =>
    lines.map((l, i) => {
      const raw = rawLineFromDisplay(ctx, l, i, lines);
      const parsed = JSON.parse(raw); // must be valid JSON
      const projected = projectEnvelope(ctx.backend, parsed);
      return { raw, projected };
    });

  it("claude: every ev fabricates valid wire JSON that re-projects to the same ev", () => {
    const lines: LogLine[] = [
      { t: "1", ev: "init", tag: "system·init", text: "session x" },
      { t: "2", ev: "text", tag: "assistant", text: "hi" },
      { t: "3", ev: "tool", tag: "tool_use", name: "Bash", text: "npm test" },
      { t: "4", ev: "out", tag: "tool_result", text: "ok" },
      { t: "5", ev: "err", tag: "tool_result", text: "bad" },
      { t: "6", ev: "result", tag: "result", text: "done", stats: { dur: 100, api: 90, turns: 2, cost: 0.1, in: 5, cached: 2, out: 3 } },
    ];
    const out = roundTrip(CTX, lines);
    expect(out.map((o) => o.projected.display?.ev)).toEqual(["init", "text", "tool", "out", "err", "result"]);
    // operator init carries the task-store MCP.
    const opRaw = rawLineFromDisplay(CTX_OP, lines[0]!, 0, lines);
    expect(opRaw).toContain("viberr-task-store");
  });

  it("claude tool_result ids match the preceding tool_use id (deterministic)", () => {
    const lines: LogLine[] = [
      { t: "1", ev: "tool", tag: "tool_use", name: "Bash", text: "ls" },
      { t: "2", ev: "out", tag: "tool_result", text: "files" },
    ];
    const toolRaw = JSON.parse(rawLineFromDisplay(CTX, lines[0]!, 0, lines));
    const resultRaw = JSON.parse(rawLineFromDisplay(CTX, lines[1]!, 1, lines));
    const toolId = toolRaw.message.content[0].id;
    const resultId = resultRaw.message.content[0].tool_use_id;
    expect(resultId).toBe(toolId);
  });

  it("codex: every ev fabricates valid JSON that re-projects to the same ev", () => {
    const lines: LogLine[] = [
      { t: "1", ev: "init", tag: "thread.started", text: "thread x" },
      { t: "2", ev: "meta", tag: "turn.started", text: "turn 1" },
      { t: "3", ev: "think", tag: "reasoning", text: "reason" },
      { t: "4", ev: "tool", tag: "command_execution", name: "exec", text: "rg foo" },
      { t: "5", ev: "out", tag: "aggregated_output", text: "1 match" },
      { t: "6", ev: "diff", tag: "file_change", text: "1 file", changes: [{ path: "a.ts", kind: "add" }] },
      { t: "7", ev: "result", tag: "turn.completed", text: "done", usage: { input_tokens: 5, cached_input_tokens: 2, output_tokens: 3 } },
    ];
    const out = roundTrip(CTX_CODEX, lines);
    // 'meta' re-projects to meta; the rest preserve their ev.
    expect(out.map((o) => o.projected.display?.ev)).toEqual(["init", "meta", "think", "tool", "out", "diff", "result"]);
  });
});
