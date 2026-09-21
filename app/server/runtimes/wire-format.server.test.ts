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

/**
 * Ruling 175: a Claude result's tokens and cost come from `modelUsage`, which
 * covers every call the query made (subagents, sidechains, compaction), with
 * `usage` — the main loop only — as the fallback. Column semantics do not move:
 * input is the whole prompt, cached its cache-read subset.
 */
describe("ruling 175: the result fold reads modelUsage", () => {
  const RESULT = {
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: 3,
    duration_ms: 12_000,
    duration_api_ms: 9_000,
    // The main loop alone: what the row used to store.
    usage: { input_tokens: 10, cache_creation_input_tokens: 1_000, cache_read_input_tokens: 20_000, output_tokens: 500 },
    total_cost_usd: 0.4,
  };

  it("sums every model's whole prompt, cache reads, output and cost", () => {
    const { display, facts } = projectEnvelope("claude", {
      ...RESULT,
      modelUsage: {
        "claude-opus-4-8": { inputTokens: 10, outputTokens: 500, cacheReadInputTokens: 20_000, cacheCreationInputTokens: 1_000, webSearchRequests: 0, costUSD: 0.3, contextWindow: 200_000, maxOutputTokens: 32_000 },
        // A subagent on another model — invisible to `usage`.
        "claude-haiku-4-5": { inputTokens: 40, outputTokens: 900, cacheReadInputTokens: 5_000, cacheCreationInputTokens: 2_000, webSearchRequests: 0, costUSD: 0.1, contextWindow: 200_000, maxOutputTokens: 8_000 },
      },
    });
    expect(facts.usage).toEqual({
      input_tokens: 10 + 1_000 + 20_000 + 40 + 2_000 + 5_000,
      cached_input_tokens: 25_000,
      output_tokens: 1_400,
      outputEstimated: false,
    });
    expect(facts.costUsd).toBeCloseTo(0.4, 10);
    expect(display?.text).toContain("$0.40");
    expect(display?.text).toContain("· 2 models");
    expect(display?.stats?.models).toEqual([
      { model: "claude-opus-4-8", in: 21_010, cached: 20_000, out: 500, cost: 0.3 },
      { model: "claude-haiku-4-5", in: 7_040, cached: 5_000, out: 900, cost: 0.1 },
    ]);
  });

  it("falls back to usage and total_cost_usd when modelUsage is absent, empty or zeroed", () => {
    const expected = { input_tokens: 21_010, cached_input_tokens: 20_000, output_tokens: 500, outputEstimated: false };
    for (const modelUsage of [undefined, {}, { "claude-opus-4-8": { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0, contextWindow: 0, maxOutputTokens: 0 } }]) {
      const { display, facts } = projectEnvelope("claude", { ...RESULT, modelUsage });
      expect(facts.usage, JSON.stringify(modelUsage)).toEqual(expected);
      expect(facts.costUsd).toBe(0.4);
      expect(display?.stats).not.toHaveProperty("models");
      expect(display?.text).not.toContain("models");
    }
  });

  it("a malformed model entry costs that entry, not the others", () => {
    const { facts } = projectEnvelope("claude", {
      ...RESULT,
      modelUsage: {
        "claude-opus-4-8": { inputTokens: 10, outputTokens: 500, cacheReadInputTokens: 20_000, cacheCreationInputTokens: 1_000, costUSD: 0.3 },
        broken: "not an entry",
      },
    });
    expect(facts.usage?.input_tokens).toBe(21_010);
    expect(facts.costUsd).toBeCloseTo(0.3, 10);
  });

  it("the budget cut-off result carries its spend like any other result", () => {
    const { display, facts } = projectEnvelope("claude", {
      ...RESULT,
      subtype: "error_max_budget_usd",
      is_error: true,
      modelUsage: {
        "claude-opus-4-8": { inputTokens: 10, outputTokens: 500, cacheReadInputTokens: 20_000, cacheCreationInputTokens: 1_000, costUSD: 0.52 },
      },
    });
    expect(display?.text).toContain("error_max_budget_usd");
    expect(facts.isError).toBe(true);
    expect(facts.costUsd).toBe(0.52);
  });
});

