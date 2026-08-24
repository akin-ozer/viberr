# Pass 26 — comprehensive live use-case + UI-tour log (2026-08-24)

Target: live container (:5173, merged main `b5b3128`, real seeded + pass-26 data). Projects: **Viberr QA 26**
(VVQX, repo akin-ozer/viberr — PR tests), Viberr (VIB), Viberr QA 25 (VQ), Viberr QA Lab (VQL, member Bora),
Viberr Strict (VS, strict human-gate). Screenshots captured earlier this session for home/board/task-detail/
new-task-modal/metadata-edit/Insights/org-settings/review-queue/recovery-packet/archive-ceremony/Agents;
the browser pane stopped compositing mid-continuation, so later coherence work uses DOM/API inspection
(more rigorous for bug-hunting — exact rendered values vs. expected) + on-disk task-file verification.

Legend: ✅ pass · ⚠️ live-confirmed finding · 📄 doc/DOM-verified.

## Live use cases exercised THIS session (≥22 distinct)

1. **UC-1 Full lifecycle → real PR MERGED** — VVQX-1: operator auto-scoped triage→ready→impl, engaged
   Developer (correct agent), delivered **PR #220** (exact 1-line file), Move-to-Review recommendation
   (honest "not the operator agent's judgement"), Reviewer verdict=approve, acceptance ceremony disclosed
   PR/revision/verdict, **real merge into main (69ba6c89a)** → Done. Traceability perfect. ✅
2. **UC-2 Reject → reconcile → recovery → archive** — VVQX-2 delivered **PR #221**, closed via `gh` →
   "Update status" flipped it to closed → operator raised a goal-AWARE recovery packet ("the goal itself
   anticipated this closure") with Rework/Archive options → archived via confirmation ceremony. ✅
3. **UC-3 New-task metadata** — VVQX-1 created with priority/labels(comma-commit)/due-date; persisted to
   frontmatter + board card. ✅
4. **UC-4 Metadata edit + urgent→board coherence** — VQ-3 high→urgent via Details panel → timeline audit
   note + board "Blocked or waiting" filter now catches it. ✅
5. **UC-5 Operator agent-selection** — operator chose Developer (Implementation) for an impl goal. ✅
6. **UC-6 Reviewer verdict gating** — reviewer engagement verdictCapable, approve→validation healthy→gated
   acceptance. ✅
7. **UC-7 Board label filter (live, my fix, hermetic)** — chips render, click narrows 10→1, active+Clear. ✅
8. **UC-8 Review-queue metadata pills (live, my fix, hermetic)** — VIB-142 shows urgent/runtime/github/due
   at the acceptance boundary. ✅
9. **UC-9 Audit export security** — CSV/JSON: no secret leakage across 1941 events, RFC-4180, formula-risk 0. ✅
10. **UC-10 Insights** — 6 stat cards + 30-day chart + breakdowns; math internally consistent. ✅
11. **UC-11 RBAC on new admin surfaces** — /insights, /audit-export, /org/settings action all
    `requireRole/requireRoleAuth("admin")` server-side. ✅ (code)
12. **UC-12 Ownership take** — VQ-3 "Assign me" → `ownerUserId` set + honest timeline note. ✅
13. **UC-13 Ownership release** — release with confirmation ceremony → `ownerUserId: null` + honest note. ✅
14. **UC-14 KB creation** — created "Pass-26 test conventions" → `docker-data/kb/pass-26-test-conventions/`. ✅
15. **UC-15 Agents page + F26-2 CONFIRMED LIVE** ⚠️ — stat "0 agent threads working" + operator hero
    "idle · engaged on 3 tasks", YET the sidebar renders **3 pulsing "working" badges** (Operator/Developer/
    Codex Dev). `workingPulseCount:3` while nothing runs — my F26-2 fix resolves this contradiction.
16. **UC-16 Capability matrix + Codex/Claude parity display** — per-capability enforcement caveats
    (execute/branch/push/PR/comment/github-read all "CLAUDE-ENFORCED"); "enforced on both backends". ✅
17. **UC-17 Skill scoping** — operator loads ONLY `viberr-app-expertise`; developer-expertise / reviewer-
    expertise scoped to their roles (no unrelated/host skills). ✅
18. **UC-18 MCP registry honesty** — `test-mcp` (HTTP localhost:9999) shows "unreachable · connection
    refused", not falsely healthy. ✅
19. **UC-19 Policy/RBAC matrix coherence** — full matrix; "Edit task priority, labels & due date" = A/M/C ✓,
    Viewer − (matches my `edit-task-meta` grant); owner-exception note intact. ✅
20. **UC-20 Search + F26-12 CONFIRMED LIVE** ⚠️ — `/resources/search?q=sec` → 0 hits though VQ-3 carries
    label "sec" (labels unsearchable); "canary" matched only via title. My F26-12 fix makes labels findable.
21. **UC-21 Notifications routing** — cross-project, project-labelled, "8 decisions" matches home; recovery
    packets honestly described. ✅
22. **UC-22 Activity feed** — 62 events, type/actor/date filters; shows **Codex Dev delivered VIB-5** (branch
    vib-5, commit f8db48d) = historical Codex/Claude delivery parity. ✅
23. **UC-23 Underspecified task → operator scoping (Strict) ✅** — VS-2 "Improve things / Make the app better":
    operator REFUSED to advance (`waiting: human`, readiness `input_required`, Strict human-gate — no
    auto-advance), raised a precise scoping packet (`"Make the app better" needs concrete scope — pick a
    deliverable`), and EXPLORED THE REAL CHECKOUT (cross-checked README + org-settings-page.tsx against
    `origin/main` to confirm real, current gaps) offering 3 grounded candidates. Exemplary operator behavior:
    honest refusal + grounded suggestions + strict gating. ⚠️ Bonus — the operator independently surfaced a
    genuine product gap (see PG26-A below).

## Product observations surfaced during testing (owner calls, not pass-26 bugs)
- **PG26-A — no in-app browse view for ORG-scoped audit events.** The operator (VS-2 scoping) noted:
  `SETTINGS_TABS` (org-settings-page.tsx) has connections/users/sso/resources but NO Audit tab, while the
  Activity page is PROJECT-scoped only — so org-scoped events (`auth.login.*`, `org.user.*`,
  `org.connection.token_replaced`, `github.pat.*`) have no in-app browse view; they exist only in the
  raw audit EXPORT (which pass-26 hardened, F26-7..11). Corroborates pass-25 PG-2. Candidate Phase-2 add:
  an org-scoped Audit tab reusing the Activity page's existing filter/date machinery. Owner call.

## Prior-pass coverage still valid (unchanged code): Codex quota-fail graceful recovery, browser capability
(VIB-4 opened example.com + attached snapshot), full RBAC member/non-member, secondary/supporting reviewer
engagement, MCP tools loading (Codex hyphen vs Claude underscore), force-accept ceremony — all pass-25
verified; none in the 24h delta or my fixes.

## Live-confirmed findings (bugs my pass-26 fixes address, now seen on the shipped container)
- **F26-2** ⚠️ agents-sidebar false "working" pulse (UC-15) — visually contradicts the fixed hero + the
  "0 working" stat on the same page.
- **F26-12** ⚠️ labels unsearchable (UC-20) — set-only field, dead to board search + ⌘K.
