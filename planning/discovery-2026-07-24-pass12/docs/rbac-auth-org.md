# RBAC + AUTH + ORG — Viberr reference (pass 12, 2026-07-24)

Audience: implementation subagents with zero other context. Every claim below is
verified against `main` @ `0981cfa` (post PR #87 round-2 fixes and PR #90
clean-sheet seed). All paths are repo-relative from
`/Users/akinozer/projects/viberr`. Supersedes
`planning/discovery-2026-07-23-pass11/docs/rbac-auth-org.md`.

---

## 1. Architecture in one paragraph

Better Auth (v1.6.23, `package.json:26`) owns **authN mechanics only**:
credentials, sessions, OAuth handshakes, cookies. The legacy `users` table
remains the app's **canonical profile + org-role store**. The single invariant
binding the two: better-auth `user.id` === app `users.id`
(`app/server/auth/identity.server.ts:5-19`). Org roles are a 2-rung ladder
(`admin` / `member`) in `users.role`; **project** roles are a 4-rung ladder
(`admin` / `maintainer` / `contributor` / `viewer`) stored **file-natively** in
each project's `project.md` frontmatter `members[]` (projected into
`project_members` for reads). There is no open sign-up anywhere — identity
creation IS the whitelist. New since pass 11: the `/api/auth/*` splat is gated
by an **allow-list of the 6 endpoints the app drives** (everything else 404s),
and password hashing/verification is **total** (a legacy-format hash reads as
wrong-password, never a 500).

---

## 2. AUTH

### 2.1 better-auth configuration — `app/lib/auth.server.ts`

`buildAuthOptions(deps)` (`:84`) is a pure options builder; `createAuth`
(`:283-285`) wraps `betterAuth(...)`; `getAuth()` (`:299-335`) is the
process-wide singleton, cached under `Symbol.for("viberr.betterAuth")`
(`AUTH_CACHE_KEY`, `:291`) and keyed to the current `getDb()` handle so test
`closeDb()` resets rebuild it.

- **Mount**: `basePath = "/api/auth"` (`AUTH_BASE_PATH`, `:34`), served by the
  splat route `app/routes/api.auth.$.ts` — loader and action both forward the
  raw `Request` to `getAuth().handler(request)` (`:11-17`). No app CSRF token
  on this route; better-auth enforces its own Origin/trustedOrigins check.
- **ALLOW-LIST (P11-02, commit 63cfe53)**: `ALLOWED_AUTH_PATHS` (`:52-59`) —
  `/sign-in/email`, `/sign-in/social`, `/callback/:id`, `/error`,
  `/get-session`, `/sign-out`. Enforced at the TOP of the `hooks.before`
  middleware (`:190-192`): any other better-auth endpoint reached through the
  splat throws `APIError("NOT_FOUND")`. Design facts (comment `:36-51`):
  entries are the endpoints' **DECLARED** paths — hooks receive
  `ctx.path` = `endpoint.path` verbatim, params un-substituted, hence the
  literal `"/callback/:id"`; and the hook pipeline **also runs for server-side
  `auth.api.*` calls**, which is why `get-session` (require-user, every
  request) and `sign-out` (logout route) must be on the list. `/error` stays
  reachable because a failed OAuth callback redirects there. This is an
  allow-list, not a deny-list, precisely so new better-auth endpoints
  (change-password, update-user, link-social, list-accounts, token, …) are
  blocked by construction — the pass-11 "unaudited parallel account mutations"
  gap is closed.
- **Database**: the app's own `node:sqlite` `DatabaseSync` handle passed
  directly (`database: deps.db`, `:111`).
- **Secret**: `BETTER_AUTH_SECRET ?? VIBERR_SESSION_SECRET` (`:311`). Cookie
  prefix `viberr` → cookie `viberr.session_token` (`advanced.cookiePrefix`,
  `:279`).
- **baseURL / trustedOrigins**: `BETTER_AUTH_URL` when set; otherwise
  undefined → better-auth infers origin per request (correct for dev's varying
  port). `trustedOrigins = [baseURL]` or `[]` (`:315`). NEW (P11-03): boot now
  WARNS when `BETTER_AUTH_URL` is unset while an OAuth provider is configured
  (`app/server/boot.server.ts:85-92`).
- **emailAndPassword** (`:116-135`): enabled, `disableSignUp: true`,
  `minPasswordLength` from `app/shared/auth/password-policy.ts`
  (MIN_PASSWORD_LENGTH = 8). NEW (P11-01) — **total hashing hooks**
  (`password: { hash, verify }`, `:131-134`): both route through
  `app/server/auth/password.server.ts`. `verifyPassword` (`password.server.ts:10-20`)
  catches ANY parse failure and returns false, so a stored credential in a
  legacy/foreign format (the pre-better-auth `scrypt$N$r$p$salt$key` shape)
  reads as wrong password (401) instead of Better Auth's built-in verifier
  throwing "Invalid password hash" → unhandled 500 on the splat (the pass-11
  legacy-scrypt→500 bug).
- **Session** (`:219-222`): `expiresIn` 30 days rolling, `updateAge` 1 day.
- **Social providers** (`:85-107`): GitHub (scopes `read:user`, `user:email`;
  `mapProfileToUser` carries the GitHub `login` into additional user field
  `githubHandle`) and Google (`accessType: "offline"`, `prompt:
  "select_account consent"`). Providers exist only when both client id and
  secret env vars are set (`getAuth`, `:316-329`); the login page renders
  unconfigured buttons disabled (`app/routes/login.tsx:366,395`).
- **user.additionalFields.githubHandle** (`:223-229`): input:false; mirrored
  to `users.github_handle` by the whitelist hook.
- **accountLinking** (`:231-239`): enabled, `trustedProviders: ["github",
  "google", "credential"]` — a social sign-in for an already-provisioned
  identity links by verified email and reuses the row (id invariant preserved).

### 2.2 Rate limiting / throttling

Two layers (long comments at `app/lib/auth.server.ts:136-165` and
`app/server/auth/rate-limit.server.ts:1-19`):

- Better Auth's own limiter is **enabled** (`rateLimit.enabled: true`, `:137`)
  but `customRules` set `/sign-in/email` and `/sign-in/social` to **false**
  (`:156,163`) — Better Auth keys on client IP and the shipped deployment
  (react-router-serve, no reverse proxy) has no `X-Forwarded-For`, so every
  request shares ONE bucket (`"no-trusted-ip|/sign-in/email"`); under any max
  that is an org-wide denial-of-login lever.
- The authoritative throttle lives in the same better-auth **`hooks.before`
  middleware** (`:179-217`, after the allow-list check) so a POST straight to
  `/api/auth/sign-in/email` through the splat is throttled:
  - `/sign-in/email` (`:193-202`): token bucket keyed `email|ip`, **10 / 15
    min** continuous refill (`LOGIN_RATE_LIMIT`, `rate-limit.server.ts:87-90`).
  - `/sign-in/social` (`:208-216`): keyed `provider|ip`, **30 / minute**
    (`SOCIAL_START_RATE_LIMIT`, `:93-96`) — the path carries no identity;
    sized unreachable by humans while displacing Better Auth's 3-per-10s
    default.
