# Viberr — Current-State Architecture Reference

**Purpose.** A durable "how the app actually works" map for implementer subagents with no
other context. Every claim below is backed by a real file the compiling pass actually
opened, cited as `path:line`. Where a plausible-sounding module turned out not to exist,
that is noted explicitly — do not re-invent it from a comment or a guess.

**Sources used to compile this.** `planning/planning-artifacts/prd.md` (intent/FRs/NFRs),
`docs/architecture/decisions.md` (binding rulings — cited as "ruling N" below, matching
the numbering in that file), `docs/architecture/file-formats.md` (canonical file-format
doc — treat as authoritative for `task.md`/`project.md` shape), plus direct reads of the
code.

**How to read this doc.** Eleven numbered sections, one per architectural area. Each
subsection names the authoritative file(s), what it does in 1–2 lines, and a load-bearing
invariant where one exists. When a file is very large (several are 2,000–8,000 lines),
line numbers point at specific exports/functions rather than claiming full coverage —
treat the file as the right place to look, not as fully summarized here.

---

## 1. Stack & entry points

### Core stack versions
- **File**: `package.json:1-64`
- **What it does**: React Router `^8.3.0` in **framework mode** (explicit route config, not
  filesystem routing, not the data-router `createBrowserRouter` API); Vite `^8.2.0`;
  TypeScript `^7.0.2`; `better-auth` `1.6.25`; Node `>=26` (`.nvmrc` pins `26`); SQLite via
  Node's built-in `node:sqlite` (`DatabaseSync`) — no `better-sqlite3`/`sqlite3` package
  dependency. Agent backends: `@anthropic-ai/claude-agent-sdk` `^0.3.220`,
  `@openai/codex-sdk` `^0.146.0`.
- **Scripts** (`package.json:9-24`): `dev` → `react-router dev`; `build` → `react-router
  build`; `start` → `react-router-serve ./build/server/index.js`; `typecheck` → `react-router
  typegen && tsc`; `lint` → `oxlint`; `test` → `vitest run`; `e2e` → `tsx scripts/e2e.ts`;
  `seed` / `seed:demo` / `rescan` / `store:check` / `backup` / `restore` / `keys`.
- **Invariant**: no custom `server.ts`/`server.js` exists at repo root — all app-specific
  bootstrap work lives in `bootServer()` (§1 "Server bootstrapping" below), invoked from
  `app/entry.server.tsx` module scope.

### Route organization
- **File**: `app/routes.ts:1-69` — the single `RouteConfig` array (framework mode, built
  with `index`/`route`/`layout` from `@react-router/dev/routes`). Routes live flat under
  `app/routes/` with dot-segmented filenames (e.g. `project.task.tsx`) but are wired
  through this one file, not filesystem routing.
- **Shape**: `/login /logout /api/auth/*` at top level; a pathless `palette-shell.tsx`
  layout wrapping `/org/settings /profile /notifications`; standalone resource routes
  (`/notifications/read`, `/prefs/theme`, `/resources/events|health|run-log|search|
  model-catalog|session-export`); `/projects/:slug/tasks/:key/attachments/:file` (member-only
  raw bytes, outside the workspace layout); the workspace shell `projects/:slug`
  (`routes/project.tsx`) nesting 8 children: index, board, review, agents, policy, github,
  activity, settings, `tasks/:key`.
- **Loader/action convention**: co-located in one route file — e.g.
  `app/routes/project.task.tsx:111` (`loader`) and `:402` (`action`) in the same module.
  Confirmed as the standard pattern across the tree.

### `app/features/` vs `app/routes/` vs `app/server/`
- **Pattern**: routes import server-only logic from `~/server/*` for their loader/action,
  and import the **presentation layer** from `~/features/<surface>/` for the rendered page
  (e.g. `project.task.tsx` imports `TaskDetailPage` etc. from `app/features/task-detail/`).
  `app/features/` holds components/hooks/tests — normally no `.server.ts` files.
- **Exception** (worth knowing): `app/features/agents/agents-query.server.ts` does exist —
  it hosts `effectiveProfileView` (§6) because the agents-page display logic needed a
  server-only computation colocated with its feature. The `.server.ts` suffix is the real
  boundary (never import a `.server.ts` module into client code), not the directory alone.
- **Layout convention** (`docs/architecture/decisions.md:24-48`): `app/ui/` = reusable
  primitives, must not import from `features/`; `app/lib/` = the better-auth instance + its
  Viberr bridge; `app/schemas/` = shared Zod schemas; `app/shared/` = narrow cross-surface
  helpers usable by both client and server code.

### Root / client / server entry points
- **File**: `app/root.tsx:1-225` — exports `links`, `middleware` (per-request correlation
  id), `loader` (theme + auth identity + CSRF token + session-renewal cookie forwarding),
  `headers`, `Layout` (the `<html>` shell + inline pre-paint theme script), default `App`
  (wraps `<Outlet/>` in `ToastProvider`+`RoutePendingBar`), `ErrorBoundary`.
- **File**: `app/entry.server.tsx:1-149` — module-scope `await bootServer()` (line 21) runs
  once per process before any request; this *is* the custom server bootstrap. Exports
  `handleError` (swallows aborted requests + routine 404s, logs everything else with
  correlation) and default `handleRequest` (`renderToPipeableStream`, 5s `streamTimeout`,
  Node stream → Web `ReadableStream`).
- **File**: `app/entry.client.tsx:1-13` — standard RR8 hydration, nothing custom.

### Server bootstrapping — `bootServer()`
- **File**: `app/server/boot.server.ts:1-653` — the single place that wires: data-root
  writer-lock acquisition (before anything else touches the store), SQLite open +
  migrations + self-heal-if-corrupt, admin seeding, event publisher start, file watcher +
  KB watcher start, GitHub reconcile poller start, MCP warm-up reaping, scheduled-action
  runner start, maintenance/retention scheduler start, boot-time projection rescan, run
  recovery (orphaned/stranded/unreacted runs), terminal-task workspace reclaim, base-agent
  roster ensure. Survives dev-server HMR via `Symbol.for("viberr.booted")`
  (`boot.server.ts:55`).
- **Invariant**: one app process per data root, ever (B-FD1) — the writer lock is taken
  *before* the database opens or any file is written; a held lock stops boot with a message
  naming the holder rather than corrupting the store (`boot.server.ts:459-481`, and see
  `docker-data-dual-writer-hazard` in project memory).

### SQLite projection DB
- **Files**: `db/migrations/0001_baseline.sql` (single squashed baseline — the only
  migration file), `app/server/db/migration-runner.server.ts:28` (`runMigrations`),
  `app/server/db/sqlite.server.ts:82-102` (`getDb`, lazily opens
  `${VIBERR_DATA_ROOT}/state/projection.sqlite`, WAL mode, foreign keys on, 5s busy
  timeout).
- **Invariant**: `sqlite.server.ts:75-90` — once `shutdownDatabase()` has run, `getDb()`
  refuses to lazily reopen a handle (mid-drain requests get a clean error, not a silent
  reopen). Migrations are forward-only/squashed; `boot.server.ts:136-223` detects and
  WARN-logs schema drift on an existing deployed root rather than failing silently.

---

## 2. The file-native store + projections

### Canonical `task.md` / `project.md` format
- **File**: `docs/architecture/file-formats.md` (the canonical doc — read this first for
  exact frontmatter shape), backed by `app/schemas/task-file.schema.ts` (~1,442 lines) and
  `app/server/files/task-file.server.ts` (parse/serialize), `app/server/files/
  task-writer.server.ts` (locked read-modify-write).
- **What it does**: Files under `${VIBERR_DATA_ROOT}` are the **only canonical business
  truth**; SQLite holds derived projections only. `task.md` = YAML frontmatter (key, title,
  stage, readiness, waiting, ownerUserId, `engagements[]`, operator, recommendations,
  schedules, `validation` *(derived cache)*, workRevision, verdicts, branch, pr, github,
  archived, noChanges, boardRank, timestamps) + three markdown sections: `## Goal`,
  `## Packet` (only while a decision packet is open), `## Timeline` (newest-first, 11 typed
  event kinds).
- **Invariant**: unknown frontmatter fields and unknown `## Sections` are always
  round-trip-preserved (`file-formats.md:36-46`); tolerant parsing never throws and never
  drops an entity, only floors readiness. `validation` is a derived cache recomputed on
  every write from `workRevision`+`verdicts`+required-reviewer set — never hand-editable
  (`file-formats.md:266-269`).

### On-disk layout
- **File**: `app/server/files/file-store-root.server.ts:1-176` (`DATA_ROOT_SUBDIRS`,
  `ensureDataRootDirs`, `resolveStoreSegment`)
- **Layout**: `projects/<slug>/project.md`, `projects/<slug>/tasks/<KEY>/task.md` (+
  `attachments/`, `workspace/` — the latter is the agent's git clone, explicitly **not**
  canonical/watched/projected, reclaimed at boot once the task reaches its terminal stage),
  `agents/profiles/<id>.md`, `kb/<dir>/`, `skills/<slug>/`, `state/projection.sqlite`. No
  `cache/`, `auth/`, or `logs/` directory (removed on purpose, P11-56).
