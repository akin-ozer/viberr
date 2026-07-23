# Delivery, GitHub & Review — canonical reference (pass 11, 2026-07-23)

Audience: implementation subagents with **zero** other context. Everything below is
verified against source on 2026-07-23 (main @ 04821fe). All paths are absolute-relative
to the repo root `/Users/akinozer/projects/viberr`.

**Mental model in one paragraph.** Viberr is file-native: `task.md` frontmatter is the
canonical truth, SQLite is a projection rebuilt from files (`rebuildPath`). Agents
(Claude Code / Codex specialists) work inside per-task **workspace clones with no push
credentials**. The **server owns delivery**: it creates the remote task branch, pushes
the workspace branch with the project PAT, opens the review PR, and (on human
acceptance) merges it. Reviews are **revision-bound**: a delivering run mints an
immutable `workRevision {id, headSha, treeSha}`; verdict-capable supporting engagements
record `verdicts[]` keyed to `revisionId`; `deriveValidation` + `acceptanceBlockedReason`
gate the human-only Review→Done acceptance.

---

## 1. Workspace lifecycle

### 1.1 Where workspaces live

Data-root layout: `app/server/files/file-store-root.server.ts:5-79`. Under
`${VIBERR_DATA_ROOT}` (env, resolved by `getDataRoot`):

```
projects/<slug>/project.md
projects/<slug>/tasks/<KEY>/task.md
projects/<slug>/tasks/<KEY>/workspace/<repo-name>/   ← the specialist clone
```

- `taskDir(slug, key)` = `projects/<slug>/tasks/<KEY>` (`file-store-root.server.ts:69`).
- `taskWorkspaceRoot` = `<taskDir>/workspace` (`app/server/tasks/specialist-run.server.ts:1090-1096`).
- Clone destination = `<taskDir>/workspace/<repo-name>` where repo-name is the last
  segment of `owner/name` (`specialist-run.server.ts:1259-1262`).
- Workspace **discovery** (used by push + reconcile) probes, in order: the run's own
  `workdir`, `<ws>/<repo-name>`, `<ws>/repo`, `<ws>` itself — first dir containing
  `.git` wins (`app/server/github/workspace-delivery.server.ts:254-261`,
  `push-workspace.server.ts:81-96`).

### 1.2 Clone creation

`cloneRepo` (`specialist-run.server.ts:1235-1303`), called from `startAgentRun`
(`specialist-run.server.ts:648-658`) only when the project/task has a `repo` AND a real
backend is available (`isBackendAvailable`). Facts:

- `git clone --depth 1` (shallow!) — args built by `createGitHubClonePlan`
  (`app/server/tasks/git-clone-auth.server.ts:110-160`).
- Auth is `GIT_ASKPASS`: a temp `askpass.sh` under `viberr-git-askpass-*` prints
  username `x-access-token` / the PAT from short-lived env vars
  (`VIBERR_GIT_ASKPASS_USERNAME/PASSWORD`). The token is **never** in argv or the
  persisted `remote.origin.url` (which stays `https://github.com/<repo>.git`).
  `dispose()` deletes the env entries + temp dir. Ambient credential helpers are
  neutralized via `GIT_CONFIG_COUNT/KEY_0/VALUE_0 credential.helper=""`.
- Workspace **reuse**: an existing `<dir>/.git` short-circuits the clone; legacy origin
  URLs that embedded the PAT are scrubbed via `githubRemoteSanitizationArgs`
  (`git-clone-auth.server.ts:88-101`, applied at `specialist-run.server.ts:1264-1274`).
  Note there is **no fetch/pull on reuse** — a reused workspace can be stale vs origin.
- Clone failure (private repo w/o PAT, offline, git missing) logs a credential-safe
  reason (`cloneFailureLogDetails`) and falls back to `workspaceRoot` as cwd — the run
  still starts; the prompt then tells the agent to clone itself
  (`buildAnalyzePrompt`, `specialist-run.server.ts:1014-1016`).
- **No git worktrees anywhere** — plain clones only, one shared clone per task
  (delivering and supporting runs use the same directory).

### 1.3 Commit identity (F24)

One delivery identity across both backends — `agentGitIdentity(profileId)` =
`{name: profileId, email: "<profileId>@viberr.local"}`
(`specialist-run.server.ts:1221-1233`):

- Run env gets `GIT_AUTHOR_NAME/EMAIL` + `GIT_COMMITTER_NAME/EMAIL` (overrides any
  `git config` the agent sets) — applied on fresh runs (`specialist-run.server.ts:675-679`)
  and resumes (`resolveResumeConfinement`, `specialist-run.server.ts:1124-1128`).
