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
import { defaultModelFor } from "~/server/runtimes/model-catalog.server";
import {
  listDeployedSpecialists,
  type DeployedSpecialistView,
} from "./specialist-run.server";
import { resolveOperatorAuthority } from "./operator-actions.server";
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
  /** The agent's current reasoning effort (empty when unset). */
  effort: string;
  /** The agent's file actor ref (author of the reply comment). */
  actorRef: FileActorRef;
  /** True when this agent is the task's PRIMARY specialist (drives whether a
   *  fresh run engages it as primary vs. reviewer, and how its session matches). */
  isPrimary: boolean;
  /** True when the mention targets the OPERATOR (not a specialist). The caller
   *  routes this to a governed operator run, not a specialist/reviewer run. */
  isOperator: boolean;
  /** The most-recent run row on this task that is THIS agent's OWN resumable
   *  session, or null when the agent has never run here as itself (→ the caller
   *  starts a FRESH run). Matched by agent identity, never merely by backend. */
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
 * The most-recent run row (created_at DESC) that is THIS agent's OWN resumable
 * session — matched by AGENT IDENTITY, never merely by backend. Matching by
 * backend alone let `@reviewer` resume the dev's most-recent claude session
 * (the dev then answered "as the dev"); this keeps each agent on its own thread.
 *
 * Pass 1 — the agent's own runs: `agent_profile_id === profileId` AND the run
 * kind matches how the agent is engaged (`primary` vs `reviewer`), so a run
 * stamped with an identity but the wrong kind (a legacy cross-agent resume) is
 * NOT reused. Pass 2 — a legacy fallback for the PRIMARY only: a pre-identity
 * (`agent_profile_id IS NULL`) primary run of the same backend, so primaries
 * that ran before the identity columns still resume.
 */
function latestSessionRun(
  db: Database.Database,
  projectSlug: string,
  taskKey: string,
  target: { profileId: string; backend: RealBackend; isPrimary: boolean },
): AgentRunRow | null {
  const rows = listRunsForTaskRows(db, projectSlug, taskKey);
  const wantKind = target.isPrimary ? "primary" : "reviewer";
  // Pass 1 — the agent's own session (identity + engagement kind).
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!;
    if (!row.session_id) continue;
    if (row.agent_profile_id === target.profileId && row.kind === wantKind) {
      return row;
    }
  }
  // Pass 2 — legacy null-identity primary session (pre-0010), same backend.
  if (target.isPrimary) {
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i]!;
      if (row.kind !== "primary") continue;
      if (!row.session_id) continue;
      if (row.agent_profile_id != null) continue;
      const rowBackend: RealBackend = row.backend === "codex" ? "codex" : "claude";
      if (rowBackend === target.backend) return row;
    }
  }
  return null;
}

/**
 * Resolve the agent an @mention targets on a task. Returns null when no agent
 * handle is present. When an agent IS mentioned but has no prior session on
 * the task, returns the identity with `session: null` (fresh-run fallback).
 *
 * Resolution precedence (first hit wins):
 *   1. `@operator` → the OPERATOR (a governed operator run, not a specialist).
 *   2. `@agent`    → the task's PRIMARY specialist (frontmatter).
 *   3. a deployed specialist by name / profile id / backend.
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

  // 1. `@operator` → the OPERATOR itself (never the primary specialist). Only
  //    resolves when an operator is actually deployed on the project; the caller
  //    routes this target to a governed operator run.
  if (handleSet.has("operator")) {
    const authority = resolveOperatorAuthority(ctx, projectSlug);
    if (authority.deployed) {
      return {
        profileId: "operator",
        name: authority.name,
        role: "coordinator",
        backend: authority.backend,
        model: authority.model,
        effort: authority.effort,
        actorRef: { kind: "operator" },
        isPrimary: false,
        isOperator: true,
        session: null,
      };
    }
    // No operator deployed — fall through (a bare `@operator` matches nothing).
  }

  // 2. Generic `@agent` → the primary specialist on the task.
  if (handleSet.has("agent") && primaryRef) {
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
      model: sp?.model ?? (defaultModelFor(backend)),
      effort: sp?.effort ?? "",
      actorRef: agentActorRef(backend, role),
      isPrimary: true,
      isOperator: false,
      session: latestSessionRun(db, projectSlug, taskKey, {
        profileId: primaryRef.profileId,
        backend,
        isPrimary: true,
      }),
    };
  }

  // 3. A deployed specialist by name / id / backend.
  const matched = specialists.find((s) => handleMatchesSpecialist(handleSet, s));
  if (matched) {
    const isPrimary = primaryRef?.profileId === matched.id;
    return {
      profileId: matched.id,
      name: matched.name,
      role: matched.role,
      backend: matched.backend,
      model: matched.model,
      effort: matched.effort,
      actorRef: agentActorRef(matched.backend, matched.role),
      isPrimary,
      isOperator: false,
      session: latestSessionRun(db, projectSlug, taskKey, {
        profileId: matched.id,
        backend: matched.backend,
        isPrimary,
      }),
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
        model: defaultModelFor(backend),
        effort: "",
        actorRef: agentActorRef(backend, primaryRef.role),
        isPrimary: true,
        isOperator: false,
        session: latestSessionRun(db, projectSlug, taskKey, {
          profileId: primaryRef.profileId,
          backend,
          isPrimary: true,
        }),
      };
    }
  }

  return null;
}

// ---------------------------------------------------- reply-text extraction

/** Timeline-comment length cap — the full transcript stays in the agent logs. */
const MAX_REPLY_CHARS = 1200;