- `TokenBucketLimiter` (`rate-limit.server.ts:37-85`): in-memory, per-process,
  max 10 000 tracked keys with refilled-bucket pruning; `reset(key)` forgives
  on success. `clientIpOf` (`:134-141`): first `X-Forwarded-For` hop or the
  literal `"local"`.
- Pre-check failures that never reach the better-auth handler
  (unknown_email / disabled / no_password) consume their own token in
  `loginWithCredentials` (`app/server/auth/login.server.ts:95-104`) so email
  enumeration is bounded by the same bucket.

### 2.3 Credentials sign-in flow

`POST /login` intent `login` (`app/routes/login.tsx:56-118`):

1. `assertTrustedOrigin(request)` only — no session yet
   (`app/server/auth/csrf.server.ts:10-13` comment).
2. Already-authenticated double-submit short-circuits to a redirect
   (`login.tsx:68-73`).
3. `loginWithCredentials(db, getAuth(), {email,password}, {requestHeaders,
   requestUrl})` (`app/server/auth/login.server.ts:63-145`):
   - normalize email, pre-check the app `users` row for the taxonomy Better
     Auth can't give: `unknown_email`, `disabled`, `no_password` — each spends
     a rate-limit token (`:98-104`);
   - drive Better Auth through `auth.handler(new Request(...))` against
     `/api/auth/sign-in/email` (`:106-123`; password verification + session
     mint inside better-auth; the before-hook spends the token); 429 →
     `rate_limited`, other non-ok → `wrong_password`;
   - success: `limiter.reset`, `recordUserLogin` (stamps `last_login_at`),
     audit `auth.login.success`, return the better-auth Set-Cookie values +
     `mustResetPassword` (= `users.pwreset_required`) (`:129-144`).
4. The route action forwards the Set-Cookie headers, appends `viberr_theme`,
   and redirects — to `/login` (reset step) when a forced reset is pending,
   else to sanitized `returnTo` or `/`.
5. Error copy deliberately merges `unknown_email` + `no_password`
   (`login.tsx:95-99`) so OAuth-only account existence isn't revealed.

Failure audits record email + reason, never the password
(`login.server.ts:85-93`); rate-limited attempts audit
`auth.login.rate_limited` (`:76-83`).

**Forced password reset gate**: while `users.pwreset_required = 1`,
`requireAuth` redirects everything to `/login` (set-new-password screen);
only callers passing `allowPendingPasswordReset` get through. Completion
(`login.tsx` intent `set-password` `:120-…` → `completeForcedPasswordReset`,
`login.server.ts:154-177`) hashes the new password, writes the better-auth
credential via `setCredentialPassword`, clears the flag, audits
`auth.password.forced_reset_completed`. Current session stays valid; other
sessions are left to expire (first-login gate, not compromise recovery).

**Social sign-in flow** (`login.tsx:304`; also `profile-page.tsx:479`): client
`fetch("/api/auth/sign-in/social", {provider, callbackURL})` → better-auth
returns provider redirect URL → `window.location.href`. The OAuth dance
including `/api/auth/callback/*` is better-auth's own code through the splat.

**Logout** (`app/routes/logout.tsx`): POST only, CSRF-checked, audits
`auth.logout`, calls `getAuth().api.signOut({headers, asResponse:true})` and
forwards its cookie-clearing Set-Cookie; loader redirects `/`.

### 2.4 Session reading + guards — `app/server/auth/require-user.server.ts`

- `authenticateWithHeaders(request)` (`:77-101`): `getAuth().api.getSession({
  headers, returnHeaders: true })` — captures the rolling-session renewal
  Set-Cookie (F10-17), which the **root loader** forwards to the browser
  (`app/root.tsx:46-65`). Loads the canonical `users` row by the id invariant;
  a **disabled or vanished user has their better-auth session row deleted**
  (raw `DELETE FROM session WHERE id = ?`, `:89`) and reads as signed out.
  (Server-side `getSession` passes the P11-02 allow-list — `/get-session` is a
  driven path.)
- `authenticate(request)` (`:114-118`): same, dropping renewal headers.
- `AuthContext` = `{ user: SessionUser, pwresetRequired, sessionId (safe to
  log; keys the CSRF token), sessionToken (never log) }` (`:37-45`).
