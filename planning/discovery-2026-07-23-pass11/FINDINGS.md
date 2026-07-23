# Pass 11 — Findings ledger (2026-07-23)

First full product pass after the Simplify rewrite (PR #84: node:sqlite, better-auth,
node:fs watchers). Data root `docker-data/` was reset 2026-07-21; demo seed re-run
2026-07-23. Subsystem docs in `docs/` (routes-ui-map, agents-operator-runtimes,
delivery-github-review, rbac-auth-org, data-model-store) — each finding cites its doc
for file:line detail.

Status: OPEN (needs fix) / VERIFY (needs live confirmation in Phase 3) /
RULING (owner decision needed) / NOTED (documented behavior, no action) / FIXED.

## Implementation status (Phase 4) — FINAL

**FIXED + tested (1446 unit/integration green, build green, many live-verified):**
R-A P11-70, R-B P11-73, R-C P11-20, R-D P11-60, P11-01, P11-02, P11-04, P11-10,
P11-11, P11-12, P11-13, P11-16, P11-21, P11-22, P11-23, P11-26 (documented),
P11-27, P11-28, P11-29, P11-30, P11-31, P11-33, P11-36, P11-40, P11-41, P11-42,
P11-43, P11-44, P11-45, P11-46, P11-47 (2 items), P11-50, P11-51, P11-52, P11-53,
P11-54, P11-55, P11-56, P11-61, P11-71, P11-72, P11-75, P11-76.
(**43 of 44 P11 findings + all 4 rulings**.)

**Live-verified:** P11-01 (arda logs in on fresh better-auth hash), P11-02 (splat
mutation endpoints 404), P11-04 (reset preserves codex auth), R-A (fresh task auto
Triage->Ready->Impl->engaged, no strand, no dup deploy - both Claude & Codex operators),
R-B (api-consultant answers a design question, not a boilerplate review), R-D (KB edit
auto-reindexes last_indexed_at), P11-50 (block reason projected), P11-71 (packet note
textarea renders), P11-41 (backend picker reflects availability).

**RULING NEEDED - surfaced to owner, deliberately not guessed:**
- P11-14: divergence detection (PR merged/closed out-of-band) runs only from the manual
  Reconcile button; PRD NFR14 wants GitHub failures surfaced ~10s from detection. Needs
  an infra decision - a lightweight poller/webhook vs staying manual. Left for the owner.

**NOT changed - documented-acceptable / owner-previously-deferred:**
- P11-17 (rate-limit + ETag plumbing parsed but unused): harmless forward-looking code.
- P11-19 (workspace gh pr view leftover): best-effort, harmless, honest comment kept.
- P11-35 (operator snapshot legacy vocab + wire-name renames): owner EXPLICITLY deferred
  in the generic-agents pass as presentational - not reopened.
- P11-47 residuals (hardcoded profileId:"operator" delete response, in-place projection
  mutation w/ guard comment, triple guard dup, colocated test, lock-chip styling, notif
  cap): lowest-value cosmetic; 2 clearest items fixed, rest left.
- P11-49 (Permissions panel): already reads roleCan for its gates - the finding overstated it.

## A. Auth & seed

| ID | Sev | Status | Summary |
|----|-----|--------|---------|
| P11-01 | HIGH | OPEN | Legacy-format password hash survives seed upsert → better-auth verifier throws → user locked out; direct splat POST returns **500**; `seed --reset` doesn't recover. Fix: seed re-hashes unparseable hashes; verify path treats parse failure as wrong-password. (Worked around manually this pass.) |
| P11-02 | MED | VERIFY | Better-auth splat exposes `/change-password` (bypasses app audit + session-kill flow) and `/update-user` (writes ba `user.name` only → split-brain vs `users.name`). Other splat paths keep BA's shared-bucket IP limiter (`/request-password-reset`, `/forget-password`); reset flow inert (no sendResetPassword) but endpoints answer. rbac doc #1/#2. |
| P11-03 | LOW | OPEN | `BETTER_AUTH_URL` required behind a proxy but never enforced/warned at boot; trustedOrigins collapses to []. rbac doc #9. |
| P11-04 | HIGH | OPEN | `seed --reset` `rmSync`s the entire `runtimes/` root (demo-seed.server.ts:151-155) to wipe run transcripts — but that root also holds runtime HOMES with credentials (`codex-home/auth.json` subscription auth, claude-home). Verified live: reset destroyed Codex auth (health flipped to `codex:"unavailable"`); restored by re-copying `~/.codex/auth.json`. Reset must scope to transcript dirs and never delete configured CODEX_HOME/claude-home contents. |

