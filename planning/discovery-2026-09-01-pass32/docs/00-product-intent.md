# 00 · Product intent — the viberr canon, digested

**Purpose.** This is the intent reference for pass-32 agents. Load this instead of the raw
PRD. Every claim and every `path:line` citation below was re-verified against the tree at
`main` @ `68b5480e` (2026-09-01). Sources, in precedence order as the tree itself declares
it:

- `planning/planning-artifacts/prd.md` — canon PRD (FR1–FR41, NFR1–NFR18), 301 lines.
- `planning/planning-artifacts/architecture.md` — "wins on conflict" over `decisions.md`
  (per that file's own header), 1264 lines.
- `docs/architecture/decisions.md` — the **108** numbered orchestrator rulings, binding, and
  what code comments cite as `ruling N`, 1659 lines.
- `planning/planning-artifacts/ux-design-specification.md` — surface/component contract,
  1176 lines.
- `planning/discovery-2026-08-31-pass31/docs/` — the seven pass-31 reference docs; `03`
  (operator + controller) is the source architecture.md's new controller section was
  written from and is the deepest description of ruling 99/107/108 machinery.
- `planning/discovery-2026-08-30-controller/DESIGN.md` — the original ruling-99 feature
  design (superseded in detail by the retrofits below; kept for rationale).
- `planning/README.md` — the standing doc-vs-app rule (see §4).

**The standing rule that governs every document here** (`planning/README.md:9-11`):

> When the app and a document disagree and the app is right, the document is corrected —
> with a note saying when and why — rather than the app being "fixed" back. Read a
> requirement's amendment notes before treating it as an instruction.

Consequence for readers: **several FR head-sentences are false on their own** and are only
correct once their amendment notes are applied. Since 2026-08-31 the PRD marks them
inline — FR5, FR11, FR14, FR27 and FR39 each open with a bracketed
`**[Amended — the head sentence below predates … read the amendment notes first.]**`
(`prd.md:214`, `:223`, `:226`, `:249`, `:239`). Never quote an FR's first sentence as intent
without its amendments.

**What changed since the pass-31 edition of this document** (delta `f868f131..HEAD`,
63 files, ~4 500 insertions): nine new rulings (100–108); the PRD's browser matrix cut to
Chromium; FR33 gained an export-before-purge; the operator-brevity guardrail deleted;
architecture.md gained a full **Controller and Chained Goals** section plus recounted
route/feature/server inventories and a corrected SSE example set; the UX spec gained a
**Controller and Goal Chain Surfaces** section, two component specs, a Phase 4 roadmap
entry, an `agent_working` amendment and a goal-chain state-family amendment. Eight of the
eighteen pass-31 open questions are now answered (§5).

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
file on disk — `$VIBERR_DATA_ROOT/projects/<slug>/tasks/<KEY>/task.md` (ruling 3,
`decisions.md:151`) — holding identity, goal, state, execution context, timeline, decisions
and execution references (FR12, `prd.md:224`). Files are the only canonical business truth;
SQLite projections are disposable and rebuildable, and nothing writes a projection without
file backing (`decisions.md:81-83`). That choice is what makes the rest of the product's
promises mechanically possible: an agent whose provider-side history is gone **re-anchors on
the canonical task file** and continues (FR22, NFR12, journey 4); a store edited outside the
app is reconciled rather than clobbered (FR10, FR36); and audit truth survives restarts
(NFR11, NFR18).

Around that contract sit three governance systems that are deliberately **kept separate**
(ruling 2, `decisions.md:137`): human org roles (`admin|member`), project membership roles as
a strict tier (`admin | maintainer | contributor | viewer`, one grant table in
`app/shared/rbac.ts`), and per-profile **agent capability policy**
(`direct | recommend | human | off`) against a shared capability catalog
(`app/shared/capabilities.ts`) — plus a short always-human server invariant list (merge PR,
transition to Done, change project policy). Execution is agent-shaped: each active task gets
a **dedicated operator agent** (FR18) that triages, dispatches, recommends and opens decision
packets; specialist agents do stage work through Codex/Claude backends (FR19, FR21); exactly
one **delivering engagement** owns the workspace, branch and PR (the single-writer invariant,
FR14); GitHub is the execution surface, one repo per project (FR7, FR30). Above the
operators sits one instance-level **controller** (FR40, ruling 99) — a conversational agent
whose every tool call runs under the *asking user's own live authority* — plus **chained
goals** (FR41), the first product concept that lets one stated outcome unroll into an ordered
chain of ordinary tasks. As of 2026-09-01 the controller also carries a built-in, unremovable
read-only diagnostics MCP (`viberr_ops`, ruling 107) and its own configuration is
**deployment-locked by default** (ruling 108).

What the product is deliberately **not**: a GitHub-review replacement, a generic AI
assistant, a public/marketing surface, or a mobile product. SEO and crawlability are
non-requirements; on-premises authenticated deployment is assumed (`prd.md:156-163`).

### 1.1 Surfaces, components and invariants that carry product meaning

**Personas** (`ux-design-specification.md:53-57`): the senior engineer/tech lead supervising
many tasks (Arda, primary); the workflow owner/administrator (Elif, secondary); the senior
troubleshooter called in when continuity fails (Murat, supporting). The named journeys live
in the PRD (`prd.md:81-87`, four journeys). Three mermaid journeys ship in the UX spec:
Arda supervises (`ux:510`), Arda intervenes on inconsistency risk (`ux:539`, "the most
important exception journey"), Murat investigates continuity failure (`ux:569`, "proves the
product's trust model under stress"). **There is still no journey for the admin persona** —
`Elif` appears zero times in the UX spec (see QUESTION 16).

**Two chosen surface directions** out of six explored (`ux:470-507`): the board is the
**Signal Console** — triage-first, "the attention-routing surface", answering *what needs me
now?* in seconds with stage / waiting state / execution profile / validation health legible
**without opening the task**; task detail is the **Operator Desk** — current state, execution
truth, latest packet, human steering actions **above** timeline depth. Rejected: Calm Kanban
("too safe"), Packet First ("more bureaucratic than operational"), Evidence Rail ("denser
than necessary"); Split Focus survives only as a secondary pattern. **Amended 2026-08-31**
(`ux:506`): the product model is **three** surfaces now — the controller is the surface for
work that has no task yet, and is neither a split view nor a preview pane; Signal Console
and Operator Desk are unchanged.

**Seven workflow components** (`ux:783-870`, phased 1/2/3/4 at `ux:901-930`): **Task Status
Card** (`ux:787` — a high-signal supervision object, not a ticket; keyboard-traversable
across lanes, D19/ruling 64); **Decision Packet** (`ux:800` — packet type, severity, observed
issue, impact, recommended options, confidence/risk, next action, at the *top* of task
detail; **no raw logs inside**); **Execution Truth Strip** (`ux:811` — branch/PR/validation/
runtime truth beside task state; drill-in must not replace the task view); **Mixed Timeline
Item** (`ux:822` — human + agent comments + typed events in one chronology, with attachment
thumbnails per ruling 96, `ux:833`); **Continuity Recovery Panel** (`ux:835` — what is known
/ missing / still authoritative / recovery path / escalation, D18/ruling 64); and, added
2026-08-31 under ruling 99, **Controller Conversation** (`ux:848`) and **Goal Chain Panel**
(`ux:859`). Three semantic patterns underneath (`ux:754-782`): Health-and-Waiting, Execution
Profile, Packet Severity — the Execution Profile pattern carries the 2026-08-31 amendment
retiring "reassign" in favour of **dispatch** (`ux:768-774`).

**Laws the UX spec states as law:** *status before history*; *decisions before discussion*;
*human attention is scarce*; *calm over chatter*; **one task, one truth** (`ux:111-117`).
**At most one primary action per decision surface** (an informational surface may have none);
labels describe the outcome, not a UI verb (`ux:974-980`). **Toasts must never be the sole
record of a consequential event** (`ux:993`); **no modal or overlay may be the sole home of
consequential task truth** (`ux:1072`). Urgent states "become clearer, not visually louder".
Named anti-patterns (`ux:203-212`): generic kanban sameness, dashboard overload,
**log-first design**, **detached approval UX**. `input gaps / inconsistency risk / blocked /
degraded continuity` must never collapse into one generic "error" treatment (`ux:954`).
Accessibility rationale (`ux:1117`): **"inaccessible state is untrustworthy state"** — WCAG
2.2 AA in *both* themes for core workflows, keyboard-only + VoiceOver *and* NVDA, three named
critical journeys (`ux:1151-1155`).

**Two state families, and a derived display value.** The four canonical readiness values are
`ready | input_required | inconsistency_risk_detected | blocked` (`ux:937-944`). Since
2026-08-31 the spec also records (a) the **derived** fifth display value `agent_working`
(`ux:947`) — never persisted, computed by `deriveDisplayReadiness`
(`app/shared/mapping/task.server.ts:498`), shown whenever `waiting: agent` while stored
readiness is `ready` or `input_required`; and (b) the **second state family** goal chains add
(`ux:949`): chain `active|paused|attention|completed|cancelled`, link
`pending|active|done|failed|skipped`, which never reach a readiness pill.

**Line-citation hazard.** `ux-design-specification.md` carries a standing warning at
`ux:35-43`: every pre-2026-08 `ux-design-specification.md:NNN` citation written into a code
comment is stale, because amendment blocks keep pushing the cited text down. Exactly three
such citations exist in the tree, and the note tabulates their real targets
(`nav.ts:48` → `ux:1052-1053`; `board-filters.ts:205` → `ux:1074-1075`;
`route-pending-bar.tsx:9` → `ux:1077-1078`). **All three were re-verified for this document
and still resolve.** Prefer a section name over a line number in any new citation. Separately,
`§4.6`/`§5.11`-style section numbers in code comments (`app/routes.ts:15`,
`org-settings-page.tsx:20`, `board-page.tsx:962`, `rich-text.tsx:6`, `mini-modal.tsx:9`) do
not address the UX spec at all — they belong to the deleted `docs/build/specs/*.md` set.

**Architecture, at product level** (`architecture.md`): file-system-authoritative with
projections; the load-bearing negative decision is **"the system should not gatekeep state
changes through an app-controlled write path"** (`architecture.md:46`) — four layers (file
corpus → interpretation → projection → diagnostics, `architecture.md:113-116`), and **"every
view should be re-derivable from current files plus current external facts"**
(`architecture.md:118`). Readiness is modelled **separate from workflow stage**
(`architecture.md:122`); branch health, assigned agent, review linkage, waiting target and
memory availability are secondary signals, never readiness values. **Tolerant parsing is a
product behavior**: malformed input produces diagnostics and a readiness downgrade — *silent
parse fallback is forbidden* (`architecture.md:588`). **SSE is the only realtime transport**,
carrying compact facts, with clients tolerating reconnects without duplicate side effects; the
shipped event set is `SSE_EVENT_NAMES` in `app/schemas/sse-event.schema.ts` — **fourteen
names**, enumerated and corrected at `architecture.md:535-539`, which also records that the
document's own canonical examples `task.readiness-changed` and `auth.session-expired`
**never shipped**. **No optimistic updates for authoritative task state**
(`decisions.md:87`). Invariants: **one app process per data root, ever**
(`state/writer.lock`, B-FD1/F18-5, `architecture.md:861-865`); mutating operations require
explicit idempotency protection before retry; secrets never in files, logs, SSE payloads or
error messages; `app/ui/` may not import `app/features/`, routes stay thin. Auth (revised
2026-07-25): **local email+password is a first-class shipped path**, OAuth optional and inert
without env vars, **no self-signup on any path**, sessions are server-side rows with an opaque
cookie token, and **GitHub OAuth is identity only — repo execution uses user-supplied
fine-grained PATs**. The `workspace/` clone and `.repo-mirror/` are **disposable working
state, never a communication channel and never read as truth**; SQLite is canonical
**per-table** (users, sessions, audit, notifications, sealed PATs, run history) and
non-canonical for task/project truth (`architecture.md:873`, restated at `:913`).

**The controller and chained goals now have an architectural home** (`architecture.md:917-942`,
added 2026-08-31 under ruling 99): one `kind: controller` profile per instance
(`CONTROLLER_PROFILE_ID`), template `agents/profiles/controller.md`, doctrine body
`agents/definitions/controller.md`, a compiled-in `FALLBACK_CONTROLLER_DEFINITION`; no
capability matrix; not deployable; Claude-only, enforced and disclosed. Two surfaces
(`/controller`, `/projects/:slug/controller`), one machinery. Authority is the asker's,
re-resolved per tool call under actor `{userId, label: "<email> · via controller"}`. No tool
merges, accepts, force-accepts, resolves a packet, or moves a task into terminal; **no tool
deletes anything**. Conversations are app-owned SQLite rows, one message = one
`agent_runs` row of `kind: "controller"`. Chained goals are canonical at
`projects/<slug>/goals/<goal-id>.md`, projected to `goal_projections`, back-referenced by each
task's `goalRef`, advanced lazily by the convergent `reconcileGoal` engine.
`architecture.md:965` records the same subsystem as a fifth entry in §Subsystem Mapping, and
`architecture.md:955` maps FR40/FR41 to their modules.

**Counts, recounted 2026-08-31 and re-verified 2026-09-01** (`architecture.md:800-810`,
`:1139-1144`): `app/routes/` holds **32** route modules and `app/routes.ts` declares **32**
entries; `app/features/` holds **18** surfaces; `app/server/` holds **25** directories. All
three re-measured for this document and correct.

---

## 2. Functional requirements, compressed

Legend: **[A]** = carries amendment notes you must read before acting on it.
**[A!]** = the head sentence is now *false* without its amendments (and the PRD now says so
inline, in brackets, at the head of each such FR).

### Workspace access & collaboration — `prd.md:203-210`

| FR | One-line intent |
|----|-----------------|
| FR1 | Team members sign in and reach shared workspaces. |
| FR2 | Admins manage membership and human roles; the system enforces project/task permissions from them. |
| FR3 | Users collaborate in a project with shared visibility into task state changes. |
| FR4 **[A]** | Comment on tasks, addressing agents or teammates in one unified timeline. *Amended 2026-07-04* (commenting is app-wide, non-member comments labeled). *Amended 2026-07-28, ruling 25 / R15-4*: projects are **members-only** — a non-member cannot open the board or tasks at all (routes behave as if the project does not exist; workflow secrecy WI-13 wins). "App-wide" now means *across the projects the user can see*. |
| FR37 **[A]** | One human **task owner** = that task's reviewer and acceptance authority; rights scoped to that task only; a task may be unowned. *Amended 2026-07-25* (the "partly implemented" note was itself stale; R14-2 widened it — the owner governs **any** open decision on their own task, each decision keeping its own inner capability gate). *Amended 2026-07-28, ruling 22 / R15-3*: the widening covers stage-transition recommendations — the Apply click **is** the authorization for that one move, and grants nothing elsewhere. |
| FR38 **[A]** | Contributor-or-above can take/release task ownership self-service; admins can release any owner; changes are typed timeline events + audit. *Amended 2026-08-21, pass 22*: read "Any member" → **contributor**. The code was right (ownership carries acceptance authority, which a viewer must not self-assign); **the requirement was corrected to match, not the code widened**. |

### Project governance & policy — `prd.md:212-218`

| FR | One-line intent |
|----|-----------------|
| FR5 **[A!]** | "Admin users can create and configure governed delivery projects." *Amended 2026-08-06, F19-29 under ruling 44*: **creation is self-serve for any signed-in user, not admin-gated**; the only guard is authentication and the creator is seeded project **admin**. Deliberate (neighbouring instance-maintenance actions do carry org-admin refusals); pinned by `workspace-routes.server.test.ts`. Nothing downstream is widened. |
| FR6 | Admins define workflow stages, allowed transitions, approval boundaries per project. |
| FR7 **[A]** | Admins define the project's GitHub repository. **One project, one repository.** *Amended 2026-07-25*: the "task-level overrides" clause was **struck** by owner ruling — it was half-built, enforced nothing, and the toggle + copy were deleted rather than the feature finished. |
| FR8 | Admins define separate human RBAC and agent capability policy per project. |
| FR9 **[A]** | Admins define reusable agent profiles (global base + project customization): eligible stages, permitted actions, permitted context resources (skills, MCPs, KBs), permitted web reach, execution backend. *Amended 2026-08-21*: **`use-browser` is a first-class capability** (default off, enforced on both backends by mounting/withholding a Viberr-owned Playwright MCP; output lands in the task's member-only `attachments/`; granting it **forces egress on** — rulings 75, 95). Shipped 2026-08-14 and undocumented in the PRD until pass 22. |

### Task records & lifecycle — `prd.md:220-229`

| FR | One-line intent |
|----|-----------------|
| FR10 | File-native store, inspectable outside the app; externally created/edited task files are recognized and reconciled. |
| FR11 **[A!]** | "Users can create tasks. **Agents cannot.**" *Struck 2026-07-25*: the "and authorized agents" clause (never implemented). *Amended 2026-08-30, ruling 99*: the bar is on agents **inventing** tasks and it stands — two human-rooted exceptions: the **controller** creating a task as the instrument of an authorized asking user (server enforces that user's own `create-task`), and **chained-goal advancement** (FR41) under the goal creator's re-proven live authority. |
| FR12 | Each task maintains a canonical operating record: identity, goal, state, execution context, timeline, decisions, execution references. |
| FR13 | Tasks move through project-defined stages under governed transition rules. |
| FR14 **[A!]** | "One primary specialist + consultant specialists." **Both amendments reverse the head sentence.** *2026-08-04 (pass 17, D9/Q17-5)*: the model is one uniform `engagements[]` list — **exactly one** `delivers: true` (the *delivering engagement*, sole owner of workspace/branch/PR = the single-writer invariant), all others *supporting*, read-only by default; a supporting engagement whose engage-time `verdictCapable` snapshot is true is a **required reviewer** acceptance waits for. *2026-08-29, ruling 98*: **static pre-assignment is retired** — `engagements[]` is written by the DISPATCH; the operator picks which deployed agent runs at each stage via ONE `run_agent` action (capability `dispatch-agents`), weighing `previousStageId`; humans dispatch through one selector+prompt control; an unengaged profile auto-engages (delivering iff no deliverer and it holds repo-write, supporting otherwise). Single-writer, verdict snapshot and required-reviewer gate unchanged. |
| FR15 | Agents flag low-quality/underspecified tasks and request clarification before execution. |
| FR16 | Typed important events sit alongside conversational updates in one chronology. |
| FR17 **[A]** | Record validation outcomes, evidence references, concise change summaries, compressed history. *Amended 2026-08-21, ruling 96*: **files an agent posts on the task thread** are evidence — any run granted `attach-evidence-references` may copy files into the task's canonical `attachments/`; images render inline as timeline thumbnails with an in-app lightbox, served member-only. Files humans must *see* go here; code and large artifacts still belong in the repo/PR. *(Not yet written into the PRD: ruling 105's completion-time prune of uncited machine-stamped browser working artifacts, and the universal in-app viewer/Download.)* |

### Agent orchestration & continuity — `prd.md:231-242`

| FR | One-line intent |
|----|-----------------|
| FR18 | One dedicated operator agent per active task. |
| FR19 | Execute approved agent profiles against tasks through Codex / Claude backends. |
| FR20 **[A]** | Operators recommend assignments, transitions and human decisions, and trigger/re-engage specialist work. *Amended 2026-08-04*: "consultant specialists" = supporting engagements (see FR14). |
| FR21 | Specialists execute stage work and append outcomes, blockers and evidence to the task record. |
| FR22 | Threads resume across stages; a reactivated agent continues from canonical task state even with no prior runtime history. |
| FR23 | Authorized users can reach an agent's native runtime session for deep debugging. |
| FR39 **[A!]** | *(added 2026-07-25)* Schedule a future run on a task that a server-side runner fires with no human present — the one capability letting an agent act unwatched, so it must stay visible, cancellable, auditable; only a run-agents role may create one; canonical in the task file; never fires on a terminal task. *Amended 2026-08-21, ruling 94*: the "carries the backend and autonomy chosen at schedule time" clause is **struck** — a schedule pins neither; the fired run resolves both from the **live deployed profile at fire time**, clamped by the autonomy ceiling. *Amended 2026-08-29, ruling 98*: generalized from "operator re-run" to `run-operator \| run-agent`; the separate schedule form is gone (each run control carries a when-picker); the agent arm pins **only profile identity**; a fire-time refusal no retry can cure retires the occurrence as a visible `failed` with its reason. |
| FR40 | *(added 2026-08-30, ruling 99)* ONE instance-level conversational **controller** — machinery like the operator, not a deployable specialist — addressable at `/controller` and `/projects/:slug/controller`, gated **per tool call on the asking user's own live permission**, evaluated separately for instance scope (org role) and board scope (project RBAC matrix). Never a privilege-escalation channel: same governed audited mutations humans use, refusals relayed out loud, nothing deletes, and the always-human decisions (merge, acceptance, force-accept, packet resolution, the move into terminal) have **no controller tool at all**. Only org admins modify the controller itself; conversations are owned by their user (readable by that user and org admins); each turn is a real recorded run. *(Not yet in the PRD: rulings 106–108 — the settings tab's editor parity, the unremovable `viberr_ops` diagnostics MCP, and the deployment lock that makes the grant lists and instructions read-only by default.)* |
| FR41 | *(added 2026-08-30, ruling 99)* **Chained goals**: one outcome decomposed into an ordered chain of tasks in a project, canonical at `projects/<slug>/goals/<id>.md`, tasks created **lazily** (link 1 at definition, each next on real completion of the previous), each a full ordinary task with its own operator. A failed link pauses the chain (`attention`) by default or is skipped under `onFailure: continue`; humans retry/skip/edit/add/pause/resume/cancel. Defining requires the user's own `create-task`; **advancement re-proves the creator's live authority at every step**. Goals are never deleted. |

### Oversight views & human governance — `prd.md:244-250`

| FR | One-line intent |
|----|-----------------|
| FR24 | Board organized by stage; cards show stage, assigned agent, waiting state (human vs agent), validation status. |
| FR25 | Task detail prioritizes current state, execution profile and latest decision packet **before** the timeline. |
| FR26 | Structured blocking/decision packets generated for human review when agent work needs intervention. |
| FR27 **[A!]** | Humans approve/reject/redirect consequential changes incl. advancement and completion; **transition to `done` is human by default, enforced server-side**. Four stacked amendments: *(a)* the single exception — a full-autonomy operator holding an explicit `completion-for-acceptance: direct` grant (never implied by raising autonomy, audited, UI-disclosed; still refuses failing validation). *(b) 2026-07-28, ruling 20 / R15-1*: acceptance is **verdict-gated** — a review PR whose head carries the delivered revision + a healthy reviewer verdict; audited **Force-accept** is the only bypass (never for a mismatched head); every acceptance passes a confirm dialog naming what merges and what is missing. *(c) 2026-08-04, ruling 40 / R16-6*: **"Done" has two meanings** — `merge-pull-request` is ALWAYS_HUMAN, so an operator acceptance records the PR `accepted` (**merge pending**) and reaches Done with the merge outstanding; only a *human* acceptance triggers the real async merge. *(d) 2026-08-06, rulings 43 + 55/62*: a third ending — **"Completed — no changes"** — a verifiably empty diff (or no branch) closes to Done with no PR and no merge, its own event and confirm dialog, re-verified against the live remote at close time. |
| FR28 | Review progress without raw provider logs or raw validation output. |

### GitHub delivery & traceability — `prd.md:252-257`

| FR | One-line intent |
|----|-----------------|
| FR29 | Authenticate to GitHub, access authorized repositories for task execution. |
| FR30 | Each task executes against its project's repository; one repo per project, no per-task override (see FR7). |
| FR31 **[A]** | Create/manage task-key branches; associate commits, changed files and review PRs with the originating task. *Amended 2026-07-28, ruling 21 / R15-2*: **delivery is an operator decision, not a stage side-effect** — the operator weighs remaining stages and delivers when the work is plausibly review-ready, opens a decision packet when unsure, may offer early delivery. The server executes the mechanics; a human can trigger delivery directly (audited); **specialists never push or open PRs**; reaching a review stage with no PR is announced with a typed event. |
| FR32 | Branch and PR status visible alongside task state. |

### Integrity, audit & recovery — `prd.md:259-264`

| FR | One-line intent |
|----|-----------------|
| FR33 **[A]** | Auditable history of human decisions, agent actions, workflow and policy events. *Bounded 2026-07-25*: audit rows are retained **90 days** then hard-deleted by a boot-time retention pass. **Amended 2026-08-31, ruling 102**: before deleting, the pass appends the expiring rows **verbatim** to a JSONL export under the data root (`audit-exports/audit-events-<YYYY-MM-DD>.jsonl`, `app/server/db/retention.server.ts:98-110`); an export failure **skips that pass's purge** (fail closed). Task-scoped history still also survives indefinitely in `task.md`; for org/auth-scoped events (sign-in outcomes, user administration, connection-token replacement, PAT changes) the export file is now their only record past 90 days. An on-demand admin download (`/org/settings/audit-export`, 100k-row cap) remains for in-window snapshots. |
| FR34 | Isolate secrets/credentials from task-visible artifacts, comments and audit records. |
| FR35 | Task quality issues and policy violations are first-class events. |
| FR36 | Manual project re-scan and state reconciliation on demand. |

### Non-functional requirements — `prd.md:266-301`

- **NFR1–NFR5 (Responsiveness, `prd.md:268-276`)** **[A!]** — section renamed from
  "Performance"; the four numeric targets (200-card board ≤2 s, task detail ≤2 s p95, action
  reflected ≤3 s p95, cross-user propagation ≤5 s) are **all struck** by ruling 63 / R19-9:
  never measured, no harness, nothing goes red. Replacements: **NFR1** the board hides nothing
  to save render time and names its unbounded-query scaling limit out loud; **NFR2** a task
  surfaces decision-relevant truth ahead of its depth; **NFR3** every state-changing action
  acknowledges itself (pending affordance, then new state or stated failure) — nothing
  completes or fails silently; **NFR4** shared task state reaches other connected users with no
  manual refresh (SSE + periodic reconciliation fallback); **NFR5** survives, re-cast
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
  they do. Consequence, deliberate: an agent with `execute-code-or-write-repo: off` can still
  reach a granted server's write tools. "Every governed action" = every action Viberr itself
  defines and gates. *(The Codex-advisory half that QUESTION 8 asked about was **resolved in
  the code, not the PRD**: ruling 101 restored the Codex read-only sandbox for write-withheld
  runs, so `execute-code-or-write-repo` is back in `ENFORCED_CAPABILITY_IDS`
  (`app/shared/capabilities.ts:223-264`) and binds on both backends. NFR8 still carries only
  the MCP amendment note.)*
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
  across those events, **not indefinitely**; retention is bounded per FR33, and since
  ruling 102 the purged rows land in the JSONL export rather than vanishing.

---

## 3. The 108 numbered rulings, digested

Format: **N** (id, date) — one-line ruling · *where it binds*. All are binding; several are
marked SUPERSEDED/NARROWED in place and are kept because their numbers are cited in code —
**never restore a superseded rule because you found its text.** The rulings live at
`docs/architecture/decisions.md:132-1638`; the line for each group header is given below.

**Foundational contracts (1–16)** — `decisions.md:134-217`. Mostly from the original
CONVENTIONS recovery.

1. Readiness is a canonical 4-value enum (`ready|input_required|inconsistency_risk_detected|blocked`) in files, Zod and SQLite; ONE mapping module to display pills; "Accepted" is derived, never stored. · `readiness-policy.server.ts`, every pill renderer.
2. **Roles: three separate systems, kept separate** — org `admin|member`; project roles (the strict tier `admin|maintainer|contributor|viewer`, one table `app/shared/rbac.ts` that guards *and* the Policy page renders from); agent capability policy `direct|recommend|human|off`, id-based against a shared catalog, with an always-human invariant list (merge PR, transition to Done, change project policy). *Superseded in part by 25* (members-only). · the whole RBAC + capability spine.
3. Task-file store at `$VIBERR_DATA_ROOT/projects/<slug>/tasks/<KEY>/task.md`; the UI renders the REAL store-relative path, never the mock's `.viberr/...`. · file store + every path display.
4. Timestamps are UTC ISO at all boundaries; ONE shared formatter reproducing the mock's display forms. · `app/shared/dates/`.
5. PAT scope violations are server-derived per-scope verdicts + per-violation open/resolved records; the rail badge is the open count; grant/re-validate writes a typed event to the violation's OWN task + audit + SSE. **No global boolean.** · GitHub/PAT surfaces.
6. Identity compares by **user id** everywhere; display names are render-only; the session user id is authoritative. · all authorization and attribution.
7. Packet options carry a stable **`kind`** — never dispatch on English titles. *(decisions.md:167-173 still enumerates **TEN**; `PACKET_OPTION_KINDS` in `app/schemas/task-file.schema.ts:129-165` now holds **ELEVEN** — `resolve_remote_collision` arrived in pass 31 (F31-6) and was recorded in `docs/architecture/file-formats.md:219,247` but never promoted here. See §6 F32-1.)* Agent policy is id-based against the shared catalog; advisory ids with no runtime consumer get no toggle. *Amended by 40.* · `PACKET_OPTION_KINDS`.
8. `tweaks-panel.jsx` is not ported (dev harness); review-queue packet + acceptance mechanics ship **before** the queue surface. · `app/features/review/`.
9. Notifications are per-user SQLite rows sorted by real timestamp DESC; task/project refs are soft refs. *Superseded in part*: the two stub projects are demo fixture only (`npm run seed:demo`); the product seed ships no board data. · notifications + seed.
10. "Waiting on you" / the review queue stay **project-wide** in V1; do not scope per-user, do not change labels. *Superseded for the board (R8-3)*: the board's "Waiting on me" chip and the home card's waiting count are **member-scoped**; the review queue itself stays project-wide. · board filters, home cards, review queue.
11. Run lifecycle is `queued|running|finished|error|interrupted` mapped to mock pills; **raw NDJSON/JSONL is truth**, the log line display is a projection; elapsed derives from `startedAt`; tokens come from real usage envelopes only, never estimates. · run service + runtime panels.
12. PR states map to pills (merged→done, open/draft→in review, closed-unmerged→risk "closed"); sync precedence merged > behind > synced, from real compare data. · GitHub view + task header.
13. Prefs: drop `ghConnected` (derive from the user row); mount Appearance; map plural pref ids ↔ singular notification kinds explicitly, once. *Narrowed*: no mailer in V1 → each category carries a single in-app `app` toggle. · prefs/profile.
14. **Shared single implementations**, never forked per surface: notification meta, the markdown-ish stripper + rich-text renderer, the credential card, the bell popover. Toast/empty-state/boundary copy in the specs is a **verbatim contract**, including intentionally divergent board vs review wording. · shared UI.
15. Stages are a per-project list in `project.md` (hex or `var(--*)` colors), created from an instance-default template. *Narrowed (owner ruling 2026-07-24)*: the "Lightweight · 3 stages" preset was **deleted** — the Standard 5-stage board is the only creation template; custom stage lists are edited per project after creation. · project creation + settings.
16. Deliberate keeps and additions: board rail count includes Done; `.card.urgent` stays visually untreated; `data-screen-label` kept app-wide; minimal list-view empty state; Escape-close + focus-trap + scrim-click on **every** dialog; `operator` stores the stage id and the UI renders "stage \<1-based index\>"; login keeps mock copy but the password minimum is 8. · board, dialogs, login.

**GitHub truth, scopes and the acceptance gate (17–25)** — `decisions.md:218-252`.

17. **PR divergence recovery** — out-of-band PR transitions are coordination events: the reconciler fires a `pr-diverged` operator trigger (closed/merged/reopened); a closed PR opens ONE recovery packet (rework · `archive_task` · `archive_task + deleteBranch`). The ruling's closing sentence, "**Remote-branch deletion exists only as that packet resolution**" (`decisions.md:222-223`), is now **stale in the narrow reading** — pass 31's `resolve_remote_collision` deletes a remote ref through a different packet (`task-actions.server.ts:6438-6445`). The broad reading (remote deletion is packet-only, human-confirmed, `approve-transition`-tiered) still holds. · reconciler + packet machinery.
18. Minimum GitHub scopes are **exactly `repo` + `pull_request:write`** (`workflow` and `read:org` dropped); fine-grained tokens prove write via empty-payload dry-run probes (422 = authorized, 403 = refused). · PAT validation.
19. **Scope chips render proven verdicts only** — a chip is evidence (scope header, live probe, open violation); `assumed`/`unchecked` render as an honest "unproven" line, never a pseudo-check. · GitHub page.
20. **R15-1: acceptance requires a verdict** — a healthy reviewer verdict on the delivered revision; the audited admin Force-accept is the only bypass and never bypasses PR-head containment; every accept, force included, shows a confirm dialog naming what merges and what is missing. · every acceptance writer.
21. **R15-2: delivery is an operator decision** — `deliver-review-pr` capability; the operator decides when delivery is plausible, packets when unsure, may offer early delivery; server executes; specialists never push/open PRs; entering the review-role stage with no PR writes a typed event; the human delivery button (maintainer+ / task owner) is the escape hatch. · `performDelivery`, operator toolkit.
22. **R15-3: owner authority covers recommendations** — a task's owner may apply or dismiss ANY operator recommendation on their own task, transitions included; the click is the authorization. · recommendation apply path.
23. **R15-5: global ⌘K palette** — real workspace-wide search (tasks, branches, agents, projects) scoped to visible projects. · `/resources/search`.
24. **R15-6: per-project delete-branch-on-merge** setting, default on — a successful accept-merge deletes the remote task branch. · project settings + merge path.
25. **R15-4: projects are members-only** — non-members cannot open a project's board, tasks or any project surface (404-style; WI-13 secrecy generalized). FR4's app-wide commenting applies within visible projects. · every project route guard.

**Doc discipline, honesty of surfaces (26–34)** — `decisions.md:253-312`.

26. **R15-7: ghost profiles are fully conservative** — a run whose profile can no longer be resolved gets nothing permissive: no delivery, no comments, no ask-human, no evidence. · run authority resolution.
27. **R15-8: `design/prd.md` is re-synced with canon** and both maintained; `planning/README.md`'s sync claim must stay true. *Re-affirmed 2026-08-05 after a second failure* — "maintained" now means **byte-identical**, pinned by `app/shared/docs/prd-sync.test.ts`; **the canon copy is the one to edit**, the design copy is a mirror. *(Re-verified 2026-09-01: `diff planning/planning-artifacts/prd.md design/prd.md` is empty.)* · docs.
28. **R15-9: an absent `deliver-review-pr` grant resolves from the project's own governance**, not a constant — the rule reads its effect off the workflow graph (`humanGatesPreWorkAdvance`: no pre-terminal boundary advances automatically ⇒ `recommend`); the gate and the policy surface share ONE function (`absentDeliverReviewPrMode`) so they cannot drift. An explicit grant always wins. · capability resolution + Policy page.
29. **R15-10: the first empty board teaches, once** — one teaching line in the entry column of a zero-task project; every other column bare; the moment any task exists, all columns are bare. · board empty state.
30. **R15-11: the Review queue stays a triage list, but rows name their action** — the row says "Review", deliberately not "Accept", because acceptance is verdict-gated and may refuse: **a control must not name an outcome its surface cannot promise.** · review queue.
31. **R15-12: unenforced capability lines are collapsed, never hidden** — rendered in a counted `<details>`; an omission the reader cannot see is worse than an awkward truth. · capability matrix.
32. **R15-13: settings headings name their own scope** — "Instance settings" and "\<name\> · settings"; every wayfinding string updated with them. · settings surfaces.
33. **R15-14: a resolved agent question goes back to the AGENT THAT ASKED**, by resuming its own session — the packet records `askedBy` (profile id, not label) and resolution routes through the same path an @mention reply takes (resume, re-apply confinement, re-anchor on `task.md`); the operator hand-off remains the fallback so no decision is swallowed. · packet resolution.
34. **R15-15: a task owns a PR only if that task opened it** — `openTaskPr` is the sole writer of the link; the reconciler keeps an owned link honest, never mints one; a PR found on the task's branch that the task does not reference is a branch **COLLISION**, reported as one (task keys restart at 1 on a new data root). · reconciler.

**Pass 16 — adoption, attention, honesty of refusals (35–41)** — `decisions.md:313-380`.

35. **R16-1: a pre-existing PR is adopted ONLY IF open AND its head sha IS the delivered revision** — identity, not containment; a task that delivered nothing adopts nothing; a name-matched failure is a reported collision that blocks delivery. **Refusal set corrected 2026-08-31** (`decisions.md:324-333`): the reasons are `merged | closed | no_revision | head_unknown | head_mismatch` — F17-L4 split `not_open` into `merged` and `closed` because they carry opposite delivery hazards (a merged stranger PR's tip is already an ancestor of base ⇒ only a stale branch NAME; a closed-unmerged one carries commits off base ⇒ a real non-fast-forward hazard). Extends 34. · `pr-adoption.server.ts`.
36. **R16-2: `input_required` joins the board's attention predicate**, and the chip is renamed **"Blocked or waiting"** so its label names what it selects. · `board-filters.ts`.
37. **R16-3: terminal GitHub facts outrank process gates in refusal copy** — a closed, unmerged PR is named FIRST; while the PR is closed admin **Force-accept is WITHDRAWN (hidden), not disabled**. Extends 20. · acceptance refusal chain.
38. **R16-4: correctness first with tests, then the full UI/a11y list — nothing deferred out of the pass**; the **disposition audit** (every backlog item re-derived from the tree after the fix waves) is what proves "done" is not "partial". · pass method.
39. **R16-5: MCP grants stay OUTSIDE the capability matrix — granting a server IS the grant.** A withheld `execute-code-or-write-repo` does NOT bound a granted server's tools. A deliberate honesty boundary, disclosed in the matrix UI and pinned by the **absence** of any `mcp__*` deny rule. · `specialist-tool-policy`, capability matrix.
40. **R16-6: merge stays human-only — "Done" has two meanings.** A full-autonomy operator acceptance records `pr.state: "accepted"` (**merge pending**) and moves to Done; a human completes the merge later. Only a human acceptance triggers the real async merge, and **the difference must be visible where the task lives** (board card *and* review queue), not only on the detail page. Corrects ruling 7. · `operator-actions.server.ts`, `capabilities.ts`.
41. **R16-7:** the stale `codex/gpt-5-6-sol-agents` branch was deleted (tip `461d34ab`). **Premise correction**: the pass-16 rationale that certain contributor/testing docs "no longer exist" was wrong — both exist. Record the deletion; discard the premise. · repo hygiene.

**Pass 17 — divergence disclosure, the third ending, doc law (42–46)** — `decisions.md:381-427`.

42. **R17-1: acceptance may accept a head AHEAD of the reviewed revision, but MUST surface the divergence** — the gate stays containment-based; the accept and force-accept dialogs show the ACTUAL merge head and "N commits added since review"; the audit names the real merge head. A head that has **diverged** (no longer contains the delivered commit) still refuses. · accept dialogs + audit.
43. **R17-2: a verified no-diff task is a first-class "Completed — no changes" outcome** — closes to Done with no PR and no merge, its own timeline event, operator-recommendable; force-accept and archive are no longer the only exits for a zero-diff task. *The "reviewer verdict optional" clause is SUPERSEDED by 62.* · `no-change-completion.server.ts`.
44. **R17-3: rulings live in `decisions.md`; a docs-canon re-read is a required closing step of every pass.** A ruling a code comment cites but no canon file records is a ruling that gets reversed. Every owner ruling a pass produces is promoted here, in this numbering, before the pass closes; re-reading `file-formats.md`/`deployment.md`/`runbook.md`/`testing.md` against the tree is itself a required closing phase, alongside the disposition audit. · **pass method — binds this pass.**
45. **R17-4: the local sign-in form leads when NO OAuth provider is configured** — disabled "not configured" provider buttons are not rendered; SSO shrinks to a one-line footnote. With ≥1 provider configured, SSO-first stands. · `login.tsx`.
46. **R17-5: "never synced" is neutral; only a genuinely stale cache warns** — `reconcile.at: null` reads "Not synced yet" (neutral); only `stale && at !== null` keeps the alert tone. Matches the MCP-health precedent. · `github-view.tsx`.

**Pass 18 — context governance, delivery aftermath (47–54)** — `decisions.md:428-509`.

47. **R18-1: a reviewer inherits the delivering engagement's KBs** — a non-delivering run's KB context is the UNION of its own grants and the deliverer's, deduped, tolerant of an undeployed deliverer, on fresh and resumed/@mention paths alike; deliverer and reviewer must judge against the same conventions. · `deliveringContextGrants`.
48. **R18-2: a full-autonomy delivery re-queues the operator** (`delivered` trigger) because delivery is not a transition and the every-transition re-trigger never fired after it; **SUPERVISED deliberately does NOT re-trigger** (the human is the driver, the "Opened PR" event is the cue). Only a newly opened PR fires it; the chain shares `OPERATOR_TRANSITION_CHAIN_CAP`. · `performDelivery`.
49. **R18-3: the SDK-native skill/command catalog is governed OUT of runs** — a run loads only Viberr's granted skills; the workspace clone's own `.claude` is stripped git-invisibly (`--skip-worktree`, so delivery never ships a `.claude` deletion); Claude launches with `strictMcpConfig: true`. Accepted limitation: a run whose task is to edit the repo's own `.claude` cannot deliver those edits — that is the posture, not a bug. · `stripUngovernedRepoCatalog`.
50. **R18-4: branch-collision stays a human-gated packet — do NOT auto-reset** the remote task branch. The rejected fix was force-resetting to base at execution start; the collision packet is an intentional safety checkpoint against clobbering unrelated remote history. *(Pass 31 gave that packet a first-class executable remedy, `resolve_remote_collision`, which stays human-confirmed at the `approve-transition` tier — the checkpoint is unchanged, only the option is now executable.)* · delivery pre-checks.
51. **R18-5: granted skills reach a Claude run through the SDK's NATIVE skills mechanism** (`skills: ["<granted>"]` discovered via `settingSources`, name+description at startup, body only on invoke), not injected prompt text; the allow-list is also what contains the SDK's compiled-in skills. **Codex keeps prompt-text injection** — an asymmetry that is disclosed, not silent. · `claude-runtime.server.ts`.
52. **R18-6: `design/prd.md` is re-synced to canon and pinned by a test** (`prd-sync.test.ts`, which names the diverging lines). See 27. · docs.
53. **R18-7: accepting from the BOARD asks first** — the drag into the final stage and the keyboard Move menu raise the same confirmation as the task page (ruling 20/FR27 promised the dialog at every acceptance path; three of five lacked it). The drag stays possible; only the silence goes. · `board-page.tsx`.
54. **R18-8: F18-9 closed as NOT REPRODUCIBLE** — both profile modals initialise with empty grants; acting on the note would have *introduced* the over-granting it warned about. **Recorded as a class: a finding taken from a UI impression and never re-verified in code can survive several passes as fact.** · pass method.

**Pass 19 — grounding, refusal, the honesty of numbers (55–72, plus 67/68 as R19-A/B)** — `decisions.md:510-841`.

55. **R19-1: the operator gets a FULL read-only clone of the project repo before it triages** — at triage its cwd held only `task.md` and the model invented scoping options from that emptiness. The clone is the SAME per-task checkout a specialist reuses; an existing checkout is returned untouched; read-only is a posture (no delivery capability), not a filesystem mode; a clone failure is a first-class `unavailable` arm carrying git's redacted complaint, never silence. · `operatorWorkspaceView`.
56. **R19-2: repo-documented conventions OUTRANK knowledge bases; the KB supplements.** Where a repo file states a convention (README, CONTRIBUTING, `docs/`, a linter config, the established pattern of the files being edited) the repo wins; a genuine conflict is followed **repo-first and reported by name** as a typed context-conflict event; an existing file family is never rewritten into a KB's style. Ships as ONE constant emitted immediately before the KB bodies, only when real KB text is present. · `KB_PRECEDENCE_NOTE`.
57. **R19-3: reviewer inheritance stays KBs only — 47 stands.** The docstring claiming a widening "to skills by LV-F3" described a widening that never shipped; the owner declined it. Skills are deliberately not inherited; the absence is pinned by a test. Same class as 54. · `specialist-run.server.ts`.
58. **R19-4: a SUPERVISED delivery must leave an actionable next step, and the SERVER guarantees it** — `ensureDeliveredNextStep` synthesizes a "Move to \<review\>" recommendation when an operator-authorized supervised delivery recorded none; conservative (adds nothing when a packet already is the next step, or past review, or no edge exists) and idempotent. · `operator-actions.server.ts`.
59. **R19-5: force-accept MAY skip the remaining stages AND the review gate — but it must SAY so.** A server 409 refusing an off-boundary force was **reverted**: force exists to unstick a wedged board, and a refusal turns the one escape hatch into another wall. The burden is honesty — the affordance is labeled and the dialog **enumerates the skipped stages**. What force does NOT bypass: ruling 37's terminal GitHub fact (now server-side) and ruling 20's head containment. · `forceIrreducibleRefusal`, `accept-confirm.tsx`.
60. **R19-6: a capability set to `off` is a HARD REFUSE by every route — no card, no audit row.** The gate is checked FIRST, before any read/card/audit row, on every path including the terminal-target reroute; `human` refuses the same way while naming the human reservation. **The operator refuses OUT LOUD** rather than silently finding another door. Extends 2 and 39. · `operator-actions.server.ts`.
61. **R19-7: the Activity audit column compacts consecutive runtime-session-open rows** into one expandable "N runtime sessions opened" row (nothing deleted; real per-row timestamps handed back on expand). **The recognizer is anchored at the END of the sentence and that anchoring is load-bearing** — `entry.text` opens with a user-settable display name, so an unanchored matcher let a member name themselves into folding their own `acceptance.forced` rows. · `activity-page.tsx`.
62. **R19-8: a "Completed — no changes required" task passes the SAME verdict gate as every other acceptance** — 43's "verdict optional" clause is superseded; a `workRevision` is minted against the real default-branch head so the verdict has a subject. "Nothing needed changing" is a CLAIM about the repository and is exactly the claim worth a second pair of eyes. **Counterpart honesty rule:** "verified" must mean the server actually looked — `defaultBranchEvidence.verified` is required on both doors (`no_branch`, `no_commits`). · `no-change-completion.server.ts`.
63. **R19-9: the numeric NFR1–NFR5 performance targets are DROPPED from canon — a target nobody measures is a claim, not a requirement.** The damage is the precision: an unenforced number teaches the reader the enforced ones might be decorative too. NFR5 is kept, re-cast behaviourally. **Standing rule: a latency budget lands in the SAME change as the harness that measures it, never before it.** Applies 44 to the non-functional half. · `prd.md` §Responsiveness; later applied to NFR14 and, in spirit, to ruling 103's browser matrix.
64. **R19-10: the two unshipped spec'd components get BUILT** — the **Continuity Recovery Panel** (D18, the named home of the Murat continuity journey) and **board arrow-key traversal** (D19). Both sit on the product's trust story, not its feature list; the UX spec's descriptions stand unchanged as the build target. · `continuity-recovery.tsx`, `board-page.tsx` roving tab stop.
65. **R19-11: a read-only Viewer does not see the project credential card** — the card is **withdrawn, not disabled** (37's precedent), the predicate is the SAME `ACTION_ROLES` entry the action guard uses (`grant-github-scope`), and **the loader redacts on that same rule** (a client-only gate leaves the token tail in the HTML). Also requires a full-page render at Viewer asserting absence, canaried by removing the gate: **an owner ruling whose guard cannot go red is a ruling that gets reverted in silence.** · `github-view.tsx`, `project.github.tsx`.
66. **R19-12: both accessibility gates get built** — a systematic both-theme WCAG AA contrast sweep, and a check enforcing the spec's "no control is hidden or disabled at any width" contract. Hiding a control below a breakpoint makes the surface **dishonest about what the user may do**; nothing may be gated on `matchMedia`. Both become suite-failing gates. · `app.css.test.ts`.
67. **R19-A: a run may never exceed the project's configured operator autonomy — the per-run level is a CEILING, not a pin.** A per-run dropdown that outranks project configuration makes the Policy page a lie. Choosing *less* autonomy stays allowed; the clamp is audited only **when it actually bites** (`task.operator.autonomy_clamped`). · `clampAutonomy`/`operatorAutonomyFor`.
68. **R19-B: a project member's GitHub approval on the PR counts as the approving verdict.** Closes the asymmetry where disapproval bound the gate but approval was inert. Four conditions make it evidence: bound to the delivered revision (`commit_id` == delivered head, re-checked on every read, so re-delivery invalidates it), approver must be a **project member** resolved via `users.github_handle`, it **fails closed** (unmappable, two claimants, non-member ⇒ does not count, reason recorded), and it is **never silent**. Composes with 20 and 62 — it cannot fire on a no-change verification revision. · `pr-human-approval.server.ts`.
69. **R19-13: git's own failure text is SURFACED to the human, redacted, where it used to be dropped whole.** The credential lives in the askpass env, so token-shape backstop redaction + control-character stripping makes the text safe; git's complaint reaches the run log, fenced timeline blocks, and a ≤240-char delivery reason. One redactor module, one choke point. *(The instruction to record this as "ruling 59" is VOID.)* · `git-output-redact.server.ts`.
70. **R19-14: new tasks are created at the ENTRY stage only** — `createTask` refuses any non-entry `stageId`; the board offers the per-lane button on the entry lane alone. A human could otherwise drop a new task straight into Review and skip the triage quality gate (FR15). File-level fixtures that seed mid-stage tasks are the test surface, not the human path. · `createTask`, `board-page.tsx`.
71. **R19-15: notifications are auto-read on VIEWING their target** — loading a task page marks all of that user's unread notifications for that task read; idempotent, monotonic, emits a converging `notification.read`, and runs only after authorization so the members-only 404 path stays pure. · `markTaskNotificationsSeen`.
72. **R19-16: OAuth sign-in is configured IN THE APP** — an org-settings **Sign-in & SSO** tab; saved credentials **override** the deployment env; enabling a method **requires a passing credential test**. Three honesty rules: saving never enables; changing either half clears the verdict and switches the method off; a passing test says what it proved (the pair) and what it did not (the callback registration). Secrets sealed; picked up per-request, no restart. · `oauth-providers.server.ts`, `sso-panel.tsx`.

**Pass 20 — the tool's own words, capability truth (73–84)** — `decisions.md:842-1026`.

73. **R19-17: a failed MCP command's OWN WORDS are surfaced — and kept.** stderr is captured (8KB cap), scrubbed through the shared `redactGitOutput`, appended to the probe verdict, **persisted** as `last_error`, and rendered under the row; a first-run install is distinguished from a hung command. · `resources.server.ts`.
74. **R19-18: first-run MCP installs FINISH IN THE BACKGROUND** — a visibly-installing command auto-warms (same handshake, bigger deadline), capped at 15 minutes, tracked by `warming_since` + an in-process registry, with a boot reaper for orphaned flags; the page re-checks until the row becomes a real verdict. · `mcp-warmup.server.ts`.
75. **R19-19: agents get a REAL BROWSER — as a first-class capability.** (a) `use-browser`, default **off**, enforced on BOTH backends by mounting/withholding a viberr-owned Playwright MCP per run; (b) injection stance: page content is **data, never instructions**, never enter credentials, the browser widens no authority; (c) chromium ships IN the app image; (d) output lands in the task's canonical `attachments/`, member-only, citable as evidence. *Amended 2026-08-21: (a) is reversed by 95 (browser now FORCES egress on) and (d) generalized by 96. Amended 2026-08-31: 105 prunes the machine-stamped working artifacts (d) used to leave in the panel. (b) and (c) stand.* · `capabilities.ts`, `specialist-browser-mcp.server.ts`, `Dockerfile`.
76. **R20-1: confirming a recovery option on a failure packet RESOLVES it and RE-QUEUES the operator** — no repeat confirms (a settled decision refuses the next), option labels state their real effect, a repeat failure opens a NEW packet, and a manual "Run operator" is **refused** while a packet is open (`refused: "open-packet"`) rather than burning a paid no-op. Extends 7 and 17. · `resolvePacket`.
77. **R20-2: `accept_completion` re-verifies the ACTUAL branch state** — empty or missing routes into the no-change path **with disclosure**, regardless of the agent's `noChanges` flag; and the `discard_branch` packet kind deletes a never-pushed **local** branch on confirm (`discardLocalTaskBranch` refuses an on-remote branch — remote deletion is packet-only). *(Its parenthetical "ruling 7's tenth" is now off by one: `resolve_remote_collision` made eleven.)* · `no-change-completion.server.ts`, `push-workspace.server.ts`.
78. **R20-3: the provider's OWN WORDS reach the packet and timeline (redacted), and model availability is validated against the account** — a redacted `providerText` from `classifyCodexFailure`/`classifyClaudeError` reaches the `err` line, packet observation, escalation and timeline; availability is marked from a REAL 400 and cleared on a real success (no synthetic probe — 19's proven-verdicts posture) in a `model_availability` table surfaced on the catalog and profile modal. Extends 69. · runtime adapters.
79. **R20-4: a first-ever probe of an npx/bunx-style stdio command that times out is treated as visibly-installing** — extends 74's warm-up to the npx family, armed at most once per command (`first_success_at`, `heuristic_warmups`) and rolled back if it fails. · `resources.server.ts`.
80. **R20-5 (scope): a pass fixes EVERY defect and every UX-coherence/drift item that is a defect or inconsistency — only pure never-built PRD features are HELD.** The held set: **D7** (Decision-Packet anatomy fields impact/confidence/severity), **D10/D11** (Continuity-Recovery-Panel escalated/paused states; the Execution-truth-strip runtime-continuity fact), **D12** (skeleton loaders). Each stays noted as a spec-vs-app gap, never silently dropped. Extends 38. · pass method — **these three are still the open spec-vs-app gaps.**
81. **R20-6: specialists act DIRECTLY or are WITHHELD — `recommend` is dropped for the specialist kind.** The silent `recommend`→`direct` widening is removed AND the seed is made honest: **file = enforcement = display.** The operator keeps its real `recommend`. · `capabilities.ts`, `agent-catalog.server.ts`.
82. **R20-7: the capability display MIRRORS the runtime gate** — the Agents card and Capability matrix bucket grants **autonomy-aware**, so an operator holding `completion-for-acceptance: direct` on a SUPERVISED project renders gated/conditional, not "Acts directly". Extends 67 and 2. · `capabilitiesToActionLabels`.
83. **R20-8:** the seeded Developer's default Codex model becomes `gpt-5.6-terra` (the model this account actually runs). Changes the default, not 78's honesty machinery. · `agent-catalog.server.ts`.
84. **R20-9: the operator MAY gather a delegated ask itself, and the packet must SAY it is standing in for the delivering agent.** Enforcement is **MECHANICAL, not advisory** — the packet-open path APPENDS the disclosure, so omission is impossible even when the model writes no body. The prompt clause survives as guidance layered over a guarantee. Sits beside the standing rule that the operator may not WITHDRAW an agent's ask (`operatorResolvePacket` refuses a packet carrying `askedBy`). · `operator-toolkit.server.ts`.

**Pass 21–22 — display law, ceremony as server invariant, sandbox reversal (85–97)** — `decisions.md:1027-1281`.

85. **R21-2: a capability-gap packet names the product's OWN remedy** — when the blocker is a withheld capability, the packet names it and says where a human grants it (the project's Agents surface), keeping that option beside the workarounds; the operator still changes no configuration itself (`change-project-policy` is always-human). Extends 75. · `operator-run.server.ts`.
86. **R21-3: the anti-slop lint plugin is ADOPTED — `npm run lint` becomes a required CI gate**, and "there is no linter, by decision" is retired (architecture.md's two sentences carry dated amendments pointing here). The 26 remaining findings are **fixed, not suppressed** — a red script whose redness is "accepted" somewhere unreadable is not a gate. **Standing lesson: a mechanical tree-wide rewrite carries the same review bar as behavior, because it changes behavior.** *(Pass 31 A1 restored the promise after it had gone soft: the gate is `error`-severity exit 0, warnings print but do not fail, and a worktree without `node_modules` silently "passes" — install `oxlint@1.79 @oxlint/plugins@1.79` with `--no-save` first, never during a `vitest run`.)* · `.oxlintrc.json`, `tools/oxlint/anti-slop/`, CI.
87. **R21-4: task workspaces clone through a per-project mirror cache, and the pre-run workspace phase is VISIBLE on the task page.** A 3+ minute clone with an empty timeline made a healthy run indistinguishable from a wedged one; `onPhase` — declared on the adapter interface and never once invoked — is actually driven, with a "preparing workspace" phase. Closes FR28's live-progress gap. · `repo-mirror.server.ts`, `runs-panels.tsx`.
88. **R21-5: an acceptance is valid only WITH the disclosure the human was shown — a bare POST is refused.** Ruling 20's ceremony held **client-architecturally only**; it is now a SERVER invariant: the acceptance carries an explicit acknowledgment echoing the displayed facts, and an echo that no longer matches the task's state is a refusal, not a silent write. Deliberately implementation-neutral. Scope is the **human** acceptance paths. Extends 20; puts 59's honesty burden behind a check. **This is the ruling the controller cannot impersonate, and therefore the reason acceptance/merge/force-accept/packet-resolution have no controller tool (99(c), 100(a)).** · `task-actions.server.ts`, `accept-confirm.tsx`.
89. **R21-6: the triage quality gate stays BEHAVIORAL — no mechanical transition block on open packets.** The owner declined hard-enforcing "no transition while an input-required packet is open": a human moving a task past an open packet is a deliberate act, not an accident to prevent. The New-task placeholder was reworded to promise only what exists. · `board-page.tsx`.
90. **R21-7: `FILES.md` is DELETED, not regenerated** — it claimed to be generated from git's index while trailing reality by ~1,000 files. A doc whose only job a command does better earns deletion over another unenforced regeneration. · docs.
91. **R21-8: while an agent actively carries a task, `input_required` YIELDS to "agent working" — on every surface.** The gate is `waiting === "agent"`; raising a packet flips `waiting` to `"human"` and the pill instantly reasserts. `blocked`/`inconsistency_risk_detected` **never** yield. *Completed 2026-08-27*: the yield now covers **`ready`** too and lives in ONE server-side derivation, `deriveDisplayReadiness` (`app/shared/mapping/task.server.ts:498`); surfaces render the derived `agent_working` value and no longer re-decide it. Stored readiness untouched. *(Recorded in the UX spec 2026-08-31, `ux:947` — closing QUESTION 15.)* · `app/shared/mapping/task.server.ts`.
92. **R21-9: the claude backend's display label is "Claude" (not "Claude Code"), and the operator run control SHOWS, it does not pick.** Per-run backend/autonomy dropdowns are gone (both live on the deployed profile; the run resolves the LIVE profile); the card states the backend, keeps Run, and adds an optional **steer** that rides the `@operator` mention machinery — recorded as the human's own timeline comment, because a directive that reaches an agent off the record is invisible to supervision. Full autonomy announces itself; supervised is the quiet default. *Partially superseded by 98(d): the human now picks WHICH agent and WHEN; backend and autonomy stay shown-not-picked (`ux:775`).* · run control.
93. **R22: the Codex OS process sandbox is REMOVED — "viberr itself is the sandbox."** **PARTIALLY SUPERSEDED by 101 (2026-08-31)**: the read-only sandbox is back for write-withheld runs. What survives of R22: the container plus the server-owned delivery gate are the real boundary; a write-GRANTED run is never confined for its role's name; Claude's tool-denylist and EGRESS enforcement on both backends are kept. · `codex-runtime.server.ts`, `capabilities.ts`.
94. **R22-schedule: a scheduled run resolves the LIVE deployed profile at fire time** — the form offers no pickers, the entry pins nothing, `runOperator` fills backend/autonomy from the deployed profile; no schedule-time clamp is needed because nothing is stored to clamp. FR39's pin is superseded. This is 92's "show, don't pick" applied to the unattended case. · `schedule.server.ts`.
95. **Browser implies egress (#176)** — granting `use-browser: direct` **forces** `use-web-search-fetch: direct` at every profile save path (`repairBrowserEgressGrants` via `applyGrantCouplings`; the editor pins the egress row). The browser IS network egress, so a browser-granted/egress-withheld profile expresses no policy at all — only a trap. Deliberately diverges from the respect-the-explicit-off posture; the runtime mount-refusal survives as the backstop for hand-edited files. Amends 75(a). · `capabilities.ts`.
96. **The attachments drop (#179)** — ANY run granted `attach-evidence-references` may POST FILES on the task thread; the persona section is emitted for any evidence-granted profile, browser or not, so browser screenshots become a special case of the general mechanic. The workspace contract's "never touch anything outside the working directory" now names the drop as its ONE exception, and on Codex the attachments dir joins the writable set. Extends 75(d); amended by 105 (uncited machine-stamped working artifacts are pruned at run completion). · `specialist-run.server.ts`.
97. **The live-backend display law (#183) — every surface displays the backend a run would ACTUALLY use.** Engagement rows snapshot the backend at engage time and heal only on the next run, so between a profile edit and that run the snapshot lies. The server query layer overlays the live deployed `profileId → backend` map (`withLiveAgentBackends`); an undeployed profile keeps its snapshot; stored records are not rewritten. **Layering:** the rule lives in the server layer (`deployment-view.server.ts`) and `features/agents` imports it back. Rulings 92 and 94 are this law's other two faces. · board, review, task detail, agents page.

**The two owner directives that define the current shape (98–99)** — `decisions.md:1282-1421`.

98. **Dynamic agent dispatch (2026-08-29) — the static delivering/reviewer slots are GONE.** Preprod, no backwards compatibility. **(a)** Engagements are run-created, not human-assigned (the ledger stays; the dispatch writes it; delivering iff no deliverer AND the profile holds repo-write; explicit `delivers: true` is a hand-off; the assign/engage menus, per-row Run buttons and legacy `specialist`/`reviewers`/`consultants` parsing are deleted; `release-agent` survives as the ledger's ✕). **(b)** ONE dispatch verb everywhere — `run_agent(profileId, prompt?, delivers?)` on both backends; `assign-primary-specialist`+`summon-reviewers` collapsed into **`dispatch-agents`**; four slot-shaped recommendation kinds collapsed into `run_agent`; the choice is an LLM decision fenced by stage eligibility, grants and the selection trace, now weighing the durable **`previousStageId`** fact. **(c)** The **dispatch-completion contract**: a dispatched run's final report always tags the dispatching human AND `@operator`, and its completion ALWAYS re-invokes the operator (mechanical in the pipeline, prompt clause as guidance — R20-9's shape); the @mention path carries the same contract and now **auto-engages** a mentioned deployed agent. **(d)** Scheduling is baked into the run controls (when-picker: now/5m/1h/6h/24h; pending entries list under their control). Extends 21, 67, 92, 94, 97; amends FR14 and FR39; supersedes FR14's static-slot reading. *(The UX spec's "reassign" vocabulary was retired in favour of **dispatch** on 2026-08-31, `ux:768-774` — closing QUESTION 14.)* · `operator-actions.server.ts`, `specialist-run.server.ts`, `schedule.server.ts`, `execution-profile.tsx`.
99. **The CONTROLLER (2026-08-30) — one instance-level conversational agent, machinery like the operator but above it, whose every action runs under the ASKING USER's own authority — plus chained goals as a first-class product concept.** Preprod, no backwards compatibility. **(a) Identity**: a third profile kind `kind: controller`, exactly one per instance, with its own doctrine, skill (`controller-guide`), KB (`kb/controller-handbook`) and org-registry MCP grants, shipped by boot backfill; **not deployable** to projects; only org admins modify it (org-settings Controller tab); it carries **NO capability matrix** because its runtime authority is the asker's. **(b) Authority**: every signed-in user converses; every TOOL CALL resolves the asker's **live** authority — org role for instance tools (users/KBs/skills/MCPs/global templates/audit/analytics = org admin; **project creation = any signed-in user**, FR5 parity), the project-role matrix for board tools using the SAME `assertProjectAction`/`requireAction` guards humans use (so the org-admin override, denial audit rows and members-only 404 posture apply identically — a probe cannot learn a project exists). Authority actor is `{userId: asker, label: "<email> · via controller"}`: guards bind to the human, audit discloses the instrument. Refusals are **out loud** (`[denied] <the guard's own sentence>`; instance-scope denials write `controller.authority.denied`). **(c) Always-human stays human**: **no tool** for merge, acceptance, force-accept, packet resolution, or a move into terminal — the move tool refuses a Done target, because ruling 88's disclosure ceremony is the load-bearing thing chat cannot impersonate. Policy edits ARE offered (gated on the asker's `edit-policy`) because ALWAYS_HUMAN `change-project-policy` bounds *agent-initiated* change and the controller never initiates. **No tool deletes anything.** Secrets never travel through chat (one bounded exception: a just-minted single-use temp password). **(d) Conversations**: app-owned SQLite, owned by the asking user, readable by that user and org admins; each user message is one real run (`agent_runs.kind = 'controller'`) inheriting NDJSON, redaction, token accounting, run-log console and boot orphan finalization; turns resume the provider session with a recent-exchange digest as the re-anchor (there is no `task.md`); single-flight per conversation with a FIFO. **CLAUDE-ONLY, enforced and disclosed** — same security decision as `read-github-api`: the toolkit is in-process, so DB handles and sealed credentials never cross a process boundary. **(e) Chained goals**: canonical `projects/<slug>/goals/<goal-id>.md` (status `active|paused|attention|completed|cancelled`, `onFailure: pause|continue`, `links[]`, `createdBy`), projected to `goal_projections` with link statuses **reconciled against live task rows**, back-referenced by each task's `goalRef`; **lazy** creation by the convergent `reconcileGoal` engine (hooked into transition/acceptance/archive writes plus a one-minute runner), under the creator's **re-proven** live `create-task` — lost authority parks the chain in `attention` instead of escalating (FR39's precedent). Failure pauses or skips per `onFailure`; humans redirect via chat or the Goals panel (gate: the creator, or `run-agents`); nothing deletes a goal. Every link's task gets its own operator — **the controller sits above operators and never duplicates them**. **(f)** FR11 amended. *(Retrofitted into the UX spec at `ux:633-731` and architecture.md at `:917-942` on 2026-08-31 — closing QUESTION 13.)* · `app/server/controller/*`, `goal-actions.server.ts`, `app/features/controller/*`.

**Pass 31 owner decisions and the controller hardening series (100–108)** — `decisions.md:1423-1638`. **New since the pass-31 edition of this document.**

100. **(owner, 2026-08-31; `decisions.md:1423-1431`) Ruling 99's two review-flagged asymmetries are INTENDED.** (a) The controller applies policy/workflow edits with **no confirm ceremony** while most governed actions have one — it is an admin-tier instrument executing an explicit human directive, so **"has a ceremony" stays the practical always-human test**, accepted rather than drift. (b) **Org admins read project-scoped controller transcripts for projects they are not members of** — a deliberate step outside R15-4's members-only posture, because the transcript belongs to the ASKING user's scope and org admins administer the instrument. Both were pass-31 discovery questions (E1), confirmed as designed. · **Answers QUESTION 2 and QUESTION 3 of the pass-31 list.** · controller toolkit + conversation ACL.
101. **(owner, 2026-08-31; `decisions.md:1433-1455`) Repo-write parity — partially supersedes R22 (ruling 93): write posture is GRANTS-derived and binds the SAME on both backends.** (a) A run whose effective `execute-code-or-write-repo` is withheld cannot write on **either** leg — Claude via the tool denylist, Codex via the read-only sandbox restored to `resolveCodexSandboxMode`; the capability moved back into `ENFORCED_CAPABILITY_IDS` (`app/shared/capabilities.ts:227`). (b) What R22 got right survives: a write-GRANTED run is never confined for its role's *name* — a supporting agent granted the family may edit its own isolated checkout (P8 isolation + sha-bound verdicts contain it), so Claude's kind-based supporting denylist narrowed to the **delivery trio** (`git push`, `gh pr create`, `gh pr merge`). (c) One disclosed carve-out: a write-withheld **evidence-granted Codex** run keeps `workspace-write` — the sandbox cannot express "read-only except attachments/". (d) The operator is coordination machinery: read-only on Codex again. (e) Scoped delivery commands stay claude-only at the tool layer; on Codex the boundary is credential-less agents + the server-owned delivery gate. **Shipped without live Codex validation** (provider quota blocked until 2026-09-18) — envelope/unit tests pin the contract. · **Answers the Codex half of QUESTION 8, in code.** · `codex-runtime.server.ts`, `claude-runtime.server.ts`, `capabilities.ts`.
102. **(owner, 2026-08-31; `decisions.md:1457-1462`) FR33's audit purge EXPORTS before it deletes.** The 90-day hard-delete first appends the expiring rows **verbatim** to `<dataRoot>/audit-exports/audit-events-<YYYY-MM-DD>.jsonl`; an export failure **skips that pass's purge** (fail closed — losing a purge tick is recoverable, losing the rows is not). Gives FR33's purge a durable long-term record beyond whatever the S3 schedule captures. · **Answers QUESTION 9's "is 90 days acceptable" half** (the retention *number* still has no separate ruling; the export does). · `app/server/db/retention.server.ts:37,98-110`.
103. **(owner, 2026-08-31; `decisions.md:1464-1467`) The declared browser matrix is Chromium-only.** Safari and Firefox were declared intent no pass ever exercised (recorded 2026-08-19); **struck from the PRD** (canon + mirror, `prd.md:160`) rather than left implied. Re-adding an engine requires a Playwright project that actually runs it. · **Answers QUESTION 7.** · `prd.md`, `design/prd.md`, `docs/testing.md`, `docs/testing-quickstart.md`.
104. **(owner, 2026-08-31; `decisions.md:1469-1488`) Operator narration is stored VERBATIM; the write-time length cap is gone.** The `operator-brevity` guardrail hard-truncated operator comments in the canonical record at 1000 chars, so an acceptance caveat's tail existed only in the agent logs while agent replies of any length survived behind the timeline's Show-more clamp. The record now keeps the full narration, `CollapsibleComment` clamps it view-side exactly like a long agent reply, and brevity survives as a **style instruction** on the operator's `post_comment` tool. The guardrail row is **deleted from `DEFAULT_GUARDRAILS`** (`app/shared/workflow/templates.ts:93-98` — four rows now: meaningful-comment, no-duplicate-summary, compression-threshold, evidence-separation); stale rows in existing `project.md` files are inert and tolerated. Accepted interaction: without the cap, two long near-identical narrations no longer collapse to an identical trimmed prefix — the durable `heldAtStage` one-nudge hold is the loop guard. Two survivors of the removal are locked: the **@mention fan-out scans the PRE-trim text** on the operator and agent-reply paths, and the ambiguity-disclosure append **balances an unclosed ``` fence**. The verbatim guarantee is locked at the **write path** (`writeOperatorComment`), not just the pure helper. · `comment-guardrails.server.ts`, `operator-actions.server.ts`, `prd.md:154,188`.
105. **(owner, 2026-08-31; `decisions.md:1490-1517`) Browser working artifacts are not deliverables; text attachments get an in-app viewer.** The browser MCP's `--output-dir` IS the task attachments store, so machine-stamped working files (`page-*.yml` aria snapshots, `console-*.log` dumps) were posted to humans next to the screenshots and drowned the panel (VIB-1: ~20 artifacts around 2 deliberate captures). **At run completion** the machine-stamped non-visual artifacts *that run produced* are DELETED unless the exact filename is cited in the final reply, the evidence rows, or the timeline since run start; screenshots, PDFs and deliberately named files always stay; the persona discloses the cleanup. Scoping survivors from the review round: FINISHED runs only; no prune while a sibling run is live on the task; the window does not ride the display LIST_CAP; the stamp regex classifies by the machine timestamp itself, not a prefix allowlist; ENOENT counts as pruned. Posted text files (txt/log/md/json/yml/yaml/csv) open in the same in-app popup as images — read-only monospace, 200k display cap, `?download=1` forces the save dialog. Pre-existing artifacts in old tasks are left in place. **Addendum (same day): the Download button is UNIVERSAL** — every attachment kind opens the card and carries Download; images show the picture, text files the reader, anything else a "no in-app preview" note (honest phrasing, because the route serves PDFs inline). The lightbox factory intercepts every plain click; modified clicks and provider-less renders fall through to the real anchor; the markdown renderer intercepts only clean single-segment names under the attachments base. The no-preview card **probes once**, and a body whose fetch PROVED the file unservable (404 after the prune, 413 over the 50 MB cap, auth redirect) reports the failure and **drops Download** — some browsers save a failed download's error body under the real filename. · `task-attachments.server.ts:108,165,188`, `attachment-lightbox.tsx`, `task-actions.server.ts`, `app/ui/markdown.tsx`.
106. **(owner, 2026-09-01; `decisions.md:1519-1550`) Controller settings speak the agent-editor language, and stay admin-only.** The org-settings Controller tab had grown its own dialect — a free-text model field (any typo silently ran the default via `resolveRunModel`), checkbox `<ul>` grant lists, **no effort control at all** (the run honored `config.effort` but nothing in the app could set it), bespoke `ctladm-*` styling. It now uses the profile modal's own `ModelEffortFields` + the extracted `useModelCatalog` hook (one mechanism, both editors), backend fixed to Claude because that is what controller runs resolve. A stored model seeds to the catalog default **only when a run would itself substitute it** — a dated `claude-*` id or family alias the served catalog does not list runs verbatim (`isKnownModel`'s static half, shared as `~/shared/model-ids`), so the picker preserves it instead of silently repinning on the next save (review finding D1, which also fixed the same latent rewrite in the profile modal). Grants are pick-chip toggles: KBs displayed by name and stored by dir with `kbDirsOf`'s display-name repair (P13-KM-01); a grant the store lost renders through the shared `MissingChips` — a **removable red chip** rather than an unremovable "not in the store" row (P14-KM-10). `effort` parses **tolerantly** (a hand-edited non-string reads as absent, never failing the whole profile — D2, which otherwise bricked the config as "profile missing from the store" with no in-app repair) and became a schema-level agent-profile frontmatter key persisted by `controller-save`, blank removing it. Access re-verified admin-only end to end: `/org/settings` loader and action `requireRole(admin)`, members 403, every nav entry admin-gated. One deliberate consequence: opening the panel now shows the default model/effort where the stored value was blank, so the first save makes them explicit. · `controller-admin-panel.tsx`, `controller-profile.server.ts`, `agent-profile-file.server.ts`, `app/shared/model-ids.ts`.
107. **(owner, 2026-09-01; `decisions.md:1552-1604`) The controller has a built-in diagnostics MCP, and no one can take it away.** The `viberr_controller` toolkit reads and changes the PRODUCT and had zero reach into the ops layer already sitting behind routes, so "why did that run fail" could only be guessed at. **`viberr_ops`** is an in-process, **READ-ONLY** server with three tools, each resolving the ASKING PERSON's authority live, per call, refusing in the toolkit's own voice: **`instance_health`** (the *reading* is open to anyone — it is what `/resources/health` serves unauthenticated (`app/routes/resources.health.ts:8`), plus per-backend availability and the cap/live/queued concurrency snapshot, three load integers carrying no name or project; the **credential DETAIL is org-admin only**, because it names the deployment's config directory), **`read_run_log`** (a member of the run's project; a controller turn's log follows conversation ownership with org-admin supervision via `canReadControllerRunLog` — the exact gate `/resources/run-log` applies, and a missing run, a forbidden project and a forbidden conversation all answer **one** not-visible sentence so a probe cannot walk run ids), and **`read_store_doc`** (org admins only, like the store browser it comes from, reporting `truncated` honestly). **Nothing writes, deletes or starts anything** — diagnostics that could change the instance would be a second authority surface beside the toolkit, which is where changes are audited. **Every page is bounded and says where it sits**: `read_run_log` defaults to the NEWEST 200 lines (500 max) on **both** directions (`controller-ops-mcp.server.ts:98-99`), refuses `since` together with `before`, and reports `page.{firstSeq,lastSeq,olderExist,newerExist,next}` computed against the run's real bounds plus `run.logLines` — never `getRunLog`'s `headSeq`/`oldestSeq`/`hasMore`, which are page-local cursors for a stateful console that a model with no second source reads as facts about the run (the measured cost of the unbounded default was a **2.5 MB reply on a 1,500-line run**). **NOT REMOVABLE BY CONSTRUCTION, not by a guard**: `buildControllerMounts` attaches it every turn with no config read and no grant row. The reserved names live in ONE list (`app/shared/mcp-reserved.ts`) read by the writer, the picker AND the run-time resolver — the resolver's private copy never learned `viberr_controller` or `viberr_ops`, so a row reaching the registry any way but `saveMcpServer` resolved and, because org servers mount LAST, **replaced the built-in server under its own key**. The settings MCP group discloses it as a **pinned chip that is deliberately not a control**, never entering the save payload. Scope is CONTROLLER-ONLY. The health body assembly moved to `~/server/ops/health-snapshot.server` and the refusal machinery to `~/server/controller/controller-tool-guards.server`, so route and tool read one derivation and both in-process servers refuse in one voice. · `controller-ops-mcp.server.ts`, `controller-run.server.ts`, `resources.server.ts`, `specialist-mcp.server.ts`.
108. **(owner, 2026-09-01; `decisions.md:1606-1638`) The controller's configuration is deployment-locked by default.** Which skills, knowledge bases and org MCP servers the controller loads, **and its instructions**, are locked out of in-app editing for **everyone, org admins included**: they are a deployment decision. Four environment variables unlock one section each at deploy time — `VIBERR_UNLOCK_CONTROLLER_SKILLS` / `_KB` / `_MCPS` / `_INSTRUCTIONS`, set to **`enabled`**; `disabled`, any other value, or unset keeps it locked (a typo fails **closed**); restart to apply; documented in `.env.example:187-190`, `compose.yml:52-55` (all four defaulted `disabled`) and the env schema (`env.server.ts:173-176`). **There is no in-app override anywhere — that is the point.** Enforcement is server-side in `saveControllerConfig`: `controllerSectionLocks()` reads the env (`controller-profile.server.ts:84-98`), and a **change** to a locked section is refused naming the section and its unlock variable (`:228`), while an **identical round-trip passes**, so model and effort stay editable — those two are deliberately *not* sections, because picking the tier is day-to-day admin work while rewriting what the controller IS operates above the org. The panel renders locked sections read-only (span chips, read-only doctrine, one note listing the locked sections and their variables) and **posts BLANK for a locked section**, which the server reads as "keep the stored value" — so a stale page copy can never be posted back as a change, and a locked section writes the STORED list verbatim (byte-stable by construction). Under a lock the P13-KM-01 display-name repair is skipped. A dangling grant is still **disclosed, just not removable**. The `viberr_ops` mount is unaffected: not a section, non-removable under every flag combination (ruling 107). **Scope (owner, narrow reading):** the lock covers the controller **settings tab** — the grant lists and the doctrine file edited there. It is deliberately **not airtight**: deleting or renaming a resource on the Agent resources tab still prunes the controller's grant (the shared `resource-references` rewrite), and editing a granted skill's or KB's file contents still changes what the controller loads as trusted context. Those side doors were left open by owner decision, in favour of not freezing org-resource management around whatever the controller happens to grant; the panel note and the ruling state the boundary rather than imply a containment the ruling does not provide. · `controller-profile.server.ts`, `controller-admin-panel.tsx`, `org.settings.tsx`, `env.server.ts`.

**Not law:** the 2026-08-21 UI-preference notes (`decisions.md:1416-1421`; #180 packet takes the
questionnaire's density; #182 the packet reads as one quiet column; #186 an owned task's owner
cell is just the owner) are **presentation preferences, styling-only** — recorded so a later
pass does not read them as drift. No capability, gate or copy contract changed.

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
| **Browser matrix** | *(Superseded 2026-08-31.)* The 2026-08-19 entry recorded declared support (Chromium/Safari/Firefox) against verified reality (chromium only) and left the matrix reading as support *intent*. The owner then **struck Safari and Firefox outright** — the PRD now declares **Chromium-based browsers only** (`prd.md:160`), with the history kept in-line and re-adding an engine gated on a Playwright project that actually runs it. | 2026-08-19, then **ruling 103**, 2026-08-31 |
| **Responsive** | The planned "review-first mode below 768px" was **never built**; the intent is **retired** rather than left as an instruction to build it. Narrow viewports get the *same surface, reflowed* — every action, including destructive and governance actions, stays available. | 2026-07-25 |
| **FR33** | "There is no export path in V1" → **export-before-purge**: the boot retention pass appends expiring rows verbatim to `audit-exports/*.jsonl` and skips its own purge if the export fails. The Phase-2 "audit export" line is partly discharged. | **ruling 102**, 2026-08-31 |
| **Anti-noise guardrail list** (`prd.md:188`) | `operator brevity` **removed from the shipped set** — the write-time cap truncated the canonical record. Replaced by a style contract on the tool plus view-side collapse. The risk paragraph at `prd.md:154` was updated in the same change so the mitigation named there matches the mechanism that exists. | **ruling 104**, 2026-08-31 |
| **FR head sentences** | FR5, FR11, FR14, FR27 and FR39 gained an inline bracketed **`[Amended — the head sentence below predates … read the amendment notes first.]`** marker. The bodies were **not** rewritten; the reader is warned in place. | 2026-08-31, pass 31 (doc-drift batch, commit `1b362434`) |

### Features deleted rather than finished

| Where | Change |
|---|---|
| **FR7** | Task-level repo override: half-built (nothing wrote a task-level repo; the admin toggle enforced nothing; a task pointing at another repo would authenticate with the project's credential anyway). **The toggle and its copy were deleted** rather than the feature completed. (2026-07-25) |
| **FR11** | "and authorized agents" — never implemented on any layer; struck. (2026-07-25) |
| **Ruling 15** | The "Lightweight · 3 stages" creation preset was **deleted**. (2026-07-24) |
| **Ruling 41** | The stale `codex/gpt-5-6-sol-agents` branch deleted (tip `461d34ab`). |
| **Ruling 90** | `FILES.md` **deleted, not regenerated** — it claimed to be generated from git's index while trailing by ~1,000 files. |
| **Ruling 13** | Email/nudge preference shapes **removed** rather than kept schema-only (no mailer in V1). |
| **Ruling 104** | The `operator-brevity` guardrail row **deleted from `DEFAULT_GUARDRAILS`** rather than kept as a decorative row — "a row with no enforcement would be decorative, the ruling-Q3 failure mode." Stale rows in existing `project.md` files are inert and tolerated. (2026-08-31) |
| **Ruling 105** | Machine-stamped browser working artifacts are **deleted at run completion** rather than paginated or filtered in the panel — the fix is at the producer, not the display. (2026-08-31) |

### Corrections *inside* `decisions.md` itself

| Where | Change |
|---|---|
| §Data & naming | The example table list said `sessions` — **a table that does not exist**; better-auth owns four SINGULAR camelCase tables (`user`, `session`, `account`, `verification`). The invented name had already propagated into `docs/operations/runbook.md`. (2026-08-06, F19-17) |
| §UI porting rules | "Keep `viberr.css` classes and CSS variables **exactly**" clarified (N19-4): "exactly" bound class **names** and the flat unprefixed convention — **not the mock's VALUES**. Deliberately diverged: `--radius-card` 16px / `--radius-panel` 22px vs the mock's 18/28; display face is **Manrope, not Roobert PRO**; `--pink`/`--dark-red`/`--radius-large` exist in `design/*.html` and nowhere in the app. **`app/app.css`'s `:root` is the ONLY token source.** (2026-08-06) |
| Ruling 7 | Packet kind count corrected nine→ten against `PACKET_OPTION_KINDS`, the source of truth (`archive_task` had arrived unrecorded; `discard_branch` added 2026-08-15). **This correction has now itself gone stale — see §6 F32-1.** |
| Ruling 35 | Refusal set corrected 2026-08-31: `not_open` had already been split into **`merged`** and **`closed`** by F17-L4 (pass 17) because they carry opposite delivery hazards; corrected against `PrAdoptionRefusal`, which is the source of truth. |
| Ruling 41 | **Premise correction**: the pass-16 rationale that contributor/testing docs "no longer exist" was wrong — both exist. The deletion stands; the premise is discarded. |
| Ruling 47 | Function names corrected (`deliveringKbGrants`→`deliveringContextGrants`). (2026-08-06) |
| Ruling 54 | F18-9 closed **NOT REPRODUCIBLE** — acting on the note would have introduced the over-granting it warned about. |
| Ruling 57 | A docstring claiming inheritance had been "widened to skills by LV-F3" described a widening that **never shipped**; the string existed nowhere else in the repo. Corrected, and the absence pinned by a test. |
| Ruling 69 | A spec instruction to record it as "ruling 59" is **VOID** (59 is taken by R19-5). |
| Ruling 84 | `R20-9` was cited by name in a shipped prompt and its test while no canon file recorded it — ruling 44's failure mode reproducing one pass later; promoted 2026-08-19. **`R21-1` is deliberately NOT promoted**: an operational step during a pass is not a rule that binds the product, and "canon that absorbs run-log entries stops being readable as law." |
| Ruling 86 | `architecture.md` said **twice** that there is no linter *by decision* while oxlint had already been installed and 387 files rewritten; both sentences plus the CI/CD note carry dated amendments pointing here. |
| Ruling 88 | Citation corrected 2026-08-19: it had read "rulings 40, 77, 82"; **82 is a neighbouring guarantee, not a disclosure carried with an acceptance.** |
| Ruling 55 | History note: a cheaper read-only view was **weighed and declined** — recorded so nobody re-proposes it. |
| Ruling 59 | A pass-19 implementer's server-409 refusing an off-boundary force-accept was **reverted by the owner** — the fix was built on a false premise. |
| Ruling 75 | Amended 2026-08-21 ((a) egress polarity reversed by 95; (d) output generalized by 96) and again 2026-08-31 (105 prunes what (d) produced). |
| Ruling 93 (R22) | **Partially superseded by ruling 101**: the Codex read-only sandbox is restored for write-withheld runs, so `execute-code-or-write-repo` binds on both backends again. R22's core — a write-GRANTED run is never confined for its role's name — survives. |
| Ruling 43 | Its "reviewer verdict optional" clause **superseded** by 62. |
| Rulings 2, 9, 10 | Marked **superseded in part** (members-only; demo-only seed projects; member-scoped board waiting). |
| Route map | Corrected 2026-08-06 against `app/routes.ts`: `/projects`, `/notifications/read`, `/prefs/theme`, `/resources/search` shipped but were never listed. **The correction has itself gone stale — see §6 F32-2.** |

### Corrections in the UX design specification

| Where | Change |
|---|---|
| Head-of-file line-citation note (`ux:35-43`, 2026-08-31) | Every pre-2026-08 `ux-design-specification.md:NNN` citation in code is stale; the note tabulates the three that exist and their real targets, **located by text and re-verified**, "not derived by adding an offset — the arithmetic version of this table was itself two lines out." Prefer section names in new citations. Also records that `§4.6`/`§5.11` comment references belong to the deleted `docs/build/specs/*` set. |
| §Implementation Approach (N19-4, 2026-08-06) | `app/app.css`'s `:root` is the **ONLY** token source and has drifted from the mock in both directions. **"No spacing scale and no elevation scale" is itself now superseded** (`ux:268-274`, 2026-08-31): design pass 30 built a **nine-step spacing scale** (`0 · .125 · .25 · .375 · .5 · .75 · 1 · 1.5 · 2` rem, ~760 values snapped onto it) and a **five-token elevation scale** (`--shadow-ring/card/menu/pop/lift`), and the type scale is **13 steps** — all locked in `app/app.css.test.ts`. Recorded with the lesson it repeats: *a superseding note that has itself gone stale is worse than the advisory text it supersedes.* |
| §Color System (superseded + N19-4) | "The concrete palette above is **advisory and the build did not take it**." Shipped direction is a bright Miro-inspired canvas: **`#5b76fe` blue, not steel blue**, pastel semantic surfaces, a violet agent tint distinct from human blue. `design/design-system.html` is "a reference MOCK, not the token source — and it has itself drifted". **"Where they disagree the app is right and the doc is what gets corrected."** **Radius amended 2026-08-31** (`ux:389-400`): the vocabulary is **six**, not four — `--radius-small 6px`, `--radius-button 8px`, `--radius-box 12px`, `--radius-chip 999px`, `--radius-card 16px`, `--radius-panel 22px`; only the count sentence had gone stale. |
| §Typography (superseded; corrected N19-2, 2026-08-06) | Shipped: **Manrope** display, **Noto Sans** body, **JetBrains Mono** technical, self-hosted. The note previously named **Roobert PRO**, "not web-available and never shipped anywhere in the product". |
| §Spacing & Layout (superseded, then amended 2026-08-31 at `ux:437-444`) | "No spacing scale" is now **false** — the retrofit the note advised against happened and was worth doing. "No spacing **tokens**" is still true (the scale is a convention the sheet keeps, not a `--space-*` family). "No 12-column grid" is still true — zero `repeat(12, …)` declarations exist. |
| §Design Direction Decision → Chosen Direction (amended 2026-08-31, `ux:506`) | **The product model is three surfaces now, not two.** "Board for scan and triage, task for clarity and steering" is still the spine; the controller is the surface for work that has no task yet, and is neither a split view nor a preview pane. |
| **§Controller and Goal Chain Surfaces** (added 2026-08-31, `ux:633-731`) | A full specification, not an amendment: where the controller appears (three places, and the load-bearing split between *talking to it* and *configuring it*), the conversation surface (layout, header, transcript, composer, empty states, permissions), what it deliberately does **not** show (no token/cost/elapsed metering in the transcript; cost is disclosed on Insights, which attributes spend to "operator and controller runs" — verified at `app/features/insights/insights-page.tsx:222`), refusal as a first-class reply (never error styling), transcript visibility and its two deliberate asymmetries, goal chains (authoring is conversational — there is no create form), and the configuration surface. Three rules hold the whole section: **the controller is an instrument, never an authority**; **consequential outcomes land on durable surfaces, not in the transcript**; **ceremony that exists to be human stays human.** |
| §Semantic Product Patterns → Execution Profile (amended 2026-08-31, `ux:768-774`) | **"Reassign" is retired vocabulary; the verb is DISPATCH.** Governs *every* occurrence of "reassign" in the document; the six surviving occurrences are enumerated so they read as history. The human steering verbs are now **approve · redirect · comment · dispatch · release**. Restates the run-control law: **configuration lives on the profile and the surface discloses it; the dispatch target and timing are the human's choice.** |
| §Custom Components (added 2026-08-31, `ux:848-870`) | **Controller Conversation** and **Goal Chain Panel** specified in the house anatomy/states/variants/a11y/content/interaction format, plus a note arguing neither duplicates an existing component (a transcript is not a Mixed Timeline Item; a chain panel is not a Task Status Card). Both added to the §Component Implementation Strategy list (`ux:889-890`) and to a new **Phase 4 — Instance Control And Goal Chains** roadmap entry (`ux:921-927`), written after the fact and saying so. |
| §State Semantics (amended twice, 2026-08-31, `ux:947` and `ux:949`) | The derived display value **`agent_working`** is declared, and so is the goal-chain **second state family**, with the rules that bind it (`attention` takes `input_required`'s treatment; `paused`/`cancelled` are neutral; every state carries its own word; the *current link* is derived positionally, never a sixth link status). |
| §Navigation Patterns (amended 2026-08-31, `ux:1047`) | **The workspace rail is eight items and the third is the Controller**: Board · Review queue · Controller · Agents · Policy · GitHub · Activity · Settings, declared in exactly one place (`app/features/shell/nav.ts`) with **no test pinning it** — read that file if they disagree. The instance controller is deliberately outside the rail. |
| §Responsive Strategy (2026-07-25) + §Implementation Guidelines (2026-07-28) | "This section previously specified **three capability modes**; that model was **never built and has been retired** rather than left standing as an instruction." One surface, reflowed. "A user on a narrow window is a supervisor with less room, not a different kind of user with fewer rights." |
| §Testing Strategy (2026-08-19, U6) | Cross-browser line qualified in place: only chromium is exercised. **Not updated for ruling 103** — see §6 F32-4. |
| Three deliberate **non-certifications** | Board lane traversal, the Continuity Recovery Panel, and the two a11y gates each record the *ruling* and explicitly refuse to assert shipped state — "read the tree". Ruling 64's reusable principle: **"a rule this document knows only as an unbuilt spec line is a rule the next pass re-files as a gap."** |

### Corrections in the architecture document

| Where | Change |
|---|---|
| §Authentication (revised 2026-07-25) | The section "originally specified OAuth-first login, **which is not what shipped**". Local credentials are first-class; server-side session rows are recorded as **not a divergence** — an opaque token satisfies the no-claims-in-the-cookie rule "absolutely rather than by discipline". |
| §Technology Stack → Styling Solution + Development Experience (corrected 2026-08-31, `architecture.md:184`, `:196`) | **"Viberr does not use Tailwind and never has."** Both Tailwind claims describe the upstream starter, not this repo: one plain stylesheet `app/app.css`, no `tailwindcss`/`postcss`/`autoprefixer` dependency, no config file has ever existed. Closes half of the pass-31 QUESTION 17. |
| §Infrastructure CI/CD + §Enforcement + tree note (reversed 2026-08-19, ruling 86) | "There **IS** a linter, and it is a gate". The linter machine-checks the anti-slop implementation patterns **only** — the naming/module-boundary/dumping-ground rules are not expressible in it, so a reviewer remains the only gate for those. No formatter, still a non-goal. |
| §Development Workflow (2026-08-19) | e2e was described as running against "a real dev server", which it has not since **2026-08-02** — it runs against the **production Docker image** in an isolated Compose stack, owner policy. |
| §Data & realtime → SSE examples (corrected 2026-08-31, `architecture.md:535-539`, `:613`) | **Two of the four canonical examples never shipped.** `task.readiness-changed` and `auth.session-expired` appear nowhere under `app/`; readiness travels as a field on `task.updated` and nothing announces session expiry. The shipped set is `SSE_EVENT_NAMES` — fourteen names, enumerated in place — over the single endpoint `/resources/events`. |
| **§The Controller and Chained Goals** (added 2026-08-31, `architecture.md:917-942`) | Ruling 99 and FR40/FR41 shipped and were then absent from this document entirely — "the failure mode ruling 44 exists to stop". The new section covers identity and degradation, the two surfaces, per-call authority resolution, why the controller is not an escalation channel, conversations-as-runs, the chained-goal file contract and reconcile engine, schedules as one-shot occurrences, and module homes. Mirrored by an FR-category mapping row (`:955`) and a fifth §Subsystem Mapping entry (`:965`). |
| Structure tree + Completeness counts (recounted 2026-08-31, `architecture.md:800-810`, `:1139-1144`) | **The counts were wrong in three places and are now measured, not remembered**: 32 route modules (the comment said 26, the Completeness section said 25 — "two sibling counts disagreeing is exactly how the staleness stayed invisible"), 18 feature folders (was 16 — `controller/` and `insights/`), 25 server directories (was 18 — `actions/`, `agents/`, `controller/`, `insights/`, `ops/`, `settings/`). **Re-verified 2026-09-01: 32 / 32 / 18 / 25.** The tree also gained `goals/`, `agents/definitions/`, `project.controller.tsx`, `palette-shell.tsx`, `controller.tsx`, `insights.tsx`, `org.settings.audit-export.ts`, `task-attachment.ts` and `goal-file.schema.ts`. |
| Runtime data root (amended 2026-08-21, `architecture.md:869`) | The `attachments/` bullet used to end "specified here and never implemented; do not write to it", **"which had been flatly false since 2026-08-14"**. Attachments are real, per-task, member-only served, thumbnailed. **Its closing sentence "There is no retention machinery" is now itself false — see §6 F32-3.** |
| Runtime data root (corrected 2026-07-25) | "The original text called the whole file non-canonical, **which read as 'disposable'**" — `projection.sqlite` is the sole home of users, sealed PATs, sessions, audit, notifications and run history. **The distinction is per-table, not per-file.** Restoring `projects/` without the DB re-mints user ids and orphans every membership and task owner. |
| Runtime data root (P11-56) | There is **no `cache/`, `auth/` or `logs/` directory** — all three were prescribed and then removed on purpose. |
| §Architectural Boundaries (corrected 2026-08-06) | The doc prescribed `app/routes/auth.callback.*.tsx`, replaced by the better-auth migration: **"no such route exists or should be created."** |
| Tree preamble + §Structure Completeness | The tree is **descriptive, regenerated from the filesystem**: "a directory that is not here does not exist, and a directory here that you cannot find is **a bug in this document, not a gap to fill**." |
| Tree note (undated) | `docs/operations/pat-management.md` was "**prescribed and never written** … so it was dropped from this tree rather than left as a phantom". |
| §Subsystem Mapping (pass 19, extended pass 31) | **Four PRD-mandated subsystems were absent from the document entirely** — decision/blocking packets, the operator agent, specialist execution, context resources — "which is how they ended up with no named home". A **fifth** was added 2026-08-31 (the controller + chained goals), with the note that it is "the same failure repeating". |

### Held, not dropped (ruling 80 / R20-5)

Three spec-vs-app gaps are **deliberately unbuilt** and must stay noted rather than silently
closed or silently ignored: **D7** (Decision-Packet anatomy fields: impact / confidence /
severity), **D10/D11** (Continuity-Recovery-Panel escalated + paused states; the
Execution-truth-strip runtime-continuity fact), **D12** (skeleton loaders). Carried
unchanged through passes 20–31; still open at pass 32 (QUESTION 12).

---

## 5. Open questions & ambiguities

Each pass-31 question is restated with its **disposition**. Answered questions are kept
(with what answered them) so a later reader does not re-open them; open questions carry
forward.

**QUESTION 1 — FR4's non-member commenting vs ruling 25. → OPEN (unchanged).** FR4
(`prd.md:208`) still states that every registered user may comment on any task "including
tasks in projects they are not a member of", with non-member comments visibly labeled, then
amends itself with ruling 25 (members-only, 404-equivalent). Under members-only, what state
still produces a non-member comment that needs the label? The org-admin override is the only
path that comes to mind, and ruling 100(b) confirms an org-admin read path exists for
controller transcripts — but that is a transcript, not a task comment. Is the "non-member
comment" label live machinery, or vestigial copy for an unreachable state?

**QUESTION 2 — the controller's policy-edit carve-out. → ANSWERED by ruling 100(a)**
(`decisions.md:1424-1427`). The owner confirmed the asymmetry is intended: the controller is
an admin-tier instrument executing an explicit human directive, so **"has a ceremony" stays
the practical always-human test**, and policy edits do not gain one. The corollary the
question raised — that any future ALWAYS_HUMAN action without a ceremony is implicitly
controller-eligible — is now the accepted rule rather than an open worry. Carry it forward
as a design constraint: **if a new always-human action must stay out of the controller, give
it a ceremony.**

**QUESTION 3 — org admins read project-scoped controller transcripts. → ANSWERED by
ruling 100(b)** (`decisions.md:1427-1431`) and specified in the UX spec at `ux:688-696`. It
is "a deliberate step outside R15-4's members-only posture": the transcript belongs to the
**asking user's** scope, not the project's, and org admins administer the instrument. The UX
spec states the two interface consequences that keep it honest — lists are scope-partitioned
and never merged, and **reading is not writing** (an org admin gets the read-only composer
like any other non-owner).

**QUESTION 4 — which document actually wins, and in which direction? → OPEN (unchanged).**
`decisions.md:3-6` still says it condenses `architecture.md`, "which wins on conflict".
Practice contradicts that in both directions: ruling 86 is an owner ruling that *amends
architecture.md*, and rulings 44/63/94/98/99/101/103/104 amend the PRD, while rulings 64 and
66 have the **UX spec winning over the app** (unbuilt spec lines were ordered *built*). The
pass-31 retrofit adds a third direction: rulings 99 and 98 were **written down into** the UX
spec and architecture.md after the fact. So precedence is genuinely conditional: **the app
wins on facts** (tokens, fonts, file layout, tool config), **the spec wins on product
promises the owner still endorses**, **canon absorbs a shipped ruling after the fact**, and
**only an owner ruling settles which category a thing is in**. This is the rule other agents
will most often need and cannot derive from any single file. Should it be stated explicitly
in canon, and should `decisions.md`'s header be corrected?

**QUESTION 5 — FR head-sentences that are now false. → PARTIALLY ANSWERED, no ruling.**
Pass 31 added an inline `**[Amended — the head sentence below predates … read the amendment
notes first.]**` marker to FR5, FR11, FR14, FR27 and FR39 (`prd.md:214`, `:223`, `:226`,
`:249`, `:239`), which removes the trap for a reader who quotes the first line. The bodies
were **not** rewritten and the amendment-note style is unchanged. The underlying question —
should FR bodies be restated to the current model with history moved below — was not put to
the owner and carries no ruling. This digest keeps the **[A!]** marker.

**QUESTION 6 — NFR1's scaling limit has no threshold. → OPEN (unchanged).** Ruling 63
replaced the 200-card figure with "a very large project is a known scaling limit to be
measured and fixed **when a real one exists**". There is no definition of "a real one" and,
by ruling 63's own standing rule, no harness may be added without the budget it measures —
which reads as circular. What event triggers the fix, and who notices it?

**QUESTION 7 — the declared browser matrix is unverifiable intent. → ANSWERED by ruling 103**
(`decisions.md:1464-1467`). The owner **struck** Safari and Firefox: the PRD now declares
Chromium-based browsers only (`prd.md:160`, mirrored byte-identically in `design/prd.md`),
with the history kept in-line and re-adding an engine gated on a Playwright project that
actually runs it. `docs/testing.md` and `docs/testing-quickstart.md` were updated in the same
change. **The UX spec's §Testing Strategy was not** — see §6 F32-4.

**QUESTION 8 — is the Codex posture still consistent with NFR8? → ANSWERED in the code by
ruling 101; the PRD note was not extended.** Ruling 101 (`decisions.md:1433-1455`) restored
the Codex read-only sandbox for write-withheld runs, so `execute-code-or-write-repo` is back
in `ENFORCED_CAPABILITY_IDS` (`app/shared/capabilities.ts:227`) and binds on **both**
backends; the "advisory on Codex" half of the question is gone. Ruling 39's MCP-outside-the-
matrix half stands, and NFR8 still carries only that amendment (`prd.md:282`). The residual
combination worth stating: a Codex run with a **granted** write-capable MCP server still has
no Viberr-enforced tool boundary — but that is ruling 39, already noted, not a Codex
asymmetry. **Remaining sub-question:** should NFR8 gain a sentence recording that the write
family binds on both backends *again*, so a PRD-only reader does not inherit R22's
Claude-only reading?

**QUESTION 9 — the 90-day audit retention has no ruling number. → PARTIALLY ANSWERED by
ruling 102.** The *export* now has a ruling and the purge fails closed
(`decisions.md:1457-1462`), so "genuinely gone at 90 days" is no longer true for the rows
themselves. The **90-day number itself** still has no numbered ruling — it lives only in
FR33's "Bounded 2026-07-25" note and `AUDIT_RETENTION_DAYS = 90`
(`app/server/db/retention.server.ts:53`). New sub-question raised by the fix: the JSONL
export has **no retention or rotation of its own** and no runbook entry — see §6 F32-6.

**QUESTION 10 — FR23's "authorized users" is undefined. → OPEN (unchanged).** FR23
(`prd.md:238`) grants access to an agent's native runtime session for deep debugging without
naming a role. Ruling 99(d) gates the controller's run-log console "owner-or-admin", and
ruling 107 makes `read_run_log` apply "the exact gate `/resources/run-log` applies" — so the
run-log gate is now single-sourced and reusable, which is progress, but FR23 still names no
`ACTION_ROLES` entry. Which entry governs it today, and does the runtime console leak
anything a viewer should not see?

**QUESTION 11 — ruling 98 vs FR39's "pins only profile identity". → OPEN (unchanged).**
Ruling 94 says a schedule pins *nothing*; ruling 98(d) says the agent arm pins *profile
identity*. Both are true and reconcilable (identity is the scheduled decision;
capability/backend/model resolve live), but FR39 (`prd.md:239`) now carries three stacked
amendments plus the new bracketed marker. A single restatement would remove a real
re-derivation cost. *(architecture.md:940 now states the reconciled version in one paragraph
— "it pins **no backend and no autonomy** — the agent arm pins only the profile identity" —
which is the sentence FR39 could adopt.)*

**QUESTION 12 — the held D7/D10/D11/D12 gaps have no expiry. → OPEN (unchanged).** Ruling 80
held them as "pure never-built PRD features". They have now been carried across passes
20–31. Are they Phase-2 scope (in which case the UX spec should say so), or debt the next
pass builds the way ruling 64 decided for D18/D19? *(Pass 31 added two brand-new components
to the custom set and a Phase 4 roadmap entry without touching the held three, which widens
the gap between "specified" and "built" rather than closing it.)*

**QUESTION 13 — the controller and chained goals exist in exactly one canon file. →
ANSWERED for ruling 99.** Pass 31 (E2) wrote both surfaces into both documents: the UX spec
gained **§Controller and Goal Chain Surfaces** (`ux:633-731`), two component specs
(`ux:848-870`), a Phase 4 roadmap entry (`ux:921-927`) and four pattern amendments;
architecture.md gained **§The Controller and Chained Goals** (`:917-942`), an FR-mapping row
(`:955`) and a fifth subsystem entry (`:965`). `goals/` is in the data-root tree (`:846`),
`goal-file.schema.ts` in the schema list (`:745`), `controller/` in both the features and
server inventories. **The same failure has already recurred one ruling later:** rulings 106,
107 and 108 are again readable in exactly one file — see §6 F32-5.

**QUESTION 14 — "reassign" is retired vocabulary the UX spec still teaches. → ANSWERED.**
The Execution Profile Pattern carries a 2026-08-31 amendment (`ux:768-774`) retiring the word
in favour of **dispatch**, enumerating the six surviving occurrences as history, and
restating the run-control law exactly as the question proposed: **"configuration lives on the
profile and the surface discloses it; the dispatch target and timing are the human's
choice."**

**QUESTION 15 — the UI renders a state neither doc declares. → ANSWERED.** `agent_working`
is now declared in §State Semantics (`ux:947`) as a derived, never-persisted display value
computed by `deriveDisplayReadiness` (`app/shared/mapping/task.server.ts:498`), together with
the second derivation the same function performs (a `ready` + `waiting: human` task with an
open input packet displays as `input_required`). A companion amendment (`ux:949`) declares the
goal-chain state family. *(Ruling 1's "Accepted is a derived display state, never a stored
readiness" is still recorded in neither planning document — a small residue of this question.)*

**QUESTION 16 — the admin/workflow-owner persona has intent but no journey. → OPEN
(unchanged).** The PRD gives Elif a full journey (`prd.md:85`); the UX spec names her
persona shape at `ux:55` but ships mermaid journeys for Arda ×2 and Murat only — the string
"Elif" appears **zero** times in the UX spec — and **no workflow component or semantic
pattern serves configuration**, while `policy/`, `agents/`, `project-settings/` and
`org-settings/` are four shipped feature surfaces governed only by the generic form-pattern
section. Pass 31 added a fifth configuration surface to that list (the org-settings
Controller tab, now specified at `ux:721-730`) — which makes the missing configuration
journey slightly more conspicuous, not less. Is configuration UX in scope for a pass?

**QUESTION 17 — architecture.md's stale islands. → PARTIALLY ANSWERED.** Fixed by pass 31:
the two Tailwind claims (`:184`, `:196`), the route/feature/server counts (`:800-810`,
`:1139-1144`), and the two never-shipped SSE examples (`:535-539`, `:613`); `controller/` and
`insights/` now appear. **Still open:** the Deferred-Decisions bullet "Auth library
abstraction choice, if a lightweight custom OAuth integration remains sufficient"
(`architecture.md:254`) and the Important-Gaps bullets "Exact OAuth implementation library is
intentionally not fixed yet" and "Exact PAT encryption primitive/key-management
implementation is not named yet" (`architecture.md:1171-1172`) — while better-auth and
AES-256-GCM are named elsewhere in the same file (`:874`). Under the document's own promise
("a divergence is a doc bug to fix"), these are doc bugs.

**QUESTION 18 — mobile leftovers survive the retirement. → OPEN (unchanged).** The a11y
section still asks for "touch targets large enough for **tablet and mobile review flows**"
(`ux:1124`) and the testing section for "**reduced-complexity review on smaller screens**"
(`ux:1139`) — vocabulary from the three-capability-mode model the same document retired as
never built, and from a mobile target the PRD excludes from V1. Harmless in effect but it
cites a mode the product deliberately does not have.

### New questions raised by rulings 100–108

**QUESTION 19 — ruling 108's lock is env-only, and the deployment that sets it is invisible
in-app.** The four unlock variables are read at request time from the parsed env
(`controller-profile.server.ts:84-98`) and the panel discloses which sections are locked and
what to set. But nothing in the app records *who* unlocked a section or when, and the two
disclosed side doors (resource-references pruning; granted-resource content edits) are
governed by ordinary org-admin actions that write ordinary audit rows under a different
name. Should an unlocked deployment be visible in the audit trail or on the instance-health
surface, so "the doctrine changed" is answerable after the fact?

**QUESTION 20 — `viberr_ops`'s `instance_health` is the first tool whose *availability* is
universal.** Ruling 107 opens the reading to anyone who can converse — which is every
signed-in user — on the reasoning that `/resources/health` is unauthenticated by design
(`app/routes/resources.health.ts:8`) and the concurrency reading is three integers carrying
no name or project. That is sound, and the credential detail is correctly gated. The question
is upstream: **should `/resources/health` still be unauthenticated** now that a conversational
surface makes its contents trivially reachable and quotable? The probe's audience was
orchestrators; it now also has users.

**QUESTION 21 — the controller now has two authority surfaces, and NFR8 describes neither.**
`viberr_controller` (ruling 99) and `viberr_ops` (ruling 107) both resolve the asker's live
authority per call, in-process, outside the capability matrix by construction (the controller
has none). NFR8's amendment covers *MCP grants* sitting outside the matrix; these are not
grants — they are built-in mounts nobody can remove. A PRD-only reader learns nothing about
either. Should NFR8 (or FR40) gain a sentence naming the two in-process servers and the
principle that binds them: **the asker's live authority, per call, refusing out loud**?

---

## 6. Findings for the pass-32 ledger

Defects, drift, dead text and contradictions found while re-verifying this document. **None
were fixed.** Each: what · where · why it matters · confidence.

**F32-1 — `decisions.md` ruling 7 still says TEN packet kinds; the schema has ELEVEN.**
`docs/architecture/decisions.md:167-173` enumerates ten kinds and narrates the nine→ten
correction. `app/schemas/task-file.schema.ts:129-165` holds **eleven** — pass 31's F31-6
added `resolve_remote_collision`. `docs/architecture/file-formats.md:219,247` **was** updated
("Eleven is the count today"), so the two docs now disagree with each other, which is the
exact pattern architecture.md's recount note calls out as how staleness stays invisible.
`decisions.md:921` (ruling 77) also still calls `discard_branch` "ruling 7's tenth". Why it
matters: ruling 7 is the canonical kind list that code comments cite, and this is the third
time the count has drifted — ruling 44's failure mode reproducing one pass later.
**Confidence: high.**

**F32-2 — `decisions.md`'s Route map omits two shipped routes.** `decisions.md:1642-1655`
lists `/org/settings`, `/controller`, `/profile`, `/notifications`, `/notifications/read`,
`/prefs/theme` and the `/resources/*` set, but **not** `/insights` (`app/routes.ts:33`) or
`/org/settings/audit-export` (`app/routes.ts:31`) — both shipped and both admin-gated. The
map's own footnote (`:1657-1659`) records the identical correction being made in 2026-08-06.
Why it matters: this map is what a reader consults for "does a route exist"; architecture.md
was recounted and this was not. **Confidence: high.**

**F32-3 — `architecture.md:869` states there is no attachments retention machinery; ruling
105 built one.** The bullet ends "There is no retention machinery — the files ride with the
task directory." Ruling 105 (`decisions.md:1490-1503`) added a **completion-time prune** of
uncited machine-stamped browser working artifacts (`isBrowserWorkingArtifact` /
`attachmentNamesSince`, `app/server/files/task-attachments.server.ts:108,165,188`, driven from
`applyAgentCompletionEffects` at `app/server/tasks/task-actions.server.ts:3139,3193-3197,3361`).
The sentence is now false in exactly the direction the bullet's
own 2026-08-21 amendment warns about ("which had been flatly false since 2026-08-14"). The
same bullet also still describes the panel as "timeline thumbnails with an in-app lightbox",
which under ruling 105's addendum is now a universal card with Download for every kind.
Why it matters: an agent reading this bullet would conclude posted files are permanent.
**Confidence: high.**

**F32-4 — the UX spec's Testing Strategy still names Safari and Firefox after ruling 103
struck them.** `ux:1140` reads "test Chromium, Safari, and Firefox on current desktop
versions" with a 2026-08-19 in-line qualifier saying only Chromium is exercised. Ruling 103
(2026-08-31) removed the two engines from the PRD (`prd.md:160`) and from
`docs/testing.md` / `docs/testing-quickstart.md`, but the UX spec was not touched — so the UX
spec now instructs a test practice canon has struck. Related dead text in the same file:
`ux:1124` and `ux:1139` still carry the retired mobile/tablet vocabulary (QUESTION 18).
Why it matters: an implementation agent taking the UX spec as the surface contract would
budget for two engines the product does not claim. **Confidence: high.**

**F32-5 — rulings 106, 107 and 108 are readable in exactly one file, which is the failure
QUESTION 13 was filed for.** Neither the UX spec nor architecture.md nor the PRD mentions the
controller settings tab's editor parity (106), the unremovable `viberr_ops` diagnostics MCP
(107), or the deployment lock (108). Concretely stale text as a result:
- `ux:725` — "It edits the model, three grant lists (skills, knowledge bases, MCP servers),
  and the instructions." Under ruling 108 all four of those are **read-only by default**; and
  under ruling 106 the panel also edits **effort**, through catalog pickers rather than a
  free-text field.
- `ux:729` — "A grant that is no longer in the store still renders, marked as not in the
  store, rather than vanishing." Ruling 106 replaced that treatment with a **removable red
  `MissingChips`** chip (`controller-admin-panel.tsx:193`); ruling 108 makes it
  non-removable-but-disclosed under a lock (`:180-192`).
- `ux:727` — "There is deliberately **no capability matrix** … the MCP grants *widen no
  authority*." Still true, but the panel now also carries a **pinned `viberr_ops` chip that is
  not a control** (`app/features/org-settings/controller-admin-panel.tsx:385-389`), which the
  section does not mention.
- `architecture.md:917-942` — the controller section describes grants and doctrine as
  org-admin-editable with no mention of the deployment lock or the ops mount.
Why it matters: ruling 44 exists precisely to stop this, and pass 31 spent a whole PR
repairing the previous instance. **Confidence: high.**

**F32-6 — ruling 102's audit export has no retention, rotation or runbook entry, and the
data-root tree does not list it.** `app/server/db/retention.server.ts:98-110` writes
`<dataRoot>/audit-exports/audit-events-<YYYY-MM-DD>.jsonl`, appending on every boot-time
purge. The directory is **not** in `DATA_ROOT_SUBDIRS`
(`app/server/files/file-store-root.server.ts:26-40`) and **not** in architecture.md's
"shipped layout, created at boot from `DATA_ROOT_SUBDIRS`" tree (`architecture.md:838-865`),
so a reader of the tree does not know it exists. **Nothing rotates, prunes or size-bounds it**
— `audit-exports` appears in exactly four places in the tree (`retention.server.ts:37,98,109`
and the org-settings disclosure line `app/features/org-settings/org-settings-page.tsx:346`)
and nowhere in `docs/operations/`. Meanwhile the PRD now says it is the only record of
org/auth events past 90 days (`prd.md:261`). Contrast `runtimes/codex-home/auth.json`, whose
secret-handling implication the same tree does call out — an audit export is a file full of
exactly the identity events NFR7/NFR10 govern. Why it matters: an unbounded file under the
data root that the architecture tree and the ops docs do not mention, so a backup or
retention policy will not know to include or protect it. **Confidence: med-high** (the
behavior is certain; whether the owner wants rotation is a decision).

**F32-7 — ruling 17's "remote-branch deletion exists only as that packet resolution" is now
false.** `decisions.md:222-223` names the `pr-diverged` recovery packet as the *sole* path to
a remote branch deletion, and ruling 77 restates it at `:923` ("remote deletion has always
been packet-only"). Pass 31's `resolve_remote_collision` deletes a remote ref and closes the
unowned PR from a **different** packet (`app/server/tasks/task-actions.server.ts:6438-6445`).
The spirit (human-confirmed, `approve-transition`-tiered, packet-only) survives; the letter
does not. Why it matters: ruling 17's sentence is the kind a reviewer quotes to refuse a
change. **Confidence: med-high.**

**F32-8 — `execute-code-or-write-repo` is listed twice in the same Set literal.**
`app/shared/capabilities.ts:228` and `:259` both add the id to `ENFORCED_CAPABILITY_IDS`.
Harmless at runtime (it is a `Set`), and the second occurrence carries the ruling-101 comment
that explains *why* it is there — but a duplicate literal in a hand-maintained id set is
exactly what a later edit deletes the wrong copy of, silently dropping the enforcement. Why
it matters: low blast radius today, high blast radius on the next edit. **Confidence: high**
(the duplication is certain; the severity is a judgement).

**F32-9 — `app/routes.ts:67` says "the seven project views + task"; there are eight.** The
workspace shell registers board, review, controller, agents, policy, github, activity,
settings (`app/routes.ts:68-78`; the stale comment is at `app/routes.ts:67`). The UX spec's 2026-08-31
nav amendment (`ux:1047`) counts eight and says the order "is declared in exactly one place,
`app/features/shell/nav.ts` — **no test pins it**". Why it matters: a stale count in the routing manifest is where the next
reader calibrates, and the nav order that the UX spec now treats as a contract has no gate.
**Confidence: high** (count), **med** (whether the missing nav-order test is worth one).

**F32-10 — `docs/architecture/decisions.md` §Layout does not list `goals/` or the controller
directories, while architecture.md does.** `decisions.md:26-37` shows `schemas/` as
"(task-file, project-file, sse-event, github-pat)" — `goal-file.schema.ts` shipped
2026-08-30 — and the `server/` line is a one-word summary that no longer covers
`controller/`. The file defers to architecture.md for "the live folder inventory"
(`decisions.md:39-40`), which is a legitimate escape, but the parenthesised schema list reads
as exhaustive and is not. Why it matters: minor, but it is the same class as F32-1/F32-2 in a
file whose whole job is to be the citable contract. **Confidence: med.**

**F32-11 — FR17 and FR40 do not record their own newest rulings.** FR17 (`prd.md:229`)
covers the attachments drop (ruling 96) but not ruling 105's completion-time prune or the
universal in-app viewer — a behavior change a user sees (files an agent produced disappear
from the panel unless cited). FR40 (`prd.md:241`) covers ruling 99 but not 106/107/108 — in
particular not that the controller's grants and instructions are **locked out of in-app
editing by default**, which contradicts FR40's own "Only org admins modify the controller
itself (its profile, resources, grants, and instructions)". Why it matters: FR40's sentence
now overstates what an org admin can do on a default deployment. **Confidence: high.**
