# RECONCILE — merge policy for the two pass-19 branches

- **Session A** = this worktree, branch `claude/viberr-app-inspection-4e5bf2` (partly uncommitted).
- **Session B** = `origin/pass19/product-fixes` (PR #154, settled).
- **Direction**: B merges INTO A. A's later owner rulings are law wherever the two sides answered
  the same owner question differently.
- **ID dialect rule** (from docs-canon, verified): finding IDs **≤ F19-21 are one shared ledger**;
  IDs **≥ F19-22 are per-session dialects** and must NEVER be equated by number. Ruling numbers do
  not align at all (A "R19-1" = operator clone; B "R19-1" = no-change completion; B "R19-4" =
  A "R19-1"; B additionally has letter-rulings R19-A/R19-B with no A number). Merge by mechanism,
  never by ID.

## Sequencing preconditions (do these BEFORE any conflict resolution)

1. **Commit Session A's in-flight wave.** A's rulings 63–66 canon edits (decisions.md, INTENT.md,
   both PRDs, ux-spec), the acceptance-cluster files (accept-confirm.tsx and friends), and the
   app.css gate work are uncommitted. Every verdict below assumes A's settled worktree is the A
   side; git-checkout wipes uncommitted work (pass-17 lesson). Nothing merges until A is committed.
2. **Retagging is a LAST pass.** The 58 citation-line edits (§4) are performed by the docs-canon
   resolver AFTER all code domains resolve, as mechanical edits. Code-domain resolvers keep B's
   tags verbatim while resolving; they do not renumber.
3. One resolver agent per domain, file ownership per §2 — no file has two owners. Where a file
   carries another domain's concern, the OWNER applies that domain's verdict as written in §1.

---

## 1. Per-domain resolution policy

### 1.1 acceptance-disclosure

**Ceremony architecture — A wins; B's provider dies.** A's single page-level `AcceptConfirm` with
six prop-driven `PendingAccept` modes (`accept / force / complete-merge / apply-recommendation /
packet / stage-move`) absorbs B's `AcceptDisclosureProvider` + throwing `useAcceptDisclosure()`.
The throw-if-undisclosed guarantee guarded distributed consumers that A's architecture dissolved
(every acceptance submission is lifted to the page); B is also strictly less complete — no
complete-merge ceremony (irreversible merge on a bare click), kind-only rec gating that waves
through a `transition`-to-terminal disguised acceptance (A's F19-26 `recReachesAcceptance` +
server reroute close it), and a Blocked row that always says "Bypassing". Do not keep the context,
the second dialog mount inside `OperatorRecommendations`, or B's `RecommendationsSection` (A
deleted it and left a tombstone comment — keep the tombstone). The relocated throw-guarantee is
A's server guards (`forceIrreducibleRefusal`, R19-6 hard refuse, archived 409, B's fail-closed
no-change check) plus one new A-shaped test: OperatorRecommendations has no submit path that
reaches `apply-recommendation` without the page's confirm state.

**Three B organs transplant into A's ceremony**: (1) `blockedReasonViaPacket` — B's real
correctness win; A's packet mode currently quotes the very packet the resolution clears as the
refusal. Port the affordance field and use it in packet mode. (2) `PacketArchiveConfirm` — B's
archive_task+deleteBranch dialog has no A counterpart and the one permanent delete in the product
gets the ask-first every lesser write has. Mount it locally in DecisionPacket for `archive_task`
options; A's AcceptConfirm keeps `accept_completion` options; kinds are disjoint, one ceremony
each; A's "deletes branch" pill + UX19-4 re-deliver note stay alongside. (3) The server-side
no-change live re-proof + R19-B human-approval verdict (modules owned by server-model/runtime-
github; this domain wires their affordance fields into the dialog).

**Stage-dropdown terminal move posts `transition`, not `accept-completion`.** A's wire replays the
exact server contract the control always had (transition RBAC tier, rework/manual vetting, the
`via: accept_completion` audit reached through the stage-move path); B silently re-types the
action. Rewrite B's tests asserting the `accept-completion` intent.

**Force-accept — A's R19-5 overrules B.** Force MAY skip stages; the burden is disclosure (dialog
enumerates the skipped stages by name), not withdrawal. B's `offerForceAccept` off-boundary hiding
and its tests are DELETED, not merged. The shared `!terminallyBlocked` withdrawal stays. A's
`forceIrreducibleRefusal` (closed PR unforceable, checked BEFORE the audit row and re-asserted
in-lock) has no B counterpart and wins the ordering: refuse first, audit `bypassed` only for a
bypass that happened. B's force path composes: the no-change probe is force-bypassable (it merges
nothing) with `forcedRefusal` disclosed on the event; the head gate never is.

**Board terminal-move dialog — A's F19-27 wins** (PR pill + drift + verdict + composed refusal via
the A-only `TaskSummary.atAcceptanceBoundary` projection, which must survive). B never touched
this dialog. `routes/project.task.tsx` loader ships the UNION of affordance fields: A's
`atBoundary`/`checkedAt` + B's `blockedReasonViaPacket`/`verdictSatisfiedBy`/`operatorAutonomy` +
Gap-10 quiet fields.

**B residual to finish**: `verdictSatisfiedBy` is computed but rendered nowhere in B. Wire it into
the AcceptConfirm verdict row + CurrentStatePanel, or the R19-B gate relaxation is invisible to
the human standing on it.