## B. Review-model integrity & delivery

| ID | Sev | Status | Summary |
|----|-----|--------|---------|
| P11-10 | HIGH | OPEN | Auto-commit at Review push happens AFTER `workRevision` was minted at run completion → PR head can postdate `workRevision.headSha`; reviewer verdicts bind to a sha that isn't what the PR delivers. Re-mint (or re-reconcile) after push-time auto-commit. delivery doc #1. |
| P11-11 | HIGH | OPEN | Push failure before PR open is only `logger.info`; flow proceeds to `openTaskPr` → can open/reuse a **stale-content PR** with no human-visible signal newest work is missing. delivery doc #9. |
| P11-12 | MED | OPEN | `grant_withheld` delivery dead-ends as "delivery may have produced no change" — mislabels a policy refusal as an empty delivery; needs a typed "withheld by capability policy" event. delivery doc #10. |
| P11-13 | MED | OPEN | `canCommitPush` fallback permissive when delivering profile can't be resolved (undeployed between run and Review) → withheld-grant workspace gets pushed anyway. delivery doc #5. |
| P11-14 | MED | RULING | Divergence detection (PR merged/closed out-of-band) runs ONLY from the manual Reconcile button — no poller/webhook. PRD NFR14 wants GitHub failures surfaced ~10s from detection. Ask owner: lightweight poll (e.g. on project.github loader + interval) vs keep manual. delivery doc #2. |
| P11-15 | MED | OPEN | Reused workspace never fetched/reset; push's `localAhead` compares against LOCAL default branch on a shallow clone (workspace reconciler uses origin+deepen, push does not) → over/under-counts; stale junk from a prior run can ride along (F15 mitigates visibility only). delivery doc #8. |
| P11-16 | LOW | OPEN | `mergeTaskPr` POSTs hardcoded `https://api.github.com/graphql`, and task-detail has a `https://github.com` host fallback under a "never hardcoded" comment; GHE branches in github-client are dead. Decide github.com-only V1 honestly and align (drop dead GHE branches or thread baseUrl everywhere). delivery doc #3, routes doc #5. |
| P11-17 | LOW | OPEN | GithubResponse rateLimit + ETag/not_modified plumbing parsed but no consumer — use or remove. delivery doc #4. |
| P11-18 | NOTE | NOTED | Acceptance `force` override exists only on the task-route accept intent, not packet/auto paths (deliberate asymmetry). delivery doc #11. |
| P11-19 | LOW | OPEN | Workspace PR detection shells the run's `gh` (pre-server-owned-delivery leftover); mostly exercises the dev machine's ambient gh auth. Harmless best-effort; either drop or scope. delivery doc #6. |

## C. Agents, operator, runtimes

