# Codebase map

> Directory by directory: what lives where, what each module owns, and the
> import rules between layers. Generated from the tree on `main` @ `68b5480`
> (2026-09-01) and the header comment of each module; the ruling-121 rows
> re-verified against the working tree on 2026-09-03. Counts are approximate
> and will drift; the structure will not. Updated 2026-09-02 for ruling 127 (branch
> `claude/per-user-codex-auth-difdnn`): the per-person backend modules under
> `server/runtimes/`, the deleted config-dir resolvers, and the deleted image entrypoint.

## 1. Top level

```
app/                 the application (React Router 8 framework mode, SSR)
db/migrations/       0001_baseline.sql — the whole SQLite schema, squashed
scripts/             operational CLIs run with tsx (seed, rescan, backup, restore, keys, store:check, e2e)
                     (no docker-entrypoint.sh since ruling 127: the image declares no ENTRYPOINT)
e2e/                 Playwright specs + the login fixture (auth.setup.ts)
test-support/        vitest fakes: app, db, store, runtime, github, demo seed, backend credentials
                     (connectFakeBackend / disconnectFakeBackend, ruling 127), fake vendor
                     binaries (writeFakeVendorBinaries, the sign-in driver's real child process)
tools/oxlint/        the vendored anti-slop lint plugin (15 rules)
design/              the HTML/JSX prototype the UI was ported from, the design system, a PRD mirror
planning/            canon (planning-artifacts/) and the discovery-pass ledgers
qa/                  smoke-run evidence notes written by agents during live passes
docs/                this documentation set
compose.yml          production-shaped single container; compose.e2e.yml is the isolated e2e stack
Dockerfile           three stages: prod-deps, build, runtime (node:26-slim + git + chromium + uv);
                     no ENTRYPOINT, no backend credential, no runtime home baked in (ruling 127)
.claude/launch.json  two dev launchers (docker-data vs hermetic ./data)
```

## 2. Layers inside `app/`

```
app/
  root.tsx, routes.ts, entry.client.tsx, entry.server.tsx, app.css
  routes/      thin route modules: loader → *-query.server; action → intent switch → *-actions.server
  features/    per-surface UI plus its loader/action glue (may import server/ and shared/)
  ui/          reusable primitives — must NOT import from features/
  lib/         the better-auth instance and its Viberr bridge
  server/      server-only modules (*.server.ts), never imported by client code
  schemas/     shared Zod schemas (task file, project file, goal file, SSE events, PAT validation, diagnostics)
  shared/      narrow cross-surface helpers safe on both sides (rbac, capabilities, workflow, mapping, dates…)
```

Rules: server-only files carry the `.server.ts` suffix and are stripped from the
client bundle; `ui/` never imports `features/`; `features/` may import `server/`
(the allowed direction), `server/` never imports `features/`; interpretation logic
(readiness, diagnostics severity, freshness) lives only under
`server/interpretation/`; DB rows map to camelCase only through `shared/mapping/`.
Tests are co-located (`foo.server.test.ts`). There are no `utils.ts` dumping grounds.

## 3. `app/server/` by directory

