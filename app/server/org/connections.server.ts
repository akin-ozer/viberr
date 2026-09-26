import {
  credentialAdvisories,
  REPO_SCOPED_SCOPES,
  repoScopeProofsOf,
  type CredentialAdvisory,
} from "~/server/secrets/pat-store.server";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { withTransaction } from "~/server/db/transaction.server";
import {
  parsePatValidation,
  parseRepoScopeProofs,
  type PatTokenKind,
  type PatValidation,
} from "~/schemas/github-pat.schema";
import { reachSummary, type ConnectionReach, type ReachedRepo } from "~/shared/connection-reach";
import {
  parseConnectionReach,
  parseStoredReach,
  readTokenReach,
  unknownReach,
  withCreatedRepository,
  type StoredReach,
} from "./connection-reach.server";
import {
  recordAudit,
  SYSTEM_ACTOR,
  type AuditActor,
} from "~/server/audit/audit-recorder.server";
import { getPatValidationRateLimiter } from "~/server/auth/rate-limit.server";
import {
  createGithubClient,
  type GithubClientOptions,
} from "~/server/github/github-client.server";
import {
  createPat,
  deletePat,
  DEFAULT_REQUIRED_SCOPES,
  getPatToken,
  recordPatValidation,
  replacePatToken,
} from "~/server/secrets/pat-store.server";
import {
  validatePatToken,
  type ValidatePatTokenOptions,
} from "~/server/secrets/pat-validator.server";
import { slugify } from "~/shared/ids/slugify";
import { formatCalendarDate } from "~/shared/dates/format";

/**
 * Org-level GitHub OWNER connections (org-settings spec §3.1 / §4.1).
 *
 * A connection = owner + PAT. The token rides the phase-7 pat-store
 * (encrypted at rest, masked display, cached validation); this module owns
 * the org facts: default flag, expiry, and which repositories the token
 * reaches (ruling 463, `connection-reach.server.ts`). The whole surface is
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

export type ConnectionValidationState = "valid" | "failed" | "unvalidated";

/**
 * One scope's verdict as every connection surface renders it. `note` is only
 * present when the validator had something to add.
 */
export interface ConnectionScopeEvidence {
  id: string;
  ok: boolean;
  source: string;
  note?: string;
}

/**
 * Ruling 480 (F40-43): what one repository proved about the token, for the
 * scopes the token as a whole could not prove (a fine-grained token's `repo`
 * and `pull_request:write`). `proven` and `refused` are scope ids.
 */
export interface ConnectionRepoProof {
  repo: string;
  proven: string[];
  refused: string[];
}

