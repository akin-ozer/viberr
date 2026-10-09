/**
 * The STATIC half of the server's `isKnownModel` acceptance rule for Claude
 * model ids, shared so the client-side model pickers can ask the same
 * question (ruling 270 review, D1). The server's full check additionally
 * consults the live `supportedModels()` cache; that part is process-local by
 * nature, but live ids are dated ids in practice, so this predicate covers
 * everything a picker must not treat as "unknown".
 */

/** Claude family aliases — the SDK resolves each to the latest model of that
 *  tier at run time, so they are valid ids forever, whether or not a served
 *  catalog happens to list them. Every curated `CLAUDE_MODELS` value in
 *  model-catalog.server.ts must run verbatim by `claudeModelRunsVerbatim`
 *  below (locked by test); today each one is an alias here. */
const CLAUDE_MODEL_ALIASES: readonly string[] = [
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
 * Pass 34 (F34-7): a CONTEXT-WINDOW VARIANT rides a bracketed suffix on the
 * id — `opus[1m]` is what the live catalog offers as "Opus (1M context)" and
 * what a profile stores. The suffix is part of the id the SDK accepts, so it
 * has to survive resolution verbatim: the old resolver's `includes("opus")`
 * arm returned the bare alias and the person who picked a 1M-context model
 * ran a 200k one.
 */
const CLAUDE_VARIANT_SUFFIX_RE = /\[[a-z0-9]+\]$/i;

/** A family alias carrying a variant suffix: `opus[1m]`, `sonnet[1m]`. */
export const CLAUDE_ALIAS_VARIANT_RE = /^(sonnet|opus|haiku)\[[a-z0-9]+\]$/i;

/**
 * Split the bracketed variant off a Claude id. `claude-opus[1m]` →
 * `{ base: "claude-opus", variant: "[1m]" }`; an id without one keeps `variant:
 * null`. The resolver splits FIRST, resolves the base through the ordinary
 * rules (dated test included) and re-appends the variant verbatim — otherwise
 * `claude-opus[1m]` would match the dated branch on the digit inside the
 * bracket and be forwarded unchanged, which is not an SDK id.
 */
export interface ClaudeModelParts {
  /** The id with any bracketed variant removed. */
  base: string;
  /** The bracketed variant suffix verbatim (`[1m]`), or null. */
  variant: string | null;
}

export function splitClaudeVariant(model: string): ClaudeModelParts {
  const m = CLAUDE_VARIANT_SUFFIX_RE.exec(model);
  if (!m) return { base: model, variant: null };
  return { base: model.slice(0, m.index), variant: m[0] };
}

/**
 * Would a Claude run execute this stored id VERBATIM even when the served
 * model catalog does not list it? True for the family aliases, for dated ids
 * and for a family alias carrying a context-window variant — exactly the
 * values `resolveRunModel("claude", …)` passes through rather than
 * substituting the default. A picker must therefore never rewrite such a
 * value to the catalog default: the rewrite would be a silent model change,
 * not a display correction.
 */
export function claudeModelRunsVerbatim(model: string): boolean {
  return (
    CLAUDE_MODEL_ALIASES.includes(model) ||
    DATED_CLAUDE_ID_RE.test(model) ||
    CLAUDE_ALIAS_VARIANT_RE.test(model)
  );
}
