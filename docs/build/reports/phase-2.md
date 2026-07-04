# Phase 2 report — Auth & org

Status: complete. All gates pass: `npm run typecheck` clean, `npm test`
100/100 (16 phase-1 + 84 new), `npm run build` clean. Live-verified against
`npm run dev` (curl + browser): `/` redirects to `/login` logged out; seeded
login sets cookies and lands authenticated; `/login` redirects to `/` when
logged in; forced-reset gate blocks everything until a new password is set
and rotates the session; logout destroys row + cookie (CSRF-checked, 403 on
forged token); `/org/users` 200 for admin, 403 for member; rate limit trips
on the 11th attempt; unconfigured OAuth buttons show the mock-style banner;
all audit actions observed in `audit_events`.

## File inventory

```
db/migrations/0002_auth_org.sql       # users +last_login_at +created_by; audit_events (+3 indexes)
test-support/test-db.ts               # shared temp-dir DB helper (phase-1 pattern, centralized)
app/
  root.tsx                            # loader now returns { theme, user, csrf }; sliding-session cookie re-issue; headers export
  app.css                             # appended: login CSS block from home.css + .ico.spin (marked)
  routes.ts                           # + login, logout, auth/*, org/users
  routes/
    _index.tsx                        # authenticated landing (requireUser + sign-out) — replaced in phase 4
    login.tsx                         # 1:1 port of login.jsx: providers, local form, forced-reset step
    logout.tsx                        # POST-only, CSRF-checked; GET redirects /
    auth.github.tsx  auth.github.callback.tsx
    auth.google.tsx  auth.google.callback.tsx
    org.users.tsx                     # TEMPORARY admin page (replace in phase 9 — marked in code)
  features/auth/oauth-callback.server.ts  # callback → cookies/flash/redirect glue (both providers)
  server/
    boot.server.ts                    # + seedInitialAdmin, boot sweep, daily session sweeper
    audit/audit-recorder.server.ts    # recordAudit / listAuditEvents (never throws)
    auth/
      password.server.ts             # scrypt hash/verify (self-describing format) [test]
      session.server.ts              # create/get(sliding)/destroy/rotate/sweep + sweeper [test]
      session-cookie.server.ts       # signed viberr_session cookie read/write/clear [test]
      csrf.server.ts                 # assertTrustedOrigin + assertCsrf + getCsrfToken [test]
      rate-limit.server.ts           # TokenBucketLimiter + login limiter singleton [test]
      user-store.server.ts           # low-level users CRUD (emails lowercased)
      user-admin.server.ts           # createUser/updateUser/resetPassword/disable/enable [test]
      login.server.ts                # loginWithCredentials + completeForcedPasswordReset [test]
      require-user.server.ts         # authenticate/requireUser/requireRole/safeReturnTo [test]
      oauth-shared.server.ts         # state/PKCE, signed state cookie, callback validation, whitelist sign-in
      oauth-github.server.ts         # authorize URL + code→token→/user/emails [oauth.server.test.ts]
      oauth-google.server.ts         # authorize URL (PKCE S256) + code→token→userinfo
      login-flash.server.ts          # one-shot /login flash cookie (OAuth errors, config notices)
      seed-admin.server.ts           # boot bootstrap admin [test]
  shared/
    ids/new-id.server.ts             # newId("u"|"evt"|...) → prefix_12chars
    mapping/user.server.ts           # UserRow → UserRecord (centralized snake→camel)
    auth/password-policy.ts          # MIN_PASSWORD_LENGTH = 8 (shared client+server)
  ui/
    icon.tsx                         # FULL ICON_PATHS set (36 names) + Icon (ui.jsx verbatim)
    avatar.tsx                       # Avatar (lg/xl/tones) + initialsOf
    pill.tsx                         # Pill/ReadinessPill/ValidationPill + THE readiness→display mapping (ruling 1)
    identity.tsx                     # AgentGlyph (claude|codex|op) + Identity (sub is a string prop)
    page-overlay.tsx                 # PageOverlay + Escape/focus-trap/scrim/scroll-lock (ruling 16)
    toggle.tsx                       # TglP
    toast.tsx                        # useToasts/ToastHost (2600 ms, check icon)
    csrf-input.tsx                   # <CsrfInput /> hidden _csrf field (fed by root loader)
.env / .env.example                  # VIBERR_SEED_ADMIN_EMAIL/PASSWORD (dev: arda@viberr.dev / viberr-dev-2828)
```

## Interfaces for later phases

### Current user in loaders/actions — `app/server/auth/require-user.server.ts`

```ts
const user = requireUser(request);            // SessionUser or throws redirect → /login?returnTo=…
const user = requireRole(request, "admin");  // + 403 Response if role below required (admin>member>viewer)
const ctx  = requireAuth(request);            // AuthContext: { user, sessionId, sessionToken, pwresetRequired, sessionRenewed }
const ctx  = authenticate(request);           // AuthContext | null — never throws (root loader, optional-auth spots)
```

