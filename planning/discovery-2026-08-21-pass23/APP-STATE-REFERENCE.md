# Viberr — Current-State Architecture Reference (pass 23, 2026-08-22)

Grounded in code on branch `claude/viberr-app-inspection-e1b87f`. Line numbers are anchors, not
contracts — re-grep the symbol if a file has moved. Written to answer "where is the seam?" fast
during implementation.

**Stack**: React Router v8 (framework mode, `app/routes.ts`), Node + `node:sqlite`. One
process per data root (writer lock, boot). ONE stylesheet (`app/app.css`, gated by
`app/app.css.test.ts`). Everything server-side lives in `app/server/**`; policy shared with the
client lives in `app/shared/**`; page composition in `app/features/**` + `app/routes/**`;
zod file formats in `app/schemas/*.schema.ts`.

**The core inversion to keep in mind**: `task.md` / `project.md` files under the data root are
CANONICAL; `state/projection.sqlite` is a DERIVED projection (plus a set of app-owned tables that
are NOT derived — auth, PATs, runs, notifications, audit). Agents (Claude/Codex) are spawned
server-side per run with capability-derived confinement; GitHub delivery (push / PR / merge) is
always executed by the SERVER, never by an agent's own credentials.

---

## 0. Orientation map

| Layer | Where |
|---|---|
| File-native store (canonical) | `app/server/files/*` — paths in `file-store-root.server.ts` |
| Projection (derived sqlite) | `app/server/projections/*`, schema `db/migrations/0001_baseline.sql` |
| Operator runtime | `app/server/runtimes/operator-run.server.ts` + `app/server/tasks/operator-actions.server.ts` + `operator-toolkit.server.ts` |
| Specialist runs | `app/server/tasks/specialist-run.server.ts` + `specialist-tool-policy.ts` + `specialist-mcp.server.ts` + `specialist-browser-mcp.server.ts` + `agent-toolkit.server.ts` |
| Backend adapters | `app/server/runtimes/{claude,codex}-runtime.server.ts`, `runtime-registry.server.ts`, `run-service.server.ts`, `adapter.server.ts` |
| Capability model | `app/shared/capabilities.ts` (catalog + polarity + couplings), enforcement split above |
| GitHub | `app/server/github/*` — context, sealed PAT, delivery, reconcile, github_read |
| RBAC / visibility | `app/shared/rbac.ts`, `app/routes/project-visibility.server.ts`, `app/server/auth/project-authority.server.ts` |
| Comments / mentions / notifications | `app/server/tasks/task-actions.server.ts` (commentToAgent), `agent-reply.server.ts`, `mention-notify.server.ts`, `app/server/projections/notifications.server.ts` |
| Org resources (KB/MCP/skills) | `app/server/org/resources.server.ts`, `app/server/files/kb-injection.server.ts`, `app/server/runtimes/skill-mount.server.ts` |
| Agent profiles UI | `app/features/agents/*` (create-profile-modal.tsx, capability-catalog.ts, agents-query.server.ts) |
| Boot wiring | `app/server/boot.server.ts` `bootServer()` :491 |

Routes (`app/routes.ts`): `/` home · `/login` · `/api/auth/*` (better-auth splat) ·
palette-shell layout (`/org/settings`, `/profile`, `/notifications`) · resource routes
(`/resources/events` SSE, `run-log`, `health`, `search`, `model-catalog`, `session-export`) ·
`/projects/:slug/tasks/:key/attachments/:file` (member-only bytes) ·
`/projects/:slug` workspace layout → `board|review|agents|policy|github|activity|settings|tasks/:key`.

Boot order (`bootServer` :491): crash handlers → `ensureDataRootDirs` → **data-root writer lock**
(`takeDataRootWriterLock` :459, F20-8 fail-closed guard `startDataRootLockGuard`) → seed default
agent assets → self-heal corrupt projection DB (`db/self-heal.server.ts`) → `getDb()` → seed admin
→ SSE publisher → boot **rescan** (offline drift) → `ensureBaseAgentsDeployed` → file watcher →
KB watcher → `finalizeOrphanedRuns` → store maintenance/retention → `reconcileRestartedWork` →
schedule runner → GitHub reconcile poller (5 min) → `logBootIntegrity`.

---

## 1. File-native store + projection rebuild

### Canonical layout (`app/server/files/file-store-root.server.ts` :8-40)

```
${VIBERR_DATA_ROOT}/
  projects/<slug>/project.md              # governance: stages, workflow, members, agents+grants, repo
  projects/<slug>/tasks/<KEY>/task.md     # frontmatter + goal + timeline + packet + verdicts
  projects/<slug>/tasks/<KEY>/attachments/  # browser screenshots etc (R19-19), served member-only
  projects/<slug>/tasks/<KEY>/workspace/<repoName>/  # the per-TASK git clone (shared by all engagements)
  agents/profiles/<id>.md                 # org-level agent profile templates
  runtimes/                               # NDJSON run logs; claude-home/, codex-home/ (CLI auth)
  kb/<dir>/                               # knowledge bases;  skills/<name>/SKILL.md
  state/projection.sqlite                 # DERIVED + app-owned tables
```

### Read/write API

- Task: `task-writer.server.ts` — `readTaskFile` :47, `updateTaskFile` :165 (mutator callback under
  the per-file mutex, atomic tmp+rename via `atomic-file.server.ts`), `createTaskFile` :190,
  `appendTimelineEvent` :225, `patchTaskFrontmatter` :237. `taskFileWriteBlockers` :138 refuses
  writes on archived-readonly etc.
