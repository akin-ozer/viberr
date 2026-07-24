# RBAC + AUTH + ORG — Viberr reference (pass 11, 2026-07-23)

Audience: implementation subagents with zero other context. Everything below is
verified against the code on `main` as of 2026-07-23 (post-PR #84, the
custom-login → better-auth migration). All paths are repo-relative from
`/Users/akinozer/projects/viberr`.

---

## 1. Architecture in one paragraph

Better Auth (v1.6.23, `package.json:25`) owns **authN mechanics only**:
credentials, sessions, OAuth handshakes, cookies. The legacy `users` table
remains the app's **canonical profile + org-role store**. The single invariant
binding the two: better-auth `user.id` === app `users.id`
(`app/server/auth/identity.server.ts:5-19`). Org roles are a 2-rung ladder
(`admin` / `member`) in `users.role`; **project** roles are a 4-rung ladder
(`admin` / `maintainer` / `contributor` / `viewer`) stored **file-natively** in
each project's `project.md` frontmatter `members[]` (projected into
`project_members` for reads). There is no open sign-up anywhere — identity
creation IS the whitelist.

---

## 2. AUTH

### 2.1 better-auth configuration — `app/lib/auth.server.ts`

`buildAuthOptions(deps)` (`:58`) is a pure options builder shared by the app and
the schema-gen script; `createAuth` (`:231`) wraps `betterAuth(...)`; `getAuth()`
(`:247`) is the process-wide singleton, cached under
`Symbol.for("viberr.betterAuth")` and keyed to the current `getDb()` handle so
test `closeDb()` resets rebuild it.

- **Mount**: `basePath = "/api/auth"` (`AUTH_BASE_PATH`, `:33`), served by the
  splat route `app/routes/api.auth.$.ts` — both loader and action forward the
  raw `Request` to `getAuth().handler(request)` (`:11-17`). No app CSRF token on
  this route; better-auth enforces its own Origin/trustedOrigins check.
- **Database**: the app's own `node:sqlite` `DatabaseSync` handle is passed
  directly (`database: deps.db`).
- **Secret**: `BETTER_AUTH_SECRET ?? VIBERR_SESSION_SECRET` (`:259`) — no new
  required env. Cookie prefix `viberr` → cookie `viberr.session_token`
  (`advanced.cookiePrefix`, `:227`).
