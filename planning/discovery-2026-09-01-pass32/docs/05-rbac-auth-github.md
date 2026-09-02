# 05 — RBAC, Auth, Secrets, GitHub Delivery, Audit

Reference doc for the pass-32 discovery/implementation phase. Standalone: every claim and every
`path:line` below was re-resolved against `main @ 68b5480e` (2026-09-01). Ruling numbers are the
canonical ones in `docs/architecture/decisions.md` (rulings 100–108 start at `:1422`).

Delta since the pass-31 doc (`git log f868f131..HEAD`): PR #253 (pass-31 implementation —
`resolve_remote_collision`, positive-evidence reconciler provenance, owned-only `github.changed`),
PR #254 (rulings 100–103 — repo-write parity, FR33 export-before-purge, Chromium-only matrix),
PR #257/#258/#259 (rulings 104/105 — verbatim operator narration, attachment prune + viewer +
universal Download), PR #260 (ruling 106 — controller settings parity), PR #261 (ruling 107 —
`viberr_ops` diagnostics MCP with per-tool RBAC), PR #262–#264 (ruling 108 — deployment-locked
controller configuration).

**`app/shared/rbac.ts` itself did not change.** Neither did `app/server/auth/*` (one test file
only). The movement in this domain is in `app/server/github/*`, `app/server/tasks/task-actions.server.ts`,
`app/server/controller/*`, `app/server/db/retention.server.ts` and `app/shared/capabilities.ts`.

---

## 1. RBAC model

### 1.1 Three separate authorization systems (ruling 2, `decisions.md:137`)

| System | Values | Stored in | Enforced by |
| --- | --- | --- | --- |
| **Org role** | `admin \| member` | `users.role` (SQLite; CHECK at `db/migrations/0001_baseline.sql:28`) | `requireRole` / `requireRoleAuth`, `app/server/auth/require-user.server.ts:208`,`:222` |
| **Project role** | `admin \| maintainer \| contributor \| viewer` | `project.md` frontmatter `members[]` (file-native; CHECK on the `project_members` mirror at `0001_baseline.sql:69`) | `app/shared/rbac.ts` → `app/server/auth/project-authority.server.ts` |
| **Agent capability** | `direct \| recommend \| human \| off` per capability id | agent-profile grants | `app/shared/capabilities.ts` + `app/server/tasks/specialist-tool-policy.ts` |

Org roles are a two-rung ladder (`UserRole` at `app/shared/mapping/user.server.ts:9`; `ROLE_ORDER`
at `require-user.server.ts:181`, `roleSatisfies` at `:187`). `coerceUserRole`
(`user.server.ts:15`) coerces any legacy/unknown stored string down to `member`.

Project roles form a **strict tier**: `viewer ⊂ contributor ⊂ maintainer ⊂ admin`
(`ROLE_RANK` in `app/shared/rbac.ts:31`). Every matrix entry is monotonic, so the explicit role
list is for readability + rendering the Policy table's columns, not for expressiveness.

`reviewer` was renamed `contributor` (ruling 2 amendment). `PROJECT_ROLES` is declared at
`app/schemas/project-file.schema.ts:24` and re-exported from `app/shared/rbac.ts:29`.

### 1.2 ACTION_ROLES — the full matrix

Single source: `RBAC_DEFINITIONS` at `app/shared/rbac.ts:61`, mapped into
`ACTION_ROLES: Map<RbacAction, readonly ProjectRole[]>` at `:97`. `roleCan(role, action)` (`:104`)
and `rolesForAction(action)` (`:110`) are the only readers. `rolesForAction` **throws** on an
unknown id (`:114`) — an action string that reached it past the type is a defect, not a deny.

| # | action id | label | admin | maintainer | contributor | viewer | Primary enforcement site |
| --- | --- | --- | :-: | :-: | :-: | :-: | --- |
| 1 | `view` | View board, tasks & timelines | ✓ | ✓ | ✓ | ✓ | membership gate only (never calls `requireAction`) |
| 2 | `comment` | Comment on tasks | ✓ | ✓ | ✓ | ✓ | membership gate only; `appendComment` asserts only the archived freeze (`task-actions.server.ts:1000`) |
| 3 | `create-task` | Create tasks | ✓ | ✓ | ✓ | | `task-actions.server.ts:460`; goals `goal-actions.server.ts:125` |
| 4 | `own-task` | Take / release own task ownership | ✓ | ✓ | ✓ | | `task-actions.server.ts:4069`, `:4201`; also the `ownerException` predicate `:308` |
| 5 | `edit-task-meta` | Edit task priority, labels & due date | ✓ | ✓ | ✓ | | `task-actions.server.ts:679` |
| 6 | `approve-transition` | Approve stage transitions | ✓ | ✓ | | | `task-actions.server.ts:4464`, `:4481`; archive `:5809`; packet options `:6384` (`archive_task`), `:6414` (`discard_branch`), `:6443` (`resolve_remote_collision`) |
| 7 | `resolve-packet` | Resolve decision packets | ✓ | ✓ | | | `requireDecisionAuthority` `task-actions.server.ts:352`/`:364`; `:6041`; `:7007` |
| 8 | `accept-completion` | Accept completion → Done | ✓ | ✓ | | | `requireAcceptCompletion` `task-actions.server.ts:322` (+ owner exception); call sites `:4486`, `:6065`, `:7969`, `:8416` |
| 9 | `update-goal` | Edit the task goal | ✓ | ✓ | | | `task-actions.server.ts:574` |
| 10 | `run-agents` | Run agents | ✓ | ✓ | | | `requireRunAgents` / `canRunAgents` `project-authority.server.ts:293`,`:311`; `manualDeliverForReview` `task-actions.server.ts:5333`; goals `goal-actions.server.ts:257` |
| 11 | `reorder-board` | Reorder the board | ✓ | ✓ | | | `task-actions.server.ts:5699` |
| 12 | `reconcile-github` | Reconcile GitHub state | ✓ | ✓ | | | `app/routes/project.github.tsx:125` (via `requireGithubAction` `:120`) |
| 13 | `grant-github-scope` | Grant GitHub scope | ✓ | ✓ | | | `project.github.tsx:129`,`:135`; `project.settings.tsx:197`,`:204`; display gate `credential-visibility.server.ts:40` |
| 14 | `rescan-project` | Re-scan project files & projections | ✓ | ✓ | | | `app/routes/project.board.tsx:130` |
| 15 | `release-any-ownership` | Release any task owner | ✓ | | | | `task-actions.server.ts:4204` |
| 16 | `manage-members` | Manage members & roles | ✓ | | | | `settings-actions.server.ts:794`,`:859` |
| 17 | `manage-agents` | Manage agent profiles | ✓ | | | | `agent-profile-actions.server.ts:215` |
| 18 | `edit-policy` | Edit workflow & policy | ✓ | | | | `settings-actions.server.ts:197`,`:261`,`:351`,`:460`,`:497`,`:561`,`:701`,`:964`,`:1008`; `policy-actions.server.ts:197` |
| 19 | `force-accept-completion` | Force-accept past the review gate | ✓ | | | | `forceAcceptCompletion` `task-actions.server.ts:8320` |

Display renders from the SAME object: `RBAC_ROWS` at `app/features/policy/policy-data.ts:41`.
`app/features/policy/policy-rbac.server.test.ts` drives every guard once per role (its
`"rescan-project": ["admin","maintainer"]` style table at `:1722`) so display and enforcement
cannot drift.

**Owner exception (R14-2 / R15-3, ruling 22).** `ownerException` (`task-actions.server.ts:308`)
lets a task's live owner — provided they hold `own-task`, i.e. contributor+ — accept their own
task and apply/dismiss any operator recommendation on it, short-circuiting the role tier. It does
**not** short-circuit the archived freeze: both `requireAcceptCompletion` (`:322`) and
`requireDecisionAuthority` (`:352`) call `requireProjectMutable` *before* the owner check,
deliberately. The 2026-08-31 packet-option additions preserve this shape: an owner-contributor
clears the outer packet gate and is then refused at the inner `approve-transition` re-check for
`archive_task` / `discard_branch` / `resolve_remote_collision`.

### 1.3 The resolution path

`app/server/auth/project-authority.server.ts` is the ONE place "what may this actor do here" is
answered (R7-1 consolidation). Key exports:

- `requireProjectMutable(project, what)` — the archived freeze, single implementation (`:136`).
- `isOrgAdmin(db, userId)` (`:152`) — reads `users.role` directly; **disabled users never qualify**.
- `resolveProjectAuthority(db, project, actor, allowed, audit)` — non-throwing core (`:173`).
- `requireProjectAuthority(...)` — throwing wrapper with the canonical 403 copy (`:265`).
- `requireRunAgents` / `canRunAgents` (`:293`, `:311`).
- `assertProjectAction(db, action, projectSlug, actor, what, opts)` — slug-only callers; reads
  `project.md` fresh (`:337`).
- `requireAction(db, project, actor, action, what)` defined at
  `app/server/tasks/task-actions.server.ts:290` — calls `requireProjectMutable` first (`:300`),
  then `requireProjectAuthority(rolesForAction(action))`. `requireProjectMutable` is re-exported
  from that module at `:250`.
- `requireAnyMember(...)` — the role-free membership gate (`task-actions.server.ts:277`), used by
  the auto-boundary stage move (`:4474`) and self-release of ownership (`:4194`).

Three rules live in `project-authority.server.ts`:

1. **Membership role** checked against `ACTION_ROLES`.
2. **Org-admin emergency override (owner ruling D2, implemented per R7-1).** An org admin whose
   membership role would be denied gets project-admin-equivalent authority, and **every such grant
   writes a `project.org_admin.override` audit row**. F19-30 extended this to the `"any-member"`
   gate (commenting is deliberately role-free, so that gate IS its only authority) with a 60s
   dedupe window keyed `ovr|<userId>|<slug>|<what>` — the `what` is in the key so a READ gate can
   never mask a WRITE gate. Dedupe helper: `shouldRecordOnce` (`:108`).
3. **Denial audit (P13-D-8).** Every refusal writes `project.authority.denied`, deduped 60s on
   `deny|<userId>|<slug>|<action>`. `silentDeny: true` is used by exactly one caller — `canRunAgents`
   on the @mention path, where a lower-role commenter's comment is kept and the run silently skipped.

Ruling 107 extended the same audited-denial discipline to the instance scope: the controller's
shared guards record `controller.authority.denied` on an org-admin refusal
(`app/server/controller/controller-tool-guards.server.ts:89`–`:99`).

### 1.4 Members-only projects / visibility (R15-4, ruling 25)

Projects are **members-only**. A signed-in non-member is indistinguishable from a nonexistent slug.
Three enforcement points, all producing byte-identical `No project at projects/<slug>.` 404s:

| Surface | Guard | File |
| --- | --- | --- |
| Layout READS (board, task detail) | inline `memberRole ?? orgAdminOverride` check | `app/routes/project.tsx:74`,`:89`; `myRole` derived at `:132` |
| Child-route config loaders | `requireProjectMember(request, slug, what)` | `app/server/auth/require-project.server.ts:33` |
| Child-route ACTIONS | `requireVisibleProject(db, slug, actor, what)` | `app/routes/project-visibility.server.ts:28` |

Why all three: React Router runs a child route's **action** without its parent's loader, and
single-fetch honors a client-supplied `?_routes=` filter, so
`GET /projects/<slug>/policy.data?_routes=routes/project.policy` runs the child loader *alone*
(F19-28). `requireProjectMember` collapses both failure modes (not-a-member 403, missing
`project.md` 404) into one response at `require-project.server.ts:57`; two different refusal
strings are themselves an oracle.

`projectNotFound` (`require-project.server.ts:81`) echoes the slug **only** when the URL already
named it positionally (`/projects/<slug>/…`, `.data` suffix tolerated). The two run-addressed
resource routes (`/resources/run-log?runId=`, `/resources/session-export?run=`) resolve the slug
from the RUN row, so they get a bare `Not found.` — echoing there would hand a non-member the name
of a project they never asked about. The check is positional, not `includes`, so a project actually
slugged `resources` is not special-cased into a leak.

Archived projects stay **reachable** on all three (`allowArchived: true`); the read-only gate is a
mutation concern.

**Credential visibility (R19-11, ruling 65).** A project Viewer does not get the credential card,
and the **loader redacts on the same rule** — `credentialGrantHolder` (`grant-github-scope`) at
`app/features/github/credential-visibility.server.ts:40` and `withoutCredentialDetail` at `:70`.
A render-only gate left `github_pat_••••42af` in the single-fetch payload. The redaction nulls
`patId/label/masked/lastValidatedAt/validation` and empties `scopes`/`openViolations` but keeps
`configured/source/requiredScopes` (project policy, not credential detail). It deliberately does
NOT call `resolveProjectAuthority`: a page read by a role with no reason to see a token is not an
unauthorized attempt (the P13-D-8 `silentDeny` category), and membership was already audited by
`requireProjectMember` in the loader.

### 1.5 Archive rules (R6-3 / R14-3 / F19-8 / F26-13)

- **Project archived** → read-only. `requireProjectMutable` throws 409
  `"This project is archived (read-only) — restore it before you <what>."` The ONE exemption is the
  restore action itself (`setProjectArchived` passes `allowArchived`). Timelines and audit stay
  readable. F17 extended it to the agent runtime (`requireRunAgents` calls it before the tier check),
  because runs write branches, commits and timeline events.
- **Task archived** → `archivedTaskBlockedReason` (`app/schemas/task-file.schema.ts:895`) refuses
  acceptance; `archivedTaskMoveBlockedReason` (`:914`) refuses stage moves (F19-8); `edit-task-meta`
  refuses inside `task-actions.server.ts` right after its `requireAction` (F26-13).
- Project archive/restore is `edit-policy` (admin only) via `settings-actions.server.ts:964`,`:1008`;
  TASK archive/restore is `approve-transition` (`task-actions.server.ts:5809`). Audit actions
  `project.archived` / `project.unarchived` (`settings-actions.server.ts:978`) and
  `task.archived` / `task.unarchived` (`task-actions.server.ts:5891`).

### 1.6 Specialist cap + ALWAYS_HUMAN

`ALWAYS_HUMAN_CAPABILITY_IDS` (`app/shared/capabilities.ts:211`) = `merge-pull-request`,
`transition-to-done`, `change-project-policy`. `capabilityEnforcement(id)` (`:298`) checks
ALWAYS_HUMAN (`:302`) **before** the claude-only set (`:303`) and the both-backend set (`:304`), so
`merge-pull-request` is never mislabeled "advisory on Codex". Enforced on profile writes at
`agent-profile-actions.server.ts:265`,`:301`,`:353`,`:548` and displayed via
`agents-query.server.ts:364`.

**Specialist cap (R20-6 / F20-21).** `coerceSpecialistCapabilityMode` (`capabilities.ts:372`) maps
a specialist `recommend` **down to `off`**, never up to `direct`. Re-introducing a
`recommend → direct` widening is the F20-21 regression. Applied on both the write paths
(`agent-profile-actions.server.ts:298`,`:366`,`:550`) and the display read
(`agents-query.server.ts:347`), so stored = enforced = displayed.

