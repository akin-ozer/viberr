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

import type { RunFailureFacts, RunFailureKind } from "~/shared/run-failure";

/** Lifecycle stored in agent_runs.state (orchestrator ruling 11). */
export type RunState =
  | "queued"
  | "running"
  | "finished"
  | "error"
  | "interrupted";

/**
 * Pass 35 U35-7 (ruling 158 addendum): the stored reason an `interrupted` run
 * stopped when no person interrupted it. A restart is a reason, not an actor;
 * `interrupted_by` stays a user id or null.
 */
export type RunInterruptedReason = "restart";

export type RunBackend = "claude" | "codex";

/**
 * F31-C7 — `kind` is a DELIVERY axis, not a role taxonomy, and the names
 * mislead if read as roles: `primary` = the run of the engagement that
 * `delivers: true` (owns workspace/branch/PR); `reviewer` = ANY supporting,
 * non-delivering specialist run — a Developer dispatched `delivers: false`
 * is stored as `reviewer`. Two partial unique indexes on `agent_runs`
 * (single-flight per task) depend on exactly this reading, and the CHECK in
 * 0001_baseline.sql mirrors these members. Renaming the members means a
 * baseline-schema change; until then, read `role`/`agent_profile_id` for
 * "who", and this field only for "does the run own delivery".
 */
export type RunKind = "operator" | "primary" | "reviewer" | "controller";

/**
 * A value that survived JSON transport. The provider payloads this module
 * carries verbatim to the raw view — a tool call's arguments above all — are
 * free-form BY CONTRACT (each vendor tool declares its own schema, and both add
 * tools between releases), so "whatever JSON.parse produced" is the honest
 * value type. `wire-format.server.ts` parses them into this shape at the wire
 * boundary; nothing downstream interprets them.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

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
  /** P19-G11: the viberr-authored `run·inputs` line's structured payload — what
   *  the run was GIVEN, as opposed to what it produced. Present only on that one
   *  line (tag `RUN_INPUTS_TAG`); every provider line leaves it undefined. */
  inputs?: RunInputs;
  /** Claude tool name (`Bash`, `Read`…) / codex `exec`; bold before text. */
  name?: string;
  /** Claude tool input for the raw view (null → synthesized from text). */
  input?: Record<string, JsonValue> | null;
  /** Codex non-zero exit → the line is `err` + raw `status:"failed"`. */
  exit?: number;
  /** Claude result stats, in the run row's terms: `in` is the whole prompt
   *  (uncached + cache writes + cache reads), `cached` its cache-read subset. */
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
  /** Ruling 130(a) (pass 34): the adapter's classified failure record, on the
   *  terminal `err` line only (beside its `run·error·<kind>` tag). Every
   *  reader of a failure consumes THIS, never a second regex over the raw
   *  stream. Absent on every other line. */
  failure?: RunFailureFacts;
}

/**
 * P19-G11 — what a run was GIVEN, recorded as one console line at run start.
 *
 * The console has always been output-only: a human could read every token an
 * agent produced and still not know which knowledge bases, skills or MCP
 * servers actually resolved for it, what canonical task state it was anchored
 * on, or how its tools were confined. That blind spot sits under a whole class
 * of recurring problem — a KB grant that resolves to nothing, the Claude/Codex
 * skills asymmetry the product promises to DISCLOSE rather than hide, the
 * KB-vs-repository precedence rule — every one of which is a claim about what an
 * agent was given.
 *
 * Deliberately NAMES and SIZES, not bodies: the persona (with its KB and skill
 * text inlined) can be tens of KB and is already authored and readable on the
 * Agents page, so duplicating it into every run log would be storage without
 * information. The one body carried verbatim is the canonical anchor, because
 * it exists nowhere else — it is composed for a single turn and thrown away, so
 * "which goal text did this turn actually receive" is otherwise unanswerable
 * exactly when it matters (the goal was edited between turns).
 */
