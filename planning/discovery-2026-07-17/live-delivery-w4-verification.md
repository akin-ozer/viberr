# Live governed-delivery + W4 divergence verification (2026-07-18, viberr project)

A full live end-to-end run on the designated test project (`viberr` → github.com/akin-ozer/viberr),
driven as elif (maintainer). Exercises operator coordination + agent selection + skill loading +
real PR delivery + the "reject a PR via gh" instruction + the pass-8 **W4 GitHub↔task divergence**
surfacing (my own implementation) — in one flow.

## The run (VIB-22 "Pass-8 live-verify note (docs)")
1. **Created** via the New-task modal (goal: a 4-line docs/testing/pass8-live-verify.md).
2. **Operator auto-engaged** on creation (`autoInvokeOperator`, trigger=create) — `run_8eGvA4pVRFHP`.
3. **Correct agent selection**: operator assigned the **Docs Writer** (claude/sonnet) for a docs task
   — NOT the Codex developer. Advanced ready→impl and started the specialist.
4. **Skill loaded + APPLIED**: the delivered file starts with `> Scope:` and ends with
   `Last reviewed: 2026-07-18` — the exact docs-style rules (and the run emitted DOCS-STYLE-MARKER-P7).
   notes MCP correctly NOT called (the goal needed no release notes — right restraint).
5. **Delivered**: pushed branch `vib-22`, opened **PR #50** (`docs/testing/pass8-live-verify.md`,
   +3/-0, 1 file — small, no bloat).
6. **Supervised operator**: posted a `1 pending` recommendation "Move the task to Review" (recommend
   mode, did not auto-move) — correct.

## Reject via gh + W4 divergence (the pass-8 feature)
7. `gh pr close 50` — closed the PR **out-of-band** while VIB-22 was still non-terminal (impl).
8. **Reconciled** in the app (GitHub page → Reconcile). Result:
   - `pr_json.state` → **closed** (reconcile picked up the out-of-band close).
   - Timeline position 0, typed `policy` event: **"Divergence: PR #50 was closed on GitHub without
     merging, but VIB-22 is still active. Decide whether to rework and reopen, or archive the task."**
   - **No auto-advance** — VIB-22 stayed at impl (W4 never moves the task itself).
   - Audit `github.reconcile.task` recorded.
9. Deleted the rejected remote branch `vib-22` (no merge happened → repo/main untouched).

## Verdict
Every step behaved correctly and matched intent: operator coordination, agent selection, skill
loading→application, real PR delivery, and the W4 divergence event on an out-of-band reject. This is
the live end-to-end validation of the governed-delivery loop AND of the pass-8 W4 code, on the app's
own repo. (VIB-22 left on the board as a divergence-demo artifact, like the other VIB test tasks.)
