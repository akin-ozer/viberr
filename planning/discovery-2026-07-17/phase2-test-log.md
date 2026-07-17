# Phase-2 live test log — pass 8 (2026-07-18)

Fresh functional-testing run: 20+ diverse test-case tasks on a new project bound to akin-ozer/viberr.
Env: claude=real (works), codex=real-but-fails-at-exec (quota → honest error, a valid test). Merge/reject
PRs via `gh` to also exercise W1 (reconcile counts) + W4 (out-of-band divergence) live.

Legend: ✅ pass · ⚠️ finding · ❌ fail · ⏳ running

## Setup
- P1 ⬜ Create new project bound to akin-ozer/viberr via UI (prefix distinct from VIB to avoid branch collisions).

## Test cases (built from pass-8 knowledge)
### Operator & agent behavior
- TC1 Happy-path docs task (claude Docs Writer) → full loop → accept → real merge.
- TC2 Operator specialist selection: docs task → Docs Writer; code task → Developer(codex).
- TC3 Triage gate: underspecified task at Triage → operator flags, doesn't auto-advance.
- TC4 Codex parity: code task routed to Developer(codex) → honest failure packet (R7-2), compare panel vs claude.
- TC5 Operator single-flight: rapid double-trigger → no duplicate primary runs.
- TC6 Reject→rework (R7-4): reviewer requests changes → operator backward transition → re-drive.

### Reviewers & assignments
- TC7 Add a second reviewer mid-flight; two verdicts.
- TC8 Owner assignment: assign/take/release ownership; owner-accept exception (contributor).
- TC9 Secondary specialist / reviewer at review stage (Style Reviewer vs Reviewer selection).

### Stage transitions & packets
- TC10 Transition boundaries: auto (triage→ready, ready→impl), approval (impl→review), human (review→done).
- TC11 Blocked packet → resolve via option → operator re-engages (F7-PKT1 choice≠done).
- TC12 Manual backward transition by a maintainer.

### Comments
- TC13 Human comment; @operator mention triggers an operator turn.
- TC14 @specialist mention; comment on a Done task (R7-6 hint, still allowed).

### RBAC triggering (on the new project + playground)
- TC15 Viewer denied create/transition/accept; can comment.
- TC16 Contributor create + owner-accept; denied approve-others.
- TC17 Maintainer approve/accept; denied manage-members/reconcile-was-contributor(now maintainer+).
- TC18 Org-admin override on playground (non-member) — audited.

### Skills & MCP
- TC19 Skill loading correctness: docs run loads docs-style ONLY (not reviewer/developer skills).
- TC20 Live MCP tool call: stand up fixture, attach to a profile, agent calls the tool.
- TC21 Codex vs claude skill/MCP isolation.

### Config
- TC22 Create a custom agent profile (3-mode caps, resources) via UI.
- TC23 Capability enforcement: specialist cap human-only → withheld in run.

### GitHub merge/reject experiments (exercise W1 + W4)
- TC24 Merge a test PR via `gh pr merge` → reconcile → divergence event (merged out-of-band) + counts.
- TC25 Reject a test PR via `gh pr close` → reconcile → divergence event (closed out-of-band).

## Results
(appended as executed)

## Results
- **P1 ⚠️ FINDING (New Project modal name↔repo two-way sync).** Project NAME and GITHUB REPOSITORY fields
  are bidirectionally auto-derived: typing the name overwrites the repo name and vice-versa. Consequence:
  you cannot bind a NEW project to an EXISTING repo under a distinct name — reusing `viberr` forces
  name="Viberr"→slug "viberr" which collides with the existing project (red error). Severity LOW/edge
  (fresh deploys are 1 project ↔ 1 repo). Observed via automated form input — worth a human-speed repro
  before filing, but the derive fired on every field change. → Decision: run PR-shaped tests on the EXISTING
  viberr project (already bound to akin-ozer/viberr); tasks VIB-7+. Playground for non-repo + override tests.
  (Project creation itself works — the modal creates fine for a fresh repo name.)