- `requireAuth` (`:154-164`) → context or throw redirect to
  `/login?returnTo=…` (returnTo normalized from RR8 single-fetch `.data` wire
  URLs, `loginRedirect` `:128-146`; sanitized by `safeReturnTo` `:121-126` —
  same-app absolute paths only, rejects `//` and `/\`).
- `requireUser` (`:167-172`) → `SessionUser` or redirect.
- `requireRole(request, "admin")` (`:201-208`) → 403 JSON via `roleSatisfies`
  (`:180-182`, ROLE_ORDER member=1 < admin=2, `:174-177`).
- `requireRoleAuth` (`:215-222`) → role check + full context in one session
  lookup (mutation actions need `sessionId` for CSRF; WI-12 dedup).

### 2.5 CSRF — `app/server/auth/csrf.server.ts`

Two mechanisms for every mutating action of an authenticated user:
Origin/`Sec-Fetch-Site` check (`assertTrustedOrigin`, `:46-69`) plus a
double-submit token `HMAC-SHA256(VIBERR_SESSION_SECRET, "viberr-csrf:" +
sessionId)` base64url (`csrfTokenForSession`, `:18-22`), delivered via the
root loader → `<CsrfInput />` hidden field `_csrf` (`CSRF_FIELD_NAME`, `:15`)
or the `X-Csrf-Token` header; compared with `timingSafeEqual`
(`assertCsrfWithSecret`, `:72-97`). `requireFormAction`
(`app/server/auth/form-action.server.ts:7-19`) bundles requireAuth + formData
+ assertCsrf + actor + intent for route actions.

### 2.6 Identity plumbing — `app/server/auth/identity.server.ts`

Synchronous row writes against better-auth's tables (never the async API):

- `provisionIdentity` (`:67-87`): upsert better-auth `"user"` row
  (`emailVerified=1`) + a `credential`-provider `account` row carrying the
  scrypt hash when a password exists (`upsertCredential`, `:37-61`).
  Idempotent; called at every user-creation site (boot/seed admin, org invite,
  OAuth hook, demo fixture).
- `setCredentialPassword` (`:90-96`), `credentialPasswordHash` (`:98-109`),
  `syncIdentityEmail` (`:125-135` — admin email edits must reach better-auth's
  `user.email` or credential sign-in locks out; pass-4 WI-2),
  `revokeUserSessions` (`:138-145`, returns the deleted-row count),
  `deleteIdentity` (`:148-150` — cascades session/account via FK).
- NEW (P11-01) `isBetterAuthPasswordHash` (`:120-122`): regex
  `/^[0-9a-f]+:[0-9a-f]+$/i` for Better Auth's own `<saltHex>:<keyHex>` scrypt
  format — the seed's recovery predicate for re-hashing a legacy credential
  (§7.1); verification totality itself is the `password.verify` hook (§2.1).
- Password hashing: better-auth's own scrypt via `better-auth/crypto`
  re-exported in `app/server/auth/password.server.ts` (`hashPassword`,
  total `verifyPassword` `:10-20`, `generateTempPassword` = 9 random bytes
  base64url `:22-24`).

### 2.7 Whitelist-based access (no open registration)

Three provisioning paths (creating the `users` row IS the whitelist entry —
`app/server/auth/user-admin.server.ts:23-33`):

1. **Boot bootstrap admin** (`app/server/auth/seed-admin.server.ts`, called
   from `app/server/boot.server.ts:102-105`): when `users` is EMPTY,
   `seedInitialAdmin(db, { email: env.VIBERR_SEED_ADMIN_EMAIL, password:
   env.VIBERR_SEED_ADMIN_PASSWORD })` creates the initial admin. CHANGED
   (clean-sheet seed, e306248): the fallback email is now
   `admin@viberr.dev` (`DEFAULT_SEED_ADMIN_EMAIL`, `seed-admin.server.ts:19`),
   not `arda@viberr.dev`; without an env password a random one is generated,
   logged ONCE clearly marked (`:75-81`) with `pwreset_required=1` (`:44-54`).
   Audits `org.user.created` with `bootstrap: true` (`:67-73`).
2. **Admin-created accounts** (org settings; §4.4): local (temp password,
   forced reset at first login), Google-account whitelisting (passwordless
   row + `idp='google'`), GitHub-handle placeholder rows, Google-domain
   allowlist rows.
3. **OAuth self-provisioning within the whitelist** —
   `app/server/auth/oauth-provision.server.ts`, wired into better-auth
   `databaseHooks` (`app/lib/auth.server.ts:243-278`):
   - `user.create.before` → `isOAuthWhitelisted` (`:50-64`): a NEW social user
     is allowed only if (a) their email domain is in
     `google_domain_allowlist`, (b) a live GitHub-handle placeholder row
     exists (email `github.com/<handle>`), or (c) a live legacy row with that
     email anomalously wasn't account-linked. `false` aborts user creation.
   - `user.create.after` → `applyOAuthUser` (`:71-120`): materializes the
     `users` row (id === better-auth id) with the role from the domain
     allowlist or the claimed placeholder (placeholder row + identity deleted,
     role carried over; audit `auth.oauth.placeholder_claimed`), stamps
     `github_handle`, normalizes the identity, audits
     `auth.oauth.user_provisioned`.
   - `account.create.after` → `linkOAuth` (`:123-142`): stamps the last
     provider on `users.idp`, audits `auth.oauth.login`.
   - In-file note (`:32-36`): the provider handshake is NOT live-verified on
     this instance (no OAuth creds configured); the pure logic is unit-tested
     (`oauth-provision.server.test.ts`).

### 2.8 `users` table schema + mapping

DDL: `db/migrations/0001_baseline.sql:23-36` — `id PK, email, name, title,
role CHECK IN ('admin','member') (:28), idp DEFAULT 'local', avatar_tone,
pwreset_required 0/1, theme CHECK IN ('light','dark','system') DEFAULT
'system', disabled 0/1, created_at, updated_at, last_login_at, created_by,
github_handle` + unique email index (`:301`). No password column —
`has_password` is derived at read time via `EXISTS(SELECT 1 FROM account WHERE
providerId='credential' AND password IS NOT NULL)`
(`app/server/auth/user-store.server.ts:19-26`).

Row→record mapping: `app/shared/mapping/user.server.ts` (`UserRow` →
`UserRecord`). **`coerceUserRole`** (`:15-17`): anything not exactly `"admin"`
reads as `"member"` — absorbs stray legacy `viewer` org-role rows (that rung
was retired, `:6-8`). Applied in `mapUserRow` (`:66`); also inlined in the
domain mappers (`org-users.server.ts:353,471`).

Store API: `app/server/auth/user-store.server.ts` — `normalizeEmail`
(`:15-17`; lookups case-insensitive), `findUserByEmail/ById` (`:28-46`),
`listUsers` (`:48-53`), `countUsers` (`:55-60`), `countActiveAdmins`
(`:63-68`, feeds the last-admin lockout), `insertUser` (`:82-108`),
`updateUserFields` (column-whitelisted patch, `:135-157`), `recordUserLogin`
(`:160-165`).

Admin mutations with validation + audit: `app/server/auth/user-admin.server.ts`
— `createUser` (`:57-110`: zod schema, conflict check, avatar-tone
round-robin, `pwresetRequired` iff temp password, provisions identity),
`updateUser` (`:119-189`; **last-admin lockout guard** `:135-143`: the last
active admin can never be demoted or disabled; disabling revokes sessions +
audits), `resetPassword` (`:195-226`: temp password, `pwreset_required=1`,
credential replaced, ALL sessions revoked), `disableUser`/`enableUser`
(`:228-242`).

**Own password change** (parity path the splat can no longer bypass):
`changeOwnPassword` (`app/features/profile/profile-actions.server.ts:121-160`)
verifies the current hash, writes the better-auth credential, deletes every
OTHER session (`DELETE FROM session WHERE userId = ? AND id != ?`, `:149-152`),
audits `auth.password.changed`. Reached via `/profile` action intents
(`app/routes/profile.tsx:61-112`).

### 2.9 Env contract — `app/server/config/env.server.ts`

Required: `VIBERR_SESSION_SECRET` (≥32 chars, `:21-26`),
`VIBERR_SECRET_ENCRYPTION_KEY` (base64 of exactly 32 bytes → `Buffer`,
`:50-73`). Optional: `BETTER_AUTH_SECRET` (`:33-36`), `BETTER_AUTH_URL`
(`:44`; REQUIRED behind a reverse proxy — documented `:38-43`, and since
P11-03 boot warns when unset with OAuth configured, `boot.server.ts:85-92`),
`GITHUB_OAUTH_CLIENT_ID/SECRET`, `GOOGLE_OAUTH_CLIENT_ID/SECRET` (`:79-82`),
`VIBERR_SEED_ADMIN_EMAIL/PASSWORD` (`:85-89`), plus runtime-backend keys.
Parsed once, cached under `Symbol.for("viberr.env")` (`:161-175`); empty
strings treated as unset (`parseEnv`, `:148-158`).

---

## 3. RBAC

### 3.1 Org roles (2)

`UserRole = "admin" | "member"` (`app/shared/mapping/user.server.ts:9-10`).
`admin` runs the instance: org settings surface (`requireRole(request,
"admin")`, `app/routes/org.settings.tsx:69` loader; `requireRoleAuth("admin")`
`:102` action) and the D2 emergency override on any project (§3.4). Hierarchy:
`roleSatisfies` (`require-user.server.ts:180-182`).

### 3.2 Project roles (4) + the single source

`PROJECT_ROLES = ["admin", "maintainer", "contributor", "viewer"]`
(`app/schemas/project-file.schema.ts:23-24`), stored per-project in
`project.md` frontmatter `members[] = {userId, role}` (`:65` role enum;
projected to `project_members`, `0001_baseline.sql:69` CHECK). Strict
monotonic tier: viewer ⊂ contributor ⊂ maintainer ⊂ admin (`ROLE_RANK`,
`app/shared/rbac.ts:27-32`; `ROLE_LABEL` `:34-39`).

**`app/shared/rbac.ts` is THE single source** for project-role authorization:
`RBAC_DEFINITIONS` (`:47-70`) → `ACTION_ROLES` (`:74-76`), `roleCan`
(`:79-82`), `rolesForAction` (`:85-87`). Server guards and the Policy page
render the SAME object (`policy-rbac.server.test.ts` binds them per role).

### 3.3 The complete RbacAction list (minimum tier in bold)

| id | label | roles | minimum tier |
|---|---|---|---|
| `view` | View board, tasks & timelines | A M C V | **app-wide** (any authenticated user; FR4) |
| `comment` | Comment on tasks | A M C V | **app-wide** (any authenticated user; FR4) |
| `create-task` | Create tasks | A M C | **contributor** |
| `own-task` | Take / release own task ownership | A M C | **contributor** |
| `approve-transition` | Approve stage transitions | A M | **maintainer** |
| `resolve-packet` | Resolve decision packets | A M | **maintainer** (+ owner exception, §3.5) |
| `accept-completion` | Accept completion → Done | A M | **maintainer** (+ owner exception) |
| `update-goal` | Edit the task goal | A M | **maintainer** |
| `run-agents` | Run agents | A M | **maintainer** |
| `reorder-board` | Reorder the board | A M | **maintainer** |
| `reconcile-github` | Reconcile GitHub state | A M | **maintainer** |
| `grant-github-scope` | Grant GitHub scope | A M | **maintainer** |
| `rescan-project` | Re-scan project files & projections | A M | **maintainer** |
| `release-any-ownership` | Release any task owner | A | **admin** |
| `manage-members` | Manage members & roles | A | **admin** |
| `manage-agents` | Manage agent profiles | A | **admin** |
| `edit-policy` | Edit workflow & policy | A | **admin** |

`view`/`comment` appear in the map only so the Policy table can render them
(`appWide: true`); their server enforcement is "authenticated", not "member" —
those guards do NOT call `requireAction` (`rbac.ts:18-23`).

### 3.4 Authority resolution — `app/server/auth/project-authority.server.ts`

THE single resolution path (pass-7 R7-1). Every guard funnels into
`resolveProjectAuthority(db, project, actor, allowed, audit)` (`:107-146`):

1. **Membership role**: actor's live role from `project.md` `members[]`
   checked against `ACTION_ROLES` (or `"any-member"`). Live reads — role
   changes bite on the next action, nothing session-cached.
2. **Org-admin emergency override (owner ruling D2)**: an org admin whose
   membership would be denied is granted project-admin-equivalent authority
   (`role: "admin"`, `isOrgAdminOverride: true`); every grant on a real
   RbacAction writes a `project.org_admin.override` audit row (`:121-143`).
   Deliberately NOT audited for `"any-member"` route-READ gates (audit-noise,
   F7-pass7; comment `:122-127`).
3. Everyone else: denied with `memberRole` (null = non-member) so callers
   format the canonical 403 copy (`requireProjectAuthority`, `:153-170`).

Other pieces in the same module:

- `requireProjectMutable` (`:72-83`): **archived projects are read-only**
  (R6-3) — 409 on every governed mutation until restored; restore passes
  `allowArchived`.
- `isOrgAdmin` (`:88-94`): reads `users.role` directly (`disabled=0`
  required). The pass-11 stale comment claiming a better-auth membership
  plugin was FIXED — the docstring (`:85-87`) now states `users.role` is the
  sole authority.
- `requireRunAgents` / `canRunAgents` (`:181-211`): the centralized
  `run-agents` check for runtime call sites (@mention trigger, dispatch,
  interrupt, run-operator); includes the archived gate (F17).
- `assertProjectAction` (`:221-274`): slug-only callers (config surfaces,
  route gates) — reads `project.md` fresh, archived gate (unless
  `allowArchived`), then resolution; 403 copy "Only project {label} can …".
- `requireProjectMember` (`app/server/auth/require-project.server.ts:20-45`):
  loader/action READ gate for project config surfaces (policy, agents,
  settings, github) = `assertProjectAction("any-member", …, {allowArchived:
  true})`, converting AppError to a thrown Response. Board/task/timelines are
  NOT behind it (FR4).

### 3.5 `requireAction` guard + call sites — `app/server/tasks/task-actions.server.ts`

- `requireAnyMember` (`:267-277`): loosest member gate (idempotent/no-op
  paths), routes through the single resolution (org-admin passes as override).
- `requireAction` (`:280-296`): archived gate (`requireProjectMutable`) then
  `requireProjectAuthority(rolesForAction(action))`; returns effective role.
- `ownerException` (`:298-309`): actor is the task's `ownerUserId` AND their
  CURRENT membership role holds `own-task` (contributor+; a removed/demoted
  stale owner fails).
- `requireAcceptCompletion` (`:312-321`): owner exception (R6-2) OR
  `accept-completion` (maintainer+).

Call sites (line numbers refreshed for pass 12):

- `:398` `create-task`
- `:490` `update-goal`
- `:2184` `own-task` (take/assign; hand-off additionally requires being the
  current owner or `release-any-ownership`, and the target must hold
  `own-task` — comments `:2196-2200`)
- `:2289` `requireAnyMember` (release with no owner — idempotent probe guard)
  / `:2296` `own-task` (release own) / `:2299` `release-any-ownership`
- `:2434` `approve-transition` ("change the task stage" — manual override)
- `:2438` `requireAnyMember` (auto boundary crossed by a human — unreachable
  from the UI) / `:2440` `approve-transition` (approval boundary)
- `:2444` `requireAcceptCompletion` (human boundary review→done)
- `:2855` `reorder-board`
- `:2989` `resolve-packet` (resolve decision packets)
- `:3462` `resolve-packet` ("apply recommendations")
- `:3567` `resolve-packet` ("dismiss recommendations")
- `:3282`, `:3398` `requireAcceptCompletion` (acceptCompletion entry, and the
  merge-pending completion path)

Config-surface actions go through `assertProjectAction` instead:
`manage-members` / `edit-policy` in
`app/features/policy/policy-actions.server.ts` (`requirePolicyAction` wrapper
`:40-51`, call sites `:87`, `:169`), and project settings/agents/github name
their specific ids the same way.

**Operator bypass**: when `ctx.operatorAuthorized === true`, task mutations
skip human RBAC — operator authority is gated upstream by its capability
policy. The final stage is protected: the operator reaches Done ONLY through
accept-completion, never a bare transition (`:2421-2431`). A human manually
moving a task into the final stage is routed through the full acceptance
contract (`:2405-2419`). NEW (63cfe53): the operator transition re-trigger
chain is structurally bounded — `transitionDepth` threads through
`ctx.operatorRun` (`:108`) and at `OPERATOR_TRANSITION_CHAIN_CAP` (8) the
transition still lands but coordination pauses on the stuck-loop packet
instead of another LLM run; any human action or agent reply resets to 0.

**Owner exceptions** (two, related):

- **Accept-completion** (R6-2): a live contributor+ owner accepts their own
  task into Done; otherwise maintainer+ (`requireAcceptCompletion`).
- **Resolve-packet** (owner ruling Q2; `:2968-2991`): a packet is addressed to
  the task OWNER, so the owner (contributor+) OR admin/maintainer may resolve
  it — EXCEPT `accept_completion`, re-gated by `requireAcceptCompletion`
  (`:3004-3010`); the owner path is disabled when `ctx.operatorAuthorized`
  (`:2978-2980`). Acceptance additionally requires every required reviewer to
  have approved the CURRENT work revision (F10-15,
  `acceptanceBlockedReason` check `:3011-3017`; same gate at `:3290`).

### 3.6 Policy page rendering

`app/features/policy/policy-data.ts:27-35` maps `RBAC_DEFINITIONS` →
`RBAC_ROWS` (`grant: Record<ProjectRole, 0|1>` + `appWide`) — consumed by
`PolicyPage` via `app/routes/project.policy.tsx` (loader behind
`requireProjectMember` `:28`; actions `set-role`/`set-boundary` admin-gated in
`policy-actions.server.ts` with a project-level last-admin guard and the
hard-locked human review→done boundary). The same map drives client-side UX
gating (`roleCan` in `app/features/task-detail/task-detail-page.tsx:209-225,
783-784,925,961,1104-1105`, `review-queue.server.ts`, `decisions.server.ts`) —
sugar only; server guards are authoritative.

---

## 4. ORG STORE (org settings surface)

Route: `/org/settings` (`app/routes/org.settings.tsx`) — loader
`requireRole("admin")` (`:69-70`), action `requireRoleAuth("admin")` + CSRF
(`:102-106`). Every mutation is a POST intent (29 `case`s, `:108-…`); loader
payload is `getOrgSettingsView` (`app/server/org/org-view.server.ts:39`):
connections, users, domains, kbs, mcps, skills, gagents, stages.
Self-targeting guards in the route action: can't demote yourself
(`:154,:163`), remove your own account (`:183`), or disable your own account
(`:190`).

### 4.1 Knowledge bases — `app/server/org/resources.server.ts` (~`:130-405`)

Content is **file-native**: real folders under `${VIBERR_DATA_ROOT}/kb/<dir>/`,
scanned from disk on every read. SQLite (`org_knowledge_bases`: id, name, dir
UNIQUE, refresh, last_indexed_at) carries only metadata. **Disk is truth**:
listings union disk folders with rows (`unionDiskAndRows`, `:117-128`); a
folder with no row renders under a synthetic `disk:<name>` id
(traversal-hardened `diskNameFromId`, `:75-93`) and is adopted on
edit/reindex. Rename = slug recompute + real folder move, collisions refused.
`saveKnowledgeBase` `:220`, `deleteKnowledgeBase` `:312`,
`reindexKnowledgeBase` `:336` (honest re-scan: count + timestamp). URI
contract: `store://kb/<dir>` (`:154,:184`).

CHANGED (P11-60/R-D): refresh cadence vocabulary is now
`KB_REFRESH_MODES = ["on change", "manual"]` (`:142`) — **"nightly" was
REMOVED** (comment `:139-141`: it was decorative, nothing scheduled it). "on
change" is now REAL: `startKbWatcher` (`app/server/files/kb-watch.service.server.ts`,
started at boot `boot.server.ts:146`) watches `${dataRoot}/kb` with a 250 ms
per-KB debounce and calls `reindexKnowledgeBaseByDir`
(`resources.server.ts:380`), which skips KBs pinned to `manual`. HMR-safe
global-symbol handle.

