# Insights — instance agent-run analytics dashboard

Shipped in `7f37843` ("Add Insights: instance agent-run analytics dashboard"),
with one follow-up cosmetic fix in `d16f4b5` (em dash → "n/a" placeholder, a
copy-ban rule — noted inline below where it applies). This doc describes the
feature AS IT CURRENTLY STANDS on disk, file:line, for an agent with no other
context.

## What it is

A read-only `/insights` page: instance-wide analytics over the `agent_runs`
table (every agent execution across every project on this Viberr instance —
NOT scoped to one project by default). Reachable from Home → the org-settings
panel's "Insights" tile.

- Route: `app/routes/insights.tsx`
- Page component: `app/features/insights/insights-page.tsx` (`InsightsPage`)
- Aggregation module: `app/server/insights/insights-query.server.ts`
  (`getInsightsSummary`)
- Home tile: `app/features/home/home-sections.tsx:532-543` (`OrgTile` with
  `verb="View"`, admin-only per `OrgTile`'s existing `isAdmin` gate at
  `app/features/home/home-sections.tsx:425-445`; a non-admin still sees the
  tile, rendered as a disabled `<div aria-disabled="true">` with the same
  "Org admins manage this" caption the other org tiles use — cosmetic only,
  the loader is the real gate)
- Route registration: `app/routes.ts:27`, nested under the pathless
  `routes/palette-shell.tsx` layout alongside `/org/settings` and `/profile`

## Auth / RBAC

`app/routes/insights.tsx:12-15`:

```ts
export async function loader({ request }: Route.LoaderArgs) {
  await requireRole(request, "admin");
  return { summary: getInsightsSummary(getDb(), new Date().toISOString()) };
}
```

- `requireRole(request, "admin")` is `app/server/auth/require-user.server.ts:200-208`.
  It calls `requireUser` (redirect to `/login` if signed out), then checks
  `roleSatisfies(user.role, "admin")` (`require-user.server.ts:180-182`,
  `ROLE_ORDER = { member: 1, admin: 2 }` at line 174) — only `role === "admin"`
  passes; `member` gets a thrown 403 JSON `Response`
  (`forbiddenRole`, `require-user.server.ts:184-198`).
- `UserRole` (`app/shared/mapping/user.server.ts:9`) is `"admin" | "member"` —
  an **instance-wide** (org) role, distinct from the four **per-project** RBAC
  roles (`viewer/contributor/maintainer/admin` in `app/shared/rbac.ts`). There
  is only one org per instance (no `org_id`/multi-tenant column anywhere in
  the schema), so "org-admin" and "instance admin" are the same thing here —
  there is no cross-*org* boundary for this feature to leak across.
  `getInsightsSummary` itself applies no project-membership filter — it reads
  every project's runs unconditionally. This is consistent with the existing
  precedent that org admins already see every project regardless of
  membership (`app/shared/rbac.ts:17-19`, the "D2 override").
- Auth is checked **before** the query runs (`await requireRole` on its own
  line, throwing before `getInsightsSummary` is reached) — a rejected request
  never touches the DB.
- Enforcement is server-side only; the Home tile hiding
  (`home-sections.tsx:436-445`) is cosmetic, not the real gate.
- Covered by `app/routes/insights.test.ts`: an org admin gets a summary
  (lines 27-33), a non-admin's loader call rejects (lines 35-37, asserts only
  `.rejects.toBeDefined()` — doesn't pin the 403 status/shape).
- `getInsightsSummary` also accepts an optional `filter.projectSlug`
  (`insights-query.server.ts:88-91, 98-103`) that scopes every query to one
  project — exercised in the query-level tests
  (`insights-query.server.test.ts:141-147`) but **no route currently passes
  it**; the live `/insights` page is always instance-wide.

## Data source

`agent_runs` table, `db/migrations/0001_baseline.sql:381-423`. Relevant
columns: `project_slug`, `kind` (`operator|primary|reviewer`), `backend`
(`claude|codex`), `model`, `state` (`queued|running|finished|error|interrupted`
— DB `CHECK`-constrained, exhaustive), `started_at`/`finished_at` (nullable
TEXT ISO-8601), `turns`/`input_tokens`/`cached_input_tokens`/`output_tokens`
(INTEGER NOT NULL DEFAULT 0), `total_cost_usd` (REAL, **nullable**).

