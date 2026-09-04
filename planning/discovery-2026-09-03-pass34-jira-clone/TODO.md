# Pass 34 — implementation plan

Every item below is a committed todo for this pass. Nothing is deferred, narrowed or made
backwards compatible. Each item names the findings it closes, the cluster it came from (so it
can be traced back to its plan and its adversarial verdict), the root cause with file:line as
the code stands today, the mechanism, the callers swept, the tests with their canaries, and
the docs it touches. All 53 plan items are here; every adversarial correction is folded in.
Every item carries a **Docs** line: AGENTS.md requires the matching page to change with the
behaviour, so "no docs page describes this" is a claim that has to be checked, not assumed —
and checking it turned C2, C3 and C6 (which had no line) into three real docs edits.

Two owner questions were asked before implementation began and are **answered** (2026-09-04):
Q34-14 (A21) — the operator may switch a task's delivering agent however it judges best, because a
human can already redirect it through the operator chat or agent allocation; and Q34-15 (A40) —
keep the `workflow` scope optional, disclosed at attach time and refused before the push. Both
answers are folded into their items below; neither is a deferral.

Ruling numbers are assigned at the end of this file, 128 upward in band order.

---

## Band A — owner-ruled behaviour changes

### A1 · Viberr bootstraps the default branch of an empty repository (closes F34-4, folds F34-3's cause; owner answer to Q34-2) (C2-1)

- **Root cause.** `app/server/github/branch-sync.server.ts:377` declares
  `{ status: "default_branch_missing"; defaultBranch }` and `:481` returns it from the 404 arm
  of the base-ref read (`:473-484`); nothing consumes that member. `probeBranchName`
  (`:91-135`) funnels every non-404 refusal into `{kind:"network"}` (`:107-109`).
  `app/server/github/push-workspace.server.ts:675-681` pushes `HEAD:refs/heads/<branch>` with
  no base check, so on an empty repository GitHub makes the task branch the repository
  default. `app/server/github/pr-open.server.ts:615-619` `ghValidationBodySchema` reads only
  `errors[].message`, so GitHub's `{resource:"PullRequest", field:"base", code:"invalid"}` row
  produces an empty `reasons`, neither regex at `:620-645` matches, and the residual returns
  `network_unavailable`, which `app/server/tasks/task-actions.server.ts:5474/5485` renders as
  "GitHub was unreachable (network error) … Fix the repository/credential settings".
- **Mechanism.** New `app/server/github/repo-bootstrap.server.ts` exporting
  `ensureDefaultBranch(db, gh, {projectSlug, taskKey}, actor, ctx)` returning
  `exists | bootstrapped | scope_violation | auth_failed | network_unavailable |
  bootstrap_failed`. (a) `GET /git/ref/heads/<default>`; a shared `isMissingRefAnswer(result)`
  (exported from branch-sync, reused by `probeBranchName` and `ensureTaskBranch` step 1)
  treats a 404 OR a 409 whose message matches `/empty/i` as "no ref", never as a network
  failure; 401 → `auth_failed`; 403 → `flagScopeViolation(scope:"repo")` → `scope_violation`.
  (b) missing → `GET /branches?per_page=1` and `GET /repos/{r}`. Empty → `PUT /contents/README.md`
  with `branch: <default>` (the Contents API authors a root commit on an empty repository
  where the Git Data endpoints answer 409) → re-probe → `bootstrapped {how:"initial_commit"}`.
  Non-empty (a task branch was pushed first) → walk `GET /commits?sha=<GitHub default>&per_page=100`
  following `Link rel=next` for at most 10 pages, take the OLDEST entry as the root, `POST /git/refs`
  (a 422 "already exists" is success), then `PATCH /repos/{r} {default_branch}` (a refusal there
  is disclosed in the timeline text, not fatal) → `bootstrapped {how:"ref_from_branch_root", from}`.
  (c) `bootstrapped` records audit `github.repo.bootstrapped` and, with a task key, one `github`
  timeline event by `{kind:"system", systemId:"delivery"}` naming which of the two shapes ran.
- **Callers.** `ensureTaskBranch` step 2 replaces its 404 arm with `ensureDefaultBranch`;
  `EnsureBranchResult` drops `default_branch_missing` and gains
  `{status:"bootstrap_failed", defaultBranch, reason}`. `performDelivery`
  (`task-actions.server.ts`, before the push at `:5049`) calls it when the GitHub context is
  `ok`. **Correction folded (verdict):** the pre-push gate is split by EVIDENCE, not by
  failure — only `bootstrap_failed` and `scope_violation` (a positive "there is no default ref
  and Viberr could not create it") refuse `pushWorkspaceBranch`; `auth_failed` and
  `network_unavailable` mean the ref could not be READ, so the push proceeds and the honest
  PR-side wording is what the person sees. "has no `main`" is never emitted on an unread probe.
  `openTaskPr`'s 422 arm gains `field`/`code`/`resource` on `ghValidationBodySchema`:
  `field === "base" && code === "invalid"` → new `{status:"base_branch_missing", base, message}`;
  every other unmapped 422 and the final residual → new `{status:"refused", message}` (GitHub
  answered; it was not the network). `performDelivery`'s rendering (`:5466-5487`) gains both.
  **Correction folded:** the `base_branch_missing` remedy must NOT point at ruling 129 (a
  checkout whose HEAD is on a task branch is left untouched by that ruling, and
  `update_branch_from_base` answers "refusing to merge unrelated histories" there); it names
  the two remedies that work (delete the task branch locally and let the deliverer re-cut it
  from the bootstrapped base, or resolve the unrelated history by hand). Activity feed gains
  `github.repo.bootstrapped` with the justification that it is a repository-level change like
  `github.credential.assigned`. **Correction folded:** the false grep claim is removed —
  `app/server/github/branch-sync.server.test.ts:423` asserts `default_branch_missing` and is
  REPLACED by the bootstrap case. **Correction folded:** every existing `performDelivery` suite
  that binds a credential and injects `fetchImpl` gains the ref route (or a credential-free
  seed), because `test-support/fake-github.ts:88-92` answers unrouted requests 404 and would
  now route them into the bootstrap.
- **Tests.**
  - `app/server/github/repo-bootstrap.server.test.ts` (new) · "an empty repository gets an
    initial commit and its default branch, recorded on the timeline and audited" · canary:
    return `bootstrap_failed` from the empty-array arm instead of issuing the PUT.
  - same file · "a 409 `Git Repository is empty.` on the ref read is a missing ref, not a
    network failure" · canary: drop the 409 clause from `isMissingRefAnswer`.
  - same file · "a repository whose only branch is a pushed task branch gets `main` at that
    branch's first commit and the default restored" · canary: post the ref with the NEWEST sha.
  - same file · "a 403 on the initial commit opens a `repo` scope violation" · canary: return
    `network_unavailable` without calling `flagScopeViolation`.
  - same file · "an existing default branch writes nothing" · canary: issue the PUT unconditionally.
  - `branch-sync.server.test.ts` · "on an empty repository `ensureTaskBranch` bootstraps `main`
    then creates the task branch from it" (REPLACES the `default_branch_missing` assertion at
    `:423`) · canary: restore the old 404 arm.
  - `pr-open.server.test.ts` · "a 422 with `field: base, code: invalid` is `base_branch_missing`,
    never `network_unavailable`" · canary: remove `field`/`code` from `ghValidationBodySchema`.
  - `pr-open.server.test.ts` · "an unmapped 422 is `refused` and carries GitHub's own words" ·
    canary: return `network_unavailable` from the residual again.
  - `task-actions.server.test.ts` · "delivery refuses to push when the base cannot be CREATED,
    and pushes anyway when the probe merely could not be READ" (both arms) · canary: route
    `network_unavailable` into the refusing arm.
  - `task-actions.server.test.ts` · "performDelivery bootstraps `main` before the first push and
    records it" — assert the bootstrap line as `timeline[1]` (timelines are newest-first) ·
    canary: gate the bootstrap on the absence of the `pushWorkspaceBranch` dep.
  - `audit-coverage.server.test.ts` · row for `github.repo.bootstrapped`.
- **Live validation is a required step before merge**, not a risk note: verify against a
  scratch EMPTY repository what GitHub actually answers (404 vs 409 on `git/ref`, `[]` from
  `/branches`, the Contents API honouring `branch:`, `PATCH /repos` restoring the default) and
  record the observed answers in the module comment.
- **Docs.** `github-delivery.md` §2, §3 (new step 0), §4 (the three mapped 422 outcomes), §9
  (`github.repo.bootstrapped`); `task-lifecycle.md` §10; `runbook.md` GitHub/PAT bullet;
  `requirements-status.md` FR31; `glossary.md` "Repository bootstrap"; `decisions.md` ruling 128.

### A2 · A reused delivering workspace is refreshed from the project mirror on every dispatch (closes F34-6; owner answer to Q34-5) (C2-3)

- **Root cause.** `app/server/tasks/specialist-run.server.ts:3398-3412` is `cloneRepo`'s reuse
  path: it re-sanitizes the remote, sets the identity, strips the catalog and returns — no
  fetch, no fast-forward. The checkout was created by the operator's triage through
  `ensureOperatorRepoCheckout` (`operator-run.server.ts:1171-1173` returns an existing checkout
  untouched, `:1194` clones a missing one) from a repository that was empty at the time, so the
  clone was unborn. Agents hold no credential and the prompt forbids fetching. Only supporting
  checkouts are refreshed (`refreshSupportBase`, `:3284-3316`, single call site `:3387`) and the
  operator's anchored read (`operator-repo-read.server.ts:139-170`), which is why the operator
  read a bootstrapped `main` while the spec writers committed unrelated ROOT commits on
  `jc-2`/`jc-5`.
- **Mechanism.** New `app/server/tasks/workspace-refresh.server.ts` exporting
  `refreshWorkspaceFromMirror(db, {projectSlug, repo, dir, defaultBranch, dataRoot, fastForward})`
  → `fast_forwarded | fetched{head} | no_mirror | fetch_failed`. (1) `refreshProjectMirror`;
  **correction folded:** on a DELIVERING dispatch pass `create: true` (the `create:false` rule
  at `repo-mirror.server.ts:274-277` was written for read-side tool calls), and if the mirror
  still cannot be built, fall back to a credentialed `git fetch` of the remote heads through
  the existing server-side askpass env, so the refresh cannot be defeated by a missing cache.
  (2) `git fetch <mirror.dir> +refs/heads/*:refs/remotes/origin/*` (60 s, `GIT_TERMINAL_PROMPT=0`),
  failure → `fetch_failed` with redacted output. (3) with `fastForward`: unborn HEAD on the
  default branch and a clean tree → `checkout -q -B <default> origin/<default>` → `fast_forwarded`;
  clean, on the default branch and an ancestor → `merge --ff-only`; on the default branch but
  not an ancestor → `fetched{head:"local_commits"}`; HEAD on another branch → `fetched{head:"task_branch"}`
  (untouched; `update_branch_from_base` owns diverged task branches); dirty → `fetched{head:"dirty"}`;
  detached → `fetched{head:"detached"}`; no `origin/<default>` → `fetched{head:"no_base"}`.
  **Correction folded:** add a fourth classification — when `git merge-base HEAD origin/<default>`
  finds NO common ancestor, return `fetched{head:"unrelated"}` and say so in the run-inputs
  disclosure and in the agent's workspace contract ("your branch shares no history with
  `origin/<default>`; `update_branch_from_base` will refuse it"), so the live damage is NAMED
  instead of silently left alone.
- **Callers.** `cloneRepo`'s reuse path calls it with `fastForward: true` after the sanitize and
  before `stripUngovernedRepoCatalog`, with a `preparing` phase line; the support-clone path
  replaces `refreshSupportBase` with `fastForward: false` and `refreshSupportBase` is deleted.
  `CloneOutcome` gains `refresh`; the dispatch threads it into `resolvedResourceInputs`
  (`run·inputs`) and into `AnalyzePromptInput.workspaceRefresh` (the workspace contract
  sentence, including the "mirror could not be refreshed from GitHub first" clause). No timeline
  event: the refresh is workspace mechanics, and the run log is its record.
  **Correction folded:** the justification for leaving `ensureOperatorRepoCheckout` alone is
  rewritten — the operator holds `Read`/`Grep`/`Glob` over the SAME directory
  (`operator-run.server.ts:1235-1245`), so this pass refreshes it too when no delivering run is
  live for the task (the single-flight table at `specialist-run.server.ts:1350` answers that),
  and the operator's own workspace contract states that the checkout may lag and that
  `read_default_branch_file` is the anchored read. Ruling 129's text says which was chosen.
- **Tests.** New `workspace-refresh.server.test.ts` over a real local-origin harness extracted
  into `test-support/git-origin.ts` (from `repo-mirror.server.test.ts` and
  `operator-run.server.test.ts`):
  - "an unborn checkout cloned from an empty origin is fast-forwarded once the origin has a
    default branch" · canary: skip the `checkout -B` step.
  - "a clean checkout behind the origin is fast-forwarded; one with local commits is not" ·
    canary: replace `merge --ff-only` with `reset --hard`.
  - "a task branch is fetched but never moved; a dirty tree is never touched" · canary: drop the
    `status --porcelain` check.
  - "a branch that shares no history with `origin/<default>` reads `unrelated` and says so" ·
    canary: fold `unrelated` into `task_branch`.
  - "no mirror means a credentialed fallback fetch, and a broken fetch degrades to `fetch_failed`" ·
    canary: return `no_mirror` without attempting the fallback.
  - `specialist-run.server.test.ts` · "a delivering dispatch into a reused unborn checkout
    refreshes it and discloses the refresh" (fixture built with git directly, never through a
    Viberr delivery, so it cannot disagree with A1's fixture) · canary: remove the call from
    `cloneRepo`'s reuse path.
  - `specialist-run.server.test.ts` · "`buildAnalyzePrompt` renders the refresh sentence only
    when given one" · canary: render it unconditionally.
- **Docs.** `agents-and-runtime.md` §4.1 and §7; `operator.md` read-only clone paragraph;
  `decisions.md` ruling 129, plus a pointer from ruling 87.

### A3 · Claude refusals are classified from the structured envelope first (closes F34-1; ruling 130 clause a) (C3-1)

- **Root cause.** `app/server/runtimes/claude-runtime.server.ts:579-641` `classifyClaudeError(cause)`
  reads only `cause.message` (`:599`) and regex-matches prose (quota `:614`, auth `:626-630`,
  else `unknown` at `:636-641`). The is_error result path (`:1051-1076`) hands it
  `new Error(resultErrorText ?? resultSubtype ?? "")`. `claudeEnvelopeSchema` (`:469-493`)
  decodes type/subtype/result/usage only, so `api_error_status: 403`, `terminal_reason`, the
  assistant envelope's `error: "oauth_org_not_allowed"` and the `rate_limit_event`'s
  `status: "rejected"` + `resetsAt` are never read. `wire-format.server.ts:337` projects EVERY
  assistant envelope as `ev:"text"`, so the provider's API-error banner became the specialist's
  own reply comment (`agent-reply.server.ts:466-476` → `task-actions.server.ts:3643-3651`,
  audit `task.agent.replied`).
- **Mechanism.** `wire-format.server.ts`: `claudeEnvelopeFields` gains
  `api_error_status: z.number().nullable().catch(null)` and `terminal_reason: wireText`;
  `EnvelopeFacts` gains `apiError`, `apiErrorStatus`, `terminalReason`; `projectClaude`'s
  `assistant` case emits `{ev:"err", tag:"assistant·<code>"}` when `e.error` is non-empty, so
  the banner can never be selected as the reply. The `rate_limit_event` display names the
  window, the STATUS and the reset instant ("utilization not reported" instead of `?`).
  `claude-runtime.server.ts`: the stream loop keeps the last rate-limit reading, the last API
  error code and the result's status/terminal reason; `classifyClaudeError(cause, evidence)`
  orders spawn codes → `session_missing` → quota (a REJECTED reading, `apiError ∈ {rate_limit,
  billing_error}`, `apiErrorStatus === 429`, or the prose regex extended with
  `session limit|weekly limit|monthly limit|out of credits|credit balance`) → auth
  (`apiError ∈ {authentication_failed, oauth_org_not_allowed}`, `apiErrorStatus ∈ {401,403}`,
  or the existing regex) → unknown. Both writers attach a typed `failure` record to the display
  line beside the `run·error·<kind>` tag. `agent-reply.server.ts` `RunFailure` reads
  `last.failure`; `codex-runtime.server.ts` emits the same shape.
  **Corrections folded:** (1) `claude-runtime.server.test.ts:244` and `:337` both assert
  `toContain("usage quota")` — they are re-pointed at the new sentence in this change (named in
  the sweep, not discovered at run time). (2) The window and reset instant are carried ONLY for
  a `status: "rejected"` reading (`RunFailureFacts.windowRejected`); a transient 429 with no
  rejected reading keeps a back-pressure sentence and null `resetsAt`/`window`, so V4 and A5's
  sink gate stay honest. (3) `RunFailureKind` and `TAGGED_FAILURE_KINDS` MOVE to a shared leaf
  `app/shared/run-failure.ts`, re-exported from `agent-reply.server.ts`, so
  `app/features/runtime/runtime-types.ts` keeps its "no server imports" contract while typing
  `LogLine.failure`. (4) The reset instant is formatted ABSOLUTELY (`formatClockUTC` +
  `utcDayKey`/`formatCalendarDate`), never with the relative `formatDayDotTimeUTC`, in the
  adapter line and in every later re-render. (5) A `rate_limit_event` whose status is `rejected`
  is EXEMPT from `log-noise.ts` `TELEMETRY_TAGS` collapsing, so the reading is visible in the
  console. (6) The reply-comment claim is stated correctly: the banner can no longer be selected
  as the reply, and a run whose only assistant output was the banner posts nothing.
- **Callers swept.** `classifyClaudeError` (`:745`, `:1059`); `projectEnvelope`
  (`claude-runtime.server.ts:975`, `codex-runtime.server.ts:735`); `EnvelopeFacts` consumers
  (`run-sink.server.ts:383-401`); `LogLine` consumers (`runs-panels.tsx:863-870`,
  `log-noise.ts:35-37`, `continuity-recovery.tsx:83`, `run-projection.server.ts:193-197`,
  `agent-reply.server.ts:465-476`, run-store); `RunFailure` consumers
  (`task-actions.server.ts:3661`, `operator-run.server.ts:2695`, `controller-run.server.ts:499`).
- **Tests.** `wire-format.server.test.ts` · "an assistant envelope carrying `error` projects as an
  err line, never as reply text" · canary: delete the `if (e.error)` branch. · "result facts carry
  `api_error_status`/`terminal_reason`; a rejected rate-limit line names the status and the reset" ·
  canary: drop the two schema fields. `claude-runtime.server.test.ts` · "a 403
  `oauth_org_not_allowed` classifies `run·error·auth` from the envelope and names Profile →
  Agent accounts" · canary: remove the structured arms. · "a session-limit refusal preceded by a
  REJECTED rate_limit_event classifies quota and carries the exact reset; an ALLOWED reading
  carries none" · canary: drop the `windowRejected` gate. · "a thrown stream error with no
  envelope evidence still classifies by prose" · canary: require evidence for the quota arm.
  `agent-reply.server.test.ts` · "`runFailureReason` returns the structured facts and classifies
  `session limit` prose as quota" · canary: remove the `last.failure` read.
  `codex-runtime.server.test.ts` · parity of the `failure` shape · canary: omit it.
- **Docs.** `agents-and-runtime.md` §2.4, §3.5, completion step 2; `runbook.md` lines 127-131.

### A4 · Every reader of a failure consumes the class (closes F34-1; ruling 130 clause a) (C3-2)

- **Root cause.** `app/server/controller/controller-run.server.ts:480-516` `settleTurn` composes
  "I could not finish this turn: …" and ALWAYS appends " Say it again to retry." (`:513`), even
  for a 403 or a spent window, while `controllerRefusalNote` (`:298-328`) already names the
  person's own move for a missing credential. `app/server/runtimes/run-projection.server.ts:193-197`
  computes `failedBackendUnavailable` from the `run·unavailable` tag or a raw-tail prose scan
  (`BACKEND_UNAVAILABLE_SIGNATURES`, `:84-102`), so neither live refusal matched and the Agent-logs
  footer said "stream ended on a continuity error" (`runs-panels.tsx:611`) with no retry offer.
- **Mechanism.** `settleTurn` builds the note from `runFailureReason` (now carrying `resetsAt`,
  `window`, `apiError`): quota names the reset instant and Profile → Agent accounts; auth names
  the org restriction and the account remedy; every other kind keeps today's sentence plus
  " Say it again to retry." The new wording is guarded on `state === "error"` PLUS a classified
  kind, so a finished-but-silent turn keeps today's sentence. `run-projection.server.ts` consults
  the CLASSIFIED tag first (`run·unavailable`, `·quota`, `·auth`) and keeps the raw scan as the
  fallback. **Correction folded:** the fix reaches EVERY run kind — the `!op` guard is dropped
  (or a separate `failureClass` field is added) and `runs-panels.tsx:559-562` selects the footer
  SENTENCE by the classified failure for any kind, while the retry BUTTON stays gated by
  `altBackend` + retry backends + the run-agents grant exactly as today. Four of the six live
  refusals were operator runs and one was a controller run.
- **Merge order.** A3 lands first (this item consumes `failure`/`RunFailure` fields).
- **Tests.** `controller-conversations.server.test.ts` · "a quota-refused turn names the reset and
  the account switch, never 'Say it again to retry'" · canary: restore the fixed suffix. · "an
  auth-refused turn names the org restriction; an `unknown` failure keeps the retry sentence" ·
  canary: route auth through the generic arm. `run-projection.server.test.ts` · "flags a run whose
  classified tag is `·auth`/`·quota` even when the raw tail carries no signature" — the row is
  inserted with `kind: "primary"` and a non-null `credential_user_id`, plus a second row of kind
  `operator` asserting the same flag · canary: remove the tag clause. `runs-panels.test.tsx` · an
  OPERATOR run with tag `run·error·quota` renders the classified footer · canary: restore the
  kind gate on the sentence.
- **Docs.** `controller-and-goals.md` line 202; `agents-and-runtime.md` §3.6.

### A5 · The quota and credential observation store records the structured refusal and whose account it was (closes F34-1; ruling 130 clause d) (C3-3)

- **Root cause.** `app/server/runtimes/run-sink.server.ts:433-441` records
  `backendQuotaExhausted.<backend>` only when the tag ends `·quota` AND
  `quotaExhaustionEvidence(display.text)` is non-null; `backend-quota.server.ts:153-154`
  `USAGE_LIMIT_RE` does not contain "session limit", so the record was never written.
  `parseQuotaResetAt` (`:285-301`) understands only the epoch and "try again at" shapes, and the
  SDK's exact `resetsAt` is folded only into `backendRateLimit` (`run-sink.server.ts:393-399`).
  `readingSchema`/`exhaustionSchema`/`credentialRefusalSchema` (`:57-116`) name no principal, so
  Insights (`insights-page.tsx:288-311`, `:348-350`) and `health-snapshot.server.ts:121-125`
  present one person's refusal as an instance-wide fact.
