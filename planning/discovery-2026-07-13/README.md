# Viberr end-to-end product pass — 2026-07-13

This folder is the durable reference for the current goal: understand the shipped product,
exercise it through the real Docker Compose deployment, test at least twenty realistic task
flows in a fresh Viberr-on-Viberr project, implement every confirmed defect, and revalidate the
whole application.

## Authority order

When sources disagree, use this order:

1. The owner's current goal and answers during this pass.
2. Decisions recorded in decisions.md in this folder.
3. The 2026-07-12 pass-4 owner rulings.
4. The current implementation, when it represents a deliberate later change.
5. The consolidated prior canon and product intent documents.
6. The original PRD and design mock as historical/visual references.

The pass before this dossier is not accepted as completion proof. Its own ledger deferred runtime
and MCP work, its validation called deferred cases PASS, and this campaign's preserved baseline run
was not clean. A later completed evidence pass superseded that baseline without erasing it. The
independent adversarial review then produced a further exact-intent hardening tree. That newest
tree completed its own local automated, fresh-Docker, API, Playwright, browser, screenshot and log
gate; it does not borrow the earlier pass's counts or screenshots.

## Documents

- current-state-reference.md — architecture, routes, invariants, roles, and operating model.
- browser-walkthrough.md — Docker/UI baseline, page inventory, screenshots, and live notes.
- findings.md — prioritized, evidence-backed defects and product questions.
- decisions.md — owner answers and explicit assumptions; no hidden product rulings.
- test-plan.md — the fresh project, 24-task matrix, role matrix, integrations, and PR outcomes.
- test-results.md — case-by-case evidence as the live campaign runs.
- implementation-ledger.md — finding to change to tests/API/UI/screenshot traceability.
- adversarial-review-remediation.md — independent post-pass review findings, owner-contract
  reconciliation, fixes, and the new release-evidence boundary.

## Phase status

- Product/document intent reconstruction: complete; owner decisions and working rulings are recorded.
- Code and architecture audit: complete; implementation ledger covers F01–F41.
- Docker Compose pre-fix baseline: captured on localhost:5173. Its former `real` backend labels meant
  credential presence, not verified provider health.
- UI pre-fix page inventory: captured and retained as diagnostic evidence.
- Live 24-task project: created as `viberr-deep-validation`; the failed first campaign and PR fixtures
  are recorded in test-results.md.
- Earlier F01–F41 pass: implemented and validated with credential-dependent boundaries explicit in
  the ledger rather than treated as live successes.
- Earlier regression evidence: complete on that earlier tree — typecheck; Vitest 146 files/1,318
  tests; focused terminal/reviewer 152 tests plus broader focused 165; production build; Playwright
  19/19 in 20.5 seconds; healthy Docker/API/rescan; real MCP probe;
  cross-role/archive/responsive browser evidence; clean logs.
- Post-review hardening: implemented and locally validated for exact completion/acceptance, merge,
  PR-open, intelligent routing, archive/restore and ownership-cleanup recovery;
  full-SHA/task-incarnation provenance; and enabled-actor/authority rechecks at canonical or
  irreversible boundaries. Publication remains on the existing draft PR #23.
- Earlier publication cleanup: complete. The branch was rebased onto the fixture merge from `origin/main`,
  then `test-support/deep-validation/VDV-13.md` was removed before publication.

## Earlier completed evidence snapshot

- Docker Compose: 5 projects, 38 tasks, watcher active, projection integrity healthy, recovery not
  required.
- VDV: 24 discovery cases with final Admin/Contributor-owner/Viewer/org-admin-override role proof.
- GitHub: external truth proved #20 merged, #21 closed-unmerged, and #22 open then deliberately
  closed/deleted. Viberr's in-app view remained stale because no credential was bound.
- MCP: real DeepWiki probe healthy, three tools, 1,477 ms, Claude+Codex, attached to API Specialist.
- Screenshots: final desktop, role, task, archive, organization, notification/profile, MCP, and
  390×844 responsive captures are indexed in `browser-walkthrough.md`.

These facts belong to the earlier F01–F41 evidence tree. They are retained for
traceability but do not validate the subsequent adversarial-review remediation.

## Post-review release evidence

- Full regression: 158 Vitest files/1,565 tests in 30.25 seconds; typecheck, production build and
  whitespace check passed. The independent risky-contract verifier passed 197/197 focused tests.
- Playwright: 19/19 passed in 22.1 seconds against the production application.
- Fresh Docker Compose: 3 projects/12 tasks; immediate rescan 0 changed/15 unchanged/0 removed/0
  errors in 3 ms; health and integrity OK; watcher active; 0 application warnings/errors.
- Signed-in browser: Home; Board; VIB-142; Review; Agents; Policy; GitHub; Activity; Settings; and
  organization Users/Resources passed with 0 console warnings/errors. Twelve new screenshots are
  indexed under `screenshots/post-review/` in `browser-walkthrough.md`.
- Publication: implementation commit `0c8c758` was pushed to
  `codex/full-pass-2026-07-13` on existing draft PR #23. GitHub Actions `verify` passed in 5m51s
  (run 29258036588).

## Non-negotiable completion rules

- The live app runs through Docker Compose, not a host dev server.
- Security hardening is out of scope unless required for role bindings or functional correctness.
- No migration/backward-compatibility layer is required; breaking cleanup is allowed. Canonical
  migration files changed in place, so this pass's demo validation must use a fresh database rather
  than an already-migrated one.
- No finding is silently deferred. An item is either implemented and validated, or resolved by an
  explicit owner decision recorded in decisions.md.
- Automated tests are necessary but insufficient. Each implementation slice also receives the
  appropriate API/file inspection and live browser verification.
- GitHub test PRs on akin-ozer/viberr must be tiny, disposable, and limited to test-support data or
  genuinely useful tests. The campaign observed one merged, one closed-unmerged, and one open PR;
  the open fixture was closed and its branch deleted after evidence capture.
