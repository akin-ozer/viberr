import {
  readdirSync,
  rmdirSync,
  rmSync,
  statSync,
  type Dirent,
} from "node:fs";
import path from "node:path";
import type { RunBackend } from "~/features/runtime/runtime-types";
import { getDataRoot } from "~/server/files/file-store-root.server";
import { logger } from "~/server/logging/logger.server";

/**
 * On-disk transcript retention (gap 20).
 *
 * `applyRetention` bounds three SQLite tables and explicitly never touches the
 * file store; `reclaimTerminalTaskWorkspaces` bounds task clones. Between them
 * they left the whole `runtimes/` tree unbounded:
 *
 *  - `runtimes/<backend>/<runId>.jsonl` — one raw envelope file per run, always
 *    (`run-store.server.ts` `rawLogPath`), appended for the life of the run and
 *    deleted by nothing except the destructive `npm run seed -- --reset`.
 *  - `runtimes/claude-home/projects/<cwd-as-dashes>/<sid>.jsonl` and
 *    `runtimes/codex-home/sessions/YYYY/MM/DD/rollout-<ts>-<sid>.jsonl` — the
 *    provider session homes, one rollout per run, forever.
 *
 * The asymmetry this fixes is the dishonest part: `run_log_lines` is deleted at
 * 30 days, so the run console goes empty while the raw file it projected lives
 * on with no reader — and a deleted project leaves its transcripts orphaned on
 * disk with not even a DB row that names them. Aligning the file window with
 * `RUN_LOG_RETENTION_DAYS` makes "run logs are kept 30 days" one true statement
 * instead of two contradictory ones.
 *
 * ## Rules
 *
 * - **Only under the data root.** A deployment may point `CLAUDE_CONFIG_DIR` at
 *   the operator's `~/.claude`, or `CODEX_HOME` at a personal `~/.codex`
 *   (`codexSessionRoots` even searches it). Sweeping someone's own dir would be
 *   indefensible, so this walks the data-root layout and nothing else; a
 *   redirected home simply has no files here and is never touched.
 * - **Only `*.jsonl` files.** `codex-home/auth.json` is a live credential and
 *   `claude-home` holds config; deleting those logs the whole instance out
 *   (P11-04). Extension-gated, never directory-level `rm -rf`.
 * - **mtime, not DB state.** An active run appends to its file continuously, so
 *   a file past the window cannot belong to a live run — and age-based pruning
 *   also collects the orphans a deleted project left behind, which a
 *   DB-driven sweep could never find.
 * - Best-effort and self-catching, like every other retention pass here: one
 *   unreadable path never aborts the sweep.
 *
 * ## The session-home tradeoff, stated plainly
 *
 * Deleting a session `.jsonl` ends resume/export for THAT conversation. The
 * window is set at 30 days because the provider already enforces roughly that
 * (`agent-reply.server.ts` documents Claude Code's ~30-day retention as a cause
 * of dead session ids, P13-D-2), so a 30-day-old id is mostly dead already.
 * Set `VIBERR_SESSION_HOME_RETENTION_DAYS=0` to keep session homes forever.
 */

/** Raw run transcripts: aligned with RUN_LOG_RETENTION_DAYS so the file and its
 *  projection disappear together instead of contradicting each other. */
export const DEFAULT_TRANSCRIPT_RETENTION_DAYS = 30;
/** Provider session homes: the window the providers themselves keep. */
export const DEFAULT_SESSION_HOME_RETENTION_DAYS = 30;

const BACKENDS: RunBackend[] = ["claude", "codex"];

export interface TranscriptReclamation {
  /** `runtimes/<backend>/<runId>.jsonl` files removed. */
  transcripts: number;
  /** Provider session/rollout `.jsonl` files removed from the app-owned homes. */
  sessions: number;
  /** Bytes freed (best-effort — a file that vanishes mid-sweep is skipped). */
  bytes: number;
}

function envDays(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const days = Number(raw);
  return Number.isFinite(days) && days >= 0 ? days : fallback;
}

export function transcriptRetentionDays(): number {
  return envDays(
    "VIBERR_TRANSCRIPT_RETENTION_DAYS",
    DEFAULT_TRANSCRIPT_RETENTION_DAYS,
  );
}

