import { describe, expect, it } from "vitest";
import { answeredStep, stepUpdateForLine, type EmittedLine } from "./adapter.server";
import type { LogLine } from "~/features/runtime/runtime-types";

const line = (display: LogLine | null, facts: EmittedLine["facts"] = {}): EmittedLine => ({
  raw: "{}",
  display,
  facts,
  occurredAt: "2026-09-18T02:10:31.000Z",
});

/**
 * Ruling 348 (pass 38, F38-2). Live on the first controller turn of the pass:
 * `Working · mcp__viberr_controller__get_github_state · {…}` stood on the
 * strip for over two minutes after that call had answered, while the console
 * one panel down logged thinking lines. Measured over the last 40 controller
 * turns: 76 stretches longer than 20 s on 26 runs, 53 minutes of a finished
 * tool shown as the thing the run was doing.
 */
describe("stepUpdateForLine (ruling 348)", () => {
  it("names a tool the run invokes, with its input", () => {
    const update = stepUpdateForLine(
      line({ t: "02:10", ev: "tool", tag: "tool_use", name: "Bash", text: "npm test" }),
    );
    expect(update).toEqual({ kind: "tool", step: "Bash · npm test" });
  });

  it("says the tool has answered on Claude's result row, ok or error", () => {
    // CANARY: drop the `tool_result` branch and both read null — the step
    // then sticks on the finished call until the next invocation.
    expect(
      stepUpdateForLine(line({ t: "02:10", ev: "out", tag: "tool_result", text: "ok" })),
    ).toEqual({ kind: "answered" });
    expect(
      stepUpdateForLine(line({ t: "02:10", ev: "err", tag: "tool_result", text: "boom" })),
    ).toEqual({ kind: "answered" });
  });

  it("says the command has answered on Codex's completed output row", () => {
    expect(
      stepUpdateForLine(
        line({ t: "02:10", ev: "out", tag: "aggregated_output", text: "12 passed", exit: 0 }),
      ),
    ).toEqual({ kind: "answered" });
  });

  it("reads a succeeding Codex MCP call's completion off the facts, since it projects no row", () => {
    // CANARY: ignore `facts.toolAnswered` and a Codex agent's MCP call stays
    // named as running through the reasoning that follows it.
    expect(stepUpdateForLine(line(null, { toolAnswered: true }))).toEqual({ kind: "answered" });
    expect(stepUpdateForLine(line(null))).toBeNull();
  });

  it("names a Codex web search as answered outright, because it is projected on completion", () => {
    const update = stepUpdateForLine(
      line({ t: "02:10", ev: "tool", tag: "web_search", name: "web_search", text: "sqlite fts5" }),
    );
    expect(update).toEqual({ kind: "tool", step: "composing · web_search · sqlite fts5 answered" });
  });

  it("still ignores command output that names no tool", () => {
    expect(stepUpdateForLine(line({ t: "02:10", ev: "out", tag: "stdout", text: "…" }))).toBeNull();
    expect(stepUpdateForLine(line({ t: "02:10", ev: "text", tag: "assistant", text: "hi" }))).toBeNull();
  });
});

describe("answeredStep (ruling 348)", () => {
  it("leads with what the run is doing now and keeps the finished call for context", () => {
    expect(answeredStep("Bash · npm test")).toBe("composing · Bash · npm test answered");
  });

  it("is idempotent, so a second result row cannot stack the prefix", () => {
    // CANARY: drop the startsWith guard — "composing · composing · …".
    const once = answeredStep("Bash · npm test");
    expect(answeredStep(once)).toBe(once);
  });

  it("keeps the word 'answered' inside the 120-char cap by trimming the call, not the verdict", () => {
    const long = `mcp__viberr_controller__create_goal · ${"x".repeat(120)}`;
    const step = answeredStep(long);
    expect(step.length).toBeLessThanOrEqual(120);
    expect(step.startsWith("composing · mcp__viberr_controller__create_goal · ")).toBe(true);
    expect(step.endsWith("… answered")).toBe(true);
  });
});
