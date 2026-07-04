# Phase 7-core report — GitHub server layer

Status: complete (server-side only; the `/github` view, settings panels and
Phase-5 accept_completion wiring consume this API). All gates pass:
`npm run typecheck` clean, `npm test` 334/334 (incl. all pre-existing
phase 1–4 suites), `npm run build` clean, `npm run seed -- --reset` clean
(3 projects / 10 tasks / 13 projections), clean-tree `npm run rescan`
0 changed / 13 unchanged, and the dev sqlite shows the seeded violation
row with the rail-badge query returning 1 for viberr-core.

Zero new dependencies: `node:crypto` for AES-256-GCM, global `fetch` for
GitHub.

## File inventory

```
db/migrations/0005_github.sql            # github_pats, project_github_credentials,
                                         # scope_violations (+ VIB-142 data seed)
app/schemas/github-pat.schema.ts         # PatValidation / ScopeCheck zod shapes (shared)
app/server/secrets/
  secret-box.server.ts        [test]     # AES-256-GCM v1$iv$ct$tag box
  pat-store.server.ts         [test]     # PAT CRUD + project binding + credential health
  pat-validator.server.ts     [test]     # /user + /repos probes → typed diagnostics; grant flow
app/server/github/
  github-client.server.ts     [test]     # typed fetch wrapper (ETag, rate limit, 1×5xx retry)
  github-context.server.ts               # project → {client, repo, defaultBranch} resolver
  scope-flag.server.ts                   # flag/resolve violations WITH file+notification side effects
  repo-access-check.server.ts            # Connection pill fact
  branch-sync.server.ts       [test]     # task-key branches, compare, sync state, commit assoc.
  pr-linker.server.ts         [test]     # PR by head branch, state mapping, checks summary
  github-reconciler.server.ts [test]     # reconcileTask/Project + mergeTaskPr
app/server/projections/policy-violations.server.ts [test rewritten]
                                         # violations API (REPLACES phase-4 stand-in; same
                                         # countOpenPolicyViolations signature)
test-support/fake-github.ts              # canned-response fetch (mock transport for tests)
```

Touched (additive only): `app/server/errors/error-codes.ts` (+6 GitHub/secret
codes), `app/server/events/projection-events.server.ts` (+`violation.updated`
event type).

## Migration 0005 (number/name fixed by orchestrator)

- `github_pats(id, user_id FK→users CASCADE, label, encrypted_token,
  token_suffix, created_at, last_validated_at, validation_json)`.
- `project_github_credentials(project_slug PK **soft ref**, pat_id FK→github_pats
  CASCADE, created_at, updated_at)` — soft project ref because `projects` is a
  projection that seed `--reset` wipes; the binding must survive.
- `scope_violations(id, project_slug, task_key NULL, scope, detail, status
  open|resolved, created_at, resolved_at, resolved_by)` + partial unique index
  on `(project_slug, scope, coalesce(task_key,'')) WHERE status='open'` →
  opening is idempotent at the DB level.
- **Data seed**: one open violation `sv_seed_vib142_pr_write`
  (viberr-core / VIB-142 / `pull_request:write`) so a fresh DB renders the
  mock's rail badge (1). Resolving it via the grant flow is permanent — a
  re-seed does NOT reopen it (only a real 403 does). `seed --reset` does not
  touch `github_pats` / `project_github_credentials` / `scope_violations`.

## 1. Secret box — `app/server/secrets/secret-box.server.ts`

Format: `v1$<iv b64>$<ciphertext b64>$<tag b64>` (12-byte iv, 16-byte GCM tag),
key = `getEnv().VIBERR_SECRET_ENCRYPTION_KEY` (32-byte Buffer, phase 1).

```ts
sealSecret(plaintext: string, key?: Buffer): string
openSecret(box: string, key?: Buffer): string   // throws AppError code "secret_box_invalid"
isSecretBox(value: string): boolean              // cheap format check
```

Any tamper (iv/ct/tag/wrong key/unknown version) throws the typed AppError;
messages never carry plaintext or key material. Pass `key` only in tests.

