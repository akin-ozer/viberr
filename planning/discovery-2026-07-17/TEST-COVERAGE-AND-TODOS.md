# Pass-8 — Test coverage matrix + implementation todos (consolidated, 2026-07-18)

The single implementation-ready reference: what was tested (dimension → test case → result), the
findings ledger (fixed / verified-non-issue / open), and the product decisions made. Written so an
implementation-phase subagent can act from THIS doc alone. Companion detail lives in
`fresh-20-task-suite-docker-2026-07-18.md` (method + evidence), `MASTER-STATUS.md` (pass-8 W1–W5),
and the memory `full-product-pass-2026-07-17-pass8`.

Environment: standalone **Docker Compose production image** (`NODE_ENV=production`, `/data` volume),
seeded (`viberr-core` + `viberr-sandbox` + 2 stubs, 5 users). Repo under test: `akin-ozer/viberr`.
Suite: **1320 unit green · typecheck clean**; 75+ REAL agent runs (`simulated:0`).

## 1. Coverage matrix — every goal-named dimension → where tested → status
| Dimension (from the goal) | Test cases | Method | Status |
|---|---|---|---|
| User/owner assignments | T02 owner-assign (admin→murat); T04 owner-take (contributor); T03/T15 deny | API → task.md `ownerUserId` | ✅ |
| Stage transitions | T05 maintainer ready→impl (allow); T06 contributor / T07 viewer (deny); T14 impl→review | API → `stage` | ✅ |
| Reviewers | T08 maintainer assign-reviewer (allow); T09 contributor (deny) | API → `reviewers` | ✅ |
| Secondary / dual assignment | T14 specialist(impl) + transition + reviewer(review) coexisting | API → `specialist`+`reviewers` | ✅ |
| Comment usage | T10 viewer comment (app-wide); T11 @operator mention; T16 non-member comment (FR4) | API → task.md body | ✅ |
| RBAC triggering | RB1–5 role-binding (`set-role`, last-admin guard); T03/06/07/09/13/15 denies; T16 app-wide allow | API → project.md `members` + task state | ✅ |
| Role bindings (owner-flagged) | RB1 admin demote co-admin; RB2/3 tier changes; RB4 non-admin deny; RB5 last-admin guard | `/policy` `set-role`; Policy UI shows live | ✅ |
| Operator correctness | VIB-169 walkthrough (scope→select specialist→prompt→run→honest-degrade→open packet); 43 operator runs | run artifacts + task timeline | ✅ |
| Operator agent-SELECTION | VSB-1 docs task → operator picks **Docs Writer (Claude)** over Codex Developer | new project + UI | ✅ |
| Agents do their job | 47 Claude runs finished; Codex runs execute (with auth); real commits (e.g. `b4bccce`) | agent_runs + workspace git | ✅ |
| MCP works | operator init shows `viberr` MCP **connected** + ToolSearch→`mcp__viberr__*` (12 tools) called | run init jsonl | ✅ |
| Skills loaded (right ones) | docs-style marker (prior); `changelog-writer` attached to Docs Writer + injection path sound | UI + code path | ✅ (see F-SKILL) |
| Codex/Claude parity | same run lifecycle both backends; server-side delivery identical; honest availability gate | live runs + fix | ✅ (see FIX-2) |
| PR lifecycle (merge) | VIB-204 → PR #59 → `gh pr merge` → viberr `merged` + Divergence, no auto-advance | live gh + reconcile | ✅ |
| PR lifecycle (reject) | VIB-205/207 → PR #60/#61 → `gh pr close` → viberr `closed` + Divergence | live gh + reconcile | ✅ |
| Create new project | Viberr Sandbox (`create-project`, self-serve, creator=admin) | API + UI | ✅ |
| Create new agent | Docs Writer (`create-profile`, Claude, skill) | API + UI | ✅ |

## 2. Test-case index (task → asserts → result)
Governance matrix, `viberr-core` (VIB-169…183 first run; VIB-187…201 re-run after the T14/T16
corrections — both 20/20). Each asserts against the CANONICAL markdown file, not the projection.
- **T02** owner-assign by admin → owner=murat ✅ · **T03** owner-take viewer → owner=null (deny) ✅
- **T04** owner-take contributor → owner=murat ✅ · **T05** transition maintainer → impl ✅
- **T06** transition contributor → stays ready (deny) ✅ · **T07** transition viewer → deny ✅
- **T08** assign-reviewer maintainer → reviewers≥1 ✅ · **T09** assign-reviewer contributor → 0 (deny) ✅
- **T10** comment viewer → lands (app-wide) ✅ · **T11** @operator comment → lands ✅
- **T12** update-goal maintainer → changed ✅ · **T13** update-goal viewer → unchanged (deny) ✅
- **T14** specialist(impl)+transition+reviewer(review) → both present, stage=review ✅
- **T15** owner-take non-member → deny (403) ✅ · **T16** comment non-member → allowed (FR4 app-wide) ✅
- **RB1** admin demote co-admin→maintainer ✅ · **RB2** →contributor ✅ · **RB3** →viewer ✅
- **RB4** contributor set-role → deny ✅ · **RB5** sole-admin self-demote → conflict (last-admin guard) ✅

