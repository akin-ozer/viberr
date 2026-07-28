# Foundation code map — auth, RBAC, users, notifications, data layer, seeds

Pass-15 discovery. Behavior-as-implemented, with jump targets. App: React Router v8 + Node,
source under `app/`, file-canonical data under `${VIBERR_DATA_ROOT}` with a SQLite projection.

## Auth (better-auth)

- **Ownership split**: better-auth owns credentials/sessions/OAuth in its own tables (`user`,
  `session`, `account`, `verification` — db/migrations/0001_baseline.sql:298-301); the app's
  `users` table stays the canonical profile/org-role store. Binding invariant: better-auth
  `user.id === users.id` (app/server/auth/identity.server.ts:5-19). Identities are provisioned
  synchronously at user creation (seed/invite/OAuth) — no backfill pass.
- **Instance**: `buildAuthOptions`/`createAuth`/`getAuth` (app/lib/auth.server.ts:112,316,332).
  Cookie prefix `viberr` (line 312), 30-day rolling session with 1-day updateAge (247-250),
  secret = `BETTER_AUTH_SECRET ?? VIBERR_SESSION_SECRET` (344). Singleton cached under a global
  symbol keyed to the db handle (324-368). Sign-up disabled (`disableSignUp: true`, 147) —
  the whitelist IS account existence.
- **Splat + allow-list**: `/api/auth/*` mounts better-auth's raw handler for GET+POST
  (app/routes/api.auth.$.ts:11-17, no app CSRF — better-auth does Origin/trustedOrigins).
  `ALLOWED_AUTH_PATHS` (app/lib/auth.server.ts:53-60) allow-lists exactly 6 endpoint paths
  (sign-in/email, sign-in/social, callback/:id, error, get-session, sign-out); everything else
  404s in the `before` hook (218-220). Anything not listed (change-password, update-user…)
  would bypass audited app flows or split-brain `users`.
- **Password totality (P11-01)**: custom `password.hash/verify` hooks (159-162) route through
  app scrypt wrappers so an unparseable legacy hash reads as 401, not a 500.
  `isBetterAuthPasswordHash` (identity.server.ts:120-122) lets the seed re-hash legacy creds.
- **Rate limiting**: better-auth's own limiter is turned OFF for `/sign-in/email` and
  `/sign-in/social` (164-193) because with no reverse proxy every client shares one ip-bucket
  (denial-of-login lever). Replacement: app token buckets in the `before` hook — `email|ip`
  for email sign-in (221-230), `provider|ip` 30/min for social start (236-244). Pre-check
  failures spend a token in `loginWithCredentials` (app/server/auth/login.server.ts:62+),
  which also keeps the failure taxonomy (unknown_email/no_password/wrong_password/disabled/
  rate_limited) and audits.
- **Session read**: `authenticateWithHeaders` captures better-auth's renewal `Set-Cookie`
  (F10-17) and forwards it via the root loader; a disabled/vanished user's session row is
  deleted inline and they read as signed out (app/server/auth/require-user.server.ts:77-101).
  Guards: `requireUser`/`requireAuth`/`requireRole` (admin>member hierarchy, 174-222); forced
  `pwreset_required` redirects everything to /login except allow-listed flows (148-164).
  Login-redirect returnTo strips React Router `.data` wire URLs (128-146).
- **Seeded admin**: on an EMPTY users table only, `seedInitialAdmin` creates the admin from
  `VIBERR_SEED_ADMIN_EMAIL/PASSWORD`, else admin@viberr.dev with a random password logged once
  and `pwreset_required=1` (app/server/auth/seed-admin.server.ts:37-91). Boot calls it
  (app/server/boot.server.ts:156-159).
