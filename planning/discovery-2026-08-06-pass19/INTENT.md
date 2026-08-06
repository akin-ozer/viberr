# Viberr — original product intent, distilled (pass 19, 2026-08-06)

Self-contained context for implementers who have not read the canon. Sources:
`planning/planning-artifacts/{prd,architecture,ux-design-specification}.md`,
`docs/architecture/{decisions,file-formats}.md`, `planning/README.md`, `design/`.

**Canon rule:** these are *living* docs. When the app and a doc disagree and the app is
right, the doc is corrected with a dated note — the app is not "fixed" back. Read the
amendment before treating any requirement as an instruction. On conflict,
`planning/planning-artifacts/` wins over `design/`; `architecture.md` wins over
`decisions.md`.

## 1. Vision

Viberr is a multi-user, desktop-first web app for **agent-native software delivery under
human governance**, built for small AI-forward engineering teams that already use Codex and
Claude Code ad hoc and have lost track of which agent owns what. It inverts the Jira model:
**agents are the native workers; humans govern flow, review, and acceptance.** The unit of
truth is the *task* — a canonical, human-readable Markdown file holding identity, goal,
state, execution context, timeline, decisions and evidence — which acts as the operating
contract between humans, persistent agent threads, and GitHub execution. Each active task
gets a dedicated **operator agent** that coordinates; **specialist agents** do stage work on
a task-key branch; humans intervene through comments, decision packets, and explicit
acceptance. Primary user: the senior engineer/tech lead supervising several live tasks
(Arda). Secondary: the workflow admin who configures projects and policy (Elif), and the
escalation troubleshooter who investigates continuity and drift failures (Murat). V1 is
GitHub-backed, one repo per project, on-prem/authenticated, no mobile target.

## 2. Glossary

- **Project** — a governed workspace: one GitHub repo, one ordered stage list, one workflow
  graph, its own member roles, its own deployed agent profiles and capability policy. Stored
  as `projects/<slug>/project.md`. Members-only: non-members get a 404-equivalent.
- **Task** — the canonical operating contract. `projects/<slug>/tasks/<KEY>/task.md`:
  frontmatter (state) + `## Goal` + `## Packet` (while open) + `## Timeline`. Key form
  `VIB-142`. Created by humans only.
- **Stage** — one entry in the project's ordered stage list (default: Triage / Ready /
  In Progress / Review / Done). Per-project, colored, editable after creation.
- **Workflow graph** — the `from → to` transition list with a governance `boundary`
  (`auto | approval | human`). `review → done` is `human` and locked. Server-enforced.
- **Engagement** — one entry in a task's uniform `engagements[]` list. Exactly one has
  `delivers: true` — the **delivering engagement**, sole owner of the workspace, branch and
  PR (single-writer invariant). All others are **supporting engagements**, read-only by
  default. Replaced the old `specialist:` / `consultants:` / `reviewers:` slots (2026-07-19).
- **Operator** — the per-task coordinator agent. Recommends assignments, transitions and
  decisions; engages specialists; decides when to deliver; opens decision packets. Runs at
  `supervised` or `full` autonomy.
- **Specialist agent** — any non-operator agent. All specialists are ONE uniform machinery
  differentiated only by their profile's capability + resource grants (generic-agents, 2026-07-19).
- **Agent profile** — a two-layer definition: an org template (`agents/profiles/<id>.md`:
  backends, eligible stages, base capabilities, resources, persona body) *deployed* into a
  project, which may override the capability policy. Assignments store `profileId`, never role text.
- **Packet (decision packet)** — a compact structured intervention artifact rendered at the
  top of the task: type, kind, observations grid, and options each carrying a **stable
  `kind`** (never dispatch on English titles). Nine kinds: `accept_completion`,
  `request_edit`, `block_on_policy`, `hold_runtime_debug`, `redirect`,
  `retry_other_backend`, `edit_goal`, `archive_task`, `custom`.
- **Knowledge base (KB)** — an org-level document folder under `${VIBERR_DATA_ROOT}/kb/<dir>`
  injected into a run. Grants reference the **directory name**, not the display name;
  a display-name grant silently resolves to nothing.
- **Capability grant** — `{capabilityId, mode}` against the shared catalog
  (`app/shared/capabilities.ts`), mode ∈ `direct | recommend | human | off`. Three are an
  always-human server invariant: `merge-pull-request`, `transition-to-done`,
  `change-project-policy`.
- **MCP grant** — a granted MCP server on a profile. Deliberately **outside** the capability
  matrix: granting the server IS the authorization for whatever its tools do.
- **Skills** — Viberr-granted skill folders mounted into a Claude run via the SDK's native
  `skills: [...]` mechanism (progressive disclosure); Codex still gets prompt-text injection.
- **Delivery** — pushing the task branch and opening the review PR. An **operator decision**,
  not a stage side-effect. The server executes the mechanics; specialists never push or open PRs.
- **Work revision** — the immutable snapshot under review (`workRevision`: id, headSha,
  treeSha, branch, sourceProfileId). Verdicts bind to a revision id, so re-delivery invalidates them.
- **Verdict / review** — a supporting engagement whose `verdictCapable` snapshot is true
  (from an explicit `report-validation-verdict: direct` grant at engage time) is a **required
  reviewer**; its `approve | request_changes` on the delivered revision gates acceptance.
