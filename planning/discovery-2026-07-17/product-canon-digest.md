# Viberr product-canon digest — 2026-07-17

Self-contained synthesis of the product docs, cross-checked against current `main`
(HEAD `8041134`, "agent-loop hardening" merged). Sources: `planning/discovery-2026-07-16/canon.md`,
`.../original-intent.md`, `planning/discovery-2026-07-16-pass7/owner-rulings.md`,
`planning/discovery-2026-07-16/owner-rulings.md`, `README.md`, plus code spot-checks
(`app/shared/rbac.ts`, `app/shared/capabilities.ts`, `app/schemas/task-file.schema.ts`,
`docs/architecture/file-formats.md`, `app/server/…`). "Implemented?" flags are best-guess from code
reads, not a full audit.

**Key repo-state fact for this pass:** the pass-6 (R6-x) and pass-7 (R7-x) rulings dated 2026-07-16
now appear IMPLEMENTED on `main` (verified below) — a change from the pass-5 branch situation the
2026-07-16 canon described. The pass-5 `codex/*` branches are reference-only (ruling R6-1); their
work is re-done selectively on `main`.

---

## 1. What Viberr is (product thesis)

- **Governed AI software delivery for small AI-forward teams**: persistent coding agents do the real
  delivery work; engineers govern flow, review, and acceptance. Not "kanban with AI" — an
  agent-native *responsibility* model. (README; original-intent §1)
- **The task file is the canonical operating contract** between humans, agents, and GitHub
  execution: one readable markdown file per task carrying state, execution context, timeline,
  decisions, and evidence. (canon §1; original-intent §1)
- **Files are truth, the database is a rebuildable projection.** Projects/tasks/agent-profiles live
  as markdown under a data root that humans and agents edit directly; a watcher reprojects into
  SQLite for fast reads. SQLite owns app-management only (users, sessions, encrypted secrets,
  projections, audit, notifications) — never business truth. (README; canon §1)
- **A dedicated operator agent coordinates each active task; specialist agent threads do stage
  work; humans govern** through policy, comments, decision packets, and explicit acceptance of
  completion. Review stays human-authorized. (original-intent §1,§4)
- **GitHub is the execution surface** (task key ↔ branch ↔ commits ↔ PR, never a fake merge), and
  everything degrades honestly without credentials (typed "no credential" states, never a crash).
  (canon §1; README)

---

## 2. Canonical objects

Files = canonical truth under the data root (`data/…`; `VIBERR_DATA_ROOT`). DB
(`data/state/projection.sqlite`) = rebuildable projection + app-owned tables. Spec:
`docs/architecture/file-formats.md`; schemas: `app/schemas/`.

