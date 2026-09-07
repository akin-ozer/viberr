# GitHub delivery pipeline: code-verified reference (pass 35, k9s-clone observation)

Branch `pass35/k9s-clone-observation` (treated as main), read 2026-09-06. Source doc:
`docs/domain/github-delivery.md` (self-dated "verified against main @ 68b5480, 2026-09-01").
Every row below says where it was verified. Where the doc and the code disagree the code
wins and the row is marked DRIFT. Line numbers are from this tree.

Conventions: `KEY` = task key (e.g. `K9S-3`); `<repo>` = `owner/name`; `gh` = the
project GitHub context; "sentence" = the exact string the app writes.

---

## 0. Where things live (files)

| Concern | File |
|---|---|
| Credential tables, `DEFAULT_REQUIRED_SCOPES` | `app/server/secrets/pat-store.server.ts` (scopes at :38-41) |
| PAT validation | `app/server/secrets/pat-validator.server.ts` |
| Project GitHub context (repo + bound PAT) | `app/server/github/github-context.server.ts` |
| HTTP client (20 s timeout, one 5xx retry) | `app/server/github/github-client.server.ts` (:210, :287) |
| Org connections (owner -> PAT) | `app/server/org/connections.server.ts` |
| Project create (repo probe) | `app/features/home/project-create.server.ts` |
| Repo repair, credential attach | `app/features/project-settings/settings-actions.server.ts` |
| Mirror clone | `app/server/tasks/repo-mirror.server.ts` |
| Workspace clone/reuse/refresh | `app/server/tasks/specialist-run.server.ts` (:2862-2912, :3395-3470), `app/server/tasks/workspace-refresh.server.ts` |
| Branch allocation + creation | `app/server/github/branch-sync.server.ts` |
| Empty-repo bootstrap | `app/server/github/repo-bootstrap.server.ts` |
| Push | `app/server/github/push-workspace.server.ts` |
| PR open / reuse / adoption | `app/server/github/pr-open.server.ts`, `pr-adoption.server.ts`, `pr-adoption-record.server.ts` |
| Delivery core | `app/server/tasks/task-actions.server.ts` `performDelivery` (:5323-5908), `manualDeliverForReview` (:5915) |
| Post-run workspace reconcile | `app/server/github/workspace-delivery.server.ts` `reconcileWorkspaceDelivery` (:294) |
| Reconciler, merge, branch delete, collision clear | `app/server/github/github-reconciler.server.ts` |
| Poller | `app/server/github/reconcile-poller.server.ts` |
| PR facts (state/checks/review/mergeable) | `app/server/github/pr-linker.server.ts` |
| Human GitHub approval as verdict | `app/server/github/pr-human-approval.server.ts` |
| Scope violations | `app/server/github/scope-flag.server.ts`, projection `app/server/projections/policy-violations.server.ts` |
| Base refresh (operator) | `app/server/github/update-branch.server.ts`, `update-branch-operator.server.ts` |
| Branch cleanup guardrail | `app/server/github/branch-cleanup.server.ts` |
| Askpass + redaction | `app/server/tasks/git-clone-auth.server.ts`, `app/server/secrets/git-output-redact.server.ts` |
| Task file schema (pr, github, workRevision, verdicts) | `app/schemas/task-file.schema.ts` |
| Operator tools | `app/server/tasks/operator-toolkit.server.ts`, actions in `operator-actions.server.ts` |
| Controller tools | `app/server/controller/controller-toolkit.server.ts` |
| Task page route/UI | `app/routes/project.task.tsx`, `app/features/task-detail/*` |
| GitHub view route | `app/routes/project.github.tsx` |

---

## 1. PAT storage, scopes, validation

### Tables (verified `pat-store.server.ts`)
| Table | Columns seen | Role |
|---|---|---|
| `github_pats` | `id, user_id, label, encrypted_token, token_suffix, created_at, last_validated_at, validation_json` (:72-73, :111-112) | The only token store; `masked` renders as `····<suffix>` (:81) |
| `github_connections` | `id, owner, pat_id, is_default, repos_count, expires_at` (`connections.server.ts:172`); `id = slugify(owner)` (:445) | Org-level owner -> PAT |
| `project_github_credentials` | `project_slug, pat_id` (:295, :318, :340) | One PAT per project; `getProjectGithubContext` reads `projects.repo`, `projects.default_branch` and this binding, never connections (`github-context.server.ts:52-84`) |

### Required scopes
- `DEFAULT_REQUIRED_SCOPES = ["repo", "pull_request:write"]` verified `pat-store.server.ts:38-41`.
- `project.md` `credentialPolicy.requiredScopes` (array, default `[]`) overrides when non-empty: schema `project-file.schema.ts:147-154`; consumed `pat-validator.server.ts:191`.
- `workflow` is NOT required. Validator records a classic token's full header list as `headerScopes` (null for fine-grained) verified `pat-validator.server.ts:269-275`.

### What attach-time validation checks (`validatePatToken`, `pat-validator.server.ts:187+`)
| Step | Call | Outcome |
|---|---|---|
| 1 | `GET /user` | 401 + message matching `/expired/i` or a known past expiry -> `expired` ("The token has expired — generate a new one on GitHub." :229); other 401 -> `revoked` (:234-236); 5xx/network -> `network_error` (never downgrades a stored verdict) |
| 2 | `GET /repos/<repo>` (only when a repo is known) | ok -> `repoWriteOk` from `permissions` block (:286-289); 404 -> `repo_not_found` with the three-cause sentence (:307-312); 403 with `/approval|access policy|organization/i` -> `org_approval_missing` (:314-321); other 403 -> `repoAccessible=false`; 5xx -> `network_error` |
| 3 classic (`x-oauth-scopes` header present) | none | each required scope checked against the header; `repo` implies `pull_request:write` (`classicScopeCheck`); an EMPTY header on a classic token = "this classic token was created with no scopes at all — regenerate it with `repo`" (:357) |
| 3 fine-grained | `GET /repos/<repo>/pulls?per_page=1&state=all` (:379-390) | proves READ only; `pull_request:write` stays `source: "assumed"` with note "read proven; write needs a write request to prove — set VIBERR_GITHUB_WRITE_PROBE=1 to allow an authorization-only dry-run" (:471) |
| 3 fine-grained, opt-in | `POST /repos/<repo>/pulls` with body `{}` when `VIBERR_GITHUB_WRITE_PROBE=1` (:98, :407-418) | 422 = held, 403 = refused, else unknown |

### What attach-time validation does NOT check
- `workflow` scope is never required (only disclosed). A classic token without `workflow` validates green and then cannot push `.github/workflows/*`; the pre-push refusal in §6 is the only guard. Fine-grained tokens publish no scopes, so a fine-grained token missing "Workflows" permission is caught only by GitHub's push refusal (`push-workspace.server.ts:840-858`).
- Branch protection / rulesets on the target repo (a push or merge refusal surfaces later as `push_failed` / `not_mergeable`).
- Whether the repo is EMPTY (handled at branch time by the bootstrap, §4).

### Freshness / re-proof
- Connection re-validated before use after `CONNECTION_REVALIDATE_AFTER_MS = 24h` (`connections.server.ts:239`, `ensureConnectionFresh` :257); downgrade audits `org.connection.validation_downgraded` (:292).
- Project "Re-check": `revalidateProjectCredential`, `REVALIDATE_COOLDOWN_MS = 60_000` (`pat-validator.server.ts:560`); a WRITE scope violation clears only on header or probe evidence, never `assumed` (:694-706).
- Chips: `header`, `probe`, `violation` render as proof; `assumed`/`unchecked` read "unproven (verified on first use)" (docs claim, not re-verified in the chip component; low value).

### Token handling in git
- `createGitHubAskpassEnv` sets `GIT_TERMINAL_PROMPT=0`, resets `credential.helper` via `GIT_CONFIG_KEY_0`, sets `GIT_ASKPASS` to a temp helper fed from `VIBERR_GIT_ASKPASS_USERNAME/PASSWORD` env (`git-clone-auth.server.ts:11-12, :48-84`). Remote URL is plain `https://github.com/<repo>.git` (:91).
- `redactGitOutput`: 600 chars max (`git-output-redact.server.ts:72`), any-length secret scrub (:89).

---

## 2. Attaching a repository

### Project creation (`app/features/home/project-create.server.ts`, route `_index.tsx:173` intent `create-project`)
- Form fields `owner`, `repoName` (`_index.tsx:184-185`); requires an existing connection for `owner` (throw at :328, not read in full; controller tool description says the same, `controller-toolkit.server.ts:833`).
- `probeRemoteRepo` (:183-207): `GET /repos/<repo>`; 404 -> `not_found`; 401/403 -> `forbidden`; `permissions.push === false` -> `read_only`; ok adopts `default_branch`. `defaultBranch` starts as `"main"` (:361) and is replaced by the probe's answer.
- A non-`ok` probe still creates the project with a warning (:263-266 comment). Read-only is "called out", not refused (:143-146).
- Connection PAT bound via `setProjectCredential` (:26 import).
- Controller `create_project` args: `key` (2-4 letters), `owner`, `repoName`, `policy` (`strict|balanced|auto`), optional `description`, `stages[]`, `boundaries[]`, `members[]` (`controller-toolkit.server.ts:836-860`); calls the same `createProject` (:890).

### Repair / credential (`settings-actions.server.ts`, route `project.settings.tsx:177` intent `repair-repo`)
- `normalizeRepoInput` accepts `owner/name` or a URL (:314).
- `repoFootprintTasks > 0` without `confirmFootprint` throws: "`N task(s) in this project carry branch/PR records against <from>. Confirm the repair to proceed; those records keep their history but future sync runs against <repo>.`" (:390-393). Form field `confirmFootprint=1` (`project.settings.tsx:183`).
- Probe with the BOUND credential: proven read-only refused (:413), 404 refused (:424), 401 refused (:428), other refused (:432). Audit `project.repo.updated` (docs claim; audit name not re-grepped).
- Intents `set-credential` / `clear-credential` exist in both `project.settings.tsx:212` and `project.github.tsx:141`; `grant-scope` in `project.github.tsx:135`; `reconcile` in `project.github.tsx:131`.
- DRIFT (minor): docs §2 names an `edit-policy` intent and `grant-github-scope` as an intent; only `repair-repo`, `set-credential`, `clear-credential`, `grant-scope`, `reconcile` exist as intents. `grant-github-scope` is the RBAC action id (`app/shared/rbac.ts:78`), not an intent.

### project.md fields
`repo`, `defaultBranch`, `credentialPolicy` (`project-file.schema.ts:246-254`). Projection mirrors to `projects.repo`, `projects.default_branch` (`github-context.server.ts:52-56`).

### Data-root layout
| Path | What |
|---|---|
| `<dataRoot>/projects/<slug>/project.md` | project file (`file-store-root.server.ts:64-73`) |
| `<dataRoot>/projects/<slug>/.repo-mirror/<owner>__<name>.git` | bare mirror, `git clone --bare`, fetch refspec set to heads only (`repo-mirror.server.ts:119-123, :339-356`) |
| `<dataRoot>/projects/<slug>/tasks/<KEY>/workspace/<repoName>` | DELIVERING checkout (`specialist-run.server.ts:2867, :2912`) |
| `<dataRoot>/projects/<slug>/tasks/<KEY>/workspace/support/<profileId>/<repoName>` | each SUPPORTING engagement's checkout (:2911) |

Mirror refresh: `git fetch --prune origin` on reuse; two consecutive failures rebuild (:211-218, :294-331). Timeout ceiling `VIBERR_GIT_CLONE_TIMEOUT_MS` (docs claim 15 min; env read not re-verified).

---

## 3. Workspace model (ruling 129, pass 34 fix LANDED)

- Delivering checkout reused across runs; on reuse: origin URL re-sanitized, identity set, then `refreshWorkspaceFromMirror` with `fastForward: !input.support` (`specialist-run.server.ts:3455-3462`).
- `refreshWorkspaceFromMirror` (`workspace-refresh.server.ts:97+`): refresh mirror -> `git fetch <mirror> +refs/heads/*:refs/remotes/origin/*` (:120), falling back to a credentialed `git fetch origin` (:130); with `fastForward` moves an UNBORN or CLEAN default-branch checkout to `origin/<default>` (`checkout -q -B <default> <base>` :174). Heads: `not_requested | no_base | detached | dirty | task_branch | unrelated | current | local_commits` (:39-54, :149-185). A failure only warns: "workspace refresh degraded — the run proceeds on the checkout as it stands" (:3465).
- `describeWorkspaceRefresh` sentences (:203-237), e.g. "fast-forwarded the unborn checkout to `origin/main` at `abc1234`", "not refreshed: no project mirror and no credential to fetch with; origin/* is as old as the clone".
- Supporting checkouts get fetch-only (`fastForward: false`, :3403-3409). A supporting run's tree can never reach the delivering tree (P8, :2892-2901).
- Agents hold NO GitHub credential; the checkout's origin is the sanitized URL and pushes are server-side (`agent-github-read.server.ts:15-24`; `repo-mirror.server.ts:60`).
- Observation trap: a checkout sitting on a TASK branch is never fast-forwarded (`task_branch` head); a dirty tree is never touched (`dirty`).

---

## 4. Branch allocation and the empty-repo bootstrap (rulings 122, 128 LANDED)

### Names (`branch-sync.server.ts`)
- `taskBranchName(key) = key.toLowerCase()` (:50). Candidate n>0 = `<canonical>-<4 hex>` from `randomBytes(2)` (:68, :72-75).
- `probeBranchName` (:94-140): `GET /repos/<repo>/git/ref/heads/<branch>` -> ok = taken; missing -> `GET /repos/<repo>/pulls?head=<owner>:<branch>&state=all&per_page=1` -> any PR ever = taken. 401 -> `auth`; 403 -> `forbidden` ("Reading branch `x` was refused." / "Listing pull requests on `x` was refused."); other -> `network`.
- `allocateTaskBranchName` (:157-180) tries candidates; `forbidden` opens a `repo` scope violation (:576-596).

### `ensureTaskBranch` (:539-760)
1. `task.md` `branch:` present -> kept verbatim (:566-567). Else allocate.
2. `GET git/ref/heads/<branch>`; missing -> `GET git/ref/heads/<default>`; missing -> `ensureDefaultBranch` (bootstrap) then re-read (:611-633). Still missing -> `bootstrap_failed` "`<default>` still has no ref after the bootstrap" (:638-644).
3. `POST /repos/<repo>/git/refs {ref: refs/heads/<branch>, sha}` (:659-664); 422 "already exists" = idempotent; 403 -> `repo` violation "Creating branch `x` was refused." (:673-694).
4. Writes `branch:` to task.md when changed (:730-735); audit `github.branch.created {repo, from}` when created (:739-747); returns `synced` with the compare.
Result statuses: `synced | task_not_found | no_repo_configured | no_pat_configured | bootstrap_failed | scope_violation | auth_failed | network_unavailable` (:503-519).

### `ensureTaskBranchBestEffort` (:403-500) called from BOTH dispatch doors (docs claim; `operatorDispatchAgent` and `dispatchAgentRun` call sites not re-grepped)
- Discloses `auth_failed`, `network_unavailable`, `bootstrap_failed`, `threw` as one `github` timeline event by `system:delivery` (:464-465):
  - with a recorded branch: "Branch `x` could not be confirmed on GitHub before dispatch: <detail>. The run proceeds in the workspace; delivery retries the branch."
  - without: "No task branch could be allocated on GitHub before dispatch: <detail>. The run proceeds in the workspace; delivery retries the branch."
  - details: "GitHub rejected the project credential (…)", "GitHub was unreachable (…)", "the repository has no `main` branch and Viberr could not create it (…)", "the branch preparation failed unexpectedly (…)" (:432-441).
- Audit `github.branch.prepare_failed {branch, status, detail}` actor `system:delivery` (:492-499). Dedupe: same text within `PREPARE_FAILURE_REPEAT_MS = 1h` writes nothing (:388, :477-484). `synced`, `scope_violation`, no-credential, no-repo, unknown task write nothing (:448-457).

### `ensureDefaultBranch` (`repo-bootstrap.server.ts:154-320`)
| Probe | Answer | Action |
|---|---|---|
| `GET git/ref/heads/<default>` | ok | `exists` |
| 403 | | `repo` violation "Reading branch `main` was refused." |
| 404 or 409 "empty" (`isMissingRefAnswer`, `github-client.server.ts:425-429`) | | continue |
| `GET /repos/<repo>/branches?per_page=1` | 409 "Git Repository is empty." | counts as 0 branches (:177-186) |
| 0 branches | | `PUT /repos/<repo>/contents/README.md` (base64 "# <projectName>\n\nInitialized by Viberr.\n") on branch `<default>`; confirm re-read; `how: "initial_commit"` |
| >0 branches (task branches only) | | `GET /repos/<repo>` -> `default_branch`; walk to that branch's ROOT commit; `POST git/refs {refs/heads/<default>, root sha}`; `PATCH /repos/<repo> {default_branch}` (refusal only warns, :257-266); `how: "ref_from_branch_root"` |
- Reads that fail (5xx, 429, decode) -> `network_unavailable`; a failed CREATE -> `bootstrap_failed` (:118-145).
- Timeline (`github`, `system:delivery`) when a task is in scope (:300-318): "Bootstrapped the repository: `<repo>` had no branches, so Viberr created **main** with an initial commit `abc1234` (a README naming the project) before cutting this task's branch." or "…had no **main** (GitHub had made `<from>` the default), so Viberr created **main** at that branch's first commit `abc1234` and restored it as the repository default." / "…; restoring it as the repository default was refused, so set it by hand on GitHub."
- Audit `github.repo.bootstrapped` (:289).
- Observation: on `akin-ozer/k9s-clone` if EMPTY, the first dispatch of a delivering agent should produce this event before any run; if the repo already has a `main` with a README nothing fires.

---

## 5. Delivery doors and gates

| Door | Identity | Gate | Audit |
|---|---|---|---|
| Operator tool `deliver_for_review` (arg `reason?`) | capability `deliver-review-pr` (`app/shared/capabilities.ts:71`) | mode `direct` performs; `recommend` records a `delivery` recommendation card (`operator-actions.server.ts:2675-2702`); `deny` withholds the tool (`operator-toolkit.server.ts:617`) | `github.delivery.operator` (`operator-actions.server.ts:2729`) |
| Applied `delivery` recommendation | route intent `apply-recommendation` (`project.task.tsx:929`) | human authority | (via performDelivery) |
| Task page "Deliver branch & open PR" | route intent `deliver-review` (`project.task.tsx:706`) -> `manualDeliverForReview` | `run-agents` action (admin, maintainer per `rbac.ts:75`) or org admin or the task OWNER with `own-task` (`project.task.tsx:303-307`; server :5924-5936) | `github.delivery.manual {status, prNumber, headSha, moved}` (:5944-5960) |
| `resolve_remote_collision` packet option | packet Confirm | `approve-transition` | `github.collision.resolved` |

- The BUTTON is rendered whenever `canDeliver && !taskClosed` (`task-detail-page.tsx:647`); it is NOT hidden for a task with no branch, no workspace or no run. Label `DELIVER_LABEL = "Deliver branch & open PR"` (`decision-packet.tsx:42`); while a PR is open with an unpushed revision the label becomes `PUSH_LABEL(rev, prNumber)` and a `diverged` relation shows `DIVERGED_PUSH_REFUSAL` (`task-side-panels.tsx:395-409`). Pressing it on a run-less task yields the "Delivery could not run" event (§6), never a silent noop.
- The controller has NO delivery tool. Its tools are: `whoami, list_capabilities, list_users, create_user, update_user, set_user_org_role, list_knowledge_bases, save_knowledge_base, list_skills, save_skill, list_mcp_servers, save_mcp_server, test_mcp_server, list_global_agents, save_global_agent, inspect_audit_log, inspect_run_analytics, create_project, get_project, list_tasks, get_task, create_task, move_task, comment_on_task, set_task_owner, update_task, run_agent_on_task, get_github_state, update_project_settings, update_stages, set_transition_boundary, invite_member, set_member_role, deploy_agent, update_agent_deployment, create_goal, list_goals, get_goal, update_goal` (`controller-toolkit.server.ts:271-2079`). `move_task` into the terminal stage answers "[denied] Moving KEY into Done means accepting its completion, which carries its own confirmation and merge consequences. Decide it on the task page: projects/<slug>/tasks/<KEY>." (:1140-1145). `run_agent_on_task` with `agent: "operator"` runs the operator (`trigger: "manual"`, refusals "[denied] The operator is not run while a decision packet is open. Answer the packet first." / "[denied] KEY is already Done; …") else `startAgentRun(profileId)` (:1418-1462). `get_github_state` is read-only (:1470-1500). Delivery therefore happens only through the operator's tool or a human's button.
- Push grant: `resolveDeliveryPushGrant` (:5168) -> deliverer must resolve `canCommitPush` (`execute-code-or-write-repo` / `commit-push-branch`); no deliverer = true; unresolvable = false (:5175-5188). A withheld grant -> `pushWorkspaceBranch` returns `grant_withheld`.

---

## 6. `performDelivery` step by step (`task-actions.server.ts:5323-5908`)

Return type `DeliveryOutcome`: `delivered {prNumber, url, created, pushStatus, headSha, moved, operatorRequeued} | push_conflict | grant_withheld | push_failed | scope_violation | nothing_to_review | failed` (:5279-5310).

Every failure writes ONE timeline event (`type: github`, actor `system:delivery`) AND a `policy` notification to task watchers with the same title/text via `surfaceDeliveryEvent` (:6052-6090).