- Parse/serialize: `task-file.server.ts` — `parseTaskFileContent` :378 (tolerant; junk degrades to
  diagnostics, never throws), `serializeTaskFile` :509. Shapes in
  `app/schemas/task-file.schema.ts`: frontmatter (stage, waiting `human|agent|none`, readiness,
  validation `healthy|changed|failing|none|bypassed`, `engagements[]` (one `delivers: true`),
  `branch`, `pr` (PrRef + cached checks/reviews), `workRevision` (+`kind: "verified"` for
  no-change), `verdicts`, `schedule`, `packet` (TaskPacket), timeline events with typed
  `type`/actor/evidence rows. `PACKET_OPTION_KINDS` :74 — 10 kinds incl. `retry_other_backend`,
  `edit_goal`, `archive_task`(+`deleteBranch`), `discard_branch`, `custom`.
- Project: `project-writer.server.ts` — `readProjectFile` :39, `updateProjectFile` :100,
  `createProjectFile` :120, `allocateTaskKey` :166. Shapes in `project-file.schema.ts`: stages,
  `workflow[]` boundaries (`auto|approval|human`), members (4 roles), `agents[]` deployments each
  with `capabilities: CapabilityGrant[]` (`{capabilityId, mode: direct|recommend|human|off}`),
  repo + defaultBranch, credentialPolicy, guardrails.
- Concurrency: `file-mutex.server.ts` (per-path async mutex) + atomic replace. All writers then
  call `reproject`/`rebuildPath` explicitly — the watcher is the backstop, not the primary path.

### Projection rebuild (`app/server/projections/`)

- `rebuilder.server.ts` — the projector: `rebuildProjectFile` :150 (projects + project_members),
  `rebuildTaskFile` :348 (task_projections incl. `packet_json` col, task_events, diagnostics,
  acceptance-block reason), `rebuildPath` :669 (path→kind dispatch, the per-file entry every
  mutation calls), `rebuildProject` :709, `rebuildAll` :793. Content-hash short-circuit: unchanged
  files are skipped unless `force`.
- `rebuild.server.ts` `rebuildProjections` :35 — the recovery hammer: transactionally DELETEs all
  file-derived rows (task_events, diagnostics, task_projections, projects+members cascade) and
  re-projects; SSE events buffered via `collectProjectionEvents` and emitted post-commit. NOT
  dropped (app-owned truth): users/sessions (better-auth tables), notifications, audit_events,
  provenance, github_pats/project_github_credentials/scope_violations, agent_runs/run_log_lines,
  org_* resources, model_availability, staged_outcomes.
- `rescan.server.ts` :15/:38 — hash-reconcile only drifted files (boot + the Settings "Re-scan"
  action). Throttled by `single-flight.server.ts` (RESCAN 10s / REBUILD 30s min interval).
- Watcher: `files/file-watch.service.server.ts` — chokidar on the projects tree, 250 ms debounce
  (:33), `startFileWatcher` :132; KB watcher `kb-watch.service.server.ts` re-indexes "on change"
  KBs. HMR-safe process-global handles via `Symbol.for` keys (a pattern reused everywhere:
  operator lease, run service, pollers).
- Derived-read modules over the projection: `board-query.server.ts` (`getProject`), `task-query`,
  `task-activity`, `activity-feed`, `review-queue`, `decisions`, `notifications`,
  `agent-deployments`, `policy-violations`.

**Where to change**: new frontmatter field → schema in `app/schemas/task-file.schema.ts` +
serializer key order (`TASK_FRONTMATTER_KEYS` :834) + projector column in `rebuildTaskFile` + a
baseline column (`db/migrations/0001_baseline.sql` — migrations stay squashed into 0001 pre-prod,
ruling P11; boot warns on missing columns via `projectionMissingColumns` boot.server :193).

---

## 2. Operator runtime (`app/server/runtimes/operator-run.server.ts`)

One managed coordinator per task. Entry: `runOperator(db, input)` :995.

### Triggers (`RunOperatorInput.trigger` :157)
`create | transition | agent-reply | goal-updated | pr-diverged | delivered | packet-resolved |
scheduled | manual`. Semantics documented :138-156: coordinate → react → re-check → recover →
proceed. Extra payloads: `resolvedOption` (packet-resolved), `scheduleNote`, `humanComment`/
`humanCommentBy` (@operator comments), `agentReply` (full report), `reactDepth` /
`transitionDepth` (loop bounds; `OPERATOR_TRANSITION_CHAIN_CAP = 8` in task-actions :176).

### Fire-time refusals (`RunOperatorResult.refused` :234)
- `terminal-stage` :1031 — a `scheduled` trigger never fires on the terminal stage (FR39/F19-20);
  settles the waiting flag honestly.
- `open-packet` :1070 — a HUMAN `manual` "Run operator" while a decision packet is open is refused
  (R20-1/F20-5); machine triggers still run (pr-diverged withdraws moot packets, agent-reply reacts).

### Single-flight lease + coalescing (:278-501)
Process-global lease keyed `slug/taskKey` (`Symbol.for("viberr.operatorLease")`), held from
`runOperator` entry through provider completion AND Codex plan execution. Concurrent triggers are
QUEUED (`queueOperatorTrigger` :379): machine triggers newest-wins; human `@operator` comments are
a bounded FIFO (max 8), same-author consecutive comments merged, drained oldest-first ahead of the
machine trigger. Release (`releaseOperatorLease` :438) is idempotent per lease-token object; a
cross-boot in-flight DB row chains `drainPendingAfterInFlight` :476 via `chainRunCompletion`;
restart-orphan rows (created before `PROCESS_START_MS` :244) are finalized as `error` and driven
over (:1115). Stranded-task backstop: `operatorLeftTaskStranded` :513 +
`maybeResumeStrandedOperator` :536 re-invoke on an auto boundary left with no packet/recommendation.

### Run preparation
`markWaitingAgent` at drive start; run row reserved BEFORE the clone when one is pending
(`pendingOperatorClone` :867, `reserveRun` — R21-4 live-strip honesty);
`ensureOperatorRepoCheckout` :891 clones the SAME per-task workspace checkout the specialist uses
(mirror-cache via `repo-mirror.server.ts`), strips repo `.claude`, never throws (→ `unavailable`
arm with redacted git stderr). Operator confinement: `OPERATOR_READ_ONLY_DENIED_TOOLS`
(re-exported :982 from claude-runtime :200 — Bash/Edit/MultiEdit/Write/NotebookEdit; Read/Grep/
Glob survive) + WebFetch/WebSearch when `use-web-search-fetch` is withheld
(`operatorDisallowedTools` :985).

### Two execution shapes
- **Claude** (`startRealOperatorRun` :2141): real tool-driven run — the `mcp__viberr__*` in-process
  governance toolkit (`operator-toolkit.server.ts` `buildOperatorToolkit` :243) wraps the gated
  actions in `operator-actions.server.ts`. System prompt: `buildOperatorSystemPrompt` :2526
  (persona `readOperatorDefinition` :2363 / fallback :2360 + skill + KB injection + workspace
  section + policy scope note); turn prompt `buildOperatorTurnPrompt` :3069 with per-trigger
  doctrine `operatorTurnDoctrine` :2853.
- **Codex** (`startCodexOperatorRun` :1558): STRUCTURED-PLAN run — `buildOperatorPlanSchema` :1346
  constrains the reply; `executeCodexPlan` :1752 executes the plan through the SAME gated
  operator-actions; refused steps are narrated visibly (`narrateRefusedActions` :2039); a no-plan
  reply writes an honest note (`writeOperatorNoPlanNote` :2105). Plan tool list is
  capability-filtered per authority (`operatorPlanToolsFor` :1313, mapping
  `OPERATOR_PLAN_TOOL_CAPABILITIES` :1287) — mirrors the Claude toolkit's build-gating.
- Failure escalates a blocked recovery packet (`escalateFailedOperatorRun` :2276) and marks model
  availability (`model-availability.server.ts`).

### Authority + gating (`app/server/tasks/operator-actions.server.ts`)
`resolveOperatorAuthority` :353 resolves the project's operator deployment → `OperatorAuthority`
:106 (policy Map, autonomy CLAMPED to the configured ceiling — R19-A `clampAutonomy` :227 with
audit when launching), backend, model/effort, skills/kb/mcps, persona override, `deployed`,
`humanGatedBeforeWork`. `gate(authority, capId)` :446 → `direct|recommend|deny`; full autonomy
promotes recommend→direct EXCEPT `completion-for-acceptance` (explicit-direct-only, owner Q1).
`deliverGate` :476 and `updateBranchGate` (update-branch-operator.server.ts :76) carry the
absent-means-derived polarity via `absentDeliverReviewPrMode` (capabilities.ts :602); undeployed
operator ⇒ deny everything.

Gated actions (all return `OperatorActionResult` `done|recommended|denied|noop`):
`operatorPostComment` :1663, `operatorSetGoal` :1770, `operatorEngageAgent` :2309 /
`operatorRunAgent` :2357 / `operatorPromptAgentGeneric` :2412 (engagement machinery),
`operatorTransitionStage` :2575, `operatorDeliverForReview` :2481 (→ `performDelivery` with
`ctx.operatorAuthorized: true`), `operatorUpdateBranchFromBase` (github/update-branch-operator
:161), `operatorAcceptCompletion` :2764, `operatorOpenPacket` :876, `operatorResolvePacket` :1057,
`operatorSnapshot` :1497 (the get_task view).

**Where to change**: a new operator power = (1) catalog entry in `shared/capabilities.ts`,
(2) gated action in `operator-actions.server.ts`, (3) Claude tool in `operator-toolkit.server.ts`
`buildOperatorToolkit`, (4) Codex plan tool + capability mapping in `operator-run.server.ts`
(:1250/:1287) + executor arm in `executeCodexPlan`, (5) doctrine text if turn-shaping matters.

---

## 3. Specialist / agent runs (`app/server/tasks/specialist-run.server.ts`)

All non-operator agents are ONE uniform machinery (generic-agents): `engagements[]` on task.md,
exactly one `delivers: true` (the deliverer, thread `primary-*`), others supporting
(`r<i>-*`, reviewer kind). Entry points: `assignSpecialist` :667, `assignReviewer` :826,
`removeReviewer` :958, `startAgentRun` :1053 → `dispatchAgentRun` :1070 (the canonical pipeline,
used by the UI Run button, operator prompt, and @mention fresh-run path).

### dispatchAgentRun pipeline (fresh run)
1. Engagement lookup; delivering single-flight (409 if a `primary` run is queued/running :1108).
2. Resolve the LIVE deployment (`resolveDeployedSpecialist` :304 → `effectiveProfileView`,
   agents-query.server :274); backend = `input.backendOverride ?? live ?? engagement snapshot`
   :1143 (D4 cross-backend retry); model/effort re-resolved for a switched backend
   (`model-catalog.server.ts` `resolveRunModel`/`resolveRunEffort`).
3. Confinement: `disallowedTools = resolveSpecialistDisallowedTools(capabilities)` :1173;
   an UNRESOLVABLE profile takes `resolveUndeployedDisallowedTools()` (fully withheld, P14-RT-01).
   Empty grant list ⇒ `withheldAgentGrants()` (deploymentGrants :242, P13-AP-06).
4. Stage eligibility re-checked at run boundary (`assertStageEligible` :1191, F1).
5. Reviewer KB inheritance: non-delivering runs union the DELIVERER's KB grants (KBs ONLY, never
   skills — R18-1/R19-3, `deliveringContextGrants` :354).