export interface RunInputs {
  /** The run's working directory — always the isolated task workspace. */
  cwd: string | null;
  /** The repository the workspace was to hold, when the project has one. */
  repo: string | null;
  /** A checkout actually landed in `cwd`. False → the agent ran on an empty dir. */
  cloned: boolean;
  /** Ruling 129 (pass 34, Q34-5): what the pre-run refresh did to a REUSED
   *  checkout, in words. Absent on a fresh clone, which needs none, and on a
   *  run with no working tree. A refresh that could not run says so here
   *  rather than leaving the reader to assume `origin/*` is current. */
  workspaceRefresh?: string;
  /** This engagement DELIVERS (vs a supporting, read-only engagement). */
  delivers: boolean;
  /** Characters of persona (Claude systemPrompt / Codex developer instructions). */
  personaChars: number;
  /** Characters of the turn prompt actually sent to the provider. */
  promptChars: number;
  /** The canonical task-state block this run was anchored on, verbatim. */
  anchor: string | null;
  /** Granted skills, split by the channel each one actually took. */
  skills: {
    /** Every skill the profile grants. */
    granted: string[];
    /** Mounted into the workspace for the SDK's native skills mechanism. */
    native: string[];
    /** Not mountable on this run — their bodies rode the persona as text. */
    injected: string[];
  };
  /** Knowledge bases whose bodies were assembled into the persona. */
  knowledge: string[];
  /** MCP grants by what actually happened to them. */
  mcp: {
    /** Servers mounted on the run (profile grants + the viberr toolkit). */
    mounted: string[];
    /** Granted, but no such server is in the org registry — mounted nowhere. */
    unresolved: string[];
    /** Mounted, but the last connection check failed. */
    unhealthy: string[];
  };
  /** Skill / knowledge-base grants whose CONTENT never reached the run. */
  unresolvedResources: { name: string; reason: string }[];
  /** Tool confinement, both directions. */
  tools: {
    /** Built-ins denied by the profile's capability grants. */
    denied: string[];
    /** Viberr collaboration tools mounted for this run. */
    toolkit: string[];
  };
  /** The turn's directive and who wrote it (null → no directive this turn). */
  directive: { from: string | null; chars: number } | null;
  /** Codex only: the OS sandbox the run got, with the honest note when the
   *  evidence carve-out decided it (pass 32, E32-3 — a write-withheld,
   *  evidence-granted run keeps workspace-write because Codex cannot express
   *  read-only-except-attachments). Null on Claude: no OS sandbox there, the
   *  tool denylist in `tools.denied` is what binds. */
  sandbox: {
    mode: "read-only" | "workspace-write" | "danger-full-access";
    note: string | null;
  } | null;
}

/**
 * P19-G11: the tag of the viberr-authored line carrying `RunInputs`. Written by
 * the run starter, never by a provider — so a reader can always tell the run's
 * declared inputs from its stream.
 */
export const RUN_INPUTS_TAG = "run·inputs";

/** True for the run-inputs disclosure line rather than a provider event. */
export function isRunInputsLine(line: LogLine): boolean {
  return line.tag === RUN_INPUTS_TAG && !!line.inputs;
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
  /** User id + label of the PERSON who interrupted the run, else null. */
  interruptedBy?: { userId: string; label: string } | null;
  /** Pass 35 U35-7: why an `interrupted` run stopped when no person did it.
   *  `"restart"` = boot recovery found it queued/running with no process
   *  behind it. Null on a human interrupt (which names the person above). */
  interruptedReason?: RunInterruptedReason | null;
  /** The run failed because its backend was unavailable / quota-limited (not a
   *  genuine task failure). The UI offers a one-click retry on `altBackend`. */
  failedBackendUnavailable?: boolean;
  /** Ruling 130(a): the classified failure kind of an errored run, for EVERY
   *  run kind; the Agent-logs footer selects its sentence from this. */
  failureKind?: RunFailureKind;
  /** The OTHER backend to retry on when this one is unavailable (D4). */
  altBackend?: "claude" | "codex";
  phase: string | null;
  step: string | null;
  /** UTC ISO started_at — client derives elapsed from this + its own clock. */
  startedAt: string | null;
  /** Display-only finished label (mock `finished`, e.g. "9:41"). */
  finished: string | null;
  turns: number;
  /** Total tokens the provider processed for the run: the whole prompt of
   *  every call (cache reads and writes included) plus the output, i.e. the
   *  row's `input_tokens + output_tokens`, which means the same thing on both
   *  backends (wire-format.server.ts normalizes Claude's three prompt figures
   *  into one). Real usage envelopes only; a lower bound until the result. */
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
