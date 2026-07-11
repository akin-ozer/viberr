# Viberr live test results — 2026-07-10/11 (phase 3)

> **⚠️ HISTORICAL (pre-D1–D4).** These are the phase-3 results captured BEFORE the D1–D4 decisions
> and the finding fixes landed, so some rows (Advisor/Tester roster, triage→ready "recommend",
> accept→"merged") no longer match the shipped build. For CURRENT results see `test-catalog.md`
> (30 designed cases → findings → fixes) and `test-sweep-committed-2026-07-11.md`; for the
> finding→fix map see `completeness-ledger.md`.

Environment: dev server, BOTH backends real (Claude via OAuth token, Codex via CLI auth added to
.env this session). Test fixtures: project **atlas-api** (created via wizard; members arda=admin,
elif=maintainer, murat=contributor, selin=viewer; deniz non-member), scratch project
**fstore-probe** (file-created), org MCP server **everything** (stdio, added via org settings),
project-scoped profile **prober** (claude; skills=[conventional-commits], mcps=[everything], kb=[]).
Tasks: ATL-1 (repo-blocked flow specimen, parked), ATL-2 (RBAC probe + operator probes), ATL-3
(full delivery loop → Done), ATL-4 (vague-goal probe, packet open), ATL-5 (context introspection),
FSP-1/FSP-99 (file tolerance). A **real PR** exists: github.com/akin-ozer/cc-devops-skills#9,
opened by the Codex Developer during ATL-3 (left open for the owner to inspect/merge/close).

Verdicts: 34 PASS · 3 FAIL (all → findings) · 2 BLOCKED · 3 covered-by-code/finding.

