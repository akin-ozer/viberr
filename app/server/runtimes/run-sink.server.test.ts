import { randomBytes } from "node:crypto";
import type { RunFailureFacts } from "~/shared/run-failure";
import { readFileSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LogLine } from "~/features/runtime/runtime-types";
import { closeDb, shutdownDatabase } from "~/server/db/sqlite.server";
import { logger } from "~/server/logging/logger.server";
import { createTestDbContext, type TestDbContext } from "../../../test-support/test-db";
import { setupTestStore, type TestStore } from "../../../test-support/test-store";
import type { EmittedLine, RunSpec } from "./adapter.server";
import {
  latestBackendRateLimits,
  parseQuotaResetAt,
} from "./backend-quota.server";
import { createLineRedactor, createRunSink } from "./run-sink.server";
import { listRunLines, rawLogPath, upsertRun, getRun } from "./run-store.server";

/**
 * P13-U-1: output-side secret redaction at the sink.
 *
 * Input-side isolation is real (`filteredSpawnEnv` strips every
 * credential-shaped variable from both spawn envs) — but the app then
 * deliberately re-adds ONE credential to the agent's child env, and Claude has
 * no counterpart to Codex's shell-env policy. So a tool call that printed its
 * environment landed the live key verbatim in a member-visible console, in the
 * `{ } raw` toggle, and in the persisted `.jsonl`.
 *
 * Ruling 137 moved that one credential out of this process's environment: it is
 * the run PRINCIPAL's own, sealed in `user_backend_credentials` and opened per
 * run, so the env sweep alone can no longer see it. `createRunSink(db, spec,
 * { secrets })` is how the value reaches the redactor, and it is now the
 * load-bearing half — the key belongs to one person while the run console is
 * visible to every project member.
 */

let ctx: TestDbContext;
let store: TestStore;

const SAVED = {
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  CODEX_ACCESS_TOKEN: process.env.CODEX_ACCESS_TOKEN,
  GIT_TERMINAL_PROMPT: process.env.GIT_TERMINAL_PROMPT,
  INNER_TOKEN: process.env.INNER_TOKEN,
};

const CLAUDE_KEY = "sk-ant-api03-VERYSECRETVALUE0123456789abcdef";
const CODEX_TOKEN = "codex-access-token-0123456789abcdef";
/**
 * The ruling-137 shape: a credential that exists ONLY in a sealed row and in
 * the one run's spawn env, never in this process's environment. Deliberately a
 * ChatGPT-workspace ACCESS TOKEN rather than an `sk-…` key: the token patterns
 * would have caught an `sk-` prefix on sight, and then this file would be
 * proving the pattern layer works rather than the per-run seam.
 */
const PERSONAL_TOKEN = "cwt-arda-workspace-0123456789abcdefghij";

beforeEach(() => {
  ctx = createTestDbContext();
  store = setupTestStore(ctx);
  process.env.ANTHROPIC_API_KEY = CLAUDE_KEY;
  process.env.CODEX_ACCESS_TOKEN = CODEX_TOKEN;
  // Credential-SHAPED but a flag, not a secret. Redacting a 1-char value would
  // scrub every "0" out of every log line.
  process.env.GIT_TERMINAL_PROMPT = "0";
});

