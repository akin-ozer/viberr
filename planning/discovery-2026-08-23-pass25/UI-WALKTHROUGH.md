# Pass 25 — UI walkthrough (page-by-page, current state)

Captured live on the rebuilt container (:5173, = merged main after pass 25) with real data (projects Viberr/VIB,
Viberr QA 25/VQ, Viberr QA Lab/VQL, Viberr Strict/VS; user Arda = org admin). Screenshots taken this pass.
This documents WHAT each surface is + its key affordances, for implementation-phase reference.

## Global chrome
- **Topbar** (every authed page): project switcher / Viberr logo (home), page title, **Search** (⌘K palette),
  **Notifications** bell (unread badge), **Account menu** (Profile & preferences · Theme · Instance settings · Sign out).
- **Design language**: one dark-first stylesheet `app/app.css`, unprefixed tokens; middle-dot `·` as the separator;
  no em/en dashes in rendered copy; WCAG AA baseline in light+dark.

## Home (`/`)
"Good afternoon, Arda · All quiet. No agent runs right now. **8 decisions** waiting on you across all your projects."
- **Grid/List** toggle · **New project**. "All projects · 4".
- Each **project card**: icon, name + task-key chip, `owner/repo`, "Standard 5-stage workflow · balanced agent policy",
  a stage-distribution bar, "N tasks · quiet", a "N waiting on you" pill, member avatars, "updated …". Pin star.
- Below the cards: an inline **Settings summary** (GitHub connections count, Users & access count, Agent resources:
  "N agent profiles · + operator · N KBs · N MCP · N skills"), and a **Store maintenance** row (admins only:
  Re-scan store / Rebuild projections; "Writer: pid N on viberr" — the single-writer identity).

## Board (`/projects/<slug>/board`)
"Board · N tasks · N waiting on a human in this project". Board/List toggle · **Re-scan** · **New task**.
- **Filter chips**: All tasks · Waiting on me·N · Agent working · Blocked or waiting · No activity · Archived·N.
  Free-text "Filter this board…".
- **Columns** = workflow stages (Triage / Ready / In Progress / Review / Done), each with a count + "+" to add a task.
- **Cards**: task-key, title, readiness pill (ready/blocked/…), owner ("awaiting owner"/"unassigned"/avatar),
  branch ("no branch"/`vq-1`), a waiting/working badge ("waiting on you" / "agent working"). Whole-card drag (dnd-kit).

