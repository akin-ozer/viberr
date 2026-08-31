# 02 — Agent runtime

How an agent is DEFINED, how it gets ENGAGED on a task, and how a run EXECUTES on each backend. Every claim names the file and symbol that carries it. Read alongside `planning/discovery-2026-08-30-controller/DESIGN.md` (ruling 99 — CONTROLLER + chained goals); the other load-bearing recent change is the 2026-08-29 "dynamic-dispatch rework" (ruling 98), tagged as such in code comments.

Two names actively lie:

- **`agent_runs.kind` is the DELIVERY axis, not a role taxonomy** (`db/migrations/0001_baseline.sql:454`): `operator` = the operator runtime; `primary` = the engagement that DELIVERS; `reviewer` = any other (supporting) engagement — a non-delivering *developer* is stored as `reviewer`; `controller` = a conversation turn. The real role rides the separate `role` column.
- **"specialist"** survives in filenames (`specialist-run.server.ts`, `resolveDeployedSpecialist`) but the concept is a generic AGENT profile + capability grants. There is also no record kind named "dispatch" — dispatch is the VERB; it writes an engagement row, an `agent_runs` row and a timeline event.

---

## 1. Agent profiles

### 1.1 Where a profile lives

A profile is a markdown file in the app-owned store, not a DB row. Two layers on purpose: identity/craft is org-wide, POLICY is per project.

