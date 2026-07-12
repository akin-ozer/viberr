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

The previous pass is not accepted as a completion proof. Its own ledger deferred runtime and
MCP work, its validation called deferred cases PASS, and this campaign's preserved baseline run was
not clean. The final evidence below supersedes that baseline without erasing it.

## Documents

- current-state-reference.md — architecture, routes, invariants, roles, and operating model.
- browser-walkthrough.md — Docker/UI baseline, page inventory, screenshots, and live notes.
- findings.md — prioritized, evidence-backed defects and product questions.
- decisions.md — owner answers and explicit assumptions; no hidden product rulings.
- test-plan.md — the fresh project, 24-task matrix, role matrix, integrations, and PR outcomes.
- test-results.md — case-by-case evidence as the live campaign runs.
- implementation-ledger.md — finding to change to tests/API/UI/screenshot traceability.

## Phase status

- Product/document intent reconstruction: complete; owner decisions and working rulings are recorded.
- Code and architecture audit: complete; implementation ledger covers F01–F41.
- Docker Compose pre-fix baseline: captured on localhost:5173. Its former `real` backend labels meant
  credential presence, not verified provider health.
- UI pre-fix page inventory: captured and retained as diagnostic evidence.
- Live 24-task project: created as `viberr-deep-validation`; the failed first campaign and PR fixtures
  are recorded in test-results.md.
- Implementation: F01–F41 are implemented; credential-dependent evidence boundaries are explicit in
  the ledger rather than treated as live successes.
- Final regression: complete — typecheck; Vitest 146 files/1,318 tests; focused terminal/reviewer
  152 tests plus broader focused 165; production build; Playwright 19/19 in 20.5 seconds; healthy
  Docker/API/rescan; real MCP probe; cross-role/archive/responsive browser evidence; clean final logs.
- Publication cleanup: complete. The branch was rebased onto the fixture merge from `origin/main`,
  then `test-support/deep-validation/VDV-13.md` was removed before publication.

## Final evidence snapshot

- Docker Compose: 5 projects, 38 tasks, watcher active, projection integrity healthy, recovery not
  required.
- VDV: 24 discovery cases with final Admin/Contributor-owner/Viewer/org-admin-override role proof.
- GitHub: external truth proved #20 merged, #21 closed-unmerged, and #22 open then deliberately
  closed/deleted. Viberr's in-app view remained stale because no credential was bound.
- MCP: real DeepWiki probe healthy, three tools, 1,477 ms, Claude+Codex, attached to API Specialist.
- Screenshots: final desktop, role, task, archive, organization, notification/profile, MCP, and
  390×844 responsive captures are indexed in `browser-walkthrough.md`.

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