### 4.2 Skills — `resources.server.ts` (~`:860-1130`)

Real `SKILL.md` folders under `${DATA_ROOT}/skills/<name>/`; same
disk-is-truth union + `disk:` adoption. `org_skills` rows carry name UNIQUE +
summary. Body reads capped at 256 KB (`SKILL_BODY_MAX_BYTES`, `:874`); the E4
write policy (`saveSkill` `:985`, guard `:1031-1044`) refuses saving a
truncated round-trip back over a larger on-disk file and keeps the existing
body when an empty body arrives without the explicit `clearBody` flag
(`:994-995,:1034`). `listSkills` `:954`, `deleteSkill` `:1106`.

### 4.3 MCP servers — `resources.server.ts` (~`:410-860`)

`org_mcp_servers` rows: name (slug UNIQUE), transport `HTTP|stdio`, target,
`cred_ref`, tools_count, up, last_checked_at. **Credential encryption
(F7-MCP1)**: `cred_ref` stores an AES-256-GCM secret box — sealed at save
(`saveMcpServer` `:681`, seal-or-keep logic `:696-711`: a non-box input is
sealed, a blank field keeps the existing sealed value), never returned to any
client (views expose only `hasCred: boolean`, `:410-411,:435`). Decryption
ONLY in `getMcpCredential` (`:450-479`), consumed exclusively by the
run-spawn injection path (specialist-mcp). CHANGED (P11-61): a PRESENT but
unusable cred (legacy/non-box format, or a sealed box that no longer opens
after key rotation) still degrades the run to no-auth, but now **logs a
warning naming the MCP** (`:459-469`) instead of failing silently. Health is
honest: HTTP targets get a real reachability probe (`probeMcpTarget`,
`:646`); stdio targets a real JSON-RPC `initialize` → `tools/list` handshake
with a hard timeout (`discoverStdioMcpTools`, `:543`); counts never
fabricated. The in-process `viberr` operator MCP is reserved and never offered
to specialists (`resource-catalog.server.ts:32,52-54`).

