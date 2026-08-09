# Reconcile recon — cluster: runtime-github

Session A = this worktree (branch `claude/viberr-app-inspection-4e5bf2`, partly uncommitted).
Session B = `origin/pass19/product-fixes` (PR #154, settled — read via `git show`, never checked out).

**ID convergence fact (verified for THIS cluster, against the global "never assume" rule):** the two
sessions independently assigned the SAME F19-nn to the same defect for F19-1 (delivered-next-step gap),
F19-6 (clone stderr suppressed), F19-12 (assign-primary-specialist label), F19-15 (skill strip vs live
mount race), F19-18 (push stderr suppressed), F19-19 (unserialized reconcileTask). Ruling numbers do NOT
line up: A's code cites "R19-1" for the operator repo view; B's code cites "R19-4" (ruling 58) for the
same owner answer. B additionally uses letter-rulings "R19-A" (autonomy clamp audit) and "R19-B" (human
GitHub approval is a verdict) that have no Session-A number.

---

## 1. What Session B built, file by file

### app/server/secrets/git-output-redact.server.ts (+ test) — NEW
`redactGitOutput(text, {token})` — three layers, strongest first: (1) exact project credential scrubbed
BY VALUE via `split/join` (no regex-escaping hazard), (2) URL userinfo `scheme://user:secret@host`,
(3) known token SHAPES (`gh[pousr]_…`, `github_pat_…`, `sk-…`, length-floored, deliberately not
entropy-based). Then a tail clamp: last 8 lines / 600 chars (bare `\r` counts as a line so clone
progress doesn't eat the clamp), because git states its verdict last. Returns `""` when empty.
Also `gitErrorText(error)` — stderr if present, else message. Docstring notes `createLineRedactor`
(run-sink) keeps an identical shape list and should import this one. **Gap: no ANSI/C0 control-character
stripping** (Session A's module has it).

### app/server/tasks/git-clone-auth.server.ts — modified
`cloneFailureLogDetails(error, {token})` now carries `detail?: string` (git's own words, scrubbed via
`redactGitOutput`) instead of dropping stderr wholesale. The premise both sessions independently proved:
the PAT travels ONLY through the `GIT_ASKPASS` env (`createGitHubAskpassEnv`/`createGitHubClonePlan`),
never argv, never the persisted remote URL — so stderr is token-free by construction and the scrub is a
belt. This is B's single choke point: every clone caller gets `detail` for free. NOTE: in B, the clone
`detail` reaches the **server log only**; the timeline note still renders just `cloneFailureSentence`.

### app/server/github/push-workspace.server.ts — modified
- `push_failed` becomes its own result arm `{status; reason; detail?}` with `detail = redactGitOutput(stderr, {token})`;
  log level info→warn. In B, `performDelivery` does NOT render `detail` into the timeline (log-only again).
- Exports carved out for reuse by the new update-branch module: `PUSH_TIMEOUT_MS`, `Exec`, `defaultExec`,
  `findWorkspaceRepoDir` (renamed from private `findRepoDir`), `commitIdentityArgs` (extracted F24
  fallback-identity logic), `isNonFastForwardStderr`.

### app/server/github/update-branch.server.ts + update-branch-operator.server.ts (+ tests) — NEW (N19-9, f0b7b62)
Mechanics half: bring the task branch up to date with its base IN the delivering engagement's workspace.
Load-bearing choices: **merge, never rebase** (rebase ⇒ force-push, refused by R18-4); **workspace is the
writer** (updating remote alone would make the next delivery push non-fast-forward); **all-or-nothing**
(conflict ⇒ `git merge --abort`, failed push ⇒ local reset to start commit; branch is forward or exactly
as it was). Unshallows a depth-1 clone before merging (correct merge base beats fast). `dirty_workspace`
refuses up front. Result arms: `updated | already_current | conflict{files≤20,detail} | push_conflict |
update_failed{reason,detail} | no_*`. Decision half: capability `update-task-branch`; `updateBranchGate`
falls back to `deliverGate` when the grant is ABSENT (capability postdates all deployments; updating is a
strictly smaller act than delivering) — an explicit grant always wins. A conflict opens a **human decision
packet** with the conflicting paths as evidence (`{k:"git", v:detail, code:true}`), never an agent retry.
Wired on BOTH backends: Claude MCP tool `update_branch_from_base` (operator-toolkit) and the Codex plan
tool list (operator-run), including the A4 all-denied-fallback exclusion (effects outside Viberr).

### app/server/runtimes/skill-mount.server.ts (+182-line test growth) — modified (F19-15, 5ef217e)
The strip/mount race fix: per-process random `MOUNT_MARK` (`viberr-skill-mount <uuid>`) written to
`.claude/skills/<name>/.viberr-mount` **after** a successful copy. `stripUngovernedRepoCatalog` becomes
surgical: deletes everything in `.claude` EXCEPT skill folders carrying this process's mark (verified via
lstat — no symlinks, ≤256-byte marker file, exact match). Random-per-process ⇒ a cloned repo cannot forge
immunity from the R18-3 strip; a stale marker from a previous process never matches. `mountOneSkill`'s
failure cleanup no longer `rmSync`s a folder that was a live mount; mount-nothing path routes through the
strip instead of `rm -rf`. Both concurrent runs keep native mounts; the SDK `skills:[...]` allow-list —
not the directory listing — remains the invocation fence. **Stated residual: finished runs' mounts are
never collected** (would need run-liveness plumbed in; design parked in B's `spec-skill-mount-race.md`).

### app/server/tasks/task-actions.server.ts — modified (F19-1 + F19-27)
`recordDeliveredNextStep` (~line 3934): after a successful delivery, when the R18-2 full-autonomy
re-queue did NOT run ("exactly ONE of the two mechanisms"), write a `transition` recommendation "Move
the task to <review>" whose detail opens with **"Recorded by Viberr when the delivery landed — this is
not the operator agent's judgement."** System `delivery` actor on the timeline note; suppression
(`alreadyActionable`) re-checked INSIDE the file lock; audit row `github.delivery.next_step`; watcher
notify with explicit `from` so the operator's name is never on it. Suppressed when: open packet, any
pending recommendation (except a `delivery`-kind card, which this call just consumed), stage at/past
review (by stage INDEX, not workflow edge), archived task/project. Also F19-27: `noChanges` schema/cache
recompute so a nothing-to-deliver task owes nobody a verdict.

### app/server/tasks/operator-actions.server.ts / operator-toolkit.server.ts — modified
- **R19-4 (ruling 58) repo view, B's mechanism:** GitHub-API read-only view of the DEFAULT branch —
  `listRepoFiles` / `readRepoFile` with hard budgets (400 paths/listing, 24k chars/file, 4 listings +
  20 reads per run), `renderRepoViewBlock`, unreachable-never-rendered-as-empty. Exposed as Claude MCP
  tools `list_repo_files` / `read_repo_file` whose descriptions state the operator's cwd "is NOT the
  repository" and that these tools are its "ONLY view". **Claude-only** — the Codex plan schema gets no
  read tools.
- **R19-2 (ruling 56) repo-beats-KB:** persona edits (operator.definition.md, hash appended to
  PRIOR_SHIPPED_HASHES) + `operatorFlagContextConflict` tool / `contextConflictEvent` timeline event —
  a noticed KB-vs-repo conflict must be REPORTED, not silently resolved.
- **R19-A autonomy clamp:** `clampAutonomy` + audit `task.operator.autonomy_clamped`, recorded only on
  the launch-path authority resolve (operator-run passes `db`+`taskKey`).

### app/server/github/pr-linker.server.ts + pr-human-approval.server.ts (NEW) + github-reconciler.server.ts — R19-B (8090ceb)
`deriveApprovals` reduces the SAME `/reviews` payload (latest-per-reviewer; COMMENTED/PENDING never
replace a verdict; DISMISSED withdraws) keeping `login`+`commit_id`. `derivePrHumanApproval` maps the
login to a Viberr member via `users.github_handle`, **fails closed** (`unlinked_handle`,
`ambiguous_handle`, `not_a_member`, `stale_revision` — an approval with null commit_id never counts),
binds to the delivered revision and re-checks the binding on every read (`humanVerdictApproval`) so a
re-delivery revokes instantly without a reconcile. Record rides `pr.humanApproval` in task.md (loose
schema round-trips it). Reconciler threads it with the same absent-means-unknown carry-forward rule as
`review`/`mergeable`; membership read from the canonical project FILE, not a projection.

### app/server/github/github-reconciler.server.ts — F19-19 serializer
`withTaskReconcileLock` — per-task promise chain (key includes data root), queue not coalescer (second
caller re-reads AFTER the first wrote), tail absorbs rejections so a failed pass never strands the
chain; explicitly NOT `runSingleFlight` (a skipped reconcile right after a merge is the one that must
not be skipped). `reconcileTask` = lock wrapper around `reconcileTaskUnlocked`.

### app/server/tasks/specialist-run.server.ts — run anchoring + inspectable inputs (9ea40cd)
`freshRunAnchor` reuses the EXISTING `canonicalTaskAnchor` (task-actions) so fresh runs and resume share
one anchor implementation; placed between the workspace contract and the directive; named in the trust
boundary as injected DATA; hard-bounded ~3.5KB/~900 tokens; covers the cold-start first-@mention path;
a genuinely unbuildable anchor is dropped with a warn. `recordRunInputs` + `RUN_INPUTS_TAG`: what a run
was actually given (anchor, resolved skills/KBs/MCP servers, and the grants whose content never arrived)
lands in the Agent logs, redacted through run-sink's own `createLineRedactor`; ONE builder serves fresh
and resume so the disclosures cannot drift. `resolveResumeConfinement` now returns `runInputs`.

### test-support/setup-env.ts — N19-6 (ed6a6c5)
`process.env.GIT_ALLOW_PROTOCOL = "file"` — git's own transport allow-list. The two tests that reached
`cloneRepo` with the publicly-resolvable `akin-ozer/viberr` (`task-detail-route.server.test.ts`,
`specialist-run.server.test.ts`) now fail instantly/offline ("transport 'https' not allowed") instead of
cloning over the network. `file://` fixtures and local `git init/add/commit` are untouched.

### MCP probe artifacts
No code artifacts — B's probes live in docs: `planning/discovery-2026-08-06-pass19/NOTES.md` UC-14
(real stdio server `pass19-probe` registered through the UI, canary `MCP-CANARY-PASS19-4417` returned by
`mcp__pass19-probe__viberr-pass19-probe` inside VC-7's run) and the round-2 live-verification records
(4c62e6a). Doc-only; conflicts covered in §4.

---

## 2. Same concern, two mechanisms — verdicts

### (a) Git stderr scrub — B `redactGitOutput` vs A `redactGitStderr` (app/server/tasks/git-stderr-redact.server.ts)
Same finding pair (F19-6/F19-18), same verified premise (askpass keeps the PAT out of argv/remote URL),
near-identical prose. Deltas: **B has** the token-SHAPE backstop layer, `gitErrorText`, threading through
`cloneFailureLogDetails` (one choke point) and the new update-branch module. **A has** ANSI + C0
control-character stripping (a timeline note must not carry `\x1b[31m` or NUL — B lacks this), an
`undefined`-on-empty contract, error-or-string input, and — decisively — **human-facing surfacing**: the
excerpt reaches the task TIMELINE as a fenced block on both paths ("What the checkout reported:" /
"What the push reported:"), a ≤240-char `oneLine` form inside the delivery sentence, and the analyze
prompt tells the agent to quote the excerpt verbatim. In B the diagnosis stops at the server log for both
clone and delivery-push (only update-branch surfaces `detail` to humans, as packet evidence).
**Verdict: unify into ONE module — B's `git-output-redact.server.ts` survives as the implementation**
(update-branch, a pure addition, already imports it; its shape layer is a real hardening; its choke-point
threading is the fewer-moving-parts shape), **ported with A's ANSI/C0 stripping added, and A's rendering
call sites kept** (timeline fenced blocks + prompt instruction + `oneLine` reason). Delete
`git-stderr-redact.server.ts` after retargeting A's three callers (specialist-run:2200,
operator-run:826, push-workspace:638/672). Throws-loudly criterion favors nothing here; surfacing-to-
humans is the tie-breaker and A wins it, redaction depth is B's win — take both.

### (b) Skill strip/mount race (F19-15) — B `MOUNT_MARK` vs A `liveWorkspaceCatalogLease`
A (specialist-run.server.ts:1979–2090): in-process lease per project/task; liveness derived from
`agent_runs` rows (`running|queued`) with a 60s mount→startRun handoff grace; a second PROFILE's run is
refused the native mount and degrades to prompt-text injection; the workspace-reuse path skips the strip
while a lease is live. skill-mount.server.ts untouched.
B: the strip itself becomes safe (survivors = folders carrying this process's random mark), so BOTH
concurrent runs keep native mounts and the caller needs no coordination.
**Verdict: B is stronger.** (i) No capability loss — A silently downgrades run 2 to prompt injection,
which is exactly the "silent degradation" the criteria penalize; (ii) the invariant lives in the ONE
module that owns the strip instead of caller-side lease bookkeeping with DB reads, a grace window and an
ISO-string compare; (iii) the random mark is unforgeable by repo content, so R18-3 is intact. A's design
does avoid B's stated residual (stale mounted folders readable — not invokable — for the workspace's
life), but that residual is documented and fenced by the SDK allow-list. **Merge action:** take B's
skill-mount.server.ts wholesale; DELETE A's lease machinery (`WorkspaceCatalogLease`,
`liveWorkspaceCatalogLease`, `holdWorkspaceCatalog`, `mountGrantedSkillsLeased`,
`resetWorkspaceCatalogLeasesForTests`, the lease-conditional strip-skip in `cloneRepo`) and call
`mountGrantedSkills`/`stripUngovernedRepoCatalog` directly — with B's strip, the reuse-path strip is safe
unconditionally. A's specialist-run tests asserting the skipped-mount fallback must be dropped in favor
of B's preservation tests (see §5).

### (c) Delivered-next-step guarantee (F19-1) — B `recordDeliveredNextStep` vs A `ensureDeliveredNextStep`
Same live repro (both name VC-1: operator delivered, narrated "will move to Review", recorded nothing).
A (operator-actions:1834, called from performDelivery): only when `ctx.operatorAuthorized === true` AND
autonomy ≠ full — a human who clicked Deliver "is present and needs no card". Uses `addRecommendation`
(dedupes per kind+profileId+toStageId, so the operator's own card collapses onto it) and — uniquely —
**checks the workflow declares an edge** `stage → review` before proposing. Card is attributed like an
operator recommendation; no dedicated audit row.
B (task-actions:3934): runs after EVERY successful delivery the full-autonomy re-queue didn't cover
(manual human delivery included); suppression re-checked INSIDE the file lock; timeline + card attributed
to the SYSTEM `delivery` actor with the "Recorded by Viberr… not the operator agent's judgement" sentence;
audit `github.delivery.next_step`; watcher notification with explicit `from`. Stage guard is index-based
(strictly before review), no workflow-edge check.
**Verdict: B's implementation is the stronger base** — honest attribution (a synthesized card wearing the
operator's name is the exact confabulation class pass 19 hunted), lock-held idempotency, its own audit
fact, and notification fan-out; B's broader scope is also live-validated (its NOTES VC-7 shows the card
rendered with Apply/Dismiss). **Fold in A's workflow-edge check** (never propose a transition the
project's workflow does not declare — B could otherwise recommend an illegal move that
`applyRecommendation` then refuses). The one open judgment for the resolver: A deliberately exempts
human-manual deliveries; B covers them. B's suppression guards make the extra card low-noise, so prefer
B's scope unless the owner said otherwise (neither tree records an owner ruling on that sub-point).
Exactly one mechanism must survive (see §5).

### (d) Operator repository visibility (B "R19-4"/ruling 58 vs A "R19-1") — THE headline divergence
B: budgeted GitHub-API read tools (`list_repo_files`/`read_repo_file`), Claude-only, persona says the
tools are the operator's ONLY view and its cwd is not the repository.
A: `ensureOperatorRepoCheckout` (operator-run.server.ts:711+) — a full read-only CLONE into the SAME
`<taskDir>/workspace/<name>` path specialist runs use (later delivering runs reuse it), provisioned once
per drive under the operator lease; `OperatorWorkspaceView` three-arm type where `unavailable` is
first-class ("the run has to KNOW it is blind"); read-only enforced structurally via
`operatorDisallowedTools` (deny Bash/Edit/MultiEdit/Write/NotebookEdit + withheld web) on BOTH backends;
`workspaceSection` prompt block with a deliberate delivery carve-out (doesn't say "you cannot push",
which would contradict the deliver_for_review contract). A's comment records the owner's answer verbatim:
**"The owner ruled for a full read-only clone over a summary view and over a persona-only fix."**
**Verdict: A wins — later/most-specific owner ruling.** The FULL-clone answer is stated as the owner's
choice in A's tree and in the task brief's known facts. A's mechanism also serves Codex (B's is
Claude-only) and grounds the operator in the same checkout delivery will use. **Merge action:** keep A's
checkout + denylist + workspaceSection; DROP B's `list_repo_files`/`read_repo_file` tools, their budget
plumbing and their persona "ONLY view" sentences (keeping them alongside a real checkout makes two
surfaces answer the same question and the persona text becomes false). Keep B's persona R19-2
(repo-beats-KB) half and its `operatorFlagContextConflict` tool — that concern is orthogonal and A's
counterpart (`KB_PRECEDENCE_NOTE` in kb-injection) composes with it: both state repo-wins; unify wording,
keep both channels (injection note + report-conflict tool).

