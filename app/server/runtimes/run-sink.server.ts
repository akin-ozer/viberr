import type { DatabaseSync } from "node:sqlite";
import type { LogLine, RunBackend, RunState } from "~/features/runtime/runtime-types";
import { logger } from "~/server/logging/logger.server";
import type { EmittedLine, RunExit, RunSpec } from "./adapter.server";
import { publishRunLogAppended, publishRunStateChanged } from "./run-events.server";
import { CREDENTIAL_ENV_RE } from "./runtime-registry.server";
import {
  appendRawLine,
  insertRunLine,
  nextSeq,
  patchRun,
} from "./run-store.server";

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
 * re-adds the SELECTED provider credential to the agent's child env
 * (`claudeSpawnEnv` / `codexSpawnEnv`), and Claude has no counterpart to Codex's
 * shell-env policy. So one `env`-printing tool call put that credential verbatim
 * into a member-visible console, the `{ } raw` toggle, and the persisted
 * `.jsonl` — the one concrete leak path PRD-8/NFR7 forbid.
 *
 * Two rules, both cheap enough to run per emitted line:
 *   1. exact values — every credential-shaped variable in THIS process's env
 *      (same regex the spawn filter uses), which by construction includes the
 *      values the app injected;
 *   2. token SHAPES — provider/PAT prefixes that are secrets wherever they came
 *      from (a PAT the agent minted itself, a key a human pasted into a prompt).
 *
 * Deliberately NOT a generic entropy heuristic: mangling ordinary output is a
 * worse failure than the leak. Nothing else is touched.
 */
const REDACTED = "[redacted]";

/**
 * Below this length a credential-shaped variable is a FLAG, not a secret
 * (`VIBERR_CLAUDE_USE_CLI_AUTH=1` matches the name regex). Redacting a 1-char
 * value would scrub every digit out of every log line.
 */
const MIN_SECRET_VALUE_LEN = 12;

/** Token shapes worth redacting on sight — anchored prefixes + a length floor,
 *  so ordinary prose ("sk-1", "gh_") is never touched. */
const TOKEN_SHAPE_SOURCE = [
  "gh[pousr]_[A-Za-z0-9]{16,}", // ghp_/gho_/ghu_/ghs_/ghr_ GitHub tokens
  "github_pat_[A-Za-z0-9_]{20,}", // fine-grained PAT
  "sk-[A-Za-z0-9_-]{16,}", // sk-ant-…, sk-proj-…, OpenAI/Anthropic keys
].join("|");

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build the redactor ONCE per run (in `createRunSink`), not per line: the
 * credential set is whatever this process holds when the run starts, which is
 * exactly what that run's child env received.
 */
export function createLineRedactor(
  env: NodeJS.ProcessEnv = process.env,
): (text: string) => string {
  const values = new Set<string>();
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string" || value.length < MIN_SECRET_VALUE_LEN) continue;
    if (!CREDENTIAL_ENV_RE.test(key)) continue;
    values.add(value);
  }
  // Longest first so a credential that contains another one is fully replaced.
  const literals = [...values].sort((a, b) => b.length - a.length).map(escapeRegExp);
  const re = new RegExp([...literals, TOKEN_SHAPE_SOURCE].join("|"), "g");
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
  return clean === json ? display : (JSON.parse(clean) as LogLine);
}

export function createRunSink(db: DatabaseSync, spec: RunSpec) {
  // Where the raw truth goes: requested backend dir + session id (or run id
  // until the session id lands). We buffer to the run-id file first, since
  // the session id arrives on the init/thread.started line — but to keep it
  // simple and stable we always write under the run id (deterministic path,
  // no rename churn), documented in the phase report.
  let effectiveBackend: RunBackend = spec.backend;
  let sessionId: string | null = spec.resumeSessionId ?? null;
  let started = false;

  // Running usage totals — usage envelopes are cumulative per turn for codex,
  // and aggregate on the final result for claude; we take the max/last so a
  // partial run never regresses the counter (tokens/cost from real envelopes
  // ONLY — no fabrication).
  let turns = 0;
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;
  let totalCostUsd: number | null = null;

  // P13-U-1: built once per run — see createLineRedactor.
  const redact = createLineRedactor();

  const publishState = (state: RunState) => {
    publishRunStateChanged({
      projectSlug: spec.projectSlug,
      taskKey: spec.taskKey,
      runId: spec.runId,
      threadId: spec.threadId,
      state,
    });
  };

  return {
    markRunning(startedAtIso?: string) {
      if (started) return;
      started = true;
      patchRun(db, spec.runId, {
        state: "running",
        startedAt: startedAtIso ?? new Date().toISOString(),
      });
      publishState("running");
    },

    phase(phase: string | null, step: string | null) {
      patchRun(db, spec.runId, { phase, step });
    },

    line(line: EmittedLine) {
      try {
        // Capture facts before persisting so the row reflects them.
        const f = line.facts;
        if (f.sessionId) sessionId = f.sessionId;
        if (typeof f.turns === "number" && f.turns > turns) turns = f.turns;
        if (f.usage) {
          inputTokens = Math.max(inputTokens, f.usage.input_tokens);
          cachedInputTokens = Math.max(cachedInputTokens, f.usage.cached_input_tokens);
          outputTokens = Math.max(outputTokens, f.usage.output_tokens);
        }
        if (typeof f.costUsd === "number") totalCostUsd = f.costUsd;

        // 0. P13-U-1: scrub injected credentials + token-shaped secrets BEFORE
        //    anything is persisted — the raw .jsonl and the DB row are both
        //    served to project members (`{ } raw` toggle, /resources/run-log).
        const raw = redact(line.raw);
        const display = line.display ? redactDisplay(line.display, redact) : null;

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
          totalCostUsd,
        });

        // 4. Publish the reference (only when a console line was produced).
        if (display) {
          publishRunLogAppended({
            projectSlug: spec.projectSlug,
            taskKey: spec.taskKey,
            runId: spec.runId,
            threadId: spec.threadId,
            seq,
          });
        }
      } catch (error) {
        logger.error("run line persist failed", {
          runId: spec.runId,
          err: error instanceof Error ? error : new Error(String(error)),
        });
      }
    },

    finalize(exit: RunExit, byInterrupt?: { userId: string }) {
      if (exit.sessionId) sessionId = exit.sessionId;
      const state: RunState =
        exit.outcome === "finished"
          ? "finished"
          : exit.outcome === "error"
            ? "error"
            : "interrupted";
      effectiveBackend = exit.effectiveBackend;
      patchRun(db, spec.runId, {
        state,
        finishedAt: new Date().toISOString(),
        sessionId,
        phase: null,
        step: null,
        ...(byInterrupt ? { interruptedBy: byInterrupt.userId } : {}),
      });
      publishState(state);
    },
  };
}
