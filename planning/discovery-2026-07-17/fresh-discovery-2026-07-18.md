# Fresh full-app discovery walk-through (2026-07-18, admin=arda)

A fresh critical page-by-page pass this session (owner asked for it, independent of prior docs) —
looking specifically for mocks / unwired / poorly-implemented / stale surfaces. Screenshots taken
live. Verdict per page + any finding.

## Home (/)
- Renders: greeting, "N runs active across M projects, K decisions waiting on you", project cards
  (grid/list toggle), New-project card, org Settings summary strip.
- Coherent: headline "15 decisions" == viberr card "15 waiting on you"; Playground "2 override-
  available" (org-admin override, not folded into the personal count). W1 member-scoping holds.
- Progress bars per card (stage distribution). "quiet" vs "N waiting on you" chip.
- VERDICT: wired, coherent. No mock.

## Board (/projects/:slug/board)
- 20 tasks; "16 waiting on a human decision" (project-wide) vs "Waiting on me · 15" (member-scoped) —
  the designed W1 split (bare waiting=human with no decision object counts in 16, not 15). Filters:
  All / Waiting on me / Agent working / Needs attention. No mock text. VERDICT: wired.

## Agents (/projects/:slug/agents)
- Tabs Profiles / Live·34 / Capability matrix. 5 profiles (Operator + Developer/Reviewer/Docs
  Writer/Style Reviewer), per-profile task counts, eligible stages, capability policy (acts-directly /
  recommends-only / reserved-for-humans). Live tab = real table (AGENT/BACKEND/TASK/ENGAGEMENT/STATUS)
  wired to run state. VERDICT: wired, rich.

## Policy (/projects/:slug/policy)
- Two surfaces: Human access·RBAC (5 members, role radios Admin/Maintainer/Contributor/Viewer +
  the total action table with app-wide "Any signed-in user" rows for view/comment) and Agent capability
  (per-profile direct/recommend/human counts; Style Reviewer shows "read-only · no gated capabilities").
  "ALWAYS RESERVED FOR HUMANS": merge PR / transition-to-Done / change-policy (all profiles). Confirms
  the pass-8 W2/W3 work live. VERDICT: wired, honest.