- **Mechanism.** `USAGE_LIMIT_RE` gains ONLY `session limit` (weekly/monthly are already there;
  **correction folded:** window words such as `five.?hour` are NOT added — `providerSentence()`
  falls back to the whole line, so the adapter's own canonical prose would satisfy its own gate).
  `parseQuotaResetAt(text, observedAtIso?)` gains the UTC-clock shape `resets HH:MM(am|pm) (UTC)`
  → the next occurrence at or after `observedAt`, with a THIRD precision value `"clock"`
  (**correction folded**): rendered to the minute like `exact`, retired with
  `QUOTA_RESET_GRACE_MS` like `prose`, updated in `exhaustionExpired` and the Insights branch
  together. The three record schemas gain `credentialUserId` and `credentialLabel`, read from
  `getRun(db, spec.runId).credential_user_id` and `findUserById`. The sink's exhaustion gate
  becomes: tag ends `·quota` AND (`failure.windowRejected` OR `quotaExhaustionEvidence(text)`) —
  **correction folded**, gated on the REJECTION, never on the mere presence of a window, so the
  TRANSIENT_429 fixture still records nothing. **Correction folded:** `credentialUserId` and
  `credentialLabel` are STRIPPED from the `/resources/health` body (that route is unauthenticated
  by design and documents "never data"); they reach Insights (org admin), `instance_health` and
  the person's own Profile card only. **Correction folded:** `providerSentence()` is exported and
  only the PROVIDER half is stored and rendered, so no person-facing copy repeats the canonical
  remedy or the marker. **Correction folded:** the Insights READING row renders the hour when
  `resetsAt` carries one (today it prints a bare calendar date). Documented in
  `agents-and-runtime.md` §2.3: one latest record per backend, and a completed run by ANY person
  retires it.
- **Tests.** `run-sink.server.test.ts` · "records exhaustion off the err line's rejected-window
  facts even when the provider sentence names no limit word" · canary: delete the `failure` clause.
  · "TRANSIENT_429 with C3-1's facts attached still records nothing" · canary: gate on `window`
  instead of `windowRejected`. · "parses `resets 11:50am (UTC)` as the next UTC occurrence with
  precision `clock`" · canary: remove the clock arm. · "a refusal record names the account it
  billed" · canary: stop reading the run's `credential_user_id`. `health-snapshot` · "the
  unauthenticated body carries no principal" · canary: return the rows unstripped.
  `insights-page.test.tsx` · "an exhausted or refused row says whose account, and the reading row
  names the hour" · canary: drop the label interpolation. `controller-ops-mcp.server.test.ts` ·
  `instance_health` carries the principal · canary: omit the fields from the schema.
- **Docs.** `agents-and-runtime.md` §2.3/§3.3; `data-model.md` `instance_settings`;
  `configuration.md` line 186; `auth-and-rbac.md` §6; `surfaces.md` `/insights`; `runbook.md`.

### A6 · Failure packets name the classified cause and the person's own remedy (closes F34-12 and F34-1; owner answer to Q34-7) (C3-4)

- **Root cause.** `app/server/runtimes/operator-run.server.ts:1840-1885` `defaultPacketOptions("blocked")`
  recommends `block_on_policy` titled "I've updated the policy / credential - unblock and re-run"
  (`:1854-1859`); `escalateFailedOperatorRun` (`:2686-2765`) uses it for EVERY failure kind
  (`:2732`) and its body ends "Retry on the other backend, fix the credential, or redirect the
  task." (`:2722-2731`). On resolution `task-actions.server.ts:6478-6481` records
  `option.ev ?? "**Decision:** policy / credential updated…"`, `app/routes/project.task.tsx:582-584`
  toasts "Policy / credential updated", and the `packet-resolved` instruction
  (`operator-run.server.ts:3426-3428`) tells the operator a policy/credential fix happened — which
  is how the JC-6 operator told the Developer the workflow-scope block was lifted. Specialist side:
  `reasonText` (`:3673-3697`, the `..` double period), the quota/auth sentence at `:3708-3709`,
  and `openStuckLoopPacket` recommending "Redirect with sharper guidance" (`:2401-2406`).
- **Mechanism.** New leaf `app/server/tasks/run-failure-remedy.server.ts` with
  `describeRunFailure(db, {failure, backend, taskKey, ownerUserId, role, agentHandle, dataRoot})`
  → `{reason, remedy, resetLabel, owner, options}`, the ONE home for failure-to-words. Quota names
  the window and the reset instant and says the owner may wait or connect a different account or
  an API key on Profile → Agent accounts; auth names the org restriction and the account remedy;
  `unavailable` keeps ruling 127's sentence; other kinds keep theirs. Operator options: the
  recommended `block_on_policy` becomes "The usage window has reset, or I switched the Claude
  account: re-run" / "I connected a different Claude account or an API key…: re-run" / "Re-run the
  operator now", each with an `ev` that asserts only what the human said ("No policy or credential
  was changed."). Specialist options: `retry_other_backend` first when the owner has the other
  backend (rule unchanged, moved into the module), else a `request_edit` titled "The window has
  reset, or the account changed: send the agent back to continue"; `redirect` is present and NOT
  recommended for backend failures. `escalateFailedOperatorRun`'s body becomes reason + "No
  coordination was performed." + remedy; the generic sentence is deleted; the packet title changes
  from "Operator run failed - pick a recovery path" (an em dash today) to the colon form
  (**correction folded:** `app/server/**` is outside the dash gate, so this is a deliberate copy
  change, stated here). The resolve arm's fallback becomes title-derived; the toast becomes
  "Unblocked · the operator re-runs to re-check"; the `packet-resolved` hint says to assume nothing
  about credentials or policy beyond what the decision says.
  **Corrections folded:** (1) `openStuckLoopPacket`'s `options` stays OPTIONAL and defaults to
  today's set, because it has THREE callers (`task-actions.server.ts:3798`, `:3966`, `:4817`) and
  the other two must keep resolvable packets. (2) `describeRunFailure` takes the data root so
  `isBackendAvailableFor` is asked the same question the console asks. (3) `ownerUserId` comes from
  the task file frontmatter (the `task-actions.server.ts:3768-3771` read); an unowned task yields no
  owner sentence and no retry option. (4) Reset assertions in tests are clock-only or pass an
  explicit `now`, and the rendering is absolute UTC, never `formatDayDotTimeUTC`.
- **Tests.** `run-failure-remedy.server.test.ts` (new) · quota/auth/unknown/specialist matrix ·
  canary: return the stock set for every kind. `operator-run.server.test.ts` · "a quota-refused
  operator run opens a packet naming the reset and the owner's remedy, never 'policy / credential'" ·
  canary: restore `defaultPacketOptions("blocked")` in `escalateFailedOperatorRun`. · "auth
  recommends switching the account; unknown recommends a plain re-run; the Codex no-plan packet
  claims no credential change" · canary: route them through the stock set. · "the `packet-resolved`
  instruction bolds the decided title and claims no policy fix" · canary: restore the parenthetical.
  `agent-completion.server.test.ts` · "a specialist quota failure recommends 'send the agent back to
  continue', names the owner's remedy and never ends in `..`" · canary: restore
  `redirect.recommended` and the fixed quota sentence. `task-governance.server.test.ts` ·
  "`block_on_policy` records the option's own words" · canary: reinstate the fixed sentence.
  `task-detail-route.server.test.ts` · the toast · canary: restore the old literal.
- **Docs.** `operator.md` "Who opens packets" and the `block_on_policy` row; `task-lifecycle.md`
  ownership section; `agents-and-runtime.md` §3.5 and completion step 5; `glossary.md`;
  `decisions.md` ruling 130, plus dated notes under rulings 76 and 7.

### A7 · The person's own Agent-accounts card shows the provider's last refusal (closes F34-1; ruling 130 clause d) (C3-6)

- **Root cause.** `app/features/profile/agent-accounts-panel.tsx:437-454` renders only
  verified/unverified/sign-in-missing from `userBackendHealth`, and
  `app/features/profile/profile-query.server.ts:87-107` `getProfileBackends` reads no run
  evidence at all, so the card said "connected · verified Sep 3" while every run on that account
  was refused with 403.
- **Mechanism.** `ProfileBackend` gains `lastRefusal?: {...} | null` (**correction folded:**
  optional, or both existing fixture files `profile-page.test.tsx:32-50` and
  `agent-accounts-panel.test.tsx:44-70` are swept in the same change). `getProfileBackends` reads
  `latestBackendRateLimits(db)` once and picks the credential-refusal record when
  `credentialRefused.credentialUserId === userId`, else the exhaustion record — never another
  person's. The card renders a `risk` pill "refused by the provider · <when>" with the PROVIDER
  half only (**correction folded:** `providerSentence()`, and the duplicate remedy sentence is
  dropped when the provider line already names it), or a neutral "usage window spent · reopens …".
  **Correction folded:** the card copy and the docs say the pill is the last refusal Viberr
  OBSERVED and that a completed run on that backend by anyone retires it, so the absence of a pill
  is not proof the account works. Depends on A5, including the constraint that the principal never
  reaches `/resources/health`.
- **Tests.** `profile-route.server.test.ts` · "the loader attaches the viewer's own last refusal and
  never another person's" · canary: drop the `credentialUserId === userId` filter.
  `agent-accounts-panel.test.tsx` · the two pills · canary: remove the render branch.
- **Docs.** `auth-and-rbac.md` §7; `agents-and-runtime.md` §2.3.

### A8 · Canonical `blockedBy`, the projection column, the readiness floor and the read-time resolver (owner answer to Q34-11) (C6-1)

- **Root cause.** `app/schemas/task-file.schema.ts:600-707` carries no dependency field
  (planning metadata ends at `dueDate`, `:642`), so `TASK_FRONTMATTER_KEYS` (`:969-1001`) has no
  slot; `db/migrations/0001_baseline.sql:72-176` `task_projections` has `due_date` at `:90` and no
  dependency column; `deriveReadiness` (`app/server/interpretation/readiness-policy.server.ts:37-48`)
  floors only on diagnostics and has ONE caller (`rebuilder.server.ts:476-479`); `goalLinkSchema`
  (`app/schemas/goal-file.schema.ts:52-64`) carries index/title/goal/taskKey/status/note only.
  Live, three of five chains stalled behind goal-1 with a human decision per hold.
- **Mechanism.** New client-safe `app/shared/dependencies.ts`: `DependencyRef = {task} | {goal, link}`,
  `parseDependencyRef` (exactly two spellings: a task key, and `<goal-id> link <n>`),
  `formatDependencyRef`, `DependencyRender`, `DEPENDENCY_GRAMMAR_HINT`. `task-file.schema.ts` gains
  `blockedBy: z.array(dependencyRefSchema).default([])` after `dueDate`, parsed with
  `tolerantRows(...)` (a malformed row drops only itself). **Correction folded:** `"blockedBy"` goes
  into `TASK_FRONTMATTER_KEYS` because that list is the unknown-key membership index (`:1005`,
  `:1483-1495`) and the file-formats section-2 pin (`app/shared/docs/file-formats-sync.test.ts:104`),
  NOT because it drives serialization (`serializeTaskFile:592-619` writes the whole frontmatter
  object). `goalLinkSchema` gains the same array. Baseline gains
  `blocked_by_json TEXT NOT NULL DEFAULT '[]'`; **correction folded:** an EXISTING data root takes
  the additive `ALTER TABLE task_projections ADD COLUMN blocked_by_json TEXT NOT NULL DEFAULT '[]'`
  that `boot.server.ts:308-312` already prescribes for additive-only drift — a re-baseline is
  explicitly NOT the remedy, because that file also carries users, sessions and sealed PATs.
  `rebuildTaskFile` stores the RAW refs and passes `dependenciesListed` into `deriveReadiness`,
  which gains `dependencyFloor` and floors at `blocked` (rank 3, so it can never improve a stored
  value). New read model `app/server/projections/dependencies.server.ts` `resolveDependencies` maps
  each ref to `open | done | failed | missing` at READ time (never cached, so rebuild order cannot
  stale it); **correction folded:** terminality is derived through `isTerminalStage` /
  `isAcceptedDisplayState`, never a positional "last stage id". A goal-link ref whose link names a
  `taskKey` takes that task's own state. `TaskSummary.blockedBy` is resolved once per query in
  `listProjectTasks` and `getTaskSummary` (never per card in the mapper). `isQuiet` gains `held`, so
  a task waiting on other work is never "gone quiet".
- **Tests.** `task-file.schema.test.ts` · "`blockedBy` round-trips, absent reads `[]` with no
  diagnostic, a malformed row drops only itself with a diagnostic at path `blockedBy[0]`"
  (**correction folded:** the path is `tolerantRowsOf`'s stamp, not `blockedBy`) · canary: delete
  the `tolerantRows` line so the round-trip reads `[]` back. `file-formats-sync.test.ts` · the
  section-2 pin · canary: remove the `blockedBy` line from the doc. `dependencies.test.ts` (new) ·
  the two spellings and nothing else · canary: narrow the link quantifier.
  `readiness-policy.server.test.ts` · the floor and `dependencyFloor` · canary: floor at
  `input_required`. `rebuilder.server.test.ts` · `blocked_by_json` verbatim, derived `blocked`,
  stored value untouched · canary: drop `dependenciesListed`. `dependencies.server.test.ts` (new) ·
  every resolved state including a hand-moved link task · canary: map `skipped` to `open`.
  `mapping/task.server.test.ts` · the summary carries the resolved list · canary: omit the field.
  `task-activity.server.test.ts` · a held task is never quiet · canary: delete the `held` return.
- **Docs.** `file-formats.md` §2 and §2b; `data-model.md` §3; `projections-and-events.md` §4;
  `glossary.md` (Blocked by / Readiness / Waiting); `decisions.md` ruling 131 and the README count.

### A9 · The dependency writer, `createTask` with `blockedBy`, and the task-page intent (Q34-11) (C6-2)

- **Root cause.** No writer exists: `setTaskMetadata` (`app/server/tasks/task-actions.server.ts:725-838`)
  knows priority, labels and due date only (archived guard `:769-775`, equality short-circuit
  `:781-789`); `CreateTaskInput` (`:463-476`) has no dependency input; the task route's
  `set-task-metadata` intent is `app/routes/project.task.tsx:518-539`; the operator's only recording
  device is `operatorOpenPacket` (`operator-actions.server.ts:987-998`), which is what JC-9's
  operator turned into a "standing token".
- **Mechanism.** New `app/server/tasks/dependencies.server.ts`. `validateDependencyRefs` refuses by
  name: unparseable (quoting `DEPENDENCY_GRAMMAR_HINT`), self, unknown task, archived task, unknown
  goal or link index, and a cycle (walk `task_projections.blocked_by_json` with a visited set).
  **Correction folded:** the walk also traverses DECLARED goal-link edges
  (`goal_projections.links_json[].blockedBy`, the field A14 adds), so a mutual sibling-chain wait —
  exactly the shape ruling 131(c) exists for — is refused at write time instead of producing two
  tasks that are born held and never release. `setTaskDependencies` gates on `edit-task-meta` unless
  `ctx.operatorAuthorized`, refuses an archived task with its OWN sentence (**correction folded:**
  `setTaskMetadata`'s sentence names "priority, labels or due date"), short-circuits an unchanged
  list, writes the list inside `updateTaskFile`, sets `waiting: "none"` when nothing else is pending,
  clears `heldAtStage` when the list empties, prepends a `note`, reprojects and records
  `task.dependencies.updated {blockedBy, added, removed}`.
  **Correction folded (the release split):** the release is TWO shared halves —
  `clearDependencies(parsed)` (the frontmatter write) and `announceRelease(db, ctx, slug, key,
  {entries, clearedBy})` (release note, stored-`blocked` lift, `heldAtStage = null`,
  `task.dependencies.released` audit, `dependency` notification, `dependencies-released`
  re-invoke). When a NON-operator write empties a previously non-empty list, this writer writes the
  empty list AND calls `announceRelease` with `clearedBy = actor.label`; that release note is the
  ONE note that lands (no separate "Dependencies cleared" note), so ruling 131(e)'s "a human
  clearing the list is the same release" is literally true. `createTask` gains
  `CreateTaskInput.blockedBy`, validated BEFORE `allocateTaskKey` so a refusal burns no key, written
  in the creating frontmatter, `waiting: "none"` at birth, with a creation note;
  **correction folded:** `readiness` stays at its birth value `input_required` (the floor is
  derived, never stored). New route intent `set-task-dependencies`.
- **Tests.** `dependencies.server.test.ts` (new) · "writes the list, the note, the audit row and
  `waiting: none`" · canary: delete the `waiting` assignment. · "refuses unknown, self, archived,
  out-of-range, cyclic (including a declared cross-chain cycle) and a viewer" · canary: remove the
  cycle walk. · "a human emptying the list produces the RELEASE, not a bare clear" · canary: call
  `clearDependencies` without `announceRelease`. `task-actions.server.test.ts` · "createTask with
  `blockedBy` is born held; a bad reference refuses before a key is allocated" · canary: move the
  validation below `allocateTaskKey`. `task-detail-route.server.test.ts` · the intent's three shapes ·
  canary: remove `requireAction`. `audit-coverage.server.test.ts` · the new action.
- **Docs.** `task-lifecycle.md` §3 and §6; `surfaces.md` §1 intent list; `auth-and-rbac.md`.

### A10 · Show the wait: card, list row, hero, Current state, the Details editor and the run control (Q34-11) (C6-3)

- **Root cause.** `app/features/board/board-page.tsx:291-357` builds PR/checks/review/validation/
  continuity pills only (`STATE_PILL_CAP = 2` at `:1338`, the neutral fold at `:365-372`); the hero's
  goal chip is `task-main-sections.tsx:197-205`; the "Waiting on" row renders "Nothing" for
  `waiting: none` (`task-side-panels.tsx:778-801`); `TaskDetailsPanel` edits the trio only
  (`:403-470`); `OperatorRunControl` knows one non-structural reason (`execution-profile.tsx:332-380`).
- **Mechanism.** **Correction folded:** the wait chip is a RAW titled span in the house shape
  (`<span className="pill neutral sm" title={everyEntryWithItsState}><Icon name="lock" />blocked by …</span>`),
  pushed FIRST into `statePills` — NEUTRAL, not `blocked`, because the readiness pill already carries
  the red for a held task (`deriveDisplayReadiness` returns `blocked`) and pass 30's density rule
  forbids two equal-weight coral chips on one card; `Pill` does not gain a `title` prop. The hero
  renders each entry as a link (task page, or the project Controller page for a goal link) with its
  state when not open. The Current-state row reads "Other work: …" while `waiting` is `none`. The
  Details panel gains a "Blocked by" kv row and, **correction folded**, its OWN form with its own
  Save and one intent (`set-task-dependencies`), one toast and one refusal — never a second fetcher
  on the metadata form, whose close-on-success would swallow a dependency refusal.
  `OperatorRunControl` gains `holdNote` rendered as `sub` copy with the button left ENABLED (a manual
  run still answers a person); the open-packet `blockedReason` keeps precedence. New CSS only in the
  marked appended section, tokens only.
- **Tests.** `board-page.test.tsx` · "a card and a list row draw the neutral wait chip with every
  state in its title, and the chip's own overflow is asserted separately from the `statePills` fold" ·
  canary: remove the push. `task-detail-components.test.tsx` · the hero links · canary: drop the
  `Link` wrapper. `task-side-panels.test.tsx` · Current state and the Details row/editor, asserted by
  the SUBMITTED form value or the rendered token text, never by a hidden input's name · canary:
  remove the dependency form. `execution-profile.test.tsx` · the hold note with the button enabled;
  a packet still disables it · canary: pass the note through `blockedReason`.
- **Docs.** `surfaces.md` §5; `task-lifecycle.md` §6.

### A11 · The release engine: hooks, the goal-runner sweep, the `dependency` notification kind and the dead-dependency notice (Q34-11) (C6-4)

- **Root cause.** The only cross-task machinery reacting to Done is `maybeReconcileGoalForTask`
  (`app/server/tasks/goal-actions.server.ts:847-870`) called from `transitionStage`
  (`task-actions.server.ts:4846-4850`), `setTaskArchived` (`:6098-6101`) and `applyAcceptanceWrite`
  (`:8267-8272`), plus the single `startGoalRunner` timer (`goal-actions.server.ts:921-935`); all of
  it advances goal chains only. `NOTIFICATION_KINDS` (`app/shared/mapping/notification.server.ts:16-25`)
  has no vocabulary for "the work you waited on landed". `reprojectTask` runs BEFORE all three hook
  seams, so a projection-reading sweep at hook time sees fresh rows.
- **Mechanism.** `releaseTask` is the engine's idempotent wrapper around A9's shared
  `clearDependencies` + `announceRelease`. `releaseDependents(db, ctx, slug)` selects held,
  non-archived, non-terminal rows, resolves each list and releases where satisfied — convergent and
  cheap. `noteDeadDependency(db, ctx, slug, archivedKey)` writes one note and one notification per
  watcher when a dependency is archived and, **correction folded**, ALSO sets `waiting: "human"` on
  the dependent (a person owes the list edit, ruling 131(e)'s "until a person edits the list"), so a
  dead wait stays on the human-decision surfaces instead of nowhere; the derived `blocked` readiness
  stays. Hooks: a fire-and-forget `maybeReleaseDependents` beside each `maybeReconcileGoalForTask`
  call, `noteDeadDependency` first inside `setTaskArchived` when archiving, and
  `releaseDueDependents(db)` on the goal runner's tick (so a hand edit or a rescan still releases
  within a minute). New notification kind `dependency` with its own routing category and toggle,
  wired through `NOTIFICATION_KINDS`, the baseline CHECK, `NOTIF_PREF_CATEGORIES`,
  `defaultNotifPrefs`, `KIND_TO_CATEGORY` (compile-enforced), `storedNotifPrefsSchema`, `PROFILE_NTF`
  and `ntfMeta`. **Correction folded:** `dependencyRelease` is `autoInvokeOperator`'s NINTH
  parameter (`task-actions.server.ts:927-950`); prefer converting the tail
  (transitionDepth/transition/resolvedOption/dependencyRelease) into ONE trailing options object.
  **Correction folded:** `releaseTask` resolves the operator authority itself
  (`autoInvokeOperator` silently returns when the operator is not deployed) to choose the
  "run the operator or move the task on yourself" sentence.
- **Tests.** `dependencies.server.test.ts` · "acceptance of the last dependency releases the
  dependent: list cleared, release note, readiness lifted, `heldAtStage` cleared, watchers notified,
  operator re-invoked" · canary: delete the `autoInvokeOperator` call. · "a partial completion
  releases nothing; an archived dependency notes, notifies once and sets `waiting: human`; a skipped
  link counts as done" · canary: treat `failed` as satisfied. · "the release is convergent" · canary:
  remove the `blockedBy = []` write. · **correction folded:** a DIRECT `releaseDueDependents(db)`
  case plus one case that the tick calls it (rather than driving the `startGoalRunner` singleton).
  `notification.server.test.ts` · the CHECK pin · canary: add the kind to one side only.
  `notification-prefs.test.ts` (new) · `notifCategoryForKind("dependency") === "dependencies"`, and
  with the toggle off the release note, audit row and re-invoke still land while no row is written ·
  canary: map it to `controller`.
- **Docs.** `task-lifecycle.md` §5, §11, §12, §14; `controller-and-goals.md` §7.3;
  `data-model.md` §3; `auth-and-rbac.md`.

### A12 · Operator runtime: the `blocked-by` refusal, the quiet backstop, the settle, the release trigger and the doctrine (Q34-11) (C6-5)

- **Root cause.** `app/server/runtimes/operator-run.server.ts:1269` `runOperator` refuses only
  `terminal-stage` for scheduled runs (`:1300-1334`) and `open-packet` for manual runs (`:1336-1358`);
  `RunOperatorResult.refused` is a two-value union (`:249-258`); `operatorLeftTaskStranded`
  (`:681-694`) judges archived/packet/recommendations/auto-boundary only, so a held task at an `auto`
  stage got the paid nudge (JC-9: five runs, no dispatch); `clearWaitingToHuman`
  (`task-actions.server.ts:4015-4048`) settles `human` for every non-terminal task; the doctrine's
  tail (`:3510`) forbids ending a turn with nothing done and no packet, and the stranded-resume text
  (`:3479-3482`) tells the operator to open a packet asking the human to confirm the hold.
- **Mechanism.** `refused` gains `"blocked-by"`, refused at fire time for `create`, `transition` and
  `scheduled` when the list is non-empty (no run, no cost). **Correction folded:** that branch calls
  `settleWaitingAfterOperator(db, taskFileRef(input))` with the same comment the terminal branch
  carries — a trigger drained off the queue had its settle skipped by `releaseOperatorLease:562-570`,
  so without it a queued `transition` leaves `waiting: "agent"` on a task with no agent forever.
  `operatorLeftTaskStranded` returns false when dependencies are listed. `clearWaitingToHuman` settles
  to `none` on a held task with nothing pending. New trigger `dependencies-released` with its
  `dependencyRelease` payload and a doctrine branch (re-read the base branch, withdraw a moot hold
  packet, then continue). **Correction folded:** when the task is held, `operatorTurnDoctrine`
  REPLACES the stage-rule tail rather than following it — the "NEVER end your turn … with nothing
  done and no packet" sentence (`:3510`) and the `resumeContext` packet exit (`:3479-3482`) are
  omitted, so the prompt cannot carry two contradictory orders. The snapshot carries `blockedBy` with
  resolved states. The schedule runner retires a due occurrence as `fired` with a
  "Scheduled action skipped" note and `outcome: "skipped-held"`. **Correction folded:** the
  `run-agent` scheduled arm (`schedule.server.ts:600-620`) is decided and recorded — a
  human-scheduled agent run STANDS, because ruling 131(d) refuses operator triggers only, and
  `task-lifecycle.md` §9 says so. **Correction folded:** a queued `dependencies-released` can be
  coalesced away newest-wins; that is acceptable because the release note is durable, and the item
  says so.
- **Tests.** `operator-run.server.test.ts` · "create, transition and scheduled are refused
  `blocked-by` at no cost; reactive triggers still drive" · canary: remove `"transition"` from
  `HELD_TRIGGERS`. · "a `transition` drained off the lease queue and refused leaves `waiting: none`,
  never `agent`" · canary: delete the settle from the new branch. · "the backstop never nudges a held
  task" · canary: delete the early return. · "a held prompt does NOT contain 'NEVER end your turn'
  and DOES name `set_dependencies`" · canary: append the doctrine instead of replacing the tail. ·
  "the `dependencies-released` doctrine names the entries, the base re-read and the moot packet" ·
  canary: return "" from `dependenciesInstruction`. `schedule.server.test.ts` · `skipped-held` ·
  canary: drop the branch. `operator-actions.server.test.ts` · the snapshot's `blockedBy` · canary:
  omit it.
- **Docs.** `operator.md` §3 and §4; `task-lifecycle.md` §6 and §9.

### A13 · The operator's `set_dependencies` tool on both backends and the shipped doctrine (Q34-11) (C6-6)

- **Root cause.** The Claude toolkit builds twelve tools and none records a wait;
  `OPERATOR_PLAN_TOOLS` (`operator-run.server.ts:1568-1596`) carries ten verbs and none either;
  `OPERATOR_PLAN_TOOL_CAPABILITIES` is `satisfies Record<OperatorPlanTool, …>` (`:1609-1625`) so the
  parity is compile-enforced; the shipped `operator.definition.md` line 25 offers only
  advance/hand-off/packet.
- **Mechanism.** `operatorSetDependencies` gated on `generate-packets` (reusing the packet's own
  capability rather than minting a catalog id for one tool), delegating to `setTaskDependencies` with
  `operatorAuthorized: true`; a validator refusal is `noop` with the validator's sentence (state, not
  policy: the LV-03 misblame rule), an unchanged list is `noop`, success is `done`. The Claude tool
  and the Codex plan verb both land (the F27-O3 parity test pins them), with the plan's JSON schema
  field, the runtime zod mirror (`.optional()` so persisted plans replay) and an executor case whose
  missing list is a malformed step. The seeded persona gains the one sentence that a wait on other
  work has its own tool and is never a packet. **Corrections folded:** (1) the parity test's negative
  case builds an authority with every capability `direct` EXCEPT `generate-packets: "off"` (leaving
  `append-typed-events` granted), which is the only shape under which the stated canary can go red;
  (2) `app/features/copy-ban.test.ts`'s seed-asset dash scan (`:936`, `:963-975`, empty allowlist)
  and the `govern*` literal scan (`:783`) are named as gates on the persona edit; (3) the sha256 of
  the CURRENT `operator.definition.md` is appended to
  `PRIOR_SHIPPED_HASHES["agents/definitions/operator.md"]` BEFORE the file is rewritten; (4) the
  malformed Codex step is asserted through `narrateRefusedActions`'s STATE arm, not the helper's raw
  string.
- **Tests.** `operator-toolkit.server.test.ts` · built under `generate-packets`, withheld when off,
  plan enum agrees · canary: gate the Claude tool under `append-typed-events`.
  `operator-actions.server.test.ts` · done/noop/noop/denied · canary: return `denied` for the
  validator's error. `operator-run.server.test.ts` · the Codex step executes; a null list is a
  malformed step · canary: delete the case from the executor switch.
  `default-assets.server.test.ts` · the persona upgrades in place · canary: remove the outgoing hash.
- **Live validation is a required step** (TESTPLAN V63), because this item carries the pass's two
  highest-risk shapes and neither is proven by a unit test alone: backend PARITY (a Claude tool and
  a Codex plan verb that must agree) and a SHIPPED-ASSET rewrite (an existing store's
  `operator.definition.md` upgrades in place only if the outgoing sha256 was appended first).
  Both legs run for real: JC-16 under the Claude operator and a scratch task under a Codex-pinned
  operator, each prompted to record what its task waits on. Assert on both: the wait lands in
  `task.md` and NO hold packet is opened; `task.dependencies.updated` carries `added`/`removed`; an
  unchanged list answers `[noop]`; a bad reference answers the VALIDATOR's own sentence as a `noop`,
  never `denied` (the LV-03 misblame rule); the Codex run's persisted plan REPLAYS the step on
  resume; and with `generate-packets` off the tool is neither built on Claude nor offered in the
  Codex plan enum. Read the upgraded persona back out of the running store, not out of the repo.
- **Docs.** `operator.md` §5 and §6; `agents-and-runtime.md` seeded catalog.

### A14 · Controller surface: `blockedBy` on tasks and goal links, chain inheritance, the reads, the context header, the Goals panel and the doctrine (Q34-11) (C6-7)

- **Root cause.** `create_task` (`app/server/controller/controller-toolkit.server.ts:962-1000`) takes
  title/goal/priority/labels; `update_task` (`:1132-1241`) has `hasMeta` at `:1156-1157`, the
  empty-call guard at `:1158-1162` and the applied/unchanged/refused arms at `:1168-1235`;
  `createGoal`'s link map is `goal-actions.server.ts:132-141` (link 1's own `createTask` at
  `:176-189`); `startLinkTaskLocked` is `:548-620` with its `createTask` at `:576-586`; the per-turn
  task header array is `controller-context.server.ts:271-278`; the `startLinkTask` catch that parks a
  chain in `attention` is `goal-actions.server.ts:804-828`.
- **Mechanism.** `create_task` and `update_task` gain `blockedBy` (the FULL list; `[]` clears),
  gated inside `setTaskDependencies` by `edit-task-meta` and reported on its own arm; the empty-call
  guard names the new field. `create_goal` links and `update_goal`'s `edit_link`/`add_link` gain
  per-link `blockedBy`, spelling-checked at write time; **correction folded:** absent-vs-`[]` is an
  explicit contract of the GOAL WRITER (`edit_link` without the key leaves the link's list, `[]`
  clears), tested on both arms, so the F33-7 merge-field rule is not re-broken one layer down.
  **Correction folded:** the cycle guarantee moves UP to declaration time — when a link's `blockedBy`
  is written, the walk traverses declared `links_json[].blockedBy` edges as well as created tasks and
  refuses a mutual sibling-chain wait with A9's cycle sentence. `startLinkTaskLocked` copies the
  link's list into `createTask` (validated there) and the link history says what it waits on.
  `list_tasks`, `get_task`, `get_goal` and `list_goals` expose the wait; the per-turn task header
  gains a `waits on:` line and the board table a `waits on N` suffix; the Goals panel renders
  `waits on …` under a link. The controller definition and the guide skill gain the two sentences,
  with both outgoing hashes appended to `PRIOR_SHIPPED_HASHES` before the rewrite.
- **Tests.** `controller-toolkit.server.test.ts` · create/update set it, `[noop]` on an unchanged
  list, refusal by name, `[]` clears (and produces the release), a viewer is refused · canary: drop
  `blockedBy` from the empty-call guard. `goal-actions.server.test.ts` · **correction folded:** ONE
  unambiguous case — goal-1 first, then goal-2 whose link 1 declares `blockedBy: ["goal-1 link 2"]`;
  assert the created task's file, `waiting: "none"`, the history line, and (with the FAKE
  `runOperator` seam) that the `create` trigger was handed over, leaving the refusal itself to A12's
  real-`runOperator` test · canary: drop `blockedBy` from `startLinkTaskLocked`'s input. · the
  attention-park case for an unresolvable reference · canary: swallow the validation error.
  `controller-context.server.test.ts` · the header line and the board suffix · canary: remove the
  line. `controller-page.test.tsx` · the Goals-panel span · canary: remove it.
  `default-assets.server.test.ts` · both assets upgrade in place · canary: omit the skill's hash.
- **Docs.** `controller-and-goals.md` §4, §2.1/§3, §7.1, §7.3, §7.4.

### A15 · Convert the two live holds, the scenario test, the runbook entry and the ledger (Q34-11) (C6-8)

- **Root cause.** JC-7 ended its hold as `waiting: human` with no packet; JC-9 ended with an
  operator `blocked` packet used as a standing token after five runs and $4.27 with no agent
  dispatched. `heldAtStage` is cleared only by transitions (`task-actions.server.ts:4722`), packet
  resolutions (`:6723`), goal edits (`:649`) and acceptance (`:8184`); nothing converts a hold into a
  watched wait and nothing releases it.
