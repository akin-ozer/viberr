# Code-gaps sweep — pass 4 (2026-07-12)

Quality sweep of `app/`, `scripts/`, `e2e/`, `test-support/` on branch `full-pass-2026-07-12`
(base bdcce97). Method: five parallel domain audits (runtime/operator/SSE · routes/guards/
projections · UI features/components · auth/org/github/scripts · cross-surface capability/stage
consistency), every finding verified against the surrounding code (no grep-only claims), merged
and deduped here. Security findings are out of scope this pass by owner instruction; missing-guard
*parity* gaps are reported factually as inconsistencies.

Severity: **HIGH** = broken user-visible behavior · **MED** = wrong-but-survivable or dead weight
· **LOW** = polish.

Counts: **56 findings** — 10 HIGH · 23 MED · 23 LOW.

| Class | Total | HIGH | MED | LOW |
|---|---|---|---|---|
| Mock / placeholder / unwired | 6 | 1 | 4 | 1 |
| Wrong / poor implementation | 17 | 3 | 8 | 6 |
| Cross-surface inconsistency | 14 | 6 | 6 | 2 |
| Dead code & migration leftovers | 11 | 0 | 3 | 8 |
| Design-token drift | 2 | 0 | 1 | 1 |
| Env & doc drift | 6 | 0 | 1 | 5 |

Toolchain baseline: `npm run typecheck` is clean. The full `npm test` run fails wholesale in the
audit sandbox with a better-sqlite3 NODE_MODULE_VERSION 147-vs-137 ABI mismatch (native module
compiled under a different Node than the one running vitest) — an **audit-environment artifact,
not an app finding**; DB-free test files pass individually. Re-verify suite health after
`npm rebuild better-sqlite3` under Node 26.

---

## 1. Mock / placeholder / unwired

### MU-1 (HIGH) — Profile "Connect" GitHub button links to a nonexistent route, 404s
- File: `/Users/akinozer/projects/viberr/app/features/profile/profile-page.tsx:519`
- `<a className="btn sm" href="/auth/github?returnTo=/profile">` — `app/routes.ts` defines no
  `/auth/*` route (better-auth is mounted only at `api/auth/*`). Clicking Connect lands on the
  ErrorBoundary "Page not found". The working pattern (login.tsx:319) POSTs to
  `/api/auth/sign-in/social` and follows the returned URL. Disconnect works; Connect is dead.

### MU-2 (MED) — `onPhase` wired end-to-end but no adapter ever emits it; Live-run phase/step is seed-only
- File: `/Users/akinozer/projects/viberr/app/server/runtimes/adapter.server.ts:91` (sink wiring
  run-service.server.ts:383; UI runs-panels.tsx:178–183)
- `RunCallbacks.onPhase` → `sink.phase()` → `patchRun({phase, step})` is fully plumbed, but none
  of the claude/codex/simulated adapters call `cb.onPhase`. Only seed rows have a phase; every
  real run renders an empty phase block next to the spinner in `LiveRunPanel`.

### MU-3 (MED) — Board "Re-scan" shown to everyone; server 403s non-maintainers and the error is swallowed
- File: `/Users/akinozer/projects/viberr/app/features/board/board-page.tsx:583` (button), 905–911
  (effect); action at `app/routes/project.board.tsx:83`
- `rescan()` pushes a "Re-scanning the task store…" toast immediately; the completion effect only
  handles `rescanFetcher.data?.ok`. The action gates on `["admin","maintainer"]` and returns
  `{ok:false,error}` that nothing reads — a viewer sees "Re-scanning…" then silence.

### MU-4 (MED) — Home "Re-scan" same pattern: rendered for all, admin-gated server-side, 403 silently ignored
- File: `/Users/akinozer/projects/viberr/app/features/home/home-page.tsx:1121` (button), 1208–1225
  (effect); action at `app/routes/_index.tsx:80`
- `StoreStrip` gates only Rebuild on `isAdmin`. The rescan action returns a 403 message for
  non-admins ("used to be ungated", per its own comment); the fetcher's type has no `error` field
  and the effect only toasts on success.

### MU-5 (MED) — Login flash cookie has readers but no writer; OAuth whitelist rejections never reach /login
- File: `/Users/akinozer/projects/viberr/app/server/auth/login-flash.server.ts:9` (reader at
  login.tsx:47)
- Module exports only `readLoginFlash`/`clearLoginFlash`; nothing ever sets `viberr_login_flash`.
  Since better-auth took over the OAuth callback, a whitelist rejection (create.before hook in
  app/lib/auth.server.ts:141) surfaces on better-auth's own `/api/auth/error` page. The
  documented rejected-OAuth UX is gone; the read path is a migration leftover.

### MU-6 (LOW) — Operator `accept_completion` tool description promises a merge the code never performs
- File: `/Users/akinozer/projects/viberr/app/server/tasks/operator-toolkit.server.ts:326`
- The tool tells the model it "moves the task to Done and marks the review PR merged", but
  `operatorAcceptCompletion` deliberately records "accepted, merge pending" and never merges —
  the model is fed a false contract.

---

