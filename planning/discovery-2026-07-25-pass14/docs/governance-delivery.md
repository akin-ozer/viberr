# Governance & delivery — code map (pass 14, 2026-07-25, main @ fa138e1)

Subsystem: tasks, stages, RBAC, reviewers, comments/notifications, GitHub delivery,
operator decision-making. All paths repo-relative to `/Users/akinozer/projects/viberr`.
Verified against current code (not prior docs); pass-13 claims re-checked in §10.

---

## 1. Task lifecycle

### 1.1 Creation

- `createTask` — `app/server/tasks/task-actions.server.ts:406`. RBAC `create-task`
  (admin|maintainer|contributor — `app/shared/rbac.ts:50`). Allocates `<PREFIX>-<n>`
  atomically from project.md's counter (`allocateTaskKey`, :433), refuses creation in the
  terminal stage (:424-427), writes task.md with the canonical default frontmatter
  (:436-461): `readiness: input_required`, `waiting: human`, `engagements: []`,
  `workRevision: null`, `verdicts: []`, operator attached unless the task starts in the
  entry stage (:447-451). Reprojects both project.md and task.md, audits `task.created`,
  then fire-and-forgets the operator (`autoInvokeOperator`, :487 → :572-601 — a no-op
  when no operator is deployed).
- FR11 (agents cannot create tasks) holds: the operator plan tools
  (`app/server/runtimes/operator-run.server.ts:409-426`) and the Claude toolkit
  (`app/server/tasks/operator-toolkit.server.ts`) expose no create-task action.
- Goal edit: `updateTaskGoal` :497 — RBAC `update-goal` (A|M), auto-clears a
  `goal_edit`-awaiting packet (:515-537), appends a neutral `note` event (P13-LV-03),
  re-invokes the operator with the dedicated `goal-updated` trigger (:566).

### 1.2 Stage machine

- **Single template.** `GOVERNED_TEMPLATE` ("Governed · 5 stages":
  triage→ready→impl→review→done) is the only preset —
  `app/shared/workflow/templates.ts:33-73`. The Lightweight preset is deleted
  (P13-AP-04 / owner ruling 2, comment at :15-23); `project-create.server.ts:206`
  confirms no `template` field remains. Residue: two live-code doc comments still
  describe a "Lightweight project is todo/doing/done" as though it ships —
  `app/shared/workflow/stage-roles.ts:8` and
  `app/server/projections/review-queue.server.ts:14` (docs-only, see GV-03).
- **Structural stage roles** (never literal ids): `resolveStageRoles`
  (`app/shared/workflow/stage-roles.ts:42-69`) — entry = index 0, terminal = last,
  review = the stage with a workflow edge INTO terminal (first match wins),
  work = edge into review; positional fallbacks for workflow-less boards.
- **Chain maintenance** (P13-D-1): `app/shared/workflow/transitions.ts` — `workflow` is
  a chain over `stages` order; `spliceStageIntoChain` :118, `rejoinChainAroundStage`
  :183 (merges to the STRICTER boundary so removing a column never deletes a gate),
  `realignChainToStages` :249, `stageFlowPath` :284 (Policy flow map + `offChain`
  honesty). Rules into the terminal stage are forced `human` + `locked`
  (:86-101, `withLock` :73-79) — V1's human-acceptance invariant is recomputed, not
  carried.

### 1.3 Transitions — `transitionStage` (`task-actions.server.ts:2672`)

Boundary resolution and authority ladder:

| path | condition | authority |
| --- | --- | --- |
| idempotent | `from === to` | none (:2700-2703) |
| human → terminal stage | any human writer to Done | rerouted to `acceptCompletion` (:2741-2753) so a manual "move to Done" is a full acceptance (merge attempt, gates, completion event) |
| operator → terminal stage | `ctx.operatorAuthorized` | **refused** (:2760-2764) — operator reaches Done only via `operatorAcceptCompletion` |
| `manual: true` | off-graph board/dropdown move | `approve-transition` (A\|M) (:2765-2768) |
| declared `auto` | crossed by a human | any member (:2769-2772; UI always sends `manual`, so API-only) |
| declared `approval` | | `approve-transition` (:2773-2774) |
| declared `human` (review→done) | | `requireAcceptCompletion` — A\|M **or task owner** (R6-2) (:2776-2784) |
| `rework: true` | operator-only, backward move, `validation === "failing"` | vetted at :2716-2731 (R7-4) |

