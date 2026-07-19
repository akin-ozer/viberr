# Delivery + GitHub integration — pass 9 discovery

Scope: `app/server/github/**` and the delivery paths in `app/server/runtimes/**`
+ `app/server/tasks/**` that create the task-key branch, have the agent commit,
push the branch, open the review PR, reconcile, and merge. Branch `main`,
HEAD `61adab1` (delivery fix `0d12bb6` is in).

Verdict up front: the `0d12bb6` auto-commit fix closes the VIB-1 "no commits"
class **only for agents that were on a real task branch** (checked out
`git checkout -B <branch>`). It is **still reachable** for profiles whose
repo-write grant is withheld (`canBranch=false`) — they are never told to make
the branch, so HEAD stays on the default branch and the auto-commit path bails
out with `no_branch` before committing anything. Details in §1 and §4.

---

## 1. Delivery flow (agent run → branch → commit → push → PR)

### 1.1 Clone + branch naming (run start)

`startSpecialistRun` (`app/server/tasks/specialist-run.server.ts`) clones the
repo best-effort into `<taskDir>/workspace/<repoName>`:

- `cloneRepo` — `specialist-run.server.ts:1364`. Uses `createGitHubClonePlan`
  which runs `git clone --depth 1 <url> <dest>`
  (`app/server/tasks/git-clone-auth.server.ts:149`). Token supplied only via
  `GIT_ASKPASS` env, never argv/URL (`:110`–`160`). Clone failure → `null`,
  run falls back to the bare workspace root and the agent is told to clone
  itself (`specialist-run.server.ts:673`–`693`).
- The delivery target branch is resolved as
  `existing.frontmatter.branch ?? taskBranchName(taskKey)`
  (`specialist-run.server.ts:713`). `taskBranchName` = the lowercased key,
  nothing else (`app/server/github/branch-sync.server.ts:38`).
- **Important:** the clone checks out the repo default branch (`main`).
  There is **no server-side `git checkout -B <task-branch>`.** The task branch
  is created only if the *agent* runs it, per the prompt below.

### 1.2 Agent prompt = the delivery contract

`buildAnalyzePrompt` (`specialist-run.server.ts:1017`) tailors the git
instructions to the profile's capability grants
(`resolveDeliveryPermissions`, `app/server/tasks/specialist-tool-policy.ts:110`):

- `canBranch` (requires `execute-code-or-write-repo` **and**
  `create-task-branch`, `:124`) → prompt says
  `git checkout -B <branch>` (`specialist-run.server.ts:1050`).
- `canCommitPush` (requires `execute-code-or-write-repo` **and**
  `commit-push-branch`, `:125`) → prompt says commit locally with `[KEY]`
  prefix, **never push, never open a PR** (`:1058`–`1060`).
- **Neither grant** → an explicit prohibition: "do NOT run `git commit` /
  `git push` … Make the changes in the workspace and report what you changed;
  the governed Review transition (or a human) delivers them"
  (`:1066`). Crucially this branch **omits the `git checkout -B`
  instruction**, so such an agent works on the default branch.

The agent never pushes. Delivery is server-side for BOTH backends by design
(`specialist-run.server.ts:699`–`701`, `1339`–`1342`): the GIT_ASKPASS push
credential lives only in the server, never in the agent's tool shell.

### 1.3 Post-run reconcile (records what the agent actually did)

On run finish (`onSpecialistRunFinished`, `task-actions.server.ts:2156`–`2170`),
for a REAL primary/delivering run only, `reconcileWorkspaceDelivery`
(`app/server/github/workspace-delivery.server.ts:196`) inspects the workspace
git repo and writes the real branch + `[KEY]`-prefixed commits + (best-effort
`gh`) PR into the task.md cache. It never pushes and never throws
(`workspace-delivery.server.ts:224`, `480`). Reviewers are excluded (their
checkout is incidental).

### 1.4 The push + PR open (Review transition) — where `0d12bb6` lives