- **Readiness** — the canonical 4-value enum, everywhere:
  `ready | input_required | inconsistency_risk_detected | blocked`. "Accepted" is a derived
  display state, never stored.

## 3. Functional requirements ledger

**Workspace access & collaboration**

| FR | Summary | Amendments |
|---|---|---|
| FR1 | Team members sign in and access shared workspaces. | — |
| FR2 | Admins manage membership + human roles; system enforces project/task permissions. | — |
| FR3 | Multi-user collaboration with shared visibility into task state changes. | — |
| FR4 | Comment on tasks, addressing agents or teammates in one unified timeline. | **2026-07-04**: commenting is app-wide, non-member comments visibly labeled. **2026-07-28 (R15-4)**: narrowed — projects are members-only, so "app-wide" means *within visible projects*; workflow secrecy beats openness. |
| FR37 | One human task **owner** = reviewer + acceptance authority, scoped to that task only; task may be unowned. | **2026-07-25**: acceptance ships; **R14-2** widened it — the owner governs *any* open decision on their own task (resolve packets, apply recommendations they hold the action for, dismiss any). **2026-07-28 (R15-3)**: also covers stage-transition recommendations — the Apply click IS the authorization for that one move. |
| FR38 | Any project member can take/release task ownership self-service; admins can release any owner; typed events + audit. | — |

**Project governance & policy**

| FR | Summary | Amendments |
|---|---|---|
| FR5 | Admins create and configure governed delivery projects. | — |
| FR6 | Admins define stages, allowed transitions, approval boundaries. | — |
| FR7 | Admins define the project's GitHub repo. One project, one repository. | **2026-07-25**: the "task-level overrides" clause was **struck** — never implemented on any layer, the admin toggle enforced nothing, and a task pointing elsewhere would still authenticate with the project credential. Toggle + copy deleted. |
| FR8 | Separate human RBAC and agent capability policy per project. | — |
| FR9 | Reusable agent profiles (global template + project customization): eligible stages, permitted actions, permitted resources (skills/MCPs/KBs), execution backend. | — |

**Task records & lifecycle**

| FR | Summary | Amendments |
|---|---|---|
| FR10 | File-native store inspectable outside the app; reconciles files created/edited directly. | — |
| FR11 | Users create tasks within a project. | **2026-07-25**: "and authorized agents" **struck** — never implemented; task-graph/subtasks are post-MVP. An agent that believes a task is needed routes it to a human via a decision packet. |
| FR12 | Each task maintains a canonical record: identity, goal, state, execution context, timeline, decisions, execution refs. | — |
| FR13 | Tasks move through project-defined stages under governed transition rules. | — |
| FR14 | Execution roster on the task; human owner tracked separately. | **2026-08-04 (pass 17, D9/Q17-5)**: vocabulary re-synced — "primary specialist"/"consultant specialists" no longer exist. One `engagements[]` list; read "primary" as the delivering engagement and "consultants" as supporting engagements. |
| FR15 | Agents flag low-quality/underspecified tasks and request clarification before execution. | — |
| FR16 | Typed important events alongside conversational updates in a single chronology. | — |
| FR17 | Validation outcomes, evidence refs, concise change summaries, compressed history preserving continuity. | — |

**Agent orchestration & continuity**

| FR | Summary | Amendments |
|---|---|---|
| FR18 | A dedicated operator agent per active task. | — |
| FR19 | Execute approved agent profiles through Codex / Claude Code backends. | — |
| FR20 | Operators recommend assignments/transitions/decisions, trigger specialist work, re-engage agents. | **2026-08-04**: "consultant specialists" = supporting engagements. |
| FR21 | Specialists execute stage work and append outcomes, blockers, evidence to the task record. | — |
| FR22 | Threads resume across stages; a reactivated agent continues from canonical task state even with no runtime history. | — |
| FR23 | Authorized users reach an agent's native runtime session for deep debugging. | — |
| FR39 | *(added 2026-07-25, recording shipped behavior)* Schedule a future operator re-run ("re-check in 24h") fired server-side with no human present. Only a role that may run agents can create one; the entry is canonical in the task file; carries the backend + autonomy chosen at schedule time; never fires on a terminal stage; visible, cancellable, auditable. | The one capability that lets an agent act unwatched. |

**Oversight views & human governance**

| FR | Summary | Amendments |
|---|---|---|
| FR24 | Board by stage; cards show stage, assigned agent, waiting state (human vs agent), validation status. | — |
| FR25 | Task detail prioritizes current state, execution profile, latest decision packet — before the timeline. | — |
| FR26 | Structured blocking/decision packets generated for human review. | — |
| FR27 | Humans approve/reject/redirect consequential changes incl. advancement and completion; `done` is human by default, server-enforced. | **2026-07-25 (Q1)**: one narrow exception — a full-autonomy project whose operator holds an explicit `completion-for-acceptance: direct` grant accepts and closes itself (still refuses failing validation). Raising autonomy alone never confers it. **2026-07-28 (R15-1)**: acceptance is **verdict-gated** — needs a PR head carrying the delivered revision + a healthy reviewer verdict; audited Force-accept is the only bypass; every accept passes a confirm dialog. **2026-08-04 (R16-6)**: "Done" has two meanings — an operator acceptance records the PR `accepted` (**merge pending**) and a human merges later; only a *human* acceptance triggers the real async merge. |
| FR28 | Review progress without raw provider logs or raw validation output. | — |