## 2. Wrong / poor implementation

### WI-1 (HIGH) — Review queue filters the literal stage id `"review"`; rail badge uses `resolveStageRoles` — permanent drift on lightweight/custom boards
- File: `/Users/akinozer/projects/viberr/app/server/projections/review-queue.server.ts:47` vs
  `app/routes/project.tsx:50–56`
- `listProjectTasks(db, slug).filter((t) => t.stage === "review")` while the rail badge counts
  via `resolveStageRoles(...).reviewId`. Its own docblock claims "the two counts can never drift"
  — false since the stage-roles rework. A Lightweight project (todo/doing/done — a first-class
  template) resolves reviewId to `doing`: the rail shows a Review count while
  `/projects/:slug/review` is permanently empty. stage-roles.ts exists precisely because
  "NOTHING in the app may hard-code the literal ids"; this file was never migrated.

### WI-2 (HIGH) — Admin email change updates only the legacy `users` row; better-auth never synced → user locked out
- File: `/Users/akinozer/projects/viberr/app/server/org/org-users.server.ts:239`
- `UPDATE users SET email = ?` with no corresponding write to better-auth's `"user"` table
  (writers live only in identity.server.ts; `updateOrgUser` calls none). Credential sign-in
  resolves email in better-auth's table (login.server.ts:98): new email → "wrong_password";
  old email → legacy pre-check fails → "unknown_email". Sign-in impossible either way until
  `provisionIdentity` is re-run.

### WI-3 (HIGH) — `deleteOrgUser` orphans the better-auth identity; re-creating the same email 500s mid-flow
- File: `/Users/akinozer/projects/viberr/app/server/org/org-users.server.ts:318`
- `DELETE FROM users WHERE id = ?` with no `deleteIdentity()`/`revokeUserSessions()` (contrast
  oauth-provision.server.ts:84–85). better-auth `user`/`account`/`session`/`member` rows persist;
  `user.email` is `NOT NULL UNIQUE` (migration 0013), so re-creating that email passes the legacy
  duplicate check, inserts the legacy row, then `provisionIdentity`'s insert throws a raw
  SQLITE_CONSTRAINT (createUser is not transactional) → 500 with a half-created user.

### WI-4 (MED) — Codex session resume silently ignores the model/effort override the API promises
- File: `/Users/akinozer/projects/viberr/app/server/runtimes/codex-runtime.server.ts:169–174`
- `resumeRun` documents that a comment-resume picks up the profile's CURRENT model, and
  `commentToAgent` passes `model`/`effort`. The Claude adapter applies them; the Codex resume
  call passes only `{ workingDirectory, skipGitRepoCheck, sandboxMode }` — the resumed run
  executes on the SDK default model while the run row and Agent-logs header display the override.

### WI-5 (MED) — Concurrent tail fetches in the run-log SSE consumer duplicate console lines
- File: `/Users/akinozer/projects/viberr/app/features/runtime/use-run-log-stream.ts:95–134`
- `fetchTail(runId, since)` advances `cursor.headSeq` only after the response lands; no in-flight
  guard or seq-dedupe on append. Two `run.log-appended` events inside one round-trip (typical
  Claude burst) both fetch `since=<same seq>` and both append — duplicated lines until the next
  loader reseed.

### WI-6 (MED) — Cross-boot operator-lease release passes no token; double-chained releases can evict a successor's lease
- File: `/Users/akinozer/projects/viberr/app/server/runtimes/operator-run.server.ts:240`
- `chainRunCompletion(inflight.id, () => releaseOperatorLease(db, leaseKey))` omits `token`, and
  `releaseOperatorLease` skips its stale-release guard when token is undefined. Two triggers
  coalescing on a DB-inflight run chain two releases; the first fires the queued trigger (fresh
  lease acquired synchronously), the second — tokenless — deletes the successor's lease,
  reopening the pre-token double-drive window the token mechanism (lines 164–186) was built to close.

### WI-7 (MED) — `interruptRun` returns the wrong RunView (and runs the projection twice; nobody reads it)
- File: `/Users/akinozer/projects/viberr/app/server/runtimes/run-service.server.ts:539–541`
- `projectRunsForTask(...).find((r) => r.id === run.thread_id) ?? projectRunsForTask(...)[0]!` —
  since the grouping rework `RunView.id` is the group *representative's* thread id, so
  interrupting a non-representative row falls back to an arbitrary group (usually the operator).
  Sole caller (project.task.tsx:301) reads only `outcome`, so `InterruptResult.run` is both wrong
  and dead weight.

### WI-8 (MED) — Per-task-row prepared statement + user query in `listProjectTasks` (n+1 in the hottest loader path)
- File: `/Users/akinozer/projects/viberr/app/server/projections/board-query.server.ts:98–106, 121–127`
- `resolveTaskOwner` creates `createActorResolver(db, ...)` per call and `listProjectTasks` calls
  it inside `rows.map(...)` — fresh `db.prepare` + empty-cache users lookup per owned row.
  `createActorResolver`'s own doc says "create one per request/query and map many rows through
  it". Flows through `getBoard` (re-run on every navigation and project-scope SSE revalidation),
  home, github, review loaders.

