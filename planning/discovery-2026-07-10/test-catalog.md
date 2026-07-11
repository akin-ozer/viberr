# Viberr test catalog — 30 designed test cases across every dimension

The consolidated test-design artifact behind the whole validation effort. Each case states the
**dimension** it targets, the **rationale** (what could plausibly be wrong, given a mock-derived
build), the **method** used to exercise it, the **expected** behavior, the **observed** result on the
live app (both backends real), and the **improvement area** it surfaced (→ a fix) or "clean". Cases
were built up across three live sweeps (Test Harbor 22 tasks, Validation-Sweep 22 VSW tasks, the
42-case plan) plus a 4-dimension adversarial code hunt. Every surfaced improvement is now fixed and
regression-tested (1029 suite green); this catalog is the reference map from test → finding → fix.

Legend for outcome: ✅ behaves correctly · 🔧 surfaced a real gap, now fixed (id) · 📎 documented
limitation.

## A. Operator judgment & triage
1. **Well-scoped coding task → auto-triage.** *Dimension:* operator behaving correctly. *Rationale:* the
   operator must recognize an executable goal and move it forward, not stall. *Method:* create
   "Add rate limiting…" via API; watch the operator run. *Expected:* one operator run, advance out of
   triage. *Observed:* ✅ real Claude run recognized full scope, advanced; **surfaced 🔧#15** (2 comments/
   turn) → fixed (fold plan into action, decision E).
2. **Underspecified goal → scoping packet.** *Dimension:* operator quality gate. *Rationale:* a vague
   goal must NOT be handed to a coding agent. *Method:* create "Make the repo better". *Expected:*
   operator opens an `input` packet, no specialist assigned. *Observed:* ✅ packet "no actionable
   acceptance criteria", stayed triage.
3. **Conflicting requirements → packet.** *Dimension:* operator judgment. *Rationale:* contradictory
   asks need a human decision, not a guess. *Method:* "export must be CSV and JSON". *Expected:*
   conflict packet. *Observed:* ✅ operator opened a format-conflict packet.
4. **Ambiguous-but-plausible goal → packet asking for specifics.** *Rationale:* subtle
   under-specification (e.g. a badge needing a CI URL) should be caught. *Method:* "Add README badges".
   *Observed:* ✅ packet "need repo/CI/license specifics" — nuanced discrimination, not a blanket pass.

## B. Stage transitions & governance boundaries
5. **triage→ready auto-advance (D2).** *Dimension:* stage transitions. *Rationale:* the pre-work
   boundary should not require a human click for scoped tasks. *Method:* 16 well-scoped tasks created
   at once. *Observed:* ✅ all 16 auto-advanced triage→ready→impl with a Developer assigned, zero human
   clicks. (This BEHAVIOR was the D2 implementation.)
6. **impl→review approval boundary RBAC.** *Dimension:* RBAC triggering. *Rationale:* the code-enters-
   review gate must be admin|maintainer. *Method:* contributor then admin transition. *Observed:* ✅
   contributor 403, admin 200.
7. **review→done is human-only + full acceptance contract.** *Dimension:* invariant. *Rationale:* only a
   human accepts; acceptance must merge + write a completion event. *Method:* accept via packet.
   *Observed:* ✅ done + completion event; **surfaced 🔧H4** (a MANUAL drag to Done bypassed the
   contract) → fixed (manual→final-stage routes through acceptCompletion).
8. **Manual stage override RBAC.** *Method:* contributor manual move → 403; maintainer → 200. *Observed:*
   ✅ (non-final moves keep "change the task stage"; final-stage routes through acceptance).

## C. GitHub delivery & traceability
9. **Full delivery loop.** *Dimension:* agents do real work + traceability. *Method:* drive a task
   through impl (Codex Developer) → review → accept. *Observed:* ✅ real branch + PR opened on GitHub;
   **surfaced 🔧#31** (agent-side branch/PR were invisible to task.md) → fixed (reconcileWorkspaceDelivery).
10. **Accept never fakes a merge (D3).** *Rationale:* claiming "merged" when no server merge ran breaks
    task↔GitHub truth. *Method:* accept a task with no project PAT; cross-check GitHub. *Observed:* ✅
    task Done, pr.state="accepted", and the real PR stayed **OPEN** on GitHub (verified via `gh pr view`).
11. **Complete-merge affordance (S2).** *Rationale:* an accepted-merge-pending PR needs a way to finish
    the merge later. *Method:* accept → inspect task GitHub panel. *Observed:* ✅ "PR #N · merge pending"
    pill + "Complete merge" button (admin|maintainer); reports honestly if still blocked. (S2 feature.)
12. **Reconcile preserves "accepted".** *Rationale:* a reconcile must not silently downgrade the
    human-accepted state. *Method:* reconcile an accepted task with the PR still open. *Observed:*
    **surfaced 🔧H1** (reconcile clobbered "accepted"→"review", killing the S2 button) → fixed (preserve
    until a real terminal state).
13. **Degrade without a PAT.** *Method:* work-start on a repo-less project. *Observed:* ✅ no crash,
    honest timeline, no phantom branch/pr.

## D. Reviewers & secondary assignments
14. **Reviewer verdict → validation + quality event + notification (all paths).** *Dimension:* reviewers
    + operator correctness. *Rationale:* a reviewer's verdict must drive board health and ping the owner
    however the run started. *Method:* run a reviewer via the direct UI "Run reviewer" intent (NOT the
    operator prompt). *Observed:* **surfaced 🔧H2** (verdict only fired on the operator-prompt path) →
    fixed; **re-verified live**: quality event "Review passed" + 3 quality notifications fired.
