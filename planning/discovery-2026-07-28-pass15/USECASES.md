# Pass 15 — Live use cases (2026-07-28)

Environment: fresh docker compose instance (production build), project **Viberr (VIB)** on `akin-ozer/viberr`, Balanced policy, PAT `akin-ozer` attached. PR-based cases run ONLY against `akin-ozer/viberr`; merges via `gh` limited to small test files (no product bloat). Other projects exist for non-PR purposes.

Status: ☐ planned · ▶ running · ✅ done (verdict) · ⚠ done-with-findings

| id | area | case | status |
|----|------|------|--------|
| UC-01 | setup | Create project Viberr (VIB), Balanced, repo auto-attach | ⚠ F15-01/02/03/04 |
| UC-02 | KB | Author a knowledge base in-app (editor cluster), verify store files + freshness stamp | ☐ |
| UC-03 | MCP | Register a real MCP server (HTTP, host-side), credential, handshake, tools listed | ☐ |
| UC-04 | skills | Create new skill in-app (write mode) + one from files; verify summaries | ☐ |
| UC-05 | agents | New agent profiles (Docs-writer/Claude + another Codex), per-project grants, delivery-withheld default | ☐ |
| UC-06 | users | Add local users: maintainer, contributor, viewer personas; project roles | ☐ |
| UC-07 | flow | VIB task end-to-end: triage → operator assigns Developer(Codex) → implement on branch → Review PR | ☐ |
| UC-08 | flow | Accept completion in review queue → app merges PR → Done | ☐ |
| UC-09 | review | Reviewer engagement + approve verdict (revision-bound) | ☐ |
| UC-10 | review | Request-changes → rework → re-review → accept | ☐ |
| UC-11 | recovery | Close PR via gh (reject) → pr-diverged trigger → recovery packet (incl. archive+deleteBranch option) | ☐ |
| UC-12 | recovery | Merge PR out-of-band via gh while task in Review → reconciler + operator handle it | ☐ |
| UC-13 | engagement | Two specialists engaged simultaneously (developer + reviewer); panel clarity | ☐ |
| UC-14 | comments | Human @mentions agent → agent answers AND @tags human, notification fires (NEW-4) | ☐ |
| UC-15 | operator | @mention operator with a question → one @tag answer, no phantom runs (liveRuns truth) | ☐ |
| UC-16 | github | gh merge one PR / gh close another; viberr reflects both correctly | ☐ |
| UC-17 | RBAC | Contributor & viewer sessions: hidden vs disabled controls, rendered reasons, no privileged actions | ☐ |
| UC-18 | transitions | Manual backward move by maintainer; operator re-trigger carries fromName/toName/byHuman; honors steer | ☐ |
| UC-19 | stages | Custom stage graph (add "QA", rename); structural-role eligibility; no stranded tasks | ☐ |
| UC-20 | archive | Archive mid-flight task: packets/recs/schedules cancelled; no operator run after | ☐ |
| UC-21 | validation | Validation lifecycle: changed → "awaiting verdict" chip; healthy only via real verdict | ☐ |
| UC-22 | parity | Same task shape run by Codex vs Claude profile — identical lifecycle from viberr's view | ☐ |
| UC-23 | skills | Run spec mounts ONLY relevant granted skills (unrelated skill stays unmounted) | ☐ |
| UC-24 | KB | KB grant reaches the run; rename KB → grants rewritten (no silent orphan) | ☐ |
| UC-25 | MCP | MCP grant reaches run; up:false server does NOT mount (LV-09b); rename follows | ☐ |
| UC-26 | operator | Operator chooses correct specialist from role summaries (3+ profiles to pick from) | ☐ |
| UC-27 | policy | Second project with Strict human-gate (different repo, non-PR): every agent action gated | ☐ |
| UC-28 | policy | Autonomous-within-policy: operator with Accept-into-Done grant completes a task itself (disclosed) | ☐ |
| UC-29 | notifications | Bell lifecycle: mentions/packets/acceptance; mark-read; See-all page | ☐ |
| UC-30 | search | ⌘K search across tasks/branches/agents | ☐ |
| UC-31 | governance | Admin force-accept at the boundary (DG-2 path) — never live-proven in pass 14 | ☐ |
| UC-32 | operator | Underspecified task → triage quality gate flags → blocking packet → human redirect → recovery | ☐ |
| UC-33 | schedules | FR39 scheduled operator re-run actually fires while nobody watches | ☐ |
| UC-34 | github | Pre-existing remote branch with the task's key (collision) — how execution/delivery handles it | ☐ |