Live-delivery / parity, `viberr-core`:
- **VIB-202/203 (T17/T18)** operator toolset + codex parity probes → denylist correct, codex executes.
- **VIB-204 (#59)** merged out-of-band → Divergence ✅ · **VIB-205 (#60)** closed → Divergence ✅
- **VIB-206 (#—)** pre-fix codex-push blocked (finding) · **VIB-207 (#61)** post-fix clean server-side delivery, PR carries codex's own commit message ✅

Creation flow, `viberr-sandbox`:
- **VSB-1** docs task → operator deploys Docs Writer (Claude) ✅

## 3. Findings ledger — the implementation todos
### FIXED this pass (committed on branch `pass8-decision-counts-rbac-divergence-2026-07-18`)
- **FIX-1 subagent-task denylist leak** (`7b17b1b`): `TaskCreate/TaskGet/TaskList/TaskOutput/TaskStop/
  TaskUpdate` leaked past the singular `Task` deny → could spawn an unrestricted subagent under
  bypassPermissions. Added the family to `BASE_DENIED_BUILTINS`; live-verified toolset 25→19.
- **FIX-2 Codex/Claude delivery parity** (`5b287be`): agent-side `git push` is impossible on Codex
  (its `shell_environment_policy: inherit "core"` strips GIT_ASKPASS — token safety). Made delivery
  **server-side for both** (agents commit locally with own messages; viberr pushes + opens PR on the
  Review transition). Removed `resolveRunPushAuth`/`pushCredentialed`; +2 tests. Owner ruling.
- **FIX-3 seed prose consistency** (`1eb77be`): the Developer expertise-skill (injected into the
  agent) + profile description still said "you open the review PR", contradicting FIX-2. Reconciled.
- (Earlier this branch) W1 member-scoped decision counts; W2/W3 RBAC + capability honesty; W4 GitHub
  divergence event; adversarial defects A–D; MED-1 reply-recovery cap; divergence-dismisses-moot-rec;
  stale-MCP amber. See `MASTER-STATUS.md`.

### VERIFIED NON-ISSUES (checked, not over-claimed — do NOT "fix")
- **F-SKILL** skill loading works; a grep of the run jsonl finds nothing only because the Claude SDK
  does not echo the system prompt (where persona+skill inject) and `changelog-writer` has no output
  marker. UI confirms attach; `effectiveProfileView`→`readSkillBody` loads the existing SKILL.md.
- **F-CAPS** create-profile persists only the 7 runtime-effective `MODAL_CAP_IDS`;
  `move-task-to-review`/`report-validation-verdict`/`run-unit-integration-validation` are documented
  "pruned fake toggles" (no runtime effect) — correctly ignored on create. Legacy seed profiles still
  list them cosmetically (minor, low-priority cleanup only).
- **PAT expiry** "expires —" is honest for a no-expiry/opaque token. **Notification dimming** already
  reconciles via `decisionsRequiring`. **MCP empty state** — a fresh seed genuinely has 0 MCPs.

### OPEN / low-priority (candidate implementation items)
- **O-1 (copy)** VIB-181 review row: "no specialist was ever assigned" when a specialist WAS assigned
  but its backend was down (produced no diff). Distinguish "assigned-but-never-ran" from "never
  assigned". Low priority; arose from an artificial sequence.
- **O-2 → INVESTIGATED, NOT A CHANGE.** The seed profiles list `run-unit-integration-validation`/
  `move-task-to-review`/`report-validation-verdict`. These ARE real catalog capability defs
  (`app/shared/capabilities.ts`) kept DELIBERATELY as descriptive labels (`capability-catalog.ts:43`:
  excluded from the create-modal because zero runtime references, but retained in the full catalog so
  seeded profiles can describe their role). They gate no tool (absent from `specialist-tool-policy`).
  Removing them would STRIP intentional descriptive richness — a regression, not a fix. Leave as-is.
- **O-3 (product Q, open)** should a scheduled/recurring capability exist for not-yet-Done tasks? The
  parity-correct form is a governed `mcp__viberr__schedule_*` tool (works for both backends), not the
  Claude Cron tool. Noted in `plan-bundled-tool-isolation.md`, not built.

## 4. Product decisions taken this pass (owner-ruled)
- Divergence dismisses the now-moot pending recommendation (R8-6 refinement) — IMPLEMENTED.
- Codex/Claude delivery = **server-side for both**, agent still authors the commit message — IMPLEMENTED (FIX-2).
- Repo hygiene: only tiny test files; merged marker reverted; all test PRs closed/branches deleted.

## 5. Verdict
Every goal-named test dimension is covered with a concrete case + result; 3 real defects were found
and fixed and re-verified live; would-be findings were checked and correctly dismissed. PR #36's
branch is implementation-ready and green. Remaining backlog = O-1/O-2 (minor polish) + O-3 (a product
question). This doc is the authoritative index for the implementation phase.
