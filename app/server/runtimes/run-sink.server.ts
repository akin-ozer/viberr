import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { LogLine, RunBackend, RunState } from "~/features/runtime/runtime-types";
import { isDatabaseShuttingDown } from "~/server/db/sqlite.server";
import { logger } from "~/server/logging/logger.server";
import type { EmittedLine, RunExit, RunSpec } from "./adapter.server";
import { publishRunLogAppended, publishRunStateChanged } from "./run-events.server";
import { CREDENTIAL_ENV_RE } from "./runtime-registry.server";
import {
  appendRawLine,
  insertRunLine,
  nextSeq,
  patchRun,
  type RunPatch,
} from "./run-store.server";
import {
  REDACTED,
  TOKEN_PATTERN_SOURCE,
} from "~/server/secrets/git-output-redact.server";

/** Terminal run states — reaching one is the run's final answer. */
const TERMINAL_STATES: readonly RunState[] = ["finished", "error", "interrupted"];

/**
 * F21-24: is the projection database gone for good?
 *
 * Shared, because every writer on the run path needs the SAME answer: the sink's
 * line/phase/finalize arms here, and anything that persists on a run's behalf
 * (see `launch` in run-service). A drained database is not a fault to report per
 * write — `getDb` refuses to reopen, the raw `.jsonl` still holds the stream, and
 * boot finalization recovers the run.
 */
export function runPersistDrained(db: DatabaseSync): boolean {
  return isDatabaseShuttingDown() || !db.isOpen;
}

/**
 * B-FD7: the FIRST terminal state a run reaches is its outcome.
 *
 * `finalize` used to overwrite the state unconditionally, so a run another
 * writer had already stamped `interrupted` (the "no live handle" path in
 * `interruptRun`, taken whenever the interrupting process is not the one
 * driving the adapter — the two-processes-one-data-root shape, or a stop issued
 * after a restart) came back as `finished`/`error` when the still-live adapter
 * exited. The recorded human intervention lost to a race with the thing it was
 * stopping. Precedence, not ordering, decides now.
 */
export function resolveTerminalState(
  current: RunState | null,
  desired: RunState,
): RunState {
  return current !== null && TERMINAL_STATES.includes(current) ? current : desired;
}

/** `agent_runs.state` as stored: the column's CHECK constraint admits exactly
 *  these five values, so anything else is not a lifecycle this code can reason
 *  about — and is treated like an unreadable row below. */
const storedRunStateSchema = z.enum([
  "queued",
  "running",
  "finished",
  "error",
  "interrupted",
] as const satisfies readonly RunState[]);

function currentRunState(db: DatabaseSync, runId: string): RunState | null {
  try {
    const row = db.prepare(`SELECT state FROM agent_runs WHERE id = ?`).get(runId);
    const parsed = storedRunStateSchema.safeParse(row?.state);
    return parsed.success ? parsed.data : null;
  } catch {
    // An unreadable row must not stop a run from finalizing; the desired state
    // is then the best information available.
    return null;
  }
}

/** The `err` tag marking a run whose DB projection is missing lines the raw
 *  `.jsonl` has. Mirrors `run·session_missing`: a durable classified line, no
 *  column, no migration. */
export const LINE_LOST_TAG = "run·line_lost";

/**
 * The RunSink turns adapter callbacks into durable state + live SSE. For
 * every emitted line it: (1) redacts secrets from the line (P13-U-1),
 * (2) appends the raw envelope to the canonical .jsonl (truth), (3) inserts a
 * run_log_lines row with the computed display_json, (4) folds
 * usage/cost/turns/session facts into the run row, THEN (5) publishes
 * `run.log-appended` {runId, seq}. Lifecycle transitions publish
 * `run.state-changed`.
 *
 * Ordering matters: persist BEFORE publish, so a client that reacts to the
 * event can always fetch the line it references.
 */

// -------------------------------------------------- output-side redaction