- **Mechanism.** **Correction folded — the live conversion starts with the projection step:** before
  any dependency is set, stop nothing, run the additive
  `ALTER TABLE task_projections ADD COLUMN blocked_by_json TEXT NOT NULL DEFAULT '[]'` that
  `boot.server.ts:308-312` prescribes, restart, and confirm the boot integrity line reports no
  `projectionMissingColumns` — explicitly NOT a re-baseline, and never a host-side `sqlite3` write
  against the running container (D34-1, the dual-writer hazard). Record the ALTER and the boot line
  in NOTES.md. Then: JC-7 gains `goal-1 link 2, goal-1 link 3, goal-1 link 4` through the task page
  (or `update_task`); JC-9 gains the same list FIRST (setting a wait never touches a packet), then
  its standing packet is resolved with its recommended option, whose one reactive turn reads the
  recorded wait and stops. When goal-1's links 2 to 4 reach Done both release themselves.
  **Correction folded:** the worked example everywhere in this cluster is a THREE-entry list, not a
  single link. The runbook gains "A task waits on other work"; FINDINGS.md gains a `Q34-11` row in
  the table's own columns (`| Q34-11 | task dependencies | high | fixed (ruling 131) | … |`) with a
  `### Q34-11` detail, and QUESTIONS.md gets the `→ ruling 131` trailer.
- **Tests.** `dependencies-conversion.server.test.ts` (new) · "JC-7 shape: converts, the backstop
  stays quiet, the release clears `heldAtStage` and re-invokes" · canary: remove the `heldAtStage`
  clear. · "JC-9 shape: the packet stays open while the list is set, resolving it runs ONE reactive
  turn that reads the wait, the release lifts the stored `blocked` and the turn withdraws the moot
  packet" — **correction folded:** drive the REAL `runOperator` with a stubbed provider so the run
  start flips `waiting` to `agent` and the settle is actually exercised, and state that the
  "packet open, waiting stays human" step depends on A9's no-packet condition · canary: stop lifting
  readiness from `blocked` to `ready`.
- **Docs.** `runbook.md` new section; `requirements-status.md` amendment chronology; the pass ledger.

### A16 · Revision drift counts authored commits only; a base refresh is reported as one (closes F34-14; owner answer to Q34-12) (C4-1)

- **Root cause.** `app/server/github/github-reconciler.server.ts:464-486` stores
  `revisionDrift = {aheadBy, headSha}` from `compare(reviewedSha...head).ahead_by`, which counts
  every commit reachable from the head and not from the reviewed sha, so an operator's base merge
  (4 base commits + the merge commit) reads as 5 unreviewed commits. The compare reader
  (`branch-sync.server.ts:242-300`, `ghCompareCommitSchema` at `:199-205`) keeps only `{sha, msg}`
  and never reads `parents`, so nothing downstream can tell a merge commit from an authored one.
  Five consumers render it with their own wording: `accept-confirm.tsx:381-398`,
  `review-helpers.ts:78-81`, `task-actions.server.ts:7879-7887` (`revisionDriftNote`, the permanent
  completion record), `operator-actions.server.ts:1867-1873` and
  `operator-run.server.ts:3310-3325` (the UNREVIEWED doctrine for any `aheadBy > 0`).
- **Mechanism.** New pure `app/shared/revision-drift.ts` with
  `RevisionDrift = {headSha, authored, baseRefresh: {merges, commits} | null}` and ONE
  `describeRevisionDrift` returning the canonical sentence every surface prints verbatim, plus
  `revisionDriftNote` moved beside it. `prRefSchema.revisionDrift` takes the new shape;
  **correction folded:** `merges: z.number().int().min(0)` (not `positive()`, because
  `update_branch_from_base` runs a plain `git merge` and a strictly-behind branch FAST-FORWARDS
  with zero merge commits), and the rule is stated: `baseRefresh = merges > 0 || commits > 0 ?
  {merges, commits} : null`. `ghCompareCommitSchema` gains `parents`; `BranchCompare.commits[]`
  carries `fullSha` and `parents`; **correction folded:** the `{sha, msg}` projection moves INTO
  `taskCommits` (`branch-sync.server.ts:325`, `filter(...)` becomes `filter(...).map(...)`) so
  `github.commits` keeps its shape and no task file churns, with `branch-sync.server.test.ts:85`
  and `:131` in the sweep. The reconciler classifies each commit in `reviewedSha...head`: not in the
  base compare's set → a base commit; a two-parent commit whose sha is in `fm.baseRefreshes[]`
  (A17) → a clean merge; anything else → authored.
  **Corrections folded:** (1) fail-closed extends to the BASE compare — classify only when
  `compare !== null && compare.droppedCommits === 0 && compare.commits.length >= compare.aheadBy`,
  in addition to the same three checks on the since-compare, and state that the base is
  `gh.defaultBranch` so a PR retargeted elsewhere is unclassifiable; (2) the carry rule is the one
  the ruling states — a commit that cannot be classified counts as AUTHORED, and a pass that cannot
  classify at all carries the cached record forward or, with no cached record, writes
  `{headSha, authored: since.aheadBy, baseRefresh: null}`, never omitting the key while
  `pr.headSha !== reviewedSha`; the same rule covers a since-compare whose status is not
  `ahead`/`identical`. Every consumer reads `describeRevisionDrift`; the operator doctrine says
  UNREVIEWED only for authored commits and names a base refresh as a base refresh; the review-queue
  row carries the whole record. **Correction folded:** `getBranchCompare`'s third non-test caller
  `branch-sync.server.ts:588` (`ensureTaskBranch`) joins the sweep, and `no-change-completion.server.ts`
  is under `app/server/tasks/`.
- **Tests.** `app/shared/revision-drift.test.ts` (new) · the four shapes and the completion suffix ·
  canary: derive the kind from `authored + baseRefresh.commits`. `github-reconciler.server.test.ts` ·
  "a base refresh records `authored: 0` with the merge and base commits reported separately" ·
  canary: drop the `notOnBase` membership test. · "an authored commit on top of a base refresh
  counts; a merge Viberr did not make counts as authored" · canary: treat any two-parent commit as
  clean. · "a fast-forward refresh records `{merges: 0, commits: N}`" · canary: restore `positive()`.
  · **correction folded:** the unclassifiable case is driven by a 404 (`missing_ref`) base compare —
  the ONLY status that reaches the drift block with `compare === null`, since `rate_limited` and
  `forbidden` return early at `:340-368` — plus a second case with a null entry in the base
  compare's commits; assert the record is CARRIED, and add the NO-CACHE case asserting
  `{authored: aheadBy}` · canary: remove the base-compare completeness guard.
  `branch-sync.server.test.ts` · the reader carries `fullSha`/`parents` AND `github.commits` entries
  are still exactly `{sha, msg}` after a reconcile · canary: remove `parents`; leave the projection
  out of `taskCommits`. The six consumer suites each assert that THEIR surface prints
  `describeRevisionDrift(...).sentence` verbatim, with one canary named per file (no consumer
  shares a canary with another, and none of the six is a typecheck error):
  - `accept-confirm.test.tsx` · the Merge-head row · canary: restore the count-based sentence at
    `accept-confirm.tsx:396-398` (`{drift.authored + (drift.baseRefresh?.commits ?? 0)} commit(s)
    added since review; they merge unreviewed`), which renders 5 for the JC-8 base-refresh fixture.
  - `review-helpers.test.ts` · the queue subline · canary: restore
    `review-helpers.ts:78-81`'s `if (pr.revisionDrift && pr.revisionDrift.aheadBy > 0)` arm over the
    summed count.
  - `task-actions.server.test.ts` · the permanent completion record · canary: restore
    `revisionDriftNote`'s old body (`task-actions.server.ts:7879-7887`) so a base refresh writes
    "N commits were added to the PR head after the review" into a Done task's timeline.
  - `operator-run.server.test.ts` · the turn doctrine · canary: restore `driftInstruction`'s blanket
    UNREVIEWED paragraph (`operator-run.server.ts:3309-3323`) for any non-zero total.
  - `operator-actions.server.test.ts` · the `get_task` snapshot · canary: emit the old
    `{aheadBy, headSha}` object at `operator-actions.server.ts:1867-1873` instead of the record, so
    the operator's read and the accept dialog disagree again.
  - `review-queue.server.test.ts` · the queue row carries the WHOLE record · canary: restore
    `review-queue.server.ts:177-178`'s `pr.revisionDrift = { aheadBy: ... }` projection, which
    drops `baseRefresh` before the row is built.
- **Docs.** `decisions.md` ruling 132 with a dated note on ruling 42/R17-1; `github-delivery.md`
  §5 and §6; `task-lifecycle.md` §11; `operator.md` §4; `file-formats.md`; `glossary.md`.

### A17 · The operator's branch update records its merge commit and re-measures drift before answering (closes F34-14; ruling 132) (C4-2)

- **Root cause.** `app/server/github/update-branch.server.ts:309-322` merges and `:426` returns
  `{status:"updated", branch, base, commits}` with no merge sha and no base sha;
  `update-branch-operator.server.ts:203-213` audits, `:216-229` appends the event and `:227`
  reprojects, but never reconciles, so `pr.revisionDrift` stays whatever the five-minute poll wrote
  (null on JC-3) while the reconciler later wrote `aheadBy 5`.
- **Mechanism.** New top-level frontmatter `baseRefreshes: []` (`{mergeSha, baseSha, base, commits,
  at}`), a first-class list like `verdicts`; **correction folded:** it is added to
  `TASK_FRONTMATTER_KEYS` (`task-file.schema.ts:969-1000`) so the unknown-key sweep does not give it
  a second home and the file-formats section-2 pin becomes its gate, and to
  `test-support/test-store.ts` `baseTaskFrontmatter` and the demo fixture.
  `updateWorkspaceBranchFromBase` reads `git rev-parse HEAD` and `git rev-parse origin/<base>`
  after the merge and BEFORE the push; an unreadable sha is an `update_failed` that resets to
  `preSha` exactly like a failed push, so a merge is never published unrecorded.
  **Correction folded:** every recorded refresh must be a real merge OR be recorded honestly — pass
  `--no-ff` to the merge (asserted in the git-level test), or keep the fast-forward and state that
  such a refresh records `mergeSha === baseSha` and classifies as `{merges: 0, commits: N}`, with a
  reconciler test for it. **Correction folded:** the operator layer's write is SPLIT explicitly —
  mutator A (under the lock) pushes the `baseRefreshes` row; then `reconcileTask`; then the file is
  re-read and the `github` timeline event carrying `describeRevisionDrift(...).sentence` is written,
  and the tool message is built from that same re-read (the sentence does not exist at mutator
  time). **Correction folded:** the reconcile inside an operator tool call can append divergence
  notes, notify watchers, run `branchCleanupOnMerge` and fire `wakeOperator`; that is listed in the
  item's risks with the reason it is acceptable here (the PR is open, so no divergence arm fires).
  The audit details gain `mergeSha`; the crash window between push and record is stated, with the
  next classified pass as the self-heal.
- **Tests.** `update-branch.server.test.ts` · "an updated branch names its merge commit and the base
  tip; an empty rev-parse resets and does not push" · canary: return the old four-field result.
  `update-branch-operator.server.test.ts` · "a successful update records the row, re-measures drift
  and says so" · canary: remove the `reconcileTask` call; remove the `baseRefreshes` push (the
  reconcile then classifies the merge as authored). · **correction folded:** the "cannot re-measure"
  case is driven through `fetchImpl` (a successful git update whose reconcile fetch answers 500),
  never through "no PAT" (which returns `no_pat` before the merge and can never reach the `updated`
  arm), asserting the message AND that the `baseRefreshes` row exists · canary: swallow the
  reconcile result silently.
- **Docs.** `operator.md` §5; `github-delivery.md` §6; `file-formats.md`; `data-model.md`.

### A18 · An engaged deliverer acts at any stage; eligibility gates NEW engagements (closes F34-16; owner answer to Q34-13) (C5-1)

- **Root cause.** `assertStageEligible` (`app/server/tasks/specialist-run.server.ts:3630`) is called
  at exactly three sites: `assignSpecialist` (`:734`), `assignReviewer` (`:909`) and
  `dispatchAgentRun` (`:1470`, the RUN boundary, with the comment at `:1464-1468`). Every dispatch
  door funnels through `startAgentRun` (`:1177` → `:1194`), so the operator's `run_agent`, the human
  Run control, the controller tool, the scheduler, the `retry_other_backend` resolution and
  `applyRecommendation` are all gated there — while the @mention path is not: `commentToAgent`
  resumes at `task-actions.server.ts:1618` (`if (target.session)` → `resumeRun`), and `resumeRun`
  (`run-service.server.ts:1398-1487`) checks continuity and principal but never the stage. That is
  exactly the live JC-3 sequence.
- **Mechanism.** ONE home beside `specialistEligibleForStage`: `runEligibilityFor(profileId, spec,
  engagements, stageId, board)` → `{ok:true, why:"declared"|"engaged-deliverer"} | {ok:false, refusal}`.
  **Correction folded:** `declared` is tested FIRST so `stageEligibility` names the exemption only
  when it was actually needed (by dispatch time the auto-engage has already written
  `delivers: true`, so an exemption-first order would stamp `engaged-deliverer` on every delivering
  run and record nothing). `assertStageEligible` stays as the NEW-engagement guard at `:734` and
  `:909`; `dispatchAgentRun` uses `runEligibilityFor`; `runStartedDetails` records
  `stageEligibility: "declared" | "engaged-deliverer" | "undeployed"` on `task.agent.run_started`.
  New `assertResumeEligible` is called as the first statement inside `commentToAgent`'s
  `if (target.session)` branch, inside the A8 try, so a supporting agent gets the honest partial
  success (comment posted, `runNotStarted` names the refusal) and the deliverer resumes anywhere.
  **Correction folded (the sibling hole):** `assertResumeEligible` must NOT pass an UNENGAGED
  profile — a released supporting agent keeps its finished run rows and provider session, and
  `resolveMentionedAgent` matches any deployed specialist by name, so an @mention would resume it at
  a stage its profile does not declare while the same mention with no session is refused by
  `assignReviewer`. With no engagement row it applies the NEW-engagement rule (resolve the deployed
  profile, require `specialistEligibleForStage`), keeping the undeployed catch as the
  "declares no stages" pass-through. **Correction folded:** `assertResumeEligible` is reached via
  `await import("./specialist-run.server")` (the cycle at `task-actions.server.ts:1353`).
  **Correction folded:** the two docstrings at `specialist-run.server.ts:3598-3606` and `:3624-3629`
  are rewritten in this item, since both still describe the deleted run guard.
  **Correction folded:** the dash-gate risk note is wrong and is dropped — `copy-ban.test.ts`'s
  BANNED_DASH scan covers `app/features`, `app/routes`, `app/ui` and the seed assets, not
  `app/server`; the `govern*` literal scan (`:783`) is the one that reaches server strings.
- **Tests.** `specialist-run.server.test.ts` · "the ENGAGED deliverer runs at a stage its profile does
  not declare" (REVERSES the F1 run-boundary case at `:573-621` deliberately, recorded in the ruling
  and in the test's own comment) · canary: call `assertStageEligible` unconditionally again. · "a
  SUPPORTING engagement stays stage-scoped at the run boundary" · canary: return ok for every engaged
  profile. · "a NEW delivering engagement is still gated" · canary: delete the `:734` call.
  `agent-reply.server.test.ts` · "an @mention of a supporting agent posts the comment and refuses the
  run" · canary: remove `assertResumeEligible`. · "an @mention of the DELIVERING agent resumes it" ·
  canary: drop the `delivers` arm. · "an @mention of a RELEASED profile at an undeclared stage is
  refused" · canary: return ok for an unengaged profile. `schedule.server.test.ts` · a scheduled
  run-agent for the deliverer fires — **correction folded:** asserted through the file's existing
  status POLLER, because the finalize is detached (`schedule.server.ts:541`) · canary: reinstate the
  unconditional assert. `operator-actions.server.test.ts` · a `retry_other_backend` resolution starts
  the retry · canary: same.
- **Live validation** (required, this is where the defect lived): on :5173 with a deliverer scoped
  away from the current stage — the Run control starts it; a human @mention resumes it; an @mention
  of a supporting profile posts the comment and shows the refusal; the audit row carries
  `stageEligibility`.
- **Docs.** `decisions.md` ruling 133 plus a dated note under ruling 98(b); `agents-and-runtime.md`
  §4.1; `task-lifecycle.md` §4, §7, §8, §9; the pass ledger.

### A19 · The operator is told the rule: snapshot, trace, toolkit, doctrine and persona (closes F34-16; ruling 133) (C5-2)

