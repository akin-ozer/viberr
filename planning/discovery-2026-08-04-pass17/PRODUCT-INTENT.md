# Viberr — product-intent canon digest (pass 17, 2026-08-04)

**Audience:** an implementation agent about to change product behavior, and the owner making the
decisions in §4.

**What this is.** The *current* digest of what the product is supposed to be, per the canon, plus
a verified list of where the tree and the canon disagree **today** — after pass 16's three fix
waves (`5e03c6e`, `53b796d`, `71fa506`, `0955ac9`, merged as `8541a32`).

**What this is not.** A re-derivation of pass 16. `planning/discovery-2026-08-04/PRODUCT-INTENT.md`
(964 lines) is the long-form map — evolution ledger, recovered rulings from the deleted pass
folders, the full surface inventory. Read it when you need history. This document is the *state*
after that pass, and every delta below was re-checked against the tree on 2026-08-04.

---

## 0. Precedence

Unchanged from `planning/README.md:3-24`, and it holds:

1. **The three living docs** — `planning/planning-artifacts/prd.md`, `architecture.md`,
   `ux-design-specification.md`. When the app and a doc disagree **and the app is right, the doc
   is amended with a dated note**, not the app "fixed" back (`planning/README.md:9-11`). Read a
   requirement's amendment notes before treating it as an instruction.
2. **`docs/architecture/decisions.md`** — the normative contract code comments cite as
   *CONVENTIONS* and *"orchestrator ruling N"*. It condenses `architecture.md`, **which wins on
   conflict**. 34 numbered rulings today. Superseded rulings are kept and marked; *"never restore
   a superseded rule because you found the ruling text"* (`decisions.md:16-20`).
3. **`design/`** — build inputs, not canon. `design/prd.md` is **byte-identical to canon today**
   (both md5 `783177bcdfd0c7e359adeb500b7d2bd5`) — R15-8 still holds.
   `design/CONVERSATION-SUMMARY.md`'s rejection list still binds as *"don't re-add this"*.
4. **The code and test suite** — the only proof of behavior. 213 unit/integration test files, 7
   e2e specs run against the **production Docker image** (the dev server is banned for any
   browser/e2e/acceptance check — modernization owner amendment).

A fifth line is now needed, and it is the headline of this pass: **pass 16's seven owner rulings
(R16-1…R16-7) are cited in ~30 code comments and tests but exist in no canon file.** They live
only in `planning/discovery-2026-08-04/FINDINGS.md:5-31`. See §3 D1.

---

## 1. The intended experience

### 1.1 One paragraph

Viberr is a multi-user web app for **governed AI software delivery** for small AI-forward
engineering teams (`prd.md:38-46`). **The task file is the canonical operating contract** between
humans, agents and GitHub execution — identity, goal, state, execution context, timeline,
decisions and evidence in one readable markdown file at
`$VIBERR_DATA_ROOT/projects/<slug>/tasks/<KEY>/task.md` (ruling 3;
`app/server/files/file-store-root.server.ts:10, :66-74`). A dedicated **operator agent** manages
each active task, **specialist agents** do the stage work, and humans govern through policy,
comments, decisions and explicit acceptance. V1 is single-repo GitHub-backed delivery behind a
familiar board/task surface: *agents are the native workers, engineers govern the flow, review
stays human-authorized* (`prd.md:44-46`).

### 1.2 Invariants an implementer may not quietly relax

| # | invariant | canon |
|---|---|---|
| I1 | **Files are canonical truth** for task/project state. SQLite is a rebuildable projection *per table* — it is also the only home of users, sessions, audit, notifications, sealed PATs, org resources and run history. | `architecture.md:109-118`; `decisions.md:75-80` |
| I2 | **Tolerant parsing.** Malformed input → diagnostics + a readiness downgrade, never a crash, never a silent drop. | `architecture.md:120-131`; `decisions.md:78-80` |
| I3 | **Readiness is exactly four values** (`ready`, `input_required`, `inconsistency_risk_detected`, `blocked`), derived in ONE module. "Accepted"/"merged" are derived display states, never stored readiness. | ruling 1; `architecture.md:120-131`; `app/server/interpretation/readiness-policy.server.ts` |
| I4 | **Human-only Done**, enforced server-side — with the one audited exception: full autonomy + an explicit `completion-for-acceptance: direct` grant. Never implied by raising autonomy; disclosed in the UI. | `prd.md:114, :245`; `decisions.md:91-95` |
| I5 | **Two permission systems, kept visibly separate**: human RBAC (4-role strict tier, one table in `app/shared/rbac.ts` that guards *and* the Policy page read) vs agent capability policy (`direct｜recommend｜human｜off`). `ALWAYS_HUMAN` = merge PR, transition to Done, change project policy. | `prd.md:110-114`; ruling 2; `app/shared/capabilities.ts:162-166` |
| I6 | **Re-anchor rule.** Any reactivated agent re-anchors on the canonical task file before acting; provider-history loss degrades gracefully. | `prd.md:116-120`, Journey 4 `prd.md:87` |
| I7 | **Traceability + idempotency.** task key ↔ branch ↔ commits ↔ PR unambiguous; retries never duplicate a transition, branch, PR or event. | NFR15/NFR16 `prd.md:289-290`; `decisions.md:82-83` |
| I8 | **Secrets never reach task-visible artifacts** — files under `projects/`, comments, audit, logs, SSE payloads, error messages. | NFR7 `prd.md:275`; `decisions.md:87-88` |
| I9 | **No optimistic UI for governed state.** Revalidate after the action and on SSE. | `decisions.md:81` |
| I10 | **Never simulate.** An unavailable backend produces an honest error + a typed blocked packet — no fake run, verdict or evidence, in product or seed. | R7-2 (pass 7) |

