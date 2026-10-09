import { scopeIsAdvisory } from "~/shared/credential-scopes";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  parsePatValidation,
  parseRepoScopeProofs,
  type PatValidation,
  type RepoScopeEvidence,
  type RepoScopeProof,
  type ScopeCheck,
} from "~/schemas/github-pat.schema";
import {
  recordAudit,
  type AuditActor,
} from "~/server/audit/audit-recorder.server";
import { AppError } from "~/server/errors/app-error.server";
import { logger } from "~/server/logging/logger.server";
import { newId } from "~/shared/ids/new-id.server";
import { openSecretRotating, sealSecret } from "./secret-box.server";
import { listScopeViolations } from "~/server/projections/policy-violations.server";
import { toError } from "~/shared/errors";

/**
 * PAT store (Phase 7): user-provided GitHub PATs, AES-256-GCM encrypted at
 * rest via the secret box. Metadata readers NEVER return the token — only
 * `getPatToken` decrypts, and only server-side GitHub calls consume it.
 *
 * Per-project credential selection: `project_github_credentials` binds one
 * stored PAT per project (the mock's POLICY.repo.credential). project.md's
 * `credentialPolicy` stays the non-secret display/requirements source
 * (label, masked, requiredScopes) — when no real PAT is bound the health
 * reader falls back to it so seeded demo projects render the mock exactly.
 */

// The scopes Viberr's own GitHub writes actually use — branch pushes (repo
// contents), PR open and PR merge — used when a project defines no
// credentialPolicy.requiredScopes of its own. Owner ruling 2026-07-25: the
// mock-era `workflow` and `read:org` are gone. Nothing in the app reads org
// data, and workflow-file pushes are situational — when a task really edits
// `.github/workflows/*`, the push 403s and opens a scope violation with
// GitHub's own message, which is a better verdict than an unprovable chip
// (fine-grained tokens offer no safe workflow probe). A project policy may
// still require either; they are validated like any policy scope.
export const DEFAULT_REQUIRED_SCOPES = [
  "repo",
  "pull_request:write",
] as const;

export interface PatMetadata {
  id: string;
  userId: string;
  label: string;
  /** Last 4 token characters — all that survives for display. */
  tokenSuffix: string;
  /** Masked display form: "····42af". */
  masked: string;
  createdAt: string;
  lastValidatedAt: string | null;
  /** Cached last validator run (tolerant parse; null when absent/invalid). */
  validation: PatValidation | null;
  /** Ruling 220: what each repository proved about the token (see
   *  `RepoScopeProof`); empty until one has. */
  repoScopes: RepoScopeProof[];
}

/** The metadata columns every PAT read selects, decoded at the sqlite boundary.
 *  0001_baseline declares each of them TEXT, the first five NOT NULL — a row
 *  that fails this parse is a row the readers below have no id or label for,
 *  which is the same answer as no row at all. */
const patRowSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  label: z.string(),
  token_suffix: z.string(),
  created_at: z.string(),
  last_validated_at: z.string().nullable(),
  validation_json: z.string().nullable(),
  repo_scopes_json: z.string().nullable(),
});
type PatRow = z.infer<typeof patRowSchema>;

const PAT_META_COLUMNS = `id, user_id, label, token_suffix, created_at,
       last_validated_at, validation_json, repo_scopes_json`;

function mapRow(row: PatRow): PatMetadata {
  return {
    id: row.id,
    userId: row.user_id,
    label: row.label,
    tokenSuffix: row.token_suffix,
    masked: `····${row.token_suffix}`,
    createdAt: row.created_at,
    lastValidatedAt: row.last_validated_at,
    validation: parsePatValidation(row.validation_json),
    repoScopes: parseRepoScopeProofs(row.repo_scopes_json),
  };
}

// ------------------------------------------------------------------ CRUD

export interface CreatePatInput {
  userId: string;
  label: string;
  /** The plaintext token — encrypted immediately, never stored raw. */
  token: string;
}