**GitHub delivery & traceability**

| FR | Summary | Amendments |
|---|---|---|
| FR29 | Authenticate to GitHub, access authorized repos. | — |
| FR30 | Each task executes against its project's repo; no per-task override. | (mirrors FR7) |
| FR31 | Create/manage task-key branches; associate commits, changed files, review PRs with the task. | **2026-07-28 (R15-2)**: delivery is an **operator decision**, not a stage side-effect. The operator weighs remaining stages, may offer early delivery, opens a packet when unsure. Server executes; a human can trigger delivery directly (audited); specialists never push. Reaching a review stage with no PR is announced with a typed event. |
| FR32 | Branch and PR status visible alongside task state. | — |

**Integrity, audit & recovery**

| FR | Summary | Amendments |
|---|---|---|
| FR33 | Auditable history of human decisions, agent actions, workflow changes, policy events. | **Bounded 2026-07-25**: audit rows retained **90 days**, hard-deleted by a boot-time retention pass; **no export in V1** (Phase 2). Task-scoped history survives in `task.md`; org/auth events (sign-ins, user admin, PAT changes) are genuinely gone at 90 days. |
| FR34 | Isolate secrets/credentials from task-visible artifacts, comments, audit. | — |
| FR35 | Task quality issues and policy violations as first-class events. | — |
| FR36 | Manual project re-scan and state reconciliation. | — |

**NFRs (compressed).** *Perf* — board ≤2s @200 cards (1); task detail ≤2s p95 (2); governed
action reflects ≤3s p95 (3); cross-user propagation ≤5s (4); never load full raw history (5).
*Security* — TLS everywhere (6); no secrets in timelines/comments/audit/logs (7); separate
human vs agent permission boundaries on every governed action (8); least-privilege creds (9);
security-relevant actions audited (10). *Reliability* — state survives restarts (11);
continue from canonical state when runtime history is gone (12); reconciliation never
corrupts (13). *Integration* — GitHub failures surfaced ≤10s (14); branch/commit/PR uniquely
traceable to the task key (15); idempotent external actions, retries never duplicate
transitions/branches/PRs/events (16); agent-identity continuity across resumes or explicit
failure (17). *Audit* — durable across restarts/resync/failures, bounded by FR33 (18).

## 4. UX design principles (load-bearing)

**Product feel.** A calm operations console for supervised AI delivery, not a ticket tracker.
Adopt Linear's calm hierarchy and speed, GitHub's artifact-linked trust, Datadog's
triage-first signaling. Anti-patterns: generic kanban-with-AI-badges, dashboard overload,
log-first design, detached approval modals.

**Experience principles.**
- *Status before history* — what is happening now, before how we got here.
- *Decisions before discussion* — the latest packet above general commentary.
- *Human attention is scarce* — only interrupt when judgment is required.
- *Calm over chatter* — suppress noise, duplication, raw machine exhaust.
- *One task, one truth* — the canonical record is the trusted coordination surface.

**Emotional target.** Confident control, calm operational trust, empowerment. When things
break the desired feeling is *contained seriousness*, not urgency. Avoid confusion,
skepticism, alert fatigue, bureaucratic frustration.

**Layout model.** Board = **Signal Console** (triage-first, compact high-signal cards). Task
detail = **Operator Desk** (current state, execution truth, latest packet, steering actions
above timeline depth). Split-view is a secondary pattern only. Make-or-break failure: if a
user ever has to reconstruct the truth from logs, PRs or side conversations, the product has
lost its core promise.

**Voice / tone / copy.**
- Button labels describe the **outcome**, not a generic UI verb. A control must never name an
  outcome its surface cannot promise (why the review queue row says "Review", not "Accept").
- Toast, empty-state and boundary copy in the specs is a **verbatim contract**, including
  deliberately divergent board-vs-review wording.
- **"govern / governance / governed / governor" is BANNED in rendered UI copy** — use
  *Maintainer* (role), *Permissions* (panel), *managed*. Enforced by
  `app/features/copy-ban.test.ts`; code identifiers are exempt. (The docs use the word
  freely; the product never does.)

**State semantics.** The 4 readiness values plus secondary signals (waiting-on-human,
waiting-on-agent, degraded continuity) mean the same thing on every surface. State is carried
by text + icon + semantic emphasis together — never color alone. Input gaps, inconsistency
risk, blocked and continuity degradation must not collapse into one generic "error".

**Button hierarchy.** At most one primary per decision surface; informational surfaces may
have none. Destructive actions never share the weight of safe progression. Approve / redirect
/ request-clarification stay stable across packet types.

**Feedback.** Inline state feedback is the primary confirmation; toasts are short-lived
acknowledgement only and must **never** be the sole record of a consequential event. Errors
explain what failed, what remains true, and what to do next. No optimistic UI for governed
state — revalidate after the action and on SSE. No modal or overlay may be the sole home of
consequential task truth; empty states orient toward the next meaningful action.

