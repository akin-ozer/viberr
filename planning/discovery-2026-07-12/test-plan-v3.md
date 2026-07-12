# Test plan v3 — live sweep on a fresh project (2026-07-12)

Project: **Viberr Selftest 4** (`viberr-selftest-4`), repo `akin-ozer/viberr`, created via the
product path. Real Claude backend (OAuth token), Codex via CLI auth (quota-limited in pass 2 —
cross-backend cases planned accordingly). No PAT in the app (credential slate stays honest; PR
work is agent-side `gh`, merges/closes done by me with `gh`). Members: arda=admin (creator),
elif=maintainer, murat=contributor, selin=viewer, deniz=non-member.

Cases marked ⚑ are **before/after probes**: they document current behavior that phase 3 changes
(rulings R-1..R-4 + findings), and get re-run post-implementation.

## A. Operator flow
- **T01** well-scoped task → operator auto-advances Triage→Ready (auto boundary) + assigns eligible specialist.
- **T02** vague task ("Make the app better") → INPUT packet (observations + options), held at Triage, waiting=human.
- **T03** two rapid @operator mentions while a run is in flight → single-flight lease coalesces; no dropped mention, no duplicate run rows.
- **T04** packet resolve `request_edit` → waiting=agent + operator re-engages with the edit.
- **T05** supervised (recommend) stage-transition → recommendation CARD (not silent move); admin Apply executes it.
- **T06** operator brevity guardrail: force a long operator reply → comment ≤1000 chars, markdown-aware truncation; meaningful-comment: trivial comment ("ok") dropped from timeline.
- **T07** goal edit (admin) persists to task.md + re-engages operator. ⚑ contributor goal-edit denied now (admin|maint) — stays denied after rework (matrix source).

## B. Delivery / GitHub (the repo-under-test is viberr itself)
- **T08** Claude specialist run: isolated workspace (`cwd=<taskDir>/workspace`, GIT_CEILING), branch `vs4-…`, small test-marker file, commits, PR opened agent-side via gh; `reconcileWorkspaceDelivery` captures branch/PR into task.md; host checkout untouched.
- **T09** `gh pr merge --squash` outside the app → app reflects merged (agent-side reconcile path since no PAT).
- **T10** second PR `gh pr close` → app reflects closed; task returns to rework honestly (no laundering to healthy).
- **T11** manual dropdown transition to Done with no PR → honest "no linked pull request" completion event; H4 (human INTO last stage routes through acceptCompletion).
- **T12** review-entry effects: validation=changed on entering Review; no fake PR when credential-less.
- **T13** cross-backend `backendOverride` retry on one task (codex→claude if quota persists) → model re-resolved for the run backend; run row shows real backend.

## C. RBAC (multi-user, ⚑ several flip after rework)
- **T14** ⚑ viewer (selin): CURRENT — can take ownership; owner-viewer resolve buttons for non-completion packets. AFTER — viewer read+comment only.
- **T15** non-member (deniz): comment posts (visibly labeled), @operator posts but NO run triggered (valve); no Assign-me.
- **T16** contributor (murat): create-task allowed; manual transition denied; @mention run trigger denied (runtimeDenied toast) — stays denied after (runtime trigger remains admin|maint).
- **T17** home scoping: selin sees only her projects; arda (org admin) sees all; ⚑ review/activity pages readable by non-member NOW → 403/redirect AFTER (R-3).
- **T18** ⚑ SSE: non-member subscribes `scope=project:viberr-selftest-4` directly — receives events NOW (R2) → denied AFTER.
- **T19** packet accept_completion option disabled for owner-only (non-admin/maint) resolver; admin sees it enabled.
- **T20** last-admin guard: demoting the only admin fails; review→done boundary locked to human in policy UI.

## D. Agents / resources / runtimes
- **T21** skills isolation: specialist with exactly one declared skill → run init shows only that skill content in persona; `settingSources:[]`, `skills:[]` (no host leak); mcp servers `[]` (honest slate).
- **T22** KB injection: nested + non-.md docs injected (6/6 for api-contracts-style KB); per-KB 24k truncation marker on an oversized doc (documents F9).
- **T23** ⚑ stage eligibility: assign a specialist to a task in a stage OUTSIDE its eligible list — succeeds NOW (F1) → validated/filtered AFTER (R-2).
- **T24** reviewer verdict pipeline: reviewer "Verdict: request changes" → validation=failing + quality event + owner notification; rework commit → re-review "Verdict: approve" → healthy (negation-aware classifier, H2 on every completion path).
- **T25** failing-validation guards: operator full-autonomy accept REFUSES failing task (H3); review re-entry does not launder failing.
- **T26** codex/claude parity: same profile on both backends — persona delivery (systemPrompt vs folded prompt), capability denial (Claude disallowedTools vs Codex advisory) — evidence for S3 labeling (R-4).
- **T27** interrupt: admin interrupts a live run → run state interrupted, task waiting recovers (no stuck waiting=agent).
- **T28** orphaned-notification probe (F2): after deleting a scratch project, its notifications dead-end → fixed by cascade in phase 3.

Results land in `test-results-v3.md` with per-case verdict + evidence.