export interface ConnectionRecord {
  id: string;
  owner: string;
  method: "PAT";
  patId: string;
  /** Masked token display, e.g. "····42af". */
  masked: string;
  def: boolean;
  /** Token expiry (ISO) when GitHub advertises one; null = none/unknown. */
  expiresAt: string | null;
  /** Whole days until expiry (may be negative); null when no expiry. */
  daysLeft: number | null;
  validationState: ConnectionValidationState;
  /** Ruling 463: the token's kind as the last validation read it; null when
   *  it was never validated. */
  tokenKind: PatTokenKind | null;
  /** The validator's own secret-free sentence when the last verdict failed;
   *  null otherwise. */
  validationDetail: string | null;
  /** Required scope ids the last validation found missing. */
  missingScopes: string[];
  /**
   * Ruling 463 (F40-6): which repositories the token reaches, read from
   * `GET /user/repos` whenever the token is validated (create, replace,
   * Re-check, the 24-hour re-proof). Null when no validation has read it yet;
   * a failed read is `unknown` with GitHub's reason, never an empty list. A
   * repository Viberr creates through the token joins a `read` list
   * (`recordCreatedRepositoryInReach`, ruling 463's dated note).
   */
  reach: ConnectionReach | null;
  /**
   * Per-scope evidence (P13-UI-01). A fine-grained PAT publishes no
   * `x-oauth-scopes` header, so the validator records `{ok:true,
   * source:"assumed"}` WITHOUT probing anything — and the panel painted a ✓ on
   * every scope anyway, next to copy promising "if any scope is missing the
   * token is refused". The first honest signal was a failed agent delivery.
   * `source` was already persisted and ignored; it now reaches the UI.
   */
  scopes: ConnectionScopeEvidence[];
  /**
   * Ruling 480 (F40-43): per-repository proof of the scopes `scopes` could not
   * prove for the token as a whole: an attached project's probe, or a branch,
   * push, pull request or merge Viberr made there. The card said "unproven.
   * Verified when attached to a project" while the proof it promised sat on
   * the project, unshown here.
   */
  repoProofs: ConnectionRepoProof[];
  /** Ruling 144(a): the same advisories the project credential card shows. */
  advisories: CredentialAdvisory[];
  lastValidatedAt: string | null;
  createdAt: string;
  /**
   * A4 (pass 23): how many projects are BOUND to this connection's credential
   * (`project_github_credentials`). Removing the connection deletes the PAT, and
   * `deletePat`'s bindings cascade — so every one of these projects loses branch
   * and PR sync the moment the connection goes. The remove-confirm reassured the
   * opposite ("Projects already created keep their repos") while naming only the
   * harmless half; this count lets it disclose the sync loss.
   */
  boundProjects: number;
}

type ConnectionRow = {
  id: string;
  owner: string;
  pat_id: string;
  is_default: number;
  expires_at: string | null;
  reach_json: string | null;
  created_at: string;
  token_suffix: string | null;
  last_validated_at: string | null;
  validation_json: string | null;
  repo_scopes_json: string | null;
  bound_projects: number;
};

function validationState(
  validation: PatValidation | null,
): ConnectionValidationState {
  if (!validation) return "unvalidated";
  return validation.status === "valid" ? "valid" : "failed";
}

/**
 * The token-wide evidence and the per-repository proofs a connection card
 * shows. A repository's probe is that repository's evidence (ruling 480): the
 * token's newest validation may be a project's repository-scoped one, and
 * painting its `repo` probe as a token-wide check claimed it for every
 * repository the token reaches. It is listed under its repository instead, and
 * reads "assumed" for the token as a whole. A scope the token proved as a
 * whole (a classic token's header) needs no repository line.
 */
interface ConnectionEvidence {
  scopes: ConnectionScopeEvidence[];
  repoProofs: ConnectionRepoProof[];
}

function connectionEvidence(
  validation: PatValidation | null,
  repoScopesJson: string | null,
): ConnectionEvidence {
  const scopes = (validation?.scopes ?? []).map((sc) => {
    if (REPO_SCOPED_SCOPES.has(sc.id) && sc.source === "probe") {
      return {
        id: sc.id,
        ok: true,
        source: "assumed",
        note: "proven per repository, not for the token as a whole",
      };
    }
    const scope: ConnectionScopeEvidence = {
      id: sc.id,
      ok: sc.ok,
      source: sc.source,
    };
    if (sc.note) scope.note = sc.note;
    return scope;
  });
  const tokenWide = new Set(
    scopes.flatMap((sc) => (sc.source === "assumed" ? [] : [sc.id])),
  );
  const repoProofs = repoScopeProofsOf({
    validation,
    repoScopes: parseRepoScopeProofs(repoScopesJson),
  }).flatMap((proof) => {
    const own = proof.scopes.filter((sc) => !tokenWide.has(sc.id));
    if (own.length === 0) return [];
    return [
      {
        repo: proof.repo,
        proven: own.flatMap((sc) => (sc.ok ? [sc.id] : [])),
        refused: own.flatMap((sc) => (sc.ok ? [] : [sc.id])),
      },
    ];
  });
  return { scopes, repoProofs };
}

