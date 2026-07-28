# S1 adversarial verification (W1 — delivery & review integrity)

Verifier pass, 2026-07-28. Method: full diff read, per-claim code check, canary
run of the OLD behavior against a `main` worktree (3 behavioral canaries, all
confirmed the pre-fix bugs), gates run on the dirty tree.

## Gates

- `npm run typecheck` — CLEAN (react-router typegen + tsc, no output).
- `npx vitest run app/server/tasks app/server/github app/server/runtimes app/features/task-detail`
  — **59 files / 965 tests, all passed** (10.1s).
- Canary vs main (worktree + reduced test using only main-era exports):
  - R15-1: delivered revision with NO verdict → `stage: done` on main (VIB-9 hole real). ✔
  - R15-2: review entry fired `openTaskPr` on main (auto-hook real). ✔
  - F15-13: out-of-band-merged PR downgraded `merged→accepted` + "merge pending" text on main. ✔

## Verdict per claim

| Claim | Verdict | Evidence |
|---|---|---|
| R15-2 capability + grant | CONFIRMED | `app/shared/capabilities.ts:56` (cap + ENFORCED at :182), `operator.profile.md:46` |
| R15-2 deliverGate absent=direct | CONFIRMED (declared deviation) | `operator-actions.server.ts:250-254`; test `delivery-decision.server.test.ts:265` |
| R15-2 tool (Claude toolkit + Codex mirror) | CONFIRMED | `operator-toolkit.server.ts:329`, `operator-run.server.ts:625,653,668,1182`; failed delivery excluded from the policy-refusal report (`:1193`, only `denied` recorded) |
| R15-2 performDelivery shared core | CONFIRMED | `task-actions.server.ts:3131` (typed `DeliveryOutcome` :3104) |
| R15-2 auto-hook deleted + safety net (a) | CONFIRMED | `task-actions.server.ts:3048-3063`; canary proves old hook fired |
| R15-2 safety net (b) manual delivery | CONFIRMED | `manualDeliverForReview` `task-actions.server.ts:3341`, route intent `project.task.tsx:428`, button `task-detail-page.tsx:255-272` |
| R15-2 doctrine (definition + turn + fallback) | CONFIRMED | `operator.definition.md:15`, `operator-run.server.ts:1445,1612,1676` |
| R15-2 recommend→delivery card→applyRecommendation | CONFIRMED | schema `task-file.schema.ts:165`, `operator-actions.server.ts:1578`, `task-actions.server.ts:4948-4960` |
| R15-1 verdict gate + gate 1 (needs PR) | CONFIRMED | `verdictGateReason` `task-actions.server.ts:4267`, wired at :4302; canary proves old acceptance |
| R15-1 confirm dialog (accept + force) | CONFIRMED | `accept-confirm.tsx` (useDialog, PR/revision/verdict/branch/bypass), `task-detail-page.tsx:1704-1729`; tests fire-click-then-confirm |
| B-WF1 in-lock re-check | CONFIRMED on the DIRECT path ONLY — see gap 1 | `beforeMerge` `task-actions.server.ts:4638-4657`; in-lock `applyAcceptanceWrite:4515-4527` |
| B-WF6 shared acceptance core | CONFIRMED as claimed (two writers) but the THIRD writer was left out — see gap 1 | `applyAcceptanceWrite` :4501; operator use `operator-actions.server.ts:1835` |
| F15-15/B-GH1 push_conflict + no-PR-over-bad-push | CONFIRMED | `push-workspace.server.ts:90-96,309-325`, `task-actions.server.ts:3183-3220` |
| F15-15 acceptancePrHeadMismatch "NEVER bypassed by force" | BROKEN as a global invariant — bypassed by the packet path (gap 1); CONFIRMED for direct + force paths | check only in `acceptCompletion` :4599-4610; absent from `resolvePacket` accept (:3835-3923) and `operatorAcceptCompletion` |
| F15-15 reviewer PR-head pinning | CONFIRMED (supporting runs only) | `specialist-run.server.ts:795-803,1206-1212` |
| B-WF4 partial(by ownership) | CONFIRMED | `operator-actions.server.ts:1768-1771`; `schedule.server.ts` untouched; H1 in `handbacks/S1.md` with exact patch |
| F15-13 already-merged honesty | CONFIRMED on the direct path; the packet path still downgrades — see gap 1 | direct: :4614,4674, `applyAcceptanceWrite` :4536-4539; packet path mutate :3917 still writes `reallyMerged ? merged : accepted` |
| F15-02 partial | CONFIRMED | `task-detail-page.tsx:204-208`; H2 in `handbacks/S1.md` with root cause |
| F15-11 terminal/archived affordances | CONFIRMED | `resolveAcceptanceAffordance` :4458-4467, `execution-profile.tsx`, `task-detail-page.tsx` taskClosed |
| B-GH4 audit-on-create-only | CONFIRMED (undeclared but tested) | `pr-open.server.ts:369-380` |
| R15-3 owner-applied recommendations | CONFIRMED implementation; note it reverses a pass-14 documented stance under a claimed owner ruling 2026-07-28 — verify the ruling exists. `recommendationAuthorized` is not reachable from any route (checked `project.task.tsx`). | `task-actions.server.ts:4861-4880,2794-2800` |

