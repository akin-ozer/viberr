import type { DatabaseSync } from "node:sqlite";
import type {
  PatTokenKind,
  PatValidation,
  ScopeCheck,
} from "~/schemas/github-pat.schema";
import {
  recordAudit,
  type AuditActor,
  SYSTEM_ACTOR,
} from "~/server/audit/audit-recorder.server";
import { createGithubClient } from "~/server/github/github-client.server";
import { resolveScopeViolationWithEvent } from "~/server/github/scope-flag.server";
import {
  listScopeViolations,
  type ScopeViolationRecord,
} from "~/server/projections/policy-violations.server";
import {
  DEFAULT_REQUIRED_SCOPES,
  getPatToken,
  getProjectCredential,
  recordPatValidation,
} from "./pat-store.server";

/**
 * PAT validator (Phase 7): probes GitHub with a stored token and produces
 * typed diagnostics — `valid`, `insufficient_scope` (which scopes),
 * `expired`, `revoked`, `repo_not_found`, `org_approval_missing`,
 * `network_error`. Results are cached on the PAT row
 * (validation_json + last_validated_at).
 *
 * HONESTY NOTES (GitHub API limitations, researched 2026):
 * - CLASSIC tokens (`ghp_…`) list their scopes in the `x-oauth-scopes`
 *   response header → scope checks are authoritative (`source: "header"`).
 *   The classic `repo` scope implies pull-request write; `admin:org` /
 *   `write:org` imply `read:org`.
 * - FINE-GRAINED tokens (`github_pat_…`) return NO scope header and GitHub
 *   offers no introspection endpoint. We probe read-only endpoints where
 *   one exists (`/repos/{r}` for repo access, `/user/orgs` for org read,
 *   `/repos/{r}/pulls` for pull-request READ) and mark write permissions
 *   `source: "assumed"` — treated as granted until a real 403 opens a
 *   scope violation (ruling 5). A safe write-probe does not exist.
 * - Expired vs revoked on a 401 is a heuristic: GitHub says "…token
 *   expired…" for expired fine-grained tokens and "Bad credentials" for
 *   revoked/unknown ones. Tokens WITH an expiration also advertise it via
 *   the `github-authentication-token-expiration` header on success — we
 *   cache it and classify a later 401 as `expired` when that date passed.
 * - A fine-grained token pending organization approval usually surfaces as
 *   404 on org repos — indistinguishable from `repo_not_found`. We report
 *   `org_approval_missing` only when the 403 message mentions approval /
 *   access policy; otherwise a 404 is reported as `repo_not_found` with a
 *   note about the ambiguity.
 */

export interface ValidatePatTokenOptions {
  /** Scope ids to check (mock vocabulary). Default: project policy list. */
  requiredScopes?: string[];
  /** "owner/name" to verify repo access against (skipped when null). */
  repo?: string | null;
  /** Cached expiration from a previous run (improves 401 classification). */
  knownExpiresAt?: string | null;
  /** Mock-transport hook for tests. */
  fetchImpl?: typeof fetch;
}

function tokenKindOf(token: string, scopesHeader: string | null): PatTokenKind {
  if (token.startsWith("github_pat_")) return "fine_grained";
  if (token.startsWith("ghp_") || token.startsWith("gho_")) return "classic";
  return scopesHeader ? "classic" : "unknown";
}

function classicScopeCheck(id: string, granted: Set<string>): ScopeCheck {
  if (granted.has(id)) return { id, ok: true, source: "header" };
  if (id === "pull_request:write" && granted.has("repo")) {
    return { id, ok: true, source: "header", note: "implied by `repo`" };
  }
  if (
    id === "read:org" &&
    (granted.has("admin:org") || granted.has("write:org"))
  ) {
    return { id, ok: true, source: "header", note: "implied by org scope" };
  }
  return { id, ok: false, source: "header" };
}

interface GhUser {
  login: string;
}