| Directory | Owns |
|---|---|
| `boot.server.ts` | The one-time startup sequence: env, data-root lock, dirs, self-heal, migrations, bootstrap admin, publisher, rescan, base agents, watchers, maintenance, run recovery, schedule and goal runners, reconcile poller, integrity log. |
| `actions/` | `withActionWatchdog`: a 30 s wall-clock ceiling on a mutating action. |
| `agents/` | `deployment-view.server.ts`: resolves a deployment to its effective runtime identity and the backend a run would use (`primaryRunBackend`, `deployedSpecialistBackends`). |
| `audit/` | `recordAudit` (writes), `audit-query` (freshness reads), `audit-browse` (org-admin in-app view), `audit-export` (CSV/JSON download, 100k cap), `s3-config` + `s3-put` (SigV4 PUT, no SDK). |
| `auth/` | better-auth identity provisioning, login + forced reset, rate limit (10 per email+ip per 15 min), CSRF (origin proof + HMAC double-submit), OAuth providers configured in-app and their credential test, OAuth whitelist provisioning, `require-user` guards, `project-authority` (the single project-authority resolver), `require-project` (the members-only 404), user admin and store, bootstrap admin. |
| `config/` | `env.server.ts`: the validated environment schema. |
| `controller/` | Conversations store (scopes: instance / board / task), run engine, the per-turn context read (`controller-context.server.ts`, ruling 121), toolkit (`viberr_controller`), ops MCP (`viberr_ops`), tool guards, controller profile + locks. |
| `db/` | SQLite open + pragmas, migration runner, data-root writer lock + guard, CLI lock for scripts, retention, self-heal of a corrupt DB, backup/restore, transaction helper. |
| `errors/` | `AppError` and the stable `ERROR_CODES`. |
| `events/` | Projection event emitter, the SSE broker (per-connection scopes, 25 s heartbeat, 256-event ring buffer, re-authorization each tick), the publisher bridging the two. |
| `files/` | The file store: data-root layout, atomic writes, per-file mutex, frontmatter codec, task/project/goal/agent-profile readers and writers, actor-ref codec, the chokidar watcher (250 ms debounce) and KB watcher, KB and skill injection readers (24 000-char budgets), attachments, the store doctor. |
| `github/` | Client, project GitHub context, branch sync, PR open/link/adopt, workspace push and delivery reconciliation, reconciler + 5-minute poller, human-approval verdict, update-branch (merge, never rebase) and its operator decision half, branch cleanup, scope-violation side effects, repo access check, the agent GitHub read tool. |
| `insights/` | One aggregate query over `agent_runs` for `/insights`. |
| `interpretation/` | Readiness derivation, diagnostics severity, freshness thresholds. |
| `logging/` | Dependency-free JSON logger; request correlation via `AsyncLocalStorage`. |
| `ops/` | Build info, disk space, health snapshot, maintenance scheduler, transcript retention. |
| `org/` | Org resources (KBs, MCP servers incl. stdio probes and background warm-ups, skills), store file browser, GitHub owner connections, org users, global agent templates, resource catalog and reference integrity, org seed, the org-settings loader payload. |
| `prefs/` | `user_prefs` key-value store. |
| `projections/` | Rebuilder (files → SQLite), full rebuild, rescan, single-flight cooldowns, board/task/review/activity/agent-deployment/decision/notification/policy-violation read models, task activity ("gone quiet"). |
| `provenance/` | Read and write layers over the `provenance` table. |
| `runtimes/` | Adapter interface, Claude and Codex adapters, runtime registry (spawn env filtering + adapter construction only), and the ruling-127 per-person auth trio: `user-homes.server.ts` (the one resolver for `runtimes/users/<userId>/{claude-home,codex-home}`), `backend-credentials.server.ts` (the `user_backend_credentials` store, provider verification, vendor logout, per-person health, `runCredentialFor`) and `run-principal.server.ts` (owner/asker resolution and the single refusal sentence), plus `backend-login.server.ts` (the hosted sign-in driver over the unmodified vendor binaries). Then run service (start/resume/interrupt/log, concurrency cap and queue), run store (raw NDJSON + rows), run sink (persist then publish), run events, run projection, wire-format normalizer, model catalog and availability, backend quota telemetry, skill mount (workspace `.claude` owner), session export, run recovery, operator run engine. *(Corrected 2026-09-02, ruling 127 — `claude-config.server.ts` and `codex-config.server.ts`, the shared config-dir resolvers, and the registry's whole availability half (`isBackendAvailable`, `backendCredentialHealth`, the CLI-auth diagnostics, `setBackendAvailability`, `codexSpawnEnv`/`claudeSpawnEnv`) are deleted, not moved.)* |
| `secrets/` | Secret box (AES-256-GCM `v1$iv$ct$tag`), PAT store and validator, key rotation reseal, git-output redaction. |
| `seed/` | Product seed (clean sheet), the built-in agent catalog, shipped assets (skills, definitions, profiles) and the boot backfill, base-agent deployment, seed credentials. |
| `settings/` | `instance_settings` JSON key-value (concurrency cap, quota observations). |
| `tasks/` | The governed task mutations (`task-actions`, the largest module), the mutation substrate and cycle break (`task-mutation`), operator actions and toolkit, agent toolkit and outcome envelope, agent reply routing, mention notify/suggestions, comment guardrails, timeline compaction, no-change completion, specialist run (workspace, mounts, prompt, dispatch), specialist MCP and browser MCP mounts, tool policy (capability → tool denylist), repo mirror, clone auth/progress, schedules, goal actions, workspace retention, operator repo read, model prose repair. |
| `theme/` | The `viberr_theme` cookie. |

## 4. `app/features/` by surface

| Directory | Surface |
|---|---|
| `shell/` | Workspace rail (`nav.ts` order: Board, Review queue, Controller, Agents, Policy, GitHub, Activity, Settings), topbar, the standalone-page header (`page-topbar.tsx`, ruling 145 — mounted by the `palette-shell` layout for the routes `standalonePageLabel` names), the shared palette trigger both headers render, ⌘K palette and its server query, bell popover, user menu, theme preference, route pending bar, CSRF result helper. |
| `home/` | `/`: project cards, pinned/all/archived groups, new-project modal (name, key, connection, repo, workflow, policy preset), project creation server logic, org tiles, admin store strip (re-scan, rebuild). |
| `board/` | Board columns, filters (URL params), dnd-kit drag with server-authoritative drop resolution, list view, new-task dialog, board-drop acceptance ceremony. |
| `task-detail/` | Hero, diagnostics, recommendations, execution profile with run controls and scheduling, decision packet, live run strip, agent logs, timeline (Lexical composer with @mention autocomplete), attachments panel and lightbox, side panels (GitHub trace, current state, permissions), accept/release/archive confirms, continuity recovery panel, plus the per-person run principal every run control answers from (`run-principal-view.ts`, ruling 127). |
| `runtime/` | Run panels (live strip, log console, raw view), the dedicated run-log SSE consumer, log noise filter and clock helpers. |
| `review/` | The review queue split by acceptance authority. |
| `agents/` | Profiles master-detail, create/edit modal, capability matrix modal, roster assembly, profile CRUD actions. |
| `policy/` | Human access roles, workflow boundaries, agent capability rows, permission table from `rbac.ts`. |
| `github/` | Repository panel, credential card (shared with settings), PR list, branch table, reconcile and grant-scope actions, credential redaction by role. |
| `activity/` | Cross-task stream and project audit column with compaction and paging. |
| `project-settings/` | Identity, stage editor, members, repository and credential, branch cleanup toggle, danger zone. |
| `org-settings/` | Tabs: connections, users and access, sign-in & SSO, agent resources (KBs, MCP servers, skills, global agent templates, store browser), controller, audit. |
| `kb-browser/` | The store folder file manager (upload, folders, GitHub import, SKILL.md editing). |
| `controller/` | The conversation surface and the Goals panel; the controller dock (`controller-dock.tsx`, mounted by `root.tsx`), its route-derived scope (`controller-dock-context.ts`) and its view builder (`controller-dock-query.server.ts`, served by `routes/resources.controller.ts`). |
| `notifications/` | The inbox page and the shared notification row. |
| `profile/` | Identity, notification routing, appearance, access view, GitHub identity, password change, and the **Agent accounts** panel (ruling 127): one card per backend with the hosted sign-in, the paste forms and Disconnect, polling `/resources/backend-login` while a sign-in is live. |
| `insights/` | Read-only run analytics dashboard. |
| `live-updates/` | `useLiveUpdates`: SSE subscription → debounced loader revalidation. |

Also under `features/`: `copy-ban.test.ts` (the "govern*" word is banned from rendered
copy) and `retired-vocabulary.test.tsx` ("primary specialist" and friends).

## 5. `app/ui/` primitives

`avatar`, `identity` (agent glyph: sparkle for Claude, cpu for Codex, shield for the
operator), `icon` (one stroke icon set), `pill` (the one readiness/validation/state
mapping), `rich-text` (inline `**bold**`, `` `code` ``, `@mention`), `markdown`
(react-markdown + GFM with attachment-aware images), `code-view` + `code-language` +
`code-highlight` (the ruling-363 reader: numbered lines, Shiki tokens by filename grammar,
loaded on first use), `mention-spans`, `toast`
(bottom-center, 2600 ms), `confirm-dialog`, `use-dialog` (native `<dialog>` contract:
Escape, backdrop click, focus restore), `use-dismiss`, `page-overlay`, `stage-menu`,
`task-meta` (priority, labels, due date), `label-input`, `calendar` + `date-picker`,
`local-time` + `use-relative-time` (hydration-safe timestamps), `csrf-input`,
`skip-link`, `roving-radio`, `toggle`, `use-fetcher-result` / `use-action-toast`,
`use-shortcut-hint`.

## 6. `app/shared/`

`rbac.ts` (the permission table), `capabilities.ts` (the capability catalog, enforcement
scopes, grant couplings), `acceptance-disclosure.ts` (the accept echo contract),
`mcp-reserved.ts`, `model-ids.ts`, `freshness.ts` (stale after 1 h),
`workflow/` (templates, transitions chain maintenance, stage roles, stage eligibility),
`mapping/` (row → render shapes for users, projects, tasks, events, actors,
notifications; `deriveDisplayReadiness` and the live-backend overlay live in
`task.server.ts`), `dates/format.ts` (the one timestamp formatter), `ids/` (`newId`,
`slugify`), `text/` (`plural`, store text extensions), `auth/` (auth paths, password
policy), `docs/` (two tests pinning `design/prd.md` to the canon PRD and
`file-formats.md` to `PACKET_OPTION_KINDS`).

## 7. `app/schemas/`

`task-file.schema.ts` (frontmatter, packet, engagements, revisions, verdicts,
schedules, recommendations, timeline events, the tolerant parser and the derivations
`deriveValidation` / `acceptanceBlockedReason`), `project-file.schema.ts`,
`goal-file.schema.ts`, `sse-event.schema.ts`, `github-pat.schema.ts`,
`file-diagnostics.ts`.

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
| `rescan` | reconcile projections with the file store (takes the writer lock) |
| `store:check` | read-only store doctor: which canonical files the app cannot trust and why |
| `backup` / `restore` | point-in-time artefact with `VACUUM INTO` + the markdown tree; whole-root or single-file restore |
| `keys` | `status` / `reseal [--dry-run]` for encryption-key rotation |

See [scripts.md](../development/scripts.md) for details and
[deployment.md](../operations/deployment.md) for the container.