### 1.3 Personas and the loop each defines

| persona | journey (`prd.md:79-98`) | the loop |
|---|---|---|
| **Arda** — senior engineer | J1, primary success path | scan board → spot what needs a human → open task → understand state in seconds → act |
| **Arda intervening** | J2, primary edge case | board flips to waiting-on-human with unhealthy validation → typed blocking packet (observed / changed / options / decision required) → pick a recovery path → operator re-engages the specialist |
| **Elif** — workflow owner | J3, admin | stages, transitions, boundaries, default repo, then human RBAC **and** the agent capability matrix *separately*, "because governing people and governing agents aren't the same problem" |
| **Murat** — escalation | J4, troubleshooting | provider history gone → operator surfaced the warning and rehydrated from `task.md` → confirm it holds enough context → drop into the provider thread only as a *debug session*, bring anything that matters back as a comment |

Binding success criteria (`prd.md:63-69`): ≥90% of active tasks show an unambiguous owner /
waiting state / latest packet; ≥90% of executed tasks keep task↔branch↔commit↔PR traceability;
blocked tasks reach a human decision quickly because packets are concise; readability holds on
long tasks.

### 1.4 The core flow, canon → mechanism

Read this as the spine. Each step names the requirement, what actually implements it, and the
guardrail that must not be removed.

**1. Task creation (human only).** FR11 (`prd.md:222`) — *"task creation is a human act"*; the "and
authorized agents" clause was struck 2026-07-25 as never implemented. An agent that believes a
task is needed routes it through a decision packet. Contributor+ may create
(`app/shared/rbac.ts`); FR15 (`prd.md:226`) lets the operator hold a vague task at triage with
`readiness: input_required` rather than executing it.

**2. Operator dispatch.** FR18/FR20 (`prd.md:232-234`) — one dedicated operator per active task; it
recommends assignments, transitions and human decisions, and triggers specialist work. Every stage
chain (re)triggers a queued operator run and the operator is stage-aware — *"never strand
`waiting:human` with no packet"* (R-A, pass 11). Under `strict`, pre-work boundaries are
human-gated; under `auto` the operator runs at full autonomy; **review→done stays structurally
human-locked in every preset** (S1, pass 1-3). Transition-chain depth is capped (8).
Toolkit: `app/server/tasks/operator-toolkit.server.ts` — `get_task`, `post_comment`, `set_goal`,
`open_decision_packet`, `resolve_decision_packet`, `engage_agent`, `run_agent`, `prompt_agent`,
`deliver_for_review`, `transition_stage`, `accept_completion`.

**3. Agent work.** FR19/FR21/FR22 (`prd.md:233-236`). Generic machinery: apart from the operator
all agents are one uniform mechanism differentiated by per-profile data (generic-agents G1).
`task.md` carries `engagements[]` of `{profileId, backend, role, delivers?}` with **exactly one
`delivers: true`** — the single-writer invariant for workspace/branch/PR ownership. Verdict power
is a **grant**, default off (G2). Agent toolkit is `post_comment`, `ask_human`, `report_outcome`,
each capability-gated (G3); outcomes come back through one envelope schema (G4). Runs execute in a
per-task workspace clone with `GIT_CEILING_DIRECTORIES` confinement; a backend with no credential
is `unavailable` and fails fast (I10). Skills / knowledge bases / MCP servers are per-profile
context grants (FR9).

**4. Review.** Q10-03 (pass 10): the review model is **revision-bound** — per-engagement verdicts
keyed to an immutable `workRevision`; a new tree invalidates prior verdicts; acceptance requires
every currently-required reviewer to approve the *current* revision. A failing verdict lets the
operator transition **backward** (Review → In Progress), the one governed audited backward edge
(R7-4). The review queue is a **triage list**: rows say "Review ›", never "Accept", because
acceptance may refuse (R15-11).

**5. Delivery.** FR31 as amended (`prd.md:252`) + R15-2: **push + review-PR opening is an operator
decision, not a stage side-effect.** The operator holds `deliver-review-pr`, weighs the task's
remaining stages, opens a packet when unsure, and may offer *early* delivery when later stages
don't gate this task. An **absent** grant resolves from the project's own workflow graph, not a
constant (R15-9, `absentDeliverReviewPrMode`). The server executes the mechanics; specialists
never push or open PRs. Entering the review-role stage with no PR writes a typed event — never
silence. A human delivery button (maintainer+ / task owner) is the escape hatch.
**A task owns a PR only if that task opened it** (R15-15), and adoption now requires the PR be
**open AND its head sha be the delivered revision** (R16-1,
`app/server/github/pr-adoption.server.ts`).

**6. Acceptance.** FR27 as amended (`prd.md:245`) + R15-1: acceptance is **verdict-gated** — a
healthy reviewer verdict on the *delivered* revision, enforced at every acceptance writer, with a
confirm dialog naming what will merge and any missing signal. The audited admin **Force-accept** is
the only bypass, and it never bypasses the PR-head check (`acceptancePrHeadCheck` +
`assertVerifiedHeadStillApplies`, `app/server/tasks/task-actions.server.ts:4696-4752`). A closed,
unmerged PR is a **terminal** blocker that outranks the process gate and *withdraws* force-accept
(R16-3). Human acceptance triggers a real async merge; a full-autonomy operator accept records
`pr.state: "accepted"` — **merge pending, a human merges it** — because `merge-pull-request` is
`ALWAYS_HUMAN` (R16-6; `app/server/tasks/operator-actions.server.ts:2034-2054`).

**7. After.** Merged-branch deletion is a per-project setting, default on (R15-6). A PR closed or
merged out of band fires a `pr-diverged` operator trigger and exactly one recovery packet: rework
/ `archive_task` / `archive_task + deleteBranch` (ruling 17). Task archive is a terminal
**disposition**, restorable, which also cancels pending scheduled re-runs (R14-3, RV-03).