## GitHub (/projects/:slug/github)
- Repository (default repo, connection=connected, task attachment, repos-per-task V1 limit) + credential
  card (scopes repo/workflow/read:org/pull_request:write all granted, Rotate/Remove) + Pull requests
  (18 linked, LIVE states: #50 [VIB-22] closed = my reject, #49 in review, #47/#46/#45/#44 closed).
  Reconcile + Open-on-GitHub. The old "GitHub delivery is dead code" note (operator-runtime-gaps
  2026-07-09) is STALE — delivery + reconcile are fully wired to the real repo. VERDICT: wired.

## Activity (/projects/:slug/activity)
- Filters All/Humans/Agents/System/Stream, 200 events. Shows W4 "Divergence:" events firing for VIB-13/
  14/17/19 (their earlier-session rejected PRs #39/#43/#41/#45), caught in one reconcile — robust +
  idempotent-per-transition (first-run backlog surfacing, not a bug). VERDICT: wired; W4 works at scale.

## Project Settings (/projects/:slug/settings)
- Project (name/prefix/description, task-key pattern, canonical file path) + Workflow stages editor
  (5 stages, drag-reorder, rename, add, remove ×; Triage+Done locked) + Members (remove ×) +
  Repository & credentials (default repo, task-level-override toggle, repos-per-task V1 limit). Wired.

## Org settings — Agent resources (/org/settings?tab=resources)
- Knowledge bases (testing-conventions 1 doc, pass8-kb 0 docs; folder/rescan/edit/delete) + MCP
  servers + Skills (docs-style, pass8-skill, developer-expertise) + Global agent profiles (Developer=
  Codex, QA Reviewer=Claude not-deployed). New/Add/edit affordances. Wired.
- **FINDING (test-env hygiene, confirms B2, now verified):** the `notes-fixture` MCP points at
  `/private/tmp/claude-501/…/72cd9952-…/scratchpad/notes-mcp-server.mjs` — a SESSION-scoped scratchpad
  path that **no longer exists** (verified missing on disk), yet the UI shows it with a GREEN status
  dot ("checked 11h ago · auth: configured"). So: a non-portable test fixture that reads healthy but is
  actually dead; a fresh session/install has no working notes MCP. The green status is stale (cached
  from the last check, not re-verified on page load). Impact limited to MCP testing, but the
  stale-green health is a mild honesty gap. Fix options: ship a self-contained/bundled notes MCP (path
  under the data root, not a temp scratchpad), and/or re-verify MCP health on the resources page load
  (or show "last checked" more prominently as "stale").

## Org settings — Users & access (?tab=users)
- 5 instance accounts, whitelist-based sign-in (no invite emails), per-user org role (Admin/Member)
  radios, "Allow access". Wired.

## Org settings — GitHub connections (?tab=connections)
- 1 connection (akin-ozer, PAT masked, 3 repos, scopes repo/workflow/pull_request:write, default).
  Add connection / Update token. Minor: "expires —" (PAT expiry not tracked/surfaced). Wired.

## Profile & preferences (/profile)
- Profile (name/title/email, org memberships: viberr admin + Viberr QA Lab admin — correctly NOT
  Playground, matching arda's non-member status), notification routing toggles (decision packets /
  approvals / mentions / policy events / quality flags), theme (Light/Dark/System, WCAG AA), reduce
  motion. Wired.

## Notifications (/notifications)
- "Everything routed to you · 19 unread", All/Unread/Mark-all-read. "Waiting on you · 15 decisions"
  (member-scoped — matches the board chip 15, confirms W1 notification scoping). Real per-task
  recommendation details (PR #, file paths, validation results). Wired.
- Minor coherence note (not a bug): VIB-22's "Move to Review … ready for review" notification is
  point-in-time — PR #50 was later rejected (divergence event fired on the timeline), but the earlier
  notification isn't retroactively updated. Acceptable (notifications are moment-in-time), but a reader
  could be briefly confused. Could dim/annotate superseded recommendation notifications.

## New-project modal (P1 fix — VERIFIED LIVE)
- Name "Payments Gateway" → repo auto-fills "payments-gateway" (autocomplete while repo untouched).
  Edit repo → "custom-repo"; then change name → "Billing Service": repo STAYS "custom-repo" (no
  two-way overwrite once edited). Exactly the owner's P1 directive. Wired + correct.

---

## OVERALL VERDICT (fresh pass)
The app is mature and overwhelmingly WIRED end-to-end — every primary surface (home, board, task
detail, review queue, agents incl. live run table, policy incl. RBAC + capability, github incl. live
PRs + credentials, activity, settings, org users/connections/resources, profile, notifications,
new-project) is real and coherent, backed by live projection/agent/GitHub state. No mock/placeholder
UI found. The pass-8 work (member-scoped decision counts, RBAC honesty, W4 divergence) is visibly live
and correct across surfaces.

Genuine findings from this fresh pass (both minor, non-blocking):
1. **notes-fixture MCP is a non-portable test fixture** pointing at a session-scoped `/private/tmp`
   scratchpad that no longer exists, while the resources UI shows it GREEN ("checked 11h ago"). Stale-
   green health + not self-contained. Fix: bundle a notes MCP under the data root + re-verify health on
   load (or mark stale). (Confirms/updates B2.)
2. **PR expiry not surfaced** on the GitHub connection ("expires —"); cosmetic.
3. **Point-in-time recommendation notifications** aren't dimmed when superseded by a later divergence
   (minor coherence).
Stale doc to fix: `operator-runtime-gaps` (2026-07-09) says "GitHub delivery is dead code / operator
generates no packets" — DECISIVELY STALE; both are fully wired now (live PRs, live packets/recs).