| # | Step | Outcome / sentence |
|---|---|---|
| 0 | `ensureDefaultBranchBeforePush` (:5340) | `bootstrap_failed` -> title "Delivery could not run", text "KEY's repository has no `main` branch and Viberr could not create it (<reason>). Nothing was pushed: a task branch must never become the repository's first ref. Create `main` on GitHub (or fix what GitHub named), then deliver again." `scope_violation` -> "KEY's repository has no default branch and creating it was refused: the project credential lacks the `repo` scope (a scope violation is open on the task). Nothing was pushed. Grant the scope or create the branch on GitHub, then deliver again." Network/auth on the probe: push proceeds (:5334-5351) |
| 1 | `pushWorkspaceBranch` (§6a) | see table |
| 1a | `grant_withheld` | "Delivery withheld by policy": "KEY's delivering agent's repo-write capability is withheld, so its workspace branch was not pushed. Grant the capability or deliver the change by hand before accepting." (:5375-5388) |
| 1b | `push_conflict` | "Delivery push conflicted": "KEY's delivery was not pushed: <reason>. This is a branch-history conflict, not a credential problem. No review PR was opened; it would review the stale remote content instead of the delivery. Resolve the remote branch `x` (delete or rename it, or force-push deliberately), then deliver again." (:5396-5409) |
| 1c | `push_refused_scope` | flags a `workflow` violation; "Delivery push refused: workflow scope": before_push: "KEY's branch changes `f`, and the project's classic token has no `workflow` scope: GitHub would refuse the push. Nothing was pushed and no review PR was opened. Grant the `workflow` scope to the project's token on GitHub, then use Re-check on the project's GitHub view, and deliver again."; github phase: "GitHub refused to push `f` on `x`: the token lacks the `workflow` scope (<reason>). …" (:5414-5446) |
| 1d | `push_failed` / `no_pat` | "Delivery push failed": "KEY's execution branch could not be pushed (<reason or 'no project credential'>). No review PR was opened; a PR over a remote missing the newest commits would review the wrong content. Fix the push, then deliver again." plus a fenced "What the push reported:" block with git's redacted stderr (:5448-5473) |
| 1e | `pushed` with `workflowFiles.length > 0` | resolves every open `workflow` violation on the project (:5480-5496) |
| 1f | other non-push (`no_commits`, `no_branch`, `no_workspace`, `no_repo`, `task_not_found`) | verified no-change (see §6b) -> title "Nothing to deliver", sets `noChanges`, mints `kind: verified` revision, returns `nothing_to_review`; else title "Delivery could not run": `no_commits`: "KEY's workspace carries no commits ahead of the default branch, so there is nothing to review and no PR was opened. If the agent produced work, it never reached the task branch. Re-run the delivering agent, then deliver again."; `no_workspace`: "KEY has no workspace clone to deliver from, so its branch was not pushed and no review PR was opened. One opened now would review whatever the remote branch already holds, not this task's work. Run the delivering agent, then deliver again."; `no_repo`: "KEY's project has no GitHub repository configured, so nothing could be pushed and no review PR was opened. Set the repository in project settings, then deliver again."; `no_branch`: "KEY's workspace is not on a task branch, so nothing was pushed and no review PR was opened: <reason>. The delivering run must commit on the task branch. Re-run it, then deliver again." (:5573-5637) |
| 2 | `reconcileWorkspaceDelivery` (best-effort) re-mints the work revision after an auto-commit (:5645-5673) |
| 3 | `openTaskPr` (§7) | `ok` -> clears `noChanges` and `github.unownedPr` (:5703-5717), withdraws a superseded push-conflict packet (:5722), then `moved = created || push.status === "pushed"` (:5756); a reused PR whose head moved gets `recordPushedHead` (:5758-5765, §11); FULL autonomy + moved -> `autoInvokeOperator(..., "delivered")` (:5771-5784); supervised + `operatorAuthorized` -> `recordDeliveredNextStep` = a `transition` recommendation labelled "Move the task to <reviewName>" audited `github.delivery.next_step` (:6161-6171) |
| 3a | `branch_collision` | "Delivery blocked by a branch collision": the adoption refusal note (§8); returns `failed` (:5811-5821) |
| 3b | `nothing_to_review` (GitHub 422 "No commits between") | "Review has no PR": "No review pull request could be opened: the execution branch has no commits ahead of the default branch. The delivery may have produced no change, or the commits never reached the remote."; sets `noChanges` (:5825-5847) |
| 3c | `base_branch_missing` | "Review PR could not be opened": "No pull request could be opened for KEY: GitHub refused the pull request: its base branch `main` does not exist (422 base invalid). The task branch was pushed, so a delivery from this workspace cannot re-cut it: delete the task branch locally and let the deliverer re-cut it from the bootstrapped `main`, or resolve the unrelated history by hand; then deliver again." (:5852-5858) |
| 3d | `refused` | "No pull request could be opened for KEY: GitHub refused it (<msg>). Fix what GitHub named, then deliver again." (:5859-5865) |
| 3e | `auth_failed` / `network_unavailable` / `no_pat_configured` / `no_repo_configured` | "No pull request could be opened for KEY: <why>. Fix the repository/credential settings, then deliver again." (:5869-5893) |

Toast (`app/features/task-detail/delivery-toast.ts:11-17`): "Delivered · opened review PR #N" / "Delivered · pushed `sha7` to PR #N" / "PR #N already carries `sha7` · nothing to push" / "Delivery did not complete: <message>".

### 6a. `pushWorkspaceBranch` (`push-workspace.server.ts:560-930`)
| Status | Trigger |
|---|---|
| `task_not_found`, `no_repo`, `no_workspace` | missing task file / repo / `.git` (:579-601) |
| `no_branch` | HEAD is the default branch or detached; carries `defaultBranchEvidence` from three read-only probes (:620-640) |
| `grant_withheld` | `canCommitPush === false` (:656) |
| auto-commit | dirty tree committed as "`[KEY] deliver working-tree changes from the agent run`" (:705) |
| `no_commits` | 0 commits ahead of `origin/<default>` (:751) |
| `no_pat` | no project credential (:759) |
| `up_to_date` | `git ls-remote --heads origin <branch>` equals HEAD, no push (:775-787) |
| `push_refused_scope` `phase: before_push` | classic token, `headerScopes` lacks `workflow`, and `git log --format= --name-only <remoteBefore>..HEAD -- .github/workflows/` is non-empty (:291, :817-835) |
| `push_refused_scope` `phase: github` | GitHub's own workflow refusal text on push, any token kind (:849-858) |
| `push_conflict` | non-fast-forward (:871) |
| `push_failed` | anything else; `reason` <=240 chars, `stderrExcerpt` fenced (:108, :193-194) |
| `pushed {branch, headSha, remoteHeadBefore, workflowFiles: string[] | null}` | `git push origin HEAD:refs/heads/<branch>` (:922-927) |

### 6b. Verified no-change (ruling 43 / R17-2, :5545-5562)
`verifiedNoChange = push.defaultBranchEvidence.verified === true && (status === "no_commits" || (status === "no_branch" && neverDelivered))` where `neverDelivered` = no `pr`, no `workRevision`, no `branch`, no cached commits, no `github.changed`. Mints `workRevision {kind: "verified", headSha: <default head>, branch: <default>}` via `resolveNoChangeBaseRevision` (:5569-5572; a GitHub outage mints nothing and says "The default-branch head could not be read from GitHub, so no revision was recorded for the reviewers to approve. Deliver again once GitHub is reachable.").

---

## 7. `openTaskPr` (`pr-open.server.ts:340-800`)

| Step | Call | Result |
|---|---|---|
| cached live PR | `GET /repos/<repo>/pulls/<n>` | still open -> reuse (`ok, created:false`) (:380-406) |
| what is on the head | `GET /repos/<repo>/pulls?head=<owner>:<branch>&state=open&per_page=1` (:433-437) | same number as cached -> adopt; else `decidePrAdoption` (§8); refused -> `branch_collision {prNumber, branch, message}` (:451-462); adopted different number -> `recordPrAdoption(source: delivery)` |
| create | `POST /repos/<repo>/pulls` title `` `[KEY] <task title>` `` (:555) | body (:60-86): "**Viberr task:** [KEY · title](<BETTER_AUTH_URL>/projects/<slug>/tasks/<KEY>)" or plain "**Viberr task:** KEY · title" when no origin (debug log "PR body omits the task back-link — no absolute app origin; set BETTER_AUTH_URL" :517), "## Goal", optional "## Change summary", optional "## Evidence", footer "_Opened by Viberr for task KEY. Review and merge are human-authorized; accepting the completion in Viberr merges this PR when GitHub is reachable. When it is not, the acceptance is recorded as merge-pending until a human completes the merge._" |
| 2xx undecodable | salvage by `number` (:584-619) |
| 403 | `pull_request:write` scope violation (:644) |
| 422 "No commits between" | `nothing_to_review` (:671) |
| 422 "already exists" | re-read head (:673) |
| 422 `field: base, code: invalid` | `base_branch_missing` "GitHub refused the pull request: its base branch `main` does not exist (422 base invalid)." (:686-688) |
| other 422 / unmapped | `refused` quoting GitHub (:691-696) |
| 401 / network | `auth_failed` / `network_unavailable` |

Writes `pr: {number, state: "review", title, headSha}` (`writePrToTask` :706-742; a cached `accepted`/`merged` state is preserved over a live "open"); timeline `github` "Opened **PR #N** for review." authored by the Operator when `operatorAuthorized`, else the human, else `profileId: "implementation"` (:744-776); audit `github.pr.opened` only when created (:790).

---

## 8. PR adoption and branch collisions

- `decidePrAdoption` (`pr-adoption.server.ts:52-74`): refuse `merged`, `closed`, `no_revision` (task has no `workRevision`), `head_unknown`, `head_mismatch`; adopt only OPEN and `pr.head.sha === workRevision.headSha`.
- Refusal note (`prAdoptionRefusalNote`, :116+) reasons: merged -> "that PR is already merged and its work is on the base branch, so a fresh delivery fast-forwards cleanly once the stale branch name is cleared"; closed -> "that PR was closed without merging and the remote branch still holds its commits, so a fresh push would conflict until the branch is cleared" (:83-86).
- Adoption record (`pr-adoption-record.server.ts:47`): "Adopted **PR #N** (head `sha`, the delivered revision) as KEY's review PR, replacing PR #M (state). Viberr did not open it; it was found on branch `x` with this task's delivered head." + audit `github.pr.adopted {repo, branch, prNumber, previousPrNumber, previousState, headSha, source}`; the reconciler source also notifies ("PR #N adopted for KEY") (docs claim; notification text not re-verified).
- Reconciler side (`github-reconciler.server.ts:452-458, :660-676, :819-828`): a name-matched PR the task does not own = `unownedPr`; recorded in `task.md` `github.unownedPr` (schema :580); ONE `note` event by the policy engine with the refusal note, only when the number is new.
- `findPrForBranch` lists `state=all, sort=created, direction=desc, per_page=5` (`pr-linker.server.ts:379-390`) and reads `GET /pulls/<n>`, `GET /branches/<branch>`, `GET /commits/<sha>/check-runs`, `GET /pulls/<n>/reviews` (:413-483).

### `resolve_remote_collision` packet option (`task-actions.server.ts:7599-7665`, `resolveRemoteBranchCollision` `github-reconciler.server.ts:1772-1892`)
- Order: DELETE the remote branch first (`deleteTaskRemoteBranch`), then `PATCH /pulls/<unowned> {state: "closed"}` (:1819, audit `github.pr.closed_unowned`), clear `github.unownedPr`, re-run `performDelivery`, lift `readiness: blocked -> ready` (:7605-7620).
- Outcomes recorded in the packet's `serverOutcome {kind: "resolve_remote_collision", outcome, reason?, prNumber?}` (`app/shared/packet-server-outcome.ts:33`): `cleared_and_delivered`, `cleared_delivery_failed` ("The stale remote branch was cleared, but the re-delivery did not complete: <msg> Deliver again from the task page when it is resolved."), and the own-PR arm "No collision to clear: PR #N on `x` is KEY's own review PR." (:7640-7650).
- Audit `github.collision.resolved {outcome, reason, prNumber, delivered, blockLifted}`; exactly one hand-off (`delivered` re-queue or `packet-resolved`) (:7622-7660, ruling 136).
- Refusals reuse `BranchDeleteRefusal`: `no_actor` "No acting user.", `default_branch` "`x` is the project's default branch. Viberr never deletes it.", `own_pr_open` "PR #N is still open on `x` (confirmed against GitHub just now), and deleting the branch would silently close it. Close or merge the PR first.", `unconfirmed` "GitHub could not confirm whether PR #N is still open on `x` (<why>), so the branch was not deleted. Try again when GitHub answers.", `github_refused`, `network`; `no_context` "This project has no GitHub repo or credential configured." (:1555-1750, :1797-1800).
- `discard_branch` option: deletes the LOCAL never-pushed branch only; `on_remote` refuses (`push-workspace.server.ts:1010-1069`); audits `task.branch.discarded` / `task.branch.discard_refused`. Operator tool description forbids authoring it for a collision (`operator-toolkit.server.ts:437`).

---

## 9. Scope violations (`scope-flag.server.ts`)

- Table `scope_violations`, one open row per (project, scope, task) (docs claim; projection module not read).
- `flagScopeViolation` (:112): timeline `policy` event by `POLICY_ENGINE_ACTOR {kind: system, systemId: "policy-engine"}` (:41-44) with `policyViolationText` = "**Policy violation:** active PAT is missing `<scope>`. <consequence>" (:46-48); `policy` notification from "Policy engine" (:143-146); audit `github.scope_violation.opened`; SSE `violation.updated` (docs claim).
- `resolveScopeViolationWithEvent` (:157): "**Policy update:** `<scope>` granted on the project credential. The earlier violation is resolved, and operations needing `<scope>` will work now." (:50-56); audit `github.scope_violation.resolved`.
- Openers: branch ref read/create 403 (`repo`), compare 403 that is not `rate_limited` (`repo`, reconciler :360-381), PR open 403 (`pull_request:write`), merge 403 (`pull_request:write`, reconciler :1507-1536), workflow-file push refusal (`workflow`), bootstrap 403 (`repo`).
- Resolvers: successful merge proves `pull_request:write` (`markWriteScopeProven`); successful push of workflow files resolves `workflow`; Re-check with header evidence (`grant-scope` intent).
- `rate_limited` (403 with rate-limit wording) is transient and opens nothing (`branch-sync.server.ts:329`; reconciler :355-359).

---

## 10. Reconciler and poller

### `reconcileTask` (`github-reconciler.server.ts:320-1050`, serialized per task :1024)
1. No `branch:` -> `no_branch` (:333). Compare `GET /repos/<repo>/compare/<default>...<branch>` via `getBranchCompare` (statuses `ok | missing_ref | forbidden | rate_limited | auth_failed | network_unavailable`, `branch-sync.server.ts:252-262`).
2. `findPrForBranch` -> PR facts: state (`open`/draft -> `review`; `merged`; `closed`), checks summary, review state, mergeable (`clean | conflicting | unknown`), head sha. A cached `accepted` survives a live "open" (:402-406); settled PRs drop `review`/`mergeable` (:416-428).
3. Ownership (:452-458): same number as cached -> owned; else adoption rule; else `unownedPr`.
4. Drift (:467-556): with an owned live PR and `reviewedSha = workRevision.headSha`: head equal -> no drift; compare `reviewedSha...head` `ahead` -> `pr.revisionDrift {headSha, authored, baseRefresh}` (authored = commits not in the base and not a recorded `baseRefreshes[]` merge); `behind`/`diverged` -> `pr.unpushedRevision {revisionSha, prHeadSha, relation}`; 404 compare confirmed by 404 `GET /commits/<reviewedSha>` -> relation `unknown` (:535-541). Sentence: `describeRevisionDrift` in `app/shared/revision-drift.ts`.
5. Human approval (:559-566): `derivePrHumanApproval` binds an APPROVED review whose `commit_id === deliveredSha` to a member via `users.github_handle` (`pr-human-approval.server.ts:93-160`); statuses `counted | unlinked_handle | ambiguous_handle | not_a_member | stale_revision` (:45-53); stored under `pr.humanApproval` (:75).
6. Writes `pr` and `github {commits, changed, unownedPr}` when changed (:757-816); never mints a PR link, never downgrades `merged`/`accepted`.
7. Divergence notes (`note`, policy engine) on the TRANSITION only (:700-760):
   - merged, task not terminal: "**Divergence:** PR #N was merged on GitHub, but KEY hasn't been accepted through Viberr, so its stage is unchanged. Accept the completion (or move it to Done) so the task reflects the merge." (+ " The now-moot “<label>” recommendation was withdrawn." when any)
   - closed unmerged, task active: "**Divergence:** PR #N was closed on GitHub without merging, but KEY is still active. Decide whether to rework and reopen, or archive the task."
   - accepted then closed externally: "**Note:** accepted PR #N was closed on GitHub without merging, so the pending merge can no longer be completed from Viberr."
   - reopened: "**Note:** PR #N was reopened on GitHub. KEY's review is live again and the closed-PR block is lifted." / "**Note:** PR #N now tracks KEY's branch on GitHub, replacing closed PR #M, so the closed-PR block is lifted."
   - `policy` notification titles: "PR #N merged on GitHub: accept KEY", "PR #N closed on GitHub: KEY needs a decision", "Accepted PR #N closed on GitHub: KEY's merge can't complete", "PR #N live again on GitHub: KEY resumes" (:907-930).
   - Operator wake `autoInvokeOperator(..., "pr-diverged")` on merged-not-done, closed-active, accepted-closed, reopened, or a live PR replaced by adoption (:939-957). NEVER auto-advances the stage.
8. Provenance `github.reconcile` (skipped on unchanged poller ticks, :962-991); audit `github.reconcile.task {repo, branch, changed, sync}` (:993-1000); `sync` = `merged | behind_main | synced` (`branch-sync.server.ts:361`).

### Cadence
- `RECONCILE_POLL_MS = 5 min` (`reconcile-poller.server.ts:41`), boot pass then interval (:299-322); projects: `p.archived = 0` with at least one branched task (:72-75, :193-200); `RECONCILE_TASK_CONCURRENCY = 4`, `RECONCILE_POLL_TASK_BUDGET = 20` per project per tick with a rotating cursor (`github-reconciler.server.ts:1073-1092`); terminal tasks skipped (docs claim).
- `RECONCILE_FAILURE_ALERT_THRESHOLD = 3` (:129) -> one `policy` notification to admins+maintainers titled "GitHub sync is failing for this project", text "Viberr has been unable to reach GitHub for this project's repository across N checks. Branch and PR status may be stale (a merged or closed PR can still show open). Check the project's GitHub credential — the token may be expired, revoked, or missing repository access." (:160-176).
- Merge-pending nudge: "PR #N accepted: merge to finish KEY" deduped by title (:85-95).
- Manual: GitHub view intent `reconcile` (`project.github.tsx:131`). Freshness: `STALE_AFTER_MS = 1h` (`app/shared/freshness.ts:21`); chip shows "last change <label>" and stale/never-synced states (`github-view.tsx:536-565`). Repo-access check cached `REPO_ACCESS_TTL_MS = 30_000` (`github-query.server.ts:123`).
- DRIFT (unverified): docs §6 names a second intent `reconcile-github`; only `reconcile` was found in `project.github.tsx`.

---

## 11. Revisions, verdicts, validation

- `workRevision {id, headSha, treeSha, branch, createdAt, sourceProfileId, kind: "delivered" | "verified"}` (`task-file.schema.ts:654-680`).
- `reconcileWorkspaceDelivery` (`workspace-delivery.server.ts:294-770`): reads HEAD and `HEAD^{tree}` (:443-453); same tree = same revision (verdicts survive); a new tree mints a new id which stales every verdict (:430-431, :476-481); writes `github.commits`; links a PR the agent opened itself (`gh pr view`, :262+) through the adoption rule; audits `github.workspace.branch_reconciled` (:549) and `github.workspace.pr_linked` (:728); writes `pr.unpushedRevision` the moment a revision is minted on a branch whose PR is open (:678-694) with timeline text "Revision `rev` from the specialist workspace is not on **PR #N** (its head is `sha`). Delivering the branch pushes it." / "…its head `sha` holds commits this workspace does not. Resolve the branch history, then deliver the branch to push it." (:241-260). Ruling 137: a new revision withdraws acceptance offers with a `note` "Recommendation withdrawn" (:499-540; `task-mutation.server.ts:377-388`).
- `verdicts[] {profileId, revisionId, headSha, result, reason, at}` (:684-700); `currentVerdicts` = verdicts whose `revisionId === workRevision.id` (:899-907); `requiredReviewers` = engagements with `!delivers && verdictCapable` (:894-896).
- `deriveValidation` (:912-964): no revision -> `none`; a required `request_changes` -> `failing`; all required approve -> `healthy`; `acceptance === "forced"` -> `bypassed`; `noChanges` with no required reviewers -> `none`; else `changed`.
- Human GitHub approval counts as the verdict only in `verdictGateReason` (§12), never for a required engaged reviewer (`pr-human-approval.server.ts:333-350`).
- `recordPushedHead` (`task-actions.server.ts:6008-6050`): timeline `github` "Pushed `sha7` to **PR #N** for review (was `old7`)" with the same author rule as "Opened PR".

---

## 12. Acceptance