- `cloneRepo` also stamps `git config user.name/user.email` in the workspace so the
  **server's** auto-commit (see §2.3) attributes to the same profile
  (`specialist-run.server.ts:1248-1257`).
- Server fallback identity when the workspace has no configured email:
  `Viberr Delivery <delivery@viberr.local>` (`push-workspace.server.ts:224-237`).

### 1.4 Confinement

- `GIT_CEILING_DIRECTORIES` = the **task dir** (a strict ancestor of the cwd), so git
  discovery can't ascend to a host repo (`workspaceRunEnv`,
  `specialist-run.server.ts:1195-1212`).
- Capability grants → `disallowedTools` deny rules (Claude only; Codex ignores them and
  uses its own sandbox): `app/server/tasks/specialist-tool-policy.ts:30-96`. Withheld
  (`human`/`off`/always-human) capabilities deny e.g. `Bash(git push:*)`,
  `Bash(git commit:*)`, `Bash(gh pr create:*)`, `Bash(gh pr merge:*)`, and for
  `execute-code-or-write-repo`: `Edit/MultiEdit/Write/NotebookEdit + git commit`.
- The run **prompt** mirrors enforcement (XS-4): `buildAnalyzePrompt`
  (`specialist-run.server.ts:980-1070`) — supporting runs are told the workspace is
  read-only; delivering runs are told to commit locally with `[<KEY>]`-prefixed
  messages and explicitly **never** to push / open a PR ("Viberr owns delivery"), even
  under an operator directive. `directiveRequestsDelivery`
  (`specialist-run.server.ts:1073-1077`) detects push/PR directives and appends an
  audit-visible `policy` timeline event (`specialist-run.server.ts:799-836`).

### 1.5 `git add` scoping in server delivery

The server's auto-commit stages the **whole tree**: `git add -A` at
`push-workspace.server.ts:214-218`. Deliberate (F15): the uncommitted changes ARE the
deliverable; `.gitignore` keeps artifacts out; the changed-file list is captured into
the log (`push-workspace.server.ts:209-213`, logged at 251-255) so strays in a reused
workspace are reviewable. It is only reachable after HEAD is confirmed on a non-default
task branch (`push-workspace.server.ts:161-169`), so it can never commit onto main.

---

## 2. Delivery pipeline (server-owned)

### 2.1 Branch naming + remote branch creation

- `taskBranchName(taskKey)` = **lowercased task key**, nothing else: `"VIB-142"` →
  `"vib-142"` (`app/server/github/branch-sync.server.ts:38-40`; owner ruling
  2026-07-17 — the old `<key>-<title-slug>` form is gone; existing `branch:` values in
  frontmatter are honored as-is).
- `ensureTaskBranch` (`branch-sync.server.ts:167-327`) creates (or confirms) the remote
  ref from the project default branch head via `POST /repos/{repo}/git/refs`.
  Idempotent: existing ref → success `created:false`; a 422 "already exists" race →
  success. 403 opens a `repo` scope violation carried by the task; writes `branch` into
  frontmatter when absent; audits `github.branch.created`; returns fresh compare data.
- Called best-effort from the operator right before it prompts the delivering
  specialist (`ensureTaskBranchBestEffort`,
  `app/server/tasks/operator-actions.server.ts:1012-1029`, invoked at 1108).

### 2.2 When the server pushes

The push happens at the **Review boundary**. `transitionStage`
(`app/server/tasks/task-actions.server.ts:2504-2513`): when a task enters the resolved
review stage, it fires `openReviewPrBestEffort` (fire-and-forget, never fails the
transition), which:

1. Resolves the delivering profile's `canCommitPush` from its capability grants
   (F10-03) — resolution failure falls back **permissive** (`task-actions.server.ts:2529-2557`).
2. `pushWorkspaceBranch` (`app/server/github/push-workspace.server.ts:124-309`):
   - locates the workspace repo, requires HEAD on a non-default branch;
   - `grant_withheld` refusal when `canCommitPush === false` — the real enforcement for
     Codex, which ignores the tool denylist (`push-workspace.server.ts:176-185`);
   - **auto-commits a dirty tree** (delivery finalization — see §1.5);
   - counts `rev-list --count <default>..HEAD`; `no_commits` when 0;
   - pushes `HEAD:refs/heads/<branch>` with the project PAT via the same askpass env
     as the clone (`createGitHubAskpassEnv`, `git-clone-auth.server.ts:42-76`);
     stderr is redacted (may echo token). Typed results, never throws:
     `pushed | up_to_date | no_pat | no_repo | no_workspace | no_branch | no_commits |
     push_failed | grant_withheld | task_not_found`.