/**
 * Ruling 366: the heartbeat line and the arguments line. Canary: drop the
 * `tool_progress` case and the first test's `ev` is still "meta" but `progress`
 * is gone and the text is the raw JSON.
 */
describe("projectEnvelope — ruling 366: heartbeats and MCP arguments", () => {
  it("tool_progress → a meta heartbeat naming the tool, its call and the provider's figure", () => {
    const { display, facts } = projectEnvelope(
      "claude",
      {
        type: "tool_progress",
        tool_use_id: "toolu_01-heartbeat-2",
        tool_name: "mcp__viberr__run_agent",
        parent_tool_use_id: "toolu_01",
        elapsed_time_seconds: 90,
        heartbeat: true,
        session_id: "s",
        uuid: "u",
      },
      "2026-09-20T10:01:30.000Z",
    );
    expect(display).toEqual({
      t: display?.t,
      ev: "meta",
      tag: "tool_progress",
      name: "mcp__viberr__run_agent",
      text: "mcp__viberr__run_agent still running · 1m 30s",
      // 366(e): the heartbeat's own instant rides the line, so a live count
      // can run on from the figure; projected without one, it is null.
      progress: { call: "toolu_01", elapsed: 90, heartbeat: true, at: "2026-09-20T10:01:30.000Z" },
    });
    expect(facts).toEqual({});
    expect(
      projectEnvelope("claude", { type: "tool_progress", tool_name: "Bash", elapsed_time_seconds: 30 }).display?.progress?.at,
    ).toBeNull();
  });

  it("a frame with no figure says still running and invents no number; no parent → keyed on its own id", () => {
    const { display } = projectEnvelope("claude", {
      type: "tool_progress",
      tool_use_id: "toolu_02",
      tool_name: "Agent",
      parent_tool_use_id: null,
      elapsed_time_seconds: null,
      subagent_type: "explorer",
    });
    expect(display).toMatchObject({
      text: "Agent still running",
      progress: { call: "toolu_02", elapsed: null, heartbeat: false, at: null },
    });
    // A garbled figure reads as none, never as a number.
    expect(
      projectEnvelope("claude", { type: "tool_progress", tool_name: "Bash", elapsed_time_seconds: "soon" })
        .display?.progress?.elapsed,
    ).toBeNull();
  });

  it("an MCP call's arguments read as key: value pairs — clipped strings, collections by size", () => {
    const { display } = projectEnvelope("claude", {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "mcp__viberr__run_agent",
            input: {
              profileId: "integration-verifier",
              delivers: false,
              prompt: "re-verify   the\nbranch " + "x".repeat(200),
              evidence: [1, 2, 3],
              extra: { a: 1 },
              gone: null,
            },
          },
        ],
      },
    });
    expect(display?.text).toBe(
      "profileId: integration-verifier · delivers: false · prompt: re-verify the branch " +
        "x".repeat(159 - "re-verify the branch ".length) +
        "… · evidence: [3 items] · extra: {1 field} · gone: null",
    );
    // The raw view keeps every character: the input rides the line untouched.
    expect(display?.input?.prompt).toContain("x".repeat(200));
  });

  it("a single string argument is the row, on both backends; a built-in keeps its own summary", () => {
    const claude = projectEnvelope("claude", {
      type: "assistant",
      message: {
        content: [{ type: "tool_use", name: "mcp__viberr__read_default_branch_file", input: { path: "services/orders/src/app.ts" } }],
      },
    });
    expect(claude.display?.text).toBe("services/orders/src/app.ts");
    const codex = projectEnvelope("codex", {
      type: "item.started",
      item: {
        id: "m",
        type: "mcp_tool_call",
        server: "viberr-agent",
        tool: "read_knowledge_doc",
        arguments: { kb: "rulings", path: "rulings.md" },
        status: "in_progress",
      },
    });
    expect(codex.display).toMatchObject({ name: "viberr-agent.read_knowledge_doc", text: "kb: rulings · path: rulings.md" });
    const bash = projectEnvelope("claude", {
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Bash", input: { command: "npm test", description: "run tests" } }] },
    });
    expect(bash.display?.text).toBe("npm test");
    // A built-in with no bespoke summary reads as the arguments line too,
    // never as one JSON blob.
    const todo = projectEnvelope("claude", {
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "TodoWrite", input: { todos: [{ content: "a" }, { content: "b" }] } }] },
    });
    expect(todo.display?.text).toBe("todos: [2 items]");
  });
});

