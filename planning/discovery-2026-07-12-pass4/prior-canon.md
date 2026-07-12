# Prior-pass canon — condensed context for pass 4 (2026-07-12)

Self-contained distillation of passes 1–3 (+ the pre-pass operator work and the TS7 stack upgrade).
This is the ONLY prior-pass context implementation subagents get. Sources are cited per section;
the deep dives live in `planning/discovery-2026-07-10/`, `planning/discovery-2026-07-11/`,
`planning/discovery-2026-07-12/`, `planning/operator-*.md`,
`planning/typescript-7-upgrade-verification-2026-07-12.md`.

---

## 1. The product in one page

**Viberr is governed AI software delivery for small teams: agents are the native workers, humans
govern flow, review, and acceptance.** (`discovery-2026-07-10/product-intent.md`;
origin `brainstorming/brainstorming-session-2026-03-29-12-02-32.md`.)

- **Task file = canonical operating contract.** Each task is one markdown file
  (`data/projects/<slug>/tasks/<KEY>/task.md`): frontmatter (stage, readiness, waiting, owner,
  specialist, reviewers, recommendations, branch/repo/pr, validation) + `## Goal` + `## Packet`
  (fenced yaml) + `## Timeline` (typed events, newest-first). Files are truth; SQLite
  (`data/state/projection.sqlite`) is a rebuildable projection (only users/sessions/secrets/audit/
  notifications are app-owned). chokidar watcher → reproject → SSE → route revalidation.
- **Projects** (`project.md`): stages (default 5: Triage/Ready/In Progress/Review/Done), workflow
  boundaries per transition (`auto` | `approval` | `human`; review→done locked `human`), members
  (4 project roles admin/maintainer/contributor/viewer), agent deployments, guardrails,
  credentialPolicy. Org roles: admin/member only.
- **Agents.** Roster = **Operator + Developer + Reviewer** (Advisor removed, Tester merged into
  Reviewer). Profiles (`data/agents/profiles/<id>.md`) carry capabilities
  (mode `direct|recommend|human|off`), resources (skills/KB/MCP), backends (claude|codex|simulated),
  model, eligible stages. Definitions (`data/agents/definitions/<id>.md`) are the persona prose.
- **The operator** coordinates each active task via an in-process `viberr` MCP toolkit gated per
  capability: reads the task, posts ONE comment per turn, assigns/prompts specialists and reviewers,
  transitions stages, opens **decision/blocking packets** (the governed intervention surface:
  observations + 2–4 options, one recommended), and — only with explicit
  `completion-for-acceptance: direct` — accepts completion. React loop: specialist/reviewer
  completion → operator reacts (depth cap 4, no-progress guard → stuck-loop recovery packet).
- **Runs**: `startRun` → claude adapter (Agent SDK, bypassPermissions, disallowedTools enforcement,
  isolation levers `settingSources:[]`/`skills:[]`/`plugins:[]`) | codex adapter (threads,
  danger-full-access, prompt-only confinement, idle timeout) | simulated fallback when no
  credential. Raw envelopes appended to `data/runtimes/<backend>/<runId>.jsonl` (canonical run
  truth) + `run_log_lines` + SSE.
- **GitHub is the execution surface**: task-key branch (`<key>-<slug>` server-side) → `[KEY]`-
  prefixed commits → PR (`[KEY] title`, task back-link body) → human-accepted merge. Dual delivery
  path: viberr's stored-PAT REST calls (ensureTaskBranch / openTaskPr on review entry / mergeTaskPr
  on accept) + agent-side `gh` in the isolated workspace, reconciled idempotently into task.md by
  `reconcileWorkspaceDelivery`. All best-effort; degrades honestly without credentials.
- **Reviews**: reviewer completion always runs `classifyReviewerVerdict` (negation-aware, full
  untruncated text) → typed `quality` event + task `validation` (healthy/changed/failing) +
  watcher notification. A rejection sticks until reworked; review re-entry never launders failing.
- **Notifications** (in-app only; kinds packet|approval|mention|quality|policy) fan out via
  `notifyTaskWatchers` (owner + admins + maintainers, dedup, routing prefs honored).
