# Summary ledger (2026-09-02)

## What shipped (all on the working tree, verified)

| Area | Files | Proof |
|---|---|---|
| Conversation scope + surface | `db/migrations/0001_baseline.sql`, `app/server/controller/controller-conversations.server.ts` | `controller-conversations.server.test.ts` (scope, CHECK, list filters, `normalizeSurface`, user-row-only surface) |
| Context read | `app/server/controller/controller-context.server.ts` | `controller-context.server.test.ts` (verbatim under budget; newest-first prefix cut with a count; head cut; no-timeline cut; task/board/instance blocks; surface hint; budget ceiling) |
| Turn assembly | `app/server/controller/controller-run.server.ts` | `controller-run.server.test.ts` (task/board/instance binding sentences; context block first; surface stored) |
| Toolkit | `app/server/controller/controller-toolkit.server.ts` | `controller-toolkit.server.test.ts` (`keyOf` default + explicit override; `whoami.conversationTask`; `update_task` gates, partial application, full replace, clear, bad date; invariants) |
| Doctrine + skill | `app/server/seed/assets/controller.definition.md`, `controller-guide.skill.md`, `default-assets.server.ts` | `default-assets.server.test.ts` (outgoing hashes listed and recognized; no `list_projects`; context paragraph; comment wording); boot log on `:5174` showed both refreshed in place |
| Resource route | `app/routes/resources.controller.ts`, `app/routes.ts` | `resources.controller.test.ts` (instance view; members-only 404 parity; task 404 copy; newest thread first; `c=new`; foreign thread 404; CSRF toast 403; send creates the bound thread and records the surface; unknown intent 400) |
| Dock view | `app/features/controller/controller-dock-query.server.ts` | covered by the route test |
| Dock | `app/features/controller/controller-dock-context.ts`, `controller-dock.tsx`, `app/root.tsx`, `app/app.css` | `controller-dock-context.test.ts`, `controller-dock.test.tsx` (trigger name, open, focus, Escape + focus return, hidden on controller pages, threads, New, send with scope + surface, error toast, transcript + working dot); `app.css.test.ts` (scales, one breakpoint, no hidden control) |
| Full page | `controller-page.tsx`, `controller-query.server.ts`, both page routes | `controller-page.test.tsx` (project name, task chip, anchored header, surface chip, `surfaceLabel`); CSRF mapping in both actions |
| Docs | `docs/architecture/decisions.md` (ruling 121 + route map), `docs/domain/controller-and-goals.md`, `docs/ui/surfaces.md`, `docs/architecture/data-model.md`, `docs/architecture/codebase-map.md`, `docs/product/glossary.md`, `docs/product/requirements-status.md`, `docs/README.md` | read-through |

## Gates

- `npx oxlint`: 0 errors (two pre-existing warnings in `claude-runtime.server.test.ts`, untouched).
- `npx tsc --noEmit`: clean.
- `npx vitest run`: 307 files, 4967 tests, all green (before the last two test-only lint fixes; the two files were re-run green after).
- Canaries: `keyOf` default, `clipTaskFile`, the dock's Escape, the route's foreign-thread refusal — each test went red with its fix reverted and the file was restored.
- `npm run e2e` (production image in Docker): 65 passed, including `08-controller-dock.spec.ts` (both specs). The first run failed the dock spec on a focus assertion because that stack has no Claude credential (disabled composer); the component now focuses the panel when the composer cannot take focus, the jsdom suite covers it, and the re-run is green.
- Final `npx vitest run` after the last edits: exit 0 (see the totals in the session recap).

## Live proof on `:5174` (hermetic root, real Claude credential)

- Home: the dock reopened the newest instance thread (Aug 30), a send showed the working state and a real reply landed with markdown.
- Board `/projects/viberr/board`: trigger `Controller · viberr`, board context line, empty thread list.
- Task `/projects/viberr/tasks/VIB-1`: trigger `Controller · VIB-1 · viberr`, context line names the task file; the reply quoted "stage Review (4 of 5), readiness ready" and the goal's two deliverables, wording that exists only in the server-gathered header, so the context read reached the model.
- Threads view, light theme, and the 375 px bottom sheet all rendered; the sheet's first pass exposed a specificity bug (the appended base rule beat the breakpoint rule), fixed as `.dock .dock-panel`.
- The provider transcript (`data/runtimes/claude/<run>.jsonl`) holds the stream, not the prompt, so the prompt's shape is pinned by tests rather than read back from disk.

## Left as recorded