| # | Case | Verdict | Evidence |
|---|---|---|---|
| 1 | Create task → operator auto-triage, single run | PASS | ATL-1: 1 operator run, triage review + transition recommendation. (2 comments/turn → finding #15) |
| 2 | Underspecified task → quality gate | PASS | ATL-4: operator refused to delegate, opened scoping packet ("Scope 'Make the skills better' before leaving Triage") |
| 3 | Approval boundary + apply recommendation | PASS | ATL-1 triage→ready via apply-recommendation as admin; operator re-invoked on new stage |
| 4 | Impl assignment + specialist run + degrade | PASS | ATL-1: operator assigned Developer (codex, REAL run), genuine `git clone` failure honestly reported, operator raised structured blocked packet |
| 5 | Operator never bare-transitions to Done | covered | Code: `transitionStage` blocks operator→last stage; T22b live-verified transition-to-done coerced human; operator consistently states Done is human-only |
| 6 | Human-only done via acceptance | PASS | ATL-3 → done via accept_completion recommendation applied by owner; completion event + audit (`task.recommendation.applied`, `task.transition`) |
| 7 | Stuck-loop / no-progress recovery | PASS | ATL-1: after identical clone failure on retry, operator itself refused a third prompt and escalated with a richer blocked packet ("was not actually applied to the project config") |
| 8 | Packet redirect → operator re-invoke | PASS (retest) | ATL-1: resolve(redirect) at 20:42:24 → operator run 20:42:29. CCD-8 stranding was pre-fix evidence (commit c09a893 landed later) |
| 9 | Concurrent triggers coalesce (lease) | PASS (retest) | ATL-2: two simultaneous @operator comments → exactly 1 new run. Narrow await-gap remains (finding #30) |
| 10 | Interrupt a run | PASS | run_atl2rCR-JE1d: interrupted_by set + `runtime.run.interrupted` audit; note run-interrupt requires runId, 404 without |
| 11 | Owner take / hand-off / admin release | PASS | ATL-3: 3 typed assign events + audits incl. `admin_released {forced:true}` |
| 12 | Reviewer verdict → quality event + validation | PASS | ATL-3: REAL 45-turn Claude review → approve → typed quality "Review passed" + validation=healthy |
| 13 | Advisor consultant flow | SKIP | Owner decision A: Advisor profile is being removed in phase 4 |
| 14 | Remove reviewer | not run | trivially same machinery as assign (exercised via operator summon); deprioritized |
| 15 | Viewer cannot create / contributor can | PASS | T15a 403 "Viewers cannot create tasks", no dir; T15b 200 → ATL-2 |
| 16 | Non-member comment labeled | PASS | deniz comment allowed; renders "app user · not in project" pill |
| 17 | Boundary RBAC on transitions | PASS | murat 403 (role message), elif 200 (moved) |
| 18 | View-side project RBAC | PASS | deniz 403 on policy/agents/settings; viewer selin 200. (403 page copy broken → finding #26) |
| 19 | Rescan gating | PASS | murat 403, elif 200 |
| 20 | Specialist cap off/human → disallowedTools | covered | Code + unit tests; live deny not exercised (agents never attempted denied commands). Codex: no confinement (finding #33) |
| 21 | Operator cap off removes tool | not run live | Gating code verified (buildOperatorToolkit); superseded by finding #34 (allowedTools doesn't confine anyway) |
| 22 | ALWAYS_HUMAN coercion at persist | PASS | T22/T22b: merge-pull-request + transition-to-done sent as direct → persisted human; T22c admin-only enforcement |
| 23 | Full autonomy flips recommend→direct | PASS | ATL-2: full-autonomy operator moved ready→impl ITSELF (no human approval) and engaged the Developer; supervised runs on the same task had only recommended |
| 24 | Skill isolation (only declared skills) | FAIL | ATL-5 prober listed the USER'S 15 personal harness skills; environment leak (finding #35) |
| 25 | KB injection | covered | Code path verified (24k budget, buildSpecialistPersona/buildOperatorSystemPrompt + unit tests); no live introspection of systemPrompt |
| 26 | MCP live round-trip | FAIL | Init envelope `{name:'everything', status:'failed'}` — wiring works, stdio spawn fails (env replacement kills PATH — finding #36) |
| 27 | No unrelated resources loaded | FAIL | Same as 24: whole user harness present (finding #35) |
| 28 | Codex/Claude parity from viberr's side | PASS | Both backends produced real runs, replies on timeline, correct backend rows/glyphs; asymmetries recorded (codex: prompt-folded persona, no confinement, no cost telemetry) |
| 29 | Codex operator structured plan | PASS | ATL-2: codex operator (1 turn) → plan executed via gated actions; recommend-mode respected. Posted duplicate observed-comments (noise) |
| 30 | Direct file edit reprojected | PASS | atlas-api members edit projected in ~1.5s |
| 31 | Malformed frontmatter → diagnostics, no crash | PASS | FSP-1: 7 diagnostics, readiness floored blocked, health ok, board+task render diagnostic, recovery clean. (Fallback stage hardcoded triage → finding #27) |
| 32 | Dir-name wins on key mismatch | PASS | FSP-99 vs frontmatter FSP-42: dir wins + key_mismatch diagnostic + readiness floor |
| 33 | Rescan / rebuild | PASS | npm run rescan clean; provenance rescan row; rows intact |
| 34 | Packet fan-out | PASS | ATL-1 packets → exactly admin(arda)+maintainer(elif); contributor/viewer excluded |
| 35 | Read-state on resolve | PASS | packet notifications read_at set when packet resolved |
| 36 | Mention notification | PASS | @Elif Demir → 1 mention notification for elif only |
| 37 | GitHub degrade without PAT | PASS | ATL-1: no crash, honest packet, no phantom branch/pr in frontmatter |
| 38 | Full server-side GitHub delivery (stored PAT) | BLOCKED | Requires a real PAT which I must not provision; agent-side delivery DID happen (PR #9) exposing finding #31 |
| 39 | Create project via wizard | PASS | atlas-api project.md complete; creator admin; base agents deployed. (guardrails: [] → finding #29) |
| 40 | Timeline compaction | covered-by-finding | compression-threshold guardrail absent on all non-seed projects (finding #29) → feature dead in practice; unit-tested in code |
| 41 | Board reorder + boardRank | PASS | reorder intent → board_rank 4000000.0 persisted |
| 42 | Session export | FAIL | Real-run export 404s — CLAUDE_CONFIG_DIR default drift (finding #32) |

## Highlights

- **The governed loop is real and good.** ATL-3 ran create → triage → approve → assign → REAL Codex
  implementation (real branch + PR #9 on GitHub) → operator transition request → approve → REAL
  45-turn Claude review → approve verdict → validation healthy → operator recommendation → human
  acceptance → Done. Operator judgment was consistently sound (duplicate-avoidance, honest
  escalation, refusing vague work).
- **The biggest product gaps found live:** #31 (agent-side delivery invisible to the canonical
  record), #34/#35 (no runtime tool/config isolation — prompt-only enforcement), #36 (MCP spawn env),
  #29 (new projects have no guardrails), #32 (session export broken).
