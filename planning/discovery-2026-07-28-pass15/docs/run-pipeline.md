# Code map: the agent run-log pipeline

Scope: adapter → sink → persistence → SSE → UI, for agent runs. All paths repo-relative.

## Pipeline shape (one sentence)

An adapter (`claude-runtime` / `codex-runtime`) emits `EmittedLine`s and one `RunExit` through callbacks (`app/server/runtimes/adapter.server.ts:96-101`); `run-service.launch` wires those into a per-run sink that persists (raw `.jsonl` + DB row) **then** publishes reference-only SSE events; the task loader ships a bounded projection window and the client's dedicated EventSource tails the rest.

## Module roster

| Module | Job |
|---|---|
| `app/server/runtimes/adapter.server.ts` | Contracts: `RunSpec`, `EmittedLine {raw, display, facts, occurredAt}`, `RunExit {outcome, effectiveBackend, sessionId}`, `RunCallbacks`, `RunHandle.interrupt()` |
| `app/server/runtimes/wire-format.server.ts` | Provider envelope → `{display: LogLine, facts: EnvelopeFacts}` normalizer |
| `app/server/runtimes/run-sink.server.ts` | The one funnel: redact → append `.jsonl` → insert row → fold facts → publish |
| `app/server/runtimes/run-store.server.ts` | `agent_runs`/`run_log_lines` CRUD + raw-file append + windowed reads |
| `app/server/runtimes/run-events.server.ts` | `run.log-appended` / `run.state-changed` publishers (direct to broker) |
| `app/server/runtimes/run-projection.server.ts` | `agent_runs` rows → grouped `ProjectedRunView[]` with the D-11 bounded window |
| `app/server/runtimes/run-service.server.ts` | `startRun`/`resumeRun`/`interruptRun`/`getRunLog`/`listRunsForTask` + handle & completion registries |
| `app/server/runtimes/run-recovery.server.ts` | Boot reconcilers (orphans, unreacted replies, stranded codex plans) |
| `app/server/events/sse-broker.server.ts` | In-process SSE fan-out, ring buffer, heartbeats, shutdown hook |
| `app/routes/resources.run-log.ts` | Member-gated log page endpoint (forward tail / backward page) |
| `app/features/runtime/use-run-log-stream.ts` | Client EventSource consumer + backward pager |
| `app/features/runtime/runs-panels.tsx` | `LiveRunPanel` (strip) + `AgentLogsPanel` (console + raw toggle) |

## Wire format (normalization)

- `app/server/runtimes/wire-format.server.ts:67-81` — `projectEnvelope(backend, raw)` turns one provider envelope into `{ display: LogLine|null, facts }`. Tolerant: unknown types become dim `meta` lines, never throw.
- Claude mapping `wire-format.server.ts:83-172`: `system.init` → `init` + sessionId/model facts; `assistant` tool_use → `tool`; `user` tool_result → `out`/`err`; `result` → `result` + usage/cost/turns facts (`isResult`, `isError`).
- Codex mapping `wire-format.server.ts:184-308`: `thread.started` → sessionId fact; `turn.completed` → usage + `turns: 1` (adapter overrides with a running count, `codex-runtime.server.ts` ~552); `item.*` for reasoning/agent_message/command_execution/file_change/mcp_tool_call/web_search. Item-type `error` is non-fatal by design (`wire-format.server.ts:247-251`).
- `LogLine` shape (`app/features/runtime/runtime-types.ts:31-66`): `{ t, ev, tag, text, name?, input?, exit?, stats?, usage?, changes? }`. `t` is a **server-local** `HH:MM:SS` (`wire-format.server.ts:8-12`).

## Run sink (the one funnel)