Related gates: `GRANT_REQUIRED_CAPABILITY_IDS` (`capabilities.ts:403`) — capabilities where an
ABSENT grant means withheld (`execute-code-or-write-repo`, the three scoped delivery caps,
`merge-pull-request`, `report-validation-verdict`); everything else keeps its permissive default.
`applyVerdictOutcomeGate` (`:335`) — the three verdict-outcome caps are only as granted as
`report-validation-verdict`. `absentDeliverReviewPrMode` (`:625`) — R15-9, an absent
`deliver-review-pr` resolves from the project's workflow graph, not a constant.

**NEW — ruling 101 (repo-write parity, `decisions.md:1435`).** `execute-code-or-write-repo` was
REMOVED from `CLAUDE_ONLY_ENFORCED_CAPABILITY_IDS` (now just `create-task-branch`,
`commit-push-branch`, `open-review-pr`, `comment-on-task`, `read-github-api` — `capabilities.ts:281`)
and added to `ENFORCED_CAPABILITY_IDS` at `:259`. Note it was *already* in that set at `:228`
(see F32-J): the claude-only membership had been shadowing it, because `capabilityEnforcement`
tests claude-only (`:303`) before both-backend (`:304`). A withheld write family now binds on Codex too,
physically, via `resolveCodexSandboxMode`
(`app/server/runtimes/codex-runtime.server.ts:377`):

- `spec.kind === "operator"` → `read-only` (coordination machinery, matching Claude's operator denylist);
- `spec.repoWriteWithheld` → `read-only`, **except** when `spec.attachmentsWritableDir` is set
  (the evidence-granted carve-out) → `workspace-write`, never `danger-full-access`;
- otherwise `workspace-write`, and `danger-full-access` only for a fully-autonomous DELIVERING run
  with egress.

The scoped delivery commands stay claude-only at the tool layer — the sandbox is all-or-nothing
filesystem confinement, so it cannot deny `git push` for a run whose write family is granted
(`specialist-tool-policy.ts:20`–`:29`). On Codex their boundary is unchanged: agents hold no
credential and delivery is server-owned.

**Controller (rulings 99/106/107/108)** — see §7. It carries **no** capability matrix: its runtime
authority is the asking user's live authority, and its toolkit has no tool for merge, acceptance,
force-accept, packet resolution, or a move into the terminal stage.

---

## 2. Auth

### 2.1 better-auth setup

`app/lib/auth.server.ts` builds the instance. Contract: **better-auth owns credentials, sessions and
OAuth; the `users` table owns profile + authorization; both rows share the same id**
(`better-auth user.id === users.id`) — `app/server/auth/identity.server.ts`.

- Mount: `AUTH_BASE_PATH = "/api/auth"` at `app/shared/auth/auth-paths.ts:14` (a SHARED module so
  the Sign-in & SSO card can render `oauthCallbackUrl(origin, provider)` at `:22` without pulling a
  server-only file into the browser bundle). Handler route: `app/routes/api.auth.$.ts` (loader `:11`,
  action `:15`). `basePath` wired at `auth.server.ts:185`.
- Cookie: `viberr.session_token` (`advanced.cookiePrefix: "viberr"`, `auth.server.ts:366`), signed
  with `BETTER_AUTH_SECRET ?? VIBERR_SESSION_SECRET`.
- Sessions: `expiresIn` 30 days (`:291`), `updateAge` 1 day (`:292`) → **rolling**.
- Sign-up **disabled** (`emailAndPassword.disableSignUp: true`, `:190`) — identities are provisioned
  by the whitelist only.
- Password hooks are **total** (P11-01, `:192`): `password.hash`/`password.verify` route through
  `app/server/auth/password.server.ts`, so an unparseable legacy hash reads as a wrong password
  (401) instead of throwing "Invalid password hash" as a 500 on the splat.
  `isBetterAuthPasswordHash` (`identity.server.ts:126`) tests the `<saltHex>:<keyHex>` form.
- `betterAuth` is a process-wide singleton cached on `Symbol.for("viberr.betterAuth")`
  (`auth.server.ts:378`), keyed on **db handle + `oauthConfigFingerprint(db)`** (`:405`, R19-16) so
  a provider saved in the UI takes effect on the next request with no restart.

### 2.2 `/api/auth/*` splat allow-list (P11-02)

`ALLOWED_AUTH_PATHS` (`auth.server.ts:63`) — an **allow-list, not a deny-list**:

```
/sign-in/email   /sign-in/social   /callback/:id   /error   /get-session   /sign-out
```

Enforced in the `hooks.before` middleware (`:237` block, refusal at `:261`–`:262`): anything else
throws `APIError("NOT_FOUND")`. Entries are the endpoints' **declared** paths (params
un-substituted, hence the literal `/callback/:id`), and the list must cover server-side
`auth.api.*` calls too (`/get-session` for `require-user`, `/sign-out` for logout). Left open,
`/change-password` would bypass the app's audited, session-revoking flow and `/update-user` would
split-brain the canonical `users` row.

### 2.3 Session model + request guards

`app/server/auth/require-user.server.ts`:

- `authenticateWithHeaders(request)` (`:77`) — calls `getSession({ headers, returnHeaders: true })`
  and **captures the renewal `Set-Cookie`** (F10-17). Without `returnHeaders` the rolling slide
  reached the DB but never the browser. Only the root document loader uses this.
- `authenticate(request)` (`:114`) — drops the renewal headers. Used by the SSE route.
- `safeReturnTo` (`:121`) strips `\t\r\n` **before** validating, because the URL parser removes them
  before resolving — `"/\t/evil.example"` would otherwise reach the browser as `//evil.example`.
- `loginRedirect` (`:135`) normalizes the RR8 `.data` wire address and drops `_routes` so `returnTo`
  is never a `.data` URL.
- `requireAuth` (`:161`), `requireUser` (`:174`), `roleSatisfies` (`:187`), `requireRole` (`:208`),
  `requireRoleAuth` (`:222`).
- A **disabled or vanished user** has their better-auth session row deleted and is treated as
  signed out (`:88`).
- `AuthContext` carries `sessionId` (safe to log, keys the CSRF token) and `sessionToken`
  (logout only, never log).
- Forced password reset: while `users.pwreset_required` is set, `requireAuth` redirects everything
  to `/login` (`:167`–`:168`); `allowPendingPasswordReset` (`:157`) exempts the reset action itself
  and logout.

### 2.4 Login flows

