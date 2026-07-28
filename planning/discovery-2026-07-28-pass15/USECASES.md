# Pass 15 — Live use cases (2026-07-28)

Environment: fresh docker compose instance (production build), project **Viberr (VIB)** on `akin-ozer/viberr`, Balanced policy, PAT `akin-ozer` attached. PR-based cases run ONLY against `akin-ozer/viberr`; merges via `gh` limited to small test files (no product bloat). Other projects exist for non-PR purposes.

Status: ☐ planned · ▶ running · ✅ done (verdict) · ⚠ done-with-findings

| id | area | case | status |
|----|------|------|--------|
| UC-01 | setup | Create project Viberr (VIB), Balanced, repo auto-attach | ⚠ F15-01/02/03/04 |
| UC-02 | KB | Author a knowledge base in-app (editor cluster), verify store files + freshness stamp | ✅ |
| UC-03 | MCP | Register a real MCP server (stdio + a dead HTTP one), handshake, tools listed | ✅ |
| UC-04 | skills | Create new skill in-app (write mode); verify summaries | ✅ |
| UC-05 | agents | New agent profiles, per-project grants, delivery-withheld default | ⚠ F15-05/06 |
| UC-06 | users | Add local users: maintainer, contributor, viewer personas; project roles | ✅ |
| UC-07 | flow | VIB task end-to-end: triage → assign → implement → Review PR | ✅ |
| UC-08 | flow | Accept completion → app merges PR → Done | ✅ |
| UC-09 | review | Reviewer engagement + approve verdict (revision-bound) | ✅ |
| UC-10 | review | Request-changes → rework → re-review → accept | ✅ |
| UC-11 | recovery | Close PR via gh → pr-diverged → recovery packet (archive+deleteBranch) | ✅ |
| UC-12 | recovery | Merge PR out-of-band via gh while in Review → reconciler + operator | ⚠ F15-13 (fixed) |
| UC-13 | engagement | Two specialists engaged simultaneously; panel clarity | ✅ |
| UC-14 | comments | Human @mentions agent → agent answers AND @tags human, notification fires | ✅ |
| UC-15 | operator | @mention operator → one @tag answer, no phantom runs | ✅ |
| UC-16 | github | gh merge one PR / gh close another; viberr reflects both | ✅ |
| UC-17 | RBAC | Contributor & viewer sessions: hidden vs disabled controls, rendered reasons | ⚠ F15-12 (fixed) · re-proven post-R15-4 |
| UC-18 | transitions | Manual backward move; operator re-trigger carries byHuman; honors steer | ✅ |
| UC-19 | stages | Custom stage graph (add QA); structural-role eligibility | ⚠ F15-17 (fixed) |
| UC-20 | archive | Archive mid-flight: packets/recs/schedules cancelled; no run after | ✅ |
| UC-21 | validation | Validation lifecycle: changed → awaiting verdict; healthy only via real verdict | ✅ (see post-fix §) |
| UC-22 | parity | Codex vs Claude profile — identical lifecycle from viberr's view | ✅ |
| UC-23 | skills | Run mounts ONLY granted skills | ✅ (re-proven post-fix) |
| UC-24 | KB | KB grant reaches the run | ✅ (re-proven post-fix) |
| UC-25 | MCP | MCP grant reaches the run; a down server is honest about it | ✅ (re-proven post-fix) |
| UC-26 | operator | Operator chooses the right specialist from role summaries | ✅ |
| UC-27 | policy | Strict human-gate project: every boundary gated | ✅ |
| UC-28 | policy | Full autonomy + explicit accept grant: operator closes a task itself | ✅ |
| UC-29 | notifications | Bell lifecycle; mark-read; See-all page | ✅ |
| UC-30 | search | ⌘K search across tasks/branches/agents | ⚠ F15-16 → R15-5 palette built, ✅ post-fix |
| UC-31 | governance | Admin force-accept (DG-2) — never live-proven before this pass | ✅ (see post-fix §) |
| UC-32 | operator | Underspecified task → triage gate → packet → recovery | ⚠ F15-14 (fixed) |
| UC-33 | schedules | FR39 scheduled operator re-run fires unattended | ✅ |
| UC-34 | github | Pre-existing remote branch collision | ❌→✅ F15-15 (fixed + re-proven) |

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


## Post-fix live verification (2026-07-29, rebuilt container)

Rebuilt the compose image and re-ran the repros against the real app on the SAME data root
(3 projects, 11 tasks, 4 users — all intact through the upgrade; no migration).

| what | evidence |
|------|----------|
| **B-FD1 lock** | boot log `data-root writer lock acquired … bootId 97e423fc…`; `compose stop` → **lock file gone**; `down`+`up` → clean boot. Live-caught first failure: with `npm run start`, npm was pid 1 and node its child, so SIGTERM never reached the holder — fixed by exec'ing the server binary (8a95d92) |
| **B-OP1 doctrine refresh** | boot log `refreshed an unedited shipped agent asset · agents/definitions/operator.md was da9cf46677bd now 03a4f8b7a1c2` — the stale live-store doctrine my instance had been running is gone |
| **F15-01** | credential card now reads "Credential attached — scopes not yet verified against GitHub (repo, pull_request:write). Run Grant scope to validate." — no green claim over zero proven scopes |
| **F15-05/06** | Docs writer's ACTS DIRECTLY no longer lists Approve the review / Request changes; unenforced entries render under an explicit "Advisory guidance, not policy" line |
| **R15-5** | ⌘K opens the palette on the board; typing `VIB-4` matches the task across the workspace |
| **F15-11** | on a Done task the accept button is gone entirely and Run controls are disabled (+ a rendered "Task closed — reopen it to run the operator", since a `title` is unreachable on a disabled control) |
| **F15-18** | 375px: horizontal overflow **0**, rail off-canvas at x=-234, content full width |
| **F15-08** | agent-log and timeline stamps now share one clock (both 20:xx local) |
| **R15-2** | VIB-10: the operator called `mcp__viberr__deliver_for_review` **itself** and pushed + opened PR #118 while the task was still In Progress — delivery is its decision, not a stage side-effect |
| **F15-15** | the reviewer's verdict reads "Checked the delivered revision ec0685a directly — confirmed HEAD on vib-10 equals the pinned commit" — review binds to the delivered SHA, not the local tree |
| **F15-19 / R15-1** | before the verdict: rendered "Acceptance is blocked: VIB-10's delivered revision has no approving verdict yet — run a review for a verdict, or an admin can force-accept" + the audited Force-accept affordance. No silent refusal |
| **F15-10 / R15-1** | accepting opens a confirm dialog naming PR #118 · review into main, revision ec0685a0736c, verdict validation healthy, "Merging is one-way" |
| **R15-6** | acceptance merged PR #118 **and** deleted the remote `vib-10` branch — timeline: "Deleted branch vib-10 from GitHub." |
| **F15-17** | with QA inserted after Review, acceptance is refused from the wrong stage with a rendered reason ("VIB-10 is at In Progress, not QA — a completion can only be accepted from the boundary the workflow puts before Done") |

Final gates on the merged tree: typecheck clean · **2418 unit tests** · build · **25 e2e** (incl. WCAG in both themes).
