import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  type Dirent,
} from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { RealBackend } from "./runtime-registry.server";
import { createLineRedactor } from "./run-sink.server";
import { userBackendHome } from "./user-homes.server";

/**
 * Locate the on-disk provider session transcript for a run so it can be
 * EXPORTED and resumed on another machine (same subscription). The agents run
 * inside the app's runtime (in Docker, on the data volume); each provider keeps
 * its own resumable transcript there, keyed by the session id the UI shows.
 *
 * Ruling 127: "there" is the CREDENTIAL PRINCIPAL's own runtime home — the run
 * row's `credential_user_id` — because that is the home the binary was spawned
 * with:
 *
 *   Claude Code : runtimes/users/<id>/claude-home/projects/<cwd-as-dashes>/<sid>.jsonl
 *   Codex       : runtimes/users/<id>/codex-home/sessions/YYYY/MM/DD/rollout-<ts>-<sid>.jsonl
 *
 * Every entry point therefore takes the principal's user id, and a run with a
 * NULL principal (one refused before any process started) has no transcript at
 * all — the export route 404s, as it already did for a run whose provider kept
 * none. Searching every user's home for a session id would be worse than
 * useless: it would hand one person's conversation to whoever could name it.
 *
 * We locate the file by the session id itself (globbing the per-project dirs /
 * dated rollout dirs) so we never depend on reproducing the cwd→folder
 * encoding. The exported transcript is what `claude --resume <id>` /
 * `codex resume <id>` replay to continue the conversation locally.
 */

export interface LocatedTranscript {
  backend: RealBackend;
  sessionId: string;
  /** Absolute path to the transcript .jsonl on the app's filesystem. */
  filePath: string;
  /** The working directory baked into the transcript (the container's cwd). */
  cwd: string | null;
  /** Number of transcript lines (rough size signal for the UI). */
  lineCount: number;
  /** Bytes on disk. */
  bytes: number;
}

/** The `…/sessions` dir of ONE person's codex home — the only place a run
 *  billed to them could have written a rollout (ruling 127). Empty when the
 *  home does not exist, or when the run had no principal. */
function codexSessionDirs(userId: string | null, dataRoot?: string): string[] {
  if (!userId) return [];
  const dir = path.join(userBackendHome(userId, "codex", dataRoot), "sessions");
  return existsSync(dir) ? [dir] : [];
}

/** The `projects` dir of ONE person's claude home, or null when there is no
 *  principal to look under. */
function claudeProjectsDir(
  userId: string | null,
  dataRoot?: string,
): string | null {
  if (!userId) return null;
  return path.join(userBackendHome(userId, "claude", dataRoot), "projects");
}

/**
 * The only field this module reads out of a transcript line: Claude writes the
 * working directory at the top level, Codex nests it under `payload`. Both are
 * `.catch(undefined)` per field — one line carrying a junk `cwd` must fall
 * through to the same line's `payload.cwd` (and then to the next line), exactly
 * as the hand-decoded version did.
 */
const transcriptCwdLineSchema = z.object({
  cwd: z.string().optional().catch(undefined),
  payload: z
    .object({ cwd: z.string().optional().catch(undefined) })
    .optional()
    .catch(undefined),
});

/** Read the cwd baked into a Claude/Codex transcript's first line that carries one. */
function transcriptCwd(filePath: string): string | null {
  try {
    const text = readFileSync(filePath, "utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue; // skip non-JSON lines
      }
      const decoded = transcriptCwdLineSchema.safeParse(parsed);
      if (!decoded.success) continue;
      const cwd = decoded.data.cwd ?? decoded.data.payload?.cwd;
      if (cwd !== undefined) return cwd;
    }
  } catch {
    // unreadable → no cwd
  }
  return null;
}

/** Rough size signals for one transcript file (see {@link LocatedTranscript}). */
interface TranscriptSize {
  lineCount: number;
  bytes: number;
}

function fileStats(filePath: string): TranscriptSize {
  try {
    const text = readFileSync(filePath, "utf8");
    const lineCount = text.split("\n").filter((l) => l.trim()).length;
    return { lineCount, bytes: Buffer.byteLength(text, "utf8") };
  } catch {
    return { lineCount: 0, bytes: 0 };
  }
}

/** Claude: `<sid>.jsonl` inside any per-project dir under the principal's
 *  `claude-home/projects/` (search every project dir by session id). */