export function createPat(
  db: DatabaseSync,
  input: CreatePatInput,
  actor: AuditActor,
): PatMetadata {
  const label = input.label.trim();
  const token = input.token.trim();
  if (!label) throw AppError.validation("Give the credential a label.");
  if (token.length < 8 || /\s/.test(token)) {
    throw AppError.validation("That doesn't look like a GitHub token.");
  }
  const id = newId("pat");
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO github_pats
       (id, user_id, label, encrypted_token, token_suffix, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, input.userId, label, sealSecret(token), token.slice(-4), now);
  recordAudit(db, {
    action: "github.pat.created",
    actor,
    subjectKind: "github_pat",
    subjectId: id,
    details: { label, suffix: token.slice(-4) },
  });
  return {
    id,
    userId: input.userId,
    label,
    tokenSuffix: token.slice(-4),
    masked: `····${token.slice(-4)}`,
    createdAt: now,
    lastValidatedAt: null,
    validation: null,
    repoScopes: [],
  };
}

/** Metadata only — never the token. */
export function getPatMetadata(
  db: DatabaseSync,
  patId: string,
): PatMetadata | null {
  const row = patRowSchema.safeParse(
    db
      .prepare(`SELECT ${PAT_META_COLUMNS} FROM github_pats WHERE id = ?`)
      .get(patId),
  );
  return row.success ? mapRow(row.data) : null;
}

/**
 * Swaps the encrypted token on an EXISTING PAT row (Phase 9B org
 * connections: "the old token stays active unless validation passes" —
 * callers validate the replacement BEFORE calling this). Clears the cached
 * validation; callers record the fresh one via `recordPatValidation`. A new
 * token is a new grant, so every repository's proof goes with the old one
 * (ruling 220).
 */
export function replacePatToken(
  db: DatabaseSync,
  patId: string,
  token: string,
  actor: AuditActor,
): PatMetadata {
  const existing = getPatMetadata(db, patId);
  if (!existing) throw AppError.notFound("That credential no longer exists.");
  const trimmed = token.trim();
  if (trimmed.length < 8 || /\s/.test(trimmed)) {
    throw AppError.validation("That doesn't look like a GitHub token.");
  }
  db.prepare(
    `UPDATE github_pats
     SET encrypted_token = ?, token_suffix = ?,
         validation_json = NULL, last_validated_at = NULL,
         repo_scopes_json = NULL
     WHERE id = ?`,
  ).run(sealSecret(trimmed), trimmed.slice(-4), patId);
  recordAudit(db, {
    action: "github.pat.token_replaced",
    actor,
    subjectKind: "github_pat",
    subjectId: patId,
    details: { label: existing.label, suffix: trimmed.slice(-4) },
  });
  return getPatMetadata(db, patId)!;
}

/** Deletes a PAT (project bindings cascade). Idempotent. */
export function deletePat(
  db: DatabaseSync,
  patId: string,
  actor: AuditActor,
): boolean {
  const existing = getPatMetadata(db, patId);
  if (!existing) return false;
  db.prepare(`DELETE FROM github_pats WHERE id = ?`).run(patId);
  recordAudit(db, {
    action: "github.pat.deleted",
    actor,
    subjectKind: "github_pat",
    subjectId: patId,
    details: { label: existing.label, suffix: existing.tokenSuffix },
  });
  return true;
}

/** `encrypted_token` is a single NOT NULL column on `github_pats`; a row that
 *  does not decode is a credential this reader cannot open, same as no row. */
const sealedTokenRow = z.object({ encrypted_token: z.string() });

/**
 * Decrypts the stored token. SERVER-INTERNAL: feed it straight into the
 * GitHub client; never into loader data, logs, timelines or errors.
 */
export function getPatToken(
  db: DatabaseSync,
  patId: string,
): string | null {
  const row = sealedTokenRow.safeParse(
    db
      .prepare(`SELECT encrypted_token FROM github_pats WHERE id = ?`)
      .get(patId),
  );
  if (!row.success) return null;
  // A9: accept a box sealed under a RETIRED key during a rotation window, then
  // re-seal it in place under the current key. Without this, rotating
  // VIBERR_SECRET_ENCRYPTION_KEY bricked every stored PAT — the only signal
  // being a 500 at the next GitHub call.
  const opened = openSecretRotating(row.data.encrypted_token);
  if (opened.staleKey) {
    try {
      db.prepare(`UPDATE github_pats SET encrypted_token = ? WHERE id = ?`).run(
        sealSecret(opened.plaintext),
        patId,
      );
      logger.info("re-sealed a PAT under the current encryption key", { patId });
    } catch (error) {
      // The read still succeeded — a failed re-seal only costs the next read
      // another fallback, so never fail the caller over it.
      logger.warn("could not re-seal a PAT under the current encryption key", {
        patId,
        err: toError(error),
      });
    }
  }
  return opened.plaintext;
}