- **KB/skills/MCP**: disk is truth (`data/kb/`, `data/skills/<name>/SKILL.md`); org tables layer
  metadata. KB injection is recursive, multi-extension, with a GLOBAL 24k budget across declared
  KBs and an honest truncation marker. Declared skills only reach a run's persona.
- **Intended end-to-end flow**: create task → operator auto-advances well-scoped work across
  `triage→ready` (auto) and assigns the stage-eligible Developer (vague → input packet, held) →
  developer delivers in the isolated workspace (branch/commits/PR) → approval boundary into Review
  (validation=changed, PR open) → reviewer verdict cycle → human accepts (`acceptCompletion`:
  real merge → `merged`, else `accepted` merge-pending + later "Complete merge") → Done.

Architecture/routes/data-model reference: `discovery-2026-07-10/app-reference.md` (read its pass-3
update banner — RBAC/capability sections were superseded by PR #14; `app/shared/rbac.ts` wins).

---

## 2. Owner rulings — ALL binding product intent (do not re-litigate)

Numbered 1–19 as in `discovery-2026-07-10/product-intent.md`; original ids in parentheses.

**Pass 1 (2026-07-10/11 — `discovery-2026-07-10/findings.md`, `sweep-design-decisions.md`,
`shipped-build-ui-walkthrough.md`):**
1. (A) Advisor/consultant profile REMOVED; the operator absorbs advisory duties via packets.
2. (C-sweep) Disk is truth for skills/KBs; org settings lists every disk dir, metadata layered.
3. (E) Operator folds its plan into the action comment — ONE timeline entry per operator turn.
4. (S1) Policy presets (strict/balanced/auto) shape REAL governance: strict human-gates pre-work
   boundaries; auto runs operator at full autonomy; review→done human-locked in all presets.
5. (S2) "Accepted, merge-pending" PRs get a "Complete merge" action to finish the real merge later.
6. (S3) Codex tool confinement is a DOCUMENTED gap (Codex SDK ignores allowed/disallowedTools);
   → in pass 3 ruled "honest labeling only" (see 18).
   Also pass-1: (B) notification routing prefs wired for real + runtime `quality` notifications;
   (D-technical) legacy `scheduleOperatorRun` deleted; (D1) Tester merged into Reviewer;
   (D2) `triage→ready` is an `auto` boundary in the governed template; (D3) accept NEVER claims a
   merge that didn't happen (distinct `accepted` state); (D4) one-click retry-on-other-backend.

**Pass 2 (2026-07-11/12 — rulings detailed in `discovery-2026-07-11/findings-v2.md` §Owner rulings):**
7. (Q1) Acceptance requires explicit `direct`: full autonomy promotes other recommend-caps to
   direct, but `completion-for-acceptance` acts only at explicit `direct`; `off`/`human` never
   offer the accept tool. The `auto` preset grants it explicitly.
8. (Q2) The task OWNER (with current project membership) may resolve non-completion packets;
   `accept_completion` stays admin|maintainer.
9. (Q3) Anti-noise guardrails are REAL: meaningful-comment / operator-brevity /
   evidence-separation enforce on the canonical record (`comment-guardrails.server`), plus the
   already-wired no-duplicate-summary + compression-threshold.
10. (Q6) Home is membership-scoped: members see their projects; org-admins see all.
11. (Q7) FULL workspace isolation: specialists run in `<taskDir>/workspace` with per-run
    `GIT_CEILING_DIRECTORIES`; an agent's git can never touch the host checkout.
12. (Q8) Codex (and Claude) runs bound by IDLE timeout, not wall-clock — only true inactivity
    (>15 min without a new event, env-configurable) interrupts; idle-timeout finishes the run
    `error` so react loop/packet/notification fire.
13. **Honest empty slate**: the seed ships NO fabricated credentials or health — 0 MCP servers,
    0 GitHub connections, 0 PATs; a `credentialPolicy` without a bound PAT renders the honest
    "No credential configured" card. Never reintroduce green-until-probed seed data.
    Also pass-2: (Q4) capability catalog pruned + key caps wired (execute-code-or-write-repo etc.);
    no email notifications in V1 (email prefs schema deleted).
14. Role-bindings phase commissioned (executed as pass 3).

**Pass 3 (2026-07-12 — `discovery-2026-07-12/owner-rulings.md`):**
15. (R-1/Q5) **Clean tiering**: viewer = strictly read + comment. Contributor = viewer +
    create-task + take/release own ownership + owner-resolve of non-completion packets.
    Admin/maintainer unchanged. Viewers can no longer own tasks.
16. (R-2) Agent eligible stages (`stages`/`spanAll`) are ENFORCED, not decorative: operator
    pickers filter by the task's current stage; assign AND run validate server-side
    (`assertStageEligible`); the scripted operator drive SKIPS a stage-ineligible engaged agent
    (never halts); `get_task` snapshot carries `eligibleForCurrentStage`.
17. (R-3) Review queue + Activity pages are MEMBERSHIP-GATED (`requireProjectMember`), like
    policy/agents/settings/github. Board + task detail stay app-wide readable per FR4.
18. (R-4) S3 = HONEST LABELING ONLY (no Codex enforcement): the capability matrix marks
    specialist tool-denylist caps "Claude-enforced · advisory on Codex"; structural ALWAYS_HUMAN
    caps (merge-PR) classify as "both". Codex confinement itself remains a documented gap.
19. (F11) Delivery unblocked: the `edit-other-task-branch` capability was REMOVED — its broad git
    deny had blocked every Claude specialist from creating its own branch; moot under Q7.

**Standing design decisions (do not "fix" — `discovery-2026-07-10/product-intent.md` §Deliberate):**
- The word **"governance/governed" is BANNED in UI copy** → use Maintainer / Permissions / "managed".
- No email notifications (in-app only; don't even say "in-app" in copy). PAT-only GitHub auth
  (no GitHub App); scopes validated at connect-time only. OAuth users whitelisted (email or Google
  domain), no invite emails; local users get admin-driven password resets.
- Project creation is self-serve for ANY org member (decision B). 4 project roles / 2 org roles
  (decision A). Specialist capability enforcement is REAL on Claude — disallowedTools deny even
  under bypassPermissions (decision C). Archive project = hide+separate only, honest copy (decision D).
- Popup overlays for profile/notifications/connection editing. Agent identity: angular violet
  glyphs (Codex=cpu, Claude=sparkle); humans round blue avatars. Board scrolls horizontally under
  ~1250px by design. Rejected UI ideas (do not re-add): AGENTS.md preview in profile modal,
  duplicate-profile button, colored card accents, sessions-security panel, addressee toggles,
  live/SSE topbar indicator, "inconsistency risk" card label, quality-gate settings panel.

---

## 3. Non-negotiable invariants (`discovery-2026-07-10/product-intent.md`)

1. **Files are canonical truth**; SQLite is a rebuildable projection. Malformed files degrade to
   diagnostics (readiness floor: warning→input_required, error→inconsistency_risk_detected,
   hardStop→blocked), never crash. Broken frontmatter → BLANK stage + diagnostic, not phantom triage.
2. **Human-only Done**: only a human accepts completion. Single exception: operator under `full`
   autonomy with explicit `completion-for-acceptance: direct` — audited, and it REFUSES a
   `failing`-validation task.
3. **Separate human RBAC and agent capability policy** — two surfaces, never mixed. Agent caps:
   direct/recommend/human/off. `ALWAYS_HUMAN` (coerced at persist): merge-pull-request,
   transition-to-done, change-project-policy.
4. **Typed events over chatter**: quality/transition/blocked/completion/policy events are
   first-class; the 5 anti-noise guardrails are product features (PRD: timeline noise = #1 risk).
5. **Re-anchor rule**: any reactivated agent re-anchors on the canonical task file;
   provider-history loss degrades gracefully.
6. **Traceability** (NFR15): task key ↔ branch ↔ commits ↔ PR stays unambiguous. Never claim a
   merge that didn't happen; `pr.state ∈ review|merged|closed|accepted`.
7. **Idempotency** (NFR16/17): retries never duplicate transitions/branches/PRs/operator runs.
   Single-flight operator lease per task (atomic in this single-process synchronous-sqlite
   runtime); coalesced triggers are QUEUED, never dropped; boot recovery replays unreacted runs.

---

## 4. What shipped, per pass

**Pre-pass operator work (2026-07-09 — `operator-verification-2026-07-09.md`,
`operator-implementation-plan-2026-07-09.md`).** Verification found the operator read/gated well
but generated nothing: no runtime packets, dead GitHub delivery, inert notifications/guardrails.
Phases A–G built: `open_decision_packet` tool + packet generator; the real delivery loop
(ensureTaskBranch / openTaskPr with composed body + task link / mergeTaskPr on accept);
notification fan-out; stuck-loop detection → recovery packet; live validation-health derivation;
typed reviewer-verdict quality events; guardrail enforcement start + timeline compaction; MCP
wiring; real resource catalog; single-flight lease; boot run-recovery.

**Pass 1 (2026-07-10 → 07-11 — `discovery-2026-07-10/`, PRs #1/#2/#3 merged; 1029 tests).**
37-finding backlog all resolved (`findings.md`, map in `completeness-ledger.md`): the runtime
isolation cluster (#32 config-dir, #34 allowedTools≠restriction, #35 host-skill leak, #36 env
replace), agent-side delivery capture (#31 `reconcileWorkspaceDelivery`), default guardrails on
new projects (#29), seed hygiene, notification prefs + runtime quality notifications, disk-truth
org resources, 403 message fix, honest fallback stage. Decisions A–E + D1–D4 + S1/S2/S3
implemented. Adversarial hunt fixed H1 (reconcile preserves `accepted`), H2 (verdict on EVERY
reviewer path), H3 (rejection sticks; operator refuses failing accept), H4 (human move INTO last
stage routes through acceptCompletion), + the negation-aware verdict classifier.

**Pass 2 (2026-07-11/12 — `discovery-2026-07-11/`, PR #7, 21 commits; 1130 tests).**
~55 findings (`findings-v2.md`) + 15 live discoveries + rulings Q1–Q8 + 16 adversarial-review
defects + 2 CI fixes + 19 current-state findings — everything fixed. Highlights: unified
completion hook `registerAgentCompletion`/`applyAgentCompletionEffects` (A1 — no more
last-writer-wins callback clobber), waiting=agent bookkeeping on every run start (A2), validation
reset semantics (A3), cross-backend model re-resolution for D4 retry (A4/X2), coalesce-queue on
the operator lease (A5/A6), codex idle timeout (A8/Q8), full workspace isolation (X1/Q7),
delivery-contract prompt (branch name + `[KEY]` commits, B4), accepted-preserving reconcile (B1),
double-PR guard (B5), canonical stage-role resolver replacing literal `triage`/`done` checks
(B6/C7), real guardrails (C6/Q3), verdict on full untruncated text (X9), `updateTaskGoal` (X11),
empty-repo→null (X12), honest completion copy (X13), UI RBAC gating (M1–M3/X14), KB recursive
injection HIGH fix (`app/server/files/kb-injection.server.ts`), honest-empty-slate seed,
operator run_specialist/run_reviewer recommendations became applyable cards, hermetic test env
(`test-support/setup-env.ts`). 22-case live campaign (selftest-3, real PRs).

**Pass 3 (2026-07-12 — `discovery-2026-07-12/`, PR #14; 1156 tests). Most detail — read
`implementation-ledger.md` first.**
- **Role-bindings rework**: `app/shared/rbac.ts` holds THE `ACTION_ROLES` map (16 canonical
  actions → allowed `ProjectRole[]`). Every guard calls `requireAction` (task-actions) or
  `assertProjectAction` (`app/server/auth/project-role-guard.server.ts`, replacing 3 duplicated
  `requireProjectAdmin` copies); UI gates use `roleCan`; the Policy page renders the SAME object
  (`RBAC_TABLE`); `app/features/policy/policy-rbac.server.test.ts` drives every guard per role to
  bind display↔enforcement (and proves monotonic rank-floors). Q5 clean tiering. Full D9 SSE
  membership (`resources.events.ts`: explicit `project:`/`task:` scope requires membership,
  org-admin bypass, foreign-only → 403). Review + Activity loaders members-only. Capability
  catalog pruned 30→26 ids (removed edit-other-task-branch, open-or-merge-pr, compress-timelines,
  owner-reassignment); `ENFORCED_CAPABILITY_IDS`=13, `CLAUDE_ONLY_ENFORCED`=4, `ALWAYS_HUMAN`=3;
  `capabilityEnforcement(id)` → both|claude-only|advisory (S3 labels).
- **Findings F1–F13 all resolved** (`findings-v3.md`): F1 stage eligibility wired (assign AND run
  boundaries; operator pickers; scripted drive skips); F2 deleteProject cleans notifications;
  F3 error boundary keeps theme; F4 honest Permissions rail from the matrix; F5/F6 copy;
  F7 seeded-run elapsed re-anchored; **F8** errored runs post a typed `blocked` event + recovery
  packet + watcher notification (quota/auth classified via `runFailureReason`) instead of silent
  waiting-revert; F9 KB budget made GLOBAL; F10 repo-less/manual-owner first-project creation;
  **F11 (HIGH)** edit-other-task-branch deny removed — its `Bash(git checkout:*)` deny defeated
  the granted create-task-branch under bypassPermissions and blocked ALL Claude delivery in the
  default config (proof: PR #13 delivered post-fix under the exact config that failed);
  F12 = F8+F11 compound resolved; F13 host-plugin leak closed as far as possible (`plugins: []`
  third isolation lever; residual = process-level inheritance, dev-only — see §5).
- **Two adversarial rounds** (ledger addenda 2+3): manual 3-reviewer pass found 4 defects
  (merge-pull-request mislabeled advisory; F1 enforced only at assign; operator seed asset still
  granting pruned ids; missing policy-rbac test) and a 25-agent Workflow found 5 more (incl. a
  REGRESSION from the F1 fix: scripted drive halting on an ineligible engaged agent; demoted
  viewer-owner still seeing Release/resolve UI). All fixed with regression tests.

**Post-pass-3 stack upgrade (same day — `typescript-7-upgrade-verification-2026-07-12.md`).**
TS 5.9→**7.0.2** (native), React Router 7→**8.2**, Vite 7→**8.1** (Rolldown), Node→**26**,
codex-sdk 0.144.1, agent-sdk 0.3.207; only 4 code files changed. Its adversarial review caught a
real RR8 regression (loginRedirect building returnTo from raw `.data` wire URLs — fixed in
`app/server/auth/require-user.server.ts`). Cold-start e2e reload root-caused → RR's
`future.unstable_optimizeDeps` flag (now set). Post-merge red CI root-caused to the **F8 ctx
omission** (see trap list) — fixed in 68d238c; suite now **1160**. Pass 4 starts from
`main` @ bdcce97.

---

## 5. Known PARTIAL / deferred / open items at end of pass 3

- **S3 — Codex tool confinement is STILL a documented gap** (owner-scoped since pass 1;
  pass-3 ruling 18 = labeling only). The Codex SDK ignores allowed/disallowedTools and
  systemPrompt/mcpServers; capability policy for Codex-backed specialists is prompt-only
  ("advisory"). The matrix labels this honestly. (`discovery-2026-07-12/owner-rulings.md`,
  `role-bindings-current-state.md` §4.)
- **R5 — apply-recommendation seam (the ONE deliberate PARTIAL)**: `applyRecommendation` has no
  top-level gate; an applied rec re-executes under the underlying mutation's human RBAC via
  `requireAction`. Documented seam; the auto-boundary transition rec is unreachable from the UI.
  (`discovery-2026-07-12/findings-v3.md` R5.)
- **F13 residual boundary**: when the dev server itself is spawned from inside an active Claude
  Code/Desktop session, spawned `claude` subprocesses inherit the PARENT session's SDK tools at
  the process level — above any SDK option; impossible in a standalone (Docker/systemd) deploy.
  Declared skills always load correctly. Do not chase this as a product bug.
  (`discovery-2026-07-12/implementation-ledger.md` addendum 1.)
- **Doc drift, docs-only**: app-reference wording notes D1/D3/D4/D5/D6 in
  `discovery-2026-07-12/findings-v3.md` (e.g. OPERATOR_DENIED_BUILTINS is 6 builtins incl. Task;
  `registerReplyAndReconcile` is now `registerAgentCompletion`→`applyAgentCompletionEffects`;
  `resumeRun` has a cosmetic dead branch) — code is correct, banners point the way.
- **Orphaned capability grants**: existing project.md files (selftest-4 etc.) still store pruned
  cap ids; ignored at runtime by design, no migration. New projects get the clean catalog.
- **Fail-closed informational notes, deliberately unchanged**: releaseOwner 404-vs-403 ordering;
  a demoted viewer-owner cannot self-release (admin releases); policy module read gated to members
  while edit-policy is admin. (`implementation-ledger.md` addendum 2 tail.)
- **Advisory capability ids kept**: the reviewer/specialist advisory labels stay in the catalog,
  honestly marked advisory (deep-prune beyond the 4 harmful ids was deliberately not done).
- **useElapsed hydration warning** (pre-existing, probabilistic): `useState(() => Date.now())`
  races SSR/hydration across second boundaries; filed as follow-up, not fixed.
  (`typescript-7-upgrade-verification-2026-07-12.md` §4.3.)
- **TS7 leftovers**: delete the `overrides {"typescript":"$typescript"}` lockfile trick once RR
  peer-accepts TS ^7; TS 7.1 compiler API not adopted; tsx→native type-stripping experiment
  deferred. (§4.7 / §6.)
- **Codex quota-exhausted until ~Aug 2026** — every real Codex run errors (now surfaced honestly
  via F8). Cross-backend behavior is exercised through the D4 retry path.
- **Skill/plugin isolation known boundary** (product-intent.md tail): standalone deployments
  inject ONLY declared skills; the one uncoverable case is the dev-parent-session inheritance above.
- **Live Codex runs unverifiable** (quota) and **live PAT-path GitHub merges** exercised mainly via
  mocks + agent-side gh (no stored PAT in the honest slate; a PAT would enable server reconcile).

Nothing else is intentionally mock/unwired: pass-3 `findings-v3.md` §Verified clean records that
form intents, profile prefs, guardrails, credentialPolicy, mcp-test/kb-reindex probes are all real,
with no TODO/stub markers and no skipped tests.

---

## 6. Environment & test facts for pass 4

- **Stack** (post-upgrade): React Router 8.2 SSR · TypeScript 7.0.2 · Vite 8.1 (Rolldown) ·
  Vitest 4.1.10 · Node >= 26 (`.nvmrc`; mismatched Node = better-sqlite3 ABI failure at boot) ·
  better-sqlite3 (WAL) · better-auth 1.6.23 · Zod v4 · SSE only (no websockets) · ported
  `viberr.css` design system — **no Tailwind; use `--viberr-*` tokens only**.
- **Commands**: `npm run dev` (:5173; launch.json name `viberr-dev`) · `npm test` (**1160** vitest,
  122 files) · `npm run typecheck` (~0.9s) · `npm run e2e` (**13/13** Playwright golden paths,
  isolated data root) · `npm run seed -- --reset` · `npm run rescan`.
- **Hermetic tests**: `test-support/setup-env.ts` seeds the two required secrets — no `.env`
  dependency. CI-parity check: run the suite with `.env` hidden and check the real exit code.
  Data root env: `VIBERR_DATA_ROOT` (default `./data` — see trap list). One pre-existing
  async-teardown-race test flakes intermittently (passes on re-run).
- **Demo users** (password `viberr-dev-2828`): arda@viberr.dev=org admin; project-role fixture
  used in every live sweep: arda=admin, elif=maintainer, murat=contributor, selin=viewer,
  deniz=non-member.
- **Backends**: Claude real via `CLAUDE_CODE_OAUTH_TOKEN` or `VIBERR_CLAUDE_USE_CLI_AUTH`; Codex
  via `VIBERR_CODEX_USE_CLI_AUTH=1` + `CODEX_HOME` (quota-dead until ~Aug 2026). No credential →
  simulated fallback (`simulated=1` on the run row). Health: `GET /resources/health` (unauth)
  shows projections/watcher/backends real-vs-simulated.
- **Live-sweep method that worked in passes 2–3** (`discovery-2026-07-12/test-plan-v3.md`,
  `test-results-v3.md`): create a fresh selftest project via the PRODUCT action path on repo
  `akin-ozer/viberr` (Balanced preset); 20+ task cases across operator flow / delivery / RBAC /
  agents; NO PAT stored in the app (honest slate) — PR work is agent-side `gh`; the tester merges/
  closes PRs with `gh pr merge --squash` / `gh pr close`. Keep agent PRs tiny (1 file / +1 line
  marker docs). RBAC probed via curl with a per-user cookie jar against better-auth email sign-in;
  **every form POST needs the `_csrf` field** scraped from the loader stream
  (`operator-verification-2026-07-09.md` §harness). Evidence sources: task.md files, the SQLite
  projection (`agent_runs`, `audit_events`, `notifications`, `scope_violations`),
  `data/runtimes/*/*.jsonl` run envelopes, run init envelopes for isolation checks.
- **Prior selftest artifacts**: selftest-3 (VTC keys, pass 2), selftest-4 (VSF keys, pass 3;
  contains orphaned pruned-cap grants). PR history on akin-ozer/viberr: pass 2 #4/#8/#10 merged,
  #5/#6/#9 closed; pass 3 **#12 merged**, #11/#13/#16 closed.
- **Naming/conventions**: server branch `<key-lowercase>-<slug>`; commits `[KEY] …`; PR title
  `[KEY] title` with task back-link body; packet dispatch on `kind`, never titles.

---

## 7. Trap list — mistakes prior passes hit; do NOT repeat

**Agent-runtime / SDK traps**
1. **`allowedTools` ≠ restriction.** In the Agent SDK it is a permission ALLOWLIST (auto-approve);
   under bypassPermissions it is a no-op. Tool confinement is `disallowedTools` ONLY.
   (`discovery-2026-07-10/findings.md` #34; `findings-v3.md` doc-drift D6.)
2. **Deny rules beat grants — broad deny specifiers are landmines (F11).** A withheld cap whose
   deny includes `Bash(git checkout:*)` silently defeated a GRANTED create-task-branch and blocked
   ALL Claude delivery. When adding deny specifiers, verify granted caps still work end-to-end
   with a real run. (`discovery-2026-07-12/findings-v3.md` F11.)
3. **SDK subprocess env semantics.** Passing a REPLACEMENT env (token only, no PATH) kills stdio
   MCP spawns (#36); conversely overlaying per-run env on a full `process.env` snapshot leaked the
   user's gh auth into Codex runs (pass-2 wave-1 #3). Spread deliberately; per-run
   `GIT_CEILING_DIRECTORIES`; record what you intend.
4. **HMR-cached adapters**: restart the dev server before live runtime testing — hot reload keeps
   stale adapter code live. (`discovery-2026-07-11/live-revalidation.md` header.)
5. **Host-repo escape**: with `VIBERR_DATA_ROOT` inside the product repo, an agent cwd'd at the
   task dir resolves git UPWARD to the host `.git` (X1 left the dev checkout on the agent's
   branch, both backends). Isolation = cwd=`<taskDir>/workspace` + GIT_CEILING; verify the host
   stays on its branch after every delivery test. (`findings-v2.md` X1.)
6. **`registerRunCompletion` is last-writer-wins** — never register a competing per-path callback;
   all completion effects flow through `registerAgentCompletion`/`applyAgentCompletionEffects`
   (pass-2 A1 clobbered verdicts+reconcile from @mention runs).
7. **Classify verdicts on the FULL reply text** — pass 2 lost real verdicts because
   classification ran on the 1200-char display truncation (X9).
8. **Parent-session inheritance (F13)** is dev-only noise: leaked CronCreate/Workflow/etc. tools in
   run init envelopes come from running the dev server inside a Claude session. Don't "fix" it.

**Correctness / lifecycle traps**
9. **F8 ctx omission (the red-CI classic)**: server helpers that resolve project context MUST be
   passed `ctx` — the one call site that omitted it silently read the DEFAULT `./data` root, so
   the test passed on dev machines (where `./data` exists) and failed in CI, and the product bug
   (failed-run notifications never delivered off-dev) shipped. When touching notify/reconcile
   paths, re-run the affected tests with `VIBERR_DATA_ROOT=<empty dir>`.
   (`typescript-7-upgrade-verification-2026-07-12.md` §8.)
10. **Never hardcode stage ids** (`triage`/`done`/`review`) or positional indexes — use the
    canonical stage-role resolver (entry/work/review/terminal); Lightweight projects broke on
    literal checks (pass-2 B6/C7/C10).
11. **The operator drive must SKIP, not halt**: pass 3's own F1 fix regressed by throwing on a
    stage-ineligible ENGAGED agent, permanently stalling tasks — coordinate() filters by
    eligibility and falls back. Any new operator-side validation needs the same skip-not-halt
    shape. (`implementation-ledger.md` addendum 3 #1.)
12. **Coalesced operator triggers are queued, never dropped** (A5 swallowed human @operator
    mentions); the lease row is inserted BEFORE coordination in every mode (A6).
13. **`pr.state` vocabulary is closed** (`review|merged|closed|accepted`); reconcile/openTaskPr
    must PRESERVE a human-set `accepted` while the PR is open (H1, B1, B3 regressions all
    re-clobbered it). Never write `"open"`; never fake `"merged"`.
14. **A human move INTO the last stage IS acceptance** — it must route through `acceptCompletion`
    (merge attempt, completion event, honest toast), not a bare stage write (H4/C4).
15. **Enforce at BOTH assign and run boundaries** — pass 3's stage eligibility was first enforced
    only at assign; re-prompts bypassed it (addendum 2 #2). Same pattern for any new gate.

**Testing / tooling traps**
16. **Dialogs close on synthetic JS `.click()`** — drive the UI with real pointer events
    (browser tools), not `element.click()` from injected JS; a mis-targeted synthetic click also
    produced the retracted "logout broken" finding (pass-2 D11). (react-doctor session memory +
    `findings-v2.md` D11.)
17. **Every form POST needs `_csrf`** (scraped from the loader stream) — curl probes without it
    read as false 4xx denials (pass-2 X-cases; harness in `operator-verification-2026-07-09.md`).
18. **Binary control bytes can poison source files** — grep/rg silently skip them and produce
    false dead-code conclusions (pass-1 #8). If grep says a symbol doesn't exist, confirm with a
    direct read before acting.
19. **Vite cold-start re-optimize aborts e2e mid-test** — keep RR's `future.unstable_optimizeDeps`
    flag; first-run-after-install failures are this, not your change. (TS7 doc §7.)
20. **npm can't major-bump RR in place** (arborist anchors the installed tree) — regenerate the
    lockfile when coordinated majors are needed.
21. **Simulated fallback masks credential problems**: a run without a real credential silently
    becomes simulated (`simulated=1`, replies prefixed "(simulated run …)") — check the run row's
    backend/simulated flags before trusting live evidence.
22. **Don't reintroduce**: banned "governance" UI copy (G1 found 9 spots), fabricated seed
    credentials/health (ruling 13), permissive default caps on new profiles (#37), or a separate
    operator "Plan:" comment (ruling 3).

---

## 8. Where to look (source docs)

| Topic | Path |
|---|---|
| Architecture / routes / runtime reference | `planning/discovery-2026-07-10/app-reference.md` (+ pass-3 banner) |
| Product intent, invariants, all rulings | `planning/discovery-2026-07-10/product-intent.md` |
| Pass-1 finding→fix map | `planning/discovery-2026-07-10/completeness-ledger.md` |
| Pass-2 full record | `planning/discovery-2026-07-11/FINAL-REPORT.md`, `findings-v2.md`, `implementation-ledger.md` |
| Pass-3 full record | `planning/discovery-2026-07-12/implementation-ledger.md`, `findings-v3.md`, `owner-rulings.md`, `test-results-v3.md` |
| RBAC current state | `app/shared/rbac.ts` (code wins), `planning/discovery-2026-07-12/role-bindings-current-state.md` (pre-rework map) |
| Stack upgrade / env deltas | `planning/typescript-7-upgrade-verification-2026-07-12.md` |
| Operator origin story | `planning/operator-verification-2026-07-09.md`, `planning/operator-implementation-plan-2026-07-09.md` |
| Product genesis (packets, guardrails, conventions) | `planning/brainstorming/brainstorming-session-2026-03-29-12-02-32.md` |
