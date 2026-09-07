# Controller and its toolkit: code-verified reference (pass 35, k9s-clone observation)

Branch `pass35/k9s-clone-observation` (treated as main), read 2026-09-06. Every claim carries a
`verified in <file>:<line>` tag; where the docs say something the code does not, the row says
`DRIFT` and the item is repeated in §14. Docs consulted: `docs/domain/controller-and-goals.md`,
`docs/architecture/decisions.md` rulings 99, 100, 106, 107, 108, 121, 127, 139, `docs/README.md`.

Abbreviations: TK = `app/server/controller/controller-toolkit.server.ts`; OPS =
`app/server/controller/controller-ops-mcp.server.ts`; RUN = `app/server/controller/controller-run.server.ts`;
GUARDS = `app/server/controller/controller-tool-guards.server.ts`; CONV =
`app/server/controller/controller-conversations.server.ts`; PROF = `app/server/controller/controller-profile.server.ts`;
DOCK = `app/features/controller/controller-dock.tsx`; PAGE = `app/features/controller/controller-page.tsx`;
CAT = `app/server/runtimes/model-catalog.server.ts`; APA = `app/features/agents/agent-profile-actions.server.ts`.

## 1. Identity and the four shipped texts

| Fact | Value | Verified |
|---|---|---|
| Profile file | `agents/profiles/controller.md`, `kind: controller`, `id: controller`, `name: Controller`, `backends: [claude]`, `model: sonnet`, `spanAll: true`, `resources.skills: [controller-guide]`, `resources.mcps: []`, `resources.kb: [controller-handbook]`, `capabilities: []` | `app/server/seed/assets/controller.profile.md` (whole file) |
| Doctrine file | `agents/definitions/controller.md` (frontmatter `id: controller`, `name: Controller`, `backend: claude`; body = doctrine) | `app/server/seed/assets/controller.definition.md` |
| Skill | `skills/controller-guide/SKILL.md` | `app/server/seed/default-assets.server.ts:143` |
| KB | `kb/controller-handbook/handbook.md` (inline constant `CONTROLLER_HANDBOOK_MD`) | `default-assets.server.ts:99-135, 151-154` |
| Shipped by | boot backfill `STATIC_ASSETS` (never the project-deployment seed) | `default-assets.server.ts:137-155` |
| `CONTROLLER_PROFILE_ID` | `"controller"` | PROF:40 |
| No-model placeholder | `NO_MODEL_PLACEHOLDER = "orchestration runtime"` reads as "" (SDK default) | PROF:164, 180 |
| Default skill rule | empty stored `resources.skills` resolves to `["controller-guide"]` (`CONTROLLER_DEFAULT_SKILLS`) | PROF:172, 182 |
| Fallback doctrine | `FALLBACK_CONTROLLER_DEFINITION` when the definition file is missing or blank | PROF:100-107, 114-126 |
| Actor label | `encodeControllerInstrument(email)` = `<email><CONTROLLER_INSTRUMENT_SUFFIX>`; docs render it as `<email> · via controller` | `app/shared/mapping/actor.server.ts:171-173`; GUARDS:85 |
| Timeline trailer on comments | `_Posted by the controller for <name>._` | TK:1194 |
| Insights label for controller runs | `controller (instance)` (label "" maps to it) | `app/server/insights/insights-query.server.ts:523` |

### 1.1 What the doctrine tells the controller to do with a big goal (agents/definitions/controller.md)

Summary of the shipped doctrine (`controller.definition.md`, whole file) and the skill (`controller-guide.skill.md`, whole file):

- Ceiling: the asking person's own live permissions; `[denied]` is final, relay it, never retry, never suggest a workaround.
- No tool on purpose for: merge PR, accept completion, force-accept, resolve a decision packet, move into Done. Told to say it is "decided on the task page itself" and name project + task key. No deletes in any scope; offer archive/disable on the human surfaces.
- Ground every claim in a same-turn read (`whoami`, `get_project`, `get_task`, `list_tasks`, `get_goal`, ...). The context block at the top of the turn counts as a same-turn read; re-read after acting or where entries were omitted.
- "The person's message is the authorization for the actions it plainly asks for; do not ask 'shall I?' for a reversible action they just requested." For a fan-out (a fully customised project, a multi-link goal) restate the shape in the same reply in which it creates it. Ask ONE precise question only when something consequential is ambiguous.
- Secrets never through chat; the one exception is relaying a just-minted temp password in full.
- Goals: "Chained goals are yours to define, create, track and advance." Write each link's task text so it stands alone (deliverable + done signal). Only link 1's task is created up front; the server creates the next when the previous completes; each task gets its own operator. Never fake chain progress. Links may declare `blockedBy`.
- Comments: `comment_on_task` never starts a run; use `run_agent_on_task`; @mention to notify; report exactly whether a run started.
- Skill "Core loop": resolve question/action/plan; read (`whoami`, `get_project`, `list_tasks`, `get_task`, `list_goals`, `get_goal`, org reads); "Act with the narrowest tool that does the ask. One user request may legitimately fan out (create a project, then tasks, then a goal); keep the fan out to what was asked."; report in the tool result's own terms.
- Skill "Two scopes": instance = org role (users, KBs, skills, MCPs, global templates, audit, analytics need org admin; project creation open to any signed-in person, creator becomes project admin); board = project role per action ("creating tasks needs contributor or above; moving tasks, running agents and reading GitHub state at depth need maintainer or above; policy, members and agent deployments need the project admin").
- Skill "Working with operators and agents": "prefer `comment_on_task` with a clear @operator directive, or `run_agent_on_task` ... Do not micromanage the how."
- NOT stated anywhere: an ordering rule such as "create KB, then skills, then MCPs, then agents, then project, then goal". The only ordering the texts give is: goal chain = one project, link 1 first, and "keep the fan out to what was asked". Creating KBs/skills/MCPs/global templates is org-admin instance work the doctrine describes as available, not as a step of a plan.
- The KB handbook (`CONTROLLER_HANDBOOK_MD`) only restates: users/roles, projects carry stages + boundaries + members + agents + repo, "The move into the final stage is always a human decision", resources are granted to agent profiles, goal chains, house rules (ceiling, ground in reads, never fabricate progress).

## 2. Guards and response prefixes (GUARDS, shared by `viberr_controller` and `viberr_ops`)

| Prefix / sentence | When | Verified |
|---|---|---|
| `[denied] <AppError.userMessage>` | handler threw `AppError` with status 401 or 403 | GUARDS:117-122 |
| `[error] <AppError.userMessage>` | any other `AppError` (400 validation, 404, 409 conflict, 500) | GUARDS:117-122 |
| `[error] That action failed unexpectedly. The details are in the server log; nothing was partially hidden from the audit trail.` | non-AppError throw (logged) | GUARDS:127-132 |
| `[denied] No project "<slug>" is visible to you.` | `requireVisible` failed (missing AND forbidden identical); also thrown explicitly by handlers when a project row/file is absent | GUARDS:49-51, 102-111; TK:914, 1137, 1407, 1477, 1518 |
| `[denied] Only org admins can <what>. Your org role is member.` | `requireOrgAdmin(what)`; writes audit `controller.authority.denied {scope: "instance", what}` | GUARDS:90-100 |
| `[done] ...` / `[noop] ...` | success prefixes hand-written per tool (see §3); `[noop]` only in `update_user` and `update_task` | TK:416, 1374 |
| `[denied] No run "<runId>" is visible to you.` | `viberr_ops` run reads (missing, forbidden project, forbidden conversation all identical) | OPS:112-114 |

