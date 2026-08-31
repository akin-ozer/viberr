# 05 — RBAC, Auth, Secrets, GitHub Delivery, Audit

Reference doc for the pass-31 implementation phase. Every claim below is anchored to a file
path + exported symbol. Ruling numbers are the canonical ones in `docs/architecture/decisions.md`.

---

## 1. RBAC model

### 1.1 Three separate authorization systems (ruling 2, `decisions.md:137`)

| System | Values | Stored in | Enforced by |
| --- | --- | --- | --- |
| **Org role** | `admin \| member` | `users.role` (SQLite; CHECK in `db/migrations/0001_baseline.sql:28`) | `requireRole` / `requireRoleAuth` in `app/server/auth/require-user.server.ts` |
| **Project role** | `admin \| maintainer \| contributor \| viewer` | `project.md` frontmatter `members[]` (file-native) | `app/shared/rbac.ts` → `app/server/auth/project-authority.server.ts` |
| **Agent capability** | `direct \| recommend \| human \| off` per capability id | agent profile grants | `app/shared/capabilities.ts` + `specialist-tool-policy` |

Org roles form a two-rung ladder (`app/shared/mapping/user.server.ts:9`, `ROLE_ORDER` in
`require-user.server.ts:181`). `coerceUserRole` coerces any legacy/unknown stored string down to
`member`.

Project roles form a **strict tier**: `viewer ⊂ contributor ⊂ maintainer ⊂ admin`
(`ROLE_RANK` in `app/shared/rbac.ts:31`). Every entry in the matrix is monotonic, so the explicit
role list is for readability + rendering the Policy table's columns, not for expressiveness.

`reviewer` was renamed `contributor` (ruling 2 amendment). `PROJECT_ROLES` is declared in
`app/schemas/project-file.schema.ts:23` and re-exported from `app/shared/rbac.ts:29`.

### 1.2 ACTION_ROLES — the full matrix

Single source: `RBAC_DEFINITIONS` in `app/shared/rbac.ts:61`, mapped into
`ACTION_ROLES: Map<RbacAction, readonly ProjectRole[]>` at `:97`. `roleCan(role, action)` (`:104`)
and `rolesForAction(action)` (`:110`) are the only readers. `rolesForAction` **throws** on an
unknown id — an action string that reached it past the type is a defect, not a deny.

| # | action id | label | admin | maintainer | contributor | viewer | Primary enforcement site |
| --- | --- | --- | :-: | :-: | :-: | :-: | --- |
| 1 | `view` | View board, tasks & timelines | ✓ | ✓ | ✓ | ✓ | membership gate only (never calls `requireAction`) |
| 2 | `comment` | Comment on tasks | ✓ | ✓ | ✓ | ✓ | membership gate only (`appendComment` → `requireVisibleProject`) |
| 3 | `create-task` | Create tasks | ✓ | ✓ | ✓ | | `task-actions.server.ts:458` |
| 4 | `own-task` | Take / release own task ownership | ✓ | ✓ | ✓ | | `task-actions.server.ts:4054`; also the `ownerException` predicate `:303` |
| 5 | `edit-task-meta` | Edit task priority, labels & due date | ✓ | ✓ | ✓ | | `task-actions.server.ts:673` |
| 6 | `approve-transition` | Approve stage transitions | ✓ | ✓ | | | `task-actions.server.ts:4317`, `:4334`; `discard_branch` resolve `:6257` |
| 7 | `resolve-packet` | Resolve decision packets | ✓ | ✓ | | | `task-actions.server.ts:362`, `:5890`, `:6753` |
| 8 | `accept-completion` | Accept completion → Done | ✓ | ✓ | | | `requireAcceptCompletion` `task-actions.server.ts:334` (+ owner exception) |
| 9 | `update-goal` | Edit the task goal | ✓ | ✓ | | | `task-actions.server.ts:571` |
| 10 | `run-agents` | Run agents | ✓ | ✓ | | | `requireRunAgents` / `canRunAgents` in `project-authority.server.ts:293`,`:311`; `manualDeliverForReview` `:5186`; goals `goal-actions.server.ts:257` |
| 11 | `reorder-board` | Reorder the board | ✓ | ✓ | | | `task-actions.server.ts:5548` |
| 12 | `reconcile-github` | Reconcile GitHub state | ✓ | ✓ | | | `app/routes/project.github.tsx:125` |
| 13 | `grant-github-scope` | Grant GitHub scope | ✓ | ✓ | | | `project.github.tsx:129`,`:135`; `project.settings.tsx:197`,`:204`; display gate `credential-visibility.server.ts:51` |
| 14 | `rescan-project` | Re-scan project files & projections | ✓ | ✓ | | | `app/routes/project.board.tsx:130` |
| 15 | `release-any-ownership` | Release any task owner | ✓ | | | | `task-actions.server.ts:4057` |
| 16 | `manage-members` | Manage members & roles | ✓ | | | | `settings-actions.server.ts:794`,`:859` |
| 17 | `manage-agents` | Manage agent profiles | ✓ | | | | `agent-profile-actions.server.ts:217` |
| 18 | `edit-policy` | Edit workflow & policy | ✓ | | | | `settings-actions.server.ts:197`,`:261`,`:351`,`:460`,`:497`,`:561`,`:701`,`:964`,`:1008` |
| 19 | `force-accept-completion` | Force-accept past the review gate | ✓ | | | | `forceAcceptCompletion` in `task-actions.server.ts` (DG-2) |

Display renders from the SAME object: `RBAC_ROWS` in `app/features/policy/policy-data.ts:40`.
`app/features/policy/policy-rbac.server.test.ts` drives every guard once per role (its
`"rescan-project": ["admin","maintainer"]` style table at `:1722`) so display and enforcement
cannot drift.

**Owner exception (R14-2 / R15-3, ruling 22).** `ownerException` (`task-actions.server.ts:303`)
lets a task's live owner — provided they hold `own-task`, i.e. contributor+ — accept their own
task and apply/dismiss any operator recommendation on it, short-circuiting the role tier. It does
**not** short-circuit the archived freeze: `requireAcceptCompletion` (`:325`) calls
`requireProjectMutable` *before* the owner check, deliberately.

### 1.3 The resolution path

`app/server/auth/project-authority.server.ts` is the ONE place "what may this actor do here" is
answered (R7-1 consolidation). Key exports:

- `resolveProjectAuthority(db, project, actor, allowed, audit)` — non-throwing core (`:173`).
- `requireProjectAuthority(...)` — throwing wrapper with the canonical 403 copy (`:265`).
- `assertProjectAction(db, action, projectSlug, actor, what, opts)` — slug-only callers; reads
  `project.md` fresh (`:337`).
- `requireRunAgents` / `canRunAgents` (`:293`, `:311`).
- `requireProjectMutable(project, what)` — the archived freeze, single implementation (`:136`).
- `isOrgAdmin(db, userId)` (`:152`) — reads `users.role` directly; **disabled users never qualify**.
- `requireAction(db, project, actor, action, what)` re-exported/defined at
  `app/server/tasks/task-actions.server.ts:286` — calls `requireProjectMutable` first, then
  `requireProjectAuthority(rolesForAction(action))`.

Three rules live in that module:

1. **Membership role** checked against `ACTION_ROLES`.
2. **Org-admin emergency override (owner ruling D2, implemented per R7-1).** An org admin whose
   membership role would be denied gets project-admin-equivalent authority, and **every such grant
   writes a `project.org_admin.override` audit row**. F19-30 extended this to the `"any-member"`
   gate (commenting is deliberately role-free, so that gate IS its only authority) with a 60s
   dedupe window keyed `ovr|<userId>|<slug>|<what>` — the `what` is in the key so a READ gate can
   never mask a WRITE gate.
3. **Denial audit (P13-D-8).** Every refusal writes `project.authority.denied`, deduped 60s on
   `deny|<userId>|<slug>|<action>`. `silentDeny: true` is used by exactly one caller — `canRunAgents`
   on the @mention path, where a lower-role commenter's comment is kept and the run silently skipped.

### 1.4 Members-only projects / visibility (R15-4, ruling 25)

Projects are **members-only**. A signed-in non-member is indistinguishable from a nonexistent slug.
Three enforcement points, all producing byte-identical `No project at projects/<slug>.` 404s:

| Surface | Guard | File |
| --- | --- | --- |
| Layout READS (board, task detail) | inline `memberRole ?? orgAdminOverride` check | `app/routes/project.tsx:75`,`:89`; `myRole` derived at `:132` |
| Child-route config loaders | `requireProjectMember(request, slug, what)` | `app/server/auth/require-project.server.ts:33` |
| Child-route ACTIONS | `requireVisibleProject(db, slug, actor, what)` | `app/routes/project-visibility.server.ts:28` |

Why all three: React Router runs a child route's **action** without its parent's loader, and
single-fetch honors a client-supplied `?_routes=` filter, so
`GET /projects/<slug>/policy.data?_routes=routes/project.policy` runs the child loader *alone*
(F19-28). `requireProjectMember` collapses both failure modes (not-a-member 403, missing
`project.md` 404) into one response; two different refusal strings are themselves an oracle.

`projectNotFound` (`require-project.server.ts:81`) echoes the slug **only** when the URL already
named it positionally (`/projects/<slug>/…`). The two run-addressed resource routes
(`/resources/run-log?runId=`, `/resources/session-export?run=`) resolve the slug from the RUN row,
so they get a bare `Not found.` — echoing there would hand a non-member the name of a project they
never asked about.

Archived projects stay **reachable** on all three (`allowArchived: true`); the read-only gate is a
mutation concern.

**Credential visibility (R19-11, ruling 65).** A project Viewer does not get the credential card,
and the **loader redacts on the same rule** — `credentialGrantHolder` (`grant-github-scope`) and
`withoutCredentialDetail` in `app/features/github/credential-visibility.server.ts`. A render-only
gate left `github_pat_••••42af` in the single-fetch payload. The redaction strips
`patId/label/masked/lastValidatedAt/validation/scopes/openViolations` but keeps
`configured/source/requiredScopes` (project policy, not credential detail).

### 1.5 Archive rules (R6-3 / R14-3 / F19-8 / F26-13)

- **Project archived** → read-only. `requireProjectMutable` throws 409
  `"This project is archived (read-only) — restore it before you <what>."` The ONE exemption is the
  restore action itself (`setProjectArchived` passes `allowArchived`). Timelines and audit stay
  readable. F17 extended it to the agent runtime (`requireRunAgents` calls it before the tier check),
  because runs write branches, commits and timeline events.
- **Task archived** → `archivedTaskBlockedReason` (`app/schemas/task-file.schema.ts:873`) refuses
  acceptance; `archivedTaskMoveBlockedReason` (`:892`) refuses stage moves (F19-8); `edit-task-meta`
  refuses at `task-actions.server.ts:708` (F26-13).
- Archive/restore is `edit-policy` (admin only) via `settings-actions.server.ts`; audit actions
  `project.archived` / `project.unarchived` / `task.archived` / `task.unarchived`.

