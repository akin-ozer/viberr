# Delivery, GitHub & Review — canonical reference (pass 12, 2026-07-24)

Audience: implementation subagents with **zero** other context. Every claim below is
re-verified against source on 2026-07-24 (main @ 0981cfa). All paths are relative to
the repo root `/Users/akinozer/projects/viberr`. Supersedes the pass-11 doc
(`planning/discovery-2026-07-23-pass11/docs/delivery-github-review.md`, verified @
04821fe); see "Delta since pass 11" for what changed in between.

**Mental model in one paragraph.** Viberr is file-native: `task.md` frontmatter is the
canonical truth, SQLite is a projection rebuilt from files (`rebuildPath`). Agents
(Claude Code / Codex specialists) work inside per-task **workspace clones with no push
credentials**. The **server owns delivery**: it creates the remote task branch, pushes
the workspace branch with the project PAT, opens the review PR, and (on human
acceptance) merges it. Reviews are **revision-bound**: a delivering run mints an
immutable `workRevision {id, headSha, treeSha}`; verdict-capable supporting engagements
record `verdicts[]` keyed to `revisionId`; `deriveValidation` + `acceptanceBlockedReason`
gate the human-only Review→Done acceptance (the block reason is now also **projected**
into `task_projections.validation_block_reason`, P11-50). Since pass 11, GitHub state is
no longer manual-refresh-only: a **5-minute background poller** re-runs the reconciler
for every active branched project.

---

## 1. Workspace lifecycle

### 1.1 Where workspaces live

Data-root layout: `app/server/files/file-store-root.server.ts:5-13` (helpers through
~150). Under `${VIBERR_DATA_ROOT}` (env, resolved by `getDataRoot`, line 40):

```
projects/<slug>/project.md
projects/<slug>/tasks/<KEY>/task.md
projects/<slug>/tasks/<KEY>/workspace/<repo-name>/   ← the specialist clone
```

- `taskDir(slug, key)` = `projects/<slug>/tasks/<KEY>` (`file-store-root.server.ts:65`).
- `taskWorkspaceRoot` = `<taskDir>/workspace` (`app/server/tasks/specialist-run.server.ts:1082-1089`).
- Clone destination = `<taskDir>/workspace/<repo-name>` where repo-name is the last
  segment of `owner/name` (`specialist-run.server.ts:1250-1254`).
- Workspace **discovery** (used by push + both reconcilers) probes, in order: the run's
  own `workdir`, `<ws>/<repo-name>`, `<ws>/repo`, `<ws>` itself — first dir containing
  `.git` wins (`app/server/github/workspace-delivery.server.ts:254-264`,
  `push-workspace.server.ts:81-96`).

### 1.2 Clone creation

`cloneRepo` (`specialist-run.server.ts:1226-1295`), called from `startAgentRun`
(`specialist-run.server.ts:648`) only when the project/task has a `repo` AND a real
backend is available. Facts:

- `git clone --depth 1` (shallow!) — args built by `createGitHubClonePlan`
  (`app/server/tasks/git-clone-auth.server.ts:110-160`).
- Auth is `GIT_ASKPASS`: a temp `askpass.sh` prints username `x-access-token` / the PAT
  from short-lived env vars (`VIBERR_GIT_ASKPASS_USERNAME/PASSWORD`). The token is
  **never** in argv or the persisted `remote.origin.url`. `dispose()` deletes the env
  entries + temp dir; ambient credential helpers are neutralized via
  `GIT_CONFIG_COUNT/KEY_0/VALUE_0 credential.helper=""` (`git-clone-auth.server.ts:42-160`).
- Workspace **reuse**: an existing `<dir>/.git` short-circuits the clone; legacy origin
  URLs that embedded the PAT are scrubbed via `githubRemoteSanitizationArgs`
  (`git-clone-auth.server.ts:88-101`, applied at `specialist-run.server.ts:1255-1265`).
  Still **no fetch/pull on reuse** — a reused workspace can be stale vs origin (gap G7).
- Clone failure logs a credential-safe reason (`cloneFailureLogDetails`,
  `git-clone-auth.server.ts:173`) and falls back to `workspaceRoot` as cwd — the run
  still starts; the prompt tells the agent to clone itself.
- **No git worktrees anywhere** — plain clones, one shared clone per task (delivering
  and supporting runs use the same directory).

### 1.3 Commit identity (F24)

`agentGitIdentity(profileId)` = `{name: profileId, email: "<profileId>@viberr.local"}`
(`specialist-run.server.ts:1212-1224`):

- Run env gets `GIT_AUTHOR_*` + `GIT_COMMITTER_*` via `agentGitIdentityEnv` — applied
  on fresh runs (`specialist-run.server.ts:675`) and resumes (1119).
- `cloneRepo` stamps `git config user.name/user.email` in the workspace so the
  **server's** auto-commit (§2.3) attributes to the same profile
  (`specialist-run.server.ts:1239-1248`, non-fatal on failure).
- Server fallback identity when the workspace has no configured email:
  `Viberr Delivery <delivery@viberr.local>` (`push-workspace.server.ts:224-237`).

### 1.4 Confinement

- `GIT_CEILING_DIRECTORIES` = the task dir (`workspaceRunEnv`,
  `specialist-run.server.ts:1186-1201`).
- Capability grants → `disallowedTools` deny rules (Claude only; Codex ignores them):
  `app/server/tasks/specialist-tool-policy.ts:30-98` (`CAP_DENY_RULES`,
  `specialistDisallowedTools`); the push-time enforcement for Codex is
  `resolveDeliveryPermissions().canCommitPush` (`specialist-tool-policy.ts:110-127`).
- The run **prompt** mirrors enforcement (XS-4): `buildAnalyzePrompt`
  (`specialist-run.server.ts:954-1063`) — supporting runs read-only; delivering runs
  commit locally with `[<KEY>]` prefixes, never push / open a PR.
  `directiveRequestsDelivery` (`specialist-run.server.ts:1065-1080`) detects push/PR
  operator directives and appends an audit-visible `policy` timeline event (797).