### 1.5 FR amendments that actually change what you build

| FR | the amendment | why it matters to an implementer |
|---|---|---|
| **FR4** (`:207`) | commenting is app-wide — **but** R15-4 made projects members-only, so "app-wide" means *within the projects you can see*; non-members get a 404-equivalent | do not add a non-member read path anywhere |
| **FR7 / FR30** (`:215, :251`) | task-level repo override **struck**; one repo per project, no exceptions | there is no task repo field to honor |
| **FR11** (`:222`) | "and authorized agents" **struck** | agents route task creation through a packet |
| **FR14** (`:225`) | *not yet amended* — still says "primary specialist + consultant specialists" while the product ships engagements | see §3 D9 |
| **FR27** (`:245`) | human-only Done + the full-autonomy exception + **verdict-gated acceptance** + mandatory confirm dialog | four gates, one shared acceptance core |
| **FR31** (`:252`) | delivery is an **operator decision**, not a stage side-effect | never bind push/PR to a stage id |
| **FR33** (`:257`) | audit bounded to **90 days**, hard-deleted on every boot, **no export in V1** | see §3 D7 for the two exempt actions |
| **FR37** (`:208`) | owner authority widened **twice**: any open decision (R14-2), then any operator recommendation incl. stage moves — *the Apply click IS the authorization* (R15-3) | scoped to that task only; every inner capability gate still applies |
| **FR38** (`:209`) | self-service take/release; admins may release any owner; typed events + audit | |
| **FR39** (`:238`) | scheduled operator re-runs — the **one** capability that lets an agent act with nobody watching, so: canonical in the task file, cancellable, audited, never on a terminal or archived task | |
| **Responsive** (`:161`) | the review-first sub-768px mode was **retired**, not deferred. Same surface, reflowed. *"Every action, including destructive and governance actions, renders at every width"* (`ux-design-specification.md:870`) | nothing may be gated on viewport |

### 1.6 UX intent in force

- **Experience principles** (`ux-design-specification.md:101-107`): status before history · decisions
  before discussion · human attention is scarce · calm over chatter · one task, one truth.
- **Emotional principles** (`:149-155`): clarity creates trust · calm beats excitement · intervention
  should feel powerful · serious, not sterile · confidence is cumulative.
- **Direction** (`:417-423`): *Signal Console* board (triage-first, high-signal cards) + *Operator
  Desk* task page (current state, execution truth, latest packet, steering actions above timeline
  depth). Split-view is explicitly secondary.
- **Five named components** (`:611-664`): Task Status Card · Decision Packet · Execution Truth Strip
  · Mixed Timeline Item · **Continuity Recovery Panel**. Four exist; the fifth does not (§3 D20).
- **State rule** (`:734`): *"Input gaps, inconsistency risk, blocked conditions, and continuity
  degradation must not collapse into a single generic 'error' treatment."*
- **Superseded in place** by the shipped design system: palette (`:348`), typography (`:373`),
  spacing/12-column grid (`:381`) — the *principles* still bind.
- **Token discipline**: one stylesheet `app/app.css`; **unprefixed** tokens (`--bg`, `--fg`,
  `--blue`); no Tailwind, no inline hex; **a `var(--x)` not defined in `:root` is a bug, not a
  style choice** (`decisions.md:106`). There is no `--viberr-*` layer and never was.
- **Copy bans**: "govern/governance" never appears in rendered UI copy (say *Maintainer*,
  *Permissions*, "managed"); the `design/CONVERSATION-SUMMARY.md` rejection list still binds.
- **Honesty over reassurance**: every count names its scope; refusals are rendered copy in place,
  never a `title` on a disabled control; a control must not name an outcome its surface cannot
  promise (R15-11); collapse, never hide (R15-12).

---

## 2. Binding owner rulings

### 2a. Numbered in `docs/architecture/decisions.md` (the citable set)

These are what a code comment means by *"ruling N"*. R-numbers are the pass label where one exists.