## 2. PAT store — `app/server/secrets/pat-store.server.ts`

```ts
interface PatMetadata { id; userId; label; tokenSuffix /*"42af"*/;
  masked /*"····42af"*/; createdAt; lastValidatedAt: string|null;
  validation: PatValidation|null }

createPat(db, { userId, label, token }, actor: AuditActor): PatMetadata   // validates+encrypts; audits
getPatMetadata(db, patId): PatMetadata | null
listPats(db, userId): PatMetadata[]                                       // newest first, NO tokens
deletePat(db, patId, actor): boolean                                      // cascades project bindings
getPatToken(db, patId): string | null      // SERVER-INTERNAL decrypt — never into loader data/logs
recordPatValidation(db, patId, validation: PatValidation): void

setProjectCredential(db, { projectSlug, patId }, actor): PatMetadata      // one PAT per project (upsert)
clearProjectCredential(db, projectSlug, actor): boolean
getProjectCredential(db, projectSlug): PatMetadata | null

getProjectCredentialHealth(db, projectSlug): ProjectCredentialHealth      // ← THE loader call
```

```ts
interface ProjectCredentialHealth {
  configured: boolean;                       // real PAT bound?
  source: "pat" | "policy_display" | "none"; // policy_display = project.md credentialPolicy fallback
  patId; label; masked; lastValidatedAt; validation: PatValidation | null;
  requiredScopes: string[];                  // credentialPolicy.requiredScopes, else
                                             // DEFAULT_REQUIRED_SCOPES = repo·workflow·read:org·pull_request:write
  scopes: ScopeChip[];                       // one per required scope → `.scope-chips`
  openViolations: ScopeViolationRecord[];
}
interface ScopeChip { id; ok: boolean;
  source: "header"|"probe"|"assumed"|"violation"|"unchecked";
  flaggedTaskKey?: string }                  // cred-warn keybtn target
```

This one call replaces the mock's `scopeGranted` boolean for ALL four
surfaces (GitHub view, Settings card, Activity, rail badge — ruling 5).
Chip verdict = cached validator result overlaid with open violations: an
open violation for a scope forces `ok:false, source:"violation"` and carries
its task key. With no PAT bound, the seeded viberr-core renders the mock
exactly (label "viberr-bot · fine-grained PAT", masked "github_pat_••••42af",
`pull_request:write` chip missing, flagged VIB-142) from
`project.md credentialPolicy` + the seeded violation row.

## 3. PAT validator — `app/server/secrets/pat-validator.server.ts`

```ts
validatePatToken(token, options?: { requiredScopes?; repo?: string|null;
  knownExpiresAt?: string|null; fetchImpl? }): Promise<PatValidation>   // pure network
validatePat(db, patId, options?): Promise<PatValidation | null>        // + caches on the row
revalidateProjectCredential(db, projectSlug, actor?, ctx?: { dataRoot?;
  fetchImpl?; repo?: string|null }): Promise<RevalidateProjectCredentialResult>
```

`PatValidation` (app/schemas/github-pat.schema.ts, cached as validation_json):
`{ status: "valid"|"insufficient_scope"|"expired"|"revoked"|"repo_not_found"|
"org_approval_missing"|"network_error", checkedAt, login, tokenKind:
"classic"|"fine_grained"|"unknown", expiresAt, repo, scopes: ScopeCheck[],
missingScopes: string[], detail }` where `ScopeCheck.source` ∈
`header | probe | assumed`.

Probe strategy + honest limitations (documented in the module header):

- **Classic tokens** (`ghp_`): `x-oauth-scopes` header is authoritative;
  `repo` implies `pull_request:write`; `admin:org`/`write:org` imply `read:org`.
- **Fine-grained tokens** (`github_pat_`): GitHub exposes NO scope
  introspection. Probes: `GET /repos/{r}` → `repo`; `GET /user/orgs` →
  `read:org`; `GET /repos/{r}/pulls` proves pull-request READ. Write
  permissions are `source:"assumed"` (granted until a real 403 opens a
  violation) — a safe write probe does not exist.