**Small picks**: archive-confirm.tsx `prStatePill` fix — either side, identical. Complete-merge
authority param takes A's name (`acceptanceHasAuthority`). `execution-profile.tsx` — take B's file
(EngagementVocabulary, ghost-engagement Run disable, UX19-18 popover roles, R19-A ceiling display);
verify A's F19-11 eligibility-sentence semantics survive. `review-helpers.ts` — union the
interface: A's `state: PrState` (F19-32) + B's `lastActivityAt`/`quiet`; keep B's UXV19-1
catalog-label read and A's F19-31/32 row honesty.

### 1.2 server-model

**No-change completion — COMPLEMENTARY, keep both halves under A's ruling-62 contract.** A guards
the moment the flag is SET (delivery-time mint via `resolveNoChangeBaseRevision`, gated by
push-workspace `DefaultBranchEvidence` — the dirty-tree honesty gate); B guards the moment it is
CONSUMED (`no-change-completion.server.ts`: live fail-closed `probeNothingToDeliver` at EVERY
writer to Done, `assertVerifiedNoChangeStillApplies` in-lock, one shared "Completed — no changes"
event builder, plus the verdict-time mint in `recordAgentCompletion`). Adopt B's module wholesale
and re-thread it into A's `acceptCompletion`/`resolvePacket`/`applyAcceptanceWrite`/
`operatorAcceptCompletion` bodies BY HAND (the callers are conflicted files; if A's bodies win
unedited, B's auto-merged module is silent dead code — the top hazard of this merge). Keep A's
delivery-time mint AND B's verdict-time mint (preconditions disjoint; in-lock re-checks make
double-mint impossible). Schema unification: keep B's `workRevision.kind`; A's mint stamps
`kind:"verified"`; relax B's "branch: null" docstring contract to "never a TASK branch" (A's
`branch: defaultBranch` + real treeSha is more truthful and feeds same-tree dedup); note there are
three minters now. A's refusal addendum ("run delivery once…") survives — belt and braces.

**`deriveValidation` — A's class fix wins; B's new arm must be NARROWED.** A's rebuilder computes
one derivation feeding both the `validation` column and the projected gate (never trusts the
cache); B's point recomputes at the two flag writers are harmless, keep them. B's `noChanges →
"none"` arm is WRONG under A's mint-before-approval flow (pending required verdict labeled
"nothing owed") — narrow it to the no-pending-required-verdict case per B's own comment before it
ships.

