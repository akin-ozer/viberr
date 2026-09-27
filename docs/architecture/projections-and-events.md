# Projections, the watcher, and live events

> How canonical files become SQLite rows, how a change reaches every open
> browser tab, and how a malformed file degrades.
>
> Source of truth: `app/server/files/*`, `app/server/projections/*`,
> `app/server/interpretation/*`, `app/server/events/*`,
> `app/server/runtimes/run-events.server.ts`, `app/server/org/resource-events.server.ts`,
> `app/routes/resources.events.ts`, `app/schemas/sse-event.schema.ts`,
> `app/features/live-updates/*`, `app/features/runtime/use-run-log-stream.ts`,
> `app/features/runtime/run-log-store.ts`.
>
> Verified against `main` @ `7d9fbf72` (2026-09-23); §5 and §6 against `8bbe2083` (PR #318);
> §5's stream events and run-log console against ruling 457's console pass (2026-09-24).

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
  wraps every read-modify-write of `task.md`, `project.md` and epic files, plus an
  epics-directory lock (`withEpicsLock`) around minting an epic id.
- **Read-your-own-writes**: `write-cache.server.ts`, shared by the task, project and epic
  writers. They write through its `writeAndRemember`, which remembers the last content
  this process wrote per path and the identity (inode, size, mtime) of the file on each
  side of the rename: the file the write put there and the one it replaced. A locked read
  that disagrees gets that content back only while the path still shows one of those two
  files (bind mounts over VirtioFS serve stale reads); any other identity is another
  writer and wins however soon after the write it lands, and no clock is read
  (ruling 513).
- **Parse memo** (ruling 457): `readProjectFile`, `readTaskFile` and
  `readAgentProfileFile` still read the file on every call, but skip the YAML + Zod
  parse when the bytes equal the bytes they last parsed for that path
  (`parse-memo.server.ts`; 256 entries, 4 M characters). The key is the content, not
  the file's stat, so any change on disk is seen by the next read and a stale
  bind-mount read is never pinned; each caller gets its own `structuredClone`.
- **Trust guard**: `updateTaskFile` and `updateProjectFile` refuse to write a file whose
  parse produced a hard-stop diagnostic (`file_not_trusted`, 409): a write would replace
  the human's content with defaults. `updateEpicFile` refuses an epic file that does not
  parse (409). `updateTaskFile` always bumps `updatedAt`; `updateEpicFile` writes nothing
  when the bytes are unchanged.
- **Frontmatter**: `---` fences, YAML between, markdown body after; BOM stripped,
  CRLF and lone CR normalized; unknown top-level keys round-trip verbatim in task,
  project, epic and agent-profile files (an agent profile also warns
  `agent_profile.unknown_field`).

## 2. The watcher

`startFileWatcher` runs chokidar over `<dataRoot>/projects` (`ignoreInitial`, no
symlink following, atomic-write coalescing) with a **250 ms trailing debounce per
path**. It ignores any dot-prefixed segment, any `*.tmp`, and everything at depth 4 or
deeper except `tasks/<KEY>/task.md`, so `workspace/`, `attachments/` and mirrors are
never traversed. It reacts to `project.md`, `task.md` and `epics/*.md` with
`rebuildPath`, and reconciles directory deletions: a removed project or `tasks/`
directory re-checks every projected task of the project, a removed task directory
projects the task's removal, and a removed `epics/` directory prunes its epic rows.

A rebuild that fails (a throw, `rebuildPath` answering `error`, or a `project.md` whose
cascade left `failedTasks`) is retried per file at 2, 5, 15, 45 and 120 seconds, reset
on the first success (ruling 218); past the last
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
`reference.unknown_stage`, `agent_profile.invalid | unknown_field`. Epic files are the
exception: an epic whose frontmatter is not a map, fails the schema, or names an id other
than its file's has no partially usable form, so every finding (`frontmatter.not_a_map`,
`frontmatter.invalid_field`, plus the fence codes) is a hard stop and the epic does not
project.

