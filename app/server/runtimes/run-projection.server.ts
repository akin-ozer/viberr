import type { DatabaseSync } from "node:sqlite";
import { TAGGED_FAILURE_KINDS, type RunFailureKind } from "~/shared/run-failure";
import {
  runBoundaryLine,
  type LogLine,
  type RunBackend,
  type RunLogWindow,
  type RunState,
  type RunView,
} from "~/features/runtime/runtime-types";
import { findUserById } from "~/server/auth/user-store.server";
import {
  listRunLinesTail,
  listRunsForTaskRows,
  runLineStats,
  type AgentRunRow,
} from "./run-store.server";
import { transcriptExists } from "./session-export.server";

/**
 * Projects agent_runs rows (+ their log lines) into the `RunView[]` the
 * task-detail loader delivers. Field names match the mock so the ported
 * panels stay props-driven (runs.md §3.1, §3.3).
 *
 * Order is preserved as stored (created_at ASC) — that defines the dropdown
 * order and default logs selection (runs.md §3.3). The seed inserts runs in
 * the mock's per-task order.
 */

const SDK_LABEL = {
  claude: "Claude Agent SDK",
  codex: "Codex SDK",
} satisfies Record<RunBackend, string>;

const WHO_NAME = {
  claude: "Claude",
  codex: "Codex",
} satisfies Record<RunBackend, string>;

// ------------------------------------------------- bounded log window (D-11)

/**
 * P13-D-11 / NFR5 ("Timeline rendering for long-lived tasks should remain
 * usable without requiring the client to load the full raw execution history at
 * once"): the loader ships the NEWEST slice of each agent group's console, not
 * all of it. Two budgets, whichever binds first:
 *
 *   • 400 lines — the console renders ~25 rows, so 400 is ~16 screens of
 *     scrollback: comfortably past what anyone scrolls before the first
 *     backward page arrives, while bounding a chatty run that would otherwise
 *     grow without limit.
 *   • 384 KB of `raw_json + display_json` — the real complaint. A measured
 *     pass-13 task carried 420 lines ≈ 928 KB (~2.2 KB/line, dominated by tool
 *     output in the raw envelope) and re-shipped ALL of it on every SSE
 *     revalidation. A line budget alone cannot bound that, because line cost
 *     varies by two orders of magnitude; a byte budget alone would ship 40k
 *     tiny lines. Both, and the payload is bounded either way.
 *
 * This PAGINATES, it does not truncate: UI-53 deliberately widened the console
 * to the agent's whole history on the task, and `logWindow` carries the cursor
 * that walks backwards through it via `/resources/run-log?before=`.
 */
export const RUN_LOG_WINDOW_LINES = 400;
export const RUN_LOG_WINDOW_BYTES = 384 * 1024;

/** Backward-paging cursor + honesty markers for one agent group's console.
 *
 * P13-D-11: declared ONCE, in the client module, and re-exported here. The
 * console pages in older blocks itself and must reproduce the run boundary
 * byte-identically to the ones this projection ships — two definitions of the
 * same shape and two copies of the same literal is precisely how that drifts. */
export type { RunLogWindow };

/** A projected run + its bounded-window metadata (P13-D-11). */
export interface ProjectedRunView extends RunView {
  logWindow: RunLogWindow;
}

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
  // P13-UI-57: this formatted with `getHours()` on the SERVER, so the console
  // showed the server's clock, not the reader's. The ISO travels instead and
  // the panel formats it in the browser (same rule as every other timestamp).
  return finishedAt;
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
  logWindow: RunLogWindow,
): ProjectedRunView {
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
  // `run·unavailable` err tag (its prose does not match the quota/rate-limit
  // signatures), so trust the tag directly and fall back to the prose scan for
  // real backend errors that carry no tag.
  //
  // Ruling 127 added a refusal the other backend CANNOT fix: a run bills a
  // person, and a task with no owner (or an owner whose account is gone) has
  // nobody to bill on either backend. `credential_user_id` is exactly that
  // distinction — the run service records the owner's id even when the refusal
  // was "they have not connected this backend", and leaves it NULL only when no
  // principal was resolvable at all.
  //
  // The two answers travel separately, because one flag cannot carry both. The
  // FAILURE is real on every such run and is stated for every viewer;
  // `altBackend` is the retry OFFER, and only that is withheld when no
  // principal was resolvable. Folding the principal into
  // `failedBackendUnavailable` made the console describe an unowned-task
  // refusal as "stream ended on a continuity error" — the exact mislabelling
  // UI-38 fixed once already, and false twice over here: nothing streamed and
  // no session was lost.
  const noPrincipal = row.credential_user_id === null;
  // Ruling 130(a): the CLASSIFIED terminal line is consulted first, for every
  // run kind (four of pass 34's six live refusals were operator runs); the raw
  // scan stays as the fallback for lines written before the class existed.
  const terminal = [...lines].reverse().find((l) => l.ev === "err" && (l.failure || (l.tag ?? "").startsWith("run·")));
  const failureKind: RunFailureKind | undefined =
    row.state !== "error"
      ? undefined
      : (terminal?.failure?.kind ??
        TAGGED_FAILURE_KINDS.find((k) => (terminal?.tag ?? "").endsWith(`·${k}`)));
  const classifiedUnavailable =
    failureKind === "quota" || failureKind === "auth" || failureKind === "unavailable";
  const taggedUnavailable = lines.some(
    (l) => l.ev === "err" && l.tag === "run·unavailable",
  );
  // A real FALLBACK, which is what the note above says it is. As an `||` arm
  // the raw prose scan also fired for runs that WERE classified — as something
  // else — so a hung or turn-capped run whose log tail merely mentioned "rate
  // limit", "429" or "quota" (an agent quoting an API error it handled, say)
  // was reported as a backend-availability failure and offered a retry on the
  // other backend, which fixes nothing. When the run carries a classification,
  // that classification decides; the scan only speaks for lines written before
  // the class existed.
  const classified = failureKind !== undefined || taggedUnavailable;
  const failedBackendUnavailable =
    row.state === "error" &&
    (classified
      ? classifiedUnavailable || taggedUnavailable
      : isBackendUnavailableError(raw));
  const view: ProjectedRunView = {
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
    // session id is present. `transcriptExists` is the cheap cached probe —
    // never the full locator, which reads whole files and is too heavy per run
    // row on a loader path.
    // Ruling 127: probed in the home of the person the run billed — a run with
    // no principal (refused before it started) never wrote one.
    exportable: row.session_id
      ? transcriptExists(backend, row.credential_user_id, row.session_id)
      : false,
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
    // P13-D-11: the count of lines that EXIST, not of the ones this payload
    // carries (`lines.length`) — the console's "N events" footer must not shrink
    // just because the loader now ships a window.
    lineCount: logWindow.totalLines,
    logWindow,
  };
  if (failureKind) view.failureKind = failureKind;
  // Absent entirely on a run that failed for any other reason. `altBackend` is
  // the D4 offer and rides only when there is a person for the retry to bill
  // (ruling 127): without it the panel states the failure and offers nothing,
  // which is the truth for an unowned task.
  if (failedBackendUnavailable) {
    view.failedBackendUnavailable = true;
    if (!noPrincipal) view.altBackend = backend === "codex" ? "claude" : "codex";
  }
  return view;
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
): ProjectedRunView[] {
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
    const bucket = groups.get(key)!;
    const representative = pickRepresentative(bucket);
    const window = windowForGroup(db, bucket, representative);
    return projectRow(
      db,
      representative,
      window.display,
      window.raw,
      window.meta,
    );
  });
}

