# Projections, the watcher, and live events

> How canonical files become SQLite rows, how a change reaches every open
> browser tab, and how a malformed file degrades. Source of truth:
> `app/server/files/*`, `app/server/projections/*`, `app/server/interpretation/*`,
> `app/server/events/*`, `app/schemas/sse-event.schema.ts`,
> `app/features/live-updates/*`. Verified against `main` @ `68b5480` (2026-09-01).

## 1. The write path

Every governed mutation follows one order: write the canonical file through its
writer module → re-project that one file synchronously → audit → publish. The SSE
event is a side effect of the re-projection, so a change made by the app and a
change made by hand on disk reach clients through the same door.

Writers (`app/server/files/`):

- **Atomic writes**: `writeFileAtomic` stages to `<file>.<8 hex>.tmp` in the same
  directory and renames. `ENOSPC` becomes a named "no space left on the data root"
  error; `ESTALE`/`EIO` become a 503 naming the data root unreachable.
- **Per-file mutex**: `withFileLock(absolutePath)` (Web Locks in-process) wraps every
  read-modify-write of `task.md`, `project.md` and goal files, plus a goals-directory
  lock for minting goal ids.
- **Read-your-own-writes**: the task and project writers remember the last content
  they wrote per path and prefer it when the disk read disagrees and the mtime has not
  advanced past the write by more than 100 ms (bind mounts over VirtioFS serve stale
  reads).
- **Trust guard**: `updateTaskFile` refuses to write a file whose parse produced a
  hard-stop diagnostic (`file_not_trusted`, 409): a write would replace the human's
  content with defaults. `updateTaskFile` always bumps `updatedAt`; `updateGoalFile`
  writes nothing when the bytes are unchanged; the project writer has no trust guard.
- **Frontmatter**: `---` fences, YAML between, markdown body after; BOM stripped,
  CRLF normalized; unknown keys round-trip verbatim (task, project, goal files; the
  agent-profile serializer drops unknown keys).

## 2. The watcher

`startFileWatcher` runs chokidar over `<dataRoot>/projects` (`ignoreInitial`, no
symlink following, atomic-write coalescing) with a **250 ms trailing debounce per
path**. It ignores any dot-prefixed segment, any `*.tmp`, and everything at depth 4 or
deeper except `tasks/<KEY>/task.md`, so `workspace/`, `attachments/` and mirrors are
never traversed. It reacts to `project.md`, `task.md` and `goals/*.md` with
`rebuildPath`, and reconciles directory deletions (a removed project or task directory
prunes its rows). `ENOENT` is ignored; other errors clear the handle (health reports
`watcher: false`) and re-arm after 2 seconds for transient codes.

`ignoreInitial` pairs with the **boot rescan**: edits made while the process was down
are converged by one hash-short-circuit rescan before the watcher takes over.

`startKbWatcher` watches `<dataRoot>/kb` the same way and re-indexes the knowledge
base a change belongs to (a KB set to `manual` refresh is skipped).

## 3. Tolerant parsing and diagnostics

Parsing never throws and never drops an entity. Every problem becomes a
`FileDiagnostic {severity: info | warning | error, code, path, message, hardStop}`,
stored in the `diagnostics` table and shown on the task page.

Readiness floors (`diagnostics-policy.server.ts`): `hardStop` → `blocked`, `error`
→ `inconsistency_risk_detected`, `warning` → `input_required`, `info` → no effect.
`deriveReadiness` (`readiness-policy.server.ts`, the only place readiness is derived)
respects the stored value unless a floor outranks it; it never improves a stored
value. The projection stores both the derived `readiness` and the raw
`stored_readiness`.

Codes worth recognizing: `frontmatter.missing | unterminated | invalid_yaml |
not_a_map` (all hard stops), `frontmatter.missing_key` / `key_mismatch` /
`missing_slug` / `slug_mismatch` (the directory name wins), `frontmatter.missing_field`,
`frontmatter.invalid_field` (per row: one bad list entry drops itself, never the
list), `frontmatter.unresolved_stage`, `frontmatter.duplicate_engagement`,
`frontmatter.multiple_deliverers` (the extra deliverer is demoted), `project.no_stages`,
`body.duplicate_section` (first wins), `body.missing_goal | missing_timeline`,
`packet.no_yaml_block | invalid_yaml | invalid_option | invalid | rec_count`,
`timeline.malformed_heading | invalid_timestamp | unknown_actor | malformed_evidence |
stray_content | unknown_type | out_of_order`, `reference.unknown_stage`,
`agent_profile.invalid | unknown_field`. Goal files are the exception: their parser is
strict, and any schema failure is a hard stop.

