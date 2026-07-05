import { existsSync, rmSync } from "node:fs";
import type Database from "better-sqlite3";
import type { LogLine, RunKind } from "~/features/runtime/runtime-types";
import { rawLineFromDisplay, projectEnvelope } from "./wire-format.server";
import {
  appendRawLine,
  insertRunLine,
  rawLogPath,
  upsertRun,
} from "./run-store.server";
import { registerSeededLive } from "./seed-resumer.server";
import { RUNTIME_SEED, type SeedRun } from "./runtime-seed-data.server";

/**
 * Materializes the full RUNTIME dataset (18 runs / 8 tasks) as agent_runs +
 * run_log_lines rows AND raw .jsonl truth, back-dated per ruling 4. For each
 * line it fabricates the wire envelope (rawLineFromDisplay) — the same
 * envelope a real run would persist — so raw_json is authentic and
 * display_json is its normalized projection.
 *
 * Seeded "running" runs: their initial `lines` are persisted; their `live`
 * lines are REGISTERED with the seed-resumer, which drips them over SSE on
 * the first client subscribe (documented approach — no persistent process
 * across restarts).
 *
 * Idempotent: rows are upserted by run id (deterministic per task+thread);
 * `--reset` clears the tables first (wired in the demo seed).
 */

const SDK_LABEL: Record<string, string> = {
  claude: "Claude Agent SDK",
  codex: "Codex SDK",
};

/** State mapping: mock render state → real lifecycle (ruling 11). */
function lifecycleOf(state: SeedRun["state"]): "running" | "finished" | "error" {
  if (state === "running") return "running";
  if (state === "error") return "error";
  // "idle" and "done" both persist as finished — an idle seeded run is a
  // completed session the operator can re-engage; the mock renders it "idle"
  // via the phase text. We keep the render nuance in a separate flag below.
  return "finished";
}

/** Deterministic run id from task + thread — stable across re-seeds. */
function runIdFor(taskKey: string, threadId: string): string {
  return `run_seed_${taskKey}_${threadId}`.toLowerCase().replace(/[^a-z0-9_]/g, "");
}

/**
 * Back-dates a display `HH:MM:SS` (or "Mar 30 · HH:MM") to an ISO instant on
 * the mock's timeline (ruling 4: today for HH:MM streams; the seed's runs use
 * today for the live tasks and "Mar 30" for the historical ones).
 */
function isoForClock(clock: string, base: Date): string {
  // "Mar 30 · 17:26" style finished labels are display-only; per-line
  // timestamps are always HH:MM:SS today (mock streams are same-day).
  const m = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(clock);
  const h = m ? Number(m[1]) : 0;
  const min = m ? Number(m[2]) : 0;
  const s = m ? Number(m[3]) : 0;
  return new Date(base.getFullYear(), base.getMonth(), base.getDate(), h, min, s, 0).toISOString();
}

export interface RuntimeSeedSummary {
  runs: number;
  lines: number;
}

