import type { RunBackend, RunKind } from "~/features/runtime/runtime-types";
import type { CredentialKind } from "./backend-credentials.server";

/**
 * Ruling 370: ONE home for every number that decides how much context a run
 * carries, when it is compacted, how long its prompt cache is assumed to live,
 * and when a resume is refused in favour of a fresh session — on both backends,
 * for all three run kinds. Nothing else in the tree may spell one of these
 * figures; the adapters, the run service, the sink and the docs all read them
 * here. The measurements behind them are in
 * `planning/prompt-cache-2026-09-21/RESEARCH.md` and the ruling text.
 *
 * A leaf module on purpose (types only from elsewhere): both adapters, the run
 * service and the insights query import it, and it must never import them.
 */

/** The backends that actually run a model (the type in runtime-types also
 *  names "codex" and "claude"; this alias keeps the tables below readable). */
export type ContextBackend = RunBackend;

/**
 * The context window past which the CLI is asked to compact, per backend and
 * run kind, in prompt tokens. `null` means "leave the CLI's own default": the
 * operator's turns peak well under 100k (measured p90 59k, max 97k over 247
 * runs), so a window there would never fire and only add a knob.
 *
 * Claude reads `CLAUDE_CODE_AUTO_COMPACT_WINDOW` (a plain token count, 100k to
 * 1M; overrides the model's own threshold, which on a native-1M model sits
 * near 967k — how specialists reached 482k per call and the controller 948k).
 * Codex reads `model_auto_compact_token_limit` with
 * `model_auto_compact_token_limit_scope = "total"`; 180k is under the ~160k
 * point past which one report saw its cache collapse under memory pressure
 * and well inside its 258k context.
 */
export const AUTO_COMPACT_WINDOW = {
  claude: { operator: null, primary: 250_000, reviewer: 250_000, controller: 300_000 },
  codex: { operator: null, primary: 180_000, reviewer: 180_000, controller: null },
} as const satisfies Record<ContextBackend, Record<RunKind, number | null>>;

/** The env key the Claude CLI reads the window from (see `contextWindowEnv`). */
export const CLAUDE_AUTO_COMPACT_WINDOW_ENV = "CLAUDE_CODE_AUTO_COMPACT_WINDOW";

/**
 * Every env key this policy may put into a run's child environment. The
 * hermeticity test pins the child env's Viberr-added keys against this list
 * plus the credential and marker keys, so a key added here without a test
 * naming it fails the suite.
 */
export const CONTEXT_ENV_KEYS = [CLAUDE_AUTO_COMPACT_WINDOW_ENV] as const;

/** The window for one run, or null when the CLI's default stands. */
export function autoCompactWindow(backend: ContextBackend, kind: RunKind): number | null {
  return AUTO_COMPACT_WINDOW[backend][kind];
}

/**
 * The env overlay a Claude run carries for its window: exactly one key when
 * the kind has a window, nothing otherwise. Codex takes its window through
 * `config.toml` keys (`codexCompactionConfig`), never the environment.
 */
export function contextWindowEnv(backend: ContextBackend, kind: RunKind): Record<string, string> {
  if (backend !== "claude") return {};
  const window = autoCompactWindow(backend, kind);
  return window === null ? {} : { [CLAUDE_AUTO_COMPACT_WINDOW_ENV]: String(window) };
}

/**
 * The Codex CLI config keys for a kind with a window: the limit, its scope and
 * the shared compaction prompt. Empty for a kind with no window, so the CLI's
 * own defaults stand and nothing is written that a reader could mistake for a
 * decision.
 */
export interface CodexCompactionConfig {
  model_auto_compact_token_limit: number;
  model_auto_compact_token_limit_scope: "total";
  compact_prompt: string;
}

export function codexCompactionConfig(kind: RunKind): Partial<CodexCompactionConfig> {
  const window = autoCompactWindow("codex", kind);
  if (window === null) return {};
  return {
    model_auto_compact_token_limit: window,
    model_auto_compact_token_limit_scope: "total",
    compact_prompt: CODEX_COMPACT_PROMPT,
  };
}

/**
 * Ruling 372: the size past which a session that has outlived its cache is
 * never replayed. Below it a resume re-writes cheaply; above it the whole
 * history is one cache write (the three first calls above 100k on this
 * instance wrote 298k, 911k and 929k, the last two after 71 minutes and 39
 * hours idle on a 945k conversation).
 *
 * Measured on the size a resume would REPLAY — the last call's prompt — not the
 * run's peak: a run that compacted at 250k and finished at 20k replays 20k, and
 * refusing to resume it would throw away the summary compaction just built.
 */
