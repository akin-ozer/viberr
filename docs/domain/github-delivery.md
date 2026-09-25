# GitHub integration and governed delivery

> Credentials, repository attachment, the delivery pipeline, PR adoption and branch
> collisions, the revision and verdict model, base refreshes, reconciliation, and scope
> violations. Source of truth: `app/server/github/*`, `app/server/secrets/*`,
> `app/server/org/connections.server.ts`, `app/server/tasks/task-actions.server.ts`
> (delivery and acceptance), `app/schemas/task-file.schema.ts` (revisions, `pr`,
> `github`), `app/shared/revision-drift.ts`, `app/shared/credential-scopes.ts`,
> `app/features/github/*`.
> Verified against `main` @ `7d9fbf72` (2026-09-23).

## 1. Credentials

Three tables, one secret store:

| Table | Role |
|---|---|
| `github_pats` | The only place a token lives, AES-256-GCM sealed (`v1$iv$ct$tag`, `secret-box.server.ts`), with `token_suffix` for display and a cached `validation_json`. |
| `github_connections` | Org-level "owner → PAT" record (`id = slugify(owner)`, `is_default`, `expires_at`, `reach_json`). Used by the Connections panel, project creation and credential attach, the store browser's GitHub import, and the controller's `list_github_connections`. |
| `project_github_credentials` | One PAT bound per project. **Every project-scoped GitHub call** resolves through `getProjectGithubContext` (`projects.repo` + `default_branch` + this binding); it never consults connections. |

Removing a connection deletes its PAT and cascades every project binding; the
default connection cannot be removed.

**A connection records which repositories its token reaches** (ruling 463). Every
validation of the token (a save, a replaced token, the card's **Re-check**, the 24-hour
re-proof) also reads `GET /user/repos?per_page=100&affiliation=owner,collaborator,organization_member`
(`connection-reach.server.ts`), paged up to 300 repositories with the cap stated, and
stores each one's `fullName`, `private` and `canPush` (the `permissions` block read
through `repoWritable`) as `reach_json`. A fine-grained token lists exactly the
repositories it was granted. A failed read is stored as `unknown` with GitHub's reason,
never as zero; a token whose validation just failed gets an `unknown` reach without a
read; NULL means the connection has not been validated since the read existed, and
Re-check reads it. A repository Viberr creates through the token (ruling 462) joins a
`read` reach at once (`recordCreatedRepositoryInReach`, no GitHub call, `readAt` kept); an
unread or `unknown` reach is left for the next validation. The card says "Reaches 3 repositories · 1 private" with the list one
disclosure away. The account's public-repo count (`GET /users/{owner}` →
`public_repos`) is no longer read or stored: it said nothing about the token.
`GET /users/{owner}` is still the owner-existence check. Re-check (`connection-recheck`,
`recheckConnection`) validates the stored token again, metered like a save; GitHub's
verdict replaces the cache either way, an unreachable GitHub changes nothing, and it
audits `org.connection.rechecked {owner, status, reach}`.

**Required scopes are exactly `repo` and `pull_request:write`**
(`DEFAULT_REQUIRED_SCOPES`; `workflow` and `read:org` are not required or probed). A
project's `credentialPolicy.requiredScopes` in `project.md` overrides the list when
non-empty; project creation writes `credentialPolicy: null`.

**The `workflow` scope stays optional and is disclosed** (ruling 144). The validator
records a classic token's full `x-oauth-scopes` list as `headerScopes` (null for
fine-grained tokens, which publish nothing). The project credential card and the
Connections row carry an ADVISORY, never a failed chip and never a validation failure:
a classic token without `workflow` cannot push changes under `.github/workflows/`. An
open `workflow` violation turns the advisory into "GitHub refused a push … (KEY)". A
project that never ships CI never sees any of this. `checks:read` is advisory the same
way (`ADVISORY_SCOPES`, §7).

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
Project "Re-check scopes" (`revalidateProjectCredential`, 60-second
cooldown) resolves open violations, but a **write** scope clears only on header or
probe evidence, never on `assumed`.

**Key rotation**: `VIBERR_SECRET_ENCRYPTION_KEY_PREVIOUS` (comma list) lets boxes
sealed under retired keys open; `getPatToken` re-seals them lazily; `npm run keys --
status` counts what still opens only under a retired key and `npm run keys -- reseal
[--dry-run]` finishes the job (takes the writer lock). `SEALED_STORES` enumerates
every sealed column: PAT tokens, MCP credentials, OAuth client secrets, the S3
secret, and each person's agent-backend API keys (`user_backend_credentials`, ruling
127). Rotating the key therefore never orphans a stored token.

**The token never reaches argv or a remote URL.** Git runs with a temporary
`GIT_ASKPASS` helper fed from env (`createGitHubAskpassEnv`), `credential.helper`
reset, `GIT_TERMINAL_PROMPT=0`; clone URLs are the plain `https://github.com/<owner>/<repo>.git`.

