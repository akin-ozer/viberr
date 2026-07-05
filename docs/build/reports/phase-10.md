# Phase 10 report — Audit, diagnostics, recovery + integration gaps

Status: complete. Gates at close: `npm run typecheck` clean, `npm test`
**753/753** green (722 prior + 31 new), `npm run build` clean (only the
pre-existing RR v8 future-flag warnings). Live-verified end to end (see
"Live verification"); store re-seeded pristine after
(`npm run seed -- --reset` → identical counts, clean-tree rescan
0 changed / 13 unchanged, VIB-142 violation `open`).

No new deps. Migration **0009_phase10.sql** (one column:
`users.github_handle`). routes.ts gained ONE route (`/resources/health`,
already in the CONVENTIONS route map).

## File inventory

```
db/migrations/0009_phase10.sql          # users.github_handle TEXT (nullable)
app/
  server/audit/
    audit-actions.ts                    # THE canonical audit-action catalog
                                        #   (~80 actions, scope per action)
    audit-coverage.server.test.ts       # static sweep (recordAudit call sites
                                        #   ⇆ catalog, both directions) + the
                                        #   table-driven functional regression
  server/projections/
    rebuild.server.ts                   # rebuildProjections: transactional
                                        #   drop-all + rebuildAll(force) + audit
    activity-feed.server.ts             # EXTENDED: countActivityStream/
                                        #   countAuditLog, resolve context on
                                        #   violation entries, new templates
                                        #   (credential.revalidated, run.started)
    activity-feed-phase10.server.test.ts
    diagnostics-flow.server.test.ts     # malformed/mangled frontmatter,
                                        #   unknown stage, duplicate section →
                                        #   floor + readable rows + clear-on-fix
  server/auth/
    oauth-shared.server.ts              # + signInGoogleVerifiedEmail (domain
                                        #   allowlist provisioning) +
                                        #   signInGithubVerifiedIdentity
                                        #   (placeholder claim + handle persist)
    oauth-github.server.ts              # + GET /user profile fetch (login/name,
                                        #   best-effort) → identity sign-in
    oauth-google.server.ts              # + name claim → provisioning-aware sign-in
    oauth.server.test.ts                # + 9 Phase-10 cases (mocked providers)
    user-store.server.ts                # + githubHandle in patch columns
  server/secrets/pat-validator.server.ts # revalidateProjectCredential now audits
                                        #   the ATTEMPT (github.credential.
                                        #   revalidated w/ typed outcome)
  server/runtimes/run-service.server.ts # startRun/resumeRun audit
                                        #   runtime.run.started (actor param;
                                        #   default = operator system actor)
  server/org/org-users.server.ts        # githubPlaceholderEmail exported
  server/boot.server.ts                 # boot integrity log + boot reconcile
                                        #   rescan (offline-drift convergence)
  server/files/file-watch.service.server.ts  # + isFileWatcherAlive()
  server/db (unchanged)                 # migration state read via
                                        #   schema_migrations in boot/health
  routes/
    resources.health.ts                 # NEW: { ok, projections, watcher }
    project.activity.tsx                # ?stream=/?audit= limits + totals
    _index.tsx                          # + rebuild-projections intent (admin)
  features/
    activity/feed-limits.ts             # STREAM/AUDIT steps + clampFeedLimit
    activity/activity-page.tsx          # resolve-context tooltip on the pill,
                                        #   "Show older" buttons both panels
    home/home-query.server.ts           # org tile: REAL kb/mcp/skill counts
    home/home-page.tsx                  # admin "Rebuild projections" button +
                                        #   RebuildConfirm dialog + toast
    home/home-phase10-route.server.test.ts
    profile/profile-{query.server,page}.tsx  # @handle attribution when known
  shared/mapping/user.server.ts         # UserRow/UserRecord + github_handle
```

## 1. Audit completeness

**Canonical catalog** (`app/server/audit/audit-actions.ts`): every action
name ever recorded, with its scope (`auth|org|project|task|system`). The
regression has two halves in `audit-coverage.server.test.ts`:

