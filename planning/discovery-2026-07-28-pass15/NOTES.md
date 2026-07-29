# Pass 15 — Discovery notes (2026-07-28)

Environment: **fresh docker compose instance** (`viberr-app-1`, production build, `/data` = `./docker-data`, clean slate: 1 user, 0 projects). Both runtimes (claude, codex) detect available in-container. Host dev server intentionally NOT running (dual-writer rule). GitHub connection `akin-ozer` PAT pre-added by owner (scopes unproven until attached to a project). Login: arda@viberr.dev (org admin).

Browser pane wedged (stale frames, input timeouts) → walkthrough driven via Playwright, shots in `shots/`.

## UI walkthrough observations (UX focus)

### Login (01)
- Clean. GitHub/Google buttons render "— not configured" with explainer + whitelist copy. Good honesty. `⌘K` chip on search shown pre-login? (n/a — that's home).

### Home (02)
- Greeting "Good evening, Arda" (time-aware). Empty-state card explains project = board + repo + policy, 3-step summary. Good.
- Footer utilities: "Re-scan" and "Rebuild projections" — admin plumbing exposed on the home page footer. Q: should these be on the home page for every org member, or tucked into settings? (RBAC-gated?)
- Settings summary cards (connections/users/agent resources) with counts — nice.

### Org settings (03-*)
- Sidebar count badge for Agent resources shows **5** (= 2 profiles + 3 skills? KB/MCP excluded because zero). Number is a grab-bag; label doesn't say what it counts.
- Connections: PAT row `akin-ozer/` — trailing slash after account name looks like a template for `owner/repo` but with no repo it reads as a typo. "3 repos · expires —" (fine-grained, no expiry = truth). Scopes line: "repo, pull_request:write unproven — verified when attached to a project" (proven-only ruling visible; good).
- Users: whitelist copy good. Role toggle Admin/Member inline. Pencil/key/x icons — key = password reset? (check later). Local badge for local accounts.
- Agent resources: Skills show `store://skills/<name>/` paths + "updated never" + template counts. Profiles: Developer=Codex, stages "Ready · In Progress", Reviewer=Claude Code, stages "In Progress · Review", both "not deployed", "1 context resource".
  - "updated never" reads odd for seeded assets (seeded ≠ never touched?). Minor copy.
  - "not deployed" — meaning not engaged in any project? Check wording against code.

### Dialogs (04-*)
- New GitHub connection: required-scope chips + classic-vs-fine-grained explainer. Good.
- Allow access: GitHub/Google/Local methods, instance role. Good.
- New KB: name → `store://kb/<name>/`, re-index on change/manual with honest copy ("does not pin what an agent reads"). Good.
- Add MCP: HTTP/stdio transports, optional credential, "real MCP handshake runs on save & test". Good.
- New skill: name + Write SKILL.md / Start from files modes + summary + markdown body. Matches day-2 ruling.
- New agent profile: backend Codex/Claude Code, role summary "the OPERATOR reads this", delivery-withheld default note, default eligible stages (Done human-only). Good.

### Project creation (06-*)
- Repo field auto-derives from project name (placeholder AND value = slug). Nice.
- **UX: after Create project, app returns to home grid — does NOT navigate into the new project.** Expected: land on the new board (or at least focus the card). Check intent.
- Project description was auto-filled with the preset blurb "Standard 5-stage workflow · balanced agent policy." — a preset summary stored as user-editable description. Mildly odd; fine.

### Project pages (07/08-*)
- Board: 5 columns, filter chips (All/Waiting on me/Agent working/Needs attention), Board/List toggle, per-project Re-scan. Clean.
- Agents: stat tiles, Operator panel + capability policy 3-col (acts directly/recommends/reserved for humans), specialist profiles list. Coherent.
- Policy: RBAC matrix per member-role with counts; agent capability summary (n direct / n recommend / n human) per profile; ALWAYS-HUMAN list. Coherent.
- Review queue: two sections (Waiting on your acceptance / Still in review) with honest empty copy.
- Activity: Stream (All/Humans/Agents/System) + Audit logs (project created, credential assigned).
- Settings: name/prefix/desc, stage editor (drag, rename, add/remove; Triage/Done locked), members invite (join as Viewer), repo & credentials + Repair…, canonical task file path shown.

## FINDINGS (numbered, accumulating)

- **F15-01 (MED, credentials/UX-honesty)**: Project credential card renders BOTH "repo, pull_request:write unproven — verified on first use" AND green "✓ Every provable scope verified." with ZERO proven scopes. Cause: `credential-card.tsx` `unverified` checks only `source === "unchecked"`; these scopes are `assumed`, so the render falls to the green `cred-ok` branch ("Every provable scope verified" when `unproven.length > 0`). With no proven chip at all, the green claim is false — violates the 2026-07-25 proven-only honesty ruling. Also check WHY attach-at-project-creation left sources `assumed` — the ruling says attach revalidates with the project repo (write probes). Repro: fresh instance → add PAT at org level → create project with it → project GitHub/Settings page.
- **F15-02 (LOW/UX)**: GitHub page "Update status" POST returns in ~14ms (no GitHub call?) and the "Not yet synced" badge persists with no feedback. Either the action is a no-op in some state or the badge's definition of "synced" never flips without tasks; either way clicking the button gives zero visible result. Investigate `github.data` action.
- **F15-03 (LOW, watcher)**: On project creation the file watcher logged `watcher reconciled removed directory /data/projects/viberr` — a REMOVE reconcile for a directory that was just created (projection survived; likely transient-rename race). Verify no state loss path.
- **F15-04 (UX)**: After Create project the app stays on the home grid instead of opening the new project board.

- **F15-05 (HIGH, agents)**: Creating a NEW agent profile (org New-profile dialog) auto-grants the skill `reviewer-expertise` as its "1 context resource" — both "Docs writer" and "Developer Claude" got it. Nothing in the dialog chose a skill; a docs-only profile now mounts reviewer instructions on every run (skill-selection correctness broken at the default). Where does the default come from?
- **F15-06 (HIGH, agents)**: The new-profile default capability set includes VERDICT caps acting directly — "Approve the review", "Request changes", "Post quality-flag events" — for ANY new profile (my Docs writer can approve reviews). The dialog's own copy promises only "read, validate, comment" with delivery withheld. Default template contradicts the revision-bound review model's intent (verdicts belong to review-capable profiles, engage-time snapshot).
- **F15-05/06 refinement (from VIB-1 run context)**: `get_task` shows Docs writer `capabilities: {delivery:false, verdict:false}` and correct per-profile skills — the STORED grants are honest; the project Agents page **detail view** renders a wrong default capability set ("Approve the review" etc. under ACTS DIRECTLY) and showed reviewer-expertise as the context resource. Defect is in the view/derivation layer (and possibly the org "1 context resource" count), not enforcement. Still fix hard: admins read that panel as truth.
- Facts learned: seeded Developer profile has backend fallback list "Codex, Claude Code — a run uses the first"; models shown: GPT-5.6 Sol (Codex), Claude Sonnet (Claude). New-profile subtitle on project page is generic "Specialist" (seeded ones show role tags "Implementation"/"Review & validation").

- **F15-08 (LOW/UX)**: Task page mixes timezones — agent-log lines show UTC ("17:46:46") while timeline comments show local ("20:46"). Same page, same events, 3h apart visually.
- **F15-09 (COSMETIC)**: Board card shows the "agent working" badge twice (top-right chip AND footer strip).
- Facts: Triage→Ready and Ready→In Progress are `auto` boundaries under Balanced — operator crosses them directly; the "recommends only" tier applies to governed boundaries (Review etc.). Operator run structure: one run per stage hop ("resumed · run 2 of 3"), each with turns/tokens/cost. VIB-1: operator triaged (12s, $0.05), assigned Developer (Codex) among 4 specialists, started its run; Codex log streams via @openai/codex-sdk runStreamed(), loaded developer-expertise skill, branch vib-1 created in-container.

- **F15-10 (MED/UX, owner question)**: "Accept completion → Done" fires immediately with NO confirmation — and it merges the PR to main. Removing a credential gets an alertdialog; merging to the default branch doesn't. Intended one-click?
- **F15-11 (MED/UX)**: A Done/closed task still renders an active "Accept completion → Done" button, active "Run"/"Run operator" buttons and the schedule-re-run form (execution profile says "task closed" and reviewer panel says "no new reviewer engagements", but the controls above contradict it).

- **F15-12 (MED, RBAC/UX — confirmed 403)**: A contributor who OWNS the task sees Apply/Dismiss on a STAGE transition recommendation (owner authority reveals the controls), but clicking Apply returns 403 (`approve-transition` is maintainer+) and the UI swallows it silently — no toast, no reason, rec stays pending. Either owner authority should extend to applying transition recs on their own task (product ruling needed) or the buttons must be gated/annotated per-kind. Repro: contributor takes ownership → transition rec → Apply.
- R6-2 verified otherwise: ownership take by contributor works; permissions panel updates to "You own this task — you can accept it → Done"; forced password-reset flow on first login works cleanly.

- **F15-13 (LOW/honesty)**: Accepting a task whose PR was merged out-of-band writes timeline "Merged PR #111 into main." attributed to the accepting human — the PR had been merged on GitHub minutes earlier. Event should acknowledge already-merged.
- **F15-14 (HIGH, operator/triage)**: The triage quality gate did NOT fire for a textbook-underspecified goal ("The documentation could be improved. Make it better." — no file, no criteria). Operator ran Glob, then advanced Triage→Ready with reason "goal and scope are set", no `set_goal`, no flag, no packet — despite the New-task dialog promising "Underspecified goals get flagged at the triage quality gate" and the profile holding `flag-underspecified-tasks`. Prompt-doctrine and/or gate needs tightening (VIB-6 repro).

- **F15-15 (CRITICAL, delivery+review integrity)**: Pre-existing remote branch with the task's key (junk `vib-8` pushed before task creation): on the Review transition the push fails non-fast-forward, the system event **misblames the credential** ("check the credential and re-scan"), and the app **opens the review PR anyway on the stale remote content** — PR #114's diff is `junk-collision.txt` only; the delivered marker commit never reached GitHub. **Second order: the Reviewer then APPROVED by reading the LOCAL workspace branch ("Local vib-8 HEAD is e669c89… exact SHA match", single-file diff) — it never compares against the PR head — and the operator recommended acceptance, which would MERGE THE JUNK PR into main with a green review attached.** Fix cluster: (a) non-fast-forward detected distinctly with honest copy; (b) never open/keep a PR whose head ≠ delivered commit (block + packet); (c) reviewer/acceptance must bind to the PR head SHA, not the local branch.

- **F15-16 (LOW/UX)**: Board search placeholder promises "tasks, branches, agents" — branch and title terms match, but agent names (e.g. "Reviewer") match nothing (cards only carry the deliverer's name). Scope is the current board only; the mock intended a global ⌘K palette (open question Q3).
- **F15-17 (HIGH, delivery — ROOT CAUSE REVISED)**: Delivery (push + PR) binds to `reviewStageIdOf(project)` = "the stage with the governed edge into Done" ([task-actions.server.ts:3028](app/server/tasks/task-actions.server.ts:3028)). After inserting a **QA** stage between Review and Done, the delivery boundary silently MOVED to QA: entering the stage literally named "Review" runs no delivery at all (no push, no PR, no log, no event) — VIB-9 sat in "Review" with "no PR" twice; moving it to QA instantly pushed and opened PR #117. Meanwhile the operator/UI language still treats "Review" as the review boundary. Structural-role concept vs. named-stage semantics incoherence — needs an owner ruling on where delivery/review bind when the graph has post-review stages, and whatever the answer, the non-delivering "Review" entry must say something. (The Developer-Claude-pushes-branch-early parity note from before stands as an independent fact.)
- **F15-18 (MED/UX, mobile)**: At 375px the fixed workspace sidebar stays expanded, squeezing task content into ~140px. D-29 promised "same surface reflowed"; this is not usable reflow.
- **F15-19 (HIGH, acceptance gate — REVISED)**: Human "Accept completion → Done" on a revision with NO reviewer verdict (chip "awaiting verdict") **succeeds** — VIB-9 went Done and PR #117 merged with zero verdicts on the delivered revision, no confirmation, no warning; the click gives no feedback for ~30s (async) so it even *looks* refused. The verdict requirement apparently binds only to the operator's direct-accept path and `blockReason` wedges, not to plain human acceptance. Owner question: must human acceptance require a healthy verdict (or at minimum a confirm dialog listing what's missing — ties into F15-10's no-confirm)? Positive note: the operator DID open its promised delivery-failure blocked packet and withdrew it with an honest reason once PR #117 appeared out-of-band; DG-2 "Force accept (override review gate)" renders only for blockReason/blocked-packet wedges (verified transient render + code at [task-detail-page.tsx:96-121](app/features/task-detail/task-detail-page.tsx:96)).
- **UX gap**: manual stage-move menu has no way to attach a note/reason — the operator must burn a run asking "why was this moved back?" (it did, correctly, on VIB-9).

## Open questions for owner (accumulating)
- Q1: Home-footer "Re-scan" / "Rebuild projections" — intended to be visible to every signed-in user on the home page, or admin-only plumbing?
- Q2: Org-settings sidebar badge "Agent resources · 5" counts profiles+skills but not KBs/MCP — intended?

## Suspect areas (accumulating)
- Credential scope sources: `assumed` vs `unchecked` distinction and who sets each (see F15-01).
- Watcher remove-reconcile race on create (F15-03).
