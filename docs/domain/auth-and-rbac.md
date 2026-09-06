# Authentication, authorization, org administration and audit

> How people sign in, what each role may do, how org admins run the instance,
> and what the audit trail records. Source of truth: `app/lib/auth.server.ts`,
> `app/server/auth/*`, `app/shared/rbac.ts`, `app/server/org/*`,
> `app/server/audit/*`, `app/server/db/retention.server.ts`. Verified against
> `main` @ `68b5480` (2026-09-01).
>
> Updated 2026-09-02 for ruling 127 (branch `claude/per-user-codex-auth-difdnn`):
> §5 gains the `profile.backend.*` audit family and §7 describes the Agent accounts
> panel. Agent backends now authenticate per person; there is no deployment-wide
> Claude or Codex credential to administer.

## 1. Authentication

Viberr runs on **better-auth 1.6.25 with no plugins**. better-auth owns
credentials, sessions and the OAuth handshake; the app's `users` table stays the
canonical profile and org-role store. The one invariant binding them is that the
better-auth `user.id` equals `users.id`; `provisionIdentity` writes the identity at
the moment a user is created (bootstrap, invite, OAuth). There is no
`organization` / `member` / `invitation` table and no org plugin; org role lives
only in `users.role`.

| Item | Value |
|---|---|
| Mount | `/api/auth/*` (`AUTH_BASE_PATH`), GET and POST forwarded to `getAuth().handler`. Only six endpoints are allowed (`/sign-in/email`, `/sign-in/social`, `/callback/:id`, `/error`, `/get-session`, `/sign-out`); every other better-auth endpoint answers 404. |
| Cookie | `viberr.session_token` (`cookiePrefix: "viberr"`), signed with `BETTER_AUTH_SECRET ?? VIBERR_SESSION_SECRET`. With an `https://` `BETTER_AUTH_URL` in production better-auth issues `__Secure-` cookies; an `http://` non-loopback origin in production only produces a boot warning. |
| Session | 30-day rolling, slid at most once a day. The renewal `Set-Cookie` is captured by `authenticateWithHeaders` and forwarded by the root loader, so active users are not signed out at login + 30 days. Expired rows are never honoured and are not pruned on a timer. |
| Passwords | better-auth's own scrypt, stored as `<saltHex>:<keyHex>` in the `account` row with `providerId = 'credential'`. Minimum 8 characters. A legacy `scrypt$…` hash is not verifiable; only the seed CLI re-hashes such a row. `users` has no password column. |
| Sign-up | Disabled. Accounts exist only because an admin created or whitelisted them (§2). |
| Login | `POST /login` `intent=login`: origin check (no session yet), pre-checks on `users` (unknown, disabled, no password) that each consume a throttle token, then better-auth `/sign-in/email`. Success records `users.last_login_at` and audits `auth.login.success`; failures audit `auth.login.failure` / `auth.login.rate_limited`. Unknown email and OAuth-only accounts share one error string. |
| Throttle | App-level token buckets replace better-auth's limiter on the two sign-in paths: 10 attempts per `email\|ip` per 15 minutes (continuous refill), 30 social starts per `provider\|ip` per minute, 10 PAT validations per actor per 5 minutes. `X-Forwarded-For` is honoured only when `VIBERR_TRUST_PROXY=N` (Nth hop from the right); otherwise the ip is the literal `local`. Per-process, in memory. |
| Forced reset | `users.pwreset_required` is set by the boot-generated bootstrap password, by admin-created temp passwords and by admin resets. `requireAuth` redirects to `/login` until `intent=set-password` completes it (audit `auth.password.forced_reset_completed`; other sessions are deliberately left alive). There is no self-service "forgot password". |
| Bootstrap admin | `seedInitialAdmin` runs only while `users` is empty: boot uses `VIBERR_SEED_ADMIN_EMAIL` / `VIBERR_SEED_ADMIN_PASSWORD` or `admin@viberr.dev` with a random one-time password logged once as `VIBERR BOOTSTRAP ADMIN` (reset forced); the seed CLI uses the known dev default. Audit `org.user.created {bootstrap: true}`. |
| Disabled users | The auth guard deletes the session of a disabled or vanished user and treats the request as signed out; `isOrgAdmin` requires `disabled = 0`. |
| Logout | `POST /logout` with CSRF, audit `auth.logout`, better-auth `signOut`, redirect to `/login`. |