- **expired vs revoked** on 401: message sniff ("…expired…") plus the cached
  `github-authentication-token-expiration` header from earlier successes
  (pass `knownExpiresAt`); otherwise revoked.
- **org_approval_missing** only on a 403 whose message mentions
  approval/access policy; a pending approval usually presents as 404 —
  reported as `repo_not_found` with the ambiguity noted in `detail`.

`revalidateProjectCredential` is the **"Grant scope" / "Re-check" backend**
(settings spec §5.4): returns `{status:"no_pat_configured"}` |
`{status:"network_unavailable", validation}` | `{status:"revalidated",
validation, resolvedViolations}`. Every open violation whose scope the fresh
validation reports granted is resolved (audit + `violation.updated` event)
and the exact typed `policy` timeline event lands on the violation's own
task: ``**Policy update:** `<scope>` granted on the project credential. The
earlier violation is resolved — PR auto-sync will work after merge.`` For
fine-grained tokens the unverifiable scopes count as granted (optimistic per
spec open-question resolution) — the next real 403 reopens the violation.
Idempotent: a second run resolves nothing and writes no second event.

## 4. GitHub client — `app/server/github/github-client.server.ts`

```ts
createGithubClient({ token, fetchImpl?, baseUrl? }): GithubClient
client.request<T>(method, path, { etag?, body?, searchParams? }?): Promise<GithubResponse<T>>

type GithubResponse<T> =
  | { ok: true; status; data: T; etag; rateLimit: {limit,remaining,reset};
      scopesHeader: string|null; tokenExpiration: string|null }
  | { ok: false; kind: "not_modified"; status: 304; etag; rateLimit }
  | { ok: false; kind: "http"; status; message; data; rateLimit }
  | { ok: false; kind: "network"; message }

githubFailureToAppError(failure, context): AppError  // route-boundary escape hatch
```

Bearer auth + `X-GitHub-Api-Version` + JSON accept; exactly ONE retry, 5xx
only; 4xx and network failures are typed results (never throws); the token
is never logged or re-emitted. New error codes: `secret_box_invalid`,
`github_auth_failed`, `github_forbidden`, `github_not_found`,
`github_unavailable`, `github_api_error`.

## 5. Services

All take `fetchImpl` injection (mock transport) and `dataRoot` (tests only).
`actor` is the phase-2 `AuditActor` (`{userId, label}`).

### repo-access-check

```ts
checkRepoAccess(db, projectSlug, { repoOverride?, fetchImpl? }?): Promise<RepoAccessResult>
type RepoAccessResult =
  | { status: "connected"; repo; remoteDefaultBranch; private }
  | { status: "no_repo_configured" } | { status: "no_pat_configured"; repo }
  | { status: "repo_not_found"; repo }
  | { status: "auth_failed"; repo; reason: "expired"|"revoked" }
  | { status: "org_approval_missing"; repo; message }
  | { status: "forbidden"; repo; message }
  | { status: "network_unavailable"; repo }
```

Connection pill: `connected` → ready pill "connected"; anything else is the
degraded state the github-view spec §7.9c asks for.

### branch-sync

```ts
taskBranchName(taskKey, title): string       // "vib-142-attach-execution-workspace-to"
                                             // <key-lc>-<title-slug capped at 4 words>
ensureTaskBranch(db, { projectSlug, taskKey }, actor, { dataRoot?, fetchImpl? }?)
  : Promise<EnsureBranchResult>
type EnsureBranchResult =
  | { status: "synced"; branch; created: boolean; compare: BranchCompare|null }
  | { status: "no_pat_configured"; repo } | { status: "no_repo_configured" }
  | { status: "task_not_found" }
  | { status: "default_branch_missing"; defaultBranch }
  | { status: "scope_violation"; scope: "repo"; violationId }
  | { status: "auth_failed"; message } | { status: "network_unavailable"; message }

getBranchCompare(client, repo, base, head): Promise<BranchCompareResult>
  // BranchCompare = { aheadBy, behindBy, status, commits: {sha(7), msg(first line)}[] }
taskCommits(commits, taskKey): commits      // keeps only "[VIB-n] …"-prefixed (case-insensitive)
deriveSyncState({ prMerged, behindBy }): "merged" | "behind_main" | "synced"
```

