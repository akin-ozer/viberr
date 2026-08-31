# 01 — Server core & domain model (pass 31, 2026-08-31)

Audience: an implementer who must change server code without re-reading the tree.
Everything below is cited `path:line`. Paths are repo-relative to
`/Users/akinozer/projects/viberr`.

---

## 0. The one-paragraph model

Viberr is **file-canonical with a SQLite projection**. The business truth for
projects, tasks and goals is Markdown-with-YAML-frontmatter under
`${VIBERR_DATA_ROOT}`; `state/projection.sqlite` is a *derived read model* for
those three entity kinds and **primary storage** for everything app-owned
(users, sessions, PATs, audit, notifications, runs, org resources). Every UI
action is a React Router route `action` that (a) checks CSRF + authority, (b)
performs a locked read-modify-write on the canonical `.md`, (c) synchronously
re-projects that one file, (d) emits an in-process projection event which the
SSE broker fans out. A chokidar watcher does the same for hand edits. There is
exactly **one app process per data root, ever** — enforced by an O_EXCL
`writer.lock`.

Layer map (`docs/architecture/file-formats.md:1`, `docs/architecture/decisions.md`):

```
routes/*.tsx  action()  ──▶ app/server/tasks/*.server.ts     (governed mutations)
                            │  authority: app/shared/rbac.ts + auth/project-authority
                            ▼
                        app/server/files/*.server.ts          (atomic locked writers)
                            │  parse/serialize: app/schemas/*.schema.ts (tolerant)
                            ▼
                        app/server/projections/rebuilder.server.ts   (files → sqlite)
                            │
                            ├─▶ app/server/events/projection-events.server.ts (EventEmitter)
                            │        └─▶ events/event-publisher → events/sse-broker → clients
                            └─▶ app/server/provenance/ (audit trail of every projection act)
```

---

## 1. Event-sourcing / file-native architecture

### 1.1 Data-root layout

`DATA_ROOT_SUBDIRS` — the complete set created at boot —
`app/server/files/file-store-root.server.ts:26-40`:

```
${VIBERR_DATA_ROOT}/
  projects/<slug>/project.md                 ← project truth
  projects/<slug>/tasks/<KEY>/task.md        ← task truth
  projects/<slug>/tasks/<KEY>/attachments/   ← browser-run outputs (member-only route)
  projects/<slug>/tasks/<KEY>/workspace/     ← git clone; NOT canonical, NOT watched
  projects/<slug>/goals/<id>.md              ← chained-goal truth (ruling 99)
  agents/profiles/<id>.md                    ← org agent-profile templates
  runtimes/claude-home/ runtimes/codex-home/ ← NDJSON run logs + SDK session homes
  kb/<dir>/    skills/<slug>/                ← knowledge bases + skills
  state/projection.sqlite                    ← the projection DB
  state/writer.lock                          ← single-writer lock (not in SUBDIRS)
```

There is deliberately **no** `cache/`, `auth/` or `logs/` dir (P11-56;
`docs/architecture/file-formats.md:28`). Logs are structured JSON on stdout.

Path helpers (all take an optional `dataRoot` override for tests):
`getDataRoot` `:43`, `ensureDataRootDirs` `:48`, `projectFilePath` `:64`,
`taskDir` `:68`, `taskFilePath` `:72`, `taskAttachmentsDir` `:87`,
`goalsDir` `:96`, `goalFilePath` `:102`, `agentProfileFilePath` `:121`,
`kbDirPath` `:168`, `skillDirPath` `:178`, `storeRelativePath` `:187`.

**Traversal guard**: `resolveStoreSegment(root, name)`
(`file-store-root.server.ts:141`) rejects `""`, `.`, `..`, `/`, `\`, `\0` and
absolute paths, then re-checks the resolved child stays under root. Every
segment that can arrive from a form field, a `readdir`, or a profile's
`resources:` array goes through it — KB/skill content is injected as *trusted
persona material*, so an escape crosses a prompt trust boundary.

`VIBERR_DATA_ROOT` defaults to `./data` (`app/server/config/env.server.ts:80`);
compose points it at `docker-data`.

### 1.2 File format: frontmatter + sections

`splitFrontmatter` (`app/server/files/frontmatter.server.ts:31`):

- strips a BOM and normalizes `CRLF`/lone-`CR` → `LF` **before** the fence check
  (`:42-44`). F28-D2: without this a `---\r\n` file failed the opening-fence
  test and the *whole* file fell back to defaults — and the rebuilder projected
  that (the write-guard only refuses writes, never reads).
- missing fence → `frontmatter.missing` **hardStop** error `:47`;
  unterminated → `frontmatter.unterminated` hardStop `:59`;
  bad YAML → `frontmatter.invalid_yaml` hardStop `:77`.
- `toYaml` uses `lineWidth: 0` (no folding, round-trip friendly) `:91`.
- `serializeFrontmatterFile(known, unknown, body)` `:99` merges known keys in
  canonical order, then any unknown key not already present — **unknown
  frontmatter keys round-trip verbatim**.

`task.md` body grammar — parse/serialize in
`app/server/files/task-file.server.ts`:

- Sections split on `^## ` (`:61`, `splitSections` `:123`). Known: `Goal`,
  `Packet`, `Timeline`. Everything else is preserved verbatim in
  `extraSections` (including the pre-first-section preamble, title `""`).
- **Duplicate known section → FIRST occurrence wins**, the duplicate is kept as
  an extra section and flagged `body.duplicate_section` (warning ⇒ readiness
  floors at `input_required`) — `:450-459`, `:467-491`.
- Timeline entries are **newest first**; heading is
  `### <UTC ISO> · <type> · <actor-ref>` with `SEP = " · "` (U+00B7) `:63`.
  Optional metadata lines directly after the heading: `title: …`, `to: agent`
  (`:199-214`). Then blank line, then body text, then optional `evidence:` and
  `attachments:` blocks (`:216-266`).
- 11 event types, `TIMELINE_EVENT_TYPES`
  (`app/schemas/task-file.schema.ts:107-124`): `comment completion github policy
  note quality transition blocked agent assign continuity`. Unknown types are
  KEPT with a `timeline.unknown_type` info diagnostic and render as comments
  (`task-file.server.ts:175`).
- **Body-line escaping** is bijective. `STRUCTURAL_LINE_SRC` `:70` =
  `## |### |title:\s|to:\s|\s*evidence:\s*$|\s*attachments:\s*$`. Serialize adds
  one `\` to any line matching `^\\*(?:…)` `:72,76`; parse strips exactly one
  from `^\\+(?:…)` `:74,83`. Goal prose uses the narrower
  `NEEDS_SECTION_ESCAPE_RE = /^\\*## /` `:101` — only `## ` can close a section,
  and escaping `title:` in prose would mangle sentences. Without the goal
  escape, an agent-authored goal containing `## Timeline` could **forge the
  history the acceptance decision reads** (`:87-100`).
- Out-of-order timeline (external appenders adding at the bottom) is tolerated
  with a `timeline.out_of_order` info diagnostic `:514-525`.
- Malformed heading / unparseable timestamp → entry SKIPPED with a warning
  (`:149`, `:164`); the task itself is never dropped.

Packet section is a single fenced ```yaml block, parsed by `parsePacketSection`
`:345`. A packet with options but ≠1 `rec: true` emits `packet.rec_count` info
`:379-388`.

**Actor refs** — codec `app/server/files/actor-ref.server.ts`:

| kind | encoding | regex |
|---|---|---|
| human | `user:<id> (Name)` | `HUMAN_RE :28` |
| agent | `agent:<codex\|claude>/<profileId> (Role)` | `AGENT_RE :32` |
| operator | `operator` | literal `:98` |
| controller | `controller` | literal `:100` |
| system | `system:<id>` | `SYSTEM_RE :33` |
| unknown | verbatim raw | fallthrough `:122` |

`decodeActorRef` is **total** — it never returns null. VIB-12: a strict decoder
rejected `&` in a role slug, decode returned null, and the timeline parser
silently DROPPED the reviewer's comment on every re-parse (`:22-26`). Agent
identity is the **profileId**, never the role string (`:14-21`).
`sanitizeHint` `:66` strips ` · ` and newlines so a display hint can never
corrupt the heading it lives in.

Goal files (`app/schemas/goal-file.schema.ts`) use a deliberately *simpler*
grammar: `## Description` prose + `## Timeline` bullets `- <ISO> · <text>`
(`:14-17`) — single-writer app narration needs no escaping machinery.

### 1.3 Tolerant parsing + diagnostics

Contract (`app/schemas/file-diagnostics.ts:1-15`): parsing never throws, never
drops an entity; missing/invalid fields yield a fallback plus a
`FileDiagnostic { severity, code, path?, message, hardStop? }`.

Severity → readiness floor (`app/server/interpretation/diagnostics-policy.server.ts`):

| severity | floor | rank |
|---|---|---|
| `info` | none | — |
| `warning` | `input_required` | 1 |
| `error` | `inconsistency_risk_detected` | 2 |
| `hardStop` (any severity) | `blocked` | 3 |

`READINESS_RANK :20`, `readinessEffectOf :28`, `worstReadinessEffect :41`.
`referenceDiagnostics({stage, knownStageIds})` `:58` adds
`reference.unknown_stage` (warning) when the task's stage id is not in the
project's list — the *only* project-context check today.

`deriveReadiness` (`app/server/interpretation/readiness-policy.server.ts:36`)
is **THE** readiness derivation: stored readiness is respected, diagnostics can
only make it WORSE, never better (`:44-47`). `"accepted"` is a display state
derived from being in the terminal stage (`isAcceptedDisplayState :55`) and is
never stored.

Two parse helpers in the schemas, and the difference matters a lot:

- `tolerant(...)` — **whole-value**; a bad value falls back to the default
  (`task-file.schema.ts:1006`).
- `tolerantRows(...)` — **per-row**; one bad element drops only itself, with an
  indexed diagnostic (`:1051`). Used for `engagements`, `recommendations`,
  `schedules`, `verdicts`, `labels`. F18 reason (`:1041-1050`): the whole-array
  path emptied the ENTIRE list on one bad row, the diagnostic was only a
  warning (so the file stayed writable), and the next `updateTaskFile`
  serialized the emptied list back — a **durable, silent loss**. Project-file
  equivalent is `tolerantArray` (`project-file.schema.ts:295`), used for
  `stages`, `workflow`, `members`, `agents`, `guardrails` (a wiped `members[]`
  is an ACL wipe; a wiped `guardrails[]` reads as "everything off").

Identity rescue: task `key` falls back to the **directory name** and the
directory wins on mismatch (`frontmatter.key_mismatch`, error) —
`task-file.schema.ts:1169-1203`. Same for project `slug`
(`project-file.schema.ts:361-394`). A missing `stage` becomes `""` +
`frontmatter.unresolved_stage` warning, never an invented `triage`
(`task-file.schema.ts:1205-1231`) — the blank stage lands the card in the
board's "unknown stage" bucket instead of silently relocating it.

Extra invariants enforced at parse time in `parseEngagements`
(`task-file.schema.ts:1106`): profileId uniqueness (first wins,
`frontmatter.duplicate_engagement`) and **at most one `delivers: true`**
(extras demoted, `frontmatter.multiple_deliverers`).

### 1.4 Writers: atomic + mutex + write-guard + stale-read repair

`writeFileAtomic(absPath, content)` — `app/server/files/atomic-file.server.ts:31`:
mkdir -p, write `<file>.<8 hex>.tmp`, `rename` over the target. On failure the
tmp file is `rmSync`'d (Gap 16 — failed writes used to leak permanent litter the
watcher ignores). `ENOSPC` → a named error `:57`; `ESTALE`/`EIO` → a typed 503
`AppError` "data root unreachable" `:69-77` (F20-1: a dead VirtioFS bind mount
used to peg the event loop instead of erroring).

`withFileLock(key, fn)` — `app/server/files/file-mutex.server.ts:1` — is a
one-line wrapper over the Web Locks API (`navigator.locks.request`). Per-file,
in-process only.

`updateTaskFile(ref, mutate)` — `app/server/files/task-writer.server.ts:165` —
is the single locked read-modify-write:
1. `withFileLock(absPath, …)`
2. `readTaskFile` (404 if absent)
3. `repairStaleRead` `:91`
4. `assertTaskFileTrusted` `:144`
5. `mutate(parsed)`, then `frontmatter.updatedAt = now`
6. `serializeTaskFile` → `writeFileAtomic` → `rememberWrite`

**Write guard** (`taskFileWriteBlockers :138`, `assertTaskFileTrusted :144`):
any `hardStop` diagnostic refuses the write with
`ERROR_CODES.FILE_NOT_TRUSTED` / 409. Gap 22: tolerant parsing is right for
reading and catastrophic for writing — appending one comment to a file with
unparseable YAML serialized the DEFAULTS over it (owner, stage, engagements, PR
link gone) and an unterminated fence also erased the goal and whole timeline.
`hardStop` is exactly the right line: unknown fields, unknown sections and
skipped timeline entries are *not* hardStop and still write.

**Stale-read repair** (`repairStaleRead :91`, project twin
`project-writer.server.ts:75`): on VirtioFS a read milliseconds after this
process's own rename can return the PREVIOUS content. Live VIB-1 2026-07-17: a
reviewer comment landed, the verdict write 2 ms later read pre-comment content
and erased it. `lastWritten: Map<path,{content,wroteAtMs}>` (cap 500,
insertion-ordered eviction `:69-80`); if the locked read disagrees AND
`mtimeMs <= wroteAtMs + 100`, our own write wins. An external editor bumps mtime
past the slack and wins as before.

Other writers with the same shape: `createTaskFile :190`,
`appendTimelineEvent :225` (unshift = newest-first prepend),
`patchTaskFrontmatter :237`, `updateProjectFile
(project-writer.server.ts:100)`, `createProjectFile :120`,
`createGoalFile`/`updateGoalFile` (`files/goal-writer.server.ts:228,265`,
with a whole-`goals/`-dir lock `withGoalsLock :220`).

**Task key allocation** — `allocateTaskKey`
(`project-writer.server.ts:166`): under the project.md mutex, read
`nextTaskNumber`, take `max(counter, scanMaxTaskNumber(prefix)+1)` `:177-178`,
persist `next+1`, return `<PREFIX>-<n>`. The dir scan `:147` rescues a stale or
missing counter. Concurrent creates can never mint the same key.

### 1.5 Projections: files → SQLite

`app/server/projections/rebuilder.server.ts` (1199 lines) is the ONLY writer of
`projects`, `project_members`, `task_projections`, `task_events`,
`goal_projections`, `diagnostics`.

