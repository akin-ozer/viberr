# Phase 8 report — Runtimes

Status: complete. Gates at close: `npm run typecheck` clean, `npm run build`
clean, `npm test` **503/503** green (422 prior + 81 new Phase-8 tests).
Live-verified in dev (`npm run dev`, arda@viberr.dev / viberr-dev-2828) — see
"Live verification" below. Store re-seeded pristine after
(`npm run seed -- --reset`: 18 runs / 96 run log lines).

**Real backends were NOT present** on this machine: no `ANTHROPIC_API_KEY`,
`CODEX_API_KEY` or `OPENAI_API_KEY` in the environment, and the local `codex`
npm binary is broken (`spawn … ENOENT` — the documented research gotcha). So
no real API smoke run was possible; the **simulated backend carries the entire
demo** (as briefed) and every real-adapter path is covered by injected-SDK-fake
tests. If keys are added later, the same code drives real runs (see "Enabling
real backends").

New deps: `@anthropic-ai/claude-agent-sdk@^0.3.201`, `@openai/codex-sdk@^0.142.5`.
New migration: `db/migrations/0006_runtimes.sql`. No CSS changes (every runbar/
logs/rsel class already ships in the ported `app.css`).

## Direction change folded in (mid-phase)

The coordinator switched the real adapters from **spawning CLIs** to the
**official TypeScript SDKs**. The architecture absorbed it cleanly — only the
two real adapters and the registry's detection changed; the sink, service,
seed, wire-format normalizer, panels, and SSE plumbing are all
backend-agnostic. The SDKs yield the SAME envelope objects the CLIs emit as
NDJSON/JSONL, so `wire-format.projectEnvelope` (the normalizer) was unchanged.
`line-buffer.server.ts` is kept as the safe reader for the raw `.jsonl` truth
(and is still tested for chunk-straddling) even though the SDKs yield parsed
objects.

## File inventory

```
db/migrations/0006_runtimes.sql          # agent_runs + run_log_lines (+ indexes)
app/
  schemas/sse-event.schema.ts            # + run.log-appended / run.state-changed
  features/runtime/
    runtime-types.ts                     # RunView, LogLine, RunState (client-safe)
    runs-helpers.ts                      # RUN_STATE/runLabel/roleShort/fmtClock/
                                         #   fmtTok/useTicker/useElapsed/runStatePill  [test]
    runs-panels.tsx                      # LiveRunPanel + AgentLogsPanel + AgentPicker
                                         #   + RunGlyph (runs.jsx port)                [test]
    use-run-log-stream.ts                # DEDICATED run.log-appended SSE consumer
  server/runtimes/
    adapter.server.ts                    # RuntimeAdapter/RunSpec/RunCallbacks/RunHandle
    wire-format.server.ts                # projectEnvelope (normalizer) +
                                         #   rawLineFromDisplay (sim) + fakeId          [test]
    line-buffer.server.ts                # chunk-straddling NDJSON/JSONL reader          [test]
    claude-runtime.server.ts             # Claude Agent SDK adapter                      [test]
    codex-runtime.server.ts              # Codex SDK adapter                             [test]
    simulated-runtime.server.ts          # THE default demo engine (scripted replay)    [test]
    runtime-registry.server.ts           # SDK-auth detection + fallback selection       [test]
    run-store.server.ts                  # DB rows + raw .jsonl append/read helpers
    run-projection.server.ts             # AgentRunRow(+lines) → RunView
    run-sink.server.ts                   # persist(raw+DB) → publish run.log-appended
    run-events.server.ts                 # direct-to-broker run.* publishers
    run-service.server.ts                # start/resume/interrupt/list/getLog +
                                         #   scheduleOperatorRun                          [test]
    runtime-seed-data.server.ts          # RUNTIME dataset (cc.*/cx.* builders, 18 runs)
    runtime-seed.server.ts               # materialize runs + lines + raw .jsonl          [test]
    seed-resumer.server.ts               # boot-registered live-line drip for running runs
  routes/
    resources.run-log.ts                 # GET /resources/run-log?runId&since (tail)
    project.task.tsx                     # + runtime loader field + run-interrupt intent  [test]
    routes.ts                            # + resources/run-log
  features/task-detail/
    runtime-slots.tsx                    # REPLACED null slots → real panel mounts
    task-detail-page.tsx                 # + runtime prop, log-stream consumer, interrupt
  server/
    boot.server.ts                       # + registerSeededLiveFromData()
    config/env.server.ts                 # + ANTHROPIC_API_KEY / CODEX_API_KEY / OPENAI_API_KEY
    seed/demo-seed.server.ts             # + seedRuntimes step, run tables in --reset
    tasks/task-actions.server.ts         # setOwner scheduling → real operator run
scripts/seed.ts                          # + agent-run / run-log-line counts
.env.example                             # + runtime backend keys section
```

## Data model (migration 0006)

- **agent_runs** — the queryable projection of a runtime session. Key columns:
  `thread_id` ("op"|"primary"|"c0", unique within a task; drives dropdown order
  + selection), `kind` (operator|primary|consultant), `backend`
  (claude|codex|simulated — the REQUESTED backend, kept for glyph fidelity),
  `simulated` (1 when the sim engine produced the run — a real fallback OR
  natively simulated; **separate from `backend`**), `state`
  (queued|running|finished|error|interrupted), `session_id` (provider id),
  `started_at`/`finished_at`, `turns`/`input_tokens`/`cached_input_tokens`/
  `output_tokens`/`total_cost_usd` (from REAL usage envelopes only — the mock's
  `tick*42` is BANNED), `interrupted_by`.
- **run_log_lines** — projected log lines: `seq` (0-based), `raw_json` (exact
  wire envelope), `display_json` (the projected LogLine). Unique `(run_id, seq)`.
- **Raw .jsonl truth**: `${VIBERR_DATA_ROOT}/runtimes/<backend>/<runId>.jsonl`,
  append-only. Persisted BEFORE the DB row + SSE publish, so a client reacting
  to `run.log-appended` can always fetch the line it references. We key the raw
  file by **run id** (deterministic path, no rename churn when the session id
  lands on the first envelope); the `<backend>` dir is the requested backend.

## Adapter interface (`adapter.server.ts`)

```ts
interface RuntimeAdapter {
  backend: "claude" | "codex" | "simulated";
  start(spec: RunSpec, cb: RunCallbacks): RunHandle;  // drives onLine/onExit
}
// cb.onLine({ raw, display, facts, occurredAt })  — one wire envelope
// cb.onExit({ outcome, effectiveBackend, simulated, sessionId })
// handle.interrupt(byUserId, byLabel)             — SIGINT / SDK interrupt / timer stop
```

Adapters never touch the DB/files/broker. The **RunSink** (`run-sink.server.ts`)
wires persistence behind the callbacks: for each line it appends the raw
`.jsonl`, inserts a `run_log_lines` row with the computed `display_json`, folds
usage/cost/turns/session facts into the run row, THEN publishes
`run.log-appended {runId, seq}`. Lifecycle transitions publish
`run.state-changed`.

### Real adapters (official SDKs)

- **Claude** (`@anthropic-ai/claude-agent-sdk`): `query({ prompt, options })`
  returns a `Query` (async generator of `SDKMessage`) with `interrupt()`. Each
  yielded message IS a wire envelope (`system·init` w/ session_id/model/tools,
  `assistant`/`user` w/ tool_use/tool_result, final `result` w/ usage/
  total_cost_usd/num_turns) → persisted as `JSON.stringify(message)` and
  projected by `projectEnvelope("claude", …)`. Prompt fed as an
  `AsyncIterable<SDKUserMessage>` to enable `Query.interrupt()` (streaming-input
  mode). Options: `cwd`, `model`, `permissionMode:"acceptEdits"` (autonomous),
  `resume:<session_id>`, `maxTurns`. Success gated on the result's `is_error`,
  never an exit code.
- **Codex** (`@openai/codex-sdk`): `new Codex().startThread({ workingDirectory,
  skipGitRepoCheck, sandboxMode:"workspace-write", model })` (or
  `resumeThread(threadId, …)`), then `thread.runStreamed(prompt, { signal })` →
  `{ events }` async generator of ThreadEvents (`thread.started` → thread_id;
  `turn.completed` w/ usage incl. `cached_input_tokens`; `item.*` variants;
  `turn.failed`/`error`). Interrupt via an `AbortController.signal`. Tokens
  only, no dollar cost. Note the Codex SDK spawns the codex binary internally,
  so on a machine where that binary is broken the run errors and the service
  falls back to simulated — exactly the briefed behavior.

Both adapters take an injectable SDK factory (`queryFn` / `codexFactory`) so
tests drive fake async generators — **real APIs are never called in tests.**

### Simulated adapter (the demo engine)

`simulated-runtime.server.ts` replays a scripted stream of display LogLines,
fabricating an authentic wire envelope for each via `rawLineFromDisplay` (the
inverse of the normalizer, faithful to the mock's `rawLine`, runs.md §5.4), so
`raw_json` is real Claude/Codex JSON and `display_json` is its projection —
**raw mode is uniform across real + simulated runs.** Realistic pacing
(1.0–3.2s cadence, the mock's `1000 + ((i*733)%2200)`); supports interrupt
(stops the timer, emits no result → `interrupted`, still resumable); usage
comes from the normalized envelope facts (no fabrication). Requires no external
anything.

## simulated-vs-real representation (documented)

`backend` on the row is ALWAYS the **requested** backend (claude|codex) — it
drives the glyph, the SDK label, and the metadata line. `simulated=1` is a
SEPARATE flag meaning "the sim engine produced this run", set either because it
is natively simulated (the seed, a freshly-scheduled operator run) OR because a
real backend fell back (its credential was absent). So a run can render as a
Claude run (sparkle glyph, "Claude Agent SDK") while `simulated=1` — the demo
looks real, the flag stays honest. `RunView.simulated` surfaces the flag if a
future surface wants to badge it.

## Registry + detection (`runtime-registry.server.ts`)

Detection is an **SDK-auth check — no paid API call** (the brief is explicit):
a backend is "available" when its credential is present in the env
(`ANTHROPIC_API_KEY` for claude; `CODEX_API_KEY`|`OPENAI_API_KEY` for codex; an
interactive `codex login` also authenticates the SDK but can't be cheaply
proven, so an env key is the detection signal — documented). Result cached per
process (HMR-safe global symbol; `setBackendAvailability` overrides for tests).
`selectAdapter(backend)` → the real adapter when available, else the simulated
engine with `simulated:true`; the caller keeps the requested backend on the row.

## run.log-appended consumer contract (phase-6 §"High-frequency streams")

- The runtime stream does NOT go through the projection emitter. `run.*` events
  are published **straight to the broker** (`run-events.server.ts`) with
  reference-only payloads (`{ projectSlug, taskKey, runId, threadId, seq }`),
  scoped to the task.
- The task-detail page mounts a **dedicated consumer** (`use-run-log-stream.ts`)
  with its OWN `EventSource` on the `task:` scope — NOT `useLiveUpdates`. On
  `run.log-appended` it fetches the new lines since its cursor from
  `GET /resources/run-log?runId&since` and appends them (append-only → the
  `follow` auto-scroll just works). On `run.state-changed` it revalidates the
  task loader ONCE (lifecycle — strip appears/disappears, pills flip — is
  loader-owned). Seeded from the loader's `runtime[].lines` + `raw`.
- `run-log` route returns `{ data: { runId, threadId, state, headSeq, lines:
  [{ seq, occurredAt, raw, display }] } }`. Any signed-in user may read
  (V1 read RBAC; interrupting is the gated action, not viewing).

## run-service API (`run-service.server.ts`)

```ts
startRun(db, { projectSlug, taskKey, threadId?, role, kind, backend, model,
  prompt, script?, resumeSessionId?, autonomous?, dataRoot? }) → { runId, simulated }
resumeRun(db, { runId, prompt, script?, dataRoot? }) → { runId, simulated }
  // a NEW run row sharing the session id (a fresh stream, matching both CLIs)
interruptRun(db, { projectSlug, taskKey, runId }, actor) → { outcome, run }
  // RBAC admin|maintainer (contracts §3.2); writes interrupted + audit event;
  // idempotent-safe (terminal run → "already-terminal", not an error)
listRunsForTask(db, projectSlug, taskKey) → RunView[]    // task-detail loader
getRunLog(db, runId, sinceSeq=-1) → RunLog | null        // dedicated-consumer tail
scheduleOperatorRun(db, { projectSlug, taskKey, ownerName, dataRoot? })
  // the Phase-5 operator-scheduling stand-in, now a REAL operator run
```

Live `RunHandle`s are held in a process-global registry keyed by run id so
`interruptRun` reaches the running adapter across requests. Concurrency:
multiple runs per task stream concurrently (VIB-151 has 3).

### Operator scheduling (generalized from Phase 5)

`setOwner` still writes the exact operator timeline event ("Acceptance boundary
now owned by **X** — scheduling execution against the quality-gated scope."),
and now ALSO calls `scheduleOperatorRun` when scheduling fires — spinning up a
real operator run so the run strip / agent logs reflect the reaction.
Best-effort (a runtime failure never breaks the ownership mutation) and
idempotent (skips if an operator thread already exists — so the seeded demo
tasks are untouched; only freshly-scheduled work spins one up).

## Seed + the running-run resumer

`seedRuntimes` materializes the full RUNTIME dataset (18 runs / 8 tasks / 96 log
lines) as `agent_runs` + `run_log_lines` + raw `.jsonl`, back-dated per ruling 4
(historical VIB-139/141 on Mar 30; the rest today). Running runs back-date
`started_at` to `now − elapsedSeconds` so the strip ticks a realistic elapsed
regardless of wall clock. Idempotent even without `--reset` (deterministic run
ids `run_seed_<task>_<thread>`; clears its own rows + raw files first). Triage
VIB-166/168 get none.

**Seeded "running" runs drip live over SSE without a persistent process:** the
seed writes each running run's initial `lines` to the DB and registers its
`live` lines with the resumer. Because `npm run seed` runs in a SEPARATE
process, `bootServer()` calls `registerSeededLiveFromData(db)` to re-derive the
pending live lines from `RUNTIME_SEED` for any DB run currently `running` — so
after a fresh boot (or CLI re-seed) the first client subscribe kicks a timer
that drips the live lines over `run.log-appended` (documented approach). Known
edge: a server restart mid-drip re-registers from line 0; the `(run_id, seq)`
unique index prevents DB duplication (raw `.jsonl` could gain a few duplicate
lines on that rare path — a demo-only artifact, re-seed clears it).

## UI (runs.jsx port)

- `runs-panels.tsx` reproduces `LiveRunPanel`, `AgentLogsPanel`, `AgentPicker`,
  `RunGlyph` 1:1 (structure, class names, copy — runs.md §4). Prototype bits
  replaced per §7: elapsed derives from `startedAt` (client clock,
  `useElapsed`); the token counter is **real cumulative usage** (the `tick*42`
  fabrication removed — a running specialist with no usage envelope shows 0,
  which is correct); live lines come from the dedicated consumer; interrupt is a
  real governed action. AgentPicker gains Escape-close + arrow-key nav (spec
  addition) keeping the exact ARIA. "View logs" scrolls the logs panel into
  view. The mount slots in `runtime-slots.tsx` (Phase-5 null placeholders) now
  render the real panels; the panel is fully suppressed (incl. the mock empty
  state) only when the task has zero runtime threads (VIB-166/168).
- Interrupt RBAC: the button is hidden for non-admin/maintainer viewers; the
  server re-checks regardless. Lifecycle mapping (ruling 11): `queued`→neutral
  "queued"; `interrupted`→neutral "interrupted · by <actor>" footer/pill; a
  `finished` run with no `finished` label renders "idle" (the operator threads),
  with one renders "done".

## Enabling real backends

1. `npm install` already added the SDKs. Set the credential(s) in `.env`:
   - Claude: `ANTHROPIC_API_KEY=sk-ant-…`
   - Codex: `CODEX_API_KEY=…` (or `OPENAI_API_KEY=…`), OR an interactive
     `codex login` on the host (needs a working `codex` binary — the npm
     wrapper on THIS machine is broken).
2. Restart the server. `isBackendAvailable(backend)` flips true, `selectAdapter`
   returns the real adapter, and new runs stream real SDK output (persisted as
   `raw_json` = `JSON.stringify(message)`). No key → the simulated engine
   carries on transparently (`simulated=1`, requested backend kept).
3. Autonomy: claude runs `permissionMode:"acceptEdits"`; codex runs
   `sandboxMode:"workspace-write"` + `skipGitRepoCheck`. `cwd`/`workingDirectory`
   is the task dir under the data root.

## Tests (81 new)

- **parsers**: `line-buffer` chunk-straddling (both backends, byte-by-byte,
  invalid-line tolerance); `wire-format` every envelope→LogLine (claude + codex)
  + the display→raw→display round-trip (matched tool_use/tool_result ids).
- **registry**: SDK-auth detection + caching + fallback with injected fakes.
- **adapters**: claude + codex with injected fake async generators — stream →
  EmittedLine, finish/error gating on result/turn.completed, interrupt →
  interrupted (never a real API call).
- **run-service**: lifecycle (finished/error), NO-fabrication token derivation,
  RunView shape + raw, `getRunLog` tail; interrupt RBAC matrix (admin/maintainer
  allow; reviewer/viewer/non-member 403) + audit + idempotent no-op;
  `scheduleOperatorRun` once.
- **simulated**: spec-conformant wire lines (raw re-projects to the same
  display), operator task-store MCP, error subtype → error, interrupt stops the
  drip, keepRunning leaves the run open.
- **seed**: 18 runs / 96 lines / 8 tasks, idempotent re-seed, VIB-142 fidelity
  spot-check vs data.js, VIB-151 (2 running + idle op), VIB-160 error,
  VIB-166/168 empty, log-projection round-trip.
- **route-level**: loader `runtime` shape (VIB-142/151/166), `run-interrupt`
  RBAC + audit through real Requests, already-terminal no-op toast.
- **UI (jsdom)**: helpers (fmtClock/fmtTok boundaries, runStatePill lifecycle);
  panels (strip visibility, concurrent-run dropdown, interrupt gating; logs
  empty/running/done/error footers + pills, raw toggle verbatim envelope, codex
  vs claude meta line).

## Live verification (dev)

Signed in as arda@viberr.dev, browser preview, console clean throughout:

- **VIB-151** (the demo case): live run strip "2 agents running" with the
  AgentPicker (Claude primary running + Codex consultant running), pulsing
  live-dot + spinner + phase/step, Elapsed ticking (06:42 → 07:40 across the
  pass, derived from `started_at`), Tokens 0 for the no-usage-yet primary (real,
  not fabricated) and 53.2k for the consultant (its real `turn.completed`
  usage), the operator idle in the dropdown. Agent logs streamed live — event
  count 17 → 22 as the seed-resumer dripped `live` lines over
  `run.log-appended`. `{ } raw` toggle rendered the exact wire JSON
  (`{"type":"system","subtype":"init",…}` / `{"type":"assistant",…"tool_use"…}`).
- **Interrupt**: clicked Interrupt on the running Claude primary as arda → run
  went `interrupted`, `interrupted_by` = arda, audit row
  `runtime.run.interrupted`, and the strip live-updated to "1 agent running"
  (the Codex consultant) via `run.state-changed`.
- **VIB-142**: no run strip (nothing running); logs default to the Operator
  thread ("idle" pill, "thread alive — no run executing"); the dropdown lists
  all three threads (op idle / Codex primary finished / Claude consultant
  finished); selecting the finished Codex primary showed the full 9-event
  history + the final `turn.completed` line ("turn 9 · in 128k (cached 96k) ·
  out 6.2k tokens · 92m") + the file_change diff line + the "run finished at
  9:41 — thread can be re-engaged" footer + the codex meta line.
- **VIB-160**: no strip; the error thread renders the "continuity error" blocked
  pill, the "stream ended on a continuity error — see the blocked packet"
  footer, and the error/result lines ("provider session 404 …", "halted ·
  operator raised a blocked decision packet").
- **VIB-166** (triage): no strip AND no agent-logs panel (zero runtime threads).

Server stopped, `npm run seed -- --reset` restored the pristine store (18 runs /
96 log lines / VIB-151 back to 2 running).

## Decisions / deviations

1. **SDKs over CLIs** (coordinator direction change) — see the section above.
   `line-buffer` kept + tested as the raw-`.jsonl` reader.
2. **Raw file keyed by run id**, not session id (deterministic path, no rename
   churn when the session id lands mid-stream). The `<backend>` dir is the
   requested backend.
3. **`finished_at` doubles as the display label** for seeded runs (the mock's
   "9:41" / "Mar 30 · 17:26" stored verbatim; real runs store ISO, the
   projection formats to `H:MM`). Render state: `finished` lifecycle + a
   finished label → "done"; + none → "idle" (operator threads).
4. **Token derivation has NO base value** — a running run with no usage envelope
   shows 0 tokens (the mock's non-zero base + `tick*42` are both prototype
   theater, removed per the brief). This is intentional and correct.
5. **`resumeRun` mints a new run row** sharing the session id (a fresh stream,
   matching how both SDKs emit a full new stream on resume) rather than
   appending to the prior row.
6. **Seed-resumer boot registration** solves the separate-process seed problem;
   restart-mid-drip is a documented demo-only edge (DB de-dup holds).
7. **RunView exposes `serverRunId`** (the DB run id) for interrupt + the log
   tail; the client-facing selection id stays the thread id ("op"/"primary"/
   "c0") per the mock.

## Known gaps (intentional)

- No `run:` SSE scope added — the dedicated consumer uses the existing `task:`
  scope (phase-6 left this as a one-liner option; task granularity is enough
  since runs are task-scoped).
- No token estimate from streamed deltas while a Claude turn is in flight (runs
  spec open-Q 8) — cumulative usage updates at usage-bearing envelopes only,
  which is the honest "no fabrication" behavior.
- No `--include-partial-messages` (token-level deltas) — not needed for the
  console; would only add stream_event envelopes.
- `interruptedBy` label uses the current display name (render-only, per ruling
  6 identity-by-id); a removed user falls back to the id.