Idempotent: existing branch → success `created:false`; a 422
"Reference already exists" race → success. When the task file had no
`branch`, the generated name is written into task.md (frontmatter writer)
and reprojected. Branch creation audits `github.branch.created`. Sync pill
mapping for the UI: `merged`→done pill "merged", `behind_main`→risk
"behind main", `synced`→ready "synced" (precedence merged > behind > synced,
from REAL compare data — the mock's `validation==="failing"` conflation is
gone per spec §7.3).

### pr-linker

```ts
findPrForBranch(client, repo, branch): Promise<PrLinkResult>
type PrLinkResult = { status: "found"; pr: PrFacts } | { status: "none" }
  | { status: "forbidden"|"auth_failed"|"network_unavailable"; message }
type PrFacts = { number; title; state: "review"|"merged"|"closed"; draft;
  headSha; changed: {files,add,del}|null; checks: {total,passing,failing,pending}|null }

mapPrToCacheState({state, merged?, merged_at?}): "review"|"merged"|"closed"
prPillFor(state): { label: "in review"|"merged"|"closed"; kind: "info"|"done"|"risk" }
```

Ruling 12: merged→done, open/draft→"in review"/info, closed-unmerged→risk
"closed". `pr.state` in task.md now also stores `"closed"` (prRefSchema is
loose; ReadinessPill/board are unaffected — only the GitHub view renders it).
Checks summary is persisted INSIDE the pr cache (`pr.checks`, loose-schema
extra field) for the UI's benefit.

### github-reconciler

```ts
reconcileTask(db, { projectSlug, taskKey }, actor, { dataRoot?, fetchImpl? }?)
  : Promise<TaskReconcileResult>
type TaskReconcileResult =
  | { status: "reconciled"; taskKey; repo; branch; changed: boolean;
      sync: "merged"|"behind_main"|"synced";
      compare: {aheadBy, behindBy}|null; pr: PrFacts|null; commits: number }
  | { status: "no_branch"; taskKey } | { status: "task_not_found"; taskKey }
  | { status: "no_pat_configured"; repo } | { status: "no_repo_configured" }
  | { status: "scope_violation"; taskKey; scope; violationId }
  | { status: "auth_failed"; message } | { status: "network_unavailable"; message }

reconcileProject(db, projectSlug, actor, ctx?): Promise<ProjectReconcileSummary>
  // { status: "ok"|"no_pat_configured"|"no_repo_configured",
  //   results: TaskReconcileResult[], reconciled, changed, failed }
  // walks every task_projections row with a branch — this is the
  // Reconcile-button action (github-view §4.1: first toast on submit,
  // completion toast when the promise resolves)

mergeTaskPr(db, { projectSlug, taskKey }, actor /*needs userId*/, ctx?)
  : Promise<MergeTaskPrResult>
type MergeTaskPrResult =
  | { status: "merged"; prNumber; sha }
  | { status: "task_not_found"|"no_pr"; taskKey }
  | { status: "no_pat_configured"; repo } | { status: "no_repo_configured" }
  | { status: "not_mergeable"; prNumber; message }      // 405 (draft/blocked)
  | { status: "head_changed"; prNumber; message }        // 409 (sha moved)
  | { status: "scope_violation"; prNumber; scope: "pull_request:write";
      violationId; message }                             // 403 → THE VIB-142 case
  | { status: "pr_not_found"; prNumber }                 // 404
  | { status: "auth_failed"; message } | { status: "network_unavailable"; message }
```

