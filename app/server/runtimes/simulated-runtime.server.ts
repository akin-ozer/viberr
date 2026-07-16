import type { LogLine, RunBackend } from "~/features/runtime/runtime-types";
import type { EmittedLine, RunCallbacks, RunHandle, RunSpec, RuntimeAdapter } from "./adapter.server";
import { projectEnvelope, rawLineFromDisplay } from "./wire-format.server";

/**
 * The simulated runtime — the DETERMINISTIC TEST ENGINE. R7-2: this adapter
 * is reachable ONLY behind the fail-closed gate (runtime-registry
 * `simulatedRuntimePermitted`: vitest, or the Playwright harness's
 * VIBERR_FORCE_SIMULATED_RUNTIME + VIBERR_TEST_RUNTIME_OK pair). It is no
 * longer a product fallback or demo engine — an unavailable real backend
 * fails its run fast instead of ever streaming from here.
 *
 * Replays a scripted stream of display LogLines, fabricating an authentic
 * wire envelope for each via `rawLineFromDisplay` so raw_json is real
 * Claude/Codex JSON and display_json is its projection (round-trips through
 * the SAME normalizer the real adapters use). Requires no external anything.
 *
 * Interrupt stops the timer and emits no result envelope → the run ends
 * `interrupted` and stays resumable (mirrors the real SIGINT behavior).
 */

export interface SimulatedScript {
  /** The display lines to replay, in order. */
  lines: LogLine[];
  /** ISO occurrence times, one per line (defaults to now-based cadence). */
  occurredAt?: string[];
  /** Provider session id to stamp into raw envelopes (claude/codex). */
  sessionId: string;
  /** Requested backend (glyph fidelity). */
  backend: "claude" | "codex";
  model: string;
  op: boolean;
  /** true → this run's script ends "running" (open thread, no exit). */
  keepRunning?: boolean;
  /** true → replay instantly (backfill of already-persisted lines). */
  instant?: boolean;
  /** Effective backend stamped on the exit (defaults to the sim engine). */
  effectiveBackend?: RunBackend;
}

/** Build a script from a plain line list (identity — a typed constructor). */
export function buildScript(input: SimulatedScript): SimulatedScript {
  return input;
}

interface SimTimers {
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
}

const REAL_TIMERS: SimTimers = { setTimeout, clearTimeout };

export function createSimulatedAdapter(timers: SimTimers = REAL_TIMERS): RuntimeAdapter {
  return {
    backend: "simulated",
    start(spec: RunSpec, cb: RunCallbacks): RunHandle {
      // The spec carries the script through a symbol channel (the service
      // sets it); a bare start with no script produces a tiny generic stream.
      const script = (spec as RunSpec & { script?: SimulatedScript }).script;
      return startSimulated(spec, cb, script, timers);
    },
  };
}

