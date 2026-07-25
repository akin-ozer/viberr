# W4 handbacks — routes & UI honesty

Changes W4 needs in files outside its ownership (`app/features/**` except
org-settings/review, `app/routes/**`, `app/ui/**`, `app/app.css`). Everything
else for the W4 findings is implemented and tested on the branch.

---

## H1 — `archived` on the BOARD projection (R14-3) — ALREADY APPLIED ✅

Recorded for the audit trail: W4's board half (`board-filters.ts` excludes
archived tasks from every filter but `archived`; `board-page.tsx` renders the
Archived chip with its count and the banner) was inert while `TaskSummary`
carried no `archived`. The lead landed the projection in `c528a18`
(`task_projections.archived`, `rebuilder.server.ts:380,391`,
`app/shared/mapping/task.server.ts:36,114,293`), so the filter now has data.

Contract tests: `app/features/board/board-filters.test.ts` → "archived tasks are
excluded from every filter but Archived"; end-to-end round trip in
`app/features/task-detail/task-detail-route.server.test.ts` → "a maintainer
archives and restores".

---

## H2 — `app/features/org-settings/resources-panel.tsx` (W1's file), 4 residuals

W4 owns every other UI residual in the pass-13 ledger; these four sit in the one
feature directory W4 must not touch.

- **P14-WL-06 (`:1156`)** — `{res} context resources` pluralizes nothing, so a
  global profile card reads "1 context resources". Same shape as the LV-09 diff
  fix: `{res} context resource{res === 1 ? "" : "s"}`.
- **P13-UI-15 residual (`:449`, `:475`)** — the org global-agent stage picker
  still filters `s.id !== "done"` twice, a magic literal against the stage-roles
  contract (`app/shared/workflow/stage-roles.ts:5-10`). Home dropped the same
  literal in pass 13 by keying off the terminal stage; `resolveStageRoles(...)
  .terminalId` is the value to compare against.
- **P13-UI-13 residual (`:105-110`)** — the KB Re-index seg conveys selection
  with the `on` class only; it needs `aria-pressed`, like the Transport seg in
  the same file (`:539,553`) already has. The users-panel role toggles
  (`users-panel.tsx:275,278,410,413,646,653`) are the same fix.
- **P13-UI-20 residual (`:31-32`)** — `formatRelative` is called at render, so
  the string is minted on the server's clock and never ages. `app/ui/use-relative-time.ts`
  is the shared hook; `store-browser.tsx`'s new `FileMtime` component is the
  pattern for calling it inside a row map.

---

## H3 — `public/favicon.ico` (P13-UI-27 residual)

`public/` holds only `favicon.svg`; browsers that ignore the SVG link still
request `/favicon.ico` and get the app's 404 boundary. Either ship an `.ico` or
drop the claim — W4 cannot add a binary asset under `public/`.

---

## H4 — INFO, no action requested: the UI-52 server half

`app/features/agents/agent-profile-actions.server.ts:467` persists
`backends: [form.backend]`, so saving an edit to a seeded two-backend profile
narrows it. W4 could not change that file, so the EDITOR now states the
narrowing before the save (`create-profile-modal.tsx` → "Saving pins this
profile to one backend … Claude Code will be dropped", covered in
`agents-page.test.tsx`). That is honest, and a run uses the first backend
anyway. If the owner would rather preserve both, the form needs to become
multi-select and that server line needs to keep the untouched ids.

---

## H5 — INFO: `data-screen-label` (P13-UI-18) still has no reader

32 occurrences across `app/**/*.tsx`, still zero consumers — deferred by the
pass-13 ruling to "one repo-wide sweep", which has not happened. W4 did not
add any new ones.