| Object | What it is | Where it lives |
|---|---|---|
| **Project** | Stages (default Governed 5 / Lightweight 3), per-transition boundaries, members[] (4 project roles), agent deployments + capability grants, guardrails, credentialPolicy, `archived` flag. | File: `data/projects/<slug>/project.md` (frontmatter). Projected to DB. |
| **Task** | The operating contract: scalar frontmatter + 3 body sections. | File: `data/projects/<slug>/tasks/<KEY>/task.md`. Projected to DB. |
| → task **frontmatter** | `key, title, stage, readiness (ready\|input_required\|inconsistency_risk_detected\|blocked), waiting (human\|agent\|none), ownerUserId, specialist (agentRef), reviewers (agentRef[]), operator (operatorRef), recommendations[], urgent, validation (healthy\|changed\|failing), branch, repo, pr, github(cache), createdAt, updatedAt, boardRank`. Unknown fields preserved round-trip. | `app/schemas/task-file.schema.ts` (`taskFrontmatterSchema`). |
| → task **body** | `## Goal` (what "done" means; agents anchor on it), `## Packet` (present only while a packet is open), `## Timeline` (typed events, newest-first). | task.md body sections. |
| **Packet** (decision/blocking) | Operator-authored: kind pill (blocked/input), observations grid (key→value), 2–4 options with one operator "pick", body follows observed→changed→recommended→decision. Also `recommendations[]` = one-click action cards (assign/run specialist, transition…) in frontmatter. | task.md `## Packet` (fenced yaml) while open; recommendations in frontmatter. |
| **Agent profile** | Reusable spec: capabilities (mode `direct\|recommend\|human\|off`), resources (skills/KB/MCP), backend (`claude\|codex`, exactly one), model, eligible stages (enforced). Persona prose is separate. | File: `data/agents/profiles/<id>.md` (+ `data/agents/definitions/<id>.md` prose). |
| **Run** | One agent execution: `startRun` → claude/codex adapter (or the gated test-only adapter). Raw wire envelopes persisted; run rows carry state/backend/simulated flag. | Raw JSONL: `data/runtimes/<backend>/<runId>.jsonl`. Rows: DB `agent_runs` (app-owned). Specialist cwd: `<taskDir>/workspace`. |
| **Comment** | A typed `comment` timeline event; app-wide (any authenticated user, non-members labeled); `@operator`/`@agent`/`@name` mentions route to agents. | task.md `## Timeline`. |
| **Decision** | Human/operator resolution of a packet or a recommendation; the *acceptance of completion* is the terminal decision. Surfaced as typed events (input/blocked/completion) + audit rows. | task.md `## Timeline` + DB audit. |
| **Timeline event** | Single typed chronology: `comment, agent, github, quality, transition, input, blocked, completion, assign, policy`. Newest-first; compressed past ~40 events (typed events always kept). | task.md `## Timeline`. |

App-owned DB-only (never in files): users, sessions, encrypted secrets/PATs, audit,
notifications, derived readiness/"accepted" display state.

---

## 3. Governance model

- **Stages.** Project-defined, ordered. Default **Governed 5**: Triage → Ready → In Progress →
  Review → Done. **Lightweight 3** alternative. Triage-first / Done-last locks; non-empty-stage
  guards on edit. Readiness (4-value enum) is separate from workflow stage.
- **Transition boundaries** per edge: `auto` | `approval` | `human`. **Review→Done is structurally
  locked `human`.** Default flow: Triage→Ready `approval` (after the quality gate), Ready→In
  Progress `auto` (operator advances once a specialist is assigned), In Progress→Review `approval`,
  Review→Done `human` (acceptance only).
- **CRITICAL boundary semantics (ruling 31 / R-2026-07-12-6):** boundary settings govern **HUMANS
  only**. An operator with `stage-transitions: direct` can cross `approval`/`human` boundaries; only
  Review→Done stays structurally locked. The fix for the mismatch was honest Policy copy, not
  enforcement.
- **Two orthogonal role surfaces** (never mixed): **human RBAC** and **agent capability policy**.
  - Human roles: **2 org** (`admin` | `member`; better-auth `member` table authoritative) + **4
    project** (`admin` ⊃ `maintainer` ⊃ `contributor` ⊃ `viewer`). Single source
    `app/shared/rbac.ts` `ACTION_ROLES` (16 actions). Tiers (Q5 clean tiering): view/comment
    app-wide; contributor+ = create-task, own-task, reconcile-github; maintainer+ =
    approve-transition, resolve-packet, accept-completion, run-agents, reorder-board, update-goal,
    grant-github-scope, rescan-project; admin = release-any-ownership, manage-members, manage-agents,
    edit-policy.
  - Agent capability policy: per-capability grant mode `direct/recommend/human/off`.
    `ALWAYS_HUMAN_CAPABILITY_IDS` = **merge-pull-request, transition-to-done, change-project-policy**
    (coerced to `human`, structural). Enforcement is REAL on Claude (withheld repo-mutating caps →
    `disallowedTools` Bash deny; binds under bypassPermissions). Codex = prompt-only ("advisory",
    honest labels). Specialist picker now offers **3 modes** Allowed/Human-only/Off (R7-5).