- **OAuth whitelist**: providers register only when both env id+secret exist
  (app/lib/auth.server.ts:349-362); login page shows buttons on the same condition
  (app/routes/login.tsx:47-50). `databaseHooks.user.create.before` calls `isOAuthWhitelisted`
  with the provider read off the callback endpoint path (`oauthProviderOf`, 79-89 — P13-D-22:
  no more guessing from githubHandle). Admission (app/server/auth/oauth-provision.server.ts:
  68-88): Google + domain in `google_domain_allowlist` → allowed with mapped role; GitHub +
  live `github.com/<handle>` placeholder row → allowed (placeholder claimed & deleted,
  95-127); else only a live existing `users` row by email. Provider `null` fails closed.
  Header comment says the handshake is NOT live-verified (no OAuth creds on this instance,
  oauth-provision.server.ts:43-46).
- **CSRF**: double-submit HMAC(secret, sessionId) in `_csrf` + Origin/Sec-Fetch-Site check
  (app/server/auth/csrf.server.ts:1-45); login uses origin-check only. Requests with neither
  header (curl) pass the origin check by design (csrf.server.ts:39-44).

## RBAC

- **Single source**: `RBAC_DEFINITIONS`/`ACTION_ROLES` in app/shared/rbac.ts:47-81 — 18
  actions × 4 project roles (viewer ⊂ contributor ⊂ maintainer ⊂ admin, ROLE_RANK 27-32).
  `view` and `comment` are app-wide (any authenticated user, FR4) and appear in the table
  only for display (rbac.ts:20-23). Org roles are separate: member/admin on `users.role`.
- **Resolution chokepoint**: `resolveProjectAuthority`
  (app/server/auth/project-authority.server.ts:167-231) — membership role from project.md
  `members[]`, org-admin D2 emergency override (granted project-admin + audited
  `project.org_admin.override` per use, except "any-member" reads to avoid page-load noise,
  181-203), and audited denials (`project.authority.denied`, deduped 60s per
  actor|project|action, 95-119). Wrappers: `requireProjectAuthority` (403 copy),
  `requireAction` (task mutations, task-actions.server.ts:297-312), `assertProjectAction`
  (slug-only config surfaces, 310-363), `requireRunAgents`/`canRunAgents` (266-300 — the
  mention path denies silently by design), `requireProjectMember` route gate for config
  surfaces (app/server/auth/require-project.server.ts:20-45, allowArchived for reads).
- **Archive**: R6-3 archived-PROJECT read-only gate is `requireProjectMutable`
  (project-authority.server.ts:131-142), applied inside `requireAction`, in
  `assertProjectAction`, and explicitly on the comment path (task-actions.server.ts:681-684).
  Task-level archive (P14-GV-02) requires `approve-transition` (admin|maintainer), withdraws
  open packets/recommendations, reversible (task-actions.server.ts:3498-3540).
  `force-accept-completion` is project-admin-only (rbac.ts:69).
- **Owner exceptions**: a contributor+ task owner may accept their own task
  (task-actions.server.ts:314-338) and governs decisions on their own task (R14-2, 340+).
- **Capabilities (agent-side RBAC)**: `UNIFIED_CAP_CATALOG` (app/shared/capabilities.ts:33-98)
  with `ALWAYS_HUMAN_CAPABILITY_IDS` = merge-pull-request, transition-to-done,
  change-project-policy (148-152), coerced to `human` server-side in profile writes
  (app/features/agents/agent-profile-actions.server.ts:137,170,211). Enforcement honesty
  metadata: `ENFORCED_CAPABILITY_IDS` (both backends) vs `CLAUDE_ONLY_ENFORCED` vs advisory
  (160-217). Specialist "recommend" is coerced to direct (220-222); `normalizeDeliveryGrants`
  repairs the VIB-1 headline-off contradiction but respects explicit `human` (234-267).
