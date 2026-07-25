import type { DatabaseSync } from "node:sqlite";
import { withTransaction } from "~/server/db/transaction.server";
import {
  parsePatValidation,
  type PatValidation,
} from "~/schemas/github-pat.schema";
import {
  recordAudit,
  type AuditActor,
} from "~/server/audit/audit-recorder.server";
import { getPatValidationRateLimiter } from "~/server/auth/rate-limit.server";
import { createGithubClient } from "~/server/github/github-client.server";
import {
  createPat,
  deletePat,
  getPatToken,
  recordPatValidation,
  replacePatToken,
} from "~/server/secrets/pat-store.server";
import { validatePatToken } from "~/server/secrets/pat-validator.server";
import { slugify } from "~/shared/ids/slugify";
import { formatCalendarDate } from "~/shared/dates/format";

/**
 * Org-level GitHub OWNER connections (org-settings spec §3.1 / §4.1).
 *
 * A connection = owner + PAT. The token rides the phase-7 pat-store
 * (encrypted at rest, masked display, cached validation); this module owns
 * the org facts: default flag, repo count, expiry. The whole surface is
 * built around "nothing is saved unless validation passes" (§7.2):
 * create/replace validate the token against the minimum scope set FIRST
 * and return a typed failure — the DB is untouched (and on replace the old
 * token stays active).
 *
 * Validation honesty: classic tokens verify scopes via the authoritative
 * `x-oauth-scopes` header; fine-grained tokens have no introspection, so
 * write scopes come back `assumed` (granted until a real 403) — phase-7
 * validator semantics, unchanged.
 */

/** The minimum a connection must hold for Viberr's own writes (branch push,
 * PR open, PR merge). Owner ruling 2026-07-25: the mock-era `workflow`
 * requirement is gone — it blocked classic tokens that were perfectly able to
 * deliver, and it is unprovable for fine-grained ones; a workflow-file push
 * that GitHub refuses surfaces as a scope violation at the moment it matters. */
export const CONNECTION_REQUIRED_SCOPES = [
  "repo",
  "pull_request:write",
] as const;

export type ConnectionValidationState = "valid" | "failed" | "unvalidated";

export interface ConnectionRecord {
  id: string;
  owner: string;
  method: "PAT";
  patId: string;
  /** Masked token display, e.g. "····42af". */
  masked: string;
  def: boolean;
  /** Accessible public repo count captured at validation; null = unknown. */
  repos: number | null;
  /** Token expiry (ISO) when GitHub advertises one; null = none/unknown. */
  expiresAt: string | null;
  /** Whole days until expiry (may be negative); null when no expiry. */
  daysLeft: number | null;
  validationState: ConnectionValidationState;
  /**
   * Per-scope evidence (P13-UI-01). A fine-grained PAT publishes no
   * `x-oauth-scopes` header, so the validator records `{ok:true,
   * source:"assumed"}` WITHOUT probing anything — and the panel painted a ✓ on
   * every scope anyway, next to copy promising "if any scope is missing the
   * token is refused". The first honest signal was a failed agent delivery.
   * `source` was already persisted and ignored; it now reaches the UI.
   */
  scopes: { id: string; ok: boolean; source: string; note?: string }[];
  lastValidatedAt: string | null;
  createdAt: string;
}

interface ConnectionRow {
  id: string;
  owner: string;
  pat_id: string;
  is_default: number;
  repos_count: number | null;
  expires_at: string | null;
  created_at: string;
  token_suffix: string | null;
  last_validated_at: string | null;
  validation_json: string | null;
}

function validationState(
  validation: PatValidation | null,
): ConnectionValidationState {
  if (!validation) return "unvalidated";
  return validation.status === "valid" ? "valid" : "failed";
}

function mapRow(row: ConnectionRow, now = new Date()): ConnectionRecord {
  const expiresAt = row.expires_at;
  let daysLeft: number | null = null;
  if (expiresAt) {
    const ms = Date.parse(expiresAt) - now.getTime();
    daysLeft = Number.isNaN(ms) ? null : Math.ceil(ms / 86_400_000);
  }
  return {
    id: row.id,
    owner: row.owner,
    method: "PAT",
    patId: row.pat_id,
    masked: `····${row.token_suffix ?? "????"}`,
    def: row.is_default === 1,
    repos: row.repos_count,
    expiresAt,
    daysLeft,
    validationState: validationState(parsePatValidation(row.validation_json)),
    scopes: (parsePatValidation(row.validation_json)?.scopes ?? []).map((sc) => ({
      id: sc.id,
      ok: sc.ok,
      source: sc.source,
      ...(sc.note ? { note: sc.note } : {}),
    })),
    lastValidatedAt: row.last_validated_at,
    createdAt: row.created_at,
  };
}

const LIST_SQL = `
  SELECT c.id, c.owner, c.pat_id, c.is_default, c.repos_count, c.expires_at,
         c.created_at, p.token_suffix, p.last_validated_at, p.validation_json
  FROM github_connections c
  LEFT JOIN github_pats p ON p.id = c.pat_id`;