- **Who owns what movement.** Operator auto-advances well-scoped triage→ready and ready→in-progress;
  a maintainer+ (or operator-direct) approves in-progress→review; the operator may move
  **Review→In Progress backward** on a failing reviewer verdict (R7-4); **only a human takes a task
  to Done** (acceptance).
- **Acceptance semantics.** `acceptCompletion` = the sole path to Done: real merge → `pr.state
  merged`; otherwise `accepted` (merge-pending) + a later "Complete merge" action — **never a fake
  merge**. Accept **refuses a `failing`-validation task (409)**. Authority is maintainer+ (ACTION_ROLES),
  **plus the task's human owner as a contributor** (R6-2 owner exception). **Dragging Review→Done =
  the same acceptance path** as the Review-queue button (R6-4). Human-only-Done invariant has one
  audited exception: full-autonomy operator with explicit `completion-for-acceptance: direct`.
- **Archive** is now **read-only enforced** server-side (R6-3): archived projects block mutations
  (tasks/comments/runs/policy/settings except restore); restore stays admin-gated.

---

## 4. Operator vs specialist

**Operator** — one persistent instance per *active* task (none in Triage), system role, never
user-deletable, Claude-backed, single-flight per-task lease.
- *Can (acts directly):* assign the primary specialist; summon/prompt reviewers; author decision &
  blocking packets; append typed timeline events (ONE comment per turn, plan folded in); compress
  long timelines; transition stages **where granted** (`stage-transitions: direct` crosses
  human/approval boundaries per ruling 31); move Review→In Progress backward on a failing verdict
  (R7-4); accept completion **only** with explicit `completion-for-acceptance: direct`.
- *Can't:* write code / mutate the repo; merge a PR; transition to Done on its own; change project
  policy (the three `ALWAYS_HUMAN` caps). It never launders a `failing` validation.
- *React loop:* agent completion → operator reacts; depth cap 4; no-progress guard → stuck-loop
  recovery packet; boot recovery replays unreacted runs and re-invokes the operator for real
  orphaned runs.
- *Specialist selection (D3 intelligent routing):* viberr **hard-filters impossible candidates**
  (stage-ineligible / capability-ineligible) and supplies skill/KB/MCP fit, backend availability,
  org-wide workload, and observed cost; **the operator makes the final selection** — no static
  winner score; durable routing-intent ids. Operator pickers filter by current stage; a
  stage-ineligible engaged agent is SKIPPED, never halted on.

**Specialists** — do the stage work in an isolated `<taskDir>/workspace` (per-run
`GIT_CEILING_DIRECTORIES`). Roster after rulings: **Developer** (Ready/In Progress; Claude+Codex —
branch/commit/push/validate/open review PR) and **Reviewer** (Review; Claude — read diff, run
validation, post quality verdicts; absorbed the old Tester). Advisor/Consultant removed (operator
absorbs advisory duties via packets). Eligible stages enforced at BOTH assign and run boundaries.
Every reviewer completion runs `classifyReviewerVerdict` → typed `quality` event + task `validation`;
a rejection sticks until real rework; multi-reviewer contract requires all current reviewers to
approve.

---

## 5. Owner rulings ledger (every numbered ruling)

Legend — Implemented?: ✅ on `main` (spot-checked), ✅~ believed on `main` (not spot-checked),
⚠️ flag = possibly NOT fully implemented / needs confirmation, N/A = process/meta ruling,
SUPERSEDED = later ruling overrides.

