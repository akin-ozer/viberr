import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { LogLine } from "~/features/runtime/runtime-types";
import {
  deliveringEngagement,
  type FileActorRef,
} from "~/schemas/task-file.schema";
import { taskDir } from "~/server/files/file-store-root.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import {
  listRunLines,
  listRunsForTaskRows,
  runIdsWithMissingSession,
  type AgentRunRow,
} from "~/server/runtimes/run-store.server";
import { SESSION_MISSING_RE } from "~/server/runtimes/session-export.server";
import type { RealBackend } from "~/server/runtimes/runtime-registry.server";
import { defaultModelFor } from "~/server/runtimes/model-catalog.server";
import {
  listDeployedSpecialists,
  type DeployedSpecialistView,
} from "./specialist-run.server";
import { resolveOperatorAuthority } from "./operator-actions.server";
import type { TaskMutationContext } from "./task-actions.server";
import { extractMentions } from "~/ui/mention-spans";

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

/**
 * All @handles in a comment, lowercased, de-duplicated, order-preserving.
 *
 * P13-LV-11: this used to be a single-token regex, so a mention of an agent
 * whose display name contains a space ("@Docs Writer" — exactly what the
 * composer inserts and the timeline highlights) matched NOTHING and the comment
 * silently routed nowhere. It now uses the shared span-finder with the known
 * mentionable names, so multi-word names resolve whole and the highlight and the
 * routing agree.
 */
function mentionHandles(text: string, known: string[] = []): string[] {
  return extractMentions(text, known);
}

/** Every string a deployed specialist can be tagged by. */
function specialistHandles(sp: DeployedSpecialistView): string[] {
  return [sp.name, sp.id, sp.backend];
}

/** The single-token mention grammar `findMentionSpans` falls back to when a
 *  handle is not in the reader's known-names list. */
const TOKENIZABLE_HANDLE_RE = /^[A-Za-z][\w-]*$/;

/**
 * The @handle to ADDRESS an agent by — the one derivation every writer uses
 * (P14-RT-12).
 *
 * It used to be derived twice and differently: `startAgentRun` took the first
 * word of the ROLE (`"Senior Developer"` → `@senior`, which
 * `resolveMentionedAgent` matches against nothing at all) while `commentToAgent`
 * took the NAME (`"Docs Writer"` → `@docs writer`, which only resolves for a
 * reader that already knows the name). The same agent was therefore addressed
 * differently depending on which path registered its completion, and a stuck
 * packet's "Agent: @…" observation could name a handle that resolves to nobody.
 *
 * The profile id is preferred because it is BOTH resolvable
 * (`handleMatchesSpecialist` matches it) and tokenizable by the bare `@word`
 * grammar, so it routes even when the reader passes no known names. A profile id
 * that is not a bare token (hand-edited store) falls back to the display name,
 * which the shared span-finder still matches whole.
 */
export function agentMentionHandle(agent: {
  profileId: string;
  name?: string | null;
}): string {
  const id = agent.profileId.trim();
  if (TOKENIZABLE_HANDLE_RE.test(id)) return id.toLowerCase();
  const name = (agent.name ?? "").trim();
  return (name || id).toLowerCase();
}

/** The generic role/backend handles the resolver honours (mirrors
 *  mention-suggestions' RESERVED and mention-notify's RESERVED_HANDLES). */
const RESERVED_AGENT_HANDLES = ["operator", "agent", "claude", "codex"];

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

/** The agent's file actor ref — `agent:<backend>/<profileId> (role)` (D7:
 * the profile id is the identity; the role is a display snapshot). */
function agentActorRef(
  backend: RealBackend,
  profileId: string,
  role: string,
): FileActorRef {
  return { kind: "agent", backend, profileId, roleHint: role };
}

/**
 * Does a set of @handles NAME this deployed specialist — by display name or
 * profile id, case-insensitively? `@agent` matches the PRIMARY specialist only
 * (resolved by the caller); it is not matched here so a two-specialist task does
 * not ambiguously match both.
 */