### Gate order `acceptanceRefusalReason` (`task-actions.server.ts:8010-8062`) with exact sentences
1. archived: "KEY is archived. Restore it before accepting the completion." (`task-file.schema.ts:1078`)
2. closed PR (terminal, outranks everything): "KEY's review PR was closed on GitHub without merging, so it can't be accepted. Rework and reopen the PR, or archive the task." (:1020-1026)
3. stage boundary: "KEY is at <stage>, not <review>. A completion can only be accepted from the boundary the workflow puts before <Done>. Move the task through the workflow first." (:7990-7998)
4. required reviewers (`acceptanceBlockedReason`, :976-1002): no revision -> "No reviewed revision yet, so there is nothing for the required reviewers to approve. If this task requires no changes, run delivery once to verify and record that."; request_changes -> "This task's latest review requests changes on the current revision. Rework and re-review before accepting."; missing -> "Waiting on N required reviewer approval(s) of the current revision."
5. live no-change probe with WORK found (its own sentence naming the branch and commit count)
6. verdict gate (`verdictGateReason`, `pr-human-approval.server.ts:306-360`): delivered work, no PR -> "KEY has delivered work but no review pull request. Deliver the branch & open the PR before accepting." (skipped for `noChanges`, `kind: verified`, or a live-verified empty branch); otherwise `healthy`/`failing` pass, a counted human approval passes, else "KEY's delivered revision has no approving verdict yet. <near-miss note>" or "…Run a review for a verdict, approve the pull request on GitHub, or an admin can force-accept."
7. open blocked packet: "This task has an open blocked decision. Resolve the operator's packet before accepting it."
8. unpushed delivered revision (ruling 135, `task-file.schema.ts:528-541`): "KEY's delivered revision `rev` is not on PR #N (its head is `sha`). Deliver the branch to push it; it cannot be accepted until the PR carries the reviewed revision." / diverged: "…whose head `sha` holds commits this workspace does not. Resolve the branch history, then deliver the branch to push it; it cannot be accepted until the PR carries the reviewed revision."
9. conflicting PR: "KEY's review PR #N conflicts with the base branch. GitHub can't merge it, so it can't be accepted. Rebase the branch and re-review, or archive the task." (:1041-1050)

### Doors
| Door | Intent / tool | Authority | Notes |
|---|---|---|---|
| Accept dialog (task page, board move into Done, applied recommendation) | `accept-completion` (`project.task.tsx:668`) | `accept-completion` (admin, maintainer, `rbac.ts:73`) | must echo the ruling-88 disclosure; refusal "acceptance of KEY carried no disclosure acknowledgment" (:8658); `data-screen-label="Accept completion dialog"` (`accept-confirm.tsx:281`); headings "Accept this completion?", "Moving to <Done> accepts this completion", "Run the merge now?", "Apply this recommendation?", "Force-accept this completion?" (:92-104) |
| Force accept | `force-accept` (:742) -> `forceAcceptCompletion` (:9288) | `force-accept-completion` (admin only, `rbac.ts:88`) | bypasses process gates, never a closed PR, never the head-containment check; writes `acceptance: "forced"` (:8812); audit `task.acceptance.forced` (:9371); button shown only when wedged (open blocked packet or work to accept) and not terminal (`task-side-panels.tsx:125-150`, ruling 124); dialog footer "Admin override. The bypassed gate is recorded to the audit log." |
| Operator `accept_completion` | capability `completion-for-acceptance` | full autonomy writes `pr.state: accepted` and NEVER merges; supervised posts a recommendation card (`operator-toolkit.server.ts:687`) |
| Complete merge | `complete-merge` (:656) -> `completeTaskMerge` | admin/maintainer | toast `result.message` or "Not merged: <message>" |