### WI-9 (MED) — Home page: double per-project membership query + all-task-rows-in-JS aggregation
- File: `/Users/akinozer/projects/viberr/app/features/home/home-query.server.ts:80–97`
- `listHomeProjectsForUser` calls `listHomeProjects(db)` (already `listProjectTasks` +
  `listProjectMembers` + a new actor resolver per project), then re-queries
  `listProjectMembers(db, p.slug)` per project for non-admins. Counts are computed by loading
  full task rows (JSON blob columns included) into JS instead of a `GROUP BY` like
  settings-query.server.ts uses. ~5+ queries per project on `/`, revalidated on every
  all-projects SSE event.

### WI-10 (MED) — GitHub view: per-branch provenance query inside `.map` + uncached live GitHub API call on every revalidation
- File: `/Users/akinozer/projects/viberr/app/features/github/github-query.server.ts:100–112` (and :92)
- `behindByFor(db, t.filePath)` re-prepares and runs one provenance query per branch row inside
  `tasks.filter(...).map(...)`. Line 92 awaits `checkRepoAccess` (live `GET /repos/:repo`, no
  cache) inside the loader, which project-scope SSE revalidates on every task/project event while
  the view is open — every board mutation costs a GitHub round-trip and rate-limit budget.

### WI-11 (MED) — Task goal editor swallows server errors; save fails silently with the editor left open
- File: `/Users/akinozer/projects/viberr/app/features/task-detail/task-detail-page.tsx:320–329`
- `goalFetcher` has no `useActionFeedback` (every other fetcher on the page does); the only
  effect closes the editor on `data?.ok`. An `{ok:false,error}` from `update-goal` is never
  rendered or toasted. (Also `onSubmit={() => setEditing(true)}` at :358 is a no-op.)

### WI-12 (LOW) — org/settings action authenticates twice per mutation
- File: `/Users/akinozer/projects/viberr/app/routes/org.settings.tsx:97–98`
- `requireRole(request,"admin")` already runs the full `authenticate()`; the following
  `requireAuth(request)` repeats it just for `sessionId`. Every one of the 30+ intents pays two
  session lookups; siblings do one `requireAuth` + role check on `ctx.user`.

### WI-13 (LOW) — Guard-order inconsistency: review/activity loaders 404-check before the membership guard; siblings guard first
- File: `/Users/akinozer/projects/viberr/app/routes/project.review.tsx:22–28` (same
  project.activity.tsx:36–43)
- `if (!getProject(...)) throw 404; await requireProjectMember(...)` vs
  agents/policy/github/settings which call `requireProjectMember` first. Parent layout's
  `requireUser` masks the difference on document requests; the inversion has no stated reason.

### WI-14 (LOW) — profile action maps only `kind === "user"` AppErrors; every sibling maps all AppErrors
- File: `/Users/akinozer/projects/viberr/app/routes/profile.tsx:117`
- `if (isAppError(error) && error.kind === "user") return data({ok:false,...}); throw error;` —
  all other routes use plain `isAppError(error)`. An infrastructure-kind AppError from a profile
  mutation crashes the overlay's error boundary instead of returning the `{ok:false}` shape the
  fetcher UI expects.

### WI-15 (LOW) — Claude adapter interrupt is lost if it lands before the SDK query is constructed
- File: `/Users/akinozer/projects/viberr/app/server/runtimes/claude-runtime.server.ts:332–338`
- `interrupt()` sets a flag and calls `queryHandle?.interrupt()`; during the `await realQuery()`
  dynamic-import window `queryHandle` is null, the abort is never delivered, and the for-await
  loop (never checking `interrupted` mid-stream) consumes — and bills — the entire run before
  settling "interrupted".

### WI-16 (LOW) — Simulated-fallback raw `.jsonl` lands under the requested backend's dir; the "set per-line" comment is false
- File: `/Users/akinozer/projects/viberr/app/server/runtimes/run-sink.server.ts:95` (and :149)
- `appendRawLine(effectiveBackend, ...)` runs per line but `effectiveBackend` is only assigned in
  `finalize()` — after all lines are appended. Fallback runs write raw truth under
  `runtimes/claude|codex/` instead of `runtimes/simulated/`. Impact confined to on-disk layout
  (nothing reads these files back — see DC-1).