**Local credentials** — `loginWithCredentials` at `app/server/auth/login.server.ts:63`. It keeps a
richer failure taxonomy than better-auth's generic sign-in: `unknown_email | no_password |
wrong_password | disabled | rate_limited` (`:25`–`:29`). Pre-checks `users` (`:101`–`:103`) and
**spends a rate-limit token for those** because they never reach better-auth's handler; then
delegates verification + session minting to `auth.handler(POST /api/auth/sign-in/email)` (`:127`).
Success forgives the bucket and records `auth.login.success`.

**Rate limiting.** better-auth's own limiter is switched **off** for `/sign-in/email` and
`/sign-in/social` (`customRules` at `auth.server.ts:209`) because it keys on client IP and Viberr
ships without a reverse proxy — every sign-in would share one `no-trusted-ip|/sign-in/email`
bucket, i.e. a denial-of-login lever. The authoritative buckets are in
`app/server/auth/rate-limit.server.ts`: `LOGIN_RATE_LIMIT` (`:137`) 10 / 15 min keyed `email|ip`,
`SOCIAL_START_RATE_LIMIT` (`:143`) 30 / min keyed `provider|ip`, `PAT_VALIDATION_RATE_LIMIT`
(`:158`) 10 / 5 min keyed on user id. The login throttle lives on the **hook**
(`auth.server.ts:268`,`:283`), not in `loginWithCredentials`, so a POST straight to the splat is
throttled too.

**Local-first when OAuth is off (R17-4, ruling 45).** `app/routes/login.tsx:412` derives
`ssoConfigured`; when neither provider is configured the provider buttons are **not rendered at
all** (`:451`) — the local form leads and SSO shrinks to a one-line footnote (`:567`). With at
least one provider configured, SSO-first stands (`:574`), including the D12 disabled button for
the other provider.

**OAuth configured in the app (R19-16, ruling 72).** `app/server/auth/oauth-providers.server.ts`:
the `oauth_providers` row **overrides the deployment env** — including when it is configured and
disabled. `enabled` requires a passing live test: `verified_at` is written only by
`recordOAuthVerification` (`:196`) and cleared the moment either credential changes
(`saveOAuthProvider:147` `keepVerdict`; `setOAuthProviderEnabled:242` refuses enabling an
unverified provider). `resolveOAuthProvider` (`:311`) fails **closed** when the secret is sealed
under a key this deployment no longer has (never silently falls back to the env identity).

**OAuth whitelist.** `app/server/auth/oauth-provision.server.ts`: `isOAuthWhitelisted`
(create.before) and `applyOAuthUser` (create.after), plus `linkOAuth` on account create; wired at
`auth.server.ts:324`–`:351`. Admission rules:

- Google + email domain in `google_domain_allowlist` → provisioned with the mapped role.
- GitHub + a live `@handle` placeholder row → claimed.
- An existing live `users` row (safety net for an unlinked legacy row).
- P13-D-22: the domain rule is **Google-only** and the provider is threaded explicitly via
  `oauthProviderOf(context)` (`auth.server.ts:101`), reading `params.id` off `/callback/:id`.
  Guessing the provider from the presence of a `githubHandle` is what let `@acme.com` admit GitHub
  accounts. `oauthProviderOf` returns null when unreadable and `isOAuthWhitelisted` **fails closed**
  on null.
- F28-A1: `accountLinking.trustedProviders: ["credential"]` only (`auth.server.ts:321`) —
  github/google are deliberately **untrusted**, because every viberr account is provisioned
  `emailVerified: 1`, which would moot the CVE-2026-53516 backstop.

**Env-admin bootstrap.** `seedInitialAdmin` at `app/server/auth/seed-admin.server.ts:37` runs at
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
2. **Double-submit token** — `csrfTokenForSession(sessionId, secret)` (`:25`) =
   `HMAC-SHA256(VIBERR_SESSION_SECRET, "viberr-csrf:" + sessionId)` base64url. Injected as the hidden
   field `_csrf` (`CSRF_FIELD_NAME`, `:18`) by `<CsrfInput />` (`app/ui/csrf-input.tsx`, fed by the
   root loader). Also accepted as the `X-Csrf-Token` header. Compared with `timingSafeEqual` (`:124`).

`assertCsrf(request, sessionId, formData?)` (`:134`, over `assertCsrfWithSecret` `:102`) is the
guard for every authenticated mutating action; the standard entry point is
`requireFormAction(request)` at `app/server/auth/form-action.server.ts:7`, which returns
`{auth, db, formData, actor, intent}`. Two fetcher-only routes use the NON-throwing `csrfError`
variant instead, because a thrown 403 Response from a fetcher renders the root error boundary and
blanks the app (UI-32): `app/routes/notifications.read.tsx:31` and `app/routes/prefs.theme.tsx:26`.
The login action has no session yet, so it uses `assertTrustedOrigin` + rate limiting only
(`login.tsx:68`), then `assertCsrf` once a session exists on the password-reset arm (`:131`).
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
`openSecretRotating(box, key?, previous?)` (`:88`) returns `{plaintext, staleKey}`; a
`staleKey: true` read obliges the caller to **re-seal in place**, so the store converges with no
migration. Callers that do: `getPatToken` (`pat-store.server.ts:222`), `readOAuthSecret`
(`oauth-providers.server.ts:112`, plus `:188`), `getS3AuditConfigForUse`
(`s3-config.server.ts:76`, F26-8 — `openSecret` alone bricked the S3 secret after a rotation), and
the MCP credential readers (`org/resources.server.ts:718`,`:784`).

`app/server/secrets/key-rotation.server.ts` finishes the job. `SEALED_STORES` (`:43`) is the
registry of every table holding a sealed box — **an unregistered sealed secret silently outlives a
rotation**; `key-rotation.server.test.ts` fails if a third `sealSecret(` home appears:

| store id | table | column | name col | id col |
| --- | --- | --- | --- | --- |
| `github_pats` | `github_pats` | `encrypted_token` | `label` | `id` |
| `org_mcp_servers` | `org_mcp_servers` | `cred_ref` | `name` | `id` |
| `oauth_providers` | `oauth_providers` | `client_secret` | `provider` | `provider` |
| `s3_audit_config` | `s3_audit_config` | `secret_box` | `bucket` | `id` |

`secretKeyRotationStatus(db)` (`:195`) counts by `SecretKeyState` (`current | stale | unreadable |
not_sealed`) and reports `converged` (safe to drop the retired key). `resealSecrets(db, {dryRun})`
(`:283`) writes and records `secrets.resealed`. CLI: `npm run keys -- reseal`.

### 3.2 PAT storage

`app/server/secrets/pat-store.server.ts`. Table `github_pats`; only `getPatToken` (`:208`) decrypts,
and it is SERVER-INTERNAL — never into loader data, logs, timelines or errors. Metadata readers
return `tokenSuffix` (last 4) and `masked = "····<suffix>"` only.

**Scopes.** `DEFAULT_REQUIRED_SCOPES = ["repo", "pull_request:write"]` (`:38`; ruling 18,
2026-07-25). The mock-era `workflow` and `read:org` are **gone**: nothing reads org data, and a
workflow-file push that GitHub refuses surfaces as a scope violation with GitHub's own message.
`CONNECTION_REQUIRED_SCOPES` at `app/server/org/connections.server.ts:61` is an **alias** of the
same tuple (B-GH6: two identical `as const` tuples made "the minimum" a one-edit mistake).

**Token shape check.** `createPat` (`:97`) / `replacePatToken` (`:153`) refuse `length < 8` or any
whitespace: `"That doesn't look like a GitHub token."`

**Validation honesty (`pat-validator.server.ts`).** Classic tokens (`ghp_…`) expose
`x-oauth-scopes` → `source: "header"` (authoritative). Fine-grained tokens have no introspection:
`GET /repos/{r}` returns a `permissions` block computed for the authenticated token, so repo write
is proven **read-only** (A8/pass-16). `pull_request:write` has no read-only signal and stays
`assumed` unless the operator opts into `VIBERR_GITHUB_WRITE_PROBE=1`, the empty-payload dry run
(**422 = authorized, 403 = refused**, ruling 18) — health checks do not write.
`markWriteScopeProven(db, patId)` (`pat-store.server.ts:270`) flips `assumed → probe` after a REAL
solicited write, and takes the `patId` **that actually made the call** (F28-U2b), not the project's
currently-bound credential. Call sites: `pr-open.server.ts:529`,`:578`;
`github-reconciler.server.ts:1341`.

**Chips (ruling 19).** `ScopeChipSource = header | probe | assumed | violation | unchecked`.
`getProjectCredentialHealth` (`:439`) overlays open violations (forcing not-ok + `flaggedTaskKey`).
With no bound PAT the health is `{configured: false, source: "none"}` **always** — a project's
`credentialPolicy` is display/requirements only, never a credential (the seeded-demo-lie fix).

**Bindings.** `project_github_credentials` (one PAT per project): `setProjectCredential` /
`clearProjectCredential` / `getProjectCredential`. Org-level connections
(`app/server/org/connections.server.ts`) validate **before** writing — on replace the old token
stays active unless validation passes (refusal copy at `:338`).

### 3.3 Scrubbing rules

`app/server/secrets/git-output-redact.server.ts` (ruling 69 / R19-13). Git's own failure text IS
surfaced to humans, redacted, at one choke point. `redactGitOutput(text, {token})` (`:79`) runs
three layers strongest-first:

1. **By value** — `out.split(opts.token).join("[redacted]")`. **F20-7: at ANY length.** The old
   `>= 8` floor let a 5-char `MCP_CREDENTIAL` ride into an MCP row error, a toast and the persisted
   `last_error`. The by-value pass is exact — it only removes the string the caller handed us — so
   a shorter value has nothing extra to mangle. The empty-string case is still guarded (a split on
   `""` would insert `[redacted]` between every character).
2. **URL userinfo** — `scheme://user:secret@host` → `scheme://[redacted]@host`, run *after* layer 1
   so `x-access-token:[redacted]@host` also loses the username half.
3. **Token patterns** — `TOKEN_PATTERN_SOURCE` (`:43`, applied at `:104`): `gh[pousr]_[A-Za-z0-9]{16,}`,
   `github_pat_[A-Za-z0-9_]{20,}`, `sk-[A-Za-z0-9_-]{16,}`. Anchored prefixes + a length floor
   deliberately, **not** an entropy heuristic — mangling git's diagnosis is worse than the leak this
   backstops. `createLineRedactor` in `run-sink.server` keeps an identical list and must stay in step.

Then ANSI CSI + C0 control stripping, split on `\r|\n|\r\n` (a bare CR is a line — git rewrites
transfer progress in place), keep the LAST 8 lines, clamp to 600 chars **from the end**.
`redactProviderText(cause, token)` (`:142`) layers on top for Claude/Codex failures: walks `cause`
three levels, keeps the last non-empty line, clamps to `PROVIDER_TEXT_CHARS = 240` (`:141`, ruling
78 / R20-3). `gitErrorText(cause)` (`:179`) decodes `stderr` and `message` **separately** so a
Buffer `stderr` still falls through to the message.

The premise that makes this safe: the PAT travels only through the `GIT_ASKPASS` helper's
environment (`app/server/tasks/git-clone-auth.server.ts`); argv and `remote.origin.url` carry the
credential-free `https://github.com/<owner>/<repo>.git`. **Changed this pass (C3):**
`CLONE_TIMEOUT_MS` became the lazy function `cloneTimeoutMs()` (`git-clone-auth.server.ts:200`)
reading through the validated env schema; `repo-mirror.server.ts:199` follows with
`mirrorTimeoutMs()`. A module-scope `getEnv()` on the clone path would throw at import time on an
invalid env and freeze the value against `resetEnvCacheForTests`.

### 3.4 S3-style secret table

`app/server/audit/s3-config.server.ts` — table `s3_audit_config`, at most one row (`id = 'default'`).
The secret access key is sealed in its **own dedicated `secret_box` column, not a JSON blob**,
precisely so `SEALED_STORES` can rescan and reseal it. Views: `getS3AuditConfigView` (`:52`, never
the key, just `hasSecret`), `getS3AuditConfigForUse` (`:67`, decrypted, rotating + lazy re-seal),
`setS3AuditConfig` (`:116`, blank secret keeps the existing seal), `clearS3AuditConfig` (`:162`).
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
a wiped instance's VIB-4 work. That single fact drives R15-15, R16-1, R18-4 **and now F31-6/ruling
101's sibling, the `resolve_remote_collision` verb**. Legacy names still resolve: the private
`isTaskBranchName(name, taskKey)` at `push-workspace.server.ts:323` accepts `vib-1` **or**
`vib-1-<anything>`.

Two creators:

1. **Remote-first** — `ensureTaskBranch(db, {projectSlug, taskKey}, actor, ctx)`
   (`branch-sync.server.ts:250`). `GET git/ref/heads/<branch>`; on 404 resolves the default-branch
   head (`ghRefSchema` is *strict* on `object.sha` — never create a branch from nothing) and
   `POST git/refs`. Idempotent (existing ref → `created:false`; 422 `/already exists/i` → success).
   403 → `flagScopeViolation(scope: "repo")` (`:346`,`:374`). Audits `github.branch.created`.
   Called best-effort by `ensureTaskBranchBestEffort` (`operator-actions.server.ts:2117`, invoked
   at `:2347`).
2. **Workspace-first** — the delivering specialist runs `git checkout -B <branch>` in its clone;
   the branch is discovered and written back by `reconcileWorkspaceDelivery`.

Also in `branch-sync.server.ts`: `getBranchCompare` (`:112`), `taskCommits` (`:194`),
`deriveSyncState` (`:205`). **DG-3 rate-limit split** — `isRateLimited = rateLimit.remaining === 0 ||
/rate limit/i` — so a transient 403 blip never auto-opens a bogus `repo` scope violation.

### 4.2 Agent work — per-engagement workspace isolation (P8, pass 25)

`app/server/tasks/specialist-run.server.ts`:

- `taskWorkspaceRoot(slug, key, dataRoot)` (`:2649`) = `<taskDir>/workspace`; `taskCloneDir`
  (`:2663`) → `supportCheckoutDir` (`:2691`). `taskDir` is
  `app/server/files/file-store-root.server.ts` (`projects/<slug>/tasks/<KEY>/`).
- **Delivering** engagement owns the canonical checkout `<workspaceRoot>/<repo>` — the tree
  `git add -A` ships, the operator reads, and evidence paths resolve against.
- **Every supporting (non-delivering) engagement** gets its own checkout at
  `<workspaceRoot>/support/<profileId>/<repo>`.
- Why it still matters after ruling 101: a write-GRANTED supporting run is now free to edit files on
  both backends by design; isolation is what stops those writes riding `git add -A` into the
  delivered PR (the F-P8 governance hole).
- Keyed by the engagement's **`profileId`** — there is no `engagementId` anywhere in the repo.
- Threaded as `const support = delivers ? undefined : { profileId }` at `:1492` (fresh run) and
  `:2757` (`resolveResumeConfinement`, defined `:2732`); resume path `resumeWorkdir(...)` at
  `app/server/tasks/agent-reply.server.ts:663`. Even a checkout-less run stays isolated:
  `runWorkdir = clone?.dir ?? (realBackend ? supportRoot : null)` (`:1526`).
- A supporting clone is `git clone --local <deliveringDir>` (`:3117`) so it actually carries the
  delivering agent's LOCAL task branch; origin is then re-pointed at GitHub. No delivering checkout
  yet → a normal mirror clone of the default branch.
- Prompt fence for supporting runs (`:2480`): "this workspace is your OWN isolated checkout —
  nothing you write here reaches the delivered PR."
- **Concurrency (P8 Finding-2, `:1286`–`:1295`):** because `cloneRepo` destructively re-clones a
  support dir, two overlapping runs of the SAME supporting engagement are refused 409
  (`liveSameEngagement`); different supporting profileIds still run concurrently. A live delivering
  run is refused separately.
- Path rewriting (`agent-reply.server.ts:493` `WORKSPACE_ABS_PATH_RE`, applied `:505`) skips the
  optional `support/<profileId>/` group so a reviewer's echoed path collapses to the repo-relative
  form.
- **Retention:** `reclaimTerminalTaskWorkspaces(db, {dataRoot})` at
  `app/server/tasks/workspace-retention.server.ts:85` removes `<taskDir>/workspace` (support
  subtrees included) once the task reaches the terminal stage; called at boot after run recovery
  (`app/server/boot.server.ts:418`,`:461`).
- Clones go through a per-project mirror cache: `cloneWorkspaceRepo` / `projectRepoMirrorDir` in
  `app/server/tasks/repo-mirror.server.ts` (R21-4, ruling 87). `cloneRepo` (`:3057`) stamps
  `agentGitIdentity(profileId)` (F24) and sanitizes the origin URL so **no PAT is ever in
  `remote.origin.url`**.

**Single-writer invariant.** At most ONE engagement carries `delivers: true`
(`engagementSchema` at `app/schemas/task-file.schema.ts:194`; the parser coerces extras).
`deliveringEngagement(fm)` is the accessor.

**`pinnedBackend` (F27-B1, owner ruling 2026-08-24).** Declared on both `engagementSchema:215` and
`agentRefSchema:181` (`"codex" | "claude" | null`, optional). A `retry_other_backend` recovery sets
it (`specialist-run.server.ts:1949`), and later runs of THAT engagement resolve to it **over** the
live profile primary. Full resolution order:
`backendOverride ?? pinnedBackend ?? live deployment ?? snapshot`
(`specialist-run.server.ts:1326`, `agent-reply.server.ts:348`,
`app/server/projections/agent-deployments.server.ts`). This composes with ruling 97 (the
live-backend display law): `withLiveAgentBackends` (`app/shared/mapping/task.server.ts:415`)
overlays the live `profileId → backend` map onto the task snapshot, but `:423` returns the agent
unchanged when `pinnedBackend` is set — the pin wins on display too.

### 4.3 Delivery decision (R15-2, ruling 21)

Push + review-PR opening is **not** a stage side-effect. The operator holds the `deliver-review-pr`
capability and decides when delivery is plausible; the SERVER executes the mechanics; specialists
never push or open PRs. Human escape hatch: `manualDeliverForReview`
(`task-actions.server.ts:5319`) — the task **owner** (via `ownerException` at `:5328`, archived
freeze still applies at `:5331`) or `run-agents` (maintainer+, `:5333`). Audit
`github.delivery.manual`; the operator path audits `github.delivery.operator`.

The absent-grant polarity for `deliver-review-pr`, `dispatch-agents`, `update-task-branch` and
`use-web-search-fetch` is now centralized in `absentPolarityGate` **inside `gate()` itself**
(`operator-actions.server.ts:470`–`:517`, consulted at `:503`), so every consumer resolves the same
answer; `deliverGate` (`:523`) survives as the documented front (and to break the
`update-task-branch → deliverGate` recursion). Full autonomy promotes `recommend → direct` for
every capability **except** `completion-for-acceptance` (`:513`, owner ruling Q1; the catalog entry
at `capabilities.ts:64` carries `promotable: false`).

### 4.4 Push — `pushWorkspaceBranch`

`app/server/github/push-workspace.server.ts:474` (F-GH3). Runs at the review boundary, **before** the
PR is opened. `PUSH_TIMEOUT_MS = 120_000` (`:112`). Never throws — every failure is a typed value.
`PushWorkspaceResult` (`:63`): `pushed | push_conflict | push_failed | no_branch | no_pat | no_repo |
no_workspace | no_commits | grant_withheld | task_not_found`.

Order (load-bearing):

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
5. `countCommitsAhead` (`:257`) — `0` → `no_commits` with re-read evidence; `null` (unknown) still pushes.
6. PAT → `createGitHubAskpassEnv({token})`; `git push origin HEAD:refs/heads/<branch>`;
   `askpass.dispose()` in `finally`.
7. `isNonFastForwardStderr(stderr)` (`:236`) → `push_conflict`; otherwise `push_failed` carrying both
   `detail` and `stderrExcerpt`, scrubbed by `redactGitOutput(stderr, {token})`.

`DefaultBranchEvidence` (`:59`, `readDefaultBranchEvidence` at `:336`) is the R19-8 honesty half:
`verified: true` only after **three** read-only probes agree — `git status --porcelain` clean, no
local task branch via `for-each-ref`, and no commits ahead of the default branch
(`commitsAheadOfDefault` `:310`). `no_branch` covers both "a verification-only task correctly
changed nothing" and "a developer edited files and forgot `git checkout -B`"; only the first may
become a no-change completion. Every unknown is `verified: false` with its own `why`.

`discardLocalTaskBranch` (`:790`, `DiscardBranchOutcome` `:769`) executes the `discard_branch`
packet option — see §4.10.

`app/server/github/workspace-delivery.server.ts:231` (`reconcileWorkspaceDelivery`) covers the
`gh`-CLI-shaped agent-side delivery path with an injectable `CommandExec` (`:68`): `git log --oneline
origin/<default>..HEAD` for commits, mints/refreshes `workRevision` via `nextWorkRevision(...)`
(`:392`) using the full `HEAD` and `HEAD^{tree}` shas — **only when `hasDeliveredWork`** (P11-72) —
and detects the PR with `gh pr view <branch> --json number,state,title,headRefOid`
(`mapGhStateToCache` at `:170`). Audits `github.workspace.branch_reconciled` and
`github.workspace.pr_linked`. Never throws. Its adoption refusal writes the shared collision note
at `:530`.

### 4.4b `performDelivery` — the delivery packet

`app/server/tasks/task-actions.server.ts:4860`. `DeliveryOutcome` (`:4829`):
`delivered | push_conflict | grant_withheld | push_failed | nothing_to_review | failed`.

- `resolveDeliveryPushGrant` → `pushWorkspaceBranch` → branch on the status.
- **`push_conflict` opens NO PR** — it would review the stale remote content instead of the delivery
  (the live F15-15 failure). Regression-locked this pass by a real non-fast-forward push test.
- `push_failed` surfaces the untruncated git block as a fenced timeline section
  `"What the push reported:"` (ruling 69).
- **A3 no-change reclassification:**
  `verifiedNoChange = push.defaultBranchEvidence?.verified === true && (status === "no_commits" ||
  (status === "no_branch" && neverDelivered))` → mints a base-anchored `workRevision`, sets
  `fm.noChanges = true`, recomputes `fm.validation`, returns `nothing_to_review`. `no_workspace` is
  deliberately excluded.
- **NEW (F31-6):** `branch_collision` from `openTaskPr` is surfaced as
  `surfaceDeliveryEvent("Delivery blocked by a branch collision")` and returns `failed`
  (`:5230`–`:5238`).
- On `pushed`: best-effort `reconcileWorkspaceDelivery` (P11-10), then `openTaskPr`.
- On `ok`: clears a stale `fm.noChanges`, `withdrawSupersededDeliveryPacket` (`:2485`, called
  `:5162`), then `autoInvokeOperator(..., "delivered")` at full autonomy (`:5200`) or
  `recordDeliveredNextStep` when supervised (`:5216`, R19-4; audit constant
  `DELIVERY_NEXT_STEP_AUDIT_ACTION = "github.delivery.next_step"` at `:5414`).

### 4.5 PR creation / adoption / collision

`openTaskPr(db, {projectSlug, taskKey}, actor, ctx)` — `app/server/github/pr-open.server.ts:323`.
`OpenTaskPrResult` (`:218`): `ok | <GithubContextFailure> | task_not_found | no_branch |
branch_collision | scope_violation | auth_failed | nothing_to_review | network_unavailable`.
Idempotent twice over (NFR16). Step order:

0. **Cached live PR.** A non-terminal `fm.pr` is re-read from GitHub; reused only if genuinely open
   (`writePrToTask(..., created:false)` at `:372`). A **terminal** cached PR (closed unmerged OR
   merged) clears the way for a fresh one — DG-1 merged-PR-reuse. The terminal PR is deliberately
   NOT reconciled into the cache here.
1. **Head dedup / adoption** — `prAlreadyOnHead` (`:411`, invoked `:466`),
   `GET /pulls?head=<owner>:<branch>&state=open`. `null` — and only `null` — clears the way to
   create; "another PR is on this head" and "we could not find out" both forbid a second attempt
   (a `decode` failure is `network_unavailable`, F21-9). The refusal writes the shared collision
   sentence at `:434`.
2. **Body** — `deliveredDiffStats` (`:148`, a live `GET /compare/base...head`) beats the cached
   `fm.github.changed`/`commits` (F22-10); fallback `latestEvidenceLines` (`:96`).
   `deliveredStatsToPrParts` (`:185`) now returns the named `DeliveredPrParts` (`:179`).
   `composePrBody` (`:43`) emits the task deep-link, `## Goal`, `## Change summary`, `## Evidence`,
   and closes with *"Review and merge are human-authorized."*
3. **Create** `POST /pulls` with `title: "[<taskKey>] <title>"`. On success → `writePrToTask(...,
   created: true)` (`:524`) then `markWriteScopeProven(db, gh.patId)` (`:529`).
   - **422 disambiguation** (`ghValidationBodySchema`, `:305`; read at `:624`): `/no commits between/i`
     → `nothing_to_review`; `/already exists/i` → re-run `prAlreadyOnHead()` (`:641`, the race);
     anything else → `network_unavailable` with the joined `errors[].message`.
   - **403** → `flagScopeViolation(scope: "pull_request:write")` (`:600`), never a throw.
   - **F21-9 salvage:** a `decode` failure on the CREATE response is re-parsed with
     `ghCreatedPrSalvageSchema` (`:290`, only `number` required, applied `:544`) so the PR is still
     recorded (`:565`, `markWriteScopeProven` `:578`).

`writePrToTask` (`:652`) preserves `checks`/`review` on the SAME PR (P13-D-28), applies the **H1
guard** (never downgrade `accepted`/`merged` to `review`), and audits `github.pr.opened` **only when
`created`** (B-GH4) — a reuse pass writes no audit row.

**R15-15 (ruling 34): a task owns a PR only if that task opened it.** `openTaskPr` is the sole writer
that establishes the link; the reconciler keeps an owned link honest, never mints one.

**R16-1 (ruling 35): adoption requires OPEN *and* head sha == the delivered revision.** Identity, not
containment. `app/server/github/pr-adoption.server.ts`:
`decidePrAdoption({state, prHeadSha, revisionHeadSha}) → PrAdoptionDecision` (`:52`, decision type
`:48`); adopt requires `state === "review"` **and** `prHeadSha === revisionHeadSha`.
**`PrAdoptionRefusal` in the CODE is `merged | closed | no_revision | head_unknown | head_mismatch`**
(`:32`) — the code split ruling 35's `not_open` into `merged` vs `closed` (F17-L4) because their
hazards differ. `prAdoptionRefusalNote(...)` (`:104`) is the ONE branch-collision sentence, shared by
all three refusing sites: `pr-open.server.ts:434` (blocks delivery),
`github-reconciler.server.ts:602` (writes the note once), `workspace-delivery.server.ts:530`.

**CHANGED this pass — the note now names the remedy verb.** `prAdoptionRefusalNote`
(`pr-adoption.server.ts:112`–`:119`) used to say "Delete or rename the remote branch"; it now says
*"Resolve it with a `resolve_remote_collision` decision (closes the unrelated PR, deletes the stale
remote branch, and re-delivers this task's work), or give this task a different branch, before
delivering."*

**R18-4 (ruling 50) as amended by F31-6.** A stale remote task branch still forces a human-gated
packet before delivery — the rejected fix remains "always force-reset the remote task branch to
base". What changed is that the remedy is now a first-class packet verb rather than manual GitHub
work. `operatorDeliverForReview` (`operator-actions.server.ts:2405`) turns a `push_conflict` into a
tool result (`:2483`–`:2494`) instructing the operator to open a packet with a
`resolve_remote_collision` option, and explicitly forbidding `discard_branch` there.
`withdrawSupersededDeliveryPacket` (`task-actions.server.ts:2485`) scopes on
`type === "blocked" && !options.some(accept_completion) && options.some(discard_branch ||
resolve_remote_collision)` (`:2493`–`:2500`; the second kind was the V10 fix) and deliberately
leaves `archive_task` reject-recovery packets alone. Audit
`task.packet.withdrawn_superseded` with `{reason: "delivery_succeeded"}`.

**Authoring coherence (F31-6, `operator-actions.server.ts:1033`–`:1047`).** `operatorOpenPacket`
REFUSES a `discard_branch` option on a task that has a delivered `workRevision` or whose branch name
is occupied (`fm.pr !== null || fm.github?.unownedPr != null`), and names
`resolve_remote_collision` instead — live-caught: an operator authored "delete the conflicting
REMOTE branch and push this task's commit fresh" onto the LOCAL-discard kind.

**Linking** — `findPrForBranch(client, repo, branch)` (`pr-linker.server.ts:373`) takes the newest of
`GET /pulls?head=<owner>:<branch>&state=all&per_page=5`, then a detail read. **F26 stale-terminal
guard:** a `closed` PR whose branch head has moved past it returns `{status:"none"}` so `openTaskPr`
opens a fresh PR; an unreadable branch fails safe. `summarizeCheckRuns` (`:249`, F21-7) distinguishes
pending (`null` conclusion) from **unknown**. `deriveReviewState` (`:298`) takes the latest per
reviewer and never lets `COMMENTED`/`PENDING` replace a standing verdict; `changes_requested`
outranks `approved`. `deriveApprovals` (`:330`), `deriveMergeable` (`:358`).
**Absent-key contract:** `review`, `approvals` and `mergeable` are set only when actually read —
absent means UNKNOWN, so the reconciler keeps the cached value.

### 4.5b NEW — `resolve_remote_collision`, the collision remedy verb (F31-6)

Eleventh packet-option kind. Declared at `app/schemas/task-file.schema.ts:163` (its doc block opens at `:155`) inside
`PACKET_OPTION_KINDS` (`:129`, now 11 kinds).

**Server mechanics.** `resolveRemoteBranchCollision(db, input, actor, ctx)` at
`app/server/github/github-reconciler.server.ts:1580`; result type `RemoteCollisionResult` (`:1564`)
= `{status:"cleared", branch, closedUnownedPr}` | `{status:"refused", message}`. Steps:

1. Read the task file; no `fm.branch` → refused (`:1590`).
2. Read `fm.github.unownedPr` (`:1592`). Resolve the GitHub context; not ok → refused (`:1595`).
3. **Close the recorded unowned PR** — `PATCH /repos/<repo>/pulls/<n>` with `{state:"closed"}`
   (`:1604`). Best-effort by design: only a SUCCESS is recorded. On success it appends a `github`
   timeline event and records the NEW audit action **`github.pr.closed_unowned`**
   (`:1615` event, `:1625` action, `subjectId: "<repo>#<n>"`).
4. **Delete the stale REMOTE branch** through the audited `deleteTaskRemoteBranch` (`:1636`) — all
   of its refusals still bind (never the default branch, never a branch with this task's own open PR,
   never without a `userId`).
5. On `deleted`/`already_gone`: clear `fm.github.unownedPr` (`:1641`–`:1645`) and reproject; return
   `cleared` (`:1647`). Every other outcome returns `refused` (`:1650`, `:1653`, `:1658`).

**Resolution path + authority.** The packet case is at `task-actions.server.ts:6438`; the inner tier
re-check is `requireAction(..., "approve-transition", "resolve this task's branch collision")`
(`:6443`) — the same tier `archive_task` and `discard_branch` take, because it deletes a remote ref.
The kind is in `NO_REQUEUE` (`:6574`, "the re-delivery's own machinery owns the follow-up").
The three-step remedy runs AFTER the resolution write (`:6846`–`:6907`), guarded by
`actor.userId`:

- `cleared` → `manualDeliverForReview(db, …, actor, ctx)` (`:6867`); a non-`delivered` result writes
  a plain-words policy-engine note.
- `refused` → note: *"The branch collision was **not** cleared: …  Nothing was re-delivered."*
- **Readiness lift (V11):** a successful re-delivery flips `readiness: blocked → ready` (`:6890`),
  because the push-conflict packet held it down and nothing in the delivery path writes readiness.
  `waiting` stays `"human"` — acceptance is still verdict-gated.

**Client ceremony.** `PacketCollisionConfirm` (`app/features/task-detail/decision-packet.tsx:431`)
spells out what is deleted/kept/closed, naming the unowned PR number when there is one (`:478`).
It shares `PacketDestructiveConfirm` (`:140`) with the archive and discard ceremonies (V15). The
disclosure type `PacketArchiveDisclosure` carries a **required** `unownedPr: number | null` (`:125`)
— V1 made it required precisely because the one production producer
(`task-detail-page.tsx:738`) had silently omitted the optional field, so the "closes PR #N" clause
was unreachable outside tests. `CONFIRM_FIRST_KINDS` (`:608`) = `archive_task`, `discard_branch`,
`resolve_remote_collision`.

**One tier table (V16).** `PACKET_TIER_GATES` (`decision-packet.tsx:536`) maps each gated kind to
`{held, denyNote, option}` and is consulted from all six sites (selected-option refusal, refusal
sentence, every-option-above-tier scan, per-option inert flag, hover title, description suffix).
`resolve_remote_collision` (`:584`) uses `grants.canDiscardBranch`, which the task page derives as
`roleCan(role, "approve-transition")` (`task-detail-page.tsx:292`, passed at `:727`) — display and
server agree.

### 4.5c NEW — reconciler provenance is POSITIVE evidence (F31-1 / V5)

`github-reconciler.server.ts:444`–`:592`. The reconciler used to record the name-matched PR's
`changed` stats and the branch compare's prefix-filtered commits regardless of OWNERSHIP, so a fresh
task whose branch name collided with a wiped instance's branch showed the stranger's diff
(live: 14 files, +313/−30) and its completion evidence claimed commits it never made.

- `sameAsCached` / `adoption` / `ownsAPr` / `unownedPr` at `:434`–`:444`.
- `deliveredThisBranch = ownsAPr || fm.pr !== null || fm.workRevision?.branch === branch` (`:558`).
- `provenBranchHead = deliveredThisBranch && !unownedPr` (`:563`).
- Compare-derived commits are taken **only** under `provenBranchHead` (`:566`); an empty filtered
  list still does not wipe a non-empty honestly-captured workspace cache (`:569`).
- `ownedChanged = pr && ownsAPr ? pr.changed : undefined` (`:572`) — **owned-only stats**.
- `cachedCommits` / `cachedChanged` fall back to `[]`/`null` when `!deliveredThisBranch` (`:576`,
  `:577`) — an unproven cache is DROPPED rather than carried forward forever.
- V5's sharpening: the test is positive evidence, not the absence of an unowned PR — a stale remote
  branch carrying foreign `[KEY]`-prefixed commits and NO PR passed the old absence test.
- `unownedPr` is persisted into `GithubCache` (`task-file.schema.ts:473`) so the collision note fires
  once (`unownedPrIsNew`, `:594`; written `:728`–`:734`) rather than on every ~288 daily ticks, and
  so the number is visible. It surfaces as a Collision row on the task's GitHub card
  (`app/features/task-detail/task-side-panels.tsx:295`) and through `TaskSummary.unownedPr`
  (`app/shared/mapping/task.server.ts:222`, mapped `:641`), the operator snapshot
  (`operator-actions.server.ts:1475`, filled `:1852`) and the packet ceremony.

### 4.6 Review — revision-bound

`app/schemas/task-file.schema.ts`:

- `workRevisionSchema` (`:548`) — `{id, headSha, treeSha, branch, createdAt, sourceProfileId, kind}`.
  `kind: "delivered" | "verified"`; **absent reads as `delivered`** (pre-pass-19 files), so read it as
  `=== "verified"`, never `!== "delivered"`.
- `nextWorkRevision(current, …)` (`:934`) returns `{revision, changed}`; `changed: false` keeps every
  prior verdict valid.
- `reviewVerdictSchema` (`:578`) — `{profileId, revisionId, headSha, result, reason, at}`;
  `REVIEW_VERDICT_RESULTS = ["approve","request_changes"]`. A verdict binds to `revisionId`, so a new
  revision **automatically staleness-invalidates** every prior verdict (F10-32).
- `verdictCapable: boolean` on the engagement (`:206`) — an **engage-time snapshot** of whether the
  profile held an explicit `report-validation-verdict: direct` grant. **Engage-time is authoritative.**
- `requiredReviewers(fm)` (`:729`) = supporting engagements with `verdictCapable`.
- `currentVerdicts(fm)` (`:734`) = verdicts whose `revisionId` matches the current revision.
- `deriveValidation(fm)` (`:747`) → `failing | healthy | changed | none | bypassed`. Arm order is
  load-bearing: real verdicts win first; `acceptance === "forced"` yields `bypassed` (`:795`); the
  R19-8 no-change arm only fires with `required.length === 0`.
- `acceptanceBlockedReason(fm)` (`:811`) — the gate.
- `ReviewState.acceptance` (`:724`) and the frontmatter field (`:684`).

**The only three engagement writers** (`app/server/tasks/specialist-run.server.ts`):
`assignSpecialist` (`:673` — writes `delivers: true`, `verdictCapable`, and carries `pinnedBackend`
across the row rebuild, `:751`), `assignReviewer` (`:848` — snapshots `verdictCapable` **once**; the
`alreadyEngaged` arm returns the **stored** snapshot, not a fresh resolve), `removeReviewer` (`:980`).
All three recompute `deriveValidation` in the same lock. The tolerant parser `parseEngagements`
dedupes `profileId` and **demotes** extra `delivers: true` rows.

**Where `verdictCapable` comes from.** `resolveAgentCollab(grants).verdict` at
`app/server/tasks/agent-outcome.server.ts:407` (`:414`) = `effectiveCollabMode(grants,
"report-validation-verdict") === "direct"`. `effectiveCollabMode` (`:381`) honors an explicit
`direct|human|off`; **`recommend` is NOT authoritative** and falls to the catalog default (`off`) —
the R7-5 coercion hazard. Verdict *recording* reads the same source with a legacy fallback
(`task-actions.server.ts:3259`–`:3265`): `verdictEngagement ? verdictEngagement.verdictCapable ===
true : collab.verdict`.

**Verdict extraction from prose:** `classifyReviewerVerdict(text)` (`task-actions.server.ts:2551`,
called `:3404`) → `approve | request_changes | null`. Three tiers: an explicit `Verdict:` line wins,
then strong request-changes phrases, then weak negatives only when not locally negated. Verdicts are
written last-write-wins per `(profileId, revisionId)`, `reason` clamped to 2000 chars.

**Revision minting — exactly two producers.** `nextWorkRevision` (schema `:934`), whose only caller is
`workspace-delivery.server.ts:392`, uses `treeSha` when both sides have one (else `headSha`) as the
identity. And the R19-8 verification mint inside `recordAgentCompletion` (`task-actions.server.ts`),
whose preconditions are narrow and re-checked **inside the write lock**.

`app/features/review/review-acceptance-authority.server.ts` and `review-helpers.ts` carry the
surface-side derivation; `app/shared/acceptance-disclosure.ts` owns the disclosure contract.

**Agent-question packet kind (C9).** `AGENT_QUESTION_PACKET_KIND = "Agent question"` is now a named
constant at `agent-outcome.server.ts:434` (stamped `:463`, imported at `task-actions.server.ts:63` and read by `resolvePacket` at `:6595`). `TaskPacket.kind` is free display text, but THIS value routes the
human's answer back to the asking agent; it used to be a duplicated English literal.

### 4.7 Verdict-gated acceptance

**R15-1 (ruling 20).** Human acceptance requires a healthy reviewer verdict on the delivered
revision. Force-accept is the only bypass, and it never bypasses the PR-head-must-contain-the-
delivered-commit check. Every accept — force included — shows a confirm dialog stating what merges
and any missing signals.

**The full refusal stack** — `acceptanceRefusalReason(project, fm, taskKey, {blockedPacket, noChange})`
at `task-actions.server.ts:7125`, first non-null wins:
`archivedTaskBlockedReason` (`:7135`, R14-3) → `closedPrBlockedReason` (`:7144`, R16-3, terminal
GitHub fact) → `acceptanceStageBlockedReason` (`:7145`; defined `:7089`, workflow-graph boundary) →
`acceptanceBlockedReason(fm)` (`:7147`, required reviewers) → `noChangeWorkRefusal` (`:7153`,
R20-2/F20-6, the live probe found commits) → `verdictGateReason(...)` (`:7159`, R15-1) → open
blocked packet (`:7170`) → `conflictingPrBlockedReason` (`:7176`, P14-LV-07).
Public read wrappers: `acceptanceRefusalFor` (`:7421`) and `resolveAcceptanceAffordance` (`:7505`) →
`AcceptanceAffordance {hasAuthority, atBoundary, blockedReason, blockedReasonViaPacket, canAccept,
terminallyBlocked, verdictSatisfiedBy}`. The **projection mirror** is `acceptanceBlockReason` at
`app/server/projections/rebuilder.server.ts:340` (called `:582`) → column `validation_block_reason`;
it deliberately omits three gates (archived, the stage boundary, the no-change refusal), and the
Review queue re-derives the rest in `gateBlockedByKey` (`review-queue.server.ts:252`).

`verdictGateReason(fm, validation, taskKey, noChangeVerified?)`
(`pr-human-approval.server.ts:306`) order: no `workRevision` → allow; delivered work with **no PR** →
refuse *unless* `fm.noChanges || workRevision.kind === "verified" || noChangeVerified`; `healthy`/
`failing` → allow; `humanVerdictApproval` → allow; else the near-miss note, else "Run a review for a
verdict, approve the pull request on GitHub, or an admin can force-accept."

**R21-5 (ruling 88): the ceremony is a SERVER invariant.** `app/shared/acceptance-disclosure.ts`:
`AcceptanceDisclosure` (`:35`), `ACCEPT_DISCLOSURE_FIELDS = {pr: "ackPr", revision: "ackRevision",
verdict: "ackVerdict"}` (`:48`), `acceptanceDisclosureFields` (`:55`, writer),
`parseAcceptanceDisclosure` (`:85`, reader — strict membership tests, never a cast; any missing field
→ `null`), `acceptanceDisclosureDrift(live, echoed, scope)` (`:137`) where `scope: "in-lock"` skips
the PR fact but always re-compares revision and verdict.

The throwing side is `assertAcceptanceDisclosure(fm, ack, taskKey, scope)`
(`task-actions.server.ts:7720`) over `acceptanceDisclosureOf(fm)` (`:7687`, derived from the
canonical file, never the projection). Three-state `ack`: `undefined` → allowed (in-process callers
with their own contract); `null` → 400 `ERROR_CODES.ACCEPT_DISCLOSURE_MISSING`
(`app/server/errors/error-codes.ts:19`); drift → 409 `ACCEPT_DISCLOSURE_STALE` (`:22`).
Throwing sites: `acceptCompletion` (`:7949`, its assert at `:6078` on the shared write path),
`applyAcceptanceWrite` (`:7769`, in-lock assert at `:6243` — **`skipInLockRecheck` for force does
NOT relax it**), `forceAcceptCompletion` (`:8305`), and every HTTP door transitively.
Client side: `app/features/task-detail/accept-confirm.tsx:254` builds the disclosure **from the
rendered props** and hands it to `onConfirm` (`:470`); parsed server-side by `acceptanceAck(formData)`
at `app/routes/project.task.tsx:376` (used `:528`,`:636`,`:692`,`:766`,`:878`) and
`app/routes/project.board.tsx:41` (used `:106`).

**R19-B (ruling 68): a project member's GitHub approval IS the approving verdict.**
`app/server/github/pr-human-approval.server.ts`:

- `PR_APPROVAL_STATUSES` (`:43`) = `counted | unlinked_handle | ambiguous_handle | not_a_member |
  stale_revision`; `PR_HUMAN_APPROVAL_KEY = "humanApproval"` (`:75`).
- `resolveGithubHandle(db, login)` (`:93`) maps via `lower(users.github_handle)`, disabled excluded;
  **two claimants → `ambiguous`**, never a coin flip.
- `derivePrHumanApproval(...)` (`:127`) classifies every standing approval and keeps ONE record; a
  `counted` approval always outranks a near-miss, and the best near-miss is kept **so the surface can
  explain it**. `readPrHumanApproval` (`:181`) is the carry-forward reader.
- `humanVerdictApproval(fm)` (`:210`) **re-checks the revision binding on every read** against the
  current `workRevision.headSha` — a re-delivery revokes the approval instantly, offline.
- `humanVerdictNote` / `humanApprovalRefusalNote` / `verdictGateReason` (`:232`,`:247`,`:306`) — the
  gate is **never silent**: it names the human, their handle and the commit.

Wired in the reconciler at `github-reconciler.server.ts:497`–`:509` — derived only when
`pr && ownsAPr`, and carried forward from the cache when `approvals` is absent.

**R17-1 (ruling 42): accept a head AHEAD, but surface the divergence.** The gate is containment-based.
A head that has **diverged** still refuses — `acceptancePrHeadCheck` (`task-actions.server.ts:7276`)
+ `assertVerifiedHeadStillApplies` (`:7299`, re-checked in the write lock at `:6237` and `:7821`) +
`acceptancePrHeadMismatch` (`:7328`); this is the ONE acceptance gate force-accept can never bypass,
and `completeTaskMerge` runs it too (A2).

The field is `pr.revisionDrift: {aheadBy, headSha} | null` (`task-file.schema.ts:443`), measured by
the reconciler (`github-reconciler.server.ts:465`–`:487`) only when the PR is **owned**,
`pr.headSha !== workRevision.headSha`, and `driftMeasurable` (state `review`/`accepted`, `:463`); a
second `getBranchCompare(reviewedSha, pr.headSha)` records `{aheadBy, headSha}` on a clean `"ahead"`.
F21-17: on a settled PR the last measurement is **carried forward**, not erased (`:522`–`:524`).
Surfaced in five places: the review-queue subline (`review-helpers.ts:78` inside `prStateSub` `:57`),
the accept/force dialog's `obs warn` "Merge head" row (`accept-confirm.tsx:377`), the completion
record (`revisionDriftNote(fm)` at `task-actions.server.ts:7592`, appended by every acceptance path
incl. `operator-actions.server.ts:2820`), the operator snapshot + tool description, and the board card.

**R19-8 (ruling 62): "Completed — no changes" passes the SAME verdict gate.** It mints a
`kind: "verified"` revision anchored to the real default-branch head. Requires
`defaultBranchEvidence.verified` from push-workspace on BOTH doors (`no_branch`, `no_commits`).
Machinery: `app/server/tasks/no-change-completion.server.ts`. Its empty-branch cleanup is
`emptyBranchDisposition` (`task-actions.server.ts:7636`) → `cleanUpEmptyTaskBranch` (`:8215`); a
name-only branch match is classified `collision` (`:7649`) and never deleted.

**Force-accept (DG-2 / R19-5, ruling 59).** `force-accept-completion` is admin-only
(`requireAction` at `:8320`). `forceAcceptCompletion` computes `bypassed` (the gate as it stood
BEFORE the write) via `acceptanceRefusalReason` (`:8365`), calls `acceptCompletion(force: true)`, and
records `task.acceptance.forced` with `{bypassed}` **only after** the write succeeded (U3/NFR16). It
MAY skip remaining stages and the review gate but must SAY so. It does NOT bypass ruling 37's
terminal GitHub fact (`forceIrreducibleRefusal` `:7221`) nor ruling 20's head-containment check.

**R16-3 (ruling 37).** A terminal GitHub fact (closed, unmerged PR) is named FIRST, and while the PR
is closed admin Force-accept is **WITHDRAWN (hidden)**, not disabled
(`acceptanceTerminallyBlocked(fm)` = `fm.pr?.state === "closed"`, `:7191`; client gate in
`task-detail-hooks.ts`).

**Review queue.** `getReviewQueue(db, slug, {viewerUserId, dataRoot?, now?})`
(`app/server/projections/review-queue.server.ts:114`) — `viewerUserId` is **required** (E5).
`canAccept` (`:234`) is `roleCan(role, "resolve-packet")` OR (`roleCan(role, "own-task")` AND the
viewer is the human owner) — fails closed for a non-member. `isReady(r)` (`:270`) =
`waiting === "human" && canAccept(key) && blockReason === null && !gateBlockedByKey.get(key) &&
pr?.state !== "closed"`. An archived project yields `reviewId = null` → an empty queue (F19-9).
Row copy: `reviewRowSub(t)` (`review-helpers.ts:87`) precedence is closed PR → `blockReason` →
`packet` → live PR state → latest event → per-`waiting` placeholder. The row says **"Review", not
"Accept"** (R15-11).

**Who may accept on the operator side.** `resolveAcceptanceAuthority(projectSlug, ctx)`
(`app/features/review/review-acceptance-authority.server.ts:29`):
`operatorCanAccept = deployed && autonomy === "full" && gate(authority, "completion-for-acceptance")
=== "direct"` (`:36`); `catch` → `{operatorCanAccept: false, operatorName: "the operator"}` (`:45`).

### 4.8 Merge — human-only

**R16-6 (ruling 40): `merge-pull-request` is and stays `ALWAYS_HUMAN`.** "Done" has two meanings:

- A **full-autonomy operator** that accepts completion CANNOT merge. It records
  `pr.state: "accepted"` — *merge pending* — moves the task to Done, and a human merges later.
- A **human** acceptance triggers a real async merge.

`completeTaskMerge(db, {projectSlug, taskKey}, actor, ctx)` (`task-actions.server.ts:8401`) is the
merge-pending completion door:

- requires `actor.userId` (a signed-in human) — explicit validation error otherwise;
- `requireAcceptCompletion` (`:8416`, maintainer+ OR the task owner, R6-2);
- **F21-23:** `pr.state === "merged"` settles as a **no-op success** with an honest message and
  **writes nothing**;
- any other non-`accepted` state → 409;
- **A2:** `acceptancePrHeadCheck` runs here too;
- delegates to `mergeTaskPr`.

`mergeTaskPr(db, {projectSlug, taskKey}, actor: AuditActor & {userId: string}, ctx)` —
`github-reconciler.server.ts:1201`; `MergeTaskPrResult` at `:1140`. **`userId` is a required,
non-optional field of the signature** — that is the type-level half of human-only. It refuses
`mergeable === "conflicting"` *before* attempting (`:1246`, P14-LV-07), un-drafts a draft PR via
GraphQL `markPullRequestReadyForReview` (`:1266`, F7-GH5, best-effort), then `PUT /pulls/{n}/merge`
(`:1274`). On success: drops `mergeable`, stamps `state: "merged"`, appends a `github` event authored
`{kind: "human", userId}`, records provenance `github.merge`, audits `github.pr.merged` (`:1311`),
resolves any open `pull_request:write` violation (`:1328`), calls `markWriteScopeProven` (`:1341`),
and runs branch cleanup (`:1353`) inside a `try/catch`. Failure mapping: 405 → `not_mergeable`
(`:1387`), 409 → `head_changed` (`:1390`), **403 → opens a `pull_request:write` scope violation +
`github.pr.merge_refused` audit** (`:1408`, never throws), 404 → `pr_not_found` (`:1425`), 401 →
`auth_failed` (`:1428`).

Six more pieces of human-only evidence: `capabilities.ts:151` declares the cap with default mode
`human` and `promotable: false`; `agent-profile-actions.server.ts:301`,`:353`,`:548` coerce
`mode = "human"` on write; `app/server/tasks/specialist-tool-policy.ts:69` denies
`Bash(gh pr merge:*)`; `attemptAcceptanceMerge` (`task-actions.server.ts:5586`) returns
`{kind: "pending", cause: UNREACHABLE_MERGE_CAUSE}` (`:5577`) immediately when `!actor.userId`
(`:5598`); the operator toolkit exposes `deliver_for_review` and `update_branch_from_base` but **no
merge tool**; and the PR body itself says "Review and merge are human-authorized."

**Merge-pending state.** `pr.state === "accepted"` is Viberr's own state (documented at
`pr-linker.server.ts:26`). `nudgeMergePendingTasks` (`reconcile-poller.server.ts:58`, called `:258`)
reminds via `json_extract(pr_json,'$.state') = 'accepted'` (B9).

