# ARCHITECTURE — Viberr current state (pass 22 revision)

## Pass-22 revision (2026-08-21)

> **Revised 2026-08-21 against `main @26fca45`.** The body below was originally
> verified at `ce2bc9e` — the **pass-21 DISCOVERY baseline** — so the unrevised
> copy predated BOTH pass 21's own merge (PR #175, `d1bc4a2`: 26 commits,
> rulings 84-90, findings F21-1..F21-24) and the ten single-topic PRs #176-#186
> that followed it. Every section those changes touch was re-verified at
> `26fca45` and corrected in place. Anchors in sections marked *unchanged* still
> date to `ce2bc9e`; the modules reworked hardest since then are
> `task-actions.server.ts` (+892 lines), `operator-run.server.ts` (+392),
> `run-service.server.ts` (+379), `specialist-run.server.ts` (+288),
> `pr-open.server.ts` (+253) and `activity-feed.server.ts` (+409) — treat any
> remaining anchor into those with suspicion.

What landed since the original text, in order:

**Pass 21's own merge (PR #175 — the unrevised doc had none of it):**

- **F21-1** — the `task_projections.validation` CHECK was **widened** to include
  `bypassed` (the "live inconsistency" warning the pass-21 doc carried is
  FIXED), a structural CHECK-vs-enum pin test was added
  (`app/server/db/projection-validation-check.test.ts`), and boot now WARNS on
  projection-schema drift: `projectionValidationGaps` (`boot.server.ts:154`) and
  `projectionMissingColumns` (:192) report through `logBootIntegrity` (:236) —
  necessary because the squashed baseline reaches only FRESH data roots (§2, §6).
- **Ruling 88 (R21-5 / F21-2)** — an acceptance is valid only WITH the
  disclosure the human was shown: a server-side acknowledgment echo
  (`app/shared/acceptance-disclosure.ts`, new) guards every human acceptance
  door, and `task_projections.work_revision_sha` (`0001_baseline.sql:143`) was
  added so the board's ceremony can disclose the delivered revision from the row
  alone (§10a).
- **R21-4 (ruling 87)** — task workspaces clone through a **per-project git
  mirror** (`app/server/tasks/repo-mirror.server.ts`, new) and the pre-run
  "preparing workspace" phase is live-visible (`onPhase` on the adapter
  interface, driven for real); `operator-repo-read.server.ts` (new) gives the
  operator main-anchored default-branch reads (F21-21) (§10a).
- **Band-1 GitHub truth** — F21-9 (the github client's "never throws" contract
  restored + PR-open salvage + per-task reconcile boundary), F21-7
  (unknown-bucket check-runs), F21-8 (tolerant commit lists), F21-11 (per-field
  PAT tolerance), F21-17 (drift carry-forward on settled PRs), F21-5 (viewer
  credential visibility, `features/github/credential-visibility.server.ts`, new).