Write effects (:2799-2838): stage set; `waiting: none` on Done; operator attached on
leaving entry; triage `input_required` cleared (only that value, :2817-2823);
`validation` recomputed on review entry via `deriveValidation` (:2829-2831); stale
`transition` recommendations dropped (:2834). Audit `task.transition`; approval
notifications marked read (:2860).

**Transition-chain cap** (`OPERATOR_TRANSITION_CHAIN_CAP = 8`, :116): every non-Done
transition re-invokes the operator (:2879-2907, ADR-002 / P11-70 re-trigger).
Operator-authored transitions thread `transitionDepth`
(`nextTransitionChainDepth` :120 — human actions reset to 0); at the cap a blocked
"stuck loop" packet opens instead of another LLM run (:2881-2896 →
`openStuckLoopPacket` :1375). The react loop has its own cap
(`OPERATOR_REACT_DEPTH_CAP = 4`, :103; `operatorShouldReactToReply` :125).

**Delivery spine hook**: entering the resolved review stage fires
`openReviewPrBestEffort` (:2916-2918), see §5.

### 1.4 Archive

Archive is **project-level only** (R6-3): `requireProjectMutable`
(`app/server/auth/project-authority.server.ts:131-142`) is the single implementation;
`requireAction` calls it on every governed mutation (`task-actions.server.ts:305`),
`appendComment` calls it explicitly since commenting is app-wide (:641), and
`requireRunAgents`/`canRunAgents` gate the runtime (`project-authority.server.ts:275,
:291`). There is **no task-level archive/delete action anywhere** — yet
`closedPrBlockedReason` copy tells the human to "archive the task"
(`app/schemas/task-file.schema.ts:541`) — GV-02.

### 1.5 Reorder

`reorderTask` :3200 — RBAC `reorder-board` (A|M), sparse `boardRank`.

---

## 2. Assignments, engagements, reviewer model

### 2.1 Engagements (G1)

One uniform list, `frontmatter.engagements[]` (`app/schemas/task-file.schema.ts:101-116`):
`{profileId, backend, role, delivers, verdictCapable}`. At most one `delivers: true`
(the workspace/branch/PR owner — `deliveringEngagement` :119); everything else is
"supporting" (:126). `verdictCapable` is the **engage-time snapshot** of an explicit
`report-validation-verdict: direct` grant.

- `assignSpecialist` (`app/server/tasks/specialist-run.server.ts:257`) — replaces the
  deliverer, de-dupes a profile that was previously supporting (:299-310), snapshots
  `verdictCapable` (:305), clears the matching recommendation, audits. Mid-run
  re-assignment is not blocked here — but a second **delivering run** is (single-flight,
  below).
- `assignReviewer` :359 — idempotent against ANY existing engagement (:386-397),
  snapshots `verdictCapable` at engage time (:418).
- `removeReviewer` :465 — supporting engagements only (`delivers` rows survive the
  filter :493-495).
- All three run through `runtimeAuditActor` :1399 → `requireRunAgents` (run-agents =
  A|M) unless `ctx.operatorAuthorized`.

### 2.2 Stage eligibility & run start

`startAgentRun` :523 — resolves the engagement (delivering by default), enforces
**single-flight for the delivering agent** (:570-587, F7-OP1 — 409 while a primary run
is queued/running; supporting agents run concurrently), resolves the LIVE deployment
(backend switch takes effect next run, :589-608), re-checks **stage eligibility at the
run boundary** (:644-646; `specialistEligibleForStage` :1482 — `spanAll` or empty list
= unrestricted), builds persona + collab gates, clones an isolated per-task workspace
(never the task dir, :693-703), and threads `disallowedTools` from
`resolveSpecialistDisallowedTools`.

### 2.3 Capability confinement (the "specialist cap")

`app/server/tasks/specialist-tool-policy.ts`:

- `CAP_DENY_RULES` :30-78 map withheld capabilities → Claude tool-deny specifiers
  (branch/commit+push/PR-create/merge; headline `execute-code-or-write-repo` removes
  Edit/Write/NotebookEdit + `git commit`; `use-web-search-fetch` removes
  WebFetch/WebSearch). Deny wins even under `bypassPermissions`. Codex: read-only
  sandbox for withheld repo-write (RT-02) else prompt-level.
