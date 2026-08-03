# Viberr modernization — 2026-08-03

Owner-approved scope, fresh implementation. This supersedes the abandoned 2026-08-02
attempt: that implementation ran to completion but the owner rejected the result and
reverted it; none of its code is reused here.

## Contract

- Update every direct dependency to the current acceptable release.
- Replace three custom subsystems:
  - recursive `node:fs.watch` adapters (projects + knowledge bases) → `chokidar@5.0.0`;
  - board HTML5 drag-and-drop → `@dnd-kit/react@0.5.0` + `@dnd-kit/dom@0.5.0`;
  - textarea/mirror-overlay mention composer → `lexical@0.49.0` + `@lexical/react@0.49.0`.
- All five additions are exact-pinned (new adoptions; dnd-kit and Lexical are pre-1.0).
- Preserve external behavior, canonical file formats, stored comment bytes, route
  action contracts, permissions, and server-authoritative board ordering.
- Excluded: an ORM, a UI framework or component suite, Octokit, a direct MCP SDK
  dependency, legacy `@dnd-kit/core`/`sortable`/`utilities`, Lexical Markdown/HTML/
  Yjs/collaboration features, rich-text persistence.
- No staging, commits, or pushes unless the owner asks.

## Design principles

The owner rejected a prior, fully green implementation on quality grounds.
Acceptance here is taste as much as tests:

- Keep the current look and interaction feel. New capabilities (keyboard and touch
  dragging) must not degrade the existing pointer experience.
- Style only with the `--viberr-*` design tokens and existing CSS idioms.
- Match the surrounding code's conventions; smallest diff that does the job; no
  speculative abstraction layers.
- Show the owner the running result (screenshots from the production-image stack)
  after each user-facing wave, before moving on.

## Testing policy (owner amendment)

- Anything that serves the app for a test runs on the **production Docker image** in
  an isolated Compose stack: fresh named volume, synthetic secrets, never `.env`,
  `docker-data/`, or host `~/.codex`. The dev server is banned for browser, e2e,
  integration, and acceptance checks.
- `npm run e2e` stays one command: an orchestrator brings the stack up (demo-fixture
  seed as a one-shot service from the Dockerfile build stage, app from the final
  stage), waits for `/resources/health`, runs Playwright against the derived port,
  and tears down with `--volumes`. Restart/persistence checks restart only the app
  service (`--no-deps`) so the seed one-shot cannot wipe the volume.
- Unit tests, typecheck, and build run directly on the host.

## Phases

0. Baseline: `npm ci`, full gates on unmodified main, registry version sweep.
1. Dependency currency in three grouped bumps, full gates between groups.
2. Compose e2e harness replacing the dev-server `webServer`.
3. A1 — chokidar watcher migration (server-only; zero client bundle delta).
4. A2 — dnd-kit board migration.
5. A3 — Lexical composer migration.
6. Final validation (clean install, all gates, browser pass, bundle measurement).
7. Implementation record + planning index update.

## Known landmines (learned from the abandoned attempt's records; no design reused)

- Task-detail absolute timestamps hydrate with a server/client timezone mismatch
  (React error 418) — pre-existing on main; verify at baseline and decide a
  disclosed narrow fix vs. documented tolerance before A3's strict e2e.
- Board drag over concurrently-changed state needs freeze-and-abort semantics; the
  server stays authoritative and nothing commits optimistically.
- `docker compose start app` re-runs one-shot dependencies; restart tests must use
  `--no-deps`.
- chokidar registers per-file native watch handles; the owner already accepted the
  descriptor footprint. Lifecycle release on stop/re-arm is still required.

## Final acceptance gates

- `npm ci` clean; `npm ls --all` valid; `npm audit` zero vulnerabilities (or a
  documented unfixable-transitive acceptance); `npm audit signatures` passes;
  `npm outdated` empty for direct dependencies.
- Full unit suite, typecheck, and build green; full e2e green on the production image.
- Compose lifecycle: health with `watcher`/`kbWatcher` true, app-only restart with
  persistence, clean shutdown, writer-lock release.
- Standalone `docker run` smoke: `--network none` boot, non-root writable volume,
  health, restart.
- Bundle deltas (gzip route closure, measured immediately pre/post per wave):
  A2 board route ≤ 45 KiB, A3 task route ≤ 120 KiB, unrelated routes within 5 KiB.
- The owner has seen the board and composer running and has not vetoed.

## Status log

- 2026-08-03: plan written; Phase 0 started.
- Phase 0 ✓ — baseline green on unmodified main: 2447 tests, typecheck, build; 9 audit
  vulns recorded as pre-existing; node_modules drift (Codex-run residue) reset by npm ci.
- Phase 1 ✓ — every direct dep current (RR trio 8.3.0, vite 8.2.0, react 19.2.8,
  claude-agent-sdk 0.3.220, codex-sdk 0.146.0, better-auth 1.6.25, jsdom 30, playwright
  1.62.1, tsx 4.23.5, fonts 5.3.0); typescript override removed (RR 8.3 accepts TS 7
  peer); lockfile regenerated (npm's incremental resolver deadlocked on the peer-locked
  trio); audit 0 vulns; signatures verified; `npm outdated` empty; full gates green.
