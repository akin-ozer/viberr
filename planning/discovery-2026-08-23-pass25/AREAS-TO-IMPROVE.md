# Pass 25 — areas to improve (product-gaps / what-to-build discovery)

This is a PRODUCT-GAPS map, not a bug list — a separate pass covers code defects
and UI/runtime honesty mismatches (see `planning/discovery-2026-08-21-pass23/AREAS-TO-IMPROVE.md`
for that family; none of its items are re-listed here). Every item below was
verified against the tree at branch `fix/pass25-discovery` (merged main after
pass 24), grepped or read directly — not inferred from copy or memory. File
paths are relative to the repo root.

Severity: **HIGH** = materially limits the core value proposition or a real
governance/ops need as the product scales past a demo; **MEDIUM** = a real,
worthwhile improvement with a workaround today; **LOW** = polish.

Classification: **DELIBERATE** = the PRD or an owner ruling explicitly scopes
this to Phase 2/3 or explicitly declines it; **GAP** = not called out anywhere
as deferred — plausibly an oversight rather than a choice; **PARTIAL/RESOLVED**
= a prior pass already closed part of it.

Read first: `planning/planning-artifacts/prd.md` §Product Scope (MVP/Growth/
Phase 2/Phase 3), `docs/architecture/decisions.md` rulings 1–97 (esp. ruling 2
capability model, ruling 15 workflow templates, ruling 13 no-mailer-in-V1).

---

## Summary of method

