# Findings ledger — pass 7 (2026-07-16)

Severity: HIGH (core flow / owner-ruled gap) · MED (wrong or misleading) · LOW (polish/debt).
Status: OPEN / FIXED / RULED / WONTFIX. Implementation phase must close every OPEN item.

## IMPLEMENTATION STATUS (branch pass7-implementation-2026-07-16)

FIXED + tests green: F7-RBAC1 (D2 org-admin audited override, mutations-only audit),
F7-RBAC2 (12 seams → project-authority.server.ts), F7-SIM1/R7-2 (no simulation: product
fallback removed, demo-seed cut, fail-closed test gate), F7-NOTIF1 (waiting-list reconciles
live), F7-UI1/2/3 (operator-active pill on live run only, sinceLabel=stage name, merged pill),
F7-UI4/R7-6 (done-comment hint, comments stay allowed), F7-REV1 (reviewer runs don't
reconcile delivery), F7-REV2 (mandatory verdict marker in reviewer skill), F7-REV3 (no
"Review passed / failing" contradiction), F7-VAL1 (blocked packet marks readiness only +
acceptance guards open blocked packet), F7-OP1 (server single-flight primary run),
F7-FLOW1/R7-4 (operator rework backward transition), F7-GH5 (un-draft PR before merge),
F7-VEST1 (seed-resumer deleted), F7-PKT1 (operator persona: resolution=choice not proof),
F7-RES4 (trusted-resource provenance banner), audit-noise (override reads not audited).
IN FLIGHT (isolated-cluster agents): F7-CAP1/R7-5 (3-mode specialist picker), F7-RUN1 (codex
failure classification), F7-BOOT1 (boot recovery backoff), F7-RES3 (viberr toolkit off
specialist MCP picker), F7-UX1 (workspace-relative report links).
PENDING (me, after F7-RES3 lands): F7-MCP1 (MCP secret:// injection, ruling 8).

## Role bindings (the pass-7 rework focus)

- **F7-RBAC1 · HIGH · OPEN (RULED R7-1: implement) — D2 org-admin emergency override is NOT implemented on main.**
  Owner ruling D2 (pass-5, explicit): org admins have visible, audited emergency project-admin
  authority without membership (`org_admin_override` audit). Verified absent: every mutation
  guard resolves from project.md members[] only; org-admins can read all (home/SSE) but 403 on
  any non-member project surface (read/act asymmetry). Scope confirmation → owner Q&A.
- **F7-RBAC2 · MED · OPEN — the 12 rework seams** (rbac-inventory.md §9): hardcoded
  ["admin","maintainer"] rescan gate; two ROLE_RANK scales; run-agents inline ×5;
  invite/remove on edit-policy vs setMemberRole on manage-members; owner-exception logic
  duplicated (requireAcceptCompletion vs inline resolvePacket vs setOwner hardcode); dual
  archived gates; role-list paths invisible to Policy table; view/comment row overstates
  (comment checks NO membership); requireProjectAdmin naming.

## Honesty / governance

- **F7-SIM1 · RULED (R7-2: don't simulate at all) — simulated reviewer verdicts govern, unmarked.**
  Superseded by the bigger cut: remove the product simulated fallback entirely (honest
  backend-unavailable error + blocked packet), strip fabricated runs from demo seed, keep a
  test-only adapter for e2e (fail-closed outside test). Implementation: F7-SIM1 work item
  becomes "execute R7-2".
- **F7-NOTIF1 · MED · OPEN — "Waiting on you" never clears resolved decisions.** Notifications
  page "Waiting on you · 2 decisions" still lists VIB-1 operator recommendations hours after
  they were applied and the task hit Done. Waiting-list membership should reconcile with live
  packet/recommendation/task state (resolved/applied/closed ⇒ drop out), independent of read.
- **F7-UI1 · LOW · OPEN — "operator active" pill = attachment, not activity** (renders on a
  closed Done task next to "task closed"; execution-profile.tsx:522-526).
- **F7-UI2 · LOW · OPEN — "coordinator · stage 2" sinceLabel is a stage INDEX**
  (mapping/task.server.ts:144) — render the stage name.
- **F7-UI3 · LOW · OPEN — displayReadiness "accepted" pill on a merged/Done task** (board card +
  task header) reads stale next to the GitHub card's "merged"; consider "completed"/"merged"
  vocabulary once merged.

## Live-phase discoveries (phase 2)

- **F7-REV1 · HIGH · OPEN — the reviewer's full report never reaches the timeline (or the PR).**
  Live evidence VIB-2/PR #29: reviewer (claude) produced a rich, correct request-changes report
  (2k chars — found a real doc inaccuracy re: VIBERR_DATA_ROOT vs playwright.config's hardcoded
  e2e data root), but the task timeline recorded ONLY the bare quality event ("Validation:
  failing. Reviewer requested changes."). No reviewer comment event exists; nothing was posted
  to the PR. Downstream: the operator paraphrased "see review comments on the PR" (none exist),
  its escalation packet says "no other detail captured", and the rework prompt told the dev to
  "pull the reviewer's actual PR comments" — a wild-goose chase. Root-cause in phase 3
  (agent-reply extraction/guardrails path for reviewer completions); the verdict-classifier
  reads the full text, so the text exists at classification time.
- **F7-OP1 · HIGH · OPEN — duplicate concurrent primary runs on one task; no server-side
  single-flight for specialists.** Live evidence VIB-2 12:33–12:34: packet-resolve + manual
  backward transition queued two sequential operator turns; turn 1 started codex dev run
  run_tY5w6O3mSZ_z; turn 2 OBSERVED "last action queued a Developer run but no report has
  landed yet" and still started run_oT_h_DGvIgo_ — two codex processes sharing
  tasks/VIB-2/workspace/viberr (git index/branch race, double push risk). The operator lease
  guards OPERATOR runs only; specialist dispatch has no per-task in-flight guard (contrast:
  PLG-1's operator declined to duplicate purely by judgment). Fix shape: server-side guard in
  startSpecialistRun (active primary run for task ⇒ 409/skip), plus operator toolkit hint.
- **F7-REV2 · HIGH · OPEN — unclear reviewer verdicts spin repeated reviewer re-runs.** Live
  VIB-5: the style-reviewer approved in substance but opened with "The task is already
  complete. This appears to be a repeat/verification invocation" — classifyReviewerVerdict
  found no clear signal → no quality event, validation stayed `changed` → the operator
  re-ran the reviewer AGAIN (3 reviewer runs + interleaved operator turns before settling).
  Each cycle costs real tokens. Fix shape: (a) reviewer prompt/persona must demand an explicit
  verdict marker (e.g. "VERDICT: approve|request-changes" — D15's structured marker idea),
  (b) classifier falls back to asking the operator to interpret, (c) server-side dedupe of
  identical reviewer dispatches (same class as F7-OP1). Related root-cause data for F7-REV1:
  VIB-5's reviewer report DID post to the timeline while VIB-2's (starting with "## Review
  verdict:" heading) did NOT — compare extraction paths on these two runs in phase 3.
  ROOT-CAUSE PROGRESS (phase 3 inline): NOT the extractor (both runs' last assistant text
  line was the full report: 3314/1621 chars), NOT the meaningful-comment guardrail (audit
  `task.agent.replied {runId}` for run_Sq72KU_Vy3QV has no droppedByGuardrail), NOT compaction
  (compactTimelineEvents guards `actor.kind !== "agent"` and there are 0 markers on VIB-2).
  Remaining suspects for the wave: (a) `reconcileWorkspaceDelivery` runs for REVIEWER runs too
  (kind not checked) — a reviewer's clone can be on the task branch and its read-modify-write
  of task.md may race the just-posted comment (both awaited in applyAgentCompletionEffects but
  the reviewer clone read/write + reproject sequence is a candidate for a lost update); (b)
  reviewer runs shouldn't reconcile *delivery* at all (reviewers don't deliver). Repro via a
  test that runs a reviewer completion whose reply is long + whose clone is on the task branch,
  assert the agent reply comment survives. Also gate reconcileWorkspaceDelivery to primary kind.
- **F7-FLOW1 · MED · OPEN — no agent-drivable rework path out of a failed review.** Developer
  is stage-eligible Ready/In Progress only (seeded default), Review's only forward edge is
  Done, and the operator can't move a task backward — every failed review requires a human to
  (1) resolve the packet AND (2) manually transition Review→In Progress before the operator
  can re-drive. Options: teach the operator a backward transition on failing validation,
  or make packet-resolution apply the chosen redirect, or default the Developer
  review-eligible. Product decision; ask owner at next checkpoint.
- **F7-UX1 · LOW · OPEN — agent reports link absolute host paths** (e.g.
  `/Users/akinozer/projects/.../workspace/...md`) — useless/broken links for anyone else;
  workspace-relative paths or repo links wanted. Seen in both codex dev reports (VIB-2, PLG-1).
- **F7-RES3 · LOW/QUESTION · OPEN — the in-process `viberr` operator toolkit is offered as an
  attachable MCP for SPECIALIST profiles** in the resource picker ("MCP servers · 0 of 2":
  notes-fixture + viberr). Specialists with the operator's coordination toolkit would blur the
  operator/specialist boundary; probably filter it from the specialist picker.
- **F7-VAL1 · HIGH · OPEN — blocked packets set validation=failing, bricking acceptance with
  misleading copy.** operatorOpenPacket type=blocked writes `validation="failing"`
  (operator-actions.server.ts:516, "FR24") even when NO reviewer ever ran; resolving the
  packet restores readiness but never clears validation (resolvePacket clears it only via the
  accept_completion option); the acceptance gate then 409s with "latest review is failing —
  rework and re-review" — nonsense when no review exists. Live repro preserved: VIB-4 (impl,
  readiness=ready, validation=failing, accept 409 for owner AND would 409 for admin).
  Fix shape: blocked-ness lives on `readiness` alone; `validation` stays review-owned
  (only classifyReviewerVerdict/accept write it); or at minimum packet-resolution restores the
  prior validation and the 409 copy distinguishes blocked-vs-rejected.
- **F7-CAP1 · MED · OPEN — specialist capability mode "recommend" is runtime-equivalent to
  "direct".** Live evidence: Docs Writer had open-review-pr=recommend yet opened PR #30
  directly. isWithheld denies only human/off; the prompt contract includes non-withheld steps;
  nothing implements a "recommend" behavior for specialists (that's an operator-only concept).
  The 4-mode picker on specialist caps is therefore misleading — either implement recommend
  for specialists (report-back instead of act) or collapse the picker to Allowed/Human-only
  for specialist-scoped caps with honest copy.
- **F7-PKT1 · MED · OPEN — packet resolution is conflated with action completion.** Live:
  VIB-4's blocked packet was resolved with the "Human commits and pushes the staged file"
  option, the human did NOT do it, and the operator's next turn asserted the commit/push had
  happened when re-engaging the specialist — which then disproved it via git and disputed the
  operator (second packet opened). Custom/human-action options carry no pending/done state and
  the operator receives no signal distinguishing "picked" from "performed". Fix shape:
  resolution records the CHOICE; operator prompts must carry live repo/task state, not the
  option text as fact (and/or human-action options get a confirm-when-done affordance).
- **F7-RES4 · MED · OPEN — org skills/KB can be flagged as prompt-injection and ignored by
  the specialist.** Live: the docs-style skill + testing-conventions KB (org-authored, admin-
  attached) were flagged "⚠️ Prompt-injection" by the claude specialist on VIB-4's second run
  and their instructions refused (first run complied — nondeterministic). Trusted org
  resources need a presentation that marks their provenance/authority explicitly in the
  system prompt, or agents will second-guess exactly the content admins intended to bind.
- **F7-GH5 · LOW · OPEN — agent-opened DRAFT PRs block acceptance merges.** Codex's gh opened
  PR #29 as a draft; accept → merge-pending; complete-merge honestly reported "GitHub can't
  merge it yet: Pull Request is still a draft" but offers no fix. Options: server marks the PR
  ready at merge time (PAT can), and/or the delivery contract instructs agents to open
  non-draft PRs. (After `gh pr ready` the same complete-merge merged cleanly.)
- **F7-UI4 · LOW · OPEN — comments are accepted on Done/closed tasks** (probe comments landed
  on VIB-1 post-merge). Decide: allow (audit trail) or gate like archived.
- Observation: profile create modal race — resource chip clicked in the same tick as submit
  didn't persist (mcps: [] first try; edit modal worked). Likely React state flush; verify a
  human-speed repro before filing as a bug.

## Runtime

- **F7-RUN1 · MED · OPEN — failure-reason classification is effectively Claude-only.** A3's
  classified terminal err line exists only in the claude adapter; codex redaction leaves the
  generic line → runFailureReason classifies `unknown` → generic escalation copy for codex
  quota/auth failures. At minimum classify codex failures in-adapter (it already has in-memory
  classification pre-redaction) and persist the classified reason.
- **F7-BOOT1 · MED · OPEN — finalizeOrphanedRuns re-invokes the operator on EVERY boot with no
  backoff/attempt cap** (run-recovery.server.ts:78) — a crash loop re-fires real operator runs
  each boot (cost + noise amplification).
- **F7-VEST1 · LOW · OPEN — seed-resumer vestigial wiring** (routes/project.task.tsx:47,91)
  + boot.server.ts:131 comment claims it was "replaced". Remove or fix comment.

## Integrations (already-ruled, still unimplemented)

- **F7-MCP1 · MED · OPEN — MCP `secret://` credential injection unfinished** (pass-4 ruling 8:
  WIRE IT). specialist-mcp.server.ts resolves configs but drops cred refs. Needs the secret
  store → HTTP headers / stdio env at spawn + a live-MCP test (F-RES1 fake seed URL is gone —
  fresh org has 0 MCPs).

## Carried standing items to exercise live (phase 2)

- Codex quota status (F-RUN2 pass-6; memory says exhausted til ~Aug 2026 — verify).
- KB re-scan really re-indexes (F-RES2).
- Codex Live-panel TURNS/TOKENS mid-run (F-PARITY1, cosmetic).
- Landlock/codex-in-compose (F-DOCKER2) — out of scope locally; documented.

## Session/user observations

- PR #23 shows MERGED on GitHub (merge commit 52ecf6b, 2026-07-13) but main's history lacks it —
  merged then force-pushed away. Historical oddity; no action, documented so nobody "re-merges".