`requireVisible` = `assertProjectAction(db, "any-member", slug, actor, what, { dataRoot, allowArchived: true })` (GUARDS:102-111), so archived projects READ fine; writes that go through `requireAction` are frozen by the writers themselves. Org admins pass via the audited override inside `assertProjectAction`.

Toolkit-level argument resolution:
- `slugOf(given)`: `given ?? boundSlug`; empty → `[error] Name the project (this conversation is not bound to one).` (TK:200-208)
- `keyOf(given, slug)`: named key wins; else the anchored task ONLY when `slug === boundSlug`; anchored but another slug → `[error] This conversation is anchored to <KEY> in <slug>; name the task in <slug>.`; no anchor → `[error] Name the task (this conversation is not anchored to one).` (TK:218-230)
- Prose fields pass through `normalizeEscapedNewlines` (`prose`) (TK:184).
- MCP server name `viberr_controller`, version 1.0.0, instructions `CONTROLLER_TOOLKIT_INSTRUCTIONS` (TK:175-182, 2082-2087). Allowed-tool ids are `mcp__viberr_controller__<name>` (TK:236-239).

## 3. The 39 `viberr_controller` tools (TK)

Count: 39 `add(` calls (TK, `grep -c "^  add("`). Order as registered. `req` = required. All `projectSlug` params are `string?` defaulting to the bound project; all `taskKey` params are `string?` defaulting to the anchored task (rules in §2).

### 3.1 Instance scope

| Tool | Params | Gate | Reply | Verified |
|---|---|---|---|---|
| `whoami` | none | signed-in | JSON `{userId,email,name,orgRole:"admin"\|"member",conversationProject,conversationTask,projects[{slug,name,role,archived}]}`; `role` = member role or `"org admin override"` or null | TK:243-272 |
| `list_capabilities` | none | signed-in | JSON `{note, kinds:{operator:{modes:[direct,recommend,human,off],capabilities[{id,label,whenUngranted,alwaysHuman}]}, agent:{modes:[direct,human,off],...}}, alwaysHuman:[merge-pull-request,transition-to-done,change-project-policy]}`; `whenUngranted` = `absentGrantMode` or `"project policy (see get_project)"` for `deliver-review-pr`/`update-task-branch` | TK:274-311; `app/shared/capabilities.ts:213-217`; `capability-catalog.ts:152-166` |
| `list_users` | none | org admin ("list users") | JSON `[{id,email,name,role,status}]` | TK:313-332 |
| `create_user` | `name` req, `email` req, `role` enum `admin\|member` req | org admin ("create users") | `[done] <email> created (org <role>). Temporary password (single use, must be changed at first sign in): <pw>` | TK:334-357 |
| `update_user` | `userId` req; `name?`, `email?`, `role?` enum, `access?` enum `enable\|disable`, `resetPassword?` bool | org admin ("update users") | `[done] profile updated (<email>, org <role>); account disabled; password reset. Temporary password (single use): <pw>.` joined by `; `; nothing given → `[noop] Nothing to change was given.`; unknown id → `[error] No such user.` | TK:359-422 |
| `set_user_org_role` | `userId` req, `role` enum req | org admin ("change org roles") | `[done] <email> is now an org <role>.` | TK:424-443 |
| `list_knowledge_bases` | none | org admin ("read the org knowledge bases") | JSON `[{grantKey(=dir),id,name,dir,refresh,files}]` | TK:445-468 |
| `save_knowledge_base` | `id?`, `name` req, `refresh?` enum `on change\|manual` (default `on change`), `doc?` `{path,content}` | org admin ("manage knowledge bases") | `[done] <toast>. Document <path> written.`; folder unresolved → `[done] <toast>. The document could not be written: the KB folder did not resolve.` | TK:470-520; `resources.server.ts:163` |
| `list_skills` | none | org admin ("read the org skills") | JSON `[{grantKey(=folder name),id,name,summary}]` | TK:522-543 |
| `save_skill` | `id?`, `name` req, `summary` req, `body?` (omit = keep disk; sent as "" on create) | org admin ("manage skills") | `[done] <toast>.` | TK:545-572 |
| `list_mcp_servers` | none | org admin ("read the MCP connections") | JSON `[{grantKey(=name),id,name,transport,target,up,tools,hasCredential,lastError}]` | TK:574-600 |
| `save_mcp_server` | `id?`, `name` req, `transport` enum `HTTP\|stdio` req, `target` req; NO credential param (`cred: ""`) | org admin ("manage MCP connections") | `[done] <toast>. If it needs a credential, the admin adds it in Org settings (secrets never travel through this chat).`; reserved name `viberr_ops` refused by `saveMcpServer` | TK:602-636; OPS:83 |
| `test_mcp_server` | `id` req | org admin ("test MCP connections") | `[done] <toast>` | TK:638-650 |
| `list_global_agents` | none | org admin ("read the global agent templates") | JSON `[{id,name,backend,summary,stages,skills,mcps,kbs,usedByProjects}]` | TK:652-679 |
| `save_global_agent` | `id?`, `name` req, `backend` enum `claude\|codex` req, `summary` req, `persona?`, `stages` string[] min 1 req, `skills?`, `mcps?`, `kbs?` (grant keys; omitted = keep, `[]` = clear). NO `model`/`effort` params. | org admin ("manage global agent templates") | `[done] <toast>.` (`<name> updated — running threads re-anchor on next turn` on edit); unknown grant key → `[error] Nothing in the store answers to <keys>. Grant a skill by its folder name, an MCP server by its registry name and a knowledge base by its store directory — the grantKey each resource list returns, never the id.`; a created template stores `model: ""`, `capabilities: conservativeGrantsFor("agent")` (delivery withheld), `kind: specialist` | TK:681-753; `gagents.server.ts:305-315, 377-470` |
| `inspect_audit_log` | `projectSlug?`, `action?` (exact id), `actorUserId?`, `since?`, `until?`, `limit?` int 1..200 (default 50) | org admin ("inspect the audit log") | JSON `{total,shown,rows[{at,action,actor,project,task,subject}]}` | TK:755-801 |
| `inspect_run_analytics` | `projectSlug?` | org admin ("inspect run analytics") | JSON `{totals,outcomes,byBackend,byKind,byProject,byModel,avgDurationMs,oversight}` | TK:803-828 |
| `create_project` | `name` req, `key` req (2 to 4 letters, uppercased, reserved prefixes refused), `owner` req (GitHub owner with a configured connection), `repoName` req, `policy` enum `strict\|balanced\|auto` req, `description?`, `stages?` `[{name,color?}]` (2..8, terminal last), `boundaries?` `[{from,to,boundary: auto\|approval\|human}]` (names, not ids), `members?` `[{email,role: admin\|maintainer\|contributor\|viewer}]` | any signed-in user; NO requireVisible; `createProject` seeds the asker as project admin | `[done] Project <name> created at <storePath> (slug <slug>, keys <KEY>-n). You are its admin. Warning: <repoWarning>`; refusals (all `[error]`): `Task key must be 2-4 letters.`; `No GitHub connection for "<owner>". Add a PAT for that owner in Instance settings → GitHub connections first.`; `A project at projects/<slug> already exists.` (409); `A custom board carries 2 to 8 stages (got N).`; `Every custom stage needs a name.` | TK:830-900; `project-create.server.ts:302-360, 525-526, 553-600` |