- **Root cause.** `operatorSnapshot` maps `eligibleForCurrentStage: specialistEligibleForStage(...)`
  at `operator-actions.server.ts:1809-1815` with the field comment at `:1416-1418`;
  `recordAgentSelectionTrace` uses the same predicate at `:2225-2233`; the toolkit says it in words
  at `operator-toolkit.server.ts:262` (`get_task`), `:541` (`run_agent`) and `:626`
  (`transition_stage`: "the move to make when a reviewer requests changes and the delivering profile
  does not work the review stage"); the doctrine at `operator-run.server.ts:3367`, `:3396`, `:3500`;
  the persona at `operator.definition.md` line 25.
- **Mechanism.** The snapshot's `eligibleForCurrentStage` is computed with `runEligibilityFor` and
  gains a sibling `engagedAsDeliverer`; the field comment says eligibility is where a profile may be
  NEWLY engaged. **Correction folded:** the TRACE's posture is derived from what the dispatch will
  DO, not from the pre-dispatch file — `resolveDeliversIntent`'s answer is already computed at
  `:2364` and passed into the selection at `:2402-2404`, so the recorded field is that value (or the
  field is named `deliveringAtSelection`), its relationship to the existing `alreadyEngaged` is
  stated in the field comment, and one assertion proves a first-dispatch (auto-engage) candidate is
  not marked as already delivering. The three toolkit sentences and the three doctrine sentences are
  rewritten so rework routing is a WORKFLOW choice, never an eligibility workaround; `run_agent`'s
  description says never to hand delivery to another profile to get around a stage. The persona's
  rework paragraph is rewritten and the outgoing sha256
  (`9462381afd6c87b991f5653610252ac2e7a4815b039709d818bbecec1db7532e`, verified today) is appended to
  `PRIOR_SHIPPED_HASHES` so unedited store copies upgrade at boot. **Correction folded:** the
  seed-asset dash scan (`copy-ban.test.ts:936`, `:963-975`, empty allowlist) is a HARD gate on the
  persona edit; the doctrine and toolkit strings are dash-exempt but still under the `govern*` scan.
- **Tests.** `operator-actions.server.test.ts` · the snapshot's two booleans · canary: map back to
  `specialistEligibleForStage`. · the trace's fields, including the first-dispatch case · canary:
  compute `eligibleForStage` with the old predicate. `operator-toolkit.server.test.ts` · the three
  descriptions · canary: restore any one original sentence. `operator-run.server.test.ts` · the
  agent-reply doctrine prompts the deliverer in place — **correction folded:** with the matching
  assertion on `buildCodexOperatorPrompt` too, since a sentence has landed in one builder and not
  the other before · canary: restore `:3367` or `:3500`. `default-assets.server.test.ts` · the
  persona upgraded in place with its outgoing hash listed · canary: revert the sentence.
- **Live validation:** a task at Review whose deliverer is scoped elsewhere — `get_task` shows
  `eligibleForCurrentStage: true` with `engagedAsDeliverer`, and the turn re-prompts in place instead
  of opening a second packet.
- **Docs.** `operator.md` §4 and §5; `agents-and-runtime.md` §6.

### A20 · The branch-conflict packet offers only options that can execute (closes F34-16; ruling 133) (C5-3)

- **Root cause.** `conflictOptions(branch, base)` (`app/server/github/update-branch-operator.server.ts:93-133`)
  is pure and unconditional: `redirect` recommended at `:105-114` ("Have the delivering agent resolve
  the conflict … in its own workspace"), plus `custom` and `archive_task`. Nothing consults the
  task's engagements, so the packet promises a resolver that may not exist; the harness itself seeds
  VIB-1 with no engagements (`update-branch-operator.server.test.ts:44-48`) and the conflict case
  (`:146-186`) asserts the redirect is recommended on that deliverer-less task.
- **Mechanism.** `conflictOptions` takes a typed `resolver: {kind:"deliverer", name} | {kind:"none", reason}`.
  **Correction folded:** the task file is BOUND at `:186` (today it is read and discarded), the
  resolver is computed inside a `result.status === "conflict" || result.status === "push_conflict"`
  guard placed BEFORE `recordAudit` at `:203-214`, `BranchUpdateAuditDetails` (`:46-52`) gains
  `resolver?: "deliverer" | "none"` documented as conflict-packets-only and set in the file's
  existing per-key `if` style (never a conditional spread), and the same value is passed into
  `conflictOptions` at `:260`. **Correction folded:** the rule applies to BOTH the conflict and the
  `push_conflict` packet, which share that one call and have different bodies at `:246-249`; the
  push_conflict body gets its own wording (no merge is described there). With a resolver the options
  are unchanged; without one, `custom` becomes recommended ("Resolve `<branch>` yourself"), the body
  says why, and an observation names the delivering agent. **Correction folded:** the cycle-free
  import justification is corrected — `update-branch-operator` already statically imports
  `operator-actions.server`, which imports `specialist-run`, so the edge exists today.
- **Tests.** `update-branch-operator.server.test.ts` · "a CONFLICT with a deployed repo-write
  deliverer keeps recommending the redirect" (the existing case at `:146-186`, fixture completed with
  a deployed and engaged `dev`) · canary: pass `{kind:"none"}` unconditionally. · "with NO delivering
  agent the packet offers only what can execute and says why" · canary: always build the three
  options. · "a deliverer whose repo-write grant was withdrawn is not offered" · canary: treat any
  deployed deliverer as a resolver. · the same two shapes for `push_conflict`.
- **Live validation:** open the conflict packet on a task with no delivering engagement and read the
  rendered options, body sentence and observation.
- **Docs.** `github-delivery.md` `update_branch_from_base` row; `operator.md` "Who opens packets".

### A21 · Q34-14 · Who may hand delivery to another profile (closes F34-16's remaining half) (C5-4)

- **Root cause as filed.** `operatorDispatchAgent` (`operator-actions.server.ts:2298`) executes an
  explicit `delivers: true` for any repo-write profile (`:2400-2442`), which `dispatchAgentRun` turns
  into a hand-off through `assignSpecialist`. Live, that let the JC-6 operator substitute the stock
  `developer` (opus[1m], not fable) to get around a stage wall that A18 removes.
- **OWNER ANSWER (Q34-14, 2026-09-04): the operator may switch the delivering agent however it
  judges best.** Verbatim: *"operator is allowed to do agent switching however it wants, human can
  already redirect over a chat with operator or agent allocation."* So ruling 98(a) stands unchanged,
  no gate is added, no recommendation card is introduced, no new UI control is built, and **no new
  ruling number is spent**: number 145 is released back to the pool. `decisions.md` records the
  confirmation as a dated note under ruling 98(a), naming this pass and the JC-6 substitution as the
  case that tested it.
- **What ships in this pass.** (1) Nothing in `operatorDispatchAgent` changes: the `direct` arm at
  `:2400-2442` keeps performing an explicit hand-off, and the `recommend` arm keeps filing a card.
  (2) A19's doctrine and `run_agent` description keep the one sentence that is now purely
  informational, and it is REWRITTEN so it cannot read as a prohibition: after A18 the engaged
  deliverer runs at every stage, so a hand-off is a choice about who should build, never a way around
  a stage. (3) The substitution motive itself is what A18 removes; this item's whole content after
  the owner's answer is that wording plus the dated note.
- **Callers swept.** `operatorDispatchAgent` (`operator-actions.server.ts:2298-2442`) — read, not
  changed; `run_agent`'s description in `operator-toolkit.server.ts`; the shipped operator doctrine
  (`app/server/seed/assets/operator.definition.md`, hash-bumped in `default-assets.server.ts` with
  A19's edit, one bump for both).
- **Tests.** `operator-actions.server.test.ts` · "an explicit hand-off to another deployed deliverer
  still runs directly under `direct` autonomy, after ruling 133" · canary: add any refusal or card
  branch to the `delivers: true` arm and the case fails. (This is the regression guard for the
  owner's answer: it fails the moment somebody re-gates the hand-off.)
  `default-assets.server.test.ts` · "the shipped doctrine says a hand-off is about who builds, not
  about stages" · canary: restore the old prohibition sentence.
- **Docs.** `docs/domain/operator.md` §5 (the hand-off paragraph states the owner's rule),
  `docs/domain/agents-and-runtime.md` §4.1, and a dated confirmation note under ruling 98(a) in
  `docs/architecture/decisions.md`.

### A22 · The Agents surface says what "N of M stages" means (closes F34-16; ruling 133 clause d) (C5-5)

- **Root cause.** `StageEligibility` (`app/features/agents/agents-page.tsx:491-568`) renders the
  chips and the summary at `:511-519` with no statement of what eligibility gates; its header comment
  (`:472-490`) and the editor hint (`create-profile-modal.tsx:700`, the only occurrence of "stages
  this profile may work in") describe the pre-ruling rule.
- **Mechanism.** **Correction folded — the paragraph renders in TWO parts.** Always: "Eligibility
  decides where this profile may be newly engaged. Once it delivers a task it may be prompted on that
  task at any stage." The scoping clause ("A supporting or reviewing engagement runs only at the
  stages above.") renders ONLY when `!unrestricted` (the local already computed at `:501`), because
  `unrestricted` is true for `spanAll`, for an empty list and for a list whose ids all resolve to
  nothing — where naming a scope would be a new copy lie and would contradict the R14-1 note two
  lines below at `:557-566`. Existing `.fine` / `.fine.sm` tokens only, so the app.css gate is
  untouched. The editor hint becomes "stages where this profile may be newly engaged".
  **Correction folded:** the two server docstrings folded into A18 keep the mirrored comments honest.
- **Tests.** `agents-page.test.tsx` · the panel states the rule for a restricted profile · canary:
  delete the paragraph. · **correction folded:** an UNRESTRICTED profile (`spanAll` or `stages: []`)
  renders the first sentence and NOT the scoping clause · canary: render the paragraph
  unconditionally. · the editor hint · canary: restore the old hint.
- **Live validation:** read the Eligible stages panel for one restricted and one `spanAll` profile,
  and the deployment editor's hint.
- **Docs.** `surfaces.md` §5; `glossary.md` "Engagement" and "Agent profile / template".

### A23 · A delivery pushes rework to the task's own open PR (closes F34-11) (C1-1)

- **Root cause.** `app/server/tasks/operator-actions.server.ts:2487-2496`: `operatorDeliverForReview`
  reads `existing.parsed.frontmatter.pr` and returns `{outcome:"noop", message:"PR #N is already
  open for review; there is nothing to deliver."}` for any cached non-terminal state, BEFORE
  `performDelivery` (called at `:2517`); the comment says a fresh push of an unchanged workspace is
  wasted motion, which assumes the workspace never changes after the first delivery.
  `pushWorkspaceBranch` (`app/server/github/push-workspace.server.ts:468-745`) never reads the remote
  task branch: it counts commits ahead of `origin/<default>` and pushes, and its own contract comment
  (`:468-472`) says a push with nothing new still reports `pushed`. `performDelivery`'s failure
  router is at `task-actions.server.ts:5137`, with a SECOND log-only `push.status !== "pushed"` check
  at `:5056`; the ruling-48 re-queue is `if (result.created)` at `:5390`. `openTaskPr` already
  re-reads a cached PR live and reuses it (`pr-open.server.ts:348-386`), so only the operator's
  pre-check hid the mechanism.
- **Mechanism.** (A) `pushWorkspaceBranch` reads `headSha` and origin's head for the branch
  (`git ls-remote --heads origin <branch>` under the askpass env, 30 s) before pushing; equal →
  a NEW `{status:"up_to_date", branch, headSha}` member with no push; otherwise push, and the
  `pushed` member carries `{status, branch, commits, headSha, remoteHeadBefore: string | null}`.
  **Correction folded:** `moved` is NOT a field on the push result — with the early return in place
  it would be the constant `true` — `performDelivery` derives `moved = result.created ||
  push.status === "pushed"`. **Correction folded:** `revParse` returns `""`, not null, on failure, so
  an unreadable HEAD skips the compare, pushes as today, returns `remoteHeadBefore: null` and records
  NO `Pushed <sha>` event; `DeliveryOutcome.delivered.headSha` is `string | null` and every message
  drops the sha clause when it is null. The contract comment is rewritten.
  (B) `performDelivery`: `up_to_date` flows through the post-push reconcile and `openTaskPr` exactly
  like `pushed`; **correction folded:** BOTH `push.status !== "pushed"` checks widen (the failure
  router at `:5137` and the log-only branch at `:5056`, which would otherwise log that every ordinary
  `up_to_date` delivery did not push). `DeliveryOutcome.delivered` gains `pushStatus`, `headSha`,
  `moved` and `operatorRequeued`. The ruling-48 arm fires on `result.created || moved`. A moved head
  on a reused PR appends one `github` event "Pushed `<sha7>` to **PR #N** for review (was `<old7>`)"
  with the author rule at `pr-open.server.ts:686-722` (**correction folded:** the earlier citation
  named the 422 handling).
  (C) `operatorDeliverForReview`: `:2487-2496` is deleted; the `recommend` arm's pre-check reads the
  RECORDED fact (`unpushedRevisionOf`, A25) instead of the cache; the `delivered` arm's message names
  what moved; the audit details gain `headSha`/`moved` on both the operator and the manual rows. The
  tool description, the DELIVERY stage rule, the `delivered` turn instruction and the seed persona
  gain one sentence — **correction folded:** worded WITHOUT a dash ("When the task's PR is already
  open and `get_task` shows `pr.unpushedRevision`, call `deliver_for_review`: it pushes the delivered
  revision to that PR. Pushing is never a person's job and never an agent's."), because the seed-asset
  dash gate has an empty allowlist; the outgoing sha256 is appended to `PRIOR_SHIPPED_HASHES`.
  (D) **Correction folded — three human doors, one helper:** `deliveryToast(outcome)` in
  `app/features/task-detail/delivery-toast.ts` serves the task-page toast (`project.task.tsx:697-704`)
  AND the applied `delivery` recommendation (`task-actions.server.ts:8972-8986`, which today throws
  on a non-delivered result and otherwise returns nothing, so the human who applies the operator's
  card is never told whether anything moved); the recommendation returns the outcome or the route
  composes the toast, with a test in the recommendation-apply suite. The stale comment at
  `decision-packet.tsx:717-722` is corrected.
- **Tests.** `push-workspace.server.test.ts` · "a workspace HEAD origin already carries is
  `up_to_date` and runs no push" · canary: delete the early return. · **correction folded:** the
  second case asserts `remoteHeadBefore` and that exactly one push call ran · canary: return the
  pushed literal without reading ls-remote (so `remoteHeadBefore` is null on a lagging origin). · "an
  unreadable ls-remote never blocks the push" · canary: fail the push instead.
  `delivery-decision.server.test.ts` · "a live open PR no longer short-circuits" (REWRITES the pinned
  noop test at `:745`; the old pin WAS the bug) · canary: restore the deleted pre-check. · "nothing to
  push is the only honest noop" · canary: return `done` regardless of `moved`.
  `delivery-requeue.server.test.ts` · "a reuse whose push MOVED the head re-queues exactly once; a
  reuse that pushed nothing does not" · canary: revert to `if (result.created)`.
  `task-actions.server.test.ts` · the `Pushed <sha>` event and its actor · canary: drop
  `recordPushedHead`. `delivery-toast.test.ts` · the three toasts · canary: swap the branches.
  `default-assets.server.test.ts` · the seed paragraph and the outgoing hash · canary: revert it.
- **Live validation (required):** deliver rework onto an already-open PR on the jira-clone repo and
  read the PR head plus the new timeline event; every unit test drives a fake exec, so nothing else
  proves the authenticated `ls-remote` works.
- **Docs.** `decisions.md` ruling 134 plus a dated note under ruling 48; `github-delivery.md` §3, §5,
  §9; `operator.md` §3 and §5; `task-lifecycle.md` §10; `glossary.md` "Delivery".

### A24 · The task page offers the push control for an unpushed delivered revision (closes F34-11; ruling 134 clause c) (C1-2)

- **Root cause.** `app/features/task-detail/task-side-panels.tsx:342-357` renders the deliver control
  only when `!task.pr || state === "closed" || state === "merged"` (comment at `:341-343`);
  `onDeliver` is wired at `task-detail-page.tsx:648` and `canDeliver` computed at
  `project.task.tsx:299-303`, so the authority is right and the visibility is wrong: with PR #10 open
  on JC-3 no surface could push the resolved revision. **Correction folded:** the component takes
  `task: TaskDetail` (`task-side-panels.tsx:50`; `TaskDetail extends TaskSummary` at
  `task-query.server.ts:52`), not the `TaskSummary` the earlier citation named; the fields are
  reachable either way.
- **Mechanism.** `const unpushed = unpushedRevisionOf(task.pr, task.workRevisionSha ?? null)` (A25's
  client-safe helper). The control renders when `onDeliver && (!task.pr || terminal || unpushed !== null)`.
  **Correction folded — the diverged case is split:** the primary `Push <rev7> to PR #N` control is
  offered only for `relation: "behind"` (and for the no-PR / terminal-PR case); for `diverged` the
  page renders the Unpushed row plus a DISABLED control whose reason names the refusal the server
  would give (a plain push is rejected non-fast-forward at `push-workspace.server.ts:694-711` and
  `performDelivery` refuses at `:5086-5103`), matching this codebase's own rule at
  `decision-packet.tsx:710-712` that naming a control which then refuses is worse than naming none.
  **Correction folded:** the busy text and the title travel WITH the label — `PUSH_LABEL(rev7, prNumber)`
  gets its own "Pushing..." and its own tooltip, instead of inheriting the delivery ones.
  A new `.kv-row` "Unpushed" names both heads. No new CSS.
- **Tests.** `task-disposition.test.tsx` · "offers the push control when the open PR does not carry the
  delivered revision, and it submits `deliver-review`" · canary: revert the visibility condition. ·
  "hides it when the recorded record is stale" · canary: drop the revision comparison in
  `unpushedRevisionOf`. · "a `diverged` relation renders the row and a disabled control naming the
  refusal" · canary: render the primary control for `diverged`.
  **Correction folded:** a THIRD test drives the record end to end (write a task file with an open PR,
  run the workspace reconcile that produces `unpushedRevision`, rebuild, load the detail projection,
  render), so the button cannot pass on a hand-built fixture while the real projection carries
  nothing · canary: stop writing the record in the reconcile.
  The existing pins stay green: `task-disposition.test.tsx:938-949` seeds a PR with no record, and
  `task-detail-components.test.tsx`'s UX19-4 pin on `DELIVER_LABEL` is untouched.
- **Live validation:** the control on the JC-5 task page.
- **Docs.** `github-delivery.md` §3; `surfaces.md` task route row.

### A25 · An unpushed delivered revision is its own acceptance gate, ranked above "conflicts" (closes F34-11) (C1-3)

- **Root cause.** `app/schemas/task-file.schema.ts:416-452` `prRefSchema` has no PR head sha;
  `github-reconciler.server.ts:452-486` reads `pr.headSha` only to record `revisionDrift` when the
  compare says `ahead`, dropping `behind`/`diverged`, and the owned ref written at `:513-530` never
  persists the head. `conflictingPrBlockedReason` (`task-file.schema.ts:877-885`) fires on the cached
  `mergeable: conflicting` — a fact about the OLD head — with "Rebase the branch and re-review, or
  archive the task", and is consulted by `acceptanceRefusalReason` (`task-actions.server.ts:7442`),
  the projection's `acceptanceBlockReason` (`rebuilder.server.ts:372`), the review queue
  (`review-queue.server.ts:258-262`), the board ceremony (`board-page.tsx:1010`),
  `attemptAcceptanceMerge` (`:5809-5820`) and `prStateSub` (`review-helpers.ts:64-66`). The
  affordance is sync, so the live head check never spoke on JC-3.
- **Mechanism.** `prRefSchema` gains `headSha` and `unpushedRevision {revisionSha, prHeadSha, relation}`.
  **Correction folded — `missing_ref` is the PRIMARY reconciler arm:** the drift compare is
  `reviewedSha...pr.headSha` where `reviewedSha` is a LOCAL workspace sha, so for the entire F34-11
  state GitHub has no such object and the compare answers 404 → `missing_ref`; when the PR is owned
  and live, `reviewedSha` is set, `pr.headSha` differs and the compare answers `missing_ref`, confirm
  with one `GET /repos/{repo}/commits/{reviewedSha}` — a 404 means the delivered revision is not on
  GitHub, so record `relation: "unknown"`; a live 200 plus a `behind`/`diverged` compare keeps the
  three-way mapping. **Correction folded:** the helper is
  `unpushedRevisionBlockedReason(pr, currentRevisionSha, taskKey)` and the verified-revision exclusion
  moves into the WRITERS (never record the field for a `verified` revision), because two of its four
  gates (`review-queue.server.ts:254-264` and `board-page.tsx:1010`) hold a `TaskSummary` with
  `workRevisionSha` and no `workRevision` object. **Correction folded:** `ReviewQueueRow.pr`
  (`review-queue.server.ts:56-81`, built at `:164-179`) gains `headSha` and `unpushedRevision` and the
  copy at `:174-179` sets them, with a test that the field survives the REAL projection — otherwise
  `prStateSub`'s new branch is structurally unreachable, exactly the defect that row's own P14-LV-07
  comment already records for `mergeable`. **Correction folded:** in `writePrToTask`, carry
  `existingPr.headSha` forward only when `samePr`; on a different PR omit the key unless
  `pr.head?.sha` is present, or the salvage path (`pr-open.server.ts:565-575`, which passes no `head`)
  stamps a stale head on a freshly created PR. **Correction folded:** `evaluateAcceptancePrHead`
  (`task-actions.server.ts:7625-7692`) gains a `missing_ref`/404 arm so a delivered revision GitHub
  does not have is a REFUSAL, not `unverifiable` (today it returns `{refusal: null,
  verification: "unverifiable"}` whenever the compare fails, which is exactly this state). The
  workspace reconcile records the same fact the moment a run mints a new revision on a branch whose
  PR is open (`workspace-delivery.server.ts`, `workRevisionPatch` at `:378-412`, the `detected` literal
  at `:565`), so the gate does not wait for the five-minute poll; a delivery that pushes clears it.
  The gate is inserted one line ABOVE `conflictingPrBlockedReason` in all four consumers, in
  `attemptAcceptanceMerge`'s cause, in `prStateSub` and in the operator's `get_task`.
- **Tests.** `task-file.schema.test.ts` · the helper's answers and the "deliver, never rebase" wording ·
  canary: drop the revision comparison. `github-reconciler.server.test.ts` · **correction folded:** the
  PRIMARY case is a 404 compare plus a 404 commit probe → `relation: "unknown"`, with the synthetic
  `behind` case kept as the secondary · canary: keep only the `ahead` arm. · diverged / cleared /
  carried-forward · canary: never clear on identical. `pr-open.server.test.ts` · reuse writes the head
  and clears a satisfied record; a DIFFERENT PR does not inherit the old head · canary: carry
  `existingPr.headSha` unconditionally. `workspace-delivery.server.test.ts` · the merge-base
  classification · canary: remove the step. `task-governance.server.test.ts` · acceptance refuses the
  unpushed revision BEFORE the conflict sentence · canary: swap the gate order.
  `task-actions.server.test.ts` · the forced-acceptance cause names the push · canary: keep the rebase
  sentence. · `evaluateAcceptancePrHead` refuses on a 404 instead of answering `unverifiable` ·
  canary: restore the `unverifiable` return. `rebuilder.server.test.ts`, `review-queue.server.test.ts`
  (including the real-projection field assertion), `review-helpers.test.ts`,
  `operator-actions.server.test.ts` · canaries as listed.
- **Docs.** `decisions.md` ruling 135; `file-formats.md` `pr:` block; `github-delivery.md` §5 gate
  order and §6; `task-lifecycle.md` §11; `operator.md` §5.

### A26 · `update_branch_from_base` reports origin's copy of the task branch (closes F34-11; ruling 134 clause c) (C1-4)

- **Root cause.** `app/server/github/update-branch.server.ts` fetches only the base
  (`+refs/heads/${base}:refs/remotes/origin/${base}`, `:246-258`), counts `HEAD..origin/<base>`
  (`:273-287`) and returns `already_current` (`:291`) or `updated` (`:426`) — neither member knows
  anything about `origin/<branch>`, so `outcomeSentence`
  (`update-branch-operator.server.ts:131-150`) printed "already up to date with `main`. Nothing to
  do." twice while origin's copy lagged by the rework.
- **Mechanism.** `UpdateBranchResult` gains `remote: RemoteBranchState`
  (`current | behind{headSha,commits} | diverged{headSha} | absent | unknown{why}`) on `already_current`
  and `updated` (plus `remoteBefore` on `updated`). **Correction folded — fetch both refs in the
  existing fetch** (`+refs/heads/${branch}:refs/remotes/origin/${branch}` beside the base) and derive
  the state LOCALLY from `origin/<branch>` (`rev-parse --verify`, `merge-base --is-ancestor`,
  `rev-list --count`), keeping `ls-remote` only as the fallback: `merge-base --is-ancestor` needs the
  remote head OBJECT, and a head pushed from another workspace is absent otherwise — the report would
  degrade to `unknown` in precisely the case that matters. `outcomeSentence` names the state and
  points at `deliver_for_review` when origin lags; the tool stays the BASE tool and never becomes a
  second push door (pushing is delivery, ruling 21). **Correction folded:** the new `already_current`
  timeline event is SUPPRESSED when the newest `github` event on the task already carries the same
  sentence (the tool is idempotent by contract, so the record must be too); the audit row still fires
  every call. **Correction folded:** the seed sentence carries no dash ("It also reports whether
  origin carries the workspace head. When it says the remote copy is behind, call `deliver_for_review`
  to push it; do not ask a person to push."). `BranchUpdateAuditDetails` gains `remote` and
  `remoteHeadSha`.
- **Tests.** `update-branch.server.test.ts` · `already_current` carries `behind` with N · canary: drop
  the second refspec (the remote reads `unknown`). · the four states · canary: collapse `diverged`
  into `behind`. · `updated` reports `current` after the push and names the pre-push lag · canary:
  report the pre-push state in `remote`. `update-branch-operator.server.test.ts` · the sentence, the
  single timeline event and the suppression of a duplicate · canary: revert the `already_current` arm;
  append unconditionally. · the persona substring · canary: revert the seed sentence.
- **Live validation:** a real repo where origin lags the workspace; assert the sentence and that
  exactly one timeline event lands across two calls.
- **Docs.** `github-delivery.md` §4; `operator.md` §5 (ruling 134(c) covers it, no separate ruling).

### A27 · `resolve_remote_collision` never strands on either arm (closes F34-10) (C1-5)

- **Root cause.** `app/server/tasks/task-actions.server.ts:6768-6778` lists the kind in `NO_REQUEUE`
  ("the re-delivery's own machinery owns the follow-up"); that machinery (the collision arm at
  `:7042-7176`) has two silent exits. Success: `manualDeliverForReview` (`:7071-7076`) re-queues only
  under FULL autonomy and only on `result.created` (`:5390`), and the supervised card
  (`recordDeliveredNextStep`) is edge-gated — `:5665` (stage at/after review), `:5669` (no
  `stage → review` edge) and `:5670` (already actionable) — and the JC board declares no
  Implementation → Review edge, so a fully successful ceremony ended `ready · waiting: human` with
  nothing. Refusal: F33-4's card at `:7140-7176` is the same edge-gated card, and the arm keeps
  `readiness: blocked` on every refusal (`:7118-7126`), which is false when the delete refused
  because the PR on the branch is the task's OWN open review PR.
- **Mechanism.** Typed refusals: `BranchDeleteResult.refused` and `RemoteCollisionResult.refused` gain
  a `reason`. The arm is restructured so every path ends in ONE hand-off, and the kind STAYS in
  `NO_REQUEUE` because the generic hand-off runs before the ceremony.
  **Correction folded — the server's outcome is NOT put in the human's mouth:** the resolved-option
  payload gains its own `serverOutcome` (a typed `{kind, outcome, reason?, prNumber?}`), rendered at
  `operator-run.server.ts:3415-3432` as a separate sentence attributed to Viberr, leaving
  `the human added: "…"` for the person's own words; a test asserts the two are rendered as different
  speakers. Otherwise the fix reproduces F34-12 inside its own remedy.
  **Correction folded — the `own_pr_open` arm decides from the RELATION, not the refusal alone:** the
  packet that offers this option is usually the push-conflict packet, i.e. a DIVERGED remote branch,
  where "the workspace revision reaches that PR by delivering" is false. Read origin's head (or the
  recorded `pr.unpushedRevision.relation`): for `behind`/`absent`, lift the block AND perform the
  delivery through `manualDeliverForReview` (which now pushes, A23) and report the real outcome — the
  person clicked the one option that pushes the work, so answering with advice would narrow the
  ceremony; for `diverged`, keep `readiness: blocked` and say that the remote branch holds commits
  this workspace does not, and who resolves the history. A self-referencing `github.unownedPr` is
  cleared only when it equals the task's own PR number. **Correction folded:** the in-ceremony
  reconcile of A28 is passed `{...ctx, wakeOperator: async () => {}}` so "exactly one hand-off" is
  literally true, and ruling 136 says so. Audit: one `github.collision.resolved` row per ceremony
  with its typed outcome; **correction folded:** the item states how that audit-coverage row supplies
  `fetchImpl` and the delivery deps seam, since the table's `run` closures otherwise take only
  `fileCtx`.
- **Tests.** `task-governance.server.test.ts` · "on a board with no `stage → review` edge the
  cleared+redelivered task still hands off" · canary: remove the hand-off. · "refusal arm, own PR open
  and `behind`: the block lifts and the delivery actually runs" · canary: keep `readiness: blocked`. ·
  "own PR open and `diverged`: the block stays and the note names the history" · canary: lift on every
  `own_pr_open`. · "GitHub refused the delete: the block stays and the operator is handed the reason" ·
  canary: lift on every refusal. `delivery-actionable.server.test.ts` · under FULL autonomy exactly one
  operator run · canary: ignore `operatorRequeued`. `operator-run.server.test.ts` · the human note and
  the server outcome render as different speakers · canary: embed the outcome in `resolvedOption.note`.
  `github-reconciler.server.test.ts` · every refusal carries its typed reason · canary: return
  `github_refused` for the own-PR case. `audit-coverage.server.test.ts` · both rows.
- **Docs.** `decisions.md` ruling 136 plus a dated note under ruling 110; `operator.md` §6 and §3;
  `github-delivery.md` §4 and §9; `task-lifecycle.md` §9.

### A28 · Every remote-branch delete re-confirms a cached open PR against GitHub (closes F34-10 and F34-11; ruling 136 clause c) (C1-6)

- **Root cause.** `app/server/github/github-reconciler.server.ts:1489-1495` (inside
  `deleteTaskRemoteBranch`, `:1462-1559`) refuses from `fm.pr.state` in task.md; the ceremony inherits
  that refusal at `:1619`. The cache is refreshed by the five-minute poller, so a PR closed on GitHub
  seventy seconds earlier still refused.
- **Mechanism.** When `fm.pr` is `review`/`accepted`, call `reconcileTask` (same module, `:909-936`,
  serialized by `withTaskReconcileLock`, and no caller of `deleteTaskRemoteBranch` holds that lock, so
  no deadlock) BEFORE deciding, then re-read: still open → refuse `own_pr_open`; now closed or merged
  → proceed with the refreshed file; a degraded reconcile → refuse `unconfirmed` (fail closed).
  **Correction folded:** the in-ceremony reconcile runs with the divergence machinery SUPPRESSED —
  `{...ctx, wakeOperator: async () => {}}` (the hook exists at `:95-101`) and a
  `suppressDivergenceNotice` flag consumed at `:793-814` — otherwise the exact branch this fix exists
  to unlock also tells every member "PR #N closed on GitHub: KEY needs a decision" and wakes the
  operator to open a rework packet about a PR the ceremony is replacing.
  **Correction folded:** EVERY `TaskReconcileResult` status gets an explicit arm — `reconciled`
  re-reads and decides; `no_branch`/`task_not_found` are unreachable here (the branch was read at
  `:1469`) and refuse as `unconfirmed`; the six degraded statuses refuse as `unconfirmed` — so a later
  change cannot make an unhandled status a silent proceed.
  **Correction folded:** the two INHERITED doors change behaviour and are covered — the archive arm
  (`task-actions.server.ts:6856`) and `cleanUpEmptyTaskBranch` (`:8572`) now pay the reconcile and can
  refuse with the new sentence, which renders into the archive/merge note at `:1355-1362`; each gets a
  test, the note copy and a line in `task-lifecycle.md`.
- **Tests.** `github-reconciler.server.test.ts` · "a cached open PR that GitHub reports CLOSED is
  re-confirmed and the ref deleted" · canary: read the cache. · "a PR GitHub still reports OPEN refuses
  with no DELETE" · canary: delete regardless. · "GitHub unreachable refuses as `unconfirmed`" ·
  canary: proceed when the reconcile fails. · "the in-ceremony reconcile fires no member notification
  and no operator wake" · canary: pass `ctx` through unchanged. · "archive + deleteBranch on a
  cached-open PR that GitHub reports closed now deletes the ref; an unreachable GitHub refuses" ·
  canary: skip the reconcile on that door. `task-governance.server.test.ts` · the JC-3 end-to-end
  shape · canary: cache-only decision.
- **Live validation (required):** close the PR on GitHub, immediately resolve a
  `resolve_remote_collision` packet, and confirm the delete, the fresh PR, ONE operator run and no
  "needs a decision" notification.
- **Docs.** `github-delivery.md` §4; `operator.md` §6; `runbook.md` GitHub section;
  `task-lifecycle.md` archive door.

### A29 · Acceptance offers are bound to a revision and withdrawn on the record (closes F34-15) (C4-3)

- **Root cause.** The accept card is dropped only at `app/server/tasks/task-actions.server.ts:2977-2983`
  (a verdict with non-healthy validation), `:6059` (archive), `:6456` (the packet accept arm) and
  `:8203` (`applyAcceptanceWrite`); the stage move at `:4756-4758` filters `r.kind !== "transition"`
  only, so a move AWAY from the boundary leaves the accept card standing. The two events that
  invalidated JC-3's card write nothing to `recommendations`: the delivery reconcile that mints a new
  work revision (`workspace-delivery.server.ts:396-416`, written at `:438-449`) and the three packet
  writers (`operator-actions.server.ts:1150-1157`, `agent-toolkit.server.ts:213-216`,
  `task-actions.server.ts:3037-3049`). Cards carry no revision binding.
- **Mechanism.** `recommendationSchema` gains `forHeadSha` on `accept_completion` cards, set by
  `operatorAcceptCompletion` and audited. ONE helper `withdrawAcceptanceOffers(parsed, terminalStageId,
  cause, actor)` removes the stale accept cards (and, for the packet and stage causes, transition cards
  targeting the terminal stage) inside the task file's own lock, unshifts a `note` titled
  "Recommendation withdrawn" naming the cause, and returns what it removed.
  **Correction folded — its HOME is the leaf `app/server/tasks/task-mutation.server.ts`** (beside
  `taskRef`/`reprojectTask`/`notifyTaskWatchers`), because `agent-toolkit.server.ts:35-38` records in
  writing that importing these from `task-actions` closes the `specialist-run → agent-toolkit →
  task-actions` cycle, and `workspace-delivery` imports nothing from `task-actions` today.
  Call sites: the delivery write (now a locked mutator; **correction folded:** it keeps the
  branch-linked `github` event "Reconciled branch …" that `workspace-delivery.server.ts:435-449`
  writes today, unshifted inside the same mutator), `operatorOpenPacket`, `openAgentQuestionPacket`,
  the completion-envelope question, and `transitionStage` when the move leaves the boundary —
  **correction folded:** the boundary is `resolveStageRoles(project.stages, project.workflow).reviewId`,
  the same source `isAtAcceptanceBoundary` uses, never `stages[length - 2]`.
  **Correction folded — the bell is scoped:** `markTaskPacketApprovalRead(..., ["approval"])` marks
  EVERY unread approval row for the task read, project-wide, and `addRecommendation` raises such a row
  for a surviving `run_agent` card; it is called ONLY when no recommendation survives the withdrawal,
  and the timeline note says so otherwise.
  **Correction folded:** `forHeadSha` is set in BOTH arms of `addRecommendation` (the push AND the
  in-place update at `operator-actions.server.ts:825-846`) and joins the change detection, or a
  re-recommended acceptance keeps a stale binding.
  One `task.recommendation.withdrawn` audit row per withdrawal event. The card renders "for revision
  <sha7>". `run_agent` and `delivery` cards survive all three causes.
- **Tests.** `workspace-delivery.server.test.ts` · "a new delivered revision withdraws the accept card,
  records why, keeps the `Reconciled branch` event, and leaves a surviving `run_agent` card's approval
  notification UNREAD" · canary: restore the blind patch. `operator-actions.server.test.ts` · opening a
  packet withdraws standing offers · canary: delete the call. · "recommend accept on rev A, deliver rev
  B, recommend again: the stored card's `forHeadSha` is B" · canary: leave the update arm alone.
  `agent-toolkit.server.test.ts` · an `ask_human` question withdraws too · canary: remove the call.
  `task-actions.server.test.ts` · the envelope question and a move off the boundary · canary: drop the
  `transitionStage` site. `audit-coverage.server.test.ts` · **correction folded:** the new row seeds its
  accept card on a task with NO open packet and resolves the packet it opens, so later rows in the same
  sequential store are unaffected. `task-detail-components.test.tsx` · the card names its revision ·
  canary: remove the render.
  **Correction folded:** the `auth-and-rbac.md` edit is DROPPED (that page lists audit FAMILIES, and
  `task.*` already covers it).
- **Docs.** `decisions.md` ruling 137; `task-lifecycle.md` §9 and §13; `operator.md` §6;
  `file-formats.md` `recommendations[]`; `glossary.md`.

### A30 · A decided `edit_goal` packet reads as decided after a reload (closes F34-13; with A31 closes U34-10) (C4-4)

- **Root cause.** `resolvePacket` stamps `parsed.packet.awaiting = "goal_edit"`
  (`app/server/tasks/task-actions.server.ts:6726-6728`) and refuses a second confirm with a 409
  (`:6196-6205`) that surfaces only as a transient toast. Nothing renders `awaiting`: `PacketRender`
  (`app/shared/mapping/task.server.ts:120-129`) declares no such field (the spread at `:514-522`
  carries it untyped), `DecisionPacket` always renders the radiogroup and "Confirm decision"
  (`decision-packet.tsx:1065-1100`), and the goal editor opens only from the in-memory
  `resolveFetcher.data.goalDraft`. The packet records WHICH option was chosen nowhere, so a reload
  cannot rebuild the draft.
- **Mechanism.** `taskPacketSchema` gains `decided {optionIndex, at, byUserId}`, stamped beside
  `awaiting`; both goal writers keep clearing the packet. `PacketRender` types `awaiting` and
  `decided`; `DisplayReadiness` gains `goal_edit_pending` with its `READINESS_DISPLAY` row.
  **Correction folded — the precedence is stated and tested:** `goal_edit_pending` wins over
  `input_required` and over a stored `blocked` (because `updateTaskGoal` lifts the blocked gate the
  moment the goal lands, `:653-660`), but NOT over `waiting === "agent"` — the `agent_working` branch
  stays first and the goal-edit branch sits immediately after it, with a mapping test for a blocked
  packet on an agent-working task. **Correction folded:** the review-queue row carries no
  `displayReadiness`, so either the row gains a `goalEditPending` flag and its subline, or "the queue"
  is struck from ruling 138 and the surface list; this plan takes the flag, so the ruling stays true.
  The card renders the chosen option locked, "Decision made · save the edited goal to clear this
  packet", and one "Edit the goal" control that opens the editor prefilled through the shared
  `goalDraftForOption` (A31). The side rail says a goal edit is owed; the operator snapshot gains
  `awaiting`. **Correction folded:** the untested `decided`-absent fallback is DROPPED (contributing.md
  §7.2 forbids untested behaviour); the card renders nothing special without `decided`.
- **Tests.** `task-governance.server.test.ts` · the `decided` stamp and its clearing · canary: drop the
  stamp. `mapping/task.server.test.ts` · the display value for input and blocked packets, never over a
  terminal state, never over `agent_working` · canary: **correction folded** — make the new branch
  return `readiness` unchanged and assert the hero renders "input required" (removing the
  `READINESS_DISPLAY` row is a TYPE error, not a runtime one, so it is not a valid canary).
  `task-detail-components.test.tsx` · locked options, no Confirm, the Edit control and its draft ·
  canary: ignore `p.awaiting`. `task-detail-route.server.test.ts` · the loader carries the decided
  packet and the reload path rebuilds the same draft · canary: **correction folded** — drop the
  `resolvePacket` stamp (not the `mapPacket` spread, which already carries the field).
  `task-side-panels.test.tsx` · the rail · canary: remove the branch.
  `operator-actions.server.test.ts` · the snapshot · canary: drop the field.
- **Docs.** `decisions.md` ruling 138; `operator.md` §6; `task-lifecycle.md` §6 and §9;
  `file-formats.md` `## Packet` sample; `glossary.md`; `surfaces.md` §5.

### A31 · `edit_goal` options carry an explicit `goalDraft`, and both prompts say what becomes the draft (closes U34-10; ruling 138) (C4-5)

- **Root cause.** The draft is composed in the route from the option's title and detail
  (`app/routes/project.task.tsx:600-611`); no prompt says so (the Claude tool description at
  `operator-toolkit.server.ts:413`, the option schema's "Short explanation under the option."
  at `:450-452`, the Codex paragraph at `operator-run.server.ts:3551`), and no field exists for the
  proposed goal text anywhere in the option shape. JC-6's option therefore prefilled an INSTRUCTION as
  the goal.
- **Mechanism.** `packetOptionSchema` gains `goalDraft`; `operatorOpenPacket` stores it and refuses it
  on a non-`edit_goal` option; **correction folded:** the refusal follows the ruling-115 authoring
  precedent (`operator-actions.server.ts:1050-1078`), and `conflictOptions` and `defaultPacketOptions`
  never set the field, so the built-in packets cannot trip it — with a test that a conflict packet
  still opens. The Claude tool declares the field with a description that says to write it AS the goal.
  **Correction folded:** the Codex `required` edit is MANDATORY, not conditional — `"goalDraft"` joins
  the option item's `required` array at `operator-run.server.ts:1733` with `type: ["string","null"]`
  under `additionalProperties: false`, the runtime mirror stays `.nullable().optional()` so persisted
  plans replay, and `operator-run.server.test.ts` is swept for assertions on the emitted plan schema.
  **Correction folded:** `project.task.tsx:600-611`'s inline composition is DELETED and replaced by the
  shared `goalDraftForOption`, or the two paths disagree — the split-brain F34-13 is about.
  **Correction folded:** `goalDraft` goes through `prose()` and a length cap in both mappers, like
  `detail`, so a model-authored draft cannot write unbounded raw text into task.md.
- **Tests.** `app/shared/packet-goal-draft.test.ts` (new) · the precedence · canary: swap it.
  `operator-actions.server.test.ts` · stored verbatim; refused on another kind; a conflict packet still
  opens · canary: drop the mapping. `operator-run.server.test.ts` · **correction folded:** the prompt
  assertion uses a REAL trigger (`buildCodexOperatorPrompt(snapshot(), "manual")`, asserting the
  open_packet paragraph) — `"open-packet"` is not in `OperatorTrigger` · canary: remove the sentence or
  the carry in `authoredPacketOptions`. `operator-toolkit.server.test.ts` · the declared field ·
  canary: remove it. `task-detail-route.server.test.ts` · the resolve response prefers `goalDraft` ·
  canary: compose title + detail inline again.
- **Docs.** ruling 138 covers it; `operator.md` §6; `file-formats.md` option sample; `glossary.md`.

### A32 · `update_agent_deployment` refuses unknown capability ids, impossible modes and unknown stages by name (closes F34-2) (C7-1)

- **Root cause.** `app/server/controller/controller-toolkit.server.ts:1567-1638`: the schema at
  `:1573-1575` takes `capabilityId: z.string()`, the handler builds `caps` from the stored grants plus
  the patches verbatim (`:1600-1602`) and answers `[done]` (`:1636`).
  `app/features/agents/agent-profile-actions.server.ts:182` accepts `caps: z.record(z.string(), modeSchema)`
  and `grantsFor` (`:283-315`) iterates the CATALOG defaults reading `caps[capabilityId] ?? def`, so a
  key outside the kind's governed set is never looked at; two more silent coercions ride the same path
  (a specialist `recommend` becomes `off` at `:299`, any mode on an always-human id becomes `human` at
  `:302`). The ledger's "reject unknown arguments" cannot be done in the handler: the Agent SDK wraps
  the raw shape in `z.object(shape)` (strip mode) before the handler runs, so `effort: "max"` never
  arrives — that half is A34.
- **Mechanism.** New pure `capabilityPatchRefusal(kind, patches)` in
  `app/features/agents/capability-catalog.ts`, built only from the sets already there, returning the
  refusal sentence or null. Branches: (a) ids not in the KIND's governed set, listed by name with the
  valid ids and a pointer at `list_capabilities`; (b) `recommend` on a specialist; (c) a non-`human`
  mode on an always-human id. **Corrections folded:** (d) an id in the catalogue for this kind with
  `group === null` (the ten matrix-only advisory ids at `capabilities.ts:142-151`, which a deployment
  can store and the edit path deliberately preserves) is refused as a matrix-only capability with no
  toggle — never as "nothing in the catalog answers to", which would be false about an id that IS in
  the catalog; (e) `report-validation-verdict` at any mode other than `direct` or `off`, because
  `grantsFor:290-296` forces exactly those two and would otherwise store `off` while the tool answered
  `[done]` for "Human-only". **Correction folded (placement):** the check lives in the controller tool
  because it is KIND-AWARE and `parseForm` is kind-blind (the kind is resolved at
  `agent-profile-actions.server.ts:657`, after `parseForm` ran at `:632`); the earlier justification
  (that the editor submits advisory ids) is FALSE — `seedCaps`'s stored-grant loop is guarded by
  `if (grant.capabilityId in caps)` (`create-profile-modal.tsx:297-307`).
  **Correction folded — the sibling catalogued identifier in the same call:** `stages` (`:1579`) is
  validated nowhere (`profileFormSchema` requires non-empty strings and `updateAgentProfile:718` writes
  them verbatim), so `{stages: ["implementation"]}` on a project whose id is `impl` answers `[done]` and
  leaves the agent eligible at no stage; every id in `args.stages` must be a stage of the project,
  refused by name, before any write. **Correction folded:** `capability-catalog.ts` is under the
  dash-ban render roots and is client-imported, so the sentences ship in the browser bundle and must
  stay dash-free.
- **Tests.** `controller-toolkit.server.test.ts` · "an unknown id is refused by name with the valid ids
  and nothing is written" (project.md byte-identical, audit count unchanged) · canary: make the helper
  return null. · "a specialist `recommend`, a non-human mode on an always-human id, and an operator id
  on a specialist are refused" · canary: validate against the union of both kinds.
  · "`report-validation-verdict` at `human` is refused" · canary: delete branch (e) (project.md stores
  `off` and the call answers `[done]`). · "an advisory id is refused as matrix-only" · canary: fold it
  into branch (a) (the wording assertion goes red). · "`{stages:['implementation']}` is refused with the
  project's stage ids" · canary: drop the stage check. **Correction folded:** the operator arm resolves
  the operator's profileId from project.md rather than assuming the literal `operator`.
  `capability-catalog.test.ts` · every governed id at a legal mode returns null; unknown ids are named ·
  canary: swap the id set for the other kind's.
- **Docs.** `controller-and-goals.md` §4 and the new §4.2; `agents-and-runtime.md` §5.

### A33 · `get_project` returns resolved grants; `list_capabilities` exposes the catalogue (closes F34-2's read half) (C7-2)

- **Root cause.** `controller-toolkit.server.ts:872-880` maps each deployment through
  `effectiveProfileView(..., VIEW_WITHOUT_POLICY)` and keeps five fields, discarding `capabilities`,
  `model`, `effort` and `autonomy` the view already carries; no tool lists `UNIFIED_CAP_CATALOG`. That
  is why the model spent two operator runs on JC-1 learning what a project read should have said.
- **Mechanism.** `get_project` returns each deployment's resolved grants, model, effort and (operator)
  autonomy, derived by the Agents page's own `assembleAgentRoster` so the controller reads exactly what
  the roster renders. **Correction folded:** the read moves from the project FILE to the projection
  deliberately, and the item says so plus states that every agent writer reprojects before returning,
  with a test that an `update_agent_deployment` followed by `get_project` in the same session reports
  the new grant. **Correction folded:** a stored grant whose id is not in the catalogue (a retired id,
  anticipated at `capabilities.ts:41-51`) falls back to the id as its label, with no non-null assertion;
  `AgentProfileView` names the field `id`, mapped to `profileId`.
  New `list_capabilities` (instance scope, any signed-in person, like `whoami`) serves the ids, the
  modes each kind takes and the always-human three. **Correction folded — it reports the ABSENT-grant
  mode, named `whenUngranted`, not the create-seed `defaultMode`:** six ids are in
  `GRANT_REQUIRED_CAPABILITY_IDS` (`capabilities.ts:408-415`) and resolve to `off` when absent, so
  publishing "create-task-branch default direct" would be the same read/runtime gap this item closes;
  the rule shares ONE home with `absentMode` in `agents-query.server.ts`, and `deliver-review-pr` /
  `update-task-branch` are named as project-policy dependent and read from `get_project`.
- **Tests.** `controller-toolkit.server.test.ts` · "`get_project` reports resolved grants, model,
  effort and autonomy" · canary: revert to the five-field literal. · **correction folded** — the
  policy canary needs a fixture that can move: strip the operator's stored `deliver-review-pr` grant
  from project.md AND set a workflow whose pre-work boundary is human-gated, so
  `absentDeliverReviewPrMode` returns `recommend`; assert the operator row reads `recommend` · canary:
  swap the roster back for `VIEW_WITHOUT_POLICY` (it reads `direct`). **Correction folded:** one
  non-tautological value assertion anchored to project.md (the developer row's `create-task-branch`
  mode equals what the FILE stores, and `off` when the grant is absent), because deep-equalling the
  tool's output against the very function it now calls can only detect an absent field.
  · "`list_capabilities` lists every governed id per kind with `whenUngranted`" · canary: return the
  union of kinds. · "a write then a read in one session reports the new grant" · canary: read the file
  again.
- **Docs.** `controller-and-goals.md` §4 (38 → 39 tools) and §4.2; `docs/README.md` count;
  `agents-and-runtime.md` §5; `decisions.md` ruling 139.

### A34 · Effort (and model at deploy) are settable and refused by name (closes G34-1) (C7-3)

- **Root cause.** `update_agent_deployment` declares `model` (`:1578`) but no `effort`, and carries the
  stored value (`:1611`); an `effort` argument is stripped by the SDK before the handler. `deploy_agent`
  (`:1544-1562`) takes only `profileId`, and `deployAgentProfileFromLibrary`
  (`agent-profile-actions.server.ts:502-620`) writes `effort: defaultEffortFor(backend)` (`:579`), so
  every controller-built deployment ran at the template default `high` while the owner's standing rule
  is max. `parseForm` refuses a foreign model (F21-13) but stores `effort` verbatim (`:702-707`), and
  `resolveRunEffort` (`model-catalog.server.ts:293-316`) CLAMPS an unknown tier at run time — the same
  silent-substitution class F21-13 closed for models.
- **Mechanism.** New `assertEffortForBackend(backend, effort)` (and `assertModelForBackend`, extracted
  from the F21-13 check) in `model-catalog.server.ts`, refusing by name with the backend's tiers.
  **Correction folded — placement:** the by-name refusal goes on the WRITE SURFACES that take a typed
  argument (`deploy_agent`, `update_agent_deployment`), the same placement A32 chose, so the controller
  can never store a tier the backend does not list. In `parseForm` it refuses only a CHANGED value
  (compared against the deployment's stored effort), because an unconditional refusal there would turn
  a profile storing a legitimately preserved tier — Codex `minimal`, deliberately accepted but not
  offered (`model-catalog.server.ts:111-120`) — into an unsaveable form, exactly the argument
  `resolveResourceGrants` records at `gagents.server.ts:269-274`.
  **Correction folded — close the stale value at its source:** drop the preserve-a-stale-effort option
  (`create-profile-modal.tsx:671-673`) and extend the seeding effect (`:193-200`) to re-seed when
  `effort` is not in `effortOptions` (today it re-seeds only when empty; `pickBackend` already clears on
  a backend switch, so the exposed path is a stored out-of-list value with no switch at all).
  `deploy_agent` takes `model` and `effort` overrides, validated against the deployment's primary
  backend and written instead of the template default; **correction folded:** the F21-13 comment at
  `agent-profile-actions.server.ts:565-571` stays true — a library template's own model is still not
  refused, only an EXPLICIT override is judged — and `ProfileSaveResult` gains the applied
  `model`/`modelLabel`/`effort` so the reply has a source. A backend switch with no effort resets to
  that backend's default and says so. `project.agent_profile.deployed` details gain the overrides.
- **Tests.** `controller-toolkit.server.test.ts` · effort set, refused by name for the wrong backend,
  and reset-on-switch · canary: remove `effort` from the schema; drop the assert on the write surface.
  · `deploy_agent` pins model and effort and audits them · canary: keep `defaultEffortFor` at `:579`.
  `agents-route.server.test.ts` · the editor refuses a CHANGED out-of-list tier and names the valid
  ones · canary: make the assert a no-op. · **correction folded** — "an UNCHANGED stale tier still
  saves" (a deployment storing Codex `minimal` saves an unrelated field) · canary: refuse
  unconditionally in `parseForm`. `agents-page.test.tsx` (jsdom) · **correction folded** — a profile
  whose stored effort is out of the backend's list shows the backend default and submits it · canary:
  restore the preserved option. `model-catalog.server.test.ts` · the assert's own matrix · canary:
  route it through `resolveRunEffort`.
- **Docs.** ruling 139's effort clause (worded as "at the controller tools, and for a CHANGED value in
  the editor", never "unconditionally in parseForm"); `controller-and-goals.md` §4 and §4.2;
  `agents-and-runtime.md` §2.3.

### A35 · `create_task` takes owner and dueDate; a named owner is seated before the first run (closes G34-3) (C7-4)

- **Root cause.** `controller-toolkit.server.ts:962-1000` `create_task` accepts title/goal/priority/labels
  only, so the model creates under the asker and patches afterwards; the board route already passes
  `dueDate`. `createTask` (`task-actions.server.ts:484-621`) seats `creator` (`:517-521`, `:552`), writes
  the file (`:596`), then fires `void autoInvokeOperator(..., "create")` (`:616`), and `runOperator`
  resolves the principal from the task file at start — so a `set_task_owner` that follows RACES that
  read: JC-15's first run started 1.2 s after creation on Arda's credential, 3.6 s before Omar was
  seated.
- **Mechanism.** `CreateTaskInput.ownerUserId`; a named owner is checked by the same rule as a hand-off
  through ONE shared `requireOwnable(project, targetUserId)` that `setOwner` (`:4277-4283`) also calls,
  keeping the pinned sentence byte-identical; **correction folded:** the item states in one line that
  `setOwner`'s ACTOR-side guard does not apply at creation because the creator is the implicit first
  owner. The seat is written in the SAME `createTaskFile` write, before `autoInvokeOperator`, so the
  first triage run bills the named owner and is refused honestly when they have no credential. One
  `assign` timeline event naming what the seat means; `task.created` details gain
  `seat: "creator" | "named"`; **correction folded:** `owner` equal to the caller records
  `seat: "creator"` and writes the existing creator text at `:591` verbatim, asserted in the toolkit
  test. The tool gains `owner` (an email, or `me`) and `dueDate`; **correction folded:** the literal
  `none`, which the sibling `set_task_owner` accepts, is refused BY NAME at creation ("A new task is
  created with an owner; use `set_task_owner` to release the seat afterwards.") instead of falling
  through to a misleading "No Viberr user with the email none." The description says
  `priority: urgent` IS the urgent flag (`urgent` is derived at `:566`, F26-16) and that a named owner
  is seated before the first operator run. The board route and goal-chain creation pass no owner.
- **Tests.** `task-actions.server.test.ts` · **correction folded** — the race test cannot pass without a
  call: the injected `ctx.deps.runOperator` resolves a DEFERRED promise capturing
  `readTaskFile(...).frontmatter.ownerUserId` and the run input; the test awaits it with a timeout and
  asserts exactly one call with the named owner (asserting immediately after `await createTask` proves
  nothing, because `autoInvokeOperator` is fired with `void` and awaits a dynamic import first) ·
  canary: write the creator into the frontmatter and apply the named owner after `autoInvokeOperator`.
  · the hand-off refusals (viewer, non-member, operator-authorized context) · canary: drop
  `requireOwnable`. `controller-toolkit.server.test.ts` · the seat, the dueDate, `priority: urgent`, the
  ownership notification, and the `owner: 'none'` refusal · canary: drop the owner pass-through; drop
  the dueDate pass-through.
- **Docs.** `task-lifecycle.md` §3; `controller-and-goals.md` §4; `glossary.md` "Owner".

### A36 · Ownership seat changes notify the person whose seat changed (closes U34-11) (C7-5)

- **Root cause.** `setOwner` (`task-actions.server.ts:4204-4332`) writes the `assign` event, reprojects
  and records `task.ownership.taken | handed_off` (`:4309-4321`) with no notification; `releaseOwner`
  (`:4339-4405`) likewise. Under ruling 127 the seat is the credential principal and the acceptance
  authority, so Omar learned he owned JC-15 from the failure packet his missing credential produced. No
  existing kind fits (`NOTIFICATION_KINDS` at `app/shared/mapping/notification.server.ts:16-25`).
- **Mechanism.** New kind `ownership` with its own routing category, wired through the kinds list, the
  baseline CHECK, `NOTIF_PREF_CATEGORIES`, `defaultNotifPrefs`, `KIND_TO_CATEGORY` (compile-enforced),
  **correction folded:** `storedNotifPrefsSchema` (`notification-prefs.ts:139-149`, or
  `mergeNotifPrefs` strips the stored pref), `PROFILE_NTF` and `ntfMeta`. One notifier
  `notifyOwnerSeatChange` runs after the write and the audit row, never to the actor themselves, and
  fails open with a logged error. Wired to: a hand-off (new owner), a takeover of an occupied seat
  (previous owner), an admin release (released owner) and A35's named creation.
  `releaseTasksOwnedBy` stays unwired (the person is leaving).
  **Correction folded — the drift work is IN this item, not deferred:** adding a value to the
  `notifications.kind` CHECK reaches only fresh roots, and the boot drift detector covers COLUMNS on
  `task_projections`/`task_events` plus one CHECK (`task_projections.validation`) only, so on an
  existing root every ownership INSERT would throw, the fail-open would swallow it and no WARN would
  fire — the same silent drop this pass is about. Generalise the boot check into `projectionCheckGaps(db)`
  comparing the live DDL's IN-list for `notifications.kind` against `NOTIFICATION_KINDS`, surface it in
  the existing `projectionSchemaDrift` WARN with the re-baseline remedy, and test it.
  **Correction folded — the audit says WHY nobody was told:** `notified: {userId} | {skipped:"silenced"}
  | {skipped:"failed"}` (or `notifiedUserId` plus `notifyFailed`), so a silenced category and a broken
  root never read the same. **Decided in this pass (implementer's call, 2026-09-04):** the previous-owner and
  admin-release branches ship. Losing the seat takes away the credential principal role, the review
  duty and the acceptance authority, so the person who held it is told exactly as the person who
  gains it is; the actor is never notified about their own act (self-take and self-release notify
  nobody). Ruling 140 states it as a decision, not a proposal.
- **Tests.** `task-actions.server.test.ts` · hand-off, takeover and admin release notify; self-take and
  self-release notify nobody · canary: delete the call in the hand-off branch. · a silenced category
  drops the row and the audit says `skipped: "silenced"` · canary: pass `bypassPrefs`.
  `notification.server.test.ts` · the CHECK pin · canary: add the kind to one side only.
  `boot.server.test.ts` · **correction folded** — a db whose notifications CHECK lacks `ownership` is
  reported as a gap · canary: revert to the `task_projections`-only read.
  `profile-page.test.tsx` · **correction folded** — the EXISTING test at `:159-167` ("renders the 6
  notification routing rows", asserting 9 `.pref-row` and 7 toggles) is updated in the same change to 7
  rows / 10 `.pref-row` / 8 toggles plus the new toggle's `set-notif` post · canary: drop the
  `PROFILE_NTF` row. `notifications-page.test.tsx` · **correction folded** — assert the `user` glyph and
  `act-transition` class explicitly, since `ntfMeta` has a catch-all and would degrade silently ·
  canary: map `ownership` to the packet branch.
- **Docs.** `decisions.md` ruling 140; `task-lifecycle.md` §7 and §14; `auth-and-rbac.md` §7
  (six toggles → seven); `controller-and-goals.md` `set_task_owner` row.

### A37 · A scheduled operator re-run is refused while a packet is open, and no occurrence is recorded as fired when no run happened (closes F34-8) (C8-3)

- **Root cause.** `app/server/runtimes/operator-run.server.ts:1335-1358` scopes the R20-1 open-packet
  refusal to `(input.trigger ?? "manual") === "manual"` at `:1344`, so a `scheduled` trigger drives a
  full turn into a paused coordination — the same paid no-op ruling 76 refuses for the human who presses
  the same button. `app/server/tasks/schedule.server.ts:478-484` writes "Scheduled action starting" at
  CLAIM time and `:638-639` sets `ok = true` for every result, `:699` stamps `fired`, and only
  `terminal-stage` is translated into an honest retirement (`:699-712`, `:735-755`). Both lease-drain
  sites discard the result (`:576-582`, `:605-611`).
- **Mechanism.** The guard covers `manual` AND `scheduled`; machine reaction triggers still run with a
  packet open (ruling 17). The schedule runner captures `result.refused` and retires an `open-packet`
  occurrence exactly like the terminal case: `fired`, `firedAt` stamped, `claimedAt: null`, a
  "Scheduled action skipped" timeline note and a final `task.schedule.fired {outcome: "skipped-packet",
  refusedAtStart: true}` audit row beside the claim-time row. It is NOT `failed` and NOT a retry.
  `noteQueuedTriggerRefused` mirrors `noteQueuedTriggerFireFailed` and is called from both drain sites by
  chaining on the result; **correction folded:** it SETTLES NOTHING (open-packet: the packet owns
  `waiting: "human"`; terminal-stage: `runOperator` already settled at `:1326`), stated in the fix so the
  mirror writer does not copy the settle and mask a real strand.
  **Correction folded — the queued half is closed properly, because that is the shape the live case had:**
  `RunOperatorInput` gains `scheduleId`, set at `schedule.server.ts:625-635`, so
  `noteQueuedTriggerRefused` can also RETIRE the occurrence (`fired`, `claimedAt: null`) and write the
  final `skipped-packet` row; if that thread is refused, `result.queued` is captured at fire time and
  recorded as `outcome: "queued-behind-drive"` there, and ruling 141's sentence is narrowed to what the
  mechanism does. Either way the ruling and the code agree.
- **Tests.** `operator-run.server.test.ts` · a SCHEDULED run is refused like a manual one; the existing
  R20-1 manual case and the `pr-diverged` case stay green · canary: restore the manual-only guard. · a
  queued trigger refused at drain time says so on the task, for a `scheduled` trigger and for a human
  `@operator` comment · canary: restore the bare `.catch(...)`.
  `schedule.server.test.ts` · an occurrence that fires into an open packet is retired as skipped with two
  audit rows, newest `skipped-packet` (following the template at `:814-869`) · canary: drop the
  `open-packet` arm. · it spends no retry · canary: route it through the retry branch.
  **Correction folded:** `operator-run.server.test.ts:2560-2600` gains the new drain-time note and stays
  green; the item says so, since its `eventually()` block is the drain's only positive observable.
- **Docs.** `decisions.md` ruling 141 (Extends ruling 76); `task-lifecycle.md` schedules/FR39;
  **correction folded** `agents-and-runtime.md` §4.5 (the schedule-outcome enumeration) and
  `operator.md:79-82` (which today says the refusal is a "human-pressed" Run operator).

### A38 · A run's shell carries none of Viberr's own configuration (closes U34-7) (C8-6)

- **Root cause.** `app/server/runtimes/runtime-registry.server.ts:89-99` `filteredSpawnEnv` copies
  `process.env` minus three regexes (credential-shaped names, four private-runtime names, the two vendor
  homes), so `NODE_ENV=production`, `PORT`, `VIBERR_DATA_ROOT`, `GITHUB_OAUTH_CLIENT_ID`,
  `BETTER_AUTH_URL`, `VIBERR_TRUST_PROXY` and the unlock flags all ride into the child. Live, the JC-6
  Developer's `env` probe showed `NODE_ENV=production` and `PORT=5173`, which broke `vitest` and
  `next start` until the agent unset them; `docs/operations/configuration.md:174-177` already claims the
  runtime "never inherits its own environment into them".
- **Mechanism.** A fourth exclusion: every key in `ENV_KEYS` (`app/server/config/env.server.ts:197`,
  `envSchema.keyof().options`), which is the app's own declared configuration and already has `NODE_ENV`
  and `PORT` at the top. Self-maintaining: a knob added to the schema is excluded the same day, and the
  existing "no undeclared env reads" gate keeps the schema complete. The three regexes stay. PATH, HOME,
  locale, proxies and the image's deliberate `UV_*` caches are undeclared and survive. Nothing a child
  needs comes from a declared knob (`VIBERR_BROWSER_EXECUTABLE` is read in the PARENT and passed as argv;
  the agent toolkit is an in-process SDK server).
  **Correction folded:** the ruling is worded to the MECHANISM ("every name the env schema declares"),
  with the observed consequence that an UNdeclared name still passes (the test's
  `VIBERR_CLAUDE_TEST_MARKER`, `LOG_LEVEL`, `VIBERR_E2E_*`), and the "no undeclared env reads" gate as
  the reason that is safe. **Correction folded:** the same change strips `NODE_ENV=production` from every
  spawned stdio MCP child (`mcpSpawnEnv`), which is named in the risks.
- **Tests.** `runtime-registry.server.test.ts` · `filteredSpawnEnv` strips every `ENV_KEYS` member and
  keeps PATH/HOME/UV_CACHE_DIR (restoring `process.env` in a finally) · canary: remove the clause. · the
  adapters are built on that env · canary: same. `org/resources.server.test.ts` · a spawned stdio MCP
  child inherits the stripped env · canary: same. **Correction folded:**
  `app/server/runtimes/harness-hermeticity.server.test.ts:94-140` is the file that asserts what the base
  spawn env carries and gains one case there ("the base carries none of the app's own configuration"),
  beside the credential and vendor-home cases.
- **Live validation:** one real run whose shell prints no `NODE_ENV` and no `PORT` (the same `env` probe
  that found it).
- **Docs.** `configuration.md` §2 and §3; `agents-and-runtime.md` §2.2; `decisions.md` ruling 142.

### A39 · An allocated branch is not a delivery (closes U34-9) (C8-7)

- **Root cause.** `app/server/insights/insights-query.server.ts:326-330` defines the denominator as
  `work_revision_sha != null || branch != null || pr_json != null` and the numerator as
  `branch != null && pr_json != null`; ruling 122 moved branch naming to allocation time, before any work
  exists, so the denominator quietly grew to every task that ever engaged a deliverer, and the card read
  "7 of 8 delivered tasks carry branch + PR" while JC-7 had delivered nothing.
- **Mechanism.** The denominator becomes `work_revision_sha != null || pr_json != null`; the numerator is
  unchanged, and stays meaningful (a delivered task with no branch or no PR is exactly the untraceable
  delivery the metric exists to find). The `OversightSummary.traceability` comment is rewritten citing
  ruling 122. **Correction folded:** the comment and the ruling state the residue — a delivered revision
  with no PR STAYS in the denominator on purpose, because an unpushed delivery is exactly an untraceable
  one.
- **Tests.** **Correction folded:** `insights-query.server.test.ts:383-397` is REWRITTEN in place (it
  encodes the defect: it seeds VIB-2 as "delivered but not traced: a branch with no PR" and asserts
  2/1/0.5) — renamed to the new rule, keeping VIB-1 (branch + PR + revision) and VIB-3 (nothing),
  changing VIB-2 to a work revision with no PR (still in the denominator, still untraced) and adding a
  branch-only VIB-4 that must NOT count, asserting 2/1/0.5 from that fixture · canary: restore
  `|| t.branch != null`. **Correction folded:** `app/features/insights/insights-page.tsx` is DROPPED from
  the files list and the page test is dropped with it — the subline wording does not change, so a test
  whose canary edits untouched code proves nothing about this fix.
- **Docs.** `auth-and-rbac.md` §6; `decisions.md` ruling 143.

### A40 · Q34-15 · The `workflow` scope: disclosed, refused before the push, and a violation on rejection (closes G34-2) (C2-5)

- **Root cause.** `app/server/secrets/pat-store.server.ts:29-41` promises in its own comment that a
  workflow-file push "403s and opens a scope violation with GitHub's own message", and ruling 18
  (`decisions.md:266-269`) repeats it; nothing implements it. `push-workspace.server.ts:236-242`
  classifies only non-fast-forward and `:707-733` sends everything else to `pushFailed`;
  `task-actions.server.ts:5103-5127` renders `push_failed` with no `flagScopeViolation` call. The
  validator reads the classic `x-oauth-scopes` header (`pat-validator.server.ts:314-341`) but
  `patValidationSchema` has no field for the granted list, and `revalidateProjectCredential` resolves
  only scopes present in `validation.scopes`. Live (JC-6), the rejection reached the person only as the
  operator's packet, 25 minutes late.
- **Correction folded — the ruling is not written from Q34-10.** The owner's answer was "ship without CI
  for now; the scope gap stays filed as G34-2 for the fix phase (probe or require `workflow`, or say so
  at attach time)", which leaves the mechanism open. **Q34-15 is put to the owner at the start of the fix
  phase** with the three-part mechanism below and the recommendation to keep `workflow` OPTIONAL (a
  requirement would reverse ruling 18's reason and is unprovable on fine-grained tokens; a write probe is
  the unsolicited write pass 16 removed). The code ships in this pass either way, as the implementation
  of ruling 18's existing promise; the numbered ruling (144) and ruling 18's amendment note are recorded
  once the answer lands.
- **Mechanism.** (a) `patValidationSchema` gains `headerScopes` (the classic token's full list; null for
  fine-grained), surfaced as a `CredentialAdvisory` on the credential card and the connection row —
  never a validation failure, no chip, no `insufficient_scope`. (b) Before pushing, delivery lists the
  workflow files the branch changes and refuses with a named remedy when the bound credential is a
  classic token without `workflow`; **correction folded — measure the delta GitHub measures:** resolve
  `origin/<branch>` first and list with `git log --format= --name-only origin/<branch>..HEAD --
  .github/workflows/`, falling back to `origin/<default>..HEAD` only when the remote branch does not
  exist (first push), so a branch whose workflow file already reached the remote is never refused for a
  push that does not touch it; the same rule governs the `workflowFiles` list returned on the `pushed`
  member. (c) A push GitHub refuses for that reason, on any token kind, is classified
  `push_refused_scope` and opens a `workflow` scope violation on the task (the `policy` event, the inbox
  notification, the credential-card flag, the rail count), resolved by a re-check whose header now lists
  `workflow` or by the next successful push of workflow files. `DeliveryOutcome` gains
  `scope_violation`, which the operator tool's exhaustive switch must handle.
  **Correction folded:** the runbook bullet and the violation's remedy name the concrete control (the
  Grant/Re-check action in `app/features/github/github-actions.server.ts`), and the classifier's negative
  case uses a protected-branch stderr string already present in `push-workspace.server.test.ts`.
- **Tests.** `pat-validator.server.test.ts` · the header list is recorded; a token without `workflow` is
  still valid · canary: drop the assignment. · Re-check resolves an open `workflow` violation once the
  header lists it · canary: stop adding `headerScopes` to the granted set.
  `pat-store.server.test.ts` · the advisory from the header and from an open violation · canary: derive
  it from `validation.scopes`. `push-workspace.server.test.ts` · refused before the push when the token
  lacks it, with NO push call · canary: remove the check. · pushed when the token lists it or the scopes
  are unknown · canary: refuse whenever workflow files are present. · **correction folded** — a branch
  whose `ci.yml` is already on `origin/<branch>` and whose new commits touch nothing under `.github/`
  still pushes · canary: measure against `origin/<default>` unconditionally. · GitHub's rejection is
  `push_refused_scope`, never a generic `push_failed` · canary: delete the classifier branch.
  `task-actions.server.test.ts` · the violation with its remedy, and `openTaskPr` not called · canary:
  route it into the `push_failed` arm. · a later successful push resolves it · canary: drop the resolve.
  `github-view.test.tsx` and `connections.server.test.ts` · the advisory renders and rides the
  connection record · canary: render it only when granted; return `[]`.
- **Docs.** `github-delivery.md` §1, §3, §7, §9, §10; `runbook.md`; `surfaces.md`; `decisions.md`
  ruling 144 plus a dated note under ruling 18 (both held until Q34-15 is answered).

---

## Band B — correctness defects

### B1 · Pre-dispatch branch preparation failures are disclosed and audited (closes F34-3) (C2-2)

- **Root cause.** `app/server/github/branch-sync.server.ts:353-364` `ensureTaskBranchBestEffort` is
  `try { await ensureTaskBranch(...) } catch {}` returning void: every typed non-`synced` result is
  discarded, throws are swallowed, and there is no logger line. Both callers ignore the return
  (`specialist-run.server.ts:1338-1346` guarded by `delivers && !frontmatter.branch`;
  `operator-actions.server.ts:2186-2198` → `:2412`, guarded by `delivers` alone). Only a created branch
  is audited and only a 403 writes a timeline line. Live, JC-1's allocation failed on the missing base
  and no surface said the repository could not take a task branch. The ledger's sub-claim that the
  deliverer was told `branch: ""` is NOT reproducible: `specialist-run.server.ts:1796` falls back to the
  canonical name, and the run-inputs disclosure has no branch field.
- **Mechanism.** The helper returns its typed result (plus `{status:"threw", message}`). `synced` and
  `scope_violation` write nothing new (the flag already wrote the event, the notification and the audit
  row). `auth_failed`, `network_unavailable`, `bootstrap_failed` and `threw` append ONE `github` timeline
  event by `system:delivery`, reproject, record `github.branch.prepare_failed` and log at warn.
  `no_pat_configured`, `no_repo_configured` and `task_not_found` are standing project states and log only.
  **Correction folded — the disclosure is DEDUPED, not one line per dispatch:** the operator's hook is
  gated on `delivers` alone, so it runs on EVERY delivering dispatch even when `branch:` is already
  recorded; while a credential is broken or GitHub is unreachable, that is a standing state, and JC-1
  took three delivery attempts in four minutes. Before appending, read the task's newest `github` event
  and skip the append and the audit row when it is the same status for the same branch and repo,
  appending only on a change of status or after a cooldown; the `logger.warn` still fires every attempt.
  **Correction folded:** the second half of the sentence is derived from whether `frontmatter.branch` was
  already recorded ("the ref could not be confirmed" vs "no branch could be allocated").
- **Tests.** `branch-sync.server.test.ts` · a network failure is disclosed and audited · canary: restore
  the void body. · a thrown error is disclosed (the `unreadableResponse` fault injector reaches through
  because `rateLimitFrom(response.headers)` sits outside both try blocks) · canary: keep the catch but
  drop the disclosure. · a project with no credential writes nothing · canary: disclose every non-synced
  status. · a REPEAT of the same failure writes one line, not three · canary: remove the dedupe.
  `audit-coverage.server.test.ts` · the new action · canary: remove the `recordAudit` call.
- **Docs.** `github-delivery.md` §3 and §9; `agents-and-runtime.md` §4.1.

### B2 · PR adoption is recorded (closes F34-9) (C2-4)

- **Root cause.** `app/server/github/github-reconciler.server.ts:434-448` decides adoption and `:511-531`
  builds the owned ref with the NEW number, written at `:692-727` with no event of its own; the only
  related line, `reopenedText` (`:643-649`), fires when the CACHED state was already `closed`, and live
  the cache still said `{number: 5, state: review}` when #6 replaced it, so nothing was written and the
  only audit row is the generic `github.reconcile.task`. Same class, second door:
  `pr-open.server.ts:411-444` adopts through `writePrToTask(..., created=false)` whose timeline event
  (`:686-722`) and `github.pr.opened` audit (`:729-741`) are gated on `created`. The third door
  (`workspace-delivery.server.ts:585/607`) already records.
- **Mechanism.** New `app/server/github/pr-adoption-record.server.ts` `recordPrAdoption(...)`: one
  `github` timeline event naming the adopted PR, its head and the PR it replaces (policy engine for the
  reconciler, `system:delivery` for the delivery door), a reprojection, and a
  `github.pr.adopted {repo, branch, prNumber, previousPrNumber, previousState, headSha, source}` audit
  row. Called from the reconciler after the write when the number changed, and from `prAlreadyOnHead`.
  **Correction folded — the adoption gets its OWN notification instead of borrowing `reopenedText`'s:**
  `noticeText` (`:793`) falls through to the title "PR #N live again on GitHub: KEY resumes" (`:806-812`),
  which would be FALSE for the live F34-9 case; build `adoptionNotice` beside it with its own title, and
  keep the existing different-number healing sentence flowing into `noticeText` when `prJustReopened` is
  true so today's notification is not lost. **Correction folded:** the item states explicitly whether an
  adoption over a live-cached PR wakes the operator, and if it should, widens the `prJustReopened`
  condition at `:824-830` rather than leaving it implicit.
- **Tests.** `github-reconciler.server.test.ts` · adopting a human-opened PR on the delivered head writes
  the event and the audit row — **correction folded:** asserted by SEARCHING the timeline for the
  `github` event containing "Adopted **PR #" (and that no other event carries it), never by index, since
  the reconciler appends more events after that point · canary: delete the call. · a refresh of the same
  number writes nothing · canary: fire on every `ownsAPr`. `pr-open.server.test.ts` · the delivery door
  records an adoption and no "opened" · canary: drop the call. `audit-coverage.server.test.ts` · the row.
- **Docs.** `github-delivery.md` §4, §6, §9; `task-lifecycle.md` §10.

### B3 · Every Agents Live row states what a run is doing (closes F34-5) (C8-1)

- **Root cause.** `app/server/projections/agent-deployments.server.ts:75-79` `primaryStatus(waiting)`
  returns "working" from the waiting flag alone and `:211` hard-codes "anchored · on call" on every
  reviewer row, while the module already selects running rows thirty lines above (`:134-139`) and uses
  them only for the `running` boolean. `agent-types.ts:180-182` `deploymentDot` ORs the status into the
  pulse and `agents-page.tsx:1466` counts `status === "working"`. `agents-page.tsx:1438-1447` (F26-2)
  already ruled this exact question for the sidebar, so this finishes that rule rather than making a new
  one; the projection is the last holdout.
- **Mechanism.** Widen the run SELECT to `state IN ('running','queued')`, build a `running` map and a
  `queued` map, and replace `operatorStatus`/`primaryStatus` with one `engagementStatus`: a running row →
  "coordinating" (operator) or "working"; else queued → "queued" (a real state, written at
  `run-service.server.ts:800` when no reservation was granted); else the idle wording per engagement kind
  from the task's `waiting` flag. `DeploymentStatus` gains "queued"; `deploymentDot` collapses to
  `d.running`; the stat counts `d.running` and its label changes.
  **Corrections folded:** (a) `agent-deployments.server.test.ts:99-129` (VIB-2/VIB-3 with no runs) is
  rewritten to "on call", the case at `:296-303` is deleted or re-premised, the join-case comment at
  `:215-217` is corrected and the module header at `:18-25` is rewritten to the run-derived vocabulary;
  (b) `app/features/retired-vocabulary.test.tsx:215-216` pins both relabelled strings verbatim and is
  updated in the same commit; (c) the stats assertion moves into an `AgentsPage` render via
  `createRoutesStub` (the pattern at `agents-page.test.tsx:1906-1930`), because `AgentStats` takes
  precomputed numbers; (d) the THIRD stat's arithmetic changes silently (a live-run engagement on a
  human-waiting task leaves the "waiting" count) — this plan keeps it counting task-level waiting and
  says so in the label.
- **Tests.** `agent-deployments.server.test.ts` · a delivering engagement with no run is "on call" ·
  canary: restore the waiting-derived "working". · a supporting engagement with a LIVE run says "working" ·
  canary: restore the hard-coded reviewer literal. · a queued run reads "queued" with `running: false` ·
  canary: drop the queued map. · an operator with a live run coordinates · canary: restore the
  waiting-derived "coordinating". `agents-page.test.tsx` · the stat counts runs in flight, and the two
  `deploymentDot` assertions as a pure-function case · canary: restore the status clauses.
- **Docs.** `surfaces.md` surface-rules bullet.

### B4 · A model id's context-window variant survives to the SDK and to the picker (closes F34-7) (C8-2)

- **Root cause.** `app/server/runtimes/claude-runtime.server.ts:124-132` `resolveClaudeModel` matches the
  dated shape first and then falls to three `includes()` tests that return the BARE alias, so `opus[1m]`
  reaches the SDK as `opus` (live: the JC-2 operator's run row said `opus[1m]`). The static half
  compounds it: `app/shared/model-ids.ts:14-18` lists only the three aliases and `DATED_CLAUDE_ID_RE`
  requires the `claude-` prefix, so `isKnownModel` is true only while the 10-minute live cache holds the
  id; on a cold process `resolveRunModel` substitutes the catalog default and the editor rewrites the
  stored value.
- **Mechanism.** `CLAUDE_ALIAS_VARIANT_RE` and `splitClaudeVariant` in `model-ids.ts`;
  `claudeModelRunsVerbatim` accepts a variant alias. **Correction folded — the ORDER matters:** split the
  bracketed variant off the ORIGINAL string FIRST, run the ENTIRE existing resolution on the base (dated
  test included), then re-append the variant verbatim — otherwise `claude-opus[1m]` matches the dated
  branch (it contains a digit inside the bracket) and returns itself, which is not an SDK id and is not
  what the item's own test asserts. This yields `opus[1m] → opus[1m]`, `claude-opus[1m] → opus[1m]`,
  `claude-sonnet-4-5[1m] → claude-sonnet-4-5[1m]`, and the three existing cases unchanged; the dated
  branch's original-case passthrough is preserved for the variant branch too. `isKnownModel` accepts the
  variant shape BEFORE consulting the live cache, so a cold process never substitutes for a value the
  picker offered. **Correction folded — the display rule is stated:** the LIVE catalog row's
  `displayName` wins whenever the catalog holds the id ("Opus (1M context)"); "Claude Opus [1m]" is only
  the cold-process fallback, and the `modelDisplayName` comment says so.
- **Tests.** `claude-runtime.server.test.ts` · the resolver's five cases · canary: restore
  `if (m.includes("opus")) return "opus"` ahead of the split. · the variant reaches the SDK options —
  **correction folded:** add `model?: string` to `CapturedOptions` (`:63-74`) or extend the existing
  capture at `:340-358`, rather than inventing a second helper · canary: same edit.
  `model-catalog.server.test.ts` · a variant alias is known on a COLD process · canary: remove the regex
  clause. · the display name · canary: delete the variant branch.
- **Live validation:** one real run on a profile pinned to `opus[1m]`, reading the run header and the
  provider line back.
- **Docs.** `agents-and-runtime.md` §2.3 claude row.

### B5 · A profile save cannot silently revert a write it never saw (closes U34-3)

- **Why it is filed now.** NOTES.md:222 reserved the id during the pass ("Candidate for the ledger if
  it bites a real user") and nothing ever filed it, leaving a hole in the U-series that anyone
  reconciling ids would chase. It is filed rather than struck, because it loses work and because THIS
  pass makes it likelier: A32-A34 turn `update_agent_deployment` into a tool that actually lands
  capability and effort writes, so a person editing the same deployment in the modal while the
  controller writes it is no longer a hypothetical.
- **Root cause.** `updateAgentProfile` (`app/features/agents/agent-profile-actions.server.ts:625-672`)
  rebuilds the whole governed grant set from the SUBMITTED form inside the `updateProjectFile`
  callback: `deployment.capabilities = [...saved.grants, ...preserved]` (`:672`), where `saved` comes
  from `grantsFor(form.caps, …)` (`:668`) and `preserved` is only the capabilities OUTSIDE the modal's
  set (`:665-667`). The modal seeds `caps` once, at open time, from `initial.capabilities`
  (`create-profile-modal.tsx:279-310`), and the route's `update-profile` intent
  (`app/routes/project.agents.tsx:205-227`) carries nothing that says which version the editor read.
  The file mutex makes the write atomic; it does not make it aware. A modal opened before a concurrent
  write and saved after it therefore reverts every governed grant that write changed, reports
  `Profile "<name>" updated` and audits a successful save.
- **Mechanism.** `deploymentFingerprint(deployment)` in `agent-profile-actions.server.ts`: the sha256
  of the canonical JSON of the record the editor may overwrite (`capabilities` sorted by
  `capabilityId`, `extras`, `definition`) — not of the whole file, so an unrelated project edit never
  refuses a save. The agents loader ships it per deployment, the modal submits it as a hidden field,
  and `updateAgentProfile` recomputes it from the FRESHLY parsed deployment inside the writer callback
  (the only place the current record and the submission are both in hand) and throws
  `AppError.conflict("This profile changed while the editor was open. Reopen it to see the current
  grants, then save again.")` on a mismatch. A refused save writes nothing and audits nothing: it is a
  validation refusal, like every other one on this path. The controller's `update_agent_deployment`
  passes the fingerprint of the record IT just read, so its own read-modify-write inside one turn is
  never refused by itself while a hand-save landing between its read and its write is; the tool's
  refusal tells the model to re-read, in the F33-8 / A32 by-name shape.
- **Callers swept.** `project.agents.tsx:205-227` (the intent), the agents loader's deployment view,
  `create-profile-modal.tsx` (the hidden field; `create-profile` sends none, because a create has no
  prior record), and the controller toolkit's deployment writer (A32's file), which gains the
  fingerprint it already has in hand.
- **Tests.** `agents-route.server.test.ts` (the existing harness for this path; there is no
  `agent-profile-actions.server.test.ts` in the tree and none is added) · "a save carrying a stale
  fingerprint is refused and the concurrent write survives byte for byte", driven end to end through
  the real project writer: write grant X from a second actor between the loader read and the save ·
  canary: skip the comparison and write anyway, and the case then finds grant X reverted. · "a save
  carrying the current fingerprint applies, and `create-profile` needs no fingerprint" · canary:
  require the field on `create-profile` too. `agents-page.test.tsx` · the modal submits the
  fingerprint it was rendered with · canary: drop the hidden field, which makes the server refuse
  every save. `controller-toolkit.server.test.ts` · the tool's own read-modify-write is not refused by
  its own fingerprint, and a hand-save landing between its read and its write IS · canary: have the
  tool send a constant. The refusal sentence is `app/features/**` copy, so `copy-ban.test.ts`'s dash
  scan gates it: no em or en dash, and no `govern*`.
- **Live validation:** TESTPLAN V66 — the two-writer race performed by hand, once from the controller
  and once from a second tab.
- **Docs.** `surfaces.md` §1 (the `/projects/:slug/agents` row at `:34`, whose `update-profile` intent
  now carries the fingerprint and can refuse), `agents-and-runtime.md` (the deployment-write contract)
  and `controller-and-goals.md` §4 (the tool's new refusal).

---

## Band C — UI, copy, environment and docs

### C1 · The console's result line says "error" when the SDK ends an error run with subtype success (closes U34-1) (C3-5)

- **Root cause.** `app/server/runtimes/wire-format.server.ts:350-352`:
  the error text is built from `e.subtype || "error"` plus the turn count, and `:360`
  `subtype: e.is_error ? e.subtype : undefined`. The SDK ends an API-refused run with
  `SDKResultSuccess` carrying `subtype: "success"`, `is_error: true` and `api_error_status: 403`, so the
  console printed `result · success · 1 turns` one line above `run·error·unknown`.
- **Mechanism.** `outcome = e.is_error ? (e.subtype && e.subtype !== "success" ? e.subtype : "error") : "success"`;
  the error text appends ` · api <status>` and ` · <terminal_reason>` when the SDK sent them;
  `stats.subtype` follows. `SDKResultError` subtypes keep their own label, and no existing test pins a
  result TEXT. **Correction folded — the merge dependency is explicit:** this lands after (or carries)
  A3's `api_error_status` and `terminal_reason` additions to `claudeEnvelopeFields`; the schema block is
  in this item's files if it ships first. **Correction folded:** the risks note is corrected —
  `LogLine.stats` has no reader in the app today, so the relabel affects only the projected text.
- **Tests.** `wire-format.server.test.ts` · the three shapes · canary: restore `${e.subtype || "error"}`.
- **Docs.** `agents-and-runtime.md` §2.4.

### C2 · The branch-collision note states what was found instead of asserting a cause (closes U34-6) (C8-4)

- **Root cause.** `app/server/github/pr-adoption.server.ts:104-122` appends a fixed causal paragraph to
  every collision note ("This happens when a task key is reused … so this only reaches a task whose
  branch was recorded before that"), while ruling 122(d) (`decisions.md:2100-2107`) keeps the packet for
  TWO shapes — the sentence denies the first (a genuinely unowned OPEN PR that appeared AFTER Viberr
  allocated the branch), which is exactly what JC-8 hit at 10:17:52Z.
- **Mechanism.** One sentence naming both shapes and asserting neither. One writer, so all three sites
  (`github-reconciler.server.ts:602`, `workspace-delivery.server.ts:530`, `pr-open.server.ts:434`) get it
  at once; the "Branch name collision:" opening marker stays byte-identical so the eight existing
  matchers stay green. **Correction folded:** the function's own doc comment at `:97-103` repeats the
  single-cause claim one layer up and is rewritten with it.
- **Tests.** `pr-adoption.server.test.ts` · the note explains both shapes and asserts neither · canary:
  restore the old causal sentence. **Correction folded:** the copy-ban entry is DELETED — the dash gate
  (`copy-ban.test.ts:940-956`) walks `app/features`, `app/routes`, `app/ui` and the seed assets and its
  own comment says `app/server/**` stays ungated there, so its canary could not fire; the dash guarantee
  becomes `expect(note).not.toMatch(/[–—]/)` inside the new case, where it can.
- **Docs.** `github-delivery.md` §4. This item had no docs line and the check that it needed none was
  never run; running it finds the SAME single-cause claim one layer up, in prose:
  `docs/domain/github-delivery.md:152-154` says "A refused match is a **branch name collision** (task
  keys restart at 1 on a new data root, so `vib-4` on GitHub may still carry an old instance's work)".
  That parenthetical asserts exactly the cause U34-6 refutes, so it gains the second shape (an unowned
  OPEN PR that appeared AFTER Viberr allocated the branch, which ruling 122(d) keeps the packet for) and
  asserts neither. The note's own copy is quoted in no docs page — `surfaces.md:137` carries only the
  `Packet collision dialog` screen label, which does not change.

### C3 · The collision confirm dialog describes the branch it is actually about (closes U34-8) (C8-5)

- **Root cause.** `app/features/task-detail/decision-packet.tsx:431-495` renders ONE shape: the Deletes
  row at `:473-486` says "The stale branch <branch> … the unrelated one squatting on this task's branch
  name" with the unowned-PR clause as the only conditional, and the Keeps row promises "the real review
  PR opens". When `unownedPr` is null there is no stranger — `resolveRemoteBranchCollision`
  (`github-reconciler.server.ts:1580-1640`) deletes THIS task's own branch and skips the PR close — so
  the person confirms the deletion of their own pushed branch under a description of somebody else's.
  And `deleteTaskRemoteBranch` refuses outright when the task's own PR is open (`:1490-1496`), which the
  dialog never says: JC-6 at 10:33:06Z and JC-3 at 11:47:48Z were both confirmed and both refused.
- **Mechanism.** `PacketArchiveDisclosure` gains a REQUIRED `openPr: number | null`, filled at
  `task-detail-page.tsx:741-746` with the same predicate the server refuses on. `PacketCollisionConfirm`
  renders two shapes: the collision shape unchanged (**correction folded:** its confirm label is quoted
  exactly as it stands today, "Clear collision & redeliver", and kept — an ampersand-to-and edit is a
  copy change nobody decided), and a no-collision shape whose heading, Deletes row, Keeps row and confirm
  label describe THIS task's own remote branch. In BOTH shapes an `openPr` adds a warn row naming the
  refusal before the button is pressed. **Correction folded:** `PacketArchiveConfirm` reaches the same
  server refusal and today only INFERS that no PR stands (`decision-packet.tsx:730-736`) — it gets the
  same `openPr` warn row rather than keeping the inference.
- **Tests.** `decision-packet.test.tsx` · the no-collision shape (no "squatting", no "stale branch") ·
  canary: restore the single shape. · the collision shape still names the stranger and its PR · canary:
  make the no-collision branch unconditional. · the `openPr` warn row and its absence · canary: drop the
  row. **Correction folded:** the wiring test moves OUT of `task-detail-route.server.test.ts` (a
  loader/action file that renders no component) into `task-disposition.test.tsx` beside the V1 block at
  `:1560-1600`, which was written for exactly this defect class and already has `renderPage` and the
  `dialog[data-screen-label="Packet collision dialog"]` selector; it asserts the RENDERED row text, never
  the props object · canary: hardcode `openPr: null`. `task-disposition.test.tsx:1573-1600` (unownedPr
  232) stays green in the collision shape.
- **Docs.** `surfaces.md` §5, one new copy-rule bullet: the collision confirm renders TWO shapes (a real
  unowned-PR collision, and this task's own remote branch when `unownedPr` is null) and in both warns
  that the delete is refused while the task's own PR is open. §5 is where copy rules that tests enforce
  live, and this item adds one. The `Packet collision dialog` screen label at `surfaces.md:137` is
  unchanged, and the server refusal the dialog now discloses is already documented in
  `github-delivery.md` §4's Branch-cleanup row ("Refuses the default branch and a branch whose PR is
  open or accepted"), so that page needs no edit for C3.

### C4 · `invite_member` tells the truth and takes a role (closes U34-5) (C7-6)

- **Root cause.** `app/server/controller/controller-toolkit.server.ts:1486` says "new members join as
  contributor" while `inviteMember` (`app/features/project-settings/settings-actions.server.ts:787-846`)
  pushes `role: "viewer" as const` (`:826`), audits `{role: "viewer"}` (`:836`) and toasts "joins as
  Viewer" (`:842-843`); the settings form has no role field. Live, three invites landed as Viewer and the
  controller repaired them with `set_member_role`, two writes and two audit rows per person.
- **Mechanism.** `inviteMember` takes an optional role, seats it in the member row, the audit details and
  the toast, and keeps the `manage-members` gate; the tool declares the role and its description says
  members join as viewer unless a role is given, in one write and one audit row.
  **Correction folded — the validation home is resolved:** `inviteMember` parses its OWN input with
  `z.enum(PROJECT_ROLES)` (default `viewer`) and throws `AppError.validation("Unknown project role.")`,
  the same single enum `setMemberRole` uses; the tool keeps the enum for the model's benefit. Without
  that, the test harness (`controller-toolkit.server.test.ts:95-104` calls the handler directly, bypassing
  the SDK parse) would push an arbitrary string into project.md, where the tolerant per-row parse drops
  the member SILENTLY. **Correction folded:** `settings-route.server.test.ts:348` pins the exact toast
  "Added deniz@viberr.dev, who joins as Viewer" and survives only because `ROLE_LABEL.viewer` is
  "Viewer"; it is named in the sweep so the sentence is not "improved".
- **Tests.** `controller-toolkit.server.test.ts` · the role is seated in one write with one audit row and
  no `role_changed`; no role lands as viewer; the description no longer promises contributor; `role: 'owner'`
  answers `[error] Unknown project role.` with project.md byte-identical · canary: drop the `z.enum` parse
  (the call answers `[done]` and project.md carries an `owner` member row); restore the old description.
  `settings-actions.server.test.ts` · the role reaches the row, the audit and the toast · canary:
  hardcode `viewer` again.
- **Docs.** `controller-and-goals.md` §4; `auth-and-rbac.md` §3.

### C5 · The Activity audit column keeps the controller instrument (closes U34-4) (C7-7)

- **Root cause.** `app/server/projections/activity-feed.server.ts:358`
  `const actor = row.actor_name ?? displayAuditActorLabel(row.actor_label);` — for any row with a user id
  the joined name wins outright and the stored `actor_label` is never read, so a row written as
  `arda@viberr.dev · via controller` (built at `controller-tool-guards.server.ts:84` and
  `controller-run.server.ts:393`) renders identically to one the same person wrote by hand, dropping the
  disclosure ruling 99(b) requires. The org Audit log and `inspect_audit_log` render the raw label, so
  only this column loses it.
- **Mechanism.** `encodeControllerInstrument` / `decodeControllerInstrument` in `actor-ref.server.ts`
  (the actor-label vocabulary module), used by BOTH producers so there is no second literal, and one
  `auditActorDisplay(row)` helper in `auditText`. **Correction folded:** the helper decodes the instrument
  for BOTH legs, so a row whose user no longer resolves renders `<email> (via the controller)` rather
  than a third rendering (`displayAuditActorLabel` → `decodeActorRef` → capitalised raw).
  **Correction folded:** the item and `auth-and-rbac.md` state explicitly that the ORG Audit log keeps the
  RAW stored label on purpose (it is the forensic surface), and the `displayAuditActorLabel` header
  comment ("so one actor reads one way on both panels") is amended so it is not left contradicted.
  **Correction folded:** the claim "compaction is unaffected" becomes the true one — the FOLD is
  unaffected, and the collapsed summary names no actor (as today), so the instrument on folded runtime
  sessions is readable only when expanded; `surfaces.md` says so. The filter stays one option per person.
- **Tests.** `activity-feed.server.test.ts` · an instrumented row and a hand-written row render
  differently, the filter still lists one option, and the rendered-text search finds "via the controller";
  plus the userless row · canary: revert `:358`. `actor-ref.server.test.ts` · the round trip · canary:
  change the suffix in the encoder only. `activity-page.test.tsx` · the fold still works — **correction
  folded:** with the NEGATIVE case too (the same entries with the parenthetical after the SENTENCE must
  NOT satisfy `isRuntimeSessionOpen`) · canary: append it after the sentence.
  `controller-toolkit.server.test.ts` · a controller write renders as the person via the controller ·
  canary: revert `:358`.
- **Docs.** `auth-and-rbac.md` §5; `surfaces.md` activity row; `controller-and-goals.md` §4.

### C6 · The task page's hydration first pass depends on the timestamp alone, with a determinism gate (closes the `formatDayDotTimeUTC` defect and the `formatCalendarDate` sibling; U34-2 itself is C8) (C8-8)

- **Root cause.** `app/shared/dates/format.ts:153` `formatDayDotTimeUTC(iso, now = new Date())` samples
  `now` and branches on `sameUtcDay` while its own doc comment (`:148-152`) calls it "the deterministic
  first pass that SSR and hydration agree on byte-for-byte" and its sibling `formatDayBucketUTC`
  (`:135-141`) documents the opposite rule. It is the first-pass renderer behind `LocalDayDotTime`
  (`app/ui/local-time.tsx:15-18`), so a server at 23:59:59Z and a viewer at 00:00:01Z diverge on every
  timestamp at once.
- **Correction folded — the scope is honest.** This item closes the `formatDayDotTimeUTC` determinism
  defect, sweeps its `formatCalendarDate` sibling (below) and lands the gate. It does NOT close U34-2:
  both live sightings were at 10:3xZ and 11:07Z, nowhere near a UTC day boundary. **U34-2 is not left
  open, and it is not this item's tail:** it is its own committed item, C8, which takes the
  interrupted-hydration probe named here and runs it. This item hands C8 the instrument (the promoted
  `hydration-determinism.test.tsx`) and stops there.
- **Mechanism.** `formatDayDotTimeUTC` loses its `now` parameter entirely (so no caller can reintroduce
  the dependency) and returns `${formatDayBucketUTC(iso)} · ${clock(UTC)}` for every timestamp; the effect
  then swaps in the viewer-local form, the same trade the activity page's grouping already ships.
  **Correction folded — do not add a new file:** `app/features/task-detail/zz-hydration-probe.test.tsx`
  is already in the tree, untracked, and is a strictly better gate (it does a real `renderToString` then
  `hydrateRoot` with an `onRecoverableError` collector). Promote it: rename it
  `hydration-determinism.test.tsx`, delete the `console.log` / `process.stdout.write` and the
  `expect(true).toBe(true)` tautologies, assert `expect(errors).toEqual([])`, and add the UTC-midnight
  pair (23:59:59Z server / 00:00:01Z client) the canary needs. If it is not shipped it must be DELETED,
  not left untracked under `app/`. **Correction folded — fix the zone leg:** flipping `process.env.TZ`
  between two renders in one process does not re-zone the module-level `Intl.DateTimeFormat` instances
  (`format.ts:19-27`, `:121-125`), which resolve their zone at import; build each environment's render
  after `vi.resetModules()` plus a dynamic import (or run the pairs in separate processes), or the zone
  assertion proves nothing.
- **Tests.** `hydration-determinism.test.tsx` · the promoted probe with the midnight pair and the
  re-imported modules · canary: restore the `now` parameter and the Today/Yesterday branches.
  `format.test.ts` · the UTC first-pass formatters depend on the timestamp alone; the LOCAL siblings keep
  their `now` · canary: reintroduce a `now` read.
- **Callers swept.** `local-time.tsx:17`; `timeline.tsx:242`, `attachments-panel.tsx:117/141`,
  `execution-profile.tsx:224/257`; `insights-page.tsx:66`, `org-settings-page.tsx:296`,
  `controller-dock.tsx:516/552`; **correction folded:** `controller-page.tsx:233` and `:288`.
- **The `formatCalendarDate` sibling is SWEPT HERE, not filed as out of scope.** The earlier draft left
  a fork ("either fixed here or stated as out of scope in the ledger"); that is the only out-of-scope in
  the plan and it contradicts the preamble, so it is decided: it is fixed here, and re-reading the call
  sites today corrects the list twice. `calendarDate` (`format.ts:23-27`) is built with no `timeZone`,
  so it resolves in the HOST zone on the server and the VIEWER zone in the browser — the same class as
  `formatDayDotTime`. Four sites render it unguarded and each gets the `useHydrated()` treatment
  `local-time.tsx` already documents (a timezone-deterministic first pass, an effect swaps in the local
  form): `sso-panel.tsx:248`, `connections-panel.tsx:246`, `agent-accounts-panel.tsx:279-280` (the plan
  said `:277-280`; `:277-278` are the comment) and **`profile-page.tsx:221`, which the earlier list
  missed**. `insights-page.tsx:423` is **already guarded** — it renders `formatCalendarDate` only when
  `hydrated` is true and a marked `(UTC)` day key otherwise, with the reason in the comment at
  `:415-419` — so the earlier claim that it was unguarded is false and is struck; it is instead the
  shape the other four are moved to. The two SERVER
  calls (`app/server/org/connections.server.ts:486` and `:533`) are NOT in this class: they compose a
  toast string in an action result, never SSR markup that hydrates, so they are left alone and the item
  says so rather than sweeping them silently.
- **Tests (the sibling half), one per site's own suite.** `sso-panel.test.tsx` (`:248`),
  `org-settings-page.test.tsx` (the connections panel, `:246`), `agent-accounts-panel.test.tsx`
  (`:279-280`) and `profile-page.test.tsx` (`:221`) · each renders its timezone-deterministic first pass
  and the calendar date only after hydration · canary, one per file: drop that site's `useHydrated()`
  guard, which makes the pre-hydration render print the host-zone date. `format.test.ts` keeps the rule
  that `calendarDate` is host-zone BY CONSTRUCTION, so nobody "fixes" this by pinning UTC inside the
  formatter (which would silently re-word every rendered date instead) · canary: add
  `timeZone: "UTC"` to `format.ts:23-27`.
- **Docs.** `surfaces.md` §5, the timestamps bullet ("Timestamps render through
  `app/shared/dates/format.ts` only …"): it gains the hydration contract this item makes true
  everywhere — a first pass that depends on the timestamp alone, an effect that swaps in the viewer's
  local form, and calendar dates rendered through `useHydrated()` for the same reason.

### C7 · The runbook forbids reading the live projection database from the host (closes D34-1) (C8-9)

- **Root cause.** `docs/operations/runbook.md:197-200` tells an operator to run
  `sqlite3 "$VIBERR_DATA_ROOT/state/projection.sqlite" …`. On the shipped Docker deployment the data root
  is a bind mount, so that opens the database from the HOST while the container writes it — the
  dual-writer hazard the single-writer section on the same page exists to prevent, and the exact thing
  done at 09:12:46Z this pass minutes before the container took a SIGBUS (exit 135). The reader/writer
  table (`:326-330`) says nothing about which side of the container boundary a reader runs on.
- **Mechanism.** Replace the block with the in-container read-only form
  (`docker compose exec -T app node -e '…new DatabaseSync(path, {readOnly:true})…'`, the same option the
  app itself uses at `db/sqlite.server.ts:30`), keeping the query and the never-select-`secret_box` note.
  Add "Readers, and where they must run": the writer lock stops a second WRITER and nothing stops a second
  READER, but outside the container a reader maps the WAL index of a file the guest writes; every read of
  a live database runs inside the container, always read-only, and so do `npm run backup`,
  `npm run store:check` and `npm run keys -- status`. On bare metal a host reader is fine and must still
  be read-only. Add the dated correction note naming the pass-34 crash.
  **Correction folded — a SECOND host-side reader of a live root is left in the docs:**
  `docs/operations/deployment.md:332-336` (the lossy rebuild recipe) runs `npm run backup` BEFORE
  `docker compose down`; it becomes `docker compose exec app npm run backup -- --out /data/backups` (or
  moves after the `down`), and the Backup bullet at `:249-260` gets the same rule.
  **Correction folded:** every in-container backup instruction carries an explicit `--out` under the
  mounted root, because `scripts/backup.ts:28` defaults to `./backups`, which inside the container is
  `/app/backups` and is lost with the container.
- **Tests.** `app/shared/docs/runbook-db-read.test.ts` (new) · **correction folded:** it scans BOTH
  `runbook.md` and `deployment.md`, expressed as "no `sqlite3` invocation on `state/projection.sqlite`
  without `mode=ro`, and the container form appears first" rather than a pattern the new bare-metal line
  only just avoids · canary: restore the old `sqlite3 "$VIBERR_DATA_ROOT/…"` line.
- **Docs.** This item IS its docs change, listed here so no item is missing the line:
  `runbook.md` (`:197-200` the read block, the reader/writer table at `:326-330`, the new "Readers,
  and where they must run" section and the dated correction note naming the pass-34 SIGBUS) and
  `deployment.md` (`:249-260` the Backup bullet, `:332-336` the lossy rebuild recipe).

### C8 · The task page's #418 is reproduced under an INTERRUPTED hydration and closed (closes U34-2) (C8-8b)

- **Why this is its own item.** C6 closes the `formatDayDotTimeUTC` determinism defect and hands over an
  instrument; it cannot close U34-2, because both live sightings (Arda at ~10:3xZ during a live run,
  Maya on JC-4 at 11:07Z with an `accept_completion` card showing) were nowhere near a UTC day boundary.
  Leaving the ledger row open with "its next probe named" is the one place the plan's own preamble does
  not hold, so the probe is not named and left, it is RUN, and whatever it names is fixed in this pass.
- **What the code says today.** (1) `app/entry.client.tsx:5-12` wraps `hydrateRoot` in
  `startTransition`, so hydration is interruptible: a discrete update that lands before the root
  finishes makes React re-render the tree and, where the re-rendered text differs from the server's DOM,
  report the recoverable "server rendered text didn't match the client" — the minified `#418` with
  `args[]=text` that both sightings carry. (2) The task page owns TWO update sources that fire during
  first paint and no other page combines: `useRunLogStream`
  (`app/features/runtime/use-run-log-stream.ts`, its OWN `EventSource` consuming `run.log-appended`
  into `useState`, plus a `useRevalidator` on `run.state-changed`), wired at
  `task-detail-page.tsx:361-378`, and `useLiveUpdates`'s revalidator
  (`app/features/live-updates/use-live-updates.ts:107`). Both sightings were on pages with exactly
  those in flight. (3) The hydration-safe primitives in that tree are already correct, so they are
  ruled out by reading rather than by guessing: `useElapsed` seeds `now` to `null` on both sides
  (`runs-helpers.ts:550-564`), `LocalRelative` renders the same `"\u{a0}"` on both
  (`local-time.tsx:40-41`), and there is no `Date.now()`, `new Date()` or `toLocale*` in render under
  `app/features/task-detail/**`. The ONE render-time non-determinism left there is
  `use-mention-autocomplete.ts:74-77`'s `Math.random()` list id — an ATTRIBUTE, which React 19 reports
  as a different error than `args[]=text`, so it is a suspect to RULE OUT, not the presumed cause.
- **Mechanism — reproduce, then fix what it names.** (a) Extend the probe C6 promotes
  (`hydration-determinism.test.tsx`) with an INTERRUPTED case that mirrors `entry.client.tsx` exactly:
  hydrate inside `startTransition`, and between the `hydrateRoot` call and the flush dispatch a
  discrete update of the shape `useRunLogStream` produces (an appended log line for the thread being
  viewed) — run it over both live shapes, a running run with a streaming console and an
  `accept_completion` card at the acceptance boundary. (b) If that does not reproduce, escalate to the
  instrument that cannot hide the answer: the same two shapes against `npm run dev` on a scratch data
  root, where React is UNMINIFIED and the recoverable error prints the server text and the client text
  verbatim instead of an error code. (c) Fix the named text node at its source by the rule this
  codebase already applies and documents (`app/ui/local-time.tsx`): a value that cannot be identical on
  both sides renders a deterministic first pass and an effect swaps in the real one — or the
  non-determinism is removed outright (the `Math.random()` id becomes React's `useId`, which is
  hydration-stable by construction, if that is what the probe names). Whatever lands gets its own case
  and its own canary in the suite that owns the component.
- **The gate lands regardless of what the probe finds.** Two permanent gates, so this class cannot
  return silently: the interrupted case above, and a TASK-PAGE case in
  `e2e/06-activity-hydration.spec.ts` (already `test.use({ timezoneId: "Pacific/Auckland" })`, already
  collecting `pageerror`) that loads a task with a live run and an open accept card and asserts
  `pageErrors` is empty. That assertion is real for THIS defect and not only for thrown errors: React
  19's default `onRecoverableError` reports through `window.reportError` when it exists
  (`react-dom/cjs/react-dom-client.production.js:2308-2309`), which Playwright surfaces as `pageerror`
  — which is why the activity spec's own assertion catches its #418 and why this one will. The case
  joins that file rather than a new spec because the timezone fixture and the error collector are
  already there; its docstring and the `testing.md` row say it now covers both pages, and the file
  keeps its name (a rename would churn the docs table and the CI report for nothing).
- **Tests.** `hydration-determinism.test.tsx` · "the task page hydrates clean when a run-log update
  lands mid-hydration" (both shapes) · canary: reintroduce the non-determinism the probe named at its
  source; if the probe names nothing, the canary is a deliberate host-zone `formatCalendarDate` planted
  in the timeline row, which the case must catch (a gate that cannot go red is not a gate — ruling 65).
  `e2e/06-activity-hydration.spec.ts` · the task-page case · canary: revert C6's `formatDayDotTimeUTC`
  change and run the spec with the container clock set one second before UTC midnight.
- **Ledger.** FINDINGS.md's `U34-2` row moves from `confirmed (2 sightings)` to `fixed`, and the file
  gains the `### U34-2` detail it has never had (the row is currently a table line with no detail
  section), carrying the reproduced cause and the instrument that produced it. The pass does not close
  with a row whose status is "a probe was named".
- **Docs.** `testing.md` §e2e table (the `06-activity-hydration.spec.ts` row's count and "Covers" text
  gain the task-page case) and the sentence naming the interrupted-hydration unit gate beside it.

---

## Rulings to record

Numbers are assigned in band order; every ruling below comes from a Band A item. Paste each under the
next number in `docs/architecture/decisions.md` "ORCHESTRATOR RULINGS" (the last existing ruling is 127
at `decisions.md:2164`), and update the count in `docs/README.md`. Cross-references inside the texts
below already use these final numbers.

### 128 — Viberr bootstraps the default branch of an empty repository itself (A1)

> 128. **Viberr bootstraps the default branch of an empty repository itself (owner, 2026-09-03, pass 34
> Q34-2).** Live (JC-1 on `akin-ozer/jira-clone`): the pre-dispatch branch hook found no `main` ref and
> said nothing; the delivery push then created `jc-1` as the repository's FIRST ref, GitHub made it the
> default branch, `POST /pulls` failed 422 `base: invalid`, and every surface, the tool result, the
> timeline, the audit row and the operator's packet reported "GitHub was unreachable (network error).
> Fix the repository/credential settings" while GitHub answered every call. Three lies (cause, remedy,
> state) and no way out: nothing in the product could create `main`, and the one thing the exercise
> forbids is a person pushing by hand. The rule: when the project's default branch has no ref, Viberr
> creates it BEFORE the task's first branch. On a repository with no refs at all it authors an initial
> commit (`README.md` naming the project) through the Contents API, which GitHub accepts on an empty
> repository where the Git Data ref and commit endpoints answer 409, and the branch that commit lands on
> is the default. On a repository whose only refs are task branches pushed before this ruling it creates
> the default branch at the first commit of GitHub's current default branch and restores the configured
> name as the repository default, the repair the owner approved live (Q34-3). Both are disclosed on the
> task timeline and audited as `github.repo.bootstrapped`. The bootstrap runs from `ensureTaskBranch`
> (both dispatch paths, ruling 122(c)) and again from `performDelivery` before the push; a delivery whose
> base cannot be CREATED does not push at all, so a task branch is never the first ref of a repository,
> while a probe that merely could not be READ (a transient network or auth failure) does not block the
> push and does not claim the base is missing. A 422 `base: invalid` on `POST /pulls` is
> `base_branch_missing` and says so; any other unmapped 422 is `refused` and quotes GitHub; neither is
> ever reported as a network failure, and a 409 "Git Repository is empty" on a ref read is a missing ref,
> not a network failure. (`app/server/github/repo-bootstrap.server.ts`; `ensureTaskBranch` in
> `branch-sync.server.ts`; the 422 arms in `pr-open.server.ts`; the pre-push gate and the rendering in
> `task-actions.server.ts`.)

### 129 — A reused delivering workspace is refreshed from the project mirror on every dispatch (A2)

> 129. **A reused delivering workspace is refreshed from the project mirror on every dispatch (owner,
> 2026-09-03, pass 34 Q34-5).** Live (JC-2 to JC-5): the task workspaces were cloned once, by the
> operators' first triage at 09:00Z, from a repository that was still empty; every later run reused them
> as they stood, agents hold no credential so they could not fetch, and while the operator read a
> bootstrapped `main` through the mirror and told the spec writers so, the spec writers found zero
> commits in their checkouts and committed unrelated root commits on `jc-2` and `jc-5`. Two sources of
> truth in one task, and `update_branch_from_base` could only answer "refusing to merge unrelated
> histories". The rule: before a delivering run starts in an existing checkout, Viberr fetches the
> mirror's heads into the checkout's `origin/*`; a checkout whose HEAD is unborn, or that sits clean on
> the default branch, is fast-forwarded to `origin/<default>`; a task branch that has diverged is left
> exactly as it is, because `update_branch_from_base` (N19-9) owns that move and a conflict there is a
> human decision; a dirty tree and a detached HEAD are never touched; and a branch that shares NO history
> with the default branch is named as such in the run's inputs and in the agent's workspace contract
> rather than silently left alone. The refresh is not defeated by a cold cache: the dispatch creates the
> mirror if it must, and falls back to a server-side credentialed fetch of the remote heads if it cannot.
> The refresh is disclosed in the run's `run·inputs` line and in the agent's workspace contract, and a
> mirror that could not itself be refreshed from GitHub says so there. Supporting checkouts keep their
> fetch-only refresh (pass 32, C32-2), now the same function. The operator's read-only view of the same
> directory is refreshed on the same terms when no delivering run is live for the task, because the
> operator holds `Read`, `Grep` and `Glob` over it; its default-branch reads remain mirror-anchored
> (F21-21). A cache still never blocks a task: a failed refresh degrades with a warning and the run
> proceeds. (`app/server/tasks/workspace-refresh.server.ts`, called from `cloneRepo` in
> `app/server/tasks/specialist-run.server.ts`.)

### 130 — A refused run's packet names the cause Viberr classified and the remedy the person actually has (A3-A7)

> 130. **A refused run's packet names the cause Viberr classified and the remedy the person actually has
> (owner, 2026-09-03, pass 34 Q34-7; F34-1, F34-12).** Live: a five-hour session limit and a 403
> `oauth_org_not_allowed` were both `run·error·unknown` ("Review the runtime configuration"), the
> controller answered "Say it again to retry", the operator's recovery packet recommended "I've updated
> the policy / credential - unblock and re-run", the resolved decision was recorded as "policy /
> credential updated", and an operator acting on that record told a specialist a GitHub-scope block had
> been lifted (JC-6), undoing the owner's Q34-10 decision. The ruling: **(a)** provider refusals are
> classified from the STRUCTURED envelope first (the result's `api_error_status`, the assistant
> envelope's `error` code, a `rate_limit_event` whose `status` is `rejected`) and from prose second; the
> classified terminal line carries the machine facts (kind, the reset instant, the window, the API status
> and code) beside its tag suffix, and every reader of a failure (packet builders, the controller's note,
> the Agent-logs footer for every run kind, the quota store) consumes that class, never a second regex
> over the raw stream; the API error banner the provider streams as an assistant message is an error
> line, never the agent's reply. **(b)** Under ruling 127 the remedy for `quota` and `auth` belongs to
> the credential principal, so the packet body, the blocked timeline event and the controller's note name
> that person and their own move: wait until the reset instant Viberr quotes, or connect a different
> account or an API key on Profile → Agent accounts. Generic advice ("fix the credential", "retry on the
> other backend", "review the runtime configuration") is never written for a classified refusal;
> `retry_other_backend` stays offered only when the owner has the other backend connected. **(c)** A
> recovery option's label states what the human asserts and what will happen; its recorded decision is
> that label or a pre-authored `ev`; the toast and the operator's re-run instruction state the EFFECT
> (unblocked, re-run) and restate no claim; "policy / credential updated" is reserved for the stock
> policy-block option the operator authors itself and is never the default for a failed run. One module
> (`run-failure-remedy.server.ts`) owns the failure-to-words mapping for operator and specialist runs
> alike. **(d)** A quota or credential refusal is recorded as evidence about the account it billed: the
> observation store, Insights, `instance_health` and the person's own Agent-accounts card say whose
> account, from which run, and when the window reopens, so an instance-wide "usage limit reached" is
> never claimed on behalf of accounts that were not refused; the unauthenticated `/resources/health` body
> keeps its contract and carries no principal, and the card states that the pill is the last refusal
> Viberr OBSERVED, which any completed run on that backend retires. Extends rulings 76 (R20-1), 78
> (R20-3) and 127; `PACKET_OPTION_KINDS` (ruling 7) is unchanged.
> (`app/server/runtimes/claude-runtime.server.ts`, `wire-format.server.ts`, `backend-quota.server.ts`,
> `run-sink.server.ts`, `app/server/tasks/run-failure-remedy.server.ts`, `task-actions.server.ts`,
> `operator-run.server.ts`, `app/server/controller/controller-run.server.ts`.)

### 131 — Task dependencies: a task names what it waits on, Viberr holds it without a packet and releases it itself (A8-A15)

> 131. **Task dependencies: a task names what it waits on, Viberr holds it without a packet and releases
> it itself (owner, 2026-09-03, pass 34 Q34-11).** Pass 34 ran five controller-built goal chains against
> one repository and three of them stalled behind the first: JC-7 and JC-9 could not start until goal-1's
> links 2 to 4 were on the base branch, and goal-3 and goal-5 queued behind the same work. Every operator
> read the situation correctly, and every one of them had only a decision packet to say so with: JC-7's
> hold ended as `waiting: human` with one comment; JC-9's operator ran five paid turns and then wrote
> "this packet is the standing token … nothing will re-check main for JC-9 again"; a person had to answer
> each hold and would have had to re-answer each one by hand when the foundation landed. Nothing in the
> product watched the thing being waited for.
> **(a) The fact lives on the task.** `task.md` carries `blockedBy: []`, the task keys (`JC-6`) and goal
> links (`goal-1 link 3`) in the same project this task waits on. It is planning metadata with one
> difference from priority, labels and due date: while the list is non-empty the derived readiness is
> floored at `blocked` (`deriveReadiness`, the one derivation home), the board card, the list row and the
> task page say what it waits on and in what state, and the task owes nobody anything (`waiting: none`
> unless a packet or a recommendation is open). A goal-link entry resolves to a task key the moment the
> chain creates that link's task and renders as both. States are resolved at read time, never cached.
> **(b) Three writers, one gate.** Humans set the list on the task page; the controller sets it through
> `create_task`, `update_task` and per goal link on `create_goal` / `update_goal`, under the asking
> person's own gate; the operator records it with its `set_dependencies` tool (gated like packets,
> `generate-packets`) instead of opening a hold packet. Every write validates against the store: a
> reference must parse, name an existing task or goal link in this project, not be the task itself, not
> be an archived task, and not close a cycle, counting DECLARED goal-link edges as well as created tasks;
> a refusal names the reference and the reason. Every write is a `note` on the timeline and
> `task.dependencies.updated` in the audit log.
> **(c) Chain-created tasks inherit.** A goal link may declare `blockedBy`; when the chain creates that
> link's task the list is copied onto it and validated then, so a link that waits on a sibling chain's
> link is born held instead of paying a triage turn that has to discover the wait.
> **(d) The operator holds without a packet and is not nudged.** While the list is non-empty: the
> `create`, `transition` and `scheduled` triggers are refused at fire time (`refused: "blocked-by"`; no
> run, no cost; the refusal settles the task's waiting flag, and a scheduled occurrence says on the
> timeline that no run happened); the stranded-coordination backstop treats the list as a recorded hold
> and never nudges; and every turn that does run (an agent report, a human's question, a resolved packet,
> a goal edit, a PR change, a manual run) is told what the task waits on, in a doctrine that REPLACES the
> ordinary "never end your turn with nothing done and no packet" tail, and must neither advance it,
> dispatch delivery work, nor open a hold packet about the wait. A human-scheduled AGENT run still fires:
> this ruling refuses operator triggers.
> **(e) Viberr releases it.** When every entry is done (its task reached the terminal stage; its goal link
> is done or was skipped) the release engine clears the list, writes the release note naming what was
> waited on, lifts a stored `blocked` readiness to `ready`, clears a recorded `heldAtStage`, notifies the
> owner and supervisors (notification kind `dependency`, its own routing toggle) and re-invokes the
> operator with the `dependencies-released` trigger, whose doctrine says the base branch has changed since
> the hold and that a hold packet the operator opened itself is now moot. The engine runs from the same
> task-write hooks that advance goal chains (transition, archive and restore, acceptance) and from the
> goal runner's minute tick, and it is convergent: an empty list has nothing to release. A human clearing
> the list is the same release, through the same two halves. A dependency that can never complete (its
> task archived, its link failed) does not release: it is noted once on the dependent's timeline, the
> owner is notified, the task is left `waiting: human` because a person owes the list an edit, and the
> entry renders as "archived" until they make it.
> **(f) What this replaces.** The two live holds convert by setting the list: JC-7 (held as
> `waiting: human`) gains its three entries; JC-9 gains them and its standing-token packet is resolved
> once, or is left for the release turn to withdraw as moot. The operator doctrine no longer offers "open
> a packet asking the human to confirm the hold" for a wait on other work; that exit stays for holds a
> human directed. Ruling 126's price still applies to the turns that run; the turns this ruling refuses
> cost nothing.
> (`app/shared/dependencies.ts`; `app/server/tasks/dependencies.server.ts`;
> `app/server/projections/dependencies.server.ts`; `deriveReadiness` in
> `app/server/interpretation/readiness-policy.server.ts`; the `blocked-by` refusal, the
> `dependencies-released` trigger and the doctrine in `app/server/runtimes/operator-run.server.ts`;
> `set_dependencies` in `app/server/tasks/operator-toolkit.server.ts` and the Codex plan; the controller
> tools in `app/server/controller/controller-toolkit.server.ts`; `task_projections.blocked_by_json`.)

### 132 — Revision drift counts authored commits only; a base refresh is reported as what it is (A16, A17)

> 132. **Revision drift counts authored commits only; a base refresh is reported as what it is (owner,
> 2026-09-03, pass 34 Q34-12).** R17-1 measured drift as GitHub's `compare(reviewedSha...head).ahead_by`,
> which counts every commit reachable from the PR head and not from the reviewed revision, so an
> operator's `update_branch_from_base` (four commits from `main` plus the merge commit) made the accept
> dialog, the review-queue subline and JC-8's permanent completion record say "5 commits added since
> review; they merge unreviewed" while the operator's own read of the same task said no drift at all.
> Drift is now the number of AUTHORED commits since the reviewed revision: the commits in
> `reviewedSha...head` that are not reachable from the base branch and are not clean merge commits. A
> clean merge commit is one the product itself made through `update_branch_from_base` and recorded on the
> task as `baseRefreshes[]` the moment the merge landed (that path aborts on any conflict, so every
> recorded merge is clean by construction); a merge commit from anywhere else, a conflict-resolving merge
> included, is an out-of-band write to the branch and counts. A base refresh is reported separately and
> never as unreviewed work: `pr.revisionDrift` is `{ headSha, authored, baseRefresh: { merges, commits } |
> null }` (a fast-forward refresh is `merges: 0`), and ONE function, `describeRevisionDrift` in
> `app/shared/revision-drift.ts`, turns it into the sentence every surface prints verbatim. Its consumers
> are the reconciler (which writes the fact), the operator's `get_task` read and turn doctrine, the accept
> and force dialogs and "Complete merge", the review-queue subline and the completion record. A pass that
> cannot classify (either compare unavailable, truncated or partly undecodable, or a PR whose base is not
> the project's default branch) carries the last measurement forward, or, with no measurement to carry,
> records every commit since the reviewed revision as authored; it never writes "no drift" from silence,
> and a commit it cannot classify counts as authored. The operator's branch update records its merge
> commit and the base tip it merged, re-measures drift in the same call and returns the sentence, so the
> operator and the ceremony can no longer read two different facts about one head. Extends R17-1 and the
> F21-17 residual; acceptance still merges an ahead head, honestly.

### 133 — An engaged deliverer acts at any stage; stage eligibility gates NEW engagements (A18-A20, A22)

> 133. **An engaged deliverer acts at any stage; stage eligibility gates NEW engagements (owner,
> 2026-09-03, pass 34 Q34-13; F34-16).** A profile's eligible stages (`stages:` / `spanAll`, resolved per
> board by R14-1's three steps) decide which profiles may be NEWLY engaged on a task at its current
> stage: `assignSpecialist`, `assignReviewer` and the dispatch's auto-engage keep refusing an ineligible
> profile. Once a profile is the task's delivering engagement it may be prompted or resumed on that task
> at EVERY stage, by the operator, by a human @mention, by the Run control, by a schedule and by the
> built-in packets (`redirect`, `retry_other_backend`, a resolved question), for rework, conflict
> resolution and follow-ups; the admitted reason is recorded on the `task.agent.run_started` audit row as
> `stageEligibility`, which names the exemption only when it was needed. Supporting engagements
> (reviewers and helpers) stay stage-scoped, and the rule is the same on every door: an @mention that
> would resume a supporting agent at a stage its profile does not declare records the comment and refuses
> the run with the dispatcher's own sentence, and a profile that is not engaged at all (released, or
> never engaged) is judged by the new-engagement rule even when a provider session survives.
> Consequences: **(a)** rework routing (`reworkStages`, `transition_stage`) is a workflow choice about
> where the board should show the work, never a workaround for a profile's stages, and the operator
> doctrine, toolkit descriptions and seeded persona say so; **(b)** a built-in packet offers only options
> that can execute: the branch-conflict and push-conflict packets recommend "Have the delivering agent
> resolve the conflict" only when the task has a delivering engagement whose profile is deployed with a
> repo-write grant, and otherwise recommend resolving by hand and say why, with the offered resolver
> recorded in the branch-update audit row; **(c)** the Agents surface states the rule beside the "N of M
> stages" count, and states the scoping half only for a profile that is actually scoped, while the
> operator's `get_task` snapshot reports the deliverer as eligible for the current stage and the
> selection trace marks the posture the dispatch will actually take. The F1 run-boundary test that
> asserted the opposite for the deliverer is reversed deliberately by this ruling; the reviewer half of
> F1 stands. Supersedes the "asserted on assignment and dispatch" sentence in `agents-and-runtime.md` and
> ruling 98(b)'s "fenced by stage eligibility" as it applied to re-running an engaged deliverer. Ruling
> 98(a) is NOT touched: who may decide a delivery hand-off was put to the owner as Q34-14 and answered on
> 2026-09-04 — the operator may switch the delivering agent however it judges best, because a human can
> redirect it through the operator chat or agent allocation — so 98(a) stands with a dated confirmation
> note and no separate ruling.

### 134 — Rework reaches its own open pull request (A23, A24, A26)

> 134. **Rework reaches its own open pull request: a delivery pushes whatever origin does not carry,
> reuses the PR, and says what moved (owner, 2026-09-04, pass 34 F34-11).** `operatorDeliverForReview`
> answered "PR #N is already open for review; there is nothing to deliver" for any cached non-terminal
> `pr.state`, before `performDelivery` ran, so every commit an agent made after the first delivery (a
> reviewer-requested rework, a resolved base conflict, the whole JC-6 scaffold) stayed in the workspace:
> the operator reported nothing pending, the reviewer approved the local revision, the accept dialog
> bound to a sha GitHub had never seen, `update_branch_from_base` said "already up to date", and the task
> page hid the Deliver control because a PR existed. Three rules. **(a) Delivery is defined by the
> remote, not by the cache.** `pushWorkspaceBranch` reads origin's head for the task branch before
> pushing, pushes when it differs, answers `up_to_date` when it does not, and the delivered outcome
> carries the head sha and the previous remote head; the operator's cached-state short-circuit is
> deleted, and the only honest noop is "PR #N already carries `<sha>`". A head the push moved on a reused
> PR is recorded on the timeline ("Pushed `<sha>` to **PR #N**") and in the delivery audit row, and every
> human door that performs a delivery (the task page's control and an applied operator recommendation)
> says what moved through one shared toast. **(b) A head the push moved is a new review subject.** Ruling
> 48's "only a NEWLY opened PR re-queues" becomes "a newly opened PR, or a head the push moved"; a reuse
> that pushed nothing still re-queues nothing, so the loop ruling 48 guarded against cannot start.
> **(c) A person may always perform that push, and the operator is told to.** The task page offers the
> control whenever the delivered revision is not on the open PR ("Push `<sha>` to PR #N", ruling 135's
> record) and not only when no live PR stands, while a DIVERGED branch gets the fact and a disabled
> control naming the refusal the server would give rather than a button that then fails;
> `update_branch_from_base` reports the remote copy of the branch beside its base answer (current, behind
> by N, diverged, absent) and points at `deliver_for_review` instead of pronouncing a lagging branch
> "already up to date"; the operator's tool description and persona say that pushing an unpushed revision
> is this tool's job. Pushing remains the server's act on the operator's or a person's decision (ruling 21
> unchanged): never an agent's, never a person's outside the product. (`pushWorkspaceBranch` in
> `app/server/github/push-workspace.server.ts`; `performDelivery` in `app/server/tasks/task-actions.server.ts`;
> `operatorDeliverForReview` in `operator-actions.server.ts`; `updateWorkspaceBranchFromBase`;
> `GithubTrace` in `app/features/task-detail/task-side-panels.tsx`.)

### 135 — An unpushed delivered revision is its own acceptance gate (A25)

> 135. **An unpushed delivered revision is its own acceptance gate, ranked above a conflicting PR, and the
> PR head is recorded in `task.md` (owner, 2026-09-04, pass 34 F34-11).** The accept dialog on JC-3 read
> "PR #10 conflicts with the base branch … Rebase the branch and re-review, or archive the task" for a
> branch that was merged, resolved and merely unpushed: `mergeable: conflicting` described the OLD head,
> the reviewer's verdict was bound to the workspace revision, and nothing in the file could say that the
> delivered revision was not on the pull request. The reconciler now records `pr.headSha` and, when the
> delivered revision is not reachable from that head, `pr.unpushedRevision` (`behind` — a plain push
> fast-forwards; `diverged` — a push will be refused as non-fast-forward; `unknown` — GitHub does not have
> the revision at all, which is what a never-pushed sha actually looks like: the compare answers
> `missing_ref` and a direct commit read answers 404). The workspace reconcile records the same fact the
> moment a delivering run mints a new revision on a branch whose PR is open, so the gate does not wait for
> the five-minute poll; a delivery that pushes clears it; a verification revision never qualifies.
> `unpushedRevisionBlockedReason` is ONE helper, taking the PR ref and the current revision sha so every
> caller can ask it from the shape it holds, consulted by every writer and every surface that consults
> `conflictingPrBlockedReason` — the acceptance refusal stack, the projection's block reason, the review
> queue (whose row carries the two new fields, or the branch could never fire), the board ceremony, the
> accept-time merge sentence, the review row subline, the operator's `get_task` — and it outranks the
> conflict sentence because it names the fact the person can act on: "deliver the branch to push it",
> never "rebase". The live accept-time head check refuses on the same evidence instead of answering
> "unverifiable". Ruling 42's "ahead" (`revisionDrift`) is the mirror case and is unchanged.
> (`prRefSchema`, `unpushedRevisionOf`, `unpushedRevisionBlockedReason` in `app/schemas/task-file.schema.ts`;
> `reconcileTaskUnlocked` in `github-reconciler.server.ts`; `reconcileWorkspaceDelivery`; `writePrToTask`
> in `pr-open.server.ts`.)

### 136 — `resolve_remote_collision` never strands on either arm (A27, A28)

> 136. **`resolve_remote_collision` never strands on either arm, and the ceremony reads GitHub before it
> refuses (owner, 2026-09-04, pass 34 F34-10 / F34-11).** Ruling 110's "it never strands" was carried by
> the re-delivery's own follow-up, which had two silent exits: `recordDeliveredNextStep` records the
> "Move to <review>" card only when the board declares a `stage → review` edge (a Backlog → Spec/Design →
> Implementation → QA → Review → Done board declares none from Implementation), and ruling 48's re-queue
> fires only on a newly opened PR under full autonomy. Live (JC-8) a fully successful ceremony — branch
> deleted, unowned PR closed, PR #9 opened — ended `waiting: human` with no packet, no card and no run;
> the refusal arm (JC-6, JC-5) ended `readiness: blocked · waiting: human` for a "collision" that was the
> task's own open review PR; and (JC-3) a human who had closed the PR on GitHub seventy seconds earlier
> was refused because `task.md` still said `review`. Three rules. **(a) The ceremony ends with exactly one
> hand-off.** The kind stays out of the generic `packet-resolved` re-queue — that hand-off runs before the
> ceremony and could not carry its outcome — and the ceremony fires its own at its end: the ruling-48
> `delivered` re-queue when the re-delivery fired it, otherwise a `packet-resolved` re-queue whose payload
> carries the ceremony's outcome in its OWN field, rendered to the operator as Viberr's sentence and never
> inside the human's quoted note, so the operator's next turn states what happened instead of re-deriving
> it and never reads a server-composed fact as the person's own words. The in-ceremony reconcile of (c)
> runs with the operator wake and the member divergence notice suppressed, so "exactly one hand-off" is
> literally true. The server-recorded card stays where the board lets it apply. **(b) A refusal that finds
> no collision does what the person asked for.** When the ref delete refuses because the PR on the branch
> is this task's own open review PR, the packet's premise was false: for a remote that is merely behind or
> absent the block is lifted, a self-referencing `github.unownedPr` is cleared and the ceremony performs
> the delivery that pushes the work; for a diverged remote the block stays and the note says that the
> remote branch holds commits this workspace does not and who resolves the history. Every other refusal
> keeps the block and hands its typed reason to the operator. **(c) A cached open PR is re-confirmed
> before it can refuse.** `deleteTaskRemoteBranch` runs a reconcile pass when `task.md` says the PR is
> open, refuses only a PR GitHub still reports open, proceeds when GitHub reports it closed or merged, and
> fails closed — "GitHub could not confirm" — for every degraded or unexpected reconcile status; nothing
> is ever deleted on an unconfirmed state, and the archive and empty-branch cleanup doors inherit the same
> live check and the same sentence. Ruling 110's delete-first order, the human-only gate and the
> scope-violation on a refused close are unchanged. (`resolvePacket`'s collision arm in
> `app/server/tasks/task-actions.server.ts`; `resolveRemoteBranchCollision` and `deleteTaskRemoteBranch` in
> `app/server/github/github-reconciler.server.ts`.)

### 137 — An acceptance offer is bound to the revision it was made for (A29)

> 137. **An acceptance offer is bound to the revision it was made for, and is withdrawn, on the record,
> when that revision or the task's decision state changes (owner-directed fix of F34-15, 2026-09-04).**
> The operator's `accept_completion` card ("the review is clean and the work meets the goal") stood on
> JC-3 after the deliverer committed a new revision with no verdict and after the operator opened a
> blocked conflict packet on top of it; only a non-healthy verdict, archive or acceptance had ever dropped
> it, and a stage move dropped transition cards alone. Every `accept_completion` card now carries
> `forHeadSha`, the work revision it was authored against, on both the authoring and the re-authoring
> path, and renders "for revision <sha>". ONE helper, `withdrawAcceptanceOffers`, living in the leaf task
> mutation module so every writer can call it without closing a module cycle, removes `accept_completion`
> cards and `transition` cards targeting the terminal stage inside the task file's own lock: it runs in
> the write that mints a new work revision (the delivery reconcile), in every writer that opens a decision
> packet (the operator's, an agent's question, the completion-envelope question), and in a stage move away
> from the acceptance boundary as the workflow graph defines it. A withdrawal is never silent: a `note`
> event titled "Recommendation withdrawn" names the card and the cause, an audit row
> `task.recommendation.withdrawn` records it, and the card's "Waiting on you" notification is marked read
> only when no recommendation survives. `run_agent` and `delivery` cards survive all three events: more
> work is compatible with rework. The operator re-recommends acceptance on its next turn if the offer
> still holds. Extends the 2026-07-18 owner decision that a divergence withdraws moot cards, and
> `applyRecommendation`'s F19-3 rule that a terminal transition card is an acceptance.

### 138 — A decided `edit_goal` packet reads as decided everywhere (A30, A31)

> 138. **A decided `edit_goal` packet reads as decided everywhere, and the goal draft it opens is an
> explicit, shared field (owner-directed fix of F34-13 and U34-10, 2026-09-04).** Confirming an
> `edit_goal` option stamped `packet.awaiting: goal_edit` and opened the goal editor from the in-memory
> action result only; after a reload the card rendered undecided with every option selectable, a second
> confirm was a 409 shown as a passing toast, the readiness pill said "input required", and the goal's
> Edit button was the undiscoverable way out. The packet now records the decision itself,
> `decided: { optionIndex, at, byUserId }`, beside `awaiting`. The decision-packet card renders a decided
> packet with the chosen option locked, the words "Decision made · save the edited goal to clear this
> packet" and one control, "Edit the goal", which opens the goal editor prefilled exactly as the confirm
> did; the display readiness is `goal_edit_pending` on the hero, the board card and the review queue,
> derived in `deriveDisplayReadiness` like every other display state and ranked below `agent_working` and
> above `input_required` and a stored `blocked`; the side rail's "Waiting on" says a goal edit is owed;
> the operator's `get_task` sees `packet.awaiting`. The prefill is `goalDraftForOption` in
> `app/shared/packet-goal-draft.ts`, the ONE composition, shared by the confirm response and the reload
> path. An `edit_goal` option carries `goalDraft`, the proposed goal text itself, which both operator
> backends are told to write as a goal (deliverable plus acceptance criteria) because it is what the
> editor opens with, and which is refused on any other option kind; an option without one prefills the
> option's title and detail verbatim, and the prompts say so, so an operator never phrases them as an
> instruction to the human. Extends R20-1 (a made decision is un-re-confirmable) and F17-L3 (the editor
> prefills with the chosen deliverable).

### 139 — The controller's catalogued writes read first and refuse by name (A32-A34)

> 139. **The controller's catalogued writes read first and refuse by name (owner, 2026-09-04, pass 34
> F34-2 / G34-1).** Every `viberr_controller` write that takes a catalogued identifier (a capability id
> and mode, a stage id, a resource grant key, a model id or effort tier, a project role) validates it
> against the catalogue the runtime resolves by and refuses an unknown or impossible value BY NAME,
> listing what is valid, before anything is written. `[done]` is never answered for a write the store did
> not make: pass 34 watched `update_agent_deployment` answer `[done]` twelve times for capability ids that
> do not exist while every grant stayed off, the same class F33-8 closed for resource grants one tool
> over. The refusal covers the whole vocabulary of that call: an id outside the deployment's KIND, a mode
> the kind does not take, a non-human mode on an always-human id, a mode other than direct or off on the
> explicit-only verdict grant, a matrix-only capability that has no toggle at all (refused as such, never
> as "no such id"), and a stage the project does not declare. For every such catalogue there is a read the
> same person may call first, and the write's description names it: `list_capabilities` (any signed-in
> person) for the capability ids and, per kind, the mode an ABSENT grant actually resolves to, not the
> catalogue's create-seed default; `get_project` for a deployment's resolved grants, model, effort and
> operator autonomy, derived by the Agents page's own roster so the controller reads what the roster
> renders; `list_skills`, `list_mcp_servers`, `list_knowledge_bases` for grant keys (F33-8). Effort is
> settable wherever model is: `deploy_agent` takes `model` and `effort`, `update_agent_deployment` takes
> `effort`, and both check the tier against the backend's list at save time rather than clamping at run
> time, because a silent clamp is the same lie as a silent drop; the profile editor shares the check for a
> CHANGED value only, so a deployment that legitimately stores a preserved tier stays editable, and the
> editor stops offering a stale tier it cannot save. The refusal lives in the controller tools and the
> shared validators, not in `grantsFor`: the project editor legitimately preserves advisory and retired
> ids that a strict catalogue check would refuse. (`controller-toolkit.server.ts`, `capability-catalog.ts`
> `capabilityPatchRefusal`, `agent-profile-actions.server.ts`, `model-catalog.server.ts`
> `assertEffortForBackend`.)

### 140 — The owner seat is named at creation, seated before the first run, and every seat change is told (A35, A36)

> 140. **The owner seat can be named at creation, is seated before the first run, and every seat change is
> told to the person whose seat it is (owner, 2026-09-04, pass 34 G34-3 / U34-11).** Ruling 127 made the
> owner the credential principal and the acceptance authority; a seat that changes hands without telling
> the person is a bill and a duty they learn about from the first failure packet, which is how Omar
> learned he owned JC-15. **(a)** `createTask` takes an optional `ownerUserId`: a member who can own tasks
> (the hand-off rule of `setOwner`, contributor or above, one shared check), seated in the same `task.md`
> write that creates the task and before the operator's `create` trigger, so the first triage run already
> bills the named owner and is refused honestly when they have no credential, instead of running once on
> the creator's account. The controller's `create_task` takes `owner` (an email, or `me`; the release word
> `none` is refused by name at creation) and `dueDate` beside priority and labels; `priority: urgent` IS
> the urgent flag, because `urgent` is derived from priority and never a second input (F26-16).
> **(b)** A notification kind `ownership`, with its own routing category, reaches the new owner on a
> hand-off or a creation that names them. The row names who did it and what the seat means under ruling
> 127, opens the task page, and never enters Waiting on you; the audit row records whether the person was
> told and, when they were not, WHY (the category was silenced, or the write failed), so a silenced
> preference and a broken store never read the same. Nobody is told about their own take or release, and a
> member removal releases seats silently because the person is leaving. Because kinds are a CHECK
> constraint on `notifications`, the boot integrity check now compares that constraint against the kinds
> the code declares, so a data root that predates a new kind is reported rather than silently dropping
> every row of it. The PREVIOUS owner is told on a takeover and the released owner on an admin
> release, through the same notifier: losing the seat takes away the credential principal role, the review
> duty and the acceptance authority, so it is not a smaller fact than gaining it. (`task-actions.server.ts` `createTask` / `setOwner` / `releaseOwner` /
> `notifyOwnerSeatChange`, `notification.server.ts`, `notification-prefs.ts`, `notification-meta.ts`,
> `0001_baseline.sql`, `boot.server.ts`, `controller-toolkit.server.ts` `create_task`.)

### 141 — A scheduled operator re-run is refused while a decision packet is open (A37)

> 141. **A scheduled operator re-run is refused while a decision packet is open, and no occurrence is
> recorded as fired when no run happened (2026-09-04, pass 34 F34-8).** Ruling 76 refuses a human-pressed
> "Run operator" while a packet is open because coordination is paused and the turn is a paid no-op; the
> guard was scoped to the `manual` trigger, so the same paid no-op still ran when a person scheduled it
> for five minutes later. It is the same turn with nobody watching, so it takes the same refusal. Pass 34
> also found the second half: the schedule runner writes "Scheduled action starting" at claim time and
> stamps the occurrence `fired` for every outcome except a terminal stage, so on JC-2 the task said a run
> had started, the trigger was queued behind the drive that then opened a packet, and the refusal existed
> only in the server log. From now on a scheduled occurrence that cannot run is retired with a timeline
> note naming the reason and a final audit row (`outcome: "skipped-packet"`, `refusedAtStart: true`)
> beside the claim-time row, it spends no retry, and a trigger that is refused when it reaches the front
> of the lease queue writes the same kind of note AND retires its occurrence the same way, because the
> occurrence's identity travels with the trigger. The refusal writer settles nothing: an open packet owns
> `waiting: "human"`, and the terminal-stage refusal already settled. Machine reaction triggers
> (`pr-diverged`, `agent-reply`, `transition`, `packet-resolved`) still run with a packet open, exactly as
> ruling 17 requires. Extends ruling 76. (`runOperator`'s open-packet guard and the two lease-drain sites
> in `app/server/runtimes/operator-run.server.ts`; the finalize block in `app/server/tasks/schedule.server.ts`.)

### 142 — A run's shell carries none of Viberr's own configuration (A38)

> 142. **A run's shell carries none of Viberr's own configuration (2026-09-04, pass 34 U34-7).** Ruling 127
> built the spawn base around what a child must not learn about OTHER people's credentials. Pass 34 found
> the other half: the base still handed every child the server's own runtime settings. The JC-6 Developer
> run saw `NODE_ENV=production` and `PORT=5173`, which broke `vitest` and `next start` inside a repository
> whose tooling reads exactly those, and the agent had to unset them by hand. An agent works in the
> project's repository, not in Viberr's process, so `filteredSpawnEnv` now also strips every name the env
> schema declares (`ENV_KEYS`), which covers `NODE_ENV`, `PORT`, the data root, the OAuth client id and
> every declared `VIBERR_` knob, and keeps the list correct as the schema grows; the same base serves
> every spawned stdio MCP child. A name the schema does NOT declare still passes, which is safe precisely
> because the "no undeclared env reads" gate keeps the schema complete. Ordinary host settings (PATH,
> HOME, locale, proxies) and the image's deliberate agent-facing caches survive. The doc sentence claiming
> the runtime "never inherits its own environment" becomes true instead of aspirational. Extends ruling
> 127. (`filteredSpawnEnv` in `app/server/runtimes/runtime-registry.server.ts`.)

### 143 — An allocated branch is not a delivery (A39)

> 143. **An allocated branch is not a delivery (2026-09-04, pass 34 U34-9).** Ruling 122 moved branch
> naming to allocation time, at first dispatch, before an agent has written anything. The Insights
> traceability metric had been counting "has a branch" as delivery footprint since before that ruling, so
> its denominator quietly grew to include every task that ever engaged an agent: live in pass 34 the card
> read "7 of 8 delivered tasks carry branch + PR" while one of the eight, JC-7, had delivered nothing at
> all. The PRD's outcome is about executed tasks. The denominator is therefore tasks carrying a delivered
> revision or a recorded pull request; a delivered revision with no pull request stays in it on purpose,
> because an unpushed delivery is exactly an untraceable one. The numerator stays branch AND pull request,
> which is what makes an untraceable delivery visible. This is a consequence of ruling 122 recorded where
> a number a person reads changed. (`getInsightsSummary` in `app/server/insights/insights-query.server.ts`.)

### 144 — The `workflow` scope: optional, disclosed, and enforced where it fails (A40; owner answer Q34-15)

> 144. **The `workflow` scope stays optional, is disclosed on classic tokens, and a workflow-file push is
> refused before it reaches GitHub when the token is known to lack it (2026-09-04, pass 34 G34-2, under
> Q34-10's direction to close the gap in the fix phase; confirmed by the owner as Q34-15 on 2026-09-04; amends
> ruling 18).** Ruling 18 dropped `workflow` from the required set and promised that "a refused workflow-file
> push surfaces as a scope violation when it matters". Live (JC-6): GitHub rejected the push of
> `.github/workflows/ci.yml` with "refusing to allow a Personal Access Token to create or update workflow
> … without `workflow` scope", and the rejection reached the person only as the operator's packet 25
> minutes later; no scope violation, no chip, nothing at attach time, because git push rejections never
> went through the violation path at all. Three parts. **(a)** The validator records a classic token's
> full `x-oauth-scopes` list; the project credential card and the connection row say, as an advisory that
> never fails validation, that a classic token without `workflow` cannot push `.github/workflows/*`.
> Fine-grained tokens expose nothing to read, so they get no advisory. **(b)** Before pushing, delivery
> lists the workflow files the branch changes AS GITHUB MEASURES THEM — the ref update from the remote
> branch head, falling back to the base branch only for a first push — and refuses with a named remedy
> before GitHub is asked when the bound credential is a classic token without `workflow`; a branch whose
> workflow file already reached the remote is never refused for a push that does not touch it. **(c)** A
> push GitHub refuses for that reason, on any token kind, opens a `workflow` scope violation on the task
> (the `policy` event, the inbox notification, the credential card flag, the rail count), resolved by a
> re-check whose header now lists `workflow`, or by the next successful push of workflow files; the
> remedy names the Grant / Re-check control by name. `workflow` is still not required: a project that
> never ships CI never sees any of this. (`pat-validator.server.ts`, `pat-store.server.ts`,
> `push-workspace.server.ts`, `performDelivery` in `task-actions.server.ts`, `credential-card.tsx`,
> `connections-panel.tsx`.)

### The two owner questions, answered

- **Q34-14 (A21).** *Who may decide a delivery hand-off.* **Answered 2026-09-04: the operator may
  switch the delivering agent however it judges best**, because a human can already redirect it
  through the operator chat or agent allocation. Ruling 98(a) stands with a dated confirmation note;
  ruling 133 stays silent about hand-offs as planned; **no ruling 145 is written and the number is
  not spent.** A36's sibling branches (notifying the previous owner and an admin-released owner) are
  no longer bundled with this question: they ship under ruling 140 as a decision.
- **Q34-15 (A40).** *The `workflow` scope.* **Answered 2026-09-04: keep it optional, disclosed and
  enforced early** — exactly ruling 144's three-part mechanism (advisory at attach time, a named
  refusal before a push that changes a workflow file, a scope violation when GitHub does reject one).
  Requiring `workflow` was declined, so `DEFAULT_REQUIRED_SCOPES` is untouched and ruling 18 keeps its
  reason with a dated amendment note.

---

## Order of work

Shared helpers and schema first, then the paths that consume them. Within a step the items are
independent; across steps the later ones import the earlier ones' exports.

1. **Shared leaves and schemas (no consumers yet).** `app/shared/run-failure.ts` (A3's moved
   `RunFailureKind`), `app/shared/revision-drift.ts` (A16), `app/shared/dependencies.ts` (A8),
   `app/shared/packet-goal-draft.ts` (A30/A31), `app/shared/model-ids.ts` (B4), the task-file schema
   additions (`blockedBy` A8, `baseRefreshes` A17, `pr.headSha` + `pr.unpushedRevision` A25,
   `recommendation.forHeadSha` A29, `packet.decided` A30, `packet option.goalDraft` A31), the packet and
   PAT schema additions (A40's `headerScopes`), the baseline column and CHECK edits (A8, A36) with the
   boot-drift generalisation (A36), and `test-support/git-origin.ts` (A2). Run `npm run typecheck` here:
   every literal the new required fields touch is named by the compiler.
2. **Server leaves that others call.** `withdrawAcceptanceOffers` into `task-mutation.server.ts` (A29);
   `runEligibilityFor` / `assertResumeEligible` in `specialist-run.server.ts` (A18);
   `capabilityPatchRefusal` (A32); `assertEffortForBackend` / `assertModelForBackend` (A34);
   `requireOwnable` (A35); `notifyOwnerSeatChange` (A36); `encodeControllerInstrument` /
   `decodeControllerInstrument` (C5); `run-failure-remedy.server.ts` (A6);
   `projections/dependencies.server.ts` + `deriveReadiness` (A8); `repo-bootstrap.server.ts` (A1);
   `workspace-refresh.server.ts` (A2); `pr-adoption-record.server.ts` (B2);
   `filteredSpawnEnv` (A38); `formatDayDotTimeUTC` (C6).
3. **GitHub delivery core, in this order.** A1 (bootstrap, because A23's tests deliver into repositories
   that must have a base) → A23 (`pushWorkspaceBranch` compare, `performDelivery`, the operator
   short-circuit) → A25 (the recorded head and the acceptance gate, which A24 and A27 read) → A26
   (`update_branch_from_base`'s remote report) → A28 (the live re-confirm) → A27 (the ceremony, which
   consumes A23's `operatorRequeued` and A28's suppression hook) → A24 (the task-page control) → B1 → B2 →
   A40. A16 and A17 land beside them (A17 writes `baseRefreshes`, A16 reads it), before A29.
4. **Runtime and failure classification.** A3 → A4 → A5 → A6 → A7 → C1 (which needs A3's schema fields) →
   A38 → B4 → B3.
5. **Dependencies (one PR-sized run, in cluster order).** A8 → A9 → A11 (the shared release halves) → A10 →
   A12 → A13 → A14 → A15 (the live conversion last, after the projection ALTER).
6. **Stage eligibility.** A18 → A19 → A20 → A22, then A21 (wording plus the dated note; the owner's Q34-14 answer leaves the hand-off itself unchanged).
7. **Acceptance and packets.** A29 (needs A25's revision facts and step 2's helper) → A30 → A31 → A37.
8. **Controller and ownership.** A32 → A33 → A34 → A35 → A36 → B5 (the fingerprint the controller tool
   passes is the one A32's writer now has in hand) → C4 → C5.
9. **Remaining UI, copy and docs.** A39, C2, C3, C6 → C8 (C8 takes C6's promoted probe as its
   instrument, so it never runs first), C7, plus every `docs/` page listed on the items above, in the
   same change as the behaviour it describes.
10. **Gates, then the live pass.** `npm run lint && npm run typecheck && npm test && npm run build`,
    then `npm run e2e`, then the live validation steps in TESTPLAN.md against the jira-clone project,
    in the order that file's "Order of the live pass" section fixes. The typecheck gate is
    `npm run typecheck` and never a bare `tsc`: the script is `react-router typegen && tsc`,
    `.react-router/` is gitignored (`.gitignore:14`) while `tsconfig.json` includes
    `.react-router/types/**/*`, so without the typegen step the route types this pass changes (A9's
    intent, A10's run control, A24's push control) are checked against a stale generation.