/**
 * Pure network validation of a plaintext token (no DB). `validatePat`
 * wraps it with token decryption + result caching.
 */
export async function validatePatToken(
  token: string,
  options: ValidatePatTokenOptions = {},
): Promise<PatValidation> {
  const requiredScopes = options.requiredScopes ?? [...DEFAULT_REQUIRED_SCOPES];
  const repo = options.repo ?? null;
  const checkedAt = new Date().toISOString();
  const client = createGithubClient({
    token,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });

  const base = {
    checkedAt,
    login: null as string | null,
    tokenKind: tokenKindOf(token, null),
    expiresAt: options.knownExpiresAt ?? null,
    repo,
    scopes: [] as ScopeCheck[],
    missingScopes: [] as string[],
  };

  // 1. Identity — /user.
  const user = await client.request<GhUser>("GET", "/user");
  if (!user.ok) {
    if (user.kind === "network") {
      return {
        ...base,
        status: "network_error",
        detail: `GitHub is unreachable: ${user.message}`,
      };
    }
    if (user.kind === "http" && user.status === 401) {
      const expiredByMessage = /expired/i.test(user.message);
      const expiredByDate =
        options.knownExpiresAt !== null &&
        options.knownExpiresAt !== undefined &&
        Date.parse(options.knownExpiresAt) < Date.now();
      if (expiredByMessage || expiredByDate) {
        return {
          ...base,
          status: "expired",
          detail: "The token has expired — generate a new one on GitHub.",
        };
      }
      return {
        ...base,
        status: "revoked",
        detail:
          "GitHub rejected the token (bad credentials) — it was revoked or never valid.",
      };
    }
    // A GitHub-side outage (5xx) never evaluated the token — say so, or a
    // degraded GitHub reads as "your token is bad" in the connection modal.
    if (user.kind === "http" && user.status >= 500) {
      return {
        ...base,
        status: "network_error",
        detail:
          `GitHub's API is degraded right now (HTTP ${user.status} on /user) — ` +
          "the token was NOT rejected. Try again in a few minutes.",
      };
    }
    return {
      ...base,
      status: "network_error",
      detail: `GitHub /user returned ${user.kind === "http" ? user.status : user.kind}: ${
        user.kind === "http" ? user.message : ""
      }`.trim(),
    };
  }

  const login = user.data.login ?? null;
  const scopesHeader = user.scopesHeader;
  const tokenKind = tokenKindOf(token, scopesHeader);
  const expiresAt = user.tokenExpiration ?? options.knownExpiresAt ?? null;
  const withIdentity = { ...base, login, tokenKind, expiresAt };

  // 2. Repo access — /repos/{owner}/{repo}.
  let repoAccessible: boolean | null = null;
  if (repo) {
    const repoResult = await client.request<{ full_name: string }>(
      "GET",
      `/repos/${repo}`,
    );
    if (repoResult.ok) {
      repoAccessible = true;
    } else if (repoResult.kind === "network") {
      return {
        ...withIdentity,
        status: "network_error",
        detail: `GitHub is unreachable: ${repoResult.message}`,
      };
    } else if (repoResult.kind === "http" && repoResult.status >= 500) {
      // Same honesty rule as /user: an outage is not a repo-access verdict.
      return {
        ...withIdentity,
        status: "network_error",
        detail:
          `GitHub's API is degraded right now (HTTP ${repoResult.status} on /repos/${repo}) — ` +
          "the token was NOT rejected. Try again in a few minutes.",
      };
    } else if (repoResult.kind === "http" && repoResult.status === 404) {
      return {
        ...withIdentity,
        status: "repo_not_found",
        detail:
          `The token cannot see \`${repo}\` — the repository does not exist, ` +
          "the token was not granted access to it, or a required organization " +
          "approval is still pending (GitHub reports all three as 404).",
      };
    } else if (repoResult.kind === "http" && repoResult.status === 403) {
      if (/approval|access policy|organization/i.test(repoResult.message)) {
        return {
          ...withIdentity,
          status: "org_approval_missing",
          detail:
            `Access to \`${repo}\` is blocked pending organization approval ` +
            `of the token: ${repoResult.message}`,
        };
      }
      repoAccessible = false;
    } else {
      repoAccessible = false;
    }
  }

  // 3. Scope introspection.
  const scopes: ScopeCheck[] = [];
  if (scopesHeader !== null && scopesHeader !== "") {
    // Classic token: the header is authoritative.
    const granted = new Set(
      scopesHeader.split(",").flatMap((s) => {
        const scope = s.trim();
        return scope ? [scope] : [];
      }),
    );
    for (const id of requiredScopes) {
      scopes.push(classicScopeCheck(id, granted));
    }
  } else {
    // Fine-grained (or headerless) token: probe what can be probed.
    let orgReadOk: boolean | null = null;
    if (requiredScopes.includes("read:org")) {
      const orgs = await client.request<unknown[]>("GET", "/user/orgs", {
        searchParams: { per_page: 1 },
      });
      // 4xx = the probe was refused; 5xx/network = unknown (assumed, not failed).
      orgReadOk = orgs.ok
        ? true
        : orgs.kind === "http" && orgs.status < 500
          ? false
          : null;
    }
    let pullsReadOk: boolean | null = null;
    if (repo && requiredScopes.includes("pull_request:write")) {
      const pulls = await client.request<unknown[]>(
        "GET",
        `/repos/${repo}/pulls`,
        { searchParams: { per_page: 1, state: "all" } },
      );
      pullsReadOk = pulls.ok
        ? true
        : pulls.kind === "http" && pulls.status < 500
          ? false
          : null;
    }
    for (const id of requiredScopes) {
      if (id === "repo" && repoAccessible !== null) {
        scopes.push({
          id,
          ok: repoAccessible,
          source: "probe",
          note: `repository ${repoAccessible ? "readable" : "not readable"}`,
        });
      } else if (id === "read:org" && orgReadOk !== null) {
        scopes.push({ id, ok: orgReadOk, source: "probe" });
      } else if (id === "pull_request:write" && pullsReadOk === false) {
        scopes.push({
          id,
          ok: false,
          source: "probe",
          note: "pull-request read probe was refused",
        });
      } else if (id === "pull_request:write" && pullsReadOk === true) {
        scopes.push({
          id,
          ok: true,
          source: "assumed",
          note: "read proven; write is unverifiable until used",
        });
      } else {
        scopes.push({
          id,
          ok: true,
          source: "assumed",
          note: "fine-grained tokens expose no scope introspection",
        });
      }
    }
  }

  const missingScopes = scopes.flatMap((s) => (s.ok ? [] : [s.id]));
  if (missingScopes.length > 0) {
    return {
      ...withIdentity,
      status: "insufficient_scope",
      scopes,
      missingScopes,
      detail: `Missing scope${missingScopes.length > 1 ? "s" : ""}: ${missingScopes.join(", ")}.`,
    };
  }
  return {
    ...withIdentity,
    status: "valid",
    scopes,
    missingScopes: [],
    detail: login ? `Authenticated as ${login}.` : "Token accepted.",
  };
}

