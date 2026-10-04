import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { logger } from "~/server/logging/logger.server";
import type { RealBackend } from "./runtime-registry.server";

/**
 * R20-3 (F20-4): which models the PROVIDER refused for this deployment's
 * account, learned from REAL run failures — never a synthetic probe.
 *
 * The live F20-4 failure was a Codex model/account mismatch: a 400
 * invalid_request_error saying "The 'gpt-5.6-sol' model is not supported when
 * using Codex with a ChatGPT account." Codex exposes no list endpoint, so the
 * only honest way to know a model is unusable is to WATCH a run fail on it.
 * Ruling 19 (chips render proven verdicts only; an unproven state renders as an
 * honest "unproven" line, never a pseudo-check) decides the shape: a mark
 * earned from a real run's failure is evidence; a save-time synthetic tick is
 * the pseudo-check that ruling bans.
 *
 * Presence of a row = unavailable (with the provider's own redacted sentence).
 * Absence = unknown-but-offered — deliberately NOT "proven available", a claim
 * we cannot make without a successful run, which is exactly what
 * `clearModelMark` records when it happens.
 */

/**
 * The provider sentences that mean "this account cannot use this model" — as
 * opposed to quota, auth, or a crash (which are transient or credential
 * problems, not model problems). Anchored on the live F20-4 text.
 */
export const MODEL_UNSUPPORTED_RE =
  /model is not supported|model .*(?:does not exist|not found|unavailable)|unknown model|invalid model/i;

/** Mark a model unavailable (upsert): the newest failure's sentence wins. */
export function markModelUnavailable(
  db: DatabaseSync,
  input: { backend: RealBackend; model: string; reason: string; runId?: string },
): void {
  const model = input.model.trim();
  if (!model) return;
  db.prepare(
    `INSERT INTO model_availability (backend, model, reason, marked_at, run_id)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(backend, model) DO UPDATE SET
       reason = excluded.reason,
       marked_at = excluded.marked_at,
       run_id = excluded.run_id`,
  ).run(
    input.backend,
    model,
    input.reason,
    new Date().toISOString(),
    input.runId ?? null,
  );
}

/** Clear a model's unavailability mark (a real success proved it usable). */
export function clearModelMark(
  db: DatabaseSync,
  backend: RealBackend,
  model: string,
): void {
  const m = model.trim();
  if (!m) return;
  db.prepare(
    `DELETE FROM model_availability WHERE backend = ? AND model = ?`,
  ).run(backend, m);
}

/** One `model_availability` row, parsed at the DB boundary. Every selected
 *  column is `TEXT NOT NULL` in the schema, so a row that fails to parse is a
 *  hand-edited database, not a case this read model should invent a mark for. */
const markRowSchema = z.object({
  model: z.string(),
  reason: z.string(),
  marked_at: z.string(),
});

/** The unavailable models for a backend, keyed by model id. */
export function unavailableModels(
  db: DatabaseSync,
  backend: RealBackend,
): Map<string, { reason: string; markedAt: string }> {
  const rows = db
    .prepare(
      `SELECT model, reason, marked_at FROM model_availability WHERE backend = ?`,
    )
    .all(backend);
  const out = new Map<string, { reason: string; markedAt: string }>();
  for (const row of rows) {
    const parsed = markRowSchema.safeParse(row);
    if (!parsed.success) continue;
    out.set(parsed.data.model, {
      reason: parsed.data.reason,
      markedAt: parsed.data.marked_at,
    });
  }
  return out;
}

/**
 * Called from the two run-failure choke points (specialist/reviewer in
 * agent-completion, operator in operator-run). A no-op unless the provider text
 * matches MODEL_UNSUPPORTED_RE and the run actually named a model — a quota or
 * auth failure must never mark a model as unusable.
 */
export function noteModelAvailabilityFromFailure(
  db: DatabaseSync,
  input: {
    runId: string;
    backend: RealBackend;
    model: string | null;
    providerText: string;
  },
): void {
  const model = (input.model ?? "").trim();
  if (!model || !input.providerText) return;
  if (!MODEL_UNSUPPORTED_RE.test(input.providerText)) return;
  markModelUnavailable(db, {
    backend: input.backend,
    model,
    reason: input.providerText,
    runId: input.runId,
  });
  logger.info("model marked unavailable from a real run failure", {
    backend: input.backend,
    model,
    runId: input.runId,
  });
}