| N | R-# | ruling | status |
|---|---|---|---|
| 1 | — | Readiness: canonical 4-value enum, ONE mapping module to pill kinds; "accepted" is derived display | in force |
| 2 | — | Roles: three separate systems (org · project · agent capability), `ALWAYS_HUMAN` invariants | amended (contributor rename, `app/shared/rbac.ts` single source); **superseded in part by 25** |
| 3 | — | Task-file store `projects/<slug>/tasks/<KEY>/task.md`; UI shows the REAL store path | in force |
| 4 | — | UTC ISO at all boundaries; one shared formatter | in force |
| 5 | — | PAT scope violations: per-scope validator + per-violation open/resolved records, no global boolean | in force |
| 6 | — | Identity: compare by user id; display names are render-only | in force |
| 7 | — | Packet options carry a stable `kind`; capability policy is id-based; advisory ids get no toggle | in force — **its kind count is stale, see D2** |
| 8 | — | `tweaks-panel.jsx` not ported; review queue lives in `app/features/review/` | in force |
| 9 | — | Notifications are per-user SQLite rows, soft refs | **superseded in part** (clean-sheet seed: no stub projects) |
| 10 | — | "Waiting on you" / review queue stay project-wide | **superseded for the board** by R8-3 (member-scoped); queue stays project-wide |
| 11 | — | Run lifecycle enum + pills; raw NDJSON is truth; tokens from real usage envelopes only | in force |
| 12 | — | PR state → pill mapping; sync precedence merged > behind > synced | in force |
| 13 | — | Prefs: derive `ghConnected`, mount Appearance, map plural↔singular once | narrowed (no mailer; one `app` toggle per category) |
| 14 | — | Shared single implementations (notification meta, stripper/renderer, credential card, bell popover); spec copy is a verbatim contract | in force |
| 15 | — | Stages are a per-project list in `project.md` | narrowed (Lightweight preset deleted; Standard 5-stage only) |
| 16 | — | Deliberate keeps + additions (rail count includes Done, `data-screen-label` kept app-wide, Escape/focus-trap/scrim on every dialog, password min 8) | in force |
| 17 | — | PR-divergence recovery: `pr-diverged` trigger, ONE recovery packet, remote-branch deletion only as a packet resolution | in force |
| 18 | — | Minimum GitHub scopes are exactly `repo` + `pull_request:write`; fine-grained proven by dry-run probes | in force |
| 19 | — | Scope chips render **proven verdicts only**; `assumed`/`unchecked` render as an honest "unproven" line | in force |
| 20 | **R15-1** | Acceptance requires a healthy verdict on the delivered revision; audited Force-accept is the only bypass, never of the PR-head check; every accept confirms | in force (+ R16-3) |
| 21 | **R15-2** | Delivery is an operator decision, not a stage side-effect | in force |
| 22 | **R15-3** | Owner authority covers recommendations, including stage moves — the Apply click IS the authorization | in force |
| 23 | **R15-5** | Global ⌘K palette: real workspace-wide search, visibility-scoped | in force |
| 24 | **R15-6** | Per-project delete-branch-on-merge, default on | in force (reverses Q10-07) |
| 25 | **R15-4** | Projects are members-only (404-style for non-members) | in force |
| 26 | **R15-7** | Ghost profiles are fully conservative — no delivery, comments, ask-human or evidence | in force |
| 27 | **R15-8** | `design/prd.md` re-synced with canon; `planning/README.md`'s sync claim must stay true | **holds** (verified byte-identical today) |
| 28 | **R15-9** | An absent `deliver-review-pr` grant resolves from the project's own workflow graph, not a constant | in force |
| 29 | **R15-10** | The first empty board teaches, once | in force |
| 30 | **R15-11** | Review queue stays a triage list; rows say "Review", not "Accept" | in force |
| 31 | **R15-12** | Unenforced capability lines are collapsed, never hidden | in force |
| 32 | **R15-13** | Settings headings name their own scope | in force |
| 33 | **R15-14** | A resolved agent question returns to the AGENT THAT ASKED, by resuming its session (`askedBy`) | in force |
| 34 | **R15-15** | A task owns a PR only if that task opened it; the reconciler never mints a link | in force, **extended by R16-1** |

### 2b. Binding but NOT numbered in `decisions.md`

Every one of these is a recorded owner decision that code still obeys. They are listed because an
agent reading only `decisions.md` will not find them, and several have been re-litigated before.

| pass | id | ruling | recorded in |
|---|---|---|---|
| 1-3 | Q1 | Full-autonomy acceptance needs an **explicit** `completion-for-acceptance: direct`; raising autonomy never confers it | `prd.md:114` |
| 1-3 | Q3 / Q6 / Q7 / Q8 | Anti-noise guardrails are real enforcement, not settings · home is membership-scoped · full per-run workspace isolation · Codex bound by IDLE timeout | recovered pass docs; `comment-guardrails.server.ts` |
| 3 | R-2026-07-12-1 | Clean role tiering: viewer = read + comment only | `app/shared/rbac.ts` |
| 3 | -2 / -4 | Agent eligible stages are real (`stages`/`spanAll`) · honest labeling of Claude-vs-Codex enforcement | code |
| 4 | R-2026-07-12-5…8 | Single-source RBAC + better-auth cutover · operator-vs-boundaries current behavior INTENDED (fix copy) · prune fake toggles · real MCP credential injection | recovered pass docs |
| 6 | R6-1…R6-5 | Stay on main · **owner may accept even as contributor** · project archive read-only enforced · **drag = acceptance** · seeded demo runs removed | recovered |
| 7 | **R7-2** | **DON'T SIMULATE AT ALL** — an unavailable backend must never produce a fake run | recovered; enforced in code |
| 7 | R7-1, R7-4, R7-5, R7-6 | Audited org-admin emergency project authority · operator may transition **backward** on a failing verdict · specialist capability picker is 3 modes · Done tasks stay commentable | recovered |
| 8 | R8-3…R8-7 | "Waiting on you" is member-scoped · reconcile raised to maintainer+ · archived projects freeze credentials · **GitHub↔task divergence: surface, never auto-advance** · manage-members admin-only | recovered |
| gen-agents | G1…G4 | Engagements replace slots (exactly one `delivers: true`) · verdict power is a grant, default off · ask-human/comments are capability-gated · one outcome envelope | recovered |
| 10 | Q10-01…Q10-07 | Keep the autonomy exception, fix copy · verdict authority explicit-only · **revision-bound multi-review** · supporting engagements read-only · logs/transcripts need membership · deterministic operator routing trace · no auto-delete of merged branches (**reversed by R15-6**) | recovered |
| 11 | R-A…R-E | Every stage chain triggers a queued operator run · agents are conversational · **injection guardrails are prompt-level on BOTH backends; do NOT move Codex to workspace-write** · KBs re-index on file change · packet free-text note | `planning/discovery-2026-07-23-pass11/PLAN.md` |
| 12 | R1 / R2 / R3 / NEW-4 | Poller nudges the human to merge · admin **force-accept** exists · `--reset` leak fixed · **agents must @tag the human they answer AND the tag must notify** | `planning/discovery-2026-07-24-pass12/PLAN.md` |
| 13 | 1-4 + D-x / U-2 | Template library with explicit "Add from library" · Lightweight deleted · in-app KB authoring · **web egress is a capability** · transitions auto-wire · repo override deleted · guardrails stay invisible | `planning/discovery-2026-07-24-pass13/` |
| 14 | R14-1…R14-4 | Profile eligibility maps by **stage role** · owner packet authority · real task archive · full KB editor. Plus **LV-01: absent grant = withheld** | `planning/discovery-2026-07-25-pass14/FINDINGS.md` |
| mod | testing policy | Anything serving the app for a test runs on the **production Docker image**; the dev server is banned for browser/e2e/integration/acceptance | `planning/modernization-2026-08-03/PLAN.md:35-46` |
| **16** | **R16-1** | **A pre-existing PR is adopted ONLY IF open AND its head sha equals the task's delivered revision**; name-matched others are a reported collision | `planning/discovery-2026-08-04/FINDINGS.md:5-9` |
| **16** | **R16-2** | `input_required` joins the board's attention predicate; the chip is renamed **"Blocked or waiting"** | same, `:11-13` |
| **16** | **R16-3** | **Terminal GitHub facts outrank process gates** in refusal copy; force-accept is hidden while the PR is closed | same, `:14-15` |
| **16** | **R16-4** | Correctness first, then the full UI/a11y list; nothing deferred out of the pass | same, `:16-17` |
| **16** | **R16-5** | **MCP stays outside the capability matrix** — granting a server IS the grant; a withheld `execute-code-or-write-repo` does not bound a granted server's tools | same, `:18-23` |
| **16** | **R16-6** | **Merge stays human-only**; the merge-pending and closed-PR states must be visible where the task is (card + queue), not only on the detail page | same, `:24-28` |
| **16** | **R16-7** | `codex/gpt-5-6-sol-agents` deleted (tip `461d34ab` if ever wanted) | same, `:29-31` |