| ID | One-line decision | Implemented? |
|---|---|---|
| **1 (A)** | 4 project roles admin/maintainer/contributor/viewer (reviewer→contributor) | ✅ (`rbac.ts`) |
| **2 (B)** | Project creation self-serve for any org member | ✅~ |
| **3 (C)** | Specialist capabilities ENFORCE via disallowedTools (Claude) | ✅ (`specialist-tool-policy`) |
| **4 (D)** | Archive = hide+separate only, NOT read-only | **SUPERSEDED by R6-3** (now read-only) |
| **5** | better-auth Option B; org roles admin/member only, org `viewer` deleted | ✅ (better-auth 1.6.23) |
| **6 (A)** | Advisor/Consultant profile REMOVED | ✅~ |
| **7 (D1-p1)** | Tester MERGED into Reviewer | ✅~ |
| **8 (E)** | Operator folds plan into action comment — ONE timeline entry/turn | ✅~ |
| **9 (S1)** | Policy presets (strict/balanced/auto) wired to REAL governance | ✅~ |
| **10 (S2)** | "Accepted, merge-pending" PRs get a "Complete merge" action | ✅ (`completeTaskMerge`) |
| **11 (S3)** | Codex tool confinement = DOCUMENTED gap (honest labels) | ✅ (standing gap) |
| **12 (D2-p1)** | triage→ready is an `auto` boundary in the governed template | ✅~ |
| **13 (D3-p1)** | Accept NEVER claims a merge that didn't happen — distinct `accepted` | ✅ (`pr.state` vocab) |
| **14 (D4)** | One-click "retry on the other backend" on quota/availability failure | ✅~ |
| **15** | notif routing real; `scheduleOperatorRun` deleted; "governance" banned in UI; no email; PAT-only; OAuth whitelist | ✅~ |
| **16 (Q1)** | Acceptance requires EXPLICIT `completion-for-acceptance: direct` | ✅~ |
| **17 (Q2)** | Task OWNER resolves non-completion packets; accept admin\|maintainer | ✅ (owner exception); accept partly **SUPERSEDED by D1/R6-2** |
| **18 (Q3)** | Anti-noise guardrails enforce for REAL on the canonical record | ✅~ |
| **19 (Q4)** | Capability catalog pruned + key caps wired; email prefs schema deleted | ✅~ |
| **20 (Q6)** | Home membership-scoped; org-admins see all | ✅~ |
| **21 (Q7)** | FULL workspace isolation (cwd=workspace + GIT_CEILING_DIRECTORIES) | ✅~ |
| **22 (Q8)** | Codex/Claude runs bound by IDLE timeout (not wall-clock) | ✅~ |
| **23** | Honest empty slate: 0 MCP / 0 GitHub / 0 PATs seeded | ✅ (README) |
| **24 (Q5 / R-07-12-1)** | CLEAN TIERING: viewer strictly read+comment; contributor +create-task/own | ✅ (`rbac.ts`) |
| **25 (R-07-12-2)** | Agent eligible stages: WIRE IT (assign + run + pickers) | ✅~ (`assertStageEligible`) |
| **26 (R-07-12-3)** | Review queue + Activity: membership-gate both | ✅~ |
| **27 (R-07-12-4)** | S3 = HONEST LABELING ONLY, no Codex enforcement | ✅~ |
| **28 (F11)** | `edit-other-task-branch` capability REMOVED | ✅~ |
| **29 (R-07-12-5)** | STRICT single-source RBAC + better-auth org-role cutover | ✅ (`ACTION_ROLES`) |
| **30 (R-07-12-6)** | Boundary settings govern HUMANS only; operator-direct may cross | ✅ (honest copy) |
| **31 (R-07-12-7)** | Prune FAKE capability toggles (display honesty) | ✅~ |
| **32 (R-07-12-8 / D4)** | MCP creds: WIRE REAL `secret://` injection at run spawn | **✅ runtime** (`specialist-mcp.server.ts`, Claude-only) / **⚠️ UI not built** (README gap) |
| **33 (D1, owner)** | Contributor who OWNS a task may accept its completion | ✅ (R6-2 owner exception verified) |
| **34 (D2, owner)** | Org admins get audited emergency project-admin authority w/o membership | ✅ (R7-1 `project-authority.server.ts`) |
| **35 (D3, owner)** | Operator makes the final agent-selection (intelligent routing) | ✅~ ⚠️ depth/quality unverified |
| **D5** (working) | Fail-closed on Claude ambient skill/plugin leakage | ⚠️ pass-5-branch origin; main status unconfirmed |
| **D6** (working) | Archive = read-only history | **SUPERSEDED→adopted by R6-3** ✅ |
| **D7** (working) | No manual jump to Done | **REJECTED by R6-4** |
| **D8** (working) | Deletion purges all project-keyed state | ⚠️ delete exists (`project.deleted` audit); full purge unconfirmed |
| **D9** (working) | Referenced KB/skill/MCP rename/delete blocked | ⚠️ unconfirmed on main |
| **D10** (working) | Atomic stage-graph edits | ✅~ unconfirmed |
| **D11** (working) | Repo-backed terminal contract (stay in Review until real merge) | **REJECTED by R6-4** |
| **D12** (working) | Simulated runs produce no governance evidence | **SUPERSEDED→adopted by R6-5/R7-2** ✅ |
| **D13** (working) | Org-wide read visibility stands | ✅~ |
| **D14** (working) | Seeded demo runs must not count as live workload | ✅ (R6-5) |
| **D15** (working) | Multi-reviewer contract (all current reviewers approve) | ✅~ unconfirmed |
| **R6-1** | STAY ON MAIN; pass-5 branches reference-only | N/A (process) |
| **R6-2** | Accept-completion owner-exception (confirms D1) | ✅ (`ownerException`, `requireAcceptCompletion`) |
| **R6-3** | Archive READ-ONLY ENFORCED (adopts D6, supersedes ruling 4) | ✅ (`requireProjectMutable`, `archive-readonly` test) |
| **R6-4** | Done boundary DRAG = ACCEPTANCE (confirms H4, rejects D7/D11) | ✅ (governance test) |
| **R6-5** | Seeded demo runs removed from rollups + stop re-animating at boot | ✅ (`finalizeOrphanedRuns`, `run-recovery`) |
| **R7-1** | Role-bindings cleanup + implement D2 (org-admin override, audited) | ✅ (`project-authority.server.ts`, `project.org_admin.override` audit) |
| **R7-2** | DON'T SIMULATE AT ALL (product no fallback; seed no fake runs; e2e gated) | ✅ (`simulatedRuntimePermitted` fail-closed gate) |
| **R7-3** | Honest split: member mgmt on `manage-members`, not `edit-policy` | ✅ (`manage-members` distinct in `ACTION_ROLES`) |
| **R7-4** | Failed review: OPERATOR MAY TRANSITION BACKWARD (Review→In Progress) | ✅ (`operator-actions` rework routing) |
| **R7-5** | Specialist capability picker COLLAPSE TO 3 MODES (Allowed/Human-only/Off) | ✅ (`create-profile-modal`, agents test) |
| **R7-6** | Done tasks stay commentable (subtle "closed" hint, no freeze) | ✅ (`timeline.tsx`) |