Entering the Review stage fires `openReviewPrBestEffort`, fire-and-forget
(`task-actions.server.ts:2848`–`2851`, body `2867`):

1. `pushWorkspaceBranch` (`app/server/github/push-workspace.server.ts:113`).
2. `openTaskPr` (`app/server/github/pr-open.server.ts:117`).
3. If `openTaskPr` returns `nothing_to_review`, surface a timeline event +
   notify supervisors (`task-actions.server.ts:2902`–`2936`).

**The `0d12bb6` auto-commit is `push-workspace.server.ts:160`–`212`:**

- Resolve `repoDir` via the same workspace conventions as the reconciler
  (`findRepoDir`, `:79`–`95`).
- `git rev-parse --abbrev-ref HEAD` → `branch`. If empty, `HEAD` (detached),
  **or equal to the default branch**, return `no_branch` and stop —
  **before the auto-commit** (`:150`–`158`).
- Only past that guard: `git status --porcelain`; if dirty →
  `git add -A` (`:177`) then `git commit` with inline identity
  `user.name=Viberr Delivery` / `delivery@viberr.local` and message
  `[<taskKey>] deliver working-tree changes from the agent run`
  (`:183`–`200`).
- Count `git rev-list --count <defaultBranch>..HEAD`; `0` → `no_commits`
  (`:215`–`223`).
- Fetch project PAT (`getProjectCredential`/`getPatToken`); none → `no_pat`
  (`:225`–`227`).
- Push non-force `git push origin HEAD:refs/heads/<branch>` under a short-lived
  askpass env (`:231`–`243`). Non-zero → `push_failed` (stderr redacted).

Then `openTaskPr` (`pr-open.server.ts`): reuse a cached live PR (`:142`), reuse
an open PR for the head branch (`:172`), else `POST /repos/{repo}/pulls`
(`:199`). A `422` maps to `nothing_to_review` (`:247`), `403` opens a
`pull_request:write` scope violation (`:223`).

### 1.5 Robustness of the auto-commit fix