**Delivered-next-step — A's gating, B's plumbing; exactly ONE function survives.** The readers
split here: server-model found A's operator-authorized-only, humans-excluded gate recorded as an
explicit 2026-08-06 owner ruling in A's tree; runtime-github preferred B's broader scope "unless
the owner said otherwise". The owner DID say otherwise — A's gate wins. Keep B's
`recordDeliveredNextStep` body (honest system attribution "Recorded by Viberr… not the operator
agent's judgement", lock-held suppression re-check, audit `github.delivery.next_step`,
`notifyTaskWatchers` with explicit system `from` — B's notify point is real, A's card lights a
count and pushes nothing), gate it at the call site with A's condition
(`ctx.operatorAuthorized === true && autonomy !== "full"`), and fold in A's workflow-edge check
(never propose a transition the workflow doesn't declare). Delete A's `ensureDeliveredNextStep`
outright — two surviving writers are order-dependent at runtime.

**R19-6 ordering in `operatorAcceptCompletion`**: A's `completionCapabilityRefusal` hard-refuse
(no card, no audit) is the FIRST statement of the merged function; B's noChange-aware card copy
applies only inside the granted-`recommend` branch. Add A's F19-26 terminal-transition reroute
(B's `operatorTransitionStage(terminal)` files a plain transition card — the disguised acceptance).

**Same fix built twice — pick one each**: archived-move guard → B's schema helper
`archivedTaskMoveBlockedReason` (shared export next to `archivedTaskBlockedReason`), delete A's
local `archivedTaskMoveRefusal`, keep A's same-stage-rank comment. Schedule mootness → A's
superset (in-lock canonical decision + IMPLEMENTED drive-time guard `refused:"terminal-stage"` +
fire-path retirement + `CLAIM_LEASE_MS` widening), plus B's schedule-time autonomy clamp
(`c27c354`, pure win); add `archived` to A's drive-time guard (B's one paper-only residual), then
drop B's dead `scheduledRunIsMoot` + its tests.

**R19-A autonomy clamp (B-only) lands whole**: `clampAutonomy` + `auditAutonomyClamp` +
`operatorAutonomyFor` + selector/schedule honesty. Promoted as ruling 67 (§4).

**R19-B human-GitHub-approval verdict (B-only) lands whole but must be RE-GRAFTED**: B patched the
OLD `rebuilder.acceptanceBlockReason(fm)`; A refactored it to `(fm, ctx)` with closed-PR/
blocked-packet/conflicting-PR arms. B's `humanVerdictApproval` + near-miss note + `kind ===
"verified"` arms must be re-grafted into A's refactored body AND A's `verdictGateReason` in
task-actions, or queue/inbox and task page disagree (A's decisions parity test will catch a miss).
Expect deliberate A-test churn: the pinned two-way refusal sentence becomes B's three-way.

### 1.3 runtime-github

**Git stderr scrub — ONE module: B's implementation, A's rendering.** B's
`app/server/secrets/git-output-redact.server.ts` survives (token-SHAPE backstop layer,
`gitErrorText`, one choke point via `cloneFailureLogDetails`, already imported by update-branch),
ported with A's ANSI/C0 control-character stripping added. KEEP A's human-facing call sites — the
fenced "What the checkout/push reported:" timeline blocks, the ≤240-char `oneLine` delivery
reason, and the analyze-prompt quote-verbatim instruction (in B the diagnosis stops at the server
log). Delete A's `git-stderr-redact.server.ts` after retargeting its three callers
(specialist-run:2200, operator-run:826, push-workspace:638/672). Record the stderr-surfacing
reversal ONCE in canon under a fresh number (§4) — never "59", that number is taken.

**Skill strip/mount race (F19-15) — B wins outright.** Per-process random `MOUNT_MARK` makes the
strip itself surgical: both concurrent runs keep native mounts, no silent capability downgrade,
invariant lives in the one module that owns the strip, unforgeable by repo content (R18-3 intact).
Take B's `skill-mount.server.ts` wholesale; DELETE A's lease machinery in specialist-run
(`WorkspaceCatalogLease`, `liveWorkspaceCatalogLease`, `holdWorkspaceCatalog`,
`mountGrantedSkillsLeased`, `resetWorkspaceCatalogLeasesForTests`, the lease-conditional
strip-skip) and its tests — they assert the opposite of B's preservation tests. B's stated
residual (finished runs' mounts uncollected) is documented and fenced by the SDK allow-list.

**Operator repo visibility — A wins by owner ruling (FULL read-only clone).** A's
`ensureOperatorRepoCheckout` + structural `operatorDisallowedTools` denylist on BOTH backends +
`workspaceSection` prompt block, with the first-class `unavailable` arm. DROP B's
`list_repo_files`/`read_repo_file` tools, their budget plumbing, and the persona "cwd is NOT the
repository"/"ONLY view" sentences — under A's clone those sentences are false, and a second repo
surface double-answers the question the ruling settled. (This overrides docs-canon's inclination
to keep the persona sentence: runtime-github's factual point wins — the checkout IS in the
workspace.) KEEP B's orthogonal persona half: R19-2 repo-beats-KB wording (unify with A's
`KB_PRECEDENCE_NOTE` — A's single shared constant in kb-injection is the implementation; both
channels survive: injection note + B's `operatorFlagContextConflict` tool + typed
`contextConflictEvent`), and B's "look before you scope" triage instruction, retargeted at the
checkout.

**reconcileTask serializer (F19-19) — keep B's `withTaskReconcileLock`** (its
`reconcileTaskUnlocked` body also threads R19-B `pr.humanApproval` — the cheap direction), and
port A's chain-map clearing into `resetReconcileCursorsForTests` (without it the merged suite can
leak chains across tests). Delete A's `serializePerTask`.

**Pure-B keeps, with re-wiring obligations**: N19-9 update-branch family (`update-branch.server.ts`,
`update-branch-operator.server.ts`, `update-task-branch` capability, `update_branch_from_base` on
both backends) — its imports (`PUSH_TIMEOUT_MS`, `Exec`, `findWorkspaceRepoDir`,
`commitIdentityArgs`, `isNonFastForwardStderr`) exist only in B's push-workspace; the resolver
must re-create B's export carve-outs on top of A's push-workspace (which wins the
`DefaultBranchEvidence`/`stderrExcerpt` half). Run anchoring + `recordRunInputs` (single
`canonicalTaskAnchor`, anchor-before-directive, run-inputs through run-sink's redactor) — preserve
through the specialist-run conflict. `GIT_ALLOW_PROTOCOL=file` in setup-env (re-verify A's
clone-failure route assertions after). B's NOTES.md MCP-probe evidence is preserved via §4 layout,
never line-merged.

### 1.4 ux-surfaces

**`board-page.tsx` — A's architecture, B's content.** Rebuild on A's shared `StateSignals` +
D19/R19-10 roving-focus architecture (owner-ruled; B has no counterpart and its inline pill
duplication contradicts its own one-vocabulary preaching). Graft B's Gap-10 onto it: `BoardTask`
type, `QuietTag` rendered INSIDE `StateSignals` between validation and WaitTag (the archived-null
branch gives B's `!archived` guard for free), the `quiet` filter chip labeled **"No activity"**
(never "quiet" — home's project card owns that word for healthy-idle) + tally. Keep A's lock-icon
`ArchivedPill` (B's tests only `toContain("archived")` and still pass).

**Per-file verdicts**: `create-profile-modal.tsx` — take B (strict superset: locked always-human
segs, widened seedCaps, roving radio, aria-expanded/controls/pressed), keep A's two test blocks
alongside B's five. `agents-route.server.test.ts` — take A wholesale (id-resolution pin + F19-28
404; B's one line is subsumed). `capability-matrix-modal.tsx` — both inserted the same
skills-asymmetry `<li>`; keep A's paragraph (states "announced as omitted" + the second fallback
trigger B omits), optionally append B's closing advice sentence; keep A's pinning test, DELETE
B's — this is the one both-tests-cannot-survive collision. `routes/project.tsx` — B's file
(generic `annotate<T>` typing Gap-10 needs + `ArchivedBanner`/`canRestore` split) + A's
`isArchived` predicate + A's docblock. `settings-page.tsx`, `project.agents.tsx` — disjoint hunks,
keep both. `capabilities.ts` — A's fuller comment + B's `update-task-branch` rows (identical
F19-12 rename both sides).

**Gate unions**: `app.css` hunks are disjoint — both land. `app.css.test.ts` — A's ~1,280-line
gate file as base, append B's one `.obs` minmax describe. B's inline
`style={{whiteSpace:"pre-wrap"}}`-via-spread in `runs-panels.tsx` is replaced by a `.lx.pre { white-space: pre-wrap }`
rule + class toggle before A's F19-33/width gates meet it. A's R19-12 contrast sweep will baseline
B's new class pairings (QuietTag, locked segs, hand/act-policy) — expect baseline churn, not bugs.

**B-only auto-merges land whole** (notifications F19-24/F19-25 + top-bell, home/new-project member
honesty + role=alert, users-panel role=alert, command-palette "· archived" + `?profile=` deep
link, runs console RunInputs disclosure + hoist + "delivering/supporting" + picker pill label,
agents DeleteConfirm honesty, agent-deployments `operatorStatus(waiting, hasPacket)`,
resources.health probes, board-filters, e2e board-drop spec). One rule on announcements: exactly
ONE announcing mechanism per refusal slot (toast OR role=alert — B's own #20 note).

### 1.5 docs-canon

**decisions.md — A's 55–66 spine wins.** B's 55 folds into A's 62 as a dated provenance paragraph
(VC-5 live evidence + the `no-change-completion.server.ts` cite); B's 56/57 land on the same
numbers with the same answers — zero edits; B's 58 folds into A's 55 as a history note (the owner's
later answer was the full clone, explicitly rejecting the summary-view family); B's unpromoted
R19-A → **ruling 67**, R19-B → **ruling 68** (with the composes-with-20/62 sentence — R19-B binds
to a delivered revision, so it cannot fire on a no-change verification revision; neither reads as
an exception to the other). The stderr-surfacing reversal both sessions implemented is recorded
once as the next free number at merge time (69 if the in-flight wave adds nothing) pending owner
confirmation; `spec-failure-diagnostics.md`'s "use ruling 59" instruction is VOID (taken by A's
R19-5). Keep all four of B's correction edits (better-auth singular tables, N19-4 token note,
ruling-47 function renames + A's re-affirm sentence, route map).

**Other docs**: `runbook.md` — B's file as base (new CLI content), A's four-path session bullet
replaces B's (B invents a "sign out other sessions" button that exists on no tree).
`file-formats.md` — B's richer content (repo-GONE, noChanges/archived/continuity) + A's dated
N19-3 note; A's new `file-formats-sync.test.ts` gates the result (verified parser-compatible).
ux-spec — A's base (carries rulings 64/66) + B's app-added-tokens and no-spacing-scale bullets.
PRDs — disjoint sections union into BOTH mirrors pairwise (prd-sync gate), then fix B's FR27
citation "rulings 43 and 55" → "43 and 62". `copy-ban.test.ts` — A's rewritten file as base;
B's F19-12 describe is MANUALLY PORTED onto A's helpers (B calls `walk`/`stripComments` that A
replaced — a textual merge will not compile); A's `retired-vocabulary.test.tsx` also stays (three
gates, three layers). Then RE-PIN A's `ALLOWED_ASSET_LINES`/`ALLOWED_LITERALS` exact sentences
against B's rewritten `operator.definition.md`/`agent-catalog.server.ts`/seed assets. Close B's
open F19-26 owner question in the merged notes — A already answered it (audited + 60s dedup).
Re-audit DISPOSITION.md §2 after the merge (fe11c0a + A's wave close items it still calls
partial).

---

## 2. Conflict-file map (one owning domain per file)

Owners: **AD** = acceptance-disclosure, **SM** = server-model, **RG** = runtime-github,
**UX** = ux-surfaces, **DC** = docs-canon. The owner applies EVERY §1 verdict touching its file,
including other domains' (cross-refs noted).

### AD — acceptance-disclosure
| File | Resolution |
|---|---|
| `app/features/task-detail/accept-confirm.tsx` | A's rewrite wins; add `blockedReasonViaPacket` row + `verdictSatisfiedBy` rendering |
| `app/features/task-detail/task-detail-page.tsx` | A; stage-move posts `transition`; no provider |
| `app/features/task-detail/task-side-panels.tsx` | A; keep `!terminallyBlocked` only (no off-boundary hiding); Gap-10 last-activity row from B |
| `app/features/task-detail/task-side-panels.test.tsx` (B-only new) | rewrite to A's prop shape; keep Gap-10 + viaPacket assertions; drop offerForceAccept |
| `app/features/task-detail/task-main-sections.tsx` | A (RecommendationsSection stays deleted, tombstone kept) + B's UX19-10 hunk |
| `app/features/task-detail/operator-recommendations.tsx` | A's dumb panel; delete B's context wiring; shared `run_specialist` label identical |
| `app/features/task-detail/decision-packet.tsx` | A + B's `PacketArchiveConfirm` mounted for archive_task |
| `app/features/task-detail/archive-confirm.tsx` | identical fix, either side |
| `app/features/task-detail/task-detail-hooks.ts` | A base; port any B hook accept-confirm needs |
| `app/features/task-detail/execution-profile.tsx` | B's file; verify A's F19-11 sentence |
| `app/features/task-detail/task-detail-components.test.tsx` | union |
| `app/features/task-detail/task-disposition.test.tsx` | A's assertions win; delete B's R19-5-violating + stage-intent suites; keep B's other coverage |
| `app/features/review/review-helpers.ts` (+`.test.ts`) | union interface: A `state` + B quiet fields |
| `app/features/review/review-page.tsx` (+ tests) | union: A F19-31/32 + B Gap-10/UXV19-1 |
| `app/routes/project.task.tsx` | loader ships UNION of affordance fields (§1.1) |

### SM — server-model
| File | Resolution |
|---|---|
| `app/server/tasks/task-actions.server.ts` (+`.test.ts`) | THE heart: A's bodies + hand-re-threaded B organs (no-change check/event/assert, humanVerdictApproval arm, viaPacket + verdictSatisfiedBy affordance, archived guard→B's helper, dismissal timeline record, B's recompute); A's forceIrreducibleRefusal ordering; B's `recordDeliveredNextStep` body under A's call-site gate |
| `app/server/tasks/operator-actions.server.ts` (+`.test.ts`) | R19-6 hard-refuse FIRST; F19-26 reroute; B's clamp/`operatorAutonomyFor`/contextConflictEvent kept; B's repo-view impl + budgets DROPPED (RG verdict); delete `ensureDeliveredNextStep` |
| `app/server/tasks/schedule.server.ts` (+`.test.ts`) | A's superset + B's schedule-time clamp; add `archived` to drive guard; drop `scheduledRunIsMoot` |
| `app/schemas/task-file.schema.ts` (+`.test.ts`) | union fields; B's `kind` + relaxed branch contract; narrowed `deriveValidation` noChanges arm; B's humanApproval-tolerant pr |
| `app/server/projections/rebuilder.server.ts` (+`.test.ts`) | A's `(fm, ctx)` refactor; re-graft B's verified-kind + R19-B arms |
| `app/server/projections/review-queue.server.ts` (+`.test.ts`) | union: A's projections + B's quiet fields |
| `app/server/projections/task-query.server.ts`, `board-query.server.ts` | union; B's Gap-10 annotations + A's atAcceptanceBoundary threading |
| `app/server/projections/activity-feed.server.ts` | union; register B's new audit kinds (`autonomy_clamped`, `delivery.next_step`) + A's bypassed-rendering fix |
| `app/server/tasks/no-change-completion.server.ts` (+ tests, B-only) | lands whole; SM re-threads callers (dead-module hazard #1) |
| `app/server/tasks/mention-suggestions.server.ts`, `app/server/boot.server.test.ts` | minor unions |
| `acceptance-graph.server.test.ts`, `acceptance-closed-pr.server.test.ts` | A's files + retagged B cites; add R19-B composition cases |

### RG — runtime-github
| File | Resolution |
|---|---|
| `app/server/tasks/specialist-run.server.ts` (+`.test.ts`) | delete A's lease block; keep A's UX19-3 recomputes + redaction call sites (retargeted to B's module); keep B's anchor + runInputs + strip comment |
| `app/server/runtimes/operator-run.server.ts` (+`.test.ts`) | A's checkout/denylist/workspaceSection/F19-20 guard + B's `update_branch_from_base` plan tool + clamp args |
| `app/server/runtimes/skill-mount.server.ts` (+ test) | B wholesale |
| `app/server/github/push-workspace.server.ts` (+`.test.ts`) | A's DefaultBranchEvidence/stderrExcerpt/oneLine + re-created B export carve-outs + B's `push_failed{detail}` arm |
| `app/server/github/github-reconciler.server.ts` (+`.test.ts`) | B's lock + humanApproval threading + A's test-reset chain clear |
| `app/server/github/pr-linker.server.ts` | B's `deriveApprovals` |
| `app/server/github/pr-human-approval.server.ts` (+ test, B-only) | lands whole; wiring verified via SM/AD files |
| `app/server/github/update-branch.server.ts`, `update-branch-operator.server.ts` (B-only) | land whole; verify imports after push-workspace resolution |
| `app/server/tasks/operator-toolkit.server.ts` (+`.test.ts`) | keep `update_branch_from_base` + `flag_context_conflict`; DROP `list_repo_files`/`read_repo_file` |
| `app/server/tasks/git-clone-auth.server.ts` (+`.test.ts`) | B's `detail` threading; both test suites onto the unified redactor |
| `app/server/secrets/git-output-redact.server.ts` (B-only) | keep + port A's ANSI/C0 stripping |
| `app/server/tasks/git-stderr-redact.server.ts` (A-only) | DELETE after retargeting 3 callers |
| `app/shared/capabilities.ts` | A's comment + B's `update-task-branch` rows |
| `app/server/seed/agent-catalog.server.ts`, `seed/assets/developer-expertise.skill.md`, `app/server/org/org-seed.server.ts`, `app/shared/workflow/templates.ts` | union vocab fixes from BOTH sides (both retired-vocab gates must pass); persona sentences per §1.3; verify seeded grants compile against merged capability catalog |
| `test-support/setup-env.ts` (B-only) | lands whole (`GIT_ALLOW_PROTOCOL=file`) |

### UX — ux-surfaces
| File | Resolution |
|---|---|
| `app/features/board/board-page.tsx` (+`.test.tsx`) | A's StateSignals/roving architecture + B's Gap-10 graft; union test suites (A's F19-27/D19 suites untouched) |
| `app/features/board/board-filters.ts` (+ test, B-only) | lands whole; chip label "No activity" |
| `app/routes/project.tsx` (+ both new test files) | B's file + A's `isArchived` + A's docblock |
| `app/routes/project.agents.tsx` | disjoint hunks, keep both |
| `app/features/agents/capability-matrix-modal.tsx` | A's paragraph (+ optional B advice sentence) |
| `app/features/agents/agents-page.test.tsx` | union; keep only A's skills-asymmetry copy test |
| `app/features/agents/create-profile-modal.tsx` | B's file; A's tests kept |
| `app/features/agents/agents-route.server.test.ts` | A wholesale |
| `app/features/project-settings/settings-page.tsx` (+ test) | disjoint, keep both; one announcer per slot |
| `app/app.css`, `app/app.css.test.ts` | disjoint hunks/gates; union (B's `.obs` describe appended); add `.lx.pre` rule |
| `app/features/runs/runs-panels.tsx` (B-only) | lands whole EXCEPT inline pre-wrap → `.lx.pre` class |
| All other B-only UX files (§1.4 list) | land whole; verified post-merge via §3 |

### DC — docs-canon
| File | Resolution |
|---|---|
| `docs/architecture/decisions.md` | A's spine; fold/promote per §4 |
| `docs/architecture/file-formats.md` | B's content + A's note; sync test green |
| `docs/operations/runbook.md` | B base + A's session bullet |
| `docs/operations/deployment.md`, `README.md`, `.env.example`, `planning-artifacts/architecture.md` (B-only) | land whole; trim if any B CLI machinery is cut |
| `design/prd.md`, `planning/planning-artifacts/prd.md` | union both sections into both mirrors + citation fix |
| `planning/planning-artifacts/ux-design-specification.md` | A base + B's additive bullets |
| `planning/discovery-2026-08-06-pass19/*` (NOTES/INTENT/json/reference + all B session docs) | §4 layout; A's INTENT (with amendments) wins; B docs → `session-b/` |
| `app/features/copy-ban.test.ts` | A base + hand-ported B describe + allowlist re-pin |
| `app/features/retired-vocabulary.test.tsx` (A-only) | stays |
| Final retag pass (58 lines / 19 files, §4) | DC executes LAST across all owners' files |

---

## 3. Semantic-collision checklist (post-merge verification — every item must be checked off)

Both-sides-merge-clean-but-fight-at-runtime hazards. Each names its proof.

**Acceptance / server:**
1. **Dead-module hazard (TOP RISK)**: `no-change-completion.server.ts` and
   `pr-human-approval.server.ts` auto-merge; their callers are conflicted files. Verify
   `acceptanceNoChangeCheck` + `assertVerifiedNoChangeStillApplies` + `noChangeCompletionEvent`
   are called from EVERY writer to Done, and `humanVerdictApproval` from BOTH `verdictGateReason`
   and the rebuilder. Proof: B's no-change + pr-human-approval test suites green AND a grep for
   each export shows ≥1 non-test caller.
2. `deriveValidation` noChanges arm narrowed — a no-change task with a pending required verdict
   must NOT project `validation: "none"`. Add the A-flow test.
3. Exactly ONE delivered-next-step writer (`recordDeliveredNextStep` under A's gate);
   `ensureDeliveredNextStep` gone. Proof: supervised operator delivery produces ONE card, system-
   attributed, notified; human manual delivery produces none.
4. Exactly ONE archived-move guard (B's schema helper); grep `archivedTaskMoveRefusal` = 0.
5. A's mint stamps `kind:"verified"`; B's probe recognizes A-minted revisions
   (`no_branch`/`branch_empty` paths); future `kind`-keyed code sees all three minters.
6. `nextWorkRevision` now stamps `kind:"delivered"` — A's revision-shape snapshots updated
   (churn, not breakage).
7. Force path: exactly one unforceable gate (closed PR, refused BEFORE the audit row and
   in-lock); no-change probe force-bypassable with `forcedRefusal` disclosed; NO server 409 on
   off-boundary force (R19-5).
8. R19-6: capability `off`/`human` = hard refuse, zero cards, zero audit rows, before any branch.
9. F19-26 both layers: `recReachesAcceptance` client-side + server reroute; operator terminal
   transition under recommend files an acceptance-shaped card, not a plain transition.
10. Stage-dropdown terminal move posts `transition` and reaches `via: accept_completion` audit.
11. No double ceremony on recommendation Apply (one dialog, page-owned) and no double dialog on
    packet resolution (accept_completion → AcceptConfirm; archive_task → PacketArchiveConfirm;
    A's pill + UX19-4 note present beside B's dialog).
12. `verdictSatisfiedBy` RENDERED (AcceptConfirm verdict row + CurrentStatePanel).
13. `project.task.tsx` loader ships the union of affordance fields; typecheck is not proof —
    assert each field reaches its surface.
14. Schedule: drive-time guard refuses `terminal` AND `archived`; `scheduledRunIsMoot` gone;
    schedule-time clamp active; `CLAIM_LEASE_MS` widening intact.

**Runtime / GitHub:**
15. ONE redactor module; grep `git-stderr-redact` = 0; ANSI/C0 stripping present in the survivor;
    clone AND push failures reach the timeline as fenced blocks (A's rendering), and no
    un-stripped ANSI reaches an operatorSnapshot note.
16. Lease machinery fully deleted; two concurrent same-workspace runs BOTH keep native mounts
    (B's tests); no test asserts the skipped-mount fallback.
17. Operator prompt tells one story: checkout in cwd, read-only, no "ONLY view"/"not the
    repository" sentences; repo-view tools absent from toolkit AND persona; repo-beats-KB stated
    once via the shared constant + conflict-flag tool.
18. update-branch imports resolve against merged push-workspace (export carve-outs re-created)
    and the unified redactor; `updateBranchGate` absent-grant fallback vs A's R19-6 explicit-off:
    one test proving explicit `off` refuses.
19. Reconcile chain map cleared in `resetReconcileCursorsForTests` (A's two lines ported).
20. `GIT_ALLOW_PROTOCOL=file`: A's clone-failure route tests re-run; no assertion depends on real
    network stderr.
21. Seeded operator grant list compiles and seeds against the merged capability catalog
    (update-task-branch present; retired vocabulary absent).

**UX:**
22. QuietTag renders via StateSignals in BOTH board views (card + list row); chip says
    "No activity"; home's "quiet" untouched; Gap-10 server legs (task-activity, board-query,
    review-helpers) all present or the feature dropped whole — never a chip that tallies 0
    because a leg was dropped.
23. Skills-asymmetry: one paragraph (A's), one pinning test (A's); B's test gone.
24. One announcing mechanism per refusal slot (no double role=alert/toast).
25. No inline `style={{whiteSpace}}` in runs-panels — `.lx.pre` class; A's F19-33/width gates
    green over B's markup.
26. A's R19-12 contrast sweep re-baselined over B's new pairings (QuietTag, locked segs,
    hand/act-policy) — churn expected, failures investigated.
27. e2e's four pinned dialog strings (aria-label "Accept completion", task key + "Merging is
    one-way", "Not yet", `/^Accept →/`) re-verified against the RESOLVED acceptance files.
28. `roleShort` "delivering/supporting" matches the merged engagement vocabulary everywhere
    (runs picker follows task-detail, never forks).

**Docs / gates:**
29. Both vocab gates green against the WHOLE merged tree: B's F19-12 line-scan over A's additions
    AND A's F19-39 govern-lexer over B's additions (health route, runs-helpers, packet dialog
    copy) — neither has run over the other's tree yet.
30. A's `ALLOWED_ASSET_LINES`/`ALLOWED_LITERALS` re-pinned against merged seed assets; rot checks
    green.
31. prd-sync green (both mirrors identical, union applied pairwise); file-formats-sync green.
32. No live code or doc cites "ruling 58" or B-dialect "R19-1"/"R19-4" untagged (§4 grep list);
    `spec-failure-diagnostics.md`'s ruling-59 instruction voided in the session-b README.
33. Runbook has no "sign out other sessions" claim; A's four-path enumeration present.
34. B's open F19-26 owner question closed with A's answer in merged notes; DISPOSITION.md §2
    re-audited.

---

## 4. Canon plan

**decisions.md** (A's file is the spine; all merged edits below):
- Fold B's 55 → A's **62** (dated provenance paragraph: VC-5 live evidence,
  `no-change-completion.server.ts` cite). No B code cites "ruling 55" by number — zero edits.
- B's 56/57 = A's 56/57 (same numbers, same answers). Absorb B's typed-conflict-event sentence
  into 56; in 47's tail keep B's corrected function names + A's re-affirm sentence.
- Fold B's 58 → A's **55** as a history note (API-view offered, full clone ruled). Re-point B's 2
  "ruling 58" prose cites to 55.
- Promote **R19-A → ruling 67**, **R19-B → ruling 68** (tags kept — no collision with A's tags;
  68 gets the composes-with-20/62 sentence). Add "(ruling 67)"/"(ruling 68)" at the 3
  definitional docstrings (`operator-actions.server.ts:199`, `pr-human-approval.server.ts:7`,
  `github-reconciler.server.ts:407`).
- Stderr-surfacing reversal: record ONCE as the next free number (assign at merge time; 69 if
  A's tail hasn't grown), pending owner confirmation. Never "59".
- Keep B's four correction edits (better-auth tables, N19-4, ruling-47 names, route map).

**Citation-update list** (DC's final mechanical pass, 58 mandatory lines / 19 files):
- B tag `R19-1` → `R19-8` (+ spelled "ruling 62"): 45 lines in 11 app files
  (task-file.schema.ts ×8, task-file.schema.test.ts ×2, no-change-acceptance.server.test.ts ×16,
  no-change-completion.server.ts ×1 + test ×1, task-actions.server.ts ~9,
  operator-actions.server.ts ~1, rebuilder.server.ts ×1 + test ×1,
  acceptance-closed-pr.server.test.ts ×1, delivery-actionable.server.test.ts ×1)
  + 4 doc lines (file-formats.md:177,267; both PRD mirrors' FR27 "rulings 43 and 55" → "43 and
  62"). Total 49 lines / 14 files.
- B tag `R19-4` → `R19-1`, "ruling 58" → "ruling 55": 9 lines / 5 files
  (operator-toolkit.server.ts ×3 + test ×1, operator-actions.server.ts ~3,
  operator-run.server.test.ts ×1, operator-parity.server.test.ts ×1). NOTE: some of these lines
  die anyway when the repo-view tools are dropped — retag whatever survives.
- B tags `R19-2`/`R19-3` + "ruling 56"/"ruling 57" prose: zero edits.
- `R19-A`/`R19-B` (27+27 lines): zero retag; only the 3 number annotations above.

**Planning-directory layout** (no interleaving):
```
planning/discovery-2026-08-06-pass19/
  INTENT.md, audit-workflow-result.json, reference/     # shared (A's INTENT incl. amendments)
  FINDINGS.md, CAMPAIGN.md, DISPOSITION.md, NOTES.md,
  ledger-specs-*.md, runbooks/, screenshots/            # Session A's ledger (stays put)
  session-b/                                            # EVERYTHING B-authored:
    NOTES.md, USE-CASES.md, ROADMAP.md, spec-*.md (5),
    gap-analysis-result.json, ux-audit-result.json
    README.md                                           # ~15-line dialect map (below)
  reconcile/                                            # the five reader docs + this file
```
`session-b/README.md` states: (1) IDs ≤21 = shared ledger; ≥22 = B dialect (B F19-26 ≠ A F19-26,
B F19-27 ≠ A F19-27, …); (2) tag map: B "R19-1" = merged ruling 62 (tag R19-8), B "R19-4" =
merged ruling 55 (tag R19-1), R19-2/R19-3 = 56/57 unchanged, R19-A/R19-B = 67/68; (3) the
spec-failure-diagnostics "this is 59" instruction is void; (4) B's open F19-26 question is closed
by A's answer (audited + 60s dedup). One-paragraph pointer to `session-b/` at the top of A's
NOTES.md. B's NOTES carries the MCP-probe evidence (UC-14, canary MCP-CANARY-PASS19-4417) —
preserved by the move, never line-merged.

**Copy-ban union**: A's rewritten `copy-ban.test.ts` is the base (lexer scan, directory-coverage
assertion, marker-only exemptions, seed-asset allowlist + rot checks). B's F19-12 describe is
hand-ported onto A's helpers. A's `retired-vocabulary.test.tsx` stays as the artifact-layer gate.
Then re-pin `ALLOWED_ASSET_LINES`/`ALLOWED_LITERALS` against the merged seed assets, and run all
three gates over the whole merged tree (checklist #29-30).

**PRD reconciliation**: union B's MVP/FR14 vocab + FR27 third-ending amendments with A's FR5 +
R19-9 Responsiveness rewrite, applied to BOTH mirrors in one change (prd-sync); fix FR27's
citation to "rulings 43 and 62".

---

## 5. Verification plan

**Gate zero**: `tsc` (build ≠ typecheck — pass-12 lesson), then the full merged unit suite
(A's 3048 ∪ B's suite), then e2e. Canary discipline: for each headline, revert the fix in a
scratch tree and confirm its test goes red before trusting it.

**A's headline still works (acceptance-disclosure ceremony family):**
- `accept-confirm.test.tsx` (A-only) — 6-mode ceremony, Blocked-vs-Bypassing, R19-5 skip
  enumeration.
- `task-disposition.test.tsx` (merged) — A's assertions authoritative.
- `acceptance-graph.server.test.ts`, `acceptance-closed-pr.server.test.ts` — R19-5 no-409 +
  F19-25 forceIrreducibleRefusal ordering.
- `board-page.test.tsx` A's F19-27 + D19 suites; `app/features/policy/*` R19-2..4 suites.
- `e2e/01-home-board.spec.ts` (B's spec!) — pins A's dialog strings; doubles as the
  cross-session proof.

**B's headlines still work:**
- No-change (merged ruling 62): `no-change-completion.server.test.ts`,
  `no-change-acceptance.server.test.ts` (retagged), plus A's push-workspace
  `DefaultBranchEvidence` tests — BOTH halves must be green simultaneously.
- R19-B/ruling 68: `pr-human-approval.server.test.ts`, reconciler humanApproval tests, and A's
  decisions parity test (catches a missed rebuilder graft).
- F19-15: `skill-mount.server.test.ts` (B's preservation tests; A's lease tests deleted).
- N19-9: update-branch + operator plan-tool tests on both backends.
- 24-coherence: notifications/home/users-panel/command-search/runs/agent-deployments/health/
  board-filters suites (all B-only, land green or the auto-merge lied).

**B tests that MUST change because A's later rulings overruled them:**
1. **R19-5 (the big one)**: B's `task-disposition.test.tsx` "off the boundary, the GitHub panel
   offers no override" suites and `task-side-panels.test.tsx` `offerForceAccept` assertions —
   DELETED (a resolver keeping "both suites" encodes contradictory law). A's skip-enumeration
   tests stand in their place.
2. Stage-move intent: B's `accept-completion`-intent assertions → rewritten to `transition`.
3. `task-side-panels.test.tsx` — rewritten to A's prop shape (`onTransition`, no
   `onAcceptViaStage`); Gap-10 + viaPacket assertions kept.
4. R19-6: B's operator-actions tests asserting a card on `off`/`human` capability → hard-refuse
   assertions.
5. Delivered-next-step: B's `delivery-actionable.server.test.ts` re-gated to A's
   operator-authorized-only scope; attribution/audit/notify assertions kept.
6. Repo view: B's `operator-toolkit` repo-view tool tests deleted;
   `operator-parity.server.test.ts` persona assertions rewritten to the checkout story.
7. B's skills-asymmetry copy test in `agents-page.test.tsx` — dropped for A's.
8. B's `scheduledRunIsMoot` unit tests — dropped with the dead helper.
9. B's `task-file.schema.test.ts` "branch: null" contract cases — relaxed to "never a TASK
   branch"; `deriveValidation` noChanges cases updated for the narrowed arm.
10. Retag-only churn: the 49 R19-1→R19-8 lines (mostly in B's no-change tests).

**A tests that change because of B (deliberate churn, not overrules):**
- Two-way refusal sentence → B's three-way (R19-B adds a satisfier) wherever pinned.
- Revision-shape snapshots gain `kind` lines (`nextWorkRevision` stamps `kind:"delivered"`).
- A's lease tests deleted (F19-15 went B's way).
- A's clone-failure route assertions re-verified under `GIT_ALLOW_PROTOCOL=file`.
- `ALLOWED_ASSET_LINES` re-pins + R19-12 contrast baseline churn.

**Final sweep**: run the §3 checklist top to bottom as its own disposition audit (pass-16
lesson: the waves will claim done; count what you ran), then re-audit DISPOSITION.md and record
the merge outcome in canon.