- **UI hide vs disable**: pattern is `roleCan(myRole, action)` in the page component.
  Authority-gated controls are HIDDEN (e.g. task archive renders only for `canTransition`,
  task-detail-page.tsx:1086-1090 comment: "hidden for everyone else rather than rendered
  inert"). STATE-gated destructive controls render disabled with the server's reason as
  visible TEXT, never `title` (a disabled control gets no pointer events so tooltips never
  open — P14-LV-08, task-detail-page.tsx:1060-1081, tested in task-disposition.test.tsx:155).
  Policy page renders the same `RBAC_DEFINITIONS` object plus `ALWAYS_HUMAN_ROWS`
  (app/features/policy/policy-page.tsx:325, policy-data.ts:64-69).

## Users & members

- Org "Users & access" (app/server/org/org-users.server.ts:38-61): local accounts get a
  one-time temp password (no mailer); Google accounts are passwordless rows whose email is
  the whitelist; GitHub handles create placeholder rows (`github.com/<handle>` email) claimed
  at first OAuth sign-in; `google_domain_allowlist` rows map domains → roles. Route-level
  `requireRole("admin")` is the access control — these functions trust their caller.
- Status derivation (org-users.server.ts:83-90): never-logged-in OAuth → "whitelisted",
  never-logged-in local w/ pwreset → "invited", else "active".
- `updateUser` (app/server/auth/user-admin.server.ts:120-190): last-active-admin lockout
  guard; disable revokes all better-auth sessions (`revokeUserSessions`, identity.server.ts:
  138-145) + audits. `resetPassword` sets temp hash + pwreset + kills sessions (193-225).
  Admin email edits sync the better-auth `user` row (`syncIdentityEmail`).

## Notifications, mentions, SSE

- **Storage**: per-user `notifications` rows in SQLite (0001_baseline.sql:162), single insert
  point `createNotification` (app/server/projections/notifications.server.ts:54-95) which
  enforces per-user routing prefs (opt-out; prefs-read failure delivers), emits
  `notification.created` SSE. Read state is monotonic; `POST /notifications/read` marks one
  or all (app/routes/notifications.read.tsx:21-36). `listNotifications` joins live task
  decision state so `waitingOnYou` reflects reality at read time (105-127).
- **Bell**: one `TopBell` for workspace + Home (app/features/shell/top-bell.tsx:12-28); list
  capped at 100 with footer note while the badge shows the full `countUnreadNotifications`
  (notifications.server.ts:151, project.tsx:106).
- **Watcher fan-out**: `notifyTaskWatchers` notifies admins+maintainers+task owner minus the
  triggering user, logging (not swallowing) recipient-resolution failures
  (task-actions.server.ts:231-279).
- **Mentions**: parsing is shared client/server via `extractMentions`
  (app/ui/mention-spans.ts:1-40) — known display names longest-first (so "@Arda Kaya" wins),
  fallback single-token grammar, reserved handles operator/agent/claude/codex route to agents.
  `notifyMentionedUsers` (app/server/tasks/mention-notify.server.ts:57-94) is the NEW-4
  shared fan-out used by EVERY comment writer (human `appendComment`
  task-actions.server.ts:741, agent toolkit agent-toolkit.server.ts:121, operator
  operator-actions.server.ts:356,442); matches enabled users by email local-part, first name,
  or full display name, notification kind `mention`, quote clipped to 240 chars.
- **Comments**: `appendComment` (task-actions.server.ts:664-765) — app-wide for authenticated
  users (no requireAction), archived-project guard, prepends a `comment` timeline event to
  canonical task.md, optional timeline compaction on threshold, reprojects, audits
  `task.comment`, mention fan-out. `@agent`-handle comments set `toAgent` and can trigger
  runs via `commentToAgent` (runtime role checked with `canRunAgents`; a lower-role
  commenter's comment is kept, run silently skipped — `runtimeDenied`, 767-782).
- **SSE**: broker in app/server/events/sse-broker.server.ts:5-39 — per-connection scopes
  (`project:`/`task:`/`projects`/`user`), 25s heartbeat, 256-event ring buffer with
  Last-Event-ID replay else `stream.resync`, backpressure closes slow connections; it also
  owns the process SIGINT/SIGTERM hook that WAL-checkpoints + closes SQLite (P13-D-43,
  sqlite.server.ts:84-106). Route `/resources/events` (app/routes/resources.events.ts):
  401/400 JSON for bad auth/scopes; non-org-admin scopes are membership-filtered — the
  `projects` firehose expands to member projects only, foreign named scopes are dropped, and
  all-foreign requests get 403 (100-137). Client `useLiveUpdates` revalidates loaders on
  events (300ms debounce), shows a "live updates paused" chip and reconnects on bounded
  backoff since EventSource never retries a failed connection
  (app/features/live-updates/use-live-updates.ts:9-48).

## Data layer

- **File-canonical layout** under `${VIBERR_DATA_ROOT}` (default `./data`,
  env.server.ts:76): `projects/<slug>/project.md`, `projects/<slug>/tasks/<KEY>/task.md`,
  `agents/profiles/<id>.md`, `kb/<dir>/`, `skills/<name>/`, `runtimes/`,
  `state/projection.sqlite` (app/server/files/file-store-root.server.ts:5-37).
  Path helpers route every single-segment name through `resolveStoreSegment` (traversal
  refused, resolved child must stay under root — 108-127); agent-profile ids included
  (P13-AP-11, 88-94).
- **SQLite projection**: WAL, FK on, busy_timeout 5s (app/server/db/sqlite.server.ts:12-19);
  one squashed migration `0001_baseline.sql` (pre-prod ruling). SQLite is PRIMARY storage for
  users/sessions/PATs/audit/notifications (not rebuildable); projections
  (`projects`, `task_projections`, `task_events`, …) rebuild from files via
  `rebuildAll`/`rebuildProject`. `rescanProjections`/`rescanProject` are audited, gated
  actions (app/server/projections/rescan.server.ts:10-48; project-scoped rescan matches its
  `rescan-project` grant).
- **Watchers**: `startFileWatcher` on projects/ (250ms debounce, HMR-safe global handle,
  cancellable re-arm — file-watch.service.server.ts:9-50); `startKbWatcher` re-indexes a KB
  on file change unless pinned "manual" (kb-watch.service.server.ts:9-24).
- **Boot sequence** (app/server/boot.server.ts:129-250): env validate → warn if OAuth
  configured without BETTER_AUTH_URL (139-146) → ensure dirs → seed default agent assets →
  open db/migrations → seed admin → SSE publisher → boot rescan (offline-drift reconcile) →
  ensure base agents deployed → start watchers → finalize orphaned runs → retention →
  fire-and-forget restart-recovery chain (91-119, sequenced per P14-RT-09) → schedule runner
  → GitHub poller → `logBootIntegrity` (dirs/migrations/projection counts, 37-67 — "no
  security posture implied").
- **Org resources**: KB/skill CONTENT is disk-truth, scanned on every read; SQLite carries
  metadata only; disk-only folders render under synthetic `disk:<name>` ids and are adopted
  into rows on mutation (app/server/org/resources.server.ts:39-60,
  store-files.server.ts:154-211). MCP health is honestly probed (HTTP reachability / stdio
  JSON-RPC tools-list), never fabricated.

## Store-files server (StoreBrowser)

- Every operation is a real filesystem mutation under `${DATA_ROOT}/kb/<dir>` or
  `/skills/<name>` followed by a rescan (app/server/org/store-files.server.ts:25-40).
- Guards: segments sanitized (backslash→"-", 200-char cap, dotfile segments dropped,
  `..` throws — 93-126); `assertInsideRoot` does the lexical containment check PLUS a
  `realpathSync` symlink resolution of the deepest existing path component, so a symlink
  (including an intermediate symlinked dir) pointing out of the store is refused for both
  reads and writes (P14-RV-02, 128-151). Uploads pre-flight every path — a conflict writes
  nothing; a file can never clobber a directory (writeStoreFiles, 233-260+). GitHub import
  snapshots via the git trees API through the org default connection only.

## Seeds

- **Product seed** `scripts/seed.ts` → `runSeed` (app/server/seed/seed.server.ts:29-56):
  clean sheet — built-in agent templates (operator/developer/reviewer), bootstrap admin on
  empty users table (default admin@viberr.dev / SEED_DEFAULT_PASSWORD), rescan; plus
  `seedOrgResources` (KBs with real files, skills, domain allowlist; no fabricated MCPs or
  GitHub connections). P11-01 recovery re-hashes a legacy admin credential. `--reset` wipes
  projects/, agents/profiles, transcripts and derived tables; users/auth + runtime credential
  homes survive.
- **Demo fixture** `scripts/seed-demo.ts` dynamically imports
  `test-support/demo-seed.ts` (not shipped in the prod image; clear failure message,
  seed-demo.ts:17-36): the mock dataset (arda & co, viberr-core VIB-139…168, stub projects,
  Arda's inbox) that e2e/route suites are written against; notification inserts use
  `bypassPrefs` for determinism (notifications.server.ts:37-41).

## Suspect areas

- **FR4 vs SSE membership gate**: any authenticated user may VIEW any board/task (rbac.ts:
  20-23), but `/resources/events` drops non-member project scopes and 403s all-foreign
  requests (resources.events.ts:100-137). A non-member legitimately viewing a foreign board
  gets a permanently "paused" live chip (or a 403 stream) on a page they are allowed to read
  — display and live-update scoping disagree.
- **No single-writer guard on the data root**: nothing prevents two app processes (host dev
  server + compose container) opening the same `state/projection.sqlite`; this already ate
  WAL data once (docker-data dual-writer incident). `openDatabase`
  (sqlite.server.ts:12-19) takes no exclusive lock and boot performs no marker/pid check;
  `.env` defaults `VIBERR_DATA_ROOT=./data` (env.server.ts:76) while launch configs point at
  `docker-data`, keeping the foot-gun loaded.
- **First-name mention fan-out is ambiguous**: `notifyMentionedUsers` matches by first name
  (mention-notify.server.ts:78-81), so "@arda" notifies EVERY enabled user whose first name
  is Arda; there is no disambiguation or dedup priority between local-part/first/full
  matches.
- **Dead export**: `MENTION_RE` (mention-notify.server.ts:25) claims "kept exported for
  callers that only need the raw token shape" — no non-comment importer exists anywhere.
- **`statusOf` blind spot**: a local user created with a password but `pwreset_required=0`
  who never logged in reads "active" (org-users.server.ts:83-90); only pwreset-flagged local
  users show "invited". Today's creation paths always set pwreset, so this is latent, not
  live.
- **`session-renewal.server.test.ts` has no sibling source file** (app/server/auth/) — it
  pins root-loader + require-user behavior; fine, but the name suggests a module that does
  not exist.
- **`google_domain_allowlist` safety-net branch**: `isOAuthWhitelisted`'s final fallback
  admits ANY provider whose email matches a live `users` row (oauth-provision.server.ts:
  85-87). Comment calls it anomalous (better-auth should have account-linked first), but if
  reached it bypasses provider-specific admission rules — e.g. a GitHub sign-in claiming a
  Google-provisioned row's email.
- **CSRF origin check passes header-less requests** (csrf.server.ts:39-44) by design for
  curl; the `_csrf` token is the real backstop — any mutation route that forgot `assertCsrf`
  would be origin-only protected. (Pass-11 established "every new form needs `_csrf`"; the
  invariant is convention, not typed.)

## Open questions

1. Should non-member (FR4) viewers get live updates on foreign boards — i.e. is the SSE
   membership filter the intended read-scoping (making FR4 pages deliberately static for
   non-members), or should project scopes follow view authority?
2. Mention semantics: when "@sam" matches two users' first names, should Viberr notify both,
   prefer exact local-part/full-name matches, or force the composer to insert full names?
3. Should the app defend against the dual-writer hazard at boot (e.g. a pidfile/lock beside
   `projection.sqlite`, or refusing to start when the WAL shows another live writer), given
   the documented data loss?
4. Is the `isOAuthWhitelisted` existing-row fallback meant to survive, or should it be
   removed/narrowed now that account-linking by verified email is configured
   (auth.server.ts:259-267)?
5. `comment` is app-wide but archived projects freeze commenting — should app-wide viewers
   see rendered copy explaining WHY the composer is missing/disabled on archived projects
   (parallel to the P14-LV-08 text-reason rule)?