- **Invariant**: `resolveStoreSegment` (`file-store-root.server.ts:118-145`) rejects any
  dynamic segment (KB dir, skill name, profile id) containing `/`, `\`, `..`, NUL, or an
  absolute path — defense against a crafted grant escaping the store root.

### Atomic writer + file mutex
- **File**: `app/server/files/atomic-file.server.ts:31-80` (`writeFileAtomic`) — writes to
  a sibling `<file>.<rand>.tmp` then renames over the target (the watcher ignores
  dotfiles/`*.tmp`); translates `ENOSPC`/`ESTALE`/`EIO` into typed errors rather than
  hanging.
- **File**: `app/server/files/file-mutex.server.ts:1-7` (`withFileLock`) — Web Locks API
  wrapper keyed per absolute file path; every task/project read-modify-write cycle runs
  inside it.
- **Invariant**: `task-writer.server.ts` refuses to write a task file whose frontmatter the
  parser could only reconstruct via tolerant-read fallback defaults (`taskFileWriteBlockers`
  / `assertTaskFileTrusted`) — safe to *read* with defaults, catastrophic to *write back*
  (would silently erase owner/stage/engagements/goal/timeline).

### Projection rebuild pipeline
- **Files**: `app/server/projections/rebuild.server.ts:1-60` (`rebuildProjections` — the
  full recovery hammer: transactionally drops every file-derived row then reprojects the
  whole tree from disk, `force: true`) vs `app/server/projections/rebuilder.server.ts:1-892`
  (the actual per-file engine: `rebuildProjectFile`/`rebuildTaskFile`, content-hash
  short-circuited unless forced; `rebuildPath` routes an absolute path to the right
  per-file rebuilder; `rebuildProject`/`rebuildAll` for scoped/full walks).
- **What triggers a rebuild**: boot (`rescanProjections`), the chokidar watcher
  (`rebuildPath` per changed file), every governed mutation (file write → `reprojectTask` →
  `rebuildPath`, always in that order — see below), manual UI/CLI rescan
  (`app/server/projections/rescan.server.ts`, single-flight gated).
- **Invariant**: the drop+rebuild transaction buffers projection events and only emits them
  after commit, so an SSE subscriber never observes a half-built projection
  (`rebuild.server.ts:29-33`).

### Chokidar file watcher
- **Files**: `app/server/files/file-watch.service.server.ts:1-353` (projects tree),
  `app/server/files/kb-watch.service.server.ts:1-80+` (KB tree).
- **What it does**: watches `${dataRoot}/projects` (`ignoreInitial: true` — the boot rescan
  already reconciled offline drift), a **250ms trailing debounce per path**
  (`WATCH_DEBOUNCE_MS`) then a direct `rebuildPath` call (no queue). Self-heals transient FS
  errors (`EMFILE`/`ENFILE`/`ENOSPC`/`EPERM`/`EACCES`) with a generation-guarded 2s re-arm.
  The KB watcher mirrors the pattern but calls `reindexKnowledgeBaseByDir` instead.
- **Invariant**: route actions always project **synchronously** and never depend on the
  watcher for correctness — the watcher exists only to reconcile out-of-band edits.

### Event system / SSE
- **Files**: `app/server/events/projection-events.server.ts:76-82` (`emitProjectionEvent`,
  an in-process `EventEmitter`, 9 event kinds), `app/server/events/
  event-publisher.server.ts:1-230` (`startEventPublisher`, translates to the SSE wire
  shape), `app/server/events/sse-broker.server.ts:1-120+` (fan-out, scope filtering, a
  256-event ring buffer keyed by monotonic id for `Last-Event-ID` reconnect replay),
  `app/routes/resources.events.ts:1-190` (the `GET /resources/events` loader — auth +
  scope validation + `text/event-stream` response with backpressure protection). Client:
  `app/features/live-updates/use-live-updates.ts:159` (`new EventSource(url)`).
- **SSE wire contract** (`docs/architecture/decisions.md:70-74`): event names are lowercase
  dot-separated facts (`task.updated`, `projection.rebuilt`, `run.log-appended`,
  `auth.session-expired`); payload `{ type, entityId, occurredAt, data }` — compact facts,
  never fat objects.
- **Invariant**: high-frequency streams (run-log lines) publish straight to
  `publishSseEvent`, never through the projection emitter (that path implies a full
  projection rebuild per event) — `sse-broker.server.ts:38-41`.

### Single-flight guard
- **File**: `app/server/projections/single-flight.server.ts:1-79` (`runSingleFlight`) — a
  per-key **cooldown**, not a mutex (the server is single-threaded/synchronous, so two
  rebuilds can never literally overlap); refuses to re-run the same expensive sweep faster
  than `minIntervalMs` (rescan: 10s, rebuild: 30s).
- **Invariant**: must **not** wrap correctness-critical rebuilds (e.g. the reproject after
  `deleteProject`) — its contract is that a *skipped* run is acceptable, which is false
  there.

### Write sequencing — SQLite is a pure read-model
- **Confirmed pattern**: every governed mutation calls `createTaskFile`/`updateTaskFile`
  (atomic write under the per-path lock) and *only after that resolves* calls
  `reprojectTask(db, ctx, projectSlug, taskKey)` (`app/server/tasks/
  task-mutation.server.ts:116-126`). Concretely in `createTask`
  (`app/server/tasks/task-actions.server.ts:479-488`): `await createTaskFile(...)` →
  `rebuildPath(...)` (project counter bump) → `reprojectTask(...)`. SQLite is never written
  independently of a file write for task/project data.
- **Invariant**: "Files are the only canonical business truth... never write projections
  without file backing for task/project state" (`docs/architecture/decisions.md:81-83`).

---

## 3. Task lifecycle & workflow

### Stages, transitions, boundaries
- **File**: `app/shared/workflow/transitions.ts:1-315` — chain-maintenance helpers
  (`spliceStageIntoChain`, `rejoinChainAroundStage`, `realignChainToStages`,
  `stageFlowPath`) that keep `workflow` a single linear chain over `stages` as an admin
  adds/removes/reorders stages (ruling P13-D-1). `Boundary` is the 3-value enum `auto |
  approval | human`.
- **File**: `app/shared/workflow/stage-roles.ts:1-113` (`resolveStageRoles`,
  `humanGatesPreWorkAdvance`) — derives structural roles (entry/terminal/review/work)
  purely from stage order + workflow edges; nothing hard-codes a literal id like `"done"`.
- **File**: `app/shared/workflow/stage-eligibility.ts:1-148` — resolves which stages an
  agent profile's declared `stages[]` apply to (literal id → structural role →
  unrestricted fallback, ruling R14-1) so a renamed board never silently strands a
  profile.
- **File**: `app/shared/workflow/templates.ts:34-94` — `GOVERNED_TEMPLATE` (the sole
  project-creation preset, "Standard · 5 stages": triage→ready→impl→review→done) +
  `DEFAULT_GUARDRAILS`.
- **Where stored**: `stages`/`workflow` are fields of `projectFrontmatterSchema`
  (`app/schemas/project-file.schema.ts:26-29, 40-60, 189-227`) — i.e. they live in
  `project.md` frontmatter, not a separate config file.
- **Where executed server-side**: `app/server/tasks/task-actions.server.ts:3753-4109`
  (`transitionStage`) — the single server-side transition executor. RBAC per boundary:
  `auto` → any member, `approval` → `approve-transition` role (or owner-applied-
  recommendation authority), `human` → `accept-completion` role or the task-owner
  exception.
- **Invariant**: a rule landing on the terminal stage is force-set `boundary: "human",
  locked: true` (`transitions.ts:82-101`) — chain-maintenance can never loosen it.
  `transitionStage` re-checks the source stage **inside** the file lock so a racing
  double-submit produces exactly one event/audit row (NFR16); every non-terminal
  transition fire-and-forget re-invokes the operator, depth-capped at
  `OPERATOR_TRANSITION_CHAIN_CAP`.

### The `engagements[]` model
- **File**: `app/schemas/task-file.schema.ts:118-155` (`engagementSchema`) — one uniform
  per-agent record: `profileId`, `backend`, `role`, `delivers: boolean`, `verdictCapable:
  boolean`. `deliveringEngagement()` finds the one `delivers:true` entry;
  `supportingEngagements()` returns the rest. Replaces the legacy `specialist` +
  `reviewers[]` slots (generic-agents pass, 2026-07-19).
- **Required reviewers**: `requiredReviewers` (`task-file.schema.ts:593-597`) = supporting
  engagements with `verdictCapable: true`, snapshotted at engage time from an explicit
  `report-validation-verdict: direct` grant. Their approval of the current `workRevision`
  gates acceptance.
- **Invariant**: at most ONE engagement carries `delivers: true`, enforced by the parser
  (`task-file.schema.ts:979-1013`, `parseEngagements`) — a second `delivers:true` is
  demoted with a diagnostic; a duplicate `profileId` is deduped to the first.

### Owner (FR37)
- **Schema**: `ownerUserId: z.string().nullable()` on task frontmatter
  (`app/schemas/task-file.schema.ts:513`) — a plain field distinct from `engagements`.
- **RBAC**: `own-task` (admin/maintainer/contributor, `app/shared/rbac.ts:65`) governs
  taking/releasing your own ownership; `release-any-ownership` (admin-only, `rbac.ts:75`)
  governs releasing someone else's. `ownerException()`
  (`app/server/tasks/task-actions.server.ts:296-307`) grants a live owner (contributor+)
  the same decision authority `accept-completion` gives — consumed by
  `requireAcceptCompletion` (the human-boundary transition branch, acceptance, force-accept)
  and by `transitionStage`'s recommendation-authorized branch (ruling R15-3: applying your
  own operator recommendation on your own task is itself the authorization).
- **Invariant**: the widening never widens what the owner can make the machinery *do* —
  only what they can *decide* about their own task; the inner mutation (e.g. `run-agents`)
  still enforces its own capability independently (`task-actions.server.ts:321-332`,
  ruling R14-2).

### Readiness / validation derivation
- **File**: `app/server/interpretation/readiness-policy.server.ts:36-61`
  (`deriveReadiness`, `isAcceptedDisplayState`) — the single readiness-derivation site.
  Stored `readiness` is respected unless diagnostics impose a *worse* floor — derivation
  never improves a stored value, only worsens it. `"accepted"` is a pure display state
  (stage === terminal), never stored.
- **File**: `app/server/interpretation/diagnostics-policy.server.ts:19-52` — maps
  `FileDiagnostic` severity → readiness floor: `info`→none, `warning`→`input_required`,
  `error`→`inconsistency_risk_detected`, `hardStop`→`blocked`.
- **File**: `app/schemas/task-file.schema.ts:609+` (`deriveValidation`) — the single
  derivation for `validation`: `none` (no work revision yet) → `failing` (any required
  reviewer requested changes) → `healthy` (all required reviewers approved) → `bypassed`
  (force-accept override) → `changed` (revision under review, verdicts pending).
- **Surfacing**: `app/server/projections/task-query.server.ts` and `.../
  review-queue.server.ts` cache `validation` into `task_projections`; `app/ui/pill.tsx`
  (`ReadinessPill`) is the display component rendered from `app/features/task-detail/` and
  `app/features/board/board-page.tsx`.

---

## 4. The operator

### `operator-run.server.ts` — the runtime driver
- **File**: `app/server/runtimes/operator-run.server.ts:1130-1378` (`runOperator`) — the
  single entry point for an operator run. Triggers: the manual "Run operator" button, a
  stage-transition fire-and-forget re-invoke, task creation/goal-update, an `@operator`
  comment, a delivered-PR requeue (full autonomy), a scheduled re-run, boot/run recovery.
  Resolves operator authority, refuses a `scheduled` trigger on an already-terminal task
  (FR39), refuses a `manual` trigger while a packet is open, enforces a per-task
  single-flight process lease (FIFO/newest-wins queuing), marks the task `waiting: agent`,
  clones/checks out the repo, then branches on backend into `startCodexOperatorRun` or
  `startRealOperatorRun`.
- **Invariant**: "one operator coordinates a task at a time" via the lease; a scheduled
  trigger is re-checked against the terminal stage again at drive time, not just claim
  time (ruling F19-20).

### `operator-toolkit.server.ts` vs the runtime driver — the split
- **File**: `app/server/tasks/operator-toolkit.server.ts:46-116,243+`
  (`buildOperatorToolkit`) — builds the operator's in-process Claude Agent SDK MCP tool
  surface (server name `"viberr"`), one tool per governed action, only for capabilities
  not in `"off"` mode. This is the **Claude-only tool surface**.
- **Three-way split**: `operator-run.server.ts` = orchestration/runtime driver (lease,
  prompt assembly, backend dispatch, completion handling); `operator-toolkit.server.ts` =
  Claude-side tool definitions only; `operator-actions.server.ts` = the actual
  capability-gated business logic BOTH backends ultimately call into.
- **Invariant**: `allowedTools` only auto-approves — the real fence is the deny-list
  (`operatorDisallowedTools`, `operator-run.server.ts:1120-1128`) plus the fact that no
  repo-write tool is ever built into this toolkit at all.

### `operator-actions.server.ts` — the capability-gated business logic
- **File**: `app/server/tasks/operator-actions.server.ts` (~2,933 lines). Key exports:
  `clampAutonomy` (227), `operatorAutonomyFor`/`resolveOperatorAuthority` (337, 353),
  `gate`/`deliverGate` (446, 476), `operatorOpenPacket`/`operatorResolvePacket` (876,
  1057), `operatorSnapshot` (1497), `operatorPostComment`/`operatorFlagContextConflict`
  (1663, 1707), `operatorSetGoal` (1770), `operatorEngageAgent`/`operatorRunAgent`/
  `operatorPromptAgentGeneric` (2309, 2357, 2412 — the current generic-agents actions),
  `operatorDeliverForReview` (2481), `operatorTransitionStage` (2575),
  `operatorAcceptCompletion` (2764). Legacy-shaped `operatorAssignSpecialist`/
  `operatorAssignReviewer`/etc. (1860-2308) are superseded by the generic pair.

### Claude toolkit vs Codex structured-plan
- **File**: `app/server/runtimes/operator-run.server.ts:2344-2470`
  (`startRealOperatorRun`) vs `:1717-1837` (`startCodexOperatorRun`).
- **What it does**: Claude gets `mcpServers`/`allowedTools` from `buildOperatorToolkit` and
  coordinates *during* the run via in-process tool calls (same Node process, no network);
  the process lease is held for the run's whole duration. Codex gets an `outputSchema`
  from `buildOperatorPlanSchema(operatorPlanToolsFor(authority))` — one JSON decision plan
  at the end — and `registerRunCompletion` parses + **executes** that plan through the
  exact same `operator-actions.server.ts` functions (`executeCodexPlan`) only after the run
  finishes cleanly.
- **Invariant**: `OPERATOR_PLAN_TOOL_CAPABILITIES` (`operator-run.server.ts:1438-1458`) is
  the Codex mirror of the Claude build-gate — a denied action is never even offered to the
  model in the schema.

### Capability policy and autonomy
- **Catalog**: `app/shared/capabilities.ts:33-165` (`UNIFIED_CAP_CATALOG`), enforcement
  metadata at `:211-296` (see §6 for the full breakdown). Consulted by `gate`/`deliverGate`
  and by `operatorPlanToolsFor`/`operatorDisallowedTools`.
- **Autonomy schema**: `autonomy: z.enum(["supervised", "full"]).optional()` on the
  operator's deployment definition (`app/schemas/project-file.schema.ts:104-106`), stored
  in `project.md`.
- **Resolution**: `resolveOperatorAuthority` (`operator-actions.server.ts:353-443`) treats
  the deployment's configured autonomy as the **ceiling**; `clampAutonomy` reduces any
  per-run override that asks for more, auditing the clamp only when it actually bit
  (`task.operator.autonomy_clamped`). Ruling R19-A: "a run may never exceed the project's
  configured autonomy." Full autonomy promotes every `recommend` capability to `direct`
  **except** `completion-for-acceptance`, which additionally requires an EXPLICIT `direct`
  grant (owner ruling Q1) — `gate()` special-cases this (`operator-actions.server.ts:
  456-462`).
- **The one deliberate human-only-Done exception**: `operatorAcceptCompletion`
  (`operator-actions.server.ts:2764-2900+`) — gated first by `completionCapabilityRefusal`
  (a withheld capability refuses before any read/card/audit row, ruling R19-6), then by
  the SAME `acceptanceRefusalFor` gate every human acceptance writer uses. Reached only
  with `autonomy === "full"` AND `gate(authority, "completion-for-acceptance") ===
  "direct"`; otherwise it posts an `accept_completion` recommendation card instead of
  acting. Per ruling R16-6: an operator acceptance records **merge pending** — the actual
  merge (`merge-pull-request`) is `ALWAYS_HUMAN` and a human completes it afterward.

### Decision packets
- **Schema**: `PACKET_OPTION_KINDS` (`app/schemas/task-file.schema.ts:74-102`) — 10 stable
  kinds: `accept_completion | request_edit | block_on_policy | hold_runtime_debug |
  redirect | retry_other_backend | edit_goal | archive_task | discard_branch | custom`.
  `taskPacketSchema` at `:418-444`.
- **File**: `app/server/tasks/operator-actions.server.ts:876-975` (`operatorOpenPacket`) —
  gated by `generate-packets`; refuses to open a second packet while one is already open.
- **Invariant**: "one open decision at a time" is enforced structurally, not just by
  prompt instruction.

### Delivery decisions — a naming trap
- **No standalone `delivery-decision.server.ts` / `delivery-actionable.server.ts` /
  `delivery-requeue.server.ts` / `delivery-push-grant.server.ts` implementation files
  exist** — only their `*.server.test.ts` counterparts under `app/server/tasks/`. The
  behavior they test lives in `task-actions.server.ts` and `operator-actions.server.ts`:
  - `performDelivery` (`task-actions.server.ts:4262-4716+`) — pushes the delivering
    engagement's branch (subject to the push-grant check), opens the review PR, surfaces a
    typed `github` timeline event for every non-success outcome.
  - `resolveDeliveryPushGrant` (`task-actions.server.ts:4120-4262`) — resolves whether the
    delivering profile's `execute-code-or-write-repo` grant permits pushing; conservative
    (deny) fallback if the deliverer's profile can't be resolved.
  - `recordDeliveredNextStep` (internal, `task-actions.server.ts:4847+`) — after a
    successful delivery, records one system-attributed "Move to Review" card for a
    supervised operator-authorized delivery.
  - Under **full** autonomy, a newly-opened PR re-queues the operator
    (`autoInvokeOperator(..., "delivered", ...)`, ruling R18-2/F18-10); **supervised**
    deliveries deliberately do not re-queue.
  - `operatorDeliverForReview` (`operator-actions.server.ts:2481`) / `deliverGate`
    (`:476-502`) — the operator's own delivery tool, **absent-means-granted** polarity
    (pre-R15-2 deployments keep delivering), falling back to
    `absentDeliverReviewPrMode(humanGatedBeforeWork)` when no explicit grant exists.
- **Invariant**: delivery is an **operator decision**, never an automatic stage
  side-effect (ruling R15-2) — reaching a review-role stage with no live PR is announced,
  never auto-delivered.

### Scheduled re-runs (FR39)
- **File**: `app/server/tasks/schedule.server.ts` — `scheduleTaskAction` (123) creates a
  `TaskSchedule` (rejects a past `dueAt` or an already-terminal task); `cancelScheduledAction`
  (183); `fireDueSchedules` (294, ticked every 60s by `startScheduleRunner` at 594) finds
  due schedules, **claims** each occurrence inside the task file lock (re-checking mootness
  against the canonical locked frontmatter, not the projection snapshot — F19-20), then
  fires `runOperator(..., { trigger: "scheduled" })` with **no pinned backend or
  autonomy** — resolution uses whichever operator profile is *live-deployed at fire time*
  (ruling R22-schedule, superseding FR39's original per-schedule pin).
- **Invariant**: a claimed-but-uncompleted occurrence (crash between claim and enqueue) is
  re-driven once its `CLAIM_LEASE_MS` lease expires — never silently lost.

---

## 5. Specialist runs

### `specialist-run.server.ts` — entry point and flow
- **File**: `app/server/tasks/specialist-run.server.ts:1057-1073` (`startAgentRun`, the
  exported public entry — a thin wrapper) → `:1074-2438` (`dispatchAgentRun`, private, the
  real implementation). `dispatchAgentRun` resolves the target engagement, enforces
  single-flight, re-resolves the live deployed profile (`resolveDeployedSpecialist`,
  :308-340), resolves backend/model/effort, clones the workspace (`cloneRepo`), mounts
  skills/KB/MCP/browser, builds the persona (`buildSpecialistPersona`), calls `startRun`
  (`run-service.server.ts`) at :1721. Other exports: `assignSpecialist` (671),
  `assignReviewer` (830), `removeReviewer` (962), `resolveResumeConfinement` (2525),
  `listDeployedSpecialists` (3182).
- **Invariant**: the run-row reservation is claimed *before* the workspace clone so the UI
  shows "Preparing workspace" instead of nothing (ruling R21-4); `startAgentRun`'s outer
  catch abandons the reservation on any preparation failure.

### The delivering single-flight
- **File**: `app/server/tasks/specialist-run.server.ts:1106-1156` — **not** a reuse of
  `single-flight.server.ts` (that's a generic rebuild cooldown, unrelated). A bespoke DB
  check: before starting a **delivering** run, queries for an existing `primary`-kind
  running/queued row and refuses with a 409 CONFLICT if found ("one live delivering run per
  task", ruling F7-OP1). For a **supporting** engagement, the analogous check is keyed on
  `agent_profile_id` (same-profile serialization only — different supporting engagements
  run concurrently, since each has its own isolated checkout).

### Per-engagement workspace isolation (pass-25 "P8")
- **File**: `app/server/tasks/specialist-run.server.ts:2442-2448` (`taskWorkspaceRoot`,
  `<taskDir>/workspace`), `:2484-2492` (`supportCheckoutDir`) — the delivering engagement's
  checkout is `path.join(workspaceRoot, repoName)` (canonical); a supporting engagement's
  is `path.join(workspaceRoot, "support", profileId, repoName)` — exactly
  `workspace/support/<profileId>/<repo>`. Built at `:1337-1366`
  (`support = delivers ? undefined : { profileId }`).
- **What it does**: inside `cloneRepo` (:2850-2973), a supporting checkout is `rmSync`'d
  and re-cloned **fresh on every dispatch** via `git clone --local <deliveringDir>
  <supportDir>` (fast local clone carrying the delivering branch's commits), then `origin`
  is re-pointed at GitHub. `app/server/tasks/agent-reply.server.ts:643-664`
  (`resumeWorkdir`) builds the identical path for resumed runs.
- **Invariant**: only the delivering engagement's checkout is canonical — the tree that
  `push-workspace` ships, the operator reads, and evidence paths resolve against. A
  supporting engagement's writes can never reach the delivered PR (physically separate
  directory, wiped and rebuilt every run).

### Resume
- **File**: `app/server/tasks/specialist-run.server.ts:2525-2766`
  (`resolveResumeConfinement`), called from `app/server/tasks/task-actions.server.ts:
  1291-1345` (a comment/@mention targeting an agent with a prior resumable session, matched
  via `latestSessionRun` in `agent-reply.server.ts:251-273`). Re-derives the **entire**
  confinement from scratch (disallowed tools, env, MCP mounts, persona/skills, outcome
  schema) rather than reusing anything cached, to avoid a resume silently dropping half the
  fresh-run policy. `resumeRun` (`app/server/runtimes/run-service.server.ts:1077`) probes
  whether the provider transcript is still alive; if gone, starts a fresh provider session
  with a "continuity reset" preamble (the `continuity` timeline event type, §3/§4 of
  `file-formats.md`).
- **Invariant**: a resumed run of an undeployed profile falls back to the same conservative
  posture as a fresh undeployed run (`resolveUndeployedDisallowedTools()`) — resuming can
  never *escalate* power.

### Skill / KB / MCP / browser mounting
All four happen during dispatch preparation (post-clone, pre-`startRun`); the persona is
built *after* all of them so it can honestly report what actually mounted.
- `app/server/runtimes/skill-mount.server.ts:256` (`mountGrantedSkills`) — Claude only;
  called right after the clone, before persona build.
- `app/server/files/kb-injection.server.ts:304` (`readKbBodies`) — invoked inside
  `buildSpecialistPersona` (`specialist-run.server.ts:2009`).
- `app/server/tasks/specialist-mcp.server.ts:120,248`
  (`resolveSpecialistMcpServersDetailed`, `verifyStdioMcpMountsForRun`) — called via
  `mcpServersFor` at `specialist-run.server.ts:1258`.
- `app/server/tasks/specialist-browser-mcp.server.ts:101` (`resolveBrowserMcp`) — called at
  `specialist-run.server.ts:1418-1424`; refuses the mount if `use-web-search-fetch` is
  withheld (browser-implies-egress pairing, ruling 95).

### Run console + run-inputs disclosure
- **File**: `app/server/tasks/specialist-run.server.ts:471-654`
  (`resolvedResourceInputs`, `recordRunInputs`) — writes a synthetic, redacted log line
  (tag `run·inputs`, `RUN_INPUTS_TAG` in `app/features/runtime/runtime-types.ts:108-154`)
  at the head of every run's console: cwd/repo/cloned, delivers, persona/prompt char
  counts, the canonical task anchor text, skills split `granted`/`native`/`injected`,
  `knowledge`, `mcp.mounted`/`unresolved`/`unhealthy`, `tools.denied`/`tools.toolkit`.
- **UI**: `app/features/runtime/runs-helpers.ts:138-255` (`runInputRows`, pure formatter —
  states every row even when empty, "an absence must be visible"),
  `app/features/runtime/runs-panels.tsx:755-800` (the expandable disclosure panel),
  `app/routes/resources.run-log.ts` (member-gated log-fetch route).
- **Invariant**: denied-tools rendering is backend-aware — on Codex it says "advisory on
  this Codex run, not tool-enforced" rather than claiming a denial that didn't happen.

---

## 6. Capability model + RBAC

Two **separate, non-overlapping** surfaces: RBAC governs which human, by project role, may
click the button that starts a run / approves a transition / accepts completion. Capability
grants govern what the *running agent process* is allowed to do once dispatched. They
compose but are enforced at entirely separate call sites and never share a check.

### `app/shared/capabilities.ts` — the catalog
- **File**: `app/shared/capabilities.ts:33-154` (`UNIFIED_CAP_CATALOG`) — 24 capabilities.
  Operator-only: `assign-primary-specialist`, `summon-reviewers`, `generate-packets`,
  `append-typed-events`, `stage-transitions`, `completion-for-acceptance`,
  `deliver-review-pr`, `update-task-branch`. Agent repo/exec: `execute-code-or-write-repo`,
  `create-task-branch`, `commit-push-branch`, `open-review-pr`. Agent collaboration:
  `comment-on-task`, `ask-human`, `use-browser`, `read-github-api`,
  `report-validation-verdict`, `attach-evidence-references`. Shared: `use-web-search-fetch`.
  Advisory/matrix-only (no runtime consumer, 9 total): `run-unit-integration-validation`,
  `move-task-to-review`, `read-repo-diff`, `run-validation-suites`, `post-quality-flags`,
  `approve-review`, `request-changes`, `author-test-cases`, `read-task-repo`,
  `flag-underspecified-tasks`. Always-human, structural (3): `merge-pull-request`,
  `transition-to-done`, `change-project-policy`.
- **Invariant**: `defaultGrantsFor`/`conservativeGrantsFor` (:165-203) — `capabilities: []`
  on a deployment does NOT mean "no powers"; an unspecified capability is read as GRANTED,
  so every creation path must persist explicit grants (ruling P13-AP-06).

### Enforcement scope — `both` / `claude-only` / `advisory`
- **File**: `app/shared/capabilities.ts:260-296`:
  ```ts
  export type EnforcementScope = "both" | "claude-only" | "advisory";
  export function capabilityEnforcement(id: string): EnforcementScope {
    if (ALWAYS_HUMAN.has(id)) return "both";
    if (CLAUDE_ONLY_ENFORCED_CAPABILITY_IDS.has(id)) return "claude-only";
    if (ENFORCED_CAPABILITY_IDS.has(id)) return "both";
    return "advisory";
  }
  ```
- `ENFORCED_CAPABILITY_IDS` (:223-258, both-backend real enforcement): the repo-write
  family (as of ruling R22, see below), `report-validation-verdict`, `ask-human`,
  `attach-evidence-references`, `use-web-search-fetch`, `use-browser`.
  `CLAUDE_ONLY_ENFORCED_CAPABILITY_IDS` (:270-283): `create-task-branch`,
  `commit-push-branch`, `open-review-pr`, `execute-code-or-write-repo`, `comment-on-task`,
  `read-github-api`.
- **Invariant / R22 history** (`capabilities.ts:262-269`; `docs/architecture/
  decisions.md:1149-1177`, ruling 93): the Codex OS read-only sandbox was removed
  2026-08-21 ("viberr itself is the sandbox" — the container + server-owned delivery gate
  are the real boundary). `execute-code-or-write-repo` therefore REJOINED the claude-only
  set: on Codex, repo-write withholding is now advisory only; on Claude it's still real
  (tool denylist under `bypassPermissions`).

### `app/shared/rbac.ts` — `roleCan`, `ACTION_ROLES`, project roles
- **File**: `app/shared/rbac.ts:31-111`. Four project roles, strict tier: `admin` ⊃
  `maintainer` ⊃ `contributor` ⊃ `viewer` (`ROLE_RANK`, :31-36; sourced from
  `PROJECT_ROLES` in `app/schemas/project-file.schema.ts:23`). **There is no "reviewer"
  project role** — that name doesn't exist here (it was renamed to `contributor`, ruling 2
  amendment). Signature: `roleCan(role: ProjectRole | null | undefined, action:
  RbacAction): boolean`. `ACTION_ROLES` is a `Map<RbacAction, readonly ProjectRole[]>` built
  from `RBAC_DEFINITIONS` (:61-88) — 17 actions: `view`, `comment`, `create-task`,
  `own-task`, `approve-transition`, `resolve-packet`, `accept-completion`, `update-goal`,
  `run-agents`, `reorder-board`, `reconcile-github`, `grant-github-scope`,
  `rescan-project`, `release-any-ownership`, `manage-members`, `manage-agents`,
  `edit-policy`, `force-accept-completion`.
- **Invariant**: `view`/`comment` are held by all four roles and enforced entirely by
  *project membership* — a non-member gets a 404, not a role check (ruling R15-4). No
  owner-override logic lives in this file — the FR37 exception is implemented in
  `task-actions.server.ts` (§3/§4), not here.

### Materializing grants for display — `effectiveProfileView`
- **File**: `app/features/agents/agents-query.server.ts:277-336+`. Signature:
  `effectiveProfileView(deployment, dataRoot, absentDeliverMode, modelMarks?)`. Resolves
  the effective template⊕override identity, then for **operator** deployments materializes
  governance-dependent capabilities that may be absent from stored grants
  (`deliver-review-pr`, `update-task-branch`) at the mode the runtime actually applies. For
  **specialist** deployments, normalizes a stray `recommend` down to `off`
  (`coerceSpecialistCapabilityMode` — never up to `direct`, the safe direction).
- **Invariant**: before a pass-24 fix (A-1, HIGH), `update-task-branch` was excluded from
  materialization, so the editor seeded it at a flat catalog `direct` while every display
  surface showed it absent — an unrelated save then silently widened `recommend`→`direct`
  on a strict project. The fix makes matrix/detail/policy/editor-seed all read the same
  computed value.

### MCP servers stay OUTSIDE the capability matrix
- **Doc**: `docs/architecture/decisions.md:347-356` (ruling R16-5 / PRD NFR8). **What it
  means**: granting an MCP server IS the authorization to use whatever its tools do — an
  MCP server's tools are not enumerated as capabilities and are not gated by the
  `direct|recommend|human|off` matrix. A withheld `execute-code-or-write-repo` does NOT
  bound a granted server's tools. Pinned by `app/server/tasks/
  specialist-tool-policy.test.ts` (no `mcp__*` deny rule exists anywhere in the
  tool-denylist builder). Disclosed in `app/features/agents/
  capability-matrix-modal.tsx:257-269`.

---

## 7. Backends (Claude vs Codex)

### Common adapter interface
- **File**: `app/server/runtimes/adapter.server.ts:234-238` (`RuntimeAdapter` — `backend`
  + `start(spec: RunSpec, cb: RunCallbacks): RunHandle`). `RunSpec` (:50-133) carries
  backend, model, effort, prompt, workdir, resumeSessionId, autonomous, systemPrompt,
  mcpServers, `allowedTools`/`disallowedTools` (Claude-only), `attachmentsWritableDir`,
  `skills` (Claude-only), `repoWriteWithheld`, `webSearchWithheld`, `outputSchema`
  (Codex-only), `env`. `RunCallbacks` (:158-172) = `onLine`/`onExit`/`onPhase`.
- **Invariant**: adapters never touch DB/files/broker directly — only run-service persists
  via callbacks (:12-16).

### Claude runtime — official SDK, not raw CLI
- **File**: `app/server/runtimes/claude-runtime.server.ts:17-35,349` — uses
  `@anthropic-ai/claude-agent-sdk`'s `query()` (`await import(...)`, line 349), returning an
  async generator of `SDKMessage`. Interrupt via `Query.interrupt()`; resume via
  `options.resume`; autonomous → `permissionMode: 'bypassPermissions'`. Isolation:
  `settingSources: []`/`plugins: []` (no host `~/.claude` leakage), `strictMcpConfig`
  ignores ambient `.mcp.json`.
- **Config dir**: `app/server/runtimes/claude-config.server.ts:25-32`
  (`resolveClaudeConfigDir`) — explicit `CLAUDE_CONFIG_DIR` wins; else CLI-auth mode uses
  real `~/.claude`; else an app-owned `<VIBERR_DATA_ROOT>/runtimes/claude-home`.

### Codex runtime — official SDK spawning the CLI binary
- **File**: `app/server/runtimes/codex-runtime.server.ts:26-64,527` — uses
  `@openai/codex-sdk` (pinned verified version, `CODEX_SDK_VERIFIED_VERSION`, line 64;
  `await import(...)` at 527): `new Codex()` → `startThread`/`resumeThread` →
  `thread.runStreamed()` → async generator of ThreadEvents. Interrupt via `AbortController`.
- **Config dir**: `app/server/runtimes/codex-config.server.ts:14-73` (`resolveCodexHome`) —
  every run gets a dedicated app-owned `CODEX_HOME`
  (`<VIBERR_DATA_ROOT>/runtimes/codex-home`), because the CLI has no SDK-level isolation
  option and `--config` merges per-leaf-key into whatever `config.toml` already exists
  rather than replacing it.

### Toolkit mode (Claude) vs structured-plan mode (Codex)
See §4 "Claude toolkit vs Codex structured-plan" — same distinction, driven from
`operator-run.server.ts:1368-1370` (`backend === "codex" ? startCodexOperatorRun(...) :
startRealOperatorRun(...)`). For specialists, `app/server/tasks/
specialist-run.server.ts:722-797` branches purely on `specialist.backend` for labeling; the
run start itself funnels through the shared adapter via run-service.

### Skills channel — backend-asymmetric
- **File**: `app/server/runtimes/codex-runtime.server.ts:241-267,303-306` — Claude has a
  native skills mechanism (`mountGrantedSkills` + SDK `skills` filter: metadata upfront,
  full body loaded only on invocation). Codex's whole skills channel is **severed on
  purpose**: `skills.include_instructions: false` + `bundled.enabled: false` in
  `codexConfigForRun`, because the Codex CLI re-installs its own bundled `.system` skills
  into any home on startup with no per-skill governance hook. Codex-granted skills instead
  ride the system prompt as plain text.
- **File**: `app/server/runtimes/skill-mount.server.ts:1-46` — Viberr is the sole writer of
  the workspace's `<workspace>/.claude` (Claude-only): strips whatever `.claude` the repo
  ships, writes granted skills back as `.claude/skills/<name>/`.

### MCP credential handling — the Codex `--config` leak
- **File**: `app/server/runtimes/codex-runtime.server.ts:153-186` (`codexMcpServers`) —
  `resolveSpecialistMcpServers` injects decrypted credentials as `headers.Authorization`
  (HTTP) / `env.MCP_CREDENTIAL` (stdio) for Claude, but this is **deliberately dropped** on
  Codex — the SDK passes MCP config to the CLI as `--config key=value` argv, visible in
  `ps auxww`. Consequence: a credentialed org MCP server authenticates on Claude runs only;
  on Codex it connects unauthenticated (documented as an honest limitation, not a silent
  drop). Also (lines 141-148): Claude mounts tools as `mcp__<name>__tool`; the Codex CLI
  lowercases hyphens to underscores in the same prefix — same declared name, different
  literal tool name per backend.
- **This is also why `read-github-api` is Claude-only** (§6/PRD NFR8 discussion) — it's an
  in-process Claude SDK tool so the PAT never leaves the server process; a Codex mount
  would require handing the child the credential via the leaky `--config` path.

### Sandbox modes — R22 removed the Codex OS sandbox
- **File**: `app/server/runtimes/codex-runtime.server.ts:342-383`
  (`resolveCodexSandboxMode`). Only a fully-autonomous **delivering** run (not
  operator/reviewer) with egress granted gets `danger-full-access`; every other run is
  `workspace-write` (writable, shell-capable, network gated separately by
  `networkAccessEnabled`/`webSearchMode`, since `danger-full-access` can't honor a
  network-off gate). Claude's tool-denylist enforcement is unchanged. Doc:
  `docs/architecture/decisions.md:1149-1177` (ruling 93/R22); live UI copy:
  `app/features/agents/capability-matrix-modal.tsx:85-93`.

### Attachments / images
- **File**: `app/server/runtimes/codex-runtime.server.ts:700-706`, `adapter.server.ts:
  93-99` — `RunSpec.attachmentsWritableDir` widens a Codex `workspace-write` sandbox with
  an extra writable dir so a profile holding `attach-evidence-references` can copy files
  into `attachments/`. Claude at `bypassPermissions` needs no widening.

### The "envelope" concept
- **File**: `app/server/tasks/agent-outcome.server.ts:15-31` — one uniform `AgentOutcome`
  envelope (summary/verdict/question/evidence), two transports: Claude stages it mid-run
  via the in-process `report_outcome` toolkit tool; Codex constrains its *final* reply to
  the same JSON shape via `outputSchema` (`AGENT_OUTCOME_JSON_SCHEMA`, OpenAI-strict).
  `applyAgentCompletionEffects` resolves one envelope per finished run, falling back to a
  prose classifier if neither transport fired.
- **Distinct concept — the wire format**: `app/server/runtimes/wire-format.server.ts:
  15-33,237-249` (`EnvelopeFacts`, `projectEnvelope()`) is the wire-level normalizer:
  decodes each backend's raw stream envelope into a common `LogLine` + facts (sessionId,
  usage, cost — Claude only, turns, isError/isResult). Unknown envelope types render raw
  rather than being dropped.

### Model catalog / availability
- **File**: `app/server/runtimes/model-catalog.server.ts:16-40` — curated fallback list
  (Claude family aliases; Codex hand-maintained since it exposes no models endpoint) plus,
  Claude-only, a live `.supportedModels()` query cached with a short TTL.
- **File**: `app/server/runtimes/model-availability.server.ts:6-129` — `model_availability`
  table marks a model unusable ONLY from a real run's failure matching
  `MODEL_UNSUPPORTED_RE` (never a synthetic probe, never quota/auth failure — ruling 19,
  "chips render proven verdicts only").

### "What differs" — no standalone matrix doc
No dedicated `docs/architecture/*backends*` matrix file exists. The closest thing is the
live UI copy in `app/features/agents/capability-matrix-modal.tsx:85-93` plus ruling 93
(`docs/architecture/decisions.md:1149-1177`) and this section.

---

## 8. GitHub delivery & reconcile

### Branch naming
- **File**: `app/server/github/branch-sync.server.ts:45-47` (`taskBranchName`) —
  `taskKey.toLowerCase()`, e.g. task `VIB-12` → branch `vib-12`. Sole convention; used
  everywhere as `fm.branch ?? taskBranchName(input.taskKey)`.

### PR creation
- **File**: `app/server/github/pr-open.server.ts:315-383` (`openTaskPr`) — reconciles any
  cached live PR first; else checks the deterministic head branch for an existing open PR
  (adoption, ruling R16-1) before creating.
- **Invariant**: idempotent twice over (NFR16) — a cached PR is reused, an existing
  head-branch PR is adopted, a duplicate is never created (`pr-open.server.ts:303-313`). A
  403 surfaces a `pull_request:write` scope violation rather than throwing.

### Branch updates
- **File**: `app/server/github/update-branch.server.ts:20-58`
  (`updateWorkspaceBranchFromBase`) — merge only (never rebase, never force-push), run
  inside the delivering engagement's own workspace, then pushed. All-or-nothing: a conflict
  aborts; a failed push resets local state.
- **File**: `app/server/github/update-branch-operator.server.ts:20-44` — gates this as an
  operator DECISION (ruling N19-9): server executes mechanics, agent decides whether/when;
  a genuine merge conflict always becomes a human-gated packet, never auto-retried.

### push-workspace
- **File**: `app/server/github/push-workspace.server.ts:18-90` (`pushWorkspaceBranch`) —
  re-supplies the project PAT via the short-lived askpass mechanism and pushes the
  workspace's task branch to origin at the review boundary. Distinguishes `pushed` /
  `push_conflict` (non-fast-forward) / `push_failed` / `no_branch` (with
  `DefaultBranchEvidence.verified` requiring 3 read-only probes to agree before treating
  it as a legitimate zero-diff completion). Never throws.
- **File**: `app/server/github/workspace-delivery.server.ts:33-49` — the complement:
  reconciles the task record from what a fully-autonomous agent (e.g. `danger-full-access`
  Codex using its own git/gh creds) did **outside** Viberr's PAT flow, by inspecting the
  run's workspace git repo directly.

### Reconcile poller
- **File**: `app/server/github/reconcile-poller.server.ts:29-41` — polls every active
  project with task branches every `RECONCILE_POLL_MS = 5 * 60_000` (5 min), driving
  `reconcileProject` from `github-reconciler.server.ts`. Also runs
  `nudgeMergePendingTasks` (:48-90) to remind about accepted-but-unmerged PRs.
- **Manual/one-off trigger**: `app/features/github/github-actions.server.ts:58-73` — the
  UI's "Update status" button calls `reconcileProject` directly.
- **File**: `app/server/github/github-reconciler.server.ts:820-826` (`reconcileTask`) —
  reconciles ONE task with live GitHub facts (branch compare, PR state, commits, checks)
  into the `pr`/`github` frontmatter cache.
- **Invariant**: idempotent — unchanged facts write nothing (but still record a
  provenance row); serialized per task via `withTaskReconcileLock` (ruling F19-19).

### Credential/PAT handling — per-project, not org-level
- **File**: `app/server/secrets/pat-store.server.ts:17-41,255-320` — `project_github_
  credentials` binds exactly ONE stored PAT per project (AES-256-GCM at rest), keyed on
  `project_slug` (`setProjectCredential`/`getProjectCredential`).
  `DEFAULT_REQUIRED_SCOPES = ["repo", "pull_request:write"]`.
- **File**: `app/server/github/github-context.server.ts:47-85`
  (`getProjectGithubContext`) — the shared resolver every GitHub service starts from:
  reads the project's single repo (`projects` table, `repo` column), resolves/decrypts the
  bound PAT, returns typed failures (`no_repo_configured`, `no_pat_configured`) rather than
  throwing.
- **File**: `app/server/tasks/git-clone-auth.server.ts:39-92` (note: lives under
  `app/server/tasks/`, NOT `app/server/github/`) — `createGitHubAskpassEnv`/
  `createGitHubClonePlan`: the PAT reaches `git` only via `GIT_ASKPASS` (never argv, never
  the remote URL, never persisted config); a short-lived helper script disposed after the
  process exits.
- **File**: `app/server/github/repo-access-check.server.ts:15-84` (`checkRepoAccess`) —
  maps GitHub 401→`auth_failed`, 404→`repo_not_found`, 403 (org-approval text)→
  `org_approval_missing`, else `forbidden`.
- **File**: `app/server/github/scope-flag.server.ts:107-151` (`flagScopeViolation`) — on a
  403 scope refusal, opens an idempotent violation row + writes a `policy` timeline event +
  notifies watchers.
- **Invariant**: "one project, one repository" (ruling P13-D-5) — the task-level repo
  override was deleted; a project's repo is singular and canonical (`repo:` in task
  frontmatter is now an ignored unknown key, per `file-formats.md:270-277`).

### Mirror cache
- **File**: `app/server/tasks/repo-mirror.server.ts:21-80` (`cloneWorkspaceRepo`,
  `projectRepoMirrorDir`) — a per-project BARE git mirror at
  `projects/<slug>/.repo-mirror/<owner>__<repo>.git`, refreshed (`fetch --prune`) before
  each workspace clone. Task workspaces clone LOCALLY from the mirror (hardlinking — fast,
  independent of later mirror GC), origin rewritten to the real credential-free GitHub URL
  afterward. Called from the private `cloneRepo` in `specialist-run.server.ts`. A
  working-but-stale mirror is still served; two consecutive refresh failures condemn it for
  rebuild. (Ruling R21-4 — see `docs/architecture/decisions.md:1059-1076`.)

### PR-adoption / divergence / human-approval / linker
- **File**: `app/server/github/pr-adoption.server.ts:1-45` (`decidePrAdoption`) — adopts a
  name-matched branch's PR ONLY if it's open AND its head sha equals the task's actually
  delivered revision (identity, not containment); otherwise it's a reported, blocking
  branch COLLISION, never silently bound.
- **Naming trap**: no standalone `pr-divergence-operator.server.ts` **implementation**
  exists — only its test file. The behavior (an out-of-band PR state change waking the
  task's operator into a decision packet) lives inside `github-reconciler.server.ts`
  (`reconcileTask`, `deleteTaskRemoteBranch`, `OperatorWake` type).
- **File**: `app/server/github/pr-human-approval.server.ts:6-40` — ruling R19-B: a project
  member's GitHub PR approval counts as the acceptance verdict, bound to the delivered
  revision's `commit_id`; fails closed on unmapped/non-member approvers.
- **File**: `app/server/github/pr-linker.server.ts:14-46` (`mapPrToCacheState`) — maps real
  GitHub PR states to the task-file cache vocabulary: merged→`"merged"`, open/draft→
  `"review"`, closed-unmerged→`"closed"`, plus a Viberr-only `"accepted"` (human-accepted,
  merge still pending).

### Branch cleanup
- **File**: `app/server/github/branch-cleanup.server.ts:4-57` (`branchCleanupOnMerge`) —
  post-merge deletion gated by a project.md guardrail (`delete-branch-after-merge`);
  never deletes the default branch or a branch with an open PR.
- **Invariant**: ABSENCE MEANS ON (ruling R15-6) — a project predating this ruling defaults
  to cleanup-enabled; only an explicit `on: false` guardrail row disables it.

---

## 9. Resources (KBs, MCP servers, skills)

### Knowledge bases — storage model
- **File**: `app/server/files/file-store-root.server.ts:16-17,126-155` — file-native
  folders under `${VIBERR_DATA_ROOT}/kb/<dir>/`, path-guarded by `resolveStoreSegment`.
  SQLite (`org_knowledge_bases`) carries only metadata (name, dir, refresh cadence,
  `last_indexed_at`) — disk is truth; a folder with no row still renders.

### KB editor UI
- **File**: `app/features/kb-browser/store-browser.tsx` (+ `tree.ts`, `local-files.ts`) — a
  store-folder file-manager popup; every mutation (upload, mkdir, doc write, GitHub import,
  delete) is a fetcher POST to the org-settings action performing a real fs write, then a
  re-scan.

### KB injection into a run
- **File**: `app/server/files/kb-injection.server.ts:161-353` — `readKbBodyDetailed`/
  `readKbBodies` walk the KB folder recursively, matching every extension in
  `STORE_TEXT_EXTENSIONS`, enforcing a **shared 24,000-char budget across ALL declared
  KBs** (`KB_INJECTION_BUDGET = 24_000`, line 64). Symlinked folders/docs are refused
  (never dereferenced); a realpath+cycle+depth-32 guard prevents traversal.
- **Invariant**: an unresolved KB grant (missing folder, symlink, empty, budget-exhausted)
  is never silently dropped — returns an `UnresolvedKbGrant` with a human-readable reason
  surfaced IN THE RUN'S OWN PROMPT, not just a server log (ruling P14-KM-05/C1).
  `KB_PRECEDENCE_NOTE` (:343-353) states once (only when real KB text is present) that the
  repo's own conventions outrank KB guidance (ruling R19-2).

### KB live re-indexing
- **File**: `app/server/files/kb-watch.service.server.ts:1-206` — same 250ms-debounce
  chokidar pattern as the projects watcher, calling `reindexKnowledgeBaseByDir`
  (`app/server/org/resources.server.ts:492-530`) on change. A KB's "refresh mode" (`on
  change` default vs `manual`) only controls the doc-count/freshness metadata — a run
  always reads the live folder at injection time regardless of mode.

### Org resource registry — the single CRUD module
- **File**: `app/server/org/resources.server.ts:1-2161` — owns KB CRUD (:147-530), MCP
  server CRUD (:532-1763), and skill CRUD (:1764-2122), each disk-is-truth folder scans
  layered with SQLite metadata. `isReservedMcpName()` (:1289-1297) refuses `viberr`/
  `viberr_agent`/`viberr-agent`/`viberr_browser`/`viberr-browser` as registrable names —
  those are Viberr's own in-process tools, mounted unconditionally.
- **File**: `app/server/org/resource-catalog.server.ts:40-89` (`buildResourceCatalog`) —
  the live picker catalog for the create/edit agent-profile UI, merging on-disk folders +
  SQLite rows for skills/MCPs/KBs. The in-process `viberr` toolkit is never listed (its
  own grant would be a decision the product already made unconditionally).

### MCP server registry — fields and credential model
- **File**: `app/server/org/resources.server.ts:534-627,637-724` — an `McpView` row:
  `name`, `transport` (`HTTP | stdio`), `target` (URL or shell command), `hasCred`/
  `credUnreadable` (flags only — sealed secret never leaves the server), `tools` (real
  discovered count), `up`/`lastCheckedAt`/`lastError`, warm-up state.
- **Invariant**: `getMcpCredentialState()` (:657-668) returns `{state: "none"|"ok"|
  "unreadable"}` — an unreadable credential makes the run REFUSE to mount rather than
  connect unauthenticated (ruling A9).

### MCP health probing / background warm-up
- **File**: `app/server/org/resources.server.ts:963-1413` — both transports run a real
  JSON-RPC MCP handshake (`initialize` → `notifications/initialized` → `tools/list`), a
  credentialed server probed WITH its credential (ruling P13-KM-05).
- **File**: `app/server/org/mcp-warmup.server.ts:1-168` (`startMcpWarmup`,
  `reapStaleWarmups`) — a first-run installer command (`npx`/`bunx`/`uvx`/`pipx`) that
  times out gets a background warm-up (15-min cap) instead of a false "down" verdict;
  reaped on boot restart.

### Resource-grant referential integrity
- **File**: `app/server/org/resource-references.server.ts:1-217`
  (`updateResourceReferences`) — rewrites (rename) or drops (delete) every KB/MCP/skill
  grant reference across BOTH org agent-profile templates and every project's deployed
  copy. A grant list is a SET on rewrite — renaming into an already-granted name collapses
  to one entry.

### Skills — prompt-text injection path
- **File**: `app/server/files/skill-body.server.ts:1-242` — `readSkillBodyDetailed`/
  `readSkillBodies`, the one reader both operator and specialist resolve declared skills
  through; symlinked skill folders refused; **shared 24,000-char budget across all
  declared skills** (`SKILL_INJECTION_BUDGET`, line 36).

### Skills — native mount (Claude only)
- **File**: `app/server/runtimes/skill-mount.server.ts:1-494` — `mountGrantedSkills`
  (:256-302) copies each granted skill's folder into `<workspace>/.claude/skills/<name>/`
  for the Claude SDK's progressive-disclosure discovery. Runs `stripUngovernedRepoCatalog`
  first (:121-167) to delete whatever `.claude` the cloned repo ships. The mounted
  `.claude/` is added to `.git/info/exclude` — never delivered, never in the review PR.
- **Invariant**: `MOUNT_MARK` (:96, a per-process random UUID) lets a concurrent run's
  strip distinguish its own live mount from everything else, so one run can never
  un-mount another's skills mid-flight (ruling F19-15).

### Skills — Claude vs Codex split, at the persona-build layer
- **File**: `app/server/tasks/specialist-run.server.ts:1961-2017`
  (`buildSpecialistPersona`) splits a profile's declared skills into `native` (Claude-only,
  actually mounted, listed as metadata) vs `injectable` (every Codex skill, plus any Claude
  skill that failed to mount) — the latter still rides `readSkillBodies` prompt-text
  injection.

### `skills-lock.json` at repo root — NOT part of the product's resource system
- **File**: `/skills-lock.json` — this is the **Claude Code CLI harness's own**
  skill-provenance lockfile for skills installed into THIS development repo's
  `.claude/skills/` (animation-vocabulary, apple-design, ponytail, etc., pinned by hash).
  It has no relation to Viberr's own `${DATA_ROOT}/skills/` org-resource store — do not
  conflate the two "skills" concepts.

### Agent profiles — templates vs deployment
- **File**: `app/server/files/agent-profile-file.server.ts:1-157` — org-level templates at
  `${VIBERR_DATA_ROOT}/agents/profiles/<id>.md`; `agentProfileFrontmatterSchema` (:27-70)
  defines `id`, `kind` (`operator|specialist`), `name`, `role`, `desc`, `icon`, `backends`,
  `model`, `scope`, `stages`, `spanAll`, `capabilities[]`, `extras[]`, `resources:
  {skills[], mcps[], kb[]}`.
- **Invariant**: two-layer model — the org template defines the base; a project's
  `project.md` `agents[]` entry DEPLOYS a template by `profileId`, carrying a
  project-effective capability policy that may override the template. The project
  deployment is a full SNAPSHOT, not a pointer — `resource-references.server.ts` must walk
  both locations on rename/delete. Every `resources:` value (skills/mcps/kb) is a **store
  folder name, never a display name** — a `kb:` entry written as the display name resolves
  to nothing with only a `logger.warn` (`file-formats.md:379-386`).
- **CRUD UI backing**: `app/server/org/gagents.server.ts` — CRUDs the built-in specialist
  templates; the system `operator` template is never listed/editable here.

---

## 10. Auth, org, notifications, audit

### better-auth — sole auth system, confirmed
- **File**: `app/lib/auth.server.ts:1-423` — `createAuth`/`getAuth()` build a single
  `betterAuth()` instance (process-wide singleton, rebuilt when OAuth provider config
  fingerprint changes, ruling R19-16). `ALLOWED_AUTH_PATHS` (:63-70) is an ALLOW-LIST of
  exactly 6 endpoints (`/sign-in/email`, `/sign-in/social`, `/callback/:id`, `/error`,
  `/get-session`, `/sign-out`) — every other better-auth endpoint 404s via a `before` hook
  (:250-263), because those would bypass Viberr's own audited/session-revoking flows.
  Sign-up is disabled (`disableSignUp: true`); identities are provisioned only via
  whitelist/seed/OAuth hooks. No legacy/parallel auth system found.
- **File**: `app/routes/api.auth.$.ts:1-18` — the ONLY better-auth mount point; both
  `loader`/`action` forward the raw `Request` to `getAuth().handler(request)`. Better-auth
  enforces its own Origin/trustedOrigins check here — the app's CSRF layer applies to
  Viberr's OWN mutating actions, not this splat.

### Session handling
- **File**: `app/server/auth/require-user.server.ts:61-223`
  (`authenticateWithHeaders`) — captures the `Set-Cookie` renewal header better-auth emits
  when a rolling session slides past `updateAge`, forwarded via the root loader
  (`app/root.tsx:76-79`). Session cookie `viberr.session_token`; 30-day rolling expiry, 1-day
  slide. A pending forced password reset redirects everything to `/login` except the reset
  action + logout.

### CSRF
- **File**: `app/server/auth/csrf.server.ts:1-146` — two layers: (1)
  `assertTrustedOrigin` (:62-99) fails closed if `Sec-Fetch-Site`/`Origin`/`Referer`
  disagree with same-origin, AND fails closed if none of the three headers are present at
  all; (2) `assertCsrf`/`assertCsrfWithSecret` (:101-145) — a double-submit token,
  `HMAC-SHA256(secret, "viberr-csrf:" + sessionId)`, checked via `timingSafeEqual` against
  an `X-Csrf-Token` header or a `_csrf` form field. Every mutating form renders
  `<CsrfInput />` (`app/ui/csrf-input.tsx`).

### Org users/roles — separate from project roles
- **File**: `app/server/org/org-users.server.ts:1-601` — TWO org-level roles only:
  `member`/`admin` (`ROLE_ORDER` in `require-user.server.ts:174-177`). Whitelisting: GitHub
  handle, Google account, or local account with a forced-reset temp password.
  `deleteOrgUser` (:403-447) refuses to remove the last active admin, cascades into
  `pruneUserFromProjects`. Org role = instance-wide account access; project role (§6) =
  per-project delegated authority — a separate 4-tier hierarchy stored in `project.md`.

### Org settings aggregate view
- **File**: `app/server/org/org-view.server.ts:1-190` (`getOrgSettingsView`) — assembles
  the entire `/org/settings` loader payload: connections, users, domains, KBs, MCPs,
  skills, global agent profiles, `projectGrants` (usage counts for honest delete-confirms),
  `authProviders`, instance storage health.

### Org seed
- **File**: `app/server/org/org-seed.server.ts` — additive, non-destructive: real KB/skill
  folders + the `@viberr.dev` Google domain allowlist row. Deliberately seeds **no** MCP
  servers and no GitHub connection ("honest empty slate").

### Notifications
- **File**: `app/shared/mapping/notification.server.ts:17-24` (5 kinds: `packet`,
  `approval`, `mention`, `quality`, `policy`); `app/server/projections/
  notifications.server.ts:1-415`. `createNotification` (:54-95) is the single insert
  funnel every creation path uses (task watcher fan-out, @mention fan-out, GitHub
  reconciler, seed), checking the recipient's per-kind routing preference (opt-out model,
  default ON). Delivery is **in-app only** — no email/push found. `countUnreadNotifications`
  excludes rows pointing at a deleted project (ruling F18-1).

### @mention notification system
- **File**: `app/server/tasks/mention-notify.server.ts:1-254`
  (`fanOutMentions`/`notifyMentionedUsers`) — shared by every comment writer (human, agent,
  operator — NEW-4 convention). `resolveMentionTargets` (:91-126) uses a 3-tier priority
  ladder; an ambiguous handle (matches >1 candidate) notifies nobody rather than guessing,
  and `withAmbiguityDisclosure` (:178-185) appends a visible non-delivery note so it's never
  silent. `RESERVED_HANDLES` (`agent`, `operator`, `codex`, `claude`) never route to a
  person.

### Audit — recording
- **File**: `app/server/audit/audit-recorder.server.ts:1-89` (`recordAudit`) — inserts
  into `audit_events`; `action` is a lowercase dot-separated fact string; `details` must be
  secret-free by convention. Recording failures are logged and swallowed — never break the
  triggering action.

### Audit — reads
- **File**: `app/server/audit/audit-query.server.ts:1-97` — e.g.
  `latestTaskReconcileCheckAt` derives the honest "last GitHub sync check" from per-tick
  reconcile audit rows (written unconditionally, even when nothing changed) — replacing an
  earlier reading that conflated "last change" with "last check" (ruling F19-22).

### 90-day audit retention (FR33) — boot-triggered, confirmed
- **File**: `app/server/db/retention.server.ts:1-109` (`applyRetention`) — deletes
  `run_log_lines` older than **30 days** (`RUN_LOG_RETENTION_DAYS`), `audit_events` older
  than **90 days** (`AUDIT_RETENTION_DAYS`) EXCEPT rows in `IDEMPOTENCY_AUDIT_ACTIONS`
  (`task.agent.replied`, `runtime.operator.plan_executed` — these double as boot-recovery
  idempotency keys), and caps `notifications` at the newest 500 rows per user.
- **Triggered**: `app/server/boot.server.ts:360` calls `runMaintenancePass(db, {reason:
  "boot"})` on every boot, AND `app/server/ops/maintenance.server.ts` runs it again on a
  periodic 6-hour interval (`DEFAULT_MAINTENANCE_INTERVAL_MS`) and on disk-pressure ticks
  via `startMaintenanceScheduler` (`boot.server.ts:366`) — not boot-only.
- **Invariant**: canonical Markdown task files are NEVER touched by retention — only
  rebuildable SQLite projection/log tables are compacted. Task-scoped history survives
  indefinitely in `task.md`; org/auth-scoped events (audit, run logs, notifications) have
  no file counterpart and are genuinely gone past their window.

### Secrets handling (NFR7)
- **Files**: `app/server/secrets/secret-box.server.ts` (AES-256-GCM at rest, format
  `v1$<iv>$<ciphertext>$<tag>`, keyed from `VIBERR_SECRET_ENCRYPTION_KEY`);
  `key-rotation.server.ts` (lazy re-seal under a new key); `pat-store.server.ts`
  (user-provided GitHub PATs, only `getPatToken` ever decrypts); `pat-validator.server.ts`
  (validates PAT scopes against GitHub); `git-output-redact.server.ts` (scrubs git's own
  stderr/stdout of credential values before they reach a human-visible surface).
- **Two-sided hygiene**: input-side, `filteredSpawnEnv` strips every credential-shaped env
  var from both backend spawn environments before re-adding only the one selected
  credential a run needs. Output-side, `app/server/runtimes/run-sink.server.ts:96-130` is
  the single choke point every emitted run-log line passes through, redacting exact
  credential values + known token patterns before persistence/display — "the one concrete
  leak path NFR7 forbids."

---

## 11. Test / build / lint / container / seed

### Vitest
- **File**: `vitest.config.ts:1-23` — `environment: "node"`; `setupFiles`:
  `test-support/setup-env.ts` (seeds deterministic session/encryption secrets, blanks
  every credential-detection env var so `isBackendAvailable` reports false under test,
  points `CLAUDE_CONFIG_DIR`/`CODEX_HOME` at a fresh temp dir, sets
  `GIT_ALLOW_PROTOCOL=file` so an accidental clone fails offline instantly) and
  `test-support/setup-dom.ts` (jsdom `<dialog>` shim). `include: ["app/**/*.test.{ts,tsx}"]`
  — **271 test files** as of this pass.
