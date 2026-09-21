import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { LogLine, RunBackend, RunState } from "~/features/runtime/runtime-types";
import { isDatabaseShuttingDown } from "~/server/db/sqlite.server";
import { logger } from "~/server/logging/logger.server";
import type { EmittedLine, RunExit, RunSpec } from "./adapter.server";
import {
  clearBackendQuotaExhaustion,
  parseQuotaResetAt,
  clearBackendCredentialRefusal,
  quotaExhaustionEvidence,
  recordBackendCredentialRefusal,
  recordBackendQuotaExhaustion,
  recordBackendRateLimit,
  providerSentence,
} from "./backend-quota.server";
import { PROVIDER_TEXT_MARKER } from "~/shared/provider-marker";
import { findUserById } from "~/server/auth/user-store.server";
import { controllerRunRoute } from "~/server/controller/controller-conversations.server";
import { publishRunLogAppended, publishRunStateChanged } from "./run-events.server";
import { CREDENTIAL_ENV_RE } from "./runtime-registry.server";
import {
  appendRawLine,
  insertRunLine,
  nextSeq,
  patchRun,
  type RunPatch,
  getRun,
} from "./run-store.server";
import {
  REDACTED,
  TOKEN_PATTERN_SOURCE,
} from "~/server/secrets/git-output-redact.server";
import { startTemperature } from "./context-policy.server";
import { noteRunCompaction } from "./run-context-events.server";

/** Terminal run states — reaching one is the run's final answer. */
const TERMINAL_STATES: readonly RunState[] = ["finished", "error", "interrupted"];

/**
 * F21-24: is the projection database gone for good?
 *
 * Shared, because every writer on the run path needs the SAME answer: the sink's
 * line/phase/finalize arms here, and anything that persists on a run's behalf
 * (see `launch` in run-service). A drained database is not a fault to report per
 * write — `getDb` refuses to reopen, the raw `.jsonl` still holds the stream, and
 * boot finalization recovers the run.
 */
export function runPersistDrained(db: DatabaseSync): boolean {
  return isDatabaseShuttingDown() || !db.isOpen;
}

/**
 * B-FD7: the FIRST terminal state a run reaches is its outcome.
 *
 * `finalize` used to overwrite the state unconditionally, so a run another
 * writer had already stamped `interrupted` (the "no live handle" path in
 * `interruptRun`, taken whenever the interrupting process is not the one
 * driving the adapter — the two-processes-one-data-root shape, or a stop issued
 * after a restart) came back as `finished`/`error` when the still-live adapter
 * exited. The recorded human intervention lost to a race with the thing it was
 * stopping. Precedence, not ordering, decides now.
 */
export function resolveTerminalState(
  current: RunState | null,
  desired: RunState,
): RunState {
  return current !== null && TERMINAL_STATES.includes(current) ? current : desired;
}

/** `agent_runs.state` as stored: the column's CHECK constraint admits exactly
 *  these five values, so anything else is not a lifecycle this code can reason
 *  about — and is treated like an unreadable row below. */
const storedRunStateSchema = z.enum([
  "queued",
  "running",
  "finished",
  "error",
  "interrupted",
] as const satisfies readonly RunState[]);

function currentRunState(db: DatabaseSync, runId: string): RunState | null {
  try {
    const row = db.prepare(`SELECT state FROM agent_runs WHERE id = ?`).get(runId);
    const parsed = storedRunStateSchema.safeParse(row?.state);
    return parsed.success ? parsed.data : null;
  } catch {
    // An unreadable row must not stop a run from finalizing; the desired state
    // is then the best information available.
    return null;
  }
}

/** The `err` tag marking a run whose DB projection is missing lines the raw
 *  `.jsonl` has. Mirrors `run·session_missing`: a durable classified line, no
 *  column, no migration. */
export const LINE_LOST_TAG = "run·line_lost";

