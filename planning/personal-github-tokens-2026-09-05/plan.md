# Personal GitHub tokens: the human owns the commit, the PR and the merge

Owner decisions, 2026-09-05. Implementation plan for the change that makes a task's
human the identity GitHub sees for the acts a human is responsible for, while every
unattended path keeps the project credential it uses today.

Prerequisite reading: [`docs/domain/github-delivery.md §1`](../../docs/domain/github-delivery.md)
(the credential model as built), ruling 127 in
[`docs/architecture/decisions.md`](../../docs/architecture/decisions.md) (the per-person
precedent this extends), and ruling 68 (the GitHub-approval verdict this partly retires).

---

## 1. The decisions

| # | Question | Decision |
|---|---|---|
| 1 | Who opens the PR | The **task owner**, with their own token. Accepts that GitHub then forbids them from approving it. |
| 2 | Who pushes the delivery branch | The **task owner**, with their own token. |
| 3 | Commit author and committer | **The owner, as both.** No agent identity in git, no co-author trailer. |
| 4 | Owner has no personal token | **Fall back to the project credential, and say so** on the record. |
| 5 | Commit author in that fallback | **Still the owner**, using the best identity available. |
| 6 | Token shape | **One personal token per person**, instance-wide, like agent accounts. |
| 7 | Who merges | The **accepting human** (whoever completes the merge), their token if they have one, else the project's. |
| 8 | A personal token that is missing a scope or has lost access | **Personal**, named to that person. Project scope violations keep meaning the project credential is wrong. |
| 9 | Every other GitHub call | **Unchanged.** Clone, mirror fetch, the agent read tool, PR-status reads and the five-minute poller keep the project credential. |
| 10 | Token present but refused mid-flight | **Refuse and name them.** No quiet fallback: that refusal IS the enforcement parity. Checked at run start as well, so most refusals land before the agent works. |

Decision 7 is the owner's own, and it is better than either option offered: the merger is
normally not the PR author, so a second GitHub account appears on the pull request, which
is exactly what a protected branch wants.

## 2. The model

A task's owner is already the credential principal for its runs (ruling 127). This
extends the same principal to the three GitHub acts a human is answerable for, and to
nothing else:

- **Push** of a delivery branch → the task owner's token.
- **Open** of the pull request → the task owner's token.
- **Merge** → the token of the human who completed it.

Everything else keeps `getProjectGithubContext(db, projectSlug)` exactly as it is. The
project credential remains the machine's credential: the shared bare mirror, workspace
clones, the reconcile poller, repo-health probes, branch bootstrap and cleanup, the
Claude-only `github_read` tool, and every PR-status read.

Commit authorship is independent of all of this. It is fields in the commit object, so
it applies whether or not a personal token exists.

## 3. Storage

One new table, reusing the existing sealed PAT store so key rotation, validation caching
and the token-suffix display all come for free. Pre-production, so it goes into the
squashed baseline (`db/migrations/0001_baseline.sql`), no new migration file.

```sql
-- Ruling 146: a person's own GitHub token, used for the acts GitHub attributes to a
-- human (push, PR open, merge). One row per person; connecting again REPLACES it.
-- The token itself lives in `github_pats` like every other, so rotation and validation
-- reach it; this table is the binding plus the GitHub identity we need to author a
-- commit that GitHub can link back to them.
CREATE TABLE user_github_credentials (
  user_id        TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  pat_id         TEXT NOT NULL REFERENCES github_pats (id) ON DELETE CASCADE,
  github_login   TEXT NOT NULL,      -- from GET /user at connect time
  github_user_id INTEGER NOT NULL,   -- numeric id; the noreply commit address needs it
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
```

Notes.

- `github_pats.user_id` already exists and records who created a token row; it stays
  provenance. This table is what makes a token *resolvable* for a person.
- `github_login` / `github_user_id` come from the `GET /user` call the validator already
  makes at connect time. They are the only way to author a commit GitHub links to the
  person's avatar and contribution graph.
- No new sealed column, so `SEALED_STORES` in `key-rotation.server.ts` needs no entry.
  Its pinned-list test keeps passing untouched, which is the point of reusing `github_pats`.
- Deleting a user cascades the binding; the `github_pats` row goes with it.

## 4. Resolution

A new resolver beside the run principal, same shape and same refusal vocabulary
(`app/server/runtimes/run-principal.server.ts` is the model):

```
app/server/github/github-principal.server.ts

  resolveGithubPrincipal(db, userId) →
    | { ok: true;  token: string; patId: string; login: string; githubUserId: number }
    | { ok: false; refusal: "no-token" }                       → fall back, disclose
    | { ok: false; refusal: "refused"; detail: PatValidation } → refuse, name them

  resolveTaskGithubPrincipal(db, ctx, projectSlug, taskKey) →
    reads task.md `ownerUserId` (the same field resolveTaskRunPrincipal reads),
    then resolveGithubPrincipal.

  githubPrincipalRefusalMessage(refusal, owner) → ONE sentence builder, shared by the
    run-start check, the blocked packet, the timeline event and the disabled control,
    so a person is never told three different stories about one refusal.
```