- **baseURL / trustedOrigins**: `BETTER_AUTH_URL` when set; otherwise undefined
  → better-auth infers origin per request (correct for dev's varying port).
  `trustedOrigins = [baseURL]` or `[]` (`:263`).
- **emailAndPassword** (`:90-95`): enabled, `disableSignUp: true` (whitelist
  provisioning only), `minPasswordLength` from
  `app/shared/auth/password-policy.ts` (MIN_PASSWORD_LENGTH = 8).
- **Session** (`:167-170`): `expiresIn` 30 days rolling, `updateAge` 1 day
  (matches the retired hand-rolled TTL/renew interval).
- **Social providers** (`:59-81`, `socialProviders`): GitHub (scopes
  `read:user`, `user:email`; `mapProfileToUser` carries the GitHub `login` into
  the additional user field `githubHandle`) and Google (`accessType: "offline"`,
  `prompt: "select_account consent"`). Providers only exist when both client id
  and secret env vars are set (`:264-277`); the login page renders unconfigured
  buttons disabled (`app/routes/login.tsx:358-433`).
- **user.additionalFields.githubHandle** (`:171-177`): input:false; mirrored to
  legacy `users.github_handle` by the whitelist hook.
- **accountLinking** (`:179-187`): enabled with `trustedProviders: ["github",
  "google", "credential"]` — a social sign-in for an already-provisioned
  identity links by verified email and reuses the row (preserving the id
  invariant) instead of creating a duplicate.

### 2.2 Rate limiting / throttling

Two layers, deliberately arranged (long comments at
`app/lib/auth.server.ts:96-125` and `app/server/auth/rate-limit.server.ts:1-19`
explain why):

- Better Auth's own limiter is **enabled** (`rateLimit.enabled: true`) but its
  rules for `/sign-in/email` and `/sign-in/social` are set to **false** — Better
  Auth keys on client IP, and the shipped deployment (react-router-serve, no
  reverse proxy) has no `X-Forwarded-For`, so every request shares ONE bucket
  (`"no-trusted-ip|/sign-in/email"`). Under any max this is an org-wide
  denial-of-login lever, so those defaults are displaced.
- The authoritative throttle lives in the better-auth **`hooks.before`
  middleware** (`app/lib/auth.server.ts:139-165`), so a POST straight to
  `/api/auth/sign-in/email` (bypassing the app's login action via the splat) is
  still throttled:
  - `/sign-in/email`: token bucket keyed `email|ip`, **10 attempts / 15 min**
    continuous refill (`LOGIN_RATE_LIMIT`, `rate-limit.server.ts:87-90`).
  - `/sign-in/social`: keyed `provider|ip`, **30 / minute**
    (`SOCIAL_START_RATE_LIMIT`, `:93-96`) — the path carries no identity, so
    provider+ip is the finest key; sized to be unreachable by humans while
    displacing Better Auth's 3-per-10s default.
- `TokenBucketLimiter` (`rate-limit.server.ts:37-85`): in-memory, per-process,
  max 10 000 tracked keys with refilled-bucket pruning; `reset(key)` forgives on
  successful login. `clientIpOf` (`:134-141`): first `X-Forwarded-For` hop or
  the literal `"local"`.
- Pre-check failures that never reach the better-auth handler
  (unknown_email / disabled / no_password) consume their own token in
  `loginWithCredentials` (`app/server/auth/login.server.ts:95-104`) so email
  enumeration is bounded by the same bucket.

### 2.3 Credentials sign-in flow

`POST /login` intent `login` (`app/routes/login.tsx:56-118`):

1. `assertTrustedOrigin(request)` only — no session yet, so no CSRF token
   (`app/server/auth/csrf.server.ts:10-13`).
2. Already-authenticated double-submit short-circuits to a redirect (`:70-73`).
3. `loginWithCredentials(db, getAuth(), {email,password}, {requestHeaders,
   requestUrl})` (`app/server/auth/login.server.ts:63-145`):
   - normalize email (trim+lowercase), pre-check the app `users` row for the
     nicer failure taxonomy Better Auth can't give: `unknown_email`,
     `disabled`, `no_password` (OAuth-only) — each spends a rate-limit token;
   - drive Better Auth through `auth.handler(new Request(...))` against
     `/api/auth/sign-in/email` (password verification + session mint happen
     inside better-auth; the before-hook spends the token); 429 → `rate_limited`,
     any other non-ok → `wrong_password`;
   - success: `limiter.reset`, `recordUserLogin` (stamps `last_login_at`),
     audit `auth.login.success`, return the better-auth `Set-Cookie` values +
     `mustResetPassword` (= `users.pwreset_required`).
4. The route action forwards the Set-Cookie headers, appends the
   `viberr_theme` cookie, and redirects — to `/login` (reset step) when a
   forced reset is pending, else to sanitized `returnTo` or `/`.
5. Login error copy deliberately merges `unknown_email` + `no_password`
   (`login.tsx:96-99`) so OAuth-only account existence isn't revealed.

Failure audits record email + reason, never the password
(`login.server.ts:85-93`); rate-limited attempts audit
`auth.login.rate_limited`.

**Forced password reset gate**: while `users.pwreset_required = 1`,
`requireAuth` redirects everything to `/login` (which renders the
set-new-password screen, mode `"reset"`); only callers passing
`allowPendingPasswordReset` (the reset action itself, logout) get through.
Completion (`login.tsx` intent `set-password` → `completeForcedPasswordReset`,
`login.server.ts:154-177`) hashes the new password, writes the better-auth
credential via `setCredentialPassword`, clears the flag, audits
`auth.password.forced_reset_completed`. The current session stays valid; other
sessions are left to expire (first-login gate, not compromise recovery).

**Social sign-in flow** (`login.tsx:288-326`): client `fetch("/api/auth/sign-in/social",
{provider, callbackURL})` → better-auth returns the provider redirect URL →
`window.location.href`. The whole OAuth dance including callback
(`/api/auth/callback/*`) is better-auth's own code through the splat route.

**Logout** (`app/routes/logout.tsx`): POST only, CSRF-checked, audits
`auth.logout`, calls `getAuth().api.signOut({asResponse:true})` and forwards its
cookie-clearing Set-Cookie.

### 2.4 Session reading + guards — `app/server/auth/require-user.server.ts`

- `authenticateWithHeaders(request)` (`:77-101`): `getAuth().api.getSession({
  headers, returnHeaders: true })` — captures the rolling-session renewal
  `Set-Cookie` (F10-17) which the **root loader** forwards to the browser
  (`app/root.tsx:46-63`). Loads the canonical `users` row by the id invariant;
  a **disabled or vanished user has their better-auth session row deleted**
  (raw `DELETE FROM session WHERE id = ?`, `:89`) and reads as signed out.
- `authenticate(request)` (`:114`): same, dropping renewal headers (guards).
- `AuthContext` = `{ user: SessionUser, pwresetRequired, sessionId (safe to
  log; keys the CSRF token), sessionToken (never log) }` (`:37-45`).
- `requireAuth` (`:154`) → context or throw redirect to
  `/login?returnTo=…` (returnTo is normalized from React Router single-fetch
  `.data` wire URLs, `:128-146`; sanitized by `safeReturnTo` `:121-126` —
  same-app absolute paths only, rejects `//` and `/\`).
- `requireUser` (`:167`) → `SessionUser` or redirect.
- `requireRole(request, "admin")` (`:201`) → 403 JSON response via
  `roleSatisfies` (`:180`, ROLE_ORDER member=1 < admin=2).
- `requireRoleAuth` (`:215`) → role check + full context in one session lookup
  (mutation actions need `sessionId` for CSRF; WI-12 dedup).

### 2.5 CSRF — `app/server/auth/csrf.server.ts`

Two mechanisms for every mutating action of an authenticated user:
Origin/`Sec-Fetch-Site` check (`assertTrustedOrigin`, `:46-69`) plus a
double-submit token `HMAC-SHA256(VIBERR_SESSION_SECRET, "viberr-csrf:" +
sessionId)` base64url (`csrfTokenForSession`, `:18-22`), delivered via the root
loader → `<CsrfInput />` hidden field `_csrf`, or the `X-Csrf-Token` header for
fetchers; compared with `timingSafeEqual` (`:94`). `requireFormAction`
(`app/server/auth/form-action.server.ts:7-19`) bundles
requireAuth + formData + assertCsrf + actor for route actions.

### 2.6 Identity plumbing — `app/server/auth/identity.server.ts`

Synchronous row writes against better-auth's tables (never the async API):

- `provisionIdentity` (`:67-87`): upsert better-auth `"user"` row
  (`emailVerified=1`) + a `credential` provider `account` row carrying the
  scrypt hash when a password exists. Idempotent; called at every user-creation
  site (seed admin, org invite, OAuth hook, demo seed).
- `setCredentialPassword` (`:90`), `credentialPasswordHash` (`:98`),
  `syncIdentityEmail` (`:112` — admin email edits must reach better-auth's
  `user.email` or credential sign-in locks out; pass-4 WI-2),
  `revokeUserSessions` (`:125` — `DELETE FROM session WHERE userId=?`),
  `deleteIdentity` (`:135` — cascades session/account via FK).
- Password hashing: better-auth's own scrypt via `better-auth/crypto`
  re-exported in `app/server/auth/password.server.ts` (also
  `generateTempPassword` = 9 random bytes base64url).

### 2.7 Whitelist-based access (no open registration)

Three provisioning paths (creating the `users` row IS the whitelist entry —
`app/server/auth/user-admin.server.ts:23-33`):

1. **Boot seed admin** (`app/server/auth/seed-admin.server.ts`, called from
   `app/server/boot.server.ts:86-89`): when `users` is EMPTY, create the
   initial admin from `VIBERR_SEED_ADMIN_EMAIL/PASSWORD`, else fall back to
   `arda@viberr.dev` with a random password logged ONCE (`logger.warn`,
   `:77-81`) and `pwreset_required=1`.
2. **Admin-created accounts** (org settings; see §4.4): local (temp password,
   forced reset at first login), Google-account whitelisting (passwordless
   row + `idp='google'`), GitHub-handle placeholder rows, Google-domain
   allowlist rows.
3. **OAuth self-provisioning within the whitelist** —
   `app/server/auth/oauth-provision.server.ts`, wired into better-auth
   `databaseHooks` (`app/lib/auth.server.ts:191-226`):
   - `user.create.before` → `isOAuthWhitelisted` (`:50-64`): a NEW social user
     is allowed only if (a) their email domain is in `google_domain_allowlist`,
     (b) a live GitHub-handle placeholder row exists (email
     `github.com/<handle>`, `githubPlaceholderEmail`), or (c) a live legacy row
     with that email anomalously wasn't account-linked. Returning `false`
     aborts the better-auth user creation entirely.
   - `user.create.after` → `applyOAuthUser` (`:71-120`): materializes the
     `users` row (id === better-auth id) with the role resolved from the domain
     allowlist or the claimed placeholder (placeholder row + identity deleted,
     role carried over; audit `auth.oauth.placeholder_claimed`), stamps
     `github_handle`, normalizes the identity, audits
     `auth.oauth.user_provisioned`.
   - `account.create.after` → `linkOAuth` (`:123-142`): stamps the last
     provider on `users.idp`, audits `auth.oauth.login`.
   - Note in-file (`:32-36`): the provider handshake itself is NOT live-verified
     on this instance (no OAuth creds configured); the pure logic is unit-tested.

### 2.8 `users` table schema + mapping

DDL: `db/migrations/0001_baseline.sql:20-33` —
`id PK, email, name, title, role CHECK IN ('admin','member'), idp DEFAULT
'local', avatar_tone, pwreset_required 0/1, theme CHECK IN
('light','dark','system') DEFAULT 'system', disabled 0/1, created_at,
updated_at, last_login_at, created_by, github_handle` + unique index on email
(`:293`). No password column — `has_password` is derived at read time via
`EXISTS(SELECT 1 FROM account WHERE providerId='credential' AND password IS NOT
NULL)` (`app/server/auth/user-store.server.ts:19-26`).

Row→record mapping: `app/shared/mapping/user.server.ts` (`UserRow` →
`UserRecord`, camelCase, booleans from 0/1). **`coerceUserRole`** (`:15-17`):
anything that isn't exactly `"admin"` reads as `"member"` — absorbs any stray
legacy `viewer` org-role row without a data migration (the old org-level viewer
rung was retired; `:6-8`). Applied in `mapUserRow` (`:66`); also inlined in the
domain-allowlist mappers (`org-users.server.ts:352,470`).

Store API: `app/server/auth/user-store.server.ts` — `normalizeEmail`
(lowercase; lookups case-insensitive), `findUserByEmail/ById`, `listUsers`,
`countUsers`, `countActiveAdmins` (`:63`, feeds the last-admin lockout guard),
`insertUser`, `updateUserFields` (column-whitelisted patch, `:110-157`),
`recordUserLogin`.

Admin mutations with validation + audit: `app/server/auth/user-admin.server.ts`
— `createUser` (zod schema, conflict check, avatar tone round-robin,
`pwresetRequired` iff temp password; provisions identity), `updateUser`
(**last-admin lockout guard** `:135-143`: the last active admin can never be
demoted or disabled; disable revokes sessions + audits), `resetPassword`
(`:195-226`: temp password, `pwreset_required=1`, credential replaced, ALL
sessions revoked), `disableUser`/`enableUser`.

### 2.9 Env contract — `app/server/config/env.server.ts`

Required: `VIBERR_SESSION_SECRET` (≥32 chars, `:21-26`),
`VIBERR_SECRET_ENCRYPTION_KEY` (base64 of exactly 32 bytes, parsed to a
`Buffer`, `:50-73`). Optional: `BETTER_AUTH_SECRET` (rotate auth secret
independently), `BETTER_AUTH_URL` (REQUIRED behind a reverse proxy for correct
OAuth/cookie origins, `:38-44` — not enforced, only documented),
`GITHUB_OAUTH_CLIENT_ID/SECRET`, `GOOGLE_OAUTH_CLIENT_ID/SECRET`,
`VIBERR_SEED_ADMIN_EMAIL/PASSWORD`, plus runtime-backend keys. Parsed once,
cached under `Symbol.for("viberr.env")`; empty strings treated as unset.

---

## 3. RBAC

### 3.1 Org roles (2)

`UserRole = "admin" | "member"` (`app/shared/mapping/user.server.ts:9`).
`admin` runs the instance: org settings surface (`requireRole(request,
"admin")`, `app/routes/org.settings.tsx:69,102`) and the D2 emergency override
on any project (§3.4). Everyone else is `member`. Hierarchy check:
`roleSatisfies` (`require-user.server.ts:174-182`).

### 3.2 Project roles (4) + the single source

`PROJECT_ROLES = ["admin", "maintainer", "contributor", "viewer"]`
(`app/schemas/project-file.schema.ts:23`), stored per-project in `project.md`
frontmatter `members[] = {userId, role}` (projected to `project_members`,
`0001_baseline.sql:63-68`). Strict monotonic tier: viewer ⊂ contributor ⊂
maintainer ⊂ admin (`ROLE_RANK`, `app/shared/rbac.ts:27-32`).

**`app/shared/rbac.ts` is THE single source** for project-role authorization:
`RBAC_DEFINITIONS` (`:47-70`) → `ACTION_ROLES` (`:74-76`), `roleCan` (`:79`),
`rolesForAction` (`:85`). Server guards and the Policy page render the SAME
object, so display and enforcement cannot drift
(`policy-rbac.server.test.ts` drives each guard per role to keep them bound).

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
(marked `appWide: true`); their server enforcement is "authenticated", not
"member" — those guards do NOT call `requireAction` (`rbac.ts:18-23`).

### 3.4 Authority resolution — `app/server/auth/project-authority.server.ts`

THE single resolution path (pass-7 R7-1 consolidation). Every guard funnels into
`resolveProjectAuthority(db, project, actor, allowed, audit)` (`:107-146`):

1. **Membership role**: actor's live role from `project.md` `members[]` checked
   against `ACTION_ROLES` (or `"any-member"`). Live reads — role changes are
   enforced on the next action, nothing session-cached.
2. **Org-admin emergency override (owner ruling D2)**: an org admin whose
   membership would be denied is granted project-admin-equivalent authority
   (`role: "admin"`, `isOrgAdminOverride: true`), and every such grant on a
   real RbacAction writes a `project.org_admin.override` audit row (`:128-142`).
   Deliberately **not** audited for `"any-member"` route-READ gates
   (audit-noise, F7-pass7; `:127-135`).
3. Everyone else: denied with `memberRole` (null = non-member) so callers format
   the canonical 403 copy ("Only project members can …" / "Your project role (x)
   cannot …", `requireProjectAuthority` `:153-170`).

Other pieces in the same module:

- `requireProjectMutable` (`:72-83`): **archived projects are read-only**
  (R6-3) — 409 on every governed mutation until restored; the restore path
  passes `allowArchived`.
- `isOrgAdmin` (`:88-94`): reads `users.role` (`disabled=0` required).
- `requireRunAgents` / `canRunAgents` (`:181-211`): the centralized
  `run-agents` check for runtime call sites (@mention trigger, dispatch,
  interrupt, run-operator); includes the archived gate (F17).
- `assertProjectAction` (`:221-274`): slug-only callers (config surfaces, route
  gates) — reads `project.md` fresh, archived gate, then resolution.
- `requireProjectMember` (`app/server/auth/require-project.server.ts:20-45`):
  loader/action READ gate for project config surfaces (policy, agents,
  settings, github) = `assertProjectAction("any-member", …, {allowArchived:
  true})`, converting AppError to a thrown 403 Response. Board/task/timelines
  are NOT behind it (FR4 app-wide readability).

### 3.5 `requireAction` guard + call sites

`requireAction(db, project, actor, action, what)` —
`app/server/tasks/task-actions.server.ts:257-272`: archived gate then
`requireProjectAuthority(rolesForAction(action))`; returns the effective role.
`requireAnyMember` (`:244-254`) is the loosest member gate for
idempotent/no-op paths.

Call sites in `task-actions.server.ts` (all non-test):

- `:297` `accept-completion` via `requireAcceptCompletion` (`:289-298`)
- `:375` `create-task`
- `:467` `update-goal`
- `:2149` `own-task` (take/assign ownership; target must also hold `own-task`,
  `:2171`)
- `:2261` `own-task` (release own) / `:2264` `release-any-ownership`
  (release another member's; `:2167` roleCan check)
- `:2399` `approve-transition` ("change the task stage" — manual override)
- `:2405` `approve-transition` ("approve stage transitions" — approval
  boundary)
- `:2688` `reorder-board`
- `:2814` `resolve-packet` (resolve decision packets)
- `:3280` `resolve-packet` ("apply recommendations")
- `:3385` `resolve-packet` ("dismiss recommendations")

Config-surface actions go through `assertProjectAction` instead, e.g.
`manage-members` / `edit-policy` in
`app/features/policy/policy-actions.server.ts:37-53`, and the project
settings/agents/github actions name their specific ids the same way.

**Operator bypass**: when `ctx.operatorAuthorized === true`, task mutations
skip human RBAC — operator authority is gated upstream by its capability
policy. The final stage is protected: the operator reaches Done ONLY through
accept-completion, never a bare transition
(`task-actions.server.ts:2386-2394`). A human manually moving a task into the
final stage is routed through the full acceptance contract (`:2372-2384`).

**Owner exceptions** (two, related):

- `ownerException` (`:275-286`): actor is the task's `ownerUserId` AND their
  CURRENT membership role holds `own-task` (i.e. contributor+; a removed or
  demoted-to-viewer stale owner fails).
- **Accept-completion** (R6-2): `requireAcceptCompletion` (`:289-298`) lets a
  live contributor+ owner accept their own task into Done; otherwise
  `accept-completion` (maintainer+).
- **Resolve-packet** (owner ruling Q2, 2026-07-11; `:2793-2815`): a decision
  packet is addressed to the task OWNER, so the owner (contributor+) OR
  admin/maintainer may resolve it — EXCEPT the `accept_completion` option,
  which is re-gated by `requireAcceptCompletion` below (`:2828-2835`), and the
  owner path is disabled when `ctx.operatorAuthorized` (the operator resolves
  through its own authority). Acceptance additionally requires every required
  reviewer to have approved the CURRENT work revision (F10-15, `:2839-2842`).

### 3.6 Policy page rendering

`app/features/policy/policy-data.ts:27-36` maps `RBAC_DEFINITIONS` →
`RBAC_ROWS` (`grant: Record<ProjectRole, 0|1>` + `appWide` flag) — consumed by
`PolicyPage` via `app/routes/project.policy.tsx` (loader behind
`requireProjectMember`; actions `set-role`/`set-boundary` via
`requireFormAction`, both admin-gated inside
`policy-actions.server.ts` with a project-level last-admin guard and the
hard-locked human review→done boundary). The same map also drives client-side
UX gating (`roleCan` calls in `app/features/task-detail/task-detail-page.tsx`,
`execution-profile.tsx`, and server projections
`review-queue.server.ts:135-136`, `decisions.server.ts`) — sugar only; the
server guards are authoritative.

---

## 4. ORG STORE (org settings surface)

Route: `/org/settings` (`app/routes/org.settings.tsx`) — loader
`requireRole("admin")` (`:69`), action `requireRoleAuth("admin")` + CSRF
(`:99-107`). Every mutation is a POST intent (~30 of them, `:112-385`); the
loader payload is `getOrgSettingsView`
(`app/server/org/org-view.server.ts:39-53`): connections, users, domains, kbs,
mcps, skills, gagents, stages.

### 4.1 Knowledge bases — `app/server/org/resources.server.ts:134-364`

Content is **file-native**: real folders under `${VIBERR_DATA_ROOT}/kb/<dir>/`
(in the shipped compose this is under `docker-data/`), scanned from disk on
every read. SQLite (`org_knowledge_bases`: id, name, dir UNIQUE, refresh,
last_indexed_at) carries only metadata. **Disk is truth**: listings union disk
folders with metadata rows (`unionDiskAndRows`, `:116-132`); a folder with no
row renders under a synthetic `disk:<name>` id (traversal-hardened,
`diskNameFromId` `:74-92`) and is adopted into a real row on edit/reindex.
Rename = slug recompute + real folder move, collisions refused (`:245-256`).
Delete removes folder + row (`:305-325`). `reindexKnowledgeBase` (`:329-364`)
is an honest re-scan (count + timestamp). Refresh cadence vocabulary: `manual |
on change | nightly` (`KB_REFRESH_MODES`, `:136`). URI contract:
`store://kb/<dir>`.

### 4.2 Skills — `resources.server.ts:823-1080`

Real `SKILL.md` folders under `${DATA_ROOT}/skills/<name>/`; same disk-is-truth
union + `disk:` adoption. `org_skills` rows carry name UNIQUE + summary.
Body reads are capped at 256 KB (`SKILL_BODY_MAX_BYTES`); the E4 write policy
(`:979-995`) refuses saving a truncated round-trip back over a larger on-disk
file and keeps the existing body when an empty body arrives without the
explicit `clearBody` flag. Disk-only skills derive their summary from SKILL.md
frontmatter `description:` (`:869-879`).

### 4.3 MCP servers — `resources.server.ts:366-821`

`org_mcp_servers` rows: name (slug, UNIQUE), transport `HTTP|stdio`, target,
`cred_ref`, tools_count, up, last_checked_at. **Credential encryption
(F7-MCP1)**: `cred_ref` stores an AES-256-GCM secret box (`sealSecret`) —
sealed at save (`saveMcpServer`, `:648-662`), never returned to any client
(views expose only `hasCred: boolean`, `:373-377`); on edit a blank field keeps
the existing sealed value. Decryption happens ONLY in `getMcpCredential`
(`:416-429`), consumed exclusively by the run-spawn injection path
(specialist-mcp); non-box legacy values and open failures return null (degrade
to no-auth, never leak or crash). Health is honest: HTTP targets get a real
reachability probe (any HTTP response = up, `probeMcpTarget` `:597-630`); stdio
targets get a real JSON-RPC `initialize` → `tools/list` handshake with a hard
timeout (`discoverStdioMcpTools`, `:494-590`); tool counts are never
fabricated. The in-process `viberr` operator MCP is reserved and never offered
to specialists (`resource-catalog.server.ts:32`, RESERVED_OPERATOR_MCP).

### 4.4 Users, whitelists, domain allowlist — `app/server/org/org-users.server.ts`

Thin composition over the phase-2 user-admin API (route-level
`requireRole("admin")` is the access control; functions trust their caller and
audit via `actor`):

- `createLocalAccount` (`:176-199`): temp password generated, surfaced ONCE to
  the admin (no mailer in V1), forced reset at first sign-in.
- `whitelistGoogleAccount` (`:149-174`): passwordless row + `idp='google'` —
  the row's email is what the OAuth flow account-links.
- `whitelistGithubUser` (`:113-147`): placeholder identity row (name
  `@handle`, email `github.com/<handle>` — deliberately not an email) until
  first GitHub sign-in claims it (`applyOAuthUser`, §2.7).
- `updateOrgUser` (`:215-262`): local accounts may change name/email (email
  change syncs the better-auth identity, pass-4 WI-2); idp accounts change
  role only. `setOrgUserRole` (`:264`).
- `resetLocalPassword` (`:275-294`): local-only; temp password once, sessions
  killed, forced-reset gate.
- `deleteOrgUser` (`:302-330`): hard delete (9B addition; audit rows keep
  denormalized actor snapshots); refuses removing the last active admin;
  revokes sessions and deletes the better-auth identity so the email can be
  re-created (pass-4 WI-3). Self-targeting demote/disable/remove is refused in
  the route action (`org.settings.tsx:151-193`).
- Status derivation for the table (`statusOf`, `:76-83`): never-logged-in
  OAuth rows = `whitelisted`, never-logged-in local with pending reset =
  `invited`, else `active`.
- **Google domain allowlist** (`:332-471`): `google_domain_allowlist` rows
  (id, domain UNIQUE like `@viberr.dev`, role admin|member). `normalizeDomain`
  accepts `@domain`, `user@domain`, bare domain. `findDomainAllowlistRole`
  (`:460-471`) is the hook the OAuth `create.before/after` hooks consult — a
  fresh Google sign-in from an allowlisted domain joins with the mapped role.

### 4.5 GitHub connections — `app/server/org/connections.server.ts`

A connection = owner + PAT, `github_connections` row (id = slugified owner,
pat_id → `github_pats`, is_default, repos_count, expires_at) joined to the PAT
store for masked display + cached validation. Built around **"nothing is saved
unless validation passes"** (§7.2): `createConnection` (`:246-299`) and
`replaceConnectionToken` (`:301-343`) first run `validatePatToken` against
`CONNECTION_REQUIRED_SCOPES` = repo · workflow · pull_request:write (`:41-45`)
plus a real owner-existence/repo-count probe; typed failures
(`duplicate|validation_failed|not_found`) leave the DB untouched and on replace
the old token stays active. Exactly one default, transactionally
(`setDefaultConnection`, `:350-374`); the default cannot be removed
(`removeConnection`, `:382-405`). `getDefaultConnectionToken` (`:148-155`)
returns the decrypted token ONLY when the last validation passed —
server-internal, used by the StoreBrowser GitHub import
(`store-files.server.ts`, `importGithubSnapshot` via the git trees API; no
unauthenticated fallback).

Validation honesty (`app/server/secrets/pat-validator.server.ts:25-55`):
classic `ghp_` tokens verify scopes via the authoritative `x-oauth-scopes`
header; fine-grained `github_pat_` tokens have no introspection so write scopes
come back `source:"assumed"` (granted until a real 403 opens a scope
violation); expired-vs-revoked on 401 is a documented heuristic.

### 4.6 Store browser file ops — `app/server/org/store-files.server.ts`

Real filesystem mutations under the resolved store folder followed by a
re-scan. Server-enforced safety (`:23-38`, `:89-131`): path segments sanitized
(no `..`, no absolute paths, backslashes → `-`), dot-prefixed segments skipped,
files never clobber directories, every resolved path verified under the root.
Ops: `writeStoreFiles` (upload incl. folder uploads; captures a root SKILL.md),
`createStoreFolder` (mkdir -p), `deleteStoreNode`, `importGithubSnapshot`.
Targets resolved via `resolveStoreTarget` (`resources.server.ts:1086-1113`).

### 4.7 Global agent profiles — `app/server/org/gagents.server.ts`

Org-level agent TEMPLATES as files under `${DATA_ROOT}/agents/profiles/<id>.md`
(the system `operator` template is never listed/editable here). `used` is a
projection over `projects.agent_policy_json` deployment counts (`:70`), gating
deletion ("Detach from N projects first"). Edits preserve fields the modal
doesn't own via read → merge → serialize.

---

## 5. SECRETS

### 5.1 Encryption at rest — `app/server/secrets/secret-box.server.ts`

AES-256-GCM secret box. Key: `VIBERR_SECRET_ENCRYPTION_KEY` env — base64 →
exactly 32-byte `Buffer`, validated at boot (`env.server.ts:50-73`). **No
derivation** (no KDF): the env value IS the key. Box format (stable storage
contract): `v1$<iv b64>$<ciphertext b64>$<tag b64>` — 12-byte random IV per
seal, 16-byte GCM tag; any tamper fails decryption with the typed AppError
`secret_box_invalid` (never garbage plaintext). Error messages never include
plaintext or key material (`:36-44`). Encrypted things: GitHub PATs
(`github_pats.encrypted_token`) and MCP credentials
(`org_mcp_servers.cred_ref`).

### 5.2 Redaction / exposure rules

- PAT metadata readers NEVER return the token — only `getPatToken`
  (`pat-store.server.ts:190-199`) decrypts, "feed it straight into the GitHub
  client; never into loader data, logs, timelines or errors". Display is
  `token_suffix` (last 4) as `····xxxx`.
- Audit rows record label + suffix only (`pat-store.server.ts:103-109`); login
  failure audits record email + reason, never the password
  (`login.server.ts:86`); `sessionToken` is documented never-log
  (`require-user.server.ts:43-44`).
- The one deliberate plaintext credential log: the bootstrap admin's generated
  password, logged once and clearly marked (`seed-admin.server.ts:75-81`).
- MCP credential: only `hasCred` boolean crosses to the client
  (`resources.server.ts:373-377`).
- The structured logger itself (`app/server/logging/logger.server.ts`) has NO
  redaction layer — callers are responsible; runtime adapters classify provider
  failures into redaction-safe canonical messages before raw text is dropped
  (`codex-runtime.server.ts:188-196`, `claude-runtime.server.ts:257`).

---

## 6. DB

### 6.1 node:sqlite setup — `app/server/db/sqlite.server.ts`

`openDatabase` (`:12-19`): `new DatabaseSync(path)` with `PRAGMA journal_mode =
WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000`. Path:
`${VIBERR_DATA_ROOT}/state/projection.sqlite` (`:22-25`). `getDb()` is an
HMR-surviving singleton (`Symbol.for("viberr.db")`) that runs pending
migrations on first open; `closeDb()` for tests/shutdown.
`withTransaction` (`app/server/db/transaction.server.ts`): BEGIN/COMMIT with
rollback guarded by `db.isTransaction`.

### 6.2 Migrations — `app/server/db/migration-runner.server.ts` + `db/migrations/`

Filename-ordered `*.sql` files, each applied in its own transaction and
recorded in `schema_migrations`; re-runs are no-ops **by filename alone**.
Only two files:

- `0001_baseline.sql` — squashed pre-prod baseline (the original 13-file chain
  was collapsed; the header `:1-17` warns: NEVER add columns to this file —
  existing DBs skip it by filename, so edits reach fresh DBs only; there is no
  drift healer anymore).
- `0002_delivering_single_flight.sql` — F10-05 partial unique index: at most
  one queued/running `primary` agent run per (project, task).

### 6.3 Table overview (baseline)

App-owned (snake_case):

- **Identity/RBAC**: `users` (§2.8), `google_domain_allowlist`.
- **Audit**: `audit_events` (id, occurred_at, actor_user_id, actor_label,
  action, subject_kind/id, project_slug, task_key, details_json) — denormalized
  actor snapshots survive user removal.
- **Projections of file truth** (rebuildable, never canonical): `projects`
  (slug PK, archived, stages/workflow/agent_policy/credential_policy/guardrails
  JSON, source_path, content_hash), `project_members` (project_slug, user_id,
  role CHECK IN the 4 project roles), `task_projections`, `task_events`,
  `diagnostics`, `provenance`.
- **App state**: `notifications`, `user_prefs` (user_id+key → value_json),
  `scope_violations` (partial unique open-violation index).
- **Secrets/GitHub**: `github_pats` (encrypted_token, token_suffix,
  validation_json, last_validated_at), `project_github_credentials`
  (project_slug PK → pat_id), `github_connections`.
- **Org resources (metadata only)**: `org_knowledge_bases`, `org_mcp_servers`,
  `org_skills`.
- **Runtime**: `agent_runs`, `run_log_lines`.

better-auth-owned (camelCase, quoted, generated by better-auth's CLI schema —
`0001_baseline.sql:286-289`): `"user"` (incl. custom `githubHandle`),
`"session"` (token UNIQUE, userId FK cascade), `"account"` (providerId
`credential|github|google`, `password` column carries the scrypt hash),
`"verification"` (better-auth internal state, e.g. OAuth state).

Retention (`app/server/db/retention.server.ts`, applied best-effort at boot,
`boot.server.ts:143-149`): run_log_lines 30 days, audit_events 90 days,
notifications newest 500/user. Canonical markdown files are never touched.

---

## 7. SEED

### 7.1 Boot-time seed admin (always on)

`bootServer()` (`app/server/boot.server.ts:73-177`, called from
entry.server module scope) → `seedInitialAdmin` (§2.7 item 1) only when
`users` is empty. Also: default agent assets, SSE publisher, boot rescan,
base-agent backfill, file watcher, orphaned-run finalize, retention, reply
recovery, schedule runner.

### 7.2 Demo seed — `npm run seed` → `app/server/seed/demo-seed.server.ts`

Writes the full mock dataset as REAL canonical files + projections. Idempotent
(users upserted by email, files overwritten, deterministic notification ids);
`--reset` wipes `${dataRoot}/projects`, `agents/profiles`, `runtimes/` and all
derived tables first (`DERIVED_TABLES`, `:73-83`).

- **Users** (`SEED_PEOPLE`, `app/server/seed/demo-data.server.ts:76-83`), all
  `idp='local'`, all with better-auth identities provisioned, password
  `viberr-dev-2828` (`SEED_DEFAULT_PASSWORD`, `demo-seed.server.ts:54`; Arda's
  from `VIBERR_SEED_ADMIN_PASSWORD` when set; existing users keep their
  password):
  - Arda Kaya `arda@viberr.dev` — org **admin**
  - Elif Demir `elif@viberr.dev` — org member
  - Murat Yıldız `murat@viberr.dev` — org member
  - Selin Aksoy `selin@viberr.dev` — org member
  - Deniz Şahin `deniz@viberr.dev` — org member (no project membership — the
    app-wide-view test subject)
- **Projects + memberships** (`demo-data.server.ts:323-400`):
  - `viberr-core` (VIB, governed template): elif **admin**, arda **admin**,
    murat **maintainer**, selin **contributor**; declares a credentialPolicy
    with requiredScopes but NO fabricated masked token (honest empty slate).
  - `deploy-pipeline` (DEP): arda **admin**, elif **maintainer**.
  - `billing-service` (BIL, lightweight 3-stage template): arda **admin**.
- **Tasks**: VIB-139..168 with full timelines + one stub task each in the two
  stub projects; NO run history is ever seeded (R7-2: don't simulate).
- Also: agent profile templates, Arda's notification inbox, one open seeded
  scope violation `sv_seed_vib142_pr_write` (deliberate mock state,
  `demo-seed.server.ts:255-269`), Arda's home pins.

### 7.3 Org-resource seed — `app/server/org/org-seed.server.ts` (additive)

`seedOrgResources`: 3 KBs with 15 real files under `${DATA_ROOT}/kb/`
(architecture-notes, api-contracts, deploy-runbooks; back-dated mtimes), 4
skills with real SKILL.md folders (conventional-commits, terraform-review,
api-design, changelog-writer), and the `@viberr.dev` Google-domain allowlist
row (role member, `:361-366`). **Honest empty slate** (owner ruling,
`:256-262`): NO MCP servers and NO GitHub connection are seeded; any
admin-installed connection survives `--reset`.

---

## Suspicious / gaps

1. **KNOWN OPEN ITEM — throttle asymmetry on the auth splat**: the app-level
   throttle hook (`app/lib/auth.server.ts:139-165`) covers only
   `/sign-in/email` and `/sign-in/social`; `customRules` (`:96-125`) disables
   Better Auth's shared-bucket rules for exactly those two paths. Every OTHER
   better-auth POST path reachable through `app/routes/api.auth.$.ts:11-17`
   (e.g. `/request-password-reset`, `/forget-password`) still runs Better
   Auth's default IP-keyed limiter — which on this proxy-less deployment is the
   same shared `"no-trusted-ip"` bucket the comments call a denial-of-login
   lever. Mitigating fact: `sendResetPassword` is not configured, so the reset
   flow is functionally inert (better-auth errors it) — but the endpoints
   answer, and the shared-bucket lever stands for any future enabled path.
2. **Unaudited parallel account mutations via the splat (verify)**: better-auth
   default endpoints `POST /api/auth/change-password` and
   `POST /api/auth/update-user` are reachable through `api.auth.$.ts` for any
   signed-in session. `change-password` would bypass the app's own
   change-password flow (`app/routes/profile.tsx:94` →
   `app/features/profile/profile-actions.server.ts:121`, which audits and kills
   other sessions); `update-user` writes better-auth `user.name` only,
   diverging from `users.name` (cosmetically harmless — the app renders from
   `users` — but a real split-brain lever). Not exercised live; needs a
   verification pass and either disabledPaths/rules or app-level parity.
3. **Stale/wrong comment**: `app/server/auth/project-authority.server.ts:85-87`
   claims "better-auth membership is authoritative; `users.role` is the
   derived-cache fallback" — false: there is no better-auth org/membership
   plugin in this app; `isOrgAdmin` (`:88-94`) reads only `users.role`.
   Misleads implementers into looking for a nonexistent membership table.
4. **Stale docstrings from before PR #84**:
   `app/server/org/org-users.server.ts:44-50` ("claiming the placeholder in
   the GitHub callback is a documented later-phase wiring") and `:454-459`
   ("the one-line hook for the Google OAuth callback (later-phase wiring)") —
   both flows are NOW live via `oauth-provision.server.ts` +
   `databaseHooks` (`app/lib/auth.server.ts:191-226`). Docs lag the code.
5. **KB `refresh` cadence is decorative**: `manual | on change | nightly`
   (`resources.server.ts:136`) is stored and displayed, but nothing schedules
   re-indexing — `last_indexed_at` only changes on seed or the manual
   `kb-reindex` intent (`org.settings.tsx:252-253`). "nightly" never fires.
6. **`login.tsx` "Forgot password?" is informational only**
   (`app/routes/login.tsx:518-531`): shows "ask an admin" copy; no self-serve
   reset exists (by design — admin reset + forced-reset gate), but zero-context
   readers should not go looking for a reset route.
7. **Legacy-plaintext MCP creds silently degrade**: `getMcpCredential`
   (`resources.server.ts:416-429`) returns null for non-secret-box `cred_ref`
   values and for open failures (rotated key) — a run degrades to no-auth with
   no surfacing anywhere in the UI or logs.
8. **`coerceUserRole` legacy-viewer absorption is dead on fresh DBs**: the
   baseline `users.role` CHECK only admits `admin|member`
   (`0001_baseline.sql:25`), so the `viewer`-absorbing coercion
   (`app/shared/mapping/user.server.ts:12-17`) only matters for pre-baseline
   databases. Harmless belt-and-braces; don't remove without checking deployed
   DBs.
9. **`BETTER_AUTH_URL` requirement behind a proxy is documented, not
   enforced** (`env.server.ts:38-44`; `trustedOrigins` collapses to `[]` at
   `app/lib/auth.server.ts:263`): a reverse-proxied deployment without it gets
   request-inferred origins — broken OAuth callback/cookie URLs with no boot
   warning.
10. **Deliberate design facts that look like bugs** (do not "fix"): (a) org-
    admin override on `"any-member"` READ gates is intentionally un-audited
    (`project-authority.server.ts:127-135`); (b) `view`/`comment` guards never
    call `requireAction` — app-wide by FR4 (`app/shared/rbac.ts:18-23`);
    (c) rate-limit buckets are in-process and reset on restart
    (`rate-limit.server.ts:1-9`); (d) disabled-user session cleanup uses raw
    SQL `DELETE FROM session` (`require-user.server.ts:89`) rather than the
    better-auth API — fine while better-auth has no secondary storage;
    (e) demo-seeded open scope violation `sv_seed_vib142_pr_write`
    (`demo-seed.server.ts:255-269`) is intentional mock state, the one
    exception to the honest-empty-slate rule.
11. **`"verification"` table exists but no app code touches it**
    (`0001_baseline.sql:289`) — better-auth internal (OAuth state). Expected;
    flagged so nobody assumes email verification flows exist.
