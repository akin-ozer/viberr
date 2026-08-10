# Pass-19 — critical UI/UX walkthrough of the CURRENT app (post-#157)

Lens: holistic coherence, terminology consistency, empty/edge states, affordance
clarity, dark-mode, a11y. Run on the live dev server (localhost:5173), logged in
as owner, against the current tree (PR #157 merged code + live test artifacts).

Legend: 🟢 works well · 🟡 minor/polish · 🔴 incoherent/broken · ❓ product question

## Pages

### Home (/) — 🟢 coherent
- Greeting is a single coherent sentence with an inline decisions pill:
  "All quiet — no agent runs right now. 5 decisions waiting on you across all
  your projects." (verified via DOM; the linearized a11y tree split it, which is
  a read-tool artifact, not a UI bug).
- `main` is a deliberate 1120px centered max-width (readable measure), NOT a
  broken narrow column — the low-res screenshot misleads here.
- Project cards: Ops Sandbox (empty → "No tasks yet · ready for its first" +
  aria-label variant, correct a11y), Pass19 Verify (1 task, stage histogram),
  Viberr Core (12 tasks, "4 waiting on you", two owners). Consistent card model.
- Settings region (GitHub connections / Users & access / Agent resources) is
  a clean at-a-glance summary with accurate counts.
- ❓Q1 (minor): header shows "Notifications — 27 unread" while the hero shows
  "5 decisions". 27 unread may be steady-state noise — is notification hygiene
  (auto-read on view, decision-only filter) something you want? Holding as a
  low-priority product question.

METHOD NOTE: the 800×500 screenshot + linearized read_page manufacture phantom
"findings" (split sentences, apparent dup text). Verify every suspected UI defect
against computed DOM before recording it.

### Ops Sandbox board (empty, all lanes) — 🟢 coherent
- Header "0 tasks · 0 waiting on a human decision in this project".
- Entry lane (Triage): actionable empty state "No tasks yet — create one to
  start the flow". Downstream lanes: plain "No tasks". Good hierarchy.
- 🟢 Terminal "Done" lane omits the "New task in this stage" button — correct:
  Done is human-only terminal, nothing is created there.
- ❓Q2: Ready / In Progress / Review lanes DO expose "New task in this stage".
  In a governed model where the operator triages and advances through the
  workflow graph, dropping a brand-new task straight into "Review" (nothing to
  review yet) is semantically odd. Intended flexibility, or should new tasks
  always enter at the entry stage (triage gate)? Product question.

### Task detail (VC-7, closed-PR recovery state) — 🟢 strong
- Recovery packet is exemplary: fact table (PR state / branch / stage), three
  options (Rework=operator-pick, Archive+keep-branch, Archive+delete-branch with
  a "deletes branch" warning chip), optional operator note, and — notably — a
  paragraph naming the out-of-list re-deliver path in the GitHub panel and
  explaining "Viberr never reopens a closed one." Verified rendered inline
  (linearized read falsely split the pill).
- Execution profile: Operator / Delivering agent (Doc Writer) / Reviewing agents
  (Reviewer, engage/release) / Human owner (take-ownership) — full governed model
  with per-role controls. Coherent.
- Scheduled re-runs form (interval / backend / autonomy / reason) is distinct
  from the run-now operator control — no overlap confusion.
- 🟡 Autonomy select shows a single option "Supervised" (R19-A project ceiling).
  Honest, and the adjacent note "Project policy: supervised — raise it on the
  operator profile" explains it, so acceptable — but a 1-option <select> reads as
  an empty dropdown; could be static text until the ceiling is >1.
- ❓Q3 (minor): top chips read "In Progress · ready · awaiting verdict" while an
  OPEN blocked decision (PR closed) sits in the body. Does "ready" over-signal
  when a blocking packet is open? The packet is prominent, so low concern.

### VERIFICATION TALLY (method discipline)
- 3 suspected UI defects (broken greeting, dup empty-state text, broken packet
  sentence) ALL dissolved under DOM verification — they were read-tool artifacts.
  The current UI is coherent; do not report screenshot/linearization phantoms.

### Agents page — 🟢 strong (highlight surface)
- Capability policy renders in 3 clear tiers: "Acts directly" (assign delivering
  agent, summon reviewers, generate packets, append events, deliver+open PR) /
  "Recommends only" (stage transitions, accept into Done) / "Reserved for humans"
  (execute code / write repo, transition to Done, change policy). Excellent honest
  boundary visualization.
- Per-agent resource isolation VERIFIED: Operator → Skills:viberr-app-expertise,
  MCP:None, KB:None. Release Engineer → Skills:developer-expertise, MCP:
  release-tools, KB:release-playbook. Each profile shows ONLY its own grants — no
  decoy/cross-contamination. Directly validates "correct skills loaded" concern.
- Roster grouped Orchestration (Operator) vs Specialist profiles (Developer,
  Reviewer, Doc Writer, Release Engineer). Selecting updates ?profile= URL.
- 🟡 (my seed, not app): Release Engineer carries skill "developer-expertise" —
  a "release-engineering"/"conventional-commits" skill would fit the role better.
  Test-artifact config, not an app defect.
