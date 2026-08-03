# Modernization 2026-08-03 — implementation record

Fresh implementation of the owner-approved modernization (dependency currency +
three subsystem replacements), superseding the abandoned 2026-08-02 attempt.
[PLAN.md](PLAN.md) carries the contract and the per-phase status log; this is
the summary record.

## What changed

**Dependencies** — every direct dependency current as of 2026-08-03; lockfile
regenerated once (npm's incremental resolver deadlocks on the peer-locked
react-router trio):

- react-router / @react-router/dev / @react-router/serve `^8.3.0` (was 8.2.0);
  the `typescript: "$typescript"` override is gone — RR 8.3 accepts TS 7 peers.
- vite `^8.2.0` (pulls patched postcss ≥ 8.5.25), react + react-dom `^19.2.8`,
  @types/react `^19.2.18`, @types/react-dom `^19.2.4`.
- @anthropic-ai/claude-agent-sdk `^0.3.220`, @openai/codex-sdk `^0.146.0`,
  better-auth `1.6.25` (exact).
- fonts `^5.3.0`, tsx `^4.23.5`, @types/node `^26.1.2`, jsdom `^30.0.1`,
  @playwright/test `^1.62.1`.
- New (all exact-pinned): chokidar `5.0.0`, @dnd-kit/react `0.5.0`,
  @dnd-kit/dom `0.5.0`, lexical `0.49.0`, @lexical/react `0.49.0`.
- `npm audit`: 0 vulnerabilities (was 2 moderate + 7 high). Signatures verified.
  `npm outdated`: empty for direct dependencies.

**Testing policy** — `npm run e2e` now builds and drives an isolated
production-image Docker Compose stack ([compose.e2e.yml](../../compose.e2e.yml),
[scripts/e2e.ts](../../scripts/e2e.ts)): demo-fixture seed as a build-stage
one-shot (the fixture never ships in the final image), app from the final
stage, synthetic secrets, project-scoped volume, teardown with `--volumes`.
The dev-server `webServer` path is deleted; CI required no changes.

**A1 — chokidar watchers** — the raw recursive `node:fs.watch` adapters in
`file-watch.service.server.ts` / `kb-watch.service.server.ts` replaced with
chokidar's typed events (add/change/unlink/unlinkDir; no rename inference).
Ignore predicate, 250ms debounce, removal reconciliation, transient re-arm,
and HMR singleton unchanged. Stops renamed (`stopFileWatcher`) and wired into
`runProcessShutdown` before DB close. Chokidar arms asynchronously: tests
await `ready`; the sub-second boot scan window is documented in both headers.
Zero client-bundle impact (and @react-router/dev already shipped chokidar
5.0.0, so the direct dependency added no tree weight).

**A2 — dnd-kit board** — the HTML5 drag events in `board-page.tsx` replaced
with @dnd-kit/react sortable/droppable hooks. Whole-card drag preserved (no
grip handle) via a `preventActivation` override; mouse activation is
distance-only so slow press-and-release still navigates; touch is long-press.
`OptimisticSortingPlugin` removed — the server stays authoritative and the
existing DropPreview/ghost visual language is untouched. Pure
`resolveBoardDrop` mapper (`board-dnd.ts`) with stale-slot degradation.
dnd-kit's ARIA decoration is off: its role="button" card wrapper nested the
task link and StageMenu (axe nested-interactive, serious) — the accessible
move path remains the StageMenu (F10-25). Board route +35.0 KiB gzip.

**A3 — Lexical composer** — the textarea + transparent-text mirror backdrop in
`timeline.tsx` replaced with a plain-text Lexical editor
(`comment-composer.tsx`, `lexical-mention-plugin.tsx`). Known mentions render
as character-editable `MentionTextNode`s driven by the same `findMentionSpans`
matcher the renderer uses; the autocomplete controller
(`use-mention-autocomplete.ts`) is DOM-decoupled (refreshFrom/applyInsert) and
its keyboard model moved to composition-safe Lexical commands. Posted bytes
unchanged (`raw.trim()`, fixture-table pinned); success reset clears undo
history; failures retain the draft. Task route +61.2 KiB gzip.

**Disclosed narrow fixes (pre-existing hydration mismatches, React #418)** —
A3's zero-page-error gate exposed timezone-dependent SSR text on the task
page, pinpointed by diffing the SSR HTML against the hydrated DOM:
timeline/schedule timestamps ([app/ui/local-time.tsx](../../app/ui/local-time.tsx)
LocalDayDotTime — UTC-deterministic first pass, viewer-local after hydration),
the Synced relative stamp (LocalRelative), and the agent-log clocks
(`finishedClock`/`localLogClock` render raw UTC until hydrated). The same bug
class remained on the activity page — fixed by the follow-up pass (see Known
gaps and follow-ups below).

## Validation (final, from clean `npm ci`)

- `npm ls --all` valid · audit 0 vulns · signatures verified · outdated empty.
- Unit: 207 files / 2474 tests green (baseline 2447; +13 board mapper, +2
  formatter, rewritten 24-test composer suite). Typecheck + build green.
- E2E: 40/40 against the production image — 29 pre-existing (incl. WCAG board
  sweeps both themes), 4 new real-input drag scenarios (non-append slot on the
  wire, cross-stage append, Escape cancel with zero requests, Done verdict
  refusal + snap-back), 7 new composer scenarios (typing, multiline, mention
  keyboard/click with chip wrap/unwrap, undo-after-post, combobox ARIA), every
  composer test gated on zero page errors.
- Compose lifecycle: health `watcher:true, kbWatcher:true`; app-only restart
  keeps the seed one-shot untouched and data intact; graceful stop releases
  `state/writer.lock`.
- Standalone image: UID-1000 writable volume, boots healthy under
  `--network none` (honest degraded backends), stop + restart on the same
  volume healthy.
- Route sweep: 15 pages/states, all clean except the pre-existing activity-page
  hydration finding above; intended 404s intact.
- Bundle (gzip route closure): board 202,890 → 238,720 (+35.0 KiB, gate 45);
  task 265,594 → 328,308 (+61.2 KiB, gate 120); profile 192,645 → 192,720.

## Known gaps and follow-ups

- Activity page hydration mismatch (pre-existing; same class as the fixed
  task-page instances) — FIXED by the follow-up pass: day-group headers,
  stream row clocks, and audit labels (incl. the violation-pill title) render
  an absolute-UTC first pass (`formatDayBucketUTC`; `groupStreamByDayUTC` /
  `auditTimeLabelUTC` — absolute days on purpose, since the grouping KEY must
  not depend on when "now" is sampled) and regroup viewer-local after
  hydration. Gated by `e2e/10-activity-hydration.spec.ts` (Auckland viewer vs
  the UTC container, zero page errors + no Today/Yesterday in the SSR HTML);
  the spec reproduced the #418 against the unfixed image before the fix
  landed. Totals move to 2478 unit / 41 e2e.
- OS-level IME composition is not covered by synthetic e2e; the composer
  guards via `editor.isComposing()`; a manual IME pass is recommended.
- Touch dragging ships behind a 250ms long-press; Playwright cannot synthesize
  full touch drags, so it is design-verified, not e2e-verified.
- The suite's two real-FS-event tests flaked under back-to-back full runs
  (macOS drops coalesced FSEvents under extreme load). Resolved three ways: a
  real A1 bug (ENOENT treated as fatal killed the watcher and cancelled the
  queued unlink reconcile — now benign, regression-tested) plus event
  re-offering in both tests' poll windows. 4/4 consecutive full-suite runs
  green afterwards (2475/2475).