/**
 * Validates a STORED PAT and caches the result on its row. Returns null
 * when the PAT id is unknown.
 */
export async function validatePat(
  db: DatabaseSync,
  patId: string,
  options: ValidatePatTokenOptions = {},
): Promise<PatValidation | null> {
  const token = getPatToken(db, patId);
  if (token === null) return null;
  const validation = await validatePatToken(token, options);
  recordPatValidation(db, patId, validation);
  return validation;
}

// ------------------------------------------------- grant / re-check flow

export type RevalidateProjectCredentialResult =
  | { status: "no_pat_configured" }
  | { status: "network_unavailable"; validation: PatValidation }
  | {
      status: "revalidated";
      validation: PatValidation;
      /** Violations this run resolved (typed policy events written). */
      resolvedViolations: ScopeViolationRecord[];
    };

export interface RevalidateContext {
  dataRoot?: string;
  fetchImpl?: typeof fetch;
  /** Repo to check against; defaults to the project's default repo row. */
  repo?: string | null;
}

/**
 * The real "Grant scope" / "Re-check scopes" backend (settings spec §5.4):
 * re-validates the project credential and resolves every open scope
 * violation whose scope the fresh validation now reports granted
 * (header/probe ok, or `assumed` for unverifiable fine-grained write
 * permissions — the next real 403 reopens it). Each resolution writes the
 * typed `policy` timeline event into the violation's OWN task (ruling 5),
 * reprojects it, and audits via the violations API. SSE fan-out rides the
 * emitted projection/violation events.
 */