| Case | Behavior | OK? |
|---|---|---|
| Empty working tree | `status` empty → skip commit → `rev-list`=0 → `no_commits` | yes |
| Detached HEAD | `rev-parse` returns `HEAD` → `no_branch`, no commit | yes (won't commit) |
| Dirty index / partial stage | `git add -A` restages everything, commit captures all | yes |
| Agent on task branch, uncommitted | auto-commit fires → push | **yes — this is the fix** |
| **Agent on the DEFAULT branch, uncommitted** | `branch===defaultBranch` → `no_branch`, **auto-commit never runs, changes abandoned** | **NO — VIB-1 class still reachable** |

See §4 for the last row (the remaining hole) and the `git add -A`
unintended-files risk.

---

## 2. GitHub client — real vs stubbed

**All GitHub calls are REAL** (`fetch` against `api.github.com`). Nothing in the
product is a stub; tests inject fakes at the transport boundary.

- `createGithubClient` (`app/server/github/github-client.server.ts:111`): Bearer
  token, `application/vnd.github+json`, `x-github-api-version: 2022-11-28`,
  ETag support, rate-limit surfaced, **exactly one retry on 5xx**
  (`:154`–`157`), network/HTTP failures returned as typed values (never
  throws). `fetchImpl` injection is the test seam (`:65`, `112`).
- **Token storage (encrypted):** `pat-store.server.ts` — PATs stored
  `encrypted_token` via `sealSecret` (AES-256-GCM, `secret-box.server.ts:48`,
  key `VIBERR_SECRET_ENCRYPTION_KEY`). Only `getPatToken`
  (`pat-store.server.ts:204`) decrypts, server-internal; metadata readers only
  ever expose the last-4 suffix (`:63`–`74`).
- **Context resolver:** `getProjectGithubContext`
  (`github-context.server.ts:45`) turns missing repo / missing PAT into typed
  `no_repo_configured` / `no_pat_configured` instead of throwing.
- **Validation:** `validatePatToken` (`app/server/secrets/pat-validator.server.ts`)
  — classic `ghp_` tokens authoritative via `x-oauth-scopes` header; fine-grained
  `github_pat_` tokens probed via `/user`, `/repos/{r}`, `/user/orgs`,
  `/repos/{r}/pulls`, with write permission **assumed** (no safe write-probe
  exists, `:27`–`42`). `checkRepoAccess` (`repo-access-check.server.ts:35`)
  is the connection fact for the UI.
- **API calls (all real):**
  - Branch create/confirm: `ensureTaskBranch` — `GET/POST /repos/{r}/git/ref[s]`
    (`branch-sync.server.ts:167`, `191`, `225`); idempotent, `422 already
    exists` = success (`:236`).
  - Compare (ahead/behind): `GET /repos/{r}/compare/{base}...{head}`
    (`branch-sync.server.ts:67`).
  - PR create/list: `pr-open.server.ts:172`, `199`.
  - PR status + checks: `findPrForBranch` — `GET /repos/{r}/pulls` + detail +
    `GET /commits/{sha}/check-runs` (`pr-linker.server.ts:108`).
  - Merge: `PUT /repos/{r}/pulls/{n}/merge` + un-draft GraphQL
    (`github-reconciler.server.ts:517`).
- **Simulated GitHub for tests?** No standalone/simulated GitHub server. Tests
  inject a fake `fetchImpl` (client/reconciler/pr-open/pr-linker/branch-sync
  `*.test.ts`) or a fake `exec` (workspace-delivery/push-workspace tests). The
  `simulated-runtime.server.ts` under `runtimes/` is an AGENT-run simulator, not
  GitHub, and `reconcileWorkspaceDelivery`/`pushWorkspaceBranch` skip simulated
  runs entirely (`workspace-delivery.server.ts:225`, run gate
  `task-actions.server.ts:2156`).

---

## 3. Reconcile

- **Explicit action only.** `reconcileProject` / `reconcileTask`
  (`github-reconciler.server.ts:424` / `142`) are wired to the GitHub view's
  Reconcile button (`app/features/github/github-actions.server.ts:34`–`41`,
  route `app/routes/project.github.tsx`). Confirmed **no scheduled/cron/interval
  reconcile** — the only `reconcileProject` in `file-watch.service.server.ts:130`
  is a *file-store↔DB* rebuild (reprojects removed dirs), not the GitHub
  reconciler.
- `reconcileTask` refreshes compare (sync pill), PR state/checks, `[KEY]`
  commits, change stats into the task.md `pr`/`github` cache; idempotent
  (no write when unchanged); records a provenance row every time
  (`:369`). Empty `[KEY]`-commit filter does **not** wipe a non-empty cache
  captured from the workspace (`:234`–`239`).
- Two other reconcile touch-points: `reconcileWorkspaceDelivery` after each real
  run (§1.3), and `openTaskPr`'s inline reconcile of an already-cached PR
  (`pr-open.server.ts:142`).

---

## 4. Failure handling

- **No credential.** `getProjectGithubContext` → `no_pat_configured` short-
  circuits every service; `pushWorkspaceBranch` → `no_pat`
  (`push-workspace.server.ts:227`); credential health reports an honest `none`
  (never a seeded green lie) (`pat-store.server.ts:409`–`442`).
- **No commits.** `pushWorkspaceBranch` → `no_commits`; `openTaskPr` `422` →
  `nothing_to_review` → timeline event + supervisor notification
  (`task-actions.server.ts:2902`). **See the VIB-1 verdict below — this is only
  fully honest when the branch was actually checked out.**
- **Merge conflict / not mergeable.** `mergeTaskPr` maps `405 →
  not_mergeable`, `409 → head_changed` (`github-reconciler.server.ts:623`–`627`);
  task stays "accepted" (merge pending), no false merge.
- **Divergence (out-of-band GitHub action).** `reconcileTask` R8-6
  (`github-reconciler.server.ts:250`–`361`): a PR merged/closed directly on
  GitHub emits a typed `policy` timeline event + notifies supervisors, withdraws
  now-moot recommendations, and **never auto-advances the stage** (files stay
  canonical). An accepted→closed-without-merge drops the Complete-merge path with
  an explanatory policy note (`:437`–`447` in workspace-delivery, `:309`–`318` in
  reconciler).

### VIB-1 "no commits" — is the class still reachable?

**Partially closed, still reachable.** Two sub-cases of "agent wrote files but
did not commit":

1. **Agent on the task branch** (`canBranch=true`, whether or not
   `canCommitPush`): the prompt told it `git checkout -B <branch>`, so HEAD is on
   the task branch. `pushWorkspaceBranch` auto-commits the dirty tree and pushes.
   **FIXED by `0d12bb6`.** This is the exact case the fix's own comment cites
   ("a Codex run wrote files but read its workspace contract as prohibiting
   commit", `push-workspace.server.ts:161`–`170`).

2. **Agent on the default branch** (`canBranch=false` — repo-write grant
   withheld): the prompt **never** told it to make a branch, so after a plain
   clone HEAD is still `main`. At Review, `pushWorkspaceBranch` hits the
   `branch === defaultBranch` guard (`:156`) and returns `no_branch`
   **before** the auto-commit. The uncommitted changes are abandoned; the
   remote task branch (created empty by the operator's `ensureTaskBranch`) has no
   diff; `openTaskPr` → `422` → `nothing_to_review`. **This reproduces the VIB-1
   symptom.** The design intent (prompt line 1066: "the governed Review
   transition delivers them to the branch/PR") is **not honored** by the push
   path for this profile class.

The same hole applies to any agent that ignores the `git checkout -B`
instruction (the prompt is guidance, not enforcement), leaving edits on the
default branch.

### Could the auto-commit commit unintended files?

**Yes.** The commit is `git add -A` over the whole working tree
(`push-workspace.server.ts:177`) with no path filter and no `.gitignore`
guarantee. Anything the agent left in the per-task clone dir — build artifacts,
installed deps not ignored, scratch/log files, or a stray `.env`/credential file
the agent wrote — is staged and lands in the review PR under Viberr's own
committer identity. The workspace is reused across runs
(`specialist-run.server.ts:1379`), so leftovers from a prior run can accumulate
into the commit too.

---

## 5. PR merge — how Viberr merges and how it flows back

- **Viberr merges via the real REST API**, not `gh`/UI: `mergeTaskPr`
  (`github-reconciler.server.ts:517`) does `PUT /repos/{r}/pulls/{n}/merge`
  (`:559`). It first un-drafts a draft PR via the GraphQL
  `markPullRequestReadyForReview` mutation, since REST can't clear `draft`
  (`:543`–`557`).
- **On success** (`:565`–`616`): task.md `pr.state → "merged"`, a human-authored
  `github` timeline event ("Merged **PR #N** into `main`."), reprojection,
  provenance + audit, and any open `pull_request:write` violation for the task is
  resolved (the write is the proof).
- **Trigger paths into the task:**
  - `accept_completion` (Review→Done) calls `mergeTaskPrIfPossible`
    (`task-actions.server.ts:2952`, invoked at `3176` and the operator/human
    accept at `3478`). If the real merge runs, event says "…and the review PR
    was merged" and `pr.state=merged`; if it can't (no GitHub/PAT, not
    mergeable), it records `pr.state="accepted"` = **merge pending**, never a
    false merge (`:3197`–`3206`).
  - A dedicated **Complete merge** action for an accepted/merge-pending PR
    (`task-actions.server.ts:3555`–`3600`) retries `mergeTaskPr`, rendering
    typed failures (`not_mergeable`, `scope_violation`, etc.).
- `mergeTaskPr` deliberately does **not** transition the stage itself — stage
  orchestration stays with the accept action (`github-reconciler.server.ts:54`).

---

## Mocks / gaps / bugs

- **[BUG] VIB-1 "no commits" class still reachable for `canBranch=false`
  profiles.** `pushWorkspaceBranch` only auto-commits once HEAD is confirmed on a
  task branch (`push-workspace.server.ts:156`). Agents with the repo-write grant
  withheld are never told to `git checkout -B` (`specialist-run.server.ts:1061`–
  `1066`), so they leave edits uncommitted on the default branch; delivery then
  returns `no_branch` and abandons the work, ending exactly at VIB-1's "delivery
  produced no commits, no PR to review." The prompt promises the Review
  transition will deliver those changes (`:1066`) but the push path does not.
  Risk: HIGH — silent lost deliverables for an entire profile class.

- **[BUG/POOR] Auto-commit stages the entire dirty tree (`git add -A`) with no
  path filter or ignore guarantee** (`push-workspace.server.ts:177`). Build
  artifacts, unignored deps, scratch files, or a stray secret the agent wrote get
  committed into the review PR under `Viberr Delivery <delivery@viberr.local>`.
  Workspace reuse across runs (`specialist-run.server.ts:1379`) compounds it.
  Risk: MEDIUM-HIGH — unintended/secret files in PRs, noisy diffs.

- **[POOR] Review-stage delivery is fire-and-forget and mostly log-only.**
  `openReviewPrBestEffort` is invoked with `void`
  (`task-actions.server.ts:2850`); `pushWorkspaceBranch` failures (`push_failed`,
  `no_pat`) are only logged (`:2882`), and `openTaskPr` `push_failed` /
  `network_unavailable` are only logged (`:2897`). Only `nothing_to_review` and
  `scope_violation` reach the timeline. A push rejected for non-fast-forward
  divergence (there IS a diff, so no `nothing_to_review`) leaves Review with a
  stale/empty PR and no user-visible signal. Risk: MEDIUM — invisible delivery
  failures at the Review boundary.

- **[POOR] No server-side branch checkout; branch creation depends on the agent
  obeying the prompt.** The clone leaves HEAD on the default branch
  (`git-clone-auth.server.ts:149`) and nothing server-side runs
  `git checkout -B`. Any agent that skips the instruction (or lacks the grant)
  produces the [BUG] above. A server-side "ensure HEAD is on `<branch>` before
  committing" step would close it. Risk: MEDIUM.

- **[POOR] Ahead-count ref inconsistency between the two delivery paths.**
  `pushWorkspaceBranch` counts `<defaultBranch>..HEAD` against the LOCAL default
  ref (`push-workspace.server.ts:217`), while `reconcileWorkspaceDelivery` counts
  `origin/<defaultBranch>..HEAD` with a shallow-clone deepen guard
  (`workspace-delivery.server.ts:302`–`326`). In a `--depth 1` clone the local
  default ref can diverge from origin; the push path has no shallow guard, so its
  count can misreport (though the subsequent non-force push is still correct).
  Risk: LOW.

- **[POOR] `mergeTaskPr` merge uses default method with an empty body**
  (`github-reconciler.server.ts:562`) — no configurable merge method
  (merge/squash/rebase) and no head-SHA guard on the PUT (relies on GitHub's
  own `409` for `head_changed`). Acceptable but rigid. Risk: LOW.

- **[MOCK — by design, noted for accuracy] No simulated GitHub server.** Tests
  inject `fetchImpl`/`exec` fakes only; there is no in-product mock GitHub, and
  simulated agent runs skip all delivery/reconcile
  (`workspace-delivery.server.ts:225`, `task-actions.server.ts:2156`). Not a
  defect — recorded so planning doesn't assume a simulated-GitHub harness exists.

- **[POOR] Fine-grained PAT write scopes are assumed, never verified**
  (`pat-validator.server.ts:39`–`42`). A fine-grained token without
  `pull_request:write` validates "green" and only fails at the real merge/PR-open
  (surfaced then as a scope violation). Expected given no safe write-probe, but
  means the pre-flight credential card can over-promise. Risk: LOW.