/**
 * Extract the FULL (untruncated) reply from a finished run's persisted lines:
 * prefer the LAST substantial `assistant`/`agent_message` text line, else fall
 * back to the final `result`/`turn.completed` text. Whitespace is preserved as
 * the agent wrote it. Returns null when nothing usable was produced.
 *
 * The verdict classifier and the no-progress guard consume THIS (full) text —
 * a reviewer's verdict frequently lands well past 1200 chars, so classifying on
 * the truncated comment would silently drop the verdict.
 */
export function extractFullReplyText(lines: LogLine[]): string | null {
  const isReplyText = (l: LogLine) =>
    l.ev === "text" &&
    (l.tag === "assistant" || l.tag === "agent_message") &&
    l.text.trim().length > 0;

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (isReplyText(line)) return line.text.trim();
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (line.ev === "result" && line.text.trim().length > 0) {
      return line.text.trim();
    }
  }
  return null;
}

/**
 * The timeline-comment form of the reply: the full text truncated to a readable
 * length with a pointer to the full transcript. The raw transcript remains in
 * the run's agent logs.
 */
export function extractReplyText(lines: LogLine[]): string | null {
  const full = extractFullReplyText(lines);
  return full == null ? null : truncate(full);
}

function truncate(text: string): string {
  if (text.length <= MAX_REPLY_CHARS) return text;
  return (
    text.slice(0, MAX_REPLY_CHARS - 1).trimEnd() +
    "…\n\n_(truncated — full report in the agent logs)_"
  );
}

/** Read a run's persisted display lines (helper for the completion callback). */
export function replyTextForRun(
  db: Database.Database,
  runId: string,
): string | null {
  const lines = listRunLines(db, runId).map((l) => l.display);
  return extractReplyText(lines);
}

/** The full untruncated reply text of a run (for verdict + no-progress checks). */
export function fullReplyTextForRun(
  db: Database.Database,
  runId: string,
): string | null {
  const lines = listRunLines(db, runId).map((l) => l.display);
  return extractFullReplyText(lines);
}

/**
 * A human-readable failure reason for a run that ended in `error` (F8): the last
 * error line the backend emitted (e.g. a Codex "usage limit" message, an auth
 * failure, a crashed tool). Returns null when the run logged no error line.
 * Classified into a short kind so the recovery packet can be specific.
 */
export function runFailureReason(
  db: Database.Database,
  runId: string,
): { kind: "quota" | "auth" | "unknown"; text: string } | null {
  const lines = listRunLines(db, runId).map((l) => l.display);
  let last: LogLine | null = null;
  for (const l of lines) {
    if (l.ev === "err" || /fail|error/i.test(l.tag ?? "")) last = l;
  }
  if (!last?.text) return null;
  const text = last.text.trim();
  const kind: "quota" | "auth" | "unknown" = /usage limit|quota|rate limit|too many requests|429/i.test(
    text,
  )
    ? "quota"
    : /unauthor|forbidden|invalid.*(key|token|credential)|401|403|not logged in|authenticate/i.test(text)
      ? "auth"
      : "unknown";
  return { kind, text };
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