function handleNamesSpecialist(
  handles: Set<string>,
  sp: DeployedSpecialistView,
): boolean {
  return handles.has(sp.name.toLowerCase()) || handles.has(sp.id.toLowerCase());
}

/**
 * The deployed specialists a BACKEND handle (`@claude` / `@codex`) covers.
 *
 * B-AG2: a backend handle names a runtime, not an agent. It used to be folded
 * into the same `find` as name/id, so on a project running two claude profiles
 * "@claude, please look" deterministically engaged whichever the project file
 * listed FIRST — a profile that may never have been intended for this task, and
 * one the human had no way to predict. It resolves only when the backend
 * identifies exactly one deployed specialist; several is an ambiguity the caller
 * reports instead of guessing at.
 */
function specialistsForBackendHandle(
  handles: Set<string>,
  specialists: readonly DeployedSpecialistView[],
): DeployedSpecialistView[] {
  return specialists.filter((sp) => handles.has(sp.backend));
}

/** An unresolvable `@claude`/`@codex` mention: the backend runs several deployed
 * specialists here, so nothing is engaged until the human names one. */
export interface AmbiguousBackendHandle {
  backend: RealBackend;
  /** Every deployed specialist of that backend, in project-file order. */
  candidates: { profileId: string; name: string }[];
}

/**
 * Why a mention that carried an agent handle engaged nobody — when the reason is
 * "the backend handle covers more than one deployed specialist". Returns null
 * for every other case (no handle, a name that matched, a single candidate).
 * The caller turns it into the policy-note reply that asks for a profile name.
 */
export function ambiguousBackendHandle(
  ctx: TaskMutationContext,
  projectSlug: string,
  text: string,
): AmbiguousBackendHandle | null {
  const specialists = listDeployedSpecialists(projectSlug, ctx);
  const handles = new Set(
    mentionHandles(text, [
      ...specialists.flatMap(specialistHandles),
      ...RESERVED_AGENT_HANDLES,
    ]),
  );
  if (handles.size === 0) return null;
  if (specialists.some((sp) => handleNamesSpecialist(handles, sp))) return null;
  const candidates = specialistsForBackendHandle(handles, specialists);
  if (candidates.length < 2) return null;
  return {
    backend: candidates[0]!.backend,
    candidates: candidates.map((sp) => ({ profileId: sp.id, name: sp.name })),
  };
}

/** The policy-note copy for an ambiguous backend mention — one sentence naming
 * every candidate, so the human can re-tag precisely. */
export function ambiguousBackendHandleNote(
  ambiguous: AmbiguousBackendHandle,
): string {
  const names = ambiguous.candidates
    .map((c) => `@${c.profileId} (${c.name})`)
    .join(" · ");
  return (
    `No agent was engaged: **@${ambiguous.backend}** names a runtime, and ` +
    `${ambiguous.candidates.length} profiles run on it here — ${names}. ` +
    // F19-12: rendered copy uses the shipped vocabulary — "delivering agent".
    `Tag the profile you want (or @agent for this task's delivering agent).`
  );
}

/**
 * The most-recent run row (created_at DESC) that is THIS agent's OWN resumable
 * session — matched by AGENT IDENTITY, never merely by backend. Matching by
 * backend alone let `@reviewer` resume the dev's most-recent claude session
 * (the dev then answered "as the dev"); this keeps each agent on its own thread.
 *
 * The profile id, engagement kind AND backend must all match. A provider
 * session is not portable across backends: a Claude session id means nothing to
 * Codex and vice versa.
 *
 * P13-RT-12: the backend clause used to be missing while the comment at the
 * `@agent` branch below already CLAIMED it ("Sessions never match across
 * backends"). After an admin switched a profile's backend, an @mention resumed
 * the DEAD backend's session with the new backend's model — `resumeRun` takes
 * the backend from the prior run row and the model from the caller, so the run
 * recorded e.g. `backend: claude, model: gpt-5.6-sol`, a pairing that never
 * existed. `resolveClaudeModel` doesn't recognize it and returns undefined, so
 * the run silently used the subscription default on the backend the admin had
 * just moved away from (typically because it was out of quota). Filtering here
 * makes the first post-switch mention start a FRESH run on the new backend,
 * which is what the comment always promised.
 *
 * P13-D-2: runs whose provider session is PROVEN gone are skipped too. There
 * used to be no state filter at all, so once a transcript vanished (Claude
 * Code's ~30-day retention, a wiped `$CODEX_HOME/sessions`) the row holding
 * that dead id stayed the newest match forever — every later @mention
 * re-selected it, failed the same way, and the agent became permanently
 * unreachable on that task. `resumeRun` records a `session_missing` failure on
 * the run that owned the id, so the next mention falls through to an older live
 * session, or to a fresh run.
 */
