/**
 * The STATIC half of the server's `isKnownModel` acceptance rule for Claude
 * model ids, shared so the client-side model pickers can ask the same
 * question (ruling 106 review, D1). The server's full check additionally
 * consults the live `supportedModels()` cache; that part is process-local by
 * nature, but live ids are dated ids in practice, so this predicate covers
 * everything a picker must not treat as "unknown".
 */

/** Claude family aliases — the SDK resolves each to the latest model of that
 *  tier at run time, so they are valid ids forever, whether or not a served
 *  catalog happens to list them. Must stay in step with the curated
 *  `CLAUDE_MODELS` values in model-catalog.server.ts (locked by test). */
export const CLAUDE_MODEL_ALIASES: readonly string[] = [
  "sonnet",
  "opus",
  "haiku",
];

/**
 * A DATED Claude id, e.g. `claude-sonnet-4-5` or `claude-opus-4-1-20250805` —
 * what `resolveClaudeModel` forwards to the SDK verbatim, and the shape a live
 * `supportedModels()` row carries. Deliberately NOT matched by seed display
 * labels ("claude-sonnet" has no digit).
 */
export const DATED_CLAUDE_ID_RE = /^claude-.*\d/;

/**
 * Would a Claude run execute this stored id VERBATIM even when the served
 * model catalog does not list it? True for the family aliases and for dated
 * ids — exactly the values `resolveRunModel("claude", …)` passes through
 * rather than substituting the default. A picker must therefore never rewrite
 * such a value to the catalog default: the rewrite would be a silent model
 * change, not a display correction.
 */
export function claudeModelRunsVerbatim(model: string): boolean {
  return CLAUDE_MODEL_ALIASES.includes(model) || DATED_CLAUDE_ID_RE.test(model);
}