- Polarity is safe-by-default-open: only `human`/`off`/ALWAYS_HUMAN are withheld (:80-88).
- Undeployed-profile resume → everything withheld (`resolveUndeployedDisallowedTools`
  :115).
- `resolveDeliveryPermissions` :133-152 — the **headline gates all three scoped
  delivery steps** (VIB-1 lesson), so prompt and enforcement tell the same story.
- Catalog + ALWAYS_HUMAN (`merge-pull-request`, `transition-to-done`,
  `change-project-policy`): `app/shared/capabilities.ts:33-94, :144-148`;
  honesty metadata `capabilityEnforcement` :198; headline↔scoped repair
  `normalizeDeliveryGrants` :223; org-template conservative grants
  (`conservativeGrantsFor` :126) consumed at `app/server/org/gagents.server.ts:292` —
  **verified: an org-library template starts delivery-withheld** (pass-13 last commit).

### 2.4 Revision-bound reviewer model (F10-15/F10-32)

- `workRevision` (`task-file.schema.ts:371-384`) minted server-side by
  `reconcileWorkspaceDelivery` (`app/server/github/workspace-delivery.server.ts:329-382`)
  only when the branch carries task work; same tree ⇒ same revision ⇒ verdicts survive
  (`nextWorkRevision` :549-570 in the schema).
- Verdicts (`reviewVerdictSchema` :389-402) bind `(profileId, revisionId)`,
  last-write-wins (`recordAgentCompletion`, `task-actions.server.ts:1684-1702`).
- Required reviewers = supporting engagements with `verdictCapable`
  (`requiredReviewers`, schema :458); `deriveValidation` :476-494 is the ONLY writer
  of the `validation` cache (none/changed/failing/healthy).
- **Verdict authority at completion prefers the engage-time snapshot**
  (`applyAgentCompletionEffects`, `task-actions.server.ts:2025-2034`) so a required
  reviewer whose live grant was revoked can still record (else the task is permanently
  un-acceptable); question (`ask-human`) authority deliberately uses the LIVE grant
  (:2079-2087 — documented asymmetry).
- Verdict source order: staged Claude `report_outcome` envelope → Codex outputSchema
  JSON → prose classifier `classifyReviewerVerdict` :1527 (only for verdict-authorized
  agents, :2048-2077; a granted reviewer with no determinable verdict leaves validation
  unchanged + warns).
- Acceptance gate: `acceptanceBlockedReason` (schema :500-518) — every required
  reviewer must approve the CURRENT revision; plus the blocked-packet gate
  (`task-actions.server.ts:3681-3689`) and the closed-PR gate
  (`closedPrBlockedReason`, schema :536-542, applied at all three Done writers —
  `acceptCompletion` :3698-3704, `resolvePacket` :3387-3393,
  `operatorAcceptCompletion` `operator-actions.server.ts:1640-1651`).

### 2.5 Ownership (FR37/FR38)

`setOwner` :2511 (own-task = A|M|C; hand-off needs current owner or
`release-any-ownership` = admin; target must hold own-task), `releaseOwner` :2608
(self = own-task, other = admin). Owner is the acceptance authority via
`ownerException` :313-324 / `requireAcceptCompletion` :327-336 — **the PRD's FR37
"partly implemented" annotation is stale**; the owner exception ships (GV-04).

### 2.6 Re-assignment mid-run

Replacing the deliverer while its run is live is possible (`assignSpecialist` has no
live-run check); the OLD run's completion still reconciles delivery under its recorded
profileId and the workspace it owns — the engagement lookup at completion
(:2029-2031) simply finds no row for the replaced profile and falls back to the live
grant for verdict authority. The single-flight gate only stops a second *delivering
run*, not a re-assignment. Benign in practice (new deliverer's run 409s until the old
one ends) but un-audited as a hand-off.

---

## 3. Operator

### 3.1 Wake-ups

