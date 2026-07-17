# Findings ledger — pass 8 (2026-07-17)

Working base: main @ 8041134 (PR #34). Fresh-eyes pass after pass-7 closed everything.
Severity: HIGH (core flow / data-integrity / owner-ruled gap) · MED (wrong or misleading) · LOW (polish/debt).
Status: OPEN / CONFIRMED / RULED / WONTFIX. Every OPEN item must be closed or ruled in implementation.

## Environment / blockers
- **B1 · BLOCKER — viberr's stored GitHub PAT is REVOKED.** Project → GitHub shows "token revoked";
  org settings shows an "Update token" affordance. Agent-driven delivery (push branch → open PR →
  merge) will fail until the owner re-authenticates the connection. `gh` CLI is separately authed
  (akin-ozer, repo/workflow/read:org) so I can merge/reject PRs manually and read the repo, but the
  agent push path is dead. **Needs owner to update the token** (I can't enter credentials). Gates the
  "open PRs against viberr" testing; non-GitHub flows (operator/specialist/RBAC/skills/MCP/comments/
  transitions) are fully testable without it.
- **B2 · MED — org MCP `notes-fixture` points at a dead path.** stdio cmd references a *previous*
  session's scratchpad (`.../72cd9952-.../scratchpad/notes-mcp-server.mjs`); that file no longer exists,
  so a real specialist run that loads it will fail to spawn. Need a live MCP fixture for MCP tests.
- **B3 · NOTE — CODEX_HOME=/Users/akinozer/.codex (owner's real personal codex home).** README warns a
  dedicated codex-home avoids importing personal config/MCP/skills. Codex runs may load host skills/MCPs.
  Test: does viberr isolate codex skill/MCP loading or leak the host setup? Deliberate local-dev choice.

## Discovery findings (fresh, this pass)

- **D1 · MED · CONFIRMED (data) — "Waiting on you" counters are incoherent across 3 surfaces.**
  Home headline "5 decisions", project cards viberr 3 + playground 2, Notifications overlay
  "Waiting on you · 4". Three different numbers for the same concept. Root: home/cards count
  PROJECT-level "decisions waiting on a human" (shown on every viewer's card regardless of membership —
  so Arda, a NON-member of Playground, sees Playground's "2 waiting on **you**"); the overlay counts
  Arda's routed packet/approval notifications. Neither equals "decisions requiring Arda's action."
  → Reconcile the counting + honest labeling (member vs org-admin-read visibility).
- **D2 · MED · CONFIRMED (data) — superseded packet notifications linger in "Waiting on you"
  (F7-NOTIF1 incompletely fixed).** VIB-4 has ONE open packet on disk ("disputes committed/pushed");
  the earlier packet ("commit denied", ntf_5p5cC0) is superseded and its notification is already
  `read`, yet the overlay still lists VIB-4 twice. The waiting-list must drop notifications whose
  packet is no longer the task's current open packet (dedupe by task/decision, key off live task
  state not the notifications row). Verify in code (notifications projection / waiting-list query).
- **D3 · QUESTION/MED — GitHub↔task state divergence on out-of-band merge.** VIB-5: PR #31 shows
  `merged` on the GitHub card, but the task is stuck Review/blocked (never accepted through Viberr).
  VIB-3: PR #30 `closed` (rejected on GitHub) but task still In Progress/ready. Viberr's canon is
  files-not-GitHub, so this may be "expected" — but a "PR merged, task not Done" divergence is
  confusing and the reconcile doesn't surface it. Owner decision: should reconcile flag/close the loop?
- **D4 · MED — Style Reviewer profile shows 0 direct / 0 recommend / 0 human capabilities.** Policy
  → Agent capability lists Style Reviewer with all-zero counts — a profile that can do nothing. Either
  a real gap (misconfigured profile) or a display bug. Chase in code + create a task that routes to it.
- **D5 · LOW — "threads waiting on a human" (Agents=6) vs "decisions waiting on you" (home=5).**
  Different scoping likely legitimate, but worth confirming the two counts have documented meanings.

## Historical residue (NOT current bugs — pass-7 phase-2 data left on disk; re-test fresh)
- VIB-5 quality event literally reads "Validation: failing. Reviewer approved the work" (the F7-REV3
  contradiction). This is yesterday's pre-fix data. Re-test with a fresh review to confirm F7-REV3 holds.
- VIB-5 timeline has an injected "Elif Demir" comment the operator CORRECTLY refused (good governance
  evidence — the operator's blocked packet reasoning is genuinely strong).
- VIB-4's two packets are the residue of a real operator/human dispute (F7-PKT1 scenario) — good data.

## Live RBAC evidence (for R8-2 rework)
- **T14 Viewer (Selin) ✅** board: no "New task", no "Re-scan"; task detail: NO mutation controls (recommendation
  shown WITHOUT Apply/Dismiss, no Run/transition/accept/edit) — only "Open on GitHub"; comment composer PRESENT
  ("Add a comment… type @…"), role=Viewer, "Comments: Every registered user". UI faithfully mirrors the matrix.
  BUT board "Waiting on me · 3" chip still shows 3 for a viewer who can act on NONE of them → R8-3 evidence.
- **T17 Org-admin override ✅** (see test-catalog) — audited `project.org_admin.override`, mutation allowed.

## D4 refined (Style Reviewer 0/0/0) — subagent code verdict
- NOT a display-derivation bug and NOT incidental: `data/projects/viberr/project.md:161-163` stores the profile with
  `capabilities: []`; counter `agents-query.server.ts:88-106` faithfully renders 0/0/0. It works BY DESIGN — a
  read-only reviewer needs zero GATED caps (read-diff + report-verdict have no write side-effects). Fix = a
  "read-only · no gated capabilities" affordance when all buckets empty (`policy-page.tsx:237-250`,
  `agents-page.tsx:334-335`), NOT re-seeding grants.
- **D4b · MED (honesty) — seed profiles carry DECORATIVE "fake toggle" advisory caps** (`capability-catalog.ts:37-47`:
  read-repo-diff, post-quality-flags…) that inflate the "N direct" counts with ZERO runtime effect. Reviewer shows
  "8 direct" partly from these + 2 recommend→direct coercions (R7-5). Candidate for the capability-honesty rework:
  either make advisory caps do something or stop counting them as capabilities.
- **F7-REV3 re-verified prevented** (`task-actions.server.ts:1480-1541`): "Review passed" title only in the else
  branch reachable when validation resolves `healthy`; can't coexist with `validation=failing`. VIB-5's contradictory
  event is confirmed pre-fix historical residue.

## Positive confirmations (working well)
- Operator reasoning on VIB-5 (self-contradictory review + unverified-identity comment) is excellent.
- RBAC Policy surface is honest + thorough post-R7-1 (13-action matrix, footnote explains every asymmetry).
- Both backends detect `real`; single-flight, no-simulation, boot-recovery-cap all confirmed in code (subagent).
- Design polish is strong across every surface (cards, avatars, progress, live log stream).
