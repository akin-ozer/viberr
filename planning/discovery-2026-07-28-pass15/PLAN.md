# Pass 15 — Implementation plan

Branch: `pass15/product-fixes` off `main`. No migrations (edit `0001_baseline.sql` + one-off ALTER on live DB only if schema changes — per standing ruling). Breaking changes allowed; tests may be rewritten. Every item lands with: code + test that FAILS against old behavior + ledger flip in FINDINGS.md.

## Environments
- Fast loop: host dev server on a THROWAWAY data root (`VIBERR_DATA_ROOT=./data-dev`, never docker-data — single-writer rule) + unit/typecheck.
- Acceptance: rebuild compose image, re-verify key flows on the real docker-data instance via Playwright + screenshots.
- Gates: `npm run typecheck` (tsc is REQUIRED — build ≠ typecheck), `npm test`, `npm run build`, e2e (playwright), live UI proof for UX items.

## Workstreams (order = risk & dependency)

### W1 — Delivery & review integrity (C/H cluster) 
F15-15 (non-FF collision → honest failure, no stale-head PR, PR-head-bound review/acceptance), F15-17 (delivery/review binding ruling + visible no-delivery signal), B-GH1, F15-19 (verdict-gated human acceptance per ruling + feedback), B-WF1 (in-lock re-check), F15-13 (already-merged honesty), F15-02 (sync freshness truth + Update-status feedback), B-WF4 (single stage-role resolver), B-GH4.

### W2 — Profiles & capability truth
F15-05/06 (detail-panel derivation from stored grants; org resource count), B-AG1 (save-time off→direct escalation + audit), B-AG2 (@backend handle ambiguity), B-AG4 (per ruling), B-AG6 (tying test), B-AG3, B-AG5.

### W3 — Operator quality
F15-14 (triage-gate doctrine hardening in operator.definition.md + seed/live-store refresh mechanism = B-OP1 hash-refresh), B-OP2 (preserve humanComment triggers), B-OP3 (cross-boot stranded resume), B-WF3 (schedule note/identity into directive), B-WF6 (share acceptance path), B-OP4/5.

### W4 — Credentials & GitHub hygiene
F15-01 (probe-at-attach for project creation + assumed-state honesty in card), B-GH2 (workflow copy), B-GH3 (owner-matched rebind), B-GH5 (reconcile cap), B-GH6, B-GH7 (periodic revalidate), B-GH8.

### W5 — Foundation & guardrails
B-FD1 (data-root writer lock at boot), B-FD2 (mention disambiguation), B-FD5 (waiting-on-you union on home/bell + input_required), B-FD7 (interrupt/finalize race), B-FD8 (honest toolkit results + mention-before-trim + drop audit parity), B-FD9/10, F15-03 (watcher race check), B-FD3/B-FD4 (per ruling).

### W6 — UX coherence sweep
F15-04 (navigate to new project), F15-08 (one timezone), F15-09 (single badge), F15-11 (closed-task controls), F15-12 (per-kind rec gating + surfaced refusals), F15-16 (search copy or palette per ruling), F15-18 (mobile sidebar collapse), B-FD6, stage-move note field (UX gap from UC-18), supporting-agents panel label (UC-13 nit), "New stage" add-flow (commits immediately — make it name-first), timeline "no validation"/"0 docs agents read" copy nits.

### W7 — Docs
C-D1..C-D5 + amend PRD/decisions.md per new rulings from this pass.

## W1 design (binding for the implementation stream) — R15-1/R15-2

**New operator capability `deliver-review-pr`** in the operator capability set (catalog + `operator.profile.md` template: mode `direct` in the shipped template; Strict preset maps it to `recommend`; label "Deliver the branch & open the review PR"). Policy/Agents pages pick it up from the catalog automatically.

**New operator tool `deliver_for_review`** (Claude toolkit + Codex plan mirror): executes the refactored shared `performDelivery(db, ctx, slug, key, actor)` = today's `openReviewPrBestEffort` core (push workspace → reconcile revision → open/reuse PR) made synchronous-with-result for the tool. `gate("deliver-review-pr")`: `recommend` → posts a new recommendation kind `delivery` ("Deliver branch & open review PR") which `applyRecommendation` executes under the human's RBAC; `direct` → performs and narrates. Tool result reports push status + PR number honestly (incl. `push_conflict`).

**Old hook**: `transitionStage`'s `reviewStageId` auto-call is DELETED. Replacement safety nets: (a) entering the structural review-ROLE stage with no live PR writes a typed `github` event "Review reached — no PR yet; the operator decides delivery" (never silent); (b) task-detail GitHub panel gains a human "Deliver branch & open PR" button (maintainer+ or task owner) calling `performDelivery` directly (audited `github.delivery.manual`).

**Operator doctrine** (turn instruction in operator-run.server.ts + delivery block in operator.definition.md): deliver when the work is committed and plausible for review; weigh the REMAINING stages (later stages like QA may not need to gate delivery for this task — offer early delivery when so); open a decision packet when unsure whether to push; never instruct specialists to push/PR (unchanged).

**R15-1 acceptance gate** in the human `acceptCompletion` path: refuse (with rendered `blockReason`, never silent) unless (1) a PR exists, (2) the PR head SHA contains/equals the delivered `workRevision`, (3) the latest verdict on that revision is approve/healthy. In-lock re-check after the merge await (B-WF1). Confirm dialog (new, useDialog pattern) before accept AND force-accept: PR #, head sha, verdict state, target branch. Force-accept (admin, audited) bypasses ONLY missing/failed verdict + blocked packets — never the PR-head-mismatch check. `operatorAcceptCompletion` reuses the same core (B-WF6).

**F15-15 non-FF (B-GH1)**: `pushWorkspaceBranch` distinguishes `push_conflict` (non-fast-forward: remote head not an ancestor of local HEAD) from `push_failed`; conflict copy names the divergence (never credentials); `openTaskPr`/`performDelivery` REFUSES to open a PR whose head ≠ local delivered commit after a failed/conflicted push — opens the operator recovery path (packet: force-push-with-lease / archive) instead. Reviewer prompt pins the PR head SHA (review the pushed revision, not the local tree).

**Stage-role resolver (B-WF4)**: one exported structural resolver (review role, terminal) used by review queue, schedule, operatorAccept, acceptance-graph — delete the positional duplicates.

## Validation protocol (end of each workstream)
1. Unit + typecheck green.
2. Canary: revert the fix locally → the new test must fail.
3. Live proof on dev-root instance (Playwright), screenshot into `shots/fixes/`.
4. End of pass: rebuild compose, full e2e, re-run the F15 repros against the container, verify every ledger row flipped with evidence. **Audit every ledger id against `git diff` (`grep -c` per id) — no bulk DONE.**