export const RESUME_FRESH_CONTEXT_TOKENS = 150_000;

/**
 * How long the provider is assumed to keep a session's prompt cache warm, by
 * backend and credential kind. Claude Code picks the TTL per request: one hour
 * for the main conversation on a subscription seat within its included usage
 * (every one of the 18,869 calls this instance stored sat in the 1-hour
 * bucket), five minutes on an API key. Codex is ten minutes until measured
 * (OpenAI documents an in-memory retention of 5 to 10 minutes idle; whether the
 * ChatGPT-backed CLI asks for 24-hour retention is disputed, and the
 * first-turn cached ratio the sink now stores will settle it).
 *
 * The policy is the CLI's automatic choice: no forced TTL and no keep-alive
 * ping on either backend (ruling 374).
 */
export const CACHE_TTL_MS = {
  claude: { login: 60 * 60 * 1000, api_key: 5 * 60 * 1000, access_token: 5 * 60 * 1000 },
  codex: { login: 10 * 60 * 1000, api_key: 10 * 60 * 1000, access_token: 10 * 60 * 1000 },
} as const satisfies Record<ContextBackend, Record<CredentialKind, number>>;

/** The TTL for one session. An unknown credential kind (a row written before
 *  the kind was stored) reads as a sign-in: the longer window, so an old row
 *  is resumed rather than reset on a guess. */
export function cacheTtlMs(backend: ContextBackend, kind: CredentialKind | null): number {
  return CACHE_TTL_MS[backend][kind ?? "login"];
}

/** What `resumeVerdict` decided, and the two facts it decided on. */
export interface ResumeVerdict {
  /** Start a fresh session instead of replaying the stored one. */
  fresh: boolean;
  idleMs: number;
  ttlMs: number;
  contextTokens: number;
}

/**
 * Ruling 372: whether a resume replays the stored session or starts fresh.
 * Fresh exactly when the session is BOTH older than its cache TTL AND larger
 * than the replay threshold; either alone resumes as before (a small stale
 * session re-writes cheaply, a large warm one reads its prefix back).
 *
 * `now` and `finishedAt` are instants the caller supplies, never a clock read
 * here: the run service passes its own `nowIso` and the tests pin it.
 */
export function resumeVerdict(input: {
  backend: ContextBackend;
  credentialKind: CredentialKind | null;
  /** The prior run's `finished_at`; null (a row that never finished) reads as
   *  "idle for ever", which only ever decides against a replay when the
   *  session is also large. */
  finishedAt: string | null;
  nowIso: string;
  /** The last call's prompt in the stored session, or null when unknown. */
  contextTokens: number | null;
}): ResumeVerdict {
  const ttlMs = cacheTtlMs(input.backend, input.credentialKind);
  const finished = input.finishedAt ? Date.parse(input.finishedAt) : NaN;
  const now = Date.parse(input.nowIso);
  const idleMs =
    Number.isFinite(finished) && Number.isFinite(now)
      ? Math.max(0, now - finished)
      : Number.POSITIVE_INFINITY;
  const contextTokens = input.contextTokens ?? 0;
  return {
    fresh: idleMs > ttlMs && contextTokens > RESUME_FRESH_CONTEXT_TOKENS,
    idleMs,
    ttlMs,
    contextTokens,
  };
}

/**
 * Ruling 369: a run's first model call started WARM when it read more of its
 * prompt from the cache than it wrote into it, COLD otherwise. One rule, so the
 * sink's stored flag, the console chip and the Insights rate cannot disagree.
 */
export function startTemperature(cacheWrite: number, cacheRead: number): "warm" | "cold" {
  return cacheRead > cacheWrite ? "warm" : "cold";
}

/** Ruling 369: a first call that wrote more than this is the Insights card's
 *  "large first write" — the replay-after-expiry shape the resume policy
 *  exists to remove. */
export const FIRST_CALL_LARGE_WRITE_TOKENS = 100_000;

// ------------------------------------------------------ what compaction keeps

/**
 * Ruling 371: the prompt Codex's summarizer is given instead of its default,
 * shared by every Codex run with a window. It names what a Viberr run cannot
 * recover from the summary alone. Per-task facts (the task.md path, branch,
 * PR, knowledge bases) are NOT in it: they ride `developer_instructions`,
 * which Codex re-renders after compaction by construction.
 */
