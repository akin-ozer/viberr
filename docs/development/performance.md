# Performance: journeys, measurements and the ratchet

> How Viberr measures and protects its speed (ruling 454). Modelled on the method in
> claude.ai's "How we made Claude.ai faster" post: pick the journeys people spend their
> time in, give each one a deterministic benchmark, remove the redundant work, and pin
> every win with a ceiling that can only move down. Source of truth:
> `test-support/perf-verdict.ts`, `test-support/perf-budgets.ts` and
> `test-support/perf-budgets/`, the `*.perf.test.ts(x)` files under `app/`,
> `scripts/measure-routes.mjs`, `app/shared/docs/perf-budgets-sync.test.ts`.
> Written 2026-09-24 on branch `perf/journeys-pass` (from `main` @ `2169f940`).

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
test, when a perf test asserts nothing, or when a bundle budget names a route that does
not exist.

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

## 4. Measuring a new hot path

1. Reproduce the journey in a test before changing code. Route loaders and actions run
   in-process through `test-support/test-app.ts` (`setupAppTest`, `cookieFor`,
   `request`); `test-support/demo-seed.ts` seeds the demo board; renders are counted
   with a `Profiler` in a `// @vitest-environment jsdom` file.
2. Count the thing that is repeated (a statement, a parse, a render), not the time.
3. Add the budget at today's value, fix, then lower it to the new value. The test that
   pinned the old number now proves the new one.
