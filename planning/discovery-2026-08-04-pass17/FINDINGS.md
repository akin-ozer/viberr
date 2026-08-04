# Pass 17 — findings & implementation backlog

Authoritative backlog for the Phase-D implementation. Sources: live testing
(`LIVE-TESTING-NOTES.md`), the seven pass-17 reference docs, and the owner
rulings gathered mid-pass. Every item has a disposition; nothing is deferred.

Repo under test for the PR flow: `github.com/akin-ozer/viberr` (Viberr itself),
project **Viberr** (VIB). Non-PR experiments used the **Autonomy Lab** (AUT) project.

---

## Owner rulings (binding — gathered 2026-08-04, pass 17)

- **R17-1 — acceptance head divergence: keep "ahead", SURFACE it.** The accept
  gate may still accept a PR head that is *ahead of* (contains) the delivered/
  reviewed revision, but the accept **and** force-accept dialogs must show the
  ACTUAL merge head and a divergence warning ("N commits added since review"),
  and the refusal/subline chain must name the divergence. Honesty over blocking.
  Resolves **F17-L12**. (The current dialog pins only the delivered SHA, which
  misrepresents what merges.)
- **R17-2 — no-change success is a first-class outcome.** Add a
  "Completed — no changes" acceptance path that closes a verified no-diff task to
  **Done without a PR/merge**, recorded distinctly on the timeline, and
  operator-recommendable. Force-accept and Archive are no longer the only exits.
  Resolves **F17-L9**.
- **R17-3 — reconcile the docs canon this pass.** Promote R16-1..R16-7 (and the
  new R17-1..3) into `docs/architecture/decisions.md`; fix the four stale
  operational docs (`file-formats.md`, `deployment.md`, `runbook.md`,
  `testing.md`); make a docs-canon re-read a required closing step of the pass.
  Resolves PRODUCT-INTENT D1 + the operational-doc drift.

Prior rulings still in force: R16-1..R16-7 (see pass-16 memory), R15-x, R6-2
(owner authority), the members-only + ALWAYS_HUMAN + store-path rulings.

---

## A. Correctness / governance (implement first, with tests)

- **F17-1 (bug) operator PR-open event mis-attributed.** The "Opened PR #N for
  review." github event is written as `{kind:"human", userId: actor.userId}`
  whenever `actor.userId` is set; the operator's actor id `"operator"` is not a
  users-table id, so `createActorResolver` falls into the human branch → renders
  the actor as a human with a **"no longer a member"** guest pill.
  Files: [pr-open.server.ts:384-401](app/server/github/pr-open.server.ts),
  resolver [actor.server.ts:121-139](app/shared/mapping/actor.server.ts).
  Fix: thread a proper `FileActorRef` (operator / agent / human) into the
  PR-open timeline write instead of a bare userId; add a test that an
  operator-triggered PR-open renders as the Operator agent, no guest pill.

- **F17-L12 / R17-1 (governance) acceptance surfaces divergence.** Gate stays
  containment-based ([acceptancePrHeadMismatch](app/server/tasks/task-actions.server.ts:4780-4789)
  returns null on compare status `ahead`/`identical`). Add: a divergence
  descriptor (delivered SHA, live head SHA, commits-ahead count) computed at
  acceptance-eval time; render it in the accept dialog, the force-accept dialog,
  and the review-queue subline; keep the audit log naming the real merge head.
  Tests: an ahead head yields a divergence warning payload; an identical head
  yields none; a replaced (diverged) head still 409s unchanged.

- **F17-L9 / R17-2 (product) "Completed — no changes" acceptance.** New
  acceptance outcome for a verified zero-diff task: closes to Done with no PR,
  distinct timeline event ("Completed with no changes required"), operator can
  recommend it, and the refusal copy stops claiming "delivered work" for a
  0-diff. Gate it on: task at Review boundary, branch exists, `git diff main...head`
  empty (or no branch at all), reviewer verdict optional. Tests for the new
  path + that it does NOT merge anything.

- **F17-L5 — DISPROVEN (harness artifact, NOT a bug).** The "Complete merge"
  failure DOES surface: `completeTaskMerge` throws `AppError.conflict`, the route's
  top-level catch returns `appErrorResponse` → `{ok:false, error: userMessage}`,
  and `useActionFeedback(runFetcher)` pushes it as an error toast (kind "error").
  Verified in code ([task-detail-hooks.ts:32-38](app/features/task-detail/task-detail-hooks.ts),
  [form-action.server.ts:21](app/server/auth/form-action.server.ts)) and covered by
  the P13-D-10 error-toast test. My live "nothing appeared" was the backgrounded
  Browser-pane toast throttling documented in [[viberr-motion-and-preview-quirks]].
  No code change.

- **F17-L6 — DONE.** Conflict/mergeable pill added to the GitHub-page PR list and
  execution-branches table (`mapPrMergeable` + `mergeablePill`), surfacing the
  same "conflicts with the base branch" fact the acceptance chain already knew.
- **F17-L4 (copy) — DONE.** `decidePrAdoption`'s `not_open` refusal split into
  `merged` (its work is on the base → a fresh delivery fast-forwards, the
  collision is only the stale branch NAME) vs `closed` (the remote branch still
  holds unmerged commits → a fresh push conflicts). The two hazards now read
  apart in the collision note.