`runOperator` (`app/server/runtimes/operator-run.server.ts:302`) triggers:
`create` (task create :487), `transition` (every non-Done stage move :2898, packet
send-backs :3592), `goal-updated` (:566), `agent-reply` (completion react,
:2336-2351), `manual` (`@operator` comment — `commentToAgent`
`task-actions.server.ts:944-961`, requires run-agents; and the task-page "Run
operator" control). Scheduled re-runs (FR39): `fireDueSchedules`
(`app/server/tasks/schedule.server.ts:215`, 60s tick, claim lease 5min :204,
bounded retries, never fires on a Done task). The GitHub poller **never** invokes the
operator — it only notifies humans.

### 3.2 Single-flight lease (NFR16/AO-2)

Process-level lease + newest-wins trigger queue keyed per task
(`operator-run.server.ts:126-250`): a trigger during a held lease queues (:321-335);
a cross-boot DB in-flight row queues + chains drain on completion (:336-354,
`drainPendingAfterInFlight` :223 never evicts a live successor). Release is
token-guarded (:185-214). `markWaitingAgent` at drive start (:386-387);
`settleWaitingAfterOperator` on release settles `waiting` (Done+no-packet+no-recs →
`none`, else `human` — P13-LV-20, `clearWaitingToHuman`
`task-actions.server.ts:2357-2391`).

### 3.3 Authority & capability gating

`resolveOperatorAuthority` (`app/server/tasks/operator-actions.server.ts:150-219`)
reads the project's operator deployment (policy map, autonomy, backend, model, KB/
skills/MCPs). `gate()` :222-236: `direct`→direct; `recommend`→direct under full
autonomy **except `completion-for-acceptance`** (never promoted — owner ruling Q1);
`human`/`off`→deny. Claude: tools are only BUILT for granted capabilities
(`operator-toolkit.server.ts:28-46`, `allowedTools` confinement); Codex: the plan
schema's tool enum is filtered to granted tools (`operatorPlanToolsFor`
`operator-run.server.ts:458-471`), refused actions are narrated (RT-03).

### 3.4 Agent selection

`operatorSnapshot` :739-835 gives the model `deployedSpecialists` with
`eligibleForCurrentStage` (:802-805), capability summary (delivery/verdict/ask),
resources, structural stage ids, the open packet's content, the last 6 timeline events
(capped 1500 chars each), and — since P13-D-4 — the PR ref (:826-831). Engagement
actions: `operatorEngageAgent` :1332 / `operatorRunAgent` :1387 /
`operatorPromptAgentGeneric` :1442 (generic dispatch, `delivers` selects shape),
legacy `operatorPromptSpecialist` :1128 / `operatorPromptReviewer` :1214.
`operatorPromptAgent` (`task-actions.server.ts:2416-2489`) posts the @handle-prefixed
directive as a to-agent comment, then `startAgentRun` under operator authority.

### 3.5 Packets & recommendations

- `operatorOpenPacket` :493-610 — gated `generate-packets`; one packet slot per task;
  blocked packets set `readiness: blocked` + `waiting: human`; watcher notification
  kind `packet`. Stable per-packet `id` (schema :344) defeats stale resolutions
  (F10-09: identity captured pre-await, re-checked in the lock —
  `task-actions.server.ts:3325-3329, :3535-3547`).
- `resolvePacket` :3300 — owner OR A|M (owner ruling Q2); option kinds drive typed
  effects (:3363-3533): `accept_completion` (full acceptance semantics, gated),
  `block_on_policy`, `hold_runtime_debug`, `edit_goal` (packet stays open, `awaiting:
  goal_edit`), `retry_other_backend` (actually starts the promised run, :3599-3636),
  default send-backs re-invoke the operator (:3587-3593). Free-text note carried onto
  the decision event (P11-71, :3558-3562).
- Recommendations (schema :143-176) — `addRecommendation`
  (`operator-actions.server.ts:387-463`): idempotent per (kind, target), sets
  `waiting: human`, notifies watchers (kind `approval`) only when NEW.
  `applyRecommendation` `task-actions.server.ts:3898` (gate: `resolve-packet` A|M
  **before** the task read; inner mutations re-gate), `dismissRecommendation` :4005.
- Completion: `operatorAcceptCompletion` (`operator-actions.server.ts:1593`) —
  recommend-card under supervised/non-direct; direct Done move ONLY under full
  autonomy + explicit direct grant (:1666-1690); all three acceptance gates re-checked
  (:1630-1663); PR recorded `accepted` (merge pending) — the operator can never merge.

### 3.6 Admin force-accept & merged-task terminal states

- `forceAcceptCompletion` :3778 — RBAC `force-accept-completion` (admin-only,
  `rbac.ts:69`), audits the exact bypassed gate (`task.acceptance.forced`,
  :3803-3820), then `acceptCompletion(force: true)` (skips reviewer/blocked/closed-PR
  gates :3670-3704). UI: `task-detail-page.tsx:89-112` (admin-only row).
