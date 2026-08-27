# Pass 29 — UI walkthrough (per-page discovery, 2026-08-27)

Every surface visited live on :5173 (docker-data) as Arda (admin). Screenshots were captured inline during the session; this is the durable per-page record with UX observations.

## Auth
- **Sign in** (`/login`) — split hero ("Managed AI delivery for small teams · Humans set the policy and stay accountable. Claude and Codex agents do first-class work on real repository branches: inspectable, recoverable, reviewed before anything ships") + email/password. Honest banner: "GitHub & Google SSO isn't configured … Sign in with a local account." Setup-pending users hit a **"Set a new password"** gate on first login (temp-password flow). Clean, on-message.

## Dashboard (`/`)
- Greeting + "N decisions waiting on you across all your projects". Grid/List toggle. Project cards show repo, workflow+policy summary, task count, "N waiting on you" pill, avatars, last-updated. Pinned section. Settings summary cards (GitHub connections, Users & access, Agent resources) + Insights link. Clear, scannable.

## Project — Board (`/projects/:slug/board`)
- 5 stages (Triage/Ready/In Progress/Review/Done) with counts; per-stage quick-add "+". Filter chips (All / Waiting on me / Agent working / Blocked or waiting / No activity) + free-text filter. Board/List toggle, **Re-scan** (reconcile files↔projection), **New task**. Task cards show key, title, assignee+backend, labels, due, branch, PR#, validation state, "waiting on you". Drag-to-reorder (dnd-kit).

## Project — Task detail (`/projects/:slug/tasks/:key`) — the richest surface
- Header: key + title + stage/readiness/validation chips + canonical `task.md` path.
- **GitHub panel:** repo, PR#·state, Checked/Last-change, Branch, Diff (files ±), Commits, "Deliver branch & open PR" (manual delivery), "Force accept", "Open on GitHub".
- **Operator recommendations** — Apply/Dismiss cards (COMPLETION / STAGE / etc.) with the operator's reasoning.
- **Current state** — Stage, Waiting-on, Last activity, Owner (Assign me), Repo. Accept completion → Done + Archive (with reversibility note).
- **Details** — priority/labels/due (Edit).
- **Permissions ("V1 rules")** — the viewer's role-scoped grants, plainly explained (role, comments, ownership, accept, run agents, Review→Done lock). Excellent honesty surface.
- **Execution profile** — Operator / Delivering agent / Reviewing agents / Human owner, each with Run controls + "Engage reviewer" + "Schedule a re-run".
- **Agent logs** — live NDJSON stream viewer (SDK session id, follow/history, load-older, raw JSON, telemetry rows). Deep and legible.
- **Timeline** — newest-first typed events (comment/agent/transition/github/quality/blocked/completion/note), attachment thumbnails, evidence linkify, @mention rendering.
- Acceptance shows a **disclosure dialog** (MERGES / REVISION / VERDICT; "Merging is one-way" or "Nothing merges") — the mandatory ceremony.

## Project — Agents (`/projects/:slug/agents`)
- Profiles / Live / **Capability matrix** / Add from library / New profile. Per-profile: eligible stages, capability policy (Acts directly / Recommends only / Reserved for humans columns), resources (skills/MCPs/KB), backend, model, continuity, active deployments. "customized for viberr" = project-diverged fork. Capability matrix modal explains server-owned delivery, Claude-enforced vs Codex-advisory, per-cap states across profiles.

## Project — Policy (`/projects/:slug/policy`)
- Two panes: **Human access (RBAC)** 4-role grid (Admin/Maintainer/Contributor/Viewer × actions) + **Agent capability** (per-profile direct/recommend/human counts) + **ALWAYS RESERVED FOR HUMANS** trio (merge PR / transition-to-Done / change policy). Cleanly separates human roles from agent capability.

## Project — GitHub (`/projects/:slug/github`)
- Repo + connection + scope-health ("All required scopes proven", repo + pull_request:write), Rotate/Remove credential, PRs linked to tasks, **Execution branches** table, **Update status** (reconcile PR state from GitHub).

## Project — Activity (`/projects/:slug/activity`)
- **Stream** (All/Humans/Agents/System, typed events, filters) + **Audit logs** (policy & access, filters). The operator's reasoning is visible here.

## Project — Settings (`/projects/:slug/settings`)
- Project name/prefix/description/canonical-path. **Workflow stages** editor (add/remove/reorder/rename; boundary rewiring; points at Policy → Workflow rules). Members (roles). Repository & credentials (Repair).

## Project — Review queue (`/projects/:slug/review`)
- "Waiting on your acceptance" + "Still in review" sections. Human-acceptance-focused. Note: "Accepting a completion merges its review PR, when there is one … always a human action, always in the audit log." Clear empty states.

## Org — Instance settings (`/org/settings`)
- **GitHub connections** — installed PAT connections + health.
- **Users & access** — whitelist-based sign-in ("no invite emails, access on first login"), **Allow access** (Local/GitHub/Google, instance role Admin/Member, generated temp password), per-user Local/Admin/Member + edit/disable/remove, **Run concurrency** cap, **Audit log** (downloadable / S3 export).
- **Sign-in & SSO** — local-accounts-only by default; GitHub/Google OAuth configurable (off here) with callback URLs. "Credentials set here override env; who may sign in is still the whitelist."
- **Agent resources** — Knowledge bases (create/browse/re-scan/edit/delete), MCP servers (HTTP/stdio, credential, "real handshake on save"), Skills, Global agent profiles (library). This is where org-level KB/MCP/skill/profile CRUD lives.

## Insights (`/insights`)
- Analytics: total runs, total cost, output tokens, completion rate, avg run time, turns; "Runs · last 30 days" chart; by-backend and by-run-kind cost/count breakdowns. Accurate against the run log.

## Modals (all captured)
- New project (name/prefix/connection/repo/workflow/policy-preset), New task (title/goal/priority/due/labels), New KB, Add MCP (HTTP/stdio), Create/Edit profile (backend/model/effort/stages/persona + CapabilityGrants accordions + ResourcePicker), acceptance disclosure, decision/blocked packets (options + Confirm decision), destructive-archive confirm ("cannot be undone").

## Overall UX read
Highly coherent and honest. Consistent design language (one app.css token system), plain-language disclosures everywhere (permissions, acceptance, delivery, refusals), clear empty states, and a strong "governed autonomy" through-line: agents act, humans govern via explicit acceptance/policy, and every governed action is audited + surfaced. One coherence bug found (F7, fixed). Product-design questions in PRODUCT-CRITIQUE.md.