/** Drives a script (exported for the adapter's unit tests). */
export function startSimulated(
  spec: RunSpec,
  cb: RunCallbacks,
  script: SimulatedScript | undefined,
  timers: SimTimers = REAL_TIMERS,
): RunHandle {
  const s: SimulatedScript = script ?? {
    lines: [
      { t: "", ev: "init", tag: spec.backend === "codex" ? "thread.started" : "system·init", text: "session started" },
      { t: "", ev: "text", tag: spec.backend === "codex" ? "agent_message" : "assistant", text: spec.prompt.slice(0, 120) },
    ],
    sessionId: spec.resumeSessionId ?? spec.threadId,
    backend: spec.backend,
    model: spec.model,
    op: spec.kind === "operator",
    keepRunning: false,
  };

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let i = 0;
  let interruptedByUser: string | null = null;

  // The run's FINAL usage lives on the last (result) line. Precompute it so the
  // live counter can GROW toward it across the preceding lines instead of
  // staying 0 until the result lands. Presentational only — it converges to the
  // same real total the result envelope reports (no numbers invented from thin
  // air, just the known total spread over the timeline).
  const target = (() => {
    const last = s.lines[s.lines.length - 1];
    if (!last) return null;
    try {
      const raw = rawLineFromDisplay(
        { backend: s.backend, sid: s.sessionId, model: s.model, op: s.op },
        last,
        s.lines.length - 1,
        s.lines,
      );
      const f = projectEnvelope(s.backend, JSON.parse(raw), "").facts;
      if (!f.usage) return null;
      return { usage: f.usage, turns: typeof f.turns === "number" ? f.turns : 0 };
    } catch {
      return null;
    }
  })();
  const contentCount = Math.max(1, s.lines.length - 1);
  let contentSeen = 0;

  const emit = (line: LogLine, idx: number, occurredAt: string) => {
    // Fabricate the wire envelope, then RE-PROJECT it through the real
    // normalizer so display_json is exactly what a real run would produce.
    const raw = rawLineFromDisplay(
      { backend: s.backend, sid: s.sessionId, model: s.model, op: s.op },
      line,
      idx,
      s.lines,
    );
    let display: LogLine | null = line;
    let facts: EmittedLine["facts"] = {};
    try {
      const projected = projectEnvelope(s.backend, JSON.parse(raw), occurredAt);
      // Keep the seed's exact display text/timestamp for fidelity, but take
      // the FACTS (usage/cost/turns/session) from the normalized envelope.
      facts = projected.facts;
    } catch {
      // rawLineFromDisplay always emits valid JSON; defensive only.
    }
    // A CONTENT line (not the result) carries no usage of its own — attach a
    // running fraction of the run's known total so the live token/turn counters
    // climb during the stream. The result line keeps its authoritative totals.
    if (target && !facts.usage) {
      contentSeen += 1;
      const frac = contentSeen / contentCount;
      facts = {
        ...facts,
        usage: {
          input_tokens: Math.round(target.usage.input_tokens * frac),
          cached_input_tokens: Math.round(target.usage.cached_input_tokens * frac),
          output_tokens: Math.round(target.usage.output_tokens * frac),
        },
        ...(target.turns > 0 ? { turns: Math.max(1, Math.round(target.turns * frac)) } : {}),
      };
    }
    cb.onLine({ raw, display, facts, occurredAt });
  };

  const finishRun = () => {
    if (stopped) return;
    stopped = true;
    if (interruptedByUser) {
      cb.onExit({
        outcome: "interrupted",
        effectiveBackend: s.effectiveBackend ?? "simulated",
        simulated: true,
        sessionId: s.sessionId,
      });
      return;
    }
    // The last line's ev decides finished-vs-error (a result with an error
    // subtype, or a codex err/turn.failed, means the run errored).
    const last = s.lines[s.lines.length - 1];
    const errored =
      last?.ev === "err" ||
      (last?.ev === "result" && !!last.stats?.subtype && last.stats.subtype !== "success");
    cb.onExit({
      outcome: errored ? "error" : "finished",
      effectiveBackend: s.effectiveBackend ?? "simulated",
      simulated: true,
      sessionId: s.sessionId,
    });
  };

  const step = () => {
    if (stopped) return;
    if (i >= s.lines.length) {
      if (!s.keepRunning) finishRun();
      return;
    }
    const idx = i;
    const line = s.lines[idx]!;
    const occurredAt = s.occurredAt?.[idx] ?? new Date().toISOString();
    emit(line, idx, occurredAt);
    i += 1;
    if (i >= s.lines.length) {
      if (!s.keepRunning) finishRun();
      return;
    }
    // Realistic cadence 1.0–3.2s (mock's `1000 + ((i*733) % 2200)`), instant
    // for backfills of already-persisted lines.
    const delay = s.instant ? 0 : 1000 + ((idx * 733) % 2200);
    timer = timers.setTimeout(step, delay);
  };

  // Kick off asynchronously so the caller can register the handle first.
  timer = timers.setTimeout(step, 0);

  return {
    runId: spec.runId,
    interrupt(byUserId: string) {
      if (stopped) return;
      interruptedByUser = byUserId;
      if (timer !== null) timers.clearTimeout(timer);
      timer = null;
      finishRun();
    },
  };
}