Six focused code investigations (agent profiles/governance, analytics/audit
export, task-graph/board ergonomics, validation/testing depth, ops/
observability, collaboration/onboarding/navigation) were run against the live
tree, each returning file:line evidence, then spot-checked directly (storage
visibility, task-schema fields, concurrency config, export routes, webhook/
mailer presence). Findings below are the genuine gaps that surfaced; a fair
amount of apparent "missing" behavior turned out to be either already fixed
(pass 23's storage-visibility gap, C9, is now partially resolved) or exactly
as deliberately scoped in the PRD (task-graph/subtask orchestration has zero
code, matching FR11's explicit deferral).

---

## 1. Declared-but-unbuilt / partial features (Phase 2/3 territory)

These map to the PRD's own Growth/Phase-2 list. For each, the question isn't
"is this missing" (yes, deliberately) but "how big is the remaining gap, and
is any of it cheap enough to pull forward."

### PG-1 — Analytics/reporting: zero aggregate or trend surface, but the data foundation already exists
**HIGH** · DELIBERATE (PRD Phase 2: "analytics on throughput, governance load, and task health") but unusually cheap to start

Confirmed absent everywhere: no dashboards, no charts, no cycle-time/lead-time/
throughput computation anywhere in the tree (whole-repo grep for those terms
returns zero product hits). What exists today is point-in-time counts only —
`app/features/home/home-query.server.ts` (stage distribution, live running-run
count, waiting count), board column counts (`app/features/board/board-page.tsx`),
a single review-queue count, and a Policy-page "last change" chip.

But the raw data a Phase-2 analytics feature needs is already captured with
**no new instrumentation**: `agent_runs` (`db/migrations/0001_baseline.sql`)
carries `started_at`/`finished_at`/`turns`/tokens/`total_cost_usd`/model/backend
per run; the task.md timeline records every `transition` event with
`occurredAt`, so stage-to-stage cycle time is *derivable* (not stored, but
computable) by diffing consecutive transition timestamps; `audit_events` has
actor/action/project/task shape sufficient for a governance-load rollup
(decisions, force-accepts per week), bounded by the existing 90-day retention.

What to build: a lightweight "Insights" view — per-project throughput
(tasks reaching Done/week), derived cycle time per stage, run cost/token
totals (already captured, just unsurfaced), governance load (decisions/
force-accepts per week) — as a derivation layer over existing tables, not a
new instrumentation project.

### PG-2 — Audit/history export: literally zero export path anywhere
**HIGH** · DELIBERATE (FR33: "Audit export is Phase 2") but worth reconsidering given retention

FR33 already states org- and auth-scoped audit events (sign-in outcomes, user
administration, PAT changes, connection-token replacement) have no file
backing and are genuinely and permanently gone after the 90-day retention
sweep (`AUDIT_RETENTION_DAYS = 90`, `app/server/db/retention.server.ts:30`).
Confirmed: the only download-capable routes in the app are `resources/
session-export` (a bash installer carrying a provider CLI transcript,
unrelated) and `task-attachment` (per-task files). There is no CSV/JSON/API
export for audit events, activity, or task history anywhere.

The Activity page (`app/features/activity/activity-page.tsx`) already has the
hard part built — free-text search, type/actor filters, and a from/to date
range (`app/features/activity/feed-limits.ts`) — so a minimal export is
mostly a thin "download what you're already viewing" layer, not new query
plumbing.

### PG-3 — Task-graph & subtask orchestration: confirmed zero implementation, exactly as declared
**INFORMATIONAL** · DELIBERATE — confirmation, not a gap

FR11 explicitly: task-graph and subtask orchestration "is scoped post-MVP."
Verified directly: `app/schemas/task-file.schema.ts` (the full 1400+-line
canonical frontmatter contract) has no `parentTask`, `subtasks`, `dependsOn`,
`blockedBy`, or `epic` field, and no board/task-detail code references any
such relation. The one-file-per-task model has no structural way to link two
tasks. Recorded here only so a later pass doesn't re-discover this as "new."

### PG-4 — Agent-profile richness: mature groundwork, several Growth-phase gaps still open
**MEDIUM** · DELIBERATE (PRD Growth: "richer reusable agent profiles," "stronger policy tooling")

What's already solid: a two-layer org-template → project-deployment model
with fork-on-edit (`app/features/agents/create-profile-modal.tsx`), a deep
capability catalog with per-capability runtime-enforcement-scope tracking and
cross-grant coupling repair (`app/shared/capabilities.ts`), and a capability-
gap decision packet that names its own remedy (ruling 85 / R21-2).

Absent: no clone/duplicate/export/import of a profile or template (single-
instance only, no cross-org sharing); drift visibility is one-directional —
the org template modal shows adopting projects only as a bare **count**
(`app/server/org/gagents.server.ts` `usedByProject`), never which projects
have forked/drifted, so an admin can't audit template adoption from the
template side; no per-stage model pinning (`AgentProfile.model` is a single
field — a profile spanning triage + implementation runs both on the same
model, no cheap-fast/strong-slow split); no structured capability-request
object (only prose inside a generic packet, see PG-15).

What to build: cross-project drift visibility from the template side first
(cheapest, highest audit value); per-stage model override second; profile
clone/duplicate is the cheapest of the versioning asks.

### PG-5 — Validation/testing: a coarse self-report layered on solid governance plumbing
**MEDIUM** · DELIBERATE (PRD Growth: "deeper validation/testing workflows")

`validation` (`app/schemas/task-file.schema.ts`) is a flat 5-value enum
(`healthy | changed | failing | none | bypassed`) derived purely from
reviewer verdicts — one `{result: approve|request_changes, reason: string}`
per revision. No pass/fail counts, no test names, no coverage. There is no
distinct QA/Tester role — it was explicitly merged into Reviewer
(`app/server/seed/agent-catalog.server.ts`). GitHub CI check-runs ARE read
(`app/server/github/pr-linker.server.ts`) but rolled up into only
`{total, passing, failing, pending, unknown}` — no per-check name, log, or
link. Test execution isn't a distinct governed capability; it's ordinary
shell use inside the generic `execute-code-or-write-repo` grant, with no
captured structured output — a human sees only a colored `ValidationPill`
badge, never raw results, unless they open the agent's run log.

What to build, in rough size order: (1) surface per-check name/conclusion/URL
instead of the 4-bucket rollup — cheapest, reuses data already fetched; (2) a
structured test-result schema (suite/pass/fail/skip counts, failing names)
replacing the flat enum's "reason" free text; (3) a first-class "run tests"
capability that captures command + exit code + output as a task artifact,
distinct from generic code execution; (4) coverage-delta surfacing (no
coverage concept exists anywhere today — the largest lift of the four).

### PG-6 — Small-team collaboration ergonomics: two cheap wins buried inside a real deferral
**MEDIUM** · DELIBERATE (PRD Growth: "stronger small-team collaboration ergonomics") — two sub-items are cheap enough to consider pulling forward

@mention autocomplete is genuinely well-built (`app/features/task-detail/
comment-composer.tsx` — full keyboard nav, merged agent/user/reserved-handle
directory). The team roster exists (`MembersPanel`) but is buried inside
Project Settings; the rail only shows a member *count* linking to `/`, not the
roster.

Absent: viewer presence (no "who else is looking at this task" anywhere —
zero UI hits); draft-comment persistence (`app/features/task-detail/
timeline.tsx` keeps the composer draft in a bare `useRef` — an accidental
navigation or reload silently discards an unsent comment); a genuine
cross-project "my open items" list (Home shows only a plain-text aggregate
count of decisions waiting on the viewer across projects, not a link to a
list; Notifications is a notification-feed, not a task worklist) — a member
on 3 projects must open each board separately to see their own work.

Of these, draft-comment persistence (a `localStorage` write, essentially) is
disproportionately cheap relative to how much trust it costs when it's
missing — worth flagging as a candidate to pull forward independent of the
rest of the Phase-2 collaboration work.

---

## 2. UX coherence / holism (genuine gaps — not called out as deferred anywhere)

### PG-7 — No guided setup after project creation
**MEDIUM** · GAP

The new-project modal (`app/features/home/new-project-modal.tsx`) bundles
repo connection and an agent policy preset, but nothing nudges the creating
admin to invite teammates afterward — invite lives only in Org Settings'
Users tab or Project Settings' Members panel, unreferenced from the
post-create flow. The empty-board teaching line (ruling R15-10, "teaches
once") covers exactly one thing — creating a first task — and says nothing
about GitHub, agents, or the team.

What to build: a lightweight, dismissible post-creation checklist ("Invite
your team," "Review the seeded agent profiles," "Connect GitHub" if skipped)
consistent with R15-10's teach-once philosophy rather than a heavier product
tour.

### PG-8 — No product tour, shortcuts reference, or help entry
**LOW** · GAP

Zero "getting started"/tour/shortcuts-list surface exists anywhere; the only
discovery aid is the bare ⌘K hint chip on Home. This sits oddly next to real
keyboard-navigation investment already shipped (board arrow-key traversal
per ruling R19-10, dialog focus-trap/Escape/scrim-click everywhere) that a
new user has no way to discover exists.

What to build: a "?" help-menu entry or a static shortcuts panel — low
effort relative to the keyboard-interaction surface it would document.

### PG-9 — Board triage tooling doesn't scale past a handful of tasks per column
**MEDIUM** · GAP (distinct from NFR1's explicit render-scaling disclaimer — this is about triage ergonomics, not render performance)

`app/features/board/board-filters.ts` defines exactly 7 fixed, non-
configurable filter chips; free-text search is a single substring match with
no field-scoped syntax (no `owner:`/`label:`); there is no sort control at
all (age, urgency); there is no multi-select or bulk action (bulk move,
archive, reassign) anywhere in `board-page.tsx` — every board action targets
one card. Combined with PG-10 below, a maintainer on a 50-open-task board has
only a binary "urgent" flag and free-text search as triage tools.

What to build: a sort control and bulk-select-plus-bulk-move/archive first —
both are board-page-local additions, no schema change required.

### PG-10 — No lightweight task priority, labels, or due date (distinct from the deliberately-deferred full task-graph)
**MEDIUM** · GAP (adjacent to, but materially smaller than, the deliberately-deferred PG-3)

The only priority-like signal on a task is a binary `urgent` boolean
(`app/schemas/task-file.schema.ts`). There are no labels/tags, and no due
date (the sole date-ish field, `schedules[].dueAt`, is a scheduled operator
re-run time, unrelated). This is a much smaller ask than parent/child task
relationships — a flat priority scale, freeform tags, and an optional due
date could ship well ahead of full task-graph orchestration, but nothing in
the PRD explicitly scopes them one way or the other, so it's worth confirming
they're wanted as an interim step rather than assuming they arrive bundled
with the Phase-2 task-graph work (see Q5).

### PG-11 — Workflow-stage templates: "Standard 5-stage" is the only creation preset
**LOW** · DELIBERATE (ruling 15 explicitly killed the "Lightweight · 3 stages" preset) — noted only for completeness

Not a gap so much as a confirmed one-size-fits-all starting point; custom
stage lists remain fully editable per project after creation. Recorded here
only because "richer... policy tooling" (PRD Growth) could plausibly include
a small library of starting templates (e.g. a research/no-PR workflow) if the
owner wants to revisit ruling 15's scope later — not proposed as urgent.

---

## 3. Capability / governance model gaps

### PG-12 — No run-concurrency or rate-limit controls anywhere
**HIGH** · GAP

Confirmed zero: no admin-facing cap on simultaneous agent runs, per-project
or per-instance (grep across `app/server/runtimes` and `app/server/tasks`
for concurrency/rate-limit config returns only unrelated GitHub-API
rate-limit-remaining bookkeeping and internal prompt-injection char budgets).
Nothing in the PRD calls this out as deferred — it reads as an oversight
rather than a choice, and it's the kind of gap that only bites once a team
runs several tasks in parallel, which is exactly the "repeated use on
complex tasks" success signal the PRD names.

What to build: an admin-configurable max-concurrent-runs setting (per-project
and/or per-instance), enforced at run-dispatch time.

### PG-13 — No global "what's running right now" view for an instance admin
**MEDIUM** · GAP, cheap

`activeRunCount` already exists server-side (`app/server/db/maintenance.
server.ts`) but is used only to gate the maintenance pass — never exposed via
any route or the health endpoint. An instance admin overseeing multiple
projects has no single place to see all active agent runs at once; today
that requires opening each task individually.

What to build: surface the existing count (and ideally a per-project/per-run
breakdown) on the health route or a new admin diagnostics tab — low effort
since the underlying data is already computed.

### PG-14 — No outbound alerting channel for unattended-instance ops events
**MEDIUM** · GAP, but adjacent to a deliberate ruling — see Q7

GitHub-sync failures, disk-critical, and MCP-server-down states all surface
only as in-app notifications/toasts (confirmed: no SMTP/webhook/Slack
integration anywhere in `app/server`). Ruling 13 deliberately dropped mailer/
email preferences for *product* notifications in V1 — it's an open question
whether that posture was meant to extend to instance-operator ops alerting,
which is a different audience (see Q7).

### PG-15 — No structured capability-request/approval workflow
**LOW-MEDIUM** · GAP, adjacent to already-shipped honesty fix

Ruling 85 (R21-2) already has the operator name its own remedy in prose
inside a generic decision packet when it hits a withheld capability — a real
honesty improvement. But there's no structured "request this capability"
object an admin can approve/deny from a queue; today the admin reads the
prose and manually goes to edit the profile. Small win given the packet
mechanism and the remedy-naming logic already exist — this would mostly be
wiring a packet option that deep-links to (or directly performs, with
confirmation) the grant.

---

## 4. Agent-experience gaps

### PG-16 — No agent performance or success-rate signal anywhere
**HIGH** · GAP

Zero telemetry exists on which capabilities a profile actually exercises,
run success rate, average run duration, or packets-raised-per-profile
(whole-tree grep for these concepts returns nothing beyond a static
adoption count). An admin choosing between profiles or models has no
evidence base beyond trial and error — this directly undercuts both the
PRD's "stronger policy tooling" Growth promise and Journey 3 (Elif
configuring agent profiles, who "decides which specialists are eligible" and
would reasonably want feedback on whether her configuration choices are
working). It's also an agent-legibility gap in its own right: making agent
behavior visible to humans is a named discovery-brief category, not only a
cost-governance one.

What to build: even a minimal per-profile rollup (runs/success-rate/avg
duration/packets-raised, sourced from the already-captured `agent_runs`
table) would close most of this gap with no new instrumentation.

### PG-17 — Test execution isn't a first-class, captured governed action
**MEDIUM** · GAP (ties directly to PG-5)

An agent running tests today does so as ordinary shell use inside the
generic `execute-code-or-write-repo` grant; nothing captures structured
output as a task artifact. This makes agent behavior less legible — a human
can't see what the agent actually ran or found without opening the raw run
log — and it's the blocking dependency for any future validation analytics
(PG-1, PG-5).

---

## 5. Observability / ops

### PG-18 — Storage visibility is a single blended free-space line, no per-category breakdown
**LOW** · PARTIAL/RESOLVED (pass 23's C9 finding is now half-fixed)

Pass 23 flagged "storage has no visibility anywhere" (C9). That's now only
partially true: `StorageLine` in `app/features/org-settings/
org-settings-page.tsx` (explicitly commented "C9 (pass 23)") shows aggregate
disk free/used% and cleanup cadence. Still absent: a breakdown by category
(task workspaces vs. repo-mirror caches vs. attachments vs. the projection
DB) — an admin trying to decide what to prune sees only one blended number.

### PG-19 — No admin-facing "last boot report"
**LOW** · GAP

Boot-time reconciliation (`app/server/boot.server.ts`) is genuinely
extensive — orphaned-run recovery, stranded-operator-plan recovery,
workspace reclaim, projection-schema-drift detection, corrupt-DB self-heal —
but every bit of it is logged server-side only (`logger.info`/`warn`). An
admin has no UI surface showing what the last boot found or fixed; they'd
have to read raw server logs.

What to build: persist the boot-integrity summary and render it (even just
the last run's headline counts) somewhere in Instance settings/Diagnostics.

### PG-20 — Backup/restore is real, but CLI-only
**LOW** · GAP

A genuine backup/restore mechanism already exists — `npm run backup` uses
SQLite `VACUUM INTO` for a consistent hot snapshot plus a file-store copy and
manifest, with a matching `restoreBackup`/`restoreStoreFile` path
(`app/server/db/backup.server.ts`, `scripts/backup.ts`) — this is
meaningfully more capable than FR33's "snapshot the data root yourself"
framing suggests. It's entirely CLI-only, though: no admin-UI trigger,
schedule, or download link exists for an operator who isn't comfortable
shelling into the container.

---

## Questions for the owner

Each of these is a real product-design call, not an obvious fix — background
included so the tradeoff is visible.

**Q1 — Pull a first analytics slice forward, or wait for the full Phase-2 push?**
The data (`agent_runs` cost/tokens/timing, task-transition timestamps,
`audit_events`) already exists with no new instrumentation needed (PG-1); a
first "Insights" view is mostly a derivation-and-render layer over data
that's already captured. Is that worth shipping as a standalone slice ahead
of the rest of Phase-2 analytics, or should analytics wait and land as one
coherent feature?

**Q2 — Is a minimal audit/history export worth pulling forward given the retention bite?**
FR33 already scopes export to Phase 2, but combined with the 90-day
retention sweep, org- and auth-scoped events (sign-ins, PAT changes, user
admin) are *permanently* unrecoverable today with no export path at all
(PG-2). The Activity page's existing filters make a minimal CSV/JSON export
mostly a UI layer, not new query work. Worth doing as a small standalone fix
ahead of full Phase-2 reporting, or should it wait?

**Q3 — Is unbounded run concurrency intentional?**
There's no admin-configurable cap on simultaneous agent runs anywhere
(PG-12). Is that a deliberate bet on the deployment's host resources and the
provider account's own rate limits being the real backstop, or a genuine gap
worth closing as teams run more tasks in parallel?

**Q4 — How far should Viberr go into test/validation depth?**
Today, test execution is ordinary shell use with no structured capture; the
platform trusts the agent's self-reported verdict (PG-5, PG-17), the way it
might trust a human developer's "tests pass" claim, leaning on GitHub
Actions/CI for real depth. Is the intended long-term posture to stay a
governance/coordination layer and leave test depth to CI — or does the
Growth-phase "deeper validation workflows" promise mean Viberr itself should
become a structured test-reporting surface (captured output, coverage,
a dedicated capability)?

**Q5 — Should lightweight task metadata (priority/labels/due date) ship ahead of full task-graph orchestration?**
These are materially smaller than parent/child task relationships (PG-10 vs.
PG-3) and would help board triage well before the Phase-2 task-graph work
lands. Are they in scope as an interim step, or should they be assumed to
arrive bundled with task-graph orchestration whenever that's built?

**Q6 — Is the absence of per-profile cost/usage telemetry and budget caps intentional?**
Agent profiles carry no token/cost budget and no usage telemetry (PG-4,
PG-16) — an admin has no evidence for whether a profile/model is earning its
grants, and no way to cap spend. Intentional (trust the provider's own
billing/limits), or a genuine gap worth closing as "stronger policy tooling"
gets scoped for Growth?

**Q7 — Does the "no mailer in V1" ruling extend to instance-operator ops alerting?**
Ruling 13 deliberately dropped email/mailer notification preferences for
*product* notifications (task/project events, aimed at end users). There's
separately no outbound alert channel at all for ops-critical events (GitHub
sync dead, disk critical) aimed at whoever runs the instance (PG-14) — a
different audience with a different failure mode (nobody's watching the UI).
Is that the same "no mailer, ever" decision, or a distinct, still-open need?
