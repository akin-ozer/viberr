import { existsSync } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import type { FileActorRef } from "~/schemas/task-file.schema";
import { taskDir } from "~/server/files/file-store-root.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import { listRunLines, listRunsForTaskRows, type AgentRunRow } from "~/server/runtimes/run-store.server";
import { buildScript, type SimulatedScript } from "~/server/runtimes/simulated-runtime.server";
import type { LogLine } from "~/features/runtime/runtime-types";
import type { RealBackend } from "~/server/runtimes/runtime-registry.server";
import {
  listDeployedSpecialists,
  type DeployedSpecialistView,
} from "./specialist-run.server";
import type { TaskMutationContext } from "./task-actions.server";

/**
 * Agent-mention resolution + reply-text extraction for the
 * "comment → resume that agent's session → reply as a comment" flow.
 *
 * A comment can @mention a specific agent on the task by:
 *   - name / profile id : `@dev`     (a deployed specialist's `name`/`id`,
 *                                      case-insensitive)
 *   - backend           : `@claude` / `@codex`
 *   - role / generic    : `@operator`, `@agent` (→ the primary specialist)
 *
 * The resolver returns the target agent's identity plus its most-recent run
 * row that HAS a `session_id` on this task (its resumable "session"), or
 * `session: null` when the agent exists but has never run here yet. It
 * returns `null` when the text mentions no agent at all.
 */

// ------------------------------------------------------------ mention parse

/** All @handles in a comment, lowercased, de-duplicated, order-preserving. */
const MENTION_RE = /@([A-Za-z][\w-]*)/g;

function mentionHandles(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of text.matchAll(MENTION_RE)) {
    const handle = match[1]!.toLowerCase();
    if (!seen.has(handle)) {
      seen.add(handle);
      out.push(handle);
    }
  }
  return out;
}

// ------------------------------------------------------- resolved shape

/** A resolved agent target for a comment (identity + resumable session). */
export interface MentionedAgent {
  /** The deployed specialist this handle resolved to. */
  profileId: string;
  name: string;
  role: string;
  backend: RealBackend;
  model: string;
  /** The agent's file actor ref (author of the reply comment). */
  actorRef: FileActorRef;
  /** The most-recent run row on this task that has a session_id, or null when
   *  the agent has never run here (→ the caller starts a FRESH run). */
  session: AgentRunRow | null;
}

/** The agent's file actor ref — an `agent:<backend>/<role>` ref. */
function agentActorRef(backend: RealBackend, role: string): FileActorRef {
  return { kind: "agent", backend, role };
}

/**
 * Does a set of @handles target this deployed specialist? Matches on the
 * specialist's name, profile id, or backend — all case-insensitive. `@agent`
 * matches the PRIMARY specialist only (resolved by the caller); it is not
 * matched here so a two-specialist task does not ambiguously match both.
 */
function handleMatchesSpecialist(
  handles: Set<string>,
  sp: DeployedSpecialistView,
): boolean {
  return (
    handles.has(sp.name.toLowerCase()) ||
    handles.has(sp.id.toLowerCase()) ||
    handles.has(sp.backend)
  );
}

/**
 * The most-recent run row (created_at DESC) on this task, matching `backend`,
 * that carries a session_id — the resumable provider session for this agent.
 * When `backend` is null, any specialist/consultant run with a session wins.
 */
function latestSessionRun(
  db: Database.Database,
  projectSlug: string,
  taskKey: string,
  backend: RealBackend | null,
): AgentRunRow | null {
  const rows = listRunsForTaskRows(db, projectSlug, taskKey);
  // listRunsForTaskRows returns created_at ASC — walk newest-first.
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!;
    if (row.kind === "operator") continue;
    if (!row.session_id) continue;
    const rowBackend: RealBackend = row.backend === "codex" ? "codex" : "claude";
    if (backend && rowBackend !== backend) continue;
    return row;
  }
  return null;
}

/**
 * Resolve the agent an @mention targets on a task. Returns null when no agent
 * handle is present. When an agent IS mentioned but has no prior session on
 * the task, returns the identity with `session: null` (fresh-run fallback).
 *
 * Resolution precedence (first hit wins):
 *   1. `@agent` / `@operator` → the task's PRIMARY specialist (frontmatter).
 *   2. a deployed specialist by name / profile id / backend.
 */