### WI-17 (LOW) — GitHub view hardcodes `https://github.com`, breaking the GHE-safe host convention
- File: `/Users/akinozer/projects/viberr/app/features/github/github-view.tsx:462`
- `` href={`https://github.com/${data.project.repo}`} `` — the task-detail panel deliberately
  threads `githubHost` from the loader (project.task.tsx:124: "the client never hardcodes
  github.com"). On a GHE deployment this page's "Open on GitHub" links to the wrong host.

---

## 3. Cross-surface inconsistency (UI promise vs server vs agent runtime)

### XS-1 (HIGH) — Comment/@mention resume drops every run confinement the fresh-run path establishes
- File: `/Users/akinozer/projects/viberr/app/server/runtimes/run-service.server.ts:300–359`
  (`resumeRun` input type) vs `app/server/tasks/specialist-run.server.ts:528, 638–644` (start
  path) and `app/server/tasks/task-actions.server.ts:858–889` (`commentToAgent` call);
  workdir fallback `app/server/tasks/agent-reply.server.ts:418–430`
- *(Found independently by both the runtime and cross-surface audits.)* `startSpecialistRun`
  threads `disallowedTools` (capability denylist), `env: workspaceRunEnv(...)`
  (GIT_CEILING_DIRECTORIES), `mcpServers`, and the persona `systemPrompt` into every run —
  `resumeRun`'s input has **none of those fields**, and its only caller passes only
  `model/effort/agentName/workdir/autonomous`. A specialist whose `commit-push-branch` /
  `execute-code-or-write-repo` is withheld runs confined once, then runs **unconfined
  (bypassPermissions, full default toolset, no git ceiling, no persona/skills/KB/MCPs)** whenever
  anyone @mentions it — and `resumeWorkdir`'s fallback returns the bare task dir inside the data
  root, the exact "run switched the host checkout onto its task branch" hazard
  specialist-run.server.ts:1214–1248 documents as must-never-happen. The matrix modal badge
  promises these caps "bind tools on Claude runs" (capability-matrix-modal.tsx:156).

### XS-2 (HIGH) — Policy page and task detail promise an unconditional human-only Done; the code ships a deliberate agent exception
- File: `/Users/akinozer/projects/viberr/app/features/policy/policy-page.tsx:371–378, 250–258`
  and `app/features/task-detail/task-detail-page.tsx:226` vs
  `app/server/tasks/operator-actions.server.ts:1191, 1220–1259` and
  `app/features/home/project-create.server.ts:68–90`
- Policy page renders unconditionally: "Only a human can accept completion … no agent profile can
  be granted this boundary", plus "Transition a task to Done · all profiles" (ALWAYS_HUMAN). But
  `operatorAcceptCompletion` under `autonomy === "full"` + `completion-for-acceptance: direct`
  sets `stage = doneStageId` itself, and the "auto" project preset grants exactly that. The
  exception is deliberate (owner ruling Q1) — the copy was never updated, so an auto-preset
  project's UI states an invariant its own default configuration breaks.

### XS-3 (HIGH) — Per-transition "Human only" / "Human approval" boundary settings are not enforced against a direct operator
- File: `/Users/akinozer/projects/viberr/app/features/policy/policy-page.tsx:344–358` (+
  policy-data.ts:48–52) vs `app/server/tasks/task-actions.server.ts:2142–2151` and
  `app/server/tasks/operator-actions.server.ts:193–199, 1093–1094`
- For humans `transitionStage` maps boundaries to `approve-transition`/`accept-completion` RBAC;
  the operator branch skips boundary checks entirely (only the terminal stage is protected).
  `operatorTransitionStage` consults only the operator's own `stage-transitions` capability, and
  full autonomy promotes `recommend` → direct for everything except completion — so the operator
  crosses a boundary labeled "Human approval"/"Human only" with no human involved. The default
  governed template's impl→review is "approval", so this is default-board behavior under full
  autonomy, not a custom-workflow corner.

### XS-4 (HIGH) — `create-task-branch` denial is bypassed by the exact command every specialist prompt instructs (`git checkout -B`)
- File: `/Users/akinozer/projects/viberr/app/server/tasks/specialist-tool-policy.ts:34–37` vs
  `app/server/tasks/specialist-run.server.ts:1047`
- Deny rules cover only `Bash(git checkout -b:*)` / `Bash(git switch -c:*)`. The delivery
  contract embedded in **every** specialist prompt instructs `` `git checkout -B ${branch}` `` —
  `-B` (and `git switch -C`, `git branch X && git checkout X`) match neither specifier. A profile
  whose `create-task-branch` is `human`/`off` — shown "Claude-enforced" in the matrix — is
  simultaneously *told* to run and *able* to run the uncovered variant. (The F11 note at :48–56
  explains the removal of a different rule; it does not cover this gap.) The prompt's delivery
  contract is also emitted regardless of withheld delivery capabilities.

### XS-5 (HIGH) — Reviewer verdict capabilities drive real state changes regardless of their mode; "advisory" caps are never even injected
- File: `/Users/akinozer/projects/viberr/app/features/agents/capability-catalog.ts:50–58` vs
  `app/server/tasks/task-actions.server.ts:1627–1635, 1365–1442`; advisory claim
  `app/shared/capabilities.ts:12–13`
- The modal/matrix let an admin set `approve-review`/`request-changes`/
  `report-validation-verdict` to `human` ("Reserved for humans" lock dot), but
  `registerAgentCompletion` runs `recordReviewerVerdict(...)` for **every** finished reviewer run
  with zero capability consult; the parsed verdict flips `validation` healthy/failing — which is
  what unblocks `operatorAcceptCompletion`. Additionally capabilities.ts claims advisory caps are
  "advisory guidance injected into the run persona" — `buildSpecialistPersona`/
  `buildAnalyzePrompt` inject definition+skills+KB only, never the grants: advisory caps are
  neither enforced nor advised.

### XS-6 (HIGH) — `merge-pull-request` classified as enforced on "both" backends; the Codex runtime carries no restriction at all
- File: `/Users/akinozer/projects/viberr/app/shared/capabilities.ts:122–133, 138–146` vs
  `app/server/runtimes/codex-runtime.server.ts:168` (and no `disallowedTools` consumption
  anywhere in the adapter); `app/server/github/workspace-delivery.server.ts:31–35`
- capabilities.ts deliberately classifies `merge-pull-request` as "both" (so the matrix shows no
  Claude-only caveat), but the Codex adapter never reads `spec.disallowedTools` and runs
  `sandboxMode: "danger-full-access"` — a Codex specialist can run `gh pr merge` with the
  machine's own credentials (as workspace-delivery's header itself documents), and
  `mapGhStateToCache` will faithfully reconcile the PR as merged.