- Terminal PR states on a Done task: `merged` (real merge),
  `accepted` (merge pending — `completeTaskMerge` :3831 finishes it; the 5-min poller
  nudges per (task, PR) — `nudgeMergePendingTasks`
  `app/server/github/reconcile-poller.server.ts:38-85`), or `closed`
  (accepted-then-closed-externally → note only, reconciler :341-352).

---

## 4. Comments, mentions, notifications

### 4.1 Writers

- Human: `appendComment` `task-actions.server.ts:621` — app-wide (any authenticated
  user; archived gate only), routed-to-agent tint via reserved handles
  (`AGENT_HANDLE_RE` :607) or a resolved named agent (`forceToAgent`), compaction on
  human comments too (:661-682).
- `commentToAgent` :886 — resolves the mentioned agent FIRST, records the comment,
  then (run-agents holders only, non-throwing `hasRuntimeRole` :1173) resumes the
  agent's session with re-established confinement (`resolveResumeConfinement`, XS-1)
  or starts a fresh primary/reviewer run (:1059-1108); `@operator` runs the operator
  (:944-961). Resumed specialists get the **canonical re-anchor block**
  (`canonicalTaskAnchor` :791, P13-D-3) + trust boundary + delivery contract
  (`specialistReplyDirective` :849, P13-RT-05).
- Agent replies: completion pipeline (`recordAgentCompletion` :1627 — reply + verdict
  + question in ONE atomic write) or `postAgentReplyComment` :1277 (interrupt/error
  path); guardrails (`meaningful-comment` drop, `evidence-separation` trim) via
  `comment-guardrails.server.ts`.
- Operator narration: `writeOperatorComment` (`operator-actions.server.ts:~300-357`,
  duplicate-suppressing) and recommendation comments.

### 4.2 Mention parsing & fan-out (NEW-4, P13-LV-11)

- One span-finder for composer highlight, renderer, and server routing:
  `findMentionSpans`/`extractMentions` (`app/ui/mention-spans.ts:50, :100`) — known
  display names (spaces allowed) matched longest-first with boundary checks; reserved
  handles (`operator|agent|claude|codex`) always route and never notify a person.
- `notifyMentionedUsers` (`app/server/tasks/mention-notify.server.ts:57-94`) resolves
  handles against enabled users by email local-part, first name, or FULL display name;
  excludes the author; respects routing prefs via `createNotification`.
- Wired into: human comments (:698), agent reply-comment path (:1321), the atomic
  finished-run report (:1806 — P13-RT-01, the primary path), Claude mid-run
  `post_comment` (`agent-toolkit.server.ts:121`), operator narration
  (`operator-actions.server.ts:351`) and recommendation reasoning (:437).
  **Exception**: `operatorPromptAgent`'s directive comment writes the timeline
  directly with no fan-out (`task-actions.server.ts:2440-2452`) — GV-06.

### 4.3 Inbox

`app/server/projections/notifications.server.ts` — per-user SQLite rows;
`createNotification` :54 is the single insert point (opt-out routing prefs, fails
open); `listNotifications` :105 overlays live actor identity and computes
`waitingOnYou` from the shared decisions set (:134-146); unread count :151;
read-marking is monotonic; packet/approval resolution marks read for every user
(`markTaskPacketApprovalRead` :211, called from resolve/transition/apply/dismiss).
SSE: `notification.created` / `notification.read` per-user events (:89-93, :165-171)
→ `sse-broker`; bell + overlay revalidate live.

Watcher fan-out: `notifyTaskWatchers` (`task-actions.server.ts:229-277`) — owner +
all project admins/maintainers, per-recipient prefs, recipient-resolution failures
logged not swallowed.

---

## 5. GitHub delivery

### 5.1 Branch & push

Branch name = `taskBranchName(taskKey)` (`branch-sync.server.ts`). Delivery is
**server-side for both backends** (F-GH3): agents commit locally in their isolated
workspace; Viberr pushes. `pushWorkspaceBranch`
(`app/server/github/push-workspace.server.ts:124`) auto-commits a dirty tree, refuses
when `canCommitPush === false` → `grant_withheld` (:179-185); other statuses:
`no_pat`, `push_failed`, `no_commits`, `pushed`.

**Withheld-delivery master gate**: `resolveDeliveryPushGrant`
(`task-actions.server.ts:2932-2953`) resolves the DELIVERING profile's
`execute-code-or-write-repo`-derived `canCommitPush`; unresolvable deliverer →
conservative deny; no deliverer → permissive. The headline capability is the master
switch through `resolveDeliveryPermissions` (§2.3).