Row lifecycle (for context, none of this is part of the audited commit):
`started_at`/`finished_at` are both written from the server's own
`new Date().toISOString()` at well-ordered points — `started_at` at dispatch
(`app/server/runtimes/run-service.server.ts:398`, threaded into
`sink.markRunning`), `finished_at` at completion
(`run-service.server.ts:461,1457`; `app/server/runtimes/operator-run.server.ts:1266`)
or at boot-time orphan finalization (`app/server/runtimes/run-recovery.server.ts:80-87`,
which also forces `state: "error"`, not `"interrupted"`, for a restart-killed
run). `state: "finished"` is set purely from the adapter's own
protocol-completion signal — `sawResult && !resultIsError` in
`app/server/runtimes/claude-runtime.server.ts:859`, `sawTurnCompleted &&
!sawFatalError` in `app/server/runtimes/codex-runtime.server.ts:817` — i.e. "the
agent process exited cleanly," independent of whatever a human reviewer later
decided about the resulting work (verdict/delivery acceptance is tracked
elsewhere, not on this row).

## Metrics, and the exact aggregation behind each

Everything below is computed once per page load by
`getInsightsSummary(db, nowIso, filter?)`, `app/server/insights/insights-query.server.ts:105-222`.
One call, ~5 SQL statements, no loop-per-row. `nowIso` is injected by the
caller (`insights.tsx:14` passes `new Date().toISOString()`) rather than read
from a clock inside the module, so the 30-day window and the `generatedAt`
stamp are deterministic/testable.

Scoping: `scope(filter)` (`insights-query.server.ts:98-103`) produces
`WHERE project_slug = ?` + `[projectSlug]` when a filter is given, else an
empty clause + `[]`. Every query below interpolates that `clause` (or, where a
query needs an extra predicate too, the `and(extra)` helper at line 111 which
prepends `WHERE`/`AND` correctly either way).

### Totals (`totals.*`) — `insights-query.server.ts:113-125`

```sql
SELECT count(*) AS runs,
       COALESCE(SUM(total_cost_usd), 0) AS cost,
       COALESCE(SUM(input_tokens), 0) AS input_tokens,
       COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens,
       COALESCE(SUM(output_tokens), 0) AS output_tokens,
       COALESCE(SUM(turns), 0) AS turns
FROM agent_runs {scope}
```

- `runs` = every row regardless of `state` (queued/running included).
- `cost`/tokens/turns: plain `SUM`, `COALESCE`d to 0 only for the "no rows
  matched at all" case — SQL `SUM` already skips individual `NULL`s per row,
  so a run with `total_cost_usd IS NULL` (cost not yet known) contributes 0 to
  the sum and does NOT poison it; it's still counted in `runs`, just not in
  `cost`. Verified with a direct test (a `NULL`-cost `interrupted` row and a
  `NULL`-cost `running` row alongside two priced `finished` rows sum to
  exactly the two known costs) — `insights-query.server.test.ts:33-46`.
- Rendered as 6 stat cards: Total runs, Total cost, Output tokens (sub: input
  + cached), Success rate, Avg run time, Turns —
  `insights-page.tsx:73-95`.

### Outcomes + success rate — `insights-query.server.ts:127-138, 205-211`

```sql
SELECT state, count(*) AS runs FROM agent_runs {scope} GROUP BY state
```

`byState(s)` looks up each of the 5 possible `state` values (falls back to 0
if absent — never happens for `runs`/`totals` since those aren't state-gated,
but a given state can legitimately have zero rows). `terminal = finished +
error + interrupted` (queued/running excluded — those aren't terminal
outcomes yet). `successRate = terminal > 0 ? finished / terminal : null` — the
one place in this module where a division happens, and it's guarded: no rows,
no terminal rows yet ⇒ `null`, not `NaN`/`0`/divide-by-zero.

- `outcomes.running` and `outcomes.queued` are computed and returned by the
  query but **not rendered anywhere** on the page — the only outcome numbers
  shown are `finished`/`error`/`interrupted`, as the Success-rate card's `sub`
  text (`insights-page.tsx:86`). See bug candidates.
