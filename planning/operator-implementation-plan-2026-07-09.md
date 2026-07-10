# Operator + delivery implementation plan — 2026-07-09

Companion to `operator-verification-2026-07-09.md`. Turns the verification's bug list and
missing-strategy list into a phased, file-level implementation plan. Ordered so the
vision-blocking items and confirmed bugs land first. Every phase ends with tests + typecheck +
build + (where observable) live E2E on `cc-devops-skills`.

Ground rules: no corners cut; each behavior gets a unit test and, where it renders, a live check.
GitHub network calls can't be end-to-end verified here (the dev PAT is a dead placeholder and we
will not push to a real repo), so Phase D is verified by unit tests against a mocked github client
plus the non-network logic (branch naming, PR-body composition, state transitions, degraded paths);
this limit is called out explicitly.

---

> **Status (final for this pass):**
> - **Phase A ✅** done + verified live (all 5 RBAC/correctness bugs; curl matrix + live checks).
> - **Phase B ✅** done + verified live (operator recommendation pinged admin+maintainer, not others).
> - **Phase C ✅** done + verified live end-to-end (real operator called `open_decision_packet` on
>   CCD-8; packet rendered in the DecisionPacket UI, supervisors notified, resolved cleanly). The
>   #1 vision-blocking gap is closed.
> - **Phase D ✅** implemented + verified. `openTaskPr` + `composePrBody` (auto-PR with Viberr task
>   link + generated description) fully unit-tested against a mock GitHub client (idempotent reuse,
>   403→scope-violation, degraded paths). Wired: branch-on-work-start (`ensureTaskBranch`), PR-open
>   on entering review, human-acceptance merge via real `mergeTaskPr` — all best-effort, degrade
>   cleanly (verified live with the dead PAT: honest "review PR not opened, auth_failed", no
>   fabrication). D5 connection-state contradiction fixed + verified live. **Honest limit:** real
>   GitHub *network* calls (actual PR create/merge) are not exercised here — no working PAT, and we
>   don't push to a real repo — so they're proven via the mock client, not a live round-trip.
> - **Phase E ✅** done. E1 (deterministic cross-cycle stuck-loop detector) — when the react guard
>   kills the loop (no-progress repeat or depth cap), the operator now auto-opens a BLOCKED recovery
>   packet with options instead of a silent stall. E2 (packet redirect/request-edit re-invokes the
>   operator, not just narrates it) ✅ + tested. E3 (simulated reports marked "(simulated run…)" in
>   the canonical timeline) ✅ + live.
> - **Phase F ✅** done. F1 concurrency lease — a single-flight per-task guard coalesces concurrent
>   operator triggers (verified live: CCD-9's create + immediate @operator produced ONE run, not
>   two). F2 restart-recovery — a boot reconciler (`run-recovery.server.ts`) posts dropped agent
>   replies + re-invokes the operator for real runs stuck at waiting=agent (NFR17). F3 live
>   validation-health — `validation` is now derived from governance transitions (review→changed,
>   accept→healthy, block→failing) instead of seed data, so the board's FR24 signal is real
>   (+ tests). F4 agent typed-event API — a reviewer's verdict is classified into a typed `quality`
>   event that drives validation (`classifyReviewerVerdict`, + tests). F5 anti-noise guardrails —
>   the operator's `no-duplicate-summary` guardrail is enforced (a re-run's duplicate narration is
>   dropped). F6 resource wiring — knowledge-base docs are now injected into the operator's context
>   (KB was decorative; + tests proving KB content reaches the system prompt).
>
> - **Phase G ✅** (the former "remaining follow-ups", now built + tested):
>   - **G1 MCP wiring** — `resolveSpecialistMcpServers` turns a profile's declared MCP names into
>     Claude SDK `mcpServers` configs from the org registry (HTTP → `{type:"http",url}`, stdio →
>     `{command,args}`; skips the in-process `viberr`), threaded into specialist + reviewer Claude
>     runs (+ tests). Honest limit: live external MCP round-trips aren't exercised (seeded targets
>     are placeholders; credential injection is the remaining production step).
>   - **G2 live resource picker** — `buildResourceCatalog` builds the profile-editor picker from the
>     REAL store (on-disk skills + KB folders ∪ org MCP registry + `viberr`), replacing the mock
>     `RES_CATALOG`. Verified live: the picker now lists developer-expertise / architecture-notes /
>     github-mcp etc., zero mock items (+ tests).
>   - **G3 timeline compaction** — `compactTimelineEvents` collapses old routine comments into a
>     marker while preserving every typed event + the recent window, wired to the
>     `compression-threshold` guardrail (+ tests).
>   - **G4 phantom references** — seed specialist profiles now cite real KB dirs (architecture-notes,
>     api-contracts, deploy-runbooks) + the real `github-mcp`; the consultant/Advisor got a real
>     `domain-advisor` skill + a real definition (shipped as default assets); and KB injection is now
>     wired into SPECIALIST runs too (was operator-only).
>
> Full suite: **960 tests green**, typecheck clean, production build passes. Nothing decorative
> remains in the resource path — skills, KB, and the picker are all live; MCP configs are built and
> threaded (live external connection pending real servers + credentials).