function mapRow(row: ConnectionRow, now = new Date()): ConnectionRecord {
  const validation = parsePatValidation(row.validation_json);
  const evidence = connectionEvidence(validation, row.repo_scopes_json);
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
    expiresAt,
    daysLeft,
    validationState: validationState(validation),
    tokenKind: validation?.tokenKind ?? null,
    validationDetail:
      validation && validation.status !== "valid" ? validation.detail : null,
    missingScopes: validation?.missingScopes ?? [],
    reach: parseConnectionReach(row.reach_json),
    scopes: evidence.scopes,
    repoProofs: evidence.repoProofs,
    advisories: credentialAdvisories(validation, []),
    lastValidatedAt: row.last_validated_at,
    createdAt: row.created_at,
    boundProjects: row.bound_projects,
  };
}

const LIST_SQL = `
  SELECT c.id, c.owner, c.pat_id, c.is_default, c.expires_at, c.reach_json,
         c.created_at, p.token_suffix, p.last_validated_at, p.validation_json,
         p.repo_scopes_json,
         (SELECT COUNT(*) FROM project_github_credentials b
            WHERE b.pat_id = c.pat_id) AS bound_projects
  FROM github_connections c
  LEFT JOIN github_pats p ON p.id = c.pat_id`;

/**
 * Why every reader below may name its rows `ConnectionRow`: LIST_SQL selects
 * exactly the columns that type declares. In 0001_baseline
 * `github_connections.id / owner / pat_id / created_at` are TEXT NOT NULL and
 * `is_default` is INTEGER NOT NULL, while `expires_at` and `reach_json` are
 * nullable; the LEFT JOIN can additionally leave every `github_pats` column
 * null, which is why those four are typed nullable.
 */
export function listConnections(db: DatabaseSync): ConnectionRecord[] {
  // SAFETY: LIST_SQL's column list is ConnectionRow's (see above).
  const rows = db
    .prepare(`${LIST_SQL} ORDER BY c.created_at ASC, c.id ASC`)
    .all() as ConnectionRow[];
  return rows.map((r) => mapRow(r));
}

export function getConnection(
  db: DatabaseSync,
  id: string,
): ConnectionRecord | null {
  // SAFETY: LIST_SQL's column list is ConnectionRow's; `id` is the primary key,
  // so at most one row comes back.
  const row = db.prepare(`${LIST_SQL} WHERE c.id = ?`).get(id) as
    | ConnectionRow
    | undefined;
  return row ? mapRow(row) : null;
}