- **F17-L4 (behavior) — OWNER QUESTION, NOT changed this pass (needs a decision
  + a careful repro).** The collision that BLOCKS delivery is inconsistent by
  timing: `openTaskPr` queries `state:"open"` PRs only, so a stale MERGED/CLOSED
  PR on the branch never blocks the delivery PR-open — but `reconcileWorkspaceDelivery`
  (run from `performDelivery` after the push) and the reconciler both flag ANY
  name-matched non-adoptable PR (incl. merged) and the real block is the PUSH
  non-fast-forward against divergent remote history. VIB-1 delivered silently
  because its remote branch was force-reset to the base tip at execution start;
  VIB-3/VIB-4 hit blocked packets because their remote branches still carried the
  old PR's divergent history. So the true variable is "was the remote task branch
  reset before delivery", not sync timing per se. The safe fix (always reset/force
  the remote task branch to base at execution start, so a reused key never
  inherits foreign history) touches delivery push semantics and should be an owner
  decision — recorded here rather than guessed. See
  [pr-open.server.ts:228-259](app/server/github/pr-open.server.ts) (open-only),
  [workspace-delivery.server.ts:460-514](app/server/github/workspace-delivery.server.ts).

## B. UX / interaction

- **F17-L3 (UX) scoping-packet resolution prefills the OLD goal.** Resolving a
  "pick a concrete deliverable" packet records the decision then opens the goal
  editor with the *original* goal text, forcing the human to retype the option
  they just chose. Prefill the editor from the selected option's deliverable.

- **F17-L8 (UX) decision-packet confirm doesn't echo the selection.** The confirm
  button reads "Confirm decision", not "Confirm: Record Arda". A raced/mis-
  registered option click silently submits the operator-pick default (reproduced
  live: a Mira-Chen click was recorded as Arda). Echo the chosen option in the
  confirm control and/or require an explicit selection before enabling it.

- **F17-L2 (copy) resource "updated never".** Seeded skills read "updated never";
  reads oddly for shipped content. Use "seeded" or the real date.

- **F17-L10 (copy) force-accept misattributed as autonomous.** The policy-engine
  note for a HUMAN admin force-accept (VIB-4) says "(Autonomous acceptance can't
  merge a PR; a human completes the merge…)". The parenthetical misattributes the
  actor class. Branch the copy on autonomous vs human-override.

- **F17-L11 (copy) first-login password screen.** A freshly whitelisted local
  account sees "An admin reset your password" on first sign-in (it never had one).
  Distinguish "set your password" (first use) from "reset by an admin".

- **F17-2 (UX, pre-existing) task "Waiting on: Human decision" is vague.** After
  operator delivery the task says "Waiting on: Human decision" but no card names
  WHICH decision. Add a "what's next" hint near Waiting-on. (Low priority.)

- **UI rough edges still open (from UI-INVENTORY §0.2):** `Icon` uses innerHTML
  for 4 icon sources; the run-log stream has no disconnect story; drag-result
  live-region announcements. Address the announcement + disconnect ones; the
  innerHTML icons are internal SVG constants (low risk) — confirm and close.

## C. Docs-canon reconciliation (R17-3)

- Promote **R16-1..R16-7** and **R17-1..R17-3** into
  [docs/architecture/decisions.md](docs/architecture/decisions.md) (it currently
  ends at R15-15 / ruling 34). Keep the numbering scheme the code comments cite.
- Fix the four operational docs the audit found wrong:
  - `file-formats.md` — teaches the renamed `reviewer` role + two dropped GitHub
    scopes.
  - `deployment.md` — justifies the backup rule with a shutdown behavior that no
    longer exists.
  - `runbook.md` — names the replaced watcher + a retention rule missing its two
    exemptions.
  - `testing.md` — says e2e runs against a dev server, contradicting the ban.
- Record the two meanings of Done (R16-6): a full-autonomy accept records
  `accepted` (merge pending); ruling-7 / FR27 text that says acceptance triggers
  a real merge must be corrected.
- FR14 vocabulary: PRD still says "consultant specialists"; the app says
  engagements/delivering/supporting/required-reviewer. Re-sync or note.

## D. Code hygiene flagged by the reference-doc audit (verify, then fix)

- **AGENTS-RUNTIME:** `resolvePacket` still defaults a backend-less retry to
  Claude; `credUnreadable` is dead; `skills-lock.json` has zero product
  consumers (decide: wire or document as build-time only).
- **RBAC:** stale docblock at
  [require-project.server.ts:10-12](app/routes/project-visibility.server.ts) still
  describes the deleted `appWide` concept (E1 residue in a comment).
- **ARCHITECTURE:** `VIBERR_SECRET_ENCRYPTION_KEY_PREVIOUS` is intentionally read
  from raw env (documented) but is absent from `.env.example`; add a commented
  reference so operators can discover the rotation window. (Minor — NOT a schema
  bug.) R16-7's premise is false: `docs/contributing-quickstart.md` and
  `docs/testing-quickstart.md` DO exist — note the correction.
- **UI:** confirm the split feature files (task-detail, home, resources) have no
  dangling references; the doc already verified them.

## E. Verified-working (do NOT re-open — evidence in LIVE-TESTING-NOTES)

Operator auto-advance + role-correct specialist pick; KB grounding (PISTACHIO
canary + commit conventions); MCP mount on Claude runs (init tool list) and Codex
tool-id underscoring (`mcp__everything_http__echo`); server-owned delivery (agents
never push); stale-branch FF at execution start; merged-PR non-adoption (R16-1);
reviewer independent verdict incl. forced-failure demo; closed-PR recovery packet;
branch-collision blocked packet + resolve loop; injection guardrail + ask-human +
human-answer resume; full-autonomy self-accept → "accepted (merge pending)" →
Complete merge → merged (R16-6); Maintainer RBAC rendering; local-account
onboarding + forced first-login password; ⌘K server search (anti-finding: the
"nothing matches" was a probe race, not a bug); Lexical mention composer + menu.
