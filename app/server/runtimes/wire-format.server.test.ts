import { describe, expect, it } from "vitest";
import { projectEnvelope } from "./wire-format.server";

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

  // P14-RT-07: these two fell to the default branch, which rendered them as dim
  // `meta` rows reading `item.text ?? item.query` — fields an McpToolCallItem
  // does not have — so the panel could not say which MCP tool a Codex agent
  // called, or with what, while Claude logged tool name + input.
  it("mcp_tool_call started → tool line naming server.tool + its arguments", () => {
    const { display } = projectEnvelope("codex", {
      type: "item.started",
      item: {
        id: "mcp-1",
        type: "mcp_tool_call",
        server: "everything-http",
        tool: "echo",
        arguments: { message: "ping" },
        status: "in_progress",
      },
    });
    expect(display).toMatchObject({
      ev: "tool",
      tag: "mcp_tool_call",
      name: "everything-http.echo",
      text: "ping",
    });
    expect(display?.input).toEqual({ message: "ping" });
  });

  it("a SUCCEEDING mcp_tool_call adds no second line; a failing one reports why", () => {
    const ok = projectEnvelope("codex", {
      type: "item.completed",
      item: { id: "mcp-1", type: "mcp_tool_call", server: "s", tool: "t", arguments: {}, status: "completed" },
    });
    expect(ok.display).toBeNull();

    const failed = projectEnvelope("codex", {
      type: "item.completed",
      item: {
        id: "mcp-2",
        type: "mcp_tool_call",
        server: "s",
        tool: "t",
        arguments: {},
        status: "failed",
        error: { message: "server refused" },
      },
    });
    expect(failed.display).toMatchObject({
      ev: "err",
      tag: "mcp_tool_call",
      name: "s.t",
      text: "server refused",
    });
    // Item-level failures stay non-fatal (same rule as ErrorItem above).
    expect(failed.facts.isError).toBeUndefined();
  });

  it("web_search → tool line carrying the query", () => {
    const { display } = projectEnvelope("codex", {
      type: "item.completed",
      item: { id: "ws-1", type: "web_search", query: "react router v8 loaders" },
    });
    expect(display).toMatchObject({
      ev: "tool",
      tag: "web_search",
      text: "react router v8 loaders",
    });
  });
});