/**
 * Ruling 367: a tool result reads as its content, never as its envelope.
 * Canary: send `content` through `wireText` again and the first text below
 * starts with `[{"type"`.
 */
describe("projectEnvelope — ruling 367: MCP result blocks", () => {
  /** A `tool_result`'s `content` as the SDK sends it: a string, nothing, or
   *  content blocks (with one deliberately malformed slot for the last case). */
  type WireResultContent =
    | string
    | null
    | (
        | { type: string; text?: string; tool_name?: string; source?: { type: string; media_type: string; data: string } }
        | number
      )[];
  const result = (content: WireResultContent, is_error = false) => ({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content, is_error }] },
  });

  it("reads a content-block array as its text, so a multi-line answer takes the code block", () => {
    const json = '{\n  "key": "BNB-27",\n  "title": "Become a host"\n}';
    const { display } = projectEnvelope("claude", result([{ type: "text", text: json }]));
    expect(display).toMatchObject({ ev: "out", tag: "tool_result", text: json });
    expect(display?.text.startsWith("[{")).toBe(false);
  });

  it("notes an image by its media type and a tool reference by its name, never the bytes", () => {
    const { display } = projectEnvelope(
      "claude",
      result([
        { type: "text", text: "Navigated." },
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "/9j/4AAQSkZJRg" } },
        { type: "tool_reference", tool_name: "mcp__viberr_browser__browser_navigate" },
        { type: "document" },
      ]),
    );
    expect(display?.text).toBe(
      "Navigated.\n[image: image/jpeg]\n[tool_reference: mcp__viberr_browser__browser_navigate]\n[document]",
    );
    expect(display?.text).not.toContain("/9j/");
  });

  it("keeps the error flag through the unwrapping, and a plain string as it was", () => {
    expect(projectEnvelope("claude", result([{ type: "text", text: "[denied] not at this stage" }], true)).display).toMatchObject({
      ev: "err",
      text: "[denied] not at this stage",
    });
    expect(projectEnvelope("claude", result("290 passing")).display?.text).toBe("290 passing");
    expect(projectEnvelope("claude", result(null)).display?.text).toBe("");
    // A block that is not an object costs its own slot, never the answer.
    expect(projectEnvelope("claude", result([{ type: "text", text: "a" }, 7])).display?.text).toBe("a\n[block]");
  });
});

/**
 * Ruling 369: the prompt-cache figures are read ONCE, at the wire boundary,
 * and ride `facts.cache`; a compaction rides `facts.compaction`. The sink folds
 * both onto the run row and the console prints them, so what this boundary
 * misses no surface can show.
 */