- `SessionUser` = `{ id, email, name, title, role, theme, idp }`. Compare by
  `user.id` everywhere (ruling 6); names are display-only.
- Forced password reset: while `users.pwreset_required=1`, `requireUser`
  redirects EVERY route to `/login` (which renders the set-new-password
  step). Pass `{ allowPendingPasswordReset: true }` only where the gate must
  not apply (the reset action itself; logout uses `authenticate` directly).
- The root loader (route id `"root"`) already exposes
  `{ theme, user, csrf }` to the client — the shell (phase 4) can read the
  signed-in user via `useRouteLoaderData("root")`, no extra loader work.
- Sliding sessions: 30-day TTL, renewed at most once/day on read; the root
  loader re-issues the cookie when `sessionRenewed` (its `headers` export
  surfaces it — leaf routes that add their own `headers` export must merge
  or Set-Cookie renewal is lost on those routes).

### Protecting a mutating action — `app/server/auth/csrf.server.ts`

```tsx
// in the form JSX:
<Form method="post"> <CsrfInput /> … </Form>          // app/ui/csrf-input.tsx

// in the action:
const ctx = requireAuth(request);                      // or requireRole + requireAuth
const formData = await request.formData();
await assertCsrf(request, ctx.sessionId, formData);    // Origin/Sec-Fetch-Site + token; throws 403 Response
```

The token is `HMAC(secret, "viberr-csrf:" + sessionId)` — stateless,
per-session, provided app-wide by the root loader. Login (no session yet)
uses `assertTrustedOrigin(request)` only. Non-form callers may send the
token as an `X-Csrf-Token` header.

### Recording audit — `app/server/audit/audit-recorder.server.ts`

```ts
recordAudit(getDb(), {
  action: "auth.login.success",              // lowercase dot-separated fact
  actor: { userId, label },                   // SYSTEM_ACTOR for system events
  subjectKind: "user", subjectId: userId,     // optional
  projectSlug, taskKey,                       // optional (phase 3+)
  details: { … },                             // secret-free JSON
});
```

Never throws (logs failures). Actions recorded so far:
`auth.login.success|failure|rate_limited`, `auth.logout`, `auth.oauth.login|failure`,
`auth.password.reset`, `auth.password.forced_reset_completed`,
`org.user.created|updated|disabled|enabled`. `listAuditEvents(db, {limit, action})`
exists for tests/phase 10.

### Seed admin behavior (boot)

`bootServer()` → `seedInitialAdmin(db, { email, password })`: ONLY when the
users table is empty. `VIBERR_SEED_ADMIN_EMAIL`/`_PASSWORD` env used when
set (dev .env: `arda@viberr.dev` / `viberr-dev-2828`, deterministic login).
Without env password: default email `arda@viberr.dev` (name "Arda Kaya"),
random password logged ONCE as a stdout line marked `VIBERR BOOTSTRAP ADMIN`,
and `pwreset_required=1` so first login forces a new password. Phase 3's
seed script must create its demo users AFTER boot or tolerate the admin row
already existing (seeding is count-based, not email-based).

### User admin — `app/server/auth/user-admin.server.ts`

`createUser(db, {email,name,role,title?,tempPassword?}, actor)` — temp
password ⇒ `pwreset_required=1`; null/absent ⇒ passwordless OAuth-only
account. Creating a user row IS the OAuth whitelist entry (no extra flag).
`updateUser(db, id, {name?,title?,role?,disabled?}, actor)` (disable kills
sessions; last-active-admin cannot be demoted/disabled), `resetPassword(db,
id, tempPassword, actor)` (forces reset + kills sessions), `disableUser`/
`enableUser`. RBAC is enforced at the ROUTE level (`requireRole(request,
"admin")`) — these functions trust their caller and take `actor` for audit.
Phase 9 replaces `/org/users` (`app/routes/org.users.tsx`, clearly marked)
with the real org-settings port; the server functions stay.

### OAuth setup instructions

Set env vars and restart — buttons activate automatically (otherwise they
show the mock-style "isn't configured" banner):

- GitHub: OAuth app with callback `https://<host>/auth/github/callback` →
  `GITHUB_OAUTH_CLIENT_ID/SECRET`. Scope `read:user user:email` is requested
  (verified primary email comes from `/user/emails`). No PKCE — GitHub OAuth
  apps don't support it; the signed state cookie covers CSRF.
- Google: OAuth client (web) with redirect
  `https://<host>/auth/google/callback` → `GOOGLE_OAUTH_CLIENT_ID/SECRET`.
  Scopes `openid email profile`, PKCE S256. Email verification comes from
  the OpenID userinfo endpoint over HTTPS (not local id_token JWKS
  verification — deliberate, allowed by the build plan).
- Whitelist: sign-in succeeds ONLY if a non-disabled user row exists with
  that verified email (any idp); otherwise `/login` shows
  "No Viberr account for <email> — ask an admin to add you."
  On first OAuth login `users.idp` flips to the provider.
- State/PKCE ride in the signed 10-min `viberr_oauth` cookie; flash
  messages ride the 60-s `viberr_login_flash` cookie (Path=/login).