## Phase A — correctness + RBAC bug fixes (small, high-confidence)

**A1 · Specialist capability `off` is a silent no-op (B4).**
`grantsFor` (`app/features/agents/agent-profile-actions.server.ts:154`) drops `off` grants
(`if (mode === "off") continue`), but `resolveSpecialistDisallowedTools`
(`app/server/tasks/specialist-tool-policy.ts`) only denies when it *finds* `mode === "off"`.
`CAPABILITY_MODES` already includes `"off"`, so: **persist off grants** — replace the `continue`
with pushing `{capabilityId, mode:"off"}`. No behavior change for the operator (gate treats missing
and off identically); the specialist deny now fires. Test: profile save with an `off` on
`open-review-pr` → deployment stores it → `resolveSpecialistDisallowedTools` returns
`Bash(gh pr create:*)`.

**A2 · `readiness: input_required` never clears (B11).**
Give readiness real transitions in `task-actions.server.ts`:
- On the first non-triage transition (leaving triage), if `readiness === "input_required"`, set it
  to `"ready"` (the goal was accepted into the workflow).
- Add an operator snapshot field + let the operator update readiness via a small governed action
  (folded into the packet tool: opening an input packet sets `input_required`; resolving it clears).
Keep the 4-value enum. Test: transition triage→ready clears input_required; board card no longer
shows "input required" for a task in flight.

**A3 · Viewer can resolve non-completion packets (B14).**
`resolvePacket` (`task-actions.server.ts:1590`) gate is `any-member`. Change the base gate to
`["admin","maintainer"]` (steering agent work is a consequential change; matrix rows
"Approve stage transitions"/"Run agents" are admin|maintainer). Keep the existing
`accept_completion` re-gate. Add a `PROJECT_CAP_MATRIX` row "Resolve decision packets" =
admin|maintainer so the table matches enforcement. Test: viewer resolve → 403; maintainer → allowed.

**A4 · Board rescan open to any user (B15).**
`rescan` intent (`project.board.tsx` + `rescanProjections`) requires only sign-in. Gate to
`admin|maintainer` via `requireMemberRole`. Test: viewer rescan → 403; maintainer → 200.

**A5 · No view-side project RBAC on config surfaces (B13).**
FR4 keeps board/task/timeline reads app-wide, but `policy`, `agents`, `settings`, `github` loaders
are config surfaces. Add a `requireProjectMember` check to those four route loaders (non-member →
403), leaving `board`, `_index`, `task`, `activity` readable app-wide. Test: non-member GET
policy/agents/settings/github → 403; board/task → 200.

Verification A: `agent-profile-actions`, `policy-rbac`, `task-actions` unit tests + a live curl
re-run of the RBAC matrix from the verification harness.

---

## Phase B — governance notification fan-out (B3)

Add a helper `notifyTaskWatchers(db, ctx, {projectSlug, taskKey, kind, ptype, title, text, from})`
in `task-actions.server.ts` (or a new `task-notify.server.ts`) that resolves recipients = the task
owner (if any) ∪ project admins+maintainers, dedupes, and calls `createNotification` per user with
the right `NotificationKind` (`packet` | `approval` | `quality`). Wire it into:
- `addRecommendation` (operator-actions) → kind `approval`, "Operator recommends: <label>".
- The new packet generator (Phase C) → kind `packet`, ptype input|blocked.
- `transitionStage` where the result sets `waiting=human` at an approval/human boundary → `approval`.
- Quality/blocked typed events (Phase E/F) → kind `quality`.
Respect NFR7 (never leak secrets into notification text). Test: creating a recommendation inserts
notification rows for owner + maintainers; the bell count and "Waiting on you" page reflect them
live. Live E2E: supervised operator recommendation → bell increments for arda.