The distinction between `no-token` and `refused` is decisions 4 and 10: never having
connected is a fallback, having connected something GitHub now rejects is a refusal.

## 5. Change list, by seam

### 5.1 Commit identity (decision 3 and 5) — independent of tokens, ship first

| File | Now | After |
|---|---|---|
| `app/server/tasks/specialist-run.server.ts:3257` | `agentGitIdentity(profileId)` returns `{ profileId, profileId@viberr.local }` | `taskCommitIdentity(db, projectSlug, taskKey)` returns the owner's name and GitHub-linked address |
| same, `:3261-3269` | `GIT_AUTHOR_*` / `GIT_COMMITTER_*` env from the profile | both pairs from the owner |
| same, `:3340-3349` | clone-time `git config user.name/user.email` | same values |
| `app/server/github/push-workspace.server.ts:491-507` | `commitIdentityArgs` falls back to `Viberr Delivery <delivery@viberr.local>` | falls back to the owner's identity; the Viberr fallback survives only for a task with no owner at all |

Address, in order of preference:

1. `<github_user_id>+<github_login>@users.noreply.github.com` when the person has a
   personal token. Always links to their GitHub account, never exposes a private address.
2. `<github_handle>@users.noreply.github.com` when they linked GitHub sign-in but have no
   token (`users.github_handle`, already populated by OAuth provisioning).
3. Their Viberr account email. Names the person honestly; may not link on GitHub.

The F24 property this retires is deliberate: git no longer records which agent wrote a
change. That fact does not disappear, it moves to where it already lives in richer form —
the run row, the run log and the task timeline all name the agent, its backend and its
model. Note it in the ruling so a future pass does not "restore" the agent author.

### 5.2 Push (decision 2, 10)

- `PushWorkspaceBranchInput` (`push-workspace.server.ts:527-545`) gains
  `principal: GithubPushPrincipal` — the resolved token plus who it belongs to, or the
  project fallback with the reason.
- The credential lines (`:757-758`) take the principal's token instead of calling
  `getProjectCredential` directly. `createGitHubAskpassEnv` already accepts the token, so
  the git plumbing is untouched.
- `performDelivery` (`task-actions.server.ts:5310`) resolves the principal alongside the
  existing `resolveDeliveryPushGrant` (`:5155-5176`) and refuses on `refused` before any
  push, with the shared sentence.

### 5.3 Pull request (decision 1, 4)

- `openTaskPr` (`pr-open.server.ts:345-364`) already takes an `actor`; it gains the
  resolved principal and uses that token for `POST /repos/{repo}/pulls` (`:549-561`).
  The project context is still resolved, for the repo, owner and base branch.
- `composePrBody` (`:44-88`) keeps its disclosure sentence and gains one line naming the
  person the delivery was made for, plus, in the fallback case, that it ran on the
  project credential because they had no personal token connected.
- Set the owner as the PR **assignee** in the same call. Free, and it points the PR at a
  person on the list view as well as on the PR itself.

### 5.4 Merge (decision 7)

`mergeTaskPr` (`github-reconciler.server.ts:1316-1393`) already receives
`actor: AuditActor & { userId: string }`. Resolve that person's personal token and use it;
fall back to the project credential when they have none, and record which was used. The
merge call body stays empty; GitHub credits whoever the token belongs to.

### 5.5 Run-start check (decision 10)

`resolveTaskRunPrincipal` is called before any expensive work at
`specialist-run.server.ts:1522`, `operator-run.server.ts:1650` and
`task-actions.server.ts:1789`. Add the GitHub check **beside** it, and only when the run
could deliver — that is, when the engagement's `canCommitPush` grant is true. A research
or review engagement with no repo-write grant must not be blocked by a GitHub token it
will never use.

Outcome shapes, reusing the existing machinery:

- `no-token` → run proceeds; the delivery will fall back and disclose.
- `refused` → the same honest `run·unavailable` error run and blocked packet ruling 127
  produces for a missing Claude account, with a sentence naming the person, their token
  and the remedy.

### 5.6 Personal credential health and failures (decision 8)

- No change to the `scope_violations` table. A personal token's problems are that
  person's: they surface as the refusal on the task, a chip on their own profile card,
  and a notification to them.
- `getProjectCredentialHealth` and the project's chips keep describing the project
  credential only.
- The task page shows whether the **owner** has GitHub connected, in the third person for
  everyone else, exactly as `backendRunMark` already does for Claude and Codex.

### 5.7 UI

| Surface | Change |
|---|---|
| Profile → a new **GitHub account** card, beside Agent accounts | Paste a token, validate, show login, masked suffix and scope chips, disconnect. Nothing is saved unless validation passes, the rule connections already follow. |
| Task page, delivery controls | The owner's GitHub state where it is load-bearing; third-person copy for other viewers. |
| Project → GitHub page | Unchanged. It still describes the project credential, which still exists and is still what the poller uses. |
| Org settings → Connections | Unchanged. |