### UI primitives now available (`app/ui/`)

`Icon` (full mock set, `IconName` union, unknown→dot), `Avatar` (+`lg`/`xl`,
tones) + `initialsOf`, `Pill`/`ReadinessPill`/`ValidationPill` (pill.tsx is
the ONE canonical-readiness→display mapping module per ruling 1; accepts the
real enum + derived `accepted`), `AgentGlyph` (`op` variant first-class),
`Identity` (`sub` is a string prop — pass real copy), `PageOverlay`
(Escape/focus-trap/scrim-close/scroll-lock built in, markup unchanged),
`TglP`, `useToasts`/`ToastHost`, `CsrfInput`. `ui/` imports nothing from
`features/`.

## Decisions / deviations

1. **Forced reset = full session + gate**, not a partial session: login with
   `pwreset_required` creates a normal session but `requireUser` redirects
   every route to `/login` until the reset completes (spec §7.6 explicitly
   allows the "flagged session that every other loader rejects" variant).
   Completion destroys ALL the user's sessions and mints a fresh one
   (rotation). The gate also applies to OAuth logins with a pending reset.
2. **Rotate lives in session.server.ts** (`rotateSession`), not
   session-cookie.server.ts as the plan sketched — the cookie module stays
   pure sign/read/clear; rotation is a DB concern. Login always creates a
   brand-new session id (primary fixation defense).
3. **`unknown_email` and `no_password` (OAuth-only account) share the mock's
   "No local account…" copy** — avoids disclosing that an OAuth-only account
   exists; internal reasons stay distinct in audit.
4. **Login POST is origin-checked but not token-checked** (no session exists
   yet to tie a token to); rate limiting + scrypt cover it. All other
   mutations require the session-bound token.
5. **Rate limiter is in-process memory** (single-node app per architecture);
   restart clears it. Successful login resets the caller's bucket. IP =
   first `X-Forwarded-For` hop or `"local"` (RR loaders don't expose the
   socket address).
6. **Google id_token is not JWKS-verified locally** — the userinfo endpoint
   over HTTPS is used instead (explicitly permitted by the build plan).
7. **Ruling reconciliation (mid-phase)**: `data-screen-label` KEPT
   (ruling 16 overrides spec §7.11); password min 8 with adjusted copy;
   `/org/users` surfaces only admin|member roles (viewer stays valid in
   schema + `roleSatisfies`); full primitive set built now per orchestrator
   instruction (pill/identity/page-overlay/toggle/toast beyond the phase
   task's Icon/Avatar).
8. **`initialsOf` lives in `app/ui/avatar.tsx`** (phase task wording) rather
   than the spec's suggested `app/shared/initials.ts`; move it if a server
   consumer appears (none yet).
9. **`MIN_PASSWORD_LENGTH` lives in `app/shared/auth/password-policy.ts`**
   (client bundles must not import `*.server.ts`; the login form validates
   client-side like the mock).
10. **Sessions store sha256(token) as `sessions.id`** — no schema change
    needed; a DB leak yields no usable tokens. Raw token exists only in the
    signed cookie.
11. Login CSS was appended to `app/app.css` from `home.css` (login block,
    `.gmark`, `.linkish`, `.idp-chip`, spin keyframes) in the marked
    additions section — phase 4 must DEDUPE when porting home.css in full.
    The mock's `.spin` never animated (scoped `.store-strip .spin`); a global
    `.ico.spin` was added per spec §6 gotcha. `body:has(.login-wrap)` scopes
    home.css's body-overflow relaxation to the login page.
12. **A11y enhancements** (spec-sanctioned, no structural change):
    `autoComplete` on all four inputs, `role="alert"`/`role="status"` on
    error/info boxes, `aria-busy` on busy buttons. Mock's inline busy style
    (`opacity:.7; pointerEvents:none`) kept verbatim.
13. `login.md` spec's "seed arda with password 2828" is superseded by
    ruling 16 (`viberr-dev-2828`, min 8) — on-screen copy says
    "at least 8 characters".
14. The mock's `"arda"` bare-username shorthand was dropped (spec §7.7):
    email only, trimmed + lowercased; password compared exactly.
15. Audit failure events record email + machine reason only — never
    passwords; verified by test (`login.server.test.ts`).

## Known gaps (intentional)

- OAuth flows are fully implemented but not live-tested against real
  provider apps (no credentials in this environment); exchange/userinfo
  logic is covered by mock-fetch tests, state mismatch + whitelist +
  unverified-email paths included.
- `/org/users` is deliberately minimal and marked TEMPORARY (phase 9).
- `users.theme` syncs to the `viberr_theme` cookie at login; the profile
  theme editor (writing users.theme) is phase 9.
- No request-id middleware yet (phase-1 gap, still open).
- `requireRole` 403 renders the root ErrorBoundary ("Error 403") — fine
  until a designed forbidden state exists.
- Icon "spin" animation + `aria-busy` visuals rely on `.ico.spin` addition;
  `data-motion="reduce"` wiring is still phase 9.
