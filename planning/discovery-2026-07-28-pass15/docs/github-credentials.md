# Code map: GitHub + credentials

Scope: PAT storage/encryption, scope model + verification, attach/rotate revalidation, server-owned delivery (branch → push → PR), the PR lifecycle reconciler + pr-diverged recovery, merge handling, repo repair, and the GitHub client/error taxonomy. All behavior statements verified against source on 2026-07-28.

## Module map

| Concern | Module |
|---|---|
| Token crypto | `app/server/secrets/secret-box.server.ts` |
| PAT rows + project binding + health | `app/server/secrets/pat-store.server.ts` |
| Validation (network probes) | `app/server/secrets/pat-validator.server.ts` |
| Org connections (owner+PAT) | `app/server/org/connections.server.ts` |
| HTTP client | `app/server/github/github-client.server.ts` |
| Per-project client resolver | `app/server/github/github-context.server.ts` |
| Branch create/compare | `app/server/github/branch-sync.server.ts` |
| Workspace push (server) | `app/server/github/push-workspace.server.ts` |
| PR open | `app/server/github/pr-open.server.ts` |
| PR facts (state/checks/review/mergeable) | `app/server/github/pr-linker.server.ts` |
| Reconciler + merge + branch delete | `app/server/github/github-reconciler.server.ts` |
| 5-min poller + merge-pending nudge | `app/server/github/reconcile-poller.server.ts` |
| Violation side effects | `app/server/github/scope-flag.server.ts` |
| GitHub view UI + actions | `app/features/github/*` |
| Repo repair | `app/features/project-settings/settings-actions.server.ts` |

## PAT storage & encryption

- Tables (db/migrations/0001_baseline.sql:184-220): `github_pats` (id, user_id, label, `encrypted_token`, `token_suffix`, `last_validated_at`, `validation_json`), `project_github_credentials` (project_slug PK → pat_id, ON DELETE CASCADE), `github_connections` (id=slugify(owner), owner UNIQUE, pat_id, is_default, repos_count, expires_at), `scope_violations` (project_slug, task_key NULLABLE, scope, status open|resolved).
- Encryption: AES-256-GCM "secret box", format `v1$<iv>$<ct>$<tag>`, keyed from `VIBERR_SECRET_ENCRYPTION_KEY` (secret-box.server.ts:27-61). Tamper/wrong-key → typed `secret_box_invalid` AppError, never garbage plaintext (secret-box.server.ts:73-106).
- Only `getPatToken` decrypts (pat-store.server.ts:195-204); every metadata reader returns label + `tokenSuffix` (last 4) + `masked` only (pat-store.server.ts:41-79). Create validates shape (len ≥ 8, no whitespace) and audits with suffix only (pat-store.server.ts:90-125).
- One PAT per project via `setProjectCredential` upsert (pat-store.server.ts:221-245); project creation resolves the connection matching the repo OWNER and binds its PAT (project-create.server.ts:220-289 — connection is REQUIRED, creation refuses without one).
- `getDefaultConnectionToken` (StoreBrowser GitHub import) releases the decrypted default-connection token only when its cached validation is `valid` (connections.server.ts:167-174).

## Scope model

- Required set = `repo` + `pull_request:write` — owner ruling 2026-07-25 dropped mock-era `workflow`/`read:org`. Declared TWICE: `DEFAULT_REQUIRED_SCOPES` (pat-store.server.ts:36-39) and `CONNECTION_REQUIRED_SCOPES` (connections.server.ts:46-49). A project's `credentialPolicy.requiredScopes` (project.md) overrides the default list when non-empty (pat-store.server.ts:369-372).
- Scope ids are the classic-scope DISPLAY vocabulary (`pull_request:write` is not a real classic scope; it's implied by `repo` — pat-validator.server.ts:74-76). A workflow-file push that GitHub 403s surfaces as a live scope violation instead of a pre-flight chip (comment pat-store.server.ts:29-35).

## Scope verification (header / probe / assumed / violation / unchecked)

`validatePatToken` (pat-validator.server.ts:94-351): 1) `/user` identity — 401 splits expired vs revoked by message regex + cached `github-authentication-token-expiration` header (126-146,169); 5xx is honestly reported as `network_error` "the token was NOT rejected" (148-156). 2) `/repos/{r}` — 404 → `repo_not_found` (with the 404-ambiguity note), 403 mentioning approval → `org_approval_missing` (196-218). 3) Scopes:

