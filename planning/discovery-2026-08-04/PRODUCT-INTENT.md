# Viberr — product intent reference (2026-08-04)

Reconciles the ORIGINAL intent (PRD / UX spec / architecture / design mock) with the CURRENT
state of `main` @ `2442945`. Written for two readers: an implementation agent about to change
product behavior, and the owner making decisions against §4 and §5.

**Read §0 before treating any older document as an instruction.**

Supersedes `planning/discovery-2026-07-28-pass15/docs/product-intent.md` (pass-15 map). That
document's eight open questions are dispositioned in §2.16.

---

## 0. Precedence, and how to read this

The canon order is declared in `planning/README.md:3-17` and holds:

1. **The three living docs** — `planning/planning-artifacts/prd.md`,
   `architecture.md`, `ux-design-specification.md`. When the app and a doc disagree and the
   app is right, **the doc is amended with a dated note**, not the app "fixed" back
   (`planning/README.md:9-11`). Read a requirement's amendment notes before treating it as
   an instruction.
2. **`docs/architecture/decisions.md`** — the normative contract that code comments cite as
   *CONVENTIONS* and *"orchestrator ruling N"*. It condenses `architecture.md`, **which wins
   on conflict** (`docs/architecture/decisions.md:1-6`). Recovered from a deleted
   `docs/build/CONVENTIONS.md` after 26 code comments were left citing a file that no longer
   existed (`decisions.md:8-14`). **34 numbered rulings** today.
   *Superseded rulings are kept and marked, never deleted: "Never restore a superseded rule
   because you found the ruling text" (`decisions.md:16-20`).*
3. **`design/`** — build inputs, not canon: the HTML mock, the design system, and a copy of
   the PRD. As of R15-8 the design PRD copy is **byte-identical** to canon (both 295 lines,
   md5 `783177bcdfd0c7e359adeb500b7d2bd5`). `design/CONVERSATION-SUMMARY.md` is mock build
   history — including a list of things the owner rejected in design iteration, which is still
   binding as *"don't re-add this"*.
4. **The code and test suite** — the only proof of behavior. 207 test files / 2478 unit tests,
   41 e2e against the production Docker image.

A caveat this document exists to enforce: **passes 1–10's planning folders were deleted**
(commits `371c141`, `c1acf2c`, 2026-07-22). Their rulings survive only in `decisions.md`, in
code comments, and in git. §2 recovers the load-bearing ones by `git show`, with the paths to
re-recover them.

---

## 1. Original vision

### 1.1 The product in one paragraph

Viberr is a multi-user web application for **governed AI software delivery** for small
AI-forward engineering teams (`prd.md:38-46`). It closes a coordination gap: coding agents are
improving fast, but task systems remain human-native and give multi-agent work no durable
operating layer. **The task file is the canonical operating contract** between humans, agents,
and GitHub execution — state, execution context, timeline, decisions, evidence in one readable
markdown file. A dedicated **operator agent** manages each active task, **specialist agent
threads** do the stage work, and humans govern through policy, comments, decisions, and
explicit acceptance of completion. V1 targets single-repo GitHub-backed delivery through a
familiar board/task interface that behaves differently underneath: *agents are the native
workers, engineers govern the flow, review stays human-authorized* (`prd.md:44-46`).

### 1.2 Pillars / non-negotiable invariants

Distilled from `prd.md`, `architecture.md`, and the (recovered) 2026-07-10 product-intent doc
(`git show 371c141^:planning/discovery-2026-07-10/product-intent.md`):

1. **Files are canonical truth.** SQLite is a rebuildable projection for *task/project* state.
   Malformed input degrades to diagnostics + a readiness downgrade, never a crash, never a
   silent drop (`architecture.md:109-118, 279-281`; `decisions.md:75-80`).
   *Corrected 2026-07-25 (`architecture.md:801`):* `state/projection.sqlite` is **not a cache**
   — it is the only home of users, sessions, audit, notifications, sealed PATs, org resources
   and run history. The derived/canonical split is **per-table, not per-file**.
2. **Human-only Done.** Transition to Done and completion acceptance are human, enforced
   server-side. One deliberate exception (owner ruling Q1): a project at `full` autonomy whose
   operator holds an explicit `completion-for-acceptance: direct` grant may accept and close
   the task itself — audited, disclosed in the UI, never implied by raising autonomy
   (`prd.md:114`, FR27 `prd.md:245`, `decisions.md:91-95`).
3. **Two permission systems, kept separate.** Human RBAC (project roles) and agent capability
   policy (`direct | recommend | human | off`) are different problems with different surfaces
   (`prd.md:110-114`; `decisions.md:125-137`). `ALWAYS_HUMAN`: merge PR, transition to Done,
   change project policy.
4. **Typed events over chatter.** Important events (quality, transition, blocked, completion,
   policy) are first-class. The PRD names **timeline noise the #1 adoption risk**, so the five
   anti-noise guardrails are product features, not decoration (`prd.md:154, 188`).
5. **Re-anchor rule.** Any reactivated agent re-anchors on the canonical task file before
   acting; provider-history loss degrades gracefully (`prd.md:116-120`, Journey 4 `prd.md:87`).
6. **Traceability.** task key ↔ branch ↔ commits ↔ PR stays unambiguous (NFR15 `prd.md:289`).
7. **Idempotency.** Retries never duplicate transitions, branch records, PR associations or
   events (NFR16 `prd.md:290`; `decisions.md:82-83`).
8. **Secrets never reach task-visible artifacts** — files under `projects/`, comments, audit,
   logs, SSE payloads, error messages (NFR7 `prd.md:275`; `decisions.md:87-88`).

### 1.3 Target users, core loops

Four personas drive the journeys (`prd.md:79-98`):

| persona | journey | the loop it defines |
|---|---|---|
| **Arda** (senior engineer) | supervision (primary success path) | scan board → spot what needs a human → open task → understand state in seconds → act |
| **Arda intervening** | drifted task (primary edge case) | board flips to waiting-on-human + unhealthy validation → typed blocking packet → pick a recovery path → operator re-engages the specialist |
| **Elif** (workflow owner / admin) | configure a governed project | stages, transitions, boundaries, default repo, human RBAC **and** the agent capability matrix, separately |
| **Murat** (escalation) | continuity failure | provider history is gone → operator surfaced the warning and rehydrated from `task.md` → confirm it holds enough context → drop to the provider thread only as a debug session |

Success criteria that bind (`prd.md:63-69`): ≥90% of active tasks show an unambiguous current
owner / waiting state / latest decision packet; ≥90% of executed tasks keep task↔branch↔commit↔PR
traceability; blocked tasks reach a human decision quickly because packets are concise;
readability holds on long tasks.

### 1.4 The requirement map (as originally numbered)

All in `prd.md`. Amendment dates are the important part.

- **Workspace & collaboration** FR1–FR4 (`:204-207`), FR37 task owner (`:208`), FR38
  self-service ownership (`:209`).
- **Governance & policy** FR5–FR9 (`:213-217`).
- **Task records & lifecycle** FR10–FR17 (`:221-228`).
- **Orchestration & continuity** FR18–FR23 (`:232-237`), FR39 scheduled operator re-runs
  (`:238`, added 2026-07-25 to record shipped behavior).
- **Oversight** FR24–FR28 (`:242-246`).
- **GitHub** FR29–FR32 (`:250-253`).
- **Integrity / audit / recovery** FR33–FR36 (`:257-260`).
- **NFR1–NFR18** (`:266-295`): board ≤2s at 200 cards, task detail ≤2s, action reflect ≤3s,
  propagation ≤5s, no full-history client load, encryption in transit, secret isolation, dual
  permission boundaries, least privilege, security audit, restart consistency, continuity
  grace, non-corrupting rescan, GitHub failures surfaced ≤10s of detection, unique
  traceability, idempotent external actions, identity continuity or explicit failure, durable
  audit (bounded per FR33).

Scope phases: **MVP** `prd.md:171-188` · **Phase 2** (richer profile templates, analytics on
throughput/governance load, deeper validation, collaboration ergonomics, task-graph + subtasks,
audit export) `prd.md:190` · **Phase 3** (org rollout, advanced policy, more backends,
enterprise deployment) `prd.md:192`.

### 1.5 UX spec — what it asked for

Five experience principles (`ux-design-specification.md:101-107`): *status before history ·
decisions before discussion · human attention is scarce · calm over chatter · one task, one
truth.* Five emotional principles (`:149-155`): *clarity creates trust · calm beats excitement ·
intervention should feel powerful · serious, not sterile · confidence is cumulative.*

Chosen design direction (`:417-423`): **Signal Console for the board** (triage-first, high-signal
cards) + **Operator Desk for the task page** (current state, execution truth, latest packet,
steering actions above timeline depth). Split-view is explicitly a secondary pattern.

Five named custom components (`:611-664`): **Task Status Card**, **Decision Packet**, **Execution
Truth Strip**, **Mixed Timeline Item**, **Continuity Recovery Panel** — phased 1/2/3 at `:693-713`.

Four canonical state categories (`:721-729`): `ready`, `input_required`,
`inconsistency_risk_detected`, `blocked`, plus the secondary signals *waiting on human / waiting
on agent / degraded continuity*. Pattern rule: **"Input gaps, inconsistency risk, blocked
conditions, and continuity degradation must not collapse into a single generic 'error'
treatment"** (`:734`).

Three sections of this spec are **marked superseded in place** by the shipped design system:
palette (`:348`), typography (`:373`), spacing/12-column grid (`:381`). The *principles* in each
still bind — color never operates alone, mono used intentionally, spacing reinforces hierarchy,
urgent states get clearer rather than louder.

### 1.6 The design language (the real one)

`design/design-system.html` is the shipped visual canon; `app/app.css` `:root` is the single
source of the actual tokens.