---

## 3. Canon vs the current app — verified 2026-08-04

Everything below was re-checked in this tree after the pass-16 waves. Deltas pass 16 opened and
its waves closed are in §3c so nobody re-files them.

### 3a. Open deltas

Marked **[deliberate]** where a ruling covers the behavior and only the *record* is wrong, or
**[owner]** where the product decision itself is unresolved.

| # | delta | evidence | disposition |
|---|---|---|---|
| **D1** | **Pass-16's rulings are not in the canon.** `decisions.md` still ends at ruling 34 (R15-15); pass 16 changed **zero** files under `docs/`, `planning/planning-artifacts/` or `design/`. Meanwhile ~30 code sites cite "R16-x (owner ruling, 2026-08-04)" as if it were citable. | ruling 34 at `docs/architecture/decisions.md:276-283` is the last one; `git diff --name-only b557060 HEAD -- docs/ planning/planning-artifacts/` is empty; citations at `app/features/board/board-filters.ts:44`, `app/features/review/review-helpers.ts:50`, `app/server/github/pr-adoption.server.ts:4`, `app/server/tasks/task-actions.server.ts:3511, :4647`, `app/features/agents/capability-matrix-modal.tsx:230`, … | **[owner]** — this is D-17's exact failure mode (*"a ruling nobody can read is a ruling that gets reversed"*) and pass-15's unanswered Q9. → **Q17-1** |
| **D2** | `decisions.md` ruling 7 says *"the kind set is now **eight**"*; there are **nine** — `archive_task` was added by ruling 17 and ruling 7 was never updated. | `docs/architecture/decisions.md:151-153` vs `app/schemas/task-file.schema.ts:62-83` | **[deliberate]** doc fix. Carried unfixed from pass 16 b5. |
| **D3** | `decisions.md`'s route map omits four live routes: `/projects`, `/prefs/theme`, `/notifications/read`, and `/resources/search` — the last being the ⌘K endpoint R15-5 exists for. | `docs/architecture/decisions.md:287-297` vs `app/routes.ts:19-39` | **[deliberate]** doc fix. |
| **D4** | `docs/architecture/file-formats.md` — the MUST-language schema contract for hand-written store files — still teaches `role: admin｜maintainer｜**reviewer**｜viewer` (renamed *contributor* by the ruling-2 amendment) and `requiredScopes: [repo, **workflow**, **read:org**, pull_request:write]` (two dropped by ruling 18). | `docs/architecture/file-formats.md:79, :91` | **[deliberate]** doc fix; direct-store editing is a supported input path (FR10). |
| **D5** | `docs/operations/deployment.md` justifies the WAL-sidecar backup rule with *"the app does not currently close the database or checkpoint on shutdown"* — false since P13-D-43; `armProcessShutdown()` runs at boot. | `docs/operations/deployment.md:177` vs `app/server/boot.server.ts` | **[deliberate]** doc fix. The instruction is still right; its stated reason is not, which is how a future pass deletes the step. |
| **D6** | `docs/operations/runbook.md` still describes *"the native recursive file watcher (250 ms debounce)"*; it has been chokidar 5 since modernization A1. | `docs/operations/runbook.md:31` | **[deliberate]** doc fix. |
| **D7** | Retention: the runbook table and FR33 both say audit rows are gone at 90 days flat. Two action kinds are **exempt** because boot recovery uses them as idempotency keys — deleting them makes the next boot redo the work. | `app/server/db/retention.server.ts:26-45` vs `docs/operations/runbook.md:98-115` and `prd.md:257` | **[deliberate]** — the code is right and well-argued. FR33 + runbook need the two names. → folded into **Q17-6** |
| **D8** | `docs/testing.md` says the e2e suite *"runs Playwright against a real dev server"* with `e2e/.tmp-data`. The owner's own modernization amendment **banned the dev server** for e2e; the suite drives the production image in an isolated Compose stack. | `docs/testing.md:26-32` vs `planning/modernization-2026-08-03/PLAN.md:35-46` | **[deliberate]** doc fix — the most misleading of the four, because it contradicts an owner ruling. |
| **D9** | **Vocabulary split.** PRD FR14/FR20 and the MVP bullet still say *"primary specialist and additional consultant specialists"*; the product has shipped **engagements** (`engagements[]`, exactly one `delivers: true`, *supporting engagement*, *required reviewer*) since 2026-07-19. `qa/pass15/GLOSSARY.md` defines Specialist and **not** Engagement, so the two canonical vocabularies disagree with each other too. | `prd.md:73, :178, :225, :234` vs `app/schemas/task-file.schema.ts`; `qa/pass15/GLOSSARY.md` | **[owner]** → **Q17-5**. Every future FR14 audit re-derives this as false drift. |
| **D10** | `architecture.md` states *"OAuth callbacks are isolated to `app/routes/auth.callback.*.tsx`"* — no such route exists; better-auth handles callbacks through the `api/auth/*` splat. | `planning/planning-artifacts/architecture.md:812` vs `app/routes.ts:13`, `app/routes/api.auth.$.ts` | **[deliberate]** doc fix. |
| **D11** | `planning/README.md` says *"completed discovery passes and generated handoff ledgers are not retained here"* — the tree retains six of them (pass 11-15, pass 16, modernization), and the README lists neither pass 16 nor this pass. R15-8 requires the README's claims to stay true. | `planning/README.md:21-24` vs `ls planning/` | **[deliberate]** doc fix. |
| **D12** | **R16-5 has no canon record.** The PRD reads as if every agent action is capability-bounded (FR8, NFR8 *"separate permission boundaries … on every governed action"*, and the risk mitigation *"agents overreach → explicit agent capability policy"*). The ruled reality: an MCP server's tools are outside the matrix, so an org MCP server with write powers is reachable by an agent whose `execute-code-or-write-repo` is withheld. Today this is stated only in a UI disclosure, a test that pins the absence of an `mcp__*` deny rule, and FINDINGS. | `prd.md:216, :276, :131`; `app/features/agents/capability-matrix-modal.tsx:230`; `app/server/tasks/specialist-tool-policy.test.ts:290-292` | **[owner]** → **Q17-2** |
| **D13** | **"Done" means two things by preset, and the canon says neither.** `decisions.md` ruling 7 states flatly *"Accept-completion triggers a real async PR merge"*; under a full-autonomy operator accept **no merge is attempted at all** — the PR is recorded `accepted` / merge pending and a human merges it. FR27's exception text says the operator *"accepts and closes the task itself"* with no mention of the pending merge. | `app/server/tasks/operator-actions.server.ts:2034-2054`; `app/shared/capabilities.ts:162-166`; `decisions.md:150`; `prd.md:245` | **[owner]** — R16-6 ruled the *behavior*; the canon text is still wrong either way. → **Q17-3** |
| **D14** | **R16-1's residual.** The rule stops new foreign-PR adoptions; it does not un-adopt one bound before the rule. The reconciler treats a discovery matching the cached number as an owned link and keeps its live facts — correct in general, but a pre-rule task (VIB-4 in the dev root) still carries a foreign merged PR in its `task.md`. | `app/server/github/github-reconciler.server.ts:~288`; `planning/discovery-2026-08-04/FINDINGS.md:246-253` | **[owner]** — needs a rule for *when Viberr may drop a PR reference it once wrote*. → **Q17-4** |
| **D15** | NFR15 (*"references must remain uniquely traceable to the originating task key"*) is exactly what R15-15/R16-1 defend, but the PRD never records the fact that made both necessary: **a task-key branch is not a unique identifier** — keys restart at 1 on a new data root. | `prd.md:289`; `app/server/github/pr-adoption.server.ts:6-18` | **[deliberate]** one-sentence PRD note; cheap insurance against a future "simplification" back to name matching. |
| **D16** | **NFR14** requires GitHub failures surfaced within 10 s *of detection*; detection is a 5-minute poll with per-project budget and cursor rotation. No webhooks anywhere. Nothing has ever argued the difference. | `prd.md:288`; `app/server/github/reconcile-poller.server.ts:22` | **[owner]**, carried → **Q17-7** |
| **D17** | **NFR1-NFR4 have never been measured**, in any pass. The board query has no `LIMIT` and no virtualization — it loads every task in the project. Every live instance has been ≤10 tasks. NFR5 is architecturally satisfied (30-event timeline slices, `?since=` log paging) but unverified on a long task. | `prd.md:266-270`; `app/server/projections/board-query.server.ts` (no LIMIT) | **[owner]**, carried → **Q17-8** |
| **D18** | **Continuity Recovery Panel** — the fifth named UX component and the surface Journey 4 is written around — does not exist. The *mechanism* does (`session_missing` as a first-class failure class, probe-before-resume, retry-as-fresh with a re-anchor preamble); the user-facing surface is a run pill reading **"continuity error"**. Continuity is also not a board filter, though the spec asks for degraded continuity as a first-class triage state. | `ux-design-specification.md:655-664, :734, :847`; `prd.md:87`; only hits are `app/features/runtime/runs-helpers.ts:20`, `runs-panels.tsx:461`; `BoardFilterId = all｜human｜agent｜risk｜archived` | **[owner]**, carried → **Q17-9** |
| **D19** | UX spec asks the Task Status Card to *"support keyboard navigation across board lanes"*. There is no lane traversal; modernization A2 deliberately did **not** add keyboard drag, leaving the StageMenu as the accessible move path (which moves a card but is not traversal). The omission is reasoned, but it lives in an implementation note, not in the spec. | `ux-design-specification.md:620`; `planning/modernization-2026-08-03/IMPLEMENTATION.md:51-53`; one `onKeyDown` in `app/features/board/board-page.tsx:628` | **[owner]** — build it or amend the spec → **Q17-10** |
| **D20** | **UI-18**, the longest-standing deferral in the project: `data-screen-label` now appears **37 times** with exactly **one** consumer (a test selector). Ruling 16 lists keeping it app-wide as a deliberate keep, so it cannot simply be swept without contradicting a ruling. | 37 occurrences under `app/`; sole consumer `app/features/task-detail/task-disposition.test.tsx:162, :178` | **[deliberate]** by ruling 16 — but the deferral should be closed as *kept, with a stated purpose* rather than re-listed every pass. |
| **D21** | **Audit export** (FR33 residue) is Phase 2. Org/auth-scoped rows (`auth.login.*`, `org.user.*`, `org.connection.token_replaced`, `github.pat.*`) have no file counterpart and are genuinely gone at 90 days; none of the windows is env-configurable. | `prd.md:257`; `app/server/db/retention.server.ts` | **[owner]**, carried → folded into **Q17-6** |
| **D22** | **Phase-2 scope is absent, correctly**: throughput/governance-load analytics, task-graph + subtasks, deeper validation workflows, org-level audit console. Listed so an audit against the PRD alone does not read absence as drift. | `prd.md:190` | **[deliberate]** — not a delta |

