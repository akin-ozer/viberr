# Pass 22 — findings ledger (2026-08-21)

Severity: HIGH (correctness/security/authority) · MED (coherence/UX/honesty) · LOW (copy/polish).
Status: OPEN → CONFIRMED-LIVE / CODE-ONLY / OWNER-QUESTION / FIXED / WONTFIX.
Every finding gets a canary'd fix in the implementation phase unless owner rules WONTFIX.

## Candidate findings (pre-implementation triage)

### F22-01 — run-operator route backend/autonomy overrides [FIXED 2026-08-21 · route no longer reads them; run always resolves the deployed profile; unused imports removed]
`app/routes/project.task.tsx:872-900` parses optional `backend`/`autonomy` on the `run-operator` action. R21-9 removed the pickers from the operator card (only `steer` is sent), but a hand-built POST can still pass these. Autonomy is clamped server-side (ruling 67), so full-autonomy escalation is blocked — but backend override is not obviously clamped. Probe: can a crafted POST run the operator on a backend the project didn't configure? Fix direction: drop the params from the route or assert they match the configured profile.

### F22-02 — schedule modal per-run backend/autonomy pickers [FIXED 2026-08-21 · R22: owner ruled REMOVE; scheduled run resolves live deployed profile at fire time]
`app/features/task-main-sections.tsx:414-451`. R21-9's rationale ("one place for the run decision; the card shows, doesn't pick") was not applied to the schedule form. Also the temporal twin of the #183 stale-backend-display bug: a frozen scheduled backend can diverge from the deployed profile at fire time. Owner question queued.