export function listConnections(db: DatabaseSync): ConnectionRecord[] {
  const rows = db
    .prepare(`${LIST_SQL} ORDER BY c.created_at ASC, c.id ASC`)
    .all() as unknown as ConnectionRow[];
  return rows.map((r) => mapRow(r));
}

export function getConnection(
  db: DatabaseSync,
  id: string,
): ConnectionRecord | null {
  const row = db.prepare(`${LIST_SQL} WHERE c.id = ?`).get(id) as
    | ConnectionRow
    | undefined;
  return row ? mapRow(row) : null;
}

/** The default connection (at most one). */
export function getDefaultConnection(
  db: DatabaseSync,
): ConnectionRecord | null {
  const row = db.prepare(`${LIST_SQL} WHERE c.is_default = 1`).get() as
    | ConnectionRow
    | undefined;
  return row ? mapRow(row) : null;
}

/**
 * Decrypted token of the default connection ONLY when its last validation
 * passed — the StoreBrowser GitHub import uses this. SERVER-INTERNAL.
 */
export function getDefaultConnectionToken(
  db: DatabaseSync,
): { connection: ConnectionRecord; token: string } | null {
  const connection = getDefaultConnection(db);
  if (!connection || connection.validationState !== "valid") return null;
  const token = getPatToken(db, connection.patId);
  return token ? { connection, token } : null;
}

// -------------------------------------------------------------- mutations

export interface ConnectionOptions {
  fetchImpl?: typeof fetch;
}

export type SaveConnectionResult =
  | { status: "saved"; connection: ConnectionRecord; toast: string }
  | { status: "duplicate"; message: string }
  | { status: "validation_failed"; message: string }
  | { status: "not_found"; message: string };

function failureMessage(validation: PatValidation): string {
  if (validation.status === "insufficient_scope") {
    const missing = validation.missingScopes.join(" · ") || "required scopes";
    return (
      `Validation failed — token is missing ${missing}. ` +
      `Minimum scopes: repo · workflow · pull_request:write. Nothing was saved.`
    );
  }
  const detail = validation.detail.trim().replace(/\.?$/, ".");
  return `Validation failed — ${detail} Nothing was saved.`;
}

interface ValidatedToken {
  validation: PatValidation;
  repos: number | null;
}

/**
 * P13-D-33: `architecture.md` asks for a targeted limit on PAT validation and
 * there was none. Both save paths below call GitHub with a token the CALLER
 * typed in, so the connection form is an unmetered outbound-probe surface (and
 * even honest retries spend the org's GitHub rate-limit budget). One token per
 * attempt, keyed on the actor. Returns null when allowed, or the typed refusal
 * message — same `validation_failed` shape the callers already render, so no
 * new UI branch is needed.
 */
function patValidationThrottle(actor: AuditActor): string | null {
  const key = actor.userId ?? actor.label;
  if (getPatValidationRateLimiter().tryConsume(key)) return null;
  return "Too many token validations — wait a few minutes and try again. Nothing was saved.";
}

/**
 * Full pre-save gate: scope validation + owner existence/repo count.
 * Returns a typed failure message; nothing is persisted here.
 */
async function validateConnectionToken(
  owner: string,
  token: string,
  options: ConnectionOptions,
): Promise<
  | { ok: true; result: ValidatedToken }
  | { ok: false; message: string }