- **Classic** (`x-oauth-scopes` header present): authoritative, `source:"header"`, with `repo`→pull_request:write and org-scope implications (72-84, 223-233).
- **Fine-grained** (no header, no introspection API): read probes (`/user/orgs`, `/repos/{r}/pulls`) plus the **empty-payload dry-run write probes** (268-286): GitHub authorizes before validating the body, so `PUT /repos/{r}/contents/viberr-scope-probe` and `POST /repos/{r}/pulls` with `body: {}` answer **422 = permission held**, **403 = refused**, anything else (404 resource-hiding, 5xx, network) = unknown → fall back to `source:"assumed"` ("granted until a real 403") (287-331). 4xx read-probe = refused; 5xx/network = unknown, not failed (241-246).

Chip assembly (`getProjectCredentialHealth`, pat-store.server.ts:359-433) overlays two more sources: an OPEN violation forces `ok:false, source:"violation"` carrying `flaggedTaskKey` (385-393); no cached validation at all → `source:"unchecked", ok:true` (397). No bound PAT → honest `configured:false, source:"none"` ALWAYS — a credentialPolicy is display-only, never rendered as configured (414-432).

UI (credential-card.tsx): only `header`/`probe`/`violation` chips render as check/miss; `assumed` + `unchecked` collapse into the "`X, Y` unproven — verified on first use" line (84-111). All-unchecked = "scopes not yet verified — Run Grant scope" warn (77-79, 142-150); ok-footer says "Every provable scope verified" when anything is unproven (152-157). Connection panel (org settings) renders per-scope `source` too (connections.server.ts:69-76 — P13-UI-01).

## Attach / rotate / revalidation

- Org connection create/replace: "nothing saved unless validation passes" — validate with `repo: null` + owner-existence `/users/{owner}` probe FIRST, then persist (connections.server.ts:224-336); replace keeps the old token active on failure (338-383). Per-actor rate limit on validation attempts (214-218). Default connection: exactly one, transactional (390-414); default can't be removed (426-434).
- Project attach/rotate (`runSetCredential`, github-actions.server.ts:104-145): always binds the **org DEFAULT connection's** PAT, then immediately re-validates WITH the project repo so fine-grained chips upgrade from all-"assumed" to probe verdicts (126-137, best-effort).
- `revalidateProjectCredential` (pat-validator.server.ts:412-532) = the Grant-scope/Re-check backend: audits every attempt with outcome (420-431); **repo-aware cooldown** (P13-D-33) reuses a `valid` cached result < 60 s old ONLY when `cached.repo` equals the target repo — a repo-less connection-modal validation never suppresses the first project-scoped run (463-489, `REVALIDATE_COOLDOWN_MS` 400). Failing/network results always re-probe. Then it resolves every open violation whose scope the fresh run reports ok — including `assumed` ok (508-523); the next real 403 reopens it.
- 30 s memoized `checkRepoAccess` per (db, project) feeds the Connection pill; every credential mutation calls `invalidateRepoAccess` (github-query.server.ts:114-156, 130; github-actions.server.ts:72,122,160).
- Expiry: captured from the response header into `expires_at`/`daysLeft`; UI-only "expires in N days" badge at ≤ 30 days (connections-panel.tsx:286-288). Nothing polls or notifies on expiry.

## GitHub client + error taxonomy

`createGithubClient` (github-client.server.ts:112-214): Bearer auth, API version pin, 20 s `AbortSignal.timeout` per request (110,137), exactly one retry on 5xx (165-167). Failures are TYPED VALUES, never throws: `{kind:"http", status, message, data, rateLimit}` / `{kind:"network"}` / `{kind:"not_modified"}` (26-55). Every service maps these into typed degraded results (`no_pat_configured`, `no_repo_configured`, `network_unavailable`, `auth_failed`, `scope_violation`, …) that the UI renders as pills/toasts (github-pills.ts:102-130, github-copy.ts). `getProjectGithubContext` is the single entry: repo from projects projection (one project, one repo — P13-D-5), token from the bound PAT (github-context.server.ts:46-78).

Rate-limit 403 vs scope 403 (DG-3): `x-ratelimit-remaining === 0` or /rate limit/i in the message → transient `rate_limited`, never a violation (branch-sync.server.ts:106-116; consumed at github-reconciler.server.ts:187-192).

## Delivery pipeline (server-owned)

Delivery is finalized server-side at the Review boundary (`openReviewPrBestEffort`, task-actions.server.ts:3069-3230):

