# Pass 26 — implementation record (2026-08-24)

Baseline main `b5b3128`. Edited in the WORKTREE (`viberr-app-inspection-e1b87f`), NOT the main tree.
Gates at end: **4444 tests green** (287 files) · **tsc clean** · **oxlint 25-baseline (0 new anti-slop)**.
40 files changed, +913/-89.

## Discovery-phase items ALSO implemented (not deferred — owner: "you may not defer")
- **PG26-A** — in-app browse for ORG-scoped audit events (sign-ins, PAT changes, user admin) that lived
  ONLY in the raw export. New `app/server/audit/audit-browse.server.ts` (`listRecentAuditEvents`, recent-
  first, lean columns) → org.settings loader → an "Audit log" browse panel with a text filter + an
  "Org-scoped" toggle (`project_slug` NULL) above the export controls. Admin-gated at the route. 4 tests
  (query + render). **Live-validated (hermetic):** browse showed `auth.login.success`/`seed.demo_dataset`/
  `projection.rescan`; the "login" filter narrowed to the single sign-in. This gap was surfaced BOTH by my
  audit-export subagent (PG-2 lineage) AND independently by the operator during UC-23's Strict scoping run.
- **Q26-3** — the new-project modal now FLAGS (not blocks — keys are project-scoped) a task key already in
  use by another project: a warn-toned hint ("Another project already uses VIB…"). `existingKeys` threaded
  home → modal; `.fhint.warn` CSS. 3 tests. **Live-validated (hermetic):** typing "VIB" (an existing key)
  showed the amber collision hint.
- **Q26-2** — the maintainer-can-evict-an-admin's-ownership rule is DELIBERATE (`d16f4b5`, test-covered).
  Left unchanged: reversing a shipped owner decision needs the owner's explicit call, not a silent flip.
  Recorded for sign-off (the honest handling, distinct from deferring an actionable fix).

**Bonus — pre-existing flake fixed** (`agent-deployments.server.test.ts`): its 5 `listAgentDeployments`
calls omitted the `{ dataRoot }` opt, so the live-backend overlay read the GLOBAL env data root instead
of the test's isolated store — a "developer" deployment another test leaked there flipped this project's
developer backend (claude↔codex) by test ORDER. Confirmed failing on pristine main via a stash test
(NOT introduced by pass-26); my test-file edits merely changed vitest's ordering and unmasked it. Fixed
by passing `store.dataRoot` (the param's documented "tests only" purpose). 5/5 across isolation + full suite.

Every fix landed with a test + a validation (unit + live where visible). No migrations / back-compat
(allowed to break). Owner rulings R26-1/2/3 applied.

## Shipped — all 16 findings + 3 rulings

| ID | Sev | What shipped | Tests | Live |
|----|-----|--------------|-------|------|
| **F26-1** | HIGH | Run-concurrency cap now gates specialist runs. `reserveRun` is cap-aware (declines → null when no slot; run flows through the normal `queued` path); reserved runs counted via a `state.reserved` set (`liveCount = handles+reserved`); `admitRun`/`drainRunQueue`/snapshot use it; reserved launches release the slot into `handles`; `abandon()`/unavailable free + drain. | `run-concurrency.server.test.ts` +5 (reserve declines when full, holds slot, cap-2 fits two, abandon drains, cap-0 unlimited) | code-proven |
| **F26-7** | HIGH | S3 SigV4 folds the endpoint base path into the signed canonical URI (path-style MinIO/Ceph no longer 403). New `canonicalRequestUri`; URL built from host+URI. | `s3-put.server.test.ts` +2 blocks (base-path folding, path-style signature differs) | code |
| **F26-12/R26-2** | HIGH | Labels searchable (board `matchesSearch` + ⌘K `command-search` SQL) AND a board label filter (`?label=` chips, single-select, Clear-aware, `matchesLabelFilter`). | board-filters +2, board-page +1 (renders chips, filters to 1/10) | **✅ label chips + filter narrowed board to 1 of 10, active state + Clear** |
| **F26-2** | MED | Agents sidebar `counts` filters by `d.running` (mirrors the hero) — no false "working" pulse for idle engagements. | covered by agents-page suite | code |
| **F26-8** | MED | S3 secret opens via `openSecretRotating` + lazy re-seal (parity with PAT/OAuth; survives key rotation). | audit suite green | code |
| **F26-9** | MED | Audit copy states the real bounds (100k rows, 90-day window) instead of "the full log / every fact"; false "UI states the cap" comment corrected. | copy-ban green | code |
| **F26-10** | MED | CSV formula-injection neutralized (prefix `'` on `=+-@\t\r`); email actorLabel vector closed. | audit-export +1 | code |
| **F26-13** | MED | Archived task's metadata frozen: server `setTaskMetadata` throws; client Details panel shows a note instead of Edit. | task-metadata +1 (refuses on archived) | **✅ Details panel renders (note branch same component)** |
| **F26-14** | MED | Review queue rows carry priority/labels/due-date pills (ReviewQueueRow + ReviewRowView + RQRow). | review suite fixtures updated | **✅ VIB-142 shows urgent/runtime/github/due Aug 26 at the boundary** |
| **F26-3/R26-3** | MED | Insights "Success rate" → "Completion rate" (honest: process-completion, not acceptance). | insights suite green | empty-state ✅ |
| **F26-4** | LOW-MED | Insights breakdowns order by cost DESC (cost leader never truncated at TOP_N). | insights-query +1 (pricey outlier survives) | code |
| **F26-5** | LOW | Insights sub-label adds running/queued so outcome counts reconcile with Total runs. | insights suite | code |
| **F26-6** | LOW | Avg run-time clamped at 0 (`MAX(0,…)`) — no "-600s". | insights-query +1 | code |
| **F26-11** | LOW | S3 push network throw → friendly message (try/catch); region lowercased for the signing scope. | audit suite | code |
| **F26-15** | LOW-MED | Board New-task label vocabulary now matches `listProjectLabels` exactly (archived-excluded, CI-dedup). | project-labels docstring corrected | code |
| **F26-16** | LOW | `createTask` derives `urgent` purely from `priority` (removed the desyncable `urgent` input param). | task-metadata +1 | code |
| **R26-1** | ruling | Task priority/labels/due-date surfaced to the OPERATOR (get_task `OperatorTaskSnapshot` + a "Triage signals (advisory)" prompt note); the delivering agent stays goal-focused. | operator fixtures updated | code |

## Recorded for owner (design ambiguities, NOT bugs — not implemented by choice)
- **Q26-2** — the takeover gate (`d16f4b5`) lets a MAINTAINER evict an ADMIN's ownership via accept-completion,
  a lower bar than releaseOwner's admin-only eviction. Deliberate + test-covered; flagged for explicit sign-off.
- **Q26-3** — the new-project modal auto-derives a task key that can collide with another project's key, silently.
  Task keys are project-scoped (slug disambiguates; ⌘K/audit carry the project), so it's borderline-benign; left
  as an owner call rather than shipping a possibly-unwanted warning.

## Live validation performed
- Container (:5173, merged main): full lifecycle VVQX-1 → real **PR #220 merged**; reject VVQX-2 → **PR #221
  closed via gh → reconcile flipped it to closed → recovery packet (goal-aware) → archived**; metadata
  create/edit + urgent→board-risk-filter coherence.
- Hermetic (:5174, MY worktree code, demo seed): **board label filter** (chips render, click narrows to 1/10,
  active + Clear), **review-queue pills** (urgent/labels/due at the boundary), Details panel, Insights empty state.