`app/server/runtimes/run-sink.server.ts:109-239` — per emitted line, strictly ordered:
1. Redact secrets (P13-U-1): exact values of credential-shaped env vars ≥12 chars + token shapes (ghp_/github_pat_/sk-…) — `run-sink.server.ts:52-93`; applied to both raw and display (`:173-174`).
2. Append raw envelope to the canonical `.jsonl` (`:177`).
3. Insert `run_log_lines` row **only when a display line exists** (`:181-189`) — display-less envelopes live in the file only.
4. Fold facts into `agent_runs` (sessionId, max-of usage, last cost, turns) (`:192-199`).
5. Publish `run.log-appended {runId, seq}` (`:202-210`) — persist-before-publish so a client can always fetch what the event references.

`finalize` (`:219-237`) maps `RunExit.outcome` → state `finished|error|interrupted`, stamps `finishedAt`, clears phase/step, publishes `run.state-changed`. `sink.line` self-catches so a persist failure never crashes a timer-context callback (`:211-216`).

## Persistence (what lives where)

- **Raw truth (files):** `${VIBERR_DATA_ROOT}/runtimes/<backend>/<runId>.jsonl`, append-only (`app/server/runtimes/run-store.server.ts:360-378`). Written under the **run id** always (the "sessionOrRunId" naming is aspirational — `run-sink.server.ts:110-115` deliberately never renames). `effectiveBackend` can change at finalize (`run-sink.server.ts:227`) so a run's lines could in principle split across backend dirs.
- **DB rows:** `agent_runs` (state/phase/step/usage/session_id/agent identity/outcome_key — `db/migrations/0001_baseline.sql:256-288`) and `run_log_lines` (run_id, seq, raw_json, display_json — `:289-297`), unique `(run_id, seq)` (`:344`). Partial unique index enforces ONE queued/running `primary` run per task (`:341-343`); `startRun` translates the violation into a 409 (`run-service.server.ts:336-350`).
- `nextSeq` = MAX(seq)+1 per run (`run-store.server.ts:222-227`).
- Retention deletes `run_log_lines` older than a cutoff by `occurred_at` (`app/server/db/retention.server.ts:43`) — the raw `.jsonl` is NOT pruned, so file and DB diverge over time by design.

## Run statuses and terminal outcomes

`RunState = queued | running | finished | error | interrupted` (`runtime-types.ts:15-20`). Row is inserted `queued` (`run-service.server.ts:321-335`), flipped to `running` immediately in `launch` (`:729-730`). Terminal outcome comes **from the stream, not the exit code** (`adapter.server.ts:85-93`):
- Claude: success requires a `result` envelope with `is_error` false; idle-timeout (no SDK message for `VIBERR_CLAUDE_IDLE_TIMEOUT_MS`) interrupts the query but settles `error` with tag `run·error·idle_timeout` (`claude-runtime.server.ts:408-491`); classified failures get `run·error·<kind>` tags.
- Codex: success gated on `turn.completed` with no top-level `turn.failed`/`error` (`codex-runtime.server.ts:34-35`); adapter failures emit one `error·<kind>`-tagged line (`:445-461`).
- Backend-unavailable fail-fast (R7-2): `startRun` with no usable credential still creates the row, writes one server-authored `err` line tag `run·unavailable`, finalizes `error` — no process ever spawns (`run-service.server.ts:416-419, 433-450`).
- Projection render state (`run-projection.server.ts:123-135`): `finished`+finished_at → "done"; `finished` w/o label → "idle"; `queued`/`interrupted` render idle-shaped; error+quota/auth signature or `run·unavailable` tag → `failedBackendUnavailable` + one-click retry on the other backend (`:176-181, 206`).

## SSE wire (run-events → broker → client)

- `app/server/runtimes/run-events.server.ts` — two direct-to-broker publishers, deliberately NOT the projection emitter (no rebuild per log line): `run.log-appended` (reference-only `{runId, threadId, seq}`, `:12-34`) and `run.state-changed` (`:36-58`), both routed to the task scope.
- Broker (`app/server/events/sse-broker.server.ts`): per-connection scope filter (`:82-105`), 25s heartbeat, 256-event ring buffer with Last-Event-ID replay else `stream.resync` (`:273-295`), publish fan-out (`:317-331`). Also owns the app's only SIGINT/SIGTERM handler (closes SSE, checkpoints DB — `:149-167`).

