# Pass 4 — end-to-end validation sweep (post-implementation, on merged `main`)

Purpose: validate the SHIPPED implementation across the whole app via a fresh project, custom
agents, and 20+ tasks covering the owner's named case matrix — with UI screenshots + API
evidence per case. Backends forced to the deterministic simulated engine
(`VIBERR_FORCE_SIMULATED_RUNTIME=1`) so the operator lifecycle completes synchronously and is
screenshot-stable; real-run isolation/parity facts (init envelopes) are from the Docker
container run recorded in `test-results-v4.md`.

Project: **Viberr Validation (VV)** on `akin-ozer/viberr`, Standard/Balanced. Roles fixture:
arda=admin, elif=maintainer, murat=contributor, selin=viewer, deniz=non-member.

## Setup (UI + API, screenshots captured)
- **VV1 · Project create** — "Viberr Validation" (VV) created via the New-project path;
  base agents (operator/developer/reviewer) auto-deployed with the Balanced policy.
- **VV2 · Members + custom agents** — arda=admin, elif=maintainer, murat=contributor,
  selin=viewer; created 2 custom profiles via create-profile: **Docs Writer** (Claude,
  stages=[impl], skill=conventional-commits, execute-code-or-write-repo=direct — the ruling-7
  addition) and **Test Engineer** (Codex, stages=[review]). Agents page screenshot shows all 5.
- **20 tasks (VV-1..VV-20)** created; the operator auto-invoked on each outside-triage creation
  and assigned the Codex Developer — board screenshot shows 18 In Progress "input required".

## Case matrix + results (all PASS on merged `main`)
| # | Case | Method | Result |
|---|---|---|---|
| VV-1 | **Full lifecycle Triage→Done** | UI+API | Operator auto-invoke → Codex Developer runs + replies → apply transition rec (maintainer) → reviewer verdict **healthy** + quality event → operator recommends acceptance → accept (RBAC-gated) → **Done** "no linked pull request" (honest, no fake merge). Screenshots: task detail (operator recommendation + Codex reply), Done column ("accepted"). |
| VV-2 | **Ownership tiering (Q5)** | API | viewer take **403**; contributor take **200** + release-own **200**; maintainer release-other **403**; admin force-release **200**. |
| VV-3 | **Manual transition RBAC** | API | viewer **403**, contributor **403**, maintainer **200**. |
| VV-4 | **Human→Done = acceptance** | API | maintainer impl→done writes a `completion` event "Human acceptance recorded", not a bare transition; board shows "accepted". |
| VV-5/6 | **Stage eligibility (R2/F1)** | API | Docs Writer(impl-only) as specialist on a review task **400**, on impl task **200**; Test Engineer(review-only) as reviewer on impl task **400**, on review task **200** — enforced at BOTH assign boundaries. |
| VV-7 | **Reviewers idempotent + secondary + remove** | API | assign **200**, re-assign idempotent **200**, secondary Test Engineer **200**, remove Reviewer **200** → left with test-engineer. |
| VV-8 | **Comment routing RBAC** | API | viewer plain comment **200**; contributor @operator **200** (recorded, runtimeDenied); maintainer @operator **200** (triggers run). |
| VV-10 | **C2 anti-laundering** | API+UI | validation=failing → accept **409 refused**, stays in Review; review queue shows the **validation failing** badge (screenshot). |
| VV-11 | **Recommendation apply/RBAC** | API | transition rec applied by contributor **403**, by maintainer **200** (part of VV-1). |
| VV-12 | **Board reorder RBAC** | API | viewer **403**, contributor **403**, maintainer **200**. |
| VV-13 | **Goal-edit RBAC** | API | viewer **403**, contributor **403**, maintainer **200**. |
| VV-14 | **Notification routing** | API | set-notif category=packets on=0 **200**; createNotification returns null for a silenced category (unit-tested `isNotifKindEnabled`). |
| VV-15/16 | **Codex/Claude parity** | API | Codex Developer + Claude Docs Writer produce IDENTICAL run rows (kind=primary, agent_name, state) — same lifecycle from viberr's eye. |
| VV-17/18 | **Drive to Done** | (covered by VV-1/VV-4 in Done). |
| VV-19 | **MCP registry** | API | org MCP server "docs-search" (HTTP) added via org settings; resolves to a connectable config for a Claude run (container-verified). secret:// injection = deferred ruling-8. |
| VV-20 | **Skill isolation** | API+container | Docs Writer declares ONLY conventional-commits; the run persona injects that skill; account-tier skills also appear on REAL runs (F-ISO1, container-verified in test-results-v4). |

## Cross-surface UI evidence (screenshots this session)
Home dashboard, New-project modal, Agents page (5 profiles incl. custom), populated board
(operator auto-invoked all 20), VV-1 task detail (operator "Recommendation: Move to Review" +
Codex reply + agent-logs transcript), review queue (VV-3/7 healthy, VV-10 failing, human-only
boundary), Policy page (honest ruling-6 copy live), final board (2 accepted in Done).

## Conclusion
The merged implementation is validated end-to-end across the owner's named case matrix —
operator behavior (auto-invoke, supervised recommend-not-direct), agent execution + verdicts,
RBAC tiers on every mutation, stage eligibility at both boundaries, packet/acceptance rules,
the C2 anti-laundering invariant, Codex/Claude parity, MCP registry, and skill declaration.
Real-run isolation facts (init envelopes, F-ISO1) come from the Docker container run in
`test-results-v4.md`. PR outcomes on `akin-ozer/viberr`: #17 merged, #18 closed, #19 open.