export function sessionHomeRetentionDays(): number {
  return envDays(
    "VIBERR_SESSION_HOME_RETENTION_DAYS",
    DEFAULT_SESSION_HOME_RETENTION_DAYS,
  );
}

function entries(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** What one `pruneFile` attempt did — `bytes` is 0 unless the file was removed. */
interface PrunedFile {
  removed: boolean;
  bytes: number;
}

/** Delete `file` when its mtime is older than `cutoffMs`. A removed EMPTY file
 *  still counts as removed, so the count never disagrees with the disk. */
function pruneFile(file: string, cutoffMs: number): PrunedFile {
  let size = 0;
  try {
    const stats = statSync(file);
    if (stats.mtimeMs >= cutoffMs) return { removed: false, bytes: 0 };
    size = stats.size;
  } catch {
    return { removed: false, bytes: 0 };
  }
  try {
    rmSync(file, { force: true });
    return { removed: true, bytes: size };
  } catch (error) {
    logger.warn("could not prune a runtime transcript", {
      file,
      err: error instanceof Error ? error : new Error(String(error)),
    });
    return { removed: false, bytes: 0 };
  }
}

/** Every `*.jsonl` beneath `dir` (bounded walk, files only). */
function jsonlFiles(dir: string, depth = 6): string[] {
  const found: string[] = [];
  for (const entry of entries(dir)) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth > 0) found.push(...jsonlFiles(abs, depth - 1));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      found.push(abs);
    }
  }
  return found;
}

/** Remove now-empty date directories under a session tree (best-effort). */
function pruneEmptyDirs(dir: string, depth = 6): void {
  for (const entry of entries(dir)) {
    if (!entry.isDirectory()) continue;
    const abs = path.join(dir, entry.name);
    if (depth > 0) pruneEmptyDirs(abs, depth - 1);
    if (entries(abs).length === 0) {
      try {
        rmdirSync(abs);
      } catch {
        // Raced, or not empty after all — never worth failing a sweep over.
      }
    }
  }
}

export interface TranscriptRetentionOptions {
  dataRoot?: string;
  now?: Date;
  /** Override the run-transcript window (days). 0 disables that half. */
  transcriptDays?: number;
  /** Override the session-home window (days). 0 disables that half. */
  sessionDays?: number;
}

/**
 * Prune aged raw run transcripts and app-owned provider session files.
 * Idempotent; safe to run while the app serves traffic (see the mtime rule).
 */
export function pruneRuntimeTranscripts(
  options: TranscriptRetentionOptions = {},
): TranscriptReclamation {
  const root = getDataRoot(options.dataRoot);
  const now = (options.now ?? new Date()).getTime();
  const transcriptDays = options.transcriptDays ?? transcriptRetentionDays();
  const sessionDays = options.sessionDays ?? sessionHomeRetentionDays();

  let transcripts = 0;
  let sessions = 0;
  let bytes = 0;

  if (transcriptDays > 0) {
    const cutoff = now - transcriptDays * 86_400_000;
    for (const backend of BACKENDS) {
      const dir = path.join(root, "runtimes", backend);
      for (const entry of entries(dir)) {
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
        const pruned = pruneFile(path.join(dir, entry.name), cutoff);
        if (!pruned.removed) continue;
        transcripts += 1;
        bytes += pruned.bytes;
      }
    }
  }

  if (sessionDays > 0) {
    const cutoff = now - sessionDays * 86_400_000;
    // App-owned homes only — a home pointed outside the data root is somebody
    // else's directory and is deliberately never swept.
    const sessionRoots = [
      path.join(root, "runtimes", "claude-home", "projects"),
      path.join(root, "runtimes", "codex-home", "sessions"),
    ];
    for (const sessionRoot of sessionRoots) {
      for (const file of jsonlFiles(sessionRoot)) {
        const pruned = pruneFile(file, cutoff);
        if (!pruned.removed) continue;
        sessions += 1;
        bytes += pruned.bytes;
      }
      pruneEmptyDirs(sessionRoot);
    }
  }

  return { transcripts, sessions, bytes };
}
