import type { RunBackend, RunKind } from "~/features/runtime/runtime-types";
import type { CredentialKind } from "./backend-credentials.server";

/**
 * Ruling 370: ONE home for every number that decides how much context a run
 * carries, when it is compacted, how long its prompt cache is assumed to live,
 * and when a resume is refused in favour of a fresh session — on both backends,
 * for all three run kinds. Nothing else in the tree may spell one of these
 * figures; the adapters, the run service, the sink and the docs all read them
 * here. The measurements behind them are in the ruling text.
 *
 * A leaf module on purpose (types only from elsewhere): both adapters, the run
 * service and the insights query import it, and it must never import them.
 */

/** The backends that actually run a model (the type in runtime-types also
 *  names "codex" and "claude"; this alias keeps the tables below readable). */
export type ContextBackend = RunBackend;

/**
 * The context window past which the CLI is asked to compact MID-RUN, per
 * backend and run kind. Every entry is `null` since ruling 376 (owner,
 * 2026-09-21, "drop it, model default"): the CLI compacts at its model's own
 * limit (near 967k on a native-1M Claude model, near the 258k window on
 * Codex), and the size a session carries between runs is bounded by
 * `COMPACT_AT_COMPLETION_TOKENS` below instead. Measured on the 25-call runs
 * of 2026-09-21: a 250k window held cache reads to 2.4M where the model's own
 * limit would have read about 7M, but the writes (574k) — the run's real cost
 * — are the same either way, and a mid-run summary drops in-run detail.
 *
 * The table stays so the decision has one place to be reversed; a non-null
 * entry is what `contextWindowEnv` (Claude, `CLAUDE_CODE_AUTO_COMPACT_WINDOW`)
 * and `codexCompactionConfig` (Codex, `model_auto_compact_token_limit` with
 * scope `total`) would carry again.
 */
const AUTO_COMPACT_WINDOW = {
  claude: { operator: null, primary: null, reviewer: null, controller: null },
  codex: { operator: null, primary: null, reviewer: null, controller: null },
} as const satisfies Record<ContextBackend, Record<RunKind, number | null>>;

/** The env key the Claude CLI reads a mid-run window from (see `contextWindowEnv`). */
export const CLAUDE_AUTO_COMPACT_WINDOW_ENV = "CLAUDE_CODE_AUTO_COMPACT_WINDOW";

/** The mid-run window for one run, or null when the CLI's default stands. */
function autoCompactWindow(backend: ContextBackend, kind: RunKind): number | null {
  return AUTO_COMPACT_WINDOW[backend][kind];
}

/**
 * The env overlay a Claude run carries for its mid-run window: exactly one key
 * when the kind has a window, nothing otherwise (nothing, since ruling 376).
 * Codex takes its window through `config.toml` keys (`codexCompactionConfig`),
 * never the environment.
 */
export function contextWindowEnv(backend: ContextBackend, kind: RunKind): Record<string, string> {
  if (backend !== "claude") return {};
  const window = autoCompactWindow(backend, kind);
  return window === null ? {} : { [CLAUDE_AUTO_COMPACT_WINDOW_ENV]: String(window) };
}

/**
 * The Codex CLI config keys a kind carries: the shared compaction prompt on
 * every specialist and controller run (it steers the mid-run compaction at
 * the model's own limit AND the completion compaction of ruling 376, both of
 * which the CLI summarizes), plus the limit and its scope only for a kind
 * with a mid-run window (none, since ruling 376). Empty for the operator, so
 * nothing is written that a reader could mistake for a decision.
 */
export interface CodexCompactionConfig {
  model_auto_compact_token_limit: number;
  model_auto_compact_token_limit_scope: "total";
  compact_prompt: string;
}

export function codexCompactionConfig(kind: RunKind): Partial<CodexCompactionConfig> {
  if (kind === "operator") return {};
  const window = autoCompactWindow("codex", kind);
  const config: Partial<CodexCompactionConfig> = { compact_prompt: CODEX_COMPACT_PROMPT };
  if (window !== null) {
    config.model_auto_compact_token_limit = window;
    config.model_auto_compact_token_limit_scope = "total";
  }
  return config;
}