**Custom component set (the identity layer).** Task Status Card, Decision Packet, Execution
Truth Strip, Mixed Timeline Item, Continuity Recovery Panel. Rule: a custom component must
improve operational legibility or it should not be custom.

**Responsive.** Desktop-first, **one surface reflowed** — breakpoints are layout reflow
points, *not* capability boundaries. Shipped set clusters near 1400/1300/1100/1080/1000/900/760px,
each attached to the grid it rescues. Multi-column pages collapse to one column; task detail
regions stack preserving reading order (state → packet → next action → timeline); board
columns narrow before wrapping; topbar drops a breadcrumb segment and the search box; the nav
rail keeps its width. **No control is hidden or disabled at any width, and nothing is gated
on `matchMedia`** — hiding a governance control on a small screen would make the surface
dishonest about what the user may do.

**Accessibility.** WCAG 2.2 AA baseline for core workflows in **both** themes. Visible focus,
semantic landmarks, ARIA for status/dialogs/expanders, screen-reader announcements for
consequential state changes, keyboard access to every packet action. Escape-close, focus-trap
and scrim-click on every dialog. "Inaccessible state is untrustworthy state."

**Visual system (as shipped).** `app/app.css` `:root` is the *single* source of tokens —
unprefixed names (`--bg`, `--fg`, `--blue`, `--muted`, `--faint`, `--placeholder`, `--cta-bg`,
`--success`, …). No Tailwind, no inline hex, no `--viberr-*` layer. A `var(--x)` not defined
in `:root` is a bug. Light/dark/system persisted per user + a cookie for SSR-safe first paint.
Agent-vs-human identity split is a core convention: agents = angular clip-path glyph in
violet (`--agent` family, Codex=cpu / Claude=sparkle), humans = round blue avatars.

## 5. Rulings ledger (`docs/architecture/decisions.md`)

Numbers are cited verbatim in code comments and must never be renumbered. A **SUPERSEDED**
ruling is kept, not deleted — never restore a superseded rule because you found its text.