/**
 * The RunSink turns adapter callbacks into durable state + live SSE. For
 * every emitted line it: (1) redacts secrets from the line (P13-U-1),
 * (2) appends the raw envelope to the canonical .jsonl (truth), (3) inserts a
 * run_log_lines row with the computed display_json, (4) folds
 * usage/cost/turns/session facts into the run row, THEN (5) publishes
 * `run.log-appended` {runId, seq}. Lifecycle transitions publish
 * `run.state-changed`.
 *
 * Ordering matters: persist BEFORE publish, so a client that reacts to the
 * event can always fetch the line it references.
 */

// -------------------------------------------------- output-side redaction

/**
 * P13-U-1: the sink is the ONE place every run-log line passes through, so it
 * is where output-side secret redaction belongs.
 *
 * Input-side isolation is already real — `filteredSpawnEnv` strips every
 * credential-shaped variable from both spawn envs (F10-02) and Codex runs with
 * `shell_environment_policy.inherit: "core"`. But the app then deliberately
 * re-adds ONE credential to the agent's child env: the credential principal's
 * own (`runCredentialFor`, ruling 127). Claude has no counterpart to Codex's
 * shell-env policy, so one `env`-printing tool call put that credential
 * verbatim into a member-visible console, the `{ } raw` toggle, and the
 * persisted `.jsonl` — the one concrete leak path PRD-8/NFR7 forbid. Since
 * ruling 127 it is somebody's PERSONAL key, which makes the leak worse: the
 * people who can read a task's run console are not the person paying for it.
 *
 * Three rules, all cheap enough to run per emitted line:
 *   1. the run's OWN secrets — the plaintext `runCredentialFor` put in the
 *      child env, passed in as `opts.secrets` because it is sealed in the
 *      database and never appears in this process's environment;
 *   2. exact values — every credential-shaped variable in THIS process's env
 *      (same regex the spawn filter uses);
 *   3. token PATTERNS — provider/PAT prefixes that are secrets wherever they
 *      came from (a PAT the agent minted itself, a key a human pasted into a
 *      prompt).
 *
 * Deliberately NOT a generic entropy heuristic: mangling ordinary output is a
 * worse failure than the leak. Nothing else is touched.
 *
 * `REDACTED` and the token PATTERNS are the single canonical copy in
 * `git-output-redact.server` (which scrubs git's own output the same way); this
 * run-log path imports them so the two can never drift.
 */

/**
 * Below this length a credential-shaped variable is a FLAG, not a secret
 * (`GIT_TERMINAL_PROMPT=0` matches the name regex). Redacting a 1-char value
 * would scrub every digit out of every log line.
 */
const MIN_SECRET_VALUE_LEN = 12;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build the redactor ONCE per run (in `createRunSink`), not per line: the
 * credential set is whatever this process holds when the run starts, plus the
 * PER-RUN secrets the run service resolved for this run's credential principal
 * — which together are exactly what that run's child env received.
 *
 * `extraSecrets` is the ruling-127 half and the load-bearing one now. A
 * personal API key lives sealed in `user_backend_credentials`, never in this
 * process's env, so the env sweep alone would not know it — and a run billed to
 * person A would then print person A's key verbatim into a member-visible
 * console the first time the model ran `env`. `runCredentialFor` hands the
 * plaintext to the spawn env and the SAME value here, so the two can never
 * disagree about what must not be shown.
 */
export function createLineRedactor(
  env: NodeJS.ProcessEnv = process.env,
  extraSecrets: readonly string[] = [],
): (text: string) => string {
  const values = new Set<string>();
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || value.length < MIN_SECRET_VALUE_LEN) continue;
    if (!CREDENTIAL_ENV_RE.test(key)) continue;
    values.add(value);
  }
  for (const secret of extraSecrets) {
    // The same floor as the env sweep: a value too short to be a credential
    // would scrub ordinary output, and no provider issues one.
    if (secret.length >= MIN_SECRET_VALUE_LEN) values.add(secret);
  }
  // Longest first so a credential that contains another one is fully replaced.
  const literals = [...values].sort((a, b) => b.length - a.length).map(escapeRegExp);
  const re = new RegExp([...literals, TOKEN_PATTERN_SOURCE].join("|"), "g");
  // `replace` with a /g regex always scans from 0 and returns the SAME string
  // when nothing matched — so the no-secret path costs one scan and no alloc.
  return (text: string) => (text ? text.replace(re, REDACTED) : text);
}