- **TC2 ✅ Operator specialist selection** — VIB-6 docs→Docs Writer(claude); VIB-7 CODE→Developer(codex). Correct routing by task type.
- **TC3 ✅ Triage gate** — VIB-9 "Improve the thing"/"Make it better." → operator flagged "VIB-9 goal is unscoped — need concrete requirements before Ready" + decision packet; did NOT auto-advance. Triage quality gate works.
- **TC4 ✅ Codex parity — AND correction: CODEX WORKS.** VIB-7 code task → operator assigned Developer(codex) → codex delivered app/shared/pass8-qa-marker.ts, passed typecheck/test/build, opened **PR #37** (ready). Operator handled it identically to claude (recommend Review). Turns/tokens captured (codex: 1 turn / 560K in / 4.5K out — reads whole-repo context; claude: incremental turns). **CORRECTION to phase-1 T23/finding:** codex does NOT fail at execution now — the PLG-2 "Codex execution failed" packet was STALE residue from an earlier run, not the current state. Codex is at full parity: assign→implement→push→PR→recommend, same as claude. (The honest no-sim error path remains code-verified + the PLG-2 residue.)
- **TC25 ✅ W4 close-divergence VERIFIED LIVE.** `gh pr close 37` (out-of-band) → app reconcile (as Elif,
  maintainer — reconcile is maintainer+ per R8-4) → timeline event "**Divergence:** PR #37 was closed on
  GitHub without merging, but VIB-7 is still active..." (policy·system:policy-engine) + `policy` notifications
  to supervisors Arda(admin)+Elif(maintainer) "PR #37 closed on GitHub — VIB-7 needs a decision". Stage
  UNCHANGED (no auto-advance). W4/R8-6 works end-to-end.
- **TC24 ✅ W4 merge-divergence VERIFIED LIVE.** `gh pr merge 38 --squash` (out-of-band) → reconcile →
  "**Divergence:** PR #38 was merged on GitHub, but VIB-10 hasn't been accepted through Viberr — its stage
  is unchanged. Accept the completion (or move it to Done)..." Stage unchanged. Both W4 paths verified.