### 1.6 Specialist cap + ALWAYS_HUMAN

`ALWAYS_HUMAN_CAPABILITY_IDS` (`app/shared/capabilities.ts:211`) = `merge-pull-request`,
`transition-to-done`, `change-project-policy`. `capabilityEnforcement(id)` (`:287`) checks
ALWAYS_HUMAN **before** the claude-only set so `merge-pull-request` is never mislabeled "advisory
on Codex". Enforced on profile writes at `agent-profile-actions.server.ts:265-298` and displayed
via `agents-query.server.ts:364`.

**Specialist cap (R20-6 / F20-21).** `coerceSpecialistCapabilityMode` (`capabilities.ts:361`) maps
a specialist `recommend` **down to `off`**, never up to `direct`. Re-introducing a
`recommend → direct` widening is the F20-21 regression. Applied on both the write paths and the
display read, so stored = enforced = displayed.

Related gates worth knowing: `GRANT_REQUIRED_CAPABILITY_IDS` (`:392`) — capabilities where an
ABSENT grant means withheld (execute-code-or-write-repo, the three scoped delivery caps,
merge-pull-request, report-validation-verdict); everything else keeps its permissive default.
`applyVerdictOutcomeGate` (`:324`) — the three verdict-outcome caps are only as granted as
`report-validation-verdict`. `absentDeliverReviewPrMode` (`:614`) — R15-9, an absent
`deliver-review-pr` resolves from the project's workflow graph, not a constant.

Controller (ruling 99): carries **no** capability matrix — its runtime authority is the asking
user's live authority, and its toolkit has no tool for merge, acceptance, force-accept, packet
resolution, or a move into the terminal stage.

---

## 2. Auth

### 2.1 better-auth setup

`app/lib/auth.server.ts` builds the instance. Contract: **better-auth owns credentials, sessions and
OAuth; the `users` table owns profile + authorization; both rows share the same id**
(`better-auth user.id === users.id`) — `app/server/auth/identity.server.ts:6`.

- Mount: `AUTH_BASE_PATH = "/api/auth"` in `app/shared/auth/auth-paths.ts:14` (a SHARED module so
  the Sign-in & SSO card can render `oauthCallbackUrl(origin, provider)` without pulling a
  server-only file into the browser bundle). Handler route: `app/routes/api.auth.$.ts`.
- Cookie: `viberr.session_token` (`advanced.cookiePrefix: "viberr"`), signed with
  `BETTER_AUTH_SECRET ?? VIBERR_SESSION_SECRET`.
- Sessions: `expiresIn` 30 days, `updateAge` 1 day → **rolling**.
- Sign-up **disabled** (`emailAndPassword.disableSignUp: true`) — identities are provisioned by the
  whitelist only.
- Password hooks are **total** (P11-01): `password.hash`/`password.verify` route through
  `app/server/auth/password.server.ts`, so an unparseable legacy hash reads as a wrong password
  (401) instead of throwing "Invalid password hash" as a 500 on the splat.
  `isBetterAuthPasswordHash` (`identity.server.ts:126`) tests the `<saltHex>:<keyHex>` form.
- `betterAuth` is a process-wide singleton cached on `Symbol.for("viberr.betterAuth")`, keyed on
  **db handle + `oauthConfigFingerprint(db)`** (R19-16) so a provider saved in the UI takes effect on
  the next request with no restart.

### 2.2 `/api/auth/*` splat allow-list (P11-02)

`ALLOWED_AUTH_PATHS` (`auth.server.ts:63`) — an **allow-list, not a deny-list**:

```
/sign-in/email   /sign-in/social   /callback/:id   /error   /get-session   /sign-out
```

Enforced in the `hooks.before` middleware (`:261`): anything else throws
`APIError("NOT_FOUND")`. Entries are the endpoints' **declared** paths (params un-substituted,
hence the literal `/callback/:id`), and the list must cover server-side `auth.api.*` calls too
(`/get-session` for `require-user`, `/sign-out` for logout). Left open, `/change-password` would
bypass the app's audited, session-revoking flow and `/update-user` would split-brain the canonical
`users` row.

### 2.3 Session model + request guards

`app/server/auth/require-user.server.ts`:

- `authenticateWithHeaders(request)` (`:77`) — calls `getSession({ headers, returnHeaders: true })`
  and **captures the renewal `Set-Cookie`** (F10-17). Without `returnHeaders` the rolling slide
  reached the DB but never the browser. Only the root document loader uses this.
- `authenticate(request)` (`:114`) — drops the renewal headers.
- `requireAuth` / `requireUser` / `requireRole` / `requireRoleAuth` (`:161`–`:222`).
- A **disabled or vanished user** has their better-auth session row deleted and is treated as
  signed out (`:88`).
- `AuthContext` carries `sessionId` (safe to log, keys the CSRF token) and `sessionToken`
  (logout only, never log).
- `safeReturnTo` (`:121`) strips `\t\r\n` **before** validating, because the URL parser removes them
  before resolving — `"/\t/evil.example"` would otherwise reach the browser as `//evil.example`.
- `loginRedirect` (`:135`) normalizes the RR8 `.data` wire address and drops `_routes` so `returnTo`
  is never a `.data` URL.
- Forced password reset: while `users.pwreset_required` is set, `requireAuth` redirects everything
  to `/login`; `allowPendingPasswordReset` exempts the reset action itself and logout.

### 2.4 Login flows