## Task detail (`/projects/<slug>/tasks/<KEY>`) — the operator-first heart
Top row: **GitHub card** (branch, commits, diff, PR # + state, "Force accept", "Open on GitHub" — or "No branch yet")
and **Current state card** (Stage dropdown, Waiting on, Last activity, Owner "+ Assign me", Repo; an acceptability
note; Archive task). Then:
- **Permissions panel** ("V1 rules") — your role + per-action grants on THIS task (role + owner authority).
- **Task goal** (editable) with readiness + validation chips + the store path.
- **Operator recommendations** — pending cards (STAGE / COMPLETION) with Apply / Dismiss + the operator's reasoning.
- **Decision packets** (blocked/input) — recovery options, radio-selectable, "Confirm decision" / "Ask operator".
- **Execution profile** — OPERATOR (backend, Run operator) · DELIVERING AGENT (or "Assign delivering agent") ·
  SUPPORTING/REVIEWING AGENTS (Engage) · HUMAN OWNER (reviews & accepts) · Schedule a re-run.
- **Live run / Agent logs** — a run strip (phase, ELAPSED/TURNS/TOKENS/RUNTIME, View logs, Interrupt) and the run
  **console** (system·init, ToolSearch, tool_use/tool_result, assistant, telemetry hidden, "{ } raw", Export,
  "run inputs" disclosure). **Attachments** (browser screenshots etc., member-only, lightbox).
- **Timeline** (All / Important events / Comments) newest-first with "Show older", + a **comment composer**
  ("type @ to tag the operator, an agent, or a teammate · @mentions route to agents").

## Policy (`/projects/<slug>/policy`)
"Human access and agent capability: two surfaces, managed separately." "last change · … " · **Capability matrix**.
- **Human access · RBAC** — a member list + the ACTION × ROLE grid (Admin/Maintainer/Contributor/Viewer) with a
  long prose note on the members-only rule, owner authority, org-admin override.
- **Agent capability** — per-profile "N direct / N recommend / N human" (a Codex-primary profile shows
  "· some grants advisory on Codex" — **F-P2**). "ALWAYS RESERVED FOR HUMANS" (merge PR / transition to Done /
  change policy).
- **Workflow rules** — the stages + transition table (each transition: who may cross it + Auto-advance / Human
  approval / Human only), with the full-autonomy-operator acceptance exception disclosed.

## Capability matrix (modal, from Policy or Agents)
The full ACTION × PROFILE grid (Acts directly / Recommends / Reserved for humans / Not granted), with
**CLAUDE-ENFORCED** tags on claude-only actions, and a long **"What differs between the two runtimes"** prose list:
skills channel, mid-run comments, ask-human timing, MCP credentials (Codex unauthenticated), MCP tool naming,
MCP-not-gated, **both operators reach the web when granted (F-P1/F25-1)**, **Codex screenshots don't return to the
model (F-P4)**.

## Agents (`/projects/<slug>/agents`)
"Reusable agent profiles, eligible stages, and capability policy." Profiles / Live·N / Capability matrix /
Add from library / New profile. Stat cards (profiles approved incl. operator · tasks with a live operator ·
threads working · threads waiting). A horizontal rail (Operator · agent profiles). Then the selected **profile detail**:
description, eligible stages, **Capability policy** (ACTS DIRECTLY / RECOMMENDS ONLY / RESERVED FOR HUMANS, each row a
governed action; a Codex-primary profile shows "· advisory on Codex" on claude-only rows — **F-P1**), Context
resources & runtime (skills / MCP / KB / backend / model / continuity), Active deployments. Project-created profiles
have Delete; global ones don't. New-profile modal: name/role/backend(Codex|Claude)/model/effort/eligible-stages/
description/persona/capability-policy (repo & execution rows tagged "ADVISORY ON CODEX" for a Codex profile — **B1**).

## Review queue (`/projects/<slug>/review`)
"N tasks at the review boundary · N waiting on your acceptance", "Review → Done · human only". Two panels:
**Waiting on your acceptance** (completion reports; "Accepting a completion merges its review PR, **when there is
one** …" — **A10**) and **Still in review** (agent actively revising). Clean empty states.

## Activity (`/projects/<slug>/activity`)
"Human decisions, agent events, and policy changes across <project>." A **Stream** with filters (All/Humans/Agents/
System, search, type/actor/task-id, date range), "N of M events". Typed entries (Operator / Policy engine / Delivery
/ Codex Dev / …) with actor, task-key chip, timestamp, "Show more". This is the 90-day audit trail surfaced.

## GitHub / Repository (`/projects/<slug>/github`)
"Execution surface … branches, pull requests, and credential health." "Checked … · Update status · Open on GitHub".
**Repository** card (default repo, Connection connected, the PAT with scope chips — `repo ✓`, `pull_request:write
unproven (verified on first use)` — Rotate / Remove credential). **Pull requests** ("N linked to tasks": # + title +
`head → base` + task-key + state pill).

## Instance settings (`/org/settings`) — 4 tabs
- **GitHub connections** — connections list (owner, PAT tail, "N public repos", scope chips, default badge, Update
  token / Remove). Disk-usage line ("N GB free of M (X% used) · automatic cleanup runs every 6h; last freed …" —
  **C9**).
- **Users & access** — instance accounts (name/email/Local/role-toggle), Edit (with **Reset password** →
  one-time temp password), Disable, Remove.
- **Sign-in & SSO** — "No single sign-on: local accounts only." GitHub + Google providers (Not configured / off /
  Set up / Callback URL + Copy); whitelist is Users & access.
- **Agent resources** — Knowledge bases (folders of docs) · MCP servers (org registry, health) · Skills (store://,
  template) · Global agent profiles (base definitions, "used in N projects").

## Notifications (`/notifications`)
"Everything routed to you, across all projects · N unread." All / Unread / Mark all read. "Waiting on you · N
decisions" (authoritative — **D-3**). Each row: title + body + project + type (decision required / approval) + time.

## Search palette (⌘K)
Cross-project fuzzy search over TASKS (and branches/agents/projects per the placeholder), grouped, each with a
project label; keyboard-navigable; esc to close.

## Profile & preferences (`/profile`, modal)
Profile (display name, title, email — "an org admin can change it in Instance settings"), **Member of** (per-project
role badges), Signs in via, Joined. **Notification routing** (Decision packets / Approval requests / Mentions &
replies / Policy events / Quality flags — per-user toggles). **Appearance & workspace** → Theme (Light / Dark /
System, WCAG AA in both, saved to the account).

## Login (`/login`)
"Sign in to Viberr · Self-hosted · collaborative agentic AI delivery." Email + Password + "Forgot password?"; a note
when SSO is off. (Admin-reset accounts are forced to set a new password on next sign-in.)

## Coherence read (holistic)
The app is remarkably coherent: one design language, one separator convention, honest copy everywhere (the
"advisory on Codex" caveats, the "when there is one" merge softening, the disk/writer disclosures), members-only
privacy, and a consistent "no action fails silently" discipline. Empty/loading/error states are considered. The
operator-first task page + the two-surface (RBAC vs capability) governance model match the PRD's intent closely.