### Merge (`mergeTaskPr`, `github-reconciler.server.ts:1316-1550`)
- Pre-check `acceptancePrHeadMismatch` (`task-actions.server.ts:8231+`): compare-based; `verified | unverifiable | not-applicable`.
- If the PR is a draft: GraphQL `markPullRequestReadyForReview` best-effort (:1355-1365).
- `PUT /repos/<repo>/pulls/<n>/merge` with body `{}` (:1373-1376): no `merge_method`, no `sha` guard; GitHub's repo default method applies.
- Mapping: 405 -> `not_mergeable` (GitHub's message; accept-time cause "GitHub refuses to merge KEY's review PR #N: <msg>", or when `conflicting` the conflict sentence, `task-actions.server.ts:6300-6325`); 409 -> `head_changed` ("PR #N's head changed on GitHub while it was being accepted. Re-review the new head, then accept."); 403 -> `pull_request:write` violation + audit `github.pr.merge_refused`; 404 -> `pr_not_found`; 401 -> `auth_failed`; network -> `network_unavailable`.
- Success writes `pr.state: "merged"` (:1402), provenance `github.merge`, audit `github.pr.merged` (:1422-1426), proves the write scope and resolves its violation, then `branchCleanupOnMerge` when guardrail `delete-branch-after-merge` is on (absent = on; `branch-cleanup.server.ts:23-32`).
- Unreachable / refused-unforced -> the acceptance is recorded with `pr.state: "accepted"` and the completion event says "Human acceptance recorded. Task transitioned to **Done**; the review PR is **accepted, merge pending** (<cause>)." (:6922, :9137); causes: "GitHub rejected the project credential", "this project has no GitHub repo/credential configured", "GitHub no longer has PR #N", "GitHub was unreachable", "the delivered revision is not on the PR; deliver the branch to push it, then merge", "the PR head changed on GitHub; re-review the new head, then merge" (:6300-6352).
- Completion event `type: "completion"`; stage transition audited `task.transition` (:9170).

---

## 13. Rejection paths (what viberr records, way out)

| Event on GitHub | Detection | Record | Way out |
|---|---|---|---|
| Human closes the PR unmerged | reconciler transition to `closed` | `pr.state: closed`; `note` "**Divergence:** PR #N was closed on GitHub without merging…"; `policy` notification "PR #N closed on GitHub: KEY needs a decision"; moot `transition`/`accept_completion` recommendations withdrawn; operator woken `pr-diverged` (opens a rework/archive/archive+deleteBranch packet per docs) | acceptance refused by gate 2 (terminal, no force-accept offered); rework then a delivery reopens (a NEW PR on the same branch adopts only if head == revision); or `archive_task` (option `deleteBranch: true` deletes the remote branch, `task-actions.server.ts:7385`); a reopen on GitHub heals ("live again") |
| Requests changes on GitHub | `pr.review` pill only (`deriveReviewState`) | informational; NOT a gate (docs §5; `verdictGateReason` only counts APPROVED) | nothing blocks; verdict gate still needs an engaged reviewer's approve or a counted human APPROVED review |
| Human approves on GitHub | reconciler `pr.humanApproval` | `counted` when `commit_id === workRevision.headSha` and the login maps to exactly one enabled member by `users.github_handle`; else `unlinked_handle` / `ambiguous_handle` / `not_a_member` / `stale_revision` with a near-miss sentence in the verdict refusal | link the handle in the user profile, re-approve the current head |
| PR merged by hand | reconciler transition to `merged` | `pr.state: merged`; `note` "**Divergence:** PR #N was merged on GitHub, but KEY hasn't been accepted…"; notification "PR #N merged on GitHub: accept KEY"; operator woken | accept (the merge call answers `not_mergeable`/405 "already merged"; the accept path records it) or move to Done |
| Branch deleted on GitHub | compare `missing_ref` -> `compare: null`; `findPrForBranch` still finds the PR by head name | no dedicated note found in code (observation target); a later push re-creates the ref (`push HEAD:refs/heads/<branch>`), a later delivery from a workspace still on the branch works | deliver again |
| Accepted (merge pending) then closed | `acceptedClosedExternally` | `note` "**Note:** accepted PR #N was closed on GitHub without merging, so the pending merge can no longer be completed from Viberr."; notification "Accepted PR #N closed on GitHub: KEY's merge can't complete"; task stays Done with `pr.state: closed` | none in product (observation target) |
| Force-push / diverged remote | push `push_conflict` | "Delivery push conflicted" event + (operator) blocked packet with `resolve_remote_collision` | packet Confirm deletes the remote branch, closes an unowned PR, re-delivers; own-PR-open arm refuses deletion |

---

## 14. task.md fields written per step (schema `task-file.schema.ts`)

| Field | Writer | Shape |
|---|---|---|
| `branch` | `ensureTaskBranch` (:730-735), workspace reconcile | string |
| `pr` | `writePrToTask`, reconciler, acceptance, merge | `{number, state: review|merged|closed|accepted (PR_STATE_VALUES :367), title, checks?, review?, mergeable?: clean|conflicting|unknown, headSha?, revisionDrift?: {headSha, authored, baseRefresh: {merges, commits} | null}, unpushedRevision?: {revisionSha, prHeadSha, relation: behind|diverged|unknown}, humanApproval?}` (:424-495) |
| `github` | reconciler, workspace reconcile | `{commits: [{sha, msg}], changed: {files, add, del} | null, unownedPr?: number | null}` (:571-585) |
| `workRevision` | workspace reconcile, no-change delivery, verdict-time mint | §11 |
| `verdicts[]` | `recordAgentCompletion` (:3105 region) | §11 |
| `baseRefreshes[]` | `update_branch_from_base` | `{mergeSha, …}` (:721-740, :820) |
| `noChanges` | delivery (§6b, §6 3b); cleared on a real PR | boolean (:842) |
| `acceptance` | force accept | `"forced" | null` (:849) |
| `readiness` | packets; lifted by collision resolve | `ready | input_required | inconsistency_risk_detected | blocked` (:28-33) |
| `validation` | cache recomputed by `deriveValidation` | `none | failing | healthy | bypassed | changed` |
| timeline `type` | | `comment, completion, github, policy, note, quality, transition, blocked, agent, assign, …` (:110-125) |

---

## 15. Audit action names (grep of `action: "…"` across `app/server`, tests excluded by eye)

`github.pat.created`, `github.pat.token_replaced`, `github.pat.deleted`, `github.credential.assigned`, `github.credential.cleared`, `github.credential.revalidated`, `org.connection.validation_downgraded`, `github.repo.bootstrapped`, `github.branch.created`, `github.branch.deleted`, `github.branch.prepare_failed`, `github.branch_update.operator`, `github.collision.resolved`, `github.pr.opened`, `github.pr.adopted`, `github.pr.merged`, `github.pr.merge_refused`, `github.pr.closed_unowned`, `github.reconcile.task`, `github.reconcile.project`, `github.scope_violation.opened`, `github.scope_violation.resolved`, `github.workspace.branch_reconciled`, `github.workspace.pr_linked`, `github.delivery.manual`, `github.delivery.operator`, `github.delivery.next_step`, `task.agent.github_read`, `task.branch.discarded`, `task.branch.discard_refused`, `task.acceptance.forced`, `task.transition`, `task.packet.resolved`, `task.packet.withdrawn_superseded`.
Provenance actions: `github.reconcile`, `github.merge`, `github.branch_delete`.
DRIFT (minor): docs §9 lists `project.repo.updated` and `github.pat.*` generically; `project.repo.updated` was not found by the grep pattern used (may be written under another literal). Unverified.

---

## 16. Exact GitHub API operations and credential

All calls use the PROJECT-BOUND PAT via `getProjectGithubContext` unless noted. Base `https://api.github.com` (`github-client.server.ts:24`), 20 s timeout, one retry on 5xx.

| Operation | Endpoint | Module |
|---|---|---|
| Validate token identity | `GET /user` | pat-validator (connection PAT at add time; project PAT on re-check) |
| Validate repo access | `GET /repos/<repo>` | pat-validator, project-create (connection PAT), settings repair (bound PAT), repo-bootstrap |
| Fine-grained read probe | `GET /repos/<repo>/pulls?per_page=1&state=all` | pat-validator |
| Optional write probe | `POST /repos/<repo>/pulls` body `{}` (env opt-in) | pat-validator |
| `read:org` probe (only if policy requires) | `GET /user/orgs?per_page=1` | pat-validator |
| Branch name probe | `GET /repos/<repo>/git/ref/heads/<branch>`; `GET /repos/<repo>/pulls?head=<owner>:<branch>&state=all&per_page=1` | branch-sync |
| Default branch probe | `GET /repos/<repo>/git/ref/heads/<default>` | branch-sync, repo-bootstrap, delivery step 0 |
| Branch listing (bootstrap) | `GET /repos/<repo>/branches?per_page=1` | repo-bootstrap |
| Initial commit | `PUT /repos/<repo>/contents/README.md` | repo-bootstrap |
| Root commit walk | commits list on `<from>` (paged) | repo-bootstrap `rootCommitOf` |
| Create ref | `POST /repos/<repo>/git/refs` | branch-sync, repo-bootstrap |
| Restore default branch | `PATCH /repos/<repo> {default_branch}` | repo-bootstrap |
| Compare | `GET /repos/<repo>/compare/<base>...<head>` | branch-sync `getBranchCompare` (reconciler, drift, head check) |
| Commit read | `GET /repos/<repo>/commits/<sha>` | reconciler (unpushed confirmation) |
| List PRs on head | `GET /repos/<repo>/pulls?head=…&state=open|all` | pr-open, pr-linker |
| PR detail | `GET /repos/<repo>/pulls/<n>` | pr-open (cached live check), pr-linker, merge (draft check) |
| Branch detail | `GET /repos/<repo>/branches/<branch>` | pr-linker |
| Check runs | `GET /repos/<repo>/commits/<sha>/check-runs` | pr-linker |
| Reviews | `GET /repos/<repo>/pulls/<n>/reviews` | pr-linker (human approval) |
| Create PR | `POST /repos/<repo>/pulls` | pr-open |
| Close unowned PR | `PATCH /repos/<repo>/pulls/<n> {state: closed}` | reconciler `resolveRemoteBranchCollision` |
| Un-draft | GraphQL `markPullRequestReadyForReview` | reconciler `mergeTaskPr` |
| Merge | `PUT /repos/<repo>/pulls/<n>/merge` body `{}` | reconciler `mergeTaskPr` |
| Delete branch | `DELETE /repos/<repo>/git/refs/heads/<branch>` (docs claim; reconciler :1596-1740, exact path not re-read) | reconciler `deleteTaskRemoteBranch` |
| git clone/fetch (mirror) | `https://github.com/<repo>.git` via `GIT_ASKPASS` | repo-mirror |
| git ls-remote / push | `origin` of the delivering workspace via `GIT_ASKPASS` (30 s / 120 s per docs; push timeout not re-read) | push-workspace |
| git fetch/merge/push (base refresh) | workspace via `GIT_ASKPASS` | update-branch |
| Agent read tool `github_read` | `GET /repos/<owner>/<name>/<subpath>` only, Claude only, capability `read-github-api` (default off) | agent-github-read (`agent-toolkit.server.ts:491-505`) |

No call ever uses a connection PAT for a project-scoped operation except project creation's probe and the org Connections panel.

---

## 17. Operator base refresh (`update_branch_from_base`, capability `update-task-branch`)

- `updateTaskBranchFromBase` statuses: `updated | already_current | conflict | push_conflict | update_failed | dirty_workspace | no_branch | no_workspace | no_repo | no_pat | task_not_found` (`update-branch.server.ts:99-137, :264-323`); remote state `current | behind {commits} | diverged | absent | unknown` (:84-89).
- Operator outcomes `done | noop | denied` (`update-branch-operator.server.ts:273-470`); a conflict/push_conflict opens a human `blocked` packet whose options are "Have <deliverer> resolve the conflict" (recommended only when a repo-write deliverer is deployed), "Resolve `x` yourself", "Archive the task: the work is superseded" (:170-220); observation "Delivering agent: <name>|none" (:443); audit `github.branch_update.operator {resolver}` (:329).

---

## 18. Observation checklist (things to watch for, derived from the code above)

1. Empty `akin-ozer/k9s-clone`: expect ONE `github` event "Bootstrapped the repository…" on the first task that dispatches a deliverer, audit `github.repo.bootstrapped`, and the task branch `k9s-1` (lowercased key) cut from the new `main`. If the repo is not empty but has a README, no bootstrap event.
2. Second data root / reused key: branch `k9s-1` taken by a prior PR -> the task gets `k9s-1-<4hex>` silently (only `task.md branch:` shows it). Watch that surfaces print the recorded branch, not the derived one.
3. Deliver button on a task with no run: must produce the "Delivery could not run" event and toast "Delivery did not complete: …", never silence.
4. `up_to_date` reuse: toast "PR #N already carries `sha7` · nothing to push", no operator re-queue.
5. Merge uses the repo's default merge method; a repo requiring squash/rebase-only or protected `main` yields `not_mergeable` -> "accepted, merge pending" with the cause. The PR body's footer promises a merge on acceptance; a ruleset makes that a lie worth noting.
6. A PR opened by the AGENT itself (`gh pr create`) is linked by `reconcileWorkspaceDelivery` only if head == revision; a draft is un-drafted at merge time.
7. Human GitHub approval counts only when `users.github_handle` is linked and the approval is on the CURRENT head; a re-push stales it (`stale_revision`).
8. `workflow` scope: a fine-grained token missing "Workflows" permission passes validation; the first CI-file push fails at GitHub and is classified `push_refused_scope` (phase `github`) only if GitHub's text matches the classifier; otherwise `push_failed`.
9. Branch deleted on GitHub while the task is active: no dedicated note found in the reconciler; check what the GitHub card says (compare `missing_ref` -> null compare).
10. Accepted-then-closed: task stays Done with `pr.state: closed`; verify the record does not claim a merge.

---

## Gap fill: Work-revision drift: exact sentences, where rendered, how to provoke authored vs base-refresh drift, effect on acceptance

Everything below is verified against the working tree of `pass35/k9s-clone-observation` unless marked otherwise. Rulings: R17-1 (`decisions.md:446-461`, accept an AHEAD head but surface it), 132 (`decisions.md:2389-2412`, drift = AUTHORED commits, base refresh reported apart), 135 (`decisions.md:2490-2514`, unpushed delivered revision is its own gate).

### 20.1 The two records on `task.md` `pr:` (`app/schemas/task-file.schema.ts:424-492`)

| Field | Shape | Written by | Meaning |
|---|---|---|---|
| `pr.headSha` | full sha, optional key (:447) | reconciler (`github-reconciler.server.ts:587`), `writePrToTask` (`pr-open.server.ts:734`), workspace reconcile (`workspace-delivery.server.ts:677`) | the PR head as GitHub last reported it; carried across a reuse of the SAME PR number, never inherited by a different number |
| `pr.revisionDrift` | `{headSha, authored: int>=0, baseRefresh: {merges: int>=0, commits: int>=0} \| null}` (:457-468) | reconciler ONLY (:522-530); operator base refresh triggers a reconcile immediately (`update-branch-operator.server.ts:365`) | PR head is strictly AHEAD of `workRevision.headSha`. `authored` = commits that ship unreviewed |
| `pr.unpushedRevision` | `{revisionSha, prHeadSha: string \| null, relation: "behind" \| "diverged" \| "unknown"}` (:481-488) | reconciler (:538-556) and workspace reconcile the moment a delivering run mints a revision (`workspace-delivery.server.ts:671-679`); cleared by a push whose live head equals the revision (`pr-open.server.ts:736-738`) | the delivered revision is NOT on the PR |
| `baseRefreshes[]` | `{mergeSha, baseSha, base, commits, at}` (:721-738), frontmatter field (:820) | `operatorUpdateBranchFromBase` under the file lock, before its reconcile (`update-branch-operator.server.ts:355-363`) | the `--no-ff` merge commits Viberr itself made; the classifier's whitelist |

- `unpushedRevisionOf(pr, currentRevisionSha)` (:507-517) returns null when the PR is `merged`/`closed`, when there is no record, or when `record.revisionSha !== currentRevisionSha` (a record for an older revision reads as nothing). Every consumer goes through it.
- `revisionDrift` has NO such staleness guard: a record whose `headSha` is no longer the live head is printed until the next measurable reconcile pass overwrites it (see 20.7 candidate).

### 20.2 `describeRevisionDrift` (`app/shared/revision-drift.ts:59-87`), every sentence

`plural(n, noun)` = `"1 noun"` / `"N nouns"`. `refresh` counts only when `merges > 0 || commits > 0`; `authored` is clamped at 0.

| `kind` | Condition | `sentence` (verbatim) | `unreviewed` |
|---|---|---|---|
| `none` | no record, or `authored === 0` and no refresh | `""` | false |
| `authored` | `authored > 0`, no refresh | `1 authored commit since review merges unreviewed` / `N authored commits since review merge unreviewed` | true |
| `base_refresh` | `authored === 0`, refresh present | `base refreshed · 1 merge commit · 4 base commits · 0 authored commits since review` (nouns pluralise: `0 merge commits` for a fast-forward refresh) | false |
| `both` | both | `2 authored commits since review merge unreviewed · base refreshed · 1 merge commit · 4 base commits` | true |

The separator is the middle dot ` · ` (U+00B7), not a hyphen. Verb agreement: `merges` for exactly 1 authored, `merge` otherwise (:71).

`revisionDriftNote(drift)` (:95-110), the completion-record suffix appended by every acceptance writer (`task-actions.server.ts:6898/:6919`, `:9103/:9137`, operator accept `operator-actions.server.ts:3105`); `head` = first 12 chars of `drift.headSha` in backticks:

| kind | Suffix (leading space is part of it) |
|---|---|
| `base_refresh` | ` The PR head (\`<head12>\`) carries a base refresh made after the review (1 merge commit, 4 base commits) and no authored commits outside the reviewed revision: <sentence>.` |
| `authored` | ` 1 authored commit was added to the PR head (\`<head12>\`) after the review, outside the reviewed revision: <sentence>.` (N>1: ` N authored commits were added …`) |
| `both` | ` N authored commits were added to the PR head (\`<head12>\`) after the review, outside the reviewed revision; the head also carries a base refresh (1 merge commit, 4 base commits): <sentence>.` |

### 20.3 How the reconciler derives it (`github-reconciler.server.ts:467-556`)

Preconditions, ALL required (:507): a PR found on the branch AND owned (same number as cached, or adopted under R16-1 open+head==revision, :449-458) AND `fm.workRevision.headSha` present AND `pr.headSha` present AND `driftMeasurable` = live `prState` is `review` or `accepted` (:487). A settled PR (merged/closed) measures nothing and CARRIES the cached `revisionDrift` forward (:579-581); a cached `unpushedRevision` is likewise carried when unmeasured (:589-591).

1. `pr.headSha === reviewedSha` -> no drift, `unpushedMeasured = true` (:508-509). No extra API call.
2. Else one extra call `GET /repos/<repo>/compare/<reviewedSha>...<prHead>` with `per_page: 250` (`branch-sync.server.ts:270-275`); each commit carries `fullSha` and `parents[]` (:286).
3. compare `status === "ahead"` and `aheadBy > 0` (:518): `classifyRevisionDrift({headSha, since: <that compare>, base: <the default...branch compare from step 1 of reconcile, :342-347>, recordedMergeShas: baseRefreshes[].mergeSha})` (`revision-drift.ts:148-171`):
   - fail-closed: returns null unless `base` was read AND both compares are complete (`droppedCommits === 0 && commits.length >= aheadBy`). GitHub lists at most 250 commits per compare, so a drift of >250 commits is unclassifiable.
   - per commit in `since`: not in the branch's own commits (`base.commits`) -> base commit (`commits += 1`); two-parent AND its sha is in `recordedMergeShas` -> `merges += 1`; anything else -> `authored += 1` (a merge Viberr did not record counts as authored; a `merge --ff` refresh produces no merge commit at all so `merges` can be 0).
   - null -> `cachedPr.revisionDrift` if any, else `{headSha, authored: aheadBy, baseRefresh: null}` (:526-531): never "no drift" from silence. Test proof: `github-reconciler.server.test.ts:305-352` mocks `commits: []` with `ahead_by: 2` and expects `authored: 2`.
4. `identical` -> nothing (:533). `behind`/`diverged` -> `unpushedRevision {revisionSha: reviewedSha, prHeadSha, relation: <status>}` unless `workRevision.kind === "verified"` (:535-540).
5. compare `missing_ref` (404) -> probe `GET /repos/<repo>/commits/<reviewedSha>`; a second 404 -> `relation: "unknown"` (:542-554). Any other failure leaves both unmeasured (cached records carried).
6. `pr.headSha` written on every pass (:587); the write happens only when the `pr` object changed (`:757-816`, §10 item 6). Audit `github.reconcile.task {repo, branch, changed, sync}`.

`prState` for `driftMeasurable` keeps a cached `accepted` over a live open PR (:404-408), so a merge-pending PR is still measured.

Docs claim (`docs/domain/github-delivery.md:259-270`) matches the code. Docs claim `:311-315` "revision drift when the head is ahead of the reviewed revision, the unpushed-revision record when it is not" matches.

### 20.4 Where each record is rendered

| Surface | File:line | Prints | Precondition |
|---|---|---|---|
| Accept / Force-accept / Complete-merge dialog (`data-screen-label="Accept completion dialog"`) | `accept-confirm.tsx:236, :384-397` | row label `Merge head`, value `<headSha first 12> · <sentence>`; class `obs warn` when `unreviewed`, plain `obs` for a base refresh. Sits directly under the `Revision` row (`<workRevisionSha first 12>` or `No delivered revision recorded.`, :370-379) so the two shas are visibly different | `drift.kind !== "none"` |
| Same dialog, `Blocked` / `Bypassing` row | `accept-confirm.tsx:433-441` | `blockedReason` = the projected refusal, which for an unpushed revision is the `unpushedRevisionBlockedReason` sentence (20.5) | a standing refusal |
| Review queue row subline | `review-helpers.ts:96-103` via `prStateSub` | `PR #N is open. <sentence>.` | ONLY when `reviewRowSub` did not return earlier: `pr.state !== "closed"`, no `blockReason`, no pending goal edit, no packet (:114-132). So a drifted task that is still blocked (no verdict etc.) shows the block, not the drift |
| Review queue row subline, unpushed | `review-helpers.ts:77-83` | `PR #N does not carry the delivered revision <rev7>. Deliver the branch to push it.` / diverged: `PR #N does not carry the delivered revision <rev7>, and its head holds commits the workspace does not. Resolve the history, then deliver the branch to push it.` | ranked above `mergeable === "conflicting"` and above `accepted`; but `blockReason` (which already carries the unpushed refusal via `review-queue.server.ts:279`) wins first |
| Task page GitHub panel, `Unpushed` row | `task-side-panels.tsx:116-125, :366-380` | `<rev7> is not on PR #N (its head is <head7>)`; head clause omitted when `prHeadSha` null | `unpushedRevisionOf` non-null and PR not terminal |
| Task page GitHub panel, push button | `task-side-panels.tsx:387-416` | label `PUSH_LABEL` = `Push <rev7> to PR #N`, busy `Pushing…`, tooltip `Push the delivered revision to the open review PR (audited)`; DISABLED with tooltip `DIVERGED_PUSH_REFUSAL` = `Origin's copy of this branch holds commits the workspace does not, so a plain push would be refused as non-fast-forward. Resolve the branch history first; the operator can open a decision packet for it.` when `relation === "diverged"`. Without an unpushed record and a live PR the button is absent; with no live PR it reads `Deliver branch & open PR` | `onDeliver` supplied (maintainer+ or task owner) |
| Task page GitHub panel, `Diff` / `Commits` | `task-side-panels.tsx:340-362` | `Diff` = `github.changed` (`N files · +a −d`); `Commits` = `github.commits` = the default...branch compare FILTERED to messages starting with `[<key lowercased>]` (`branch-sync.server.ts:348-359`) | an out-of-band commit whose message lacks the `[k9s-1]` prefix is INVISIBLE in this list; the drift itself is NOT rendered on the task page at all (no `revisionDrift` consumer in `task-side-panels.tsx`) |
| Board card / board acceptance ceremony | `board-page.tsx:1060` | only `unpushedRevisionBlockedReason` (the ceremony IS `accept-confirm.tsx`, so the `Merge head` row appears there) | |
| Operator `get_task` | `operator-actions.server.ts:1973-1981` | `pr.revisionDrift` (null when kind none), `pr.revisionDriftSentence`, `pr.unpushedRevision` (via `unpushedRevisionOf`), `pr.unpushedRevisionSentence` (= `unpushedRevisionBlockedReason` or `""`) | |
| Operator turn doctrine | `operator-run.server.ts:3562-3590` | `FACT you must carry into whatever you write: the PR head (\`<head12>\`) carries N authored commit(s) pushed AFTER the last reviewed revision (<sentence>), so they are UNREVIEWED. …` / base refresh: `FACT about the PR head (\`<head12>\`): <sentence>. That is a base refresh Viberr itself merged … never send the task back for a second review of it.` | drift present |
| Completion record (timeline `type: "completion"`, title `Completion accepted`) | 20.2 `revisionDriftNote` | suffix appended to the `Human acceptance recorded. …` text | drift present at acceptance time |
| Workspace reconcile timeline (`type: "github"`) | `workspace-delivery.server.ts:241-252, :700-707` | `Revision \`<rev7>\` from the specialist workspace is not on **PR #N** (its head is \`<head7>\`). Delivering the branch pushes it.` / diverged: `…: its head \`<head7>\` holds commits this workspace does not. Resolve the branch history, then deliver the branch to push it.` / cleared: `**PR #N** carries the workspace revision \`<head7>\`.` | the unpushed record CHANGED on that reconcile; audit `github.workspace.pr_linked {repo, branch, prNumber, prState, headSha, unpushedRevision: <relation or null>}` (:721-741). Requires the agent's own `gh pr view` to answer (:254-260); no `gh` in the workspace = no record from this writer, only from the 5-min poller |
| Operator base-refresh timeline (`type: "github"`, actor operator) | `update-branch-operator.server.ts:227-240, :371-380` | `Brought \`<branch>\` up to date with \`<base>\` (N commits merged in, merge commit \`<sha7>\`; the push published it, so origin now carries the workspace head[, including the N workspace commit(s) origin was missing \| ; the branch did not exist on origin before]). Drift re-measured: <sentence>.` or `… The review PR's head now equals the reviewed revision.` or `… Drift could not be re-measured now (<reconcile status>); the next GitHub pass will.` | status `updated`; same text is the tool's `message` |

### 20.5 Effect on acceptance

Gate order in `acceptanceBlockedReason` (`task-actions.server.ts:~7990-8062`, §12): … verdict gate -> open blocked packet -> `unpushedRevisionBlockedReason` (:8060) -> `conflictingPrBlockedReason`. `revisionDrift` is in NO gate: authored drift is DISCLOSED, never refused (R17-1).

`unpushedRevisionBlockedReason(pr, currentRevisionSha, taskKey)` (`task-file.schema.ts:528-541`), exact sentences (`rev` = 7 chars, `head` = `` `<7>` `` or `an older head`):
- behind/unknown: `KEY's delivered revision \`<rev>\` is not on PR #N (its head is <head>). Deliver the branch to push it; it cannot be accepted until the PR carries the reviewed revision.`
- diverged: `KEY's delivered revision \`<rev>\` is not on PR #N, whose head <head> holds commits this workspace does not. Resolve the branch history, then deliver the branch to push it; it cannot be accepted until the PR carries the reviewed revision.`

The live head check, run by EVERY Done writer including force-accept and Complete merge (`acceptancePrHeadCheck` :8177-8196; callers :8738, :9031, :9445; force does not relax it, :8195-8215). `evaluateAcceptancePrHead` (:8247-8330), never throws:

| Live facts | `refusal` | `verification` |
|---|---|---|
| no `pr`, no `workRevision`, or `pr.state === "merged"` | null | `not-applicable` |
| `getProjectGithubContext` not ok, or `GET /pulls/<n>` fails | null | `unverifiable` (acceptance ALLOWED) |
| live `head.sha === workRevision.headSha` | null | `verified` |
| else `GET /compare/<revSha>...<liveHead>`: `ahead` or `identical` | null (an AUTHORED-drifted head MERGES) | `verified` |
| compare 404 AND `GET /commits/<revSha>` 404 | `KEY's delivered revision \`<rev7>\` is not on GitHub: PR #N's head is \`<head7>\`. Deliver the branch to push it; it cannot be accepted until the PR carries the reviewed revision.` | `verified` |
| compare failed otherwise | null | `unverifiable` |
| compare `behind` / `diverged` | `PR #N's head (<head7>) does not contain the delivered revision <rev7>: the PR carries different content than was delivered. Re-deliver the branch (or fix the remote branch), then re-review.` | `verified` |

- In-lock re-pin (`assertVerifiedHeadStillApplies` :8200-8215): if `pr.number` or `workRevision.headSha` changed between the check and the write -> `KEY's pull request or delivered revision changed while the acceptance was being verified. The PR head was never checked against what would be closed now. Refresh the task and accept again.`
- `unverifiable` + a merge that actually landed appends to the completion text (:8875-8884): `\n\nNote: PR #N's head could not be verified against the delivered revision before the merge (GitHub could not be reached for the check). It was accepted without that containment check.`
- The merge itself (`mergeTaskPr`, `PUT /pulls/<n>/merge` body `{}`, no `sha` guard, §12) merges WHATEVER the head is at that instant; GitHub 409 -> `head_changed` -> refusal `PR #N's head changed on GitHub while it was being accepted. Re-review the new head, then accept. (<GitHub message>)`, merge-pending cause `the PR head changed on GitHub; re-review the new head, then merge` (:6328-6333). GitHub returns 409 only when a `sha` is supplied and mismatches; with body `{}` a race between the check and the merge merges the newer head silently (unverified live; candidate).
- 405 with an unpushed record on file -> cause `the delivered revision is not on the PR; deliver the branch to push it, then merge` (:6303-6316), ranked above the conflict sentence.
- Verdict binding under authored drift: `verdicts[].revisionId` still equals `workRevision.id` (the revision did not change, only the PR head), so `validation` stays `healthy` and a human GitHub approval whose `commit_id === deliveredSha` stays `counted` (`pr-human-approval.server.ts`, §11). Nothing re-reviews the extra commit; the dialog's `Merge head` row is the only warning.

### 20.6 Recipes (state to expect; `KEY` = `K9S-1`, branch `k9s-1`, base `main`)

Common setup: task delivered (PR #N open, `workRevision.headSha = R`, `pr.headSha = R`, a verdict or human approval on R). `R7` = first 7 of R.

(a) AUTHORED drift, out of band on GitHub:
1. From the host: `git clone https://github.com/akin-ozer/k9s-clone && cd k9s-clone && git checkout k9s-1 && git commit --allow-empty -m "out of band" && git push origin k9s-1` (an empty commit is enough; it is NOT in `main` and NOT a recorded merge). Note the sha `H`.
2. `/projects/<slug>/github` -> `Update status` (intent `reconcile`, gate `reconcile-github`, maintainer+, `project.github.tsx:131-134`), or wait <=5 min for the poller.
3. Expect in `task.md`: `pr.headSha: H`, `pr.revisionDrift: {headSha: H, authored: 1, baseRefresh: null}`, `workRevision.headSha` unchanged (R), `verdicts[]` unchanged, `validation` unchanged. If the empty commit's message lacks the `[k9s-1]` prefix it does not appear in the panel `Commits` list; `Diff` unchanged for an empty commit.
4. Task page: NO drift indication in the GitHub panel. Review queue: subline `PR #N is open. 1 authored commit since review merges unreviewed.` only if nothing else blocks the row. Operator `get_task`: `revisionDriftSentence: "1 authored commit since review merges unreviewed"`.
5. Accept dialog: `Revision` row `R12`, `Merge head` row (warn) `H12 · 1 authored commit since review merges unreviewed`. Confirm: head check -> compare `R...H` = `ahead` -> `verified`; merge lands on H. Completion event: `Human acceptance recorded. K9S-1 transitioned to **Done** and the review PR was merged. 1 authored commit was added to the PR head (\`H12\`) after the review, outside the reviewed revision: 1 authored commit since review merges unreviewed.`
6. Side effect to watch: the delivering workspace's `k9s-1` still sits at R. `refreshWorkspaceFromMirror` fetches but never moves a task branch (`workspace-refresh.server.ts:180` returns `head: "task_branch"`), so the next agent run commits on top of R; the next `Deliver` finds `ls-remote` head H != local -> push rejected non-fast-forward -> `push_conflict` `the remote branch \`k9s-1\` holds commits that are not in the local delivery (non-fast-forward)` (`push-workspace.server.ts:865-876`), and the reconciler records `unpushedRevision.relation: "diverged"` (workspace side: `cat-file -e H` succeeds only if the checkout fetched it, else `unknown`, `workspace-delivery.server.ts:232-237`).

(b) BASE refresh through the operator:
1. Push a commit to `main` on GitHub (from the host: `git checkout main && git commit --allow-empty -m "base moves" && git push origin main`).
2. On the task: `@operator update the branch from main` (or the controller's `run_agent_on_task` with `agent: "operator"`); the operator calls `update_branch_from_base` (capability `update-task-branch`, §17). Requires a clean workspace (else `dirty_workspace`), and origin's copy of `k9s-1` not diverged (else `push_conflict` + human `blocked` packet).
3. Expect: workspace `git merge --no-ff --no-edit -m "[K9S-1] merge main into k9s-1" origin/main` (`update-branch.server.ts:407-424`), push, `baseRefreshes[]` gets `{mergeSha: M, baseSha, base: "main", commits: 1, at}`, an immediate reconcile, timeline `Brought \`k9s-1\` up to date with \`main\` (1 commit merged in, merge commit \`M7\`; the push published it, so origin now carries the workspace head). Drift re-measured: base refreshed · 1 merge commit · 1 base commit · 0 authored commits since review.`
4. `pr.revisionDrift: {headSha: M, authored: 0, baseRefresh: {merges: 1, commits: 1}}`. Accept dialog `Merge head` row is plain `obs` (no warn): `M12 · base refreshed · 1 merge commit · 1 base commit · 0 authored commits since review`. Review queue: `PR #N is open. base refreshed · 1 merge commit · 1 base commit · 0 authored commits since review.` Completion suffix: ` The PR head (\`M12\`) carries a base refresh made after the review (1 merge commit, 1 base commit) and no authored commits outside the reviewed revision: base refreshed · 1 merge commit · 1 base commit · 0 authored commits since review.`
5. Variant: do (b) then (a) -> `kind: both`: `1 authored commit since review merges unreviewed · base refreshed · 1 merge commit · 1 base commit`. Variant: merge `main` into `k9s-1` by hand on GitHub (the PR page's "Update branch" button) -> the merge commit is NOT in `baseRefreshes` -> counted as `authored: 1` plus `baseRefresh: {merges: 0, commits: 1}` -> `1 authored commit since review merges unreviewed · base refreshed · 0 merge commits · 1 base commit` (warn). This is by design (ruling 132: "a merge commit from anywhere else … counts") but reads as unreviewed work for a button GitHub offers on every PR: candidate observation.
6. Crash window: if the process dies between the push and the `baseRefreshes` write, the next pass counts M as authored until the row lands (never, after a crash) (`update-branch-operator.server.ts:350-353`).

(c) UNPUSHED delivered revision (new run after the PR):
1. With PR #N open at R, run the deliverer again (a comment `@<deliverer> add X`, or the operator's `run_agent`); it commits R2 in the workspace. `reconcileWorkspaceDelivery` mints a new `workRevision` (new tree -> new id, every verdict stale, §11) and, if the agent's `gh pr view --json number,state,title,headRefOid` answers, writes `pr.unpushedRevision: {revisionSha: R2, prHeadSha: R, relation: "behind"}` (`merge-base --is-ancestor R R2` ok) with the timeline line `Revision \`R2-7\` from the specialist workspace is not on **PR #N** (its head is \`R7\`). Delivering the branch pushes it.` Without `gh`, the poller writes the same record from GitHub's compare `R2...R` = `missing_ref` -> commit probe 404 -> `relation: "unknown"` (up to 5 min later; `prHeadSha` = R).
2. Task page GitHub panel: `Unpushed` row `R2-7 is not on PR #N (its head is R7)` and the button `Push R2-7 to PR #N` (intent `deliver-review`, `project.task.tsx:706` -> `performDelivery`). Review queue: `blockReason` = the ruling-135 refusal sentence. Accept dialog: `Blocked` row with the same sentence; the server refuses with it (gate 8) and, if a merge is attempted anyway through a stale dialog, the live check refuses `K9S-1's delivered revision \`R2-7\` is not on GitHub: …`.
3. Operator under `recommend`: card label `Push \`R2-7\` to PR #N`, body `The delivered revision \`R2-7\` is not on PR #N; delivering pushes it to that PR.` (`operator-actions.server.ts:2688-2699`); with no unpushed record: `PR #N already carries the delivered revision \`R7\`; there is nothing to deliver.`
4. After the push: `writePrToTask` sets `pr.headSha: R2` and deletes `unpushedRevision` (`pr-open.server.ts:734-738`); `recordPushedHead` timeline `Pushed \`R2-7\` to **PR #N** for review (was \`R7\`)` (§11). Verdicts must be re-run on R2 (`validation: changed`).
5. Diverged variant: do (a) first, then (c): the panel shows `Unpushed` with a DISABLED push button and the `DIVERGED_PUSH_REFUSAL` tooltip; the only outs are the operator's `resolve_remote_collision` packet option or a human resolving the branch by hand. Confirm which path the operator actually offers.

### 20.7 Proof queries

- File truth: `<dataRoot>/projects/<slug>/tasks/K9S-1/task.md` frontmatter keys `pr:` (`headSha`, `revisionDrift`, `unpushedRevision`), `workRevision:`, `baseRefreshes:`, `verdicts:` (`file-store-root.server.ts:10, :85`).
- Projection (read the DB only from inside the container, never from the host, memory trap): `sqlite3 projection.sqlite "select key, branch, work_revision_sha, json_extract(pr_json,'$.headSha') head, json_extract(pr_json,'$.revisionDrift') drift, json_extract(pr_json,'$.unpushedRevision') unpushed from task_projections where key='K9S-1'"` (`db/migrations/0001_baseline.sql:72, :144, :158`).
- GitHub side: `gh pr view <N> --repo akin-ozer/k9s-clone --json headRefOid,state,mergeable`; `git ls-remote --heads https://github.com/akin-ozer/k9s-clone k9s-1`; `gh api repos/akin-ozer/k9s-clone/compare/<R>...<H> --jq '{status, ahead_by, behind_by, commits: [.commits[] | {sha, parents: [.parents[].sha]}]}'` reproduces the classifier's input; `gh api repos/akin-ozer/k9s-clone/compare/main...k9s-1 --jq '[.commits[].sha]'` is the `branchOwn` set.
- Audit: `github.reconcile.task` rows (`changed: true` on the pass that wrote the drift), `github.workspace.pr_linked` with `details.unpushedRevision`, `github.branch_update.operator`, `github.pr.merged` (`details` carry the merged head; check it names H/M, not R, per R17-1).
- Dialog: `[data-screen-label="Accept completion dialog"] .obs .k` texts `Merges`, `Revision`, `Merge head`, `Verdict`, `Blocked`/`Bypassing`; the `Merge head` row's class list contains `warn` only for authored drift.

### 20.8 Candidate findings to confirm live

1. Authored drift is invisible on the task page itself (no `revisionDrift` consumer in `task-side-panels.tsx`, and the `Commits` list is prefix-filtered to `[k9s-1]`); the first human-facing disclosure is the accept dialog. The review-queue subline shows it only for rows with no `blockReason`.
2. `pr.revisionDrift` has no staleness guard (unlike `unpushedRevisionOf`): after a delivery that pushes a NEW revision on top of a drifted head, `writePrToTask` spreads the old record (`{...existingPr, ...fresh}`) so the dialog can print `Merge head <old H>` beside `Revision <R2>` until the next reconcile pass (<=5 min or `Update status`). Unverified live.
3. A GitHub "Update branch" click on the PR page (merge commit Viberr did not make) reads as `1 authored commit … merges unreviewed` (by design per ruling 132, but a plausible observer surprise).
4. `mergeTaskPr` sends no `sha` in the merge body; a head that moves between `evaluateAcceptancePrHead` and the `PUT` merges unverified (GitHub 409 fires only on a supplied mismatching `sha`). Code claim; race needs two actors to provoke.
5. Recipe (a) step 6: an out-of-band commit strands the delivering workspace behind origin with no automatic catch-up; the next delivery is a `push_conflict` and the panel's push button is disabled for `diverged`. Verify the operator's packet actually offers a way out.
6. Docs vs code: no disagreement found in `docs/domain/github-delivery.md:259-300` for drift/unpushed; the existing §10 item "docs claim, terminal tasks skipped by poller" remains unverified here.

---

## Gap fill: First delivery into an EMPTY repository, step by step (clone/bootstrap/branch/checkout order and what the agent is told)

Read 2026-09-06 against this tree AND against the live data root (`docker-data/projects/k9c-k9s-clone`, read-only: reflog, `task.md`, mirror config). Every claim says where. The observed KNC-1 sequence is the ground truth the code walk is checked against.

### A. The three actors that touch the workspace, and their ORDER on an empty repo

| # | Actor | Function | What it does to disk | Verified |
|---|---|---|---|---|
| 1 | Operator drive (the auto-invoked triage run, and every later operator run on the task) | `ensureOperatorRepoCheckout` (`app/server/runtimes/operator-run.server.ts:1301-1357`), called at `:1694` BEFORE the operator's persona is built | If `<taskDir>/workspace/<repoName>/.git/HEAD` exists: returns it UNTOUCHED (`:1310-1312`, comment "An EXISTING checkout is returned untouched: no remote re-sanitization and no re-strip"). Else `cloneWorkspaceRepo` into the CANONICAL delivering dir `<taskDir>/workspace/<repoName>` (`:1330-1334`), then `stripUngovernedRepoCatalog` | `operator-run.server.ts:1288-1296` says it is "the SAME checkout a specialist run uses" |
| 2 | Pre-dispatch branch hook | `ensureTaskBranchBestEffort` (`branch-sync.server.ts:403`) -> `ensureTaskBranch` (`:539`) -> `ensureDefaultBranch` (`repo-bootstrap.server.ts:154`) | GitHub only: creates `main` (initial README commit) and `refs/heads/<branch>`; writes `task.md branch:`; NO disk workspace change | Operator door: `operator-actions.server.ts:2584-2587` (`if (delivers)` after `recordAgentSelectionTrace`, BEFORE `operatorPromptAgent`). Human/controller door: `specialist-run.server.ts:1356-1369` (`if (delivers && !existing.parsed.frontmatter.branch)`), BEFORE the run reservation (`:1621`) and BEFORE `cloneRepo` (`:1650`) |
| 3 | Delivering specialist run | `cloneRepo` (`specialist-run.server.ts:3330-3520`) | Reuse path (`.git` exists, `:3421-3470`): re-sanitize origin, set identity, strip catalog, `refreshWorkspaceFromMirror({fastForward: true})`. Fresh path (`:3472-3500`): `cloneWorkspaceRepo` from the mirror (creating the mirror if cold) | `:3455` (refresh), `:3489` (clone) |

Consequences (all verified by the code order above):
- On a task whose operator has ALREADY run (the normal path: task created -> operator auto-invoked -> operator dispatches), the canonical checkout is cloned by actor 1 BEFORE actor 2 bootstraps anything. On an EMPTY repo that clone is UNBORN. The delivering run then always takes the REUSE path and the ruling-129 refresh is what puts it on `main`. The fresh-clone path with an already-bootstrapped repo happens only when the operator never ran on the task before a human/controller dispatch.
- `ensureTaskBranchBestEffort` runs BEFORE the workspace clone/refresh in both doors, so on the first delivering dispatch GitHub has `main` + `<branch>` before the mirror is refreshed. The mirror fetch then sees both.
- The operator door calls the hook on EVERY delivering dispatch (no `!branch` guard, `operator-actions.server.ts:2584`); the specialist door only when `task.md` has no `branch:` yet. Both are idempotent (`ensureTaskBranch` keeps a recorded branch verbatim, `branch-sync.server.ts:566`; a 422 "already exists" on the ref is treated as created-before, `:673`).
- The operator run does NOT refresh an existing checkout. `grep refreshWorkspaceFromMirror app/server` hits ONLY `specialist-run.server.ts:3409,3455`; `operator-run.server.ts` has no call and `:1310-1312` returns an existing checkout untouched. DRIFT: ruling 129 (`docs/architecture/decisions.md:2278-2280`) says "The operator's read-only view of the same directory is refreshed on the same terms when no delivering run is live for the task". Docs claim, code disagrees: the operator reads whatever the last delivering run left (its default-branch reads go through the mirror, `operator-repo-read.server.ts:149-157`, so those are current; the CHECKOUT it can `Read`/`Grep` is not). Candidate finding.

### B. What `git clone` of an EMPTY repository yields (verified empirically, git 2.55 host; container git 2.47.3, `init.defaultBranch` unset system+global, `docker exec` read)

| Step | Command (as the code runs it) | Result on an empty repo |
|---|---|---|
| Mirror create | `git clone --bare --progress https://github.com/<repo>.git <mirrorDir>` (`repo-mirror.server.ts:305-309`), then `config --local --replace-all remote.origin.fetch +refs/heads/*:refs/heads/*` (`:315-327`) | Succeeds with stderr "warning: You appear to have cloned an empty repository." `<mirrorDir>/HEAD` = `ref: refs/heads/main` (the remote's unborn HEAD is advertised; the live mirror `docker-data/projects/k9c-k9s-clone/.repo-mirror/akin-ozer__k9s-clone.git/HEAD` reads exactly that, with NO `init.defaultBranch` set anywhere in the container). Zero refs. `mirrorIsCold` is false from now on (`HEAD` file exists, `:143-146`) |
| Mirror refresh (every later dispatch, and the operator's default-branch read) | `git -C <mirrorDir> fetch --prune origin` (`:263-267`), 120 s budget (`MIRROR_REFRESH_TIMEOUT_MS`, `:224`) | After the bootstrap this brings `refs/heads/main` and `refs/heads/<branch>` into the mirror. Two consecutive failures rebuild it (`MIRROR_REBUILD_AFTER_FAILURES = 2`, `:235`) |
| Workspace clone | `git clone <mirrorDir> <dest>` (`:479-482`, hardlinked, full history, NO `-b`, NO `--depth`), then `setOriginUrlArgs` to `https://github.com/<repo>.git` (`:487-489`) | Unborn checkout: `.git/HEAD` = `ref: refs/heads/main`, `symbolic-ref HEAD` = `refs/heads/main`, `rev-parse --verify HEAD^{commit}` FAILS, `rev-parse --abbrev-ref HEAD` exits 128 printing `HEAD`, `status --porcelain` empty (exit 0), no `origin/main`. Directory is empty apart from `.git` |
| Direct-from-GitHub fallback (mirror unusable only) | `git clone --depth 1 <url> <dest>` (`git-clone-auth.server.ts:172`), askpass env | Same unborn shape; the only path that yields a SHALLOW clone (which `reconcileWorkspaceDelivery` deepens by 50 before counting, `workspace-delivery.server.ts:383-395`) |

Note the mirror clone is `--bare`, not `--mirror`: `refs/pull/*` are deliberately excluded (`repo-mirror.server.ts:311-314`), so a PR's head is never in a workspace unless it is also a branch head.

### C. How an UNBORN checkout is put on the task branch (ruling 129 refresh, then the agent)

`refreshWorkspaceFromMirror` (`workspace-refresh.server.ts:97-200`), delivering dispatch = `fastForward: true`, `create: true` (`:105-110`):
1. `refreshProjectMirror` (creates the mirror if missing) then `git fetch --quiet <mirrorDir> +refs/heads/*:refs/remotes/origin/*` (`:120`). Fallback with no mirror: credentialed `git fetch --quiet origin +refs/heads/*:refs/remotes/origin/*` (`:128-134`); no mirror AND no token -> `no_mirror`.
2. `rev-parse --verify origin/<default>^{commit}` (`:152`); missing -> `fetched/no_base` ("origin/* refreshed; the remote has no `main` yet, so nothing to fast-forward to"). This is what a dispatch sees if the bootstrap FAILED: the agent is then on an unborn `main` with no base and its `checkout -B <branch>` creates an unrelated root history (the pass-34 JC-2/JC-5 shape).
3. `symbolic-ref -q HEAD` (`:158`); none -> `detached`. `onDefault = symbolic === refs/heads/<default>` (`:163`). `born = rev-parse --verify HEAD^{commit}` (`:164`).
4. `status --porcelain --untracked-files=no` non-empty -> `dirty` (tracked changes only; mounted skill folders do not count, `:168-169`).
5. UNBORN (`!born`): if not on the default branch -> `task_branch` (left alone); else `git checkout -q -B <default> origin/<default>` (`:174`) -> `fast_forwarded/from: unborn`. Reflog signature: `branch: Created from origin/main` + `checkout: moving from main to main` at the same second.
6. Born: `merge-base HEAD origin/<default>` fails -> `unrelated`; not on default -> `task_branch`; same sha -> `current`; HEAD not an ancestor -> `local_commits`; else `merge --ff-only` -> `fast_forwarded/from: behind`.

The task branch itself is checked out by the AGENT, never by the server: the only server-side `checkout` on a task workspace is `push-workspace.server.ts:1082-1084` (`git checkout <defaultBranch>`, the post-accept cleanup path), and `update-branch.server.ts` merges base INTO the task branch. The prompt line that does it: "Do all work on the branch `<branch>` (create it from the default branch if it does not exist): `git checkout -B <branch>`." (`specialist-run.server.ts:2704`, only when `canBranch`). `git checkout -B knc-1` on an unborn `main` yields an unborn `knc-1` (verified empirically); on a born `main` it forks at `origin/main`'s sha.

Trap: an unborn HEAD on a branch OTHER than `<default>` (e.g. if GitHub ever failed to advertise the unborn HEAD and git fell back to `master`) is classified `task_branch` and described as "HEAD is on the task branch and was left as it is" (`:174`, `:212`), a misreport. Not observed live (the mirror HEAD proves GitHub advertised `main`); watch for it on any data root where the workspace `.git/HEAD` is not `refs/heads/main` before the first commit.

### D. What the delivering agent is TOLD (exact sentences, `buildAnalyzePrompt`, `specialist-run.server.ts:2617-2732`)

Preconditions: `input.repo` set; `delivers: true`; `delivery = resolveDeliveryPermissions(grants)` (`specialist-tool-policy.ts:227-245`): `canBranch = !withheld(execute-code-or-write-repo) && !withheld(create-task-branch)`, `canCommitPush = !withheld(execute-code-or-write-repo) && !withheld(commit-push-branch)`. `branch = task.md branch ?? taskBranchName(key)` (`:1829`); `cloned = !!clone.dir` (`:1830`); `workspaceRefresh = clone.refreshed` (reuse path only, `:1834`).

| Condition | Sentence (verbatim) | Line |
|---|---|---|
| always, repo attached | "You are the <role> specialist on task <KEY>: "<title>". Goal: <goal>. Work from the repository checked out in your workspace — read the code you need (structure, dependencies, the change on your branch) to do the task well." | `:2618-2622` |
| always | "## Workspace contract (follow exactly)" / "- Work ONLY inside the current working directory — it is the dedicated workspace for this task. Never `cd` to a parent directory or touch any repository outside it." | `:2629-2633` |
| `cloned` | "- The repository `<owner/repo>` is already checked out in the current directory." + (reuse path) " Before this run Viberr <workspaceRefresh>." e.g. "Before this run Viberr fast-forwarded the unborn checkout to `origin/main` at `77eecbb`." | `:2642-2649` |
| `!cloned` + `cloneFailure` | "- **The workspace has NO checkout, and this is a server-side failure, not something you can fix.** <sentence>" / "- Do NOT try to clone, fetch, or authenticate to `<repo>` yourself, and do NOT ask anyone to provision credentials or place a checkout[ — the credential is present and working; repeating that request wastes a human's time on a false lead]. Report that the checkout could not be provisioned, quote the reason above verbatim, and stop. Do not speculate about the cause beyond what that sentence says." | `:2655-2663` |
| `!cloned`, no failure recorded | "- Clone `https://github.com/<repo>` INTO the current directory (`git clone https://github.com/<repo>.git .`) before making changes." (agents hold no credential, so on a private repo this can only fail) | `:2672` |
| `canBranch` | "- Do all work on the branch `<branch>` (create it from the default branch if it does not exist): `git checkout -B <branch>`." | `:2704` |
| `canCommitPush` | "- Commit your work locally on the branch with clear messages, each prefixed `[<KEY>]` so it traces back to this task. Write real, descriptive commit messages — this history is delivered as-is." / "- Do NOT run `git push` and do NOT open a PR — even if an operator directive tells you to. This workspace has no push credentials by design, and Viberr owns delivery: it pushes the branch + opens the review PR when the task enters Review. Just report the branch name and commit SHA(s) in your reply." | `:2718-2719` |
| `!canCommitPush` | "- Repo delivery is HUMAN-gated for your profile: do NOT run `git commit` / `git push` or open a PR — even if a directive tells you to. Make the changes in the workspace and report exactly what you changed (files + summary); the governed Review transition (or a human) delivers them to the branch/PR." | `:2725` |
| always (delivering) | "- Report the exact branch name, commit SHAs, and PR URL for whatever delivery steps you performed back in your reply." | `:2727` |

Observations on the copy (candidate findings, not yet confirmed as owner-visible defects):
- "it pushes the branch + opens the review PR when the task enters Review" (`:2719`): with the KNC custom stages the delivery happened from Design via the operator's `deliver_for_review`; the sentence names a stage transition that is not the trigger (`performDelivery` runs from the operator tool, an applied recommendation, or the Deliver button; the code never keys it on entering a stage named Review). Harmless to the agent, but a lie about the mechanism.
- No sentence names the WORKSPACE PATH; the agent is told "current working directory" and the run's `cwd` is the checkout (`runWorkdir = clone.dir`, `:1683`). `GIT_CEILING_DIRECTORIES` pins git discovery below `<taskDir>/workspace` (`workspaceRunEnv`, `:3241-3258`).
- No sentence names the toolchain. The Dockerfile installs ONLY `git ca-certificates` and `chromium fonts-liberation` (apt), copies `uv`/`uvx` from `ghcr.io/astral-sh/uv:0.12.3`, base `node:26-slim` (`Dockerfile:46-73`); no `make`, `go`, `gcc`, `python3`, `gh` (`docker exec which` confirms only node 26.8.1, uv, chromium). The KNC-1 run log carries "/bin/bash: line 1: make: command not found" (`task.md:136,318`). `RunInputs.sandbox` and `instance_health` say nothing about toolchains.

Git identity: the run env sets `GIT_AUTHOR_NAME/EMAIL` and `GIT_COMMITTER_NAME/EMAIL` to `<profileId>` / `<profileId>@viberr.local` (`agentGitIdentityEnv`, `:3278-3286`) and the checkout's `user.name`/`user.email` are set the same (`setIdentity`, `:3350-3360`; live: `developer` / `developer@viberr.local`).

### E. The `run·inputs` line (`RunInputs`, `app/features/runtime/runtime-types.ts:127-190`; written by `recordRunInputs`, `specialist-run.server.ts:640-700`, at `:2058-2075`)

- Raw NDJSON: `{"type":"run_inputs","source":"viberr","run_id":…,"backend":…,"inputs":{…}}`; display line `ev: "meta"`, `tag: "run·inputs"`, text `Run inputs — delivering engagement · canonical anchor N chars · persona N chars · prompt N chars · N skills · N knowledge bases · N MCP servers[ · workspace <workspaceRefresh>][ · N grants did NOT reach this run]` (`runInputsSummary`, `:585-604`).
- Fields to read for KNC-n: `cwd` = `/data/projects/<slug>/tasks/<KEY>/workspace/<repoName>` (container path); `repo` = `akin-ozer/k9s-clone`; `cloned: true` when a checkout exists (a REUSED unborn checkout counts as cloned); `workspaceRefresh` ABSENT on a fresh clone and on a run without a tree, else one of the `describeWorkspaceRefresh` sentences (`workspace-refresh.server.ts:203-237`); `delivers: true`; `anchor` = the canonical task-state block verbatim (null -> summary prints "NO canonical anchor").
- Expected values per dispatch on an empty repo whose operator triaged first: dispatch 1 -> `workspace fast-forwarded the unborn checkout to `origin/main` at `<sha7>``; dispatch 2+ (agent left HEAD on the task branch) -> `workspace origin/* refreshed; HEAD is on the task branch and was left as it is (update_branch_from_base owns a diverged task branch)`; a dispatch when the bootstrap failed -> `workspace origin/* refreshed; the remote has no `main` yet, so nothing to fast-forward to`; mirror fetch failed -> the suffix " (the mirror could not be refreshed from GitHub first, so origin/* may lag)".
- The run RESERVATION step label before the clone: "Cloning <repo> · first task in this project, this can take a few minutes" when the mirror has no `HEAD` file, else "Cloning <repo>" (`repo-mirror.server.ts:150-154`); progress form "Cloning <repo> · NN% · first task in this project" (`:166-169`). On an empty repo the cold clone finishes instantly, so the label is a flicker at most.

### F. Numbered timeline for KNC-1 (observed 2026-09-06, matched to code)

| # | UTC | Event | Code | On-disk / GitHub proof |
|---|---|---|---|---|
| 1 | 13:17:22 | Task created (assign event by Arda); operator auto-invoked | `task.md:366` | `tasks/KNC-1/task.md` exists |
| 2 | ~13:17:2x | Operator run 1 prepares: `ensureOperatorRepoCheckout` -> `cloneWorkspaceRepo` -> mirror CREATED from the EMPTY repo (`.repo-mirror` dir mtime 13:17Z), canonical checkout cloned UNBORN on `main` | `operator-run.server.ts:1694,1330`; `repo-mirror.server.ts:305,479` | `.repo-mirror/akin-ozer__k9s-clone.git/HEAD` = `ref: refs/heads/main`; workspace reflog has NO entry before 13:18:23 (unborn clones log nothing) |
| 3 | 13:17:41 | Operator moved Triage -> Design | `task.md:362-364` | transition event |
| 4 | 13:18:20 | Operator run 2 calls `run_agent` (delivers) -> `ensureTaskBranchBestEffort` -> `ensureDefaultBranch`: `GET git/ref/heads/main` missing -> `GET branches` 409 empty -> `PUT contents/README.md` message `Initialize <projectName>` -> `main` @ `77eecbb`; then `POST git/refs refs/heads/knc-1` at that sha; `task.md branch: knc-1` written | `operator-actions.server.ts:2587`; `repo-bootstrap.server.ts:190-230`; `branch-sync.server.ts:659,730-747` | timeline `github · system:delivery` "Bootstrapped the repository: `akin-ozer/k9s-clone` had no branches, so Viberr created **main** with an initial commit `77eecbb` (a README naming the project) before cutting this task's branch." (`task.md:358-360`); audits `github.repo.bootstrapped`, `github.branch.created {repo, from: main}`; GitHub `main` = 77eecbb "Initialize k9c — k9s clone", `knc-1` = 77eecbb; `task.md:68 branch: knc-1` |
| 5 | 13:18:21 | Developer (Codex) dispatched: `startSpecialistRun` -> branch already recorded so the specialist-door hook is skipped -> `reserveRun` -> `cloneRepo` REUSE path -> `refreshWorkspaceFromMirror`: mirror `fetch --prune`, workspace fetch, unborn HEAD on `main` -> `checkout -q -B main origin/main` | `specialist-run.server.ts:1356,1621,1650,3421-3470`; `workspace-refresh.server.ts:174` | reflog 13:18:23 `branch: Created from origin/main` + `checkout: moving from main to main`; run log `run·inputs` should read `workspace fast-forwarded the unborn checkout to `origin/main` at `77eecbb`` (verify in the Agent logs) ; prompt "Before this run Viberr fast-forwarded the unborn checkout to `origin/main` at `77eecbb`." |
| 6 | 13:18:38 | Agent `git checkout -B knc-1` | prompt `:2704` | reflog `checkout: moving from main to knc-1` |
| 7 | 13:18-13:20 | Agent runs `make fmt/test/lint/build` x4 -> "make: command not found" (no toolchain in the image) | Dockerfile | run log lines; `task.md:136` |
| 8 | 13:20:22 | Agent commits `f95e67e` "[KNC-1] docs(adr): record stack and architecture" as developer@viberr.local; reports to @operator; does NOT push | prompt `:2718-2719`; identity `:3278` | reflog `commit:`; `git -C <ws> status` clean; GitHub `knc-1` still 77eecbb |
| 9 | 13:20:37 | Run finished -> `reconcileWorkspaceDelivery` (delivering runs only): `rev-parse --abbrev-ref HEAD` = `knc-1` = `fm.branch` (no "Reconciled branch" event); `log --oneline origin/main..HEAD` = 1 commit -> `github.commits` cache; `nextWorkRevision` mints `workRevision {id: rev_…, headSha, treeSha, branch: knc-1, kind: delivered}`; `validation` re-derived | `task-actions.server.ts:4040-4056`; `workspace-delivery.server.ts:360-520` | `task.md workRevision`, `github.commits: [{sha: f95e67e, msg}]`, `validation: changed`; audit `github.workspace.branch_reconciled {repo, branch, branchLinked: false, commits: 1}` (fires because commits changed) |
| 10 | 13:21-13:22 | Operator run 4: `update_branch_from_base` -> `[noop]` "`knc-1` is already up to date with `main`. Origin's copy of `knc-1` (`77eecbb`) is 1 commit behind the workspace head: call `deliver_for_review` to push it. Do not ask a person to push." | `update-branch-operator.server.ts:242,106-110` | tool result text |
| 11 | 13:22 | `deliver_for_review` -> `performDelivery`: `ensureDefaultBranchBeforePush` (`exists`), `pushWorkspaceBranch`: HEAD `knc-1`, tree clean (no auto-commit), 1 ahead, `ls-remote --heads origin knc-1` = 77eecbb != HEAD -> `git push origin HEAD:refs/heads/knc-1`; post-push re-reconcile; `openTaskPr` -> PR #1 | `task-actions.server.ts:5340,5663`; `push-workspace.server.ts:605-680,760-830` | tool result "Delivered: pushed f95e67e and opened review PR #1." (`operator-actions.server.ts:2744`); GitHub PR #1 head f95e67e base main; `task.md pr {number: 1, state: review, headSha}`; audits `github.pr.opened`, `github.delivery.operator {moved: …}`; mirror gains `refs/heads/knc-1` on its next refresh |
| 12 | 13:24-13:25 | Architecture Reviewer (supporting): `cloneRepo({support})` -> `rm -rf` its dir, `git clone --local <canonical> <workspace>/support/architecture-reviewer/k9s-clone`, origin re-pointed, fetch-only refresh (`fastForward: false`) | `specialist-run.server.ts:3384-3418` | `workspace/support/architecture-reviewer/k9s-clone/` exists; prompt says SUPPORTING + "The review subject is PINNED to the delivered revision `f95e67e…`" (`:2695`) |
| 13 | 13:25:56 | Developer re-dispatched after `request_changes`: reuse path, refresh -> `task_branch` (left alone); agent `checkout -B knc-1` again | `workspace-refresh.server.ts:175` | reflog `branch: Reset to HEAD` + `checkout: moving from knc-1 to knc-1`; prompt "Before this run Viberr origin/* refreshed; HEAD is on the task branch and was left as it is (update_branch_from_base owns a diverged task branch)." |
| 14 | 13:27:32 | Commit `5651122` "[KNC-1] docs(adr): clarify layer and rendering contracts"; completion reconcile mints a NEW revision (different tree) -> prior verdict stale, acceptance offers withdrawn (ruling 137) | `workspace-delivery.server.ts:420-470` | `task.md workRevision.id: rev_glHT7w9ASzPD headSha 5651122…`, `github.commits` = 2 entries |
| 15 | later | Delivered again -> push `5651122` to the OPEN PR #1: tool result "Delivered: pushed 5651122… to the open review PR #1 (its head moved; the reviewers judge the new revision)." | `operator-actions.server.ts:2746` | mirror `refs/heads/knc-1` = 5651122; `task.md pr.headSha` = 5651122; `git log --all --decorate` shows `origin/knc-1` at 5651122 |

### G. On-disk proof commands (host side, read-only; container path `/data` = host `docker-data`)

```
P=docker-data/projects/k9c-k9s-clone; W=$P/tasks/KNC-1/workspace/k9s-clone
cat $P/.repo-mirror/akin-ozer__k9s-clone.git/HEAD            # ref: refs/heads/main (also on an EMPTY repo)
git -C $P/.repo-mirror/akin-ozer__k9s-clone.git for-each-ref  # what the last mirror refresh saw on GitHub
cat $W/.git/HEAD; git -C $W reflog show --date=iso HEAD       # the whole clone/ff/checkout/commit story
git -C $W status --porcelain --branch; git -C $W log --oneline --all --decorate
git -C $W config --get-all remote.origin.url                  # must be https://github.com/<repo>.git, never a PAT URL or the mirror path
ls $P/tasks/KNC-1/workspace/support/                          # one dir per supporting profileId
awk '/^---$/{c++} c<2' $P/tasks/KNC-1/task.md | grep -n '^branch:\|^workRevision:\|^pr:\|^github:\|^validation:'
```
Do NOT read `projection.sqlite`/audit tables from the host while the container runs (WAL stale reads; memory trap); read audit rows through the UI or `viberr_ops`.

### H. What a `make: command not found` run still reconciles

- The reconcile keys ONLY on git state (`workspace-delivery.server.ts:344-360`): HEAD's branch name, `origin/<default>..HEAD`, `HEAD`/`HEAD^{tree}`. A failed build changes nothing there. If the agent committed anyway (KNC-1 did: an ADR), the revision is minted and delivery proceeds; the failure lives only in the run log and whatever the agent wrote in its reply.
- If the agent committed NOTHING on `knc-1`: `commits === []` -> `hasDeliveredWork` false -> no revision, no audit; the task stays `validation: pending`. A later `deliver_for_review` reports `no_commits` with `defaultBranchEvidence` (verified only when the tree is clean, `push-workspace.server.ts:726-756`).
- If the agent left the tree DIRTY and uncommitted: reconcile mints nothing (no commits), but delivery's auto-commit ships the whole tree as `[<KEY>] deliver working-tree changes from the agent run` (`push-workspace.server.ts:690-705`), including build junk not ignored by `.gitignore`.
- If the agent never ran `checkout -B` (HEAD on `main`, born): reconcile `validBranch` null -> nothing; delivery `no_branch` "HEAD is on the default branch (main) with a clean working tree, no local commits and no task branch" or "… and <why>" (`:636-648`).
- If HEAD is UNBORN at completion (bootstrap failed AND agent committed nothing): `rev-parse --abbrev-ref HEAD` exits 128 -> reconcile `rawBranch = ""` -> nothing written; delivery `no_branch` "the workspace's HEAD could not be read" (`:626-628`). Nothing on any surface says "unborn" or "the repository was empty".

### I. Drift and candidate findings from this section

1. Ruling 129's operator-refresh clause has no implementation (`operator-run.server.ts:1310` returns an existing checkout untouched; no `refreshWorkspaceFromMirror` call outside `specialist-run.server.ts`). Docs claim, code disagrees.
2. Prompt line `:2719` "when the task enters Review" misnames the delivery trigger (operator tool / recommendation / Deliver button, any stage that allows it).
3. Unborn HEAD on a non-default branch is reported as "HEAD is on the task branch" (`workspace-refresh.server.ts:175,212`). Latent; not hit live.
4. An unborn workspace at delivery reports "the workspace's HEAD could not be read" (`push-workspace.server.ts:626-628`), which reads as a git fault rather than "nothing was ever committed".
5. The image ships no build toolchain and nothing (prompt, `run·inputs`, `instance_health`, project settings) discloses it; the controller chose Go and the Developer discovered it by `make: command not found`. Product-level gap to raise with the owner, not a code lie.
6. `git clone --bare` of an empty repo prints "warning: You appear to have cloned an empty repository." to stderr; the mirror code logs only "created the project's repository mirror cache" (`repo-mirror.server.ts:330-335`), so the operator's first triage on an empty repo leaves no product-visible trace that its checkout is unborn (the operator prompt's workspace view is out of scope here; check what it says about an empty checkout).

---

## Gap fill: Human GitHub approval as verdict is unreachable without GitHub OAuth (github_handle setter)

Supplements §12 gate 6 and §13 row "Human approves on GitHub". Every claim below is code-verified on branch `pass35/k9s-clone-observation`; line numbers are from that tree.

### Bottom line

- `users.github_handle` is written by EXACTLY TWO call sites, both inside the GitHub OAuth sign-in path: `app/server/auth/oauth-provision.server.ts:141` (`applyOAuthUser`, better-auth `user.create.after` for a NEW GitHub-created user) and `:190` (`recordSignIn`, better-auth `session.create.after`, mirrors better-auth's own `user.githubHandle` column onto `users.github_handle` on every sign-in). Both fire only when better-auth has a GitHub social provider, i.e. `resolveOAuthProvider(db, "github").credentials !== null` (`app/server/auth/oauth-providers.server.ts:301-330`, wired in `app/lib/auth.server.ts:157-169`).
- No admin, seed, script, e2e fixture, profile intent, or org Users action sets the column (table below). `UserFieldPatch.githubHandle` exists (`user-store.server.ts:138,150`) but no caller outside `oauth-provision.server.ts` passes it (grep of `updateUserFields` callers, 13 sites).
- This deployment has no GitHub OAuth: `.env` carries no `GITHUB_OAUTH_CLIENT_ID` line (`.env.example:75-76` has both names commented out), `docker-data/.env` does not exist, and `docker-compose.yml` names no `GITHUB_OAUTH_*`. The only other source is an `oauth_providers` row (`db/migrations/0001_baseline.sql:383`); read it with the SQL below before assuming (expected: zero rows).
- Therefore `pr.humanApproval.status: "counted"` and the sentence `humanVerdictNote` are UNPROVABLE on this stack unless the human owner first configures a GitHub OAuth App (subsection "The only door"). Any GitHub approval the observer records WILL land as `unlinked_handle`. Reporting `unlinked_handle` as a bug is a false finding; the real observation targets are the two dead-end sentences flagged under "Candidate findings".

### Every path that touches `users.github_handle` (verified)

| Path | File:line | Writes `github_handle`? |
|---|---|---|
| GitHub OAuth, new user created by better-auth | `oauth-provision.server.ts:135-141` `insertUser(...)` then `if (handle) updateUserFields(db, user.id, { githubHandle: handle })` | YES (normalized: trim, strip leading `@`, lowercase, `:57-59`) |
| Any sign-in (`session.create.after`) | `oauth-provision.server.ts:176-197` reads `SELECT "githubHandle" FROM "user"`; writes when non-null and different; audit `auth.github_handle.recorded {handle}` | YES, but the source column `user.githubHandle` is filled only by the GitHub provider's `mapProfileToUser: (profile) => ({ githubHandle: profile.login })` (`auth.server.ts:166-168`) at user creation, and by `account.accountLinking.updateUserInfoOnLink: true` (`auth.server.ts:333`) when a GitHub account is linked to an existing local user |
| `linkOAuth` (`account.create.after`) | `oauth-provision.server.ts:210-229` | NO, only `idp` + audit `auth.oauth.login` |
| Org Users "Allow access" with method GitHub (`invite-github`) | `org-users.server.ts:137-170` `whitelistGithubUser` -> `insertUser` with `email: "github.com/<handle>"`, `name: "@<handle>"`, `idp: "github"`; audit `org.user.whitelisted`; toast "@<handle> whitelisted — allowed at first GitHub sign-in" | NO: `insertUser` (`user-store.server.ts:88-118`) has no `github_handle` column in its INSERT. The placeholder row's `github_handle` is NULL, so it can never match `resolveGithubHandle` |
| Admin edit user (`user-edit`, `user-role`, `user-disable`, `user-enable`) | `user-admin.server.ts:120-198` `updateUser` builds `fields` from `name, title, role, disabled` only | NO |
| Profile `identity` intent | `profile.tsx:105-110` -> `profile-actions.server.ts:75` `{ name, title }` | NO |
| Profile `github-disconnect` intent | `profile-actions.server.ts:175-200` `disconnectGithubIdentity`: refuses unless `idp === "github"` ("GitHub isn't connected on this account."), refuses without a password ("Set a password first: this account signs in only through GitHub."), then `updateUserFields(db, actor.userId, { idp: "local" })`, audit `identity.github.disconnected`, toast "GitHub disconnected. Audit falls back to your workspace identity" | NO: the handle SURVIVES a disconnect |
| Forced password reset, theme, Google idp flip | `login.server.ts:167`, `prefs.theme.tsx:31`, `org-users.server.ts:186` | NO |
| Seeds, e2e, scripts | grep `github_handle|githubHandle` over `e2e test-support scripts db docker`: only `0001_baseline.sql:36` (column) and `:611` (better-auth `"user"."githubHandle"`) | NO |

### How the approval is read (so the observer knows what to expect)

- Fetch: `pr-linker.server.ts:485-501`: `GET /repos/<repo>/pulls/<n>/reviews?per_page=100` ONLY while `state === "review"` (open PR); merged/closed PRs never refresh approvals. `deriveApprovals` (`:330-346`) keeps each login's LATEST review event and returns those whose latest state is `APPROVED` as `{login, commitSha: review.commit_id ?? null, at}`.
- Classify: `pr-human-approval.server.ts:127-177` `derivePrHumanApproval({approvals, deliveredSha: fm.workRevision?.headSha ?? null, memberUserIds, db})`. `resolveGithubHandle` (`:93-113`) runs `SELECT id, name FROM users WHERE lower(github_handle) = ? AND disabled = 0 ORDER BY id ASC` (idp is NOT consulted). Member set = `members[].userId` from the project file frontmatter, not the DB (`github-reconciler.server.ts:312-320`). Rank kept when several approvals exist: `counted` 0, `stale_revision` 1, `not_a_member` 2, `ambiguous_handle` 3, `unlinked_handle` 4; ONE record survives (`:169-176`).
- Store: reconciler (`github-reconciler.server.ts:559-569, :599`) writes `pr.humanApproval = {login, commitSha, at, userId, name, status}` on the task.md `pr:` block; when the reviews call did not run (`pr.approvals === undefined`) the cached record is carried forward for the same PR.
- Gate: `verdictGateReason` (`:306-360`): `humanVerdictApproval` (`:210-220`) passes only `status === "counted"` AND `userId` AND `commitSha === workRevision.headSha` (re-checked on every read, so a re-push revokes it offline). Otherwise the refusal is `"<KEY>'s delivered revision has no approving verdict yet. " + humanApprovalRefusalNote(fm)`.
- Where the sentences render: task page side panel `.deny-note` as "**Not acceptable yet.** <reason>" (`task-side-panels.tsx:1094-1111`; "**Acceptance is closed.**" when terminal); review queue row subline via projection `blockReason` (`rebuilder.server.ts:366`, `review-helpers.ts:119`), except a `closed` PR row which prints `prStateSub` instead; board move-to-Done dialog via `task.blockReason` (`board-page.tsx:1041-1060`). The POSITIVE sentence (`verdictSatisfiedBy`) renders as a `.hint` with a check icon on the task side panel (`:1088-1092`) and as " · <sentence>" after the Verdict pill in the accept dialog (`accept-confirm.tsx:407-409`); the board dialog hard-codes `verdictSatisfiedBy={null}` (`board-page.tsx:1151`).

### Exact sentences (`pr-human-approval.server.ts`)

| Status | Sentence appended after "<KEY>'s delivered revision has no approving verdict yet. " |
|---|---|
| `unlinked_handle` (`:270-274`) | "@<login> approved the pull request on GitHub, but no Viberr account carries that GitHub handle. Link it on their profile and it will count as the verdict." |
| `ambiguous_handle` (`:275-279`) | "@<login> approved the pull request on GitHub, but more than one Viberr account claims that handle. Resolve the duplicate before the approval can count." |
| `not_a_member` (`:280-284`) | "<name> (@<login>) approved the pull request on GitHub, but they are not a member of this project. Only a project member's approval can be the verdict." |
| `stale_revision` (`:264-269`) | "<name> (@<login>) approved commit `<sha7>` on GitHub, not the delivered revision. The approval cannot stand in for a verdict until they approve the current head." |
| was `counted`, revision moved (`:253-261`) | "<name> (@<login>) approved commit `<sha7>` on GitHub, which is no longer the delivered revision. Re-approve the current head." |
| no approval at all (`:359`) | "Run a review for a verdict, approve the pull request on GitHub, or an admin can force-accept." (this generic variant is the ONLY one that mentions force-accept) |
| counted, positive (`humanVerdictNote` `:232-237`) | "Approved on GitHub by <name> (@<login>) on the delivered revision `<sha7>`. A project member's PR approval is the verdict." |

`approverLabel` (`:223-225`) prints "<name> (@<login>)" when `name` is known, else "@<login>"; `unlinked_handle`/`ambiguous_handle` never have a name.

### Expected observation on THIS stack (no OAuth)

1. Owner approves the PR on GitHub as `akin-ozer` (the PAT identity) on the delivered head.
2. Wait for the 5-minute reconcile or trigger a task reconcile (§10). `task.md` `pr:` gains `humanApproval: {login: "akin-ozer", commitSha: "<head>", at: "<iso>", userId: null, name: null, status: "unlinked_handle"}`.
3. Task page (acceptance authority, at the review boundary or not): "**Not acceptable yet.** K9S-1's delivered revision has no approving verdict yet. @akin-ozer approved the pull request on GitHub, but no Viberr account carries that GitHub handle. Link it on their profile and it will count as the verdict." Same text in the review queue subline and in the board's move-to-Done dialog. `validation` stays `changed` (no engaged reviewer verdict). Accept button disabled; Force accept (admin) is the only way through.
4. Nothing on Profile can honour "Link it on their profile": with no provider the GitHub identity card (`profile-page.tsx:607-616`) prints "GitHub sign-in isn't configured on this deployment, so there's no personal GitHub identity to connect. Your actions record under your workspace identity above." and shows NO Connect button (`showConnectAffordance = gh || data.githubConfigured`, `:543`; `githubConfigured` = `resolveOAuthProvider(db, "github").credentials !== null`, `profile-query.server.ts:306`).
5. Org Users "Allow access" > GitHub `@akin-ozer` creates a placeholder row (name "@akin-ozer", email `github.com/akin-ozer`, `github_handle` NULL) that changes nothing for the gate.

### The only door: configuring GitHub OAuth (human-only steps)

Preconditions the observer cannot perform (account creation and secret entry are prohibited for the subagent; the human owner does them):
1. Owner creates a GitHub OAuth App whose "Authorization callback URL" is `<origin>/api/auth/callback/github` (`app/shared/auth/auth-paths.ts:15-24`; the SSO panel shows this URL with a copy button `aria-label="Copy the callback URL <url>"`, `sso-panel.tsx:162-186`). Scopes requested at sign-in: `read:user`, `user:email` (`auth.server.ts:162`).
2. Instance settings `?tab=sso` ("Sign-in & SSO", `data-screen-label="Settings · Sign-in & SSO"`, `sso-panel.tsx:204-207`; reachable only from the org-settings rail, not Home's Settings tiles): paste client ID (hint "Client ID (starts Iv1. or Ov23…)") and secret; intent `oauth-save` -> toast "GitHub credentials saved. Test them to switch sign-in on." (`org.settings.tsx:500-516`; audit `org.oauth_provider.created|updated`, secret sealed, `oauth-providers.server.ts:113-176`).
3. Intent `oauth-test` -> `POST https://api.github.com/applications/<clientId>/token` with Basic auth and a probe token (`oauth-credential-test.server.ts:55-80`); 401 -> "GitHub rejected the client ID / secret pair (401 Bad credentials) — check both values on the OAuth app."; pass -> toast "GitHub accepted the credentials." and audit `org.oauth_provider.tested {passed}`; the panel adds "<detail> The callback URL above still has to be registered on the provider. That is only exercised by a real sign-in." (`sso-panel.tsx:256-260`).
4. Intent `oauth-toggle enabled=1` -> "GitHub sign-in is on." (refused without a passing test: "Test the credentials first — a sign-in method is only offered once the provider has accepted its client ID and secret.", `oauth-providers.server.ts:225-238`; audit `org.oauth_provider.enabled`). No restart: `getAuth` is keyed on `oauthConfigFingerprint(db)` (`auth.server.ts:417-430`).
5. Owner (an EXISTING local user, e.g. the admin) opens Profile > GitHub identity > "Connect" (`POST /api/auth/sign-in/social {provider: "github", callbackURL: "/profile"}`, `profile-page.tsx:552-580`). better-auth links by VERIFIED provider email only (`trustedProviders: ["credential"]`, `auth.server.ts:307-322`): the GitHub primary email must be verified AND equal the Viberr account email, else better-auth creates a NEW user, which the whitelist rejects unless a `github.com/<handle>` placeholder or a matching enabled row exists (`isOAuthWhitelisted`, `oauth-provision.server.ts:63-82`). On link, `updateUserInfoOnLink` copies `githubHandle` to better-auth `"user"."githubHandle"`; the session hook then writes `users.github_handle` and audits `auth.github_handle.recorded` (`:176-197`), and `linkOAuth` flips `idp` to `github` (`:210-229`). Card then reads "@<handle> · GitHub sign-in" and "Connected. Your approvals, acceptances, and runtime-session opens are attributed to @<handle> in audit records."
6. Only then can a re-approval on the CURRENT head produce `status: "counted"`, the `.hint` sentence, and a plain Accept without force.

### SQL (read-only, non-secret)

Data root layout: `<dataRoot>/state/projection.sqlite` (`docs/architecture/data-model.md:23,48`); `humanApproval` itself is in `<dataRoot>/projects/<slug>/tasks/<KEY>/task.md` under `pr:`. Read the container's DB from inside the container (WAL stale-read hazard when read from the host), with `-readonly`.

```sql
-- who could ever match an approval (idp is irrelevant to the match)
SELECT id, email, name, idp, disabled, github_handle FROM users ORDER BY created_at;
-- better-auth's mirror column (the source the session hook copies from)
SELECT id, email, "githubHandle" FROM "user";
-- is a GitHub provider configured in-app? (never select client_secret; it is a sealed box)
SELECT provider, client_id, enabled, verified_at, verified_detail FROM oauth_providers;
-- did any sign-in ever record a handle?
SELECT occurred_at, action, subject_id, details_json FROM audit_events
 WHERE action IN ('auth.github_handle.recorded','auth.oauth.user_provisioned','auth.oauth.placeholder_claimed','org.oauth_provider.created','org.oauth_provider.enabled')
 ORDER BY occurred_at DESC;
```

(Table and columns verified in `db/migrations/0001_baseline.sql`: `audit_events (id, occurred_at, actor_user_id, actor_label, action, subject_kind, subject_id, project_slug, task_key, details_json)`.)

### Candidate findings (observation targets, not yet confirmed live)

- CF-GH-1 Dead-end pointer: the `unlinked_handle` refusal says "Link it on their profile and it will count as the verdict." while the profile card on an unconfigured deployment says there is "no personal GitHub identity to connect" and offers no button. The sentence also omits the force-accept way out that the generic variant names. A person following the app's advice arrives at a door the app says does not exist. Files: `pr-human-approval.server.ts:270-274` vs `profile-page.tsx:607-616`.
- CF-GH-2 Disconnect does not unlink: `disconnectGithubIdentity` flips only `idp`; `resolveGithubHandle` matches on `github_handle` alone. After Disconnect the card reads "not connected" and "your GitHub review approvals can't be matched back to you" (`profile-page.tsx:662-665`), yet the approval still counts. Unprovable on this stack (needs a linked handle first); record as a code-derived finding.
- CF-GH-3 Whitelist placeholder carries no handle: "Allow access > GitHub @handle" is the one admin surface that names a GitHub login, and it does not populate `github_handle` (`insertUser` has no such column); the placeholder only matters at first OAuth sign-in. On an OAuth-less deployment the affordance is inert for the verdict path, and its toast promises a sign-in method that is "off".
- CF-GH-4 Board dialog never shows the positive attribution: `board-page.tsx:1151` passes `verdictSatisfiedBy={null}` while its own comment says the board must disclose no less than the task page; only observable once `counted` exists.
- CF-GH-5 Docs gap: `docs/domain/github-delivery.md:271-275`, `docs/domain/task-lifecycle.md:298-301`, `docs/architecture/decisions.md:856-876` (ruling 68) and `docs/architecture/data-model.md:99` all describe matching "through `users.github_handle`" and none states that the column is populated only by GitHub OAuth sign-in (or that a deployment without a provider can never satisfy the gate except by force-accept). `docs/domain/auth-and-rbac.md:274` documents only the disconnect. Code wins; the docs under-describe the precondition.

---

## Gap fill: PR adoption and unowned-PR provocation recipes

Read 2026-09-06 against this tree. Source doc `docs/domain/github-delivery.md` §4 (lines 217-235) and rulings 34/35 in `docs/architecture/decisions.md:367-395`. Every claim below names its line. Task key assumed `KNC-1`, branch `knc-1` (`taskBranchName = key.toLowerCase()`, `branch-sync.server.ts:50-51`), repo `akin-ozer/k9s-clone`, default branch `main`.

### 21.0 Preconditions that every recipe shares (verified)

| Fact | Where verified | Why it matters |
|---|---|---|
| The remote branch `knc-1` is CREATED on GitHub at DISPATCH, pointing at `main`'s head (`POST /repos/<repo>/git/refs`), and `branch:` is written to `task.md` then | `branch-sync.server.ts:659-664, :730-735`; callers `specialist-run.server.ts:1363`, `operator-actions.server.ts:2587` | A hand push onto `knc-1` fast-forwards from `main`; `gh pr create --head knc-1` BEFORE any commit fails on GitHub ("No commits between"). The poller only visits tasks with `branch IS NOT NULL` (`github-reconciler.server.ts:1130-1139`), so a dispatched task is polled even before delivery |
| `workRevision.headSha` is minted at the END of the delivering run (`input.delivers && finished.state === "finished"`), from the workspace HEAD, never from GitHub | `task-actions.server.ts:4042-4056`; `workspace-delivery.server.ts:443-481` | Adoption compares the PR head against this sha. A task whose run has not finished (or that committed nothing) has no revision: every foreign PR refuses as `no_revision` |
| Workspace path: `<dataRoot>/projects/<slug>/tasks/<KEY>/workspace/<repoName>` (fallbacks `workspace/repo`, `workspace`) | `workspace-delivery.server.ts:348-357` | The host reads the delivered commit from here WITHOUT touching the DB: `git -C ~/k9s-clone fetch <workspace-path> knc-1` |
| Adoption rule: OPEN and `pr.head.sha === workRevision.headSha`; refusals `merged, closed, no_revision, head_unknown, head_mismatch` | `pr-adoption.server.ts:52-74` | Identity, not containment: one extra hand commit on top of the revision is `head_mismatch` |
| `findPrForBranch` picks the NEWEST PR on the head (`state=all, sort=created, direction=desc, per_page=5`, `list.data[0]`) | `pr-linker.server.ts:379-402` | With an own closed PR #N and a hand PR #M on the same branch, the reconciler sees #M |
| `openTaskPr` step 0 re-reads a cached non-terminal PR live; closed/merged live -> falls through WITHOUT writing the terminal state to the cache; then lists OPEN PRs on the head (`per_page: 1`) | `pr-open.server.ts:374-406, :433-437` | The delivery-door adoption text is built from the STALE cache (`previousState: fm.pr?.state`), see CF-ADOPT-2 |
| Push precedes PR open; `up_to_date` when `git ls-remote --heads origin <branch>` equals HEAD; non-fast-forward = `push_conflict` | `push-workspace.server.ts:775-787, :871`; §6 | A hand PR whose head differs from the revision blocks at the PUSH, never at `branch_collision` (CF-ADOPT-4) |

The three doors (all call `decidePrAdoption`):

| Door | File | Trigger | Records adoption as | Records refusal as |
|---|---|---|---|---|
| Delivery (`prAlreadyOnHead`) | `pr-open.server.ts:433-479` | Deliver button / `deliver_for_review` / applied `delivery` card / packet re-delivery | `recordPrAdoption(source: "delivery")` only when `fm.pr?.number !== pr.number` (:462-476); no "Opened" event, no `github.pr.opened` | returns `branch_collision {prNumber, branch, message}` -> `performDelivery` writes "Delivery blocked by a branch collision" + `failed` (`task-actions.server.ts:5811-5821`) |
| Reconciler (`reconcileTaskUnlocked`) | `github-reconciler.server.ts:452-458, :713-731, :875-897` | 5-min poller, "Update status" on `/projects/<slug>/github` (intent `reconcile`, action `reconcile-github` = admin/maintainer, `project.github.tsx:131-134`, `rbac.ts:77`), or the delete-branch confirm pass (:1631-1635) | `recordPrAdoption(source: "reconciler")` + `policy` notification unless `prJustReopened` | `github.unownedPr = N` + ONE `note` when the number is new (:660-676, :819-828); no notification, no operator wake (wake list :939-945) |
| Workspace (`reconcileWorkspaceDelivery` step 4) | `workspace-delivery.server.ts:565-690` | end of a delivering run; `performDelivery` step 2 | `github` event "Linked **PR #N** opened from the specialist workspace." + audit `github.workspace.pr_linked` (:702-743) | same `note` + `github.unownedPr` when `baseCache?.unownedPr !== number` (:611-641) |

Actors as rendered: `systemIdToName` turns `policy-engine` into "Policy engine" and `delivery` into "Delivery" (`actor-ref.server.ts:49-52`); the adoption event actor is `{kind: system, systemId: "policy-engine"}` for the reconciler and `{kind: system, systemId: "delivery"}` for delivery (`pr-adoption-record.server.ts:36-39`). Audit actor: poller = `SYSTEM_ACTOR {userId: null, label: "system"}` (`reconcile-poller.server.ts:224`, `audit-recorder.server.ts:23`); "Update status" = the clicking human; delivery = the human or operator actor passed to `openTaskPr`.

Adoption event text (both sources, `pr-adoption-record.server.ts:41-48`): "Adopted **PR #N** (head `abc1234`, the delivered revision) as KNC-1's review PR[, replacing PR #M (state)]. Viberr did not open it; it was found on branch `knc-1` with this task's delivered head." Audit `github.pr.adopted {repo, branch, prNumber, previousPrNumber, previousState, headSha, source}`, `subjectKind: "pull_request"`, `subjectId: "<repo>#N"` (:66-82).

Collision note text (all doors, `pr-adoption.server.ts:116-135`): "**Branch name collision:** GitHub already has PR #N on branch `knc-1`, but it is NOT KNC-1's review PR: <cause>. Viberr will not track it as one. Either that pull request was opened on `knc-1` after Viberr allocated the name to KNC-1, or KNC-1's branch was recorded before ruling 122 under a task key an older data root had already used (keys restart at 1; names allocated since take a suffix when the canonical one is spoken for), and Viberr cannot tell which from here. Resolve it with a `resolve_remote_collision` decision (closes the unrelated PR, deletes the stale remote branch `knc-1`, and re-delivers this task's work) before delivering." Causes (:82-95): `head_mismatch` -> "its head is not KNC-1's delivered revision (abc1234)"; `no_revision` -> "KNC-1 has delivered no revision, so no pull request can stand for its work yet"; `head_unknown` -> "its head commit could not be read, so it cannot be matched to KNC-1's delivered revision"; `merged` / `closed` -> §8.

### 21.1 Recipe A: delivery-door adoption

**A1, pure form (no PR ever opened by Viberr).** Preconditions: delivering run finished with commits (task.md has `workRevision.headSha = R`, `branch: knc-1`, `pr: null`), nobody has pressed Deliver.

Host commands (owner's `gh` is logged in as `akin-ozer`, scopes include `repo`; verified `gh auth status` on this Mac):
```
WS=<dataRoot>/projects/<slug>/tasks/KNC-1/workspace/k9s-clone
git -C ~/k9s-clone fetch "$WS" knc-1                      # read-only on the workspace
git -C ~/k9s-clone push origin FETCH_HEAD:refs/heads/knc-1   # fast-forward from main's head
gh pr create --repo akin-ozer/k9s-clone --head knc-1 --base main --title "hand PR on knc-1" --body "opened by hand"
```
Confirm `gh pr view knc-1 --repo akin-ozer/k9s-clone --json number,headRefOid` shows `headRefOid == R`. Do this BEFORE the next poller tick or the reconciler door adopts first (recipe B decides which door you are testing; the race window is up to 5 min, `RECONCILE_POLL_MS`).

Trigger: task page "Deliver branch & open PR" (or the operator's `deliver_for_review`).

Expected:
| Record | Value |
|---|---|
| push | `up_to_date` (remote head == HEAD, `push-workspace.server.ts:775-787`); if the workspace was dirty the auto-commit makes it `pushed` and the PR head moves to the new sha, which is ALSO the re-minted revision (step 2 of §6), so adoption still holds |
| `task.md pr` | `{number: N, state: "review", title: "hand PR on knc-1", headSha: R}` via `writePrToTask(..., created=false)` (`pr-open.server.ts:462`) |
| `task.md github.unownedPr` | untouched (null) |
| timeline | ONE `github` event by "Delivery": "Adopted **PR #N** (head `R7`, the delivered revision) as KNC-1's review PR. Viberr did not open it; it was found on branch `knc-1` with this task's delivered head." NO "Opened **PR #N** for review." |
| audit | `github.pr.adopted` with `details.source = "delivery"`, `previousPrNumber: null`, `previousState: null`; NO `github.pr.opened` |
| notification | NONE (only the reconciler source notifies, `github-reconciler.server.ts:877-897`) |
| toast | "PR #N already carries `R7` · nothing to push" (`delivery-toast.ts:18`); operator tool message "Nothing to push: PR #N already carries `R7`." (`operator-actions.server.ts:2751`) |
| follow-ups | `moved = created || pushed = false` (`task-actions.server.ts:5756`): no `autoInvokeOperator("delivered")`, and under supervised + operator delivery `recordDeliveredNextStep` still runs (:5786-5792, not gated on `moved`) |

**A2, replacing Viberr's own closed PR at the delivery door.** Preconditions: Viberr opened PR #N (`pr.state: review` cached).
```
gh pr close N --repo akin-ozer/k9s-clone
gh pr create --repo akin-ozer/k9s-clone --head knc-1 --base main --title "replacement" --body "hand-opened after closing #N"
```
Trigger Deliver within the poll window. Step 0 reads #N live -> closed -> falls through (`pr-open.server.ts:390-399`, cache NOT updated); `prAlreadyOnHead` lists open PRs on the head -> #M -> `fm.pr.number (N) !== M` -> `decidePrAdoption(review, head R, revision R)` -> adopt.
Expected: same as A1 except the event reads "... as KNC-1's review PR, replacing PR #N (review). ..." and the audit carries `previousPrNumber: N, previousState: "review"` even though #N is closed on GitHub (CF-ADOPT-2). Watch also: `openTaskPr` returns `created: false`, so no "Opened" event; the divergence note for #N's closure is never written by this door (only the reconciler writes divergence notes).

### 21.2 Recipe B: reconciler-door adoption (PR opened by hand AFTER delivery replaced a closed one)

Preconditions: Viberr opened PR #N on `knc-1` (cached `pr.state: review`), task not terminal (stage not archived and PR not merged, `github-reconciler.server.ts:1130-1136`).

Host: `gh pr close N --repo akin-ozer/k9s-clone`, then `gh pr create --repo akin-ozer/k9s-clone --head knc-1 --base main --title "replacement" --body "..."`. Do NOT press Deliver (that is recipe A2). Trigger: wait for the poller (up to 5 min) or press "Update status" on `/projects/<slug>/github`.

Two shapes, decided by whether a tick landed BETWEEN the close and the hand-open:

**B1, one tick sees both (cache still `review`, live newest PR = #M open):** `sameAsCached` false, adoption adopt, `prReplacedLive = true` (:731-735), `prJustReopened = false` (cache was not `closed`), `prJustClosed = false` (newPr is #M in `review`).
| Record | Value |
|---|---|
| `task.md pr` | `{number: M, state: "review", title, headSha: R, checks?, review?, mergeable?}` (owned facts, :573-608) |
| timeline | ONE `github` event by "Policy engine": "Adopted **PR #M** (head `R7`, the delivered revision) as KNC-1's review PR, replacing PR #N (review). Viberr did not open it; ..." NO divergence note about #N |
| audit | `github.pr.adopted {source: "reconciler", previousPrNumber: N, previousState: "review"}`, actor label `system` (poller) or the human (Update status); plus `github.reconcile.task {changed: true}` |
| notification | `policy` from "Policy engine" to owner + admins + maintainers (`task-mutation.server.ts` `notifyTaskWatchers`), title "PR #M adopted for KNC-1: replaces PR #N", text = the adoption sentence (:885-893) |
| operator | woken with `pr-diverged` (`prReplacedLive`, :939-957) |

**B2, a tick saw the close first:** tick 1 writes `pr.state: closed`, note "**Divergence:** PR #N was closed on GitHub without merging, but KNC-1 is still active. Decide whether to rework and reopen, or archive the task." + notification "PR #N closed on GitHub: KNC-1 needs a decision" + operator wake (it may author a rework/archive packet). Tick 2 (after the hand-open): adopt, `prJustReopened = true` (:713).
| Record | Value |
|---|---|
| timeline | `github` "Adopted **PR #M** ... replacing PR #N (closed). ..." AND `note` "**Note:** PR #M now tracks KNC-1's branch on GitHub, replacing closed PR #N, so the closed-PR block is lifted." (:736-740, :860-869) |
| audit | `github.pr.adopted {source: "reconciler", previousState: "closed"}` |
| notification | ONLY "PR #M live again on GitHub: KNC-1 resumes" with the reopen text (:906-927); the "adopted" notification is suppressed by `!prJustReopened` (:877) |
| operator | woken with `pr-diverged` (`prJustReopened`) to withdraw the now-moot recovery packet |

Discriminating proof between A and B: `audit_events.details_json` `source` (`delivery` vs `reconciler`), the timeline actor ("Delivery" vs "Policy engine"), and the inbox (A: nothing; B1: "adopted"; B2: "live again").

### 21.3 Recipe C: an `unownedPr` (hand PR on a head that is NOT the delivered revision)

Preconditions: delivering run finished (`workRevision.headSha = R`, `branch: knc-1`, `pr: null`, nothing delivered yet). Remote `knc-1` exists at `main`'s head from dispatch.

Host (any commit that is not R; the simplest is R plus one):
```
git -C ~/k9s-clone fetch "$WS" knc-1 && git -C ~/k9s-clone checkout -B knc-1 FETCH_HEAD
git -C ~/k9s-clone commit --allow-empty -m "hand commit on top of the delivered revision"
git -C ~/k9s-clone push origin knc-1:refs/heads/knc-1
gh pr create --repo akin-ozer/k9s-clone --head knc-1 --base main --title "stranger on knc-1" --body "..."
```
(An unrelated commit straight on top of `main`'s head works too; then the push_conflict below is a real history conflict rather than "remote ahead".)

Trigger 1, the poller or "Update status": `fm.pr` null -> `decidePrAdoption(review, head X, revision R)` -> `head_mismatch`.
| Record | Value |
|---|---|
| `task.md pr` | stays null |
| `task.md github` | `{commits: [], changed: null, unownedPr: N}`; while the collision stands `provenBranchHead` is false so no stranger stats are recorded (:631-657) |
| timeline | ONE `note` by "Policy engine", the collision note with cause "its head is not KNC-1's delivered revision (R7)"; never repeated while `unownedPr` stays N (`unownedPrIsNew`, :663-664) |
| audit | `github.reconcile.task {changed: true}` only; no adoption row |
| notification | NONE; operator NOT woken (CF-ADOPT-1) |
| task page | GitHub side panel row "Collision" / "PR #N holds this branch name but is not this task's review PR" (`task-side-panels.tsx:332-340`); operator snapshot field `unownedPr: N` (`operator-actions.server.ts:1990`) |

Trigger 2, Deliver: push is non-fast-forward -> `push_conflict` BEFORE `openTaskPr` -> `github` event + `policy` notification "Delivery push conflicted" / "KNC-1's delivery was not pushed: <git reason>. This is a branch-history conflict, not a credential problem. No review PR was opened; it would review the stale remote content instead of the delivery. Resolve the remote branch `knc-1` (delete or rename it, or force-push deliberately), then deliver again." (§6 1b). The operator's `deliver_for_review` answer: "Delivery push CONFLICTED: ... Open a decision packet with a `resolve_remote_collision` option ... Do NOT author `discard_branch` here ..." (`operator-actions.server.ts:2755-2766`). `branch_collision` from `openTaskPr` does NOT fire in this recipe (CF-ADOPT-4).

Variant C-no_revision: run the same host commands on a task whose delivering run has NOT finished (no `workRevision`). The collision note's cause reads "KNC-1 has delivered no revision, so no pull request can stand for its work yet". If the hand PR's head later EQUALS the revision the run mints, the next tick adopts it (recipe B1 shape with `previousPrNumber: null`, notification "PR #N adopted for KNC-1").

### 21.4 Collision follow-up: the packet and the dialog

- The operator authors it with `open_decision_packet` (`operator-toolkit.server.ts:413`), option `kind: "resolve_remote_collision"` (`task-file.schema.ts:165`; description at `operator-toolkit.server.ts:437`). `discard_branch` authoring is refused on a task with a `workRevision` or an occupied branch name (`pr !== null || github.unownedPr !== null`): "discard_branch only fits a LOCAL, never-pushed branch with no delivered revision — ..." (`operator-actions.server.ts:1060-1080`).
- Resolution needs `approve-transition` (admin/maintainer, `rbac.ts:71`) and a human actor: `resolveRemoteBranchCollision` refuses `{reason: "no_actor", message: "No acting user."}` (`github-reconciler.server.ts:1788-1791`).
- Dialog `data-screen-label="Packet collision dialog"` (`decision-packet.tsx:527`), `stranger = task.unownedPr !== null` (:520):
  - `unownedPr` recorded: heading "Clear the branch collision?", aria-label "Clear this task's branch collision", confirm "Clear collision & redeliver", Decision row "reclaims the branch name for this task.", Deletes row "The stale branch `knc-1` on GitHub, the unrelated one squatting on this task's branch name, and closes its pull request #N. Deleting the remote branch cannot be undone."
  - no `unownedPr`: heading "Delete this task's remote branch?", aria-label "Delete this task's remote branch and redeliver", confirm "Delete branch & redeliver", Decision row "removes this task's own remote branch and pushes its local work again.", Deletes row "This task's own remote branch `knc-1` on GitHub. No unrelated pull request is recorded on it, so nothing of anyone else's is touched and no pull request is closed."
  - foot hint "Recorded as timeline events and audit rows."
- Order on confirm (:1808-1835): `deleteTaskRemoteBranch` FIRST (timeline "Deleted branch `knc-1` from GitHub.", audits `github.branch_delete` and `github.branch.deleted`); when the cached OWN PR is `review`/`accepted` it first re-confirms with a silent `reconcileTask` (`wakeOperator` noop, `suppressDivergenceNotice`) and refuses `own_pr_open` / `unconfirmed` (:1625-1660, §8 sentences); then `PATCH /pulls/<unownedPr> {state: "closed"}` -> timeline "Closed unrelated PR #N that stood on branch `knc-1` (it was not KNC-1's review PR)." by the confirming human, audit `github.pr.closed_unowned` (:1819-1836); then `performDelivery` (fresh push -> `POST /pulls` -> "Opened **PR #N+1** for review.", `github.pr.opened`), `github.unownedPr` cleared, `readiness: blocked -> ready`; `serverOutcome {kind: "resolve_remote_collision", outcome: "cleared_and_delivered" | "cleared_delivery_failed"}` and audit `github.collision.resolved {outcome, reason, prNumber, delivered, blockLifted}` (`task-actions.server.ts:7599-7665`).
- In recipe C the task has `pr: null`, so the own-PR confirm pass is skipped and the delete proceeds straight away.

### 21.5 The workspace door (`gh pr view`) and whether it can fire here

- Code: `exec("gh", ["pr", "view", <branch>, "--repo", repo, "--json", "number,state,title,headRefOid"])` from the workspace dir, 8 s timeout (`workspace-delivery.server.ts:569-583`); `defaultExec` turns ENOENT and non-zero exits into `{ok: false}` (:98-117) and the caller then leaves `pr:` untouched (:584, comment :565-566 "if gh is absent or returns nothing"). Runs at the end of every delivering run (`task-actions.server.ts:4042-4056`) and inside `performDelivery` step 2.
- Container: `Dockerfile:56-58` installs only `git ca-certificates` (+ `chromium`, `uv`); no `gh`. The path NEVER fires on the compose stack; the agent-opened-PR link comes only from the delivery and reconciler doors.
- Host dev server: `/opt/homebrew/bin/gh` 2.98.0 is logged in as `akin-ozer` via keyring (scopes `gist, read:org, repo, workflow`). The server process inherits PATH and keyring, so this door CAN fire on a host run, with the OWNER's identity, not a project PAT (CF-ADOPT-5). `gh pr view <branch>` answers the branch's newest PR whatever its state (comment :590-593); refusals write the same collision note with `github.unownedPr`.

### 21.6 Where to read the proof

- `audit_events` (`db/migrations/0001_baseline.sql`): `SELECT occurred_at, actor_label, action, subject_id, details_json FROM audit_events WHERE task_key='KNC-1' AND action IN ('github.pr.adopted','github.pr.opened','github.pr.closed_unowned','github.branch.deleted','github.collision.resolved','github.reconcile.task','github.workspace.pr_linked') ORDER BY occurred_at DESC;` (controller tool `inspect_audit_log` reads the same table).
- `task.md` frontmatter: `pr`, `github.unownedPr`, `workRevision.headSha`, `readiness`.
- Inbox `/notifications` (`routes.ts:36`); recipients = task owner + project admins + maintainers (`task-mutation.server.ts` `notifyTaskWatchers`).

### Candidate findings (code-derived, to confirm live)

- CF-ADOPT-1 A branch collision reaches no inbox and wakes no operator: the reconciler writes the `note` only (`github-reconciler.server.ts:819-828`); notifications fire for adoption and divergences alone (:877-930) and the wake list (:939-945) excludes the collision. The person learns of it from the task page or when a delivery later fails with "Delivery push conflicted". Docs §4 (`docs/domain/github-delivery.md:229-233`) describe the note and the packet but do not say the collision is silent.
- CF-ADOPT-2 The delivery-door adoption record names a stale state: `openTaskPr` step 0 sees the cached PR closed live and deliberately does not write that to the cache (`pr-open.server.ts:390-399`), then `recordPrAdoption` copies `previousState: fm.pr?.state` (:472), so the timeline says "replacing PR #N (review)" and the audit `previousState: "review"` for a PR that is closed on GitHub. The reconciler door (B2) says "(closed)" for the same situation.
- CF-ADOPT-3 A delivery-door adoption is invisible outside the timeline: no notification (only `source: reconciler` notifies), and the toast / operator message read "PR #N already carries `R7` · nothing to push" / "Nothing to push: PR #N already carries `R7`." (`delivery-toast.ts:18`, `operator-actions.server.ts:2751`), which never say the PR was one Viberr did not open.
- CF-ADOPT-4 Docs claim, code disagrees on WHERE a refused adoption blocks delivery: `docs/domain/github-delivery.md:182` says the delivery "applies the adoption rule; a refused adoption is a collision" and ruling 35 says a refused match blocks delivery. In code the push (`push_conflict`, §6 1b) precedes `openTaskPr`; a hand PR on the head shares the branch head, so a differing head conflicts at the push and a fast-forwarded head becomes the pushed revision and is ADOPTED. `branch_collision` at the delivery door is reachable only via `no_revision` (revision missing after a successful push, e.g. step 2 reconcile failed) or `head_unknown`. The observable blocking sentence in recipe C is the push-conflict one, and its remedy text ("delete or rename it, or force-push deliberately") differs from the collision note's ("Resolve it with a `resolve_remote_collision` decision").
- CF-ADOPT-5 Docs §8 (`docs/domain/github-delivery.md`, "Agent runs hold no GitHub credential") vs `workspace-delivery.server.ts:565-583`: on a host dev server the post-run reconcile shells out to the owner's logged-in `gh` and reads GitHub with the owner's identity. Inert in the container (no `gh` in the image); flag only if the observation runs on the host.
- CF-ADOPT-6 Recipe B2's tick 1 wakes the operator with `pr-diverged`, which may open a rework/archive packet; tick 2 wakes it again to withdraw. Between the two, a human who presses Deliver takes the delivery door (recipe A2) while the packet stands. Whether an open packet blocks Deliver, and whether the packet is withdrawn after a delivery-door adoption (the reconciler's `prJustReopened` wake never fires because the cache already says #M), was not verified.

---

## Gap fill: Which scope-violation paths are reachable with the owner's fine-grained PAT (no new token can be entered)

Extends §9. Premise (owner facts, memory): the bound PAT is fine-grained (`github_pat_…`), no expiry, and the observer may NOT enter any token. Everything below is what the CODE does with such a token; nothing here needs a second credential.

### What the validator stores for a fine-grained token (`validation_json`)

Verified `pat-validator.server.ts:187-495` (`validatePatToken`) and `pat-store.server.ts:243-253` (`recordPatValidation` writes `JSON.stringify(validation)` into `github_pats.validation_json`, `last_validated_at = checkedAt`).

| Field | Fine-grained value | Why |
|---|---|---|
| `tokenKind` | `"fine_grained"` | prefix `github_pat_` (`tokenKindOf`, :141-145) |
| `headerScopes` | `null` | GitHub sends no `x-oauth-scopes` header; only a classic token gets a list (:269-275) |
| `login` | GitHub login | `GET /user` |
| `expiresAt` | `null` on a no-expiry token | header `github-authentication-token-expiration` or known expiry |
| `repo` | `owner/name` or `null` | null when validated from the connection modal (repo-less), set on the project-scoped re-check (:157-160 of `github-actions.server.ts`, `proveAttachedCredential`) |
| `scopes[]` `repo` | `{ok:true, source:"probe", note:"read + write reported by GitHub for this token"}` when `GET /repos/<repo>` `permissions.push|maintain|admin === true` (:288, :425-430); `{ok:false, source:"probe", note:"repository readable but not writable"}` when `push === false` (:434-437); `{ok:true, source:"assumed", note:"repository readable; GitHub reported no permission block, so write is unverified"}` when no block (:438-446) | the ONLY write proof a fine-grained token can get read-only |
| `scopes[]` `pull_request:write` | `{ok:true, source:"assumed", note:"read proven; write needs a write request to prove — set VIBERR_GITHUB_WRITE_PROBE=1 to allow an authorization-only dry-run"}` after `GET /repos/<repo>/pulls?per_page=1&state=all` succeeds (:379-390, :466-472); `{ok:false, source:"probe", note:"pull-request read probe was refused"}` on a 4xx (:459-464); `{ok:true, source:"probe", note:"write proven by dry-run"}` only with `VIBERR_GITHUB_WRITE_PROBE=1` (:405-418, :453-457) | no read-only signal exists for PR write |
| any other required id (only if `project.md credentialPolicy.requiredScopes` names one, e.g. `workflow`) | `{ok:true, source:"assumed", note:"fine-grained tokens expose no scope introspection"}` (:475-479) | see finding CF-SC-3 |
| `status` | `"valid"` unless a scope is `ok:false` -> `"insufficient_scope"`, `detail: "Missing scope: <ids>."` (:486-491); `"repo_not_found"` on 404 (:304-312); `"org_approval_missing"` on 403 with `/approval|access policy|organization/i` (:314-321) | |
| `missingScopes[]` | ids with `ok:false` | |

Consequences for this deployment:
- The fine-grained "Workflows" permission is NEVER read, probed, or recorded. Nothing in `validation_json` says whether the token can push `.github/workflows/*`; the only oracle is GitHub's answer to a real push (`push-workspace.server.ts:838-860`).
- `credentialAdvisories` returns `[]` for a fine-grained token with no open `workflow` violation (`pat-store.server.ts:385-411`: the header advisory needs `tokenKind === "classic"`), so the card shows NO CI warning before the first refused push.
- The card renders proven chips only (`credential-card.tsx:74-82`): expect `repo` as a check chip and the line "pull_request:write unproven (verified on first use)" (:105-109) until a PR is opened; footer "Every provable scope verified. Secrets stay isolated from task records and timelines." (:165). After the first `POST /pulls` 2xx, `markWriteScopeProven` (`pat-store.server.ts:270-282`, called `pr-open.server.ts:569,:618`) rewrites the cached `pull_request:write` to `{ok:true, source:"probe"}` and the footer flips to "All required scopes proven. …" (:166). See CF-SC-2 for how a later re-check undoes that.

### SQL to read the token's proven permissions (non-secret; never select `encrypted_token`)

Run inside the container against `<dataRoot>/state/projection.sqlite` with `-readonly` (WAL stale-read hazard from the host). Table DDL verified `db/migrations/0001_baseline.sql:307-316`.

```sql
SELECT label, token_suffix, last_validated_at, validation_json FROM github_pats;
-- which PAT the project uses (0001_baseline.sql:317-319)
SELECT project_slug, pat_id FROM project_github_credentials;
-- open/resolved violations (0001_baseline.sql:356-366; unique open row per project+scope+task :648-649)
SELECT id, task_key, scope, status, detail, created_at, resolved_at, resolved_by FROM scope_violations ORDER BY created_at DESC;
-- the audit trail of every opener/resolver and every Re-check press
SELECT occurred_at, action, actor_label, task_key, details_json FROM audit_events
 WHERE action IN ('github.scope_violation.opened','github.scope_violation.resolved','github.credential.revalidated','github.pr.merge_refused')
 ORDER BY occurred_at DESC;
```

Reading `validation_json`: `tokenKind` must be `fine_grained` and `headerScopes` `null` (if it is `classic` with a list, §6's before_push refusal applies instead and the rest of this section is moot). `scopes[]` entries with `source:"probe"` are proven, `"assumed"` are not evidence. `repo` proven with `ok:true` = the token holds Contents write on THIS repo (`permissions.push`), which is what `git push`, `POST /git/refs` and the bootstrap need. `github.credential.revalidated` rows carry `details_json {outcome, validationStatus, resolvedViolations, cached}` (`pat-validator.server.ts:596-609`; `cached:true` = the 60 s cooldown reused the stored `valid` verdict, :662-672, so a Re-check within 60 s of a successful one does NOT hit GitHub).

### Reachability of each §9 opener with the owner's token

| Opener (scope) | Trigger in code | Reachable now | Why / recipe |
|---|---|---|---|
| Branch ref read 403 (`repo`) | `branch-sync.server.ts:706-722` (`GET /git/ref/heads/<branch>` 403) | no | needs a token without Contents read on the repo; the owner's token has proven read (project exists, mirror clones) |
| Branch create 403 (`repo`) | `branch-sync.server.ts:673-694` (`POST /git/refs` 403) | no | needs Contents read-only; `repo` chip would already read "repository readable but not writable" |
| Allocation 403 (`repo`) | `branch-sync.server.ts:575-590` (`allocateTaskBranchName` forbidden) | no | same permission |
| Bootstrap 403 (`repo`) | `repo-bootstrap.server.ts:322-341` (`violation()` helper) | no | same permission; and `k9s-clone` bootstrap needs Contents write, which the token has if `repo` chip is proven |
| Compare 403 not rate-limited (`repo`) | `github-reconciler.server.ts:360-381`; `rate_limited` = `x-ratelimit-remaining: 0` or `/rate limit/i` (`branch-sync.server.ts:324-331`) | no (a primary rate limit opens nothing by design) | |
| PR open 403 (`pull_request:write`) | `pr-open.server.ts:627-647` | no, unless the token lacks the fine-grained "Pull requests: write" permission | if the owner's token was created without Pull requests write, the FIRST delivery opens this violation (GitHub answers 403 "Resource not accessible by personal access token"; unverified wording, any 403 qualifies). Check before the pass: `scopes[]` `pull_request:write` will be `{ok:false, source:"probe", note:"pull-request read probe was refused"}` only if READ is also missing; write-missing with read present is indistinguishable from fine (`assumed`) |
| Merge 403 (`pull_request:write`) | `github-reconciler.server.ts:1507-1536`, audit `github.pr.merge_refused` | no (same permission as PR open) | a merge refused by a ruleset/branch protection is 405 -> `not_mergeable`, never a violation (:1501-1503) |
| Close unowned PR 403 (`pull_request:write`) | `github-reconciler.server.ts:1841-1862` (branch delete path, C05-D) | no | |
| before_push classic refusal (`workflow`) | `push-workspace.server.ts:815-836` requires `tokenKind === "classic"` and `headerScopes !== null` | NO, never on fine-grained | `headerScopes` is null, the guard is skipped; the push always goes to GitHub |
| GitHub push refusal (`workflow`), `phase: "github"` | `push-workspace.server.ts:843-859`, classifier `isWorkflowScopeRejection` :270-272 = `/refusing to allow .*(create|update) workflow/i && /workflow.? scope/i` | ONLY IF the fine-grained token lacks the "Workflows" repository permission | the one provokable class; recipe below |

Two more classes reachable without any token change, for completeness:
- `push_failed` (no violation): a protected `main`/ruleset or a pre-receive hook. Stderr like `GH006: Protected branch update failed` is explicitly NOT a scope refusal (`push-workspace.server.test.ts:1062`). Task event title "Delivery push failed" with the fenced "What the push reported:" block (`task-actions.server.ts:5447-5470`).
- `push_conflict` (no violation): a pre-existing remote branch under the task key (§8).

### Recipe for the one reachable opener (fine-grained token without Workflows)

Preconditions to read first: `validation_json.tokenKind == "fine_grained"`, `repo` chip proven. Whether the token holds Workflows cannot be read from viberr; the GitHub token settings page is the only place (observer reads, never edits).

1. Ask the controller (or a task goal) for a task whose deliverable ADDS `.github/workflows/ci.yml` on the agent's branch (e.g. "add a GitHub Actions workflow that runs `go test ./...`"). The deliverer commits it in the workspace; agents hold no credential, so nothing happens until delivery (`push-workspace.server.ts:24`, docs §8).
2. `changedWorkflowFiles` measures `git log --format= --name-only <remoteHead>..HEAD -- .github/workflows/` (first push: `origin/<default>..HEAD`) (:282-306). `null` = unmeasurable (a degraded read), `[]` = measured none; both push anyway on fine-grained.
3. Outcome A, token HAS Workflows: `status:"pushed", workflowFiles:["…/ci.yml"]`. `performDelivery` then sweeps open `workflow` violations and resolves them (`task-actions.server.ts:5474-5495`); with none open this resolves nothing and no event says "CI file pushed". PR opens as usual. Nothing scope-related is observable; note only whether the PR body/timeline mentions the workflow at all.
4. Outcome B, token LACKS Workflows: `status:"push_refused_scope", scope:"workflow", phase:"github", files:[…], reason:<one-line redacted stderr>` (:851-858). `performDelivery` (:5414-5445) then:
   - `flagScopeViolation` -> `scope_violations` row `{scope:"workflow", task_key:KEY, detail:"**Policy violation:** active PAT is missing `workflow`. pushing `.github/workflows/ci.yml` on `<branch>`"}` (`scope-flag.server.ts:46-48`), a `policy` timeline event by `{kind:"system", systemId:"policy-engine"}` (:41-44, :83-101), a `policy` notification from "Policy engine" to owner + admins/maintainers (:131-146), audit `github.scope_violation.opened {scope:"workflow"}` (`policy-violations.server.ts:208-221`), SSE `violation.updated` (:222-227). Idempotent: a second refusal on the same task writes nothing new (`created:false`).
   - `surfaceDeliveryEvent` writes a SECOND event, type `github`, actor `{kind:"system", systemId:"delivery"}`, plus a SECOND notification (kind `policy`, title "Delivery push refused: workflow scope") (`task-actions.server.ts:6052-6085`). Text: "GitHub refused to push `.github/workflows/ci.yml` on `<branch>`: the token lacks the `workflow` scope (<reason>). Nothing was pushed and no review PR was opened. Grant the `workflow` scope to the project's token on GitHub, then use Re-check on the project's GitHub view, and deliver again." (:5430-5437).
   - Returns `{status:"scope_violation", scope:"workflow", message}`. The task page's Deliver control answers 409 with toast "Delivery did not complete: <message>" (`project.task.tsx:715-728`, `delivery-toast.ts:10-13`); an applied operator `delivery` card throws the same conflict (`task-actions.server.ts:9636-9638`). The operator's own delivery attempt reads "Delivery was refused for a missing `workflow` scope: … A scope violation is open on the task; do not retry until the credential card shows the scope. Do not ask an agent to push." (`operator-actions.server.ts:2765-2774`, outcome `noop`).
   - Surfaces: task timeline chip label "Policy violation" with a shield (`event-meta.ts:31`), rail Settings badge `.count.violations` = open count (`rail.tsx:86-91`, `project.tsx:161`), GitHub view credential card advisory `data-advisory="workflow_scope"` "GitHub refused a push under .github/workflows/ with this token (KEY): it lacks the workflow scope. Grant it on GitHub, then Re-check the credential." (`pat-store.server.ts:391-398`). NOTE: no `workflow` chip appears (chips are the required set only, `getProjectCredentialHealth` :506-518), so the card's footer STILL reads "Every provable scope verified." above/below the advisory.
5. Way out, in order:
   - The owner adds "Workflows: read and write" to the fine-grained token on GitHub (observer must not touch token settings; it is a permission edit, not a new token, so the bound PAT keeps working unchanged: viberr stores the token string, not its permission set).
   - Press "Grant scope" (button label `github-view.tsx:500`, title "Re-check the credential's scopes against GitHub"; intent `grant-scope`, RBAC `grant-github-scope`, `project.github.tsx:135-138`). On fine-grained this CANNOT resolve the `workflow` violation: `revalidateProjectCredential` resolves a non-write scope when `grantedScopes.has(scope)` (:714-716), and `grantedScopes` = required-set `ok` ids + `headerScopes` (:694-711); `workflow` is in neither. Expected toast: "Scopes re-checked. All required scopes granted." (`github-copy.ts:79`), audit `github.credential.revalidated {outcome:"revalidated", resolvedViolations:0}`, violation still open, advisory still shown.
   - Deliver again. Only a `pushed` result with `workflowFiles.length > 0` resolves it (:5474-5495): row `status='resolved', resolved_by=<actor userId>`, `policy` event "**Policy update:** `workflow` granted on the project credential. The earlier violation is resolved, and operations needing `workflow` will work now." (`scope-flag.server.ts:50-56`), audit `github.scope_violation.resolved`. A retried push whose measurement comes back `null` resolves nothing even when GitHub accepted it (comment :5476-5479).
   - If the owner instead removes the workflow file from the task, the violation stays open forever on this token kind (no header, no probe): the rail badge and advisory persist until someone ships CI successfully.

### Re-check evidence rules (why fine-grained clears only on a real write)

Verified `pat-validator.server.ts:573, :694-729`:
- `WRITE_EVIDENCE_SCOPES = {"repo","pull_request:write"}` clear only when the fresh validation lists them `ok` with `source` `header` or `probe`.
- `repo` on fine-grained IS probe-proven from `permissions.push`, so a `repo` violation (unreachable here) would clear on Re-check.
- `pull_request:write` on fine-grained is `assumed` unless `VIBERR_GITHUB_WRITE_PROBE=1`, so its violation clears only on a successful merge (`github-reconciler.server.ts:1437-1450`, `findOpenScopeViolation` + `resolveScopeViolationWithEvent`). A successful PR OPEN does NOT resolve an open `pull_request:write` violation: `pr-open.server.ts` imports no resolver (grep: only `flagScopeViolation`, `markWriteScopeProven`).
- `workflow` is a non-write scope for the sweep, but it enters `grantedScopes` only via `headerScopes` (classic) or as a `credentialPolicy.requiredScopes` entry (then `assumed`, :475-479, which the sweep accepts for non-write scopes). Docs `github-delivery.md:349-351` and ruling 144(c) (`decisions.md:2762-2765`) say "resolved by a re-check whose header now lists `workflow` … or by the next successful push of workflow files"; code agrees, and for fine-grained only the second door exists.

### Candidate findings (code-derived; live-provable ones marked)

- CF-SC-1 (provable live, needs the token to lack Workflows): the remedy sentence says "then use Re-check on the project's GitHub view" (`task-actions.server.ts:5432`) and the advisory says "then Re-check the credential" (`pat-store.server.ts:396`), but the only control is labelled "Grant scope" (`github-view.tsx:500`); the word "Re-check" appears only in its hover title (:497). On a fine-grained token that button also cannot clear the violation, so the app's own remedy is a control under another name that does nothing for the case that produced the message; the true remedy (deliver again) is named nowhere on the card.
- CF-SC-2 (provable live with the owner's token, no violation needed): proof decay. After the first PR opens, `markWriteScopeProven` flips `pull_request:write` to `probe` and the footer says "All required scopes proven." A "Grant scope" press more than 60 s later re-validates (`validatePat` -> `recordPatValidation` overwrites the whole `validation_json`, :507-517, `pat-store.server.ts:243-253`) and the fine-grained branch writes `assumed` again, so the chip returns to "pull_request:write unproven (verified on first use)" although the PR it opened still exists. The connections panel on `/org/settings` mirrors the same per-PAT cache ("unproven. Verified when attached to a project", `connections-panel.tsx:316-324`). Recipe: open one PR, note the footer, press Grant scope after 61 s, reload.
- CF-SC-3 (code-only, not reachable in the pass unless `project.md credentialPolicy.requiredScopes` is edited by hand): with `workflow` (or any unknown id) in `requiredScopes`, a fine-grained validation emits `{ok:true, source:"assumed"}` for it (:475-479) and the sweep resolves an open `workflow` violation on that assumption (:714-716), contradicting B-GH8's "we don't know is not granted" for exactly the scope GitHub just refused.
- CF-SC-4 (provable live in Outcome B): a refused workflow push produces two timeline events and two `policy` notifications for one fact (the policy-engine violation and the delivery's "Delivery push refused: workflow scope"); check whether the inbox shows both and whether either links to the GitHub view.
- CF-SC-5 (provable live in Outcome B): the credential card shows the workflow advisory AND the green footer "Every provable scope verified." at once, because `workflow` is not a required-set chip; the rail badge counts 1 while the card's verdict area reports nothing missing.
- CF-SC-6 (docs): `docs/domain/github-delivery.md:29-35` says "Fine-grained tokens expose nothing to read, so they get no advisory" but does not say that on a fine-grained token a `workflow` violation can never be cleared by Re-check; ruling 144(c) states both doors without the token-kind split. Under-description, not contradiction.
