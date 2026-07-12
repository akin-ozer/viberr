# Pass 3 — discovery → live testing → implementation (2026-07-12) — ✅ COMPLETE

Third full-product pass. Scope beyond passes 1–2: **the deferred role-bindings rework** (D2/D5
matrix-as-runtime-source, guard consolidation, capability prune, full D9 SSE membership, Q5 ruling),
plus fresh findings and a 20+ case live sweep. Security stayed out of scope (S3 → honest labeling only).

Base: `main` at the PR #7 merge (`7c064cd`), 1130 tests. **Delivered on branch
`viberr-rolebindings-pass3` → [PR #14](https://github.com/akin-ozer/viberr/pull/14)** (mergeable),
**1156 tests green**, typecheck clean, e2e 13/13, every changed flow verified live.

## Outcome
- **Role-bindings rework DONE**: `app/shared/rbac.ts` is the single `ACTION_ROLES` source that both
  the Policy page and every guard consume; `assertProjectAction` replaced the 3 duplicated admin
  guards; Q5 clean tiering; full D9 SSE membership; review/activity members-only; capability prune
  (30→26 ids) + S3 honest labeling.
- **All findings F1–F13 resolved** (F13 chased to its process-inheritance root cause). Notably F11
  (HIGH) — the `edit-other-task-branch` deny that blocked ALL Claude delivery in the default config.
- **Two adversarial review rounds** after the implementation: a 3-reviewer manual pass (4 defects) and
  a 25-agent verified Workflow (5 defects, incl. a regression from my own F1 fix). All fixed with
  regression tests. See `implementation-ledger.md` addenda 2 + 3.

## Docs in this folder (authoritative for this pass)
- **`implementation-ledger.md`** — THE finding/ruling → fix → validation map, incl. the F13 addendum
  and the two review-round addenda. Read this first for what shipped.
- **`role-bindings-current-state.md`** — the DISCOVERY-time enforcement map (pre-rework). See its top
  banner: the rework is now DONE; use `../discovery-2026-07-10/app-reference.md` pass-3 banner +
  `app/shared/rbac.ts` for the CURRENT state.
- **`findings-v3.md`** — the 13 findings + 7 role-bindings items, each tracked to closure
  (19 RESOLVED, 1 PARTIAL = the deliberate apply-recommendation seam).
- **`test-plan-v3.md` / `test-results-v3.md`** — the live sweep (selftest-4 on akin-ozer/viberr; real
  PRs #12 merged, #11/#13/#16 closed) + the post-implementation re-validation + agent-creation check.
- **`owner-rulings.md`** — the 4 questions asked this pass and the owner's decisions.

## Prior-pass canon
- `../discovery-2026-07-10/app-reference.md` — architecture/routes; **now carries a pass-3 update
  banner** with the RBAC/capability/runtime deltas.
- `../discovery-2026-07-10/product-intent.md` — invariants + resolved decisions incl. **pass-3
  rulings 15–19**.
- `../discovery-2026-07-11/role-bindings-map.md` — superseded (banner points here).