- **Static sweep**: parses every `recordAudit(x, {` call site under `app/`
  + `scripts/` (single literals AND same-line ternaries), then asserts
  set-equality with the catalog in BOTH directions plus the
  dot-fact naming grammar. Adding a governed action without registering
  it — or leaving a stale catalog row — fails the suite with the file
  list in the message. Maintainable: one map entry per new action.
- **Table-driven functional**: 15 rows exercising the real entry points
  (create/comment/take/hand-off/release/admin-release/transition/resolve,
  run start+interrupt, violation open+resolve, grant-scope attempt,
  rescan, rebuild) and asserting the row landed with the catalogued name
  and the subject fields its scope demands (`task` → projectSlug+taskKey,
  `project` → projectSlug). Org/auth families keep their existing
  phase-2/9 per-surface tests; the static half still pins their naming.

**Holes found and filled** (the sweep confirmed everything else was
already recorded):

| gap | fix |
|---|---|
| run START was never audited (only interrupt) | `runtime.run.started` in `startRun` (subject `run/<id>`, details thread/backend/role/kind/simulated/resumed). `StartRunInput.actor?` added — additive, all call sites compile unchanged; default actor is the operator system actor (`{userId:null,label:"operator"}`). `resumeRun` forwards it. Seeded runs use `upsertRun` directly → seed stays audit-silent. |
| grant-scope ATTEMPTS were invisible (only successful resolutions audited) | `github.credential.revalidated` recorded by `revalidateProjectCredential` on every outcome: `no_pat_configured` / `network_unavailable` / `revalidated` (+validationStatus, resolvedViolations count). Both callers (GitHub view + Settings `runGrantScope`) inherit it. |
| OAuth provisioning paths (new in this phase) | `auth.oauth.user_provisioned`, `auth.oauth.placeholder_claimed` (§5). |
| full rebuild (new) | `projection.rebuild` (sibling of `projection.rescan`). |

**Naming drift ruling**: the org-family verb drift that shipped in 9B
(`org.kb.created/.deleted` vs `org.mcp.added/.removed` vs
`org.domain.whitelisted/.removed`) is **frozen as recorded vocabulary** —
renaming would orphan historical rows in live DBs and buy nothing; the
catalog is now the canonical registry going forward and the static test
prevents NEW drift. No existing action was renamed.

## 2. Audit surfaces (Activity panel deepened)

Per the mock check the brief mandated: `activity.jsx`'s audit panel has
**no filters** (the actor mini-seg explicitly does not touch it — spec
§4.2/§8.3), and the org-settings mock has **no audit tab** — so the
project Activity panel stays the audit home and no filter UI was
invented. What was deepened:

- **Complete readable rendering**: the whitelist
  (`AUDIT_ACTION_KINDS`) now covers every project-scoped governance
  family — all `project.*`, `github.credential.assigned/cleared/
  revalidated`, `github.pr.merge_refused` (blockedact),
  `task.ownership.admin_released`, `runtime.run.started` (the mock's
  "opened the Developer runtime session" row is now real) and
  `runtime.run.interrupted` (audit kind). Every action has a bespoke
  sentence template; the fallback template (`{actor} — {action words}.`)
  guarantees a whitelisted-before-templated addition still renders a
  sentence — **no raw JSON can reach the UI** (test-asserted). Stream
  -visible activity (comments/transitions/github/completion events)
  deliberately stays in the Stream panel; org-scoped and auth rows have
  no project home (see gaps).
- **Violation resolve context** (ruling 5 / 9C seam): `AuditLogEntry` now
  carries `resolvedAt` + `resolvedBy` (user-id resolved to display name,
  label fallback); the resolved pill's wrapper carries
  `title="Resolved by {name} · {time}"` (open pill: a grant hint). Mock
  markup unchanged.
- **Pagination**: both panels are bounded newest-first slices with
  loader-driven "Show older" (the task-detail `?events=` pattern):
  `?stream=` (step 200, ceiling 2000) and `?audit=` (step 60, ceiling
  600) via `clampFeedLimit` (`app/features/activity/feed-limits.ts`);
  `countActivityStream`/`countAuditLog` drive the remaining-count
  labels; buttons render only when the store holds more.