**Branch cleanup (R15-6, ruling 24).** `branchCleanupOnMerge(db, projectSlug)` at
`app/server/github/branch-cleanup.server.ts:32` reads `projects.guardrails_json` for
`BRANCH_CLEANUP_GUARDRAIL_ID = "delete-branch-after-merge"` (`:23`) — **absence means ON**; only an
explicit `on: false` disables. Mechanics: `deleteTaskRemoteBranch(db, {projectSlug, taskKey}, actor,
ctx)` (`github-reconciler.server.ts:1462`; `BranchDeleteResult` `:1438`) refuses three things
outright — no acting `userId` (`:1473`, "branch deletion is a HUMAN decision"), the default branch
(`:1483`), and an OPEN PR (`:1490`, `review`/`accepted`). Ref path is
`encodeRefPath("heads/" + branch)` (B11); 422 → `already_gone` (`:1547`). Audit
`github.branch.deleted` (`:1531`), provenance `github.branch_delete` (`:1524`).
**Four callers:** post-merge inside `mergeTaskPr` (`:1353`), the `archive_task` + `deleteBranch`
packet option (`task-actions.server.ts:6655`), `cleanUpEmptyTaskBranch` (`:8231`), and NEW —
`resolveRemoteBranchCollision` (`github-reconciler.server.ts:1636`).

