# Phase 2 — Live Test Log (2026-07-19, pass 9)

Env: docker `viberr-app-1` :5173, real backends (claude OAuth, codex CLI). Project `viberr` →
akin-ozer/viberr. Logged in as Arda (admin). PRs open against akin-ozer/viberr; merge/reject via app + `gh`.

Setup: granted developer `execute-code-or-write-repo: direct` on the canonical project.md (F14 workaround
so delivery works on current built image; the real fix lands in phase 3).

Legend: ✅ pass · ❌ fail (→ finding) · ⚠️ partial/notable.

| # | Case | Dimensions | Result | Notes |
|---|------|-----------|--------|-------|
| T1 | Create custom "Docs Writer" profile via modal (Claude/Sonnet, Ready+In Progress, doc-focused desc+persona) | create-profile modal, D6 desc/persona split | ✅ | Created `docs-writer`. Modal has NO capability toggles; defaults materialized. **Finding: modal-created specialist gets `execute-code-or-write-repo: direct`** (+ scoped delivery direct, verdict off) — so new deliverers work. Confirms docker developer's explicit `off` (F14) came from a different path, not the create modal. Desc helper text: "the OPERATOR reads this to pick the right agent". |
| T0 | Grant developer `execute-code-or-write-repo: direct` via canonical project.md edit | watcher/tolerant-parse, canonical-file edit | ✅ | Developer direct count 7→8 in UI; watcher reprojected the external edit cleanly. |
| T2 | Create Local Member user via org "Allow access" | user admin, whitelist, one-time password | ✅ | Deniz Test / deniz@viberr.dev, instance role Member, "setup pending". Temp password `SrB7gPf_khCc` (shown once). For RBAC tests. |

<!-- test creds: deniz@viberr.dev / SrB7gPf_khCc (must-change on first login) -->

### VIB-3 (Docs Writer selection + Claude delivery flow) — in progress
| T3 | Operator selects specialist by description (docs-only task) | **operator agent-selection** | ✅ **strong** | Operator picked **Docs Writer** (Claude), NOT the general Developer (Codex), for the CONTRIBUTING.md task. Confirms selection-by-desc works (generic-agents). Triage auto-passed (well-specified goal). |
| T4 | Claude specialist delivery (branch+commit) | delivery, claude backend | ✅ | Docs Writer delivered on branch vib-3 @3285bc8, 79-line CONTRIBUTING.md, docs-only. Operator recommended Move-to-Review. |
| — | Delivery-identity note | F15-adjacent | ⚠️ | Operator flagged: "agent set a repo-local git user.name/email to make the commit — confirm the delivery identity is acceptable before merge." Agent-commit path uses the agent's own git identity; Viberr auto-commit path uses `Viberr Delivery <delivery@viberr.local>`. Two identity paths — worth unifying/clarifying in impl. |
| T5 | Move-to-Review → push branch + open PR on akin-ozer/viberr | delivery, GitHub PR open, stage transition (approval boundary) | ✅ | **PR #71** `[VIB-3] Add a CONTRIBUTING.md...` opened, branch vib-3, 1 commit ahead, ONLY CONTRIBUTING.md (no stray files → F15 not triggered on agent-commit path). Task at Review. Commit author `docs-writer <docs-writer@viberr.local>` (`<profileId>@viberr.local`), clean conventional message. |
| T6 | Operator auto-summons reviewer at Review; engagements model | engagements[], single-deliverer invariant, secondary engagement, summon-reviewers cap | ✅ | VIB-3 engagements: docs-writer (delivers:true) + reviewer (delivers:false). Exactly one deliverer. Operator summoned reviewer automatically on the Review transition. |
| T7 | Reviewer validates diff/PR, posts verdict via ENVELOPE | reviewer verdict, envelope (not regex), attribution (VIB-12 fix), verdict gating→validation | ✅ **strong** | Reviewer (Claude, ran in workspace clone w/ Bash) reviewed PR #71, posted BOTH its own comment AND `# Verdict: approve`, attributed to `agent:claude/reviewer` (NOT operator). `validation: changed→healthy`, `waiting: human`. Used report_outcome envelope (6×), not regex fallback. Operator's summon prompt was detailed+correct. VIB-12 codec bug confirmed FIXED. |
| T8 | Operator generates completion recommendation after approve | operator react loop, completion-for-acceptance (human-gated) | ✅ | Operator reacted to reviewer approval → "COMPLETION — Accept completion, move VIB-3 to Done" recommendation. Human-gated. |
| **F22** | Live-run panel shows PHANTOM "running" agent after runs finish | SSE / live-run projection | ❌ **BUG** | During the reaction chain the panel showed "1 agent running · Operator · 0 turns · 0 tokens" with climbing elapsed (00:08→02:43) while disk showed all runs `result:success` and `waiting:human`. Cleared ONLY on full page reload. Stale live-run projection / missing terminal SSE event for reaction-chain runs. Verify in code (run-projection terminal event + SSE). |
| T9 | Human acceptance → merge PR via app → Done | acceptance (human-gated), app-side PR merge (real REST), Review→Done locked boundary | ✅ **strong** | Applied completion rec → VIB-3 **Done + merged**, "task closed". **PR #71 MERGED** on GitHub (merge commit 5cc603a), CONTRIBUTING.md now on `main`. Full core loop (triage→ready→impl→review→done + PR merge) works end-to-end with real agents + real GitHub. |

