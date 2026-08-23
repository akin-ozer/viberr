# Pass 25 — live use-case log

Project under test: **Viberr QA 25** (slug `viberr-qa-25`, key `VQ`), repo `akin-ozer/viberr`, Balanced policy (operator supervised). Created live this pass.
Other projects available for non-PR experiments: Viberr (VIB), Viberr QA Lab (VQL), Viberr Strict (VS).

Goal: ≥20 use cases exercising user assignments, stage transitions, reviewers, secondary assignments, comments, @mentions, RBAC, operator behavior, agents doing real work, MCPs, skills, Codex/Claude parity, browser cap. Real PRs on akin-ozer/viberr (merge some via gh, reject some).

Legend: ⏳ running · ✅ pass · ⚠️ issue found (→ FINDINGS.md) · ❌ fail

---

## UC-1 [✅] Full lifecycle on Claude → real PR → human accept/merge
- VQ-1 "Add pass-25 QA canary note". Operator auto-invoked → scoped → auto Triage→Ready→In Progress →
  engaged **Developer (Claude)** as delivering agent → implemented `qa/pass25-canary.md` (+1/-0), committed
  `17a4708`, delivered **real PR #203** (vq-1→main) → Viberr recorded "Move to Review" recommendation → I
  applied it → operator engaged **Reviewer** → clean verdict (**validation healthy**) → recommended accept →
  I accepted via ceremony (MERGES PR#203/REVISION/VERDICT disclosed) → **real merge into main** (commit
  f97ea488) → task **Done**, GitHub "merged". Traceability task→branch→commit→PR all correct. Flawless.

## UC-12 [✅] Operator picks the right agent from the goal
- VQ-2 goal hinted "Deliver using the Codex Dev agent" → operator assigned **Codex Dev** as delivering agent. Correct.

## UC-2 [✅ partial — Codex quota-blocked] Codex parity delivery
- VQ-2 assigned Codex Dev → **Codex over quota until Sep 18, 2026** → run failed → operator raised a clean
  blocked-decision packet with the provider message + 5 recovery paths. Live Codex delivery not possible this
  pass (external constraint). Re-solved with "Retry on Claude" → backend switched (sonnet) → delivered **PR #204**
  (+1/-0 `qa/pass25-codex-canary.md`, incl. a "merge main into vq-2" commit to stay current). Live-reproduces
  backlog **B2** (no pre-run quota signal). Parity at CODE level covered by PARITY-CAPABILITY-AUDIT.md.

## UC-3 / UC-4 [✅] Reject a PR out-of-band via gh → reconcile surfaces it
- Closed **PR #204** via `gh pr close` (kept branch). Viberr's poller lag ~5min, so I used Repository →
  "Update status" → PR flipped to **closed**; toast "Every branch and PR maps to its task key." VQ-2 task then:
  Current state "Acceptance is closed. VQ-2's review PR was closed on GitHub without merging… Rework and reopen,
  or archive." + operator auto-raised a **"PR #204 closed without merging — choose a recovery path"** decision
  packet (Rework and reopen / archive / reopen-on-GitHub-auto-detected). Honest, correct, matches pass-24 VQL-2.

## Discovery-round verified use cases (live on the rebuilt container)
- **UC-13 [✅] KB authoring** — created KB "Pass-25 QA conventions" (Instance settings → Agent resources → New);
  `store://kb/pass-25-qa-conventions/ · 0 docs · agents read the live folder · re-scanned just now`. Honest copy
  ("controls the doc count and freshness stamp only … Every run loads the live folder either way").
- **UC-14 [✅] MCP honest disclosure** — the org registry shows `test-mcp` (HTTP localhost:9999) as
  **unreachable · connection refused** with a red dot, not falsely healthy. (A credentialed server would also
  carry the new F-P3 "Claude runs only · Codex mounts unauthenticated" caveat.)
- **UC-15 [✅] Skills scoped per-agent** — from run data: Developer loads only `developer-expertise`, Reviewer only
  `reviewer-expertise`, operator only `viberr-app-expertise` — no unrelated/host skills leak (the pass-13 hazard).
- **UC-16 [✅] Browser capability** — VIB-4: the Developer opened example.com live, reported the h1, attached a
  browser snapshot `.yml`, made no repo changes (browser-only scope honored).
- **UC-17 [✅] Agent profile creation** — created the Codex Dev profile (backend/model/effort/stages/persona/
  capability policy; "ADVISORY ON CODEX" tags shown for a Codex profile — B1).
- **UC-18 [✅] Admin password reset (RBAC action)** — reset member Bora's password → one-time temp shown, "password
  reset pending" pill, forced set-new-password on next sign-in.
- **UC-19 [✅] Search palette** — ⌘K cross-project task search ("canary" → VQ-2/VQ-1/VQL-1 with project labels).
- **UC-20 [✅] Notifications routing** — 8 decisions authoritative vs 9 unread rows (D-3); per-user routing toggles.
- **UC-21 [✅] Strict vs Balanced autonomy** — VS-1 (Strict) shows an operator RECOMMEND for Triage→Ready (human
  approval), whereas Balanced (VQ-1/VQ-2) auto-advanced pre-work boundaries.
- **UC-22 [✅] Review queue / Activity / GitHub / Profile / SSO surfaces** — all render coherently with honest
  empty/health states (documented in UI-WALKTHROUGH.md).

## Planned
- UC-2 Codex parity: same shape task on Codex Dev backend; compare to UC-1.
- UC-3 Reject path: request-changes / reject a delivered PR; verify board + reconcile.
- UC-4 Out-of-band merge via `gh`; verify reconcile-poller surfaces it in Viberr.
- UC-5 Underspecified task → operator raises scoping/decision packet at triage.
- UC-6 RBAC: member (non-admin) blocked from admin-only actions (403 + honest UI).
- UC-7 Task ownership: take/release; owner acceptance authority.
- UC-8 Reviewer (verdict-capable) summoned; approve/request-changes verdict gating.
- UC-9 Secondary/supporting agent engagement + @mention routing to agents.
- UC-10 Comments: @operator, @agent, @teammate; cross-project comment labeling.
- UC-11 Stage transitions under Strict project (human-gate) vs Balanced.
- UC-12 Operator agent selection: does it pick the right specialist/skill for the goal?
- UC-13 MCP: add server to a profile, run, verify tools load (Codex hyphen→underscore).
- UC-14 Skills: verify only related skills load (not unrelated ones).
- UC-15 Browser cap: agent drives live browser, attaches evidence (already seen on VIB-4).
- UC-16 Knowledge base: create KB, grant to profile, verify agent uses it.
- UC-17 Schedule a re-run; verify it fires.
- UC-18 Force-accept path + confirmation ceremony honesty.
- UC-19 "Completed — no changes" path (verification-only task).
- UC-20 Full-autonomy operator acceptance (separate project/policy).
- UC-21+ notifications, search, activity feed, diagnostics.