afterEach(() => {
  for (const [key, value] of Object.entries(SAVED)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  ctx.cleanup();
});

function spec(runId: string): RunSpec {
  return {
    runId,
    projectSlug: store.slug,
    taskKey: "VIB-1",
    threadId: "primary",
    kind: "primary",
    backend: "claude",
    model: "sonnet",
    prompt: "go",
    workdir: store.dataRoot,
  };
}

function emitted(
  display: LogLine,
  raw: string,
  // Fixed by the tests that assert on a record's AGE; `now` otherwise.
  occurredAt: string = new Date().toISOString(),
): EmittedLine {
  return { raw, display, facts: {}, occurredAt };
}

/** A run row + a sink over it. `threadId` is only ever passed when a test needs
 *  a SECOND run on the same task (one thread holds one run row). */
function sinkFor(runId: string, threadId = "primary") {
  upsertRun(store.db, {
    id: runId,
    projectSlug: store.slug,
    taskKey: "VIB-1",
    threadId,
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

/** The same row + sink, but carrying the per-run secrets `runCredentialFor`
 *  resolved for the run's principal (ruling 137). */
function sinkWithSecrets(runId: string, secrets: string[], threadId = "primary") {
  upsertRun(store.db, {
    id: runId,
    projectSlug: store.slug,
    taskKey: "VIB-1",
    threadId,
    role: "developer",
    kind: "primary",
    backend: "claude",
    model: "sonnet",
    sdk: "Claude Agent SDK",
    agentProfileId: "dev",
    state: "queued",
  });
  return createRunSink(store.db, spec(runId), { secrets });
}

/**
 * The Claude adapter's live prompt sum over distinct API messages equalled the
 * result's input on every stored run, so a non-empty result BELOW the live sum
 * can only mean the live fold double-counted (an SDK that stopped sending
 * `message.id`). The max fold would then keep the larger, wrong number in
 * silence; the sink says so instead. An errored result carries an empty usage
 * (zeros), which is not that signature.
 */
describe("the sink names a result that lands below the live sum", () => {
  const usageLine = (usage: { input_tokens: number; cached_input_tokens: number; output_tokens: number }, isResult = false): EmittedLine => ({
    raw: JSON.stringify({ type: isResult ? "result" : "assistant" }),
    display: { t: "00:00:00", ev: isResult ? "result" : "text", tag: isResult ? "result" : "assistant", text: "x" },
    facts: isResult
      ? { usage: { input_tokens: usage.input_tokens, cached_input_tokens: usage.cached_input_tokens, output_tokens: usage.output_tokens, outputEstimated: false }, isResult: true }
      : { usage: { input_tokens: usage.input_tokens, cached_input_tokens: usage.cached_input_tokens, output_tokens: usage.output_tokens, outputEstimated: true } },
    occurredAt: new Date().toISOString(),
  });

  it("warns once, and the row keeps the larger figure", () => {
    // Canary: drop the `f.isResult && … < inputTokens` warning in the sink.
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const runId = "run_overshoot";
    const sink = sinkFor(runId);
    sink.line(usageLine({ input_tokens: 1000, cached_input_tokens: 800, output_tokens: 10 }));
    sink.line(usageLine({ input_tokens: 900, cached_input_tokens: 700, output_tokens: 300 }, true));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toBe("run usage: the result's input is below the live sum");
    expect(warn.mock.calls[0]![1]).toMatchObject({ runId, live: 1000, result: 900 });
    // SAFETY: the statement selects two INTEGER NOT NULL columns (0001_baseline)
    // of the row `sinkFor` just upserted under this id.
    const row = store.db.prepare(`SELECT input_tokens, output_tokens FROM agent_runs WHERE id = ?`).get(runId) as { input_tokens: number; output_tokens: number };
    expect(row).toEqual({ input_tokens: 1000, output_tokens: 300 });
    warn.mockRestore();
  });

  it.each([
    ["an errored result's empty usage", { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 }],
    ["a result that matches the live sum", { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 300 }],
  ] as const)("stays quiet for %s", (_name, usage) => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const sink = sinkFor("run_quiet");
      sink.line(usageLine({ input_tokens: 1000, cached_input_tokens: 800, output_tokens: 10 }));
      sink.line(usageLine(usage, true));
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

/**
 * F35-1 (pass 35): the Claude adapter's live output is an ESTIMATE from the
 * streamed text (`outputEstimated: true`). It folds by max like every other
 * live figure, but the provider's own total REPLACES it (an estimate may
 * overshoot, and max would keep the wrong number for good) and stamps
 * `usage_final = 1` on the row, which is what the projection and Insights read
 * to tell an estimate from a total.
 */
describe("F35-1: an estimated output is a lower bound, the provider's figure replaces it", () => {
  const line = (
    usage: { input_tokens: number; cached_input_tokens: number; output_tokens: number; outputEstimated: boolean },
    isResult = false,
  ): EmittedLine => ({
    raw: JSON.stringify({ type: isResult ? "result" : "assistant" }),
    display: { t: "00:00:00", ev: isResult ? "result" : "text", tag: isResult ? "result" : "assistant", text: "x" },
    facts: isResult ? { usage, isResult: true } : { usage },
    occurredAt: new Date().toISOString(),
  });
  const rowOf = (runId: string) =>
    // SAFETY: the statement selects INTEGER NOT NULL columns (0001_baseline) of
    // the row `sinkFor` just upserted under this id.
    store.db.prepare(`SELECT output_tokens, usage_final FROM agent_runs WHERE id = ?`).get(runId) as { output_tokens: number; usage_final: number };

  it("a result BELOW the live estimate replaces it and marks the row final", () => {
    // Canary: restore `Math.max` for the result arm and the row keeps 1200.
    const sink = sinkFor("run_estimate_high");
    sink.line(line({ input_tokens: 1000, cached_input_tokens: 800, output_tokens: 1200, outputEstimated: true }));
    expect(rowOf("run_estimate_high")).toEqual({ output_tokens: 1200, usage_final: 0 });
    sink.line(line({ input_tokens: 1000, cached_input_tokens: 800, output_tokens: 900, outputEstimated: false }, true));
    expect(rowOf("run_estimate_high")).toEqual({ output_tokens: 900, usage_final: 1 });
  });

  it("estimates fold by max and never mark the row final", () => {
    const sink = sinkFor("run_estimate_fold");
    sink.line(line({ input_tokens: 1000, cached_input_tokens: 800, output_tokens: 1200, outputEstimated: true }));
    sink.line(line({ input_tokens: 1000, cached_input_tokens: 800, output_tokens: 1000, outputEstimated: true }));
    expect(rowOf("run_estimate_fold")).toEqual({ output_tokens: 1200, usage_final: 0 });
  });

  it("an errored result's empty usage leaves the estimate and the flag alone", () => {
    const sink = sinkFor("run_estimate_empty");
    sink.line(line({ input_tokens: 1000, cached_input_tokens: 800, output_tokens: 1200, outputEstimated: true }));
    sink.line(line({ input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, outputEstimated: false }, true));
    expect(rowOf("run_estimate_empty")).toEqual({ output_tokens: 1200, usage_final: 0 });
  });
});

describe("createLineRedactor", () => {
  it("replaces the credential values this process injects into agent envs", () => {
    const redact = createLineRedactor();
    expect(redact(`ANTHROPIC_API_KEY=${CLAUDE_KEY}`)).toBe(
      "ANTHROPIC_API_KEY=[redacted]",
    );
    expect(redact(`bearer ${CODEX_TOKEN} done`)).toBe("bearer [redacted] done");
  });

  it("redacts token PATTERNS the app never held (a PAT the agent minted itself)", () => {
    const redact = createLineRedactor();
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
    expect(redact("GIT_TERMINAL_PROMPT=0")).toBe("GIT_TERMINAL_PROMPT=0");
  });

  /**
   * Ruling 137: the run's own secret. A personal API key is sealed in
   * `user_backend_credentials` and decrypted for exactly one run, so it is
   * never in `process.env` — the env sweep above cannot know it, and without
   * this seam the first `env` a model ran would print one person's key into a
   * console every project member can read.
   */
  it("redacts the PER-RUN secrets the env sweep cannot see", () => {
    // Proof the env sweep alone misses it: the value is in no variable here,
    // and no token pattern claims it either.
    expect(createLineRedactor()(PERSONAL_TOKEN)).toBe(PERSONAL_TOKEN);
    const redact = createLineRedactor([PERSONAL_TOKEN]);
    expect(redact(`CODEX_ACCESS_TOKEN=${PERSONAL_TOKEN}`)).toBe(
      "CODEX_ACCESS_TOKEN=[redacted]",
    );
    // The env-held credentials keep being redacted alongside it.
    expect(redact(`x ${CLAUDE_KEY} y`)).toBe("x [redacted] y");
  });

  it("holds the per-run secrets to the same length floor as the env sweep", () => {
    // A short "secret" is a flag or a fixture stub; redacting it would scrub
    // ordinary prose, and no provider issues a credential this short.
    const redact = createLineRedactor(["short", PERSONAL_TOKEN]);
    expect(redact("the short answer")).toBe("the short answer");
    expect(redact(`key ${PERSONAL_TOKEN} here`)).toBe("key [redacted] here");
  });

  it("sorts a per-run secret against the env values longest-first", () => {
    // One credential CONTAINING another (a token and its prefix) must be
    // replaced whole, or the longer value leaks its tail.
    process.env.INNER_TOKEN = PERSONAL_TOKEN.slice(0, 20);
    const redact = createLineRedactor([PERSONAL_TOKEN]);
    expect(redact(`v=${PERSONAL_TOKEN}`)).toBe("v=[redacted]");
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

  it("scrubs the PRINCIPAL's own credential, which lives only in the sealed row", () => {
    // Ruling 137's leak path: the run bills one person, its child env carries
    // that person's credential, and the console is visible to every project
    // member.
    const sink = sinkWithSecrets("run_personal", [PERSONAL_TOKEN]);
    sink.markRunning();
    const text = `CODEX_ACCESS_TOKEN=${PERSONAL_TOKEN}\nPATH=/usr/bin`;
    sink.line(
      emitted(
        { t: "00:00:01", ev: "out", tag: "tool_result", text },
        JSON.stringify({ type: "tool_result", content: text }),
      ),
    );

    const [line] = listRunLines(store.db, "run_personal");
    expect(line!.display.text).not.toContain(PERSONAL_TOKEN);
    expect(line!.display.text).toContain("CODEX_ACCESS_TOKEN=[redacted]");
    expect(line!.raw).not.toContain(PERSONAL_TOKEN);
    const onDisk = readFileSync(rawLogPath("claude", "run_personal"), "utf8");
    expect(onDisk).not.toContain(PERSONAL_TOKEN);
    expect(onDisk).toContain("[redacted]");
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

/**
 * D5 (pass 31) — the other half of quota telemetry.
 *
 * `rate_limit_event` is a Claude-only channel, so an already-spent Codex
 * subscription produced no reading at all: /insights read "no reading yet" for
 * a backend that had refused every run for days, while the failure the human
 * had just read carried both the limit and the date it reopens. The sink sees
 * that failure line, so it is where the fact is captured.
 */
describe("quota exhaustion from a refused run (D5)", () => {
  const CODEX_REFUSAL =
    "Codex usage limit was reached. Retry after the subscription limit resets." +
    "\n\nThe provider reported: You've hit your usage limit. To continue using " +
    "Codex, start a free trial of Plus today, or try again at Sep 18th, 2026 5:20 PM.";

  /** V4: the SAME class (`·quota`) both classifiers give a spent subscription —
   *  but the provider's sentence is transient back-pressure that clears in
   *  seconds, and it names no window at all. */
  const TRANSIENT_429 =
    "The Claude model is over its usage quota. Retry after the limit resets." +
    '\n\nThe provider reported: 429 {"type":"error","error":{"type":' +
    '"rate_limit_error","message":"Number of request tokens has exceeded your ' +
    'per-minute rate limit"}}';

  /** A genuinely spent window whose sentence names NO reset date. */
  const UNDATED_REFUSAL =
    "Codex usage limit was reached. Retry after the subscription limit resets." +
    "\n\nThe provider reported: You've hit your usage limit. To continue using " +
    "Codex, start a free trial of Plus today.";

  /**
   * The block's frozen clock: the morning of the day `CODEX_REFUSAL` names,
   * seven hours before the 17:20 UTC instant it resolves to. A line is observed
   * at it, and a read that is not ABOUT expiry happens at it, so the reader's
   * expiry arms (`exhaustionExpired`) stay out of the tests that record and
   * retire the flag. Reading on the wall clock instead is what failed three of
   * them on 2026-09-20: the fixture's reset plus `QUOTA_RESET_GRACE_MS` had
   * passed the evening before, and the reader — correctly — retired the record
   * before the assertion looked at it. A test that IS about expiry passes its
   * own instants. CANARY: default `nowIso` back to `undefined` (the wall
   * clock) and those three tests fail again on any day after 2026-09-19.
   */
  const FROZEN_NOW = "2026-09-18T10:00:00.000Z";

  function quotaFor(backend: "claude" | "codex", nowIso: string = FROZEN_NOW) {
    return latestBackendRateLimits(store.db, nowIso).find(
      (q) => q.backend === backend,
    )!;
  }

  /**
   * F32-4 (pass 32). Live: the seeded Codex refresh token had already been
   * consumed elsewhere, the first Codex run died at turn 0 with "Your access
   * token could not be refreshed", and both `/resources/health` (`backends`)
   * and the controller's `instance_health` kept saying "codex · real · verified
   * via file-based credential" — presence is not validity. The rejected
   * credential is recorded off the classifiers' `·auth` class exactly the way
   * quota exhaustion rides `·quota`, and only a completed run retires it.
   */
  it("records a rejected credential off a classified ·auth line and retires it on a completed run", () => {
    const runId = `run_auth_${randomBytes(6).toString("hex")}`;
    const sink = sinkFor(runId);
    sink.markRunning();
    try {
      expect(quotaFor("claude").credentialRefused).toBeNull();
      sink.line(
        emitted(
          {
            t: "10:00:00",
            ev: "err",
            tag: "run·error·auth",
            text:
              "Codex authentication failed. Review the configured subscription credential." +
              "\n\nThe provider reported: Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.",
          },
          "{}",
        ),
      );
      const refused = quotaFor("claude").credentialRefused;
      expect(refused).toBeTruthy();
      expect(refused!.runId).toBe(runId);
      expect(refused!.providerText).toContain("refresh token was already used");
      // A transient failure of any other class records nothing here.
      sink.line(
        emitted(
          { t: "10:00:01", ev: "err", tag: "run·error·unknown", text: "boom" },
          "{}",
        ),
      );
      expect(quotaFor("claude").credentialRefused!.runId).toBe(runId);
      // The re-probe is a real run that COMPLETES on the backend.
      sink.finalize({ outcome: "finished", effectiveBackend: "claude" });
      expect(quotaFor("claude").credentialRefused).toBeNull();
    } finally {
      rmSync(rawLogPath("claude", runId), { force: true });
    }
  });

  it("records the exhaustion off a classified ·quota line, with its evidence", () => {
    const runId = `run_quota_${randomBytes(6).toString("hex")}`;
    const sink = sinkFor(runId);
    sink.markRunning();
    try {
      expect(quotaFor("claude").exhausted).toBeNull();
      sink.line(
        emitted(
          { t: "10:00:00", ev: "err", tag: "run·error·quota", text: CODEX_REFUSAL },
          "{}",
          FROZEN_NOW,
        ),
      );
      const row = quotaFor("claude");
      // The flag is its OWN record: no utilization number was invented for it.
      expect(row.reading).toBeNull();
      expect(row.exhausted).toBeTruthy();
      expect(row.exhausted!.runId).toBe(runId);
      expect(row.exhausted!.providerText).toContain("usage limit");
      expect(row.exhausted!.resetsAt).toBe(parseQuotaResetAt(CODEX_REFUSAL)!.at);
      // V9: the record says HOW the instant was derived, so the reader can be
      // conservative about it and the panel can render it honestly.
      expect(row.exhausted!.resetsAtPrecision).toBe("prose");
    } finally {
      rmSync(rawLogPath("claude", runId), { force: true });
    }
  });

  /**
   * V4 (pass 31). Both classifiers fold `rate limit` / `too many requests` /
   * `429` into the SAME `quota` class as a spent subscription window. A
   * momentary 429 therefore recorded an exhaustion — with no reset instant to
   * retire it — and /insights read "usage limit reached" at 100% until some
   * later run on that backend happened to finish. The class is not the
   * evidence; the provider's own sentence is.
   */
  it("does not record transient rate limiting, even on a ·quota-classified line", () => {
    const runId = `run_429_${randomBytes(6).toString("hex")}`;
    const sink = sinkFor(runId);
    sink.markRunning();
    try {
      sink.line(
        emitted(
          { t: "10:00:00", ev: "err", tag: "run·error·quota", text: TRANSIENT_429 },
          "{}",
          FROZEN_NOW,
        ),
      );
      // CANARY: have `quotaExhaustionEvidence` return the sentence
      // unconditionally and this momentary 429 becomes a spent window.
      expect(quotaFor("claude").exhausted).toBeNull();
      // …while the same class carrying a real usage-limit sentence still lands.
      sink.line(
        emitted(
          { t: "10:00:01", ev: "err", tag: "run·error·quota", text: CODEX_REFUSAL },
          "{}",
          FROZEN_NOW,
        ),
      );
      expect(quotaFor("claude").exhausted).toBeTruthy();
    } finally {
      rmSync(rawLogPath("claude", runId), { force: true });
    }
  });

  /**
   * V4: a record naming no reset instant used to be retired by nothing but a
   * later COMPLETED run on the same backend, so on an instance where the next
   * run never came it claimed a spent window forever. Provider windows are
   * hours; past the TTL the record is stale evidence.
   */
  it("expires an exhaustion record that named no reset instant, on age alone", () => {
    const runId = `run_undated_${randomBytes(6).toString("hex")}`;
    const sink = sinkFor(runId);
    sink.markRunning();
    const observedAt = "2026-08-31T09:00:00.000Z";
    try {
      sink.line(
        emitted(
          { t: "09:00:00", ev: "err", tag: "run·error·quota", text: UNDATED_REFUSAL },
          "{}",
          observedAt,
        ),
      );
      expect(quotaFor("claude", observedAt).exhausted!.resetsAt).toBeNull();
      // Five hours later it is still the best evidence anyone has…
      expect(quotaFor("claude", "2026-08-31T14:00:00.000Z").exhausted).toBeTruthy();
      // …and past the TTL it is not evidence of anything. CANARY: drop the
      // `observedAt + UNDATED_EXHAUSTION_TTL_MS` arm of `exhaustionExpired` and
      // this record stands until some later run happens to finish.
      expect(quotaFor("claude", "2026-08-31T16:00:00.000Z").exhausted).toBeNull();
    } finally {
      rmSync(rawLogPath("claude", runId), { force: true });
    }
  });

  /**
   * V9: a prose reset is a wall clock in the ACCOUNT's timezone, resolved here
   * in UTC — which can sit up to 12 hours before the true instant. Retiring the
   * record at that derived moment would announce a reopened window while the
   * provider is still refusing every run, so the grace window is spent instead.
   * A provider-emitted epoch needs no such slack and gets none.
   */
  it("holds a prose-derived reset through the grace window", () => {
    const runId = `run_prose_${randomBytes(6).toString("hex")}`;
    const sink = sinkFor(runId);
    sink.markRunning();
    try {
      sink.line(
        emitted(
          { t: "10:00:00", ev: "err", tag: "run·error·quota", text: CODEX_REFUSAL },
          "{}",
        ),
      );
      // 17:20 UTC on the 18th is the derived instant; an hour past it the
      // record stands, because the account may be as far west as UTC-12.
      // CANARY: set `QUOTA_RESET_GRACE_MS` to 0 and the panel announces a
      // reopened window while the provider is still refusing runs.
      expect(quotaFor("claude", "2026-09-18T18:20:00.000Z").exhausted).toBeTruthy();
      // A full day later no real timezone can still be inside the window.
      expect(quotaFor("claude", "2026-09-19T18:20:00.000Z").exhausted).toBeNull();
    } finally {
      rmSync(rawLogPath("claude", runId), { force: true });
    }
  });

  it("retires a provider-EMITTED reset instant to the second, with no grace", () => {
    const runId = `run_exact_${randomBytes(6).toString("hex")}`;
    const sink = sinkFor(runId);
    sink.markRunning();
    try {
      // The Claude shape: a unix epoch (2026-09-18T14:20:00Z) the provider
      // computed itself, so the moment it names is the moment it means.
      sink.line(
        emitted(
          {
            t: "10:00:00",
            ev: "err",
            tag: "run·error·quota",
            text:
              "The Claude account is over its usage quota." +
              "\n\nThe provider reported: Claude AI usage limit reached|1789741200",
          },
          "{}",
        ),
      );
      const stored = quotaFor("claude", "2026-09-18T14:19:00.000Z").exhausted;
      expect(stored!.resetsAtPrecision).toBe("exact");
      // CANARY: give the `exact` arm of `exhaustionExpired` the prose grace and
      // this record outlives the instant the provider itself computed.
      expect(quotaFor("claude", "2026-09-18T14:21:00.000Z").exhausted).toBeNull();
    } finally {
      rmSync(rawLogPath("claude", runId), { force: true });
    }
  });

  it("ignores a failure of any OTHER class, and prose that merely says the words", () => {
    const runId = `run_notquota_${randomBytes(6).toString("hex")}`;
    const sink = sinkFor(runId);
    sink.markRunning();
    try {
      // An auth failure is not an exhausted window.
      sink.line(
        emitted(
          { t: "10:00:00", ev: "err", tag: "run·error·auth", text: "credential rejected" },
          "{}",
        ),
      );
      // …and an agent that PRINTS the sentence cannot mark its own backend:
      // the class rides the tag, and this is ordinary output.
      sink.line(
        emitted(
          { t: "10:00:01", ev: "out", tag: "assistant", text: CODEX_REFUSAL },
          "{}",
        ),
      );
      expect(quotaFor("claude").exhausted).toBeNull();
    } finally {
      rmSync(rawLogPath("claude", runId), { force: true });
    }
  });

  it("a COMPLETED run on that backend retires the flag (the run is the re-probe)", () => {
    const failedId = `run_quota_a_${randomBytes(6).toString("hex")}`;
    const okId = `run_quota_b_${randomBytes(6).toString("hex")}`;
    try {
      const failed = sinkFor(failedId);
      failed.markRunning();
      failed.line(
        emitted(
          { t: "10:00:00", ev: "err", tag: "error·quota", text: CODEX_REFUSAL },
          "{}",
          FROZEN_NOW,
        ),
      );
      failed.finalize({ outcome: "error", effectiveBackend: "claude" });
      // An ERRORED run proves nothing about the window — the flag stands.
      expect(quotaFor("claude").exhausted).toBeTruthy();

      const ok = sinkFor(okId, "retry");
      ok.markRunning();
      ok.finalize({ outcome: "finished", effectiveBackend: "claude" });
      expect(quotaFor("claude").exhausted).toBeNull();
    } finally {
      rmSync(rawLogPath("claude", failedId), { force: true });
      rmSync(rawLogPath("claude", okId), { force: true });
    }
  });

  it("retires a record whose provider-named reset instant has passed", () => {
    const runId = `run_quota_old_${randomBytes(6).toString("hex")}`;
    const sink = sinkFor(runId);
    sink.markRunning();
    try {
      sink.line(
        emitted(
          {
            t: "10:00:00",
            ev: "err",
            tag: "error·quota",
            text:
              "The Claude account is over its usage quota." +
              "\n\nThe provider reported: usage limit. try again at Jan 2nd, 2020 5:20 PM.",
          },
          "{}",
        ),
      );
      // Stored…
      expect(
        latestBackendRateLimits(store.db, "2019-12-01T00:00:00.000Z").find(
          (q) => q.backend === "claude",
        )!.exhausted,
      ).toBeTruthy();
      // …and gone once the window the provider named is over. No sweep, no
      // clearing job: the reader simply stops asserting what it cannot support.
      expect(
        latestBackendRateLimits(store.db, "2026-08-31T00:00:00.000Z").find(
          (q) => q.backend === "claude",
        )!.exhausted,
      ).toBeNull();
    } finally {
      rmSync(rawLogPath("claude", runId), { force: true });
    }
  });
});

/**
 * Ruling 160(a) (pass 34): the quota store records the STRUCTURED refusal
 * (a rejected window on the terminal line's `failure` record) and whose
 * account it was. Canaries: delete the `failure` clause from the exhaustion
 * gate; gate on `window` instead of `windowRejected`; remove the clock arm;
 * stop reading the run's `credential_user_id`.
 */
describe("ruling 161(b): a Codex line's usage reading", () => {
  it("is stored as the codex backend's reading, naming the account that ran it", () => {
    const runId = `run_codex_rl_${randomBytes(6).toString("hex")}`;
    upsertRun(store.db, {
      id: runId, projectSlug: store.slug, taskKey: "VIB-1", threadId: "primary", role: "developer", kind: "primary",
      backend: "codex", model: "gpt-6-luna", sdk: "Codex SDK", agentProfileId: "dev", state: "queued",
      credentialUserId: store.users.arda.id,
    });
    const sink = createRunSink(store.db, { ...spec(runId), backend: "codex", model: "gpt-6-luna" });
    sink.markRunning();
    try {
      const reading = {
        status: "allowed",
        rateLimitType: "seven_day",
        utilization: 0.42,
        resetsAt: 1_791_333_093,
        isUsingOverage: false,
        windows: [
          { rateLimitType: "five_hour", utilization: 0.12, resetsAt: 1_790_800_000 },
          { rateLimitType: "seven_day", utilization: 0.42, resetsAt: 1_791_333_093 },
        ],
      };
      sink.line({ ...emitted({ t: "13:00:00", ev: "tool", tag: "codex·tool", text: "npm test" }, "{}", "2026-09-30T13:00:00.000Z"), facts: { rateLimit: reading } });
      // CANARY: record the reading for Claude runs only and Profile's Codex
      // card has nothing to show before a refusal.
      // CANARY (ruling 161(b)): drop `windows` from the stored schema and the
      // five-hour figure never reaches instance_health.
      const row = latestBackendRateLimits(store.db, "2026-09-30T13:01:00.000Z").find((q) => q.backend === "codex")!;
      expect(row.reading).toMatchObject({ ...reading, observedAt: "2026-09-30T13:00:00.000Z", credentialUserId: store.users.arda.id });
    } finally {
      rmSync(rawLogPath("codex", runId), { force: true });
    }
  });
});

describe("ruling 160(a): structured refusals and the principal", () => {
  const facts = (over: Partial<RunFailureFacts>): RunFailureFacts => ({
    kind: "quota", resetsAt: null, window: null, windowRejected: false, apiError: null, apiErrorStatus: null, terminalReason: null, origin: null, ...over,
  });
  function principalSink(runId: string) {
    upsertRun(store.db, {
      id: runId, projectSlug: store.slug, taskKey: "VIB-1", threadId: "primary", role: "developer", kind: "primary",
      backend: "claude", model: "sonnet", sdk: "Claude Agent SDK", agentProfileId: "dev", state: "queued",
      credentialUserId: store.users.arda.id,
    });
    return createRunSink(store.db, spec(runId));
  }
  const quotaFor = (nowIso?: string) => latestBackendRateLimits(store.db, nowIso).find((q) => q.backend === "claude")!;

  it("records exhaustion off the err line's rejected-window facts even when the provider sentence names no limit word", () => {
    const runId = `run_rej_${randomBytes(6).toString("hex")}`;
    const sink = principalSink(runId);
    sink.markRunning();
    try {
      sink.line(emitted({
        t: "10:00:00", ev: "err", tag: "run·error·quota",
        text: "The Claude account is over its usage quota: its five hour window is spent.",
        failure: facts({ windowRejected: true, window: "five_hour", resetsAt: "2026-09-07T11:50:00.000Z", apiErrorStatus: 429 }),
      }, "{}", "2026-09-07T09:00:00.000Z"));
      const row = quotaFor("2026-09-07T09:01:00.000Z");
      expect(row.exhausted).toBeTruthy();
      expect(row.exhausted!.resetsAt).toBe(Date.UTC(2026, 8, 7, 11, 50) / 1000);
      expect(row.exhausted!.resetsAtPrecision).toBe("exact");
      // Only the provider half is stored: no marker here, so the window fact.
      expect(row.exhausted!.providerText).toBe("five hour window rejected by the provider");
      expect(row.exhausted!.providerText).not.toContain("Retry");
      // …and whose account it was.
      expect(row.exhausted!.credentialUserId).toBe(store.users.arda.id);
      expect(row.exhausted!.credentialLabel).toBeTruthy();
    } finally {
      rmSync(rawLogPath("claude", runId), { force: true });
    }
  });

  it("a transient 429 with facts attached but no REJECTED window still records nothing", () => {
    const runId = `run_t429_${randomBytes(6).toString("hex")}`;
    const sink = principalSink(runId);
    sink.markRunning();
    try {
      sink.line(emitted({
        t: "10:00:00", ev: "err", tag: "run·error·quota",
        text: "The Claude account is over its usage quota.\n\nThe provider reported: 429 rate_limit_error per-minute rate limit",
        failure: facts({ windowRejected: false, window: "five_hour", apiErrorStatus: 429 }),
      }, "{}"));
      expect(quotaFor().exhausted).toBeNull();
    } finally {
      rmSync(rawLogPath("claude", runId), { force: true });
    }
  });

  it("a clock-derived reset is stored as `clock` and retired with the prose grace", () => {
    // A clock-derived instant is retired with the prose grace, never at the minute.
    const runId = `run_clock_${randomBytes(6).toString("hex")}`;
    const sink = principalSink(runId);
    sink.markRunning();
    try {
      sink.line(emitted({
        t: "10:00:00", ev: "err", tag: "run·error·quota",
        text: "The Claude account is over its usage quota.\n\nThe provider reported: You've hit your session limit · resets 11:50am (UTC)",
      }, "{}", "2026-09-07T09:00:00.000Z"));
      expect(quotaFor("2026-09-07T09:01:00.000Z").exhausted).toMatchObject({ resetsAtPrecision: "clock", providerText: "You've hit your session limit · resets 11:50am (UTC)" });
      expect(quotaFor("2026-09-07T12:00:00.000Z").exhausted).toBeTruthy();
      expect(quotaFor("2026-09-09T12:00:00.000Z").exhausted).toBeNull();
    } finally {
      rmSync(rawLogPath("claude", runId), { force: true });
    }
  });

  it("a credential refusal names the account it billed, and a run with no principal names none", () => {
    const runId = `run_auth_p_${randomBytes(6).toString("hex")}`;
    const sink = principalSink(runId);
    sink.markRunning();
    try {
      sink.line(emitted({ t: "10:00:00", ev: "err", tag: "run·error·auth", text: "refused\n\nThe provider reported: token revoked" }, "{}"));
      // The refused run ends in error, which leaves the record standing.
      sink.finalize({ outcome: "error", effectiveBackend: "claude" });
      const refused = quotaFor().credentialRefused!;
      expect(refused.credentialUserId).toBe(store.users.arda.id);
      expect(refused.providerText).toBe("token revoked");
    } finally {
      rmSync(rawLogPath("claude", runId), { force: true });
    }

    // The record is the latest refusal's: a run that billed nobody names
    // nobody, not the account the earlier refusal named.
    const bare = `run_auth_np_${randomBytes(6).toString("hex")}`;
    const sink2 = sinkFor(bare, "primary-r1");
    sink2.markRunning();
    try {
      sink2.line(emitted({ t: "10:00:00", ev: "err", tag: "run·error·auth", text: "refused" }, "{}"));
      expect(quotaFor().credentialRefused!.credentialUserId).toBeNull();
    } finally {
      rmSync(rawLogPath("claude", bare), { force: true });
    }
  });
});

/**
 * Ruling 172: the sink folds every cache fact onto the row — the run's writes,
 * the FIRST call (with its temperature and the provider's miss reason), the
 * peak and last prompt (per-call figures only), the TTL bucket and the
 * compactions — and a compaction is a governed fact with an audit row.
 */
describe("ruling 172: the sink folds the prompt-cache record", () => {
  const cacheLine = (
    cache: NonNullable<EmittedLine["facts"]["cache"]>,
    tag = "assistant",
  ): EmittedLine => ({
    raw: JSON.stringify({ type: "assistant" }),
    display: { t: "00:00:00", ev: "text", tag, text: "x" },
    facts: { cache },
    occurredAt: new Date().toISOString(),
  });
  const call = (
    write: number,
    read: number,
    extra: Partial<NonNullable<EmittedLine["facts"]["cache"]>> = {},
  ): NonNullable<EmittedLine["facts"]["cache"]> => ({
    messageId: null,
    promptTokens: 2 + write + read,
    cacheWrite: write,
    cacheRead: read,
    perCall: true,
    ttl: { fiveMinute: 0, oneHour: write },
    missReason: null,
    ...extra,
  });
  const rowOf = (runId: string) =>
    // SAFETY: every selected column is declared on agent_runs (0001_baseline).
    store.db
      .prepare(
        `SELECT cache_write_tokens, first_call_prompt_tokens, first_call_cache_write, first_call_cache_read,
                first_call_warm, first_call_miss_reason, cache_ttl_bucket, peak_prompt_tokens,
                last_prompt_tokens, compactions FROM agent_runs WHERE id = ?`,
      )
      .get(runId) as {
      cache_write_tokens: number;
      first_call_prompt_tokens: number | null;
      first_call_cache_write: number | null;
      first_call_cache_read: number | null;
      first_call_warm: number | null;
      first_call_miss_reason: string | null;
      cache_ttl_bucket: string | null;
      peak_prompt_tokens: number;
      last_prompt_tokens: number;
      compactions: number;
    };

  it("the first fact is the first call; writes sum; peak and last fold per call; the TTL bucket follows the writes", () => {
    const sink = sinkFor("run_cache");
    // A cold first call (wrote 14k, read 0) with the provider's reason.
    sink.line(cacheLine(call(14_100, 0, { missReason: "previous_message_not_found" })));
    sink.line(cacheLine(call(2_000, 40_000)));
    sink.line(cacheLine(call(500, 60_000)));
    const row = rowOf("run_cache");
    expect(row).toEqual({
      cache_write_tokens: 16_600,
      first_call_prompt_tokens: 14_102,
      first_call_cache_write: 14_100,
      first_call_cache_read: 0,
      first_call_warm: 0,
      first_call_miss_reason: "previous_message_not_found",
      cache_ttl_bucket: "1h",
      peak_prompt_tokens: 60_502,
      last_prompt_tokens: 60_502,
      compactions: 0,
    });
  });

  it("a warm first call reads 1; a later miss reason never overwrites the first call's", () => {
    const sink = sinkFor("run_warm");
    sink.line(cacheLine(call(4_200, 47_900)));
    sink.line(cacheLine(call(300, 50_000, { missReason: "messages_changed" })));
    const row = rowOf("run_warm");
    expect(row.first_call_warm).toBe(1);
    expect(row.first_call_miss_reason).toBeNull();
    expect(row.first_call_cache_read).toBe(47_900);
  });

  it.each([
    ["mixed TTLs read 'mixed'", [{ fiveMinute: 10, oneHour: 0 }, { fiveMinute: 0, oneHour: 10 }], "mixed"],
    ["a 5-minute-only write reads '5m'", [{ fiveMinute: 10, oneHour: 0 }], "5m"],
    ["no TTL split reads null", [null], null],
  ] as const)("%s", (_name, ttls, bucket) => {
    const sink = sinkFor("run_ttl");
    for (const ttl of ttls) sink.line(cacheLine(call(10, 0, { ttl })));
    expect(rowOf("run_ttl").cache_ttl_bucket).toBe(bucket);
  });

  it("a Codex turn total is a first call and a write, never a peak or a last prompt", () => {
    const sink = sinkFor("run_codex_turn");
    sink.line(cacheLine(call(1_500, 21_248, { perCall: false, ttl: null, promptTokens: 26_000 })));
    const row = rowOf("run_codex_turn");
    expect(row.first_call_prompt_tokens).toBe(26_000);
    expect(row.first_call_warm).toBe(1);
    expect(row.cache_write_tokens).toBe(1_500);
    expect(row.peak_prompt_tokens).toBe(0);
    expect(row.last_prompt_tokens).toBe(0);
    // …until the rollout says what the calls carried.
    sink.foldRolloutStats({
      peakPromptTokens: 24_000,
      lastPromptTokens: 22_600,
      compactions: 1,
      firstCall: { promptTokens: 14_000, cacheRead: 0, cacheWrite: 0 },
    });
    const after = rowOf("run_codex_turn");
    expect(after.peak_prompt_tokens).toBe(24_000);
    expect(after.last_prompt_tokens).toBe(22_600);
    expect(after.compactions).toBe(1);
    // The rollout's first call replaces the turn total as the run's first
    // call: one request of 14k with nothing cached is a cold start, whatever
    // the whole turn later read back.
    expect(after.first_call_prompt_tokens).toBe(14_000);
    expect(after.first_call_cache_read).toBe(0);
    expect(after.first_call_warm).toBe(0);
    // Folded by max: a smaller rollout figure never lowers a streamed one.
    sink.foldRolloutStats({ peakPromptTokens: 1, lastPromptTokens: 0, compactions: 0 });
    expect(rowOf("run_codex_turn").peak_prompt_tokens).toBe(24_000);
    expect(rowOf("run_codex_turn").last_prompt_tokens).toBe(22_600);
    // A fold without a first call leaves the recorded one alone.
    expect(rowOf("run_codex_turn").first_call_prompt_tokens).toBe(14_000);
  });

  it("a compaction the rollout reports and the stream never carried is audited at finalize", async () => {
    const { listAuditEvents } = await import("../../../test-support/audit-log");
    upsertRun(store.db, {
      id: "run_rollout_compact",
      projectSlug: store.slug,
      taskKey: "VIB-3",
      threadId: "rollout-compact",
      role: "developer",
      kind: "primary",
      backend: "codex",
      model: "gpt-5.6-terra",
      sdk: "Codex SDK",
      agentName: "Dev",
      agentProfileId: "dev",
      state: "running",
    });
    const sink = createRunSink(store.db, { ...spec("run_rollout_compact"), backend: "codex", taskKey: "VIB-3" });
    const stats = {
      peakPromptTokens: 177_960,
      lastPromptTokens: 26_700,
      compactions: 1,
      compactionEvents: [{ preTokens: 177_960, postTokens: 19_509 }],
    };
    sink.foldRolloutStats(stats);
    expect(rowOf("run_rollout_compact").compactions).toBe(1);
    const audit = listAuditEvents(store.db, { action: "task.agent.compaction" }).filter(
      (e) => e.taskKey === "VIB-3",
    );
    expect(audit).toHaveLength(1);
    // The same rollout folded again (a second finalize read) audits nothing new.
    sink.foldRolloutStats(stats);
    expect(
      listAuditEvents(store.db, { action: "task.agent.compaction" }).filter((e) => e.taskKey === "VIB-3"),
    ).toHaveLength(1);
  });

  it("ruling 174: a completion compaction's fact sets the replay size, and its request adds cost and tokens", () => {
    const sink = sinkFor("run_completion_compact", "completion-compact");
    sink.line(cacheLine(call(2_000, 118_000, { promptTokens: 120_000 })));
    sink.line({
      raw: "",
      display: { t: "00:00:01", ev: "result", tag: "result", text: "done" },
      facts: { isResult: true, costUsd: 4, usage: { input_tokens: 120_000, cached_input_tokens: 118_000, output_tokens: 500, outputEstimated: false } },
      occurredAt: "2026-09-21T12:00:01.000Z",
    });
    expect(rowOf("run_completion_compact").last_prompt_tokens).toBe(120_000);
    sink.line({
      raw: "",
      display: { t: "00:00:02", ev: "meta", tag: "run·compacted·completion", text: "context compacted at the end of the run" },
      facts: { compaction: { trigger: "completion", preTokens: 120_000, postTokens: 18_000 } },
      occurredAt: "2026-09-21T12:00:02.000Z",
    });
    sink.line({
      raw: "",
      display: { t: "00:00:03", ev: "meta", tag: "run·compaction·request", text: "compaction request · $0.70" },
      facts: { costAddUsd: 0.7, usageAdd: { input_tokens: 2_000, cached_input_tokens: 118_000, output_tokens: 4_000 } },
      occurredAt: "2026-09-21T12:00:03.000Z",
    });
    sink.finalize({ outcome: "finished", effectiveBackend: "claude", sessionId: null });
    const row = rowOf("run_completion_compact");
    expect(row.compactions).toBe(1);
    // What a resume replays now: the summary, not the history it folded.
    expect(row.last_prompt_tokens).toBe(18_000);
    expect(row.peak_prompt_tokens).toBe(120_000);
    // Increments on top of the result's figures, never a replacement.
    const full = getRun(store.db, "run_completion_compact")!;
    expect(full.total_cost_usd).toBeCloseTo(4.7, 5);
    expect(full.input_tokens).toBe(122_000);
    expect(full.cached_input_tokens).toBe(236_000);
    expect(full.output_tokens).toBe(4_500);
  });

  it("a compaction counts on the row and audits", async () => {
    const { listAuditEvents } = await import("../../../test-support/audit-log");
    upsertRun(store.db, {
      id: "run_compact",
      projectSlug: store.slug,
      taskKey: "VIB-1",
      threadId: "primary",
      role: "developer",
      kind: "primary",
      backend: "claude",
      model: "sonnet",
      sdk: "Claude Agent SDK",
      agentName: "Dev",
      agentProfileId: "dev",
      state: "running",
    });
    const sink = createRunSink(store.db, { ...spec("run_compact"), compactAnchor: "# Context compacted — re-anchor" });
    sink.line({
      raw: JSON.stringify({ type: "system", subtype: "compact_boundary" }),
      display: { t: "00:00:00", ev: "meta", tag: "system·compact_boundary", text: "context compacted (auto)" },
      facts: { compaction: { trigger: "auto", preTokens: 251_000, postTokens: 12_000 } },
      occurredAt: "2026-09-21T12:00:00.000Z",
    });
    expect(rowOf("run_compact").compactions).toBe(1);
    const audit = listAuditEvents(store.db, { action: "task.agent.compaction" });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.taskKey).toBe("VIB-1");
  });
});
