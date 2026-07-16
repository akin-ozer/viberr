# UI walkthrough — pass 5 discovery (2026-07-16)

State: main @ 81dafe3, DB restored from `projection.pre-baseline-20260715-2320.sqlite`
(the codex-branch baseline DB is preserved as `data/state/projection.baselined-codex-20260716.sqlite.bak`).
Logged in as seeded admin arda@viberr.dev. Dev server via `.claude/launch.json` (port 5173).

Every page below was visited and screenshotted in-session. This file records what each
page actually renders on main today, plus per-page observations. Findings with IDs live
in `findings.md`.

## Login `/login`
- Email+password local login; GitHub & Google OAuth buttons render disabled with
  "not configured on this deployment" copy. Whitelist-based access copy at bottom.
- Works. Seeded admin login succeeds.

## Home `/` (also `/projects` redirects here)
- "Good morning, Arda" + summary line ("3 runs active across 1 project, 17 decisions waiting").
- Pinned section (star toggle) + "Everything else"; Grid/List toggle; New project; ⌘K search box.
- 9 projects present: Deploy Pipeline, Viberr Core (pinned), Billing Service, Lite Probe,
  Viberr Selftest 4 (29 tasks), Viberr Selftest 5 (20), Viberr Validation (20), viberr, viberr1.
- Cards show: repo, description, per-stage progress bar, task count, "quiet"/"N agents running",
  "N waiting on you", member avatars, updated-ago.
- Observation: "3 runs active" comes from stale `agent_runs` rows (see F-RUN1 in findings).

## Project board `/projects/:id/board`
- 5 columns (Triage/Ready/In Progress/Review/Done) with per-column "+" (new task in stage).
- Cards: key, badges (input required / ready / accepted), title, assignee chip
  (Claude Code / Codex · role), branch name, PR number, "waiting on you" / "agent working".
- Filters: All tasks / Waiting on me · N / Agent working / Needs attention. Board/List view toggle.
- "Re-scan" button (aria: "Reconcile the board with the file-native store").
- Sidebar: project switcher, Board(count), Review queue(count), Agents, Policy, GitHub,
  Activity, Settings.

## Task detail `/projects/:id/tasks/:key` (viewed VIB-151)
- Header: key, title, stage badge, readiness badge, "validation healthy" badge, canonical
  file chip `projects/viberr-core/tasks/VIB-151/task.md`, description + Edit.
- Live run panel: "N agents running", runtime selector (Claude Code · primary), current
  activity line ("Running validation sweep / Bash · npm test…"), ELAPSED / TURNS / TOKENS /
  RUNTIME model tiles, View logs, Interrupt. ELAPSED ticks live; TURNS/TOKENS were 0 on a
  stale run (see F-RUN1).
- Execution profile: OPERATOR card (backend dropdown Claude Code/Codex, autonomy dropdown
  "Supervised", stage indicator), PRIMARY SPECIALIST card (profile + backend + Running badge).
- REVIEWERS section (reviewer chip + Add reviewer), HUMAN OWNER · REVIEWS & ACCEPTS card
  (owner avatar + Manage dropdown).
- Agent logs: backend/session line (`@anthropic-ai/claude-agent-sdk · stream-json · session …`),
  raw toggle, follow toggle, timestamped tool_use/tool_result/assistant lines. Real prior logs render.
- Timeline: filters All / Important events / Comments; comment box "type @ to tag the operator,
  an agent, or a teammate" (⌘↵ to send, "Open to every registered user · @mentions route to agents");
  entries for agent comments, operator actions (re-anchoring, assignments), GitHub pushes, ownership.
- Right rail: GitHub card (branch, PR/no-PR, Open on GitHub), Current state (Stage pill with
  transition control, Waiting on, Owner (removable ×), Repo), Permissions card (V1 fixed rules,
  your role, comments policy, Accept completion, Run agents, Review→Done lock), View project policy.

## Review queue `/projects/:id/review`
- Two buckets: "Waiting on your acceptance" (completion report cards → Accept completion or
  send back) and "Still with agents" (transition requests with evidence).
- Cards: key, title, PR chip, badges (evidence changed / validation healthy), agent-working dot.
- Lock copy: "Accepting a completion merges the review PR and moves the task to Done — always
  a human action, always in the audit log." Top-right chip: "Review → Done · human only".

## Agents `/projects/:id/agents`
- Tabs: Profiles / Live · N / Capability matrix. Stats tiles (profiles approved, active tasks ·
  one operator each, specialists in working state, threads waiting on a human).