**The token never enters a workspace's git either** (pass 40 review, R-seams-1; ruling
460). A task workspace is writable by every agent uid, so its `.git` can hold hooks,
`core.fsmonitor`, a credential helper or `url.<x>.insteadOf` an agent planted. The
server therefore never runs git with a workspace as its working repository under its own
uid: the workspace's own git (status, add, commit, merge, the reads the gates take) runs
as the task owner's agent uid through the launcher, with no credential in its
environment (`taskWorkspaceGit`, `workspace-git.server.ts`); everything that needs the
PAT runs as the server in a bare **stage** it owns (`withServerStage`,
`projects/<slug>/.repo-stage/`, borrowing the mirror's objects through `alternates`
under the mirror's lock, removed afterwards), against the PROJECT's URL rather than the
`origin` a checkout's config names. A branch leaves a workspace by the server's `git
fetch` into the stage, whose `git-upload-pack` is the launcher running as the person
(`workspaceUploadPack`), so the server's side only parses a pack. Every git the server
spawns, as itself or as the person, is built on `filteredSpawnEnv()` (never
`process.env`) and carries `core.hooksPath=/dev/null` and `core.fsmonitor=false` at
command-line precedence (`serverGitEnv`, `GIT_CONFIG_COUNT`); an agent's own git keeps
its hooks.
`redactGitOutput` scrubs any git or provider text before it reaches a human: by value,
URL userinfo, token-shaped patterns (`gh*_`, `github_pat_`, `sk-`), control
characters; last 8 lines, 600 characters.

## 2. Attaching a repository

- **A repository is required at project creation**: `owner/name` plus an existing
  connection for that owner. The connection's token probes the repo; success adopts
  the remote default branch, a read-only repo still creates with a warning, and
  404/401/network produce warnings with `defaultBranch` falling back to `main`. The
  connection's PAT is bound to the project and proved against the repo.
- **Creation can create the repository** (ruling 462). With `createRepository`
  (`{ private, description? }`: the controller's `create_project` argument, or the New
  project modal's "Create this repository on GitHub if it does not exist") a 404 probe
  makes the server create it with the connection's PAT before `project.md` is written:
  `POST /user/repos` when the connection's owner is the token's own login (the stored
  validation's `login`), else `POST /orgs/{owner}/repos`, with `auto_init: true` so the
  default branch exists, then a re-probe whose answer is recorded as for any creation.
  An existing repository is used as it is. Everything else refuses and writes no
  project: a 401/403 says the token cannot create repositories and that a fine-grained
  token needs **Administration: Read and write** for All repositories (a classic one
  `repo`); a 422 relays GitHub's message; a probe that cannot tell whether the
  repository exists (token refused, GitHub unreachable) and a name outside
  `[A-Za-z0-9._-]` refuse before any create. The create is sent once
  (`retryServerError: false`: the client's 5xx retry would turn a create GitHub made
  before failing into a 422 "name already exists"), and a 5xx or a dropped connection is
  read back with the probe: a repository there now was made, is recorded and used, and
  the reply says what GitHub answered; one that is not refuses without claiming nothing
  was made. Audit `project.repository.created {repo, private}` under the acting person,
  recorded as soon as GitHub is known to have made it.
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
- **An empty repository is bootstrapped, never misreported** (ruling 128). A
  repository with no refs at all, or one whose only refs are task branches, has no
  default branch to open a pull request against. Viberr creates it itself, before a
  task's first branch: an initial commit (`README.md` naming the project) through the
  Contents API on a repository with no refs, or the configured default branch at the
  first commit of GitHub's current default (a task branch pushed first) with the
  repository default restored. Both are disclosed on the task timeline and audited as
  `github.repo.bootstrapped` (`repo-bootstrap.server.ts`). The Contents API is the one
  door: GitHub answers every Git Database endpoint (blobs, trees, commits, refs) 409
  "Git Repository is empty." until a first commit exists, so an empty-tree commit made
  through them cannot be the first one (ruling 468).
- **An empty repository is named, and initialized before anyone reads it** (ruling 468,
  F40-12). Project creation's probe and the GitHub page's access check read `size: 0` on
  `GET /repos/{r}` as the cue and `GET /repos/{r}/commits` answering 409 as the proof
  (`repositoryIsEmpty`), and record `empty: true` on the connected repo access; creation's
  reply and toast say "<repo> is empty: Viberr will create its first commit on <branch>
  before the first task branch", the GitHub page's Repository panel carries a Contents
  row, and `get_github_state` a `contents` line. When GitHub's permissions block says the
  token cannot push, the connected access also records `readOnly: true` and all three say
  instead that Viberr cannot make that commit until the token can push: the Contents PUT
  would be refused, so the fix is the token, never a pushed commit. The operator's checkout
  (`ensureOperatorRepoCheckout`) is the other path that needs the base: a checkout whose
  HEAD has no commit runs the same bootstrap (actor `system:delivery`, the timeline naming
  the operator's first checkout) and is moved onto the new commit by ruling 129's
  refresh, on the first clone and on a checkout an earlier run left unborn
  (`initializeUnbornCheckout`). The bootstrap is idempotent under a race: a create GitHub
  refuses because another call already made the branch re-reads the ref and answers
  `exists`, writing nothing. The PUT is sent once too, and when its answer said nothing
  (a 5xx, a dropped connection) the branch's head is read: a root commit carrying the
  PUT's own message is Viberr's first commit and is audited and put on the timeline as
  the bootstrap; any other head is `exists`. A token that cannot write gets ruling 128's
  `repo` scope violation, as delivery does. The operator's doctrine says the first commit is Viberr's
  and never a person's.

Only github.com is supported; there is no GitHub Enterprise host configuration.

## 3. The delivery pipeline

Branch name (ruling 122): **allocated once, not derived.** The canonical
`taskBranchName(key) = key.toLowerCase()` (`VIB-142` → `vib-142`) is taken when it is
free; when it is not, the task gets `<key>-<4 hex>` instead. "Not free" means a remote ref
exists **or any pull request was ever opened on that name** — the PR half is the
load-bearing one, because task keys restart at 1 on a new data root (ruling 34), so
`vib-1` on GitHub can still carry a previous instance's merged PR while no ref exists at
all.

`allocateTaskBranchName` picks the name; `ensureTaskBranch` persists it into `task.md`
`branch:` (the field every reader prefers over the derived name) and creates the ref
from the default branch (idempotent, audit `github.branch.created {repo, from,
canonical, branch, suffixed}`). A suffixed allocation is DISCLOSED (U36-6): the same
file write that records `branch:` appends a policy-engine note — "Branch `hlc-10-0c88`
allocated: `hlc-10` is already spoken for on GitHub (a ref or a past pull request),
ruling 122." — so the page explains a name that is not the key; the canonical name gets
no note. A task that already carries a `branch:` keeps it verbatim — nothing in flight is
renamed. `ensureTaskBranchBestEffort` (`branch-sync.server.ts`) is the shared
pre-dispatch hook, called from **both** dispatch paths: the operator's
(`operatorDispatchAgent`) and a human's (`dispatchAgentRun`, for a delivering run on a
task with no `branch:` yet). Both are best-effort: a task that cannot reach GitHub still
runs. The hook DISCLOSES the failures a person can act on (F34-3): `auth_failed`,
`network_unavailable`, `bootstrap_failed` and a throw each write one `github` timeline
event by `system:delivery` ("No task branch could be allocated on GitHub before
dispatch: …" or "Branch `x` could not be confirmed on GitHub before dispatch: …"), an
audit row `github.branch.prepare_failed {branch, status, detail}` and a warn log line;
a repeat of the same failure within an hour writes no second line (the log still says
every attempt); `synced` and `scope_violation` write nothing new (the flag already did);
no credential, no repository and an unknown task are standing states and only log.

`performDelivery` is the shared core behind the operator's `deliver_for_review`
(capability `deliver-review-pr`, audit `github.delivery.operator`), an applied
`delivery` recommendation, and the task page's Deliver button
(`manualDeliverForReview`, `run-agents` or the owner, audit `github.delivery.manual`).
A task that waits on other work (`blockedBy` non-empty) is refused before any of the
steps below, with the hold sentence on the timeline (ruling 240).

0. **The base exists** (ruling 128): `ensureDefaultBranch` runs before the push, exactly
   as it runs from `ensureTaskBranch` at dispatch. The gate splits by EVIDENCE: only a
   positive "there is no default ref and Viberr could not create it" (`bootstrap_failed`,
   a `repo` scope violation) refuses the push, with "Delivery could not run" naming the
   remedy; a probe that merely could not be READ (network, auth) pushes anyway and the
   PR-side wording is what the person sees. "Has no `main`" is never emitted on an
   unread probe: a 5xx, a 429 or an unparseable body on a READ (the ref probe, the
   branch listing, the confirming re-read, the history walk) degrades to the
   unreachable status, while a failed CREATE (the initial commit, the branch creation)
   keeps refusing, because it is positive evidence the base could not be made. An empty
   repository's 409 `Git Repository is empty.` on the branch listing counts as zero
   branches, the answer the bootstrap acts on.
1. **Push grant**: the deliverer must hold `execute-code-or-write-repo` /
   `commit-push-branch`; otherwise "Delivery withheld by policy" (`grant_withheld`).
2. **`pushWorkspaceBranch`** (`push-workspace.server.ts`): locate the delivering
   workspace; HEAD must be a task branch (the default branch means `no_branch`, with
   evidence from three read-only probes); auto-commit a dirty tree as `[KEY] deliver
   working-tree changes from the agent run`; count commits ahead of `origin/<default>`
   (0 → `no_commits`). All of that is the workspace's git, run as the task owner's
   agent uid; from `ls-remote` on, the PAT's steps run in the server's stage (§1).
   Then, in order:
   - **Store layout** (ruling 159): the tree at HEAD is read under the store's own
     prefix (`git ls-tree -r -z --name-only HEAD -- projects/<slug>/tasks/`,
     NUL-delimited so a path git would quote for its non-ASCII bytes cannot read as an
     empty tree); a branch that carries any such path is refused
     (`push_refused_store_layout`, the paths named), because Viberr never publishes its
     store layout into a customer repository. `performDelivery` reports it as "Delivery
     push refused: store layout in the branch" (`store_layout`: no PR, a `github`
     timeline line, a policy notification), and the operator's `deliver_for_review`
     reply says to re-prompt the delivering agent to remove the folder. An unreadable
     tree is not a measurement and the push answers for itself.
   - **Origin's head**: `git ls-remote --heads <project URL> <branch>` from the stage
     under the askpass env (30 s); equal to the workspace HEAD → `up_to_date`, no push
     (ruling 134). An unreadable `ls-remote` never blocks the push.
   - **Workflow files** (ruling 144(b)): the files under `.github/workflows/` the push
     changes as GitHub measures them (`git log --format= --name-only <origin
     head>..HEAD`, falling back to the base only on a first push, so a workflow file
     already on origin never refuses a push that does not touch it). The `pushed`
     result carries `workflowFiles` — a measured list, `[]` for a push that changes
     none, and `null` when history could not answer at all (a truncated clone with no
     `origin/<default>`): an unmeasured push refuses nothing on its own and proves
     nothing either.
   - **File leases** (rulings 245, 353): every file the branch changed since its fork
     point (`git merge-base origin/<default> HEAD`, then `git log --format= --name-only
     <fork>..HEAD --no-merges`, so commits a base refresh brought in are not counted) is
     checked against the project's active leases (`activeFileLeases`); a path another
     task holds refuses the push as `lease_held` with the `leaseRefusal` sentence
     ([task-lifecycle.md §15](task-lifecycle.md#15-file-leases)). An unmeasurable fork
     point refuses nothing and says so in the log.
   - **Workflow scope**: a classic token whose published scopes lack `workflow`, on a
     push that changes workflow files, is refused BEFORE GitHub is asked
     (`push_refused_scope`, `before_push`); GitHub's own refusal of such a push, on any
     token kind, is classified the same way (`github`), never as a generic
     `push_failed`.
   - **Push**: the branch is fetched out of the workspace into the stage (the
     launcher's `git-upload-pack` as the person, no credential), then the head read for
     the origin compare is pushed from the stage as `<sha>:refs/heads/<branch>` under the
     askpass env with a 120-second timeout (a branch moved after that read cannot slip a
     different head into the push); `pushed` carries the head it published and the remote head it replaced. A
     non-fast-forward is a `push_conflict` (a branch collision, never a credential
     error) whose timeline remedy first names what is on the branch (ruling 321): this
     task's own review PR (deleting the branch closes it, force-pushing rewrites what
     the reviewers judged, so it prints `DIVERGED_BRANCH_REMEDY`: merge origin's copy
     into the workspace branch, never rebase or amend), an unowned PR (the packet's
     clear-the-collision option), a head this task pushed with no PR, or an anonymous
     ref. Other failures surface git's redacted words in a fenced "What the push
     reported" block.
3. **Verified no-change**: `no_commits`, or `no_branch` on a task that never had a
   branch, PR, revision or commits, with `defaultBranchEvidence.verified === true`,
   sets `noChanges`, mints a `kind: verified` work revision at the default-branch head
   and routes the task to the "Completed, no changes" acceptance path. A task whose
   deliverable is not a commit (`deliveredAt` set, ruling 388) is told that no commits
   is the right outcome and not to deliver again (ruling 391).
4. **`openTaskPr`** (`pr-open.server.ts`): reuse a cached live PR if GitHub still
   reports it open. A pull request closed WITHOUT merging is a person's decision
   (ruling 160): a cached `closed` PR whose `closure` no person has answered refuses
   with `closed_by_human` before GitHub is asked (a `closed` cache carrying NO closure
   record is one the workspace reconcile wrote, so it goes through `reconcileTask`
   first and the refusal reads off what that pass recorded), and a cached live PR that
   GitHub now reports closed and unmerged is handed to `reconcileTask` (the one writer
   of the closure record and of the R8-6 note, inbox alert and `pr-diverged` wake; the
   workspace reconcile writes the closed STATE too, which is why the record, not the
   state, is what those three key on) and then refused the same way; no fresh PR is
   opened for the branch until a person answers the recovery packet (rework, archive)
   or reopens the PR on GitHub. Only a MERGED pull request, cached or discovered live,
   clears the way for a fresh review PR (DG-1: a reworked branch never resurrects a
   merged PR). Else list open PRs on the branch and apply the adoption rule (§4); a
   refused adoption is a `branch_collision`. Otherwise `POST /pulls` with title `[KEY]
   <task title>` and a body composed from the task: a link back to the task when
   `BETTER_AUTH_URL` is set (a relative link would 404 on github.com), the goal, a
   change summary and evidence from the live compare, and a footer stating that review
   and merge are human-authorized. A 403 opens a `pull_request:write` scope violation;
   a 2xx whose body fails to decode is salvaged by PR number. The 422 arms are typed
   (ruling 128): "No commits between" is `nothing_to_review`; "already exists" re-reads
   the head; `field: base, code: invalid` is `base_branch_missing` (the repository has
   no base branch; the timeline names the two remedies: delete the task branch locally
   and let the deliverer re-cut it from the bootstrapped base, or resolve the unrelated
   history by hand); any other 422 and any unmapped HTTP status is `refused`, quoting
   GitHub. Neither is ever reported as a network failure. A transport failure
   (`network_unavailable`) writes "Review PR could not be opened" with GitHub's reason
   and says nothing about the repository or credential is wrong — the branch is pushed
   and the work is safe, deliver again in a few minutes (ruling 334); `auth_failed`
   points at the credential; only the two "nothing configured" statuses say to fix the
   repository/credential settings. Audit `github.pr.opened` on creation; `pr: {number,
   state: review, title, headSha, bodyWritten}` is written to the task, `bodyWritten`
   being the hash of the body just sent and the revision it describes.

   A REUSED PR's body follows the delivery (ruling 474). When the revision the body was
   written for (`pr.bodyWritten.revision`: the delivered revision, else the PR head) is
   not the one delivered now, the body is recomposed from the current task with the
   create path's inputs (the live compare, the delivered revision, the current goal)
   and sent as one `PATCH /pulls/{n}` that is never retried on a 5xx; the record moves
   to the new body and the audit row is `github.pr.body_updated {prNumber, fromRevision,
   toRevision}`. An unchanged revision sends nothing. Before rewriting, the description
   GitHub holds is hashed (`prBodySha256`, CRLF read as LF) against
   `pr.bodyWritten.sha256`: a mismatch is a person's edit, which is never overwritten.
   The timeline says so once per revision (a `github` note by `system:delivery`: the
   description was left as the person wrote it, the revision it was written for, and the
   revision, commits, files and +/− the PR now carries). A PR with no record (opened
   before ruling 474, or adopted) counts as Viberr's and is rewritten. A `PATCH` that
   fails, or a recorded description GitHub's answer did not include, never fails the
   delivery: a `github` note says which revision the description still describes and
   why, the audit row is `github.pr.body_update_failed` with the same fields plus
   `reason`, and the next delivery tries again. The reconciler never reads the body; it
   carries `bodyWritten` for the same PR, including one a delivery wrote during its
   pass.
5. **Afterwards**: `noChanges` is cleared, a stale push-conflict packet is withdrawn,
   `workRevision.pushedAt` is stamped on the revision whose head the push published
   (ruling 161; also a head that reaches the revision only through Viberr's own base
   refreshes, ruling 439), and what MOVED decides the follow-up (ruling 134): a newly
   opened PR, or a push that moved the head of a reused PR (recorded as "Pushed `<sha>`
   to **PR #N** for review (was `<old>`)" with the same author rule as "Opened PR", and
   in the delivery audit row's `headSha` / `moved`), re-queues a full-autonomy operator
   with the `delivered` trigger; a reuse that pushed nothing (`up_to_date`) re-queues
   nothing, so the loop ruling 48 guarded against cannot start. When the delivery was
   made by the operator's own live drive, the drive continues on its own and the
   `delivered` follow-up is decided when its lease is released: it is queued only if
   the drive stopped without moving the task or dispatching (`deliveredHeadMoved`,
   `actedAfterDelivery`, `deliveredFollowUpFor`, ruling 357). A drive that attempted
   the push counts as having delivered for the stranded backstop (ruling 202). A
   supervised operator-authorized delivery records a "Move to <review>" recommendation
   (audit `github.delivery.next_step`). Every human door that performs a delivery (the
   task page's control, an applied `delivery` recommendation) says what moved through
   one shared toast (`deliveryToast`). The operator's `deliver_for_review` has no
   cached-state short-circuit: the only honest noop is the push itself answering
   `up_to_date`.

`reconcileWorkspaceDelivery` (`workspace-delivery.server.ts`) runs after every finished
delivering run and after a push: it reads the clone, mints or refreshes the work
revision only when the branch carries work (`nextWorkRevision`, §5), records
`github.commits`, and links a PR the run opened from inside its workspace through the
same adoption rule (audit `github.workspace.branch_reconciled`,
`github.workspace.pr_linked`). When it mints a revision but cannot read the PR (no
credential, say), it re-measures `pr.unpushedRevision` against the PR head on record
(ruling 445).

## 4. PR adoption, collisions, and the remedies

A task owns a PR only if that task opened it (ruling 34). A PR found on the task's
branch that the task does not reference is **adopted only when it is open and its head
SHA equals the delivered revision** (ruling 35, `pr-adoption.server.ts`). An adoption is
RECORDED (F34-9, `pr-adoption-record.server.ts`): one `github` timeline event ("Adopted
**PR #N** (head `sha`, the delivered revision) as KEY's review PR, replacing PR #M
(state). Viberr did not open it…"), by the policy engine from the reconciler or by
`system:delivery` from the delivery door, an audit row `github.pr.adopted {repo,
branch, prNumber, previousPrNumber, previousState, headSha, source}`, and — from the
RECONCILER, the door nobody is watching — its own `policy` notification ("PR #N adopted
for KEY", "…: replaces PR #M"). The delivery door writes the event and the row without a
notification: whoever asked for the delivery is reading its answer. A refresh of the
same number records nothing, and replacing a LIVE cached PR wakes the operator with
`pr-diverged` like a reopen does (a closed PR being replaced keeps the existing "live
again" notice instead). Refusals: `merged`, `closed`, `no_revision`, `head_unknown`,
`head_mismatch`.

A refused match is a **branch name collision**, recorded as `github.unownedPr` and
blocking delivery. Two origins reach it and the refusal cannot tell them apart, so
neither the note nor this page asserts one: an unowned OPEN pull request that appeared
on the branch AFTER Viberr allocated the name (the case ruling 122(d) keeps the packet
for), or a branch recorded before ruling 122 under a task key an older data root had
already used (keys restart at 1 on a new data root, so `vib-4` on GitHub may still carry
an old instance's work; names allocated since take a suffix when the canonical one is
spoken for). The remedy is the same either way. A NEW collision is a coordination event
(U36-7): on the same transition edge as the note the reconciler sends the task watchers
a `policy` notification ("Branch name collision on KEY: PR #N is not this task's", the
note as its text; suppressed on the ruling-136(c) re-confirm pass like the divergence
notices) and wakes the operator with `pr-diverged`, so the ruling-50
`resolve_remote_collision` packet is authored on the next turn instead of waiting for an
unrelated wake; a persisting collision re-notifies and re-wakes nobody. The operator
cannot offer `resolve_remote_collision` when no unowned PR is recorded (ruling 244).
The operator snapshot also carries `collisions`: the other open review PRs whose changed
paths overlap this task's (`prPathOverlaps`, ruling 413), the same fact the review queue's
"collides with" chip shows.

| Remedy | What it does | Gate |
|---|---|---|
| `resolve_remote_collision` packet option | Refused before anything is written while the task waits on other work (ruling 354; the packet stays open). Deletes the stale remote branch first, closes the recorded unowned PR (audit `github.pr.closed_unowned` when Viberr's close went through), re-delivers this task's local work, lifts `readiness` from `blocked`. The ceremony writes ONE `github` event naming the PR's fate in every arm (U36-7): "Branch collision cleared: closed PR #N and deleted branch `b`" when the close answered 200; after a refused close it re-reads the PR and says what GitHub shows — "is closed on GitHub with its head", "still shows open on GitHub — close it there", or "could not be re-read" — with the refusal quoted. Ruling 136: the ceremony ends with exactly ONE hand-off (the `delivered` re-queue when the re-delivery fired it, else a `packet-resolved` re-queue carrying the outcome in its own `serverOutcome` field); a refusal because the PR on the ref is this task's OWN open PR is no collision: a behind or absent remote gets the delivery that pushes the work and the block lifts, a diverged remote keeps the block and prints `DIVERGED_BRANCH_REMEDY`; every other refusal keeps the block and hands the operator its typed reason. One audit row per ceremony: `github.collision.resolved {outcome, reason, prNumber, delivered, blockLifted}`. | `approve-transition` |
| `discard_branch` packet option | Deletes the **local**, never-pushed workspace branch; refuses when the branch exists on the remote. Ruling 161: the operator may author it until the revision has LEFT the workspace (`revisionLeftWorkspace`: a PR tracks the branch, an unowned PR stands on the name, or a push stamped `workRevision.pushedAt`); a revision the agent merely reported does not block it, and the refusal names the real reason. A confirmed discard retires the reported revision (`workRevision.kind: discarded`, verdicts kept as history, `validation: none`), says so in the outcome note ("Revision `rev_…` is retired with it") and records `retiredRevisionId` on `task.branch.discarded` (`localSha`, `remoteSha: null`, `basis: local_only`). | `approve-transition` |
| `update_branch_from_base` (operator, capability `update-task-branch`) | `updateWorkspaceBranchFromBase` (`update-branch.server.ts`) merges the base into the task branch in the workspace (`--no-ff`, never rebase, never force; the merge and its abort run as the task owner's agent uid, GitHub's base and origin's copy of the branch are fetched with the PAT into the server's stage and fetched from there by the workspace, and the push goes out from the stage — §1, R-seams-1), reads the merge commit and base tip before the push (an unreadable sha rolls back and publishes nothing), pushes, and `recordBranchRefresh` records the refresh in `baseRefreshes` (with `onto`, the head it merged onto, ruling 439), stamps `pushedAt`, and reconciles at once (ruling 132). Before fetching it refuses a branch that carries the store layout (`store_layout`, ruling 159(b)) or changes a path another task leases (`lease_held`, ruling 428); nothing is merged or pushed. It reports origin's copy of the task branch beside the base answer (current, behind by N, diverged, absent, unknown) and points a lagging origin at `deliver_for_review` (ruling 134(c)); `already_current` is reported as done, not a refusal (ruling 229). A conflict or push conflict opens a human `blocked` packet whose options can all execute (ruling 133(b)): "Have <deliverer> resolve the conflict" is offered and recommended only when the task's delivering engagement is deployed with a repo-write grant (a person routing the conflict to it is the one case the operator directs an agent to merge `origin/<base>` in its workspace, ruling 438); otherwise "Resolve the branch yourself" is recommended, the body says why (no deliverer, undeployed, grant withdrawn), a "Delivering agent" observation names it or "none", and the `github.branch_update.operator` audit row records `resolver`. Refused at the acceptance-boundary stage and past it (`acceptanceBoundaryRefusal`, ruling 162: the acceptance ceremony refreshes once) unless the PR is `conflicting` at its current head or the work is still in its review loop (`validation` `failing` or `changed`, ruling 429); the operator snapshot carries the same refusal as `notRefreshableReason` (ruling 424). The redirect option is marked `rework: true` with "The task returns to Review for the re-verdict." when the task stands past the stage its reviewers can run (ruling 163). A drive that refreshed the branch and then left the task idle is resumed once (ruling 442). | operator gate; `recommend` is refused outright |
| Branch cleanup | `deleteTaskRemoteBranch`, after a successful merge when the `delete-branch-after-merge` guardrail is on (absence means on); on `archive_task` with `deleteBranch: true`; after a no-change acceptance. Refuses the default branch and a branch whose PR is open or accepted. Ruling 136(c): a CACHED open PR is re-confirmed against GitHub before it can refuse (a pass with the divergence notification and the operator wake suppressed); a PR GitHub reports closed or merged lets the delete proceed on the refreshed file, a PR still open refuses (`own_pr_open`), and every degraded or unexpected reconcile status refuses as `unconfirmed` ("GitHub could not confirm"), never deleting on an unconfirmed state. The archive and empty-branch doors inherit the same check and sentence. Ruling 161: the ref's head is read before the DELETE and recorded (`github.branch.deleted {sha}`, "Deleted branch … Its head was `sha`"); the archive's local cleanup records both heads on `task.branch.discarded {localSha, remoteSha, basis: archive_cleanup}`, and the archive dialog says what origin holds when the reconciler recorded `github.foreignHead` ("origin's `branch` carries commits this task did not author; deleting it removes them too"). Only GitHub's explicit "does not exist" answer counts as `already_gone`; any other refusal of the DELETE (a protected branch, a ruleset) is `github_refused` (ruling 207(d)). | human `userId` required |

## 5. Revisions, verdicts and acceptance

- **Work revision** `{id, headSha, treeSha, branch, createdAt, sourceProfileId, kind,
  pushedAt}`, `kind` one of `delivered | verified | discarded | external`
  (`nextWorkRevision`, `activeWorkRevision` in `task-file.schema.ts`): the same tree
  keeps the same revision; a different one mints a new id and stales every prior
  verdict. A head reached only through Viberr's own base refreshes keeps the revision
  too (ruling 439): each refresh records `baseRefreshes[].onto` (the merge's first
  parent), and `refreshChainFrom` follows a revision's head through the refreshes made
  onto it, stopping at the first refresh made onto anything else; a refresh recorded
  without `onto` links nothing.
- **Verdicts** are bound to the review subject (`reviewSubjectId`: the active revision's
  id, or `files:<deliveredAt>` for a deliverable that is not a commit, ruling 388); only
  verdicts on the current subject count. Required reviewers are supporting engagements
  with `verdictCapable: true`, plus the project's declared `requiredReviewers`
  ([task-lifecycle.md §8](task-lifecycle.md#8-engagements-dispatch-and-verdicts)). A
  reviewer is checked out at the reviewed revision's head, except that
  `reviewSubjectSha` moves it to the PR head when the drift measured at that head is a
  base refresh only (ruling 238), and to the end of the refresh chain when no drift was
  measured at the head being offered (ruling 439); a measured drift outranks the chain.
- **`validation`** derives from the two: `none`, `failing`, `healthy`, `bypassed`
  (after force-accept), `changed`.
- **Revision drift is classified, not counted** (ruling 132): `pr.revisionDrift` is
  `{headSha, authored, baseRefresh: {merges, commits} | null}`. The reconciler
  classifies each commit in `reviewedSha...head`: not among the branch's own commits
  (the `default...branch` compare) is a base commit; a two-parent commit recorded in
  `baseRefreshes[]` is a clean merge; anything else, including a merge Viberr did not
  make, is authored. It classifies only when both compares are complete and the base
  compare was read; otherwise it carries the last record or, with nothing to carry,
  records every commit as authored, never "no drift". When a refresh's pushed merge is
  not yet the PR head GitHub reports (GitHub lagging, or unreachable),
  `recordBranchRefresh` writes the drift from the refresh record itself
  (`refreshOnlyDrift`) and says where the numbers came from, or that the drift was not
  re-measured (ruling 439). One function, `describeRevisionDrift`, turns the record into
  the sentence every surface prints verbatim ("N authored commit(s) since review
  merge(s) unreviewed", "base refreshed · 1 merge commit · 4 base commits · 0 authored
  commits since review"); only authored commits are called unreviewed.
- **A project member's GitHub approval counts as the verdict** (ruling 68,
  `pr-human-approval.server.ts`) when the approval's `commit_id` equals the delivered
  head and the reviewer's login maps to exactly one non-disabled member through
  `users.github_handle`; the reconciler stores `pr.humanApproval` with a status
  (`counted`, `unlinked_handle`, `ambiguous_handle`, `not_a_member`, `stale_revision`)
  and the binding is re-checked on every read. GitHub's own review-state pill is
  informational, not a gate. `users.github_handle` has two writers (ruling 154): GitHub
  OAuth sign-in syncs it from the provider's login for a GitHub account, and an org
  admin links it under Instance settings, Users & access for a local or Google account
  (`updateOrgUser`, audit `org.user.github_handle.set` / `.cleared`); the person cannot
  set their own. The `unlinked_handle` refusal names both doors.
- **Acceptance gate order** (`acceptanceRefusalReasons`): archived → closed PR
  (terminal, withdraws force-accept) → stage boundary → engaged required reviewers →
  project-declared required reviewers → the live no-change probe's has-work refusal →
  the delivered-work verdict gate → open blocked packet → **unpushed delivered
  revision** (ruling 135) → conflicting PR. Human acceptance needs the disclosure echo
  (ruling 88). Force-accept (admin only) bypasses process gates but never a closed PR,
  an archived task, or the PR-head containment check. The last two gates are ONE
  function, `mergeReadinessRefusal` (ruling 162), read by the stack, by the operator's
  snapshot (`notAcceptableReason` is the whole stack's verdict, `pr.mergeable` the
  recorded fact), by the operator's move into the acceptance-boundary stage, and by the
  accept-time merge refusal; no surface offers an acceptance the gate will refuse (the
  recommendation card, the accept dialog, the sidebar and the GitHub card's "conflicts"
  pill all read it), and the reconciler withdraws a pending `accept_completion` card
  when `mergeable` flips to conflicting. The full ceremony is
  [task-lifecycle.md §11](task-lifecycle.md#11-acceptance-and-the-endings).
- **Mergeability belongs to the head it was measured on** (rulings 405, 435): the
  reconciler records `pr.mergeableAt` beside `pr.mergeable`, and every reader goes
  through `liveMergeable` (`app/features/github/github-pills.ts`): the acceptance gate
  (`conflictingPrBlockedReason`), the pills, the operator snapshot,
  `acceptanceBoundaryRefusal` and the review-queue row. A verdict measured on another
  head reads as unknown and never blocks; the merge attempt decides. An unpinned
  (older) `conflicting` still blocks. The conflict sentence says to merge the base into
  the branch, never to rebase (ruling 291).
- **The base refresh happens once, at acceptance** (ruling 162): the ceremony runs
  `updateWorkspaceBranchFromBase` between two runs of the gate re-check (the refresh
  publishes, so nothing is pushed under a decision the caller can no longer confirm) and
  before the merge, records the refresh (`baseRefreshes`, the shared
  `recordBranchRefresh`, audit `github.branch_update.acceptance`), refuses on a conflict
  with the gate's sentence after recording `mergeable: conflicting` and the conflicting
  paths, and hands the task to the operator (`pr-conflicting`, ruling 332). It proceeds
  to the merge when the branch cannot be refreshed from here, including a path another
  task leases (ruling 428). Operators stop refreshing at the acceptance boundary once the
  work is approved. Ruling 159(b): the refresh pushes the whole workspace head, so it
  reads HEAD's tree under `projects/<slug>/tasks/` first and answers `store_layout` (the
  paths named, nothing fetched, merged or pushed) rather than publishing the store layout
  a refused delivery left committed on the local branch; the audit row carries the
  paths, and the operator's tool prints them with the remedy. A person can also ask for
  the refresh without accepting, followed by a re-review of the refreshed head by every
  reviewer whose verdict stands (intent `refresh-and-review`, `refreshAndReview`, ruling
  449; same audit row).
- **The unpushed delivered revision** (ruling 135): `pr.headSha` is the PR head as
  GitHub last reported it, and `pr.unpushedRevision {revisionSha, prHeadSha, relation}`
  says the delivered revision is not on the pull request: `behind` (origin's copy is an
  ancestor, a plain push fast-forwards), `diverged` (origin holds commits the workspace
  does not, a push is refused non-fast-forward) or `unknown` (the two heads could not be
  related: GitHub has no such commit, which is what a never-pushed revision looks like,
  or the workspace holds no copy of the PR head). The reconciler writes it: the primary
  arm is a compare GitHub answers `missing_ref` to, confirmed by a commit read GitHub
  answers "not found" to (`isMissingCommitAnswer`: 404, the empty-repository 409, or 422
  "No commit found for SHA", which is how `GET /commits/{sha}` really answers; rulings
  223 and 427); a `behind`/`diverged` compare is the secondary arm. The workspace
  reconcile writes it the moment a delivering run mints a revision on a branch whose PR
  is open, a delivery that pushes clears it, a `verified` revision never gets one, and a
  record for a revision that is no longer current reads as nothing
  (`unpushedRevisionOf`). One helper, `unpushedRevisionBlockedReason`, is consulted by
  every consumer of the conflict gate (the refusal stack, the projected `blockReason`,
  the review queue row, the board ceremony, the accept-time merge cause, the review row
  subline, the operator's `get_task`) and outranks the conflict sentence because it
  names the fact a person can act on: "deliver the branch to push it". The live
  accept-time head check (`acceptancePrHeadCheck`) refuses on the same evidence instead
  of answering "unverifiable", records a `github` event and a
  `task.acceptance.head_unpushed` audit row, and hands the task to the operator
  (`head-unpushed`, ruling 235). A PR whose compare GitHub refuses outright is refused
  too, with a non-blocking packet offering `accept_unverified_head`, a waiver
  (`headCheckWaiver`) valid only for that PR, revision and live head (ruling 226).
- **Merge is always human.** A human acceptance attempts the real merge (`mergeTaskPr`,
  `PUT /pulls/{n}/merge`, un-drafting first, refusing a conflicting PR) before the
  completion is written; an unreachable GitHub leaves `pr.state: accepted` (merge
  pending) and a refusal (405/409, or a head that changed during the acceptance)
  refuses the acceptance unless forced. A 405 re-reads the pull (ruling 162): a
  conflicting answer, or GitHub's own "merge conflicts" sentence while it is still
  computing, records `mergeable: conflicting` and the result says `mergeable:
  "conflicting"`, so the acceptance prints the gate's sentence, never a second one for
  the same fact. The completion record is written from the file as it stands after the
  merge, so it names the head that merged and the refresh the ceremony made (ruling
  318). The accept dialog says what CI reports when checks are failing or pending, and
  that checks are not a gate (ruling 304). A full-autonomy operator acceptance writes
  `accepted` and never merges; "Complete merge" finishes it later after re-running the
  head check. Audit `github.pr.merged` / `github.pr.merge_refused`.

**A PR head that moves after the verdict voids it** (ruling 179). Verdicts bind to the
work revision; a push Viberr did not make moves `pr.headSha` without touching it. On the
pass that first records such a head carrying authored commits (ruling 132's `authored >
0`) on an open task whose current revision has a verdict, the reconciler mints the head
as the revision under review (`workRevision.kind: "external"`), so `validation`
re-derives to `changed`; withdraws the moot accept and transition offers; writes a
"Revision moved after review" note with the drift sentence; notifies the watchers; wakes
the operator (`pr-diverged`); and returns a task that sits past its verdict stage to the
stage where the reviewer works (`task.transition {boundary: "rework", via:
"authored-drift"}`). Drift before any verdict is the branch growing: nothing is minted.
The commits without the task's `[KEY]` prefix are kept as `github.otherCommits` and the
Commits card lists them apart as "Also on the branch · not this task's".

## 6. Reconciliation and freshness

`reconcileTask` (`github-reconciler.server.ts`, serialized per task) fetches the branch
compare (`rate_limited` is transient; another 403 opens a `repo` violation), the PR
(state, checks summary, review state, mergeability and the head it was measured on, the
head sha, the changed paths, revision drift when the head is ahead of the reviewed
revision, the unpushed-revision record when it is not (ruling 135), human approval), and
writes the `pr` and `github` caches into `task.md`. The PR is found by branch name, and
a closed PR whose branch has since advanced is not returned that way (F26); when the
listing names nothing and the task's cached PR is live (or says `closed` with no closure
record), the cached NUMBER is read directly and a settled answer (closed, merged) is
recorded (ruling 160): this is what lets a close that a push overtook transition at all.
Writing `pr.closure` (`at`, the closer's GitHub login from the issue payload or null,
`answered: null`) is what announces the close: the note, the alert and the wake fire the
pass that RECORD appears, not the pass the state changes, because `pr.state: closed` also
reaches the file from the workspace reconcile. The closure is carried while the PR stays
closed and dropped when it is live or merged again. The operator's branch update runs one
such pass right after its push (ruling 132), so the drift it caused is measured before
the tool answers. The reconciler never mints a PR link and never downgrades `merged` or
`accepted`.

Facts it records beside the state:

- **Commits** (`github.commits`, ruling 187): each entry carries `pushed` — whether the
  remote has it — stamped only from a COMPLETE branch compare; a short compare list
  (`droppedCommits > 0`) judges nothing, and a merged branch stops new stamping. An
  absent `pushed` renders as neither answer; the GitHub page's branch row renders the
  rest ("1 commit · not pushed"). Viberr does not declare such a commit lost: at
  reconcile time a commit awaiting delivery and one whose workspace is gone are
  indistinguishable.
- **Changed paths** (`pr.paths`, ruling 236): the PR's changed files pinned to the head
  they were read at, capped at `PR_PATHS_MAX` (300) with `truncated`. The review queue
  and the operator snapshot compare them across open PRs (`prPathOverlaps`).
- **Checks** (ruling 360): a check-runs read GitHub refuses is kept as
  `pr.checksUnread {status, message}` until a read succeeds, and the PR card, the accept
  dialog and the GitHub page say the checks could not be read, with GitHub's reason. A
  403 there flags the advisory `checks:read` scope (§7). `checksRead` in
  `get_github_state` separates "never read" from "read, zero checks" (ruling 276).
- **Sync verdict**: the branch pill reads `merged`, `behind_main`, `synced`, `unknown`
  ("not compared") or `no_branch` (a terminal task with no PR and no commits, decided
  before the compare, so finished work never reads `behind_main`; ruling 401). A pass
  whose only change is this verdict still writes a `github.reconcile` provenance row, so
  a branch that falls behind because `main` moved stops rendering a stale `synced`.

Out-of-band changes become typed `note` events from the policy engine ("Divergence":
merged but not Done → accept; closed but active → rework or archive; reopened), a
`policy` notification to task watchers, a withdrawal of moot recommendations, and a
`pr-diverged` operator wake; a NEW branch collision gets the same notification and wake
(U36-7). **It never auto-advances the stage.** Provenance `github.reconcile`; audit
`github.reconcile.task`.

`reconcileProject` runs a pool of 4 concurrent tasks (`RECONCILE_TASK_CONCURRENCY`) over
every task with a branch. A manual pass takes them all; the poller's budgeted pass takes
20 per tick (`RECONCILE_POLL_TASK_BUDGET`) with a rotating cursor and skips terminal
tasks (archived, merged PR, or at the terminal stage). The **poller**
(`reconcile-poller.server.ts`) runs once at boot and then every 5 minutes
(`RECONCILE_POLL_MS`) over every non-archived project with a branched task; after 3
consecutive failing passes it sends one deduped `policy` notification to project admins
and maintainers ("GitHub sync is failing for this project"), and it nudges merge-pending
PRs ("PR #N accepted: merge to finish KEY") from its own last reading of the PR, because
budgeted passes skip terminal tasks.

The GitHub view's **Update status** (`reconcile`, `reconcile-github`) forces a pass
now. The freshness chip shows two facts: the last completed check (newest
`github.reconcile.*` audit row) and the last change (newest reconcile provenance);
older than an hour reads stale; never synced reads neutral (ruling 46).

## 7. Scope violations

`scope_violations` keeps one open row per `(project, scope, task)`. Opened on a GitHub
403 to a write or a repo read (branch create, compare, PR open, merge, a check-runs
read) with a timeline event from the policy engine, a `policy` notification, an audit row
`github.scope_violation.opened` and the SSE event `violation.updated`. Resolved by a
successful merge (proves `pull_request:write`), by re-validating the credential (write
scopes need header or probe evidence), or, for `checks:read`, by a later successful
read. Surfaced on the credential card (a `violation` chip linking to the flagged task),
the rail Settings badge (open count), the task timeline and the inbox.

**An advisory scope is not a violation** (rulings 380(b) and 386). `ADVISORY_SCOPES`
(`app/shared/credential-scopes.ts`, today `checks:read`) lists scopes whose absence is
worth reporting and that nothing requires. A refusal on one writes a `note` reading
"**Credential advisory:** the active PAT has no `checks:read`, which this project does
not require. …" instead of a "**Policy violation:**" `policy` event
(`scopeFlagText`), its clearing note says "advisory", and the Settings badge
(`countOpenPolicyViolations`) leaves it out of the count. The notification kind stays
`policy`.

Ruling 144(c): a workflow-file push refused for the `workflow` scope opens a `workflow`
violation on the task through the same door (the `policy` event, the inbox notification,
the credential-card flag, the rail count), and delivery answers `scope_violation` with a
remedy that names the Re-check scopes control on the project's GitHub page. It resolves
on a re-check whose header lists `workflow` (header scopes are evidence for every scope
they name), or on the next successful push of workflow files. A push whose workflow
files could not be measured (`workflowFiles: null`) leaves the violation standing: the
absence of a measurement is not the proof the ruling asks for.

## 8. What agents get

Agent runs hold **no GitHub credential**: workspaces are cut from a per-project bare
mirror and delivery is server-side on both backends. The one authenticated read an
agent gets is the Claude-only in-process tool `github_read` (capability
`read-github-api`, default off, `agent-github-read.server.ts`): the server makes a GET
under `/repos/{owner}/{name}` of the task's project with the project PAT and returns
only the JSON; paths outside the repo, full URLs, traversal and non-GET are refused;
every call audits `task.agent.github_read`. Codex never gets the tool because a Codex
mount would hand the child the credential. The operator and the controller read the
default branch through the server (`read_default_branch_file`, served from the project
mirror, `operator-repo-read.server.ts`), and the controller reads one task's pull request (files, status, counts and hunks under a
40,000-character patch budget) through `read_pull_request` (`pr-diff.server.ts`,
ruling 266); both are server-side reads with the project's credential, never a
credential handed to a model.

## 9. Identifiers and knobs

- Audit: `github.pat.*`, `github.credential.*`, `org.connection.*`, `secrets.resealed`,
  `project.repo.updated`, `project.repository.created` (ruling 462, a repository made
  at project creation), `github.repo.bootstrapped` (ruling 128, a repository-level
  change like `github.credential.assigned`), `github.branch.created|deleted`,
  `github.branch.prepare_failed`, `github.branch_update.operator|acceptance`,
  `github.collision.resolved`,
  `github.pr.opened|adopted|merged|merge_refused|closed_unowned`,
  `github.reconcile.task|project`, `github.scope_violation.opened|resolved`,
  `github.workspace.branch_reconciled|pr_linked`,
  `github.delivery.manual|operator|next_step`, `task.acceptance.head_unpushed`,
  `task.agent.github_read`, `task.branch.discarded|discard_refused`,
  `project.file_leases.updated`.
- Provenance: `github.reconcile`, `github.merge`, `github.branch_delete`.
- Timeline: `github` (branch and PR facts, delivery signals by `system:delivery`),
  `policy` (scope violation and update), `note` (divergence, collision, cleanup, a
  credential advisory), `completion`, `transition`.
- Constants: request timeout 20 s (`GITHUB_REQUEST_TIMEOUT_MS`) with one retry on 5xx;
  repo-access cache 30 s; connection re-proof after 24 h; revalidation cooldown 60 s;
  poll every 5 min, 20 tasks per project per tick, 4 concurrent; stale after 1 h;
  pre-push `ls-remote` 30 s; push timeout 120 s (`PUSH_TIMEOUT_MS`); base-refresh fetch
  timeout 300 s and merge timeout 60 s (`update-branch.server.ts`); clone and mirror
  ceiling `VIBERR_GIT_CLONE_TIMEOUT_MS` (15 min); `PR_PATHS_MAX` 300.