/** The default connection (at most one). */
export function getDefaultConnection(
  db: DatabaseSync,
): ConnectionRecord | null {
  // SAFETY: LIST_SQL's column list is ConnectionRow's; `setDefaultConnection`
  // keeps `is_default = 1` on at most one row.
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

/**
 * How long a connection's cached `valid` verdict is trusted before the next
 * consumer re-proves it (B-GH7). Nothing polls GitHub for connection health,
 * so without this a token revoked on github.com keeps clearing every gate that
 * reads `validationState` until a human opens org settings and re-checks by
 * hand — and token expiry only ever showed as a ≤30-day badge.
 */
const CONNECTION_REVALIDATE_AFTER_MS = 24 * 60 * 60 * 1000;

export interface FreshnessOptions extends ConnectionOptions {
  /** Clock hook for tests. */
  now?: () => number;
}

/**
 * Opportunistic staleness check for one connection, run where a token is about
 * to be USED. At most ONE probe: only a `valid` verdict older than
 * `CONNECTION_REVALIDATE_AFTER_MS` is re-asked, with `repo: null` — the same
 * question the connection modal asked — and the answer replaces the cache that
 * every connection surface renders.
 *
 * A `network_error` is NOT a downgrade: it evaluated nothing, and caching it
 * would turn twenty unreachable seconds into "this connection failed" on the
 * org page. Only GitHub's own verdict can demote a connection.
 */
export async function ensureConnectionFresh(
  db: DatabaseSync,
  id: string,
  options: FreshnessOptions = {},
): Promise<ConnectionRecord | null> {
  const connection = getConnection(db, id);
  if (!connection || connection.validationState !== "valid") return connection;

  const now = (options.now ?? Date.now)();
  const age =
    connection.lastValidatedAt !== null
      ? now - Date.parse(connection.lastValidatedAt)
      : Number.POSITIVE_INFINITY;
  if (Number.isFinite(age) && age >= 0 && age < CONNECTION_REVALIDATE_AFTER_MS) {
    return connection;
  }

  const token = getPatToken(db, connection.patId);
  if (!token) return connection;
  const probe: ValidatePatTokenOptions = {
    requiredScopes: [...DEFAULT_REQUIRED_SCOPES],
    repo: null,
    knownExpiresAt: connection.expiresAt,
  };
  // Only a test hands one over; production must reach the real `fetch`.
  if (options.fetchImpl) probe.fetchImpl = options.fetchImpl;
  const validation = await validatePatToken(token, probe);
  if (validation.status === "network_error") return connection;

  // Ruling 463: a re-proof is a validation, so it re-reads the reach too.
  const reach = await reachFor(token, validation, options);
  recordPatValidation(db, connection.patId, validation);
  db.prepare(
    `UPDATE github_connections SET expires_at = ?, reach_json = ?, updated_at = ? WHERE id = ?`,
  ).run(
    validation.expiresAt,
    JSON.stringify(reach),
    new Date(now).toISOString(),
    connection.id,
  );
  if (validation.status !== "valid") {
    recordAudit(db, {
      action: "org.connection.validation_downgraded",
      actor: SYSTEM_ACTOR,
      subjectKind: "github_connection",
      subjectId: connection.id,
      details: {
        owner: connection.owner,
        status: validation.status,
        detail: validation.detail,
      },
    });
  }
  return getConnection(db, connection.id);
}

/**
 * `getDefaultConnectionToken` with the staleness check in front of it — the
 * async form for callers that can await (store import, credential attach).
 * A connection GitHub has since rejected returns null here instead of handing
 * out a dead token.
 */
export async function getDefaultConnectionTokenFresh(
  db: DatabaseSync,
  options: FreshnessOptions = {},
): Promise<{ connection: ConnectionRecord; token: string } | null> {
  const current = getDefaultConnection(db);
  if (!current) return null;
  await ensureConnectionFresh(db, current.id, options);
  return getDefaultConnectionToken(db);
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
    // B-GH2: the minimum is READ off the required set, never re-typed. This
    // sentence named `workflow` for three passes after the owner dropped it —
    // telling people to widen a token Viberr no longer wants.
    return (
      `Validation failed — token is missing ${missing}. ` +
      `Minimum scopes: ${DEFAULT_REQUIRED_SCOPES.join(" · ")}. Nothing was saved.`
    );
  }
  const detail = validation.detail.trim().replace(/\.?$/, ".");
  return `Validation failed — ${detail} Nothing was saved.`;
}

interface ValidatedToken {
  validation: PatValidation;
  reach: StoredReach;
}

/**
 * Ruling 463: the reach a validation's verdict allows reading. A token GitHub
 * has just refused reaches nothing Viberr can learn, so its reach is unknown
 * with that reason instead of a read that could only fail the same way.
 */