6. MCP resolution `mcpServersFor` :1227 (see §MCP below) BEFORE persona (honest prompt).
7. Collab gates `resolveAgentCollab(grants)` (agent-outcome :407) → `{comment, ask, verdict,
   evidence, githubRead}`; `outcomeKey` staged-envelope key minted :1251.
8. Run row RESERVED before the clone (`reserveRun`, phase `preparing`/`Cloning …` :1284);
   `cloneRepo` :2746 into `tasks/<KEY>/workspace/<repo>` via the project mirror; interrupt
   honored mid-clone (`assertRunReservationLive` :1327).
9. Skill mount (Claude only): `mountGrantedSkills` (runtimes/skill-mount.server.ts) — strips the
   repo's own `.claude` (R18-3) then writes granted skills as `.claude/skills/<name>/`; surgical
   per-process `MOUNT_MARK` (F19-15) protects concurrent runs' mounts.
10. Browser mount `resolveBrowserMcp` :1367 (see §4/browser); attachments dir pre-created for
    evidence-granted runs.
11. Persona `buildSpecialistPersona` :1884 built from what ACTUALLY mounted (skills/KB/MCP/browser/
    github_read sections appear iff mounted — XS-4 prompt=enforcement); unresolved resources
    collected for run-input disclosure. Prompt `buildAnalyzePrompt` :2157 + delivery permissions
    (`resolveDeliveryPermissions`) + canonical task anchor (`freshRunAnchor` :444, P19-G0)
    + reviewer's pinned `reviewSubject` (PR head sha, F15-15) + clone-failure honesty (also a
    system timeline note :1494).