- Timeline events gained an optional **`attachments`** name list (which files a
  run saved into the task's `attachments/` dir), projected as
  `task_events.attachments_json` (`0001_baseline.sql:183`) (§8c).
- **R21-3 (ruling 86)** — oxlint + the anti-slop plugin is ADOPTED: `npm run
  lint` is a required CI gate ("no linter by decision" is retired).
- **R20-9 promoted (ruling 84)** — a packet the operator raises after consulting
  an agent mechanically APPENDS the on-whose-behalf disclosure at packet-open.
- OBS-6 — the SSE client stops reconnecting on a deliberate 401 (expired
  session) instead of hammering (§5); U8 — insecure auth-origin boot warning.
- The humanizer sweep (`3efe55e`) reworded rendered copy tree-wide — another
  behavior-preserving, anchor-moving rewrite (mostly em-dash removal).

**PRs #176-#186 (post-pass-21, 2026-08-20/21):**

- **#176 browser-implies-egress** — granting `use-browser` now REPAIRS
  `use-web-search-fetch` to `direct` at the save layer
  (`repairBrowserEgressGrants` / `applyGrantCouplings`,
  `app/shared/capabilities.ts:475` / `:510`); the runtime mount interlock stays
  as the backstop for hand-edited files (§8a-8b).
- **#177 / #179 / #184 attachments** — the attachments dir now has **two
  writer classes** (the browser's `--output-dir` and the agent "attachments
  drop"); agents are TOLD the drop exists (persona section + the workspace
  contract's one named exception); Codex `workspace-write` sandboxes add the dir
  as an additional writable directory (`RunSpec.attachmentsWritableDir`);
  attachments render on the producing comment with markdown link repair; images
  open an in-app lightbox (§8c, §8e).
- **#180 / #182 packet redesign** — decision-packet density + one-quiet-column
  visual redesign (CSS + `decision-packet.tsx` only; no data-model change).
- **#181 R21-8 (ruling 91)** — `input_required` YIELDS to "agent working" on
  every surface while `waiting === "agent"`; display-only, stored readiness
  untouched; `blocked`/`inconsistency_risk_detected` never yield.
- **#183 live-agent-backend** — engaged agents DISPLAY the backend a run would
  actually use: the live deployment overlays the engage-time snapshot in every
  read model (`withLiveAgentBackends`, `app/shared/mapping/task.server.ts:369`;
  `deployedSpecialistBackends` / `primaryRunBackend`,
  `features/agents/agents-query.server.ts:408` / `:383`).
- **#185 R21-9 (ruling 92)** — the claude backend's display label is **"Claude"**
  (not "Claude Code") everywhere (`agentBackendName`,
  `app/server/files/actor-ref.server.ts:122`), and the operator run control
  SHOWS the profile-configured backend/autonomy instead of picking per run, with
  an optional steer that rides the `@operator` mention machinery (§14).
- **#186 owner-cell-no-manage** — the owned task's owner cell is display-only
  (`execution-profile.tsx` simplification; UI only).

Headline metric corrections applied in place: `db/migrations/0001_baseline.sql`
is **505** lines (the pass-21 text said 482), `app/shared/capabilities.ts`
**556** (was 473), `app/schemas/task-file.schema.ts` **1437** (was 1394),
`app/app.css` **4455** (was 4262); dir counts `features/` **179**, `server/`
**305**, `shared/` **32**, `tasks/` **57**, `projections/` **27**.

---

> **Verified 2026-08-19 against `main @ce2bc9e`** (worktree branch
> `claude/viberr-app-inspection-1fe423`, identical to main). Every anchor below
> was re-read at that commit, **except where the pass-22 revision above
> re-verified it at `26fca45`** — those corrections are edited into the body.

**Read this before trusting the pass-20 copy.** The pass-20 doc
(`planning/discovery-2026-08-14-pass20/reference/ARCHITECTURE.md`) was pinned to
`main @b97ad02` — the **discovery baseline of pass 20, before pass 20's own work
landed**. Pass 20 merged as **PR #169** (`6c94f2c`) with 12 pass-20 commits, and
two anti-slop lint commits followed (`54ffab8` installs the `dmmulroy/anti-slop`
oxlint plugin, `ce2bc9e` fixes 2,843 → 26 findings and touched files across the
tree). So the pass-20 doc predates every pass-20 mechanism it is named after:
the crash-visibility handlers, the `procStartedAt` lock reclaim (F20-8), the
action watchdog (F20-1), the any-length credential scrub (F20-7), the
`model_availability` store (R20-3), the `discard_branch` packet (R20-2), the
heuristic MCP warm-up (R20-4). All are below, and a "Corrections vs pass-20 doc"
list closes the file.

Viberr is a governed-AI-delivery web app: **React Router 8** (framework mode,
loaders/actions, single-fetch) over a **file-native store** (markdown/frontmatter
files are canonical) projected into a **rebuildable SQLite read-model**, with
**better-auth** for sessions, an **SSE bus** for live updates, and a
**single-writer data-root lock**. Node 26 (`package.json` `engines.node: ">=26"`),
Vite 8, TypeScript 7, React 19, `@playwright/mcp` 0.0.79 as a *production*
dependency. `package.json` version `0.19.0`.

---

## 1. Layering

> Verified 2026-08-19 against the `app/` tree at `ce2bc9e`.

```
routes/  →  features/  →  server/  →  shared/ + schemas/
(loaders/    (UI slices +   (all server-    (isomorphic helpers +
 actions)     query.server)   only logic)     Zod file schemas)
```

Routes are thin: a loader/action calls a `server/` function and renders a
`features/` component. `server/*.server.ts` is server-only (never bundled to the
client). `shared/` is isomorphic (client+server safe). `schemas/` holds the Zod
schemas + tolerant parsers for the canonical files.

> The server-only boundary is load-bearing **and the production build enforces
> it**. R19-16 hit it: importing `AUTH_BASE_PATH` from `lib/auth.server` into a
> route pulled a server-only module into the browser bundle and broke the build.
> The constant lives in **`app/shared/auth/auth-paths.ts`**; `lib/auth.server.ts`
> re-exports it so every server importer is unchanged. **Any constant a client
> component needs belongs in `shared/`, not in a `.server` module.**

### Directory map (`app/`)

File counts (`git ls-tree -r --name-only HEAD app/<dir> | wc -l` at `26fca45`):
`routes/` **43**, `features/` **179**, `server/` **305**, `shared/` **32**,
`schemas/` 7, `lib/` 2, `ui/` **32**.
(Pass 21 discovery recorded 43 / 177 / 299 / 31 / 7 / 2 / 32; pass 20 recorded
42 / 176 / 293 / 31 / 7 / 2 / 31. The `shared/` addition is
`acceptance-disclosure.ts` — ruling 88; `features/` gained
`task-detail/attachment-lightbox.tsx` and `github/credential-visibility.server.ts`.)

| Dir | Purpose |
| --- | --- |
| `routes/` | RR8 route modules; the route table is `app/routes.ts` (**69** lines, was 59). |
| `features/` | One dir per surface: activity, agents, board, github, home, kb-browser, live-updates, notifications, org-settings, policy, profile, project-settings, review, runtime, shell, task-detail. Three suite-level guards sit at the top level: `copy-ban.test.ts` (F18-14 — banned words in rendered copy), `retired-vocabulary.test.tsx`, and **`toast-honesty.test.ts`** (new, D5). |
| `server/` | All server-only logic (subdirs below). |
| `shared/` | `capabilities.ts`, `rbac.ts`, `freshness.ts`, **`acceptance-disclosure.ts`** (ruling 88 — the acceptance acknowledgment echo, §10a), `auth/auth-paths.ts` + `auth/password-policy.ts`, `dates/`, `ids/`, `mapping/`, `text/`, `workflow/`, and `docs/prd-sync.test.ts` + `docs/file-formats-sync.test.ts` (pin `design/prd.md` and `docs/architecture/file-formats.md` to canon — ruling 27 / N19-3). |
| `schemas/` | `task-file.schema.ts`, `project-file.schema.ts`, `sse-event.schema.ts`, `github-pat.schema.ts`, `file-diagnostics.ts` (+2 tests). |
| `lib/` | `auth.server.ts` — the better-auth instance factory (+ its test). |
| `ui/` | Presentational primitives + hooks. New in pass 20: **`confirm-dialog.tsx`** (the shared confirmation ceremony, D6/C6). |

`app/server/` subdirs (counts at `26fca45`, key files):

- **`actions/` (1) — NEW, absent from pass 20**: `action-watchdog.server.ts`
  (F20-1, §12).
- **`tasks/` (57, was 53)** — task lifecycle domain: `task-actions.server.ts`,
  `task-mutation.server.ts` (the cycle break), `operator-actions.server.ts`,
  `operator-toolkit.server.ts`, `agent-toolkit.server.ts`,
  `specialist-run.server.ts`, `specialist-mcp.server.ts`,
  `specialist-browser-mcp.server.ts` (§8), `specialist-tool-policy.ts`,
  `no-change-completion.server.ts`, `schedule.server.ts`,
  `comment-guardrails.server.ts`, `mention-notify.server.ts`,
  `timeline-compaction.server.ts`, `workspace-retention.server.ts`,
  `model-prose.server.ts`, and — **new in pass 21 (R21-4)** —
  **`repo-mirror.server.ts`** (the per-project mirror/reference clone cache) and
  **`operator-repo-read.server.ts`** (main-anchored default-branch reads for the
  operator, F21-21).
- **`runtimes/` (35, was 33)** — agent adapters + run pipeline:
  `claude-runtime`, `codex-runtime`, `operator-run`, `run-service`, `run-store`,
  `run-events`, `run-sink`, `run-recovery`, `run-projection`, `session-export`,
  `model-catalog`, `{claude,codex}-config`, `runtime-registry`, `wire-format`,
  `skill-mount.server.ts` (R18-5 — the ONLY writer of a run workspace's
  `.claude`), and **`model-availability.server.ts`** (R20-3, §13).
- **`projections/` (27)** — files→SQLite read-model: `rebuilder.server.ts`,
  `rebuild.server.ts` (drop+rebuild), `rescan.server.ts`,
  `single-flight.server.ts`, `task-query`, `board-query`, `task-activity`,
  and per-surface (activity-feed, notifications, decisions, review-queue,
  policy-violations, agent-deployments).
- **`github/` (29)** — `github-client`, `github-context`, `github-reconciler`,
  `reconcile-poller`, `pr-open`, `pr-linker`, `pr-adoption`,
  `pr-human-approval` (R19-B), `push-workspace`, `workspace-delivery`,
  `branch-sync`, `branch-cleanup`, `update-branch{,-operator}`,
  `repo-access-check`, `scope-flag` (§10).
- **`interpretation/` (5)** — the ONLY place readiness/diagnostics/freshness are
  derived: `readiness-policy`, `diagnostics-policy`, `freshness-policy`.
- **`db/` (14)** — SQLite lifecycle: `sqlite.server.ts` (`getDb` **:82**,
  `shutdownDatabase` **:133** — moved in pass 21), `migration-runner.server.ts`
  (`runMigrations` :28), `data-root-lock.server.ts` (§7), `cli-lock.server.ts`
  (§7a), `backup.server.ts` (`createBackup` :177 / `restoreBackup` :442),
  `retention.server.ts`, `transaction.server.ts`, and the F21-1 pin
  `projection-validation-check.test.ts` (the CHECK-vs-enum structural test).
- **`events/` (5)** — `sse-broker.server.ts`, `event-publisher.server.ts`,
  `projection-events.server.ts` (§5).
- **`files/` (30, was 29)** — `file-store-root.server.ts` (path helpers, §2),
  `task-file`/`project-file` (read), `task-writer`/`project-writer` (write),
  `atomic-file.server.ts` (+ a new test), `frontmatter`, `file-mutex`,
  `file-watch.service.server.ts`, `kb-watch.service.server.ts`, `kb-injection`,
  `skill-body`, `agent-profile-file`, `store-check.server.ts`,
  `task-attachments.server.ts` (§8c).
- **`auth/` (27)** — `require-user`, `require-project`, `project-authority`,
  `seed-admin`, `identity`, `password`, `login`, `oauth-provision`,
  `oauth-providers.server.ts` + `oauth-credential-test.server.ts` (R19-16, §4a),
  `csrf`, `rate-limit`, `user-store`, `user-admin`.
- **`org/` (19)** — `resources.server.ts` (KB reindex + the MCP registry, §9),
  `mcp-warmup.server.ts` (R19-18 + R20-4, §9), `store-files.server.ts`,
  `connections`, `org-users`, `org-seed`, `org-view`, `resource-catalog`.
- **`ops/` (8)** — `build-info`, `disk-space`, `maintenance`,
  `transcript-retention` (§11).
- **`secrets/` (10)** — `pat-store`, `pat-validator`, `secret-box` (AES-256-GCM),
  `key-rotation.server.ts` (the sealed-store registry), and
  `git-output-redact.server.ts` (`redactGitOutput` **:73**,
  `redactProviderText` **:136** — §9/§13).
- **`config/` (2)** — `env.server.ts` (`getEnv`, validation).
- **`seed/` (18)** — `seed.server.ts`, `default-assets.server.ts`,
  `ensure-base-agents.server.ts`, `agent-catalog.server.ts`, the definition +
  skill markdown assets.
- Others: `prefs/` (2), `provenance/` (3), `audit/` (4), `errors/` (2),
  `logging/` (4), `theme/` (1), and the top-level `boot.server.ts` (+ test).

`app/app.css` is **4455** lines (pass-21 discovery: 4262; pass 20: 4218) — one
stylesheet, gated by `app/app.css.test.ts` (class-coverage + both-theme
contrast, **no allowlist**). The packet redesign PRs #180/#182 and the
attachment thumbnails/lightbox account for most of the growth.

### Route table (`app/routes.ts`, 69 lines)

One structural change in pass 20: **`routes/palette-shell.tsx`** (new, F20-30) is
a **pathless layout** wrapping `org/settings`, `profile` and `notifications`
(**:21-26**). Those three render OUTSIDE the workspace layout, so the ⌘K palette
— which Home calls "one shortcut app-wide" — never reached them. The layout
keeps their URLs unchanged and mounts only the shortcut + palette; Home and the
workspace mount it themselves, so nothing double-registers.

Everything else: `index` → home, `login`/`logout`, the better-auth splat
`api/auth/*` (:11), the resource routes (`notifications/read`, `prefs/theme`,
`resources/events`, `resources/run-log`, `resources/health`, `resources/search`,
`resources/model-catalog`, `resources/session-export`), the attachment route
(**:49-53**, outside the workspace layout because it serves raw bytes), and the
workspace shell `projects/:slug` with its eight children
(index/board/review/agents/policy/github/activity/settings + `tasks/:key`).

---

## 2. File-native store + SQLite projection model

> Verified 2026-08-19 against `app/server/files/file-store-root.server.ts`,
> `app/server/projections/{rebuilder,rebuild,rescan,single-flight}.server.ts`,
> `app/server/files/{file-watch,kb-watch}.service.server.ts`.

**Files are canonical; SQLite is a derived, per-table-rebuildable read-model.**
Store layout + path helpers: `file-store-root.server.ts` (layout doc **:5-23**,
`DATA_ROOT_SUBDIRS` **:26-39**). Helpers: `getDataRoot` (:43),
`ensureDataRootDirs` (:48), `projectsDir` (:56), `projectDir` (:60),
`projectFilePath` (:64) → `projects/<slug>/project.md`, `taskDir` (:68),
`taskFilePath` (:72) → `projects/<slug>/tasks/<KEY>/task.md`,
**`taskAttachmentsDir` (:87)** → `projects/<slug>/tasks/<KEY>/attachments/`,
`agentProfilesDir` (:95), `agentProfileFilePath` (:106),
**`resolveStoreSegment` (:126 — the traversal guard)**, `kbRootDir` (:148),
`kbDirPath` (:153), `skillsRootDir` (:158), `skillDirPath` (:163),
`storeRelativePath` (:172).

### Data-root layout (`DATA_ROOT_SUBDIRS`, `:26-39`)

```
${VIBERR_DATA_ROOT}/
  projects/<slug>/project.md
  projects/<slug>/tasks/<KEY>/task.md
  projects/<slug>/tasks/<KEY>/attachments/   ← R19-19, browser output (§8c)
  agents/
  agents/profiles/<id>.md                    ← org-level agent profile templates
  runtimes/                                  ← NDJSON run logs
  runtimes/claude-home/                      ← CLAUDE_CONFIG_DIR under compose
  runtimes/codex-home/                       ← CODEX_HOME under compose
  runtimes/uv-cache/  runtimes/uv-python/    ← set by the image, not in the list
  kb/<dir>/                                  ← knowledge bases (store://kb/<dir>/)
  skills/<name>/SKILL.md                     ← skills (store://skills/<name>/)
  state/projection.sqlite                    ← the read-model
  state/writer.lock                          ← the single-writer lock (§7)
```

UI copy renders REAL store-relative paths (`projects/viberr-core/tasks/VIB-142/task.md`).

### Projection rebuild (`projections/rebuilder.server.ts`)

`rebuildProjectFile` **:150**, `rebuildTaskFile` **:348**, `rebuildPath`
**:669** (the watcher + mutation entry point), `rebuildProject` **:709**,
`rebuildAll` **:793** (full rescan + prune vanished rows). Content-hash
short-circuit at **:184** (project) and **:393** (task).

Two derivations feed the row and must not contradict each other:
`derivedValidation = deriveValidation(fm)` (**:410**, with the UX19-3 rationale
just above — the column used to carry the file's `validation` CACHE while the
gate one argument away re-derived it) and `deriveReadiness` (**:459**), writing
both `readiness` (derived) and `stored_readiness` (raw). The single UPSERT
starts at **:494** — column list :496-498, `ON CONFLICT` at :503+ (`acceptance`
and `continuity` updates at :510-511, `work_revision_sha` at :518). Columns from
pass 20: `acceptance` (bound from `fm.acceptance ?? null`) and `continuity`
(derived at **:487-489** from
`parsed.timeline.some(e => e.type === "continuity")`). **New in pass 21**:
`work_revision_sha` (ruling 88 — the delivered revision's head sha, so the
board's acceptance ceremony can disclose what it accepts from the row alone) and
`task_events.attachments_json` (bound in the event insert at **:590** — the
names of files an event's run saved into the task's `attachments/` dir, §8c).

**Per-table drop+rebuild** (`projections/rebuild.server.ts`):
`rebuildProjections` (**:35**) DELETEs the derived tables (`task_events`,
`diagnostics`, `task_projections`, `projects`; `project_members` cascades,
:41-44) then `rebuildAll(force)`, all in one transaction with events buffered
until commit. It explicitly PRESERVES the non-projection SQLite tables (users,
sessions, notifications, audit, provenance, PATs, agent_runs, org resources).

**Everyday reconcile**: `rescanProjections` / `rescanProject`
(`rescan.server.ts:15,38`), throttled by `single-flight.server.ts`
(`RESCAN_MIN_INTERVAL_MS = 10 s` :39, `REBUILD_MIN_INTERVAL_MS = 30 s` :40,
`runSingleFlight` :51, `throttledMessage` :69).

**Watchers (chokidar 5)**: `file-watch.service.server.ts` (`startFileWatcher`
**:132**, `WATCH_DEBOUNCE_MS = 250` :33, `stopFileWatcher` :341; keeps only
`project.md`/`task.md`; an ENOENT from a vanished path is logged, never fatal);
`kb-watch.service.server.ts` (`startKbWatcher` **:72**,
`KB_WATCH_DEBOUNCE_MS = 250` :32 → `reindexKnowledgeBaseByDir`).

**Schema**: `db/migrations/0001_baseline.sql` — still a **single squashed
migration** (**505** lines at `26fca45`), applied by
`migration-runner.server.ts:28`, which records and skips by **FILENAME alone**
(tracking table created at :33). Five schema changes rode the pre-prod squash
convention in pass 20, and pass 21 rode it three more times (the widened
`validation` CHECK, `work_revision_sha`, `task_events.attachments_json`).
**Because the squash reaches only FRESH data roots, boot now warns on drift**
(F21-1): `projectionValidationGaps` + `projectionMissingColumns`
(`boot.server.ts:154` / `:192`) read the deployed DB's real DDL and name, in
`logBootIntegrity`'s one line, any `VALIDATION_VALUES` member the live CHECK
refuses and any `task_projections` column the live table lacks — the two
failure shapes a baseline-only schema change produces on an existing root
(silent per-task "projection rebuild failed" / "no such column" on every task).
See DOMAIN-MODEL.md §5 for the full table inventory and the task→row mapping.

---

## 3. Readiness / interpretation policy

> Verified 2026-08-19 against `app/server/interpretation/`.

*(Unchanged since pass 20 — re-verified line by line.)*

Derivation is confined to `app/server/interpretation/`. The **canonical readiness
enum** (4 values) is defined in `schemas/task-file.schema.ts:25-31`; `"accepted"`
is a derived display state.

- `deriveReadiness(input)` (`readiness-policy.server.ts:36`) — stored readiness
  is respected unless diagnostics impose a WORSE floor; derivation never
  improves readiness. `isAcceptedDisplayState` (:55).
- `diagnostics-policy.server.ts` — severity→floor: warning→`input_required`,
  error→`inconsistency_risk_detected`, hardStop→`blocked`; `READINESS_RANK`
  (:20), `readinessEffectOf` (:28), `worstReadinessEffect` (:41),
  `referenceDiagnostics` (unknown-stage, :58).
- `freshness-policy.server.ts` re-exports `isStale`/`STALE_AFTER_MS` from
  `~/shared/freshness`.

The **goal-interpretation / scoping-packet / triage gate** is the operator flow,
not this dir: `triageQualityGate` lives in
`runtimes/operator-run.server.ts:2797` (blocks Triage→Ready until a vague goal
survives scoping; applied at :2884 and :2953). Ruling 89 (R21-6) keeps this gate
**behavioral**: there is deliberately NO mechanical transition block on open
packets — a human moving a task past an open packet is a deliberate act. See
AGENTS-RUNTIME.md.

---

## 4. better-auth (`app/lib/auth.server.ts` + `app/server/auth/`)

> Verified 2026-08-19 against `app/lib/auth.server.ts` and `app/server/auth/`.

- **Instance**: `buildAuthOptions(deps)` (**:155**), `createAuth` (**:357**),
  cached singleton `getAuth()` (**:385**). `AUTH_BASE_PATH = "/api/auth"` lives
  in `~/shared/auth/auth-paths.ts` and is re-exported here; cookie prefix
  `viberr` → `viberr.session_token`.
- **Session**: rolling 30-day with daily slide (`expiresIn` 30 d **:291**,
  `updateAge` 1 d **:292**); the renewal `Set-Cookie` is captured in
  `require-user.server.ts` (`authenticateWithHeaders`). The canonical `users` row
  and the better-auth `user` row share one id.
- **Splat allow-list**: `ALLOWED_AUTH_PATHS` (**:63**) = sign-in/email,
  sign-in/social, callback/:id, error, get-session, sign-out; the `before` hook
  (**:250**) 404s any other `/api/auth/*` (**:261**). Route: `routes/api.auth.$.ts`.
- **Passwords**: `emailAndPassword` with `disableSignUp: true`,
  `minPasswordLength`, and TOTAL custom hash/verify wired to the app's
  `hashPassword`/`verifyPassword` (**:203**), so a bad legacy hash reads 401 not
  500. Login + social-start rate-limited per email|ip via `rateLimit.customRules`
  inside the same `before` hook.
- **First-login temp password**: `seedInitialAdmin` (`seed-admin.server.ts`)
  creates the first admin with `pwresetRequired` when the password was generated;
  `requireAuth` redirects to `/login` while the flag is set, and the SSE route
  also refuses those sessions.
- **Env-admin bootstrap**: the first `admin` is created when `users` is empty,
  from `VIBERR_SEED_ADMIN_EMAIL/PASSWORD` (default `admin@viberr.dev`), called
  from boot. OAuth whitelist/provisioning hooks live in `databaseHooks`;
  `oauthProviderOf(context)` (**:101**) reads the provider off the running
  endpoint (`/callback/:id`) and **fails closed on null**.

### 4a. In-app OAuth provider configuration (R19-16)

`GITHUB_OAUTH_*` / `GOOGLE_OAUTH_*` env vars are only a **bootstrap default**.
Admins configure sign-in from **Org settings → "Sign-in & SSO"**
(`features/org-settings/sso-panel.tsx`, admin-gated by `routes/org.settings.tsx`).

- **Store**: `app/server/auth/oauth-providers.server.ts` over the
  `oauth_providers` table (`0001_baseline.sql:247-256`).
- **Ruling 1 — the app row OVERRIDES the deployment env**, including when the
  row is configured and DISABLED.
- **Ruling 2 — enabling requires a passing test.** `verified_at` is written only
  by a live provider round-trip and cleared the moment either credential
  changes. The probe is real (`auth/oauth-credential-test.server.ts`
  `testOAuthCredentials`): GitHub `POST /applications/{id}/token` answers 401 for
  a bad pair and 404/422 for a good one; Google's token endpoint answers
  `invalid_client` vs `invalid_grant`.
- **No restart needed.** better-auth reads `socialProviders` once at
  construction, so the singleton cache entry carries a **non-secret
  `providerFingerprint`** (`AuthCacheEntry`, `auth.server.ts:367-371`) beside the
  db handle; `getAuth()` recomputes it via `oauthConfigFingerprint(db)`
  (**:392**) and rebuilds the instance when it moves (**:397**, stored :418).
- **Secrets** are sealed with `secret-box` and the store is registered in
  `secrets/key-rotation.server.ts` `SEALED_STORES` — the key-rotation integrity
  test enforces registration.

---

## 5. SSE bus (`app/server/events/` + `app/features/live-updates/`)

> Verified 2026-08-19 against `app/server/events/`, `app/routes/resources.events.ts`,
> `app/features/live-updates/use-live-updates.ts`.

- **Broker** (`sse-broker.server.ts`): `publishSseEvent(event, route)` (**:322** —
  monotonic id + ring buffer `RING_BUFFER_SIZE = 256` :45 + fan-out). Scopes
  (`SseScope`, **:49**): project / task / projects-firehose / user;
  `parseSseScope` (:62), `routeMatchesConnection` (:88).
  `connectSseClient` (**:250**) sends a `stream.open` hello, replays missed
  events on reconnect via `Last-Event-ID`, and starts an unref'd 25 s heartbeat
  (`HEARTBEAT_INTERVAL_MS` :44, `HEARTBEAT_CHUNK` :175).
- **Publisher bridge** (`event-publisher.server.ts`): `startEventPublisher`
  (**:198**) subscribes the projection emitter → `translateProjectionEvent`
  (**:52**) → `publishSseEvent`. The high-frequency `run.log-appended` bypasses
  the emitter and is published straight to the broker from the run service.
- **Endpoint** (`routes/resources.events.ts`): `loader` (**:63**) serves
  `GET /resources/events` — 401 for unauth/pwreset (**:68**), 400 for a bad
  scope (:85, :98), 403 for a non-member (:136); streaming `text/event-stream`
  with backpressure cap `MAX_QUEUED_CHUNKS = 1024` (**:61**). A non-2xx on an
  `EventSource` **fails the connection permanently** — that is why these are
  deliberate status choices (see the comment at :32-40).
- **Client** (`live-updates/use-live-updates.ts`): `useLiveUpdates(scopes)`
  opens an `EventSource` and **triggers route revalidation** (no optimistic UI),
  300 ms debounced (`REVALIDATE_DEBOUNCE_MS` **:40**), exponential-backoff
  reopen; the topbar shows a "live updates paused — retry" pill. **Changed in
  pass 21 (OBS-6):** a deliberate **401** (expired or pwreset session) now
  STOPS the reconnect loop instead of hammering `/resources/events` every
  backoff step forever — the paused pill stays, and only a session that can
  actually succeed resumes the stream (the module doc at :26-75 explains the
  probe).
- **Shutdown teardown**: `runProcessShutdown()` (**:372-384**) — close SSE
  connections → `stopFileWatcher` → `stopKbWatcher` → **`stopDataRootLockGuard`**
  (so a clean shutdown is never mistaken for a steal) → `shutdownDatabase` →
  `releaseDataRootLock`. `armProcessShutdown()` (**:368**) is the eager boot
  registration — registration used to ride the first publish/connect, so a warm
  store that emitted nothing shut down without releasing the lock.

> **The event vocabulary is a closed typed union routed by user/project/task
> scope.** `ProjectionEvent` (`projection-events.server.ts:11-43`) is **8**
> variants; the wire union `SSE_EVENT_NAMES`
> (`app/schemas/sse-event.schema.ts:22-40`) is **12** (the 8 plus
> `run.log-appended`, `run.state-changed`, `stream.open`, `stream.resync`).
> R19-18 and R20-4 both deliberately did NOT add an event for a transient
> org-settings row state and used a 20 s poll instead (§9) — treat "add a new SSE
> event name" as a real design decision, not plumbing.

---

## 6. Boot sequence (`app/server/boot.server.ts`)

> Re-verified 2026-08-21 against `app/server/boot.server.ts` at `26fca45`
> (pass 21 added ~145 lines — every anchor moved, and `logBootIntegrity` gained
> the F21-1 projection-schema drift fields).

`bootServer()` (**:490**), ordered. **Step 0 is new as of pass 20.**

0. **`installCrashVisibilityHandlers()`** (**:493**, defined **:90**) — **F20-8(a),
   NEW.** *First of all*, so even a failure DURING boot dies loudly. On
   2026-08-14 the process vanished with zero output: `logger.error` is an async
   `process.stdout.write` that the following `process.exit` truncates, so nothing
   durable reached the log. These handlers flush ONE **synchronous** stderr line
   (`writeFatalSync` → `fs.writeSync(2, …)`) before exiting. Registering
   `uncaughtException`/`unhandledRejection` suppresses Node's own crash-and-exit,
   so each handler exits itself to keep the fail-fast contract.
1. **`BOOT_KEY` idempotency guard** (**:495**; the symbol at **:54**) —
   HMR/re-entrant safe.
2. `getEnv()` validation, then the `BETTER_AUTH_URL`-behind-a-proxy warning and
   — **new in pass 21 (U8)** — `insecureAuthOriginWarning`
   (`config/env.server.ts:252`, production + non-local `http://` origin only).
3. `ensureDataRootDirs()`.
4. **`takeDataRootWriterLock(env)`** (**:524**, defined **:458**) —
   `acquireDataRootLock({force: forceDataRootTakeover(env)})`; on
   `DataRootLockedError` it prints the refusal to stderr and `exit(1)` (a refusal
   to boot, **not** a crash — `bootServer` is awaited from `entry.server.tsx`
   module scope, so an escaping throw would surface as an SSR module-init stack
   trace instead of the one message that names the holder). Anything else still
   throws.
5. `armProcessShutdown()` (**:529**) — register the lock-releasing signal handler.
6. **`startDataRootLockGuard()`** (**:535**) — the F18-5 fail-closed guard (§7).
7. `seedDefaultAgentAssets()` (**:540**).
8. **`getDb()`** (**:541**) — open `state/projection.sqlite` + run migrations.
9. `await seedInitialAdmin(db, …)` (**:543**).
10. `startEventPublisher()` (**:550**).
11. **`rescanProjections(db)`** (**:557**) — reconcile offline file drift.
12. `ensureBaseAgentsDeployed(db)` (**:574**).
13. **`startFileWatcher()`** (**:583**) + **`startKbWatcher()`** (**:587**).
14. `finalizeOrphanedRuns(db)` (**:594**).
15. **`startStoreMaintenance(db)`** (**:606**, defined **:340**) — three things in
    order: **`reapStaleWarmups(db)`** (**:349** — clears `warming_since` rows left
    by a dead process, §9), `runMaintenancePass(db, {reason:"boot",
    reclaimWorkspaces:false})`, then `startMaintenanceScheduler(db)` so a
    container that never restarts still prunes (§11). `reclaimWorkspaces: false`
    is deliberate — `reconcileRestartedWork` owns the reclaim (P14-RT-09).
16. `void reconcileRestartedWork(db)` (**:610**, fire-and-forget; defined
    **:398**) — agent-reply recovery → codex operator-plan recovery → workspace
    reclaim, **in that order**, each in its own try/catch. The three steps are
    injectable so the ordering is testable rather than only asserted.
17. `startScheduleRunner(db)` (**:616**), `startGithubReconcilePoller(db)`
    (**:622**), `logBootIntegrity(db)` (**:624**, defined **:236** — data-root
    dirs, migration state, projection/user counts, `BuildInfo`, disk status,
    and — **new in pass 21 (F21-1)** — the projection-schema drift fields:
    `projectionSchemaDrift` from `projectionValidationGaps` (**:154**, which
    `VALIDATION_VALUES` members the deployed DB's `validation` CHECK refuses)
    and `projectionMissingColumns` (**:192**, which current-baseline
    `task_projections` columns the deployed table lacks, computed by running the
    real migrations against a throwaway in-memory DB). Both absent on a healthy
    schema; either one present is the warning that this root predates a
    baseline change and every affected task rebuild will fail silently).

The lock is taken and GUARDED (steps 4-6) before anything opens the DB or writes
a file (step 8+).

---

## 7. Single-writer data-root lock (`app/server/db/data-root-lock.server.ts`)

> Verified 2026-08-19 against `app/server/db/data-root-lock.server.ts`.

This is B-FD1: the defense against the documented dual-writer WAL-clobber
catastrophe (two processes on one `docker-data` root over VirtioFS silently
losing SQLite transactions).

**The lock**: `acquireDataRootLock` (**:458**) does an `O_EXCL` create
(`openSync(path, "wx")`, `writeLockFile` **:444**) of
`<dataRoot>/state/writer.lock` (`DATA_ROOT_LOCK_FILENAME` **:50**), keeps the fd
for the process lifetime, and writes a `LockHolder`. On `EEXIST`,
`classifyLock` (**:307**) returns `stale | held | unknown-holder`;
`forceDataRootTakeover` (**:227**, env `VIBERR_FORCE_DATA_ROOT_LOCK` at **:53**)
overrides. A live foreign-host lock is refused with `DataRootLockedError`
(**:150**), whose `message` (`refusalMessage` **:404**) names the holder and both
remedies. `heldDataRootLock()` (**:186**), `releaseDataRootLock()` (**:222**).

### 7a. `LockHolder` — four fields, three of them evidence (`:58-89`)

```ts
type LockHolder = {
  pid: number;
  hostname: string;
  startedAt: string;      // ISO, acquisition time
  bootId?: string;        // per-PROCESS uuid, stable across HMR (processBootId :198)
  procStartedAt?: number; // /proc/<pid>/stat field 22 — clock ticks since boot
};
```

- **`bootId`** exists because `pid + hostname` cannot identify a process:
  `compose.yml` pins the hostname, so "same host" is trivially true for every
  container from that file, and two containers over one data root routinely land
  on the same low pid. Without it the self-reclaim branch would hand a LIVE
  holder's lock to a second writer.
- **`procStartedAt`** is **NEW in pass 20 (F20-8b)** — see §7b.

The lock file is parsed by a tolerant Zod schema (`lockFileSchema` **:278-295**):
`pid` and `hostname` are required (without them the verdict is `unknown-holder`
→ refuse, the safe answer); everything else degrades field by field, and the two
evidence fields stay **ABSENT** rather than becoming `undefined`, because both
readers ask "was this recorded at all?".

### 7b. F20-8(b) — the container self-lockout, and the `procStartedAt` reclaim

**The bug (live: nine consecutive boot refusals, RestartCount 11, cleared only by
deleting the file by hand).** The app runs as **pid 1** and compose pins the
hostname, so a CRASHED predecessor leaves `writer.lock` naming **pid 1 on this
exact host**. `classifyLock` then reached `isAlive(holder.pid)` — which, when
`holder.pid === self.pid`, is a **self-probe that always answers "alive"** — so
the boot refused forever.

**The fix** (`classifyLock` **:307-346**, in order):

1. `!holder` ⇒ `unknown-holder`.
2. `holder.bootId === self.bootId` ⇒ `stale` (our own HMR-dropped lock).
3. `holder.hostname !== self.hostname` ⇒ `held` (**the realistic dual-writer
   shape — a host process vs a container — is refused here, before the new
   branch**).
4. **NEW:** `holder.pid === self.pid && holder.procStartedAt !== undefined` ⇒
   read `/proc/<self.pid>/stat` field 22 (`readProcessStartTicks` **:250**,
   parsed after the LAST `") "` because `comm` can contain spaces and
   parentheses). If it is readable: **equal start time ⇒ `held` (the same
   instance genuinely still holds it); different ⇒ `stale` (the pid was recycled
   by a since-gone writer → reclaim)**. If unreadable — a pre-F20-8 lock, or any
   platform without `/proc` — fall through unchanged.
5. Otherwise `isAlive(holder.pid) ? "held" : "stale"`.

The residual window (a second LIVE writer that also sits on our exact
pid+hostname, indistinguishable from a crashed predecessor inside one pid
namespace) is deliberately resolved **toward reclaiming rather than bricking**,
because the F18-5 ownership guard below catches the loser within one tick and
fails it closed. `bootingHolder` (**:430**) records `procStartedAt` only when
Linux gives it (omitted off-Linux, where the pid-1 self-lockout does not arise).

### 7c. F18-5 — fail CLOSED when the lock is stolen

The lock keeps an fd open for the process lifetime, and nothing re-checked that
the FILE still exists. A store reset that deleted `state/` left the holder with
an unlinked-inode fd (still "holding" a ghost) while a second process booted into
the freed path — two live writers, silent SQLite loss (`PRAGMA integrity_check`
passes before and after; it does not detect lost transactions).

- `DataRootLock` (**:111-128**) exposes `fd`, `release()`, **`abandon()`**
  (drop tracking + close the stale fd **WITHOUT unlinking** — the file there now
  belongs to whatever replaced it) and `verifyOwnership()`.
- **`verifyLockOwnership(lock, probes?)`** (**:379-402**) — pure + injectable:
  `fstat` the held fd (unusable ⇒ `stolen`), `stat` the path (ENOENT ⇒
  `stolen`), compare `ino`+`dev` (differ ⇒ `stolen`); on an inode match,
  corroborate by reading the file's `bootId` — VirtioFS synthesizes inode
  numbers. A null/torn read ⇒ `unverifiable` (retry, not shutdown).
- **`startDataRootLockGuard(options)`** (**:614**) — unref'd, HMR-safe, 20 s
  timer (`DATA_ROOT_LOCK_GUARD_INTERVAL_MS` **:555**); on `stolen` it calls
  `stopDataRootLockGuard()` (**:644**) then a loud `logger.error` +
  `lock.abandon()` + `process.exit(1)`.
- **Surface the holder** (F18-5b): `/resources/health` returns
  `{pid, hostname, startedAt}` of the lock holder
  (`routes/resources.health.ts:107-113` — `bootId` is deliberately internal),
  rendered admin-only in the Home store-maintenance strip.

### 7d. The CLI writer lock (`db/cli-lock.server.ts`)

The invariant was enforced against a second **server**, not a second **writer**:
`npm run seed`, `npm run seed:demo` and `npm run rescan` opened the same
projection with no coordination. Every writing CLI now goes through
**`runWithDataRootWriterLock`** (**:109**), which takes the same lock with the
same inode+bootId proof, the same staleness rules and the same
`VIBERR_FORCE_DATA_ROOT_LOCK` takeover, and fails closed with
`cliLockRefusalMessage` (**:71**) naming the holder. `acquireCliWriterLock`
(**:89**), `cliDataRoot` (**:136**).

**Read-only CLIs deliberately do NOT take it** — `npm run backup`,
`npm run store:check`, `npm run keys -- status` open the projection read-only
(`db/backup.server.ts`, `files/store-check.server.ts`). Refusing to back up a
running instance would defeat the point.

Operational notes: never wipe `state/` while a process runs; beware the same-port
`::1` (host dev) vs IPv4 (docker-proxy) split-brain.

---

## 8. Agents get a real browser + the task attachments store (R19-19)

> Re-verified 2026-08-21 at `26fca45` against
> `app/server/tasks/specialist-browser-mcp.server.ts`,
> `app/server/tasks/specialist-run.server.ts`,
> `app/server/files/task-attachments.server.ts`, `app/routes/task-attachment.ts`,
> `app/shared/capabilities.ts`, `Dockerfile` — this section absorbed PRs #176,
> #177, #179 and #184.

Owner ruling, `docs/architecture/decisions.md` **75**. Three pieces: a
capability-enforced MCP mount, a canonical attachments directory, and a
member-only serving route.

### 8a. The capability

`app/shared/capabilities.ts:111` —
`cap("use-browser", "Drive a live web browser", ["agent"], "Collaboration", "off")`.
**Default OFF** (absence is withholding), agent-kind only, and in
`ENFORCED_CAPABILITY_IDS` (:240).

**NEW (PR #176, owner ruling 2026-08-20): granting the browser IMPLIES granting
web egress.** Live incident: an admin granted `use-browser`, left
`use-web-search-fetch` off, and run after run honestly reported "browser not
mounted" against a matrix that said Allowed — the mount interlock (§8b) fails
closed either way, so the contradictory pair expressed **no policy** and is now
inexpressible. Three layers, one rule:

- **Editor**: while the browser is Allowed the egress row pins to Allowed
  (disabled, reason in the accessible name); granting the browser flips egress
  with it (`create-profile-modal.tsx`).
- **Save layer**: `repairBrowserEgressGrants` (`capabilities.ts:475`; constants
  `BROWSER_CAP_ID`/`WEB_EGRESS_CAP_ID` :453-454) repairs the pair on create,
  edit and deploy-from-library, disclosed as a notice and under its own audit
  keys. `applyGrantCouplings` (**:510**) runs every coupling rule in one pass —
  the delivery headline (B-AG1) first, then browser→egress — and save results
  now carry `notices[]` (`GrantCouplingNotice` :355; both rules can fire on one
  save). **This deliberately diverges from B-AG1's respect-the-explicit-off**:
  the delivery headline's withheld state is enforceable, the browser/egress
  contradiction is not — respecting the `off` preserved nothing but the trap.
- **Runtime**: the `resolveBrowserMcp` interlock stays untouched as the backstop
  for hand-edited files.

### 8b. The mount IS the enforcement (`specialist-browser-mcp.server.ts`)

Deliberately **not** an org-registry row: registry MCPs sit outside the
capability policy (P13-KM-04, governance-by-instruction), and a browser is
exactly the tool that must not ride that gap — it is network egress, it executes
page JavaScript, and it feeds page content to an agent that may hold repo-write.

- `BROWSER_MCP_NAME = "viberr_browser"` (**:50**).
- `resolveBrowserMcp({grants, attachmentsDir, backend})` (**:100**) returns
  `{server, refused}`. Granted ⇒ a viberr-owned **Playwright MCP** child
  (`@playwright/mcp` **0.0.79**, a *production* dependency) joins the run's
  `mcpServers` on **both** backends. Withheld ⇒ the tool surface does not exist.
- **The egress interlock** (**:115-121**): the mount also requires effective
  `use-web-search-fetch: direct`. A profile whose web egress was revoked cannot
  re-acquire it one row down. When the pair still disagrees at runtime (a
  hand-edited file — the save layer now repairs it, §8a), the contradiction is
  **surfaced**, not silently resolved — it rides the P14-LV-09
  `UnresolvedMcpGrant` disclosure pipe into the run's inputs and persona.
- **Containment** (argv at **:133-145**): `--headless`, `--isolated` (in-memory
  profile — no cookies surviving a run or crossing tasks), **no**
  `--allow-unrestricted-file-access` (so `file://` is blocked and file access is
  confined to the child cwd), `--output-dir <attachments>`, on Codex
  `--image-responses omit`, and — only when `VIBERR_BROWSER_EXECUTABLE` is set —
  `--executable-path <exe> --no-sandbox`. The CLI entry is resolved through
  `playwrightMcpCliPath()` (**:76**) because the package's exports map hides
  `cli.js`. The child is `process.execPath` + args, with **no env and no
  credential**, so it survives the codex `--config` argv serialization intact.
- **Injection stance is prompt-level**: `browserPersonaSection(attachmentsRel)`
  (**:180**) — pages are DATA never instructions; never enter credentials; the
  browser widens no authority; and the screenshot-naming instruction below.
- **Wiring** (`specialist-run.server.ts` at `26fca45`): `attachmentsDir` at
  **:1360**, the mount resolved at **:1366** (only for a real backend), persona
  section appended at **:2015-2019** (inside `buildSpecialistPersona`,
  **:1849**), and merged into `mergedMcpServers` at **:1603-1605** — **between**
  the org grants and the toolkit, so a registry row can never shadow it and it
  can never shadow viberr's governance tools. The resume path repeats the mount
  at **:2461**.
- `viberr_browser` / `viberr-browser` are in `RESERVED_MCP_NAMES`
  (`tasks/specialist-mcp.server.ts:84`, applied :163) and `isReservedMcpName`
  (`org/resources.server.ts:1289`) — refused at save AND skipped by the resolver,
  both spellings.

**Live-verified quirk you must not "fix" away** (0.0.79): a screenshot taken with
the DEFAULT name lands in `--output-dir`; one taken with an explicit `filename:`
resolves against the **child cwd** (the run workspace) instead, because the SDK's
stdio config carries no `cwd`. The persona steers agents to default naming and
says so out loud.

### 8c. The attachments store — now with the "attachments drop" (PRs #177/#179)

`app/server/files/task-attachments.server.ts` — the read side is deliberately
dumb: **the directory is the truth**. No projection table, no browser upload
path, no retention machinery; attachments live inside the task dir so
archive/delete flows move them with the task. `listTaskAttachments` (**:35**,
newest-first, `LIST_CAP = 100` :33, skips dotfiles, tolerates a raced unlink),
**`attachmentNamesSince` (**:74**, NEW — names that appeared after a run
started, for attribution)**, `resolveTaskAttachment` (**:88** — through
`resolveStoreSegment`, throws on traversal), `INLINE_TYPES` (**:99**),
`attachmentContentType` (**:112**).

**Two writer classes now, not one** (the pass-21 doc said "one writer today"):

1. The browser MCP's `--output-dir` (§8b) — unchanged.
2. **The attachments drop (PR #179, owner ask 2026-08-20)** — ANY agent whose
   profile holds `attach-evidence-references` can copy a file into the task's
   `attachments/` dir during its run to "post a file on the task thread":
   - **Persona**: `attachmentsDropSection(attachmentsRel)`
     (`specialist-browser-mcp.server.ts:167`) is emitted for any
     evidence-granted profile, browser or not — the browser's default-named
     screenshots are a special case of this mechanic. The dir is `mkdir`'d
     before the run (`specialist-run.server.ts:1376`) so a plain `cp` cannot
     fail.
   - **The workspace contract names it as its ONE exception**
     (`buildAnalyzePrompt`, `specialist-run.server.ts` — live VIB-2, twice: the
     persona section alone was outranked by "never touch anything outside the
     working directory" and the agent correctly refused the copy; an exception a
     rule does not name is not an exception).
   - **Sandbox**: `RunSpec.attachmentsWritableDir`
     (`runtimes/adapter.server.ts:98`, set at
     `specialist-run.server.ts:1654`) — the Codex adapter adds it as an
     `additionalDirectories` entry **only at `workspace-write`**
     (`codex-runtime.server.ts:650-651`) — full access already writes it, and
     widening a read-only run would break P13-RT-02's matrix honesty. Claude
     runs at bypassPermissions and needs no widening.
   - **Attribution**: the completion pipeline stamps the names of files that
     appeared during the run onto the agent's reply event
     (`TaskFileEvent.attachments`, sanitized by `sanitizeEventAttachmentNames`
     with `EVENT_ATTACHMENTS_MAX = 20` — `task-file.schema.ts:1371-1405`),
     projected to `task_events.attachments_json` (`0001_baseline.sql:183`).
     Names only — the directory stays the truth.

### 8d. The serving route

`app/routes/task-attachment.ts` → `GET /projects/:slug/tasks/:key/attachments/:file`
(registered at `app/routes.ts:49-53`, **outside** the workspace layout since it
serves raw bytes).

- Authorization is **project membership** (`requireProjectMember`, **:33**) — the
  same bar as `/resources/run-log`, because a screenshot can show anything the
  agent saw. Org admins pass via the audited D2 override inside the same guard.
- Traversal violations become a plain **404**, never an oracle (**:39-47**).
- `MAX_ATTACHMENT_BYTES = 50 MB` (**:29**) → 413 above it.
- Every response carries `X-Content-Type-Options: nosniff` (**:63**) and
  `Content-Security-Policy: sandbox; default-src 'none'`, and only whitelisted
  types render inline — **stored HTML/SVG/JS are never inline** (they download as
  `application/octet-stream`), because a stored page served on the app origin
  would be stored XSS with the viewer's session attached.

### 8e. The UI (grew substantially in PRs #177 and #184)

- `features/task-detail/attachments-panel.tsx:26` — newest-first panel, images in
  a thumbnail grid, everything else as files; **renders nothing at zero**.
- `routes/project.task.tsx:263-272` gates the list on `runsVisible` (computed at
  :180; the route re-checks membership on every fetch anyway), builds the
  `attachmentProducers` map (event → the names its run saved), and passes
  `attachmentsBase` at **:1032**.
- **Evidence linkify**: `features/task-detail/timeline.tsx:132` `EvidenceLabel` —
  an evidence label token (backticks/quotes/trailing punctuation stripped) that
  matches a filename the task ACTUALLY has becomes a link to the serving route.
  Everything else stays plain text — no guessing.
- **Producing-comment previews (PR #177)**: an image attachment renders as a
  small `.tl-attach-thumb` picture ON the producing message (the timeline is a
  feed, the panel is the gallery); non-image files keep filename chips. Same
  member-only serving route, same sandboxed inline types.
- **Markdown link repair (PR #177)**: `repairAttachmentHref`
  (`app/ui/markdown.tsx:150`) — when a comment link's or embedded image's href
  is attachment-shaped (`attachments/<name>`, any relative prefix, or the bare
  filename) AND the filename names a file the task really has, the href is
  rewritten to the serving route. Absolute URLs, foreign paths and unknown names
  pass through exactly as written — the same no-guessing contract as the
  evidence linkify. Wired only where a task supplies its attachment set.
- **In-app lightbox (PR #184)**: `AttachmentLightboxProvider` +
  `useAttachmentLightbox` (`features/task-detail/attachment-lightbox.tsx`) — a
  plain left click on any image-evidence surface (timeline thumbnail, panel
  grid, evidence-linkified image filename, inline markdown embed) opens a
  modal-card lightbox (the app's one dialog contract: `useDialog`, Escape,
  backdrop, animated close) with an "Open original" link. Modified clicks
  (cmd/ctrl/shift/alt/middle) pass through the real anchor; with no provider
  mounted the handler is inert. Non-image chips keep the plain link.

### 8f. The image

`Dockerfile:59-73` installs Debian `chromium` + `fonts-liberation` (~700 MB with
its dependency closure; the owner accepted the weight over a sidecar) and sets
`ENV VIBERR_BROWSER_EXECUTABLE=/usr/bin/chromium`. When that var is set the mount
builder also passes `--no-sandbox`, because chromium's user-namespace sandbox
cannot start under docker's default seccomp as the non-root `node` user. On a dev
host the var is unset and Playwright's own resolution + sandbox apply.

---

## 9. The org MCP registry: probe honesty + background installs

> Verified 2026-08-19 against `app/server/org/resources.server.ts` and
> `app/server/org/mcp-warmup.server.ts`.

**R19-17 — surface what the command said.** The stdio probe spawned with
`stdio: ["pipe","pipe","ignore"]`, discarding the child's own explanation at the
OS level. stderr is now captured (bounded 8 KB) and carried in the failure reason
(`discoverStdioMcpTools` **:963**); the spawn error itself is surfaced too
(`spawn uvx-not-installed ENOENT`, :1013-1021).

**R19-17b — keep the reason on the row.** `org_mcp_servers.last_error`
(`0001_baseline.sql:314`), written by every probe path and **CLEARED by a passing
probe** — a stale explanation under a green dot is worse than none.

**R19-17c — tell a first-run install apart from a hung command.** The stdio
window is **20 s** (`discoverStdioMcpTools` :963, the default at :978) because
`npx` and `uvx` FETCH on first use. When the probe gives up and stderr matches
`INSTALLING_RE` (:1045) the reason says so and the discovery carries
`installing: true` (`StdioDiscoveryFailure` :901-916). **Earned by evidence
only.**

**R19-18 — finish the install in the background** (`org/mcp-warmup.server.ts`):
`startMcpWarmup` (**:62**) re-runs **the same** `discoverStdioMcpTools`
handshake with `WARMUP_CAP_MS = 15 min` (**:35**), detached from the request,
writing the real verdict when it settles. It is reached by dynamic
`import("./resources.server")` to break the cycle (**:87**). One in-process `Set`
keyed by server id makes a second registration a no-op (`isWarming` :41).
`org_mcp_servers.warming_since` is the row's own third state — **neither green
nor red**. `reapStaleWarmups(db)` (**:141**) runs at boot: the flag means
"running HERE", so after a restart a survivor would be a row claiming to install
with no installer behind it.

### 9a. R20-4 (N20-2) — the npx/bunx heuristic — pass 20

The uvx path already warmed a first-run install; a cold
`npx -y @modelcontextprotocol/server-everything` exceeding the 20 s probe showed
a bare "timed out after 20s" and **no warm-up**, because npx is SILENT while the
registry resolves.

- **`isFirstRunInstallerCommand(argv)`** (`resources.server.ts:946`) — matches
  `npx`/`bunx`/`uvx`/`pipx`, `pnpm|yarn|bun` + `dlx|x`, and `uv tool`. Matched on
  **argv, never the raw string**, so `my-server --npx-mode` is not a false
  positive.
- The probe reports `firstRunInstaller: true` on such a timeout
  (`StdioDiscoveryFailure` **:911**) and **stays DB-free** — only the caller
  holds the row and can decide whether this is really a first run.
- **`org_mcp_servers.first_success_at`** (`0001_baseline.sql:319`) — NULL means
  the server has never worked here, which is what makes the timeout a plausible
  first-run install. Stamped idempotently with `COALESCE` when a warm-up
  succeeds (`mcp-warmup.server.ts:98`), never cleared.
- **`org_mcp_servers.heuristic_warmups`** (`0001_baseline.sql:325`) — capped at
  **1**. Incremented at *arm* time, and only for a heuristic warm-up
  (`mcp-warmup.server.ts:75-79`); the evidence-based path (`installing === true`)
  is NOT counted, because it is not a guess. `reapStaleWarmups` rolls it back with
  `MAX(0, heuristic_warmups - 1)` (**:159**) — a warm-up a restart killed never
  got its 15 minutes, so it is not a spent attempt. **The cap is what makes
  `unreachable` a reachable terminal state.**

### 9b. The credential scrub — F20-7, tightened in pass 20

`secrets/git-output-redact.server.ts` `redactGitOutput` (**:79**) is the shared
child-process scrubber, used deliberately (not incidentally) by the MCP probe:
the child is spawned WITH `MCP_CREDENTIAL` in its env (P13-KM-05), so a server
that dumps its environment while dying would otherwise print the credential into
a toast and into the persisted `last_error`.

- **Layer 1 — by value** (**:96-97**). **F20-7 removed the `>= MIN_TOKEN_LEN` (8)
  floor**: the credential is now scrubbed **at ANY length**. Live leak: a 5-char
  `MCP_CREDENTIAL` printed as `CRED=xy7Qk`. The by-value pass is exact — it only
  removes the string the caller HANDED us — so a shorter value has nothing extra
  to mangle; the floor only ever protected a leak. The empty-string case is still
  guarded (a split on `""` would insert `[redacted]` between every character).
- Layer 2 — URL userinfo (**:99-103**, after layer 1 so
  `x-access-token:[redacted]@host` still loses the username half). Layer 3 —
  anchored token patterns (`TOKEN_PATTERN_SOURCE` **:43**, applied :104). Then
  ANSI stripping, C0-control stripping, and a clamp to the **TAIL**
  (`MAX_DETAIL_LINES = 8`, `MAX_DETAIL_CHARS = 600`) because a traceback states
  its verdict last.
- **The belt to that brace**: `saveMcpServer` (**:1415**) **refuses a fresh
  plaintext credential under 8 characters** (`resources.server.ts:1455` — "That
  credential is too short. Enter at least 8 characters, or leave it blank for no
  auth." — the wording lost its em-dash in the pass-21 humanizer sweep). A
  sealed box is long by construction, so the floor only applies to fresh
  plaintext.

### 9c. The settings page polls, it does not subscribe

`features/org-settings/resources-panel.tsx` arms a 20 s
`revalidator.revalidate()` interval **only while some row is warming**. The
reason is architectural — the SSE vocabulary is a closed typed union routed by
user/project/task scope and an org-settings row fits none of them (§5).

### 9d. Why the image ships uv

`specialist-mcp.server.ts` spawns a registered stdio server's command
**verbatim — there is no allow-list** — so whatever the command names must exist
in the runtime image. `npx` shipped with the base image; the Python half
(`uvx mcp-server-…`) did not. `uv` + `uvx` are copied as two static binaries from
`ghcr.io/astral-sh/uv:0.12.3` (`Dockerfile:85`); **no system python3**, because
uv downloads and manages its own CPython. Its cache and that interpreter go on
the `/data` volume (`UV_CACHE_DIR`, `UV_PYTHON_INSTALL_DIR`, `Dockerfile:101-102`)
next to `CLAUDE_CONFIG_DIR` and `CODEX_HOME` for the same reason.

---

## 10. The delivery pipeline to GitHub

> Re-verified 2026-08-21 against `app/server/tasks/task-actions.server.ts` and
> `app/server/github/` at `26fca45` — both changed heavily in pass 21 (§10a).

**`performDelivery(db, ctx, projectSlug, taskKey, actor)`**
(`task-actions.server.ts:3703` at `26fca45`) is the shared core behind the operator's
`deliver_for_review` tool, the applied `delivery` recommendation, and the task
page's manual delivery button (R15-2 — it is NOT a `transitionStage` side effect;
that was deleted by owner ruling). **It never throws**: degraded GitHub state
returns a typed outcome AND surfaces a timeline event, so a failed delivery is
never silent. RBAC belongs to the caller (the operator's `deliver-review-pr`
grant, or the human's authority).

`DeliveryOutcome` (the union at **:3672-3701**):
`delivered` (with `pushStatus`) · **`push_conflict`** (F15-15/B-GH1 — the remote
branch diverged non-fast-forward; **no PR is opened**, because it would review
the stale remote content) · `grant_withheld` · `push_failed` · `nothing_to_review`
· `failed`.

Steps: resolve the push grant → `pushWorkspaceBranch`
(`github/push-workspace.server.ts`, dynamically imported) → re-reconcile the work
revision (`github/workspace-delivery.server.ts` `reconcileWorkspaceDelivery`
**:231**, which calls `nextWorkRevision`) → open or reuse the review PR
(`github/pr-open.server.ts` `openTaskPr` **:223**, body composed by
`composePrBody` **:41** with `latestEvidenceLines` **:94**; pass 21's F21-9
added **PR-open salvage** — `pr-open` grew ~250 lines hardening the open path
against a client that must never throw).

Around it:

- **`github/reconcile-poller.server.ts`** — `startGithubReconcilePoller` (**:192**)
  / `stopGithubReconcilePoller` (**:221**), `pollGithubReconcile` (**:121**),
  `RECONCILE_POLL_MS = 5 min` (**:22**). This is what keeps `pr.state`,
  `pr.checks`, `pr.review`, `pr.mergeable` and `revisionDrift` fresh.
- **`github/pr-human-approval.server.ts`** (R19-B) — a project member's GitHub
  approval on the PR counts as the approving **verdict**. `PR_HUMAN_APPROVAL_KEY
  = "humanApproval"` (**:75**) rides in the loose `pr` object;
  `derivePrHumanApproval` (**:127**), `readPrHumanApproval` (**:181**),
  `humanVerdictApproval` (**:210**), `verdictGateReason` (**:306**).
- **`github/branch-cleanup.server.ts`** — the `delete-branch-after-merge`
  guardrail (`BRANCH_CLEANUP_GUARDRAIL_ID` **:23**, `branchCleanupOnMerge` **:32**).
- **`github/push-workspace.server.ts` `discardLocalTaskBranch`** (**:790**) —
  **pass 20 (R20-2 / F20-6)**. Deletes a task's LOCAL, never-pushed
  workspace branch on the human's `discard_branch` confirm. It touches ONLY the
  workspace clone and **refuses the moment the branch exists on origin** — this
  is cleanup, not a disposition, and remote deletion stays the archive packet's
  job (ruling 17). Best-effort: a git failure becomes a typed `failed` outcome
  (`DiscardBranchOutcome`, :769-774), never a throw that could un-resolve the
  packet the caller already recorded. Called from `task-actions.server.ts:5466`
  and :5534 (both behind a dynamic `import`, at :5456 / :5531).
- **`github/update-branch{,-operator}.server.ts`** (N19-9) — bring the task
  branch up to date with the base.
- **`github/scope-flag.server.ts`** — opens/resolves `scope_violations` rows when
  a PAT lacks a required scope.

Git output reaching a human or an agent prompt is always scrubbed by
`redactGitOutput` (ruling 69 / R19-13, §9b).

### 10a. Pass-21 additions around the pipeline (missing from the pass-21 doc)

- **Ruling 88 (R21-5 / F21-2) — acceptance carries its disclosure.** R15-1's
  confirm ceremony held client-architecturally only; a direct POST completed an
  acceptance with no disclosure at all. Now every HUMAN acceptance door —
  normal or forced, task page or board drop — must carry an acknowledgment
  echoing the facts the client displayed (merge state, revision being accepted,
  standing verdict); the server refuses a bare POST and refuses an echo that no
  longer matches the live task (a stale disclosure is a refusal, not a silent
  write; re-compared under the write lock). Shared shape:
  `app/shared/acceptance-disclosure.ts` (`ACCEPT_DISCLOSURE_FIELDS` :48,
  `parseAcceptanceDisclosure` :85, `acceptanceDisclosureDrift` :137); ceremony:
  `features/task-detail/accept-confirm.tsx`; and
  **`task_projections.work_revision_sha`** (`0001_baseline.sql:143`) exists so a
  board card — rendered from the row alone — can disclose the delivered
  revision instead of "No delivered revision recorded" (which the server would
  then rightly refuse as a stale echo).
- **R21-4 (ruling 87) — the per-project mirror**
  (`app/server/tasks/repo-mirror.server.ts`): `cloneWorkspaceRepo` (**:411**) /
  `projectRepoMirrorDir` (**:98**) / `refreshProjectMirror` (**:349**) back task
  clones with a per-project git mirror cache (stale-serve + self-heal), so the
  second clone of a 113 MB repo is local work; the pre-run "preparing workspace"
  phase is surfaced live through `onPhase` on the adapter interface (finally
  driven — it existed but was never invoked). `operator-repo-read.server.ts`
  (`readDefaultBranchFile` **:181**) gives the operator **main-anchored**
  default-branch file reads via the mirror (F21-21).
- **Band-1 GitHub truth (F21-7/8/9/11/17, F21-5)** — regressions the anti-slop
  rewrite introduced, fixed in pass 21: the github client's "never throws"
  contract restored + a per-task reconcile boundary (`github-client` /
  `github-reconciler`); unknown-bucket check-runs (a drifted check-runs payload
  no longer persists a false green); one malformed commit no longer empties the
  whole commit list; per-field PAT tolerance (`pat-validator`); revision-drift
  carry-forward on settled PRs; and the viewer credential visibility rule
  (`features/github/credential-visibility.server.ts`).

---

## 11. Ops / store maintenance (`app/server/ops/`)

> Verified 2026-08-19 against `app/server/ops/`.

Four modules, armed from `boot.server.ts:465` via `startStoreMaintenance` (§6):

- **`maintenance.server.ts`** — `runMaintenancePass` (**:142**),
  `DEFAULT_MAINTENANCE_INTERVAL_MS = 6 h` (**:65**),
  `DEFAULT_DISK_CHECK_INTERVAL_MS = 5 min` (**:68**),
  `MIN_PRESSURE_PASS_GAP_MS = 30 min` (**:71**), `activeRunCount` (**:120** — the
  periodic pass's own active-run guard, since boot's pass runs with
  `reclaimWorkspaces:false`), `startMaintenanceScheduler` (**:369**). Retention
  used to run exactly once per process, at boot — coupled to a restart a stable
  deployment never performs.
- **`transcript-retention.server.ts`** — `pruneRuntimeTranscripts` (**:178**);
  `DEFAULT_TRANSCRIPT_RETENTION_DAYS` (**:62**) /
  `DEFAULT_SESSION_HOME_RETENTION_DAYS` (**:64**) = 30. Prunes raw run
  transcripts and provider session homes on disk.
- **`disk-space.server.ts`** — `measureDataRootSpace` (**:102**),
  `cachedDataRootSpace` (**:138**, `DISK_MEASUREMENT_TTL_MS = 5 s` **:128**),
  `classifyFreeBytes` (**:88**) against `DEFAULT_DISK_LOW_FREE_BYTES = 2 GB`
  (**:45**) / `DEFAULT_DISK_CRITICAL_FREE_BYTES = 512 MB` (**:47**), both
  env-overridable (`VIBERR_DISK_LOW_FREE_MB`, :78-81).
- **`build-info.server.ts`** — `resolveBuildInfo` (**:106**) / `getBuildInfo`
  (**:129**), consumed by `logBootIntegrity`.

---

## 12. The action watchdog (`app/server/actions/`) — pass 20 (F20-1)

> Verified 2026-08-19 against `app/server/actions/action-watchdog.server.ts`.

`withActionWatchdog(label, fn, timeoutMs = ACTION_WATCHDOG_MS)` (**:28**,
`ACTION_WATCHDOG_MS = 30_000` at **:6**) races a mutating server action against a
timer and fails THAT action with a typed `AppError` (**503**) so the request
returns instead of the user staring at a wedged page. The timer is `unref`'d and
always cleared in a `finally`.

**Read the documented LIMITATION (:15-25) before extending it.** The timer only
fires for an **ASYNC** hang. It **cannot interrupt a synchronous CPU spin on the
main thread** — while such a loop holds the thread, the timer callback never
runs, and *the live F20-1 spin was exactly this shape* (an unbounded `existsSync`
collision loop). Those are closed **at the source** instead:

- `app/server/org/store-files.server.ts` — the collision loop is bounded
  (`MAX_STORE_SCAN_DEPTH = 32` at **:89**, checked at :92).
- `app/server/files/atomic-file.server.ts` — a stale/unreachable mount (a deleted
  VirtioFS bind-mount inode) fails writes/renames with **ESTALE/EIO**, which is
  now a typed `AppError` throw (**:69-77**) instead of a hang.

The watchdog is the cheap general insurance on top. **Implemented once; do not
re-implement the race per route.** Current call site:
`app/features/home/project-create.server.ts:261`.

---

## 13. Model availability from real failures (R20-3) — pass 20

> Verified 2026-08-19 against `app/server/runtimes/model-availability.server.ts`
> and `app/server/secrets/git-output-redact.server.ts`.

Codex exposes no model-list endpoint, so the only honest way to know a model is
unusable for this deployment's account is to **watch a real run fail on it**
(live F20-4: a 400 `invalid_request_error` — "The 'gpt-5.6-sol' model is not
supported when using Codex with a ChatGPT account" — while the blocked packet
said only "Codex execution failed. Review its authentication and runtime
configuration.").

- **Store**: the `model_availability` table (`0001_baseline.sql:312-319`,
  DOMAIN-MODEL.md §5.4). **Presence of a row = unavailable; absence =
  unknown-but-offered, never "proven available"** (ruling 19: proven verdicts
  only, never a pseudo-check).
- **`MODEL_UNSUPPORTED_RE`** (**:30-31**) separates "this account cannot use this
  model" from quota / auth / crash. `noteModelAvailabilityFromFailure` (**:106**)
  is gated on it (**:117**) and on the run actually naming a model.
- `markModelUnavailable` (**:34**, upsert — the newest failure's sentence wins),
  `clearModelMark` (**:57**, on a real success), `unavailableModels` (**:79**).
- **Wiring** (anchors at `26fca45`): mark at `task-actions.server.ts:2615` and
  `operator-run.server.ts:2321`; clear at `task-actions.server.ts:2676` and
  `operator-run.server.ts:2243`; read by `runtimes/model-catalog.server.ts:365`
  and `features/agents/agents-query.server.ts:592-594` (the profile modal
  disables a marked model with its reason, `modelUnavailable` :497).
- **Pass-21 addition (F21-13)**: a FOREIGN model on a profile (a Codex model
  saved onto a Claude backend or vice versa) is now **rejected at save**, and
  when a run must substitute a model anyway the substitution is **surfaced in
  the run's own copy** (`run-service.server.ts:603-604`) instead of silently
  running something else.
- **The provider's own words** reach the packet observation, the escalation, the
  persisted `err` line and the timeline through **`redactProviderText(raw, token)`**
  (`git-output-redact.server.ts:142`, `PROVIDER_TEXT_CHARS = 240` at :141). It
  walks up to 3 levels of `Error.cause` (the SDK wraps the real message a couple
  of layers down), runs the shared `redactGitOutput` scrubber, keeps the LAST
  non-empty line, and clamps from the tail. Ruling 69's argument transfers
  verbatim from git to the model runtimes: the credential never lives in argv
  (Codex gets it via `CodexOptions.apiKey`/env, Claude via `claudeSpawnEnv`).

**Seed half (R20-8):** the seeded Developer's default Codex model is now
`gpt-5.6-terra` (`app/server/seed/agent-catalog.server.ts`).

---

## 14. The operator loop (R20-1 changed its entry and exit; R21-9 its control)

> Re-verified 2026-08-21 against `app/server/runtimes/operator-run.server.ts`
> and `app/server/tasks/task-actions.server.ts` at `26fca45`.

`runOperator(db, input)` (`operator-run.server.ts:995` at `26fca45`) is the
single entry. `RunOperatorInput.trigger` (**:157-167**) is a closed set:
`create | transition | agent-reply | goal-updated | pr-diverged | delivered |
packet-resolved | scheduled | manual`, each with a documented turn instruction.
Concurrent triggers for one task merge into a single queued turn
(`queueOperatorTrigger`).

**R20-1 (F20-5) added the `packet-resolved` trigger and two refusals:**

- `packet-resolved` (**:164**) carries `resolvedOption {kind, title, note?}`
  (**:170**) so the turn instruction can state exactly what was decided rather
  than making the operator re-derive it from the timeline. Handled at **:2938**.
  The instruction is explicit: *never re-open the packet you were just answered
  on*.
- A manual "Run operator" **while a packet is open is REFUSED, not paid for**:
  `refused: "open-packet"` (**:1082**; the union `"terminal-stage" |
  "open-packet"` at **:234**). Previously a human-pressed run burned a paid
  no-op the coordination pause could take no action on.
- On the resolution side (`resolvePacket`, `task-actions.server.ts:4773`):
  `markTaskPacketApprovalRead` is now **unconditional** (**:5327**), and EVERY
  settled decision **re-queues the operator** except the documented `NO_REQUEUE`
  set (**:5332-5340**: `accept_completion`, `archive_task`, `edit_goal`,
  `hold_runtime_debug`, `retry_other_backend`, `discard_branch`). A
  request_edit/redirect/custom answer on an "Agent question" packet is routed to
  the **asker** first (R15-14, `answerAskingAgent`), then the operator runs to
  coordinate.

**R21-9 (ruling 92, PR #185) simplified the RUN CONTROL — it shows, it does not
pick.** The per-run backend/autonomy dropdowns are gone: both are configured on
the deployed operator profile, and the run resolves the LIVE profile (the same
law PR #183 applies to the delivering-agent card). The card states the backend
(labeled **"Claude"**, never "Claude Code" — every backend display site), keeps
"Run operator", and adds an optional **steer** input. The steer rides the
`@operator` mention machinery: recorded as the human's own timeline comment (a
directive that reaches an agent off the record is invisible to supervision) and
passed as the run's `humanComment`, with `humanCommentBy` the DISPLAY name (the
email label tagged "@arda@viberr.dev", which chips and notifies nobody). F20-9's
mirror survives as a caption — full autonomy announces itself on the run
surface — and P11-41 survives without a picker: an unconfigured profile backend
disables Run with the reason rendered.

**R20-9 (ruling 84) — consultation disclosure is MECHANICAL:** a packet the
operator opens after prompting an agent this turn has the on-whose-behalf
disclosure APPENDED by the `open_decision_packet` handler itself
(`operator-toolkit.server.ts` `consultationDisclosure`) — omission is
impossible at packet-open, not merely discouraged; and the operator may still
never WITHDRAW an agent's ask (a packet carrying `askedBy` is refused to it).

Other bounds worth knowing: `reactDepth` (the prompt↔react loop) and
`transitionDepth` / `OPERATOR_TRANSITION_CHAIN_CAP` (the transition→re-trigger
loop, reset by any human/agent-reply trigger).

---

## 15. Notifications

> Verified 2026-08-19 against `app/server/projections/notifications.server.ts`
> and `app/server/tasks/mention-notify.server.ts`.

`notifications` is a **canonical SQLite table**, not a projection
(`0001_baseline.sql:182-196`), with `kind` CHECK
`('packet','approval','mention','quality','policy')` (**:185**) and a
packet-only `ptype` CHECK `input|blocked`.

- `createNotification` (`projections/notifications.server.ts:54`) is the single
  writer; `markTaskPacketApprovalRead` (**:312**) consumes the packet approval
  when a decision settles (R20-1 made that call unconditional, §14).
- `notifyMentionedUsers` (`tasks/mention-notify.server.ts:248`) is the shared
  path every comment writer goes through — the NEW-4 convention: agents and the
  operator must @tag the human they answer AND the tag must notify.
- R19-15: a notification is **auto-read on VIEWING its target**.
- Delivery to the client is the `notification.created` / `notification.read` SSE
  variants, scoped `user:<id>` (§5), which drive a route revalidation rather than
  an optimistic badge update.

---

## 16. The runtime image is part of the architecture

> Verified 2026-08-19 against `Dockerfile` (143 lines).

Because `specialist-mcp.server.ts` spawns registered stdio commands verbatim and
`specialist-browser-mcp.server.ts` mounts a browser, **what the image carries is
a functional contract, not packaging**:

| Layer | Line | Why |
| --- | --- | --- |
| `git`, `ca-certificates` | :55-58 | clone/deliver; the SDKs' native binaries already ride node_modules |
| `chromium` + `fonts-liberation` + `VIBERR_BROWSER_EXECUTABLE` | :69-73 | R19-19 (§8f) — a pinned binary, not `npx playwright install` into a container-local cache |
| `uv` + `uvx` from `ghcr.io/astral-sh/uv:0.12.3` | :85 | Python MCP servers (§9d); no system python3 by design |
| `VIBERR_DATA_ROOT=/data` | :90 | canonical store + projections on the mounted volume |
| `CLAUDE_CONFIG_DIR` :93 / `CODEX_HOME` :96 / `UV_CACHE_DIR` :101 / `UV_PYTHON_INSTALL_DIR` :102 | :93-102 | all four default under `$HOME`, which is container-local |

Three build details that are non-obvious and must not be "cleaned up":

- **`prod-deps` is its own stage keyed only on the lockfile** (:3-29). The
  runtime tree used to come from `npm ci && build && npm prune --omit=dev` AFTER
  `COPY . .`, so every source edit re-ran a ~150 s silent prune. Installing the
  production tree directly removes the prune entirely and lets buildkit run it in
  PARALLEL with the build.
- **Both `npm ci` lines carry `--foreground-scripts`** (:29, :40). A from-scratch
  install fails with **ETXTBSY**: esbuild's postinstall spawns its just-written
  binary for `--version` while overlayfs still counts a writer on it. The layers
  are lockfile-cached, so the serialization is paid only on real dependency
  changes.
- **`CMD` runs the server binary directly, not `npm run start`** (:136-143). With
  npm in between, npm is pid 1 and node is its child, and a `docker compose stop`
  SIGTERM never reaches node — which is what checkpoints the WAL and **releases
  the data-root writer lock**. An npm-wrapped server left a lock file behind on
  every stop.

---

## 17. Delta summary (pass-20 doc → pass 21) — historical

> This table compares the PASS-20 doc to the pass-21 discovery baseline
> (`ce2bc9e`) and is kept as history. For everything after `ce2bc9e` (pass 21's
> own merge PR #175 + PRs #176-186) see the **Pass-22 revision** section at the
> top; its "Unchanged and re-verified at ce2bc9e" line below is superseded where
> that section says so (notably the browser capability's save-layer coupling and
> the ops-adjacent boot integrity fields).

| Area | Change | Where |
| --- | --- | --- |
| **Doc baseline** | the pass-20 doc was pinned to `b97ad02`, the pass-20 *discovery* baseline — **before pass 20's own 12 commits merged as PR #169** | `6c94f2c` |
| Crash visibility | **NEW** `installCrashVisibilityHandlers` — synchronous stderr FATAL line before exit; boot **step 0** | F20-8a, `boot.server.ts:84,358` |
| Data-root lock | **NEW** `LockHolder.procStartedAt` + the `/proc` start-time branch in `classifyLock` — ends the container pid-1 self-lockout | F20-8b, `data-root-lock.server.ts:88,250,339-344` |
| Action watchdog | **NEW** `app/server/actions/action-watchdog.server.ts` (30 s, 503, async-hangs only) + bounded `store-files` loop + ESTALE/EIO throw in `atomic-file` | F20-1, §12 |
| Credential scrub | `redactGitOutput` scrubs the caller's token at **ANY length** (the 8-char floor is gone) + `saveMcpServer` refuses fresh plaintext under 8 chars | F20-7, §9b |
| Model availability | **NEW** `model_availability` table + `runtimes/model-availability.server.ts` + `redactProviderText` (240-char clamp) | R20-3, §13 |
| MCP warm-up | **NEW** npx/bunx heuristic: `isFirstRunInstallerCommand`, `firstRunInstaller` discovery flag, `first_success_at` + `heuristic_warmups` columns, cap-1 arming with restart rollback | R20-4, §9a |
| Packets / operator | **NEW** 10th packet kind `discard_branch` + `discardLocalTaskBranch`; `packet-resolved` trigger; unconditional approval consume; `NO_REQUEUE` set; manual run refused on an open packet | R20-1/R20-2, §10, §14 |
| Projection columns | **NEW** `task_projections.acceptance` (force-accept fact) and `.continuity` (degraded runtime continuity) | N20-14 / D4, §2, DOMAIN-MODEL §5.2 |
| Capabilities | `coerceSpecialistCapabilityMode` inverted: `recommend → off`, never `→ direct`; seed made honest | R20-6, DOMAIN-MODEL §3.2 |
| Routes | **NEW** pathless `routes/palette-shell.tsx` wrapping org-settings / profile / notifications so ⌘K reaches them | F20-30, `routes.ts:21-26` |
| UI | **NEW** `app/ui/confirm-dialog.tsx` (shared confirmation ceremony); **NEW** `features/toast-honesty.test.ts` | D5/D6 |
| Lint | `dmmulroy/anti-slop` oxlint plugin installed; 2,843 → 26 findings fixed tree-wide — **this is why many anchors moved without behaviour changing** | `54ffab8`, `ce2bc9e` |
| Counts | `routes/` 42→**43**, `features/` 176→**177**, `server/` 293→**299**, `ui/` 31→**32**; `routes.ts` 59→**69**; `app.css` 4218→**4262** | — |

**Unchanged and re-verified at `ce2bc9e`**: the layering rule, the interpretation
policy (§3), the SSE scope model and its two closed unions (§5), the F18-5
ownership guard, the CLI lock split, the single squashed migration, the
watcher/single-flight throttles, the browser capability's mount-is-enforcement
design (§8), and the whole ops/maintenance surface (§11).

Note: `docker-data/**` and `.claude/worktrees/**` contain checkout copies of the
same tree — the canonical source is `app/`, `db/` and `Dockerfile`.

---

## Corrections vs pass-20 doc — historical

> Written at `ce2bc9e`; its anchors are pass-21-discovery anchors and several
> have since moved again (see the Pass-22 revision section for current ones).

1. **Its baseline (`b97ad02`) predates pass 20's own merge.** It is a
   discovery-time snapshot, so it documents pass-19 material as "NEW this pass"
   and contains none of the pass-20 mechanisms listed in §17.
2. **Boot has a step 0 now.** `installCrashVisibilityHandlers()` runs before the
   `BOOT_KEY` guard and before `getEnv()` (`boot.server.ts:358`). The pass-20
   doc's step 1 is no longer first.
3. **Every boot anchor moved**: `bootServer` is **:355** (was :250);
   `takeDataRootWriterLock` **:383** (was :275), `armProcessShutdown` **:388**
   (:280), `startDataRootLockGuard` **:394** (:286), `seedDefaultAgentAssets`
   **:399** (:291), `getDb` **:400** (:292), `seedInitialAdmin` **:402** (:294),
   `startEventPublisher` **:409** (:301), `rescanProjections` **:416** (:308),
   `ensureBaseAgentsDeployed` **:433** (:325), `startFileWatcher` **:442** (:334),
   `startKbWatcher` **:446** (:338), `finalizeOrphanedRuns` **:453** (:345),
   `startStoreMaintenance` **:465** (:357), `reconcileRestartedWork` **:469**
   (:361), `startScheduleRunner` **:475** (:367), `startGithubReconcilePoller`
   **:481** (:373), `logBootIntegrity` **:483** (:375).
4. **Every data-root-lock anchor moved and the classify logic changed.**
   `acquireDataRootLock` **:458** (was :340), `classifyLock` **:307** (:231),
   `verifyLockOwnership` **:379** (:276), `DATA_ROOT_LOCK_GUARD_INTERVAL_MS`
   **:555** (:439), `startDataRootLockGuard` **:614** (:490),
   `stopDataRootLockGuard` **:644** (:520), `releaseDataRootLock` **:222** (:191),
   `heldDataRootLock` **:186** (:161), `DataRootLockedError` **:150** (:133),
   `forceDataRootTakeover` **:227** (:196), `DataRootLock` **:111** (:94). And
   `classifyLock` gained the `procStartedAt` branch the pass-20 doc has no
   knowledge of.
5. **`rebuilder.server.ts` anchors moved again**: `rebuildProjectFile` **:150**
   (was :148), `rebuildTaskFile` **:348** (:344), `rebuildPath` **:655** (:618),
   `rebuildProject` **:695** (:658), `rebuildAll` **:779** (:741). The readiness
   write is no longer at :464/:474 — the single UPSERT is **:493-560** and now
   also binds `acceptance` and `continuity`.
6. **`sqlite.server.ts`**: `getDb` is **:59** (was :47), `shutdownDatabase`
   **:102** (:96).
7. **SSE anchors moved** (the pass-20 doc called them "identical"):
   `publishSseEvent` **:322** (was :313), `connectSseClient` **:250** (:241),
   `SseScope` **:49**, `runProcessShutdown` **:372** (:361),
   `armProcessShutdown` **:368** (:357). `event-publisher`'s
   `startEventPublisher` is **:198** (:174) and `translateProjectionEvent`
   **:52** (:51). `resources.events.ts` loader is **:63** (:61).
8. **`app/routes.ts` is 69 lines, not 59**, and has a new pathless
   `palette-shell` layout; the attachment route is at **:49-53**, not :41-44.
9. **`app/server/` has an `actions/` subdir** the pass-20 doc does not list, and
   the per-dir counts moved (`runtimes/` 33→35, `files/` 29→30, `tasks/` 53
   unchanged but with two new modules).
10. **`@playwright/mcp` and the browser mount** are unchanged, but
    `resolveBrowserMcp` is at **:100** (was :93), `BROWSER_MCP_NAME` **:50**,
    `playwrightMcpCliPath` **:76** (:69), `browserPersonaSection` **:157** (:150),
    and the `specialist-run.server.ts` wiring anchors are **:1235 / :1241 / :1268
    / :1466 / :1857 / :2287-2311** (were :1184 / :1190 / :1217 / :1397 / :1212 /
    :2190-2264).
11. **`org/resources.server.ts` anchors moved**: `discoverStdioMcpTools` **:963**
    (was :811), `defaultSpawn` **:854** (:765), `INSTALLING_RE` **:1045** (:897),
    `isReservedMcpName` **:1289** (:1055), `saveMcpServer` **:1415**,
    `testMcpServer` **:1626** (:1412). `McpView` is **:534** (:507),
    `StdioDiscovery` **:914** (:774).
12. **`ops/` anchors moved**: `runMaintenancePass` **:142** (was :124),
    `activeRunCount` **:120** (:103), `pruneRuntimeTranscripts` **:178** (:175),
    `measureDataRootSpace` **:102** (:96), `cachedDataRootSpace` **:138** (:132),
    `DISK_MEASUREMENT_TTL_MS` **:128** (:122), `classifyFreeBytes` **:88** (:82),
    `getBuildInfo` **:129** (:121), `resolveBuildInfo` **:106** (:98).
13. **`file-watch.service.server.ts` `startFileWatcher` is :132** (was :106) and
    `kb-watch.service.server.ts` `startKbWatcher` is **:72** (was :52).
14. The pass-20 doc had no §10 (delivery), §14 (operator loop) or §15
    (notifications) at all, and no §12/§13 (they did not exist yet).
