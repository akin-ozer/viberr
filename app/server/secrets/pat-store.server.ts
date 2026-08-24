import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  parsePatValidation,
  type PatValidation,
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
});
type PatRow = z.infer<typeof patRowSchema>;

const PAT_META_COLUMNS = `id, user_id, label, token_suffix, created_at,
       last_validated_at, validation_json`;

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
 * validation; callers record the fresh one via `recordPatValidation`.
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
         validation_json = NULL, last_validated_at = NULL
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
        err: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }
  return opened.plaintext;
}

/** Caches a validator run on the PAT row (validation_json + timestamp). */
export function recordPatValidation(
  db: DatabaseSync,
  patId: string,
  validation: PatValidation,
): void {
  db.prepare(
    `UPDATE github_pats
     SET validation_json = ?, last_validated_at = ?
     WHERE id = ?`,
  ).run(JSON.stringify(validation), validation.checkedAt, patId);
}

/**
 * F27-U2: a real, SOLICITED write to GitHub (a task's PR actually opened or
 * merged) genuinely proves `pull_request:write` on the project's bound
 * credential — so flip its cached scope from the honest-but-stale "unproven
 * (verified on first use)" to `probe` (proven). Validation deliberately never
 * fires an UNSOLICITED write to prove this scope (that is the opt-in
 * `VIBERR_GITHUB_WRITE_PROBE`); this costs nothing extra because the write the
 * task needed already happened. No-op when nothing is bound, no validation is
 * cached, or the scope already reads proven.
 */
export function markWriteScopeProven(
  db: DatabaseSync,
  projectSlug: string,
): void {
  const pat = getProjectCredential(db, projectSlug);
  const validation = pat?.validation ?? null;
  if (!pat || !validation) return;
  const scope = validation.scopes.find((s) => s.id === "pull_request:write");
  if (!scope || (scope.ok && scope.source === "probe")) return;
  recordPatValidation(db, pat.id, {
    ...validation,
    scopes: validation.scopes.map((s) =>
      s.id === "pull_request:write" ? { ...s, ok: true, source: "probe" } : s,
    ),
  });
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
              p.last_validated_at, p.validation_json
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
  requiredScopes: string[];
  /** One chip per required scope — feed straight into `.scope-chips`. */
  scopes: ScopeChip[];
  /** Open violations for the project (newest first). */
  openViolations: ReturnType<typeof listScopeViolations>;
}

interface CredentialPolicyDisplay {
  credentialLabel: string;
  masked: string;
  requiredScopes: string[];
}

/** `credential_policy_json` is the projection's own nullable TEXT column. */
const credentialPolicyRow = z.object({
  credential_policy_json: z.string().nullable(),
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

function readCredentialPolicy(
  db: DatabaseSync,
  projectSlug: string,
): CredentialPolicyDisplay | null {
  const row = credentialPolicyRow.safeParse(
    db
      .prepare(`SELECT credential_policy_json FROM projects WHERE slug = ?`)
      .get(projectSlug),
  );
  const json = row.success ? row.data.credential_policy_json : null;
  if (!json) return null;
  try {
    return credentialPolicyDisplaySchema.parse(JSON.parse(json));
  } catch {
    return null;
  }
}

/**
 * The one server-derived credential fact the GitHub view, Settings card,
 * Activity and rail badge all consume (replaces the mock's `scopeGranted`
 * client boolean — ruling 5). Scope chips combine the cached validator
 * verdicts with the open-violation overlay: an open violation for a scope
 * forces its chip to not-ok and carries the flagged task key.
 */
export function getProjectCredentialHealth(
  db: DatabaseSync,
  projectSlug: string,
): ProjectCredentialHealth {
  const pat = getProjectCredential(db, projectSlug);
  const policy = readCredentialPolicy(db, projectSlug);
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

  const scopes: ScopeChip[] = requiredScopes.map((id) => {
    const violation = violationByScope.get(id);
    if (violation) {
      const chip: ScopeChip = { id, ok: false, source: "violation" };
      if (violation.taskKey) chip.flaggedTaskKey = violation.taskKey;
      return chip;
    }
    const check = validated.get(id);
    if (check) return { id, ok: check.ok, source: check.source };
    return { id, ok: true, source: "unchecked" };
  });

  if (pat) {
    return {
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
    };
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
  };
}
