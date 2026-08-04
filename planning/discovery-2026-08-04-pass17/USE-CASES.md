# Pass 17 — executed live use cases (the enumerated ledger)

Every use case below was **executed live** during Phase B of this pass (2026-08-04),
against the real store (`docker-data`) and the real `akin-ozer/viberr` repository,
per the goal's ground rules: PR-producing tests on the viberr project only, small
sanctioned files (`qa/smoke/*`), merges/rejections exercised with `gh`, other
projects for non-PR purposes.

This file is the consolidated enumeration; the in-flight notes under-recorded it
(`LIVE-TESTING-NOTES.md` kept the walkthrough log and credentials, findings went
straight to `FINDINGS.md`). Each entry cites durable evidence — a task in the
store, a PR number on GitHub, a finding id, or a doc section — so every claim is
independently checkable today.

Legend: **Evidence** = where to look now. Findings spawned are in `FINDINGS.md`;
behaviors confirmed healthy are also summarized in `FINDINGS.md §E`.

## Identity, access, onboarding

1. **Local-account creation with temp password → forced first-login reset → land
   home.** Exercised with `mira@viberr.dev` (org Member). Spawned **F17-L11**
   (screen said "an admin reset your password" for a never-had-one account).
   *Evidence:* LIVE-TESTING-NOTES §UC-onboarding; fix in `app/routes/login.tsx`.
2. **Sign-in / sign-out round trip, whitelist copy, forgot-password guidance.**
   Re-exercised again after R17-4 (this session, live screenshots).
   *Evidence:* login.server.test.ts (loader modes, returnTo contract); R17-4
   screenshots in transcript; `app/routes/login.test.tsx`.
3. **RBAC rendering by role — Maintainer vs viewer.** "Update status" hidden from
   viewer (would 403), shown to maintainer; members-only project visibility.
   *Evidence:* FINDINGS §E; UI-37 tests in `github-view.test.tsx`.
4. **Admin force-accept authority + merge-pending nudge.** Spawned **F17-L10**
   (nudge blamed "autonomous acceptance" for a human force-accept).
   *Evidence:* FINDINGS §B; `reconcile-poller.server.ts` fix + test.

## Projects, tasks, stages

5. **Project creation via the modal** (repo-name derivation, task-key derivation,
   policy preset picker) — Autonomy Lab in Phase B; Chip Lab again this session.
   *Evidence:* `docker-data/projects/autonomy-lab/`; creation screenshots.
6. **Project archive → read-only banner → restore affordance.** (Chip Lab.)
   *Evidence:* archive screenshots; project.json `archived` flag.
7. **Task creation → operator scoping packet → goal scoped.** Spawned **F17-L3**
   (resolution prefilled the OLD goal, not the chosen deliverable).
   *Evidence:* VIB-1..VIB-6 task files; FINDINGS §B; `decision-packet.tsx` fix.
8. **Stage transitions: auto-advance at dispatch, manual moves, "Blocked or
   waiting" predicate.** *Evidence:* task.md `events` timelines (VIB-1..9);
   FINDINGS §E.
9. **Task detail "Waiting on: Human decision" clarity.** Spawned **F17-2**
   (tooltip added). *Evidence:* FINDINGS §B; `task-side-panels.tsx`.

## Operator + specialist agents

10. **Operator dispatch chooses the role-correct specialist** (Developer for code
    work, Docs Writer for docs, Reviewer for verdicts) under the engagement
    machinery. *Evidence:* FINDINGS §E; run logs on VIB-1/VIB-2 tasks.
