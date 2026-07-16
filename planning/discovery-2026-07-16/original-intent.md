# Viberr — Original Product Intent (PRD + mock design)

**Purpose.** This document reconstructs what Viberr was *supposed to be*, feature by feature, so a
reviewer can compare the current app against the original intent. It covers only the original side:
the PRD and the HTML mock prototype. Later owner rulings (documented in
`planning/discovery-2026-07-1{0,1,2}/` and memory) deliberately override parts of this — drift from
this doc is not automatically a defect.

**Sources read for this distillation:**

- `design/prd.md` — authoritative PRD (2026-03-30; scope simplified 2026-06-08; reviewer/commenting
  amendments 2026-07-04). Primary source.
- `design/CONVERSATION-SUMMARY.md` — design-session record of every mock screen built and every
  copy/UX ruling made during design iteration.
- `design/html-app/CONVERSATION-SUMMARY.md` — later design session: runtime logs, owner=reviewer model.
- `design/index.html`, `design/landing.html`, `design/design-system.html` — design language + marketing companion.
- `design/html-app/` — the interactive React mock (three HTML entry pages + `app/*.jsx`).
- `design/better-auth-migration.md` — current auth architecture (not original intent; noted where relevant).
- `planning/discovery-2026-07-10/product-intent.md` — prior distillation, reconciled below.

---

## 1. Elevator pitch and personas (as the PRD states them)

**Pitch.** Viberr is a multi-user web application for *governed AI software delivery*, built for
small AI-forward engineering teams that want persistent coding agents to do real delivery work while
engineers keep control of flow, review, and acceptance. The task is the canonical operating contract
between humans, agents, and GitHub execution: each task carries state, execution context, timeline,
decisions, and evidence in one readable file. A dedicated **operator agent** manages each active
task, **specialist agent threads** do the stage work, and humans govern through policy, comments,
decisions, and explicit acceptance of completion. V1 targets GitHub-backed delivery through a
familiar board/task interface that behaves differently underneath: **agents are the native workers,
engineers govern the flow, and review stays human-authorized.**

Positioning (PRD "Differentiators"): not "kanban with AI" — an agent-native responsibility model
with the canonical task file as the durable contract, persistent operator+specialist threads, and
PR-backed review tied to task progression. Explicitly *not* a GitHub-review replacement or a generic
AI assistant.

Deployment intent: self-hosted / on-premises, authenticated internal workspace, desktop-first SPA;
SEO and mobile are non-goals; narrow screens get "review-first" access only.

**Personas (PRD User Journeys):**

| Persona | Role | Journey |
|---|---|---|
| **Arda** | Senior engineer, daily supervisor (primary persona) | J1: supervises several persistent agent threads from the board; opens task detail to see current state, execution profile, latest decision packet, compact timeline. J2: intervenes on a drifted task via a typed blocking packet with recommended options. |
| **Elif** | Admin / operations, workflow owner | J3: configures a governed project — stages, allowed transitions, default repo, human RBAC and agent capability matrix (two separate surfaces), agent profiles (eligible stages, allowed actions, skills/MCPs/KBs, backend). Front-loaded design pays back in predictable behavior. |
| **Murat** | Escalation / support troubleshooter | J4: investigates a continuity failure — operator surfaced a continuity warning, specialist rehydrated from the canonical task file; provider-native thread available as a debug session, never the primary record. |
| *(mock-only)* **Selin** | Reviewer-role member in mock data | Appears as task owner on VIB-151. |
| *(mock-only)* **Deniz** | Registered app user, *not* a project member | Demonstrates FR4 app-wide commenting with the "app user · not in project" label. |