`npm run store:check` lists every project, task and epic file the app cannot trust
(hard stop) or that is degraded (error), with the offending line. `npm run rescan`
counts rebuilds that ended in `error`, not untrusted files: a malformed task or project
file still projects (with defaults and a hard stop) and reports zero errors there, while
an unparseable epic file counts as one.

## 4. Projection tables and the rebuilder

`rebuilder.server.ts` owns files → SQLite:

- `rebuildProjectFile` upserts `projects` (JSON copies of stages, workflow, agent
  policy, credential policy, guardrails, and the project's required-reviewer rules
  resolved to stage and agent names, ruling 178), rewrites `project_members`, replaces
  the file's `diagnostics`, records provenance, emits `project.updated`, forces every
  task of the project to re-project when the project row is new or a field tasks derive
  from changed: the repo, stages, workflow, resolved required reviewers or member ids
  (`projectContextForTasks`, the one reader both sides share; ruling 457), and writes
  the content hash **last**. Each cascaded task runs in its own `SAVEPOINT`: one that
  throws rolls back alone, its fault and provenance `error` row name ITS file, and the
  project row, its members and the other tasks still land. The project then keeps the
  `""` hash and the result lists `failedTasks`, so the next rebuild of `project.md`
  (the watcher's retry included) runs the cascade again. A write that only moves
  `nextTaskNumber` (every task creation), a file lease or the description costs the
  project row and one `project.updated`. The rescans read the same answer
  (`taskFacingChanged`) before they force a project's tasks. A vanished
  `project.md` deletes its diagnostics first and the `projects` row last (members
  cascade), and emits `project.removed`.
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
  counts and `recommendation_kinds`, `schedules_json`, `epic_id` (ruling 503),
  `work_revision_sha` (the active work revision; a discarded one projects as null,
  ruling 161), `board_rank`; writes `task_events` (position 0 = newest, actor
  snapshot denormalized into `actor_json` so events survive member removal, agent
  `actor_ref` keyed `agent/<profileId>`) keeping the rows of unchanged events: stored
  and fresh rows are aligned from the oldest end while time, type and actor match, kept
  rows shift position in one UPDATE and take changed content in place, and the rest are
  deleted and inserted, so a row's `id` survives an append and the timeline keyed on it
  does not remount (ruling 457); stores `""` as the hash until events and diagnostics
  landed; emits `task.updated`. A vanished `task.md` deletes events and
  diagnostics first and the projection row last, and emits `task.removed`.
- `rebuildEpicFile` (ruling 503) projects the epic file's own fields into
  `epic_projections` and emits `epic.updated`; it reads no task, because an epic's tasks
  are the task rows whose `epic_id` names it and its progress is counted from them at read
  time (`epic-query.server.ts`). An epic file that does not parse writes its hard-stop
  diagnostics and a provenance `error` row and keeps its previous projection; a vanished
  one deletes its row and emits `epic.updated`.
- `dependencies.server.ts` (ruling 131) is the READ model beside the rebuilder:
  `resolveDependencies` / `dependencyResolver` map each stored entry to
  `open | done | failed | missing` from the live projections (a task at the
  terminal stage is `done`, an archived one `failed`; every entry is a task key since
  ruling 503 retired the goal-link spelling). The board
  query resolves every row through ONE resolver; the task query resolves on read;
  nothing caches a resolved state. `listHeldTasks` feeds the release engine.
- Each file's re-projection (project, task, epic) runs as ONE transaction, its
  projection events held until COMMIT; a caller already inside a transaction (the full
  rebuild, a project's cascade) runs it inline (ruling 457). A rebuild that throws rolls
  back and announces nothing; a cascaded task rolls back only to its savepoint (above).
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
| **Rescan** | Walk projects → tasks → epics, re-project changed files by hash, prune vanished rows, one `rescan` provenance row, `projection.rebuilt {scope: full}`. Audit `projection.rescan`. | 10 s (`RESCAN_MIN_INTERVAL_MS`) | Home store strip (org admin), `npm run rescan` (takes the writer lock; `--force` reprojects everything), boot |
| **Project rescan** | `rescanProject` → `rebuildProject`: the same reconcile confined to one project, `projection.rebuilt {scope: project}`. Audit `projection.rescan` with the slug. | none | Board Re-scan (`rescan-project`: project admin or maintainer) |
| **Rebuild** | One transaction: `DELETE` `task_events`, `diagnostics`, `task_projections`, `projects` (members cascade), then a forced full rescan; events buffered until commit. Audit `projection.rebuild`. Users, sessions, secrets, audit, notifications, provenance and runs untouched. | 30 s (`REBUILD_MIN_INTERVAL_MS`) | Home store strip (org admin, confirm dialog) |
| **Store check** | Read-only parse of every project, task and epic file, no lock. | none | `npm run store:check` |

The single-flight helper is a cooldown, not a mutex: it stamps the timestamp before
the work runs and a throttled call answers `{ status: "throttled", retryAfterMs }`
(the Home actions return it as a 429).

## 5. Events and SSE

**Projection events** (`projection-events.server.ts`): `task.updated`, `task.removed`,
`project.updated`, `project.removed`, `projection.rebuilt {scope, changed}`,
`notification.created {userId}`, `notification.read {userId}`, `violation.updated
{projectSlug, taskKey}`, `epic.updated {projectSlug, epicId}`. Inside
`collectProjectionEvents` (the rebuild's transaction, and each single file's
re-projection, ruling 457) they are buffered and re-emitted only after commit; a throw
discards them. The publisher (`event-publisher.server.ts`)
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
| `run.log-appended` | `projectSlug, taskKey, runId, threadId, seq` | the task's own scope only (`taskOnly`, ruling 457): no `project:` connection and no `projects` firehose |
| `run.state-changed` | `projectSlug, taskKey, runId, threadId, state` | project + task |
| `controller.updated` | `conversationId, userId` | the owner's `user` scope |
| `controller.log-appended` | `conversationId, userId, runId, threadId, seq` | the owner's `user` scope |
| `epic.updated` | `projectSlug, epicId` | project |
| `stream.open` | `headId` | control: the connection's first message |
| `stream.resync` | `{}` | control: sent when replay cannot catch a reconnect up |

`controller.log-appended` and `run.log-appended` are **stream events**
(`SSE_STREAM_EVENTS` in `event-types.ts`): one frame per console line, which revalidates
nothing. `useLiveUpdates` hands each one to the tab's run-log consoles (`onLiveFrame`)
and to nothing else. `controller.log-appended` rides the `user` scope every signed-in
surface subscribes; `run.log-appended` reaches only a connection holding its task's scope
(the workspace layout of the page showing that task), because nothing on a board, the
controller page or another task's page changes per line of someone else's run: the
board's "agent running" fact moves on `run.state-changed`. Until ruling 457 a board
received and dropped every line, and the task's own page revalidated root, layout and
task on its run's lines at most once per 2 s (`RUN_LINE_REVALIDATE_MS`) to move the Live
run strip; the strip now reads the facts every console tail read returns (below).

A data event reaches `onLiveFrame` too, once per id, after the ledger has recorded it
(ruling 481(c)). Its one listener is the root's `AttentionWatcher`, which re-reads
`/resources/attention` on `notification.created` and `notification.read` to keep the
tab's title count and, when opted in, announce a new decision as a desktop notification.

**The broker** (`sse-broker.server.ts`, behind the route `resources.events.ts`): one
connection per stream on `/resources/events` (401 JSON when signed out, since an
`EventSource` cannot render a login page; 400 for a malformed scope), scopes
`project:<slug>`, `task:<slug>/<key>`, `projects` (every visible project) and `user`.
Org admins keep any scope. For everyone else foreign project and task scopes are
dropped and `projects` is expanded to their memberships; an empty result is a 403. The
first message sets `retry: 5000` and sends `stream.open`. A 25-second heartbeat
(`: hb`) also **re-authorizes** every connection, dropping ones whose scopes vanished (a
throw keeps the existing scopes: a check that could not run must neither widen access
nor tear down a healthy stream). Two 256-event rings replay, on the new connection's
scopes and in id order, every event after the position a connection names: the browser's
own `Last-Event-ID` header when it retries a source, or the `lastEventId` query param a
new `EventSource` carries (ruling 457; the header wins). One ring holds data events, the
other stream events (console lines, `SSE_STREAM_EVENTS`), so a busy run cannot push a
data event out of reach. A position below a data event the ring has let go of, or from
an earlier process (ids are unique across processes: each starts at a thousand per
millisecond of its boot clock), gets `stream.resync` and the client revalidates once;
console lines the stream ring has let go of never resync, since the console reads past
its own cursor. Root's
`liveHeadMiddleware` reads the head before any loader of a request runs, and a document
load hands it to the page as root's `liveHead`, so the page's first stream replays what
was published between the server render and hydration. Queue backpressure caps at 1024
chunks per connection; a failed write drops the connection. The broker also owns the
process shutdown hook
(`runProcessShutdown`): close streams, stop both watchers and the lock guard, close the
DB and release the writer lock.

**The client** (`useLiveUpdates`): subscribes the current surface to its scopes (Home:
`user` + `projects`; a project page: `project:<slug>` + `user`, plus `task:<slug>/<key>`
when a task is open; the controller page: `user`, plus `project:<slug>` on a project;
the controller dock, Instance settings and notifications: `user`), and revalidates on
data events and `stream.resync` (debounced 300 ms; never on a stream event;
`controller.updated`, a **conversation event** (`SSE_CONVERSATION_EVENTS`), only on the
two controller pages, which render the conversation and pass `{ conversations: true }`:
every other surface hands it, debounced the same way, to the controller dock as the
window event `CONTROLLER_UPDATED_EVENT`, and the dock reloads its own resources, ruling
457).

**Which loaders re-run** (`revalidation-policy.ts`, ruling 457). Single fetch asks every
route on screen to re-run after every navigation, action and `revalidate()`; every route
with a loader answers through `shouldRevalidate = revalidateWhen("<route id>")`, from one
rule table that says what each loader reads: its path params, its search params, and the
facts its data depends on (`domain`, `run`, `bell`, `conversation`, `theme`,
`session`). Each tab keeps a **ledger** of what its loaders owe: every live event as it
arrives (a run's state is a `run` fact, a notification a `bell` fact, a conversation a
`conversation` fact, anything else `domain`), every action as it is submitted (by the
path it posts to: `/notifications/read` changes the bell, `/prefs/theme` the theme, sign-in,
sign-out and `/profile` everything, a page's own action `domain` and `run`) and again as
it answers, since a load that started while it ran cannot hold its write (ruling 457,
RV-4), and every
`revalidate()` that is not the live hook's own (the F22 net, a settle, a panel's poll:
everything but root). When a route's data lands, it covers what was recorded before the
load that brought it started. That is the watermark: the server publishes an event after
its write commits, so a load the browser sent after receiving the event was answered from
data that holds it. A route re-runs when it owes something it reads, when a navigation
changed a param or search param its loader reads, or on a navigation to the URL already
on screen, its hash included: the press that ends a link's mark takes the hash away
(ruling 523), the one hash change React Router hands the loaders, and re-runs only what a
route still owes.
The flush revalidates once, and only if a route on screen still owes a live
event, and it waits for a load in flight to land first, but not for a submission: another
member's change reaches the page while the person's own slow action (an upload, a GitHub
sync) still runs (ruling 457, RV-6). So:

| Trigger | Re-runs |
|---|---|
| A keystroke, chip or view toggle in the board filter | nothing (no loader reads `q`, `filter`, `label`, `view`) |
| `?events` on a task page (show older) | the task loader |
| The press that ends a link's mark (the hash taken away, ruling 523) | nothing |
| `?c=` / `?all=` on a controller page | that controller page |
| Any search param on Activity | Activity |
| A navigation inside a project | the new page; the workspace layout only when the slug changed; never root |
| A page's own action (comment, drop, transition) | the workspace layout and that page; the action's own SSE echo, received before that load was sent, then re-runs nothing (when the action answered inside the flush's 300 ms) |
| The bell's mark-read | what draws the bell's counts or list: the shells, Home and the notifications page |
| A theme change | root and the profile page |
| Sign-in, sign-out, a profile change | everything |
| `task.updated`, `project.updated`, `violation.updated`, … | the shell and every page on screen |
| `run.state-changed` (any task) | the pages, not the shells (the task page renders instance run facts another task's run can change: model availability, the owner's backend health) |
| `notification.created` / `.read` | the shells, Home and the notifications page |
| `controller.updated` | the controller pages (elsewhere it goes to the dock) |
| `stream.resync`, or a `revalidate()` | every page and shell, not root |

An action React Router does not revalidate after (a 4xx or 5xx answer, or a caller that
opts out, like the dock's send) re-runs nothing; an event its write published still does.
A 403 re-runs root alone: it is how a stale CSRF token answers (a sign-in in another tab
gave the session a new id), and root no longer re-reads the session on every live event.
Every action answers it as a result, never a throw (`requireFormAction`'s `refused`, or
`csrfError`), because React Router sends a thrown fetcher error to the route's error
boundary without revalidating anything (ruling 457, RV-1).
A trigger that interrupts a load in flight finds that load's obligations still in the
ledger and loads them itself, so nothing a person has not seen is skipped.

**Reconnects replay** (ruling 457, RF-1). Every stream records the id it stands at: the
hello's head, then each event. A reopen names that position (`lastEventId`), and the
broker replays what the tab missed on the new scopes, which revalidates like any event;
only a reconnect that could not say where it stood pulls every loader once. So a
deliberate re-scope (opening, switching or closing a task) and a quiet return from a
hidden tab reload nothing, and a return after events, or a failure recovered on the
backoff, reloads what those events concern. A stream's position moves only on its own
scopes' events, so a reopen after more than 256 data events elsewhere on the instance
falls off the ring and resyncs. A stream that takes on a project, the `projects`
firehose or the `user` scope (a slug change, a surface's first stream) opens from the
tab's position when the navigation's loads were sent, not the newest id the old stream
saw, since the old scopes say nothing about the new one's events (ruling 457, RV-2);
it can replay an event its load already held, one redundant reload at most (entering a
project from a `user`-only surface such as notifications, after that project changed). An event the closing stream had delivered
but not yet flushed (a hide or a re-scope inside the 300 ms window) is still in the
ledger, and the reopened stream flushes it. A hidden tab holds no stream: the hook
closes on `visibilitychange` and reopens on return (ruling 301), and the replay is its
catch-up. A failed stream flips `paused` (the "live updates paused" strip under the header, ruling 455(f)),
reopens on a 2 / 5 / 15 / 30 s backoff, probes the session after two consecutive
failures and stops on a 401 until the user retries; while it is down the tab's consoles
say so in their footer (`useLiveStreamFailed`). There is no optimistic UI for
governed state: revalidation is the update mechanism. (Measured 2026-09-23 on the
ax-clone instance, before the run-line floor: each line of any run in the project
revalidated every open board and task page, and three open pages at 2.5 revalidations a
second pushed a trivial request's p90 from 8 ms to 157 ms on the server's one event
loop, the one the agents run on.)

**The run-log console** (`useRunLogStream` over `run-log-store.ts`, ruling 457) opens no
connection of its own: it takes its frames from the tab's one live stream through
`onLiveFrame`, so a task tab holds ONE `EventSource` (ruling 301 had named merging the
console's second stream "the next cut"), and the layout's hidden-tab close and reconnect
replay cover it. On the task scope it tails `run.log-appended`; for a controller
conversation, `controller.log-appended` on the `user` scope. Its lines live in an external
store the console reads with `useSyncExternalStore`, so a line re-renders the console and
not the page. Per frame it fetches the lines since its cursor from `/resources/run-log`
(one read in flight per thread, read again when a frame announced a line the read did not
bring; a thread whose lines are not loaded reads the run's facts alone, so the strip moves
for an agent whose console was never opened), and every answer carries the run row's live
facts (`RunLiveFacts`: phase, step, turns, tokens, cache), which the Live run strip and
the controller's working row read, so nothing revalidates per line. Each read of the
facts, a tail's or a revalidation's, is stamped with the row's `updated_at` (`factsAt`),
and the console keeps the newer one whichever lands last. Owner decision 2 (2026-09-24): a
page's payload carries console lines only on a document load, and only the shown agent's
display lines; a revalidation or a client navigation carries each thread's window facts
(`logWindow.loaded: false`), the console fills the thread it shows with ONE
`/resources/run-log?window=1` request, and the stored envelopes load when the raw view
opens. A revalidation keeps what a thread holds unless its representative run changed, and
a console on screen whose run did change keeps its lines until the new run's window
replaces them; a head the loader saw past the cursor (a missed frame, a tab back from
hidden) is read as a gap, and a gap wider than one window (`RUN_LOG_WINDOW_LINES`, 400)
loads the window instead, so a catch-up never outgrows what a fresh load ships. The
console pages older history on demand and, while a run is shown active and the tab's
stream is DOWN, revalidates every 20 s (F22: a missed terminal event cannot leave the
strip "running"; with the stream up the event arrives or is replayed, ruling 457, RF-6);
the controller page reads the working turn's tail every 5 s instead and revalidates once
the tail says the run ended (CTL-2). `run.state-changed` revalidates through the layout's
stream, once.

## 6. Provenance and freshness

The `provenance` table records what the projector and the reconciler observed:
`projected` (with diagnostics and event counts), `removed`, `error`, `rescan`,
`github.reconcile` (including project heartbeats), `github.merge`,
`github.branch_delete`, `github.push` (a Viberr push of a task branch, ruling 494).
Readers derive "last synced" facts from it; it is never pruned. A `github.reconcile`
row names the branch head its compare read (`headSha`), and the operator's
`baseBehindBy` is read with that head and against Viberr's newest `github.push`: a push
recorded after it, or one whose first compare after it read another head, makes the count
not the pushed head's.
Freshness rules live in `app/shared/freshness.ts` (re-exported through
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
- Any list whose loss would persist must be parsed per row (`tolerantListField`, or
  `tolerantRowsOf` for a list already extracted, in `schemas/file-diagnostics.ts`); a
  whole-array fallback silently empties the list and the next write serializes the empty
  list over good rows.
- `rebuildProjections` must emit only after commit; a revalidation racing a
  half-built projection is the reason events are collected during the transaction.
- A change to a derived column needs a `PROJECTION_DERIVATION_VERSION` bump, or
  existing rows keep the old derivation until their file changes.
- The baseline is squashed and forward-only: a CHECK value or column added to it reaches
  only fresh roots. Boot backfills the known nullable columns (`ensureBaselineColumns`)
  and WARNs `projection schema drift` for the rest; a row that silently stops updating
  almost always means a schema or CHECK problem.
- Stage ids are never literals; use `resolveStageRoles` and `isTerminalStage`.
