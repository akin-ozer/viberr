import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
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
import { getEnv } from "~/server/config/env.server";
import {
  createGithubClient,
  type GithubClientOptions,
} from "~/server/github/github-client.server";
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
 *   one exists (`/repos/{r}` for repo access + its `permissions` block,
 *   `/user/orgs` for org read, `/repos/{r}/pulls` for pull-request READ) and
 *   mark anything still unprovable `source: "assumed"` — treated as granted
 *   until a real 403 opens a scope violation (ruling 5).
 * - REPOSITORY WRITE is proven READ-ONLY (A8/pass-16): `GET /repos/{r}`
 *   returns a `permissions` object computed for the AUTHENTICATED token, so
 *   `permissions.push` answers "can this credential write to this repo?"
 *   without touching the repository. The previous prover was an empty-payload
 *   dry-run `PUT /repos/{r}/contents/viberr-scope-probe` — non-destructive by
 *   construction (GitHub authorizes before validating the body, so `{}` can
 *   only 422) but still a WRITE request issued against a real user repository
 *   on every revalidation: it lands in the org audit log, it can trip rulesets
 *   and branch-protection tooling, and it is one GitHub validation-ordering
 *   change away from actually creating a file. Health checks do not write.
 *   The dry-run survives only as an explicit, disclosed opt-in
 *   (`VIBERR_GITHUB_WRITE_PROBE=1`) for operators who
 *   want `pull_request:write` proven rather than assumed — that one has no
 *   read-only signal (a fine-grained token can hold Contents:write while
 *   Pull requests is read-only, so `permissions.push` must NOT be read as
 *   proof of it).
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

/** The one opt-in to the authorization-only WRITE dry-run for scopes with no
 *  read-only signal (A8). Default OFF: validation, and a "Re-check scopes"
 *  press, never write to a user's repository unless someone asked for it.
 *  Consequence, deliberately: `pull_request:write` stays `assumed`, and B-GH8
 *  (write scopes need PROVEN evidence) keeps its violation open until a real
 *  delivery succeeds or an operator opts in; turning "we don't know" into
 *  "granted" is the failure B-GH8 exists to prevent. The env schema parses
 *  `VIBERR_GITHUB_WRITE_PROBE` and refuses a spelling it does not know at boot
 *  (ruling 458(c)). */
function writeProbeEnabled(): boolean {
  return getEnv().VIBERR_GITHUB_WRITE_PROBE;
}

/** The legacy permission block GitHub computes for the AUTHENTICATED token on
 *  `GET /repos/{owner}/{repo}` — the read-only proof of repository write. The
 *  one decoder of it: this validator, the project-repair probe
 *  (`settings-actions.server.ts`) and the create probe
 *  (`project-create.server.ts`) all read the block through it, each inside its
 *  own response wrapper.
 *
 *  Per-FIELD tolerance (F21-11): one drifted key must not void the block. It
 *  did — five strict booleans inside a block-level catch meant a single
 *  non-boolean (`triage: "yes"`) discarded a `push: false` sitting right next
 *  to it, and a read-only repository then came back `repoWriteOk: null` →
 *  scope `source: "assumed"` → status `valid`. A silent UPGRADE: the credential
 *  card claimed write access GitHub had just denied. Each key now degrades on
 *  its own, so what GitHub DID assert still counts. */
export const repoPermissionsSchema = z.object({
  admin: z.boolean().optional().catch(undefined),
  maintain: z.boolean().optional().catch(undefined),
  push: z.boolean().optional().catch(undefined),
  triage: z.boolean().optional().catch(undefined),
  pull: z.boolean().optional().catch(undefined),
});

type RepoPermissions = z.infer<typeof repoPermissionsSchema>;

/** `GET /repos/{owner}/{repo}`, narrowed to the one block we read. A block in
 *  an unexpected shape reads as ABSENT rather than voiding the response: the
 *  repo itself was still reachable, we just learned nothing about write. */
const repoResponseSchema = z.object({
  permissions: repoPermissionsSchema.optional().catch(undefined),
});

/** True/false when GitHub answered, null when it sent no `permissions` block
 *  (an older GHES, or a response shape we should not guess about). A block that
 *  arrived with a drifted key is NOT "no block": the keys that did decode are
 *  answers, and `push === false` among them is the proven read-only repo.
 *
 *  F20-15: a project exists to push branches and open PRs, so a repo the
 *  credential can only READ is not deliverable — on `false` the Change probe
 *  refuses where the board writes its repository (ruling 669) and the create
 *  probe warns. The third state is on purpose: absent or
 *  unreadable is "unknown", never a refusal; only a PROVEN read-only repo is.
 *  `admin` and `maintain` need no third state: either GitHub asserted one or it
 *  did not. */