// ------------------------------------------------ per-repository evidence

/**
 * Ruling 220 (F40-43): the required scopes whose evidence is about ONE
 * repository. A fine-grained token is granted per repository, and the
 * validator proves these two against the repository it was asked about (the
 * `permissions` block, the pulls probe), so a verdict on one repository says
 * nothing about another. A classic token's `x-oauth-scopes` header answers for
 * every repository at once, which is why a `header` verdict stays token-wide.
 */
export const REPO_SCOPED_SCOPES: ReadonlySet<string> = new Set([
  "repo",
  "pull_request:write",
]);

/** GitHub compares repository names without case. */
function sameRepo(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** `proofs` with `evidence` recorded for `repo`: a scope's newest verdict
 *  replaces its older one on that repository, the others stay. */
function withRepoEvidence(
  proofs: RepoScopeProof[],
  repo: string,
  evidence: RepoScopeEvidence[],
): RepoScopeProof[] {
  if (evidence.length === 0) return proofs;
  const current = proofs.find((p) => sameRepo(p.repo, repo));
  const answered = new Set(evidence.map((e) => e.id));
  const kept = (current?.scopes ?? []).filter((s) => !answered.has(s.id));
  return [
    ...proofs.filter((p) => p !== current),
    { repo: current?.repo ?? repo, scopes: [...kept, ...evidence] },
  ];
}

/**
 * What one validator run does to the per-repository proofs. A token GitHub
 * refuses (revoked, expired) proves nothing any more, so every proof goes. A
 * run that asked about a repository it could not see (`repo_not_found`,
 * `org_approval_missing`) ends that repository's proof. A run that probed a
 * repository records its `probe` verdicts there, a refusal as much as a grant.
 * A run that asked about NO repository (the connection's save, its Re-check,
 * the 24-hour re-proof) or never reached GitHub leaves every proof as it was:
 * a narrower question cannot unprove what a wider one proved, which is the
 * regression F40-43 found.
 */
function repoScopesAfter(
  proofs: RepoScopeProof[],
  validation: PatValidation,
): RepoScopeProof[] {
  if (validation.status === "revoked" || validation.status === "expired") return [];
  const repo = validation.repo;
  if (!repo) return proofs;
  if (validation.status === "repo_not_found" || validation.status === "org_approval_missing") {
    return proofs.filter((p) => !sameRepo(p.repo, repo));
  }
  return withRepoEvidence(
    proofs,
    repo,
    validation.scopes.flatMap((s) =>
      REPO_SCOPED_SCOPES.has(s.id) && s.source === "probe"
        ? [{ ...s, at: validation.checkedAt }]
        : [],
    ),
  );
}

/** The proofs a row holds now, the ones its cached validation implies
 *  included (`repoScopeProofsOf`), so a write never drops them. */
function currentRepoScopes(db: DatabaseSync, patId: string): RepoScopeProof[] {
  const pat = getPatMetadata(db, patId);
  return pat ? repoScopeProofsOf(pat) : [];
}

function proofsJson(proofs: RepoScopeProof[]): string | null {
  return proofs.length > 0 ? JSON.stringify(proofs) : null;
}

/**
 * Caches a validator run on the PAT row (validation_json + timestamp), and
 * folds what it learned about a repository into that repository's proof
 * (ruling 220, `repoScopesAfter`).
 */
export function recordPatValidation(
  db: DatabaseSync,
  patId: string,
  validation: PatValidation,
): void {
  const proofs = repoScopesAfter(currentRepoScopes(db, patId), validation);
  db.prepare(
    `UPDATE github_pats
     SET validation_json = ?, last_validated_at = ?, repo_scopes_json = ?
     WHERE id = ?`,
  ).run(JSON.stringify(validation), validation.checkedAt, proofsJson(proofs), patId);
}

/** A write Viberr made to a repository with a token, and what it proves. */
export type RepoWrite = "branch" | "push" | "initial_commit" | "pull_request" | "merge";

const WRITE_PROOF = {
  branch: { scopes: ["repo"], note: "a branch Viberr created here" },
  push: { scopes: ["repo"], note: "a branch Viberr pushed here" },
  initial_commit: { scopes: ["repo"], note: "the initial commit Viberr made here" },
  pull_request: { scopes: ["pull_request:write"], note: "a pull request Viberr opened here" },
  // Merging needs Contents write (the base branch moves) on top of the pull
  // request itself; F28-U2a already counted it for `pull_request:write`.
  merge: { scopes: ["repo", "pull_request:write"], note: "a pull request Viberr merged here" },
} satisfies Record<RepoWrite, { scopes: readonly string[]; note: string }>;

/**
 * F27-U2 / F28-U2, ruling 220: a real, SOLICITED write to GitHub proves the
 * scopes it needed, on the repository it went to. A branch created, a branch
 * pushed or the initial commit prove `repo`; a pull request opened proves
 * `pull_request:write`; a merge proves both. Validation deliberately never
 * fires an UNSOLICITED write (that is the opt-in `VIBERR_GITHUB_WRITE_PROBE`);
 * this costs nothing because the write the task needed already happened. It
 * used to prove `pull_request:write` alone, on the token's newest validation
 * (whatever repository that asked about, or none), so no push or merge ever
 * made the card's "repo unproven (verified on first use)" true.
 *
 * F28-U2b: takes the `patId` that ACTUALLY made the call (from the GithubContext
 * that authenticated it), NOT the project's currently-bound credential — a
 * credential rotation racing an in-flight `openTaskPr` must not stamp "proven"
 * onto a PAT that made no GitHub call. No-op when the PAT is gone.
 */
export function markWriteScopeProven(
  db: DatabaseSync,
  patId: string,
  repo: string,
  write: RepoWrite,
): void {
  const pat = getPatMetadata(db, patId);
  if (!pat || !repo) return;
  const at = new Date().toISOString();
  const { scopes, note } = WRITE_PROOF[write];
  const proofs = withRepoEvidence(
    repoScopeProofsOf(pat),
    repo,
    scopes.map((id) => ({ id, ok: true, source: "probe" as const, note, at })),
  );
  db.prepare(`UPDATE github_pats SET repo_scopes_json = ? WHERE id = ?`).run(
    proofsJson(proofs),
    pat.id,
  );
}

/**
 * Every repository's proof for a token: the stored ones, plus, for a row
 * cached before the proofs had their own column, the repository its
 * validation probed when no stored proof names it. Both the project card and
 * the connection card read the token's evidence through this.
 */
export function repoScopeProofsOf(
  pat: Pick<PatMetadata, "validation" | "repoScopes">,
): RepoScopeProof[] {
  const validation = pat.validation;
  const repo = validation?.repo ?? null;
  if (!validation || !repo || pat.repoScopes.some((p) => sameRepo(p.repo, repo))) {
    return pat.repoScopes;
  }
  return repoScopesAfter(pat.repoScopes, validation);
}

/** The verdicts one repository's proof holds, by scope id. */
function repoEvidence(
  proofs: RepoScopeProof[],
  repo: string | null,
): Map<string, ScopeCheck> {
  const proof = repo ? proofs.find((p) => sameRepo(p.repo, repo)) : undefined;
  return new Map((proof?.scopes ?? []).map((s) => [s.id, s]));
}

// --------------------------------------------- project credential binding

export function setProjectCredential(
  db: DatabaseSync,
  input: { projectSlug: string; patId: string },
  actor: AuditActor,
): PatMetadata {
  const pat = getPatMetadata(db, input.patId);
  if (!pat) throw AppError.notFound("That credential no longer exists.");
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO project_github_credentials
       (project_slug, pat_id, created_at, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(project_slug) DO UPDATE SET
       pat_id = excluded.pat_id, updated_at = excluded.updated_at`,
  ).run(input.projectSlug, input.patId, now, now);
  recordAudit(db, {
    action: "github.credential.assigned",
    actor,
    subjectKind: "github_pat",
    subjectId: input.patId,
    projectSlug: input.projectSlug,
    details: { label: pat.label, suffix: pat.tokenSuffix },
  });
  return pat;
}

export function clearProjectCredential(
  db: DatabaseSync,
  projectSlug: string,
  actor: AuditActor,
): boolean {
  const result = db
    .prepare(`DELETE FROM project_github_credentials WHERE project_slug = ?`)
    .run(projectSlug);
  if (result.changes === 0) return false;
  recordAudit(db, {
    action: "github.credential.cleared",
    actor,
    subjectKind: "project",
    subjectId: projectSlug,
    projectSlug,
  });
  return true;
}

/** The PAT bound to a project (metadata only), or null. */
export function getProjectCredential(
  db: DatabaseSync,
  projectSlug: string,
): PatMetadata | null {
  const row = db
    .prepare(
      `SELECT p.id, p.user_id, p.label, p.token_suffix, p.created_at,
              p.last_validated_at, p.validation_json, p.repo_scopes_json
       FROM project_github_credentials b
       JOIN github_pats p ON p.id = b.pat_id
       WHERE b.project_slug = ?`,
    )
    .get(projectSlug);
  const parsed = patRowSchema.safeParse(row);
  return parsed.success ? mapRow(parsed.data) : null;
}

// --------------------------------------------------------- credential health

/** Chip verdict source — extends the validator's with the overlay states:
 * `violation` (an open scope violation forces not-ok) and `unchecked`
 * (no validation cached yet; ok by absence of violations). */
export type ScopeChipSource =
  | "header"
  | "probe"
  | "assumed"
  | "violation"
  | "unchecked";

export interface ScopeChip {
  id: string;
  ok: boolean;
  source: ScopeChipSource;
  /** Task the open violation is flagged on (cred-warn keybtn target). */
  flaggedTaskKey?: string;
}

/**
 * Ruling 221(a) (pass 34, G34-2): an ADVISORY about the credential that never
 * fails validation and never renders as a missing chip. Today's one advisory:
 * a classic token whose published scope list lacks `workflow`, which GitHub
 * refuses for a push touching `.github/workflows/*`; or an open `workflow`
 * violation, which is the same fact after GitHub said so. Fine-grained tokens
 * publish nothing to read, so they get no advisory.
 */
export interface CredentialAdvisory {
  id: "workflow_scope" | "checks_read";
  scope: "workflow" | "checks:read";
  source: "header" | "violation";
  text: string;
}

/** Ruling 221(a): the advisories a validation and the open violations imply. */
export function credentialAdvisories(
  validation: PatValidation | null,
  openViolations: readonly { scope: string; taskKey: string | null }[],
): CredentialAdvisory[] {
  const advisories: CredentialAdvisory[] = [];
  const violation = openViolations.find((v) => v.scope === "workflow");
  const header = validation?.headerScopes ?? null;
  if (violation) {
    advisories.push({
      id: "workflow_scope",
      scope: "workflow",
      source: "violation",
      text: `GitHub refused a push under .github/workflows/ with this token${violation.taskKey ? ` (${violation.taskKey})` : ""}: it lacks the workflow scope. Grant it on GitHub, then use Re-check scopes on the project's GitHub page.`,
    });
  } else if (header && validation?.tokenKind === "classic" && !header.includes("workflow")) {
    advisories.push({
      id: "workflow_scope",
      scope: "workflow",
      source: "header",
      text: "This classic token has no workflow scope, so it cannot push changes under .github/workflows/. Grant it on GitHub if a task will ship CI, then use Re-check scopes on the project's GitHub page.",
    });
  }
  // Ruling 237 (pass 38, F38-14): the check-runs read GitHub refused with this
  // token. Not a missing REQUIRED scope — merging never needed it — but the
  // reason the checks are not shown (ruling 315 dropped the "checks not
  // readable" pill; the project's own gates carry the verification).
  // F39-5: the same list the timeline writer reads, so "advisory" cannot mean
  // one thing on the card and another on the record.
  const checks = openViolations.find(
    (v) => v.scope === "checks:read" && scopeIsAdvisory(v.scope),
  );
  if (checks) {
    advisories.push({
      id: "checks_read",
      scope: "checks:read",
      source: "violation",
      text: `GitHub refused this token's read of pull-request check results${checks.taskKey ? ` (${checks.taskKey})` : ""}: it lacks Checks: read, so CI status is not shown on task pages or accept dialogs, and merges proceed without it. Grant it on GitHub, then use Re-check scopes on the project's GitHub page.`,
    });
  }
  return advisories;
}

export interface ProjectCredentialHealth {
  /** True when a real PAT row is bound to the project. */
  configured: boolean;
  /** pat = real bound credential · none = nothing bound (a project may still
   * declare a credentialPolicy for requiredScopes, but a policy is not a
   * credential and never renders as configured). */
  source: "pat" | "none";
  patId: string | null;
  label: string | null;
  masked: string | null;
  lastValidatedAt: string | null;
  validation: PatValidation | null;
  /** Ruling 222 (F40-45): the Instance-settings connection whose token this
   *  is, so the card can send an instance admin to that connection's Update
   *  token (the only place a token is replaced). Absent when no connection
   *  holds the bound PAT, and on a project with none: an absent key costs the
   *  settings payload nothing (ruling 11). */
  connectionId?: string;
  requiredScopes: string[];
  /** One chip per required scope — feed straight into `.scope-chips`. Ruling
   *  220: a repository-scoped scope's chip reads THIS project's repository's
   *  proof (`repoScopeProofsOf`), never another repository's, and never the
   *  "assumed" a connection-level Re-check leaves on the token. */
  scopes: ScopeChip[];
  /** Open violations for the project (newest first). */
  openViolations: ReturnType<typeof listScopeViolations>;
  /** Ruling 221(a): advisories, never verdicts (see `CredentialAdvisory`). */
  advisories: CredentialAdvisory[];
}

interface CredentialPolicyDisplay {
  credentialLabel: string;
  masked: string;
  requiredScopes: string[];
}

/** `credential_policy_json` and `repo` are the projection's own nullable TEXT
 *  columns. */
const credentialPolicyRow = z.object({
  credential_policy_json: z.string().nullable(),
  repo: z.string().nullable(),
});

/** The non-secret display policy as project.md's projection stored it. Every
 *  field is INDEPENDENTLY tolerant, exactly as the hand decode this replaced
 *  was: a junk value degrades to that one field's fallback (a junk SCOPE drops
 *  itself, keeping the rest of the list) instead of voiding the whole policy. */
const credentialPolicyDisplaySchema = z
  .object({
    credentialLabel: z.string().catch(""),
    masked: z.string().catch(""),
    requiredScopes: z
      .array(z.string().nullable().catch(null))
      .catch([])
      .transform((scopes) => scopes.filter((scope) => scope !== null)),
  })
  .catch({ credentialLabel: "", masked: "", requiredScopes: [] });

/** The project's display policy (null when it declares none) and the
 *  repository its repository-scoped chips are about (ruling 220). */
interface ProjectCredentialFacts {
  policy: CredentialPolicyDisplay | null;
  repo: string | null;
}

function readCredentialPolicy(
  db: DatabaseSync,
  projectSlug: string,
): ProjectCredentialFacts {
  const row = credentialPolicyRow.safeParse(
    db
      .prepare(`SELECT credential_policy_json, repo FROM projects WHERE slug = ?`)
      .get(projectSlug),
  );
  const repo = row.success ? row.data.repo?.trim() || null : null;
  const json = row.success ? row.data.credential_policy_json : null;
  if (!json) return { policy: null, repo };
  try {
    return { policy: credentialPolicyDisplaySchema.parse(JSON.parse(json)), repo };
  } catch {
    return { policy: null, repo };
  }
}

/** `id` is `github_connections`' TEXT primary key. */
const connectionIdRow = z.object({ id: z.string() });

/** The connection holding a PAT, if one does (ruling 222, F40-45). */
function connectionIdOf(db: DatabaseSync, patId: string): string | null {
  const row = connectionIdRow.safeParse(
    db.prepare(`SELECT id FROM github_connections WHERE pat_id = ?`).get(patId),
  );
  return row.success ? row.data.id : null;
}

/**
 * One required scope's chip. An open violation wins (the caller checks it
 * first). A classic token's `header` verdict answers for every repository. A
 * repository-scoped scope otherwise reads the proof of the PROJECT's
 * repository (ruling 220): a probe or a write there is proof, and a verdict
 * the token earned anywhere else (or nowhere, on a connection-level Re-check)
 * leaves it "assumed", which the card renders as unproven.
 */
function scopeChip(
  id: string,
  check: ScopeCheck | undefined,
  proof: ScopeCheck | undefined,
): ScopeChip {
  if (REPO_SCOPED_SCOPES.has(id) && check?.source !== "header") {
    if (proof) return { id, ok: proof.ok, source: "probe" };
    return check ? { id, ok: true, source: "assumed" } : { id, ok: true, source: "unchecked" };
  }
  if (check) return { id, ok: check.ok, source: check.source };
  return { id, ok: true, source: "unchecked" };
}

/**
 * The one server-derived credential fact the GitHub view, Settings card,
 * Activity and rail badge all consume (replaces the mock's `scopeGranted`
 * client boolean — ruling 221). Scope chips combine the cached validator
 * verdicts with the open-violation overlay: an open violation for a scope
 * forces its chip to not-ok and carries the flagged task key.
 */
export function getProjectCredentialHealth(
  db: DatabaseSync,
  projectSlug: string,
): ProjectCredentialHealth {
  const pat = getProjectCredential(db, projectSlug);
  const { policy, repo } = readCredentialPolicy(db, projectSlug);
  const openViolations = listScopeViolations(db, projectSlug, {
    status: "open",
  });

  const requiredScopes =
    policy && policy.requiredScopes.length > 0
      ? policy.requiredScopes
      : [...DEFAULT_REQUIRED_SCOPES];

  const violationByScope = new Map<string, (typeof openViolations)[number]>();
  for (const violation of openViolations) {
    if (!violationByScope.has(violation.scope)) {
      violationByScope.set(violation.scope, violation);
    }
  }

  const validated = new Map(
    (pat?.validation?.scopes ?? []).map((s) => [s.id, s]),
  );
  const proven = repoEvidence(pat ? repoScopeProofsOf(pat) : [], repo);

  const scopes: ScopeChip[] = requiredScopes.map((id) => {
    const violation = violationByScope.get(id);
    if (violation) {
      const chip: ScopeChip = { id, ok: false, source: "violation" };
      if (violation.taskKey) chip.flaggedTaskKey = violation.taskKey;
      return chip;
    }
    return scopeChip(id, validated.get(id), proven.get(id));
  });

  if (pat) {
    const health: ProjectCredentialHealth = {
      configured: true,
      source: "pat",
      patId: pat.id,
      label: pat.label,
      masked: pat.masked,
      lastValidatedAt: pat.lastValidatedAt,
      validation: pat.validation,
      requiredScopes,
      scopes,
      openViolations,
      advisories: credentialAdvisories(pat.validation, openViolations),
    };
    const connectionId = connectionIdOf(db, pat.id);
    if (connectionId) health.connectionId = connectionId;
    return health;
  }
  // No bound PAT → honest "none" state, ALWAYS. A project may still declare a
  // credentialPolicy (its requiredScopes drive the pre-flight scope check), but
  // a policy is NOT a credential: the old `policy_display` source rendered a
  // green "All required scopes granted" card from project.md's masked/label for
  // a token that does not exist (seeded demo lie — owner ruling "honest empty
  // slate"). requiredScopes still flow through so the degraded card can say what
  // the project needs; nothing fabricated is presented as configured.
  return {
    configured: false,
    source: "none",
    patId: null,
    label: null,
    masked: null,
    lastValidatedAt: null,
    validation: null,
    requiredScopes,
    scopes,
    openViolations,
    advisories: [],
  };
}
