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
| Session | 30-day rolling, slid at most once a day. The renewal `Set-Cookie` is captured by `authenticateWithHeaders` and forwarded by root's `sessionRenewalMiddleware` on whichever GET resolved the session (ruling 457: root's loader no longer runs on every request), so active users are not signed out at login + 30 days. Expired rows are never honoured and are not pruned on a timer. A GET or HEAD resolves its session once however many loaders and guards ask (the router hands them one Request; ruling 457); a POST resolves on every call. |
| Passwords | better-auth's own scrypt, stored as `<saltHex>:<keyHex>` in the `account` row with `providerId = 'credential'`. Minimum 8 characters (`MIN_PASSWORD_LENGTH`). A legacy `scrypt$…` hash is not verifiable; only the seed CLI re-hashes such a row. `users` has no password column. |
| Sign-up | Disabled. Accounts exist only because an admin created or whitelisted them (§2). |
| Login | `POST /login` `intent=login`: origin check (no session yet), pre-checks on `users` (unknown, disabled, no password) that each consume a throttle token, then better-auth `/sign-in/email`. Success records `users.last_login_at` and audits `auth.login.success`; failures audit `auth.login.failure` / `auth.login.rate_limited`. Unknown email and OAuth-only accounts share one error string. |
| Throttle | App-level token buckets replace better-auth's limiter on the two sign-in paths: 10 attempts per `email\|ip` per 15 minutes (continuous refill), 30 social starts per `provider\|ip` per minute, 10 PAT validations per actor per 5 minutes. `X-Forwarded-For` is honoured only when `VIBERR_TRUST_PROXY=N` (Nth hop from the right); otherwise the ip is the literal `local`. Per-process, in memory. |
| Forced reset | `users.pwreset_required` is set by the boot-generated bootstrap password, by admin-created temp passwords and by admin resets. `requireAuth` redirects to `/login` until `intent=set-password` completes it (audit `auth.password.forced_reset_completed`; other sessions are deliberately left alive). There is no self-service "forgot password". |
| Bootstrap admin | `seedInitialAdmin` runs only while `users` is empty: boot uses `VIBERR_SEED_ADMIN_EMAIL` / `VIBERR_SEED_ADMIN_PASSWORD` or `admin@viberr.dev` with a random one-time password logged once as `VIBERR BOOTSTRAP ADMIN` (reset forced); the seed CLI uses the known dev default. Audit `org.user.created {bootstrap: true}`. The account is recognised afterwards as the first one the instance holds, made by nobody with a password of its own (`bootstrapAdminOf`), and until another enabled account exists Home's setup checklist asks an admin for one (ruling 532). |
| Disabled users | The auth guard deletes the session of a disabled or vanished user and treats the request as signed out; `isOrgAdmin` requires `disabled = 0`. |
| Background loads | Every route a page loads in the background answers a request with no session, or with a forced reset pending, with a 401 (`authenticate`, then the route's own refusal), never `requireUser`'s login redirect: the dock's two (`/resources/controller`, `/resources/controller-unseen`), the bell's list (`/resources/notifications`), the attention watcher's read (`/resources/attention`), the SSE stream (`/resources/events`), the Agent accounts poll (`/resources/backend-login`), the palette's search (`/resources/search`), the model catalog (`/resources/model-catalog`), the run console's log reads (`/resources/run-log`) and the task page's Changes read. A fetcher follows a redirect as a navigation, and the redirect's returnTo named the resource, so signing in again opened a page of raw JSON; a plain `fetch` follows it silently and got the login page instead of its answer (ruling 457; test audit L14-29 found the last six). Each answer is one the page can hold, so the tab stays where it is; its next real navigation asks for the sign-in with the page's own path as the returnTo. |
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
formData → CSRF → `{ refused, auth, db, formData, actor, intent }`. A failed check is
answered, not thrown: `refused` is the 403 `{ ok: false, error }` result the action
returns first (`if (refused) return refused;`), so the page stays up with what the
person typed, and the 403 re-runs root, which re-reads the token (ruling 457, RV-1).
The routes that do not use the preamble (`/controller`, `/projects/:slug/controller`,
`/profile`, `/notifications/read`, `/prefs/theme`, `/resources/controller`) call
`csrfError`, which `refused` is built from, and return it the same way. `/api/auth/*`
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
`/org/settings` (every tab and intent), `/org/settings/audit-export`,
`/org/settings/board-export` (ruling 653), `/insights`,
the Home store re-scan and rebuild-projections actions, and everyone's controller
transcripts (read, interrupt a live turn, and delete, ruling 525). Any signed-in user may **create a
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
| `edit-task-meta`: priority, labels and due date, the epic a task is in (ruling 503), and what a task waits on, which releases it when cleared (rulings 131, 309(a)) | ✓ | ✓ | ✓ | |
| `attach-file`: attach a file to a task (ruling 379) | ✓ | ✓ | ✓ | |
| `manage-epics`: create and edit epics, their status, lead and dates; there is no delete (ruling 503) | ✓ | ✓ | ✓ | |
| `approve-transition`: approve stage transitions | ✓ | ✓ | | |
| `resolve-packet`: resolve decision packets | ✓ | ✓ | | |
| `accept-completion`: accept completion into Done | ✓ | ✓ | | |
| `update-goal`: edit the task goal (and its title, ruling 295) | ✓ | ✓ | | |
| `run-agents`: run agents | ✓ | ✓ | | |
| `reorder-board`: reorder the board | ✓ | ✓ | | |
| `reconcile-github`: reconcile GitHub state | ✓ | ✓ | | |
| `grant-github-scope`: manage the GitHub credential (re-check its scopes, set or clear it) | ✓ | ✓ | | |
| `rescan-project`: re-scan project files and projections | ✓ | ✓ | | |
| `release-any-ownership`: release any task owner | ✓ | | | |
| `manage-members`: manage members and roles | ✓ | | | |
| `manage-agents`: manage agent profiles | ✓ | | | |
| `delete-controller-conversations`: delete another person's controller conversation about this project, its board's or one of its tasks'; everyone may delete their own (ruling 525) | ✓ | | | |
| `edit-policy`: edit workflow and policy, and archive or restore the project itself | ✓ | | | |
| `remove-from-record`: remove a file from a task (ruling 582; a comment's words are the operator's, ruling 584) | ✓ | | | |
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
loader, through the same `readWorkspace` read, ruling 457) and `requireProjectMember`,
which return the **same 404 bytes** for a non-member and for an unknown slug (ruling 25); actions go through `requireProjectFormAction`, which runs
`requireVisibleProject` (`app/routes/project-visibility.server.ts`) before any try block. Config surfaces use
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
`connections` (the default), `users`, `sso`, `resources`, `boards` (Import & export),
`controller`. Below the
tabs sit the run-concurrency and spending-cap rows, then the Audit log card. Home's
setup checklist (ruling 532) links into two dialogs here: `?tab=connections&add` opens
the New GitHub connection dialog, and `?tab=users&add=admin` opens Allow access with
Admin chosen, for the person who signed in as the bootstrap admin to make an account of
their own.