### (e) reconcileTask serialization (F19-19) — near-identical twins
A `serializePerTask` vs B `withTaskReconcileLock`: same queue-not-coalesce design, same
never-rejecting-tail trick, same dataRoot-in-key insight, same only-current-tail-clears rule.
Differences: A clears the chain map in `resetReconcileCursorsForTests` (B does NOT — B's reset clears
cursors only); A runs `prior.then(work, work)` (belt), B `previous.then(work)` (tail never rejects, so
equivalent). **Verdict: keep B's version** — its reconciler body also threads R19-B `humanApproval`, so
taking B's file wholesale is the cheap direction — **but port A's chain-map clear into
`resetReconcileCursorsForTests`** (without it, cross-test chain leakage is possible in the merged suite).

### (f) No-change completion (A F19-21 / B F19-27) — complementary halves, one shared flag
A: `DefaultBranchEvidence` in push-workspace — `verified:true` only after three read-only probes agree
(clean tree, no local commits ahead — with a HEAD==origin/<default> offline shortcut — and no abandoned
task branch matching `taskBranchName` forms); `no_branch`/`no_commits` carry it so performDelivery can
distinguish "verified zero-diff" from "agent forgot to branch/commit failed".
B: schema + validation — `noChanges` recomputed alongside its cache at both performDelivery sites, and
the acceptance/validation layer stops demanding a verdict from a task with nothing to deliver.
**Verdict: keep BOTH — they gate different ends of the same flag.** A decides WHEN "no changes" may be
asserted (evidence-gated, throws-nothing-but-verifies); B decides what a no-change task OWES the gates.
Resolver must make A's evidence the only writer of the flag B's validation exemption reads (both sides
touch task-file.schema.ts and the same performDelivery region — see §4/§5).