`reconcileTask` writes ONLY the mirrored cache fields `pr` + `github`
(commits + changed) through the phase-3 frontmatter writers, then
incrementally reprojects (SSE `task.updated` rides the rebuild). Unchanged
facts → `changed:false`, NO file write (byte-stable, no updatedAt churn).
Every observation records a provenance row (`github.reconcile` /
`github.merge`) and an audit event (`github.reconcile.task/.project`,
`github.pr.merged/.merge_refused`). When the PR lookup is refused (fine-
grained read gap) the last-known pr cache is kept — reads never destroy data.

**mergeTaskPr contract for Phase 5 (accept_completion)**: call it BEFORE
transitioning; only `status:"merged"` may proceed to done. On success it
flips `pr.state` to "merged" in task.md, appends a human-authored `github`
event (``Merged **PR #N** into `main`.``), reprojects, audits — and resolves
an open `pull_request:write` violation for that task (a successful write is
the proof), writing the typed policy-update event. On 403 it opens (or
reuses — fully idempotent, the seeded VIB-142 row is simply returned) the
violation with its typed `policy` event + owner notification, and returns
the typed failure for the caller to render. It does NOT touch
stage/readiness/packet — that orchestration stays in resolvePacket.

## 6. Violations API — `app/server/projections/policy-violations.server.ts`

REPLACED the phase-4 policy-event derivation. **Kept verbatim signature**
(the only consumer, `app/routes/project.tsx` rail badge, needed no change):

```ts
countOpenPolicyViolations(db, projectSlug): number   // = COUNT(status='open')
```

New API (all sync, audit + `violation.updated` projection event built in):

```ts
listScopeViolations(db, projectSlug, { status? }?): ScopeViolationRecord[]  // newest first
getScopeViolation(db, id): ScopeViolationRecord | null
findOpenScopeViolation(db, projectSlug, scope, taskKey|null): ScopeViolationRecord | null
openScopeViolation(db, { projectSlug, taskKey?, scope, detail?, actor? })
  : { violation, created: boolean }                   // idempotent per (project,scope,task)
resolveScopeViolation(db, id, actor?): { violation, resolved: boolean } | null
```

Higher-level (file side effects — use THESE from actions, not the raw rows):
`app/server/github/scope-flag.server.ts`:

```ts
flagScopeViolation(db, { projectSlug, taskKey, scope, detail, actor? }, { dataRoot? }?)
  // open row + typed `policy` violation event into the task's task.md +
  // owner notification (kind "policy") + reprojection; created:false → no side effects
resolveScopeViolationWithEvent(db, violationId, actor?, { dataRoot? }?)
  // resolve row + typed `policy` update event on the violation's own task
policyViolationText(scope, consequence); policyUpdateText(scope)  // copy helpers
POLICY_ENGINE_ACTOR  // system:policy-engine file actor ref
```

New projection event type (Phase 6 should map it to an SSE event so rail
badge/GitHub view/Settings/Activity revalidate):
`{ type: "violation.updated"; projectSlug; taskKey: string|null; occurredAt }`.

## 7. Degraded-mode contract (UI step, read this)

Every service returns **typed results, never throws**, for the expected
states: `no_pat_configured` (render the "connect credential" affordance,
settings spec §7.11), `no_repo_configured`, `network_unavailable` (keep
last-known projection data — the GitHub view is read-mostly, stale-but-
labeled beats blank, github-view §7.10), `auth_failed`
(expired/revoked → Connection pill must not claim connected),
`scope_violation` (render the cred-warn banner path). `AppError` throws are
reserved for programmer/infra errors (secret box corruption, invalid input
to createPat). Tests inject transports via `fetchImpl` —
`test-support/fake-github.ts` is the canned harness (routes keyed
`"METHOD /path"`, per-route attempt counter for retry tests,
`unreachableFetch()` for network-down).

The GitHub view loader recipe (github-view spec §3.1 `GithubViewData`):
- `repo` panel: `checkRepoAccess` + `getProjectCredentialHealth`
- PR list / branch table: existing `task_projections` columns
  (`pr_json`, `branch`, `github_json`) — already maintained by the reconciler
- Reconcile action: `reconcileProject`; Grant-scope action:
  `revalidateProjectCredential`; rail badge: unchanged.

## 8. Adding a PAT for real use

1. On GitHub: Settings → Developer settings → **Fine-grained personal access
   token**, resource owner = the org/user owning the project repo, grant
   access to that repository, permissions:
   - **Contents: Read and write** (branch creation — our `repo` chip)
   - **Pull requests: Read and write** (PR link/status + merge — our
     `pull_request:write` chip)
   - **Metadata: Read-only** (implied/required by GitHub)
   - optional **Workflows: Read and write** only if agents will push
     workflow-file changes (our `workflow` chip), **Organization
     members/Members: Read** for the `read:org` chip.
   A classic token with `repo` (+ `workflow`, `read:org`) also works and
   validates more precisely (scope header).
2. In Viberr (server fns; org-settings UI arrives in Phase 9):
   `createPat(db, { userId, label, token }, actor)` →
   `setProjectCredential(db, { projectSlug, patId }, actor)` →
   `revalidateProjectCredential(db, projectSlug, actor)`.
3. Env: `VIBERR_SECRET_ENCRYPTION_KEY` must stay stable — rotating it
   orphans stored tokens (openSecret fails typed; delete + re-add PATs).
   The mock scope-id vocabulary maps to fine-grained permissions as:
   `repo`→Contents RW, `workflow`→Workflows RW, `read:org`→Org read,
   `pull_request:write`→Pull requests RW.

## Decisions / deviations

1. **Violation rows live in SQLite, seeded by a data migration** (0005) —
   not derived from timeline events. The phase-4 derivation is deleted; its
   test file was rewritten for the table-backed API. Rail badge behavior is
   unchanged (seed keeps it at 1; the phase-4 shell test still passes).
2. **Resolution permanence**: re-seeding does not reopen a resolved
   violation (mock parity would; real 403s reopen it honestly). Deliberate.
3. **Fine-grained scope optimism**: unverifiable write scopes count as
   granted on re-validate (chips green, violation resolves) — the documented
   answer to github-view open question 1. The next real 403 reopens.
4. **`pr.state` gains `"closed"`** (ruling 12) and `pr.checks` rides in the
   loose pr cache. Phase-3 schema untouched (loose objects).
5. **Merge event copy authored**: ``Merged **PR #N** into `main`.`` (human
   actor) — mock's VIB-141 shows a human-actor merged github event with
   bespoke suffix text; parameterized form documented here.