`npm run store:check` lists every file the app cannot trust (hard stop) or that is
degraded (error), with the offending line. `npm run rescan` counts throws, not
untrusted files, so a malformed file reports zero errors there.

## 4. Projection tables and the rebuilder

`rebuilder.server.ts` owns files → SQLite:

- `rebuildProjectFile` upserts `projects` (JSON copies of stages, workflow, agent
  policy, credential policy, guardrails), rewrites `project_members`, replaces the
  file's `diagnostics`, records provenance, writes the content hash **last**, emits
  `project.updated`, and forces every task of the project to re-project when the
  project row changed.
- `rebuildTaskFile` computes the derived `readiness` (`deriveReadiness`: the
  diagnostics floor and, ruling 131, the dependency floor: a non-empty `blockedBy`
  floors it at `blocked` while `stored_readiness` keeps the file's value), stores
  `blocked_by_json` verbatim, `validation`
  (`deriveValidation`, never the stored cache), `validation_block_reason` (closed PR →
  required reviewers → verdict gate → open blocked packet → conflicting PR),
  `continuity` (`degraded` when a `continuity` event exists), `waiting` forced to
  `none` in the terminal stage, `repo` always the project's, counts, `goal_id` /
  `goal_link_index`, `work_revision_sha`, `board_rank`; rewrites `task_events`
  wholesale (position 0 = newest, actor snapshot denormalized so events survive
  member removal); stores `""` as the hash until events and diagnostics landed;
  emits `task.updated`.
- `rebuildGoalFile` reconciles link statuses against live task rows and emits
  `goal.updated`.
- `dependencies.server.ts` (ruling 131) is the READ model beside the rebuilder:
  `resolveDependencies` / `dependencyResolver` map each stored entry to
  `open | done | failed | missing` from the live projections (a task at the
  terminal stage is `done`, an archived one `failed`; a goal link takes its task's
  state once created, else its own status, `skipped` counting as done). The board
  query resolves every row through ONE resolver; the task query resolves on read;
  nothing caches a resolved state. `listHeldTasks` feeds the release engine.
- `rebuildPath` routes a path to the right rebuilder with a content-hash
  short-circuit unless forced; it swallows every throw into a provenance `error` row
  and the log line `projection rebuild failed`, so a row that silently stops updating
  almost always means a schema or CHECK problem (read the boot integrity WARN).

Three whole-store operations:

| Operation | What | Cooldown | Where |
|---|---|---|---|
| **Rescan** | Walk projects → tasks → goals, re-project changed files by hash, prune vanished rows, one `rescan` provenance row, `projection.rebuilt {scope: full}`. Audit `projection.rescan`. | 10 s (`RESCAN_MIN_INTERVAL_MS`) | Home store strip (org admin), `npm run rescan` (takes the writer lock), boot |
| **Rebuild** | One transaction: `DELETE` `task_events`, `diagnostics`, `task_projections`, `projects`, then a forced rescan; events buffered until commit. Audit `projection.rebuild`. Users, sessions, secrets, audit and notifications untouched. | 30 s | Home store strip (org admin, confirm dialog) |
| **Store check** | Read-only parse of every canonical file, no lock. | none | `npm run store:check` |

The single-flight helper is a cooldown, not a mutex: it stamps the timestamp before
the work runs and a throttled call answers `{ status: "throttled", retryAfterMs }`.

## 5. Events and SSE

**Projection events** (`projection-events.server.ts`): `task.updated`, `task.removed`,
`project.updated`, `project.removed`, `projection.rebuilt {scope, changed}`,
`notification.created {userId}`, `notification.read {userId}`, `violation.updated
{projectSlug, taskKey}`, `goal.updated {projectSlug, goalId}`. The publisher
(`event-publisher.server.ts`) translates each into the wire shape `{ type, entityId,
occurredAt, data }`, reading back the task's stage and readiness for `task.updated`,
and zod-parses every event against `sseEventSchema` before publishing.

Two publishers bypass the projection emitter on purpose: the run stream
(`run.log-appended {runId, seq}`, `run.state-changed {state}`, task-scoped,
reference-only so the dedicated log consumer fetches content from
`/resources/run-log`) and the controller's frames (`controller.updated` and
`controller.log-appended {conversationId, userId, runId, threadId, seq}`, both routed to
the conversation owner's `user` stream; a controller run has no task scope, so the
sink hands `run-events.server.ts` the owner route `controllerRunRoute` resolved and the
same two publishers route there).

