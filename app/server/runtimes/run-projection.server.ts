import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  consoleBoundaryKey,
  consoleLineKey,
  runBoundaryLine,
  RUN_LOG_WINDOW_LINES,
  SESSION_MISSING_SUFFIX,
  type LogLine,
  type RunBackend,
  type RunLiveFacts,
  type RunLogWindow,
  type RunState,
  type RunView,
} from "~/features/runtime/runtime-types";
import { findUserById } from "~/server/auth/user-store.server";
import { BACKEND_LABEL } from "~/shared/text/backend-label";
import {
  listRunLineDisplays,
  listRunLineSizes,
  listRunLinesTail,
  listRunsForTaskRows,
  runLineRaw,
  runLineStatsForTask,
  type AgentRunRow,
  type RunLineStats,
  type TailBudget,
} from "./run-store.server";
import { transcriptExists } from "./session-export.server";
import { classifyRunEndOf, type RunEnd } from "./provider-refusal.server";

/**
 * Projects agent_runs rows (+ their log lines) into the `RunView[]` the
 * task-detail loader delivers. Field names match the mock so the ported
 * panels stay props-driven (runs.md §3.1, §3.3).
 *
 * Order is preserved as stored (created_at ASC) — that defines the dropdown
 * order and default logs selection (runs.md §3.3). The seed inserts runs in
 * the mock's per-task order.
 */

/** The SDK a backend's runs go through, as the run picker names it — run-service
 *  stamps it on the run row it reserves and starts; a row stored without one
 *  falls back to it here. */