6. **Read failures never open violations** — only write/compare 403s do
   (a PR-list 403 could be repo visibility, not scope). Merge success
   auto-resolves the task's `pull_request:write` violation (proof by write).
7. **Branch-name slug capped at 4 title words** + Turkish `ı→i` fold; the
   mock's exact `vib-142-attach-workspace` name survives because existing
   `branch` frontmatter always wins over generation.
8. **project_github_credentials.project_slug is a soft ref** (see migration
   comments). `github_pats.user_id` is a hard FK (users are app-owned).
9. **`x-oauth-scopes` classic-scope implications** implemented for
   `pull_request:write` (implied by `repo`) and `read:org` (implied by
   `admin:org`/`write:org`) so classic tokens don't false-flag.
10. **reconcileProject keeps per-task typed results** rather than failing
    the whole run — a single 403 task shows up as its violation while the
    rest reconcile.

## Known gaps (intentional)

- No routes/UI: Reconcile button, cred-card, settings panels, org-settings
  PAT modal are the UI step's work (this report is their API doc).
- Phase 5's resolvePacket still flips the mirrored `pr.state` directly on
  accept; switching it to `mergeTaskPr` (+ explicit failure state) is the
  documented integration point (§5 above).
- SSE: `violation.updated` is emitted in-process; Phase 6 must forward it.
- No scheduled/webhook reconcile — manual (button/action) only; the UI may
  want a "last reconciled at" line (provenance rows carry the timestamps).
- ETag support exists in the client but the reconciler doesn't persist
  ETags yet (single-flight reconciles are cheap; add a cache table if rate
  limits ever bite).