`create_project` also: preinstalls the default roster (operator + developer + reviewer) via `presetAgents(policy, defaultAgentDeployments())` (`project-create.server.ts:453-455`; `agent-catalog.server.ts:204-231`); `strict` sets the operator's `deliver-review-pr` to `recommend`, `auto` widens `completion-for-acceptance` (`project-create.server.ts:79-115`). Custom stage ids = `slugifyProjectName(name)` (fallback `stage-<i>`); default chain over a custom list: every pre-work edge `auto`, the edge into the stage before terminal `approval`, the edge into terminal `human` + locked (`project-create.server.ts:569-590`). Default (no custom stages) board = template `governed-5`: `triage` (Triage), `ready` (Ready), `impl` (In Progress), `review` (Review), `done` (Done) (`app/shared/workflow/templates.ts:35-42`). `repoWarning` variants: token can read but not push; repo not visible; token refused; could not reach GitHub (`project-create.server.ts:395-407`).

### 3.2 Board reads (gate = `requireVisible`)

| Tool | Params | Reply | Verified |
|---|---|---|---|
| `get_project` | `projectSlug?` | JSON `{slug,name,repo,archived,description,stages[{id,name,tasks}],workflow,members[{userId,role,name,email}],agents[{profileId,name,kind,backends,stages,model,modelLabel,effort,capabilities[{capabilityId,mode,label}],autonomy(operator only)}],goals[{id,title,status,link,links}]}`; agents come from `assembleAgentRoster` (RESOLVED grants) | TK:904-976 |
| `list_tasks` | `projectSlug?`, `stageId?`, `includeArchived?` | JSON `[{key,title,stage,readiness,waiting,owner,priority,archived,goal:{goalId,link}\|null,waitsOn:["<label> (<state>)"]}]`; includes Done | TK:978-1015 |
| `get_task` | `projectSlug?`, `taskKey?`, `events?` int 1..50 (default 12) | JSON `{task: <TaskSummary>, newestEvents[{at,type,by,title,text(≤700 chars)}]}`; missing → `[error] No task <key> in <slug>.` | TK:1017-1045 |
| `get_github_state` | `projectSlug?` | JSON `{repo,defaultBranch,connection,reconcile,prs[{task,number,state,title,checks,review,mergeable}],branches[{task,branch,sync}]}` | TK:1468-1501 |
| `list_goals` | `projectSlug?` | JSON `[{id,title,status,createdBy,currentLink,links[{index,title,status,taskKey,blockedBy}]}]` | TK:1925-1952 |
| `get_goal` | `projectSlug?`, `goalId` req | JSON goal view; missing → `[error] No goal <id> in <slug>.` | TK:1954-1968 |

### 3.3 Board writes (gate = `requireVisible`, then the writer's own `requireAction`)

RBAC matrix (`app/shared/rbac.ts:60-86`): `create-task`/`own-task`/`edit-task-meta` = admin, maintainer, contributor; `approve-transition`/`update-goal`/`run-agents` = admin, maintainer; `manage-members`/`manage-agents`/`edit-policy` = admin. Org admins pass any project gate via the audited override.

| Tool | Params | Reply / refusals | Verified |
|---|---|---|---|
| `create_task` | `projectSlug?`, `title` req, `goal?`, `priority?` enum `low\|normal\|high\|urgent`, `labels?`, `owner?` (email or `me`, default `me`; `none` refused), `dueDate?` (`YYYY-MM-DD`, "" = none), `blockedBy?` string[] | `[done] <KEY> created in <StageName>: <title>. Owner: <email>, seated before the first operator run. Waits on <labels>; held until every entry is done.`; `owner: none` → `[error] A new task is created with an owner; use \`set_task_owner\` to release the seat afterwards.`; unknown email → `[error] No Viberr user with the email <x>.`; always the ENTRY stage (`project.stages[0]`); title < 3 chars → `[error] A title of at least 3 characters is required.`; auto-invokes the task's operator (createTask) | TK:1047-1121; `task-actions.server.ts:546-576` |
| `move_task` | `projectSlug?`, `taskKey?`, `toStageId` req | terminal target → `[denied] Moving <KEY> into <Done name> means accepting its completion, which carries its own confirmation and merge consequences. Decide it on the task page: projects/<slug>/tasks/<KEY>.` (returned, not thrown); else `transitionStage({manual: true})` → `[done] <KEY> is now in stage <stageId>.`; `Unknown stage <id> for this project.`; `No allowed transition from <A> to <B>.` (both `[error]`) | TK:1123-1167; `task-actions.server.ts:4782-4822` |
| `comment_on_task` | `projectSlug?`, `taskKey?`, `text` req | `[done] Comment posted on <KEY>.`; archived project refused by `requireProjectMutable`; posts as actor `{kind: "controller"}` + trailer; never starts a run | TK:1169-1207 |
| `set_task_owner` | `projectSlug?`, `taskKey?`, `owner` req (email, `me`, `none`) | `[done] <KEY> is now unowned.` / `[done] <KEY> is owned by <name>.`; `Only the current owner or a project admin can hand off ownership.` → `[denied]` | TK:1209-1249; `task-actions.server.ts:4463` |
| `update_task` | `projectSlug?`, `taskKey?`, `goal?`, `priority?`, `labels?` (full set), `dueDate?` ("" clears), `blockedBy?` (full list, `[]` clears + releases) | nothing passed → `[error] Pass a goal and/or at least one metadata field (priority, labels, dueDate, blockedBy).`; `[done] <KEY> updated: <applied>. Already set, nothing written: <unchanged>. Not applied: <axis>: <reason>`; all unchanged → `[noop] <KEY>: <axes> already had that value; nothing was written.`; all refused → first refusal thrown | TK:1251-1387 |
| `run_agent_on_task` | `projectSlug?`, `taskKey?`, `agent` req (`"operator"` or deployed profileId), `prompt?` | not run-agents → `[denied] Running agents needs the maintainer role (or project admin) in this project.`; operator: `[denied] The operator is not run while a decision packet is open. Answer the packet first.` / `[denied] <KEY> is already Done; there is nothing for the operator to coordinate.` / `[done] The operator is already working <KEY>; your directive was queued for it.` / `[done] Operator run started on <KEY>.`; specialist: `[done] <Name> run started on <KEY> (<backend>).`; `[error] No agent \`<id>\` is deployed in this project.`; stage ineligible → `[error] <Name> is not eligible for the "<stage>" stage — its profile is scoped to <stages>. Change the task's stage or the profile's eligible stages.` | TK:1389-1466; `specialist-run.server.ts:337-345, 1505, 3691-3693` |
| `update_project_settings` | `projectSlug?`, `name?`, `prefix?`, `description?` | `[done] <toast>.` (project admin) | TK:1503-1535 |
| `update_stages` | `projectSlug?`, `op` enum `add\|rename\|remove\|reorder` req, `stageId?`, `name?`, `orderedIds?` | `[done] <toast> (id <stageId>).` on add; `[error] Give the new stage a name.` / `Renaming needs stageId and name.` / `Removing needs stageId.` / `Reordering needs orderedIds.` | TK:1537-1599 |
| `set_transition_boundary` | `projectSlug?`, `from` req (stage id), `to` req (adjacent stage id), `boundary` enum `auto\|approval\|human` req | `[done] <toast>.` (edit-policy); terminal edge locked human | TK:1601-1626 |
| `invite_member` | `projectSlug?`, `name` req, `email` req, `role?` enum (omitted = viewer) | `[done] <toast> Temporary password (single use, must be changed at first sign in): <pw>` (only for a new account) | TK:1628-1665 |
| `set_member_role` | `projectSlug?`, `email` req, `role` enum req | `[done] <toast>.`; unknown email → `[error] No Viberr user with the email <x>.` | TK:1667-1695 |
| `deploy_agent` | `projectSlug?`, `profileId` req, `model?`, `effort?` | see §5 | TK:1697-1723 |
| `update_agent_deployment` | `projectSlug?`, `profileId` req, `capabilities?` `[{capabilityId, mode: direct\|recommend\|human\|off}]`, `backend?` enum, `model?`, `effort?`, `stages?` string[], `autonomy?` enum `supervised\|full` (operator only) | see §5 | TK:1725-1864 |