## 3. Diagnostics end-to-end (verified by breaking things)

All flows already worked (phases 3/5 built them soundly) — this phase
**proved** them live and pinned them with
`diagnostics-flow.server.test.ts`:

- Malformed frontmatter (invalid YAML) → `frontmatter.invalid_yaml`
  hard-stop + per-field fallbacks → readiness floored to `blocked`,
  board card pill flips, task DiagnosticsPanel lists every finding as
  `code — message` sentences (7 findings observed live on VIB-145, via
  the watcher in <1 s, no reload).
- Totally mangled file (no closing fence) → still projects, floored,
  never crashes.
- Unknown stage → `reference.unknown_stage` warning + `input_required`
  floor; duplicate `## Goal` → `body.duplicate_section` warning, first
  occurrence wins (phase-3 post-fixes confirmed).
- Fix + rescan/watcher → diagnostics rows deleted, readiness restored,
  DiagnosticsPanel disappears **live via SSE with the page open**.
- PAT diagnostics: GitHub view cred-card renders the missing
  `pull_request:write` chip + cred-warn + flagged VIB-142 keybtn from
  the seeded violation; VIB-142's timeline carries the typed policy
  event (phase-7 machinery, re-verified).

Note: file-drift diagnostics are PROJECTION state, not audit events (a
disk edit has no session actor) — the audit trail of recovery is the
`projection.rescan`/`projection.rebuild` audit rows + provenance, and
the violation/policy paths remain the audit-visible diagnostics. This is
the deliberate reading of "activity/audit visibility".

## 4. Recovery

- **Full rebuild** (`app/server/projections/rebuild.server.ts`):
  `rebuildProjections(db, {actor, dataRoot?})` deletes ALL file-derived
  rows (task_events, diagnostics, task_projections, projects →
  project_members cascades) and runs `rebuildAll({force:true})` inside
  ONE transaction (readers never see a half-empty projection), audits
  `projection.rebuild`, and the `projection.rebuilt` SSE broadcast rides
  the existing rebuildAll emit. NOT dropped: users/sessions/
  notifications/audit/provenance/PATs/violations/runs/org tables
  (app-owned or historical truth).
- **UI placement** (documented ADDITION — neither mock nor specs have a
  rebuild control): Home store strip, beside Re-scan, **admin-only**,
  `RebuildConfirm` packet-styled dialog (useDialog: Escape/scrim/trap),
  toast with real counts. Route intent `rebuild-projections` in
  `_index.tsx` (403 for non-admins, CSRF as ever). Everyday drift copy
  points users at Re-scan.
- **Boot reconcile + watcher restart**: the watcher runs with
  `ignoreInitial`, so edits made while the server is down used to sit
  stale until a manual re-scan. `bootServer` now runs one
  hash-short-circuited `rescanProjections` before starting the watcher
  — **verified live**: server killed → VIB-166 title edited on disk →
  restart → boot log `boot rescan reconciled offline drift (changed:1)`
  and the projection matched the file before first paint. Clean boots
  cost one no-op walk (2 ms on the seed store). Boot failures are
  caught and logged, never block startup.

## 5. Integration gaps from 9B/9C (closed)

**(a) OAuth callbacks consume the 9B org data**
(`oauth-shared.server.ts`; both providers' `complete*Login` route through
the new functions; callback route modules unchanged):

- **Google**: account-existence whitelist first (existing rows keep the
  exact phase-2 path — test-asserted, incl. role untouched). Otherwise
  `findDomainAllowlistRole(db, email)` (the 9B hook, now actually
  wired): allowlisted domain → passwordless user row provisioned with
  the domain's mapped role, name from the userinfo `name` claim
  (local-part fallback), `idp: google`, audit
  `auth.oauth.user_provisioned`, then the shared session path. Not
  allowlisted → the existing `not_whitelisted` failure + audit.