async function reachFor(
  token: string,
  validation: PatValidation,
  options: ConnectionOptions,
): Promise<StoredReach> {
  if (validation.status !== "valid") {
    return unknownReach(
      `The token failed validation (${validation.status.replaceAll("_", " ")}), so which repositories it reaches was not read.`,
    );
  }
  return readTokenReach(token, options);
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
 * Full pre-save gate: scope validation + owner existence, then what the token
 * reaches (ruling 463; a failed reach read never refuses the save, it is
 * stored as unknown). Returns a typed failure message; nothing is persisted
 * here.
 */
async function validateConnectionToken(
  owner: string,
  token: string,
  options: ConnectionOptions,
): Promise<
  | { ok: true; result: ValidatedToken }
  | { ok: false; message: string }
> {
  const probe: ValidatePatTokenOptions = {
    requiredScopes: [...DEFAULT_REQUIRED_SCOPES],
    repo: null,
  };
  // Only a test hands one over; production must reach the real `fetch`.
  if (options.fetchImpl) probe.fetchImpl = options.fetchImpl;
  const validation = await validatePatToken(token, probe);
  if (validation.status !== "valid") {
    return { ok: false, message: failureMessage(validation) };
  }

  // Owner existence. A miss here refuses the save — the owner must be real.
  // Ruling 463: nothing else is read off this answer. The account's
  // `public_repos` it carries used to be shown on the card as "3 public
  // repos", which says nothing about what the TOKEN reaches.
  const clientOptions: GithubClientOptions = { token };
  if (options.fetchImpl) clientOptions.fetchImpl = options.fetchImpl;
  const client = createGithubClient(clientOptions);
  const user = await client.request("GET", `/users/${owner}`, z.unknown());
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
    // Other HTTP failures: keep the connection (scope validation passed).
  }
  return {
    ok: true,
    result: { validation, reach: await reachFor(token, validation, options) },
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
  const { validation, reach } = gate.result;

  // Validation passed — NOW persist (encrypt token, cache validation).
  const pat = createPat(
    db,
    { userId: input.userId, label: `connection · ${owner}`, token: input.token },
    actor,
  );
  recordPatValidation(db, pat.id, validation);

  const now = new Date().toISOString();
  // SAFETY: `SELECT count(*) AS c` is an aggregate with no GROUP BY — sqlite
  // answers it with exactly one row carrying the single integer column `c`.
  const isFirst =
    (db.prepare(`SELECT count(*) AS c FROM github_connections`).get() as {
      c: number;
    }).c === 0;
  db.prepare(
    `INSERT INTO github_connections
       (id, owner, pat_id, is_default, expires_at, reach_json,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    owner,
    pat.id,
    isFirst ? 1 : 0,
    validation.expiresAt,
    JSON.stringify(reach),
    now,
    now,
  );
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
    toast: `${owner} connected — scopes verified${expiry ? `, expires ${expiry}` : ""}${reachClause(connection)}`,
  };
}

/** Ruling 463: what a save or Re-check read, for its toast. */
function reachClause(connection: ConnectionRecord): string {
  const reach = connection.reach;
  if (reach?.status === "read") return `. It reaches ${reachSummary(reach)}`;
  if (reach?.status === "unknown") {
    return `. Which repositories it reaches could not be read: ${reach.reason}`;
  }
  return "";
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
  const { validation, reach } = gate.result;

  replacePatToken(db, existing.patId, input.token, actor);
  recordPatValidation(db, existing.patId, validation);
  db.prepare(
    `UPDATE github_connections
     SET expires_at = ?, reach_json = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    validation.expiresAt,
    JSON.stringify(reach),
    new Date().toISOString(),
    existing.id,
  );
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
    toast: `Token for ${existing.owner} replaced — scopes verified${expiry ? `, expires ${expiry}` : ""}${reachClause(connection)}`,
  };
}

export type RecheckConnectionResult =
  | { status: "rechecked"; connection: ConnectionRecord; toast: string }
  | { status: "refused"; message: string }
  | { status: "not_found"; message: string };

/**
 * Ruling 463: "Re-check" on a connection's card. Validates the STORED token
 * again and re-reads what it reaches — the one way to read the reach of a
 * connection saved before the read existed without pasting its token again.
 *
 * GitHub's own verdict replaces the cache either way, a refusal included
 * (that is what a re-check is for); an unreachable GitHub evaluated nothing,
 * so it changes nothing, the same rule `ensureConnectionFresh` keeps. Metered
 * like a save: it spends the same GitHub calls.
 */