**Flagged as possibly NOT fully implemented / worth confirming:** ruling 32/D4 (MCP secret
injection works at runtime for **Claude only**; **Codex connects unauthenticated** by design due to
the argv-exposure gap, and the **management UI is unbuilt** per README); D3/35 (operator routing —
present but selection quality/inputs not spot-verified); working rulings **D5, D8, D9, D10, D15**
(pass-5-branch origin, not adopted by an explicit R6/R7 ruling — main status unconfirmed); the
**Codex argv secret exposure** is explicitly NOT fixed anywhere (owner scoped security out).

---

## 6. Open product questions / tensions for the owner

Most cross-pass contradictions in the 2026-07-16 canon (§6) have since been RESOLVED by the R6-x/R7-x
rulings and implemented on `main` (archive read-only, drag=acceptance, owner-accept, org-admin
override, no-simulation). The questions below are the ones that still look genuinely open.

1. **Is Done-boundary acceptance reconcilable with the repo-backed terminal contract?** R6-4 (drag =
   acceptance, can go to Done merge-pending) explicitly rejected D11 (stay in Review until a real
   merge). *Why it matters:* a task can now reach Done with `pr.state=accepted` and no merge — the
   very "claimed-but-unmerged" ambiguity the traceability invariant guards against. Is the
   merge-pending Done state acceptable long-term, or should unmerged tasks visibly block Done?