### 4.4 Users, whitelists, domain allowlist — `app/server/org/org-users.server.ts`

Thin composition over the phase-2 user-admin API (route-level
`requireRole("admin")` is the access control; functions trust their caller and
audit via `actor`). The pass-11 stale "later-phase wiring" docstrings were
FIXED — the header (`:43-51`) and `findDomainAllowlistRole` doc (`:455-460`)
now describe the LIVE databaseHooks wiring.

- `createLocalAccount` (`:177-200`): temp password generated, surfaced ONCE to
  the admin (no mailer in V1), forced reset at first sign-in.
- `whitelistGoogleAccount` (`:150-175`): passwordless row + `idp='google'` —
  the row's email is what the OAuth flow account-links.
- `whitelistGithubUser` (`:114-148`): placeholder identity row (name
  `@handle`, email `github.com/<handle>` — deliberately not an email,
  `githubPlaceholderEmail` `:110-112`) until first GitHub sign-in claims it
  (`applyOAuthUser`, §2.7).
- `updateOrgUser` (`:216-263`): local accounts may change name/email (email
  change syncs the better-auth identity, WI-2, `:242`); idp accounts change
  role only. `setOrgUserRole` (`:265-272`).
- `resetLocalPassword` (`:276-295`): local-only; temp password once, sessions
  killed, forced-reset gate.