12. Collaboration transports :1524-1623: Claude → in-process `viberr_agent` toolkit
    (agent-toolkit.server.ts `buildAgentToolkit` :252: `post_comment` :258, `ask_human` :285,
    `report_outcome` :350 — mounts for verdict OR evidence, verdict field only when granted,
    `github_read` :453); Codex → `AGENT_OUTCOME_JSON_SCHEMA` outputSchema on the final reply when
    verdict/ask/evidence granted. MCP precedence: org grants < browser < toolkit (:1612-1614).
13. `startRun` (run-service :574) adopts the reservation; `recordRunInputs` :1676 persists the
    full input disclosure (P19-G8/G11); timeline "Started a … run" event; audit
    `task.agent.run_started`; `registerAgentCompletion` :1809 wires the ONE completion handler.
14. Env: `workspaceRunEnv` (GIT_CEILING confinement) + `agentGitIdentity(profileId)` :2703
    (uniform commit author). The clone remote is SANITIZED (no credential;
    `githubRemoteSanitizationArgs` in git-clone-auth.server.ts) — agents commit locally, the
    SERVER pushes.

### Resume path (@mention / packet answer)
`resolveResumeConfinement` :2429 re-derives denylist/env/MCP/persona for a resumed provider
session (XS-1 — a resumed run is as confined as a fresh one); `resumeRun` (run-service :1030);
`resumeWorkdir` (agent-reply :639).

### Completion pipeline (task-actions.server.ts)
`registerAgentCompletion` :2396 → on run finish `recordAgentCompletion` :2019 /
`applyAgentCompletionEffects` :2452: post the agent's reply comment (`postAgentReplyComment`
:1586, dedup + run-scoped F22-12), resolve ONE outcome envelope (staged `takeStagedOutcome` first,
then parsed Codex reply `parseAgentOutcomeJson`), gate verdict/question/evidence on the
engage-time grants (server-side — this is why ask/verdict/evidence bind on BOTH backends),
reconcile delivery for the deliverer (`reconcileWorkspaceDelivery`,
github/workspace-delivery.server.ts :231 — reads the workspace git/gh facts into
frontmatter/workRevision), attach files that landed in `attachments/`, verdict fallback prose
classifier `classifyReviewerVerdict` :1919 (only for verdict-GRANTED agents), stuck-loop packet
:1757, then re-invoke the operator to REACT (`ctx.operatorRun` chain, depth-capped). Failure
classification for the human: `runFailureReason` (agent-reply :572; provider text via
`PROVIDER_TEXT_MARKER`).

### Backend adapters (`app/server/runtimes/`)
- Portable `RunSpec` (adapter.server.ts :50) — prompt/systemPrompt/model/effort/workdir/env/
  disallowedTools/mcpServers/skills/outputSchema/attachmentsWritableDir/kind/autonomous…
- **Claude** (`claude-runtime.server.ts` `createClaudeAdapter` :543): Claude Agent SDK `query()`;
  deny rules bind under `bypassPermissions`. Layered denylists: `BASE_DENIED_BUILTINS` :264 for
  EVERY run (Skill w/o mounts, Task* family, Workflow, Cron*, notifications, worktrees),
  `SUPPORTING_DENIED_BUILTINS` :223 for reviewer-kind runs (file writes + git/gh mutation),
  operator list :200. `MANAGED_SETTINGS.claudeMdExcludes` :332 blocks repo CLAUDE.md ingestion.
  Skills via native `skills: [...]` filter (`nativeSkillNames` :311). In-process MCP servers OK,
  credentials OK (headers/env).