- Single-flight for the DELIVERING agent: one live primary run per task, second
  dispatch 409s (`specialist-run.server.ts:528-546`).

### 1.5 `git add` scoping in server delivery

The server's auto-commit stages the **whole tree**: `git add -A` at
`push-workspace.server.ts:214-218`. Deliberate (F15): the uncommitted changes ARE the
deliverable; `.gitignore` keeps artifacts out; the changed-file list is logged
(`push-workspace.server.ts:209-213`, 251-255). Only reachable after HEAD is confirmed
on a non-default task branch (`push-workspace.server.ts:161-169`) — can never commit
onto main.

---

## 2. Delivery pipeline (server-owned)

### 2.1 Branch naming + remote branch creation

- `taskBranchName(taskKey)` = **lowercased task key**: `"VIB-142"` → `"vib-142"`
  (`app/server/github/branch-sync.server.ts:38-40`; owner ruling 2026-07-17; existing
  `branch:` frontmatter honored as-is).
- `ensureTaskBranch` (`branch-sync.server.ts:167-327`) creates (or confirms) the remote
  ref from the default branch head via `POST /repos/{repo}/git/refs`. Idempotent
  (existing ref / 422-race → success), 403 → `repo` scope violation, writes `branch`
  into frontmatter when absent, audits `github.branch.created`, returns compare data.
- Called best-effort from the operator right before it prompts the delivering
  specialist (`ensureTaskBranchBestEffort`,
  `app/server/tasks/operator-actions.server.ts:1046-1063`, invoked at 1142).

### 2.2 When the server pushes — the Review boundary

`transitionStage` (`app/server/tasks/task-actions.server.ts:2338-2587`): entering the
resolved review stage fires `openReviewPrBestEffort` (fire-and-forget, never fails the
transition; `task-actions.server.ts:2581-2584`). `openReviewPrBestEffort`
(`task-actions.server.ts:2622-2758`) now does, in order:

1. `resolveDeliveryPushGrant(ctx, slug, key)` (**exported**,
   `task-actions.server.ts:2598-2619`) — resolves the delivering profile's
   `execute-code-or-write-repo` grant. **P11-13 flipped the fallback**: a NAMED
   deliverer whose profile can't be resolved (undeployed between run and Review) is
   now a **conservative deny** (`canCommitPush=false`); only a task with no deliverer
   at all is permissive. Unit-tested directly
   (`app/server/tasks/delivery-push-grant.server.test.ts`).
2. `pushWorkspaceBranch` (`app/server/github/push-workspace.server.ts:124-309`):
   locates the workspace repo; requires HEAD on a non-default branch; refuses with
   `grant_withheld` when `canCommitPush === false` (`push-workspace.server.ts:176-185`
   — the real enforcement for Codex); **auto-commits a dirty tree** (§1.5); counts
   `rev-list --count <default>..HEAD` (LOCAL default ref — gap G7); `no_commits` when
   0; pushes `HEAD:refs/heads/<branch>` with the project PAT via askpass
   (`createGitHubAskpassEnv`); stderr redacted. Typed results, never throws:
   `pushed | up_to_date | no_pat | no_repo | no_workspace | no_branch | no_commits |
   push_failed | grant_withheld | task_not_found`. (**`up_to_date` is declared but
   never constructed** — see findings FC-1.)
3. **P11-12**: `grant_withheld` → `surfaceDeliveryEvent` "Delivery withheld by policy"
   (typed `github` timeline event, `system:delivery` actor, + `policy` watcher
   notification) and **returns** — no PR attempt, no misleading "no change" copy
   (`task-actions.server.ts:2651-2665`).
4. **P11-11**: `push_failed` / `no_pat` → surfaced as "Delivery push failed" ("any
   review PR may not reflect the newest commits"), then **still** attempts the PR (a
   prior push may carry earlier content) (`task-actions.server.ts:2667-2682`).
5. **P11-10**: on `pushed`, re-runs `reconcileWorkspaceDelivery` for the delivering
   engagement so the `workRevision` reflects the post-auto-commit HEAD — reviewer
   verdicts no longer bind to a pre-auto-commit sha (`task-actions.server.ts:2684-2718`).
   This closed pass-11 gap #1.
6. `openTaskPr` (§2.3). `ok` → done. `nothing_to_review` (422 empty diff) → "Review
   has no PR" event + notification, but **only when** the push didn't already explain
   why (`push.status !== push_failed/no_pat`, `task-actions.server.ts:2731-2751`).
   Other PR-open failures (`auth_failed`, `network_unavailable`) are **only logged**
   (2729) — see findings FC-4.

`surfaceDeliveryEvent` helper: `task-actions.server.ts:2766-2799`.

### 2.3 PR creation — API + token

`openTaskPr` (`app/server/github/pr-open.server.ts:117-254`). Uses the project-bound
PAT through `getProjectGithubContext` → `createGithubClient`. Behavior:

- **Idempotent twice over**: (0) a cached `fm.pr` with `state !== "closed"` is
  confirmed via `GET /pulls/{n}` and reused (`pr-open.server.ts:142-164`) — note this
  treats a cached **"merged"** PR as live and reuses it (findings FC-2); (1)
  `GET /pulls?head=owner:branch&state=open` reuses an open PR for the deterministic
  head (172-181); (2) otherwise `POST /repos/{repo}/pulls` with
  `title: "[KEY] <task title>"`, `head` = `fm.branch ?? taskBranchName(key)`, `base` =
  project default branch (199-206).
- PR body via `composePrBody` (`pr-open.server.ts:28-56`): Viberr task back-link
  (`taskUrl` from `BETTER_AUTH_URL`, 59-67), Goal, change summary (from the
  `github.changed` cache), evidence, human-authorized-merge footer.