- `deleteOrgUser` (`:303-331`): hard delete (9B; audit rows keep denormalized
  actor snapshots); refuses removing the last active admin (`:310-316`);
  revokes sessions and deletes the better-auth identity so the email can be
  re-created (WI-3). Self-targeting demote/disable/remove refused in the route
  action (§4 above).
- Status derivation (`statusOf`, `:77-84`): never-logged-in OAuth rows =
  `whitelisted`, never-logged-in local with pending reset = `invited`, else
  `active`.
- **Google domain allowlist** (`:333-472`): `google_domain_allowlist` rows
  (id, domain UNIQUE like `@viberr.dev`, role admin|member). `normalizeDomain`
  (`:369-379`) accepts `@domain`, `user@domain`, bare domain. `addDomain`
  `:386-426`, `removeDomain` `:428-453`. `findDomainAllowlistRole`
  (`:461-472`) is the hook the OAuth create hooks consult — a fresh Google
  sign-in from an allowlisted domain joins with the mapped role.

### 4.5 GitHub connections — `app/server/org/connections.server.ts`

A connection = owner + PAT, `github_connections` row (id = slugified owner,
pat_id → `github_pats`, is_default, repos_count, expires_at) joined to the PAT
store for masked display + cached validation. **"Nothing is saved unless
validation passes"**: `createConnection` (`:246`) and `replaceConnectionToken`
(`:301`) first run `validatePatToken` against `CONNECTION_REQUIRED_SCOPES` =
repo · workflow · pull_request:write (`:41`) plus a real owner-existence/
repo-count probe; typed failures (`duplicate|validation_failed|not_found`)
leave the DB untouched and on replace the old token stays active. Exactly one
default, transactionally (`setDefaultConnection`, `:350`); the default cannot
be removed (`removeConnection`, `:382`). `getDefaultConnectionToken` (`:148`)
returns the decrypted token ONLY when the last validation passed —
server-internal, used by the StoreBrowser GitHub import.

Validation honesty (`app/server/secrets/pat-validator.server.ts`): classic
`ghp_`/`gho_` tokens verify scopes via the authoritative `x-oauth-scopes`
header (`:33-35,:67-68`); fine-grained `github_pat_` tokens have no
introspection so write scopes come back `source:"assumed"` (`:37-41,
:282,:289`); expired-vs-revoked on 401 is a documented heuristic.

### 4.6 Store browser file ops — `app/server/org/store-files.server.ts`

Real filesystem mutations under the resolved store folder followed by a
re-scan. Server-enforced safety: path segments sanitized (`sanitizeDirPath`,
`:99` — no `..`, no absolute paths, backslashes → `-`), dot-prefixed segments
skipped, files never clobber directories, every resolved path verified under
the root. Ops: `writeStoreFiles` (`:213`), `createStoreFolder` (`:289`),
`deleteStoreNode` (`:339`), `importGithubSnapshot`. Targets resolved via
`resolveStoreTarget` (`resources.server.ts:1135`).

### 4.7 Global agent profiles — `app/server/org/gagents.server.ts`

Org-level agent TEMPLATES as files under `${DATA_ROOT}/agents/profiles/<id>.md`
(the system `operator` template is never listed/editable here). `used` is a
projection over `projects.agent_policy_json` deployment counts
(`usedByProject`, `:70`), gating deletion ("Detach from N projects first",
`:192`). Edits preserve fields the modal doesn't own via read → merge →
serialize (`saveGlobalAgentProfile`, `:146`).

---

## 5. SECRETS

### 5.1 Encryption at rest — `app/server/secrets/secret-box.server.ts`

AES-256-GCM secret box. Key: `VIBERR_SECRET_ENCRYPTION_KEY` env — base64 →
exactly 32-byte `Buffer`, validated at boot (`env.server.ts:50-73`). No KDF:
the env value IS the key. Box format: `v1$<iv b64>$<ct b64>$<tag b64>` —
12-byte random IV, 16-byte GCM tag; tamper fails with typed
`secret_box_invalid` (never garbage plaintext). Encrypted things: GitHub PATs
(`github_pats.encrypted_token`) and MCP credentials
(`org_mcp_servers.cred_ref`).

### 5.2 Redaction / exposure rules

- PAT metadata readers NEVER return the token — only `getPatToken`
  (`pat-store.server.ts:190`) decrypts. Display = `token_suffix` (last 4).
- Audit rows record label + suffix only; login failure audits record email +
  reason, never the password (`login.server.ts:85-93`); `sessionToken` is
  documented never-log (`require-user.server.ts:43-44`).
- The one deliberate plaintext credential log: the bootstrap admin's GENERATED
  password (no-env fallback only), logged once and clearly marked
  (`seed-admin.server.ts:75-81`). With env credentials configured, nothing is
  logged but the email (`:82-84`). The seed CLI prints the sign-in line to
  stdout (`scripts/seed.ts:47-49`).
- MCP credential: only `hasCred` crosses to the client
  (`resources.server.ts:410-411`).
- The structured logger has NO redaction layer — callers are responsible;
  runtime adapters classify provider failures into redaction-safe canonical
  messages before raw text is dropped.

---

## 6. DB

### 6.1 node:sqlite setup — `app/server/db/sqlite.server.ts`

`openDatabase`: `new DatabaseSync(path)` with WAL, foreign_keys ON,
busy_timeout 5000. Path: `${VIBERR_DATA_ROOT}/state/projection.sqlite`.
`getDb()` is an HMR-surviving singleton (`Symbol.for("viberr.db")`) that runs
pending migrations on first open; `closeDb()` for tests/shutdown.

### 6.2 Migrations — CHANGED: exactly ONE file

`db/migrations/0001_baseline.sql` is now the ONLY migration —
`0002_delivering_single_flight.sql` was folded into the baseline and deleted
(63cfe53, per the pass-11 owner RULING: pre-prod, schema changes are squashed
INTO the baseline, no incremental chain). The header (`:1-20`) documents the
convention and its cost: the runner records by FILENAME alone, so a baseline
edit reaches FRESH databases only; there is no drift healer — after pulling a
baseline change, wipe the sqlite and re-seed, and because users/auth live in
the same file a wipe REGENERATES USER IDS. The F10-05 single-flight partial
unique index now lives in the baseline (`idx_agent_runs__one_delivering`,
`:337`).

