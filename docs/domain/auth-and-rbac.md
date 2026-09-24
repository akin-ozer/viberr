# Authentication, authorization, org administration and audit

> How people sign in, what each role may do, how org admins run the instance, what the
> audit trail records, and what Insights and the Profile page show.
> Source of truth: `app/lib/auth.server.ts`, `app/server/auth/*`, `app/shared/rbac.ts`,
> `app/server/org/*`, `app/server/settings/instance-settings.server.ts`,
> `app/server/audit/*`, `app/server/db/retention.server.ts`,
> `app/server/insights/insights-query.server.ts`, `app/features/profile/*`,
> `app/server/runtimes/backend-credentials.server.ts`.
> Verified against `main` @ `7d9fbf72` (2026-09-23).

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
| Mount | `/api/auth/*` (`AUTH_BASE_PATH`), GET and POST forwarded to `getAuth().handler`. Only six endpoints are allowed (`ALLOWED_AUTH_PATHS`: `/sign-in/email`, `/sign-in/social`, `/callback/:id`, `/error`, `/get-session`, `/sign-out`); every other better-auth endpoint answers 404. |
| Cookie | `viberr.session_token` (`cookiePrefix: "viberr"`), signed with `BETTER_AUTH_SECRET ?? VIBERR_SESSION_SECRET`. With an `https://` `BETTER_AUTH_URL` in production better-auth issues `__Secure-` cookies; an `http://` non-loopback origin in production only produces a boot warning. |
| Session | 30-day rolling, slid at most once a day. The renewal `Set-Cookie` is captured by `authenticateWithHeaders` and forwarded by root's `sessionRenewalMiddleware` on whichever GET resolved the session (ruling 454: root's loader no longer runs on every request), so active users are not signed out at login + 30 days. Expired rows are never honoured and are not pruned on a timer. A GET or HEAD resolves its session once however many loaders and guards ask (the router hands them one Request; ruling 454); a POST resolves on every call. |
| Passwords | better-auth's own scrypt, stored as `<saltHex>:<keyHex>` in the `account` row with `providerId = 'credential'`. Minimum 8 characters (`MIN_PASSWORD_LENGTH`). A legacy `scrypt$…` hash is not verifiable; only the seed CLI re-hashes such a row. `users` has no password column. |
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