- Failure mapping: 403 → `pull_request:write` scope violation (223-243); 422 →
  `nothing_to_review` (247-249); 401 → `auth_failed`; network →
  `network_unavailable`. Never fabricates a PR ref on failure.
- `writePrToTask` (`pr-open.server.ts:256-330`): cache vocabulary (open→`review`),
  preserves extra cached fields, H1 guard (never downgrades `accepted`/`merged` while
  GitHub says open), "Opened **PR #N** for review." event on creation, reprojects,
  audits `github.pr.opened` (audit fires on reuse too, with `created:false`).

### 2.4 `findPrForBranch` — terminal-PR matching rules

`app/server/github/pr-linker.server.ts:108-219`:

- Lists PRs `head=owner:branch, state=all, sort=created desc, per_page=5`, takes the
  newest; fetches detail (merged flag + add/del/changed_files) and a check-runs
  summary for the head sha (`passing` = success/neutral/skipped, `failing` =
  failure/timed_out/cancelled/action_required, else pending; 177-199).
- State mapping (`mapPrToCacheState`, `pr-linker.server.ts:25-33`): `merged||merged_at`
  → `merged`; `closed` → `closed`; anything else (**open + draft**) → `review`.
  Viberr-only fourth state `accepted` = human accepted, merge pending. Canonical enum:
  `PR_STATE_VALUES` (`app/schemas/task-file.schema.ts:226`, tolerant
  `.catch("review")` at 237). `PrFacts.draft` is captured (line 207) but **never
  persisted** into the `fm.pr` cache — draftness is re-read live only at merge time.
- **F26 terminal-PR rule** (`pr-linker.server.ts:156-175`): newest PR terminal (raw
  state `closed`) AND live branch head ≠ PR head sha → return `none` (a reused branch
  that advanced past its old PR must not link the stale PR). Fail-safe: unreadable
  branch ref (auto-deleted on merge) → link the terminal PR.
- 403/404 on the list → `forbidden` (reads are best-effort — only write failures open
  scope violations).
- `prPillFor` (37-51) is an exported duplicate of the UI's
  `github-pills.prStatePill` — dead outside tests (findings FC-9).

### 2.5 Reconcilers — now THREE triggers

**(a) Workspace reconciler** — `reconcileWorkspaceDelivery`
(`app/server/github/workspace-delivery.server.ts:198-552`). Runs after every finished
**delivering** run (`applyAgentCompletionEffects` step 2,
`task-actions.server.ts:1911-1941`; reviewers deliberately excluded — a reviewer's
clone is incidental) AND, new in P11-10, after a successful Review-boundary push
(`task-actions.server.ts:2689-2718`). Best-effort, never throws, idempotent:

1. Reads HEAD branch; valid only if non-empty, not detached, not the default branch
   (274-285).
2. Computes commits ahead of `origin/<default>` for the display cache
   (`fm.github.commits`), guarding shallow clones (deepen 50 first; skip on deepen
   failure rather than write a wrong cache) (299-324).
3. **Mints/refreshes the `workRevision`** (F10-15) — full `rev-parse HEAD` +
   `HEAD^{tree}`, via `nextWorkRevision` (same tree ⇒ keep revision + verdicts; new
   tree ⇒ new id ⇒ prior verdicts stale) and recomputes derived `validation`
   (326-383). **P11-72**: minting is now gated on `hasDeliveredWork` —
   `commits === []` (known-empty branch, HEAD at base tip) mints **nothing**, so a
   run that correctly delivered no change no longer flips validation to `changed` and
   opens an empty review; `commits === null` (couldn't enumerate history:
   shallow+offline) still mints, to never drop a real delivery (332-342).
4. Writes branch + caches idempotently; audits `github.workspace.branch_reconciled`
   only on real branch/commit change (revision-only stamps audit-silent) (367-430).