2. **Codex remains structurally un-governable — is "advisory + honest label" the permanent answer?**
   Capability enforcement is Claude-only; Codex ignores disallowedTools AND leaks MCP secrets via
   argv (`ps`-visible). *Why it matters:* any Codex-backed specialist can perform withheld
   repo-mutating actions and expose credentials; the product ships this as a labeled gap. Confirm
   this is acceptable for V1, or scope a real Codex sandbox (separate OS user/container).

3. **Should MCP credentials be fully productized?** Runtime injection exists (Claude-only) but the
   management UI is unbuilt and Codex connects unauthenticated. *Why it matters:* org admins can
   register MCP servers but not attach/rotate credentials in-app, and Codex silently connects
   without auth — a partial feature that may surprise operators.

4. **Which pass-5 working rulings (D5, D8, D9, D10, D15) are actually canon on `main`?** They were
   never adopted by an explicit R6/R7 ruling and their main-code status is unconfirmed. *Why it
   matters:* fail-closed skill leakage (D5), purge-on-delete (D8), referenced-resource delete blocks
   (D9), atomic stage-graph edits (D10), and the all-reviewers-approve contract (D15) are each a real
   safety/data-integrity behavior — leaving them ambiguous risks half-implemented governance.

5. **Full-autonomy acceptance: is the single audited human-only-Done exception still wanted?** Q1
   grants a full-autonomy operator `completion-for-acceptance: direct` to accept without a human.
   *Why it matters:* it's the one hole in the flagship "review stays human-authorized" invariant; a
   reviewer of the product should confirm it's intentional and adequately audited/disclosed.

6. **Backward operator transitions (R7-4) have no attempt cap.** The drift doc notes
   `finalizeOrphanedRuns` re-invokes the operator on every boot with no backoff, and R7-4 adds an
   operator-driven Review→In Progress edge. *Why it matters:* combined, a failing task could
   ping-pong or crash-loop-amplify with no governed ceiling — should there be a rework-attempt cap
   before it escalates to a human packet?

7. **Simulation is banned in product — is the e2e-only adapter's isolation sufficient?** R7-2 removes
   all simulated fallback; a deterministic test adapter survives behind an env flag (fail-closed
   outside test). *Why it matters:* the whole demo/onboarding experience now shows honest "backend
   unavailable" errors with no credentials — confirm that's the intended first-run experience (the
   seed no longer ships fake run history).

8. **D3 intelligent routing has no static score — how is "final selection" made auditable?** Viberr
   hard-filters, then the operator picks using workload/cost/fit. *Why it matters:* without a visible
   ranking, the routing decision is opaque; owners may want a durable, inspectable rationale on the
   task (routing-intent ids exist — are they surfaced?).

9. **"Reconcile-github" vs "rescan-project" tiering.** `ACTION_ROLES` puts `reconcile-github` at
   contributor+ but `rescan-project` at maintainer+. *Why it matters:* both are projection/GitHub
   reconciliation affordances; the split may be intentional (write vs read reconcile) or an
   inconsistency worth confirming against the "clean tiering" intent.

10. **Org-admin emergency override: any rate-limiting or notification, or audit-only?** R7-1
    implements audited project-admin authority for org admins on non-member projects. *Why it
    matters:* it's a deliberate break of the "member-scoped mutation" model; confirm whether the
    project's actual admins should be *notified* when an org admin acts, not just have it in the log.

11. **Guardrail compression at ~40 events on long-running tasks.** The #1 PRD risk is timeline noise;
    compression keeps typed events but drops chatter past a threshold. *Why it matters:* on very
    long tasks, is 40 still the right threshold, and does compression ever hide context an operator
    needs to re-anchor?