---

## 3. Pure Session-B additions (no Session-A counterpart) — auto-merge, with risks

- **update-branch.server.ts / update-branch-operator.server.ts + `update-task-branch` capability +
  `update_branch_from_base` on both backends (N19-9).** Owner-ruled feature; A has nothing like it.
  Risks: (1) it imports `PUSH_TIMEOUT_MS`/`Exec`/`findWorkspaceRepoDir`/`commitIdentityArgs`/
  `isNonFastForwardStderr` from push-workspace — those exports exist only in B's version of a file that
  will CONFLICT; the resolver must re-create B's export carve-outs on top of A's push-workspace changes.
  (2) It imports `redactGitOutput` — survives only if §2(a) keeps B's module (recommended). (3) Its
  absent-grant fallback rides `deliverGate`; A's R19-6 ("capability 'off' = hard refuse") concerns an
  EXPLICIT off, which `updateBranchGate` already honors first — compatible, but worth one test.
  (4) A's R19-5 (force-accept may skip stages) does not touch it.
- **pr-human-approval.server.ts + pr-linker `deriveApprovals` + reconciler threading (R19-B).** Auto-merges
  file-wise except the reconciler/pr-linker conflicts (§4). Real risk is semantic: A's acceptance-ceremony
  family (throwing `AcceptDisclosure`, verdict-gated acceptance) must LEARN that `pr.humanApproval`
  satisfies the verdict gate, or B's feature merges in dead. Flag to the acceptance cluster.