/** One agent group's console slice: the projected lines, their raw envelopes
 *  (index-aligned), and the window metadata the client pages with. */
interface GroupConsoleSlice {
  display: LogLine[];
  raw: string[];
  meta: RunLogWindow;
}

/**
 * The newest slice of one agent group's console, within the D-11 budgets.
 *
 * P13-UI-53: the console showed ONLY the representative run's lines, so every
 * earlier run of a resumed agent silently disappeared — a thread that had
 * answered three times looked like it had answered once. It still shows the
 * agent's whole history on the task; the difference (P13-D-11) is that the
 * loader ships the newest page of it and hands back a cursor for the rest.
 *
 * Fills newest-run-first so the tail — the part anyone is actually reading —
 * always survives the budget, then re-assembles chronologically with the same
 * explicit `run N of M` boundary UI-53 introduced.
 */
function windowForGroup(
  db: DatabaseSync,
  bucket: AgentRunRow[],
  representative: AgentRunRow,
): GroupConsoleSlice {
  const stats = bucket.map((row) => runLineStats(db, row.id));
  const totalLines = stats.reduce((sum, s) => sum + s.count, 0);

  let lineBudget = RUN_LOG_WINDOW_LINES;
  let byteBudget = RUN_LOG_WINDOW_BYTES;
  /** Per bucket index (only for runs that contributed), oldest-first later. */
  const included = new Map<number, { seq: number; display: LogLine; raw: string }[]>();

  for (let i = bucket.length - 1; i >= 0; i--) {
    if (lineBudget <= 0 || byteBudget <= 0) break;
    const tail = listRunLinesTail(db, bucket[i]!.id, lineBudget);
    // A run with NO lines yet (the freshly-queued newest resume is the common
    // case) contributes nothing but must not end the walk — otherwise the
    // console would go blank the instant an agent is re-engaged.
    if (tail.length === 0) continue;
    // Drop from the OLDEST end of this run's tail until the byte budget fits —
    // one 300 KB tool output must not evict the whole rest of the window. While
    // nothing is in the window yet, keep at least the newest line even if it
    // busts the budget on its own: an empty console is a worse answer than an
    // oversized one, and the next run of the walk sees an exhausted budget.
    const minKeep = included.size === 0 ? 1 : 0;
    let start = 0;
    let bytes = tail.reduce((sum, l) => sum + l.bytes, 0);
    while (start < tail.length - minKeep && bytes > byteBudget) {
      bytes -= tail[start]!.bytes;
      start += 1;
    }
    // Non-empty tail, nothing kept → the byte budget is spent; older runs are
    // outside the window by definition.
    const kept = tail.slice(start);
    if (kept.length === 0) break;
    lineBudget -= kept.length;
    byteBudget -= bytes;
    included.set(
      i,
      kept.map((l) => ({ seq: l.seq, display: l.display, raw: l.raw })),
    );
  }

  const display: LogLine[] = [];
  const raw: string[] = [];
  let shipped = 0;
  let oldest: RunLogWindow["oldest"] = null;
  let first = true;
  for (let i = 0; i < bucket.length; i++) {
    const lines = included.get(i);
    if (!lines || lines.length === 0) continue;
    if (!oldest) oldest = { runId: bucket[i]!.id, seq: lines[0]!.seq };
    if (!first) {
      display.push(runBoundaryLine(i + 1, bucket.length));
      raw.push("");
    }
    first = false;
    for (const line of lines) {
      display.push(line.display);
      raw.push(line.raw);
      shipped += 1;
    }
  }

  const repIndex = bucket.indexOf(representative);
  return {
    display,
    raw,
    meta: {
      totalLines,
      hasMore: shipped < totalLines,
      runIds: bucket.map((row) => row.id),
      oldest: shipped < totalLines ? oldest : null,
      headSeq: repIndex >= 0 ? stats[repIndex]!.maxSeq : -1,
    },
  };
}