export async function recheckConnection(
  db: DatabaseSync,
  connectionId: string,
  actor: AuditActor,
  options: ConnectionOptions = {},
): Promise<RecheckConnectionResult> {
  const existing = getConnection(db, connectionId);
  if (!existing) {
    return { status: "not_found", message: "That connection no longer exists." };
  }
  const throttled = patValidationThrottle(actor);
  if (throttled) return { status: "refused", message: throttled };
  const token = getPatToken(db, existing.patId);
  if (!token) {
    return {
      status: "refused",
      message: `The stored token for ${existing.owner} cannot be read. Update the token to check it again.`,
    };
  }
  const probe: ValidatePatTokenOptions = {
    requiredScopes: [...DEFAULT_REQUIRED_SCOPES],
    repo: null,
    knownExpiresAt: existing.expiresAt,
  };
  // Only a test hands one over; production must reach the real `fetch`.
  if (options.fetchImpl) probe.fetchImpl = options.fetchImpl;
  const validation = await validatePatToken(token, probe);
  if (validation.status === "network_error") {
    return {
      status: "refused",
      message: `${validation.detail.trim().replace(/\.?$/, ".")} Nothing changed.`,
    };
  }
  const reach = await reachFor(token, validation, options);
  recordPatValidation(db, existing.patId, validation);
  db.prepare(
    `UPDATE github_connections SET expires_at = ?, reach_json = ?, updated_at = ? WHERE id = ?`,
  ).run(validation.expiresAt, JSON.stringify(reach), new Date().toISOString(), existing.id);
  const connection = getConnection(db, existing.id)!;
  recordAudit(db, {
    action: "org.connection.rechecked",
    actor,
    subjectKind: "github_connection",
    subjectId: existing.id,
    details: {
      owner: existing.owner,
      status: validation.status,
      reach:
        connection.reach?.status === "read"
          ? reachSummary(connection.reach)
          : "unknown",
    },
  });
  if (validation.status !== "valid") {
    const why =
      validation.status === "insufficient_scope"
        ? `the token is missing ${validation.missingScopes.join(" · ") || "required scopes"}.`
        : validation.detail.trim().replace(/\.?$/, ".");
    return {
      status: "refused",
      message: `Re-checked ${existing.owner}: ${why} The connection now shows the failed validation.`,
    };
  }
  return {
    status: "rechecked",
    connection,
    toast: `${existing.owner} re-checked: scopes verified${reachClause(connection)}`,
  };
}

/**
 * Ruling 463's dated note (pre-merge review R-seams-4): Viberr just created
 * `repo` through this connection's token (ruling 462), so the stored reach
 * lists it. Otherwise the card undercounts and `list_github_connections` tells
 * the controller the token cannot see the repository it has just made, until
 * a Re-check or the 24-hour re-proof reads the list again. A reach not read,
 * or read as unknown, is left for those. No GitHub call; returns whether the
 * stored reach changed.
 */
export function recordCreatedRepositoryInReach(
  db: DatabaseSync,
  connectionId: string,
  repo: ReachedRepo,
): boolean {
  // SAFETY: `reach_json` is nullable TEXT on `github_connections`; the row may
  // be gone (a connection removed mid-creation), which reads as no row.
  const row = db
    .prepare(`SELECT reach_json FROM github_connections WHERE id = ?`)
    .get(connectionId) as { reach_json: string | null } | undefined;
  const stored = parseStoredReach(row?.reach_json ?? null);
  const next = stored ? withCreatedRepository(stored, repo) : null;
  if (!next) return false;
  db.prepare(`UPDATE github_connections SET reach_json = ?, updated_at = ? WHERE id = ?`).run(
    JSON.stringify(next),
    new Date().toISOString(),
    connectionId,
  );
  return true;
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