1. **Grant gate**: `resolveDeliveryPushGrant` reads the delivering engagement's `execute-code-or-write-repo` capability; unresolvable → conservative deny; no deliverer → permissive (task-actions.server.ts:3045-3066). Withheld → `grant_withheld`, surfaced as "Delivery withheld by policy" (3100-3112); the server never stages/commits/pushes (push-workspace.server.ts:179-189 — this is the real Codex enforcement, F10-03).
2. **Push** (`pushWorkspaceBranch`, push-workspace.server.ts:124-312): locates the workspace clone (workdir → `workspace/<repoName>` → `workspace/repo` → `workspace`, 80-95), refuses unless HEAD is on a non-default branch (164-172), **auto-commits a dirty tree** as `[KEY] deliver working-tree changes from the agent run` (delivery finalization for agents told not to commit; identity falls back to `Viberr Delivery <delivery@viberr.local>`, 201-266), counts ahead-commits, then pushes `HEAD:refs/heads/<branch>` with the PAT supplied via a short-lived `GIT_ASKPASS` env (never argv/URL/config; helper resets credential.helper — git-clone-auth.server.ts:34-62). Push stderr is redacted (292-294). Failed push / no PAT still attempts the PR but surfaces "Delivery push failed" (task-actions.server.ts:3117-3129).
3. **Re-reconcile** after an auto-commit so the workRevision matches the pushed head (3136-3165; `reconcileWorkspaceDelivery` mints revisions from full head+tree sha, workspace-delivery.server.ts:342-366).
4. **PR open** (`openTaskPr`, pr-open.server.ts:140-299): a cached LIVE PR is confirmed against GitHub and reused; a TERMINAL cached PR (merged/closed) clears the way for a fresh one — the **merged-PR reuse guard** (DG-1, 166-203). Then head-branch dedup (`GET /pulls?head=owner:branch`, 211-219), then create with the composed body (task back-link, goal, change summary, newest evidence rows — 32-79, 229-243). 403 → `pull_request:write` violation (268-288); **422 → `nothing_to_review`** (empty diff, honestly not a network error, 289-294). Branch creation itself (`ensureTaskBranch`, branch-sync.server.ts:180-341) is invoked by the operator's prompt-agent path (operator-actions.server.ts:1137-1145, 1233): idempotent ref create from the default branch head, 422 "already exists" = success (246-251), 403 → `repo` violation.
- Branch name = lowercased task key only (`taskBranchName`, branch-sync.server.ts:38-40).
- Agent-side delivery (an agent that pushed/opened a PR with its own `gh` creds) is reconciled from the workspace after each run: real branch, commits (with shallow-clone deepen guard), and PR via the run's own gh auth; never fabricates, never clobbers (workspace-delivery.server.ts:198-554; PR-state mapping + accepted-guard 460-476).

## PR lifecycle reconciler — polling, no webhooks

