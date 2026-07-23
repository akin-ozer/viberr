import type { DatabaseSync } from "node:sqlite";
import type { RunBackend, RunState } from "~/features/runtime/runtime-types";
import { logger } from "~/server/logging/logger.server";
import type { EmittedLine, RunExit, RunSpec } from "./adapter.server";
import { publishRunLogAppended, publishRunStateChanged } from "./run-events.server";
import {
  appendRawLine,
  insertRunLine,
  nextSeq,
  patchRun,
} from "./run-store.server";

/**
 * The RunSink turns adapter callbacks into durable state + live SSE. For
 * every emitted line it: (1) appends the raw envelope to the canonical
 * .jsonl (truth), (2) inserts a run_log_lines row with the computed
 * display_json, (3) folds usage/cost/turns/session facts into the run row,
 * THEN (4) publishes `run.log-appended` {runId, seq}. Lifecycle transitions
 * publish `run.state-changed`.
 *
 * Ordering matters: persist BEFORE publish, so a client that reacts to the
 * event can always fetch the line it references.
 */

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

  const publishState = (state: RunState) => {
    publishRunStateChanged({
      projectSlug: spec.projectSlug,
      taskKey: spec.taskKey,
      runId: spec.runId,
      threadId: spec.threadId,
      state,
    });
  };

  return {
    markRunning(startedAtIso?: string) {
      if (started) return;
      started = true;
      patchRun(db, spec.runId, {
        state: "running",
        startedAt: startedAtIso ?? new Date().toISOString(),
      });
      publishState("running");
    },

    phase(phase: string | null, step: string | null) {
      patchRun(db, spec.runId, { phase, step });
    },

    line(line: EmittedLine) {
      try {
        // Capture facts before persisting so the row reflects them.
        const f = line.facts;
        if (f.sessionId) sessionId = f.sessionId;
        if (typeof f.turns === "number" && f.turns > turns) turns = f.turns;
        if (f.usage) {
          inputTokens = Math.max(inputTokens, f.usage.input_tokens);
          cachedInputTokens = Math.max(cachedInputTokens, f.usage.cached_input_tokens);
          outputTokens = Math.max(outputTokens, f.usage.output_tokens);
        }
        if (typeof f.costUsd === "number") totalCostUsd = f.costUsd;

        // 1. Raw truth (append-only .jsonl).
        appendRawLine(effectiveBackend, spec.runId, line.raw);

        // 2. DB projection row.
        const seq = nextSeq(db, spec.runId);
        if (line.display) {
          insertRunLine(db, {
            runId: spec.runId,
            seq,
            occurredAt: line.occurredAt,
            raw: line.raw,
            display: line.display,
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
        if (line.display) {
          publishRunLogAppended({
            projectSlug: spec.projectSlug,
            taskKey: spec.taskKey,
            runId: spec.runId,
            threadId: spec.threadId,
            seq,
          });
        }
      } catch (error) {
        logger.error("run line persist failed", {
          runId: spec.runId,
          err: error instanceof Error ? error : new Error(String(error)),
        });
      }
    },

    finalize(exit: RunExit, byInterrupt?: { userId: string }) {
      if (exit.sessionId) sessionId = exit.sessionId;
      const state: RunState =
        exit.outcome === "finished"
          ? "finished"
          : exit.outcome === "error"
            ? "error"
            : "interrupted";
      effectiveBackend = exit.effectiveBackend;
      patchRun(db, spec.runId, {
        state,
        finishedAt: new Date().toISOString(),
        sessionId,
        phase: null,
        step: null,
        ...(byInterrupt ? { interruptedBy: byInterrupt.userId } : {}),
      });
      publishState(state);
    },
  };
}