/**
 * P13-U-1: the sink is the ONE place every run-log line passes through, so it
 * is where output-side secret redaction belongs.
 *
 * Input-side isolation is already real — `filteredSpawnEnv` strips every
 * credential-shaped variable from both spawn envs (F10-02) and Codex runs with
 * `shell_environment_policy.inherit: "core"`. But the app then deliberately
 * re-adds the SELECTED provider credential to the agent's child env
 * (`claudeSpawnEnv` / `codexSpawnEnv`), and Claude has no counterpart to Codex's
 * shell-env policy. So one `env`-printing tool call put that credential verbatim
 * into a member-visible console, the `{ } raw` toggle, and the persisted
 * `.jsonl` — the one concrete leak path PRD-8/NFR7 forbid.
 *
 * Two rules, both cheap enough to run per emitted line:
 *   1. exact values — every credential-shaped variable in THIS process's env
 *      (same regex the spawn filter uses), which by construction includes the
 *      values the app injected;
 *   2. token PATTERNS — provider/PAT prefixes that are secrets wherever they
 *      came from (a PAT the agent minted itself, a key a human pasted into a
 *      prompt).
 *
 * Deliberately NOT a generic entropy heuristic: mangling ordinary output is a
 * worse failure than the leak. Nothing else is touched.
 *
 * `REDACTED` and the token PATTERNS are the single canonical copy in
 * `git-output-redact.server` (which scrubs git's own output the same way); this
 * run-log path imports them so the two can never drift.
 */

/**
 * Below this length a credential-shaped variable is a FLAG, not a secret
 * (`VIBERR_CLAUDE_USE_CLI_AUTH=1` matches the name regex). Redacting a 1-char
 * value would scrub every digit out of every log line.
 */
const MIN_SECRET_VALUE_LEN = 12;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build the redactor ONCE per run (in `createRunSink`), not per line: the
 * credential set is whatever this process holds when the run starts, which is
 * exactly what that run's child env received.
 */
export function createLineRedactor(
  env: NodeJS.ProcessEnv = process.env,
): (text: string) => string {
  const values = new Set<string>();
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || value.length < MIN_SECRET_VALUE_LEN) continue;
    if (!CREDENTIAL_ENV_RE.test(key)) continue;
    values.add(value);
  }
  // Longest first so a credential that contains another one is fully replaced.
  const literals = [...values].sort((a, b) => b.length - a.length).map(escapeRegExp);
  const re = new RegExp([...literals, TOKEN_PATTERN_SOURCE].join("|"), "g");
  // `replace` with a /g regex always scans from 0 and returns the SAME string
  // when nothing matched — so the no-secret path costs one scan and no alloc.
  return (text: string) => (text ? text.replace(re, REDACTED) : text);
}

/**
 * Redact the display projection by serializing it once. The marker carries no
 * quote or backslash, so the JSON stays parseable; an unchanged string skips
 * the parse entirely.
 */
function redactDisplay(
  display: LogLine,
  redact: (text: string) => string,
): LogLine {
  const json = JSON.stringify(display);
  const clean = redact(json);
  // SAFETY: `clean` is `display`'s own serialization with secret substrings —
  // which only ever occur INSIDE its string values — swapped for a marker
  // carrying no quote or backslash. The document structure is therefore
  // untouched, so what parses back is the same LogLine with shorter strings.
  return clean === json ? display : (JSON.parse(clean) as LogLine);
}