- **Codex** (`codex-runtime.server.ts` `createCodexAdapter` :532): Codex SDK threads; persona via
  `developer_instructions`; MCP translated to `mcp_servers` config with **credentials dropped**
  (argv exposure — F7-MCP1); `project_doc_max_bytes: 0`. Sandbox (R22, :368): NO read-only mode
  anymore — "viberr is the sandbox"; fully-autonomous delivering run w/ egress →
  `danger-full-access`, everything else `workspace-write` with `networkAccessEnabled`/
  `webSearchMode` gating egress (the one Codex-enforced capability). Idle timeout 15 min both
  backends.
- `runtime-registry.server.ts`: `RealBackend` :42, availability probes (CLI auth diagnostics
  :137/:234, `isBackendAvailable` :309), spawn env scrubbing (`CREDENTIAL_ENV_RE` :453,
  `codexSpawnEnv`/`claudeSpawnEnv`).
- `run-service.server.ts`: `reserveRun` :362 / `startRun` :574 / `resumeRun` :1030, completion
  callbacks (`registerRunCompletion` :161, `chainRunCompletion` :178), denylist-derived facts
  (`repoWriteWithheldFromDenylist` :475, webSearchWithheld :489) threaded into the spec.
  `run-store.server.ts` (agent_runs + run_log_lines), `run-sink` (line redaction),
  `run-events` (SSE), `run-recovery` (`finalizeOrphanedRuns`), `session-export`.

**Where to change**: run-time behavior for agents → dispatchAgentRun (fresh) AND
`resolveResumeConfinement` (resume) — the recurring bug class is fixing one path only.

---

## 4. Capability model

### Catalog (`app/shared/capabilities.ts`)
`UNIFIED_CAP_CATALOG` :33 — one list, each entry `{id, label, kinds: operator|agent, group
(null=matrix-only), defaultMode, promotable}`. Operator caps: assign-primary-specialist,
summon-reviewers, generate-packets, append-typed-events, stage-transitions(recommend),
completion-for-acceptance(recommend, non-promotable), deliver-review-pr, update-task-branch.
Agent caps: execute-code-or-write-repo + the scoped delivery trio (create-task-branch,
commit-push-branch, open-review-pr), comment-on-task, ask-human, use-web-search-fetch (also
operator), use-browser(off), read-github-api(off, non-promotable), report-validation-verdict(off),
attach-evidence-references; matrix-only advisory persona rows; ALWAYS_HUMAN trio
(merge-pull-request, transition-to-done, change-project-policy) :211.

### Polarity & derived sets
- `GRANT_REQUIRED_CAPABILITY_IDS` :393 — absence = WITHHELD (repo-write family + merge + verdict);
  everything else keeps its catalog default when absent (notably web egress = on).
- `SCOPED_DELIVERY_CAPABILITY_IDS` :371 gated under the `execute-code-or-write-repo` headline.
- `VERDICT_OUTCOME_CAPABILITY_IDS` :304 + `applyVerdictOutcomeGate` :325 — approve/request-changes
  render as granted only when the verdict cap is explicitly `direct`.
- `coerceSpecialistCapabilityMode` :362 — a specialist `recommend` normalizes DOWN to `off`
  (F20-21; never widen to direct).
- Save-layer couplings `applyGrantCouplings` :560: `repairDeliveryGrants` :449 (materialize an
  ABSENT headline when scoped grants are actionable; an explicit `off` stands + notice) and
  `repairBrowserEgressGrants` :525 (browser `direct` ⇒ egress `direct` — the mount refuses the
  contradictory pair anyway).
- `defaultGrantsFor` :165 (explicit grants at creation — `capabilities: []` is never written) /
  `conservativeGrantsFor` :192 (org-template editor: delivery + verdict outcomes start withheld).

### Enforcement honesty (`capabilityEnforcement` :288)
- `ENFORCED_CAPABILITY_IDS` :223 — binds on BOTH backends: the operator caps (toolkit/plan-schema
  gating + server action gates), server-owned delivery gates, completion-pipeline gates
  (verdict/ask/evidence), web egress (Claude tool-deny + Codex webSearchMode), use-browser
  (mount-or-not on both).
- `CLAUDE_ONLY_ENFORCED_CAPABILITY_IDS` :270 — since R22 the whole repo-write family is
  Claude-only (tool denylist); on Codex advisory + the server-owned delivery gate. Also
  comment-on-task and read-github-api (in-process Claude tools; a Codex mount would leak the
  credential into `--config` argv).
- Everything else: advisory persona text.

### Runtime consumption
- Tool layer: `specialist-tool-policy.ts` — `CAP_DENY_RULES` :49 map caps → deny specifiers
  (git checkout -b/-B, switch -c/-C; git push/commit; gh pr create/merge;
  Edit/MultiEdit/Write/NotebookEdit+git commit for the headline; WebFetch/WebSearch for egress).
  `grantModes` :119 (repairs ONLY an absent headline), `isWithheld` :131,
  `resolveSpecialistDisallowedTools` :145, `resolveUndeployedDisallowedTools` :170,
  `resolveDeliveryPermissions` :188 (prompt-side mirror — prompt and denylist must agree, XS-4).
- Collab layer: `agent-outcome.server.ts` `effectiveCollabMode` :381 (explicit grant wins;
  `recommend` falls to the catalog default; NO implicit reviewer-verdict rule — F10-14),
  `resolveAgentCollab` :407. Envelope: `AGENT_OUTCOME_JSON_SCHEMA` :68 (OpenAI-strict),
  `parseAgentOutcomeJson` :195 (tolerant per-field), staging map + `staged_outcomes` table
  (:254-340, restart-safe).
- Server delivery gate: `resolveDeliveryPushGrant` (task-actions :3672) — the deliverer's
  `canCommitPush` consulted by `performDelivery` regardless of backend.