**Numbering note.** ONE sequence, 1–54. Rulings 1–16 came from the deleted
`docs/build/CONVENTIONS.md` and carry no pass label; pre-pass-15 rulings were folded into them
as inline Amended/Narrowed/Superseded notes. Only four old labels survive: **R6-2** (ruling
22), **R8-3** (ruling 10), **R14-2** (FR37/ruling 22), **R14-3** (ruling 7's `archive_task`).
Match any other `R7-…`/`R8-…`/`R9-…` citation by amendment *text*; if it is nowhere, ruling
44 says promote it.

**Conventions (unnumbered, binding).** `*.server.ts` for server-only, never imported into
client components; tests co-located; kebab-case files, PascalCase components, camelCase vars.
SQLite plural snake_case tables, camelCase in TS/JSON via `app/shared/mapping/` only. UTC ISO
8601 timestamps at every boundary. SSE names are lowercase dot-separated facts with a
`{type, entityId, occurredAt, data}` payload of compact facts, parsed before publish. Typed
`AppError` with stable codes, never leaking stacks or secrets. **Files are the only canonical
business truth** — write file → re-parse → re-project → publish SSE; never write a projection
without file backing. Tolerant parsing: malformed input yields diagnostics + a readiness
downgrade, never a crash or silent drop. Mutating actions idempotent-safe. Every governed
action writes an audit event and, where user-visible, a typed timeline event. Secrets from env
only; PATs AES-256-GCM in SQLite. RBAC applies to actions, not file existence.

| # | Ruling |
|---|---|
| 1 | **Readiness** — canonical 4-value enum in files/Zod/SQLite; ONE mapping module to pill kinds. "Accepted" is derived display, never stored. |
| 2 | **Three separate role systems.** Org `admin\|member`; project roles in `project.md`; agent capability policy per profile (`direct\|recommend\|human`) id-based against a shared catalog, with an always-human server invariant list. **Amended**: project roles are `admin \| maintainer \| contributor \| viewer` (strict tier; `reviewer`→`contributor`), single source `app/shared/rbac.ts`. **Superseded in part** by 25. |
| 3 | **Task-file store** at `$VIBERR_DATA_ROOT/projects/<slug>/tasks/<KEY>/task.md`; the UI renders the REAL store-relative path, never the mock's `.viberr/...`. |
| 4 | **Timestamps** UTC ISO at boundaries; one shared formatter in `app/shared/dates/`. |
| 5 | **PAT scope violations** — per-scope validator results + per-violation open/resolved records; rail badge = open count; typed timeline event on the violation's own task. No global boolean. |
| 6 | **Identity** — compare by user id everywhere; display names are render-only. |
| 7 | **Packet options carry a stable `kind`** — never dispatch on English titles. Nine kinds (see glossary). Agent policy is id-based; advisory ids with no runtime consumer get no toggle. **Amended by 40**. |
| 8 | `tweaks-panel.jsx` not ported (dev harness). Review-queue packet + acceptance mechanics ship before the queue surface. |
| 9 | **Notifications** are per-user SQLite rows, real-timestamp DESC, soft refs. **Superseded in part** (clean-sheet seed, 2026-07-24): the seeded stub projects are demo data — `npm run seed:demo` only; the product seed ships no board data. |
| 10 | "Waiting on you" / review queue stay project-wide in V1. **Superseded for the board** (R8-3): the board chip and home waiting count are **member-scoped**; the review queue stays project-wide. |
| 11 | **Run lifecycle** `queued\|running\|finished\|error\|interrupted`; raw NDJSON is truth, log display is a projection; elapsed from `startedAt`; tokens only from real usage envelopes. |
| 12 | **PR states** — merged→done pill, open/draft→"in review", closed-unmerged→risk "closed"; sync precedence merged > behind > synced from real compare data. |
| 13 | **Prefs** — derive `ghConnected` from the user row; mount Appearance; map plural pref ids ↔ singular kinds once. **Narrowed**: no mailer in V1, email/nudge shapes removed; one in-app `app` toggle per category. |
| 14 | **Shared single implementations** for notification meta, the markdown stripper/renderer, the credential card, the bell popover. Never fork per surface. Spec copy is a verbatim contract. |
| 15 | **Stages** are a per-project list in `project.md` from an instance-default template. **Narrowed** (2026-07-24): the "Lightweight · 3 stages" preset was **deleted**; the Standard 5-stage board is the only creation template. |
| 16 | **Deliberate keeps** — board rail count includes Done; `.card.urgent` visually untreated; `data-screen-label` kept app-wide. Additions: list-view empty state; Escape/focus-trap/scrim on every dialog; `operator` stores the stage id, UI renders "stage \<1-based\>"; login copy kept but password minimum 8. |
| 17 | **PR divergence recovery** — out-of-band PR transitions fire a `pr-diverged` operator trigger; a closed PR opens ONE recovery packet (rework / `archive_task` / `archive_task`+`deleteBranch`). Remote-branch deletion exists only as that resolution. |
| 18 | **Minimum GitHub scopes are exactly `repo` + `pull_request:write`.** `workflow` and `read:org` dropped. Fine-grained tokens prove write via empty-payload dry-run probes (422 = authorized, 403 = refused). |
| 19 | **Scope chips render proven verdicts only** — a chip is evidence; `assumed`/`unchecked` render as an honest "unproven" line, never a pseudo-check. |
| 20 | **R15-1 — acceptance requires a verdict.** Healthy reviewer verdict on the delivered revision; audited admin Force-accept is the only bypass and never bypasses the PR-head check. Every accept shows a confirm dialog. |
| 21 | **R15-2 — delivery is an operator decision** (see FR31). Human delivery button (maintainer+/owner) is the escape hatch. |
| 22 | **R15-3 — owner authority covers recommendations**, including stage transitions; the Apply click IS the authorization for that one move. |
| 23 | **R15-5 — global ⌘K palette**: real workspace-wide search (tasks, branches, agents, projects) scoped to visible projects. |
| 24 | **R15-6 — per-project delete-branch-on-merge** setting, default on. |
| 25 | **R15-4 — projects are members-only**; non-members get a 404-style response on every project surface. |
| 26 | **R15-7 — ghost profiles are fully conservative**: an unresolvable profile gets nothing permissive — no delivery, comments, ask-human or evidence. |
| 27 | **R15-8 — `design/prd.md` is re-synced** with canon and both are maintained. *Re-affirmed 2026-08-05*: "maintained" now means **byte-identical**, pinned by `prd-sync.test.ts`. Edit the canon copy; the design copy is a mirror. |
| 28 | **R15-9 — an absent `deliver-review-pr` grant resolves from the project's own workflow graph**, not a constant: no pre-terminal boundary advances automatically ⇒ `recommend`. Gate and policy surface share `absentDeliverReviewPrMode` so they cannot drift. An explicit grant always wins. |
| 29 | **R15-10 — the first empty board teaches, once**: one teaching line in the entry column of a zero-task project; every other column bare, and all bare the moment any task exists. |
| 30 | **R15-11 — the Review queue stays a triage list whose rows name their action** ("Review", deliberately not "Accept"); acceptance stays with its evidence on the task page. |
| 31 | **R15-12 — unenforced capability lines are collapsed, never hidden** (a counted `<details>`). An omission the reader cannot see is worse than an awkward truth. |
| 32 | **R15-13 — settings headings name their own scope**: "Instance settings" and "\<name\> · settings". |
| 33 | **R15-14 — a resolved agent question goes back to the AGENT THAT ASKED**, by resuming its own session. Packets record `askedBy` (profile id); operator hand-off remains the fallback so no decision is swallowed. |
| 34 | **R15-15 — a task owns a PR only if that task opened it.** `openTaskPr` is the sole link writer; a PR on the branch the task does not reference is a branch **collision**, reported as one — task-key branches are not identifiers (keys restart at 1 on a new data root). |
| 35 | **R16-1 — a pre-existing PR is adopted ONLY IF it is open AND its head sha IS the delivered revision** (identity, not containment). A task that delivered nothing adopts nothing. A name-matched failure is a reported collision that blocks delivery. `app/server/github/pr-adoption.server.ts`. |
| 36 | **R16-2 — `input_required` joins the board's attention predicate**; the chip is renamed **"Blocked or waiting"** so its label names what it selects. |
| 37 | **R16-3 — terminal GitHub facts outrank process gates in refusal copy.** A closed unmerged PR is named FIRST, and while it is closed admin Force-accept is **withdrawn (hidden)**, not merely disabled. |
| 38 | **R16-4 — correctness first with tests, then the full UI/a11y list — nothing deferred out of a pass.** The **disposition audit** (every backlog item's state re-derived from the tree after the fix waves) is what proves "done" ≠ "partial". |
| 39 | **R16-5 — MCP grants stay OUTSIDE the capability matrix — granting a server IS the grant.** Consequence stated plainly: a withheld `execute-code-or-write-repo` does NOT bound a granted server's tools. A deliberate honesty boundary, pinned by the ABSENCE of any `mcp__*` deny rule and disclosed in the UI. |
| 40 | **R16-6 — merge stays human-only; "Done" has two meanings.** Operator acceptance → PR `accepted` (merge pending) + task Done, human merges later; human acceptance → real async merge. The difference must be visible on the board card **and** the review queue, not only detail. |
| 41 | **R16-7 — the stale `codex/gpt-5-6-sol-agents` branch was deleted.** Premise correction: the "missing contributor docs" rationale was wrong; `docs/contributing-quickstart.md` and `docs/testing-quickstart.md` both exist. |
| 42 | **R17-1 — acceptance may accept a head AHEAD of the reviewed revision but MUST surface the divergence.** Containment-based gate kept; accept + force-accept dialogs show the ACTUAL merge head and "N commits added since review"; audit names the real merge head. A head that has *diverged* still refuses. |
| 43 | **R17-2 — a verified no-diff task is a first-class "Completed — no changes required" outcome**: closes to Done with no PR or merge, its own timeline event, operator-recommendable. Force-accept and Archive are no longer the only exits for a zero-diff task. |
| 44 | **R17-3 — rulings live in `decisions.md`; a docs-canon re-read is a required closing step of every pass.** A ruling no canon file records is a ruling that gets reversed. |
| 45 | **R17-4 — the local sign-in form leads when NO OAuth provider is configured** (disabled "not configured" buttons are not rendered; SSO shrinks to a footnote). |
| 46 | **R17-5 — "never synced" is neutral; only a genuinely stale cache warns.** `reconcile.at: null` reads "Not synced yet" (neutral); only `stale && at !== null` keeps the alert tone. |
| 47 | **R18-1 — a reviewer inherits the delivering engagement's KBs** (union with its own, deduped, non-delivering runs only) so deliverer and reviewer judge against the same conventions. |
| 48 | **R18-2 — a full-autonomy delivery re-queues the operator** with a `delivered` trigger (delivery is not a transition, so the every-transition re-trigger never fired). SUPERVISED deliberately does not re-trigger. |
| 49 | **R18-3 — the SDK-native skill/command catalog is governed OUT of runs.** The clone's own `.claude` is stripped git-invisibly (`--skip-worktree`), Claude launches with `strictMcpConfig: true`. Accepted limitation: a run whose task is to edit the repo's own `.claude` cannot deliver those edits. |
| 50 | **R18-4 — branch-collision stays a human-gated packet — do NOT auto-reset** the remote task branch. The packet is an intentional safety checkpoint against clobbering unrelated remote history. |
| 51 | **R18-5 — granted skills reach a Claude run through the SDK's NATIVE `skills: [...]`**, not injected prompt text: progressive disclosure, and the allow-list is what finally contains the SDK's compiled-in skills. **Codex keeps prompt-text injection** — the asymmetry is disclosed, not silent. |
| 52 | **R18-6 — `design/prd.md` re-synced and pinned** by `app/shared/docs/prd-sync.test.ts` (see 27). |
| 53 | **R18-7 — accepting from the BOARD asks first.** Dragging a card into the final stage runs the full acceptance contract (a real merge), so drag and the keyboard Move menu now raise the same confirmation. |
| 54 | **R18-8 — F18-9 closed as NOT REPRODUCIBLE** (agent-profile modals initialise empty grants). Recorded as a class: *a finding taken from a UI impression and never re-verified in code can survive several passes as fact.* |

## 6. Deliberate divergences vs open questions

**Deliberate — the doc was corrected, do NOT "fix" the app back**

1. **Per-task repo override** (FR7) — deleted, not finished. Half-built and unsafe.
2. **Agents creating tasks** (FR11) — struck; task creation is a human act.
3. **Full-autonomy operator acceptance** (FR27/Q1) — the single narrow exception to human-only
   `done`, explicit + audited + UI-disclosed; never implied by raising autonomy.
4. **"Done" is two states** (R16-6) — operator-accepted Done is *merge pending*.
5. **Engagement vocabulary** (FR14/FR20) — "primary specialist / consultants" is dead
   vocabulary; the model is `engagements[]` with one `delivers: true`.
6. **Delivery is an operator decision** (R15-2), not a stage side-effect.
7. **App-wide commenting narrowed to members-only projects** (R15-4) — workflow secrecy won.
8. **Mobile "review-first mode" below 768px** — never built, **retired** 2026-07-25 rather
   than left as an instruction. One surface, reflowed; nothing gated on viewport.
9. **UX color palette superseded** — the spec's graphite/steel-blue advisory palette was not
   taken. Shipped is a bright Miro-inspired canvas: `#5b76fe` accent, pastel semantic
   surfaces, violet agent tint, two transparent radial background gradients. Principles
   (color never alone, cross-theme semantic consistency, contrast-constrained text ladder) still bind.
10. **Typography superseded** — IBM Plex Sans/Mono was advisory. Shipped is **Manrope**
    (display) / Noto Sans (body) / JetBrains Mono (technical). ⚠️ The UX spec's own
    superseding note says the display face is *Roobert PRO* — it is not; that note is stale
    and should be corrected (see §7).
11. **Spacing system superseded** — no 8px token scale and no 12-column grid exist. `app.css`
    uses per-component rem values and content-sized grid/flex. Match the surrounding
    component's rhythm; do not retrofit a scale.
12. **Audit retention bounded to 90 days, no export** (FR33) — org/auth-scoped events are
    genuinely gone at 90 days.
13. **"Lightweight · 3 stages" workflow preset deleted** (ruling 15) — Standard 5-stage only.
14. **No demo/board data in the product seed** (ruling 9) — clean-sheet; demo lives in
    `npm run seed:demo`.
15. **No mailer in V1** (ruling 13) — email/nudge preference shapes removed, not stubbed.
16. **Project role `reviewer` renamed `contributor`**; roles form a strict 4-tier.
17. **MCP grants are outside the capability matrix** (R16-5) — a stated honesty boundary,
    explicitly *not* a gap to close.
18. **Codex vs Claude skills asymmetry** (R18-5) — native SDK skills for Claude, prompt-text
    injection for Codex; disclosed, not hidden.
19. **The word "govern*" is banned from rendered copy** even though the PRD's own vocabulary
    is "governed delivery" — a design-conversation decision that outranks doc phrasing.
20. **`state/projection.sqlite` is not a cache** (architecture correction 2026-07-25) — it is
    the only home of users, credentials, sessions, audit, notifications, sealed PATs, org
    resources and run history. Restoring `projects/` without it re-mints user ids and orphans
    every membership and task owner.

**Carried / open**

- **Doc staleness found while writing this file (both are ruling-44 candidates):**
  (a) `docs/architecture/file-formats.md` §2 still says "The 8 kinds" and omits
  `archive_task` — `decisions.md` ruling 7 corrected this to nine on 2026-08-05 against
  `PACKET_OPTION_KINDS`, which is the source of truth. (b) the ux-spec's typography
  supersede-note names Roobert PRO as shipped; `app/app.css` ships Manrope.
- **D16 — GitHub webhooks.** Not built; reconciliation is 5-minute polling + manual re-scan.
- **D17 — NFR measurement.** The numeric NFR1–NFR5 targets have no measurement harness; they
  are asserted, not verified.
- **D18 — Continuity Recovery Panel.** The spec's named component (and a board-card continuity
  cue, which needs a task-schema continuity field) is still unshipped; pass 18 landed only a
  warning-toned `continuity` typed event as a partial.
- **D19 — board keyboard traversal.** Full arrow-key traversal across lanes (spec'd on Task
  Status Card) is incomplete.
- **Phase 2 backlog, deliberately unbuilt:** audit export, throughput/governance-load
  analytics, task-graph + subtask orchestration, richer profile templates, deeper
  validation/testing workflows.
- **Recently closed, do not reopen:** Q-V1 (a read-only Viewer must not see the Danger zone or
  the PAT — ruled + shipped); F18-9 (not reproducible, ruling 54); F17-L4 (ruled by R18-4).

## 7. Design-mock deltas

`design/` holds four build inputs. The **HTML mock app** (`design/html-app/`, 17 JSX modules)
was ported near-1:1 and is still the UI porting source of truth. The real losses are the
other three deliverables.

**Dropped entirely**
- **`design/landing.html`** — a full marketing site (hero, `#proof`, `#flow` four-step
  explainer, `#early-access` CTA). **No landing surface ships.** `/` is the authenticated
  project list; there is no marketing route, no prerender config, `public/` holds only a
  favicon. Its only survivor is the login page's left aside ("Managed AI delivery for small
  teams" + three claims) in `app/routes/login.tsx`.
- **`design/design-system.html`** — the design-system *browser* itself. No `/design-system`
  route, no Storybook equivalent. Its component-search filter, pattern tablist and
  "Desktop dense, mobile decisive" responsive showcase have no shipped home.
- **`design/index.html`** — the deliverables index; a build artifact only.
- **`tweaks-panel.jsx`** — prototype edit-mode tooling; correctly never ported (ruling 8).

**Reshaped**
- **Topbar search field → command-palette trigger.** The mock had a live `<input>` with a dead
  `⌘K` hint; shipped is a dialog trigger button + real search (R15-5). `app.css.test.ts`
  records the deliberate silhouette split (a search FIELD and a dialog TRIGGER must not look alike).
- **Overlays became URL-addressable routes** — Profile, Notifications and Org settings were
  `useState` overlays inside one hash-routed `App()`; they are now real routes.
- **"Operator panel" → "Execution profile"**, with its "Next" row split into a separate
  Recommendations section.
- **Store strip → "Store maintenance"** — org-admin-gated, plus a destructive Rebuild
  projections confirm and the single-writer lock holder, none of which the mock had.
- **Vocabulary:** "Consultants" → **Reviewers** (dynamic label), "Primary specialist" →
  **Delivering agent**. `consultants` survives only as a dead deserialization alias in
  `task-file.schema.ts`. There is no "slots" concept anywhere — that vocabulary never existed.
- **Nav is byte-identical** — the seven rail items (Board, Review queue, Agents, Policy,
  GitHub, Activity, Settings) match `main.jsx`'s `NAV` exactly.

**Design-system value drift (naming convention unchanged — flat unprefixed tokens)**
- **Display typeface: the DS doc and every mock say Roobert PRO; `app/app.css` ships
  `Manrope`.** The UX spec's own superseding note claims Roobert PRO shipped — **that note is
  itself stale.** Body (Noto Sans) and mono (JetBrains Mono) match.
- **Radius scale shrank**: DS doc button 8 / card **18** / panel **28** / canvas **44**;
  shipped button 8 / card **16** / panel **22**, and **no canvas/large radius token exists**.
- **Orphan tokens** documented but never defined in `app.css`: `--pink`, `--dark-red`,
  `--radius-large`. Conversely the app added `--agent*`, `--cta-*`, `--faint`, `--hairline`,
  `--shadow-*`, `--rail-w`, `--topbar-h`, `--ease-out`, `--radius-chip` — the DS doc was
  already stale against the mock app's own `viberr.css`.
- **State vocabulary survived exactly** (`ready | input_required |
  inconsistency_risk_detected | blocked`), and the DS doc's "Memory · anchored to task.md"
  Operator-panel row was demoted to micro-copy on the agent profile.

## 8. Key file map

| Path | What lives there |
|---|---|
| `planning/planning-artifacts/prd.md` | Canon PRD (FR/NFR ledger + amendment notes). Byte-identical mirror at `design/prd.md`. |
| `planning/planning-artifacts/architecture.md` | Canon architecture; wins over `decisions.md` on conflict. |
| `planning/planning-artifacts/ux-design-specification.md` | Canon UX spec (principles, components, consistency patterns, responsive/a11y). |
| `docs/architecture/decisions.md` | The numbered rulings + binding conventions code comments cite. |
| `docs/architecture/file-formats.md` | Exact on-disk shapes of `project.md`, `task.md`, profile templates, actor refs. |
| `app/routes.ts` + `app/routes/` | Route table; thin route modules that delegate to `features/` + `server/`. |
| `app/features/` | Per-surface UI: `board`, `task-detail`, `review`, `agents`, `policy`, `github`, `activity`, `home`, `shell`, `org-settings`, `project-settings`, `notifications`, `profile`, `runtime`, `kb-browser`, `live-updates`. |
| `app/ui/` | Reusable primitives (incl. the single ported `icon.tsx`). MUST NOT import from `features/`. |
| `app/app.css` | The ONE stylesheet; `:root` is the single source of design tokens. Gated by `app.css.test.ts`. |
| `app/shared/rbac.ts` | Single-source project-role × action grant matrix; guards and the Policy page render from it. |
| `app/shared/capabilities.ts` | Agent capability catalog + `ALWAYS_HUMAN_CAPABILITY_IDS`. |
| `app/shared/workflow/` | Stage templates (`templates.ts` → `GOVERNED_TEMPLATE`), transitions, stage-role eligibility, `absentDeliverReviewPrMode`. |
| `app/schemas/task-file.schema.ts` | Task frontmatter + packet Zod schema; `PACKET_OPTION_KINDS` is the source of truth for packet kinds. |
| `app/schemas/project-file.schema.ts` | Project frontmatter Zod schema (stages, workflow, members, agents, credential policy, guardrails, autonomy). |
| `app/server/interpretation/readiness-policy.server.ts` | The ONLY place readiness is derived. |
| `app/server/files/` | Frontmatter-preserving writers, atomic writes, file mutexes, chokidar watchers, KB injection, skill bodies. |
| `app/server/projections/rebuilder.server.ts` | Files → SQLite projection rebuild. |
| `app/server/tasks/task-actions.server.ts` | Governed task mutations incl. `performDelivery` and the acceptance gate. |
| `app/server/tasks/operator-actions.server.ts` | Operator recommendations, packets, acceptance path. |
| `app/server/tasks/specialist-run.server.ts` | Specialist run assembly: KB union (R18-1), `stripUngovernedRepoCatalog` (R18-3). |
| `app/server/tasks/specialist-tool-policy.ts` | Capability → tool allow/deny mapping (the absent `mcp__*` deny is R16-5's pin). |
| `app/server/runtimes/` | Codex + Claude adapters, `operator-run.server.ts`, run sink/log projection. |
| `app/server/github/` | PAT handling, PR linker, adoption (`pr-adoption.server.ts`), reconciler, workspace delivery. |
| `app/server/db/data-root-lock.server.ts` | Single-writer lock on the data root (one app process per root, ever). |
| `${VIBERR_DATA_ROOT}/` | The file-native store: `projects/<slug>/{project.md,tasks/<KEY>/task.md}`, `agents/profiles/`, `kb/<dir>/`, `state/projection.sqlite`. |