export function repoWritable(
  permissions: RepoPermissions | null | undefined,
): boolean | null {
  if (!permissions) return null;
  const { admin, maintain, push } = permissions;
  if (admin === true || maintain === true || push === true) return true;
  if (push === false) return false;
  return null;
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

/** `GET /user` — only the login is read, with a `?? null`, so it parses to
 *  `undefined` on drift and the identity just stays unknown. */
const ghUserSchema = z
  .object({ login: z.string().optional().catch(undefined) })
  .catch({});

/** Everything a verdict carries besides `status` and `detail` — filled in as
 *  the probes answer, and spread into whichever verdict the run reaches. */
interface PatValidationBase {
  checkedAt: string;
  login: string | null;
  tokenKind: PatTokenKind;
  expiresAt: string | null;
  repo: string | null;
  scopes: ScopeCheck[];
  missingScopes: string[];
  /** Ruling 144: the classic token's granted list (null until the header is
   *  read, and for fine-grained tokens). */
  headerScopes: string[] | null;
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
  const clientOptions: GithubClientOptions = { token };
  if (options.fetchImpl) clientOptions.fetchImpl = options.fetchImpl;
  const client = createGithubClient(clientOptions);

  const base: PatValidationBase = {
    checkedAt,
    login: null,
    tokenKind: tokenKindOf(token, null),
    expiresAt: options.knownExpiresAt ?? null,
    repo,
    scopes: [],
    missingScopes: [],
    headerScopes: null,
  };

  // 1. Identity — /user.
  const user = await client.request("GET", "/user", ghUserSchema);
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
          detail: "The token has expired. Generate a new one on GitHub.",
        };
      }
      return {
        ...base,
        status: "revoked",
        detail:
          "GitHub rejected the token (bad credentials): it was revoked or never valid.",
      };
    }
    // A GitHub-side outage (5xx) never evaluated the token — say so, or a
    // degraded GitHub reads as "your token is bad" in the connection modal.
    if (user.kind === "http" && user.status >= 500) {
      return {
        ...base,
        status: "network_error",
        detail:
          `GitHub's API is degraded right now (HTTP ${user.status} on /user); ` +
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
  // Ruling 144 (pass 34): a CLASSIC token's full granted list, verbatim from
  // the header (an empty header is the positive fact "no scopes"). Null for a
  // fine-grained token, which sends no header. Advisory: `scopes` below stays
  // the verdict on the REQUIRED set; this is what the credential card reads to
  // say that a token without `workflow` cannot push `.github/workflows/*`, and
  // what delivery consults before such a push.
  const headerScopes =
    scopesHeader !== null && tokenKind === "classic"
      ? scopesHeader.split(",").flatMap((s) => {
          const scope = s.trim();
          return scope ? [scope] : [];
        })
      : null;
  const withIdentity = { ...base, login, tokenKind, expiresAt, headerScopes };

  // 2. Repo access — /repos/{owner}/{repo}. The response also carries the
  //    `permissions` block GitHub computes for THIS token, which is the
  //    read-only proof of repository write (A8).
  let repoAccessible: boolean | null = null;
  let repoWriteOk: boolean | null = null;
  if (repo) {
    const repoResult = await client.request("GET", `/repos/${repo}`, z.unknown());
    if (repoResult.ok) {
      repoAccessible = true;
      const parsed = repoResponseSchema.safeParse(repoResult.data);
      repoWriteOk = parsed.success ? repoWritable(parsed.data.permissions) : null;
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
          `GitHub's API is degraded right now (HTTP ${repoResult.status} on /repos/${repo}); ` +
          "the token was NOT rejected. Try again in a few minutes.",
      };
    } else if (repoResult.kind === "http" && repoResult.status === 404) {
      return {
        ...withIdentity,
        status: "repo_not_found",
        detail:
          `The token cannot see \`${repo}\`: the repository does not exist, ` +
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
  if (scopesHeader !== null && (scopesHeader !== "" || tokenKind === "classic")) {
    // Classic token: the header is authoritative.
    //
    // B11/pass-16: an EMPTY header on a classic token is a positive fact — "this
    // token holds no scopes" — not missing information. The condition used to
    // require a non-empty header, so a scopeless `ghp_…` fell through to the
    // fine-grained probe branch and came back `pull_request:write: assumed`
    // ("fine-grained tokens expose no scope introspection") while `tokenKind`
    // right above it still said `classic`: an assumed-granted chip for a token
    // GitHub had just told us can do nothing. An empty header on an unknown-
    // prefix token stays in the probe branch — there, absence really does prove
    // nothing (GitHub omits the header entirely for fine-grained tokens).
    const granted = new Set(
      scopesHeader.split(",").flatMap((s) => {
        const scope = s.trim();
        return scope ? [scope] : [];
      }),
    );
    for (const id of requiredScopes) {
      const check = classicScopeCheck(id, granted);
      scopes.push(
        granted.size === 0
          ? {
              ...check,
              // Say WHICH nothing this is: "missing scope" reads like a partial
              // grant, and the operator would go looking for one checkbox.
              note: "this classic token was created with no scopes at all; regenerate it with `repo`",
            }
          : check,
      );
    }
  } else {
    // Fine-grained (or headerless) token: probe what can be probed.
    let orgReadOk: boolean | null = null;
    if (requiredScopes.includes("read:org")) {
      const orgs = await client.request("GET", "/user/orgs", z.unknown(), {
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
      const pulls = await client.request(
        "GET",
        `/repos/${repo}/pulls`,
        z.unknown(),
        { searchParams: { per_page: 1, state: "all" } },
      );
      pullsReadOk = pulls.ok
        ? true
        : pulls.kind === "http" && pulls.status < 500
          ? false
          : null;
    }
    // WRITE permissions via the empty-payload dry-run: GitHub authorizes a
    // request BEFORE validating its body, so a write endpoint hit with `{}`
    // answers 422 (Validation Failed) when the permission is HELD — nothing
    // can be created from an empty payload — and 403 when it is refused.
    //
    // A8/pass-16: this is now OPT-IN and never runs by default. It is still a
    // write REQUEST against someone's real repository, issued on every
    // revalidation of a credential — audit-log noise at best, ruleset/branch
    // -protection noise in the middle, and destructive if GitHub ever
    // validated the body before authorizing it. Repository write is proven
    // read-only from the `permissions` block instead; `pull_request:write` has
    // no read-only signal, so it stays honestly "assumed" unless an operator
    // turns this on. Any other answer (404 resource-hiding, 5xx, network)
    // stays UNKNOWN → the same "assumed" fallback.
    const writeProbe = writeProbeEnabled();
    const dryRunWrite = async (
      method: "POST" | "PUT",
      path: string,
    ): Promise<boolean | null> => {
      if (!writeProbe) return null;
      const dry = await client.request(method, path, z.unknown(), { body: {} });
      if (dry.ok) return true; // cannot really happen for an empty payload
      if (dry.kind !== "http") return null;
      if (dry.status === 422) return true;
      if (dry.status === 403) return false;
      return null;
    };
    const pullsWriteOk =
      repo && pullsReadOk === true
        ? await dryRunWrite("POST", `/repos/${repo}/pulls`)
        : null;
    for (const id of requiredScopes) {
      if (id === "repo" && repoAccessible !== null) {
        scopes.push(
          repoAccessible && repoWriteOk === true
            ? {
                id,
                ok: true,
                source: "probe",
                note: "read + write reported by GitHub for this token",
              }
            : repoAccessible && repoWriteOk === false
              ? {
                  id,
                  ok: false,
                  source: "probe",
                  note: "repository readable but not writable",
                }
              : {
                  id,
                  ok: repoAccessible,
                  source: repoAccessible ? "assumed" : "probe",
                  note: repoAccessible
                    ? "repository readable; GitHub reported no permission block, so write is unverified"
                    : "repository not readable",
                },
        );
      } else if (id === "read:org" && orgReadOk !== null) {
        scopes.push({ id, ok: orgReadOk, source: "probe" });
      } else if (id === "pull_request:write" && pullsWriteOk !== null) {
        scopes.push(
          pullsWriteOk
            ? { id, ok: true, source: "probe", note: "write proven by dry-run" }
            : { id, ok: false, source: "probe", note: "pull-request write refused" },
        );
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
          // A8: name the opt-in so the chip discloses WHY it is only assumed
          // and what the operator can turn on to prove it. `permissions.push`
          // is deliberately not read as proof here — a fine-grained token can
          // hold Contents:write while Pull requests stays read-only.
          note: "read proven; write needs a write request to prove (set VIBERR_GITHUB_WRITE_PROBE=1 to allow an authorization-only dry-run)",
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
  /** Injectable clock for the revalidation cooldown (tests). */
  now?: () => number;
}

/**
 * P13-D-33: how long a SUCCESSFUL validation suppresses a repeat network call.
 *
 * `last_validated_at` was recorded and then never consulted, so every press of
 * "Re-check scopes" made a fresh round trip to GitHub even when the credential
 * had just been confirmed valid. Only a `valid` result is reused: a failing
 * credential is precisely the one the operator is re-checking after fixing
 * something on GitHub's side, and a `network_error` never evaluated anything —
 * both must always re-probe, or the button becomes a lie.
 */
export const REVALIDATE_COOLDOWN_MS = 60_000;

/**
 * The real "Re-check scopes" backend (settings spec §5.4):
 * re-validates the project credential and resolves every open scope
 * violation whose scope the fresh validation now reports granted
 * (header/probe ok, or `assumed` for unverifiable fine-grained write
 * permissions — the next real 403 reopens it). Each resolution writes the
 * typed `policy` timeline event into the violation's OWN task (ruling 5),
 * reprojects it, and audits via the violations API. SSE fan-out rides the
 * emitted projection/violation events.
 */
/** Scopes whose violations need PROVEN write evidence to clear (B-GH8). */
const WRITE_EVIDENCE_SCOPES = new Set(["repo", "pull_request:write"]);

/** What the attempt audit row records beside its `outcome`. */
interface RevalidateAuditDetails {
  validationStatus?: PatValidation["status"];
  resolvedViolations?: number;
  /** P13-D-33: the cooldown suppressed the network call. */
  cached?: boolean;
}

/** Only the field a run reads out of `projects.credential_policy_json`. Junk
 *  entries become null so the AUTHORED length still decides whether the policy
 *  overrides the defaults — a list of nothing but junk means "check no scopes",
 *  exactly as the hand-rolled filter left it. */
const credentialPolicySchema = z.object({
  requiredScopes: z.array(z.string().nullable().catch(null)).optional(),
});

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
    extra: RevalidateAuditDetails = {},
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

  // SAFETY: `projects` declares both selected columns nullable TEXT
  // (0001_baseline.sql), and `slug` is the table's PRIMARY KEY, so the lookup
  // returns at most one row.
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
      const policy = credentialPolicySchema.safeParse(
        JSON.parse(projectRow.credential_policy_json),
      );
      const authored = policy.success ? policy.data.requiredScopes : undefined;
      if (authored && authored.length > 0) {
        requiredScopes = authored.filter((id) => id !== null);
      }
    } catch {
      // tolerated — fall through to defaults
    }
  }

  // P13-D-33: reuse a still-fresh SUCCESSFUL validation instead of re-probing
  // GitHub. The violation sweep below still runs against the cached scopes, so
  // a suppressed round trip changes nothing an operator can observe except the
  // wasted API call. See REVALIDATE_COOLDOWN_MS for why only `valid` qualifies.
  //
  // Reuse additionally requires the cache to cover the SAME repo this run
  // would probe: the connection modal validates with `repo: null`, so its
  // fresh-but-repo-less "valid" used to suppress the first project-scoped
  // run (add connection → attach within the cooldown), pinning a
  // fine-grained token at all-"assumed" scope chips that a repo probe would
  // have upgraded. A repo-context change is a new question, not a repeat.
  const targetRepo = ctx.repo !== undefined ? ctx.repo : (projectRow?.repo ?? null);
  const now = (ctx.now ?? Date.now)();
  const cached = credential.validation;
  const cachedAge =
    credential.lastValidatedAt !== null
      ? now - Date.parse(credential.lastValidatedAt)
      : Number.POSITIVE_INFINITY;
  const reusable =
    cached !== null &&
    cached.status === "valid" &&
    (cached.repo ?? null) === targetRepo &&
    Number.isFinite(cachedAge) &&
    cachedAge >= 0 &&
    cachedAge < REVALIDATE_COOLDOWN_MS
      ? cached
      : null;

  const validateOptions: ValidatePatTokenOptions = {
    repo: targetRepo,
    knownExpiresAt: credential.validation?.expiresAt ?? null,
  };
  if (requiredScopes) validateOptions.requiredScopes = requiredScopes;
  if (ctx.fetchImpl) validateOptions.fetchImpl = ctx.fetchImpl;

  const validation =
    reusable ?? (await validatePat(db, credential.id, validateOptions));
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
  // B-GH8: a WRITE scope may only be cleared by WRITE evidence. `assumed` means
  // the dry-run probe never answered — resolving on it turns "we don't know"
  // into "granted", and the human learns otherwise at the next failed delivery.
  // Read-only scopes keep the historical assumed-ok behaviour.
  const provenScopes = new Set(
    validation.scopes.flatMap((s) =>
      s.ok && (s.source === "header" || s.source === "probe") ? [s.id] : [],
    ),
  );
  // Ruling 144(c): a classic token's published list is header evidence for
  // EVERY scope it names, not only the required ones, so an open `workflow`
  // violation resolves on a re-check whose header now lists it.
  for (const scope of validation.headerScopes ?? []) {
    grantedScopes.add(scope);
    provenScopes.add(scope);
  }
  const resolvedViolations: ScopeViolationRecord[] = [];
  for (const violation of listScopeViolations(db, projectSlug, {
    status: "open",
  })) {
    const enough = WRITE_EVIDENCE_SCOPES.has(violation.scope)
      ? provenScopes.has(violation.scope)
      : grantedScopes.has(violation.scope);
    if (!enough) continue;
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
    // P13-D-33: the ATTEMPT is still audited when the cooldown suppressed the
    // network call — the log says which, so "we re-checked" stays honest.
    cached: reusable !== null,
  });
  return { status: "revalidated", validation, resolvedViolations };
}
