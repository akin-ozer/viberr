# GitHub integration and governed delivery

> Credentials, repository attachment, the delivery pipeline, the revision and
> verdict model, reconciliation, and scope violations. Source of truth:
> `app/server/github/*`, `app/server/secrets/*`, `app/server/org/connections.server.ts`,
> `app/server/tasks/task-actions.server.ts` (delivery and acceptance),
> `app/features/github/*`. Verified against `main` @ `68b5480` (2026-09-01).
> Updated 2026-09-02 for ruling 127 (branch `claude/per-user-codex-auth-difdnn`):
> `SEALED_STORES` gained a fifth column, each person's agent-backend API keys.

## 1. Credentials

Three tables, one secret store:

| Table | Role |
|---|---|
| `github_pats` | The only place a token lives, AES-256-GCM sealed (`v1$iv$ct$tag`, `secret-box.server.ts`), with `token_suffix` for display and a cached `validation_json`. |
| `github_connections` | Org-level "owner → PAT" record (`id = slugify(owner)`, `is_default`, `repos_count`, `expires_at`). Used by the Connections panel, project creation and credential attach, and the store browser's GitHub import. |
| `project_github_credentials` | One PAT bound per project. **Every project-scoped GitHub call** resolves through `getProjectGithubContext` (`projects.repo` + `default_branch` + this binding); it never consults connections. |

Removing a connection deletes its PAT and cascades every project binding; the
default connection cannot be removed.

**Required scopes are exactly `repo` and `pull_request:write`**
(`DEFAULT_REQUIRED_SCOPES`; `workflow` and `read:org` were dropped by owner ruling on
2026-07-25). A project's `credentialPolicy.requiredScopes` in `project.md` overrides
the list when non-empty; project creation writes `credentialPolicy: null`.

**Validation** (`pat-validator.server.ts`): `GET /user` (401 → `expired` or
`revoked`; 5xx or network → `network_error`, which never downgrades a stored
verdict), then `GET /repos/{repo}` when a repo is known (404 → `repo_not_found`; 403
with approval wording → `org_approval_missing`; the `permissions` block proves write
access read-only). Scope evidence per token kind:

- **Classic** tokens: the `x-oauth-scopes` header is authoritative (`repo` implies
  `pull_request:write`).
- **Fine-grained** tokens expose no scope introspection, so `repo` is proven from the
  `permissions` block and `pull_request:write` stays `assumed` until a real PR open or
  merge proves it (`markWriteScopeProven`), or `VIBERR_GITHUB_WRITE_PROBE=1` enables an
  empty-payload `POST /pulls` dry run (422 = authorized, 403 = refused).

Chips render only `header`, `probe` and `violation` sources as proof; `assumed` and
`unchecked` read "unproven (verified on first use)" (ruling 19). A connection's
`valid` verdict is re-proven before use once it is older than 24 hours
(`ensureConnectionFresh`; a downgrade audits `org.connection.validation_downgraded`).
Project "Re-check scopes" / "Grant scope" (`revalidateProjectCredential`, 60-second
cooldown) resolves open violations, but a **write** scope clears only on header or
probe evidence, never on `assumed`.

**Key rotation**: `VIBERR_SECRET_ENCRYPTION_KEY_PREVIOUS` (comma list) lets boxes
sealed under retired keys open; `getPatToken` re-seals them lazily; `npm run keys --
status` counts what still opens only under a retired key and `npm run keys -- reseal
[--dry-run]` finishes the job (takes the writer lock). `SEALED_STORES` enumerates
every sealed column: PAT tokens, MCP credentials, OAuth client secrets, the S3
secret, and each person's agent-backend API keys (ruling 127).

**The token never reaches argv or a remote URL.** Git runs with a temporary
`GIT_ASKPASS` helper fed from env (`createGitHubAskpassEnv`), `credential.helper`
reset, `GIT_TERMINAL_PROMPT=0`; clone URLs are the plain `https://github.com/<owner>/<repo>.git`.
`redactGitOutput` scrubs any git or provider text before it reaches a human: by value,
URL userinfo, token-shaped patterns (`gh*_`, `github_pat_`, `sk-`), control
characters; last 8 lines, 600 characters.

## 2. Attaching a repository