### 5.2 Review-boundary PR open

`openReviewPrBestEffort` (`task-actions.server.ts:2956-3121`): push → surface
`grant_withheld` / `push_failed|no_pat` as timeline `github` events + watcher `policy`
notifications (`surfaceDeliveryEvent` :3129); re-reconcile the workspace after a
`pushed` so verdicts bind to what the PR carries (P11-10, :3023-3052); then
`openTaskPr` (`app/server/github/pr-open.server.ts:140`):

- **Merged-PR reuse (DG-1)**: a cached terminal PR (closed/merged) — or a cached
  "open" PR that turns out terminal on GitHub — is never reused; a FRESH PR is opened
  for reworked branches (:168-203).
- Idempotency: reuse an open PR for the deterministic head branch (:210-226).
- PR body carries goal, change summary, latest evidence rows (P13-D-26,
  `latestEvidenceLines` :69), and the task back-link (`composePrBody` :32).
- Failure taxonomy is honest: 422 → `nothing_to_review` (:292-294), 403 → scope
  violation record (NFR14, :268-288), 401/network distinct. DG-5: auth/network/
  missing-config failures at the review boundary surface to the timeline + inbox
  (`task-actions.server.ts:3091-3114`).
- `writePrToTask` :301 never downgrades a human-set `accepted`/`merged` while GitHub
  reports open (H1, :319-324) and preserves reconciler-owned `checks`/`review` facts.

### 5.3 Merge & merge detection

- Human acceptance attempts the REAL merge (`mergeTaskPrIfPossible`
  `task-actions.server.ts:3171-3195` → `mergeTaskPr`
  `github-reconciler.server.ts:560`); unreachable GitHub records `accepted`
  (merge pending) — never a false `merged` (D3/NFR15).
- **Poller**: `startGithubReconcilePoller`
  (`reconcile-poller.server.ts:170-196`) — boot pass + every 5 min
  (`RECONCILE_POLL_MS` :21), non-overlapping, HMR-safe singleton, unref'd;
  reconciles every active branched project (`projectsToPoll` :88), suppresses
  per-project audit + unchanged provenance (DG-3).
- `reconcileTask` (`github-reconciler.server.ts:153`): branch compare (rate-limit 403
  ≠ scope violation, :186-191), PR facts incl. checks + review state (P13-D-28,
  :239-259), commit-cache never wiped by an empty prefix-filtered list (:262-271).

### 5.4 Divergence surfacing (R8-6)

Fires only on the TRANSITION into a terminal PR state (:294-303):
merged-but-not-Done / closed-but-active → neutral `note` event + `policy`
notification to watchers (:353-396); withdraws now-moot recommendations
(`transition` on any divergence; `accept_completion` only when closed —
:318-339). Never auto-advances the stage. Accepted-then-closed-externally gets a
note only, no inbox alert (:341-352) — GV-09. The closed-PR **acceptance block**
(§2.4) plus the review queue's exclusion make a rejected task un-acceptable except
by admin force-accept.

---

## 6. RBAC, auth, CSRF

### 6.1 Roles

- **Org**: `admin | member` (`users.role`; `isOrgAdmin`
  `project-authority.server.ts:147-153`). Env-admin: seed admin from env
  (`seed-admin.server.ts`; admin@viberr.dev per clean-sheet seed).
- **Project**: `viewer ⊂ contributor ⊂ maintainer ⊂ admin`, single source
  `RBAC_DEFINITIONS`/`ACTION_ROLES` (`app/shared/rbac.ts:47-81`) — 19 actions, all
  monotonic; `view`/`comment` app-wide (FR4, enforcement is "authenticated" not
  `requireAction`). Policy page renders the SAME object;
  `policy-rbac.server.test.ts` drives every guard per role (matrix-derived coverage).
- **Resolution**: `resolveProjectAuthority` (`project-authority.server.ts:167-231`) —
  member role vs `ACTION_ROLES`; org-admin D2 override audited per grant
  (`project.org_admin.override` :188-202); **denials audited**
  (`project.authority.denied`, P13-D-8, deduped 60s :95-119; `silentDeny` reserved
  for the @mention probe :283-300).

### 6.2 Auth (better-auth — migration COMPLETE)