export const CODEX_COMPACT_PROMPT =
  "You are compacting the context of an agent run that Viberr coordinates. Write a " +
  "summary the same agent can resume from without re-reading the history. It " +
  "MUST keep, verbatim where they are short: the task key and its goal; the " +
  "pointer to the canonical task file (task.md) and the instruction to re-read " +
  "it before acting; the branch and pull request the work lands on; the names " +
  "of the attached knowledge bases and that read_knowledge_doc re-reads them; " +
  "every decision taken and why; every attempt that FAILED, what was tried and " +
  "why it failed, so it is not repeated; the work still pending, as a list; " +
  "and the files changed so far. Drop tool output and reasoning that the list " +
  "above already accounts for. Do not invent progress that did not happen.";

/** Everything the task anchor names, so a compacted Claude session gets back
 *  the facts its summary may have dropped. */
export interface SpecialistCompactAnchorInput {
  taskKey: string;
  title: string;
  /** Absolute path of the canonical task file. */
  taskMdPath: string;
  branch: string | null;
  /** The PR's number and, when the project's repository is known, its URL. */
  pr: { number: number; url: string | null } | null;
  /** Attached knowledge-base names, sorted. */
  kb: readonly string[];
  /** The project's rulings knowledge base, when one is attached. */
  rulingsKb: string | null;
}

/**
 * Ruling 371: what a specialist is told the moment its context has been
 * compacted (a `SessionStart` hook on the `compact` source). Claude keeps the
 * system prompt — the persona and the knowledge-base indexes — untouched and
 * re-injects the skills the run invoked; what it drops is tool output,
 * reasoning and anything the summary did not carry. This block re-pins the
 * facts a task run cannot work without.
 */
export function specialistCompactAnchor(input: SpecialistCompactAnchorInput): string {
  const lines = [
    "# Context compacted — re-anchor before you continue",
    "",
    "Viberr compacted this session's context. Your persona and the knowledge-base " +
      "indexes in your system prompt are unchanged; the conversation above is a " +
      "summary, and any tool output it does not mention is gone.",
    "",
    `Task: ${input.taskKey} — "${input.title}"`,
    `Canonical task file: ${input.taskMdPath} — re-read it before you act; it is the truth, the summary is not.`,
    input.branch ? `Branch: \`${input.branch}\`` : "Branch: none allocated yet",
    input.pr
      ? `Pull request: #${input.pr.number}${input.pr.url ? ` (${input.pr.url})` : ""}`
      : "Pull request: none opened yet",
    input.kb.length
      ? `Knowledge bases: ${input.kb.join(", ")} — read a document again with read_knowledge_doc; nothing in the summary replaces it.`
      : "Knowledge bases: none attached.",
    input.rulingsKb
      ? `The project's rulings (${input.rulingsKb}) still bind you; re-read the relevant document before a decision.`
      : "",
    "Continue from the pending work the summary lists; if it lists none, derive it from task.md and the repository state, and say so in your report.",
  ];
  return lines.filter((line) => line !== "").join("\n");
}

/** The conversation anchor for a compacted controller session (ruling 373). */
export interface ControllerCompactAnchorInput {
  conversationId: string;
  userLabel: string;
  projectSlug: string | null;
  taskKey: string | null;
}

export function controllerCompactAnchor(input: ControllerCompactAnchorInput): string {
  const scope =
    input.projectSlug && input.taskKey
      ? `anchored to task \`${input.taskKey}\` in project \`${input.projectSlug}\``
      : input.projectSlug
        ? `bound to the project \`${input.projectSlug}\``
        : "instance-scoped: name the project when acting on a board";
  return [
    "# Context compacted — re-anchor before you continue",
    "",
    "Viberr compacted this conversation's context. Your system prompt, the tool " +
      "manifest and the knowledge-base indexes are unchanged; the exchange above is " +
      "a summary, and any tool result it does not mention is gone.",
    "",
    `Conversation: ${input.conversationId}, with ${input.userLabel}; ${scope}.`,
    "Every turn opens with a fresh server read of where the person is standing; trust " +
      "that read and your tools over the summary for anything that may have changed.",
    "Built-in diagnostics (viberr_ops) are still attached and read-only.",
    "If the person's last request depends on context the summary lost, say so " +
      "and ask rather than guessing.",
  ].join("\n");
}