5. PR detection via the run's own `gh` CLI (`gh pr view <branch> --json
   number,state,title`, 432-449) — maps OPEN/CLOSED/MERGED to the cache vocabulary;
   H1 guard for `accepted`; closed-without-merge on an accepted PR adds the "pending
   merge can no longer be completed" `policy` note; audits
   `github.workspace.pr_linked` (450-526). Still a pre-F-GH3 leftover in practice
   (sandboxed runs have no `gh` auth) — harmless best-effort.

**(b) GitHub reconciler** — `reconcileTask` / `reconcileProject`
(`app/server/github/github-reconciler.server.ts:148-479`). Triggered by (i) the
**"Update status"** button (renamed from "Reconcile", P11-14) on
`/projects/:slug/github` (`app/routes/project.github.tsx:55-56`, RBAC
`reconcile-github` = admin|maintainer, `app/shared/rbac.ts:58`;
`app/features/github/github-actions.server.ts:35-55` `runReconcile`), and (ii) **the
background poller** (c). Per task with a branch:

- Branch compare via `GET /compare/{base}...{head}` (`getBranchCompare`,
  `branch-sync.server.ts:67-108`); PR facts via `findPrForBranch`; task-key-prefixed
  commit association (`taskCommits`, `branch-sync.server.ts:114-120`; empty prefixed
  list never wipes a non-empty workspace-captured cache,
  `github-reconciler.server.ts:236-245`). 403 on the compare →
  `repo` scope violation (180-201) — note a **rate-limit 403 also lands here**
  (findings FC-3b).
- Sync pill: `merged > behind_main > synced` (`deriveSyncState`,
  `branch-sync.server.ts:125-132`).
- **R8-6 divergence detection** (`github-reconciler.server.ts:254-367`): fires only on
  the *transition* into a terminal PR state while the task is not in its terminal
  stage — merged-but-not-Done → "accept the completion" `policy` event +
  `notifyTaskWatchers`; closed-but-active → "rework and reopen, or archive". On any
  divergence, pending `transition` recommendations are withdrawn;
  `accept_completion` recs are withdrawn only on close (they survive a merge —
  accepting is exactly right). Never auto-advances the stage.
- Per-task provenance row + `github.reconcile.task` audit on **every** observation
  (375-399, unconditional — findings FC-3a). `reconcileProject` (430-479) fans out
  `Promise.all` over every branched task (451-455) and records a project summary
  audit **unless** `ctx.skipProjectAudit` (468-477, added for the poller).

**(c) Background poller (NEW, P11-14)** —
`app/server/github/reconcile-poller.server.ts` (whole file, 125 lines):

- `RECONCILE_POLL_MS = 5 * 60_000` (line 21). `projectsToPoll` = active
  (non-archived) projects with ≥1 branched task (24-36).
- `pollGithubReconcile` (43-73): reconciles each such project with `SYSTEM_ACTOR` and
  `skipProjectAudit: true`; per-project failures are logged and never abort the
  others; logs an info summary only when something changed.
- `startGithubReconcilePoller` (94-114): HMR-safe global-symbol singleton; runs
  **once at boot** (catches out-of-band changes while the process was down — errors
  silently swallowed, line 97), then every 5 min; non-overlapping (`running` guard),
  unref'd, idempotent. `stopGithubReconcilePoller` (117-124) for tests/shutdown.
- Wired in `bootServer` (`app/server/boot.server.ts:192`), after the schedule runner.

This closes pass-11 gap #2 (divergence detection was manual-only): a PR merged/closed
directly on GitHub now surfaces within ~5 minutes without a human clicking anything.

**Divergence surfacing in UI**: still no dedicated banner — divergence reaches humans
as (1) the typed `policy` timeline event, (2) an inbox notification via
`notifyTaskWatchers` ("Policy engine" sender, `github-reconciler.server.ts:138-141`),
(3) the PR pill flip: `prStatePill` (`app/features/github/github-pills.ts:37-42`) —
`merged`=done, `review`=info "in review", `closed`=risk, `accepted`=input "merge
pending". Task detail shows "PR #N · merge pending" + **Complete merge** button for
`accepted` (`app/features/task-detail/task-detail-page.tsx:112,161-174` →
`completeTaskMerge` via `app/routes/project.task.tsx:256-258`). The GitHub view shows
a freshness chip ("Updated <ago>" / "Not yet synced", stale > 1h) fed by the newest
`github.reconcile` provenance row (`app/features/github/github-view.tsx:425-455`;
`app/features/github/github-query.server.ts:186+` — its comments still say "no
scheduled sync", stale, findings FC-8).

### 2.6 Merge — `mergeTaskPr`

`github-reconciler.server.ts:525-684`. The real merge behind acceptance:

- Pre-step F7-GH5: if the PR is a draft, un-draft via the GraphQL
  `markPullRequestReadyForReview` mutation (REST can't), best-effort (545-570).
  **P11-16**: the GraphQL endpoint is now derived from `GITHUB_API_BASE`
  (`` `${GITHUB_API_BASE}/graphql` ``, line 562) instead of a second hardcoded
  literal — the REST and GraphQL layers agree on the host. V1 is explicitly
  github.com-only (a GHE base would need `/api/graphql`, documented as a non-goal in
  the comment).
- `PUT /repos/{repo}/pulls/{n}/merge` (572-576). Success → `pr.state="merged"` +
  human-authored `github` event + provenance + `github.pr.merged` audit +
  auto-resolve of an open `pull_request:write` violation (578-629). Typed failures:
  405 `not_mergeable`, 409 `head_changed`, 403 → scope violation + audit
  `github.pr.merge_refused` (642-673), 404 `pr_not_found`, 401 `auth_failed`.

---

## 3. GitHub connection config

### 3.1 Where tokens live

`app/server/secrets/pat-store.server.ts` (unchanged since pass 11). User-provided
GitHub PATs, AES-256-GCM encrypted (`secret-box.server.ts`), SQLite `github_pats`
table. Only `getPatToken` (190-199) decrypts, server-side. Metadata readers return
masked `····<last4>`.

### 3.2 How a project binds to a repo

- **Repo**: `project.md` frontmatter `repo:` + `defaultBranch:`; task-level `repo:`
  **overrides** (`getProjectGithubContext` `repoOverride`,
  `app/server/github/github-context.server.ts:45-76`).
- **Credential**: `project_github_credentials` binds ONE stored PAT per project
  (`setProjectCredential`/`getProjectCredential`, `pat-store.server.ts:216-276`).
  Default required scopes `repo, workflow, read:org, pull_request:write`
  (`pat-store.server.ts:29-34`).

`getProjectGithubContext` returns typed gaps: `{status:"no_repo_configured"}` /
`{status:"no_pat_configured", repo}` — note `createGithubClient` is called **without a
baseUrl** (github-context.server.ts:66-70), so GHE support remains theoretical.

### 3.3 With no connection

Unchanged degraded contract: runs still start (unauthenticated clone for public
repos, else empty workspace); branch/PR/reconcile paths short-circuit typed; a
transition never fails on GitHub state; acceptance without reachable GitHub records
`pr.state="accepted"` (merge pending), never a false "merged". The poller inherits
the same short-circuit — and its **project-level** context check means a task-level
`repo:` override in a project with no project repo/PAT is never polled (findings
FC-6). Connection panel: `checkRepoAccess`
(`app/server/github/repo-access-check.server.ts:36-79`).

### 3.4 Rate limits / error handling

`createGithubClient` (`app/server/github/github-client.server.ts:106-199`):

- Bearer auth, `application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`,
  user-agent `viberr`; ETag/304 support; **exactly one retry, 5xx only** (149-151);
  typed `network`/`http` failures, never throws; token never logged.
- `rateLimit {limit, remaining, reset}` parsed on every response (80-92, 161) — still
  **no caller consumes it**, and no caller passes `etag` (repo-wide grep 2026-07-24:
  zero hits outside the client + tests). With the poller multiplying calls this is
  now a real hazard, not just dead capability (findings FC-3b).
- `x-oauth-scopes` + token-expiration headers feed the PAT validator
  (`app/server/secrets/pat-validator.server.ts`) → scope chips / credential health.
- 403-on-write ⇒ scope violations: `flagScopeViolation`
  (`app/server/github/scope-flag.server.ts:109-149`), idempotent row + typed `policy`
  event + watcher notification; `resolveScopeViolationWithEvent` (151+) closes it
  (auto-fired by a later successful merge). NOTE the module doc comment (33-36) still
  references "the seeded VIB-142 violation (migration 0005)" — **that migration no
  longer exists** (findings FC-7).
- `githubWebHost` (`github-client.server.ts:210-220`) derives browse hosts; its GHE
  branches remain effectively dead (no non-default baseUrl is ever wired) but the
  V1 github.com-only stance is now documented at the P11-16 call site.

---

## 4. Review model (revision-bound, F10-15)

All shapes in `app/schemas/task-file.schema.ts` (unchanged since pass 11 except a
comment).

### 4.1 `workRevision` minting

`workRevisionSchema` (`task-file.schema.ts:324-337`): `{id, headSha (full), treeSha,
branch, createdAt, sourceProfileId}`. Minted in exactly one function — the workspace
reconciler (`workspace-delivery.server.ts:326-365`) — but that function now runs at
**two moments**: delivering-run completion AND post-push at the Review boundary
(P11-10). `nextWorkRevision` (`task-file.schema.ts:475-503`): same tree ⇒
`changed:false` (verdicts survive, F10-32); different tree ⇒ new `rev_*` id ⇒ all
prior verdicts stale. P11-72 empty-branch gate: see §2.5(a).3.

### 4.2 Verdicts

`reviewVerdictSchema` (`task-file.schema.ts:342-355`): `{profileId, revisionId,
headSha, result: approve|request_changes, reason, at}` in frontmatter `verdicts[]`.
Recorded in `recordAgentCompletion` (`task-actions.server.ts:1410-1600`; binding at
1452-1477): bound to the **current** `workRevision.id`, last-write-wins per
`(profileId, revisionId)`, reason = first 2000 chars of the reply. Approve with no
revision → "Approval noted", never a pass (1483-1487). A non-healthy derived
validation drops any pending `accept_completion` recommendation (1497-1506).

Verdict **authority** resolution (`applyAgentCompletionEffects`,
`task-actions.server.ts:1650-1804`):

- The engagement's engage-time `verdictCapable` snapshot is authoritative when an
  engagement row exists (1719-1735); live-grant fallback only for legacy/ad-hoc runs.
- Envelope verdict first — Claude `report_outcome` staged outcome keyed by
  `outcomeKey`, **now persisted across restarts** in the `staged_outcomes` table
  (P11-28: `stageOutcome`/`takeStagedOutcome(db, key)`,
  `app/server/tasks/agent-outcome.server.ts:161-226`) — or Codex `outputSchema` JSON
  envelope (`parseAgentOutcomeJson`, 102+). A verdict-authorized agent with no
  envelope falls back to the prose classifier `classifyReviewerVerdict`
  (`task-actions.server.ts:1351-1408`); the regex never runs without authority (R1);
  no determinable verdict ⇒ validation left unchanged + loud warn (1762-1778).
- **P11-26 asymmetry (intentional)**: question authority uses the LIVE `ask-human`
  grant, not a snapshot — a question is open-only and never blocks acceptance
  (1780-1788).

### 4.3 `verdictCapable` — engage-time snapshot

Set on the engagement when engaged (`engagementSchema`, `task-file.schema.ts:94-108`):
`assignSpecialist` → `resolveAgentCollab(specialist.capabilities).verdict`
(`specialist-run.server.ts:269`); `assignReviewer` → same for the reviewer (382).
**P11-31**: `resolveAgentCollab(grants)` lost its vestigial `delivers` second arg
(`agent-outcome.server.ts:277-290`); `effectiveCollabMode` (254-275): verdict is
explicit-only (F10-14) — `report-validation-verdict: direct` required; catalog default
`off` (`app/shared/capabilities.ts:58`); a `recommend` grant deliberately falls
through to the default.

**Required reviewers** = supporting engagements with `verdictCapable:true`
(`requiredReviewers`, `task-file.schema.ts:408-410`). The deliverer is never required.

### 4.4 `deriveValidation` + `acceptanceBlockedReason`

- `deriveValidation` (`task-file.schema.ts:426-448`): `none` before any revision;
  `failing` if any required reviewer requests changes on the current revision;
  `healthy` when required reviewers exist and all approved; else `changed`.
  Recomputed on verdict recording (`task-actions.server.ts:1478`), revision minting
  (`workspace-delivery.server.ts:378`), and review-stage entry
  (`task-actions.server.ts:2495-2497` — never launders a standing `failing`).
- `acceptanceBlockedReason` (`task-file.schema.ts:450-473`) — the single acceptance
  gate (no revision + required reviewers → blocked; no revision + none required →
  acceptable; required `request_changes` → blocked; missing approvals → blocked).
  **P11-50**: also computed at projection-rebuild time into
  `task_projections.validation_block_reason`
  (`app/server/projections/rebuilder.server.ts:372,384,412`; column in
  `db/migrations/0001_baseline.sql:89`) and mapped to `TaskSummary.blockReason`
  (`app/shared/mapping/task.server.ts:108-115,241`), so loader-path read models no
  longer re-read task files.
- Consumed by: `acceptCompletion` (`task-actions.server.ts:3295-3298`, `force`
  bypass), the `accept_completion` packet option (3011-3018, **no** force), and the
  review queue (§4.6).

### 4.5 Accept-completion flow + RBAC

`acceptCompletion` (**module-private**, `task-actions.server.ts:3272-3380`), reached
via: (a) human `transitionStage` into the terminal stage (auto-routed, 2402-2419);
(b) the `accept_completion` packet option in `resolvePacket` (3001-3058 — inline
re-implementation, not a call); (c) `applyRecommendation` of an operator
`accept_completion` card (3518).

- **RBAC**: `requireAcceptCompletion` (`task-actions.server.ts:312-330`) =
  `accept-completion` action (admin|maintainer, `app/shared/rbac.ts:54`) OR the
  task-owner exception (R6-2, `ownerException` at 298 — requires live contributor+).
- Gates: `acceptanceBlockedReason` (unless `force`), and an open operator `blocked`
  packet refuses acceptance (3300-3314). **The `force` override has ZERO callers**
  — neither internal call site (2412, 3518) nor any route passes it (findings FC-5).
- Effects: real merge attempt (`mergeTaskPrIfPossible` at 2808 → `mergeTaskPr`);
  stage=terminal, readiness=ready, waiting=none, validation=healthy, `pr.state` =
  `merged` (real) or `accepted` (merge pending); packet + transition/accept recs
  cleared; honest `completion` event copy; `task.transition` audit via
  `accept_completion` (3338-3379).
- **Complete merge** (`completeTaskMerge`, `task-actions.server.ts:3383-3448`):
  same RBAC, requires `pr.state === "accepted"`, calls `mergeTaskPr`, typed user
  messages per failure.

### 4.6 Review queue — `/projects/:slug/review`

Route: `app/routes/project.review.tsx` (membership guarded before the 404, lines
24-28). Read model: `getReviewQueue`
(`app/server/projections/review-queue.server.ts:59-146`):

- Qualification: stage == `resolveStageRoles().reviewId` (never the literal id).
- **P11-50**: `blockReason` now comes from the projection row (`t.blockReason`, line
  101) — the per-task frontmatter re-read on the loader path is gone.
- Panel split (R8-3, viewer-scoped): "Waiting on your acceptance" iff
  `waiting === "human"` AND viewer can accept (maintainer+ via `resolve-packet`, or
  owner with `own-task`) AND `blockReason === null` (121-140). Read-only; SSE
  revalidation; ordering task-key ASC.

---

## 5. Stage / transition model

Stages per-project (`project.md` `stages:`/`workflow:`), roles derived
(`app/shared/workflow/stage-roles.ts:25-78`, unchanged).

`transitionStage` (`task-actions.server.ts:2338-2587`) — who can move what
(unchanged gates): auto boundary → any member (UI always sends manual);
approval boundary → `approve-transition`; human boundary → `requireAcceptCompletion`;
`manual:true` → `approve-transition` (2431-2434); operator → capability-gated
upstream, **never** a bare move into the terminal stage (2426-2430), rework only
backward-on-failing (2382-2397); human → terminal auto-routes into `acceptCompletion`
(2402-2419).

**Changed in P11-70 — operator re-trigger on EVERY transition.** The old rule
(operator-authored transitions don't re-invoke the operator) stranded tasks: a drive
that advanced one auto boundary and stopped left the task waiting at a pre-work
stage. Now ANY move onto a new non-Done stage re-invokes the operator
(`task-actions.server.ts:2528-2573`), including the operator's own moves.
Runaway protection: consecutive operator-authored transitions thread
`ctx.operatorRun.transitionDepth` (`nextTransitionChainDepth`, 107-109; human
actions reset to 0) and `OPERATOR_TRANSITION_CHAIN_CAP = 8` (103) turns a loop into
an `openStuckLoopPacket` escalation (2547-2562) instead of unbounded LLM spend.
`runOperator` holds a process-level single-flight lease per task and queues a
mid-run trigger (newest wins), firing it on release
(`app/server/runtimes/operator-run.server.ts:117-200`).

Side effects on transition (unchanged otherwise): review entry recomputes derived
validation; leaving entry attaches operator + clears triage `input_required`;
pending `transition` recs dropped; review entry fires the push+PR spine (§2.2).

**Run orchestration context**: one live delivering run per task
(`specialist-run.server.ts:528-546`); every start path registers ONE completion
pipeline (`registerAgentCompletion`, `task-actions.server.ts:1603`; resume path at
957) whose effects are reply/verdict/question atomic write → workspace reconcile
(delivers only, 1911-1941) → operator react loop (depth-capped) → waiting flip. Boot
recovery replays effects for runs that finished while the server was down
(`recoverUnreactedAgentRuns`, wired `app/server/boot.server.ts:176`). Boot also
starts the reconcile poller (192) and the export-link probe uses `transcriptExists`
— a **filename-only, 30s-TTL, 500-entry cached** existence check
(`app/server/runtimes/session-export.server.ts:158-190`) consumed by the run
projection's `exportable` flag (`app/server/runtimes/run-projection.server.ts:151-156`);
`locateTranscript` (heavy, content-scan fallback) never runs on loader paths
(P11-43 + round-2 fix 63cfe53).

---

## Delta since pass 11 (04821fe → 0981cfa)

33 commits; delivery-relevant changes all landed via PR #87 (`pass11/product-fixes`,
incl. round-2 63cfe53) and PR #90 (clean-sheet seed):

1. **P11-14 — background PR-status poller** (582fd63): new
   `app/server/github/reconcile-poller.server.ts` (5-min interval + boot pass,
   HMR-safe singleton, non-overlapping, unref'd), `skipProjectAudit` on
   `GithubActionContext`, boot wiring (`boot.server.ts:192`), UI rename Reconcile →
   **"Update status"** + freshness copy (`github-view.tsx:425-455`,
   `github-copy.ts:12-14`). Pass-11 gap #2 (divergence manual-only) **closed**.
2. **P11-10** — post-push `reconcileWorkspaceDelivery` re-mint at the Review
   boundary (`task-actions.server.ts:2684-2718`). Pass-11 gap #1 (verdicts bind to
   pre-auto-commit sha) **closed**.
3. **P11-11 / P11-12** — `push_failed`/`no_pat` and `grant_withheld` are surfaced as
   typed timeline events + watcher notifications via `surfaceDeliveryEvent`;
   `grant_withheld` short-circuits before the PR attempt; the "no change" 422 copy is
   suppressed when the push already explained the failure
   (`task-actions.server.ts:2651-2751`). Pass-11 gaps #9/#10 **closed**.
4. **P11-13** — push-grant resolution extracted as exported
   `resolveDeliveryPushGrant` (`task-actions.server.ts:2598-2619`) with the fallback
   **inverted to conservative deny** for a named-but-unresolvable deliverer; new
   direct unit tests (`delivery-push-grant.server.test.ts`). Pass-11 gap #5 **closed**.
5. **P11-16** — un-draft GraphQL call now uses `${GITHUB_API_BASE}/graphql`
   (`github-reconciler.server.ts:557-562`). Pass-11 gap #3 host-mismatch **closed**
   (GHE remains an explicit V1 non-goal).
6. **P11-72** — `workRevision` minted only when the branch carries commits
   (`workspace-delivery.server.ts:332-342`): an empty delivery no longer opens a
   review over an empty diff.
7. **P11-50** — `acceptanceBlockedReason` projected to
   `task_projections.validation_block_reason` at rebuild (`rebuilder.server.ts:412`);
   review queue reads the projection (`review-queue.server.ts:72-77,101`);
   `TaskSummary.blockReason` added (`mapping/task.server.ts:108-115`).
8. **P11-70** — every stage transition re-invokes the operator (operator's own moves
   included), with `OPERATOR_TRANSITION_CHAIN_CAP = 8` + stuck-loop packet
   (`task-actions.server.ts:103-109, 2528-2573`) and an operator-run lease/trigger
   queue (`operator-run.server.ts:117-200`).
9. **P11-28** — staged Claude outcomes persist in the `staged_outcomes` table
   (`agent-outcome.server.ts:161-226`); `takeStagedOutcome` now takes `db`.
10. **P11-31** — `resolveAgentCollab` dropped the vestigial `delivers` param
    (`agent-outcome.server.ts:277-290`); engage-time snapshots updated at call sites
    (`specialist-run.server.ts:269,382`).
11. **P11-26** — documented intentional live-grant asymmetry for question authority
    (`task-actions.server.ts:1780-1788`).
12. **P11-43 + 63cfe53 (round 2)** — Export link gated on `transcriptExists`, a
    filename-only 30s-cached probe; `locateTranscript` off loader paths
    (`session-export.server.ts:156-190`, `run-projection.server.ts:151-156`).
13. **P11-71** — `resolvePacket` accepts an optional human `note`, blockquoted into
    the decision event (`task-actions.server.ts:2943-2946,3177-3186`).
14. **Clean-sheet seed** (e306248/625eb71): product seed carries **zero demo data**;
    migrations squashed to `db/migrations/0001_baseline.sql` (schema only,
    `validation_block_reason` at line 89); the old 0005-seeded VIB-142 scope
    violation now exists ONLY in the e2e fixture (`test-support/demo-seed.ts:236-247`).
    Pass-11 gap #12 (seeded-violation coupling) now applies only to fixture-seeded
    test DBs, not to any product database.
15. Doc-comment cleanups: "(mock data contract)" removed from
    `branch-sync.server.ts` `taskCommits`; the schema's "(future) Phase-7 reconciler"
    comment de-futured. Pass-11 gap #7 note **closed**.

Pass-11 gaps still open, renumbered here: G6 = workspace `gh pr view` leftover
(§2.5(a).5); G7 = reused workspace never fetched + push counts vs LOCAL default
branch (`push-workspace.server.ts:266-273`; the workspace reconciler uses
`origin/<default>` + deepen, the push does not); G8 = rate-limit/ETag parsed but
unconsumed (escalated — see FC-3b); G9 = force asymmetry (escalated — FC-5).

---

## Findings candidates (pass 12)

Verified against source 2026-07-24; each cites the exact evidence.

**FC-1 (dead code) — `up_to_date` push result is unreachable.**
`PushWorkspaceResult` declares `up_to_date` (`app/server/github/push-workspace.server.ts:39`)
and the caller checks for it (`task-actions.server.ts:2644`), but no code path
constructs it: the function returns `pushed` (301) whenever `localAhead > 0` and the
push exits 0 — including a push of an already-up-to-date branch (git exits 0). Net
effect: every re-entry into Review with existing commits reports `pushed` and runs
the P11-10 re-reconcile (idempotent, so harmless), and the declared/documented
`up_to_date` contract is dead.

**FC-2 (bug, delivery dead-end) — `openTaskPr` resurrects a MERGED cached PR instead
of opening a fresh one for new work.** The cached-PR fast path reuses `fm.pr` whenever
`fm.pr.state !== "closed"` (`app/server/github/pr-open.server.ts:142`) — which
includes `"merged"`. Scenario: PR merged out-of-band → poller flips the cache to
`merged` + divergence event says "rework"; a developer delivers new commits on the
same branch; the task re-enters Review → `openTaskPr` step 0 confirms the OLD merged
PR via `GET /pulls/{n}` (147), `writePrToTask`'s H1 guard keeps `merged` (274-279),
and the function returns `ok, created:false` — **no PR ever opens for the new
revision**, and a later acceptance's `mergeTaskPr` on the already-merged PR 405s into
"accepted, merge pending" forever. The F26 stale-terminal rule protects only the
`findPrForBranch` path (`pr-linker.server.ts:156-175`), not this fast path. Fix
shape: treat `merged` like `closed` in the step-0 condition (or apply the F26
head-sha comparison there too).

**FC-3a (unbounded growth) — the poller writes per-task audit + provenance rows every
5 minutes.** `skipProjectAudit` suppresses only the project summary audit
(`github-reconciler.server.ts:468-477`); the per-task `github.reconcile.task` audit
(391-399) and the provenance row (375-390) fire **unconditionally per branched task
per observation** — ~288 rows/day/task each under the poller. Audit rows are pruned
only after 90 days at boot (`app/server/db/retention.server.ts:23,47-50`);
**provenance has no retention at all** (retention touches only `run_log_lines`,
`audit_events`, `notifications`). A long-lived deployment with a handful of branched
tasks accumulates hundreds of thousands of rows. Fix shape: gate the per-task audit
on `changed` (provenance arguably too, or add it to retention).

**FC-3b (correctness hazard) — a rate-limited 403 opens a bogus `repo` scope
violation, and the poller makes it likely.** GitHub returns 403 for both missing
scopes AND rate-limit exhaustion; `getBranchCompare` maps any 403 → `forbidden`
(`branch-sync.server.ts:101-103`) and `reconcileTask` responds by flagging a `repo`
scope violation + policy event + watcher notification (`github-reconciler.server.ts:180-201`).
The poller (`reconcile-poller.server.ts:21`) issues 2-4 REST calls per branched task
per 5 min via `Promise.all` bursts (`github-reconciler.server.ts:451-455`) with the
parsed `rateLimit` info never consulted (`github-client.server.ts:80-92,161` — zero
consumers repo-wide). A busy PAT that trips the limit gets false "missing scope"
violations broadcast to watchers. Fix shape: sniff GitHub's rate-limit 403 message /
`x-ratelimit-remaining: 0` before flagging, and/or make the poller budget-aware.

**FC-4 (silent stall) — PR-open `auth_failed` / `network_unavailable` at the Review
boundary is only a log line.** P11-11/12 surfaced push-side failures, but when the
push succeeds and `openTaskPr` then fails with 401 or a network error, the only
trace is `logger.info("review PR not opened")` (`task-actions.server.ts:2729`); the
`nothing_to_review` surfacing (2736-2751) covers only the 422 case, and a 403 at
least flags a scope violation. The task sits in Review with no PR and no
timeline/notification signal, and nothing retries (the poller reconciles existing
PRs; it never opens one). Fix shape: extend `surfaceDeliveryEvent` to the
`auth_failed`/`network_unavailable` results of `openTaskPr`.

**FC-5 (dead code / missing product affordance) — the `force` acceptance override
has zero callers.** `acceptCompletion` is module-private with `force?: boolean`
(`task-actions.server.ts:3272-3274`); its two call sites (2412, 3518) and the packet
path (3001-3058, inline) never pass it; repo-wide grep finds no route/UI setting it.
Consequence: a task whose required reviewer can never record a verdict (e.g. backend
quota-exhausted reviewer profile, or a reviewer engagement added by mistake) is
**permanently un-acceptable** — there is no human override anywhere. (Pass-11 gap #11
claimed "the task route's accept intent" sets force; that is not true on current
main.) Either wire a maintainer-visible force path or delete the parameter.

**FC-6 (config blind spot) — the poller (and Update-status button) never reconcile a
task-level `repo:` override in a project with no project-level repo/PAT.**
`projectsToPoll` selects on branched tasks (`reconcile-poller.server.ts:24-36`), but
`reconcileProject` short-circuits on the PROJECT context
(`github-reconciler.server.ts:436-441`) before ever reaching `reconcileTask`, which
does support `repoOverride` (161-164). Divergence detection silently never runs for
such tasks. LOW (unusual config), but the degradation is invisible.

**FC-7 (stale doc comment) — `scope-flag.server.ts:33-36` references "the seeded
VIB-142 violation (migration 0005)".** Migration 0005 no longer exists: migrations
are squashed to `db/migrations/0001_baseline.sql` (schema only — its own header line
8 notes "zero demo data"), and the VIB-142 violation is seeded only by the e2e
fixture (`test-support/demo-seed.ts:236-247`). Product databases have a clean
violations table; the comment misleads implementers about production state.

**FC-8 (stale comments + near-dead styling) — `github-query.server.ts` still
documents the pre-poller world.** Lines 67 ("last manual reconcile") and 186-188
("there is no scheduled sync") contradict P11-14. Also, the `stale` freshness flag
(> 1h since newest `github.reconcile` provenance) is now effectively unreachable
while the poller is healthy — it fires only when GitHub/config is broken for an
hour, which is fine but no longer what the comments/tooltip describe (the tooltip in
`github-view.tsx:433-437` was updated; the query-layer comments were not).

**FC-9 (dead duplicate) — `prPillFor` in `pr-linker.server.ts:37-51` has no
non-test importer.** The UI renders PR pills exclusively via
`app/features/github/github-pills.ts:37-42` (`prStatePill`). Two hand-synced copies
of the same mapping ("keep the two in lockstep" per its own comment) with one of
them dead is a drift trap — delete `prPillFor` or make one delegate to the other.

**FC-10 (docs/behavior nuance, pre-existing but re-verified) — PR-state coverage.**
All GitHub PR states are handled somewhere: open→`review`, draft→`review`
(`pr-linker.server.ts:32` — draftness is deliberately invisible in the cache; the
merge path re-reads it live and un-drafts, `github-reconciler.server.ts:545-570`),
merged→`merged` + divergence when not Done, closed-unmerged→`closed` + divergence
when active, reopened→flips back to `review` on the next poll, accepted (Viberr-only)
protected by H1 guards in all three writers (`pr-open.server.ts:271-279`,
`workspace-delivery.server.ts:462-472`, `github-reconciler.server.ts:218-225`). The
one genuinely unhandled combination is FC-2's merged-then-reworked-branch.

**FC-11 (minor inconsistency) — the poller's boot pass swallows errors silently.**
`startGithubReconcilePoller` boot invocation uses `.catch(() => {})`
(`reconcile-poller.server.ts:97`) while the interval tick logs failures (102-107).
A misconfigured PAT at boot produces zero signal until the first 5-min tick.
