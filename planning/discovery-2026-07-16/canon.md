# Viberr product canon — as of 2026-07-16 (main @ 81dafe3)

Self-contained digest of all prior discovery/fix passes. A fresh agent can rely on this doc alone.
Sources: `planning/discovery-2026-07-10/` (pass 1), `planning/discovery-2026-07-11/` (pass 2),
`planning/discovery-2026-07-12/` (pass 3), `planning/discovery-2026-07-12-pass4/` (pass 4, incl.
`prior-canon.md`), and `planning/discovery-2026-07-13/` (pass 5 — **exists only on the unmerged
branch `codex/full-pass-2026-07-13`, draft PR #23**; read it via `git show`). The 2026-07-13 ultra
code review has no report file in `planning/` — its record is assistant memory
(`code-review-pass5-2026-07-13`) plus the branch's `adversarial-review-remediation.md`.

**Critical repo-state fact:** `main` (81dafe3) is the pass-4 state. Pass 5 ("harden governed
delivery", ~26k-line diff by GPT-5.6 Codex, F01–F41 + H01–H08, 1565 tests) lives on draft PR #23
(`codex/full-pass-2026-07-13`, tip 3a469f9) and a further branch
`codex/e2e-product-hardening-2026-07-13` (adds cc645b2, 4fc32f0, 9c57af2). **None of pass 5 is on
main.** Anything below marked "(branch-only)" is not in the shipped tree.

---

## 1. What viberr is — product summary

Governed AI software delivery for small teams: **agents are the native workers; humans govern
flow, review, and acceptance.**

- **Task file = canonical operating contract.** One markdown file per task
  (`data/projects/<slug>/tasks/<KEY>/task.md`): frontmatter (stage, readiness, waiting, owner,
  specialist, reviewers, recommendations, branch/repo/pr, validation) + `## Goal` + `## Packet`
  (fenced yaml) + `## Timeline` (typed events, newest-first). **Files are truth; SQLite
  (`data/state/projection.sqlite`) is a rebuildable projection** (only
  users/sessions/secrets/audit/notifications are app-owned). chokidar watcher → reproject → SSE.
- **Projects** (`project.md`): stages (default 5: Triage/Ready/In Progress/Review/Done; or
  Lightweight 3), per-transition boundaries (`auto` | `approval` | `human`; review→done locked
  `human` — but see ruling 24 for what "boundary" governs), members (4 project roles), agent
  deployments + capability grants, guardrails, credentialPolicy. Org roles: admin/member only.
- **Agent roster = Operator + Developer + Reviewer** (Advisor removed; Tester merged into
  Reviewer). Profiles (`data/agents/profiles/<id>.md`) carry capabilities
  (mode `direct|recommend|human|off`), resources (skills/KB/MCP), backend (claude|codex|simulated),
  model, eligible stages (enforced). Definitions (`data/agents/definitions/<id>.md`) = persona prose.
- **The operator** coordinates each active task via an in-process `viberr` MCP toolkit gated per
  capability: reads the task, posts ONE comment per turn, assigns/prompts specialists and
  reviewers, transitions stages, opens **decision/blocking packets** (observations + 2–4 options,
  one recommended), and — only with explicit `completion-for-acceptance: direct` — accepts
  completion. React loop: agent completion → operator reacts (depth cap 4, no-progress guard →
  stuck-loop recovery packet). Single-flight per-task lease; coalesced triggers queued, never
  dropped; boot recovery replays unreacted runs.
- **Runs**: `startRun` → claude adapter (Agent SDK, bypassPermissions, **disallowedTools is the
  only real confinement**, isolation levers `settingSources:[]`/`skills:[]`/`plugins:[]`) | codex
  adapter (threads, prompt-only confinement, idle timeout) | simulated fallback when no
  credential. Raw envelopes in `data/runtimes/<backend>/<runId>.jsonl`. Specialists run isolated
  in `<taskDir>/workspace` with per-run `GIT_CEILING_DIRECTORIES`.
- **GitHub is the execution surface**: server branch `<key-lowercase>-<slug>` → `[KEY]` commits →
  PR `[KEY] title` with task back-link → human-accepted merge. Dual delivery: viberr stored-PAT
  REST calls (ensureTaskBranch / openTaskPr on review entry / mergeTaskPr on accept) + agent-side
  `gh` in the workspace, reconciled idempotently (`reconcileWorkspaceDelivery`). Degrades honestly
  without credentials. `pr.state ∈ review|merged|closed|accepted` (closed vocabulary; `accepted` =
  human accepted, merge pending; never fake `merged`).
- **Reviews**: every reviewer completion runs `classifyReviewerVerdict` (negation-aware, full
  untruncated text) → typed `quality` event + task `validation` (healthy/changed/failing).
  A rejection sticks until real rework; review re-entry never launders `failing`;
  accept refuses a `failing` task (409).
- **Notifications**: in-app only (kinds packet|approval|mention|quality|policy), fan out via
  `notifyTaskWatchers` (owner + admins + maintainers, dedup, routing prefs honored).
- **Intended loop**: create task → operator auto-advances well-scoped work `triage→ready` (auto)
  and assigns a stage-eligible Developer (vague → input packet, held) → developer delivers in the
  isolated workspace → approval boundary into Review (validation=changed, PR open) → reviewer
  verdict cycle → human accepts (`acceptCompletion`: real merge → `merged`, else `accepted`
  merge-pending + later "Complete merge") → Done.

Stack (main): React Router 8.2 SSR · TypeScript 7.0.2 (native) · Vite 8.1 (Rolldown) · Vitest ·
Node ≥26 · better-sqlite3 (WAL) · better-auth 1.6.23 · Zod v4 · SSE only · hand-ported
`viberr.css` design system — **no Tailwind, `--viberr-*` tokens only**. Tests at pass-4 merge:
1185 unit + 13/13 Playwright e2e. Architecture reference:
`planning/discovery-2026-07-12-pass4/app-map.md` (verified against pass-4 code) and
`planning/discovery-2026-07-10/app-reference.md` (older; read its supersession banners).

### Non-negotiable invariants (from `planning/discovery-2026-07-10/product-intent.md`)
1. Files are canonical truth; malformed files degrade to diagnostics, never crash.
2. **Human-only Done** (single audited exception: operator under full autonomy with explicit
   `completion-for-acceptance: direct`; it refuses failing validation).
3. Human RBAC and agent capability policy are **two separate surfaces, never mixed**.
4. Typed events over chatter; the 5 anti-noise guardrails are product features.
5. Re-anchor rule: reactivated agents re-anchor on the task file; provider-history loss degrades
   gracefully.
6. Traceability: task key ↔ branch ↔ commits ↔ PR unambiguous; never claim a merge that
   didn't happen.
7. Idempotency: retries never duplicate transitions/branches/PRs/operator runs.

---

## 2. RBAC / role model as currently ruled (and coded on main)

### Human roles — two orthogonal levels
- **Org roles** (`admin` | `member` only; the `viewer` org rung was deleted). Since pass-4 ruling
  R-2026-07-12-5, the **better-auth `member` table is the authoritative org-role source**
  (`resolveOrgRole` in `authenticate`); `users.role` is derived. Better-auth 1.6.23 is the SOLE
  auth system (sessions, CSRF token derivation, OAuth, scrypt-compatible passwords); legacy
  session/oauth code deleted. Identity provisioning: `app/server/auth/identity.server.ts`.
- **Project roles** (`project.md` members[], file-native): `admin` | `maintainer` |
  `contributor` | `viewer`. Legacy `reviewer` coerces → `contributor` at parse.

### Single source of truth: `app/shared/rbac.ts`
`ACTION_ROLES` — 16 canonical actions → allowed `ProjectRole[]` — is THE runtime source. Every
server guard calls `requireAction` (task-actions) or `assertProjectAction`
(`app/server/auth/project-role-guard.server.ts`); UI gates use `roleCan`; the Policy page renders
the SAME object via `RBAC_TABLE`. `PROJECT_CAP_MATRIX` in `app/features/policy/policy-data.ts` is
now only a **display projection of RBAC_TABLE** (do not treat it as source).
`app/features/policy/policy-rbac.server.test.ts` drives every guard per role to bind
display↔enforcement and proves monotonic rank floors (viewer ⊂ contributor ⊂ maintainer ⊂ admin).

Current tiers (Q5 "clean tiering", pass-3 ruling):
- **app-wide (any authenticated user, FR4)**: `view`, `comment` (board + task detail readable
  app-wide; non-member comments visibly labeled).
- **contributor+**: `create-task`, `own-task` (take/release OWN ownership), `reconcile-github`.
  Task owner (contributor+, current member) may additionally resolve **non-completion** packets.
- **maintainer+**: `approve-transition`, `resolve-packet`, `accept-completion`, `run-agents`
  (assign/run/interrupt agents, @mention triggers, run operator), `reorder-board`, `update-goal`,
  `grant-github-scope`.
- **admin**: `release-any-ownership`, `manage-members`, `manage-agents`, `edit-policy`
  (+ project settings via the same tier).
- Membership-gated read surfaces: review queue, activity, policy, agents, settings, github
  (`requireProjectMember`; a non-member gets 403 BEFORE 404 so project existence doesn't leak).
  SSE (`resources.events.ts`): explicit `project:`/`task:` scopes require membership; org-admin
  read bypass; foreign-only → 403. Home is membership-scoped (org-admins see all).

### Agent capability policy (separate surface)
- Grant modes per capability: `direct` / `recommend` / `human` / `off`.
- `ALWAYS_HUMAN_CAPABILITY_IDS` (`app/shared/capabilities.ts`): **merge-pull-request,
  transition-to-done, change-project-policy** — coerced to `human` at persist time; structural.
- Enforcement is REAL on Claude (decision C): withheld repo-mutating caps map to `disallowedTools`
  Bash deny specifiers in `app/server/tasks/specialist-tool-policy.ts`; deny binds even under
  bypassPermissions. Safe-by-default polarity: deny only on explicit `human`/`off`.
  **`allowedTools` is NOT a restriction** (it's a permission allowlist; no-op under
  bypassPermissions) — confinement is disallowedTools ONLY.
- **Codex cannot be tool-confined** (SDK ignores allowed/disallowedTools) — standing owner-scoped
  gap S3; `capabilityEnforcement(id)` labels each cap `both` / `claude-only` / `advisory`
  ("Claude-enforced · advisory on Codex" badges; ALWAYS_HUMAN classifies "both").
- Pass-4 ruling R-7 pruned the toggleable catalog to runtime-consulted ids only (11 fake advisory
  toggles removed: approve-review, request-changes, report-validation-verdict, …);
  `execute-code-or-write-repo` was made expressible (it IS enforced, incl. MultiEdit in the deny).
  Resume runs re-thread confinement (`resolveResumeConfinement`, pass-4 XS-1 fix).
- Agent **eligible stages** (`stages`/`spanAll`) are enforced at BOTH assign and run boundaries
  (`assertStageEligible`); operator pickers filter by current stage; the scripted operator drive
  SKIPS (never halts on) a stage-ineligible engaged agent.
- Policy presets shape real governance (S1): strict human-gates pre-work boundaries; balanced =
  default; auto runs the operator at full autonomy (explicitly grants
  `completion-for-acceptance: direct`). Full autonomy promotes recommend→direct EXCEPT
  acceptance, which acts only at explicit `direct` (Q1).

### Archive semantics (main)
Decision D (pre-pass RBAC work): archive = **hide + separate only** — `archived` frontmatter flag,
Home "Archived" section, admin-gated `setProjectArchived`, restore in Settings → Danger zone;
**NOT read-only enforcement**, with honest copy saying so. (Pass 5's branch-only working ruling D6
makes archive fully read-only — see §6.)

### The 4 founding RBAC product decisions (owner, pre-pass "make RBAC real" work, 2026-07)
(A) Keep 4 project roles with honest names; (B) project creation is self-serve for ANY org member;
(C) specialist capability enforcement is REAL, not advisory; (D) BUILD archive (hide+separate).

---

## 3. Owner rulings ledger — binding product intent (do not re-litigate)

Every explicit owner decision, in order. "vs PRD" = what changed against the original
`planning/planning-artifacts/prd.md` / design mocks.

**Pre-pass (≈2026-07-08/09, RBAC + auth):**
1. (A) 4 project roles admin/maintainer/contributor/viewer — `reviewer` renamed contributor (vs PRD's reviewer role).
2. (B) Project creation self-serve for any org member (vs implied admin gate).
3. (C) Specialist capabilities ENFORCE via disallowedTools (vs advisory-only).
4. (D) Archive = build it, hide+separate only, not read-only.
5. better-auth migration Option B (bridge → later full cutover); org roles admin/member only, org `viewer` deleted.

**Pass 1 (2026-07-10/11):**
6. (A) Advisor/consultant profile REMOVED — operator absorbs advisory duties via packets (vs PRD 4-specialist roster).
7. (D1) Tester MERGED into Reviewer — one quality specialist reviews + tests (vs PRD separate Tester).
8. (C-sweep) Disk is truth for skills/KBs; org tables layer metadata only.
9. (E) Operator folds plan into its action comment — ONE timeline entry per turn.
10. (S1) Policy presets (strict/balanced/auto) wired to REAL governance.
11. (S2) "Accepted, merge-pending" PRs get a "Complete merge" action.
12. (S3) Codex tool confinement = DOCUMENTED gap (security deprioritized).
13. (D2) `triage→ready` is an `auto` boundary in the governed template (vs all-human gates).
14. (D3) Accept NEVER claims a merge that didn't happen — distinct `accepted` state.
15. (D4) One-click "retry on the other backend" on quota/availability failure.
16. Also: notification routing prefs real; legacy `scheduleOperatorRun` deleted; **"governance/governed" BANNED in UI copy**; no email notifications in V1; PAT-only GitHub auth; OAuth whitelist, no invite emails.

**Pass 2 (2026-07-11/12, rulings Q1–Q8 + follow-ups):**
17. (Q1) Acceptance requires EXPLICIT `completion-for-acceptance: direct` (full autonomy doesn't promote it).
18. (Q2) Task OWNER (current member) resolves non-completion packets; accept stays admin|maintainer. *(Superseded in part by pass-5 D1 — see §6.)*
19. (Q3) Anti-noise guardrails enforce for REAL on the canonical record (`comment-guardrails.server`).
20. (Q4) Capability catalog pruned + key caps wired; email prefs schema deleted.
21. (Q6) Home membership-scoped; org-admins see all.
22. (Q7) FULL workspace isolation: cwd=`<taskDir>/workspace` + per-run GIT_CEILING_DIRECTORIES.
23. (Q8) Codex/Claude runs bound by IDLE timeout (default 15 min, `VIBERR_CODEX_IDLE_TIMEOUT_MS`), not wall-clock.
24. Honest empty slate: seed ships 0 MCP servers / 0 GitHub connections / 0 PATs; no fabricated health. Never reintroduce.

**Pass 3 (2026-07-12, `planning/discovery-2026-07-12/owner-rulings.md`):**
25. (R-2026-07-12-1 / Q5) CLEAN TIERING: viewer = strictly read + comment; contributor = +create-task, take/release own ownership, owner-resolve of non-completion packets.
26. (R-2026-07-12-2) Agent eligible stages: WIRE IT (assign + run + operator pickers).
27. (R-2026-07-12-3) Review queue + Activity: membership-gate both (board/task detail stay app-wide per FR4).
28. (R-2026-07-12-4) S3 = HONEST LABELING ONLY, no Codex enforcement work.
29. (F11 ruling) `edit-other-task-branch` capability REMOVED (its broad git deny blocked ALL Claude delivery; moot under Q7).

**Pass 4 (2026-07-12, `planning/discovery-2026-07-12-pass4/owner-rulings.md`):**
30. (R-2026-07-12-5) STRICT single-source RBAC (every guard via ACTION_ROLES) **+ better-auth org-role cutover** (`member` table authoritative; breaking allowed).
31. (R-2026-07-12-6) Operator vs boundaries: CURRENT BEHAVIOR INTENDED — `stage-transitions: direct` lets the operator cross approval/human boundaries; **boundary settings govern HUMANS only** (Review→Done stays structurally locked). Fix = honest Policy copy (incl. disclosing the Q1 acceptance exception), not enforcement.
32. (R-2026-07-12-7) Prune the FAKE capability toggles (never-consulted reviewer-verdict ids etc.) — display honesty over new enforcement.
33. (R-2026-07-12-8) MCP credentials: WIRE REAL `secret://` injection (encrypted secret store → HTTP headers / stdio env at run spawn). *(Implemented only on the pass-5 branch — see §4.)*

**Pass 5 (2026-07-13, `planning/discovery-2026-07-13/decisions.md` on branch `codex/full-pass-2026-07-13` — owner-answered D1–D3; branch NOT merged):**
34. (D1) A **contributor who OWNS a task may accept that task's completion** (task-scoped authority; authority re-read at the acceptance/merge commit boundary). Changes Q2/ACTION_ROLES (`accept-completion` maintainer+ on main).
35. (D2) **Org admins have visible, audited emergency project-admin authority** without project membership (`org_admin_override` audit). Changes the pass-3/4 "org-admin reads all, mutates nothing" model.
36. (D3) **Operator makes the final agent-selection** (intelligent routing): viberr hard-filters impossible candidates (stage/capability) and supplies skill/KB/MCP fit, backend availability, org-wide workload, and observed cost; no static winner score; durable routing intent ids.

Pass-5 **working rulings D4–D15** (explicitly NOT owner quotes; replaceable): D4 MCP cred mapping
schema; D5 fail-closed on Claude ambient skill/plugin leakage; D6 archive = read-only history;
D7 no manual jump to Done (acceptance only from governed Review); D8 deletion purges all
project-keyed state; D9 referenced KB/skill/MCP rename/delete blocked; D10 atomic stage-graph
edits; D11 repo-backed terminal contract (healthy + all reviewer approvals + linked PR + real
merge before Done; else accepted/merge-pending stays in Review); D12 simulated runs produce no
governance evidence; D13 org-wide read visibility stands; D14 seeded demo runs must not count as
live workload; D15 multi-reviewer contract (isolated workspaces, one structured verdict marker,
all current reviewers must approve).

**Standing design decisions (do not "fix"):** banned "governance" copy; popup overlays for
profile/notifications/connections; agent identity = angular violet glyphs (Codex=cpu,
Claude=sparkle), humans = round blue avatars; board scrolls horizontally under ~1250px; rejected
UI ideas (do not re-add): AGENTS.md preview in profile modal, duplicate-profile button, colored
card accents, sessions-security panel, addressee toggles, live/SSE topbar indicator,
"inconsistency risk" card label, quality-gate settings panel.

---

## 4. Known-deferred backlog

### Deferred on main (pass-4 ledger, `planning/discovery-2026-07-12-pass4/implementation-ledger.md`)
Left to a "combined Codex re-check" because a parallel Codex session owned the runtime/adapter/MCP
layer; the pass-5 branch claims to implement all of them (F-row given), but **main still lacks
them**:
- **Ruling 8 — MCP `secret://` injection** (`app/server/tasks/specialist-mcp.server.ts` delivers
  connectable configs but drops auth) → branch F14.
- **MU-2 — real adapter phase/step callbacks** (onPhase) → branch F19.
- **XS-7 — Codex operator isolated empty workdir** (today: server cwd) → branch F23.
- **F-ISO1 — Anthropic ACCOUNT-tier skills/subagents leak into real Claude runs even in a clean
  container** (`skills:[]` doesn't suppress them under OAuth-token auth; verified live in Docker,
  `test-results-v4.md`) → branch F21 (fail-closed, per working ruling D5).
- **WI-5/6/7/15/16** — run-log tail dedupe, operator-lease release token, interruptRun view,
  claude interrupt pre-query, simulated raw-jsonl dir → branch F20/F05/F07/F40.
- Remaining pass-4 polish: **MU-5** login flash on OAuth whitelist rejection (→ branch F25),
  **XS-11** advisory-vs-enforced row labeling in the matrix (→ F17/F22), **N11** Agents tab URL
  state (→ F26), **N1** seeded eternal "running" runs (open question; branch F30/D14 removed them
  from live counts).

### Deferred by the 2026-07-13 ultra code review (56 verified findings on cf1a3df; memory `code-review-pass5-2026-07-13`)
The review applied 10 safe fixes directly (date-window string-compare, "(scripted)" mislabel,
blocked-merge green toast, toast aria-live, undefined `--amber`/`--yellow` tokens, rail mobile
focus-yank, short-secret mask disclosure, MCP probe wiping tools_count, stage-reorder coercing a
"Human only" boundary → approval). It **deferred the deep clusters to the owner**:
- **GitHub delivery**: PR `headSha` never written → reconcile wipes reviewer approvals; merge 409
  deadlock; reviewer branch-blind on private repos; same-basename repo swap serves the wrong
  checkout.
- **Dispatch/lease lifecycle**: restart-orphaned runs wedge dispatch rows + lease forever;
  foreign-run stamping; no-retry queue stall; archive/purge don't clear dispatches (paid run on a
  read-only project).
- **Reviewer governance**: default reviewer bricks a task via the strict delivery contract;
  @mention Q&A wipes an approval; request_changes yanks a Done task back; healthy-only accept
  dead-ends zero-reviewer projects; recovery-dedupe swallows repeat failures forever.
- **Codex argv secret leak**: MCP secret passed via `--config` argv, visible in `ps auxww`.
- Repo-less task bricked by @mention; cleanup cluster (exec triplication, hand-rolled RBAC checks,
  routing copy-paste ×4, prPill duplication) — confirmed, low priority.

**Status:** the branch's `adversarial-review-remediation.md` + H01–H08 hardening (commit 0c8c758,
1565 tests, CI green on PR #23) claim every cluster EXCEPT the Codex argv secret was subsequently
fixed on the branch — self-attested, not independently re-reviewed. On **main, all of these
clusters are moot-or-present only where the underlying pass-5 code exists** (most clusters are in
pass-5's NEW code; main's simpler delivery/dispatch predates them — do not "fix" them on main
without checking they exist there). The **Codex argv secret exposure is explicitly NOT fixed
anywhere** (owner scoped security out).

### Standing documented gaps (all passes)
- **S3 — Codex tool confinement**: SDK ignores allowed/disallowedTools; capability policy on
  Codex-backed agents is prompt-only ("advisory"); honest labels are the fix (rulings 12, 28).
- **R5 — apply-recommendation seam** (deliberate PARTIAL): `applyRecommendation` has no top-level
  gate; an applied rec re-executes under the underlying mutation's `requireAction` RBAC.
- **F13 residual**: dev-only parent-session tool inheritance when the dev server runs inside a
  Claude Code/Desktop session — above any SDK option, impossible in a standalone deploy. Not a bug.
- **useElapsed hydration warning** (probabilistic SSR race) — filed, unfixed on main (branch F08).
- **TS7 leftovers**: drop the `overrides {"typescript":"$typescript"}` lockfile trick once React
  Router peer-accepts TS ^7; TS 7.1 compiler API not adopted.
- **Codex quota-exhausted until ~Aug 2026** — every real Codex run errors (surfaced via the F8
  typed-blocked path); cross-backend behavior exercised through D4 retry.
- **Live PAT-path GitHub reconcile/merge** largely unexercised (honest slate has no stored PAT;
  live PR work is agent-side `gh`).
- Orphaned pruned-capability ids in old `project.md` files (selftest-4 etc.) — ignored at runtime
  by design; no migration.

---

## 5. What each pass fixed (do NOT re-diagnose these)

- **Pre-pass operator build (2026-07-09,** `planning/operator-verification-2026-07-09.md`**)**:
  operator read/gated well but generated nothing — built packets, the real GitHub delivery loop,
  notifications, stuck-loop recovery, verdict quality events, guardrail enforcement, MCP wiring,
  single-flight lease, boot recovery.
- **Pass 1 (2026-07-10→11,** `planning/discovery-2026-07-10/`**, PRs #1–#3, 1029 tests)**: 37-finding
  backlog — runtime isolation cluster (config-dir, allowedTools≠restriction, host-skill leak, env
  replace), agent-side delivery capture, default guardrails, seed hygiene; decisions A–E, D1–D4,
  S1–S3; adversarial H1–H4 (accepted-preserving reconcile, verdict on every path, rejection
  sticks, human-move-into-last-stage = acceptance).
- **Pass 2 (2026-07-11/12,** `planning/discovery-2026-07-11/`**, PR #7, 1130 tests)**: unified
  completion pipeline `registerAgentCompletion`/`applyAgentCompletionEffects`, waiting=agent
  bookkeeping, validation reset semantics, coalesce-queue on the lease, codex idle timeout, full
  workspace isolation, delivery-contract prompt, double-PR guard, canonical stage-role resolver
  (never hardcode stage ids), real guardrails, KB recursive injection, honest-empty-slate,
  hermetic test env (`test-support/setup-env.ts`; every form POST needs `_csrf`). 22 live cases.
- **Pass 3 (2026-07-12,** `planning/discovery-2026-07-12/`**, PR #14, 1156 tests)**: the
  role-bindings rework (`app/shared/rbac.ts` ACTION_ROLES as single source, Q5 tiering, D9 SSE
  membership, capability prune 30→26), F1 stage eligibility at both boundaries, F8 typed
  blocked-run escalation, **F11 HIGH** (edit-other-task-branch deny had blocked ALL Claude
  delivery — removed, proven by PR #13), F13 root-caused. Two adversarial rounds fixed 9 more.
  Same-day stack upgrade to TS 7.0.2 / RR 8.2 / Vite 8.1 / Node 26.
- **Pass 4 (2026-07-12,** `planning/discovery-2026-07-12-pass4/`**, merged b938f05→81dafe3, 1185
  tests)**: **F-MIG1 CRITICAL** (schema-drift self-heal: boot reconciler
  `db/schema-reconcile.server.ts` adds missing columns — the `projects.archived` drift had
  bricked every pre-existing DB), F-OP1 (failed real Claude operator run now escalates),
  XS-1 (resume confinement), XS-4 (`git checkout -B`/`switch -C` deny bypass), WI-1 (review queue
  stage-roles), better-auth org-role cutover, capability-toggle prune, honest boundary/acceptance
  Policy copy, loader perf, dead-code sweep, e2e determinism (`VIBERR_FORCE_SIMULATED_RUNTIME`).
  Validated by a 20-case sweep (`validation-sweep-v4.md`) + real Docker container run.
- **Pass 5 (2026-07-13, UNMERGED — draft PR #23,** `codex/full-pass-2026-07-13`**)**: F01–F41
  (server-owned authenticated delivery, org-admin override, contributor-owner acceptance,
  read-only archive, atomic stage-graph edits, MCP secret injection + real probes, reviewer
  isolation/verdict contract, terminal contract, routing context, purge-on-delete, phase
  callbacks, hydration-safe time, …) + H01–H08 exact-intent durability hardening after the ultra
  review; 1565 tests + 19/19 Playwright on the branch. **Adopting or discarding this is the
  owner's open decision.**
- **Ultra code review (2026-07-13, memory only)**: 56 verified findings on the pass-5 branch; 10
  safe fixes applied on-branch; deep clusters deferred (see §4); 3 candidates refuted as
  owner-ruled (two migration-in-place items + contributor self-accept, sanctioned by D1).

---

## 6. Open questions / ambiguities between passes

1. **Is pass 5 canon?** Its 3 owner rulings (D1–D3) are explicit and dated 2026-07-13 — they
   supersede earlier rulings *in intent* — but the implementing branch (draft PR #23 + the further
   `codex/e2e-product-hardening-2026-07-13` branch) is unmerged. Main's code contradicts D1
   (accept-completion is maintainer+ in `ACTION_ROLES`) and D2 (org-admin cannot mutate without
   membership). Until merge/re-implementation, main behavior ≠ latest owner intent.
2. **Archive semantics conflict**: owner decision D (archive = hide+separate, explicitly NOT
   read-only, honest copy) vs pass-5 working ruling D6 (read-only history, mutations rejected,
   runs stopped). D6 is NOT an owner quote. Owner confirmation needed before treating read-only
   archive as canon.
3. **Done-boundary semantics conflict**: pass-1/2 canon says a human move INTO the last stage IS
   acceptance (H4; pass-4 VV-4 validated impl→done acceptance) and an accepted-but-unmerged task
   goes to Done with `pr.state=accepted`. Pass-5 working rulings D7/D11 forbid acceptance outside
   the governed Review stage and keep repo-backed tasks IN Review until a real merge. Direct
   behavioral contradiction; D7/D11 are working rulings only.
4. **Simulated-run governance**: pass-4's validation sweep drove acceptance with simulated
   reviewer verdicts; pass-5 D12 says simulated output can never satisfy review/completion
   governance. Affects demo/e2e flows if adopted.
5. **Q2 vs D1**: Q2 (pass 2) explicitly kept `accept_completion` at admin|maintainer; D1 (pass 5,
   owner-answered) grants a contributor OWNER task-scoped acceptance. D1 is later and explicit —
   treat Q2 as superseded on this point, but note main still enforces Q2.
6. **Review deferred clusters' true status**: memory says "deferred to owner"; the branch's own
   remediation ledger says fixed in 0c8c758 ("validated on final tree", self-attested). No
   independent re-review of the H01–H08 tree exists. If PR #23 is merged, a fresh review of that
   tree is warranted; if not, the clusters mostly describe branch-only code.
7. **Two live pass-5 lineages**: `codex/full-pass-2026-07-13` (PR #23, tip 3a469f9) vs
   `codex/e2e-product-hardening-2026-07-13` (3 further commits incl. "assignment-stage-aware
   primary specialist eligibility"). Which, if either, is the intended merge candidate is
   undecided.
8. **Pass-5 README authority order** (its decisions > pass-4 rulings > prior canon) applies only
   within that branch's dossier; this doc treats owner-answered rulings by date regardless of
   branch, and working rulings as provisional.
9. Minor: memory `viberr-rbac-model.md` still names `PROJECT_CAP_MATRIX` (policy-data.ts) as the
   single source — outdated since pass 3; `app/shared/rbac.ts` `ACTION_ROLES` is the source.
10. **N1 seeded eternal running runs** on main: owner never explicitly ruled; pass-4 left as-is,
    pass-5 D14/F30 (branch) removed them from live counts.

---

## Appendix: environment & conventions quick reference

- Commands: `npm run dev` (:5173, launch.json `viberr-dev`) · `npm test` · `npm run typecheck` ·
  `npm run e2e` · `npm run seed -- --reset` · `npm run rescan`. Data root env `VIBERR_DATA_ROOT`
  (beware the F8 ctx trap: helpers must receive `ctx` or they silently read `./data`).
- Demo users (password `viberr-dev-2828`): arda=org admin; live-sweep project-role fixture:
  arda=admin, elif=maintainer, murat=contributor, selin=viewer, deniz=non-member.
- Backends: Claude via `CLAUDE_CODE_OAUTH_TOKEN`/`VIBERR_CLAUDE_USE_CLI_AUTH`; Codex via
  `VIBERR_CODEX_USE_CLI_AUTH=1`+`CODEX_HOME` (quota-dead until ~Aug 2026); no credential →
  simulated (`simulated=1` on the run row — check before trusting live evidence). Health:
  `GET /resources/health`. Restart the dev server before live runtime tests (HMR-cached adapters).
- GitHub self-test history on akin-ozer/viberr: pass 2 #4/#8/#10 merged, #5/#6/#9 closed; pass 3
  #12 merged, #11/#13/#16 closed; pass 4 #17 merged, #18 closed, #19 open→(later closed by pass 5);
  pass 5 #20 merged, #21 closed, #22 closed+branch deleted, **#23 = the open draft implementation PR**.
- The full trap list (22 hard-won mistakes: SDK env semantics, deny-beats-grant, verdicts on full
  text, skip-not-halt operator, closed pr.state vocabulary, CSRF probes, synthetic-click dialog
  closes, …) lives in `planning/discovery-2026-07-12-pass4/prior-canon.md` §7 — read it before
  touching runtime or lifecycle code.