## Ledger (chronological verdicts)

### UC-13 — simultaneous specialists ✅
VIB-7: operator engaged Docs writer as SUPPORTING (`delivers:false`); it drafted content and posted a report explicitly stating "No repository files were modified by me"; Developer Claude then delivered the drafted file. Organic second proof: Reviewer engaged during VIB-2's In Progress. ⚠ UX nit: supporting engagements render under the "REVIEWING AGENTS" panel label.

### UC-14/15/29 — mentions + notifications ✅
`@operator` on Done VIB-1 → operator run fired, precise @Arda answer citing PR #109. `@Developer Claude` on Done VIB-3 → agent replied @Arda with an accurate retro; notification landed in the bell + /notifications. /notifications aggregates cross-project with a "Waiting on you · 1 decision" section (DSK-1's pending rec). Mark-read controls present.

### UC-20 — archive contract ✅
VIB-6 archived mid-flight from the right rail: confirm dialog names the NOW/AFTER/WITHDRAWN effects (including the open packet); pending 5-min schedule was cancelled and provably never fired (log watch through its window); chips show `archived`. ⚠ dead controls: schedule form still renders on archived task (F15-11 class).

### UC-27 — Strict human-gate ✅
DSK project (cc-devops-skills repo): operator capability counts equal Balanced, but the WORKFLOW rules carry the strictness — at Triage the operator produced a "Move to Ready" RECOMMENDATION instead of moving. Every boundary is human-gated. (Left pending; non-PR project.)