### 4.9 Reconciliation + divergence

`app/server/github/github-reconciler.server.ts` + `reconcile-poller.server.ts`
(`RECONCILE_POLL_MS = 5 * 60_000` at `poller:41`; `RECONCILE_FAILURE_ALERT_THRESHOLD = 3` at `:129`;
`RECONCILE_TASK_CONCURRENCY = 4` at `reconciler:958`; `RECONCILE_POLL_TASK_BUDGET = 20` at `:966`).

`reconcileTask` (`:909`) wraps `reconcileTaskUnlocked` (`:309`) in `withTaskReconcileLock` (`:265`) —
a **per-task QUEUE, not a coalescer** (F19-19). Ownership is `sameAsCached || adoption?.adopt === true`
(`:443`); a foreign PR is recorded as `github.unownedPr` so the collision note fires **once**
(`unownedPrIsNew`, `:594`) rather than on every ~288 daily ticks. The patch is re-applied inside
`updateTaskFile` with `keepCurrent` guarding `merged` (irreversible) and a local `accepted` against a
stale remote `review`. `reconcileProject` (`:996`) runs a **budgeted, cursor-rotating** pass over
`task_projections WHERE branch IS NOT NULL`, skipping tasks whose computed `terminal` is
`archived = 1 OR json_extract(pr_json,'$.state') = 'merged'` — deliberately not `closed`. It uses a
bounded worker pool, not `Promise.all` (B-GH5). `reconcileSummaryFailed(summary)` (`poller:22`,
C7/pass-24) is how failure is detected: credential/network failures come back as **values**.

