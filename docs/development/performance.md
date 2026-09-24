# Performance: journeys, measurements and the ratchet

> How Viberr measures and protects its speed (ruling 457). Modelled on the method in
> claude.ai's "How we made Claude.ai faster" post: pick the journeys people spend their
> time in, give each one a deterministic benchmark, remove the redundant work, and pin
> every win with a ceiling that can only move down. Source of truth:
> `test-support/perf-verdict.ts`, `test-support/perf-budgets.ts` and
> `test-support/perf-budgets/`, the `*.perf.test.ts(x)` files under `app/`,
> `scripts/measure-routes.mjs`, `app/shared/docs/perf-budgets-sync.test.ts`.
> Written 2026-09-24 with the first pass (ruling 457), from `main` @ `2169f940`.

## 1. The journeys

| Journey | What a person does | What it costs |
|---|---|---|
| `fresh-load` | Opens Viberr in a new tab: Home, a board, the login page | the route's client closure (JS + render-blocking CSS), fonts, the SSR loaders, the hydration payload |
| `task-open` | Clicks a card and reads the task | the task route chunk, the task loader's bytes and server work, the first render |
| `live-run` | Watches an agent's console while it runs | work per console line on the server (sink, SSE, tail fetch) and in the browser (renders, DOM writes), and the periodic revalidation |
| `board-live` | Keeps the board open while agents move cards | the board loader per revalidation, cards re-rendered per change, filter keystrokes |
| `compose-send` | Writes a comment and sends it | renders per keystroke, the action's server work, the loaders re-run afterwards |
| `controller` | Talks to the instance controller in the dock or on its page | what the closed dock costs every page, working-turn polling, renders per update |
| `server` | Everything above shares one Node event loop with the agents' runs | SQL statements, file reads and YAML parses per request |

The server journey matters more than its milliseconds suggest: the same event loop runs
the agents, answers clicks and streams consoles, so a loader that re-parses the same file
eleven times slows every tab (measured 2026-09-23: three open pages reloading 2.5 times a
second took `/resources/health` from 8 ms to 157 ms at p90).

## 2. Deterministic metrics only

A budget counts something that does not depend on how busy the machine is:

- **bytes**: a loader's serialized payload, a route's gzip client closure, the root
  stylesheet;
- **counts**: SQL statements per request, file reads or YAML parses per request, React
  commits or component renders per interaction (via `<Profiler onRender>` in jsdom), DOM
  mutations, loaders re-run per event or action, EventSources or intervals alive.

Wall-clock numbers are only corroboration in a PR description. This machine and CI are
shared, and a figure that swings with load cannot ratchet.

## 3. The ratchet

Every budget has an id, a ceiling, a unit, a journey and a fixture sentence. The area
tables live in `test-support/perf-budgets/` (one file per area, so parallel changes
append to different files); `test-support/perf-budgets.ts` merges them and refuses a
duplicate id. A `*.perf.test.ts(x)` file next to the code measures the figure on its
fixture and calls `expectWithinBudget(id, measured)` from `test-support/perf-ratchet.ts`.

The verdict (`test-support/perf-verdict.ts`) fails in both directions:

- **measured > ceiling**: a regression. Remove the extra work, or raise the ceiling in
  the same change with the reason written beside the entry.
- **measured < ceiling × (1 − slack)**: an improvement nobody recorded. The message prints
  the number to write; lowering the ceiling keeps the win. Slack defaults to 0 for counts
  and 5 % for bytes.

`app/shared/docs/perf-budgets-sync.test.ts` fails when a budget id is asserted by no perf
test, when a perf test asserts nothing, when a perf test that seeds through the server
does not pin the clock, or when a bundle budget names a route that does not exist.

### Bundle budgets

`test-support/perf-budgets/bundle.json` holds the gzip (level 9) closure of the routes
people load first: `root`, `root.css` (the render-blocking stylesheet alone),
`routes/login`, `routes/_index`, `routes/project.board`, `routes/project.task`,
`routes/controller` and `routes/profile`. After a build:

```sh
npm run build && node scripts/measure-routes.mjs --check
```