### 3b. What did NOT drift (checked, so it isn't re-checked)

- `design/prd.md` ≡ canon PRD, byte for byte (R15-8 holds).
- The "govern/governance" copy ban holds in rendered strings.
- No `--viberr-*` token exists anywhere; the token layer is unprefixed.
- No root `AGENTS.md`; the `codex/gpt-5-6-sol-agents` branch is gone locally and from `origin`
  (R16-7 executed).
- `merge-pull-request`, `transition-to-done`, `change-project-policy` are still the three
  `ALWAYS_HUMAN` capability ids (`app/shared/capabilities.ts:162-166`).
- The task store path and the "UI shows the real store path" rule (ruling 3) are intact.
- Deployment's TLS boundary is explicit and documented — NFR6 is satisfied by the reverse proxy,
  not by the Node process (`docs/operations/deployment.md:36-47`). Not a delta.

### 3c. Closed by pass 16 — do not re-file

| pass-16 id | was | now |
|---|---|---|
| b1 / G1 / H12 | `input_required` missing from the board's attention predicate; a test pinned the opposite | fixed under **R16-2**; predicate covers it and the chip reads "Blocked or waiting" (`board-filters.ts:40-58`) |
| b2 / G2 / H10 | Review queue named the process gate over a closed PR and offered a force-accept the task page withheld | fixed under **R16-3** (`review-helpers.ts:50-65`; `task-actions.server.ts:4647`) |
| b3 / G3 | Home's ⌘K unreachable below 1080px | reclassified as a defect and fixed — Home has a real `button.kbd`; the hide rule is scoped to the topbar chip (`app/app.css:2835-2840`), with 375px e2e coverage |
| A2 | `acceptancePrHeadMismatch` bypassable on 2 of 4 Done writers | one shared gate, plus an in-lock `assertVerifiedHeadStillApplies` re-check (`task-actions.server.ts:4696-4752`) |
| H8 | Foreign merged PR adopted by branch name | **R16-1** — `app/server/github/pr-adoption.server.ts`, refusals typed (`not_open` / `no_revision` / `head_unknown` / `head_mismatch`) |
| E1 | Policy page and the task Permissions panel claimed view/comment were app-wide while enforcement 404'd non-members | display now states membership; pinned by test |
| A4 | Undeployed operator could still deliver | `deliverGate` denies when `!authority.deployed` (`operator-actions.server.ts:277, :301-326`) |
| b11 / G4 | Dangling `codex/gpt-5-6-sol-agents` branch | deleted under **R16-7** |
| F17 / H15 | Seeded profiles said "customized for Viberr Core" (a mock literal) | seeded profiles now say `Global base` |

