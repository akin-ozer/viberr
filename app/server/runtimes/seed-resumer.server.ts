import type Database from "better-sqlite3";
import type { LogLine } from "~/features/runtime/runtime-types";
import { logger } from "~/server/logging/logger.server";
import type { EmittedLine } from "./adapter.server";
import { publishRunLogAppended, publishRunStateChanged } from "./run-events.server";
import {
  getRun,
  nextSeq,
  appendRawLine,
  insertRunLine,
  patchRun,
  listRunsForTaskRows,
} from "./run-store.server";
import { RUNTIME_SEED } from "./runtime-seed-data.server";
import { projectEnvelope, rawLineFromDisplay } from "./wire-format.server";

/**
 * Seed "running" run resumer. A seeded running run has its initial `lines`
 * persisted at seed time but no live process across restarts. On the FIRST
 * client subscribe to such a run's task (the task-detail loader calls
 * `resumeSeededRunningRuns`), an in-process timer drips the run's `live`
 * lines over SSE so the demo shows genuinely live streaming — without a
 * persistent process. This is idempotent per process: each run resumes once.
 *
 * The live lines are attached to the run row at seed time as
 * `pending_live_json` (an out-of-band column-less store here: kept in a
 * process map keyed by run id so a re-seed replaces them). We instead store
 * them in the DB via the run's `phase`… no — cleaner: the seed registers the
 * live lines here directly (registerSeededLive), and the resumer replays them.
 */

interface PendingLive {
  runId: string;
  projectSlug: string;
  taskKey: string;
  threadId: string;
  backend: "claude" | "codex";
  sessionId: string;
  model: string;
  op: boolean;
  lines: LogLine[];
  /** true → after replaying, the run stays running (open thread). */
  keepRunning: boolean;
}

interface ResumerState {
  /** runId → its pending live lines (registered by the seed). */
  pending: Map<string, PendingLive>;
  /** runIds already resumed this process. */
  resumed: Set<string>;
  timers: Set<ReturnType<typeof setTimeout>>;
}

const RESUMER_KEY = Symbol.for("viberr.seedResumer");

function getState(): ResumerState {
  const cache = globalThis as unknown as Record<symbol, ResumerState | undefined>;
  let state = cache[RESUMER_KEY];
  if (!state) {
    state = { pending: new Map(), resumed: new Set(), timers: new Set() };
    cache[RESUMER_KEY] = state;
  }
  return state;
}

/** Registered by the seed for each seeded running run. */
export function registerSeededLive(entry: PendingLive): void {
  const state = getState();
  state.pending.set(entry.runId, entry);
  state.resumed.delete(entry.runId);
}

/**
 * Boot-time registration in the SERVER process. `npm run seed` runs in a
 * SEPARATE process, so its registerSeededLive calls never reach the running
 * server's resumer map. At boot the server re-derives the pending live lines
 * from RUNTIME_SEED for any DB run that is currently `running` — so a live
 * demo works after a fresh boot (or a CLI re-seed) without a persistent
 * process. Idempotent: registerSeededLive replaces existing entries.
 */
export function registerSeededLiveFromData(db: Database.Database): void {
  for (const [taskKey, runs] of Object.entries(RUNTIME_SEED)) {
    for (const run of runs) {
      if (run.state !== "running" || !run.live || !run.live.length) continue;
      const runId = seedRunId(taskKey, run.id);
      const row = getRun(db, runId);
      if (!row || row.state !== "running") continue;
      registerSeededLive({
        runId,
        projectSlug: row.project_slug,
        taskKey: row.task_key,
        threadId: run.id,
        backend: run.backend,
        sessionId: run.sid,
        model: run.model,
        op: run.kind === "operator",
        lines: run.live,
        keepRunning: true,
      });
    }
  }
}

/** Same deterministic id the runtime seed uses. */
function seedRunId(taskKey: string, threadId: string): string {
  return `run_seed_${taskKey}_${threadId}`.toLowerCase().replace(/[^a-z0-9_]/g, "");
}

/** Test-only. */
export function resetSeedResumerForTests(): void {
  const cache = globalThis as unknown as Record<symbol, ResumerState | undefined>;
  const state = cache[RESUMER_KEY];
  if (state) for (const t of state.timers) clearTimeout(t);
  cache[RESUMER_KEY] = undefined;
}

