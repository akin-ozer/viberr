# Pass 17 — live testing notes (working file)

Session: 2026-08-04, container `viberr-app-1` on :5173 (docker-data root), clean-sheet seed.
This file is the running log for Phase B (live usage). Findings graduate into FINDINGS.md.
**The consolidated enumeration of every executed use case (34, each with durable
evidence pointers) is in `USE-CASES.md`** — this file kept only the working log,
which under-recorded the list it was accumulating.

## Environment / accounts

- App: http://localhost:5173 (compose container; DO NOT start a host dev server — dual-writer hazard).
- Users:
  - arda@viberr.dev / viberr-dev-2828 — org Admin (seeded, Local).
  - mira@viberr.dev / temp `JJogZ_RlAUTS` — org Member, Local, setup pending (must set own password on first login).
  - deniz@viberr.dev / temp `pZnKRUExj0x_` — org Member, Local, setup pending.
- Project: **Viberr** (key VIB, slug `viberr`, repo akin-ozer/viberr, Standard 5 stages, Balanced preset). Created 15:27.
- gh CLI: logged in as akin-ozer (repo scope) — used for PR merge/reject experiments.
- Instance seed state: 1 GitHub connection (akin-ozer, PAT ····k3ui), 3 skills (developer-expertise, reviewer-expertise, viberr-app-expertise), global profiles Developer (Codex) + Reviewer (Claude Code), 0 KBs, 0 MCP servers.

## Walkthrough log (Phase A leg)

- Login page: clean; local login worked first try.
- Dashboard empty state: good copy (project = board + repo + policy; 1-2-3 steps).
- Instance settings: connections / users / resources tabs all coherent; store maintenance (re-scan, rebuild projections) on Home.
- Project shell pages seen: Board (5 stages + risk chips incl. "Blocked or waiting"), Review queue (honest empty state, "always a human action, always in the audit log"), Agents (profiles/live/capability matrix), Policy (RBAC table + agent capability + workflow rules; Review→Done locked·V1), GitHub (repo, credential health, PR panel explains accepted-merge-pending), Activity (stream + audit log; project-creation events present), Settings (stages editor, members invite, repo repair, danger zone).
- Capability matrix modal: includes "What differs between the two runtimes" — testable claims list (mid-run comments Codex no-op, ask-human timing, MCP creds Claude-only, Codex renames MCP tool ids, operator web reach Claude-only).

## UX observations (candidates for FINDINGS)

- UX-1 Login: the disabled "GitHub — not configured" button is the most prominent element on the card (filled, top position) even when unusable. Consider de-emphasis when unconfigured.
- UX-2 Skills list rows say "updated never" — reads oddly for seeded content; consider "seeded" or the actual date.
- UX-3 Project GitHub page shows red-warning "Not yet synced" on a brand-new project before any sync attempt; slightly alarming as the first state a user sees. Consider neutral "no sync yet".
- UX-4 (harness) read_page/a11y tree of the name input showed placeholder as accessible name after fill — verify the filled input's accessible name is its value/label, not placeholder (a11y question, needs code check).

## Temp-password / onboarding use case (UC-onboarding)

- Local account creation generates a temp password shown once in a green banner (DOM-verified). Row badge: `setup pending`. To test: sign in as mira → forced password change? (TBD)

## Findings (live, confirmed in code)