/**
 * Redact the display projection by serializing it once. The marker carries no
 * quote or backslash, so the JSON stays parseable; an unchanged string skips
 * the parse entirely.
 */
function redactDisplay(
  display: LogLine,
  redact: (text: string) => string,
): LogLine {
  const json = JSON.stringify(display);
  const clean = redact(json);
  // SAFETY: `clean` is `display`'s own serialization with secret substrings —
  // which only ever occur INSIDE its string values — swapped for a marker
  // carrying no quote or backslash. The document structure is therefore
  // untouched, so what parses back is the same LogLine with shorter strings.
  return clean === json ? display : (JSON.parse(clean) as LogLine);
}

/** Per-run sink options. */
/** What `foldRolloutStats` takes: the rollout figures a Codex run learns at
 *  finalize (`codexRolloutRunStats`), the first call optional so a caller with
 *  only the sizes can still fold them. */
export interface RolloutStats {
  peakPromptTokens: number;
  lastPromptTokens: number;
  compactions: number;
  /** The rollout's compactions with their sizes; the sink audits and notes
   *  every one beyond what the stream already carried (Codex SDK 0.153
   *  streams no compaction item at all, measured live 2026-09-21). */
  compactionEvents?: { preTokens: number; postTokens: number }[];
  firstCall?: { promptTokens: number; cacheRead: number; cacheWrite: number } | null;
}

export interface RunSinkOptions {
  /** Ruling 127: the plaintext credentials this run's child env carries, from
   *  `runCredentialFor`. Redacted from every persisted line and SSE payload. */
  secrets?: readonly string[];
  /** The data root the compaction note writes under (tests). */
  dataRoot?: string;
}