### F22-03 — read-only Codex evidence persona over-promise [RESOLVED 2026-08-21 by R22: Codex read-only sandbox removed → reviewers run workspace-write → CAN write attachments/, so the persona no longer lies]
`app/server/tasks/specialist-run.server.ts` emits the attachments-drop persona section whenever `collab.evidence`, but Codex `additionalDirectories` is only widened at workspace-write (`codex-runtime.server.ts:646-652`). A write-withheld Codex reviewer with evidence granted is told it can post files it physically cannot. Honesty gap (#179 family). Fix: gate the persona section on the sandbox actually being writable, or narrow the promise for read-only Codex.

### F22-04 — browser→egress coupling has no numbered ruling despite reversing B-AG1 posture (MED, OWNER-QUESTION)
PR #176 forces egress→direct when browser=direct, at the save layer, with NO "withheld" arm — deliberately diverging from B-AG1 (delivery repair respects explicit off). Lives only in code comments (`capabilities.ts:456-474`), no `decisions.md` entry. This is exactly the ruling-44 failure class that ruling 84 documented. Candidate for promotion to canon. Owner question queued.

### F22-05 — canon docs (prd.md / architecture.md / ux-spec) not amended for PRs #176-186 (MED, CONFIRMED)
`planning/planning-artifacts` had zero commits post-pass21. Confirmed false statement: `architecture.md:824` "attachments/ … never implemented; do not write to it" — attachments are real since R19-19 and central since #177-184. prd/ux still describe the pre-#185 operator picker and pre-#186 ownership Manage popover. Fix: amend canon with dated amendment notes (this is a doc task, allowed since canon is living).

### F22-06 — stale source comments after PR merges (LOW, CODE-ONLY)
- `task-attachments.server.ts:11-12` still says attachments have "exactly one writer today: the browser MCP server's --output-dir" — false since #179 evidence drop.
- run-operator stale comment claiming the picker still exists (per delta agent). Fix: refresh comments in touched files.

### F22-07 — "Claude Code is unavailable" run-refusal copy (LOW → OWNER-QUESTION)
`run-service.server.ts:801-803` shows "Claude Code" on a user-facing run refusal. R21-9 relabels the agent "Claude" but carves out genuine product references (CLI login, harness). Confirm this refusal is a product reference (intended) vs an agent-label leak.

### F22-08 — Codex usage-limit failure misclassified [FIXED 2026-08-21]
Live repro on VIB-1 (evidence/codex-usage-limit-repro.txt). Codex account quota is exhausted (external, until Sep 18 2026 — NOT a viberr bug). But viberr's surfacing IS a bug: the codex-sdk streams the real reason as `turn.failed`/`error` events (`"You've hit your usage limit… try again at Sep 18th, 2026 5:20 PM."`) which the adapter's event loop already receives and logs (`codex-runtime.server.ts:697`, sets `sawFatalError`), then the iterator throws a bare `"Codex Exec exited with code 1: Reading prompt from stdin…"` with no keys. `classifyCodexFailure` (`:736`) runs on the THROWN error, so the quota branch (`:447`) never matches → human gets the generic `"Codex execution failed. Review its authentication and runtime configuration."` (`:472`) and a useless providerText, sending them to check auth (which is fine). **Fix:** retain the last fatal stream event's `error.message`/`message`, redact it, and feed THAT to `classifyCodexFailure` + providerText (fall back to the thrown error only if no fatal event was seen). This makes the quota branch fire and surfaces the retry date. Claude-parity: this is the "codex and claude behave the same from viberr's eye" gap the owner named — Claude surfaces provider text (R20-3), Codex drops it here.
NOTE: this quota block means ALL live Codex runs fail this session. Codex delivery/parity use cases are limited to "viberr invokes Codex correctly + surfaces failure" (invocation layer works: SDK spawns, prompt passed, events streamed). Actual model-completion use cases run on Claude.

### F22-09 — no backend fallback when the first backend is down (MED, OWNER-QUESTION)
Developer's backend order is "Codex, Claude" but "a run uses the first" — Codex failed (quota) and the run went `blocked`, no fallback to Claude. Intended per matrix copy, but worth an owner decision: should a hard backend outage (not a task failure) fall through to the next listed backend? Queued.

### F22-10 — PR body carries stale change-summary/evidence stats [FIXED 2026-08-21 (change-summary+evidence now from live base...head compare); deeper reconcile-collision guard still open]
Confirmed with a real PR on the actual repo. Context: fresh data root reuses task keys, so VIB-1→branch `vib-1` collided with a stale remote `vib-1` (prior pass, head `17bbd2a`, login-in-red history, +214/−16 across 3 files). **Positives observed:** (a) viberr's policy-engine DETECTED the collision and posted a clear note "GitHub already has PR #178 on branch vib-1 … NOT VIB-1's review PR … Delete or rename the remote branch before delivering" — good; (b) after I deleted the stale branch, viberr pushed a fresh `vib-1` (1 commit) and opened **PR #187** whose actual diff is correct: 1 file, +5/−0, commit `c3503a1`.
**The bug:** PR #187's BODY (permanent GitHub artifact) still says `## Change summary: 3 file(s) changed (+214/-16)` and `## Evidence: 3 file(s) changed on vib-1 · +214 · −16 · 3 commit(s) delivered` — the STALE remote branch's numbers, not the actual pushed diff. The in-app delivery report likewise said "3 commit(s) delivered" (actual: 1). The PR-body/evidence stats are derived from a reconcile snapshot (or the mirror's stale ref) rather than from the actual pushed diff (`base..head`), so a human reviewer reading the PR is told the wrong scope. **Fix direction:** compute PR-body change-summary + evidence stats from the actual delivered diff at push time (workspace branch vs merge-base), never from the reconcile/mirror snapshot; and refresh the reconcile view synchronously after a delivery. Edge-triggered by task-key reuse (the app's own clean-sheet dev loop hits it constantly — see memory trap). Cleaned up stale vib-1/vib-2/vib-5/vib-7 test branches this session.

## Probe candidates from doc agents (ARCH/DOMAIN/UI/RBAC/RULINGS) — verify live
- Layering inversion #183: `projections/{task,board}-query.server.ts` import `deployedSpecialistBackends` from `features/agents/*` (server→features), + project.md reads on hottest loaders w/ silent empty-map fallback. Probe board latency + silent-fallback path.
- #177 regression risk: timeline ships `attachments[]` ungated + `attachmentsBase` unconditional, but serving route requires membership → a viewer who can see timeline but fails `requireProjectMember` (org-admin-override viewer?) gets broken `<img>` 403 tiles. Probe least-privileged viewer on a task with screenshots.
- P14 doctrine violation: #176 pinned egress row explains itself only via title/aria-label on disabled radios; disabled-reason must be RENDERED copy. Probe keyboard/touch.
- Bare-Enter on `.op-steer` starts a real operator run + posts public @operator comment, while composer requires ⌘/Ctrl+Enter — inconsistent + accidental-run risk. Probe the steer-comment-lands-but-runOperator-throws seam.
- Nested-interactive: `[![alt](attachments/x.png)](url)` → `.md-img-btn` <button> inside <a>. Probe crafted agent comment (axe nested-interactive).
- Attachments store has no quota/retention; LIST_CAP=100 hides files past 100 while on disk; mtime-window attribution may cross-attribute concurrent deliverer+reviewer files.
- Baseline-squash drift: docker-data root predating pass21 → boot WARN only, task rebuilds fail "no such column". Verify deployed root DDL is current (this container was rebuilt, likely fine).
- Lightbox focus: initial focus → "Open original" not Close; verify Escape/backdrop + focus-restore + very-tall image vs max-height 76vh.
- Owner-cell (#186): take-over gone entirely on owned tasks (not just release) — confirm Current-state copy makes the release path discoverable.
- Dead-class rot: `app.css:120` + `app.css.test.ts:392/413` name deleted `.op-sel`; `task-file.schema.ts:44` "10 timeline event types" over an 11-member array.
- R21-8 yield duplicated across hero/card/list/filter — check review-queue rows + notification inbox don't say "input required" mid-run.

## To verify live (fold results here)
- Profile-page "ACTS DIRECTLY" line counts vs Policy-page direct counts (Operator 5/2/3 etc.) — coherence.
- Hero yields on anyRunLive vs board yields only waiting==="agent" (R21-8 disagreement window).
- Steer input posts @operator comment BEFORE runOperator — refused-run dangling mention.
</content>

### R22 — Codex OS read-only sandbox removed ("viberr itself is the sandbox") [DONE 2026-08-21]
Owner ruling (2026-08-21 batch, refined): remove Codex's OS process sandbox; KEEP Claude's capability tool-enforcement unchanged; egress STAYS gated. Impl: `resolveCodexSandboxMode` never returns read-only — only an autonomous DELIVERING run with egress gets danger-full-access; everything else (operators, reviewers, supervised, egress-withheld) is workspace-write (writable + shell, network gated via networkAccessEnabled/webSearchMode). Reconciliation note: the two owner answers conflict at the extreme (danger-full-access forces network on, breaking egress gating), so egress-gated runs use workspace-write — the least-confining mode whose network toggle Codex respects. capabilityEnforcement: execute-code-or-write-repo moved to claude-only (Codex advisory now); egress stays "both". Capability-matrix modal copy updated. Tests: codex-runtime (44), runtime-registry parity (updated to the ruled asymmetry), capabilities (execute-code→claude-only). All green. Claude runtime UNCHANGED (owner kept its enforcement).

## Tier-3 probe items — addressed (2026-08-21)
### F22-13 — steer @operator comment orphaned when the run is refused [FIXED]
project.task.tsx run-operator: the steer comment was posted BEFORE runOperator; a refused run (open packet / terminal stage) stranded a directive no run addresses. Now the comment posts only when `!started.refused` (humanComment still rides the run input). The UI already disables the steer input in those states, so this closes the crafted-POST path.
### F22-14 — nested-interactive: attachment image-button inside a markdown link [FIXED]
markdown.tsx: `[![alt](attachments/x)](url)` rendered the `.md-img-btn` <button> inside the <a> (axe nested-interactive). Added a `MarkdownInsideLink` context set by the `a` override; the img override (extracted to a PascalCase `MarkdownImg` component so useContext is legal) renders the image plain inside a link, keeping the button only for standalone attachment images. +2 markdown tests.

## Tier-3 probe items — NOTED for owner (design decisions / need owner call, per "if unsure ask")
- #177 broken-image tiles for a viewer who sees the timeline but fails requireProjectMember (org-admin-override viewer): needs a specific population to reproduce; likely rare. Recommend: gate attachment thumbnails on membership or render a fallback. OWNER: is this population reachable?
- P14 doctrine: #176 pinned egress row explains itself only via title/aria-label on disabled radios (should be rendered copy). Minor a11y/polish.
- Bare-Enter on `.op-steer` runs the operator (single-line input; Enter-submit is a common pattern; button is the primary path). Debatable whether to require ⌘/Ctrl+Enter. OWNER: keep Enter, or match the ⌘↵ composer?
- Attachments store: no quota/retention; LIST_CAP=100 hides files past 100 while on disk; mtime-window attribution may cross-attribute concurrent deliverer+reviewer files. Adding quota/retention is a FEATURE — likely out of pass scope. OWNER: build it?
- Layering inversion #183: `projections/{task,board}-query.server.ts` import `deployedSpecialistBackends` from `features/agents/*` (server→features) + project.md reads on hottest loaders w/ silent empty-map fallback. May be intentional; a refactor moving the shared rule to a server module would restore the layering. OWNER: refactor?
- F22-12 agent double-post (mid-run post_comment + final envelope reply): may be intentional (two channels). OWNER: dedupe?

---

## Batch 2 — deferred items resolved (2026-08-21, owner approved "#183 layering + broken-tiles" + "Small polish set")

- **#183 layering inversion — FIXED.** New server module `app/server/agents/deployment-view.server.ts` owns `primaryRunBackend`, `deploymentRuntimeIdentity` (the single `override ?? template ?? default` resolution of kind/backends), and `deployedSpecialistBackends` — moved out of `features/agents/agents-query.server.ts` together with the pure-server `readTemplate`/`parseDeploymentDefinition`. The projection loaders (`task-query`, `board-query`, `agent-deployments`) and `specialist-run` now import from the server module (server→server); `effectiveProfileView` (still in features) imports the resolver back (features→server, allowed) and delegates its kind/backends to it, so display and run resolve one computation (no drift). Scoped-out (documented, not done): `effectiveProfileView` itself still imported by `specialist-run`/`operator-actions` — relocating the full display-view engine (capability labels, model resolution) is a separate, larger refactor; the NAMED hot-loader inversion is fully removed. Ruling 97 updated.
- **#177 broken-tiles — INVESTIGATED, membership gap does NOT reproduce; fixed the real cause instead.** The task page (`requireVisibleProject`) and the attachment route (`requireProjectMember`) both authorize through the SAME `assertProjectAction("any-member")` (org-admin D2 override included, audit rate-collapsed), and the attachments loader ships `[]` to non-members — so no viewer ever sees a tile it can't fetch. The genuine broken-tile cause is membership-independent: an attachment whose file was rotated/removed on disk (404), exceeds the route's 50 MB inline cap (413), or is an unsupported type. Fixed with a graceful fallback (`AttachmentImage`) across all three surfaces (timeline thumb, side-panel grid, lightbox): a failed image degrades to a labeled placeholder / message instead of the browser's broken-image glyph, keeping the link + filename affordance. 3 tests.
- **Bare-Enter steer — KEPT Enter, added IME guard.** `.op-steer` is a single-line input, so Enter-to-submit is the correct convention (the composer needs ⌘/Ctrl+Enter only because Enter is a newline there). The real latent bug was an Enter that merely confirms an IME candidate launching the billable run; guarded with `!e.nativeEvent.isComposing`. 2 tests.
- **#176 pinned egress row — FIXED (P14).** The disabled-reason moved from title-only (a title never opens on a disabled control) to RENDERED copy (`.cap-mnote`), kept the aria-label for AT, dropped the dead title. 1 assertion added.
- **F22-12 agent double-post — FIXED (dedupe).** `prepareAgentReplyEvent` now drops a final report that byte-matches (trimmed) the agent's own most-recent comment — the mid-run `post_comment` it was told not to repeat. Recorded honestly as `deduped: "duplicate-of-own-comment"` (not a guardrail drop) so boot recovery, which keys on the `task.agent.replied` runId audit, doesn't reprocess it. Exact-match only: a report that adds anything still posts. 2 tests.
- **Codex↔Claude profile-toggle "flakiness" (memory correction):** not a viberr bug. Picking a new backend clears the model and holds Save until an async `/resources/model-catalog` fetch returns the new backend's default (F21-13 — the guard that makes an incoherent Codex-model-on-Claude-profile pair unrepresentable). A scripted chip→Save click raced that hold; a human waits the ~200 ms. When scripting a switch, wait for Save to re-enable.

**Not done (owner did not select):** attachments quota/retention (a FEATURE, not a fix); the broader `effectiveProfileView` server→features relocation (larger refactor).

**Final gate:** 265 test files / 4167 tests green, tsc clean.

---

## Batch 2 — pre-commit adversarial review (16 confirmed findings, all addressed)

A 4-lane fable/max review of the batch-2 diff (layering / dedup / ui-polish / test-canary), each finding adversarially verified, ran BEFORE commit. It caught real regressions in the first-cut F22-12 dedup; all 16 confirmed findings were fixed:

**F22-12 dedup — 3 real regressions, rebuilt:**
- **Evidence loss (medium):** deduping a no-verdict reply dropped the run's evidence rows (the early-return ignored `evidence`). Fixed: `prepareAgentReplyEvent` now returns a `duplicate` FLAG on the event (not a drop status); a suppressed reply still lands a producing NOTE carrying its evidence + attachments, so nothing is orphaned.
- **No run-start scoping (medium):** a byte-identical reply from a PRIOR run was deduped and lost. Fixed: `duplicatesOwnCommentThisRun` bounds the match to `occurredAt >= getRun().started_at` — only THIS run's own mid-run comment, the same boundary the no-progress detector uses.
- **Transform asymmetry (medium):** the reply was compared post-`separateEvidence` while the stored mid-run text skipped it, so a >12-line fence (default config) defeated the dedup. Fixed: compare BOTH the separated and un-separated reply forms. (A workspace-path normalized only on the reply side is a documented residual — that repeat still posts, which is safe.)
- **`replyDropReason("empty")` → "meaningful-comment" (low):** an empty-reply-with-attachments audited as a guardrail drop. Fixed: `suppressedReplyReason` maps empty → null.
- Tests added: recordAgentCompletion dedup (the production finished-run path), cross-run non-dedup, evidence-on-a-note, duplicate-with-attachments.

**UI polish:**
- **Safari IME (medium):** `!isComposing` alone misses WebKit (compositionend fires before the confirming keydown); added `keyCode !== 229`. Test covers both paths.
- **Markdown embed (low):** the 3rd lightbox surface (inline `![](…)`) had no degrade; `MarkdownImg` now shows the placeholder too.
- **Transient latch + SR-label (low):** extracted a shared `AttachmentThumb` that owns the failed state, drives the anchor's aria-label (a broken tile no longer announces like a working one), and re-keys the panel tile by name+size so a re-saved file clears a stale placeholder. Dropped `.attach-broken`'s `cursor: default` (the tile is still a live lightbox trigger).

**Layering / tests (low):** repointed two stale comments (board-query cycle note, specialist-run "(agents-query)"); added `deployment-view.server.test.ts` (tolerant-decode of `parseDeploymentDefinition` + a delegation-equivalence canary proving `effectiveProfileView` and `deploymentRuntimeIdentity` resolve kind/backends identically on a disagreeing override — the single-source invariant #183 exists for).

**Scanner gotcha:** `className={someVar}` (a bare identifier) reads as a class to app.css.test.ts's no-allowlist gate; `AttachmentThumb` picks its class via an inline `variant` ternary of string literals instead.
