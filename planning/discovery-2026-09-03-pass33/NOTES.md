# Pass 33 — discovery notes (2026-09-03)

Running log of observations while reading the code/docs and using the app.
Findings with an id (`F33-*` defect, `U33-*` UX, `D33-*` doc/canon, `Q33-*` question for
the owner, `G33-*` gap) are collected in [FINDINGS.md](FINDINGS.md).

## Environment for this pass

- Host dev server on `docker-data` (port 5173), container `viberr-app-1` STOPPED first
  (one writer per data root). Build revision `119bf85a` (ruling 121, controller dock).
- Data root started EMPTY of projects — a clean-sheet run, so first-run UX is exercised.
- Sign-in `arda@viberr.dev` (org admin, the only user at start).
- Screenshots: `scripts/.pass33-shots.mjs` / `.pass33-drive.mjs` (Playwright, 1440x900 @2x,
  deleted at pass close). The in-app Browser pane paints STALE frames in this session —
  its DOM reads and clicks work, its screenshots lag; Playwright is the source of truth.

## Reading log

- Read `AGENTS.md`, the whole `docs/` set (product, architecture, all five domain pages,
  ops, ui/surfaces, development) and all 121 rulings in `docs/architecture/decisions.md`.
- The documentation is unusually good: code-verified, dated, with a validation ledger.
  Treat it as accurate but not infallible — verify anything I act on.

## Method and traps (for the next pass)

- **Two automation stacks disagree less than one lies.** The in-app Browser pane painted
  stale frames all session — its DOM reads and clicks worked, its screenshots lagged — so a
  Playwright driver did the seeing. Both were used to cross-check the one finding that
  looked like a broken Comment button; both "confirmed" it, and both were wrong. The app's
  own e2e spec held the answer in a comment (`:has-text("Comment")` also matches the
  *Comments* filter tab). **Read the existing test before believing a UI observation.**
  Use `button:text-is("X")`, never `:has-text("X")`, for an exact control.
- A `ConfirmDialog` with no `data-screen-label` is invisible to a screen-label sweep, which
  is why two "buttons that do nothing" (remove stage, cancel schedule) were really dialogs I
  never saw. Fixed this pass; the label is now a required prop.
- The controller-dock focus test is timing-fragile under load: it failed twice while ten
  subagents were saturating the machine and passed 3/3 afterwards, and the whole suite is
  green. Not a product defect; a 1s testing-library timeout on a fetcher + paint.
- **Partitioning agents by file leaves seams.** Ten file-disjoint clusters landed cleanly,
  but three fixes needed an edit in a file another cluster owned — the mention author-note
  call site, the KB display names, the dock→page handoff. Each agent correctly refused and
  reported the exact edit; the orchestrator has to finish them. Budget for that.
- `npm run build` emits one `INEFFECTIVE_DYNAMIC_IMPORT` warning. It is **pre-existing** —
  verified by building a fully stashed tree. Do not chase it; a partial stash misattributes
  it.
- The Playwright driver and screenshot scripts (`scripts/.pass33-*.mjs`) are deleted at pass
  close; recreate them from this file's description rather than looking for them.
