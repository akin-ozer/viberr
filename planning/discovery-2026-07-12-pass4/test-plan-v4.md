# Pass 4 — live test plan (draft; cases numbered T1…)

Method (proven in passes 2–3, `prior-canon.md` §6): fresh selftest project on repo
`akin-ozer/viberr` via the PRODUCT paths; no PAT in the app (honest slate) — delivery is
agent-side `gh`; I merge/close PRs with host `gh`. Tiny marker-file PRs only (test-support/
selftest5/*.md). RBAC probes via curl + per-user cookie jars + `_csrf`. Restart dev server
before runtime tests (HMR trap #4). Verify host repo stays on its own branch after every
delivery (trap #5). Check run rows for `simulated` flag before trusting evidence (trap #21).

Projects:
- **selftest-5** (VS5): Standard 5-stage, Balanced preset, repo akin-ozer/viberr → main PR flows.
- **lite-probe** (LP): Lightweight 3-stage, repo-less → stage-role + review-queue drift probes.

Roles fixture (same as prior passes): arda=admin, elif=maintainer, murat=contributor,
selin=viewer, deniz=non-member.

## A. Project / agent setup
- T1: Create selftest-5 via New-project modal (Standard, Balanced, repo bound). Verify board,
  base agents auto-deployed (operator+Developer+Reviewer), policy defaults match preset.
- T2: Create lite-probe (Lightweight, repo-less). Verify 3 stages, review-queue rail badge vs
  /review page contents (expected drift — HIGH finding), honest no-repo GitHub page.
- T3: Create a NEW custom agent profile (e.g. "Docs Writer", Claude, stages=[impl] only,
  skills=[conventional-commits], no KB) via New specialist profile; deploy to selftest-5;
  verify on-disk profile file + roster + capability defaults (restrictive per #37).
- T4: Create a second custom agent ("Test Engineer", stages=[review], spanAll=false) to give
  the operator a real choice; verify eligible-stage chips in UI.

## B. Task lifecycle / stage transitions
- T5: Create task in Triage with underspecified goal → triage quality gate flags input_required;
  operator packet or readiness flag appears.
- T6: Create task directly in Ready with concrete goal → operator auto-invoke on creation
  outside triage; verify operator comment + specialist recommendation/assignment (Balanced =
  supervised → recommendation cards, not direct assignment).
- T7: Manual transition Ready→In Progress as maintainer (elif) → allowed (approve-transition);
  as contributor (murat) → 403; as viewer (selin) → 403. (RBAC matrix rows live.)
- T8: Auto boundary triage→ready (governed template): any member can move; verify boundary
  semantics + operator attach on leaving entry stage.
- T9: Human move INTO Done routes through acceptCompletion (accept contract, not bare write) —
  verify honest toast (no fake merge claim), task.md pr.state.
- T10: Operator can never bare-transition to Done: full-autonomy operator without explicit
  completion-for-acceptance:direct must open packet instead.

## C. Ownership / assignments
- T11: murat (contributor) takes ownership (own-task) then releases own; selin (viewer) take →
  403 (Q5 clean tiering). elif assigns owner to murat (owner-assign allowed for admin/owner
  paths per matrix); release-any by elif → 403 (admin-only), by arda → ok.
- T12: Assign primary specialist (Developer/Claude) + verify stage eligibility enforcement:
  assign Docs Writer (stages=[impl]) while task in Ready → server rejects (assign boundary);
  move to In Progress → assign succeeds (both boundaries, trap #15).
- T13: Secondary assignment = add Reviewer + a second reviewer (Docs Writer as reviewer if
  eligible) — idempotent re-engage, remove-reviewer.

## D. Runs / operator / agents
- T14: Run specialist (Claude real) on a tiny marker-file task → verify: workspace clone cwd,
  GIT_CEILING confinement (init envelope), branch vs5-N-<slug>, [VS5-N] commit prefix, PR
  opened via agent gh with task back-link; workspace-delivery reconciliation records
  branch/PR on task.md; host checkout untouched.
- T15: Reviewer run → verdict classification (healthy/failing) from FULL reply; quality event
  + notification; A3 approve-after-rework clears failing.
- T16: Operator react loop: agent reply → operator re-invoke (depth cap 4) → ends
  waiting=human; no duplicate operator comments (guardrails); single-flight lease (fire two
  triggers quickly; verify queued-not-dropped).
- T17: @mention comment routing: @operator (runs operator with humanComment), @Developer
  resume (session reuse, same clone workdir) — CHECK init envelope of resumed run for
  disallowedTools/env/MCP (expected MISSING — HIGH finding to confirm live), reply lands as
  agent comment; viewer @mention records comment but runtimeDenied (no run).
- T18: Codex specialist run (quota-dead) → error path: F8 typed blocked event, quota-aware
  copy, stuck packet, quality notification, waiting→human; D4 retry-on-other-backend switches
  to Claude and works. (Codex/Claude parity from viberr's eye: identical lifecycle rows,
  labels, audit.)
- T19: Interrupt a running Claude run (admin) → interrupted state + audit; viewer interrupt →
  403; verify SSE run.state-changed.
- T20: Skill isolation: Docs Writer declares ONLY conventional-commits → init envelope skills
  list contains exactly that (+ no host skills; settingSources/plugins empty). Developer with
  no skills → none. (F13 parent-session leak is known dev-only noise — ignore leaked parent
  tools, check declared skills exactly.)
- T21: KB injection: attach a KB to Docs Writer, verify persona carries KB body under 24k
  budget with truncation marker if oversized.
- T22: MCP: add an org MCP server (stdio echo/everything server), attach to Docs Writer,
  verify mcp health probe (initialize+tools/list), run carries mcpServers config (Claude), and
  document the secret:// cred non-injection gap live.

## E. Packets / recommendations / review queue
- T23: Supervised operator produces recommendation cards (assign/run/transition) → apply one
  as maintainer (executes under human RBAC), dismiss another; stale recs auto-clear on manual
  assignment.
- T24: Decision packet resolve rules: owner (contributor murat) resolves non-completion packet;
  viewer selin → 403; accept_completion option re-gates to maintainer+ and REFUSES while
  validation failing (C2).
- T25: Review queue: task enters Review → PR auto-open attempt (no PAT → typed degraded, but
  agent-side PR already exists → findPrForBranch links it); accept completion in queue →
  "accepted, merge pending" (no PAT) + Complete-merge button after I merge via gh? (S2 flow:
  merge PR with gh, reconcile, verify state=merged; separately close one PR unmerged →
  state=closed + reject-flow copy.)
- T26: Evidence-changed marker: push an extra commit to a PR branch after acceptance-eligible
  state → "evidence changed" chip (seen on VIB-142 seed; verify live equivalent) / validation
  reset to changed on re-entering review.

## F. RBAC / notifications / SSE
- T27: Members-only surfaces (review/agents/policy/github/activity/settings) as deniz
  (non-member) → 403 page; board/task detail readable (FR4) app-wide; SSE: deniz subscribing
  to selftest-5 project scope gets dropped/403; member gets events.
- T28: Policy page edit: set murat→maintainer (admin-only manage-members), last-admin guard
  (demote arda as sole admin → rejected), boundary edit review→done stays locked human.
- T29: Notification routing: disable packet notifications for elif in profile → packet created
  → no notification row for elif, others get one; bell counts + mark-all-read.
- T30: Audit log: every governed action above lands audit_events rows with correct actor
  (operator rows actor=null+label); Activity page streams match.

## G. Cross-cutting
- T31: Board reorder (drag rank) as maintainer ok / contributor 403; reorder into Done column
  = acceptance contract (T9 overlap, confirm).
- T32: Re-scan / reconcile buttons: project rescan (admin|maintainer), GitHub reconcile
  (member non-viewer) — degraded-but-ok toasts without PAT.
- T33: Session export: download resume script for a real run; verify it references the
  provider transcript.
- T34: Archive project (lite-probe at the end): hidden from home default, honest copy,
  data preserved on disk.

PR outcome matrix on akin-ozer/viberr: ≥2 agent PRs merged via gh (squash), ≥1 closed
unmerged (reject), 1 left open in review — then verify viberr reflects merged/closed/review
states after reconcile.
