import { randomBytes } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LogLine } from "~/features/runtime/runtime-types";
import { closeDb, shutdownDatabase } from "~/server/db/sqlite.server";
import { resetSseBrokerForTests } from "~/server/events/sse-broker.server";
import { logger } from "~/server/logging/logger.server";
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

  it("redacts token PATTERNS the app never held (a PAT the agent minted itself)", () => {
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
    const command = line!.display.input!.command;
    expect(command).not.toContain(CLAUDE_KEY);
    expect(command).toContain("Bearer [redacted]");
  });
});

/**
 * B-FD7: two writers can reach one run — the adapter's own exit and a human's
 * interrupt taking `interruptRun`'s no-live-handle path — and the sink used to
 * let whichever landed last define the outcome.
 */
describe("finalize state precedence", () => {
  const exit = (outcome: "finished" | "error" | "interrupted") => ({
    outcome,
    effectiveBackend: "claude" as const,
    sessionId: "sess_1",
  });

  function runRow(runId: string) {
    return store.db
      .prepare(`SELECT state, finished_at FROM agent_runs WHERE id = ?`)
      .get(runId)!;
  }

  it("does not overwrite a run already recorded as interrupted", () => {
    const sink = sinkFor("run_interrupted");
    sink.markRunning();
    // Another writer stamped the human's stop while the adapter was still alive.
    store.db
      .prepare(`UPDATE agent_runs SET state = 'interrupted', finished_at = ? WHERE id = ?`)
      .run("2026-07-28T10:00:00.000Z", "run_interrupted");

    sink.finalize(exit("finished"));

    const row = runRow("run_interrupted");
    expect(row.state).toBe("interrupted");
    // The recorded finish time is the interrupt's, not this exit's.
    expect(row.finished_at).toBe("2026-07-28T10:00:00.000Z");
    // Facts the exit carried still land.
    expect(
      store.db
        .prepare(`SELECT session_id FROM agent_runs WHERE id = ?`)
        .get("run_interrupted")!.session_id,
    ).toBe("sess_1");
  });

  it("finalizes normally from a live (non-terminal) state", () => {
    const sink = sinkFor("run_live");
    sink.markRunning();
    sink.finalize(exit("error"));
    const row = runRow("run_live");
    expect(row.state).toBe("error");
    expect(row.finished_at).not.toBeNull();
  });

  it("a second finalize never rewrites the first terminal answer", () => {
    const sink = sinkFor("run_double");
    sink.markRunning();
    sink.finalize(exit("finished"));
    const first = runRow("run_double").finished_at;
    sink.finalize(exit("error"));
    expect(runRow("run_double")).toEqual({ state: "finished", finished_at: first });
  });
});

describe("silent line loss is surfaced (B-FD7)", () => {
  it("marks the run's console as incomplete, once, when lines cannot be persisted", () => {
    // Raw transcripts are keyed by run id under the AMBIENT data root, so the
    // id has to be unique per run of this test or the appends accumulate.
    const runId = `run_lossy_${randomBytes(6).toString("hex")}`;
    const sink = sinkFor(runId);
    sink.markRunning();
    // A DB write failure AFTER the successful raw append — the exact divergence
    // shape: emulate it by removing the row `run_log_lines` FKs to.
    store.db.prepare(`DELETE FROM agent_runs WHERE id = ?`).run(runId);
    try {
      sink.line(emitted({ t: "10:00:00", ev: "out", tag: "x", text: "one" }, '{"say":"one"}'));
      sink.line(emitted({ t: "10:00:01", ev: "out", tag: "x", text: "two" }, '{"say":"two"}'));

      const raw = readFileSync(rawLogPath("claude", runId), "utf8")
        .split("\n")
        .filter(Boolean);
      // Both lines still reached the canonical transcript...
      expect(raw.filter((l) => l.includes('"say"'))).toHaveLength(2);
      // ...and the divergence is stated ONCE, not per dropped line.
      const markers = raw.filter((l) => l.includes("line_lost"));
      expect(markers).toHaveLength(1);
      expect(markers[0]).toContain("INCOMPLETE");
    } finally {
      rmSync(rawLogPath("claude", runId), { force: true });
    }
  });
});

/**
 * F21-24 — a shutdown drain is not ten faults.
 *
 * Live (UC-31, `docker restart` mid-Codex-run): SIGTERM closed sqlite while a
 * run was still streaming, and the pipeline kept its stale handle. Every
 * subsequent line produced a "run line persist failed" ERROR plus a "run
 * divergence marker could not be persisted" ERROR — ~10 pairs of the same fact,
 * burying the one line an operator needed. There is nothing to retry: the
 * database will not reopen (see `getDb`'s refusal), the raw `.jsonl` is a plain
 * append and still holds the full stream, and boot finalization already recovers
 * the run ("finalized non-terminal runs at boot: 1").
 */
describe("run lines during a shutdown drain (F21-24)", () => {
  it("collapses to ONE warning and writes no divergence marker", () => {
    const runId = `run_drain_${randomBytes(6).toString("hex")}`;
    const sink = sinkFor(runId);
    sink.markRunning();
    // The same persist failure B-FD7 emulates — but during a shutdown.
    store.db.prepare(`DELETE FROM agent_runs WHERE id = ?`).run(runId);
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const error = vi.spyOn(logger, "error").mockImplementation(() => {});
    try {
      shutdownDatabase();
      for (let i = 0; i < 5; i++) {
        sink.line(emitted({ t: "10:00:00", ev: "out", tag: "x", text: `l${i}` }, `{"n":${i}}`));
      }

      const drainWarnings = warn.mock.calls.filter(([msg]) =>
        msg.includes("the database closed mid-run"),
      );
      expect(drainWarnings).toHaveLength(1);
      // NOT one error per line — that spray is the defect.
      expect(
        error.mock.calls.filter(([msg]) => msg.includes("run line persist failed")),
      ).toHaveLength(0);

      const raw = readFileSync(rawLogPath("claude", runId), "utf8")
        .split("\n")
        .filter(Boolean);
      // The canonical transcript is untouched by any of this…
      expect(raw.filter((l) => l.includes('"n"'))).toHaveLength(5);
      // …and no divergence marker was attempted: writing it would only produce
      // the second half of the per-line error pair.
      expect(raw.filter((l) => l.includes("line_lost"))).toHaveLength(0);
    } finally {
      warn.mockRestore();
      error.mockRestore();
      closeDb(); // clears the shutdown latch for the rest of the suite
      rmSync(rawLogPath("claude", runId), { force: true });
    }
  });

  it("still reports a GENUINE persist failure per line when nothing is shutting down", () => {
    const runId = `run_genuine_${randomBytes(6).toString("hex")}`;
    const sink = sinkFor(runId);
    sink.markRunning();
    store.db.prepare(`DELETE FROM agent_runs WHERE id = ?`).run(runId);
    const error = vi.spyOn(logger, "error").mockImplementation(() => {});
    try {
      sink.line(emitted({ t: "10:00:00", ev: "out", tag: "x", text: "one" }, '{"say":"one"}'));
      expect(
        error.mock.calls.filter(([msg]) => msg.includes("run line persist failed")),
      ).toHaveLength(1);
    } finally {
      error.mockRestore();
      rmSync(rawLogPath("claude", runId), { force: true });
    }
  });
});
