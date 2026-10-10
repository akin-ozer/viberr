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
e2e/                 Playwright specs (11) + the login fixture (auth.setup.ts)
test-support/        vitest setup and harnesses: hermetic env + <dialog> polyfill, test app/db/store,
                     fake runtime, fake GitHub fetch, a local git origin, fake vendor binaries
                     (writeFakeVendorBinaries, the sign-in driver's real child process), backend
                     credentials (connectFakeBackend / disconnectFakeBackend, ruling 137), the demo seed
                     and data, a custom 3-stage board, a raw audit reader, MCP tool-meta and
                     strict-schema checks, the operator prompt's task snapshot, the hermetic
                     toolchain reading, and the performance ratchet (ruling 11): perf-verdict /
                     perf-budgets(/) / perf-ratchet, the counters (perf-counters, render-counter),
                     the revalidation and dock harnesses, the console fixture, a static-import
                     walker and the app.css rule parser
tools/oxlint/        the vendored anti-slop lint plugin (15 rules) and its pinned manifest
tools/viberr-launch/ the setuid agent launcher (C) the image compiles, root:node 4750 (ruling 139)
docs/                this documentation set, the PRD (docs/product/prd.md) included
public/              favicon.svg
.github/workflows/   ci.yml: lint, typecheck, test, build; then the e2e job
compose.yml          production-shaped single container (init: true, hostname viberr, healthcheck on
                     /resources/health); compose.e2e.yml is the isolated e2e stack
Dockerfile           four stages: prod-deps, build, launcher (compiles tools/viberr-launch), runtime
                     (node:26-slim + git + make + curl + pnpm + chromium + uv); no ENTRYPOINT, no backend credential, no runtime home baked in
                     (ruling 137); CMD runs node directly
.claude/launch.json  three launchers: dev on docker-data, dev on the hermetic ./data (port 5174), and the
                     production build on ./data (port 5175) for measuring
.claude/skills/, .agents/skills/
                     agent skills for coding sessions on this repository (test-audit,
                     ponytail, and the animation and design-review skills)
README.md, AGENTS.md, CLAUDE.md, CONTRIBUTING.md
                     entry points for people and coding agents; LICENSE (MIT);
                     THIRD_PARTY_NOTICES.md the vendored code's licences; .env.example the
                     documented environment template
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
  schemas/     shared Zod schemas (task file, project file, epic file, SSE events, PAT validation, diagnostics)
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
`app/routes/` holds 48 modules (46 routes plus `project-visibility.server.ts`, the
members-only 404 guard for actions, and `project-workspace.server.ts`, the one gated read
of a project the workspace layout and the board loader share per request, ruling 11);
the route table is `app/routes.ts`.

## 3. `app/server/` by directory

| Directory | Owns |
|---|---|
| `boot.server.ts` | The one-time startup sequence: crash handlers, env, dirs, data-root lock and guard, shipped assets, self-heal, database, bootstrap admin, publisher, derivation-version rebuild or rescan, base agents, the one-time goal-to-epic conversion (ruling 17), watchers, maintenance, Codex rollout repair, run recovery, the schedule runner and the dependency release tick, reconcile poller, controller recovery, integrity log. |
| `actions/` | `withActionWatchdog`: a 30 s wall-clock ceiling on a mutating action (wraps project creation). |
| `agents/` | `deployment-view.server.ts`: resolves a deployment to its effective runtime identity and the backend a run would use (`primaryRunBackend`, `deployedSpecialistBackends`). |
| `audit/` | `recordAudit` (`audit-recorder`), `audit-query` (freshness reads), `audit-browse` (org-admin in-app view), `audit-export` (CSV/JSON download, 100 000-row cap), `s3-config` + `s3-put` (SigV4 PUT, no SDK). |
| `auth/` | better-auth identity provisioning, login + forced reset, password hashing, rate limit (10 per email+ip per 15 min), CSRF (origin proof + HMAC double-submit), `requireFormAction` + `appErrorResponse`, OAuth providers configured in-app and their credential test, OAuth whitelist provisioning, `require-user` guards, `project-authority` (the single project-authority resolver), `authority-prompt` (the authorization table written out for the controller model, ruling 254), `require-project` (the members-only 404), user admin and store, bootstrap admin. |
| `config/` | `env.server.ts`: the validated environment schema. |
| `controller/` | Conversations store (scopes: instance / board / task), run engine, the per-turn context read (`controller-context.server.ts`, ruling 253), toolkit (`viberr_controller`), ops MCP (`viberr_ops`), tool guards, controller profile, the controller's standing resource requests (`controller-requests.server.ts`, `agents/controller-requests.md`, ruling 271), and the next step a conversation leaves itself for a task's acceptance (`controller-follow-ups.server.ts`, ruling 259; what an acceptance does with it is `tasks/controller-continuation.server.ts`). |
| `db/` | SQLite open + pragmas, the copy-first read-only open (ruling 23), migration runner, baseline-column backfill, data-root writer lock + guard, CLI lock for scripts, retention, self-heal of a corrupt DB, backup/restore, transaction helper. |
| `errors/` | `AppError` and the stable `ERROR_CODES`. |
| `events/` | Projection event emitter, the SSE broker (per-connection scopes, 25 s heartbeat, a 256-event replay ring for data events and one for console lines, re-authorization each tick, the process shutdown hook), the publisher bridging the two. |
| `files/` | The file store: data-root layout, atomic writes, per-file mutex, read-your-own-writes cache, the zip reader and writer a board file travels in (`zip.server.ts`, ruling 32), the readers' content-keyed parse memo (ruling 21), `form-files` (the files a multipart form carries, ruling 258), frontmatter codec, task/project/epic/agent-profile readers and writers, actor-ref codec, the chokidar watcher (250 ms debounce, retrying failed rebuilds) and KB watcher, the KB index injector (ruling 205) and skill injection reader (24 000-char budget), the project rulings KB (ruling 208(a)), attachments, a task's kept sources (`task-sources.server.ts`, ruling 15: the server's own `sources/` folder, its append-only index and the one writer of both), the search of one source's text (`find-in-text.server.ts`, ruling 82: the places that hold a word or phrase, each with its line, an excerpt and the offset a read starts at), the store doctor. |
| `github/` | Client, project GitHub context, branch sync, empty-repo bootstrap (ruling 227), PR open/link/adopt and the adoption record, PR diff reads for the controller (ruling 265) and for the task page's Changes panel, bound to the delivered revision (ruling 246), the GitHub review relay to the deliverer (ruling 246), workspace push and delivery reconciliation, reconciler + 5-minute poller, human-approval verdict, update-branch (merge, never rebase) and its operator decision half, the acceptance-boundary refresh rule (ruling 95), branch cleanup, scope-violation side effects, repo access check and remembered repo health, the agent GitHub read tool. |
| `http/` | `isDocumentNavigation`: a document load (a hard load, a refresh, a new tab) versus single fetch's `.data` request; R19-15's read-marking and ruling 300's console shipping ask it. `cookieValues`: the one reader of a request's cookies (the theme cookie and the setup checklist's close, ruling 322). |
| `insights/` | One aggregate query over `agent_runs` for `/insights`. |
| `interpretation/` | Readiness derivation, diagnostics severity, freshness re-export. |
| `logging/` | Dependency-free JSON logger; request correlation via `AsyncLocalStorage`. |
| `ops/` | Build info, disk space, health snapshot, maintenance scheduler, transcript retention, the host toolchain probe (ruling 40). |
| `mcp-proxy/` | The loopback MCP gateway of ruling 191 (`gateway.server.ts`: the 127.0.0.1 listener, run tokens, per-run sessions, the ruling-188 filter, call logging and write-call audit; `grant-tool.server.ts`: `viberr_connection_grant`, a tool it answers itself, naming an OAuth sign-in's granted scopes, ruling 192; `knowledge-tool.server.ts`: `viberr_knowledge`, the server it answers itself for a Codex specialist that holds a knowledge base, with `read_knowledge_doc` and `correct_knowledge_doc`, ruling 216; `board-tool.server.ts`: `viberr_board`, the one it answers for a Codex specialist that holds a collaboration grant, with `read_board`, `read_timeline_entry` and `read_task_attachment`, rulings 216 and 214, and, ruling 82, `read_task_source` beside them and `keep_source` for a run that may save files on its task) and the one MCP client Viberr speaks to an org server with (`upstream.server.ts`: Streamable HTTP with the SSE fallback, shared with the health probe, which also carries an OAuth sign-in's token and renews it once on a 401; `upstream-stdio.server.ts`: a stdio command the server spawns with `MCP_CREDENTIAL`), and the MCP authorization flow as a client (`oauth-client.server.ts`, ruling 192: discovery, dynamic registration, PKCE, code exchange, refresh, revocation over the SDK's helpers). |
| `org/` | Board files (ruling 32: `board-file` the layout and board.md's keys, `board-export` one project out as a zip, `board-import` the preview's plan and the import that writes it), org resources (KBs, MCP servers incl. stdio probes and background warm-ups and the unchecked registration an import makes, skills), an HTTP MCP connection's OAuth sign-in (`mcp-oauth.server.ts`, ruling 192: the sealed and public halves, the sign-ins in flight, the callback's completion, the token source the gateway renews through, sign-out), the `resource.updated` broadcast, store file browser, GitHub owner connections, org users, global agent templates and template grant propagation (ruling 177), resource catalog and reference integrity (a knowledge base's rename follows into each project's `rulingsKb`, ruling 199; a delete leaves it), the decision that a board connects no repository (`repository-ruling`, ruling 199: one document in the project's rulings knowledge base, which a board file never carries, `boardKbFiles`), a task's file copied into a knowledge base (`kb-task-file`, ruling 267), the passage edit a knowledge-base document and a skill share (`kb-corrections`, rulings 212(b) and 267), org seed, the org-settings loader payload. |
| `prefs/` | `user_prefs` key-value store. |
| `projections/` | Rebuilder (files → SQLite), full rebuild, instance and project rescan, the derivation version stamp, per-file projection faults for health (ruling 22), single-flight cooldowns, board/task/review/activity/agent-deployment/decision/notification/policy-violation/epic read models, one task's open decision as the task page and the Review queue's dialog both read it (`task-decision.server.ts`, ruling 304) (the epic's progress counted from its task rows, ruling 272), the dependency read model (ruling 55), task-key links, task activity ("gone quiet"), and `repo-footprint`: how many tasks carry records against the project's repository, imported by the settings door and by the operator's repository question, which must not load that door to ask it. |
| `provenance/` | Read and write layers over the `provenance` table. |
| `runtimes/` | Adapter interface, Claude and Codex adapters, the Claude process-group spawn and the settled-run process sweep (`claude-spawn`, `run-processes`, ruling 142), the OS user every agent process runs as (`agent-isolation.server.ts`, ruling 139: the uid map, the launcher's verbs, `agentIsolation` for health, the boot store layout and `shareDirWithAgents`), a command Viberr itself runs for a task as the task owner's agent user (`person-command.server.ts`: `taskOwnerLaunch`, `runPersonCommand` with its group kill at the timeout, and `BoundedLog`; the project's gates and the page capture both run through it, rulings 139 and 194), the Codex app-server compaction client (ruling 174), runtime registry (spawn env filtering + adapter construction only), and the ruling-137 per-person auth modules: `user-homes.server.ts` (the one resolver for `runtimes/users/<userId>/{claude-home,codex-home}` and, ruling 138, each account's own home inside them), `backend-credentials.server.ts` (the `user_backend_credentials` store of a person's several accounts per backend: provider verification, the active account, switch, rename, per-account disconnect and vendor logout, per-person and per-account health, `runCredentialFor`), `run-principal.server.ts` (owner/asker resolution and the single refusal sentence) and `backend-login.server.ts` (the hosted sign-in driver over the unmodified vendor binaries). Then run service (start/resume/interrupt/log, concurrency cap and queue), run store (raw NDJSON + rows), run sink (persist then publish), run events, run projection, run inputs disclosure (ruling 167), context-compaction events (ruling 172), provider-refusal classification (ruling 92), context policy and prompt-prefix ordering (ruling 169), Bash argument policy (ruling 219(a)), wire-format normalizer, model catalog and availability, backend quota telemetry, strict MCP tool definitions and the tool manifest (ruling 255), skill mount (workspace `.claude` owner), session export, run recovery, operator run engine (ruling 13(a): the run, its single-flight lease and queued triggers in `operator-run`, what the operator is told in `operator-prompt`, the Codex plan's tools, schema and execution in `operator-codex-plan`), and the writing guide the operator's, the controller's and every specialist's prompt closes on (`humanizer.server.ts` over the vendored, hash-pinned `humanizer/` skill, ruling 187). |
| `secrets/` | Secret box (AES-256-GCM `v1$iv$ct$tag`), PAT store and validator, key rotation reseal, git-output redaction and the test for a credential by those same patterns (`readsAsCredential`, ruling 82). |
| `seed/` | Product seed (clean sheet), the built-in agent catalog (the base roster, and the library's Writer, Editor, Diagrammer and Cover Designer, ruling 179), shipped assets (`assets/`: skills, definitions, profiles) and the boot backfill, base-agent deployment, seed credentials. |
| `settings/` | `instance_settings` JSON key-value (concurrency cap, per-run spend cap, quota observations, the projection derivation version). |
| `tasks/` | The governed task mutations, one module per action family (ruling 13(a)): `task-action-core` (the action context, guards, stage and actor helpers, operator caps, `autoInvokeOperator`), then `task-edits`, `task-ownership`, `task-archive`, `task-escalations` and `task-replies` (with its leaf `verdict-reason`: the cut of a verdict's stored reason and the room a reader leaves for it, rulings 88 and 201), then `task-acceptance` and `task-delivery`, then `task-transitions`, `task-recommendations`, `agent-completion`, `task-comments` and `packet-resolution`, each importing only from the ones before it (agent completion's two calls upward load their module when they run); the mutation substrate and cycle break (`task-mutation`), task closure (ruling 52), operator actions (ruling 13(a): `operator-authority`, then `operator-packets`, then `operator-snapshot`, `operator-dispatch` and `operator-moves`, with the direct task actions in `operator-actions`) and toolkit, agent toolkit and outcome envelope, the board read agents and operators share (rulings 213(a)/117), agent reply routing, mention notify/suggestions and display names, comment guardrails, timeline compaction, no-change completion, specialist run (ruling 13(a): `specialist-roster`, then `specialist-workspace` and `specialist-prompt`, then `specialist-assignment`, with dispatch in `specialist-run`), specialist MCP and browser MCP mounts, the page capture (`page-capture`, ruling 86: the serial queue, the delivery job that pictures a stamped files delivery from its kept copy, carried to the renderer through the task's `.capture-input/` and rendered in a scratch of the task's `.captures/`, both beside `deliveries/` where only the server writes, and writes the pictures, the `pageCaptures` record, the note and the audit row; `captureTaskPage`, the `capture_page` tool's door; `measureTaskPage`, `measure_page`'s, and the measuring of a delivered HTML page with its comparison to the board's accepted pages (ruling 328); `pictureWebPage`, the one door that opens a page on the web; and `removeRunPageCaptures`, which the completion pipeline calls when a run ends), `page-look` (ruling 327: `keepPageLook`, the `keep_page_look` tool's door, which keeps a page on the web as the sources of one look, or takes over the look another task keeps), `page-measured` (ruling 328: the figures a pictured page's record keeps, read back by the server alone, and the one line that says them), `page-looks` (ruling 329: what each reader showed a run, written on its row, what an approval of a files delivery owes a look at, and the sentences that say so before the run and when it did not look) and its renderer (`page-capture-child`: a script Node runs as the task owner's agent user, which serves one page from loopback, drives a headless Chromium over its debugging pipe with no network, and writes the pictures; it also puts a page in a state before a picture, opens a page on the web for a look (the one job with the network), and measures a page (rulings 194, 327 and 328); nothing in the app imports it), tool policy (capability → tool denylist), repo mirror and workspace refresh (ruling 195), clone auth/progress, schedules and the stranded-task sweep (ruling 122), epic actions and the goal-to-epic conversion (ruling 272), dependencies and release (ruling 55), file leases (ruling 60), required reviewers (ruling 89), review deadlock (ruling 94), packet fan-out (ruling 65), the repository question's answers and what a connected repository settles (ruling 224: `repository-ask`, after `packet-resolution`), run-failure remedies (ruling 156), similar tasks (ruling 67), keeping a source and the one timeline entry a run's kept sources leave (`task-sources`, ruling 82), workspace retention, operator repo read, model prose repair, and `what-it-took` (ruling 83: what a task took, derived when read from its run rows and its own record for the completion card, the operator's snapshot and the controller's task reads; it stores nothing). |
| `theme/` | The `viberr_theme` cookie. |

## 4. `app/features/` by surface

| Directory | Surface |
|---|---|
| `shell/` | Workspace rail (`nav.ts` order: Board, Epics, Review queue, Controller, Agents, Policy, GitHub, Activity, Settings), topbar, the standalone-page header (`page-topbar.tsx`, ruling 294 — mounted by the `palette-shell` layout for the routes `standalonePageLabel` names), the shared palette trigger both headers render, ⌘K palette and its server query, bell popover (pages ship its counts; it loads its list from `routes/resources.notifications.ts`, ruling 300), user menu, theme preference, route pending bar, CSRF result helper. |
| `home/` | `/`: the setup checklist (`setup-checklist.tsx`, its steps read by `getHomeSetup`; closed for the session through `setup-hidden.server.ts`, ruling 322), project cards, pinned/all/archived groups, new-project modal (name, key, connection, repo, workflow, agent policy preset; the first four in `project-fields.tsx`, shared with the board import dialog), project creation server logic (its identity check, repository reach and write are the steps a board import composes too), org tiles, admin store strip (re-scan, rebuild). |
| `board/` | Board columns, the board card projection the board loader ships (`board-card.ts`, `toBoardCard`: the fields the board reads, ruling 11), the card's one status seat and problem chips (`card-status.ts`, ruling 306), filters (URL params), dnd-kit drag with server-authoritative drop resolution (`board-dnd.ts`), list view, new-task modal, board-drop acceptance confirm, orphan and repo-access banners. |
| `task-detail/` | Hero, diagnostics, recommendations, execution profile with the agent picker, run controls and scheduling, decision packet, live run strip, agent logs, timeline (Lexical composer with @mention autocomplete, loaded lazily behind a same-size stand-in that keeps what was typed, ruling 300; sliced newest-first), attachments panel and lightbox, the Sources panel (`sources-panel.tsx`, ruling 317), side panels (GitHub trace, current state, permissions), accept/release/archive/move-back confirms (move-back asks why, ruling 47), delivery and completion toasts, continuity recovery panel, plus the per-person run principal every run control answers from (`run-principal-view.ts`, ruling 137). The page itself is composition only (ruling 13(b)): its posts, each with its fetcher, toast and confirm, are hooks in `task-detail-actions.tsx`, what it reads off its props is pure functions in `task-detail-derive.ts`, and the decision region, the acceptance ceremony (`task-detail-regions.tsx`) and the main column (`task-main-column.tsx`) are hook-free components that each take one slot of its markup. |
| `runtime/` | Run panels (live strip, log console, raw view), the run-log console's store and hook (`run-log-store.ts`, `use-run-log-stream.ts`: lines outside React state, frames from the layout's live stream, ruling 11), the incremental console fold (`console-fold.ts`), the readable live step, log noise filter and clock helpers. |
| `epics/` | The Epics list (Open, Closed, All) and one epic's page: its description, progress bar, tasks with Add tasks, New task and Remove, history and details, the create and edit dialog, and their read models over the workspace read (`epics-query.server.ts`); ruling 325. |
| `review/` | The review queue: the decisions waiting on the viewer, on their own tasks, in two panels (`review-page.tsx`), and the dialog that answers one (`review-decision-dialog.tsx`, read by the `task-decision.ts` route): its body is the task page's own decision, recommendation cards and comment composer, `TaskDecisionDialogBody` in `task-detail/task-detail-page.tsx`, posting to the task page's action (ruling 304). |
| `agents/` | Profiles master-detail, create/edit modal, capability matrix modal, roster assembly, profile CRUD actions. |
| `policy/` | Human access roles, agent capability rows, workflow rules, guardrails, required reviewers, permission table from `rbac.ts`. |
| `github/` | Repository panel, credential card (shared with settings), PR list, branch table, reconcile and grant-scope actions, credential redaction by role. |
| `activity/` | Cross-task stream and project audit column with compaction and paging. |
| `project-settings/` | Identity, workflow stages (with colour presets, ruling 279), required reviewers, file leases, members, repository and credentials (change, scope re-check, branch cleanup toggle), danger zone. |
| `org-settings/` | Tabs: GitHub connections, users and access, sign-in & SSO, agent resources (KBs, MCP servers, skills, global agent templates, store browser), import & export (a board's file out, a board file in through the import dialog, ruling 32), controller (profile, locks, standing requests); below the tabs: run concurrency and run spend cap, the audit export card, the storage line. |
| `kb-browser/` | The store folder file manager (upload, folders, GitHub import, SKILL.md editing). |
| `controller/` | The conversation surface; the working-turn step row (ruling 257) and scoped example prompts (ruling 319); where a transcript puts its reader and the jump back to its newest message, shared by the page and the dock (`transcript-follow.ts`, `transcript-jump.tsx`, ruling 320), as is the message list both draw (`message-list.tsx`, ruling 12); the controller dock (`controller-dock.tsx`, mounted by `root.tsx`; its open panel's body `controller-dock-panel.tsx`, loaded on demand, ruling 11, with its hook-free regions in `controller-dock-panel-regions.tsx`, ruling 13(b); the not-connected note both composers share, `not-connected.tsx`, in the server's own words from `shared/controller-not-connected.ts`; the files sent with a message, `message-files.tsx`, served by `routes/resources.controller-file.ts`, ruling 258), its route-derived scope (`controller-dock-context.ts`) and its view builder (`controller-dock-query.server.ts`, served by `routes/resources.controller.ts`). |
| `notifications/` | The inbox page and the shared notification row. |
| `profile/` | Identity, notification routing, appearance, access view, GitHub identity, password change, and the **Agent accounts** panel (ruling 137): one card per backend with the hosted sign-in, the paste forms and Disconnect, polling `/resources/backend-login` while a sign-in is live; ruling 138: several accounts per backend, Rename and Disconnect each; ruling 323: the account in use as a picker (`AccountPicker`) whose menu switches to another (no sign-in), adds another account and opens the others' management. |
| `insights/` | Read-only run analytics dashboard (oversight cards, backend quota, prompt cache, breakdowns, daily chart). |
| `live-updates/` | `useLiveUpdates`: SSE subscription → debounced loader revalidation, replaying what a reconnect missed; `revalidation-policy.ts`: which loader re-runs on which trigger (every route's `shouldRevalidate`, and the tab's ledger of what its loaders owe, ruling 11); `event-types.ts` mirrors the wire contract. |

Also under `features/`, five copy and behaviour pins: `copy-ban.test.ts` (the "govern*"
word is banned from rendered copy), `retired-vocabulary.test.tsx` ("primary specialist"
and friends), `rebase-advice.test.ts` (Viberr never tells anyone to rebase, ruling 230),
`shortcut-glyph.test.ts` (no literal ⌘, ruling 319) and `toast-honesty.test.ts` (a
failure toast never renders the success tick).

## 5. `app/ui/` primitives

`avatar` + `initials`, `identity` (agent glyph: sparkle for Claude, cpu for Codex, shield
for the operator), `icon` (one stroke icon set), `pill` (the one
readiness/validation/state mapping), `rich-text` (inline `**bold**`, `` `code` ``,
`@mention`), `markdown` (react-markdown + GFM with attachment-aware images), `markdown-doc`
(a markdown file read as a document, and its Preview / Raw switch, ruling 317), `collapsible`
(a box taller than 340px clamps behind Show more: a long comment, a task's long attachment
list, ruling 314; its `FoldToggle` counts what it hides beyond the box and keeps its place
on Show less, and `useFirstRow` counts the tiles on a wrapping strip's first line, so a
timeline entry's pictures fold with its text, ruling 314), `code-view` +
`code-language` + `code-highlight` (the ruling-317 reader: numbered lines, Shiki tokens by
filename grammar, loaded on first use) + `log-grammar` (upstream's log grammar with whole
numbers and levels by severity, in the grammar's own chunk, ruling 317), `mention-spans`, `toast` (bottom-center; success 5 s, paused on hover or focus; errors stay until dismissed, ruling 299),
`confirm-dialog`, `use-dialog` (native `<dialog>` contract: Escape, backdrop click, focus
restore; `commit` runs a primary action and then the same exit, ruling 287), `copy-glyph`
(`GlyphSwap`: a glyph that trades with its control's state cross-fades in place; `CopyGlyph` is
its copy case, ruling 284(b)), `use-fresh-line` (a line animates only once it replaces the one first
painted, ruling 284(a)), `live-pose` (a dialog closed mid-entrance leaves from where it is, ruling
287), `spring` (the board drop's spring and pointer velocity, momentum projection
and rubber-banding, ruling 285), `use-sheet-drag` (the dock's pull-to-dismiss sheet, ruling
285), `use-dismiss`, `page-overlay`, `stage-menu`, `task-meta` (priority, labels, due
date), `label-input` (its rows and label fold in `label-input-derive`), `calendar` + `date-picker`, `local-time` + `use-relative-time`
(hydration-safe timestamps), `use-clock` (one shared interval per cadence for every
ticking reader, ruling 11), `use-stable-rows` (structural sharing of loader rows and
values across revalidations, ruling 11), `number-ticker` (counts up to a figure,
ruling 284(e); it commits only when the drawn digits change),
`attach-files` (a composer's tray of picked, dropped or pasted files, its paperclip and its drop target, ruling 319) + `picked-files` (the rules a composer keeps files by, which the New task dialog shares, and `IMAGE_RE`, the one test for a picture's file name, ruling 12), `csrf-input`, `skip-link`, `radio-seg` (single-select group on Radix `ToggleGroup`,
ruling 14), `pagination` (Previous, the page numbers with a gap for each skipped run, Next:
shadcn's Pagination drawn with the sheet's classes, ruling 326), `toggle`, `use-fetcher-result` / `use-action-toast`, `use-shortcut-hint`.

## 6. `app/shared/`

`rbac.ts` (the permission table, and `asProjectRole`, the one decoder of a role string, ruling 12), `capabilities.ts` (the capability catalog, enforcement
scopes, grant couplings), `acceptance-disclosure.ts` (the accept echo contract),
`mcp-reserved.ts`, `mcp-tools.ts` (admin-marked MCP write tools, ruling 188),
`model-ids.ts`, `freshness.ts` (stale after 1 h), `controller-locks.ts` (ruling 270),
`dependencies.ts` (the `blockedBy` vocabulary, ruling 55), `task-refs.ts` (the
`blockedBy` and epic id spellings the task schema validates, and the epic statuses:
import-free, because that schema reaches every page, ruling 11), `file-leases.ts` (ruling
60), `credential-scopes.ts` (violation vs advisory GitHub scopes, ruling 221(b)),
`github-handle.ts` (ruling 29), `names.ts`, `attachment-kinds.ts`, `page-capture.ts` (ruling 86: the two widths a delivered page is pictured at, which names are pages, the name a picture is kept under, and which files of a folder are Viberr's own pictures, `pageCapturesAmong`), `controller-not-connected.ts` (ruling 12), `page-title.ts`
(one title grammar), `errors.ts` (`toError` / `errorMessage`, the one normalization of a
caught value), `packet-goal-draft.ts` (ruling 63), `packet-server-outcome.ts`
(ruling 233), `provider-marker.ts`, `revision-drift.ts` (ruling 239), `run-failure.ts`
(the failed-run vocabulary, ruling 155(a)), `task-key-links.ts`, `timeline-leads.ts`
(ruling 83: the opening words of the timeline entries a count is read from, a decision,
an agent's question, a stage move and the declined-recommendation title, imported by
their writers and by the reader),
`workflow/` (templates, transitions chain maintenance, stage roles, stage eligibility,
stage colour presets (ruling 279), packet option kinds (ruling 131), the re-verdict stage
(ruling 90), the stages a task nobody delivers may go back to (ruling 112), guardrail
labels),
`mapping/` (`*.server.ts` row → render shapes for users, projects, tasks, task events,
actors, notifications; `deriveDisplayReadiness` and the live-backend overlay live in
`task.server.ts`), `dates/` (`format.ts`, the one timestamp formatter; `time-zone.ts`,
the viewer's zone for the controller's prose), `ids/` (`newId` in `new-id.server.ts`,
`slugify`), `text/` (`plural`, store text extensions, `BACKEND_LABEL` (ruling 298),
`escapeRegExp`, `endSentence`, `wholeThousands`, `prettySize` (a byte count as people read it, ruling 319), `figures` (`formatCost` and `formatDuration`, a dollar total and a span of time as Insights and the completion card print them, ruling 316)), `auth/` (auth paths, password
policy), `docs/` (six tests: `file-formats.md` against `PACKET_OPTION_KINDS`, every
"ruling N" citation resolving to `decisions.md`, the runbook's database-read rules, the vendored anti-slop
tree against its manifest, every performance budget measured by some test, and
`vite.config.ts`'s font and chunk rules).

## 7. `app/schemas/`

`task-file.schema.ts` (frontmatter, packet, engagements, revisions, verdicts,
schedules, recommendations, timeline events, the tolerant frontmatter parser
`parseTaskFrontmatter` and the derivations `deriveValidation` /
`acceptanceBlockedReason`), `project-file.schema.ts`, `epic-file.schema.ts`,
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
| `seed` | product baseline: agent templates, KBs, skills, bootstrap admin; `-- --reset` deletes the board, its run history and agent profiles, then the org resources (knowledge bases, skills, MCP servers with their credentials, the domain allowlist), and reseeds; users, auth, GitHub connections and PATs and backend credentials survive (takes the writer lock) |
| `seed:demo` | the test/dev mock board (arda & co) the route and e2e suites use |
| `rescan` | reconcile projections with the file store; `-- --force` reprojects every file (takes the writer lock) |
| `store:check` | read-only store doctor: which canonical files the app cannot trust and why |
| `backup` / `restore` | point-in-time artefact with `VACUUM INTO` + the markdown tree; whole-root or single-file restore |
| `keys` | `status` / `reseal [--dry-run]` for encryption-key rotation |
| `deploy` | stamp the build from git, build, `compose up`, then read back which build is serving (ruling 41); `-- --no-up` stops after the build |

Outside `npm run`: `node scripts/anti-slop-manifest.mjs` re-pins
`tools/oxlint/anti-slop.manifest.json` after the vendored plugin is refreshed, and
`node scripts/measure-routes.mjs` reports the client asset closure per route.

See [scripts.md](../development/scripts.md) for details and
[deployment.md](../operations/deployment.md) for the container.