- **A repository is required at project creation**: `owner/name` plus an existing
  connection for that owner. The connection's token probes the repo; success adopts
  the remote default branch, a read-only repo still creates with a warning, and
  404/401/network produce warnings with `defaultBranch` falling back to `main`. The
  connection's PAT is bound to the project and proved against the repo.
- **Changing the repo later is a repair** (`repair-repo`, `edit-policy`): normalizes
  `owner/name` or a URL, demands `confirmFootprint` when tasks already carry GitHub
  records, probes with the bound credential and refuses 404/401/403 or a read-only
  repo. Audit `project.repo.updated`.
- **Attach, rotate or clear the credential** (`set-credential` / `clear-credential`,
  `grant-github-scope`): prefers the connection whose owner matches the repo, else
  the default; a borrowed connection is probed against the repo first. Audit
  `github.credential.assigned|cleared`.
- Without a credential or repo every service returns a typed degraded value
  (`no_pat_configured`, `no_repo_configured`, `auth_failed`, `network_unavailable`,
  …) that renders as a pill and an honest toast; nothing throws. The GitHub view
  caches the repo-access check for 30 seconds. Credential detail is stripped from
  loader payloads for readers without `grant-github-scope` (ruling 65).

Only github.com is supported; there is no GitHub Enterprise host configuration.

## 3. The delivery pipeline

Branch name (ruling 122, 2026-09-03): **allocated once, not derived.** The canonical
`taskBranchName(key) = key.toLowerCase()` (`VIB-142` → `vib-142`) is taken when it is
free; when it is not, the task gets `<key>-<4 hex>` instead. "Not free" means a remote ref
exists **or any pull request was ever opened on that name** — the PR half is the
load-bearing one, because task keys restart at 1 on a new data root (ruling 34), so
`vib-1` on GitHub can still carry a previous instance's merged PR while no ref exists at
all. That was the state that used to stop the operator with a branch-collision packet for a
delivery that then succeeded on the first press.

`allocateTaskBranchName` picks the name; `ensureTaskBranch` persists it into `task.md`
`branch:` (the field every reader already prefers over the derived name) and creates the
ref from the default branch (idempotent, audit `github.branch.created`). A task that
already carries a `branch:` keeps it verbatim — nothing in flight is renamed.
`ensureTaskBranchBestEffort` is the shared pre-dispatch hook, called from **both** dispatch
paths: the operator's (`operatorDispatchAgent`) and a human's (`dispatchAgentRun`), the
second added by ruling 122(c) because a human-dispatched delivering run used to reach the
agent prompt with no branch recorded and fall back to the canonical key. Both are
best-effort: a task that cannot reach GitHub still runs.

`performDelivery` is the shared core behind the operator's `deliver_for_review`
(capability `deliver-review-pr`, audit `github.delivery.operator`), an applied
`delivery` recommendation, and the task page's Deliver button
(`manualDeliverForReview`, `run-agents` or the owner, audit `github.delivery.manual`):

1. **Push grant**: the deliverer must hold `execute-code-or-write-repo` /
   `commit-push-branch`; otherwise "Delivery withheld by policy".
2. **`pushWorkspaceBranch`**: locate the delivering workspace; HEAD must be a task
   branch (the default branch means `no_branch`, with evidence from three read-only
   probes); auto-commit a dirty tree as `[KEY] deliver working-tree changes from the
   agent run`; count commits ahead of `origin/<default>` (0 → `no_commits`); push
   `HEAD:refs/heads/<branch>` under the askpass env with a 120-second timeout. A
   non-fast-forward is a `push_conflict` (a branch collision, never a credential
   error); other failures surface git's redacted words in a fenced "What the push
   reported" block.
3. **Verified no-change**: `no_commits`, or `no_branch` on a task that never had a
   branch, PR, revision or commits, with `defaultBranchEvidence.verified === true`,
   sets `noChanges`, mints a `kind: verified` work revision at the default-branch head
   and routes the task to the "Completed, no changes" acceptance path.
4. **`openTaskPr`**: reuse a cached live PR if GitHub still reports it open; else list
   open PRs on the branch and apply the adoption rule (§4); a refused adoption is a
   `branch_collision`. Otherwise `POST /pulls` with title `[KEY] <task title>` and a
   body composed from the task: a link back to the task when `BETTER_AUTH_URL` is set
   (a relative link would 404 on github.com), the goal, a change summary and evidence
   from the live compare, and a footer stating that review and merge are
   human-authorized. A 403 opens a `pull_request:write` scope violation; a 2xx whose
   body fails to decode is salvaged by PR number. Audit `github.pr.opened` on
   creation; `pr: {number, state: review, title}` is written to the task.