export function createRunSink(db: DatabaseSync, spec: RunSpec) {
  // Where the raw truth goes: requested backend dir + session id (or run id
  // until the session id lands). We buffer to the run-id file first, since
  // the session id arrives on the init/thread.started line — but to keep it
  // simple and stable we always write under the run id (deterministic path,
  // no rename churn), documented in the phase report.
  let effectiveBackend: RunBackend = spec.backend;
  let sessionId: string | null = spec.resumeSessionId ?? null;
  let started = false;

  // Running usage totals — usage envelopes are cumulative per turn for codex,
  // and aggregate on the final result for claude; we take the max/last so a
  // partial run never regresses the counter (tokens/cost from real envelopes
  // ONLY — no fabrication).
  let turns = 0;
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;
  let totalCostUsd: number | null = null;

  // P13-U-1: built once per run — see createLineRedactor.
  const redact = createLineRedactor();

  const publishState = (state: RunState) => {
    publishRunStateChanged({
      projectSlug: spec.projectSlug,
      taskKey: spec.taskKey,
      runId: spec.runId,
      threadId: spec.threadId,
      state,
    });
  };

  /**
   * F21-24: the database is CLOSED under us (graceful shutdown drained while
   * this run streamed).
   *
   * Live (UC-31, `docker restart` mid-Codex-run) the pipeline kept a stale
   * handle and sprayed ~10 "run line persist failed" + "divergence marker could
   * not be persisted" errors, one pair per streamed line — noise that says the
   * same thing ten times and buries the one fact that matters. It is not a
   * per-line fault and there is nothing to retry: the run is finalized at boot
   * ("finalized non-terminal runs at boot"), and the raw `.jsonl` — a plain
   * append, unaffected by the database — still holds the full stream.
   */
  const persistDrained = () => runPersistDrained(db);
  /** The ONE line this run logs about the drain, however much it loses. */
  let drainWarned = false;
  const warnDrainedOnce = () => {
    if (drainWarned) return;
    drainWarned = true;
    logger.warn(
      "the database closed mid-run — run rows and lines are no longer being persisted; the raw transcript is intact and the run is finalized at boot",
      { runId: spec.runId, taskKey: spec.taskKey },
    );
  };
  /**
   * Run `write` unless the database is already drained, and treat a failure that
   * IS the drain as the drain rather than as a fault.
   *
   * The line path had this from the start; `phase` and `finalize` did not, so a
   * shutdown mid-run still sprayed "run phase persist failed" — one per streamed
   * phase, from `launch`'s own catch — which is the same noise F21-24 removed one
   * arm of. The check runs twice on purpose: before the write (the common case,
   * where nothing is attempted at all) and again after a throw (the database
   * closed between the two). Returns whether the row was actually written, so a
   * caller does not publish an SSE state for a row that does not carry it.
   */
  const persistOrDrain = (write: () => void): boolean => {
    if (persistDrained()) {
      warnDrainedOnce();
      return false;
    }
    try {
      write();
      return true;
    } catch (error) {
      if (persistDrained()) {
        warnDrainedOnce();
        return false;
      }
      throw error;
    }
  };

  /**
   * B-FD7: a persist failure used to be logged to stdout and nothing else — the
   * console silently missed a line the raw `.jsonl` has, while the footer count
   * (read from the DB) claimed completeness. Record the divergence ON the run,
   * once, so a reader of the log sees that it is incomplete. Best-effort by
   * construction: the failure we are reporting may be the same one that stops
   * us reporting it.
   */
  let divergenceReported = false;
  const markDivergent = (cause: unknown) => {
    if (divergenceReported) return;
    // A drained database cannot take the marker either — writing it would only
    // produce the second half of the per-line error pair.
    if (persistDrained()) {
      divergenceReported = true;
      return;
    }
    divergenceReported = true;
    const now = new Date().toISOString();
    const text =
      "At least one line of this run could not be written to the projection database, so this console is INCOMPLETE — the run's raw .jsonl transcript under the data root holds the full stream.";
    const raw = JSON.stringify({
      type: "error",
      source: "viberr",
      reason: "line_lost",
      message: text,
      cause: cause instanceof Error ? cause.message : String(cause),
    });
    try {
      appendRawLine(effectiveBackend, spec.runId, raw);
    } catch {
      // The raw file is the failing half in this branch — the DB marker below
      // is then the only surface left.
    }
    try {
      const seq = nextSeq(db, spec.runId);
      insertRunLine(db, {
        runId: spec.runId,
        seq,
        occurredAt: now,
        raw,
        display: { t: now.slice(11, 19), ev: "err", tag: LINE_LOST_TAG, text },
      });
      publishRunLogAppended({
        projectSlug: spec.projectSlug,
        taskKey: spec.taskKey,
        runId: spec.runId,
        threadId: spec.threadId,
        seq,
      });
    } catch (error) {
      logger.error("run divergence marker could not be persisted", {
        runId: spec.runId,
        err: error instanceof Error ? error : new Error(String(error)),
      });
    }
  };

  return {
    markRunning(startedAtIso?: string) {
      if (started) return;
      started = true;
      const written = persistOrDrain(() => {
        patchRun(db, spec.runId, {
          state: "running",
          startedAt: startedAtIso ?? new Date().toISOString(),
        });
      });
      if (written) publishState("running");
    },

    phase(phase: string | null, step: string | null) {
      persistOrDrain(() => {
        patchRun(db, spec.runId, { phase, step });
      });
    },

    line(line: EmittedLine) {
      try {
        // Capture facts before persisting so the row reflects them.
        const f = line.facts;
        if (f.sessionId) sessionId = f.sessionId;
        if (f.turns != null && f.turns > turns) turns = f.turns;
        if (f.usage) {
          inputTokens = Math.max(inputTokens, f.usage.input_tokens);
          cachedInputTokens = Math.max(cachedInputTokens, f.usage.cached_input_tokens);
          outputTokens = Math.max(outputTokens, f.usage.output_tokens);
        }
        if (f.costUsd != null) totalCostUsd = f.costUsd;

        // 0. P13-U-1: scrub injected credentials + token-shaped secrets BEFORE
        //    anything is persisted — the raw .jsonl and the DB row are both
        //    served to project members (`{ } raw` toggle, /resources/run-log).
        const raw = redact(line.raw);
        const display = line.display ? redactDisplay(line.display, redact) : null;

        // 1. Raw truth (append-only .jsonl).
        appendRawLine(effectiveBackend, spec.runId, raw);

        // 2. DB projection row.
        const seq = nextSeq(db, spec.runId);
        if (display) {
          insertRunLine(db, {
            runId: spec.runId,
            seq,
            occurredAt: line.occurredAt,
            raw,
            display,
          });
        }

        // 3. Fold facts into the run row.
        patchRun(db, spec.runId, {
          sessionId,
          turns,
          inputTokens,
          cachedInputTokens,
          outputTokens,
          totalCostUsd,
        });

        // 4. Publish the reference (only when a console line was produced).
        if (display) {
          publishRunLogAppended({
            projectSlug: spec.projectSlug,
            taskKey: spec.taskKey,
            runId: spec.runId,
            threadId: spec.threadId,
            seq,
          });
        }
      } catch (error) {
        // F21-24: shutdown drain, not a fault — ONE warning for the whole run,
        // then silence. Anything else keeps the per-line error, which is the
        // signal that a genuine persist failure needs.
        if (persistDrained()) {
          warnDrainedOnce();
          return;
        }
        logger.error("run line persist failed", {
          runId: spec.runId,
          err: error instanceof Error ? error : new Error(String(error)),
        });
        markDivergent(error);
      }
    },

    finalize(exit: RunExit, byInterrupt?: { userId: string }) {
      if (exit.sessionId) sessionId = exit.sessionId;
      // F21-24: a run that reaches its exit AFTER the drain has nothing to
      // record — boot finalization stamps its terminal state from the row it
      // finds. Publishing an SSE state for it would be a claim about a row that
      // was never written, so the whole arm is skipped, not just the write.
      if (persistDrained()) {
        warnDrainedOnce();
        return;
      }
      const desired: RunState =
        exit.outcome === "finished"
          ? "finished"
          : exit.outcome === "error"
            ? "error"
            : "interrupted";
      effectiveBackend = exit.effectiveBackend;
      // B-FD7: never demote an already-terminal run. Another writer (a human's
      // interrupt taking the no-live-handle path) got there first and its
      // finish time is the real one, so neither the state nor `finishedAt` is
      // restamped; the facts this exit carries (session id) still land.
      const current = currentRunState(db, spec.runId);
      const state = resolveTerminalState(current, desired);
      if (state !== desired) {
        logger.warn("run already terminal at finalize — keeping the recorded outcome", {
          runId: spec.runId,
          recorded: state,
          adapterOutcome: desired,
        });
      }
      const patch: RunPatch = { state, sessionId, phase: null, step: null };
      // Only the writer whose outcome WON stamps the finish time — the recorded
      // one already carries the real instant (B-FD7 above).
      if (state === desired) patch.finishedAt = new Date().toISOString();
      if (byInterrupt) patch.interruptedBy = byInterrupt.userId;
      const written = persistOrDrain(() => {
        patchRun(db, spec.runId, patch);
      });
      if (written) publishState(state);
    },
  };
}