describe("projectEnvelope — ruling 369: cache facts and compactions", () => {
  interface Usage {
    input_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
    cache_creation?: { ephemeral_5m_input_tokens: number; ephemeral_1h_input_tokens: number };
    output_tokens?: number;
  }
  interface Extra {
    diagnostics?: { cache_miss_reason: { type: string } };
  }
  const assistant = (usage: Usage, extra: Extra = {}) => ({
    type: "assistant",
    parent_tool_use_id: null,
    message: {
      id: "msg_1",
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
      usage,
      ...extra,
    },
  });

  it("an assistant envelope carries the call's prompt, its cache write and read, the TTL split and the miss reason", () => {
    const { facts } = projectEnvelope(
      "claude",
      assistant(
        {
          input_tokens: 2,
          cache_creation_input_tokens: 11597,
          cache_read_input_tokens: 7413,
          cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 11597 },
          output_tokens: 1,
        },
        { diagnostics: { cache_miss_reason: { type: "unavailable" } } },
      ),
    );
    expect(facts.cache).toEqual({
      messageId: "msg_1",
      promptTokens: 2 + 11597 + 7413,
      cacheWrite: 11597,
      cacheRead: 7413,
      perCall: true,
      ttl: { fiveMinute: 0, oneHour: 11597 },
      missReason: "unavailable",
    });
  });

  it("no TTL split and no diagnostics read as null, never as zeros or empty strings", () => {
    const { facts } = projectEnvelope(
      "claude",
      assistant({ input_tokens: 2, cache_creation_input_tokens: 10, cache_read_input_tokens: 20 }),
    );
    expect(facts.cache).toMatchObject({ ttl: null, missReason: null, promptTokens: 32 });
  });

  it("a subagent's envelope and an all-zero usage carry no cache fact", () => {
    // Canary: drop the `parent_tool_use_id` gate and a subagent's prompt
    // becomes the run's first call.
    const sub = projectEnvelope("claude", {
      ...assistant({ input_tokens: 5, cache_creation_input_tokens: 5, cache_read_input_tokens: 5 }),
      parent_tool_use_id: "toolu_agent",
    });
    expect(sub.facts.cache).toBeNull();
    const zero = projectEnvelope(
      "claude",
      assistant({ input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 }),
    );
    expect(zero.facts.cache).toBeNull();
    // A tool_use envelope and an API-error banner carry the fact too: the
    // call happened, whatever the model did with it.
    const tool = projectEnvelope("claude", {
      ...assistant({ input_tokens: 1, cache_creation_input_tokens: 1, cache_read_input_tokens: 1 }),
      message: {
        id: "msg_2",
        content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }],
        usage: { input_tokens: 1, cache_creation_input_tokens: 1, cache_read_input_tokens: 1 },
      },
    });
    expect(tool.facts.cache?.messageId).toBe("msg_2");
  });

  it("a compact_boundary names the trigger and the sizes, and rides facts.compaction", () => {
    const { display, facts } = projectEnvelope("claude", {
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "auto", pre_tokens: 972032, post_tokens: 10041 },
    });
    expect(display).toMatchObject({
      ev: "meta",
      tag: "system·compact_boundary",
      text: "context compacted (auto) · 972k → 10k tokens",
    });
    expect(facts.compaction).toEqual({ trigger: "auto", preTokens: 972032, postTokens: 10041 });
    // Without metadata the line still says a compaction happened.
    const bare = projectEnvelope("claude", { type: "system", subtype: "compact_boundary" });
    expect(bare.display?.text).toBe("context compacted (auto)");
    expect(bare.facts.compaction).toEqual({ trigger: "auto", preTokens: null, postTokens: null });
  });

  it("a Codex turn's usage carries its cache write and cached read as a TURN total, never a prompt size", () => {
    const { display, facts } = projectEnvelope("codex", {
      type: "turn.completed",
      usage: { input_tokens: 26_000, cached_input_tokens: 21_248, cache_write_input_tokens: 1_500, output_tokens: 300 },
    });
    expect(facts.cache).toEqual({
      messageId: null,
      promptTokens: 26_000,
      cacheWrite: 1_500,
      cacheRead: 21_248,
      perCall: false,
      ttl: null,
      missReason: null,
    });
    expect(display?.text).toContain("wrote 1.5k");
    // An SDK that sent no write figure (the default 0) prints none.
    const silent = projectEnvelope("codex", {
      type: "turn.completed",
      usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 1 },
    });
    expect(silent.display?.text).not.toContain("wrote");
    expect(silent.facts.cache?.cacheWrite).toBe(0);
  });

  it("a Codex context_compaction item counts as a compaction", () => {
    const { display, facts } = projectEnvelope("codex", {
      type: "item.completed",
      item: { id: "cc-1", type: "context_compaction" },
    });
    expect(display).toMatchObject({ ev: "meta", tag: "context_compaction", text: "context compacted" });
    expect(facts.compaction).toEqual({ trigger: "auto", preTokens: null, postTokens: null });
    expect(
      projectEnvelope("codex", { type: "item.started", item: { id: "cc-1", type: "context_compaction" } }).display,
    ).toBeNull();
  });
});