`requireFormAction(request)` is the preamble most route actions use: auth → db →
formData → CSRF → `{ auth, db, formData, actor, intent }`. Document-form routes let
the 403 hit the error boundary; fetcher routes (`/controller`, `/projects/:slug/controller`,
`/profile`, `/notifications/read`, `/prefs/theme`, `/resources/controller`) call
`csrfError` instead and return `{ ok: false, error }` so the UI stays up. `/api/auth/*`
is exempt (better-auth's own `trustedOrigins` check); `/login`'s `login` intent runs the
origin check only (`assertTrustedOrigin`, there is no session yet), and its
`set-password` intent the full check.

## 2. OAuth sign-in and the whitelist

Providers are GitHub (`read:user user:email`, `githubHandle` captured) and Google
(offline access, account chooser). Callback path: `/api/auth/callback/<provider>`.
Configuration has two sources with a clear precedence (ruling 72):

- **The deployment env** (`GITHUB_OAUTH_*`, `GOOGLE_OAUTH_*`) is the bootstrap default.
- **An `oauth_providers` row**, edited on Instance settings → Sign-in & SSO, **overrides
  the env**, even to switch a provider off. Saving never enables; changing either half
  of the pair clears the verdict and disables; enabling requires a passing credential
  test against the provider (`oauth-credential-test.server.ts`, which proves the
  client id and secret, not the callback registration); the running auth handler picks
  changes up per request via `oauthConfigFingerprint`. Audit
  `org.oauth_provider.created|updated|tested|enabled|disabled|removed`.

With at least one provider configured, the login card leads with the two provider
buttons (an unconfigured one renders disabled and says so); with none configured, the
local form leads and sign-in with a provider shrinks to a one-line note.

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
A row provisioned from the allowlist audits `auth.oauth.user_provisioned`; the first
link of a provider account audits `auth.oauth.login`; every new session, credential or
OAuth, runs `recordSignIn` (the `session.create.after` hook), which stamps
`users.last_login_at`, audits `auth.sign_in`, and mirrors a changed GitHub handle from
the provider onto `users.github_handle` with `auth.github_handle.recorded`.

## 3. Roles

### Org roles

`users.role` is `admin | member` (CHECK-constrained). Org admins alone reach
`/org/settings` (every tab and intent), `/org/settings/audit-export`, `/insights`,
the Home store re-scan and rebuild-projections actions, and everyone's controller
transcripts (read, and interrupt a live turn). Any signed-in user may **create a
project** and becomes its project admin (FR5). The last active org admin cannot be
demoted, disabled or removed, and nobody can demote, disable or remove themselves.

### Project roles

`admin | maintainer | contributor | viewer`, a strict tier, stored in `project.md`
`members[]` and read live by every guard. `app/shared/rbac.ts` (`RBAC_DEFINITIONS`,
`ACTION_ROLES`) is the single table the guards, the Policy page and Profile → Your
access share; `app/shared/rbac.test.ts` holds this table to it row by row:

| Action | admin | maintainer | contributor | viewer |
|---|---|---|---|---|
| `view`: view board, tasks and timelines | ✓ | ✓ | ✓ | ✓ |
| `comment`: comment on tasks | ✓ | ✓ | ✓ | ✓ |
| `create-task`: create tasks | ✓ | ✓ | ✓ | |
| `own-task`: take or release your own ownership of a task | ✓ | ✓ | ✓ | |
| `edit-task-meta`: priority, labels and due date, and what a task waits on, which releases it when cleared (rulings 131, 309(a)) | ✓ | ✓ | ✓ | |
| `attach-file`: attach a file to a task (ruling 379) | ✓ | ✓ | ✓ | |
| `approve-transition`: approve stage transitions | ✓ | ✓ | | |
| `resolve-packet`: resolve decision packets | ✓ | ✓ | | |
| `accept-completion`: accept completion into Done | ✓ | ✓ | | |
| `update-goal`: edit the task goal (and its title, ruling 295) | ✓ | ✓ | | |
| `run-agents`: run agents | ✓ | ✓ | | |
| `reorder-board`: reorder the board | ✓ | ✓ | | |
| `reconcile-github`: reconcile GitHub state | ✓ | ✓ | | |
| `grant-github-scope`: grant GitHub scope, and set or clear the project credential | ✓ | ✓ | | |
| `rescan-project`: re-scan project files and projections | ✓ | ✓ | | |
| `release-any-ownership`: release any task owner | ✓ | | | |
| `manage-members`: manage members and roles | ✓ | | | |
| `manage-agents`: manage agent profiles | ✓ | | | |
| `edit-policy`: edit workflow and policy, and archive or restore the project itself | ✓ | | | |
| `force-accept-completion`: force-accept past the review gate | ✓ | | | |

Beyond the table: a task's **owner** (contributor or above) may accept their own
task and govern any open decision on it; membership invites join in the seat the
inviter names and as `viewer` when they name none, in one write with one audit row
(an unknown role is refused by name, against the same single enum `setMemberRole`
parses; an invite is membership, with no accept step); the last live project admin
cannot be demoted or removed; deleting an org account prunes its memberships from
every `project.md` and releases its tasks. `edit-policy` also covers project
settings, stages, required reviewers (ruling 178), file leases (ruling 396), the
rulings knowledge base (ruling 239), the repository, branch cleanup and delete. Every
boundary into the terminal stage must stay `human`; the Policy page refuses anything
else.

### Enforcement paths

`resolveProjectAuthority` is the one resolver. Outcomes: the member role suffices
(no audit); the actor is an **org admin** and gets `role: admin` as the audited
emergency override (`project.org_admin.override`, repeats collapsed per minute);
or a denial audited as `project.authority.denied` (silent only on the `@mention`
run-agents probe). Reads go through the workspace layout loader (and the board
loader, through the same `readWorkspace` read, ruling 454) and `requireProjectMember`,
which return the **same 404 bytes** for a non-member and for an unknown slug (ruling 25); actions go through `requireVisibleProject`
(`app/routes/project-visibility.server.ts`) before any try block. Config surfaces use
`assertProjectAction`, which re-reads `project.md` and refuses an archived project
with 409 unless `allowArchived`.

"Guest" is not a role: it is a render-only pill on a timeline author who is no
longer a member.

### Agent authority

Agents are governed by capability grants, not roles; see
[agents-and-runtime.md](agents-and-runtime.md). The three always-human capabilities
(`merge-pull-request`, `transition-to-done`, `change-project-policy`) are forced to
`human` on every write path, denied at the tool layer and labelled so.

## 4. Instance settings (`/org/settings`, org admin only)

The page is headed "Instance settings", and everything that points at it uses the same
name: the header crumb, the user menu, and the server and agent sentences (the
spending-cap refusals and remedies, the controller's credential and grant-request
replies, the unlinked GitHub approval note). Tabs ride `?tab=`, in this order:
`connections` (the default), `users`, `sso`, `resources`, `controller`. Below the
tabs sit the run-concurrency and spending-cap rows, then the Audit log card.

- **GitHub connections**: owner + PAT. Nothing is saved unless the PAT validates
  against `repo` + `pull_request:write` and the owner exists; the first connection
  becomes the default; the default cannot be removed; removing a connection deletes
  its PAT and cascades every project binding. A `valid` verdict older than 24 hours
  (`CONNECTION_REVALIDATE_AFTER_MS`) is re-proven before use. Audit `org.connection.*`,
  `github.pat.*`.
- **Users & access**: allow access by local account (temp password shown once, reset
  forced), Google account, Google domain, or GitHub handle; edit name/email; link the
  GitHub handle of a local or Google account (ruling 154: the handle whose PR approval
  counts as that person's review verdict under ruling 68; normalized to lower case,
  unique among enabled accounts, refused on a GitHub-signed-in account whose handle
  syncs from the provider; audit `org.user.github_handle.set` / `.cleared` with the
  previous value). The invariant holds at every writer: a GitHub sign-in that carries a
  handle an admin linked elsewhere takes it, clearing the losing row and auditing
  `org.user.github_handle.cleared` with the reason, and enabling an account whose handle
  was linked elsewhere while it was disabled is refused naming the holder. Also: change
  org role; reset password (revokes all sessions); disable/enable (disable revokes
  sessions); remove (prunes memberships, releases tasks, retires the person's agent
  accounts, deletes the identity). Removal runs the vendor's own logout and deletes the
  sign-in file from that person's runtime home before the row cascades (ruling 127):
  nothing else would ever remove a live Claude.ai / ChatGPT credential from this
  server, and the person can no longer reach Disconnect to revoke it themselves; the
  audit detail lists `backendsRetired`, and transcripts stay. Status pills: setup
  pending, whitelisted, password reset pending, disabled; an allowed Google domain
  reads "domain allowlist" with the role it joins as. Audit `org.user.*`,
  `org.domain.*`, `auth.password.reset`.
- **Sign-in & SSO**: §2.
- **Agent resources**: knowledge bases (`name`, `dir`, refresh `on change | manual`,
  re-index, delete), MCP servers (`HTTP` or `stdio`, target, sealed credential; saving
  runs a real `initialize` → `tools/list` handshake, stdio children get a filtered env
  plus `MCP_CREDENTIAL`, first-run installers finish in a 15-minute background warm-up;
  reserved names refused). The MCP editor's "Write tools" section (ruling 176) marks the
  tools that a run withholding repo write, and every operator run, does not get: the
  probe's tool names are offered, the write-looking ones pre-selected until the server
  is first reviewed, a name can be typed, and each change is audited as
  `org.mcp.tool_policy.changed` {name, before, after}. Every server row states where it
  stands on write tools (ruling 220): N withheld from read-only runs, reviewed with none
  withheld, or write-looking tools nobody has reviewed. Skills
  (`skills/<name>/SKILL.md` plus files): every writer (this editor, the controller's
  `save_skill`, an upload and the store browser's document editor) refuses a SKILL.md
  body that is empty, that arrived JSON-escaped (literal `\n` sequences, no real
  newline) or whose frontmatter block does not parse, by name and never rewritten,
  through `assertSkillBodyWellFormed` in `skill-body.server.ts` (ruling 183); plain
  markdown with no block stays valid, and an empty submission on an existing skill keeps
  the file. Global agent templates (specialists only, created with conservative grants,
  undeletable while deployed; the edit modal's "Copy these grants to the N projects that
  adopted this profile" box rewrites each adopted project's copy of the grants with the
  save, ruling 156). The store browser (upload, folders, doc editing, GitHub import).
  Renames rewrite every template and deployment reference. Audit `org.kb.*`,
  `org.mcp.*`, `org.skill.*`, `org.store.*`, `org.agent_profile.*` (the `updated`
  row's details carry `diverged` and `propagated` project slugs), and one
  `project.agent_profile.resources_synced` row per project a propagation rewrote.
- **Controller**: model and effort are always editable; the grant lists and the
  doctrine body are deployment-locked (ruling 108); a note lists the grants the
  controller asked for and cannot make (`request_resource_grant`, ruling 390), each
  naming its unlock variable and the restart. A save that leaves the resource granted
  answers the request, and each one has a Decline button (`controller-request-decline`).
  See
  [controller-and-goals.md §6](controller-and-goals.md#6-configuring-the-controller-rulings-106-and-108).
- **Run concurrency**: `set-concurrency` writes `maxConcurrentRuns` (0 = unlimited,
  ceiling 64, `MAX_CONCURRENT_RUNS_CEILING`) and drains the queue. The control shows the
  cap, the live and queued counts, and under the field, for a positive cap, the lane
  sentence of ruling 152(b): "Cap N: up to N agent runs at once, plus M slots for
  operator and controller turns so a decision is not stuck behind the builds it is
  about." M is the lane the server derived (`coordinationLane`, `max(1, ceil(cap / 4))`),
  printed rather than stated as a rule. That is why a cap of 2 can show three runs live;
  the extra one is an operator or controller turn
  ([agents-and-runtime.md §3.2](agents-and-runtime.md#32-reservation-and-admission)).
- **Spending cap** (ruling 175): the second row in the same well. `set-run-spend-cap`
  writes `maxRunSpendUsd`, the instance's cap per Claude run in dollars (above zero, at
  most two decimals; blank clears it; none by default; an instance ceiling only, no
  profile field). Every change records `org.run_spend_cap.changed` with the value before
  and after. The row reads "No cap" or "$X per Claude run", and the sentence under it
  says Claude stops a run once it has spent that much while Codex has no budget option.
  Refusals follow ruling 147(d): Save stays live and a bad value is refused in words on
  the click ([agents-and-runtime.md §3.5](agents-and-runtime.md#35-failure-kinds) for the
  cut-off).
- **Audit log card**: §5.

These two instance settings are the only rows the page writes to `instance_settings`
(`app/server/settings/instance-settings.server.ts`).

## 5. Audit

`recordAudit` writes `audit_events(id, occurred_at, actor_user_id, actor_label,
action, subject_kind, subject_id, project_slug, task_key, details_json)`; details
must be secret-free and recording never breaks the action. Actors: a user, the
`system` actor, the `operator` actor, or a controller-driven human labelled
`<email> · via controller`. Rows with a null `project_slug` are org or instance
scoped.

Action families (about 200 distinct strings; the authoritative list is a grep for
`action:` and the `*_AUDIT_ACTION` constants under `app/`): `auth.*`, `identity.*`,
`profile.*`, `org.user.*`, `org.domain.*`, `org.oauth_provider.*`, `org.connection.*`,
`org.kb.*`, `org.mcp.*`, `org.skill.*`, `org.store.*`, `org.agent_profile.*`,
`org.controller.updated`, `org.run_spend_cap.changed` {before, after} (ruling 175),
`org.audit_export.*`, `github.pat.*`, `github.credential.*`, `project.*` (including
`project.org_admin.override`, `project.authority.denied`,
`project.required_reviewers.updated`, `project.file_leases.updated`,
`project.rulings_kb.updated` and `project.stage.recolored`), `task.*` (creation, title,
goal, metadata, dependencies, comments, attachments, transitions, ownership, packets,
acceptance, recommendations, quality, schedules, review deadlocks, agent and operator
actions, session compactions `task.agent.compaction`, ruling proposals
`task.operator.ruling_proposed`), `goal.*`, `github.*` (branches, PRs, delivery,
reconcile, workspace, scope violations, repository bootstrap), `runtime.run.*`,
`runtime.operator.plan_executed`, `run.recovery.*`, `run.completion.effects_lost`
(ruling 207(a)), `controller.authority.denied`, the controller's audited reads
`controller.ops.read`, `controller.repo.read` and `controller.github.read`,
`controller.resource_grant.requested|granted|declined` (ruling 390),
`projection.rescan|rebuild`, `seed.*`, `secrets.resealed`, `store.restored`.

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

**Row shapes worth knowing.**

- `task.engagement.added {posture: "reviewer" | "supporting", profileId, backend, role}`
  records a new engagement (a supporting engagement is not a reviewer, U36-11).
- `task.acceptance.interrupted_runs {cause: "accept" | "force-accept" | "archive",
  runIds}` is written by the closure interrupt (ruling 177) beside one
  `runtime.run.interrupted {reason: "task-closed", cause, closedBy}` row per run, actor
  the system.
- `github.delivery.next_step` carries `{withheld: "verdict-pending" | "verdict-failing",
  validation}` when the delivery card is not written (F36-6).
- `task.transition {boundary: "rework", via: "authored-drift"}` is the reconciler's
  ruling-179 move, actor the system. A `task.transition` row with `by: operator` and
  `boundary: approval` is never written (ruling 151).
- `project.required_reviewers.updated` records the ruling-178 rule (via the controller
  or the project settings form).
- `task.acceptance.forced` carries `bypassed` (the gate sentences joined with " | "),
  `bypassedGates` (the same list), `skippedStages`, `validation` and `withdrawnPacket`
  (U35-3).
- `task.hold.lifted {cause: "operator-run" | "dispatch", trigger?, profileId?,
  byUserId?, previous: "blocked"}` is written by `liftHoldForRun`, actor the person who
  started the operator or the operator actor for a dispatch (ruling 157).
- `task.comment.unrouted` has two shapes: the ambiguous handle, and
  `reason: "run-not-started"` (F35-5).
- `runtime.run.started` carries the run's `credentialUserId` (ruling 127).

Where it is read:

- **Instance settings → Audit log**: an in-app browse of the newest 150 rows (max 500) with
  a text filter and an "Org-scoped" toggle. The org-scoped list is its own SQL query
  (`project_slug IS NULL`), so the toggle shows 150 instance rows rather than filtering
  the unscoped window; both windows leave out `github.reconcile.task`, the poller's
  per-task heartbeat, by name (`BROWSE_HIDDEN_ACTIONS`, ruling 234), which stays in the
  table, the retention sweep and the export. The card's copy states the retention
  window, the export cap and the export-before-purge files.
- **Download**: `GET /org/settings/audit-export?format=csv|json&project=&action=&actor=&since=&until=`,
  newest first, capped at 100 000 rows (`AUDIT_EXPORT_MAX_ROWS`), CSV with
  formula-injection neutralization.
- **S3 push**: a single `s3_audit_config` row (bucket, region, prefix, optional
  endpoint, access key, sealed secret) and the `audit-export-s3` intent, which PUTs a
  full export with a hand-rolled SigV4 signature.
- **Project Activity page**: project-scoped rows for members.
- Derived facts: the Policy page's "last change" chip, the GitHub page's "last checked"
  time, and Insights' packet and time-to-review metrics.

Retention: audit rows are hard-deleted after 90 days (`AUDIT_RETENTION_DAYS`),
**after** being appended verbatim to `<dataRoot>/audit-exports/audit-events-<date>.jsonl`;
an export failure skips that pass's purge. Two actions boot recovery uses as idempotency
keys (`task.agent.replied`, `runtime.operator.plan_executed`) are exempt. The pass runs
at boot, every 6 hours and on disk pressure.

**Reading a controller-driven write** (ruling 99(b)). A write the controller makes for a
person is audited under that person with the controller named as the instrument
(`encodeControllerInstrument` in `app/server/files/actor-ref.server.ts`). The Activity
audit column renders it as "<name> (via the controller)" through `auditActorDisplay`, on
both the joined-name and the userless leg. The org Audit log and `inspect_audit_log`
keep the RAW stored label deliberately: they are the forensic surfaces, and the raw
label is what `recordAudit` was handed.

## 6. Insights (`/insights`, org admin only)

One aggregate read over `agent_runs` and the projections (`getInsightsSummary`), under
the standalone-page header. Read-only; nothing here writes.

- **Totals**: runs, cost, tokens (input, cached input, output), turns. Cost is a
  Claude-only observation (the Codex envelope carries tokens and no price), so every
  cost figure is null, "not reported", where nothing reported one, never $0.00.
- **Coordination share** (operator and controller runs against delivery runs). The
  dollar share is null unless EVERY run on both sides reported a cost (rulings 190,
  201); the card then gives the real dollars and names how many runs, on which backend,
  reported none. A second card gives coordination's share of TOKENS, the unit both
  backends report, null when a side ran and landed no final figure.
- **Outcomes** and success rate; a restart-interrupted run is stopped, not an error,
  and a never-started one is outside the completion rate (ruling 158).
- **Breakdowns** by backend, kind, project, model, task and profile (ruling 308), each
  the top 8 (half the slots reserved for the busiest groups) with `hidden`,
  `hiddenRuns` and `hiddenCost` naming what the window left out. A task row is labelled
  `project/task`.
- **Prompt cache** table (ruling 369), by run kind and by credential kind: runs, the
  warm-start rate over runs with a first call ("n/a" with none), tokens written and
  read, the write/read ratio, first calls writing over 100k, and each cache lifetime's
  count. A write figure is null for groups with no run on a backend that reports one
  (`CACHE_WRITE_REPORTING_BACKENDS`, Claude only; ruling 395).
- Average duration and a 30-day daily chart.
- **Oversight**: owner clarity (active tasks with a definite next actor), branch and PR
  traceability, packet resolution times from audit rows, time to review, and long
  timelines. Each card that counts exceptions names them by key, linked, capped at
  `INSIGHTS_NAMED_EXCEPTIONS` (8) with the remainder counted (ruling 290).
- **Backend quota** readings.

Branch and PR traceability counts, over the tasks that have **delivered** (a delivered
work revision or a recorded pull request), how many carry both the task branch and a
recorded PR. An allocated branch alone is not a delivery: ruling 122 names the branch at
first dispatch, before an agent has written anything, so a task that only ever engaged a
deliverer stays out of the denominator (ruling 143). A finished task whose delivery was
never commit-shaped (terminal, no PR, no commits, e.g. a report delivered as
attachments) is out of it too (ruling 407). A delivered revision with no PR stays in it
on purpose; an unpushed delivery is exactly the untraceable one the number exists to
show.

The backend quota panel names whose account a refusal or an exhaustion was recorded on
(`credentialLabel`, ruling 130(d)). That is org-admin information: it names a person's
provider account state, so it reaches this page, the signed-in `instance_health` read and
the person's own Profile card, and never the unauthenticated health body. A reading, a
refusal and an exhaustion all retire when the account they describe changes
(`retireBackendRecordsFor`, rulings 165 and 294).

## 7. Profile and preferences (`/profile`)

The page renders inside a `PageOverlay` in two columns. Left: the Profile card
(identity: name and title, audit `profile.updated`; a "Password" row whose button opens
the change-password modal, ruling 148(b)), notification routing and appearance. Right:
"Your access", **Agent accounts** (below) and GitHub identity.

- **Notification routing**: eight in-app opt-out toggles (`NOTIF_PREF_CATEGORIES`:
  packets, approvals, mentions, policy, quality, controller, dependencies, ownership),
  each mapped from one notification kind and enforced inside `createNotification`: an
  off category means the row is never written.
- **Appearance & workspace**: theme `light | dark | system`, persisted to `users.theme`
  and the `viberr_theme` cookie; the timeline's default filter. There is no in-app
  reduce-motion setting (ruling 148(c)); the OS preference is the one signal.
- **Your access**: a read-only table rendered from the same RBAC rows.
- **GitHub identity**: disconnect flips `idp` back to `local` (audit
  `identity.github.disconnected`), refused without a password. On a deployment without
  GitHub sign-in the card shows an admin-linked handle as `@handle · linked by an org
  admin` and says what the link does (ruling 154); the person cannot set their own handle
  because the verdict path counts approvals by it.
- **Password**: a self-service change that keeps the current session and revokes every
  other one (audit `auth.password.changed`).

Preferences other than theme live in `user_prefs`.

### Agent accounts (ruling 127)

The panel holds one `cred-card` per backend, and it is where a person connects the
provider account their agent runs bill: runs on tasks they own, and their own controller
turns. There is no deployment-wide Claude or Codex credential, so this panel is the only
place either backend is connected.

Two routes in, both the vendor's own:

- **Hosted sign-in.** `backend-login-start` spawns the UNMODIFIED bundled vendor binary
  (`claude auth login --claudeai` or `--console`; `codex login --device-auth`) with
  `filteredSpawnEnv()` plus that person's own runtime home
  (`<dataRoot>/runtimes/users/<id>/{claude-home,codex-home}`), argv only, never a shell,
  every stream piped. Only the vendor being signed in to has to be installed
  (`resolveBackendBinary`), so a host whose other optional platform package never landed
  still connects the one it has; when the package IS missing the person is told which
  binary is absent and that an admin can reinstall without `--omit=optional`. The card
  then shows what the vendor printed: the URL to open, and for Codex the one-time code to
  type on OpenAI's page. Claude asks for the code Anthropic displays, which
  `backend-login-code` writes to the child's stdin and nowhere else (empty,
  whitespace-only and over-long values are refused before stdin). On exit 0 the driver
  asks the SAME binary (`claude auth status`, `codex login status`) whether it is really
  signed in, and only that answer writes the row. The session is polled from the browser
  through `/resources/backend-login` every 2 s while it is live; the success toast
  settles on that result, never on the submit. The card renders the flow as two numbered
  steps: the vendor's link is an "Open sign-in page" button that names its host and is
  never printed in full, with a "Copy link" button beside it on both backends (ruling
  294: the browser holding the vendor session is often not the one reading this page);
  Codex's code sits beside a Copy button; Claude's code field is a real labelled input
  whose Submit follows ruling 147 (enabled, an empty submit refused with the field marked
  and focused). A step marker is pending until its input arrives, current while
  actionable, done once the code is on its way; step 1 is never marked done on its own,
  because nothing server-side can see the link being opened. The status line is the ONE
  polite live region; the step group takes focus when it replaces the button that started
  the flow, because every value in it arrives from a later poll.
- **A pasted credential.** `backend-set-key` verifies an Anthropic Console or OpenAI
  Platform API key with a FREE `GET /v1/models` probe before sealing it; a ChatGPT
  workspace access token has no free probe and is stored `verified_at = null` with the
  card saying so. `backend-disconnect` runs the vendor's own logout, removes the
  credential file and drops the row (transcripts stay).

**The last refusal Viberr observed** (ruling 130(d)). A connected card also reads the
quota store (`latestBackendRateLimits`) and shows, ONLY when the record's
`credentialUserId` is the viewer, a `risk` pill "refused by the provider · <when>" with
the provider's own sentence in a "Last refusal" row, or a neutral "usage window spent ·
reopens <when>" pill with a "Usage window" row. The copy says what the pill is: the last
refusal Viberr observed on this account, which any completed run on that backend
retires, so the absence of a pill is not proof the account works. Another person's
refusal, or a record written before principals were stored, never appears on this card.
The record is evidence about the account that was billed, so a change to the viewer's
credential on that backend retires it too (ruling 165): a confirmed sign-in, a pasted key
the vendor accepted, a disconnect, or the removal of their account
(`retireBackendRecordsFor`, called from the credential store's own writers, so the
driver's confirmation and an org admin's account removal reach it without passing through
the Profile action). The card says so ("as does connecting a different Claude account
here"), and the dispatch hold that rests on the same record lifts with it. A record
naming another person, or nobody, is untouched; signing back into the SAME spent account
retires it as well, because Viberr never stores the vendor identity behind a sign-in and
cannot tell, and one refused run re-records the window.

**The last usage reading** (ruling 294). A Claude card whose connected account reported
a utilization reading (`rate_limit_event`) shows a "Usage" row: the percentage of the
named window, clamped, "not reported" rather than 0% when the provider sent none, with
the reading's age and a note that it is the last figure a run reported, not a live probe.
The same principal check applies, and the reading retires with the account like the
refusal does. Codex reports no readings, so a Codex card shows none.

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

- `design/better-auth-migration.md` describes the better-auth `organization`
  plugin, `member`/`invitation` tables, a legacy `scrypt$…` compatibility hook and a
  password backfill. None of these exist; treat that file as history.
- The README's "Known gaps" entry "Org audit browse is minimal" says the browse has no
  filtering; it has a text filter and an org-scoped toggle backed by its own query
  (§5). It has no paging.