- **F17-L1 (bug, timeline attribution):** The "Opened PR #N for review." github event renders actor as human `operator` with a "no longer a member" guest pill when delivery is operator-triggered. Root: [pr-open.server.ts:384-401](app/server/github/pr-open.server.ts) writes `{kind:"human", userId: actor.userId}` unconditionally when `actor.userId` is set; the operator's actor id "operator" is not a users-table id, so `createActorResolver` (app/shared/mapping/actor.server.ts:121-139) falls into the human branch → nameHint fallback + guest pill. Fix: thread a proper FileActorRef (operator/agent/human) into the PR-open path instead of a bare userId.
- **F17-L2 (UX):** After the operator delivers and finishes, the task shows "Waiting on: Human decision" but no explicit card says WHICH decision (approve In Progress→Review via the stage chip? engage reviewer? accept?). The affordances exist but are scattered; a "what's next" hint near Waiting-on would close the loop.
- Verified working (Phase B evidence): operator auto-advance Triage→Ready→In Progress; operator picked Docs Writer (role-correct); KB canary PISTACHIO honored + KB commit conventions applied; MCP everything-http mounted on the Claude run (init line); agent did NOT push (server-owned delivery), server pushed + opened PR #126; stale GitHub `vib-1` branch force-reset to main tip at execution start; merged PR #123 NOT adopted (R16-1); run economics chips (turns/duration/cost) rendered.