| ID | Sev | Status | Summary |
|----|-----|--------|---------|
| P11-20 | HIGH | RULING | Codex delivering runs are `danger-full-access` (SDK has no denylist channel) — all capability tool-denial + MCP governance is prompt-only on Codex, and every translated MCP is `default_tools_approval_mode:"approve"`. Prior ruling (pass 9 Q2) accepted honest claude-only labels; NEW question: move Codex delivering runs to `workspace-write` sandbox (server does push/PR anyway)? agents doc #1/#20. |
| P11-21 | MED | OPEN | Operator ignores its deployment definition persona/description — `buildOperatorSystemPrompt` reads only shipped `agents/definitions/operator.md` (a mechanism REMOVED for specialists in F10-30); UI Edit-Operator modal shows generic specialist copy ("the OPERATOR reads this to pick the right agent") and an inert Description field. Align: either consume deployment persona or hide/label the fields for operator. agents doc #2, UI-verified. |
| P11-22 | MED | OPEN | `run_agent {profileId: X, delivers:true}` silently runs the CURRENT deliverer when X isn't it — should error or engage X. agents doc #12. |
| P11-23 | MED | OPEN | Mid-run agent comments audit with actor label "operator" (`OPERATOR_AUDIT_ACTOR`), agent identity only in details.actorRef → audit filtering misattributes. agents doc #18. |
| P11-24 | MED | OPEN | Resume of an undeployed profile is "conservative" in name only: denies just `gh pr merge`, no persona/MCP/envelope confinement. agents doc #10. |
| P11-25 | MED | RULING | `ask-human` (and `comment-on-task`) default to `direct` — any freshly created zero-grant profile can open decision packets; also makes askHuman a weak operator-selection signal. Ask owner: keep permissive default or flip ask-human to explicit grant? agents doc #7. |
| P11-26 | MED | OPEN | Verdict authority uses engage-time snapshot but question authority uses LIVE ask grant at completion — asymmetry undocumented; align or document. agents doc #8. |
| P11-27 | MED | OPEN | Codex operator `open_packet` can't carry authored options (flat plan schema) → canned defaults only; `retry_other_backend`/`edit_goal`/`accept_completion` options never reachable from Codex-operator reasoning. agents doc #13. |
| P11-28 | LOW | OPEN | Claude staged `report_outcome` map is process-memory (restart → prose-regex fallback); eviction insertion-order not LRU. agents doc #5. |
| P11-29 | LOW | OPEN | `comment-on-task` withhold only removes Claude mid-run post_comment; final reply always posts (both backends) — capability copy overpromises. agents doc #6. |
| P11-30 | LOW | OPEN | `RunHandle.interrupt(byUserId,byLabel)` args dropped by both adapters (decorative signature). agents doc #4. |
| P11-31 | LOW | OPEN | Vestigial `delivers` params in `effectiveCollabMode`/`resolveAgentCollab` (dead since F10-14). agents doc #9. |
| P11-32 | VERIFY | VERIFY | `AGENT_HANDLE_RE` only tints `@agent|operator|codex|claude` in plain appendComment; named mentions (@Developer) rely on commentToAgent forceToAgent — verify live mention routing for custom-named agents. agents doc #14. |
| P11-33 | LOW | OPEN | `buildAnalyzePrompt` opens "Analyze the repository…" for repo-less tasks. agents doc #15. |
| P11-34 | LOW | NOTED | `directiveRequestsDelivery` regex detection-only, misses paraphrases (mitigated by precedence prose). agents doc #16. |
| P11-35 | LOW | OPEN | Operator snapshot/toolkit legacy vocabulary (`specialist`/`reviewers`, `deployedSpecialists`) + deferred wire-name renames (assign/run-specialist → engage/run-agent) from generic-agents pass — one naming-debt cleanup. agents doc #11. |
| P11-36 | LOW | OPEN | Duplicate constants (`OPERATOR_AUDIT_ACTOR`, `readSkillBody`) across task-actions/operator-run/specialist-run. agents doc #17. |
| P11-37 | NOTE | NOTED | Completion react-step lacks idempotent replay if restart splits reconcile/react (documented residual). agents doc #19. |

## D. Routes & UI

