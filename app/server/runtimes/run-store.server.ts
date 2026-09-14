import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type {
  LogLine,
  RunBackend,
  RunInterruptedReason,
  RunKind,
  RunState,
} from "~/features/runtime/runtime-types";
import { getDataRoot } from "~/server/files/file-store-root.server";

/**
 * Run persistence: the RAW .jsonl append (canonical truth, under
 * ${VIBERR_DATA_ROOT}/runtimes/<backend>/<sessionOrRunId>.jsonl) and the DB
 * projection rows (agent_runs + run_log_lines). Callers append a line via
 * `appendRunLine` (raw file + DB row) and read via the query helpers here.
 */

/** One `agent_runs` row, column-for-column. A row is a plain record, so this is
 *  a type alias rather than an interface: the boundary reads below convert
 *  `node:sqlite`'s own row type into it directly, with no `unknown` hop. */
export type AgentRunRow = {
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
  /** F35-1: 1 once a PROVIDER usage figure landed on the row (a Claude result,
   *  a Codex turn.completed), 0 while the token columns hold the Claude
   *  adapter's live estimate or nothing at all. The projection prints an
   *  estimated row as `~n`; Insights leaves it out of its token totals. */
  usage_final: number;
  total_cost_usd: number | null;
  /** The PERSON who interrupted the run (a users.id), else null. Never a
   *  pseudo-actor: a restart is a reason (below), not a person. */
  interrupted_by: string | null;
  /** Pass 35 U35-7: why an `interrupted` run stopped when no person did it
   *  (`'restart'` = boot recovery / the operator drive's orphan sweep). Null
   *  on every other row, a human interrupt included. */
  interrupted_reason: RunInterruptedReason | null;
  created_at: string;
  updated_at: string;
  /** Staging key for a Claude `report_outcome` envelope (`staged_outcomes`).
   *  Null on every row that never staged one (Codex, recovered, seed rows).
   *  Persisted so boot recovery can re-find the envelope after a restart —
   *  see `recoverUnreactedAgentRuns`. */
  outcome_key: string | null;
  /** Dispatch-completion contract (pass 32, C02-R11): the display name and
   *  user id of the human whose manual/scheduled dispatch started this run.
   *  Persisted (like `outcome_key`) so boot recovery re-supplies them — the
   *  in-process closure that carried them dies with the process, and a run
   *  recovered after a restart used to post its report with no cc line and
   *  without the guaranteed operator re-invoke. Null on every other run. */
  dispatched_by_name: string | null;
  dispatched_by_user_id: string | null;
  /** Ruling 127: the credential principal — the person whose connected backend
   *  account this run bills, and whose runtime home holds its transcript. Task
   *  runs carry the task owner, controller turns the asker. Null only on a run
   *  refused before any credential was looked up (an unowned task). */
  credential_user_id: string | null;
};

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
  interruptedReason?: RunInterruptedReason | null;
  /** Ruling 127: the credential principal (see `AgentRunRow.credential_user_id`).
   *  Optional at THIS layer — the store is a plain writer, also driven by
   *  fixtures that build a row directly, and an omitted principal stores NULL.
   *  The rule "a run that spawned a process has a principal" is enforced one
   *  level up, where `StartRunInput`/`ReserveRunInput` require the field. */
  credentialUserId?: string | null;
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
        interrupted_by, interrupted_reason, credential_user_id, created_at, updated_at)
     VALUES
       (@id, @taskKey, @projectSlug, @threadId, @role, @kind, @backend,
        @model, @sessionId, @sdk, @agentName, @agentProfileId, @state, @phase, @step,
        @startedAt, @finishedAt,
        @turns, @inputTokens, @cachedInputTokens, @outputTokens, @totalCostUsd,
        @interruptedBy, @interruptedReason, @credentialUserId, @createdAt, @updatedAt)
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
        interrupted_by=excluded.interrupted_by,
        interrupted_reason=excluded.interrupted_reason,
        credential_user_id=excluded.credential_user_id,
        updated_at=excluded.updated_at`,
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
    interruptedReason: input.interruptedReason ?? null,
    credentialUserId: input.credentialUserId ?? null,
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
  /** See `AgentRunRow.usage_final` (F35-1): 1 once a provider figure landed. */
  usageFinal?: 0 | 1;
  totalCostUsd?: number | null;
  interruptedBy?: string | null;
  /** Pass 35 U35-7: the reason an `interrupted` run stopped with no person
   *  behind it. The orphan sweeps write `"restart"`; nothing else writes it. */
  interruptedReason?: RunInterruptedReason | null;
  backend?: RunBackend;
  /** C1 (pass 31): the `staged_outcomes` key for this run's Claude
   *  `report_outcome` envelope. It used to be written by a raw
   *  `UPDATE agent_runs SET outcome_key = ?` in `registerAgentCompletion`,
   *  which meant the store's own types did not know the column existed and
   *  `AgentRunRow` silently lied about the row shape. Patched like every other
   *  column now, so the exhaustiveness check below covers it too. */
  outcomeKey?: string | null;
  /** See `AgentRunRow.dispatched_by_name` (pass 32, C02-R11). */
  dispatchedByName?: string | null;
  dispatchedByUserId?: string | null;
  /** Ruling 127: the credential principal, patchable like `backend` is — the
   *  start path stamps it onto the row a reservation already inserted, without
   *  re-writing every other column of a run that is already live. */
  credentialUserId?: string | null;
}

/** Patch selected fields on a run row; always bumps updated_at. */
export function patchRun(db: DatabaseSync, runId: string, patch: RunPatch): void {
  // Each patchable field paired with the column it writes. `satisfies` keeps the
  // set exhaustive, so a field added to `RunPatch` cannot silently stop being
  // persisted.
  const assignable = {
    sessionId: ["session_id", patch.sessionId],
    state: ["state", patch.state],
    phase: ["phase", patch.phase],
    step: ["step", patch.step],
    startedAt: ["started_at", patch.startedAt],
    finishedAt: ["finished_at", patch.finishedAt],
    turns: ["turns", patch.turns],
    inputTokens: ["input_tokens", patch.inputTokens],
    cachedInputTokens: ["cached_input_tokens", patch.cachedInputTokens],
    outputTokens: ["output_tokens", patch.outputTokens],
    usageFinal: ["usage_final", patch.usageFinal],
    totalCostUsd: ["total_cost_usd", patch.totalCostUsd],
    interruptedBy: ["interrupted_by", patch.interruptedBy],
    interruptedReason: ["interrupted_reason", patch.interruptedReason],
    backend: ["backend", patch.backend],
    outcomeKey: ["outcome_key", patch.outcomeKey],
    dispatchedByName: ["dispatched_by_name", patch.dispatchedByName],
    dispatchedByUserId: ["dispatched_by_user_id", patch.dispatchedByUserId],
    credentialUserId: ["credential_user_id", patch.credentialUserId],
  } satisfies Record<keyof RunPatch, readonly [string, SQLInputValue | undefined]>;

  const cols: string[] = [];
  const values: SQLInputValue[] = [];
  for (const [column, value] of Object.values(assignable)) {
    if (value === undefined) continue;
    cols.push(`${column} = ?`);
    values.push(value);
  }
  if (cols.length === 0) return;
  db.prepare(`UPDATE agent_runs SET ${cols.join(", ")}, updated_at = ? WHERE id = ?`).run(
    ...values,
    new Date().toISOString(),
    runId,
  );
}

export function getRun(db: DatabaseSync, runId: string): AgentRunRow | null {
  // SAFETY: `agent_runs` declares every column of `AgentRunRow` — NOT NULL on
  // the non-nullable ones, plus CHECK constraints pinning kind/backend/state to
  // exactly the members of RunKind/RunBackend/RunState (0001_baseline.sql).
  return (db.prepare(`SELECT * FROM agent_runs WHERE id = ?`).get(runId) as AgentRunRow | undefined) ?? null;
}

export function listRunsForTaskRows(
  db: DatabaseSync,
  projectSlug: string,
  taskKey: string,
): AgentRunRow[] {
  // SAFETY: same `agent_runs` DDL guarantee as `getRun`.
  return db
    .prepare(
      `SELECT * FROM agent_runs WHERE project_slug = ? AND task_key = ?
       ORDER BY created_at ASC, rowid ASC`,
    )
    .all(projectSlug, taskKey) as AgentRunRow[];
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
  // SAFETY: `agent_profile_id` is NOT NULL TEXT and the WHERE clause excludes
  // every row whose `agent_name` is NULL or empty, so both aliases are strings.
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
  // SAFETY: `MAX()` over the INTEGER `seq` column yields a number, or NULL when
  // the run has no lines yet.
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
  /** C02-R12 (pass 32): an optional bound pushed into the SELECT — the
   *  viberr_ops forward page. Absent ⇒ unbounded (the console's live tail). */
  limit?: number,
): RunLogLine[] {
  const bounded = limit !== undefined && Number.isFinite(limit) && limit >= 0;
  // SAFETY: `run_log_lines` declares all four selected columns NOT NULL — `seq`
  // INTEGER, the rest TEXT (0001_baseline.sql).
  const rows = (
    bounded
      ? db
          .prepare(
            `SELECT seq, occurred_at, raw_json, display_json FROM run_log_lines
             WHERE run_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
          )
          .all(runId, sinceSeq, limit)
      : db
          .prepare(
            `SELECT seq, occurred_at, raw_json, display_json FROM run_log_lines
             WHERE run_id = ? AND seq > ? ORDER BY seq ASC`,
          )
          .all(runId, sinceSeq)
  ) as {
    seq: number;
    occurred_at: string;
    raw_json: string;
    display_json: string;
  }[];
  // SAFETY: `display_json` is written by `insertRunLine` and nowhere else, as
  // `JSON.stringify` of the `LogLine` it was handed.
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
  // SAFETY: same NOT NULL guarantee as `listRunLines`; `length()` over two NOT
  // NULL TEXT columns is an integer.
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
  // SAFETY: `display_json` holds exactly what `insertRunLine` stringified.
  return rows.reverse().map((r) => ({
    seq: r.seq,
    occurredAt: r.occurred_at,
    raw: r.raw_json,
    display: JSON.parse(r.display_json) as LogLine,
    bytes: r.bytes,
  }));
}

