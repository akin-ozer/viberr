import type { DatabaseSync } from "node:sqlite";
import {
  type LogLine,
  type RunState,
  type RunView,
} from "~/features/runtime/runtime-types";
import { findUserById } from "~/server/auth/user-store.server";
import { listRunLines, listRunsForTaskRows, type AgentRunRow } from "./run-store.server";
import { locateTranscript } from "./session-export.server";

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
 * Signatures that mean "the BACKEND wasn't available" (quota, rate limit,
 * overload, auth/credit) rather than "the task genuinely failed". Matched
 * case-insensitively against an errored run's raw log tail so the UI can offer
 * a retry on the other backend (D4) instead of surfacing a dead end.
 */
const BACKEND_UNAVAILABLE_SIGNATURES = [
  "usage limit",
  "rate limit",
  "quota",
  "insufficient_quota",
  "overloaded",
  "capacity",
  "temporarily unavailable",
  "service unavailable",
  "credit balance",
  "billing",
  "429",
];

function isBackendUnavailableError(raw: string[]): boolean {
  // Only scan the tail — the failure is at the end of the stream.
  const tail = raw.slice(-12).join("\n").toLowerCase();
  return BACKEND_UNAVAILABLE_SIGNATURES.some((s) => tail.includes(s));
}

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
  db: DatabaseSync,
  row: AgentRunRow,
  lines: LogLine[],
  raw: string[],
): RunView {
  const op = row.kind === "operator";
  const backend = row.backend;
  // The picker/header label is the AGENT's own name ("dev"/"Operator"/a
  // reviewer's name) when the run carries an identity; seed/historical rows
  // (null agent_name) fall back to the backend WHO_NAME so nothing regresses.
  const who = op
    ? { kind: "agent" as const, name: row.agent_name ?? "Operator" }
    : {
        kind: "agent" as const,
        backend,
        name: row.agent_name ?? WHO_NAME[backend] ?? "Agent",
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
  // A run can end in `error` because its BACKEND was unavailable / quota-limited
  // rather than because the task genuinely failed. Detect that so the UI can
  // offer a one-click retry on the OTHER backend (D4) instead of leaving the
  // task stalled on an opaque error. The R7-2 fail-fast path emits a STRUCTURED
  // `run·unavailable` err tag (its prose "…is unavailable — no usable
  // credential…" doesn't match the quota/rate-limit signatures), so trust the
  // tag directly and fall back to the prose scan for real backend errors that
  // carry no tag.
  const failedBackendUnavailable =
    row.state === "error" &&
    !op &&
    (lines.some((l) => l.ev === "err" && l.tag === "run·unavailable") ||
      isBackendUnavailableError(raw));
  const altBackend: "claude" | "codex" = backend === "codex" ? "claude" : "codex";
  return {
    id: row.thread_id,
    serverRunId: row.id,
    op: op ? true : undefined,
    role: row.role,
    kind: row.kind,
    profileId: row.agent_profile_id,
    who,
    backend,
    sdk: row.sdk || SDK_LABEL[backend] || "",
    model: row.model,
    sid: row.session_id,
    // P11-43: the Export link 404s when the provider kept no on-disk transcript.
    // Compute REAL exportability here (does the transcript actually exist?) so
    // the UI only offers Export when it will produce a file, not whenever a
    // session id is present.
    exportable: row.session_id
      ? locateTranscript(backend, row.session_id) !== null
      : false,
    state: renderStateOf(row.state, finished),
    lifecycle: row.state,
    interruptedBy,
    ...(failedBackendUnavailable ? { failedBackendUnavailable: true, altBackend } : {}),
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

/**
 * The per-agent grouping key for a run row. Every resume of an agent's session
 * mints a NEW run row (fresh thread id, shared provider session), so grouping
 * by agent collapses all of one agent's runs into a single picker entry:
 *
 *   operator          → "operator"           (one operator thread per task)
 *   specialist/etc.   → "<kind>:<profileId>" (stable across resumes)
 */
function groupKeyOf(row: AgentRunRow): string {
  if (row.kind === "operator") return "operator";
  return `${row.kind}:${row.agent_profile_id}`;
}

/**
 * The REPRESENTATIVE run for a group: the one that is `running` if any, else
 * the most-recently-created. Its thread_id becomes the group's RunView id
 * (selection key) and its row supplies serverRunId — so a running run keeps the
 * live-run strip working and the newest run (a fresh reply) becomes the entry.
 *
 * Rows arrive created_at ASC; we track "latest" as the last seen and prefer the
 * first running row we meet.
 */
function pickRepresentative(rows: AgentRunRow[]): AgentRunRow {
  let running: AgentRunRow | null = null;
  let latest = rows[0]!;
  for (const row of rows) {
    latest = row; // ASC input → the last one is the newest
    if (row.state === "running" && !running) running = row;
  }
  return running ?? latest;
}

/**
 * All runs for a task as RunView[], GROUPED to ONE entry per agent (BUG 2):
 * the operator, the primary specialist (across every resume), and any
 * reviewer each appears exactly once, labeled by the agent's own name.
 *
 * Grouping preserves the representatives' created_at order (the first group a
 * key appears defines its slot), so a task with an operator + a primary "dev"
 * (with many resume runs) + an optional reviewer shows 2–3 named entries.
 */
export function projectRunsForTask(
  db: DatabaseSync,
  projectSlug: string,
  taskKey: string,
): RunView[] {
  const rows = listRunsForTaskRows(db, projectSlug, taskKey);

  // Group rows by agent, preserving first-seen (created_at ASC) group order.
  const order: string[] = [];
  const groups = new Map<string, AgentRunRow[]>();
  for (const row of rows) {
    const key = groupKeyOf(row);
    let bucket = groups.get(key);
    if (!bucket) {
      bucket = [];
      groups.set(key, bucket);
      order.push(key);
    }
    bucket.push(row);
  }

  return order.map((key) => {
    const representative = pickRepresentative(groups.get(key)!);
    const stored = listRunLines(db, representative.id);
    return projectRow(
      db,
      representative,
      stored.map((l) => l.display),
      stored.map((l) => l.raw),
    );
  });
}