- **GitHub connections**: owner + PAT. Nothing is saved unless the PAT validates
  against `repo` + `pull_request:write` and the owner exists; the first connection
  becomes the default; the default cannot be removed; removing a connection deletes
  its PAT and cascades every project binding. A `valid` verdict older than 24 hours
  (`CONNECTION_REVALIDATE_AFTER_MS`) is re-proven before use. Audit `org.connection.*`,
  `github.pat.*`. Creating a repository with a project (ruling 462) needs more than
  the required pair and is never checked at save: a fine-grained token needs
  **Administration: Read and write** for All repositories (a classic token's `repo`
  covers it), and a token without it is refused at creation with that sentence.
  Each row says which repositories the TOKEN reaches ("Reaches 3 repositories · 1
  private", the list one disclosure away; ruling 463), read from `GET /user/repos`
  whenever the token is validated, and carries **Re-check**, which validates the
  stored token again and re-reads that list. A connection saved before the read
  existed says it has not been read yet; a failed read says why. The account's
  public-repo count is no longer shown: it described the account, not the token.
  The controller reads the same facts through `list_github_connections`, open to any
  signed-in person, without token material.
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
  runs a real `initialize` → `tools/list` handshake — over HTTP through the same client
  the MCP gateway uses, with the SSE fallback (ruling 461) — stdio children get a
  filtered env plus `MCP_CREDENTIAL`, first-run installers finish in a 15-minute
  background warm-up; reserved names refused). A server with a stored credential is
  reached by every run through Viberr's loopback MCP gateway, so the credential never
  enters an agent process (ruling 461); its row reads "auth: configured (held by Viberr;
  runs connect through its gateway)". An HTTP server can instead be **signed in with
  OAuth** (ruling 469): its editor's "OAuth sign-in" section, beside the credential
  field, offers **Sign in** (`mcp-oauth-start`), which discovers the server's
  protected-resource and authorization-server metadata, registers Viberr dynamically
  with the redirect URI `<origin>/resources/mcp-oauth/callback` (the origin of
  `BETTER_AUTH_URL`, else of the request) and hands back the authorization URL; the
  editor shows it as a link that opens in a new tab ("Continue at <host>"). The admin
  approves Viberr on the server's own page, the callback (org admin, the same session
  that started it, the `state` spent once) exchanges the code with the PKCE verifier,
  seals the tokens beside the row and says the tab can be closed; this page updates on
  the resource event. A sign-in replaces a pasted credential (a connection holds one;
  the editor drops one typed before the sign-in landed, ruling 514),
  a pasted one over a live sign-in is refused, a pasted one over a sign-in that is not
  live ("needs sign-in", "expired") clears what is left of it — a row holding a pasted
  credential reports no sign-in status at all — and changing the endpoint drops the
  sign-in. The row and the editor read "needs sign-in" (the server answered the MCP
  authorization challenge and holds no token), "auth: OAuth, signed in (expires in …,
  renews itself)" or "sign-in expired: an admin must sign in again" with the server's
  reason; **Sign out** (`mcp-oauth-sign-out`) revokes the tokens at the server when it
  offers revocation and drops them. Audited as `org.mcp.oauth_connected` {name, issuer,
  scope, expiresAt, renews, replacedStaticCredential}, `org.mcp.oauth_failed` {name,
  stage, reason} and `org.mcp.oauth_signed_out` {name, revocation, reason}; no token,
  code or client secret is in any of them. A signed-in server also says what its sign-in
  was granted (ruling 486): the row's auth phrase ends with "read-only · 194 scopes" (or
  "194 scopes · 12 writes"), and the editor puts "Granted read-only · 194 scopes" under
  the sign-in's status (for a read-only grant, that the server refuses any call that
  writes and how to ask for write scopes) with a disclosure listing every granted scope,
  each write marked. An HTTP server's editor has an optional "Requested scopes" field
  (spaces, commas or newlines between scopes; a token OAuth does not allow is refused at
  save), stored as `oauth_requested_scope` and sent as the next sign-in's `scope`; left
  blank, the resource's advertised scopes are asked for. The authorization server decides
  what it grants, which is why the editor shows the grant rather than the request. The MCP editor's "Write tools" section (ruling 176) marks the
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
  row's details carry `diverged`, `propagated` and `personaPropagated` project slugs),
  one `project.agent_profile.resources_synced` row per project a propagation rewrote,
  and one `project.agent_profile.updated` row with `personaChanged` per copy whose
  persona it rewrote (ruling 467).