`NOTES.md` N6 (Insights label), N7 (notification-kind comment), N8 (page transcript height), N9 (one shared stream), N10 (`get_task` goal text). None blocks the ask.

## Adversarial review round, 2026-09-03 — 36 findings, all fixed

Method: eight lensed reviewers (server correctness, authority and security, client
behaviour, a11y and motion, design system and CSS gates, test quality, docs and rulings,
product and conventions) read the whole change set; every finding was put to three
independent skeptics with distinct lenses (reproduce, by-design, severity-and-scope) and
kept only when two of three could not refute it; a synthesis merged duplicates and
narrowed each claim; a completeness critic then hunted what no lens was assigned. 61 raw
findings, 49 unique, 36 confirmed, 13 refuted.

### The three the verdict called blocking

| # | What was wrong | Fix |
|---|---|---|
| 1 | `listConversations` had no tie-break, so same-millisecond threads came back oldest-first and the new route test failed 5 of 6 runs — `npm test` was red | `ORDER BY … DESC, rowid DESC` (the repo's own pattern), plus a store test that creates six threads in a loop and asserts the order |
| 2 | Every 404 from the dock's loader replaced the whole page with the root error boundary — three ordinary paths reached it, and a stale per-tab selection made it permanent for the tab | The route and the view never throw: an unreachable scope answers an `unavailable` view, an unusable selection falls back to the newest thread and reports `staleSelection`, and the client forgets the id. The send-result reload is guarded on the scope it was sent under |
| 3 | The per-turn context read had no authority gate: an ex-member driving an old thread from either full page got that project's `task.md` in the prompt while every tool refused | `assertProjectAction` inside `gatherControllerContext` (the same chokepoint the board tools use), the toolkit's uniform not-visible sentence as the block, and both full pages refuse a thread from another scope |

### The gap the eight lenses missed, found by the critic

`ensureBaselineColumns` (`sqlite.server.ts`): the squashed baseline is forward-only, so an
existing data root never gained `controller_conversations.task_key`,
`controller_messages.surface` or the scope index. The dock's loader names `task_key` on the
first signed-in page of every surface, so an upgraded root would have 500'd there and shown
the root error page everywhere. The backstop now ALTERs both columns and creates the index
idempotently at boot, with a test that reproduces the pre-121 schema first.

### Also fixed

Cross-project task anchoring; `update_task` claiming writes that never happened; a
forgeable context fence (now computed from the content, under a data-not-instructions
line); the dock rendering inert on `/profile` and `/notifications`; two focus-stealing
effects; Escape closing the dock from anywhere on the page; reduced motion losing to the
mobile sheet on specificity; the dock painting over the bell and account popovers; a
second SSE stream on every surface; the trigger's name flipping after the first open; the
board read running the app's hottest query twice; 40 project-file parses per instance
turn; two silent caps; the clip budget; the store-relative path; page-sent messages not
recording a surface; and the ledger's own over-claims. Twelve new or rewritten tests cover
them, including the turn assembly (asserted against the real `RunSpec`), budgets grown
past their bounds through the real writers, and the dock's open panel in the WCAG gate.

### Gates after the round

`npx oxlint` 0 errors · `npx tsc --noEmit` clean · `npx vitest run` 307 files / **4990
tests** · `npm run build` clean · `npm run e2e` (production image, Docker) **67 passed**,
including the dock's OPEN panel in the WCAG 2.2 AA gate in both themes (review G2).

The e2e earned its place twice over here. Run 1 failed because the spec still pressed
Escape from the page and expected the dock to close — the behaviour finding 8 deliberately
removed; the spec now asserts both halves (from the page it stays, from inside the panel it
closes). Run 2 then failed on the focus return, and that one was a REAL regression in the
fix: scoping Escape had also gated the focus return on "the user opened it", so a panel
restored open across a navigation closed and left focus on nothing. The rule is now the one
finding 8 actually stated — focus returns to the trigger whenever focus was inside the panel
at the moment it closed, however it came to be open — with a jsdom test for the
remembered-open path. Run 3 is green.

Screenshots in `screenshots/` were re-captured against the fixed code (the earlier set
predated the review), and `09-popover-over-panel.png` is the evidence for finding 9: the
notifications popover now paints over the dock's panel.

Live on `:5174`:
a stale selection now leaves the page intact and drops the id, Escape outside the panel no
longer closes it, the bell popover paints over the panel, and the trigger is named from
the workspace loader on the server as well as the client (no hydration mismatch).