| ID | Sev | Status | Summary |
|----|-----|--------|---------|
| P11-40 | MED | OPEN | Optimistic success toasts on 4 surfaces (mark-all-read ×2, notification routing, theme) fire before the server answers; failures leave false success. routes doc #7. |
| P11-41 | MED | OPEN | Backend pickers offer Claude/Codex regardless of credential availability (health knows) → run fails with toast instead of being prevented/labelled. routes doc #12. |
| P11-42 | MED | OPEN | Live roster renders raw `profileId` as agent name (no display name on AgentDeploymentView). routes doc #9. |
| P11-43 | MED | OPEN | Session Export link renders whenever sid exists but server 404s without on-disk transcript → downloads an error body. routes doc #8. |
| P11-44 | LOW | OPEN | UI role gates hardcode role strings (4 sites) instead of `roleCan`/ACTION_ROLES. routes doc #6. |
| P11-45 | LOW | OPEN | Board Re-scan visibility keyed to `canTransition` instead of rescan capability. routes doc #14. |
| P11-46 | LOW | OPEN | Root loader serializes unread `user` into every HTML response. routes doc #1. |
| P11-47 | LOW | OPEN | Cleanup batch: no-op goal-editor onSubmit; hardcoded `profileId:"operator"` delete response; org profile modal `["impl"]` stage default; layout loader mutates projection objects; triple guard duplication in task action; `.server.test.ts` colocated in app/routes; review-queue lock chip styled as static chip; notification caps 100/200 disagree. routes doc #2/#3/#4/#11/#16/#18/#19/#13. |
| P11-48 | NOTE | NOTED | `/resources/health` intentionally unauthenticated; `intent=login` CSRF-less by design; set-credential rotates org connection PAT by design. routes doc #10/#15/#20. |
| P11-49 | LOW | OPEN | Task-detail Permissions panel is hand-maintained prose, not rendered from ACTION_ROLES like Policy. routes doc #17. |

## E. Data model, projections, events

