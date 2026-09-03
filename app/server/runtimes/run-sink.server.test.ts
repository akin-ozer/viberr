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
import {
  latestBackendRateLimits,
  parseQuotaResetAt,
} from "./backend-quota.server";
import { createLineRedactor, createRunSink } from "./run-sink.server";
import { listRunLines, rawLogPath, upsertRun } from "./run-store.server";

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
 * Ruling 121 moved that one credential out of this process's environment: it is
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
};

const CLAUDE_KEY = "sk-ant-api03-VERYSECRETVALUE0123456789abcdef";
const CODEX_TOKEN = "codex-access-token-0123456789abcdef";
/**
 * The ruling-121 shape: a credential that exists ONLY in a sealed row and in
 * the one run's spawn env, never in this process's environment. Deliberately a
 * ChatGPT-workspace ACCESS TOKEN rather than an `sk-…` key: the token patterns
 * would have caught an `sk-` prefix on sight, and then this file would be
 * proving the pattern layer works rather than the per-run seam.
 */
const PERSONAL_TOKEN = "cwt-arda-workspace-0123456789abcdefghij";

beforeEach(() => {
  ctx = createTestDbContext();
  store = setupTestStore(ctx);
  resetSseBrokerForTests();
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
 *  resolved for the run's principal (ruling 121). */
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
    expect(redact("GIT_TERMINAL_PROMPT=0")).toBe("GIT_TERMINAL_PROMPT=0");
  });

  /**
   * Ruling 121: the run's own secret. A personal API key is sealed in
   * `user_backend_credentials` and decrypted for exactly one run, so it is
   * never in `process.env` — the env sweep above cannot know it, and without
   * this seam the first `env` a model ran would print one person's key into a
   * console every project member can read.
   */
  it("redacts the PER-RUN secrets the env sweep cannot see", () => {
    // Proof the env sweep alone misses it: the value is in no variable here,
    // and no token pattern claims it either.
    expect(createLineRedactor()(PERSONAL_TOKEN)).toBe(PERSONAL_TOKEN);
    const redact = createLineRedactor(process.env, [PERSONAL_TOKEN]);
    expect(redact(`CODEX_ACCESS_TOKEN=${PERSONAL_TOKEN}`)).toBe(
      "CODEX_ACCESS_TOKEN=[redacted]",
    );
    // The env-held credentials keep being redacted alongside it.
    expect(redact(`x ${CLAUDE_KEY} y`)).toBe("x [redacted] y");
  });

  it("holds the per-run secrets to the same length floor as the env sweep", () => {
    // A short "secret" is a flag or a fixture stub; redacting it would scrub
    // ordinary prose, and no provider issues a credential this short.
    const redact = createLineRedactor({}, ["short", PERSONAL_TOKEN]);
    expect(redact("the short answer")).toBe("the short answer");
    expect(redact(`key ${PERSONAL_TOKEN} here`)).toBe("key [redacted] here");
  });

  it("sorts a per-run secret against the env values longest-first", () => {
    // One credential CONTAINING another (a token and its prefix) must be
    // replaced whole, or the longer value leaks its tail.
    const redact = createLineRedactor(
      { INNER_TOKEN: PERSONAL_TOKEN.slice(0, 20) },
      [PERSONAL_TOKEN],
    );
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
    // Ruling 121's leak path: the run bills one person, its child env carries
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

  it("a sink built WITHOUT the run's secrets would have persisted it", () => {
    // The canary for the seam itself: drop `{ secrets }` in `launch` and the
    // key rides through, which is exactly what this pair proves is possible.
    const sink = sinkFor("run_nosecrets", "primary-nosec");
    sink.markRunning();
    sink.line(
      emitted(
        { t: "00:00:01", ev: "out", tag: "tool_result", text: PERSONAL_TOKEN },
        JSON.stringify({ type: "tool_result", content: PERSONAL_TOKEN }),
      ),
    );
    expect(listRunLines(store.db, "run_nosecrets")[0]!.display.text).toBe(
      PERSONAL_TOKEN,
    );
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

  function quotaFor(backend: "claude" | "codex", nowIso?: string) {
    return latestBackendRateLimits(store.db, nowIso).find(
      (q) => q.backend === backend,
    )!;
  }

  it("parses both providers' reset clauses, and answers null rather than guessing", () => {
    // Codex: English prose in the ACCOUNT's timezone, with an ordinal suffix
    // that Date.parse rejects outright. V9: the components are resolved in UTC,
    // not in whatever timezone this server happens to run in — Date.parse made
    // the same sentence mean different instants on a container and a laptop.
    // CANARY: build the instant with `new Date(year, month, day, …)` instead of
    // `Date.UTC` and this shifts by the runner's own offset.
    expect(parseQuotaResetAt(CODEX_REFUSAL)).toEqual({
      at: Date.UTC(2026, 8, 18, 17, 20) / 1000,
      precision: "prose",
    });
    // Claude: a bare unix epoch after a pipe — no interpretation, no timezone.
    expect(parseQuotaResetAt("Claude AI usage limit reached|1750000000")).toEqual({
      at: 1_750_000_000,
      precision: "exact",
    });
    // No date named, and prose that only mentions the limit: null, so the card
    // falls back to the observed instant instead of inventing a window.
    expect(
      parseQuotaResetAt("You've hit your usage limit. Upgrade to Plus."),
    ).toBeNull();
    // A word in a month's position that is not a month is not a date.
    expect(parseQuotaResetAt("try again at soon 18, 2026")).toBeNull();
  });

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
            text: "Claude AI usage limit reached|1789741200",
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
            text: "usage limit. try again at Jan 2nd, 2020 5:20 PM.",
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