- Displayed success rate: `fmtPercent` (`insights-page.tsx:43-45`) —
  `Math.round(rate * 100)}%`, or `"n/a"` when `null`.

### Per-backend / per-kind / per-project / per-model breakdowns — `insights-query.server.ts:140-155`

```sql
SELECT {column} AS label, count(*) AS runs,
       COALESCE(SUM(total_cost_usd), 0) AS cost
FROM agent_runs {scope}
GROUP BY {column}
ORDER BY runs DESC, cost DESC
LIMIT 8   -- TOP_N, insights-query.server.ts:15
```

Called once per axis with `column` ∈ `{"backend","kind","project_slug","model"}`
(`insights-query.server.ts:213-216`) — `column` is always one of these four
hardcoded literals, never user input, so no injection risk despite the string
interpolation. `label` is coalesced to `"unknown"` if `NULL`
(`insights-query.server.ts:155`), which is defensive-only: all four grouped
columns are `NOT NULL` in the schema, so this branch is currently
unreachable.

Rendered as 4 `BreakdownCard`s (`insights-page.tsx:100-103`), each a
horizontal bar list sized to the row's share of the busiest row **by run
count** (`insights-page.tsx:137,155`), with that row's own cost alongside
(`insights-page.tsx:160`).

Ordering/truncation is **by run count, not by cost**, and the cap is a fixed
top 8 with no "+N more" affordance — see bug candidate #1, this is the
headline finding.

### Average run duration — `insights-query.server.ts:157-166`

```sql
SELECT AVG((julianday(finished_at) - julianday(started_at)) * 86400000) AS avg_ms
FROM agent_runs
{scope AND} state = 'finished' AND started_at IS NOT NULL AND finished_at IS NOT NULL
```

Only `state = 'finished'` rows with both timestamps present are averaged —
still-running rows (`finished_at IS NULL`) and crashed/orphaned rows
(`state != 'finished'`, e.g. boot-orphaned rows land in `state = 'error'` per
`run-recovery.server.ts:84-87`) are correctly excluded. `julianday()` diffs
the two ISO instants in fractional days; `× 86400000` converts to ms. SQL
`AVG` over zero matching rows returns `NULL` (verified directly against
`node:sqlite`), which the Zod schema types as nullable
(`insights-query.server.ts:80`) and the page renders as `"n/a"`
(`fmtDuration`, `insights-page.tsx:32-33`).

There is no floor/clamp on the diff being non-negative — see bug candidate #3.

Rendered: `fmtDuration` (`insights-page.tsx:32-41`) — `<60s` as `"Ns"`, `<60m`
as `"Nm"`/`"Nm Ss"`, else `"Nh Mm"`. Sub-label explicitly says "finished runs"
(`insights-page.tsx:92`) — honest about the exclusion.

### 30-day daily activity chart — `insights-query.server.ts:168-194`

1. `cutoff` = the UTC calendar date 29 days before `nowIso`'s instant
   (`WINDOW_DAYS - 1 = 29`), i.e. a 30-day inclusive window ending on
   `nowIso`'s own UTC date (`insights-query.server.ts:170-174`).
