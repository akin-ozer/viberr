import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LogLine } from "~/features/runtime/runtime-types";
import { resetSseBrokerForTests } from "~/server/events/sse-broker.server";
import { createTestDbContext, type TestDbContext } from "../../../test-support/test-db";
import { setupTestStore, type TestStore } from "../../../test-support/test-store";
import type { EmittedLine, RunSpec } from "./adapter.server";
import { createLineRedactor, createRunSink } from "./run-sink.server";
import { listRunLines, rawLogPath, upsertRun } from "./run-store.server";

/**
 * P13-U-1: output-side secret redaction at the sink.
 *
 * Input-side isolation is real (`filteredSpawnEnv` strips every
 * credential-shaped variable from both spawn envs) — but the app then
 * deliberately re-adds the SELECTED provider credential to the agent's child
 * env, and Claude has no counterpart to Codex's shell-env policy. So a tool call
 * that printed its environment landed the live key verbatim in a member-visible
 * console, in the `{ } raw` toggle, and in the persisted `.jsonl`.
 */

let ctx: TestDbContext;
let store: TestStore;

const SAVED = {
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  CODEX_ACCESS_TOKEN: process.env.CODEX_ACCESS_TOKEN,
  VIBERR_CLAUDE_USE_CLI_AUTH: process.env.VIBERR_CLAUDE_USE_CLI_AUTH,
};

const CLAUDE_KEY = "sk-ant-api03-VERYSECRETVALUE0123456789abcdef";
const CODEX_TOKEN = "codex-access-token-0123456789abcdef";

beforeEach(() => {
  ctx = createTestDbContext();
  store = setupTestStore(ctx);
  resetSseBrokerForTests();
  process.env.ANTHROPIC_API_KEY = CLAUDE_KEY;
  process.env.CODEX_ACCESS_TOKEN = CODEX_TOKEN;
  // Credential-SHAPED but a flag, not a secret. Redacting a 1-char value would
  // scrub every "1" out of every log line.
  process.env.VIBERR_CLAUDE_USE_CLI_AUTH = "1";
});

afterEach(() => {
  for (const [key, value] of Object.entries(SAVED)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetSseBrokerForTests();
  ctx.cleanup();
});

function spec(runId: string): RunSpec {
  return {
    runId,
    projectSlug: store.slug,
    taskKey: "VIB-1",
    threadId: "primary",
    role: "developer",
    kind: "primary",
    backend: "claude",
    model: "sonnet",
    prompt: "go",
    workdir: store.dataRoot,
  };
}

function emitted(display: LogLine, raw: string): EmittedLine {
  return { raw, display, facts: {}, occurredAt: new Date().toISOString() };
}

/** A run row + a sink over it. */
function sinkFor(runId: string) {
  upsertRun(store.db, {
    id: runId,
    projectSlug: store.slug,
    taskKey: "VIB-1",
    threadId: "primary",
    role: "developer",
    kind: "primary",
    backend: "claude",
    model: "sonnet",
    sdk: "Claude Agent SDK",
    agentProfileId: "dev",
    state: "queued",
  });
  return createRunSink(store.db, spec(runId));
}

describe("createLineRedactor", () => {
  it("replaces the credential values this process injects into agent envs", () => {
    const redact = createLineRedactor();
    expect(redact(`ANTHROPIC_API_KEY=${CLAUDE_KEY}`)).toBe(
      "ANTHROPIC_API_KEY=[redacted]",
    );
    expect(redact(`bearer ${CODEX_TOKEN} done`)).toBe("bearer [redacted] done");
  });

  it("redacts token SHAPES the app never held (a PAT the agent minted itself)", () => {
    const redact = createLineRedactor({});
    expect(redact("remote: ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")).toBe(
      "remote: [redacted]",
    );
    expect(redact("token github_pat_11ABCDEFG0aaaaaaaaaaaaaaaaaaa")).toBe(
      "token [redacted]",
    );
    expect(redact("OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwx")).toBe(
      "OPENAI_API_KEY=[redacted]",
    );
  });

  it("does not mangle ordinary output", () => {
    const redact = createLineRedactor();
    const prose =
      "Ran 12 tests in 1.4s. See sk-1 and gh_ and token counts (in 4.1k / out 0.3k).";
    // No match at all → the very same string comes back (the cheap path).
    expect(redact(prose)).toBe(prose);
    // A short credential-shaped FLAG value never becomes a redaction pattern.
    expect(redact("VIBERR_CLAUDE_USE_CLI_AUTH=1")).toBe(
      "VIBERR_CLAUDE_USE_CLI_AUTH=1",
    );
  });
});

describe("the sink redacts before it persists", () => {
  it("scrubs the injected key from the DB row, the raw envelope and the .jsonl", () => {
    const sink = sinkFor("run_leak");
    sink.markRunning();
    // The concrete leak path: a Claude tool call that prints its environment.
    const text = `ANTHROPIC_API_KEY=${CLAUDE_KEY}\nCODEX_ACCESS_TOKEN=${CODEX_TOKEN}\nPATH=/usr/bin`;
    sink.line(
      emitted(
        { t: "00:00:01", ev: "out", tag: "tool_result", text },
        JSON.stringify({ type: "tool_result", content: text }),
      ),
    );

    const [line] = listRunLines(store.db, "run_leak");
    expect(line!.display.text).not.toContain(CLAUDE_KEY);
    expect(line!.display.text).not.toContain(CODEX_TOKEN);
    expect(line!.display.text).toContain("ANTHROPIC_API_KEY=[redacted]");
    // The `{ } raw` toggle renders the stored envelope verbatim — scrub it too.
    expect(line!.raw).not.toContain(CLAUDE_KEY);
    expect(line!.raw).toContain("[redacted]");
    // …and the canonical append-only .jsonl (what a downloaded export carries).
    // The sink appends under the ambient data root (no per-run override).
    const onDisk = readFileSync(rawLogPath("claude", "run_leak"), "utf8");
    expect(onDisk).not.toContain(CLAUDE_KEY);
    expect(onDisk).toContain("[redacted]");
    // Everything else survives intact.
    expect(line!.display.text).toContain("PATH=/usr/bin");
  });

  it("keeps the display line parseable and untouched when it holds no secret", () => {
    const sink = sinkFor("run_clean");
    sink.markRunning();
    const display: LogLine = {
      t: "00:00:02",
      ev: "tool",
      tag: "tool_use",
      text: "Bash(npm test)",
      name: "Bash",
      input: { command: "npm test", quoted: 'a "b" \\ c' },
    };
    sink.line(emitted(display, JSON.stringify({ type: "tool_use" })));
    const [line] = listRunLines(store.db, "run_clean");
    expect(line!.display).toEqual(display);
  });

  it("survives a secret embedded in a nested tool input (JSON round-trip)", () => {
    const sink = sinkFor("run_nested");
    sink.markRunning();
    sink.line(
      emitted(
        {
          t: "00:00:03",
          ev: "tool",
          tag: "tool_use",
          text: "Bash(curl)",
          name: "Bash",
          input: { command: `curl -H "Authorization: Bearer ${CLAUDE_KEY}"` },
        },
        JSON.stringify({ type: "tool_use", key: CLAUDE_KEY }),
      ),
    );
    const [line] = listRunLines(store.db, "run_nested");
    const command = (line!.display.input as { command: string }).command;
    expect(command).not.toContain(CLAUDE_KEY);
    expect(command).toContain("Bearer [redacted]");
  });
});
