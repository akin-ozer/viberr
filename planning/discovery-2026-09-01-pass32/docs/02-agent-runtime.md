# 02 — Agent runtime

How an agent is DEFINED, how it gets ENGAGED on a task, and how a run EXECUTES on each backend. Every claim names the file and symbol that carries it; every `path:line` was re-resolved against `main @ 68b5480e` (2026-09-01). Read alongside `docs/architecture/decisions.md` rulings 98–108 — the load-bearing recent ones for this domain are **98** (dynamic dispatch), **99** (controller), **101** (repo-write PARITY), **104** (verbatim operator narration), **105** (browser working-artifact prune), **106** (controller settings / shared model ids), **107** (`viberr_ops`), **108** (deployment-locked controller config).

Two names still actively lie:

- **`agent_runs.kind` is the DELIVERY axis, not a role taxonomy** (`db/migrations/0001_baseline.sql:474`, with the column's own note at `:460-473`): `operator` = the operator runtime; `primary` = the engagement that DELIVERS; `reviewer` = any other (supporting) engagement — a non-delivering *developer* is stored as `reviewer`; `controller` = a conversation turn. The real role rides the separate `role` column.
- **"specialist"** survives in filenames (`specialist-run.server.ts`, `resolveDeployedSpecialist`) but the concept is a generic AGENT profile + capability grants. There is no record kind named "dispatch" — dispatch is the VERB; it writes an engagement row, an `agent_runs` row and a timeline event.

---

## 1. Agent profiles

### 1.1 Where a profile lives

A profile is a markdown file in the app-owned store, not a DB row. Two layers on purpose: identity/craft is org-wide, POLICY is per project.

Paths, all via `app/server/files/file-store-root.server.ts`: `getDataRoot(dataRoot?)` (:43) resolves `VIBERR_DATA_ROOT`, default `./data`; `projectFilePath(slug)` (:64) → `projects/<slug>/project.md`; `taskAttachmentsDir(slug, key)` (:87); `agentProfilesDir` (:110) / `agentProfileFilePath(id)` (:121) → `agents/profiles/<id>.md`; `kbRootDir` (:163) / `kbDirPath(dir)` (:168) → `kb/<dir>/`; `skillsRootDir` (:173) / `skillDirPath(name)` (:178) → `skills/<name>/SKILL.md`; plus `runtimes/` and `state/projection.sqlite`. `resolveStoreSegment(root, name)` (:141) guards every id/name (rejects `""`, `.`, `..`, `/`, `\`, NUL, absolute paths, then re-checks containment) — because grant-resolved content is injected into a run as TRUSTED material.

- **Parse/serialize**: `app/server/files/agent-profile-file.server.ts` — `parseAgentProfileContent(content, ctx?)` (:119), `serializeAgentProfile(parsed)` (:168), `agentProfileFrontmatterSchema` (:27, `.loose()`, so unknown keys round-trip but raise an `agent_profile.unknown_field` warning against `AGENT_PROFILE_KNOWN_KEYS` :90). Frontmatter keys: `id, kind ("operator"|"specialist"|"controller"), name, role, desc, icon, backends[], model, effort, scope, stages[], spanAll, capabilities[{capabilityId,mode}], extras[{label,mode}], resources{skills[],mcps[],kb[]}`. **The markdown body IS the long persona**; `desc` is the short operator-facing blurb.
  - **NEW (ruling 106)**: `effort` is a schema-level key (`:44-51`), declared `z.string().optional().catch(undefined)` — deliberately TOLERANT, because a strict field on hand-editable frontmatter bricked the controller config ("profile missing from the store") over one junk YAML line with no in-app repair path. Only the controller profile is edited through this key today; deployed specialists carry model+effort on their `project.md` `agents:` entry.
- **Org template CRUD**: `app/server/org/gagents.server.ts` — `listGlobalAgentProfiles` (:162), `saveGlobalAgentProfile` (:216), `deleteGlobalAgentProfile` (:336), `usedByProject` (:117). Only `kind: "specialist"` files are listed or mutated. New templates get `conservativeGrantsFor("agent")` (:309) — delivery WITHHELD — because that editor has no capability UI. A non-zero deployment count blocks deletion.
- **Project deployment CRUD** (the only writer of a project's `agents:` list): `app/features/agents/agent-profile-actions.server.ts` — `createAgentProfile` (:386), `deployAgentProfileFromLibrary` (:502), `updateAgentProfile` (:625), `deleteAgentProfile` (:804). Canonical order: file write (`updateProjectFile`) → incremental reproject (`rebuildPath`) → audit. RBAC `assertProjectAction(db, "manage-agents", …)`, admin-only. Two distinct grant builders: `grantsFor()` (:283, edit path, seeds unspecified caps from catalog defaults) and `createModalGrants()` (:339, create path, materializes an omitted cap as explicit `off`).
- **Merge for display and run**: `effectiveProfileView(deployment, dataRoot, absentDeliverMode, modelMarks?)` (`app/features/agents/agents-query.server.ts:278`), `assembleAgentRoster` (:497), `listLibraryProfiles` (:173).

`agents/definitions/<id>.md` is **legacy for specialists** (F10-30 removed the per-specialist override; the persona is now the profile body). Only the operator and controller still have one, seeded by `app/server/seed/default-assets.server.ts`. The controller is a third kind, one per instance, never deployable — `app/server/controller/controller-profile.server.ts` (`CONTROLLER_PROFILE_ID` :39, `resolveControllerConfig` :171, `readControllerDefinition`), and `readTemplate` (`app/server/agents/deployment-view.server.ts:52`) returns null for `kind: "controller"`.

**NEW (ruling 108) — controller config is deployment-locked.** `controllerSectionLocks(env)` (`controller-profile.server.ts:84`) resolves four booleans (`skills`, `kb`, `mcps`, `instructions`) from `VIBERR_UNLOCK_CONTROLLER_*` (`CONTROLLER_UNLOCK_ENV` :58). Only the literal value `enabled` unlocks (`CONTROLLER_UNLOCK_VALUE` :77, `unlockFlag` :78 lowercases/trims) — `disabled`, a typo, or unset all fail CLOSED. Enforcement is server-side in `saveControllerConfig` (:203): for each locked grant section `resolveGrant` (:234) writes the STORED list back verbatim (order + duplicates), refusing only a NON-EMPTY input that differs as a set (`sameSet` :222, `lockedChange` :226 names the section and its variable); a blank list keeps the stored value, because the panel posts blank for a read-only section. Same shape for `instructions` (:254-261) against `readControllerDefinition`. Model and effort are deliberately NOT sections. The audit row's `definitionEdited` is true only when the doctrine file was actually rewritten (:303).

### 1.2 Three shapes, not one

There is no single `AgentProfile` type:

1. **`AgentProfileFrontmatter`** (`agent-profile-file.server.ts:27`) — the stored org template. No `profileId`; `backends[]` is PLURAL.
2. **`AgentDeployment`** (`app/schemas/project-file.schema.ts`) — the project's adoption: `profileId`, `capabilities[]`, `extras[]`, and a full `definition` snapshot (kind, name, role, icon, backends, model, effort, scope, desc, persona, stages, spanAll, resources).
3. **`AgentProfileView`** (`app/features/agents/agent-types.ts`) — the merged render shape: `id, kind, name, role, icon, backends[], model, modelLabel, modelKnown, modelUnavailable?, effort, scope, customized, desc, definition, stages[], spanAll, autonomy?, actions{direct,recommend,forbidden,off?}, capabilities[], extras[], resources{…}, source`.

The run-facing projection is `ResolvedSpecialist` (`app/server/tasks/specialist-run.server.ts:173`), from `resolveDeployedSpecialist(ctx, projectSlug, profileId)` (:310) via `toResolved(view)` (:210):

| field | source | used for |
| --- | --- | --- |
| `profileId` | deployment key | engagement identity, git identity, workspace dir |
| `name` / `role` | template | run row `agent_name`, timeline copy, @mention handle |
| `backend` | `primaryRunBackend(view.backends)` via `pickBackend` (:204) | which adapter |
| `model` | `resolveRunModel(backend, view.model)` | SDK model id |
| `effort` | template | claude `options.effort` · codex `modelReasoningEffort` |
| `skills[]` | `view.resources.skills` | mount (claude) or prompt text (codex) |
| `kb[]` | `view.resources.kb` | prompt injection under a shared budget |
| `mcps[]` | `view.resources.mcps` | resolved against the org MCP registry |
| `definition` | template body | the run persona (ONE source since F10-30) |
| `capabilities[]` | the DEPLOYMENT's grants | tool denylist, **Codex sandbox mode**, collab gates, mounts |
| `stages[]` / `spanAll` | template | eligibility at assign AND at run |

Resources are granted as **bare resolvable ids** — a skill's folder name, a KB's `dir` slug (`slugify(name)`), an MCP server's registry `name` — offered by `buildResourceCatalog(db, dataRoot?)` (`app/server/org/resource-catalog.server.ts:44`), which now skips every name in the shared reserved list (`isReservedMcpName`, :67). Renames are propagated by `updateResourceReferences(kind, from, to, dataRoot?)` (`app/server/org/resource-references.server.ts`) across every `agents/profiles/*.md` and every `project.md` deployment — best-effort per file, so a hand-edit can still orphan a grant. An orphaned grant is DISCLOSED at run time (§7.2), never silently dropped.

### 1.3 Capability grants

One catalog: `app/shared/capabilities.ts` → `UNIFIED_CAP_CATALOG` (:33), entries `{id, label, kinds: ("operator"|"agent")[], group: string|null, defaultMode, promotable}` built by `cap()` (:24, `defaultMode` defaults to `"direct"`). `group: null` = matrix-only advisory (no toggle, no runtime consumer). Modes: `direct | recommend | human | off`.

- **Operator** (all toggled): `dispatch-agents` "Select & run agents" (direct) · `generate-packets` · `append-typed-events` · `stage-transitions` (recommend) · `completion-for-acceptance` (recommend, `promotable:false`) · `deliver-review-pr` · `update-task-branch`.
- **Agent — Repository & execution** (`:79-83`): `execute-code-or-write-repo` · `create-task-branch` · `commit-push-branch` · `open-review-pr` (all direct).
- **Agent — Collaboration**: `comment-on-task` (direct) · `ask-human` (direct) · `use-web-search-fetch` (direct, kinds **agent + operator**) · `use-browser` (**off**, :113) · `read-github-api` (**off**, `promotable:false`, :131) · `report-validation-verdict` (**off**, :134) · `attach-evidence-references` (**direct**, :142).
- **Agent — Reserved for humans** (`human`, `promotable:false`, :157-159): `merge-pull-request` · `transition-to-done` · `change-project-policy`.
- **Agent — advisory (`group: null`, :144-154)**: `run-unit-integration-validation` · `move-task-to-review` · `read-repo-diff` · `run-validation-suites` · `post-quality-flags` · `approve-review` · `request-changes` · `author-test-cases` · `read-task-repo` · `flag-underspecified-tasks`.

Derived sets, same file: `ALWAYS_HUMAN_CAPABILITY_IDS` (:211); `SCOPED_DELIVERY_CAPABILITY_IDS` (:381, branch/push/PR); `VERDICT_OUTCOME_CAPABILITY_IDS` (:314); `GRANT_REQUIRED_CAPABILITY_IDS` (:403 — the six where **absent means withheld**); `ENFORCED_CAPABILITY_IDS` (:223, both backends); `CLAUDE_ONLY_ENFORCED_CAPABILITY_IDS` (:281). `capabilityEnforcement(id)` (:298) → `"both" | "claude-only" | "advisory"` is the one honest answer the matrix and profile panel render.

**CHANGED (ruling 101).** `execute-code-or-write-repo` MOVED from the claude-only set back into `ENFORCED_CAPABILITY_IDS` (:258) — a write-withheld Codex run gets the read-only sandbox back. `CLAUDE_ONLY_ENFORCED_CAPABILITY_IDS` is now exactly `{create-task-branch, commit-push-branch, open-review-pr, comment-on-task, read-github-api}` (:281-292).

Polarity — the seam that kept producing bugs, now single-sourced:

- **Absent-grant meaning is a three-way split.** `GRANT_REQUIRED_*` → withheld. `dispatch-agents`, `deliver-review-pr`, `update-task-branch`, `use-web-search-fetch` are absent-means-GRANTED. Everything else falls to `gate()`'s absent-means-`off`.
- **NEW (F31-C2)**: the four exceptions now live in ONE table, `absentPolarityGate(authority, capabilityId)` (`app/server/tasks/operator-actions.server.ts:466`), consulted inside `gate()` itself (:499). `dispatchGate` (:575) and `updateBranchGate` (`app/server/github/update-branch-operator.server.ts:75`) are now plain delegations to `gate()`; `deliverGate` (:529) keeps its own body only because `absentPolarityGate` calls it for `update-task-branch` (loop avoidance). **A consumer that reaches for plain `gate()` on one of the four no longer silently re-breaks it** — this closes pass-31 gotcha #6.
- `capabilities: []` resolves to an explicitly WITHHELD set, not "unspecified" — `deploymentGrants` (`specialist-run.server.ts:246`) logs and substitutes `withheldAgentGrants()` (`app/features/agents/capability-catalog.ts:89`).
- A specialist `recommend` normalizes DOWN to `off` (`coerceSpecialistCapabilityMode`, capabilities.ts:372), never up. The specialist picker offers 3 modes (`SPECIALIST_CAP_MODES`, capability-catalog.ts:149), the operator picker 4.
- `applyVerdictOutcomeGate(grants)` (:335) renders the three verdict OUTCOMES withheld unless `report-validation-verdict` is explicitly `direct`.
- Save-time couplings: `applyGrantCouplings` (:570) = `repairDeliveryGrants` (:459, fills a MISSING headline when a scoped grant is actionable; RESPECTS an explicit `off` and reports the contradiction) then `repairBrowserEgressGrants` (:535, browser forces egress on). Decisions surface as `GrantCouplingNotice[]`.
- Runtime interpretation: `specialistGrantModes(grants)` (`app/server/tasks/specialist-tool-policy.ts:121`) repairs exactly ONE thing — an ABSENT headline when scoped grants are actionable (:127-131) — and never overturns an explicit `off` (unlike `normalizeDeliveryGrants`, capabilities.ts:585, which would).

`effectiveProfileView` materializes every ABSENT catalog capability at the mode the RUNTIME would use before rendering, which is why matrix, detail panel, policy counts and editor seeding cannot disagree with enforcement; its own absent-polarity mirror is at `agents-query.server.ts:373-390`. Tool confinement itself: `resolveSpecialistDisallowedTools(grants)` (:149), `resolveUndeployedDisallowedTools()` (:174), `resolveDeliveryPermissions(grants)` (:192), whose `CAP_DENY_RULES` (:51) map each capability to concrete Bash/tool specifiers.

Matrix UI: `app/features/agents/capability-matrix-modal.tsx` — rows from `CAP_MODAL_CATALOG` (`capability-catalog.ts:56`) plus a synthesized "Other actions" group. Matching is by display LABEL, bridged back via `capabilityByLabel(label)` (capabilities.ts:596) → `capabilityEnforcement(id)` to stamp the "binds tools on Claude runs · advisory on Codex" chip (:124). Its notes block discloses that MCP tools are NOT gated by the matrix (:269-276), that org MCP credentials go to Claude runs only (:244) and that MCP tool names differ per backend (:253).

### 1.4 Granted resources threading into a run

Resolved in `dispatchAgentRun` (`specialist-run.server.ts:1116`, resource block from ~:1500) in this order:

1. **MCP** — `mcpServersFor(db, mcpNames, backend)` (:275) → `resolveSpecialistMcpServersDetailed` + `verifyStdioMcpMountsForRun`. Yields mounted servers, `unresolved` and `unhealthy`.
2. **Skills** — `mountGrantedSkills({workspaceDir, skills, dataRoot})` (`app/server/runtimes/skill-mount.server.ts:299`), called at `specialist-run.server.ts:1564`; Claude + real backend only.
3. **Browser** — `resolveBrowserMcp({grants, attachmentsDir, backend})` (`specialist-browser-mcp.server.ts:136`), at :1577.
4. **Persona** — `buildSpecialistPersona(input)` (:2122): definition body → mounted-skill trusted-provenance banner (:2155) → NON-mounted skill bodies (`readSkillBodies`, `SKILL_INJECTION_BUDGET = 24_000` at `app/server/files/skill-body.server.ts:36`) → `KB_PRECEDENCE_NOTE` + KB bodies (`readKbBodies` `app/server/files/kb-injection.server.ts:304`, `KB_INJECTION_BUDGET = 24_000` at :64, shared across ALL declared KBs) → MCP-governance clause (:2244) → browser section (:2309) → attachments-drop section (:2303).
5. **Disclosure** — `recordRunInputs(db, {...resolvedResourceInputs(...)})` (:591 / :491): cwd, cloned, delivers, persona chars, skills vs nativeSkills, kb, mounted/unresolved/unhealthy MCPs, unresolved resources, denied tools, toolkit gates, prompt chars, anchor, directive.

`readKbBodies` never silently shrinks: a KB squeezed out by the shared budget emits an explicit omission marker AND a structured `unresolved` row (`kb-injection.server.ts:252`). `collectKbDocs` (:75) walks the whole tree, refuses symlinks, guards realpath cycles, caps depth at 32 and containment-checks against the realpath'd root.

A reviewer's KB list is UNIONED with the delivering engagement's KBs — `deliveringContextGrants` (:360) + `withDeliveringGrants` (:383), ruling 57 / R19-3. **Skills are deliberately NOT inherited**.

### 1.5 Deployment view

`app/server/agents/deployment-view.server.ts` — `readTemplate` (:52), `parseDeploymentDefinition` (:147), `primaryRunBackend` (:160), `deploymentRuntimeIdentity` (:179), `deployedSpecialistBackends` (:210). `deploymentRuntimeIdentity` is the ONE writing of `override ?? template ?? default`; `primaryRunBackend` is THE "which backend does this profile run on" rule; `parseDeploymentDefinition` `.catch`es each field independently so one junk value loses only that field. `listDeployedSpecialists(projectSlug, ctx)` (`specialist-run.server.ts:3393`) is the picker/dispatch source, returning `DeployedSpecialistView` with a pre-digested `capabilities: {delivery, verdict, askHuman, browser}`; `modelUnavailable` is now assigned conditionally on a typed local rather than spread (:3479-3485, byte-identical view). `specialistEligibleForStage` (:3346) / `assertStageEligible` (:3368) enforce stage eligibility at BOTH assign and run.

---

## 2. Dispatch-written engagements

### 2.1 The engagement record

`engagementSchema`, `app/schemas/task-file.schema.ts:194`, in task frontmatter `engagements: []`:

```
profileId, backend, role,
delivers        (default false)   // at most one true; parser demotes extras
verdictCapable  (default false)   // ENGAGE-TIME snapshot of an explicit
                                  // report-validation-verdict: direct grant
pinnedBackend?: "codex"|"claude"|null   // F27-B1 sticky retry switch
```

Helpers: `deliveringEngagement(fm)` (:221), `supportingEngagements(fm)` (:228), `requiredReviewers(fm)` (:729 — `!delivers && verdictCapable`). `verdictCapable` is a snapshot ON PURPOSE: a live lookup would let a revoked grant leave a task permanently un-acceptable. Related: `workRevision {id, headSha, treeSha, branch, createdAt, sourceProfileId, kind?}` and `verdicts[]` bound to `revisionId`.

Projection (`0001_baseline.sql:72` table, `specialist_json` :127 / `reviewers_json` :128; written by `app/server/projections/rebuilder.server.ts:594-595`): the delivering engagement is serialized WHOLE into the legacy-named `specialist_json`, the supporting ones into `reviewers_json`. Also `work_revision_sha`, `recommendation_count`, `schedules_json`.

### 2.2 Auto-engage and capability-derived posture

`dispatchAgentRun` (`specialist-run.server.ts:1116`), auto-engage block :1152-1244:

- Not engaged + `profileId` given → look it up in `listDeployedSpecialists`; absent → "Deploy it on the Agents page first." (:1159).
- `delivery = view.capabilities?.delivery === true`; `wantsDelivery = input.delivers ?? (currentDeliverer === null && delivery)` (:1165).
- `wantsDelivery && !delivery` → refuse, NAMING the missing grant and where to grant it (R21-2, :1168-1175).
- `wantsDelivery` → `assignSpecialist` (:673): single-deliverer invariant, hand-off event, live-primary refusal — and it garbage-collects any pending `run_agent` recommendation for the profile it just engaged. Else → `assignReviewer` (:848): own isolated checkout; verdict-capable ⇒ required reviewer.
- Already engaged as supporting + explicit `delivers: true` → the SAME repo-write guard (:1203-1229), then `assignSpecialist`.

Backend priority: `input.backendOverride ?? engagement.pinnedBackend ?? resolved?.backend ?? engagement.backend`. A D4 retry-on-other-backend PINS; a plain profile edit does not.

`StartAgentRunInput` (:1061); `startAgentRun` (:1099) is a thin try/catch whose only job is releasing the mid-flight `PendingReservation` when preparation throws (:1107).

### 2.3 The `dispatch-agents` cap

`dispatch-agents` replaced the retired `assign-primary-specialist` + `summon-reviewers` pair (ruling 98(b)). `dispatchGate(authority)` is now a one-liner over `gate()` (`operator-actions.server.ts:575-579`), because `absentPolarityGate` (:466) carries the absent-means-`direct` polarity for every consumer. Consumers: the Claude toolkit (`operator-toolkit.server.ts:537`), the Codex plan filter (`operator-run.server.ts:1614`), `operatorDispatchAgent` itself (`operator-actions.server.ts:2233`), and the read surface at `agents-query.server.ts:382`.

### 2.4 The `run_agent` verb and the `run_agent` recommendation kind

- **Action**: `operatorDispatchAgent(db, ctx, {projectSlug, taskKey, profileId, prompt?, delivers?, reason?}, authority)` (`operator-actions.server.ts:2233`) — the ONE operator action for putting an agent to work. Arms: `direct` (engage-if-needed + prompt-as-comment + run), `recommend` (one card), `deny`. It refuses two CONTRADICTORY hints up front. `resolveDeliversIntent` (:2197) is the shared rule; `recordAgentSelectionTrace` (:2149) best-effort-audits the choice.
- **Tool** (Claude): `run_agent` at `operator-toolkit.server.ts:540`.
- **Plan verb** (Codex): `"run_agent"` in `OPERATOR_PLAN_TOOLS` (`operator-run.server.ts:1535`, entry :1548), capability map :1581, schema properties :1660-1664, executor arm :2223, permitted-set filter `operatorPlanToolsFor(authority)` (:1600).
- **Human prompt path**: `operatorPromptAgent(...)` (`task-actions.server.ts:3932`) — posts the `@handle` comment FIRST; a refused start unshifts a `note` retracting the hand-off.
- **Recommendation kind**: `RECOMMENDATION_KINDS = ["transition","run_agent","accept_completion","delivery"]` (`task-file.schema.ts:245`); `recommendationSchema` (:267) carries `{id, kind, profileId?, prompt?, delivers?, toStageId?, label, detail}`. Writer `addRecommendation` (`operator-actions.server.ts:779`); applier `applyRecommendation` (`task-actions.server.ts:8507`, `run_agent` arm :8581+) which dynamically imports `startAgentRun` and passes `triggeredByName: userName(db, actor.userId)` (:8594) + `triggeredByUserId`. UI: `app/features/task-detail/operator-recommendations.tsx`.

### 2.5 `previousStageId` and the NEW `heldAtStage`

`taskFrontmatterFields.previousStageId` (`task-file.schema.ts:608`, `z.string().nullable().default(null)`, tolerant-parsed :1264, initialized `null` at creation `task-actions.server.ts:499`). Written in `transitionStage` (`task-actions.server.ts:4542`) plus the acceptance stamp (:7877); read into the operator snapshot as `previousStage: {id, name}`.

**NEW (F31-11 / V18) — `heldAtStage`** (`task-file.schema.ts:620`, tolerant-parsed :1273, known-key list :973). A DURABLE "the operator deliberately held this stage" marker, initialized `null` at creation (`task-actions.server.ts:502`). Cleared by every human re-litigation: `updateTaskGoal` (:588), `transitionStage` (:4546), `resolvePacket` (:6520), `applyAcceptanceWrite` (:7880). Written by the stranded-resume settle (§3.11).

### 2.6 The dispatch-completion contract

Owner directive 2026-08-29. Armed by `triggeredByName` / `triggeredByUserId` → `completion.dispatchedByName` / `dispatchedByUserId` (`specialist-run.server.ts:2036-2039`).

- **Guidance half**: `buildAnalyzePrompt` (:2416) appends a `## Reporting back` section (:2559).
- **cc-append** (`task-actions.server.ts:3302-3315`, inside `applyAgentCompletionEffects` :3139, applied BEFORE the reply is stored): "already tagged?" is answered by `mentionNotifiesUser(db, text, userId)` (`mention-notify.server.ts:175`) — the SAME resolution ladder the fan-out delivers with — plus `/@operator\b/i`. What is missing is appended as `\n\ncc @Name @operator`.
- **always-react** (:3803-3806): `mustReact = !!dispatchedByName && finished.state === "finished" && currentDepth < OPERATOR_REACT_DEPTH_CAP` (cap = 4, :175).
- `stripCcLine` (:1824) is applied to BOTH sides of the no-progress comparison (:3792-3796). **CHANGED**: the filter is now `line.startsWith("cc @")` rather than `/^cc @/` — same semantics, no regex.

Known loss class, documented in code: a run RECOVERED after a crash degrades to the react heuristic with no cc line, because `dispatchedByName` lives only in the in-process closure.

Sources that arm the contract: the manual run-agent control (`app/routes/project.task.tsx:818`), an `@mention` (`commentToAgent`, `task-actions.server.ts:1278`; arming :1628), a fired schedule (`schedule.server.ts:612`), an applied recommendation (:8594), and the controller's `run_agent_on_task`.

### 2.7 Scheduled dispatch

`SCHEDULE_ACTION_TYPES = ["run-operator","run-agent"]` (`task-file.schema.ts:299`); `scheduleSchema` (:315). `app/server/tasks/schedule.server.ts` — `scheduleTaskAction` (:131), `cancelScheduledAction` (:221), `tasksWithUnresolvedSchedules` (:280), `fireDueSchedules` (:335), `startScheduleRunner` (:791), private `MAX_SCHEDULE_RETRIES = 3` (:327).

- **CHANGED (V19)**: `CLAIM_LEASE_MS` is now the function `claimLeaseMs()` (:329-331) = `cloneTimeoutMs() + 5 min`, because the clone ceiling became a lazy env read. Used at :366 (stale-claim test) and re-stamped at fire time (:562-568).
- Create requires `run-agents` (maintainer+) and, for `run-agent`, a currently deployed profileId. R22: an entry pins NO backend and NO autonomy.
- The tick CLAIMS an occurrence in the file before the detached enqueue. A `run-agent` occurrence whose profile already has a live run is deferred pre-claim (:415+).
- Fire (:600+): `startAgentRun` with `triggeredByName = createdByLabel` (:612), actor `{userId:"system", label:"schedule runner"}`, ctx `operatorAuthorized: true`; the archived-project freeze is re-decided here (`projectArchivedFor` :354, checked :415).
- Three failure dispositions: 409 → `deferredConflict` (:655, retries UNTOUCHED); 400 → `refusedValidation` (:683, terminal `failed`); else bounded retry (:718). An entry with `action: "run-agent"` and no profileId is terminal-failed visibly (:595).

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

`RunSpec` (`app/server/runtimes/adapter.server.ts:50`) is the single contract every adapter receives; `RuntimeAdapter` (:234) is `{backend, start(spec, cb) → RunHandle}`. Adapters never touch the DB, files or the broker — the RunSink does. `RUN_PHASE` (:185) is the shared vocabulary: `preparing` (emitted by the PIPELINE), `starting`, `working`, `finishing`; `phaseStepForLine` (:209) derives the step from the PROJECTED display line. Phase writes are throttled in `launch` (`run-service.server.ts:1377`).

`registerRunCompletion(runId, cb, db?)` (:199, last writer wins) and `chainRunCompletion` (:216) both call `fireIfAlreadyTerminal` when handed a `db`. A throwing callback triggers `noteCompletionEffectsLost` (:1086), which writes a `continuity` timeline entry and flips `waiting = "human"`.

### 3.2 Workspace isolation

- Root `<taskDir>/workspace` (`taskWorkspaceRoot`, `specialist-run.server.ts:2649`).
- **Delivering** engagement → `<workspaceRoot>/<repo>`.
- **Supporting** engagement → `<workspaceRoot>/support/<profileId>/<repo>` (`supportCheckoutDir`, :2691, P8/pass-25). `cloneRepo` (:3050+) DELETES and re-clones it fresh every dispatch, which is why same-engagement runs must be serialized.
- A real-backend run's cwd is ALWAYS an isolated workspace dir, never the task dir.
- These are plain clones, not git worktrees. `app/server/tasks/repo-mirror.server.ts` makes later tasks clone in seconds; `git-clone-progress.server.ts` turns the cold clone into a live percentage.
- **CHANGED (C3/V19)**: `CLONE_TIMEOUT_MS` (a module-scope const) became `cloneTimeoutMs()` (`app/server/tasks/git-clone-auth.server.ts:200`) — a LAZY read of the validated env (`getEnv().VIBERR_GIT_CLONE_TIMEOUT_MS`, default 900 000). Lazy deliberately: a module-scope `getEnv()` would throw at import time on an invalid env on the clone/delivery path, and would freeze the value against `resetEnvCacheForTests`. Callers updated: `specialist-run.server.ts:3118/3208/3222`, `repo-mirror.server.ts:196/502/542`, `operator-run.server.ts:1220`, `schedule.server.ts:329`.
- Retention: `reclaimTerminalTaskWorkspaces(db, {dataRoot?})` (`app/server/tasks/workspace-retention.server.ts:85`) removes `workspace/` for tasks in their project's TERMINAL stage. **Both callers gate on `activeRunCount(db) === 0`** (`app/server/ops/maintenance.server.ts:120`, which returns `1` on an unreadable table). Deliberately NOT part of `app/server/db/retention.server.ts`, whose contract is SQLite-only.

### 3.3 Per-run environment

`workspaceRunEnv` (`specialist-run.server.ts:2981`) returns ONE var: `GIT_CEILING_DIRECTORIES = <taskDir>` — deliberately a STRICT ANCESTOR of both cwd shapes. `agentGitIdentityEnv(profileId)` (:3018) sets `GIT_AUTHOR_NAME/EMAIL` + `GIT_COMMITTER_NAME/EMAIL` to `{profileId, <profileId>@viberr.local}` (`agentGitIdentity`, :3014) so codex and claude are indistinguishable in the git history — on Codex these reach the model's shell only because they are named in `SHELL_EXPORTED_ENV_KEYS` (`codex-runtime.server.ts:218`). Agent runs are NOT handed push credentials: delivery is server-side on both backends (`pushWorkspaceBranch`; the note lives at `specialist-run.server.ts:2974-2979`).

### 3.4 The Claude leg

`createClaudeAdapter` (`app/server/runtimes/claude-runtime.server.ts:612`) over `@anthropic-ai/claude-agent-sdk` `query()`. The prompt is fed as a one-message async iterable (`singlePrompt`) because `Query.interrupt()` exists only in streaming-input mode.

Options (:785): `cwd`; `permissionMode = autonomous ? "bypassPermissions" : "default"`; `maxTurns = resolveMaxTurns()` (:525, default 2000, `VIBERR_CLAUDE_MAX_TURNS`); `abortController`; `settingSources: nativeSkills.length ? ["project"] : []`; `skills: nativeSkills`; `plugins: []`; `strictMcpConfig: true`; `managedSettings = MANAGED_SETTINGS` (:401) only when the project source is open (:847). `systemPrompt`: for `kind === "operator" | "controller"` the persona REPLACES the default; for a specialist/reviewer it is `{type:"preset", preset:"claude_code", append: persona}`. `model` via `resolveClaudeModel` (:119); `effort` via `resolveClaudeEffort` (:142).

**CHANGED (F31-C4/V6) — the CLAUDE.md ingress is now CLOSED, and through a different channel than pass 31 believed.** A live in-container canary probe (2026-08-31) proved `Options.managedSettings.claudeMdExcludes` is SILENTLY DROPPED: the SDK filters `managedSettings` restrictive-only against an allowlist and the excludes key is not on it. `MANAGED_SETTINGS` (:401) is kept only as a belt (harmless while dropped, effective the day the SDK allowlists it) and its docstring says exactly that (:390-400). The real mitigation is a FILE: `mountGrantedSkills` writes `{"claudeMdExcludes":["**/CLAUDE.md","**/CLAUDE.local.md","**/.claude/**"]}` into `<workspace>/.claude/settings.json` (`skill-mount.server.ts:408`, `writeCatalogSettings` :427), which the project settings source actually loads — the canary flipped to hidden through it.

The two halves are welded together by `nativeSkillsForRun(spec)` (`claude-runtime.server.ts:371`), the new seam the adapter calls instead of `nativeSkillNames` (:788): it re-checks the excludes file with `ensureCatalogSettings(spec.workdir)` (`skill-mount.server.ts:472`, which REPAIRS a missing file and refuses to create or write through a symlinked catalog), and returns **`[]`** when neither holds — so the run keeps `settingSources: []` and `Skill` denied rather than opening the source on faith.

Denylist assembled at :891:
- `BASE_DENIED_BUILTINS` (:291): `Skill` (only when the run mounted no skills), `Task`/`TaskCreate|Get|List|Output|Stop|Update`, `Workflow`, `CronCreate|Delete|List`, `ScheduleWakeup`, `RemoteTrigger`, `Monitor`, `PushNotification`, `SendMessage`, `DesignSync`, `EnterWorktree`, `ExitWorktree`.
- for operator/controller `OPERATOR_READ_ONLY_DENIED_TOOLS` (:223: `Bash`, `Edit`, `MultiEdit`, `Write`, `NotebookEdit`) at :904.
- **CHANGED (ruling 101)**: for `kind === "reviewer"` the old `SUPPORTING_DENIED_BUILTINS` was replaced by `SUPPORTING_DELIVERY_DENIED_BUILTINS` (:259) — now only `Bash(git push:*)`, `Bash(gh pr create:*)`, `Bash(gh pr merge:*)`. The file-write built-ins and `git commit` / `git checkout -b` LEFT the kind-based list; a supporting run's local write posture now rides its grant-derived `spec.disallowedTools` (:910). What stays kind-based is reaching the REMOTE (the VIB-30 class).
- `spec.disallowedTools` last (:910).

Deliberately NOT denied: `ToolSearch`, the coding toolset, web tools, and the whole `mcp__*` channel (rationale at :279-290).

Terminal classification is gated on the final `result` envelope's `is_error`, never an exit code. `classifyClaudeError` (:547) → `quota | auth | session_missing | unknown`, riding the err line's tag as `run·error·<kind>` plus a `redactProviderText` sentence. Special arms: `error_max_turns` → `run·error·max_turns` (:1005); spawn `EBADF/EMFILE/ENFILE` and `ENOENT` get their own copy; an `is_error` RESULT is classified identically (P14-RT-10).

### 3.5 The Codex leg

`createCodexAdapter` (`app/server/runtimes/codex-runtime.server.ts:561`) over `@openai/codex-sdk` (`CODEX_SDK_VERIFIED_VERSION = "0.146.0"` :64, asserted against package.json by a test). `startThread` / `resumeThread` then `thread.runStreamed(prompt, {signal, outputSchema?})`.

`ThreadOptions` (:744): `model`, `sandboxMode`, `workingDirectory`, `skipGitRepoCheck: true`, `approvalPolicy: "never"`, `modelReasoningEffort` when in the SDK's union (`resolveCodexReasoningEffort` :189), `additionalDirectories = [attachmentsWritableDir]` **only under `workspace-write`** (:765), `networkAccessEnabled = false` for operator runs (:778), `webSearchMode = "disabled"` when egress is withheld (:787).

**CHANGED (ruling 101) — `resolveCodexSandboxMode(spec)` (:377) is now grants-derived:**

```ts
if (spec.kind === "operator") return "read-only";            // :380
if (spec.repoWriteWithheld) {                                 // :385
  return spec.attachmentsWritableDir ? "workspace-write" : "read-only";
}
const isDeliverer = spec.kind !== "reviewer";                 // :396
if (spec.autonomous && isDeliverer && !spec.webSearchWithheld) return "danger-full-access";
return "workspace-write";
```

Three deltas from R22: (a) `read-only` is BACK for a write-withheld run — the P13-RT-02 shape; (b) the OPERATOR is structurally `read-only` again (it used to be `workspace-write` under B-1's scratch-dir rationale, which is now moot but harmless); (c) `isDeliverer` no longer excludes `kind === "operator"` because the early return already settled it — but it also no longer excludes `"controller"`, which is inert only because controller runs are Claude-only.

`spec.repoWriteWithheld` is set in `startRun` (`run-service.server.ts:839-843`) from `input.repoWriteWithheld ?? repoWriteWithheldFromDenylist(input.disallowedTools)` (:594, markers `["Edit","Write","NotebookEdit"]` :580). Same shape for `webSearchWithheld` (:611, markers `["WebFetch","WebSearch"]` :609).

`codexConfigForRun(spec, base)` (:268) is the isolation half config can carry: `allow_login_shell: false`; `project_doc_max_bytes: 0` (the repo's `AGENTS.md` never becomes instruction-tier — the Codex counterpart of the CLAUDE.md excludes); `skills: {include_instructions: false, bundled: {enabled: false}}`; `features: {apps:false, plugins:false, hooks:false}`; `memories: {generate_memories:false, use_memories:false, dedicated_tools:false}`; `mcp_servers: codexMcpServers(...)` (:332, builder :153); `shell_environment_policy: {inherit:"core", ignore_default_excludes:false, set:<SHELL_EXPORTED_ENV_KEYS>}`; `developer_instructions = spec.systemPrompt`. `SHELL_EXPORTED_ENV_KEYS` (:218) is the CLOSED list crossing into the MODEL's shell: `GIT_CEILING_DIRECTORIES` + the four GIT_AUTHOR/COMMITTER vars.

Terminal: success = `turn.completed` seen with no TOP-LEVEL `turn.failed` / `error`. `classifyCodexFailure(cause, phase, streamText)` (:468) prefers the STREAMED reason; `CodexFailureKind = quota | auth | idle_timeout | session_missing | unknown`.

### 3.6 Backend selection, credentials, models

`app/server/runtimes/runtime-registry.server.ts`:

- `isBackendAvailable(backend)` (:309) — a cheap credential-PRESENCE check re-run on EVERY call (`setBackendAvailability` :428 is a sticky override). Claude: `ANTHROPIC_API_KEY` | `CLAUDE_CODE_OAUTH_TOKEN` | (`VIBERR_CLAUDE_USE_CLI_AUTH=1` AND a plausible config dir). Codex: `CODEX_ACCESS_TOKEN` | `CODEX_API_KEY` | `OPENAI_API_KEY` | (`VIBERR_CODEX_USE_CLI_AUTH=1` AND a real `$authSource/auth.json`). The registry NEVER makes a paid call.
- `backendCredentialHealth(backend, env)` (:349) — the ONE place UI, run service, logs and now `viberr_ops` get "why", with `verification: credential | file | presence | none`.
- `codexAuthMisconfiguration(diag)` (:184) names the D1 trap.
- `filteredSpawnEnv()` (:458) strips every `CREDENTIAL_ENV_RE` (:453) match plus `DATABASE_URL|REDIS_URL|SSH_AUTH_SOCK|GPG_AGENT_INFO`; `claudeSpawnEnv` (:509) / `codexSpawnEnv` (:475) re-add exactly the selected credential. **Both SDKs REPLACE the child env.**
- `selectAdapter(backend, adapters)` (:598) returns `{kind:"unavailable"}` or the adapter, and re-mirrors the codex auth home PER RUN (`prepareCodexHome`, `codex-config.server.ts:129`).
- R7-2: an unavailable backend does not fabricate a fallback stream — `failRunUnavailable` writes one classified `run·unavailable` err line and finalizes `error`.

Homes: `resolveClaudeConfigDir()` (`claude-config.server.ts:25`) → `CLAUDE_CONFIG_DIR` | `~/.claude` (CLI-auth opt-in) | `<dataRoot>/runtimes/claude-home`. `resolveCodexHome(env)` (`codex-config.server.ts:67`) → `<VIBERR_DATA_ROOT>/runtimes/codex-home`, always app-owned.

Models (`model-catalog.server.ts`): `curatedCatalog` (:175), `defaultModelFor` (:185), `defaultEffortFor` (:190), `isKnownModel` (:219), `foreignModelBackend` (:245), `resolveRunModel` (:263), `resolveRunEffort` (:290), `modelDisplayName` (:317), `getModelCatalog` (:542, `LIVE_TTL_MS` 10 min :371, `LIVE_TIMEOUT_MS` 15 s :372; NEVER throws). `startRun` substitutes a FOREIGN model with the backend default and injects `MODEL_SUBSTITUTED_TAG = "run·model_substituted"` (`run-service.server.ts:679`) as the run log's FIRST line.

**NEW (ruling 106) — `app/shared/model-ids.ts`.** The static half of `isKnownModel` for Claude now lives in a shared module the CLIENT pickers import: `CLAUDE_MODEL_ALIASES` (:16), `DATED_CLAUDE_ID_RE = /^claude-.*\d/` (:26), `claudeModelRunsVerbatim(model)` (:36). `model-catalog.server.ts:219-225` consumes `DATED_CLAUDE_ID_RE` from it rather than a private copy — so a picker can no longer rewrite a stored id that a run would execute verbatim to the catalog default (a silent model change, not a display correction).

Availability is learned from REAL failures only (ruling 19): `model-availability.server.ts` — `MODEL_UNSUPPORTED_RE` (:30), `markModelUnavailable` (:34), `clearModelMark` (:57), `unavailableModels` (:79), `noteModelAvailabilityFromFailure` (:106, a no-op unless the provider text matches).

### 3.7 Quota telemetry (materially expanded, D5 + V4)

`app/server/runtimes/backend-quota.server.ts`, stored as `instance_settings` KV. Two independent kinds of evidence, deliberately not folded together:

1. **Live utilization** — `recordBackendRateLimit` (:280) under `backendRateLimit.<backend>` (:50), fed by the Claude SDK's `rate_limit_event` envelopes through the sink (`run-sink.server.ts:359-370`, forwarded :364). **Claude-only by construction.**
2. **NEW — exhaustion, derived from a refused run** — `recordBackendQuotaExhaustion` (:298) under `backendQuotaExhausted.<backend>` (:51). Recorded in the sink (`run-sink.server.ts:398-409`) when a display line's tag ends `·quota` AND `quotaExhaustionEvidence(display.text)` (:152) matches — i.e. the PROVIDER's own sentence (split off at `PROVIDER_TEXT_MARKER` :135 by `providerSentence` :144, never the adapter's canonical prose) names a usage/quota/plan window (`USAGE_LIMIT_RE` :124). Generic 429 / "rate limit" wording is deliberately EXCLUDED — a transient 429 names no reset instant, so it would be recorded as exhaustion that nothing retires (the V4 defect). Recorded off the REDACTED display text.

`parseQuotaResetAt(text)` (:261) returns `{at, precision:"exact"|"prose"}`: an emitted epoch (`usage limit reached|<digits>`, 10 or 13 digits) is `exact`; a "try again at Sep 18th, 2026 5:20 PM" phrase is reconstructed by `proseInstantMs` (:200) as if UTC and marked `prose`. Retirement: `clearBackendQuotaExhaustion` (:319) is called from the sink's `finalize` **only on `state === "finished"`** (`run-sink.server.ts:501-506`) — a real completed run IS the re-probe (ruling 19); plus `latestBackendRateLimits(db, nowIso?)` (:385) drops a record whose reset has passed (`exhaustionExpired` :359, `QUOTA_RESET_GRACE_MS` 24 h for `prose` :342, none for `exact`) or, with no reset at all, once older than `UNDATED_EXHAUSTION_TTL_MS` (6 h, :354). It still **gates nothing** — pre-failure visibility on `/insights` and in `viberr_ops`.

### 3.8 Run logs

Canonical truth is one raw NDJSON file **per run**: `<dataRoot>/runtimes/<backend>/<runId>.jsonl`, via `rawLogPath` (`run-store.server.ts:409`) / `appendRawLine` (:418). `run_log_lines` (`0001_baseline.sql:501`, UNIQUE `(run_id, seq)` :612) is the projection. Store API: `upsertRun` (:83), `patchRun` (:163), `getRun` (:199), `listRunsForTaskRows` (:206), `agentNamesByProfile` (:229), `nextSeq` (:248), `listRunLines` (:264), `listRunLinesTail` (:307), `runLineStats` (:351), `runIdsWithMissingSession` (:379), `insertRunLine` (:430).

**CHANGED (C1)**: `outcome_key` is now a first-class store column — declared on `AgentRunRow` (:46-50) and patchable via `RunPatch.outcomeKey` (:153-159, mapped :181). `registerAgentCompletion` writes it through `patchRun` (`task-actions.server.ts:3106`) instead of the old raw `UPDATE agent_runs SET outcome_key = ?`. Pass-31 gotcha #19 is CLOSED.

`createRunSink(db, spec)` (`run-sink.server.ts:185`) → `{markRunning, phase, line, finalize}`. Per line, in order — **persist BEFORE publish**: (0) redact + the quota-exhaustion probe, (1) `appendRawLine` (:413), (2) `insertRunLine` with `display_json` (:418), (3) `patchRun` folding session id / turns / token counters (running `Math.max` :354-356) / last-seen cost (:427), (4) `publishRunLogAppended({runId, seq})` (:438).

Redaction (P13-U-1) is built ONCE per run by `createLineRedactor(env)` (:150): every `process.env` value whose key matches `CREDENTIAL_ENV_RE` and is at least `MIN_SECRET_VALUE_LEN` (12, :139) chars, longest-first, plus `TOKEN_PATTERN_SOURCE`. Deliberately NOT an entropy heuristic.

Two failure regimes: a DRAINED database (`runPersistDrained` :40) logs ONE warning for the whole run; a real persist failure logs per line and writes one `LINE_LOST_TAG = "run·line_lost"` (:88) err line. `resolveTerminalState(current, desired)` (:55) — the FIRST terminal state wins (B-FD7).

Reads: `getRunLog(db, runId, {since?|before?, limit?})` (`run-service.server.ts:1657`) picks forward vs backward mode, default page `RUN_LOG_PAGE_LINES = 200` (:1634). **mode selection reads `limit`, not just `before`** (`backward = before !== undefined || limit !== undefined`, :1664), so a caller that passes `limit` with `since` gets a BACKWARD page instead of a bounded tail; a true forward tail is bounded by the consumer's own cursor and `listRunLines` has no SQL LIMIT. `projectRunsForTask` (`run-projection.server.ts:270`) groups rows by agent (`groupKeyOf` :237) and fills a newest-run-first window against `RUN_LOG_WINDOW_LINES = 400` (:62) and `RUN_LOG_WINDOW_BYTES = 384 KB` (:63). `failedBackendUnavailable` + `altBackend` (:222-224) drive the D4 cross-backend retry offer.

SSE: `publishRunLogAppended` (`run-events.server.ts:12`) / `publishRunStateChanged` (:42) publish DIRECTLY to the broker. Payloads are REFERENCE-ONLY (`runId` + `seq`). Both early-return when `projectSlug === ""` — controller turns.

Client: `app/features/runtime/{use-run-log-stream.ts, runs-panels.tsx, runs-helpers.ts, log-noise.ts, log-clock.ts, runtime-types.ts}`. **MOVED (ruling 107)**: `canReadControllerRunLog` now lives at `app/server/controller/controller-conversations.server.ts:117` (it was in `controller-run.server.ts`) — the run-log route, the session export and `viberr_ops` all ask it, and importing the run engine to answer a conversation-access question made a cycle.

Retention: `RUN_LOG_RETENTION_DAYS = 30` (`app/server/db/retention.server.ts:51`) and `pruneRuntimeTranscripts` (`app/server/ops/transcript-retention.server.ts:184`, default 30 :63) are aligned ON PURPOSE. `sessionHomeRetentionDays()` (:98, default 30, `0` = forever) prunes `runtimes/claude-home/projects/` and `runtimes/codex-home/sessions/`. **CHANGED (C3)**: both windows read the VALIDATED env via `getEnv()` (`days()` :85) instead of `process.env[name]` by string.

### 3.9 Interrupt and watchdogs

1. **`interruptRun(db, {projectSlug, taskKey, runId}, actor)`** (`run-service.server.ts:1522`). RBAC `run-agents`, deliberately NOT gated on `archived`. Idempotent. With a live handle: `handle.interrupt()`, delete the handle, stamp `interrupted_by` immediately. Without one: write the terminal row directly, publish, `state.reserved.delete(runId)` + `drainRunQueue(db)` (F28-R1). Always audits `runtime.run.interrupted`.
2. **Claude watchdog**: `claudeIdleTimeoutMs()` (`claude-runtime.server.ts:176`, default 15 min), re-armed on every stream message. On timeout: cooperative `Query.interrupt()` → after `INTERRUPT_GRACE_MS` (20 s, :189) `abortController.abort()` → after `INTERRUPT_ABORT_GRACE_MS` (10 s, :200) a backstop settle. **CHANGED (C3)**: reads `getEnv().VIBERR_CLAUDE_IDLE_TIMEOUT_MS` (:177), not raw `process.env` — a test that sets it must call `resetEnvCacheForTests()`.
3. **Codex watchdog**: `codexIdleTimeoutMs()` (`codex-runtime.server.ts:406`, default 15 min). `abort.abort()` IS the kill lever; `INTERRUPT_SETTLE_GRACE_MS` (20 s, :421) force-settles. Codex has no `maxTurns`.
4. **Clone timeout** `cloneTimeoutMs()`, then the next boot's `finalizeOrphanedRuns`.

### 3.10 Concurrency, reservations, single-flight

Cap: `getMaxConcurrentRuns(db)` (`app/server/settings/instance-settings.server.ts:89`) / `setMaxConcurrentRuns` (:95) — an instance SETTING (key `maxConcurrentRuns`), **not** an env var. Default `0` = **unlimited**; ceiling `MAX_CONCURRENT_RUNS_CEILING = 64` (:80). Service state lives on `globalThis[Symbol.for("viberr.runService")]`.

- `liveCount(state) = handles.size + reserved.size` (`run-service.server.ts:1292`).
- `reserveRun(db, input)` (:450) returns `null` when no slot is free or on a display failure, but THROWS a 409 on a single-flight violation.
- `admitRun(db, runId, launchThunk)` (:1308) launches now, or parks the thunk in `state.pending` with the DB row left `queued`.
- `drainRunQueue(db)` (:1332) is called from every `onExit` (BEFORE the completion callback), from `abandon()`, from the unavailable-backend path, and from interrupt-while-reserved.
- `runConcurrencySnapshot(db)` (:1367) → `{cap, live, queued}` — now also read by `viberr_ops.instance_health`.

**There is no `releaseRun` and no `withLease`.**

Single-flight is enforced twice — a JS preflight in `dispatchAgentRun` (:1259-1303) and two partial unique indexes:

```sql
idx_agent_runs__one_delivering       (project_slug, task_key)        -- 0001_baseline.sql:593
  WHERE kind='primary'  AND state IN ('queued','running')
idx_agent_runs__one_live_per_support (project_slug, task_key, agent_profile_id)  -- :608
  WHERE kind='reviewer' AND state IN ('queued','running')
```

`singleFlightConflict(kind, sqlite)` (:416) translates SQLite errcode **2067** into a 409 for BOTH write paths, discriminating on the violated columns. `ensureSingleFlightIndexes(db)` (`app/server/db/sqlite.server.ts:114`, called :94) idempotently re-creates the supporting index at boot.

`assertRunReservationLive(db, runId)` (:389, `RESERVATION_LIVE_STATES` :371) is checked at three points: before preparation, after the clone (`specialist-run.server.ts:1537`), and inside `startRun` (:706).

Leases, where they DO exist: the controller conversation lease (`controller-run.server.ts:68-99`, FIFO of at most `MAX_QUEUED_MESSAGES = 8` :100, released in `settleTurn` :395); the operator's coalesce lease; the schedule claim lease (`claimLeaseMs()`).

### 3.11 Recovery, and the one-nudge stranded hold

`app/server/runtimes/run-recovery.server.ts` (`RECOVERY_REINVOKE_CAP = 3` :19, `RECOVERY_WINDOW_MS` 30 min :20, `STRANDED_PLAN_MAX_AGE_MS` 60 min :36):

- `finalizeOrphanedRuns(db)` (:71) — on a fresh boot a non-terminal row is by definition an orphan: patch `state='error', finishedAt=now, interruptedBy='restart'`, then re-invoke the operator per affected task, guarded by a crash-loop backstop. `controller` runs are skipped.
- `recoverUnreactedAgentRuns(db, ctx)` (:218) — finished `primary`/`reviewer` runs whose task is still `waiting='agent'` with no `task.agent.replied` audit row. It re-supplies `outcome_key`.
- `recoverStrandedOperatorPlans(db, ctx)` (:378) — the Codex-only window, bounded to 1 hour.
- `IDEMPOTENCY_AUDIT_ACTIONS` (`app/server/db/retention.server.ts:72`) are EXEMPT from the 90-day audit window.

Boot chain `reconcileRestartedWork(db, deps?)` (`app/server/boot.server.ts:411`) runs the four steps strictly sequenced and individually caught, with the workspace reclaim gated on `activeRunCount(db) === 0` (:455).

**NEW (F31-11 / V13 / V18) — the stranded-operator resume is ONE paid nudge, then a recorded hold.** `maybeResumeStrandedOperator` (`operator-run.server.ts:701`):
- If `heldAtStage === stage`, the resume is withheld silently (:777-795) — a durable hold already stands and every external trigger would otherwise buy a fresh nudge plus a byte-identical note.
- If THIS drive was itself the nudge (`ref.strandedResume`, :805), the settle writes `heldAtStage = stage` plus one policy-engine timeline note and stops (:806-857).
- Otherwise it fires one resume with `strandedResume: true` (:905) and the turn instruction tells the operator to advance or RECORD the hold (`resumeContext`, `operatorTurnDoctrine` :3410-3416).
- `queueOperatorTrigger` (:435) preserves `strandedResume` and the deeper `transitionDepth` across newest-wins overwrites (:438-451) — losing either un-marks the eventual drive.
- A cross-boot `executeStrandedCodexPlan` sets `strandedResume: false` explicitly (:2046).

Single-writer safety: `app/server/db/data-root-lock.server.ts` — an `openSync(path, "wx")` at `<dataRoot>/state/writer.lock`. `classifyLock` (:307) → `stale | held | unknown-holder`; a 20 s guard (`DATA_ROOT_LOCK_GUARD_INTERVAL_MS` :555) re-verifies ino/dev + `bootId` and, on a `stolen` verdict, writes a fatal line and `process.exit(1)`. `forceDataRootTakeover` (:227) reads `VIBERR_FORCE_DATA_ROOT_LOCK` (:53). `heldDataRootLock()` (:186) is what the health snapshot reports.

Session continuity: `probeSessionContinuity(backend, sessionId)` (`session-export.server.ts:258`) + `SESSION_MISSING_RE` (:245), three-valued `present | missing | unknown`. `resumeRun` (`run-service.server.ts:1215`) probes BEFORE handing the id to the SDK; on `missing` the turn runs once as a FRESH canonical-anchored run with a `continuityResetPreamble`. Three probes exist deliberately: `transcriptExists` (:196, loader path), `probeSessionContinuity` (:258, resume path, uncached), `locateTranscript` (:276, export route). `buildResumeScript` (:322) emits a self-contained base64 bash installer carrying the transcript and NO credentials.

---

## 4. Claude ↔ Codex parity

Ruling 101's sentence is the contract: *"reviewer is just a type of an agent; some agents should be able to write, some don't, related to their work/assignment — but parity between Claude and Codex is essential."*

### 4.1 The two enforcement channels

| | Claude | Codex |
| --- | --- | --- |
| tool denial | `options.disallowedTools`, binds under `bypassPermissions` (`claude-runtime.server.ts:891-911`) | **none** — the SDK has no denylist channel |
| OS confinement | none (permissionMode only) | `ThreadOptions.sandboxMode` (`codex-runtime.server.ts:746`), all-or-nothing filesystem |
| network | `WebFetch`/`WebSearch` denial | `networkAccessEnabled` (operator only, :778) + `webSearchMode` (:787) |
| in-process tools | `viberr_agent` SDK MCP server (`agent-toolkit.server.ts:252`) | not mountable in-process; the outcome ENVELOPE (`outputSchema`) is the substitute |
| config-tier isolation | `settingSources`, `strictMcpConfig`, `skills[]`, `plugins: []` | `codexConfigForRun` (:268) + the app-owned `CODEX_HOME` |
| repo docs ingress | `<workspace>/.claude/settings.json` excludes (`skill-mount.server.ts:427`) | `project_doc_max_bytes: 0` (`codex-runtime.server.ts:292`) |

### 4.2 Parity matrix — capability × backend × mechanism

`E` = real enforcement (a tool/write is physically impossible); `A` = advisory (prompt + server-side gate only); `—` = not applicable.

| Capability | Claude mechanism | Codex mechanism | `capabilityEnforcement` |
| --- | --- | --- | --- |
| `execute-code-or-write-repo` | **E** — denylist `Edit`/`MultiEdit`/`Write`/`NotebookEdit`/`Bash(git commit:*)` (`specialist-tool-policy.ts:77-80`) | **E*** — `sandboxMode: "read-only"` (`codex-runtime.server.ts:385-387`) — **unless the run is evidence-granted, which widens the WHOLE workspace to `workspace-write`** (see §4.3) | `both` (capabilities.ts:258) |
| `create-task-branch` | **E** — `Bash(git checkout -b|-B:*)`, `Bash(git switch -c|-C:*)` (:56-66) | **A** — sandbox is all-or-nothing; boundary is credential-less agents + server-owned delivery | `claude-only` (:282) |
| `commit-push-branch` | **E** — `Bash(git push:*)`, `Bash(git commit:*)` (:67) | **A** — same | `claude-only` (:283) |
| `open-review-pr` | **E** — `Bash(gh pr create:*)` (:68) | **A** — same | `claude-only` (:284) |
| `merge-pull-request` | **E** — `Bash(gh pr merge:*)` (:69) + always-human | **E** — server-side only (no agent path exists on either leg) | `both` (via `ALWAYS_HUMAN`, :298-301) |
| `use-web-search-fetch` | **E** — denylist `WebFetch`, `WebSearch` (:86-89) | **E** — `webSearchMode: "disabled"` (`codex-runtime.server.ts:787`); `curl`/`wget` through Bash stay reachable on BOTH | `both` (:250) |
| `use-browser` | **E** — the MCP server is not MOUNTED (`specialist-browser-mcp.server.ts:142`) | **E** — same mount gate, same code path | `both` (:263) |
| `report-validation-verdict` | **E** — the `report_outcome` tool is not BUILT (`agent-toolkit.server.ts:422-440`) **and** the completion pipeline re-derives the grant | **E** — server-side re-derivation; a Codex agent CAN fill the envelope's `verdict` field, and the drop is LOGGED, not silent (B-5) | `both` (:243) |
| `ask-human` | **E** — `ask_human` tool not built (:288) + server-side packet gate | **E** — server-side packet gate on the envelope's `question` | `both` (:244) |
| `attach-evidence-references` | **E** — the `report_outcome` `evidence` field is not declared + server-side row gate | **E** — server-side row gate on the envelope | `both` (:247) |
| `comment-on-task` | **E** — `post_comment` tool not built (:261) | **A** — Codex has no in-process comment channel at all; its final reply always posts | `claude-only` (:287) |
| `read-github-api` | **E** — `github_read` tool not built (:456) | **A** (never mounted — the PAT would ride codex's `--config` argv) | `claude-only` (:291) |
| `transition-to-done` / `change-project-policy` | **E** — no tool exists | **E** — no plan verb exists | `both` |
| advisory group (`group: null`) | **A** — persona text only | **A** — persona text only | `advisory` |
| **operator read-only posture** | **E** — `OPERATOR_READ_ONLY_DENIED_TOOLS` (`claude-runtime.server.ts:223`, applied :904) | **E (restored)** — `sandboxMode: "read-only"` (`codex-runtime.server.ts:380`) | ruling 101(d) |
| **supporting-run remote block** | **E** — `SUPPORTING_DELIVERY_DENIED_BUILTINS` (:259, applied :909) | **E-by-absence** — no credential; delivery is server-owned | ruling 101(b) |
| **repo `CLAUDE.md`/`AGENTS.md` ingress** | **E** — `<workspace>/.claude/settings.json` excludes + `nativeSkillsForRun` precondition (`claude-runtime.server.ts:371`) | **E** — `project_doc_max_bytes: 0` | ruling 101 era |
| **granted skills** | native (`skills[]` + `settingSources:['project']`) | prompt text only — the CLI's skills channel is severed (`skills.include_instructions:false`, `bundled.enabled:false`) | deliberate asymmetry |
| **org MCP credentials** | sent (`Authorization` header / `MCP_CREDENTIAL` env) | **NOT sent** — codex serializes MCP config into `--config` argv, `ps auxww`-visible (`specialist-mcp.server.ts`, `codexMcpServers` :153) | disclosed, not normalized |
| **MCP tool naming** | `mcp__everything-http__echo` | `mcp__everything_http__echo` (the CLI lowercases hyphens to underscores) | disclosed (P13-LV-15) |
| **screenshots back to the model** | yes (SDK renders image tool-results) | no — `--image-responses omit` (`specialist-browser-mcp.server.ts:191`); the persona says so | deliberate |

### 4.3 The one disclosed carve-out, and how wide it actually is

`resolveCodexSandboxMode` (`codex-runtime.server.ts:385-387`): a write-withheld run that also carries `spec.attachmentsWritableDir` gets `workspace-write` instead of `read-only`, because the sandbox cannot express "read-only except attachments/" and blocking the copy-into-attachments flow was the F22-03 defect.

`attachmentsWritableDir` is set iff `collab.evidence` — i.e. an effective `attach-evidence-references` grant (`specialist-run.server.ts:1873-1875`; gate via `effectiveCollabMode`, `agent-outcome.server.ts:381`). That capability's catalog default is **`direct`** (`capabilities.ts:142`), it is NOT in `GRANT_REQUIRED_CAPABILITY_IDS`, and `conservativeGrantsFor("agent")` (:192) does not withhold it. The **shipped Reviewer profile grants it explicitly** (`app/server/seed/agent-catalog.server.ts:187`) while withholding `execute-code-or-write-repo`.

So the carve-out is not an edge case: it is the DEFAULT shape of a write-withheld agent. On Claude that agent cannot call `Edit`/`Write`/`NotebookEdit`/`git commit`; on Codex the same agent gets a writable, shell-capable workspace. See finding **F32-R2**.

### 4.4 Where parity is achieved by ABSENCE rather than mechanism

Worth stating plainly, because the matrix's `E` for these is not symmetric machinery:

- **Delivery** (push / open PR / merge / close / Done) is server-owned on both legs (`pushWorkspaceBranch`, `performDelivery`). Agents hold no push credential on either backend (`specialist-run.server.ts:2974-2979`).
- **Verdicts, questions and evidence rows** bind on Codex only because the completion pipeline re-resolves the same grants before recording (`applyAgentCompletionEffects`, `task-actions.server.ts:3139+`) — there is no tool to withhold.
- **MCP tools sit OUTSIDE the capability policy on BOTH backends.** `CAP_DENY_RULES` covers Bash and the file tools; there is no `mcp__*` rule. The rule "MCP tools do not widen your authority" is prompt text on both legs (`specialist-run.server.ts:2244`), and the matrix says so out loud (`capability-matrix-modal.tsx:269-276`).

---

## 5. The user-authority ceiling per tool call, and the controller's two servers

Ruling 99 + 107. The controller is the one agent whose authority is a LIVE HUMAN's, resolved per tool call — never snapshotted, never stored as a grant row.

**NEW — the refusal machinery is now shared.** `app/server/controller/controller-tool-guards.server.ts` — `controllerToolGuards(db, user, dataRoot)` (:79) returns `{actor, orgAdmin, requireOrgAdmin, requireVisible, run, runWith, json}`. Both in-process servers build from it (`controller-toolkit.server.ts:161`, `controller-ops-mcp.server.ts:130`), so a reworded refusal cannot drift between them.

- Actor `{userId: user.id, label: "<email> · via controller"}` (:84).
- `requireOrgAdmin(what)` (:89) checks `isOrgAdmin(db, user.id)` LIVE and writes a `controller.authority.denied` audit row before throwing (P13-D-8 parity).
- `requireVisible(slug, what)` (:101) goes through `assertProjectAction(db, "any-member", …, {allowArchived:true})`; missing and forbidden answer the SAME `notVisible` sentence (:48) via `NotVisibleError` (:54) — no existence oracle.
- `run()` / `runWith()` (:112/:136) map an `AppError` to `[denied] <sentence>` for 401/403 and `[error] …` otherwise.

### 5.1 `viberr_controller` (the product toolkit, ruling 99)

`buildControllerToolkit(deps)` (`controller-toolkit.server.ts:154`) builds an in-process Claude SDK MCP server; tool names are stamped `mcp__viberr_controller__<name>` (:183). `CONTROLLER_TOOLKIT_INSTRUCTIONS` (:144) tells the model a `[denied]` answer is final. Per-verb gates reuse the human guards: `run_agent_on_task` (:1052) calls `canRunAgents` (:1075), then dispatches through the SAME `runOperator` / `startAgentRun` entry points, arming the dispatch-completion contract. **No tool exists for merge, acceptance, force-accept, packet resolution, a terminal-stage move, or ANY delete. The ceiling is the tool SET, not a prompt.**

### 5.2 `viberr_ops` (NEW — the diagnostics MCP, ruling 107)

`app/server/controller/controller-ops-mcp.server.ts`, mount key `CONTROLLER_OPS_MCP_NAME = "viberr_ops"` (:75), instructions :77. READ-ONLY: nothing writes, deletes or starts anything. Three tools:

- **`instance_health`** (:163). Reading is UNGATED — it is what `/resources/health` serves unauthenticated — plus availability booleans and `runConcurrencySnapshot` (:191). The credential DETAIL is org-admin only: `backendCredential(backend, orgAdmin)` (:117) returns the full `BackendCredentialHealth` for an admin and `{backend, available}` otherwise, because the sentence names deployment config paths.
- **`read_run_log`** (:200). Gate: `requireRunVisible(row)` (:149) — a `controller` row goes through `canReadControllerRunLog`, everything else through `requireVisible(row.project_slug)`; a missing run, a forbidden project and a forbidden conversation all answer `notVisibleRun(runId)` (:104). Bounded on EVERY path: `DEFAULT_LOG_LINES = 200`, `MAX_LOG_LINES = 500` (:98-99); `since` + `before` together is REFUSED (:243) rather than letting one silently win; forward mode applies the bound itself (`page = log.lines.slice(0, limit)` :272) because `getRunLog` ignores `limit` there BY DESIGN. Page position is computed against the RUN's real bounds via `runLineStats` (:280-284) and reported as `page.{firstSeq,lastSeq,olderExist,newerExist,next}` plus `run.logLines` — `getRunLog`'s own `headSeq`/`oldestSeq`/`hasMore` are page-local console cursors and are deliberately NOT relayed (:275-279).
- **`read_store_doc`** (:329). `requireOrgAdmin("read store documents")` (:339); reports `truncated` honestly (:349).

**Not removable by construction.** `buildControllerMounts(db, input)` (`controller-run.server.ts:150`) attaches both in-process servers on EVERY turn with no config read and no grant row, then spreads org grants LAST (:167-176). Org grants cannot shadow them because the RESOLVER refuses reserved names (§7.2). The system prompt states the mount unconditionally (:672-676) and now says "org MCP servers" in the mounted/none arms (:665-667) so the model is not told in consecutive breaths that it has no MCP server and that it has one.

### 5.3 Controller run shape

`runControllerTurn` (`controller-run.server.ts:180`) refuses honestly when `isBackendAvailable("claude")` is false (:206). `startTurnRun` (:263) resolves + pre-flights the ORG MCP grants once (:275-281), then adds `disallowedTools = ["Read","Grep","Glob","WebFetch","WebSearch"]` (:301) on top of the operator read-only set. Runs carry `project_slug = ''` and `task_key = <conversationId>` (:344-345).

### 5.4 Ordinary agents authorize differently

**Their tools are BUILT only when the capability is granted.** `buildAgentToolkit({db, ctx, projectSlug, taskKey, actorRef, outcomeKey, collab})` (`app/server/tasks/agent-toolkit.server.ts:252`) mounts `viberr_agent` with `post_comment` (:261), `ask_human` (:288), `report_outcome` (:422, its optional `evidence` field separately gated) and `github_read` (:456). Gates come from `resolveAgentCollab(grants)` (`agent-outcome.server.ts:407`) / `effectiveCollabMode(grants, id)` (:381), where a `recommend` grant falls through to the catalog default rather than being widened.

Server-side re-derivation is the real gate — which is how verdicts, questions and evidence bind on Codex too.

`withMcpAutoApproval(allowedTools, mcpServerNames)` (`run-service.server.ts:643`) auto-approves every MOUNTED server the caller did not already name, in ONE funnel (fresh, operator, resume). `allowedTools` is the APPROVAL list; a caller that curated per-tool entries (the operator does) is left alone.

**NEW (C9)**: `AGENT_QUESTION_PACKET_KIND = "Agent question"` (`agent-outcome.server.ts:435`) is now a shared constant — packet resolution routes the human's answer back to the asking agent only when `packet.kind` matches exactly (`task-actions.server.ts:6594`), and it used to be an untyped English literal duplicated at writer and reader.

---

## 6. Browser capability and the attachments store

`use-browser`, catalog default OFF, ruling 75 / R19-19 (`app/server/tasks/specialist-browser-mcp.server.ts`). **Note**: the SEEDED Developer profile grants it `direct` alongside `Search & fetch from the web` (`app/server/seed/agent-catalog.server.ts:161`, owner ruling 2026-08-27) — so out of the box one deployed profile has a browser.

- `resolveBrowserMcp({grants, attachmentsDir, backend})` (:136) requires `use-browser === "direct"` (:142) AND `use-web-search-fetch === "direct"` (:151); the contradictory pair is SURFACED as an `UnresolvedMcpGrant` (:60-71), never silently resolved. Enforcement is the MOUNT, and it binds on BOTH backends.
- `BROWSER_MCP_NAME = "viberr_browser"`, in the shared reserved list, refused as a registry name at save.
- The mount (:185-197) is `{command: process.execPath, args: [<@playwright/mcp cli.js>, "--headless", "--isolated", "--output-dir", <attachmentsDir>, …("--image-responses","omit") on codex, …("--executable-path", VIBERR_BROWSER_EXECUTABLE, "--no-sandbox")]}`. **No `env`** — deliberately, so the config survives codex's `--config` argv serialization.
- Chromium ships IN THE IMAGE: `Dockerfile:60-73` installs Debian `chromium` + `fonts-liberation` and sets `ENV VIBERR_BROWSER_EXECUTABLE=/usr/bin/chromium` (:73).
- `browserRuntimeStatus()` (:108) hoists the same checks; it is now also a field on the ops health snapshot (`app/server/ops/health-snapshot.server.ts:89`).
- Containment: `--isolated`; no `--allow-unrestricted-file-access`. Injection stance is prompt-level (`browserPersonaSection` :235).
- **Ruling 103**: the declared browser matrix is Chromium-only; Safari/Firefox were struck from the PRD.

### 6.1 Attachments drop and the NEW completion-time prune (ruling 105)

The dir is `taskAttachmentsDir(projectSlug, taskKey, dataRoot)`, created before the run when `collab.evidence` holds (`specialist-run.server.ts:1586-1587`) and by the browser mount (`specialist-browser-mcp.server.ts:183`, idempotent). Codex `workspace-write` adds it via `RunSpec.attachmentsWritableDir` → `threadOptions.additionalDirectories` (`codex-runtime.server.ts:765`); Claude at bypassPermissions needs no widening.

At completion, `applyAgentCompletionEffects` (`task-actions.server.ts:3139`):

1. `attachmentNamesSince(slug, key, sinceIso, dataRoot)` (`app/server/files/task-attachments.server.ts:106`) collects everything written at-or-after `agent_runs.started_at`. **CHANGED**: it no longer rides `listTaskAttachments` — that path's `LIST_CAP` display bound silently limited the window to the newest 100 files, permanently orphaning the overflow in exactly the drowning case the prune targets. It now `readdirSync`+`statSync`es directly and is UNCAPPED.
2. **NEW — `pruneBrowserWorkingArtifacts(slug, key, names, citedIn, dataRoot)`** (:196) deletes the run's machine-stamped non-visual artifacts unless the exact filename is cited. `isBrowserWorkingArtifact(name)` (:170) = `MCP_STAMPED_NAME_RE` (:151, `^[a-z][a-z0-9_]*-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.`) AND NOT `VISUAL_EVIDENCE_RE` (:156, png/jpe?g/webp/gif/pdf). The stamp itself is the classifier, not a prefix allow-list. `ENOENT` counts as pruned; any other error keeps the file listed, because the panel must never name-check files the directory still holds.
3. Call site `task-actions.server.ts:3316-3382`, with two scoping guards, both live-confirmed: **finished runs only** (an errored browsing run never got to cite anything, and its console dump is often its only diagnostic), and **no prune while a SIBLING run is live on this task** (`siblingLiveRuns` COUNT at :3334-3342 — the mtime window is task-wide).
4. The citation corpus (:3343-3358) is the final reply, the FULL envelope text (`replyText` is narrowed to its summary for Codex), the evidence rows, the ask-human question title/body, and every timeline text since the run started. It is assembled AFTER `replyText`/`outcome` are final and BEFORE every consumer of the attachment list.
5. Persona discloses the cleanup on both halves: `attachmentsDropSection` (`specialist-browser-mcp.server.ts:219`, tail at :228-231) and `browserPersonaSection` (:235, "Snapshots and console dumps are yours, not the humans'" :271-275).

Serving: `projects/:slug/tasks/:key/attachments/:file` (`app/routes.ts:63`, `app/routes/task-attachment.ts`) — raw bytes, member-only. `INLINE_TYPES` (`task-attachments.server.ts:223`) gained `.yml`, `.yaml`, `.csv` as `text/plain` (:234-237) so the in-app read-only viewer can fetch them; `?download=1` forces the save dialog (`task-attachment.ts:55-57`).

---

## 7. Skills and MCP loading

### 7.1 Skills — now a two-part atomic decision

Claude gets skills NATIVELY; Codex gets them as prompt text. The asymmetry is deliberate: the Codex CLI's whole skills channel is severed because it cannot be governed per skill.

`app/server/runtimes/skill-mount.server.ts` is the ONLY writer of `<workspace>/.claude`, and now does **three** halves of one job:

- `stripUngovernedRepoCatalog(repoDir)` (:125) deletes whatever `.claude` the cloned repo ships — first marking tracked `.claude` paths `--skip-worktree` (:129-141), so `git add -A` delivery never stages the deletion. **CHANGED (V6)**: when live mounts survive, it OVERWRITES `settings.json` in place first (:176) and deletes it only if that write fails (:177-182); the preserve loop now keeps `skills` and `CATALOG_SETTINGS_FILE` (:184-186). With no survivors the whole catalog still goes (:151-155) — a run of ours that mounts nothing keeps `settingSources: []`.
- `mountGrantedSkills({workspaceDir, skills, dataRoot})` (:299) strips first (:324), `excludeCatalogFromDelivery(dir)` (:325 / :529), copies each granted skill NORMALIZING frontmatter to `{name, description}` only, refuses symlinks and nested `.git` (`copyableEntry` :661), and refuses anything that is not a plain git checkout (`isPlainGitCheckout` :511). **CHANGED**: after the copy loop it writes the excludes file, and **a failed write mounts NOTHING** (:347-357) — every grant falls back to prompt-text injection. Returns `{mounted, skipped, settingsWritten}` (`SkillMount` :253-265).
- `ensureCatalogSettings(repoDir)` (:472) — the precondition seam the Claude adapter calls before opening the source. It REPAIRS rather than only reporting (the workspace is shared and a co-engaged run's mount strips this catalog), never CREATES a catalog, and refuses to write through a symlinked `.claude` (:481-486). `catalogSettingsInPlace` (:492) `lstat`s first and rejects a symlink, an oversized file (`CATALOG_SETTINGS_MAX_BYTES` 4096, :417) or one whose parsed `claudeMdExcludes` lacks any of the three patterns.

`MOUNT_MARK` (:100) is a per-PROCESS random UUID written as `.viberr-mount` (:101) in each mounted folder; the strip preserves ONLY folders carrying that exact mark (`ownMountedSkillNames` :194). `isSdkSkillName(name)` (:243, `/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/`) is an ALLOW-list; the adapter re-checks with `nativeSkillNames` (`claude-runtime.server.ts:338`).

The persona injects ONLY the non-mounted skills (`injectable`, `specialist-run.server.ts:2148`) under one shared budget; mounted skills get their own trusted-provenance banner (:2155).

Two accepted residuals, both stated in code: a mount is never garbage-collected (`skill-mount.server.ts:340-345`), and — the new one — if the excludes file goes missing AFTER the mount and the adapter's repair also fails, the persona has already announced the skills the run will not enable (`claude-runtime.server.ts:360-368`).

### 7.2 MCP

- Registry: `app/server/org/resources.server.ts` — `listMcpServers` (:806), `getMcpServer`, `getMcpCredentialState`, `splitMcpCommand`, `discoverStdioMcpTools`, `discoverHttpMcpTools`, `markMcpServerUnreachableFromRun`, `saveMcpServer` (reserved-name refusal at :1516).
- **NEW names-only readers (F31-3 / V12)**: `listKnowledgeBaseNames` (:267), `listMcpServerNames` (:811), `listSkillNames` (:1972) — because the operator snapshot's `orgResources` catalog backs `get_task`, the most-called tool, and `buildSkill` reads every SKILL.md body (up to 256 KB) that the caller then discards.
- Per-run: `resolveSpecialistMcpServersDetailed(db, mcpNames)` (`specialist-mcp.server.ts:115`) → `{servers, unresolved}`. Portable shapes `HttpMcpServerConfig` (:68) / `StdioMcpServerConfig` (:61).
- **CHANGED (ruling 107) — ONE reserved-name list.** `app/shared/mcp-reserved.ts` (`RESERVED_MCP_NAMES` :31, `isReservedMcpName` :42) covers `viberr`, `viberr_agent`, `viberr_browser`, `viberr_controller`, `viberr_ops`, each in both spellings. Three layers read it: the WRITER (`resources.server.ts:1516`), the PICKER (`resource-catalog.server.ts:67`), and the RESOLVER (`specialist-mcp.server.ts:138/142/175`). The resolver's private copy had fallen two rulings behind, so a row carrying `viberr_controller` or `viberr_ops` — written straight into SQLite, restored from a backup, or created before the name was reserved — resolved normally and, because org servers mount LAST, REPLACED the instance's own in-process server under its own key.
- Credentials are sealed in the registry and decrypted ONLY at run-spawn. A credential that is CONFIGURED but unopenable DROPS the mount with a reason (A9, :185-190).
- `verifyStdioMcpMountsForRun(db, resolution, {backend})` (:243) re-runs the real discovery handshake per stdio mount, DROPS a server that fails to start, discloses it by name, and writes row-health back. On Codex it pre-flights WITHOUT the credential (matching the run, B-4).
- A REGISTERED but known-down server still mounts and is flagged `mounted: true` in `unresolved` (`flagDown` :152).
- Mount precedence (`specialist-run.server.ts:1823-1825`): declared org servers → browser → toolkit. The toolkit can never be shadowed. Controller precedence is the same shape (`controller-run.server.ts:167-171`) except the org grants come last, which is safe only because the resolver refuses reserved names.
- Codex translation: `codexMcpServers(servers)` (`codex-runtime.server.ts:153`) via `codexMcpServerSchema` (:115) — an in-process `{type:"sdk"}` server decodes to `null`; a half-declared server is DROPPED rather than partially translated.
- Command isolation: the Codex CLI MERGES `--config` per dotted leaf key into `$CODEX_HOME/config.toml` — it removes NOTHING the home declares. On Claude the equivalent lever is `strictMcpConfig: true`.

---

## 8. Gotchas

1. **`allowedTools` is NOT a restriction** — it is the auto-APPROVAL list. The only Claude restriction channel is `disallowedTools`.
2. **Codex ignores `disallowedTools` entirely.** Since ruling 101 the *headline* repo-write withholding binds there through the SANDBOX instead; the three SCOPED delivery commands remain advisory, with the server-owned delivery gate + credential-less agents as the boundary.
3. **A Codex `read-only` run is derived from the DENYLIST, not from a grant lookup.** `startRun` computes `repoWriteWithheld` from `repoWriteWithheldFromDenylist(disallowedTools)` when the caller passes no explicit value (`run-service.server.ts:839`). A caller that passes a partial denylist (or none) silently gets `workspace-write`.
4. **`skills: []` does not give an empty skill set.** The SDK compiles ~16 first-party skills into its binary — hence denying the `Skill` TOOL when nothing is mounted, and hence `Skill` must LEAVE that list when skills ARE mounted.
5. **The CLAUDE.md ingress is closed by a FILE, not by an SDK option.** `managedSettings.claudeMdExcludes` is silently dropped (live-proven). `<workspace>/.claude/settings.json` is the whole mitigation, and `nativeSkillsForRun` is what makes it a precondition rather than a hope. Do not "simplify" the mount by dropping the settings write.
6. **Envelope-on-resume.** Every half of a run's policy must be re-passed on resume: `disallowedTools`, `skills`, `allowedTools`, `env`, `mcpServers`, `systemPrompt`, `outputSchema`, `effort` (`ResumeRunInput` :1120, `carryResumeOptions` :1179, `resolveResumeConfinement` `specialist-run.server.ts:2732`). `carryResumeOptions` copies only PRESENT keys — an explicit `undefined` changes behavior. **`attachmentsWritableDir` is NOT in that set** (see F32-R3).
7. **`capabilities: []` used to mean full power.** `GRANT_REQUIRED_CAPABILITY_IDS` + `deploymentGrants` + `withheldAgentGrants()` close it; hand-edited or imported `project.md` files are the remaining source.
8. **Absent-grant polarity is a three-way split — but it now lives in ONE table.** `absentPolarityGate` (`operator-actions.server.ts:466`) is consulted inside `gate()`, so a new consumer no longer re-breaks the four exceptions. The dedicated gates remain as named fronts.
9. **Both SDKs REPLACE the child env.** Passing `{...spec.env}` alone strips PATH/HOME.
10. **Reserved rows are interruptible before a process exists**, and **a reserved run holds a concurrency slot** — an interrupt on a reserved run must release it explicitly or the cap starves for up to the clone timeout.
11. **`GIT_CEILING_DIRECTORIES` equal to cwd is a no-op** — it must be a strict ancestor.
12. **A foreign model id does not error, it silently substitutes.** `foreignModelBackend` + the `run·model_substituted` line are the net. **New corollary (ruling 106)**: a picker must not rewrite a stored id that `claudeModelRunsVerbatim` accepts — that would be a silent model change, not a display fix.
13. **Effort scales differ** — Claude `low|medium|high|xhigh|max`, Codex `minimal|low|medium|high|xhigh`. Both adapters narrow rather than forward. The controller's stored `effort` parses TOLERANTLY (`agent-profile-file.server.ts:51`) because a strict key bricked the config.
14. **The Codex thrown error is only an exit banner.** The real reason arrives as a streamed `turn.failed` / `error` event.
15. **The Codex CLI merges `--config` per leaf key** — config alone can never close the host channels. And `skills.bundled = false` as a BARE BOOLEAN makes the CLI refuse its entire configuration.
16. **`getRunLog` mode selection is `limit`-sensitive, and its cursors are PAGE-LOCAL.** `backward = query.before !== undefined || query.limit !== undefined` (`run-service.server.ts:1664`) — so passing `limit` ALONGSIDE `since` silently flips a forward tail into a backward page. `viberr_ops.read_run_log` therefore calls `getRunLog(db, runId, { since })` with no `limit` and slices the ascending lines itself (`controller-ops-mcp.server.ts:270-272`). And `headSeq`/`oldestSeq`/`hasMore` (:1679-1684) are page-local console cursors, not facts about the run. `viberr_ops.read_run_log` bounds and re-derives both (`controller-ops-mcp.server.ts:262-284`); any new consumer must do the same.
17. **One workspace, many runs.** The checkout is per TASK; the skill strip is destructive; only the per-process `MOUNT_MARK` keeps a concurrent run's skills alive. Supporting runs of the SAME profile must be serialized.
18. **`agent_runs.kind = 'reviewer'` does not mean "a reviewer"** — it means "does not deliver".
19. **`actor.label` is an email, not a display name.** The cc-append and every @tag must use `userName(db, userId)`.
20. **The @mention fan-out must scan the PRE-TRIM text** (B-FD8b). `PreparedReply.mentionSourceText` (`task-actions.server.ts:1804-1809`) carries it; three call sites use it (:2106-2110, :2699-2701, :2967-2970), and the operator path scans its own original `text` (`operator-actions.server.ts:718`). A handle inside a fence that evidence-separation cut away must still notify.
21. **There is no operator-brevity cap any more** (ruling 104). `enforceOperatorBrevity` / `OPERATOR_BREVITY_MAX_CHARS` and the `brevity`/`brevityMax` inputs are DELETED (`comment-guardrails.server.ts:18-25, 73`). The one job the truncation did that had to survive is the fence balance, now owned by `withAmbiguityDisclosure` (`mention-notify.server.ts:201-206`). `CommentTrim` is now a single-member union (:73).
22. **A resource grant is a bare slug.** A hand-edit still orphans the grant, which is why the run DISCLOSES `unresolved` / `unhealthy`.
23. **Controller runs use `project_slug = ''` and `task_key = <conversationId>`** so no task-scoped query matches them, the SSE publishers early-return on them, and their logs authorize by conversation ownership.
24. **The run-concurrency cap is an instance SETTING, not an env var** — and default `0` means UNLIMITED.
25. **The controller's config sections are LOCKED by default and the only unlock value is the literal `enabled`.** A test or script that posts a non-empty grant list for a locked section gets a 403 naming the section; a blank list is the "keep" signal. Owner-declared narrow scope: the Agent-resources tab can still prune or re-content a controller grant.
26. **`discard_branch` authoring is now refused** on a task with a delivered revision or an occupied branch name (`operator-actions.server.ts:1023-1046`, guard at :1032); the branch-collision remedy is the new `resolve_remote_collision` option kind (`task-file.schema.ts:154-163`, resolver `task-actions.server.ts:6438-6459` + the three-step remedy at :6846-6907).

### Env vars this subsystem reads

**CHANGED (C3)**: every var below is now declared in `envSchema` (`app/server/config/env.server.ts:80-176`) and read through `getEnv()`. Pass-31 gotcha #22 is CLOSED.

| var | default | effect | declared |
| --- | --- | --- | --- |
| `VIBERR_DATA_ROOT` | `./data` | root for `runtimes/`, `state/`, `projects/` | :80 |
| `VIBERR_FORCE_DATA_ROOT_LOCK` | unset | take over a live-looking `writer.lock` | :87 |
| `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` | — | Claude credential | — (provider) |
| `VIBERR_CLAUDE_USE_CLI_AUTH` / `CLAUDE_CONFIG_DIR` | — | Claude CLI-auth opt-in / config dir | :122 |
| `CODEX_ACCESS_TOKEN` / `CODEX_API_KEY` / `OPENAI_API_KEY` | — | Codex credential | — (provider) |
| `VIBERR_CODEX_USE_CLI_AUTH` / `CODEX_HOME` | — | Codex cached-login opt-in / auth source | :137 |
| `VIBERR_CLAUDE_MAX_TURNS` | `2000` | Claude runaway turn cap | :160 |
| `VIBERR_CODEX_IDLE_TIMEOUT_MS` | `900000` | Codex idle watchdog | :161 |
| `VIBERR_CLAUDE_IDLE_TIMEOUT_MS` | `900000` | Claude idle watchdog | :162 |
| `VIBERR_GIT_CLONE_TIMEOUT_MS` | `900000` | clone ceiling; feeds `claimLeaseMs()` | :163 |
| `VIBERR_TRANSCRIPT_RETENTION_DAYS` | `30` | raw `.jsonl` pruning | :164 |
| `VIBERR_SESSION_HOME_RETENTION_DAYS` | `30` (`0` = forever) | provider session-home pruning | :165 |
| `VIBERR_BROWSER_EXECUTABLE` | set in the image | pinned chromium for the browser MCP | :96 |
| `VIBERR_UNLOCK_CONTROLLER_SKILLS` / `_KB` / `_MCPS` / `_INSTRUCTIONS` | unset (= locked) | ruling 108 per-section unlock; only `enabled` unlocks | :173-176 |

---

## Findings for the pass-32 ledger

Nothing below was fixed. Ordered roughly by consequence.

---

**F32-R1 — Stale doc comments across the runtime still describe the pre-parity (R22) world.** *(drift · MEDIUM · confidence HIGH)*

Ruling 101 changed behaviour in `resolveCodexSandboxMode`, but nine comment sites still assert the removed posture:

- `app/server/runtimes/adapter.server.ts:109-116` — `RunSpec.repoWriteWithheld`'s own docstring says "on Codex it is ADVISORY since R22 removed the read-only sandbox … **no runtime consumes this flag for enforcement anymore**". That is now flatly false: `resolveCodexSandboxMode` (`codex-runtime.server.ts:385`) is the flag's primary consumer. This is the field's canonical documentation.
- `app/server/runtimes/run-service.server.ts:589-591` (`repoWriteWithheldFromDenylist`) and `:836-838` (the spec assignment) — same claim.
- `app/server/tasks/specialist-run.server.ts:1258`, `:2380`, `:2468`, `:2685` — "supporting agents are read-only for the repo by policy (Claude-enforced, advisory on Codex since R22)". Both halves are now wrong: supporting posture is grants-derived, and Codex binds it.
- `app/server/runtimes/operator-run.server.ts:1097`, `:1876`, `:1925`, `:2807` — describe the Codex operator as `workspace-write` with a scratch-dir writable root. It is `read-only` now (`codex-runtime.server.ts:380`), which makes the whole pass-24 B-1 scratch-dir rationale moot (harmless, but the comment reads as live design).
- `app/shared/capabilities.ts:79` — "Agent repository/execution toggles (bind via the Claude tool denylist)" now understates `execute-code-or-write-repo`.

*Why it matters:* the next person to touch the sandbox will read `adapter.server.ts:109-116` and conclude the flag is decorative.

---

**F32-R2 — The evidence carve-out defeats repo-write parity for the DEFAULT withheld-agent shape, including the shipped Reviewer.** *(parity gap · HIGH · confidence HIGH)*

`resolveCodexSandboxMode` (`app/server/runtimes/codex-runtime.server.ts:385-387`) returns `workspace-write` — the FULL workspace, plus shell — for a write-withheld run whenever `spec.attachmentsWritableDir` is set. That flag is set iff `collab.evidence` (`app/server/tasks/specialist-run.server.ts:1873-1875`), i.e. an effective `attach-evidence-references` grant, whose catalog default is `direct` (`app/shared/capabilities.ts:142`), which `conservativeGrantsFor` does not withhold (:192) and which the seeded **Reviewer** grants explicitly (`app/server/seed/agent-catalog.server.ts:187`) while withholding `execute-code-or-write-repo`.

Net: on Claude that Reviewer cannot call `Edit`/`MultiEdit`/`Write`/`NotebookEdit`/`git commit` (`specialist-tool-policy.ts:77-80`); on Codex it gets a writable, shell-capable checkout. Ruling 101 discloses the carve-out but frames it as narrow ("its file-posting assignment"); in practice it is the default path, so `capabilityEnforcement("execute-code-or-write-repo") === "both"` (`capabilities.ts:258, 298`) overstates the Codex leg for the common profile. Containment that remains: P8 isolated checkout, no push credential, server-owned delivery, sha-bound verdicts.

*Why it matters:* the owner's stated requirement is parity; the matrix, the profile panel and the policy counts all now say "both backends" for the one capability where the shipped withheld profile diverges.

---

**F32-R3 — `attachmentsWritableDir` is not carried on resume, so a RESUMED evidence-granted Codex run loses the carve-out (and, when write-withheld, drops to `read-only`).** *(defect · HIGH · confidence HIGH)*

`ResumeRunInput` (`app/server/runtimes/run-service.server.ts:1120-1168`) has no `attachmentsWritableDir`, `carryResumeOptions` (:1179-1191) does not copy one, and `resumeRun` (:1215) does not recover it from the prior row. `ResumeConfinement` (`app/server/tasks/specialist-run.server.ts:2703-2720`) does not produce one either, and the @mention resume site (`app/server/tasks/task-actions.server.ts:1572-1597`) therefore never sets it.

Two consequences on the Codex leg:
- Pre-existing: a resumed evidence-granted run at `workspace-write` loses `additionalDirectories: [attachmentsDir]` (`codex-runtime.server.ts:765`), so it cannot copy files into `attachments/` — while its persona (rebuilt by `resolveResumeConfinement`, which DOES re-emit the browser/attachments sections) still tells it to.
- New under ruling 101: a **write-withheld** evidence-granted run resumes as `read-only` (`codex-runtime.server.ts:386`), reintroducing exactly the F22-03 defect the carve-out exists to prevent — on the @mention path, which is the most common way a reviewer is re-driven.

The class is the XS-1/F7 "resume drops half the run's policy" family that `carryResumeOptions` was built to close.

---

**F32-R4 — The supporting-run PROMPT still forbids what the parity ruling now permits.** *(prompt vs enforcement · MEDIUM · confidence HIGH)*

`app/server/tasks/specialist-run.server.ts:2479-2480` tells every non-delivering run: *"Do NOT create a branch, edit files, run `git commit`/`git push`, or open a PR — even if a directive says to."* Ruling 101(b) deliberately un-denied local edits and `git commit` for a supporting agent that HOLDS the write family (`claude-runtime.server.ts:259` narrowed to push/pr-create/pr-merge; `resolveCodexSandboxMode` gives it `workspace-write`). `resolveDeliveryPermissions` (`specialist-tool-policy.ts:192`) already computes the per-grant answer, and the prompt does not consult it on this branch.

This is XS-4 in mirror image: the prompt is now STRICTER than enforcement, which wastes the capability the ruling restored (a write-granted supporting agent will refuse to edit) rather than producing denied tool calls.

---

**F32-R5 — A grant naming a reserved MCP name is skipped SILENTLY, against the module's own doctrine.** *(honesty gap · LOW · confidence HIGH)*

`resolveSpecialistMcpServersDetailed` (`app/server/tasks/specialist-mcp.server.ts:175`) does `if (RESERVED_MCP_NAMES.has(name)) continue;` with no `unresolved` row — while every other drop in that function goes through `drop()` (:162), which exists precisely because "a declared MCP that resolves to nothing used to be dropped in silence". A profile (or the controller config) carrying a stale grant to `viberr_ops` / `viberr_browser` / `viberr_controller` — reachable via a hand-edited `project.md`, a pre-reservation row, or a restored backup — therefore shows the grant in the UI and gets no disclosure in the run's inputs.

The registry-unreadable arm at :138-146 filters reserved names out of its log/disclosure for the same reason, so the behaviour is at least consistent — but it is the silent-resource class this codebase keeps re-finding.

---

**F32-R6 — `SkillMount.settingsWritten` is written and never read.** *(dead code · LOW · confidence HIGH)*

`app/server/runtimes/skill-mount.server.ts:264` declares it, :308/:315/:372 populate it, and no non-test consumer exists (`grep settingsWritten` outside tests hits only its own module and a comment at `claude-runtime.server.ts:368`). Its own docstring frames it as "reported rather than left to a log line", and `claude-runtime.server.ts:360-368` names threading it into `buildSpecialistPersona` as the fix for the residual capability loss it documents. Today it is a field that costs a maintainer a lookup and buys nothing.

---

**F32-R7 — The Claude persona can announce native skills the adapter then refuses to enable.** *(documented residual · MEDIUM · confidence HIGH)*

`nativeSkillsForRun` (`app/server/runtimes/claude-runtime.server.ts:371-379`) returns `[]` when `ensureCatalogSettings(spec.workdir)` fails at adapter start. By then `buildSpecialistPersona` has already written the "Attached skills (trusted — installed in your workspace)" banner (`specialist-run.server.ts:2149-2165`) naming those skills, because the mount reported them as mounted. The run then carries `settingSources: []`, `Skill` denied, and a persona claiming otherwise.

The code states this trade honestly (:360-368) and chooses it over reopening the ingress — recorded here as a known divergence, and as the concrete consumer F32-R6 is waiting for.

---

**F32-R8 — `resolveCodexSandboxMode` treats `kind: "controller"` as a deliverer.** *(latent · LOW · confidence HIGH)*

`app/server/runtimes/codex-runtime.server.ts:396`: `const isDeliverer = spec.kind !== "reviewer";`. The old form excluded `"operator"` explicitly; the new form relies on the early return at :380. `"controller"` was never in either list, so a controller run reaching this adapter with `autonomous: true` and egress would get `danger-full-access`. Inert today — `runControllerTurn` refuses unless `isBackendAvailable("claude")` and hard-codes `backend: "claude"` (`controller-run.server.ts:206, 337`) — but it is a one-line change away from being live, and the comment above it enumerates only operators.

---

**F32-R9 — `ENFORCED_CAPABILITY_IDS` lists `execute-code-or-write-repo` twice.** *(cosmetic · LOW · confidence HIGH)*

`app/shared/capabilities.ts:227` and `:258`. It is a `Set`, so behaviour is unaffected; the duplicate is the seam of the ruling-101 edit and reads as an oversight to the next editor.

---

**F32-R10 — Two ops sweeps disagree about whose env they read.** *(inconsistency · LOW · confidence MEDIUM)*

`runMaintenancePass` now forwards `options.dataRoot` into `applyRetention` (`app/server/ops/maintenance.server.ts:150-156`) so ruling 102's audit export lands under the pass's root. But `transcriptRetentionDays()` / `sessionHomeRetentionDays()` (`app/server/ops/transcript-retention.server.ts:92-102`) read the process-wide validated env while `pruneRuntimeTranscripts` (:184) takes a `dataRoot`. That is coherent (window vs location), but the maintenance pass now mixes an injected root with process-global windows — worth pinning with a test before someone "harmonizes" it.

---

**F32-R11 — The dispatch-completion contract still degrades silently across a restart.** *(carried forward · MEDIUM · confidence HIGH)*

`dispatchedByName` / `dispatchedByUserId` live only in the in-process completion closure (`specialist-run.server.ts:2032-2039`); `recoverUnreactedAgentRuns` (`run-recovery.server.ts:218`) re-supplies `outcome_key` but has no channel for them. A run recovered after a crash therefore posts no cc line and falls back to the react heuristic — the dispatching human is never tagged, so never notified. Documented in code, unchanged this pass; recorded because `outcome_key` just got a durable column (`run-store.server.ts:46`) and the same shape would work here.

---

**F32-R12 — `viberr_ops.read_run_log` forward mode still issues an unbounded SELECT.** *(carried forward, bounded reply · LOW · confidence HIGH)*

`controller-ops-mcp.server.ts:270-272` calls `getRunLog(db, runId, { since })` and slices the result to `limit`. The REPLY is bounded (which is the property that matters for a model's context), but `listRunLines` (`run-store.server.ts:264`) has no SQL LIMIT, so a `since=0` call on a 50 000-line run materializes every row in memory first. The code says exactly this and names the fix (push a LIMIT into `listRunLines`), so it is a known, priced trade rather than an oversight — logged so a later pass with a big run does not rediscover it as a mystery.