### CSRF for app routes

Two independent layers, both required (`app/server/auth/csrf.server.ts`):

1. **Origin proof**: `Sec-Fetch-Site` must be `same-origin` or `none`; `Origin`
   must match; a `Referer`, if present, must be same-origin; **a request with none
   of the three is refused** (fails closed).
2. **Double-submit token**: `HMAC-SHA256(VIBERR_SESSION_SECRET, "viberr-csrf:" +
   sessionId)`, issued by the root loader and rendered by `<CsrfInput />` as
   `_csrf` (or the `X-Csrf-Token` header), compared with `timingSafeEqual`.

`requireFormAction(request)` is the preamble every route action uses: auth → db →
formData → CSRF → `{ auth, db, formData, actor, intent }`. Document-form routes let
the 403 hit the error boundary; fetcher routes return `{ ok: false, error }` through
`csrfError` so the UI stays up. `/api/auth/*` is exempt (better-auth's own
`trustedOrigins` check) and the login action runs the origin check only.

## 2. OAuth sign-in and the whitelist

Providers are GitHub (`read:user user:email`, `githubHandle` captured) and Google
(offline access, account chooser). Callback path: `/api/auth/callback/<provider>`.
Configuration has two sources with a clear precedence (ruling 72):

- **The deployment env** (`GITHUB_OAUTH_*`, `GOOGLE_OAUTH_*`) is the bootstrap default.
- **An `oauth_providers` row**, edited on Org settings → Sign-in & SSO, **overrides
  the env**, even to switch a provider off. Saving never enables; changing either half
  of the pair clears the verdict and disables; enabling requires a passing credential
  test against the provider (`oauth-credential-test.server.ts`, which proves the
  client id and secret, not the callback registration); the running auth handler picks
  changes up per request via `oauthConfigFingerprint`. Audit
  `org.oauth_provider.created|updated|tested|enabled|disabled|removed`.

The login page renders provider buttons only for configured providers; with none
configured the local form leads.

**Whitelist, no open sign-up.** A new social sign-in is accepted only when
(`isOAuthWhitelisted`):

- the provider-verified email already has a non-disabled `users` row (any idp), in
  which case better-auth links the account and `linkOAuth` stamps `users.idp`; or
- the provider is **Google** and the email's domain is in `google_domain_allowlist`
  (joins with the domain's configured org role); or
- the provider is **GitHub** and a placeholder row `github.com/<handle>` exists,
  created by an admin's "allow GitHub handle" (claimed and replaced on first sign-in,
  audit `auth.oauth.placeholder_claimed`).

Anything else is refused by the `user.create.before` hook. Account linking trusts
only the `credential` provider, so an unverified provider email can never auto-link.

## 3. Roles

### Org roles

`users.role` is `admin | member` (CHECK-constrained). Org admins alone reach
`/org/settings` (every tab and intent), `/org/settings/audit-export`, `/insights`,
the Home re-scan and rebuild actions, and everyone's controller transcripts. Any
signed-in user may **create a project** and becomes its project admin (FR5). The last
active org admin cannot be demoted, disabled or removed, and nobody can demote,
disable or remove themselves.

### Project roles

`admin | maintainer | contributor | viewer`, a strict tier, stored in `project.md`
`members[]` and read live by every guard. `app/shared/rbac.ts` is the single table
the guards and the Policy page share:

| Action | admin | maintainer | contributor | viewer |
|---|---|---|---|---|
| `view`, `comment` | ✓ | ✓ | ✓ | ✓ |
| `create-task`, `own-task`, `edit-task-meta` (priority, labels, due date and, ruling 131, what a task waits on) | ✓ | ✓ | ✓ | |
| `approve-transition`, `resolve-packet`, `accept-completion`, `update-goal`, `run-agents`, `reorder-board`, `reconcile-github`, `grant-github-scope`, `rescan-project` | ✓ | ✓ | | |
| `release-any-ownership`, `manage-members`, `manage-agents`, `edit-policy`, `force-accept-completion` | ✓ | | | |

Beyond the table: a task's **owner** (contributor or above) may accept their own
task and govern any open decision on it; membership invites join in the seat the
inviter names and as `viewer` when they name none, in one write with one audit row
(pass 34, C4: an unknown role is refused by name, against the same single enum
`setMemberRole` parses; invite is membership, no accept step); the last live project admin cannot be
demoted or removed; deleting an org account prunes its memberships from every
`project.md` and releases its tasks. `edit-policy` also covers project settings,
stages, the repository, archive and delete. Every boundary into the terminal stage
must stay `human`; the Policy page refuses anything else.

### Enforcement paths

`resolveProjectAuthority` is the one resolver. Outcomes: the member role suffices
(no audit); the actor is an **org admin** and gets `role: admin` as the audited
emergency override (`project.org_admin.override`, repeats collapsed per minute);
or a denial audited as `project.authority.denied` (silent only on the `@mention`
run-agents probe). Reads go through the workspace layout loader and
`requireProjectMember`, which return the **same 404 bytes** for a non-member and for
an unknown slug (ruling 25); actions go through `requireVisibleProject` before any
try block. Config surfaces use `assertProjectAction`, which re-reads `project.md`
and refuses an archived project with 409 unless `allowArchived`.

"Guest" is not a role: it is a render-only pill on a timeline author who is no
longer a member.

### Agent authority

Agents are governed by capability grants, not roles; see
[agents-and-runtime.md](agents-and-runtime.md). The three always-human capabilities
(`merge-pull-request`, `transition-to-done`, `change-project-policy`) are forced to
`human` on every write path, denied at the tool layer and labelled so.

## 4. Org settings (`/org/settings`, org admin only)

Tabs ride `?tab=`: `connections`, `users`, `sso`, `resources`, `controller`; below
the tabs sit the Audit log card and the run-concurrency control.

- **GitHub connections**: owner + PAT. Nothing is saved unless the PAT validates
  against `repo` + `pull_request:write` and the owner exists; the first connection
  becomes the default; the default cannot be removed; removing a connection deletes
  its PAT and cascades every project binding. A `valid` verdict older than 24 hours is
  re-proven before use. Audit `org.connection.*`, `github.pat.*`.
- **Users & access**: allow access by local account (temp password shown once, reset
  forced), Google account, Google domain, or GitHub handle; edit name/email; change org
  role; reset password (revokes all sessions); disable/enable (disable revokes
  sessions); remove (prunes memberships, releases tasks, retires the person's agent
  accounts, deletes the identity). Removal runs the vendor's own logout and deletes the
  sign-in file from that person's runtime home before the row cascades (ruling 127) —
  the row goes with the account either way, but nothing else would ever remove a live
  Claude.ai / ChatGPT credential from this server, and the person can no longer reach
  Disconnect to revoke it themselves; the audit detail lists `backendsRetired`, and
  transcripts stay. Status pills: whitelisted, password reset pending, disabled. Audit
  `org.user.*`, `org.domain.*`, `auth.password.reset`.
- **Sign-in & SSO**: §2.
- **Agent resources**: knowledge bases (`name`, `dir`, refresh `on change | manual`,
  re-index, delete), MCP servers (`HTTP` or `stdio`, target, sealed credential; saving
  runs a real `initialize` → `tools/list` handshake, stdio children get a filtered env
  plus `MCP_CREDENTIAL`, first-run installers finish in a 15-minute background warm-up;
  reserved names refused), skills (`skills/<name>/SKILL.md` plus files), global agent
  templates (specialists only, created with conservative grants, undeletable while
  deployed), and the store browser (upload, folders, doc editing, GitHub import).
  Renames rewrite every template and deployment reference. Audit `org.kb.*`,
  `org.mcp.*`, `org.skill.*`, `org.store.*`, `org.agent_profile.*`.