15. **Reviewer requests changes → operator re-engages developer.** *Method:* a real review round.
    *Observed:* ✅ request-changes → validation=failing → operator routed back to the developer.
16. **Reviewer verdict classification robustness.** *Rationale:* a thorough APPROVE that says "no
    blockers" must not read as a rejection. *Method:* live VSW-3 review. *Observed:* **surfaced 🔧
    (verdict-classifier)** — negation-blind `fail`/`blocker` match → fixed (explicit-verdict priority +
    negation-aware scan).
17. **Multiple reviewers / secondary assignment.** *Dimension:* secondary assignments. *Method:* engage
    Developer-as-reviewer + Reviewer on one task; dup + remove. *Observed:* ✅ two distinct reviewers
    coexist, dup is idempotent, remove works; **surfaced 🔧H3** (operator only prompted reviewers[0];
    a later approve masked an earlier request_changes) → fixed (prompt all; rejection sticks; no
    accept while failing).

## E. RBAC (human)
18. **Viewer cannot create tasks; contributor can.** *Observed:* ✅ viewer 403 "Viewers cannot create
    tasks", no dir; contributor 200.
19. **Non-member commenting labeled (FR4).** *Method:* deniz (non-member) comments. *Observed:* ✅ 200,
    timeline actor carries `guest: true` ("app user · not in project").
20. **View-side project RBAC.** *Method:* non-member GET policy/agents/settings. *Observed:* ✅ 403
    (requireProjectMember); member viewer 200. **surfaced 🔧#26** (403 page lost the real message) → fixed.
21. **Board rescan gating.** *Observed:* ✅ contributor 403, maintainer 200.
22. **Ownership: self-service take + admin release-any.** *Method:* member take, admin release. *Observed:*
    ✅ typed events + audits (`taken`, `admin_released {forced:true}`).

## F. Comments, mentions, notifications
23. **@operator mention → operator run.** *Observed:* ✅ mention routes to the operator (single run,
    lease coalesces concurrent triggers).
24. **@human mention → notification only.** *Method:* @Elif Demir. *Observed:* ✅ mention notification to
    elif only, no agent run.
25. **Notification routing prefs filter delivery.** *Rationale:* the profile toggles must actually gate.
    *Method:* set approvals=off, then trigger a recommendation. *Observed:* **surfaced 🔧#4** (toggles
    were decorative) → fixed; verified no notification when the category is off. Seed inserts bypass the
    filter (deterministic --reset).
26. **Runtime `quality` notification.** *Observed:* **surfaced 🔧#6** (quality notifications were
    seed-only) → fixed; a real reviewer verdict now fans a quality card (re-verified in case 14).

## G. Agents: skills, MCP, backend parity
27. **Skill isolation — only declared skills load.** *Dimension:* "skills correctly loaded, not
    unrelated." *Method:* a Prober profile declaring ONE skill introspects its context. *Observed:*
    **surfaced 🔧#35** (the host's personal skills leaked in) → fixed (`skills:[]` + `settingSources:[]`);
    re-verified: Prober sees only `conventional-commits`, operator only `viberr-app-expertise`.
28. **MCP round-trip.** *Method:* grant an org stdio MCP (`everything`) to a profile; echo call.
    *Observed:* **surfaced 🔧#36** (env-replacement killed the npx spawn) → fixed (spread process.env);
    `mcp__everything__echo` round-tripped live.
29. **Codex/Claude parity from viberr's eye.** *Dimension:* backend parity. *Method:* same task shape on
    both. *Observed:* ✅ both produce real runs, replies on timeline, correct backend rows/glyphs,
    delivery captured; asymmetries (codex: no cost telemetry, **📎 no tool confinement — S3/#33**,
    prompt-folded persona) documented for the role-bindings phase.
30. **Backend availability retry (D4).** *Rationale:* a quota/availability failure should offer a retry
    on the other engine, not a dead end. *Observed:* run-projection flags `failedBackendUnavailable` +
    `altBackend`; UI shows "Retry on <other>"; genuine task failures are NOT flagged (unit-verified; a
    live quota error wasn't reproducible this session).

## H. Data-model tolerance & runtime hardening (spot cases)
- **Direct file edit → watcher reprojection** ✅ (~1.5s). **Malformed frontmatter** → diagnostics +
  **honest empty stage** (🔧#27, not phantom triage) + board "unstaged" banner. **Dir-name wins on key
  mismatch** ✅. **Board reorder + boardRank** ✅. **Session export** 🔧#32 (config-dir drift) → fixed,
  200 live. **Single-flight operator lease** ✅ (concurrent triggers coalesce). **Policy presets differ
  (S1)** ✅ (strict=all-approval, auto=operator full-autonomy) — surfaced the cosmetic-preset gap → fixed.

## Coverage matrix (user's enumerated dimensions → cases)
user assignments 18,22 · stage transitions 5–8 · reviewers 14–17 · secondary assignments 17 ·
comment usage 19,23,24 · RBAC triggering 18–21 · operator behaving correctly 1–4,7,15,H3 · agents doing
their job 9,14,27–29 · MCPs 28 · skills correctly loaded (not unrelated) 27 · codex/claude parity 29,30.

**Every improvement area this catalog surfaced is fixed and regression-tested** — see
`completeness-ledger.md` for the finding→fix map and `test-sweep-committed-2026-07-11.md` for the
raw live-run evidence.