### UC-28 — full autonomy with explicit accept grant ✅
VAL project (Autonomous preset): preset alone does NOT grant self-accept (completion stays recommend — safety default matching FR27's "explicit grant" wording). After explicitly setting operator autonomy=Full + Accept-completion=Direct: VAL-1 ran creation→Done with ZERO human touches (~3.5 min): triage→assign→implement→direct transition→PR #116→reviewer approve→`accept_completion` by the operator, timeline: "Operator accepted completion under full-autonomy policy … merge pending (a human merges it)". Human clicked "Complete merge" → merged. Attribution and disclosure all correct.

### UC-32 — underspecified → packet → recovery ⚠✅
Front gate FAILED (F15-14): vague VIB-6 sailed to In Progress and a 91-turn broad-docs run had to be Interrupted manually. Recovery excellent: steer comment → operator @Arda ack + 3-option scope packet (structured facts, operator-pick), work parked. Resolution option "Scope goal to README quickstart" = edit_goal kind (packet stays open awaiting the edit — correct per design).

### UC-33 — FR39 schedule fires unattended ✅
"5 min" schedule on VIB-7 (attributed, reasoned) fired at 18:15:07Z ("scheduled actions fired: 1") while task waited at a rec; re-run was idempotent (no duplicate recommendation).

### UC-34 — pre-existing branch collision ❌ (F15-15, CRITICAL)
See NOTES: non-fast-forward push failure misblamed credentials; PR #114 opened on stale junk content; reviewer approved from the LOCAL branch; acceptance would have merged junk. Resolved safely via gh close → recovery packet → archive+deleteBranch (junk branch deleted by the resolution).

### UC-19 (partial) — stage editor on a live board ✅
Added stage (commits immediately with inline rename — first click minted an accidental "New stage"), renamed-by-typing, removed cleanly with transitions auto-rewiring copy. QA column live on the board with 5 Done tasks intact. Flow-through test rides VIB-9.

### UC-10 — request-changes → rework → re-review ✅
VIB-2 two-step protocol: reviewer issued "Verdict: request-changes" citing `VIB-2.md:3 STATUS: draft`; operator routed rework; developer fixed on same branch; verdict correctly reset to "awaiting verdict" on the new revision (revision-bound); re-review approved; PR #111.

### UC-11 — closed-PR recovery packet + archive+deleteBranch ✅
Closed PR #112 via gh. Reconciler (5-min poll) fired pr-diverged; operator withdrew the moot accept-recommendation with a policy note, opened the ruled recovery packet (facts: PR state/verdict/branch; options rework-and-reopen [operator pick] / archive-keep-branch / archive-and-delete-branch [deletes-branch chip]); right-rail Accept disabled with rendered reason "Not acceptable yet…". Resolved archive+delete → task `archived`, remote `vib-5` deleted. Bell count dropped on resolution.

### UC-12/16 — out-of-band gh merge while in Review ⚠
Merged PR #111 via gh while VIB-2 sat in Review. Reconciler surfaced it; GH panel flipped to "merged"; operator posted accept recommendation; Apply → Done · merged, no double-merge. **F15-13**: acceptance timeline logs "Merged PR #111 into main." attributed to the accepting human even though the PR was merged out-of-band 3 min earlier — event should say the PR was already merged.

### UC-17 (partial) — contributor + owner authority ⚠
Cem (contributor): forced temp-password reset on first login works; recommendation controls hidden; permissions panel copy is honest per-action. Took ownership (R6-2) → Apply/Dismiss revealed → **Apply on a STAGE rec returns 403 swallowed silently (F15-12)**. Accept-completion copy correctly flips to "You own this task — you can accept it → Done".

### UC-22 — Codex/Claude parity ✅
VIB-1 (Codex) and VIB-3 (Claude) delivered identical lifecycles: task-key branch, single-file commit, server-owned PR, reviewer approve, human accept, GitHub merge. Only cosmetic differences (thread.started/turn.started vs system·init log vocabulary).

### UC-23/24/25 — skills/KB/MCP reach the run ✅⚠
VIB-4 (Developer Claude): run init lists `mcp__time-mcp__current_time`+`task_key_check`, `time-mcp: connected`; tool actually called; delivered timestamp is the tool's ms-precision ISO. KB path pattern quoted verbatim from viberr-architecture KB. Commit `test(VIB-4): …` proves conventional-commits skill influenced behavior. ⚠ `search-mcp` (known-down) was still passed to the SDK and shows `status: failed` in-run — verify against LV-09b intent (should a down server be withheld, or is connect-time failure the design?).

### UC-26 — operator picks the right specialist ✅
VIB-3: picked Developer Claude on an explicit goal hint. VIB-4: picked Developer Claude (only profile holding both time-mcp and the KB) with no hint. VIB-1/2/5: picked Codex Developer (Implementation role).

### UC-08/09 — Reviewer verdict + acceptance + merge ✅⚠
Operator (run 3) summoned Reviewer directly at Review; Reviewer (Claude) verified the diff (one file, exact content, commit-date match), posted "Verdict: approve" + typed quality event → validation healthy (REAL verdict, not synthesized). Operator posted COMPLETION recommendation with honest merge-pending caveat copy. Human clicked right-rail "Accept completion → Done" → task Done · merged; **PR #109 merged on GitHub 17:50:31Z**, `qa/pass15/VIB-1.md` on main with exact content. Findings: F15-10 (no confirm on accept/merge), F15-11 (Done task keeps active accept/run controls).

### UC-07 — VIB-1 end-to-end to Review ✅ (so far clean)
Task created in Triage → operator run 1 triaged (goal well-scoped, `auto` boundary) → Ready → run 2 assigned Developer (Codex) directly, moved to In Progress, started Codex run → Developer created branch `vib-1`, wrote `qa/pass15/VIB-1.md`, validated, committed `f5282c3`, reported completion → operator posted STAGE recommendation (governed boundary honesty) → human Applied → Review + **server pushed branch & opened PR #109**. Skills loaded correctly (developer-expertise cited in first agent message). Facts: operator runtime sonnet (claude-sonnet-5), 17 tools, mcp:viberr; Codex via @openai/codex-sdk runStreamed. Findings: F15-08 (log UTC vs timeline local), F15-09 (double badge).

### UC-02/03/04/05/06 — resources & users ✅/⚠
KB authored in-app (2 docs, files verified on disk). time-mcp (stdio, 2 tools discovered via real handshake) + search-mcp (dead HTTP, honest "unreachable"). Skills conventional-commits + terraform-review created. Profiles Docs writer + Developer Claude created and deployed via Add-from-library; delivery caps granted to Developer Claude via editor; KB+MCP grants exercised (collapsible groups). Users Maya/Cem/Vera added with temp passwords, project roles Maintainer/Contributor/Viewer. Findings: F15-05 (reviewer-expertise auto-granted to every new profile), F15-06 (default caps include verdict powers).

### UC-01 — Create project ⚠
Created Viberr (VIB) via dialog; repo name auto-derived; Balanced preset. Found F15-01 (false "Every provable scope verified" with zero proven scopes), F15-02 (Update status silent no-op), F15-03 (watcher remove-reconcile on create), F15-04 (no navigation to new project). Details in NOTES.md.
