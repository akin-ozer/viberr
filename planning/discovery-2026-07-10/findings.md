# Viberr findings backlog — 2026-07-10 discovery pass

> **✅ ALL RESOLVED (final, 2026-07-11).** Every P0–P3 finding below is fixed, by-design (#18 honest
> placeholder), or a documented deferral (#33 codex tool confinement → role-bindings phase). The
> per-finding status cells reflect the DISCOVERY-time state; the authoritative finding→fix map is
> `completeness-ledger.md`. Summary of what landed: runtime isolation cluster (#32/#34/#35/#36),
> Advisor removal (A) + Tester→Reviewer merge (D1), triage→ready auto (D2), accept-never-fakes-merge
> (D3), backend retry (D4), operator behavior (E/#15/#24), default guardrails (#29), seed hygiene
> (#17/#18/#22), notification-prefs + quality (#4/#6), org disk-truth (#7), dead-code/binary-byte
> cleanup (#8/#10/#14), RES_CATALOG mock removal (#5/#14), 403 message (#26), honest fallback stage
> (#27), and the wave-1 small fixes. The lease "residual" (#1/#30) is atomic in this
> single-process/synchronous-better-sqlite3 runtime (live-verified) — no lock needed. Beyond this
> backlog, a shipped-build critical pass added S1 (real policy presets), S2 (Complete-merge), S3
> (codex-enforcement doc), and an adversarial hunt fixed H1–H4 + the reviewer-verdict classifier —
> all in `completeness-ledger.md` + `test-catalog.md`. 1029 tests green.

Ranked implementation backlog. Severity: **P0** breaks a product promise on real runs · **P1**
functional gap/bug · **P2** poorly implemented / drift risk · **P3** cosmetic. Status column filled
during phase 3 testing and phase 4 implementation.

## P0/P1 — runtime bugs (evidence from real runs of 2026-07-09)

| # | Finding | Evidence / location | Status |
|---|---|---|---|
| 1 | **Operator single-flight lease race** — two operator runs start ~1s apart, both execute → duplicate reviewer runs, duplicate packets, duplicate notifications | CCD-6 evidence is PRE-FIX (probes 07-09 20:41 UTC; hardening commit c09a893 landed 07-10 02:36 UTC). Code is still check-then-insert TOCTOU (`inFlightOperatorRun`, operator-run.server.ts:93) — retest live (case 9) | retest needed |
| 2 | ~~resolvePacket → operator re-invoke silently fails~~ **FIXED before this pass** — CCD-8 evidence predates c09a893; live retest 2026-07-10 (ATL-1 redirect resolve → operator run started in <6s) PASSES. Residual concern: `void autoInvokeOperator` still swallows failures silently (only a log line) | ATL-1 20:42:29 run | retest PASS |
| 3 | **Advisor replies misclassified as review verdicts** — advisory guidance can flip task `validation` | consultant engaged via reviewer machinery; `recordReviewerVerdict` gates on run kind only (`task-actions.server.ts:1336`) | confirmed by code |
| 4 | **Notification routing prefs are decorative** — per-category toggles persist but `notifyTaskWatchers`/`createNotification` never read them | `profile-actions.server.ts:71-87` writes; only profile read consumes; no creation-path consumer | confirmed by code |
| 5 | **New-profile default resource grants point at mock ids** (`repo-write`, `test-runner`, "Coding standards") that resolve to no real resource | `RES_DEFAULTS` (`capability-catalog.ts:208`) used by `create-profile-modal.tsx:677-679`; server comment admits mock ids resolve to nothing | confirmed by code |
| 6 | **`quality` notification kind never emitted at runtime** — inbox quality cards exist only from seed; reviewer verdicts write timeline event but no notification | only `createNotification({kind:"quality"})` is seed (`demo-data.server.ts:855`) | confirmed by code |
| 7 | **Skills two sources of truth** — org_skills table (4 seed rows) drives org-settings UI; disk `data/skills/` (9 dirs incl. all 5 agent-expertise skills) drives what agents load + resource picker | org-settings shows 4; `buildResourceCatalog` scans disk | confirmed live |

## P2 — poor implementation / drift risk

| # | Finding | Location | Status |
|---|---|---|---|
| 8 | Binary-byte-poisoned source files — grep/rg silently skip `rebuilder.server.ts` and `use-live-updates.ts` (control char); already caused a false dead-code reading | `app/server/projections/rebuilder.server.ts`, `app/features/live-updates/use-live-updates.ts` | confirmed |
| 9 | `scheduleOperatorRun` legacy Phase-5 stand-in: quality-gate owner-assign path ALWAYS streams simulated narration even with a real backend; bypasses real runOperator | `run-service.server.ts:510`, called from `setOwner` | confirmed by code |
| 10 | Two parallel audit query implementations (prod uses `listAuditLog`/`countAuditLog`; `listAuditEvents` is test-only) | `audit-recorder.server.ts:93` vs `activity-feed.server.ts:268` | confirmed |
| 11 | MCP `tools_count` seed-only; user-created MCP servers never show tool counts (no discovery handshake) | `resources.server.ts:406,449` | confirmed by code |
| 12 | User disable/enable implemented server-side, no UI | `user-admin.server.ts:245,253` | confirmed |
| 13 | `clearProjectCredential` / `listPats` unwired — no way to remove/rotate a project credential from UI | `pat-store.server.ts:256,134` | confirmed |
| 14 | Dead exports: `getDataRootForRuns`, `countRunLines`, `DEFAULT_HOME_PREFS`, `deploymentCountsByProfile`, `getSseBrokerStats` (test-only), unreachable `RES_CATALOG` fallback | various | confirmed |
| 15 | Operator noise: posts separate "Plan:" comment before every action (CCD-9: 2 comments in 2s); brevity guardrail doesn't cover plan narration | operator definition SOP step 2 | judgment call |
| 16 | CCD-9-style duplicate: packet-level duplication not caught by no-duplicate-summary guardrail (fallout of #1 but guardrail should also catch) | guardrail enforcement | needs test |

## P3 — cosmetic / seed hygiene

| # | Finding | Location |
|---|---|---|
| 17 | Seed notifications deep-link to phantom tasks (DEP-31, BIL-9) → graceful 404 | seed data |
| 18 | Org GitHub connection seed row "PAT ····0000 · not validated" looks broken | org-seed |
| 19 | Login OAuth fake "Checking whitelist…" ~900ms spinner when provider unconfigured | `login.tsx:303-341` |
| 20 | Email-channel + nudge notification prefs persist in schema, no UI (ruling 13 — dormant by design; consider deleting the dead schema instead) | `notification-prefs.ts:23-42` |
| 21 | `app/features/auth/` empty dir | — |
| 22 | `invite-domain` duplicate → toast but modal stays open ("Mock:" comment) | `org.settings.tsx:206-208` |

## New findings from phase-3 live testing (2026-07-10)

| # | Finding | Evidence | Status |
|---|---|---|---|
| 23 | **P2 — literal `\n` escapes rendered in timeline comments.** Operator's post_comment text persisted with literal backslash-n sequences ("**Plan — ATL-1**\n\nObserved:…") — model emitted escaped newlines and nothing normalizes them; renders raw in UI | ATL-1 comment 2026-07-10T20:38:19 | confirmed live |
| 24 | **P2 — Ready-stage operator turn is a no-op bounce.** On `ready` (auto boundary to impl, copy says "Operator, when a primary specialist is assigned") the operator neither assigns the Developer nor advances — it posts a recommendation for a transition at an AUTO boundary and waits for a human. Either operator should act at auto boundaries (cap recommend should not bind below-approval boundaries) or assign-then-advance in one turn. Also: it did not assign the specialist despite Developer being stage-eligible at ready | ATL-1 20:38 run | confirmed live |
| 25 | **P3 — balanced preset still deploys `consultant` profile** (to be removed per decision A) | atlas-api project.md agents[] | confirmed |
| 26 | **P1 — 403 RBAC pages lose the server's denial message.** `require-project.server.ts:35` throws `data(userMessage, {status:403})` but root error boundary (`app/root.tsx:150-153`) renders `statusText \|\| "An unexpected error occurred."` and never reads `error.data` → non-members see "Error 403 Internal Server Error" instead of the explanation | live: deniz GET policy | confirmed live |
| 27 | **P2 — broken task frontmatter falls back to hardcoded stage `triage`** (`task-file.schema.ts:356`) not the project's first stage / last-known stage → task jumps board columns while YAML is broken; wrong for projects without a `triage` stage id | live: FSP-1 probe | confirmed live |
| 28 | **P3 — update-profile with empty definition stores generated placeholder desc** ("<Name> — a <role> specialist.", grammar "a implementation") shadowing the org template prose | `agent-profile-actions.server.ts:306-308` | confirmed |
| 29 | **P1 — new projects get zero guardrails.** Create-project wizard writes `guardrails: []`; the PRD's anti-noise guardrails (meaningful-comment, operator-brevity, no-duplicate-summary, compression-threshold, evidence-separation) exist only on the seeded demo project → timeline compaction + brevity enforcement are OFF for every real project | atlas-api project.md | confirmed live |
| 30 | **Retest PASS — operator single-flight lease** (case 9): two simultaneous @operator comments → exactly one new run. Residual: check-then-insert still has a narrow await-gap; harden with atomic claim in phase 4 | ATL-2 20:48:42 | retest PASS |
| 31 | **P0 — agent-side delivery invisible to the canonical record.** Codex Developer (caps direct) really branched/pushed/opened PR #9 on github.com/akin-ozer/cc-devops-skills via inherited gh credentials, but task.md stayed `branch: null, pr: null` — server-side ensureTaskBranch/openTaskPr only run through the stored-PAT path, so agent-delivered branches/PRs break task↔branch↔PR traceability (NFR15) and the GitHub page shows nothing. Also: agent picked branch name `ATL-3` (not the server's `atl-3-<slug>` convention). Fix direction: after a specialist run, reconcile task frontmatter from the agent's reply/workspace (parse branch+PR), or reconcile against GitHub by task-key convention, or instruct agents to report branch/PR via a structured channel | ATL-3 live, PR #9 real | confirmed live |
| 32 | **P1 — session export broken for every real run** (case 42 FAIL): `createAdapters` (runtime-registry.server.ts:139-148) omits the `CLAUDE_CONFIG_DIR` default (only passes it when explicitly in .env) while session-export + buildRuntimeEnv default to `data/runtimes/claude-home` → SDK writes transcripts elsewhere; `GET /resources/session-export?run=<real claude run>` 404s ("No claude session transcript found"). Cross-restart resume similarly at risk. Fix: single source for the config-dir default | live 20:49 export probe | confirmed live |
| 33 | **P2 — Codex runs have no tool confinement** (known; reconfirmed): disallowedTools threaded only into the Claude adapter; codex adapter ignores allowed/disallowed and merges full process.env (user's gh auth!) with danger-full-access. Capability enforcement for codex specialists rests entirely on the prompt | codex-runtime.server.ts | confirmed by code |
| 34 | **P0 — operator/specialist Claude runs are NOT tool-confined.** Live init envelope shows the operator run carries Bash/Edit/Write/WebSearch/Task/Cron*/SendMessage + all viberr MCP tools under bypassPermissions — `allowedTools` in the Agent SDK is a permission ALLOWLIST (auto-approve), it does not remove tools; under bypassPermissions it's a no-op. "The operator can never write code" is prompt-enforced only. Same for specialists (no allowedTools at all) | ATL-5 operator init envelope | confirmed live |
| 35 | **P0 — runs leak the user's entire global Claude Code environment.** Specialist init shows the user's personal skills (deep-research, dataviz, code-review, …), 30+ slash commands, custom agents, harness tools — because the SDK subprocess inherits `~/.claude` config (no CLAUDE_CONFIG_DIR isolation, see #32). Case 24/27 (skill isolation) FAIL: unrelated skills ARE loaded. Viberr runs need a clean isolated config dir + explicit tool surface | ATL-5 prober report + init envelope | confirmed live |
| 36 | **P1 — declared org MCP server reaches the run but fails to connect** (`{name:'everything', status:'failed'}`): resolveSpecialistMcpServers wiring works; the stdio spawn dies — likely because createAdapters passes a REPLACEMENT env (token only, no PATH) to the SDK. Case 26 FAIL at the connection step | ATL-5 init envelope | confirmed live |
| 37 | **P2 — create-profile merges permissive default caps** the client never sent (prober got commit-push-branch:direct, create-task-branch:direct, open-review-pr:recommend on top of the 2 caps submitted) — new custom profiles are default-permissive | atlas-api project.md prober deployment | confirmed live |

## Product decisions (owner, 2026-07-10 — via AskUserQuestion)

| Q | Decision |
|---|---|
| A | **REMOVE the Advisor/consultant profile entirely; the operator absorbs its job.** Delete profile+definition+seed references; FR14 "consultants" satisfied by multi-reviewer/specialist ability. Verdict-classification bug (#3) becomes moot for advisors but keep classification robust for reviewers. |
| B | **Wire notification routing prefs for real** — creation paths consult recipient prefs; also emit runtime `quality` notifications (#6) so the toggle governs something. |
| C | **Disk is truth for skills (and KBs)** — org settings lists every disk dir, metadata layered from table; auto-sync (#7). |
| D | (Technical call, mine) delete `scheduleOperatorRun` legacy path; route through real runOperator (#9). |
| E | **Fold operator plan into the action comment** — one operator comment per turn (observed → did/recommends); update operator definition SOP + brevity guardrail enforcement (#15). |