### 6.3 Table overview (baseline)

App-owned (snake_case): `users` (§2.8), `google_domain_allowlist`,
`audit_events` (denormalized actor snapshots survive user removal),
projections (`projects`, `project_members` — role CHECK the 4 project roles
`:69` —, `task_projections`, `task_events`, `diagnostics`, `provenance`),
app state (`notifications`, `user_prefs`, `scope_violations`),
secrets/GitHub (`github_pats`, `project_github_credentials`,
`github_connections`), org metadata (`org_knowledge_bases`,
`org_mcp_servers`, `org_skills`), runtime (`agent_runs`, `run_log_lines`,
and `staged_outcomes` `:352` — new since the pass-11 doc's list).

better-auth-owned (camelCase, quoted; `0001_baseline.sql:294-297`): `"user"`
(incl. custom `githubHandle`), `"session"` (token UNIQUE, userId FK cascade),
`"account"` (providerId `credential|github|google`, `password` column carries
the scrypt hash), `"verification"` (better-auth internal, e.g. OAuth state; no
app code touches it).

Retention (`app/server/db/retention.server.ts`, best-effort at boot
`boot.server.ts:163-169`): run_log_lines 30 days, audit_events 90 days,
notifications newest 500/user (`:21-25`). Canonical markdown files never
touched.

---

## 7. SEED — REWRITTEN since pass 11 (clean-sheet, e306248 + 625eb71)

### 7.1 Product seed = clean sheet

**Owner ruling 2026-07-24: the product seed ships NO demo/mock board data.**

- **Boot** (`app/server/boot.server.ts:102-105`): `seedInitialAdmin(db,
  {email: env.VIBERR_SEED_ADMIN_EMAIL, password:
  env.VIBERR_SEED_ADMIN_PASSWORD})` — runs on EVERY boot, creates the admin
  only while `users` is EMPTY (`seed-admin.server.ts:41`). Fallback:
  `admin@viberr.dev` + random one-time password logged once +
  `pwreset_required=1` (§2.7).
- **CLI** `npm run seed` → `scripts/seed.ts` → `runSeed`
  (`app/server/seed/seed.server.ts:116-194`): the SAME `seedInitialAdmin`
  bootstrap (CLI default password `SEED_DEFAULT_PASSWORD = "viberr-dev-2828"`,
  `:55`), the built-in agent catalog templates (operator/developer/reviewer,
  from `agent-catalog.server.ts` `SEED_AGENT_PROFILES`), and a projection
  rescan over whatever REAL project files exist. NOTHING else — no projects,
  tasks, notifications, or extra users; the board starts empty by design.
  Then `scripts/seed.ts:33` runs `seedOrgResources` (§7.3).
- **P11-01 recovery** (`seed.server.ts:133-159`): when the admin already
  exists, re-normalize the identity and — only if
  `!isBetterAuthPasswordHash(credentialPasswordHash(...))` — re-hash the
  credential to the configured password, restoring access for data roots
  seeded before the better-auth migration (a legitimately changed valid
  password is left untouched).
- **`--reset`** (`resetStore`, `:93-114`): wipes `projects/`,
  `agents/profiles`, the per-backend runtime TRANSCRIPT dirs
  (`runtimes/claude`, `runtimes/codex`) and all derived tables
  (`DERIVED_TABLES` `:72-83`, now incl. `staged_outcomes`) — but NEVER the
  credential HOMES under `runtimes/` (`codex-home/auth.json`, `claude-home`;
  P11-04 — deleting those logged the whole instance out). Users/auth tables
  survive.

### 7.2 Demo dataset → TEST-ONLY fixture

The former demo seed moved verbatim to `test-support/demo-seed.ts`
(`runDemoSeed`) + `test-support/demo-data.ts` (SEED_PEOPLE
arda/elif/murat/selin/deniz `@viberr.dev`, `demo-data.ts:74-81`; viberr-core +
deploy-pipeline + billing-service; tasks VIB-139..168; Arda's inbox; the
VIB-142 seeded scope violation; Arda's pins). Product code never imports
test-support. Seeded via `npm run seed:demo` (`scripts/seed-demo.ts`,
test/dev-only, used by `playwright.config.ts`) — the ~18 route-level suites
import the fixture directly. **Drift guards**
(`app/server/seed/demo-fixture.test.ts:95,137`): every fixture file must parse
with ZERO unknown frontmatter and round-trip the CURRENT serializers, and a
task written by the real `createTask` action into the fixture store must land
just as clean — so a schema rename breaks loudly instead of silently
de-representing the fixture.

### 7.3 Org-resource seed — `app/server/org/org-seed.server.ts` (additive)

`seedOrgResources` (`:287`): 3 KBs with real files under `${DATA_ROOT}/kb/`,
4 skills with real SKILL.md folders, and the `@viberr.dev` Google-domain
allowlist row (role member, id `dom_seed_viberr`, `:361-366`). Honest empty
slate: NO MCP servers and NO GitHub connection are seeded; admin-installed
connections survive `--reset`. Run by BOTH `scripts/seed.ts` and
`scripts/seed-demo.ts`.

---

## Delta since pass 11 (2026-07-23 → 2026-07-24, commits 63cfe53, e306248, 625eb71, merges b361ba5/0981cfa)

1. **`/api/auth/*` gate inverted to an allow-list** (P11-02 round 2):
   `ALLOWED_AUTH_PATHS` (6 driven paths) in `app/lib/auth.server.ts:52-59`,
   enforced first thing in `hooks.before` (`:190-192`) — everything else 404s.
   Keys are DECLARED endpoint paths (`/callback/:id` literal); the hook also
   runs for server-side `auth.api.*` calls (get-session, sign-out covered).
   Pass-11 gap #2 (change-password/update-user split-brain bypass) is CLOSED;
   gap #1 (throttle asymmetry) is largely defused — non-driven paths no longer
   function at all.
2. **Legacy-scrypt→500 splat bug fixed** (P11-01): custom total
   `password.{hash,verify}` hooks (`auth.server.ts:121-134` →
   `password.server.ts:10-20`), `isBetterAuthPasswordHash`
   (`identity.server.ts:120-122`), and the seed's re-hash recovery
   (`seed.server.ts:133-159`).
3. **Clean-sheet product seed** (e306248/625eb71): `demo-seed.server.ts` /
   `demo-data.server.ts` are GONE from `app/server/seed/` — replaced by
   `seed.server.ts` (`runSeed`, no board data) + `agent-catalog.server.ts`.
   Bootstrap admin email default changed `arda@viberr.dev` →
   `admin@viberr.dev`; `seedInitialAdmin` now takes `{email?, password?}` and
   boot passes `VIBERR_SEED_ADMIN_EMAIL/_PASSWORD`. Demo dataset lives on as
   the test fixture `test-support/demo-seed.ts` (+ drift guards,
   `demo-fixture.test.ts`), seeded by new `npm run seed:demo`.
4. **Migrations squashed to ONE file**: 0002 folded into `0001_baseline.sql`
   (owner ruling: squash-into-baseline while pre-prod); header documents the
   wipe-and-reseed upgrade step and that a wipe regenerates user ids.
5. **Boot warning for missing `BETTER_AUTH_URL` with OAuth configured**
   (P11-03, `boot.server.ts:85-92`) — pass-11 gap #9 downgraded from "no boot
   warning" to "warn-not-enforce".
6. **Pass-11 stale-comment findings FIXED**: `project-authority.server.ts:85-87`
   (users.role sole authority) and `org-users.server.ts:43-51,:455-460`
   (live databaseHooks wiring).
7. **KB cadence honest**: `nightly` removed from `KB_REFRESH_MODES`
   (`resources.server.ts:139-142`); boot-started KB watcher
   (`kb-watch.service.server.ts`, `boot.server.ts:146`) makes "on change"
   real via `reindexKnowledgeBaseByDir` (`resources.server.ts:380`) — pass-11
   gap #5 CLOSED.
8. **MCP legacy-cred degradation now logged** (P11-61,
   `resources.server.ts:459-469`) — pass-11 gap #7 improved (warn on
   unusable cred; still no UI surfacing).
9. **Operator transition chain cap** (63cfe53): `transitionDepth` /
   `OPERATOR_TRANSITION_CHAIN_CAP` = 8 in `task-actions.server.ts` (`:108`) —
   touches the operator-bypass story in §3.5.
10. Boot also gained `startGithubReconcilePoller` (P11-14,
    `boot.server.ts:189-192`) — outside this doc's scope but shifts
    boot-sequence line numbers.

Carried over unchanged: gaps #6 (forgot-password copy informational only,
`login.tsx:530`), #8 (`coerceUserRole` belt-and-braces), #10 (deliberate
design facts — note (e) demo scope violation now lives only in the test
fixture), #11 (`"verification"` table untouched by app code,
`0001_baseline.sql:297`).