export async function revalidateProjectCredential(
  db: DatabaseSync,
  projectSlug: string,
  actor: AuditActor = SYSTEM_ACTOR,
  ctx: RevalidateContext = {},
): Promise<RevalidateProjectCredentialResult> {
  // Governed action (Phase 10): the grant/re-check ATTEMPT itself is
  // audited with its outcome — not only the violation resolutions.
  const auditAttempt = (
    outcome: RevalidateProjectCredentialResult["status"],
    extra: Record<string, unknown> = {},
  ) =>
    recordAudit(db, {
      action: "github.credential.revalidated",
      actor,
      subjectKind: "github_credential",
      subjectId: projectSlug,
      projectSlug,
      details: { outcome, ...extra },
    });

  const credential = getProjectCredential(db, projectSlug);
  if (!credential) {
    auditAttempt("no_pat_configured");
    return { status: "no_pat_configured" };
  }

  const projectRow = db
    .prepare(
      `SELECT repo, credential_policy_json FROM projects WHERE slug = ?`,
    )
    .get(projectSlug) as
    | { repo: string | null; credential_policy_json: string | null }
    | undefined;

  let requiredScopes: string[] | undefined;
  if (projectRow?.credential_policy_json) {
    try {
      const parsed = JSON.parse(projectRow.credential_policy_json) as {
        requiredScopes?: unknown;
      };
      if (Array.isArray(parsed.requiredScopes) && parsed.requiredScopes.length) {
        requiredScopes = parsed.requiredScopes.filter(
          (s): s is string => typeof s === "string",
        );
      }
    } catch {
      // tolerated — fall through to defaults
    }
  }

  const validation = await validatePat(db, credential.id, {
    repo: ctx.repo !== undefined ? ctx.repo : (projectRow?.repo ?? null),
    ...(requiredScopes ? { requiredScopes } : {}),
    knownExpiresAt: credential.validation?.expiresAt ?? null,
    ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
  });
  if (!validation) {
    auditAttempt("no_pat_configured");
    return { status: "no_pat_configured" };
  }
  if (validation.status === "network_error") {
    auditAttempt("network_unavailable");
    return { status: "network_unavailable", validation };
  }

  const grantedScopes = new Set(
    validation.scopes.flatMap((s) => (s.ok ? [s.id] : [])),
  );
  const resolvedViolations: ScopeViolationRecord[] = [];
  for (const violation of listScopeViolations(db, projectSlug, {
    status: "open",
  })) {
    if (!grantedScopes.has(violation.scope)) continue;
    const result = await resolveScopeViolationWithEvent(
      db,
      violation.id,
      actor,
      { dataRoot: ctx.dataRoot },
    );
    if (result?.resolved) resolvedViolations.push(result.violation);
  }
  auditAttempt("revalidated", {
    validationStatus: validation.status,
    resolvedViolations: resolvedViolations.length,
  });
  return { status: "revalidated", validation, resolvedViolations };
}