Paths, all via `app/server/files/file-store-root.server.ts` (`getDataRoot(dataRoot?)` resolves `VIBERR_DATA_ROOT`, default `./data`): `agentProfilesDir` / `agentProfileFilePath(id)` → `agents/profiles/<id>.md`; `projectFilePath(slug)` → `projects/<slug>/project.md`; `kbRootDir` / `kbDirPath(dir)` → `kb/<dir>/`; `skillsRootDir` / `skillDirPath(name)` → `skills/<name>/SKILL.md`; plus `runtimes/` and `state/projection.sqlite`. `resolveStoreSegment(root, name)` guards every id/name (rejects `""`, `.`, `..`, `/`, `\`, NUL, absolute paths, then re-checks containment) — because grant-resolved content is injected into a run as TRUSTED material.

- **Parse/serialize**: `app/server/files/agent-profile-file.server.ts` — `parseAgentProfileContent(content, ctx?)`, `serializeAgentProfile(parsed)`, `agentProfileFrontmatterSchema` (`.loose()`, so unknown keys round-trip but raise an `agent_profile.unknown_field` warning). Frontmatter keys: `id, kind ("operator"|"specialist"|"controller"), name, role, desc, icon, backends[], model, scope, stages[], spanAll, capabilities[{capabilityId,mode}], extras[{label,mode}], resources{skills[],mcps[],kb[]}`. **The markdown body IS the long persona**; `desc` is the short operator-facing blurb.
- **Org template CRUD**: `app/server/org/gagents.server.ts` — `listGlobalAgentProfiles`, `saveGlobalAgentProfile`, `deleteGlobalAgentProfile`, `usedByProject`. Only `kind: "specialist"` files are listed or mutated. New templates get `conservativeGrantsFor("agent")` — delivery WITHHELD — because that editor has no capability UI. A non-zero deployment count blocks deletion.
- **Project deployment CRUD** (the only writer of a project's `agents:` list): `app/features/agents/agent-profile-actions.server.ts` — `createAgentProfile`, `deployAgentProfileFromLibrary`, `updateAgentProfile`, `deleteAgentProfile`. Canonical order: file write (`updateProjectFile`) → incremental reproject (`rebuildPath`) → audit. RBAC `assertProjectAction(db, "manage-agents", …)`, admin-only. Two distinct grant builders: `grantsFor()` (edit path, seeds unspecified caps from catalog defaults) and `createModalGrants()` (create path, materializes an omitted cap as explicit `off`).
- **Merge for display and run**: `effectiveProfileView(deployment, dataRoot, absentDeliverMode, modelMarks?)`, `assembleAgentRoster`, `listLibraryProfiles` — `app/features/agents/agents-query.server.ts`.

`agents/definitions/<id>.md` is **legacy for specialists** (F10-30 removed the per-specialist override; the persona is now the profile body). Only the operator and controller still have one, seeded by `app/server/seed/default-assets.server.ts`. The controller is a third kind, one per instance, never deployable — `app/server/controller/controller-profile.server.ts` (`CONTROLLER_PROFILE_ID`, `resolveControllerConfig`, `readControllerDefinition`), and `readTemplate` returns null for `kind: "controller"`.

### 1.2 Three shapes, not one

There is no single `AgentProfile` type — expect a diagram here:

1. **`AgentProfileFrontmatter`** (agent-profile-file.server.ts) — the stored org template. No `profileId`; `backends[]` is PLURAL.
2. **`AgentDeployment`** (`app/schemas/project-file.schema.ts`) — the project's adoption: `profileId`, `capabilities[]`, `extras[]`, and a full `definition` snapshot (kind, name, role, icon, backends, model, effort, scope, desc, persona, stages, spanAll, resources).
3. **`AgentProfileView`** (`app/features/agents/agent-types.ts`) — the merged render shape: `id, kind, name, role, icon, backends[], model, modelLabel, modelKnown, modelUnavailable?, effort, scope, customized, desc, definition, stages[], spanAll, autonomy?, actions{direct,recommend,forbidden,off?}, capabilities[], extras[], resources{…}, source`.

The run-facing projection is `ResolvedSpecialist` (`app/server/tasks/specialist-run.server.ts:173`), from `resolveDeployedSpecialist(ctx, projectSlug, profileId)` (:310) via `toResolved(view)` (:210):

| field | source | used for |
| --- | --- | --- |
| `profileId` | deployment key | engagement identity, git identity, workspace dir |
| `name` / `role` | template | run row `agent_name`, timeline copy, @mention handle |
| `backend` | `primaryRunBackend(view.backends)` (`pickBackend` :204) | which adapter |
| `model` | `resolveRunModel(backend, view.model)` | SDK model id |
| `effort` | template | claude `options.effort` · codex `modelReasoningEffort` |
| `skills[]` | `view.resources.skills` | mount (claude) or prompt text (codex) |
| `kb[]` | `view.resources.kb` | prompt injection under a shared budget |
| `mcps[]` | `view.resources.mcps` | resolved against the org MCP registry |
| `definition` | template body | the run persona (ONE source since F10-30) |
| `capabilities[]` | the DEPLOYMENT's grants | tool denylist, collab gates, mounts |
| `stages[]` / `spanAll` | template | eligibility at assign AND at run |

Resources are granted as **bare resolvable ids** — a skill's folder name, a KB's `dir` slug (`slugify(name)`), an MCP server's registry `name` — offered by `buildResourceCatalog(db, dataRoot?)` (`app/server/org/resource-catalog.server.ts`, which reserves the name `viberr`). Renames are propagated by `updateResourceReferences(kind, from, to, dataRoot?)` (`app/server/org/resource-references.server.ts`) across every `agents/profiles/*.md` and every `project.md` deployment — best-effort per file, so a hand-edit can still orphan a grant; `countProjectDeploymentGrants` / `countTemplateGrants` feed the delete-confirm dialog. An orphaned grant is DISCLOSED at run time (§6.2), never silently dropped.

### 1.3 Capability grants

One catalog: `app/shared/capabilities.ts` → `UNIFIED_CAP_CATALOG`, entries `{id, label, kinds: ("operator"|"agent")[], group: string|null, defaultMode, promotable}`. `group: null` = matrix-only advisory (no toggle, no runtime consumer). Modes: `direct | recommend | human | off`.

- **Operator** (all toggled): `dispatch-agents` "Select & run agents" (direct) · `generate-packets` (direct) · `append-typed-events` (direct) · `stage-transitions` (recommend) · `completion-for-acceptance` (recommend, `promotable:false`) · `deliver-review-pr` (direct) · `update-task-branch` (direct).
- **Agent — Repository & execution**: `execute-code-or-write-repo` · `create-task-branch` · `commit-push-branch` · `open-review-pr` (all direct).
- **Agent — Collaboration**: `comment-on-task` (direct) · `ask-human` (direct) · `use-web-search-fetch` (direct, kinds **agent + operator**) · `use-browser` (**off**) · `read-github-api` (**off**, `promotable:false`) · `report-validation-verdict` (**off**) · `attach-evidence-references` (direct).
- **Agent — Reserved for humans** (`human`, `promotable:false`): `merge-pull-request` · `transition-to-done` · `change-project-policy`.
- **Agent — advisory (`group: null`)**: `run-unit-integration-validation` · `move-task-to-review` · `read-repo-diff` · `run-validation-suites` · `post-quality-flags` · `approve-review` · `request-changes` · `author-test-cases` · `read-task-repo` · `flag-underspecified-tasks`.

Derived sets, same file: `ALWAYS_HUMAN_CAPABILITY_IDS`; `SCOPED_DELIVERY_CAPABILITY_IDS` (branch/push/PR); `VERDICT_OUTCOME_CAPABILITY_IDS` (approve / request-changes / quality-flags); `GRANT_REQUIRED_CAPABILITY_IDS` (the six where **absent means withheld**: `execute-code-or-write-repo`, the three scoped delivery ids, `merge-pull-request`, `report-validation-verdict`); `ENFORCED_CAPABILITY_IDS` (both backends); `CLAUDE_ONLY_ENFORCED_CAPABILITY_IDS` (`create-task-branch`, `commit-push-branch`, `open-review-pr`, `execute-code-or-write-repo`, `comment-on-task`, `read-github-api`). `capabilityEnforcement(id)` → `"both" | "claude-only" | "advisory"` is the one honest answer the matrix and profile panel render.

Polarity — the seam that keeps producing bugs:

- **Absent-grant meaning is a three-way split.** `GRANT_REQUIRED_*` → withheld. `dispatch-agents`, `deliver-review-pr`, `update-task-branch`, `use-web-search-fetch` are absent-means-GRANTED, each through its own gate (`dispatchGate`, `deliverGate`, `updateBranchGate`, `absentDeliverReviewPrMode`). Everything else falls to `gate()`'s absent-means-`off`. A consumer that reaches for plain `gate()` on one of the four silently re-breaks it.
- `capabilities: []` resolves to an explicitly WITHHELD set, not "unspecified" — `deploymentGrants` (specialist-run.server.ts:246) logs and substitutes `withheldAgentGrants()` (`app/features/agents/capability-catalog.ts:89`).
- A specialist `recommend` normalizes DOWN to `off` (`coerceSpecialistCapabilityMode`), never up. The specialist picker offers 3 modes (`SPECIALIST_CAP_MODES`), the operator picker 4.
- `applyVerdictOutcomeGate(grants)` renders the three verdict OUTCOMES withheld unless `report-validation-verdict` is explicitly `direct`.
- Save-time couplings: `applyGrantCouplings` = `repairDeliveryGrants` (fills a MISSING headline when a scoped grant is actionable; RESPECTS an explicit `off` and reports the contradiction) then `repairBrowserEgressGrants` (browser forces egress on). Decisions surface as `GrantCouplingNotice[]` on the result and in the audit `details`.
- Runtime interpretation: `specialistGrantModes(grants)` (`app/server/tasks/specialist-tool-policy.ts:119`) repairs exactly ONE thing — an ABSENT headline when scoped grants are actionable — and never overturns an explicit `off` (unlike `normalizeDeliveryGrants`, which would).

`effectiveProfileView` materializes every ABSENT catalog capability at the mode the RUNTIME would use before rendering, which is why the matrix, detail panel, policy counts and editor seeding cannot disagree with enforcement. Tool confinement itself: `resolveSpecialistDisallowedTools(grants)` / `resolveUndeployedDisallowedTools()` / `resolveDeliveryPermissions(grants)` in specialist-tool-policy.ts, whose `CAP_DENY_RULES` map each capability to concrete Bash/tool specifiers.

Matrix UI: `app/features/agents/capability-matrix-modal.tsx` — rows from `CAP_MODAL_CATALOG` plus a synthesized "Other actions" group for labels outside it (operator-only + advisory ids). Matching is by display LABEL, bridged back via `capabilityByLabel(label)` → `capabilityEnforcement(id)` to stamp a "Claude-enforced" chip. `forbidden` renders coral (always-human lock), `off` grey ("Not granted") — the NEW-3 distinction. Its notes block discloses that MCP tools are NOT gated by the matrix.

### 1.4 Granted resources threading into a run

Resolved in `dispatchAgentRun` (specialist-run.server.ts:1116+) in this order:

1. **MCP** — `mcpServersFor(db, mcpNames, backend)` (:275) → `resolveSpecialistMcpServersDetailed` + `verifyStdioMcpMountsForRun`. Yields mounted servers, `unresolved` (reached nothing) and `unhealthy` (mounted, last probe failed).
2. **Skills** — `mountGrantedSkills({workspaceDir, skills, dataRoot})` (`app/server/runtimes/skill-mount.server.ts:256`), Claude + real backend only.
3. **Browser** — `resolveBrowserMcp({grants, attachmentsDir, backend})` (`specialist-browser-mcp.server.ts:136`).
4. **Persona** — `buildSpecialistPersona(input)` (:2122): definition body → trusted-provenance banner → NON-mounted skill bodies (`readSkillBodies`, `SKILL_INJECTION_BUDGET = 24_000`) → `KB_PRECEDENCE_NOTE` + KB bodies (`readKbBodies`, `KB_INJECTION_BUDGET = 24_000` shared across ALL declared KBs, `app/server/files/kb-injection.server.ts`) → MCP-governance clause → browser section → attachments-drop section.
5. **Disclosure** — `recordRunInputs(db, {...resolvedResourceInputs(...)})` (:591): cwd, cloned, delivers, persona chars, skills vs nativeSkills, kb, mounted/unresolved/unhealthy MCPs, unresolved resources, denied tools, toolkit gates, prompt chars, anchor, directive. The run's INPUTS, on the run, before its first provider line.

`readKbBodies` never silently shrinks: a KB squeezed out by the shared budget emits an explicit omission marker AND a structured `unresolved` row. `collectKbDocs` walks the whole tree, refuses symlinks, guards realpath cycles, caps depth at 32 and containment-checks against the realpath'd root.

A reviewer's KB list is UNIONED with the delivering engagement's KBs — `deliveringContextGrants` (:360) + `withDeliveringGrants` (:383), ruling 57 / R19-3. **Skills are deliberately NOT inherited**; `skill-mount.server.test.ts` pins the absence of any skills-widening claim.

### 1.5 Deployment view

`app/server/agents/deployment-view.server.ts` — `readTemplate`, `parseDeploymentDefinition`, `primaryRunBackend`, `deploymentRuntimeIdentity`, `deployedSpecialistBackends`. `deploymentRuntimeIdentity` is the ONE writing of `override ?? template ?? default`; `primaryRunBackend` is THE "which backend does this profile run on" rule so run and display cannot drift; `parseDeploymentDefinition` `.catch`es each field independently so one junk value loses only that field. `listDeployedSpecialists(projectSlug, ctx)` (specialist-run.server.ts:3393) is the picker/dispatch source, returning `DeployedSpecialistView` with a pre-digested `capabilities: {delivery, verdict, askHuman, browser}`. `specialistEligibleForStage` (:3346) / `assertStageEligible` (:3368) enforce stage eligibility at BOTH assign and run.

---

## 2. Dispatch-written engagements

The rework deleted the static delivering/reviewer SLOTS. An engagement row still exists — verdict snapshots, KB union, workspace paths, single-flight and the required-reviewer gate all key off it — but it is now WRITTEN BY THE DISPATCH rather than by a separate human "engage" step.

### 2.1 The engagement record

`engagementSchema`, `app/schemas/task-file.schema.ts:184`, in task frontmatter `engagements: []`:

```
profileId, backend, role,
delivers        (default false)   // at most one true; parser demotes extras
verdictCapable  (default false)   // ENGAGE-TIME snapshot of an explicit
                                  // report-validation-verdict: direct grant
pinnedBackend?: "codex"|"claude"|null   // F27-B1 sticky retry switch
```

Helpers: `deliveringEngagement(fm)` (:211), `supportingEngagements(fm)` (:218), `requiredReviewers(fm)` (`!delivers && verdictCapable` — acceptance waits on their approval of the current work revision). `verdictCapable` is a snapshot ON PURPOSE: a live lookup would let a revoked grant leave a task permanently un-acceptable. The parser dedupes by `profileId` and demotes extra deliverers with a diagnostic (:1139–1152). Related: `workRevision {id, headSha, treeSha, branch, createdAt, sourceProfileId, kind?}` and `verdicts[]` bound to `revisionId`, so a new revision stales every prior verdict.

Projection (`0001_baseline.sql:72`, written by `app/server/projections/rebuilder.server.ts:591`): the delivering engagement is serialized WHOLE into the legacy-named `task_projections.specialist_json`, the supporting ones into `reviewers_json`. Also `work_revision_sha`, `recommendation_count`, `schedules_json` (what the schedule runner queries without reading every task file).

### 2.2 Auto-engage and capability-derived posture

`dispatchAgentRun` lines 1140–1250:

- Not engaged + `profileId` given → look it up in `listDeployedSpecialists`; absent → "Deploy it on the Agents page first."
- `delivery = view.capabilities?.delivery === true` (the repo-write grant). `wantsDelivery = input.delivers ?? (currentDeliverer === null && delivery)`.
- `wantsDelivery && !delivery` → refuse, NAMING the missing grant and where to grant it (R21-2): *"…holds no repo-write grant, so it cannot own delivery. Run it as a supporting agent, or grant "Execute code or write to the repo" on the Agents page."*
- `wantsDelivery` → `assignSpecialist` (:673): single-deliverer invariant, hand-off event, live-primary refusal — and it garbage-collects any pending `run_agent` recommendation for the profile it just engaged (:773). Else → `assignReviewer` (:848): own isolated checkout; verdict-capable ⇒ required reviewer.
- Already engaged as supporting + explicit `delivers: true` → the SAME repo-write guard (the hunt fix: it used to live only on the unengaged branch), then `assignSpecialist`.

Backend priority (:1324): `input.backendOverride ?? engagement.pinnedBackend ?? resolved?.backend ?? engagement.backend`. A D4 retry-on-other-backend PINS (`engaged.pinnedBackend = input.backendOverride`, :1948); a plain profile edit does not, so an admin's backend change still takes the next run.

`StartAgentRunInput` (:1061): `{projectSlug, taskKey, profileId?, directive?, directiveFrom?, backendOverride?, delivers?, triggeredByName?, triggeredByUserId?}`. `startAgentRun` (:1099) is a thin try/catch whose only job is releasing the mid-flight `PendingReservation` when preparation throws.

### 2.3 The `dispatch-agents` cap

`dispatch-agents` replaced the retired `assign-primary-specialist` + `summon-reviewers` pair (ruling 98(b), a deliberate breaking change — an old grant row for either retired id is simply unknown now). `dispatchGate(authority)`, `app/server/tasks/operator-actions.server.ts:518`:

```ts
if (!authority.deployed) return "deny";
if (authority.policy.has("dispatch-agents")) return gate(authority, "dispatch-agents");
return "direct";                                   // absent means GRANTED
```

Three consumers must route through it, not `gate()`: the Claude toolkit (`operator-toolkit.server.ts:535`), the Codex plan schema (`operator-run.server.ts:1516`), and `operatorDispatchAgent` itself (operator-actions.server.ts:2130). The read surface mirrors it at `agents-query.server.ts:385`. Each had to be corrected individually; a fourth consumer would silently re-break it.

### 2.4 The `run_agent` verb and the `run_agent` recommendation kind

- **Action**: `operatorDispatchAgent(db, ctx, {projectSlug, taskKey, profileId, prompt?, delivers?, reason?}, authority)` (`operator-actions.server.ts:2113`) — the ONE operator action for putting an agent to work, collapsing `engage_agent` / `run_agent` / `prompt_agent` and the specialist/reviewer function pairs. Arms: `direct` (engage-if-needed + prompt-as-comment + run), `recommend` (one card), `deny` (refused out loud, R19-6). It refuses two CONTRADICTORY hints up front — `delivers: true` on a non-repo-write profile, and `delivers: false` aimed at the current deliverer — because `dispatchAgentRun` keeps an engaged profile's shape, so honoring that hint in the label while the run went out `kind: "primary"` was "a governed lie". `resolveDeliversIntent` (:2077) is the rule this module and the auto-engage must agree on; `recordAgentSelectionTrace` (:2029) best-effort-audits the choice.
- **Tool** (Claude): `run_agent` at `operator-toolkit.server.ts:538`, args `{profileId, prompt?, delivers?, reason?}`.
- **Plan verb** (Codex): `"run_agent"` in `OPERATOR_PLAN_TOOLS` (`operator-run.server.ts:1450`), capability map :1483, schema properties :1562–1566, executor arm :2121, permitted-set filter `operatorPlanToolsFor(authority)` (:1502).
- **Human prompt path**: `operatorPromptAgent(db, {projectSlug, taskKey, directive, profileId, delivers?, handle}, ctx?)` (`task-actions.server.ts:3785`) — posts the `@handle` comment FIRST; a refused start unshifts a `note` retracting the hand-off.
- **Recommendation kind**: `RECOMMENDATION_KINDS = ["transition", "run_agent", "accept_completion", "delivery"]` (`task-file.schema.ts:235`); `run_agent` collapsed the four slot-shaped kinds. `recommendationSchema` (:257) carries `{id, kind, profileId?, prompt?, delivers?, toStageId?, label, detail}` — `delivers` is PERSISTED because the recommend arm used to announce "as a supporting agent" then drop the hint, letting Apply install the opposite posture. Writer `addRecommendation` (operator-actions.server.ts:721); applier `applyRecommendation` (`task-actions.server.ts:8250`, `run_agent` arm 8324–8345) which dynamically imports `startAgentRun` and passes `triggeredByName: userName(db, actor.userId)` + `triggeredByUserId`. UI: `app/features/task-detail/operator-recommendations.tsx`.

Supervised autonomy → ONE run-agent card; full autonomy → dispatches directly.

### 2.5 `previousStageId`

`taskFrontmatterFields.previousStageId` (`task-file.schema.ts:598`, `z.string().nullable().default(null)`, tolerant-parsed :1246, initialized `null` at creation :499). Written in `transitionStage` (`task-actions.server.ts:4397`) plus two acceptance-path stamps (:6106, :7623); read into the operator snapshot as `previousStage: {id, name}` (`operator-actions.server.ts:1631`). Durable structural "where did this task just come from" so the operator's agent choice survives past one turn — before it, prior-stage knowledge reached the operator only as one-hop trigger context or timeline prose. The `run_agent` tool description leans on it explicitly ("a task back from Review is rework for the same builder; a task newly in Review wants a verdict-capable profile").

### 2.6 The dispatch-completion contract

Owner directive 2026-08-29. Armed by `triggeredByName` / `triggeredByUserId` → `completion.dispatchedByName` / `dispatchedByUserId` (specialist-run.server.ts:2032–2040).

- **Guidance half**: `buildAnalyzePrompt` appends a `## Reporting back` section (:2553) telling the model to close its report tagging `@<dispatcher>` and `@operator`.
- **cc-append** (`task-actions.server.ts:3248`, inside `applyAgentCompletionEffects`, applied BEFORE the reply is stored so no-progress comparison, the operator's react input and the timeline all see one text): "already tagged?" is answered by `mentionNotifiesUser(db, text, userId)` (`mention-notify.server.ts:175`) — the SAME resolution ladder the fan-out delivers with — plus `/@operator\b/i`. What is missing is appended as `\n\ncc @Name @operator`. The old first-word substring check was satisfied by "@Arda Other" for dispatcher "Arda Kaya", a tag the ladder rules ambiguous and delivers to NOBODY.
- **always-react** (:3656): `mustReact = !!dispatchedByName && finished.state === "finished" && currentDepth < OPERATOR_REACT_DEPTH_CAP` (cap = 4, :173) bypasses the new-progress heuristic `operatorShouldReactToReply`. Only THIS hop is forced — runs the reacting operator then dispatches itself carry no `dispatchedByName`.
- `stripCcLine` is applied to BOTH sides of the no-progress comparison (:3645): the cc line varies with dispatch source, so identical reports would otherwise compare unequal and buy an extra operator react.

Known loss class, documented in code: a run RECOVERED after a crash degrades to the react heuristic with no cc line, because `dispatchedByName` lives only in the in-process closure.

Sources that arm the contract: the manual run-agent control (`app/routes/project.task.tsx:795`), an `@mention` (`commentToAgent`, task-actions.server.ts:1272; arming 1622/1688), a fired schedule (schedule.server.ts:609), an applied recommendation (:8337), and the controller's `run_agent_on_task`.

### 2.7 Scheduled dispatch

`SCHEDULE_ACTION_TYPES = ["run-operator", "run-agent"]` (`task-file.schema.ts:289`); statuses `pending | claimed | fired | failed | cancelled`. `scheduleSchema`: `{id, action, dueAt, profileId, prompt, createdBy, createdByLabel, createdAt, status, firedAt, claimedAt, retries}`. `app/server/tasks/schedule.server.ts` — `scheduleTaskAction`, `cancelScheduledAction`, `tasksWithUnresolvedSchedules`, `fireDueSchedules`, `startScheduleRunner`, `CLAIM_LEASE_MS = CLONE_TIMEOUT_MS + 5 min`, private `MAX_SCHEDULE_RETRIES = 3`.

- Create requires `run-agents` (maintainer+) and, for `run-agent`, a currently deployed profileId (:142–156). Route intent `schedule-action` bounds due dates to 1 min–28 days and the prompt to 4000 chars.
- R22: an entry pins NO backend and NO autonomy. The profile id is the only pin; everything else resolves from the LIVE deployment at fire time.
- The tick CLAIMS an occurrence in the file before the detached enqueue, so a crash between claim and completion is re-drivable by lease expiry. A `run-agent` occurrence whose profile already has a live run is deferred pre-claim (:415–438) so it does not bounce off single-flight and burn a retry.
- Fire (:594): `startAgentRun` with `triggeredByName = createdByLabel`, `triggeredByUserId = createdBy`, actor `{userId:"system", label:"schedule runner"}`, ctx `operatorAuthorized: true`. Because that bypasses the route layer's `requireRunAgents`, the archived-project freeze is re-decided here (`projectArchivedFor`, :350).
- Three failure dispositions: 409 → `deferredConflict` (back to `pending`, retries UNTOUCHED — a legitimately long run must not burn the budget); 400 → `refusedValidation` (terminal `failed` with the reason on the timeline); else bounded retry. An entry with `action: "run-agent"` and no profileId is terminal-failed visibly (:588), never a surprise operator turn.

---

## 3. Run execution

### 3.1 The pipeline

```
dispatchAgentRun / runOperator / runControllerTurn
  → reserveRun(db, ReserveRunInput)      # a live `running` row BEFORE the clone
  → cloneRepo / mountGrantedSkills / resolve MCP / build persona + prompt
  → startRun(db, StartRunInput)          # adopts the reservation, builds RunSpec
      → selectAdapter(backend, adapters)
      → admitRun(...) | direct launch    # concurrency gate
      → launch(db, spec, adapter, opts)  # RunSink + adapter callbacks
          adapter.start(spec, {onLine, onPhase, onExit})
  → registerRunCompletion(runId, cb, db) # reply / verdict / react
```

`RunSpec` (`app/server/runtimes/adapter.server.ts:50`) is the single contract every adapter receives; `RuntimeAdapter` (:234) is `{backend, start(spec, cb) → RunHandle}`. Adapters never touch the DB, files or the broker — the RunSink does. `RUN_PHASE` (:185) is the shared vocabulary: `preparing` (emitted by the PIPELINE, before any adapter exists), `starting`, `working`, `finishing`; `phaseStepForLine` (:209) derives the step from the PROJECTED display line, so "Bash · npm test" reads identically on both backends. Phase writes are throttled in `launch` (immediate on a phase CHANGE, ≥1 s apart for step-only churn).

`registerRunCompletion(runId, cb, db?)` (last writer wins) and `chainRunCompletion` (existing fires first) both call `fireIfAlreadyTerminal` when handed a `db` — covering the F-SPAWN2 race where a run dies synchronously at launch (`spawn EBADF`) before the caller can register. A throwing callback triggers `noteCompletionEffectsLost` (:1085), which writes a `continuity` timeline entry and flips `waiting = "human"`.

### 3.2 Workspace isolation

- Root `<taskDir>/workspace` (`taskWorkspaceRoot`, specialist-run.server.ts:2649).
- **Delivering** engagement → `<workspaceRoot>/<repo>` — the tree `git add -A` delivery ships, the operator reads, and evidence paths resolve against.
- **Supporting** engagement → `<workspaceRoot>/support/<profileId>/<repo>` (`supportCheckoutDir`, :2691, P8/pass-25), so a supporting run's writes — only ADVISORY-blocked on Codex since R22 — can never reach the delivering tree or be swept into the delivered PR. `cloneRepo` DELETES and re-clones it fresh every dispatch, which is why same-engagement runs must be serialized.
- A real-backend run's cwd is ALWAYS an isolated workspace dir, never the task dir; a checkout-less supporting run falls back to its own scoped root.
- These are plain clones, not git worktrees. `app/server/tasks/repo-mirror.server.ts` makes later tasks clone in seconds; `mirrorIsCold` drives the honest "one-time mirror build" strip copy and `git-clone-progress.server.ts` turns the cold clone into a live percentage. `CLONE_TIMEOUT_MS` (`git-clone-auth.server.ts:199`, `VIBERR_GIT_CLONE_TIMEOUT_MS`, default 900 000).
- Retention: `reclaimTerminalTaskWorkspaces(db, {dataRoot?})` (`app/server/tasks/workspace-retention.server.ts`) removes `workspace/` for tasks in their project's TERMINAL stage — the LAST stage whatever its id, since stages are renameable. A workspace is a cache, not canonical state. Best-effort, idempotent. **Both callers gate on `activeRunCount(db) === 0`** (`app/server/ops/maintenance.server.ts:120`, which returns `1` on an unreadable table — skipping a reclaim costs disk, doing one over a live tree costs a run). Deliberately NOT part of `db/retention.server.ts`, whose contract is SQLite-only.

### 3.3 Per-run environment

`workspaceRunEnv` (:2981) returns ONE var: `GIT_CEILING_DIRECTORIES = <taskDir>` — deliberately a STRICT ANCESTOR of both cwd shapes, because a ceiling EQUAL to cwd is a no-op (git's first step up lands in the ceiling's unblocked parent). It stops repo-discovery reaching a host `.git` above the data root; it is NOT a filesystem or process isolation boundary. `agentGitIdentityEnv(profileId)` (:3018) sets `GIT_AUTHOR_NAME/EMAIL` + `GIT_COMMITTER_NAME/EMAIL` to `{profileId, <profileId>@viberr.local}` (`agentGitIdentity`, :3014) so codex and claude are indistinguishable in the git history — on Codex these reach the model's shell only because they are named in `SHELL_EXPORTED_ENV_KEYS`. Agent runs are NOT handed push credentials: delivery is server-side on both backends (`pushWorkspaceBranch`).

### 3.4 The Claude leg

`createClaudeAdapter` (`app/server/runtimes/claude-runtime.server.ts:563`) over `@anthropic-ai/claude-agent-sdk` `query()`. The prompt is fed as a one-message async iterable (`singlePrompt`) because `Query.interrupt()` exists only in streaming-input mode.

Options (:735): `cwd`; `permissionMode = autonomous ? "bypassPermissions" : "default"`; `maxTurns = resolveMaxTurns()` (default 2000, `VIBERR_CLAUDE_MAX_TURNS`) — a RUNAWAY guard, not a work budget; `abortController`; `settingSources: nativeSkills.length ? ["project"] : []`; `skills: nativeSkills`; `plugins: []`; `strictMcpConfig: true`; `managedSettings = {claudeMdExcludes: ["**/CLAUDE.md","**/CLAUDE.local.md","**/.claude/**"]}` only when the project source is open. `systemPrompt`: for `kind === "operator" | "controller"` the persona REPLACES the default (they never write code and work through in-process tools); for a specialist/reviewer it is `{type:"preset", preset:"claude_code", append: persona}` so the coding harness survives. `model` via `resolveClaudeModel` (:119) — family labels → `sonnet|opus|haiku`, dated ids pass through, unknown → undefined (SDK default); `effort` via `resolveClaudeEffort` (:142) — only the SDK's own union survives.

Denylist assembled at :839 — `BASE_DENIED_BUILTINS` (:284: `Skill` unless the run mounted skills, the whole `Task`/`TaskCreate|Get|List|Output|Stop|Update` subagent family, `Workflow`, `CronCreate|Delete|List`, `ScheduleWakeup`, `RemoteTrigger`, `Monitor`, `PushNotification`, `SendMessage`, `DesignSync`, `EnterWorktree`, `ExitWorktree`) + for operator/controller `OPERATOR_READ_ONLY_DENIED_TOOLS` (:220: `Bash`, `Edit`, `MultiEdit`, `Write`, `NotebookEdit`) + for `kind === "reviewer"` `SUPPORTING_DENIED_BUILTINS` (:243: the write built-ins plus `git commit|push|checkout -b|-B|switch -c|-C` and `gh pr create|merge`) + `spec.disallowedTools`. Deliberately NOT denied: `ToolSearch` (the operator loads its deferred `mcp__viberr__*` tools through it — 137 real calls), the coding toolset, web tools, and the whole `mcp__*` channel.

Terminal classification is gated on the final `result` envelope's `is_error`, never an exit code. `classifyClaudeError` (:498) → `quota | auth | session_missing | unknown`, riding the err line's tag as `run·error·<kind>` plus a `redactProviderText` sentence. Special arms: `error_max_turns` → `run·error·max_turns`; spawn `EBADF/EMFILE/ENFILE` and `ENOENT` get their own copy; an `is_error` RESULT (not a thrown error) is classified identically (P14-RT-10).

### 3.5 The Codex leg

`createCodexAdapter` (`app/server/runtimes/codex-runtime.server.ts:543`) over `@openai/codex-sdk` (`CODEX_SDK_VERIFIED_VERSION = "0.146.0"`, asserted against package.json by a test so the claim cannot rot). `startThread` / `resumeThread` then `thread.runStreamed(prompt, {signal, outputSchema?})`.

`ThreadOptions` (:726): `model`, `sandboxMode`, `workingDirectory`, `skipGitRepoCheck: true`, `approvalPolicy: "never"` (no interactive approval channel exists; "never" returns denials to the model instead of hanging), `modelReasoningEffort` when in the SDK's union (`resolveCodexReasoningEffort`, :189), `additionalDirectories = [attachmentsWritableDir]` under workspace-write, `networkAccessEnabled = false` for operator runs, `webSearchMode = "disabled"` when egress is withheld.

`resolveCodexSandboxMode(spec)` (:368) — R22, "viberr itself is the sandbox": only a fully-autonomous DELIVERING run that also holds egress reaches `danger-full-access`; **everything else is `workspace-write`**, never `read-only` (that mode is gone), because `danger-full-access` cannot honor the egress toggle.

`codexConfigForRun(spec, base)` (:268) is the isolation half config can carry: `allow_login_shell: false`; `project_doc_max_bytes: 0` (the repo's `AGENTS.md` never becomes instruction-tier — the Claude counterpart of `settingSources: []`); `skills: {include_instructions: false, bundled: {enabled: false}}`; `features: {apps:false, plugins:false, hooks:false}`; `memories: {generate_memories:false, use_memories:false, dedicated_tools:false}`; `mcp_servers: codexMcpServers(...)`; `shell_environment_policy: {inherit:"core", ignore_default_excludes:false, set:<SHELL_EXPORTED_ENV_KEYS>}`; `developer_instructions = spec.systemPrompt`. `SHELL_EXPORTED_ENV_KEYS` (:218) is the CLOSED list of vars crossing into the MODEL's shell: `GIT_CEILING_DIRECTORIES` + the four GIT_AUTHOR/COMMITTER vars.

Terminal: success = `turn.completed` seen with no TOP-LEVEL `turn.failed` / `error` (an ITEM whose type is `error` is explicitly non-fatal in the SDK contract). `classifyCodexFailure(cause, phase, streamText)` (:450) prefers the STREAMED reason; `CodexFailureKind = quota | auth | idle_timeout | session_missing | unknown`.

### 3.6 Backend selection, credentials, models

`app/server/runtimes/runtime-registry.server.ts`:

- `isBackendAvailable(backend)` — a cheap credential-PRESENCE check re-run on EVERY call (an explicit `setBackendAvailability` override is sticky). Claude: `ANTHROPIC_API_KEY` | `CLAUDE_CODE_OAUTH_TOKEN` | (`VIBERR_CLAUDE_USE_CLI_AUTH=1` AND a plausible config dir). Codex: `CODEX_ACCESS_TOKEN` | `CODEX_API_KEY` | `OPENAI_API_KEY` | (`VIBERR_CODEX_USE_CLI_AUTH=1` AND a real `$authSource/auth.json`). The registry NEVER makes a paid call to detect availability.
- `backendCredentialHealth(backend, env)` — the ONE place UI, run service and logs get "why", with `verification: credential | file | presence | none`. `presence` is the honest macOS case (Claude Code's credential is in the login Keychain; probing would pop a system dialog).
- `codexAuthMisconfiguration(diag)` (:184) names the D1 trap: `CODEX_HOME` pointed at Viberr's OWN run home makes the auth source and the run home the same empty directory, so no `codex login` can ever reach a run.
- `filteredSpawnEnv()` strips every `CREDENTIAL_ENV_RE` match plus `DATABASE_URL|REDIS_URL|SSH_AUTH_SOCK|GPG_AGENT_INFO`; `claudeSpawnEnv(configDir, apiKey, oauthToken)` / `codexSpawnEnv(codexHome, accessToken, preferCachedLogin)` re-add exactly the selected credential. **Both SDKs REPLACE the child env**, so the filtering is real — and is why a COMPLETE env (PATH/HOME) must be passed, not `{}`.
- `selectAdapter(backend, adapters)` returns `{kind:"unavailable"}` or the adapter, and re-mirrors the codex auth home PER RUN (`prepareCodexHome`), not once per process (P14-RT-05).
- R7-2: an unavailable backend does not fabricate a fallback stream — `failRunUnavailable` writes one classified `run·unavailable` err line through the regular sink and finalizes `error`, so completion callbacks fire through the already-terminal path.

Homes: `resolveClaudeConfigDir()` (`claude-config.server.ts:25`) → `CLAUDE_CONFIG_DIR` | `~/.claude` (CLI-auth opt-in) | `<dataRoot>/runtimes/claude-home`. `resolveCodexHome(env)` (`codex-config.server.ts:67`) → `<VIBERR_DATA_ROOT>/runtimes/codex-home`, always app-owned; `prepareCodexHome` (:129) symlinks (preferred, so a CLI token refresh stays coherent) or copies `auth.json` in, and touches disk ONLY in cached-login mode.

Models (`model-catalog.server.ts`): `curatedCatalog`, `defaultModelFor`, `defaultEffortFor`, `isKnownModel`, `foreignModelBackend`, `resolveRunModel`, `resolveRunEffort`, `modelDisplayName`, `getModelCatalog` (`LIVE_TTL_MS` 10 min, `LIVE_TIMEOUT_MS` 15 s; Claude enhances the curated list from the live `supportedModels()`, Codex is curated-only; NEVER throws). `startRun` substitutes a FOREIGN model with the backend default, stores the substituted model, and injects `MODEL_SUBSTITUTED_TAG = "run·model_substituted"` as the run log's FIRST line (run-service.server.ts:678, 712–737).

Availability is learned from REAL failures only, never a synthetic probe (ruling 19): `model-availability.server.ts` — `MODEL_UNSUPPORTED_RE`, `markModelUnavailable`, `clearModelMark`, `unavailableModels`, `noteModelAvailabilityFromFailure` (a no-op unless the provider text matches, so quota/auth failures never mark a model unusable). Row present = unavailable; row absent = unknown-but-offered, deliberately not "proven available".

Quota telemetry: `backend-quota.server.ts` — `recordBackendRateLimit`, `latestBackendRateLimits`, stored as `instance_settings` KV under `backendRateLimit.<backend>`. An OBSERVATION log fed by the Claude SDK's `rate_limit_event` envelopes, try/caught and swallowed so it can never break the run-line persist path. **It gates nothing** — pre-failure visibility on `/insights`; a backend with no reading renders neutral.

### 3.7 Run logs

Canonical truth is one raw NDJSON file **per run** (never per session — a resume mints a new run row sharing the session id, so a session-keyed file would interleave two runs): `<dataRoot>/runtimes/<backend>/<runId>.jsonl`, via `rawLogPath(backend, runId, dataRoot?)` / `appendRawLine(...)` (`app/server/runtimes/run-store.server.ts:386–405`). `run_log_lines(id AUTOINCREMENT, run_id → agent_runs ON DELETE CASCADE, seq, occurred_at, raw_json, display_json, created_at)` with UNIQUE `(run_id, seq)` is the projection. Store API: `upsertRun`, `patchRun`, `getRun`, `listRunsForTaskRows`, `agentNamesByProfile`, `nextSeq`, `listRunLines`, `listRunLinesTail`, `runLineStats`, `runIdsWithMissingSession`, `insertRunLine`.

`createRunSink(db, spec)` (`run-sink.server.ts`) → `{markRunning, phase, line, finalize}`. Per line, in order — **persist BEFORE publish**, so a client reacting to the event can always fetch the line: (0) redact, (1) `appendRawLine`, (2) `insertRunLine` with `display_json`, (3) `patchRun` folding session id / turns / token counters (running `Math.max`, so a partial run never regresses) / last-seen cost, (4) `publishRunLogAppended({runId, seq})`. `rate_limit_event` readings forward to `recordBackendRateLimit`.

Redaction (P13-U-1) is built ONCE per run by `createLineRedactor(env)`: every `process.env` value whose key matches `CREDENTIAL_ENV_RE` and is at least `MIN_SECRET_VALUE_LEN` (12) chars, longest-first, plus `TOKEN_PATTERN_SOURCE` from `app/server/secrets/git-output-redact.server.ts`. The display projection is redacted by serializing to JSON, replacing, and re-parsing only if the string changed (`REDACTED` carries no quote or backslash, so structure survives). Deliberately NOT an entropy heuristic.

Two failure regimes: a DRAINED database (`runPersistDrained`) logs ONE warning for the whole run and stops writing; a real persist failure logs per line and writes one `LINE_LOST_TAG = "run·line_lost"` err line so a reader knows the console is incomplete while the `.jsonl` still holds everything. `resolveTerminalState(current, desired)` (:49) — the FIRST terminal state wins (B-FD7), so a human's recorded `interrupted` is never overwritten by the still-live adapter's later exit.

Reads: `getRunLog(db, runId, {since?|before?, limit?})` (run-service.server.ts:1656) picks forward vs backward mode, default page `RUN_LOG_PAGE_LINES = 200`. `projectRunsForTask(db, projectSlug, taskKey)` (`run-projection.server.ts`) groups rows by agent (`groupKeyOf`: `"operator"`, else `"<kind>:<profileId>"`) so every RESUME collapses into one picker entry, and fills a **newest-run-first** window against two budgets — `RUN_LOG_WINDOW_LINES = 400` and `RUN_LOG_WINDOW_BYTES = 384 KB` (a measured task carried 420 lines ≈ 928 KB and re-shipped all of it on every SSE revalidation, NFR5). `lineCount` on the view is what EXISTS, not what shipped. `failedBackendUnavailable` + `altBackend` drive the D4 cross-backend retry offer.

SSE: `publishRunLogAppended` / `publishRunStateChanged` (`run-events.server.ts`) publish DIRECTLY to the broker, bypassing the projection emitter (which would imply "a projection changed" and tempt a rebuild per log line). Payloads are REFERENCE-ONLY (`runId` + `seq`), never content. Both early-return when `projectSlug === ""` — controller turns are owner-only and would fail the wire schema's non-empty-slug rule.

Client: `app/features/runtime/{use-run-log-stream.ts, runs-panels.tsx, runs-helpers.ts, log-noise.ts, log-clock.ts, runtime-types.ts}`. Controller run logs authorize by CONVERSATION ownership (or live org-admin), never project membership — `canReadControllerRunLog` (`controller-run.server.ts:438`).

Retention: `RUN_LOG_RETENTION_DAYS = 30` (`db/retention.server.ts`) and `pruneRuntimeTranscripts` (`app/server/ops/transcript-retention.server.ts`, `VIBERR_TRANSCRIPT_RETENTION_DAYS` default 30) are aligned ON PURPOSE, so "run logs are kept 30 days" is one true statement about both the file and its projection. `VIBERR_SESSION_HOME_RETENTION_DAYS` (default 30, `0` = forever) prunes `runtimes/claude-home/projects/` and `runtimes/codex-home/sessions/`.

### 3.8 Interrupt and watchdogs

Four levers, in escalation order.

1. **`interruptRun(db, {projectSlug, taskKey, runId}, actor)`** (run-service.server.ts:1521). RBAC `run-agents` (admin|maintainer) via `requireRunAgents` through the ONE authority path, deliberately NOT gated on `archived` (stopping is de-escalation). Idempotent — a terminal run returns `already-terminal`. With a live handle: `handle.interrupt()`, delete the handle, stamp `interrupted_by` immediately so it lands regardless of adapter timing. Without one (post-restart, seeded row, or a run still RESERVED mid-clone): write the terminal row directly, publish, and `state.reserved.delete(runId)` + `drainRunQueue(db)` (F28-R1 — else the slot stays counted for up to the full clone timeout). Always audits `runtime.run.interrupted`.
2. **Claude watchdog**: idle guard `claudeIdleTimeoutMs()` (`VIBERR_CLAUDE_IDLE_TIMEOUT_MS`, default 15 min), re-armed on every stream message. On timeout: cooperative `Query.interrupt()` → after `INTERRUPT_GRACE_MS` (20 s) `abortController.abort()` (SIGTERM→SIGKILL ~5 s later) → after `INTERRUPT_ABORT_GRACE_MS` (10 s) a backstop settle. A hung run settles `error` (`run·error·idle_timeout`, so the react/stuck-loop packet fires); a human interrupt stays `interrupted` — `idleTimedOut` is the discriminator. Before P13-RT-11 Claude had NO timer at all.
3. **Codex watchdog**: `codexIdleTimeoutMs()` (`VIBERR_CODEX_IDLE_TIMEOUT_MS`, default 15 min). Here `abort.abort()` IS the kill lever; `INTERRUPT_SETTLE_GRACE_MS` (20 s) force-settles if the child survives SIGTERM (trapped signal, or a grandchild holding the stdout pipe open) and the iterator never ends. Codex has no `maxTurns` and settles only on `turn.completed`.
4. **Clone timeout** `CLONE_TIMEOUT_MS`, then the next boot's `finalizeOrphanedRuns` as the last resort.

### 3.9 Concurrency, reservations, single-flight

Cap: `getMaxConcurrentRuns(db)` / `setMaxConcurrentRuns(db, n)` (`app/server/settings/instance-settings.server.ts`) — an instance SETTING (key `maxConcurrentRuns`), **not** an env var. Default `0` = **unlimited**; ceiling `MAX_CONCURRENT_RUNS_CEILING = 64`. Service state lives on `globalThis[Symbol.for("viberr.runService")]` — `{handles, reserved, adapters, completions, pending, draining}`, HMR-safe.

- `liveCount(state) = handles.size + reserved.size` (:1291) is the ground truth; no separate counter to leak. A reserved run has COMMITTED to running (F26-1), else every reserving dispatch slipped past the cap during its clone.
- `reserveRun(db, input)` (:449) returns `null` when no slot is free (caller falls through to the normal queued path) or on a display failure, but THROWS a 409 on a single-flight violation — that is the other dispatch winning, not a display problem. Returns `{runId, threadId, startedAt, phase(), abandon()}`.
- `admitRun(db, runId, launchThunk)` (:1307) launches now, or parks the thunk in `state.pending` with the DB row left `queued`.
- `drainRunQueue(db)` (:1331) is called from every `onExit` (BEFORE the completion callback, so a chain keeps flowing even if the callback throws), from `abandon()`, from the unavailable-backend path, and from interrupt-while-reserved. It re-reads the cap each pass and DROPS a pending run whose row is no longer `queued`; `state.draining` guards reentrancy.
- `runConcurrencySnapshot(db)` (:1366) → `{cap, live, queued}`.

**There is no `releaseRun` and no `withLease`.** Slot release is `state.reserved.delete(runId)` / `state.handles.delete(runId)` plus `drainRunQueue`.

Single-flight is enforced twice — a JS preflight in `dispatchAgentRun` (:1259–1303) and, because that check awaits through a multi-minute clone, two partial unique indexes:

```sql
idx_agent_runs__one_delivering       (project_slug, task_key)
  WHERE kind='primary'  AND state IN ('queued','running')
idx_agent_runs__one_live_per_support (project_slug, task_key, agent_profile_id)
  WHERE kind='reviewer' AND state IN ('queued','running')
```

`singleFlightConflict(kind, sqlite)` (:415) translates SQLite errcode **2067** into a 409 for BOTH write paths, discriminating on the violated columns so a `thread_id` collision (a caller bug) is not reported as "a run is already in progress". `ensureSingleFlightIndexes(db)` (`app/server/db/sqlite.server.ts:114`) idempotently re-creates the supporting index at boot, because data roots predating that line already applied the squashed baseline; failure is warned, not fatal.

`assertRunReservationLive(db, runId)` (:388) — `RESERVATION_LIVE_STATES = ["queued","running"]` — is checked at three points: before preparation, after the clone (specialist-run.server.ts:1536), and inside `startRun` immediately before adopting. Without it the adoption upsert REVIVED a run a human had stopped (C4-opres). `abandon()` likewise refuses to demote an already-terminal row.

Leases, where they DO exist: the controller conversation lease (`controller-run.server.ts:67–99`, FIFO of at most `MAX_QUEUED_MESSAGES = 8`, released in `settleTurn`); the operator's coalesce lease (a queued human directive is handed to the in-flight turn); and the schedule claim lease (`CLAIM_LEASE_MS`, re-stamped at fire time so a long wait does not look like a crashed tick).

### 3.10 Recovery

`app/server/runtimes/run-recovery.server.ts` (`RECOVERY_REINVOKE_CAP = 3`, `RECOVERY_WINDOW_MS` 30 min, `STRANDED_PLAN_MAX_AGE_MS` 60 min):

- `finalizeOrphanedRuns(db)` — on a fresh boot a non-terminal row is by definition an orphan: patch `state='error', finishedAt=now, interruptedBy='restart'`, then re-invoke the operator per affected task, guarded by a crash-loop backstop (a `run.recovery.reinvoked` audit row per attempt; 3 inside 30 min stops further re-invokes). `controller` runs are skipped. The returned `reinvokes` promise is joinable because those drives clone the very workspaces the boot reclaim deletes.
- `recoverUnreactedAgentRuns(db, ctx)` — finished `primary`/`reviewer` runs whose task is still `waiting='agent'` with no `task.agent.replied` audit row. It re-supplies `outcome_key` so a staged Claude verdict survives a restart instead of falling back to the prose regex.
- `recoverStrandedOperatorPlans(db, ctx)` — the Codex-only window where the operator coordinates AFTER the run finishes; bounded to 1 hour, because a plan is a decision about a state that has since moved.
- `IDEMPOTENCY_AUDIT_ACTIONS = ["task.agent.replied", "runtime.operator.plan_executed"]` are EXEMPT from the 90-day audit window (`db/retention.server.ts`), because deleting one makes the next boot redo the work.

Boot chain `reconcileRestartedWork(db, deps?)` (`app/server/boot.server.ts`) runs the four steps strictly sequenced and individually caught: finalizeOrphanedRuns → recoverUnreactedAgentRuns → recoverStrandedOperatorPlans → `await orphanReinvokes` → workspace reclaim, and only when `activeRunCount(db) === 0`.

Single-writer safety is a separate module, `app/server/db/data-root-lock.server.ts`: an `openSync(path, "wx")` at `<dataRoot>/state/writer.lock`, held for process lifetime. `classifyLock(holder, self, isAlive, readProcStartTicks?)` → `stale | held | unknown-holder`; the F20-8b arm compares `/proc/<pid>/stat` field 22 against the recorded `procStartedAt` when the lock names THIS process's own pid, because a self-liveness probe always says "alive" and bricked containers running as pid 1 with a compose-pinned hostname. A 20 s guard (`DATA_ROOT_LOCK_GUARD_INTERVAL_MS`) re-verifies ino/dev + `bootId` and, on a `stolen` verdict, writes a fatal line and `process.exit(1)` — ABANDONING the fd rather than unlinking a file that now belongs to someone else. `VIBERR_FORCE_DATA_ROOT_LOCK` is the override.

Session continuity: `probeSessionContinuity(backend, sessionId)` + `SESSION_MISSING_RE` (`session-export.server.ts`), three-valued `present | missing | unknown` — a boolean would read "no transcript store on this host" as "session gone" and force a fresh run on every deployment whose provider writes transcripts somewhere this process cannot see. `resumeRun` (:1214) probes BEFORE handing the id to the SDK; on `missing` the turn is not failed — it runs once as a FRESH canonical-anchored run with a `continuityResetPreamble`, the dead run is stamped `run·session_missing`, the timeline says continuity was lost, and `runIdsWithMissingSession` stops `latestSessionRun` re-selecting the dead id forever. Three probes exist deliberately: `transcriptExists` (loader path, filename-only, 30 s cache), `probeSessionContinuity` (resume path, UNCACHED, full locator), `locateTranscript` (export route, plus file reads). `buildResumeScript` emits a self-contained base64-embedded bash installer carrying the transcript and NO credentials.

---

## 4. The user-authority ceiling per tool call

Ruling 99. The controller is the one agent whose authority is a LIVE HUMAN's, resolved per tool call — never snapshotted at conversation start, never stored as a grant row (a stored grant would be a toggle with no effect, so none exists). `buildControllerToolkit(deps)` (`app/server/controller/controller-toolkit.server.ts:168`) builds an in-process Claude SDK MCP server `viberr_controller`; `deps.user` is the only authority anything runs under.

- Actor `{userId: user.id, label: "<email> · via controller"}` — guards bind to the human, the audit row discloses the instrument.
- Instance scope: `requireOrgAdmin(what)` (:182) checks `isOrgAdmin(db, user.id)` LIVE and, on refusal, writes a `controller.authority.denied` audit row before throwing (P13-D-8 parity — a project denial is audited, so an instance denial must not read cleaner).
- Project scope: `requireVisible(slug, what)` (:196) goes through `assertProjectAction(db, "any-member", …)`, so the D2 org-admin override, denial audit rows, the archived read-only gate and members-only visibility all apply for free. Missing and forbidden projects answer the SAME `notVisible` sentence — no existence oracle.
- Per-verb gates reuse the human guards: `run_agent_on_task` (:1127) calls `canRunAgents(db, authority, actor, …)`, refusing with "[denied] Running agents needs the maintainer role (or project admin) in this project." It then dispatches through the SAME `runOperator` / `startAgentRun` entry points, arming the dispatch-completion contract with `triggeredByName: userName(db, user.id)` + `triggeredByUserId`.
- Refusal shape: `run()` / `runWith()` (:220/:243) map an `AppError` to `[denied] <the guard's own sentence>` for 401/403 and `[error] …` otherwise; `CONTROLLER_TOOLKIT_INSTRUCTIONS` (:145) tells the model a `[denied]` answer is final and must be relayed with its reason.
- No tool exists for merge, acceptance, force-accept, packet resolution, a terminal-stage move, or ANY delete. **The ceiling is the tool SET, not a prompt.**
- The controller's run is Claude-only and enforced: `runControllerTurn` (`controller-run.server.ts:121`) refuses honestly when `isBackendAvailable("claude")` is false, and `startTurnRun` (:204) adds `disallowedTools = ["Read","Grep","Glob","WebFetch","WebSearch"]` on top of the operator read-only set — its world is the product, not the disk. Runs carry `project_slug = ''` and `task_key = <conversationId>`.

Ordinary agents authorize differently: **their tools are BUILT only when the capability is granted.** `buildAgentToolkit({db, ctx, projectSlug, taskKey, actorRef, outcomeKey, collab})` (`app/server/tasks/agent-toolkit.server.ts`) mounts `viberr_agent` with `post_comment` (`comment-on-task`), `ask_human` (`ask-human`), `report_outcome` (`report-validation-verdict`, its optional `evidence` field separately gated on `attach-evidence-references`) and `github_read` (`read-github-api`). An ungranted capability's tool is never built — there is no `operatorAuthorized` boolean on this path. Gates come from `resolveAgentCollab(grants)` / `effectiveCollabMode(grants, id)` (`agent-outcome.server.ts:381/407`), where a `recommend` grant falls through to the catalog default rather than being widened.

Server-side re-derivation is the real gate: the completion pipeline re-resolves the same grants before recording a verdict, opening a question packet, or accepting the agent's own evidence rows — which is how those three bind on Codex too, where no tool ever existed. (A Codex agent CAN fill the envelope's `verdict` field without the grant; the verdict is discarded and the drop is LOGGED, not silent — B-5.)

`withMcpAutoApproval(allowedTools, mcpServerNames)` (run-service.server.ts:642) auto-approves every MOUNTED server the caller did not already name, in ONE funnel (fresh, operator, resume). `allowedTools` is the APPROVAL list: without an entry an `mcp__*` tool stalls on a permission prompt no human can answer, which made `bypassPermissions` load-bearing for a capability GRANT. A caller that curated per-tool entries (the operator does) is left alone.

---

## 5. Browser capability

`use-browser`, default OFF, ruling 75 / R19-19 (`app/server/tasks/specialist-browser-mcp.server.ts`):

- `resolveBrowserMcp({grants, attachmentsDir, backend})` (:136) requires `use-browser === "direct"` AND `use-web-search-fetch === "direct"` — the browser IS network egress, and the contradictory pair is SURFACED as an `UnresolvedMcpGrant` on the existing disclosure pipe, never silently resolved either way. Enforcement is the MOUNT (the server is simply not attached), the strongest shape the runtime has, and it binds on BOTH backends.
- `BROWSER_MCP_NAME = "viberr_browser"`, in `RESERVED_MCP_NAMES` and refused as a registry name at save, so no org row can shadow it.
- The mount is `{command: process.execPath, args: [<@playwright/mcp cli.js>, "--headless", "--isolated", "--output-dir", <attachmentsDir>, …("--image-responses","omit") on codex, …("--executable-path", VIBERR_BROWSER_EXECUTABLE, "--no-sandbox")]}`. **No `env`** — deliberately, so the config survives codex's `--config` argv serialization with full parity (the F7-MCP1 secret-drop concern is moot).
- Chromium ships IN THE IMAGE: `Dockerfile:60–73` installs Debian `chromium` + `fonts-liberation` and sets `ENV VIBERR_BROWSER_EXECUTABLE=/usr/bin/chromium`. `--no-sandbox` rides with it because chromium's user-namespace sandbox cannot start under docker's default seccomp as the non-root `node` user.
- `browserRuntimeStatus()` (:108) hoists the same checks so a health surface can report "chromium is not installed" BEFORE a run is spent. A pinned-but-absent executable is a REFUSAL with disclosure, not a deep failure inside the first browser tool call.
- Containment: `--isolated` (in-memory profile — nothing survives a run or crosses tasks); no `--allow-unrestricted-file-access`, so Playwright MCP blocks `file://` and confines file access to the child's cwd (the run workspace), never the data root. Injection stance is prompt-level (`browserPersonaSection`, :232): page content is DATA, never instructions; never enter credentials; the browser widens no authority.

Evidence / attachments flow: the dir is `taskAttachmentsDir(projectSlug, taskKey, dataRoot)`, created before the run when `collab.evidence` holds and by the browser mount (idempotent). Codex `workspace-write` adds it via `RunSpec.attachmentsWritableDir` → `threadOptions.additionalDirectories`; Claude at bypassPermissions needs no widening (since R22 removed the read-only sandbox an evidence-granted reviewer CAN copy files there, so the "Posting files" persona no longer promises a write the sandbox blocked). A DEFAULT-named `browser_take_screenshot` lands in `--output-dir`; an explicitly `filename:`d one resolves against the child's cwd instead (verified live on @playwright/mcp 0.0.79, since the stdio config carries no `cwd`) — the persona steers agents to default naming and says a self-named file stays workspace-local where no human sees it. On Codex the image does NOT return to the model, and the persona says so, so the agent never claims to have visually inspected a capture it cannot see. At completion `attachmentNamesSince(projectSlug, taskKey, runStartedAt, dataRoot)` (`app/server/files/task-attachments.server.ts:102`) collects everything written at-or-after `agent_runs.started_at` and stamps it onto the producing timeline event (`task-actions.server.ts:3139`); images render inline, and with no recorded start nothing is claimed. Serving: `projects/:slug/tasks/:key/attachments/:file` (`app/routes.ts:57`, `app/routes/task-attachment.ts`) — raw bytes, member-only, deliberately OUTSIDE the workspace layout. `attachmentsDropSection(attachmentsRel)` (:219) is emitted for ANY profile holding `attach-evidence-references`, browser or not — the drop is a plain directory, not a tool.

---

## 6. Skills and MCP loading

### 6.1 Skills

Claude gets skills NATIVELY; Codex gets them as prompt text. The asymmetry is deliberate: the Codex CLI's whole skills channel is severed because it cannot be governed per skill, and the CLI re-installs its five bundled `.system` skills into ANY home on startup.

`app/server/runtimes/skill-mount.server.ts` is the ONLY writer of `<workspace>/.claude`, and does both halves of one job so no caller can do half:

- `stripUngovernedRepoCatalog(repoDir)` (:121) deletes whatever `.claude` the cloned repo ships — first marking tracked `.claude` paths `--skip-worktree`, so `git add -A` delivery never stages the deletion into the review PR.
- `mountGrantedSkills({workspaceDir, skills, dataRoot})` (:256) copies each granted skill from the store to `.claude/skills/<name>/`, NORMALIZING the frontmatter to `{name, description}` only — a store file must not be able to widen or narrow run policy through `allowed-tools` / `model` / `disable-model-invocation`. It refuses symlinks and nested `.git` (`copyableEntry`), refuses anything that is not a plain git checkout (`isPlainGitCheckout` — `.git` must be a real DIRECTORY, because `settingSources: ['project']` walks parents to the repo root and a non-root cwd could reach a host `.claude`), and appends `.claude/` to `.git/info/exclude` (`excludeCatalogFromDelivery`, :324) so the mount is never delivered. A failed exclude write is WARNed with the delivery risk named.
- `MOUNT_MARK` (:96) is a per-PROCESS random UUID written as `.viberr-mount` in each mounted folder; the strip preserves ONLY folders carrying that exact mark, so a second run on the same TASK workspace cannot unmount a live run's skills (F19-15). Per-process and random, not a fixed filename, because `.claude` arrives from an untrusted clone that could otherwise forge it.
- `isSdkSkillName(name)` (:217, `/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/`) is an ALLOW-list, not a mirror of the SDK's deny-list: `query()` THROWS BEFORE STARTING on a name it cannot use, and a run must never die because a store folder was called `my skill (v2)`. Unmountable names fall back to prompt-text injection; the adapter re-checks with `nativeSkillNames(spec.skills)` (claude-runtime.server.ts:331).

The persona injects ONLY the non-mounted skills (`injectable`, :2148) under one shared budget, so no grant is fed twice and none is silently dropped. Mounted skills get their own trusted-provenance banner (:2155) — they now sit in the repo working tree, which the trust-boundary block calls UNTRUSTED, so saying where they came from matters MORE, not less.

Accepted residual, stated in the module: a mount is never garbage-collected, so a profile's skill folders stay READABLE in a co-engaged agent's cwd for the life of the workspace. Not INVOKABLE — the SDK `skills: [...]` filter and the `Skill` deny are the fence, never the directory listing.

### 6.2 MCP

- Registry: `app/server/org/resources.server.ts` — `listMcpServers`, `getMcpCredentialState`, `splitMcpCommand`, `discoverStdioMcpTools`, `discoverHttpMcpTools`, `markMcpServerUnreachableFromRun`, `isReservedMcpName`.
- Per-run: `resolveSpecialistMcpServersDetailed(db, mcpNames)` (`specialist-mcp.server.ts:120`) → `{servers, unresolved}`. Portable shapes: `HttpMcpServerConfig {type:"http", url, headers?:{Authorization}}` and `StdioMcpServerConfig {command, args, env?:{MCP_CREDENTIAL}}`.
- `RESERVED_MCP_NAMES` (:85) = `viberr`, `viberr_agent`, `viberr-agent`, `viberr_browser`, `viberr-browser` — skipped even if a hand-edited row carries one, because on Claude a row would shadow the real toolkit and on Codex it would not, so the backends would disagree about what the agent can do.
- Credentials are sealed in the registry (secret-box) and decrypted ONLY at run-spawn. A credential that is CONFIGURED but unopenable (retired key, legacy plaintext ref) DROPS the mount with a reason (A9) rather than silently downgrading to an anonymous connection the persona still advertises.
- `verifyStdioMcpMountsForRun(db, resolution, {backend})` (:248) re-runs the real discovery handshake per stdio mount, DROPS a server that fails to start (`mounted: false`), discloses it by name, and writes row-health back via `markMcpServerUnreachableFromRun`. On Codex it pre-flights WITHOUT the credential (matching the run, B-4); if the credential-ful probe then succeeds it does NOT downgrade the shared org row (P9) and discloses the drop as Codex-specific.
- A REGISTERED but known-down server still mounts (a probe can be stale) and is flagged `mounted: true` in `unresolved`, so the prompt says "may expose no tools" instead of promising them (P14-LV-09b).
- Mount precedence (specialist-run.server.ts:1823): declared org servers → browser → toolkit. The toolkit can never be shadowed.
- Codex translation: `codexMcpServers(servers)` (`codex-runtime.server.ts:153`) via `codexMcpServerSchema` — an in-process `{type:"sdk"}` server decodes to `null` (skipped), HTTP needs a real `url`, everything else is stdio; a half-declared server is DROPPED rather than partially translated. **Credentials are deliberately not carried to Codex**: the SDK serializes MCP config into `--config key=value` argv, which is `ps auxww`-visible.
- Naming asymmetry, disclosed not normalized (P13-LV-15): the same declared name mounts as `mcp__everything-http__echo` on Claude and `mcp__everything_http__echo` on Codex (the CLI lowercases hyphens to underscores). A persona or skill naming a tool LITERALLY works on one backend only; the transform is inside the codex binary.
- Command isolation: the Codex CLI MERGES `--config` per dotted leaf key into `$CODEX_HOME/config.toml` — it removes NOTHING the home declares, so the app-owned run home is the only thing that makes the MCP list exhaustive. On Claude the equivalent lever is `strictMcpConfig: true` (ignores repo `.mcp.json`, user MCP, plugin MCP).
- Governance gap, stated rather than hidden: MCP tools sit OUTSIDE the capability policy (`CAP_DENY_RULES` covers Bash and the file tools; there is no `mcp__*` rule). The rule "MCP tools do not widen your authority" is written into the system prompt on both backends (specialist-run.server.ts:2242), and the matrix says so out loud ("Granting a server IS the grant").

---

## 7. Gotchas

1. **`allowedTools` is NOT a restriction** — it is the auto-APPROVAL list. The only Claude restriction channel is `disallowedTools`, which removes tools from context and binds even under `bypassPermissions`. A comment here once pointed at a `tools` option that does not exist.
2. **Codex ignores `disallowedTools` entirely** — no denylist channel. Repo-write withholding is ADVISORY there since R22 removed the read-only sandbox; the server-owned delivery gate is the real boundary. Web egress still binds, via `workspace-write` + `webSearchMode: "disabled"`.
3. **`skills: []` does not give an empty skill set.** The SDK compiles ~16 first-party skills into its binary; a pristine docker deployment still listed all 16 in the run init. Hence denying the `Skill` TOOL when nothing is mounted — and hence `Skill` must LEAVE that list when skills ARE mounted (deny beats the `skills` auto-allow, so keeping it would list them and make them uninvokable).
4. **Envelope-on-resume.** Every half of a run's policy must be re-passed on resume or it is silently dropped: `disallowedTools`, `skills`, `allowedTools`, `env`, `mcpServers`, `systemPrompt`, `outputSchema`, `effort` (`ResumeRunInput` :1119, `carryResumeOptions` :1178, `resolveResumeConfinement` specialist-run.server.ts:2732). A resumed Codex reviewer without `outputSchema` fell back to a prose regex; a resumed @mention run without `disallowedTools` ran UNCONFINED. `carryResumeOptions` copies only PRESENT keys — an explicit `undefined` changes behavior, because `startRun` reads key PRESENCE.
5. **`capabilities: []` used to mean full power.** An unspecified capability read as granted. `GRANT_REQUIRED_CAPABILITY_IDS` + `deploymentGrants` + `withheldAgentGrants()` close it; hand-edited or imported `project.md` files are the remaining source.
6. **Absent-grant polarity is a three-way split** (§1.3). Four capabilities are absent-means-GRANTED through dedicated gates; reaching for plain `gate()` on one silently withholds it on every pre-rework deployment.
7. **Both SDKs REPLACE the child env.** Passing `{...spec.env}` alone, rather than overlaying it on a complete filtered env, strips PATH/HOME and breaks the spawned binary and every stdio MCP.
8. **Reserved rows are interruptible before a process exists.** Without `assertRunReservationLive` at all three checkpoints the adoption upsert REVIVES a run a human stopped.
9. **A reserved run holds a concurrency slot.** Counting only live handles let every reserving dispatch slip past the cap during its clone (F26-1); an interrupt on a reserved run must release the slot explicitly (F28-R1) or the cap starves for up to the clone timeout.
10. **`GIT_CEILING_DIRECTORIES` equal to cwd is a no-op** — it must be a strict ancestor.
11. **A foreign model id does not error, it silently substitutes.** `resolveClaudeModel` returns undefined for an unknown id and the SDK runs its default. `foreignModelBackend` + the `run·model_substituted` line are the net; the save-time rejection in `agent-profile-actions.server.ts` is the fix.
12. **Effort scales differ** — Claude `low|medium|high|xhigh|max`, Codex `minimal|low|medium|high|xhigh` — and the picker only refetches on backend change, so a stored `"minimal"` can reach a Claude run. Both adapters narrow rather than forward.
13. **The Codex thrown error is only an exit banner.** The real reason (a usage limit with its retry date) arrives as a streamed `turn.failed` / `error` event; classify on `lastFatalMessage`. A fatal event can also arrive WITHOUT the iterator throwing — hence the post-loop arm.
14. **`CODEX_HOME` pointed at Viberr's own run home** makes the auth source and the run home the same empty directory, so no `codex login` can reach a run while the probe still reports "available, no restart needed".
15. **The Codex CLI merges `--config` per leaf key** — config alone can never close the host channels; the app-owned home is the boundary. And `skills.bundled = false` as a BARE BOOLEAN makes the CLI refuse its entire configuration ("expected struct BundledSkillsConfig") and fails every run.
16. **`settingSources: ['project']` re-opens the repo's `CLAUDE.md`** as system-prompt-tier instruction. `managedSettings.claudeMdExcludes` is passed but is an ACCEPTED, UNVERIFIED mitigation; the Codex leg closes the same door deterministically with `project_doc_max_bytes: 0`. Treat the ingress as OPEN until someone reads a live run's system prompt.
17. **One workspace, many runs.** The checkout is per TASK; the skill strip is destructive; only the per-process `MOUNT_MARK` keeps a concurrent run's skills alive. And supporting runs of the SAME profile must be serialized — their isolated checkout is destructively re-cloned per dispatch.
18. **`agent_runs.kind = 'reviewer'` does not mean "a reviewer"** — it means "does not deliver". `idx_agent_runs__one_delivering` constrains the delivery slot, not a role.
19. **`outcome_key` is on the table but not in the store module** — absent from `AgentRunRow`, `InsertRunInput` and `RunPatch`; its only writer is a raw `db.prepare("UPDATE agent_runs SET outcome_key = ? …")` at `task-actions.server.ts:3049`, bypassing `run-store.server.ts` entirely.
20. **`actor.label` is an email, not a display name.** The cc-append and every @tag must use `userName(db, userId)`; a tag that does not resolve notifies nobody (R21-9). The cc line is bookkeeping, not progress — `stripCcLine` must be applied to BOTH sides of the no-progress comparison.
21. **A resource grant is a bare slug.** `updateResourceReferences` propagates renames best-effort; a hand-edit still orphans the grant, which is why the run DISCLOSES `unresolved` / `unhealthy` rather than announcing tools that will never appear. A registered-but-down server still mounts and is flagged `mounted: true`.
22. **Some run env vars are not in the validated env schema.** `VIBERR_GIT_CLONE_TIMEOUT_MS`, `VIBERR_TRANSCRIPT_RETENTION_DAYS` and `VIBERR_SESSION_HOME_RETENTION_DAYS` are not in `envSchema`, and `VIBERR_CLAUDE_IDLE_TIMEOUT_MS` is read from raw `process.env` rather than `getEnv()`. Do not claim the validated env surface is complete.
23. **Controller runs use `project_slug = ''` and `task_key = <conversationId>`** so no task-scoped query matches them, the SSE publishers early-return on them, and their logs authorize by conversation ownership, not membership.
24. **The run-concurrency cap is an instance SETTING, not an env var** — and default `0` means UNLIMITED, not "no runs".

### Env vars this subsystem reads

| var | default | effect |
| --- | --- | --- |
| `VIBERR_DATA_ROOT` | `./data` | root for `runtimes/`, `state/`, `projects/` |
| `VIBERR_FORCE_DATA_ROOT_LOCK` | unset | take over a live-looking `writer.lock` |
| `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` | — | Claude credential |
| `VIBERR_CLAUDE_USE_CLI_AUTH` / `CLAUDE_CONFIG_DIR` | — | Claude CLI-auth opt-in / config dir |
| `CODEX_ACCESS_TOKEN` / `CODEX_API_KEY` / `OPENAI_API_KEY` | — | Codex credential |
| `VIBERR_CODEX_USE_CLI_AUTH` / `CODEX_HOME` | — | Codex cached-login opt-in / auth source |
| `VIBERR_CLAUDE_MAX_TURNS` | `2000` | Claude runaway turn cap |
| `VIBERR_CLAUDE_IDLE_TIMEOUT_MS` | `900000` | Claude idle watchdog (raw `process.env`) |
| `VIBERR_CODEX_IDLE_TIMEOUT_MS` | `900000` | Codex idle watchdog |
| `VIBERR_GIT_CLONE_TIMEOUT_MS` | `900000` | clone timeout; feeds `CLAIM_LEASE_MS` |
| `VIBERR_BROWSER_EXECUTABLE` | set in the image | pinned chromium for the browser MCP |
| `VIBERR_TRANSCRIPT_RETENTION_DAYS` | `30` | raw `.jsonl` pruning |
| `VIBERR_SESSION_HOME_RETENTION_DAYS` | `30` (`0` = forever) | provider session-home pruning |
