# Capabilities, models and effort across every surface (code-verified reference)

Pass 35 (k9s-clone observation). Branch `pass35/k9s-clone-observation`. Every claim below
was checked against the working tree on 2026-09-06; each carries `verified in <file>:<line>`
or is flagged `DRIFT` (docs say X, code does Y; code wins). Docs consulted:
`docs/domain/agents-and-runtime.md` (§2.1-2.3, §4.3, §5, §10), `docs/domain/controller-and-goals.md`
(§1, §5, §6), `docs/architecture/decisions.md` (rulings 28, 31, 39, 75, 81, 94, 95, 101, 106,
109, 127, 139), `docs/ui/surfaces.md`.

Vocabulary used here: "specialist" = any non-operator agent profile (`kind: "agent"` in the
catalog, `kind: "specialist"` in profile files); "operator" = the per-task coordinator;
"controller" = the instance-wide conversational agent (Claude only).

---

## 1. Capability catalog (`app/shared/capabilities.ts`)

Source: `UNIFIED_CAP_CATALOG` (verified in app/shared/capabilities.ts:33-156). Modes are the
file enum `CAPABILITY_MODES = ["direct","recommend","human","off"]` (verified in
app/schemas/project-file.schema.ts:36). Editor words for the four modes (D32-9, verified in
app/features/agents/capability-catalog.ts:143-148): `direct` = "Acts directly",
`recommend` = "Recommends only", `human` = "Human-only", `off` = "Off".

Columns: kind = which profile kinds carry it; group = editor accordion group (`null` = matrix
only, no toggle, refused as such by the controller); default = mode seeded on create;
promotable = raising project autonomy may promote it to direct (only matters for operator
`stage-transitions`); enforcement = `capabilityEnforcement(id)` (verified :303-311);
whenUngranted = `absentGrantMode(kind, cap)` (verified in
app/features/agents/agents-query.server.ts:303-313), i.e. what a deployment RESOLVES to when
project.md carries no grant for the id.

| id | label (exact) | kind | group | default | promotable | enforcement | whenUngranted |
|---|---|---|---|---|---|---|---|
| `dispatch-agents` | Select & run agents | operator | Assignment | direct | yes | both | direct (catalog default; :52,:308) |
| `generate-packets` | Generate decision & blocking packets | operator | Coordination | direct | yes | both | off |
| `append-typed-events` | Append typed important events | operator | Coordination | direct | yes | both | off |
| `stage-transitions` | Stage transitions | operator | Permissions | recommend | yes | both | off |
| `completion-for-acceptance` | Accept completion into Done | operator | Permissions | recommend | **no** (:64) | both | off |
| `deliver-review-pr` | Deliver the branch & open the review PR | operator | Permissions | direct | yes | both | "project policy (see get_project)": `absentDeliverReviewPrMode(humanGatedBeforeWork)` = recommend when a human gates pre-work advance, else direct (:630-634; ruling 28) |
| `update-task-branch` | Bring the task branch up to date | operator | Permissions | direct | yes | both | same as delivery (policy dependent; agents-query.server.ts:282-285) |
| `execute-code-or-write-repo` | Execute code or write to the repo | agent | Repository & execution | direct | yes | both (ruling 101) | **off** (grant-required) |
| `create-task-branch` | Create the task-key branch | agent | Repository & execution | direct | yes | claude-only | **off** (grant-required) |
| `commit-push-branch` | Commit & push to the branch | agent | Repository & execution | direct | yes | claude-only | **off** (grant-required) |
| `open-review-pr` | Open the review pull request | agent | Repository & execution | direct | yes | claude-only | **off** (grant-required) |
| `comment-on-task` | Post mid-run comments | agent | Collaboration | direct | yes | claude-only | direct |
| `ask-human` | Ask the human a question | agent | Collaboration | direct | yes | both | direct |
| `use-web-search-fetch` | Search & fetch from the web | agent, operator | Collaboration | direct | yes | both | direct (both kinds; :102, agents-query:308) |
| `use-browser` | Drive a live web browser | agent | Collaboration | **off** | yes | both (mount itself) | off |
| `read-github-api` | Read GitHub repository & PR data | agent | Collaboration | **off** | **no** (:130) | claude-only | off |
| `report-validation-verdict` | Report a validation verdict | agent | Collaboration | **off** | yes | both | **off** (grant-required) |
| `attach-evidence-references` | Attach evidence references | agent | Collaboration | direct | yes | both | direct |
| `run-unit-integration-validation` | Run unit & integration validation | agent | null | direct | yes | advisory | direct |
| `move-task-to-review` | Move the task to Review | agent | null | direct | yes | advisory | direct |
| `read-repo-diff` | Read the repository & diff | agent | null | direct | yes | advisory | direct |
| `run-validation-suites` | Run validation suites | agent | null | direct | yes | advisory | direct |
| `post-quality-flags` | Post quality-flag events | agent | null | direct | yes | advisory | direct (but gated by verdict, see below) |
| `approve-review` | Approve the review | agent | null | direct | yes | advisory | direct (verdict-gated) |
| `request-changes` | Request changes | agent | null | direct | yes | advisory | direct (verdict-gated) |
| `author-test-cases` | Author test cases | agent | null | direct | yes | advisory | direct |
| `read-task-repo` | Read the task & repository | agent | null | direct | yes | advisory | direct |
| `flag-underspecified-tasks` | Flag underspecified tasks | agent | null | direct | yes | advisory | direct |
| `merge-pull-request` | Merge a pull request | agent | Reserved for humans | human | no | both (always-human) | human |
| `transition-to-done` | Transition a task to Done | agent | Reserved for humans | human | no | both (always-human) | human |
| `change-project-policy` | Change project policy | agent | Reserved for humans | human | no | both (always-human) | human |

Named families (all verified in app/shared/capabilities.ts):

- `ALWAYS_HUMAN_CAPABILITY_IDS` = `merge-pull-request`, `transition-to-done`,
  `change-project-policy` (:213-217). Every write path coerces them to `human`
  regardless of the form (agent-profile-actions.server.ts:319, :391); the controller refuses
  a non-human mode by name (capability-catalog.ts:287-289).
- `GRANT_REQUIRED_CAPABILITY_IDS` = `execute-code-or-write-repo`, `create-task-branch`,
  `commit-push-branch`, `open-review-pr`, `merge-pull-request`, `report-validation-verdict`
  (:408-415). Absent = withheld (`isWithheld`, specialist-tool-policy.ts:154-161). Every
  other capability absent = its catalog default (permissive).
- `SCOPED_DELIVERY_CAPABILITY_IDS` = `create-task-branch`, `commit-push-branch`,
  `open-review-pr` (:386-390); all three are vetoed when the headline
  `execute-code-or-write-repo` is withheld (`resolveDeliveryPermissions`,
  specialist-tool-policy.ts:308-330).
- `VERDICT_OUTCOME_CAPABILITY_IDS` = `approve-review`, `request-changes`,
  `post-quality-flags` (:319-323); rendered as `off` unless `report-validation-verdict` is
  exactly `direct` (`applyVerdictOutcomeGate`, :340-359).
- `ENFORCED_CAPABILITY_IDS` (both backends) :225-269; `CLAUDE_ONLY_ENFORCED_CAPABILITY_IDS`
  = `create-task-branch`, `commit-push-branch`, `open-review-pr`, `comment-on-task`,
  `read-github-api` (:286-298).
- Specialist modes: no `recommend`. A stored/submitted specialist `recommend` normalizes DOWN
  to `off` (`coerceSpecialistCapabilityMode`, :377-381; ruling 81). The operator keeps all four.
  DRIFT-NOTE (comment only): `effectiveProfileView` comment at agents-query.server.ts:317-323
  still says a specialist `recommend` is "coerced to direct ('Allowed') on read" - the R7-5
  wording ruling 81 retired; runtime reads `effectiveCollabMode` which treats `recommend` as
  absent (agent-outcome.server.ts:381-401). Display-comment drift, not behaviour.
- `defaultGrantsFor(kind)` = every catalog cap of that kind at its default (:167-174).
  `conservativeGrantsFor("agent")` = the same with `execute-code-or-write-repo`, the three
  scoped delivery ids and the three verdict outcomes forced `off` (:194-205). Used when a
  library template with an empty grant list is deployed (agent-profile-actions.server.ts:612-624).
- `withheldAgentGrants()` (capability-catalog.ts:89-94): every agent cap `off`, always-human
  stay `human`; what a deployment with `capabilities: []` or an undeployed profile runs with.

### 1.1 Save-time couplings (`applyGrantCouplings`, :575-586)

| rule | trigger | result | exact notice message |
|---|---|---|---|
| `delivery-headline` repaired | any scoped delivery id is direct/recommend and the headline is ABSENT | headline materialised `direct` | `"Execute code or write to the repo" was granted to match <labels>: the delivery steps above it cannot run without it.` (:509-511) |
| `delivery-headline` withheld | scoped id granted, headline explicitly `off`/`human` | nothing changed; profile cannot deliver | `<labels> stays granted but "Execute code or write to the repo" is off, so this profile cannot deliver until the headline capability is granted.` (`human-only` when human) (:488-491) |
| `browser-egress` repaired | `use-browser: direct` and `use-web-search-fetch` not `direct` | egress set/added `direct` | `"Search & fetch from the web" was granted to match "Drive a live web browser": the browser is web egress and cannot mount without it.` (:567-568; ruling 95) |

Notices ride the save result (`notices[]`) and the audit row (`deliveryGrants`,
`deliveryNote`, `browserEgress`, `browserEgressNote` keys) (agent-profile-actions.server.ts:153-168).
The project editor also pins the egress row to Allowed while the browser is Allowed
(`coupleGrants`, create-profile-modal.tsx:310-316).

### 1.2 Runtime enforcement (what withholding actually does)

Claude deny rules (`CAP_DENY_RULES`, verified in app/server/tasks/specialist-tool-policy.ts:52-100):

| withheld id | Claude `disallowedTools` | Codex |
|---|---|---|
| `create-task-branch` | `Bash(git checkout -b:*)`, `Bash(git checkout -B:*)`, `Bash(git switch -c:*)`, `Bash(git switch -C:*)` | advisory (server-owned delivery gate is the boundary) |
| `commit-push-branch` | `Bash(git push:*)`, `Bash(git commit:*)` | advisory |
| `open-review-pr` | `Bash(gh pr create:*)` | advisory |
| `merge-pull-request` | `Bash(gh pr merge:*)` | structural (never held actionable) |
| `execute-code-or-write-repo` | `Edit`, `MultiEdit`, `Write`, `NotebookEdit`, `Bash(git commit:*)` | `read-only` sandbox (`resolveCodexSandboxMode`, codex-runtime.server.ts:431-460) EXCEPT the ruling-109 carve-out: evidence granted (`attachmentsWritableDir` set) keeps `workspace-write` |
| `use-web-search-fetch` | `WebFetch`, `WebSearch` | `webSearchMode: "disabled"`; also keeps the sandbox below `danger-full-access` |
| `use-browser` | Playwright MCP not mounted (`resolveBrowserMcp`) | same |
| `comment-on-task`, `ask-human`, `report-validation-verdict`, `read-github-api`, `attach-evidence-references` | the `viberr_agent` toolkit tool is not built / the completion pipeline ignores the field | ask/verdict/evidence gated server-side (both); comment and github-read never exist on Codex |

`curl`/`wget` via Bash stay reachable on both backends (documented tension, :78-86). MCP
tools are never gated by the matrix (ruling 39; no `mcp__*` deny rule).

Codex sandbox decision (verified codex-runtime.server.ts:431-460): operator -> `read-only`;
`repoWriteWithheld` -> `read-only` unless `attachmentsWritableDir` -> `workspace-write`;
`autonomous && kind === "primary" && !webSearchWithheld` -> `danger-full-access`; else
`workspace-write`.

`codexRepoWriteAdvisory(grants)` is true exactly when grants are non-empty, the headline is
withheld and `attach-evidence-references` is not withheld (specialist-tool-policy.ts:242-254).
Sentence used everywhere for that shape (`CODEX_REPO_WRITE_ADVISORY_NOTE`, :258-259):
"repo-write is withheld but evidence is granted, and Codex's sandbox cannot express
read-only-except-attachments - so on Codex this run keeps workspace-write and the withholding
is advisory; the server-owned delivery gate is the real boundary" (the original uses an
em-dash). Editor row tags (create-profile-modal.tsx:949-985): "advisory on Codex" with
title "Enforced on Claude runs (tool denylist). On this Codex profile it is advisory only: the
Codex SDK ignores tool allow/deny lists, so the server-owned delivery gate is the real
boundary."; `read-github-api` on a Codex profile reads "inert on Codex" with title "This tool
is Claude-only and is never mounted on Codex, so on this Codex profile the grant is inert."
Matrix legend: "binds tools on Claude runs · advisory on Codex" (capability-matrix-modal.tsx:137).

### 1.3 `use-browser` and its egress precondition

- Default `off`; grant it and egress is forced `direct` at save (ruling 95, above).
- Mount gate `resolveBrowserMcp({grants, attachmentsDir, backend})` (verified
  app/server/tasks/specialist-browser-mcp.server.ts:148-215): requires
  `effectiveCollabMode(grants,"use-browser") === "direct"` AND
  `effectiveCollabMode(grants,"use-web-search-fetch") === "direct"`; otherwise refused with
  reason `the profile grants a browser but withholds web egress (use-web-search-fetch) - the
  browser is not mounted; grant egress or withhold the browser`. Further refusals:
  `the @playwright/mcp package is not installed in this deployment`; `the pinned browser
  executable (VIBERR_BROWSER_EXECUTABLE=<path>) is not on disk - chromium is not installed in
  this deployment; the browser is not mounted (rebuild the image or install chromium)`.
  Refusal name: `<BROWSER_MCP_NAME> (use-browser)`.
- Mount args: `--headless --isolated --output-dir <attachmentsDir>`; on Codex additionally
  `--image-responses omit` (screenshots not returned to the model); with a pinned executable
  `--executable-path <exe> --no-sandbox` (:186-200). No env, no credential.
- `effectiveCollabMode` (agent-outcome.server.ts:381-401): explicit direct/human/off wins;
  `recommend` or absent falls to the catalog default (`use-browser` -> off,
  `use-web-search-fetch` -> direct).
- Only Chromium is declared (ruling 103).

### 1.4 `read-github-api`

Default `off`, `promotable: false`, claude-only (in-process `viberr_agent` SDK tool; the PAT
never crosses to the child), advisory/never mounted on Codex (capabilities.ts:114-130). Scope
forced under `/repos/{owner}/{name}` of the task's project, GET only
(`scopeAgentGithubReadPath`, agent-github-read.server.ts per the comment; not re-read here).

---

## 2. Model catalogs (`app/server/runtimes/model-catalog.server.ts`)

Verified in model-catalog.server.ts:80-197.

### 2.1 Claude (curated; `CLAUDE_EFFORTS = ["low","medium","high","xhigh","max"]`)

| value | displayName | description | efforts |
|---|---|---|---|
| `sonnet` | Claude Sonnet | "Balanced speed and capability - the everyday default." | low..max |
| `opus` | Claude Opus | "Most capable - deepest reasoning for the hardest work." | low..max |
| `haiku` | Claude Haiku | "Fastest and lightest - quick, cheap turns." | low..max |

`defaultModel = "sonnet"` (first), `defaultEffort = "high"` (:108-116). Also accepted as
KNOWN (`isKnownModel`, :308-319): any dated id matching `/^claude-.*\d/`, any family alias
with a bracket variant `/^(sonnet|opus|haiku)\[[a-z0-9]+\]$/i` (e.g. `opus[1m]`), and any
value the LIVE catalog cache last offered (TTL-blind).