- **Hermetic data root**: `test-support/test-db.ts:24-49` (`createTestDbContext`) creates a
  fresh `mkdtempSync` dir + migrated `DatabaseSync` per test, `rmSync`'d in cleanup — unit
  tests don't rely on `VIBERR_DATA_ROOT` directly.

### TypeScript
- **File**: `tsconfig.json:1-36` — `target: "ES2025"`, `module: "ESNext"`,
  `moduleResolution: "bundler"`, path alias `~/* → ./app/*`, `strict: true`,
  `noUnusedLocals`/`noUnusedParameters`, `verbatimModuleSyntax: true`,
  `erasableSyntaxOnly: true`, `noEmit: true`. `npm run typecheck` = `react-router typegen &&
  tsc` (route types generated first, feeding `.react-router/types`).

### oxlint — code-shape rules only (NOT the copy-ban)
- **File**: `.oxlintrc.json:1-39` — loads one custom plugin, `anti-slop`
  (`tools/oxlint/anti-slop/index.ts`), 14 rules as `"error"` (e.g.
  `no-chained-type-assertions`, `no-module-mocking`, `no-unknown-returns`,
  `require-safety-comment-for-type-assertion`) — all *code-shape* correctness rules (type
  assertions, reflection, mocking hygiene). **None of these is the "govern*" copy-ban
  rule.** `npm run lint` = `oxlint`, a required CI gate since ruling R21-3 (2026-08-19) —
  "must exit 0, no suppression list."

