import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { LogLine, RunBackend, RunKind, RunState } from "~/features/runtime/runtime-types";
import { getDataRoot } from "~/server/files/file-store-root.server";

/**
 * Run persistence: the RAW .jsonl append (canonical truth, under
 * ${VIBERR_DATA_ROOT}/runtimes/<backend>/<sessionOrRunId>.jsonl) and the DB
 * projection rows (agent_runs + run_log_lines). Callers append a line via
 * `appendRunLine` (raw file + DB row) and read via the query helpers here.
 */

export interface AgentRunRow {
  id: string;
  task_key: string;
  project_slug: string;
  thread_id: string;
  role: string;
  kind: RunKind;
  backend: RunBackend;
  model: string;
  session_id: string | null;
  sdk: string;
  /** The deployed agent's display name ("dev"/"Operator"/…); null on seed/
   *  historical rows (the projection falls back to the backend WHO_NAME). */
  agent_name: string | null;
  /** The deployed profile id — the stable per-agent grouping key. */
  agent_profile_id: string;
  state: RunState;
  phase: string | null;
  step: string | null;
  started_at: string | null;
  finished_at: string | null;
  turns: number;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  total_cost_usd: number | null;
  interrupted_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface InsertRunInput {
  id: string;
  projectSlug: string;
  taskKey: string;
  threadId: string;
  role: string;
  kind: RunKind;
  /** Requested backend, kept for glyph fidelity. */
  backend: RunBackend;
  model: string;
  sdk: string;
  sessionId?: string | null;
  /** The deployed agent's display name (grouped-picker label). */
  agentName?: string | null;
  /** The deployed profile id (per-agent grouping key). */
  agentProfileId: string;
  state: RunState;
  phase?: string | null;
  step?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  turns?: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  totalCostUsd?: number | null;
  interruptedBy?: string | null;
}

/** Insert (or replace, for seed idempotency) an agent_runs row. */
export function upsertRun(db: DatabaseSync, input: InsertRunInput): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO agent_runs
       (id, task_key, project_slug, thread_id, role, kind, backend,
        model, session_id, sdk, agent_name, agent_profile_id, state, phase, step,
        started_at, finished_at,
        turns, input_tokens, cached_input_tokens, output_tokens, total_cost_usd,
        interrupted_by, created_at, updated_at)
     VALUES
       (@id, @taskKey, @projectSlug, @threadId, @role, @kind, @backend,
        @model, @sessionId, @sdk, @agentName, @agentProfileId, @state, @phase, @step,
        @startedAt, @finishedAt,
        @turns, @inputTokens, @cachedInputTokens, @outputTokens, @totalCostUsd,
        @interruptedBy, @createdAt, @updatedAt)
     ON CONFLICT(id) DO UPDATE SET
        task_key=excluded.task_key, project_slug=excluded.project_slug,
        thread_id=excluded.thread_id, role=excluded.role, kind=excluded.kind,
        backend=excluded.backend, model=excluded.model,
        session_id=excluded.session_id, sdk=excluded.sdk,
        agent_name=excluded.agent_name, agent_profile_id=excluded.agent_profile_id,
        state=excluded.state,
        phase=excluded.phase, step=excluded.step, started_at=excluded.started_at,
        finished_at=excluded.finished_at, turns=excluded.turns,
        input_tokens=excluded.input_tokens, cached_input_tokens=excluded.cached_input_tokens,
        output_tokens=excluded.output_tokens, total_cost_usd=excluded.total_cost_usd,
        interrupted_by=excluded.interrupted_by, updated_at=excluded.updated_at`,
  ).run({
    id: input.id,
    taskKey: input.taskKey,
    projectSlug: input.projectSlug,
    threadId: input.threadId,
    role: input.role,
    kind: input.kind,
    backend: input.backend,
    model: input.model,
    sessionId: input.sessionId ?? null,
    sdk: input.sdk,
    agentName: input.agentName ?? null,
    agentProfileId: input.agentProfileId,
    state: input.state,
    phase: input.phase ?? null,
    step: input.step ?? null,
    startedAt: input.startedAt ?? null,
    finishedAt: input.finishedAt ?? null,
    turns: input.turns ?? 0,
    inputTokens: input.inputTokens ?? 0,
    cachedInputTokens: input.cachedInputTokens ?? 0,
    outputTokens: input.outputTokens ?? 0,
    totalCostUsd: input.totalCostUsd ?? null,
    interruptedBy: input.interruptedBy ?? null,
    createdAt: now,
    updatedAt: now,
  });
}

export interface RunPatch {
  sessionId?: string | null;
  state?: RunState;
  phase?: string | null;
  step?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  turns?: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  totalCostUsd?: number | null;
  interruptedBy?: string | null;
  backend?: RunBackend;
}

/** Patch selected fields on a run row; always bumps updated_at. */
export function patchRun(db: DatabaseSync, runId: string, patch: RunPatch): void {
  const cols: string[] = [];
  const params: Record<string, SQLInputValue> = {
    id: runId,
    updatedAt: new Date().toISOString(),
  };
  const map: Record<keyof RunPatch, string> = {
    sessionId: "session_id",
    state: "state",
    phase: "phase",
    step: "step",
    startedAt: "started_at",
    finishedAt: "finished_at",
    turns: "turns",
    inputTokens: "input_tokens",
    cachedInputTokens: "cached_input_tokens",
    outputTokens: "output_tokens",
    totalCostUsd: "total_cost_usd",
    interruptedBy: "interrupted_by",
    backend: "backend",
  };
  for (const key of Object.keys(patch) as (keyof RunPatch)[]) {
    const value = patch[key];
    if (value === undefined) continue;
    cols.push(`${map[key]} = @${key}`);
    params[key] = value;
  }
  if (cols.length === 0) return;
  db.prepare(`UPDATE agent_runs SET ${cols.join(", ")}, updated_at = @updatedAt WHERE id = @id`).run(params);
}

export function getRun(db: DatabaseSync, runId: string): AgentRunRow | null {
  return (db.prepare(`SELECT * FROM agent_runs WHERE id = ?`).get(runId) as AgentRunRow | undefined) ?? null;
}

export function listRunsForTaskRows(
  db: DatabaseSync,
  projectSlug: string,
  taskKey: string,
): AgentRunRow[] {
  return db
    .prepare(
      `SELECT * FROM agent_runs WHERE project_slug = ? AND task_key = ?
       ORDER BY created_at ASC, rowid ASC`,
    )
    .all(projectSlug, taskKey) as unknown as AgentRunRow[];
}

/**
 * Map of agent profile id → the agent's DISPLAY NAME, drawn from its run rows
 * for a project (most-recent name wins). This is the authoritative source for
 * "what is this agent CALLED" when rendering a timeline/notification actor:
 * every agent that authored an event necessarily has a run row, and the run
 * carried the deployment's own name (e.g. "Reviewer") — not the backend/runtime
 * label. Rows without a stored name are skipped so callers fall back to the
 * backend label only for genuinely nameless (seed/legacy) agents.
 */
export function agentNamesByProfile(
  db: DatabaseSync,
  projectSlug: string,
): Map<string, string> {
  const rows = db
    .prepare(
      `SELECT agent_profile_id AS pid, agent_name AS name FROM agent_runs
       WHERE project_slug = ? AND agent_name IS NOT NULL AND agent_name <> ''
       ORDER BY created_at ASC, rowid ASC`,
    )
    .all(projectSlug) as { pid: string; name: string }[];
  const map = new Map<string, string>();
  for (const row of rows) map.set(row.pid, row.name); // later row → most recent name
  return map;
}

/** Next append sequence for a run (max seq + 1, or 0). */
export function nextSeq(db: DatabaseSync, runId: string): number {
  const row = db.prepare(`SELECT MAX(seq) AS m FROM run_log_lines WHERE run_id = ?`).get(runId) as
    | { m: number | null }
    | undefined;
  return (row?.m ?? -1) + 1;
}

export interface RunLogLine {
  seq: number;
  occurredAt: string;
  raw: string;
  display: LogLine;
}

export function listRunLines(
  db: DatabaseSync,
  runId: string,
  sinceSeq = -1,
): RunLogLine[] {
  const rows = db
    .prepare(
      `SELECT seq, occurred_at, raw_json, display_json FROM run_log_lines
       WHERE run_id = ? AND seq > ? ORDER BY seq ASC`,
    )
    .all(runId, sinceSeq) as {
    seq: number;
    occurred_at: string;
    raw_json: string;
    display_json: string;
  }[];
  return rows.map((r) => ({
    seq: r.seq,
    occurredAt: r.occurred_at,
    raw: r.raw_json,
    display: JSON.parse(r.display_json) as LogLine,
  }));
}

/** One windowed line + the wire cost of shipping it (P13-D-11 byte budget). */
export interface SizedRunLogLine extends RunLogLine {
  /** `raw_json` + `display_json` byte length — what this line costs a payload. */
  bytes: number;
}

/**
 * P13-D-11: the NEWEST `limit` lines of a run (optionally strictly before
 * `beforeSeq`), returned OLDEST-first so callers can concatenate them straight
 * into a console.
 *
 * `listRunLines` has no LIMIT, which is exactly why the task loader shipped a
 * task's entire raw execution history on every SSE revalidation (NFR5). This is
 * the bounded read both the loader window and the backward-paging endpoint use.
 */
export function listRunLinesTail(
  db: DatabaseSync,
  runId: string,
  limit: number,
  beforeSeq?: number,
): SizedRunLogLine[] {
  if (limit <= 0) return [];
  const before = beforeSeq ?? Number.MAX_SAFE_INTEGER;
  const rows = db
    .prepare(
      `SELECT seq, occurred_at, raw_json, display_json,
              length(raw_json) + length(display_json) AS bytes
         FROM run_log_lines
        WHERE run_id = ? AND seq < ?
        ORDER BY seq DESC LIMIT ?`,
    )
    .all(runId, before, limit) as {
    seq: number;
    occurred_at: string;
    raw_json: string;
    display_json: string;
    bytes: number;
  }[];
  return rows.reverse().map((r) => ({
    seq: r.seq,
    occurredAt: r.occurred_at,
    raw: r.raw_json,
    display: JSON.parse(r.display_json) as LogLine,
    bytes: r.bytes,
  }));
}

/** Line count + seq bounds for a run — one query, no row bodies (P13-D-11). */
export function runLineStats(
  db: DatabaseSync,
  runId: string,
): { count: number; minSeq: number; maxSeq: number } {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c, MIN(seq) AS lo, MAX(seq) AS hi
         FROM run_log_lines WHERE run_id = ?`,
    )
    .get(runId) as { c: number; lo: number | null; hi: number | null } | undefined;
  return {
    count: row?.c ?? 0,
    minSeq: row?.lo ?? -1,
    maxSeq: row?.hi ?? -1,
  };
}