### XS-7 (MED) — Codex operator run: full-access shell in the server's own cwd; no equivalent of the Claude operator's tool denials
- File: `/Users/akinozer/projects/viberr/app/server/runtimes/operator-run.server.ts:400–416` vs
  `app/server/runtimes/claude-runtime.server.ts:112–119, 261–265`
- Claude operator runs deny `Bash/Edit/MultiEdit/Write/NotebookEdit/Task`; `startCodexOperatorRun`
  passes `autonomous: true` with no `workdir` and no `env` — the codex thread spawns
  `danger-full-access` in the server process's working directory (specialists at least get an
  isolated workspace + GIT_CEILING). Plan execution goes through the same gates (good parity),
  but the agent process itself is unconfined while the seeded operator profile displays
  `execute-code-or-write-repo: human`.

### XS-8 (MED) — `execute-code-or-write-repo` is enforced at the tool layer but inexpressible in the profile UI
- File: `/Users/akinozer/projects/viberr/app/server/tasks/specialist-tool-policy.ts:44–47` vs
  `app/features/agents/capability-catalog.ts:37–70` (MODAL_CAP_IDS) and
  `app/features/agents/agent-profile-actions.server.ts:173–183`
- The headline "REAL teeth (D1/Q4)" deny rule fires only on an explicit `human`/`off` grant — but
  the id is in neither modal catalog, and `createModalGrants` drops non-modal ids. Only
  seed-authored profiles can carry it; for every app-created specialist the write-confinement is
  unreachable, surfacing in the matrix only under "Other actions".

### XS-9 (MED) — `manage-members` exists in the matrix and Policy table but is never consulted; member-role changes are guarded as `edit-policy`
- File: `/Users/akinozer/projects/viberr/app/shared/rbac.ts:92, 124` vs
  `app/features/policy/policy-actions.server.ts:59–70`
- `setMemberRole` routes through `requireProjectAdmin` → `assertProjectAction("edit-policy",…)`.
  Same tier today, but editing `manage-members` in ACTION_ROLES would change the displayed table
  without changing enforcement — a single-source bypass of exactly the kind the rbac.ts header
  forbids.

### XS-10 (MED) — `reconcile-github` / `grant-github-scope` enforced only by hardcoded role strings (plus two hardcoded `run-agents` sites)
- File: `/Users/akinozer/projects/viberr/app/shared/rbac.ts:81, 89, 54` vs
  `app/routes/project.github.tsx:55–96`, `app/server/runtimes/run-service.server.ts:448–455`,
  `app/routes/project.task.tsx:424–434`
- No `requireAction`/`roleCan` call exists for either action; the github route uses
  `if (!myRole || myRole === "viewer")` and `if (myRole !== "admin" && myRole !== "maintainer")`.
  `interruptRun` and the `run-operator` route action likewise hardcode the tier rbac.ts assigns
  to `run-agents`. All currently-equivalent tiers, but each site decouples ACTION_ROLES (what the
  Policy page displays) from the guard.

### XS-11 (MED) — Advisory capability rows render identically to enforced rows in every capability surface
- File: `/Users/akinozer/projects/viberr/app/features/agents/capability-matrix-modal.tsx:146–160`,
  `app/features/policy/policy-page.tsx:228–241`, `app/features/agents/agents-page.tsx:328–338` vs
  `app/shared/capabilities.ts:135–152`
- `capabilityEnforcement()` distinguishes both/claude-only/advisory and the catalog header says
  the UI should "label the difference rather than overstating authority" — but only the
  claude-only case gets a badge; the 13 advisory ids (11 toggleable) get plain mode dots, and the
  Policy per-profile counts and Agents columns make no distinction. A `human` dot on
  `move-task-to-review` (decoration) looks identical to one on `transition-to-done`
  (structurally locked).

### XS-12 (MED) — Execution-profile owner controls ignore the Q5 viewer restriction — viewers get buttons that 403
- File: `/Users/akinozer/projects/viberr/app/features/task-detail/execution-profile.tsx:83, 118–147`
- `return myRole ? (<button … Assign me>)` — any member incl. viewer sees "Assign me", and the
  Manage menu offers take-over/hand-off to everyone; server `setOwner`/`releaseOwner` require
  `own-task` = contributor+ (rbac.ts:80), so a viewer's click 403s (error does surface as a
  toast). The sibling `CurrentStatePanel` (task-detail-page.tsx:691) was fixed to gate on
  `canOwn` with a "hide rather than render a button that 403s" comment; this panel wasn't. Stale
  copy "Unowned — open to any project member" (:95, :667) repeats the wrong claim.