CI's verify job runs the same check after its build step. `node scripts/measure-routes.mjs
routes/project.task` (no flag) still prints the raw and gzip figures for any route.

The bundle table also accepts a `raised` note: a ceiling that went up says why beside the
number, the way a TypeScript budget carries a comment.

## 4. Measuring a new hot path

1. Reproduce the journey in a test before changing code, and count the thing that is
   repeated (a statement, a parse, a render), not the time.
2. Add the budget at today's value and see it pass, fix, then lower it to the new value.
   The test that pinned the old number now proves the new one. Keep a behavioural test
   beside it: a faster wrong answer is a regression.
3. If a count moves when the suite is busy, the test is measuring the tail of the step
   before it, not the interaction. Wait for the tree to stop committing (`settle`) before
   resetting a counter, and keep jsdom-only side channels out of the window (the composer
   tests pass Lexical's `SKIP_DOM_SELECTION_TAG`, because a DOM selection Lexical writes
   comes back through a queued `selectionchange` that it re-reads under time-based guards).
4. A figure must not move with the time of day, the zone or the host. The demo seed dates
   its events from the wall clock in local time and loaders derive from the hour (Home's
   greeting, a card's `quiet` flag), so a perf file that seeds through the server calls
   `pinPerfClock()` before it imports the seed. A byte figure leaves out what the host
   decides, such as a temp directory's path. On the real clock, `writes:comment.sql` read
   16 before 09:58 and 15 after, and Home's payload grew two bytes every afternoon.

The harnesses, one home each:

| Harness | Measures |
|---|---|
| `test-support/test-app.ts`, `demo-seed.ts` | route loaders and actions in-process, with real sessions and CSRF |
| `test-support/perf-clock.ts` | the wall clock a server fixture reads: one local time, the same in every zone (`pinPerfClock`) |
| `test-support/perf-counters.ts` | SQL executions, rows, compiles and commits (`countSql`, `tallyServerReads`), store-file reads and writes (`countFileReads`, `countFileWrites`); wraps the `node:sqlite` prototypes and `node:fs`, restored on exit |
| `test-support/render-counter.ts` | which components rendered in each commit, read off the fiber tree the way DevTools does (`createRenderCounter` + `<Profiler onRender>`), `settle`, and DOM writes (`observeMutations`) |
| `test-support/revalidation-harness.tsx` | loaders re-run per trigger, with single fetch's choice of routes and the real SSE broker in-process |
| `test-support/console-fixture.ts` | a big task: 870 console lines over three agent groups |
| `test-support/controller-dock-stub.tsx` | the dock's routed stub: requests per navigation, view loads per send |
| `test-support/static-imports.ts` | a module's static client closure, and so whether a route reaches a package (no build needed) |
| `test-support/css-rules.ts` | the one `app.css` parser, for CSS budgets (infinite loops on the main thread, scrollers without a gutter) |

## 5. What the first pass measured

Ruling 457 records the pass. From `main` @ `2169f940` to the merged pass, on the fixtures
the budgets name (103 budgets in 27 perf test files, plus 8 bundle closures):

| Journey | Figure | Before | After |
|---|---|---|---|
| fresh-load | root closure, gzip | 275,352 B | 168,823 B |
| fresh-load | Home closure, gzip | 319,392 B | 188,914 B |
| fresh-load | board closure, gzip | 368,729 B | 237,090 B |
| fresh-load | render-blocking stylesheet, gzip | 55,592 B | 35,669 B |
| task-open | task closure, gzip | 422,641 B | 304,870 B |
| task-open | a big task's `.data` | 1,048,869 B | 13,073 B |
| server | YAML parses per task revalidation | 35 | 0 |
| server | SQL statements per task revalidation | 86 | 49 |
| server | session lookups per task revalidation | 3 | 1 |
| server | SQL statements to create a task | 430 | 14 |
| server | commits to create a task | 279 | 1 |
| compose-send | loader runs per own comment | 6 | 2 |
| live-run | component renders per console line, 400 rows | 250 | 4 |
| live-run | loader runs per 20 s of a live run | 30 | 0 |
| live-run | EventSources per task tab | 2 | 1 |
| board-live | cards re-rendered when one card changes | 40 | 1 |
| board-live | loader runs per five filter keystrokes | 15 | 0 |
| controller | closed-dock requests per navigation | 1 | 0 |
| controller | controller-page loader runs per 30 s turn | 14 | 0 |

The findings the pass left alone, and why, are in the ruling and in the budget files'
comments: a prepared-statement cache (under a millisecond per request once the parses
were gone), replacing the `body:has()` login selector (about 1 ms per body restyle, for a
match-aware root layout), and one run-log row per run instead of a window (the same SQL
work for tiny rows).