/**
 * Ruling 376 (owner, 2026-09-21): a session whose last prompt is larger than
 * this is compacted at the END of its run, while its prefix is still in the
 * provider's cache — one warm full-history read plus a summary, instead of a
 * cold replay of the whole history on the next resume (200k written at the
 * 1-hour rate is $6; the compaction is about $0.70 and every later call reads
 * ~20k instead of ~200k). The session keeps its memory as the summary and
 * stays resumable; ruling 372's fresh start is the backstop for a large
 * session that never got compacted. 100k, the owner's number: the specialist
 * median peak is 108k, so the typical long run is compacted once, at its end.
 * Applies to a run that finished or errored; an interrupted run is left alone
 * (the person asked for the spending to stop).
 */
export const COMPACT_AT_COMPLETION_TOKENS = 100_000;

/**
 * Ruling 701: how long a completion compaction may take before the run service
 * stops waiting for it. The session then stays as large as it was (ruling 372
 * is its backstop), the compaction's process is stopped, and a run held for
 * that session starts. Measured compactions took one to two and a half
 * minutes; Codex's own exchange gives up at five.
 */
export const COMPLETION_COMPACT_DEADLINE_MS = 10 * 60 * 1000;

/**
 * What the completion compaction asks the summarizer to keep — the same
 * facts `CODEX_COMPACT_PROMPT` names, as the argument of Claude's `/compact`.
 * Skills and knowledge bases need no instruction: the persona and the
 * knowledge-base indexes live in the recorded system prompt, which no
 * compaction touches, and the CLI re-injects the skills the run invoked.
 */
export const COMPLETION_COMPACT_INSTRUCTIONS =
  "This run has finished; summarize it for the agent that resumes this session later. Keep, " +
  "verbatim where short: the task key and title; the canonical task.md path; the branch and " +
  "the pull request; the knowledge bases attached and that read_knowledge_doc re-reads them; " +
  "every decision taken and its reason; every attempt that failed and why; the pending work " +
  "in order; the files changed and the commands run with their exit codes; the last report " +
  "posted. Drop tool output and reasoning.";

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

// ------------------------------------------- what Insights measures them by

/**
 * Ruling 505: OpenAI's documented extended prompt-cache retention (24 hours,
 * research S16). The Codex rows of `CACHE_TTL_MS` stay at ten minutes "until
 * measured"; this is the retention the measurement looks for. If Codex resumes
 * idle past ten minutes read their prefix back, the Codex TTL moves toward it.
 */
export const EXTENDED_CACHE_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * Ruling 505: the idle edges Insights sorts resumes by, ascending: every TTL
 * `CACHE_TTL_MS` assumes (five minutes, ten, an hour) and then the extended
 * retention. Derived rather than spelled, so a TTL the table gains or loses
 * moves the edges with it. Each bucket then says whether the sessions resumed
 * that long after their last run read their prefix back, which is the fact
 * ruling 372's verdict assumes and PLAN.md's Codex retention probe asked for.
 */
export const RESUME_IDLE_EDGES_MS: readonly number[] = [
  ...new Set(Object.values(CACHE_TTL_MS).flatMap((byKind): number[] => Object.values(byKind))),
  EXTENDED_CACHE_RETENTION_MS,
].sort((a, b) => a - b);

/**
 * Ruling 505: how close together two operator starts must be for the second to
 * count as part of a burst. A cache entry exists only once the first response
 * has begun, so an operator run that starts while another of the same prefix
 * (same project, seat and model) is still waiting for its first response writes
 * the prefix again. The operator's first response begins seconds after its
 * start (spawn, server handshakes, one request); a minute bounds that
 * generously, so the cold starts it counts are the most a gate serializing
 * those first calls could save. PLAN.md (PR 5) said to count them before
 * building that gate.
 */
export const OPERATOR_BURST_WINDOW_MS = 60 * 1000;

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
    "# Context compacted: re-anchor before you continue",
    "",
    "Viberr compacted this session's context. Your persona and the knowledge-base " +
      "indexes in your system prompt are unchanged; the conversation above is a " +
      "summary, and any tool output it does not mention is gone.",
    "",
    `Task: ${input.taskKey}, "${input.title}"`,
    `Canonical task file: ${input.taskMdPath}. Re-read it before you act; it is the truth, the summary is not.`,
    input.branch ? `Branch: \`${input.branch}\`` : "Branch: none allocated yet",
    input.pr
      ? `Pull request: #${input.pr.number}${input.pr.url ? ` (${input.pr.url})` : ""}`
      : "Pull request: none opened yet",
    input.kb.length
      ? `Knowledge bases: ${input.kb.join(", ")}. Read a document again with read_knowledge_doc; nothing in the summary replaces it.`
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
    "# Context compacted: re-anchor before you continue",
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