export function seedRuntimes(
  db: Database.Database,
  options: { dataRoot: string; projectSlug?: string } = { dataRoot: "" },
): RuntimeSeedSummary {
  const projectSlug = options.projectSlug ?? "viberr-core";

  // Idempotent even without --reset: drop the deterministic seed rows and
  // their raw .jsonl files first, so a re-seed never duplicates lines.
  const seedRunIds = new Set<string>();
  for (const [taskKey, runs] of Object.entries(RUNTIME_SEED)) {
    for (const run of runs) seedRunIds.add(runIdFor(taskKey, run.id));
  }
  for (const runId of seedRunIds) {
    db.prepare(`DELETE FROM run_log_lines WHERE run_id = ?`).run(runId);
    db.prepare(`DELETE FROM agent_runs WHERE id = ?`).run(runId);
    for (const backend of ["claude", "codex", "simulated"] as const) {
      const file = rawLogPath(backend, runId, options.dataRoot);
      if (existsSync(file)) rmSync(file, { force: true });
    }
  }
  const now = new Date();
  // Historical tasks (VIB-139, VIB-141) use March 30 for their run instants.
  const mar30 = new Date(now.getFullYear(), 2, 30);
  const HISTORICAL = new Set(["VIB-139", "VIB-141"]);

  let runCount = 0;
  let lineCount = 0;

  for (const [taskKey, runs] of Object.entries(RUNTIME_SEED)) {
    const base = HISTORICAL.has(taskKey) ? mar30 : now;
    for (const run of runs) {
      const runId = runIdFor(taskKey, run.id);
      const backend = run.backend;
      const lifecycle = lifecycleOf(run.state);
      const op = run.kind === "operator";

      // Timestamps: the first line instant drives started_at. The mock's
      // `finished` DISPLAY LABEL ("9:41", "Mar 30 · 17:26") is stored in
      // finished_at verbatim so the footer renders the mock string (the
      // projection passes non-ISO finished_at through as the label; real
      // runs store an ISO the projection formats).
      const firstClock = run.lines[0]?.t ?? "00:00:00";
      // Running runs back-date started_at to (now − elapsedSeconds) so the
      // strip ticks a realistic elapsed regardless of the wall clock (avoids
      // the near-future seed quirk when the day rolls over); others use the
      // first line's wall-clock instant.
      const startedAt =
        run.state === "running" && typeof run.elapsedSeconds === "number"
          ? new Date(Date.now() - run.elapsedSeconds * 1000).toISOString()
          : isoForClock(firstClock, base);
      const finishedAt = run.state === "running" ? null : (run.finished ?? null);

      // Pass 1: precompute each line's raw envelope + real usage facts (no
      // fabrication) so the run row carries the right tokens/cost/turns.
      let turns = 0;
      let inputTokens = 0;
      let cachedInputTokens = 0;
      let outputTokens = 0;
      let totalCostUsd: number | null = null;
      const prepared = run.lines.map((line, idx) => {
        const occurredAt = isoForClock(line.t, base);
        const raw = rawLineFromDisplay(
          { backend, sid: run.sid, model: run.model, op },
          line,
          idx,
          run.lines,
        );
        const facts = safeFacts(backend, raw, occurredAt);
        if (typeof facts.turns === "number" && facts.turns > turns) turns = facts.turns;
        if (facts.usage) {
          inputTokens = Math.max(inputTokens, facts.usage.input_tokens);
          cachedInputTokens = Math.max(cachedInputTokens, facts.usage.cached_input_tokens);
          outputTokens = Math.max(outputTokens, facts.usage.output_tokens);
        }
        if (typeof facts.costUsd === "number") totalCostUsd = facts.costUsd;
        return { line, idx, occurredAt, raw };
      });

      // The run row must exist before its log lines (FK). Insert it first.
      upsertRun(db, {
        id: runId,
        projectSlug,
        taskKey,
        threadId: run.id,
        role: run.role,
        kind: run.kind as RunKind,
        backend,
        simulated: true, // seeded demo data is produced by the sim engine
        model: run.model,
        sdk: run.sdk || SDK_LABEL[backend] || "",
        sessionId: run.sid,
        state: lifecycle,
        phase: run.phase ?? null,
        step: run.step ?? null,
        startedAt,
        finishedAt,
        turns,
        inputTokens,
        cachedInputTokens,
        outputTokens,
        totalCostUsd,
      });
      runCount += 1;

      // Pass 2: persist each line (raw .jsonl truth + DB projection row).
      for (const p of prepared) {
        appendRawLine(backend, runId, p.raw, options.dataRoot);
        insertRunLine(db, { runId, seq: p.idx, occurredAt: p.occurredAt, raw: p.raw, display: p.line });
        lineCount += 1;
      }

      // Register live lines for the resumer (running runs only).
      if (run.state === "running" && run.live && run.live.length) {
        registerSeededLive({
          runId,
          projectSlug,
          taskKey,
          threadId: run.id,
          backend,
          sessionId: run.sid,
          model: run.model,
          op,
          lines: run.live,
          // VIB-151/153/145 primaries + consultants stay "running" after
          // their live batch (they hold the thread open); the mock never
          // ends them. Keep running so the strip stays live for the demo.
          keepRunning: true,
        });
      }
    }
  }

  return { runs: runCount, lines: lineCount };
}

function safeFacts(backend: "claude" | "codex", raw: string, occurredAt: string) {
  try {
    return projectEnvelope(backend, JSON.parse(raw), occurredAt).facts;
  } catch {
    return {};
  }
}

/** For finished/error runs the mock shows a `finished` display label
 *  ("9:41", "Mar 30 · 17:26"). We store it separately so the footer renders
 *  the mock string verbatim rather than deriving from finished_at. */
export function seededFinishedLabels(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const runs of Object.values(RUNTIME_SEED)) {
    for (const run of runs) {
      if (run.finished) out[run.sid] = run.finished;
    }
  }
  return out;
}
