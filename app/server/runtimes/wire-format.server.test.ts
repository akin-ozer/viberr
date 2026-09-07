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
      usage: {
        input_tokens: 812,
        cache_creation_input_tokens: 1000,
        cache_read_input_tokens: 38210,
        output_tokens: 2140,
      },
    };
    const { display, facts } = projectEnvelope("claude", raw);
    expect(display?.ev).toBe("result");
    expect(facts.isResult).toBe(true);
    expect(facts.isError).toBe(false);
    expect(facts.costUsd).toBe(0.31);
    expect(facts.turns).toBe(4);
    // The run row's terms: `input_tokens` is the WHOLE prompt (Claude's three
    // disjoint prompt figures summed), `cached_input_tokens` its cache-read
    // subset. Canary: read `usage.input_tokens` alone again and the row goes
    // back to the two-tokens-per-call figure the strip showed for months.
    // F35-1: a result is the provider's figure, never an estimate.
    expect(facts.usage).toEqual({ input_tokens: 40022, cached_input_tokens: 38210, output_tokens: 2140, outputEstimated: false });
    expect(display?.stats).toMatchObject({ in: 40022, cached: 38210, out: 2140 });
    expect(display?.text).toBe("success · 4 turns · 132s · $0.31 · in 40.0k (cached 38.2k) · out 2.1k tokens");
  });

  it("a result without cache figures keeps the plain input", () => {
    const raw = { type: "result", subtype: "success", is_error: false, num_turns: 1, duration_ms: 1000, total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 3 } };
    expect(projectEnvelope("claude", raw).facts.usage).toEqual({ input_tokens: 10, cached_input_tokens: 0, output_tokens: 3, outputEstimated: false });
  });

  it("result with error subtype → isError true", () => {
    const raw = { type: "result", subtype: "error_during_execution", is_error: true, num_turns: 5, usage: {} };
    expect(projectEnvelope("claude", raw).facts.isError).toBe(true);
  });

  it("unknown type → meta line, never throws", () => {
    expect(projectEnvelope("claude", { type: "system", subtype: "api_retry", error: "overloaded" }).display?.ev).toBe("meta");
    expect(projectEnvelope("claude", { type: "brand_new_2027" }).display?.ev).toBe("meta");
  });

  it("system/permission_denied (SDK ≥ 0.3.223) → an err line naming the refused tool and the reason, never a dim meta row", () => {
    // Agent SDK 0.3.261 upgrade: a tool call the permission layer refused — a
    // deny rule such as `Bash(git push:*)` on a supporting run — now reaches the
    // stream as its own frame. It used to fall to the generic system branch and
    // render as `system·permission_denied` in meta grey, so a human scanning the
    // console for the VIB-30 class (a review agent reaching for `git push`) saw
    // nothing. Canary: remove the `permission_denied` branch and `ev` is "meta".
    const denied = projectEnvelope("claude", {
      type: "system",
      subtype: "permission_denied",
      tool_name: "Bash",
      tool_use_id: "toolu_01",
      decision_reason_type: "rule",
      decision_reason: "Bash(git push:*) is denied for this run",
      message: "Permission to use Bash has been denied.",
      uuid: "u1",
      session_id: "s1",
    });
    expect(denied.display).toEqual({
      t: expect.any(String),
      ev: "err",
      tag: "permission_denied",
      name: "Bash",
      text: "denied by rule: Bash(git push:*) is denied for this run",
    });
    expect(denied.facts).toEqual({});

    // No deciding component's reason → the SDK's rejection sentence (the string
    // `message`, which shares its key with the assistant envelope's object).
    const noReason = projectEnvelope("claude", {
      type: "system",
      subtype: "permission_denied",
      tool_name: "Edit",
      tool_use_id: "toolu_02",
      message: "The session has no approval surface.",
      uuid: "u2",
      session_id: "s1",
    });
    expect(noReason.display).toMatchObject({ ev: "err", name: "Edit", text: "denied: The session has no approval surface." });

    // A frame missing even the tool name still says what happened.
    const bare = projectEnvelope("claude", { type: "system", subtype: "permission_denied" });
    expect(bare.display).toMatchObject({ ev: "err", tag: "permission_denied", text: "tool call denied" });
    expect(bare.display).not.toHaveProperty("name");

    // The assistant/user envelopes' object `message` is untouched by the shared key.
    const assistant = projectEnvelope("claude", {
      type: "assistant",
      message: { content: [{ type: "text", text: "hello" }] },
    });
    expect(assistant.display).toMatchObject({ ev: "text", text: "hello" });
  });

  it("rate_limit_event → meta line + rateLimit facts (pass 29 quota telemetry)", () => {
    const raw = {
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed_warning",
        resetsAt: 1_787_832_000,
        rateLimitType: "seven_day",
        utilization: 0.91,
        isUsingOverage: false,
      },
    };
    const { display, facts } = projectEnvelope("claude", raw);
    // Same telemetry tag the client already groups; a human-readable summary.
    expect(display).toMatchObject({ ev: "meta", tag: "rate_limit_event" });
    expect(display?.text).toContain("91%");
    expect(display?.text).toContain("seven_day");
    expect(facts.rateLimit).toEqual({
      status: "allowed_warning",
      rateLimitType: "seven_day",
      utilization: 0.91,
      resetsAt: 1_787_832_000,
      isUsingOverage: false,
    });
  });

  it("rate_limit_event with no/malformed info → meta line, NO fabricated facts", () => {
    const bare = projectEnvelope("claude", { type: "rate_limit_event" });
    expect(bare.display?.tag).toBe("rate_limit_event");
    expect(bare.facts.rateLimit).toBeUndefined();
    // A malformed utilization must read as "not reported", never a fake 0.
    const partial = projectEnvelope("claude", {
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed", rateLimitType: "five_hour", utilization: "high" },
    });
    expect(partial.facts.rateLimit?.utilization).toBeNull();
    // Ruling 130(a): the placeholder says what is missing instead of `?`.
    expect(partial.display?.text).toContain("utilization not reported");
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
    expect(facts.usage).toEqual({ input_tokens: 51234, cached_input_tokens: 38912, output_tokens: 1954, outputEstimated: false });
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

/**
 * Ruling 130(a) / U34-1 (pass 34): the provider's structured refusal facts
 * are projected, never lost. Canaries: delete the `if (e.error)` branch (the
 * banner projects as reply text); drop `api_error_status`/`terminal_reason`
 * from the schema; restore `${e.subtype || "error"}` in the result text.
 */
describe("ruling 130(a): structured refusal facts", () => {
  it("an assistant envelope carrying `error` projects as an err line, never as reply text", () => {
    const { display, facts } = projectEnvelope("claude", {
      type: "assistant",
      error: "oauth_org_not_allowed",
      message: { content: [{ type: "text", text: "You are not allowed to use this account here." }] },
    });
    expect(display).toMatchObject({ ev: "err", tag: "assistant·oauth_org_not_allowed" });
    expect(display?.text).toContain("not allowed");
    expect(facts.apiError).toBe("oauth_org_not_allowed");
    // A plain assistant message stays reply text.
    expect(projectEnvelope("claude", { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }).display?.ev).toBe("text");
  });

  it("result facts carry `api_error_status` / `terminal_reason`; the label is never `success` on an error", () => {
    const refused = projectEnvelope("claude", {
      type: "result", subtype: "success", is_error: true, num_turns: 1, usage: {},
      api_error_status: 403, terminal_reason: "api_error",
    });
    expect(refused.facts).toMatchObject({ isError: true, apiErrorStatus: 403, terminalReason: "api_error" });
    expect(refused.display?.text).toBe("error · 1 turns · api 403 · api_error");
    expect(refused.display?.stats?.subtype).toBe("error");
    const maxTurns = projectEnvelope("claude", { type: "result", subtype: "error_max_turns", is_error: true, num_turns: 9, usage: {} });
    expect(maxTurns.display?.text).toBe("error_max_turns · 9 turns");
    const ok = projectEnvelope("claude", { type: "result", subtype: "success", is_error: false, num_turns: 2, usage: {}, duration_ms: 1000, total_cost_usd: 0.1 });
    expect(ok.display?.text).toContain("success · 2 turns");
    expect(ok.facts.apiErrorStatus).toBeNull();
  });

  it("a REJECTED rate-limit line names the window, the status and the reset, and is not telemetry", () => {
    const { display, facts } = projectEnvelope("claude", {
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected", rateLimitType: "five_hour", utilization: null, resetsAt: 1_788_781_800, isUsingOverage: false },
    });
    expect(display).toMatchObject({ ev: "err", tag: "rate_limit_event·rejected" });
    expect(display?.text).toBe("rate limit · five_hour · rejected · utilization not reported · resets 2026-09-07 11:50 UTC");
    expect(facts.rateLimit?.status).toBe("rejected");
    const allowed = projectEnvelope("claude", {
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed", rateLimitType: "five_hour", utilization: 0.4, resetsAt: null, isUsingOverage: false },
    });
    expect(allowed.display).toMatchObject({ ev: "meta", tag: "rate_limit_event" });
    expect(allowed.display?.text).toBe("rate limit · five_hour · allowed · 40%");
  });
});
