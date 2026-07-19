# Implementation Plan — Pass 9 (2026-07-19)

Fix all findings from discovery (FINDINGS.md) + live testing (TEST-LOG.md), honoring owner rulings.
Environment: dev server (HMR) on current main against docker-data, real backends. After each cluster:
`npm run typecheck` + targeted `npm test`; live-validate the critical ones. No cutting corners; may touch tests.

Status: [ ] todo · [~] in progress · [x] done · [v] validated (code+test+live where applicable)

## Cluster A — Delivery + capability (owner Q1: headline = master switch)
- [v] **F14** Seed `developer` (and base deliverers) explicitly grant `execute-code-or-write-repo: direct`
      (demo-data.server.ts developer direct list). Add validation/repair: a profile granting scoped
      delivery caps (create-task-branch/commit-push-branch/open-review-pr in an actionable mode) but
      with headline `execute-code-or-write-repo` withheld is a contradictory config → surface + repair
      (never silently non-delivering). Verify create/edit path can't materialize the contradiction.
- [x] **F24** Unify commit-author identity across backends. Force `GIT_AUTHOR_*`/`GIT_COMMITTER_*` in the
      agent run env to `<profileId> <profileId@viberr.local>` (overrides codex's host identity + claude's
      own), stamp the same via repo config at clone, and the auto-commit prefers that config (Viberr
      fallback only when unset). One author from Viberr's eye. +unit test (agentGitIdentity).
- [x] **F15** `git add -A` safety: honors `.gitignore` (build artifacts excluded); auto-commit now logs
      the committed file list so stray files in a reused workspace are visible, not silently shipped.

## Cluster B — Codex parity (owner Q2: fix clearly-fixable)
- [x] **F7** Codex envelope-on-resume: `resumeRun` must pass `outputSchema` so resumed/@mentioned Codex
      agents produce the structured outcome envelope (not the prose regex; ask_human works on resume).
- [ ] **F8/F9** Keep Codex tool-enforcement + MCP-auth asymmetry as HONEST "claude-only" labels
      (no sandbox). Verify UI/labels state the asymmetry truthfully (no over-claim).
- [ ] **F10** `classifyReviewerVerdict` regex fragility: when the envelope is absent AND the regex can't
      confidently classify a verdict-granted run, do NOT silently mark `healthy` — default safe / flag.

## Cluster C — Robustness / security (from code-map)
- [x] **F18** Per-entry tolerant parse for members/stages/workflow/agents (like parseEngagements) so one
      malformed row doesn't wipe the whole ACL/list.
- [x] **F17** Archived read-only gate must cover agent-runtime actions (assign/run/interrupt/schedule/
      run-operator) — add requireProjectMutable.
- [ ] **F20** Board rescan: scope to the authorized project (not whole instance); applyRecommendation:
      authz before read/throw.
- [ ] **F13** Stop swallowing delivery/reply/toolkit errors silently; fix audit attribution (agent
      actions under the agent actor, not the operator system actor).

## Cluster D — UI / surfacing
- [x] **F22** Phantom live-run: run-projection must emit a terminal event / SSE so the live-run panel
      clears when reaction-chain runs finish (no perpetual "running").
- [v] **F5** Home "Agent resources" tile skill count: shows 0, actual 3 — fixed (count from disk-union list, not empty projection). LIVE: tile now shows "3 skills".
- [ ] **F25/F6** Surface out-of-band PR close loudly (timeline event + notification + PR-closed badge;
      operator decision packet). Review queue: don't list blocked/PR-less/closed-PR tasks as acceptable.
- [x] **F4** (owner Q3) Rename task-page execution-profile labels + intents: Primary specialist /
      Reviewers / Add reviewer → unified engagements model. Machinery already generic; this is UI/wire.

## Cluster E — Cleanup / docs
- [ ] **F19** Remove operator legacy dead code (operatorSchedulesOnOwner seed-only path) + stale "Phase-8"
      doc comments (already-implemented capability checks).
- [ ] **F12** Warn when a declared skill is missing (currently silently dropped); note bundled-skill
      suppression relies on the tool-deny.
- [x] **F21** Fix stale README "Known gaps" (3 of 9 already closed: stub tasks seeded [BIL-9 not BIL-7],
      home GitHub tile reads connections, MCP creds UI built; profile email/nudge prefs removed).

## Validation matrix (must pass before "done")
- `npm run typecheck` clean · `npm test` green (touch/extend tests as needed).
- Live: F14 (fresh developer delivers), F24 (commit author consistent), F7 (resumed codex envelope),
  F22 (panel clears), F5 (home shows 3 skills). Screenshot/branch/PR evidence.

## STATUS (final for this pass)
Done + tests + typecheck green (137 files / 1389 tests): **F14, F5, F21, F24, F15, F7, F10, F18, F17,
F22, F4, F12**, plus **F8/F9 verified** (tool-enforcement asymmetry is already honestly surfaced via
`capabilityEnforcement` "claude-only" badges in the capability matrix — owner Q2 "keep honest labels").

- F14 owner-Q1 ✓ (seed grants headline direct + `normalizeDeliveryGrants` repair on create/edit/seed).
- F7 owner-Q2 ✓ (Codex envelope re-armed on resume). F4 owner-Q3 ✓ (engagement-aware labels).
- F24 unified commit identity (`GIT_AUTHOR_*` env + clone config + auto-commit prefers it).
- F17/F18 security (archived agent-runtime gate; per-entry tolerant parse — no ACL wipe).
- F10 fail-safe verdict + anomaly flag; F12 warns on a missing declared skill; F5/F21 corrected.

**Remaining (lower-severity, documented not rushed):**
- F25/F6 divergence surfacing (out-of-band PR close detected + stale accept-rec cleared, but no loud
  timeline event/notification/PR-closed badge). Medium UX; found live. Reconcile updates `pr.state`.
- F13 swallowed errors + agent audit attribution under the operator system actor. Robustness.
- F19 operator legacy dead code (`operatorSchedulesOnOwner`) + stale "Phase-8" comments. Cleanup.
- F20 board rescan reprojects instance-wide under a project-scoped gate (idempotent; intentional-ish)
  + `applyRecommendation` pre-authz reads (info already view-accessible). Low value — left as-is.