- **There is no `--viberr-*` prefix.** `grep -rn -- '--viberr-'` over `app/` and `design/`
  returns nothing. Tokens are unprefixed: `--bg --surface --fg --muted --faint --placeholder
  --border --ring --hairline --blue --blue-pressed --blue-soft --cta-bg --cta-fg --success
  --coral-light/dark --rose-light --teal-light/dark --orange-light --yellow-dark --red-light
  --agent --agent-dark --agent-soft --font-display/body/mono --shadow-ring/card/pop --ease-out
  --radius-button/chip/card/panel --rail-w --topbar-h --pin-star`.
  Any doc or memory referring to "`--viberr-*` tokens" — including
  `planning/modernization-2026-08-03/PLAN.md:28` — names something that does not exist. The
  *discipline* is real; the name is wrong.
- **Palette:** bright Miro-inspired white canvas, `#5b76fe` blue as the primary action, pastel
  semantic pairs (light surface + dark text so they invert together), a **violet `#7b61ff`
  agent-identity family distinct from human blue**. "Blue is the primary action. Teal means
  ready or healthy. Orange and red require human review."
- **Typography:** display = Manrope (Roobert PRO is not web-available;
  `app/app.css:2723-2726` is the shipped override), body = Noto Sans, mono = JetBrains Mono for
  keys / branches / evidence / task ids. The whole app lives in a compressed sub-1rem type band.
- **Radius:** button 8 · chip 999 · card 16 · panel 22. *"Tight controls inside roomy panels."*
- **Spacing has no tokens.** Hand-tuned rem values per component. Match the surrounding
  component's rhythm; do not introduce a scale now (`ux-design-specification.md:381`).
- **Dark theme is a pure token swap** at `app/app.css:2193` (`:root[data-theme="dark"]`).
- **`var(--x)` that is not defined in `:root` is a bug, not a style choice**
  (`decisions.md:106`). A recurring historical defect class (P13-D-18): rules written against
  `--mono`, `--coral`, `--font-sans`, `--link`, `--accent`, `--surface-2`, `--ink`, `--teal`,
  `--panel-2` — none of which existed — silently falling back and rendering wrong.

### 1.7 Where the paper trail starts and stops

`prd.md:16-19` records that the product brief, its distillate and the 2026-03-29 brainstorming
session were consumed into the PRD and their copies deleted; the PRD is self-standing. There is
no earlier artifact in the tree. `planning/planning-artifacts/` also once held `epics.md`, two
implementation-readiness reports, a sprint-change proposal and `ux-design-directions.html` —
all deleted in `c1acf2c` and recoverable only by `git show`.

---

## 2. Evolution ledger

Chronological. Everything here is a recorded owner decision or a recorded reconciliation.

### 2.0 Where the records live

| pass | dir | status |
|---|---|---|
| 1–3 (07-10…07-12) | `planning/discovery-2026-07-10 / -07-11 / -07-12` | **deleted** — `git show 371c141^:<path>` |
| 4 (07-12) | `planning/discovery-2026-07-12-pass4` | **deleted** — same |
| 5 (07-13, code review) | never in `planning/` | memory + branch `codex/e2e-product-hardening-2026-07-13` (reference-only per R6-1) |
| 6 (07-16) | `planning/discovery-2026-07-16` | **deleted** |
| 7 (07-16) | `planning/discovery-2026-07-16-pass7` | **deleted** |
| 8 (07-17) | `planning/discovery-2026-07-17` | **deleted** |
| generic-agents + 9 + 10 (07-19) | `-07-19-generic-agents`, `-pass9`, `-pass10` | **deleted** — `git show c1acf2c^:<path>` |
| 11 (07-23) | `planning/discovery-2026-07-23-pass11` | present |
| 12 (07-24) | `planning/discovery-2026-07-24-pass12` | present |
| 13 (07-24/25) | `planning/discovery-2026-07-24-pass13` | present (incl. the 90 KB `INTENT-VS-IMPLEMENTATION.md`) |
| 14 (07-25) | `planning/discovery-2026-07-25-pass14` | present |
| 15 (07-28/29) | `planning/discovery-2026-07-28-pass15` | present |
| modernization (08-03) | `planning/modernization-2026-08-03` | present |

### 2.1 Pre-build and design iteration (2026-03-30 → 2026-07-04)

- Scope simplified 2026-06-08; **reviewer & commenting amendments FR4 / FR14 / FR37 / FR38**
  landed 2026-07-04 (`prd.md:36`).
- **"govern / governor / governance" is BANNED in product UI copy** — use *Maintainer*,
  *Permissions*, "managed" (`design/CONVERSATION-SUMMARY.md:23`). Verified still held: every
  occurrence of "govern*" under `app/features`, `app/routes`, `app/ui` is in comments or
  identifiers, none in rendered strings.
- **Agent-vs-human identity split**: agents get an angular clip-path glyph in violet (Codex =
  cpu, Claude = sparkle), humans get round blue avatars; "waiting on you" is blue, "agent
  working" is a violet pulse (`design/CONVERSATION-SUMMARY.md:19`).
- PAT-only GitHub auth (no GitHub App); whitelist OAuth (no invites, no self-signup); no email
  notifications; popups/overlays over separate pages for profile, notifications, connection and
  resource editing (`design/CONVERSATION-SUMMARY.md:184-190`).
- A standing **rejection list** to respect: no Duplicate-profile button, no AGENTS.md
  preview/generator, no field-explainer notes, no quality-gate panel, no "Sessions & security"
  panel, no notification-routing side panel, no RBAC legend footnote, no colored card
  accents/shadows, no live/SSE topbar indicator, no addressee toggle buttons (mentions only).

### 2.2 Passes 1–3 (2026-07-10 → 07-12) — recovered

From `git show 371c141^:planning/discovery-2026-07-10/product-intent.md` and
`…/discovery-2026-07-12/owner-rulings.md`:

- **Advisor/consultant profile REMOVED** (decision A). The operator absorbs advisory duties via
  packets; the reviewer covers quality. Tester later merged into Reviewer (D1).
- **Disk is truth for skills/KB/MCP** (decision C-sweep); org settings lists every disk dir via
  `buildResourceCatalog`, metadata layered from the table.
- **Operator "Plan:" comments folded into the action comment** — one timeline entry per operator
  turn (decision E).
- **Policy presets wired to real governance** (S1): `strict` human-gates the pre-work
  boundaries, `auto` runs the operator at full autonomy, review→done stays human-locked in all.
- **Q1 acceptance requires explicit `direct`** — full autonomy promotes other
  recommend-capabilities but `completion-for-acceptance` acts only at explicit `direct`.
- **Q3 anti-noise guardrails are REAL** — enforced on the canonical record
  (`comment-guardrails.server.ts`), not settings decoration.
- **Q6 home is membership-scoped** · **Q7 full workspace isolation** (per-run
  `GIT_CEILING_DIRECTORIES`) · **Q8 Codex runs bound by IDLE timeout, not wall clock**.
- **Honest empty slate (2026-07-12)** — the seed ships no fabricated credentials or health.
- **R-2026-07-12-1 · Q5 CLEAN TIERING**: viewer = strictly read + comment. Contributor adds
  create-task, take/release own ownership, owner-resolve of non-completion packets.
  *"The old 'viewer can own a task' behavior is gone — names now mean what they say."*
- **R-2026-07-12-2 · agent eligible stages: WIRE IT** — `stages`/`spanAll` become real.
- **R-2026-07-12-3 · review queue + Activity membership-gated**; board/task stay app-wide
  readable (later reversed by R15-4).
- **R-2026-07-12-4 · S3 honest labeling only** — capability modal marks tool-denial caps
  "enforced on Claude · advisory on Codex"; no Codex enforcement that pass.
- **F11 (critical)**: the `edit-other-task-branch` capability's broad git deny had silently
  blocked every Claude specialist from creating its own task branch. Removed.

### 2.3 Pass 4 (2026-07-12) — recovered

`git show 371c141^:planning/discovery-2026-07-12-pass4/owner-rulings.md`

- **R-2026-07-12-5 · strict single-source RBAC + better-auth cutover.** Every guard consults
  `ACTION_ROLES`; finish the better-auth organization migration. Breaking changes allowed.
- **R-2026-07-12-6 · operator vs boundaries: CURRENT BEHAVIOR INTENDED.** `stage-transitions:
  direct` means the org trusted the operator; approval/human boundary settings govern **humans**
  only (Review→Done stays structurally locked). Fix is honest copy, not behavior.
- **R-2026-07-12-7 · prune the fake toggles** — capabilities with no runtime consumer lose their
  toggle. (Later partly reversed: several were *promoted to real gates* in generic-agents, and
  P13-D-26 gave `attach-evidence-references` a real consumer.)
- **R-2026-07-12-8 · wire real MCP credential injection** (`secret://` refs resolved at spawn).

### 2.4 Pass 6 (2026-07-16) — recovered

`git show 371c141^:planning/discovery-2026-07-16/owner-rulings.md`

- **R6-1 · STAY ON MAIN.** `codex/e2e-product-hardening-2026-07-13` is reference-only.
- **R6-2 · accept-completion owner exception** — maintainer+ always may accept; *additionally*
  the task's human owner may accept even as a Contributor.
- **R6-3 · project archive is READ-ONLY ENFORCED** (supersedes the pass-3 hide-only decision).
- **R6-4 · DRAG = ACCEPTANCE.** A permitted human dragging Review→Done runs the same acceptance
  path as the queue's Accept button — one semantic, two surfaces.
- **R6-5 · seeded demo runs removed from rollups and from boot re-animation.**

### 2.5 Pass 7 (2026-07-16) — recovered · the largest scope cut in the project

`git show 371c141^:planning/discovery-2026-07-16-pass7/owner-rulings.md`

- **R7-2 · DON'T SIMULATE AT ALL.** *"an unavailable backend must NEVER produce a fake run"* —
  keyless/broken-credential runs surface an honest "backend unavailable" error + a typed blocked
  packet. No simulated verdicts, no simulated governance evidence. The demo seed ships no
  fabricated run history. A deterministic test-only adapter may remain for Playwright, gated so
  it is unreachable in production.
