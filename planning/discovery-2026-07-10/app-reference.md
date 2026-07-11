# Viberr app reference — architecture, data model, routes (2026-07-10)

Self-contained reference for implementation agents. Verified against the live codebase on 2026-07-10.
Stack: React Router 7 SSR · Node 20+ · TS · better-sqlite3 (WAL) · Zod v4 · SSE (no websockets) ·
ported `viberr.css` design system (**no Tailwind — use `--viberr-*`/design tokens only**).

## 1. Big picture

- Canonical truth = markdown files under `VIBERR_DATA_ROOT` (`data/` in dev). SQLite
  (`data/state/projection.sqlite`) holds projections + app-management (users, sessions via
  better-auth, encrypted PATs, audit, notifications, org resources).
- chokidar watcher (250ms debounce, `project.md`/`task.md` only) → `rebuildPath` →
  content-hash-short-circuited projection → in-proc projection events → SSE broker → route
  revalidation in the client (`useLiveUpdates`).
- Every mutation follows: write file (atomic, mutex) → `reprojectTask/Project` → SSE.
- Boot (`app/server/boot.server.ts`): seed assets → DB → seed admin → event publisher → boot rescan
  → `ensureBaseAgentsDeployed` → file watcher → seeded-run resumer → `recoverUnreactedAgentRuns`.

## 2. File store

```
data/projects/<slug>/project.md            # project: stages, workflow, members, agents[], guardrails
data/projects/<slug>/tasks/<KEY>/task.md   # task: frontmatter + ## Goal + ## Packet (yaml) + ## Timeline
data/agents/profiles/<id>.md               # org profile template (caps, resources, backends, model)
data/agents/definitions/<id>.md            # agent system-prompt persona (prose)
data/kb/<dir>/…  data/skills/<name>/SKILL.md
data/runtimes/{claude,codex}/<runId>.jsonl # append-only raw run envelopes (canonical run truth)
```

Parsers: `app/schemas/project-file.schema.ts`, `app/schemas/task-file.schema.ts`,
`app/schemas/file-diagnostics.ts`. Tolerant: never throw, never drop; unknown fields preserved;
diagnostics floor readiness (warning→input_required, error→inconsistency_risk_detected,
hardStop→blocked) via `app/server/interpretation/readiness-policy.server.ts` (the ONLY derivation).

### task.md frontmatter (complete)
`key` (dir wins), `title`, `stage`, `readiness` (ready|input_required|inconsistency_risk_detected|blocked),
`waiting` (human|agent|none), `ownerUserId`, `specialist` ({profileId,backend,role}|null),
`reviewers[]` (same shape; legacy `consultants` key coerced), `operator` ({assignedAtStageId}|null),
`recommendations[]` ({id,kind∈assign_specialist|assign_reviewer|transition|accept_completion,profileId?,
toStageId?,label,detail}), `urgent`, `validation` (healthy|changed|failing|none), `branch`, `repo`
(override|null), `pr` ({number,state,title}|null), `github` (commits+changed cache), `createdAt`,
`updatedAt`, `boardRank`.

Packet (`## Packet` fenced yaml): `type` (input|blocked), `kind` label, `from`, `title`, `body`,
`observations[]` {k,v,code}, `options[]` {kind∈accept_completion|request_edit|block_on_policy|
hold_runtime_debug|redirect|custom, t, d, rec, accept?, ev?}. Dispatch on `kind`, never titles.

Timeline `### <iso> · <type> · <actor>` newest-first; types: comment|completion|github|policy|quality|
transition|blocked|agent|assign. Actors: `user:<id> (Name)` | `agent:<backend>/<role-slug>` |
`operator` | `system:<id>`.

### project.md frontmatter (complete)
`name`, `slug`, `archived?`, `repo` (owner/name|null), `defaultBranch`, `taskPrefix`,
`nextTaskNumber`, `stages[]` {id,name,color}, `workflow[]` {from,to,boundary∈auto|approval|human,by,
locked}, `members[]` {userId,role∈admin|maintainer|contributor|viewer}, `agents[]` deployments
({profileId, capabilities[]{capabilityId,mode∈direct|recommend|human|off}, extras[], definition?
(kind,name,role,icon,backends,model,effort,scope,desc,stages,spanAll,autonomy∈supervised|full)}),
`credentialPolicy` {credentialLabel,masked,requiredScopes[]}, `guardrails[]` {id,desc,on,value?,unit?}
(ids: meaningful-comment, operator-brevity, no-duplicate-summary, compression-threshold(40 events),
evidence-separation).