**PRD success criteria (abridged):** ≥90% of active tasks show unambiguous current owner, waiting
state, latest decision packet; ≥90% of executed tasks keep task↔branch↔commits↔PR traceability;
blocked tasks reach a human decision quickly via concise packets; timeline readability holds on
long-running tasks (timeline noise is called out as the #1 risk).

---

## 2. Feature inventory — what was promised, and where the mock shows it

Mock page references are files under `design/html-app/` unless prefixed with `design/`.

| Feature | What PRD / mock promised | Mock page | Notes |
|---|---|---|---|
| Multi-user authenticated access (FR1) | Sign in to shared workspaces. Local email/password + GitHub + Google OAuth; **whitelist** onboarding (no invite emails); admin-driven password resets for local accounts (forced new-password at next login) | `Viberr Login.html`, `app/login.jsx` | Design rulings: whitelist-only OAuth (whole Google org via `@company.com` allowed); test account `arda@viberr.dev`/2828. Session in `localStorage` in mock. Current app re-based auth on better-auth (`design/better-auth-migration.md`) — an implementation swap, not an intent change. |
| Home / project selection | Post-login landing: greeting by name, pinned/starred projects, project cards (stage-distribution meter, task count, "N agents running", "N waiting on you" pill, member stack, updated-at), grid/row views, New-project tile, empty state, store-strip Re-scan | `Viberr Home.html`, `app/home.jsx` | One board per project in V1. Cards deep-link into the workspace. |
| Project creation (FR5) | PRD: *admin* users create governed projects. Mock modal: name, task key (≤4 uppercase), **GitHub connection picked at creation** (sets repo root), repository, workflow template (Governed 5-stage vs Lightweight 3-stage), agent policy preset (Strict human-gate / Balanced / Autonomous within policy), "Completion stays human-authorized in every preset", creates `~/viberr/projects/<KEY>/` | `app/home.jsx` (New project modal) | Later ruling made creation self-serve for any org member (decision B) and wired the presets to real governance (S1) — both post-PRD. |
| Org-level settings | GitHub connections (PAT-only, multiple, scopes validated **at connect-time only**, min `repo · workflow · pull_request:write`, expiry shown, token never redisplayed); Users & access (whitelist, local-account resets, admin/member); Agent resources (knowledge bases, MCP servers, skills, global agent profiles — CRUD via popups) | `app/org-settings.jsx` (reached from Home `#settings/…`), `app/kb-browser.jsx` | KB/skills get a file-system browser: nested folders, multi-file upload, drag-to-upload onto a hovered folder, import from GitHub link, `SKILL.md` as the required skill marker (shown fully + editable). PAT-only (no GitHub App) was an explicit design decision. |
| File-native store (FR10, FR12) | Projects + tasks live in a file store inspectable outside the app; canonical task record at `.viberr/tasks/<KEY>/task.md` holding identity, goal, state, execution context, timeline, decisions, execution references; files created/edited directly are recognized and reconciled | shown across `app/task.jsx` (hero file path), `app/board.jsx` (Re-scan), Home store strip | "Files remain the only authoritative business state. Projections and external facts explain, not overrule." (`design/design-system.html` closing rule.) |
| Board supervision (FR24) | Kanban by stage; each card: key, readiness pill, title, specialist (agent glyph) or owner line, owner avatar stack, branch/PR trace, waiting tag ("waiting on you" blue hand vs "agent working" violet pulse); filter chips All / Waiting on me / Agent working / Needs attention; Board/List segmented toggle; per-column "+"; Re-scan | `app/board.jsx` | Default stages: Triage / Ready / In Progress / Review / Done. Board deliberately scrolls horizontally under ~1250px (narrow = review-first per PRD). No colored card edges/shadows (explicitly rejected). |
| Task creation (FR11) | New-task modal: title (required), stage chips (Done excluded), goal ("what done means — the operator and specialists anchor on this"; underspecified goals flagged at the triage quality gate); key auto-assigned; "creates a canonical task file in the store" | `app/board.jsx` (NewTaskModal) | Agents may also create tasks per FR11 ("users and authorized agents"). |
| Task detail, operator-first (FR25) | Order of the page: hero (key, title, stage/readiness/validation pills, canonical file path, goal) → **live run strip** → **decision packet** → execution profile → agent logs → typed timeline. Side rail: GitHub trace (repo, branch, diff stats, PR), Current state (stage, waiting-on, owner), Permissions summary + "View project policy" | `app/task.jsx`, `app/runs.jsx` | "Current state, execution profile, and latest decision packet before the ongoing timeline" is a PRD requirement, not styling. |
| Decision / blocking packets (FR26) | Typed packet from the Operator: kind pill (blocked/input), title, body, observations grid (key→value, code values mono), 2–4 radio options with one "operator pick", primary action = the selected option, secondary "Ask operator" (prefills `@operator` in composer). Structure: observed → changed → recommended → decision required | `app/task.jsx` (DecisionPacket); flagship examples: VIB-142 completion packet, VIB-160 blocked continuity packet in `app/data.js` | Journey 2's centerpiece. Accepting a completion: task → Done, PR flips to merged, completion event prepended, packet cleared. "Block on policy" routes to Settings; "Hold for runtime debug" records an audited debug session. |
| Typed important events (FR16, FR35) | Single chronology mixing comments with typed events. Mock vocabulary: `comment`, `agent`, `github`, `quality`, `transition`, `input`, `blocked`, `completion`, `assign`, `policy` — each with distinct icon/tone | `app/task.jsx` (Timeline), `app/data.js` | Quality flags, transition requests, blocked decisions, completion reports, policy violations are first-class. |
| App-wide commenting + @mentions (FR4, amended 2026-07-04) | Every registered user may comment on any task, including non-members (labeled "app user · not in project"); addressing via `@operator` / `@agent` / `@name` mentions only (addressee toggle buttons explicitly rejected); mention regex routes comment to agent | `app/task.jsx` composer; Deniz on VIB-153 in `app/data.js` | Hint lives in the textarea placeholder only. |
| Human owner = reviewer (FR37/FR38, added 2026-07-04) | One human owner per task = its reviewer and acceptance authority; task-scoped rights only; tasks may be unowned; any project member takes/releases self-serve; admins release anyone ("admin release" pill, audit trail); Manage ▾ menu (Take over / Hand off to member / Release…), packet-styled release confirm (Owner / Open now / After rows + hand-off chips); all changes are typed `assign` events | `app/task.jsx` (OwnerControl, ReleaseConfirm), owner on board cards/list | The final iteration of "task-scoped human reviewers". Specialist (agent) and owner (human) are separate fields. |
| Dedicated operator per task (FR18, FR20) | A persistent operator instantiated per active task: coordinates specialists, keeps the canonical file authoritative, produces packets; "never writes code and never closes a task itself" | `app/agents.jsx` (Operator profile, pinned under "Orchestration"), execution profile in `app/task.jsx` | See §4 for the full capability split. |
| Specialist profiles (FR9, FR14, FR19, FR21) | Reusable agent profiles: global base + project customization; eligible stages, permitted actions, permitted context resources (skills/MCPs/KBs), execution backend (**Codex or Claude Code, exactly one per profile**). Mock ships Developer, Reviewer, Tester, Consultant; tasks have one primary specialist + consultant specialists | `app/agents.jsx` (Profiles tab, Create/Edit modal), `app/data.js` AGENTS | Create/edit modal: plain-text Definition in user's words (AGENTS.md preview explicitly rejected — compiled backend-side); capability policy = 18-action catalog in 3 accordion groups, each Direct/Recommend/Human/Off. Later rulings removed Consultant and merged Tester into Reviewer. |
| Agent capability policy (FR8) | Per-project agent capability matrix, managed separately from human RBAC ("two surfaces, managed separately"); per-action level Direct / Recommend-only / Reserved-for-humans / Off; capability-matrix modal = every profile × every action, color-coded | `app/agents.jsx` (CapabilityMatrixModal), `app/policy.jsx` | Sensible defaults: merge, Done-transition, policy-change default to Human. |
| Human RBAC (FR2, FR8) | Role select per member; RBAC matrix of grants per role (see §5) | `app/policy.jsx` (Human access panel), `app/data.js` POLICY.rbac | |
| Workflow stages & transitions (FR6, FR13) | Project-defined stages with per-transition boundaries: mock select of *agent-allowed / human-only / operator-auto* (data model: `auto` / `approval` / `human`); Review→Done locked human; editable stages in Settings: drag-reorder (board updates live), inline rename, add/remove with guards (Triage first, Done last, non-empty stages protected) | `app/policy.jsx` (Workflow rules), `app/settings.jsx` (Workflow stages panel) | Default transition set in §4. |
| Triage quality gate (FR15) | Agents flag low-quality/underspecified tasks and request clarification before execution; Triage→Ready is a human approval "after the quality gate" | goal-field hint in `app/board.jsx`; transitions in `app/data.js` | |
| Review queue, human-only Done (FR27) | Split panels: "Waiting on your acceptance" vs "Still with agents"; rows show PR pill + validation pill + waiting tag; header lock "Review → Done · human only" links to Policy; note: "Accepting a completion merges the review PR and moves the task to Done — always a human action, always in the audit log" | `app/review.jsx` | The core governance invariant: only humans transition to `done`. |
| GitHub delivery & traceability (FR29–FR32) | Repo panel (project default, task-level override allowed, "Repos per task: 1 · V1 limit"); credential card with scope chips + missing-scope warning wired to the flagged task; PR list (branch → main · task key); execution-branches table (Task / Branch / PR / Sync) — "branch names and commit messages carry the task key"; Reconcile action | `app/github.jsx`; GitHub trace side rail in `app/task.jsx` | Sync health states: synced / behind main / merged. Merging reserved for humans (via completion acceptance). |
| Agent runtime visibility (FR23, FR28) | **Live run strip** while a run executes: pulsing indicator, phase + current step, ticking elapsed/token counters, model, View logs / Interrupt, dropdown for concurrent runs. **Agent logs panel**: per-thread dark console with simulated live streaming, run states running/idle/finished/continuity-error, `{ } raw` wire-JSON toggle. Log shapes verified against real Claude Code `stream-json` NDJSON and Codex SDK `runStreamed()` events | `app/runs.jsx`, RUNTIME in `app/data.js` | FR23: authorized users may open an agent's native runtime session for debugging — recorded per audit policy (RBAC row "Open agent runtime sessions"). FR28: progress must be reviewable *without* raw provider logs — the logs are the escape hatch, not the primary surface. |
| Continuity & re-anchor (FR22, Journey 4) | Persistent threads resume across stages; any reactivated agent re-anchors on the canonical task file; provider-history loss degrades gracefully with an operator continuity warning + blocked packet offering recovery paths (resume rehydrated thread / fresh specialist / hold for runtime debug) | VIB-160 packet + continuity-error stream in `app/data.js` | A "Continuity / Anchored to task.md" row in the execution profile was built then removed (design ruling). |
| Activity & audit (FR33, NFR18) | Two-column page: day-grouped activity stream (filter All/Humans/Agents/System, actor-typed icons, task deep links) + **Audit logs** panel (violations, blocked agent actions, policy changes, runtime-session opens; violation pill open→resolved) | `app/activity.jsx` | Audit examples in mock: blocked Codex merge attempt, Murat's runtime-session open, Elif locking Review→Done. |
| Project settings (FR5–FR7, FR36) | Project panel (name, task prefix, description, canonical-file kv); workflow stages editor; Members panel (invite → Viewer w/ pending pill, remove guards: not self, not last admin); Repository & credentials (default repo, task-override toggle, repos-per-task limit, credential card, grant-scope flow resolving the policy violation); Danger zone (archive/delete, RBAC-denied for maintainer) | `app/settings.jsx` | A quality-gate settings panel was built then removed (ruling). |
| Manual re-scan / reconciliation (FR36) | "Re-scan" on Board + Home store strip ("board matches the file-native store"), "Reconcile" on GitHub page | `app/board.jsx`, `app/github.jsx`, `app/home.jsx` | Recovery affordance for missed change detection. |
| Notifications | Bell + unread badge on both Home and workspace headers; popup lists packets/approvals/mentions/policy/quality with deep links straight to project/task; "See all" opens a **popup overlay** (not a page): "Waiting on you" (packets + approvals) above "Everything else"; All/Unread filter, mark-all-read; read-state shared across surfaces; stream is global to the user across projects | `app/notifications.jsx`, bell in `app/main.jsx` + `app/home.jsx` | **No email notifications** (design ruling: in-app only, and don't say "in-app"). Resolving a packet clears its notification. |
| Profile & preferences | Popup overlay (not a page): editable display name/title (email managed by identity provider); notification routing per typed-event kind with in-app/email toggles + waiting-on-you reminder stepper; read-only "Your access" RBAC view; Appearance (theme Light/Dark/System, reduce motion, default timeline filter); GitHub identity (personal OAuth attribution, distinct from project execution credential) | `app/profile.jsx` | Full dark theme + FOUC guard + `prefers-color-scheme` tracking were built into the mock. "Sessions & security" panel built then removed (ruling). |
| Anti-noise guardrails (PRD MVP list) | Five named guardrails, shown as policy: `meaningful-comment` (status chatter rejected), `operator-brevity` (packets keep observed→changed→recommended→decision), `no-duplicate-summary` (restating summaries dropped), `compression-threshold` (timelines compress past ~40 events; typed events always kept), `evidence-separation` (raw validation output stays in evidence refs, never inline) | `app/data.js` POLICY.guardrails | PRD frames these as product features mitigating its #1 risk (timeline noise / process theater). |
| Secrets isolation (FR34, NFR7) | Secrets never in timelines/comments/audit/logs; PAT masked (`github_pat_••••42af`), never redisplayed; "Secrets stay isolated from task records and timelines" copy on GitHub page | `app/github.jsx`, `app/org-settings.jsx` | A "Secrets · Isolated" row in the task Permissions panel was explicitly removed (ruling) — enforced, not advertised. |
| Search | Topbar "Search tasks, branches, agents…" with ⌘K affordance | `app/main.jsx` | Never functional in the mock — see §6. |

---

## 3. Page / screen inventory of the mock design

### Design-language / marketing surfaces (`design/`)

| File | Purpose + notable affordances |
|---|---|
| `design/index.html` | Cover/launcher for the design package: intro card ("Miro-inspired design language for a governed AI delivery tool"), hero task-card + decision-packet vignette (VIB-142), links to the design system ("01 System — foundations and components") and landing page ("02 Companion — marketing surface"). |
| `design/landing.html` | Marketing landing ("Viberr — Governed AI Delivery"): hero with embedded product mock (rail nav Board 18 / Review 4 / Policy 2 / GitHub healthy, canonical-source path, three task cards, decision packet "Human acceptance gates done"); three value props (file truth / operator model / review gate); 4-step operating loop (Author task → Assign operator → Execute in GitHub → Accept completion); "Humans govern. Agents execute. Files remember."; early-access request form (work email + team context). |
| `design/design-system.html` | Design system v1: color tokens (pastel semantic surfaces — teal=ready, orange=input, red=blocked; `#5b76fe` primary), type (Roobert PRO display / Noto Sans body / JetBrains Mono for keys, branches, evidence), radius scale (8px buttons → 44px canvas), **readiness state vocabulary** (`ready`, `input_required`, `inconsistency_risk_detected`, `blocked` — "readiness is separate from workflow stage"), core components (task card, decision packet, operator panel, GitHub trace, policy chip set, typed timeline), task/policy/GitHub surface patterns, responsive-workspace mock (board/detail/inspector on desktop; narrow collapses to prioritized task context + sticky actions — includes an "SSE live" chip later banned from the product), closing rule "Files remain the only authoritative business state", implementation note "built for React Router surfaces, route-local state, SSE revalidation, and file-authoritative workflows". |

### Interactive app mock (`design/html-app/`)

Three HTML entry pages (React + Babel, shared mock data in `app/data.js`):

| Screen | File(s) | Purpose + notable affordances |
|---|---|---|
| Login | `Viberr Login.html`, `app/login.jsx` | Local email/password with distinct inline errors (unknown email vs wrong password); GitHub + Google buttons (whitelist-check stubs); forced set-new-password flow after an admin reset; tagline "Self-hosted · collaborative agentic AI delivery"; session redirect loops with Home/workspace. |
| Home (project selection) | `Viberr Home.html`, `app/home.jsx` | Greeting with session name; Pinned + All projects (card grid and row list); project cards: stage-distribution meter, "N tasks · N agents running / quiet", "N waiting on you" pill, member stack, star/pin; New-project tile + modal (name, task key, GitHub connection, repo, workflow template, policy preset); org Settings tiles (GitHub connections / Users & access / Agent resources with live counts); store-strip Re-scan; empty-state hero ("Create your first governed project"); header bell + avatar menu identical to workspace. |
| Org settings | `app/org-settings.jsx` (Home `#settings/…`) | Three tabs. **GitHub connections**: PAT rows with required-capability chips + expiry, add/update via popup (token write-only, validate-on-apply), Re-scan. **Users & access**: whitelist entries (email or Google domain), local-user creation, edit/reset-password popups, admin/member roles. **Agent resources**: Knowledge bases, MCP servers, Skills, Global agent profiles — each with create/update/delete popups. |
| KB / skills browser | `app/kb-browser.jsx` | File-system browser for the predefined KB folder: nested folder creation, multi-file upload, drag-to-upload onto hovered folder, import-from-GitHub link, hover actions, confirm-on-delete; skills variant keeps uploaded folder intact and treats `SKILL.md` as the marker (rendered + editable). |
| Workspace shell | `Viberr Operator Workspace.html`, `app/main.jsx` | Left rail: project switch ("Viberr Core · akin-ozer/viberr · N members"), nav **Board / Review queue / Agents / Policy / GitHub / Activity / Settings** with live counts (board total, review count, violations badge on Settings); topbar: V-logo → Home, breadcrumbs, ⌘K search, bell, avatar menu (Profile & preferences, Switch project, Theme cycle, Sign out); hash routing incl. `#task/VIB-xxx`; toasts; profile + notifications as overlays. |
| Board | `app/board.jsx` | Agent-aware kanban (5 columns fitting laptop widths); cards with readiness pill, specialist/owner identity line, owner avatar stack, branch/PR trace, waiting tags; filter chips (All / Waiting on me / Agent working / Needs attention); Board/List toggle; Re-scan; New-task modal; per-column "+"; List view with stage pills. |
| Task detail | `app/task.jsx` | Operator-first layout: hero (key, title, stage + readiness + validation pills, `.viberr/tasks/<KEY>/task.md` path, goal); live run strip; decision packet (observations grid, radio options with "operator pick", resolve + Ask operator); Execution profile (Operator, primary specialist, consultants, human owner with Manage ▾ take/hand-off/release + admin release, release confirm dialog); Agent logs panel; typed timeline with day-prefixed times + comment composer (@mentions, violet-highlighted); side rail: GitHub (repo/branch/diff ±/PR, Open on GitHub), Current state (stage/waiting-on/owner), Permissions summary → Policy. |
| Agent runtime (in task) | `app/runs.jsx` | Live run strip (only while executing): pulsing state, phase + current step, ticking elapsed + token counters, model, View logs / **Interrupt** (stub), concurrent-run dropdown; Agent logs: per-thread dark console, states running/idle/finished/**continuity error**, simulated streaming with auto-follow, event counts, `{ } raw` toggle showing exact Claude `stream-json` / Codex `runStreamed` wire JSON. |
| Review queue | `app/review.jsx` | "Waiting on your acceptance" vs "Still with agents" panels; rows: key, title, packet/latest-event subtitle, PR pill, validation pill, waiting tag; "Review → Done · human only" lock → Policy; acceptance note (merges PR, moves to Done, always audited). |
| Agents | `app/agents.jsx` | Stats strip (profiles approved / operators running / specialists working / threads waiting on a human — derived live); **Profiles** tab master-detail: Operator pinned under "Orchestration", specialists grouped; detail hero (glyph, role pill, running-on-N badge, Delete/Edit) + panels: Eligible stages (ineligible struck), Capability policy (Acts directly / Recommends only / Reserved for humans), Context resources & runtime (skills/MCP/KB chips, backend, model), Active deployments (→ task); **Live** tab: agent roster table (Agent / Backend / Task / Engagement / Status); Create/Edit profile modal (name, role, single-select backend, eligible stages, plain-text Definition, 18-action capability catalog with Direct/Recommend/Human/Off segmented controls, resource toggles); Capability-matrix modal (profiles × actions, color-coded). |
| Policy | `app/policy.jsx` | "Human access and agent capability — two surfaces, managed separately": Human access (role select per member) beside Agent capability; Workflow rules: per-transition boundary select (agent-allowed / human-only / operator-auto), Review→Done locked; collapsible matrix. |
| GitHub | `app/github.jsx` | Repository panel (default repo, connected pill, task-attachment note, "Repos per task: 1 · V1 limit"); credential card (masked PAT, scope chips, missing `pull_request:write` warning → flagged task + Fix in Settings); Pull requests panel (branch → main · task key, in review/merged); Execution branches table (Task / Branch / PR / Sync: synced / behind main / merged); Reconcile; human-only-merge note. |
| Activity | `app/activity.jsx` | Day-grouped stream (Today live from task timelines, older curated) with All/Humans/Agents/System filter, actor-typed icons, task key deep links; Audit logs panel (violation / blocked-action / change / audit kinds; violation pill open → resolved after scope grant). |
| Project settings | `app/settings.jsx` | Project panel (name, VIB prefix, description, task-key + canonical-file rows); Workflow stages editor (drag-reorder updates board live, inline rename, add/remove with Triage-first/Done-last locks and non-empty guard); Members (invite name+email → Viewer w/ "invite pending", remove guards); Repository & credentials (override toggle, repos-per-task limit, Grant-scope flow resolving the VIB-142 violation + rail badge); Danger zone (archive/delete, RBAC-denied toast for maintainer). |
| Profile & preferences | `app/profile.jsx` (overlay) | Profile (name/title editable, email IdP-managed); Notification routing (per typed-event in-app/email toggles, waiting-on-you reminder 1/2/4/8/24h stepper); Your access (read-only RBAC); Appearance (theme, reduce motion, default timeline filter); GitHub identity (personal OAuth connect/disconnect). |
| Notifications | `app/notifications.jsx` (bell popup + overlay) | Popup: unread badge/count, mark-all-read, items deep-link to project/task (cross-project items toast "that workspace isn't built in this prototype"); full overlay: "Waiting on you" (packets/approvals) above "Everything else" (mentions/policy/quality by day), All/Unread filter, blue unread dots. |
| Shared / non-product | `app/ui.jsx` (icons, pills, avatars/agent glyphs, toasts, PageOverlay), `app/data.js` (all mock data + prefs/session persistence), `app/viberr.css` + `app/home.css` (design language incl. full dark theme), `app/tweaks-panel.jsx` (**prototyping-tool scaffold for design tweaking — not product intent**), `reference/` (copies of the three design pages), `_shots/` (prototype screenshots). |

---

## 4. Operator / agent model as originally intended

**Backends.** Codex and Claude Code, run as **non-interactive** executions (PRD MVP:
"Codex / Claude Code backed non-interactive runs"). Each specialist profile binds to exactly one
backend (design ruling in the create-profile modal). Agent identity convention: angular violet
clip-path glyphs (Codex = cpu icon, Claude = sparkle); humans = round blue avatars.

**The operator (one per active task, system role, never user-deletable).** From `app/data.js`:

- *Acts directly:* assign the primary specialist; summon consultant specialists; generate decision &
  blocking packets; append typed important events; compress long-running timelines.
- *Recommends only:* stage transitions; completion for human acceptance; owner re-assignment.
- *Reserved for humans (forbidden to it):* execute code or write to the repo; transition a task to
  Done; change project policy.
- Runtime: "orchestration runtime" on the Claude backend; resources: packet-authoring,
  timeline-compression, continuity-reanchor skills; `viberr-task-store` MCP.
- Tasks in Triage have **no operator yet** — the operator is instantiated when a task becomes active.

**Specialist roster as designed** (global base profiles, project-customizable):

| Profile | Stages | Backends | Direct | Recommends | Forbidden |
|---|---|---|---|---|---|
| Developer | Ready, In Progress | Codex + Claude | create task-key branch; commit & push; run unit/integration validation; open review PR | move to Review; validation verdict | merge PR; transition to Done; edit another task's branch |
| Reviewer | Review | Claude | read repo & diff; run validation suites; post quality-flag events; comment | approve review; request changes | merge PR; transition to Done; push commits |
| Tester | In Progress, Review | Codex | author tests; run validation suite; attach evidence refs | validation verdict; hold on failing checks | merge PR; transition to Done |
| Consultant | all pre-Done stages | Claude + Codex | read task & repo; comment with guidance | flag underspecified tasks | any repo write; open/merge PR; any transition |

Each task has **one primary specialist owner plus persistent consultant specialists** (FR14);
consultant threads are "persistent expert memory the operator can re-engage across stages".

**Stage flow and dispatch loop** (default transitions in `app/data.js`; loop from the landing page —
Author task → Assign operator → Execute in GitHub → Accept completion):

1. **Triage → Ready** — boundary `approval`: human, after the quality gate; agents may flag
   underspecified tasks (FR15).
2. **Ready → In Progress** — boundary `auto`: the operator advances it once a primary specialist is
   assigned.
3. **In Progress → Review** — boundary `approval`: operator files a *transition request* with
   evidence attached; a maintainer/admin approves.
4. **Review → Done** — boundary `human`, **locked**: only human acceptance of the completion report;
   accepting merges the review PR and moves the task to Done, always audited.

**Reviews and intervention.** The operator turns agent work into concise **decision packets**
(observed → changed → recommended options with one operator pick → decision required); packets are
the governed intervention surface for blocked/drifted tasks (Journey 2). Human "acceptance of
completion" is the only path to Done. Quality flags, blocked agent actions (e.g. a Codex Developer
attempting a merge), and policy violations surface as typed events + audit entries rather than chat.

**Continuity.** Threads persist across stages; every reactivated agent **re-anchors on the canonical
task file** before acting; provider-history loss produces a continuity warning + a blocked packet
with recovery options (resume rehydrated thread / fresh specialist / hold for runtime debug), and
authorized humans may open the provider-native session as an audited debug action whose findings
return as task comments (Journey 4, FR22/FR23, NFR12/NFR17).

**Runtime visibility.** Live run strip (phase, step, elapsed, tokens, model, interrupt) plus a
streamed per-thread log console modeled on the real Claude Code `stream-json` NDJSON and Codex SDK
`runStreamed()` event shapes, with a raw-JSON toggle — designed for SSE/WebSocket piping, session
resume, and interrupts once a backend existed.

---

## 5. Role model as originally intended (before later reworks)

The PRD itself names only "admin users" vs users, plus the FR37 task owner; the concrete role
vocabulary comes from the mock (`app/data.js` POLICY):

**Project roles: `admin` · `maintainer` · `reviewer` · `viewer`** with this RBAC matrix:

| Action | admin | maintainer | reviewer | viewer |
|---|---|---|---|---|
| View board, tasks & timelines | ✓ | ✓ | ✓ | ✓ |
| Comment on tasks (app-wide) | ✓ | ✓ | ✓ | ✓ |
| Take / release task ownership | ✓ | ✓ | ✓ | ✓ |
| Release any task owner | ✓ | — | — | — |
| Approve stage transitions | ✓ | ✓ | — | — |
| Accept completion → Done | ✓ | ✓ | — | — |
| Open agent runtime sessions | ✓ | ✓ | — | — |
| Manage members & roles | ✓ | — | — | — |
| Edit workflow & policy | ✓ | — | — | — |

Notes on original intent:

- **Two separate governance surfaces** (FR8): human RBAC above vs the agent capability matrix
  (direct/recommend/human/off per action per profile) — "governing people and governing agents
  aren't the same problem" (Journey 3). The word "governance" itself was **banned from UI copy**
  during design (use Maintainer / Permissions / "managed").
- **Task owner (FR37/38)** is orthogonal to role: any member of the project — including a viewer in
  the original matrix — could take ownership of a task and thereby hold its review & acceptance for
  that task only. Admin releases are audited.
- **Org level** (Home mock): users are `admin` or `member`; onboarding by whitelist (email or Google
  domain), local accounts admin-managed; new project members join as Viewer.
- **App-wide commenting** (FR4 amendment) cuts across membership: any registered user comments on
  any task, visibly labeled when not a member.
- *Later reworks (for the comparison, not part of original intent):* `reviewer` was renamed
  `contributor`; Q5 clean tiering made viewer strictly read+comment and moved take-ownership +
  packet-resolve to contributor+; org/project role split was formalized (2 org + 4 project roles);
  the Consultant profile was removed and Tester merged into Reviewer; policy presets were wired to
  real enforcement. See `planning/discovery-2026-07-10/product-intent.md` and the pass-2/3 rulings.

---

## 6. Aspirational / decorative mock content that may never have been wired

Things the mock *shows* that were stubs, simulations, or marketing-only — a reviewer should not
expect the current app to match these one-for-one:

- **The entire landing page** (`design/landing.html`) is a marketing companion with a
  "Request early access" form (work email + team context) — Viberr is an internal, self-hosted tool
  with no public surface in scope (PRD Web App Requirements). The form submits nowhere.
- **"SSE live" indicator** in `design/design-system.html`'s responsive workspace mock — built,
  renamed, then **explicitly removed** from the product design ("no live/SSE indicator in topbar");
  live updates were intended to be felt, not badged.
- **⌘K global search** in the workspace topbar (`app/main.jsx`) — a permanent affordance in every
  screenshot, never functional in the mock; no PRD FR backs a search feature.
- **Cross-project notifications** (Deploy Pipeline `DEP-31`, Billing Service `BIL-9` in
  `app/data.js`) — decorative proof that the stream is user-global; clicking them toasts "that
  workspace isn't built in this prototype".
- **Live-run telemetry**: elapsed/token tickers, phase/step text, and the **Interrupt** button in
  `app/runs.jsx` are simulated (interrupt explicitly "stubbed — wire to real SDK interrupt when
  backend exists"); log streams are pre-scripted `lines`/`live` arrays, though their event shapes
  were verified against the real SDKs.
- **"Open on GitHub"** buttons (task side rail, GitHub page) toast "external links are stubbed".
- **Email notification toggles** in Profile → Notification routing (`app/profile.jsx`) — decorative
  even at design time: the design ruling was **no email notifications in V1** (in-app only), so the
  per-event email column and the reminder stepper are aspirational surface.
- **Home project-card stats** (`app/home.jsx`): the stage-distribution meter, "N agents running",
  and "N waiting on you" pills are computed from hand-written `dist`/`running`/`waiting` fields in
  mock data — a promise of live aggregation the mock never computes from real state.
- **Agents stats strip** (`app/agents.jsx`) is derived live from mock task data, but reads like an
  analytics feature; real **analytics/reporting is explicitly Phase 2** in the PRD ("analytics on
  throughput, governance load, and task health", "reporting and audit exports") — the mock contains
  **no charts at all**, so any dashboard-like expectation beyond these strips is post-MVP by design.
- **Capability-matrix modal** (`app/agents.jsx`) is display-only (reads live profile state; no
  editing from the matrix).
- **KB "import from GitHub link"** and drag-to-upload flourishes in `app/kb-browser.jsx` — rich
  file-management UX sketched in one design pass; the PRD only requires that profiles reference
  skills/MCPs/KBs (FR9).
- **Re-scan / Reconcile** actions in the mock are `setTimeout` toasts — the affordance is real
  intent (FR36), the behavior shown is fake.
- **Policy presets** on project creation (Strict / Balanced / Autonomous) were purely cosmetic in
  the mock (a later owner ruling wired them to real governance).
- **Model name strings** ("codex-large", "claude-sonnet", "orchestration runtime") in agent profiles
  are invented placeholder metadata.
- **`app/tweaks-panel.jsx`** is a design-time tweaks-panel scaffold (edit-mode host protocol) — a
  prototyping tool, not a product feature.
- **Login demo mechanics** (`arda@viberr.dev` / password `2828`, `localStorage` sessions,
  `viberr:pw:arda`) are prototype scaffolding; the intent they carry is the *flow* (local login,
  whitelist OAuth, admin reset → forced new password), not the mechanism.

---

## Reconciliation with `planning/discovery-2026-07-10/product-intent.md`

The prior distillation is consistent with this document and remains accurate on invariants
(files-canonical, human-only Done, two policy surfaces, typed events, re-anchor, traceability,
idempotency). Differences in scope: that doc mixes original intent with **resolved owner rulings**
(consultant removal, Tester merge, role renames, preset wiring, Q1–Q8, pass-3 rulings) — this
document deliberately stops at the PRD + mock so the "original" column stays clean. Where the two
disagree about what was *original* (e.g. project roles: mock says admin/maintainer/**reviewer**/
viewer; the prior doc lists the post-rework admin/maintainer/**contributor**/viewer), this document
reflects the mock as the original and flags the rework in §5.