- **R7-1 · role-bindings cleanup + implement D2**: org admins get visible, **audited** emergency
  project-admin authority on any project without membership.
- **R7-4 · operator may transition BACKWARD** on a failing verdict (Review→In Progress), one
  governed audited backward edge.
- **R7-5 · specialist capability picker collapses to 3 honest modes** — Allowed / Human-only /
  Off. `recommend` is operator-only; at runtime a specialist `recommend` grant was identical to
  `direct`.
- **R7-6 · Done tasks stay commentable.**

### 2.6 Pass 8 (2026-07-17) — recovered

`git show 371c141^:planning/discovery-2026-07-17/owner-rulings.md`

- **R8-3 · every "waiting on you" counter means "requires MY action", member-scoped.**
  Non-members do not see a project's decisions as waiting on them; superseded/resolved packets
  drop out immediately; org-admin override-eligible items are labeled distinctly, never folded
  into the personal count.
- **R8-4** reconcile-github raised to maintainer+ · **R8-5** archived projects freeze credential
  mutation · **R8-6 · GitHub↔task divergence: SURFACE, human closes the loop** — post a typed
  divergence event + notification, never auto-advance · **R8-7** manage-members stays admin-only.

### 2.7 Generic agents + passes 9/10 (2026-07-19) — recovered

`git show c1acf2c^:planning/discovery-2026-07-19-generic-agents/plan.md`,
`…/discovery-2026-07-19-pass10/DECISIONS.md`

The uniform-machinery rework. *"Apart from the operator, all agents are generic: one uniform
machinery, differentiated only by per-profile data."*

- **G1 · Engagements replace slots.** `task.md` gets one `engagements[]` of
  `{profileId, backend, role, delivers?}`. **Exactly one engagement carries `delivers: true`**
  (workspace/branch/PR ownership — the single-writer invariant). *Reviewer stops being a slot.*
- **G2 · Verdict power is a grant.** Any verdict-capable agent writes `validation`; failing
  blocks acceptance. Default **off** so a casually-created profile never acquires acceptance-veto
  power.
- **G3 · Ask-human + comments** are capability-gated agent tools; `ask_human` opens a
  question-type packet. The operator keeps exclusive open+resolve+recommend.
- **G4 · Envelope + fallback** — one structured outcome schema, MCP tool on Claude,
  output-schema on Codex, one server-side handler.
- Actor refs become **profileId-keyed** (`agent:<backend>/<profileId>`) with a never-null compat
  decoder. Profiles carry a short scannable `desc` (for operator selection) plus a long body
  persona.
- **Pass 10 rulings** (`DECISIONS.md`): security scope = **in-app mitigations only**, no
  container/sandbox/credential-broker infra · **Q10-01 keep the full-autonomy acceptance
  exception, fix the copy** · **Q10-02 verdict authority EXPLICIT-ONLY** · **Q10-03 full
  revision-bound multi-review model** — per-engagement verdicts keyed to an immutable
  `workRevision`; a new tree invalidates prior verdicts; acceptance requires every currently
  required reviewer to approve the *current* revision · **Q10-05 supporting engagements are
  physically read-only by default** · **Q10-04 raw run logs + provider transcript export require
  project membership** · **Q10-06 persist a deterministic operator routing trace** · **Q10-07 no
  auto-delete of merged branches** (later reversed by R15-6).

### 2.8 Pass 11 (2026-07-23) — first pass after the Simplify rewrite

`planning/discovery-2026-07-23-pass11/PLAN.md:6-27`. Rulings are lettered R-A…R-E.

- **R-A · every stage chain triggers a (queued) operator run; the operator is stage-aware.**
  *"Never strand `waiting:human` with no packet."* Root cause: an operator's own transition did
  not re-trigger it, so nothing ever assigned a specialist (`FINDINGS.md:130`).
- **R-B · agents are conversational; they decide review vs respond.** A mention-triggered run
  foregrounds the triggering comment as the directive. *"don't hardcode 'produce a review'."*
- **R-C · prompt-injection guardrails on BOTH backends.** Explicitly **rejected** the proposed
  Codex sandbox change: *"Do NOT change Codex to workspace-write."* Guardrails are prompt-level
  on both runtimes; Codex honors its constraints from the prompt.
- **R-D · KBs re-index on each change via the file watcher.** No scheduler, no nightly; drop the
  decorative cadence field.
- **R-E ·** ship the packet **free-text note channel** (P11-71); leave `ask-human` default
  `direct` as-is.
- Also shipped: the **5-minute GitHub reconcile poller** (P11-14) with "Reconcile" renamed
  **"Update status"** plus a staleness indicator — built *instead of* amending NFR14; `seed
  --reset` stopped destroying live Codex credentials (P11-04); better-auth splat
  account-mutation paths disabled (P11-02); `workRevision` re-minted after the push-time
  auto-commit so verdicts bind to the delivered sha (P11-10).

### 2.9 Pass 12 (2026-07-24)

`planning/discovery-2026-07-24-pass12/PLAN.md:44-52`

- **R1 (F12-05) · poller nudges the human to merge.** Keep autonomous self-accept; the poller +
  a notification surface a Done/accepted task whose PR is still open. *"Nothing rots silently."*
- **R2 (DG-2) · add admin force-accept** — explicit, audited, admin-only, bypassing the
  required-reviewer gate. The `force` param had zero callers, so a task whose required reviewer
  could never record a verdict was **permanently un-acceptable**.
- **R3 (DM-3b) · just fix the leak** — `--reset` also clears `scope_violations` + `user_prefs`;
  leave the MCP-vs-GitHub reset asymmetry as-is.
- **NEW-4 (user-reported) · agents must @tag the human they answer, and the tag must notify.**
  `notifyMentionedUsers` wired into **every** comment writer plus operator/specialist directives.
- **DG-1** a merged PR is treated like a closed one at the cached fast path, so a reworked branch
  opens a **fresh** PR · **AO-1** staged outcomes survive restart via an `outcome_key` column ·
  **AO-2** lease-drain race closed · **NEW-1** a rejected (closed-unmerged) PR stops reading as
  acceptance-ready.
- **DM-1 triaged NOT A BUG** — `validation` (work health) and `validation_block_reason` (review
  gate) are orthogonal by design; "healthy + blocked" is legitimate.
- Method fact recorded twice: **`npm run build` ≠ typecheck; `tsc` is a required gate.**
- **No PRD/spec text was amended in pass 12.**

### 2.10 Pass 13 (2026-07-24/25) — the KB/MCP pass and the big intent audit

`planning/discovery-2026-07-24-pass13/PLAN.md:8-23` and `DRIFT-TRIAGE.md:10-18`

Scope rulings:

1. **Global agent profiles → a real template library** with an explicit *"Add from library"*
   that copies a template into the project. **No silent auto-deployment.** Org-created profiles
   had been structurally undeployable.
2. **Drop the "Lightweight · 3 stages" template** — *removed, not remapped*. Every lightweight
   project was dead on arrival: the seeded roster carried Standard stage ids, so no specialist
   was ever stage-eligible. Standard 5-stage is now the only creation preset; custom boards
   remain fully editable after creation (`decisions.md:187-191`).
3. **In-app KB authoring** through the same writer path the skill editor uses.
4. **Model network egress as a capability** (`use-web-search-fetch`), granted by default,
   visible in the matrix, revocable per profile. A "read-only reviewer" with every repo
   capability Off still had `WebFetch`/`WebSearch`.

Drift rulings (2026-07-25): **D-1** transitions auto-wire on stage add/remove, no transitions
editor · **D-5/D-27** delete the task-level repo override end to end · **D-26** wire the
`evidence:` block · **U-2** guardrails stay invisible (enforced, no settings surface).

The audit itself, `INTENT-VS-IMPLEMENTATION.md` (1341 lines): 100 agents, 92 claims, **72
confirmed after adversarial verification, 20 refuted**. 48 DRIFT items (D-1…D-48), 11 DELIBERATE
divergences needing doc edits, 3 UNCLEAR, 18 refuted claims listed *so they are not re-raised*.
Disposition: **24 CODE, 19 DOC, 5 BOTH, 5 RULED, 0 deferred at the D-level.** The one deferral in
the whole pass is **UI-18** (a repo-wide `data-screen-label` sweep).

PRD amendments dated 2026-07-25: **FR7** override clause struck · **FR11** "and authorized
agents" struck (*never implemented on any layer*) · **FR27** full-autonomy exception stated ·
**FR30** no per-task override · **FR33** bounded to 90-day retention, no export, export = Phase 2
· **FR37/FR38/FR4/FR14** 2026-07-04 amendments folded into canon · **FR39 created** ·
responsive review-first mode **retired**.

Also created here: `docs/architecture/decisions.md` itself (D-17 — 26 code comments were citing a
deleted normative file). *"In an AI-maintained repo a ruling nobody can read is a ruling that
gets reversed."*

### 2.11 Pass 14 (2026-07-25)

`planning/discovery-2026-07-25-pass14/FINDINGS.md:3-20`

- **R14-1 · profile eligibility auto-maps by STAGE ROLE**, not raw stage id, so a profile lands
  eligible on any board's equivalent stages. Dropping the Lightweight template had stranded
  existing projects that used its ids.
- **R14-2 · owner packet authority, WIDER than FR37 as written.** A task's human owner may
  resolve **any** packet on their own task. Closes the dead end where the decisions inbox counted
  an owned task as "waiting on you" and every action returned 403.
- **R14-3 · real task-level archive** — terminal disposition, hidden from the board default,
  timeline/audit preserved, restorable, maintainer+. *"this is a disposition, not a delete."*
- **R14-4 · full KB editor cluster** — open/view/edit in place, overwrite confirm, folder
  targeting, draft preserved on error.
- Headline behavior change: **capability polarity inverted (LV-01)** — an **absent** delivery or
  verdict grant now means **withheld**, not granted. `capabilities: []` had silently carried full
  repo-write.