Capability catalog: `app/shared/capabilities.ts` (`CAP_CATALOG`, ~32 ids;
`ALWAYS_HUMAN_CAPABILITY_IDS` = merge-pull-request, transition-to-done, change-project-policy —
coerced to `human` at persist by `grantsFor`).

## 3. SQLite tables

Projections (rebuildable): `projects`, `project_members`, `task_projections` (stores BOTH derived
`readiness` and raw `stored_readiness`; `reviewers_json` renamed from consultants in 0011;
`board_rank` 0012), `task_events` (position 0=newest, replaced wholesale), `diagnostics`,
`provenance`, `agent_runs` (kind∈operator|primary|reviewer; backend∈claude|codex|simulated +
`simulated` flag; state∈queued|running|finished|error|interrupted; unique thread_id),
`run_log_lines` (raw_json + display_json per envelope).

App-owned: `users` (org role admin|member), better-auth (`user`,`session`,`account`,`verification`,
`organization`,`member`,`invitation`; bridge user.id===users.id), `audit_events`, `user_prefs`,
`github_pats` (AES-256-GCM via VIBERR_SECRET_ENCRYPTION_KEY), `project_github_credentials`,
`scope_violations` (one OPEN row per project+scope+task), `github_connections` (one default),
`google_domain_allowlist`, `org_knowledge_bases`, `org_mcp_servers`, `org_skills` (metadata only —
content on disk), `notifications` (kind∈packet|approval|mention|quality|policy).

## 4. Route table (path → module → notes)

- `/` `_index.tsx` — Home. Intents: pin, view, rescan, rebuild-projections (admin), create-project
  (any member).
- `/login` `login.tsx` — credentials + set-password (forced reset); OAuth buttons env-gated.
- `/logout`, `/org/users` (redirect), `/org/settings` (admin; tabs connections/users/resources; huge
  action switch incl. store-upload/mkdir/delete/import-github, kb/mcp/skill/agent-save/delete).
- `/profile` — identity, notif routing, appearance, password, github identity.
- `/notifications` + `/notifications/read`; `/prefs/theme`.
- Resources: `/api/auth/*` (better-auth), `/resources/events` (SSE; scopes project:/task:/user),
  `/resources/run-log?runId&since`, `/resources/health` (unauth: projections/watcher/backends),
  `/resources/model-catalog?backend=`, `/resources/session-export`.
- `/projects/:slug` layout `project.tsx` (getBoard, myRole, counts, violations) with children:
  - `board` — intents create-task, transition, reorder, rescan (admin|maintainer).
  - `review` — read-only queue (ready vs working).
  - `agents` — requireProjectMember; roster+deployments+resourceCatalog (real, from
    `buildResourceCatalog`); intents create/update/delete-profile.
  - `policy` — set-role (last-admin guard), set-boundary (review→done locked).
  - `github` — reconcile (non-viewer), grant-scope (admin|maintainer).
  - `activity` — stream + audit log (read-only).
  - `settings` — save-project, rename/add/remove/reorder-stages, invite, remove-member, override,
    grant-scope, archive-project, delete-project.
  - `tasks/:key` `project.task.tsx` — THE task workspace. Intents: comment (mention→agent run),
    resolve-packet, owner-take/assign/release, transition, run-interrupt, assign-specialist,
    run-specialist, assign-reviewer, run-reviewer, remove-reviewer, apply-recommendation,
    dismiss-recommendation, run-operator (admin|maintainer; backend+autonomy choice).

Feature dirs under `app/features/*` map 1:1 to these pages; shared primitives in `app/ui/*`.

## 5. Agent runtime