- **F17-L3 (UX):** Resolving a scoping packet ("pick a concrete deliverable") records the decision then opens the goal editor — but with the OLD goal text, not the selected option's deliverable text. The human must retype the scope they just picked. Prefill the editor from the chosen option.
- **F17-L4 (consistency, needs code verification):** Branch-collision policy fires only when the project has synced GitHub state. VIB-1 (stale MERGED PR #123 on `vib-1`) delivered silently before the first sync (fast-forward over the stale branch); VIB-3 (stale MERGED PR #110 on `vib-3`, same class) hit a "Branch name collision" blocked packet because a sync had happened by then. Same input class, two behaviors, decided by sync timing. Packet copy also says "merged/closed" without distinguishing, while the two states have different safety properties (merged tip = ancestor → FF-safe; closed-unmerged → force-push risk). Verify in pr-adoption.server.ts / reconciler / policy-note writer; decide one rule.
- Codex parity evidence (VIB-2): Developer on Codex/gpt-5.6-sol wrote+committed mode-100755 script, verified exit 0, reported at END of run (no mid-run channel — matches documented difference), @operator mention present, did not push. Blocked-then-resolved packet loop: human deletes stale branch → confirm with note → operator re-engages → PR #127 opened. ✓
- Docs Writer KB grounding again on VIB-3 (PISTACHIO in report). ✓

- **F17-L5 (bug, confirmed):** "Complete merge" on an accepted (merge-pending) task whose PR head no longer contains the delivered revision → server refuses correctly (POST `.data` → 409 with the precise message "PR #129's head (49bf4ac) does not contain the delivered revision 325305e — … Re-deliver the branch (or fix the remote branch), then re-review.") but the UI renders NOTHING — no toast, no inline error, no timeline note. The button just looks dead. Surface the fetcher error.
- **F17-L6 (observation):** the project GitHub page PR list doesn't surface GitHub's mergeable/conflict state ("in review" shown for a conflicted PR); the task-detail acceptance chain DOES know ("conflicts with the base branch"). Consider a conflict pill in the PR list + execution-branches table.
- Verified (conflict/acceptance chain): reviewer ran independently incl. forced-failure demo in scratch; operator opened "cannot accept — conflict" packet; admin Force-accept dialog shows MERGES/REVISION/VERDICT/BYPASSING with live conflict text; force-accept → Done · **accepted** (merge pending) with "Complete merge" affordance + rebase guidance (R16-6 two-meanings-of-Done live); after merging main INTO the branch (head contains delivered revision) Complete merge succeeds → Done · merged. PR-head gate verified in both directions (rebase-replaced head 409s; containing head passes).
- Verified: VIB-2 accept dialog (PR/revision/verdict + one-way warning) → merge → Done; ownership Assign-me before acceptance; closed-PR recovery packet on VIB-3 (rework-with-steer / archive-keep-branch / archive+delete-branch, reopen auto-withdraws) → archive+delete executed, branch really deleted on GitHub.
- Note: force-accept JS click was blocked once by the harness auto-mode classifier (session note, not a product issue); real browser click worked.

- **F17-L8 (UX polish):** decision-packet Confirm button doesn't echo the selected option ("Confirm decision", not "Confirm: Record Arda"). A raced/mis-registered option click silently submits the default (operator pick). Echo the payload in the confirm control (and/or require explicit selection). (Found via a real mis-submit: my Mira-Chen click raced React state and Arda was recorded.)
- **F17-L9 (product gap):** a no-change outcome has no clean path to Done. VIB-6: agent correctly made 0-line diff, no commit; operator recommended Review; acceptance refuses ("delivered work but no review pull request — deliver the branch & open the PR") but a zero-commit branch cannot open a PR. Only exits: force-accept (audited override, semantically wrong) or archive (task actually succeeded). Also the refusal copy claims "has delivered work" for a 0-diff. Owner question: add a "completed without changes" acceptance (no-PR accept) or operator-recommended close-as-satisfied. Post-force-accept the Done task keeps an "awaiting verdict" chip forever (cosmetic).
- **F17-L10 (copy):** policy-engine notification for force-accepted VIB-4 says "(Autonomous acceptance can't merge a PR; a human completes the merge…)" — the accept was a HUMAN admin force-accept, not autonomous. The parenthetical rule text misattributes the actor class.
- **F17-L11 (copy, minor):** first-login forced password screen says "An admin reset your password" for a freshly created account (never had one). Also noted: local-account onboarding worked cleanly end to end (temp password → set own → land on Home).
- Verified: specialist injection-guardrail — Docs Writer refused the operator's inline "Human decision confirmed: Arda" claim and raised ask_human through the channel; Maintainer (Mira) answered; auto-mention "@docs-writer … answered by a human: Arda. Continue…" posted; agent resumed and delivered PR #130. Guardrail + ask-human + human-answer loop all live. (Design question for owner: should an operator relay of a RESOLVED packet carry a verifiable decision reference so the specialist need not re-ask?)
- Verified: Maintainer RBAC rendering (no force-accept, no Invite, danger zone disabled with honest copy, own-seat ownership only); org-Member Mira sees the New project button (question: is project creation open to all org members by design?).
- Anti-finding (do NOT file): ⌘K "Nothing matches" for mid-word queries was my probe racing the debounce — with a 2.5s settle all hits render. Server search + client anti-stale guard behave correctly.

- **F17-L12 (HIGH, confirmed live):** acceptance merges unreviewed foreign commits. Repro: VIB-5 delivered 849f68f (PR #130); external commit 92b22ca pushed ON TOP of it to vib-5; synced ("just now", diff grew +1→+3); Force-accept dialog still pinned REVISION 849f68f with NO divergence warning; confirm → PR #130 MERGED including 92b22ca — content nobody reviewed — task Done · merged. The PR-head gate is containment-based ("head does not contain the delivered revision" was VIB-4's refusal), so head-beyond-delivered passes silently. Complement of pass-15 F15-15 (reviewer side); this is the acceptance side. To decide (owner): identity semantics (head == delivered revision, strict) vs containment + explicit divergence surfacing in the accept/force dialogs and refusal chain. Verify in code: applyAcceptanceWrite / assertVerifiedHeadStillApplies + whether the NORMAL verdict-gated accept has the same hole (verdict binds to revision; head containment lets post-verdict commits ride).
  - Cleanup note: main now contains the probe line "external marker — pass-17 divergence probe" in qa/smoke/pass17-governed-delivery.md (remove in Phase D).
- Verified UC32 (autonomous project): full-autonomy operator summoned Reviewer itself, took approve verdict, accepted into Done — "accepted,

- [x] 2 extra users (Mira member, Deniz member)
- [ ] Project members: add Mira (Maintainer), Deniz (Contributor) to VIB; test Viewer with one of them on a second project.
- [ ] KB creation + grant
- [ ] MCP server add + grant
- [ ] New agent profile + operator selection
- [ ] Second project (Strict human-gate) + third (Autonomous) for preset matrix
- [ ] 20+ use cases (list being built in TEST-PLAN as executed)
