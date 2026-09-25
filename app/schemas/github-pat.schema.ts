import { z } from "zod";

/**
 * Shared shapes for GitHub PAT validation results (Phase 7).
 *
 * `validation_json` on the `github_pats` row caches the last
 * pat-validator run as this shape; loaders re-parse it tolerantly
 * (invalid/legacy blobs → null, never a crash).
 *
 * Scope-id vocabulary: the classic-scope display ids are the contract —
 * the required set is `repo` + `pull_request:write` (what Viberr's own
 * writes use; owner ruling 2026-07-25 dropped the mock-era `workflow` and
 * `read:org`), and project.md credentialPolicy.requiredScopes may add
 * others. For CLASSIC tokens ids are compared literally against the
 * `x-oauth-scopes` header. For FINE-GRAINED tokens GitHub exposes no
 * scope introspection, so each id maps to a live probe where one exists —
 * reads directly, writes via the empty-payload dry-run (422 = authorized,
 * 403 = refused) — and is otherwise "assumed" granted until a real 403
 * opens a scope violation (ruling 5).
 */

const PAT_VALIDATION_STATUS_VALUES = [
  "valid",
  "insufficient_scope",
  "expired",
  "revoked",
  "repo_not_found",
  "org_approval_missing",
  "network_error",
] as const;

const PAT_TOKEN_KINDS = ["classic", "fine_grained", "unknown"] as const;
export type PatTokenKind = (typeof PAT_TOKEN_KINDS)[number];

/** How a scope verdict was reached (honesty marker, surfaced in UI/tooling):
 *  header   — listed (or absent) in the classic `x-oauth-scopes` header
 *  probe    — a read-only API probe succeeded/failed
 *  assumed  — no safe probe exists; treated as granted until a 403 proves
 *             otherwise (fine-grained write permissions)
 */
const scopeCheckSchema = z
  .object({
    id: z.string().min(1),
    ok: z.boolean(),
    source: z.enum(["header", "probe", "assumed"]),
    note: z.string().optional(),
  })
  .loose();
export type ScopeCheck = z.infer<typeof scopeCheckSchema>;

const patValidationSchema = z
  .object({
    status: z.enum(PAT_VALIDATION_STATUS_VALUES),
    /** UTC ISO timestamp of the validator run. */
    checkedAt: z.string(),
    /** GitHub login of the token's user (null when auth failed). */
    login: z.string().nullable().default(null),
    tokenKind: z.enum(PAT_TOKEN_KINDS).default("unknown"),
    /** From the GitHub-Authentication-Token-Expiration response header. */
    expiresAt: z.string().nullable().default(null),
    /** Repo the run checked access against ("owner/name"), when any. */
    repo: z.string().nullable().default(null),
    /** Per-required-scope verdicts (always present, even on failure). */
    scopes: z.array(scopeCheckSchema).default([]),
    /** Scope ids with ok=false — convenience for insufficient_scope. */
    missingScopes: z.array(z.string()).default([]),
    /** Ruling 144 (pass 34, G34-2): a CLASSIC token's full granted list, read
     *  from the `x-oauth-scopes` header verbatim (an empty header records
     *  `[]`). Null for fine-grained tokens, which expose nothing to read, and
     *  for a run that never reached the header. Advisory only: the required
     *  set is judged by `scopes`, never by this list — it exists so the
     *  credential card can say that a token without `workflow` cannot push
     *  `.github/workflows/*`, and so delivery can refuse such a push BEFORE
     *  GitHub is asked. */
    headerScopes: z.array(z.string()).nullable().default(null),
    /** Human-readable, secret-free summary of what happened. */
    detail: z.string().default(""),
  })
  .loose();
export type PatValidation = z.infer<typeof patValidationSchema>;

/** Tolerant parse of a cached validation_json blob. */
export function parsePatValidation(raw: string | null): PatValidation | null {
  if (!raw) return null;
  try {
    const result = patValidationSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/**
 * Ruling 480 (F40-43): what one REPOSITORY proved about a token, kept per
 * repository in `github_pats.repo_scopes_json`.
 *
 * A fine-grained token is granted per repository, so its `repo` and
 * `pull_request:write` answers are facts about one repository: GitHub's
 * permission block on `GET /repos/{r}`, or a write Viberr made there (a branch,
 * a push, a pull request, a merge). The token's own `validation_json` is the
 * NEWEST validator run, whatever it asked, and the connection's Re-check asks
 * about no repository at all; when that was the only home of the evidence, a
 * Re-check on Instance settings turned a project's proven `repo` back into
 * "unproven". Each entry is the verdict one scope last received on one
 * repository (`at` is when), always `source: "probe"`: an `assumed` answer is
 * no evidence and is never stored here.
 */
const repoScopeEvidenceSchema = scopeCheckSchema.extend({ at: z.string() });
export type RepoScopeEvidence = z.infer<typeof repoScopeEvidenceSchema>;

const repoScopeProofSchema = z.object({
  /** "owner/name", as the probe or the write named it. */
  repo: z.string().min(1),
  scopes: z.array(repoScopeEvidenceSchema),
});
export type RepoScopeProof = z.infer<typeof repoScopeProofSchema>;

/** Tolerant parse of `repo_scopes_json`: NULL or a value this code did not
 *  write is "nothing proven yet" (an empty list), never a crash. */
export function parseRepoScopeProofs(raw: string | null): RepoScopeProof[] {
  if (!raw) return [];
  try {
    const result = z.array(repoScopeProofSchema).safeParse(JSON.parse(raw));
    return result.success ? result.data : [];
  } catch {
    return [];
  }
}