export function createRunSink(
  db: DatabaseSync,
  spec: RunSpec,
  opts: RunSinkOptions = {},
) {
  // Where the raw truth goes: requested backend dir + session id (or run id
  // until the session id lands). We buffer to the run-id file first, since
  // the session id arrives on the init/thread.started line — but to keep it
  // simple and stable we always write under the run id (deterministic path,
  // no rename churn), documented in the phase report.
  let effectiveBackend: RunBackend = spec.backend;
  let sessionId: string | null = spec.resumeSessionId ?? null;
  let started = false;

  // Running usage totals. Both adapters emit CUMULATIVE figures (Codex's
  // turn.completed carries the thread's running total; the Claude adapter sums
  // its distinct API calls, and the result envelope then carries the SDK's own
  // total), so max per field keeps the row monotone and lets the final figure
  // win (tokens/cost from real envelopes ONLY — no fabrication).
  //
  // F35-1: output is the exception. The Claude adapter's live figure is an
  // ESTIMATE from the streamed text (`outputEstimated: true`), folded by max
  // like the rest; a provider figure (a Claude result, a Codex turn.completed)
  // REPLACES it, because an estimate may overshoot and max would then keep the
  // wrong number for good. `usageFinal` records that a provider figure landed
  // (`agent_runs.usage_final`): the projection prints the row as an estimate
  // until it does, and Insights leaves the row out of its token totals.
  let turns = 0;
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;
  let usageFinal = false;
  let totalCostUsd: number | null = null;

  // Ruling 369: the prompt-cache record, folded from `facts.cache` — one fact
  // per model call on Claude (the adapter strips a message's repeat
  // envelopes), one per turn on Codex. The first fact is the run's FIRST
  // CALL; the write sums; the peak and the last fold only from per-call
  // figures (a Codex turn total is not a prompt size); the TTL bucket reads
  // off the provider's split of each write; compactions count the boundary
  // facts. Everything lands on the row with the token counters below.
  let cacheWriteTokens = 0;
  let firstCall: RunPatch | null = null;
  let peakPromptTokens = 0;
  let lastPromptTokens = 0;
  let sawFiveMinute = false;
  let sawOneHour = false;
  let compactions = 0;
  const cachePatch = (): RunPatch => ({
    cacheWriteTokens,
    peakPromptTokens,
    lastPromptTokens,
    compactions,
    cacheTtlBucket:
      sawFiveMinute && sawOneHour ? "mixed" : sawFiveMinute ? "5m" : sawOneHour ? "1h" : null,
    ...firstCall,
  });

  // P13-U-1: built once per run — see createLineRedactor. `opts.secrets` is the
  // principal's own credential (ruling 127), which lives sealed in the database
  // rather than in this process's env, so the env sweep could not find it.
  const redact = createLineRedactor(process.env, opts.secrets ?? []);
  // Ruling 130(d): whose account this run bills, for the quota and credential
  // observation records (ruling 127: a run bills one person's credential).
  const runRow = getRun(db, spec.runId);
  const principal = (() => {
    const userId = runRow?.credential_user_id ?? null;
    if (!userId) return { credentialUserId: null, credentialLabel: null };
    const user = findUserById(db, userId);
    return { credentialUserId: userId, credentialLabel: user ? user.name || user.email : null };
  })();
  /** Ruling 369: the name the compaction note calls the agent by. */
  const agentName = runRow?.agent_name ?? null;

  // Ruling 99: a controller turn's frames route to its conversation owner (it
  // has no task scope to route on). Resolved once per run, like the principal.
  const controller =
    spec.kind === "controller"
      ? controllerRunRoute(db, { kind: spec.kind, task_key: spec.taskKey })
      : null;

  const publishState = (state: RunState) => {
    publishRunStateChanged({
      projectSlug: spec.projectSlug,
      taskKey: spec.taskKey,
      runId: spec.runId,
      threadId: spec.threadId,
      state,
      controller,
    });
  };

  /**
   * F21-24: the database is CLOSED under us (graceful shutdown drained while
   * this run streamed).
   *
   * Live (UC-31, `docker restart` mid-Codex-run) the pipeline kept a stale
   * handle and sprayed ~10 "run line persist failed" + "divergence marker could
   * not be persisted" errors, one pair per streamed line — noise that says the
   * same thing ten times and buries the one fact that matters. It is not a
   * per-line fault and there is nothing to retry: the run is finalized at boot
   * ("finalized non-terminal runs at boot"), and the raw `.jsonl` — a plain
   * append, unaffected by the database — still holds the full stream.
   */
  const persistDrained = () => runPersistDrained(db);
  /** The ONE line this run logs about the drain, however much it loses. */
  let drainWarned = false;
  const warnDrainedOnce = () => {
    if (drainWarned) return;
    drainWarned = true;
    logger.warn(
      "the database closed mid-run — run rows and lines are no longer being persisted; the raw transcript is intact and the run is finalized at boot",
      { runId: spec.runId, taskKey: spec.taskKey },
    );
  };
  /**
   * Run `write` unless the database is already drained, and treat a failure that
   * IS the drain as the drain rather than as a fault.
   *
   * The line path had this from the start; `phase` and `finalize` did not, so a
   * shutdown mid-run still sprayed "run phase persist failed" — one per streamed
   * phase, from `launch`'s own catch — which is the same noise F21-24 removed one
   * arm of. The check runs twice on purpose: before the write (the common case,
   * where nothing is attempted at all) and again after a throw (the database
   * closed between the two). Returns whether the row was actually written, so a
   * caller does not publish an SSE state for a row that does not carry it.
   */
  const persistOrDrain = (write: () => void): boolean => {
    if (persistDrained()) {
      warnDrainedOnce();
      return false;
    }
    try {
      write();
      return true;
    } catch (error) {
      if (persistDrained()) {
        warnDrainedOnce();
        return false;
      }
      throw error;
    }
  };

  /**
   * B-FD7: a persist failure used to be logged to stdout and nothing else — the
   * console silently missed a line the raw `.jsonl` has, while the footer count
   * (read from the DB) claimed completeness. Record the divergence ON the run,
   * once, so a reader of the log sees that it is incomplete. Best-effort by
   * construction: the failure we are reporting may be the same one that stops
   * us reporting it.
   */
  let divergenceReported = false;
  const markDivergent = (cause: unknown) => {
    if (divergenceReported) return;
    // A drained database cannot take the marker either — writing it would only
    // produce the second half of the per-line error pair.
    if (persistDrained()) {
      divergenceReported = true;
      return;
    }
    divergenceReported = true;
    const now = new Date().toISOString();
    const text =
      "At least one line of this run could not be written to the projection database, so this console is INCOMPLETE — the run's raw .jsonl transcript under the data root holds the full stream.";
    const raw = JSON.stringify({
      type: "error",
      source: "viberr",
      reason: "line_lost",
      message: text,
      cause: cause instanceof Error ? cause.message : String(cause),
    });
    try {
      appendRawLine(effectiveBackend, spec.runId, raw);
    } catch {
      // The raw file is the failing half in this branch — the DB marker below
      // is then the only surface left.
    }
    try {
      const seq = nextSeq(db, spec.runId);
      insertRunLine(db, {
        runId: spec.runId,
        seq,
        occurredAt: now,
        raw,
        display: { t: now.slice(11, 19), ev: "err", tag: LINE_LOST_TAG, text },
      });
      publishRunLogAppended({
        projectSlug: spec.projectSlug,
        taskKey: spec.taskKey,
        runId: spec.runId,
        threadId: spec.threadId,
        seq,
        controller,
      });
    } catch (error) {
      logger.error("run divergence marker could not be persisted", {
        runId: spec.runId,
        err: error instanceof Error ? error : new Error(String(error)),
      });
    }
  };

  return {
    markRunning(startedAtIso?: string) {
      if (started) return;
      started = true;
      const written = persistOrDrain(() => {
        patchRun(db, spec.runId, {
          state: "running",
          startedAt: startedAtIso ?? new Date().toISOString(),
        });
      });
      if (written) publishState("running");
    },

    phase(phase: string | null, step: string | null) {
      persistOrDrain(() => {
        patchRun(db, spec.runId, { phase, step });
      });
    },

    line(line: EmittedLine) {
      try {
        // Capture facts before persisting so the row reflects them.
        const f = line.facts;
        if (f.sessionId) sessionId = f.sessionId;
        if (f.turns != null && f.turns > turns) turns = f.turns;
        if (f.usage) {
          // The Claude adapter's live sum over distinct API calls equalled the
          // result's input on every stored run. A non-empty result BELOW the
          // live sum is the one signature of a double-counting live fold (an
          // SDK that stopped sending `message.id`), and max would then keep
          // the larger, wrong number: say so.
          if (f.isResult && f.usage.input_tokens > 0 && f.usage.input_tokens < inputTokens) {
            logger.warn("run usage: the result's input is below the live sum", {
              runId: spec.runId,
              live: inputTokens,
              result: f.usage.input_tokens,
            });
          }
          inputTokens = Math.max(inputTokens, f.usage.input_tokens);
          cachedInputTokens = Math.max(cachedInputTokens, f.usage.cached_input_tokens);
          if (f.usage.outputEstimated) {
            outputTokens = Math.max(outputTokens, f.usage.output_tokens);
          } else if (
            f.usage.input_tokens > 0 ||
            f.usage.cached_input_tokens > 0 ||
            f.usage.output_tokens > 0
          ) {
            // The provider's own figure replaces the estimate. An EMPTY usage
            // (an errored result that never reached the API) reports nothing
            // and leaves both the estimate and `usageFinal` alone.
            outputTokens = f.usage.output_tokens;
            usageFinal = true;
          }
        }
        if (f.costUsd != null) totalCostUsd = f.costUsd;
        // Ruling 376: the completion compaction's own call lands after the
        // run's result, so its cost and tokens ADD to the recorded figures.
        if (f.costAddUsd != null) totalCostUsd = (totalCostUsd ?? 0) + f.costAddUsd;
        if (f.usageAdd) {
          inputTokens += f.usageAdd.input_tokens;
          cachedInputTokens += f.usageAdd.cached_input_tokens;
          outputTokens += f.usageAdd.output_tokens;
        }
        // Ruling 369: fold the call's cache figures (see `cachePatch`).
        if (f.cache) {
          cacheWriteTokens += f.cache.cacheWrite;
          if (firstCall === null) {
            firstCall = {
              firstCallPromptTokens: f.cache.promptTokens,
              firstCallCacheWrite: f.cache.cacheWrite,
              firstCallCacheRead: f.cache.cacheRead,
              firstCallWarm: startTemperature(f.cache.cacheWrite, f.cache.cacheRead) === "warm" ? 1 : 0,
              firstCallMissReason: f.cache.missReason,
            };
          }
          if (f.cache.perCall) {
            lastPromptTokens = f.cache.promptTokens;
            if (f.cache.promptTokens > peakPromptTokens) peakPromptTokens = f.cache.promptTokens;
          }
          if (f.cache.ttl) {
            if (f.cache.ttl.fiveMinute > 0) sawFiveMinute = true;
            if (f.cache.ttl.oneHour > 0) sawOneHour = true;
          }
        }
        // Ruling 369: a compaction is counted on the row and noted on the task
        // — the audit row and the timeline note are how a supervisor sees
        // that the agent's context was replaced with a summary. Best-effort
        // by construction, and never on the line's own persist path.
        if (f.compaction) {
          compactions += 1;
          // What a resume replays now is the summary, not the history the
          // compaction folded: the last prompt is the post size until the
          // next call says otherwise (ruling 372 reads it; ruling 376 sets it
          // at the end of the run).
          if (f.compaction.postTokens !== null && f.compaction.postTokens > 0) {
            lastPromptTokens = f.compaction.postTokens;
          }
          try {
            noteRunCompaction(db, spec, agentName, f.compaction, line.occurredAt, opts.dataRoot);
          } catch (error) {
            logger.error("compaction audit failed", {
              runId: spec.runId,
              err: error instanceof Error ? error : new Error(String(error)),
            });
          }
        }
        // Backend quota telemetry (pass 29): a rate_limit_event's reading is
        // folded into the instance-wide store so approaching exhaustion is
        // visible on /insights BEFORE a run fails on it. `recordBackendRateLimit`
        // is internally best-effort — it can never fail this persist path.
        if (f.rateLimit) {
          recordBackendRateLimit(db, effectiveBackend, {
            ...f.rateLimit,
            observedAt: line.occurredAt,
            ...principal,
          });
        }

        // 0. P13-U-1: scrub injected credentials + token-shaped secrets BEFORE
        //    anything is persisted — the raw .jsonl and the DB row are both
        //    served to project members (`{ } raw` toggle, /resources/run-log).
        const raw = redact(line.raw);
        const display = line.display ? redactDisplay(line.display, redact) : null;

        // D5 (pass 31): the OTHER half of quota telemetry. The live
        // `rate_limit_event` channel above is Claude-only, so an already-spent
        // Codex subscription produced no reading at all and /insights read "no
        // reading yet" for a backend that had been refusing every run for days
        // — with the reset date sitting in the failure the human just read.
        //
        // Both adapters classify their own failure and ride the class on the
        // err line's tag as `·quota` (the same structured channel
        // `runFailureReason` routes on), so the CLASS is the entry condition —
        // never a regex over the whole line. Recorded off the REDACTED display:
        // this sentence is stored and rendered on an admin page, and the raw
        // form has not been scrubbed yet at this point in the function.
        //
        // V4 (pass 31): the class alone is not sufficient, though. Both
        // classifiers fold transient rate limiting (`rate limit`, `too many
        // requests`, `429`) into `quota` alongside a genuinely spent
        // subscription window, and a momentary 429 names no reset instant — so
        // it was recorded as exhaustion that nothing retired, and the panel
        // read "usage limit reached" at 100% indefinitely. The provider's own
        // sentence (only that half of the line, never the adapter's canonical
        // prose) has to evidence a usage window before this store hears about
        // it — see `quotaExhaustionEvidence`.
        // Ruling 130(d): the gate is the REJECTION, structured or in the
        // provider's own words. A rejected rate-limit reading attached to the
        // line (`failure.windowRejected`) is the provider declaring the window
        // spent even when its sentence names no limit word; a transient 429
        // whose reading was merely `allowed` still records nothing. Only the
        // provider half of the line is stored and rendered, never the
        // adapter's canonical remedy or the marker.
        if (display?.tag?.endsWith("·quota") && display.text) {
          const facts = display.failure ?? null;
          // The provider's own words are judged only when the line carries
          // them behind the marker: without one the whole line is the
          // adapter's canonical sentence, which names "usage quota" for every
          // member of the class and must never satisfy its own gate.
          const hasMarker = display.text.includes(PROVIDER_TEXT_MARKER);
          const evidence = hasMarker ? quotaExhaustionEvidence(display.text) : null;
          if (facts?.windowRejected || evidence) {
            const providerText =
              evidence ??
              (hasMarker
                ? providerSentence(display.text)
                : `${(facts?.window ?? "usage").replace(/_/g, " ")} window rejected by the provider`);
            const exactReset =
              facts?.resetsAt && Number.isFinite(Date.parse(facts.resetsAt))
                ? { at: Math.round(Date.parse(facts.resetsAt) / 1000), precision: "exact" as const }
                : null;
            const reset = exactReset ?? parseQuotaResetAt(providerText, line.occurredAt);
            recordBackendQuotaExhaustion(db, effectiveBackend, {
              resetsAt: reset?.at ?? null,
              resetsAtPrecision: reset?.precision ?? null,
              providerText,
              runId: spec.runId,
              observedAt: line.occurredAt,
              ...principal,
            });
          }
        }
        // F32-4 (pass 32): the credential half. Both classifiers tag a
        // rejected key/token/refresh-token as `·auth`; the presence-only
        // availability signals (`backends`, `userBackendHealth`) cannot
        // see it, so the refusal is recorded off the same structured class the
        // quota flag rides, with the provider's sentence as its evidence.
        if (display?.tag?.endsWith("·auth") && display.text) {
          recordBackendCredentialRefusal(db, effectiveBackend, {
            providerText: providerSentence(display.text),
            runId: spec.runId,
            observedAt: line.occurredAt,
            ...principal,
          });
        }

        // 1. Raw truth (append-only .jsonl).
        appendRawLine(effectiveBackend, spec.runId, raw);

        // 2. DB projection row.
        const seq = nextSeq(db, spec.runId);
        if (display) {
          insertRunLine(db, {
            runId: spec.runId,
            seq,
            occurredAt: line.occurredAt,
            raw,
            display,
          });
        }

        // 3. Fold facts into the run row.
        patchRun(db, spec.runId, {
          sessionId,
          turns,
          inputTokens,
          cachedInputTokens,
          outputTokens,
          usageFinal: usageFinal ? 1 : 0,
          totalCostUsd,
          ...cachePatch(),
        });

        // 4. Publish the reference (only when a console line was produced).
        if (display) {
          publishRunLogAppended({
            projectSlug: spec.projectSlug,
            taskKey: spec.taskKey,
            runId: spec.runId,
            threadId: spec.threadId,
            seq,
            controller,
          });
        }
      } catch (error) {
        // F21-24: shutdown drain, not a fault — ONE warning for the whole run,
        // then silence. Anything else keeps the per-line error, which is the
        // signal that a genuine persist failure needs.
        if (persistDrained()) {
          warnDrainedOnce();
          return;
        }
        logger.error("run line persist failed", {
          runId: spec.runId,
          err: error instanceof Error ? error : new Error(String(error)),
        });
        markDivergent(error);
      }
    },

    /**
     * Ruling 369: figures learned AFTER the stream ended — a Codex run's
     * per-call prompt sizes and compactions, which its SDK never streams and
     * the run service reads off the rollout once the CLI has exited. Folded by
     * max so nothing a streamed fact already established is lowered; the
     * last prompt is the rollout's own answer when it has one.
     */
    foldRolloutStats(stats: RolloutStats) {
      if (stats.peakPromptTokens > peakPromptTokens) peakPromptTokens = stats.peakPromptTokens;
      if (stats.lastPromptTokens > 0) lastPromptTokens = stats.lastPromptTokens;
      // Every compaction the rollout knows and the stream did not carry gets
      // the same governed record a streamed one gets (ruling 369(d)): the
      // audit row and the task's timeline note, sizes from the rollout.
      const events = stats.compactionEvents ?? [];
      for (const event of events.slice(compactions)) {
        try {
          noteRunCompaction(
            db,
            spec,
            agentName,
            { trigger: "auto", preTokens: event.preTokens, postTokens: event.postTokens },
            new Date().toISOString(),
            opts.dataRoot,
          );
        } catch (error) {
          logger.error("compaction audit failed", {
            runId: spec.runId,
            err: error instanceof Error ? error : new Error(String(error)),
          });
        }
      }
      if (stats.compactions > compactions) compactions = stats.compactions;
      // The run's real first REQUEST: a Codex turn total (the streamed fact)
      // sums every call of the turn, so its "first call" read a whole turn's
      // cache hits. The rollout's first `token_count` is one request, and the
      // start chip and Insights' warm rate speak about that.
      if (stats.firstCall) {
        firstCall = {
          firstCallPromptTokens: stats.firstCall.promptTokens,
          firstCallCacheWrite: stats.firstCall.cacheWrite,
          firstCallCacheRead: stats.firstCall.cacheRead,
          firstCallWarm:
            startTemperature(stats.firstCall.cacheWrite, stats.firstCall.cacheRead) === "warm" ? 1 : 0,
          firstCallMissReason: null,
        };
      }
      persistOrDrain(() => {
        patchRun(db, spec.runId, cachePatch());
      });
    },

    finalize(exit: RunExit, byInterrupt?: { userId: string }) {
      if (exit.sessionId) sessionId = exit.sessionId;
      // F21-24: a run that reaches its exit AFTER the drain has nothing to
      // record — boot finalization stamps its terminal state from the row it
      // finds. Publishing an SSE state for it would be a claim about a row that
      // was never written, so the whole arm is skipped, not just the write.
      if (persistDrained()) {
        warnDrainedOnce();
        return;
      }
      const desired: RunState =
        exit.outcome === "finished"
          ? "finished"
          : exit.outcome === "error"
            ? "error"
            : "interrupted";
      effectiveBackend = exit.effectiveBackend;
      // B-FD7: never demote an already-terminal run. Another writer (a human's
      // interrupt taking the no-live-handle path) got there first and its
      // finish time is the real one, so neither the state nor `finishedAt` is
      // restamped; the facts this exit carries (session id) still land.
      const current = currentRunState(db, spec.runId);
      const state = resolveTerminalState(current, desired);
      if (state !== desired) {
        logger.warn("run already terminal at finalize — keeping the recorded outcome", {
          runId: spec.runId,
          recorded: state,
          adapterOutcome: desired,
        });
      }
      const patch: RunPatch = { state, sessionId, phase: null, step: null };
      // Only the writer whose outcome WON stamps the finish time — the recorded
      // one already carries the real instant (B-FD7 above).
      if (state === desired) patch.finishedAt = new Date().toISOString();
      if (byInterrupt) patch.interruptedBy = byInterrupt.userId;
      const written = persistOrDrain(() => {
        patchRun(db, spec.runId, patch);
      });
      // D5: a run that COMPLETED on this backend is proof the account is not
      // refusing work any more — the real run IS the re-probe (ruling 19), so
      // the exhaustion flag is retired here rather than by a synthetic check.
      // Only on `finished`: an interrupted or errored run proves nothing.
      if (written && state === "finished") {
        clearBackendQuotaExhaustion(db, effectiveBackend);
        // F32-4: the same completed run proves the credential is accepted.
        clearBackendCredentialRefusal(db, effectiveBackend);
      }
      if (written) publishState(state);
    },
  };
}