3. `openTaskPr` (§2.3).
4. If `nothing_to_review` (GitHub 422 = empty diff): a `github` timeline event + a
   `policy` notification to task watchers so the task doesn't silently stall at Review
   with no PR (`task-actions.server.ts:2591-2625`).

### 2.3 PR creation — API + token

`openTaskPr` (`app/server/github/pr-open.server.ts:117-254`). Uses the project-bound
PAT through `getProjectGithubContext` → `createGithubClient` (Bearer token against
`https://api.github.com`, see §3). Behavior:

- **Idempotent twice over**: (0) a live cached `fm.pr` (state ≠ closed) is confirmed
  via `GET /pulls/{n}` and reused — covers agent-side delivery on a branch the head=
  dedup wouldn't match; (1) `GET /pulls?head=owner:branch&state=open` reuses an open PR
  for the deterministic head; (2) otherwise `POST /repos/{repo}/pulls` with
  `title: "[KEY] <task title>"`, `head` = `fm.branch ?? taskBranchName(key)`,
  `base` = project default branch.
- PR body composed by `composePrBody` (`pr-open.server.ts:28-56`): Viberr task
  back-link (`taskUrl` from `BETTER_AUTH_URL`, `pr-open.server.ts:59-67`), Goal,
  change summary (from the `github.changed` cache), evidence, and the
  human-authorized-merge footer.
- Failure mapping: 403 → `pull_request:write` **scope violation** flagged on the task
  (`flagScopeViolation`, §3.4); 422 → `nothing_to_review`; 401 → `auth_failed`;
  network → `network_unavailable`. Never fabricates a PR ref on failure.
- `writePrToTask` (`pr-open.server.ts:256-330`) writes `fm.pr` in the **cache
  vocabulary** (open→`review`), preserves extra cached fields (`checks`), never
  downgrades a human-set `accepted`/`merged` while GitHub still says open (H1 guard),
  appends the "Opened **PR #N** for review." `github` event on creation, reprojects,
  audits `github.pr.opened`.

### 2.4 `findPrForBranch` — terminal-PR matching rules

`app/server/github/pr-linker.server.ts:108-219`:

- Lists PRs `head=owner:branch, state=all, sort=created desc, per_page=5` and takes the
  **newest**; fetches detail (merged flag + add/del/changed_files) and a check-runs
  summary for the head sha (`passing` = success/neutral/skipped, `failing` =
  failure/timed_out/cancelled/action_required, else pending).
- State mapping (`mapPrToCacheState`, `pr-linker.server.ts:25-33`):
  `merged||merged_at` → `merged`; `closed` → `closed`; anything else (open + draft) →
  `review`. Viberr-only fourth state `accepted` = human accepted, merge pending
  (GitHub never reports it). Canonical enum: `PR_STATE_VALUES`
  (`app/schemas/task-file.schema.ts:226`, tolerant `.catch("review")` at 237).
- **F26 terminal-PR rule** (`pr-linker.server.ts:164-175`): if the newest PR is
  terminal (raw GitHub state `closed`, i.e. merged or closed-unmerged) AND the live
  branch head ≠ that PR's head sha, return `none` — a reused branch that advanced past
  its old PR must not link the stale PR (a fresh one gets opened instead). Fail-safe:
  if the branch ref can't be read (auto-deleted on merge), link the terminal PR as
  before (the legitimate accepted / merged-out-of-band case).
- 403/404 on the list → `forbidden` (fine-grained PAT without PR read masks repos as
  404); reads are best-effort — only **write** failures open scope violations.

### 2.5 Delivery reconcilers (two of them)

**(a) Workspace reconciler** — `reconcileWorkspaceDelivery`
(`app/server/github/workspace-delivery.server.ts:198-543`). Runs after every finished
**delivering** run (`applyAgentCompletionEffects` step 2,
`task-actions.server.ts:1883-1906`; reviewers deliberately excluded). Best-effort,
never throws, idempotent. From the workspace git repo it:

1. Reads HEAD branch; valid only if non-empty, not detached, not the default branch.
2. Computes commits ahead of `origin/<default>` for the **display cache**
   (`fm.github.commits`), guarding shallow clones (deepen 50 first; skip when the
   deepen fails, rather than write a wrong cache) (`workspace-delivery.server.ts:299-324`).
3. **Mints/refreshes the `workRevision`** (F10-15): full `rev-parse HEAD` +
   `HEAD^{tree}`; `nextWorkRevision` (same tree ⇒ same review subject ⇒ keep the
   revision + verdicts; new tree ⇒ new id ⇒ all prior verdicts stale) and recomputes
   the derived `validation` (`workspace-delivery.server.ts:332-374`).
4. Writes branch + caches idempotently; audits `github.workspace.branch_reconciled`
   only on real branch/commit change (revision-only stamps stay audit-silent).