12. **Repos-per-task = 1 (V1 limit).** *Why it matters:* real delivery tasks often span a service +
    its client/infra repo; confirm this stays a hard V1 boundary or is a near-term expansion.

---

## Executive summary (12 lines)

1. Viberr = governed AI software delivery: agents are the native workers, humans govern flow/review/acceptance.
2. The **task markdown file is the canonical contract**; SQLite is a rebuildable projection (app-owned data only).
3. Canonical objects: project.md, task.md (frontmatter + Goal/Packet/Timeline), agent profiles, runs (JSONL), typed timeline events.
4. Governance = two orthogonal surfaces: human RBAC (2 org + 4 project roles, `ACTION_ROLES` single source) and agent capability policy (`direct/recommend/human/off`, 3 ALWAYS_HUMAN caps).
5. Stages have `auto/approval/human` boundaries; **boundaries govern humans only** — an operator-direct can cross them; Review→Done is structurally human-locked.
6. **One operator per active task** coordinates (packets, assignment, transitions, backward-on-fail); it never writes code, merges, or self-accepts (except full-autonomy `direct`).
7. Specialists (Developer, Reviewer) do isolated-workspace stage work; eligible stages + capabilities are enforced on Claude (Codex is prompt-only, a labeled gap).
8. Acceptance is the sole path to Done: real merge → `merged`, else `accepted`/merge-pending; refuses `failing`; owner-exception + drag=acceptance both allowed.
9. All pass-6 (R6-x) and pass-7 (R7-x) rulings dated 2026-07-16 now appear **implemented on `main`** — a resolution of the pass-5-branch contradictions the old canon flagged.
10. Adopted from pass-5: contributor-owner accept (R6-2/D1), org-admin override (R7-1/D2), read-only archive (R6-3/D6), no-simulation (R7-2/R6-5/D12). **Rejected**: D7/D11 (via R6-4).
11. Standing gaps worth flagging: Codex un-confinable + argv secret leak (security scoped out), MCP-cred UI unbuilt, several pass-5 working rulings (D5/D8/D9/D10/D15) unconfirmed on main.
12. Remaining genuine tensions: merge-pending Done vs traceability, un-capped operator backward loops, full-autonomy human-only-Done exception, opaque routing, no-simulation first-run experience.

---

### Top 6 candidate owner-questions (verbatim)

1. **Is Done-boundary acceptance reconcilable with the repo-backed terminal contract?** A task can now reach Done with `pr.state=accepted` and no merge (R6-4 rejected the "stay in Review until merged" rule) — is merge-pending Done acceptable long-term, or should unmerged tasks visibly block Done?

2. **Codex remains structurally un-governable — is "advisory + honest label" the permanent answer?** Codex ignores disallowedTools and leaks MCP secrets via argv; a Codex specialist can perform withheld repo-mutating actions and expose credentials. Acceptable for V1, or scope a real Codex sandbox?

3. **Which pass-5 working rulings (D5 fail-closed skill leakage, D8 purge-on-delete, D9 referenced-resource delete blocks, D10 atomic stage-graph edits, D15 all-reviewers-approve) are actually canon on `main`?** None was adopted by an explicit R6/R7 ruling and their code status is unconfirmed.

4. **Full-autonomy acceptance: is the single audited human-only-Done exception still wanted?** `completion-for-acceptance: direct` lets a full-autonomy operator accept without a human — the one hole in "review stays human-authorized." Intentional and adequately disclosed?

5. **Backward operator transitions (R7-4) have no attempt cap, and boot re-invokes the operator on every orphan with no backoff.** Should there be a rework-attempt ceiling before a failing task escalates to a human packet, to prevent ping-pong/crash-loop amplification?

6. **Simulation is now banned in product (R7-2) — is the honest "backend unavailable" first-run experience intended?** With no credentials the demo shows errors and the seed ships no run history; confirm that's the wanted onboarding, versus a guided credential setup.