| ID | Sev | Status | Summary |
|----|-----|--------|---------|
| P11-50 | MED | OPEN | Review-queue read model re-reads task FILES on a loader path because workRevision/verdicts aren't projected — project a `validation_block_reason` (or revision/verdict JSON) column. data doc #10. |
| P11-51 | MED | OPEN | Stale-read (VirtioFS) repair exists only for task files; project.md read-modify-writes (members/agents/policy/task-counter) lack it. data doc #4. |
| P11-52 | LOW | OPEN | `projection.rebuilt` scope `"file"` declared, never emitted. data doc #1. |
| P11-53 | LOW | OPEN | Stale comments: policy-violations "migration 0005 seeds mock violation" (baseline removed it); task-file schema "(future) Phase-7 reconciler" (it exists); adapter/codex/run-service comments (agents doc #3); branch-sync "(mock data contract)"; org-users pre-#84 "later-phase wiring" docstrings; project-authority "better-auth membership authoritative" falsehood. One stale-comment sweep. data doc #2/#3, delivery #7, rbac #3/#4. |
| P11-54 | LOW | OPEN | `notifications.kind` CHECK vs TS union hand-mirrored (no single source). data doc #12. |
| P11-55 | LOW | OPEN | Env vars read outside env.server.ts contract (`VIBERR_CLAUDE_MAX_TURNS`, `VIBERR_CODEX_IDLE_TIMEOUT_MS`, `VIBERR_GIT_ASKPASS_*`, `LOG_LEVEL`). data doc #9. |
| P11-56 | LOW | OPEN | `cache/`, `auth/`, `logs/` data-root dirs created at boot, never used. data doc #6. |
| P11-57 | NOTE | NOTED | Dual users/user tables (Option-B bridge), legacy `specialist_json`/`reviewers_json` projection names, in-process locks single-node only, watcher ignore twins, no project.md updatedAt. data doc #5/#7/#8/#11/#13. |

## F. Org store & resources

| ID | Sev | Status | Summary |
|----|-----|--------|---------|
| P11-60 | MED | RULING | KB `refresh` cadence (`nightly`/`on change`) is stored+displayed but nothing schedules re-indexing — implement real re-scan triggers or cut the field to `manual`. rbac doc #5. |
| P11-61 | MED | OPEN | Legacy/undecryptable MCP `cred_ref` silently degrades run to no-auth (no UI/log surfacing). rbac doc #7. |

## G. Live-run findings (Phase 3)

| ID | Sev | Status | Summary |
|----|-----|--------|---------|
| P11-70 | HIGH | FIXED | (R-A) transitions re-trigger operator + stage-aware prompt; live-verified VLT-6 auto Triage→Ready→Impl→engaged, no strand, no dup deploy. Operator flow strands at Ready: an operator triage run may stop after triage→ready ("pre-work handoff scope" per its own log), but operator self-transitions don't re-trigger the operator, so nothing ever assigns a specialist — task sits `waiting: human` with NO packet/recommendation/comment explaining what's needed (dead-end UX). Same-shaped task VLT-1 got the full triage→engage flow; VLT-2 stranded. Fix direction: either chain an operator turn after its own auto-boundary transition, or make the operator prompt explicitly carry through to assignment in one run, and ALWAYS leave an actionable artifact when ending waiting:human. Evidence: VLT-2 operator run log 21:25:02. |

| P11-71 | MED | CONFIRMED | Packet options that require human input have no input channel: VLT-3's packet option read "Human confirms this is intentionally an RBAC test **and specifies expected behavior**", but resolve-packet only records the option index — no free-text field. Only `edit_goal` has a follow-up path. The operator then proceeds on the unspecified reading. Add an optional note/text field to packet resolution (or make such options route to edit_goal-style follow-ups). |
| P11-72 | LOW | CONFIRMED | Empty delivery still mints a workRevision and flips validation to "changed": VLT-3's developer made zero commits (branch tip == base, treeSha == parent tree) yet workRevision was minted and validation shows `changed`. deriveValidation could recognize an empty diff (revision.treeSha == base tree) as "none". |
| P11-73 | HIGH | CONFIRMED | @mention question does not drive a supporting agent's prompt: asked api-consultant a concrete API-design question via mention; the triggered supporting run produced a generic code review ("## Review: approve") that never addressed the question. The supporting-run review contract dominates the resumed comment. Mention-triggered runs must foreground the comment as the directive (review framing only when summoned for review). Positive: routing to the named custom profile worked; Codex read-only sandbox held (denied vite temp write); non-granted "approve" prose correctly NOT recorded as a verdict. |
| P11-74 | LOW | CONFIRMED | Board drag/reorder to another stage performs a silent bare transition: reorder intent with `to=<stage>` moved VLT-3 In Progress → Triage as a plain admin transition (allowed by RBAC), easy to trigger accidentally from the board; consider confirming cross-stage drags on active tasks (the transition comment IS written). |
| P11-75 | LOW | OPEN | Schedule lifecycle: cancelled schedule rows get `firedAt` stamped at cancel time (semantically odd); MCP probe (`mcp-test`) reports `up:1` but never fills `tools_count` (no tool enumeration in probe). |
| P11-76 | MED | OPEN | `run-operator` intent server-side hardcodes `backend ?? "claude"` — a POST without a `backend` field runs the operator on Claude even when the operator profile is configured for Codex. The auto-invoke path (create/transition) correctly uses the profile backend, so this is an inconsistency: the manual button default should be the operator's configured backend, not a literal "claude". (project.task.tsx run-operator handler.) Found while verifying UC-30. Same pattern for `autonomy ?? "supervised"`. |

## My own UI-pass observations (to fold in)

- Operator Edit modal: see P11-21. Save-footer says "Ready to save changes" before any edit.
- Seed: 0 GitHub connections / 0 MCPs is the honest-empty-slate design (NOTED).
- Demo PR numbers (#318 etc.) are fictional against the real akin-ozer/viberr repo name —
  expected mock parity, but "Open on GitHub" links 404. NOTED (demo-only).