- Editor mirror: `app/features/agents/capability-catalog.ts` (modal groups seeded from the SAME
  catalog + `GRANT_REQUIRED` polarity; `withheldAgentGrants` :89), matrix modal
  `capability-matrix-modal.tsx`, enforcement badges from `capabilityEnforcement`.

**Where to change**: adding a capability = catalog entry + (if enforced) a consumer in
tool-policy / collab gates / operator gates + enforcement-set membership + editor group. The
seeded operator's grants are spelled as LABELS in `app/server/seed/agent-catalog.server.ts`
(resolved via `capabilityByLabel` — drifting a label silently degrades the grant; pinned by
`agents-route.server.test.ts`).

---

## 5. GitHub integration (`app/server/github/`)

### Context + credentials
- `github-context.server.ts` `getProjectGithubContext` :47 — the ONE resolver: projection `projects`
  row (repo, default_branch) + `getProjectCredential`/`getPatToken` → token-injected client, or
  typed `no_repo_configured` / `no_pat_configured`.
- Sealed PAT: `app/server/secrets/pat-store.server.ts` — tokens sealed via `secret-box.server.ts`
  (AES, key rotation in `key-rotation.server.ts`), `createPat` :97, `getPatToken` :208 (the only
  decrypt), project binding `setProjectCredential` :257, health chips
  `getProjectCredentialHealth` :410. Scopes: repo + pull_request:write. Git subprocess output is
  ALWAYS redacted (`secrets/git-output-redact.server.ts`, any-length creds F20-7).
- Client: `github-client.server.ts` `createGithubClient` :212 — typed `request(method, path,
  zodSchema)` with rate-limit info, 20 s timeout, failure messages; `GITHUB_API_BASE` :24.

### Server-owned delivery (agents never push)
- `performDelivery` (task-actions :3814) — THE delivery core behind the operator's
  `deliver_for_review`, the applied `delivery` recommendation, and the task page's manual button
  (`manualDeliverForReview` :4268): (1) `pushWorkspaceBranch` (push-workspace.server.ts :474 —
  pushes the per-task workspace clone's branch with the PAT, honoring the deliverer's
  `canCommitPush` grant; non-fast-forward → `push_conflict`, never a PR over stale remote), (2)
  re-reconcile the work revision, (3) `openTaskPr` (pr-open.server.ts :315 — compose body with
  evidence lines + stats-from-compare F22-10, reuse an open PR by head-sha adoption rules
  `pr-adoption.server.ts` :52). Typed `DeliveryOutcome` :3783 (delivered / push_conflict /
  grant_withheld / push_failed / nothing_to_review / failed); every failure surfaces a timeline
  event. No-change path: `resolveNoChangeBaseRevision` :3727 mints a `kind: "verified"` revision
  from the default branch so the ORDINARY review ceremony runs (F19-21);
  `no-change-completion.server.ts` renders "Completed — no changes".
- Branch mechanics: `branch-sync.server.ts` (`taskBranchName` :45 `viberr/<KEY>`,
  `ensureTaskBranch` :250, compare/sync state), `update-branch.server.ts` +
  `update-branch-operator.server.ts` (N19-9 server-owned merge-from-base; conflict → packet),
  `branch-cleanup.server.ts` (archive `deleteBranch`), `push-workspace.server.ts`
  `discardLocalTaskBranch` :790 (the discard_branch packet kind).
- Merge: human-only. `resolvePacket`/`acceptCompletion` → `attemptAcceptanceMerge` :4535 /
  `completeTaskMerge` :7037; human GitHub approvals read via `pr-human-approval.server.ts`
  (a human PR approval counts as a verdict — R19-B).

### Reconcile
- `github-reconciler.server.ts` `reconcileTask` :826 (per-task promise QUEUE :261 — F19-19, no
  coalescing) → typed `TaskReconcileResult` :197; detects out-of-band PR merge/close/reopen and
  wakes the operator with trigger `pr-diverged` (:90, :756); scope violations recorded
  (`scope-flag.server.ts`, scope_violations table). Project sweep concurrency 4, poll budget 20.
- `reconcile-poller.server.ts` — boot + every 5 min (:22), plus merge-pending nudges; manual
  "Update status" button hits the same path (RBAC `reconcile-github`).

### Agent read access (F4)
`agent-github-read.server.ts` — `github_read` tool backend: `scopeAgentGithubReadPath` :61 forces
every request under `/repos/{owner}/{name}` of the task's project, rejects full URLs, backslashes,
`%2e`, and re-verifies the WHATWG-NORMALIZED path (the parser the client uses) — GET only.
`runAgentGithubRead` :161 resolves context in-process (PAT never crosses to the agent).
Claude-only mount (`githubReadForRun` specialist-run :1825); persona section :201; audited per
call (`task.agent.github_read`, agent-toolkit :469).

---

## 6. RBAC + project visibility

- `app/shared/rbac.ts` — THE source: `RBAC_DEFINITIONS` :61, 18 actions × 4 monotonic roles
  (viewer ⊂ contributor ⊂ maintainer ⊂ admin). Tail actions admin-only:
  release-any-ownership, manage-members, manage-agents, edit-policy, force-accept-completion
  (DG-2 audited escape hatch). `roleCan` :99 / `rolesForAction` :105. The Policy page renders the
  SAME object (display = enforcement).
- Org layer: 2 org roles (org admin overrides project membership as the audited D2 override) —
  `app/server/auth/project-authority.server.ts` (`assertProjectAction`, denial audit rows
  P13-D-8), `require-user.server.ts`, `user-admin.server.ts`.