- **Run anchoring + `recordRunInputs` (9ea40cd).** Concern-pure addition (A never built a fresh-run
  anchor), but textually embedded in specialist-run.server.ts which conflicts heavily (§4). Mechanism to
  preserve: single `canonicalTaskAnchor` reuse, anchor-before-directive placement, trust-boundary naming,
  run-inputs recorded through run-sink's redactor.
- **setup-env.ts `GIT_ALLOW_PROTOCOL=file` (N19-6).** No A counterpart (A left setup-env untouched; A's
  suite still makes those two network clones). Auto-merges. Risk: any A test that implicitly depended on
  a real clone attempt (timing out / specific stderr) now fails fast with "transport 'https' not
  allowed" — A's clone-failure tests are unit-level with injected stderr, but A's fenced-excerpt timeline
  assertions in route-level tests should be re-run first after merge.
- **R19-A autonomy clamp + audit; key-rotation.server.ts; schedule autonomy ceiling (c27c354).** Adjacent
  to this cluster; no A mechanism collides (A's schedule change is the F19-20 terminal-stage refusal —
  different concern, both can land; both sides touch schedule.server.ts so expect textual conflict there).

---

## 4. Files in this domain that WILL conflict textually (both sides modified vs main)

From `git diff --name-only main...origin/pass19/product-fixes` ∩ worktree `git diff --name-only main`:

