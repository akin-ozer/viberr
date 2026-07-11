# Role-bindings surface map (2026-07-11)

The complete map of both authorization systems, produced for the owner's planned role-bindings
rework. Every claim is file:line-anchored (verified against the live codebase this session).

Two systems, meeting at defined seams:
1. **Human RBAC** — org roles `admin|member`; project roles `admin|maintainer|contributor|viewer`.
2. **Agent capability policy** — per-deployment `{capabilityId, mode}` with modes
   `direct|recommend|human|off`; `ALWAYS_HUMAN_CAPABILITY_IDS` coerced to `human` at persist.

## 1. Human RBAC

**Sources of truth (PROBLEM: two, only one enforced):**
- `PROJECT_CAP_MATRIX` (app/features/policy/policy-data.ts:36-59) — **display-only**; imported by
  policy-page + profile-page. NO server guard consults it.
- The real enforcement: ~15 hardcoded role lists across route actions + server modules, kept in
  sync only by `policy-rbac.server.test.ts`.

**Guard helpers (duplicated ×5):** `requireMemberRole` (task-actions.server.ts:267-281),
`requireProjectRole` (:186-194), `requireProjectMember` (require-project.server.ts:18-39),
`requireProjectAdmin` ×3 copies (policy-actions:58, settings-actions:75, agent-profile-actions:97),
`requireRuntimeRole`/`hasRuntimeRole` (specialist-run:1288, task-actions:885), inline checks
(run-operator project.task.tsx:411-421; interruptRun run-service:401; github routes).

### Enforcement table (server-authoritative)

| Action | Roles | Where |
|---|---|---|
| create-project | any org member (decision B) | _index.tsx:94-117 |
| rebuild-projections | org admin | _index.tsx:79-90 |
| home rescan | ⚠️ ANY signed-in (ungated) | _index.tsx:75-77 |
| org settings (all tabs/intents) | org admin | org.settings.tsx:66,97 |
| create task | any member except viewer | task-actions:358-359 |
| manual transition / reorder / board rescan | admin\|maintainer | task-actions:1799, 2019; board.tsx:105 |
| auto-boundary transition | any member (unreachable from UI — manual:true always sent) | task-actions:1805-1806 |
| take ownership | any member (self) | task-actions:1542 |
| hand-off ownership | owner or admin; target must be member | task-actions:1556-1559 |
| release ownership | self any-member; release-any = admin | task-actions:1653-1670 |
| comment | ANY registered user incl. non-members (FR4) | task-actions:513-611 |
| @mention → agent run | admin\|maintainer (`hasRuntimeRole`; others: comment posts + runtimeDenied toast) | task-actions:702,885 |
| resolve packet (all kinds) | admin\|maintainer; accept_completion re-gated | task-actions:2103-2108, 2132 |
| accept completion / complete merge | admin\|maintainer (+userId for merge) | task-actions:2299, 2388 |
| apply recommendation | NO top-level gate — inherits underlying mutation RBAC (auto-transition rec ⇒ any member!) | task-actions:2440-2489 |
| dismiss recommendation | admin\|maintainer (docstring stale says any-member) | task-actions:2516,2529 |
| assign/run specialist/reviewer, remove reviewer, interrupt run | admin\|maintainer | specialist-run:1272-1307, 396; run-service:401 |
| run operator (backend+autonomy) | admin\|maintainer (inline) | project.task.tsx:411-421 |
| profile CRUD | project admin (operator profile non-deletable) | agent-profile-actions:97-114, 370-374 |
| set member role / set boundary | project admin; last-admin guard; review→done locked | policy-actions:108,135-144,216-218 |
| settings (identity/stages/members/archive/delete/override) | project admin | settings-actions various |
| github reconcile | non-viewer member | project.github.tsx:55-56 |
| grant-scope / set-credential / clear-credential | admin\|maintainer | project.github.tsx:67-96 |
| view board/task | ANY authed user (project.tsx requireUser; myRole=null for non-members) | project.tsx:32 |
| view policy/agents/settings/github | project member | require-project.server.ts |

**Effective tiers:** contributor ≡ viewer except `createTask`. maintainer = admin minus
{members/roles, policy edit, profile CRUD, release-any, archive/delete, stage editing, override}.

### UI-vs-server mismatches
- M1: recommendation **Dismiss** button rendered for everyone; server admin|maint (operator-recommendations.tsx:90-98).
- M2: **DecisionPacket resolve options** rendered for every task viewer; server admin|maint (decision-packet.tsx:126).
- M3: **"Assign me"** shown to non-members; server requires membership (task-detail-page.tsx:585-593).
- M4: server MORE permissive: contributor may apply an auto-boundary transition rec; UI hides Apply (canRunAgents).
- M5: reviewer profile extra "Push commits to the branch: human" is decorative (no grant, no deny rule).

## 2. Agent capability policy