**DG-3.** The provenance observation row is skipped on an *unchanged* poller tick, so provenance
cannot grow unboundedly. The honest "last check" is the **unconditional** per-tick audit row
`github.reconcile.task` (`reconciler:879`; constant `RECONCILE_TASK_AUDIT_ACTION` at
`app/server/audit/audit-query.server.ts:31`), read by `latestTaskReconcileCheckAt` (`:51`). The
poller passes `skipProjectAudit: true`, so the project-level read unions `github.reconcile.project`
(`reconciler:1102`, human-triggered) with the task rows. A `github.reconcile` row is also written on
the human-triggered task path (`:874`) and by `reconcileProject`'s own writer (`:1129`).

**PR divergence (ruling 17 + R17-5/ruling 46).** `github-reconciler.server.ts:826`–`:839` fires
`ctx.wakeOperator ?? autoInvokeOperator(db, ctx, slug, key, "pr-diverged")` on exactly four edges:
`mergedButNotDone` (`:637`), `closedButActive` (`:638`), `acceptedClosedExternally` (`:613`),
`prJustReopened` (`:644`). Fire-and-forget on the same transition edge as the policy-engine note.
The seam type is `OperatorWake` (`:87`); the trigger is the kebab **string literal** `"pr-diverged"`
(`reconciler:92`,`:839`; `task-actions.server.ts:877`; `operator-run.server.ts:165`,`:3306`) — there
is no `pr_diverged`/`prDiverged` identifier anywhere. It **never auto-advances the stage**; it emits
typed `note` events authored by `POLICY_ENGINE_ACTOR` (`scope-flag.server.ts:41`), notifies watchers
via `notifyTaskWatchers`, and withdraws superseded recommendations (`transition` always;
`accept_completion` only on `closedButActive`, `:677`).

**The ghost test file is gone (C8):** `pr-divergence-operator.server.test.ts` was renamed
`app/server/github/pr-divergence-wake.server.test.ts` — the seam it exercises is `OperatorWake` /
`ctx.wakeOperator`. There is still no `pr-divergence-*.server.ts` SOURCE file.

Operator handling — `app/server/runtimes/operator-run.server.ts:3306`:

- **closed + at terminal** → ONE `input` packet with `custom` options (`:3323`): reopen+merge on
  GitHub, or accept that the work stays unmerged and re-deliver via a new task.
- **closed + active** → ONE recovery packet (`:3334`): `custom` REWORK · `archive_task` ·
  `archive_task` with `deleteBranch: true`. Exactly one recommended. Body must say reopening the PR
  on GitHub is also valid. **Never recommend acceptance while the PR is closed.**
- **merged out-of-band** → `accept_completion`.
- **reopened/replaced** → withdraw the now-moot packet (`:3343`–`:3345`).
- **F21-17:** the packet must carry the unreviewed out-of-band commit drift (`driftInstruction`,
  `:3244`, threaded `:3316`) as a REQUIRED observation.

Freshness chip honesty (R17-5): `reconcile.at === null` reads neutral "Not synced yet"; only
`stale && at !== null` warns (`project.github.tsx:101`).

### 4.10 `discard_branch` (R20-2 / F20-6)

A packet option kind (`PACKET_OPTION_KINDS` entry at `task-file.schema.ts:154`) that deletes the task's
**LOCAL, never-pushed** workspace branch — nothing on the remote changes. Operator-authored only
(taught at `operator-run.server.ts:3486`, and now guarded by the F31-6 authoring refusal at
`operator-actions.server.ts:1033`). Because it destroys commits it re-checks `approve-transition`
server-side at resolve time (`task-actions.server.ts:6414`) and the UI asks for a two-step confirm
(`PacketDiscardConfirm`, `decision-packet.tsx:368`). It is in the `NO_REQUEUE` set (`:6573`).
The resolution write only records the decision; the git work happens after via
`discardLocalTaskBranch` (`push-workspace.server.ts:790`), which: `revParse(refs/heads/<branch>)`
first so the outcome can name the sha it destroyed; **ruling-17 guard**
`git ls-remote --exit-code --heads origin <branch>` exits 0 → `on_remote`; `git checkout
<defaultBranch>` when HEAD is on it, then `git branch -D`. `DiscardBranchOutcome` (`:769`) =
`deleted{branch,sha} | not_found | on_remote | no_workspace | failed{reason}`. `fm.branch` is cleared
**only** when the branch actually deleted is still the one the frontmatter names. Audit:
`task.branch.discarded` (`task-actions.server.ts:6736`,`:6826`) / `task.branch.discard_refused`
(`:6827`).

### 4.11 Update-branch (N19 gap 9)

`app/server/github/update-branch.server.ts` (mechanics) + `update-branch-operator.server.ts`
(decision, `UPDATE_BRANCH_CAPABILITY = "update-task-branch"`). Same R15-2 split.

- **MERGE, never rebase** — a rebase needs a force-push, exactly what R18-4 refused.
- **The workspace is the writer** — the update runs in the delivering engagement's own clone and is
  then pushed, preserving the single-writer invariant.
- **A conflict is a human decision, never an agent retry** — it opens a decision packet
  (`conflictOptions`, `update-branch-operator.server.ts:98`) and the branch is left as it was.
- An **absent** `update-task-branch` grant falls back to the DELIVERY gate deliberately — now routed
  through `absentPolarityGate` (`operator-actions.server.ts:479`) as well as the local arm.
- **A dirty tree refuses** (`dirty_workspace`). On conflict the conflicting files are read
  (`git diff --name-only --diff-filter=U`, capped at `MAX_CONFLICT_FILES = 20`) **before**
  `git merge --abort`. A failed push after a successful merge does `git reset --hard <preSha>`.
- `UpdateBranchResult`: `updated | already_current | conflict | push_conflict | update_failed | no_pat
  | no_repo | no_workspace | no_branch | dirty_workspace | task_not_found`.

Audit: `github.branch_update.operator`, `github.workspace.branch_reconciled`.

### 4.12 Scope violations and repo access

`app/server/github/scope-flag.server.ts`: `flagScopeViolation` (`:112`) is fully idempotent —
`created: false` writes no event, no notification, no reprojection. On `created` it appends a typed
`policy` timeline event **and** fans out via `notifyTaskWatchers` (E3). `policyUpdateText(scope)`
(`:50`) names the ACTUAL scope. `resolveScopeViolationWithEvent` (`:157`) closes one.
Only two scopes are ever flagged: `repo` (branch read/create, reconcile compare —
`branch-sync.server.ts:346`,`:374`) and `pull_request:write` (PR open `pr-open.server.ts:600`, merge
`github-reconciler.server.ts:1408`). The audit rows themselves are written by
`app/server/projections/policy-violations.server.ts:209` (`github.scope_violation.opened`) and `:256`
(`github.scope_violation.resolved`).

`checkRepoAccess(db, projectSlug, opts)` (`repo-access-check.server.ts`) →
`connected | no_repo_configured | no_pat_configured | repo_not_found | auth_failed{reason:
"expired"|"revoked"} | org_approval_missing | forbidden | network_unavailable`. Memoized 30 s per
`DatabaseSync` in `github-query.server.ts` and busted by `invalidateRepoAccess(db, slug)` on every
credential mutation (LV-05). `probeRepoWithConnection` (`github-actions.server.ts:199`) is the
bind-time variant returning `reachable | access_miss | unverified` — "we could not ask" never blocks
a bind (B-GH3).

### 4.13 Agent GitHub reads