- **Import & export** (ruling 653): a board's workflow without its work, as a board
  file (`<slug>.viberr-board.zip`, format in
  [file-formats.md §9](../architecture/file-formats.md#9-a-board-file-ruling-653)).
  **Export a board** lists every project, archived ones last, each with what its file
  would carry (stages, agents, skills, knowledge bases, MCP servers) and any grant it
  cannot carry because the instance has no such resource; **Export** fetches
  `GET /org/settings/board-export?project=<slug>` and saves the zip, and a refusal (a
  project file the store cannot read, a board larger than an import accepts) is a toast.
  The export changes nothing and records nothing, as the audit download does. **Import
  a board** takes a dropped or chosen zip: `board-import-preview` reads it and plans the
  import without writing anything, and the dialog shows the new project's name, task key
  and repository (the New project dialog's own fields and refusals, plus "a project at
  projects/<slug> already exists"), the stages with the rule into each, the agents, and
  every knowledge base, skill, MCP server and agent template the file carries as New,
  Already here (the same content, reused) or one this instance holds differently, which
  offers "Import a copy" (the default, under a free name) or "Use this instance's"; a
  different template stays in the library and the board's agent carries the file's
  settings as its own definition. Every problem in the file is listed at once and refuses
  the import. `board-import` plans again from the uploaded bytes, checks the identity and
  reaches the repository as project creation does, writes the resources through their own
  writers (an MCP server comes in UNCHECKED and without a credential: nothing in a file
  runs or is contacted until an admin tests it), then project.md, with the importer as
  its admin. Audit: the writers' own rows (`org.kb.*`, `org.skill.*`, `org.store.files_added`,
  `org.mcp.added` with `unchecked`, `org.agent_profile.created` with `importedFrom`) and
  `project.created` with `template: "imported"`, the `file`, `exportedFrom`, and what was
  `created` and `reused`; the project's Activity reads "created the project from the board
  file …".
- **Controller**: model and effort are always editable; the grant lists and the
  doctrine body are deployment-locked (ruling 108); a note lists the grants the
  controller asked for and cannot make (`request_resource_grant`, ruling 390), each
  naming its unlock variable and the restart. A save that leaves the resource granted
  answers the request, and each one has a Decline button (`controller-request-decline`).
  See
  [controller-and-epics.md §6](controller-and-epics.md#6-configuring-the-controller-rulings-106-and-108).
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
actions, session compactions `task.agent.compaction`, knowledge-base corrections
`task.kb_correction.merged` and their undo `task.kb_correction.undone`, ruling 498, and
before it the proposals `task.kb_proposal.filed`, ruling 483), `org.kb.proposal_promoted`
and `org.kb.proposal_dismissed` (ruling 483), `epic.*` (`epic.created`, `epic.updated`, and
the conversion's `epic.converted`) and `task.epic.changed` (ruling 503), the `goal.*` rows an
upgraded store holds, `github.*` (branches, PRs, delivery,
reconcile, workspace, scope violations, repository bootstrap), `runtime.run.*`,
`runtime.operator.plan_executed`, `run.recovery.*`, `run.completion.effects_lost`
(ruling 207(a)), `controller.authority.denied`, the controller's audited reads
`controller.ops.read`, `controller.repo.read` and `controller.github.read`,
`controller.resource_grant.requested|granted|declined` (ruling 390),
`projection.rescan|rebuild`, `seed.*`, `secrets.resealed`, `store.restored`.

**`profile.backend.*` (ruling 127).** Connecting or dropping a personal agent account
is governed, because it changes whose provider account this instance's runs bill. Seven
actions, all instance-scoped (no `project_slug`, no `task_key`), actor the person
themselves: `profile.backend.login_started` {backend, method, accountId,
existingAccount} when the vendor's own binary is spawned, `profile.backend.login_failed`
{backend, method, reason} on a non-zero exit, an unconfirmed sign-in or the
15/16-minute timeout, `profile.backend.login_cancelled` {backend, method},
`profile.backend.connected` {backend, kind, method, signedInAgain | verified} on success
or a saved key, `profile.backend.disconnected` {backend, kind, wasActive}, and (ruling
507) `profile.backend.switched` {backend, kind, from} when another of the person's
accounts becomes the one their runs bill and `profile.backend.renamed` {backend, named}.
Subject kind is `backend_login` for the session rows and `backend_credential` (the
account) for the stored ones. The `reason` is the
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
- Every write to a knowledge base, a skill or an MCP server that changes what a run is
  given carries `resource {kind: "kb" | "skill" | "mcp", key, boards: [{project,
  rulings, agents}]}` (ruling 681): the grant key, and the boards that name it as their
  rulings or whose deployed agents hold it, as they stood at the write. That is every
  `org.store.*` row (which before named only a row id and a path inside the folder), a
  knowledge base's rename (`renamedFrom`), `org.kb.privacy` and `org.kb.deleted`, a
  skill's rewrite (`rewritten`) or rename and `org.skill.deleted`, and `org.mcp.updated`,
  `org.mcp.tool_policy.changed` (on a server that exists) and `org.mcp.removed`. A
  delete asks before it drops the grants. A save that changes nothing a run is given
  carries none: a knowledge base's display name or refresh mode, a skill's summary
  (its text on disk is compared with what the save sent), an MCP server saved with the
  name, the address and the credential it had. A document that is one board's own and
  named after it (`no-repository-<slug>.md`, ruling 672) names that board alone.
  `org.store.doc_written` also carries `task {project, key}` when the write is an
  agent's correction or its undo (ruling 498).
- `task.acceptance.forced` carries `bypassed` (the gate sentences joined with " | "),
  `bypassedGates` (the same list), `skippedStages`, `validation` and `withdrawnPacket`
  (U35-3; null when the force answered the open decision instead, ruling 471).
- `task.packet.resolved {optionKind, optionTitle, packetKind}` is a person resolving a
  decision packet, actor that person. With `via: "accept" | "force-accept"` it was
  answered by the task page's acceptance rather than the packet's confirm (ruling 471);
  `task.packet.withdrawn {title, kind, type, by}` (actor the system) is an acceptance
  that closed a decision it did not answer (F32-11).
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
- **Project Activity page**: project-scoped rows for members, and the instance rows
  about what the board's runs are given (ruling 681). A write to a knowledge base, a
  skill or an MCP server is audited with no project and names, in `resource`, the boards
  whose runs are given it at that moment; each of those boards' audit panel shows the row as a
  change ("<person> edited a passage of **rules.md** in the project's rulings
  **house-rules**.", "… rewrote the skill **estimating**, which Scout uses."). No
  sentence quotes a document: an edit's `edited` passage is read as whether there was
  one, so a private knowledge base (ruling 578) is safe whoever reads the panel. An org
  admin's row links the knowledge-base document it wrote; nobody else is handed the
  link. A write that is an agent's correction or its undo names its task (`task`) and
  is left off that task's board, whose Stream already carries the task's entry.
- Derived facts: the Policy page's "last change" chip, the GitHub page's "last checked"
  time, and Insights' packet and time-to-review metrics.

Retention: audit rows are hard-deleted after 90 days (`AUDIT_RETENTION_DAYS`),
**after** being appended verbatim to `<dataRoot>/audit-exports/audit-events-<date>.jsonl`;
an export failure skips that pass's purge. Two actions boot recovery uses as idempotency
keys (`task.agent.replied`, `runtime.operator.plan_executed`) are exempt. The pass runs
at boot, every 6 hours and on disk pressure.

**Reading a controller-driven write** (ruling 99(b)). A write the controller makes for a
person is audited under that person with the controller named as the instrument
(`encodeControllerInstrument` in `app/shared/mapping/actor.server.ts`). The Activity
audit column renders it as "<name> (via the controller)" through `auditActorDisplay`, on
both the joined-name and the userless leg. The org Audit log and `inspect_audit_log`
keep the RAW stored label deliberately: they are the forensic surfaces, and the raw
label is what `recordAudit` was handed.

## 6. Insights (`/insights`, org admin only)

One read over `agent_runs` and the projections (`getInsightsSummary`), under the
standalone-page header. Read-only; nothing here writes. Ruling 635: the instance's own
record (tasks, packets, the audit trail) covers every backend, and the agent runs are read
one backend at a time, because Claude and Codex do not measure alike (only Claude reports
a cost, their tokens are different models' tokens, Codex reports no cache write).

- **Oversight** (`oversightSummary`, every backend): owner clarity (active tasks with a
  definite next actor), branch and PR traceability, packet resolution times from audit
  rows, time to review, and long timelines, longest first. Each card that counts
  exceptions names them by key, linked, capped at `INSIGHTS_NAMED_EXCEPTIONS` (8) with
  the remainder counted (ruling 290).
- **The backend switch** (`backendRuns`): every backend with its run count, one that never
  ran included. The loader reads `runAnalytics` for each backend that ran; the page's
  `?backend=` picks one in the browser (an unknown value is no choice), else the one with
  the most runs, so switching costs no request.
- **Measure**: cost when any of the backend's runs reported one, else tokens (input plus
  output over final provider figures). Every cost figure is null, "not reported", where
  nothing reported one, never $0.00, and tokens follow the same rule.
- **Totals**: runs, cost, tokens (input, cached input, output), turns.
- **Coordination share** (operator and controller runs against delivery runs, in the
  backend's measure). Null when a side's runs reached the provider and put no figure in
  at all (ruling 190); a run that never reached the provider is no evidence either way,
  and a stopped run inside a backend is counted on the Cost and Tokens cards rather than
  suppressing the share (ruling 635, amending 201).
- **Outcomes** and success rate; a restart-interrupted run is stopped, not an error,
  and a never-started one is outside the completion rate (ruling 158).
- **Breakdowns** by kind, project, model, task and profile (ruling 308), each the top 8
  (half the slots reserved for the busiest groups, the rest led by the measure) with
  `hidden`, `hiddenRuns`, `hiddenCost` and `hiddenTokens` naming what the window left
  out. Each row carries its key (`label`) and the name the page prints (`name`, ruling
  642): a kind in the run consoles' engagement words (Operator, Controller, Delivering,
  Supporting), a project's and an agent's own name (the newest run's `agent_name`), a
  model's display name; a task keeps its key. A task row is labelled `project/task` and
  links to its task; the page drops the prefix when every row is one project's.
- **Prompt cache** table (ruling 369), by run kind and by credential kind: runs, the
  warm-start rate over runs with a first call ("n/a" with none), the planning baseline's
  columns (ruling 505: the mean first-call write, cache reads per run over the runs that
  reached the provider, and the peak prompt's median · p90 · max), tokens written and
  read, the write/read ratio, first calls writing over 100k, and each cache lifetime's
  count. A backend that reports no cache write (`CACHE_WRITE_REPORTING_BACKENDS`, Claude
  only; ruling 395) has no write columns. Under it (ruling 505): **resumes by idle
  time**, a row per credential kind the earlier run billed, naming the TTL `cacheTtlMs`
  assumes for it, with the warm resumes of all the resumes in each idle bucket
  (`RESUME_IDLE_EDGES_MS`: every assumed TTL, then 24 hours; a bucket past the row's TTL
  is marked) and the sessions set aside as stale and large (ruling 372); and, on Claude,
  the **operator bursts**, the operator starts within a minute of the previous one on the
  same project, principal and model, with the cold ones and what their first calls wrote
  (Codex's cache does not cross threads, so it has none).
- Average duration and a 30-day daily chart.
- **Usage limits** (the backend quota): the backend's latest reading, every window it
  lists (ruling 608) by the name a person reads ("5-hour", "Weekly", "Weekly · Fable",
  `quotaWindowLabel`), each aged on its own reset (ruling 612), and when it was observed.

The page (ruling 642) reads each band of figures in one panel, a hairline between cells:
the four oversight figures with the long timelines across the foot, then the backend's
six run figures three to a row (turns ride under runs). A figure reads label, number and
one line; an absent one is a muted phrase in the number's place ("Not reported", "No
deliveries yet"). The day chart and the usage limits share a row; the breakdowns are one
table under an Agent · Task · Model · Project · Kind switch (`?by=`, read in the browser
like `?backend=`), each row's bar behind its name measuring what the rows are ordered by;
the prompt cache shows its headline (warm starts, read, written) and folds its tables
and their definitions under "Details".

The controller's `inspect_run_analytics` reads the same functions: `backends`, the
instance's `oversight`, and `runs.<backend>` for each backend that ran (or the one asked
for), never a sum across them.

Branch and PR traceability counts, over the tasks that have **delivered** (a delivered
work revision or a recorded pull request), how many carry both the task branch and a
recorded PR. An allocated branch alone is not a delivery: ruling 122 names the branch at
first dispatch, before an agent has written anything, so a task that only ever engaged a
deliverer stays out of the denominator (ruling 143). A finished task whose delivery was
never commit-shaped (terminal, no PR, no commits, e.g. a report delivered as
attachments) is out of it too (ruling 407). A delivered revision with no PR stays in it
on purpose; an unpushed delivery is exactly the untraceable one the number exists to
show.

A reading whose own window has reset (`readingWindowReset`, ruling 481(d)) keeps its
row in the past tense with no bar and no percentage: "<window> · window reset, no reading
since", "reset <time>", and the old window's warning and overage words dropped. It used to
read "92% of five hour · resets 03:30" hours after 03:30 on an idle instance.

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

- **Notification routing**: nine in-app opt-out toggles (`NOTIF_PREF_CATEGORIES`:
  packets, questions, approvals, mentions, policy, quality, controller, dependencies,
  ownership), each mapped from one notification kind and enforced inside
  `createNotification`: an off category means the row is never written. Each toggle's
  description names what its writers send (ruling 481(a)): "Decision packets for you" is
  the operator's packets (a blocked task, a question about scope, a completion report);
  "Agent questions" is an agent's `ask_human` or Codex outcome-envelope question, kind
  `question`, which used to be filed as an `approval` and was silenced by the approvals
  toggle; "Approval requests" is the operator's recommendations and a delivery's recorded
  next step. Below them, **Desktop notifications** is a per-browser opt-in (ruling
  481(c)): the switch is the only place the browser's permission is requested, it turns
  on once the browser allowed it and showed one notification, and a denial or an
  unsupported browser leaves it off with the reason on the row. The opt-in lives in that
  browser's storage, not in `user_prefs`, because the permission it rests on is the
  browser's.
- **Appearance & workspace**: theme `light | dark | system`, persisted to `users.theme`
  and the `viberr_theme` cookie; the timeline's default filter. There is no in-app
  reduce-motion setting (ruling 148(c)); the OS preference is the one signal.
- **Your access**: a read-only table rendered from the same RBAC rows.
- **GitHub identity**: disconnect flips `idp` back to `local` (audit
  `identity.github.disconnected`), refused without a password. The Disconnect asks first,
  on the shared `ConfirmDialog` ("Disconnect GitHub?", ruling 481(b)). On a deployment without
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
place either backend is connected. Until the person holds one that can bill a run, Home's
setup checklist carries a **Claude or Codex** step for them, whatever their role (ruling
532), whose link, `/profile#agent-accounts`, brings this panel to rest below the
overlay's pinned head, ringed and focused.

**Several accounts per backend (rulings 507, 616).** A person may keep up to ten accounts
per backend; one is **in use**, the one their runs bill, and Claude's and Codex's are
chosen apart. A connected card leads with it as a picker labelled **Runs use** (ruling
616): the trigger names the account in use over its kind, and the card under it carries
that account's health, usage and refusals. The trigger opens a menu, "Claude accounts · n
of 10", that lists every account the person keeps there with the one in use checked.
Choosing another is `backend-account-switch` {account}: a switch, not a sign-in, because
every account keeps its vendor sign-in in a home of its own on this server; it takes
effect for the next run, a run already going keeps its account, and the toast says "Claude
runs now use <name>". While it is in flight the trigger reads "Switching to <name>…" under
the account still in use. An account whose sign-in file is gone is listed dimmed and
cannot be chosen. The menu keeps the repo's menu keyboard (the arrows, Home/End, Escape
and Tab back to the trigger) and opens upward where the overlay has no room below. Under a
rule it offers **Add another Claude account**, which opens the same sign-in and paste
methods a fresh card has, says the new account becomes the one in use and the others stay
connected, and is disabled with a sentence at the ceiling; and **Manage other accounts**,
which opens **Other Claude accounts**, a row each: the name (one line, cut with an
ellipsis only where the row is narrower than it) and its facts over the row's buttons
(ruling 515). An account whose sign-in file is gone offers its sign-in there, into that
same account (`backend-login-start` with its `account`); the others are renamed and
disconnected there without first becoming the one in use. Every account, the one in use
included, has **Rename** (`backend-account-rename` {account, name}: the same field idiom
as the key form, at most 60 characters refused in the store's own words per ruling 147, an
empty name going back to the vendor's facts) and **Disconnect**. An account is named by
the person's label, else the email Claude's `auth status` reported, else its kind
("ChatGPT sign-in", "API key ending in abcd").

Two routes in, both the vendor's own:

- **Hosted sign-in.** `backend-login-start` spawns the UNMODIFIED bundled vendor binary
  (`claude auth login --claudeai` or `--console`; `codex login --device-auth`) with
  `filteredSpawnEnv()` plus the home of the ONE account it signs in (ruling 507: a new,
  empty `<dataRoot>/runtimes/users/<id>/{claude-home,codex-home}/accounts/<accountId>`,
  or with `account` that existing sign-in's own home), argv only, never a shell, every
  stream piped. A sign-in into a new account that does not end connected takes its
  half-made home with it once the vendor process has exited, and the account ceiling is
  refused before any process starts. Only the vendor being signed in to has to be installed
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
  settles on that result, never on the submit. A tab signed out meanwhile gets a 401
  refusal from the poll, never a login redirect (ruling 457), and the card keeps what its
  page drew; so it does for a poll the server never answers (a restart, a 5xx, a dead
  network), which the route's `clientLoader` answers with null instead of the Profile
  page's error boundary. The card renders the flow as two numbered
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
  card saying so. A saved key is a new account and becomes the one in use (ruling 507);
  nothing that was connected is logged out. `backend-disconnect` {account} removes ONE
  account: it runs the vendor's own logout in that account's home, removes the account's
  home (its credential file only, for an account connected before ruling 507) and drops
  the row (transcripts stay). Removing the one in use hands runs to the account used
  before it, and the toast names both. The card's Disconnect asks first (ruling 481(b)):
  the shared `ConfirmDialog`, "Disconnect Claude?" (or Codex) for a person's only account
  on the backend, whose body says tasks the person owns and their controller
  conversations can't start a run on that backend until they connect again, confirmed by
  "Disconnect Claude"; with several accounts it names the account ("Disconnect Work?")
  and says which account runs keep, or switch to. One tap used to sign the vendor session
  out with no undo short of a fresh sign-in.

**The last refusal Viberr observed** (ruling 130(d)). A connected card also reads the
quota store (`latestBackendRateLimits`) and shows, ONLY when the record's
`credentialUserId` is the viewer, a `risk` pill "refused by the provider · <when>" with
the provider's own sentence in a "Last refusal" row, or a neutral "usage window spent ·
reopens <when>" pill with a "Usage window" row. The copy says what the pill is: the last
refusal Viberr observed on this account, which any completed run on that backend
retires, so the absence of a pill is not proof the account works. Another person's
refusal, or a record written before principals were stored, never appears on this card.
The record is evidence about the account that was billed, so a change of the account the
viewer's runs bill on that backend retires it too (ruling 165, extended by ruling 507): a
confirmed sign-in, a pasted key the vendor accepted, a switch, the disconnect of the
account in use, or the removal of their account
(`retireBackendRecordsFor`, called from the credential store's own writers, so the
driver's confirmation and an org admin's account removal reach it without passing through
the Profile action). The card says so ("as does switching to or connecting a different
Claude account here"), and the dispatch hold that rests on the same record lifts with it. A record
naming another person, or nobody, is untouched; signing back into the SAME spent account
retires it as well, because Viberr never stores the vendor identity behind a sign-in and
cannot tell, and one refused run re-records the window.

**The last usage reading** (ruling 294). A Claude card whose connected account reported
a utilization reading (`rate_limit_event`) shows a "Usage" row: the percentage of the
named window, clamped, "not reported" rather than 0% when the provider sent none, with
the reading's age and a note that it is the last figure a run reported, not a live probe.
The same principal check applies, and the reading retires with the account like the
refusal does. A Codex card shows the reading its runs' rollouts report (ruling 604),
once one of them has made a model call. A Claude card's reading names the account's
plan window closest to its limit, which each run reads from its own CLI when it starts
(ruling 611), so the weekly window shows before the provider warns. A reading that
lists its windows ages each one on its own reset (ruling 612): when the binding one has
reset, the card shows the current window closest to its limit instead. Once the reading's
own `resetsAt` has passed (`readingWindowReset`, computed in `latestBackendRateLimits`,
the one home Insights reads too; ruling 481(d)) the pill drops the percentage and reads
"<window> window reset", and the note says "That window reset <time>, and no Claude run
has reported a reading since." instead of "The window resets <time>."

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