Catalog: `app/shared/capabilities.ts:26-72` (32 ids). Persist: `grantsFor`/`createModalGrants`
(agent-profile-actions:155,182) coerce ALWAYS_HUMAN → human. Operator resolution `gate()`
(operator-actions:176-182): direct→direct; recommend→(full? direct : recommend); human/off/missing→deny.

### Consumed (11 of 32)

| capability | consumer | effect |
|---|---|---|
| assign-primary-specialist | operator-toolkit:183; operator-actions:672-945; operator-run:559 | tool offered/act vs recommend vs withheld |
| summon-reviewers | operator-toolkit:238; operator-actions:740-1021; operator-run:545 | same |
| generate-packets | operator-toolkit:113; operator-actions:422 | open_decision_packet |
| append-typed-events | operator-toolkit:98; operator-actions:651 | post_comment |
| stage-transitions | operator-toolkit:295; operator-actions:1030 (auto boundary bypasses recommend :1041-1057) | transition_stage |
| completion-for-acceptance | operator-toolkit:321-324; operator-actions:1139-1204 | accept_completion — ⚠️ contract holes (findings A7) |
| create-task-branch | specialist-tool-policy:36 | deny git checkout -b / switch -c when withheld (Claude only) |
| commit-push-branch | specialist-tool-policy:39 | deny git push (Claude only) |
| open-review-pr | specialist-tool-policy:41 | deny gh pr create (Claude only) |
| merge-pull-request (ALWAYS_HUMAN) | specialist-tool-policy:44 | always deny gh pr merge (Claude only) |
| open-or-merge-pr | specialist-tool-policy:42-43 | rule exists, NEVER granted anywhere → dead rule |

### Dead (21 of 32) — never change runtime behavior
Settable in UI + seeded: compress-timelines, owner-reassignment (operator editor);
edit-other-task-branch, move-task-to-review, report-validation-verdict, run-validation-suites,
author-test-cases, attach-evidence-references, post-quality-flags, comment-on-task, approve-review,
request-changes, read-task-repo, flag-underspecified-tasks, transition-to-done†, change-project-policy†
(† always-human decoration — unlike merge-pull-request they map to NO tool denial).
Seeded only (no UI): execute-code-or-write-repo, run-unit-integration-validation, read-repo-diff.
Fully orphan: validation-verdict, hold-on-failing-checks.

**UI coverage:** specialist modal governs 18 ids (MODAL_CAP_IDS), operator editor 8
(OPERATOR_CAP_IDS) → 6 catalog ids settable by NO UI.

### Enforcement asymmetry per backend
- **Claude specialist:** withheld caps → `disallowedTools` deny specifiers, bind under
  bypassPermissions (claude-runtime:216-220). BUT the headline cap `execute-code-or-write-repo`
  has NO deny rule — a "can't write repo" specialist still has Edit/Write/Bash.
- **Codex specialist:** NO tool confinement at all (danger-full-access; disallowedTools computed
  then ignored) — S3 gap. Same profile enforces on Claude, advisory-only on Codex.
- **Operator (Claude):** write builtins hard-denied (OPERATOR_DENIED_BUILTINS); viberr MCP tools
  gated per capability. **Operator (Codex):** plan executed through the same gated actions —
  policy enforced in the executor.

## 3. Seams
1. @mention valve: any-member comments; admin|maintainer required to trigger runs (task-actions:885).
2. Operator-on-behalf: `operatorAuthorized` bypasses human RBAC; agent gate() applies instead;
   never a bare move to last stage (task-actions:1786-1795). Human bridge = who may press Run
   operator (admin|maint) and choose autonomy.
3. apply-recommendation: agent recommend → human actor re-executes under human RBAC.
4. Done exception: operator accepts ONLY under full autonomy (+cap contract, see A7); merge always
   requires a human userId (task-actions:1972) → operator writes "accepted", never "merged".
5. Packet: agent generates (generate-packets) → human resolves (admin|maint; C3 questions owner
   alignment).
6. Capability grant (set by project admin in modal) → Claude runtime denylist (seam of the two
   systems; Codex exempt).

## 4. Rework recommendations (priority order)
1. Make `PROJECT_CAP_MATRIX` the runtime source: `actionRequires(action): RoleId[]` consumed by all
   guards; delete the 5 duplicated helpers; policy page renders the same object it enforces.
2. Prune the capability catalog to consumed ids (+ wire execute-code-or-write-repo → Edit/Write/
   Bash(git commit/push) deny; edit-other-task-branch rule; drop or implement owner-reassignment,
   compress-timelines) — pending owner ruling Q4.
3. Fix UI/server mismatches M1-M5; resolve packet-owner authority (Q2); dismiss/docstring drift.
4. Decide contributor vs viewer differentiation (Q5).
5. Codex confinement (S3) — still deprioritized by owner; role-bindings work must not silently
   depend on specialist caps holding on Codex.
6. Unify home vs board rescan gating; audit run-operator with real userId.
