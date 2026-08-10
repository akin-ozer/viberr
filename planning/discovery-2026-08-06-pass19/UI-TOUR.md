# Pass-19 systematic UI tour + live use-case campaign (merged tree)

Tree: merged HEAD (d48ed26), 3629 tests green. App live at localhost:5173, signed in as
Arda (org admin). Screenshots captured inline via the browser pane; observations recorded
here. Focus per owner: UI/UX holistic coherence + design.

## Page-by-page tour

### 1. Home (/) ✓
Greeting + "All quiet — no agent runs right now. 3 decisions waiting on you across all your projects."
Grid/List toggle · New project. Two project cards: stage-distribution mini-bar, task count,
"N waiting on you" amber pill, member avatars, updated-time. Settings hub (3 cards: GitHub
connections / Users & access / Agent resources). Admin store-maintenance strip w/ writer pid.
- COHERENT. Calm hierarchy, member-scoped counts, honest "quiet" status.
- Search placeholder is "Find a project..." on home vs "Search..." in a project — deliberate scope cue.

### 2. Review queue (/review) ✓
Header pill "Review → Done · human only". Two sections: "Waiting on your acceptance (0 of 1)"
empty state ("Nothing waits on you. Completion reports land here when a task reaches the
boundary.") + honest lock line ("Accepting a completion merges the review PR and moves the task
to Done — always a human action, always in the audit log."). "Still in review (1)": VC-5 row
names its action **Review** (not Accept — R15-11), "no validation" pill, "waiting on a human".
- COHERENT. Merged Session-B copy ("waiting on a human") sits fine next to A's row-action naming.

### 3. Agents (/agents) ✓
Stat tiles (4 profiles·incl operator / 2 tasks w/ live operator / 0 specialists working / 3 threads
waiting on human). Orchestration: Operator (running 2). Specialist profiles: Developer(idle),
Reviewer(2), Doc Writer(1). Operator detail: eligible stages (all 5), 3-tier Capability policy
(ACTS DIRECTLY green / RECOMMENDS ONLY blue / RESERVED FOR HUMANS red), context resources (SKILLS
viberr-app-expertise, MCP None, KB None), backend order, autonomy, continuity, active deployments.
- **Capability matrix modal**: full profile×action grid w/ CLAUDE-ENFORCED tags + honesty preamble
  (Codex tool limits advisory, read-only sandbox + server delivery gate constrain it). The F19-16
  runtime-asymmetry paragraph is A's fuller version live: "On Claude [skills] installed... as real
  skills... no length cap. Codex... pasted into the prompt up front under one shared 24,000-char
  budget — a long skill can arrive clipped, and one that no longer fits is announced as omitted."
  ✓ RECONCILE §3 #23 satisfied live (one paragraph, A's).
- COHERENT. This is the densest page and stays legible; the matrix is the strongest custom component.

### 4. Policy (/policy) ✓
Subtitle "Human access and agent capability — two surfaces, managed separately". LEFT: Human
access · RBAC — member role toggles (Admin/Maintainer/Contributor/Viewer; Arda=Admin, Elif=
Contributor) + action×role grid (View/Comment/Create/Take-release/Approve-transitions/Resolve-
packets/Accept→Done/Edit-goal/Run-agents/Reorder/Reconcile...). RIGHT: Agent capability — 4
profiles w/ N direct·N recommend·N human counts. "ALWAYS RESERVED FOR HUMANS": merge PR (all
profiles), transition to Done ("except an operator at full autonomy with an explicit Accept
completion into Done grant" — the Q1 exception, honest), change policy (all profiles).
- COHERENT. Matches "three separate role systems" ruling; the human-only exception is disclosed
  precisely (ruling 27/Q1). No "govern*" anywhere (copy-ban holds live).

### 5. Activity (/activity) ✓ — HEADLINE: 4 merged rulings live at once
Stream (All/Humans/Agents/System, 158 events) + Audit logs (policy & access · all actors).
- **R19-7 audit compaction (my UX19-5)**: "3 runtime sessions opened — each recorded per audit
  policy · Show each" and "7 runtime sessions opened · Show each" — the runtime-session spam is
  FOLDED, and real events surface: autonomy-clamp, force-accept, interrupt, reconcile. LIVE ✓
- **R19-A autonomy clamp (Session B)**: "Arda — task operator autonomy clamped · VC-2". LIVE ✓
- **R19-8 no-change completion (Session B)**: stream "Completed — no changes. Human acceptance
  recorded — VC-9 completed with no changes. Branch vc-9 carries no commits ahead of main..." ✓
- **Force-accept audit honesty**: "Arda force-accepted the completion, overriding the acceptance
  gate (VC-8's delivered revision has no approving verdict yet) — on VC-8". ✓
- Delivery honesty: "VC-9's workspace carries no commits ahead of the default branch... re-run the
  delivering agent, then deliver again." (F19-18/no-change surfacing).
- COHERENT + the audit column is now legible (was the UX19-5 defect). Both sessions' events read
  as one chronology.

### 6. Settings (/settings) ✓
"Viberr Core · settings" (ruling 33 scope-named). 2×2: Project (name/prefix VC/desc, task keys
VC-###, canonical path), Workflow stages (5, drag-reorder, Triage+Done locked, Move menu + ×,
re-wire copy "Adding or removing a stage re-wires the transition chain..."), Members (2 active,
invite → Viewer default, "Roles managed in Policy → Human access"), Repository & credentials
(repo, task attachment, After merge: delete branch checkbox=on, connection scope chips
"pull_request:write unproven — verified on first use"). Danger zone below (Viewer-gated per Q-V1).
- COHERENT. Cross-page references consistent; nothing gated on viewport.
### 7. Instance settings (/org/settings) ✓ + FINDING UX19-6
Tabbed: GitHub connections (1: akin-ozer PAT ····k3ui, 3 repos, scope chips), Users & access (3),
Agent resources (6). Agent resources = 4 panels: Knowledge bases (QA marker conventions, live
folder, re-scanned 3d ago), MCP servers (pass19-probe stdio node docker-data/mcp-test/server.mjs,
1 tool, checked 1d ago · stale retest), Skills (kubernetes-rollback=DECOY, developer-expertise,
reviewer-expertise, viberr-app-expertise), Global agent profiles (Developer Codex, Reviewer Claude).
- COHERENT layout.
- **UX19-6 (MED, copy-ban) — a "govern*" word renders in the UI.** The seeded `viberr-app-expertise`
  skill DESCRIPTION reads "Coordinate one **governed** Viberr task through its workflow..." and it
  renders verbatim in the Agent resources panel (and the resource/profile modals). INTENT §6.19 bans
  "govern*" in RENDERED copy. copy-ban.test.ts:589-591 EXPLICITLY ALLOWLISTS this line as "skill
  frontmatter description — the model's tool-selection blurb" — but the field is DUAL-PURPOSE: it is
  also the human-facing UI label. The allowlist masks a real rendered-copy violation. Fix: reword the
  seed description to drop "governed" (bodies stay exempt — they are pure agent prompt), and split the
  copy-ban allowlist so `description:` frontmatter (rendered) is held to the ban while bodies stay
  exempt. OWNER CALL: is a skill's tool-selection blurb "rendered copy" (my read) or agent-context?

### 8. Profile & preferences (/profile) ✓
Profile (display name, title, email "local account · admins can edit", member-of list w/ per-
project role pills, signs in via local account, joined). Notification routing toggles (Decision
packets / Approval requests / Mentions & replies / Policy events). "Your access" = per-action
grid derived from the user's role (admin=all checked).
- COHERENT. Access grid honestly mirrors the RBAC matrix for the signed-in role.
### 9. Board (/board), task detail, ⌘K — covered earlier this session ✓
Board: 5 stage columns, filter chips incl. "No activity" (B Gap-10), roving arrow-key traversal
(D19, live-verified), archived cards inert (F19-8). Task detail (VC-7): 6-mode AcceptConfirm,
freshness "Checked/Last change" (F19-22), R19-5 force label, D18 continuity panel (live-verified),
operator packet grounded in real repo (R19-1) w/ MCP canary + skill-decoy proof.

## Tour verdict
The merged UI is HOLISTIC and COHERENT. Both sessions' work reads as one product — no vocabulary
forks, no contradictory affordances, state semantics consistent across board/queue/detail/activity.
Custom components (Task Status Card, Decision Packet, Execution Truth Strip, Mixed Timeline Item,
D18 Continuity Recovery Panel) all present. Copy-ban holds in source. ONE finding: UX19-6 (a
"governed" word renders via a seed skill description, allowlisted but human-facing).

Merged rulings VERIFIED LIVE this tour: R19-1 (operator repo clone grounding), R19-5 (force label),
R19-7 (audit compaction), R19-8 (no-change completion), R19-A (autonomy clamp), R19-B present,
D18 panel, D19 traversal, F19-16 skills asymmetry, F19-22 freshness, force-accept audit honesty.