### ⚠️ ENV CORRECTION: docker image was STALE (pre-0d12bb6)
- VIB-2 move-to-review failed "no commits ahead" — investigated to root: the 0d12bb6 auto-commit fix was
  committed **09:46 UTC** but the running docker image was built **09:23 UTC**, so the image PREDATES the
  fix (confirmed: auto-commit string absent from `/app/build/server/index.js`). Manual `git add -A` +
  commit in the same workspace succeeds. So VIB-1/VIB-2 "no commits" failures are **stale-image
  artifacts, NOT main bugs**. F14 (execute-code-or-write-repo master-gate) remains a real *code* issue in
  main (verified by reading), but the auto-commit "didn't fire" is NOT a main defect.
- ACTION: switched testing to the **dev server** (HMR = current main), reusing `docker-data` (preserves
  GitHub connection/project/users/tasks) with isolated CODEX_HOME. All subsequent tests run current main.

### Dev server on current main (real backends, docker-data) — Flow 2 (Codex) + batch checks
| T10 | Operator picks **Codex Developer** for a code task | operator agent-selection (discriminates code vs docs) | ✅ **strong** | VIB-4 (env-check.ts code task) → operator engaged `developer` (codex, delivers:true), NOT Docs Writer. With T3 (docs→Docs Writer) this proves selection-by-description discriminates correctly across backends. |
| T11 | Skill isolation — only declared skills, Skill tool denied | skills loaded correctly (not unrelated) | ✅ | Run `init` shows **Skill tool DENIED** (`has Skill tool: False`) on reviewer + operator runs → bundled/unrelated skills not invokable. Persona injects exactly `resources.skills` by name (code path, agent-runtime.md). Reviewer's declared skill = reviewer-expertise only. Note: skill *content* lives in the system prompt (not the output-stream `.jsonl`), so it's verified via code + tool-deny, not by grepping the run. |
| T12 | Capability-gated agent toolkits per grant | agent toolkit (G3/G4), MCP wiring | ✅ | Reviewer run tools include `mcp__viberr_agent__{ask_human,post_comment,report_outcome}` (its granted collaboration caps). Operator run tools = generic `mcp__viberr__{engage_agent,run_agent,prompt_agent,get_task,set_goal,transition_stage,open/resolve_decision_packet,accept_completion,post_comment}`. Toolkits match grants + the generic-agents operator collapse. |
| T13 | Codex self-commits when properly granted (validates F14 fix) | codex delivery, F14 fix validation | ✅ | VIB-4 codex developer committed **e3cdaaf** "[VIB-4] Add environment preflight check" on branch vib-4 (I first checked mid-run before the commit). With `execute-code-or-write-repo: direct` (canBranch=true → prompt instructs commit), Codex commits. This re-confirms the earlier VIB-1/VIB-2 no-commit was F14 grant-off (+ stale image), NOT a codex-can't-commit problem. |
| **F24** | **Commit-author identity differs between Codex and Claude** | codex/claude parity, delivery identity | ⚠️ **PARITY** | Claude Docs Writer committed as `docs-writer <docs-writer@viberr.local>` (profile identity, repo-local). Codex Developer committed as `akin-ozer <ozer_akin@outlook.com>` (the **host git global identity**), NOT a profile identity. And the 0d12bb6 auto-commit net uses `Viberr Delivery <delivery@viberr.local>`. Three different author identities across paths → attribution inconsistency. For "codex and claude the same from Viberr's eye," commit author should be unified (agent profile identity for both). Impl target. |
| T14 | Reviewer approves a CODEX-delivered PR | reviewer on codex delivery, codex/claude parity (review side) | ✅ | Claude reviewer validated Codex PR #72 → `validation healthy`, operator recommends Accept. Codex delivery quality (env-check.ts) met all acceptance criteria; reviewer reviews codex-authored diffs the same as claude-authored. |
| T15 | Must-change-password flow on first login | auth, admin-provisioned local account | ✅ | Deniz's first login (temp password) forced "Set a new password — an admin reset your password"; set new password → in. |
| T16 | RBAC: Viewer (non-member) restrictions | **RBAC triggering** (UI + server) | ✅ **strong** | As Deniz (instance Member, project role = Viewer): board hides New-task/Re-scan; task page exposes NO mutating actions (no Apply/Accept/Edit-goal/Take-ownership/Run-agent), only nav + Open-on-GitHub; no `_csrf` form rendered; account menu lacks Org-settings (admin-only). A forged mutating POST → **403**. View + comment allowed (any signed-in user). Server enforcement = requireProjectAuthority (code-verified). |
| T17 | Reject PR via `gh` (out-of-band close) → reconcile → divergence | GitHub reject path, reconcile, no false auto-advance | ✅ **strong** | Closed PR #72 unmerged via `gh`. Viberr initially showed it "in review" (no scheduled reconcile). After manual Reconcile: `pr.state: closed` reflected; task **stayed at Review** (validation healthy) — did NOT auto-advance to Done. Divergence detection works. (⚠️ see F25 re: whether the close is surfaced loudly enough + stale accept rec.) |
| — | Reviewer is a genuine reviewer, not a rubber-stamp | reviewer quality | ✅ | On PR #72 the reviewer approved but flagged 3 real non-blocking test-coverage nits (whitespace branch, error-path non-disclosure, main() stream routing verified via CLI but not unit-asserted). Thorough diff review. |
| **F25** | Out-of-band PR close is under-surfaced on the task page | divergence surfacing (delivery/github) | ❌ **BUG(minor)** | After reconcile detected PR #72 closed: `pr.state:closed` updated + stale accept rec cleared (good), BUT **no timeline event and no notification** were emitted about the rejection, and the task-page PR pill shows "PR #72" with **no closed/rejected badge**. A human sees "Review · validation healthy · PR #72" with no cue the PR was rejected. delivery-github.md claims divergence is "surfaced via typed timeline event + notification" — not observed on this reconcile path. Surface it loudly (event + notification + PR-closed badge) + ideally an operator decision packet. |

## Phase 3 — Implementation live validations (dev server, current branch)
| # | Fix | Live evidence | Result |
|---|-----|---------------|--------|
| V1 | **F24** unified commit identity | VIB-5 Codex developer committed `c5f26c1` as **`developer <developer@viberr.local>`** (was host identity `akin-ozer <ozer_akin@outlook.com>` pre-fix on VIB-4). Codex now matches Claude's `<profileId>@viberr.local`. | ✅ **strong** |
| V2 | **F14** deliverer delivers | VIB-5 codex developer committed on branch vib-5 (delivery works with the granted headline). | ✅ |
| V3 | **F4** engagement labels | Task page execution profile renders "Operator / Delivering agent / Reviewing agents / Engage reviewer". | ✅ |
| V4 | **F5** home skill count | Home Agent-resources tile shows "3 skills" (was "0 skills"). | ✅ |
| — | Suite + typecheck | `tsc` 0 errors; vitest 137 files / 1389 tests green. | ✅ |

Implementation branch: `fix/pass9-delivery-capability-parity` → PR #73 on akin-ozer/viberr.