### The "govern*" copy-ban — a Vitest test, not an oxlint rule
- **File**: `app/features/copy-ban.test.ts:1-1032` — bans the word family
  `\bgovern(ance|ed|or|ors|ing|s)?\b` (line 142) from every human-read surface: the JSX
  render layer (`app/features`, `app/routes`, `app/ui`, root/entry files, `app.css`), pure
  TS string literals (`app/server`, `app/schemas`, `app/shared`, `app/lib`, `routes.ts` —
  via a hand-rolled lexer separating strings from regex/comments), and the seeded agent
  `.md` assets. A coverage-completeness assertion (:678-712) proves every top-level entry
  under `app/` is claimed by one of the scans. A second gate (:916-978) bans em/en dashes
  (only U+2013/U+2014 — the middle-dot `·` is fine) from the same surfaces. A third
  (:980-1031) bans the retired "primary specialist" vocabulary.

### e2e — Playwright
- **File**: `playwright.config.ts:1-55` — requires `VIBERR_E2E_BASE_URL`; exactly TWO
  projects: `setup` (logs in once via the real `/login` UI) and `chromium` (depends on
  setup). `fullyParallel: false`, `workers: 1`. **Only chromium runs** — `docs/
  testing.md:51-59` states Safari/Firefox (named in the PRD's browser matrix) have never
  been run here, automated or manual; `.github/workflows/ci.yml`'s e2e job installs
  `chromium` only.
- **Specs**: `e2e/01-home-board.spec.ts` through `07-accessibility.spec.ts` (the latter uses
  `@axe-core/playwright`), plus `auth.setup.ts`.
- **File**: `compose.e2e.yml` + `scripts/e2e.ts` — an isolated Compose stack (project name
  `viberr-e2e`, named volume `e2e-data`) with a one-shot `seed` service
  (`npm run seed:demo`) gating the `app` service; never touches the main `compose.yml`,
  `.env`, or `./docker-data`.

### CI
- **File**: `.github/workflows/ci.yml:1-51` — two jobs: `verify` (`npm ci` → lint →
  typecheck → test → build) and `e2e` (`npm ci` → install chromium → `npm run e2e`).

### Container
- **File**: `Dockerfile:1-144` — three stages: `prod-deps` (keyed only on the lockfile, so
  it cache-hits on ordinary source edits), `build` (full tree, `npm run build`), runtime
  (`node:26-slim` + `git`/`ca-certificates`/`chromium`/`fonts-liberation`/`uv`/`uvx`).
  `VIBERR_DATA_ROOT=/data`; entrypoint execs Node directly as PID 1 (not via `npm run
  start`) so `SIGTERM` reaches Node directly for clean WAL checkpoint + writer-lock
  release.
- **File**: `compose.yml:1-72` — one `app` service, `hostname: viberr` (stable identity so
  a recreated container can reclaim its predecessor's writer lock, B-FD1), `init: true`
  (reaps orphaned zombies), forces `NODE_ENV=production`/`VIBERR_DATA_ROOT=/data`. **`volumes:
  - ./docker-data:/data`** — the host-bind-mounted `docker-data` directory is the canonical
  shared data root (confirms the "docker-data dual-writer hazard" from project memory: only
  ONE process — container OR a host dev server, never both — may hold this root's writer
  lock, enforced structurally by `app/server/db/cli-lock.server.ts`, not just convention).

### Seed
- **File**: `app/server/seed/seed.server.ts:29-54,127-210` (`runSeed`) — the **product**
  seed: clean sheet, no demo/mock board data. Creates the bootstrap admin only on an empty
  users table (`admin@viberr.dev` default), writes the built-in agent catalog
  (`agent-catalog.server.ts`) as org profile templates, runs `rebuildAll()`. `resetStore()`
  wipes `projects/`/profiles/derived tables but never touches `users`/auth or credential
  directories.
- **Entry points**: `scripts/seed.ts` (`npm run seed`, product) vs `scripts/seed-demo.ts`
  (`npm run seed:demo`, test/dev-only — dynamically imports `test-support/demo-seed.ts` +
  `demo-data.ts`, so a production image lacking `test-support/` fails loudly rather than
  cryptically). Both take the data-root writer lock first.

### `app/app.css.test.ts` — the stylesheet integrity gate
- **File**: `app/app.css.test.ts:1-2503` — statically gates `app/app.css` (4,502 lines) the
  way `tsc` gates TypeScript: every `var(--x)` resolves to a declared custom property
  (:110-153); every `className` literal/expression used anywhere under `app/` has a
  matching CSS rule, including runtime-completed prefixes (:514-704, an anti-rot guard
  asserts `files.length > 150` and `used.size > 500`); WCAG contrast ratios for secondary
  text and CTA colors in both themes (:426-512); one consolidated `:focus-visible` rule
  (:177-253); breakpoint hygiene (:781-886). **Icon-name validity is a TypeScript-level
  invariant, not a Vitest one** — `app/ui/icon.tsx` types `IconName = keyof typeof
  ICON_PATHS`, so `tsc` itself rejects an unknown icon name.
- **Invariant**: escape-hatch allowlists (`CLASSLESS_BY_DESIGN` etc.) are deliberately
  near-empty with a hard cap and required justification string — "no silent allowlist
  growth."

### Design tokens
- **File**: `app/app.css:8,10,29` (light `:root`) / `:2617,2619,2632` (`:root[data-theme=
  "dark"]`) — confirms the unprefixed token convention: `--bg`, `--fg`, `--blue`, etc., no
  `--viberr-*` prefix. One stylesheet, no Tailwind.

---

## Corrections to working assumptions (recorded so a later pass doesn't re-trip on them)

- **`delivery-decision.server.ts` / `delivery-actionable.server.ts` /
  `delivery-requeue.server.ts` / `delivery-push-grant.server.ts` do not exist** as
  implementation files — only their `*.server.test.ts` counterparts under
  `app/server/tasks/`. The behavior lives in `task-actions.server.ts` (`performDelivery`,
  `resolveDeliveryPushGrant`, `recordDeliveredNextStep`) and `operator-actions.server.ts`
  (`operatorDeliverForReview`, `deliverGate`).
- **`git-clone-auth.server.ts` lives under `app/server/tasks/`, not
  `app/server/github/`.**
- **`pr-divergence-operator.server.ts` does not exist** as an implementation file — the
  PR-divergence/operator-wake behavior lives inside `github-reconciler.server.ts`.
- **The oxlint `anti-slop` plugin (`.oxlintrc.json`) is code-shape/type-hygiene rules
  only** (no chained assertions, no module mocking, etc.) — it is NOT the "govern*"
  copy-ban. That ban is a separate Vitest suite, `app/features/copy-ban.test.ts`, run by
  `npm test`, not `npm run lint`.
- **There is no "reviewer" project role.** The four project roles are `admin`,
  `maintainer`, `contributor`, `viewer` (`app/schemas/project-file.schema.ts:23`); the
  historical `reviewer` name was renamed to `contributor`.
- **`app/features/agents/agents-query.server.ts` is a `.server.ts` file living inside
  `app/features/`** — the boundary that matters is the `.server.ts` suffix, not the
  directory; this is where `effectiveProfileView` lives, not under `app/server/`.