The memory hint "in-progress Option B" is stale: better-auth is the live authority.
`app/lib/auth.server.ts` — cookie `viberr.session_token`, 30-day rolling sessions,
sign-up disabled, whitelist-provisioned identities; total password hash/verify
wrappers (legacy-scrypt → 401 not 500, :149-163). **`/api/auth` splat allow-list**
(P11-02): `ALLOWED_AUTH_PATHS` :53-60 enforced in the before-hook :218-220 — six
endpoints pass, everything else 404s. Per-`email|ip` login throttle in the hook
(:221-230) replaces better-auth's shared-bucket limiter (:164-193);
`/sign-in/social` throttled per provider|ip (:236-244). OAuth whitelist resolves the
provider from the callback endpoint (P13-D-22, `oauthProviderOf` :79-89).
`api.auth.$.ts:11-17` forwards raw requests; CSRF exempt there (Origin/trustedOrigins).

### 6.3 CSRF

Session-keyed token (`app/server/auth/csrf.server.ts`), every app form posts `_csrf`
(`app/ui/csrf-input.tsx`); fetcher-friendly failure-as-result wrapper `csrfError`
(`app/features/shell/csrf-result.server.ts:19-40`, UI-32).

---

## 7. Decisions inbox ("waiting on you")

`decisionsRequiring` (`app/server/projections/decisions.server.ts:70-148`) is the
single member-scoped source (R8-3): one open decision per non-terminal task with a
packet or ≥1 recommendation. `mine` = maintainer+ (resolve-packet tier) OR the
narrow owner exception — packet or `accept_completion` recommendation only
(:118-132); org-admin-only reach is `overrideEligible`, never `mine` (:136-142).
Consumers: home per-project counts (`home-query.server.ts:106`), workspace rail/board
chip (`routes/project.tsx:54`), notification `waitingOnYou` flags
(`notifications.server.ts:134-146`). Review queue is member-scoped by acceptance
authority (owner or maintainer+) with the operator-exception disclosure
(`review-acceptance-authority.server.ts:29-47`, P13-D-9); "Still in review" labels
human-waiting rows honestly (`review-queue.server.ts` header).

**Honesty gap found**: the owner-`accept_completion`-recommendation case is counted
`mine` but is not actionable by that owner anywhere (GV-01 below).

---

## 8. Boot / recovery interplay

`app/server/boot.server.ts` wires: SSE bridge → boot rescan → file watcher → KB
watcher → GitHub reconcile poller (:16) → run recovery
(`finalizeOrphanedRuns` / `recoverUnreactedAgentRuns`,
`run-recovery.server.ts:38, :181` — replays `applyAgentCompletionEffects` for runs
whose completion callback died with the process; `outcome_key` persisted on the run
row for staged envelopes, AO-1, `task-actions.server.ts:1917-1923`) → schedule
ticker. Completion callbacks survive the finished-before-registered race
(`fireIfAlreadyTerminal`, `run-service.server.ts:110-147`).

---

## 9. Findings

