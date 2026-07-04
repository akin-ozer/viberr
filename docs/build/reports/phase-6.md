# Phase 6 report — SSE live updates

Status: complete. Gates at close: `npm run typecheck` clean,
`npm run build` clean, `npm test` 408/408 green (incl. all concurrent
Phase-7 agent suites; ~40 new phase-6 tests). Live-verified in dev
(`npm run dev`, Vite) AND prod (`npm run build` + `npm run start`,
react-router-serve) — details in "Live verification" below. Store
re-seeded pristine after (`npm run seed -- --reset`, arda's unread back
to 6, no verification artifacts in task files), all servers stopped.

No new deps. No new migrations. No CSS changes.

## File inventory

```
app/
  schemas/sse-event.schema.ts            # THE wire contract: zod discriminated union
                                         # { type, entityId, occurredAt, data } per event name
  server/
    boot.server.ts                       # + startEventPublisher() (before the watcher)
    events/
      sse-broker.server.ts               # connections, scope filter, ring buffer, heartbeat,
                                         # drop-on-failed-write, shutdown   [test: 17]
      event-publisher.server.ts          # projection emitter → broker translation  [test: 9]
  routes/resources.events.ts             # GET /resources/events (registered in routes.ts)
  features/live-updates/
    event-types.ts                       # client mirror: re-exports schema types + sseScopes/
                                         # buildEventsUrl/SSE_CONTROL_EVENTS
    sse-client.ts                        # EventSource wrapper: jittered backoff, lastEventId,
                                         # visibility pause/resume            [test: 8]
    use-live-updates.ts                  # useLiveUpdates(scopes): 300ms-debounced useRevalidator
                                         #                                    [jsdom test: 6]
    sse-route.server.test.ts             # route-level: 401/400, SSE headers, stream reads,
                                         # emitter→stream end-to-end, ?lastEventId= replay [4]
  routes/project.tsx                     # + useLiveUpdates([project, (task), user]) in the shell
  routes/_index.tsx                      # + useLiveUpdates([user]) on Home
```

## Wire contract (CONVENTIONS §SSE)

Event names are lowercase dot-separated facts; every `data:` line is one
JSON object `{ type, entityId, occurredAt, data }` — compact facts only.
Schema: `app/schemas/sse-event.schema.ts` (zod-parsed server-side before
every publish; a malformed event logs an error and is never sent).