Live enhancement (:676-719): only when the caller passes the VIEWER's own Claude
`RunCredential`; `query().supportedModels()` with `claudeProbeOptions` (filtered env +
credential env, `settingSources: []`, `skills: []`, `plugins: []`, `maxTurns: 1`), 15 s
timeout, 10 min cache keyed by the viewer's `homeDir`; on any failure or empty list the
curated list is served. When live succeeds the served `models` are the LIVE rows ONLY
(`claudeCatalogFromLive`, :655-668), with the curated effort superset and `defaultModel` =
the live row whose value equals `sonnet` else the first live row. OPEN QUESTION: the exact
`value`s the SDK returns (whether `opus`/`sonnet` aliases appear verbatim, or only dated ids
plus `opus[1m]`); `modelDisplayName` handles `opus[1m]` as "Opus (1M context)" when cached,
"Claude Opus [1m]" cold (:420-433).

### 2.2 Codex (curated, closed list; `CODEX_EFFORTS = ["low","medium","high","xhigh","max"]`)

| value | displayName | description | efforts |
|---|---|---|---|
| `gpt-5.6-terra` | GPT-5.6 Terra | "Balanced everyday workhorse with strong reasoning and tool use." | low..max |
| `gpt-6-astra` | GPT-6 Astra | "Most capable model for complex, demanding work." | low..max |
| `gpt-5.6-sol` | GPT-5.6 Sol | "Flagship model for complex coding, research, and high-value work." | low..max |
| `gpt-5.6-luna` | GPT-5.6 Luna | "Fast model for clear, repeatable, well-scoped tasks." | low..max |
| `gpt-5.5` | GPT-5.5 | "Previous-generation model retained for existing profiles." | low, medium, high, xhigh (no max) |

`defaultModel = "gpt-5.6-terra"` (first; Sol 400s on ChatGPT-plan accounts, F20-33),
`defaultEffort = "medium"` (:188-197). No live layer: `getModelCatalog("codex")` always
returns curated (:685). `minimal` is accepted by the Codex adapter but never offered;
`ultra` and `persistent` are neither offered nor forwarded (:118-131, codex-runtime.server.ts:213-241).

Effort labels in every picker (`EFFORT_LABEL`, create-profile-modal.tsx:113-120): minimal
"Minimal", low "Low", medium "Medium", high "High", xhigh "Extra high", max "Maximum".

### 2.3 Availability marks

`model_availability` table rows (per backend+model) stamp `unavailable: {reason, markedAt}`
onto every served catalog copy (:472-485); set only from a real run failure matching
`MODEL_UNSUPPORTED_RE`, cleared by a real success (docs §2.3; `model-availability.server.ts`
not re-read here). Picker: option disabled, suffix " (unavailable for this account)", hint
"Unavailable for this account: <reason> Pick another model." (create-profile-modal.tsx:685-700).
Roster badge "unavailable" with title "<reason> A run on this model would be refused. Open
Edit profile to pick another." (agents-page.tsx:1050-1057).

### 2.4 Validators and refusal sentences (model-catalog.server.ts)

- `assertEffortForBackend(backend, effort)` (:244-252): refuses a tier not in the BACKEND-wide
  list: `"<e>" is not an effort tier <Claude|Codex> offers. <Claude|Codex> takes: low, medium,
  high, xhigh, max.` Empty renders as `"(empty)"`. NOTE: backend-wide, not per-model:
  `gpt-5.5` + `max` passes even though the catalog lists GPT-5.5 to `xhigh` only (candidate).
- `assertModelForBackend(backend, model)` (:261-281): a Codex-unknown id ->
  `"<id>" is not a model Codex offers. Codex takes: gpt-5.6-terra, gpt-6-astra, gpt-5.6-sol,
  gpt-5.6-luna, gpt-5.5.`; a foreign id (known to the other backend) ->
  `<DisplayName> is a <Claude|Codex> model. <Backend> cannot run it. Pick a model from the
  <Backend> list.` Claude side is OPEN (an unknown-to-both id passes).
- `foreignModelBackend(backend, model)` (:339-345): the other backend iff it knows the id.
- `resolveRunModel(backend, model)` (:357-363): known -> verbatim, else `defaultModelFor`.
- `resolveRunEffort(backend, effort)` (:385-408): in the backend list -> verbatim; else by
  rank (`minimal 0, low 1, medium 2, high 3, xhigh 4, max 5, ultra 6`) to the nearest offered
  tier; unknown -> backend default. Consequence: Codex `minimal` -> `low`, `ultra` -> `max`.

---

## 3. How a run resolves its model and effort

| run kind | backend | model | effort | verified |
|---|---|---|---|---|
| specialist (fresh) | `input.backendOverride ?? engagement.pinnedBackend ?? resolved.backend ?? engagement.backend` where `resolved.backend = primaryRunBackend(view.backends)` (first of `codex`/`claude`, Claude if none) | same backend as profile: `resolveRunModel(backend, view.model)`; different backend (D4 retry): `resolveRunModel(backend, undefined)` = that backend's default | same backend: `view.effort` (= `definition.effort ?? ""`); different: `resolveRunEffort(backend, resolved.effort)` | specialist-run.server.ts:214-236, 1440-1487; deployment-view.server.ts:160-166 |
| operator | `overrides.backend ?? deploymentBackend(view)` (first declared; Claude if none) | declared backend: `resolveRunModel(backend, view.model)`; override: `defaultModelFor(backend)`; no deployment: `defaultModelFor(overrides.backend ?? "claude")` | declared backend: `view.effort || ""`; override or undeployed: `""` | operator-actions.server.ts:400-470; spec.effort set only if truthy at operator-run.server.ts:2191, :2862 |
| controller | always `"claude"` | `resolveRunModel("claude", config.model)` per turn (fresh and resume) | `config.effort` when set | controller-run.server.ts:227, :356, :414-446 |
| every run (funnel) | `startRun`: `foreignModelBackend(input.backend, input.model)` -> substitute `defaultModelFor(backend)` and write the disclosure; `spec.effort = resolveRunEffort(input.backend, input.effort)` only when effort is non-empty | | | run-service.server.ts:759-776, :866-871 |
| Claude adapter | `resolveClaudeModel(spec.model)`: split `[variant]`, dated `claude-*\d` verbatim, contains opus/haiku/sonnet -> alias, else `undefined` (SDK default); `resolveClaudeEffort`: low/medium/high/xhigh/max else `undefined` | passed as `options.model` / `options.effort` | | claude-runtime.server.ts:136-190, :1040, :1106-1112 |
| Codex adapter | `threadOptions.model = spec.model` verbatim; `modelReasoningEffort = resolveCodexReasoningEffort(spec.effort)` (minimal/low/medium/high/xhigh/max, else omitted) | | | codex-runtime.server.ts:227-241, :843-856 |

Substitution disclosure (run-service.server.ts:759-776, :1620-1640): the run row stores the
model that actually ran; the run log's FIRST line is a `meta` line tagged
`run·model_substituted` (`MODEL_SUBSTITUTED_TAG`, :717) with text:
`The agent's model **<DisplayName>** (`<id>`) is a <Claude|Codex> model and cannot run on
<Backend>, so this run used `<default>` instead. Pick a model from this backend's list on the
agent profile.` Only a FOREIGN id triggers this; an id unknown to both backends is substituted
silently by `resolveRunModel` at the call sites above (no line).

Roster view fields (agents-query.server.ts:430-447): `model` (stored), `modelKnown =
isKnownModel(primary, model)`, `modelLabel = modelDisplayName(primary, resolveRunModel(...))`,
`modelUnavailable` from marks, `effort = def?.effort ?? ""`. Badge when `!modelKnown`:
"default" with title `The saved model "<model>" isn't a recognized model id, so runs use the
default (<modelLabel>). Open Edit profile to pick a model.` (agents-page.tsx:1038-1046).

Seeded values (agent-catalog.server.ts:82-172; docs §10 agree): `operator` backends
`["claude","codex"]`, model `orchestration runtime` (sentinel, `NO_MODEL_PLACEHOLDER` in
controller-profile.server.ts:164); `developer` backends `["claude","codex"]`, model `sonnet`;
`reviewer` backends `["claude"]`, model `sonnet`. No seeded effort: seeded deployments carry no
`definition`, so `effort` is `""` and the SDK default applies (Claude: high; Codex CLI default)
until an editor save writes one.

DRIFT (docs claim, code disagrees): agents-and-runtime.md §2.3 says Codex "`minimal` accepted
at run time", model-catalog.server.ts:127-130 says "`resolveCodexReasoningEffort` still
accepts it so a profile that already stored it keeps running on its tier", and ruling 139
protects "a deployment storing a legitimately preserved tier (Codex `minimal`)". But every
run passes `resolveRunEffort` first (run-service.server.ts:870), which maps `minimal` (not in
`CODEX_EFFORTS`) to `low` by rank. A stored `minimal` never reaches the Codex adapter; it runs
`low`, with no disclosure line.

---

## 4. Backend availability per person (ruling 127)

Verified in app/server/runtimes/backend-credentials.server.ts:765-828, :894-935 and
run-principal.server.ts:64, :107-135, :160-193.

- No instance-level backend. Principal: task owner for every task run (operator, specialist,
  resume, scheduled, boot recovery, retry); the asker for a controller turn. Persisted as
  `agent_runs.credential_user_id`.
- `userBackendHealth(db, userId, backend)` needs a `user_backend_credentials` row:
  `api_key`/`access_token` -> available (`verification: "credential"`); `login` -> the vendor
  file in `<dataRoot>/runtimes/users/<userId>/{claude-home,codex-home}` (`"file"`), or on
  darwin the home dir alone (`"presence"`); else unavailable (`"none"`).
- Exact `detail` sentences (`CONNECT_HERE = "Profile → Agent accounts"`, :104):
  - no row: `Claude isn't connected. Connect it on your Profile → Agent accounts.` (or Codex)
  - login row, file gone: `Your Claude sign-in file is missing from this server (the runtime
    volume was wiped). Sign in again on your Profile → Agent accounts.`
  - sealed key cannot be opened (spawn time only, :944-953): `Your Claude key can no longer be
    decrypted on this server (the encryption key changed). Connect Claude again on your
    Profile → Agent accounts.`
- `principalRefusalMessage(refusal, backend)` (run error line `run·unavailable`, blocked
  packet body, disabled dispatch control), `NO_PROCESS = "No agent process was started."`:
  - unowned: `<Backend> runs on <KEY> need a task owner: agent runs use the owner's accounts
    and this task has none. Own the task (Assign me) and run the agent again. No agent process
    was started.`
  - owner-missing: `This task's owner account is disabled or gone, so its agents have no
    account to run on. Assign a new owner and run the agent again. No agent process was started.`
  - no-credential: `<Backend> isn't connected for <Name> (<email>), the task owner. Runs on
    this task use the owner's accounts; they can connect <Backend> on Profile → Agent
    accounts.[ <health.detail when the row exists>] No agent process was started.`
- Task page voice (`run-principal-view.ts:83-112`): viewer IS owner -> `<health.detail or
  "<Backend> isn't connected. Connect it on your Profile → Agent accounts."> Runs on this task
  use your own account.`; other owner -> `<Backend> isn't connected for <ownerName>, the task
  owner. Runs on this task use the owner's account: they can connect <Backend> on Profile →
  Agent accounts.`; row mark: `<Backend> not connected for <ownerName>`; no owner: `no task owner`.
- Controller (controller-run.server.ts:302-330; page constant controller-page.tsx:57-60):
  `The controller runs on your own Claude account, and Claude isn't connected for you yet.
  Connect it on your Profile → Agent accounts, then send your message again.` (composer
  disabled with the same sentence; written into the transcript on send). Wiped file:
  `<health.detail> The controller runs on your own Claude account, so I cannot answer until
  it is connected.` Disabled/deleted asker: `Your account is disabled or gone, so there is no
  Claude account for the controller ...`.
- Agents page (agents-page.tsx:167-173, :1070-1080): roster note `Runs use the task owner's
  <Backend> account · <n> of <m> members connected`; viewer note `You haven't connected
  <Backend>. Runs use the task ...` (def-note).
- Profile editor backend chips are ALWAYS live; if the viewer lacks the picked backend a
  note reads `You haven't connected <Backend>. You can still pin this profile to it: runs use
  the task owner's account, so it runs on tasks owned by people who have connected it.
  Connect <Backend> on your Profile → Agent accounts to run it on the tasks you own.`
  (create-profile-modal.tsx:494-559).
- Profile card badges (agent-accounts-panel.tsx:542): `signing in` / `connected` /
  `not connected`; sign-in buttons `Sign in with Claude`, `Sign in with Console`,
  `Sign in with ChatGPT` (:48-50); refusal pills `refused by the provider · <when>` and
  `usage window spent ... reopens <when>` (:628-632). Route `/profile`, intents
  `backend-login-start`, `backend-login-code`, `backend-login-cancel`, `backend-set-key`,
  `backend-disconnect`; poll `/resources/backend-login?backend=claude|codex`.
- `/resources/model-catalog?backend=` (resources.model-catalog.ts): `requireUser`; unknown
  backend -> claude; passes the viewer's own `runCredentialFor(db, user.id, "claude")` only for
  Claude and only when it resolves (AppError -> curated).

---

## 5. Every surface where model / effort / backend can be set

Legend for the two probe combinations: A = `gpt-6-astra` + `medium` (Codex), B = `opus` +
`high` (Claude).