**The complete wire event list** (`SSE_EVENT_NAMES`): `task.updated`, `task.removed`,
`project.updated`, `project.removed`, `projection.rebuilt`, `notification.created`,
`notification.read`, `violation.updated`, `resource.updated`, `run.log-appended`,
`run.state-changed`, `controller.updated`, `controller.log-appended`, `goal.updated`, plus
the control events `stream.open {headId}` and `stream.resync`. `controller.log-appended`
is a **stream event** (`SSE_STREAM_EVENTS` in `event-types.ts`): one frame per console
line on the `user` scope every signed-in surface subscribes, so `useLiveUpdates` does not
revalidate on it; only the dedicated log consumer handles it. `run.log-appended` is a
**run-line event** (`SSE_RUN_LINE_EVENTS`): the `project:` scope delivers it for every run
of the project (to the board, the controller page and every open task page, which
subscribes its project for the rail), but only the page whose `task:` scope names that
task revalidates on it, at most once per `RUN_LINE_REVALIDATE_MS` (2 s), because its Live
run strip (phase, step, turns, tokens) is loader data that moves per line.

**The broker** (`sse-broker.server.ts`): one connection per browser tab on
`/resources/events` (401 JSON when signed out, since an `EventSource` cannot render a
login page), scopes `project:<slug>`, `task:<slug>/<key>`, `projects` (every visible
project) and `user`. Non-admins have foreign project and task scopes dropped and
`projects` expanded to their memberships; an empty scope set is a 403. A 25-second
heartbeat (`: hb`) also **re-authorizes** every connection, dropping ones whose
scopes vanished (a throw keeps the existing scopes: a check that could not run must
neither widen access nor tear down a healthy stream). A 256-event ring buffer replays
after a reconnect with `Last-Event-ID`; an id older than the buffer, or a restart,
sends `stream.resync` and the client revalidates once. Queue backpressure caps at
1024 chunks per connection. Shutdown closes streams, stops watchers and the lock
guard, closes the DB and releases the writer lock.

**The client** (`useLiveUpdates`): subscribes the current surface to its scopes,
revalidates the active React Router loaders on any data event or `stream.resync`
(debounced 300 ms; a run line only on its own task's page, floored at 2 s, joining a
pending revalidation rather than pushing it out), revalidates once on every reconnect,
backs off 2/5/15/30 s on close, probes the session after two failures and stops on a
401 until the user retries. There is no optimistic UI for governed state: revalidation is the update
mechanism. The run-log console has its own `EventSource` (`useRunLogStream`), so a
log line reaches the console at once and refetches the whole task loader at most every
2 s. (Measured 2026-09-23 on ax-clone: before the floor, each line of any run in the
project revalidated every open board and task page; three open pages at 2.5 revalidations
a second pushed a trivial request's p90 from 8 ms to 157 ms on the server's one event
loop, the one the agents run on.)

## 6. Provenance and freshness

The `provenance` table records what the projector and the reconciler observed:
`projected` (with diagnostics and event counts), `removed`, `error`, `rescan`,
`github.reconcile` (including project heartbeats), `github.merge`,
`github.branch_delete`. Readers derive "last synced" facts from it; it is never
pruned. Freshness rules live in `app/shared/freshness.ts` (re-exported through
`server/interpretation/freshness-policy.server.ts`): older than one hour is stale;
never checked is neutral, not stale. "Gone quiet" on a task derives from
`task_events.occurred_at`: one hour after the last agent event, 72 hours after the
last human event, suppressed for archived, terminal, empty or actively running tasks.

## 7. Where things can bite

- A `projects` row deletion does not cascade task rows; the directory reconcile
  prunes them explicitly.
- The watcher's `ignoreInitial` means an external edit inside the sub-second initial
  scan window is picked up only on its next touch or a manual rescan.
- Any list whose loss would persist must be parsed per row (`tolerantRows`); a
  whole-array fallback silently empties the list and the next write serializes the
  empty list over good rows.
- `rebuildProjections` must emit only after commit; a revalidation racing a
  half-built projection is the reason events are collected during the transaction.
- Stage ids are never literals; use `resolveStageRoles` and `isTerminalStage`.