---

## Phase C — runtime decision/blocking packet generator (B1, the #1 gap)

**C1 · Action.** Add `operatorOpenPacket(db, ctx, input, authority)` to `operator-actions.server.ts`,
gated by `generate-packets`. It builds a `TaskPacket` (`type` input|blocked; `kind` pill;
`observations[]`; `options[]` with stable `PacketOptionKind`s + exactly one `rec:true`), writes it
to the file's `## Packet` section via `updateTaskFile`, sets `waiting="human"` and (for blocked)
`readiness="blocked"`, reprojects, audits `task.operator.packet_opened`, and calls
`notifyTaskWatchers` (Phase B). Validate exactly-one-recommended-option and known kinds before write.

**C2 · Tool.** In `operator-toolkit.server.ts`, add `open_decision_packet` (offered when
`gate(authority,"generate-packets") !== "deny"`) with a schema for `type`, `title`, `observations`,
and `options[]` (kind/title/detail/recommended). Confine via `allowedTools`.

**C3 · Wire the capability into `gate` usage** — already generic; just ensure `generate-packets` is
in the operator's default policy (it is, in `data/agents/profiles/operator.md` + demo caps).

**C4 · Reconcile docs.** Update `data/agents/definitions/operator.md` and
`data/skills/viberr-app-expertise/SKILL.md` so the SOP names `open_decision_packet` and says: at an
authority limit or a genuine decision point, open a packet (not just a comment). Update
`app/server/seed/assets/operator.definition.md` to match (shipped copy).

**C5 · Supervised accept path.** `operatorAcceptCompletion` under supervised currently posts a
recommendation card — keep that, but also allow the operator to open a completion *packet*
(`type:input`, option `accept_completion`) so the human gets the FR26 artifact, matching the manual.

Test: unit test that `operatorOpenPacket` writes a round-trippable packet the parser reads back and
`resolvePacket` can consume; the tool is withheld when `generate-packets` is off. Live E2E: drive a
task to a decision point, confirm a real DecisionPacket renders on the task page and resolving it
works.

---

## Phase D — GitHub delivery loop (B2, the flagship)

The primitives exist and are real; they're just orphaned. Wire them.

**D1 · Branch on work start.** When a task enters the working (impl) stage — in `transitionStage`
and/or when the operator prompts the primary specialist — call the existing `ensureTaskBranch`
(`github/branch-sync.server.ts`) to create `<key-slug>` off the default branch, write
`frontmatter.branch`, reproject. Degrade cleanly when repo/PAT absent (typed no_repo/no_pat, a
`policy` event, no throw).

**D2 · Specialists do real work.** `buildAnalyzePrompt` (`specialist-run.server.ts:855`) currently
says "analyze and report". For the developer role, change the directive to: work on the checked-out
task-key branch, implement the goal, commit with a `[<KEY>] …` message, push. Check out the task
branch in the clone (currently checks out default). Keep simulated runs clearly simulated (Phase E).