| # | surface | route / entry | write | fields | A | B | notes |
|---|---|---|---|---|---|---|---|
| 1 | Project agents page, "New agent profile" modal (`data-screen-label="Agent profile modal"`) | `/projects/:slug/agents`, intent `create-profile`, form field `payload` (JSON) | `createAgentProfile` (project admin: `manage-agents`) | payload keys `name`, `role`, `backend` (`"codex"|"claude"`, chips labelled "Codex"/"Claude", `data-field="backend"`), `stages[]`, `definition`, `persona`, `model`, `effort`, `caps{}`, `resources{skills,mcps,kb}` | yes | yes | Model select `aria-label="Model"` (id `<uid>-model`), Effort select `aria-label="Effort"` (`<uid>-effort`), options from `/resources/model-catalog`; efforts narrowed per selected model; Save held while `model === ""` with footer `Loading the models available on <Backend>. Saving is held until this profile has one of them.` / `Pick a model available on <Backend>. Saving is held until this profile has one.` / `Couldn't load the models available on <Backend>. Retry above, then pick one. ...` (create-profile-modal.tsx:1480-1510). Empty model/effort -> backend defaults server-side (agent-profile-actions.server.ts:474-476). Switching the backend chip clears model+effort on the click (:1385-1410). Verified project.agents.tsx:174-186 |
| 2 | Same modal, "Edit <name>" for a SPECIALIST | intent `update-profile`, fields `profileId` + `payload` (with `fingerprint`) | `updateAgentProfile` | as above; single backend chip; a two-backend seeded profile shows `Saving pins this profile to one backend. It currently declares Claude and Codex; Codex will be dropped.` | yes | yes | Effort validated only when CHANGED (`assertEffortForBackend`, :722-725); model validated only for FOREIGN ids (`parseForm`, :283-296; no `assertModelForBackend` here). Stale editor refused: `This profile changed while the editor was open. Reopen it to see the current grants, then save again.` (:707-711). Toast `Profile "<name>" updated · changes apply from the next run` |
| 3 | Same modal, "Edit Operator" (kind operator) | intent `update-profile`, `profileId: "operator"` | `updateAgentProfile` (isOperator branch) | backend chip, **Default autonomy** chips (Supervised / Full autonomy), Model, Effort, stages, definition/persona, operator capability rows with 4 modes | yes (Codex operator) | **yes** | This is where the OPERATOR is put on opus+high: chip Claude, Model "Claude Opus", Effort "High". Stored on `project.md agents[operator].definition {backends:["claude"], model:"opus", effort:"high", autonomy}` (:775-795). Roster row shows **Autonomy**, not Model, for the operator (agents-page.tsx:1024-1034): the operator's model/effort are visible only in the modal and `get_project` |
| 4 | Project agents page, "Add from library" | intent `deploy-profile`, field `profileId` | `deployAgentProfileFromLibrary` | NO model/effort inputs on this page (project.agents.tsx:188-204) | no | no | Template model kept if not foreign, else backend default; effort = backend default; grants = template's or `conservativeGrantsFor` (delivery withheld). Toast `"<name>" added from the global library · the operator can assign it now` |
| 5 | Org settings, Agent resources tab, global agent template modal | `/org/settings`, intent `agent-save` (fields `profileId`, `name`, `backend`, `summary`, `role`, `persona`, `stages`, `skills`, `mcps`, `kbs`) | `saveGlobalAgentProfile` (org admin) | backend only; **no model, no effort** (org.settings.tsx:592-609; gagents.server.ts:453-454 writes `model: ""`); no capability UI | no | no | A template therefore deploys at the backend default model+effort unless overridden via #4 (no) or #8 (yes) |
| 6 | Controller tool `save_global_agent` | `viberr_controller` (org admin) | same as #5 | `id?`, `name`, `backend` enum, `summary`, `persona?`, `stages[]`, `skills?`, `mcps?`, `kbs?` | no | no | verified controller-toolkit.server.ts:682-752 |
| 7 | Org settings, Controller settings tab (`data-screen-label="Controller settings"`) | `/org/settings`, intent `controller-save`, fields `model`, `effort`, `definition`, `skills`, `kb`, `mcps` (newline lists) | `saveControllerConfig` (org admin) | Model + Effort via `ModelEffortFields` with `useModelCatalog("claude")` (backend fixed) | no (Claude only) | yes | Model/effort always editable; skills/kb/mcps/instructions locked unless `VIBERR_UNLOCK_CONTROLLER_{SKILLS,KB,MCPS,INSTRUCTIONS}=enabled`; lock refusal `The controller's <section> are locked on this deployment. Set <VAR>=enabled in the app environment and restart to edit them.` Audit `org.controller.updated` (details model, effort, counts, definitionEdited). Toast `Controller updated. Changes apply from its next turn`. NOTE: no `assertEffortForBackend`/`assertModelForBackend` on this path (controller-profile.server.ts has no such import); `""` effort deletes the key |
| 8 | Controller tool `deploy_agent` | `{projectSlug?, profileId, model?, effort?}` (project admin via `manage-agents`) | `deployAgentProfileFromLibrary` with overrides | model/effort checked by name against the TEMPLATE's primary backend (`fm.backends[0]`) | yes (if the template is Codex) | yes (if Claude) | Reply `[done] <name> deployed on <slug>. Runs on <Backend> with model <model> at effort <effort>. Delivery starts withheld; open it up with update_agent_deployment when the profile should write the repo.` Audit `project.agent_profile.deployed` with `model`, `effort` |
| 9 | Controller tool `update_agent_deployment` | `{projectSlug?, profileId, capabilities?[{capabilityId, mode}], backend?, model?, effort?, stages?, autonomy?}` | `updateAgentProfile` | backend switch with no effort -> default effort (and default model when no model given) | yes | yes; operator too (`profileId: "operator"`, `backend: "claude"`, `model: "opus"`, `effort: "high"`) | Refusals before any write: `capabilityPatchRefusal` (see §6), `autonomy is an operator setting; <name> is a specialist. Nothing was written.`, unknown stage `"<id>" is not a stage of <slug>. Nothing was written. The project's stage ids are: ...`, `assertEffortForBackend`, `assertModelForBackend`. Reply `[done] <name> updated on <slug>.[ Backend switched to <B>: effort reset to its default (<e>) and model to <m>.][ Effort is now <e>.][governance][notes]` |
| 10 | Task page run controls | `/projects/:slug/tasks/:key`, intents `run-agent` / `run-operator`, optional form field `backend` | `backendOverride` (D4 retry) | backend only; no model/effort | n/a | n/a | Override pins `engagement.pinnedBackend` only on a deliberate stuck-retry (specialist-run.server.ts:2124-2125) |
| 11 | Controller tool `run_agent_on_task` | `{projectSlug?, taskKey?, agent, prompt?}` | `runOperator` / `startAgentRun` | no backend/model/effort | n/a | n/a | verified :1392-1446 |
| 12 | Controller tool `get_project` | read | per deployment: `profileId, name, kind, backends, stages, model, modelLabel, effort, capabilities[{capabilityId, mode, label}]`, operator adds `autonomy` | | | | from `assembleAgentRoster` (:938-964) |
| 13 | Controller tool `list_capabilities` | read | `{note, kinds:{operator:{modes:[direct,recommend,human,off], capabilities:[{id,label,whenUngranted,alwaysHuman}]}, agent:{modes:[direct,human,off], ...}}, alwaysHuman:[...]}` | | | | :274-310 |

DRIFT (tool descriptions vs code): `deploy_agent.effort` and `update_agent_deployment.effort`
describe Codex tiers as `low|medium|high|xhigh` (controller-toolkit.server.ts:1705, :1741),
but `CODEX_EFFORTS` includes `max` and `assertEffortForBackend("codex","max")` passes. A
controller reading its own schema may refuse or talk a person out of Codex `max`. Docs
(agents-and-runtime.md §2.3) already say Codex offers `max`.

"Orchestration runtime": the seeded operator template's `model:` sentinel
(app/server/seed/assets/operator.profile.md:10; agent-catalog.server.ts:87). `isKnownModel`
returns false for it, so `resolveRunModel` substitutes the backend default silently
(`sonnet` on Claude, `gpt-5.6-terra` on Codex). Once the operator is saved from the editor
its definition stores a real model and the sentinel is gone
(agent-profile-actions.server.ts:779-783). The operator system prompt names the model and
effort it received (operator-run.server.ts:3342).

---

## 6. Controller capability writes: refusals by name (ruling 139)

`capabilityPatchRefusal(kind, patches)` (verified app/features/agents/capability-catalog.ts:258-297):

- matrix-only id: `"<id>" is a matrix-only capability with no toggle: it describes persona
  guidance and cannot be granted or withheld. Nothing was written. The ids <the operator|a
  specialist> takes are: <list> (see list_capabilities).`
- other kind's id: `"<id>" is an operator capability and cannot be set on a specialist.
  Nothing was written. ...` (and the mirror)
- unknown: `No capability answers to "<id>". Nothing was written. The ids ... takes are: ...`
- specialist recommend: `"<id>" cannot be set to recommend on a specialist: recommend is an
  operator-only mode (a specialist runs a grant directly or not at all). Use direct, human or
  off. Nothing was written.`
- always-human non-human: `"<id>" is reserved for humans and can only be human. Nothing was written.`
- verdict: `"report-validation-verdict" takes only direct or off: verdict authority is
  explicit and is never widened or reserved. Nothing was written.`

`update_agent_deployment` seeds the write from the RESOLVED roster grants (not the raw file)
so an unrelated patch never re-arms withheld capabilities (:1783-1797); it sends
`deploymentFingerprint(deployment)` so its own read-modify-write is never refused (:1810).

---

## 7. Reviewer / verdict profiles and backend

- There is NO code rule that a verdict-capable (reviewer) profile must be Claude. The SEED
  pins `reviewer` to `backends: ["claude"]` (agent-catalog.server.ts:169-170) and docs §10
  say "claude". The editor lets an admin switch it to Codex (single chip). Verified by grep:
  no `verdict`+`backend` coupling anywhere in app/server/tasks or app/features/agents.
- What is Claude-only for a reviewer: `comment-on-task` (mid-run comments), `read-github-api`
  (never mounted on Codex), the scoped delivery denies. Verdicts, ask-human and evidence are
  gated server-side on BOTH backends (`ENFORCED_CAPABILITY_IDS`).
- A Codex-only choice on a Claude-only profile (e.g. `gpt-6-astra` while backend is Claude):
  - project editor: cannot happen through the picker (backend switch clears the model, Save
    held); a hand-posted payload is refused by `parseForm`: `GPT-6 Astra is a Codex model.
    Claude cannot run it. Pick a model from the Claude list.` (agent-profile-actions.server.ts:288-296)
  - controller `update_agent_deployment` / `deploy_agent`: same sentence from
    `assertModelForBackend`.
  - already stored (pre-guard file, hand edit): run-time substitution to `sonnet` with the
    `run·model_substituted` first log line (§3) and a `logger.warn`; the roster shows the
    "default" badge.
  - Codex effort `minimal` on Claude: `resolveRunEffort("claude","minimal")` -> `low`.
- Library deploy of a template whose model is foreign to its backend: not refused; falls back
  to the backend default and records it (agent-profile-actions.server.ts:637-657).

---

## 8. Operator specifics

- Kind `operator`, one per project, ensured at boot (`ensureBaseAgentsDeployed`); cannot be
  deleted from the agents page (`canDelete = a.kind !== "operator"`, agents-page.tsx:815).
- Operator modes: all four; `completion-for-acceptance` not promotable; direct acceptance is
  live only with `autonomy: full` AND `completion-for-acceptance: direct`. Saving that
  combination emits the governance notice `<name> now runs at full autonomy with "Accept
  completion into Done" granted. It can move tasks to Done without a human.` and audit
  `project.operator.autonomy_changed` (agent-profile-actions.server.ts:850-905).
- Autonomy is a ceiling per run: `clampAutonomy(overrides.autonomy, configuredAutonomy)`
  (operator-actions.server.ts:450-453). A schedule pins no backend/autonomy (ruling 94).
- Codex operator runs are `read-only` sandbox, no network (codex-runtime.server.ts:411-441).
- Operator on opus+high: surface #3 or #9 above. Operator effort is stored only when the
  form sends one (`isOperator ? {} : {effort: default}`, agent-profile-actions.server.ts:785-789)
  and reaches the run only when truthy (operator-run.server.ts:2191).

---

## 9. Audit action names and tables touched

| action | where |
|---|---|
| `project.agent_profile.created` | createAgentProfile (details name, role, backend, projectName, coupling keys) |
| `project.agent_profile.deployed` | deployAgentProfileFromLibrary (details name, source:"library", projectName, model, effort) |
| `project.agent_profile.updated` | updateAgentProfile (details name, role, backend, operatorAutonomy, acceptCompletionIntoDone, acceptCompletionActsDirectly) |
| `project.operator.autonomy_changed` | updateAgentProfile governance transition |
| `org.controller.updated` | saveControllerConfig |
| `model_availability` (table) | provider-refused model marks per backend |
| `user_backend_credentials` (table) | per-person backend rows (`kind`: api_key / access_token / login; `method`) |
| `agent_runs.credential_user_id` (column) | the run's principal |
| `instance_settings` | `backendRateLimit.<backend>`, `backendQuotaExhausted.<backend>` (docs §2.3; not re-read) |

Files: `project.md` `agents[]` = `{profileId, capabilities[{capabilityId, mode}], extras[],
definition{kind, name, role, icon, backends[], model, effort, scope, desc, persona, stages,
spanAll, autonomy, resources}}` (project-file.schema.ts:82-120); org templates
`<dataRoot>/agents/profiles/<id>.md`; controller profile `agents/profiles/controller.md` +
doctrine file.

---

## 10. Drift candidates (docs or comments vs code)

1. Codex `minimal` is NOT preserved at run time: `resolveRunEffort` (run-service.server.ts:870)
   clamps it to `low` before `resolveCodexReasoningEffort` ever sees it. Contradicts
   agents-and-runtime.md §2.3, model-catalog.server.ts:127-130 and ruling 139's stated reason
   for the "changed value only" editor check.
2. Controller tool descriptions list Codex efforts as `low|medium|high|xhigh`
   (controller-toolkit.server.ts:1705, :1741) while the catalog and validator accept `max`.
3. `assertEffortForBackend` is backend-wide: `gpt-5.5` + `max` is accepted by `deploy_agent` /
   `update_agent_deployment` and stored, although the catalog lists GPT-5.5 to `xhigh`; the
   picker clamps per model, the tools do not.
4. Org settings `controller-save` performs no model/effort validation (ruling 139 covers the
   controller tools and the profile editor; the controller tab stores whatever the form posts).
5. The operator's model and effort are invisible on the agents roster (the operator row shows
   Autonomy in the Model cell's place); only the edit modal and `get_project` show them, and
   the "default" substitution badge for the seeded `orchestration runtime` sentinel is never
   rendered for the operator.
6. The project agents page's "Add from library" (`deploy-profile`) takes no model/effort,
   while the controller's `deploy_agent` does; global templates store `model: ""`.
7. Comment drift: agents-query.server.ts:317-323 still describes the retired R7-5
   recommend-to-direct coercion for specialists (ruling 81 replaced it with recommend-to-off).

---

## Gap fill: Which backend a two-backend deployment actually runs on (clarify primaryRunBackend)

Amends §3 row "specialist (fresh)" and the operator row. Every claim below is verified
against the working tree of `pass35/k9s-clone-observation` on 2026-09-06.

### G.1 The rule, verbatim (app/server/agents/deployment-view.server.ts:154-166)

```ts
/**
 * The backend a run uses when a profile declares more than one: the FIRST real
 * one, Claude if none is named. The roster, board glyphs and review queue must
 * DISPLAY the same backend the run starts on, so the rule lives once and
 * everyone delegates.
 */
export function primaryRunBackend(
  backends: readonly string[],
): "codex" | "claude" {
  return backends.find((b) => b === "codex" || b === "claude") === "codex"
    ? "codex"
    : "claude";
}
```

Plain reading: **the first declared backend wins. Codex runs only if `codex` is listed
BEFORE `claude`.** `["claude","codex"]` runs Claude; `["codex","claude"]` runs Codex;
`[]` or junk runs Claude. The phrase "first of codex/claude" in §3 was ambiguous (it could
be read as "codex if present anywhere"); replace it with "the first declared backend
(Codex only when it is listed before Claude; Claude when nothing real is listed)".

`backends` reaching this function: `deploymentRuntimeIdentity` returns
`def?.backends ?? template?.backends ?? []` (deployment-view.server.ts:189), where `def`
is the project.md `agents[].definition` override parsed tolerantly (junk entries filtered
out, :115-120) and `template` is `<dataRoot>/agents/profiles/<id>.md` frontmatter (:72).

### G.2 Every copy of the rule (all equivalent for a valid enum array)