### XS-13 (LOW) — Specialist write-denial omits `MultiEdit` (which the operator denial list still names) and shell-level writes
- File: `/Users/akinozer/projects/viberr/app/server/tasks/specialist-tool-policy.ts:44–47` vs
  `app/server/runtimes/claude-runtime.server.ts:112–119`
- Operator denies `["Bash","Edit","MultiEdit","Write","NotebookEdit","Task"]`; the specialist
  `execute-code-or-write-repo` rule denies only `["Edit","Write","NotebookEdit","Bash(git commit:*)"]`
  — MultiEdit (if present) and Bash file writes (`sed -i`, redirection) remain while the
  docstring claims the specialist "cannot edit files".

### XS-14 (LOW) — Policy-page footnote contradicts the RBAC matrix rendered beside it on ownership tiers
- File: `/Users/akinozer/projects/viberr/app/features/policy/policy-page.tsx:165–176` vs
  `app/shared/rbac.ts:80` and `app/server/tasks/task-actions.server.ts:1894–1897`
- *(Flagged by both the UI and cross-surface audits.)* The pol-note says "any project member may
  take or release task ownership", but `own-task` is contributor+ (Q5: viewer is strictly
  read+comment) and the guard 403s viewers. Stale pre-Q5 copy on the one page whose stated
  contract is "display and enforcement can never drift".

---

## 4. Dead code & migration leftovers

### DC-1 (MED) — `line-buffer.server.ts` is dead code with a false docstring
- File: `/Users/akinozer/projects/viberr/app/server/runtimes/line-buffer.server.ts:31`
- `createLineBuffer` is imported only by its own test (repo-wide grep). The docstring claims
  "this parser reads those files back (projection rebuild, offline inspection)" — nothing
  anywhere reads the raw `.jsonl` files (`rawLogPath`/`appendRawLine` have writers only).

### DC-2 (MED) — better-auth organization-plugin tables are written on every user create/role change but never read
- File: `/Users/akinozer/projects/viberr/app/server/auth/identity.server.ts:36, 108–120, 133`
- `ensureDefaultOrg`, the `member` upserts, and `setMemberRole` maintain `organization`/`member`
  rows; the only read anywhere is identity.server.ts's own existence check. No code reads
  `member.role`, `invitation`, or `activeOrganizationId` — role checks all go through
  `users.role`/`app/shared/rbac.ts`. The Option-B membership surface is write-only weight today.

### DC-3 (MED) — Dead component: `Identity` (and its exported `IdentityWho`) in app/ui
- File: `/Users/akinozer/projects/viberr/app/ui/identity.tsx:41–102`
- `Identity` is module-private and never called anywhere; `IdentityWho` is exported but
  referenced only by `Identity` itself. Mock leftover — "surfaces that use them" never arrived.

### DC-4 (LOW) — `readProjectFile` imported but unused in three action modules
- File: `/Users/akinozer/projects/viberr/app/features/policy/policy-actions.server.ts:10` (also
  settings-actions.server.ts:14, agent-profile-actions.server.ts:11)
- All three import `{ readProjectFile, updateProjectFile }` but reference only
  `updateProjectFile` — leftovers from the pre-`assertProjectAction` hand-rolled guards; no
  `noUnusedLocals` to flag them.

### DC-5 (LOW) — Vestigial "invited" membership status: read model + UI keep a state the invite flow stopped writing
- File: `/Users/akinozer/projects/viberr/app/features/project-settings/membership.server.ts:48–51`
  (UI settings-page.tsx:374, 428)
- The reader derives `status === "invited"` and the settings page renders a pending counter,
  "Invited" pill and "Revoke invite" title — but settings-actions.server.ts:380–383 (X15) now
  writes plain `{ userId, role: "viewer" }` ("we no longer stamp a decorative status: invited").
  Unreachable except via legacy files; the module doc is stale.

### DC-6 (LOW) — `StoreBrowser` accepts a `root` prop that is never used
- File: `/Users/akinozer/projects/viberr/app/features/kb-browser/store-browser.tsx:587, 597`
- `root: string` (doc: 'e.g. "store://kb/api-contracts"') is destructured but referenced nowhere;
  both call sites (resources-panel.tsx:1053, 1064) pass real URIs for nothing.

### DC-7 (LOW) — `StageMenu` `variant="card"` / `align` options and their CSS are dead
- File: `/Users/akinozer/projects/viberr/app/ui/stage-menu.tsx:36–38` (CSS app.css:626–630)
- Only usage is task-detail-page.tsx:628 with `variant="panel"`, default align. The board
  replaced per-card dropdowns with drag-and-drop; board-page.tsx:740's prop doc ("enables the
  per-card stage-move dropdown") is stale.

