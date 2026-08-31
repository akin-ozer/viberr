# 00 · Product intent — the viberr canon, digested

**Purpose.** This is the intent reference for pass-31 agents. Load this instead of the raw
PRD. Sources, in precedence order as the tree itself declares it:

- `planning/planning-artifacts/prd.md` — canon PRD (FR1–FR41, NFR1–NFR18).
- `planning/planning-artifacts/architecture.md` — "wins on conflict" over `decisions.md`
  (per that file's own header).
- `docs/architecture/decisions.md` — the 99 numbered **orchestrator rulings**, binding, and
  what code comments cite as `ruling N`.
- `planning/planning-artifacts/ux-design-specification.md` — surface/component contract.
- `planning/discovery-2026-08-30-controller/DESIGN.md` — newest feature design (ruling 99).
- `planning/README.md` — the standing doc-vs-app rule (see §4).

**The standing rule that governs every document here** (`planning/README.md:9-11`):

> When the app and a document disagree and the app is right, the document is corrected —
> with a note saying when and why — rather than the app being "fixed" back. Read a
> requirement's amendment notes before treating it as an instruction.

Consequence for readers: **several FR head-sentences are now false on their own** and are
only correct once their amendment notes are applied (FR14, FR11, FR27, FR39 especially).
Never quote an FR's first sentence as intent without its amendments.

---

## 1. What viberr IS

Viberr is a multi-user, authenticated, desktop-first web application for **governed AI
software delivery** — a task system in which coding agents are the native workers and
humans govern flow, review and acceptance. It targets small AI-forward engineering teams
already running Codex and Claude Code ad hoc, who have lost the ability to say which agent
owns what, what is blocked, and whether branch/PR state still matches reality. The thesis
is that persistent agent work cannot be governed through scattered chats, branches and
status labels, so the product supplies the missing durable operating layer.
(`prd.md:40-46`.)

The central mechanism is **the task as canonical operating contract**. Every task is a real
file on disk — `$VIBERR_DATA_ROOT/projects/<slug>/tasks/<KEY>/task.md` (ruling 3) — holding
identity, goal, state, execution context, timeline, decisions and execution references
(FR12). Files are the only canonical business truth; SQLite projections are disposable and
rebuildable, and nothing writes a projection without file backing (`decisions.md`
§Behavior rules). That choice is what makes the rest of the product's promises mechanically
possible: an agent whose provider-side history is gone **re-anchors on the canonical task
file** and continues (FR22, NFR12, journey 4); a store edited outside the app is
reconciled rather than clobbered (FR10, FR36); and audit truth survives restarts (NFR11,
NFR18).

Around that contract sit three governance systems that are deliberately **kept separate**
(ruling 2): human org roles (`admin|member`), project membership roles as a strict tier
(`admin | maintainer | contributor | viewer`, one grant table in `app/shared/rbac.ts`), and
per-profile **agent capability policy** (`direct | recommend | human | off`) against a
shared capability catalog — plus a short always-human server invariant list (merge PR,
transition to Done, change project policy). Execution is agent-shaped: each active task
gets a **dedicated operator agent** (FR18) that triages, dispatches, recommends and opens
decision packets; specialist agents do stage work through Codex/Claude backends (FR19,
FR21); exactly one **delivering engagement** owns the workspace, branch and PR (the
single-writer invariant, FR14); GitHub is the execution surface, one repo per project
(FR7, FR30). As of ruling 99 there is also one instance-level **controller** — a
conversational agent above the operators whose every tool call runs under the *asking
user's own live authority*, plus **chained goals** (FR40/FR41), the first product concept
that lets one stated outcome unroll into an ordered chain of ordinary tasks.

What the product is deliberately **not**: a GitHub-review replacement, a generic AI
assistant, a public/marketing surface, or a mobile product. SEO and crawlability are
non-requirements; on-premises authenticated deployment is assumed (`prd.md:156-163`).

### 1.1 Surfaces, components and invariants that carry product meaning

**Personas** (`ux-design-specification.md:45-47`): the senior engineer/tech lead supervising
many tasks (Arda, primary); the workflow owner/administrator (Elif, secondary); the senior
troubleshooter called in when continuity fails (Murat, supporting). Three mermaid journeys
ship: Arda supervises, Arda intervenes on inconsistency risk ("the most important exception
journey"), Murat investigates continuity failure ("proves the product's trust model under
stress"). **There is no journey for the admin persona** (see QUESTION 16).

**Two chosen surface directions** out of six explored (`ux:436-464`): the board is the
**Signal Console** — triage-first, "the attention-routing surface", answering *what needs me
now?* in seconds with stage / waiting state / execution profile / validation health legible
**without opening the task**; task detail is the **Operator Desk** — current state, execution
truth, latest packet, human steering actions **above** timeline depth. Rejected: Calm Kanban
("too safe"), Packet First ("more bureaucratic than operational"), Evidence Rail ("denser
than necessary"); Split Focus survives only as a secondary pattern.

**Five workflow components** (`ux:636-713`, phased 1/2/3): **Task Status Card** (a
high-signal supervision object, not a ticket; keyboard-traversable across lanes — D19,
ruling 64); **Decision Packet** (packet type, severity, observed issue, impact, recommended
options, confidence/risk, next action — at the *top* of task detail; **no raw logs inside**);
**Execution Truth Strip** (branch/PR/validation/runtime truth beside task state; drill-in
must not replace the task view); **Mixed Timeline Item** (human + agent comments + typed
events in one chronology, with attachment thumbnails per ruling 96); **Continuity Recovery
Panel** (what is known / missing / still authoritative / recovery path / escalation — D18,
ruling 64). Three semantic patterns underneath: Health-and-Waiting, Execution Profile,
Packet Severity.

**Laws the UX spec states as law:** *status before history*; *decisions before discussion*;
*human attention is scarce*; *calm over chatter*; **one task, one truth**. **At most one
primary action per decision surface** (an informational surface may have none); labels
describe the outcome, not a UI verb. **Toasts must never be the sole record of a
consequential event**; **no modal or overlay may be the sole home of consequential task
truth**. Urgent states "become clearer, not visually louder". Named anti-patterns: generic
kanban sameness, dashboard overload, **log-first design**, **detached approval UX**.
`input gaps / inconsistency risk / blocked / degraded continuity` must never collapse into
one generic "error" treatment. Accessibility rationale (`ux:926`): **"inaccessible state is
untrustworthy state"** — WCAG 2.2 AA in *both* themes for core workflows, keyboard-only +
VoiceOver *and* NVDA, three named critical journeys.

**Architecture, at product level** (`architecture.md`): file-system-authoritative with
projections; the load-bearing negative decision is **"the system should not gatekeep state
changes through an app-controlled write path"** (L46) — four layers (file corpus →
interpretation → projection → diagnostics), and **"every view should be re-derivable from
current files plus current external facts"** (L118). Readiness is modelled **separate from
workflow stage**; branch health, assigned agent, review linkage, waiting target and memory
availability are secondary signals, never readiness values. **Tolerant parsing is a product
behavior**: malformed input produces diagnostics and a readiness downgrade — *silent parse
fallback is forbidden*. **SSE is the only realtime transport**, carrying compact facts, with
clients tolerating reconnects without duplicate side effects; **no optimistic updates for
authoritative task state**. Invariants: **one app process per data root, ever**
(`state/writer.lock`, B-FD1/F18-5); mutating operations require explicit idempotency
protection before retry; secrets never in files, logs, SSE payloads or error messages;
`app/ui/` may not import `app/features/`, routes stay thin. Auth (revised 2026-07-25):
**local email+password is a first-class shipped path**, OAuth optional and inert without env
vars, **no self-signup on any path**, sessions are server-side rows with an opaque cookie
token, and **GitHub OAuth is identity only — repo execution uses user-supplied fine-grained
PATs**. The `workspace/` clone and `.repo-mirror/` are **disposable working state, never a
communication channel and never read as truth**; SQLite is canonical **per-table** (users,
sessions, audit, notifications, sealed PATs, run history) and non-canonical for task/project
truth.

---

## 2. Functional requirements, compressed

Legend: **[A]** = carries amendment notes you must read before acting on it.
**[A!]** = the head sentence is now *false* without its amendments.

### Workspace access & collaboration

| FR | One-line intent |
|----|-----------------|
| FR1 | Team members sign in and reach shared workspaces. |
| FR2 | Admins manage membership and human roles; the system enforces project/task permissions from them. |
| FR3 | Users collaborate in a project with shared visibility into task state changes. |
| FR4 **[A]** | Comment on tasks, addressing agents or teammates in one unified timeline. *Amended 2026-07-04* (commenting is app-wide, non-member comments labeled). *Amended 2026-07-28, ruling 25 / R15-4*: projects are **members-only** — a non-member cannot open the board or tasks at all (routes behave as if the project does not exist; workflow secrecy WI-13 wins). "App-wide" now means *across the projects the user can see*. |
| FR37 **[A]** | One human **task owner** = that task's reviewer and acceptance authority; rights scoped to that task only; a task may be unowned. *Amended 2026-07-25* (the "partly implemented" note was itself stale; R14-2 widened it — the owner governs **any** open decision on their own task, each decision keeping its own inner capability gate). *Amended 2026-07-28, ruling 22 / R15-3*: the widening covers stage-transition recommendations — the Apply click **is** the authorization for that one move, and grants nothing elsewhere. |
| FR38 **[A]** | Contributor-or-above can take/release task ownership self-service; admins can release any owner; changes are typed timeline events + audit. *Amended 2026-08-21, pass 22*: read "Any member" → **contributor**. The code was right (ownership carries acceptance authority, which a viewer must not self-assign); **the requirement was corrected to match, not the code widened**. |

### Project governance & policy

| FR | One-line intent |
|----|-----------------|
| FR5 **[A!]** | "Admin users can create and configure governed delivery projects." *Amended 2026-08-06, F19-29 under ruling 44*: **creation is self-serve for any signed-in user, not admin-gated**; the only guard is authentication and the creator is seeded project **admin**. Deliberate (neighbouring instance-maintenance actions do carry org-admin refusals); pinned by `workspace-routes.server.test.ts`. Nothing downstream is widened. |
| FR6 | Admins define workflow stages, allowed transitions, approval boundaries per project. |
| FR7 **[A]** | Admins define the project's GitHub repository. **One project, one repository.** *Amended 2026-07-25*: the "task-level overrides" clause was **struck** by owner ruling — it was half-built, enforced nothing, and the toggle + copy were deleted rather than the feature finished. |
| FR8 | Admins define separate human RBAC and agent capability policy per project. |
| FR9 **[A]** | Admins define reusable agent profiles (global base + project customization): eligible stages, permitted actions, permitted context resources (skills, MCPs, KBs), permitted web reach, execution backend. *Amended 2026-08-21*: **`use-browser` is a first-class capability** (default off, enforced on both backends by mounting/withholding a Viberr-owned Playwright MCP; output lands in the task's member-only `attachments/`; granting it **forces egress on** — rulings 75, 95). Shipped 2026-08-14 and undocumented in the PRD until pass 22. |

### Task records & lifecycle

| FR | One-line intent |
|----|-----------------|
| FR10 | File-native store, inspectable outside the app; externally created/edited task files are recognized and reconciled. |
| FR11 **[A!]** | "Users can create tasks. **Agents cannot.**" *Struck 2026-07-25*: the "and authorized agents" clause (never implemented). *Amended 2026-08-30, ruling 99*: the bar is on agents **inventing** tasks and it stands — two human-rooted exceptions: the **controller** creating a task as the instrument of an authorized asking user (server enforces that user's own `create-task`), and **chained-goal advancement** (FR41) under the goal creator's re-proven live authority. |
| FR12 | Each task maintains a canonical operating record: identity, goal, state, execution context, timeline, decisions, execution references. |
| FR13 | Tasks move through project-defined stages under governed transition rules. |
| FR14 **[A!]** | "One primary specialist + consultant specialists." **Both amendments reverse the head sentence.** *2026-08-04 (pass 17, D9/Q17-5)*: the model is one uniform `engagements[]` list — **exactly one** `delivers: true` (the *delivering engagement*, sole owner of workspace/branch/PR = the single-writer invariant), all others *supporting*, read-only by default; a supporting engagement whose engage-time `verdictCapable` snapshot is true is a **required reviewer** acceptance waits for. *2026-08-29, ruling 98*: **static pre-assignment is retired** — `engagements[]` is written by the DISPATCH; the operator picks which deployed agent runs at each stage via ONE `run_agent` action (capability `dispatch-agents`), weighing `previousStageId`; humans dispatch through one selector+prompt control; an unengaged profile auto-engages (delivering iff no deliverer and it holds repo-write, supporting otherwise). Single-writer, verdict snapshot and required-reviewer gate unchanged. |
| FR15 | Agents flag low-quality/underspecified tasks and request clarification before execution. |
| FR16 | Typed important events sit alongside conversational updates in one chronology. |
| FR17 **[A]** | Record validation outcomes, evidence references, concise change summaries, compressed history. *Amended 2026-08-21, ruling 96*: **files an agent posts on the task thread** are evidence — any run granted `attach-evidence-references` may copy files into the task's canonical `attachments/`; images render inline as timeline thumbnails with an in-app lightbox, served member-only. Files humans must *see* go here; code and large artifacts still belong in the repo/PR. |

### Agent orchestration & continuity

| FR | One-line intent |
|----|-----------------|
| FR18 | One dedicated operator agent per active task. |
| FR19 | Execute approved agent profiles against tasks through Codex / Claude backends. |
| FR20 **[A]** | Operators recommend assignments, transitions and human decisions, and trigger/re-engage specialist work. *Amended 2026-08-04*: "consultant specialists" = supporting engagements (see FR14). |
| FR21 | Specialists execute stage work and append outcomes, blockers and evidence to the task record. |
| FR22 | Threads resume across stages; a reactivated agent continues from canonical task state even with no prior runtime history. |
| FR23 | Authorized users can reach an agent's native runtime session for deep debugging. |
| FR39 **[A!]** | *(added 2026-07-25)* Schedule a future run on a task that a server-side runner fires with no human present — the one capability letting an agent act unwatched, so it must stay visible, cancellable, auditable; only a run-agents role may create one; canonical in the task file; never fires on a terminal task. *Amended 2026-08-21, ruling 94*: the "carries the backend and autonomy chosen at schedule time" clause is **struck** — a schedule pins neither; the fired run resolves both from the **live deployed profile at fire time**, clamped by the autonomy ceiling. *Amended 2026-08-29, ruling 98*: generalized from "operator re-run" to `run-operator | run-agent`; the separate schedule form is gone (each run control carries a when-picker); the agent arm pins **only profile identity**; a fire-time refusal no retry can cure retires the occurrence as a visible `failed` with its reason. |
| FR40 | *(added 2026-08-30, ruling 99)* ONE instance-level conversational **controller** — machinery like the operator, not a deployable specialist — addressable at `/controller` and `/projects/:slug/controller`, gated **per tool call on the asking user's own live permission**, evaluated separately for instance scope (org role) and board scope (project RBAC matrix). Never a privilege-escalation channel: same governed audited mutations humans use, refusals relayed out loud, nothing deletes, and the always-human decisions (merge, acceptance, force-accept, packet resolution, the move into terminal) have **no controller tool at all**. Only org admins modify the controller itself; conversations are owned by their user (readable by that user and org admins); each turn is a real recorded run. |
| FR41 | *(added 2026-08-30, ruling 99)* **Chained goals**: one outcome decomposed into an ordered chain of tasks in a project, canonical at `projects/<slug>/goals/<id>.md`, tasks created **lazily** (link 1 at definition, each next on real completion of the previous), each a full ordinary task with its own operator. A failed link pauses the chain (`attention`) by default or is skipped under `onFailure: continue`; humans retry/skip/edit/add/pause/resume/cancel. Defining requires the user's own `create-task`; **advancement re-proves the creator's live authority at every step**. Goals are never deleted. |

### Oversight views & human governance

| FR | One-line intent |
|----|-----------------|
| FR24 | Board organized by stage; cards show stage, assigned agent, waiting state (human vs agent), validation status. |
| FR25 | Task detail prioritizes current state, execution profile and latest decision packet **before** the timeline. |
| FR26 | Structured blocking/decision packets generated for human review when agent work needs intervention. |
| FR27 **[A!]** | Humans approve/reject/redirect consequential changes incl. advancement and completion; **transition to `done` is human by default, enforced server-side**. Four stacked amendments: *(a)* the single exception — a full-autonomy operator holding an explicit `completion-for-acceptance: direct` grant (never implied by raising autonomy, audited, UI-disclosed; still refuses failing validation). *(b) 2026-07-28, ruling 20 / R15-1*: acceptance is **verdict-gated** — a review PR whose head carries the delivered revision + a healthy reviewer verdict; audited **Force-accept** is the only bypass (never for a mismatched head); every acceptance passes a confirm dialog naming what merges and what is missing. *(c) 2026-08-04, ruling 40 / R16-6*: **"Done" has two meanings** — `merge-pull-request` is ALWAYS_HUMAN, so an operator acceptance records the PR `accepted` (**merge pending**) and reaches Done with the merge outstanding; only a *human* acceptance triggers the real async merge. *(d) 2026-08-06, rulings 43 + 55/62*: a third ending — **"Completed — no changes"** — a verifiably empty diff (or no branch) closes to Done with no PR and no merge, its own event and confirm dialog, re-verified against the live remote at close time. |
| FR28 | Review progress without raw provider logs or raw validation output. |

### GitHub delivery & traceability

| FR | One-line intent |
|----|-----------------|
| FR29 | Authenticate to GitHub, access authorized repositories for task execution. |
| FR30 | Each task executes against its project's repository; one repo per project, no per-task override (see FR7). |
| FR31 **[A]** | Create/manage task-key branches; associate commits, changed files and review PRs with the originating task. *Amended 2026-07-28, ruling 21 / R15-2*: **delivery is an operator decision, not a stage side-effect** — the operator weighs remaining stages and delivers when the work is plausibly review-ready, opens a decision packet when unsure, may offer early delivery. The server executes the mechanics; a human can trigger delivery directly (audited); **specialists never push or open PRs**; reaching a review stage with no PR is announced with a typed event. |
| FR32 | Branch and PR status visible alongside task state. |

### Integrity, audit & recovery

| FR | One-line intent |
|----|-----------------|
| FR33 **[A]** | Auditable history of human decisions, agent actions, workflow and policy events. *Bounded 2026-07-25*: audit rows are retained **90 days** then hard-deleted by a boot-time retention pass; **no export path in V1** (Phase 2). Task-scoped history survives indefinitely in `task.md`; org/auth-scoped events (sign-in outcomes, user administration, connection-token replacement, PAT changes) are genuinely gone at 90 days. Longer windows = snapshot the data root. |
| FR34 | Isolate secrets/credentials from task-visible artifacts, comments and audit records. |
| FR35 | Task quality issues and policy violations are first-class events. |
| FR36 | Manual project re-scan and state reconciliation on demand. |

### Non-functional requirements

- **NFR1–NFR5 (Responsiveness)** **[A!]** — section renamed from "Performance"; the four
  numeric targets (200-card board ≤2 s, task detail ≤2 s p95, action reflected ≤3 s p95,
  cross-user propagation ≤5 s) are **all struck** by ruling 63 / R19-9: never measured, no
  harness, nothing goes red. Replacements: **NFR1** the board hides nothing to save render
  time and names its unbounded-query scaling limit out loud; **NFR2** a task surfaces
  decision-relevant truth ahead of its depth; **NFR3** every state-changing action
  acknowledges itself (pending affordance, then new state or stated failure) — nothing
  completes or fails silently; **NFR4** shared task state reaches other connected users
  with no manual refresh (SSE + periodic reconciliation fallback); **NFR5** survives, re-cast
  behaviourally — bounded newest-first timeline slice + bounded run-log window, console pages
  backwards. Standing rule: **a latency budget lands in the same change as the harness that
  measures it, never before.**
- **NFR6** encrypt all authenticated and external traffic in transit (honestly the
  deployment's job).
- **NFR7** credentials/tokens/secrets never in task timelines, comments, audit views, or
  general logs.
- **NFR8** **[A]** separate human/agent permission boundaries on every governed action.
  *Amended 2026-08-14, ruling 39 / R16-5*: **MCP server grants sit OUTSIDE the capability
  matrix** — granting a profile a server *is* the authorization to use its tools, whatever
  they do. Consequence, deliberate: an agent with `execute-code-or-write-repo: off` can
  still reach a granted server's write tools. "Every governed action" = every action Viberr
  itself defines and gates.
- **NFR9** least-privilege GitHub/provider credentials by project policy and task context.
- **NFR10** security-relevant actions (policy changes, credential failures, unauthorized
  attempts, human approvals) recorded in audit.
- **NFR11** task-state consistency across restarts, no canonical history lost.
- **NFR12** continue from canonical task state when runtime history is unavailable.
- **NFR13** manual reconciliation/re-scan complete without corrupting canonical state.
- **NFR14** **[A]** GitHub integration failures surfaced with task-relevant context.
  *Amended 2026-08-15*: the "within 10 seconds of detection" figure is **struck** under
  ruling 63's standing rule; the surfacing requirement stands, the stopwatch is gone.
- **NFR15** branch/commit/PR references uniquely traceable to the originating task key.
- **NFR16** idempotent external execution — retries never duplicate transitions, branches,
  PRs or events.
- **NFR17** agent-identity continuity across resumed work, or explicit failure.
- **NFR18** durable audit trail across restarts/resync/runtime failures — "durable" means
  across those events, **not indefinitely**; retention is bounded per FR33.

---

## 3. The 99 numbered rulings, digested

Format: **N** (id, date) — one-line ruling · *where it binds*. All are binding; several are
marked SUPERSEDED/NARROWED in place and are kept because their numbers are cited in code —
**never restore a superseded rule because you found its text.**

**Foundational contracts (1–16)** — mostly from the original CONVENTIONS recovery.

1. Readiness is a canonical 4-value enum (`ready|input_required|inconsistency_risk_detected|blocked`) in files, Zod and SQLite; ONE mapping module to display pills; "Accepted" is derived, never stored. · `readiness-policy.server.ts`, every pill renderer.
2. **Roles: three separate systems, kept separate** — org `admin|member`; project roles (now the strict tier `admin|maintainer|contributor|viewer`, one table `app/shared/rbac.ts` that guards *and* the Policy page render from); agent capability policy `direct|recommend|human|off`, id-based against a shared catalog, with an always-human invariant list (merge PR, transition to Done, change project policy). *Superseded in part by 25* (members-only). · the whole RBAC + capability spine.
3. Task-file store at `$VIBERR_DATA_ROOT/projects/<slug>/tasks/<KEY>/task.md`; the UI renders the REAL store-relative path, never the mock's `.viberr/...`. · file store + every path display.
4. Timestamps are UTC ISO at all boundaries; ONE shared formatter reproducing the mock's display forms. · `app/shared/dates/`.
5. PAT scope violations are server-derived per-scope verdicts + per-violation open/resolved records; the rail badge is the open count; grant/re-validate writes a typed event to the violation's OWN task + audit + SSE. **No global boolean.** · GitHub/PAT surfaces.
6. Identity compares by **user id** everywhere; display names are render-only; the session user id is authoritative. · all authorization and attribution.
7. Packet options carry a stable **`kind`** — never dispatch on English titles. Kind set is **TEN**: `accept_completion, request_edit, block_on_policy, hold_runtime_debug, redirect, retry_other_backend, edit_goal, archive_task, discard_branch, custom`. Agent policy is id-based against the shared catalog; advisory ids with no runtime consumer get no toggle. *Amended by 40.* · `PACKET_OPTION_KINDS` in `task-file.schema.ts`.
8. `tweaks-panel.jsx` is not ported (dev harness); review-queue packet + acceptance mechanics ship **before** the queue surface. · `app/features/review/`.
9. Notifications are per-user SQLite rows sorted by real timestamp DESC; task/project refs are soft refs. *Superseded in part*: the two stub projects are demo fixture only (`npm run seed:demo`); the product seed ships no board data. · notifications + seed.
10. "Waiting on you" / the review queue stay **project-wide** in V1; do not scope per-user, do not change labels. *Superseded for the board (R8-3)*: the board's "Waiting on me" chip and the home card's waiting count are **member-scoped**; the review queue itself stays project-wide. · board filters, home cards, review queue.
11. Run lifecycle is `queued|running|finished|error|interrupted` mapped to mock pills; **raw NDJSON/JSONL is truth**, the log line display is a projection; elapsed derives from `startedAt`; tokens come from real usage envelopes only, never estimates. · run service + runtime panels.
12. PR states map to pills (merged→done, open/draft→in review, closed-unmerged→risk "closed"); sync precedence merged > behind > synced, from real compare data. · GitHub view + task header.
13. Prefs: drop `ghConnected` (derive from the user row); mount Appearance; map plural pref ids ↔ singular notification kinds explicitly, once. *Narrowed*: no mailer in V1 → each category carries a single in-app `app` toggle. · prefs/profile.
14. **Shared single implementations**, never forked per surface: notification meta, the markdown-ish stripper + rich-text renderer, the credential card, the bell popover. Toast/empty-state/boundary copy in the specs is a **verbatim contract**, including intentionally divergent board vs review wording. · shared UI.
15. Stages are a per-project list in `project.md` (hex or `var(--*)` colors), created from an instance-default template. *Narrowed (owner ruling 2026-07-24)*: the "Lightweight · 3 stages" preset was **deleted** — the Standard 5-stage board is the only creation template; custom stage lists are edited per project after creation. · project creation + settings.
16. Deliberate keeps and additions: board rail count includes Done; `.card.urgent` stays visually untreated; `data-screen-label` kept app-wide; minimal list-view empty state; Escape-close + focus-trap + scrim-click on **every** dialog; `operator` stores the stage id and the UI renders "stage \<1-based index\>"; login keeps mock copy but the password minimum is 8. · board, dialogs, login.

**GitHub truth, scopes and the acceptance gate (17–25)**

17. **PR divergence recovery** — out-of-band PR transitions are coordination events: the reconciler fires a `pr-diverged` operator trigger (closed/merged/reopened); a closed PR opens ONE recovery packet (rework · `archive_task` · `archive_task + deleteBranch`). **Remote-branch deletion exists only as that packet resolution** (refuses open PRs and the default branch). · reconciler + packet machinery.
18. Minimum GitHub scopes are **exactly `repo` + `pull_request:write`** (`workflow` and `read:org` dropped); fine-grained tokens prove write via empty-payload dry-run probes (422 = authorized, 403 = refused). · PAT validation.
19. **Scope chips render proven verdicts only** — a chip is evidence (scope header, live probe, open violation); `assumed`/`unchecked` render as an honest "unproven" line, never a pseudo-check. · GitHub page.
20. **R15-1: acceptance requires a verdict** — a healthy reviewer verdict on the delivered revision; the audited admin Force-accept is the only bypass and never bypasses PR-head containment; every accept, force included, shows a confirm dialog naming what merges and what is missing. · every acceptance writer.
21. **R15-2: delivery is an operator decision** — `deliver-review-pr` capability; the operator decides when delivery is plausible, packets when unsure, may offer early delivery; server executes; specialists never push/open PRs; entering the review-role stage with no PR writes a typed event; the human delivery button (maintainer+ / task owner) is the escape hatch. · `performDelivery`, operator toolkit.
22. **R15-3: owner authority covers recommendations** — a task's owner may apply or dismiss ANY operator recommendation on their own task, transitions included; the click is the authorization. · recommendation apply path.
23. **R15-5: global ⌘K palette** — real workspace-wide search (tasks, branches, agents, projects) scoped to visible projects. · `/resources/search`.
24. **R15-6: per-project delete-branch-on-merge** setting, default on — a successful accept-merge deletes the remote task branch. · project settings + merge path.
25. **R15-4: projects are members-only** — non-members cannot open a project's board, tasks or any project surface (404-style; WI-13 secrecy generalized). FR4's app-wide commenting applies within visible projects. · every project route guard.

**Doc discipline, honesty of surfaces (26–34)**

26. **R15-7: ghost profiles are fully conservative** — a run whose profile can no longer be resolved gets nothing permissive: no delivery, no comments, no ask-human, no evidence. · run authority resolution.
27. **R15-8: `design/prd.md` is re-synced with canon** and both maintained; `planning/README.md`'s sync claim must stay true. *Re-affirmed 2026-08-05 after a second failure* — "maintained" now means **byte-identical**, pinned by `prd-sync.test.ts`; **the canon copy is the one to edit**, the design copy is a mirror. · docs.
28. **R15-9: an absent `deliver-review-pr` grant resolves from the project's own governance**, not a constant — the rule reads its effect off the workflow graph (`humanGatesPreWorkAdvance`: no pre-terminal boundary advances automatically ⇒ `recommend`); the gate and the policy surface share ONE function (`absentDeliverReviewPrMode`) so they cannot drift. An explicit grant always wins. · capability resolution + Policy page.
29. **R15-10: the first empty board teaches, once** — one teaching line in the entry column of a zero-task project; every other column bare; the moment any task exists, all columns are bare. · board empty state.
30. **R15-11: the Review queue stays a triage list, but rows name their action** — the row says "Review", deliberately not "Accept", because acceptance is verdict-gated and may refuse: **a control must not name an outcome its surface cannot promise.** · review queue.
31. **R15-12: unenforced capability lines are collapsed, never hidden** — rendered in a counted `<details>`; an omission the reader cannot see is worse than an awkward truth. · capability matrix.
32. **R15-13: settings headings name their own scope** — "Instance settings" and "\<name\> · settings"; every wayfinding string updated with them. · settings surfaces.
33. **R15-14: a resolved agent question goes back to the AGENT THAT ASKED**, by resuming its own session — the packet records `askedBy` (profile id, not label) and resolution routes through the same path an @mention reply takes (resume, re-apply confinement, re-anchor on `task.md`); the operator hand-off remains the fallback so no decision is swallowed. · packet resolution.
34. **R15-15: a task owns a PR only if that task opened it** — `openTaskPr` is the sole writer of the link; the reconciler keeps an owned link honest, never mints one; a PR found on the task's branch that the task does not reference is a branch **COLLISION**, reported as one (task keys restart at 1 on a new data root). · reconciler.

**Pass 16 — adoption, attention, honesty of refusals (35–41)**

35. **R16-1: a pre-existing PR is adopted ONLY IF open AND its head sha IS the delivered revision** — identity, not containment; a task that delivered nothing adopts nothing; a name-matched failure is a reported collision that blocks delivery (`prAdoptionRefusalNote`; `not_open|no_revision|head_unknown|head_mismatch`). Extends 34. · `pr-adoption.server.ts`.
36. **R16-2: `input_required` joins the board's attention predicate**, and the chip is renamed **"Blocked or waiting"** so its label names what it selects. · `board-filters.ts`.
37. **R16-3: terminal GitHub facts outrank process gates in refusal copy** — a closed, unmerged PR is named FIRST; while the PR is closed admin **Force-accept is WITHDRAWN (hidden), not disabled**. Extends 20. · acceptance refusal chain.
38. **R16-4: correctness first with tests, then the full UI/a11y list — nothing deferred out of the pass**; the **disposition audit** (every backlog item re-derived from the tree after the fix waves) is what proves "done" is not "partial". · pass method.
39. **R16-5: MCP grants stay OUTSIDE the capability matrix — granting a server IS the grant.** A withheld `execute-code-or-write-repo` does NOT bound a granted server's tools. A deliberate honesty boundary, disclosed in the matrix UI and pinned by the **absence** of any `mcp__*` deny rule. · `specialist-tool-policy`, capability matrix.
40. **R16-6: merge stays human-only — "Done" has two meanings.** A full-autonomy operator acceptance records `pr.state: "accepted"` (**merge pending**) and moves to Done; a human completes the merge later. Only a human acceptance triggers the real async merge, and **the difference must be visible where the task lives** (board card *and* review queue), not only on the detail page. Corrects ruling 7. · `operator-actions.server.ts`, `capabilities.ts`.
41. **R16-7:** the stale `codex/gpt-5-6-sol-agents` branch was deleted (tip `461d34ab`). **Premise correction**: the pass-16 rationale that certain contributor/testing docs "no longer exist" was wrong — both exist. Record the deletion; discard the premise. · repo hygiene.

**Pass 17 — divergence disclosure, the third ending, doc law (42–46)**

42. **R17-1: acceptance may accept a head AHEAD of the reviewed revision, but MUST surface the divergence** — the gate stays containment-based; the accept and force-accept dialogs show the ACTUAL merge head and "N commits added since review"; the audit names the real merge head. A head that has **diverged** (no longer contains the delivered commit) still refuses. · accept dialogs + audit.
43. **R17-2: a verified no-diff task is a first-class "Completed — no changes" outcome** — closes to Done with no PR and no merge, its own timeline event, operator-recommendable; force-accept and archive are no longer the only exits for a zero-diff task. *The "reviewer verdict optional" clause is SUPERSEDED by 62.* · `no-change-completion.server.ts`.
44. **R17-3: rulings live in `decisions.md`; a docs-canon re-read is a required closing step of every pass.** A ruling a code comment cites but no canon file records is a ruling that gets reversed. Every owner ruling a pass produces is promoted here, in this numbering, before the pass closes; re-reading `file-formats.md`/`deployment.md`/`runbook.md`/`testing.md` against the tree is itself a required closing phase, alongside the disposition audit. · **pass method — binds this pass.**
45. **R17-4: the local sign-in form leads when NO OAuth provider is configured** — disabled "not configured" provider buttons are not rendered; SSO shrinks to a one-line footnote. With ≥1 provider configured, SSO-first stands. · `login.tsx`.
46. **R17-5: "never synced" is neutral; only a genuinely stale cache warns** — `reconcile.at: null` reads "Not synced yet" (neutral); only `stale && at !== null` keeps the alert tone. Matches the MCP-health precedent. · `github-view.tsx`.

**Pass 18 — context governance, delivery aftermath (47–54)**

47. **R18-1: a reviewer inherits the delivering engagement's KBs** — a non-delivering run's KB context is the UNION of its own grants and the deliverer's, deduped, tolerant of an undeployed deliverer, on fresh and resumed/@mention paths alike; deliverer and reviewer must judge against the same conventions. · `deliveringContextGrants`.
48. **R18-2: a full-autonomy delivery re-queues the operator** (`delivered` trigger) because delivery is not a transition and the every-transition re-trigger never fired after it; **SUPERVISED deliberately does NOT re-trigger** (the human is the driver, the "Opened PR" event is the cue). Only a newly opened PR fires it; the chain shares `OPERATOR_TRANSITION_CHAIN_CAP`. · `performDelivery`.
49. **R18-3: the SDK-native skill/command catalog is governed OUT of runs** — a run loads only Viberr's granted skills; the workspace clone's own `.claude` is stripped git-invisibly (`--skip-worktree`, so delivery never ships a `.claude` deletion); Claude launches with `strictMcpConfig: true`. Accepted limitation: a run whose task is to edit the repo's own `.claude` cannot deliver those edits — that is the posture, not a bug. · `stripUngovernedRepoCatalog`.
50. **R18-4: branch-collision stays a human-gated packet — do NOT auto-reset** the remote task branch. The rejected fix was force-resetting to base at execution start; the collision packet is an intentional safety checkpoint against clobbering unrelated remote history. · delivery pre-checks.
51. **R18-5: granted skills reach a Claude run through the SDK's NATIVE skills mechanism** (`skills: ["<granted>"]` discovered via `settingSources`, name+description at startup, body only on invoke), not injected prompt text; the allow-list is also what contains the SDK's compiled-in skills. **Codex keeps prompt-text injection** — an asymmetry that is disclosed, not silent. · `claude-runtime.server.ts`.
52. **R18-6: `design/prd.md` is re-synced to canon and pinned by a test** (`prd-sync.test.ts`, which names the diverging lines). See 27. · docs.
53. **R18-7: accepting from the BOARD asks first** — the drag into the final stage and the keyboard Move menu raise the same confirmation as the task page (ruling 20/FR27 promised the dialog at every acceptance path; three of five lacked it). The drag stays possible; only the silence goes. · `board-page.tsx`.
54. **R18-8: F18-9 closed as NOT REPRODUCIBLE** — both profile modals initialise with empty grants; acting on the note would have *introduced* the over-granting it warned about. **Recorded as a class: a finding taken from a UI impression and never re-verified in code can survive several passes as fact.** · pass method.

**Pass 19 — grounding, refusal, the honesty of numbers (55–72, plus 67/68 as R19-A/B)**

55. **R19-1: the operator gets a FULL read-only clone of the project repo before it triages** — at triage its cwd held only `task.md` and the model invented scoping options from that emptiness. The clone is the SAME per-task checkout a specialist reuses; an existing checkout is returned untouched; read-only is a posture (no delivery capability), not a filesystem mode; a clone failure is a first-class `unavailable` arm carrying git's redacted complaint, never silence. · `operatorWorkspaceView`.
56. **R19-2: repo-documented conventions OUTRANK knowledge bases; the KB supplements.** Where a repo file states a convention (README, CONTRIBUTING, `docs/`, a linter config, the established pattern of the files being edited) the repo wins; a genuine conflict is followed **repo-first and reported by name** as a typed context-conflict event; an existing file family is never rewritten into a KB's style. Ships as ONE constant emitted immediately before the KB bodies, only when real KB text is present. · `KB_PRECEDENCE_NOTE`.
57. **R19-3: reviewer inheritance stays KBs only — 47 stands.** The docstring claiming a widening "to skills by LV-F3" described a widening that never shipped; the owner declined it. Skills are deliberately not inherited; the absence is pinned by a test. Same class as 54. · `specialist-run.server.ts`.
58. **R19-4: a SUPERVISED delivery must leave an actionable next step, and the SERVER guarantees it** — `ensureDeliveredNextStep` synthesizes a "Move to \<review\>" recommendation when an operator-authorized supervised delivery recorded none; conservative (adds nothing when a packet already is the next step, or past review, or no edge exists) and idempotent. · `operator-actions.server.ts`.
59. **R19-5: force-accept MAY skip the remaining stages AND the review gate — but it must SAY so.** A server 409 refusing an off-boundary force was **reverted**: force exists to unstick a wedged board, and a refusal turns the one escape hatch into another wall. The burden is honesty — the affordance is labeled and the dialog **enumerates the skipped stages**. What force does NOT bypass: ruling 37's terminal GitHub fact (now server-side) and ruling 20's head containment. · `forceIrreducibleRefusal`, `accept-confirm.tsx`.
60. **R19-6: a capability set to `off` is a HARD REFUSE by every route — no card, no audit row.** The gate is checked FIRST, before any read/card/audit row, on every path including the terminal-target reroute; `human` refuses the same way while naming the human reservation. **The operator refuses OUT LOUD** rather than silently finding another door. Extends 2 and 39. · `operator-actions.server.ts`.
61. **R19-7: the Activity audit column compacts consecutive runtime-session-open rows** into one expandable "N runtime sessions opened" row (nothing deleted; real per-row timestamps handed back on expand). **The recognizer is anchored at the END of the sentence and that anchoring is load-bearing** — `entry.text` opens with a user-settable display name, so an unanchored matcher let a member name themselves into folding their own `acceptance.forced` rows. · `activity-page.tsx`.
62. **R19-8: a "Completed — no changes required" task passes the SAME verdict gate as every other acceptance** — 43's "verdict optional" clause is superseded; a `workRevision` is minted against the real default-branch head so the verdict has a subject. "Nothing needed changing" is a CLAIM about the repository and is exactly the claim worth a second pair of eyes. **Counterpart honesty rule:** "verified" must mean the server actually looked — `defaultBranchEvidence.verified` is required on both doors (`no_branch`, `no_commits`). · `no-change-completion.server.ts`.
63. **R19-9: the numeric NFR1–NFR5 performance targets are DROPPED from canon — a target nobody measures is a claim, not a requirement.** The damage is the precision: an unenforced number teaches the reader the enforced ones might be decorative too. NFR5 is kept, re-cast behaviourally. **Standing rule: a latency budget lands in the SAME change as the harness that measures it, never before it.** Applies 44 to the non-functional half. · `prd.md` §Responsiveness; later applied to NFR14.
64. **R19-10: the two unshipped spec'd components get BUILT** — the **Continuity Recovery Panel** (D18, the named home of the Murat continuity journey) and **board arrow-key traversal** (D19). Both sit on the product's trust story, not its feature list; the UX spec's descriptions stand unchanged as the build target. · `continuity-recovery.tsx`, `board-page.tsx` roving tab stop.
65. **R19-11: a read-only Viewer does not see the project credential card** — the card is **withdrawn, not disabled** (37's precedent), the predicate is the SAME `ACTION_ROLES` entry the action guard uses (`grant-github-scope`), and **the loader redacts on that same rule** (a client-only gate leaves the token tail in the HTML). Also requires a full-page render at Viewer asserting absence, canaried by removing the gate: **an owner ruling whose guard cannot go red is a ruling that gets reverted in silence.** · `github-view.tsx`, `project.github.tsx`.
66. **R19-12: both accessibility gates get built** — a systematic both-theme WCAG AA contrast sweep, and a check enforcing the spec's "no control is hidden or disabled at any width" contract. Hiding a control below a breakpoint makes the surface **dishonest about what the user may do**; nothing may be gated on `matchMedia`. Both become suite-failing gates. · `app.css.test.ts`.
67. **R19-A: a run may never exceed the project's configured operator autonomy — the per-run level is a CEILING, not a pin.** A per-run dropdown that outranks project configuration makes the Policy page a lie. Choosing *less* autonomy stays allowed; the clamp is audited only **when it actually bites** (`task.operator.autonomy_clamped`). · `clampAutonomy`/`operatorAutonomyFor`.
68. **R19-B: a project member's GitHub approval on the PR counts as the approving verdict.** Closes the asymmetry where disapproval bound the gate but approval was inert. Four conditions make it evidence: bound to the delivered revision (`commit_id` == delivered head, re-checked on every read, so re-delivery invalidates it), approver must be a **project member** resolved via `users.github_handle`, it **fails closed** (unmappable, two claimants, non-member ⇒ does not count, reason recorded), and it is **never silent**. Composes with 20 and 62 — it cannot fire on a no-change verification revision. · `pr-human-approval.server.ts`.
69. **R19-13: git's own failure text is SURFACED to the human, redacted, where it used to be dropped whole.** The credential lives in the askpass env, so token-shape backstop redaction + control-character stripping makes the text safe; git's complaint reaches the run log, fenced timeline blocks, and a ≤240-char delivery reason. One redactor module, one choke point. *(The instruction to record this as "ruling 59" is VOID.)* · `git-output-redact.server.ts`.
70. **R19-14: new tasks are created at the ENTRY stage only** — `createTask` refuses any non-entry `stageId`; the board offers the per-lane button on the entry lane alone. A human could otherwise drop a new task straight into Review and skip the triage quality gate (FR15). File-level fixtures that seed mid-stage tasks are the test surface, not the human path. · `createTask`, `board-page.tsx`.
71. **R19-15: notifications are auto-read on VIEWING their target** — loading a task page marks all of that user's unread notifications for that task read; idempotent, monotonic, emits a converging `notification.read`, and runs only after authorization so the members-only 404 path stays pure. · `markTaskNotificationsSeen`.
72. **R19-16: OAuth sign-in is configured IN THE APP** — an org-settings **Sign-in & SSO** tab; saved credentials **override** the deployment env; enabling a method **requires a passing credential test**. Three honesty rules: saving never enables; changing either half clears the verdict and switches the method off; a passing test says what it proved (the pair) and what it did not (the callback registration). Secrets sealed; picked up per-request, no restart. · `oauth-providers.server.ts`, `sso-panel.tsx`.

**Pass 20 — the tool's own words, capability truth (73–84)**

73. **R19-17: a failed MCP command's OWN WORDS are surfaced — and kept.** stderr is captured (8KB cap), scrubbed through the shared `redactGitOutput`, appended to the probe verdict, **persisted** as `last_error`, and rendered under the row; a first-run install is distinguished from a hung command. · `resources.server.ts`.
74. **R19-18: first-run MCP installs FINISH IN THE BACKGROUND** — a visibly-installing command auto-warms (same handshake, bigger deadline), capped at 15 minutes, tracked by `warming_since` + an in-process registry, with a boot reaper for orphaned flags; the page re-checks until the row becomes a real verdict. · `mcp-warmup.server.ts`.
75. **R19-19: agents get a REAL BROWSER — as a first-class capability.** (a) `use-browser`, default **off**, enforced on BOTH backends by mounting/withholding a viberr-owned Playwright MCP per run; (b) injection stance: page content is **data, never instructions**, never enter credentials, the browser widens no authority; (c) chromium ships IN the app image; (d) output lands in the task's canonical `attachments/`, member-only, citable as evidence. *Amended 2026-08-21: (a) is reversed by 95 (browser now FORCES egress on) and (d) generalized by 96; (b) and (c) stand.* · `capabilities.ts`, `specialist-browser-mcp.server.ts`, `Dockerfile`.
76. **R20-1: confirming a recovery option on a failure packet RESOLVES it and RE-QUEUES the operator** — no repeat confirms (a settled decision refuses the next), option labels state their real effect, a repeat failure opens a NEW packet, and a manual "Run operator" is **refused** while a packet is open (`refused: "open-packet"`) rather than burning a paid no-op. Extends 7 and 17. · `resolvePacket`.
77. **R20-2: `accept_completion` re-verifies the ACTUAL branch state** — empty or missing routes into the no-change path **with disclosure**, regardless of the agent's `noChanges` flag; and the new `discard_branch` packet kind (7's tenth) deletes a never-pushed **local** branch on confirm (`discardLocalTaskBranch` refuses an on-remote branch — remote deletion has always been packet-only). · `no-change-completion.server.ts`, `push-workspace.server.ts`.
78. **R20-3: the provider's OWN WORDS reach the packet and timeline (redacted), and model availability is validated against the account** — a redacted `providerText` from `classifyCodexFailure`/`classifyClaudeError` reaches the `err` line, packet observation, escalation and timeline; availability is marked from a REAL 400 and cleared on a real success (no synthetic probe — 19's proven-verdicts posture) in a `model_availability` table surfaced on the catalog and profile modal. Extends 69. · runtime adapters.
79. **R20-4: a first-ever probe of an npx/bunx-style stdio command that times out is treated as visibly-installing** — extends 74's warm-up to the npx family, armed at most once per command (`first_success_at`, `heuristic_warmups`) and rolled back if it fails. · `resources.server.ts`.
80. **R20-5 (scope): a pass fixes EVERY defect and every UX-coherence/drift item that is a defect or inconsistency — only pure never-built PRD features are HELD.** The held set: **D7** (Decision-Packet anatomy fields impact/confidence/severity), **D10/D11** (Continuity-Recovery-Panel escalated/paused states; the Execution-truth-strip runtime-continuity fact), **D12** (skeleton loaders). Each stays noted as a spec-vs-app gap, never silently dropped. Extends 38. · pass method — **these three are still the open spec-vs-app gaps.**
81. **R20-6: specialists act DIRECTLY or are WITHHELD — `recommend` is dropped for the specialist kind.** The silent `recommend`→`direct` widening is removed AND the seed is made honest: **file = enforcement = display.** The operator keeps its real `recommend`. · `capabilities.ts`, `agent-catalog.server.ts`.
82. **R20-7: the capability display MIRRORS the runtime gate** — the Agents card and Capability matrix bucket grants **autonomy-aware**, so an operator holding `completion-for-acceptance: direct` on a SUPERVISED project renders gated/conditional, not "Acts directly". Extends 67 and 2. · `capabilitiesToActionLabels`.
83. **R20-8:** the seeded Developer's default Codex model becomes `gpt-5.6-terra` (the model this account actually runs). Changes the default, not 78's honesty machinery. · `agent-catalog.server.ts`.
84. **R20-9: the operator MAY gather a delegated ask itself, and the packet must SAY it is standing in for the delivering agent.** Enforcement is **MECHANICAL, not advisory** — the packet-open path APPENDS the disclosure, so omission is impossible even when the model writes no body. The prompt clause survives as guidance layered over a guarantee. Sits beside the standing rule that the operator may not WITHDRAW an agent's ask (`operatorResolvePacket` refuses a packet carrying `askedBy`). · `operator-toolkit.server.ts`.

**Pass 21–22 — display law, ceremony as server invariant, sandbox reversal (85–97)**

85. **R21-2: a capability-gap packet names the product's OWN remedy** — when the blocker is a withheld capability, the packet names it and says where a human grants it (the project's Agents surface), keeping that option beside the workarounds; the operator still changes no configuration itself (`change-project-policy` is always-human). Extends 75. · `operator-run.server.ts`.
86. **R21-3: the anti-slop lint plugin is ADOPTED — `npm run lint` becomes a required CI gate**, and "there is no linter, by decision" is retired (architecture.md's two sentences carry dated amendments pointing here). The 26 remaining findings are **fixed, not suppressed** — a red script whose redness is "accepted" somewhere unreadable is not a gate. **Standing lesson: a mechanical tree-wide rewrite carries the same review bar as behavior, because it changes behavior** (four regressions it introduced were fixed in the same pass). · `.oxlintrc.json`, `tools/oxlint/anti-slop/`, CI.
87. **R21-4: task workspaces clone through a per-project mirror cache, and the pre-run workspace phase is VISIBLE on the task page.** A 3+ minute clone with an empty timeline made a healthy run indistinguishable from a wedged one; `onPhase` — declared on the adapter interface and never once invoked — is actually driven, with a "preparing workspace" phase. Closes FR28's live-progress gap. · `repo-mirror.server.ts`, `runs-panels.tsx`.
88. **R21-5: an acceptance is valid only WITH the disclosure the human was shown — a bare POST is refused.** Ruling 20's ceremony held **client-architecturally only**; it is now a SERVER invariant: the acceptance carries an explicit acknowledgment echoing the displayed facts, and an echo that no longer matches the task's state is a refusal, not a silent write. Deliberately implementation-neutral. Scope is the **human** acceptance paths. Extends 20; puts 59's honesty burden behind a check. · `task-actions.server.ts`, `accept-confirm.tsx`.
89. **R21-6: the triage quality gate stays BEHAVIORAL — no mechanical transition block on open packets.** The owner declined hard-enforcing "no transition while an input-required packet is open": a human moving a task past an open packet is a deliberate act, not an accident to prevent. The New-task placeholder was reworded to promise only what exists. · `board-page.tsx`.
90. **R21-7: `FILES.md` is DELETED, not regenerated** — it claimed to be generated from git's index while trailing reality by ~1,000 files. A doc whose only job a command does better earns deletion over another unenforced regeneration. · docs.
91. **R21-8: while an agent actively carries a task, `input_required` YIELDS to "agent working" — on every surface.** The gate is `waiting === "agent"`; raising a packet flips `waiting` to `"human"` and the pill instantly reasserts. `blocked`/`inconsistency_risk_detected` **never** yield. *Completed 2026-08-27*: the yield now covers **`ready`** too (a green all-clear mid-run is the same defect with a worse tell) and lives in ONE server-side derivation, `deriveDisplayReadiness`; surfaces render the derived `agent_working` value and no longer re-decide it. Stored readiness untouched. · `app/shared/mapping/task.server.ts`.
92. **R21-9: the claude backend's display label is "Claude" (not "Claude Code"), and the operator run control SHOWS, it does not pick.** Per-run backend/autonomy dropdowns are gone (both live on the deployed profile; the run resolves the LIVE profile); the card states the backend, keeps Run, and adds an optional **steer** that rides the `@operator` mention machinery — recorded as the human's own timeline comment, because a directive that reaches an agent off the record is invisible to supervision. Full autonomy announces itself; supervised is the quiet default. · run control.
93. **R22: the Codex OS process sandbox is REMOVED — "viberr itself is the sandbox."** No run gets `read-only`; only a fully-autonomous DELIVERING run holding egress gets `danger-full-access`; everything else is `workspace-write` with the network gated by the egress capability. **The container plus the server-owned delivery gate (push/open-PR/merge/close/Done are server actions no agent tool reaches) are the real boundary.** KEPT: Claude's capability tool-denylist enforcement and EGRESS as an enforced capability on both backends. Consequence: `execute-code-or-write-repo` rejoined the Claude-only enforced set (on Codex it is **advisory** plus the delivery gate) and the matrix copy says so. Supersedes P13-RT-02 and P14-RT-03. · `codex-runtime.server.ts`, `capabilities.ts`.
94. **R22-schedule: a scheduled run resolves the LIVE deployed profile at fire time** — the form offers no pickers, the entry pins nothing, `runOperator` fills backend/autonomy from the deployed profile; no schedule-time clamp is needed because nothing is stored to clamp. FR39's pin is superseded. This is 92's "show, don't pick" applied to the unattended case, where it matters more. · `schedule.server.ts`.
95. **Browser implies egress (#176)** — granting `use-browser: direct` **forces** `use-web-search-fetch: direct` at every profile save path (`repairBrowserEgressGrants` via `applyGrantCouplings`; the editor pins the egress row). The browser IS network egress, so a browser-granted/egress-withheld profile expresses no policy at all — only a trap. Deliberately diverges from the respect-the-explicit-off posture; the runtime mount-refusal survives as the backstop for hand-edited files. Amends 75(a). · `capabilities.ts`.
96. **The attachments drop (#179)** — ANY run granted `attach-evidence-references` may POST FILES on the task thread; the persona section is emitted for any evidence-granted profile, browser or not, so browser screenshots become a special case of the general mechanic. The workspace contract's "never touch anything outside the working directory" now names the drop as its ONE exception, and on Codex the attachments dir joins the writable set. Extends 75(d). · `specialist-run.server.ts`.
97. **The live-backend display law (#183) — every surface displays the backend a run would ACTUALLY use.** Engagement rows snapshot the backend at engage time and heal only on the next run, so between a profile edit and that run the snapshot lies. The server query layer overlays the live deployed `profileId → backend` map (`withLiveAgentBackends`); an undeployed profile keeps its snapshot; stored records are not rewritten. **Layering:** the rule lives in the server layer (`deployment-view.server.ts`) and `features/agents` imports it back — the prior inversion (server importing from features) is removed. Rulings 92 and 94 are this law's other two faces. · board, review, task detail, agents page.

**The two owner directives that define the current shape (98–99)**

98. **Dynamic agent dispatch (2026-08-29) — the static delivering/reviewer slots are GONE.** Preprod, no backwards compatibility. **(a)** Engagements are run-created, not human-assigned (the ledger stays; the dispatch writes it; delivering iff no deliverer AND the profile holds repo-write; explicit `delivers: true` is a hand-off; the assign/engage menus, per-row Run buttons and legacy `specialist`/`reviewers`/`consultants` parsing are deleted; `release-agent` survives as the ledger's ✕). **(b)** ONE dispatch verb everywhere — `run_agent(profileId, prompt?, delivers?)` on both backends; `assign-primary-specialist`+`summon-reviewers` collapsed into **`dispatch-agents`**; four slot-shaped recommendation kinds collapsed into `run_agent`; the choice is an LLM decision fenced by stage eligibility, grants and the selection trace, now weighing the durable **`previousStageId`** fact. **(c)** The **dispatch-completion contract**: a dispatched run's final report always tags the dispatching human AND `@operator`, and its completion ALWAYS re-invokes the operator (mechanical in the pipeline, prompt clause as guidance — R20-9's shape); the @mention path carries the same contract and now **auto-engages** a mentioned deployed agent. **(d)** Scheduling is baked into the run controls (when-picker: now/5m/1h/6h/24h; pending entries list under their control). Extends 21, 67, 92, 94, 97; amends FR14 and FR39; supersedes FR14's static-slot reading. · `operator-actions.server.ts`, `specialist-run.server.ts`, `schedule.server.ts`, `execution-profile.tsx`.
99. **The CONTROLLER (2026-08-30) — one instance-level conversational agent, machinery like the operator but above it, whose every action runs under the ASKING USER's own authority — plus chained goals as a first-class product concept.** Preprod, no backwards compatibility. **(a) Identity**: a third profile kind `kind: controller`, exactly one per instance, with its own doctrine, skill (`controller-guide`), KB (`kb/controller-handbook`) and org-registry MCP grants, shipped by boot backfill; **not deployable** to projects; only org admins modify it (org-settings Controller tab); it carries **NO capability matrix** because its runtime authority is the asker's. **(b) Authority**: every signed-in user converses; every TOOL CALL resolves the asker's **live** authority — org role for instance tools (users/KBs/skills/MCPs/global templates/audit/analytics = org admin; **project creation = any signed-in user**, FR5 parity), the project-role matrix for board tools using the SAME `assertProjectAction`/`requireAction` guards humans use (so the org-admin override, denial audit rows and members-only 404 posture apply identically — a probe cannot learn a project exists). Authority actor is `{userId: asker, label: "<email> · via controller"}`: guards bind to the human, audit discloses the instrument. Refusals are **out loud** (`[denied] <the guard's own sentence>`; instance-scope denials write `controller.authority.denied`). **(c) Always-human stays human**: **no tool** for merge, acceptance, force-accept, packet resolution, or a move into terminal — the move tool refuses a Done target, because ruling 88's disclosure ceremony is the load-bearing thing chat cannot impersonate. Policy edits ARE offered (gated on the asker's `edit-policy`) because ALWAYS_HUMAN `change-project-policy` bounds *agent-initiated* change and the controller never initiates. **No tool deletes anything.** Secrets never travel through chat (one bounded exception: a just-minted single-use temp password). **(d) Conversations**: app-owned SQLite, owned by the asking user, readable by that user and org admins; each user message is one real run (`agent_runs.kind = 'controller'`) inheriting NDJSON, redaction, token accounting, run-log console and boot orphan finalization; turns resume the provider session with a recent-exchange digest as the re-anchor (there is no `task.md`); single-flight per conversation with a FIFO. **CLAUDE-ONLY, enforced and disclosed** — same security decision as `read-github-api`: the toolkit is in-process, so DB handles and sealed credentials never cross a process boundary. **(e) Chained goals**: canonical `projects/<slug>/goals/<goal-id>.md` (status `active|paused|attention|completed|cancelled`, `onFailure: pause|continue`, `links[]`, `createdBy`), projected to `goal_projections` with link statuses **reconciled against live task rows**, back-referenced by each task's `goalRef`; **lazy** creation by the convergent `reconcileGoal` engine (hooked into transition/acceptance/archive writes plus a one-minute runner), under the creator's **re-proven** live `create-task` — lost authority parks the chain in `attention` instead of escalating (FR39's precedent). Failure pauses or skips per `onFailure`; humans redirect via chat or the Goals panel (gate: the creator, or `run-agents`); nothing deletes a goal. Every link's task gets its own operator — **the controller sits above operators and never duplicates them**. **(f)** FR11 amended (see FR11). · `app/server/controller/*`, `goal-actions.server.ts`, `app/features/controller/*`.

**Not law:** the 2026-08-21 UI-preference notes (#180 packet takes the questionnaire's
density; #182 the packet reads as one quiet column; #186 an owned task's owner cell is just
the owner) are **presentation preferences, styling-only** — recorded so a later pass does
not read them as drift. No capability, gate or copy contract changed.

---

## 4. Deliberate-change ledger — "the app was right, the doc was corrected"

This is the list a reader needs so they do not "fix" something back. Each entry: what the
doc used to say, what it says now, when, and why.

**The rule itself** — `planning/README.md:9-11`: when app and doc disagree and the app is
right, the doc is corrected with a dated note, not the app reverted. Ruling 44 (R17-3) is
its enforcement arm: a ruling no canon file records is a ruling that gets reversed, so a
docs-canon re-read is a required closing step of every pass.

### PRD corrections where the code was right

| Where | Change | When / authority |
|---|---|---|
| **FR5** | "Admin users can create projects" → **creation is self-serve for any signed-in user**; creator seeded project admin. The divergence had survived two passes recorded only as a code comment and a test — "exactly the failure mode ruling 44 exists to stop." | 2026-08-06, F19-29 under ruling 44 |
| **FR38** | "Any member" can take/release ownership → **contributor or above**. Owner confirmed the code was right (ownership carries acceptance authority). **"The requirement is corrected to match, not the code widened."** | 2026-08-21, pass 22 |
| **FR37** | The "partly implemented" annotation was **itself stale**; the requirement is now *wider* than originally written (owner governs any open decision on their own task). | 2026-07-25 (R14-2), extended 2026-07-28 (R15-3) |
| **FR39** | The per-schedule backend/autonomy pin clause **struck**; live profile resolves at fire time. | 2026-08-21, ruling 94 |
| **NFR8** | Amendment note added recording that MCP grants sit outside the matrix — "recorded here so a reader of the PRD alone does not get the opposite impression." | 2026-08-14, ruling 39 |
| **NFR14** | "within 10 seconds of detection" **struck** — nothing measured it. | 2026-08-15, under ruling 63 |
| **NFR1–NFR4** | All four numeric latency targets **struck**; replaced with qualitative requirements. | 2026-08-08, ruling 63 |
| **Browser matrix** | Declared support (Chromium/Safari/Firefox) vs verified reality recorded explicitly: the e2e suite runs a single `chromium` project and CI installs that browser alone; **Safari and Firefox have never been run here, automated or manual, in any pass.** The matrix now reads as support *intent*. | 2026-08-19 |
| **Responsive** | The planned "review-first mode below 768px" was **never built**; the intent is **retired** rather than left as an instruction to build it. Narrow viewports get the *same surface, reflowed* — every action, including destructive and governance actions, stays available. | 2026-07-25 |

### Features deleted rather than finished

| Where | Change |
|---|---|
| **FR7** | Task-level repo override: half-built (nothing wrote a task-level repo; the admin toggle enforced nothing; a task pointing at another repo would authenticate with the project's credential anyway). **The toggle and its copy were deleted** rather than the feature completed. (2026-07-25) |
| **FR11** | "and authorized agents" — never implemented on any layer; struck. (2026-07-25) |
| **Ruling 15** | The "Lightweight · 3 stages" creation preset was **deleted**. (2026-07-24) |
| **Ruling 41** | The stale `codex/gpt-5-6-sol-agents` branch deleted (tip `461d34ab`). |
| **Ruling 90** | `FILES.md` **deleted, not regenerated** — it claimed to be generated from git's index while trailing by ~1,000 files. |
| **Ruling 13** | Email/nudge preference shapes **removed** rather than kept schema-only (no mailer in V1). |

### Corrections *inside* `decisions.md` itself

| Where | Change |
|---|---|
| §Data & naming | The example table list said `sessions` — **a table that does not exist**; better-auth owns four SINGULAR camelCase tables (`user`, `session`, `account`, `verification`). The invented name had already propagated into `docs/operations/runbook.md`. (2026-08-06, F19-17) |
| §UI porting rules | "Keep `viberr.css` classes and CSS variables **exactly**" clarified (N19-4): "exactly" bound class **names** and the flat unprefixed convention — **not the mock's VALUES**. Deliberately diverged: `--radius-card` 16px / `--radius-panel` 22px vs the mock's 18/28; no canvas/large radius token; display face is **Manrope, not Roobert PRO**; `--pink`/`--dark-red`/`--radius-large` exist in `design/*.html` and nowhere in the app. **`app/app.css`'s `:root` is the ONLY token source.** (2026-08-06) |
| Ruling 7 | Packet kind count corrected nine→ten against `PACKET_OPTION_KINDS`, the source of truth (`archive_task` had arrived unrecorded; `discard_branch` added 2026-08-15). |
| Ruling 41 | **Premise correction**: the pass-16 rationale that contributor/testing docs "no longer exist" was wrong — both exist. The deletion stands; the premise is discarded. |
| Ruling 47 | Function names corrected (`deliveringKbGrants`→`deliveringContextGrants`). (2026-08-06) |
| Ruling 54 | F18-9 closed **NOT REPRODUCIBLE** — acting on the note would have introduced the over-granting it warned about. |
| Ruling 57 | A docstring claiming inheritance had been "widened to skills by LV-F3" described a widening that **never shipped**; the string existed nowhere else in the repo. Corrected, and the absence pinned by a test. |
| Ruling 69 | A spec instruction to record it as "ruling 59" is **VOID** (59 is taken by R19-5). |
| Ruling 84 | `R20-9` was cited by name in a shipped prompt and its test while no canon file recorded it — ruling 44's failure mode reproducing one pass later; promoted 2026-08-19. **`R21-1` is deliberately NOT promoted**: an operational step during a pass is not a rule that binds the product, and "canon that absorbs run-log entries stops being readable as law." |
| Ruling 86 | `architecture.md` said **twice** that there is no linter *by decision* while oxlint had already been installed and 387 files rewritten; both sentences plus the CI/CD note carry dated amendments pointing at the ruling. Also: the ruling openly states which half of itself was still in flight when written. |
| Ruling 88 | Citation corrected 2026-08-19: it had read "rulings 40, 77, 82"; **82 is a neighbouring guarantee, not a disclosure carried with an acceptance.** |
| Ruling 55 | History note: a cheaper read-only view was **weighed and declined** — recorded so nobody re-proposes it. |
| Ruling 59 | A pass-19 implementer's server-409 refusing an off-boundary force-accept was **reverted by the owner** — the fix was built on a false premise. |
| Ruling 75 | Amended 2026-08-21: two of its four decisions moved ((a) egress polarity reversed by 95; (d) output generalized by 96). |
| Ruling 43 | Its "reviewer verdict optional" clause **superseded** by 62. |
| Rulings 2, 9, 10 | Marked **superseded in part** (members-only; demo-only seed projects; member-scoped board waiting). |
| Route map | Corrected 2026-08-06 against `app/routes.ts`: `/projects`, `/notifications/read`, `/prefs/theme`, `/resources/search` shipped but were never listed. |

### Corrections in the UX design specification

| Where | Change |
|---|---|
| §Implementation Approach (N19-4, 2026-08-06) | `app/app.css`'s `:root` is the **ONLY** token source and has drifted from the mock in both directions. Shipped radius card **16**/panel **22** (mock 18/28); **no canvas/large radius token at all**; `--pink`, `--dark-red`, `--radius-large` are documented but **undefined** — "using one in app code yields an empty value, not a colour". Tokens the app added that no spec records: `--agent*` (violet agent-identity tint), `--cta-*`, `--faint`, `--hairline`, `--shadow-*`, `--ease-out`, `--rail-w`, `--topbar-h`, `--radius-chip`. **No spacing scale and no elevation scale.** "Never copy a value out of `design/*.html`; read the `:root` block." |
| §Color System (superseded + N19-4) | "The concrete palette above is **advisory and the build did not take it**." Shipped direction is a bright Miro-inspired canvas: **`#5b76fe` blue, not steel blue**, pastel semantic surfaces, a violet agent tint distinct from human blue. `design/design-system.html` is "a reference MOCK, not the token source — and it has itself drifted"; the prior notes cited it as "the shipped X", "which reads as an authority claim it cannot support". **"Where they disagree the app is right and the doc is what gets corrected."** |
| §Typography (superseded; corrected N19-2, 2026-08-06) | Shipped: **Manrope** display, **Noto Sans** body, **JetBrains Mono** technical, self-hosted. The note previously named **Roobert PRO**, which "is not web-available and has never shipped anywhere in the product"; a duplicate `:root` 2600 lines later had been silently overriding it. Lesson recorded verbatim: **"A superseding note that has itself gone stale is worse than the advisory text it supersedes, because it is the line a reader trusts instead of checking."** |
| §Spacing & Layout (superseded) | The ported design system defines **no spacing tokens and no 12-column grid**; match the surrounding component's rhythm — a retrofit "would touch every surface for no user-visible gain". |
| §Responsive Strategy (2026-07-25) + §Implementation Guidelines (2026-07-28) | "This section previously specified **three capability modes**; that model was **never built and has been retired** rather than left standing as an instruction." One surface, reflowed. "A user on a narrow window is a supervisor with less room, not a different kind of user with fewer rights." The "review-first mobile" guidance was "a leftover this document had already retired". |
| §Testing Strategy (2026-08-19, U6) | Cross-browser line qualified in place: only chromium is exercised; the Safari/Firefox halves are "an **open item, not a practice this product follows**". |
| Three deliberate **non-certifications** | Board lane traversal, the Continuity Recovery Panel, and the two a11y gates each record the *ruling* and explicitly refuse to assert shipped state — "read the tree". Ruling 64's reusable principle: **"a rule this document knows only as an unbuilt spec line is a rule the next pass re-files as a gap."** |

### Corrections in the architecture document

| Where | Change |
|---|---|
| §Authentication (revised 2026-07-25) | The section "originally specified OAuth-first login, **which is not what shipped** and would mislead anyone extending auth". Local credentials are first-class; server-side session rows are recorded as **not a divergence** — an opaque token satisfies the no-claims-in-the-cookie rule "absolutely rather than by discipline". |
| §Infrastructure CI/CD + §Enforcement + tree note (reversed 2026-08-19, ruling 86) | "There **IS** a linter, and it is a gate" — replacing "there is no linter or formatter, and adding one is a deliberate non-goal", which "was left standing, which is the drift U1 was filed for". The linter machine-checks the anti-slop implementation patterns **only** — none of the naming/module-boundary/dumping-ground rules are expressible in it, so a reviewer remains the only gate for those. No formatter, still a non-goal. |
| §Development Workflow (2026-08-19) | e2e was described as running against "a real dev server", which it has not since **2026-08-02** — it runs against the **production Docker image** in an isolated Compose stack, owner policy. |
| Runtime data root (amended 2026-08-21) | The `attachments/` bullet used to end "specified here and never implemented; do not write to it", **"which had been flatly false since 2026-08-14"**. Attachments are real, per-task, member-only served, thumbnailed. **There is no retention machinery** — files ride with the task directory. |
| Runtime data root (corrected 2026-07-25) | "The original text called the whole file non-canonical, **which read as 'disposable'**" — `projection.sqlite` is the sole home of users, sealed PATs, sessions, audit, notifications and run history. **The distinction is per-table, not per-file.** Restoring `projects/` without the DB re-mints user ids and orphans every membership and task owner. |
| Runtime data root (P11-56) | There is **no `cache/`, `auth/` or `logs/` directory** — all three were prescribed and then removed on purpose. |
| §Architectural Boundaries (corrected 2026-08-06) | The doc prescribed `app/routes/auth.callback.*.tsx`, replaced by the better-auth migration: **"no such route exists or should be created."** |
| Tree preamble + §Structure Completeness (2026-07-25 / 08-06 / 08-19) | The tree is **descriptive, regenerated from the filesystem**: "a directory that is not here does not exist, and a directory here that you cannot find is **a bug in this document, not a gap to fill**." It "drifted badly" as a prescription (a `features/auth/` that never existed; six omitted server modules including the largest). |
| Tree note (undated) | `docs/operations/pat-management.md` was "**prescribed and never written** … so it was dropped from this tree rather than left as a phantom". |
| §Subsystem Mapping (pass 19) | **Four PRD-mandated subsystems were absent from the document entirely** — decision/blocking packets, the operator agent, specialist execution, context resources — "which is how they ended up with no named home". |

### Held, not dropped (ruling 80 / R20-5)

Three spec-vs-app gaps are **deliberately unbuilt** and must stay noted rather than silently
closed or silently ignored: **D7** (Decision-Packet anatomy fields: impact / confidence /
severity), **D10/D11** (Continuity-Recovery-Panel escalated + paused states; the
Execution-truth-strip runtime-continuity fact), **D12** (skeleton loaders).

---

## 5. Open questions & ambiguities

Each is a place where the canon documents genuinely tension with each other, or where intent
is under-specified. These are for the pass to resolve or to consciously carry.

**QUESTION 1 — FR4's non-member commenting vs ruling 25.** FR4 still states that "every
registered user may comment on any task, including tasks in projects they are not a member
of, and non-member comments are visibly labeled as such", then amends itself with ruling 25
(members-only, 404-equivalent). Under members-only, what state still produces a non-member
comment that needs the label? The org-admin D2 override is the only path that comes to mind
(ruling 99(b) confirms the override exists for controller reads). Is the "non-member
comment" label live machinery, or vestigial copy for an unreachable state?
*(`prd.md` FR4; `decisions.md` rulings 2, 25, 99(b).)*

**QUESTION 2 — the controller's policy-edit carve-out is a principle with one instance.**
Ruling 99(c) admits policy edits to the controller because `change-project-policy`'s
ALWAYS_HUMAN entry "bounds AGENT-initiated change, and the controller never initiates."
That same reasoning ("the human's conversational directive *is* the human action") would
also admit acceptance and merge — and deliberately does not, because ruling 88's disclosure
ceremony "is the load-bearing thing chat cannot impersonate." So the distinguishing test is
*whether the action has a ceremony*, not whether it is ALWAYS_HUMAN. That is coherent, but
it means **any future ALWAYS_HUMAN action without a ceremony is implicitly controller-
eligible.** Is that the intended rule, and should policy edits gain a ceremony (or the
controller a disclosure echo, ruling 88's shape) so the boundary rests on something other
than which actions happen to have dialogs today?

**QUESTION 3 — org admins read project-scoped controller transcripts.** Ruling 99(d):
conversations are "readable by that user and org admins", justified as "a transcript is
scoped to what ITS user was entitled to hear." That bounds the *writer*, not the *reader* —
an org admin who is not a project member can read a transcript full of that project's board
truth, which ruling 25's members-only posture (and WI-13 workflow secrecy) otherwise
withholds. The D2 org-admin override may already make this consistent; if so it should be
stated as the reason. If not, it is a secrecy hole with a friendly name.

**QUESTION 4 — which document actually wins, and in which direction?** `decisions.md`'s
header says it condenses `architecture.md`, "which wins on conflict." Practice contradicts
that in both directions: ruling 86 is an owner ruling that *amends architecture.md* (its
"no linter, by decision" sentences were simply wrong while a gate was shipped), and rulings
44/63/94/98/99 amend the PRD. Meanwhile rulings 64 and 66 have the **UX spec winning over
the app** — unbuilt spec lines were ordered *built*, not retired. So precedence is
genuinely conditional: **the app wins on facts** (tokens, fonts, file layout, tool config),
**the spec wins on product promises the owner still endorses** (trust and accessibility
surfaces), and **only an owner ruling settles which category a thing is in**. This is the
rule other agents will most often need and cannot derive from any single file. Should it be
stated explicitly in canon, and should `decisions.md`'s header be corrected?

**QUESTION 5 — FR head-sentences that are now false.** FR5, FR11, FR14, FR27 and FR39 each
open with a sentence their own amendments reverse; FR14's opening ("one primary specialist
and additional consultant specialists") describes a model retired twice over (pass 17,
then ruling 98). The amendment-note style is deliberate and preserves history, but it means
any agent or human who quotes an FR's first line gets the wrong intent. Should the FR bodies
be rewritten to the current model with the amendment history moved below a rule, given
ruling 44's spirit? (This digest works around it with the **[A!]** marker.)

**QUESTION 6 — NFR1's scaling limit has no threshold.** Ruling 63 replaced the 200-card
figure with "the board is not virtualized and its query is unbounded, so a very large
project is a known scaling limit to be measured and fixed **when a real one exists**." There
is no definition of "a real one" and, by ruling 63's own standing rule, no harness may be
added without the budget it measures — which reads as circular. What event is supposed to
trigger the fix, and who notices it?

**QUESTION 7 — the declared browser matrix is unverifiable intent.** The PRD declares
current Chromium, Safari and Firefox desktop, then records that Safari and Firefox have
never been exercised in any pass. Under ruling 63's logic (an unenforced claim is
decoration), is the three-browser matrix a requirement this pass should either verify or
strike down to chromium? The amendment stops short of deciding.

**QUESTION 8 — is the Codex posture still consistent with NFR8?** Ruling 93 makes
`execute-code-or-write-repo` **advisory** on Codex (enforcement is the server-side delivery
gate), and ruling 39 puts MCP tools outside the matrix entirely. Combined, a Codex run with
a granted write-capable MCP server has no Viberr-enforced file/command boundary at all
inside its workspace. NFR8 ("separate permission boundaries ... on every governed action")
carries an amendment note for the MCP half only. Should NFR8 gain a second amendment note
recording the Codex-advisory half, so a PRD-only reader gets the true picture? *(This is the
same class of omission that ruling 39's own note was written to close.)*

**QUESTION 9 — the 90-day audit retention has no ruling number.** FR33's hard bound is
recorded only in the PRD ("Bounded 2026-07-25") with no corresponding numbered ruling, while
NFR10 requires security-relevant actions to be recorded and NFR18 requires a reconstructable
trail. Sign-in outcomes, user administration and PAT changes are "genuinely gone at 90 days"
with no file counterpart and no export path. For a product whose thesis is governance and
auditability, is 90 days an owner decision that should be promoted into `decisions.md` under
ruling 44, and is "snapshot the data root" an acceptable answer in canon?

**QUESTION 10 — FR23's "authorized users" is undefined.** FR23 grants access to an agent's
native runtime session for deep debugging without naming a role. Ruling 99(d) gates the
controller's run-log console "owner-or-admin"; ruling 65 (R19-11) establishes the principle
that a surface shows a role only what it may act on and that loaders must redact on the same
predicate. Which `ACTION_ROLES` entry governs FR23 today, and does the runtime console leak
anything a viewer should not see?

**QUESTION 11 — ruling 98 vs FR39's "pins only profile identity".** Ruling 94 says a
schedule pins *nothing*; ruling 98(d) says the agent arm pins *profile identity*. Both are
true and reconcilable (identity is the scheduled decision; capability/backend/model resolve
live), but the PRD now carries three stacked amendments on FR39 saying subtly different
things. A single restatement would remove a real re-derivation cost for every future reader.

**QUESTION 12 — the held D7/D10/D11/D12 gaps have no expiry.** Ruling 80 held them as "pure
never-built PRD features", noted as spec-vs-app gaps. They have now been carried across
passes 20–30. Are they Phase-2 scope (in which case the UX spec should say so), or debt the
next pass builds the way ruling 64 decided for D18/D19?

**QUESTION 13 — the controller and chained goals exist in exactly one canon file.** Ruling
99 / FR40 / FR41 shipped 2026-08-30, but **neither the UX specification nor the architecture
document mentions them at all**: no conversational surface, no Goals panel, no transcript
component, no persona or journey for "a user directs an instance-level agent"; and in
architecture no `goals/` directory in the data root, no `app/server/controller/`, no
`app/features/controller/`, no `goal-file.schema.ts`, while `controller.updated` and
`goal.updated` are live SSE events. This is the single largest intent gap in the tree, and
it is precisely the failure mode ruling 44 exists to stop (a rule readable in only one place
is a rule that gets reversed). Should pass 31 write the controller into both documents?

**QUESTION 14 — "reassign" is retired vocabulary the UX spec still teaches as a core verb.**
The spec names reassignment five times as a first-class human steering action, including as
its worked example of a *primary* action in the button-hierarchy law. Ruling 98(a) **deleted**
the assign/engage menus, the per-row Run buttons and the `assign-specialist` /
`run-specialist` / `assign-reviewer` / `run-reviewer` intents; engagements are run-created
and humans dispatch through one selector-plus-prompt control, with only `release-agent`
surviving. The Execution Profile Pattern needs re-basing on **dispatch**. Related: ruling
98(d) partially supersedes the spec's "the run controls SHOW, they do not pick" note —
backend and autonomy are still shown-not-picked, but the human now explicitly picks *which
agent* and *when*. Is the restated law "configuration lives on the profile and the surface
discloses it; the dispatch target and timing are the human's choice"?

**QUESTION 15 — the UI renders a state neither doc declares.** The spec's State Semantics
section insists "every state must mean the same thing everywhere" and enumerates four
canonical readiness values; ruling 91 adds a **derived fifth display value, `agent_working`**,
which `input_required` and `ready` yield to while `waiting === "agent"` (and which `blocked`
and `inconsistency_risk_detected` never yield to). Ruling 1's "Accepted is a derived display
state, never a stored readiness" is likewise recorded in neither doc. The file/wire contract
is unchanged, so this is not a conflict — but a reader of either document will not learn what
the UI actually shows. Should derived display states get a named home in the spec?

**QUESTION 16 — the admin/workflow-owner persona has intent but no journey.** The UX spec
names her as a secondary persona and the PRD gives her a full journey (Elif: stages,
transitions, default repo, RBAC and the agent capability matrix configured *separately*,
deciding which specialists are eligible and what skills/MCPs/KBs each may load). The spec
ships mermaid journeys for Arda ×2 and Murat only, and **no workflow component or semantic
pattern serves configuration** — yet `policy/`, `agents/`, `project-settings/` and
`org-settings/` are four shipped feature surfaces governed only by the generic form-pattern
section. Intent gap, not a divergence: is configuration UX in scope for a pass?

**QUESTION 17 — architecture.md's stale islands.** Several statements survive with no
amendment note while the rest of the document is scrupulously corrected: it says twice that
the chosen starter **includes Tailwind** and promises "Tailwind-ready UI scaffolding", while
its own tree note says no Tailwind or PostCSS config "has ever existed here"; its Deferred /
Gap lists still say the auth library, the OAuth library and the PAT encryption primitive
"are not fixed yet" when better-auth and AES-256-GCM are named elsewhere in the same file;
its route/feature counts disagree with each other (26 vs 25 routes) and with the tree (29
route entries, 18 feature folders — `controller/` and `insights/` appear nowhere); and its
canonical SSE examples (`task.readiness-changed`, `auth.session-expired`) never shipped.
Under the document's own promise — "a divergence is a doc bug to fix, not scope to build" —
these are doc bugs. Do they get fixed this pass, or are they explicitly out of scope?

**QUESTION 18 — mobile leftovers survive the retirement.** The a11y section still asks for
"touch targets large enough for **tablet and mobile review flows**" and the testing section
for "**reduced-complexity review on smaller screens**" — vocabulary from the three-capability-
mode model the same document retired as never built, and from a mobile target the PRD
excludes from V1. Harmless in effect (larger targets are fine) but it cites a mode the
product deliberately does not have, which is the exact leftover class fixed elsewhere in that
file.