| site | expression | equivalent? | verified |
|---|---|---|---|
| operator authority | `deploymentBackend(view)`: `view.backends.find(b => b==="claude"\|\|b==="codex") === "codex" ? "codex" : "claude"` | yes, a duplicate of G.1 (comment calls itself "The ONE rule", B-OP5) | operator-actions.server.ts:328-332 |
| specialist run | `pickBackend(view) = primaryRunBackend(view.backends)` | delegates | specialist-run.server.ts:214-220 |
| roster / get_project | `primaryRunBackend(backends)` for `modelKnown`/`modelLabel`/marks | delegates | agents-query.server.ts:435 |
| display overlay map | `deployedSpecialistBackends` -> `primaryRunBackend(backends)` per non-operator deployment | delegates | deployment-view.server.ts:210-227 |
| controller `deploy_agent` (library) | `fm.backends[0] === "codex" ? "codex" : "claude"` | yes (template `backends` is filtered to codex/claude, so `[0]` is the first real one) | agent-profile-actions.server.ts:611 |
| controller `update_agent_deployment` | `currentBackend = view.backends[0] === "codex" ? "codex" : "claude"` | yes | controller-toolkit.server.ts:1812 |
| agents page primary glyph/health | `a.backends[0] ?? null` | yes (null when empty) | agents-page.tsx:102-104 |
| profile editor initial backend | `initial.backends[0] ?? ""` | yes | create-profile-modal.tsx:1333 |
| policy page / capability matrix "codexPrimary" | `p.backends[0] === "codex"` | yes | policy-page.tsx:361, capability-matrix-modal.tsx:188 |
| org library page (`/org/agents`) | `fm.backends[0] === "claude" ? "claude" : "codex"` | **INVERTED default**: an empty `backends` shows Codex here and runs Claude everywhere else | gagents.server.ts:158 |

`deploymentBackend` and `primaryRunBackend` are two identical functions in two files;
neither imports the other (operator-actions.server.ts:328, deployment-view.server.ts:160).

### G.3 Precedence per run kind