export const SDK_LABEL = {
  claude: "Claude Agent SDK",
  codex: "Codex SDK",
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
 *
 * The line budget is declared in runtime-types.ts, because the console reads
 * it too (ruling 11, CON-2: a tail further behind than one window re-windows).
 */
const RUN_LOG_WINDOW_BYTES = 384 * 1024;

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

/**
 * Ruling 11 (LIVE-1): the facts of a run row that move while it streams —
 * the Live run strip's phase, step, turns and tokens and the console's cache
 * row. One mapping for the loader's `RunView` and the `/resources/run-log`
 * answer the console tails with, so the two can never read a row differently.
 */
export function runLiveFacts(row: AgentRunRow): RunLiveFacts {
  const finished = finishedLabel(row.finished_at);
  const facts: RunLiveFacts = {
    phase: row.phase,
    step: row.step,
    turns: row.turns,
    // F35-1: null until a usage envelope has landed (a Codex run before its
    // first model call completes, a Claude run before its first API message)
    // and the run is still live; a terminal row prints the figure it has
    // rather than "pending" for ever.
    tokens:
      row.usage_final === 0 && row.input_tokens + row.output_tokens === 0 && !finished
        ? null
        : row.input_tokens + row.output_tokens,
    // Whether the figure is an estimate is the column's own question, and the
    // run ending does not answer it: a run somebody stopped, and one that
    // errored before the provider replied, keep the adapter's estimate for
    // good. Dropping the tilde there would print an estimate as the
    // provider's total, which is the dishonesty F35-1 exists to remove, and
    // would disagree with the Insights sums, which leave that same row out.
    tokensEstimated: row.usage_final === 0,
    // Ruling 172: read off the row as stored; the sink folded every figure.
    cache: {
      writeTokens: row.cache_write_tokens,
      readTokens: row.cached_input_tokens,
      firstCall:
        row.first_call_warm === null
          ? null
          : {
              promptTokens: row.first_call_prompt_tokens ?? 0,
              write: row.first_call_cache_write ?? 0,
              read: row.first_call_cache_read ?? 0,
              warm: row.first_call_warm === 1,
              missReason: row.first_call_miss_reason,
            },
      ttlBucket: row.cache_ttl_bucket,
      peakPromptTokens: row.peak_prompt_tokens,
      lastPromptTokens: row.last_prompt_tokens,
      compactions: row.compactions,
    },
  };
  // Ruling 11 (CON-7): the row's version (`patchRun` moves `updated_at` on
  // every fact write), so the console keeps the newer of a revalidation's
  // read and a tail read, whichever lands last.
  const factsAt = Date.parse(row.updated_at);
  if (Number.isFinite(factsAt)) facts.factsAt = factsAt;
  return facts;
}

function projectRow(
  db: DatabaseSync,
  row: AgentRunRow,
  slice: GroupConsoleSlice,
  /** Ruling 155(a) / ruling 92: how the run ended (`classifyRunEndOf`). */
  end: RunEnd,
): ProjectedRunView {
  const { display: lines, raw, keys: lineKeys, meta: logWindow, sessionMissing } = slice;
  const op = row.kind === "operator";
  const backend = row.backend;
  // The picker/header label is the AGENT's own name ("dev"/"Operator"/a
  // reviewer's name) when the run carries an identity; seed/historical rows
  // (null agent_name) fall back to the backend label so nothing regresses.
  const who = op
    ? { kind: "agent" as const, name: row.agent_name ?? "Operator" }
    : {
        kind: "agent" as const,
        backend,
        name: row.agent_name ?? BACKEND_LABEL[backend] ?? "Agent",
        role: row.role,
      };

  // `interrupted_by` is a PERSON (a users.id) or null; a restart is not a
  // person, it is the row's `interrupted_reason` (pass 35 U35-7: boot recovery
  // used to store the literal "restart" here, so this looked it up as a user
  // and the pill named it like one).
  let interruptedBy: RunView["interruptedBy"] = null;
  if (row.interrupted_by) {
    const user = findUserById(db, row.interrupted_by);
    interruptedBy = {
      userId: row.interrupted_by,
      label: user?.name ?? row.interrupted_by,
    };
  }
  const interruptedReason: RunView["interruptedReason"] = row.interrupted_reason;

  const finished = finishedLabel(row.finished_at);
  // A run can end in `error` because its BACKEND was unavailable / quota-limited
  // rather than because the task genuinely failed. Detect that so the UI can
  // offer a one-click retry on the OTHER backend (D4) instead of leaving the
  // task stalled on an opaque error. The R7-2 fail-fast path emits a STRUCTURED
  // `run·unavailable` err tag (its prose does not match the quota/rate-limit
  // signatures), so trust the tag directly and fall back to the prose scan for
  // real backend errors that carry no tag.
  //
  // Ruling 137 added a refusal the other backend CANNOT fix: a run bills a
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
  // Ruling 155(a) / ruling 92: one classification of how the run ended,
  // shared with the review-round counter so the two can never disagree.
  const { failureKind, failureOrigin, failedBackendUnavailable } = end;
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
    // Left out, not null, for a run given none: the console payload carries
    // every run on the task (ruling 11's budget), and most were given none.
    effort: row.effort ?? undefined,
    sid: row.session_id,
    // P11-43: the Export link 404s when the provider kept no on-disk transcript.
    // Compute REAL exportability here (does the transcript actually exist?) so
    // the UI only offers Export when it will produce a file, not whenever a
    // session id is present. `transcriptExists` is the cheap cached probe —
    // never the full locator, which reads whole files and is too heavy per run
    // row on a loader path.
    // Ruling 137: probed in the home of the person the run billed — a run with
    // no principal (refused before it started) never wrote one.
    exportable: row.session_id
      ? transcriptExists(backend, row.credential_user_id, row.session_id)
      : false,
    state: renderStateOf(row.state, finished),
    lifecycle: row.state,
    interruptedBy,
    interruptedReason,
    startedAt: row.started_at,
    finished,
    ...runLiveFacts(row),
    lines,
    raw,
    lineKeys,
    // P13-D-11: the count of lines that EXIST, not of the ones this payload
    // carries (`lines.length`) — the console's "N events" footer must not shrink
    // just because the loader now ships a window.
    lineCount: logWindow.totalLines,
    logWindow,
    sessionMissing,
  };
  if (failureKind) view.failureKind = failureKind;
  if (failureOrigin) view.failureOrigin = failureOrigin;
  // Absent entirely on a run that failed for any other reason. `altBackend` is
  // the D4 offer and rides only when there is a person for the retry to bill
  // (ruling 137): without it the panel states the failure and offers nothing,
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
 * Ruling 300 (owner decision 2, 2026-09-24): how much of each agent group's
 * console a projection carries.
 *
 *   - `all`: every group's window, display lines and stored envelopes. The
 *     server callers (the interrupt result, a reply's log thread) and the
 *     projection's own tests.
 *   - `shown`: a document load. Only the group the console opens on (the
 *     running one, else the first, `shownGroupIndex`) carries its window, and
 *     as display lines only: the envelopes load when the raw view opens.
 *   - `none`: a `.data` request (a revalidation, a client navigation). No
 *     group carries lines; each keeps its window facts, and the console fills
 *     the thread it shows with one `/resources/run-log?window=1` request.
 */
export type ConsoleShipping = "all" | "shown" | "none";

/** How {@link projectRunsForTask} reads a task's runs. */
export interface RunsForTaskOptions {
  console?: ConsoleShipping;
  /** The task's run rows as `listRunsForTaskRows` returns them, when the
   *  caller holds them already (ruling 83). */
  rows?: AgentRunRow[];
}

/**
 * The group the console opens on when nothing is selected, the same rule
 * `AgentLogsPanel` applies: the running one, else the first.
 */
function shownGroupIndex(representatives: AgentRunRow[]): number {
  const running = representatives.findIndex((row) => row.state === "running");
  return running >= 0 ? running : 0;
}

/**
 * All runs for a task as RunView[], GROUPED to ONE entry per agent (BUG 2):
 * the operator, the primary specialist (across every resume), and any
 * reviewer each appears exactly once, labeled by the agent's own name.
 *
 * Grouping preserves the representatives' created_at order (the first group a
 * key appears defines its slot), so a task with an operator + a primary "dev"
 * (with many resume runs) + an optional reviewer shows 2–3 named entries.
 *
 * Ruling 83: a caller that has already read the task's run rows hands them
 * in (`rows`), so the task page reads them once for this and for what the
 * task took; without them this reads its own.
 */
export function projectRunsForTask(
  db: DatabaseSync,
  projectSlug: string,
  taskKey: string,
  { console: shipping = "all", rows }: RunsForTaskOptions = {},
): ProjectedRunView[] {
  const groups = groupRuns(rows ?? listRunsForTaskRows(db, projectSlug, taskKey));
  if (groups.length === 0) return [];
  const representatives = groups.map(pickRepresentative);
  // Ruling 11 (TASK-1): one COUNT/MAX for the task, not one per run.
  const stats = runLineStatsForTask(db, projectSlug, taskKey);
  const shown = shipping === "shown" ? shownGroupIndex(representatives) : -1;
  return groups.map((bucket, i) => {
    const representative = representatives[i]!;
    const read: WindowRead = shipping === "all" ? "full" : i === shown ? "display" : "sizes";
    return projectRow(
      db,
      representative,
      windowForGroup(db, bucket, representative, stats, read),
      classifyRunEndOf(db, representative),
    );
  });
}

/** Rows grouped by agent, in first-seen (created_at ASC) group order. */
function groupRuns(rows: AgentRunRow[]): AgentRunRow[][] {
  const order: AgentRunRow[][] = [];
  const groups = new Map<string, AgentRunRow[]>();
  for (const row of rows) {
    const key = groupKeyOf(row);
    let bucket = groups.get(key);
    if (!bucket) {
      bucket = [];
      groups.set(key, bucket);
      order.push(bucket);
    }
    bucket.push(row);
  }
  return order;
}

/**
 * Ruling 300 (TASK-1, owner decision 2): the console window of the agent group
 * `run` belongs to, as the task loader would ship it for the shown group:
 * display lines, their keys and the window facts, plus the representative's
 * live facts. The console fills a thread with this one request when the page
 * payload did not carry it (a client navigation, a revalidation, or a group
 * other than the one a hard refresh opened on).
 */
export interface RunLogWindowPage {
  /** The group's representative run and its thread id right now. */
  runId: string;
  threadId: string;
  lines: LogLine[];
  lineKeys: string[];
  logWindow: RunLogWindow;
  facts: RunLiveFacts;
}

export function runLogWindowFor(db: DatabaseSync, run: AgentRunRow): RunLogWindowPage {
  const key = groupKeyOf(run);
  const bucket = listRunsForTaskRows(db, run.project_slug, run.task_key).filter(
    (row) => groupKeyOf(row) === key,
  );
  // The run itself is always in its own group; the guard only keeps a row
  // deleted mid-request from indexing an empty bucket.
  const group = bucket.length > 0 ? bucket : [run];
  const representative = pickRepresentative(group);
  const slice = windowForGroup(
    db,
    group,
    representative,
    runLineStatsForTask(db, run.project_slug, run.task_key),
    "display",
  );
  return {
    runId: representative.id,
    threadId: representative.thread_id,
    lines: slice.display,
    lineKeys: slice.keys,
    logWindow: slice.meta,
    facts: runLiveFacts(representative),
  };
}

/** One agent group's console slice: the projected lines, their raw envelopes
 *  (index-aligned, or empty when not read), their keys, the window metadata
 *  the client pages with, and the continuity marker inside the window. */
interface GroupConsoleSlice {
  display: LogLine[];
  raw: string[];
  keys: string[];
  meta: RunLogWindow;
  sessionMissing: RunView["sessionMissing"];
}

/**
 * How much of each line a window reads (ruling 300): `full` bodies and
 * envelopes, `display` bodies only, `sizes` neither (only the facts that
 * bound the window and find the continuity marker).
 */
type WindowRead = "full" | "display" | "sizes";

/** One line inside a window, as much of it as the read asked for. */
interface WindowLine {
  seq: number;
  bytes: number;
  tag: string;
  display: LogLine | null;
  raw: string | null;
}

/**
 * The newest lines of one run that fit what is left of the window, oldest
 * first: drop from the OLDEST end of the run's tail until the byte budget
 * fits — one 300 KB tool output must not evict the whole rest of the window —
 * but keep at least `budget.keep` of the newest (see `windowForGroup`). The
 * two ruling-11 reads apply that rule inside their query, so a line outside
 * the window is neither returned nor parsed.
 */
function readTail(db: DatabaseSync, runId: string, budget: TailBudget, read: WindowRead): WindowLine[] {
  if (read === "display") {
    return listRunLineDisplays(db, runId, budget).map((l) => ({
      seq: l.seq,
      bytes: l.bytes,
      tag: l.display.tag,
      display: l.display,
      raw: null,
    }));
  }
  if (read === "sizes") {
    return listRunLineSizes(db, runId, budget).map((l) => ({
      seq: l.seq,
      bytes: l.bytes,
      tag: l.tag,
      display: null,
      raw: null,
    }));
  }
  const tail = listRunLinesTail(db, runId, budget.lines);
  let start = 0;
  let bytes = tail.reduce((sum, l) => sum + l.bytes, 0);
  while (start < tail.length - budget.keep && bytes > budget.bytes) {
    bytes -= tail[start]!.bytes;
    start += 1;
  }
  return tail.slice(start).map((l) => ({
    seq: l.seq,
    bytes: l.bytes,
    tag: l.display.tag,
    display: l.display,
    raw: l.raw,
  }));
}

/** The one field the continuity panel reads out of a marker's envelope. A
 *  blank id is the same as none: the panel must not print `session <empty>`. */
const deadSessionEnvelope = z.object({ session_id: z.string().trim().min(1) });

/**
 * The dead session id from the marker line's STORED wire envelope. Structured,
 * not scraped: `recordSessionMissing` writes `{type:"error", source:"viberr",
 * reason:"session_missing", session_id, message}`. An adapter envelope that
 * carries no id yields null, and the panel says nothing about a session it
 * cannot name.
 */
function deadSessionId(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const envelope = deadSessionEnvelope.safeParse(JSON.parse(raw));
    return envelope.success ? envelope.data.session_id : null;
  } catch {
    return null;
  }
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
 *
 * Ruling 300: the window is bounded the same way whatever `read` carries, so a
 * thread the console fills later gets exactly the window a document load
 * would have shipped, and the continuity marker (P13-D-2) counts only while it
 * is inside that window (the panel's retirement rule, continuity-recovery.tsx).
 */
function windowForGroup(
  db: DatabaseSync,
  bucket: AgentRunRow[],
  representative: AgentRunRow,
  stats: Map<string, RunLineStats>,
  read: WindowRead,
): GroupConsoleSlice {
  const countOf = (row: AgentRunRow) => stats.get(row.id)?.count ?? 0;
  const totalLines = bucket.reduce((sum, row) => sum + countOf(row), 0);

  let lineBudget = RUN_LOG_WINDOW_LINES;
  let byteBudget = RUN_LOG_WINDOW_BYTES;
  /** Per bucket index (only for runs that contributed), oldest-first later. */
  const included = new Map<number, WindowLine[]>();

  for (let i = bucket.length - 1; i >= 0; i--) {
    if (lineBudget <= 0 || byteBudget <= 0) break;
    // A run with NO lines yet (the freshly-queued newest resume is the common
    // case) contributes nothing but must not end the walk — otherwise the
    // console would go blank the instant an agent is re-engaged. The task's
    // counts say so without a query.
    if (countOf(bucket[i]!) === 0) continue;
    // While nothing is in the window yet, keep at least the newest line even
    // if it busts the budget on its own: an empty console is a worse answer
    // than an oversized one, and the next run of the walk sees an exhausted
    // budget.
    const kept = readTail(
      db,
      bucket[i]!.id,
      { lines: lineBudget, bytes: byteBudget, keep: included.size === 0 ? 1 : 0 },
      read,
    );
    // A run with lines but none kept → the byte budget is spent; older runs
    // are outside the window by definition.
    if (kept.length === 0) break;
    lineBudget -= kept.length;
    byteBudget -= kept.reduce((sum, l) => sum + l.bytes, 0);
    included.set(i, kept);
  }

  const shipped = read !== "sizes";
  const display: LogLine[] = [];
  const raw: string[] = [];
  const keys: string[] = [];
  let count = 0;
  let oldest: RunLogWindow["oldest"] = null;
  let marker: { runId: string; line: WindowLine } | null = null;
  let first = true;
  for (let i = 0; i < bucket.length; i++) {
    const lines = included.get(i);
    if (!lines || lines.length === 0) continue;
    if (!oldest) oldest = { runId: bucket[i]!.id, seq: lines[0]!.seq };
    if (!first && shipped) {
      display.push(runBoundaryLine(i + 1, bucket.length));
      if (read === "full") raw.push("");
      keys.push(consoleBoundaryKey(i));
    }
    first = false;
    for (const line of lines) {
      count += 1;
      if (!marker && line.tag.endsWith(SESSION_MISSING_SUFFIX)) marker = { runId: bucket[i]!.id, line };
      if (!shipped) continue;
      display.push(line.display!);
      if (read === "full") raw.push(line.raw ?? "");
      keys.push(consoleLineKey(i, line.seq));
    }
  }

  const repStats = stats.get(representative.id);
  return {
    display,
    raw,
    keys,
    meta: {
      totalLines,
      hasMore: count < totalLines,
      runIds: bucket.map((row) => row.id),
      oldest: count < totalLines ? oldest : null,
      headSeq: repStats ? repStats.maxSeq : -1,
      loaded: shipped,
    },
    sessionMissing: marker
      ? {
          sessionId: deadSessionId(
            marker.line.raw ?? runLineRaw(db, marker.runId, marker.line.seq),
          ),
        }
      : null,
  };
}