| event | entityId | data | routed to |
|---|---|---|---|
| `task.updated` | `slug/KEY` | `{projectSlug, taskKey, stage, readiness}` | project + task scopes |
| `task.readiness-changed` | `slug/KEY` | same, readiness non-null | project + task scopes |
| `task.removed` | `slug/KEY` | `{projectSlug, taskKey}` | project + task scopes |
| `project.updated` / `.removed` | `slug` | `{projectSlug}` | project + task:slug/* scopes |
| `projection.rebuilt` | `store` | `{scope: full\|file, changed}` | broadcast (all connections) |
| `notification.created` | user id | `{userId}` | ONLY that user's `user`-scoped connections |
| `violation.updated` | `slug[/KEY]` | `{projectSlug, taskKey\|null}` | project (+task) scopes |
| `stream.open` | `stream` | `{headId}` | control: first message per connection |
| `stream.resync` | `stream` | `{}` | control: replay impossible → revalidate once |

`task.readiness-changed` is DERIVED by the publisher (the projection
emitter only says "task changed"): it reads `task_projections.stage/
readiness` back and compares with the last readiness it saw per task.
First sightings emit nothing (a boot rescan would otherwise flood).

## Broker API (`app/server/events/sse-broker.server.ts`)

```ts
parseSseScope(raw): SseScope | null       // "user" | "project:<slug>" | "task:<slug>/<key>"
publishSseEvent(event: SseEvent, route: SseRoute): number   // returns the assigned id
  // SseRoute: { projectSlug?, taskKey? } | { userId } | { broadcast: true }
connectSseClient({ userId, scopes, lastEventId?, write, onClose? }): { id, close() }
closeAllSseConnections()                  // graceful shutdown (also SIGINT/SIGTERM hook)
resetSseBrokerForTests() / getSseBrokerStats()
HEARTBEAT_INTERVAL_MS = 25_000, RING_BUFFER_SIZE = 256
```

Mechanics:

- **Filtering**: `routeMatchesConnection` — user-targeted routes match
  only same-user connections holding a `user` scope (a project-scoped
  connection of the same user does NOT receive them); project routes
  match `project:` scopes and `task:` scopes of that slug (task-level
  routes additionally require the key to match); broadcasts match all.
- **Ring buffer**: last 256 published events, ids monotonically
  increasing from 1 per process. Hello (`stream.open`) carries the head
  id AS its `id:` field, so clients track a resume position even when
  they never receive a data event. Reconnect with `Last-Event-ID` header
  (native) or `?lastEventId=` (our wrapper — a new EventSource never
  re-sends the header) replays the missed, scope-filtered events; ids
  outside the buffer window (incl. a restart's id reset) get
  `stream.resync` instead → the client revalidates once. No full page
  refresh anywhere.
- **Heartbeat**: `: hb\n\n` comment every 25 s per connection (timers
  unref'd — they never keep the process alive).
- **Backpressure / failed writes**: all writes go through the
  connection's `write` callback; any throw drops and closes that
  connection. The route's write throws when the stream controller's
  `desiredSize` falls below −1023 chunks (stalled client) or when
  enqueue fails (torn socket). A slow consumer can never block others.
- **Shutdown**: SIGINT/SIGTERM (registered once, skipped under
  NODE_ENV=test) closes every connection then re-raises the signal.
- **HMR-safe**: all state behind `Symbol.for("viberr.sseBroker")`
  (phase-1 getDb pattern).

## Publisher API (`app/server/events/event-publisher.server.ts`)

```ts
startEventPublisher(): void   // idempotent singleton; called from bootServer()
translateProjectionEvent(e, { taskFacts?, previousReadiness? }): { event, route }[]  // pure
readTaskFacts(db, slug, key): { stage, readiness } | null
stopEventPublisherForTests()
```

Every existing mutation source was verified to flow through the phase-3
projection emitter — no direct publish calls were needed:

- task actions (create/comment/owner/transition/resolve) end in
  `rebuildPath` → `task.updated` (+`project.updated` for the key-counter
  bump on create);
- the chokidar watcher calls `rebuildPath` on external edits;
- rescan (`rebuildAll` — Home/Board buttons) emits per-file events plus
  ONE `projection.rebuilt` summary;
- `createNotification` (mention fan-out etc.) emits
  `notification.created` per recipient row;
- Phase-7's violations module emits `violation.updated`.

## Route: GET /resources/events

Repeatable `scope=` query params, at least one required (400 otherwise;
401 JSON when signed out — an EventSource can't follow requireUser's
login redirect, documented deviation). Any signed-in user may subscribe
to any project/task scope (matches V1 read RBAC: all app users see all
projects); `user` scope is implicitly the session user — you cannot
subscribe to someone else's targeted events.

**How streaming works in BOTH dev and prod** (tested against both): the
loader returns a plain `Response` wrapping a never-ending web
`ReadableStream` with `Content-Type: text/event-stream`. That is the
whole trick — the Vite dev middleware and `react-router-serve` both pipe
web-stream responses chunk-by-chunk. Prod's express `compression()`
middleware does NOT buffer it because `text/event-stream` is not a
compressible type (verified live: chunks arrive immediately through
`npm run start`). Headers: `Cache-Control: no-store, no-transform`,
`Connection: keep-alive`, `X-Accel-Buffering: no` (nginx-style proxies).
Client disconnects arrive as `request.signal` abort AND stream
`cancel()` — both close the broker connection.

## Client (`app/features/live-updates/`)

- `sse-client.ts` — `createSseClient({ url, onEvent, ... })`: wraps
  EventSource; on error closes and reconnects with exponential backoff
  (1 s base, ×2, 15 s cap) jittered ×[0.5, 1.5); tracks `lastEventId`
  from every received event and appends `?lastEventId=` on reconnect;
  `visibilitychange` hidden → drop stream + cancel pending retry,
  visible → immediate reconnect (ring buffer replays the gap). All
  environment touchpoints injectable for tests.
- `use-live-updates.ts` — `useLiveUpdates(scopes)`: ONE EventSource per
  hook instance; every non-control event schedules a TRAILING 300 ms
  debounced `useRevalidator().revalidate()` so bursts (rescan, comment →
  task+notification) coalesce into one loader round-trip. Loop-safe by
  construction: revalidation only runs loaders (GETs), which never write
  files/projections, so nothing re-enters the emitter; `stream.open` is
  ignored so connecting never revalidates.
- Wiring (one connection per tab, not per surface):
  - workspace shell (`routes/project.tsx`): `project:<slug>` + `user`
    (+ `task:<slug>/<key>` while a task route is open). Board columns,
    rail counts, violations badge, bell and the open task detail all
    revalidate off the layout+child loaders on the same tick.
  - Home (`routes/_index.tsx`): `user` (own notifications + rebuild
    broadcasts refresh cards/hero).
  - Bell: badge updates silently via revalidation — specs/shell.md
    defines no incoming-notification toast (checked; toasts there are
    action feedback only).

## How a future phase publishes a NEW event type

1. Add the name + payload variant to `app/schemas/sse-event.schema.ts`
   (keep `{ type, entityId, occurredAt, data }`, compact facts only).
   The client picks it up automatically — `SSE_EVENT_NAMES` drives the
   listener set, and any non-control event already triggers debounced
   revalidation.
2. **Low-frequency, projection-backed facts** (the normal case): add a
   variant to `ProjectionEvent` (projection-events.server.ts), emit it
   from the owning module, translate it in
   `event-publisher.server.ts#translateProjectionEvent` (+ shape test).
   You get buffering/replay, scope filtering and boot wiring for free.
3. **High-frequency streams — Phase 8 `run.log-appended`**: publish
   STRAIGHT to the broker from the runtime adapter:
   `publishSseEvent(event, { projectSlug, taskKey })` — do NOT route
   chatty streams through the projection emitter (that path implies "a
   projection changed" and would tempt a rebuild per log line; it also
   fans through translate/zod for no benefit at volume). Notes for that
   phase: (a) keep payloads to line REFERENCES (run id, seq, byte
   offset), let the panel fetch content — CONVENTIONS forbids fat
   objects; (b) the 256-event ring is shared, so a chatty run stream
   will evict board-level events between reconnects — clients handle it
   (stream.resync → one revalidation), but if that bites, either bump
   `RING_BUFFER_SIZE` or mark log events unbuffered (skip the ring;
   replay is pointless for logs — the NDJSON file is the truth);
   (c) do NOT wire log lines into `useLiveUpdates` revalidation — the
   logs panel should consume the events directly (its own
   `createSseClient` with a `task:` scope or a dedicated `run:` scope
   added to `parseSseScope`), revalidating loaders only on run
   lifecycle events.

## Live verification (dev, then prod)

Dev (`npm run dev`, curl jars for arda + elif via POST /login, CSRF
token scraped from the SSR turbo-stream payload):

- (a) `curl -N …?scope=project:viberr-core&scope=user` as arda, then
  `perl -pi` title edit of seeded VIB-142/task.md → `task.updated`
  (compact data: stage `review`, readiness `input_required`) arrived
  ~1.3 s after the edit (250 ms watcher debounce + rebuild). ✓
- (b) POST comment as elif (`@arda …` mention) → arda's project-scoped
  stream got `task.updated` + targeted `notification.created` on the
  same tick; in the real browser (preview, signed in as arda, board
  open) a later disk edit re-rendered the VIB-142 card with the new
  title within ~1 s with NO navigation (same-document check), and a
  third elif mention bumped the bell badge 8→9 silently (zero toasts,
  zero reloads). Browser console clean. Multi-client: a concurrent curl
  stream ("second tab") and the browser both reacted to the same event;
  the curl stream also showed a `: hb` heartbeat after 25 s. ✓
- (c) kill stream → miss an event → reconnect with `Last-Event-ID: 3`
  header AND with `?lastEventId=3`: both replayed exactly the missed
  `task.updated` (id 4); `lastEventId=999` (stale/previous server life)
  → `stream.resync`. ✓
- (d) elif's `user`-scoped stream received NOTHING when arda was the
  mention target (and vice versa in the earlier run) — user targeting
  holds at the broker, not just the UI. ✓
- UI rescan (board action POST) → ONE `projection.rebuilt`
  `{scope:"full",changed:0}` broadcast, received on a user-scope-only
  stream (Home case). ✓

Prod (`npm run build` + `npm run start`): response headers show
`text/event-stream`/`no-store, no-transform`/`x-accel-buffering: no`
with chunked encoding through express+compression; `stream.open` hello
arrived immediately and a live disk edit produced `task.updated` on the
open stream ~1.3 s later — streaming works under react-router-serve
with zero special-casing. ✓ Servers killed after; `npm run seed --
--reset` restored the pristine demo store.

## Decisions / deviations

1. **401 instead of login redirect** on /resources/events (requireUser
   semantics otherwise kept): EventSource follows a 302 into HTML and
   errors opaquely; a 401 makes the client back off cleanly and recover
   after re-login.
2. **One stream per tab, owned by the page shells** — the task-detail
   route does not open its own connection; the workspace layout adds the
   `task:` scope while a task is open (satisfies the brief's
   "task + project" scoping without a second connection; matters because
   HTTP/1.1 caps ~6 connections per origin across tabs).
3. **`stream.open`/`stream.resync` control events** added beyond the
   brief's five names (they follow the naming/payload rules): open
   carries the resume head id; resync is the honest "replay impossible"
   signal that turns into exactly one revalidation.
4. **`projection.rebuilt` is a broadcast** to every connection — a full
   rescan can affect any surface, and per-file rebuilds already carry
   precise task/project events for scoped delivery.
5. **Script rescans don't reach clients**: `npm run rescan`/`npm run
   seed` run in a separate process whose emitter has no subscribers —
   only in-process mutations (UI buttons, watcher, actions) produce SSE.
   Inherent to the in-process bus (no external queue by architecture);
   external edits still arrive via each server's own watcher.
6. **Readiness-change detection is per-process memory** (publisher map,
   seeded lazily): after a restart the first `task.updated` per task
   carries readiness but emits no `task.readiness-changed`. Nothing
   consumes readiness-changed yet (the hook revalidates on task.updated
   anyway) — it exists because the BUILD-PLAN names it; Phase 8+ can use
   it for targeted UI (e.g. waiting-pill pulse) without loader work.
7. **Backpressure threshold** is 1024 queued chunks (~100 KB of typical
   events) rather than byte-accounting — honest drop-and-close without
   hardening theater. The client reconnects and replays.
8. **PORT nuance surfaced during verification**: `react-router-serve`
   binds `process.env.PORT ?? 3000` before the app's dotenv runs, so
   `.env`'s PORT=5173 applies to dev only; prod on this machine serves
   on :3000 unless PORT is exported in the shell. Pre-existing behavior
   (phase 1), documented here because SSE verification tripped on it.
9. **jitter floor**: backoff delay is `expDelay × (0.5 + random())` —
   worst-case first retry is 500 ms, which doubles as the minimum retry
   spacing observed in tests.

## Known gaps (intentional)

- No `run:` scope yet — Phase 8 adds it if the logs panel wants
  finer-than-task subscription (one-line change in `parseSseScope` +
  routing).
- `auth.session-expired` (named in CONVENTIONS' example list) is not
  emitted: a dropped session simply 401s the reconnect and the client
  keeps backing off; the next navigation hits requireUser's redirect.
  Wire it when a phase wants proactive logout UX.
- The bell popover list itself refreshes via revalidation only while a
  surface with a `user` scope is mounted — that is every current
  surface (Home + workspace shell). PageOverlay routes (/profile,
  /notifications) don't subscribe; their data is a click away from a
  subscribed surface and Phase 9 owns their final shape.
- Multi-tab was verified as browser tab + concurrent curl stream (the
  preview harness drives a single tab); the broker fan-out path is the
  same for N browser tabs and is unit-tested for multiple connections.