- **GitHub**: the callback now also fetches `GET /user` (login + name;
  best-effort — a profile failure degrades to the email-only path,
  test-asserted). Email match wins and persists the handle. No email
  match → the 9B placeholder convention (`github.com/<handle>` row from
  org-settings "Users & access") is **claimed**: the row's email/name
  become the real verified identity, `github_handle` stored, audit
  `auth.oauth.placeholder_claimed`, then sign-in. Placeholder rows are
  untouched when the email path matched (still claimable/removable).
  Nine mocked-provider tests cover both providers' paths.

**(b) Home org tile**: `getHomeOrgSummary` counts
`org_knowledge_bases`/`org_mcp_servers`/`org_skills` — live tile shows
"3 knowledge bases · 3 MCP · 4 skills" on the seed. (The GitHub
-connections tile still derives owners from project repos — see gaps.)

**(c) GitHub handle persisted** (it was cheap): migration 0009 adds
`users.github_handle`, written on every GitHub OAuth sign-in and on
placeholder claim. Profile "GitHub identity" panel renders
`@handle · GitHub sign-in` and attributes the connected cred-ok line to
`@handle` when known (email fallback preserved). Row mapping updated
(`UserRow`/`UserRecord.githubHandle`, patchable via `updateUserFields`).

## 6. Boot/runtime integrity + health

- **Boot integrity log** (`boot.server.ts`): one `boot integrity check`
  line — data-root subdir presence (`DATA_ROOT_SUBDIRS`, missing list
  when any), migrations applied count + latest filename (from
  `schema_migrations`; `getDb` already fail-fasts on a failed apply),
  projection counts (projects/tasks), user count.
- **`GET /resources/health`** (new route, CONVENTIONS route map):
  `{ ok: true, projections: { projects, tasks }, watcher: <bool> }`,
  200; `{ ok: false }` 503 when the DB can't answer. Unauthenticated by
  design (ops probes run sessionless; only aggregate counts are
  exposed). `watcher` comes from the new `isFileWatcherAlive()`; a dead
  watcher reports `false` without failing `ok` (requests still serve —
  the field is the degraded-mode signal).

## Decisions / deviations

1. **No audit-panel filters** — the brief's conditional resolved against:
   the mock has none (checked in activity.jsx / spec §4.2); the panel
   stays mock-1:1 with pagination + tooltips as the only additions.
2. **Rebuild control placement** is an authored addition on the Home
   store strip (admin-only, confirmed) — the mock/specs place no rebuild
   affordance anywhere; documented here per the phase plan.
3. **Historical audit action names frozen**; the catalog + static test
   govern the namespace from now on (no renames of recorded vocabulary).
4. **`github.credential.revalidated` logs attempts**, including
   `no_pat_configured` — a governed-surface click is a governed action
   even when it can't proceed (the live pass shows "requested a scope
   grant — no GitHub credential configured." in the panel).
5. **`runtime.run.started` default actor is the operator** system actor;
   human-triggered starts (future surfaces) should pass the session
   actor via `StartRunInput.actor`. The audit-panel row reads
   "{actor} opened the {role} runtime session — recorded per audit
   policy on {task}", realizing the mock's session-open row.
6. **Boot rescan writes one `projection.rescan` audit row per process
   start** (system actor) — deliberate: recovery actions are audited,
   and boot IS a recovery point. HMR reloads don't re-run it (BOOT_KEY).
7. **Placeholder-claim conflict rule**: verified-email match beats the
   handle placeholder; a claimed row keeps its whitelisted role; the
   provider display name wins over `@handle` (placeholder name kept when
   the provider has none).
8. **The BUILD-PLAN's "secret-isolation guard (scrub known secret
   patterns from logs/timeline writes)"** was explicitly scoped OUT by
   the Phase-10 brief (no security-hardening work; the existing
   discipline — sealed tokens, no-token-in-results contracts from
   phase 7 — stays as-is). On record as not built in this phase.
9. **Health endpoint returns flat JSON** (the exact shape the plan
   specifies), not the `{ data }` envelope — ops-probe convention wins
   over the JSON-endpoint rule; documented divergence.