function locateClaude(
  userId: string | null,
  sessionId: string,
  dataRoot?: string,
): string | null {
  const projectsDir = claudeProjectsDir(userId, dataRoot);
  if (!projectsDir || !existsSync(projectsDir)) return null;
  let entries: string[];
  try {
    entries = readdirSync(projectsDir);
  } catch {
    return null;
  }
  for (const dir of entries) {
    const candidate = path.join(projectsDir, dir, `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Codex: a `rollout-…jsonl` whose filename embeds the session id, found by
 *  recursively walking the dated dirs under each codex `sessions` root.
 *  Filename-only walk — no file reads. */
function codexTranscriptByFilename(
  userId: string | null,
  sessionId: string,
  dataRoot?: string,
): string | null {
  return rolloutByFilename(codexSessionDirs(userId, dataRoot), sessionId);
}

/** The walk behind {@link codexTranscriptByFilename}, over the given
 *  `sessions` roots (a missing root is skipped). */
function rolloutByFilename(roots: readonly string[], sessionId: string): string | null {
  const stack = [...roots];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (entry.name.endsWith(".jsonl") && entry.name.includes(sessionId)) {
        return full; // filename embeds the id
      }
    }
  }
  return null;
}

/** Content fallback: the id appears in the session-meta (first line). Reads
 *  every candidate file — export-route only, never on a loader path. */
function codexTranscriptByContent(
  userId: string | null,
  sessionId: string,
  dataRoot?: string,
): string | null {
  const stack: string[] = codexSessionDirs(userId, dataRoot);
  if (stack.length === 0) return null;
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.name.endsWith(".jsonl")) continue;
      try {
        const head = readFileSync(full, "utf8").split("\n", 1)[0] ?? "";
        if (head.includes(sessionId)) return full;
      } catch {
        // ignore
      }
    }
  }
  return null;
}

function locateCodex(
  userId: string | null,
  sessionId: string,
  dataRoot?: string,
): string | null {
  return (
    codexTranscriptByFilename(userId, sessionId, dataRoot) ??
    codexTranscriptByContent(userId, sessionId, dataRoot)
  );
}

// ------------------------------------------------------- existence probe

/**
 * Cheap existence probe for read models (the P11-43 `exportable` flag): the run
 * projection only needs "will Export produce a file?", not the located stats.
 * `locateTranscript` is too heavy per run row on a loader path — it reads whole
 * files (line counts, the Codex content-scan fallback). This probe matches by
 * FILENAME only (no file reads) and caches results briefly, so a task-detail
 * load with many runs costs at most one directory walk per stale entry. A
 * transcript findable only by the content scan shows no Export link (a
 * conservative miss); the export route itself still runs the full locator.
 */
const TRANSCRIPT_EXISTS_TTL_MS = 30_000;
const TRANSCRIPT_EXISTS_MAX_ENTRIES = 500;
const transcriptExistsCache = new Map<string, { ok: boolean; at: number }>();

export function transcriptExists(
  backend: RealBackend,
  /** Ruling 127: the run row's `credential_user_id` — whose home to look in.
   *  Null (a refused run) has no transcript by construction. */
  userId: string | null,
  sessionId: string,
  dataRoot?: string,
): boolean {
  if (!sessionId || !userId) return false;
  // The principal is part of the key: the same session id under a different
  // home is a different question, and a shared key would serve one person's
  // answer for another's run.
  const key = `${backend}:${userId}:${sessionId}`;
  const cached = transcriptExistsCache.get(key);
  const now = Date.now();
  if (cached && now - cached.at < TRANSCRIPT_EXISTS_TTL_MS) return cached.ok;
  const ok =
    backend === "codex"
      ? codexTranscriptByFilename(userId, sessionId, dataRoot) !== null
      : locateClaude(userId, sessionId, dataRoot) !== null;
  if (
    transcriptExistsCache.size >= TRANSCRIPT_EXISTS_MAX_ENTRIES &&
    !transcriptExistsCache.has(key)
  ) {
    const oldest = transcriptExistsCache.keys().next().value;
    if (oldest !== undefined) transcriptExistsCache.delete(oldest);
  }
  transcriptExistsCache.delete(key);
  transcriptExistsCache.set(key, { ok, at: now });
  return ok;
}

// --------------------------------------------------- resume-time continuity

/**
 * P13-D-2: whether a stored session id still has provider-side history.
 *
 *   present — the transcript is on disk; a resume will replay it.
 *   missing — the transcript store EXISTS but holds nothing for this id
 *             (Claude Code's ~30-day retention swept it, or a `docker-data`
 *             wipe took `$CODEX_HOME/sessions` with it).
 *   unknown — there is no transcript store to look in at all, so absence
 *             proves nothing.
 *
 * The three-valued answer is the whole point. A boolean would read "no store"
 * as "session gone" and force a fresh run on every deployment whose provider
 * writes transcripts somewhere this process cannot see — degrading continuity
 * to fix a continuity bug. `unknown` resumes exactly as before.
 *
 * Ruling 434: `damaged` — the transcript is there and the CLI will refuse it.
 * A Codex rollout must open with its `session_meta` line; three on this
 * instance (Codex CLI 0.156) had a `task_started` line written over the head
 * of it, and every resume of those sessions failed.
 */
export type SessionContinuity = "present" | "missing" | "damaged" | "unknown";

/**
 * How the two CLIs report a resume against a session they no longer hold —
 * Claude's `--resume <id>` prints "No conversation found with session ID …"
 * (the exact string the export installer warns about at the bottom of
 * RESUME_SCRIPT_TEMPLATE); Codex's `resume <id>` reports the rollout as not
 * found. Shared by both adapters' classifiers and by `runFailureReason`, so a
 * vanished session is never narrated as an authentication problem.
 */
export const SESSION_MISSING_RE =
  /no conversation found|conversation not found|session not found|no session (?:with|found)|unknown session|no such session|rollout not found|no rollout/i;

/**
 * Ruling 434: what the Codex CLI says when a rollout's head is torn —
 * "rollout at <path> does not start with session metadata (code -32603)".
 * The session cannot be resumed and fresh runs still work, which is
 * `session_missing`'s outcome; the classifier gives it its own sentence.
 */
export const SESSION_DAMAGED_RE = /does not start with session metadata/i;

/**
 * Ruling 221 (F37-41): the same outcome by a different road — the store the
 * CLI keeps its conversations in is THERE and cannot be opened.
 *
 * Live on pass 37, after the host corrupted a SQLite file under load:
 *
 *   internal error: failed to open thread history database: failed to open
 *   thread history DB at /data/runtimes/users/<u>/codex-home/thread_history_1.sqlite:
 *   error returned from database: (code: 26) file is not a database
 *
 * That text matched nothing, fell through to the auth branch, and viberr told
 * the owner to "review its authentication and runtime configuration" and
 * recommended re-writing the directive. The credential was fine and no prompt
 * could have helped: the file's first page was not a SQLite header at all, so
 * every RESUME failed while fresh runs kept working — which is exactly the
 * shape {@link SESSION_MISSING_RE} already classifies, and whose remedy (one
 * fresh run, re-anchored on task.md) is already the right one.
 *
 * Deliberately anchored on the STORE's own nouns rather than on "not a
 * database" alone: an agent building a SQLite-backed service can print that
 * sentence out of its own work, and a run is not a session failure because the
 * code it was writing hit a bad file.
 */
/**
 * Ruling 221: the clause viberr's OWN sentence about an unreadable store
 * carries, so the remedy layer can tell the two roads into `session_missing`
 * apart without re-parsing the provider's prose a second time. The adapter
 * writes it; `runFailureReason` reads it; both sides pin it in their tests.
 */
export const SESSION_STORE_UNREADABLE_MARK =
  "session store on this host could not be opened";

export const SESSION_STORE_UNREADABLE_RE =
  /failed to open (?:the )?(?:thread[-_ ]?history|session|rollout|conversation)[-_ ]?(?:database|db|store|index)|thread[-_]history[\w-]*\.sqlite|(?:sessions?|rollouts?)\.sqlite[^\n]*(?:not a database|malformed|corrupt)/i;

/**
 * The resume-time probe. Deliberately NOT `transcriptExists`, which is the
 * loader-path Export-button probe: that one caches for 30 s (a stale `true`
 * would resume the dead id we are trying to detect) and matches Codex rollouts
 * by FILENAME only (a conservative miss there merely hides an Export link —
 * here it would throw away a live session's context). This one is uncached and
 * uses the full locator per backend, minus the file reads `locateTranscript`
 * does for stats; a resume spawns an agent process, so one directory walk is
 * noise.
 */
export function probeSessionContinuity(
  backend: RealBackend,
  /** Ruling 127: whose home holds the transcript — the principal of the RESUMED
   *  turn, which is the task owner as of now, so this never reads one person's
   *  transcript on behalf of another (agents-and-runtime.md §3.6). An owner
   *  CHANGE is not decided here: `resumeRun` treats a principal that differs
   *  from the prior run's as `missing` before calling this, because a home with
   *  no transcript store yet answers `unknown` and `unknown` means "resume as
   *  before". */
  userId: string | null,
  sessionId: string | null | undefined,
  dataRoot?: string,
): SessionContinuity {
  if (!sessionId) return "unknown";
  // No principal, no home to look in — and no run to start either. `unknown`
  // keeps this probe out of the way of the refusal `startRun` records.
  if (!userId) return "unknown";
  if (backend === "codex") {
    if (codexSessionDirs(userId, dataRoot).length === 0) return "unknown";
    const rollout = locateCodex(userId, sessionId, dataRoot);
    if (!rollout) return "missing";
    // Ruling 434: found is not resumable. Asked here, before the spawn, so a
    // torn rollout starts a fresh session instead of a run that fails.
    return codexRolloutOpensWithMeta(rollout) ? "present" : "damaged";
  }
  const projectsDir = claudeProjectsDir(userId, dataRoot);
  // Ruling 507: an EMPTY store proves no more than an absent one. Viberr now
  // creates the shared `projects/` itself, before any CLI has run, so that
  // each account home's link to it resolves; its existence is no longer the
  // CLI's evidence of having written a transcript here.
  if (!projectsDir || !existsSync(projectsDir) || isEmptyDir(projectsDir)) return "unknown";
  return locateClaude(userId, sessionId, dataRoot) ? "present" : "missing";
}

function isEmptyDir(dir: string): boolean {
  try {
    return readdirSync(dir).length === 0;
  } catch {
    return false;
  }
}

/** The first line of a Codex rollout, as far as the probe needs it. */
const rolloutHeadSchema = z.object({ type: z.string() });

/** Longest first line the probe reads. The `session_meta` line carries the
 *  base instructions, tens of kilobytes; a line past this is not one. */
const ROLLOUT_HEAD_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Ruling 434: does this rollout open with its `session_meta` line, which the
 * CLI needs to resume it? Reads only as far as the first newline.
 *
 * An unreadable file answers true: the probe's job is to catch a file it can
 * see is torn, and a read error is not evidence of that, so the resume goes
 * ahead as before and the CLI says what it says.
 */
function codexRolloutOpensWithMeta(rollout: string): boolean {
  let fd: number | null = null;
  try {
    fd = openSync(rollout, "r");
    const chunk = Buffer.alloc(64 * 1024);
    const parts: Buffer[] = [];
    let total = 0;
    for (;;) {
      const n = readSync(fd, chunk, 0, chunk.length, total);
      if (n === 0) break;
      const newline = chunk.subarray(0, n).indexOf(0x0a);
      parts.push(Buffer.from(chunk.subarray(0, newline === -1 ? n : newline)));
      total += n;
      if (newline !== -1 || total >= ROLLOUT_HEAD_MAX_BYTES) break;
    }
    const head = rolloutHeadSchema.safeParse(JSON.parse(Buffer.concat(parts).toString("utf8")));
    return head.success && head.data.type === "session_meta";
  } catch (error) {
    // A torn head is often not JSON at all; any other failure is the read.
    return error instanceof SyntaxError ? false : true;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

// ------------------------------------------------- context size readers

/**
 * Ruling 372: ONE main-loop assistant line of a Claude transcript — the fields
 * the context-size reader needs. `isSidechain` marks a subagent's line, which
 * is not part of the session a resume replays.
 */
const claudeTranscriptUsageLineSchema = z.object({
  type: z.string().catch(""),
  isSidechain: z.boolean().catch(false),
  message: z
    .object({
      usage: z
        .object({
          input_tokens: z.number().catch(0),
          cache_creation_input_tokens: z.number().catch(0),
          cache_read_input_tokens: z.number().catch(0),
        })
        .nullable()
        .catch(null),
    })
    .nullable()
    .catch(null),
});

/** Ruling 369/372: one `token_count` line of a Codex rollout: the last call's
 *  usage (the prompt it carried, cached slice inside it) and when. */
const codexRolloutLineSchema = z.object({
  timestamp: z.string().catch(""),
  type: z.string().catch(""),
  payload: z
    .object({
      type: z.string().catch(""),
      item: z.object({ type: z.string().catch("") }).nullable().catch(null),
      info: z
        .object({
          last_token_usage: z
            .object({
              input_tokens: z.number().catch(0),
              cached_input_tokens: z.number().catch(0),
              cache_write_input_tokens: z.number().catch(0),
              total_tokens: z.number().catch(0),
            })
            .nullable()
            .catch(null),
        })
        .nullable()
        .catch(null),
    })
    .nullable()
    .catch(null),
});

function transcriptLines(filePath: string): unknown[] {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  const out: unknown[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // A torn last line (the CLI mid-write) is not a transcript fact.
    }
  }
  return out;
}

/**
 * Ruling 372: the size a resume of this session would REPLAY — the last
 * main-loop call's whole prompt as the provider's own transcript records it
 * (Claude: the last non-sidechain assistant line's usage, uncached + written +
 * read; Codex: the rollout's last `token_count`, whose `last_token_usage`
 * carries the last call's input with its cached slice inside). Null when the
 * transcript cannot be found or holds no usage yet, which the policy reads as
 * "size unknown, resume as before".
 *
 * Read from the transcript rather than a stored column so the policy answers
 * for a session whose runs predate the column, and so a session another run
 * extended is measured as it now is.
 */
export function sessionContextTokens(
  backend: RealBackend,
  userId: string | null,
  sessionId: string | null | undefined,
  dataRoot?: string,
): number | null {
  if (!sessionId || !userId) return null;
  const filePath =
    backend === "codex"
      ? locateCodex(userId, sessionId, dataRoot)
      : locateClaude(userId, sessionId, dataRoot);
  if (!filePath) return null;
  const lines = transcriptLines(filePath);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (backend === "codex") {
      const line = codexRolloutLineSchema.parse(lines[i]);
      const usage = line.payload?.type === "token_count" ? line.payload.info?.last_token_usage : null;
      if (usage && usage.input_tokens > 0) return usage.input_tokens;
      continue;
    }
    const line = claudeTranscriptUsageLineSchema.parse(lines[i]);
    if (line.type !== "assistant" || line.isSidechain) continue;
    const usage = line.message?.usage;
    if (!usage) continue;
    const total =
      usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens;
    if (total > 0) return total;
  }
  return null;
}

/**
 * One compaction as the rollout shows it: the last prompt the CLI sent before
 * it, and the size of the context it left.
 *
 * Ruling 403: `postTokens` is NULL when nothing measured it, never 0. A zero
 * seeded as "not measured yet" survived all the way to the timeline, where it
 * told a human that a 100k-213k token conversation had been summarized "to 0k
 * tokens". Null is the value the whole chain treats as unmeasured (the
 * completion line on the run's console renders it "a summary").
 *
 * Ruling 414 corrected why it was missing. The CLI writes one compaction as
 * `compacted`, then its own size line (a `token_count` whose prompt is 0 and
 * whose total is the compacted context), then a `ContextCompaction` item. The
 * size line used to CLOSE the compaction, so the item opened a second one with
 * no size, and that phantom was the event every note printed. The size was
 * measured the whole time.
 */
export interface CodexCompactionEvent {
  preTokens: number;
  postTokens: number | null;
}

/**
 * The compaction whose other spellings may still arrive. It stays open from
 * its first marker until the next REAL call (a `token_count` with a prompt): a
 * context can only need compacting again once a call has grown it, so a marker
 * before that call is the same compaction written another way.
 */
interface OpenCompaction {
  event: CodexCompactionEvent | null;
}

/** Ruling 369: what a Codex run's calls carried, read off its rollout. */
export interface CodexRolloutRunStats {
  /** The largest prompt any call in the window carried. */
  peakPromptTokens: number;
  /** The last call's prompt — the size a resume replays. */
  lastPromptTokens: number;
  /** Context compactions the CLI recorded in the window: the length of
   *  `compactionEvents`, so the run row and the audit count the same thing. */
  compactions: number;
  /** One entry per compaction in the window, in order: the last prompt the
   *  CLI sent before it and the context it left (its own size line, else the
   *  first call after it, else null). The sizes the audit row and the
   *  console's completion line carry. */
  compactionEvents: CodexCompactionEvent[];
  /** Calls seen in the window; 0 means the rollout said nothing about it. */
  calls: number;
  /** The FIRST call in the window — the run's real first request, which the
   *  SDK's turn total is not: a prompt of `promptTokens` of which `cacheRead`
   *  came back from the cache (Codex reports no write slice; the SDK's field
   *  is carried for the day it does). Null when the rollout has no call. */
  firstCall: { promptTokens: number; cacheRead: number; cacheWrite: number } | null;
}

/**
 * Ruling 369: the per-call prompt figures the Codex SDK does not stream (its
 * `turn.completed` is a turn TOTAL), read at finalize off the rollout the CLI
 * writes into the principal's home: every `token_count` line from `sinceIso`
 * on is one call, and a `context_compacted` event is one compaction. A thread
 * resumed across runs is windowed by the run's own start, so an earlier run's
 * calls are not this run's.
 */
export function codexRolloutRunStats(
  userId: string | null,
  sessionId: string | null | undefined,
  sinceIso: string | null,
  dataRoot?: string,
): CodexRolloutRunStats | null {
  if (!sessionId || !userId) return null;
  const filePath = locateCodex(userId, sessionId, dataRoot);
  if (!filePath) return null;
  const since = sinceIso ? Date.parse(sinceIso) : NaN;
  const stats: CodexRolloutRunStats = {
    peakPromptTokens: 0,
    lastPromptTokens: 0,
    compactions: 0,
    compactionEvents: [],
    calls: 0,
    firstCall: null,
  };
  // The CLI has spelled a compaction three ways across its versions: a
  // top-level `compacted` line carrying the replacement history (0.153, the
  // shape measured live on 2026-09-21), an `event_msg` whose item is a
  // `ContextCompaction` (written beside it), and an older `context_compacted`
  // event. One compaction appears under two of them, with its own size line
  // BETWEEN the two (ruling 414), so every marker until the next real call is
  // the same compaction.
  let lastPrompt = 0;
  // A holder, so the marking below is one statement the flow analysis follows.
  const open: OpenCompaction = { event: null };
  const markCompaction = () => {
    if (open.event) return; // the same compaction, spelled again
    open.event = { preTokens: lastPrompt, postTokens: null };
    stats.compactionEvents.push(open.event);
  };
  for (const raw of transcriptLines(filePath)) {
    const line = codexRolloutLineSchema.parse(raw);
    const at = Date.parse(line.timestamp);
    // A line with no readable instant is kept: better to count a call twice
    // across two runs than to lose the only figure a run has.
    if (Number.isFinite(since) && Number.isFinite(at) && at < since) continue;
    if (line.type === "compacted") {
      markCompaction();
      continue;
    }
    if (line.type !== "event_msg" || !line.payload) continue;
    if (
      line.payload.type === "context_compacted" ||
      (line.payload.type === "item_completed" && line.payload.item?.type === "ContextCompaction")
    ) {
      markCompaction();
      continue;
    }
    if (line.payload.type !== "token_count") continue;
    const usage = line.payload.info?.last_token_usage;
    const prompt = usage?.input_tokens ?? 0;
    if (prompt <= 0) {
      // The compaction request's own line: no prompt, but `total_tokens` is
      // the compacted context, the size a resume replays. It MEASURES the
      // open compaction and does not end it (ruling 414): the CLI writes the
      // compaction's second spelling after it.
      const compacted = usage?.total_tokens ?? 0;
      if (open.event && open.event.postTokens === null && compacted > 0) {
        open.event.postTokens = compacted;
        stats.lastPromptTokens = compacted;
      }
      continue;
    }
    if (open.event) {
      // A real call ends the compaction. Its prompt is the post size only
      // when the compaction's own size line never came: it already carries
      // the work done since.
      if (open.event.postTokens === null) open.event.postTokens = prompt;
      open.event = null;
    }
    lastPrompt = prompt;
    stats.calls += 1;
    if (stats.firstCall === null) {
      stats.firstCall = {
        promptTokens: prompt,
        cacheRead: usage?.cached_input_tokens ?? 0,
        cacheWrite: usage?.cache_write_input_tokens ?? 0,
      };
    }
    stats.lastPromptTokens = prompt;
    if (prompt > stats.peakPromptTokens) stats.peakPromptTokens = prompt;
  }
  stats.compactions = stats.compactionEvents.length;
  return stats;
}

// ------------------------------------------------------- live usage (541)

/**
 * Ruling 541: one `token_usage_record` line of a Codex rollout. The pinned CLI
 * (0.156.0) writes one the moment a model call completes, before the tool the
 * call asked for runs (the `token_count` event waits for the tool's output),
 * with that call's usage, the turn's running total and the thread's. Only the
 * turn total is read: a Viberr run is one turn, and the thread total also
 * counts every earlier run of a resumed thread.
 */
const codexUsageRecordSchema = z.object({
  type: z.literal("token_usage_record"),
  payload: z.object({
    turn_token_usage: z.object({
      input_tokens: z.number(),
      cached_input_tokens: z.number(),
      cache_write_input_tokens: z.number().catch(0),
      output_tokens: z.number(),
    }),
  }),
});

/** What a record's line holds, verbatim, for a scan that parses no other line. */
const USAGE_RECORD_MARK = '"token_usage_record"';

/** Ruling 541: what a live Codex run's rollout says the run has used so far. */
export interface CodexLiveUsage {
  /** The model calls the run has made, one record each: a Codex run's Turns. */
  calls: number;
  /** The run's turn total over those calls (the newest record's). */
  usage: z.infer<typeof codexUsageRecordSchema>["payload"]["turn_token_usage"];
}

/** Ruling 541: a live Codex run's rollout, read as the CLI writes it. */
export interface CodexUsageTail {
  /** The run's records so far, reading only what the CLI wrote since the last
   *  call; null before the first. `sessionId` is the thread the run streamed,
   *  once it has named it. */
  read(sessionId: string | null): CodexLiveUsage | null;
}

/**
 * Ruling 541: follow the rollout of the run about to start in `codexHome`.
 *
 * A new thread's rollout is found by its id once the stream has named it (the
 * CLI creates the file right after `thread.started`). A resumed thread's is
 * found now, before the CLI appends to it, and read from where it ends: what
 * it already holds belongs to the thread's earlier runs.
 */
export function codexUsageTail(codexHome: string, resumeSessionId: string | null): CodexUsageTail {
  const roots = [path.join(codexHome, "sessions")];
  let file: string | null = null;
  let offset = 0;
  let live: CodexLiveUsage | null = null;
  if (resumeSessionId) {
    file = rolloutByFilename(roots, resumeSessionId);
    try {
      if (file) offset = statSync(file).size;
    } catch {
      file = null;
    }
  }
  return {
    read(sessionId) {
      if (!file && !resumeSessionId && sessionId) file = rolloutByFilename(roots, sessionId);
      if (!file) return live;
      const chunk = bytesFrom(file, offset);
      // Only whole lines: the CLI may be mid-write on the last one, which is
      // read again, whole, next time.
      const end = chunk.lastIndexOf(0x0a);
      if (end === -1) return live;
      offset += end + 1;
      for (const line of chunk.toString("utf8", 0, end).split("\n")) {
        if (!line.includes(USAGE_RECORD_MARK)) continue;
        let json: unknown;
        try {
          json = JSON.parse(line);
        } catch {
          continue;
        }
        const record = codexUsageRecordSchema.safeParse(json);
        if (!record.success) continue;
        live = { calls: (live?.calls ?? 0) + 1, usage: record.data.payload.turn_token_usage };
      }
      return live;
    },
  };
}

/** The bytes `file` holds past `offset` (none when it cannot be read). */
function bytesFrom(file: string, offset: number): Buffer {
  let fd: number | null = null;
  try {
    fd = openSync(file, "r");
    const size = fstatSync(fd).size;
    const out = Buffer.alloc(Math.max(0, size - offset));
    let got = 0;
    while (got < out.length) {
      const n = readSync(fd, out, got, out.length - got, offset + got);
      if (n === 0) break;
      got += n;
    }
    return out.subarray(0, got);
  } catch {
    return Buffer.alloc(0);
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/**
 * Where a session's transcript is on disk, or null: {@link locateTranscript}
 * without the read it makes for the size. Ruling 525's purge of a deleted
 * controller conversation needs only the path.
 */
export function transcriptFile(
  backend: RealBackend,
  userId: string | null,
  sessionId: string,
  dataRoot?: string,
): string | null {
  if (!sessionId || !userId) return null;
  return backend === "codex"
    ? locateCodex(userId, sessionId, dataRoot)
    : locateClaude(userId, sessionId, dataRoot);
}

/**
 * Locate the resumable transcript for a session id + backend, or null when the
 * provider kept no on-disk session.
 */
export function locateTranscript(
  backend: RealBackend,
  /** Ruling 127: the run row's `credential_user_id`. A run with none never
   *  spawned a process, so it has no transcript to export. */
  userId: string | null,
  sessionId: string,
  dataRoot?: string,
): LocatedTranscript | null {
  const filePath = transcriptFile(backend, userId, sessionId, dataRoot);
  if (!filePath) return null;
  const { lineCount, bytes } = fileStats(filePath);
  return {
    backend,
    sessionId,
    filePath,
    cwd: transcriptCwd(filePath),
    lineCount,
    bytes,
  };
}

// ------------------------------------------------------------- resume bundle

/**
 * A self-contained bash installer that carries the session transcript and,
 * when run on the user's machine, drops it where the local CLI looks for it and
 * prints the exact resume command. It handles the two providers' different
 * resume models (verified via docs + source in the portability research):
 *
 *   • Codex — resume-by-id is NOT cwd-scoped: the rollout goes anywhere under
 *     `$CODEX_HOME/sessions` and `codex resume <id>` finds it by a filesystem
 *     scan. So we keep the original `rollout-…jsonl` filename and drop it in an
 *     `imported/` subdir.
 *   • Claude — `claude --resume <id>` is scoped to the ENCODED name of the
 *     current directory (`<abs cwd>` with every non-alphanumeric char → `-`).
 *     So the script encodes whatever dir you point it at (default: `$PWD`, i.e.
 *     cd into your local checkout first), places `<id>.jsonl` under
 *     `$CLAUDE_CONFIG_DIR/projects/<encoded>/`, and prints `cd … && claude
 *     --resume <id>`.
 *
 * The script writes ONE file and never carries credentials — the user signs in
 * locally with their own (same) subscription. base64-embedded so it is a single
 * downloadable artifact.
 */
export interface ResumeBundle {
  filename: string;
  body: string;
}

export function buildResumeScript(
  located: LocatedTranscript,
  opts: { taskKey: string; taskTitle?: string },
): ResumeBundle {
  // The transcript is the VENDOR's own file, so nothing has scrubbed it: the
  // run sink's P13-U-1 redaction covers Viberr's `.jsonl` and the console, and
  // this is the sibling channel that bypassed it. One `env`-printing tool call
  // puts the run's credential into the provider transcript verbatim — and
  // since ruling 127 that is somebody's PERSONAL key, while this bundle is
  // downloadable by any member of the run's project. Scrub before embedding,
  // with the same redactor and the same token patterns ("secrets wherever they
  // came from"). The marker carries no quote or backslash, so the JSONL stays
  // parseable and `claude --resume` still reads it.
  const redact = createLineRedactor();
  const b64 = Buffer.from(redact(readFileSync(located.filePath, "utf8")), "utf8")
    .toString("base64")
    .replace(/(.{76})/g, "$1\n");
  const origName = path.basename(located.filePath);
  const shortSid = located.sessionId.slice(0, 8);
  const filename = `resume-${opts.taskKey}-${shortSid}.sh`;

  const body = RESUME_SCRIPT_TEMPLATE.replace(/__SID__/g, located.sessionId)
    .replace(/__BACKEND__/g, located.backend)
    .replace(/__ORIG__/g, origName)
    .replace(/__TASK__/g, opts.taskKey)
    .replace(/__ORIGIN_CWD__/g, located.cwd ?? "(unknown)")
    .replace("__B64__", () => b64);

  return { filename, body };
}

const RESUME_SCRIPT_TEMPLATE = [
  "#!/usr/bin/env bash",
  "# Viberr: resume this agent session on your OWN machine (same subscription).",
  "#",
  "#   session : __SID__",
  "#   backend : __BACKEND__",
  "#   task    : __TASK__",
  "#   origin  : __ORIGIN_CWD__   (the working dir the agent used inside Viberr)",
  "#",
  "# Installs the conversation transcript where the local CLI looks for it, then",
  "# prints the exact resume command. Writes ONE file; carries NO credentials.",
  "# Sign in locally with your own subscription first:",
  "#   Claude : run `claude` once and sign in with your own account (Pro/Max or Console)",
  "#   Codex  : run `codex login` (a ChatGPT plan that includes Codex)",
  "set -euo pipefail",
  "",
  'SID="__SID__"',
  'BACKEND="__BACKEND__"',
  'ORIG_NAME="__ORIG__"',
  "",
  "b64decode() { base64 --decode 2>/dev/null || base64 -D 2>/dev/null || openssl base64 -d; }",
  "",
  "# Decode the embedded transcript once into a temp file.",
  'TMP="$(mktemp)"',
  "trap 'rm -f \"$TMP\"' EXIT",
  "b64decode > \"$TMP\" <<'VIBERR_TRANSCRIPT_B64'",
  "__B64__",
  "VIBERR_TRANSCRIPT_B64",
  "",
  'if [ "$BACKEND" = "codex" ]; then',
  '  DEST_DIR="${CODEX_HOME:-$HOME/.codex}/sessions/imported"',
  '  mkdir -p "$DEST_DIR"',
  '  DEST="$DEST_DIR/$ORIG_NAME"',
  '  cp "$TMP" "$DEST"',
  '  echo ""',
  '  echo "Installed -> $DEST"',
  '  echo "Resume from ANY directory (ideally your local checkout of the repo):"',
  '  echo ""',
  '  echo "    codex resume $SID"',
  '  echo ""',
  "else",
  "  # Claude locates a session by the ENCODED name of your CURRENT directory, so",
  "  # this maps the conversation onto whatever project dir you point it at",
  "  # (default: the dir you run this from; cd into your local checkout first).",
  '  TARGET_DIR="${1:-$PWD}"',
  "  # Physical path (pwd -P): Claude resolves symlinks (e.g. macOS /var ->",
  "  # /private/var, /tmp -> /private/tmp), so the encoded folder must match the",
  "  # REAL path or --resume reports 'No conversation found'. Verified on 2.1.201.",
  '  ABS="$(cd "$TARGET_DIR" 2>/dev/null && pwd -P || true)"',
  '  if [ -z "$ABS" ]; then echo "Directory not found: $TARGET_DIR" >&2; exit 1; fi',
  "  ENCODED=\"$(printf '%s' \"$ABS\" | sed 's/[^A-Za-z0-9]/-/g')\"",
  '  DEST_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects/$ENCODED"',
  '  mkdir -p "$DEST_DIR"',
  '  DEST="$DEST_DIR/$SID.jsonl"',
  '  cp "$TMP" "$DEST"',
  '  echo ""',
  '  echo "Installed -> $DEST"',
  '  echo "Mapped onto project dir: $ABS"',
  '  echo "Resume with:"',
  '  echo ""',
  '  echo "    cd \\"$ABS\\" && claude --resume $SID"',
  '  echo ""',
  '  echo "(Use the exact --resume <id>; imported sessions may not appear in the picker.)"',
  "fi",
  "",
].join("\n");