### 3.4 Goals (gate = `requireVisible`, then the goal writers' gates)

| Tool | Params | Reply | Verified |
|---|---|---|---|
| `create_goal` | `projectSlug?`, `title` req (≥3 chars), `description?`, `onFailure?` enum `pause\|continue` (default pause), `links` `[{title,goal,blockedBy?}]` min 1 max 20 req | `[done] Goal <goalId> created with N links; link 1 is <KEY>.`; needs the asker's own `create-task`; link 1's task is created first (createTask, operator auto-invoke) | TK:1866-1923; `goal-actions.server.ts:184, 206, 281` |
| `update_goal` | `projectSlug?`, `goalId` req, `op` enum `pause\|resume\|cancel\|skip_link\|retry_link\|edit_link\|add_link\|remove_pending_link` req, `index?` int ≥1, `title?`, `goal?`, `reason?`, `blockedBy?` | `[done] <message> Goal <id> is <status> on <activeTaskKey>.`; `[error] <op> needs the link index.`; `[error] add_link needs a title.`; gate = creator OR `run-agents` holder; non-member → `[denied] Only project members can <what>.` | TK:1970-2080; `goal-actions.server.ts:324` |

Goal file: `projects/<slug>/goals/goal-<n>.md`; `GOAL_MAX_LINKS = 20` (`goal-actions.server.ts:72`). The page's `goal-op` intent exposes only `pause|resume|cancel|skip_link|retry_link` (`app/routes/project.controller.tsx:150-186`); `edit_link`, `add_link`, `remove_pending_link` are controller-only.

### 3.5 What the controller cannot do (pinned)

- No tool for: merge, accept completion, force-accept, resolve packet, move into the terminal stage, delete anything (users, projects, tasks, goals, resources). `move_task` refuses a terminal target with the `[denied] Moving ... Decide it on the task page: projects/<slug>/tasks/<KEY>.` sentence (TK:1139-1145). Doctrine sentence it should say: "decided on the task page itself" naming project and task key (`controller.definition.md` para 3). `CONTROLLER_TOOLKIT_INSTRUCTIONS` repeats: "Nothing here deletes, merges, accepts completions, resolves decision packets, or moves a task into its final stage." (TK:175-182)
- Denied built-ins on every turn: `Read`, `Grep`, `Glob`, `WebFetch`, `WebSearch` (RUN:379) plus the operator read-only adapter set. No filesystem, no shell (system prompt RUN:866).
- Cannot edit its own profile/resources/doctrine (skill "What you never do").

## 4. `viberr_ops` (OPS)

Mounted on EVERY turn with no config read; name `CONTROLLER_OPS_MCP_NAME = "viberr_ops"`, reserved in `RESERVED_MCP_NAMES` (OPS:83; RUN:163-188). Allowed ids `mcp__viberr_ops__<name>`. Every successful read writes audit `controller.ops.read` `{tool, ...}` with `subjectKind: "controller"`, `subjectId` = target (OPS:167-179).

| Tool | Params | Gate | Returns | Verified |
|---|---|---|---|---|
| `instance_health` | none | anyone | `healthSnapshot(db,{principal:true})` + `backendCredentials:[{backend:"claude"\|"codex",connectedUsers,askerConnected}]` + `runs:{cap,live,queued}` (`runConcurrencySnapshot`) + `browserDetail` (org admin only) | OPS:209-259 |
| `read_run_log` | `runId` req, `since?` int (forward), `before?` int (backward), `limit?` int (default 200, clamp 1..500) | project member; controller run = owner or live org admin | JSON `{run:{id,kind,state,backend,model,agent,project,task,startedAt,finishedAt,turns,logLines},page:{firstSeq,lastSeq,olderExist,newerExist,next:{older:{before}\|null,newer:{since}\|null}},lines[{seq,at,display}]}`; both cursors → `[error] Name either since (a forward page) or before (a backward page), not both.` | OPS:261-408 |
| `read_store_doc` | `kind` enum `kb\|skill` req, `id` req, `path` string[] req | org admin ("read store documents") | JSON `{resource:{kind,id,name},path,truncated,text}`; `[error] That resource no longer exists.` / `That file no longer exists.` | OPS:410-442 |

## 5. Model and effort on `deploy_agent` / `update_agent_deployment` / `save_global_agent`

### 5.1 Catalog (CAT)

| Backend | Models (in order; first = default) | Efforts (offered) | Default effort | Verified |
|---|---|---|---|---|
| claude | `sonnet`, `opus`, `haiku` (open catalog: dated `claude-*\d` ids, `alias[1m]` variants, live-catalog values also pass `isKnownModel`) | `low, medium, high, xhigh, max` | `high` | CAT:80-114, 306-317; `app/shared/model-ids.ts:26` |
| codex | `gpt-5.6-terra` (default), `gpt-6-astra`, `gpt-5.6-sol`, `gpt-5.6-luna`, `gpt-5.5` (closed catalog) | `low, medium, high, xhigh, max` (`gpt-5.5` stops at `xhigh`; `minimal`/`ultra`/`persistent` never offered) | `medium` | CAT:129-195 |

- `assertEffortForBackend(backend, effort)`: refuses unless in the backend's offered list: `"<e or (empty)>" is not an effort tier <Claude|Codex> offers. <Claude|Codex> takes: low, medium, high, xhigh, max.` (CAT:242-250). Note: it does NOT consult the per-model list, so `gpt-5.5` + `max` passes here (open question §15).
- `assertModelForBackend(backend, model)`: codex + unknown id → `"<id>" is not a model Codex offers. Codex takes: gpt-5.6-terra, gpt-6-astra, gpt-5.6-sol, gpt-5.6-luna, gpt-5.5.`; a model known on the OTHER backend → `<Display> is a <Other> model. <This> cannot run it. Pick a model from the <This> list.`; claude + unknown-but-not-codex string (e.g. `opus-9`) PASSES (CAT:259-279, 337-345).
- `resolveRunModel(backend, model)` at run start: unknown → `defaultModelFor(backend)` silently (CAT:355-361). See §14 drift D3.
- `resolveRunEffort` clamps at run time by rank; the controller's asserts are what stop a clamp from being reachable through chat (CAT:385-408).
- Adapter hand-off: Claude `resolveClaudeEffort` passes exactly `low|medium|high|xhigh|max` → `options.effort` (`claude-runtime.server.ts:175-185, 1107-1112`); Codex `resolveCodexReasoningEffort` passes `minimal|low|medium|high|xhigh|max` → `threadOptions.modelReasoningEffort` (`codex-runtime.server.ts:227-240, 843-856`). A specialist run threads `effort: view.effort || ""` from the deployment (`specialist-run.server.ts:191-192, 233`).

