import { existsSync, readdirSync, readFileSync, type Dirent } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { resolveClaudeConfigDir } from "./claude-config.server";
import { codexSessionRoots } from "./codex-config.server";
import type { RealBackend } from "./runtime-registry.server";

/**
 * Locate the on-disk provider session transcript for a run so it can be
 * EXPORTED and resumed on another machine (same subscription). The agents run
 * inside the app's runtime (in Docker, on the data volume); each provider keeps
 * its own resumable transcript there, keyed by the session id the UI shows:
 *
 *   Claude Code : $CLAUDE_CONFIG_DIR/projects/<cwd-slashes-as-dashes>/<sid>.jsonl
 *   Codex       : <codex run home>/sessions/YYYY/MM/DD/rollout-<ts>-<sid>.jsonl
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

/** Every `…/sessions` dir a codex rollout may live in. Runs write into the
 *  app-owned run home (P13-LV-13); the human's login dir is still searched so a
 *  transcript recorded before that split stays exportable. */
function codexSessionDirs(): string[] {
  return codexSessionRoots()
    .map((root) => path.join(root, "sessions"))
    .filter((dir) => existsSync(dir));
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

/** Claude: `<sid>.jsonl` inside any per-project dir under
 *  `$CLAUDE_CONFIG_DIR/projects/` (search every project dir by session id). */
function locateClaude(sessionId: string): string | null {
  const projectsDir = path.join(resolveClaudeConfigDir(), "projects");
  if (!existsSync(projectsDir)) return null;
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
function codexTranscriptByFilename(sessionId: string): string | null {
  const stack: string[] = codexSessionDirs();
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
      if (entry.name.endsWith(".jsonl") && entry.name.includes(sessionId)) {
        return full; // filename embeds the id
      }
    }
  }
  return null;
}

/** Content fallback: the id appears in the session-meta (first line). Reads
 *  every candidate file — export-route only, never on a loader path. */
function codexTranscriptByContent(sessionId: string): string | null {
  const stack: string[] = codexSessionDirs();
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

function locateCodex(sessionId: string): string | null {
  return codexTranscriptByFilename(sessionId) ?? codexTranscriptByContent(sessionId);
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

export function transcriptExists(backend: RealBackend, sessionId: string): boolean {
  if (!sessionId) return false;
  const key = `${backend}:${sessionId}`;
  const cached = transcriptExistsCache.get(key);
  const now = Date.now();
  if (cached && now - cached.at < TRANSCRIPT_EXISTS_TTL_MS) return cached.ok;
  const ok =
    backend === "codex"
      ? codexTranscriptByFilename(sessionId) !== null
      : locateClaude(sessionId) !== null;
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
 */
export type SessionContinuity = "present" | "missing" | "unknown";

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
  sessionId: string | null | undefined,
): SessionContinuity {
  if (!sessionId) return "unknown";
  if (backend === "codex") {
    if (codexSessionDirs().length === 0) return "unknown";
    return locateCodex(sessionId) ? "present" : "missing";
  }
  const projectsDir = path.join(resolveClaudeConfigDir(), "projects");
  if (!existsSync(projectsDir)) return "unknown";
  return locateClaude(sessionId) ? "present" : "missing";
}

/**
 * Locate the resumable transcript for a session id + backend, or null when the
 * provider kept no on-disk session.
 */
export function locateTranscript(
  backend: RealBackend,
  sessionId: string,
): LocatedTranscript | null {
  if (!sessionId) return null;
  const filePath = backend === "codex" ? locateCodex(sessionId) : locateClaude(sessionId);
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
  const b64 = readFileSync(located.filePath)
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
  "# Viberr — resume this agent session on your OWN machine (same subscription).",
  "#",
  "#   session : __SID__",
  "#   backend : __BACKEND__",
  "#   task    : __TASK__",
  "#   origin  : __ORIGIN_CWD__   (the working dir the agent used inside Viberr)",
  "#",
  "# Installs the conversation transcript where the local CLI looks for it, then",
  "# prints the exact resume command. Writes ONE file; carries NO credentials —",
  "# sign in locally with your own subscription first:",
  "#   Claude : run `claude` once and sign in (Pro/Max), or `claude setup-token`",
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
  "  # (default: the dir you run this from — cd into your local checkout first).",
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
