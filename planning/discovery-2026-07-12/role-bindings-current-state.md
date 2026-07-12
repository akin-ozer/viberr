# Role-bindings ground truth — verified vs `main` 2026-07-12

Every anchor re-verified this pass against main @ 7c064cd (post-PR#7). Supersedes
`../discovery-2026-07-11/role-bindings-map.md`. Module reality: task/specialist/operator actions
live under `app/server/tasks/`, runtime under `app/server/runtimes/`, auth helpers under
`app/server/auth/` (the old map's `app/features/task-detail/*` paths were stale).

## 1. Human RBAC — current enforcement table

Two sources of truth, only one enforced. `PROJECT_CAP_MATRIX` (`app/features/policy/policy-data.ts:36-51`,
shape `{action, roles: RoleId[]}`; `RBAC_ROWS` derived at :53-59 and imported by policy-page.tsx:19,146 +
profile-page.tsx:10,381) is **display-only** — no server guard consults it.

| Action | Roles | file:line |
|---|---|---|
| create-project | any org member | `_index.tsx:107,113` (auth :53) |
| rebuild-projections | org admin | `_index.tsx:92,95-101` |
| home rescan | org admin (D7) | `_index.tsx:75,80-86` |
| org settings (all intents) | org admin | `org.settings.tsx:66,97` |
| create task | member except viewer | `task-actions.server.ts:386-387` |
| update task goal (NEW, unmapped) | admin\|maintainer | `task-actions.server.ts:485-490`; route `project.task.tsx:181` |
| manual transition | admin\|maintainer | `task-actions.server.ts:2081-2086` |
| auto-boundary transition | any member (UI always sends manual:true) | `task-actions.server.ts:2088` |
| approval / human transition | admin\|maintainer | `task-actions.server.ts:2090-2103` |
| reorder board / board rescan | admin\|maintainer | `task-actions.server.ts:2319`; `project.board.tsx:50,83-88` |
| take ownership | any member (self) | `task-actions.server.ts:1824-1829` |
| hand-off ownership | owner or admin; target member | `task-actions.server.ts:1836-1844` |
| release ownership | self any-member; release-any admin | `task-actions.server.ts:1935-1954` |
| comment | ANY registered user (FR4) | `task-actions.server.ts:586` |
| @mention → agent run | admin\|maintainer (`hasRuntimeRole` :990-1003; else comment + runtimeDenied) | `task-actions.server.ts:795` |
| resolve packet (non-completion) | admin\|maintainer OR current-member task owner (Q2) | `task-actions.server.ts:2430-2444` |
| resolve packet accept_completion | admin\|maintainer | `task-actions.server.ts:2457-2462` |
| accept completion | admin\|maintainer | `task-actions.server.ts:2636-2641` |
| complete PR merge | admin\|maintainer + userId | `task-actions.server.ts:2736-2737` |
| apply recommendation | NO top-level gate — inherits underlying mutation RBAC (auto-transition rec ⇒ any member) | `task-actions.server.ts:2788,2802-2856` |
| dismiss recommendation | admin\|maintainer | `task-actions.server.ts:2897-2902` |
| assign/run specialist/reviewer | admin\|maintainer via `runtimeAuditActor`→`requireRuntimeRole` | `specialist-run.server.ts:220,304,477,707`; def :1307-1326 |
| remove reviewer | admin\|maintainer | `specialist-run.server.ts:398` |
| interrupt run | admin\|maintainer (inline) | `run-service.server.ts:438-457` |
| run operator | admin\|maintainer (inline) + real userId audited (D8) | `project.task.tsx:427-433,449` |
| profile CRUD | project admin (operator non-deletable) | `agent-profile-actions.server.ts:97-114,354,370-374` |
| set member role | project admin; last-admin guard | `policy-actions.server.ts:108-113,135-144` |
| set boundary | project admin; review→done locked | `policy-actions.server.ts:191,216-218` |
| settings intents | project admin | `settings-actions.server.ts:132…546` |
| github reconcile | non-viewer member | `project.github.tsx:56-64` |
| grant-scope / set/clear-credential | admin\|maintainer | `project.github.tsx:68-92` |
| view board/task | ANY authed (myRole=null non-member) | `project.tsx:33,40-41` |
| view review queue / activity | ⚠️ ANY authed (requireUser only — no membership) | `project.review.tsx:21`, `project.activity.tsx:35` |
| view policy/agents/settings/github | project member | `require-project.server.ts:18-39` |

**Duplicated guard helpers (delete in D2/D5):**
`requireMemberRole` task-actions:295-309 · `requireProjectRole` task-actions:205-213 ·
`requireProjectMember` require-project:18-39 · `requireProjectAdmin` ×3 (policy-actions:58,
settings-actions:87, agent-profile-actions:97) · `requireRuntimeRole` specialist-run:1307 /
`hasRuntimeRole` task-actions:990. Inline copies: run-service:451, project.task.tsx:427,
project.github.tsx:56/68/82, project.board.tsx:83, _index.tsx:80/95.

**Displayed matrix rows (11)** vs ~30 enforced actions — the rework needs an explicit
row→actions mapping (one matrix row may govern several server actions) + owner-exception
annotation on packet resolve (Q2).

## 2. Capability catalog truth (30 ids)

- `ALWAYS_HUMAN_CAPABILITY_IDS` (3): merge-pull-request, transition-to-done, change-project-policy
  (`capabilities.ts:67-71`).
- `ENFORCED_CAPABILITY_IDS` (15): create-task-branch, commit-push-branch, open-review-pr,
  open-or-merge-pr, merge-pull-request, execute-code-or-write-repo, edit-other-task-branch,
  assign-primary-specialist, summon-reviewers, generate-packets, append-typed-events,
  stage-transitions, completion-for-acceptance, transition-to-done, change-project-policy (:88-104).
- **Consumed (13)**: operator gate ×6 (assign-primary-specialist, summon-reviewers, generate-packets,
  append-typed-events, stage-transitions, completion-for-acceptance) + specialist deny rules ×7
  (create-task-branch, commit-push-branch [push+commit], open-review-pr, open-or-merge-pr [dead rule —
  never granted anywhere], merge-pull-request [always denied], execute-code-or-write-repo
  [Edit/Write/NotebookEdit + git commit], edit-other-task-branch [checkout/switch/reset]).
- **Dead (18)**: compress-timelines (seeded direct on operator, never gated — compaction is driven by
  the compression-threshold GUARDRAIL instead), owner-reassignment, move-task-to-review,
  report-validation-verdict, run-validation-suites, post-quality-flags, comment-on-task,
  approve-review, request-changes, author-test-cases, attach-evidence-references, read-task-repo,
  flag-underspecified-tasks, transition-to-done†, change-project-policy† († always-human decoration),
  run-unit-integration-validation, read-repo-diff (seed-label-only), open-or-merge-pr (rule never
  granted).
- UI coverage: MODAL_CAP_IDS=18, OPERATOR_CAP_IDS=8 → **4 ids settable by NO UI**:
  execute-code-or-write-repo, run-unit-integration-validation, read-repo-diff, open-or-merge-pr.
- `gate()` `operator-actions.server.ts:188-202`: direct→direct; recommend→(full? direct : recommend)
  EXCEPT completion-for-acceptance stays recommend at full (Q1, :197); human/off/absent→deny (tool
  withheld). Full tool table in pass-3 runtime notes; Codex operator plan enum routes through the
  same gated functions (`executeCodexPlan` operator-run:517-597).

## 3. SSE current state (`app/routes/resources.events.ts`)

Enforced: session required (:56-62); non-org-admin `projects` firehose expands to member-project
scopes (:11-16, :99-109).
**GAP (full D9)**: an explicitly-named `scope=project:<slug>` / `scope=task:<slug>/<key>` is passed
through with NO membership verification (:102-108) — any authed user can subscribe to any project's
events. `parseSseScope` validates syntax only.

## 4. Seams (unchanged from pass 2, re-verified)

1. @mention valve (any-registered comments; runtime role to trigger).
2. Operator-on-behalf: `runtimeAuditActor` early-returns operator label when `ctx.operatorAuthorized`
   (specialist-run:1291-1300) — bypasses requireRuntimeRole by design; never bare-move to last stage
   (task-actions:2062-2076 routes human INTO last stage through acceptCompletion).
3. apply-recommendation re-executes under human RBAC (but see no-top-gate row above).
4. Done exception: operatorAcceptCompletion refuses failing validation (H3) and writes
   pr.state="accepted", never "merged" without a real merge (D3).
5. Packet: agent generates → human (or Q2 owner) resolves.
6. Capability grant → Claude deny rules; Codex exempt (S3).

## 5. Rework backlog for THIS phase

1. **Matrix-as-runtime-source (D2/D5)**: single `actionRequires(action): RoleId[]` (or equivalent)
   derived from the same object the policy page renders; delete the duplicated helpers + inline
   checks; keep the deliberate exceptions (owner-resolve Q2, operator-on-behalf, comment FR4,
   org-level actions) explicit in the same module.
2. **Deep catalog prune** (owner ruling needed on wire-vs-drop for stages/spanAll and the dead 18).
3. **Full D9**: membership check on explicit SSE scope subscribe (org-admin bypass).
4. **Q5 contributor-vs-viewer** (owner ruling — currently identical except create-task).
5. Membership gating for review/activity read surfaces? (ask owner — board/task view is
   deliberately app-wide, these two may be too, but they leak member lists/audit).
6. S3 codex confinement — deprioritized unless owner says otherwise.