Entry points:
- `rebuildPath(db, absPath, opts)` `:938` — routes an absolute path by regex:
  `TASK_PATH_RE :930`, `PROJECT_PATH_RE :931`, `GOAL_PATH_RE :932`; anything else
  is `ignored`. **All throws are caught here** `:958` → logs "projection rebuild
  failed", records `action: "error"` provenance, returns `{action:"error"}`.
- `rebuildProjectFile :159`, `rebuildTaskFile :376`, `rebuildGoalFile :733`.
- `rebuildProject(db, slug)` `:982` — project-scoped rescan + prune (F20: the
  Board "Re-scan" gate is project-scoped, so its effect must be too).
- `rebuildAll(db)` `:1085` — full walk + prune of vanished rows.

**Content-hash short-circuit**: `sha256(content)` `:97` compared against the
row's `content_hash`; equal + not `force` ⇒ `unchanged`, no provenance row
(`:196`, `:426`, `:769`).

**Sentinel-hash commit marker (F28-D3)**: the row is INSERTed with
`content_hash = ""` (`:239`, `:629`) and the real hash is written **last**
(`:264`, `:708`) after `project_members` / `task_events` / `diagnostics` have
landed. A crash mid-projection therefore leaves an unmatched hash and the next
rebuild re-runs instead of short-circuiting on a torn row. Removals delete
dependents FIRST and the probe's own row LAST for the same reason (`:174-177`,
`:396-404`).

**Project→task cascade**: project-derived data (stage-reference diagnostics,
effective repo, guest flags) is baked into task rows, so a changed project row
force-reprojects every task `:281-288`. `rebuildAll`/`rebuildProject` pass
`skipTaskCascade: true` and do their own forced walk instead (`:1011`, `:1130`)
so tasks are not projected twice per rescan.

**Derivations performed at projection time** (`rebuildTaskFile`):
- `derivedValidation = deriveValidation(fm)` `:443` — the column carries the
  FRESH derivation, never `fm.validation` (which is only a cache). UX19-3: a
  stale cache put "validation healthy" on the card while the gate one argument
  away read "no approving verdict yet".
- `acceptanceBlockReason(fm, {validation, blockedPacket})` `:340` →
  `validation_block_reason`. Order mirrors `acceptanceRefusalReason`:
  `closedPrBlockedReason` → `acceptanceBlockedReason` → `verdictGateReason` →
  open blocked packet → `conflictingPrBlockedReason`. Three gates are
  deliberately absent: `archived` and the STAGE boundary (per-reader state every
  consumer filters on) and the no-change WORK refusal (needs a live async GitHub
  probe) — documented at `:303-338`.
- `projectedWaiting` `:481` — a task in the **terminal stage** projects
  `waiting: "none"` regardless of the file (LV-20: a Done+merged task reported
  "Waiting on: Human decision" forever). The canonical file is untouched.
- `continuity` `:520` — `"degraded"` iff the timeline carries any `continuity`
  event.
- `storedReadiness` is NULL when a `readiness`-path diagnostic exists `:490-491`.
- `specialist_json` = `deliveringEngagement(fm)`, `reviewers_json` =
  `supportingEngagements(fm)` `:594-595` (derived legacy shapes).
- `repo` = `project?.repo ?? null` unconditionally `:598` (P13-D-5: no
  task-level override).

`task_events` are **replaced wholesale** per task (`DELETE` then re-INSERT with
`position` = file order, 0 = newest) `:633-685`. Actor kind/ref are flattened
and `actor_json` carries a denormalized render snapshot resolved through
`createActorResolver` `:507` (so events survive member removal).
`unknown` actors project as `system` so their events stay visible (D7 `:646-655`).

**Goal link reconciliation** `:811-844`: link statuses stored in the goal file
are the advance engine's *claims*; the projection re-derives from live task rows
— archived ⇒ `failed` (unless already `done`), terminal stage ⇒ `done`, and a
stored `done`/`failed` contradicted by a live non-terminal task ⇒ `active`.
`skipped` is never overridden. An unparseable goal file records `action:"error"`
provenance + diagnostics and **leaves the existing row standing** `:783-801`
(visible-but-stale beats vanished).

Every acting rebuild records provenance (`recordProvenance`,
`app/server/provenance/provenance-recorder.server.ts:49`) with
`action ∈ projected | removed | error | rescan`.

### 1.6 Watchers (chokidar)

`startFileWatcher` — `app/server/files/file-watch.service.server.ts:133`.

- Watches `projectsDir()` only `:152,271`; `ignoreInitial: true`,
  `followSymlinks: false`, `atomic: true` `:271-276`.
- Ignore matcher `shouldIgnoreWatchPath :104`: any dot-prefixed path segment,
  any `*.tmp`, and anything deeper than 4 segments that is not exactly
  `<slug>/tasks/<KEY>/task.md` `:110-111`. This prunes traversal into
  `workspace/` clones entirely (F-SPAWN1).
- `WATCH_DEBOUNCE_MS = 250` `:33`, trailing debounce **per path**, separate
  `fileTimers` / `dirTimers` maps `:114-125`.
- Handled events: `add`/`change`/`unlink` → `onFile :258` (accepts
  `project.md`, `task.md`, and `<slug>/goals/<id>.md` `:261-266`);
  `unlinkDir` → `rebuildDir :183`, which maps a vanished directory onto the
  rows it backed (projects root → every project; `<slug>` or `<slug>/tasks` →
  whole project incl. explicit task-row prune, since a `projects` row deletion
  does NOT cascade task rows `:196-205`; `<slug>/goals` → prune goal rows;
  `<slug>/tasks/<KEY>` → schedule the task.md removal).
- Error handling `:285`: `ENOENT` is logged at debug and **ignored** (deleting a
  subtree races chokidar's bookkeeping and killing the watcher there cancelled
  the queued reconcile). Any other error clears the handle so
  `isFileWatcherAlive() :350` and `/resources/health` report the truth; a
  transient errno (`EMFILE ENFILE ENOSPC EPERM EACCES`) schedules ONE owned,
  generation-guarded 2 s re-arm `:317-338` (F10-08 — the old un-owned timer
  resurrected watchers after teardown in an unbounded loop).
- HMR-safe via `Symbol.for("viberr.fileWatcher")` + a separate lifecycle slot
  carrying `{generation, reArmTimer}` `:48,68`.

`startKbWatcher` (`app/server/files/kb-watch.service.server.ts`) is the
knowledge-base twin: re-index a KB when its store files change.

`ignoreInitial: true` pairs with the **boot rescan** — offline drift is
reconciled before the watcher starts (`:22-28`). Route actions project
synchronously and never depend on the watcher.

### 1.7 Projection events → SSE

`app/server/events/projection-events.server.ts` is a `node:events` EventEmitter
on `Symbol.for("viberr.projectionEvents")`, channel `"projection"`, max
listeners 100 `:54-77`.

`ProjectionEvent` union `:11-52`: `task.updated`, `task.removed`,
`project.updated`, `project.removed`, `projection.rebuilt`,
`notification.created`, `notification.read`, `violation.updated`,
`goal.updated`. Payloads are **compact facts + references, never fat objects**.

`collectProjectionEvents(fn)` `:108` defers emission into a module-local buffer
so a write transaction's subscribers never observe uncommitted state; a throw
DISCARDS the buffer. Nested collections buffer into the innermost.

`onProjectionEvent(listener)` `:123` returns an unsubscribe.

The wire contract is `app/schemas/sse-event.schema.ts`: `SSE_EVENT_NAMES :22`
adds `run.log-appended`, `run.state-changed` (published straight to the broker
from the run service, not through the projection emitter),
`controller.updated`, plus the broker control events `stream.open` (carries the
head event id for resume) and `stream.resync` (Last-Event-ID predates the ring
buffer). Every payload is `{type, entityId, occurredAt, data}` and is
zod-parsed before it goes on the wire `:56`.

`armProcessShutdown()` (`events/sse-broker.server.ts:412`) just materializes the
broker state so its signal handlers are registered. `runProcessShutdown() :416`
runs, in order: close SSE connections → `stopFileWatcher()` →
`stopKbWatcher()` → `stopDataRootLockGuard()` → `shutdownDatabase()` →
`releaseDataRootLock()`. Both watchers are detached BEFORE the DB closes so no
debounced rebuild fires into a shut-down database.

### 1.8 SQLite: WAL, pragmas, migrations, self-heal

`openDatabase(dbPath)` — `app/server/db/sqlite.server.ts:12` — sets
`journal_mode = WAL`, `foreign_keys = ON`, `busy_timeout = 5000`.
`openDatabaseReadOnly :29` exists for the read-only CLIs (`npm run backup`,
`npm run keys -- status`) which must work against a LIVE instance and therefore
cannot take the writer lock; it runs **no** migrations.

`getDb()` `:82` is the process-wide handle behind `Symbol.for("viberr.db")`,
lazily opening + migrating + `ensureSingleFlightIndexes`. After
`shutdownDatabase()` `:158` it **refuses to reopen** (`DB_SHUTDOWN_KEY`, F21-24 —
a request arriving during the drain used to re-open the DB and re-run migrations
on a process that had just released it). `shutdownDatabase` does
`PRAGMA wal_checkpoint(TRUNCATE)` then closes; the flag latches in a `finally`.

`ensureSingleFlightIndexes(db)` `:114` is an idempotent `IF NOT EXISTS` backstop
for indexes added to the baseline after a root already applied it — needed
because migrations are **squashed**.

`runMigrations(db, dir)` — `app/server/db/migration-runner.server.ts:28`:
applies `db/migrations/*.sql` in filename order, each inside its own
transaction with its `schema_migrations` row; **skips by FILENAME alone**. A
failure becomes `ERROR_CODES.DB_MIGRATION_FAILED` `:71`.

**The squashed-baseline convention** (`db/migrations/0001_baseline.sql:10-19`):
pre-prod, schema changes are edited INTO `0001_baseline.sql`. Because the runner
skips by filename, editing it reaches **fresh databases only** — an existing
root keeps its old schema and every projection write touching a new column
throws. There is no drift healer. The remedy is to wipe and re-seed
(`npm run seed -- --reset`), which regenerates user ids because auth lives in
the same file.

Boot therefore *detects* the drift in two ways
(`app/server/boot.server.ts`):
- `projectionValidationGaps(db) :160` — reads the live
  `task_projections` DDL out of `sqlite_master` and reports which
  `VALIDATION_VALUES` members its CHECK refuses. F21-1: `bypassed` was missed,
  so reprojecting a force-accepted task with a `workRevision` aborted with
  "CHECK constraint failed", `rebuildPath`'s catch swallowed it as "projection
  rebuild failed", and the row went stale with nothing saying why.
- `projectionMissingColumns(db) :198` — runs the real migrations against a
  throwaway `:memory:` DB and diffs `PRAGMA table_info` for
  `task_projections` + `task_events`. A missing column fails EVERY task's
  INSERT ("no such column").

Both feed `logBootIntegrity :242`, which emits one `boot integrity check` info
line and, on drift, a separate loud WARN carrying impact + remedy `:291-319`.

`selfHealProjectionDbIfCorrupt(path)`
(`app/server/db/self-heal.server.ts:202`, called at `boot.server.ts:588`)
runs BEFORE the first handle opens: if the file is corrupt it salvages the
non-reconstructable rows, moves the corrupt file aside for forensics and builds
a fresh valid one; projections rebuild from `.md` on the boot rescan.
`isCorruptionError :55`, `projectionDbState :113`.

Retention: `applyRetention` (`app/server/db/retention.server.ts:66`) with
`RUN_LOG_RETENTION_DAYS = 30 :28`, `AUDIT_RETENTION_DAYS = 90 :30`,
`NOTIFICATION_MAX_PER_USER = 500 :54`, and `IDEMPOTENCY_AUDIT_ACTIONS :49`
(rows retained longer because they back idempotency checks).

Backup/restore: `createBackup :177` / `restoreBackup :442` /
`restoreStoreFile :600` (`app/server/db/backup.server.ts`), format
`viberr-backup/1 :67`, `BACKED_UP_STORE_DIRS = projects agents kb skills :74`,
`OPTIONAL_STORE_DIRS = runtimes :82`.

### 1.9 The single-writer lock

`app/server/db/data-root-lock.server.ts` — **the** most important operational
invariant. ONE app process per data root, EVER (B-FD1). It has bitten this
project twice: a host dev server + compose container sharing `docker-data` over
VirtioFS clobbered the WAL and ate PATs and run logs; and the run pipeline's
handles/completion callbacks are per-process globals, so process B "interrupts"
a run process A is still driving (`:19-47`).

- Lock file `state/writer.lock` (`DATA_ROOT_LOCK_FILENAME :50`), created with
  `openSync(path, "wx")` — O_CREAT|O_EXCL, atomic on local FS and bind mounts
  (`writeLockFile :444`).
- Holder JSON: `{pid, hostname, startedAt, bootId?, procStartedAt?}`
  (`LockHolder :58`). `bootId` is a per-PROCESS `randomUUID` on
  `Symbol.for("viberr.processBootId")` `:192-207` — needed because compose PINS
  the hostname, so "same host" is trivially true for every container from that
  file and two containers routinely land on the same low pid.
  `procStartedAt` is field 22 of `/proc/<pid>/stat` (`readProcessStartTicks :250`,
  parsed after the LAST `)` because `comm` can contain spaces/parens).
- `classifyLock(holder, self, isAlive, readProcStartTicks) :307` — verdicts
  `stale | held | unknown-holder`:
  1. `holder.bootId === self.bootId` ⇒ **stale** (our own HMR-orphaned lock).
  2. different hostname ⇒ **held** (we cannot probe that pid — this is exactly
     the docker-data incident shape).
  3. `holder.pid === self.pid` with a recorded `procStartedAt` ⇒ compare live
     start ticks: equal ⇒ held, different ⇒ stale. **F20-8(b)**: the app runs as
     pid 1 and compose pins the hostname, so a crashed predecessor left
     `writer.lock` naming pid 1 on this exact host and `isAlive(self.pid)` was a
     self-probe that always said "alive" — nine consecutive boot refusals,
     RestartCount 11, until the file was deleted by hand.
  4. otherwise `isAlive(holder.pid)` — `EPERM` counts as alive `:239`.
- `acquireDataRootLock :458` retries 3× (each takeover unlinks and retries, so
  a competing process that wins the re-create is refused). Refusal is a
  `DataRootLockedError` whose `message` (`refusalMessage :404`) names the holder
  and both remedies (delete the file, or `VIBERR_FORCE_DATA_ROOT_LOCK=1`).