| run kind | backend expression | verified |
|---|---|---|
| specialist fresh run (deliverer OR supporting, same function) | `input.backendOverride ?? engagement.pinnedBackend ?? resolved?.backend ?? (engagement.backend === "codex" ? "codex" : "claude")` where `resolved.backend = primaryRunBackend(live deployment backends)`; `resolved` is undefined only when `resolveDeployedSpecialist` throws (profile undeployed since engagement) | specialist-run.server.ts:1430-1449 |
| `@agent` mention reply | `primaryRef.pinnedBackend ?? sp?.backend ?? snapshot` (no override slot; `sp.backend` is the roster's primary) | agent-reply.server.ts:347-350 |
| by-name mention of the delivering agent | `pinned ?? matched.backend`; pin applies ONLY when the mention names the specialist; an explicit `@claude`/`@codex` handle is never overridden by the pin | agent-reply.server.ts:383-388 |
| operator | `overrides.backend ?? deploymentBackend(view)`; `overrides.backend` is set only from the Run-operator picker (`input.backend`, operator-run.server.ts:1424; comment at :2932-2935 says every machine trigger passes none) | operator-actions.server.ts:433-434 |
| operator, no deployment | `overrides.backend ?? "claude"` | operator-actions.server.ts:415 |
| controller | `"claude"` always | controller-run.server.ts (see §3) |

Model/effort follow the backend, not the profile, whenever the run backend differs from
`resolved.backend`: `model = resolveRunModel(backend, undefined)` (that backend's default),
`effort = resolveRunEffort(backend, resolved.effort)` (specialist-run.server.ts:1477-1486).
Same-backend runs keep `resolved.model` / `resolved.effort`. The operator does the same
(`defaultModelFor(backend)` and `effort: ""` when overridden, operator-actions.server.ts:441-444, :464).

### G.4 When `engagements[].backend` is written, healed, and pinned

| moment | what is written | verified |
|---|---|---|
| engage (assign deliverer) | `ref = {profileId, backend: specialist.backend, role}` where `specialist = toResolved(view)` -> `pickBackend` at THAT moment; row is `{...existing, ...ref, delivers: true, ...}` (an existing `pinnedBackend` is carried across) | specialist-run.server.ts:771-774, :796-806 |
| engage (supporting / reviewer) | `backend: reviewer.backend`, same resolution | specialist-run.server.ts:933, :945, :998, :1007 |
| auto-engage by dispatch | same `ref` shape (ruling 98; the engagement is written by the dispatch) | specialist-run.server.ts:1159-1171 (input shape), docs agents-and-runtime.md:31-33 |
| run start heals the snapshot | `if (engaged && engaged.backend !== backend) engaged.backend = backend;` so the row says what actually ran | specialist-run.server.ts:2114-2118 |
| run start pins | `if (engaged && input.backendOverride) engaged.pinnedBackend = input.backendOverride;` ONLY an explicit override pins; a plain profile-edit run never pins | specialist-run.server.ts:2124-2126 |
| pin cleared | **never**: the only write to `pinnedBackend` in the tree is the line above; another `retry_other_backend` re-pins to its target (task-actions.server.ts:7073-7075 "until another retry re-pins it") | grep `pinnedBackend =` across app/ (one hit) |

`backendOverride` sources (the only two):
- task page dispatch form field `backend` (`"claude"`/`"codex"`, anything else ignored) -> `startAgentRun({... backendOverride})` (app/routes/project.task.tsx:428-431, :886). The Agent-logs "Retry on <other>" button posts this (runs-panels.tsx:467-479, `onRetryBackend`, offered only for backends in `retryBackends`, ruling 127).
- packet option kind `retry_other_backend` -> `startAgentRun({projectSlug, taskKey, backendOverride: target, profileId?})` under `OPERATOR_TASK_ACTOR`, `operatorAuthorized: true` (task-actions.server.ts:7796-7808). Timeline: `**Decision:** <option.t>. Re-running on <Claude|Codex> with a fresh context.` (:7085-7086).

Display between a profile edit and the next run (ruling at decisions.md:1380-1409):
`withLiveAgentBackends` overlays `deployedSpecialistBackends` onto the task summary's
`specialist`/`reviewers`; a `pinnedBackend` row is returned untouched (pin wins over the
live profile) (app/shared/mapping/task.server.ts:420-445); the agents page's per-task chips
use `ref.pinnedBackend ?? liveBackends.get(profileId) ?? ref.backend` (agent-deployments.server.ts:143).
Stored records are NOT rewritten by display.

### G.5 Worked line: the seeded `developer` on the k9s-clone project

Seed facts (app/server/seed/agent-catalog.server.ts:118-131, :86-87): `developer` template
`backends: ["claude","codex"]`, `model: "sonnet"`; `operator` template `backends:
["claude","codex"]`, `model: "orchestration runtime"`; `reviewer` `["claude"]`. Seeded
project deployments carry no `definition`, so `backends` is the template's.

| step | project.md `agents[developer].definition.backends` | `primaryRunBackend` | run row (`agent_runs.backend`, `.model`) | task.md `engagements[developer].backend` |
|---|---|---|---|---|
| before any edit | absent (template `["claude","codex"]`) | `claude` | `claude`, `resolveRunModel("claude","sonnet")` (§2.1 alias) | `claude` at engage time |
| controller `update_agent_deployment {profileId:"developer", backend:"codex"}` | `["codex"]` (editor always stores `backends: [form.backend]`, agent-profile-actions.server.ts:785) plus `model: defaultModelFor("codex")`, `effort: defaultEffortFor("codex")` because `switched` and neither was passed (controller-toolkit.server.ts:1812-1830) | `codex` | next fresh run: `codex`, Codex default model | still `claude` until that run; display already shows Codex (overlay); the run heals it to `codex` and posts `Started a Codex run for the Implementation agent (switched from Claude) — streaming to the agent logs.` (specialist-run.server.ts:2099, :2128-2131; the em dash is in the source) |
| same call, but the engagement carries `pinnedBackend: "claude"` from an earlier `retry_other_backend` | `["codex"]` | `codex` | run on `claude` (pin beats the live profile, :1446); Claude default model, effort re-resolved | row keeps `claude`; overlay shows Claude (pin honoured); no UI clears the pin |
| `update_agent_deployment {backend:"codex", model:"gpt-5.5", effort:"high"}` | `["codex"]`, `model: "gpt-5.5"`, `effort: "high"` (validated by `assertModelForBackend`/`assertEffortForBackend` against `codex` BEFORE the write, :1815-1816) | `codex` | `codex`, `gpt-5.5` | as above |

Controller reply after the plain switch (controller-toolkit.server.ts:1853-1859):
`[done] Developer updated on <slug>. Backend switched to Codex: effort reset to its default (<effort>) and model to <model>.`
With `effort` passed: `... Effort is now <effort>.` instead of the reset clause. The
`effort` parameter description still reads `Codex low|medium|high|xhigh` (:1741; drift item 2).

`deploy_agent` from the library keeps the template's list: `backends: fm.backends.length ?
fm.backends : [backend]` (agent-profile-actions.server.ts:630), so a freshly deployed
Developer is `["claude","codex"]` -> Claude, and its reply says `Runs on Claude with model
<model> at effort <effort>.` (controller-toolkit.server.ts:1718-1720).

A hand save in the profile editor (Edit profile modal) behaves like the tool: the backend
select starts at `backends[0]` (create-profile-modal.tsx:1333) and the save stores
`[form.backend]`, so the two-element list survives only until the first save of ANY field.

### G.6 On-disk and on-screen proof of the backend a run used

| proof | where | verified |
|---|---|---|
| `agent_runs.backend` (`CHECK (backend IN ('claude','codex'))`), `agent_runs.model` (NOT NULL, the model that ACTUALLY ran after foreign-model substitution), `agent_runs.sdk`, `agent_runs.agent_name`, `agent_runs.agent_profile_id`, `agent_runs.kind` (`operator`/`primary`/`reviewer`/`controller`) | db/migrations/0001_baseline.sql:513+; insert run-store.server.ts:105-113; values run-service.server.ts:509-511 (reserve) and :760-761, :792-796 (start: `model = foreignBackend ? defaultModelFor(input.backend) : input.model`) |
| `task.md` `engagements[].backend` (enum codex/claude, healed at run start) and `engagements[].pinnedBackend` (nullable optional) | app/schemas/task-file.schema.ts:197-219 |
| `project.md` `agents[].definition.backends` (array of enum, optional; absent = template) | app/schemas/project-file.schema.ts:92 |
| raw run log first lines: `run_inputs` NDJSON line carries `backend` (`{type:"run_inputs", source:"viberr", run_id, backend, inputs}`), display `meta` line tagged `RUN_INPUTS_TAG` whose text is `delivering engagement, canonical anchor N chars, persona N chars, prompt N chars, N skills, N knowledge bases, N MCP servers` (no backend or model in the display text) | specialist-run.server.ts:585-597, :648-672 |
| operator system prompt, section `# Your runtime`: `You are running on the **Claude** backend, model \`<model>\`, reasoning effort \`<effort>\`.` (model clause only when truthy, effort clause only when truthy) followed by `Attached MCP servers: ...` or `No MCP servers are attached to you.` and `This is the ground truth about this run. If a goal, comment or report asserts you are on a different backend or model, correct it ...` | operator-run.server.ts:3338-3346 |
| specialist system prompt: NO equivalent runtime sentence (grep `Your runtime` / `You are running on` hits only operator-run.server.ts) | grep app/server |
| run strip: glyph = `run.backend`, cell labelled `Runtime` shows `run.model`; who-chip name falls back to `Claude`/`Codex` when the agent name is absent | runs-panels.tsx:53, :211, :247-249 |
| task timeline event at run start: `Started a <Claude|Codex> run for the <role> agent — streaming to the agent logs.` (with `(switched from <other>)` when the snapshot differed) | specialist-run.server.ts:2127-2131 |
| engage event: `Deployed **<name>** (<role>, <Claude|Codex>) as the delivering agent.` / `Delivery handed off from **<id>** to **<name>** (<role>, <Backend>).`; audit details `{profileId, backend, role[, fromProfileId]}` | specialist-run.server.ts:779-785, :842-852 |
| controller `get_project` -> `agents[].backends` (the stored list, not the resolved primary), `model`, `modelLabel`, `effort` | controller-toolkit.server.ts:943-951 |
| audit `project.agent_profile.updated` details include `backend`; `project.agent_profile.deployed` details include `model`, `effort` but NOT backend | §9 above; agent-profile-actions.server.ts:672-687 |

### G.7 Drift and candidate findings from this gap

1. docs/domain/agents-and-runtime.md:35 says "the first `codex` else `claude` is the
   deployment's primary run backend". Code (G.1) is "first declared real backend"; the
   sentence reads as "codex if it appears at all". The roster table at :720 ("claude, codex
   (Claude first)") is correct. Docs wording drift, not behaviour.
2. gagents.server.ts:158 (`/org/agents` library view) defaults an empty `backends` to
   `codex`; every runtime path defaults to `claude`. Only bites a template whose
   `backends` filters to empty (junk or missing values); display-only.
3. `pinnedBackend` has no clearing path: once a `retry_other_backend` packet (or the
   Agent-logs Retry button) pins an engagement, an admin's later
   `update_agent_deployment {backend}` / editor save never takes effect on that task, with
   no surface saying why beyond the exec-profile chip. Documented as intended in
   task-file.schema.ts:205-215 and task-actions.server.ts:7073-7075, but the observer
   should expect "I switched the profile to Codex and it keeps running Claude" on a task
   that was ever retried.
4. `deploy_agent`'s reply and audit name the resolved backend (`Runs on Claude`), but the
   stored definition keeps the two-element template list, and `get_project` returns the
   list, not the resolved primary; a controller reading `backends: ["claude","codex"]` has
   to know G.1 to answer "which one runs". `update_agent_deployment`'s own read uses
   `backends[0]` (TK:1812), so its reply is right.
5. The specialist run has no `# Your runtime` sentence (operator only, G.6): a specialist
   that reads a comment claiming "you are on Codex" has nothing in its prompt to correct
   it with.
6. `primaryRunBackend` and `deploymentBackend` are duplicate implementations (G.2); a
   future edit to one misses the other. No behavioural difference today.

---

## Gap fill: Seeded roster grants at project creation (operator/developer/reviewer per policy preset)

Section 11 of this file. Everything below was verified against the working tree on
2026-09-06; the observation store (`docker-data/`, project `k9c-k9s-clone`) was read, never
written. PATH CORRECTION for anyone following the brief: the catalog is
`app/server/seed/agent-catalog.server.ts` (there is no `app/server/agents/agent-catalog.server.ts`;
`app/server/agents/` holds only `deployment-view.server.ts`). Abbreviations: CAT =
`app/server/seed/agent-catalog.server.ts`, PC = `app/features/home/project-create.server.ts`,
DV = `app/server/agents/deployment-view.server.ts`, AQ = `app/features/agents/agents-query.server.ts`,
APA = `app/features/agents/agent-profile-actions.server.ts`, TK =
`app/server/controller/controller-toolkit.server.ts`, SR = `app/server/tasks/specialist-run.server.ts`,
STP = `app/server/tasks/specialist-tool-policy.ts`, OA = `app/server/tasks/operator-actions.server.ts`.

### 11.1 What is written into `project.md agents[]` at creation

- `createProject` writes `agents: presetAgents(input.policy, defaultAgentDeployments())`
  (verified PC:455). `defaultAgentDeployments()` = `deployments()` = every
  `SEED_AGENT_PROFILES` entry mapped to `{profileId, capabilities: normalizeDeliveryGrants(seed caps), extras: []}`
  (CAT:204-206, :226-233). **No `definition` key** is written for any of the three; the
  only exception is the `auto` preset's operator, which gets `definition: {autonomy: "full"}`
  (PC:113-116; `a.definition` is undefined so the spread adds nothing else).
- Consequence (verified DV:179-191, AQ:430-509): a seeded deployment's `kind`, `name`,
  `role`, `backends`, `model`, `stages`, `spanAll`, `persona` (template body), `desc` and
  `resources` all come from the ORG TEMPLATE FILE `<dataRoot>/agents/profiles/<id>.md` at
  read time, until some save writes a full `definition` (APA:783-816). `effort` comes ONLY
  from a definition (`def?.effort ?? ""`, AQ:462); the template's `effort` is never read.
  `capabilities` come ONLY from the deployment row; `readTemplate` does not read the
  template's `capabilities:` list at all (DV:67-85).
- `presetAgents` touches ONLY `profileId === "operator"` (PC:88-90, :103-105). Developer and
  Reviewer grants are byte-identical across `strict|balanced|auto`.
- Policy field: home modal `data-screen-label="New project modal"`, chip group labelled
  "Agent policy preset" with chips `Strict human-gate` / `Balanced · recommended` /
  `Autonomous within policy` (`aria-pressed`), default `balanced`
  (new-project-modal.tsx:347-375, :488-489); form field `policy`, anything but
  `strict`/`auto` is read as balanced (`app/routes/_index.tsx:189-193`). Controller
  `create_project` takes `policy` as a required enum (TK; see controller-toolkit.md §3.1).
  The preset is NOT stored (ruling 28, decisions.md:322-334); its effect is read off the
  workflow graph (`humanGatesPreWorkAdvance`, stage-roles.ts:97-104) and off the operator row.
- Boot backfill (`ensureBaseAgentsDeployed`, ensure-base-agents.server.ts:32-90): the
  operator row is re-added to any project missing it; developer + reviewer are re-added only
  to a project with ZERO specialist rows. Backfilled rows are the plain seed shape (no
  preset shaping, no definition), i.e. balanced.

### 11.2 Operator row per preset (`profileId: "operator"`)

Stored list (CAT:110-112 via `mapActions`, every label resolves to a catalog id; verified
against the on-disk copy `data/agents/profiles/operator.md` and the k9c project file):

| capabilityId | strict | balanced | auto | runtime note |
|---|---|---|---|---|
| `dispatch-agents` | direct | direct | direct | |
| `generate-packets` | direct | direct | direct | |
| `append-typed-events` | direct | direct | direct | |
| `stage-transitions` | recommend | recommend | recommend (stored) | `gate()` promotes recommend to direct when the run's autonomy is `full` (OA:525-532), so under `auto` the operator crosses governed boundaries itself |
| `completion-for-acceptance` | recommend | recommend | **direct** (explicit, PC:107-111) | never promoted by autonomy (OA:531; catalog `promotable: false`); live only when autonomy is `full` AND the grant is literally `direct` (both true under `auto`) |
| `deliver-review-pr` | **recommend** (PC:87-101; row is filtered out and re-appended LAST) | direct | direct | R15-2 (ruling 21) |
| `execute-code-or-write-repo` | human | human | human | an agent-kind id stored on the operator row; outside `OPERATOR_CAP_IDS`, so every editor/controller save PRESERVES it untouched (APA:750-759) |
| `transition-to-done` | human | human | human | |
| `change-project-policy` | human | human | human | |
| `update-task-branch` | absent | absent | absent | resolves to the explicit `deliver-review-pr` mode: strict recommend, else direct (AQ:359-368; OA:496-499) |
| `use-web-search-fetch` | absent | absent | absent | resolves direct (OA:500-503; AQ `absentGrantMode`) |
| `definition` | none | none | `{autonomy: "full"}` (PC:113-116) | `readAutonomy(definition)` = full iff literally `"full"` (OA:207-211); view `autonomy` = `def?.autonomy ?? "supervised"` (AQ:447-448) |
| workflow (same file) | every pre-terminal `auto` boundary becomes `approval` with `by: "Human approval (strict policy) before work advances"` (PC:58-69) so `humanGatedBeforeWork` = true | template `governed-5`: `auto, auto, approval, human` (templates.ts:35-42); false | same as balanced; false | only matters when `deliver-review-pr` is ABSENT (`absentDeliverReviewPrMode`, capabilities.ts:630-634); seeded rows always carry it explicitly |

Template identity behind the row (`data/agents/profiles/operator.md`, from
`app/server/seed/assets/operator.profile.md`; CAT:84-101 for the `npm run seed` writer):
`kind: operator`, `backends: [claude, codex]` (Claude runs, §G.1), `model: orchestration
runtime` (sentinel, resolves to `sonnet`), `stages: [triage, ready, impl, review, done]`,
`spanAll: true`, `resources.skills: [viberr-app-expertise]`, `kb: []` in a boot-backfilled
store / `[architecture-notes]` in an `npm run seed` store (default-assets.server.ts:369-388
`kbGrants` vs seed.server.ts:183-188). Docs agents-and-runtime.md:717-720 agree.

### 11.3 Developer row (`profileId: "developer"`), identical under every preset

Stored grants (CAT:161-163; on-disk template `data/agents/profiles/developer.md` shows the
same 12 in the same order):

| capabilityId | stored mode | resolved when absent (AQ:417-421 / STP:135-143) |
|---|---|---|
| `execute-code-or-write-repo` | direct | |
| `create-task-branch` | direct | |
| `commit-push-branch` | direct | |
| `run-unit-integration-validation` | direct | |
| `open-review-pr` | direct | |
| `comment-on-task` | direct | |
| `ask-human` | direct | |
| `move-task-to-review` | direct | |
| `use-browser` | direct | egress rides along explicitly (CAT:153-160; mount gate needs both) |
| `use-web-search-fetch` | direct | |
| `merge-pull-request` | human | |
| `transition-to-done` | human | |
| `report-validation-verdict` | ABSENT | off (grant-required) |
| `read-github-api` | ABSENT | off |
| `attach-evidence-references` | ABSENT | direct |
| `change-project-policy` | ABSENT | human |
| the 8 matrix-only advisory ids | ABSENT | direct (approve/request/flags render off, verdict-gated) |

Derived facts for a seeded developer:
- `specialistGrantModes` sees the headline `direct` (STP:121-133) so
  `resolveDeliveryPermissions` = `{canBranch: true, canCommitPush: true, canOpenPr: true}`
  (STP:227-246). Operator-facing summary `deployedSpecialists[].capabilities` =
  `{delivery: true, verdict: false, askHuman: true, browser: <mount gate>}` (SR:3839-3858).
- `verdictCapable` = `resolveAgentCollab(caps).verdict` = `effectiveCollabMode(caps,
  "report-validation-verdict") === "direct"` = **false** (absent falls to the catalog default
  `off`; agent-outcome.server.ts:381-402, :407-420).
- Claude `disallowedTools` from `CAP_DENY_RULES`: only `Bash(gh pr merge:*)` (merge is
  human). Codex sandbox: headline granted, so `workspace-write`; `danger-full-access` when the
  run is the autonomous PRIMARY with egress granted (codex-runtime.server.ts:431-460, §1.2).
- Template identity: `backends: [claude, codex]` (Claude runs), `model: sonnet`, effort `""`,
  `stages: [ready, impl]`, `spanAll: false`, `skills: [developer-expertise]`, `kb: []` (boot)
  or `[architecture-notes, api-contracts]` (seed) (CAT:116-143).

### 11.4 Reviewer row (`profileId: "reviewer"`), identical under every preset

Stored grants (CAT:187-192; on-disk `data/agents/profiles/reviewer.md` matches, 13 rows):

| capabilityId | stored mode | note |
|---|---|---|
| `read-repo-diff` | direct | advisory |
| `run-validation-suites` | direct | advisory |
| `author-test-cases` | direct | advisory |
| `attach-evidence-references` | direct | evidence field on `report_outcome` |
| `post-quality-flags` | direct | verdict-gated outcome |
| `comment-on-task` | direct | Claude-only tool |
| `ask-human` | direct | |
| `report-validation-verdict` | **direct** | the ONLY seeded profile with it |
| `approve-review` | direct | verdict-gated outcome |
| `request-changes` | direct | verdict-gated outcome |
| `merge-pull-request` | human | |
| `transition-to-done` | human | |
| `commit-push-branch` | human | a REAL deny (`git push`, `git commit`), not an extra (CAT:189-192) |
| `execute-code-or-write-repo` | ABSENT | off: no scoped grant is actionable, so nothing infers the headline (STP:127-131) |
| `create-task-branch`, `open-review-pr` | ABSENT | off |
| `use-web-search-fetch` | ABSENT | direct |
| `use-browser`, `read-github-api` | ABSENT | off |
| `change-project-policy` | ABSENT | human |

Derived facts for a seeded reviewer:
- **`verdictCapable` = true out of the box**; a supporting engagement of this profile is a
  REQUIRED reviewer (`requiredReviewers` = `!delivers && verdictCapable`,
  task-file.schema.ts:894-896) and acceptance waits for its verdict on the current
  `workRevision`. No `update_agent_deployment` call is needed to make the verdict count.
- Delivery: headline withheld, so `{canBranch: false, canCommitPush: false, canOpenPr: false}`;
  summary `{delivery: false, verdict: true, askHuman: true, browser: false}`.
- Claude `disallowedTools`: `Edit`, `MultiEdit`, `Write`, `NotebookEdit`, `Bash(git commit:*)`
  (headline), `Bash(git checkout -b:*)`, `Bash(git checkout -B:*)`, `Bash(git switch -c:*)`,
  `Bash(git switch -C:*)` (create), `Bash(git push:*)` (commit/push), `Bash(gh pr create:*)`,
  `Bash(gh pr merge:*)`. If an admin moves it to Codex: `read-only` sandbox EXCEPT that
  evidence is granted, so ruling 109 keeps `workspace-write` and the withholding is advisory.
- Template identity: `backends: [claude]`, `model: sonnet`, effort `""`, `stages: [impl,
  review]`, `skills: [reviewer-expertise]`, `kb: []` (boot) or `[api-contracts]` (seed).

### 11.5 Eligible stages: what the declared ids mean on a given board

- Declared ids resolve per board in three steps (`resolveDeclaredStages`,
  app/shared/workflow/stage-eligibility.ts:91-111): literal id on the board; else the
  structural ROLE the alias names (`ROLE_BY_ALIAS` :24-46: `triage|todo|backlog|inbox` entry,
  `ready|planned` ready, `impl|doing|in-progress|in_progress|progress|wip|build` work,
  `review|qa|verify` review, `done|complete|completed|shipped` terminal); else dropped.
  `stageEligible` (:136-147): `spanAll` or an empty declared list or a list that resolves to
  nothing = eligible everywhere.
- Board roles (`resolveStageRoles`, stage-roles.ts:41-68): entry = first stage, terminal =
  last, review = the `from` of the edge INTO terminal, work = the `from` of the edge into
  review; `boardStageRoles` (:62-89) adds "ready" = the stage right after entry when work is
  not adjacent to entry.
- Standard board `governed-5`: developer `[ready, impl]` and reviewer `[impl, review]` are
  all literal. Operator spans all.
- The k9s board on disk (`triage, design, impl, validation, review, merge, done`): roles are
  entry `triage`, terminal `done`, review-role `merge`, work-role `review`, ready-role
  `design`. A never-saved seeded developer resolves `ready` -> `design`, `impl` literal ->
  eligible at `design` and `impl`; the stored k9c developer definition says exactly
  `stages: [design, impl]`. A seeded reviewer `[impl, review]` is literal on that board, so
  it cannot be NEWLY engaged at `validation` or `merge`.
- Enforcement: a new engagement at an ineligible stage is refused with
  `<Name> is not eligible for the "<stageId>" stage — its profile is scoped to <resolved ids>.
  Change the task's stage or the profile's eligible stages.` (SR:3683-3694; em-dash in
  source). The RUN boundary admits the engaged DELIVERER at every stage
  (`runEligibilityFor`, SR:3738-3742; ruling 133, decisions.md:2420+) and records
  `stageEligibility: "declared" | "engaged-deliverer" | "undeployed"` on the
  `task.agent.run_started` audit row (SR:1496-1507). Supporting engagements stay stage-scoped.
- `update_agent_deployment.stages` must be LITERAL ids of the project (TK:1785-1791); the
  alias resolution above is not applied to the patch, so `stages: ["ready"]` on the k9s
  board is refused with `"ready" is not a stage of <slug>. Nothing was written. The
  project's stage ids are: triage, design, impl, validation, review, merge, done.`
  Only `args.stages` is checked: a call that omits `stages` re-submits `view.stages` (the
  raw template ids, e.g. `[ready, impl]`) and `updateAgentProfile` stores them verbatim,
  its schema requiring only a non-empty list (APA:207, :808). The stored aliases keep
  resolving per board at run time, so this is harmless, but `get_project` then reports
  `stages: [ready, impl]` on a board that has no `ready` stage.

### 11.6 Template edits vs already-created projects (`save_global_agent`)

- `saveGlobalAgentProfile` update path (gagents.server.ts:391-429): allowed on any
  `kind: specialist` template, INCLUDING the seeded `developer` and `reviewer`; refuses the
  operator/controller (`No such agent profile.`). It spreads the existing frontmatter and
  overwrites `name`, `role`, `desc`, `backends: [<backend>]`, `stages`, `resources` (merge
  semantics), and the body when a persona is sent. It does NOT touch `model` or
  `capabilities`. Audit `org.agent_profile.updated {name, backend}`; toast
  `<name> updated — running threads re-anchor on next turn`; controller reply `[done] <toast>.`
- Effect on projects: a deployment WITHOUT a `definition` (every never-saved seeded row)
  re-resolves against the new template on the next read, so its backend, stages, persona,
  desc and resources change in every such project at once; its grants do not. A deployment
  WITH a definition (any row that went through `update_agent_deployment`, the project
  editor, `deploy_agent`, or project-local create) is untouched. The k9c project's rows all
  carry definitions, so the 13:09Z overwrite of the developer template did not change them.
- On-disk proof of that overwrite: `docker-data/agents/profiles/developer.md` now reads
  `backends: [codex]`, `stages: [design, impl]`, a k9c-specific `desc`, and STILL
  `model: sonnet` (the spread kept it). `isKnownModel("codex","sonnet")` is false
  (model-catalog.server.ts:306-309) and `foreignModelBackend("codex","sonnet")` = claude, so
  any project created from now on in that store gets a developer whose roster row wears the
  "default" badge and whose first Codex run writes the `run·model_substituted` line (§3).
- Missing template edge: if `agents/profiles/<id>.md` is absent, `readTemplate` returns null
  and a definition-less row resolves to `kind: "specialist"`, `backends: []` (Claude),
  `name: <profileId>`, `stages: []` (eligible everywhere) (DV:183-190, AQ:452-495). For the
  OPERATOR row that means `resolveOperatorAuthority` finds no operator and every gate denies
  (OA:396-426, :516). The boot backfill ships `operator.md` as a static asset
  (default-assets.server.ts:145), so this needs a deleted file to happen.

### 11.7 The exact `update_agent_deployment` calls for the observation targets

All three go through `updateAgentProfile` with `caps` seeded from the RESOLVED roster
(TK:1801-1807), `definition: ""`, `persona: ""` (TK:1827-1828; both mean "keep current",
APA:800-807), `stages: view.stages`, `resources: view.resources`. Every call rewrites the
row's `capabilities` to the full editor-governed list, explicit `off` included
(`grantsFor`, APA:320-345), plus the preserved non-governed ids, and writes a full
`definition` (APA:783-816). From then on the org template no longer influences the row.

| target | call | precondition check | reply (exact) |
|---|---|---|---|
| developer = Codex `gpt-6-astra` `medium`, delivering | `update_agent_deployment {projectSlug: "<slug>", profileId: "developer", backend: "codex", model: "gpt-6-astra", effort: "medium"}` | `currentBackend = view.backends[0]` = claude on a pristine template, so `switched` = true but the reset sentence is suppressed because both model and effort were passed (TK:1812-1817, :1853-1858); `assertModelForBackend("codex","gpt-6-astra")` and `assertEffortForBackend("codex","medium")` pass; delivery is already direct from the seed, no `capabilities` patch needed | `[done] Developer updated on <slug>. Effort is now medium.` |
| reviewer = Claude `opus` `high`, verdict direct | `update_agent_deployment {projectSlug: "<slug>", profileId: "reviewer", model: "opus", effort: "high", capabilities: [{capabilityId: "report-validation-verdict", mode: "direct"}]}` | backend unchanged (claude), no reset; the verdict patch is redundant (seed already direct) but passes `capabilityPatchRefusal` (direct is one of the two allowed modes) | `[done] Reviewer updated on <slug>. Effort is now high.` |
| operator = Claude `opus` `high` | `update_agent_deployment {projectSlug: "<slug>", profileId: "operator", backend: "claude", model: "opus", effort: "high"}` | `currentBackend` = claude (template `[claude, codex]`), not switched; autonomy re-stored from `view.autonomy` | `[done] Operator updated on <slug>. Effort is now high.` (plus the governance sentence only if this save turns full+direct-accept on) |

Notices: none expected on the seeded rows (headline present, browser+egress both direct),
so no ` Notes: ...` suffix. Audit per call: `project.agent_profile.updated`.

### 11.8 On-disk proof after the calls (what the observer should find)

`project.md agents[]` developer row after the developer call (verified against
`docker-data/projects/k9c-k9s-clone/project.md`, which is exactly this shape): 16 grants =
the 14 `MODAL_CAP_IDS` (`execute-code-or-write-repo`, `create-task-branch`,
`commit-push-branch`, `open-review-pr`, `comment-on-task`, `ask-human`,
`use-web-search-fetch`, `use-browser`, `read-github-api`, `report-validation-verdict`,
`attach-evidence-references`, `merge-pull-request`, `transition-to-done`,
`change-project-policy`) each at its resolved mode (so `read-github-api: off`,
`report-validation-verdict: off`, `change-project-policy: human` now appear EXPLICITLY) +
the 2 preserved advisory rows (`run-unit-integration-validation`, `move-task-to-review`);
then `extras: []`; then `definition: {kind: specialist, name: Developer, role:
Implementation, icon: branch, backends: [codex], model: gpt-6-astra, effort: medium,
scope: Global base, desc: <template desc>, persona: <template body>, stages: [...],
spanAll: false, resources: {skills, mcps, kb}}`. Reviewer row: 20 grants (14 modal + 6
preserved advisory: `read-repo-diff`, `run-validation-suites`, `author-test-cases`,
`post-quality-flags`, `approve-review`, `request-changes`), `commit-push-branch: human`,
`execute-code-or-write-repo: off`, `report-validation-verdict: direct`, definition
`backends: [claude], model: opus, effort: high`. Operator row: 11 grants (the 8 stored +
materialized `update-task-branch` and `use-web-search-fetch`, plus `execute-code-or-write-repo:
human` preserved), definition with `autonomy: supervised|full`.

`task.md engagements[]` after the first engagement (SR:801-816 deliverer, :962-969
supporting; schema task-file.schema.ts:196-219):

```
engagements:
  - profileId: developer
    backend: codex
    role: Implementation
    delivers: true
    verdictCapable: false
  - profileId: reviewer
    backend: claude
    role: Review & validation
    delivers: false
    verdictCapable: true
```

(`docker-data/projects/k9c-k9s-clone/tasks/KNC-1/task.md:10-20` shows this shape with
`architecture-reviewer` in the reviewer slot.) Timeline sentences at engage time:
`Deployed **Developer** (Implementation, Codex) as the delivering agent.` (SR:785) and
`Engaged **Reviewer** (Review & validation, Claude) as a reviewer.` (SR:957-960; a profile
without the verdict grant reads `as a supporting agent.`). Audit `task.reviewer.assigned
{profileId, backend, role}` (SR:989-1001). `verdictCapable` is a SNAPSHOT: granting or
revoking the verdict after engagement does not change an existing row; verdict recording
reads the row, not the live profile (task-actions.server.ts:3560-3574).

### 11.9 Drift and candidate findings from this gap fill

1. `deploy_agent` always replies `Delivery starts withheld; open it up with
   update_agent_deployment when the profile should write the repo.` (TK:1720), but the
   library deploy takes the TEMPLATE's own grants whenever the template has any
   (APA:590-600) and only falls back to `conservativeGrantsFor` for an empty list. The seeded
   `developer` template carries delivery `direct` (data/agents/profiles/developer.md), so
   re-adding a removed Developer from the library deploys it DELIVERING while the reply
   says withheld. The tool description (TK:1700) makes the same claim.
2. `save_global_agent` backend switch keeps the template's `model` (gagents.server.ts:401-412
   never touches it), so a Claude template moved to Codex stores a foreign id. Live proof:
   `docker-data/agents/profiles/developer.md` = `backends: [codex]` + `model: sonnet`. Every
   project created afterwards inherits a developer that runs `gpt-5.6-terra` with a
   substitution line and a "default" badge; `list_global_agents` shows nothing wrong.
3. `save_global_agent` on the seeded `developer`/`reviewer` silently rewrites the identity
   (backend, stages, persona, desc, resources) of every project whose row was never saved;
   the toast says only `running threads re-anchor on next turn`, and the controller reply
   drops the `used` (projects-using) count `saveGlobalAgentProfile` returns
   (gagents.server.ts:424-428 vs TK:748).
4. Docs: task-lifecycle.md:120-123 describes `strict` as "every pre-work `auto` becomes
   `approval`; operator supervised" and agents-and-runtime.md:717 lists the operator's
   `deliver` as direct without caveat; code ALSO stores `deliver-review-pr: recommend` under
   `strict` (PC:87-101). Minor doc omission; behaviour is R15-2 as intended.
5. Path drift in the brief for this gap: the catalog lives in `app/server/seed/`, not
   `app/server/agents/` (only `deployment-view.server.ts` is there). Reference-file
   citations that say `agent-catalog.server.ts:82-172` without a directory resolve to
   `app/server/seed/agent-catalog.server.ts:83-196`.
6. `update_agent_deployment.stages` accepts literal ids only (TK:1785-1791) while the
   runtime resolves declared aliases per board (§11.5); a controller told "make the
   developer eligible at the ready stage" on a custom board must translate the alias
   itself, and a seeded row it never saved is already alias-resolved at run time.

---

## Gap fill: Runtime environment: container toolchain, sandbox/network per backend, and how to read what a run could execute

Section 12 of this file. Verified 2026-09-06 against the working tree of
`pass35/k9s-clone-observation` (HEAD `cb4fa22a`) and, read-only, against the LIVE container
`viberr-app-1` (image `viberr-app`, created 2026-09-06T12:51Z, mount
`/Users/akinozer/projects/viberr/docker-data -> /data`, `init=true`, no `cap_add`, not
privileged, no `security_opt`). Every `docker exec` below was a read (`command -v`, `ls`,
`grep`, `git log`); nothing was written. Abbreviations: CR =
`app/server/runtimes/claude-runtime.server.ts`, CX = `app/server/runtimes/codex-runtime.server.ts`,
RR = `app/server/runtimes/runtime-registry.server.ts`, RS = `app/server/runtimes/run-service.server.ts`,
SR = `app/server/tasks/specialist-run.server.ts`, STP = `app/server/tasks/specialist-tool-policy.ts`,
GCA = `app/server/tasks/git-clone-auth.server.ts`, WF = `app/server/runtimes/wire-format.server.ts`,
RT = `app/features/runtime/runtime-types.ts`, RH = `app/features/runtime/runs-helpers.ts`,
BC = `app/server/runtimes/backend-credentials.server.ts`, OR = `app/server/runtimes/operator-run.server.ts`,
CTR = `app/server/controller/controller-run.server.ts`, ENV = `app/server/config/env.server.ts`.

### 12.1 The image and the container

Dockerfile (verified by line) and what `docker exec viberr-app-1 sh -c 'command -v ...'`
returned on 2026-09-06:

| fact | value | verified |
|---|---|---|
| base image (runtime stage) | `node:26-slim` (Debian 13 trixie, `/etc/os-release`); kernel `6.12.76-linuxkit` (Docker Desktop VM) | Dockerfile:48; live |
| apt packages added | `git`, `ca-certificates` (:56-58); `chromium`, `fonts-liberation` (:70-72) | Dockerfile |
| copied binaries | `/usr/local/bin/uv` and `/uvx` from `ghcr.io/astral-sh/uv:0.12.3` (:85); the comment says "a system python3 is deliberately NOT installed" (:84) | Dockerfile |
| PRESENT (live) | `node` v26.8.1, `npm`, `npx`, `git` 2.47.3, `uv`/`uvx` 0.12.3, `chromium` (/usr/bin/chromium), `bash`, `sh`, `tar`, `gzip`, `perl`, `awk`, `sed`, `find`, `ps`, `openssl`, `apt-get` (binary present; needs root) | live `command -v` |
| MISSING (live) | `go`, `make`, `gcc`, `cc`, `python3`, `python`, `pip`, `gh`, `curl`, `wget`, `cargo`, `rustc`, `java`, `xz`, `unzip`, `zip`, `ssh`, `jq`, `sqlite3`, `sudo` | live `command -v` |
| SDK vendor binaries | `/app/node_modules/@anthropic-ai/claude-agent-sdk` (bundled `claude` CLI, SDK 0.3.261) and `/app/node_modules/@openai/codex-linux-arm64` (Codex CLI 0.153.4); both installed by the linux `npm ci` (Dockerfile:50-54, :121) | live `ls`; CR:22, CX:83 |
| process user | `uid=1000(node)`, `CapEff: 0000000000000000` (no capabilities); `USER node` | Dockerfile:141; live `/proc/self/status` |
| writable for uid node (live) | `/data` (the bind mount, 13 GB free of 229 GB), `/home/node` (`HOME`), `/tmp`; NOT `/usr/local`, `/usr/local/bin`, `/opt` | live `test -w` |
| env baked into the image | `VIBERR_BROWSER_EXECUTABLE=/usr/bin/chromium` (:73), `NODE_ENV=production` (:99), `VIBERR_DATA_ROOT=/data` (:107), `UV_CACHE_DIR=/data/runtimes/uv-cache`, `UV_PYTHON_INSTALL_DIR=/data/runtimes/uv-python` (:112-113), `PORT=3000` (:114), `VIBERR_BUILD_*` (:96-98, empty in this build) | Dockerfile; live `env` |
| entrypoint / cmd | no ENTRYPOINT (ruling 127, :145-151); `CMD ["node", "/app/node_modules/@react-router/serve/bin.cjs", "./build/server/index.js"]` (:161) | Dockerfile |
| compose | `hostname: viberr` (:10), `init: true` (:17), `env_file: .env` (:18), forced `NODE_ENV=production` + `VIBERR_DATA_ROOT=/data` (:22-23), the four `VIBERR_UNLOCK_CONTROLLER_*` defaulting to `disabled` (:41-44), port `${PORT:-3000}:${PORT:-3000}` (:48), volume `./docker-data:/data` (:55), healthcheck = node `fetch(/resources/health)` every 30 s (:56-67), `restart: unless-stopped` (:68) | compose.yml |
| outbound network from the container (live) | `HEAD https://github.com` 200, `HEAD https://proxy.golang.org/` 200, `HEAD https://go.dev/dl/` 405 (reachable) via `node -e fetch(...)`: there is NO docker-level egress restriction; every network limit below is per-run (Codex sandbox) or per-tool (Claude denylist) | live |
| server-process env carries retired names | `.env` in the repo root still sets `CLAUDE_CODE_OAUTH_TOKEN`, `CODEX_HOME` and `VIBERR_CODEX_USE_CLI_AUTH` (names only; all three were retired by ruling 127, ENV:111-119) plus `PORT=5173`, so the container listens on 5173, not the image's 3000. None of the three reaches a child: see 12.2 | `.env` key names; live `env` |

Docs agents-and-runtime.md and deployment.md:90-96 ("git and a CA bundle ... chromium ...
uv/uvx") describe the inventory correctly. NO doc, prompt, health field or controller tool
states the negative: no compiler, no `make`, no `gh`, no `curl`, no Python interpreter
until `uv` fetches one, no root (grep `toolchain|installed|command not found` across
SR, `app/server/controller/*.ts`, `controller-ops-mcp.server.ts`: zero hits outside the
`@playwright/mcp` sentence). `instance_health` reports watchers, lock, disk, maintenance,
build identity, connected backends and the run queue (controller-ops-mcp.server.ts:212),
plus `browserDetail` for admins (:253); nothing about the toolchain.

What that means for a Go project (the controller's choice for k9c): `go`/`make` cannot be
apt-installed (no root) or dropped into `/usr/local` (read-only). A run CAN fetch a Go
tarball with `node -e fetch` or `git clone` (no `curl`) and untar it under `$HOME` or the
workspace (tar+gzip present, xz absent, so only `.tar.gz`) when its network is open (12.5),
and can bootstrap Python through `uvx`/`uv python install` into `/data/runtimes/uv-python`
(writable, created on first use; it did not exist live). Node projects work as shipped.
None of this survives the container (`/home/node` is container-local; `/data` persists).

### 12.2 The environment a spawned run actually sees

| layer | what it adds or removes | verified |
|---|---|---|
| `filteredSpawnEnv()` (base for BOTH adapters and every stdio MCP child) | `process.env` minus: names matching `CREDENTIAL_ENV_RE` = `/(?:^|_)(?:API_?KEY|ACCESS_?KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_?KEY|CREDENTIALS?|AUTH)(?:_|$)/i` (so `CLAUDE_CODE_OAUTH_TOKEN`, `OPENAI_API_KEY`, `VIBERR_SESSION_SECRET`, `VIBERR_SEED_ADMIN_PASSWORD`, `VIBERR_CODEX_USE_CLI_AUTH` all go); `PRIVATE_RUNTIME_ENV_RE` = `DATABASE_URL|REDIS_URL|SSH_AUTH_SOCK|GPG_AGENT_INFO`; `RUNTIME_HOME_ENV_RE` = `CLAUDE_CONFIG_DIR|CODEX_HOME`; and EVERY name the env schema declares (`APP_CONFIG_ENV = ENV_KEYS`: `NODE_ENV`, `PORT`, `VIBERR_DATA_ROOT`, `VIBERR_BROWSER_EXECUTABLE`, every `VIBERR_*` knob, ruling 142). PASSES: `PATH`, `HOME=/home/node`, `UV_CACHE_DIR`, `UV_PYTHON_INSTALL_DIR`, locale | RR:50-53, :71, :100, :127-138; ENV:16-187 |
| `runCredentialFor(db, userId, backend)` (per run, the ONE person it bills) | adds `CLAUDE_CONFIG_DIR=/data/runtimes/users/<userId>/claude-home` OR `CODEX_HOME=/data/runtimes/users/<userId>/codex-home` (0o700, created on demand); a PASTED credential additionally rides as `ANTHROPIC_API_KEY` (Claude) / `CODEX_API_KEY` (api_key row) / `CODEX_ACCESS_TOKEN` (workspace token); a hosted `login` row adds nothing (the binary reads its own file in the home). Refusal when not connected: `<Backend> isn't connected. Connect it on your ...` (AppError 409, `RUN_UNAVAILABLE`) | BC:894-938; user-homes.server.ts:13-15, :71-78 |
| specialist `spec.env` overlay | `GIT_CEILING_DIRECTORIES=<dataRoot>/projects/<slug>/tasks/<KEY>` (git may not discover a repo above the task dir) + `GIT_AUTHOR_NAME`/`GIT_COMMITTER_NAME=<profileId>`, `GIT_AUTHOR_EMAIL`/`GIT_COMMITTER_EMAIL=<profileId>@viberr.local`. NO push credential: "agent runs are NO LONGER handed push credentials" | SR:1800-1807, :3235-3239, :3241-3258, :3274-3286 |
| collision guard | a spec.env key that the credential env also names throws `run env overlay collides with the credential env: <keys>` (internal error, the run never starts) | RS:1017-1024 |
| Claude child env | `options.env = {...deps.env, ...spec.env}`: the whole filtered base + credential + overlay. The `claude` CLI and every `Bash` command it runs inherit it, so a Claude specialist's shell can read `CLAUDE_CONFIG_DIR` and, when the principal pasted a key, `ANTHROPIC_API_KEY` (code-implied; the run sink redacts those VALUES from every persisted line, RR:44-48). Docs make no statement either way | CR:1117-1121 |
| Codex child env | the SDK REPLACES the child env wholesale with `mergedEnv = {...deps.env, ...spec.env}` (CX:808-829); the CLI's `shell_environment_policy = {inherit: "core", ignore_default_excludes: false, set: {<only the 5 git keys present>}}` means the MODEL's shell sees core vars plus `GIT_CEILING_DIRECTORIES`, `GIT_AUTHOR_*`, `GIT_COMMITTER_*` and nothing else (no `CODEX_HOME`, no key). Docs §2.5 agrees | CX:257-263, :271-278, :313-319, :374; docs agents-and-runtime.md:222-223 |

### 12.3 Claude adapter: no OS sandbox, a denylist only

- `ClaudeQueryOptions` (CR:45-110) has NO `sandbox` field. The SDK does offer one
  (`SandboxSettings`, `@anthropic-ai/claude-agent-sdk/sdk.d.ts:1992-2032`) and Viberr never
  passes it. Consequence: a Claude run is confined ONLY by `disallowedTools`; its `Bash`
  runs as uid node with the whole container filesystem (12.1 writable set) and the whole
  container network, whatever the grants say. `RunInputs.sandbox` is `null` on Claude by
  design ("no OS sandbox there, the tool denylist in `tools.denied` is what binds", RT:178-186).
- Options actually sent (CR:1046-1116, :1131-1189): `cwd: spec.workdir`; `permissionMode:
  spec.autonomous ? "bypassPermissions" : "default"` and `autonomous` is `input.autonomous ??
  true` with no caller passing false (RS:861; OR:2179, :2851; CTR:406, :435; SR passes
  none), so EVERY run is `bypassPermissions`; `permissionPrompts: "none"`; `maxTurns` =
  `VIBERR_CLAUDE_MAX_TURNS` or 2000 (CR:648-653); `settingSources: ["project"]` only when
  native skills mounted, else `[]`; `skills: <mounted names>`; `plugins: []`;
  `strictMcpConfig: true`; `model` via `resolveClaudeModel`; `effort` via
  `resolveClaudeEffort` (low|medium|high|xhigh|max); `managedSettings` (inert, CR:455-476)
  when native skills; `resume`; `systemPrompt` = string REPLACING the harness for
  `operator`/`controller`, `{type:"preset", preset:"claude_code", append}` for specialists;
  `mcpServers`; `allowedTools` (auto-approval only, RS:842-845 adds every mounted MCP);
  `disallowedTools`; `abortController`.
- `disallowedTools` assembly (CR:1165-1186), in order:
  1. `BASE_DENIED_BUILTINS` (CR:324-366): `Skill` (dropped when native skills mounted),
     `Task`, `TaskCreate`, `TaskGet`, `TaskList`, `TaskOutput`, `TaskStop`, `TaskUpdate`,
     `Workflow`, `CronCreate`, `CronDelete`, `CronList`, `ScheduleWakeup`, `RemoteTrigger`,
     `Monitor`, `PushNotification`, `SendMessage`, `DesignSync`, `EnterWorktree`,
     `ExitWorktree`.
  2. `OPERATOR_READ_ONLY_DENIED_TOOLS` for `kind: operator|controller` (CR:256-264):
     `Bash`, `Edit`, `MultiEdit`, `Write`, `NotebookEdit`.
  3. `SUPPORTING_DELIVERY_DENIED_BUILTINS` for `kind: reviewer` (CR:292-296):
     `Bash(git push:*)`, `Bash(gh pr create:*)`, `Bash(gh pr merge:*)`.
  4. `spec.disallowedTools` = grant-derived (`CAP_DENY_RULES`, STP:51-99): withheld
     `create-task-branch` -> `Bash(git checkout -b:*)`, `Bash(git checkout -B:*)`,
     `Bash(git switch -c:*)`, `Bash(git switch -C:*)`; `commit-push-branch` ->
     `Bash(git push:*)`, `Bash(git commit:*)`; `open-review-pr` -> `Bash(gh pr create:*)`;
     `merge-pull-request` (always human) -> `Bash(gh pr merge:*)`;
     `execute-code-or-write-repo` -> `Edit`, `MultiEdit`, `Write`, `NotebookEdit`,
     `Bash(git commit:*)`; `use-web-search-fetch` -> `WebFetch`, `WebSearch`. The controller
     adds `Read`, `Grep`, `Glob`, `WebFetch`, `WebSearch` (CTR:379); the operator adds
     `WebFetch`, `WebSearch` only when its web grant is withheld (OR:1399-1407). An
     UNDEPLOYED profile gets every rule (STP:174-178; SR:1469).
- Holes the code documents as deliberate: `Bash` stays on every specialist, so `sed -i`,
  shell redirection, `git commit` via a wrapper, `node -e fetch`, `git clone https://...`,
  `npx`, `uvx` all reach the disk and the network even when the file-write or web families
  are withheld (STP:73-76, :81-85 name `curl`/`wget`; `curl` is absent in this image, node
  is not).
- Live proof of what the operator run exposes (`/data/runtimes/claude/run_2Z2zF6ecFEJ2.jsonl`
  first line, `system/init`): `cwd` = the task dir; `tools` = `Glob, Grep, ListAgents, Read,
  ReportFindings, ToolSearch, WebFetch, WebSearch, mcp__viberr__*`. `ListAgents` and
  `ReportFindings` are SDK built-ins on no denylist (harmless today: `SendMessage` is
  denied, and `ReportFindings` only renders a list).

### 12.4 Codex adapter: sandbox mode decides writes, and network follows the mode

- Config written per run (CX:307-380, merged per leaf into `$CODEX_HOME/config.toml`):
  `allow_login_shell: false`, `project_doc_max_bytes: 0` (the repo's `AGENTS.md` is never
  read), `skills.include_instructions: false`, `skills.bundled.enabled: false`,
  `features.apps|plugins|hooks: false`, `memories.*: false`, `mcp_servers` (credentials
  dropped, CX:185-193), `shell_environment_policy` (12.2), `developer_instructions =
  spec.systemPrompt`.
- Thread options (CX:844-889) and the argv the SDK 0.153.4 emits
  (`@openai/codex-sdk/dist/index.js:200-232`): `model` -> `--model`; `sandboxMode` ->
  `--sandbox <mode>`; `workingDirectory` -> `--cd`; `skipGitRepoCheck: true` ->
  `--skip-git-repo-check`; `approvalPolicy: "never"` -> `--config approval_policy="never"`;
  `modelReasoningEffort` -> `--config model_reasoning_effort="..."`;
  `additionalDirectories: [attachmentsDir]` -> `--add-dir` ONLY when the mode is
  `workspace-write` AND `attachmentsWritableDir` is set (CX:864-866);
  `networkAccessEnabled: false` -> `--config sandbox_workspace_write.network_access=false`
  ONLY for `kind: operator` (CX:876-878); `webSearchMode: "disabled"` -> `--config
  web_search="disabled"` when `webSearchWithheld` (CX:879-886); `outputSchema` ->
  `--output-schema <tmpfile>`.
- `resolveCodexSandboxMode(spec)` (CX:431-459), in order: `kind === "operator"` ->
  `read-only`; `repoWriteWithheld` -> `attachmentsWritableDir ? "workspace-write" :
  "read-only"`; `autonomous && kind === "primary" && !webSearchWithheld` ->
  `danger-full-access`; else `workspace-write`. Docs agents-and-runtime.md:224-227 state
  the same order (verified equal). `repoWriteWithheld`/`webSearchWithheld` are derived from
  the denylist markers (`repoWriteWithheldFromDenylist` = `Edit|Write|NotebookEdit` present,
  `webSearchWithheldFromDenylist` = `WebFetch|WebSearch` present; STP:24-26, SR:578-579).
- NETWORK on Codex, the part no doc states plainly: `danger-full-access` = network on
  unconditionally (CX:414-417); `read-only` and `workspace-write` take the network from
  `sandbox_workspace_write.network_access`, which Viberr sets to `false` for the operator
  and NEVER sets to `true` for anyone, so a workspace-write specialist runs on the CLI
  default. The adapter test pins the flag `undefined` for a reviewer and for an
  egress-withheld run and its comment says "The workspace-write default (network off) is
  what actually gates it" (codex-runtime.server.test.ts:298, :317-320). Therefore on Codex:
  the ONLY run with shell-level network is an autonomous DELIVERING run whose
  `use-web-search-fetch` is granted (which is every seeded developer run: both live Codex
  runs disclosed `sandbox: {mode: "danger-full-access", note: null}`); a supporting
  (reviewer-kind) Codex run has no network for its commands even with egress GRANTED
  (its `web_search` tool follows the CLI default, since Viberr sets `web_search` only to
  `disabled`); a write-withheld + evidence-granted deliverer
  (workspace-write) likewise has none. DRIFT: docs agents-and-runtime.md:226-227 and
  decisions.md:1293 say workspace-write runs have "the network gated by the egress
  capability (`networkAccessEnabled` / `webSearchMode`)", and the code comment CX:882-884
  says "Network access stays ON for specialists"; the grant never turns the network on
  below full access.
- Sandbox implementation on Linux: the CLI carries Landlock + seccomp (`sandboxing/src/landlock.rs`,
  feature flags `use_linux_sandbox_bwrap`, `use_legacy_landlock` in the binary strings).
  Both Codex runs observed so far were `danger-full-access` (no sandbox engaged), so
  whether `read-only`/`workspace-write` actually initialise inside this container (uid
  node, `CapEff` 0, docker default seccomp) is UNVERIFIED; a failure there would surface as
  a Codex `error`/`turn.failed` line (`error·unknown` tag) naming the sandbox.
- `describeCodexSandbox` (CX:473-478): `note` = `CODEX_REPO_WRITE_ADVISORY_NOTE` exactly
  when `kind !== "operator" && repoWriteWithheld && attachmentsWritableDir`; the sentence
  (STP:212-213): `repo-write is withheld but evidence is granted, and Codex's sandbox
  cannot express read-only-except-attachments — so on Codex this run keeps
  workspace-write and the withholding is advisory; the server-owned delivery gate is the
  real boundary` (em dash in source).

### 12.5 Backend x posture

`spec.autonomous` is true for every run kind (12.3), so "delivering supervised" is not a
distinct runtime posture: supervision lives in the operator's authority (`stage-transitions`
recommend vs direct, §8) and in what the server does after the run, never in the child's
sandbox or denylist. Rows below are what the CHILD process can do.

| run (kind) | Claude: sandbox / net / writable / denied | Codex: sandbox / net / writable / denied |
|---|---|---|
| delivering specialist, write + egress granted (`primary`; seeded developer) | none / container-wide / all of `/data`, `$HOME`, `/tmp` (only `.claude` in the checkout is stripped and skip-worktree'd, skill-mount.server.ts:125-150) / base list + `Bash(gh pr merge:*)` | `danger-full-access` / ON / unrestricted / no denylist channel; `tools.denied` shows `Bash(gh pr merge:*)` labelled advisory |
| delivering specialist, egress WITHHELD | none / still container-wide through Bash (`WebFetch`, `WebSearch` denied) / same / + `WebFetch`, `WebSearch` | `workspace-write` / CLI default (off) / cwd (+ `attachments/` when evidence granted) / `web_search="disabled"` |
| delivering specialist, write WITHHELD (`execute-code-or-write-repo` off/human) | none / container-wide / Bash can still write; `Edit`, `MultiEdit`, `Write`, `NotebookEdit`, `Bash(git commit:*)` + the scoped git/gh denies | `read-only` (evidence withheld) or `workspace-write` + advisory note (evidence granted) / off / none, or cwd + `attachments/` |
| supporting specialist (`reviewer`; seeded reviewer, write withheld) | none / container-wide / Bash can write its OWN isolated checkout; denied: base + `Bash(git push:*)`, `Bash(gh pr create:*)`, `Bash(gh pr merge:*)` + grant denies (§11.4 list) | seeded reviewer is evidence-granted -> `workspace-write` + advisory note / off / own checkout + `attachments/`; a write-GRANTED supporting profile -> `workspace-write` (never full access: `kind` is `reviewer`) / off |
| operator | none / `WebFetch`/`WebSearch` allowed unless web grant withheld; NO `Bash` / cwd = task dir but `Bash`, `Edit`, `MultiEdit`, `Write`, `NotebookEdit` denied (writes only through `mcp__viberr__*`) / base + operator set | `read-only` / OFF (`network_access=false`) / nothing (cwd `.operator-scratch` is empty and unwritable at read-only; the sandbox mode wins over the "scratch is your only writable area" prompt sentence, OR:3159) / `web_search` follows the grant |
| controller | none / no web tools, no `Bash`, no `Read`/`Grep`/`Glob`; only its in-process toolkit + `viberr_ops` / cwd `/data/runtimes/controller-scratch` (CTR:756-760) / base + operator set + `Read`, `Grep`, `Glob`, `WebFetch`, `WebSearch` (CTR:379) | never runs on Codex (`backend: "claude"`, CTR:430) |

Working directories (`RunInputs.cwd`): deliverer `<dataRoot>/projects/<slug>/tasks/<KEY>/workspace/<repoName>`
when cloned, else `<taskDir>/workspace` (SR:1676-1687; the empty-workspace case is what a
clone failure produces); supporting `<taskDir>/workspace/support/<profileId>/<repoName>` else
`.../support/<profileId>`; Claude operator = `<taskDir>` (RS:748-749 default; live
`cwd: /data/projects/k9c-k9s-clone/tasks/KNC-1`); Codex operator = `<taskDir>/.operator-scratch`
(OR:1261, :2133, :2170); controller = `<dataRoot>/runtimes/controller-scratch`. Live
listing of KNC-1: `attachments/`, `task.md`, `workspace/k9s-clone` (2 `[KNC-1]` commits on
top of `77eecbb Initialize k9c`), `workspace/support/{architecture-reviewer,reviewer}/k9s-clone`,
project mirror `.repo-mirror/akin-ozer__k9s-clone.git`.

### 12.6 Timeouts, caps and the env knobs the runs honour

| knob | default | where read | effect and the sentence printed |
|---|---|---|---|
| `VIBERR_GIT_CLONE_TIMEOUT_MS` | 900000 (15 min); `parseInt`, ignored unless > 0 | GCA:200-211 `cloneTimeoutMs()` | ceiling on one mirror fetch / clone / local support clone (SR:3391-3393, :3521, :3535). On expiry the run CONTINUES against an empty workspace; timeline note (SR:1874-1884): `**Workspace checkout failed:** The workspace checkout was cancelled after 900s — the clone ran past its time limit rather than failing. <credential sentence> The agent is running against an EMPTY workspace, so it cannot read or change <repo>. Raise `VIBERR_GIT_CLONE_TIMEOUT_MS` if this repository simply needs longer, then re-run.` (em dash in source). Other reasons (GCA:244-261): `git is not installed on the Viberr server, so the workspace checkout could not be created.` / `The workspace checkout failed (git exit <n>).` followed by `The project's GitHub credential WAS supplied to the clone, so this is not a missing-credential problem.` or `No GitHub credential is attached to this project, so the clone ran anonymously.`; git's redacted stderr rides in a fenced `What the checkout reported:` block |
| `VIBERR_CLAUDE_IDLE_TIMEOUT_MS` | 900000 | CR:208-213 | inactivity guard per message; on expiry err line tag `run·error·idle_timeout`, text `The run produced no output for <ms> ms and was stopped as hung — not a task failure. Re-prompt the agent to continue from its session, or raise VIBERR_CLAUDE_IDLE_TIMEOUT_MS.` (CR:1019-1023, em dash in source); run state `error` |
| `VIBERR_CODEX_IDLE_TIMEOUT_MS` | 900000 | CX:483-487 | same guard; err line tag `error·idle_timeout`, text `Codex stopped after <ms> ms without producing an event.` (CX:731, :952) |
| `VIBERR_CLAUDE_MAX_TURNS` | 2000 | CR:648-653 | SDK `maxTurns`; `error_max_turns` result -> `run·error·max_turns` (docs §2.4). Codex has no turn cap |
| interrupt grace | Claude 20 s cooperative then abort, +10 s backstop (CR:222, :233); Codex 20 s settle after abort (CX:498) | constants | a Stop that the child ignores still settles the row |
| schedule claim lease | `cloneTimeoutMs() + 5 min` | schedule.server.ts:322-323 | a scheduled operator drive is presumed crashed only after clone ceiling + 5 min |
| `maxConcurrentRuns` (instance setting, not env) | 0 = unlimited | instance-settings.server.ts:89-91; RS:1523-1537 | runs beyond the cap stay `queued` (reserved runs count from clone start, RS:1507-1509); `instance_health.runs` shows the queue |
| `VIBERR_TRANSCRIPT_RETENTION_DAYS` / `VIBERR_SESSION_HOME_RETENTION_DAYS` | 30 / 30 (0 = forever) | ENV:134-137 | raw `.jsonl` and provider session homes pruned by the maintenance pass |
| `VIBERR_BROWSER_EXECUTABLE` | unset on a dev host; `/usr/bin/chromium` in the image | ENV:96; specialist-browser-mcp.server.ts:119, :186-208 | when set: `--executable-path <it> --no-sandbox` appended to the `@playwright/mcp` argv (`node <cli.js> --headless --isolated --output-dir <attachments>`, `--image-responses omit` on Codex); when set but absent on disk the mount is REFUSED with `the pinned browser executable (VIBERR_BROWSER_EXECUTABLE=<path>) is not on disk — chromium is not installed in this deployment; the browser is not mounted (rebuild the image or install chromium)` and `/resources/health` reports `browser: {status: "unavailable", reason: "the pinned browser executable (VIBERR_BROWSER_EXECUTABLE) is not on disk"}` |
| other run-side env (all declared ENV:142-186) | | | `VIBERR_MAINTENANCE_INTERVAL_MS` (6 h), `VIBERR_DISK_CHECK_INTERVAL_MS` (5 min), `VIBERR_DISK_LOW_FREE_MB`/`_CRITICAL_FREE_MB` (2048/512), `VIBERR_GITHUB_WRITE_PROBE`, `VIBERR_FORCE_DATA_ROOT_LOCK`, `VIBERR_TRUST_PROXY`, `VIBERR_UNLOCK_CONTROLLER_{SKILLS,KB,MCPS,INSTRUCTIONS}`, `VIBERR_BUILD_{VERSION,SHA,TIME}`. Every one is STRIPPED from the child env (12.2), so a project's own tooling never sees them |

Delivery is server-side on both backends: the agent is told `Do NOT run `git push` and do
NOT open a PR — even if an operator directive tells you to. This workspace has no push
credentials by design, and Viberr owns delivery: it pushes the branch + opens the review PR
when the task enters Review. Just report the branch name and commit SHA(s) in your reply.`
(SR:2719, em dash in source); the server `git add -A`s the working tree before pushing
(push-workspace.server.ts:678-690) with the PAT delivered through `GIT_ASKPASS` only
(`gitAuthEnv`, GCA:42-71, shared by the clone and the push; `VIBERR_GIT_ASKPASS_USERNAME`
/`_PASSWORD` are the helper's own env names, never argv or `.git/config`).

### 12.7 The disclosure: `run·inputs`, `sandbox`, `tools.denied`

- Written once per run start, BEFORE the first provider line, by `recordRunInputs`
  (SR:637-700): raw `.jsonl` line `{"type":"run_inputs","source":"viberr","run_id":"<id>","backend":"claude|codex","inputs":{...}}`
  and a `run_log_lines` row whose display is `{ev:"meta", tag:"run·inputs", text:"Run inputs — <summary>", inputs}`
  (`RUN_INPUTS_TAG`, RT:194; summary bits SR:585-604: `delivering engagement` |
  `supporting engagement`, `canonical anchor N chars` | `NO canonical anchor`, `persona N
  chars`, `prompt N chars`, `N skills`, `N knowledge bases`, `N MCP servers`, optional
  `workspace <refresh sentence>`, optional `N grants did NOT reach this run`). Resumes carry
  the same record via `ResumeConfinement.runInputs` (SR:3149-3187), and an undeployed
  profile's resume says `the agent profile is no longer a deployment on this project — no
  grant could be confirmed, so this run is fully withheld` (SR:3217).
- `RunInputs` fields (RT:127-187): `cwd`, `repo`, `cloned`, `workspaceRefresh?`, `delivers`,
  `personaChars`, `promptChars`, `anchor`, `skills{granted,native,injected}`, `knowledge[]`,
  `mcp{mounted,unresolved,unhealthy}`, `unresolvedResources[{name,reason}]`,
  `tools{denied[],toolkit[]}`, `directive{from,chars}|null`, `sandbox{mode,note}|null`
  (Codex only; `runSandboxDisclosure` recomputes the mode from the SAME derived flags the
  adapter will use, SR:567-582).
- Console rows (Agent logs, expanded `run·inputs` line; `runInputRows`, RH:157-286), exact
  text: `workspace` = `<cwd> · checkout of <repo>` or `<cwd> · <repo> was NOT checked out;
  the agent ran against an empty workspace` or `... · no repository attached to this
  project`; `tools` = `viberr tools: <list>|none` + ` · ` + on Claude `denied by its
  capability grants: <list>`, on Codex `capability grants deny (on this Codex run the
  repo-write and web families bind via sandbox and search toggles; command-level entries
  are advisory): <list>`, or `no built-in tools denied`; `sandbox` row (Codex only) =
  `<mode>` or `<mode> · <note>`; also `anchor`, `persona`, `skills`, `knowledge`, `mcp`,
  `missing`, `directive`, `prompt` rows. The console's `{ } raw` toggle prints the raw
  envelope of any line.
- Live samples (2026-09-06): Claude supporting run `run_3Nf0sCG0V0fp` (architecture-reviewer):
  `cwd .../workspace/support/architecture-reviewer/k9s-clone`, `cloned: true`, `delivers:
  false`, skills native `k9c-review, reviewer-expertise`, KBs `k9c-product-spec,
  k9c-engineering-standards, kubernetes-client-notes`, mcp mounted `viberr_agent`,
  `tools.denied` = the 12 supporting/withheld entries of §11.4, toolkit `post_comment,
  ask_human, report_outcome`, `sandbox: null`. Codex delivering runs `run_G3SR44OXTvu2`,
  `run_ozuSfCYSshCo` (developer): `cwd .../workspace/k9s-clone`, skills `injected` (not
  native, as designed on Codex), mcp mounted `[]`, `tools.denied: ["Bash(gh pr merge:*)"]`,
  toolkit `[]`, `sandbox: {mode: "danger-full-access", note: null}`, `workspaceRefresh`
  present (ruling 129).

### 12.8 Proving a failure class from the log

Where to read: the Agent logs console on the task page (`{ } raw`); the route
`GET /resources/run-log?runId=<id>&since=<seq>` (forward) or `&before=<seq>&limit=<n>`
(backward), returning `{data: {runId, threadId, state, headSeq, oldestSeq, hasMore, ...}}`
(app/routes/resources.run-log.ts:13-45); the controller's `viberr_ops.read_run_log` (newest
page by default); the canonical raw file `/data/runtimes/<backend>/<runId>.jsonl`
(run-store.server.ts:454-460), i.e. `docker exec viberr-app-1 sh -c 'tail -n 40
/data/runtimes/codex/<runId>.jsonl'`. Never read `/data/state/projection.sqlite` from the
host (WAL stale-read trap, see memory); `run_log_lines` holds the same rows.

| signature in the log | class | attribution rule | verified |
|---|---|---|---|
| Codex raw `{"type":"item.completed","item":{"type":"command_execution","command":"/bin/bash -c 'make fmt'","aggregated_output":"/bin/bash: line 1: make: command not found\n","exit_code":127}}`; console `ev:"err", tag:"aggregated_output", exit:127` (WF:575-577) | binary absent from the IMAGE (12.1) | exit 127 + `command not found` is never a sandbox or network refusal; it is the same under every mode and on both backends. LIVE: 18 occurrences of `make: command not found` across the two Codex deliveries of KNC-1 (`make fmt`, `make lint`, `make test`, `make build`, each exit 127) | live grep |
| Claude `ev:"err", tag:"tool_result"` whose text carries the shell's `...: not found` and an `Exit code <n>` line (the SDK's Bash result content, not a wire field; `is_error: true` on the `tool_result` block, WF:419-423). LIVE: the reviewer runs quote `command not found` in their own reports; `Exit code 1` appears 4x | same class on Claude | Claude has no `exit` field; read the text. The tool_result text is the ONLY place the exit code appears | live grep; WF |
| `ev:"err", tag:"permission_denied", name:<tool>, text:"denied by <decision_reason_type>: <reason>"` (WF:368-379) | Claude denylist / mode refusal | the tool was REMOVED or refused by Viberr's confinement (12.3); confirm the entry is in `run·inputs.tools.denied` | WF |
| Codex `aggregated_output` with a non-zero exit and text like `Operation not permitted`, `Read-only file system`, or the CLI's own sandbox denial (telemetry names `sandbox_denied`, `network_policy_denial` in the binary strings); a `dial tcp`/`connection refused`/`network is unreachable` under `workspace-write`/`read-only` | Codex OS sandbox (12.4) | only possible when `run·inputs.sandbox.mode` is NOT `danger-full-access`; on full access and on every Claude run, a network error is upstream (DNS, GitHub, proxy), because the container itself has egress (12.1). EXACT denial wording UNVERIFIED (no sandboxed Codex run has happened yet) | code + live network probe |
| `ev:"err", tag:"run·unavailable"`, text ending `No agent process was started.` (RS:1030, :1070) | no credential for the principal (ruling 127) | nothing ran; fix on Profile -> Agent accounts | RS |
| `run·error·quota|auth|overloaded|session_missing|unknown` (Claude, CR:626-641, :978) / `error·quota|auth|overloaded|session_missing|idle_timeout|unknown` (Codex, CX:519-521, :795); `failure` record on the line (ruling 130a) | provider / adapter | provider prose follows `The provider reported:`; `unknown` on Claude = `The agent run did not complete. Review the runtime configuration.` (CR:862); spawn `ENOENT` = `The agent runtime executable was not found. Check the deployment's Claude CLI/SDK install.` (CR:755) | CR, CX |
| `run·error·idle_timeout` / `error·idle_timeout` | hang guard (12.6) | 15 min silence; the task shows `waiting: agent` until then | CR, CX |
| timeline note `**Workspace checkout failed:** ...` + `run·inputs` `cloned:false` + console `... was NOT checked out; the agent ran against an empty workspace` | clone (server side, before any child) | reason word `clone_terminated` (timeout, SIGTERM) vs `clone_failed` (git exit n, stderr quoted) vs `git_unavailable`; the agent is told to quote the sentence verbatim (SR:1846-1852) | SR, GCA |
| `system/init` `tools` list (Claude first line) | what the model could call | compare with 12.3; a tool absent here was denied | live |
| `agent_runs.state = error|interrupted`, `interrupted_by = "restart"` | boot recovery (`finalizeOrphanedRuns`) | the container restarted mid-run; docs §8 | docs agents-and-runtime.md (not re-verified) |

Reading the live evidence for the k9c pass so far: the controller chose a Go stack (goal
text in the KNC-1 anchor: "Go 1.23+ with tview on tcell ..."); the developer was moved to
Codex and delivered KNC-1 twice under `danger-full-access` (network on, so `go` COULD have
been fetched) but every `make ...` died with exit 127 and the run reported the missing
Makefile/module rather than the missing toolchain; nothing in Viberr disclosed to the
controller, the operator or the human that the image has no `go`/`make`. `run·inputs`
tells the truth about confinement and never about the toolchain.

### 12.9 Drift and candidate findings from this gap fill

1. Codex network below full access is NOT egress-gated: docs agents-and-runtime.md:226-227
   and decisions.md:1293 ("network gated by the egress capability") and the comment
   CX:882-884 ("Network access stays ON for specialists") vs code that only ever sets
   `networkAccessEnabled=false` (operator) and leaves workspace-write on the CLI default
   (off; pinned by codex-runtime.server.test.ts:298, :317-320). An egress-GRANTED supporting
   Codex run, or a write-withheld evidence-granted deliverer, has no shell network; the
   matrix and `run·inputs` say egress is granted.
2. No surface discloses the runtime toolchain (12.1): not the persona, the delivery
   contract, `instance_health`, `/resources/health`, deployment.md, or the controller's
   context. The controller cannot learn that `go`, `make`, `gh`, `curl`, `python3` are
   absent, and the observed runs turned that into "no Makefile" (exit 127 x18). Candidate:
   a toolchain line in `run·inputs` or `instance_health`, and a docs sentence in
   deployment.md.
3. `.env` in the repo root still carries the ruling-127-retired names `CLAUDE_CODE_OAUTH_TOKEN`,
   `CODEX_HOME` (a host path), `VIBERR_CODEX_USE_CLI_AUTH`, plus `PORT=5173`; compose
   injects them into the server process. They are stripped from every child (12.2), so no
   run bills the wrong account, but the env schema and `.env.example` deny they exist and
   nothing at boot warns that they are ignored.
4. Claude runs have no OS sandbox and `Bash` survives every grant: a write-withheld or
   egress-withheld Claude specialist can still write any file under `/data` (including
   other tasks' workspaces and `task.md`, subject only to `GIT_CEILING_DIRECTORIES` for git
   discovery) and reach the network with `node -e`/`git`/`npx`. Documented as a known
   tension in STP:73-85; not in the user-facing docs, and `run·inputs` renders
   `denied by its capability grants` with no "advisory through Bash" caveat (the Codex row
   does carry one).
5. `ListAgents` and `ReportFindings` are exposed to every Claude run (live `system/init`
   tools list) and are on no denylist; `BASE_DENIED_BUILTINS` (CR:324-366) predates them.
6. Docs §2.5 line "operator threads have network off" is correct; docs §2.4 makes no
   statement that Claude has no sandbox at all (RT:178-186 does). Docs deployment.md:90-96
   inventory is correct but silent on what is missing.
7. The Codex operator prompt says `Your working directory is a separate, empty scratch
   folder — your ONLY writable area.` (OR:3159, em dash in source) while its sandbox is
   `read-only` (CX:434), so even the scratch folder is unwritable; harmless (the operator
   writes through its plan), but the sentence is false.
