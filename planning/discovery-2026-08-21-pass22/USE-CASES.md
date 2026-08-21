# Pass 22 — live use-case catalog (2026-08-21)

Status legend: PENDING → RUNNING → PASS / FAIL(→finding) / PARTIAL / BLOCKED.
All PR-producing cases run on project **VIB (akin-ozer/viberr)** per owner instruction; merges/rejects via `gh` are allowed, merged files must stay tiny (qa/ canaries only). Non-PR cases may use a second project.

## A. Core flow (task lifecycle)  — ALL PASS (VIB-1, real merged PR #187)
- **UC-01 Task creation & operator auto-triage** — Status: **PASS**. Operator auto-engaged on create, cloned per-project mirror (visible "Preparing workspace · Cloning"), moved Triage→Ready→In Progress autonomously (Balanced auto-advances early boundaries; Review→Done human-locked).
- **UC-02 Stage transition governance** — Status: **PASS**. Move-to-Review was a human-approval recommendation (Balanced); Applied it → transition + audit row + operator re-triggered (stranding fix).
- **UC-03 Developer delivery + PR** — Status: **PASS** (on Claude; Codex quota-blocked, see F22-08). Developer(Claude) created qa/pass22-canary.md, committed c3503a1 on fresh vib-1, handed back (did NOT push — delivery is viberr's job). viberr pushed + opened PR #187 at Review. Commit clean of .claude (R18-3).
- **UC-04 Reviewer (Claude) verdict** — Status: **PASS**. Operator auto-engaged Reviewer(Claude) with a 3-requirement directive; Reviewer pinned revision c3503a1 (R15-1), cross-checked bullets vs real source agent-catalog.server.ts, posted approve verdict + quality event. Genuine review. Its evidence stats (1 file/+5) contradicted the PR body's stale 3 files/+214 → F22-10.
- **UC-05 Acceptance ceremony + real merge** — Status: **PASS**. R21-5 ceremony disclosed MERGES PR#187→main / REVISION c3503a112 / VERDICT healthy / one-way. No drift. Accepted → PR #187 MERGED (181034c), file on main, vib-1 auto-deleted. Task=Done.
- **UC-06 PR rejection path** — a second task's PR gets changes-requested/closed via `gh`; expect viberr reflects pr state (changes-requested chip, closed-unmerged surfaces on board filter "Blocked or waiting"). Status: PENDING.
- **UC-07 No-change completion** — task whose goal is already satisfied; expect "Completed — no changes" first-class path (R17-2, ruling 62) with default-branch evidence. Status: PENDING.
- **UC-08 Force-accept past the gate** — Status: **PASS**. VIB-2 (In Progress, no PR). Force-accept ceremony disclosed MERGES "No linked pull request — closes without a merge", REVISION none, VERDICT no validation, SKIPS "Review and the review gate", BYPASSING explanation, "Admin override... recorded to the audit log". Confirmed → Done. Audit: "Arda force-accepted the completion, overriding the acceptance gate (VIB-2 is at In Progress, not Review)". Bonus: RBAC denials audited too ("Blocked: Deniz Kaya tried to create tasks... viewer is not permitted").

## B. Browser capability (OWNER FOCUS) — VALIDATED (VIB-2)
- **UC-09 Browser evidence run (Claude)** — Status: **PASS**. Operator auto-selected Web Researcher; playwright/mcp + chromium mounted; drove example.com + github (404) live; screenshots → attachments/ default-named; accurate findings; #177 thumbnails on producing comment + Attachments panel with attribution; #184 native-<dialog> lightbox opens in-app showing captured page. Page content treated as DATA not instructions (security stance).
- **UC-10 Browser grant coupling** — Status: **PASS (code + creation-side live)**. Creation: Web Researcher (browser=direct) ran the browser, which requires coupled egress at mount → egress WAS coupled. Edit/deploy save-layer coupling + editor disabled-pin code-verified (repairBrowserEgressGrants, create-profile-modal.tsx:697-761). See F22-04 (no withheld arm, no ruling) + owner Q1. UI-drill of the pinned egress row skipped (Lexical/section-toggle friction).
- **UC-11 Browser on Codex** — Status: **BLOCKED** (Codex quota). Code path verified (argv MCP, --image-responses omit). Not live.
- **UC-12 Browser without egress (hand-edited)** — Status: PENDING (fail-closed mount test). Code-verified (specialist-browser-mcp.server.ts:115 refuses).
- **UC-13 Screenshot naming split** — Status: **PASS**. All screenshots default-named page-<ts>.png → landed in attachments/ (human-visible); persona steered correctly; attribution window linked them to the producing comment.

## Also validated (not in original list)
- Operator agent-selection: picked Developer for code task (VIB-1), Web Researcher for browser task (VIB-2). ✓
- @mention→run routing (Lexical composer + mention autocomplete → run → @tag human reply). ✓
- Audit completeness (25-row VIB-1 lifecycle) + RBAC-denial auditing. ✓
- Live-backend overlay #183 (Developer engagement showed "Claude" after profile edit). ✓

## C. Agents / backends / context resources
- **UC-14 Claude vs Codex parity** — Status: **PASS (Claude delivery half, live 2026-08-21)**. VIB-7 "Claude delivery canary" delivered by a CLAUDE-backed Developer end-to-end: operator triaged → advanced → engaged Developer → primary run on Claude/sonnet (9 turns) → commit 1d1f649 on vib-7 → viberr opened PR #190 (1 file/+1, exactly the scoped canary `qa/pass22-claude-canary.md`). Same lifecycle, run panel, operator coordination ("Move to Review" recommendation) and PR pipeline as Codex from viberr's eye; the Claude agent followed the scoped goal precisely (no bloat). PR #190 then rejected via `gh pr close` → viberr reconciled the close live; vib-7 branch deleted. The CODEX delivery half stays quota-blocked until Sep 18 (external). Skills delivery (native vs 24k prompt) + Codex-comments-channel remain code-verified only.
- **UC-15 Skill loading fidelity** — Status: **PASS** (Claude). Developer workspace `.claude/skills/` contained ONLY `developer-expertise` — not reviewer/viberr-app, not the repo's own tracked skills (react-doctor etc., which R18-3 strips via skip-worktree). Delivery commit clean of `.claude`. Codex-side (24k prompt budget) untested (quota).
- **UC-16 KB proof-of-read** — Status: **PASS**. Web Researcher cited "Per review standards (marker KB-CANON-ORCHID-42)" in its VIB-2 report → viberr-product-canon KB granted→mounted→read→applied. Full loop verified.
- **UC-17 MCP live tool call** — Status: **PASS (Claude)**. mcp__everything__get-sum(21,21)→"42"; mcp__everything__echo(MCP-PONG-77)→"Echo: MCP-PONG-77". Claude tool-ids keep hyphens (get-sum). Codex underscored form unverifiable (quota).
- **UC-18 MCP credential injection** — Status: code-verified (Claude Authorization header; Codex argv unauthenticated + disclosed). Not live (no credentialed server needed for the everything test).
- **UC-19 Ask-human mid-run** — Claude agent asks a question mid-flight (pauses run, input_required yields to agent-working per R21-8 only when waiting==agent); answer resumes. Codex variant arrives end-of-run. Status: PENDING.
- **UC-20 Continuity loss & re-anchor** — kill a live run's session (delete session file / restart container mid-run); expect continuity typed event, degraded fact, board filter chip appears, recovery panel states. Status: PENDING.

## D. Governance / RBAC / multi-user — ALL PASS (live, server-enforced)
- **UC-21 Contributor scope (Mira)** — Status: **PASS**. Sees only Viberr (not Sandbox); Permissions panel honest (comment ✓, take own seat ✓, accept only if owner, no run-agents); SERVER: run-operator → 403 "Permission".
- **UC-22 Viewer scope (Deniz)** — Status: **PASS**. role=Viewer, "View only (contributor+ to own)", no create/ownership affordances, CAN comment; SERVER: create-task → 403 "contributor". Denial audited.
- **UC-23 Members-only invisibility** — Status: **PASS**. Mira on /projects/sandbox/board (non-member) → 404 identical to nonexistent slug (only the echoed slug differs). R15-4.
- **UC-24 Owner-scoped authority** — Status: **PASS**. Mira (contributor) took VIB-2 ownership → panel flips to "You own this task, so you can accept it → Done". Deniz (viewer) cannot take ownership (FR38 floor). R15-3/FR37.
- **UC-25 Org-admin override** — Arda acts on a project he's not member of (second project owned by Mira?) — audited org-admin override rows. Status: PENDING (needs second project without Arda membership — check if creator-seeded-admin blocks this