- Release: `release()` unlinks + closes; `abandon()` closes WITHOUT unlinking
  (the file now belongs to whoever replaced us) `:507-524`. Registered on
  `process.once("exit")` AND called explicitly by the signal shutdown, because
  the app's handler **re-raises** SIGINT/SIGTERM so Node's `exit` event never
  fires on `docker compose stop` (`releaseDataRootLock :222`, docblock `:209-221`).
- **Fail-closed ownership guard** `startDataRootLockGuard :614`, interval
  `DATA_ROOT_LOCK_GUARD_INTERVAL_MS = 20_000 :555`. Every tick
  `verifyLockOwnership :379`: fstat our fd → stat the path (ENOENT ⇒ stolen) →
  compare inode+dev → and, when our identity carries a `bootId`, re-read the
  file and check it still names us (VirtioFS synthesizes inode numbers). A
  `stolen` verdict calls `loudlyShutDownOnStolenLock :584`, which
  `writeFatalSync`es the diagnosis to stderr **synchronously**, `abandon()`s and
  `process.exit(1)`. `unverifiable` (a torn read) retries next tick. F18-5: a
  store reset that deleted `state/` left this process writing lock-less while a
  second one booted into the freed path.

CLI counterpart: `acquireCliWriterLock` / `runWithDataRootWriterLock`
(`app/server/db/cli-lock.server.ts:89,109`) for write-mode scripts.

### 1.10 Boot ordering (`app/server/boot.server.ts:531` `bootServer`)

Exact sequence — this order is load-bearing:

| # | step | line | why here |
|---|---|---|---|
| 0 | `installCrashVisibilityHandlers()` | `:534`, def `:96` | F20-8(a) — a fatal must never vanish; `writeFatalSync` flushes ONE sync stderr line before `process.exit`. Handlers suppress Node's own crash-and-exit so each exits itself. |
| 1 | `bootFlags()[BOOT_KEY]` re-entry guard | `:535-536` | HMR-safe idempotence via `Symbol.for("viberr.booted")`. |
| 2 | `getEnv()` + `BETTER_AUTH_URL` warnings | `:538-557` | fail fast on bad config; warn on OAuth-without-URL and on `http://` origin in production (`insecureAuthOriginWarning`). |
| 3 | `ensureDataRootDirs()` | `:559` | |
| 4 | **`takeDataRootWriterLock(env)`** | `:565`, def `:499` | BEFORE anything opens the DB or writes a file. A `DataRootLockedError` is printed to stderr and `process.exit(1)` — a refusal, not a crash (boot is awaited from `entry.server.tsx` module scope, so a throw would render an SSR stack trace instead of the diagnosis). |
| 5 | `armProcessShutdown()` | `:570` | registers the handler that RELEASES the lock. Used to ride on the first SSE publish, so a store that emitted nothing left the lock behind. |
| 6 | `startDataRootLockGuard()` | `:576` | F18-5 fail-closed guard. |
| 7 | `seedDefaultAgentAssets()` | `:581` | ships default agent skills/definitions/profile templates before anything reads them; idempotent, best-effort. |
| 8 | `selfHealProjectionDbIfCorrupt(getProjectionDbPath())` | `:588` | before the first handle opens. |
| 9 | `getDb()` (opens + migrates) | `:601` | |
| 10 | `await seedInitialAdmin(db, …)` | `:603` | |
| 11 | `startEventPublisher()` | `:610` | SSE bridge FIRST so the rescan below and every later mutation reach clients. |
| 12 | `rescanProjections(db)` | `:617` | reconciles edits made while down (the watcher's `ignoreInitial` cannot see them). Hash short-circuit makes it cheap. Failures never block boot. |
| 13 | `ensureBaseAgentsDeployed(db)` | `:634` | after the rescan (project list populated), before the watcher (no concurrent writer). |
| 14 | `startFileWatcher()` | `:643` | |
| 15 | `startKbWatcher()` | `:647` | |
| 16 | `startStoreMaintenance(db)` | `:654`, def `:346` | `reapStaleWarmups` (R19-18: MCP installs belong to the process that started them) → `runMaintenancePass({reason:"boot", reclaimWorkspaces:false})` → `startMaintenanceScheduler`. **`reclaimWorkspaces:false` is deliberate** — the reclaim belongs to step 17. |
| 17 | `void reconcileRestartedWork(db)` | `:660`, def `:411` | fire-and-forget; must not hold up serving. |
| 18 | `startScheduleRunner(db)` | `:666` | fires due schedules once, then on an interval; unref'd. |
| 19 | `startGithubReconcilePoller(db)` | `:672` | boot + every 5 min. |
| 20 | `startGoalRunner(db)` + `recoverControllerConversations(db)` | `:678-680` | |
| 21 | `logBootIntegrity(db)` | `:687` | |

`reconcileRestartedWork` `:411` is itself a strictly ordered chain:
0. `finalizeOrphanedRuns(db)` — a run row left `running`/`queued` has no live
   process in a fresh boot; finalize to `error` and re-invoke the operator. Its
   `.reinvokes` promise is **kept** and joined at `:446`.
1. `await recoverUnreactedAgentRuns(db)` — a run that finished before its
   in-process reply callback fired.
2. `await recoverStrandedOperatorPlans(db)` — Codex operators coordinate AFTER
   the run finishes, so a restart loses the whole turn.
3. workspace reclaim — **only after** joining `orphanReinvokes`, and **only if
   `activeRunCount(db) === 0`** `:455`. P14-RT-09: the reclaim used to run right
   after *scheduling* step 1 while claiming to run after it, so a recovered
   run's delivery reconcile could race the `rmSync` of the workspace it reads.
   Every step is self-catching; one failure never stops the next.

---

## 2. Domain model

### 2.1 Canonical (file) entities

**Project** — `projects/<slug>/project.md`.
Schema `app/schemas/project-file.schema.ts:196` (`projectFrontmatterSchema`),
keys in canonical write order at `:213`.

| field | type | notes |
|---|---|---|
| `name` | string | falls back to slug |
| `slug` | `/^[a-z0-9][a-z0-9-]*$/` | directory name wins on mismatch |
| `archived` | bool? | archived projects are **read-only** (R6-3) |
| `repo` | `owner/name` \| null | ONE repo per project (P13-D-5) |
| `defaultBranch` | string | default `main` |
| `taskPrefix` | `/^[A-Za-z]+$/` | derived from slug when absent (`derivePrefix :344`) |
| `nextTaskNumber` | int \| null | atomic key counter |
| `stages[]` | `{id,name,color}` | `stageSchema :40`; per-project, ordered; empty ⇒ `project.no_stages` error |
| `workflow[]` | `{from,to,boundary,by,locked}` | `workflowBoundarySchema :50`; `BOUNDARY_VALUES = auto\|approval\|human :28` |
| `members[]` | `{userId, role}` | `PROJECT_ROLES = admin\|maintainer\|contributor\|viewer :23`; **files are the ACL truth**, `project_members` is its projection |
| `agents[]` | `AgentDeployment` | `:128` — `{profileId, capabilities[], extras[], definition?}` |
| `credentialPolicy` | `{credentialLabel, masked, requiredScopes[]}` \| null | NON-secret; the PAT is sealed in SQLite |
| `guardrails[]` | `{id,desc,on,value?,unit?}` | defaults `DEFAULT_GUARDRAILS` (`app/shared/workflow/templates.ts:88`) |

Markdown body = the project description.

**AgentDeployment.definition** (`:85` `agentDeploymentDefinitionSchema`) is the
loose per-project override: `kind, name, role, icon, backends[], model, effort,
scope, desc, persona, stages[], spanAll, autonomy (supervised|full),
resources{skills[],mcps[],kb[]}`.

**Two-layer agent model**: `agents/profiles/<id>.md` are ORG templates
(backends, eligible stages, base capability policy, resources, markdown-body
persona); a project's `agents:` list *deploys* a template by `profileId` and
carries the project-effective capability policy
(`docs/architecture/file-formats.md:116-124`, `:387-424`). Task assignments
store `profileId` — never joined by role text.

**Task** — `projects/<slug>/tasks/<KEY>/task.md`.
Fields `app/schemas/task-file.schema.ts:589` (`taskFrontmatterFields`), write
order `TASK_FRONTMATTER_KEYS :946`.

| field | type | line |
|---|---|---|
| `key` | `/^[A-Za-z]+-\d+$/` | `:590` |
| `title` `stage` | string | `:591-592` |
| `previousStageId` | string\|null | `:598` — where the task CAME from (ruling 98) |
| `readiness` | `READINESS_VALUES` = `ready \| input_required \| inconsistency_risk_detected \| blocked` | `:25` |
| `waiting` | `human \| agent \| none` | `:33` |
| `ownerUserId` | string\|null | one human owner |
| `engagements[]` | `Engagement` | `:184` |
| `operator` | `{assignedAtStageId}` \| null | `:226` |
| `recommendations[]` | `Recommendation` | `:257` |
| `schedules[]` | `TaskSchedule` | `:305` |
| `urgent` / `priority` / `labels[]` / `dueDate` | bool / `low\|normal\|high\|urgent` `:46` / string[] / `YYYY-MM-DD` | `urgent` is derived from `priority` at write time |
| `archived` | bool | R14-3 |
| `validation` | `healthy\|changed\|failing\|none\|bypassed` `:42` | DERIVED cache |
| `workRevision` | `WorkRevision` \| null | `:538` |
| `verdicts[]` | `ReviewVerdict` | `:568` |
| `branch` | string\|null | |
| `pr` | `PrRef` \| null | `:406` |
| `noChanges` | bool? | R17-2/R19-8 |
| `acceptance` | `"forced"` \| null | N20-14 |
| `github` | `GithubCache` \| null | `:446` |
| `goalRef` | `{goalId, linkIndex}` \| null | ruling 99 |
| `createdAt` `updatedAt` `boardRank` | | |

`repo` is **not** in the schema (P13-D-5) — an existing `repo:` line is an
unknown key, preserved verbatim and read by nothing (`:636-639`).

Sub-shapes:
- `Engagement :184` — `{profileId, backend, role, delivers, verdictCapable,
  pinnedBackend?}`. At most one `delivers: true` (workspace/branch/PR owner).
  `verdictCapable` is a snapshot of an EXPLICIT `report-validation-verdict:
  direct` grant taken at engage time — it makes a supporting engagement a
  REQUIRED reviewer without any live profile lookup `:191-196`.
  `pinnedBackend` is a *sticky* retry pin from `retry_other_backend` that
  outranks the live profile's primary `:197-205`.
  Helpers: `deliveringEngagement :211`, `supportingEngagements :218`,
  `requiredReviewers :707`, `currentVerdicts :712`.
- `Recommendation :257` — `{id, kind, profileId?, prompt?, delivers?,
  toStageId?, label, detail}`; `RECOMMENDATION_KINDS = transition | run_agent |
  accept_completion | delivery :235`. Several may be pending at once (unlike a
  packet, which is a single decision).
- `TaskSchedule :305` — `{id, action, dueAt, profileId, prompt, createdBy,
  createdByLabel, createdAt, status, firedAt, claimedAt, retries}`.
  `SCHEDULE_ACTION_TYPES = run-operator | run-agent :289`;
  `SCHEDULE_STATUS_VALUES = pending → claimed → fired | failed | cancelled :297`.
  `claimed` reserves the occurrence *before* the detached enqueue so a crash is
  recoverable; a claim past `CLAIM_LEASE_MS` (`tasks/schedule.server.ts:321`)
  is re-driven. R22: a schedule pins only the profile *id* — backend/model/
  capabilities resolve from the LIVE deployment at fire time `:313-323`.
- `PrRef :406` — `{number, state, title, checks?, review?, mergeable?,
  revisionDrift?}`. `PR_STATE_VALUES = review|merged|closed|accepted :349`;
  `PR_REVIEW_VALUES = approved|changes_requested|review_required :366`;
  `PR_MERGEABLE_VALUES = clean|conflicting|unknown :391`. `checks/review/
  mergeable` are optional KEYS: absent ≠ "no checks", it means "never read", and
  writers omit rather than persist null. Every one carries `.catch(null)` so a
  hand-edited garbage value cannot null the WHOLE ref (which the next write
  would persist) `:414-439`.
- `WorkRevision :538` — `{id, headSha, treeSha, branch, createdAt,
  sourceProfileId, kind?}`; `kind ∈ delivered | verified`, ABSENT reads as
  `delivered` `:550-560`.
- `ReviewVerdict :568` — `{profileId, revisionId, headSha, result, reason, at}`;
  `REVIEW_VERDICT_RESULTS = approve | request_changes :565`.
- `TaskPacket :500` — `{id?, type: input|blocked, kind, from, title, body,
  observations[], options[], awaiting?, askedBy?}`.
  `PacketOption :477` = `{kind, t, d, rec, ev?, backend?, profileId?,
  deleteBranch?}`. **`PACKET_OPTION_KINDS` :128 is the source of truth** — today
  ten: `accept_completion, request_edit, block_on_policy, hold_runtime_debug,
  redirect, retry_other_backend, edit_goal, archive_task, discard_branch,
  custom`. Re-derive the count from the constant, never from prose.
- `EvidenceRow :1489` — `{label, add, del}`; `EVIDENCE_MAX_ROWS = 8 :1497`,
  label cap 200 chars `:1503`, count cap 16 `:1504`, empty column sentinel
  `EVIDENCE_EMPTY_COLUMN = "—" :1514` (a truly empty column collapses the row to
  two segments and the parser drops it). `normalizeEvidenceRows :1531` flattens
  newlines and strips ` · ` from count columns so a row can never forge columns.
- `sanitizeEventAttachmentNames :1574` — `EVENT_ATTACHMENTS_MAX = 20 :1564`,
  rejects path separators, control chars, and names that do not survive the
  parser's `trim()`.

**Goal (chain)** — `projects/<slug>/goals/<id>.md`,
`app/schemas/goal-file.schema.ts:68`.
`{id, title, status, createdBy, createdByLabel, onFailure, links[], createdAt,
updatedAt}`. `GOAL_STATUS_VALUES = active|paused|attention|completed|cancelled
:32`; `GOAL_LINK_STATUS_VALUES = pending|active|done|failed|skipped :41`;
`GOAL_ON_FAILURE_VALUES = pause|continue :50`.
`GoalLink :53` = `{index (1-based), title, goal, taskKey, status, note}`.
Helpers `allLinksSettled :125`, `currentLinkIndex :134`.
`createdBy` is the authority chain advancement **re-proves** (their live
`create-task` in this project) every time a link task is created with nobody
present `:72-74`. **Goal files are never deleted by the product.**

**Agent profile template** — `agents/profiles/<id>.md`
(`docs/architecture/file-formats.md:387`): `{id, kind: operator|specialist|
controller, name, role, desc, icon, backends[], model, scope, stages[],
spanAll, capabilities[], extras[], resources{skills,mcps,kb}}` + markdown-body
persona. Reader: `app/server/files/agent-profile-file.server.ts`.

> **`resources:` values are STORE FOLDER NAMES, never display names.** For
> skills/mcps the slug *is* the folder so they coincide; for KB they do not — a
> KB has a display name and a `dir` as separate columns. A `kb:` entry written
> as the display name resolves to nothing: `readKbBody` returns `""` with only a
> `logger.warn`, so the run proceeds *without* the KB while every UI still shows
> it attached (`docs/architecture/file-formats.md:418-424`). Renaming a KB dir
> orphans existing grants the same way.

### 2.2 App-owned (SQLite) entities

All DDL in `db/migrations/0001_baseline.sql`.

| table | line | owner module | notes |
|---|---|---|---|
| `users` | `:23` | `auth/user-store.server.ts` | org role `admin\|member`, `idp`, `disabled`, `pwreset_required`, `theme` |
| `audit_events` | `:37` | `audit/audit-recorder.server.ts` | `{occurred_at, actor_user_id, actor_label, action, subject_kind, subject_id, project_slug, task_key, details_json}` |
| `projects` | `:49` | rebuilder | projection of project.md |
| `project_members` | `:66` | rebuilder | `ON DELETE CASCADE` from `projects` |
| `task_projections` | `:72` | rebuilder | see below |
| `task_events` | `:177` | rebuilder | replaced wholesale per task |
| `goal_projections` | `:203` | rebuilder | link statuses RECONCILED, not copied |
| `diagnostics` | `:226` | rebuilder | keyed by `source_path` |
| `provenance` | `:238` | `provenance/` | `projected\|removed\|error\|rescan` |
| `notifications` | `:247` | `projections/notifications.server.ts` | kinds `packet\|approval\|mention\|quality\|policy\|controller`; `ptype input\|blocked` |
| `user_prefs` | `:264` | `prefs/user-prefs.server.ts` | `(user_id,key)` JSON |
| `instance_settings` | `:276` | `settings/instance-settings.server.ts` | **NEVER store a secret here** — a sealed secret needs its own column so key rotation can reseal it |
| `s3_audit_config` | `:284` | `audit/s3-config.server.ts` | `secret_box` sealed column |
| `github_pats` | `:294` | `secrets/pat-store.server.ts` | `encrypted_token`, `token_suffix`, `validation_json` |
| `project_github_credentials` | `:304` | | project → PAT binding |
| `scope_violations` | `:310` | `projections/policy-violations.server.ts` | partial unique index on OPEN rows `:574` |
| `github_connections` | `:321` | `org/connections.server.ts` | id = `slugify(owner)` |
| `oauth_providers` | `:337` | `auth/oauth-providers.server.ts` | sealed `client_secret`; `enabled` cannot be set without `verified_at` |
| `google_domain_allowlist` | `:347` | | |
| `org_knowledge_bases` | `:353` | `org/resources.server.ts` | `dir` UNIQUE — the folder under `kb/` |
| `org_mcp_servers` | `:363` | `org/resources.server.ts`, `org/mcp-warmup.server.ts` | `warming_since`, `last_error`, `first_success_at`, `heuristic_warmups` (capped at 1) |
| `model_availability` | `:402` | `runtimes/model-availability.server.ts` | presence = unavailable; absence = unknown-but-offered, never "proven available" |
| `org_skills` | `:410` | `org/resources.server.ts` | `name` = folder under `skills/` |
| `controller_conversations` / `controller_messages` | `:423` / `:439` | `controller/` | app-owned collaboration state (ruling 99) |
| `agent_runs` | `:454` | `runtimes/run-store.server.ts` | see below |
| `run_log_lines` | `:501` | `runtimes/run-store.server.ts` | `(run_id, seq)` unique |
| `staged_outcomes` | `:623` | `tasks/agent-outcome.server.ts` | Claude `report_outcome` envelope, keyed by `outcome_key` |
| `user` / `session` / `account` / `verification` | `:537-551` | better-auth 1.6.25, hand-inlined | `verification` looks dead but better-auth writes it on EVERY OAuth sign-in (DB state strategy) — dropping it breaks all social login `:540-550` |
| `schema_migrations` | created by the runner | `db/migration-runner.server.ts:33` | |

**`task_projections`** (`:72-176`) columns worth knowing:
`readiness` (DERIVED) vs `stored_readiness` (raw, NULL when invalid);
`waiting` (terminal-stage-normalized); `priority` + `labels_json` + `due_date`;
`archived`; `validation` **with a hand-written CHECK that mirrors
`VALIDATION_VALUES`** `:102`; `validation_block_reason`;
`acceptance ∈ {forced}`; `continuity ∈ {degraded}`; `owner_user_id`;
`specialist_json` / `reviewers_json` / `operator_json`; `branch`; `repo`
(denormalized project repo); `pr_json`; `github_json`;
`work_revision_sha` (the sha only — needed by the board's acceptance ceremony,
which renders from this row alone, ruling 53/88 `:138-149`);
`goal`; `packet_json`; `recommendation_count`; `schedules_json` (so the schedule
runner finds due entries without reading every task file); `event_count`;
`comment_count`; `goal_id` + `goal_link_index`; `diagnostic_count`;
`board_rank`; `source_path` + `content_hash` + `parsed_at`.
PK `(project_slug, task_key)`.

**`agent_runs`** (`:454`) — the `kind` column is **not a role taxonomy, it is
the DELIVERY axis** (`:460-473`): `operator` = the operator runtime's own run;
`primary` = an engagement that DELIVERS; `reviewer` = an engagement that merely
SUPPORTS — *so a non-delivering developer is stored as `reviewer`*. The real
role rides `role`. `controller` rows carry `project_slug = ''` and
`task_key = <conversationId>` so every task-scoped query misses them.
Two partial unique indexes enforce single-flight atomically:
- `idx_agent_runs__one_delivering :593` — one live `primary` run per task
  (F10-05: the JS preflight has a check-then-await window two racing dispatches
  can both pass; `startRun` translates the constraint violation to a 409).
- `idx_agent_runs__one_live_per_support :608` — one live `reviewer` run *per
  profile* per task (P8 gave each supporting engagement a destructively
  re-cloned `workspace/support/<profileId>/`, so two overlapping runs of the
  same profile `rm -rf` each other's tree). DIFFERENT profiles still run
  concurrently. Existing roots predate this line, hence
  `ensureSingleFlightIndexes` at boot.

`outcome_key :499` persists the staging key for a Claude `report_outcome`
envelope so boot recovery can find the structured verdict instead of falling
back to the prose regex.

### 2.3 Org resources, secrets, seed, ops, audit

**Resources — `app/server/org/resources.server.ts` (2188 lines)**, owner of
`org_knowledge_bases`, `org_mcp_servers`, `org_skills` and of `kb/*` +
`skills/*` on disk. Core invariant: **disk is truth, the row is metadata on
top** — listings scan real folders and layer rows over them, and a folder with
no row renders under a synthetic `disk:<name>` id (`DISK_ID_PREFIX :77`,
`diskNameFromId :83` rejects `..`/separators). `subDirNames :113` uses
`readdirSync(withFileTypes)+isDirectory()`, **never `statSync`** — `statSync`
dereferences, so `kb/notes -> /etc` was listed as a first-class KB and injected
as trusted context (C5, `:103-112`).

- **KB**: `KB_REFRESH_MODES = ["on change","manual"] :161` controls **metadata
  only** — runs always read the live folder, `manual` never freezes content
  `:155-160`. `KbView :165` carries `injectableCount` beside `fileCount` plus
  `folderExists :186` (a KB of PDFs counted "healthy" and injected nothing,
  P14-KM-13). `saveKnowledgeBase :283` does `dir = slugify(name)` and
  `renameSync`s the folder. **C4 ordering `:312-328`: the folder move and the
  row write are ONE synchronous block and `updateResourceReferences` runs
  after** — otherwise the KB watcher's 250 ms debounce observes a disk/row
  disagreement and adopts the moved folder as a new KB, blowing the `dir`
  UNIQUE constraint. `reindexKnowledgeBaseByDir :493` is the watcher entry
  point; it returns null when `refresh === "manual"`.
- **MCP**: `openMcpCredential :672` lazily re-seals under a retired key; a
  credential that opens under **no** key returns `unreadable` and the server is
  **not mounted** `:711-724` (A9 — this used to warn-and-null, silently
  downgrading every authenticated server to anonymous). `mcpSpawnEnv :871`
  gives stdio children `filteredSpawnEnv()`, not `process.env` (F10-02);
  `defaultSpawn :879` is `detached` and `killProcessTree :905` signals `-pid`
  (F20-2). `splitMcpCommand :950` is shared with the run path so probe and run
  never disagree. `discoverStdioMcpTools :986` — 20 s timeout, `STDERR_CAP =
  8000`, stderr scrubbed by value, and `stdin.on("error") :1107` folds EPIPE
  into `down` (an unhandled EPIPE was fatal in 5/40 live iterations, F20-8).
  `MCP_CLIENT_CAPABILITIES :1197` must advertise
  `{roots:{listChanged:true},sampling:{},elicitation:{}}` — `{}` made a server
  hide tools. `saveMcpServer :1441`: blank credential means **keep**
  (`clearCred :1467` is the only removal), **8-char credential floor `:1479`
  (F20-7)**, reserved names refused (`isReservedMcpName :1312`), and a rename
  rewrites grants `:1608` (P14-KM-01 — the one rename leg that never did).
- **Skills**: `SKILL_BODY_MAX_BYTES = 256 KB :1792`. `readSkillBody :1824`
  routes through the **injector's own** `resolveContainedSkillFile` so editor
  and injector answer identically (A5); `assertSkillBodyWritable :1850` refuses
  to save through a symlinked `SKILL.md` or folder (unguarded, the editor was a
  write-anywhere primitive) and uses `lstat`, not `existsSync`.
- **Warm-ups** (`org/mcp-warmup.server.ts`): `WARMUP_CAP_MS = 15 min :35`;
  `heuristic_warmups` is bumped at ARM time `:91` and rolled back by
  `reapStaleWarmups :181` (a warm-up a restart killed is not a spent attempt);
  **every verdict write is `AND target = ?` scoped `:123,:138`** — an admin may
  re-point the row mid-warm-up and an id-only write would stamp the OLD
  command's verdict onto the NEW one.

`org/resource-references.server.ts` is referential integrity (P13-KM-07). Two
reference homes: `agents/profiles/<id>.md` `resources.*` and `project.md`
`agents[].definition.resources.*`. `updateResourceReferences :48` rewrites on
rename, drops on delete, best-effort per file. **`nextList :78` treats a grant
list as a SET** (P14-KM-07). `countTemplateGrants :232` walks profile **files**,
not `listGlobalAgentProfiles` (which drops `controller.md`/`operator.md`), since
the delete rewrites every file.

`org/store-files.server.ts` (946 lines) — the StoreBrowser layer.
**`assertInsideRoot :162` is two-layer**: lexical `path.relative` **plus**
`realpathSync` on the existing part `:176-185` — lexical alone proves the path
*string* is contained, not the file, and a symlink named `notes.md` served an
arbitrary host file through the in-app reader (P14-RV-02). `writeStoreFiles
:281` pre-flights so a conflict writes NOTHING; `writeStoreDoc :448` requires
explicit `overwrite`. GitHub import `importGithubSnapshot :630`:
`IMPORT_MAX_FILES = 100`, `IMPORT_MAX_BLOB_BYTES = 1 MB`, provenance dotfile
`.viberr-import.json :551` (dotfiles are skipped by scanner and injector so it
never becomes agent context), **refresh-in-place** when the marker matches
`:851-866` (re-imports used to pile up `docs`, `docs-2`, `docs-3`… all injected,
P13-KM-13), and **`COLLISION_CAP = 32` `:849`** — on a ghost data-root inode
`existsSync` answered true for every candidate and the unbounded loop pegged the
event loop and took the app down (F20-1).

`org/gagents.server.ts` — global profile templates. **`summary` is frontmatter
`desc`, `persona` is the markdown body `:41-52`** (the card once printed a
600-word system prompt as a row subtitle). `usedByProject :117` **excludes
archived projects** (a template was undeletable because of a project nobody can
edit). Create starts from `conservativeGrantsFor("agent") :309`.

`org/org-users.server.ts` — `statusOf :85` reads a local account with **no
password** as `invited`, not `active` (F20-12). `updateOrgUser :235` must call
`syncIdentityEmail :261` — updating only `users` locked the account out of
credential sign-in. `pruneUserFromProjects :329` runs `releaseTasksOwnedBy` in
**every** project, not just member ones `:361-366` (an org admin can own a task
in a project they are not a member of, via the audited D2 override).
`deleteOrgUser :403` prunes BEFORE deleting rows so a failure leaves the account
intact. `findDomainAllowlistRole :588` is the hook live Google OAuth calls.

`org/connections.server.ts` — `CONNECTION_REQUIRED_SCOPES` is an **alias** of
`DEFAULT_REQUIRED_SCOPES :61` (B-GH6: two identical tuples made gate and chips a
one-edit divergence). `CONNECTION_REVALIDATE_AFTER_MS = 24 h :235`;
`ensureConnectionFresh :253` does at most ONE probe and **a `network_error` is
never a downgrade** `:280`. Nothing is persisted unless validation passes
(`createConnection :434`, `replaceConnectionToken :494`); removing the default
connection is refused `:585`.

**Secrets (`app/server/secrets/`).**
`secret-box.server.ts` — box format `v1$<iv b64>$<ct b64>$<tag b64> :17`,
AES-256-GCM, random 12-byte IV per seal. `previousSecretKeys :55` reads
`VIBERR_SECRET_ENCRYPTION_KEY_PREVIOUS` from **raw `process.env`, not
`getEnv()`** (an operational rotation-window value, not a process-lifetime
cache); malformed entries are skipped **in silence** `:68` because a key list
must never produce an error naming key material. `openSecretRotating :88`
returns `{plaintext, staleKey}` — `staleKey: true` means the caller owes a
re-seal. `openSecret :144` throws typed `SECRET_BOX_INVALID`/500, **never
garbage plaintext**.

`key-rotation.server.ts` — **`SEALED_STORES :43-84` is the registry**:
`github_pats.encrypted_token`, `org_mcp_servers.cred_ref`,
`oauth_providers.client_secret` (id column is `provider`, not `id`),
`s3_audit_config.secret_box`. **`key-rotation.server.test.ts` fails if a third
home of `sealSecret(` appears `:41-42`.** The batch pass exists because
`resources.server.ts:753 openedForNewRow` deliberately does *not* re-seal, and
lazy convergence only reaches secrets somebody READS — the dormant ones are the
risky ones `:33-37`. `secretKeyRotationStatus :195` is READ-ONLY;
`resealSecrets :283` **writes and needs the writer lock**, and leaves an
unreadable box exactly as it is `:318-321` (it is the operator's only copy of
that ciphertext).

`pat-store.server.ts` — `DEFAULT_REQUIRED_SCOPES = ["repo","pull_request:write"]
:38`. **`getPatToken :208` is server-internal** ("never into loader data, logs,
timelines or errors") and lazily re-seals in place `:222-238` — without it,
rotating the key bricked every stored PAT. `markWriteScopeProven :270` takes
**the patId that actually made the call** (F28-U2b). With no bound PAT the
health source is **always `"none"`** `:491-497`.

`pat-validator.server.ts` — **health checks do not write** (A8 `:48-62`):
repo-write is proven read-only from `GET /repos/{r}`'s `permissions`; the old
dry-run `PUT` survives only as opt-in `VIBERR_GITHUB_WRITE_PROBE :96`.
`repoPermissionsSchema :113` is **per-FIELD tolerant (F21-11)** — one drifted
key discarded a `push: false` beside it and silently UPGRADED the verdict.
A **5xx is `network_error`, not a rejection**. `REVALIDATE_COOLDOWN_MS =
60_000 :543` reuses only a `valid` result, and only for the **same repo**
`:645-653`. `WRITE_EVIDENCE_SCOPES :556` — a write scope's violation clears only
on `header`/`probe` evidence, never `assumed` `:677-685`.

`git-output-redact.server.ts` `redactGitOutput :79` — three layers, strongest
first: **by value** (`split`/`join`, **no length floor** `:87-95` — F20-7's
5-char credential rode into an MCP `last_error`, a toast and the DB), then URL
userinfo `:102`, then anchored patterns `:104` (deliberately not an entropy
heuristic). Then ANSI/C0 stripping and a clamp **from the END**
(`MAX_DETAIL_LINES = 8`, `MAX_DETAIL_CHARS = 600`).

**Seed (`app/server/seed/`).** `runSeed :127` ships built-in templates + a
bootstrap admin **only on an empty users table** + a rescan; no projects, tasks
or mock data (that is `test-support/demo-seed.ts`). `DERIVED_TABLES :76` is what
`--reset` deletes (12 tables; `scope_violations` + `user_prefs` were added by
DM-3 — a stale violation resurfaced as a phantom badge on a recreated same-slug
project). **`resetStore :104` deletes only `runtimes/<backend>/` transcript dirs
— never `codex-home/auth.json` or `claude-home`** (P11-04: deleting those logged
the whole instance out).

`default-assets.server.ts` — assets are **read from disk at runtime, not Vite
`?raw`** `:5-27`; `readAsset :33` fails LOUDLY rather than shipping an empty
persona (the `?raw` version killed `npm run seed` with
`ERR_UNKNOWN_FILE_EXTENSION ".md"` while typecheck, 1663 tests and the build
were green). `SHIPPED_MANIFEST_REL = state/shipped-assets.json :165` holds a
SHA-256 per shipped path; **`PRIOR_SHIPPED_HASHES :184-262` must be appended by
hand when you edit a shipped asset** `:175-178`, and an unrecognized hash fails
SAFE (the store copy is preserved, with a WARN naming both hashes).

`agent-catalog.server.ts` — `SEED_AGENT_PROFILES :83` (operator, developer,
reviewer). `mapActions :30` resolves action LABELS via `capabilityByLabel`, and
an unmatched label **degrades to a display-only extra** `:36-38`. The operator
deliberately carries **no `viberr` MCP grant** `:91-96` (the toolkit mounts it
unconditionally and the catalog filters the reserved name, so the grant painted
a red chip). Developer defaults to Claude (owner ruling 2026-08-21) and ships
`use-browser` + web egress **as a pair** `:152-160`; reviewer forbids
`"Commit & push to the branch"` using the **exact catalog label** `:190-192` so
it becomes a real `commit-push-branch: human` grant, not a decorative extra.
`ensure-base-agents.server.ts:32` — the operator is unconditionally ensured on
every project; base specialists are backfilled **only into a project with no
specialist deployments at all** `:51-62` (E10: otherwise removing one never
stuck).

**Ops (`app/server/ops/`).** `maintenance.server.ts` introduces **no new
writer** — a timer inside the process that already holds the lock, on the same
`getDb()` handle `:35-43`. `DEFAULT_MAINTENANCE_INTERVAL_MS = 6 h :65`,
`DEFAULT_DISK_CHECK_INTERVAL_MS = 5 min :68`, **`MIN_PRESSURE_PASS_GAP_MS =
30 min :71`** so a wedged low-space condition cannot busy-loop.
`activeRunCount :120` **returns 1 on an unreadable table** `:131-134` —
"skipping a reclaim costs disk; doing one over a live working tree costs a run."
`startMaintenanceScheduler :369` runs **no immediate pass** `:364-368` (it would
race the run recovery boot just scheduled). Every pass logs even when it removed
nothing `:215-217`.
`transcript-retention.server.ts` — four rules `:39-49`: only under the data root
(a redirected `CLAUDE_CONFIG_DIR`/`CODEX_HOME` is untouched), **only `*.jsonl`**
(`codex-home/auth.json` is a live credential), mtime not DB state, best-effort.
Both windows default to 30 days; `0` disables that half.
`disk-space.server.ts` — **absolute bytes, not percentages** `:17-36` (a
workspace clone is 11-16 MB). Low = 2 GiB, critical = 512 MiB, `low =
max(low, critical) :85`. `measureDataRootSpace :102` returns **`null`, never a
fabricated zero** (R17-5).
`build-info.server.ts` — identity from something REAL or reported absent `:19`
(no placeholder). Build env vars → `package.json` version → `.git` **file reads
only**; resolved once and cached `:129` (the health endpoint is unauthenticated).

**Audit (`app/server/audit/`).** `recordAudit :61` — `details` must be
secret-free, and recording must never break the action that triggered it
(failures logged and swallowed `:83-88`). `AuditDetailValue :38-45` names the
value type so a caller cannot hand over an Error/Map that `JSON.stringify`
flattens to `{}`. Actors `SYSTEM_ACTOR :23` / `OPERATOR_AUDIT_ACTOR :28`;
actions are lowercase dot-separated facts.
`audit-query.server.ts` exists because the only freshness fact was
`MAX(observed_at)` over `github.reconcile` **provenance**, which is deliberately
not written on an unchanged tick — so "Synced 1h ago" showed at 12:42Z with
seven successful passes in the audit rows (F19-22). `RECONCILE_TASK_AUDIT_ACTION
:31` is written unconditionally after every early return, and
`latestProjectReconcileCheckAt :80` **UNIONs both actions**.
`audit-export.server.ts` — `AUDIT_EXPORT_MAX_ROWS = 100_000 :16` (disclosed in
the panel copy with the 90-day window, F26-9), every filter is a bound
placeholder `:61-63`, and **`csvField :145` neutralizes formula injection** by
prefixing `'` to a cell starting with `= + - @` — `actorLabel` is a
user-supplied email and the validator permits a leading `+`/`-` (F26-10).
`s3-config.server.ts` — the secret lives in its **own `secret_box` column**, not
a JSON blob, precisely so `SEALED_STORES` reaches it `:10-16`;
`getS3AuditConfigForUse :67` opens rotating + lazily re-seals (F26-8: plain
`openSecret` bricked the target after a rotation and failed with the misleading
"No S3 target configured").

**Injection budgets.** `SKILL_INJECTION_BUDGET = 24_000`
(`files/skill-body.server.ts:36`) and `KB_INJECTION_BUDGET = 24_000`
(`files/kb-injection.server.ts:64`) are **shared across the whole declared list,
not per item** — the first attempt at a per-skill cap was N x 24 k = unbounded
`:16-22`. Per-doc `### <rel>` headings are **charged** against the budget
(`kb-injection.server.ts:222-225`, P13-KM-14). When nothing fits, the "omitted
entirely" marker is returned on its own plus a structured `unresolved` `:236-254`
(P14-KM-05: the old `parts.length > 0` guard suppressed both, so an earlier KB
that spent the budget made every later one vanish without a trace).
`isInjectableKbDoc :58` is owned by the injector so count and injection answer
the same question. `collectKbDocs :75` realpaths the root, keeps a `visited`
cycle guard, caps depth at 32, re-checks containment per directory and
`lstat`-skips symlinks (F10-18/C5). `KB_PRECEDENCE_NOTE :343-353` (R19-2 — the
repository's own conventions outrank the KBs) is emitted **only alongside real
KB text**. `resolveContainedSkillFile :82` refuses a symlinked folder or
`SKILL.md`, with a realpath containment check as defense in depth `:116-122`.
The shared text-extension set is `app/shared/text/store-extensions.ts` — one
source answering "will the injector read it", "will the editor author it" and
"is it clickable" (three hand-maintained copies previously diverged).

**Attachments** (`files/task-attachments.server.ts`) — **the directory is the
truth**: no table, no upload path, no retention machinery `:14-17`.
`LIST_CAP = 100 :35` with a sibling `countTaskAttachments :78` so a task with
140 files does not render as exactly 100 with no "and N more" (C8).
`resolveTaskAttachment :116` goes through `resolveStoreSegment`; a traversal
throws and the route turns that into a **404, never an oracle** `:20-22`.
**`INLINE_TYPES :127-138` is a WHITELIST** — png/jpg/jpeg/webp/gif/pdf/txt/log/
md/json. HTML/SVG/JS are never inline: a stored page served on the app origin
would be stored XSS with the viewer's session `:22-25`.

`agent-profile-file.server.ts` — `agentProfileFrontmatterSchema :27` is
`.loose()` at every level, so `AGENT_PROFILE_KNOWN_KEYS :80` (15 keys) exists
purely for **drift detection**: an unknown top-level key is preserved but
otherwise silent, and now emits `agent_profile.unknown_field :146`.

`kb-watch.service.server.ts` — `KB_WATCH_DEBOUNCE_MS = 250 :32` per KB dir,
`ignoreInitial: true` (the initial scan must not bump `last_indexed_at` on every
boot), `followSymlinks: false`. Same ENOENT-is-not-broken and
clear-handle-then-re-arm error policy as the file watcher (DM-2: a zombie
watcher stayed cached forever, so `isKbWatcherAlive()` and `/resources/health`
lied).

### 2.4 Read models (loader shapes)

`TaskSummary` (`app/shared/mapping/task.server.ts:146`) is what board cards,
the review queue and the inbox render from — it is built from
`task_projections` ALONE, which is why facts like `workRevisionSha :245`,
`acceptance :171`, `continuity :182`, `blockReason :186` and
`atAcceptanceBoundary :204` had to be projected rather than re-derived.
Other mappers: `actor.server.ts` (`createActorResolver`),
`project.server.ts`, `notification.server.ts`, `task-event.server.ts`, `user.server.ts`.

Query modules (all read-only over the projection):
`projections/board-query.server.ts` (`getBoard :293`, `listProjectTasks :177`,
`compareBoardOrder :60`, `BOARD_RANK_BASE = 1_000_000 :39`),
`task-query.server.ts` (`getTaskSummary :79`, `getTaskDetail :223`,
`listTaskEvents :121`, `listTaskDiagnostics :191`),
`review-queue.server.ts` (`getReviewQueue :114`),
`decisions.server.ts` (`decisionsRequiring :84`),
`notifications.server.ts`, `activity-feed.server.ts` (stream + audit log,
`ACTIVITY_STREAM_LIMIT = 200 :42`, `AUDIT_SCAN_CAP = 1000 :527`),
`task-activity.server.ts` (`QUIET_AFTER_AGENT_MS = 1h :46`,
`QUIET_AFTER_HUMAN_MS = 72h :57`),
`policy-violations.server.ts`, `agent-deployments.server.ts`,
`insights/insights-query.server.ts`, `provenance/provenance-query.server.ts`.

---

## 3. The action layer

### 3.1 Shape of a governed mutation

Every governed write lives in `app/server/tasks/*.server.ts` and takes
`(db, input, actor: TaskActor, ctx: TaskMutationContext)`.

`TaskActor` (`tasks/task-mutation.server.ts:44`) = `{userId, label}` where
`label` is the audit label (the email).
`TaskMutationContext :50` = `{dataRoot?, operatorAuthorized?, operatorRun?}`.
**`operatorAuthorized` is in-process operator authority — routes must never set
it** `:53`. `operatorRun` carries `{backend, autonomy, reactDepth,
transitionDepth?}` for the bounded loops.

Three substrate helpers live in `task-mutation.server.ts` *specifically to break
an import cycle* (`:16-42`): `specialist-run → agent-toolkit → task-actions ⇢
(dynamic) specialist-run`. Hiding that cycle behind `await import()` produced a
live failure — `resolvePacket`'s `retry_other_backend` arm imported a
half-evaluated `specialist-run` namespace and `startAgentRun` threw
`ReferenceError: Cannot access '__vite_ssr_import_30__' before initialization`
inside a `catch` that only logged, so the packet cleared and **no agent run
started**. The helpers:
- `loadProjectContext(ctx, slug) :81` → `ProjectContext {slug, stages,
  workflow, memberRoles, archived}` read straight from project.md.
- `taskRef :104`, `reprojectTask :117` (calls `rebuildPath` on the one file).
- `notifyTaskWatchers :144` — owner + project admins/maintainers, honouring each
  recipient's routing prefs; a **deliberate fail-open** on a corrupt project/task
  file, logged, documented at `:160-182`.

Canonical mutation body:
```
const project = loadProjectContext(ctx, slug);
requireAction(db, project, actor, "<rbac-action>", "<what>");   // + archive freeze
const existing = readTaskFile(taskRef(ctx, slug, key));         // pre-checks
await updateTaskFile(taskRef(...), (parsed) => { ...mutate... }); // locked RMW
reprojectTask(db, ctx, slug, key);                              // synchronous
recordAudit(db, { action, actor, subjectKind, subjectId, projectSlug, taskKey, details });
return summaryOrThrow(db, slug, key);
```
(`setTaskArchived` at `tasks/task-actions.server.ts:5651` is a compact, complete
example: idempotence check `:5668`, withdrawal note `:5679`, note event `:5696`,
locked write cancelling packet/recs/schedules `:5711-5735`, reproject `:5736`,
`markTaskPacketApprovalRead :5737`, audit `:5739`, fire-and-forget goal
reconcile `:5758`.)

Routes with `action` exports (all under `app/routes/`; URL mapping in
`app/routes.ts`):

| file:line | purpose |
|---|---|
| `_index.tsx:78` | Home — `pin`, `view`, `rescan` (org-admin + single-flight), `rebuild-projections`, `create-project` |
| `controller.tsx:41` | instance controller conversation — `send` |
| `login.tsx:67` | `login`, `set-password` (origin check only, no session yet) |
| `logout.tsx:11` | revoke session, audit `auth.logout` |
| `notifications.read.tsx:21` | `read` / `read-all`; emits user-scoped `notification.read` |
| `prefs.theme.tsx:19` | persists `users.theme` **and** the `viberr_theme` cookie |
| `profile.tsx:67` | `identity`, `set-notif`, `set-motion`, `set-tl-default`, `change-password`, `github-disconnect` |
| `org.settings.tsx:195` | org admin — connections, members, resources, MCP, OAuth (manual CSRF) |
| `project.agents.tsx:135` | `create-profile`, `deploy-profile`, `update-profile`, `delete-profile` |
| `project.board.tsx:45` | `create-task`, `reorder` (carries the acceptance ack on a terminal drop), `rescan` |
| `project.controller.tsx:64` | `send`, `goal-op` (pause/resume/cancel/skip_link/retry_link) |
| `project.github.tsx:105` | `reconcile`, `grant-scope`, `set-credential`/`clear-credential` |
| `project.policy.tsx:44` | `set-role`, `set-boundary` (admin) |
| `project.settings.tsx:82` | project save, stage CRUD, members, repo repair, branch cleanup, archive/delete |
| `project.task.tsx:406` | **24 intents** — comment, update-goal, set-task-metadata, resolve-packet, request-maintainer-decision, complete-merge, accept-completion, deliver-review, archive/restore-task, force-accept, owner-take/assign/release, transition, run-interrupt, run-agent, release-agent, apply/dismiss-recommendation, run-operator, schedule-action, cancel-schedule |
| `api.auth.$.ts:15` | forwards the raw Request to better-auth; **no app CSRF** |
| `resources.events.ts` | `GET /resources/events` — the SSE stream (plain 401 JSON, not a redirect: an EventSource cannot render a login page, and per spec a non-200 kills the stream permanently, so the client owns reconnect backoff) |

**End-to-end example — `intent=set-task-metadata`:**
1. `project.task.tsx:406` `requireFormAction` → auth, db, formData, CSRF.
2. `:420` `requireVisibleProject(...)` **outside** the try (404, not 403).
3. `:478-497` parse the three axes and call `setTaskMetadata(db, input, actor)`.
4. `task-actions.server.ts:660-673` `loadProjectContext` →
   `requireAction(..., "edit-task-meta", ...)` → archive freeze + role check.
5. `:674-697` **all validation before any write** — "so a bad value fails the
   whole edit before any file write (never a half-applied patch)".
6. `:699-724` preconditions: file exists; archived-task guard (F26-13); no-op
   short-circuit when every provided axis already holds its target.
7. `:740-758` `updateTaskFile` → lock → read → stale-read repair → **write
   guard** → mutate (`priority`, derived `urgent`, `labels`, `dueDate`, and a
   `note` timeline event unshifted) → `updatedAt` → serialize → atomic write →
   `rememberWrite`.
8. `:759` `reprojectTask` → `rebuildPath` → `rebuildTaskFile` (hash
   short-circuit, diagnostics, readiness derivation, upsert, `task_events`
   rewrite, provenance, **commit-marker hash last**) →
   `emitProjectionEvent("task.updated")`.
9. `:761-771` `recordAudit("task.metadata.updated", …)` with only the axes that
   actually changed.
10. Publisher hydrates `readTaskFacts`, `sseEventSchema.parse`s, and
    `publishSseEvent`s to every matching connection; clients revalidate their
    own loaders (the payload is a reference, not the new state).
11. `{ok:true, intent, toast}`. Any `AppError` is caught at `:1062-1064` by
    `appErrorResponse`; anything else is re-thrown to the root `ErrorBoundary`.

### 3.2 Authority

`requireAction(db, project, actor, action, what)` —
`tasks/task-actions.server.ts:288` — is the chokepoint. It first calls
`requireProjectMutable(project, what)` (the **R6-3 archived-project freeze**:
archived projects are read-only for every governed mutation) and then
`requireProjectAuthority(db, project, actor, rolesForAction(action), …)`.

`app/shared/rbac.ts` is the single source for enforcement AND the Policy page's
permission table. `RBAC_DEFINITIONS :61` (19 actions), `ACTION_ROLES :97`,
`roleCan :104`, `rolesForAction :110`. Roles are a strict tier
`ROLE_RANK viewer 0 < contributor 1 < maintainer 2 < admin 3 :31`.
Membership is the outer gate on **every** action (R15-4): a non-member gets the
unknown-slug 404 from the layout loader / `requireVisibleProject`, and `view` +
`comment` have no role narrowing at all — that membership gate *is* their whole
enforcement `:20-27`.

Three deliberate short-circuits, each of which re-asserts the archive freeze
**first** because it skips `requireAction`:
- `requireAcceptCompletion :320` — the live task OWNER (contributor+) may accept
  their own task.
- `requireDecisionAuthority :350` — R14-2: the owner governs decisions on their
  own task (packets AND recommendations; the pass-12 version was packet-only and
  produced dead-end inbox entries).
- `requireAnyMember :275` — the loosest gate, for idempotent/no-op paths.

Agent authority is capability-based, not role-based: `app/shared/capabilities.ts`.
`UNIFIED_CAP_CATALOG :33` carries `{id, label, kinds, group, defaultMode,
promotable}`. Key invariants:
- `ALWAYS_HUMAN_CAPABILITY_IDS = merge-pull-request, transition-to-done,
  change-project-policy :211` — a server invariant list; stored modes can never
  grant these to agents.
- `GRANT_REQUIRED_CAPABILITY_IDS :392` — **absence is withholding, not
  permission** (P14-LV-01) for the six repo-write/verdict capabilities.
  Everything else keeps the permissive default when absent (notably
  `use-web-search-fetch`, whose catalog default is `direct`).
- `capabilityEnforcement(id) :287` → `both | claude-only | advisory`.
  `ENFORCED_CAPABILITY_IDS :223`, `CLAUDE_ONLY_ENFORCED_CAPABILITY_IDS :269`
  (R22 removed the Codex read-only sandbox — "viberr itself is the sandbox" —
  so the whole repo-write family is Claude-only again).
- `coerceSpecialistCapabilityMode :361` — a specialist `recommend` normalizes
  **DOWN to `off`**, never up to `direct` (F20-21: widening was the dangerous
  direction and made the seeded project.md disagree with every rendered surface).
- `applyVerdictOutcomeGate :324` — the three advisory verdict outcomes are only
  as granted as `report-validation-verdict`.
- `applyGrantCouplings :559` = `repairDeliveryGrants :448` then
  `repairBrowserEgressGrants :524`. Delivery: an ABSENT headline is materialized
  `direct`, an EXPLICIT `off`/`human` is **respected** and reported (B-AG1).
  Browser→egress: the browser IS network egress and the mount fails closed
  either way, so an `off` egress under a `direct` browser is repaired UP.
- `defaultGrantsFor :165` vs `conservativeGrantsFor :192` — org-template
  creation (no capability UI) starts delivery + verdict outcomes WITHHELD.
- `absentDeliverReviewPrMode(humanGatedBeforeWork) :614` — R15-9, derived from
  the workflow graph so runtime and policy display cannot drift.

### 3.3 CSRF and the form-action preamble

`app/server/auth/csrf.server.ts` runs **two independent layers**, both required.

**Layer 1 — origin proof** (`assertTrustedOrigin :62`), fails closed on all
three browser signals: `Sec-Fetch-Site` present and not `same-origin`/`none`
⇒ 403 `:63`; `Origin === "null"` or `Origin !== url.origin` ⇒ 403 `:77`;
`Referer` present with a foreign origin ⇒ 403 `:84`. The load-bearing clause is
`:96` — **none of the three present ⇒ 403** "Request origin could not be
verified." (§7.10/A7; this used to PASS as a curl concession that bought
nothing, since every call site is a browser form `:53-60`).

**Layer 2 — stateless double-submit token.**
`csrfTokenForSession(sessionId, secret)` `:25` =
`HMAC-SHA256(secret, "viberr-csrf:" + sessionId).base64url` — deterministic per
session, no server-side store. Issued by the root loader
(`app/root.tsx:74`, `csrf: auth ? getCsrfToken(auth.sessionId) : null`) and
rendered by `app/ui/csrf-input.tsx` as
`<input type="hidden" name="_csrf">`; `useCsrfToken()` serves programmatic
`fetcher.submit`. `assertCsrfWithSecret :102` reads `X-Csrf-Token` else the
`_csrf` field (`CSRF_FIELD_NAME :18`, `csrfFieldSchema = z.string().min(1) :22`
so a File part / empty string reads as "no token"), then `timingSafeEqual` with
a length pre-check `:121-126`.

Failure shape: `forbidden(reason) :36` throws a **raw `Response`** 403 with
`{"error":{"code":"forbidden","message":…}}`.

`requireFormAction(request)` — `app/server/auth/form-action.server.ts:8-16` — is
the whole preamble, in this order:
```
requireAuth(request)  →  getDb()  →  await request.formData()
                      →  assertCsrf(request, auth.sessionId, formData)
→ { auth, db, formData, actor: {userId, label: email}, intent }
```
`formData` is passed in because a body can only be read once (`:115` falls back
to `request.clone().formData()`). `intent` (a form field) is the universal
dispatch key — every route action switches on it.

`appErrorResponse(cause) :24` **re-throws anything that is not an `AppError`**
so genuine defects reach the error boundary; otherwise
`data({ok:false, error: cause.userMessage}, {status: cause.status})`.

Two deliberately different failure ergonomics:
- document-form routes let the thrown 403 `Response` hit the error boundary;
- fetcher routes use `app/features/shell/csrf-result.server.ts` `csrfError(...)`,
  which catches it and returns `{ok:false, error:"That request expired…"}` at
  403 — UI-32: a thrown response replaced the whole UI and made the toast
  branches in `top-bell.tsx` / `notifications.tsx` / `user-menu.tsx` /
  `profile-page.tsx` unreachable. Used at `routes/notifications.read.tsx:31`
  and `routes/prefs.theme.tsx:26`.

Exceptions to `requireFormAction`: `routes/login.tsx:68` (origin check only —
no session yet — plus rate limiting), `routes/logout.tsx:15`,
`routes/org.settings.tsx:197` (manual, so one session lookup serves both the
role gate and CSRF), and `routes/api.auth.$.ts:15` (**no app CSRF** —
better-auth enforces its own `trustedOrigins` check).

### 3.4 Identity and the authority resolver

`app/server/auth/require-user.server.ts`:
- `authenticateWithHeaders :77` calls better-auth `getSession({headers,
  returnHeaders:true})`. **F10-17**: rolling sessions (30 d expiry, 1 d
  updateAge) emit a renewal `Set-Cookie` the old code discarded, so cookies
  expired at login+30 d regardless of activity. Only the root loader uses the
  headers variant; `authenticate :114` drops them.
- Identity invariant: better-auth `user.id` === `users.id`. A missing or
  `disabled` user gets `DELETE FROM session WHERE id = ?` and reads as signed
  out `:88-91`.
- `requireAuth :161` → `{user, pwresetRequired, sessionId, sessionToken}` or
  `loginRedirect`. `loginRedirect :135` normalizes single-fetch `.data` URLs so
  `returnTo` is never a wire address; `safeReturnTo :121` strips `\t\n\r`
  **before** checking, because URL parsing removes them and `"/<TAB>/evil"`
  would reach the browser as protocol-relative `//evil`.
- Org roles: `ROLE_ORDER {member:1, admin:2} :181`, `requireRole :208`,
  `requireRoleAuth :222`.

`app/server/auth/project-authority.server.ts` is **THE** single authority
resolution path (R7-1). `resolveProjectAuthority(db, project, actor, allowed,
audit) :173` is non-throwing with three outcomes:
1. member role suffices `:180` — no audit row;
2. **org-admin emergency override (D2)** `:187` — `isOrgAdmin :152`, grants
   `role:"admin"` and writes a `project.org_admin.override` audit row. F19-30:
   `"any-member"` grants used to be exempt, which was false — `appendComment`
   never calls `requireAction`, so an org admin could write into a members-only
   project silently. Repeats collapse per 60 s on
   `ovr|${userId}|${slug}|${what}` (the `what` is in the key so a read gate
   cannot mask a write gate); RbacAction gates are **never** collapsed `:208`;
3. denial `:232` — `project.authority.denied`, deduped 60 s unless
   `audit.silentDeny` (the membership gate also guards polled resource routes,
   and a retrying 403 would bury the deliberate probe).
   Dedupe state is a `WeakMap<DatabaseSync, Map<string, number>>` keyed per DB
   handle so parallel test DBs never share it `:108-124`.

Throwing wrappers: `requireProjectAuthority :265`,
**`requireProjectMutable(project, what) :136`** (the single R6-3 implementation
— 409 `CONFLICT`, "This project is archived (read-only)…"),
`requireRunAgents :293` (mutable-gate **then** `run-agents` — F17: the agent
runtime creates branches/commits/events and used to skip the archive gate),
`canRunAgents :311` (non-throwing @mention sibling with `silentDeny: true`), and
`assertProjectAction(db, action, slug, actor, what, opts) :337` — the
**slug-only** guard for config surfaces, which re-reads `project.md` fresh.

`requireProjectMember :33` (`auth/require-project.server.ts`) **collapses both
failure modes into one 404** `:81`. F19-28: throwing the 403 was a
project-existence oracle, because single-fetch honours a client `?_routes=`
filter — `GET /projects/<slug>/policy.data?_routes=routes/project.policy` runs
the child loader alone and the layout's 404 never executes. The 404 body echoes
the slug only when the URL positionally named it `:82-85`.

Action-side twin: `routes/project-visibility.server.ts` `requireVisibleProject
:29`. React Router runs a child **action** without the parent's loader, so a
POST to `/projects/<slug>/tasks/<key>` reached the mutation for any
authenticated user. It is called **outside** the try block
(`project.task.tsx:420`, `project.board.tsx:53`) so the refusal stays a thrown
404 and never becomes an `appErrorResponse` 403 that would confirm existence.

**ALWAYS_HUMAN enforcement has three server-side points**, not one:
1. write coercion — `app/features/agents/agent-profile-actions.server.ts:301`
   (edit), `:353` and `:548` (create/deploy) force `mode = "human"` whatever the
   form said, so **no write path can persist an actionable always-human grant**;
2. runtime tool denial — `app/server/tasks/specialist-tool-policy.ts:137`
   `isWithheld()` returns true unconditionally for an ALWAYS_HUMAN id, before
   any grant lookup; `CAP_DENY_RULES :65` maps
   `merge-pull-request → ["Bash(gh pr merge:*)"]`;
3. labelling — `capabilities.ts:291` checks ALWAYS_HUMAN **before** the
   claude-only set so `merge-pull-request` is never called "advisory on Codex".

### 3.5 Action watchdog

`app/server/actions/action-watchdog.server.ts` (56 lines).
`ACTION_WATCHDOG_MS = 30_000 :6`; `withActionWatchdog(label, fn, timeoutMs) :28`
races `fn()` against a timer that logs `action watchdog fired` and rejects with
a 503 `AppError` ("…the data root may be unreachable. Nothing reliable was
changed…"). Timer is `unref()`'d `:49` and cleared in `finally` `:53`.

Two things to know: it **cannot interrupt a synchronous CPU spin** `:19-26`
(the live F20-1 spin was exactly that — those are closed at the source: the
bounded collision loop in `org/store-files.server.ts` and the ESTALE/EIO arm in
`atomic-file.server.ts`); and despite the docblock's "applied at the mutating
action entry point", it currently has **exactly one production call site** —
`app/features/home/project-create.server.ts:285`.

### 3.6 Errors and logging

- `AppError` (`app/server/errors/app-error.server.ts:26`) carries
  `{code, status, userMessage, details?}`; `details` is **scalars only** so
  nothing nested (or secret-valued) can ride into a log `:9`.
  Statics: `notFound :43` (404), `validation :55` (400), `forbidden :67` (403),
  `conflict :75` (409), `internal :83` (500). `isAppError :96`.
- `ERROR_CODES` (`errors/error-codes.ts:6`) — **never rename an existing
  value**: `internal_error, not_found, validation_failed, forbidden, conflict,
  db_migration_failed, secret_box_invalid, file_not_trusted,
  accept_disclosure_missing, accept_disclosure_stale`.
- An `AppError.message` is rendered to humans, so the **copy ban applies to
  server strings too** — `app/features/copy-ban.test.ts` scans user-facing
  `AppError` messages under `app/server/**`
  (`tasks/task-actions.server.ts:4264-4267`).
- Logging: `app/server/logging/logger.server.ts` — structured JSON on stdout,
  levels debug/info/warn/error (**there is no `fatal`**; `writeFatalSync` is the
  app's fatal channel, a synchronous `fs.writeSync(2, …)` used before any
  `process.exit`, `boot.server.ts:88-94`).
  `logging/request-context.server.ts` carries request correlation.

### 3.7 Interpretation layer

`app/server/interpretation/` is the *only* place derivation lives
(`architecture.md`; `readiness-policy.server.ts:8-11`). It holds readiness
(`deriveReadiness`), diagnostics severity (`diagnostics-policy`) and freshness.
`freshness-policy.server.ts:19` merely **re-exports** `~/shared/freshness`
(`isMcpHealthStale`, `isReconcileStale`, `isStale`, `STALE_AFTER_MS`) because
the MCP rule is evaluated in a *client* component and `.server.ts` modules are
stripped from the client bundle — one definition, two doors.

---

## 4. Task lifecycle

### 4.1 Stages and the workflow graph

Stages are **per project** and freely renamed/reordered. Nothing may hard-code
`triage`/`ready`/`review`/`done`. `resolveStageRoles(stages, workflow)`
(`app/shared/workflow/stage-roles.ts:41`) derives four structural roles:

- `entryId` = `stages[0]`
- `terminalId` = `stages[last]` (the human-only Done stage)
- `reviewId` = the first stage with an edge INTO terminal, falling back to
  `stages[length-2]`
- `workId` = the first stage with an edge INTO review, falling back to the stage
  before review

`isTerminalStage :107`, `stageName :75`, `stageLockReason :31`,
`humanGatesPreWorkAdvance :97` (the `strict` preset's signature read straight
off the graph — R15-9: the preset itself is never stored).

`workflow` is maintained as a **CHAIN over `stages` order** — one rule per
consecutive pair, so every stage has an in-edge (bar entry) and an out-edge (bar
terminal) and Done is always reachable
(`app/shared/workflow/transitions.ts:20-39`):
- `spliceStageIntoChain :118` — inserting at *i* replaces `prev→next` with
  `prev→new` + `new→next`, both inheriting the replaced edge's boundary.
- `rejoinChainAroundStage :183` — removing a stage merges its neighbours with
  the **stricter** boundary (removing a column must not delete a governance
  checkpoint as a side effect).
- `realignChainToStages :249` — a reorder re-aligns; a pair without a rule
  inherits the boundary guarding **entry into the target stage**.
- Two facts are always RECOMPUTED, never carried: a rule into terminal is forced
  `human`, and `locked` marks exactly the human-into-terminal rules
  (`withLock :73`, `createdRule :86`).
- `stageFlowPath :291` walks the *real* rules and returns `{chain, offChain}` so
  Policy's flow map cannot depict a path governance does not have.
- `strictestBoundary :48`, `defaultTransitionBy :57` (copy that deliberately
  names no stage, because stages get renamed).

Default template: `GOVERNED_TEMPLATE` (`app/shared/workflow/templates.ts:34`) —
5 stages `triage/ready/impl/review/done` with boundaries
`auto, auto, approval, human(locked)`. The "Lightweight · 3 stages" preset was
DELETED (P13-AP-04): its `todo/doing/done` ids made every seeded specialist
stage-ineligible, so every lightweight project was dead on arrival for agent
work `:16-23`.

### 4.2 `transitionStage` (`tasks/task-actions.server.ts:4182`)

Inputs beyond the target stage: `manual` (board dropdown, ANY stage,
admin|maintainer), `rework` (operator-only BACKWARD move on a `failing` task,
R7-4), `recommendationAuthorized` (set ONLY by `applyRecommendation` after its
own gate; never by a route), `ack` (the acceptance disclosure echo, ruling 88).

Order of checks:
1. Same-stage ⇒ idempotent return `:4222`.
2. Target must be a real stage `:4229`.
3. `archivedTaskMoveBlockedReason` ⇒ **409** `:4241-4247` (F19-8: an archived
   card could be dragged column to column while every surface called it
   abandoned).
4. Boundary lookup; `isReworkMove` vetting `:4257`; otherwise a non-manual,
   non-boundary move is a validation error `:4263`.
5. **A human moving a task INTO the terminal stage IS accepting completion**
   `:4281-4297` — it routes through `acceptCompletion` (real merge attempt,
   `completion` event, packet/recs cleared), never a bare transition.
6. Operator authority skips human RBAC but is **forbidden** from a bare move to
   terminal `:4304-4308`. Otherwise: `manual` ⇒ `approve-transition`; `auto`
   boundary ⇒ `requireProjectMutable` + any member; `approval` ⇒
   `approve-transition`; `human` ⇒ `requireAcceptCompletion`.
7. The write re-checks the stage **inside the file lock** `:4375-4391` (U3 /
   NFR16): already-there ⇒ write nothing; moved elsewhere ⇒ 409, because every
   guard above was evaluated against `fromStageId` and the event text already
   says "from <that stage>". `moved` carries the in-lock verdict back out so the
   event, the audit row and the operator re-trigger follow the ONE write.
8. On success: `previousStageId = fromStageId` `:4397`; terminal ⇒
   `waiting = "none"`; leaving the entry stage attaches the operator
   (`operator = {assignedAtStageId}`) and clears the triage-time
   `input_required` gate.

Runaway backstops: `OPERATOR_REACT_DEPTH_CAP = 4 :173`,
`OPERATOR_TRANSITION_CHAIN_CAP = 8 :186`, `nextTransitionChainDepth :190` (a
human-authored transition restarts the chain at 0),
`operatorShouldReactToReply :195` (no reply, a duplicate reply, or a depth at
the cap stops the loop).

### 4.3 Revisions, verdicts, validation

`WorkRevision` is the immutable identity of the work under review. `nextWorkRevision(current, input)`
(`task-file.schema.ts:912`): a head with the **same tree** (or same head when the
tree is unavailable) is the SAME review subject — no new revision, prior verdicts
stay valid. Anything else mints a new id, which makes every prior verdict stale
automatically. That *is* new-commit invalidation (F10-15/F10-32). This helper has
exactly one caller (a delivering run's reconcile) and always mints
`kind: "delivered"` `:937-940`.

`deriveValidation(fm)` `:725`, in order:
1. no `workRevision` ⇒ `none`
2. any required reviewer `request_changes` on the current revision ⇒ `failing`
3. required reviewers exist and ALL approved ⇒ `healthy`
4. `acceptance === "forced"` ⇒ `bypassed` (N20-14 — a durable human override;
   re-deriving the pre-accept pending state would be a false live obligation)
5. `noChanges && required.length === 0` ⇒ `none`
6. else ⇒ `changed`

Arm order is load-bearing and documented at `:742-775`: a recorded verdict is
EVIDENCE and must never be erased into "nothing to see", so the real-verdict arms
win; only the genuinely moot case yields.

`acceptanceBlockedReason(fm)` `:789` — required reviewers must have approved the
CURRENT revision. With no revision and required reviewers it names the way out
("run delivery once to verify and record that") rather than dead-ending (F19-21).
Sibling gates, all shaped reason-or-null:
`closedPrBlockedReason :833` (a PR closed unmerged is an out-of-band rejection —
ONE guard, ≥3 call sites, P13-D-4),
`conflictingPrBlockedReason :854` (P14-LV-07: VM-4 went to Done with the PR still
open and conflicting while the timeline blamed missing credentials),
`archivedTaskBlockedReason :873`, `archivedTaskMoveBlockedReason :892`.

### 4.4 Acceptance ceremony (ruling 53 + 88)

`app/shared/acceptance-disclosure.ts` — the ceremony must DISCLOSE what it
accepts, and the confirmed click must **echo** the three displayed facts back:
`AcceptanceDisclosure {pr, revision, verdict}` `:35`, form fields
`ACCEPT_DISCLOSURE_FIELDS = {ackPr, ackRevision, ackVerdict} :48`,
`parseAcceptanceDisclosure :85` (deliberately strict — a half-filled or
unrecognised echo is NOT a disclosure), `acceptanceDisclosureDrift(live, echoed,
scope) :137` with `scope: "full"` pre-merge and `"in-lock"` (PR fact excluded,
because the acceptance's own merge may already have moved it).

A **bare POST carries no echo and is refused** — pass 21 found R15-1's
consolidation was client architecture only, and the server took a bare POST
(`:8-14`). Server side: `acceptanceDisclosureOf`
(`tasks/task-actions.server.ts:7433`) derives the comparison from the task file
using the same expression the projection stores in `work_revision_sha`
(`fm.workRevision?.headSha ?? "none"`, rebuilder `:608`).

Related server surface: `acceptanceTerminallyBlocked :6937`,
`acceptancePrHeadCheck :7022`, `acceptancePrHeadMismatch :7074`,
`acceptanceRefusalFor :7167`, `resolveAcceptanceAffordance :7251`,
`revisionDriftNote :7338`, `applyAcceptanceWrite :7515`,
`forceAcceptCompletion :8048` (admin-only `force-accept-completion`, DG-2),
`completeTaskMerge :8144`.

### 4.5 Packets, recommendations, schedules

`resolvePacket` (`:5792`) dispatches on the stable `PacketOption.kind`, never on
English titles (ruling 7). `packetIdentity(p) :5776` is the packet id, or a
content fingerprint when absent — captured before the lock and re-checked inside
it, so a REPLACEMENT packet opened in the read→await→lock window cannot be
resolved by the stale action (F10-09).
Notable arms: `archive_task` `:6460` runs the real R14-3 archive contract (and
with `deleteBranch: true` deletes the remote branch, refused while the PR is
open); `discard_branch` `:6572` deletes the LOCAL never-pushed workspace branch
only, refusing when the branch exists on the remote (R20-2/F20-6); both require
`approve-transition`. `edit_goal` stamps `awaiting: "goal_edit"` and the packet
clears when `updateTaskGoal` lands.
`requestPacketMaintainerDecision :6721` escalates when the resolver lacks
authority.

Recommendation flow: `applyRecommendation :8250` /
`dismissRecommendation :8448` (audit action
`RECOMMENDATION_DISMISSED_AUDIT_ACTION :8441`). Applying passes
`recommendationAuthorized` to the inner mutation, whose OWN cap still applies —
widening the outer gate never widens what the owner can make the machinery do.

Recovery packets: opened when the bounded operator loop stalls
(`:2220`), withdrawn after successful agent work (`:2339`) — and the withdrawal
is scoped by the packet's `discard_branch` option, deliberately leaving a
reject-recovery packet (which uses `archive_task`) alone `:2427-2446`.

Schedules: `scheduleTaskAction :131` / `cancelScheduledAction :221` /
`tasksWithUnresolvedSchedules :280` (reads `schedules_json` from the projection,
not every task file) / `fireDueSchedules :332` / `startScheduleRunner :788`
(`tasks/schedule.server.ts`). Never fires on a terminal or archived task;
archiving cancels `pending`/`claimed` entries
(`task-actions.server.ts:5724-5728`, P14-RV-03).

### 4.6 No-change completion (R17-2 / R19-8)

`noChanges` marks a task that completes with nothing to deliver. Two producers:
a delivery attempt that found the branch empty (`performDelivery`'s
`nothing_to_review`), and a reviewer approving a task that never needed a branch
(`recordAgentCompletion`, which also mints the `kind: "verified"` revision the
verdict binds to). It is a **claim about a moment that has passed**, so
`acceptanceNoChangeCheck` (`tasks/no-change-completion.server.ts:280`)
re-verifies it against the LIVE remote before any writer closes the task to
Done; `assertVerifiedNoChangeStillApplies :339` is the in-lock assertion.
Cleared the moment a delivery opens a PR. Do not hand-set it.
Also here: `probeNothingToDeliver :107`, `noChangeApplies :69`,
`noChangeCandidate :79`, `noChangeCompletionEvent :361`.

### 4.7 Engagements are written by the DISPATCH (ruling 98)

`startAgentRun` → `dispatchAgentRun`
(`tasks/specialist-run.server.ts:1099`, `:1116`). Running an agent that is not
yet engaged **engages it** — the pre-assignment ceremony is gone `:1140-1151`:
- posture derives from the profile's own capability grants: delivering iff the
  task has no deliverer AND the profile holds a repo-write grant
  (`view.capabilities?.delivery === true` `:1162-1164`); supporting otherwise.
- a delivering request against a profile with no repo-write grant is **refused
  by name** with the remedy `:1165-1172` (R21-2 posture), on BOTH doors to
  `delivers: true` — the second door (`input.delivers === true` on an already
  supporting engagement) got the same check in the 2026-08-29 hunt `:1212-1225`.
- `assignSpecialist :673` / `assignReviewer :848` are the actual engagement
  writers; `removeReviewer :980`.
- Single-flight: a delivering dispatch refuses with 409 when a live `primary`
  run exists `:1259-1275`; supporting runs get their own isolated checkout
  `workspace/support/<profileId>/<repo>` and are guarded by the per-profile
  index `:1276-1283`.

---

## 5. Gotchas — the sharp edges

1. **One process per data root, ever.** Never run a host dev server against
   `docker-data` while the container is up. The lock refuses the second boot
   (`data-root-lock.server.ts:458`), but a *different hostname* also refuses a
   genuinely dead holder — that is deliberate (`classifyLock :318`). Clear it
   with `VIBERR_FORCE_DATA_ROOT_LOCK=1` or by deleting `state/writer.lock`.
   Never wipe `<dataRoot>/state` while a process is running: the guard will
   `process.exit(1)` (`:584`).

2. **Migrations are squashed and forward-only.** Editing
   `db/migrations/0001_baseline.sql` reaches FRESH databases only
   (`0001_baseline.sql:10-19`). Adding a column or widening a CHECK requires a
   re-baseline (`npm run seed -- --reset`), which regenerates user ids and
   destroys sealed PATs / audit / notifications. Boot warns about both drift
   shapes (`boot.server.ts:160,198`) — read the WARN, it carries the remedy.
   When you widen `VALIDATION_VALUES`, widen the CHECK at
   `0001_baseline.sql:102` in the same commit (`projection-validation-check.test.ts`
   pins them).

3. **Tolerant parse ≠ tolerant write.** Reads never throw and never drop an
   entity; writes REFUSE on any `hardStop`
   (`task-writer.server.ts:144`, `ERROR_CODES.FILE_NOT_TRUSTED`). The reverse
   asymmetry also exists: `splitFrontmatter`'s CRLF normalization matters
   because the write guard only refuses WRITES — the READ/projection path
   happily projects a broken file (`frontmatter.server.ts:35-41`).

4. **Whole-array vs per-row parsing.** Any list whose loss would PERSIST must go
   through `tolerantRows` / `tolerantArray`. The failure mode is silent: one bad
   row empties the list, the diagnostic is only a warning so the file stays
   writable, and the next write serializes the empty list over the good rows
   (`task-file.schema.ts:1041-1050`, `project-file.schema.ts:287-294`). This is
   a recurring bug class in this repo — grep every sibling when you fix one.

5. **`validation` in the file is a CACHE, not truth.** Always call
   `deriveValidation(fm)`. The projection does (`rebuilder.server.ts:443`); a
   hand-edited `validation:` line is admitted by the canonical-files rule and
   would otherwise put "healthy" on a card whose gate says "no approving
   verdict".

6. **Projection columns that intentionally diverge from the file.**
   `waiting` is forced to `none` in the terminal stage (`:481`);
   `repo` is always the project's (`:598`);
   `validation_block_reason` omits three gates by design (`:303-338`).
   Do not "fix" these to match the file.

7. **Boot re-baseline vs boot rescan.** The rescan (`boot.server.ts:617`) only
   reconciles PROJECTION rows from files. It cannot recover users, sessions,
   PATs, audit or notifications — those live only in `projection.sqlite`. Run
   `npm run backup` before deleting it.

8. **The reclaim/recovery ordering at boot is load-bearing.** Do not move the
   workspace reclaim earlier: recovered completions LAUNCH runs that clone
   exactly the paths the reclaim `rmSync`s, so the chain joins `orphanReinvokes`
   AND re-asks `activeRunCount(db) > 0` (`boot.server.ts:446-468`).

9. **Watcher blind spots.** `ignoreInitial: true` means an external edit landing
   inside the sub-second initial scan window is picked up only on its next touch
   or a manual rescan. Anything deeper than `<slug>/tasks/<KEY>/task.md` is
   ignored outright (`file-watch.service.server.ts:111`) — `workspace/` and
   `attachments/` are invisible to it, on purpose. A `projects` row deletion does
   NOT cascade task rows, so the directory reconcile prunes them explicitly
   (`:196-205`).

10. **Read-your-own-writes on VirtioFS.** Both the task and project writers keep
    an in-process `lastWritten` cache and prefer it when the disk read
    disagrees and mtime has not advanced past `wroteAtMs + 100`
    (`task-writer.server.ts:91`, `project-writer.server.ts:75`). If you add a
    third canonical file kind with its own writer, it needs this too.

11. **`agent_runs.kind` is a delivery axis, not a role.** `reviewer` means "does
    not deliver" — a non-delivering *developer* is stored as `reviewer`
    (`0001_baseline.sql:460-473`). Every query that means "reviews" must read
    `role` / `verdictCapable`, not `kind`.

12. **`capabilities: []` is not "no powers."** An unspecified capability is
    GRANTED unless it is in `GRANT_REQUIRED_CAPABILITY_IDS`
    (`capabilities.ts:392`). Every creation path must persist EXPLICIT grants
    (`defaultGrantsFor :165` / `conservativeGrantsFor :192`).

13. **KB grants resolve by DIRECTORY, not display name.** A wrong `kb:` entry
    degrades to a `logger.warn` and an empty body while the UI still shows the KB
    attached (`docs/architecture/file-formats.md:418-424`). Renaming a KB dir
    orphans grants.

14. **The seeded operator's grants are spelled as catalog LABELS** and resolved
    via `capabilityByLabel` (`seed/agent-catalog.server.ts`). A label edited in
    `UNIFIED_CAP_CATALOG` does not error — the grant silently degrades to a
    display-only `extra` with no runtime authority (`capabilities.ts:47-51`).

15. **Timeline body escaping is a security boundary, not formatting.** An
    unescaped `## Timeline` in a goal or comment forges the history the
    acceptance decision reads (`task-file.server.ts:87-100`). External appenders
    MUST apply the same escape.

16. **Duplicate `## Goal`/`## Packet`/`## Timeline`: FIRST wins.** Never
    last-wins — a later duplicate must not override real state
    (`task-file.server.ts:446-459`).

17. **`operatorAuthorized` must never come from a request.** Same for
    `recommendationAuthorized` and `rework` on `transitionStage` — forging any
    of them from a form bypasses the RBAC tier
    (`task-mutation.server.ts:53`, `task-actions.server.ts:4200-4205`).

18. **Acceptance requires the echo.** Any new door to Done must thread `ack`
    and go through `acceptCompletion`; a bare POST is refused with
    `accept_disclosure_missing` (`acceptance-disclosure.ts:8-31`). And any new
    writer that lands `stage = done` must call `closedPrBlockedReason` — three
    writers already do, a fourth must too (`task-file.schema.ts:817-832`).

19. **In-lock re-checks, not pre-checks.** The idempotence/state checks outside
    the file lock are FAST PATHS. `transitionStage` `:4375`, `resolvePacket`'s
    packet-identity re-check `:5776`, and `recordDeliveredNextStep` all re-run
    the decision inside the lock. Two submits of one human act otherwise produce
    two timeline entries and two audit rows (NFR16/NFR18).

20. **Dynamic `await import()` inside this module graph is dangerous.** It hides
    real cycles and can resolve to a half-evaluated namespace at runtime
    (`task-mutation.server.ts:16-42`). Put shared leaf helpers in
    `task-mutation.server.ts`, not `task-actions.server.ts`.

21. **`rebuildPath` swallows every throw** into `{action:"error"}` +
    "projection rebuild failed" (`rebuilder.server.ts:958`). A row that silently
    stops updating almost always means a schema/CHECK problem — check the boot
    integrity WARN and `provenance` rows with `action = 'error'`.

22. **`npm run rescan` counts THROWS, not untrusted files.** A malformed file
    never throws, so it reports `0 errors`. Use `npm run store:check`
    (`files/store-check.server.ts:202` `checkStore`, report `:244`) or
    `untrustedFileReport(db) :329` — the latter reads `diagnostics` where
    `hard_stop = 1`. Recovery is `npm run restore -- --file <path> --from
    <artefact>` (one file, without rolling SQLite back with it).

23. **Never put a secret in `instance_settings`.** Sealed secrets need their own
    column so key rotation can reseal them — see `s3_audit_config.secret_box`
    and the `SEALED_STORES` registry (`0001_baseline.sql:271-292`).

24. **`verification` looks dead — keep it.** better-auth writes it on every
    OAuth sign-in (`0001_baseline.sql:540-550`).

25. **Stage ids are never literals.** Use `resolveStageRoles` /
    `isTerminalStage` (`app/shared/workflow/stage-roles.ts`). The old
    `stage === "done"` and `stages[length-2]` idioms are the root cause of the
    positional-vs-literal bug family.

26. **`readdirSync(withFileTypes)`, never `statSync`, when listing store
    folders.** `statSync` dereferences, so `kb/notes -> /etc` was listed as a
    first-class KB and injected as trusted context
    (`org/resources.server.ts:103-113`). Every store reader also needs the
    two-layer containment check (`org/store-files.server.ts:162`): lexical
    `path.relative` **plus** `realpathSync` — lexical alone proves the path
    *string* is contained, not the file.

27. **Injection budgets are shared across the whole grant list, not per item**
    (24 000 chars each for skills and KBs), and headings are charged against
    them. A profile with many grants silently pushes later ones into the
    "omitted entirely" marker path
    (`files/skill-body.server.ts:36`, `files/kb-injection.server.ts:64,222`).

28. **`org_knowledge_bases.refresh` CHECK still permits `'nightly'`**
    (`0001_baseline.sql:357`) though the product removed it. A hand-written
    `'nightly'` row passes the DB and is silently coerced to `"on change"`
    (`org/resources.server.ts:215`).

29. **Grant slugs are asymmetric.** KBs are referenced by `dir` (the slugified
    name); MCPs and skills by `name`. `org-view.server.ts:191-198` and
    `resource-catalog.server.ts:31-32` both depend on it — renaming a KB changes
    the reference, renaming only its display name does not.

30. **`PRIOR_SHIPPED_HASHES` needs manual maintenance.** Editing any file under
    `app/server/seed/assets/` without appending the outgoing hash
    (`seed/default-assets.server.ts:175-178`) strands pre-manifest stores on the
    old version forever (they now WARN, `:428-441`).

31. **Never inherit `process.env` into a spawned MCP child.** Use
    `filteredSpawnEnv()` (`org/resources.server.ts:871`) — inheriting handed
    every registered third-party command the secret-encryption key, the session
    secret and the provider keys (F10-02). Spawn `detached` and kill by process
    group (`killProcessTree :905`) so npx→node→chromium grandchildren are not
    orphaned to pid 1.

32. **The redactor has no length floor.** `redactGitOutput` scrubs by VALUE
    first with `split`/`join` (`secrets/git-output-redact.server.ts:87-98`); the
    old `>= 8` floor let a 5-char credential into an MCP row's `last_error`, a
    toast and the DB (F20-7). Clamp from the END — a clamp that keeps the
    command echo and drops git's verdict defeats the point.

33. **Health probes must not write.** PAT scope validation proves repo-write
    read-only from `GET /repos/{r}`'s `permissions` block; the write probe is
    opt-in behind `VIBERR_GITHUB_WRITE_PROBE`
    (`secrets/pat-validator.server.ts:48-62,96`). A 5xx is `network_error`, not
    a rejection. A write scope's violation clears only on `header`/`probe`
    evidence, never `assumed` (`:677-685`).

34. **Attachment serving is whitelist-only.** `INLINE_TYPES`
    (`files/task-attachments.server.ts:127`) excludes HTML/SVG/JS on purpose — a
    stored page served on the app origin is stored XSS with the viewer's
    session. A traversal in the name must 404, never 403 (no existence oracle).

35. **404, not 403, for project visibility.** `requireProjectMember` collapses
    "does not exist" and "not a member" into one 404
    (`auth/require-project.server.ts:81`) because single-fetch honours a client
    `?_routes=` filter, so a child loader runs without the layout's guard
    (F19-28). The action-side twin `requireVisibleProject` must be called
    **outside** the try block so the refusal stays a thrown 404 and never
    becomes an `appErrorResponse` 403
    (`routes/project.task.tsx:420`, `routes/project.board.tsx:53`).

36. **CSRF fails closed on a request with no origin signals at all.**
    `assertTrustedOrigin` 403s when `Sec-Fetch-Site`, `Origin` and `Referer` are
    all absent (`auth/csrf.server.ts:96`) — the old curl concession bought
    nothing. Fetcher routes must use `csrfError(...)`
    (`app/features/shell/csrf-result.server.ts`), not the thrown `Response`, or
    the 403 replaces the whole UI and every `{ok:false}` toast branch becomes
    unreachable (UI-32).

37. **Only a `valid` verdict is ever cached or reused.** Connection freshness
    (`org/connections.server.ts:235,280`) and PAT revalidation
    (`pat-validator.server.ts:543,645`) both refuse to reuse a failing or
    `network_error` result, and cache reuse additionally requires the **same
    repo** — the connection modal validates with `repo: null`, and its
    repo-less `valid` used to suppress the first project-scoped check.

38. **The single-flight helper is a cooldown, not a mutex**
    (`projections/single-flight.server.ts:10-16`), and it stamps the timestamp
    **before** the work runs `:64` so a throw still holds the cooldown. Never
    wrap a correctness-critical rebuild in it — its contract is that a skipped
    run is acceptable `:20-24`.

39. **`rebuildProjections` must emit only after commit.** It DELETEs the four
    derived tables and re-projects inside one transaction, wrapped in
    `collectProjectionEvents`, re-emitting afterwards
    (`projections/rebuild.server.ts:52-53`) — an SSE-triggered revalidation must
    never race a half-built or rolled-back projection.

40. **SSE authorization is re-resolved on every heartbeat.**
    `reauthorize()` (`events/sse-broker.server.ts:278`) runs each 25 s tick
    because these streams are open-ended; returning `[]` drops the connection,
    and a THROW keeps the existing scopes (a check that could not run must
    neither widen access nor tear down a healthy stream).