## The 3 most dangerous gaps

1. **`resolvePacket`'s `accept_completion` is a third Done writer the W1 gates skipped**
   (`task-actions.server.ts:3835-3923`). It gets `acceptanceRefusalReason` (so the
   R15-1 verdict gate DOES apply pre-merge), but it is missing:
   - `acceptancePrHeadMismatch` — the F15-15 endgame (junk PR + green review)
     merges through an operator acceptance packet, the most common acceptance UX.
     This breaks the "NEVER bypassed" invariant as stated.
   - the B-WF1 refusal re-check — its `beforeMerge` re-checks only packet
     identity, and its locked write re-checks nothing; a revision delivered
     during the merge await closes the task over the new revision (the exact
     bug fixed on the direct path).
   - F15-13 — its mutate still writes `reallyMerged ? "merged" : "accepted"`
     and its event still says "merge pending" for an out-of-band-merged PR
     (`merged` → `accepted` downgrade alive on this path).
   It also does not use `applyAcceptanceWrite`, so "ONE shared core" is 2 of 3.

2. **The Strict preset does NOT map `deliver-review-pr` to recommend** — three
   comments claim it does (`capabilities.ts`, `agent-catalog.server.ts:95`,
   `operator.profile.md:44-45`) and the binding W1 design requires it, but
   `presetAgents` (`app/features/home/project-create.server.ts:67-89`) touches
   only the `auto` preset, and the shipped template grants `direct`. A "strict"
   project — the preset whose whole point is a human gating every advance —
   gets an operator that pushes branches and opens PRs at its own discretion.
   Undeclared plan deviation with actively misleading comments.

3. **`operatorAcceptCompletion` no longer clears non-acceptance recommendation
   cards on Done** — the old full-autonomy branch wrote `recommendations = []`;
   the shared core filters only `transition`/`accept_completion`/`delivery`.
   A leftover `run_specialist`/`assign_*` card on a Done task can be applied
   later and (for a spanAll/stage-eligible profile) start a run on a closed
   task. Also inconsistent with `resolvePacket`'s accept path, which still
   clears all. Low likelihood, but the class ("leftover offer the server
   honors") is the one this pass is hunting.

Minor notes (not blocking): Codex plan executor drops non-denied failed
delivery outcomes from the run report (deliberate; timeline events cover it);
safety-net review event is fire-and-forget (`void surfaceDeliveryEvent`);
`acceptancePrHeadMismatch` fail-open on any GitHub error is declared design.