`scopeAgentGithubReadPath` at `app/server/github/agent-github-read.server.ts:61` (F4 review,
2026-08-21). The GitHub client builds its URL with `new URL(GITHUB_API_BASE + path)`, and the WHATWG
parser converts `\`→`/`, percent-decodes `%2e` and collapses `..` — so a purely TEXTUAL `..` check is
defeated by `pulls\..\..\..\..\user` or `%2e%2e/%2e%2e/other/repo`. The function refuses those
encodings up-front, then **resolves through the same parser the client uses and re-verifies the scope
on the normalized path**, and **returns that normalized path** so the request and the audit row
(`task.agent.github_read`) record exactly what is fetched. Capability: `read-github-api`, CLAUDE-ONLY
(R22).

---

## 5. Audit

### 5.1 Recorder

`app/server/audit/audit-recorder.server.ts`. `recordAudit(db, event)` (`:61`) inserts into
`audit_events` `(id, occurred_at, actor_user_id, actor_label, action, subject_kind, subject_id,
project_slug, task_key, details_json)` (`:68`). Rules: **`details` must be secret-free**;
**recording never breaks the action that triggered it** (failures are logged at `:84` and swallowed).
`AuditDetailValue` (`:38`) is a JSON-only recursive type, named precisely so a caller cannot hand over
an Error/Map/class instance that `JSON.stringify` flattens to `{}`. Actors: `SYSTEM_ACTOR` (`:23`,
`{userId: null, label: "system"}`) and `OPERATOR_AUDIT_ACTOR` (`:28`, `label: "operator"`).

Note the column is **`occurred_at`, not `created_at`**.

### 5.2 What is audited

**153 distinct action strings** reachable from a `recordAudit(` call site (most literal; the rest
through a ternary — `input.archived`, `isTake`, `isSelf`, `handoff`, `oldDir`, `oldName`, `wasDir`,
`enabled`, `existing`, `outcome.status` — or a named constant: `COMMENT_DROPPED_AUDIT_ACTION`,
`DELIVERY_NEXT_STEP_AUDIT_ACTION`, `RECOMMENDATION_DISMISSED_AUDIT_ACTION`,
`RECONCILE_TASK_AUDIT_ACTION`). All dot-separated lowercase. Families:

- **auth** — `auth.login.success|failure|rate_limited`, `auth.logout`, `auth.oauth.login |
  user_provisioned | placeholder_claimed`, `auth.password.changed | reset | forced_reset_completed`,
  `identity.github.disconnected`, `profile.updated`.
- **authorization** — `project.org_admin.override` (D2), `project.authority.denied` (P13-D-8),
  `controller.authority.denied` (ruling 99, now also emitted by the ruling-107 ops MCP through
  `controller-tool-guards.server.ts:92`).
- **org** — `org.user.created|updated|removed|disabled|enabled|whitelisted`,
  `org.domain.whitelisted|removed`, `org.connection.created|token_replaced|default_changed|removed|
  validation_downgraded`, `org.oauth_provider.created|updated|tested|enabled|disabled|removed`,
  `org.mcp.added|updated|removed`, `org.kb.created|updated|deleted|reindexed`,
  `org.skill.created|updated|deleted`, `org.store.files_added|folder_created|doc_written|
  github_import|folder_deleted|file_deleted`, `org.agent_profile.created|updated|deleted`,
  `org.controller.updated`.
- **project** — `project.created|deleted|archived|unarchived`, `project.member.invited|removed|
  role_changed`, `project.policy.boundary_changed`, `project.stage.added|removed|renamed|reordered`,
  `project.settings.updated`, `project.repo.updated`, `project.operator.autonomy_changed`,
  `project.agent_profile.created|updated|deleted|deployed`.
- **task** — `task.created|archived|unarchived`, `task.transition`, `task.goal.updated`,
  `task.metadata.updated`, `task.ownership.taken|handed_off|released|admin_released|
  released_on_removal`, `task.packet.resolved|escalated|withdrawn_superseded`,
  `task.acceptance.forced`, `task.operator.*` (9 rows), `task.agent.commented|replied|run_started|
  packet_opened|github_read`, `task.specialist.assigned`, `task.reviewer.assigned|removed`,
  `task.delivery.handoff`, `task.branch.discarded|discard_refused`,
  `task.schedule.created|fired|cancelled`, `task.quality.flagged`,
  `task.comment|.dropped|.unrouted`, `task.recommendation.applied|dismissed`.
- **github** — `github.pat.created|token_replaced|deleted`, `github.credential.assigned|cleared|
  revalidated`, `github.branch.created|deleted`, `github.branch_update.operator`,
  `github.pr.opened|merged|merge_refused`, **`github.pr.closed_unowned` (NEW, F31-6)**,
  `github.delivery.manual|operator`, `github.delivery.next_step`,
  `github.reconcile|.task|.project`, `github.scope_violation.opened|resolved`,
  `github.workspace.pr_linked|branch_reconciled`.
- **runtime / system** — `runtime.run.started|interrupted`, `runtime.operator.plan_executed`,
  `run.recovery.reinvoked|reply_replayed`, `projection.rebuild|rescan`, `secrets.resealed`,
  `seed.baseline|org_resources`, `store.restored`, `goal.created|updated|completed`.

`github.merge` and `github.branch_delete` are PROVENANCE kinds
(`recordGithubProvenance`, `github-reconciler.server.ts:171`), not `audit_events` actions —
easy to confuse with the audit list.

`app/server/audit/audit-coverage.server.test.ts` drives governed entry points for their EFFECT and
asserts the row lands — that is the test to extend when adding a governed action.

### 5.3 Retention — and the NEW export-before-purge (ruling 102)

`app/server/db/retention.server.ts`: `RUN_LOG_RETENTION_DAYS = 30` (`:51`),
`AUDIT_RETENTION_DAYS = 90` (`:53`), `NOTIFICATION_MAX_PER_USER = 500` (`:77`). Canonical Markdown
task files are **never** touched. `applyRetention(db, now, options)` (`:200`).

`IDEMPOTENCY_AUDIT_ACTIONS` (`:72`, B-FD10) is **exempt** from the window: `task.agent.replied` and
`runtime.operator.plan_executed` double as idempotency keys for boot recovery, so deleting one would
make the next boot **redo the work**. Explicitly listed, never pattern-matched. The rolling-window
recovery counters are deliberately NOT exempt.

**NEW (ruling 102, `decisions.md:1456`).** The audit purge now EXPORTS before it deletes:

- `expiringAuditRows(now)` (`:144`) builds the predicate ONCE so the export and the DELETE cannot
  disagree about which rows are expiring; values are bound placeholders.
- `exportExpiringAuditEvents(db, expiring, now, dataRoot)` (`:165`) SELECTs those rows, parses them
  through `auditRowSchema` (`:124`, a `looseObject` so a later migration's column rides through), and
  appends one JSON object per line to
  `<dataRoot>/audit-exports/audit-events-<YYYY-MM-DD>.jsonl` (`auditPurgeExportPath` `:106` — one
  file per DAY, APPENDED, because several passes run per day).
- **Fails closed** (`:192`): any failure — unparseable rows, an uncreatable directory, a write error
  — returns `false` and the caller **skips that pass's DELETE** (`:215`–`:221`), reporting
  `auditEvents: 0`. An empty result is a vacuous success (no file created).
- `app/server/audit/audit-export.server.ts` is deliberately NOT reused: it serializes a camelCased
  projection into a single JSON array/CSV under a 100k row cap, which is the right shape for an admin
  download and the wrong one for an append-only machine record of deleted rows.
- `RetentionOptions.dataRoot` (`:85`) is threaded from `runMaintenancePass`
  (`app/server/ops/maintenance.server.ts:153`). Boot's pass (`boot.server.ts:365`) passes none, so
  the configured root applies.

`applyRetention` now has exactly ONE caller — `runMaintenancePass` — which runs at boot
(`boot.server.ts:365`, `reason: "boot"`) and on the interval (`maintenance.server.ts:396`).

### 5.4 Reads and export

- **In-app browse** — `app/server/audit/audit-browse.server.ts`. `listRecentAuditEvents` (`:47`),
  newest-first, no `details` blob; `AUDIT_BROWSE_DEFAULT_LIMIT = 150` (`:29`), max 500. Org-admin
  gated at the route (`org.settings.tsx:109`, `auditEvents:` at `:125`).
- **File export** — `app/server/audit/audit-export.server.ts`: `queryAuditEventsForExport(db,
  filters)` (`:65`; projectSlug / action / actorUserId / since / until / limit, every filter a bound
  placeholder), `serializeAuditExport(rows, format)` (`:221`), `EXPORT_FORMATS` (`:209`),
  `isAuditExportFormat` (`:216`). `AUDIT_EXPORT_MAX_ROWS = 100_000` (`:16`, clamped `:93`).
  **F26-9:** the org-settings Audit-log panel copy discloses BOTH the row cap and the 90-day window.
- **Download route** — `app/routes/org.settings.audit-export.ts:18`, `requireRole(request, "admin")`
  at `:20`, `Content-Disposition: attachment; filename="viberr-audit-<date>.<ext>"` (`:46`),
  `Cache-Control: no-store` (`:47`).
- **S3 push** — `app/routes/org.settings.tsx:287` intent `audit-export-s3` →
  `getS3AuditConfigForUse` + `putObjectToS3`. **F26-11:** a network-level failure makes `fetch`
  THROW, so the call is wrapped (`:306`–`:318`).

---

## 6. Route guard inventory

Every route in `app/routes.ts`, with its authorization. `requireFormAction` =
`requireAuth` + `assertCsrf` + actor (`form-action.server.ts:7`).

| Route | Loader guard | Action guard |
| --- | --- | --- |
| `/` (`_index.tsx`) | `requireUser` `:44` | `requireFormAction` `:85` |
| `/login` | none (public) `:46` | `assertTrustedOrigin` `:68`; `requireAuth`+`assertCsrf` `:128`,`:131` on the reset arm; rate-limited |
| `/logout` | redirect `:36` | `requireAuth` + `assertCsrf` `:15` |
| `/api/auth/*` | better-auth handler `:11` | better-auth handler `:15`; `ALLOWED_AUTH_PATHS` allow-list + own Origin check |
| `/org/settings` | `requireRole(admin)` `:109` | `requireRoleAuth(admin)` `:201` + `assertCsrf` `:205` |
| `/org/settings/audit-export` | `requireRole(admin)` `:20` | — |
| `/insights` | `requireRole(admin)` `:17` | — |
| `/controller` | `requireUser` `:26` | `requireFormAction` `:42`; per-tool-call authority inside the run |
| `/profile` | `requireUser` `:60` | `requireAuth` `:68` + CSRF inside the try |
| `/notifications` | `requireUser` `:47` | — |
| `/notifications/read` | redirect `:48` | `requireAuth` `:22` + non-throwing `csrfError` `:31` |
| `/prefs/theme` | redirect `:43` | `requireAuth` `:20` + non-throwing `csrfError` `:26` |
| `/resources/events` (SSE) | `authenticate` `:65` (401, not redirect); scopes re-resolved live per `isOrgAdmin` / `memberProjectSlugs` `:124`–`:134` | — |
| `/resources/health` | **unauthenticated by design** `:59` | — |
| `/resources/run-log` | `requireUser` `:43`; controller runs → `canReadControllerRunLog` `:78`; all others → `requireProjectMember` `:86` | — |
| `/resources/search` | `requireUser` `:15`; scoping inside `searchWorkspace` | — |
| `/resources/model-catalog` | `requireUser` `:25` | — |
| `/resources/session-export` | `requireUser` `:33`; controller runs → `canReadControllerRunLog` `:51`; else `requireProjectMember` `:56` | — |
| `/projects/:slug/tasks/:key/attachments/:file` | `requireUser` `:32` + `requireProjectMember` `:33` | — |
| `/projects` | redirect `:7` | — |
| `/projects/:slug` (layout) | `requireUser` `:71`; 404 for unknown slug `:74` and for non-member without org-admin override `:89` | — |
| `/projects/:slug/` (index) | redirect to board `:5` | — |
| `…/board` | parent layout | `requireFormAction` `:46` + `requireVisibleProject` `:53`; `assertProjectAction("rescan-project")` `:130` |
| `…/review` | `requireProjectMember` `:30` | — |
| `…/controller` | `requireProjectMember` `:31` | `requireFormAction` `:65` + `requireVisibleProject` `:66`; goal ops gate inside `updateGoal` (`goal-actions.server.ts:245`,`:257`) |
| `…/agents` | `requireProjectMember` `:47` | `requireFormAction` `:136` + `requireVisibleProject` `:142`; `manage-agents` inside `agent-profile-actions.server.ts:215` |
| `…/policy` | `requireProjectMember` `:35` | `requireFormAction` `:45` + `requireVisibleProject` `:49`; `edit-policy` inside `policy-actions.server.ts:197` |
| `…/github` | `requireProjectMember` `:51` | `requireFormAction` `:106` + `requireVisibleProject` `:111`; `reconcile-github` `:125`, `grant-github-scope` `:129`,`:135` |
| `…/activity` | `requireProjectMember` `:46` | — |
| `…/settings` | `requireProjectMember` `:57` | `requireFormAction` `:83` + `requireVisibleProject` `:90`; `grant-github-scope` `:197`,`:204`; everything else gated inside `settings-actions.server.ts` |
| `…/tasks/:key` | `requireUser` `:117` + `requireVisibleProject` `:125` | `requireFormAction` `:413` + `requireVisibleProject` `:420`; per-intent gates inside `task-actions.server.ts` |

`palette-shell.tsx` is a pathless layout with no loader/action — it only mounts the ⌘K shortcut.

---

## 7. Controller authorization (rulings 99, 106, 107, 108)

### 7.1 The authority model

The controller holds **no** authority of its own: every tool call resolves the ASKING user's live
authority. `controllerToolGuards(db, user, dataRoot)` at
`app/server/controller/controller-tool-guards.server.ts:79` is the shared machinery for both
in-process servers:

- `actor = { userId: user.id, label: "<email> · via controller" }` (`:84`) — guards bind to the human
  id, the instrument is disclosed in the label.
- `orgAdmin()` (`:87`) — LIVE `isOrgAdmin`, never snapshotted at conversation start.
- `requireOrgAdmin(what)` (`:89`) — refuses 403 AND records `controller.authority.denied`
  `{scope: "instance", what}` (P13-D-8 parity: project denials are audited, instance denials must
  not read cleaner).
- `requireVisible(slug, what)` (`:101`) — `assertProjectAction("any-member", …, {allowArchived:true})`,
  and any failure becomes `NotVisibleError` with the uniform sentence
  `notVisible(slug)` = `[denied] No project "<slug>" is visible to you.` (`:48`).
- `run`/`runWith` (`:112`,`:136`) wrap handlers: `AppError` 401/403 → `[denied] <userMessage>`,
  anything else → `[error]`.

Conversation access: `canAccessConversation` / `requireConversation`
(`controller-conversations.server.ts:148`) — owner, or org admin (ruling 100(b) confirmed this step
outside R15-4 as intended). `canReadControllerRunLog(db, run, user)` moved to `:125` of that file
(ruling 107) and is the SINGLE gate for a controller run's log and session export:
`run.kind === "controller"` → conversation must exist and be owned by the caller, else `isOrgAdmin`.

### 7.2 `viberr_ops` — the built-in diagnostics MCP (ruling 107)

`app/server/controller/controller-ops-mcp.server.ts`, mount key
`CONTROLLER_OPS_MCP_NAME = "viberr_ops"` (`:75`). Built by `buildControllerOpsMcp` (`:127`) and
mounted UNCONDITIONALLY by `buildControllerMounts`
(`app/server/controller/controller-run.server.ts:150`, ops merged at `:161`–`:170`) — no config is
read, no grant row exists, nothing in the UI can drop it. READ-ONLY: nothing writes, deletes or
starts anything.

Per-tool RBAC:

| Tool | Who | Where |
| --- | --- | --- |
| `instance_health` | **the READING is open to any signed-in user** (it is what `/resources/health` serves unauthenticated, plus per-backend availability booleans and three concurrency integers). The credential **DETAIL** sentence is **org-admin only** | `:161`–`:196`; `backendCredential(backend, orgAdmin)` `:117` returns `{backend, available}` for a non-admin and the full `BackendCredentialHealth` for an admin |
| `read_run_log` | exactly the `/resources/run-log` gate: `canReadControllerRunLog` for a controller turn, `requireVisible(project)` otherwise | `requireRunVisible` `:149`; tool `:198`–`:325` |
| `read_store_doc` | **org admins only**, like the store browser it comes from | `requireOrgAdmin("read store documents")` `:339` |

**One not-visible sentence.** `notVisibleRun(runId)` (`:104`) = `[denied] No run "<id>" is visible to
you.` A missing run (`:237`), a forbidden project (`:157`) and a forbidden conversation (`:152`) all
answer it, so a probe cannot walk run ids or learn which project a run belongs to.

**Bounded pages.** `DEFAULT_LOG_LINES = 200`, `MAX_LOG_LINES = 500` (`:98`,`:99`). `since` together
with `before` is REFUSED (`:243`) rather than letting one silently win. Backward mode passes `limit`
into `getRunLog` (`:257`); forward mode slices tool-side (`:272`) because `getRunLog` ignores `limit`
there BY DESIGN (the console's live tail is bounded by its own cursor) — the documented tradeoff is
that the SELECT stays unbounded and the fix, if it ever bites, is a LIMIT pushed into `listRunLines`,
never a bigger reply. The reply carries `page.{firstSeq,lastSeq,olderExist,newerExist,next}` computed
against the run's real bounds (`runLineStats`, `:280`) plus `run.logLines` — never `getRunLog`'s
page-local `headSeq/oldestSeq/hasMore`.

**Reserved names, one list.** `app/shared/mcp-reserved.ts:29` — `viberr`, `viberr_agent`,
`viberr-agent`, `viberr_browser`, `viberr-browser`, `viberr_controller`, `viberr-controller`,
`viberr_ops`, `viberr-ops`; `isReservedMcpName` at `:42`. Read by the WRITER (`saveMcpServer`), the
PICKER (`buildResourceCatalog`) and — the ruling-107 fix — the RESOLVER
(`app/server/tasks/specialist-mcp.server.ts:4`, which had kept a private copy two rulings behind, so
a row reaching the registry any way but `saveMcpServer` resolved and, mounting LAST, replaced the
built-in server under its own key).

### 7.3 Deployment locks on controller configuration (ruling 108)

`app/server/controller/controller-profile.server.ts`:

- `ControllerSectionLocks {skills, kb, mcps, instructions}` (`:49`), `true` = locked.
- `CONTROLLER_UNLOCK_ENV` (`:58`) — `VIBERR_UNLOCK_CONTROLLER_SKILLS` / `_KB` / `_MCPS` /
  `_INSTRUCTIONS` (env schema at `app/server/config/env.server.ts:173`–`:176`).
- `CONTROLLER_UNLOCK_VALUE = "enabled"` (`:77`); `unlockFlag` (`:78`) lowercases and trims, so
  `disabled`, a typo, or unset all keep the section **locked** (fails safe/closed).
- `controllerSectionLocks(env = getEnv())` (`:84`) — the live lock state. **There is no in-app
  override anywhere.**
- `CONTROLLER_SECTION_LABEL` (`:67`) is shared by the refusal sentence and the settings panel note.

Enforcement is **server-side in `saveControllerConfig`** (`:203`), not in the route, so every save
path is bound (`ctx.locks` exists for tests only, `:221`):

- `resolveGrant(section, stored)` (`:235`): unlocked → write the input as given; locked → return the
  STORED list **verbatim** (order and duplicates included), and throw `lockedChange(section)`
  (`:226`) only when the input is non-empty AND `!sameSet(input, stored)`.
- Instructions (`:254`–`:261`): blank keeps the current doctrine (unchanged semantics); under a lock
  a non-blank body that differs from the stored doctrine is refused, and a locked save never rewrites
  the doctrine file.
- Refusal copy names the section and its variable:
  *"The controller's `<label>` are locked on this deployment. Set `<VAR>=enabled` in the app
  environment and restart to edit them."*
- Model and effort are deliberately NOT sections (`:45`–`:46`); `effort` is persisted at `:275`–`:277`
  with blank deleting the key.
- Audit `org.controller.updated` (`:286`) with `definitionEdited` true **only** when the doctrine file
  was actually rewritten (review #12).

Route wiring: `org.settings.tsx:126` returns `controllerLocks: controllerSectionLocks()` to the
panel, and `:439` now posts `effort`. Access stays org-admin end to end
(`requireRole(admin)` loader `:109`, `requireRoleAuth(admin)` action `:201`).

**Declared scope (owner, narrow).** The lock covers the controller SETTINGS tab only. Deleting or
renaming a resource on the Agent resources tab still prunes the controller's grant (the shared
`resource-references` rewrite), and editing a granted skill's or KB's file contents still changes
what the controller loads. `decisions.md:1629`–`:1638` states the boundary rather than implying a
containment the ruling does not provide.

---

## 8. Gotchas

1. **Human GitHub approval IS a verdict (R19-B, ruling 68).** Four properties make it evidence and
   all four must survive any refactor: bound to the delivered revision (checked when recorded AND on
   every read), approver must be a **project member** resolved via `users.github_handle`, **fails
   closed**, and it is **never silent**.

2. **`acceptance: "forced"` is a durable frontmatter fact, not just an audit row.**
   `task-file.schema.ts:684`/`:724` and the `if (fm.acceptance === "forced") return "bypassed"` arm at
   `:795`. The arm sits AFTER the real-verdict arms.

3. **Scope-check the NORMALIZED form.** `scopeAgentGithubReadPath`
   (`agent-github-read.server.ts:61`) — a purely textual `..` check is defeated by
   `pulls\..\..\..\..\user` or `%2e%2e/%2e%2e/other/repo`.

4. **A task-key branch is not an identifier.** Keys restart at 1 on a fresh data root. FOUR rulings
   now exist because of this one fact: R15-15 (only the task that opened a PR owns it), R16-1 (adopt
   only OPEN + head-sha-identical), R18-4 (branch collision → human packet, never force-reset), and
   F31-6 (`resolve_remote_collision` is the packet's remedy verb). Its fifth consequence is the V5
   provenance rule below.

5. **Provenance is POSITIVE evidence, not the absence of a stranger's PR (V5).** A stale remote
   branch with foreign `[KEY]`-prefixed commits and NO pull request passed the old absence test.
   `provenBranchHead = deliveredThisBranch && !unownedPr` (`github-reconciler.server.ts:563`) and
   `github.changed` is OWNED-only (`:572`).

6. **`push_conflict` must not open a PR.** It would review the stale remote content instead of the
   delivery (the live F15-15 failure). Regression-locked this pass.

7. **`discard_branch` and `resolve_remote_collision` are opposites.** The first destroys the task's
   LOCAL commits; the second keeps them and clears the REMOTE. Authoring `discard_branch` on a task
   with a delivered revision or an occupied branch name is REFUSED
   (`operator-actions.server.ts:1033`) — an operator once authored a remote-deletion promise onto the
   local-discard kind.

8. **Merge is `ALWAYS_HUMAN` and "Done" is ambiguous.** An operator acceptance records
   `pr.state: "accepted"` = merge pending. `mergeTaskPr`'s `userId: string` is required at the type
   level; that is the enforcement, not a runtime check.

9. **Scrub at ANY length (F20-7).** The by-value pass in `redactGitOutput` has no minimum. Reject
   tokens shorter than 8 at INPUT (`createPat`), never at scrub time.

10. **A sealed secret that is not in `SEALED_STORES` silently outlives a key rotation.** Any new
    `sealSecret(` call site needs a registry entry **and** a dedicated column (never a JSON blob).

11. **`view`/`comment` have no role tier — their entire enforcement IS the membership gate.** They
    never call `requireAction`. `requireProjectMember` (loaders) or `requireVisibleProject` (actions)
    is the gate, and both must produce the byte-identical 404.

12. **A child route's ACTION runs without its parent's loader**, and single-fetch honors `?_routes=`,
    so a loader-only gate on the layout is not a gate. Every project-scoped loader AND action needs
    its own.

13. **The org-admin override must leave a row every time it is used** (D2). The 60s dedupe key
    includes the caller's `what` so a READ gate cannot mask a WRITE gate (F19-30). The instance-scope
    twin is `controller.authority.denied`.

14. **`occurred_at`, not `created_at`** on `audit_events` — and the reconcile freshness fact is the
    unconditional `github.reconcile.task` audit row, not `MAX(observed_at)` on provenance.

15. **The audit purge now writes before it deletes, and fails CLOSED.** A pass whose JSONL export
    fails reports `auditEvents: 0` and leaves the rows in place. Do not "optimize" the export into a
    best-effort side effect.

16. **`verdictCapable` is frozen at engage time.** `pinnedBackend` is the mirror-image case: it
    deliberately overrides the live profile, including on display.

17. **Force-accept never bypasses a terminal GitHub fact.** While the PR is closed unmerged, the
    force affordance is WITHDRAWN (hidden) and the server refuses too.

18. **A no-change completion needs `defaultBranchEvidence.verified`, on BOTH doors.**

19. **`decisions.md` ruling 35 and the code disagree on the refusal enum.** `PrAdoptionRefusal`
    (`pr-adoption.server.ts:32`) is `merged | closed | no_revision | head_unknown | head_mismatch`.
    Read the code, not the ruling, for the enum. (`decisions.md` carries a dated A2 correction.)

20. **There is no `pr-divergence-*.server.ts` source file** — the ghost test was renamed
    `pr-divergence-wake.server.test.ts` (C8). The seam is `OperatorWake` / `ctx.wakeOperator`.

21. **`recommend` is not a widening anywhere it matters.** Specialist → coerced DOWN to `off`; for
    `report-validation-verdict` it is not authoritative and falls to the catalog default `off`; full
    autonomy promotes `recommend → direct` for every capability **except**
    `completion-for-acceptance`.

22. **Repo-write parity now binds on BOTH backends (ruling 101).** `execute-code-or-write-repo` is in
    `ENFORCED_CAPABILITY_IDS`, not the claude-only set. A withheld family forces the Codex read-only
    sandbox — except the evidence-granted carve-out, which widens to `workspace-write` and never to
    `danger-full-access`. Moving it back to claude-only is the regression.

23. **Absent GitHub keys mean UNKNOWN, not false.** `pr-linker` sets `review`, `approvals` and
    `mergeable` only when it actually read them.

24. **A supporting engagement's clone is destructive.** Two overlapping runs of the SAME supporting
    engagement are refused 409.

25. **`AcceptDisclosure` is a historical name.** The live component is `AcceptConfirm`; the server
    contract is `app/shared/acceptance-disclosure.ts` + `assertAcceptanceDisclosure`. Error codes:
    `accept_disclosure_missing` (400), `accept_disclosure_stale` (409).

26. **`getReviewQueue` requires `viewerUserId`.**

27. **`viberr_ops` is non-removable BY CONSTRUCTION, not by a guard.** `buildControllerMounts` reads
    no config and writes no grant row; the mount key is reserved at the writer, the picker AND the
    resolver. A disabled toggle here would be the P14-KM-14 toggle-with-no-effect.

28. **Controller locks are enforced in `saveControllerConfig`, not the route** — and a locked section
    round-trips the STORED grants byte-for-byte, including duplicates and order, so no save can
    perturb the on-disk list.

---

## 9. Findings for the pass-32 ledger

**F32-A · `instance_health` leaks a deployment host path that ruling 107 explicitly gated its
sibling for.** `healthSnapshot` includes `browser: {status:"unavailable", reason}`
(`app/server/ops/health-snapshot.server.ts:108`–`:110`), and `browserRuntimeStatus`
(`app/server/tasks/specialist-browser-mcp.server.ts:118`) builds that reason as
`` `the pinned browser executable (VIBERR_BROWSER_EXECUTABLE=${executable}) is not on disk` `` — an
absolute host path. The ruling-107 review moved `backendCredentialHealth.detail` behind
`requireOrgAdmin` precisely because "a member of no project was reading a host path through an
ungated tool" (`decisions.md:1567`), and the tool's own comment
(`controller-ops-mcp.server.ts:167`–`:177`) enumerates what stays ungated as "aggregate counts, the
lock holder's pid and host, free bytes, build identity" — it does not mention `browser.reason`. The
same string is also on the unauthenticated `/resources/health` body, whose docstring claims it
"exposes only aggregate counts, never data" (`app/routes/resources.health.ts:8`–`:9`).
**Why it matters:** the credential-detail gate is now inconsistent with its own stated rule, and any
signed-in user (member of no project) can ask the controller for a deployment filesystem path.
**Confidence: high** (verified in source; the ruling's own reasoning is the standard it fails).

**F32-B · The collision remedy can close a third party's PR and then report "not cleared / nothing
was re-delivered".** `resolveRemoteBranchCollision`
(`app/server/github/github-reconciler.server.ts:1604`–`:1632`) closes the recorded unowned PR FIRST,
then calls `deleteTaskRemoteBranch` (`:1636`), which can refuse for reasons that are not transient —
the branch is the project default (`:1483`), this task's own PR is open on it (`:1490`), GitHub is
unreachable or answers non-422 (`:1550`–`:1557`). On any of those the function returns
`{status:"refused"}` and the resolver writes
*"The branch collision was **not** cleared: … Nothing was re-delivered."*
(`app/server/tasks/task-actions.server.ts:6878`). A PR **was** closed, and the refusal sentence says
nothing about it. The close is separately disclosed on the timeline and audited
(`github.pr.closed_unowned`, `:1625`), so the record is not lost — but the sentence a human reads at
the point of failure names the wrong outcome, and there is no re-open.
**Confidence: high** on the ordering and the copy; **medium** on how often a refusal follows a
successful close in practice.

**F32-C · `resolveRemoteBranchCollision` non-null-asserts `actor.userId` with no guard, while its
sibling refuses.** `github-reconciler.server.ts:1618` writes
`actor: { kind: "human", userId: actor.userId!, nameHint: userName(db, actor.userId!) }` for the
PR-close timeline event. `deleteTaskRemoteBranch` guards the same field up front and refuses
("No acting user.", `:1473`) because "branch deletion is a HUMAN decision". The only production
caller happens to guard it (`task-actions.server.ts:6846` — `option.kind ===
"resolve_remote_collision" && actor.userId`), but the function is exported and the PR close runs
BEFORE the guarded delete, so a system/operator actor reaching it would close a PR and write a
`{kind:"human", userId: undefined}` event.
**Why it matters:** latent — an exported audited-write path whose human-only precondition is asserted
rather than enforced, in a family where the sibling enforces it.
**Confidence: high** that the asymmetry exists; **low** that it is currently reachable.

**F32-D · A 403 on the collision remedy's PR close opens no scope violation.** Every other
`pull_request:write` operation flags one on 403 — `openTaskPr`
(`app/server/github/pr-open.server.ts:600`) and `mergeTaskPr`
(`github-reconciler.server.ts:1408`). The `PATCH …/pulls/<n>` at `:1604` treats every failure as
best-effort and records nothing, so a credential missing `pull_request:write` produces a silent
half-remedy with no chip, no timeline policy event and no `github.scope_violation.opened` row.
**Confidence: high** (no `flagScopeViolation` call anywhere in that block).

**F32-E · `saveControllerConfig`'s comment promises a refusal the code does not give for a CLEAR.**
`app/server/controller/controller-profile.server.ts:215`–`:220` states the locked-section rule as
"an empty list … keeps the stored value; a NON-empty list that changes it is refused … so a scripted
caller is told rather than silently ignored." `resolveGrant` (`:235`–`:245`) only refuses when
`input[section].length > 0`, so a scripted caller that posts an EMPTY list intending to CLEAR the
grants is exactly the case that is silently ignored. The blank-keeps behaviour is deliberate (the
panel posts blank for a read-only section) — the comment's claim is what overreaches.
**Confidence: high** (the two are adjacent in the same function).

**F32-F · `decisions.md`'s route map omits two shipped routes.** The map at `decisions.md:1640`–`:1655`
lists `/org/settings` but not `/org/settings/audit-export` (`app/routes.ts:31`, the org-admin audit
download) and not `/insights` (`app/routes.ts:33`, org-admin instance analytics). The map already
carries a dated correction note for four earlier omissions (`:1657`), so the omission pattern is
known; these two are newer.
**Why it matters:** the route map is the canon a reviewer checks a new surface against; a missing
org-admin download route is the kind of gap an audit reads as "no such surface".
**Confidence: high.**

**F32-G · `/resources/run-log`'s own docstring names a response shape the tool contract just
disowned.** `app/routes/resources.run-log.ts:39`–`:40` documents the return as
`{ runId, threadId, state, headSeq, oldestSeq, hasMore, lines }`, and `:25`–`:28` instructs a reader
to page on `hasMore: false`. That is still TRUE for the route (`getRunLog` is unchanged), but ruling
107 established that those three are page-local console cursors that a second consumer reads as facts
about the run (`decisions.md:1583`–`:1587`; `controller-ops-mcp.server.ts:275`–`:279`). Two consumers
now read the same endpoint under opposite documentation.
**Why it matters:** drift risk, not a defect — the next consumer of this route will read the
docstring, not the ruling. **Confidence: high** on the divergence; it is documentation, not behavior.

**F32-H · `github.pr.closed_unowned` is locked outside the designated audit-coverage file.** The
new action is written at `github-reconciler.server.ts:1625` and IS asserted — but at
`app/server/tasks/task-governance.server.test.ts:1466`, not in
`app/server/audit/audit-coverage.server.test.ts`, whose stated job is to "drive governed entry points
for their EFFECT and assert the row lands" and which §5.2 names as "the test to extend when adding a
governed action". Closing a PR that belongs to someone else is the most consequential single GitHub
write the new verb performs, so it belongs in the file a reviewer reads to answer "is every governed
action audited".
**Confidence: high** on where the lock lives; severity **low** — behavior is covered, the convention
is not followed.

**F32-I · `MIRROR_TIMEOUT_MS` became a one-line alias with no distinct value.** `app/server/tasks/repo-mirror.server.ts:199` now reads
`const mirrorTimeoutMs = (): number => cloneTimeoutMs();` with a comment explaining that the first
mirror clone gets the clone budget — but it is now a pure alias with no distinct value, used once
(`:344`). Harmless; noted so a later pass does not read it as a separate knob.
**Confidence: high** (trivially verifiable); severity: cosmetic.

**F32-J · `execute-code-or-write-repo` is listed TWICE in `ENFORCED_CAPABILITY_IDS`, and was in
both enforcement sets before ruling 101.** The literal appears at
`app/shared/capabilities.ts:228` and again at `:259`. `git show f868f131:app/shared/capabilities.ts`
confirms `:228` predates the parity change, and that the same id was simultaneously in
`CLAUDE_ONLY_ENFORCED_CAPABILITY_IDS` (`:273` in the old file) — so before 2026-08-31 the capability
sat in BOTH sets, and `capabilityEnforcement` resolved it to `"claude-only"` only because `:303`
is tested before `:304`. The parity commit removed the claude-only entry and ADDED a second
ENFORCED entry rather than noticing the existing one, and its comment (`:253`–`:258`) says the family
"binds on BOTH backends again … moves back to ENFORCED_CAPABILITY_IDS" — it never left.
**Why it matters:** it is a `Set`, so behavior is correct today; but the two sets are not disjoint by
construction and nothing enforces that, so the next capability added to both will silently resolve by
list order instead of by intent, and the duplicate makes the ruling's own history note misleading.
**Confidence: high** (both lines verified in the current file and in the base commit).