5. PR detection via the run's own `gh` CLI (`gh pr view <branch> --repo <repo> --json
   number,state,title`) — maps the GraphQL enum OPEN/CLOSED/MERGED to the cache
   vocabulary; H1 guard for `accepted`; a closed-without-merge on an accepted PR adds
   the "pending merge can no longer be completed" `policy` note; audits
   `github.workspace.pr_linked` (`workspace-delivery.server.ts:423-517`).

**(b) GitHub reconciler** — `reconcileTask` / `reconcileProject`
(`app/server/github/github-reconciler.server.ts:142-471`). **Manual-only trigger**: the
Reconcile button on `/projects/:slug/github` (`app/routes/project.github.tsx:55-56`,
RBAC `reconcile-github` = admin|maintainer;
`app/features/github/github-actions.server.ts:34-49`). Per task with a branch:

- Branch compare (ahead/behind) via `GET /compare/{base}...{head}`; PR facts via
  `findPrForBranch`; task-key-prefixed commit association (`taskCommits`,
  `branch-sync.server.ts:114-120`; an empty prefixed list never wipes a non-empty
  workspace-captured cache, `github-reconciler.server.ts:230-239`).
- Sync pill derivation: `merged > behind_main > synced` (`deriveSyncState`,
  `branch-sync.server.ts:125-132`).
- **R8-6 divergence detection** (`github-reconciler.server.ts:255-361`): fires only on
  the *transition* into a terminal PR state while the task is not in its terminal
  stage —
  - PR **merged** on GitHub but task not Done → "Divergence: … accept the completion"
    `policy` event + `notifyTaskWatchers` notification (Policy engine sender). The
    `accept_completion` recommendation **survives** (accepting is exactly right).
  - PR **closed** unmerged but task active → "rework and reopen, or archive" event +
    notification; `accept_completion` recommendations are **withdrawn**.
  - `transition` recommendations are withdrawn on **any** divergence (owner decision
    2026-07-18). Never auto-advances the stage — a human closes the loop.
- Records a provenance row per observation and audits `github.reconcile.task/project`.

**Divergence surfacing in UI**: there is **no dedicated banner** — divergence reaches
humans as (1) the typed `policy` timeline event on the task, (2) an inbox notification
via `notifyTaskWatchers`, (3) the PR pill flip: `prStatePill`
(`app/features/github/github-pills.ts:37-41`) — `merged`=done pill, `review`=info
"in review", `closed`=risk pill, `accepted`=input pill "merge pending". Task detail
shows "PR #N · merge pending" and the **Complete merge** button for `accepted`
(`app/features/task-detail/task-detail-page.tsx:112,172,963` → `completeTaskMerge`,
`task-actions.server.ts:3201-3266`).

### 2.6 Merge — `mergeTaskPr`

`github-reconciler.server.ts:517-671`. The real merge behind acceptance:

- Pre-step F7-GH5: if the PR is a draft, un-draft via the **GraphQL**
  `markPullRequestReadyForReview` mutation (REST can't), best-effort
  (`github-reconciler.server.ts:543-557`).
- `PUT /repos/{repo}/pulls/{n}/merge`. Success → `pr.state="merged"` + human-authored
  `github` event + provenance + audit + **auto-resolve** an open `pull_request:write`
  violation (the successful write is the proof). Typed failures: 405 `not_mergeable`,
  409 `head_changed`, 403 → scope violation (flag + audit `github.pr.merge_refused`),
  404 `pr_not_found`, 401 `auth_failed`.

---

## 3. GitHub connection config

### 3.1 Where tokens live

`app/server/secrets/pat-store.server.ts`. **User-provided GitHub PATs**, AES-256-GCM
encrypted at rest (`secret-box.server.ts`), in the SQLite `github_pats` table
(id/user_id/label/encrypted_token/token_suffix). Only `getPatToken`
(`pat-store.server.ts:190-199`) decrypts, server-side only. Metadata readers return
masked `····<last4>` only. Not org settings, not env: PATs are created per-user in the
UI and bound per-project.

### 3.2 How a project binds to a repo

Two independent bindings:

- **Repo**: `project.md` frontmatter `repo:` ("owner/name") + `defaultBranch:`;
  mirrored into the `projects` projection row. Task-level `repo:` frontmatter
  **overrides** the project default (`getProjectGithubContext` `repoOverride`,
  `app/server/github/github-context.server.ts:45-76`).
- **Credential**: `project_github_credentials` table binds ONE stored PAT per project
  (`setProjectCredential` / `getProjectCredential`, `pat-store.server.ts:216-276`),
  audited. `project.md`'s `credentialPolicy` stays the non-secret display/requirements
  source (label, masked, requiredScopes); default required scopes:
  `repo, workflow, read:org, pull_request:write` (`pat-store.server.ts:29-34`).

`getProjectGithubContext` is the single resolver every GitHub service starts from; the
two config gaps come back as typed values, not throws:
`{status:"no_repo_configured"}` / `{status:"no_pat_configured", repo}`.

### 3.3 With no connection

Everything degrades to typed results the UI renders as pills/cards:

- Runs still start; `cloneRepo` without a PAT attempts an unauthenticated clone
  (public repos work), else falls back to an empty workspace.
- `ensureTaskBranch` / `openTaskPr` / `reconcile*` short-circuit with
  `no_repo_configured` / `no_pat_configured`; `openReviewPrBestEffort` logs and moves
  on — a transition never fails on GitHub state.
- Acceptance without reachable GitHub records `pr.state="accepted"` (merge pending),
  never a false "merged" (§4.5).
- Connection panel fact: `checkRepoAccess`
  (`app/server/github/repo-access-check.server.ts:36-79`) → `connected | repo_not_found
  | auth_failed(expired|revoked) | org_approval_missing | forbidden |
  network_unavailable`.

### 3.4 Rate limits / error handling

`createGithubClient` (`app/server/github/github-client.server.ts:106-199`):

- Bearer auth, `application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`,
  user-agent `viberr`; ETag/If-None-Match support (304 → `not_modified`).
- **Exactly one retry, 5xx only** — no retry storms. Network + HTTP failures are typed
  results (`kind:"network" | "http"`), never throws; nothing logs the token.
- `rateLimit {limit, remaining, reset}` parsed from headers onto every response — but
  see gaps: no caller consumes it (no backoff/budget logic anywhere).
- `x-oauth-scopes` + token-expiration headers feed the PAT validator
  (`app/server/secrets/pat-validator.server.ts`) → scope chips / credential health on
  the GitHub view (`getProjectCredentialHealth`, `pat-store.server.ts:354+`).
- 403-on-write ⇒ **scope violations**: `flagScopeViolation`
  (`app/server/github/scope-flag.server.ts:109-145`) opens an idempotent violation row
  carried by the task + typed `policy` timeline event + watcher notifications;
  `resolveScopeViolationWithEvent` closes it with a `policy` update event (auto-fired
  by a later successful merge, §2.6).
- `githubWebHost` (`github-client.server.ts:210-220`) derives browse-link hosts and
  nominally supports GHE — but the API base is effectively hardcoded (see gaps).

---

## 4. Review model (revision-bound, F10-15)

All shapes in `app/schemas/task-file.schema.ts`.

### 4.1 `workRevision` minting

`workRevisionSchema` (`task-file.schema.ts:324-337`): `{id, headSha (full), treeSha,
branch, createdAt, sourceProfileId}` — the immutable identity of the delivered work
under review. Minted in **exactly one place**: the workspace reconciler after a
finished delivering run (`workspace-delivery.server.ts:332-356`), via
`nextWorkRevision` (`task-file.schema.ts:475-503`): same tree (or same head when tree
unavailable) ⇒ `changed:false`, revision + verdicts survive (F10-32); different tree ⇒
new `rev_*` id ⇒ every prior verdict is stale automatically. This IS new-commit
invalidation — there is no comment/stage-bounce heuristic anymore.

### 4.2 Verdicts

`reviewVerdictSchema` (`task-file.schema.ts:342-355`): `{profileId, revisionId,
headSha, result: approve|request_changes, reason, at}` in frontmatter `verdicts[]`.
Recorded in `recordAgentCompletion` (`task-actions.server.ts:1425-1452`): bound to the
**current** `workRevision.id`, last-write-wins per `(profileId, revisionId)`, reason =
first 2000 chars of the reply. An approve with no revision to bind to is recorded as
prose only ("Approval noted", never a pass).

Verdict **authority** resolution (`applyAgentCompletionEffects`,
`task-actions.server.ts:1692-1752`):

- The engagement's engage-time `verdictCapable` snapshot is authoritative when an
  engagement row exists (pass-10 ruling — a live-grant lookup would let an undeployed
  reviewer approve-but-never-record, wedging acceptance); live-grant fallback only for
  legacy/ad-hoc runs.
- Envelope verdict first (Claude `report_outcome` staged outcome keyed by `outcomeKey`,
  or Codex `outputSchema` JSON envelope — `app/server/tasks/agent-outcome.server.ts:53-179`);
  a verdict-authorized agent with no envelope falls back to the prose classifier
  `classifyReviewerVerdict` (`task-actions.server.ts:1324-1380`). The regex **never**
  runs without authority (R1). No determinable verdict ⇒ validation left unchanged +
  loud warn (F10, fail-safe).

### 4.3 `verdictCapable` — engage-time snapshot

Set on the engagement when engaged (`engagementSchema`, `task-file.schema.ts:94-108`):

- `assignSpecialist` (deliverer): `resolveAgentCollab(caps, true).verdict`
  (`specialist-run.server.ts:264-277`).
- `assignReviewer` (supporting): `resolveAgentCollab(caps, false).verdict`
  (`specialist-run.server.ts:376-393`).

`resolveAgentCollab` / `effectiveCollabMode` (`agent-outcome.server.ts:212-248`):
verdict is **explicit-only** (F10-14) — `report-validation-verdict: direct` grant
required; the catalog default is `off` (`app/shared/capabilities.ts:54`); a `recommend`
grant deliberately falls through to the default (pre-generic-agents data hazard).

**Required reviewers** = supporting engagements with `verdictCapable:true`
(`requiredReviewers`, `task-file.schema.ts:408-410`). The deliverer is never required.

### 4.4 `deriveValidation` + `acceptanceBlockedReason`

- `deriveValidation` (`task-file.schema.ts:426-444`): `none` before any revision;
  `failing` if any required reviewer requests changes on the current revision;
  `healthy` when required reviewers exist and all approved it; else `changed`.
  `validation` in frontmatter is a **derived cache**, recomputed on verdict recording,
  revision minting, and review-stage entry — never authored.
- `acceptanceBlockedReason` (`task-file.schema.ts:450-468`) — the **single acceptance
  gate**, returns null (acceptable) or a human-readable reason:
  - no revision + required reviewers exist → "No reviewed revision yet…";
  - no revision + no required reviewers → **acceptable** (planning/non-repo tasks);
  - any required `request_changes` on current revision → "rework and re-review…";
  - missing approvals → "Waiting on N required reviewer approval(s)…".
  Consumed by: `acceptCompletion` (`task-actions.server.ts:3113-3116`, unless
  `force:true` human override), the `accept_completion` packet option
  (`task-actions.server.ts:2840-2843`), and the review queue (§4.6).

### 4.5 Accept-completion flow + RBAC

`acceptCompletion` (`task-actions.server.ts:3090-3198`), reached via:
(a) `transitionStage` into the terminal stage by a human (auto-routed,
`task-actions.server.ts:2372-2384`); (b) the `accept_completion` packet option in
`resolvePacket` (`task-actions.server.ts:2826+`); (c) `applyRecommendation` of an
operator `accept_completion` card (`task-actions.server.ts:3336`).

- **RBAC**: `requireAcceptCompletion` (`task-actions.server.ts:289-298`) =
  `accept-completion` action (admin|maintainer per
  `app/shared/rbac.ts:54`) **OR** the task-owner exception (R6-2): the live
  contributor+ owner of the task (`ownerException`, `task-actions.server.ts:275-286`).
- Gates: `acceptanceBlockedReason` (unless `force`), and an open operator `blocked`
  packet refuses acceptance (F7-VAL1, `task-actions.server.ts:3124-3132`).
- Effects: attempts the **real merge** (`mergeTaskPrIfPossible` → `mergeTaskPr`);
  writes stage=terminal, readiness=ready, waiting=none, validation=healthy,
  `pr.state` = `merged` (real) or `accepted` (merge pending — offline/no-PAT/not
  mergeable), clears packet + transition/accept recommendations, appends the
  `completion` event with honest copy, audits `task.transition` via
  `accept_completion`.
- Later, **Complete merge** (`completeTaskMerge`, `task-actions.server.ts:3201-3266`)
  finishes a merge-pending acceptance: same RBAC, requires `pr.state === "accepted"`,
  calls `mergeTaskPr`, returns typed user messages per failure.

### 4.6 Review queue — `/projects/:slug/review`

Route: `app/routes/project.review.tsx` (member-only loader, R4; membership checked
before the 404 so non-members can't probe existence). Read model:
`getReviewQueue` (`app/server/projections/review-queue.server.ts:61-160`):

- Qualification: tasks whose stage is the **resolved review stage**
  (`resolveStageRoles().reviewId` — never the literal id "review"; on a
  todo/doing/done board the review role is `doing`).
- Panel split (R8-3, viewer-scoped): **"Waiting on your acceptance"** (`ready`) iff
  `waiting === "human"` AND the viewer can accept (maintainer+ via `resolve-packet`
  tier, or task owner with `own-task`) AND `blockReason === null` (F10-11 — computed
  per task by re-reading frontmatter and calling `acceptanceBlockedReason`).
  Everything else → **"Still in review"** (`working`). No viewer passed ⇒ state-based
  split (tests / unscoped callers).
- Rows carry waiting, packet header, newest event text, pr {number, state
  review|merged}, validation, blockReason. Read-only; zero mutations; SSE revalidation
  keeps it live. Ordering: task-key number ASC.

---

## 5. Stage / transition model

Stages are per-project frontmatter (`project.md` `stages:` + `workflow:` edges), freely
renamed — structural roles are **derived**, never literal ids
(`app/shared/workflow/stage-roles.ts:25-78`): `entry` = first stage, `terminal` =
last, `review` = the stage with an edge INTO terminal (fallback: positionally
second-to-last), `work` = stage with an edge into review. `stageLockReason` pins entry
+ terminal against policy edits.

`transitionStage` (`task-actions.server.ts:2303-2516`) — who can move what:

| Move | Gate |
|---|---|
| Declared `auto` boundary | any member (UI always sends manual, so effectively unreachable) |
| Declared `approval` boundary | `approve-transition` (admin\|maintainer) |
| Declared `human` boundary (review→done in V1) | `requireAcceptCompletion` (admin\|maintainer or owner) |
| `manual: true` (stage dropdown, any direction/off-graph) | `approve-transition` (admin\|maintainer) |
| Operator (ctx.operatorAuthorized) | capability-gated upstream (`stage-transitions` grant); **may never bare-move into the terminal stage** — hard forbidden (`task-actions.server.ts:2391-2395`); reaches Done only via accept-completion under full autonomy |
| Operator `rework: true` | backward move only, on `validation === "failing"` only (R7-4, `task-actions.server.ts:2350-2357`) |
| Human → terminal stage | auto-routed into the full `acceptCompletion` contract (`task-actions.server.ts:2372-2384`) — never a bare move |

**Transition-to-done is ALWAYS_HUMAN** at three layers: (1) the capability catalog
marks `transition-to-done`, `merge-pull-request`, `change-project-policy` as
structurally human (`ALWAYS_HUMAN_CAPABILITY_IDS`, `app/shared/capabilities.ts:79-83`)
and profile writes coerce them to mode `human`
(`app/features/agents/agent-profile-actions.server.ts:130-197`); (2) the operator's
`completion-for-acceptance` capability is never autonomy-promoted past `recommend`
(`capabilities.ts:42`); (3) the terminal-stage checks in `transitionStage` above.

Side effects on transition: entering review recomputes derived validation (never
launders a standing `failing` — only a new revision can); leaving the entry stage
attaches the operator + clears the triage `input_required`; pending `transition`
recommendations are dropped; non-operator moves to non-terminal stages auto-invoke the
operator (`task-actions.server.ts:2500-2502`); entering review fires the push+PR spine
(§2.2). Audited as `task.transition` with the boundary kind.

**Delivery-relevant run orchestration** (context): one live delivering run per task
(single-flight 409, `specialist-run.server.ts:537-554`); every run start path
registers ONE completion pipeline (`registerAgentCompletion`,
`task-actions.server.ts:1576-1615`; also the resume path at 930) whose effects are
reply → workspace-delivery reconcile (delivers only) → verdict/question → operator
react loop (depth-capped, no-progress detection) → waiting flip
(`applyAgentCompletionEffects`, `task-actions.server.ts:1623-1998`). Boot recovery
(`recoverUnreactedAgentRuns`, wired in `app/server/boot.server.ts:156`) replays the
same effects for runs that finished while the server was down.

---

## Suspicious / gaps

1. **Auto-commit at Review is invisible to the review model** — no `workRevision`
   re-mint after the push-time auto-commit. `pushWorkspaceBranch` commits a dirty tree
   at the Review boundary (`app/server/github/push-workspace.server.ts:198-263`), but
   `workRevision` was minted earlier, at delivering-run completion
   (`workspace-delivery.server.ts:332-356`), from the pre-auto-commit HEAD. Nothing
   re-runs `reconcileWorkspaceDelivery`/`nextWorkRevision` after the auto-commit, so
   the PR's actual head can postdate `workRevision.headSha` and reviewer verdicts bind
   to a sha that is NOT what the PR delivers. (Reviewers reading the shared workspace
   see the files either way, but the recorded `headSha` traceability is wrong.)

2. **Divergence detection is manual-only.** `reconcileTask`'s R8-6 merged/closed-out-
   of-band detection (`github-reconciler.server.ts:255-361`) only ever runs from the
   Reconcile button on the GitHub view (`app/routes/project.github.tsx:55`,
   `app/features/github/github-actions.server.ts:41`). No scheduler/poller/webhook
   calls it (checked `app/server/boot.server.ts` — the schedule runner fires operator
   re-runs only). A PR merged directly on GitHub goes unnoticed indefinitely unless a
   maintainer clicks Reconcile (or a later specialist run's workspace `gh` happens to
   see it).

3. **Hardcoded api.github.com in the un-draft mutation.** `mergeTaskPr` POSTs to the
   literal `"https://api.github.com/graphql"` (`github-reconciler.server.ts:549`),
   bypassing the client's `baseUrl`. Related: `createGithubClient` is never called
   with a non-default `baseUrl` in production (`github-context.server.ts:66-70`), so
   `githubWebHost`'s GHE branches (`github-client.server.ts:210-220`) are effectively
   dead code — fine for github.com-only, but the two layers disagree about whether GHE
   is a thing.

4. **Rate-limit info is surfaced but never consumed.** `GithubResponse.rateLimit` is
   parsed on every call (`github-client.server.ts:80-92,161`) yet no caller reads it
   (repo-wide grep: only auth-login rate limiting matches). Same for the ETag /
   `not_modified` support — no caller passes `etag`. Dead capability or future work.

5. **`canCommitPush` falls back permissive.** In `openReviewPrBestEffort`, a failure
   to resolve the delivering profile (undeployed, file error) sets
   `canCommitPush = true` (`task-actions.server.ts:2553-2557`) — a withheld-grant
   profile that was undeployed between run and Review gets its workspace pushed anyway.
   Deliberate ("the common case is a granted profile") but it weakens F10-03.

6. **Workspace PR detection depends on the run's `gh` auth that sandboxed runs don't
   have.** `reconcileWorkspaceDelivery` step 4 shells `gh pr view` "using whatever gh
   auth the run had" (`workspace-delivery.server.ts:423-440`) — but the server-owned
   delivery model (F-GH3) means agents no longer open PRs, and containerized runs have
   no `gh` login; in practice this path mostly exercises the *developer machine's*
   ambient `gh` auth. Harmless (best-effort) but is a leftover from the pre-F-GH3
   agent-side delivery world.

7. **`stageLockReason` third role mismatch risk** — none found; but note
   `deriveSyncState`/`taskCommits` still carry "(mock data contract)" doc comments
   (`branch-sync.server.ts:111-116`) though they are live code paths — the comment is
   stale, not the code.

8. **Reused workspace is never refreshed.** `cloneRepo` reuses `<ws>/<repo>` without
   any `git fetch`/reset (`specialist-run.server.ts:1264-1274`), so a second run on a
   task starts from the previous run's HEAD/tree (including uncommitted junk another
   backend left). That's partly intended ("reused workspace" F15 visibility in the
   push), but combined with the shallow `--depth 1` initial clone it also means the
   commit-count and `<default>..HEAD` computations depend on a possibly stale local
   default-branch ref (`push-workspace.server.ts:266-273` compares against the LOCAL
   `<defaultBranch>`, not `origin/<defaultBranch>` — on a shallow clone whose local
   default branch never advances this over/under-counts `localAhead`; the
   workspace-delivery reconciler DOES use `origin/<default>` + deepen, the push does
   not).

9. **Push failure before PR open is only logged.** In `openReviewPrBestEffort`, a
   `push_failed`/`no_pat` push result logs `logger.info` and proceeds straight to
   `openTaskPr` (`task-actions.server.ts:2570-2575`); only the resulting 422
   `nothing_to_review` becomes a timeline event/notification. A push failure with an
   EXISTING remote diff (e.g. new commits not pushed, old ones present) opens/reuses a
   stale-content PR with no human-visible signal that the newest work is missing.

10. **`grant_withheld` delivery dead-ends silently at Review.** When the deliverer's
    repo-write grant is withheld, `pushWorkspaceBranch` refuses
    (`push-workspace.server.ts:176-185`) and `openTaskPr` then 422s → the
    "no commits" timeline event claims "delivery may have produced no change", which
    mislabels a policy refusal as an empty delivery. No typed "delivery withheld by
    capability policy" surfacing exists.

11. **Two acceptance entry points, one `force` asymmetry.** `acceptCompletion` accepts
    `force?: boolean` (`task-actions.server.ts:3092`) but the packet-option path
    re-implements the gate WITHOUT a force override (`task-actions.server.ts:2840-2843`)
    and `transitionStage`'s auto-route never passes force — so the only true override
    path is whatever action surface sets `force` (grep shows the task route's
    accept intent). Not a bug, but implementers should know the override is not
    uniformly available.

12. **Seeded VIB-142 violation coupling.** `scope-flag.server.ts:33-36` documents that
    migration 0005 pre-seeds a `pull_request:write` violation with its events; logic
    is idempotent against it, but tests/implementers must not assume a clean
    violations table on seeded databases.