- TOOL NOTE: `computer left_click` via ref mis-mapped (800×500 screenshot vs
  1440×900 viewport); programmatic .click() worked. Browser-pane coord quirk, not
  an app selection bug.

### Activity (Stream + Audit logs) — 🟢 strong
- Two coherent columns: Stream (human-readable events, actor filter
  All/Humans/Agents/System, "200 of 205 events") + Audit logs (compliance).
- Stream shows REAL end-to-end orchestration on BOTH runtimes:
  • VC-12 (Release Engineer / Claude Code) yesterday 22:38→22:43: Triage→Ready→
    In Progress → agent committed qa/smoke/pass19-release.md → PR #159 → "Move to
    Review" next-step recorded ("Recorded by Viberr when the delivery landed").
  • VC-11 (Developer / Codex): operator review-REJECTED a bad
    "Marker-Convention: v3" trailer → @Developer fix → re-deliver → PR #158.
    The governed reject→rework→redeliver loop works, Codex + Claude parity live.
- Audit column verifies governance primitives render honestly:
  • R19-7 compaction: "5 / 10 / 3 / 7 runtime sessions opened — Show each".
  • R19-A: "Arda — task operator autonomy clamped · VC-2".
  • R15-1: "Arda force-accepted the completion, overriding the acceptance gate
    (VC-8's delivered revision has no approving verdict yet)".

## OVERALL CONCLUSION (current-state critical tour)
The current app (post-#157) is UI/UX-coherent and functionally strong across
every surface toured: Home, all 3 boards, task detail (recovery packet), Agents
(3-tier capability policy + per-agent resource isolation), Activity (stream +
audit). NO real UI defects found — all 3 suspected ones were read-tool artifacts
that dissolved on DOM verification. New live evidence: VC-11 (#158, Codex) and
VC-12 (#159, Claude) both delivered real PRs this cycle, incl. a review-rejection
loop. Open items are PRODUCT QUESTIONS, not bugs (see Q1–Q3 above + the new-task
entry-stage fork). Pass-19 discovery+testing+implementation is complete; PR #157
is CI-green.

### Deeper tour (owner chose "keep touring") — Policy / GitHub / Settings / org / themes
- Policy — 🟢 two-surface model explicit (human RBAC matrix w/ live role counts
  vs agent capability cards "5 direct · 2 recommend · 3 human"; "Agents never
  hold human roles"). Members-only + org-admin-override prose present.
- GitHub — 🟢 masked PAT (····k3ui), honest scope ("pull_request:write unproven —
  verified on first use"), 9 task-linked PRs w/ correct states, "Merging stays
  reserved for humans."
- Settings — 🟢 stage editor: Remove Triage/Done correctly DISABLED with titles
  ("required entry stage…", "required terminal stage…"); mid stages removable;
  per-stage task counts; invite defaults to Viewer.
- Light mode — 🟢 live contrast: card title 17.01:1, awaiting-verdict pill
  5.09:1 (AA passes in real render, R19-12 gate holds).
- Mobile 375px — 🟢 responsive: stacked controls, wrapping chips, h-scroll
  lanes. 🟡 "input required" pill truncates under card overflow dot at 375px.
- Org / Agent resources — 🟢 KB freshness ("re-scanned 4d ago"), MCP honest
  staleness ("last check passed but is stale — retest to confirm"),
  kubernetes-rollback decoy present in store (R18-5 proof), UX19-6 description
  fix visible.

## OWNER RULINGS FROM THIS TOUR (2026-08-10)
- R19-14: new tasks are created at the ENTRY stage only — remove per-lane
  "New task in this stage" from downstream lanes; server refuses non-entry
  create. (Q2 answered "Gate to entry stage".)
- R19-15: notifications AUTO-READ ON VIEW — opening a notification's target
  marks it read; the badge counts genuinely-unseen items. (Q1 answered
  "Auto-read on view".)

## RULINGS IMPLEMENTED + LIVE-VERIFIED (2026-08-10)
- R19-14 (ruling 70): server refuses non-entry stageId (names entry stage);
  board "+" on Triage lane only (live-checked all 5 lanes); NewTaskModal lost
  the stage picker, shows "Starts in Triage — the triage gate is where the goal
  is refined before work begins."; operator-at-birth ternary collapsed.
- R19-15 (ruling 71): markTaskNotificationsSeen (per-user/per-task/all kinds,
  monotonic) called from the task loader AFTER auth (verifier added the missing
  R15-4 purity pin — order swap had left every pre-existing test green).
  Live: 27→21 (VC-7, 6 rows), →20 (VC-2), →19 (VC-11).
- BONUS root-cause fix the live check exposed: useLiveUpdates only revalidated
  on reconnect-after-FAILURE, so an SSE event emitted during a scope-change
  stream reopen (exactly R19-15's view-marking emit, fired by the navigation
  itself) was lost and the badge stayed stale until the next interaction.
  Now any (re)connect that follows a previous stream pulls loaders once
  (first stream of the surface's life still excluded). Canaried; live-proven
  20→19 with NO reload. Loop-safety comment updated for the one monotonic
  loader write.