### DC-8 (LOW) — Empty no-op branch in run-service resume path
- File: `/Users/akinozer/projects/viberr/app/server/runtimes/run-service.server.ts:325–327`
- `if (prev.backend === "simulated") { /* comment only */ }` — an empty branch.

### DC-9 (LOW) — Committed selftest marker files from one-off live delivery tests
- File: `/Users/akinozer/projects/viberr/test-support/selftest/T1.md` (also selftest2/R1.md,
  selftest3/C04.md)
- Three tracked one-line markers landed via delivery-test PRs #4/#8/#10 (22a146f, fbbb2fd,
  703ac33). Nothing in app/, scripts/, e2e/, or configs references them.

### DC-10 (LOW) — `AgentDeploymentDefinition` is defined twice and has already diverged
- File: `/Users/akinozer/projects/viberr/app/schemas/project-file.schema.ts:109` vs
  `app/features/agents/agents-query.server.ts:33`
- The zod-inferred schema type is exported but unused; agents-query hand-mirrors it as an
  interface and adds `resources?: { skills/mcps/kb }` the schema never enumerates (it survives
  only via `.loose()`). Two sources of truth for the same file shape, drifting.

### DC-11 (LOW) — Unused type/const exports (batch)
- Files: `app/schemas/github-pat.schema.ts:28` (`PatValidationStatus`),
  `app/schemas/project-file.schema.ts:35` (`Boundary`), `:74` (`ProjectMember`),
  `app/schemas/task-file.schema.ts:52` (`TimelineEventType`),
  `app/server/github/github-client.server.ts:57` (`GithubFailure`),
  `app/features/live-updates/event-types.ts:11` (`SseEvent` re-export)
- Verified via ts-prune + repo-wide grep: exported, never imported anywhere (tests included).
  Also export-only-internal (used in module, never imported): `profileFormSchema`
  (agent-profile-actions.server.ts:64), `LOCKED_BOUNDARY_MESSAGE` (policy-actions.server.ts:170).

---

## 5. Design-token drift

The client code is otherwise clean: zero hex/rgb/Tailwind color literals in any .tsx/.ts —
inline styles use `var(--*)` exclusively. The hex palettes in `home-query.server.ts:30–35` and
`app/shared/workflow/templates.ts:27–31, 69–71` are deliberate server-side accent/stage *data*
(project-file.schema.ts:50: hex or var(--*) both accepted, ruling 15) — not drift.

### TD-1 (MED) — Operator glyph is white-on-white in dark mode (hardcoded `#fff` missed by the dark fixups)
- File: `/Users/akinozer/projects/viberr/app/app.css:1094`
- `.agent-glyph.op { background: var(--fg); color: #fff; … }`. Dark theme sets `--fg: #eceef4`
  (:1935); the dark fixup block (:1961–1970) overrides `.gh-bar`/`.toast`/`.tl-node.github` but
  not `.agent-glyph.op` — the operator shield renders #fff-on-near-white everywhere it appears
  (decision packet, execution profile, live roster, mention menu).

### TD-2 (LOW) — `.pj-star.on` raw `#e8a800` with no token or dark override
- File: `/Users/akinozer/projects/viberr/app/app.css:2668`
- The lone off-token accent without a variable or dark pairing (visually survivable on dark).
  Remaining raw hex in app.css (`.pill.done`, `.agent-glyph.codex/.claude`, the always-dark
  `.console` palette) all have explicit dark fixups or are deliberately theme-invariant.

---

## 6. Env & doc drift

### ED-1 (MED) — .env.example missing `BETTER_AUTH_URL` / `BETTER_AUTH_SECRET` / `CLAUDE_CONFIG_DIR`
- File: `/Users/akinozer/projects/viberr/.env.example:17` vs
  `app/server/config/env.server.ts:31, 42, 104`
- env.server.ts declares `BETTER_AUTH_URL` "REQUIRED behind a reverse proxy" (pr-open.server.ts:64
  also uses it for PR back-links), plus `BETTER_AUTH_SECRET` and `CLAUDE_CONFIG_DIR` — none appear
  in .env.example, whose header claims it documents every variable (env.server.ts:124 points
  users there). A proxied deploy configured from the example gets broken OAuth callback/cookie
  URLs with no hint.

### ED-2 (LOW) — Env reads that bypass the validator and are undocumented: `LOG_LEVEL`, `VIBERR_CODEX_IDLE_TIMEOUT_MS`
- File: `/Users/akinozer/projects/viberr/app/server/logging/logger.server.ts:25`,
  `app/server/runtimes/codex-runtime.server.ts:69`
- Both read `process.env` directly — not in envSchema, not in .env.example. (The logger is
  deliberately import-free; still undocumented.) No documented-but-never-read vars exist.

### ED-3 (LOW) — boot.server.ts docstring claims an expired-session sweep that no longer exists
- File: `/Users/akinozer/projects/viberr/app/server/boot.server.ts:64`
- "…sweeps expired sessions (once now + daily interval)" — no sweep exists (only per-request
  session deletes for disabled/vanished users). Leftover from the retired hand-rolled `sessions`
  table (dropped in migration 0014); expired better-auth sessions now linger unless touched.

