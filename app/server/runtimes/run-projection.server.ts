import type Database from "better-sqlite3";
import {
  type LogLine,
  type RunState,
  type RunView,
} from "~/features/runtime/runtime-types";
import { findUserById } from "~/server/auth/user-store.server";
import { listRunLines, listRunsForTaskRows, type AgentRunRow } from "./run-store.server";

/**
 * Projects agent_runs rows (+ their log lines) into the `RunView[]` the
 * task-detail loader delivers. Field names match the mock so the ported
 * panels stay props-driven (runs.md §3.1, §3.3).
 *
 * Order is preserved as stored (created_at ASC) — that defines the dropdown
 * order and default logs selection (runs.md §3.3). The seed inserts runs in
 * the mock's per-task order.
 */

const SDK_LABEL: Record<string, string> = {
  claude: "Claude Agent SDK",
  codex: "Codex SDK",
};

const WHO_NAME: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

const ISO_RE = /^\d{4}-\d{2}-\d{2}T/;

/**
 * The `finished` display label. Seeded runs store the mock's verbatim label
 * ("9:41", "Mar 30 · 17:26"); real runs store an ISO — format that to a
 * `H:MM` clock. Null → the footer shows the "—" fallback.
 */
function finishedLabel(finishedAt: string | null): string | null {
  if (!finishedAt) return null;
  if (!ISO_RE.test(finishedAt)) return finishedAt; // mock label, verbatim
  const d = new Date(finishedAt);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * Render state (mock's four): the real lifecycle maps directly EXCEPT
 * `finished`, which is either "done" (produced a terminal result — has a
 * finished label) or "idle" (an alive session with no run executing — the
 * operator threads). `queued`/`interrupted` render as idle-shaped; the pill
 * copy for interrupted is handled by the UI reading `lifecycle`.
 */
function renderStateOf(lifecycle: RunState, finished: string | null): RunView["state"] {
  switch (lifecycle) {
    case "running":
      return "running";
    case "error":
      return "error";
    case "finished":
      return finished ? "done" : "idle";
    case "queued":
    case "interrupted":
      return "idle";
  }
}

function projectRow(
  db: Database.Database,
  row: AgentRunRow,
  lines: LogLine[],
  raw: string[],
): RunView {
  const op = row.kind === "operator";
  const backend = row.backend === "simulated" ? "claude" : (row.backend as "claude" | "codex");
  const who = op
    ? { kind: "agent" as const, name: "Operator" }
    : {
        kind: "agent" as const,
        backend,
        name: WHO_NAME[backend] ?? "Agent",
        role: row.role,
      };

  let interruptedBy: RunView["interruptedBy"] = null;
  if (row.interrupted_by) {
    const user = findUserById(db, row.interrupted_by);
    interruptedBy = {
      userId: row.interrupted_by,
      label: user?.name ?? row.interrupted_by,
    };
  }

  const finished = finishedLabel(row.finished_at);
  return {
    id: row.thread_id,
    serverRunId: row.id,
    op: op ? true : undefined,
    role: row.role,
    kind: row.kind,
    who,
    backend,
    simulated: row.simulated === 1,
    sdk: row.sdk || SDK_LABEL[backend] || "",
    model: row.model,
    sid: row.session_id,
    state: renderStateOf(row.state, finished),
    lifecycle: row.state,
    interruptedBy,
    phase: row.phase,
    step: row.step,
    startedAt: row.started_at,
    finished,
    turns: row.turns,
    tokens: row.input_tokens + row.output_tokens,
    lines,
    raw,
    lineCount: lines.length,
  };
}

/** All runs for a task as RunView[] (with full log lines each). */
export function projectRunsForTask(
  db: Database.Database,
  projectSlug: string,
  taskKey: string,
): RunView[] {
  const rows = listRunsForTaskRows(db, projectSlug, taskKey);
  return rows.map((row) => {
    const stored = listRunLines(db, row.id);
    return projectRow(
      db,
      row,
      stored.map((l) => l.display),
      stored.map((l) => l.raw),
    );
  });
}

/** Project a single run row (used by getRunLog after a state change). */
export function projectSingleRun(db: Database.Database, row: AgentRunRow): RunView {
  const stored = listRunLines(db, row.id);
  return projectRow(
    db,
    row,
    stored.map((l) => l.display),
    stored.map((l) => l.raw),
  );
}