## Live streaming to the UI

- Loader: `app/routes/project.task.tsx:133-149` calls `listRunsForTask` → `projectRunsForTask` (`run-projection.server.ts:264-297`), which **groups rows per agent** (`operator` | `<kind>:<profileId>`, `:231-234`), picks a representative (running-first else newest, `:245-253`), and ships a bounded window: newest 400 lines / 384 KB across the group, newest-run-first fill, synthetic `── resumed · run N of M ──` boundaries (`:312-389`, budgets `:61-62`). Non-members get a stripped summary (empty lines/window, `project.task.tsx:135-149`).
- Client: `useRunLogStream` (`app/features/runtime/use-run-log-stream.ts:135-503`) opens its OWN EventSource on the task scope. On `run.log-appended` for a known run it fetches `/resources/run-log?runId&since=<headSeq>` and appends dedup-filtered lines (`:406-479`); on `run.state-changed` it revalidates the loader once (`:480-493`). Backward paging (`loadOlder`, `:284-390`) walks `logWindow.runIds` with `?before=`/`?limit=`; paged threads are frozen against loader re-seeds (`:187-196`).
- Endpoint: `app/routes/resources.run-log.ts` — project-member gated (`:69`), forward tail (`since`) or backward page (`before`/`limit` clamped 1–500), served by `getRunLog` (`run-service.server.ts:924-954`).
- Panel: `AgentLogsPanel` renders `linesByThread`, raw toggle shows stored `raw_json` verbatim; footer count = `max(lineCount, storedShown)` excluding synthetic boundaries (`runs-panels.tsx:418-425`); elapsed derives from `startedAt` + client clock (`:143, :164`).
- Read modes of `getRunLog` (`run-service.server.ts:924-954`): forward `{since}` → `listRunLines` (unbounded, live tail is naturally small); backward `{before?, limit}` → `listRunLinesTail` (newest-N-oldest-first with per-line byte cost, `run-store.server.ts:275-305`); response carries `headSeq`/`oldestSeq`/`hasMore` where `hasMore = oldestSeq > stats.minSeq`.
- Client dedup + single-flight: at most one tail fetch per run in flight (`inFlight` set, UI-35, `use-run-log-stream.ts:399-404`); fetched lines filtered to `seq > headSeq` before append (`:436-439`). Stream failure surfaces as `streamError` copy instead of a silent freeze (UI-03/UI-30, `:459-466`).

## Start path (who writes what, in order)

`startRun` (`run-service.server.ts:309-423`):
1. `upsertRun` state `queued` with agent identity (name + profileId) and any `resumeSessionId` (`:321-335`); a unique-constraint hit on the delivering index → 409 (`:336-350`).
2. Audit `runtime.run.started` (with `failedUnavailable` marker when no adapter, `:353-370`).
3. Build `RunSpec` — effort normalized per backend (P13-RT-08, `:381-389`); Codex-only enforcement flags derived from the Claude-shaped denylist so both backends bind the same withheld grants (`repoWriteWithheldFromDenylist` `:272-278`, `webSearchWithheldFromDenylist` `:289-295`).
4. Unavailable backend → `failRunUnavailable` (`:416-419`); else `launch` (`:721-785`): create sink, `sink.markRunning()` immediately (queued→running), wire `onLine`/`onPhase`/`onExit`, register the handle only if the adapter didn't exit synchronously (`exited` guard, `:779-784`).
5. `onExit` order: `sink.finalize` → delete handle → fire-and-consume the one-shot completion callback with the re-read terminal row (`:750-777`).