/**
 * P13-D-2: the run ids on a task whose stream recorded a `session_missing`
 * failure — i.e. the provider transcript behind that run's session id is
 * PROVEN gone. The classified kind rides the err line's tag as a `·<kind>`
 * suffix (the same channel quota/auth use), so the fact is durable without a
 * schema change and visible in the console that showed the failure.
 *
 * `latestSessionRun` (agent-reply) subtracts these so a run row holding a dead
 * session id is not re-selected forever — the permanent-stranding half of D-2.
 * Matched with `json_extract` on the tag, never a LIKE over the whole row, so
 * an agent that merely PRINTS the word cannot mark its own run.
 */
export function runIdsWithMissingSession(
  db: DatabaseSync,
  projectSlug: string,
  taskKey: string,
): Set<string> {
  const rows = db
    .prepare(
      `SELECT DISTINCT l.run_id AS id FROM run_log_lines l
         JOIN agent_runs r ON r.id = l.run_id
        WHERE r.project_slug = ? AND r.task_key = ?
          AND json_extract(l.display_json, '$.tag') LIKE '%session_missing'`,
    )
    .all(projectSlug, taskKey) as { id: string }[];
  return new Set(rows.map((r) => r.id));
}

// -------------------------------------------------- raw .jsonl truth

/**
 * The canonical raw log path: `runtimes/<backend>/<runId>.jsonl`.
 *
 * D5/pass-16: this used to document a `<sessionOrRunId>` key — "the provider
 * session id when known, else the run id" — which NO caller has ever produced
 * (run-sink and the session-missing marker both pass the run id
 * unconditionally). The CODE is the honest half: a resume creates a new run row
 * that SHARES the provider session id, so a session-keyed file would interleave
 * two runs' envelopes into one .jsonl and make each run's raw truth
 * unrecoverable. One file per run, always.
 */
export function rawLogPath(
  backend: RunBackend,
  runId: string,
  dataRoot?: string,
): string {
  return path.join(getDataRoot(dataRoot), "runtimes", backend, `${runId}.jsonl`);
}

/** Append one raw envelope line to the run's canonical .jsonl (creates dirs). */
export function appendRawLine(
  backend: RunBackend,
  runId: string,
  raw: string,
  dataRoot?: string,
): void {
  const file = rawLogPath(backend, runId, dataRoot);
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, raw.replace(/\n+$/, "") + "\n", "utf8");
}

/** Insert one projected log line row (raw + display). Returns the seq used. */
export function insertRunLine(
  db: DatabaseSync,
  input: { runId: string; seq: number; occurredAt: string; raw: string; display: LogLine },
): void {
  db.prepare(
    `INSERT INTO run_log_lines (run_id, seq, occurred_at, raw_json, display_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id, seq) DO NOTHING`,
  ).run(
    input.runId,
    input.seq,
    input.occurredAt,
    input.raw,
    JSON.stringify(input.display),
    new Date().toISOString(),
  );
}