11. **Operator-authorized delivery attribution.** Spawned the pass headline
    **F17-1** — "Opened PR" event rendered the operator as an ex-member human
    (guest pill). The first fix passed jsdom but the operator's OWN path was
    still broken — caught ONLY by re-running the live use case (VIB-8/PR #132
    still wrong → VIB-9/PR #133 verified fixed).
    *Evidence:* VIB-8, VIB-9 tasks; PRs #132/#133 (both closed, probe-only);
    `pr-open.server.ts` + `operator-actions.server.ts` + integration test.
12. **Full-autonomy operator: self-accept → "accepted (merge pending)" →
    human Complete merge → merged (R16-6 two-stage done).** *Evidence:*
    FINDINGS §E; AUT-1 events; PR #131 MERGED.
13. **Injection guardrail: hostile instruction in task content → guardrail
    blocks → ask-human packet → human answer → run resumes.** *Evidence:*
    FINDINGS §E; guardrail events in the VIB timelines.
14. **Conversational agent replies @tag the asking human and notify** (NEW-4
    convention). *Evidence:* FINDINGS §E; comment events with mention routing.

## Knowledge bases, MCP, skills

15. **KB creation + agent grounding.** PISTACHIO canary + commit-conventions KB:
    agent output demonstrably used KB content. *Evidence:* FINDINGS §E; KB files
    under `docker-data`; run transcripts.
16. **MCP server registration (everything-http) + grant + Claude run mounts it**
    (tool list visible at init). *Evidence:* VIB-7 task; FINDINGS §E.
17. **Codex MCP parity: same grant reaches Codex with tool-id underscoring**
    (`mcp__everything_http__echo`). *Evidence:* VIB-7 comparison; FINDINGS §E.
18. **Skills load per grant, no unrelated skills.** Docs Writer granted 0 skills
    loaded none; operator loads `viberr-app-expertise` only. *Evidence:*
    FINDINGS §E; run-start skill manifests in run logs.
19. **Broken MCP credential honesty.** A credential that can't decrypt read
    "auth: configured" — spawned **D8/credUnreadable** ("auth: unreadable" now).
    *Evidence:* FINDINGS §D; `resource-rows.tsx` fix + org-settings test.

## Delivery, review, GitHub governance (the PR-producing set — viberr repo only)

20. **Server-owned delivery opens the PR at the review boundary; agents never
    push.** *Evidence:* VIB-1 → PR #126 MERGED; FINDINGS §E.
21. **Claude vs Codex delivery parity from Viberr's eye** — both server-owned,
    both verdict-gated identically; Codex's missing mid-run comments surfaced
    honestly rather than faked. *Evidence:* FINDINGS §E; VIB task runs split
    across both backends.
22. **Reviewer engagement (secondary assignment) with independent verdict,
    including a forced-failure demo → verdict gates acceptance.** *Evidence:*
    FINDINGS §E; VIB review events; PR #129 (VIB-4) MERGED after verdict.
23. **Accept → merge via the app** (human-only merge, R16-6). *Evidence:*
    PRs #126/#127/#129/#130 MERGED through the acceptance flow.
24. **Reject/close a PR via `gh` → closed-PR recovery packet → operator recovery
    options (archive / reset).** *Evidence:* PR #128 (VIB-3) CLOSED; VIB-3
    stage `impl` with recovery events; R16-3 precedence respected.
25. **Externally merged PR is NOT silently adopted (R16-1 head-sha adoption).**
    Spawned **F17-L4 copy split**: `merged` (FF-safe copy) vs `closed`
    (push-conflict copy) refusals. *Evidence:* `pr-adoption.server.ts` +
    `acceptance-closed-pr.server.test.ts`; FINDINGS §A.
26. **Branch collision (stale remote task branch) → blocked packet → resolve
    loop → delivery retry.** Timing-dependent blocking variant recorded as an
    OWNER QUESTION, not guessed. *Evidence:* FINDINGS §A (F17-L4 behavior);
    branch-deletion recovery events in VIB timelines.
27. **Revision drift: extra commit pushed to the PR head after review →
    divergence surfaced at accept** (R17-1). Live probe appended a marker line
    to `qa/smoke/pass17-governed-delivery.md` via the Contents API, then
    cleaned it up. *Evidence:* FINDINGS §A; `github-reconciler` revisionDrift +
    accept-dialog "Merge head" row (live screenshot in transcript).
28. **No-diff task → first-class "Completed — no changes"** (R17-2): closes to
    Done without a PR; verdict gate carved out. *Evidence:* VIB-5/VIB-6 family;
    `delivery-decision.server.test.ts`; FINDINGS §A.
29. **Stale-branch fast-forward at execution start; merged-PR reuse refusal.**
    *Evidence:* FINDINGS §E; execution events on re-dispatched VIB tasks.
30. **PR list honesty: conflict pill + CI checks + review verdict on the GitHub
    page and execution-branches table** (F17-L6). *Evidence:* `github-pills.ts`
    `mergeablePill` + `github-view.test.tsx`/`github-route.server.test.ts`.
31. **Reconcile freshness lifecycle: manual Update status, 5-minute poller, and
    the staleness chip.** Spawned **UX-3 → R17-5** (never-synced now neutral,
    stale cache warns) — both tones live-verified this session (fresh project
    neutral; 3h-old cache warn). *Evidence:* `github-view.tsx` + chip tests;
    screenshots in transcript.

## Cross-cutting UX (the goal's stated focus)

32. **Holistic UX/coherence walk** — every surface, both themes, desktop +
    mobile: one shell, one pill vocabulary, one observation grammar, honest
    empty states, consistent attention predicate. Verdict: strongly coherent.
    Spawned UX-1 → **R17-4** (local-first login) and UX-4 (mobile kanban,
    by-design). *Evidence:* `UX-COHERENCE-REVIEW.md`.
33. **⌘K server search across projects/tasks** — anti-finding: the "nothing
    matches" was a probe race, not a bug. *Evidence:* FINDINGS §E.
34. **Notification + decision-count coherence** ("N waiting on you" counts the
    same predicate on home cards, board header, review queue, notifications).
    *Evidence:* FINDINGS §E; UX-COHERENCE-REVIEW §5.

## Test cases built from these use cases (the durable regression net)

Built during Phase D against the behaviors the use cases exercised — all in the
suite (2815 green): operator-authorized PR-open attribution (unit + integration,
`pr-open.server.test.ts`, `delivery-decision.server.test.ts`); revisionDrift
computation ahead-only (`github-reconciler.server.test.ts`) and its review-queue
subline (`review-helpers.test.ts`); merged-vs-closed adoption refusals
(`acceptance-closed-pr.server.test.ts`); noChanges roundtrip + verdict-gate
carve-out (`delivery-decision.server.test.ts`); accept-dialog divergence +
no-change copy (`task-detail-components.test.tsx`); conflict pill on both tables
(`github-view.test.tsx`, `github-route.server.test.ts`); credUnreadable +
updatedLabel (`org-settings-page.test.tsx`); delivery workspace no-commit paths
(`workspace-delivery.server.test.ts`); login layout fork R17-4
(`login.test.tsx`); freshness-chip tones R17-5 (`github-view.test.tsx`). The
UX-ruling tests were canary-verified (hand-neutered, watched fail, restored).