---

## Findings candidates (pass 12)

Verified mock / unwired / dead / poor / inconsistent items. Each checked
against source on `main` @ 0981cfa.

1. **UNTESTED SECURITY CONTROL — the ALLOWED_AUTH_PATHS gate has zero test
   coverage.** `grep -r ALLOWED_AUTH_PATHS` matches only
   `app/lib/auth.server.ts` (`:52`, `:190`); no test drives a blocked path
   (e.g. `POST /api/auth/change-password` → 404) or pins the allow-list
   contents. `login.server.test.ts` exercises the throttle hook through
   `auth.handler` (`:218`, `:330-343`) but never a non-driven path. The exact
   mechanism this gate depends on — `ctx.path` being the DECLARED path, hooks
   firing for `auth.api.*` — is version-sensitive better-auth behavior: a
   better-auth upgrade could silently break either direction (block
   get-session = app-wide sign-out; or stop blocking = reopen the
   change-password bypass). A test that walks the mounted endpoints and
   asserts allowed/blocked would pin it.
2. **STALE DOCSTRING — `buildAuthOptions` claims a nonexistent gen script.**
   `app/lib/auth.server.ts:80-83`: "the gen/validation script and the app both
   use this so the schema that ships is exactly the schema the app runs
   against" — the only caller in the repo is `createAuth`
   (`app/lib/auth.server.ts:284`); no schema-gen/validation script exists
   under `scripts/` (the better-auth CLI schema was generated once into the
   baseline). Misleads readers into hunting for schema-drift tooling.
3. **INCONSISTENT — Better Auth's shared-bucket limiter still governs the six
   allowed splat paths.** `rateLimit.enabled: true` (`auth.server.ts:137`)
   with rules disabled only for the two sign-in paths (`:156,:163`). On the
   proxy-less deployment every browser-borne request to
   `/api/auth/callback/:id`, `/error`, `/get-session`, `/sign-out` shares the
   one `"no-trusted-ip"` IP bucket the in-file comments call a
   denial-of-login lever. Narrow residue of pass-11 gap #1 (needs a live 429
   probe to size; server-side `auth.api.getSession` bypasses the handler
   pipeline's limiter, so app page loads are not the exposure — the OAuth
   callback burst case is).
4. **DEAD/DECORATIVE — passwordless "invited" edge in `statusOf`.** A local
   account that is passwordless (possible via `createUser` with
   `tempPassword: null` when not idp-flipped) and never logged in reads
   `active` (`org-users.server.ts:77-84` falls through) — cosmetic only, no
   authorization effect; today the only passwordless creator immediately flips
   idp to google (`:163`), so the state is unreachable through shipped UI.
5. **REDUNDANT — `deleteOrgUser` revokes sessions then deletes the identity.**
   `org-users.server.ts:320-321`: `revokeUserSessions` is a no-op prelude —
   `deleteIdentity` cascades `session`/`account` via FK
   (`0001_baseline.sql:295`). Harmless belt-and-braces; worth a comment or
   removal, not a fix.
6. **CARRIED, still open — no UI surfacing for a degraded MCP credential.**
   P11-61 added the log line (`resources.server.ts:459-469`), but the org
   settings MCP card still shows `hasCred: true` with no "credential
   unreadable" state — an admin sees a healthy-looking integration running
   no-auth unless they read server logs.
7. **CARRIED design facts that look like bugs (do not "fix")**: (a) org-admin
   override un-audited on `"any-member"` READ gates
   (`project-authority.server.ts:122-127`); (b) `view`/`comment` never call
   `requireAction` (FR4, `rbac.ts:18-23`); (c) rate-limit buckets are
   in-process and reset on restart (`rate-limit.server.ts:1-9`); (d)
   disabled-user session cleanup is raw `DELETE FROM session`
   (`require-user.server.ts:89`) — fine while better-auth has no secondary
   storage; (e) the forgot-password link is deliberately informational
   (`login.tsx:530`); (f) `coerceUserRole` viewer-absorption is dead on
   fresh DBs (baseline CHECK `0001_baseline.sql:28`) but kept for
   pre-baseline data roots.
8. **DOC-DRIFT RISK — squashed-baseline upgrade path relies on operator
   discipline.** The baseline header (`0001_baseline.sql:10-19`) is the only
   place stating that pulling a schema change requires wipe + reseed and that
   the wipe REGENERATES USER IDS (better-auth ids included — external
   references like audit `actor_user_id` snapshots survive, but any
   out-of-band stored user id goes stale). No runtime check detects a
   baseline/DB mismatch; the first symptom is a projection write throwing on a
   missing column. Accepted pre-prod per the ruling — flagged so pass-12
   implementers don't "fix" it, and so the first-deployment revisit isn't
   forgotten.