> {
  const validation = await validatePatToken(token, {
    requiredScopes: [...CONNECTION_REQUIRED_SCOPES],
    repo: null,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  if (validation.status !== "valid") {
    return { ok: false, message: failureMessage(validation) };
  }

  // Owner existence + repo count (honest replacement for the mock's fake
  // `repos: 5`). A miss here refuses the save — the owner must be real.
  const client = createGithubClient({
    token,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  const user = await client.request<{ public_repos?: number }>(
    "GET",
    `/users/${owner}`,
  );
  if (!user.ok) {
    if (user.kind === "http" && user.status === 404) {
      return {
        ok: false,
        message: `Validation failed — github.com/${owner} was not found. Nothing was saved.`,
      };
    }
    if (user.kind === "network") {
      return {
        ok: false,
        message: `Validation failed — GitHub is unreachable. Nothing was saved.`,
      };
    }
    // Other HTTP failures: keep the connection (scope validation passed);
    // repo count just stays unknown.
    return { ok: true, result: { validation, repos: null } };
  }
  return {
    ok: true,
    result: {
      validation,
      repos:
        typeof user.data.public_repos === "number"
          ? user.data.public_repos
          : null,
    },
  };
}

export async function createConnection(
  db: DatabaseSync,
  input: { owner: string; token: string; userId: string },
  actor: AuditActor,
  options: ConnectionOptions = {},
): Promise<SaveConnectionResult> {
  const owner = input.owner.trim();
  const id = slugify(owner);
  if (!id) {
    return { status: "validation_failed", message: "Enter an owner name." };
  }
  if (getConnection(db, id)) {
    return { status: "duplicate", message: "That connection already exists." };
  }

  const throttled = patValidationThrottle(actor);
  if (throttled) return { status: "validation_failed", message: throttled };

  const gate = await validateConnectionToken(owner, input.token, options);
  if (!gate.ok) return { status: "validation_failed", message: gate.message };
  const { validation, repos } = gate.result;

  // Validation passed — NOW persist (encrypt token, cache validation).
  const pat = createPat(
    db,
    { userId: input.userId, label: `connection · ${owner}`, token: input.token },
    actor,
  );
  recordPatValidation(db, pat.id, validation);

  const now = new Date().toISOString();
  const isFirst =
    (db.prepare(`SELECT count(*) AS c FROM github_connections`).get() as {
      c: number;
    }).c === 0;
  db.prepare(
    `INSERT INTO github_connections
       (id, owner, pat_id, is_default, repos_count, expires_at,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, owner, pat.id, isFirst ? 1 : 0, repos, validation.expiresAt, now, now);
  recordAudit(db, {
    action: "org.connection.created",
    actor,
    subjectKind: "github_connection",
    subjectId: id,
    details: { owner, suffix: pat.tokenSuffix, default: isFirst },
  });

  const connection = getConnection(db, id)!;
  const expiry = formatCalendarDate(connection.expiresAt);
  return {
    status: "saved",
    connection,
    toast: `${owner} connected — scopes verified${expiry ? `, expires ${expiry}` : ""}`,
  };
}

export async function replaceConnectionToken(
  db: DatabaseSync,
  input: { connectionId: string; token: string },
  actor: AuditActor,
  options: ConnectionOptions = {},
): Promise<SaveConnectionResult> {
  const existing = getConnection(db, input.connectionId);
  if (!existing) {
    return { status: "not_found", message: "That connection no longer exists." };
  }

  const throttled = patValidationThrottle(actor);
  if (throttled) return { status: "validation_failed", message: throttled };

  const gate = await validateConnectionToken(
    existing.owner,
    input.token,
    options,
  );
  // "The old token stays active unless validation passes."
  if (!gate.ok) return { status: "validation_failed", message: gate.message };
  const { validation, repos } = gate.result;

  replacePatToken(db, existing.patId, input.token, actor);
  recordPatValidation(db, existing.patId, validation);
  db.prepare(
    `UPDATE github_connections
     SET repos_count = ?, expires_at = ?, updated_at = ?
     WHERE id = ?`,
  ).run(repos, validation.expiresAt, new Date().toISOString(), existing.id);
  recordAudit(db, {
    action: "org.connection.token_replaced",
    actor,
    subjectKind: "github_connection",
    subjectId: existing.id,
    details: { owner: existing.owner },
  });

  const connection = getConnection(db, existing.id)!;
  const expiry = formatCalendarDate(connection.expiresAt);
  return {
    status: "saved",
    connection,
    toast: `Token for ${existing.owner} replaced — scopes verified${expiry ? `, expires ${expiry}` : ""}`,
  };
}

export type SetDefaultResult =
  | { status: "ok"; toast: string }
  | { status: "not_found" };

/** Exactly one default, transactionally (spec §5 #3). */
export function setDefaultConnection(
  db: DatabaseSync,
  id: string,
  actor: AuditActor,
): SetDefaultResult {
  const target = getConnection(db, id);
  if (!target) return { status: "not_found" };
  withTransaction(db, () => {
    db.prepare(`UPDATE github_connections SET is_default = 0`).run();
    db.prepare(`UPDATE github_connections SET is_default = 1 WHERE id = ?`).run(
      id,
    );
  });
  recordAudit(db, {
    action: "org.connection.default_changed",
    actor,
    subjectKind: "github_connection",
    subjectId: id,
    details: { owner: target.owner },
  });
  return {
    status: "ok",
    toast: "Default connection updated — new projects start from it",
  };
}

export type RemoveConnectionResult =
  | { status: "removed"; toast: string }
  | { status: "is_default"; message: string }
  | { status: "not_found" };

/** Refuses to remove the default ("Set another connection as default first"). */
export function removeConnection(
  db: DatabaseSync,
  id: string,
  actor: AuditActor,
): RemoveConnectionResult {
  const existing = getConnection(db, id);
  if (!existing) return { status: "not_found" };
  if (existing.def) {
    return {
      status: "is_default",
      message: "Set another connection as default first",
    };
  }
  db.prepare(`DELETE FROM github_connections WHERE id = ?`).run(id);
  deletePat(db, existing.patId, actor);
  recordAudit(db, {
    action: "org.connection.removed",
    actor,
    subjectKind: "github_connection",
    subjectId: id,
    details: { owner: existing.owner },
  });
  return { status: "removed", toast: `${existing.owner} disconnected` };
}