| File | A's change | B's change | Sting |
|---|---|---|---|
| app/server/tasks/specialist-run.server.ts | catalog lease; clone token hoist + `redactGitStderr` excerpt into failure/timeline/prompt | anchor + runInputs; `cloneFailureLogDetails(error,{token})`; strip-comment on reuse path | same `cloneRepo` catch and reuse-path lines; same `buildAnalyzePrompt` params region |
| app/server/tasks/specialist-run.server.test.ts | lease tests | anchor/runInputs tests | opposing F19-15 assertions (§5) |
| app/server/runtimes/operator-run.server.ts (+ test) | repo checkout, `operatorDisallowedTools`, workspaceSection, F19-20 refusal, signature changes to startCodex/startReal + buildOperatorSystemPrompt | `update_branch_from_base` plan tool + A4 exclusion, clamp-audit args to resolveOperatorAuthority | same `runOperator` body and plan-tool tables |
| app/server/github/push-workspace.server.ts (+ test) | `DefaultBranchEvidence`, `stderrExcerpt`, `oneLine`, result-type reshuffle | `push_failed{detail}` arm, export carve-outs for update-branch, `commitIdentityArgs` extraction | the SAME result union and the SAME push-failure block rewritten differently on both sides |
| app/server/github/github-reconciler.server.ts (+ test) | `serializePerTask` + reset clearing | `withTaskReconcileLock` + R19-B threading | two implementations of the identical serializer around the same function head |
| app/server/tasks/task-actions.server.ts | performDelivery: F19-21 evidence branch + `ensureDeliveredNextStep` call + fenced push excerpt | performDelivery: `recordDeliveredNextStep` call + F19-27 noChanges recompute | same post-push region of `performDelivery` |
| app/server/tasks/operator-actions.server.ts (+ test) | `ensureDeliveredNextStep`, `terminalStageIdOf`, `completionCapabilityRefusal` | repo-view impl + budgets, `contextConflictEvent`, `clampAutonomy` | large disjoint additions to one file — mostly mechanical, but big |
| app/server/tasks/operator-toolkit.server.ts (+ test) | (A test/impl touches) | `list_repo_files`/`read_repo_file`/`flag_context_conflict`/`update_branch_from_base` tools | resolve per §2(d): keep update-branch + flag-conflict tools, drop repo-view tools |
| app/server/tasks/git-clone-auth.server.test.ts | A added excerpt tests | B added detail tests | merge both suites onto the unified redactor |
| app/shared/capabilities.ts | F19-12 label change + long comment | same label change + `update-task-branch` cap | trivial: keep B's new cap + either comment |
| app/server/tasks/schedule.server.ts (+ test) | F19-20 retirement recording | autonomy-ceiling honoring | adjacent features, same file |
| app/server/seed/agent-catalog.server.ts | A edits | B edits (persona grants incl. update-branch label?) | check seeded operator grant list compiles against merged capability catalog |
| app/schemas/task-file.schema.ts (+ test) | A F19-21-adjacent | B F19-27 fields + humanApproval-tolerant pr | one schema, two new field sets — union them |
| planning/discovery-2026-08-06-pass19/{INTENT.md, NOTES.md, audit-workflow-result.json, reference/*.md} | A's pass-19 docs | B's pass-19 docs — SAME directory name, same filenames | do NOT line-merge; keep both as `NOTES-A.md`/`NOTES-B.md` or a merged register — B's NOTES carries the MCP probe evidence (UC-14) that must not be lost |

Not conflicting (verified): `test-support/` (A: custom-board.ts; B: setup-env.ts), skill-mount.server.ts
(B-only), git-clone-auth.server.ts impl (B-only), git-stderr-redact.server.ts (A-only, slated for
deletion per §2(a)), update-branch* and pr-human-approval* (B-only), operator.definition.md (B-only —
but see §5 semantic edit).

## 5. Semantic collisions that will NOT (fully) conflict textually

1. **Double next-step card.** A's `ensureDeliveredNextStep` (performDelivery, operator-authorized arm)
   and B's `recordDeliveredNextStep` (performDelivery, non-requeued arm) BOTH fire on a supervised
   operator delivery. Their dedupe keys don't see each other (A dedupes per kind+profileId+toStageId;
   B's guard counts ANY pending recommendation — so the outcome depends on call order). Keep exactly one
   (§2(c): B's body + A's workflow-edge check); delete the other AND its tests
   (`delivery-actionable.server.test.ts` in B vs A's operator-actions/task-detail tests — both suites
   assert their own card's wording).
2. **Lease vs marker.** If both F19-15 fixes land, B's marker makes concurrent mounts safe but A's lease
   still refuses run 2's native mount — a silent downgrade contradicting B's tested behavior. A's tests
   assert "skipped: another agent's live run holds this task's workspace catalog"; B's tests assert the
   second run's mount SURVIVES. Merged suite = duplicate tests asserting opposite behavior. Remove the
   lease (§2(b)).
3. **Operator prompt contradiction.** B's persona/tool text: cwd "is NOT the repository", API tools are
   the "ONLY view". A's workspaceSection: here is your read-only checkout of the repository, in your cwd.
   Both merge clean (different files) and lie to the model in opposite directions at runtime. Per the
   FULL-clone owner ruling, rewrite B's operator.definition.md sentences to describe the checkout, and
   drop the repo-view tools (§2(d)). Keep B's "look before you scope" triage instruction — it applies to
   the checkout just as well.
4. **Double redaction / half-redaction.** Two redactors on one stderr is harmless; the hazard is the
   asymmetric merge: if A's callers keep `redactGitStderr` while B's git-clone-auth carries `detail`
   through its own scrubber, the same clone failure gets logged twice with different texts, and B's
   un-stripped ANSI can reach an operatorSnapshot note. Unify per §2(a).
5. **noChanges writer/reader split.** A's evidence gate writes `noChanges` only on `verified:true`; B's
   F19-27 recomputes the cache at both performDelivery sites and exempts no-change tasks from the
   verdict gate. Merged wrong, B's exemption could fire on a flag A's stricter gate never set (fine) or
   A's gate could set the flag without B's cache recompute (board shows stale claim — the exact bug
   B's 732fd47 fixed). The merged performDelivery must run A's evidence check, then B's flag+cache write.
6. **Human-approval verdict vs acceptance ceremony.** B's `humanVerdictApproval` satisfies the approving
   verdict; A's acceptance family (AcceptDisclosure throw-path, R19-5 force-accept enumeration, R19-6
   hard-refuse) predates it. They merge clean file-wise; unwired, a member's GitHub approval still forces
   an admin force-accept — B's feature silently dead. Hand to the acceptance cluster with pr-linker's
   `approvals` carry-forward rule intact.
7. **Reconcile chain leakage in tests.** B's serializer survives (§2(e)) but B never clears
   `taskReconcileChain` in `resetReconcileCursorsForTests`; A's suite relies on that clearing. Port A's
   two lines or the merged suite can flake.
8. **N19-6 vs A's network-cloning tests.** B's `GIT_ALLOW_PROTOCOL=file` flips A's two accidental
   network clones from "sometimes slow/green" to "always fail fast" — the assertion texts A wrote around
   clone failure (fenced excerpts now containing "transport 'https' not allowed") must be re-verified.