5. **Afterwards**: `noChanges` is cleared, a stale push-conflict packet is withdrawn, a
   full-autonomy operator is re-queued with the `delivered` trigger, and a supervised
   operator-authorized delivery records a "Move to <review>" recommendation (audit
   `github.delivery.next_step`).

`reconcileWorkspaceDelivery` runs after every finished delivering run and after a
push: it reads the clone, mints or refreshes the work revision only when the branch
carries work, records `github.commits`, and links a PR the run opened from inside its
workspace through the same adoption rule (audit `github.workspace.branch_reconciled`,
`github.workspace.pr_linked`).

## 4. PR adoption, collisions, and the remedies

A task owns a PR only if that task opened it (ruling 34). A PR found on the task's
branch that the task does not reference is **adopted only when it is open and its head
SHA equals the delivered revision** (ruling 35). Refusals: `merged`, `closed`,
`no_revision`, `head_unknown`, `head_mismatch`. A refused match is a **branch name
collision** (task keys restart at 1 on a new data root, so `vib-4` on GitHub may still
carry an old instance's work), recorded as `github.unownedPr` and blocking delivery.

| Remedy | What it does | Gate |
|---|---|---|
| `resolve_remote_collision` packet option | Closes the recorded unowned PR (audit `github.pr.closed_unowned`), deletes the stale remote branch, re-delivers this task's local work, lifts `readiness` from `blocked`. | `approve-transition` |
| `discard_branch` packet option | Deletes the **local**, never-pushed workspace branch; refuses when the branch exists on the remote. The operator may not author it when a work revision exists. | `approve-transition` |
| `update_branch_from_base` (operator, capability `update-task-branch`) | Merges the base into the task branch in the workspace (never rebase, never force), pushes; a conflict opens a human `blocked` packet (`redirect`, `custom`, `archive_task`). | operator gate; `recommend` is refused outright |
| Branch cleanup | After a successful merge when the `delete-branch-after-merge` guardrail is on (absence means on); on `archive_task` with `deleteBranch: true`; after a no-change acceptance. Refuses the default branch and a branch whose PR is open or accepted. Audit `github.branch.deleted`. | human `userId` required |

## 5. Revisions, verdicts and acceptance

- **Work revision** `{id, headSha, treeSha, branch, createdAt, sourceProfileId, kind}`:
  the same tree keeps the same revision; a different one mints a new id and stales
  every prior verdict.
- **Verdicts** are bound to a revision id; only verdicts on the current revision
  count. Required reviewers are supporting engagements with `verdictCapable: true`.
- **`validation`** derives from the two: `none`, `failing`, `healthy`, `bypassed`
  (after force-accept), `changed`.
- **A project member's GitHub approval counts as the verdict** (ruling 68) when the
  approval's `commit_id` equals the delivered head and the reviewer's login maps to
  exactly one non-disabled member through `users.github_handle`; the reconciler stores
  `pr.humanApproval` with a status (`counted`, `unlinked_handle`, `ambiguous_handle`,
  `not_a_member`, `stale_revision`) and the binding is re-checked on every read.
  GitHub's own review-state pill is informational, not a gate.
- **Acceptance gate order**: archived → closed PR (terminal, withdraws force-accept)
  → stage boundary → required reviewers → live no-change probe → verdict gate → open
  blocked packet → conflicting PR. Human acceptance needs the disclosure echo
  (ruling 88). Force-accept (admin only) bypasses process gates but never a closed PR
  and never the PR-head containment check.
- **Merge is always human.** A human acceptance attempts the real merge
  (`PUT /pulls/{n}/merge`, un-drafting first, refusing a conflicting PR); an
  unreachable GitHub leaves `pr.state: accepted` (merge pending) and a refusal
  (405/409) refuses the acceptance unless forced. A full-autonomy operator acceptance
  writes `accepted` and never merges; "Complete merge" finishes it later after
  re-running the head check. Audit `github.pr.merged` / `github.pr.merge_refused`.

## 6. Reconciliation and freshness

`reconcileTask` (serialized per task) fetches the branch compare
(`rate_limited` is transient; another 403 opens a `repo` violation), the PR (state,
checks summary, review state, mergeability, revision drift when the head is ahead of
the reviewed revision, human approval), and writes the `pr` and `github` caches into
`task.md` (the reconciler never mints a PR link and never downgrades `merged` or
`accepted`). Out-of-band changes become typed `note` events from the policy engine
("Divergence": merged but not Done → accept; closed but active → rework or archive;
reopened), a `policy` notification to task watchers, a withdrawal of moot
recommendations, and a `pr-diverged` operator wake. **It never auto-advances the
stage.** Provenance `github.reconcile`; audit `github.reconcile.task`.

`reconcileProject` runs a budgeted pool (4 concurrent, 20 tasks per tick with a
rotating cursor, terminal tasks skipped). The **poller** runs once at boot and then
every 5 minutes over every non-archived project with a branched task; after 3
consecutive failing passes it sends one deduped `policy` notification to project
admins and maintainers ("GitHub sync is failing"), and it nudges merge-pending PRs
("PR #N accepted: merge to finish KEY").

The GitHub view's **Update status** (`reconcile`, `reconcile-github`) forces a pass
now. The freshness chip shows two facts: the last completed check (newest
`github.reconcile.*` audit row) and the last change (newest reconcile provenance);
older than an hour reads stale; never synced reads neutral (ruling 46).

## 7. Scope violations

`scope_violations` keeps one open row per `(project, scope, task)`. Opened on a
GitHub 403 to a write or a repo read (branch create, compare, PR open, merge) with a
`policy` timeline event from the policy engine, a `policy` notification, an audit row
`github.scope_violation.opened` and the SSE event `violation.updated`. Resolved by a
successful merge (proves `pull_request:write`) or by re-validating the credential
(write scopes need header or probe evidence). Surfaced on the credential card (a
`violation` chip linking to the flagged task), the rail Settings badge (open count),
the task timeline and the inbox.

## 8. What agents get

Agent runs hold **no GitHub credential**: workspaces are cut from a per-project bare
mirror and delivery is server-side on both backends. The one authenticated read is
the Claude-only in-process tool `github_read` (capability `read-github-api`, default
off): the server makes a GET under `/repos/{owner}/{name}` of the task's project with
the project PAT and returns only the JSON; paths outside the repo, full URLs,
traversal and non-GET are refused; every call audits `task.agent.github_read`. Codex
never gets the tool because a Codex mount would hand the child the credential.

## 9. Identifiers and knobs

- Audit: `github.pat.*`, `github.credential.*`, `org.connection.*`, `secrets.resealed`,
  `project.repo.updated`, `github.branch.created|deleted`,
  `github.branch_update.operator`, `github.pr.opened|merged|merge_refused|closed_unowned`,
  `github.reconcile.task|project`, `github.scope_violation.opened|resolved`,
  `github.workspace.branch_reconciled|pr_linked`,
  `github.delivery.manual|operator|next_step`, `task.agent.github_read`,
  `task.branch.discarded|discard_refused`.
- Provenance: `github.reconcile`, `github.merge`, `github.branch_delete`.
- Timeline: `github` (branch and PR facts, delivery signals by `system:delivery`),
  `policy` (scope violation and update), `note` (divergence, collision, cleanup),
  `completion`, `transition`.
- Constants: request timeout 20 s with one retry on 5xx; repo-access cache 30 s;
  connection re-proof after 24 h; revalidation cooldown 60 s; poll every 5 min, 20
  tasks per project per tick, 4 concurrent; stale after 1 h; push timeout 120 s;
  fetch timeout 300 s; merge timeout 60 s; clone and mirror ceiling
  `VIBERR_GIT_CLONE_TIMEOUT_MS` (15 min).

## 10. Corrections to older text

- The README said rotating the encryption key orphans stored tokens. Rotation is
  supported and finishable through the previous-key window and `npm run keys`.
- The README suggested `workflow` and `read:org` scopes; they are not required or
  probed unless a project's `credentialPolicy` names them.
- The README described creating a project and then attaching the repo; a repo and a
  connection for its owner are required at creation, and settings only repairs.