- Phase 2 ✓ — e2e now runs against the production image: compose.e2e.yml (build-stage
  seed one-shot → chown 1000 → final-stage app, synthetic env, project-scoped volume),
  scripts/e2e.ts orchestrator (`npm run e2e` unchanged for CI), webServer/globalTeardown
  removed, a11y spec fixed (cookie origin derived from page URL; login-card animations
  awaited before Axe). 29/29 e2e green.
- Phase 6 ✓ — final validation from clean `npm ci`: tree valid, audit 0, signatures
  verified, outdated empty; 2474 unit / typecheck / build; 40/40 e2e on the
  production image; compose lifecycle (watchers true, app-only restart with data
  intact, graceful stop RELEASES writer.lock); standalone `--network none` boot
  healthy on a UID-1000 volume with stop/restart; 16-route sweep clean except the
  pre-existing activity-page hydration finding (follow-up chip filed; /org is not
  a route). Flake hunt (12 back-to-back full-suite runs): three fixes. (1)
  PRODUCT — the A1 error handler treated ENOENT as fatal, killing the watcher and
  cancelling the queued unlink reconcile (regression test added: ENOENT is
  benign). (2)+(3) TESTS — macOS drops (not just delays) coalesced FSEvents under
  extreme load, so the two real-FS-event tests now RE-OFFER the awaited event
  inside their poll windows (KB: periodic re-touch; E13: a work-neutral poke file
  forcing a listing re-diff) — a broken reconcile path still never converges.
  Final: 4/4 back-to-back runs green at 2475/2475.
- Phase 5 (A3) ✓ — comment composer on lexical + @lexical/react 0.49.0 (exact pins).
  Plain-text only: same trimmed posted bytes (fixture-table pinned), mention
  highlighting via a character-editable MentionTextNode driven by the SAME
  findMentionSpans matcher the renderer uses; textarea/mirror-backdrop hack deleted;
  autocomplete controller decoupled from the DOM (refreshFrom/applyInsert) and
  keyboard model moved to composition-safe Lexical commands; draft synced to a ref
  (send reads exact current text, Timeline no longer re-renders per keystroke);
  success reset clears undo history. DISCLOSED narrow fixes for pre-existing
  hydration mismatches the strict A3 gate exposed (React #418 on task detail):
  timeline/schedule timestamps (LocalDayDotTime, UTC-deterministic first pass),
  reconciledAt relative stamp (LocalRelative), and agent-log clocks
  (finishedClock/localLogClock render raw-UTC until hydrated) — reproduced and
  pinpointed via SSR-HTML-vs-hydrated-DOM diffing. Bundle: task route +61.2 KiB
  gzip (gate 120), board/profile ±75 B. Gates: 2472/2472 unit (24 rewritten
  composer tests drive the real editor), typecheck, build, 8/8 composer e2e
  (real typing incl. mention chip wrap/unwrap on the wire), 40/40 full e2e, zero
  page errors under the multi-comment + operator-run reproducer. Known gap:
  OS-level IME composition not covered by synthetic e2e (guarded in code via
  editor.isComposing(); manual check recommended).
- Phase 4 (A2) ✓ — board drag on @dnd-kit/react + @dnd-kit/dom 0.5.0 (exact pins).
  Whole-card drag preserved (no grip handle): custom `preventActivation` lets the
  link face lift while buttons stay clickable; mouse activation is distance-only so
  a slow press-and-release still navigates; touch is long-press (250ms). Optimistic
  sorting plugin removed — server-authoritative order, same DropPreview/ghost visual
  language, pure `resolveBoardDrop` mapper (13 unit cases) with stale-slot
  degradation. dnd-kit's ARIA decoration dropped: its role="button" wrapper nested
  the link/StageMenu (axe nested-interactive, serious) — the accessible move path
  stays the StageMenu per F10-25, keyboard drag not added. Bundle: board route
  +35.0 KiB gzip (gate 45), task/profile ±0. Gates: 2447+13 unit / typecheck /
  build / 33 e2e incl. 4 real-input drag scenarios (non-append slot submit,
  cross-stage append, Escape cancel with zero requests, Done verdict refusal with
  snap-back) / axe both themes green. jsdom gains a ResizeObserver stub.
- Phase 3 (A1) ✓ — both watchers on chokidar@5.0.0 (exact pin; already in tree via
  @react-router/dev, so zero added weight). Typed add/change/unlink/unlinkDir events
  replace rename-inference; ignore predicate, debounce, reconciliation, re-arm
  lifecycle unchanged; stops renamed honest (`stopFileWatcher`) and wired into
  runProcessShutdown before DB close. Chokidar arms asynchronously — tests await
  `ready`; boot-window semantics documented in both headers. 2447/2447 unit, 29/29
  e2e, zero chokidar in client bundle, live in-container round-trip
  (sed task.md → "watcher reprojected"), app-only restart re-arms with data intact.