- Membership as the OUTER gate (R15-4): reads — the workspace layout loader
  (`routes/project.tsx`) 404s non-members with the byte-identical unknown-slug message; actions —
  `requireVisibleProject` (`routes/project-visibility.server.ts` :28) because RR runs child
  actions without parent loaders; it re-throws AppError as the same 404 (never a 403 that would
  confirm existence). `view`/`comment` are role-free INSIDE membership.
- Task-action guards: `requireAction` (task-actions :278) + specialization
  (`requireAcceptCompletion` :310, `requireDecisionAuthority` :334); runtime-role gate for agent
  runs `requireRunAgents` (project-authority) — admin|maintainer.
- Auth: better-auth is the sole system (`/api/auth/*` splat allow-list, `app/lib/auth.server.ts`);
  local-first login when OAuth off (R17-4); CSRF `_csrf` on every form (`auth/csrf.server.ts`).

---

## 7. Comments, @mention routing, notifications

- `appendComment` (task-actions :756) — the plain writer: timeline event + mention fan-out +
  ambiguity disclosure.
- `commentToAgent` :1033 — the routed path (every task-page comment goes through it):
  `resolveMentionedAgent` (agent-reply :285) resolves `@operator`, backend handles
  (`@claude`/`@codex` — refused with a named-candidates note when ambiguous, B-AG2 :1067),
  role/name handles per deployed specialist (`agentMentionHandle` :87; reserved handles :99).
  Then: lower-than-maintainer → comment recorded, run skipped (`runtimeDenied`); `@operator` →
  `runOperator(trigger: manual, humanComment)` :1132; specialist with a live session → RESUME with
  `specialistReplyDirective` :996 + canonical anchor (P13-D-3) under `resolveResumeConfinement`;
  no session → fresh `startAgentRun` with the comment as directive.
- Agent replies: completion pipeline `postAgentReplyComment` :1586 (dedup run-scoped +
  evidence-aware F22-12; agents must @tag the human they answer — NEW-4, `withMention` :3115);
  reply text extraction `agent-reply.server.ts` `extractReplyText`/`fullReplyTextForRun`
  (:447-520, workspace-path normalization).
- Mentions → notifications: `mention-notify.server.ts` — `MENTION_RE` :44, `RESERVED_HANDLES` :47,
  `resolveMentionTargets` :91 (name/first-name/email-local keys; ambiguity judged over ALL enabled
  users), `fanOutMentions` :216 → `createNotification` (projections/notifications.server.ts,
  category prefs respected), `notifyMentionedUsers` :248 wired into EVERY comment writer (human,
  operator `writeOperatorComment`, agent replies). Watchers: `notifyTaskWatchers` for packets/
  completions. UI: `/notifications` + `features/notifications`; SSE `resources/events` drives
  revalidation (`events/sse-broker.server.ts`).

---

## 8. Org resources: KB / MCP / skills / agent profiles

### Registry (`app/server/org/resources.server.ts`, tables org_knowledge_bases / org_mcp_servers / org_skills)
- **KB**: rows + on-disk `kb/<dir>/`; `listKnowledgeBases` :241, `saveKnowledgeBase` :282 (in-app
  authoring writes store files — `store-files.server.ts`), `reindexKnowledgeBase` :437 (+ by-dir
  for the watcher), refresh mode `on change|manual`. Injection:
  `files/kb-injection.server.ts` — `KB_INJECTION_BUDGET` 24 000 chars per run across a KB's docs
  :64, `readKbBodyDetailed` :161 (symlink-safe walk :75, deterministic order, truncation marker,
  structured `unresolved` misses), `readKbBodies` :304, `KB_PRECEDENCE_NOTE` :343. Consumed by
  specialist persona AND operator system prompt.
- **MCP**: `listMcpServers` :770, `saveMcpServer` :1415 (name refusals: `isReservedMcpName` :1289
  — viberr/viberr_agent/viberr_browser variants), probe/discovery (`discoverStdioMcpTools` :963,
  `probeMcpTarget` :1242, `discoverHttpMcpTools` :1313), credential sealed via secret-box
  (`getMcpCredentialState` :657 — an unopenable credential REFUSES the mount, never silent
  anonymous). Run resolution: `tasks/specialist-mcp.server.ts`
  `resolveSpecialistMcpServersDetailed` :119 (HTTP → bearer header; stdio → `MCP_CREDENTIAL` env;
  credentials Claude-only), `verifyStdioMcpMountsForRun` :231 (F20-10 spawn pre-flight — dead
  server dropped + disclosed + row corrected via `markMcpServerUnreachableFromRun` :1750),
  known-down rows mounted-but-flagged (P14-LV-09b). MCP grants outside the capability matrix are
  instruction-governed only (P13-KM-04) — the browser exists as a capability precisely to avoid
  that gap.
- **Browser** (`tasks/specialist-browser-mcp.server.ts`): viberr-owned Playwright MCP
  (`@playwright/mcp` pinned dep), per-run stdio, both backends. `resolveBrowserMcp` :100 —
  requires `use-browser: direct` AND effective egress `direct` (contradiction → structured
  `refused` disclosure); `--headless --isolated --output-dir <attachments>` (+`--image-responses
  omit` on Codex, `--executable-path`+`--no-sandbox` under the container env var). Persona
  guardrails :180 (pages are data; no credentials; default-named screenshots land in
  attachments/). Attachments served by `routes/task-attachment.ts` (member-only);
  `files/task-attachments.server.ts`.
- **Skills**: rows + `skills/<name>/SKILL.md` (`skill-body.server.ts` read; 256 KB cap);
  mounted natively for Claude runs via `runtimes/skill-mount.server.ts`; Codex gets prompt-text
  only (LV-13). The repo's own `.claude` is always stripped (R18-3).