/** How much console a run holds: line count plus its seq bounds. `minSeq` and
 *  `maxSeq` read -1 when the run has no lines. */
export interface RunLineStats {
  count: number;
  minSeq: number;
  maxSeq: number;
}

/** Line count + seq bounds for a run — one query, no row bodies (P13-D-11). */
export function runLineStats(db: DatabaseSync, runId: string): RunLineStats {
  // SAFETY: `COUNT()` is always an integer; `MIN`/`MAX` over the INTEGER `seq`
  // column are numbers, or NULL when the run has no lines.
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
  // SAFETY: `run_log_lines.run_id` is NOT NULL TEXT (0001_baseline.sql).
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

/**
 * Ruling 242 (pass 37, F37-69): did `profileId` RUN on this task since `since`?
 *
 * The signal ruling 204's round counter was reaching for. That ruling made a
 * reviewer's repeat objection on the same revision count as a fresh round,
 * because in a real deadlock the deliverer commits nothing and no new revision
 * is ever minted — SHOP-9, where the count would otherwise have sat at 1 while
 * the loop ran. What it could not distinguish is a repeat objection with NO
 * rework behind it at all, which is what ruling 237's own escalation question
 * provokes: the reviewer is asked to answer, answers, and verdicts again on an
 * untouched revision.
 *
 * A DELIVERER RUN is the thing that separates them. In SHOP-9 the deliverer ran
 * and reported it had nothing in scope to change; on SHOP-25's question run
 * nobody reworked anything.
 *
 * Counts every run row whatever its state: a deliverer that was dispatched and
 * crashed still means a round was fought, and reading `finished` only would let
 * a failing rework loop climb forever without the counter noticing.
 */
export function profileRanSince(
  db: DatabaseSync,
  projectSlug: string,
  taskKey: string,
  profileId: string,
  since: string,
): boolean {
  // SAFETY: `COUNT(*)` always returns exactly one row holding one integer.
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM agent_runs
        WHERE project_slug = ? AND task_key = ? AND agent_profile_id = ?
          AND created_at > ?`,
    )
    .get(projectSlug, taskKey, profileId, since) as { n: number };
  return row.n > 0;
}
