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

## Validation protocol (end of each workstream)
1. Unit + typecheck green.
2. Canary: revert the fix locally → the new test must fail.
3. Live proof on dev-root instance (Playwright), screenshot into `shots/fixes/`.
4. End of pass: rebuild compose, full e2e, re-run the F15 repros against the container, verify every ledger row flipped with evidence. **Audit every ledger id against `git diff` (`grep -c` per id) — no bulk DONE.**
