# Pass 23 — page-by-page UI walkthrough (discovery)

Systematic capture of every major surface on the live merged-main container
(`viberr-app-1`, :5173), signed in as Arda (admin) with the pass-23 project
`Viberr → akin-ozer/viberr` and tasks VIB-1..VIB-5. Each entry = what the page
shows + a UX/coherence read. Screenshots were taken live in the browser pane.

## Auth
- **Login** (`/login`) — split hero + "Sign in to Viberr". Honest banner: "GitHub &
  Google SSO isn't configured on this deployment. Sign in with a local account."
  Wrong email → "No local account for that email. Ask an admin to create one…"
  (no user enumeration beyond the whitelist model). First-login for a seeded account
  forces a password reset ("Set a new password… you signed in with a temporary password").

## Home / all projects (`/`)
- Greeting + a HONEST status line: "All quiet. No agent runs right now. **3 decisions
  waiting on you** across all your projects." Accurately reflects pending packets.
- Project card: name, key, repo, workflow+policy summary, a stage-distribution bar,
  "4 tasks · quiet", a "**3 waiting on you**" pill, "updated 3m ago". Grid/List toggle.
- Bottom: an inline Settings summary (GitHub connections / Users & access / Agent
  resources counts) + Store maintenance (Re-scan / Rebuild projections, admin-only,
  names the writer pid). Coherent, information-dense, no dead controls seen.

## Project board (`/projects/viberr/board`)
- Header "4 tasks · 3 waiting on a human". Filters: All / Waiting on me·3 / Agent
  working / Blocked or waiting / No activity / Archived·1. Filter search box.
- 5 columns Triage→Ready→In Progress→Review→Done. Cards: key, title, readiness badge,
  owner/assignee, branch/PR, and a state pill ("waiting on you", "agent working",
  "merged"). Reads cleanly at a glance.

## Task detail (`/projects/viberr/tasks/VIB-*`)
- Left: GitHub card (PR state, branch, commits, diff stat, "Open on GitHub",
  Deliver/Force-accept). Right: Current state (Stage, Waiting on, Owner, Repo) + the
  acceptance affordance (honest "Not acceptable yet… move the task through the workflow
  first" when pre-Review). Permissions ("V1 rules") spell out the viewer's exact grants.
- Below: the goal (editable), **Operator recommendations / Decision packets** (Apply/
  Dismiss or resolve options with honest framing — e.g. "Recorded by Viberr when the
  delivery landed; this is not the operator agent's judgement"), a live Agent-logs
  stream (raw tool calls as evidence, "never in the task record"), the Execution profile
  (Operator / Delivering agent / Reviewing agents / Human owner), and the Timeline
  (All / Important events / Comments) with a Lexical @-mention composer.

## Agents (`/projects/viberr/agents`)
- Tabs: Profiles / Live / Capability matrix / Add from library / New profile. Stat
  tiles (profiles approved, tasks with a live operator, threads working / waiting).
- A horizontal profile selector (Operator + agent profiles) → a detail panel per
  profile: description, eligible stages, capability policy (ACTS DIRECTLY / RECOMMENDS
  ONLY / RESERVED FOR HUMANS), context resources (skills/MCP/KB), backend, model,
  autonomy, active deployments. Edit-profile modal = the create/edit form (backend
  pin, model/effort, stages, persona, capability toggles grouped in accordions,
  resource pickers). NOTE: BUG-1 lives here (web-egress toggle displayed "Off" while
  on at runtime) — fixed in PR #194.

## Policy (`/projects/viberr/policy`)
- Two surfaces: **Human access · RBAC** (the role×action matrix with a prose rider on
  members-only privacy + owner-scoped authority) and **Agent capability** (per-profile
  direct/recommend/human counts + the ALWAYS-RESERVED-FOR-HUMANS list). Plus Workflow
  rules (5 stages, 4 transition rules, per-boundary Auto/Human-approval/Human-only,
  "locked · V1"). Dense but legible; the acceptance-exception prose is precise.

## GitHub (`/projects/viberr/github`)
- Repository + connection health (PAT suffix, scopes, "unproven (verified on first
  use)"), Rotate/Remove credential, "Update status" (reconcile). Pull requests linked
  to tasks (state: in review / merged / closed) + Execution branches (task→branch→
  commit→PR mapping with SYNC status). The reconcile flips PR state honestly (validated
  live: #193/#196 → closed after `gh pr close`).

## Activity (`/projects/viberr/activity`)
- Full event stream (Humans / Agents / System), filterable by type + actor. Every
  event typed + attributed; the reject/recovery flow rendered with consistent honesty
  disclosures; TODAY/YESTERDAY date-rollover grouping correct (a historical hydration
  bug area — clean here).

## Review queue (`/projects/viberr/review`)
- "Waiting on your acceptance" + "Still in review", each with an honest empty state and
  the human-only acceptance rule stated ("Accepting a completion merges the review PR
  and moves the task to Done, always a human action, always in the audit log").

## Org / instance settings (`/org/settings?tab=…`)
- **Connections** — add a GitHub connection (PAT validated against min scopes before
  saving). **Users & access** — whitelist accounts (Local/GitHub/Google), instance role
  Admin/Member; "Allow access" generates a temp password. **Sign-in & SSO**. **Agent
  resources** — Knowledge bases / MCP servers / Skills / Global agent profiles, each
  with create/edit/delete + honest empty states. A Member (non-admin) gets 403 here;
  their account menu omits "Org settings".

## Overall UI/UX read (coherence)
Holistic and coherent. Consistent design language, honest empty/first-run states,
acceptance/transition disclosures that carefully distinguish system-recorded facts from
agent judgement, and RBAC that hides members-only projects as non-existent (404) while
gating org settings (403). The two coherence defects found (BUG-1 web-egress display,
BUG-2 @operator "picking it up") are fixed in PR #194/#195. Minor polish candidates
(delete-confirm grant count, first-clone "Preparing workspace" progress) → AREAS-TO-IMPROVE.md.
