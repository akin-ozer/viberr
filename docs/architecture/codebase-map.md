# Codebase map

> Directory by directory: what lives where, what each module owns, and the import rules
> between layers. Counts are approximate and drift; the structure does not. `app/` holds
> about 455 modules and about 400 co-located test files; `app/server/` about 210 modules.
>
> Source of truth: the tree itself (`ls` / `find`), each module's header comment,
> `package.json` and `app/features/shell/nav.ts`.
>
> Verified against `main` @ `7d9fbf72` (2026-09-23).

## 1. Top level

```
app/                 the application (React Router 8 framework mode, SSR)
db/migrations/       0001_baseline.sql — the whole SQLite schema, squashed
scripts/             operational CLIs run with tsx (seed, seed-demo, rescan, store-check, backup,
                     restore, secret-keys, deploy, e2e) plus two node scripts (anti-slop-manifest.mjs,
                     measure-routes.mjs); no docker-entrypoint.sh: the image declares no ENTRYPOINT
e2e/                 Playwright specs (8) + the login fixture (auth.setup.ts)
test-support/        vitest setup and harnesses: hermetic env + <dialog> polyfill, test app/db/store,
                     fake runtime, fake GitHub fetch, a local git origin, fake vendor binaries
                     (writeFakeVendorBinaries, the sign-in driver's real child process), backend
                     credentials (connectFakeBackend / disconnectFakeBackend, ruling 127), the demo seed
                     and data, a custom 3-stage board, a raw audit reader, MCP tool-meta and
                     strict-schema checks, the hermetic toolchain reading, and the performance
                     ratchet (ruling 454): perf-verdict / perf-budgets(/) / perf-ratchet, the
                     counters (perf-counters, render-counter), the revalidation and dock harnesses,
                     the console fixture, a static-import walker and the app.css rule parser
tools/oxlint/        the vendored anti-slop lint plugin (15 rules) and its pinned manifest
design/              the HTML/JSX prototype the UI was ported from, the design system, a PRD mirror
planning/            canon (planning-artifacts/: prd, architecture, UX spec) and the discovery-pass
                     ledgers, plans and probes
qa/                  smoke-run evidence notes written by agents during live passes
test-artifacts/      captured pass-20 canary transcripts and controller live-run screenshots
docs/                this documentation set
public/              favicon.svg
.github/workflows/   ci.yml: lint, typecheck, test, build; then the e2e job
compose.yml          production-shaped single container (init: true, hostname viberr, healthcheck on
                     /resources/health); compose.e2e.yml is the isolated e2e stack
Dockerfile           three stages: prod-deps, build, runtime (node:26-slim + git + make + curl + pnpm +
                     chromium + uv); no ENTRYPOINT, no backend credential, no runtime home baked in
                     (ruling 127); CMD runs node directly
.claude/launch.json  three launchers: dev on docker-data, dev on the hermetic ./data (port 5174), and the
                     production build on ./data (port 5175) for measuring
.claude/skills/, .agents/skills/
                     agent skills for coding sessions (skills-lock.json pins their sources)
config               vite.config.ts, vitest.config.ts, playwright.config.ts, react-router.config.ts,
                     tsconfig.json, .oxlintrc.json, doctor.config.ts + .react-doctor/ (react-doctor)
```

## 2. Layers inside `app/`

```
app/
  root.tsx, routes.ts, entry.client.tsx, entry.server.tsx, app.css
  routes/      thin route modules: loader → *-query.server; action → intent switch → *-actions.server
  features/    per-surface UI plus its loader/action glue (may import server/ and shared/)
  ui/          reusable primitives — must NOT import from features/ or server/
  lib/         the better-auth instance and its Viberr bridge
  server/      server-only modules (*.server.ts), never imported by client code
  schemas/     shared Zod schemas (task file, project file, goal file, SSE events, PAT validation, diagnostics)
  shared/      narrow cross-surface helpers (rbac, capabilities, workflow, dependencies, mapping, dates…)
```