`phase`/`step` are live-strip-only run-row columns (no persisted line): adapter `onPhase` → `sink.phase` → `patchRun` (`run-sink.server.ts:153-155`); cleared at finalize (`:232-233`).

## liveRuns derivation

`operatorSnapshot` (`app/server/tasks/operator-actions.server.ts:862-879`): `SELECT kind, agent_profile_id, state FROM agent_runs WHERE … state IN ('queued','running')` — declared the ONLY truth for "a run is in flight" (`:744-754`); the operator prompt is explicitly told `waiting` is a display flag (`operator-run.server.ts:1648`). The task-detail client mirrors this: `anyRunLive = waiting==='agent' || runtime.some(lifecycle running|queued)` (`app/features/task-detail/task-detail-page.tsx:1396-1400`) — note the client version deliberately ORs in `waiting`, covering the pre-row window, which is exactly the inference the operator is forbidden.

## Crash / interrupt / resume

- **Interrupt** (`run-service.server.ts:801-875`): RBAC `run-agents`; live handle → `handle.interrupt()` + stamp `interruptedBy`, adapter's onExit finalizes state; no handle (post-restart) → writes `interrupted` directly and publishes state. Idempotent (`already-terminal`).
- **Completion callbacks** are in-process only (`run-service.server.ts:67-98`); `fireIfAlreadyTerminal` (`:110-132`) covers the spawn-crash race. A restart loses pending callbacks — covered at boot by three reconcilers (`app/server/boot.server.ts:93,100,207`):
  - `finalizeOrphanedRuns` (`run-recovery.server.ts:51-164`): any `running|queued` row at boot → `error` + `interruptedBy:"restart"`, operator re-invoked per task under a 3-per-30-min audit-counted cap.
  - `recoverUnreactedAgentRuns` (`:194-325`): finished primary/reviewer runs on `waiting=agent` tasks with no `task.agent.replied` audit row → replay completion effects (staged `outcome_key` consumed, AO-1).
  - `recoverStrandedOperatorPlans` (`:350-418`): finished codex operator runs with no `plan_executed` audit row, ≤1h old.
