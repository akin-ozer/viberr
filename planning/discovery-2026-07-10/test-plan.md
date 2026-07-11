# Viberr live test plan — phase 3 (2026-07-10)

Executed against the dev server with REAL backends (Claude real; Codex enabled via
`VIBERR_CODEX_USE_CLI_AUTH=1` + `CODEX_HOME`). Test project(s) created fresh so seed data isn't
polluted. Each case records: setup → action → expected → observed → verdict. Results appended in
`test-results.md`.

Conventions: run as Arda (org admin) unless stated; secondary users elif (member), murat, selin.
API = form POSTs to route actions (with CSRF) or direct file edits; UI = browser.

## A. Task lifecycle & operator core

1. **Create task → operator auto-triage.** New well-scoped task → operator run fires (trigger:create),
   posts plan, recommends triage→ready (supervised). Expect exactly ONE operator run (lease).
2. **Underspecified task → quality gate.** Vague goal ("make it better") → operator flags
   underspecified / input_required, does NOT assign specialist, asks for clarification.
3. **Approval boundary respected.** Apply operator's triage→ready recommendation as admin →
   transition lands, operator re-invoked on ready stage.
4. **Ready→impl with specialist assignment.** Operator assigns Developer (direct cap), branch
   creation attempted (no repo/PAT → clean degrade, no crash), specialist run starts.
5. **Operator NEVER transitions to done.** Full-autonomy operator on a task at review: may
   accept_completion (audited); supervised operator only recommends. Bare transition_stage to done
   must be refused even for operator.
6. **Human-only done via review queue.** Accept completion as admin → task done, validation healthy,
   completion event, PR merge attempted (degrade ok).
7. **Stuck-loop recovery packet.** Force a no-progress loop (specialist repeats reply — simulated
   codex is deterministic, good) → after repeat detection, BLOCKED recovery packet opens instead of
   silent stall.
8. **Packet resolve → redirect re-invokes operator (bug #2 repro).** Open packet, resolve with
   redirect/custom option → operator run MUST start within seconds; task must not strand at
   waiting:agent with no run.
9. **Concurrent operator triggers coalesce (bug #1 repro).** Fire two triggers <1s apart (comment
   @operator + transition) → exactly one operator run row.
10. **Interrupt a run.** Start specialist run, interrupt via UI → run state interrupted, timeline
    honest, operator does not react to empty reply.

## B. Assignment, ownership, reviewers

11. **Owner take/release + admin release-any.** elif takes ownership (member self-service); arda
    (admin) releases her; events + audit recorded.
12. **Reviewer flow with verdict.** Reviewer run on a task with real diff → request_changes verdict →
    typed quality event + validation=failing; approve → healthy.
13. **Secondary/consultant assignment.** Add Advisor as reviewer, prompt it → verify its reply does
    NOT flip validation (bug #3 — expected to fail pre-fix, retest post-fix).
14. **Remove reviewer.** Remove engaged reviewer → frontmatter updated, timeline event.

## C. RBAC & permissions (human)

15. **Viewer cannot create tasks; contributor can.** Set selin=viewer, murat=contributor in a test
    project; verify create-task UI gate + server 403 on direct POST for viewer.
16. **Non-member commenting labeled (FR4).** deniz (not a member) comments on test-project task →
    allowed, visibly labeled non-member.
17. **Boundary RBAC.** contributor murat attempts approval-boundary transition (server should 403);
    maintainer succeeds.
18. **View-side RBAC.** Non-member deniz opens policy/agents/settings routes → denied
    (requireProjectMember).
19. **Board rescan gating.** contributor murat fires rescan intent → 403; maintainer OK.

## D. Agent capability policy (RBAC for agents)

20. **Specialist cap off/human denies tools.** Developer with commit-push=human → Claude run's
    disallowedTools includes push specifiers; verify in run init envelope (9 tools / deny list).
21. **Operator capability off removes tool.** Set generate-packets=off on operator deployment →
    operator toolkit lacks open_decision_packet (check run init tools list + behavior).
22. **ALWAYS_HUMAN coercion.** Try saving profile with merge-pull-request=direct → persists as human.
23. **Full autonomy flip.** Same task, operator full autonomy: recommend-mode caps become direct;
    verify transition happens without human approval.

## E. Context resources (skills / KB / MCP)

24. **Skill isolation.** Developer profile declares developer-expertise only → run system prompt
    contains that skill body and NOT reviewer/tester skills. Codex: folded prompt equivalent.
25. **KB injection.** Profile with architecture-notes KB → KB docs in system prompt (24k budget).
26. **MCP wiring.** Add a REAL stdio MCP server org-wide (e.g. everything-server), grant to
    Developer, verify mcpServers in Claude run init and a live tool call round-trip.
27. **Unrelated resources NOT loaded.** Profile with zero skills/kb → no skill/KB sections in prompt.

## F. Codex/Claude parity

28. **Same task shape on both backends.** Two identical tasks, Developer backend=claude vs codex →
    both produce runs, replies land on timeline, run rows carry correct backend, glyphs correct;
    codex real run (thread.started envelopes) after enabling CLI auth.
29. **Codex operator plan execution.** Run operator with codex backend → structured plan → actions
    executed through gated functions (check timeline + audit).

## G. Files-first & recovery

30. **Direct file edit picked up.** Edit a task.md title/stage on disk → watcher reprojects within
    ~1s; board reflects; SSE updates open browser tab.
31. **Malformed task.md → diagnostics.** Break frontmatter (bad yaml) → readiness floors to
    blocked/inconsistency, diagnostics visible, no crash; fix file → recovers.
32. **Task created by mkdir+file.** Create tasks/TST-99/task.md by hand → appears on board with
    dir-name key winning over frontmatter mismatch.
33. **Rescan + rebuild projections.** Home admin actions work; provenance rows recorded.

## H. Notifications & watchers

34. **Packet fan-out.** Operator opens packet → owner+admins+maintainers notified (check elif's
    inbox), actor excluded.
35. **Recommendation fan-out + read-state.** New recommendation → notification; resolving packet
    marks related notification read (markTaskPacketApprovalRead).
36. **Mention notification.** Comment @elif → mention notification for elif only.

## I. GitHub delivery (real repo optional)

37. **Branch/PR degrade cleanly without PAT.** Work-start + review-entry on repo-less project → no
    crash, honest timeline, no phantom branch/pr in frontmatter.
38. **(If PAT available) full delivery loop.** Real repo: branch on work start → PR on review with
    task back-link → merge on accept. Idempotency: re-trigger doesn't duplicate.

## J. Misc product surfaces

39. **Create project via wizard.** New project from Home (template, connection pick) → project.md
    on disk, member seeded admin, base agents deployed.
40. **Timeline compaction.** Task with >40 events → compaction kicks in (compression-threshold),
    typed events survive.
41. **Board DnD reorder + boardRank persistence.**
42. **Session export.** Download resume-installer for a real run; 404 for simulated.