### ED-4 (LOW) — org-seed header describes a placeholder GitHub connection the code no longer seeds
- File: `/Users/akinozer/projects/viberr/app/server/org/org-seed.server.ts:21`
- Header: "and a PLACEHOLDER akin-ozer GitHub connection (no real token…)". Lines 257–263 and
  359–360 explicitly seed no connection/MCPs ("Honest empty slate"); `mcps` in the summary is
  hardcoded 0. Doc drift from the pass that removed the fabricated seed.

### ED-5 (LOW) — `loginWithCredentials` docstring claims a credential sync it doesn't perform
- File: `/Users/akinozer/projects/viberr/app/server/auth/login.server.ts:56`
- "…syncs the better-auth credential to the current password hash…" — the body never calls
  `setCredentialPassword`; the sync lives in `resetPassword` (user-admin.server.ts:232) and
  `completeForcedPasswordReset`. No functional gap (hash writers sync at write time); the comment
  describes a removed bridge step.

### ED-6 (LOW) — routes.ts still labels the org routes "TEMPORARY"/"Placeholder" though phase 9 shipped
- File: `/Users/akinozer/projects/viberr/app/routes.ts:8–11`
- `/org/users` is now a redirect into the real tabbed `/org/settings` surface (org.users.tsx:8;
  org.settings.tsx is the full 395-line implementation), but the comments still say "TEMPORARY
  admin surface — replaced by the real org settings in phase 9" and "Placeholder until phase 9
  ports the tabbed org-settings surface".

---

## Appendix — checked and verified fine (don't re-chase)

**Runtime/operator/SSE:** operator-lease token idempotency on the real/codex/scripted paths;
sse-broker ring-buffer replay/resync math, heartbeat cleanup, and backpressure drop in
resources.events; `withFileLock` chain hygiene; completion-callback registration race for
instant-reply scripts (task-file writes are sync, registration wins); comment guardrails, verdict
classifier negation handling, timeline compaction, F8 error-path escalation, run-recovery
idempotency (audit-row keyed), chokidar error self-heal, SSE scope authorization expansion.

**Routes/guards:** CSRF is uniformly enforced — every mutating action calls `assertCsrf` (login
uses `assertTrustedOrigin` pre-session by documented design; /api/auth/* delegates to
better-auth's origin check). All route files are registered in routes.ts; every "RBAC inside"
promise was confirmed (requireAction/assertProjectAction/requireRuntimeRole at each mutation
entry). Bare `catch {}` blocks are documented tolerant fallbacks, none returning fake success.
Deliberate asymmetries left unflagged: FR4 app-wide reads (task detail/model-catalog/
session-export); GitHub actions returning `ok:true` with degraded-state toasts (phase-7
"degraded modes are values"); `/resources/health` intentionally unauthenticated aggregate-only.

**UI:** topbar search genuinely drives the board `?q=` filter; every submitted intent across
board/task/settings/policy/org/profile has a matching server case consuming all fields (incl. the
full profile-modal payload); drag-drop reorder, notifications, theme cycling, mention
autocomplete, SSE streams, and dialog reset/close all correct.

**Auth/org/github/scripts:** the GitHub layer is real and wired — branch-sync/reconciler/pr-open/
workspace-delivery are reached via dynamic `await import(...)` (plain import-grep falsely reports
them dead); PAT validator genuinely probes GitHub and honestly labels unverifiable fine-grained
scopes "assumed"; connections.server refuses to persist unvalidated tokens; legacy `sessions`
table properly dropped (migration 0014); demo/org seeds honestly labeled; all 6 e2e specs real
with assertions (none skipped; `e2e/.auth/arda.json` is a gitignored runtime artifact); disabled
OAuth buttons render an explicit "not configured" state (D12).

**Capability/RBAC mapping table:** CAP_CATALOG has 26 ids (23 toggleable: 17 specialist + 6
operator; 3 display-only). ENFORCED_CAPABILITY_IDS claims 13 (5 tool-denial — 4 correctly badged
claude-only, 1 mislabeled "both" = XS-6; 6 operator-gate ids genuinely both backends via
`gate()`; 2 structural app-locks); 13 advisory (none reach a run in any form = XS-5).
ACTION_ROLES has 16 actions: 2 app-wide by design, 11 through the canonical guard, 2 never
consulted (XS-10), 1 aliased (XS-9). The old "allowedTools is not a restriction" footgun is
genuinely fixed: Claude adapter treats allowedTools as auto-approve-only, all confinement via
`disallowedTools`; operator toolkit is default-deny (`policy.get(id) ?? "off"`); ALWAYS_HUMAN
coercion at grant-persist, F1 stage-eligibility, manual-move-to-Done routing through
`acceptCompletion`, and the anti-noise guardrails all enforced exactly as displayed.

**Toolchain:** `npm run typecheck` clean. Full `npm test` in the audit sandbox fails on a
better-sqlite3 NODE_MODULE_VERSION 147-vs-137 ABI mismatch (native module built under a different
Node than vitest's) — environment artifact, not app code; re-run after `npm rebuild better-sqlite3`.