2. Query the real rows in that window:
   ```sql
   SELECT substr(started_at, 1, 10) AS date, count(*) AS runs,
          COALESCE(SUM(total_cost_usd), 0) AS cost
   FROM agent_runs
   {scope AND} started_at IS NOT NULL AND substr(started_at, 1, 10) >= ?  -- cutoff
   GROUP BY date ORDER BY date ASC
   ```
   (`insights-query.server.ts:175-185`) — bucketed by taking the first 10
   characters of the ISO `started_at` (its `YYYY-MM-DD` prefix), i.e. **UTC
   calendar day**, since every writer stores `started_at` as a `Z`-suffixed
   UTC ISO string (see "Data source" above). There is no upper bound on this
   filter (no `<= today`), so a future-dated `started_at` would be selected
   here but then silently fail to land in any bucket in step 3 below (its date
   key is outside the 30 generated days) — not currently reachable (both
   timestamps are always the server's own same-instant clock), but there's no
   guard either.
3. Gap-fill: loop `i` from 0..29, compute `d = cutoff + i days` (also a UTC
   calendar-date string — `new Date("YYYY-MM-DD")` parses date-only strings as
   UTC per the ECMA-262 spec, so this is consistent with step 1/2, not a
   timezone mismatch *within* the module), look up `d` in the query results,
   default to `{runs: 0, cost: 0}` if absent (`insights-query.server.ts:186-194`).
   This is what makes a quiet day a real `0` bar instead of a missing one —
   verified by `insights-query.server.test.ts:120-133`.

Rendered as 30 CSS column bars, `insights-page.tsx:172-195` — height is the
day's share of the busiest day (floor of 3% so a zero day still shows a tick,
line 188), no chart library. Each bar's only date label is a `title` hover
tooltip (`insights-page.tsx:184`); there's no always-visible x-axis. The whole
window is UTC-anchored with no viewer-timezone adjustment — see bug
candidate #5.

### Generated-at stamp — hydration

`summary.generatedAt` (the same `nowIso`) is displayed via
`<LocalDayDotTime iso={summary.generatedAt} />` (`insights-page.tsx:57`,
component at `app/ui/local-time.tsx:15-18`). This is the app's existing
hydration-safe pattern: first paint renders the timezone-deterministic UTC
form (`formatDayDotTimeUTC`), then an effect swaps to the viewer-local form
post-hydration — so this specific stamp does **not** produce a React #418
mismatch. (The UTC-day chart-bucketing question above is a separate, real
per-viewer perception concern, not a hydration bug — the SSR and client HTML
are identical either way since nothing about the chart depends on
`new Date()` at render time.)

## Empty state

`insights-page.tsx:49,66-70`: `empty = totals.runs === 0` (the unfiltered
`count(*)`, so it correctly accounts for runs in *any* state, not just
terminal ones). When empty, the entire stat grid / chart / breakdown UI is
skipped and replaced with one `.empty` message; nothing downstream (e.g. an
empty `BreakdownCard`'s "No runs." paragraph, `insights-page.tsx:144`, or a
`max || 1` divide-by-zero guard on the bar-width calcs, lines 137/173) is ever
reached in that state, though those guards exist independently too.

## Honesty / formatting behavior (`insights-page.tsx:16-45`)

- `fmtCost`: `$0.00` for exactly 0, `"<$0.01"` for any `0 < usd < 0.01`
  (avoids misleadingly rounding a real nonzero cost down to `$0.00`), else
  `$X.XX`. This is the one place the commit explicitly optimizes for honest
  display, and it does so correctly for the normal (non-negative) case.
- `fmtTokens`: `N`, `N.NK`, or `N.NM` (one decimal) by magnitude.
- `fmtDuration`/`fmtPercent`: `null` renders as `"n/a"` (originally an em dash
  in `7f37843`; changed to `"n/a"` in the immediate follow-up commit
  `d16f4b5` per this codebase's "no em dash in rendered copy" convention —
  `insights-page.tsx:33,44` and its test at
  `app/features/insights/insights-page.test.tsx:96-100` both already reflect
  `"n/a"`, not `"—"`).

## Tests

- `app/server/insights/insights-query.server.test.ts` — totals/outcomes sum
  correctly with mixed `NULL` costs (lines 20-38), `successRate` is `null`
  with zero terminal runs (40-45), grouping by all four axes (47-63), average
  duration over finished-with-both-timestamps only (65-82), gap-filled 30-day
  window with oldest-first ordering (84-97), project scoping (140-147).
- `app/features/insights/insights-page.test.tsx` — headline stat rendering,
  breakdown bars + 30 daily columns, empty state, null-placeholder rendering
  ("n/a" for both success rate and avg duration).
- `app/routes/insights.test.ts` — admin gets a summary; non-admin's loader
  call rejects (status/body not asserted).

## Not covered by this feature (context for related work)

- No route currently passes `InsightsFilter.projectSlug` — the scoping
  capability exists and is tested at the query layer only.
- No per-viewer timezone handling for the daily chart (UTC calendar days
  throughout).
- No indication in the UI when a breakdown list is truncated to the top 8.