function latestSessionRun(
  db: DatabaseSync,
  projectSlug: string,
  taskKey: string,
  target: { profileId: string; isPrimary: boolean; backend: RealBackend },
): AgentRunRow | null {
  const rows = listRunsForTaskRows(db, projectSlug, taskKey);
  const deadSessions = runIdsWithMissingSession(db, projectSlug, taskKey);
  const wantKind = target.isPrimary ? "primary" : "reviewer";
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!;
    if (!row.session_id) continue;
    if (deadSessions.has(row.id)) continue;
    if (
      row.agent_profile_id === target.profileId &&
      row.kind === wantKind &&
      row.backend === target.backend
    ) {
      return row;
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
  db: DatabaseSync,
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
  text: string,
): MentionedAgent | null {
  const specialists = listDeployedSpecialists(projectSlug, ctx);
  // Known handles must be collected BEFORE parsing so a multi-word agent name
  // matches whole (P13-LV-11).
  const handles = mentionHandles(text, [
    ...specialists.flatMap(specialistHandles),
    ...RESERVED_AGENT_HANDLES,
  ]);
  if (handles.length === 0) return null;
  const handleSet = new Set(handles);

  const existing = readTaskFile({
    projectSlug,
    taskKey,
    dataRoot: ctx.dataRoot,
  });
  const primaryRef = existing
    ? deliveringEngagement(existing.parsed.frontmatter)
    : null;

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
    // Backend precedence MUST match the fresh-run resolver
    // (specialist-run.server `backendOverride ?? pinnedBackend ?? live ?? snapshot`)
    // so an @mention resume goes to the SAME backend a new Run would. F28-P1: a
    // STUCK retry pin (F27-B1) wins over the live deployment — otherwise a
    // "Retry on the other backend" packet switches the engagement, but the next
    // `@agent` comment silently resumes the backend the retry existed to escape,
    // while every surface shows the pinned one. Absent a pin, prefer the current
    // deployment's backend over the assign-time snapshot (a redeployed profile
    // replies there). Sessions never match across backends, so the first reply
    // after a switch starts a fresh run instead of resuming a dead session.
    const backend: RealBackend =
      primaryRef.pinnedBackend ??
      sp?.backend ??
      (primaryRef.backend === "codex" ? "codex" : "claude");
    const role = sp?.role ?? primaryRef.role;
    return {
      profileId: primaryRef.profileId,
      name: sp?.name ?? primaryRef.profileId,
      role,
      backend,
      model: sp?.model ?? (defaultModelFor(backend)),
      effort: sp?.effort ?? "",
      actorRef: agentActorRef(backend, primaryRef.profileId, role),
      isPrimary: true,
      isOperator: false,
      session: latestSessionRun(db, projectSlug, taskKey, {
        profileId: primaryRef.profileId,
        isPrimary: true,
        backend,
      }),
    };
  }

  // 3. A deployed specialist NAMED by the mention (display name or profile id),
  //    else the single specialist a backend handle identifies (B-AG2).
  const backendCandidates = specialistsForBackendHandle(handleSet, specialists);
  const matched =
    specialists.find((s) => handleNamesSpecialist(handleSet, s)) ??
    (backendCandidates.length === 1 ? backendCandidates[0] : undefined);
  if (matched) {
    const isPrimary = primaryRef?.profileId === matched.id;
    // F28-P1: a by-NAME mention of the pinned delivering agent resumes on the
    // pin (matching the @agent path and a fresh Run). An explicit `@claude` /
    // `@codex` backend handle is the user's OWN backend choice and is never
    // overridden — so the pin applies only when the mention actually names the
    // specialist. When the pin diverges from the live deployment, the model /
    // effort snapshot is for the wrong backend, so fall back to a default.
    const pinned =
      isPrimary && handleNamesSpecialist(handleSet, matched)
        ? (primaryRef?.pinnedBackend ?? null)
        : null;
    const backend: RealBackend = pinned ?? matched.backend;
    const sameAsDeployment = backend === matched.backend;
    return {
      profileId: matched.id,
      name: matched.name,
      role: matched.role,
      backend,
      model: sameAsDeployment ? matched.model : defaultModelFor(backend),
      effort: sameAsDeployment ? matched.effort : "",
      actorRef: agentActorRef(backend, matched.id, matched.role),
      isPrimary,
      isOperator: false,
      session: latestSessionRun(db, projectSlug, taskKey, {
        profileId: matched.id,
        isPrimary,
        backend,
      }),
    };
  }

  // Several deployed specialists share the tagged backend: engage NOBODY rather
  // than guess (B-AG2). The primary fallback below must not fire either — it
  // would resolve exactly the arbitrary pick this branch exists to refuse.
  if (backendCandidates.length > 1) return null;

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
        actorRef: agentActorRef(backend, primaryRef.profileId, primaryRef.role),
        isPrimary: true,
        isOperator: false,
        session: latestSessionRun(db, projectSlug, taskKey, {
          profileId: primaryRef.profileId,
          isPrimary: true,
          backend,
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
 * the LAST substantial `assistant`/`agent_message` text line. Whitespace is
 * preserved as the agent wrote it. Returns null when the run produced no
 * report of its own.
 *
 * The verdict classifier and the no-progress guard consume THIS (full) text —
 * a reviewer's verdict frequently lands well past 1200 chars, so classifying on
 * the truncated comment would silently drop the verdict.
 *
 * P13-RT-09: there used to be a fallback to the terminal `result` line, whose
 * text is RUNTIME STATISTICS, not prose — `"success · 3 turns · 12s · $0.02"`
 * on Claude, `"in 4.1k (cached 2.0k) · out 0.3k tokens"` on Codex
 * (wire-format). A run that only edited files and exited therefore posted
 * `success · 7 turns · 214s · $0.31` to the timeline as the agent's report, fed
 * that string to the prose verdict classifier, and — because two such Codex
 * runs can produce byte-identical text — tripped the "verbatim repeat"
 * stuck-loop detector for the wrong reason. A run with no report now honestly
 * has none: `postAgentReplyComment` logs it and posts nothing, and the stats
 * stay where they belong, in the run panel.
 */
export function extractFullReplyText(lines: LogLine[]): string | null {
  const isReplyText = (l: LogLine) =>
    l.ev === "text" &&
    (l.tag === "assistant" || l.tag === "agent_message") &&
    l.text.trim().length > 0;

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (isReplyText(line)) return normalizeWorkspacePaths(line.text.trim());
  }
  return null;
}

/**
 * An absolute host path that points INTO a task workspace clone, matched at a
 * boundary that is not part of a URL (F7-UX1). Structure:
 *   `<data-root>/…/tasks/<KEY>/workspace/<repo>/<rest>`  →  captured `<rest>`.
 * P8 (pass 25): a SUPPORTING run's checkout is one level deeper —
 *   `…/tasks/<KEY>/workspace/support/<profileId>/<repo>/<rest>` — so the optional
 * `support/<profileId>/` group is skipped before the repo segment; without it a
 * reviewer's echoed path would rewrite to `<profileId>/<repo>/<rest>` (wrong).
 * The leading `/` must not follow a word char, `:`, `/`, or `.` so `http(s)://`
 * and `file://` URLs (and interior path segments) are never anchored on. The
 * `<rest>` capture stops at whitespace or bracket/paren so a markdown link's
 * closing `)` / `]` is left intact.
 */
const WORKSPACE_ABS_PATH_RE =
  /(?<![:\w/.])\/(?:[^\s()<>[\]]*?\/)?tasks\/[^/\s()<>[\]]+\/workspace\/(?:support\/[^/\s()<>[\]]+\/)?[^/\s()<>[\]]+\/([^\s()<>[\]]+)/g;

/**
 * Rewrite workspace-absolute host paths in an agent reply to repo-relative ones
 * (F7-UX1): `/Users/…/tasks/VIB-2/workspace/viberr/docs/x.md` → `docs/x.md`, so
 * links a specialist emits are portable for every reader instead of pointing at
 * one machine's checkout. Real URLs (http/https/file) and non-workspace paths
 * are left untouched. Applied at reply-extraction time so the canonical timeline
 * comment (and everything derived from it) is clean.
 */
export function normalizeWorkspacePaths(text: string): string {
  return text.replace(WORKSPACE_ABS_PATH_RE, "$1");
}

/**
 * The reply truncated to a readable preview length with a pointer to the full
 * transcript. NO LONGER the stored timeline form (2026-07-17: comments store
 * the FULL reply and the timeline UI clamps + expands) — kept for previews and
 * the recovery reconciler's has-a-reply check.
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
  db: DatabaseSync,
  runId: string,
): string | null {
  const lines = listRunLines(db, runId).map((l) => l.display);
  return extractReplyText(lines);
}

/** The full untruncated reply text of a run (for verdict + no-progress checks). */
export function fullReplyTextForRun(
  db: DatabaseSync,
  runId: string,
): string | null {
  const lines = listRunLines(db, runId).map((l) => l.display);
  return extractFullReplyText(lines);
}

/** R20-3 (F20-4): the marker both runtimes append the provider's redacted
 *  sentence behind, so `runFailureReason` can split it back off. ONE source
 *  since pass 32 (P07-C): `~/shared/provider-marker`, re-exported here for
 *  the task layer's existing importers. */
import { PROVIDER_TEXT_MARKER } from "~/shared/provider-marker";
export { PROVIDER_TEXT_MARKER };

/** Classified failure classes for an errored run (F8 + R7-2 fail-fast).
 *  Ruling 130(a) (pass 34): the vocabulary lives in the client-safe leaf
 *  `~/shared/run-failure` so the console's `LogLine.failure` can be typed
 *  without a server import; re-exported here for the task layer's importers. */
import {
  TAGGED_FAILURE_KINDS,
  type RunFailureFacts,
  type RunFailureKind,
} from "~/shared/run-failure";
export type { RunFailureKind };

export interface RunFailure {
  kind: RunFailureKind;
  text: string;
  /** R20-3: the provider's own redacted sentence, when the adapter sent one. */
  providerText?: string;
  /** Ruling 130(a) (pass 34): the adapter's structured facts (reset instant,
   *  window, API error code and status), read from the terminal line's
   *  `failure` record. Absent when the adapter attached none. */
  facts?: RunFailureFacts;
}

/**
 * A human-readable failure reason for a run that ended in `error` (F8): the last
 * error line the backend emitted (e.g. a Codex "usage limit" message, an auth
 * failure, a crashed tool). Returns null when the run logged no error line.
 * Classified into a short kind so the recovery packet can be specific.
 * "unavailable" is the R7-2 fail-fast class: no agent process ever started.
 * Under ruling 127 that means the run had no credential principal (an unowned
 * task, or an owner whose account is gone) or that person had not connected the
 * backend, so there was nothing to spawn with.
 */
export function runFailureReason(
  db: DatabaseSync,
  runId: string,
): RunFailure | null {
  const lines = listRunLines(db, runId).map((l) => l.display);
  let last: LogLine | null = null;
  for (const l of lines) {
    if (l.ev === "err" || /fail|error/i.test(l.tag ?? "")) last = l;
  }
  if (!last?.text) return null;
  // R20-3 (F20-4): the adapter appended the provider's own redacted sentence
  // after a marker (git-output-redact:redactProviderText / the two runtimes).
  // Split it back off so `text` stays the human sentence every existing caller
  // expects, and `providerText` rides separately into the packet observation
  // and the fenced timeline block.
  const raw = last.text.trim();
  const markerIdx = raw.indexOf(PROVIDER_TEXT_MARKER);
  const text = (markerIdx >= 0 ? raw.slice(0, markerIdx) : raw).trim();
  const providerText =
    markerIdx >= 0
      ? raw.slice(markerIdx + PROVIDER_TEXT_MARKER.length).trim()
      : "";
  // An adapter that classified its OWN failure before redacting the raw stderr
  // rides the class on the err tag as a `·<kind>` suffix (e.g. `error·quota`).
  // Trust that structured signal directly: the redaction-safe message text is
  // deliberately generic and may not re-match these prose regexes (the codex
  // auth message says "authentication" while the regex below wants
  // "authenticate"), so re-classifying the prose would drop codex quota/auth
  // failures to `unknown`. Backends that emit no class (plain err lines) still
  // fall through to the prose regexes below.
  // Ruling 130(a): the adapter's typed record wins outright; the tag suffix
  // is the same fact for lines written before the record existed.
  if (last.failure) {
    return withProviderText({ kind: last.failure.kind, text, facts: last.failure }, providerText);
  }
  const tag = last.tag ?? "";
  const taggedKind = TAGGED_FAILURE_KINDS.find((k) => tag.endsWith(`·${k}`));
  if (taggedKind) return withProviderText({ kind: taggedKind, text }, providerText);
  const kind: RunFailureKind =
    // P13-D-2 first: a vanished session is NOT an auth problem, and "no
    // conversation found" would otherwise fall through to `unknown` and be
    // narrated as "review its authentication and runtime configuration".
    SESSION_MISSING_RE.test(text)
      ? "session_missing"
      : /is unavailable|no usable credential/i.test(text)
        ? "unavailable"
        : /usage limit|quota|rate limit|too many requests|429|session limit|weekly limit|monthly limit|out of credits|credit balance/i.test(text)
          ? "quota"
          : /unauthor|forbidden|invalid.*(key|token|credential)|401|403|not logged in|authenticate/i.test(text)
            ? "auth"
            : "unknown";
  return withProviderText({ kind, text }, providerText);
}

/** `providerText` is absent unless the adapter actually sent one — an empty
 *  string would render as an empty "The provider reported:" block. */
function withProviderText(failure: RunFailure, providerText: string): RunFailure {
  if (providerText) failure.providerText = providerText;
  return failure;
}

// -------------------------------------------------------- resume workdir

/**
 * The working directory a resumed reply run should use: the specialist-run
 * clone at `<taskDir>/workspace/<repo-name>` when it still exists (so the
 * agent keeps its repo context), else the dedicated workspace root. The
 * workspace fallback keeps `GIT_CEILING_DIRECTORIES=<taskDir>` a strict
 * ancestor of cwd, preventing Git from discovering a host checkout above the
 * data root. `repo` is the task/project repo `<owner>/<name>` (null → no clone
 * was ever made).
 */
export function resumeWorkdir(
  projectSlug: string,
  taskKey: string,
  repo: string | null,
  dataRoot?: string,
  /** P8 (pass 25): a resumed SUPPORTING run stays in its OWN isolated checkout
   *  (`workspace/support/<profileId>/<repo>`) — never the delivering engagement's
   *  canonical `workspace/<repo>`, so its writes never reach the delivered PR. */
  support?: { profileId: string },
): string {
  const base = taskDir(projectSlug, taskKey, dataRoot);
  const scopedRoot = support
    ? path.join(base, "workspace", "support", support.profileId)
    : path.join(base, "workspace");
  if (repo) {
    const name = repo.split("/").pop() ?? repo;
    const clone = path.join(scopedRoot, name);
    if (existsSync(path.join(clone, ".git"))) return clone;
  }
  mkdirSync(scopedRoot, { recursive: true });
  return scopedRoot;
}