10. **`feed-limits.ts` duplicates the 200/60 defaults** of
    `activity-feed.server.ts` (a client-safe module can't import
    .server; server→feature import would invert layering). The loader
    always passes explicit limits, so the server defaults are
    effectively dev-facing only.

## Live verification (dev :5173, preview browser)

`npm run seed -- --reset`, `npm run dev`, signed in as arda@viberr.dev.
Browser console: **zero warnings/errors** for the whole pass.

- Boot log shows `boot integrity check` (dirs ok, 8 migrations,
  latest 0009, 3 projects / 10 tasks / 6 users);
  `curl /resources/health` → `{"ok":true,"projections":{"projects":3,
  "tasks":10},"watcher":true}`.
- Home org tile: "3 knowledge bases · 3 MCP · 4 skills"; store strip
  shows Re-scan + (admin) Rebuild projections.
- **Rebuild**: confirm dialog → run → sqlite shows the
  `projection.rebuild` audit row (arda) with
  `{projects:3,tasks:10,changed:13,errors:0}`; counts identical after
  (3/10/32); `projection.rebuilt` broadcast revalidated the open page.
- **Diagnostics break/fix**: `readiness: [unclosed` written into
  VIB-145's frontmatter on disk → watcher reprojected <1 s → board card
  moved to Triage with a `blocked` pill → task page: Diagnostics panel
  "7 findings", every row a readable `code — message` sentence, hero
  pill blocked. Restored the file → projection back to
  review/ready/0 findings, and the open task page cleared the panel
  LIVE via SSE (no navigation).
- **Governed actions → audit panel**: Selin reviewer→viewer→reviewer
  (Policy), stage add + remove (Settings), Grant scope with no PAT
  (Settings, typed toast), Interrupt on VIB-151's running primary. The
  Activity audit panel rendered all of them readably ("Arda Kaya set
  Selin Aksoy to **viewer**.", "…requested a scope grant — no GitHub
  credential configured.", "…interrupted an agent run — recorded per
  audit policy on VIB-151" with audit tint), plus the seeded open
  violation with its pill; zero raw JSON anywhere.
- **PAT diagnostics**: /github cred-card shows repo/workflow/read:org
  chips + `pull_request:write [miss]` and the cred-warn flagging
  VIB-142 with Grant scope / Fix in Settings.
- **Watcher-restart convergence**: server killed → VIB-166 title edited
  on disk → restart → boot log `boot rescan reconciled offline drift
  (changed:1)`, projection matched before first request; file restored,
  watcher reprojected.
- Server stopped; `npm run seed -- --reset` → pristine (identical
  counts, 0 changed / 13 unchanged rescan, VIB-142 violation `open`).

## Known gaps (intentional)

- **Org-level audit console**: org-scoped rows (`org.*`, `github.pat.*`,
  auth) have no UI surface — the mock has no org audit tab. The catalog +
  `listAuditEvents` make a future `/org/settings?tab=audit` a pure
  rendering exercise.
- Home "GitHub connections" tile still derives owners from project repos
  (phase-4 stand-in); switching it to `github_connections` changes
  displayed content and was out of the brief's counted gap (b).
- `runtime.run.started` rows for seeded demo runs don't exist (seed
  bypasses startRun by design); only real starts audit.
- Provenance table grows unboundedly (one row per projection action) —
  retention policy is a Phase-11/ops question.
- Policy header "last change" chip still doesn't deep-link into a
  filtered audit view (9A suggestion; no filterable view exists to link
  to, per decision 1).

## What Phase 11 needs

- The health route is ready for container HEALTHCHECK / compose probes
  (`/resources/health`, 200/503, no auth).
- Boot logs now carry integrity + drift lines worth surfacing in ops
  docs; `npm run rescan` output unchanged.
- `audit-actions.ts` is the registry to extend for any new governed
  action; the static sweep enforces registration automatically.
- E2E golden paths can assert the rebuild + break/fix diagnostics flows
  exactly as the live pass above (stable selectors: `.confirm-card`,
  Diagnostics panel head, `.pev-list`).