Visibility rule, by precedent: only you see your own token's detail. Everyone else sees
connected or not connected where a decision depends on it, and nothing more. This mirrors
ruling 107's deletion of the org-admin credential-detail arm.

## 6. What deliberately does not change

Worth writing down, because each one is a place a future reader will assume otherwise:

- The shared bare mirror and every workspace clone.
- The five-minute reconcile poller and everything it drives.
- Repo-health probes, project creation's attach probe, repo bootstrap, branch creation
  and cleanup, `update-branch`.
- The Claude-only `github_read` tool.
- PR-status reads used by acceptance and the timeline.
- Agent runs still hold no GitHub credential of any kind. Delivery stays server-side.

## 7. Consequences to accept, on the record

1. **The owner cannot approve their own pull request.** GitHub forbids it. Ruling 68's
   path, a project member's GitHub approval standing as the approving verdict, no longer
   applies to a person's own tasks; acceptance happens in Viberr, or another member
   approves. On a protected branch that requires a review, someone else must approve.
   Decision 7 softens this, since the merger is a second account.
2. **Viberr will hold one full-power token per person.** A classic token with `repo`
   scope reaches every repository that person can. Sealed like every other, and reachable
   by the rotation sweep, but the blast radius of the store grows with headcount.
3. **GitHub becomes the real authority on delivery.** Someone Viberr says may deliver, but
   who lacks write access on that repository, is refused. That is the point, and it means
   a role grant in Viberr is no longer sufficient on its own.
4. **Git stops recording which agent wrote a change.** Deliberate; the run log and
   timeline carry it.

## 8. Phases

Each phase ships on its own and leaves the product coherent.

| Phase | Content | Value on its own |
|---|---|---|
| 1 | Storage, the profile card, validation, `resolveGithubPrincipal` | People can connect; nothing uses it yet |
| 2 | Commit identity (5.1) | **Commits are the human's**, with no token required |
| 3 | Push and PR open on the owner's token, run-start check, fallback disclosure (5.2, 5.3, 5.5) | The pull request is the human's |
| 4 | Merge by the accepting human (5.4) | The whole chain is honest |
| 5 | Health, refusal surfacing, notifications (5.6, 5.7) | The failures are legible |

Phase 2 is worth shipping first because it delivers half of what was asked for and
depends on nothing.

## 9. Tests

Per the repo's rule, every fix ships a test proven red by canary. Per phase:

- **Storage and resolution**: connect replaces a prior row; a token GitHub rejects is not
  saved; deleting a user cascades; `resolveGithubPrincipal` returns each of the three
  outcomes; the loader payload carries no token, no box and no data root.
- **Commit identity**: the author and committer are the owner in all three address tiers;
  a task with no owner keeps the Viberr delivery fallback.
- **Push and PR**: the owner's token is the one handed to askpass; a `refused` principal
  never reaches git; a `no-token` principal falls back AND writes the disclosure; the PR
  body names the person; the assignee is set.
- **Merge**: the accepting human's token is used, not the owner's; no token falls back.
- **Run start**: a delivering engagement with a refused owner token produces the honest
  error run and blocked packet; a non-delivering engagement with the same owner runs.
- **e2e**: presence only. The e2e stack has no GitHub credential and no network, so it
  follows the ruling 127 precedent: the profile card renders with nothing connected, and
  the flows themselves stay in unit tests.

## 10. Documentation

- **New ruling 146** in `docs/architecture/decisions.md`, recording all ten decisions,
  the two facts retired (agent commit authorship; ruling 68 for a person's own tasks) and
  why. Amend rulings 68 and 18 with dated notes rather than rewriting them.
- `docs/domain/github-delivery.md`: §1 gains the personal credential and the principal
  table; §3 the push and PR identity; §5 the approval consequence.
- `docs/ui/surfaces.md`: the profile intents and the new card.
- `docs/product/glossary.md`: "personal GitHub credential" versus "project credential".
- `docs/product/requirements-status.md`: NFR9 moves from partial toward met.
- `docs/architecture/codebase-map.md`: the new server module.

## 11. Assumptions I settled by precedent

Flagged so they can be vetoed cheaply:

1. Personal tokens require the same scopes as project credentials, `repo` and
   `pull_request:write`, validated on paste. `workflow` stays the advisory ruling 144
   made it.
2. Connecting a second token replaces the first, as agent accounts do.
3. A person's token is instance-wide, not per project, so it is validated against
   `GET /user` at connect time and proves repo access lazily at first use, naming the
   repository that refused.
4. The task owner changing mid-flight leaves an open pull request with its original
   author; later pushes use the new owner's token, and the timeline records both.
5. No org admin, and no project maintainer, can see another person's token detail.