**Local credentials** — `loginWithCredentials` in `app/server/auth/login.server.ts:63`. It keeps a
richer failure taxonomy than better-auth's generic sign-in: `unknown_email | no_password |
wrong_password | disabled | rate_limited`. Pre-checks `users` (unknown/disabled/OAuth-only) and
**spends a rate-limit token for those** because they never reach better-auth's handler; then
delegates verification + session minting to `auth.handler(POST /api/auth/sign-in/email)`. Success
forgives the bucket and records `auth.login.success`.

**Rate limiting.** better-auth's own limiter is switched **off** for `/sign-in/email` and
`/sign-in/social` (`customRules` at `auth.server.ts:227`,`:234`) because it keys on client IP and
Viberr ships without a reverse proxy — every sign-in would share one
`no-trusted-ip|/sign-in/email` bucket, i.e. a denial-of-login lever. The authoritative buckets are
in `app/server/auth/rate-limit.server.ts`: `LOGIN_RATE_LIMIT` 10 / 15 min keyed `email|ip`,
`SOCIAL_START_RATE_LIMIT` 30 / min keyed `provider|ip`, `PAT_VALIDATION_RATE_LIMIT` 10 / 5 min
keyed on user id. The login throttle lives on the **hook**, not in `loginWithCredentials`, so a POST
straight to the splat is throttled too.

**Local-first when OAuth is off (R17-4, ruling 45).** `app/routes/login.tsx:407`: when neither
provider is configured, the provider buttons are **not rendered at all** — the local form leads and
SSO shrinks to a one-line footnote. With at least one provider configured, SSO-first stands
(including the D12 disabled button for the other provider).

**OAuth configured in the app (R19-16, ruling 72).** `app/server/auth/oauth-providers.server.ts`:
the `oauth_providers` row **overrides the deployment env** — including when it is configured and
disabled. `enabled` requires a passing live test: `verified_at` is written only by
`recordOAuthVerification` and cleared the moment either credential changes
(`saveOAuthProvider:147` `keepVerdict`). `resolveOAuthProvider` fails **closed** when the secret is
sealed under a key this deployment no longer has (never silently falls back to the env identity).

**OAuth whitelist.** `app/server/auth/oauth-provision.server.ts`: `isOAuthWhitelisted` (create.before)
and `applyOAuthUser` (create.after), plus `linkOAuth` on account create. Admission rules:
- Google + email domain in `google_domain_allowlist` → provisioned with the mapped role.
- GitHub + a live `@handle` placeholder row → claimed.
- An existing live `users` row (safety net for an unlinked legacy row).
- P13-D-22: the domain rule is **Google-only** and the provider is threaded explicitly via
  `oauthProviderOf(context)` (`auth.server.ts:101`), reading `params.id` off `/callback/:id`. Guessing
  the provider from the presence of a `githubHandle` is what let `@acme.com` admit GitHub accounts.
  `oauthProviderOf` returns null when unreadable and `isOAuthWhitelisted` **fails closed** on null.
- F28-A1: `accountLinking.trustedProviders: ["credential"]` only — github/google are deliberately
  **untrusted**, because every viberr account is provisioned `emailVerified: 1`, which would moot the
  CVE-2026-53516 backstop and let anyone with a provider-reported *unverified* victim email be
  linked in.

**Env-admin bootstrap.** `seedInitialAdmin` in `app/server/auth/seed-admin.server.ts:37` runs at
boot **only when `users` is empty**. Uses `VIBERR_SEED_ADMIN_EMAIL` / `VIBERR_SEED_ADMIN_PASSWORD`,
else falls back to `DEFAULT_SEED_ADMIN_EMAIL = "admin@viberr.dev"` (`:19`) with a
`randomBytes(12).toString("base64url")` password logged **once** (`logger.warn`, `{bootstrap:true}`)
and `pwreset_required = 1`. It calls `provisionIdentity` so the bootstrap admin can actually sign in,
and records `org.user.created` with `{bootstrap: true}` under `SYSTEM_ACTOR`.

### 2.5 CSRF

`app/server/auth/csrf.server.ts`. Two layers:

1. **`assertTrustedOrigin(request)`** (`:62`) — `Sec-Fetch-Site` / `Origin` / `Referer` must all say
   same-origin, **and the request must carry at least one of them** (§7.10 / A7). The old
   "carries none → pass" concession bought nothing (every call site is a browser form surface) and
   turned defense-in-depth into an omittable header. `Origin: null` (opaque) is refused outright.
2. **Double-submit token** — `csrfTokenForSession(sessionId, secret)` =
   `HMAC-SHA256(VIBERR_SESSION_SECRET, "viberr-csrf:" + sessionId)` base64url. Injected as the hidden
   field `_csrf` (`CSRF_FIELD_NAME`, `:18`) by `<CsrfInput />` (`app/ui/csrf-input.tsx`, fed by the
   root loader). Also accepted as the `X-Csrf-Token` header. Compared with `timingSafeEqual`.

`assertCsrf(request, sessionId, formData?)` is the guard for every authenticated mutating action;
the standard entry point is `requireFormAction(request)` in
`app/server/auth/form-action.server.ts:7`, which returns `{auth, db, formData, actor, intent}`.
The login action has no session yet, so it uses `assertTrustedOrigin` + rate limiting only.
`/api/auth/*` runs no app CSRF — better-auth enforces its own Origin/`trustedOrigins` check.

---

## 3. Secrets

### 3.1 Secret box

`app/server/secrets/secret-box.server.ts`. AES-256-GCM, keyed from
`VIBERR_SECRET_ENCRYPTION_KEY` (32-byte buffer validated at boot). Stable storage contract:

```
v1$<iv base64>$<ciphertext base64>$<auth tag base64>
```

12-byte random IV per seal, 16-byte auth tag. Any tamper fails with a typed
`AppError(SECRET_BOX_INVALID)`, never garbage plaintext. Error messages never include plaintext or
key material.

**Key rotation (A9).** `VIBERR_SECRET_ENCRYPTION_KEY_PREVIOUS` (comma-separated) holds retired keys.
`openSecretRotating(box, key?, previous?)` returns `{plaintext, staleKey}`; a `staleKey: true` read
obliges the caller to **re-seal in place**, so the store converges with no migration. Callers that do:
`getPatToken` (`pat-store.server.ts:222`), `readOAuthSecret`, `getS3AuditConfigForUse`
(`s3-config.server.ts:76`, F26-8 — `openSecret` alone bricked the S3 secret after a rotation).

`app/server/secrets/key-rotation.server.ts` finishes the job. `SEALED_STORES` (`:43`) is the
registry of every table holding a sealed box — **an unregistered sealed secret silently outlives a
rotation**; `key-rotation.server.test.ts` fails if a third `sealSecret(` home appears:

| store id | table | column | name col | id col |
| --- | --- | --- | --- | --- |
| `github_pats` | `github_pats` | `encrypted_token` | `label` | `id` |
| `org_mcp_servers` | `org_mcp_servers` | `cred_ref` | `name` | `id` |
| `oauth_providers` | `oauth_providers` | `client_secret` | `provider` | `provider` |
| `s3_audit_config` | `s3_audit_config` | `secret_box` | `bucket` | `id` |

`secretKeyRotationStatus(db)` counts by `SecretKeyState` (`current | stale | unreadable |
not_sealed`) and reports `converged` (safe to drop the retired key). `resealSecrets(db, {dryRun})`
writes and records `secrets.resealed`. CLI: `npm run keys -- reseal`.

### 3.2 PAT storage

`app/server/secrets/pat-store.server.ts`. Table `github_pats`; only `getPatToken` decrypts, and it
is SERVER-INTERNAL — never into loader data, logs, timelines or errors. Metadata readers return
`tokenSuffix` (last 4) and `masked = "····<suffix>"` only.

**Scopes.** `DEFAULT_REQUIRED_SCOPES = ["repo", "pull_request:write"]` (`:38`; ruling 18,
2026-07-25). The mock-era `workflow` and `read:org` are **gone**: nothing reads org data, and a
workflow-file push that GitHub refuses surfaces as a scope violation with GitHub's own message —
a better verdict than an unprovable chip. `CONNECTION_REQUIRED_SCOPES` in
`app/server/org/connections.server.ts:61` is an **alias** of the same tuple (B-GH6: two identical
`as const` tuples made "the minimum" a one-edit mistake).

**Token shape check.** `createPat` / `replacePatToken` refuse `length < 8` or any whitespace:
`"That doesn't look like a GitHub token."`

**Validation honesty (`pat-validator.server.ts`).** Classic tokens (`ghp_…`) expose
`x-oauth-scopes` → `source: "header"` (authoritative). Fine-grained tokens have no introspection:
`GET /repos/{r}` returns a `permissions` block computed for the authenticated token, so repo write
is proven **read-only** (A8/pass-16). `pull_request:write` has no read-only signal and stays
`assumed` unless the operator opts into `VIBERR_GITHUB_WRITE_PROBE=1`, the empty-payload dry run
(**422 = authorized, 403 = refused**, ruling 18) — health checks do not write.
`markWriteScopeProven(db, patId)` (`pat-store.server.ts:270`) flips `assumed → probe` after a REAL
solicited write (a PR actually opened or merged), and takes the `patId` **that actually made the
call** (F28-U2b), not the project's currently-bound credential.

**Chips (ruling 19).** `ScopeChipSource = header | probe | assumed | violation | unchecked`.
`getProjectCredentialHealth` (`:439`) overlays open violations (forcing not-ok + `flaggedTaskKey`).
With no bound PAT the health is `{configured: false, source: "none"}` **always** — a project's
`credentialPolicy` is display/requirements only, never a credential (the seeded-demo-lie fix).

**Bindings.** `project_github_credentials` (one PAT per project): `setProjectCredential` /
`clearProjectCredential` / `getProjectCredential`. Org-level connections
(`app/server/org/connections.server.ts`) validate **before** writing — on replace the old token
stays active unless validation passes.

### 3.3 Scrubbing rules

`app/server/secrets/git-output-redact.server.ts` (ruling 69 / R19-13). Git's own failure text IS
surfaced to humans, redacted, at one choke point. `redactGitOutput(text, {token})` runs three layers
strongest-first:

1. **By value** — `out.split(opts.token).join("[redacted]")`. **F20-7: at ANY length.** The old
   `>= 8` floor let a 5-char `MCP_CREDENTIAL` ride into an MCP row error, a toast and the persisted
   `last_error` (live: `CRED=xy7Qk`). The by-value pass is exact — it only removes the string the
   caller handed us — so a shorter value has nothing extra to mangle; the floor only ever protected a
   leak. The empty-string case is still guarded (a split on `""` would insert `[redacted]` between
   every character).
2. **URL userinfo** — `scheme://user:secret@host` → `scheme://[redacted]@host`, run *after* layer 1
   so `x-access-token:[redacted]@host` also loses the username half.
3. **Token patterns** — `TOKEN_PATTERN_SOURCE` (`:43`): `gh[pousr]_[A-Za-z0-9]{16,}`,
   `github_pat_[A-Za-z0-9_]{20,}`, `sk-[A-Za-z0-9_-]{16,}`. Anchored prefixes + a length floor
   deliberately, **not** an entropy heuristic — mangling git's diagnosis is worse than the leak this
   backstops. `createLineRedactor` in `run-sink.server` keeps an identical list and must stay in step.

Then ANSI CSI + C0 control stripping, split on `\r|\n|\r\n` (a bare CR is a line — git rewrites
transfer progress in place), keep the LAST 8 lines, clamp to 600 chars **from the end** (a clamp that
drops git's verdict to keep its command echo defeats the point). `redactProviderText(cause, token)`
(`:142`) layers on top for Claude/Codex failures: walks `cause` three levels, keeps the last
non-empty line, clamps to `PROVIDER_TEXT_CHARS = 240` (ruling 78 / R20-3). `gitErrorText(cause)`
(`:179`) decodes `stderr` and `message` **separately** so a Buffer `stderr` still falls through to
the message.

The premise that makes this safe: the PAT travels only through the `GIT_ASKPASS` helper's
environment (`app/server/tasks/git-clone-auth.server.ts`); argv and `remote.origin.url` carry the
credential-free `https://github.com/<owner>/<repo>.git`.

### 3.4 S3-style secret table

`app/server/audit/s3-config.server.ts` — table `s3_audit_config`, at most one row (`id = 'default'`).
The secret access key is sealed in its **own dedicated `secret_box` column, not a JSON blob**,
precisely so `SEALED_STORES` can rescan and reseal it. Views: `getS3AuditConfigView` (never the key,
just `hasSecret`), `getS3AuditConfigForUse` (decrypted, rotating + lazy re-seal),
`setS3AuditConfig` (blank secret keeps the existing seal), `clearS3AuditConfig`.
`app/server/audit/s3-put.server.ts` is a hand-rolled SigV4 signer for a single PUT (no aws-sdk);
`signingKey` / `sha256Hex` are exported for the AWS known-answer test.

---

## 4. GitHub delivery pipeline, end to end

### 4.0 Context resolution

`getProjectGithubContext(db, projectSlug, opts)` (`app/server/github/github-context.server.ts`)
resolves repo + credential + client into a `GithubContext`; `createGithubClient`
(`github-client.server.ts`) is the typed transport (every failure is a value: `ok | http | network`).
Project repo only — the task-level repo override was deleted (P13-D-5).

### 4.1 Branch

`taskBranchName(taskKey)` = `taskKey.toLowerCase()` (`app/server/github/branch-sync.server.ts:45`;
owner ruling 2026-07-17 killed the old `<key>-<title-slug>` form). Deterministic and therefore
**not an identifier** — keys restart at 1 on a fresh data root, so `vib-4` on GitHub may still carry
a wiped instance's VIB-4 work. That single fact drives R15-15, R16-1 and R18-4 below. Legacy names
still resolve: the private `isTaskBranchName(name, taskKey)` in `push-workspace.server.ts` accepts
`vib-1` **or** `vib-1-<anything>`.

Two creators:
1. **Remote-first** — `ensureTaskBranch(db, {projectSlug, taskKey}, actor, ctx)`
   (`branch-sync.server.ts:250`). `GET git/ref/heads/<branch>`; on 404 resolves the default-branch
   head (`ghRefSchema` is *strict* on `object.sha` — never create a branch from nothing) and
   `POST git/refs`. Idempotent (existing ref → `created:false`; 422 `/already exists/i` → success).
   403 → `flagScopeViolation(scope: "repo")`. Audits `github.branch.created`. Called best-effort by
   `ensureTaskBranchBestEffort` (`operator-actions.server.ts:1997`).
2. **Workspace-first** — the delivering specialist runs `git checkout -B <branch>` in its clone;
   the branch is discovered and written back by `reconcileWorkspaceDelivery`.

Also in `branch-sync.server.ts`: `getBranchCompare`, `taskCommits`, `deriveSyncState`. **DG-3
rate-limit split** at `:168` — `isRateLimited = rateLimit.remaining === 0 || /rate limit/i` — so a
transient 403 blip never auto-opens a bogus `repo` scope violation.

### 4.2 Agent work — per-engagement workspace isolation (P8, pass 25)

`app/server/tasks/specialist-run.server.ts`:

- `taskCloneDir(ctx, slug, key, support?)` (`:2663`) → `supportCheckoutDir(...)` (`:2691`).
- **Delivering** engagement owns the canonical checkout `<workspaceRoot>/<repo>` — the tree
  `git add -A` ships, the operator reads, and evidence paths resolve against.
- **Every supporting (non-delivering) engagement** gets its own checkout at
  `<workspaceRoot>/support/<profileId>/<repo>`.
- Why: since R22 removed the Codex read-only OS sandbox, a supporting run's repo writes are only
  ADVISORY-blocked on Codex — without isolation a reviewer's writes could be swept into the
  delivered PR by `git add -A` (the F-P8 governance hole).
- Keyed by the engagement's **`profileId`** — there is no `engagementId` anywhere in the repo.
- `taskWorkspaceRoot(slug, key, dataRoot)` (`:2649`) = `<taskDir>/workspace`;
  `taskDir` is `app/server/files/file-store-root.server.ts:68` (`projects/<slug>/tasks/<KEY>/`).
- Threaded as `const support = delivers ? undefined : { profileId }` at `:1492` (fresh run) and
  `:2757` (`resolveResumeConfinement`); resume path `resumeWorkdir(...)` in
  `app/server/tasks/agent-reply.server.ts:668`. Even a checkout-less run stays isolated:
  `runWorkdir = clone?.dir ?? (realBackend ? supportRoot : null)` (`:1526`).
- A supporting clone is `git clone --local <deliveringDir>` (`:3111`) so it actually carries the
  delivering agent's LOCAL task branch (the shared mirror does not have it until a push); origin is
  then re-pointed at GitHub. No delivering checkout yet → a normal mirror clone of the default branch.
- Prompt fence for supporting runs (`:2480`): "this workspace is your OWN isolated checkout —
  nothing you write here reaches the delivered PR."
- **Concurrency (P8 Finding-2, `:1276`):** because `cloneRepo` destructively re-clones a support dir,
  two overlapping runs of the SAME supporting engagement are refused 409 (`liveSameEngagement`);
  different supporting profileIds still run concurrently. A live delivering run is refused separately.
- Path rewriting (`agent-reply.server.ts:495`, `WORKSPACE_ABS_PATH_RE`) skips the optional
  `support/<profileId>/` group so a reviewer's echoed path collapses to the repo-relative form.
- **Retention:** `reclaimTerminalTaskWorkspaces(db, {dataRoot})` in
  `app/server/tasks/workspace-retention.server.ts:85` removes `<taskDir>/workspace` (support subtrees
  included) once the task reaches the terminal stage; called at boot after run recovery
  (`app/server/boot.server.ts:406`,`:449`).
- Clones go through a per-project mirror cache: `cloneWorkspaceRepo` / `projectRepoMirrorDir` in
  `app/server/tasks/repo-mirror.server.ts` (R21-4, ruling 87 — a 113MB repo was re-fetched per task).
  `cloneRepo` (`:3057`) stamps `agentGitIdentity(profileId)` (F24) and sanitizes the origin URL so
  **no PAT is ever in `remote.origin.url`**.

**Single-writer invariant.** At most ONE engagement carries `delivers: true`
(`engagementSchema` in `app/schemas/task-file.schema.ts:183`; the parser coerces extras).
`deliveringEngagement(fm)` is the accessor.

**`pinnedBackend` (F27-B1, owner ruling 2026-08-24).** Declared on both `engagementSchema:205` and
`agentRefSchema:171` (`"codex" | "claude" | null`, optional). A `retry_other_backend` recovery sets
it (`specialist-run.server.ts:1949`), and later runs of THAT engagement resolve to it **over** the
live profile primary. Full resolution order:
`backendOverride ?? pinnedBackend ?? live deployment ?? snapshot`
(`specialist-run.server.ts:1326`, `agent-reply.server.ts:348`,
`app/server/projections/agent-deployments.server.ts:110`). Absent/null (the common case) leaves "a
run follows the live profile" intact, so an admin's profile-backend change still takes effect next
run. This composes with ruling 97 (the live-backend display law): `withLiveAgentBackends`
(`app/shared/mapping/task.server.ts:369`) overlays the live `profileId → backend` map onto the task
snapshot, but `:420` returns the agent unchanged when `pinnedBackend` is set — the pin wins on
display too, so the card names what a run would actually use.

### 4.3 Delivery decision (R15-2, ruling 21)

Push + review-PR opening is **not** a stage side-effect. The operator holds the `deliver-review-pr`
capability and decides when delivery is plausible; the SERVER executes the mechanics; specialists
never push or open PRs. Human escape hatch: `manualDeliverForReview`
(`task-actions.server.ts:5168`) — the task **owner** (via `ownerException`, archived freeze still
applies) or `run-agents` (maintainer+). Audit `github.delivery.manual`; the operator path audits
`github.delivery.operator`.

### 4.4 Push — `pushWorkspaceBranch`

`app/server/github/push-workspace.server.ts:474` (F-GH3). Runs at the review boundary, **before** the
PR is opened. `PUSH_TIMEOUT_MS = 120_000`. Never throws — every failure is a typed value.
`PushWorkspaceResult` (`:63`): `pushed | push_conflict | push_failed | no_branch | no_pat | no_repo |
no_workspace | no_commits | grant_withheld | task_not_found`.

Order (the ordering is load-bearing):
1. `findWorkspaceRepoDir` (`:430`) — candidates `workdir` → `<wsRoot>/<repoName>` → `<wsRoot>/repo`
   → `<wsRoot>`, first with a `.git`.
2. `git rev-parse --abbrev-ref HEAD`; `""` / `HEAD` / the default branch → `no_branch` **with**
   `defaultBranchEvidence`.
3. **Grant gate (F10-03):** `canCommitPush === false` → `grant_withheld`, refused *before* touching
   the index or the remote.
4. **Delivery auto-commit:** dirty tree → `git add -A` + commit
   `"[<taskKey>] deliver working-tree changes from the agent run"`. `commitIdentityArgs` (`:411`)
   falls back to `Viberr Delivery <delivery@viberr.local>`. Only reachable once HEAD is confirmed on
   a task branch, so it can never auto-commit onto the default branch.
5. `countCommitsAhead` — `0` → `no_commits` with re-read evidence; `null` (unknown) still pushes.
6. PAT → `createGitHubAskpassEnv({token})`; `git push origin HEAD:refs/heads/<branch>`;
   `askpass.dispose()` in `finally`.
7. `isNonFastForwardStderr(stderr)` (`:236`) → `push_conflict`; otherwise `push_failed` carrying both
   `detail` and `stderrExcerpt`, scrubbed by `redactGitOutput(stderr, {token})`.

`DefaultBranchEvidence` (`:59`, `readDefaultBranchEvidence` at `:336`) is the R19-8 honesty half:
`verified: true` only after **three** read-only probes agree — `git status --porcelain` clean, no
local task branch via `for-each-ref`, and no commits ahead of the default branch. `no_branch` covers
both "a verification-only task correctly changed nothing" and "a developer edited files and forgot
`git checkout -B`"; only the first may become a no-change completion. Every unknown is
`verified: false` with its own `why`.

`discardLocalTaskBranch` (`:790`) executes the `discard_branch` packet option — see §4.10.

`app/server/github/workspace-delivery.server.ts:231` (`reconcileWorkspaceDelivery`) covers the
`gh`-CLI-shaped agent-side delivery path with an injectable `CommandExec`: `git log --oneline
origin/<default>..HEAD` for commits, mints/refreshes `workRevision` via `nextWorkRevision(...)`
(`:392`) using the full `HEAD` and `HEAD^{tree}` shas — **only when `hasDeliveredWork`** (P11-72) —
and detects the PR with `gh pr view <branch> --json number,state,title,headRefOid`
(`mapGhStateToCache` at `:170` maps `OPEN|CLOSED|MERGED`). Audits `github.workspace.branch_reconciled`
and `github.workspace.pr_linked`. Never throws.

### 4.4b `performDelivery` — the delivery packet

`app/server/tasks/task-actions.server.ts:4709`. `DeliveryOutcome` (`:4678`):
`delivered | push_conflict | grant_withheld | push_failed | nothing_to_review | failed`.

- `resolveDeliveryPushGrant` → `pushWorkspaceBranch` → branch on the status.
- **`push_conflict` opens NO PR** — it would review the stale remote content instead of the delivery
  (the live F15-15 failure).
- `push_failed` surfaces the untruncated git block as a fenced timeline section
  `"What the push reported:"` (ruling 69).
- **A3 no-change reclassification:**
  `verifiedNoChange = push.defaultBranchEvidence?.verified === true && (status === "no_commits" ||
  (status === "no_branch" && neverDelivered))` → mints a base-anchored `workRevision`, sets
  `fm.noChanges = true`, recomputes `fm.validation`, returns `nothing_to_review`. `no_workspace` is
  deliberately excluded.
- On `pushed`: best-effort `reconcileWorkspaceDelivery` (P11-10 — re-mint so the reviewers' subject
  matches what the PR delivers), then `openTaskPr`.
- On `ok`: clears a stale `fm.noChanges`, `withdrawSupersededDeliveryPacket` (`:2434`), then
  `autoInvokeOperator(..., "delivered")` at full autonomy or `recordDeliveredNextStep` when supervised
  (R19-4).

### 4.5 PR creation / adoption / collision

`openTaskPr(db, {projectSlug, taskKey}, actor, ctx)` — `app/server/github/pr-open.server.ts:316`.
`OpenTaskPrResult` (`:211`): `ok | <GithubContextFailure> | task_not_found | no_branch |
branch_collision | scope_violation | auth_failed | nothing_to_review | network_unavailable`.
Idempotent twice over (NFR16). Step order:

0. **Cached live PR.** A non-terminal `fm.pr` is re-read from GitHub; reused only if genuinely open.
   A **terminal** cached PR (closed unmerged OR merged) clears the way for a fresh one — DG-1
   merged-PR-reuse: reworking a branch whose PR already merged must open a NEW review PR, not
   resurrect the merged one (which would dead-end acceptance at "merge pending" forever). The
   terminal PR is deliberately NOT reconciled into the cache here (that would record a misleading
   `github.pr.opened` for a PR being discarded).
1. **Head dedup / adoption** — `prAlreadyOnHead` (`:404`), `GET /pulls?head=<owner>:<branch>&state=open`.
   `null` — and only `null` — clears the way to create; "another PR is on this head" and "we could not
   find out" both forbid a second attempt (a `decode` failure is `network_unavailable`, F21-9).
2. **Body** — `deliveredDiffStats` (`:148`, a live `GET /compare/base...head`) beats the cached
   `fm.github.changed`/`commits` (F22-10: stale-branch stats leaked into PR #187); fallback
   `latestEvidenceLines`. `composePrBody` (`:43`) emits the task deep-link, `## Goal`,
   `## Change summary`, `## Evidence`, and closes with
   *"Review and merge are human-authorized."*
3. **Create** `POST /pulls` with `title: "[<taskKey>] <title>"`. On success → `writePrToTask(...,
   created: true)` then `markWriteScopeProven(db, gh.patId)`.
   - **422 disambiguation** (`ghValidationBodySchema`, `:298`): `/no commits between/i` →
     `nothing_to_review`; `/already exists/i` → re-run `prAlreadyOnHead()` (the race); anything else →
     `network_unavailable` with the joined `errors[].message`.
   - **403** → `flagScopeViolation(scope: "pull_request:write")`, never a throw.
   - **F21-9 salvage:** a `decode` failure on the CREATE response is re-parsed with
     `ghCreatedPrSalvageSchema` (`:283`, only `number` required) so the PR is still recorded.

`writePrToTask` (`:645`) preserves `checks`/`review` on the SAME PR (P13-D-28), applies the **H1
guard** (never downgrade `accepted`/`merged` to `review`), and audits `github.pr.opened` **only when
`created`** (B-GH4) — a reuse pass writes no audit row.

**R15-15 (ruling 34): a task owns a PR only if that task opened it.** `openTaskPr` is the sole writer
that establishes the link; the reconciler keeps an owned link honest, never mints one.

**R16-1 (ruling 35): adoption requires OPEN *and* head sha == the delivered revision.** Identity, not
containment (acceptance accepts a head that merely *contains* the delivered commit; adoption is the
stronger claim). A task that delivered nothing adopts nothing. (Live H8: a brand-new VIB-4 adopted a
week-old merged PR and wore a green "merged" badge for work never pushed.)

`app/server/github/pr-adoption.server.ts`:
`decidePrAdoption({state, prHeadSha, revisionHeadSha}) → PrAdoptionDecision`; adopt requires
`state === "review"` **and** `prHeadSha === revisionHeadSha`. **`PrAdoptionRefusal` in the CODE is
`merged | closed | no_revision | head_unknown | head_mismatch`** — the code split ruling 35's
`not_open` into `merged` vs `closed` (F17-L4) because their hazards differ: a merged PR's work is
already on base so a fresh delivery fast-forwards once the stale name is cleared, while a closed PR's
branch still holds its commits so a fresh push conflicts. `prAdoptionRefusalNote(...)` (`:104`) is the
ONE branch-collision sentence, shared by all three refusing sites: `pr-open.server.ts:422` (blocks
delivery), `github-reconciler.server.ts:560` (writes the note once), `workspace-delivery.server.ts:530`.

**R18-4 (ruling 50): branch-collision stays a human-gated packet.** A stale remote task branch forces
a collision packet before delivery. The rejected fix was "always force-reset the remote task branch
to base"; the ruling KEEPS the packet + human resolve as a safety checkpoint against clobbering
unrelated remote history. Chain: `performDelivery` → `surfaceDeliveryEvent("Delivery blocked by a
branch collision")` → `failed`; `operatorDeliverForReview` (`operator-actions.server.ts:2362`) turns a
`push_conflict` into a tool result instructing the operator to open a packet so a human deletes/renames
the remote branch or archives the task. The packet's structured marker is a `discard_branch` option —
`withdrawSupersededDeliveryPacket` (`task-actions.server.ts:2434`) scopes on exactly
`type === "blocked" && !options.some(accept_completion) && options.some(discard_branch)`, and
deliberately leaves `archive_task` reject-recovery packets alone. Audit
`task.packet.withdrawn_superseded` with `{reason: "delivery_succeeded"}`.

**Linking** — `findPrForBranch(client, repo, branch)` (`pr-linker.server.ts:373`) takes the newest of
`GET /pulls?head=<owner>:<branch>&state=all&per_page=5`, then a detail read.
**F26 stale-terminal guard (`:430`):** a `closed` PR whose branch head has moved past it returns
`{status:"none"}` so `openTaskPr` opens a fresh PR; an unreadable branch fails safe and links as
before. `summarizeCheckRuns` (`:249`, F21-7) distinguishes pending (`null` conclusion) from **unknown**
(undecodable entry / `total_count` shortfall). `deriveReviewState` (`:298`) takes the latest per
reviewer and never lets `COMMENTED`/`PENDING` replace a standing verdict; `changes_requested` outranks
`approved`. **Absent-key contract:** `review`, `approvals` and `mergeable` are set only when actually
read — absent means UNKNOWN, so the reconciler keeps the cached value.

### 4.6 Review — revision-bound

`app/schemas/task-file.schema.ts`:

- `workRevisionSchema` (`:538`) — `{id, headSha, treeSha, branch, createdAt, sourceProfileId, kind}`.
  `kind: "delivered" | "verified"`; **absent reads as `delivered`** (pre-pass-19 files), so read it as
  `=== "verified"`, never `!== "delivered"`. A `verified` revision is the default-branch head a
  reviewer judged on a task with nothing to deliver, and never carries a task branch.
- `nextWorkRevision(current, …)` (`:912`) returns `{revision, changed}`; `changed: false` keeps every
  prior verdict valid.
- `reviewVerdictSchema` (`:567`) — `{profileId, revisionId, headSha, result, reason, at}`;
  `REVIEW_VERDICT_RESULTS = ["approve","request_changes"]`. A verdict binds to `revisionId`, so a new
  revision **automatically staleness-invalidates** every prior verdict (F10-32 — this replaced the
  "rework = a comment or stage bounce" heuristic).
- `verdictCapable: boolean` on the engagement (`:196`) — an **engage-time snapshot** of whether the
  profile held an explicit `report-validation-verdict: direct` grant. A pure file-local flag so the
  required-reviewer set needs no live profile lookup. **Engage-time is authoritative.**
- `requiredReviewers(fm)` (`:708`) = supporting engagements with `verdictCapable`.
- `currentVerdicts(fm)` (`:713`) = verdicts whose `revisionId` matches the current revision.
- `deriveValidation(fm)` (`:730`) → `failing | healthy | changed | none | bypassed`. Arm order is
  load-bearing: real verdicts win first; `acceptance === "forced"` yields `bypassed`; the R19-8
  no-change arm only fires with `required.length === 0`.
- `acceptanceBlockedReason(fm)` (`:791`) — the gate.

**The only three engagement writers** (`app/server/tasks/specialist-run.server.ts`):
`assignSpecialist` (`:758` — writes `delivers: true`, `verdictCapable:
resolveAgentCollab(caps).verdict`, and deliberately carries `pinnedBackend` across the row rebuild),
`assignReviewer` (`:848` — snapshots `verdictCapable` **once** at `:905`; the `alreadyEngaged` arm at
`:892` returns the **stored** snapshot, not a fresh resolve, "those two can differ, and only one of
them governs"), `removeReviewer` (`:980`). All three recompute `deriveValidation` in the same lock,
because the roster is an input to `requiredReviewers`. The tolerant parser `parseEngagements` (`:1106`)
dedupes `profileId` and **demotes** extra `delivers: true` rows.

**Where `verdictCapable` comes from.** `resolveAgentCollab(grants).verdict` in
`app/server/tasks/agent-outcome.server.ts:407` = `effectiveCollabMode(grants,
"report-validation-verdict") === "direct"`. `effectiveCollabMode` (`:381`) honors an explicit
`direct|human|off`; **`recommend` is NOT authoritative** and falls to the catalog default (`off`) —
the R7-5 coercion hazard, since widening would silently arm verdict-veto on a delivering developer.
Verdict *recording* reads the same source with a legacy fallback
(`task-actions.server.ts:3194`): `verdictEngagement ? verdictEngagement.verdictCapable === true :
collab.verdict` — prefer the engagement snapshot; fall back to the live grant only when there is no
engagement row.

**Verdict extraction from prose:** `classifyReviewerVerdict(text)` (`task-actions.server.ts:2497`) →
`approve | request_changes | null`. Three tiers: an explicit `Verdict:` line wins, then strong
request-changes phrases, then weak negatives (`fail`, `blocker`) only when not locally negated
("no blockers" stays positive). Verdicts are written last-write-wins per `(profileId, revisionId)`
(`:2755`), `reason` clamped to 2000 chars.

**Revision minting — exactly two producers.** `nextWorkRevision` (schema `:912`), whose only caller is
`workspace-delivery.server.ts:392`, uses `treeSha` when both sides have one (else `headSha`) as the
identity: same subject → the SAME revision object and `changed: false`. And the R19-8 verification
mint inside `recordAgentCompletion` (`task-actions.server.ts` ~`:2732`) — preconditions are narrow
(verdict `approve`, actor is an agent, pre-state has no `workRevision`/`pr`/`branch`, no delivering
engagement, approver is a `!delivers && verdictCapable` engagement) and re-checked **inside the write
lock**.

`app/features/review/review-acceptance-authority.server.ts` and `review-helpers.ts` carry the
surface-side derivation; `app/shared/acceptance-disclosure.ts` owns the disclosure contract.

### 4.7 Verdict-gated acceptance

**R15-1 (ruling 20).** Human acceptance requires a healthy reviewer verdict on the delivered
revision. Force-accept is the only bypass, and it never bypasses the PR-head-must-contain-the-
delivered-commit check. Every accept — force included — shows a confirm dialog stating what merges
and any missing signals.

**The full refusal stack** — `acceptanceRefusalReason(project, fm, taskKey, {blockedPacket, noChange})`
at `task-actions.server.ts:6871`, first non-null wins:
`archivedTaskBlockedReason` (R14-3) → `closedPrBlockedReason` (R16-3, terminal GitHub fact) →
`acceptanceStageBlockedReason` (`:6835`, workflow-graph boundary) → `acceptanceBlockedReason(fm)`
(required reviewers) → `noChangeWorkRefusal` (R20-2/F20-6, the live probe found commits) →
`verdictGateReason(...)` (R15-1) → open blocked packet → `conflictingPrBlockedReason` (P14-LV-07).
Public read wrappers: `acceptanceRefusalFor` (`:7167`) and `resolveAcceptanceAffordance` (`:7251`) →
`AcceptanceAffordance {hasAuthority, atBoundary, blockedReason, blockedReasonViaPacket, canAccept,
terminallyBlocked, verdictSatisfiedBy}`. The **projection mirror** is `acceptanceBlockReason` in
`app/server/projections/rebuilder.server.ts:340` → column `validation_block_reason`; it deliberately
omits three gates (archived, the stage boundary, and the no-change refusal, which needs a live async
probe), and the Review queue re-derives the rest in `gateBlockedByKey`
(`app/server/projections/review-queue.server.ts:252`).

`verdictGateReason(fm, validation, taskKey, noChangeVerified?)`
(`pr-human-approval.server.ts:306`) order: no `workRevision` → allow; delivered work with **no PR** →
refuse *unless* `fm.noChanges || workRevision.kind === "verified" || noChangeVerified`; `healthy`/
`failing` → allow (failing was already named precisely upstream); `humanVerdictApproval` → allow;
else the near-miss note, else "Run a review for a verdict, approve the pull request on GitHub, or an
admin can force-accept."

**R21-5 (ruling 88): the ceremony is a SERVER invariant.** `app/shared/acceptance-disclosure.ts`:
`AcceptanceDisclosure {pr, revision, verdict}`, `ACCEPT_DISCLOSURE_FIELDS = {pr: "ackPr", revision:
"ackRevision", verdict: "ackVerdict"}`, `acceptanceDisclosureFields` (writer),
`parseAcceptanceDisclosure` (reader — strict membership tests, never a cast; any missing field →
`null`), `acceptanceDisclosureDrift(live, echoed, scope)` where `scope: "in-lock"` skips the PR fact
(this acceptance's own merge may have moved it) but always re-compares revision and verdict.

The throwing side is `assertAcceptanceDisclosure(fm, ack, taskKey, scope)`
(`task-actions.server.ts:7466`) over `acceptanceDisclosureOf(fm)` (`:7433`, derived from the canonical
file, never the projection). Three-state `ack`: `undefined` → allowed (in-process callers with their
own contract — packet resolution, `applyRecommendation`, full-autonomy operator); `null` → 400
`ERROR_CODES.ACCEPT_DISCLOSURE_MISSING`; drift → 409 `ERROR_CODES.ACCEPT_DISCLOSURE_STALE`
(`app/server/errors/error-codes.ts:19`,`:22`). Four throwing sites: `acceptCompletion` (`:7732`,
scope `"full"`, before the merge), `applyAcceptanceWrite` (`:7575`, scope `"in-lock"` — **`skipInLockRecheck`
for force does NOT relax it**), `forceAcceptCompletion` (`:8097`), and every HTTP door transitively.
Client side: `app/features/task-detail/accept-confirm.tsx:254` builds the disclosure **from the
rendered props**; parsed server-side by `acceptanceAck(formData)` at `app/routes/project.task.tsx:376`
and `app/routes/project.board.tsx:42`. Scope is the HUMAN acceptance paths only.

**R19-B (ruling 68): a project member's GitHub approval IS the approving verdict.**
`app/server/github/pr-human-approval.server.ts`:
- `PR_APPROVAL_STATUSES` (`:43`) = `counted | unlinked_handle | ambiguous_handle | not_a_member |
  stale_revision`.
- `resolveGithubHandle(db, login)` (`:93`) maps via `lower(users.github_handle)`, disabled excluded;
  **two claimants → `ambiguous`**, never a coin flip.
- `derivePrHumanApproval(...)` (`:127`) classifies every standing approval and keeps ONE record; a
  `counted` approval always outranks a near-miss so a stranger cannot mask a member, and the best
  near-miss is kept **so the surface can explain it** — silence is not fail-closed disclosure.
- `humanVerdictApproval(fm)` (`:210`) **re-checks the revision binding on every read** against the
  current `workRevision.headSha` — a re-delivery revokes the approval instantly, offline, with no
  GitHub round-trip. Conversely an unreachable GitHub cannot flip a satisfied gate red (the
  reconciler carries the last record forward as UNKNOWN).
- `humanVerdictNote` / `humanApprovalRefusalNote` / `verdictGateReason` (`:232`,`:247`,`:306`) — the
  gate is **never silent**: it names the human, their handle and the commit.

**R17-1 (ruling 42): accept a head AHEAD, but surface the divergence.** The gate is containment-based
(a legitimate auto-commit on top of the delivery is fine). A head that has **diverged** (no longer
contains the delivered commit) still refuses — `acceptancePrHeadCheck` (`:7022`) +
`assertVerifiedHeadStillApplies` (`:7045`, re-checked in the write lock) + `acceptancePrHeadMismatch`
(`:7074`); this is the ONE acceptance gate force-accept can never bypass, and `completeTaskMerge` runs
it too (A2, `:8205`).

The field is `pr.revisionDrift: {aheadBy, headSha} | null` (`task-file.schema.ts:433`), measured by
the reconciler (`github-reconciler.server.ts:445`) only when the PR is owned, `pr.headSha !==
workRevision.headSha`, and the PR state is `review`/`accepted`; a second `getBranchCompare(reviewedSha,
pr.headSha)` recording `{aheadBy, headSha}` on a clean `"ahead"`. F21-17: on a settled PR the last
measurement is **carried forward**, not erased. Surfaced in five places:
review-queue subline (`review-helpers.ts:78` inside `prStateSub`), the accept/force dialog's
`obs warn` "Merge head" row (`accept-confirm.tsx:375`), the completion record
(`revisionDriftNote(fm)` at `task-actions.server.ts:7338`, appended by every acceptance path incl.
`operator-actions.server.ts:2696`), the operator snapshot + tool description
(`operator-actions.server.ts:1729`, `operator-toolkit.server.ts:262`), and the board card. The
*enforced* half is the disclosure echo: a stale `ackRevision` is refused, so a tab left open across a
re-delivery can no longer accept a revision the human never saw.

**R19-8 (ruling 62): "Completed — no changes" passes the SAME verdict gate.** It mints a
`kind: "verified"` revision anchored to the real default-branch head so the verdict has a subject.
Requires `defaultBranchEvidence.verified` from push-workspace on BOTH doors (`no_branch`,
`no_commits`). Machinery: `app/server/tasks/no-change-completion.server.ts`.

**Force-accept (DG-2 / R19-5, ruling 59).** `force-accept-completion` is admin-only.
`forceAcceptCompletion` computes `bypassed` (the gate as it stood BEFORE the write) via
`acceptanceRefusalReason`, calls `acceptCompletion(force: true)`, and records
`task.acceptance.forced` with `{bypassed}` **only after** the write succeeded (U3/NFR16 — a
double-submit used to leave two rows, and a refusal below it left a row claiming a bypass that never
happened). It MAY skip remaining stages and the review gate but must SAY so (the confirm dialog
enumerates the skipped stages). It does NOT bypass ruling 37's terminal GitHub fact (a closed,
unmerged PR still refuses, server-side) nor ruling 20's head-containment check
(`forceIrreducibleRefusal`).

**R16-3 (ruling 37).** A terminal GitHub fact (closed, unmerged PR) is named FIRST, ahead of any
process gate, and while the PR is closed admin Force-accept is **WITHDRAWN (hidden)**, not disabled
(`acceptanceTerminallyBlocked(fm)` = `fm.pr?.state === "closed"`, `:6937`; client gate
`task-detail-hooks.ts:168`).

**Review queue.** `getReviewQueue(db, slug, {viewerUserId, dataRoot?, now?})`
(`app/server/projections/review-queue.server.ts:114`) — `viewerUserId` is **required** (E5: the old
optional parameter defaulted an authorization question to "yes, anyone").
`isReady(r)` (`:270`) = `waiting === "human" && canAccept(key) && blockReason === null &&
!gateBlockedByKey.get(key) && pr?.state !== "closed"`; `canAccept` (`:234`) is
`roleCan(role, "resolve-packet")` OR (`roleCan(role, "own-task")` AND the viewer is the human owner) —
fails closed for a non-member. An archived project yields `reviewId = null` → an empty queue (F19-9).
Row copy: `reviewRowSub(t)` (`review-helpers.ts:87`) precedence is closed PR → `blockReason` →
`packet` → live PR state → latest event → per-`waiting` placeholder. The row says **"Review", not
"Accept"** (R15-11): acceptance is verdict-gated and may refuse.

**Who may accept on the operator side.** `resolveAcceptanceAuthority(projectSlug, ctx)`
(`app/features/review/review-acceptance-authority.server.ts:29`):
`operatorCanAccept = deployed && autonomy === "full" && gate(authority, "completion-for-acceptance")
=== "direct"`; `catch` → `{operatorCanAccept: false, operatorName: "the operator"}`. The narrowness is
enforced in `gate()` (`operator-actions.server.ts:446`): full autonomy promotes `recommend → direct`
for every capability **except** `completion-for-acceptance` (owner ruling Q1; the catalog entry at
`capabilities.ts:64` carries `promotable: false`).

### 4.8 Merge — human-only

**R16-6 (ruling 40): `merge-pull-request` is and stays `ALWAYS_HUMAN`.** "Done" has two meanings:

- A **full-autonomy operator** that accepts completion CANNOT merge. It records
  `pr.state: "accepted"` — *merge pending* — moves the task to Done, and a human merges later
  (`operator-actions.server.ts:2684`,`:2718`). The difference must be visible on the board card and
  the review queue, not only the detail page.
- A **human** acceptance triggers a real async merge.

`completeTaskMerge(db, {projectSlug, taskKey}, actor, ctx)` (`task-actions.server.ts:8144`) is the
merge-pending completion door:
- requires `actor.userId` (a signed-in human) — explicit validation error otherwise;
- `requireAcceptCompletion` (maintainer+ OR the task owner, R6-2);
- **F21-23:** `pr.state === "merged"` settles as a **no-op success** with an honest message
  (`"PR #N was already merged on GitHub; nothing merged now."`) and **writes nothing** — minting a
  second completion for a click that changed no state is the invented record ruling 88 prevents.
  `merged` answers "is it merged when this returns", not "did this call merge it";
- any other non-`accepted` state → 409;
- **A2:** `acceptancePrHeadCheck` runs here too — this is a Done writer and used to run the head gate
  on neither side;
- delegates to `mergeTaskPr` (`github-reconciler.server.ts`), which writes `pr.state="merged"`, a
  `github` timeline event and the audit row.

`mergeTaskPr(db, {projectSlug, taskKey}, actor: AuditActor & {userId: string}, ctx)` —
`github-reconciler.server.ts:1161`. **`userId` is a required, non-optional field of the signature** —
that is the type-level half of human-only. It reads the PR, refuses `mergeable === "conflicting"`
*before* attempting (P14-LV-07), un-drafts a draft PR via GraphQL `markPullRequestReadyForReview`
(F7-GH5, best-effort), then `PUT /pulls/{n}/merge`. On success: drops `mergeable`, stamps
`state: "merged"`, appends a `github` event authored `{kind: "human", userId}`, records provenance
`github.merge`, audits `github.pr.merged`, resolves any open `pull_request:write` violation, calls
`markWriteScopeProven`, and runs branch cleanup inside a `try/catch` whose comment is explicit ("an
acceptance that reported failure over a completed merge is the one outcome this block must never
produce"). Failure mapping: 405 → `not_mergeable`, 409 → `head_changed`, **403 → opens a
`pull_request:write` scope violation + `github.pr.merge_refused` audit** (never throws), 404 →
`pr_not_found`, 401 → `auth_failed`.

Six more pieces of human-only evidence: `capabilities.ts:151` declares the cap with default mode
`human` and `promotable: false`; `agent-profile-actions.server.ts:301`,`:353`,`:548` coerce
`mode = "human"` on write; `app/server/tasks/specialist-tool-policy.ts:67` denies
`Bash(gh pr merge:*)`; `attemptAcceptanceMerge` (`task-actions.server.ts:5436`) returns
`{kind: "pending", cause: UNREACHABLE_MERGE_CAUSE}` immediately when `!actor.userId`; the operator
toolkit exposes `deliver_for_review` and `update_branch_from_base` but **no merge tool**; and the PR
body itself says "Review and merge are human-authorized."

**Merge-pending state.** `pr.state === "accepted"` is Viberr's own state (documented at
`pr-linker.server.ts:26`) — a human accepted the completion but the real merge could not run.
`nudgeMergePendingTasks` (`reconcile-poller.server.ts:58`) reminds via
`json_extract(pr_json,'$.state') = 'accepted'` (B9 replaced a `LIKE '%"state":"accepted"%'` scan).

**Branch cleanup (R15-6, ruling 24).** `branchCleanupOnMerge(db, projectSlug)` in
`app/server/github/branch-cleanup.server.ts:32` reads `projects.guardrails_json` for
`BRANCH_CLEANUP_GUARDRAIL_ID = "delete-branch-after-merge"` — **absence means ON** (so pre-ruling
projects need no rewrite); only an explicit `on: false` disables. Mechanics:
`deleteTaskRemoteBranch(db, {projectSlug, taskKey}, actor, ctx)` (`github-reconciler.server.ts:1422`)
refuses three things outright — no acting `userId` ("branch deletion is a HUMAN decision"), the
default branch, and an OPEN PR (`review`/`accepted`; deleting the head would silently close it). Ref
path is `encodeRefPath("heads/" + branch)` (B11 — encoded per segment so `/` stays a separator); 422 →
`already_gone`. Audit `github.branch.deleted`, provenance `github.branch_delete`. Callers: post-merge
inside `mergeTaskPr` (`:1312`) and the `archive_task` + `deleteBranch` packet option
(`task-actions.server.ts:6468`,`:7967`).

### 4.9 Reconciliation + divergence

`app/server/github/github-reconciler.server.ts` + `reconcile-poller.server.ts`
(`RECONCILE_POLL_MS = 5 * 60_000`; `RECONCILE_FAILURE_ALERT_THRESHOLD = 3`;
`RECONCILE_TASK_CONCURRENCY = 4`; `RECONCILE_POLL_TASK_BUDGET = 20`).

`reconcileTask` (`:869`) wraps `reconcileTaskUnlocked` (`:309`) in `withTaskReconcileLock` (`:265`) —
a **per-task QUEUE, not a coalescer** (F19-19): the second pass re-reads after the first writes, and
failures are absorbed in the tail link so one bad pass never strands the key. Ownership is
`sameAsCached || adoption?.adopt === true`; a foreign PR is recorded as `github.unownedPr` so the
collision note fires **once** (`unownedPrIsNew`) rather than on every ~288 daily ticks. The patch is
re-applied inside `updateTaskFile` with `keepCurrent` guarding `merged` (irreversible) and a local
`accepted` against a stale remote `review`. `reconcileProject` (`:956`) runs a **budgeted, cursor-
rotating** pass over `task_projections WHERE branch IS NOT NULL`, skipping tasks whose computed
`terminal` is `archived = 1 OR json_extract(pr_json,'$.state') = 'merged'` — deliberately not
`closed`, because a reopened PR must stay reachable from the only automatic path. It uses a bounded
worker pool, not `Promise.all` (B-GH5). `reconcileSummaryFailed(summary)` (`poller:22`, C7/pass-24) is
how failure is detected: credential/network failures come back as **values**, not throws.

**DG-3.** The provenance observation row is skipped on an *unchanged* poller tick
(`if (changed || !ctx.skipUnchangedProvenance)`), so provenance cannot grow unboundedly. The
consequence, and the reason `app/server/audit/audit-query.server.ts` exists (F19-22): the surfaces
rendering `MAX(observed_at)` as "Synced 3m ago" were claiming the last pass that RAN while showing
the last pass that CHANGED. The honest "last check" is the **unconditional** per-tick audit row
`github.reconcile.task` (`RECONCILE_TASK_AUDIT_ACTION`), read by `latestTaskReconcileCheckAt`. The
poller passes `skipProjectAudit: true`, so the project-level read unions
`github.reconcile.project` (human-triggered) with the task rows.

**PR divergence (ruling 17 + R17-5/ruling 46).** Out-of-band PR transitions are coordination events.
`github-reconciler.server.ts:785` fires
`ctx.wakeOperator ?? autoInvokeOperator(db, ctx, slug, key, "pr-diverged")` on exactly four edges:
`mergedButNotDone`, `closedButActive`, `acceptedClosedExternally`, `prJustReopened`. Fire-and-forget
on the same transition edge as the policy-engine note, so a persistent divergence never re-fires and
a project with no operator deployed is a no-op. The seam type is `OperatorWake` (`:87`); the trigger
is the kebab **string literal** `"pr-diverged"` — there is no `pr_diverged`/`prDiverged` identifier
anywhere. It also **never auto-advances the stage**; it emits typed `note` events authored by
`POLICY_ENGINE_ACTOR`, notifies watchers via `notifyTaskWatchers` with
`POLICY_ENGINE_NOTIFY_FROM = {kind: "system", name: "Policy engine"}`, and withdraws superseded
recommendations (`transition` always; `accept_completion` only on `closedButActive`).

**There is no `pr-divergence-operator.server.ts` source file** — only the test
`app/server/github/pr-divergence-operator.server.test.ts`, which drives the reconciler seam
(`ctx.wakeOperator`) plus `deleteTaskRemoteBranch`.

Operator handling — `app/server/runtimes/operator-run.server.ts:3197`:
- **closed + at terminal** → ONE `input` packet with `custom` options: reopen+merge on GitHub, or
  accept that the work stays unmerged and re-deliver via a new task. Never re-prompt an agent.
- **closed + active** → ONE recovery packet: `custom` REWORK · `archive_task` · `archive_task` with
  `deleteBranch: true` (archive AND delete the remote branch). Exactly one recommended (rework unless
  the work was rejected outright). Body must say reopening the PR on GitHub is also valid — Viberr
  detects it and withdraws the packet. **Never recommend acceptance while the PR is closed.**
- **merged out-of-band** → `accept_completion`.
- **reopened/replaced** → withdraw the now-moot packet.
- **F21-17:** the packet must carry the unreviewed out-of-band commit drift (`driftInstruction`) as a
  REQUIRED observation — the packet is model-authored, so the fact has to arrive in the turn
  instruction.

Remote branch deletion exists ONLY as that packet resolution (refuses open PRs and the default
branch). Freshness chip honesty (R17-5): `reconcile.at === null` reads neutral "Not synced yet";
only `stale && at !== null` warns.

### 4.10 `discard_branch` (R20-2 / F20-6)

A packet option kind (`PACKET_OPTION_KINDS` in `task-file.schema.ts:153`) that deletes the task's
**LOCAL, never-pushed** workspace branch — nothing on the remote changes. Operator-authored only
(taught at `operator-run.server.ts:3366`). Because it destroys commits it re-checks
`approve-transition` server-side at resolve time (`task-actions.server.ts:6257`), the same tier the
archive-with-branch-deletion path requires, and the UI asks for a two-step confirm
(`decision-packet.tsx:918`). It is in the `NO_REQUEUE` set (`:6392`, "cleanup only, no coordination
change"). The resolution write only records the decision; the git work happens after (`:6572`) via
`discardLocalTaskBranch` (`push-workspace.server.ts:790`), which:
`revParse(refs/heads/<branch>)` first so the outcome can name the sha it destroyed (`""` →
`not_found`); **ruling-17 guard** `git ls-remote --exit-code --heads origin <branch>` exits 0 →
`on_remote` (remote deletion stays the archive packet's job); `git checkout <defaultBranch>` when HEAD
is on it, then `git branch -D`. `DiscardBranchOutcome` = `deleted{branch,sha} | not_found | on_remote |
no_workspace | failed{reason}` (reason scrubbed by `redactGitOutput`). `fm.branch` is cleared **only**
when the branch actually deleted is still the one the frontmatter names. Audit:
`task.branch.discarded` / `task.branch.discard_refused`.

### 4.11 Update-branch (N19 gap 9)

`app/server/github/update-branch.server.ts` (mechanics) + `update-branch-operator.server.ts`
(decision, `UPDATE_BRANCH_CAPABILITY = "update-task-branch"`). Same R15-2 split: the operator decides,
the server owns the git.

- **MERGE, never rebase** — a rebase needs a force-push, exactly what R18-4 refused for the adjacent
  collision case. A merge commit fast-forwards the remote and can never clobber history.
- **The workspace is the writer** — the update runs in the delivering engagement's own clone and is
  then pushed, preserving the single-writer invariant (a human rebasing in a terminal is a second
  writer Viberr never sees).
- **A conflict is a human decision, never an agent retry** — it opens a decision packet and the branch
  is left exactly as it was.
- An **absent** `update-task-branch` grant falls back to the DELIVERY gate deliberately (R15-9
  situation): updating the branch is strictly smaller than delivering it, and reusing `deliverGate`
  means an undeployed operator is denied for free. `recommend` refuses honestly rather than silently
  performing (ruling Q1).
- **A dirty tree refuses** (`dirty_workspace`) — committing is a delivery decision owned by
  `pushWorkspaceBranch`. On conflict the conflicting files are read (`git diff --name-only
  --diff-filter=U`, capped at `MAX_CONFLICT_FILES = 20`) **before** `git merge --abort`. A failed push
  after a successful merge does `git reset --hard <preSha>` — all-or-nothing.
- `UpdateBranchResult`: `updated | already_current | conflict | push_conflict | update_failed | no_pat
  | no_repo | no_workspace | no_branch | dirty_workspace | task_not_found`. A conflict opens a
  `blocked` packet whose options (`conflictOptions`, `update-branch-operator.server.ts:98`) are
  `redirect` (recommended — the delivering agent resolves it in its own workspace), `custom` (a person
  resolves it), `archive_task`; the tool result says explicitly *"do not retry this yourself."*

Audit: `github.branch_update.operator`, `github.workspace.branch_reconciled`.

### 4.12 Scope violations and repo access

`app/server/github/scope-flag.server.ts`: `flagScopeViolation` is fully idempotent — `created: false`
writes no event, no notification, no reprojection. On `created` it appends a typed `policy` timeline
event **and** fans out via `notifyTaskWatchers` (E3: the old owner-only path notified nobody on an
ownerless task). `policyUpdateText(scope)` names the ACTUAL scope. Only two scopes are ever flagged:
`repo` (branch read/create, reconcile compare) and `pull_request:write` (PR open, merge).

`checkRepoAccess(db, projectSlug, opts)` (`repo-access-check.server.ts`) →
`connected | no_repo_configured | no_pat_configured | repo_not_found | auth_failed{reason:
"expired"|"revoked"} | org_approval_missing | forbidden | network_unavailable`. Memoized 30 s per
`DatabaseSync` in `github-query.server.ts` and busted by `invalidateRepoAccess(db, slug)` on every
credential mutation (LV-05: `github-actions.server.ts:129`,`:319`,`:348`). `probeRepoWithConnection`
(`github-actions.server.ts:199`) is the bind-time variant returning
`reachable | access_miss | unverified` — "we could not ask" never blocks a bind (B-GH3).

---

## 5. Audit

### 5.1 Recorder

`app/server/audit/audit-recorder.server.ts`. `recordAudit(db, event)` inserts into `audit_events`
`(id, occurred_at, actor_user_id, actor_label, action, subject_kind, subject_id, project_slug,
task_key, details_json)`. Rules: **`details` must be secret-free** (ids, emails, field names — never
passwords, tokens or hashes); **recording never breaks the action that triggered it** (failures are
logged and swallowed). `AuditDetailValue` is a JSON-only recursive type, named precisely so a caller
cannot hand over an Error/Map/class instance that `JSON.stringify` flattens to `{}` — a field name
with no fact under it. Actors: `SYSTEM_ACTOR` (`{userId: null, label: "system"}`) and
`OPERATOR_AUDIT_ACTOR` (`label: "operator"`).

Note the column is **`occurred_at`, not `created_at`**.

### 5.2 What is audited

~145 distinct action strings, dot-separated lowercase. Families:

- **auth** — `auth.login.success|failure|rate_limited`, `auth.logout`, `auth.oauth.login |
  user_provisioned | placeholder_claimed`, `auth.password.changed | reset | forced_reset_completed`,
  `identity.github.disconnected`.
- **authorization** — `project.org_admin.override` (D2), `project.authority.denied` (P13-D-8, NFR10's
  "unauthorized action attempts" — the one audited category that previously had NO row anywhere),
  `controller.authority.denied` (ruling 99 parity).
- **org** — `org.user.*`, `org.domain.whitelisted|removed`, `org.connection.*`,
  `org.oauth_provider.created|updated|tested|enabled|disabled|removed`, `org.mcp.*`, `org.kb.*`,
  `org.skill.*`, `org.store.*`, `org.agent_profile.*`, `org.controller.updated`.
- **project** — `project.created|deleted|archived|unarchived`, `project.member.invited|removed|
  role_changed`, `project.policy.boundary_changed`, `project.stage.*`, `project.settings.updated`,
  `project.repo.updated`, `project.operator.autonomy_changed`, `project.agent_profile.*`.
- **task** — `task.created|archived|unarchived`, `task.transition(ed)`, `task.ownership.*`,
  `task.packet.resolved|escalated|withdrawn_superseded`, `task.acceptance.forced`,
  `task.operator.*`, `task.agent.*`, `task.delivery.handoff`, `task.branch.discarded|discard_refused`,
  `task.schedule.created|fired|cancelled`, `task.quality.flagged`, `task.comment(.dropped|.unrouted)`.
- **github** — `github.pat.created|token_replaced|deleted`, `github.credential.assigned|cleared|
  revalidated`, `github.branch.created|deleted`, `github.branch_update.operator`,
  `github.pr.opened|merged|merge_refused`, `github.merge`, `github.delivery.manual|operator`,
  `github.reconcile(.task|.project)`, `github.scope_violation.opened|resolved`,
  `github.workspace.pr_linked|branch_reconciled`.
- **runtime / system** — `runtime.run.started|interrupted`, `runtime.operator.plan_executed`,
  `run.recovery.reinvoked|reply_replayed`, `projection.rebuild|rescan`, `secrets.resealed`,
  `seed.baseline|org_resources`, `store.restored`, `goal.created|updated|completed`.

`app/server/audit/audit-coverage.server.test.ts` drives governed entry points for their EFFECT and
asserts the row lands — that is the test to extend when adding a governed action.

### 5.3 Retention

`app/server/db/retention.server.ts`: `AUDIT_RETENTION_DAYS = 90`, `RUN_LOG_RETENTION_DAYS = 30`,
`NOTIFICATION_MAX_PER_USER = 500`. Canonical Markdown task files are **never** touched — this only
compacts rebuildable SQLite tables. Runs best-effort at boot AND on the maintenance interval
(gap 15: boot-only coupled the policy to a restart a stable deployment avoids).

`IDEMPOTENCY_AUDIT_ACTIONS` (B-FD10) is **exempt** from the window: `task.agent.replied` and
`runtime.operator.plan_executed` double as idempotency keys for boot recovery
(`NOT EXISTS (SELECT 1 FROM audit_events …)`), so deleting one would make the next boot **redo the
work** — a >90-day-old task at `waiting=agent` would have its reply posted twice. Explicitly listed,
never pattern-matched. The rolling-window recovery counters are deliberately NOT exempt (30-minute
window).

### 5.4 Reads and export

- **In-app browse** — `app/server/audit/audit-browse.server.ts` (PG26-A). Recent events newest-first,
  no `details` blob; `AUDIT_BROWSE_DEFAULT_LIMIT = 150`, max 500. Exists because org/instance-scoped
  events (`auth.login.*`, `org.*`, `github.pat.*`) had no in-app view at all — the project Activity
  page is project-scoped and templated. Org-admin gated at the route.
- **File export** — `app/server/audit/audit-export.server.ts`: `queryAuditEventsForExport(db,
  filters)` (projectSlug / action / actorUserId / since / until / limit; every filter is a bound
  placeholder), `serializeAuditExport(rows, format)`, `EXPORT_FORMATS`, `isAuditExportFormat`.
  `AUDIT_EXPORT_MAX_ROWS = 100_000`. **F26-9:** the org-settings Audit-log panel copy discloses BOTH
  the row cap and the 90-day retention window, so "the full log" is never claimed where both silently
  bound it.
- **Download route** — `app/routes/org.settings.audit-export.ts`, `requireRole(request, "admin")`,
  `Content-Disposition: attachment; filename="viberr-audit-<date>.<ext>"`, `Cache-Control: no-store`.
- **S3 push** — `app/routes/org.settings.tsx:284` intent `audit-export-s3` → `getS3AuditConfigForUse`
  + `putObjectToS3`. **F26-11:** a network-level failure makes `fetch` THROW (only HTTP errors come
  back as a result), so the call is wrapped — without the catch it re-threw raw past
  `appErrorResponse` and surfaced a stack-shaped 500.

---

## 6. Gotchas

1. **Human GitHub approval IS a verdict (R19-B, ruling 68).** Do not treat the PR review state as "a
   status pill". Four properties make it evidence and all four must survive any refactor: bound to
   the delivered revision by `commit_id` (checked when recorded AND on every read), approver must be a
   **project member** resolved via `users.github_handle`, **fails closed** (unlinked / ambiguous /
   non-member → does not count, and the reason is recorded), and it is **never silent**.

2. **`acceptance: "forced"` is a durable frontmatter fact, not just an audit row.** `ReviewState.acceptance`
   (`task-file.schema.ts:700`) and the `if (fm.acceptance === "forced") return "bypassed"` arm in
   `deriveValidation` (N20-14 §5c / C2). Without it a force-accepted, Done task re-derives "awaiting
   verdict" on every surface that renders the validation pill — a false live obligation. The arm sits
   AFTER the real-verdict arms: a reviewer who actually approved or requested changes still wins.

3. **Scope-check the NORMALIZED form.** `scopeAgentGithubReadPath` in
   `app/server/github/agent-github-read.server.ts:61` (F4 review, 2026-08-21). The GitHub client builds
   its URL with `new URL(GITHUB_API_BASE + path)`, and the WHATWG parser converts `\`→`/`,
   percent-decodes `%2e` and collapses `..` — so a purely TEXTUAL `..` check is defeated by
   `pulls\..\..\..\..\user` or `%2e%2e/%2e%2e/other/repo`. The function refuses those encodings
   up-front for a clear error, then **resolves through the same parser the client uses and re-verifies
   the scope on the normalized path** (the authoritative check), and **returns that normalized path**
   so the request and the audit row record exactly what is fetched.

4. **A task-key branch is not an identifier.** Keys restart at 1 on a fresh data root. Three separate
   rulings exist because of this one fact: R15-15 (only the task that opened a PR owns it), R16-1
   (adopt only OPEN + head-sha-identical), R18-4 (branch collision → human packet, never force-reset).

5. **Merge is `ALWAYS_HUMAN` and "Done" is ambiguous.** An operator acceptance records
   `pr.state: "accepted"` = merge pending. Any surface that renders "Done" must distinguish the two,
   on the board card and the review queue, not only the detail page (ruling 40).

6. **Scrub at ANY length (F20-7).** The by-value pass in `redactGitOutput` has no minimum. Reject
   tokens shorter than 8 at INPUT (`createPat`), never at scrub time.

7. **A sealed secret that is not in `SEALED_STORES` silently outlives a key rotation.** Any new
   `sealSecret(` call site needs a registry entry **and** a dedicated column (never a JSON blob) —
   that is why `s3_audit_config.secret_box` is its own column.

8. **`view`/`comment` have no role tier — their entire enforcement IS the membership gate.** They never
   call `requireAction`. If you add a surface, `requireProjectMember` (loaders) or
   `requireVisibleProject` (actions) is the gate, and both must produce the byte-identical 404.

9. **A child route's ACTION runs without its parent's loader**, and single-fetch honors
   `?_routes=`, so a loader-only gate on the layout is not a gate. Every project-scoped loader AND
   action needs its own.

10. **The org-admin override must leave a row every time it is used** (D2). The 60s dedupe key
    includes the caller's `what` precisely so a READ gate cannot mask a WRITE gate (F19-30).

11. **`occurred_at`, not `created_at`**, on `audit_events` — and the reconcile freshness fact is the
    unconditional `github.reconcile.task` audit row, not `MAX(observed_at)` on provenance (DG-3
    deliberately skips unchanged provenance ticks).

12. **`verdictCapable` is frozen at engage time.** Changing a profile's `report-validation-verdict`
    grant does not retroactively add or remove a required reviewer on a live task. `pinnedBackend` is
    the mirror-image case: it deliberately overrides the live profile, including on display.

13. **Force-accept never bypasses a terminal GitHub fact.** While the PR is closed unmerged, the
    force affordance is WITHDRAWN (hidden) and the server refuses too (ruling 59 fixed the
    client-only version).

14. **A no-change completion needs `defaultBranchEvidence.verified`, on BOTH doors.** Frontmatter
    cannot see a missing `git checkout -B`; only push-workspace's three read-only probes can.

15. **`decisions.md` ruling 35 and the code disagree on the refusal enum.** The ruling says
    `not_open | no_revision | head_unknown | head_mismatch`; `PrAdoptionRefusal` in
    `pr-adoption.server.ts` is `merged | closed | no_revision | head_unknown | head_mismatch`
    (F17-L4 split `not_open`, because a merged PR's branch is a name clash while a closed PR's branch
    still holds commits that will conflict). Read the code, not the ruling, for the enum.

16. **There is no `pr-divergence-operator.server.ts` source file** — only a test of that name. The
    seam it exercises is `OperatorWake` / `ctx.wakeOperator` in `github-reconciler.server.ts`.

17. **`recommend` is not a widening anywhere it matters.** For a specialist it coerces DOWN to `off`
    (`coerceSpecialistCapabilityMode`); for `report-validation-verdict` it is not authoritative and
    falls to the catalog default `off` (`effectiveCollabMode`, R7-5); and full autonomy promotes
    `recommend → direct` for every capability **except** `completion-for-acceptance` (Q1).

18. **`push_conflict` must not open a PR.** It would review the stale remote content instead of the
    delivery — the live F15-15 failure.

19. **Absent GitHub keys mean UNKNOWN, not false.** `pr-linker` sets `review`, `approvals` and
    `mergeable` only when it actually read them; the reconciler keeps the cached value otherwise.
    This is what makes an unreachable GitHub unable to flip a satisfied R19-B verdict gate red.

20. **A supporting engagement's clone is destructive.** `cloneRepo` re-clones the support dir each
    dispatch, so two overlapping runs of the SAME supporting engagement are refused 409. Do not
    "optimize" that into a reuse without re-checking the P8 isolation guarantee.

21. **`AcceptDisclosure` is a historical name.** The live component is `AcceptConfirm`
    (`accept-confirm.tsx`); the server contract is `app/shared/acceptance-disclosure.ts` +
    `assertAcceptanceDisclosure`. Error codes: `accept_disclosure_missing` (400),
    `accept_disclosure_stale` (409).

22. **`getReviewQueue` requires `viewerUserId`.** It used to be optional, which defaulted an
    authorization question to "yes, anyone" (E5).
