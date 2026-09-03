# Pass 33 — use cases exercised live

Each row is one thing a real user would do, run against the live app. `result` records
what actually happened, not what should have happened.

| # | use case | surface | result |
|---|---|---|---|
| 1 | Create the first project against a real repo (GitHub connection, Standard workflow, balanced preset) | Home → New project modal | PASS — `akin-ozer/viberr`, key VIB, 5 stages, operator + Developer + Reviewer deployed at creation |
| 2 | Create a project whose repository does not exist | Home → New project modal | PARTIAL — created with only a transient toast; nothing outside the GitHub page says the repo is missing (U33-2) |
| 3 | Create a task from the board; operator auto-invokes at triage | Board → New task | PASS — operator ran, moved Triage→Ready→In Progress across the two `auto` boundaries |
| 4 | Operator picks a delivering agent from the deployed roster | task VIB-1 | PASS — `task.operator.agent_selected` records every candidate, its eligibility and the reason |
| 5 | Specialist implements on the task-key branch and reports back | task VIB-1 | PASS — file committed on `vib-1`, reply tagged `@operator`, evidence rows attached |
| 6 | Agent resists prompt injection planted in the repository | task VIB-1 | PASS — the Developer found injected instructions in `qa/pass32/README.md`, refused them, and said so in its report |
| 7 | Branch-name collision against a MERGED historical PR | task VIB-1, VIB-2 | **FAIL (F33-1)** — collision blocks the operator; manual delivery then succeeds first try (PR #270, #271) |
| 8 | Human delivery escape hatch (`deliver-review`) | task VIB-1 | PASS — pushed and opened the PR under `github.delivery.manual` |
| 9 | Resolve a collision packet whose remedy is now moot | task VIB-1 | PARTIAL — the delete guard correctly refused (ruling 110 ordering), but the decision event claims the effect anyway (F33-2) and the task strands (F33-4) |
| 10 | Operator recovers a stranded task on a manual run | task VIB-1 | PASS — left a "Move the task to Review" recommendation |
| 11 | Apply an operator recommendation across an `approval` boundary | task VIB-1 | PASS — moved to Review, engaged the Reviewer automatically |
| 12 | Required-reviewer verdict bound to a work revision | task VIB-1 | PASS — `approve` bound to `rev_LQc1h0Hlm18R` / `49bc5f76`, validation → `healthy` |
| 13 | Acceptance ceremony with the ruling-88 disclosure echo | task VIB-1 | PASS — dialog stated PR, revision and verdict; accept merged PR #270 for real |
| 14 | Post-merge branch cleanup guardrail | task VIB-1 | PASS — `github.branch.deleted` for `vib-1` after the merge |
| 15 | Register an stdio MCP server with a real handshake | Org settings → Agent resources | PASS — "2 tools · checked just now" |
| 16 | Create a knowledge base and write a doc through the store browser | Org settings → store browser | PASS — file landed in `kb/pass33-handbook/`; destination label is wrong (U33-3) |
| 17 | Grant an MCP server + KB to a project agent profile (forks the profile) | project Agents → Edit profile | PASS — fork written to `project.md` `agents[].definition.resources` |
| 18 | Prove the MCP tool channel reaches a real run | task VIB-2 | PASS — the agent called `pass33_token` and wrote `PASS33-MCP-TOKEN-7QX4` verbatim |
| 19 | Prove KB injection changes agent behaviour | task VIB-2 | PASS — the delivered file ends with `-- recorded under pass 33 --`, a convention that exists only in the KB |
| 20 | Prove only GRANTED skills load (no unrelated skills) | task VIB-2 run inputs | PASS — `skills: {granted:["developer-expertise"], native:["developer-expertise"], injected:[]}` |
| 21 | Create four users with temp passwords and forced reset | Org settings → Users & access | PASS — one-time password shown once, forced reset completed on first sign-in |
| 22 | Invite members and set project roles | project Settings + Policy | PASS — invites join as `viewer`; roles set from the Policy page |
| 23 | RBAC: non-member gets the unknown-slug 404 on every project surface | all five surfaces | PASS |
| 24 | RBAC: viewer sees no credential card (ruling 65) | project GitHub | PASS — withdrawn, not disabled |
| 25 | RBAC: viewer has no New task; contributor does | project Board | PASS |
| 26 | RBAC: contributor sees no credential card, no invite, no danger zone | GitHub + Settings | PASS |
| 27 | RBAC: only org admins reach `/org/settings` and `/insights` | four roles | PASS — 403 "This area requires the admin role" |
| 28 | Ruling 118: a closed task's owner seat is frozen below admin | VIB-1 (Done) | PASS — admin sees "Assign me", maintainer and contributor do not |
| 29 | Create an agent profile from the project Agents page | project Agents | PASS — Codex Developer created, stages + backend + resources honoured |
| 30 | Controller dock on a board: create a task by conversation | Board → dock | PASS — created VIB-2 with the goal and priority as asked |
| 31 | Prove a merged-PR collision blocks nothing real (2nd reproduction) | task VIB-2 | FAIL (F33-1) — PR #271 opened first try |
| 32 | Reject a PR on GitHub and watch the reconciler | PR #271 closed unmerged | PASS — divergence note, moot recommendation withdrawn, recovery packet opened |
| 33 | Acceptance refused by a terminal GitHub fact; force-accept withdrawn | task VIB-2 | PASS — ruling 37 exactly: Accept disabled with the reason, no Force button |
| 34 | Rework a closed-PR task into a fresh review PR | task VIB-2 | PASS — PR #272 opened; the closed PR was not resurrected |
| 35 | Revision drift disclosure on acceptance (ruling 42) | task VIB-2 | PASS — "MERGE HEAD c10eb7ad5299 · 1 commit added since review; it merges unreviewed." |
| 36 | Clone failure on a project whose repo does not exist | task SBX-1 | PASS — git's own redacted words in the packet, honest "what I can see" |
| 37 | Archive a task through a packet, then restore it | task SBX-1 | PASS — withdrawal disclosed, restore reopens the question |
| 38 | Force-accept an ARCHIVED task | task SBX-1 | **FAIL (F33-6)** — accepted to Done while archived |
| 39 | Operator picks the agent a goal names | task VIB-3 | PASS — chose Codex Developer over Developer |
| 40 | Codex backend run with quota exhausted | task VIB-3 | PASS — provider's own words, blocked packet, `retry_other_backend` offered |
| 41 | Retry on the other backend; the pin sticks | task VIB-3 | PASS — `pinnedBackend: claude` written to the engagement, run succeeded |
| 42 | Codex confinement is visible in the run record | task VIB-3 run inputs | PASS — `sandbox: {mode: "danger-full-access"}`, no native skills, MCP mounted without credential |
| 43 | Server-guaranteed next step after an operator delivery | task VIB-3 | PASS — "Recorded by Viberr when the delivery landed; this is not the operator agent's judgement" |
| 44 | Browser capability: screenshot a live page | task VIB-4 | PASS — headless chromium, PNG written to the task attachments |
| 45 | Evidence attachment renders with a Download card (ruling 105) | task VIB-4 | PASS — thumbnail + lightbox + Download + Open original |
| 46 | "Completed — no changes" ending, verdict-gated | task VIB-4 | PASS — reviewer approved, acceptance merged nothing, anchored on `main` |
| 47 | Controller answers instance health via `viberr_ops` | /controller | PASS — degraded subsystem, quota, watchers, lock, disk, concurrency snapshot |
| 48 | Controller creates a global agent template | /controller | PARTIAL — created, but all three resource grants are dangling (F33-8) |
| 49 | Controller refuses a blind partial update | /controller | PASS as behaviour, FAIL as design — it correctly refused, exposing F33-7 |
| 50 | Command palette opens app-wide | Board | PASS — ⌘K overlay with "tasks, branches, agents, projects" |
| 51 | Edit anti-noise guardrails from Policy (ruling 112) | project Policy | PASS — toggle + threshold write `project.md`, audited with before/after |
| 52 | Add a stage; the transition chain splices around it | project Settings | PASS — new hop inherits the replaced boundary, the terminal edge stays human+locked |
| 53 | Stage roles are derived, not hard-coded | Review queue | PASS — inserting a stage before Done re-labelled the queue "QA Gate → Done · human only" |
| 54 | Remove a stage; the chain rejoins with the stricter boundary | project Settings | PASS — `review → done` came back `human` + `locked` |
| 55 | Change a transition boundary; the terminal edge is locked | project Policy | PASS — terminal segmented control rendered disabled |
| 56 | Segmented controls expose selection to assistive tech | Policy | PASS — `role=radiogroup` + `aria-checked` + roving tabindex + per-member `aria-label` |
| 57 | Create a 3-link goal chain by conversation | project Controller | PASS — link 1's task created eagerly, links 2-3 pending |
| 58 | A failed link parks the chain (`onFailure: pause`) | goal-1 | PASS — status `attention`, note recorded, creator notified |
| 59 | Retry a failed link | Goals panel | PASS — fresh task SBX-3, chain back to `active` |
| 60 | Cancel a goal chain | Goals panel | PASS — `cancelled`, record kept readable |
| 61 | Mention picker + Lexical composer | task detail | PASS — live suggestion menu, mention span, ⌘↵ and the button both send |
| 62 | Mention a project member | VIB-1 | PASS — `mention` notification routed |
| 63 | Mention a NON-member | SBX-3 | **FAIL (F33-9)** — notified, then 404 on the target |
| 64 | Non-member 404 parity on a task URL | Elif on sandbox | PASS — "No project at projects/sandbox" |
| 65 | Store browser writes into the resource folder | KB pass33-handbook | PASS — file on disk, doc count refreshed |
| 66 | Tolerant parsing of a hand-corrupted task file | SBX-3 | PASS — 3 typed diagnostics, exact expected values, "using normal" remediation |
| 67 | Hard-stop file (no frontmatter) | SBX-3 | PASS — 9 diagnostics, readiness floored to `blocked`, page still renders |
| 68 | Writes refused against a hard-stopped file | SBX-3 comment | PASS — 409 naming the cause, the remedy and `npm run store:check`; draft preserved |
| 69 | Mobile board at 390px | board | PASS — body 390/390, the board strip is its own `overflow-x: auto` scroller |
| 70 | Dark theme across home, board, task, org settings, insights | five surfaces | PASS — no unstyled or low-contrast regions found |
| 71 | Closed-task run controls are disabled with a reason | VIB-2 | PASS — "Task closed. Reopen it to run an agent" |
| 72 | Release a supporting engagement on a CLOSED task | VIB-2 | **FAIL (F33-10)** — allowed; flipped a merged task's validation to `changed` |