/**
 * On the first subscribe to a task, kick a live drip for each seeded running
 * run on that task that still has pending live lines. Safe to call on every
 * loader invocation — it only starts each run's drip once.
 */
export function resumeSeededRunningRuns(
  db: Database.Database,
  projectSlug: string,
  taskKey: string,
): void {
  const state = getState();
  const rows = listRunsForTaskRows(db, projectSlug, taskKey);
  for (const row of rows) {
    if (row.state !== "running") continue;
    const pending = state.pending.get(row.id);
    if (!pending) continue;
    if (state.resumed.has(row.id)) continue;
    state.resumed.add(row.id);
    startDrip(db, pending);
  }
}

function startDrip(db: Database.Database, pending: PendingLive): void {
  const state = getState();
  let i = 0;
  const step = () => {
    // Guard: the run may have been interrupted since we scheduled this.
    const row = getRun(db, pending.runId);
    if (!row || row.state !== "running") return;

    if (i >= pending.lines.length) {
      if (!pending.keepRunning) {
        // Close the thread out as finished when the script ends.
        patchRun(db, pending.runId, {
          state: "finished",
          finishedAt: new Date().toISOString(),
          phase: null,
          step: null,
        });
        publishRunStateChanged({
          projectSlug: pending.projectSlug,
          taskKey: pending.taskKey,
          runId: pending.runId,
          threadId: pending.threadId,
          state: "finished",
        });
      }
      return;
    }

    const line = pending.lines[i]!;
    const occurredAt = new Date().toISOString();
    const emitted = buildEmitted(pending, line, i, occurredAt);
    try {
      const seq = nextSeq(db, pending.runId);
      appendRawLine(pending.backend, pending.runId, emitted.raw);
      if (emitted.display) {
        insertRunLine(db, {
          runId: pending.runId,
          seq,
          occurredAt,
          raw: emitted.raw,
          display: emitted.display,
        });
      }
      // Fold usage facts into the row (no fabrication — real envelope facts).
      const f = emitted.facts;
      if (f.usage || typeof f.turns === "number") {
        const patch: Record<string, number> = {};
        if (f.usage) {
          patch.inputTokens = Math.max(row.input_tokens, f.usage.input_tokens);
          patch.cachedInputTokens = Math.max(row.cached_input_tokens, f.usage.cached_input_tokens);
          patch.outputTokens = Math.max(row.output_tokens, f.usage.output_tokens);
        }
        if (typeof f.turns === "number") patch.turns = Math.max(row.turns, f.turns);
        patchRun(db, pending.runId, patch);
      }
      if (emitted.display) {
        publishRunLogAppended({
          projectSlug: pending.projectSlug,
          taskKey: pending.taskKey,
          runId: pending.runId,
          threadId: pending.threadId,
          seq,
        });
      }
    } catch (error) {
      logger.error("seed resumer drip failed", {
        runId: pending.runId,
        err: error instanceof Error ? error : new Error(String(error)),
      });
    }

    i += 1;
    const delay = 1400 + ((i * 733) % 2600);
    const timer = setTimeout(() => {
      state.timers.delete(timer);
      step();
    }, delay);
    state.timers.add(timer);
    timer.unref?.();
  };

  // Kick off after a short delay so the initial page render lands first.
  const timer = setTimeout(() => {
    state.timers.delete(timer);
    step();
  }, 2000);
  state.timers.add(timer);
  timer.unref?.();
}

function buildEmitted(
  pending: PendingLive,
  line: LogLine,
  idx: number,
  occurredAt: string,
): EmittedLine {
  const raw = rawLineFromDisplay(
    { backend: pending.backend, sid: pending.sessionId, model: pending.model, op: pending.op },
    line,
    idx,
    pending.lines,
  );
  let facts: EmittedLine["facts"] = {};
  try {
    facts = projectEnvelope(pending.backend, JSON.parse(raw), occurredAt).facts;
  } catch {
    // rawLineFromDisplay always emits valid JSON.
  }
  return { raw, display: line, facts, occurredAt };
}
