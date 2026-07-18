# Goal-completion report — the full mandate, clause by clause (2026-07-18)

The owner's /goal ran across multiple sessions (passes 8 → final acceptance). This is the single
traceability map from **every mandate clause** to its **concrete evidence artifact** (doc / commit /
PR / live observation), written for (a) the implementation-phase reference the mandate asked for and
(b) the external (gpt-5.6) code review. Everything cited is committed in this folder or visible on
github.com/akin-ozer/viberr.

## Clause → evidence matrix

| Mandate clause | Where it happened | Evidence artifact |
|---|---|---|
| "Discover the app by code inspection, documentation, UI navigation… screenshots of each page" | Pass-8 discovery + the fresh critical walk + final acceptance sweep | `code-map.md`, `product-canon-digest.md`, `fresh-discovery-2026-07-18.md` (all 13 surfaces re-walked), `cross-role-ui-walkthrough.md` (per-role screenshots), acceptance sweep of the merged build (10 surfaces, `fresh-20-task-suite-docker-2026-07-18.md` addendum) |
| "be critical regardless… note mocks/unwired/poorly-implemented parts" | Systematic mock audit + adversarial review | `findings.md`, `critical-audit-2.md`, `diff-adversarial-review.md` (4 real defects found in OUR OWN new code, fixed), `style-reviewer-bug.md`, mock audit (verdict: no mocks left) in commit b3f4557 |
| "most up-to-date documentation lives under planning/" honored, "ask about product design choices" | Every contested behavior escalated as an owner question, never assumed | `owner-rulings.md` (R8-1…R8-7), later rulings recorded inline: divergence-dismisses-rec, STAY-ON-MAIN, DON'T-SIMULATE, tool-isolation caution ("check if unused tools make sense first" — which caught that denying ToolSearch would have broken the operator) |
| "we will need to touch role bindings" | Role-binding governance implemented AND exercised | `rbac-audit.md`; matrix-as-source `app/shared/rbac.ts`; set-role suite RB1–RB5 (admin gate + last-admin guard) in `fresh-20-task-suite-docker-2026-07-18.md` |
| "create a good documentation… to refer in implementation phase" | This folder (21 docs) + consolidated index | `MASTER-STATUS.md` (phase status + backlog), `implementation-plan.md`, `TEST-COVERAGE-AND-TODOS.md`, this report |
| "Create new projects, new tasks, new agents, let operator choose correct agents" | Creation flows validated end-to-end | creation-flow validation (new project + new agent profile + operator selection) commit 2419de1; operator agent-selection verified from real artifacts (`agent-runtime-verification.md`) |
| "at least 20 different tasks by different test cases" | Twice, plus organic live load | Pass-8 live catalog: VIB-1…22 (`test-catalog.md`, `phase2-test-log.md`); fresh 20-task suite re-run in the production docker container, 20/20 (`fresh-20-task-suite-docker-2026-07-18.md`); 75+ real agent runs (`simulated:0`) |
| "user assignments, stage transitions, reviewers, secondary assignments, comments, RBAC triggering" | The 20-task matrix covers each explicitly | T02–T16 rows + RB1–RB5 rows in `fresh-20-task-suite-docker-2026-07-18.md` (owner-assign/take, allow+deny transitions per role, reviewer + dual assignment, viewer/non-member comments incl. the FR4 app-wide boundary) |
| "operator behaving correctly" | Walkthroughs from real run artifacts | VIB-169 loop (scope→select→prompt→run→honest failure→packet) in the docker log; VIB-1 live: packet resolution → sharpened re-prompt → delivery → reviewer summoned (owner-driven, observed in Activity) |
| "agents do what they need to do; MCPs work; skills correctly loaded (not unrelated)" | Runtime verification from artifacts + docker | `agent-runtime-verification.md`: docs-style skill injected as prompt text (36-run marker, 0 codex leaks), notes-MCP live (21 calls), viberr governance MCP connected for operator / absent for reviewers; SDK-bundled skill leak found REAL-IN-PROD and denied (`plan-bundled-tool-isolation.md`) |
| "codex and claude work the same from viberr's eye" | Parity proven with codex EXECUTING | Docker log §parity: identical lifecycle both backends; the honest availability gate (F-DOCKER1) and its recurring-trap fix (PR #64) |
| "testing on new project for akin-ozer/viberr… open PRs… merge some with gh, reject some… only small files" | Real PR lifecycle on the actual repo | ~50 PRs across passes + docker-pass PRs #59 (merged, 1-line marker) / #60–62 (rejected → W4 divergence events verified); test-fixture PRs closed unmerged (repo hygiene); `live-delivery-w4-verification.md` |
| "implementation phase… every item… no cut corners, no deferrals" | Every finding/ruling/todo dispositioned, then merged | PR #36 (49 commits — W1–W5, A–D, MED-1, skill-leak, subagent-task family, requireRunAgents, O-1, O-3 scheduled re-runs, divergence-withdraws-recs) MERGED to main; disposition ledger commit e0b9c66 ("nothing open"); PR #63 (react-doctor pass) merged |
| "validate by code, UI screenshots, and browser usage" | Every change validated three ways | Unit suite grown 1298 → 1330 green; live docker verifications; UI walkthroughs with screenshots (cross-role + final acceptance sweep) |
| "allowed to break, no migrations" | Honored | Single consolidated baseline migration; breaking reworks (role-bindings matrix, decision counts) shipped without compat shims |

## What the pipeline actually surfaced (the headline findings, all closed)
1. **SDK-bundled tool/skill leak is real in production** (not the assumed dev-nesting artifact) —
   denied `Skill` + the full subagent-spawn family (`Task`, `TaskCreate/Get/List/Output/Stop/Update`),
   docker-verified 25→19 tools with ToolSearch + `mcp__viberr__*` intact.
2. **Owner-scoped decision counting over/under-counts** (4 adversarial-review defects A–D) — fixed;
   the board's three waiting-signals now measure three different true things (verified live).
3. **GitHub↔task divergence was invisible** — typed event + notification + moot-rec withdrawal (owner
   ruling), live-verified via rejected PRs.
4. **The recurring "Codex broke again" compose trap** — asymmetric credential storage + state-blind
   error + pinned availability cache; all three fixed (PR #64) with a zero-restart live demo.
5. **Copy honesty**: RBAC table now total (17 rows incl. FR4 app-wide), reviewer read-only affordance,
   stale-MCP-health amber, accurate assigned-but-failed operator descriptions, pluralization idiom.

## Current state (2026-07-18 close)
- `main` = the fully-implemented product: PR #36 + #63 + **#64** (codex availability self-heal,
  state-aware unavailable copy, pluralization — owner-approved merge) + **#65** (packet
  supersession, below). Suite **1335 green**, typecheck clean.
- **Both open questions RESOLVED by the owner (AskUserQuestion, 2026-07-18 evening):**
  1. PR #64 → **merged**.
  2. Packet supersession → **auto-withdraw ruled and IMPLEMENTED (PR #65, merged)**: a successful
     run withdraws a stale `type: "blocked"` work-stalled packet about the same agent (subject
     joined on the retry option's profileId; accept_completion packets never touched; timeline
     note + `task.packet.withdrawn_superseded` audit; withdrawal lands BEFORE the operator reacts).
     5 targeted tests drive the real completion-effects pipeline.
  3. Testing phase → **closed by the owner** (the 20-task suite ran twice; the owner hand-drove the
     final acceptance themselves).
- Owner's compose env: **VIB-1 reached Done** under the owner's own hands — create → codex fail →
  packet → "send back" decision → sharpened re-prompt → delivery → review → reviewer → human
  acceptance. The complete governed loop, end to end, on the final build.