export function resolveMentionedAgent(
  db: Database.Database,
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
  text: string,
): MentionedAgent | null {
  const handles = mentionHandles(text);
  if (handles.length === 0) return null;
  const handleSet = new Set(handles);

  const specialists = listDeployedSpecialists(db, projectSlug, ctx);

  const existing = readTaskFile({
    projectSlug,
    taskKey,
    ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
  });
  const primaryRef = existing?.parsed.frontmatter.specialist ?? null;

  // 1. Generic `@agent` / `@operator` → the primary specialist on the task.
  if (
    (handleSet.has("agent") || handleSet.has("operator")) &&
    primaryRef
  ) {
    const sp =
      specialists.find((s) => s.id === primaryRef.profileId) ?? null;
    const backend: RealBackend =
      primaryRef.backend === "codex" ? "codex" : "claude";
    const role = sp?.role ?? primaryRef.role;
    return {
      profileId: primaryRef.profileId,
      name: sp?.name ?? primaryRef.profileId,
      role,
      backend,
      model: sp?.model ?? (backend === "codex" ? "gpt-5-codex" : "claude-sonnet-4-5"),
      actorRef: agentActorRef(backend, role),
      session: latestSessionRun(db, projectSlug, taskKey, backend),
    };
  }

  // 2. A deployed specialist by name / id / backend.
  const matched = specialists.find((s) => handleMatchesSpecialist(handleSet, s));
  if (matched) {
    return {
      profileId: matched.id,
      name: matched.name,
      role: matched.role,
      backend: matched.backend,
      model: matched.model,
      actorRef: agentActorRef(matched.backend, matched.role),
      session: latestSessionRun(db, projectSlug, taskKey, matched.backend),
    };
  }

  // A backend handle (`@claude`/`@codex`) with no deployed specialist of that
  // backend still targets "the agent" if the primary matches that backend.
  if (primaryRef) {
    const backend: RealBackend =
      primaryRef.backend === "codex" ? "codex" : "claude";
    if (handleSet.has(backend)) {
      return {
        profileId: primaryRef.profileId,
        name: primaryRef.profileId,
        role: primaryRef.role,
        backend,
        model: backend === "codex" ? "gpt-5-codex" : "claude-sonnet-4-5",
        actorRef: agentActorRef(backend, primaryRef.role),
        session: latestSessionRun(db, projectSlug, taskKey, backend),
      };
    }
  }

  return null;
}

// ---------------------------------------------------- reply-text extraction

/** Timeline-comment length cap — the full transcript stays in the agent logs. */
const MAX_REPLY_CHARS = 1200;

/**
 * Extract a reply from a finished run's persisted lines: prefer the LAST
 * substantial `assistant`/`agent_message` text line, else fall back to the
 * final `result`/`turn.completed` text. Whitespace-normalized + truncated to
 * a readable length (the raw transcript remains in the run's agent logs).
 * Returns null when nothing usable was produced.
 */
export function extractReplyText(lines: LogLine[]): string | null {
  const isReplyText = (l: LogLine) =>
    l.ev === "text" &&
    (l.tag === "assistant" || l.tag === "agent_message") &&
    l.text.trim().length > 0;

  // Walk newest-first for the last substantial assistant line.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (isReplyText(line)) return truncate(line.text.trim());
  }
  // Fallback: the final result envelope's text.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (line.ev === "result" && line.text.trim().length > 0) {
      return truncate(line.text.trim());
    }
  }
  return null;
}

function truncate(text: string): string {
  if (text.length <= MAX_REPLY_CHARS) return text;
  return text.slice(0, MAX_REPLY_CHARS - 1).trimEnd() + "…";
}

/** Read a run's persisted display lines (helper for the completion callback). */
export function replyTextForRun(
  db: Database.Database,
  runId: string,
): string | null {
  const lines = listRunLines(db, runId).map((l) => l.display);
  return extractReplyText(lines);
}

// -------------------------------------------------------- resume workdir

// ---------------------------------------------------- simulated reply stream

/**
 * A short simulated reply stream for a resumed session so the run produces a
 * final `assistant`/`agent_message` line (→ an agent reply comment) even with
 * NO real backend. When a real backend IS available the adapter ignores the
 * script and the real transcript carries the reply instead. `instant` so the
 * reply lands promptly (and the test is deterministic).
 */
export function buildReplyScript(
  backend: RealBackend,
  model: string,
): SimulatedScript {
  const now = new Date().toISOString();
  const replyText =
    "Thanks for the comment — I re-read the task and my working tree. " +
    "I've addressed the point you raised and pushed the adjustment; the " +
    "analysis still holds. Let me know if you'd like a deeper pass on any part.";
  const lines: LogLine[] =
    backend === "codex"
      ? [
          { t: "", ev: "init", tag: "thread.started", text: "codex thread · resumed for a follow-up comment" },
          { t: "", ev: "text", tag: "agent_message", text: replyText },
          { t: "", ev: "result", tag: "turn.completed", text: "reply complete", usage: { input_tokens: 900, cached_input_tokens: 400, output_tokens: 120 } },
        ]
      : [
          { t: "", ev: "init", tag: "system·init", text: "resumed session · follow-up comment" },
          { t: "", ev: "text", tag: "assistant", text: replyText },
          { t: "", ev: "result", tag: "result", text: "reply complete", stats: { subtype: "success", dur: 2400, api: 2100, turns: 1, cost: 0.01, in: 900, cached: 400, out: 120 } },
        ];
  return buildScript({
    lines,
    occurredAt: lines.map(() => now),
    sessionId: "reply",
    backend,
    model,
    op: false,
    keepRunning: false,
    instant: true,
  });
}

/**
 * The working directory a resumed reply run should use: the specialist-run
 * clone at `<taskDir>/workspace/<repo-name>` when it still exists (so the
 * agent keeps its repo context), else the bare task dir. `repo` is the
 * task/project repo `<owner>/<name>` (null → no clone was ever made).
 */
export function resumeWorkdir(
  projectSlug: string,
  taskKey: string,
  repo: string | null,
  dataRoot?: string,
): string {
  const base = taskDir(projectSlug, taskKey, dataRoot);
  if (repo) {
    const name = repo.split("/").pop() ?? repo;
    const clone = path.join(base, "workspace", name);
    if (existsSync(path.join(clone, ".git"))) return clone;
  }
  return base;
}
