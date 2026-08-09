# Reconcile recon — cluster: acceptance-disclosure

Merge direction: Session B (`origin/pass19/product-fixes`, PR #154, SETTLED) merges INTO
Session A (this worktree, `claude/viberr-app-inspection-4e5bf2`, partly uncommitted — several
files below are still being edited by another workflow; A-side statements are advisory).

Reminder that governs everything below: **F19-nn ids collide across sessions.** In this cluster
alone: F19-21 (A: verification-only refusal copy / B: stale-noChanges live re-proof), F19-22
(A: GitHub "Synced" split / B: the stage-dropdown terminal move), F19-27 (A: board-dialog
disclosure / B: no-change validation `none`), F19-8 vs F19-38 (the same archived-move guard).
Never merge by finding id; merge by mechanism.

---

## 1. What Session B built (file by file, load-bearing mechanisms)

### `app/features/task-detail/accept-confirm.tsx` — the AcceptDisclosure seam
- `interface AcceptDisclosure { task, workRevisionSha, noChanges, defaultBranch }` — the page
  assembles this ONCE (`task-detail-page.tsx:264`) and every acceptance surface states these
  same facts.
- `AcceptDisclosureProvider` (React context) publishes `{ disclosure, blockedReason }`;
  **`useAcceptDisclosure()` THROWS at render** when a consumer sits outside the provider —
  the "throw-if-undisclosed" guarantee. Sole consumer today: `OperatorRecommendations`.
- `AcceptConfirm` props: `disclosure`, `force?`, `via?` (union: `recommendation | decision |
  stage`, naming the clicked control), `blockedReason`. Rows: Merges (canonical `prStatePill`,
  B's F19-14), via-row, Revision, Merge head (R17-1 drift), Verdict, and a blockedReason row
  whose key is **always "Bypassing"** — including on packet/stage modes that cannot bypass
  anything (A fixed exactly this with `force ? "Bypassing" : "Blocked"`).

### `app/features/task-detail/task-detail-page.tsx`
- `PendingAccept = accept | force | stage | packet{optionIndex,note,title}` (4 kinds).
- `{kind:"stage"}` comes from `CurrentStatePanel.onAcceptViaStage` and on confirm posts
  **intent `accept-completion`** — NOT `transition`. (A posts `transition` and lets the
  server's own `transitionStage → acceptCompletion` contract fire; see §2.)
- packet mode passes `acceptance.blockedReasonViaPacket` (see below) — B's genuinely better
  idea in this file.
- `onCompleteMerge` is handed to `GithubTrace` **directly — B has NO complete-merge ceremony**;
  the "Complete merge" button performs the irreversible GitHub merge on a bare click (A's
  F19-24 mode has no B counterpart).
- Provider wraps ONLY `<RecommendationsSection>`.

### `app/features/task-detail/operator-recommendations.tsx`
- Panel keeps its own pendingAccept state and mounts a SECOND `<AcceptConfirm>` inside itself,
  reading facts from `useAcceptDisclosure()`. Ceremony gate is **`rec.kind ===
  "accept_completion"` only** — a `transition` recommendation targeting the terminal stage
  applies in ONE un-ceremonied click (the exact hole A live-proved and closed as F19-26 with
  `recReachesAcceptance`, plus a server-side reroute).

### `app/features/task-detail/task-main-sections.tsx`
- Keeps `RecommendationsSection` (own fetcher, submits `apply-recommendation` directly).
  A **deleted** this component and left a do-not-re-add warning comment in its place.

### `app/features/task-detail/task-side-panels.tsx`
- `GithubTrace` now takes the `acceptance` affordance (same UX19-2 unification A made) but
  adds `offerForceAccept = acceptance.atBoundary && !acceptance.terminallyBlocked` — the
  force-accept button is **hidden off-boundary**. **OVERRULED by A's R19-5** (force MAY skip
  stages; the burden is disclosure, not withdrawal). The `!terminallyBlocked` half agrees
  with A and stays.
- `CurrentStatePanel` keeps the transition fetcher LOCAL and intercepts the terminal pick via
  `onAcceptViaStage` (B's F19-22 — the same sixth writer A closed as F19-37).
- Gap-10: "Last activity" row (`task.lastActivityAt`, timeline `occurred_at`, never
  `updatedAt`) + quiet hint.

### `app/features/task-detail/decision-packet.tsx`
- **UX19-9 `PacketArchiveConfirm`** — a local dialog interposed on `archive_task` packet
  options: names the option, the remote branch `deleteBranch` permanently deletes, what the
  archive withdraws, "Archive & delete <branch>" danger button. Deliberately NOT a second
  AcceptDisclosureProvider (ruling 17 gives branch deletion exactly one surface). **A has no
  dialog here** — only a "deletes branch" pill on the option (plus A's UX19-4 re-deliver
  note). B's ceremony is the stronger design for the one permanent delete in the product.

### `app/features/task-detail/archive-confirm.tsx`
- Same one-line fix as A (raw `task.pr.state` → `prStatePill`); trivial conflict, either side.

### `app/server/tasks/task-actions.server.ts` (+538 over main)
- `AcceptanceAffordance` grows **`blockedReasonViaPacket`** (refusal recomputed with
  `blockedPacket:false` — what a packet resolution would actually hit, since resolving IS
  what clears the packet) and **`verdictSatisfiedBy`** (R19-B sentence).
- **R19-B (B-only owner ruling): a project member's GitHub approval on the PR IS the
  approving verdict.** `verdictGateReason` gains a `humanVerdictApproval(fm)` arm plus a
  fail-closed near-miss note (unlinked handle / non-member / older commit). Also admits
  `fm.workRevision.kind === "verified"`.
- **R19-1 live no-change re-proof**: `acceptCompletion` and `applyAcceptanceWrite` thread an
  `acceptanceNoChangeCheck` (live remote read; fails CLOSED on unreachable remote; force may
  bypass it — it merges nothing — but never the head gate); `assertVerifiedNoChangeStillApplies`
  re-asserts under the write lock; dedicated `noChangeCompletionEvent`.
- `forceAcceptCompletion`: audits `bypassed` THEN calls `acceptCompletion(force)`. **No
  off-boundary 409 anywhere** (force bypasses the whole `acceptanceRefusalReason`, stage gate
  included) — B's restriction is UI-only. But B force also bypasses the closed-PR terminal
  fact with **no server-side guard** (client-side `terminallyBlocked` hiding only) — A's
  `forceIrreducibleRefusal` (checked BEFORE the audit row and again inside the write lock) has
  no B counterpart and must win.
- F19-8 (B's id): `archivedTaskMoveBlockedReason` — archived tasks refuse `transitionStage`
  AND `reorderTask` with 409; helper exported from `task-file.schema.ts`.

### `app/server/tasks/operator-actions.server.ts` (+860)
- `operatorAcceptCompletion`: shared `acceptanceRefusalFor` gate before both branches;
  recommend-branch card copy is **noChange-aware** (never promises a merge on a PR-less task);
  full-autonomy branch runs the R19-1 live no-change check and writes through
  `applyAcceptanceWrite`. **No R19-6**: `off`/`human` capability falls into the recommend
  branch and files a real card + audit row — exactly what A's owner ruling forbids. **No
  F19-26 reroute**: `operatorTransitionStage(terminal)` under `recommend` files a plain
  `transition` card to Done.
- R19-A autonomy ceiling (`clampAutonomy`, `OperatorAutonomy`) threads `operatorAutonomy`
  through the task page/pickers — outside this cluster but it rides in the same conflicted
  files.

### Board / review (acceptance-adjacent)
- `board-page.tsx`: B's changes are F19-8 archived-inert cards (inline conditionals ×2 views),
  F19-13/UXV19-6 list-row pills (inline ×2), Gap-10 `QuietTag` + "No activity" filter +
  `BoardTask` type. **B's `AcceptOnBoardConfirm` is main's unchanged generic dialog** (no PR
  pill, no drift, no refusal row).
- `review-queue.server.ts` / `review-helpers.ts` / `review-page.tsx`: Gap-10 quiet fields on
  rows; UXV19-1 capability label read from the shared catalog (`capabilityById(
  "completion-for-acceptance")`) instead of the retired hardcoded string.

---

## 2. Same concern, two mechanisms — verdicts

| Concern | Session A | Session B | Winner + why |
|---|---|---|---|
| Ceremony architecture | ONE page-level `AcceptConfirm`, prop-driven; `PendingAccept` with **6 modes** (`accept/force/complete-merge/apply-recommendation/packet/stage-move`); all fetchers lifted to the page | Context provider + throwing hook; **two dialog mounts** (page + inside the rec panel); 4 kinds, no complete-merge | **A.** Single shared implementation, fewer moving parts, covers two writers B leaves bare (complete-merge, transition-rec-to-terminal). See §6 for what to salvage from B. |
| Recommendation Apply gating | `recReachesAcceptance` — gates on the rec's **TARGET** (kind `accept_completion` OR `transition` → terminal) | `kind === "accept_completion"` only | **A.** B's gate misses the disguised acceptance ("Move the task to Done" card) at BOTH layers — A closed it client-side and server-side (F19-26 reroute). |
| Stage-dropdown terminal move | Confirm, then post **`transition`** — server's own `transitionStage → acceptCompletion` contract, manual-move authority checks intact | Confirm, then post **`accept-completion`** | **A.** Same disclosure either way, but A replays the exact server contract the control always had (transition RBAC tier, rework/manual vetting, `via: accept_completion` audit reached through the stage-move path); B silently re-types the action. |
| Force-accept off-boundary | Offered, labeled "skips the remaining stages and the review gate"; dialog enumerates the skipped stages by name (R19-5); server never 409s the graph under force | Button **hidden** off-boundary (`offerForceAccept = atBoundary && …`); server identical (no 409) | **A — by owner ruling R19-5.** B's UI withdrawal (and its tests, §5) are overruled. Keep the shared `!terminallyBlocked` withdrawal. |
| Force vs closed PR (R16-3) | `forceIrreducibleRefusal` — server 409 BEFORE the audit row, re-asserted inside the write lock | Client-side hiding only (`terminallyBlocked`) | **A.** Throws loudly server-side; B's guard is decoration against a crafted POST or stale client. |
| Packet-mode blocked reason | Passes generic `acceptance.blockedReason` | **`blockedReasonViaPacket`** (recomputed with `blockedPacket:false`) | **B.** A's generic reason can quote the very packet the resolution clears as a "Blocked" refusal the server will not apply. Port B's affordance field into A's dialog wiring. |
| Blocked-row honesty in dialog | `force ? "Bypassing" : "Blocked"` | Always "Bypassing" | **A.** B promises an override non-force clicks don't have. |
| No-change completion (shared ruling R19-1/55) | Delivery-time verification only (`verifiedNoChange` at delivery, `fm.noChanges` trusted at acceptance) + refusal-copy pointer "run delivery once" | `workRevision.kind: "verified"` minted at verdict time; **live `acceptanceNoChangeCheck` at every Done writer, fails closed, re-asserted in-lock**; `deriveValidation → "none"` for noChanges; verification-only tasks reach acceptance through the ordinary reviewer path | **B.** Deeper and throws loudly: a stale `noChanges` flag can never close a task whose branch gained commits; A's copy fix is compatible and can ride along. Adopt B's `no-change-completion.server.ts` + schema `kind` + the threading in acceptCompletion/applyAcceptanceWrite/operatorAcceptCompletion. |
| Human GitHub approval as verdict (R19-B) | absent | `pr-human-approval.server.ts` + verdict-gate arm + `verdictSatisfiedBy` | **B (only design).** Owner-ruled on B's side, consistent with the shared-owner pattern. NOTE: B computes `verdictSatisfiedBy` and its docstring demands rendering, but **no B surface renders it** — a residual to finish post-merge. |
| Archived task can't move | `archivedTaskMoveRefusal` local to task-actions (F19-38) | `archivedTaskMoveBlockedReason` exported from `task-file.schema.ts` (F19-8) | **B's placement** (shared schema helper next to `archivedTaskBlockedReason`, one home), A's coverage identical. Trivial pick — keep exactly one. |
| Board terminal-move dialog | F19-27: PR pill + drift + verdict + composed refusal via new `TaskSummary.atAcceptanceBoundary` projection; from-stage named | main's generic two-sentence dialog | **A.** Ruling-42 disclosure on the surface that merges; B never touched it. A's `atAcceptanceBoundary` projection (`shared/mapping/task.server.ts`, A-only) must survive the merge. |
| Archived board cards / list-row pills (F19-8/F19-13) | Shared `StateSignals` + `ArchivedPill` components rendered by card AND list row | Same behavior, inlined twice (card + row), plus Gap-10 quiet pill inline | **A structurally** (one implementation, two views — B's own rulings 12/14 argue for it). Re-host B's `QuietTag` INSIDE A's `StateSignals` (B's ordering doc: PR → checks → review → validation → quiet → wait). |
| GithubTrace blocked-reason source (both call it UX19-2) | `acceptance.blockedReason` (+ terminal withdrawal) | identical idea | Equivalent — merge is copy-level. |
| Complete-merge authority (both call it F19-10) | `acceptanceHasAuthority` param | `mergeAuthority` param | Identical fix, different name. Pick A's name (its call site also routes through the ceremony). |
| review row PR-state | F19-32: canonical `PrState` through projection + row; waiting `none` honesty (F19-31) | Gap-10 quiet fields; UXV19-1 catalog label | Disjoint — union both. |
| archive_task packet resolution | warning pill on the option | **`PacketArchiveConfirm` dialog** | **B.** The one permanent delete in the product gets the same ask-first every lesser write now has. Mount B's dialog inside A's DecisionPacket (A's page already interposes on `accept_completion`; B's archive dialog stays local to the card — the two interpositions compose, one option kind each). A's UX19-4 re-deliver note is orthogonal and stays. |

---

## 3. Pure Session-B additions (auto-merge) — and their risks

- **`app/server/tasks/no-change-completion.server.ts`** (+ `no-change-completion.server.test.ts`,
  `no-change-acceptance.server.test.ts`, `spec-no-change-acceptance.md`). RISK: its callers all
  live in CONFLICTED files (`task-actions`, `operator-actions`, `specialist-run`?). If the
  resolver keeps A's function bodies, this module lands as **silent dead code** and R19-1's
  fail-closed guarantee vanishes without a test failing on A's side. The threading must be
  re-applied by hand.
- **`app/server/github/pr-human-approval.server.ts`** (+ test). Same trap, worse: the verdict-
  gate arm lives in conflicted `task-actions.server.ts`, and the approval itself is RECORDED by
  the conflicted `github-reconciler.server.ts` (B writes `pr.humanApproval` into the cache).
  Dropping either half leaves the other silently inert.
- **`app/server/projections/task-activity.server.ts`** (+ test) — Gap-10 quiet detector.
  Standalone; safe. Its consumers (board-query, review-queue, task-query, board/review pages)
  are conflicted — quiet annotations must be re-threaded.
- **`app/features/task-detail/task-side-panels.test.tsx`** — B-only NEW test file that
  auto-merges but (a) hand-builds `AcceptanceAffordance` literals with
  `blockedReasonViaPacket` and (b) renders `CurrentStatePanel` with B's prop shape
  (`onAcceptViaStage`, no `onTransition`). Breaks loudly at typecheck against A's tree —
  must be rewritten to A's signatures, keeping its Gap-10 assertions.
- **`app/features/task-detail/execution-profile-label.test.ts`** — autonomy labels; fine.
- B docs/e2e (`ROADMAP`, use-case registers, e2e board-confirm pin) — safe.
- A-only new files the merge must not lose: `accept-confirm.test.tsx`,
  `acceptance-graph.server.test.ts`, `acceptance-closed-pr.server.test.ts`,
  `continuity-recovery.tsx(+test)`.

## 4. Files in this cluster that WILL conflict textually (both sides touched vs main)

`app/features/task-detail/`: **accept-confirm.tsx** (total rewrite both sides — the heart of
the merge), task-detail-page.tsx, task-side-panels.tsx, task-main-sections.tsx,
operator-recommendations.tsx, decision-packet.tsx, archive-confirm.tsx, task-detail-hooks.ts,
execution-profile.tsx, task-detail-components.test.tsx, **task-disposition.test.tsx** (B +1062
lines asserting B's architecture vs A's assertions — heaviest test conflict).
`app/features/board/`: board-page.tsx, board-page.test.tsx.
`app/features/review/`: review-helpers.ts, review-page.tsx, review-page.test.tsx,
review-route.server.test.ts (+ A-only review-helpers.test.ts churn on B side).
Server: **app/server/tasks/task-actions.server.ts** (A +392/−183 vs B +538 — the second heart),
operator-actions.server.ts (+ tests), app/schemas/task-file.schema.ts (+ test),
app/server/projections/review-queue.server.ts (+ test), board-query.server.ts,
app/server/github/github-reconciler.server.ts, app/routes/project.task.tsx (loader must ship
the UNION of affordance fields: A's `atBoundary`/`checkedAt` + B's `blockedReasonViaPacket`/
`verdictSatisfiedBy`/`operatorAutonomy`/quiet fields), app/routes/project.tsx.
Note: task-detail-page.tsx, task-main-sections.tsx, operator-recommendations.tsx,
board-page.tsx carry UNCOMMITTED A-side edits right now.

## 5. Semantic collisions that will NOT conflict textually

1. **B's off-boundary force-accept tests vs R19-5.** `task-disposition.test.tsx` ("off the
   boundary, the GitHub panel offers no override") and the `offerForceAccept` logic assert the
   behavior A's owner explicitly reverted. The file conflicts, but a resolver keeping "both
   test suites" would encode contradictory law. B's off-boundary-withdrawal tests must be
   DELETED, not merged; A's skip-enumeration tests stand.
2. **Stage-move wire intent.** B tests assert the confirmed stage move posts
   `accept-completion`; A tests assert `transition`. Opposite assertions on the same click —
   pick A's (see §2) and rewrite B's.
3. **Dead-module hazard** (§3): keeping A's `acceptCompletion` body verbatim silently disarms
   B's auto-merged `no-change-completion` + `pr-human-approval` modules — no conflict marker
   will point at it. The resolver must consciously re-thread `acceptanceNoChangeCheck`,
   `noChangeCompletionEvent`, `assertVerifiedNoChangeStillApplies`, and the
   `humanVerdictApproval` verdict arm into A's bodies (they compose cleanly with A's
   `forceIrreducibleRefusal`; B already ordered force-bypasses correctly: noChange bypassable,
   head check never).
4. **R19-6 vs B's recommend fallback.** B's `operatorAcceptCompletion` files a card when
   `completion-for-acceptance` is `off`/`human`. A's `completionCapabilityRefusal` (hard
   refuse, no card, no audit) must be the FIRST statement of the merged function; B's
   noChange-aware card copy then applies only to the granted-`recommend` branch.
5. **Double-ceremony risk on Apply.** If the resolver keeps B's context-consuming
   `OperatorRecommendations` AND A's page-level `onApplyRec` routing, an `accept_completion`
   Apply opens TWO dialogs in sequence. Keep A's dumb panel; delete B's context wiring, throw
   included (see §6).
6. **Gap-10 quiet vs A's StateSignals.** B's QuietTag threading (board-query → BoardTask →
   card+row) merges into files A restructured; naive resolution renders quiet in one view and
   not the other — the exact one-vocabulary defect both passes spent findings on. Re-host in
   `StateSignals` once.
7. **`verdictSatisfiedBy` computed-never-rendered** (B residual): after merge, wire it into
   the acceptance surfaces (AcceptConfirm verdict row + CurrentStatePanel) or the R19-B gate
   relaxation is invisible to the human standing on it.
8. **Audit-order nuance:** B's `forceAcceptCompletion` records the `task.acceptance.forced`
   row before any irreducible check exists; A refuses first so the log never claims a bypass
   that was denied. Keep A's ordering when unifying (F19-25).

## 6. The direct question: can B's throwing AcceptDisclosure seam carry A's R19-5 semantics, or should A's ceremony absorb B's throw-if-undisclosed guarantee?

**A's ceremony absorbs B — with three B organs transplanted, not the seam itself.**

B's context COULD carry R19-5 (add `atBoundary` + stages to the context value), but the seam
exists to solve a problem A dissolved: B pushes facts DOWN to surfaces that kept their own
fetchers; A lifted every acceptance submission UP to the page, so there are no distributed
consumers left to protect, and the throwing hook would guard an architecture the merged tree
no longer has. A's shape is also strictly more complete where it counts: 6 ceremony modes vs
4 (B's "Complete merge" merges on a bare click; B's kind-only rec gate waves through the
disguised `transition`-to-terminal acceptance), R19-5 skip enumeration, honest
Blocked-vs-Bypassing, and the server-side irreducible-refusal backstop that makes UI
withdrawal mere decoration. On every tiebreaker (later owner rulings, one shared
implementation, throws-loudly, fewer parts) A's ceremony wins.

Absorb from B:
1. **`blockedReasonViaPacket`** into `AcceptanceAffordance` + A's packet mode (B's correctness
   win; A currently shows a refusal the server won't apply).
2. **The throw-if-undisclosed guarantee, relocated where it still bites**: not a render-time
   context throw but the merged tree's existing equivalents — A's server guards
   (`forceIrreducibleRefusal`, R19-6 hard refuse, F19-38/F19-8 archived 409, B's fail-closed
   `acceptanceNoChangeCheck`) all throw `AppError.conflict` past any silent UI. If a
   render-time regression gate is still wanted, keep A's task-main-sections tombstone comment
   AND add one A-shaped test: "OperatorRecommendations receives no submit callback that can
   reach `apply-recommendation` without the page's confirm state" — cheaper than reviving the
   provider for one consumer.
3. **B's disclosure-assembly discipline** is already A's (`workRevisionSha`/`noChanges`/
   `defaultBranch` assembled once on the page); no port needed — just don't let the merged
   dialog grow per-mode fact derivation.

Also transplant (server, orthogonal to the seam): B's no-change live re-proof, R19-B
human-approval verdict, noChange-aware operator card copy, `PacketArchiveConfirm`, Gap-10 —
per §2/§3.