### 5.2 `deploy_agent` (TK:1697-1723 → APA:542-689)

1. `requireVisible(slug, "manage this project's agents")`, then `deployAgentProfileFromLibrary` → `requireProjectAction` (`manage-agents`, admin).
2. Template must exist and be `kind: specialist`: `[error] No global agent profile \`<id>\`.` / `[error] \`<id>\` is not a specialist template and can't be added to a project.` (APA:570-580).
3. Already deployed → 409 → `[error] <Name> is already deployed in this project.` (APA:606-609). Every app-created project ALREADY carries operator + developer + reviewer, so `deploy_agent developer` on such a project answers this.
4. `backend = fm.backends[0] === "codex" ? "codex" : "claude"` (the template's PRIMARY backend; shipped Developer = `["claude","codex"]` → claude) (APA:611; `agent-catalog.server.ts:131`).
5. Overrides checked BEFORE the write: `assertModelForBackend(backend, model)`, `assertEffortForBackend(backend, effort)` (APA:621-624).
6. Stored: `model = override || (templateModel not foreign ? templateModel : defaultModelFor(backend))`; `effort = override || defaultEffortFor(backend)` (the template's own effort is never read) (APA:631-636).
7. Capabilities: the template's own list when non-empty (shipped Developer holds `execute-code-or-write-repo` direct etc.), else `conservativeGrantsFor("agent")` (delivery withheld); `applyGrantCouplings` repairs delivery/browser pairs (APA:590-600; `capabilities.ts:194-205, 575-582`).
8. Audit `project.agent_profile.deployed` with `model`, `effort` in details (APA:668-687).
9. Reply: `[done] <Name> deployed on <slug>. Runs on <Claude|Codex> with model <model> at effort <effort>. Delivery starts withheld; open it up with update_agent_deployment when the profile should write the repo.` (TK:1717-1720). The last sentence is unconditional: see §14 D2.

Worked values:
- `deploy_agent {profileId:"developer"}` on a fresh template store: backend claude, model `sonnet` (template), effort `high` (default).
- `deploy_agent {profileId:"<claude template>", model:"opus", effort:"high"}` → stored `opus`/`high`; run passes `options.effort="high"`, model `opus`.
- `deploy_agent {profileId:"<codex-primary template>", model:"gpt-6-astra", effort:"medium"}` → stored `gpt-6-astra`/`medium`; Codex run gets `modelReasoningEffort: "medium"`, model `gpt-6-astra` verbatim (`isKnownModel("codex","gpt-6-astra")` true). A template whose primary backend is claude cannot be deployed onto astra: `assertModelForBackend("claude","gpt-6-astra")` → `GPT-6 Astra is a Codex model. Claude cannot run it. Pick a model from the Claude list.`; switch afterwards with `update_agent_deployment {backend:"codex", model:"gpt-6-astra", effort:"medium"}`.

### 5.3 `update_agent_deployment` (TK:1725-1864 → APA:693-860)

Order of checks, all BEFORE any write (each is `[error]` since they are 400 validation):
1. `requireVisible(slug, "manage this project's agents")`; deployment lookup → `[error] No agent <id> is deployed on <slug>.` (TK:1760-1766).
2. `capabilityPatchRefusal(kind, capabilities)` (`capability-catalog.ts:258-287`), sentences: `"<id>" is a matrix-only capability with no toggle: it describes persona guidance and cannot be granted or withheld. Nothing was written. The ids <the operator|a specialist> takes are: <list> (see list_capabilities).`; `"<id>" is an operator capability and cannot be set on a specialist. ...` (and the reverse); `No capability answers to "<id>". Nothing was written. ...`; `"<id>" cannot be set to recommend on a specialist: recommend is an operator-only mode (a specialist runs a grant directly or not at all). Use direct, human or off. Nothing was written.`; `"<id>" is reserved for humans and can only be human. Nothing was written.`; `"report-validation-verdict" takes only direct or off: verdict authority is explicit and is never widened or reserved. Nothing was written.`
3. `autonomy` on a specialist → `autonomy is an operator setting; <name> is a specialist. Nothing was written.` (TK:1780-1784).
4. Unknown stage ids → `"<id>" is not a stage of <slug>. Nothing was written. The project's stage ids are: <ids>.` (TK:1785-1791).
5. Caps seeded from the RESOLVED roster (`assembleAgentRoster`), patched by the given list (TK:1801-1807).
6. Backend: `currentBackend = view.backends[0]`; `backend = args.backend ?? currentBackend`; `switched = backend !== currentBackend`. `assertEffortForBackend(backend, effort)` if given; `assertModelForBackend(backend, model)` if given. `effort = args.effort ?? (switched ? defaultEffortFor(backend) : view.effort)`; `model = args.model ?? (switched ? defaultModelFor(backend) : view.model)` (TK:1812-1830).
7. Form carries `fingerprint: deploymentFingerprint(deployment)`; a hand-save between read and write → 409 `[error] This profile changed while the editor was open. Reopen it to see the current grants, then save again.` (TK:1824; APA:730-735).
8. `updateAgentProfile` stores `backends: [backend]`, `model: form.model || defaultModelFor`, `effort` as given (specialist with blank effort → default; operator with blank → key omitted); re-asserts effort only when CHANGED (APA:742-745, 783-794).
9. Reply: `[done] <Name> updated on <slug>.` + (if switched and effort omitted) ` Backend switched to <Codex|Claude>: effort reset to its default (<effort>)[ and model to <model>].` + (if effort given) ` Effort is now <effort>.` + governance notice + coupling notes (TK:1847-1859). Audit `project.agent_profile.updated` (APA:857-859); raising the operator to `full` writes a dedicated governance audit row (APA:832-850).

Worked values:
- Claude deployment, `{model:"opus", effort:"high"}` → stored `opus`/`high`; reply `... Effort is now high.`
- Claude deployment → `{backend:"codex", model:"gpt-6-astra", effort:"medium"}` → asserts against codex, stored `["codex"]`/`gpt-6-astra`/`medium`; reply `... Effort is now medium.` (no reset sentence because effort was given).
- Claude deployment → `{backend:"codex"}` alone → `gpt-5.6-terra`/`medium`; reply `Backend switched to Codex: effort reset to its default (medium) and model to gpt-5.6-terra.`
- Codex deployment → `{backend:"claude"}` alone → `sonnet`/`high`.
- `{effort:"ultra"}` on codex → `[error] "ultra" is not an effort tier Codex offers. Codex takes: low, medium, high, xhigh, max.`
- `{model:"gpt-6-astra"}` on a claude deployment without `backend` → `[error] GPT-6 Astra is a Codex model. Claude cannot run it. Pick a model from the Claude list.`

### 5.4 `save_global_agent` and model

No model/effort parameters exist (TK:685-710); a created template stores `model: ""` (`gagents.server.ts:454`), an edited one keeps its stored model. A chat-created template therefore deploys at `defaultModelFor(backend)` unless `deploy_agent` passes `model`. Templates are `kind: specialist` only; the operator and controller are untouchable here (TK:684).

## 6. Deployment locks (ruling 108)

| Section | Env var | Locked when | Verified |
|---|---|---|---|
| skill grants | `VIBERR_UNLOCK_CONTROLLER_SKILLS` | value is not exactly `enabled` (trimmed, case-insensitive) | `app/shared/controller-locks.ts:26-31, 46`; PROF:58-79 |
| knowledge base grants | `VIBERR_UNLOCK_CONTROLLER_KB` | same | same |
| MCP server grants | `VIBERR_UNLOCK_CONTROLLER_MCPS` | same | same |
| instructions | `VIBERR_UNLOCK_CONTROLLER_INSTRUCTIONS` | same | same |

- Model and effort are never locked (`controller-locks.ts:5-7`).
- Enforcement in `saveControllerConfig`: locked section + non-empty input that differs from the stored/effective set → 403 `The controller's <section label> are locked on this deployment. Set <VAR>=enabled in the app environment and restart to edit them.`; blank input keeps the stored list verbatim (a CLEAR cannot be expressed through a locked section); locked instructions: a differing non-blank body is refused, blank keeps the file (PROF:228-277). Audit `org.controller.updated {model, effort, skills, kb, mcps, definitionEdited}` (PROF:306-321).
- Missing profile → 404 `The controller profile is missing from the store. Restart the app to restore the shipped one, then edit it.` (PROF:214-217).
- Env schema: all four optional strings (`env.server.ts:177-180`); `.env.example:158-161` ships them commented out (`=enabled`).
- Settings panel: `data-screen-label="Controller settings"`, button `Open the controller`, lock note `Locked here on this deployment: ...` (`controller-admin-panel.tsx:281-330`).

## 7. Conversations, scopes and storage (CONV)

| Fact | Value | Verified |
|---|---|---|
| Tables | `controller_conversations(id, user_id, user_label, project_slug, task_key, title, created_at, updated_at, last_message_at)`; `controller_messages(id, conversation_id, seq, author user\|controller, user_id, text, run_id, surface, created_at)` | CONV:264-270, 407-411 |
| Ids | conversation `cnv_...` (`newId("cnv")`), message `cmsg_...` | CONV:262, 392 |
| Scope | `conversationScopeOf`: taskKey → `task`, slug → `board`, else `instance`; fixed at creation; task without project → `A conversation anchored to a task must name the task's project.` | CONV:228-259 |
| Title | first user message, whitespace-flattened, clipped to 79 chars + `…` when > 80 | CONV:423-441 |
| Surface | user messages only, `normalizeSurface`, `MESSAGE_SURFACE_MAX_CHARS = 400` | CONV:354-368, 405-406 |
| Access | owner, or live-resolved org admin (`canAccessConversation`); others get 404 `Conversation not found.` (`requireConversation`) | CONV:121-132, 213-223 |
| Speak | owner only: 403 `Only the conversation's owner can talk in it. Start your own conversation with the controller.` | RUN:204-211 |
| Run-log / interrupt gate | `canReadControllerRunLog` = `canInterruptControllerRun` = owner or live org admin | CONV:141-174 |
| List order | `COALESCE(last_message_at, created_at) DESC, rowid DESC`, limit 1..200 (default 50); `taskKey` undefined = any binding under the slug, null = board-only, key = that task | CONV:284-321 |
| SSE | `controller.updated {conversationId, userId}` owner-routed on every append | CONV:445-458 |

## 8. Surfaces, routes and the dock

### 8.1 Routes

| Path | File | Notes | Verified |
|---|---|---|---|
| `/controller` | `app/routes/controller.tsx` | any signed-in; `?c=<id>` selects, `?c=new` = blank composer, no `?c` = newest OWN instance thread, `?all=1` = org admin lists everyone's; intents `send`, `interrupt` | `controller.tsx:53-140`; `app/routes.ts:32` |
| `/projects/:slug/controller` | `app/routes/project.controller.tsx` | `requireProjectMember` (non-member = unknown-slug 404); same `?c`/`?all`; intents `send`, `goal-op`, `interrupt`; loader adds `canRedirectGoals` (run-agents holder or org admin) | `project.controller.tsx:62-215`; `routes.ts:88` |
| `/resources/controller` | `app/routes/resources.controller.ts` | dock data: `GET ?project=&task=&c=` → `{view}`; `POST intent=send` (+ `text`, `surface`, `project`, `task`, `conversationId` or `new`) → `{ok, conversationId}`; never throws (unreachable scope → `unavailable` view; POST → `{ok:false, error:"That project or task is not open to you."}` 404; foreign thread → `Conversation not found.`; other intent → `Unknown action.` 400) | whole file; `routes.ts:59` |
| `/resources/run-log` | `app/routes/resources.run-log.ts` | console paging; owner-or-admin for controller runs | `routes.ts:50` |

Page facts: `data-screen-label="Controller"` (PAGE:131); composer `aria-label="Message to the controller"`, placeholder `Ask the controller, or tell it what to do…` / `Read-only: only the conversation's owner can talk in it.` / `CLAUDE_NOT_CONNECTED`; footer `Acts with your permissions · refusals say why · ⌘↵ sends`; Send button `Send` / `Sending…`; ⌘↵ or Ctrl↵ sends (PAGE:455-525). `CLAUDE_NOT_CONNECTED = "The controller runs on your own Claude account, and Claude isn't connected for you yet. Connect it on your Profile → Agent accounts, then send your message again."` (PAGE:59-62). `NEW_CONVERSATION_PARAM = "new"` (PAGE:73).

Entry points: workspace rail item `Controller` (third of eight: Board, Review queue, Controller, Agents, Policy, GitHub, Activity, Settings) (`app/features/shell/nav.ts:22-30`; DRIFT: docs say "Eighth item", §14 D5); Home hero `Controller` button linking `/controller` (`home-sections.tsx:262-265`); org settings tab `Open the controller`; the dock.

### 8.2 The dock (DOCK, `controller-dock-context.ts`)

| Fact | Value | Verified |
|---|---|---|
| Mount | once in `root.tsx`; hidden on route ids `routes/login`, `routes/controller`, `routes/project.controller`, `routes/profile`, `routes/notifications` | `controller-dock-context.ts:42-48` |
| Scope from routes | `routes/project` match → board (`params.slug`); `routes/project.task` under it → task (`params.key`); else instance | `controller-dock-context.ts:72-92` |
| Trigger | `<button class="dock-fab" aria-label="Controller · <scope>" aria-haspopup="dialog" aria-expanded>`; scope = `Instance`, `<project name>` (slug before the loader), `<KEY> · <project name>`; `.live-dot` while working | DOCK:99-104, 624-646 |
| Panel | `<section role="dialog" aria-modal="false" aria-label="Controller dock" data-screen-label="Controller dock" id="controller-dock-panel">` | DOCK:436-444 |
| Header buttons (aria-labels) | `Threads here (<n>)` (aria-pressed), `New thread`, `Open the full controller page` (link to `<pageHref>?c=<id>` or `?c=new`), `Close the controller dock` | DOCK:464-499 |
| Context line | task: `Knows the <KEY> task file and its place in the <project> workflow · <acts>`; board: `Knows the <project> board: stages, members, open tasks, goal chains · <acts>`; instance: `Knows your projects and org role · <acts>`; loading: `Reading where you are…`; unreachable: `Not available here: this project or task is not open to you.` | `controller-dock-query.server.ts:94-117, 231`; DOCK:502-504 |
| Empty copy | task: `Ask about <KEY> or say what to do with it. The controller already has its task file.`; board: `Ask about the <project> board or say what to do on it: tasks, agents, goal chains.`; instance: `Ask about this instance or say what to do: projects, users, resources, agents, goal chains.` | DOCK:106-114 |
| Unavailable body | `The controller has nothing to work with here: this project or task is not open to you, or it no longer exists. Everything else on the page still works.` (section aria-label `Controller unavailable here`) | DOCK:505-512 |
| Threads list | section aria-label `Threads here`; `No threads here yet.`; rows = title + local time or `empty`; `aria-current="true"` on the open one | DOCK:513-536 |
| Transcript | section aria-label `Conversation transcript`; `You` vs controller name; working row `role="status"`: `<name> is working…`; hidden live region `<name> is working` | DOCK:538-579, 650-652 |
| Composer | textarea aria-label `Message to the controller`, 2 rows; placeholders `Loading…` / `Read-only: only the thread's owner can talk in it.` / `CLAUDE_NOT_CONNECTED` / `Ask the controller, or tell it what to do here…`; footer `Acts with your permissions · ⌘↵ sends`; `Send`/`Sending…`; ⌘↵ / Ctrl↵ submits; POST to `/resources/controller` with `intent=send` | DOCK:581-620, 389-411 |
| Keyboard | Escape ON the panel closes instantly and returns focus to the trigger when focus was inside; an outside click never closes; composer focus only on a user-initiated open | DOCK:253-337, 446-453 |
| Poll | `WORKING_POLL_MS = 5_000` while `turn.working`, open or closed | DOCK:50, 215-228 |
| Persistence | `sessionStorage` keys `viberr.dock.open` and `viberr.dock.selected` (per scope key `<slug>|<key>`); `NEW_THREAD = "new"`; `staleSelection` from the server forgets a stored id | DOCK:48-52, 157-213 |
| Own SSE stream | only on `routes/insights` (`DOCK_SELF_STREAM_ROUTE_IDS`) | `controller-dock-context.ts:60` |
| Send error | toast `<error>` or `The controller could not take that. Try again.` | DOCK:233-236 |

## 9. How a turn runs (RUN)

1. `runControllerTurn`: empty text → 400 `Say something for the controller to act on.`; `requireConversation` (owner or admin); non-owner → 403 (RUN:198-211).
2. The user message is appended FIRST (RUN:213-220).
3. `resolveUserRunPrincipal(db, user.id, "claude")`: refusal is written into the transcript as a controller message and the turn answers `{state:"refused"}` (RUN:227-238). Sentences (RUN:302-333): no credential → `The controller runs on your own Claude account, and Claude isn't connected for you yet. Connect it on your Profile → Agent accounts, then send your message again.`; credential row present but file gone → `<health.detail> The controller runs on your own Claude account, so I cannot answer until it is connected.`; otherwise → `Your account is disabled or gone, so there is no Claude account for the controller to run on. Ask an org admin to re-enable it. I have not started anything.`
4. Lease: `Map<conversationId, {runId, queue[]}>` on `globalThis[Symbol.for("viberr.controllerLease")]`; single flight; `MAX_QUEUED_MESSAGES = 8`; overflow appends `I could not take that on: The controller is still answering and its queue for this conversation is full. Wait for the current reply. Say it again once I have replied.` and answers `refused` (RUN:76-108, 240-259).
5. Start failure appends `I could not start this turn: <reason>` and rethrows (RUN:273-290).
6. `startTurnRun`: `resolveControllerConfig`; org MCP grants resolved + stdio pre-flighted once; mounts = `viberr_controller` + `viberr_ops` + org servers (org names cannot shadow the reserved two) (RUN:348-365); system prompt = doctrine + attached skills/KBs (`KB_INJECTION_BUDGET = 24_000`) + runtime block (`You are the instance controller, running on the Claude backend, model \`<model>\`.`, org MCP lines, `Built-in diagnostics (viberr_ops) are always attached ...`, `You have no filesystem or shell: the viberr_controller tools are how you read and change anything.`) + conversation block naming the asker, their live org role, and the binding sentence (RUN:814-886; `kb-injection.server.ts:64`).
7. Prompt = context read (§10) + `Recent exchange (for orientation; the store is the truth for anything that may have changed):` digest of the last `CONTEXT_MESSAGES = 30` messages within `CONTEXT_CHARS = 24_000`, 600 chars each + `<userLabel> says:\n\n<text>` (RUN:109-111, 762-801).
8. Resume vs fresh: the newest prior controller run of the conversation with a `session_id` is resumed (`resumeRun`, model re-resolved per turn via `resolveRunModel("claude", config.model)`, effort only when set); else `startRun` with `role: "Controller"`, `kind: "controller"`, `backend: "claude"`, `credentialUserId` = asker, `agentProfileId: "controller"`, `projectSlug: ""`, `taskKey: <conversation id>`, `autonomous: true`, `workdir = <dataRoot>/runtimes/controller-scratch` (RUN:99-106, 381-450, 756-760).
9. `settleTurn` on completion: reply = full reply text; interrupted → `This turn was stopped before I could answer.`; error → `failedTurnNote` (RUN:549-581): quota → `I could not finish this turn: your Claude account's <window> window is spent. It reopens at <YYYY-MM-DD HH:MM UTC>. Wait for it, or connect a different Claude account or an API key on Profile → Agent accounts, then send your message again.`; auth → `I could not finish this turn: your Claude account was refused by the provider (<code>): <cause>. Connect a different Claude account or an API key on Profile → Agent accounts, then send your message again.`; overloaded → `I could not finish this turn: Claude was overloaded or failed on its side (HTTP <n>). Nothing about your account is wrong. Say it again in a few minutes.`; other → `I could not finish this turn: the run did not complete. Say it again to retry.` (RUN:500-540). Then the next queued message starts; a queued start failure appends `I could not start the queued turn. Say it again to retry.` or `... and I dropped the N messages you sent after it. Say them again to retry.` (RUN:583-623).
10. Boot recovery: `This turn was interrupted by a server restart before I could answer. Say it again and I will pick it up.` for orphaned terminal runs without a settle message and for conversations ending in a user message (RUN:676-752).
11. `conversationTurnState` = `working` when the leased run is not finished/error/interrupted (RUN:658-669).

## 10. The context read (`controller-context.server.ts`)

Constants: `TASK_FILE_CONTEXT_CHARS = 24_000`, `BOARD_CONTEXT_TASKS = 40`, `BOARD_CONTEXT_MEMBERS = 20`, `BOARD_CONTEXT_GOALS = 20`, `BOARD_CONTEXT_CHARS = 12_000`, `INSTANCE_CONTEXT_PROJECTS = 40`, `CONTEXT_BLOCK_CHARS = 32_000` (`controller-context.server.ts:50-56`). Omission markers: `[... N older timeline entries omitted to fit the context budget; get_task reads more ...]` and the head-cut variant (`:84-89`). A bound project the asker cannot see replaces the block with `[denied] No project "<slug>" is visible to you. This conversation is bound to it, so I cannot read its ...` (`:434`). Surface line: `They are looking at: <surface>` (`:442`). Over budget the whole block is truncated with a marker (`:447-449`).

## 11. Interrupt

- Page: Live-run strip `Interrupt` (shown when `canInterruptTurn` = owner or org admin) → `ConfirmDialog` `screenLabel="Interrupt turn dialog"`, title `Interrupt this turn?`, body `The controller stops where it is. Anything it was about to apply is not applied, and the transcript records that the turn was stopped. You can send your message again afterward.`, confirm `Interrupt turn` (PAGE:306-318; `controller-query.server.ts:144-146`). Posts `intent=interrupt`, `conversationId`, `runId` (PAGE:258-266).
- Route toast: `Turn interrupted. The transcript records that it was stopped.` or `That turn had already ended.` (`controller.tsx:121-138`; `project.controller.tsx:188-205`).
- Engine: `interruptControllerTurn` → `interruptRun({projectSlug:"", taskKey: conversationId, runId})`; controller runs gate on `canInterruptControllerRun`, refusal 404-shaped `Run <id> not found on <conversationId>.`; terminal or already-stamped → `outcome: "already-terminal"`; no live handle → row patched to `interrupted` and `fireIfAlreadyTerminal` fires the completion callback so `settleTurn` records the stop; audit `runtime.run.interrupted` (RUN:638-650; `run-service.server.ts:1741-1860`).
- No dock Interrupt control exists (DOCK has none; verified by absence in DOCK:432-653).

## 12. Run row and log locations

| Fact | Value | Verified |
|---|---|---|
| Row | `agent_runs.kind = 'controller'`, `project_slug = ''`, `task_key = <conversation id>`, `role = 'Controller'`, `backend = 'claude'`, `agent_profile_id = 'controller'`, `credential_user_id = <asker>` | RUN:427-446; `db/migrations/0001_baseline.sql:513-553` |
| States | `queued, running, finished, error, interrupted` | `0001_baseline.sql:538-539` |
| Console lines | SQLite `run_log_lines(run_id, seq, occurred_at, raw_json, display_json)` | `0001_baseline.sql:575-583` |
| Raw NDJSON on disk | `<VIBERR_DATA_ROOT>/runtimes/<backend>/<runId>.jsonl` (i.e. `runtimes/claude/<runId>.jsonl` for controller turns); retention `VIBERR_TRANSCRIPT_RETENTION_DAYS` (30) | `run-store.server.ts:8-9, 444`; `docs/architecture/data-model.md:70, 178` |
| Scratch workdir | `<dataRoot>/runtimes/controller-scratch` | RUN:756-760 |
| Live frames | `controller.log-appended {conversationId,userId,runId,threadId,seq}` on the OWNER's `user` stream; lifecycle → `controller.updated` | docs §3 (`run-events.server.ts`, not re-read here) |
| Page runtime panels | `listRunsForTask(db, "", conversationId)`; grouped console `run N of M` | `controller-query.server.ts:143` |

## 13. Audit action names touched by this subsystem

`controller.authority.denied` (GUARDS:93), `controller.ops.read` (OPS:173), `org.controller.updated` (PROF:307), `project.agent_profile.deployed` (APA:681), `project.agent_profile.updated` (APA:858), `runtime.run.interrupted` (`run-service.server.ts:1836`), `org.agent_profile.updated` (`gagents.server.ts:407`), `goal.created` / `goal.updated` / `goal.completed` (docs §8; not re-read), `task.agent.commented` with label `controller` (docs §8).

## 14. Drift candidates (code wins)

- D1 `docs/README.md:67` says "the 38 `viberr_controller` tools"; the toolkit registers 39 (`grep -c "^  add("` TK) and `docs/domain/controller-and-goals.md:272` says 39. Doc-only inconsistency.
- D2 `deploy_agent` reply ALWAYS ends `Delivery starts withheld; open it up with update_agent_deployment when the profile should write the repo.` (TK:1720) and its description says "delivery starts withheld until an admin opens it up" (TK:1700), but `deployAgentProfileFromLibrary` keeps a template's OWN grants when it has any (APA:590-600); the shipped Developer template ships `execute-code-or-write-repo` direct (`agent-catalog.server.ts:131-166`). Deploying such a template answers a sentence that is false for it. Docs (`controller-and-goals.md:283`) repeat the tool's wording.
- D3 `run_agent_on_task` operator arm handles `refused === "open-packet"`, `"terminal-stage"` and `queued` only (TK:1435-1444); `runOperator` also returns `refused: "blocked-by"` with `runId: null` for a held task (`operator-run.server.ts:282, 1476-1500`, ruling 131(d)). That case falls through to `[done] Operator run started on <KEY>.` with no run. Docs (`controller-and-goals.md:283`) list only the two refusals. Candidate: "the controller says a run started when the operator refused a held task".
- D4 Ruling 139 says the model check refuses "an unknown or impossible value BY NAME"; for Claude only a FOREIGN (Codex) id is refused (`assertModelForBackend`, CAT:259-279). A typo such as `model: "opus-9"` is stored, the reply reports `Runs on Claude with model opus-9`, and `resolveRunModel` silently runs `sonnet` (CAT:355-361). Docs (`controller-and-goals.md:358-367`) describe only effort as "refused by name".
- D5 `controller-and-goals.md:67` says the project Controller surface is the "Eighth item in the workspace rail"; `nav.ts:22-30` places it third of eight.
- D6 Ruling 121(e) (decisions.md:2044-2046) says "the composer takes focus on open"; code focuses only on a user-initiated open (DOCK:318-337). The domain doc already carries the correction (`controller-and-goals.md:108-110`); the ruling text does not.
- D7 `assertEffortForBackend` checks the backend list, not the per-model list (CAT:242-250); `gpt-5.5` is catalogued to `xhigh` only (CAT:180-185) yet `effort: "max"` on a `gpt-5.5` deployment passes the assert. Ruling 139's "never a tier the runtime would silently clamp" holds only if the Codex adapter accepts `max` for that model (unverified, §15).

## 15. Open questions (not verified here)

- Whether the Codex CLI accepts `modelReasoningEffort: "max"` on `gpt-5.5` or clamps/refuses it (D7).
- `capabilityPatchRefusal`'s `ADVISORY_IDS` and `toggleableIdsFor` membership per kind (only the sentences were read; the exact id sets live above `capability-catalog.ts:258`).
- The exact `TaskSummary` field list returned by `get_task` (`task-query.server.ts`, not read).
- `run-events.server.ts` routing of `controller.log-appended` (docs claim, not re-read).
- Whether `getGithubViewData` returns null for a project with no connection (would surface as the not-visible sentence from `get_github_state`, TK:1477).
- The `applyGrantCouplings` notice sentences appended to `deploy_agent`/`update_agent_deployment` replies (`capabilities.ts:575-600`, only the function shape was read).
- Goal audit names `goal.created` / `goal.updated` / `goal.completed` and notification kind `controller` are docs claims (`controller-and-goals.md:509-513`), not re-verified in `goal-actions.server.ts`.
