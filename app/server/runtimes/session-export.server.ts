import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getEnv } from "../config/env.server";
import type { RealBackend } from "./runtime-registry.server";

/**
 * Locate the on-disk provider session transcript for a run so it can be
 * EXPORTED and resumed on another machine (same subscription). The agents run
 * inside the app's runtime (in Docker, on the data volume); each provider keeps
 * its own resumable transcript there, keyed by the session id the UI shows:
 *
 *   Claude Code : $CLAUDE_CONFIG_DIR/projects/<cwd-slashes-as-dashes>/<sid>.jsonl
 *   Codex       : $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<sid>.jsonl
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

/** Resolve Claude's config dir the same way the runtime registry does. */
function claudeConfigDir(): string {
  const env = getEnv();
  return env.CLAUDE_CONFIG_DIR ?? path.resolve(env.VIBERR_DATA_ROOT, "runtimes", "claude-home");
}

/** Resolve Codex's home dir: explicit CODEX_HOME, else the conventional ~/.codex. */
function codexHome(): string {
  const env = getEnv();
  return env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
}

/** Read the cwd baked into a Claude/Codex transcript's first line that carries one. */
function transcriptCwd(filePath: string): string | null {
  try {
    const text = readFileSync(filePath, "utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line) as { cwd?: string; payload?: { cwd?: string } };
        if (typeof obj.cwd === "string") return obj.cwd;
        if (obj.payload && typeof obj.payload.cwd === "string") return obj.payload.cwd;
      } catch {
        // skip non-JSON lines
      }
    }
  } catch {
    // unreadable → no cwd
  }
  return null;
}

function fileStats(filePath: string): { lineCount: number; bytes: number } {
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
  const projectsDir = path.join(claudeConfigDir(), "projects");
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
 *  recursively walking the dated dirs under `$CODEX_HOME/sessions`. Falls back
 *  to matching the id inside the file's first meta line. */
function locateCodex(sessionId: string): string | null {
  const sessionsDir = path.join(codexHome(), "sessions");
  if (!existsSync(sessionsDir)) return null;
  const stack: string[] = [sessionsDir];
  let byContent: string | null = null;
  while (stack.length) {
    const dir = stack.pop()!;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const full = path.join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!name.endsWith(".jsonl")) continue;
      if (name.includes(sessionId)) return full; // filename embeds the id
      if (!byContent) {
        // Cheap fallback: the id appears in the session-meta (first line).
        try {
          const head = readFileSync(full, "utf8").split("\n", 1)[0] ?? "";
          if (head.includes(sessionId)) byContent = full;
        } catch {
          // ignore
        }
      }
    }
  }
  return byContent;
}

/**
 * Locate the resumable transcript for a session id + backend, or null when the
 * provider kept no on-disk session (e.g. a simulated run, or Codex not logged
 * in so no rollout was written).
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