There are **no GitHub webhooks anywhere**; truth arrives by polling + on-demand reconcile. `startGithubReconcilePoller` runs at boot and every 5 minutes (RECONCILE_POLL_MS, reconcile-poller.server.ts:21,170-196; HMR-safe global-symbol singleton, non-overlapping, unref'd), covering every non-archived project with ≥ 1 branched task (88-100). Poller ticks suppress the project audit and unchanged-provenance heartbeats (115-121; github-reconciler.server.ts:69-79,479).

`reconcileTask` (github-reconciler.server.ts:154-522) per task: branch compare (sync pill: merged > behind > synced; `unknown` when never compared — github-pills.ts:28-39), PR facts via `findPrForBranch` (pr-linker.server.ts:179-320: newest PR for head; F26 stale-terminal-PR guard when the branch advanced past it, 235-246; checks summary; review state derived from the review EVENT log with changes_requested > approved, 137-153; mergeable with "unknown = still computing" semantics, 164-173). Cache-honesty rules: failed reads keep last-known values for the same PR; settled PRs drop review/mergeable (244-260); human-set `accepted` never downgraded to `review` while the PR is open (H1 guard, 231-238); `[KEY]`-prefixed commit filter never wipes a workspace-recorded cache (276-282).

**Divergence (R8-6)**: on the TRANSITION edge only — merged-but-not-done, closed-but-active, accepted-then-closed, and the healing reopen — it writes a neutral policy-engine `note`, withdraws now-moot recommendations (transition recs on any divergence; accept_completion only when closed — owner ruling 2026-07-18, 339-365), notifies task watchers (421-444), and **fire-and-forgets `autoInvokeOperator(…, "pr-diverged")`** (453-469).

## pr-diverged operator trigger + closed-PR recovery packet

The trigger prompt (operator-run.server.ts:1592-1623) branches on snapshot PR state (snapshot exposes `pr` and `branch` precisely so packets can name them — operator-actions.server.ts:853-861):

- **closed + active**: open ONE "input" decision packet whose options are the real paths — `custom` REWORK (recommended unless rejected outright; resolution re-invokes the operator to move back + re-prompt), `archive_task` (keep branch), and `archive_task` with `deleteBranch: true` (discard entirely; the prompt names the branch). Body must say reopening on GitHub is also valid — Viberr detects it and the packet is withdrawn (1603-1612).
- **closed + terminal**: custom-options packet (reopen-and-merge on GitHub vs accept-unmerged) (1597-1602).
- **merged out-of-band**: `accept_completion` per policy, no re-prompt (1614-1617).
- **review (reopened/replaced)**: withdraw the moot packet, continue (1620-1623).

Resolution (task-actions.server.ts:3850-3881, 3964-4009): `archive_task` re-checks `approve-transition` inside the case (a contributor-owner gets an honest 403), archives via the real R14-3 contract, then best-effort `deleteTaskRemoteBranch` — which REFUSES deleting the default branch or a branch with an open/accepted PR (would silently close it), treats GitHub's 422 "Reference does not exist" as `already_gone`, and records every non-success outcome as a plain-words timeline note (github-reconciler.server.ts:859-950; task-actions.server.ts:3988-4009). `custom`/`request_edit`/`redirect` resolutions re-invoke the operator (3956-3962).

## Merge handling

- Acceptance gates are ONE helper (`acceptanceRefusalReason`, task-actions.server.ts:4113-4135): archived, stage graph, required-reviewer revisions, blocked packet, **closed PR** (schema helper task-file.schema.ts:576-583 — "Rework and reopen the PR, or archive the task"), **conflicting PR** (597-605). The operator's accept path runs the same gates before recommending OR acting (operator-actions.server.ts:1663-1701).
- `acceptCompletion` attempts the REAL merge first (4287-4305). `mergeTaskPr` (github-reconciler.server.ts:640-831): pre-reads the PR, persists a definite mergeability, and refuses `conflicting` before attempting (679-696); un-drafts via GraphQL `markPullRequestReadyForReview` best-effort (698-713, github.com-only); `PUT /pulls/{n}/merge` with 405→not_mergeable, 409→head_changed, 403→`pull_request:write` violation + `github.pr.merge_refused` audit, 404→pr_not_found (779-826). Success writes `pr.state="merged"` (dropping `mergeable`), a human-authored github event, provenance + audit, and resolves the open `pull_request:write` violation — the write is the proof (721-776).
- Unreachable merge → task still goes Done with `pr.state:"accepted"` ("merge pending", honest cause in the completion event, 4308-4338). `completeTaskMerge` finishes it later under the same acceptance authority (4422-4474). The poller nudges watchers about every accepted-but-open PR, deduped by notification title (reconcile-poller.server.ts:38-85, F12-05).
- **Admin force-accept** (DG-2): `forceAcceptCompletion` requires the `force-accept-completion` action, audits the EXACT bypassed gate via the same shared helper, then accepts with `force:true` (which also skips the unmergeable refusal) (task-actions.server.ts:4365-4419, 4302).

## Repo repair (settings)

`repairProjectRepo` (settings-actions.server.ts:198-306), owner ruling 2026-07-26: repo identity is one-per-project and not casually editable — this is the explicit repair for creation-time misconfiguration. Admin (`edit-policy`) tier; input normalized from pasted URLs (157-165); no-op when unchanged (224-230); tasks already carrying PRs/pushed commits demand `confirmFootprint` (170-180, 232-237); with a bound credential the new repo is probed live and ANY miss refuses the repair with a precise reason (404 = credential can't see it, 401 = replace token, network = try again) — "a repair must not install the next misconfiguration" (239-275); on success refreshes `defaultBranch` from GitHub, reprojects, invalidates the repo-access memo, audits from→to (277-297).

## Scope violation flow

`flagScopeViolation` (scope-flag.server.ts:111-147): idempotent row open + typed `policy` timeline event on the flagged task + `notifyTaskWatchers` fan-out (owner + admins/maintainers — E3) + reprojection; re-flagging an open row writes nothing. `resolveScopeViolationWithEvent` mirrors it (153-174). Writers: branch create/read 403 (`repo`), PR open/merge 403 (`pull_request:write`), reconcile compare 403 (`repo`, rate-limit-excluded). Reads are best-effort and never flag (github-reconciler.server.ts:226-229).

## Suspect areas

1. **Stale `workflow` in the connection failure copy** — `failureMessage` still says "Minimum scopes: repo · workflow · pull_request:write" (connections.server.ts:190-195) while `CONNECTION_REQUIRED_SCOPES` is `repo` + `pull_request:write` (46-49) and the owner ruling explicitly dropped `workflow`. A user with a classic token holding exactly the required scopes who fails for another reason is told to add a scope the product no longer wants.
2. **Rotate always re-points at the DEFAULT connection** — project creation binds the connection matching the repo OWNER (project-create.server.ts:220-289), but `runSetCredential` ("Attach"/"Rotate credential") binds `getDefaultConnection` unconditionally (github-actions.server.ts:110-119). In a multi-connection org, rotating a project whose repo lives under a non-default owner silently swaps it onto a different owner's PAT — likely breaking repo access with no warning beyond the later probe.
3. **Required-scope set defined twice** — `DEFAULT_REQUIRED_SCOPES` (pat-store.server.ts:36) and `CONNECTION_REQUIRED_SCOPES` (connections.server.ts:46) are separate identical constants; editing one without the other would make the connection gate and the project chips disagree.
4. **`github.pr.opened` audit fires on every reuse** — `writePrToTask` records the audit unconditionally, `created` only a detail flag (pr-open.server.ts:369-377). Every Review transition that re-confirms an existing PR appends another "opened" audit row.
5. **Non-fast-forward push has no recovery** — `ensureTaskBranch` creates the remote branch at the default-branch head; if the workspace branch has diverged history (agent rebased, reused workspace), `git push` (not force, push-workspace.server.ts:285-294) fails and surfaces only the generic "Delivery push failed… check the credential and re-scan" (task-actions.server.ts:3117-3129) — the copy blames credentials for a history problem.
6. **`reconcileProject` runs all tasks in parallel** (Promise.all, github-reconciler.server.ts:559-563) and each task costs ~3-6 API calls; the 5-min poller multiplies that across projects. DG-3 makes rate-limit 403s non-destructive, but a large board can burn the PAT's budget every tick — no per-tick concurrency cap or backoff exists.
7. **Validation staleness is unbounded for the connection gate** — `getDefaultConnectionToken` trusts `validationState === "valid"` forever (connections.server.ts:167-174); nothing re-validates org connections on a schedule, and token expiry only ever surfaces as the ≤30-day badge (connections-panel.tsx:286-288). A revoked default-connection token keeps passing this gate until someone manually re-checks.
8. **Project-level violations (task_key NULL) are silent** — the schema allows a violation without a task (0001_baseline.sql:200-210) and `flagScopeViolation` skips the event + notification entirely when `taskKey` is null (scope-flag.server.ts:125-145). No current writer passes null, but any future one would open rows nobody is told about.
9. **`revalidateProjectCredential` resolves violations on "assumed" evidence** — deliberate per the comment (pat-validator.server.ts:406-410, 508-523), but it means Grant-scope can clear a real `pull_request:write` violation using a fine-grained token probe that proved only READ, when the dry-run write probe was skipped (e.g. pullsReadOk not true). The violation reopens only at the next live 403.
10. **Draft un-draft GraphQL endpoint** would be wrong on GHE (`${base}/graphql` vs `/api/graphql`) — acknowledged in-code as github.com-only (github-reconciler.server.ts:700-705); fine until a non-default baseUrl is ever wired (`githubWebHost` already anticipates GHE, github-client.server.ts:225-235).

## Open questions

1. Should "Rotate credential" offer a connection PICKER (or at least prefer the connection matching the repo owner) instead of silently binding the org default? (Suspect 2.)
2. Is 5-minute polling the accepted long-term design, or should webhooks (or conditional requests — the client supports ETags but no reconciler passes one) reduce latency and rate-limit spend?
3. Should org-connection tokens be re-validated on a schedule and expiry/expired states pushed as notifications, rather than a badge visible only on the org-settings page?
4. When a delivery push fails non-fast-forward, what is the intended recovery — force-push with lease under the server's PAT, a fresh branch, or a decision packet? Today it dead-ends in a log-plus-warning.
5. The dry-run contents probe PUTs to `viberr-scope-probe` at the repo root — is that path guaranteed harmless on every repo (e.g. branch protections that log 422s, org audit noise), and should the probe path be namespaced/configurable?
6. `project_github_credentials` cascades on PAT delete, so removing a non-default org connection silently unbinds every project riding it (connections.server.ts:435-436 → deletePat → CASCADE). Should removal warn about (or refuse on) bound projects the way default-removal is refused?