- Cross-references: `resource-references.server.ts` / `resource-catalog.server.ts` (which
  profiles grant what; rename orphan detection).

### Agent profiles
- Org templates: `agents/profiles/<id>.md` (`files/agent-profile-file.server.ts`); library list
  `agents-query.server.ts` `listLibraryProfiles` :169; per-project deployment merges the template
  with deployment overrides (`effectiveProfileView` :274 — identity, model/effort, backends,
  stages, resources, definition/persona).
- Editor: `features/agents/create-profile-modal.tsx` (create AND edit; presentational — the
  agents page owns the fetcher; payload `ProfileFormPayload` :48 name/role/backend/stages/
  definition/persona/model+effort (fetched from `/resources/model-catalog`, unavailability marks
  R20-3)/caps/autonomy(operator)/resources). Capability toggles seeded from
  `CAP_MODAL_CATALOG`/`CAP_MODAL_DEFAULTS` (capability-catalog.ts, GRANT_REQUIRED polarity);
  browser⇒egress pinning client-side, `applyGrantCouplings` server-side on save. Server actions:
  `features/agents/agent-profile-actions.server.ts` (writes project.md deployments / template
  files). Seed catalog: `server/seed/agent-catalog.server.ts` (+ `ensure-base-agents.server.ts`
  backfills operator/Developer/Reviewer into every project at boot).

---

## 9. Decision packets + recovery

- Shape: `TaskPacket` (task-file.schema :418) — id, type `input|blocked`, kind, `from` (display;
  `askedBy` profileId stamps agent questions for resume routing R15-14), title/body/observations,
  `options: PacketOption[]` (kind from the 10 `PACKET_OPTION_KINDS` :74, exactly one `rec`,
  optional `ev` pre-authored event text, `backend`/`profileId` for retries, `deleteBranch`).
  Stored on task.md `packet`; projected into `task_projections.packet_json` (baseline :145);
  rendered by `features/task-detail/decision-packet.tsx`.
- Writers (all enforce ONE open packet, re-checked inside the locked write): operator
  `operatorOpenPacket` :876 (via the DISCLOSED toolkit wrapper `operatorOpenPacketDisclosed`,
  operator-toolkit :229); agent `openAgentQuestionPacket` (agent-toolkit :187 →
  `buildAgentQuestionPacket`, agent-outcome :427); system stuck-loop packet (task-actions :1757);
  failed-run escalation (`escalateFailedOperatorRun`, operator-run :2276); completion-pipeline
  question arm (Codex envelope). A blocked packet sets `readiness: blocked` (validation is
  review-only, F7-VAL1) and `waiting: human`.
- Withdrawal: `operatorResolvePacket` :1057 — operator may withdraw ONLY its own packet (never an
  agent's `askedBy` question, B2), restores readiness, typed timeline note.
- Human resolution: `resolvePacket` (task-actions :4884) — RBAC `resolve-packet` (admin|
  maintainer, `requireDecisionAuthority`), packet-identity pin (F10-09) across awaits, optional
  free-text `note`, `custom` free answer (synthetic custom option), acceptance disclosure `ack`
  required on the `accept_completion` arm (ruling 88, `assertAcceptanceDisclosure` :6450).
  Kind-specific arms: `edit_goal` keeps the packet open `awaiting: goal_edit` (cleared on goal
  save); `archive_task` (+ branch delete) enforces `approve-transition`; `discard_branch` deletes
  the local never-pushed branch; **`retry_other_backend`** :5709 starts a specialist run with
  `backendOverride: option.backend` (operator-authorized) — the cross-backend "Retry on Claude/
  Codex" path. Backend defaulting at AUTHOR time: `retryOtherBackendDefaults` (operator-actions
  :845) — the OTHER backend from the last agent run (else deliverer, else operator). Superseded
  stuck-packets self-withdraw on the agent's later success (:1840).
- After resolution the operator is re-invoked with trigger `packet-resolved` + `resolvedOption`
  (R20-1) — except kinds that own their follow-up (:5448 list). Maintainer-request flow:
  `requestPacketMaintainerDecision` :5769.
- Acceptance (adjacent, for orientation): `resolveAcceptanceAffordance` :6235 →
  `acceptCompletion` :6641 (verdict-gated, PR-head re-check :6046, disclosure-asserted,
  merge attempt) / `forceAcceptCompletion` :6941 (admin, DG-2); `transition-to-done` remains
  human-only except the explicit-direct `operatorAcceptCompletion` exception.

---

## Cross-cutting facts worth re-stating

- **Audit**: `server/audit/audit-recorder.server.ts` `recordAudit` — every governed action writes
  a row; actors: user / OPERATOR_AUDIT_ACTOR / SYSTEM_ACTOR. Query: `audit-query.server.ts`.
- **SSE**: projection events → `events/event-publisher` → `sse-broker` → `/resources/events`;
  clients revalidate routes. Events are buffered inside projection transactions.
- **Secrets**: secret-box sealing for PATs + MCP credentials; redaction of git output and run log
  lines (`run-sink` `createLineRedactor`); creds never in argv on Codex (dropped by design).
- **Model availability** (F3): `runtimes/model-availability.server.ts` — provider refusals mark a
  model unavailable; the model catalog and profile modal surface it.
- **Tests**: colocated `*.test.ts(x)`; hermetic env `test-support` fixtures; `tsc` is a required
  gate distinct from build; `app.css.test.ts` is the design-token integrity gate.
- **Docker/dev**: one process per data root EVER (dual-writer hazard); launch.json points dev at
  `docker-data`; container Codex auth lives in `runtimes/codex-home`.
