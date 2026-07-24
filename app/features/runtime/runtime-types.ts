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

export type RunBackend = "claude" | "codex";

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

/**
 * P13-D-11: the tag of the SYNTHETIC boundary the projection inserts between
 * the runs of one agent group (UI-53's `── resumed · run N of M ──`). It is not
 * a stored `run_log_lines` row, so it never counts toward
 * `logWindow.totalLines` — anything counting "events" must exclude it or the
 * count drifts above the number of lines that actually exist.
 *
 * The server writes the same literal in `run-projection.server.ts`; the client
 * both recognises it (counting) and re-creates it (backward paging across a run
 * boundary), so the shape lives here, on the shared wire type.
 */
export const RUN_BOUNDARY_TAG = "run·resumed";

/** True for a synthetic run boundary rather than a stored console line. */
export function isRunBoundary(line: LogLine): boolean {
  return line.ev === "meta" && line.tag === RUN_BOUNDARY_TAG;
}

/**
 * The boundary row shown ABOVE run `runNumber`'s block (1-based, of
 * `runTotal`). Byte-identical to the projection's own boundary so a block the
 * console paged in looks exactly like one the loader shipped.
 */
export function runBoundaryLine(runNumber: number, runTotal: number): LogLine {
  return {
    t: "",
    ev: "meta",
    tag: RUN_BOUNDARY_TAG,
    text: `── resumed · run ${runNumber} of ${runTotal} ──`,
  };
}

/**
 * P13-D-11 / NFR5 ("…without requiring the client to load the full raw
 * execution history at once"): the task loader ships a BOUNDED window of each
 * agent group's console — the newest lines within the server's line/byte
 * budgets — instead of every run-log line of every run. This is the metadata
 * that makes that PAGING rather than truncation: `oldest` is the cursor the
 * console walks backwards with (`/resources/run-log?runId=…&before=…`), so
 * UI-53's whole-history view is still reachable, one page at a time.
 *
 * Mirrors `RunLogWindow` in `app/server/runtimes/run-projection.server.ts`
 * (the server owns the budgets; this is the wire shape both sides agree on).
 */
export interface RunLogWindow {
  /** Total console lines stored across EVERY run in the group. */
  totalLines: number;
  /** Older lines exist before the ones this payload carries. */
  hasMore: boolean;
  /** The group's run ids, oldest-first — the order to page backwards through. */
  runIds: string[];
  /** Cursor for the next backward page. Null iff `hasMore` is false. */
  oldest: { runId: string; seq: number } | null;
  /**
   * Highest seq held for the REPRESENTATIVE run — the live-tail cursor. Seed
   * `?since=` from THIS, never from `lines.length - 1`: since UI-53 the console
   * concatenates several runs (plus synthetic boundaries) into one group, so an
   * array index is not a seq, and with a bounded window it is not even close.
   * -1 when the representative run has no lines yet.
   */
  headSeq: number;
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
  /** Deployed profile behind this run; identifies which agent to re-run. */
  profileId: string;
  who: RunWho;
  backend: "claude" | "codex";
  sdk: string;
  model: string;
  /** Provider session/thread id (may be null before init lands). */
  sid: string | null;
  /** P11-43: the provider kept an on-disk transcript for this session, so the
   *  Export installer will actually produce a file (false → hide the link). */
  exportable: boolean;
  /** Mock-render state: running | idle | done | error (maps from RunState). */
  state: "running" | "idle" | "done" | "error";
  /** Real lifecycle state (queued/running/finished/error/interrupted). */
  lifecycle: RunState;
  /** User id + label of an interrupter, else null. */
  interruptedBy?: { userId: string; label: string } | null;
  /** The run failed because its backend was unavailable / quota-limited (not a
   *  genuine task failure). The UI offers a one-click retry on `altBackend`. */
  failedBackendUnavailable?: boolean;
  /** The OTHER backend to retry on when this one is unavailable (D4). */
  altBackend?: "claude" | "codex";
  phase: string | null;
  step: string | null;
  /** UTC ISO started_at — client derives elapsed from this + its own clock. */
  startedAt: string | null;
  /** Display-only finished label (mock `finished`, e.g. "9:41"). */
  finished: string | null;
  turns: number;
  /** Cumulative real token usage (input+output). No fabrication. */
  tokens: number;
  /** The projected log lines for the group's bounded window (newest last),
   * with UI-53's synthetic `── resumed · run N of M ──` boundaries between
   * runs. NOT the whole history since P13-D-11 — see `logWindow`. */
  lines: LogLine[];
  /** The exact stored wire envelope per line (index-aligned with `lines`) —
   * what the `{ } raw` toggle renders verbatim (runs.md §5.4). Boundary rows
   * carry an empty envelope. */
  raw: string[];
  /** P13-D-11: total lines that EXIST across the group (== the window's
   * `totalLines`), not the number this payload shipped — so the console's
   * "N events" footer keeps its pre-window meaning. */
  lineCount: number;
  /** P13-D-11: the bounded-window totals + the backward-paging cursor. */
  logWindow: RunLogWindow;
}