Rules: server-only files carry the `.server.ts` suffix and are stripped from the
client bundle; `ui/` never imports `features/` or `server/`; `features/` may import
`server/` (the allowed direction); `server/` imports from `features/` only
`*.server.ts` modules, types, and four pure helpers (listed in
[overview.md §3](overview.md#3-layers-and-the-rules-between-them)); readiness derivation
and diagnostics severity live only under `server/interpretation/`, freshness thresholds
only in `shared/freshness.ts`; DB rows map to camelCase only through `shared/mapping/`.
Tests are co-located (`foo.server.test.ts`). There are no `utils.ts` dumping grounds.
`app/routes/` holds 38 modules (36 routes plus `project-visibility.server.ts`, the
members-only 404 guard for actions, and `project-workspace.server.ts`, the one gated read
of a project the workspace layout and the board loader share per request, ruling 454);
the route table is `app/routes.ts`.

## 3. `app/server/` by directory

| Directory | Owns |
|---|---|
| `boot.server.ts` | The one-time startup sequence: crash handlers, env, dirs, data-root lock and guard, shipped assets, self-heal, database, bootstrap admin, publisher, derivation-version rebuild or rescan, base agents, watchers, maintenance, Codex rollout repair, run recovery, schedule and goal runners, reconcile poller, controller recovery, integrity log. |
| `actions/` | `withActionWatchdog`: a 30 s wall-clock ceiling on a mutating action (wraps project creation). |
| `agents/` | `deployment-view.server.ts`: resolves a deployment to its effective runtime identity and the backend a run would use (`primaryRunBackend`, `deployedSpecialistBackends`). |
| `audit/` | `recordAudit` (`audit-recorder`), `audit-query` (freshness reads), `audit-browse` (org-admin in-app view), `audit-export` (CSV/JSON download, 100 000-row cap), `s3-config` + `s3-put` (SigV4 PUT, no SDK). |
| `auth/` | better-auth identity provisioning, login + forced reset, password hashing, rate limit (10 per email+ip per 15 min), CSRF (origin proof + HMAC double-submit), `requireFormAction` + `appErrorResponse`, OAuth providers configured in-app and their credential test, OAuth whitelist provisioning, `require-user` guards, `project-authority` (the single project-authority resolver), `authority-prompt` (the authorization table written out for the controller model, ruling 309), `require-project` (the members-only 404), user admin and store, bootstrap admin. |
| `config/` | `env.server.ts`: the validated environment schema. |
| `controller/` | Conversations store (scopes: instance / board / task), run engine, the per-turn context read (`controller-context.server.ts`, ruling 121), toolkit (`viberr_controller`), ops MCP (`viberr_ops`), tool guards, controller profile, the controller's standing resource requests (`controller-requests.server.ts`, `agents/controller-requests.md`, ruling 390). |
| `db/` | SQLite open + pragmas, the copy-first read-only open (ruling 158), migration runner, baseline-column backfill, data-root writer lock + guard, CLI lock for scripts, retention, self-heal of a corrupt DB, backup/restore, transaction helper. |
| `errors/` | `AppError` and the stable `ERROR_CODES`. |
| `events/` | Projection event emitter, the SSE broker (per-connection scopes, 25 s heartbeat, a 256-event replay ring for data events and one for console lines, re-authorization each tick, the process shutdown hook), the publisher bridging the two. |
| `files/` | The file store: data-root layout, atomic writes, per-file mutex, read-your-own-writes cache, the readers' content-keyed parse memo (ruling 454), frontmatter codec, task/project/goal/agent-profile readers and writers, actor-ref codec, the chokidar watcher (250 ms debounce, retrying failed rebuilds) and KB watcher, the KB index injector (ruling 283) and skill injection reader (24 000-char budget), the project rulings KB (ruling 239), attachments, the store doctor. |
| `github/` | Client, project GitHub context, branch sync, empty-repo bootstrap (ruling 128), PR open/link/adopt and the adoption record, PR diff reads for the controller (ruling 266), workspace push and delivery reconciliation, reconciler + 5-minute poller, human-approval verdict, update-branch (merge, never rebase) and its operator decision half, the acceptance-boundary refresh rule (ruling 162), branch cleanup, scope-violation side effects, repo access check and remembered repo health, the agent GitHub read tool. |
| `http/` | `isDocumentNavigation`: a document load (a hard load, a refresh, a new tab) versus single fetch's `.data` request; R19-15's read-marking and ruling 454's console shipping ask it. |
| `insights/` | One aggregate query over `agent_runs` for `/insights`. |
| `interpretation/` | Readiness derivation, diagnostics severity, freshness re-export. |
| `logging/` | Dependency-free JSON logger; request correlation via `AsyncLocalStorage`. |
| `ops/` | Build info, disk space, health snapshot, maintenance scheduler, transcript retention, the host toolchain probe (ruling 182). |
| `org/` | Org resources (KBs, MCP servers incl. stdio probes and background warm-ups, skills), the `resource.updated` broadcast, store file browser, GitHub owner connections, org users, global agent templates and template grant propagation (ruling 156), resource catalog and reference integrity, org seed, the org-settings loader payload. |
| `prefs/` | `user_prefs` key-value store. |
| `projections/` | Rebuilder (files → SQLite), full rebuild, instance and project rescan, the derivation version stamp, per-file projection faults for health (rulings 217/218), single-flight cooldowns, board/task/review/activity/agent-deployment/decision/notification/policy-violation read models, the dependency read model (ruling 131), task-key links, task activity ("gone quiet"). |
| `provenance/` | Read and write layers over the `provenance` table. |
| `runtimes/` | Adapter interface, Claude and Codex adapters, the Claude process-group spawn and the settled-run process sweep (`claude-spawn`, `run-processes`, ruling 174), the Codex app-server compaction client (ruling 376), runtime registry (spawn env filtering + adapter construction only), and the ruling-127 per-person auth modules: `user-homes.server.ts` (the one resolver for `runtimes/users/<userId>/{claude-home,codex-home}`), `backend-credentials.server.ts` (the `user_backend_credentials` store, provider verification, vendor logout, per-person health, `runCredentialFor`), `run-principal.server.ts` (owner/asker resolution and the single refusal sentence) and `backend-login.server.ts` (the hosted sign-in driver over the unmodified vendor binaries). Then run service (start/resume/interrupt/log, concurrency cap and queue), run store (raw NDJSON + rows), run sink (persist then publish), run events, run projection, run inputs disclosure (ruling 344), context-compaction events (ruling 369), provider-refusal classification (ruling 416), context policy and prompt-prefix ordering (ruling 370), Bash argument policy (ruling 101(e)), wire-format normalizer, model catalog and availability, backend quota telemetry, strict MCP tool definitions and the tool manifest (ruling 297), skill mount (workspace `.claude` owner), session export, run recovery, operator run engine. |
| `secrets/` | Secret box (AES-256-GCM `v1$iv$ct$tag`), PAT store and validator, key rotation reseal, git-output redaction. |
| `seed/` | Product seed (clean sheet), the built-in agent catalog, shipped assets (`assets/`: skills, definitions, profiles) and the boot backfill, base-agent deployment, seed credentials. |
| `settings/` | `instance_settings` JSON key-value (concurrency cap, per-run spend cap, quota observations, the projection derivation version). |
| `tasks/` | The governed task mutations (`task-actions`, the largest module), the mutation substrate and cycle break (`task-mutation`), task closure (ruling 177), operator actions and toolkit, agent toolkit and outcome envelope, the board read agents and operators share (rulings 281/282), agent reply routing, mention notify/suggestions and display names, comment guardrails, timeline compaction, no-change completion, specialist run (workspace, mounts, prompt, dispatch), specialist MCP and browser MCP mounts, tool policy (capability → tool denylist), repo mirror and workspace refresh (ruling 129), clone auth/progress, schedules and the stranded-task sweep (ruling 330), goal actions, dependencies and release (ruling 131), file leases (ruling 245), required reviewers (ruling 178), review deadlock (ruling 237), packet fan-out (ruling 319), run-failure remedies (ruling 130), similar tasks (ruling 324), workspace retention, operator repo read, model prose repair. |
| `theme/` | The `viberr_theme` cookie. |

## 4. `app/features/` by surface

| Directory | Surface |
|---|---|
| `shell/` | Workspace rail (`nav.ts` order: Board, Review queue, Controller, Agents, Policy, GitHub, Activity, Settings), topbar, the standalone-page header (`page-topbar.tsx`, ruling 145 — mounted by the `palette-shell` layout for the routes `standalonePageLabel` names), the shared palette trigger both headers render, ⌘K palette and its server query, bell popover (pages ship its counts; it loads its list from `routes/resources.notifications.ts`, ruling 454), user menu, theme preference, route pending bar, CSRF result helper. |
| `home/` | `/`: project cards, pinned/all/archived groups, new-project modal (name, key, connection, repo, workflow, agent policy preset), project creation server logic, org tiles, admin store strip (re-scan, rebuild). |
| `board/` | Board columns, the board card projection the board loader ships (`board-card.ts`, `toBoardCard`: the fields the board reads, ruling 454), the card's one status seat and problem chips (`card-status.ts`, ruling 365), filters (URL params), dnd-kit drag with server-authoritative drop resolution (`board-dnd.ts`), list view, new-task modal, board-drop acceptance confirm, orphan and repo-access banners. |
| `task-detail/` | Hero, diagnostics, recommendations, execution profile with the agent picker, run controls and scheduling, decision packet, live run strip, agent logs, timeline (Lexical composer with @mention autocomplete, loaded lazily behind a same-size stand-in that keeps what was typed, ruling 454; sliced newest-first), attachments panel and lightbox, side panels (GitHub trace, current state, permissions), accept/release/archive/move-back confirms (move-back asks why, ruling 381), delivery and completion toasts, continuity recovery panel, plus the per-person run principal every run control answers from (`run-principal-view.ts`, ruling 127). |
| `runtime/` | Run panels (live strip, log console, raw view), the run-log console's store and hook (`run-log-store.ts`, `use-run-log-stream.ts`: lines outside React state, frames from the layout's live stream, ruling 454), the incremental console fold (`console-fold.ts`), the readable live step, log noise filter and clock helpers. |
| `review/` | The review queue split by acceptance authority. |
| `agents/` | Profiles master-detail, create/edit modal, capability matrix modal, roster assembly, profile CRUD actions. |
| `policy/` | Human access roles, agent capability rows, workflow rules, guardrails, required reviewers, permission table from `rbac.ts`. |
| `github/` | Repository panel, credential card (shared with settings), PR list, branch table, reconcile and grant-scope actions, credential redaction by role. |
| `activity/` | Cross-task stream and project audit column with compaction and paging. |
| `project-settings/` | Identity, workflow stages (with colour presets, ruling 364), required reviewers, file leases, members, repository and credentials (repair, scope re-check, branch cleanup toggle), danger zone. |
| `org-settings/` | Tabs: GitHub connections, users and access, sign-in & SSO, agent resources (KBs, MCP servers, skills, global agent templates, store browser), controller (profile, locks, standing requests); below the tabs: run concurrency and run spend cap, the audit export card, the storage line. |
| `kb-browser/` | The store folder file manager (upload, folders, GitHub import, SKILL.md editing). |
| `controller/` | The conversation surface and the Goals panel; the working-turn step row (ruling 250) and scoped example prompts (ruling 314); the controller dock (`controller-dock.tsx`, mounted by `root.tsx`; its open panel's body `controller-dock-panel.tsx`, loaded on demand, ruling 454; the not-connected note both composers share, `not-connected.tsx`), its route-derived scope (`controller-dock-context.ts`) and its view builder (`controller-dock-query.server.ts`, served by `routes/resources.controller.ts`). |
| `notifications/` | The inbox page and the shared notification row. |
| `profile/` | Identity, notification routing, appearance, access view, GitHub identity, password change, and the **Agent accounts** panel (ruling 127): one card per backend with the hosted sign-in, the paste forms and Disconnect, polling `/resources/backend-login` while a sign-in is live. |
| `insights/` | Read-only run analytics dashboard (oversight cards, backend quota, prompt cache, breakdowns, daily chart). |
| `live-updates/` | `useLiveUpdates`: SSE subscription → debounced loader revalidation, replaying what a reconnect missed; `revalidation-policy.ts`: which loader re-runs on which trigger (every route's `shouldRevalidate`, and the tab's ledger of what its loaders owe, ruling 454); `event-types.ts` mirrors the wire contract. |

Also under `features/`, five copy and behaviour pins: `copy-ban.test.ts` (the "govern*"
word is banned from rendered copy), `retired-vocabulary.test.tsx` ("primary specialist"
and friends), `rebase-advice.test.ts` (Viberr never tells anyone to rebase, ruling 291),
`shortcut-glyph.test.ts` (no literal ⌘, ruling 419(d)) and `toast-honesty.test.ts` (a
failure toast never renders the success tick).

## 5. `app/ui/` primitives

`avatar` + `initials`, `identity` (agent glyph: sparkle for Claude, cpu for Codex, shield
for the operator), `icon` (one stroke icon set), `pill` (the one
readiness/validation/state mapping), `rich-text` (inline `**bold**`, `` `code` ``,
`@mention`), `markdown` (react-markdown + GFM with attachment-aware images), `code-view` +
`code-language` + `code-highlight` (the ruling-363 reader: numbered lines, Shiki tokens by
filename grammar, loaded on first use), `mention-spans`, `toast` (bottom-center, 2600 ms),
`confirm-dialog`, `use-dialog` (native `<dialog>` contract: Escape, backdrop click, focus
restore), `use-dismiss`, `page-overlay`, `stage-menu`, `task-meta` (priority, labels, due
date), `label-input`, `calendar` + `date-picker`, `local-time` + `use-relative-time`
(hydration-safe timestamps), `use-clock` (one shared interval per cadence for every
ticking reader, ruling 454), `use-stable-rows` (structural sharing of loader rows and
values across revalidations, ruling 454), `number-ticker` (counts up to a figure,
ruling 366(f); it commits only when the drawn digits change),
`csrf-input`, `skip-link`, `radio-seg` (single-select group on Radix `ToggleGroup`,
ruling 166), `toggle`, `use-fetcher-result` / `use-action-toast`, `use-shortcut-hint`.

## 6. `app/shared/`

`rbac.ts` (the permission table), `capabilities.ts` (the capability catalog, enforcement
scopes, grant couplings), `acceptance-disclosure.ts` (the accept echo contract),
`mcp-reserved.ts`, `mcp-tools.ts` (admin-marked MCP write tools, ruling 176),
`model-ids.ts`, `freshness.ts` (stale after 1 h), `controller-locks.ts` (ruling 108),
`dependencies.ts` (the `blockedBy` vocabulary, ruling 131), `file-leases.ts` (ruling
245), `credential-scopes.ts` (violation vs advisory GitHub scopes, ruling 380(b)),
`github-handle.ts` (ruling 154), `names.ts`, `attachment-kinds.ts`, `page-title.ts`
(one title grammar), `packet-goal-draft.ts` (ruling 138), `packet-server-outcome.ts`
(ruling 136(a)), `provider-marker.ts`, `revision-drift.ts` (ruling 132), `run-failure.ts`
(the failed-run vocabulary, ruling 130(a)), `task-key-links.ts`,
`workflow/` (templates, transitions chain maintenance, stage roles, stage eligibility,
stage colour presets (ruling 364), packet option kinds (ruling 164), the re-verdict stage
(ruling 163), guardrail labels),
`mapping/` (`*.server.ts` row → render shapes for users, projects, tasks, task events,
actors, notifications; `deriveDisplayReadiness` and the live-backend overlay live in
`task.server.ts`), `dates/` (`format.ts`, the one timestamp formatter; `time-zone.ts`,
the viewer's zone for the controller's prose), `ids/` (`newId` in `new-id.server.ts`,
`slugify`), `text/` (`plural`, store text extensions), `auth/` (auth paths, password
policy), `docs/` (six tests: `design/prd.md` against the canon PRD, `file-formats.md`
against `PACKET_OPTION_KINDS`, the rulings supersession markers, the runbook's
database-read rules, the vendored anti-slop tree against its manifest, the vitest
per-test budget).

## 7. `app/schemas/`

`task-file.schema.ts` (frontmatter, packet, engagements, revisions, verdicts,
schedules, recommendations, timeline events, the tolerant frontmatter parser
`parseTaskFrontmatter` and the derivations `deriveValidation` /
`acceptanceBlockedReason`), `project-file.schema.ts`, `goal-file.schema.ts`,
`sse-event.schema.ts`, `github-pat.schema.ts`, `file-diagnostics.ts` (the diagnostic
shape, its constructors and the per-row tolerance helper `tolerantRowsOf`).

## 8. Scripts

| `npm run …` | Does |
|---|---|
| `dev` / `build` / `start` | React Router dev server / production build / serve |
| `lint` | oxlint with the vendored anti-slop plugin; must exit 0 |
| `typecheck` | route typegen + `tsc` |
| `test` | vitest over `app/**/*.test.{ts,tsx}` |
| `e2e` | `scripts/e2e.ts`: build the production image, seed the demo fixture on a named volume, run Playwright, tear down |
| `seed` | product baseline: agent templates, KBs, skills, domain allowlist, bootstrap admin; `-- --reset` wipes board and derived state (takes the writer lock) |
| `seed:demo` | the test/dev mock board (arda & co) the route and e2e suites use |
| `rescan` | reconcile projections with the file store; `-- --force` reprojects every file (takes the writer lock) |
| `store:check` | read-only store doctor: which canonical files the app cannot trust and why |
| `backup` / `restore` | point-in-time artefact with `VACUUM INTO` + the markdown tree; whole-root or single-file restore |
| `keys` | `status` / `reseal [--dry-run]` for encryption-key rotation |
| `deploy` | stamp the build from git, build, `compose up`, then read back which build is serving (ruling 345); `-- --no-up` stops after the build |

Outside `npm run`: `node scripts/anti-slop-manifest.mjs` re-pins
`tools/oxlint/anti-slop.manifest.json` after the vendored plugin is refreshed, and
`node scripts/measure-routes.mjs` reports the client asset closure per route.

See [scripts.md](../development/scripts.md) for details and
[deployment.md](../operations/deployment.md) for the container.
