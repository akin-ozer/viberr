# Pass 11 — Implementation plan

Findings in FINDINGS.md; use-case evidence in USECASES.md; subsystem code-maps in docs/.
Grouped by whether they need an owner ruling first. Severity from FINDINGS.

## Owner rulings (DECIDED 2026-07-23)

- **R-A (P11-70) — "every stage chain triggers a (queued) operator run; operator is
  stage-aware."** Every stage transition (INCLUDING the operator's own) must enqueue an
  operator run — queued via the existing lease if one is already running (owner believes
  the missing queue-on-self-transition is the root cause). A fresh operator run must know
  the active stage and do the stage-right thing (at Ready with no deliverer → assign +
  advance to Impl). Fix via operator prompt + the transition→operator trigger. Never
  strand `waiting:human` with no packet.
- **R-B (P11-73) — "agents are conversational; they decide review vs respond."** A
  mention/comment-triggered run must foreground the triggering comment as the directive.
  The agent decides whether that means review or answering a question; don't hardcode
  "produce a review". Fix via prompt.
- **R-C (P11-20) — "prompt-injection guardrails on BOTH; Codex enforces via its own
  constraints."** Do NOT change Codex to workspace-write. Add explicit capability +
  injection-resistance guardrails to BOTH backends' prompts; Codex honors its constraints
  from the prompt. Prompt-level, both runtimes.
- **R-D (P11-60) — "KBs update on each change via the file watcher, like the rest of the
  system."** No scheduler/nightly. Watch the KB store dirs and re-index on change; drop
  the decorative cadence field (or reduce to "live / on change").
- **R-E** not separately ruled; implement P11-71 (packet note channel) as a clear UX fix;
  leave P11-25 (ask-human default `direct`) as-is (defensible), revisit only if it blocks.

## Tier 1 — clear bugs, no ruling (implement + test)

- P11-01 seed re-hashes legacy password hash; verify path treats unparseable as
  wrong-password not 500.
- P11-04 `seed --reset` must not delete configured CODEX_HOME/claude-home credentials
  (scope the runtimes wipe to transcript dirs).
- P11-10 re-mint/re-reconcile `workRevision` after the Review push-time auto-commit so
  verdicts bind to the delivered sha.
- P11-11 surface a push-failure-before-PR as a typed timeline event/notification (not
  just logger.info).
- P11-12 typed "delivery withheld by capability policy" event instead of "no change".
- P11-13 don't fall back permissive on `canCommitPush` when the delivering profile
  can't be resolved.
- P11-21 operator consumes its deployment persona/desc (or the Edit-Operator modal
  hides/relabels the inert fields).
- P11-22 `run_agent {profileId,delivers:true}` errors/engages X instead of silently
  running the current deliverer.
- P11-23 mid-run agent comments audit under the agent actor ref, not "operator".
- P11-26 align verdict/question authority source (both engage-time snapshot, or
  document the asymmetry in one place).
- P11-40 four optimistic success toasts wait for the fetcher result.
- P11-41 backend pickers reflect `isBackendAvailable` (disable/annotate unconfigured).
- P11-42 live roster resolves a display name instead of raw profileId.
- P11-43 Session Export link gated on real transcript existence (loader flag) or
  server returns a friendly state.
- P11-50 project a `validation_block_reason` (or revision/verdict JSON) so review-queue
  stops reading task files on a loader path.
- P11-51 add the stale-read (VirtioFS) repair to `updateProjectFile`/`allocateTaskKey`.
- P11-71 packet resolution carries an optional note/text field for options that need it.
- P11-72 `deriveValidation`/workRevision treats an empty diff (tree == base tree) as
  "none", not "changed".
- P11-74 confirm cross-stage board drags on active tasks (or at least keep the audit).
- P11-76 `run-operator` default backend/autonomy = the operator profile's configured
  values, not literal claude/supervised.

## Tier 2 — correctness cleanups (implement + test where behavior changes)

- P11-27 Codex operator `open_packet` carries authored options (extend the plan schema).
- P11-28 persist Claude staged `report_outcome` (survive restart) or document + LRU.
- P11-29 fix `comment-on-task` capability copy/semantics.
- P11-44 UI role gates consume `roleCan`/ACTION_ROLES, not literals.
- P11-45 board Re-scan visibility keyed to the rescan capability.
- P11-49 task-detail Permissions panel rendered from the matrix.
- P11-52 remove dead `projection.rebuilt` scope `"file"`.
- P11-53 stale-comment sweep (7 sites listed in FINDINGS).
- P11-54 single-source `notifications.kind` (derive CHECK + TS from one list).
- P11-61 surface undecryptable/legacy MCP cred degradation (log + UI).
- P11-02 disable/parity the better-auth splat account-mutation paths
  (`change-password`, `update-user`) — pending R (may just disablePaths).
- P11-75 schedule `firedAt` semantics on cancel; MCP probe tool_count.

## Tier 3 — low-risk hygiene (batch)

- P11-03 boot warning when proxied without BETTER_AUTH_URL.
- P11-16/P11-17 GHE honesty (drop dead branches or thread baseUrl) + rate-limit/ETag
  use-or-remove — pending R on github.com-only.
- P11-19 drop the pre-server-delivery `gh pr view` workspace path or scope it.
- P11-30 drop decorative `interrupt(byUserId,byLabel)` args or wire them.
- P11-31 remove vestigial `delivers` params.
- P11-33 repo-less analyze prompt wording.
- P11-35 operator/toolkit vocabulary + deferred wire-name renames.
- P11-36 dedupe `OPERATOR_AUDIT_ACTOR`/`readSkillBody`.
- P11-46 stop serializing unread root `user`.
- P11-47 route cleanups batch (no-op onSubmit; hardcoded profileId:"operator";
  `["impl"]` stage default; in-place projection mutation; triple guard dup; colocated
  test file; review-queue lock chip; notification caps).
- P11-55 route stray env vars through env.server.ts.
- P11-56 remove/ document unused data-root dirs.

## NOTED (documented-intentional, no action)

P11-18, P11-34, P11-37, P11-48, P11-57, and health/CSRF-login/set-credential design facts.