| id | sev | headline | evidence | conf |
| --- | --- | --- | --- | --- |
| GV-01 | MED | A contributor **owner** whose task carries only an `accept_completion` recommendation is counted "waiting on you" but cannot act: `applyRecommendation` gates on `resolve-packet` (A\|M, no owner exception) and the UI hides Apply (`canApply = canRunAgents`) and the stage menu (`canTransition`), while `decisionsRequiring` classifies that rec as `mine` for the owner. Dead-end inbox entry; the server-side owner path (manual move → `acceptCompletion`) has no UI for them. | decisions.server.ts:129-132 vs task-actions.server.ts:3910; task-detail-page.tsx:1375, :890 | high |
| GV-02 | LOW-MED | `closedPrBlockedReason` copy instructs "…or archive the task" — no task-level archive/delete exists anywhere (only project archive, R6-3). The real escapes are rework+reopen or admin force-accept. Misleading dead-end guidance shown at all three acceptance writers. | task-file.schema.ts:541; no `archiveTask` symbol in app/ | high |
| GV-03 | LOW | Stale "Lightweight (todo/doing/done)" prose survives in live-code doc comments a pass after the preset was deleted — harmless today but invites re-implementation. | stage-roles.ts:8; review-queue.server.ts:14; routes/project.review.tsx:37 | high |
| GV-04 | LOW-MED | Intent-vs-implementation drift around FR37: the PRD still annotates owner-acceptance as NOT implemented ("gated by project role … rather than bound to the task owner") while the code ships the owner exception (R6-2) at every acceptance writer; conversely the task page's execution-profile row tells a contributor-owner "Maintainer or admin only" and a UI comment claims `accept_completion` packet options 409 for owners — both false. | prd.md:208 vs task-actions.server.ts:313-336, :3656-3663; task-detail-page.tsx:306-310, :1243-1247 | high |
| GV-05 | LOW | `resolvePacket`'s `accept_completion` performs the REAL GitHub merge **before** the locked packet-identity re-check: if the packet was replaced during the merge await, the resolution 409s but the PR is already merged — task stays in Review with a merged PR until the poller surfaces "merged but not Done". Self-healing but an external side effect committed under a stale decision. | task-actions.server.ts:3401-3407 (merge) vs :3535-3547 (identity check) | high |
| GV-06 | LOW | `operatorPromptAgent`'s directive comment is the one comment writer that skips the NEW-4 mention fan-out — a human @tagged inside an operator directive (e.g. "coordinate with @Arda") is never notified. All other writers funnel through `notifyMentionedUsers`. | task-actions.server.ts:2440-2452 (no fan-out) vs :698, :1321, :1806; operator-actions.server.ts:351, :437 | high |
| GV-07 | LOW | Decisions-inbox comment and enforcement disagree on owner recommendation authority: decisions.server.ts's own doc says "an owner governs … its `accept_completion` recommendation", but no apply/dismiss path honors an owner. Whichever way the owner ruling lands, one side must change (companion to GV-01). | decisions.server.ts:22-28, :122-132 vs task-actions.server.ts:3910, :4015 | high |
| GV-08 | INFO | A human crossing a declared `auto` boundary needs only any-member — deliberately (auto = ungoverned), and the UI always sends `manual: true` — but the API accepts it, so a contributor can curl a governed-graph transition the board never offers them. Documented in-code as unreachable-from-UI; recording so a later UI change doesn't silently widen it. | task-actions.server.ts:2769-2772 | high |
| GV-09 | LOW | An accepted (merge-pending) PR closed externally gets a timeline note but **no watcher notification** — the Complete-merge affordance silently disappears (`pr.state` → closed) and only a task-page visitor learns why; both real divergence branches do notify. | github-reconciler.server.ts:341-352 (note only) vs :378-396 | high |
| GV-10 | LOW | Replacing the delivering specialist mid-run is permitted with no live-run check and no hand-off audit distinct from `task.specialist.assigned`; the old run completes and reconciles delivery under the replaced profile while the task file names a new deliverer (verdict-snapshot fallback covers correctness, but the record of "who owned this revision" can read confusingly). | specialist-run.server.ts:257-340 (no live-run guard) vs :570-587 (run-level gate only) | med |
| GV-11 | INFO | Verified pass-13 deliverables hold on main: Lightweight preset fully gone (templates.ts:15-23, project-create.server.ts:206); org-template delivery-withheld (gagents.server.ts:292); operator snapshot exposes `pr` (operator-actions.server.ts:826-831); closed-PR gate at all three Done writers; display-name mentions via shared span-finder; finished-run mention fan-out (task-actions.server.ts:1798-1815). | cited inline | high |

---

## 10. Pass-13 claim spot-checks (verify, don't trust)

| claim (pass-13) | status on main @ fa138e1 |
| --- | --- |
| Lightweight template dropped | CONFIRMED — only `GOVERNED_TEMPLATE` exists; creation has no template field. Doc-comment residue (GV-03). |
| Org template starts delivery-withheld (last commit) | CONFIRMED — `conservativeGrantsFor("agent")` at gagents.server.ts:292. |
| NEW-4: every comment writer fans out mentions | CONFIRMED for human/agent/operator narration + finished-run reports; ONE gap remains (`operatorPromptAgent`, GV-06). |
| Display-name-with-space mentions (P13-LV-11) | CONFIRMED — mention-spans.ts longest-first known-name matching, used by mention-notify + suggestions. |
| P13-D-4 closed-PR gate on all Done writers | CONFIRMED — schema helper + 3 call sites + operator snapshot `pr`. |
| Better-auth "in-progress Option B" (memory) | STALE — migration complete; better-auth is the sole session authority with the splat allow-list. |
| AO-1 outcome_key persistence / AO-2 lease drain | CONFIRMED — task-actions.server.ts:1917-1923; operator-run.server.ts:216-243. |