- **Resume** (`resumeRun`, `run-service.server.ts:599-718`): a resume mints a NEW run row with a fresh derived thread id (`prev.thread_id + "-r…"`, `:645-646`) sharing the provider session id — the projection's group key (`<kind>:<profileId>`) is what keeps all resumes under one picker entry (`run-projection.server.ts:231-234`). Callers must re-supply confinement on resume (denylist XS-1, env, mcpServers, systemPrompt, outputSchema F7 — `:619-635`); model defaults to the caller's current profile, not the stale row (`:695-697`).
- **Continuity break** (P13-D-2): `probeSessionContinuity` first — uncached, unlike the 30s-cached loader-path `transcriptExists` (`session-export.server.ts:167-189, 224-228`). A proven-missing transcript stamps the dead run with a `run·session_missing` err line in BOTH the DB and the `.jsonl` (`recordSessionMissing`, `run-service.server.ts:497-522`), writes a timeline note, and starts a FRESH session with a continuity preamble (`:531-537, 660-684`) instead of failing the turn. `runIdsWithMissingSession` matches the tag suffix via `json_extract` (never LIKE over the row, so an agent printing the word can't self-mark — `run-store.server.ts:337-351`) to stop `latestSessionRun` re-selecting the dead id.

## Where a run could show stale/wrong state

1. **Missed finalize event** → phantom "running" strip: acknowledged (F22); bounded to 20s only while `hasActiveRun` (`use-run-log-stream.ts:168-174`). A queued-but-never-running row shows an idle-shaped pill meanwhile.
2. **In-process death without restart isn't covered**: `finalizeOrphanedRuns` runs at boot only. If an adapter's onExit never fires while the process stays alive, the row stays `running` until the idle timeout (15 min Codex / configurable Claude) — during that window `liveRuns` blocks the operator and the one-delivering index blocks new primary runs.
3. **Two processes, one data root** (the known docker-data dual-writer hazard): handles/completions are per-process globals (`run-service.server.ts:88-98`), so process B's `interruptRun` on process A's run takes the "no live handle" path and writes `interrupted` while A's adapter keeps running and later overwrites state at finalize.
4. **Sink persist failure is swallowed** (`run-sink.server.ts:211-216`): a failed DB insert after a successful `.jsonl` append silently skips seq + publish — the console permanently misses a line the raw file has; no marker is shown.
5. **`exportable` staleness**: `transcriptExists` caches 30s (`session-export.server.ts:167`), so an Export link can 404 briefly after a provider sweep, or stay hidden briefly after a transcript lands.
6. **Retention vs. window math**: pruning `run_log_lines` by `occurred_at` (`retention.server.ts:43`) shrinks `totalLines`/`minSeq` mid-session; a frozen paged thread (`pagedRef`) keeps its old `withheld` count and could show "load older" that returns nothing (handled: empty page walks on, `use-run-log-stream.ts:342`).
7. **`t` timestamps are server-clock strings** (`wire-format.server.ts:8-12`), unlike every other timestamp which travels as ISO and formats client-side (contrast `run-projection.server.ts:108-114`) — console rows show the server's timezone.
8. **Boot finalization publishes no `run.state-changed`** (`run-recovery.server.ts:76-85` patches rows directly): correct in practice (SSE clients reconnect and get `stream.resync` → revalidate), but a tab that reconnects within the ring-buffer window sees replayed pre-restart events, never a terminal one for the orphan; the 20s F22 interval is the actual healer.
9. **usage `Math.max` folding** (`run-sink.server.ts:164-167`): correct for cumulative Claude totals, but for Codex per-turn cumulative usage a context-compaction that RESETS token counts would freeze the counter at the pre-compaction max (by design: "never regress").

## Suspect areas

- Dual-writer interrupt/finalize race (item 3 above) — nothing guards `patchRun` state transitions against a concurrent finalizer; `sink.finalize` unconditionally overwrites `interrupted` with the adapter's outcome ordering.
- Silent line loss on DB error (item 4) — raw file and DB projection can diverge with no surfaced signal; the "N events" footer trusts `lineCount` from the DB only.
- In-process orphan window (item 2) — a wedged adapter that also dodges the idle timer (e.g. a stream that heartbeats events forever without a terminal envelope) holds the delivering lock indefinitely; only interrupt or restart clears it.
- `failRunUnavailable` calls `sink.markRunning()` before erroring (`run-service.server.ts:436`) — an SSE listener sees a `running` flash for a run that never had a process; harmless but makes "state=running once meant a process" untrue.
- `finishedLabel` passes the raw ISO through (`run-projection.server.ts:108-114`) yet seeded rows store verbatim mock labels ("9:41") — client formatting must handle both shapes; a non-ISO label from any new writer would render oddly.

## Open questions

- Is the `effectiveBackend` switch at finalize (`run-sink.server.ts:227`) reachable anymore now the simulated-fallback runtime is gone (R7-2)? If not, `RunExit.effectiveBackend` and the raw-path backend split are dead flexibility.
- Retention sweeps `run_log_lines` but never `agent_runs` rows nor `runtimes/*.jsonl` files — is unbounded raw-file growth accepted for a side project, or should the sweep prune files past the same cutoff?
- `run.log-appended` publishes only when a display line exists (`run-sink.server.ts:202`), so raw-only envelopes never nudge the tail — is the `{ } raw` toggle understood to show only *stored-row* raw (it is), and is the `.jsonl`'s superset ever surfaced anywhere in the UI?
- The 256-event ring buffer is global across all scopes (`sse-broker.server.ts:39`) — can one chatty run evict another task's events fast enough that reconnecting tabs on quiet tasks systematically hit `stream.resync` (full revalidate) instead of replay?