- ORCHESTRATION: Operator (system role, one per active task, not deletable). SPECIALIST
  PROFILES: Developer(5), Reviewer(3) + New specialist profile.
- Right panel per profile: description, Eligible stages chips, Capability policy 3 columns
  (ACTS DIRECTLY / RECOMMENDS ONLY / RESERVED FOR HUMANS), Edit profile.
- Live tab: table AGENT / BACKEND (orchestration | Codex | Claude Code) / TASK / ENGAGEMENT
  (operator | primary | reviewer) / STATUS (packet open, waiting on human, anchored · on call,
  coordinating, working). Showed 14 rows from stale state.

## Policy `/projects/:id/policy`
- "last change · <user> · <when>" chip.
- Human access · RBAC: member rows with Admin/Maintainer/Contributor/Viewer pill selector,
  then a 12-action × 4-role check matrix (see findings for exact rows).
- Cross-role rules paragraph: commenting is app-wide; contributors+ take/release own ownership;
  owner = task's human reviewer & acceptance authority; admins may release any owner (audited).
- Agent capability panel: per-profile counts (N direct / N recommend / N human), ALWAYS
  RESERVED FOR HUMANS list (Merge a PR / Transition a task to Done / Change project policy),
  Capability matrix + Manage profiles buttons.
- Workflow rules: 4 transitions, each with Auto-advance / Human approval / Human only options;
  Review→Done "locked · V1" (human acceptance; full-autonomy operator exception paragraph).

## GitHub `/projects/:id/github`
- Repository card: default repo, Connection status ("no credential" pill on Viberr Core),
  Task attachment (project default · task-level override allowed), Repos per task (1 · V1 limit).
- "No credential configured" warning + Attach credential / Fix in Settings.
- Pull requests card: PRs linked to tasks (#318 in review, #311 in review, #298 merged,
  #287 merged) with branch → main · task-key lines.
- Execution branches table: TASK / EXECUTION BRANCH / PULL REQUEST / SYNC.
- Reconcile + Open on GitHub buttons. Merge copy: accepting a completion merges its PR when
  GitHub reachable; otherwise records accepted (merge pending).

## Activity `/projects/:id/activity`
- Stream (32 events): operator blocked-decisions, agent comments, quality flags, human
  comments, continuity warnings, with task-key chips + filters All/Humans/Agents/System.
- Audit logs panel (policy & access): profile updates, runtime session opens ("recorded per
  audit policy"), interrupts, archive/restore entries.

## Settings `/projects/:id/settings`
- Project: name, task prefix, description, task keys pattern, canonical task file path.
- Workflow stages: 5 stages with task counts, drag-reorder, rename, Add stage; Triage & Done
  locked (lock icons); pointer to Policy → Workflow rules.
- Members: 4 active + Invite ("New members join as Viewer. Roles are managed in Policy").
- Repository & credentials: default repo, task-level override toggle, repos-per-task 1 · V1,
  "No credential configured" warning + Attach credential.
- Danger zone: Archive (hide, restorable) + Delete project (removes tasks/timelines/audit).

## Org settings `/org/settings` (tabs: connections / users / resources)
- GitHub connections: 0 connections. "Every project picks one at creation — it sets the
  repository root. Each authenticates with a PAT, validated against minimum scopes."
- Users & access: 5 instance accounts; @viberr.dev Google domain-allowlist row; per-user
  Local badge, org role Admin/Member toggle, edit/reset/remove; Allow access button.
- Agent resources: Knowledge bases (3, store://kb/…, re-scan buttons), MCP servers
  (docs-search → https://mcp.example.dev/docs, unreachable · checked 3d ago — demo data),
  Skills (store://skills/…), Global agent profiles (Developer/Reviewer, "used in 9 projects").

## Notifications `/notifications` (modal over home)
- All/Unread, Mark all read. Grouped: "Waiting on you · 33 decisions" then others.
- Rows: severity icon, title, task-key + excerpt, project chip, type badge (blocked decision /
  completion report), timestamp. Codex-quota blocked decisions from Jul 12 visible.

## Profile `/profile` (modal)
- Display name, title, email (local account · admins can edit), avatar initials.
- Member of: per-project role badges. "Your access": the 12 RBAC actions with checks for
  your role. Sign-in method row. Role-change pointer to Policy.

## Not yet exercised in this pass (deferred to live-testing phase)
- New project modal, new task modal, task create → operator auto-dispatch loop.
- Capability matrix modal, profile editor, org KB/skill/MCP editors, Attach credential flow.
- Board drag-and-drop, stage transition controls, packet resolve UI, comment @mentions.
- Lite Probe (3-stage template) specifics; archived-project view; List views.
