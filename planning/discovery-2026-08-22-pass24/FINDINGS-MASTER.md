# Pass 24 — master findings (implementation backlog)

Baseline: main `60eade3` (pass 23 merged: PRs #194/#195/#197). Container rebuilt to this.
Method: 3 fable/max code-audit subagents (parity, count-coherence, PR#197-regression) →
I verified EACH in code myself (file:line + failure scenario). Statuses below are MY verification,
not the subagents'.

Legend: **CONFIRMED** = I read the code and the failure scenario holds. **CONFIRMED*** = verified
the core claim, one link to re-check at implementation. Severity: HIGH = user misled / data or work
lost / governance integrity; MEDIUM = confusing/wasteful/real gap w/ workaround; LOW = polish.

The striking theme: **several pass-23 fixes are inert or regressed** — the C-series silent-drop
remediation (C2, C3, C4, C5, C7) was wired to seams that cannot fire for the failure they target, or
introduced a new regression; and the A1 capability-display materialization has wrong polarity for
operator-kind and governance-dependent caps.

---

## THEME A — Capability display/save honesty (A1 fix has polarity bugs)

### A-1 [HIGH, CONFIRMED] `update-task-branch`: silent recommend→direct widening on a no-touch operator save
(cross-confirmed independently by 2 subagents; = K1 = R1)
- `update-task-branch` catalog default = `direct` (capabilities.ts:76), NOT grant-required
  (GRANT_REQUIRED_CAPABILITY_IDS lacks it). It IS in the operator editor catalog (group="Permissions",
  kinds=["operator"] → included via `editorCatalog("operator")`, capability-catalog.ts:106).
- `effectiveProfileView` EXCLUDES it from A1 materialization (`governanceDependent=new Set(["update-task-branch"])`,
  agents-query.server.ts:339) → matrix / profile-detail / policy show NO row.
- Runtime: `updateBranchGate` (update-branch-operator.server.ts:76) — absent → `deliverGate` →
  `absentDeliverReviewPrMode(humanGatedBeforeWork)` = **recommend on a human-gated (Strict) project**.
  An EXPLICIT grant wins.
- Editor `seedCaps` (create-profile-modal.tsx:170) seeds absent non-grant-required caps to catalog
  default → toggle shows **Direct**. Save persists ALL operator cap ids → persists
  `update-task-branch: direct`.
- **Failure**: Strict project; admin opens operator editor, changes only the name, saves →
  `update-task-branch` goes recommend→**direct** (explicit). Operator now merges base + pushes the
  task branch directly on a human-gated project. Same silent-flip class BUG-1/PR#194 fixed, in the
  WIDENING direction.
- **Fix**: `seedCaps` + materialization must handle the THIRD (governance-dependent) polarity:
  seed/display `deliver-review-pr` AND `update-task-branch` at `absentDeliverReviewPrMode(project.humanGatedBeforeWork)`,
  not the flat catalog default; materialize `update-task-branch` (drop from `governanceDependent`, or
  materialize at governance mode like `deliver-review-pr`). Editor has the project workflow, so it can
  compute humanGatedBeforeWork. Add a cross-surface agreement test vs `updateBranchGate`.

### A-2 [MEDIUM, CONFIRMED] A1 materialization over-states ABSENT operator coordination caps (gate = off/deny)
(= R6)
- `effectiveProfileView` materializes absent caps at `GRANT_REQUIRED?off:c.defaultMode`
  (agents-query.server.ts:340-353) — the SPECIALIST polarity. But the operator `gate()` treats absent
  as `off`/deny for everything except deliver-review-pr/update-task-branch (governance) and web-egress
  (operator-actions.server.ts:453 `authority.policy.get(capabilityId) ?? "off"`).
- So an operator missing (hand-edited/imported project.md, or a FUTURE-added operator cap)
  `stage-transitions` / `generate-packets` / `assign-primary-specialist` / `summon-reviewers` /
  `append-typed-events` / `completion-for-acceptance` shows matrix/detail/policy = "Recommends"/"Acts
  directly", and a save ARMS it (persists the shown mode) — where runtime is deny. Seeded operators
  have all present, so this bites hand-edits + future caps.
- **Fix**: materialization must key off the GRANT KIND — for operator caps, absent = `off` except the
  three special-resolved ones (deliver-review-pr/update-task-branch=governance, use-web-search-fetch=default).
  Consolidate with A-1 into one correct polarity function reused by editor + view + gate.

### A-3 [LOW] connection card "N repos" always plural + is GitHub `public_repos`, not a viberr binding count
- connections-panel.tsx:260 `${c.repos} repos` (would render "1 repos"; use countLabel). `c.repos` =
  GitHub account `public_repos` (connections.server.ts:429) — correct value but reads as "repos bound
  here". Low; consider "N public repos" + countLabel.

---

## THEME B — Codex/Claude backend parity

### B-1 [HIGH, CONFIRMED — also an OWNER QUESTION] Codex operator's writable sandbox is rooted at the task GOVERNANCE dir → task.md is writable; Claude operator physically cannot write
(= P1)
- Codex operator `StartRunInput` sets no `workdir` (operator-run.server.ts:1668-1691) →
  run-service.server.ts:594 `workdir = input.workdir ?? taskDir(...)` = `projects/<slug>/tasks/<KEY>`
  (the folder holding **task.md**). `resolveCodexSandboxMode` → `workspace-write` for operators
  (codex-runtime.server.ts:378-382) = writable + shell-capable; `workingDirectory: spec.workdir`
  (:690); `approvalPolicy:"never"` → Codex runs shell tools mid-turn autonomously.
- So a Codex operator can `sed -i ./task.md` (flip validation, delete an open packet, rewrite a reviewer
  verdict) or `git commit` in `./workspace/<repo>` (the shared deliverer clone → a later delivery ships
  operator-authored code). NO server gate mediates a direct task.md write; the watcher reprojects it as
  canonical truth. The Claude operator has Bash/Edit/Write/MultiEdit/NotebookEdit DENIED → cannot.
- The shared system prompt even asserts "you cannot edit… the file-writing and shell tools are withheld
  from this run" and "You have no shell" (operator-run.server.ts:2551, operator.definition.md:15) —
  FALSE on Codex.
- **Owner question**: R22 ("viberr is the sandbox") accepted advisory file/command limits with the
  server-owned DELIVERY gate as the boundary — but did not consider direct task.md mutation. Fix
  options: (a) root the Codex operator at the workspace CLONE dir (like specialists) so task.md (one
  level up) is outside the writable root [minimal; residual: operator can still commit in the clone];
  (b) give the operator a SEPARATE read-only checkout; (c) accept as within R22. Needs a ruling.

### B-2 [MEDIUM, CONFIRMED] `use-web-search-fetch` granted to a Codex operator is inert
(= P2)
- codex-runtime.server.ts:709-711 unconditionally `networkAccessEnabled=false; webSearchMode="disabled"`
  for `spec.kind==="operator"`, ignoring `spec.webSearchWithheld`. Claude operator honors the grant
  (operatorDisallowedTools only removes WebFetch/WebSearch when withheld). Cap is in ENFORCED "both" set,
  matrix shows it green ("Acts directly") for the operator, editor shows no advisory tag.
- **Fix**: for a Codex operator, gate web search on the SAME grant Claude uses
  (`webSearchMode = spec.webSearchWithheld ? "disabled" : <on>`), keeping sandbox network off
  (MCP/tooling unaffected). Or, if operators are intentionally web-less on Codex, tag the row advisory
  and stop rendering it green for a Codex-pinned operator.

### B-3 [MEDIUM, CONFIRMED] `read_default_branch_file` (VIB-7/F21-21 fix) is Claude-only; shared prompt tells the Codex operator to call it and says "you have no shell"
(= P3)
- Tool offered only by the Claude toolkit (operator-toolkit.server.ts:292,330); not in `OPERATOR_PLAN_TOOLS`.
  Shared system prompt / operator.definition.md instruct EVERY operator "call `read_default_branch_file`
  … You have no shell, so that tool is your only anchored read." On Codex: the tool doesn't exist AND it
  DOES have a shell (workspace-write). → a Codex operator either reads the task-branch checkout with its
  shell and re-creates the VIB-7 false out-of-band-merge blocking packet, or declares itself unable.
- **Fix**: give the Codex plan path an equivalent anchored default-branch read (a plan tool backed by
  `operatorRepoRead`/origin read), and make the shared prompt's "you have no shell" conditional on backend.
  (Interlocks with B-1: the Codex operator having a shell at all is the root.)

### B-4 [MEDIUM, CONFIRMED] Stdio-MCP run pre-flight verifies WITH a credential the Codex run never receives
(= P4)
- `verifyStdioMcpMountsForRun` spawns each stdio server WITH its token (specialist-mcp.server.ts:267-272);
  Codex CLI translation drops `env.MCP_CREDENTIAL` (codex-runtime.server.ts:160-183). A credential-
  requiring server passes pre-flight (`disc.kind==="up"` → mount left healthy, announced in persona),
  then dies at Codex spawn → no unresolved entry, agent reports the absence as its own failure. Claude
  run works.
- **Fix**: for a Codex run, pre-flight the stdio mount WITHOUT the credential (matching the run), or mark
  credential-requiring stdio mounts unresolved/advisory on Codex with disclosure.

### B-5 [LOW, CONFIRMED] An un-granted verdict a Codex agent emits is discarded with no log or note
(= P5)
- task-actions.server.ts:2749 `let verdict = verdictAuthorized ? (outcome?.verdict ?? null) : null;` —
  when unauthorized, silently nulled; no log (the prose-fallback log fires only on the authorized path).
  Claude's `report_outcome` omits the verdict field unless granted, so it can't happen there.
- **Fix**: when a verdict field is present but unauthorized, log + (optionally) a system note that a
  verdict was asserted and dropped.

### B-6 [LOW, CONFIRMED] `executeCodexPlan` silently skips schema-valid-but-null plan steps
(= P6)
- Guard arms `case "post_comment": if (a.text) {record(...)} break;` (and transition_stage/set_goal,
  operator-run.server.ts:1935/2003/2046) fall through without `record()` when the (OpenAI-strict,
  present-but-nullable) field is null → `narrateRefusedActions` never surfaces the skip. Human sees an
  operator that decided nothing. Claude toolkit returns a zod error the model self-corrects.
- **Fix**: each guard's else branch should `record()` a refusal ("plan step omitted <field>").

---

## THEME C — Pass-23 silent-drop fixes that are INERT or REGRESSED

### C-1 [MEDIUM, CONFIRMED] C4's `noteCompletionEffectsLost` cannot fire on its primary path
(= R2)
- run-service.server.ts:145-155 & :1252 wrap `cb(finished)` in a SYNCHRONOUS try/catch →
  `noteCompletionEffectsLost`. But the registered callback is `(finished) => void
  applyAgentCompletionEffects(...).catch(log)` (task-actions.server.ts:2601) — an async fn that never
  throws synchronously; its rejection is swallowed by the inner `.catch(log)`. So a real
  completion-effects failure logs only; board stays "agent working" until restart — the exact pre-C4 symptom.
- **Fix**: call `noteCompletionEffectsLost` inside the async `.catch` at task-actions.server.ts:2605
  (where the rejection is actually caught), passing dataRoot.

### C-2 [MEDIUM, CONFIRMED] C7's "GitHub sync failing" alert is dead for revoked/expired/network PATs
(= R3)
- `pollGithubReconcile` calls `noteReconcileFailure` only in its catch (reconcile-poller.server.ts:219-227),
  but `reconcileProject` never THROWS for the named failure class: `gh.status!=="ok"` early-returns a
  summary (github-reconciler.server.ts:920), and auth/network failures return per-task `auth_failed`
  results. The poll then runs `noteReconcileSuccess(slug)` each tick, clearing the streak → alert never
  fires. The notification text even names "expired, revoked, or missing repository access".
- **Fix**: inspect `summary.status` and per-task failed/auth results; `noteReconcileFailure` on a
  credential/network-failed summary; `noteReconcileSuccess` only on a genuinely clean pass.

### C-3 [MEDIUM, CONFIRMED] C3's retry double-posts the agent reply (then a false "could not be posted" note)
(= R4)
- task-actions.server.ts:1789 `writeReply` unconditionally `unshift`s the reply event (no internal
  dedup — F22-12 dedup is upstream, deciding WHETHER to run this flow). The chain
  `writeReply().then(finalizeReply).catch(async ()=>{ await writeReply(); finalizeReply(); ...})`
  (:1840-1888): if `writeReply` succeeded but `finalizeReply` (reproject/audit/notify — throws on
  transient SQLITE_BUSY) failed, the catch re-runs `writeReply()` → reply posted TWICE; if finalize
  fails again, a "could not be posted" note is added beneath two copies.
- **Fix**: catch writeReply and finalizeReply SEPARATELY (retry only the step that failed), or make
  writeReply idempotent (guard: skip if this run's reply event already present).

### C-4 [MEDIUM, CONFIRMED] C5's "reviewer finished without a readable verdict" note fires on conversational replies & question outcomes
(= R5)
- task-actions.server.ts:2809 `if (verdictAuthorized && !verdict)` posts a policy-engine note claiming
  "validation is unchanged and acceptance stays gated. Re-run…". `verdictAuthorized` = engagement
  verdictCapable (true for every engaged reviewer). So it false-alarms on: a conversational @mention
  reply ("@Reviewer summarize your concerns"), and a reviewer that finishes by ASKING a question
  (`question` set — condition ignores it). Fires on tasks not even in review.
- **Fix**: gate the note on the run actually being a review/validation run that was EXPECTED to produce
  a verdict, and add `&& !question`. (A log-line was invisible; a timeline note is a user-facing claim.)

### C-5 [MEDIUM, CONFIRMED] C2's second half unimplemented: a queued @operator turn that FAILS at fire time is silently dropped and strands `waiting: agent`
(= R7)
- operator-run.server.ts:517-522 & :545-550 fire the queued trigger as `void runOperator(...).catch(log)`.
  On rejection: no timeline note, no notification, and `settleWaitingAfterOperator` is skipped (it runs
  only when there was NO queued trigger, :536-538) → task stuck waiting:agent, comment dropped. The C2
  commit surfaced only the MAX_PENDING cap-overflow drop.
- **Fix**: on a queued-trigger fire failure, write a system note (or notify the commenter) AND settle
  the waiting state.

---

## THEME D — Count / aggregate coherence (F19-9 "badge/queue parity" class)

### D-1 [MEDIUM, CONFIRMED*] Archived-project review queue & board "Waiting on me" count decisions the server refuses and the home/notifications inboxes exclude
(= K2)
- `decisionsRequiring` drops archived PROJECTS (decisions.server.ts:112 `filter(!p.archived)`);
  `getReviewQueue` checks only task-level `archived=0`, never `project.archived` (review-queue.server.ts).
  Board `waitingOnMe = decisionsRequiring.mine ∪ getReviewQueue.ready` (project.tsx:107). Server refuses
  acceptance on an archived project (task-actions.server.ts:6591). F19-9 covered archived TASKS not
  archived PROJECTS.
- **Failure**: archive a project with an acceptance-ready review task → Home card 0 waiting, notifications
  "nothing waiting", but the project's board chip "Waiting on me · 1" + Review page "1 of 1", and clicking
  accept is refused. Re-check: confirm getReviewQueue path has no archived-project guard.
- **Fix**: exclude archived-project tasks in `getReviewQueue` (or add a project.archived guard), matching
  `decisionsRequiring`.

### D-2 [MEDIUM, CONFIRMED] Policy "N direct" counts advisory (group:null) lines the profile detail excludes
(= K3)
- policy-page.tsx:323-346 sums raw `p.actions.direct/recommend/forbidden` buckets; the profile detail
  (agents-page.tsx) partitions governed vs advisory (group:null → "Advisory only · N lines the runtime
  does not read"). Seeded Reviewer: policy "11 direct" vs detail "5 acts directly" (6 advisory:
  read-repo-diff, run-validation-suites, author-test-cases, post-quality-flags, approve-review,
  request-changes). Comparing agents by policy count compares binding+advisory mixtures.
- **Fix**: policy counts should sum only governed caps (or split governed vs advisory like the detail).

### D-3 [MEDIUM, CANDIDATE] Home hero "N decisions waiting on you" vs notifications "N decisions": inbox counts only decisions that produced a notification row
(= K4)
- Home sums `decisionsRequiring.mine` (the SET); notifications `needsTotal` counts packet/approval
  NOTIFICATION rows with waitingOnYou over the newest 100 (notifications-page-helpers.ts). Membership
  changes after the event, decisions with no notification, and the 100-row cap drop decisions from
  needsTotal that stay in `mine`. `needsTotal ≤ hero`, can be 0 while hero says N.
- Verify at impl: confirm the two derivations; likely fix = notifications "waiting" derives from the same
  decisions SET, or the hero notes it's a superset.

### D-4 [LOW, CANDIDATE] Rail "N members" counts removed-account ghosts that Policy/Settings split out
(= K5)
- project.tsx:227 `membersCount={board.members.length}` (raw project_members) vs policy/settings LV-04
  `filter(!m.missing)` → "N members · M removed accounts". Rail "3 members" vs Policy "2 members · 1
  removed account".
- **Fix**: rail should count live members (apply the missing split), or label it consistently.

### D-5 [LOW, CANDIDATE] Home "running" counts distinct TASKS but is labeled "agents running" / "runs active"
(= K6)
- home-query.server.ts:210 `COUNT(DISTINCT task_key) WHERE state='running'`; project-cards.tsx:127
  `countLabel(p.running,"agent")+" running"`; home-sections.tsx:201 `countLabel(totalRunning,"run")+" active"`.
  Two live runs on one task → "1 agent running" / "1 run active" while the Agents Live tab shows 2.
- **Fix**: either count runs (not distinct tasks) or relabel as "task(s) with a run in flight".

---

## THEME E — Misc

### E-1 [MEDIUM, CONFIRMED] A3 releaseTasksOwnedBy skips non-member (org-admin-override) owners → ghost owner + false dialog promise
(= R8)
- org-users.server.ts:344 `if (!members.some(userId)) continue;` runs BEFORE `releaseTasksOwnedBy`
  (:359). An org admin can take ownership of a task in a project they're NOT a member of (D2 override).
  On account deletion, `pruneUserFromProjects` skips that project → task keeps a deleted ownerUserId
  (ghost owner, acceptance stalls). Dialog (users-panel.tsx:806) promises the tasks are released.
- **Fix**: release owned tasks per project regardless of the deleted user's membership (walk projects
  where they OWN a task, not only where they're a member), or correct the dialog copy.

### E-2 [LOW, CONFIRMED] D2 rename missed 3 rendered toasts still saying "org settings"
(= R9)
- github-actions.server.ts:275, 290, 308 say "org settings" (nav now reads "Instance settings").
- **Fix**: rename to "Instance settings".

---

## Owner questions (see QUESTIONS.md)
- B-1: how to constrain the Codex operator's writable sandbox re: task.md (R22 ruling interplay).
- Any others surfaced during live testing.

## Verified-not-a-bug this pass
- Seeded capability IDs (run-unit-integration-validation, read-repo-diff, etc.) ARE real catalog entries.
- Review-queue nav badge "8" was a screenshot misread of "0" (DOM-verified).
- VIB-5 closed-PR recovery packet + delivery-while-In-Progress + system fallback recommendation =
  intended honest behavior.
- D1 first-clone hint ("Cloning … · first task") works live. A1 web-egress matrix display works live.
- D2 nav label now "Instance settings" (except the 3 toasts in E-2).

---

## IMPLEMENTATION STATUS (2026-08-22) — ALL 20 FINDINGS IMPLEMENTED

Branch (main repo): `fix/pass24-parity-coherence` (see note). tsc clean; full suite green.

| ID | Fix | Files |
|---|---|---|
| A-1/A-2 | operator materialization matches the gate (update-task-branch at delivery-gate mode; coordination caps absent→off) | agents-query.server.ts |
| A-3 | connection "N public repo(s)" + countLabel | connections-panel.tsx |
| B-1 | Codex operator scratch-dir cwd (task.md read-only) + isolated prompt | operator-run.server.ts |
| B-2 | Codex operator honors web grant | codex-runtime.server.ts |
| B-3 | Codex anchored default-branch read (git show); generic definition | operator-run.server.ts, operator.definition.md, default-assets.server.ts |
| B-4 | MCP preflight without credential on Codex | specialist-mcp.server.ts, specialist-run.server.ts, operator-run.server.ts |
| B-5 | log discarded unauthorized verdict | task-actions.server.ts |
| B-6 | executeCodexPlan narrates skipped malformed steps | operator-run.server.ts |
| C-1 | noteCompletionEffectsLost in the async catch | task-actions.server.ts |
| C-2 | reconcile poller reads summary failures | reconcile-poller.server.ts |
| C-3 | writeReply/finalize separate retry (no double-post) | task-actions.server.ts |
| C-4 | C5 note gated on review stage + no question | task-actions.server.ts |
| C-5 | queued @operator fire-failure notes + settles | operator-run.server.ts |
| D-1 | getReviewQueue archived-project guard | review-queue.server.ts |
| D-2 | policy counts governed-only | policy-page.tsx |
| D-3 | notifications "Waiting on you" = authoritative decisionsRequiring | notifications.tsx, notifications-page.tsx |
| D-4 | rail member count drops ghosts | board-query.server.ts, project.tsx |
| D-5 | home running = COUNT(*) runs (matches labels + Live tab) | home-query.server.ts |
| E-1 | releaseTasksOwnedBy in every project (org-admin owners) | org-users.server.ts |
| E-2 | 3 "org settings" → "Instance settings" toasts | github-actions.server.ts |

New tests: A-1/A-2 operator polarity (agents-query.test), D-1 archived review queue, C-2 reconcileSummaryFailed,
B-1 Codex scratch cwd + isolated prompt (operator-run.test), B-2 operator web grant honored (codex-runtime.test).
Updated 7 tests for the intended behavior changes.

NOTE ON BRANCH: edits landed in the MAIN repo working tree (absolute paths), not the harness worktree.
Committed to a feature branch off main in the main repo; the empty worktree branch is unused.