- **RV-02 (security)** — store path containment became `realpathSync`-based; a symlink inside the
  store had read host files through the in-app reader.
- **RV-03** — archiving now cancels pending scheduled operator re-runs. An archived task with a
  pending schedule still fired it: *abandoned work resurrected by an agent with no human
  watching* — the exact thing FR39 exists to bound.
- Method finding worth carrying: **four ledger rows marked DONE were not done.** *"the bulk
  OPEN → DONE rewrite at pass close was too optimistic."*
- **Only FR37's text was touched** — pass 13's "partly implemented" annotation was itself stale
  and the requirement was already *wider* than written.

### 2.12 Post-pass-14, straight to main (2026-07-25 → 28)

Three rulings that landed as commits and were only later given numbers
(`decisions.md:197-209`): **17** PR-divergence recovery — the reconciler fires a `pr-diverged`
operator trigger; on a closed PR the operator opens ONE recovery packet (rework / `archive_task` /
`archive_task + deleteBranch`), and remote-branch deletion exists *only* as that packet
resolution. **18** minimum GitHub scopes are exactly `repo + pull_request:write`; `workflow` and
`read:org` were dropped; fine-grained tokens prove write permission via empty-payload dry-run
probes (422 = authorized, 403 = refused). **19** scope chips render **proven verdicts only** — a
chip is evidence; `assumed`/`unchecked` render as an honest "unproven" line, never a pseudo-check.

### 2.13 Pass 15 (2026-07-28/29) — delivery, acceptance, visibility

`planning/discovery-2026-07-28-pass15/FINDINGS.md:101-116`; promoted verbatim into
`decisions.md` as rulings 20–34.

| ruling | what | why |
|---|---|---|
| **R15-1** | **Acceptance is verdict-gated.** A healthy reviewer verdict on the *delivered revision* is required; audited admin **Force-accept** is the only bypass, and it never bypasses the PR-head-must-contain-the-delivered-commit check. Every accept shows a confirm dialog naming what merges and any missing signal. | F15-19: a task went Done and its PR merged with **zero verdicts**, no confirm, ~30 s of silence. F15-10: merging to the default branch had no dialog while *removing a credential* did. |
| **R15-2** | **Delivery is an OPERATOR decision.** Push + review-PR opening is no longer a stage side-effect. The operator holds `deliver-review-pr`, weighs the task's remaining stages, opens a packet when unsure, and may offer **early** delivery when later stages don't gate this task. The server still executes the mechanics; specialists never push or open PRs. Entering the review-role stage with no PR writes a typed event — never silence. A human delivery button (maintainer+ / task owner) is the escape hatch. | F15-17: delivery was bound to "the stage with the governed edge into Done". Inserting a QA stage after Review silently moved push+PR to QA, and entering the stage literally named "Review" delivered nothing, with no event. |
| **R15-3** | **Owner authority covers recommendations** — a task's owner may apply or dismiss **any** operator recommendation on their own task, including a stage move their role could not authorize from the menu. **The Apply click IS the authorization** for that one move. | F15-12: a contributor who owned the task saw Apply/Dismiss on a stage recommendation; Apply 403'd **silently**. |
| **R15-4** | **Projects are members-only.** A non-member cannot open a project's board, tasks, or any project surface — the routes behave as if the project does not exist. FR4's app-wide commenting applies *within visible projects*. | B-FD3: board/task were app-wide readable while review/activity 403'd specifically so a user "must not learn the project exists". Workflow secrecy (WI-13) wins. |
| **R15-5** | **Global ⌘K palette** — real workspace-wide search over tasks, branches, agents and projects, scoped to visible projects. | F15-16: the topbar promised "Search tasks, branches, agents" but was an inline filter over the current board; agent names matched nothing. |
| **R15-6** | **Per-project delete-branch-on-merge**, default on. | merged task branches accumulated. |
| **R15-7** | **Ghost profiles are fully conservative** — a run whose profile can no longer be resolved gets nothing permissive: no delivery, no comments, no ask-human, no evidence. | the "we can confirm nothing about this profile" posture applied to tools but not to collaboration. |
| **R15-8** | **`design/prd.md` is re-synced with canon** and both are maintained; `planning/README.md`'s sync claim must stay true. | the README claimed the copies agreed; they were 12 hunks apart. **Verified today: byte-identical.** |
| **R15-9** | An absent `deliver-review-pr` grant **resolves from the project's own governance, not a constant** — read off the workflow graph (`humanGatesPreWorkAdvance`) rather than a stored preset field. | the capability postdates R15-2, so "absent" is normal on every pre-existing project; a flat `direct` made two projects with identical governance behave differently *by creation date*. *"Deriving beats a stored field here precisely because it is already true of projects that predate the capability."* |
| **R15-10** | **The first empty board teaches, once** — one line in the entry column, only at zero live tasks. | five bare "No tasks" columns were the only empty state in the app that didn't teach, and the first thing a new user sees. Narrows P13-D-34 rather than reversing it. |
| **R15-11** | The **Review queue stays a triage list**; rows say "Review ›", deliberately **not** "Accept". | acceptance is verdict-gated and may refuse — *"a control must not name an outcome its surface cannot promise."* |
| **R15-12** | **Unenforced capability lines are collapsed, never hidden** (a `<details>` labelled with its count). | *"an omission the reader cannot see is worse than an awkward truth, and 'role-irrelevant' is a judgment the code should not be making about policy."* |
| **R15-13** | **Settings headings name their own scope** — "Instance settings" and "\<name\> · settings". | "Viberr settings" collided with a project *named* Viberr. |
| **R15-14** | **A resolved agent question goes back to the AGENT THAT ASKED**, by resuming its own session. The packet records `askedBy` (profile id, not display label). | the answer used to travel only through the operator, which may start the specialist cold — *"a cold start discards the reasoning that produced the question."* `ask_human` still ends the run. |
| **R15-15** | **A task owns a PR only if that task opened it.** `openTaskPr` is the sole writer of the link; the reconciler keeps an owned link honest and **never mints one**. A PR found on the task's branch that the task does not reference is a branch-name **collision** and is reported as one. | a task-key branch is not a unique identifier — a new data root restarts keys at 1, so a brand-new `VIB-1` gets branch `vib-1`, which on GitHub may still carry a previous `VIB-1`'s PR. |

Pass-15 also produced the sharpest method statements in the project, worth keeping:

- *"Tests check the rule; only the instance checks the assumption."* Three defects survived a
  green suite and died on the running app (`FINDINGS.md:221-234`).
- *"Run both directions, and run them last."* A ledger→diff audit proves no row lies; only a
  diff→ledger audit proves the ledger is **complete**. It found six defects in the evidence
  trail and zero in the product (`FINDINGS.md:145-183`).
- *"A ✅ that rests only on positive evidence is half a proof."* *"'X reaches the run' and 'only X
  reaches the run' are different claims, and the second is the one a capability system actually
  promises"* (`FINDINGS.md:194-206`).

The `UX-ASSESSMENT.md` verdict on the UI: *"yes, it is coherent — unusually so — and the
incoherences are specific and nameable"* (`:8`), judged from rendered copy on the running app,
not source, *"because coherence is a property of what the user actually reads"* (`:72-76`).

### 2.14 Modernization (2026-08-03)

`planning/modernization-2026-08-03/`. Framing: this **supersedes an abandoned 2026-08-02 attempt
that ran to completion and was rejected by the owner on quality grounds; none of its code is
reused**. *"Acceptance here is taste as much as tests"* (`PLAN.md:22-33`) — keep the look and
feel, new capabilities must not degrade the existing pointer experience, smallest diff, show the
owner the running result after each user-facing wave.

- Every direct dependency current; `npm audit` 0 vulnerabilities (was 2 moderate + 7 high).
- **A1** chokidar 5 replaces raw recursive `node:fs.watch` — typed add/change/unlink/unlinkDir
  instead of rename inference (the exact source of the old F15-03 class).
- **A2** dnd-kit board. **Whole-card drag preserved, no grip handle**; mouse activation is
  distance-only so a slow press-and-release still navigates; **touch is a 250 ms long-press —
  a new capability**. `OptimisticSortingPlugin` removed: the server stays authoritative.
  dnd-kit's ARIA decoration is deliberately **off** (its `role="button"` wrapper nested the task
  link and StageMenu — axe nested-interactive, serious); **keyboard drag was not added**, the
  accessible move path remains the StageMenu.
- **A3** Lexical plain-text composer replaces the textarea + mirror backdrop. Posted bytes
  unchanged; failures retain the draft.
- **Testing policy amendment (owner):** anything serving the app for a test runs on the
  **production Docker image** in an isolated Compose stack. **The dev server is banned for
  browser, e2e, integration and acceptance checks.**
- Product-visible: touch dragging; React #418 hydration mismatches fixed on the task page and
  (by follow-up) the activity page — timestamps render UTC-deterministic on the first pass and
  viewer-local after hydration, with day-grouping keys deliberately absolute.

### 2.15 What pass 15 closed from the previous product-intent doc

The pass-15 map (`planning/discovery-2026-07-28-pass15/docs/product-intent.md:214-235`) asked
eight open questions. Status today:

| # | question | status |
|---|---|---|
| 1 | promote the three post-pass-14 rulings into `decisions.md`? | **CLOSED** — they are rulings 17/18/19. |
| 2 | Continuity Recovery Panel — V1 ceiling or a V1.x slot? | **STILL OPEN** → §5 Q4 |
| 3 | global ⌘K palette — build it or amend the mock copy? | **CLOSED — built** (R15-5). A residual reachability gap survives → §4b. |
| 4 | NFR14's "10 s of detection" vs the 5-minute poller | **STILL OPEN** → §5 Q5 |
| 5 | measure the performance NFRs or amend them? | **STILL OPEN** → §5 Q6 |
| 6 | audit export vs 90-day hard delete | **STILL OPEN** → §5 Q7 |
| 7 | `design/prd.md` — re-sync, delete, or freeze-label? | **CLOSED** — re-synced (R15-8), verified byte-identical; `planning/brainstorming/` is gone. |
| 8 | who verifies the full-autonomy close live? | **CLOSED** — VAL-1 ran creation→Done with **zero human touches** in ~3.5 min; the timeline disclosed *"Operator accepted completion under full-autonomy policy … merge pending (a human merges it)"*. |