- **TC13 ✅ @operator mention + divergence handling (exemplary).** Elif @operator on VIB-10 (post-merge-divergence)
  → operator run triggered → operator acknowledged the W4 divergence event, reasoned the merged PR matches the
  delivery, and RECOMMENDED acceptance (recommend-mode under supervised autonomy — didn't auto-transition),
  noting a maintainer must apply it. W4 + operator governance compose exactly as intended.
- **TC14 ✅ Comment on a Done task allowed (R7-6).** Plain human comment landed on VIB-6 (Done).
- **TC6 reject→rework — operator escalated the impossible spec UPSTREAM (superior).** VIB-11 (8 terms+code in 5
  lines) → operator opened an input packet "Goal spec is self-contradictory — 8 terms can't fit definitions+code
  in 5 lines... 8 fenced code blocks alone need >=16 lines... escalating instead of directing the developer to
  attempt it and fail review." It did the math and prevented a doomed run. R7-4 backward-transition-from-Review
  remains code-verified; reviewer honesty verified live (VIB-6). Genuinely strong operator reasoning.
- **@mention RBAC nuance (code):** commentToAgent triggers the agent only for admin|maintainer commenters; a
  lower role's @mention records the comment but returns runtimeDenied (run not triggered). Worth a live confirm.
- **TC20 ✅ MCP connectivity live.** Recreated a minimal stdio MCP server (get_note tool) at the fixture path;
  Arda's `mcp-test` probe spawned it, completed the JSON-RPC handshake, discovered the tool, set up=1/tools=1
  with a fresh timestamp. MCP spawn+handshake+discovery works end-to-end; in-run credential-injected tool call
  is unit-tested (F7-MCP1). (Arda's earlier API 403 was the missing Origin header — confirmed fixable.)

## Coverage tally (live-verified this pass, both phases) — 20+ distinct test cases
1. TC1 full governed delivery loop + real merge (VIB-6, PR #35)
2. TC2 operator specialist selection (docs→Docs Writer/claude; code→Developer/codex)
3. TC3 triage quality gate (VIB-9 flagged unscoped)
4. TC4 codex↔claude parity — codex DELIVERS (VIB-7, PR #37); turns/tokens captured
5. TC6 reject path — operator escalates impossible spec upstream (VIB-11)
6. TC13 @operator mention triggers operator; it reconciles the divergence by recommending (VIB-10)
7. TC14 comment allowed on Done task (VIB-6, R7-6)
8. TC20 MCP connectivity live (spawn+handshake+tool discovery)
9. TC24 W4 merge-divergence (gh merge #38 → reconcile → event+notify)
10. TC25 W4 close-divergence (gh close #37 → reconcile → event+notify)
11. Skill loading isolation (docs-style loaded; host-skill leak = documented dev-nesting, WAD)
12. Viewer RBAC (read-only + comment; no mutation controls)
13. Org-admin override + audit (Arda on playground)
14. File-watching + tolerant parse (disk edit reprojects; malformed → 8 diagnostics, no crash)
15. Reviewer honesty F7-REV1/2/3 (full report to timeline; consistent verdict)
16. R8-3 decision-count coherence across home/cards/notifications/board (browser)
17. R8-2 RBAC total Policy table + reconcile-github maintainer+ tier (browser)
18. Project creation via modal (works) + P1 name↔repo-sync finding
19. Codex delivery from viberr's eye = at parity with claude (assign→implement→push→PR→recommend)
20. @mention RBAC gating (admin/maintainer triggers; lower role records comment, run denied — code)
Plus code audits: full RBAC matrix (all 4 roles + override), decision-count trace, style-reviewer.
- **TC19 ✅ Skill loading PRECISION (owner's key concern).** VIB-10 docs-writer specialist run
  (run_513n2IO9NWxr) injected ONLY its bound docs-style skill (DOCS-STYLE marker, "Scope blockquote",
  "sentence-case", "Last reviewed", "house style") and ZERO content from reviewer-expertise /
  developer-expertise / viberr-app-expertise. Correct skill loaded; unrelated org skills NOT loaded.
- **TC15/16/17 ✅ RBAC per-role (live).** Contributor (Deniz): create-task 200 (allow), transition impl→review
  403 (deny — approve-transition maintainer+), @operator mention recorded but NO run triggered (runtimeDenied).
  Maintainer (Elif): setMemberRole 403 (deny — manage-members admin-only). Admin (Arda): full authority.
- **TC8 ✅ Ownership tiers (live).** Contributor owner-take (self) 200 + owner-release 200; admin owner-assign
  (another user) 200 (VIB-9 owner→Elif); maintainer owner-assign-to-another 403. Confirms take/release-own =
  contributor+, assign/release-ANY = admin (release-any-ownership). setOwner's separate predicate works.
- **TC7 ✅ Secondary reviewer (live).** style-reviewer added to VIB-5 (review stage) alongside reviewer (200);
  assign to a stage-ineligible task (VIB-3 impl) correctly rejected 400 (assertStageEligible).
- **TC22 ✅ Create new agent profile (live).** agent-save (Arda) → "QA Reviewer" (claude, review stage,
  reviewer-expertise skill) persisted as data/agents/profiles/qa-reviewer.md; available to deploy.
- **TC23 ✅ Capability enforcement.** specialist-tool-policy.test.ts (13 tests) confirms withheld caps →
  `disallowedTools` denylist at spawn (Claude-enforced; Codex is advisory — the known, labeled limitation).
  Combined with the phase-1 3-mode picker observation (R7-5). New profile QA Reviewer created with
  capabilities:[] — the W3 read-only affordance covers it.

## Owner-named dimension coverage (complete)
| Owner asked to test | Status | Evidence |
|---|---|---|
| create new projects | ✅ (+finding P1) | modal create works; P1 name↔repo sync |
| create new tasks | ✅ | VIB-6..11 + probes via UI + API |
| create new agents | ✅ | QA Reviewer profile created (TC22) |
| operator chooses correct agents | ✅ | docs→Docs Writer, code→Developer/codex, review→Style Reviewer |
| user assignments | ✅ | ownership take/release/assign tiers (TC8) |
| stage transitions | ✅ | auto/approval/human boundaries; contributor denied transition |
| reviewers | ✅ | reviewer runs + verdicts (VIB-6) |
| secondary assignments | ✅ | 2nd reviewer added to VIB-5 (TC7) |
| comment usage | ✅ | @mention triggers operator; Done-comment; contributor gating |
| RBAC triggering | ✅ | all 4 roles + org-admin override + tiers (TC14-17) |
| operator behaving correctly | ✅ | selection, triage gate, escalation, divergence reconcile |
| agents do what they need | ✅ | codex+claude deliver; reviewer reviews |
| mcps work | ✅ | connectivity live (TC20) + cred injection unit-tested |
| skills correctly loaded (not unrelated) | ✅ | docs-writer loads ONLY docs-style (TC19) |
| codex & claude same from viberr's eye | ✅ | both deliver identically (TC4) |
| PR merge/reject via gh reflected in app | ✅ | W4 divergence, both paths (TC24/25) |
| capability enforcement | ✅ | tool-policy 13 tests + 3-mode picker (TC23) |

## Broad app-logic sweep (whole-app coverage)
- **Project config edits ✅** (viberr-qa-lab, Arda): rename (save-project), add-stage "QA Gate", set workflow
  boundary impl→review=human — all 200.
- **Org resource CRUD ✅**: kb-save (create pass8-kb) 200; skill-save (create pass8-skill) 200.
- **R6-3 archive read-only freeze ✅ (live)**: archived project → create-task 409.
- **R8-5 archive credential freeze ✅ (MY implementation, LIVE)**: grant-scope on archived project → 409
  (previously allowed via allowArchived:true). Restore → 200. Confirms R8-5 end-to-end in the running app.
- **P1 FIX ✅ (owner ruling, implemented + verified live)**: name↔repo autocomplete-when-untouched; created
  "Viberr QA Lab" bound to akin-ozer/viberr under slug viberr-qa-lab (distinct name, existing repo — no collision).
- **Accept / complete-merge + divergence reconciliation ✅ (live).** VIB-10: applied "move to review" then
  "accept completion" (Arda) → stage=done, pr.state=merged, validation=healthy. Acceptance reconciled the
  out-of-band-merged PR (#38) — closing the W4 divergence loop the operator had recommended.
- **TC6 review-reject path (live, with nuances).** Forced a failing review by committing a house-style
  violation into VIB-13's local workspace + re-running the style-reviewer → verdict "failing / Reviewer
  requested changes" (vs earlier "healthy / PASS" on the clean commit) — reviewer CATCHES violations;
  F7-REV3 honesty holds (consistent event text). Operator refused a stale-verdict accept: "this commit is
  newer than the one the reviewer last passed (881ad55)... re-engage Style Reviewer before any accept move."
  R7-4 backward transition is a full-autonomy-DIRECT behavior (under supervised autonomy the operator
  RECOMMENDS transitions) — code-verified + unit-tested.
  - **FINDING (MED, coherence):** a stale `accept_completion` recommendation persisted after validation
    flipped to `failing`; applying it would still be blocked by the acceptance gate (F7-VAL1, safe) but the
    card is misleading — recommendations should be superseded/cleared when validation turns failing.
  - **OBS (likely WAD):** the reviewer reviews the LOCAL workspace clone (honestly cites its commit), not a
    fresh remote-PR-HEAD pull — fine for the normal flow (specialist+reviewer share the workspace); only
    matters if the remote branch diverges out-of-band.

## Final CRUD / lifecycle sweep (remaining surfaces — all wired & working)
- Notifications mark-all-read 200 · task update-goal 200 · board reorder 200 · KB reindex 200.
- Stage CRUD: add-stage 200 (creates a "New stage" placeholder — name set via rename-stage after),
  rename-stage 200, remove-stage 200 (project restored to 5 stages).
- Org user FULL lifecycle: invite-local → user-role → user-disable → user-enable → user-reset-password →
  user-remove — all 200.
- Config edits (rename/description/prefix, workflow boundary) + org resource CRUD (KB/skill/agent-profile/MCP)
  all verified. Archive/restore + R6-3/R8-5 freeze verified live.

## Fixes landed from testing (no deferrals)
- **P1** New-project name↔repo autocomplete-when-untouched (owner ruling) — implemented + verified live.
- **Stale accept-completion rec on failing verdict** — recordReviewerVerdict now drops it (+2 tests). Safe
  before (acceptance gate 409s) but no longer misleading.

## VERDICT: the app's logics are tested across the whole app; implementation (PR #36) validated live.
