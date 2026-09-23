# Projections, the watcher, and live events

> How canonical files become SQLite rows, how a change reaches every open
> browser tab, and how a malformed file degrades.
>
> Source of truth: `app/server/files/*`, `app/server/projections/*`,
> `app/server/interpretation/*`, `app/server/events/*`,
> `app/server/runtimes/run-events.server.ts`, `app/server/org/resource-events.server.ts`,
> `app/routes/resources.events.ts`, `app/schemas/sse-event.schema.ts`,
> `app/features/live-updates/*`, `app/features/runtime/use-run-log-stream.ts`.
>
> Verified against `main` @ `7d9fbf72` (2026-09-23); §5 and §6 against `8bbe2083` (PR #318).

## 1. The write path

Every governed mutation follows one order: write the canonical file through its
writer module → re-project that one file synchronously (`rebuildPath`) → notify and
audit. The SSE event is a side effect of the re-projection, so a change made by the app
and a change made by hand on disk reach clients through the same door.

Writers (`app/server/files/`):

- **Atomic writes**: `writeFileAtomic` stages to `<file>.<8 hex>.tmp` in the same
  directory and renames, removing the staging file on failure. `ENOSPC` becomes a named
  "no space left on the data root" error; `ESTALE`/`EIO` become a 503 naming the data
  root unreachable.
- **Per-file mutex**: `withFileLock(key)` (Web Locks, `navigator.locks`, in-process)
  wraps every read-modify-write of `task.md`, `project.md` and goal files, plus a
  goals-directory lock (`withGoalsLock`) around minting a goal id.
- **Read-your-own-writes**: `write-cache.server.ts`, shared by the task, project and goal
  writers, remembers the last content this process wrote per path and prefers it when a
  locked read disagrees and the mtime has not advanced past the write by more than
  100 ms (bind mounts over VirtioFS serve stale reads).
- **Parse memo** (ruling 454): `readProjectFile`, `readTaskFile` and
  `readAgentProfileFile` still read the file on every call, but skip the YAML + Zod
  parse when the bytes equal the bytes they last parsed for that path
  (`parse-memo.server.ts`; 256 entries, 4 M characters). The key is the content, not
  the file's stat, so any change on disk is seen by the next read and a stale
  bind-mount read is never pinned; each caller gets its own `structuredClone`.
- **Trust guard**: `updateTaskFile` and `updateProjectFile` refuse to write a file whose
  parse produced a hard-stop diagnostic (`file_not_trusted`, 409): a write would replace
  the human's content with defaults. `updateGoalFile` refuses a goal file that does not
  parse (409). `updateTaskFile` always bumps `updatedAt`; `updateGoalFile` writes nothing
  when the bytes are unchanged.
- **Frontmatter**: `---` fences, YAML between, markdown body after; BOM stripped,
  CRLF and lone CR normalized; unknown top-level keys round-trip verbatim in task,
  project, goal and agent-profile files (an agent profile also warns
  `agent_profile.unknown_field`).

## 2. The watcher

`startFileWatcher` runs chokidar over `<dataRoot>/projects` (`ignoreInitial`, no
symlink following, atomic-write coalescing) with a **250 ms trailing debounce per
path**. It ignores any dot-prefixed segment, any `*.tmp`, and everything at depth 4 or
deeper except `tasks/<KEY>/task.md`, so `workspace/`, `attachments/` and mirrors are
never traversed. It reacts to `project.md`, `task.md` and `goals/*.md` with
`rebuildPath`, and reconciles directory deletions: a removed project or `tasks/`
directory re-checks every projected task of the project, a removed task directory
projects the task's removal, and a removed `goals/` directory prunes its goal rows.

A rebuild that fails (a throw, or `rebuildPath` answering `error`) is retried per file
at 2, 5, 15, 45 and 120 seconds, reset on the first success (ruling 218); past the last
step the watcher gives up and the fault stays on the health report (§4). A watcher
`ENOENT` is ignored; any other error clears the handle (health reports `watcher: false`
and `degraded: ["watcher"]`) and, for the transient codes `EMFILE`, `ENFILE`, `ENOSPC`,
`EPERM` and `EACCES`, re-arms after 2 seconds.

`ignoreInitial` pairs with the **boot rescan**: edits made while the process was down
are converged by one hash-short-circuit rescan before the watcher takes over.

`startKbWatcher` watches `<dataRoot>/kb` the same way (250 ms debounce per KB directory)
and re-indexes the knowledge base a change belongs to (a KB set to `manual` refresh is
skipped), then broadcasts `resource.updated`.

## 3. Tolerant parsing and diagnostics

Parsing never throws and never drops an entity. Every problem becomes a
`FileDiagnostic {severity: info | warning | error, code, path, message, hardStop}`,
stored in the `diagnostics` table and shown on the task page.

Readiness floors (`diagnostics-policy.server.ts`): `hardStop` → `blocked`, `error`
→ `inconsistency_risk_detected`, `warning` → `input_required`, `info` → no effect.
`deriveReadiness` (`readiness-policy.server.ts`, the only place readiness is derived)
respects the stored value unless a floor outranks it; it never improves a stored
value. The second floor is the dependency floor (ruling 131): a non-empty `blockedBy`
list floors readiness at `blocked`. The projection stores both the derived `readiness`
and the raw `stored_readiness`.

Codes worth recognizing: `frontmatter.missing | unterminated | invalid_yaml |
not_a_map` (all hard stops), `frontmatter.missing_key` / `key_mismatch` /
`missing_slug` / `slug_mismatch` (the directory name wins), `frontmatter.missing_field`,
`frontmatter.invalid_field` (per row: one bad list entry drops itself, never the
list), `frontmatter.unresolved_stage`, `frontmatter.duplicate_engagement`,
`frontmatter.multiple_deliverers` (the extra deliverer is demoted), `project.no_stages`,
`body.duplicate_section` (first wins), `body.missing_goal | missing_timeline`,
`packet.no_yaml_block | invalid_yaml | invalid_option | invalid_observation | invalid |
rec_count`, `timeline.malformed_heading | invalid_timestamp | unknown_actor |
malformed_evidence | stray_content | unknown_type | out_of_order`,
`reference.unknown_stage`, `agent_profile.invalid | unknown_field`. Goal files are the
exception: a goal whose frontmatter is not a map or fails the schema has no partially
usable form, so every finding (`frontmatter.not_a_map`, `frontmatter.invalid_field`,
plus the fence codes) is a hard stop and the goal does not project.

`npm run store:check` lists every project, task and goal file the app cannot trust
(hard stop) or that is degraded (error), with the offending line. `npm run rescan`
counts rebuilds that ended in `error`, not untrusted files: a malformed task or project
file still projects (with defaults and a hard stop) and reports zero errors there, while
an unparseable goal file counts as one.

## 4. Projection tables and the rebuilder

`rebuilder.server.ts` owns files → SQLite:

- `rebuildProjectFile` upserts `projects` (JSON copies of stages, workflow, agent
  policy, credential policy, guardrails, and the project's required-reviewer rules
  resolved to stage and agent names, ruling 178), rewrites `project_members`, replaces
  the file's `diagnostics`, records provenance, writes the content hash **last**, emits
  `project.updated`, and forces every task of the project to re-project when the
  project row is new or changed. A vanished `project.md` deletes its diagnostics first
  and the `projects` row last (members cascade), and emits `project.removed`.
- `rebuildTaskFile` computes the derived `readiness` (`deriveReadiness`: the
  diagnostics floor and the dependency floor, while `stored_readiness` keeps the file's
  value), stores `blocked_by_json` verbatim, `validation` (`deriveValidation`, never the
  stored cache), `validation_block_reason` (closed PR → required reviewers' approval of
  the current revision → the project's declared required reviewers (ruling 178) → verdict
  gate → open blocked packet → delivered revision not on the PR (ruling 135) →
  conflicting PR), `acceptance` (the force-accept fact), `continuity` (`degraded` when a
  `continuity` event exists), `waiting` (forced to `none` in the terminal stage; `schedule`
  when a stored `human` wait rests only on a pending schedule occurrence with no packet,
  no recommendation, nothing a human could accept now, no `blockedBy` and not archived,
  ruling 225; a stored `schedule` projects as `human`), `repo` always the project's,
  counts and `recommendation_kinds`, `schedules_json`, `goal_id` / `goal_link_index`,
  `work_revision_sha` (the active work revision; a discarded one projects as null,
  ruling 161), `board_rank`; rewrites `task_events` wholesale (position 0 = newest, actor
  snapshot denormalized into `actor_json` so events survive member removal, agent
  `actor_ref` keyed `agent/<profileId>`); stores `""` as the hash until events and
  diagnostics landed; emits `task.updated`. A vanished `task.md` deletes events and
  diagnostics first and the projection row last, and emits `task.removed`.
- `rebuildGoalFile` reconciles link statuses against live task rows (a terminal-stage
  task makes its link `done`, an archived one `failed` unless already `done`, `skipped`
  stays, and a `done`/`failed` link whose task moved back becomes `active`) and emits
  `goal.updated`. A goal file that does not parse writes its hard-stop diagnostics and a
  provenance `error` row and keeps its previous projection.
- `dependencies.server.ts` (ruling 131) is the READ model beside the rebuilder:
  `resolveDependencies` / `dependencyResolver` map each stored entry to
  `open | done | failed | missing` from the live projections (a task at the
  terminal stage is `done`, an archived one `failed`; a goal link takes its task's
  state once created, else its own status, `skipped` counting as done). The board
  query resolves every row through ONE resolver; the task query resolves on read;
  nothing caches a resolved state. `listHeldTasks` feeds the release engine.
- `rebuildPath` routes a path to the right rebuilder with a content-hash
  short-circuit unless forced. It swallows every throw: the log line `projection rebuild
  failed`, a per-file projection fault (`store-health.server.ts`, rulings 217 and 218),
  and a provenance `error` row attempted in its own `try`, so a store too broken to take
  even that gets one warn line and the caller still receives `{ action: "error" }`
  (ruling 219). While any file's fault stands, `/resources/health` reports
  `degraded: ["projections"]` with the file count and the latest fault; the next rebuild
  of THAT file that writes clears it.

**Derivation version.** The hash short-circuit never re-projects an unchanged file, so a
change to how the rebuilder derives a column would leave old rows in the old shape.
`derivation-version.server.ts` holds `PROJECTION_DERIVATION_VERSION` (4); boot compares
it with the `projection.derivationVersion` instance setting and, when the stored value
lags, runs one forced full rescan and writes the new stamp only if no file failed, so the
next boot retries otherwise. Bump it with any change to a derived column.

Whole-store operations:

| Operation | What | Cooldown | Where |
|---|---|---|---|
| **Rescan** | Walk projects → tasks → goals, re-project changed files by hash, prune vanished rows, one `rescan` provenance row, `projection.rebuilt {scope: full}`. Audit `projection.rescan`. | 10 s (`RESCAN_MIN_INTERVAL_MS`) | Home store strip (org admin), `npm run rescan` (takes the writer lock; `--force` reprojects everything), boot |
| **Project rescan** | `rescanProject` → `rebuildProject`: the same reconcile confined to one project, `projection.rebuilt {scope: project}`. Audit `projection.rescan` with the slug. | none | Board Re-scan (`rescan-project`: project admin or maintainer) |
| **Rebuild** | One transaction: `DELETE` `task_events`, `diagnostics`, `task_projections`, `projects` (members cascade), then a forced full rescan; events buffered until commit. Audit `projection.rebuild`. Users, sessions, secrets, audit, notifications, provenance and runs untouched. | 30 s (`REBUILD_MIN_INTERVAL_MS`) | Home store strip (org admin, confirm dialog) |
| **Store check** | Read-only parse of every project, task and goal file, no lock. | none | `npm run store:check` |

The single-flight helper is a cooldown, not a mutex: it stamps the timestamp before
the work runs and a throttled call answers `{ status: "throttled", retryAfterMs }`
(the Home actions return it as a 429).

## 5. Events and SSE

**Projection events** (`projection-events.server.ts`): `task.updated`, `task.removed`,
`project.updated`, `project.removed`, `projection.rebuilt {scope, changed}`,
`notification.created {userId}`, `notification.read {userId}`, `violation.updated
{projectSlug, taskKey}`, `goal.updated {projectSlug, goalId}`. Inside
`collectProjectionEvents` (the rebuild's transaction) they are buffered and re-emitted
only after commit; a throw discards them. The publisher (`event-publisher.server.ts`)
translates each into the wire shape `{ type, entityId, occurredAt, data }`, reading back
the task's stage and readiness for `task.updated`, and zod-parses every event against
`sseEventSchema` before publishing.

Three publishers bypass the projection emitter on purpose and call the broker directly:
the run stream (`runtimes/run-events.server.ts`: `run.log-appended` and
`run.state-changed`, reference-only so the dedicated log consumer fetches content from
`/resources/run-log`), the controller's frames (`controller.updated` from
`publishConversationUpdated`, and `controller.log-appended`; a controller run has no task
scope, so the sink hands `run-events.server.ts` the owner route `controllerRunRoute`
resolved, a controller run's state change publishes `controller.updated`, and a run with
an empty project slug and no route publishes nothing), and the org resource broadcast
(`org/resource-events.server.ts`: `resource.updated`).

**The complete wire event list** (`SSE_EVENT_NAMES`, 16 names) and how each is routed:

| Event | `data` | Route |
|---|---|---|
| `task.updated` | `projectSlug, taskKey, stage, readiness` | project + task |
| `task.removed` | `projectSlug, taskKey` | project + task |
| `project.updated`, `project.removed` | `projectSlug` | project |
| `projection.rebuilt` | `scope` (`full` or `project`), `changed` | broadcast |
| `notification.created`, `notification.read` | `userId` | that user's `user` scope |
| `violation.updated` | `projectSlug, taskKey` (nullable) | project, plus task when named |
| `resource.updated` | `kind` (`kb`, `skill`, `mcp`), `id` | broadcast |
| `run.log-appended` | `projectSlug, taskKey, runId, threadId, seq` | project + task, kept off the `projects` firehose (`skipFirehose`) |
| `run.state-changed` | `projectSlug, taskKey, runId, threadId, state` | project + task |
| `controller.updated` | `conversationId, userId` | the owner's `user` scope |
| `controller.log-appended` | `conversationId, userId, runId, threadId, seq` | the owner's `user` scope |
| `goal.updated` | `projectSlug, goalId` | project |
| `stream.open` | `headId` | control: the connection's first message |
| `stream.resync` | `{}` | control: sent when replay cannot catch a reconnect up |

`controller.log-appended` is a **stream event** (`SSE_STREAM_EVENTS` in
`event-types.ts`): one frame per console line on the `user` scope every signed-in
surface subscribes, so `useLiveUpdates` does not revalidate on it; only the dedicated
log consumer handles it. `run.log-appended` is a **run-line event**
(`SSE_RUN_LINE_EVENTS`): the `project:` scope delivers it for every run of the project
(to the board, the controller page and every open task page, which subscribes its
project for the rail), but only the page whose `task:` scope names that task revalidates
on it, at most once per `RUN_LINE_REVALIDATE_MS` (2 s), because its Live run strip
(phase, step, turns, tokens) is loader data that moves per line. Nothing else a
project-scoped page renders changes per line: the board's "agent running" fact moves on
`run.state-changed`.

**The broker** (`sse-broker.server.ts`, behind the route `resources.events.ts`): one
connection per stream on `/resources/events` (401 JSON when signed out, since an
`EventSource` cannot render a login page; 400 for a malformed scope), scopes
`project:<slug>`, `task:<slug>/<key>`, `projects` (every visible project) and `user`.
Org admins keep any scope. For everyone else foreign project and task scopes are
dropped and `projects` is expanded to their memberships; an empty result is a 403. The
first message sets `retry: 5000` and sends `stream.open`. A 25-second heartbeat
(`: hb`) also **re-authorizes** every connection, dropping ones whose scopes vanished (a
throw keeps the existing scopes: a check that could not run must neither widen access
nor tear down a healthy stream). A 256-event ring buffer replays after a reconnect with
`Last-Event-ID`; an id older than the buffer, or a restart, sends `stream.resync` and
the client revalidates once. Queue backpressure caps at 1024 chunks per connection; a
failed write drops the connection. The broker also owns the process shutdown hook
(`runProcessShutdown`): close streams, stop both watchers and the lock guard, close the
DB and release the writer lock.

**The client** (`useLiveUpdates`): subscribes the current surface to its scopes (Home:
`user` + `projects`; a project page: `project:<slug>` + `user`, plus `task:<slug>/<key>`
when a task is open; the controller page: `user`, plus `project:<slug>` on a project;
the controller dock, Instance settings and notifications: `user`), revalidates the active
React Router loaders on any data event or `stream.resync` (debounced 300 ms; a run line
only on its own task's page, floored at 2 s, joining a pending revalidation rather than
pushing it out), and revalidates once on any connect that follows a previous stream. A
hidden tab holds no stream: the hook closes on `visibilitychange` and reopens on return
(ruling 301). A failed stream flips `paused` (the topbar's "live updates paused" chip),
reopens on a 2 / 5 / 15 / 30 s backoff, probes the session after two consecutive
failures and stops on a 401 until the user retries. There is no optimistic UI for
governed state: revalidation is the update mechanism. (Measured 2026-09-23 on the
ax-clone instance, before the run-line floor: each line of any run in the project
revalidated every open board and task page, and three open pages at 2.5 revalidations a
second pushed a trivial request's p90 from 8 ms to 157 ms on the server's one event
loop, the one the agents run on.)

The run-log console has its own `EventSource` (`useRunLogStream`), so a log line reaches
the console at once while the task loader refetches on run lines at most every 2 s: on
the task scope it tails `run.log-appended` and revalidates once on `run.state-changed`;
for a controller conversation it tails `controller.log-appended` on the `user` scope. It
fetches lines since its cursor from `/resources/run-log`, pages older history on demand,
revalidates every 20 s while a run is shown active (a missed terminal event cannot leave
the strip "running"), and also closes while the tab is hidden.

## 6. Provenance and freshness

The `provenance` table records what the projector and the reconciler observed:
`projected` (with diagnostics and event counts), `removed`, `error`, `rescan`,
`github.reconcile` (including project heartbeats), `github.merge`,
`github.branch_delete`. Readers derive "last synced" facts from it; it is never
pruned. Freshness rules live in `app/shared/freshness.ts` (re-exported through
`server/interpretation/freshness-policy.server.ts`): older than one hour is stale;
never checked is neutral, not stale. "Gone quiet" on a task (`task-activity.server.ts`)
derives from `task_events.occurred_at` and follows who is on the hook: one hour of
silence while the task waits on an agent or on nothing, 72 hours while it waits on a
human, and for a task resting on a schedule 72 hours past the occurrence's due time. It is
suppressed for archived, terminal, empty-timeline, held (`blockedBy`) and actively
running tasks. A page recomputes it when it revalidates, which is on a domain event (a
transition, a comment, a run starting or stopping) or a navigation, never on another
task's console lines, so a task that crosses into quiet shows it at the project's next
event, not the minute it crosses (`board-query.server.ts`).

## 7. Where things can bite

- A `projects` row deletion does not cascade task rows; the directory reconcile
  prunes them explicitly.
- The watcher's `ignoreInitial` means an external edit inside the sub-second initial
  scan window is picked up only on its next touch or a manual rescan.
- Any list whose loss would persist must be parsed per row (`tolerantRowsOf` in
  `schemas/file-diagnostics.ts`); a whole-array fallback silently empties the list and
  the next write serializes the empty list over good rows.
- `rebuildProjections` must emit only after commit; a revalidation racing a
  half-built projection is the reason events are collected during the transaction.
- A change to a derived column needs a `PROJECTION_DERIVATION_VERSION` bump, or
  existing rows keep the old derivation until their file changes.
- The baseline is squashed and forward-only: a CHECK value or column added to it reaches
  only fresh roots. Boot backfills the known nullable columns (`ensureBaselineColumns`)
  and WARNs `projection schema drift` for the rest; a row that silently stops updating
  almost always means a schema or CHECK problem.
- Stage ids are never literals; use `resolveStageRoles` and `isTerminalStage`.
