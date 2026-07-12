# Findings v3 — pass 3 discovery (2026-07-12)

Sources: 3 parallel code-verification agents vs main @7c064cd + owner-eye UI walkthrough (dark theme,
seeded data, real Claude+Codex creds present). Status column tracked to closure during phase 3.
Security explicitly out of scope this pass.

## Functional / product findings

| # | Sev | Finding | Anchor | Fix direction | Status |
|---|-----|---------|--------|---------------|--------|
| F1 | MED | Agent "eligible stages" (`stages`+`spanAll`) is required at create, prominently displayed ("N of M stages", per-stage dots), but NOTHING consumes it: `DeployedSpecialistView` omits it; `pickSpecialist`/`pickReviewer` select by role-name regex with no stage check (comments claim otherwise) | agents-page.tsx:304-311; agent-profile-actions.server.ts:67; specialist-run.server.ts:1329-1368; operator-run.server.ts:863-884 | Owner ruling: wire it (carry into view, filter pickers + assignment validation) or drop the field | RESOLVED |
| F2 | MED | Notifications survive project deletion → 21 orphaned "viberr-selftest-3" rows dead-ending on 404; no cleanup on project delete or projection rebuild | notifications table; observed live | Cascade-delete notifications (and open recommendations?) for a deleted project slug; prune on rescan when project row vanishes | RESOLVED |
| F3 | LOW | Error/404 page renders light theme inside a dark-theme session (error boundary doesn't apply stored theme) | observed on /projects/viberr-selftest-3/tasks/VTC-7 | Carry `data-theme` into the root error boundary | RESOLVED |
| F4 | LOW | Task page Permissions rail ("V1 rules") contradicts enforcement: "Task owner — Reviews & accepts · that task only" and "Transition to done — Human owner only" while acceptance is admin\|maintainer (owner has no accept authority; Q2 gave owner only non-completion packet resolve) | task-detail permissions panel | Render from the same runtime matrix as policy page after D2/D5 | RESOLVED — Permissions rail renders per-role from the matrix (roleCan); dropped the misleading owner-accepts/human-owner-only copy |
| F5 | LOW | Org settings connections empty-state copy: "No connections yet — add one to create projects" implies connection required; project creation is self-serve without one (decision B) | org-settings connections panel | Verify at project-create; fix copy | RESOLVED |
| F6 | LOW | GitHub view "Grant scope" button renders in the no-credential state (nothing to grant against) | project.github view | Hide/disable grant-scope until a credential exists | RESOLVED |
| F7 | LOW | Seeded "live" runs show ELAPSED 12h+ with TURNS 0 / TOKENS 0 (drip runs resume at boot with epoch stats) — reads as broken stats to a first-time viewer | VIB-151 live pane | Seed resumer should reset startedAt | RESOLVED — registerSeededLiveFromData now re-anchors each seeded running run's started_at to (now − its elapsedSeconds) on every boot; verified live (VIB-151 15h→~7min) |
| F8 | MED | Codex quota/auth failures surface as generic run `error` (no typed reason on the row/packet); user learns nothing actionable; D4 retry is manual | codex-runtime.server.ts:211-223; wire-format.server.ts:398-403 | Type the common failure classes (auth/quota/binary-missing) into the error fact + stuck-packet body | RESOLVED |
| F9 | LOW | KB injection budget is per-declared-KB (24k × N), not a global cap — doc claims single 24k; N large KBs can blow the prompt | operator-run.server.ts:945-948; kb-injection.server.ts:40 | Decide: global budget split across KBs (likely) or document per-KB | RESOLVED — KB_INJECTION_BUDGET is now a GLOBAL cap shared across all declared KBs in both operator + specialist persona assembly |
| F10 | MED | Fresh instance (honest-empty-slate, 0 connections) can't create its first project via UI — Create button hard-disabled with 0 connections, but server only needs a non-empty `owner` string (createProject accepts owner with no bound connection). UI stricter than server; "self-serve" copy misleads | project-create dialog; project-create.server.ts:162-165 | Allow typing an owner/org login when 0 connections, or a first-run "add a connection" guided path; align UI gate with server | RESOLVED |
| F11 | HIGH | **Claude specialist cannot create its task branch in the default secure config.** `edit-other-task-branch: human` (seeded default) injects `Bash(git checkout:*)` + `Bash(git switch:*)` deny; deny wins under bypassPermissions, so `git checkout -B <own-task-branch>` and `git switch -c` are BOTH blocked — defeating the granted `create-task-branch: direct`. Delivery fails at the first git step (clone succeeded, isolation intact). Regression from P3.8 wiring of edit-other-task-branch. Under Q7 per-task workspace isolation the capability is moot anyway (one clone, no "other task branch") | specialist-tool-policy.ts:54-57; observed live on VSF-9 Claude run (primary-tgZXpXod) | Remove the broad `git checkout:*`/`git switch:*` deny from edit-other-task-branch (keep `git reset:*` at most), or drop the capability in the prune; ensure create-task-branch grant isn't defeated by a co-withheld cap | RESOLVED |
| F13 | MED | Host plugin slash-commands (deep-research, dataviz, code-review, security-review, verify, simplify…) appear in BOTH operator and specialist Claude run init envelopes — `skills:[]` closes the SDK-skill channel but not the plugin-marketplace channel (registered in the spawned config dir's `.claude.json`). `cwd` isolation (task workspace) and viberr-MCP gating DO work correctly. Largely a dev-env artifact (server runs inside a Claude-for-Desktop session; clean Docker deploy has no host plugins) but app-reference claims "no host skills/plugins leak" | claude-runtime.server.ts:196-199; claude-config.server.ts; observed in run init envelopes | Spawn Claude runs with plugins disabled / a marketplace-free config dir, or document the isolation boundary honestly (skills vs plugin-commands) | RESOLVED (as far as possible) — added `plugins: []` (3rd empty lever) + honest boundary comment. EMPIRICALLY PROVEN the residual leak is PROCESS-LEVEL inheritance: the leaked tools (CronCreate/Monitor/Workflow/SendMessage) are the PARENT Claude session's own SDK tools, inherited because the dev server was spawned inside an active Claude Code/Desktop session — above any SDK option, and IMPOSSIBLE in a standalone deployment (pristine CLAUDE_CONFIG_DIR, no parent). Declared skills DO load correctly. |
| F12 | MED | Both backends currently unable to auto-deliver: Codex quota-exhausted (errors) + Claude branch-deny (F11) → in the default config the operator assigns a specialist that cannot deliver, and nothing surfaces why (see F8). Compounding: F11 + F8 make a stuck task look "assigned, waiting on you" with no actionable signal | — | Fix F11 + F8; consider a preflight capability check before the operator assigns/starts a specialist that is guaranteed to be denied | RESOLVED |

## Role-bindings findings (feed phase-3 rework; see role-bindings-current-state.md)

| # | Sev | Finding | Status |
|---|-----|---------|--------|
| R1 | HIGH | PROJECT_CAP_MATRIX display-only; ~30 actions enforced by 5 duplicated helpers + 8 inline checks (D2/D5) | RESOLVED — app/shared/rbac.ts is the runtime source; requireAction + assertProjectAction consolidate the guards |
| R2 | HIGH | SSE explicit scope subscribe has NO membership check — any authed user can stream any project's events (full D9) | RESOLVED |
| R3 | MED | 18 of 30 capability ids dead … | RESOLVED (partial) — removed the 4 harmful/pointless ids (edit-other-task-branch, open-or-merge-pr, compress-timelines, owner-reassignment); the advisory reviewer/specialist labels are kept but honestly marked advisory vs Claude-enforced (S3) |
| R4 | MED | review + activity readable by non-members | RESOLVED — owner ruling: membership-gate both (requireProjectMember) |
| R5 | LOW | applyRecommendation has no top-level gate; auto-boundary transition rec applyable by any member | PARTIAL — apply-recommendation still inherits the underlying mutation RBAC (the deliberate seam: an applied rec re-executes under human RBAC via requireAction). Documented; auto-boundary transition is unreachable from the UI. |
| R6 | LOW | `updateTaskGoal` absent from displayed matrix rows | RESOLVED — added "Edit the task goal" row (update-goal action) to RBAC_TABLE |
| R7 | LOW | Q5 contributor≡viewer except create-task — ruling still open | RESOLVED (wire it) |

## Doc-drift corrections (app-reference.md / role-bindings-map.md readers beware)

| # | Correction |
|---|---|
| D1 | OPERATOR_DENIED_BUILTINS = Bash, Edit, MultiEdit, Write, NotebookEdit, **Task** (6, not 3) — claude-runtime.server.ts:107-114 |
| D2 | operator-run.server.ts module header FIXED this pass (Codex = structured-plan run, not always scripted) |
| D3 | `registerReplyAndReconcile` is actually `registerAgentCompletion`→`applyAgentCompletionEffects` (task-actions:1458,1499) |
| D4 | Delivery is dual-path: viberr's own PAT REST calls (ensureTaskBranch on specialist prompt, openTaskPr on review entry, mergeTaskPr on accept — never commits) + agent-side gh in workspace; reconciled idempotently to one PR record |
| D5 | resumeRun has a no-op `if (prev.backend === "simulated")` comment block (run-service:325-327) — cosmetic dead branch, delete |
| D6 | `allowedTools` doc-comments overstate: it auto-approves, doesn't confine; confinement is disallowedTools only (adapter.server.ts:45, run-service:182) |

## Verified clean (do not re-audit)

Form intents↔actions complete; profile prefs (notif routing/motion/timeline default) all consumed;
guardrails + credentialPolicy real; mcp-test/kb-reindex real probes; no TODO/stub markers; no
skipped tests; design-mock parity complete (tweaks-panel.jsx deliberately absent); frontmatter
fields consumed except agent stages/spanAll (F1); Q1/Q2/Q3/Q6/Q7/Q8/D7/D8 implementations verified
in place; honest-empty-slate intact (0 connections/MCP/PATs, no fabricated health).