The pass-16 **disposition audit** is the method worth keeping: after the waves, seven agents
re-derived every backlog item's state from the tree and found **11 "done" items were partial** —
including three of four call sites routed correctly, half of a two-part fix landed, and a file
split that had grown instead. Do that again before this pass claims anything is closed.

---

## 4. Open questions for the owner

Ordered by cost of leaving them open.

**Q17-1 — Do R16-1…R16-7 get `decisions.md` numbers, and what is the standing rule?**
Pass 16 produced seven rulings, cited them in ~30 code sites as *"owner ruling"*, and amended no
canon file. Pass 15's Q9 asked exactly this and was never answered. *Decision:* (a) promote all
seven to rulings 35-41 now and make "promote this pass's rulings" a required closing step, or
(b) define the threshold — e.g. *only rulings a code comment cites get a number* — and enforce it
mechanically (a test that greps for `R\d+-\d+` citations with no `decisions.md` entry would make
the rule self-checking).

**Q17-2 — Does R16-5 (MCP outside the capability matrix) get a canon record, and does the
consequence need a bound?**
The ruling is settled: Viberr will not pretend to bound a third-party tool, so granting a server
IS the grant. But FR8/NFR8 and the PRD's own overreach mitigation read as though every agent
action is capability-gated, and an org MCP server with write powers is reachable by an agent whose
`execute-code-or-write-repo` is deliberately withheld. *Decision:* record it as a PRD/NFR8
amendment note (cheap, closes the honesty gap), and separately: should an MCP server carry a
`writes: true` flag that a project may refuse, or is per-profile grant the whole story forever?

