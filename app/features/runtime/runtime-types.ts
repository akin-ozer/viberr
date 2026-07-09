/**
 * Runtime domain types shared by the server (adapters, run-service,
 * projection) and the client (LiveRunPanel / AgentLogsPanel). Client-safe:
 * no server imports, so both sides use the same shapes.
 *
 * Two layers, per the runs spec:
 * - the RAW wire envelope (Claude stream-json / Codex JSONL) — canonical
 *   truth, persisted append-only under runtimes/, shown by the "{ } raw"
 *   toggle verbatim;
 * - the LOG LINE projection (`{ t, ev, tag, text, name?, ... }`) — the
 *   friendly console model. `runs.md` §3.2 is the authoritative shape.
 */

/** Lifecycle stored in agent_runs.state (orchestrator ruling 11). */
export type RunState =
  | "queued"
  | "running"
  | "finished"
  | "error"
  | "interrupted";

/** The requested backend — kept for glyph/SDK fidelity even when simulated. */
export type RunBackend = "claude" | "codex" | "simulated";

export type RunKind = "operator" | "primary" | "reviewer";

/**
 * Projected LogLine — one console row. Mirrors the mock's `cc.*`/`cx.*`
 * builder output (runs.md §3.2). `ev` selects the row color + raw-envelope
 * reconstruction; `tag` is the wire tag rendered verbatim.
 */
export interface LogLine {
  /** Wall-clock `HH:MM:SS`, rendered in the `.lt` column. */
  t: string;
  /** Render class + envelope selector: init|text|tool|out|err|result +
   * think|meta|diff (codex). */
  ev: "init" | "text" | "tool" | "out" | "err" | "result" | "think" | "meta" | "diff";
  /** Wire tag, e.g. `system·init`, `tool_use`, `command_execution`. */
  tag: string;
  /** Main content rendered in `.lx`. */
  text: string;
  /** Claude tool name (`Bash`, `Read`…) / codex `exec`; bold before text. */
  name?: string;
  /** Claude tool input for the raw view (null → synthesized from text). */
  input?: Record<string, unknown> | null;
  /** Codex non-zero exit → the line is `err` + raw `status:"failed"`. */
  exit?: number;
  /** Claude result stats → raw result envelope fields. */
  stats?: {
    subtype?: string;
    dur: number;
    api: number;
    turns: number;
    cost: number;
    in: number;
    cached: number;
    out: number;
  } | null;
  /** Codex turn.completed usage → raw `turn.completed.usage`. */
  usage?: {
    input_tokens: number;
    cached_input_tokens: number;
    output_tokens: number;
  } | null;
  /** Codex file_change changes → raw `file_change.changes`. */
  changes?: { path: string; kind: "add" | "update" | "delete" }[] | null;
}

/** Identity chip shape (mock `who`). Operator: no backend, no role. */
export interface RunWho {
  kind: "agent";
  backend?: "claude" | "codex";
  name: string;
  role?: string;
}

/**
 * One run/thread as the task-detail loader delivers it (a projection over
 * agent_runs + run_log_lines). Field names match the mock so the ported
 * panels stay props-driven (runs.md §3.1).
 */
export interface RunView {
  /** Thread id unique within the task ("op" | "primary" | "c0"). */
  id: string;
  /** DB run id (agent_runs.id) — for interrupt + the run-log tail fetch. */
  serverRunId: string;
  /** Operator flag → shield glyph, "operator" short-role. */
  op?: boolean;
  role: string;
  kind: RunKind;
  who: RunWho;
  backend: "claude" | "codex";
  /** True when the simulated engine produced this run (real fallback or seed). */
  simulated: boolean;
  sdk: string;
  model: string;
  /** Provider session/thread id (may be null before init lands). */
  sid: string | null;
  /** Mock-render state: running | idle | done | error (maps from RunState). */
  state: "running" | "idle" | "done" | "error";
  /** Real lifecycle state (queued/running/finished/error/interrupted). */
  lifecycle: RunState;
  /** User id + label of an interrupter, else null. */
  interruptedBy?: { userId: string; label: string } | null;
  phase: string | null;
  step: string | null;
  /** UTC ISO started_at — client derives elapsed from this + its own clock. */
  startedAt: string | null;
  /** Display-only finished label (mock `finished`, e.g. "9:41"). */
  finished: string | null;
  turns: number;
  /** Cumulative real token usage (input+output). No fabrication. */
  tokens: number;
  /** The persisted, projected log lines (newest last). */
  lines: LogLine[];
  /** The exact stored wire envelope per line (index-aligned with `lines`) —
   * what the `{ } raw` toggle renders verbatim (runs.md §5.4). */
  raw: string[];
  /** Total lines available (== lines.length; the loader sends the full tail). */
  lineCount: number;
}