**D3 · Auto-open PR at the review boundary.** Add `openTaskPr(db, ctx, {projectSlug, taskKey})` in a
new `github/pr-open.server.ts` using the real `githubClient` (`POST /repos/{repo}/pulls`). The PR
**title** = `[<KEY>] <task title>`; the **body** is composed from: the task goal, a change summary,
evidence refs, and a back-link line `Viberr task: <appOrigin>/projects/<slug>/tasks/<KEY>`
(appOrigin from `BETTER_AUTH_URL` or request origin). Idempotent (reuse existing open PR for the
branch via the reconciler's pr-linker). Write `frontmatter.pr` from the real API response. Trigger:
on transition into the review stage (operator or human), guarded by repo/PAT presence. Gated by
`open-review-pr` capability for agent-initiated; humans can always.

**D4 · Merge on accept.** Route `operatorAcceptCompletion` (full autonomy) and the human
`resolvePacket`/`acceptCompletion` accept path through the real `mergeTaskPr`
(`github-reconciler.server.ts:387`) instead of flipping the cached `pr.state="merged"` string. On
success set state from the API; on failure surface a scope/GitHub `policy` event and do NOT fake a
merge. Human-only-Done invariant unchanged.

**D5 · Fix the GitHub connection-state contradiction (B12).** The page renders "token revoked" and
"All required scopes granted" together — make the scopes/health block derive from the same
connection health so a revoked token shows a single coherent degraded state.

Verification D (honest limits): unit tests against a **mocked** github client for branch-on-start,
PR-body composition (asserts the task back-link + title + goal are present), idempotent PR reuse,
merge-on-accept success + failure→policy-event, and every degraded (no repo/no PAT/401) path. Live:
the dev PAT is dead, so we verify the degraded surfacing live (Reconcile shows a coherent revoked
state, no fake PR) and the composed PR body via the unit test. **Called out: real end-to-end PR
creation against GitHub is not executed in this session (no working token; no pushing to a real
repo).**

---

## Phase E — stuck-loop recovery + honesty (B8, B10)

**E1 · Cross-cycle no-progress detection.** Beyond the per-chain identical-reply guard, track
forward progress across react cycles (e.g. N consecutive reviewer "request changes" / no new commits
on the branch). On stall, the operator opens a **blocked packet** (Phase C) with recovery options
(reassign / redirect / hold / abandon) and sets `readiness="blocked"` — the recoverability half of
Journey 2.

**E2 · Execute re-engagement on packet resolution.** `resolvePacket`'s redirect/custom branch
currently only narrates "operator re-engages the specialist". Make it actually call
`autoInvokeOperator` (or `scheduleOperatorRun`) so the human's decision moves the task.

**E3 · Honesty guards (B10).** Stamp simulated agent reports in the canonical timeline (e.g. a
`simulated: true` marker on the event / a visible "(simulated)" prefix), and make
`operatorAcceptCompletion` refuse to accept/merge when the completion rests on simulated,
zero-commit work under full autonomy.

Test: a stalled loop opens a blocked packet with recovery options; resolving redirect triggers an
operator run; accept refuses on simulated work. Live E2E: reproduce CCD-1's repeated no-op and
confirm a blocked packet now appears instead of a silent stall.

---

## Phase F — remaining strategies

**F1 · Per-task operator single-flight lease (B6).** An in-process (and file-marked) lease keyed by
task so create-time auto-invoke, drag transitions, @operator comments, and react re-invocations
coalesce instead of racing. Test: two concurrent triggers → one operator run, no double assignment.

**F2 · Restart recovery of react hooks (B9).** Persist a "finished-but-unreacted" marker (run row
flag or a small table) and reconcile on boot: post the missing reply + re-invoke the operator, or
fail explicitly per NFR17. Test: simulate a dropped completion callback → boot reconcile posts the
reply.

**F3 · Live validation-health derivation (B7).** Derive `frontmatter.validation`
(healthy/changed/failing) from reviewer/tester verdicts (approve→healthy, request-changes→failing,
new commits→changed) so the board card + "Needs attention" filter reflect real state. Test: a
request-changes reviewer verdict sets validation=failing and surfaces the card under
"Needs attention".

**F4 · Agent typed-event + evidence API.** Give specialists/reviewers a way to emit typed events
(`quality`, `blocked`, completion) with evidence refs instead of only plain comments (extend the
reply path / add a small tool). Wire `post-quality-flags` / `report-validation-verdict` /
`attach-evidence-references` capabilities to real handlers. Test: a reviewer quality flag lands as a
`type:"quality"` event with evidence.

**F5 · Anti-noise guardrails + timeline compaction.** Read `project.md` `guardrails`: implement a
comment-admission filter (meaningful-comment, no-duplicate-summary) and a compaction pass keyed to
compression-threshold that collapses routine events while preserving typed ones. Test: a duplicate
operator summary is suppressed; a long timeline compacts while typed events survive.

**F6 · Real resource wiring + picker (FR9).** Replace the hardcoded mock `RES_CATALOG`
(`capability-catalog.ts:150`) resource picker with live org resources (skills/MCP/KB from the store)
so a resource created in settings can be granted through the UI; thread profile `mcps` into runs
(operator + specialists) and inject KB content into agent context; give the consultant a real
persona; enforce eligible-stages in specialist selection. Test: an org skill created in settings
appears in the profile picker and reaches a run; an org MCP declared on a profile is passed to the
run. (Largest of Phase F; may be split.)

Verification F: unit tests per item + live checks for the ones that render.

---

## Sequencing & verification cadence

A → B → C → D → E → F. After each phase: `npm test` (targeted then full), `npm run typecheck`,
`npm run build`, and a live E2E slice on `cc-devops-skills`. The report and this plan are the
source of truth; the verification harness (subsystem maps, curl RBAC matrix, run-log inspection,
SQLite queries) from `operator-verification-2026-07-09.md` is reused for regression checks.