**Q17-3 — Is human-attributed merge a permanent invariant?** (carries pass-15/16 Q12)
`merge-pull-request` stays `ALWAYS_HUMAN` (R16-6), so a full-autonomy operator's "Done" means
*accepted, merge pending* while a human's "Done" means merged. R16-6 made the state visible on the
card; it did not decide whether the divergence is permanent. Meanwhile `decisions.md` ruling 7
still asserts acceptance triggers a real merge, which is false on the autonomous path.
*Decision:* keep merge human-forever (and fix ruling 7 + FR27's wording to say so), or let a
project that already granted `completion-for-acceptance: direct` grant an equally explicit
`merge-pull-request: direct`.

**Q17-4 — When may Viberr drop a PR reference it once wrote?**
R16-1 prevents new foreign adoptions but cannot un-adopt pre-rule ones; a task can still carry a
foreign merged PR with a green badge. The product's escape hatch is the operator's branch-collision
packet plus `archive_task(+deleteBranch)`. *Decision:* define a self-heal rule (e.g. *on
reconcile, if a cached PR's head has never contained any revision this task delivered, demote the
link to a divergence and notify*), or declare the packet the only path and document that a
pre-rule binding is repaired by hand.

**Q17-5 — Does the PRD's vocabulary get re-synced to the product's?**
FR14/FR20 say "consultant specialists"; the product says engagements / delivering engagement /
supporting engagement / required reviewer, and `qa/pass15/GLOSSARY.md` defines neither consistently.
*Decision:* amend FR14+FR20+the MVP bullet+the glossary to the engagement model, or declare
"specialist" the user-facing word and remove "engagement" from rendered copy. Leaving it costs one
false-drift finding per audit, forever.

**Q17-6 — Retention: name the exemptions, and/or move export up.**
Two audit actions are exempt from the 90-day delete because boot recovery uses them as idempotency
keys, and neither FR33 nor the runbook says so. Org/auth rows still have no file counterpart and no
export. *Decision:* (a) amend FR33 + the runbook to name the two exempt actions — cheap, closes the
honesty gap today; and separately (b) make the windows env-configurable, or (c) move export out of
Phase 2.

**Q17-7 — NFR14 vs the polling model.** (carried)
"Within 10 seconds of detection" against a 5-minute poll with cursor rotation. *Decision:* amend
NFR14 to state the detection cadence explicitly, or put webhook detection on the roadmap — noting
webhooks need a public ingress the current single-node reverse-proxy story does not assume.

**Q17-8 — Measure NFR1-NFR4, or replace them with the observed envelope?** (carried)
Never measured; no `LIMIT`, no virtualization on the board query. *Decision:* fund one pass that
builds a 200-task project and measures the four numbers (adding virtualization only if it fails),
or amend them to the small-team envelope the product actually targets and stop asserting untested
numbers. The PRD's own success criteria lean on "feels immediate", not the numbers.

**Q17-9 — Continuity Recovery Panel: build it, or retire it from the spec?** (carried)
The only one of five named components that does not exist, and the one Journey 4 is written around.
The mechanism is solid; the surface that says *what is known / what is missing / what remains
authoritative / how to continue safely* is a run pill reading "continuity error". *Decision:*
schedule the panel (with continuity as a board triage state, per `ux-design-specification.md:847`),
or amend the spec to record that the typed failure class plus the canonical task file IS the
recovery affordance.

**Q17-10 — Board keyboard traversal: build, or amend the spec?**
The spec asks for keyboard navigation across board lanes; modernization deliberately shipped the
StageMenu instead of keyboard drag, and that reasoning lives in an implementation note. *Decision:*
add lane traversal (arrow keys across columns, independent of drag), or amend
`ux-design-specification.md:620` to record the StageMenu as the accessible path — the second is
consistent with A2's a11y reasoning and costs nothing.

**Q17-11 — Who owns `docs/` canon, and when?** (carried, and now measurable)
Six verified stale statements sit in four operational docs today (D3-D6, D8, D10), every one
introduced by a *correct* change elsewhere, and none of them was touched by pass 16. *Decision:*
make "docs canon re-read" a required closing phase of every pass (like the ledger audit), or stamp
each operational doc with a "last verified" date so a reader can discount it.

---

## 5. Pointer index

| what | where |
|---|---|
| Requirements, journeys, NFRs, amendment notes | `planning/planning-artifacts/prd.md` |
| Layering, readiness model, auth, boundaries, directory map | `planning/planning-artifacts/architecture.md` |
| Principles, components, states, responsive ruling | `planning/planning-artifacts/ux-design-specification.md` |
| The 34 citable rulings + route map + conventions | `docs/architecture/decisions.md` |
| Pass-16 long-form intent map, evolution ledger, recovered rulings | `planning/discovery-2026-08-04/PRODUCT-INTENT.md` |
| Pass-16 backlog, R16-1…R16-7, live findings, disposition ledger | `planning/discovery-2026-08-04/FINDINGS.md` |
| Pass-16 implementation notes (what "partial" meant) | `planning/discovery-2026-08-04/IMPLEMENTATION.md` |
| Modernization scope + the testing-policy amendment | `planning/modernization-2026-08-03/PLAN.md`, `IMPLEMENTATION.md` |
| Store file schemas (MUST language) | `docs/architecture/file-formats.md` |
| Deployment, retention, recovery runbooks | `docs/operations/deployment.md`, `docs/operations/runbook.md` |
| RBAC single source | `app/shared/rbac.ts` |
| Capability catalog + `ALWAYS_HUMAN` | `app/shared/capabilities.ts` |
| Task-file schema (engagements, packet kinds, workRevision) | `app/schemas/task-file.schema.ts` |
| Operator toolkit / authority gates | `app/server/tasks/operator-toolkit.server.ts`, `operator-actions.server.ts` |
| Acceptance gates | `app/server/tasks/task-actions.server.ts:4640-4760` |
| PR adoption rule (R16-1) | `app/server/github/pr-adoption.server.ts` |
| Board filter predicate (R16-2) | `app/features/board/board-filters.ts` |
| Design tokens (the only stylesheet) | `app/app.css` |