- **Controller**: see [controller-and-goals.md §6](controller-and-goals.md#6-configuring-the-controller-rulings-106-and-108).
- **Run concurrency**: `set-concurrency` writes `maxConcurrentRuns` (0 = unlimited,
  ceiling 64) and drains the queue.
- **Audit log card**: §5.

## 5. Audit

`recordAudit` writes `audit_events(id, occurred_at, actor_user_id, actor_label,
action, subject_kind, subject_id, project_slug, task_key, details_json)`; details
must be secret-free and recording never breaks the action. Actors: a user, the
`system` actor, the `operator` actor, or a controller-driven human labelled
`<email> · via controller`. Rows with a null `project_slug` are org or instance
scoped.

Action families (about 145 distinct strings; the authoritative list is a grep for
`recordAudit` under `app/`): `auth.*`, `identity.*`, `profile.*`, `org.user.*`,
`org.domain.*`, `org.oauth_provider.*`, `org.connection.*`, `org.kb.*`, `org.mcp.*`,
`org.skill.*`, `org.store.*`, `org.agent_profile.*`, `org.controller.updated`,
`github.pat.*`, `github.credential.*`, `project.*` (including
`project.org_admin.override` and `project.authority.denied`), `task.*` (creation,
goal, metadata, comments, transitions, ownership, packets, acceptance,
recommendations, quality, schedules, agent and operator actions), `goal.*`,
`github.*` (branches, PRs, delivery, reconcile, workspace, scope violations),
`runtime.run.*`, `runtime.operator.plan_executed`, `run.recovery.*`,
`controller.authority.denied`, `projection.rescan|rebuild`, `seed.*`,
`secrets.resealed`, `store.restored`.

**`profile.backend.*` (ruling 127).** Connecting or dropping a personal agent account
is governed, because it changes whose provider account this instance's runs bill. Five
actions, all instance-scoped (no `project_slug`, no `task_key`), actor the person
themselves: `profile.backend.login_started` {backend, method} when the vendor's own
binary is spawned, `profile.backend.login_failed` {backend, method, reason} on a
non-zero exit, an unconfirmed sign-in or the 15/16-minute timeout,
`profile.backend.login_cancelled` {backend, method}, `profile.backend.connected`
{backend, kind, method | verified} on success or a saved key, and
`profile.backend.disconnected` {backend, kind}. Subject kind is `backend_login` for
the session rows and `backend_credential` for the stored ones. The `reason` is the
same already-redacted sentence the person sees; a key, a token, a one-time code and a
raw vendor line never reach an audit row.

Where it is read:

- **Org settings → Audit log**: an in-app browse of the newest 150 rows (max 500) with
  a text filter and an org-scope-only toggle; the copy discloses the retention window,
  the export cap and the export-before-purge files.
- **Download**: `GET /org/settings/audit-export?format=csv|json&project=&action=&actor=&since=&until=`,
  newest first, capped at 100 000 rows, CSV with formula-injection neutralization.
- **S3 push**: a single `s3_audit_config` row (bucket, region, prefix, optional
  endpoint, access key, sealed secret) and the `audit-export-s3` intent, which PUTs a
  full export with a hand-rolled SigV4 signature.
- **Project Activity page**: project-scoped rows for members.
- Derived facts: the Policy page's "last change" chip, the GitHub page's "last checked"
  time, and Insights' packet and time-to-review metrics.

Retention: audit rows are hard-deleted after 90 days, **after** being appended
verbatim to `<dataRoot>/audit-exports/audit-events-<date>.jsonl`; an export failure
skips that pass's purge. Two actions boot recovery uses as idempotency keys
(`task.agent.replied`, `runtime.operator.plan_executed`) are exempt. The pass runs at
boot and every 6 hours.

**Reading a controller-driven write** (pass 34, C5). A write the controller makes for a
person is audited under that person with the controller named as the instrument
(`encodeControllerInstrument` in `app/shared/mapping/actor.server.ts`, ruling 99(b)). The
Activity audit column renders it as "<name> (via the controller)" through
`auditActorDisplay`, on both the joined-name and the userless leg. The org Audit log and
`inspect_audit_log` keep the RAW stored label deliberately: they are the forensic
surfaces, and the raw label is what `recordAudit` was handed.

## 6. Insights (`/insights`, org admin only)

One aggregate query over `agent_runs` (`getInsightsSummary`): totals (runs, cost,
coordination share for operator and controller runs, tokens, turns), outcomes and
success rate, breakdowns by backend, kind, project and model (top 8), average
duration, a 30-day daily chart, oversight metrics (owner clarity, branch and PR
traceability, packet resolution times from audit rows, time to review, long
timelines) and the latest backend quota readings. Read-only; nothing here writes.

Branch and PR traceability counts, over the tasks that have **delivered** (a delivered
work revision or a recorded pull request), how many carry both the task branch and a
recorded PR. An allocated branch alone is not a delivery: ruling 122 names the branch at
first dispatch, before an agent has written anything, so a task that only ever engaged a
deliverer stays out of the denominator (ruling 143). A delivered revision with no PR
stays in it on purpose; an unpushed delivery is exactly the untraceable one the number
exists to show. *(Corrected 2026-09-04, pass 34 — U34-9: the denominator used to admit
any task with a branch, and the card read "7 of 8 delivered tasks carry branch + PR"
while one of the eight had delivered nothing.)*

Ruling 130(d) (pass 34): the backend quota panel names whose account a refusal or an
exhaustion was recorded on (`credentialLabel`). That is org-admin information: it names a
person's provider account state, so it reaches this page, the signed-in `instance_health`
read and the person's own Profile card, and never the unauthenticated health body.

## 7. Profile and preferences (`/profile`)

Identity (name, title; audit `profile.updated`), notification routing (eight in-app
opt-out toggles: packets, approvals, mentions, policy, quality, controller,
dependencies (ruling 131) and ownership; enforced inside `createNotification`), appearance (theme `light | dark | system` persisted to
`users.theme` and the `viberr_theme` cookie; default timeline filter — the in-app reduce-motion
setting was removed by ruling 148(c), the OS preference is the one signal),
a read-only "Your access" table rendered from the same RBAC rows, **Agent accounts**
(below), GitHub identity (disconnect flips `idp` back to `local`, refused without a
password), and a self-service password change (ruling 148(b): a "Password" row on the Profile card whose
button opens a modal) that keeps the current session and revokes every other one (audit
`auth.password.changed`). Preferences other than theme
live in `user_prefs`.

### Agent accounts (ruling 127)

The panel sits in the right column above GitHub identity, one `cred-card` per backend,
and it is where a person connects the provider account their agent runs bill: runs on
tasks they own, and their own controller turns. There is no deployment-wide Claude or
Codex credential any more, so this panel is the only place either backend is connected.

Two routes in, both the vendor's own:

- **Hosted sign-in.** `backend-login-start` spawns the UNMODIFIED bundled vendor binary
  (`claude auth login --claudeai` or `--console`; `codex login --device-auth`) with
  `filteredSpawnEnv()` plus that person's own runtime home
  (`<dataRoot>/runtimes/users/<id>/{claude-home,codex-home}`), argv only, never a shell,
  every stream piped. Only the vendor being signed in to has to be installed
  (`resolveBackendBinary`), so a host whose other optional platform package never landed
  still connects the one it has; when the package IS missing the person is told which
  binary is absent and that an admin can reinstall without `--omit=optional`, not a
  generic 500 sentence. The card then shows what the vendor printed: the URL to open, and
  for Codex the one-time code to type on OpenAI's page. Claude asks for the code
  Anthropic displays, which `backend-login-code` writes to the child's stdin and nowhere
  else (empty, whitespace-only and over-long values are refused before stdin). On exit 0
  the driver asks the SAME binary (`claude auth status`, `codex login status`) whether it
  is really signed in, and only that answer writes the row. The session is polled from the
  browser through `/resources/backend-login` every 2 s while it is live; the success toast
  settles on that result, never on the submit. The card renders the flow as two numbered steps
  (2026-09-06): the vendor's link is an "Open sign-in page" button that names its host
  and is never printed in full, Codex's code sits beside a Copy button, and Claude's code
  field is a real labelled input whose Submit follows ruling 147 (enabled, an empty submit
  refused with the field marked and focused). A step marker is pending until its input
  arrives, current while actionable, done once the code is on its way; step 1 is never
  marked done on its own, because nothing server-side can see the link being opened. The
  status line is the ONE polite live region; the step group takes focus when it replaces
  the button that started the flow, because every value in it (the link, the code, the
  status line) arrives from a later poll.
- **A pasted credential.** `backend-set-key` verifies an Anthropic Console or OpenAI
  Platform API key with a FREE `GET /v1/models` probe before sealing it; a ChatGPT
  workspace access token has no free probe and is stored `verified_at = null` with the
  card saying so. `backend-disconnect` runs the vendor's own logout, removes the
  credential file and drops the row (transcripts stay).

**The last refusal Viberr observed** (ruling 130(d), pass 34 F34-1). A connected card
also reads the quota store (`latestBackendRateLimits`) and shows, ONLY when the record's
`credentialUserId` is the viewer, a `risk` pill "refused by the provider · <when>" with
the provider's own sentence in a "Last refusal" row, or a neutral "usage window spent ·
reopens <when>" pill with a "Usage window" row. The copy says what the pill is: the last
refusal Viberr observed on this account, which any completed run on that backend
retires, so the absence of a pill is not proof the account works. Another person's
refusal, or a record written before principals were stored, never appears on this card.

Viberr never implements the vendors' OAuth, never reads, copies or stores a Claude.ai or
ChatGPT **session** token, and offers no setup-token field: Anthropic's Claude Code
legal page requires a hosting platform to have each end user authenticate with their own
credentials through Anthropic's own flow, and forbids collecting or storing Claude.ai
session tokens. The one vendor-issued token Viberr ever holds is the ChatGPT workspace
access token a person deliberately pastes: an `access_token` row, sealed like any API
key and never returned to a loader. A `login` row therefore holds no secret at all; the
vendor's own client owns the credential file inside that person's home, and availability
is re-probed from the filesystem on every read, so a wiped runtime volume reads as "sign
in again" the moment it happens. Pasted keys are sealed (AES-256-GCM) and registered in
`SEALED_STORES`, so a key rotation reaches them; only the last four characters ever
reach a loader. One sign-in runs per person per backend; starting another cancels the
first (SIGTERM, then SIGKILL five seconds later), and a session that ends stays readable
for ten minutes so the card can report the outcome. A sign-in already connected is not a
reason to hide a running one: the in-progress card renders over the connected card until
the flow ends, which is how a key is replaced by a hosted sign-in, and a card whose
credential file has vanished offers the sign-in its own sentence names, beside
Disconnect.

## 8. Known drift in older documents

- `design/better-auth-migration.md` still describes the better-auth `organization`
  plugin, `member`/`invitation` tables, a legacy `scrypt$…` compatibility hook and a
  password backfill. None of these exist; treat that file as history.
- The README's "Enabling OAuth sign-in" describes env-only configuration; the in-app
  Sign-in & SSO tab overrides the env. Its "Known gaps" entries about a missing org
  audit console and a missing audit export are out of date.
- `docs/architecture/decisions.md` ruling 2 says the schema tolerates an org role of
  `viewer`; the CHECK constraint admits only `admin | member` (TypeScript coerces
  anything else to `member`).