---

## 3. Current product surface

### 3.1 Routes (`app/routes.ts`)

```
/login  /logout  /api/auth/*                    better-auth (incl. OAuth callbacks)
/                                               home — project list, decisions headline
/projects                                       → home (not a 404)
/projects/:slug                                 workspace shell (rail + topbar)
  ├ /board  /review  /agents  /policy  /github  /activity  /settings
  └ /tasks/:key
/org/settings                                   tabbed: GitHub connections · Users & access · Agent resources
/profile   /notifications                       URL-addressable page overlays
/prefs/theme   /notifications/read              resource actions
/resources/events (SSE)  /resources/health  /resources/run-log
/resources/search (⌘K)   /resources/model-catalog  /resources/session-export
```

32 route modules; 16 feature modules; 19 server subsystems; one squashed migration
(`db/migrations/0001_baseline.sql`).

### 3.2 What each surface does

- **Home** — membership-scoped project grid (pinned / all / archived), list & board views with a
  density toggle, per-project waiting counts labelled with their scope, a cross-project
  *"N decisions waiting on you across all your projects"* headline, project creation
  (self-serve for any org member; creator becomes that project's admin), instance settings,
  projection rebuild.
- **Board** — stage columns from `project.md`, task cards carrying stage, waiting state, assigned
  agent, readiness pill, validation pill and branch chip; filters `all · waiting on me · waiting
  on agent · needs attention · archived`; board-scoped text filter over key/title/branch/identities;
  whole-card drag between stages (server-authoritative) plus a keyboard/pointer StageMenu;
  manual board reorder (`reorder-board`); teaching empty state on a brand-new board.
- **Task detail** — title, current state panel, execution profile, decision packet, operator
  recommendations (apply/dismiss), acceptance affordance with a confirm dialog, archive/release
  confirmations, GitHub panel, diagnostics panel, scheduled re-runs panel, agent-logs console
  with streamed run lines and a session-export affordance, unified timeline with progressive
  disclosure (30 events, "show older"), and a Lexical plain-text composer with @mention
  autocomplete over humans and agents.
- **Review queue** — "Waiting on your acceptance" / "Still in review", each row naming its live
  PR state or block reason; rows link to the task ("Review ›"), acceptance stays on the task page.
- **Agents** — deployed roster, per-profile detail, create/edit profile modal (backends, model +
  reasoning effort from the live catalog, eligible stages, capability grants, resources),
  capability matrix modal, "Add from library".
- **Policy** — three panels held visibly separate: *Human access · RBAC* (rendered from the same
  `RBAC_DEFINITIONS` object the guards consult), *Agent capability*, *Workflow rules* (the flow
  map drawn from the real `workflow` edges).
- **GitHub** — credential card with proven-only scope chips, repo binding, branch/PR table, sync
  freshness disclosure, "Update status".
- **Activity** — cross-task stream + audit log, both paginated.
- **Project settings** — name/description, stages editor (auto-wiring the transition chain),
  guardrails, repository & credentials, delete-branch-on-merge, members & roles, archive.
- **Org settings** — GitHub connections (multiple, validated before save), users & access
  (create/disable, OAuth domain allowlist), agent resources (skills, knowledge bases, MCP
  registry) with a store browser and an in-app document editor.
- **Profile / Notifications** — theme, in-app notification preferences, "Your access" table,
  notification list (newest 200).

### 3.3 Agent machinery

- **Operator toolkit** (`app/server/tasks/operator-toolkit.server.ts`): `get_task`,
  `post_comment`, `set_goal`, `open_decision_packet`, `resolve_decision_packet`, `engage_agent`,
  `run_agent`, `prompt_agent`, `deliver_for_review`, `transition_stage`, `accept_completion`.
- **Agent toolkit** (`agent-toolkit.server.ts`): `post_comment`, `ask_human`, `report_outcome`.
- **Capability catalog** (`app/shared/capabilities.ts`, 29 entries) across three shapes: operator
  toggles, agent toggles, matrix-only advisory ids (`group: null`, no toggle — ruling 7), and the
  always-human structural locks (`merge-pull-request`, `transition-to-done`,
  `change-project-policy`).
- **RBAC** (`app/shared/rbac.ts`, 18 actions, 4 roles in a strict tier). One object renders the
  Policy table and feeds the guards, so display and enforcement cannot drift.
- **Runtimes**: Claude Agent SDK and Codex SDK, credential-presence-detected; a backend with no
  credential is reported `unavailable` and runs on it fail fast (R7-2). Per-run workspace clone
  under `<taskDir>/workspace/` with `GIT_CEILING_DIRECTORIES` confinement.
- **Scheduled operator re-runs** (FR39) with a 60 s server-side runner; entries live in the task
  file so they survive a rebuild.
- **Guardrails** with real enforcement on the canonical record: `meaningful-comment` (chatter
  dropped), `operator-brevity` (1000-char cap), `evidence-separation` (raw dumps → reference),
  plus `no-duplicate-summary` and `compression-threshold` (40 events).

### 3.4 What `npm run seed` ships

A **clean sheet**: the built-in agent catalog (Operator, Developer, Reviewer profile templates),
knowledge bases with real files, skills, the domain allowlist, and a bootstrap admin *only while
the users table is empty*. **No projects, tasks, notifications, or run history.** The mock
dataset lives on solely as a test fixture (`npm run seed:demo`).

---

## 4. The delta table — intent vs reality

### 4a. Deliberately changed, with a recorded ruling

Do **not** "fix" any of these back toward the source document.

| # | Original intent | Today | Ruling / cite |
|---|---|---|---|
| a1 | Simulated/degraded runtime fallback when a backend is unavailable | An unavailable backend produces an honest error + typed blocked packet. No fake runs, verdicts or evidence, in product or seed. | **R7-2**, pass 7 · `git show 371c141^:planning/discovery-2026-07-16-pass7/owner-rulings.md` |
| a2 | FR14 "one primary specialist and additional consultant specialists"; a Reviewer *slot* | `engagements[]` with exactly one `delivers: true`; verdict power is a grant, not a kind | generic-agents **G1/G2**, 2026-07-19 · `git show c1acf2c^:planning/discovery-2026-07-19-generic-agents/plan.md` |
| a3 | Advisor / Tester / consultant profile kinds | Removed. Operator absorbs advisory duties; Reviewer covers quality. Kinds are `operator` and `specialist`. | pass-1 decision A, pass-3 D1 · recovered product-intent doc |
| a4 | FR7/FR30 task-level repo override | Deleted end to end — writer, toggle, audit kind, read path, FR clauses | **D-5/D-27** · `prd.md:215, :251` |
| a5 | FR11 "and authorized agents" may create tasks | Struck — never implemented on any layer; task-graph is post-MVP | **D-24** · `prd.md:222` |
| a6 | Human-only Done, unconditional | One audited exception: full autonomy + explicit `completion-for-acceptance: direct` | **Q1** · `prd.md:114, :245`; `decisions.md:91-95` |
| a7 | UX spec review-first mobile mode below 768px | Retired. One surface, reflowed; nothing gated on viewport | **D-29** · `prd.md:161`, `ux-design-specification.md:870` |
| a8 | "Lightweight · 3 stages" creation preset | Deleted (not remapped). Standard 5-stage is the only preset; custom boards edited after creation | **pass-13 ruling 2** · `decisions.md:187-191`, `app/shared/workflow/templates.ts:19-22` |
| a9 | Project role `reviewer` | Renamed `contributor`; 4-tier strict scale; one grant table | ruling 2 amendment · `decisions.md:130-133` |
| a10 | FR4 commenting is app-wide, including projects you are not a member of | **Projects are members-only** — non-members get an unknown-slug 404. "App-wide" now means across visible projects | **R15-4** · `decisions.md:229-231`, `prd.md:207` |
| a11 | Delivery (push + PR) as a stage side-effect | An operator decision, weighed against remaining stages; server executes, agents never push | **R15-2** · `decisions.md:215-221`, `prd.md:252` |
| a12 | Acceptance is a human click | Verdict-gated + confirm dialog; audited admin Force-accept is the only bypass | **R15-1 / DG-2** · `decisions.md:210-214`, `prd.md:245` |
| a13 | FR37 owner = reviewer + acceptance authority for their task | Widened twice: any open decision (**R14-2**), then any operator recommendation incl. stage moves (**R15-3**) | `prd.md:208`; `decisions.md:222-224` |
| a14 | Q10-07 no auto-delete of merged branches | Per-project `delete-branch-after-merge`, **default on** | **R15-6** · `decisions.md:227-228` |
| a15 | OAuth-first login with cookie sessions | Email+password is the shipped first-class default; OAuth optional, whitelist-based, buttons inert without env vars; better-auth is the sole system | `architecture.md:299-303` (revised 2026-07-25) |
| a16 | Anti-noise guardrails get a settings surface | Always-on and enforced, deliberately invisible | **U-2** · `DRIFT-TRIAGE.md:17, :89` |
| a17 | KB refresh cadence (`nightly` / `on change`) | Live file watcher re-indexes on change; the cadence field was cut | **R-D**, pass 11 · `PLAN.md:23-25` |
| a18 | Codex sandbox tightened to `workspace-write` | **Explicitly rejected.** Injection resistance is prompt-level on both backends | **R-C**, pass 11 · `PLAN.md:19-22` |
| a19 | GitHub scopes `repo, workflow, read:org, pull_request:write` | Exactly `repo + pull_request:write` | ruling 18 · `decisions.md:203-206` |
| a20 | A linter/formatter enforcing the anti-drift rules | **Deliberate non-goal, permanently.** typecheck + tests + review instead | **D-31** · `architecture.md:408` |
| a21 | FR5 "Admin users can create projects" | Self-serve for **any** org member; the creator becomes that project's admin | pass-13 §3 FR5 row (*"grants admins the ability; it does not say only admins"*), pinned by test |
| a22 | Board "Waiting on me" project-wide (ruling 10) | Member-scoped — a decision the viewer can act on. The review queue itself stays project-wide | **R8-3** · `decisions.md:164-169` |
| a23 | e2e against a dev server | Production Docker image in an isolated Compose stack; the dev server is banned for any browser/e2e/acceptance check | modernization owner amendment · `PLAN.md:35-46` |
| a24 | Board drag as HTML5 drag events, pointer-only | dnd-kit, whole-card, server-authoritative, touch via 250 ms long-press; keyboard drag deliberately **not** added (StageMenu is the accessible path) | `IMPLEMENTATION.md:45-53` |

### 4b. Silently drifted — no recorded decision found

These are the owner-question generators. Each was verified against the code today.

| # | Claim / expectation | What the code does | Evidence | Why it matters |
|---|---|---|---|---|
| **b1** | The board's "Needs attention" filter should cover the readiness value that literally means *a human must supply something*. Pass 15 wrote the exact patch as handback **H1 (B-FD5)**. | `matchesBoardFilter`'s `risk` branch covers `inconsistency_risk_detected`, `blocked`, `validation: failing`, `urgent`, and a closed PR — **not `input_required`**. A live test **asserts the opposite** with a bare comment `// input_required is NOT "needs attention"` and no rationale. | patch specified `planning/discovery-2026-07-28-pass15/handbacks/S5-foundation.md:9-35`; code `app/features/board/board-filters.ts:40-53`; counter-test `app/features/board/board-filters.test.ts:45-48` | The handback was written to be applied and never was, while a test pins the opposite behavior. One of these is wrong and nothing records which. A supervisor filtering for work that needs them misses every task waiting on their input. |
| **b2** | The review queue row should tell the human the *right next action*. R15-11 explicitly: "a control must not name an outcome its surface cannot promise". P14-LV-05 explicitly: "live PR state outranks the newest timeline note". | `reviewRowSub` returns `t.blockReason` **first**, before `prStateSub`. `acceptanceRefusalReason` orders the R15-1 verdict gate **before** `closedPrBlockedReason`. So a task whose PR was closed unmerged **and** has no verdict reads *"no approving verdict yet — run a review"* and the rejection disappears from the queue. | `app/features/review/review-helpers.ts:52` vs `:38-39`; `app/server/tasks/task-actions.server.ts:4566-4580`; flagged `handbacks/G-B-foundation-verify.md:174-187` | The human is told to run a review on work GitHub already declined. The reason ordering was never ruled on — R15-1 simply inserted a gate ahead of an existing one. |
| **b3** | R15-5: the ⌘K palette is *"real workspace-wide search"* and the mock's promise finally kept. | In the **workspace** topbar the whole `.top-search` is a button, and it survives to 720px. On **Home** the only pointer affordance is the `.kbd` chip, and `@media (max-width: 1080px) { .kbd { display: none } }`. A tablet or phone user on Home has **no way to open the global palette** — ⌘K is the only route and touch devices have no ⌘K. | `app/features/home/home-page.tsx:900-925`; `app/features/shell/topbar.tsx:158-172`; `app/app.css:2556-2561`; flagged `handbacks/S6-ux-verify.md:135-145` as *"undisclosed … should not ship as-is"* | It contradicts the responsive ruling head-on: *"Every action — including destructive and governance actions — renders at every width; nothing is gated on viewport size, and nothing should be"* (`ux-design-specification.md:870`). |
| **b4** | FR33 / NFR18 / the runbook: audit rows are hard-deleted at 90 days. | Two action kinds are **exempt** because they double as idempotency keys: `task.agent.replied` and `runtime.operator.plan_executed` (B-FD10). The runbook's retention table still says a flat 90 days. | `app/server/db/retention.server.ts:26-45, :69-78`; `docs/operations/runbook.md:104` | The exemption is well-reasoned in code but contradicts two canon statements. An operator planning around the retention table gets it wrong in the *safe* direction, but FR33's "genuinely gone at 90 days" is now false for two kinds. |
| **b5** | `decisions.md` ruling 7: *"the kind set is now **eight**"*. | Nine. Ruling 17 added `archive_task` and ruling 7 was never updated. | `app/schemas/task-file.schema.ts:62-81` vs `docs/architecture/decisions.md:151-153` | Small, but `decisions.md` is the file the whole tree cites; a count that is wrong there is the kind of thing a future pass "corrects" by deleting a kind. |
| **b6** | `docs/architecture/file-formats.md` is the canonical schema contract with MUST language. | Its `project.md` example still shows `role: admin \| maintainer \| reviewer \| viewer` — **`reviewer` was renamed `contributor`** by the ruling-2 amendment — and `requiredScopes: [repo, **workflow**, **read:org**, pull_request:write]` (dropped by ruling 18). | `docs/architecture/file-formats.md:79, :90` | Hand-written or imported project files are a supported input path. This document teaches two shapes the product no longer accepts or requires. |
| **b7** | `docs/operations/deployment.md`: *"the app does not currently close the database or checkpoint on shutdown"* — the stated reason WAL sidecars must be in every backup. | False since P13-D-43 and doubly so now: `armProcessShutdown()` is called explicitly at boot (`app/server/boot.server.ts:209`) and `runProcessShutdown` runs on SIGINT/SIGTERM. | `docs/operations/deployment.md:176-178` | The backup instruction is still right for other reasons; the *justification* is stale, which is how a future pass "simplifies" the backup step away. |
| **b8** | `docs/operations/runbook.md`: *"The native recursive file watcher (250 ms debounce)"*; `docs/testing.md`: *"Runs Playwright against a real dev server … `e2e/.tmp-data`"*. | chokidar 5 since modernization A1; the dev-server `webServer` path is **deleted** and e2e drives the production image in an isolated Compose stack. | `runbook.md:31`, `testing.md:26-32` vs `modernization-2026-08-03/IMPLEMENTATION.md:27-43` | `testing.md` actively misdescribes the owner's own testing-policy amendment. |
| **b9** | FR14 and the product glossary should use the same words. | PRD FR14 still says *"one primary specialist and additional consultant specialists"*; the product says *engagements*, *delivering engagement*, *supporting engagement*, *required reviewer*. `qa/pass15/GLOSSARY.md` defines Task, Stage, Operator, Specialist, Decision packet — and not Engagement. | `prd.md:225`; `app/schemas/task-file.schema.ts:107-135`; `qa/pass15/GLOSSARY.md` | Generic-agents changed the mechanism and the doc reconciliation covered `file-formats.md`, never FR14's vocabulary. A reader of the PRD looks for a "consultants" field that does not exist. |
| **b10** | The P14-WL-03 comment and its test describe a readiness value `in_review`. | No such value exists. The canonical enum is exactly `ready` / `input_required` / `inconsistency_risk_detected` / `blocked`, and `in_review` appears in production code only inside that comment. | `app/features/board/board-filters.ts:49`; `app/features/board/board-filters.test.ts:57`; enum `decisions.md:57-59` | The behavior under test is right; the rationale describes a state the system cannot produce, which makes the test unfalsifiable as documentation. |
| **b11** | An unmerged branch `codex/gpt-5-6-sol-agents` (2026-08-02) adds a 101-line `AGENTS.md` at the repo root, titled *"Optimize agent guidance for GPT-5.6 Sol"*. | Not on `main`; no planning record; `design/CONVERSATION-SUMMARY.md` records that an AGENTS.md preview/generator was **rejected** in design iteration. | `git show 461d34a` | Either it is wanted (and belongs in a pass with a record) or it should be deleted; leaving it dangling invites a future agent to merge it as "obviously intended". |

### 4c. Missing or never built

| # | Intent | Status | Cite |
|---|---|---|---|
| **c1** | **Continuity Recovery Panel** — what is known / what is missing / what remains authoritative / recovery path / escalation (`ux-design-specification.md:655-664`), the component Journey 4 leans on (`prd.md:87`) | **Not built.** D-2 built the *mechanism* — a first-class `session_missing` failure class on both backends, a probe before resume, retry-as-fresh with a canonical re-anchor preamble, and `latestSessionRun` skipping dead session ids — but the designed panel does not exist. Sanctioned as Phase-3 sequencing (`ux-design-specification.md:707-711`), never re-examined since. | `DRIFT-TRIAGE.md:26`; `app/server/runtimes/run-service.server.ts:471-534` |
| **c2** | Search/filter defaults should include **degraded continuity** as a first-class triage state (`ux-design-specification.md:847`), and the four states must not collapse into one generic treatment (`:734`) | The board ships five filters, none of them continuity. Continuity degradation reaches the UI only as a run-console pill reading *"continuity error"*. | `app/features/board/board-filters.ts:7`; `app/features/runtime/runs-helpers.ts:20` |
| **c3** | **Performance NFR1–NFR4** (200-card board ≤2s; task detail ≤2s; action reflect ≤3s; propagation ≤5s) | **Never measured, in any pass.** Every live instance has been ≤10 tasks. The board query has no `LIMIT` and no virtualization — it loads every task in the project. Timeline and run logs *are* progressively disclosed (30-event slices, `?since=` paging), so NFR5 is architecturally satisfied but unverified on a genuinely long task. | `prd.md:266-270`; `app/server/projections/board-query.server.ts`; `app/features/task-detail/timeline-slice.ts:8-9` |
| **c4** | **NFR14** — GitHub failures surfaced within 10 s **of detection** | Detection itself is a 5-minute poll. Nothing anywhere argues detection cadence vs surfacing latency; pass 11 built the poller *instead of* amending the NFR. There are **no GitHub webhooks** in the tree. | `prd.md:288`; `app/server/github/reconcile-poller.server.ts:22` |
| **c5** | **Audit export** (FR33 residue) | Phase 2. Org- and auth-scoped rows (`auth.login.*`, `org.user.*`, `org.connection.token_replaced`, `github.pat.*`) have no markdown counterpart and are genuinely gone at 90 days unless the operator snapshots the data root. | `prd.md:257` |
| **c6** | **Board keyboard navigation across lanes** (`ux-design-specification.md:620`: *"support keyboard navigation across board lanes"*) | Never claimed, tested, or ruled on. Modernization A2 explicitly did **not** add keyboard drag; the StageMenu is the accessible move path (F10-25), which moves a card but is not lane traversal. | `IMPLEMENTATION.md:51-53` |
| **c7** | **Output-side secret scrub** (NFR7 read strictly) | U-1 was settled by building narrow redaction of app-injected credential values *at the sink*; there is no general scrubber over the bare logger. Source-side isolation + membership scoping is the accepted stance. Standing gap-by-ruling. | `DRIFT-TRIAGE.md:88`; `prd.md:275` |
| **c8** | **UX spec testing strategy**: the three critical journeys *"explicitly tested across breakpoints and with assistive technologies"* (`:930`) | The axe/AA e2e sweep covers a handful of routes in both themes. Breakpoint testing of board-scan / blocked-decision / continuity-recovery has no recorded evidence, and the continuity-recovery journey has no surface to test (c1). | `ux-design-specification.md:909-931` |
| **c9** | **Phase 2 scope** — analytics on agent throughput and governance load, task-graph + subtask orchestration, richer profile templates beyond the library, deeper validation workflows | Not built. Correctly out of MVP; listed so nobody mistakes their absence for drift. | `prd.md:190` |
| **c10** | **Org-level audit console** | Org-scoped audit rows are recorded but only project-scoped audit has a UI (Activity → Audit logs). Documented as a deliberate boundary — the mock defines no org audit tab. | `README.md:235-237` |
| **c11** | `UI-18` — the repo-wide `data-screen-label` sweep | 32 occurrences, zero consumers. Deferred by ruling in pass 13, still open at pass 14, unmentioned in pass 15. The single longest-standing deferral in the project. | pass-13 `FINDINGS.md:340`; pass-14 `docs/routes-ui-reverify.md:77, :121` |

### 4d. Built beyond the original scope

None of these is drift; all are additive and most are ruled. They are listed because the PRD does
not describe them, so an audit against the PRD alone reads them as unplanned.

| area | what shipped | authority |
|---|---|---|
| **Context resources** | Skills, knowledge bases and an MCP registry as first-class org resources, with a store browser, in-app authoring **and** a full editor cluster (view/edit/overwrite-confirm/folder targeting), GitHub single-file import, rename-rewrites-references, a 24 000-char KB injection budget with a trusted-provenance banner | FR9 names the *concept*; authoring/editing is pass-13 ruling 3 + **R14-4** |
| **⌘K command palette** | Workspace-wide search over tasks, branches, agents, projects, visibility-scoped | **R15-5** |
| **Notifications** | Per-user in-app rows, bell popover, notification page, per-category preferences, **@mention fan-out from every comment writer including agents** (NEW-4) | pass-12 NEW-4; ruling 9/13 |
| **Task archive** | Terminal disposition, restorable, withdraws packets + schedules, maintainer+ | **R14-3** |
| **Scheduled operator re-runs** | 5m/1h/6h/24h, canonical in the task file, cancellable, audited, never fires on a terminal or archived task | O-3 → retro-promoted to **FR39** |
| **Force-accept** | Audited admin bypass of the review gate; names the exact gate it overrode | **DG-2** |
| **Session export** | Downloads a bash installer carrying a run's provider transcript so the conversation resumes locally; membership-gated | FR23-adjacent; Q10-04 |
| **Run console** | Streamed SDK output, real usage envelopes only (**never estimates**), interrupt, retry-on-other-backend, paginated log tail | ruling 11 |
| **Model catalog** | Per-backend model + reasoning-effort pickers with substitution flags | — |
| **Project archive** | Read-only enforced server-side | **R6-3** |
| **Org connections** | Multiple GitHub PATs, AES-256-GCM sealed, validated before save, proven-only scope chips via dry-run write probes | ruling 18/19 |
| **Home/board ergonomics** | Pinned projects, density toggle, list vs board view, board reorder, three-way empty states, teaching empty board | **R15-10**, P13-D-34 |
| **Ops** | `/resources/health` (unauthenticated by design), single-writer data-root lock with a boot-id-based staleness proof, boot retention pass, workspace reclaim, graceful shutdown with WAL checkpoint | B-FD1, D-20, AU-4, D-43 |
| **Web egress capability** | `use-web-search-fetch`, on by default, revocable, enforced on both backends | pass-13 ruling 4 + P14-RT-06 |

---

## 5. Open questions for the owner

Numbered for reference. Each is decision-ready: background, why it matters, and the shape of the
decision.

**Q1 — `input_required` and the "Needs attention" filter: which side is right?**
Pass 15 wrote a handback specifying the exact patch to fold `input_required` into the board's
"Needs attention" filter, on the reasoning that it is *"the one readiness value that literally
means a human must supply something"* (`handbacks/S5-foundation.md:9-35`). It was never applied,
and a live test asserts the opposite with no rationale (`board-filters.test.ts:45-48`). The
server half of the same finding *was* applied (home counts + notifications inbox). Today a
supervisor who filters for "needs attention" sees blocked and risk tasks but not the tasks
waiting on their own input, while the home headline counts them. **Decision: apply the handback
and delete the counter-test, or keep the current behavior and give the test a recorded reason.**

**Q2 — When a PR is closed unmerged and no verdict exists, which refusal does the human read?**
`acceptanceRefusalReason` runs the R15-1 verdict gate before the closed-PR gate, and the review
queue's `reviewRowSub` prefers `blockReason` over live PR state. The net effect: a task GitHub
already declined reads *"no approving verdict yet — run a review"*, and the closure vanishes from
the queue entirely. R15-11's own principle says a surface must not point at an action it cannot
deliver, and P14-LV-05 established that live PR state outranks stale narrative. **Decision: does
a terminal GitHub fact outrank a process gate in refusal copy — as a general rule, or only for
closed PRs?** This generalizes: the same question applies to a conflicting PR and an archived task.

**Q3 — Is the global palette reachable enough, given that the responsive ruling forbids gating
anything on viewport?**
On Home the only pointer route into ⌘K is the `.kbd` chip, hidden below 1080px
(`app/app.css:2559`); the workspace topbar keeps a real button down to 720px. A tablet user on
Home cannot open workspace search at all. The responsive amendment is unusually absolute:
*"Every action — including destructive and governance actions — renders at every width; nothing is
gated on viewport size, and nothing should be"* (`ux-design-specification.md:870`). **Decision:
make Home's trigger a button like the workspace one (smallest fix), give Home its own
palette-open affordance, or amend the responsive ruling to permit hiding pure accelerators.**

**Q4 — Continuity Recovery Panel: V1.x slot, or is the current ceiling the intent?**
This is the only one of the five named UX-spec components that does not exist, and it is the
component Journey 4 (Murat) is written around (`prd.md:87`, `ux-design-specification.md:655-664`).
The *mechanism* is solid — `session_missing` is a first-class failure class on both backends, the
resume path probes before resuming, retry-as-fresh carries a canonical re-anchor preamble, and a
dead session id can no longer be re-selected forever. What is missing is the surface that says
*what is known, what is missing, what remains authoritative, and how to continue safely.* Today a
user sees a run pill reading "continuity error". **Decision: schedule the panel, or amend the UX
spec to record that the named failure class plus the canonical task file IS the recovery
affordance, and retire the component.**

**Q5 — NFR14 vs the polling model.**
NFR14 requires GitHub failures surfaced "within 10 seconds of detection". Detection is a
5-minute poll with a 20-task-per-project budget and cursor rotation
(`reconcile-poller.server.ts:22`). Surfacing after detection is fast; end-to-end latency is up to
5 minutes plus rotation. No document has ever argued the difference, and there are no webhooks
anywhere in the tree. **Decision: amend NFR14 to state a detection cadence explicitly (e.g.
"surfaced within one reconcile cycle, ≤10 s after detection"), or put webhook-based detection on
the roadmap.** Note the second option carries real cost: webhooks need a public ingress, which
the current single-node reverse-proxy deployment story does not assume.

**Q6 — Measure the performance NFRs, or replace them with the observed envelope?**
NFR1–NFR4 have never been tested; every live instance has been ≤10 tasks. The board loads every
task in a project with no `LIMIT` and no virtualization, so 200 cards is genuinely unverified —
plausibly fine, but unknown. Timeline and run logs *are* paginated, so NFR5 is architecturally
answered. **Decision: fund one pass that generates a 200-task project and measures the four
numbers (and adds virtualization only if it fails), or amend NFR1–NFR4 to the small-team envelope
the product actually targets and stop asserting untested numbers.** The PRD's own success
criteria lean on "feels immediate", not on the numbers.

**Q7 — Audit export vs the 90-day hard delete.**
Retention runs on every boot: run logs 30 days, audit 90, notifications newest-500 per user, none
env-configurable. Task-scoped history survives in `task.md`, but sign-in outcomes, user
administration, connection-token replacement and PAT changes have no file counterpart and are
gone (`prd.md:257`). Export is Phase 2. Separately, two audit actions are now **exempt** from the
delete because boot recovery uses them as idempotency keys (`retention.server.ts:26-45`), which
the PRD and runbook do not mention. **Decision: (a) make the windows env-configurable, (b) move
export up, or (c) keep as-is and amend FR33 + the runbook to name the two exempt actions.** (c)
is cheap and closes the honesty gap even if (a)/(b) wait.

**Q8 — Does the PRD's vocabulary get re-synced to the product's?**
FR14 still says "consultant specialists"; the product says engagements, delivering engagement,
supporting engagement, required reviewer. The generic-agents rework changed the mechanism in
2026-07-19 and the doc reconciliation covered `file-formats.md` but never FR14. The pass-15
glossary (`qa/pass15/GLOSSARY.md`) defines Specialist and not Engagement, so the two canonical
vocabularies also disagree with each other. **Decision: amend FR14 (and the glossary) to the
engagement model, or declare "consultant specialist" the user-facing term and stop using
"engagement" in copy.** This matters because every future audit of FR14 against the code will
re-derive the same false drift.

**Q9 — What is the standing rule for a ruling's record?**
Pass 15 promoted three commit-only rulings into `decisions.md` (17/18/19) after the pass-15 map
flagged them, and then produced two more (R15-14, R15-15) that exist **only** in `decisions.md`
and never appeared in the pass's own FINDINGS ruling block. Meanwhile the *handback* mechanism
produced at least one specified-but-unapplied change with no closing record (Q1). D-17's lesson
was *"a ruling nobody can read is a ruling that gets reversed"*. **Decision: define the threshold
— does every owner ruling get a `decisions.md` number, or only those a code comment cites? And
does an unapplied handback need an explicit disposition row before a pass can close?**

**Q10 — `docs/` canon maintenance: who owns it, and when?**
Six factual errors sit in the four operational docs today (b4, b6, b7, b8), all introduced by
correct changes elsewhere: `file-formats.md` teaches a renamed role and dropped scopes,
`deployment.md` justifies the backup rule with a shutdown behavior that no longer exists,
`runbook.md` names a replaced watcher and an incomplete retention rule, `testing.md`
misdescribes the owner's own e2e policy amendment. Each is a one-line fix; collectively they are
the pattern D-17 was created to stop. **Decision: make "docs canon re-read" a required closing
phase of every pass (like the ledger audit), or accept that operational docs lag and mark them
with a "last verified" date so a reader can discount them.**

**Q11 — The unmerged `codex/gpt-5-6-sol-agents` branch.**
It adds a 101-line root `AGENTS.md` on 2026-08-02, between pass 15 and the modernization, with no
planning record and a commit message that names a model. Design iteration previously **rejected**
an AGENTS.md preview/generator in the product. **Decision: merge it with a record of what it is
for, or delete the branch.** Leaving it is the condition under which a future agent merges it as
obviously-intended.

**Q12 — Should the operator ever perform the merge under full autonomy?**
Today `merge-pull-request` is `ALWAYS_HUMAN`, so a full-autonomy operator that self-accepts leaves
a "merge pending" PR that the poller nudges a human to finish (R1, pass 12). VAL-1 proved the
whole path live and the timeline copy was honest about it. But it means "Done" carries two
different meanings by preset, which is exactly what the F12-05 fork was posed about. **Decision:
is human-attributed merge a permanent invariant, or does a project that has already granted
`completion-for-acceptance: direct` get an equally explicit `merge` grant?** Recorded as an
unresolved question in the pass-15 subsystem docs (`docs/workflow-core.md:87`,
`docs/operator.md:104`) and never asked.

---

## 6. UX principles in force

An implementer changing any surface should be able to satisfy every line here.

**Token discipline.** No Tailwind, no inline hex. Every color, radius, shadow, font and easing
comes from `app/app.css` `:root` (unprefixed names — see §1.6). **A `var(--x)` that is not
defined in `:root` is a bug, not a style choice** (`decisions.md:106`). New CSS goes in clearly
marked appended sections after `app/app.css:2616`. Dark theme is a token swap, so any literal
color you add must be fixed up there too. The light theme's secondary text ladder
(`--muted / --faint / --placeholder`) is **AA-constrained, not free** — the values carry small
text on white and were darkened for contrast; do not lighten them back.

**Motion vocabulary.** One easing token, `--ease-out: cubic-bezier(.23, 1, .32, 1)` — *"strong
ease-out for entrances/presses; ease-in-out reserved for on-screen moves"*. Durations cluster at
`.10–.12s` (press), `.14s` (the workhorse: border/color/background/shadow), `.15–.16s`
(transform), `.20s` (exits), `.30s` (entrances). Rules with teeth:

- **Origin-aware entrances** — a menu grows from the edge that touches its trigger
  (`menu-in` / `menu-in-up`); scrims fade, because a full-screen veil has no edge to slide from.
- **Exit mirrors entrance, faster** — `rise` enters at `.3s`, leaves at `.2s` on the same path.
- **Centered dialogs need `pop-center`** — the generic `rise` keyframe clobbers
  `translate(-50%,-50%)`. `useDialog` sets `[data-closing]` to play the reverse.
- **Press feedback is a scale ladder**: cards `.99` → buttons/chips `.96` → `.fm-act` `.94` →
  icon-only ✕ `.9`. The bigger the target, the subtler the squash.
- **Two-tier reduced motion.** `[data-motion="reduce"]` is the in-app kill switch (clamps to
  `.01ms`); `@media (prefers-reduced-motion: reduce)` is gentler — *"entrances collapse to a quick
  fade (movement is what nauseates; opacity still aids comprehension)"*. Where a clamp would
  leave a misleading artifact it is compensated (the route-pending bar goes to `width: 100%`
  rather than freezing at a 34% stub). `prefers-reduced-transparency` is honored too.
- Animate transforms, not layout properties — *"compositor-only, retargetable mid-flight"*.

**Clean-sheet seed philosophy.** `npm run seed` ships the product baseline and nothing else: the
agent catalog, KBs with real files, skills, the domain allowlist, and a bootstrap admin only when
the users table is empty. **No projects, tasks, notifications, or fabricated run history.** The
mock dataset is a *test fixture* (`npm run seed:demo`). This is R7-2's second half plus the
2026-07-24 clean-sheet ruling: no fabricated credentials, no green-until-probed health, no
simulated evidence. If you need state for a test, build it **through the product's own actions**
or use the fixture — never hand-write a projection row.

**Honesty over reassurance.** The pass-15 UX assessment named this as the product's design voice
and the reason its defects were findable at all. Concretely:

- Every count names its scope ("…in this project", "…across all your projects").
- Refusals are **rendered copy in place**, not a disabled button. A disabled control explains
  itself in visible text — `title` is unreachable on a disabled element for keyboard and touch,
  so a reason that lives only there does not exist.
- A control must not name an outcome its surface cannot promise (R15-11).
- A refusal must not name an escape hatch this surface does not offer (F15-22).
- An omission the reader cannot see is worse than an awkward truth — collapse, never hide
  (R15-12).
- Degraded states are typed values with honest copy, never a crash and never a green pill.
- **No optimistic UI for governed state** — revalidate after the action and on SSE
  (`decisions.md:81`).

**Agents-tag-humans (NEW-4).** Agents and the operator must @tag the human they are answering,
**and the tag must actually notify**. Every comment writer funnels through `notifyMentionedUsers`
(`app/server/tasks/mention-notify.server.ts`). Mention routing is a priority ladder — exact email
local-part, then exact full display name, then a first name unique among enabled users — and a
tie **notifies nobody** and says so on the timeline, *"because guessing is worse than a visible
non-delivery"*. Reserved handles (`agent`, `operator`, `codex`, `claude`) never route to a person.

**RBAC honesty.** `app/shared/rbac.ts` is the single source: the guards consult it and the Policy
page **renders the same object**, so display and enforcement cannot drift. Roles form a strict
tier (viewer ⊂ contributor ⊂ maintainer ⊂ admin) and every action is monotonic. Agent capability
policy is a separate surface with its own vocabulary (`direct | recommend | human | off`) — the
two systems stay visibly separate in the UI because *"governing people and governing agents
aren't the same problem"* (`prd.md:85`). Capability copy states where enforcement actually
happens; a capability with no runtime consumer gets no toggle (ruling 7) and renders under
"Advisory only · N" (R15-12). Owner exceptions (accept-completion, packet resolution,
recommendation apply) are rendered as exception rules, not folded into the role table.

**Identity and state vocabulary.** Compare by user id everywhere; display names are render-only
(ruling 6). Agents are angular violet glyphs, humans are round blue avatars. Readiness is exactly
four values with derivation in **one** module
(`app/server/interpretation/readiness-policy.server.ts`); "accepted" and "merged" are *derived
display* states, never stored readiness (ruling 1). Timestamps are UTC ISO at every boundary,
formatted by one shared module, and any first-paint rendering must be timezone-deterministic
(SSR renders absolute UTC, hydration switches to viewer-local) or it produces a React #418.

**Copy bans and standing rejections.** "govern / governance" never appears in product UI copy —
say *Maintainer*, *Permissions*, "managed". No SDK/exec jargon. The design-iteration rejection
list in `design/CONVERSATION-SUMMARY.md` still binds; check it before adding a panel, a duplicate
button, a legend, or a live indicator.

---

## 7. Verification notes for the next pass

Things checked in the code on 2026-08-04, recorded so nobody re-litigates them:

- **Fixed and confirmed** (raised as residuals by the pass-15 adversarial verifiers, now closed
  in code): the `?_routes=` read leak past the members-only gate — every project loader now calls
  `requireVisibleProject` (`app/routes/project.task.tsx:103`); the writer-lock same-host/same-pid
  short circuit, replaced by a per-process `bootId` (`data-root-lock.server.ts:199-206`); the
  shutdown handler's lazy arming, now an explicit `armProcessShutdown()` at boot
  (`boot.server.ts:209`); `closed` folded into the poller's terminal predicate — deliberately
  excluded, with the reasoning in place (`github-reconciler.server.ts:665-670`).
- **`design/prd.md` is byte-identical to canon** — R15-8 holds; `planning/README.md`'s sync claim
  is true today.
- **The "governance" copy ban holds** — every `govern*` hit under `app/features`, `app/routes`,
  `app/ui` is in a comment or an identifier.
- **`--viberr-*` does not exist** anywhere in `app/` or `design/`. Fix the memory, the
  modernization PLAN and any prompt that says otherwise before an agent invents the prefix.
- `app/routes/project._index.tsx` carries no membership guard of its own; it is a redirect to
  `/board` under the guarded layout, which is why it does not need one. Confirm this stays true
  if it ever renders content.