**Run engine**: `run-service.server.ts` `startRun` → adapter (`claude-runtime` — Agent SDK query(),
bypassPermissions, maxTurns 50, streaming input, `resume` support; `codex-runtime` — Codex SDK
threads, danger-full-access, no systemPrompt/mcp/allowedTools support; `simulated-runtime` — replays
scripts). Backend availability = credential presence (`isBackendAvailable`); fallback → simulated
with `simulated=1` on the run row. RunSink appends jsonl + run_log_lines + SSE `run.log-appended`.
`registerRunCompletion` callbacks are in-process only; boot `recoverUnreactedAgentRuns` replays
dropped reactions. `resumeRun` = new row, same provider session.

**Operator** (`operator-run.server.ts` `runOperator`): triggers = task create / non-operator
transition / packet resolve (request_edit|redirect|custom) / @operator comment / Run operator button /
boot recovery. Single-flight via `inFlightOperatorRun` (**known race — check-then-insert**).
Three modes: real Claude (in-proc `viberr` MCP toolkit via `buildOperatorToolkit`, gated per
capability: get_task always; post_comment=append-typed-events; open_decision_packet=generate-packets;
assign/run/prompt_specialist=assign-primary-specialist; assign/run/prompt_reviewer=summon-reviewers;
transition_stage=stage-transitions; accept_completion=completion-for-acceptance or full autonomy),
Codex (structured JSON plan → executed through same gated functions), scripted drive (offline).
React loop: specialist/reviewer completion → post reply → (reviewer runs only) verdict classification
→ `operatorShouldReactToReply` (skips: unclean run, empty reply, verbatim-repeat no-progress,
reactDepth ≥ 4) → re-invoke or `openStuckLoopPacket`. Prompt = definition body + skills + KB (24k) +
authority block.

**Specialists** (`specialist-run.server.ts`): assign/start via admin|maintainer or
operator-authorized. Persona = definition + skills + KB; Claude gets systemPrompt/mcpServers
(`resolveSpecialistMcpServers` — org registry, no cred injection) / disallowedTools
(`specialist-tool-policy.ts`: withheld caps → git/gh deny specifiers); Codex gets everything folded
into the prompt. Reviewer replies → `classifyReviewerVerdict` (approve/request_changes) → typed
quality event + validation health. Simulated replies prefixed "(simulated run …)".

**GitHub** (`app/server/github/`): `ensureTaskBranch` (idempotent, on work start),
`openTaskPr` (idempotent, on review entry, task back-link body), `mergeTaskPr` (on accept; typed
failures), `reconcileTask/Project`, `flagScopeViolation` on 403s. All best-effort — degrade cleanly
without credentials.

**Task lifecycle** (`task-actions.server.ts`, 2380 lines): `transitionStage` (boundary RBAC:
auto=member, approval/human=admin|maintainer; operator skips human RBAC but NEVER to last stage;
review entry → validation=changed + PR open; leaving triage → operator attach + clear input_required),
`setOwner`/`releaseOwner` (self-service member take; admin release-any), `acceptCompletion`
(admin|maintainer; merge+done+healthy+completion event; also operator under full autonomy via
`operatorAcceptCompletion`), `resolvePacket` (accept_completion re-gated; block_on_policy→blocked;
hold_runtime_debug→blocked; request_edit/redirect/custom→waiting=agent+ready+re-invoke operator),
`applyRecommendation`/`dismissRecommendation` (admin|maintainer), `notifyTaskWatchers` (owner +
admins + maintainers, dedup, on packets + new recommendations), timeline compaction
(`compactTimelineEvents` gated by compression-threshold guardrail).

## 6. Dev workflow

`npm run dev` (5173) · `npm test` (~960 vitest) · `npm run typecheck` · `npm run e2e` (Playwright,
isolated data root) · `npm run seed -- --reset` (restore demo) · `npm run rescan`.
Demo login: `arda@viberr.dev` / `viberr-dev-2828` (admin); elif/murat/selin/deniz same password.
Health: `GET /resources/health` → backends real vs simulated. Claude real via `CLAUDE_CODE_OAUTH_TOKEN`
or `VIBERR_CLAUDE_USE_CLI_AUTH`; Codex real via `VIBERR_CODEX_USE_CLI_AUTH=1` + `CODEX_HOME`.
Data-root env: `VIBERR_DATA_ROOT`.
