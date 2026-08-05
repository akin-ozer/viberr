# Viberr — PRD-vs-implementation gap analysis (pass 18, 2026-08-05)

**Question this answers:** *what to build, what's missing, what needs change* — derived
requirement by requirement from the canon, then verified in the tree.

**Tree under analysis:** branch `pass18/product-fixes` @ `1f6b689` (PR #140, **OPEN** —
pass-18 work is NOT on `main` yet). 216 test files; 2860 unit/integration tests green at
last full run; 8 e2e specs against the production image.

**Method.** Every FR and NFR was re-derived from the code by six parallel verification
sweeps, each required to cite `file:line` before claiming a state. Docs were used to find
*intent*, never to prove *behavior*. Where a subagent's claim contradicted the code on
re-check, the code won and the correction is recorded inline (two such: FR15, F18-9).

---

## 1. Executive summary

### Counts

| | DONE | PARTIAL | MISSING | SUPERSEDED / REJECTED |
|---|---|---|---|---|
| Functional (FR1–FR39) | **36** | **3** (FR5, FR27, FR33) | 0 | FR7/FR11/FR30 clauses struck; responsive review-first mode retired |
| Non-functional (NFR1–NFR18) | **9** | **8** | **1** (NFR1) | NFR8 narrowed by ruling 39 (R16-5) |
| Journeys (J1–J4) | 3 | 1 (J4) | 0 | — |
| UX-spec named components (5) | 4 | 0 | 1 (Continuity Recovery Panel) | — |

**The product is functionally built.** Every functional requirement has real, tested,
server-enforced machinery behind it. Nothing in the PRD is unimplemented. The gaps are
concentrated in three places: **one governance-honesty hole in acceptance**, **the
non-functional envelope (never measured, one requirement with no mechanism at all)**, and
**the one named UX component Journey 4 is written around**.

### The five things that actually matter

1. **FR27's confirm-dialog clause is unmet at three of five acceptance entry points.** A
   board **drag into Done** performs a full `acceptCompletion` — a real PR merge — with
   no dialog at all (`app/routes/project.board.tsx:56-76`, `task-actions.server.ts:3065-3081`).
   Same for the task-detail stage menu → Done and for Apply on an `accept_completion`
   recommendation. The gates (verdict, PR-head) all hold, so nothing unsafe merges — but
   ruling 20 / FR27 say *"every acceptance, gated or forced, passes through a confirmation
   dialog stating what will merge"*, and three paths don't. This is new; no prior pass
   audited the dialog across writers (pass 16 audited the *gates* across writers).
2. **NFR14 is unmet for two failure classes on the automated path.** The poller discards
   `auth_failed` and `network_unavailable` per-project results with a `logger.warn`
   (`reconcile-poller.server.ts:133-138`); only scope violations reach a user surface.
   A revoked PAT or a GitHub outage is invisible in the app until someone clicks
   "Update status". This is sharper than the carried D16 (which only argued cadence).
3. **NFR1 has neither mechanism nor measurement.** `board-query.server.ts:161` selects
   every task in the project with no `LIMIT`, deliberately including archived rows, and
   the board renders them all un-virtualized. NFR1–NFR4 have never been measured in 18
   passes; there is no benchmark, no p95 instrumentation, no perf script anywhere in the
   repo. (Carried as D17 — now with the precise mechanism gap named.)
4. **The Continuity Recovery Panel still does not exist** — the fifth named UX component
   and the surface PRD Journey 4 is written around. Pass 18's G8 fixed the *classification*
   (the continuity event is now warning-toned, `run-service.server.ts:616`), but there is
   no panel, no Execution-Truth-Strip continuity state, and no board triage state.
   (Carried as D18; G8 closed one third of it.)
5. **Doc canon has drifted again, in the exact way ruling 44 (R17-3) exists to prevent.**
   `design/prd.md` and the canon PRD are no longer byte-identical (pass-17's FR14/FR20/FR27
   amendments landed only in canon) — ruling 27 / R15-8 requires both maintained. Ruling 7
   still says "eight" packet kinds; there are nine. The route map still omits four live
   routes.

### What is emphatically NOT a gap

RBAC and capability enforcement, secret isolation on the run path, idempotency, the
anti-noise guardrails, revision-bound review, delivery-as-operator-decision, PR adoption
identity, scheduled re-runs, and continuity *mechanism* are all sound and adversarially
re-verified this pass (see `NEW-FINDINGS.md` §"Investigated — NO defect"). Phase-2 scope
(analytics, subtasks, audit export) is correctly absent, not drifted.

---

## 2. Precedence used

1. `planning/planning-artifacts/prd.md` — **the canon PRD** (`design/prd.md` is a stale copy).
2. `docs/architecture/decisions.md` — 50 numbered rulings; **later rulings override the PRD**.
3. `design/CONVERSATION-SUMMARY.md` — the REJECT list and copy bans (binding as "do not re-add").
4. `planning/planning-artifacts/ux-design-specification.md` — principles, named components.
5. The code and its tests — the only proof of behavior.

---

## 3. Requirement-by-requirement

### 3.1 Workspace access & collaboration

| id | title | state | evidence |
|---|---|---|---|
| **FR1** | Sign in, access shared workspaces | **DONE** | `app/server/auth/login.server.ts:63` (better-auth session, rate-limited, forced-reset gate `:154`); `app/features/home/home-query.server.ts:118` (membership-scoped listing); `app/routes/project.tsx:74` |
| **FR2** | Admin manages membership + roles; permissions enforced | **DONE** | Single-source `app/shared/rbac.ts:61`; `app/features/policy/policy-actions.server.ts:92` (`setMemberRole` behind `manage-members`); chokepoint `app/server/tasks/task-actions.server.ts:303` → `app/server/auth/project-authority.server.ts:310`; matrix test `app/features/policy/policy-rbac.server.test.ts:723`. Live-verified as a real contributor (LIVE-VERIFY-SESSION §RBAC): `POST save-project` → 403 server-side |
| **FR3** | Shared visibility into state changes | **DONE** | `app/server/events/sse-broker.server.ts:78`; `app/routes/resources.events.ts:100` (membership-authorized, `Last-Event-ID` resume `:181`); client revalidation `app/features/live-updates/use-live-updates.ts:87` |
| **FR4** | Comment + @-address in one timeline (members-only per R15-4) | **DONE** | `app/server/tasks/task-actions.server.ts:759` (`appendComment` into the one timeline); `app/server/tasks/mention-notify.server.ts:237`; members-only gate `app/routes/project.tsx:74`; the old non-member comment label is deliberately gone (`app/features/task-detail/timeline.tsx:148`) |
| **FR37** | Task owner = reviewer + acceptance authority; widened by R14-2 + R15-3 | **DONE** | `task-actions.server.ts:320` (`ownerException`), `:333` (`requireAcceptCompletion`), `:359` (R14-2 decision authority), `:5446` (R15-3 `ownerApplied`/`asCoordination`) — inner capability gates still apply |
| **FR38** | Self-service take/release; admins release any owner; typed events + audit | **DONE**, one deliberate narrowing | `task-actions.server.ts:2835` (`setOwner`), `:2929` (`releaseOwner`), typed `assign` events `:2885`/`:2963`, audit `:2900`/`:2985`. **Narrowing:** viewers cannot own — `own-task` is admin/maintainer/contributor only (`app/shared/rbac.ts:65`), per the Q5 clean-tiering ruling. PRD says "any member assigned to the project"; the ruling is later and wins |

### 3.2 Project governance & policy

| id | title | state | evidence |
|---|---|---|---|
| **FR5** | Admin users can create and configure governed projects | **PARTIAL — deviation, needs a ruling** | *Configuration* is admin-gated (`app/features/project-settings/settings-actions.server.ts:107`, `edit-policy`). *Creation* is deliberately self-serve for **any signed-in user**, org role explicitly not consulted (`app/routes/_index.tsx:174`, `app/features/home/project-create.server.ts:189`; creator seeded as project admin `:289`). The PRD says "Admin users can create". Either amend FR5 or gate creation — see **QN-2** |
| **FR6** | Stages, allowed transitions, approval boundaries | **DONE** | Stage CRUD under `edit-policy` (`settings-actions.server.ts:369/406/461/538`); `policy-actions.server.ts:179` (`setTransitionBoundary`); vocabulary `app/schemas/project-file.schema.ts:28`; runtime enforcement `task-actions.server.ts:3096/3108/3117` |
| **FR7** | One project, one repository (override struck) | **DONE — strike is real** | `app/schemas/project-file.schema.ts:176`; task-level `repo` is now an *unknown key* (`app/schemas/task-file.schema.ts:504`, `:717`, `:1054`); `app/server/github/github-context.server.ts:57` has no override read; regression test `settings-route.server.test.ts:372` |
| **FR8** | Separate human RBAC and agent capability policy | **DONE** | `app/shared/rbac.ts:61` vs `app/shared/capabilities.ts:31` + per-project grants `project-file.schema.ts:127`; two separately-gated surfaces on one page (`policy-page.tsx:253` vs `:537`); agent policy has runtime teeth `app/server/tasks/specialist-tool-policy.ts:52` |
| **FR9** | Reusable agent profiles (global base + project customization) | **DONE** | `app/server/org/gagents.server.ts:199` (global base); `project-file.schema.ts:85` (project fork: backends, model, effort, persona, stages, spanAll, autonomy, resources); `app/routes/project.agents.tsx:117`/`:135`; eligible stages enforced not decorative `specialist-run.server.ts:1945`, `:758` |

### 3.3 Task records & lifecycle

| id | title | state | evidence |
|---|---|---|---|
| **FR10** | File-native store, inspectable + reconciled | **DONE** | chokidar watcher `app/server/files/file-watch.service.server.ts:223`; boot rescan before watcher `app/server/boot.server.ts:238`/`:264`; unknown-key/unknown-section round-trip preservation `app/server/files/task-file.server.ts:22` |
| **FR11** | Humans create tasks; agents cannot | **DONE** | `task-actions.server.ts:438` (`create-task`, sole entry); `create-task` exists only in the **human** RBAC table (`rbac.ts:64`) with no capability counterpart; neither toolkit exposes creation (`operator-toolkit.server.ts:95-404`, `agent-toolkit.server.ts:222/249/304`). *Note: no packet kind is specific to "a new task is needed"; it lands as `custom`/`input`* |
| **FR12** | Canonical operating record | **DONE** | `app/schemas/task-file.schema.ts:473` (identity, state, execution context, refs, ownership, decisions); `:1260` (`ParsedTaskFile` = frontmatter + goal + packet + timeline + extraSections) |
| **FR13** | Governed stage transitions | **DONE** | `task-actions.server.ts:2995` (`transitionStage`: boundary lookup, per-boundary authority, operator barred from a bare move into done `:3091`, vetted backward rework); tests `task-governance.server.test.ts:415-559` (re-run green this pass) |
| **FR14** | One delivering + supporting engagements; owner separate | **DONE** | `task-file.schema.ts:482` (`engagements[]`; a second `delivers:true` is coerced with a diagnostic `:849-861`); `:539` (`requiredReviewers` = supporting + `verdictCapable`); snapshot at engage time `specialist-run.server.ts:403`/`:523` |
| **FR15** | Agents flag low-quality tasks and request clarification | **DONE** *(corrected)* | `agent-toolkit.server.ts:249` (`ask_human` → `blocked` packet + `waiting:human`); typed `quality` events + audit + notify `task-actions.server.ts:2006`/`:2122`; triage quality gate blocks forward movement on a vague goal `operator-run.server.ts:2137`; tasks are created `input_required` `task-actions.server.ts:472`. **Correction:** a sweep flagged `flag-underspecified-tasks` (`capabilities.ts:100`) as a dead toggle. It is not — `group: null` means **matrix-only advisory** by design (`capability-catalog.ts:42`, `:119-131`), disclosed under "Other actions" per ruling 7 + R15-12. No defect |
| **FR16** | Typed events + conversation in one chronology | **DONE** | `task-file.schema.ts:47` (one `TIMELINE_EVENT_TYPES` incl. `comment`); one newest-first `## Timeline` section `task-file.server.ts:29`; one rendered list with All/Important/Comments `timeline.tsx:33`; tolerant unknown-type fallback `event-meta.ts:51` |
| **FR17** | Validation outcomes, evidence, change summaries, compression | **DONE** | Validation derived from `workRevision` + verdicts `task-file.schema.ts:553-575`; `EvidenceRow[]` `:1181`/`:1213`; `github.changed{files,add,del}` + commits cache `:346` reused in the PR body `pr-open.server.ts:273`; compaction `timeline-compaction.server.ts:52` (threshold 60/keep 24; never folds typed events or human comments), now also on the agent-reply writer (G7) |

### 3.4 Agent orchestration & continuity

| id | title | state | evidence |
|---|---|---|---|
| **FR18** | Dedicated operator per active task | **DONE** | `app/server/runtimes/operator-run.server.ts:688` (`runOperator`, per-task single-flight lease `:706-712`, queued not dropped); auto-invoked `task-actions.server.ts:687` gated on `authority.deployed` `:704`; run row `operator-run.server.ts:1721`. *Note: the operator is stateless per drive (fresh `threadId`); continuity is by canonical re-read, which is the FR22 model* |
| **FR19** | Codex / Claude Code non-interactive runs | **DONE** | `claude-runtime.server.ts:276` (`@anthropic-ai/claude-agent-sdk` `query()`, `permissionMode` `:519`); `codex-runtime.server.ts:388` (`@openai/codex-sdk`, `runStreamed` `:519-552`); "approved profiles only" `specialist-run.server.ts:223` |
| **FR20** | Operator recommends + triggers + re-engages | **DONE** | Recommendation kinds `task-file.schema.ts:155-175`; packets `operator-actions.server.ts:686`; `operatorPromptSpecialist` `:1449`, `operatorPromptReviewer` `:1535` (idempotent), generic routing `:1765`/`:1687`; every one capability-gated |
| **FR21** | Specialists append outcomes, blockers, evidence | **DONE** | One outcome envelope `agent-outcome.server.ts:14-76`; blockers `agent-toolkit.server.ts:177`/`:250`; atomic write of reply+verdict+question+evidence `task-actions.server.ts:2204`, evidence derivation `:1842`; conservative grants for a vanished profile (R15-7) |
| **FR22** | Resumable threads; continue when runtime history is gone | **DONE** | Probe-before-resume `run-service.server.ts:712`; on `missing` → `session_missing` stamp `:538-544`, typed `continuity` event `:593-626`, fresh run with re-anchor preamble `:721-739`; dead sessions excluded from future selection `agent-reply.server.ts:250`. *Note: operator re-engagement of an already-engaged agent starts fresh; session resume is the @mention/answer path (`task-actions.server.ts:1226`, `:624`)* |
| **FR23** | Access the native runtime session for debugging | **DONE** | `app/routes/resources.session-export.ts:31` (membership-gated `:43`; builds a `claude --resume` / `codex resume` installer); raw log paging `resources.run-log.ts:38`; UI entry `runs-panels.tsx:308` |
| **FR39** | Scheduled operator re-run | **DONE** (all seven clauses) | `app/server/tasks/schedule.server.ts` — RBAC `project.task.tsx:758`/`:784`; canonical in the task file `:147-155`; carries backend+autonomy `:131-145`, replayed `:396-408`; terminal-stage refusal at create `:126-129` and fire `:309-336`; 60 s runner `:475` wired at `boot.server.ts:33`; visible + cancellable `task-main-sections.tsx:282`/`:347`; audited `:157`/`:194`/`:351`; lease + bounded retry `:244-247`/`:419-449` |

### 3.5 Oversight views & human governance

| id | title | state | evidence |
|---|---|---|---|
| **FR24** | Board cards: stage, agent, waiting state, validation | **DONE** | Stage columns `board-page.tsx:953`; agent `:150`; waiting human-vs-agent `:128` (member-scoped "waiting on you" per R8-3 `:138`); `ValidationPill` `:330`; readiness `:257`; branch/PR `:264`; R16-6 merge-pending / closed pills `:281-306` |
| **FR25** | Task detail prioritizes state, profile, packet before timeline | **DONE** | Contract at `task-main-sections.tsx:24`, realized `task-detail-page.tsx:345` hero → `:356` live run → `:365` diagnostics → `:368` packet → `:383` recommendations → `:394` execution profile → **`:442` timeline last** |
| **FR26** | Structured blocking / decision packets | **DONE** | `operator-actions.server.ts:771-830` (typed `blocked` vs `input`, `observations[]` + `options[]` with one recommended, sets `waiting:human`, single-open-packet guard `:731-739`, audited); agent-raised questions `agent-outcome.server.ts:339-372`; resolution UI `decision-packet.tsx:117-130`/`:321-338`. Packets cannot be emitted empty or malformed (validated title + ≥1 option + known kinds) |
| **FR27** | Approve/reject/redirect; human-only Done; verdict-gated acceptance; **confirm dialog on every acceptance** | **PARTIAL** | **DONE:** human-by-default Done `task-actions.server.ts:3065-3081`; operator barred from a bare terminal move `:3083-3090`; ALWAYS_HUMAN ids `capabilities.ts:161-166` coerced server-side `agent-profile-actions.server.ts:185`/`:239`; the single autonomy exception requires `full` **and** an explicit `direct` grant `operator-actions.server.ts:2062`, non-promotable `capabilities.ts:48`, audited `:2122-2130`; unified verdict + PR-head gate at **every** writer `task-actions.server.ts:4694-4760`, `:4797-4830`, in-lock re-assert `:5072-5085`; force-accept is the only bypass and is audited `:5275-5320`; R16-6 merge-pending `operator-actions.server.ts:2102-2106`. **R17-1 SHIPPED** (drift computed `github-reconciler.server.ts:308-341`, surfaced in the shared accept **and** force-accept dialog `accept-confirm.tsx:105-124`, review-queue subline `review-helpers.ts:47-52`, completion record on all three writers). **R17-2 SHIPPED** (`noChanges` `task-file.schema.ts:517`, gate exception `task-actions.server.ts:4709-4713`, distinct events, dialog copy `accept-confirm.tsx:85-90`). **GAP:** the confirm dialog wraps only the detail-page Accept / Force-accept. Three other paths reach `acceptCompletion` on one click: board drag or card StageMenu → Done (`app/routes/project.board.tsx:56-76` — the honest toast is written *after* the merge), task-detail stage menu → Done (`task-side-panels.tsx:442-448` → `project.task.tsx:554-576`), and Apply on an `accept_completion` recommendation (`operator-recommendations.tsx:101` → `task-actions.server.ts:5546-5553`). The packet path has a two-step confirm but names no PR, revision, target branch or missing signal (`decision-packet.tsx:321-338`) |
| **FR28** | Review progress without raw logs | **DONE** | Typed events + evidence rows `timeline.tsx:183-190`; validation summarized into sentences, never raw output `task-actions.server.ts:1962-1980`; raw provider material explicitly optional and member-gated with copy saying the summary suffices `task-detail-page.tsx:412-437` |

### 3.6 GitHub delivery & traceability

| id | title | state | evidence |
|---|---|---|---|
| **FR29** | Authenticate to GitHub, access authorized repos | **DONE** | AES-256-GCM sealed PATs `app/server/secrets/pat-store.server.ts:16`, `secret-box.server.ts:11` (rotation via `..._KEY_PREVIOUS`); honest classic/fine-grained scope validation `pat-validator.server.ts:28`; repo probe `repo-access-check.server.ts:37` |
| **FR30** | One repo per project, no per-task override | **DONE** | `github-context.server.ts:57` (`projectRow?.repo ?? null`); former call sites carry deletion notes `branch-sync.server.ts:194`, `github-reconciler.server.ts:174`; the admin toggle and its audit action are removed `settings-actions.server.ts:727` |
| **FR31** | Branches, commits, PRs tied to the task; **delivery is an operator decision** (R15-2) | **DONE**, all five clauses | `performDelivery` is no longer a transition side-effect `task-actions.server.ts:3345`; gate `operator-actions.server.ts:297` with R15-9 absent-grant resolution; tool withheld when `off` `operator-toolkit.server.ts:341`, prompt tells it to open a packet when unsure `:347`; `recommend` → human-applied `delivery` recommendation `task-file.schema.ts:171`; human escape hatch `task-side-panels.tsx:215`; specialists genuinely cannot push — SDK deny rules not prompt guidance `specialist-tool-policy.ts:63-64`; review stage with no PR writes a typed event `task-actions.server.ts:3267` |
| **FR32** | Branch + PR status alongside task state | **DONE** | `task-side-panels.tsx:87` (repo, branch, PR number + state pill; honest "no branch yet" `:95`); board chips `board-page.tsx:265` |
| **FR33** | Auditable history; 90-day retention; no export in V1 | **PARTIAL — the record is wrong, not the code** | Recorder + secret-free `details` contract `app/server/audit/audit-recorder.server.ts:10`; coverage test `audit-coverage.server.test.ts:13-31`; 90-day delete on every boot `retention.server.ts:23` + `boot.server.ts:286`; **no export path anywhere** (correct per PRD — the only `Content-Disposition` is the run-transcript export `resources.session-export.ts:71`). **Gap:** two actions are exempt from the delete *forever* — `task.agent.replied` and `runtime.operator.plan_executed`, because boot recovery uses their rows as idempotency keys (`retention.server.ts:42`, applied `:74`). Neither FR33 nor the runbook says so, so "hard-deleted at 90 days" is not true as written (carried D7 / Q17-6) |
| **FR34** | Secrets isolated from task-visible artifacts | **DONE** | Token never in argv, URL or persisted git config — short-lived `GIT_ASKPASS`, ambient helpers disabled, `dispose()` `git-clone-auth.server.ts:36`; per-run redactor applied to raw **and** display before persist `run-sink.server.ts:261`; PAT audit details carry label + last-4 only `pat-store.server.ts:114` |
| **FR35** | Quality issues and policy violations as first-class events | **DONE** | `quality` and `policy` are typed event kinds `task-file.schema.ts:47-56`; quality flags `task-actions.server.ts:2006`/`:2135`; violations open a projection row + typed event + notification, idempotently `scope-flag.server.ts:111`, raised from PR-open `pr-open.server.ts:308` and the reconciler `github-reconciler.server.ts:201` |
| **FR36** | Manual re-scan and reconciliation | **DONE**, RBAC-gated maintainer+ (R8-4) | `project.board.tsx:86` (`assertProjectAction("rescan-project")`, UI derived from the same gate `:116`); `project.github.tsx:62` (`requireGithubAction("reconcile-github")`); both `[Admin, Maintainer]` in `rbac.ts:72`/`:74`; project-scoped rebuild + audit `rescan.server.ts:32` |

### 3.7 Non-functional

| id | title | state | evidence |
|---|---|---|---|
| **NFR1** | Board ≤200 cards in ≤2 s | **MISSING** (no mechanism, no measurement) | `board-query.server.ts:161` — `SELECT * FROM task_projections WHERE project_slug = ?`, **no LIMIT/OFFSET**, and `:206` deliberately loads archived rows too, hidden client-side; `board-page.tsx:437` plain `.map`, no virtualization, no windowing dep in `package.json`. No benchmark, no perf script, no p95 anywhere in the repo. It is the *only* unbounded projection query — activity (`activity-feed.server.ts:41`, `:105`) and notifications (`notifications.server.ts:202`) all carry limits |
| **NFR2** | Task detail ≤2 s for 95% | **PARTIAL** | Client-side done: 30-event slice `project.task.tsx:115-118`, `timeline-slice.ts:8-9`. Server still reads the whole history — `task-query.server.ts:95-100` (`SELECT * FROM task_events … ORDER BY position ASC`, no LIMIT) then slices in memory `:149`. No p95 measurement |
| **NFR3** | Governed action reflected ≤3 s | **PARTIAL** (mechanism sound, unmeasured) | No-optimistic-UI + revalidation is deliberate `use-live-updates.ts:10-21` with a 300 ms trailing debounce `:39`. Nothing asserts a latency anywhere |
| **NFR4** | Others see updates ≤5 s | **PARTIAL** | Persist-then-publish `run-sink.server.ts:264-290`; scoped authorized stream `resources.events.ts:60-120`. But the reopen backoff reaches 30 s (`use-live-updates.ts:47`), so the bound is not held in the degraded state — the UI is honest about it ("live updates paused — retry", `topbar.tsx:165`) but the number is unmet and unmeasured |
| **NFR5** | Timeline usable without full raw history | **DONE** | `timeline-slice.ts:8-43` (30-event window + "Show older"); `resources.run-log.ts:11-24` (`?since=` / `?before=&limit=`, clamped 500 `:57`); `run-projection.server.ts:61-62` (400 lines / 384 KB window); canonical compaction `timeline-compaction.server.ts:38-41` |
| **NFR6** | Encrypted in transit | **PARTIAL** | External is DONE (`github-client.server.ts:15` pins `https://api.github.com`). App traffic is a **deployment** guarantee only: `docs/operations/deployment.md:36-72` requires a TLS-terminating proxy; nothing in code asserts it. `BETTER_AUTH_URL` is optional and unvalidated for scheme (`env.server.ts:44`); CSRF checks origin equality, not scheme (`csrf.server.ts:57-85`). The only "enforcement" is better-auth's inherited `__Secure-` cookie default |
| **NFR7** | Credentials never in timelines/comments/audit/logs | **PARTIAL** | Strong on the run path: per-run redactor over injected values + `ghp_`/`github_pat_`/`sk-` shapes, applied before persist `run-sink.server.ts:117-147`, `:264-265`; agent replies inherit it `agent-reply.server.ts:503-508`; spawn envs stripped `runtime-registry.server.ts:441-455`. **Gaps:** the general logger has no redaction (`logger.server.ts:48-80` serializes any field verbatim); audit `details` secret-freedom is a doc-comment convention with no filter (`audit-recorder.server.ts:10-11`); human-typed comments are never scrubbed |
| **NFR8** | Separate human/agent boundaries **on every governed action** | **PARTIAL — narrowed by ruling 39 (R16-5)** | Human `rbac.ts:61-88` → `project-authority.server.ts:167-231`; agent `capabilities.ts:32-107` with the three ALWAYS_HUMAN locks, enforced at the tool layer `specialist-tool-policy.ts:52-92`. The carve-out is deliberate: MCP tools sit outside the matrix, pinned by the *absence* of an `mcp__*` deny rule (`specialist-tool-policy.test.ts:290-292`) and disclosed in `capability-matrix-modal.tsx:230`. "Every governed action" is therefore not literally true and the PRD still reads as if it were (carried D12 / Q17-2) |
| **NFR9** | Least-privilege GitHub/runtime credentials | **DONE** | Per-project PAT binding with `requiredScopes` defaulting to `repo` + `pull_request:write` only `pat-store.server.ts:27-39`, `:355-393`; agents hold **no** push credential `specialist-run.server.ts:1063`; the server performs all pushes/PRs. Scoping is per-project; per-task narrowing is by workspace isolation, not by token |
| **NFR10** | Security-relevant actions audited (4 classes) | **DONE** | Unauthorized attempts `project-authority.server.ts:208-229` (`project.authority.denied`, 60 s dedupe `:95-119`, one documented `silentDeny` carve-out for @mention `:284-299`); credential failures `pat-validator.server.ts:530-546`, `connections.server.ts:239-247`; policy changes + human approvals (`project.policy.boundary_changed`, `project.member.role_changed`, `task.transition`, `task.packet.resolved`, `task.acceptance.forced`, org-admin override `project-authority.server.ts:189-201`) |
| **NFR11** | Consistency across restarts | **DONE** | Boot rescan rebuilds projections from files before the watcher starts `boot.server.ts:238`/`:264` → `rescan.server.ts:13` → `rebuilder.server.ts:707`; WAL + checkpoint on shutdown `sqlite.server.ts:15-17`, `:67` |
| **NFR12** | Continue from canonical state when history is gone | **DONE** | `run-service.server.ts:538-540`, `:584-587`, `:593-626`; boot recovery chain `boot.server.ts:98-110` |
| **NFR13** | Reconcile/re-scan without corrupting canonical state | **DONE** | `rescan.server.ts:9-46` writes only projections + an audit row, never files; `rebuilder.server.ts:343-348`, `:503-506` touches only `task_projections`/`task_events`/`diagnostics`, never `audit_events`; single-flight guard `single-flight.server.ts` |
| **NFR14** | GitHub failures surfaced with task context ≤10 s of detection | **PARTIAL — two failure classes never surface** | Detection is a 5-min poll `reconcile-poller.server.ts:22` (carried D16). Scope/permission failures surface in the same tick — typed `policy` event into `task.md`, watcher notification, reprojection `github-reconciler.server.ts:199-218` → `scope-flag.server.ts:22-36`. But `auth_failed` and `network_unavailable` are *return values* (`github-reconciler.server.ts:187-198`, `:224-231`) that the poller **discards** with a `logger.warn` (`reconcile-poller.server.ts:133-138`), and a project-level context failure returns silently `github-reconciler.server.ts:680-689`. A revoked PAT or an outage produces **no user-visible signal at all** on the automated path |
| **NFR15** | Branch/commit/PR uniquely traceable to the task key | **PARTIAL — mitigated, not solved** | The code documents that the naming scheme is not an identifier: `pr-adoption.server.ts:9-18` ("keys restart at 1 on a new data root"), same warning `github-reconciler.server.ts:1163-1176`. Identity now rests on `workRevision.headSha` (`decidePrAdoption` `pr-adoption.server.ts:57-72`, ownership `github-reconciler.server.ts:1183-1193`). **Missing:** any durable task↔PR marker (task id in the PR body/label), so a wiped data root can still collide on branch names — and a pre-R16-1 binding is never un-adopted (`github-reconciler.server.ts:288` `sameAsCached` keeps it honest forever). Carried D14 / Q17-4 |
| **NFR16** | Idempotent external actions | **DONE** | PR open `pr-open.server.ts:141-143`, `:222-234`, 422 handled `:328-331`; branch create `branch-sync.server.ts:204`, `:248-251`; same-stage transition early-return `task-actions.server.ts:3029-3032`; restart replays keyed on retention-exempt audit rows `retention.server.ts:42-45` + `task-actions.server.ts:1485-1505` |
| **NFR17** | Identity continuity across resumes, or explicit failure | **DONE** | `run-service.server.ts:538-544` (classified `err` stamped on the dead run), `:593-626` (typed `continuity` event stating the transcript is gone and a fresh session started); failure class `agent-reply.server.ts:530+`; resume preserves session id + workdir `run-service.server.ts:655-665` |
| **NFR18** | Durable audit trail across restarts/resync/failures | **DONE** (bounded per FR33) | WAL + checkpoint `sqlite.server.ts:15-17`, `:67`; rebuild/rescan never touch `audit_events`; retention explicit `retention.server.ts:23`, `:70-77`, `boot.server.ts:286`. *Note: audit writes are best-effort — failures are swallowed-but-logged `audit-recorder.server.ts:63-68`* |

---

## 4. Journeys

| journey | state | assessment |
|---|---|---|
| **J1 — Arda governs agent-driven delivery** (primary success path) | **DONE** | The whole loop is live-verified end to end this pass on a clean production-image environment: project create → operator auto-invoke → triage scope → auto-advance → Codex developer writes → server-owned push + PR → operator recommends → human applies → Claude reviewer verdict → human accept → merge → branch cleanup → Done (`LIVE-VERIFY-SESSION.md` FV-1a…FV-1f, PR #142 merged by the app). Board carries all four FR24 signals; the task page orders state-before-history |
| **J2 — Arda intervenes on a drifted task** (primary edge case) | **DONE** | Typed blocking packets with observations/options/recommendation (`operator-actions.server.ts:771-830`); recovery packets on PR divergence (ruling 17) with reopen auto-withdraw; R15-14 routes a resolved question back to the **asking agent** by resuming its session; R15-3 lets the task owner apply any recommendation. Live-verified: closed-PR recovery → archive (LV-0), out-of-band merge → honest reconcile → force-accept (FV-2d) |
| **J3 — Elif configures a governed project** (admin) | **DONE** | Stages/transitions/boundaries (FR6), repo (FR7), human RBAC and the agent capability matrix as two visibly separate surfaces on one page (FR8, `policy-page.tsx:253` vs `:537`), per-profile eligible stages / skills / MCPs / KBs / backend (FR9). One deviation to rule on: project *creation* is self-serve, not admin-gated (FR5 / **QN-2**) |
| **J4 — Murat investigates a continuity failure** (support) | **PARTIAL** | The *mechanism* is complete and honest (FR22/NFR12/NFR17 all DONE). The journey's own entry point — *"a continuity warning appears on task or board"* — is only half true: pass 18's G8 made the timeline event warning-toned (`run-service.server.ts:616`, `event-meta.ts:33`/`:62`), but there is **no** Continuity Recovery Panel, **no** continuity state on the Execution Truth Strip (`execution-profile.tsx` has no continuity reference), and **no** board triage state (`BoardFilterId = all｜human｜agent｜risk｜archived`, `board-filters.ts:7`). A supervisor scanning the board still cannot see degraded continuity. Carried **D18** |

### UX-spec named components (`ux-design-specification.md:611-664`)

Task Status Card **DONE** · Decision Packet **DONE** · Execution Truth Strip **DONE**
(minus its "degraded continuity" state) · Mixed Timeline Item **DONE** ·
**Continuity Recovery Panel — MISSING** (D18).

Two spec clauses on shipped components remain unmet: *"support keyboard navigation across
board lanes"* (`:620`) — there is no lane traversal, the only `onKeyDown` in
`board-page.tsx:628` is an Enter-submit in the new-task modal (**D19**); and the
Execution Truth Strip's *"degraded continuity"* state (**D18**).

---

## 5. What to build next — prioritized backlog

Sizes: **S** ≈ under a day, **M** ≈ a few days, **L** ≈ a pass of its own.

### P0 — a shipped ruling is contradicted in the product

**B1 · Confirm dialog on every acceptance path — S/M**
*Value:* a drag into Done currently merges a pull request with no dialog. The gates hold,
so nothing unsafe merges, but the human never sees "this merges PR #N into main at
revision X" before it happens — which is exactly what FR27 and ruling 20 promise. The
board's own toast is honest *after* the fact.
*Evidence:* `app/routes/project.board.tsx:56-76` → `task-actions.server.ts:3065-3081`;
`task-side-panels.tsx:442-448` → `project.task.tsx:554-576`;
`operator-recommendations.tsx:101` → `task-actions.server.ts:5546-5553`.
*Sketch:* the acceptance decision is already computed server-side
(`acceptanceRefusalReason`, `revisionDriftNote`, `noChanges`) and already rendered by one
component (`accept-confirm.tsx`, shared by accept and force-accept). Route the three paths
through it: (a) board — intercept a drop/StageMenu pick whose target is the terminal stage
and open the dialog before dispatching `reorder`; (b) task-detail stage menu — same
interception; (c) recommendation Apply — when `kind === "accept_completion"`, open the
dialog instead of submitting. Also enrich the packet path's "Confirm decision" for the
`accept_completion` option with PR number + revision + missing signals. Tests: each path
canaried by asserting no `acceptCompletion` call without a confirm.
*Owner question first:* ruling R6-4 said "drag = acceptance". Does a dialog on drag
contradict it, or complete it? See **QN-1**.

**B2 · The poller must surface auth and network failures — S/M**
*Value:* today a revoked PAT or a GitHub outage is invisible in the app; the user finds out
by clicking "Update status" on the GitHub page. NFR14's promise ("surfaced with
task-relevant context") is unmet for the two most likely failure classes.
*Evidence:* `reconcile-poller.server.ts:133-138` discards `summary` failure statuses;
`github-reconciler.server.ts:187-198`, `:224-231`, `:680-689` return them as values.
*Sketch:* treat a project-scoped `auth_failed` like a credential fact — raise the existing
connection-level "validation downgraded" surface (`connections.server.ts:239-247`) plus a
project-scoped notification, deduped like `project.authority.denied` is. Treat repeated
`network_unavailable` as a degraded-integration banner on the GitHub view and the board
rail, cleared on the next successful tick. Do **not** write a `policy` timeline event for
these — they are not policy violations. Files: `reconcile-poller.server.ts`,
`github-reconciler.server.ts`, `app/features/github/github-view.tsx`, notifications.

### P1 — named intent that has never shipped

**B3 · Continuity Recovery Panel + board triage state — M**
*Value:* closes Journey 4's entry point and the last of the five named UX components.
Today's cue is one amber timeline event mid-history; a supervisor scanning the board sees
nothing.
*Evidence:* no panel file in `app/features/task-detail/`; no continuity reference in
`execution-profile.tsx`; `board-filters.ts:7` has no continuity filter.
*Sketch:* add a `continuity` field to the task frontmatter (`task-file.schema.ts`) written
where G8 already writes the typed event (`run-service.server.ts:616`) and cleared on the
next healthy resumed run. Project it (`rebuilder.server.ts`, `board-query.server.ts`), add
a board pill + a filter id, add the Execution-Truth-Strip state, and build the panel to the
spec's anatomy: *what is known / what is missing / what remains authoritative / how to
continue safely / escalate*. The content already exists — the run's classified `err`, the
canonical task file, the last meaningful events. Note the spec explicitly wants this to
distinguish warning from failure (`ux-design-specification.md:655-664`).

**B4 · Measure NFR1–NFR4, and bound the board query — M**
*Value:* four numbers the product has asserted for 18 passes with no evidence, on the one
query that has no bound. Either the numbers hold and you can say so, or you learn where
they break before a user does.
*Evidence:* `board-query.server.ts:161` (no LIMIT, loads archived); `board-page.tsx:437`
(no virtualization); `task-query.server.ts:95-100` (whole timeline read server-side); no
benchmark anywhere in the repo.
*Sketch:* a seed script that builds a 200-task project with long timelines, then a small
timing harness (board loader, task loader, action round-trip, SSE propagation) run against
the production image the same way e2e is. Add virtualization or a LIMIT **only if a number
fails** — measuring first is the cheap half. Fold in the NFR2 server-side slice (push the
30-event window into SQL). If the numbers are wrong for the product's real envelope, amend
them rather than chase them (see **QN-5**).

**B5 · Audit export + name the retention exemptions — M**
*Value:* org- and auth-scoped events (sign-ins, user administration, PAT changes) have no
file counterpart and are genuinely gone at 90 days with no way to keep them. FR33's own
text is also untrue as written.
*Evidence:* `retention.server.ts:23`, `:42`, `:74`; no export route anywhere.
*Sketch:* (a) cheap and immediate — amend FR33 + `docs/operations/runbook.md` to name
`task.agent.replied` and `runtime.operator.plan_executed` as permanently exempt and say
why; (b) make the window env-configurable (`env.server.ts`); (c) an admin-only NDJSON/CSV
export of `audit_events` filtered by scope and date, streamed like
`resources.session-export.ts` already streams. (c) is the PRD's Phase 2 — moving it up is
an owner call.

**B6 · Durable task↔PR identity — M**
*Value:* the branch name is not an identifier and the code says so in two places. R16-1
stopped *new* foreign adoptions; it cannot un-adopt an old one, and a wiped data root can
still collide.
*Evidence:* `pr-adoption.server.ts:9-18`; `github-reconciler.server.ts:288` (`sameAsCached`
keeps a pre-rule binding forever), `:1163-1176`.
*Sketch:* stamp a durable marker when Viberr opens a PR — an HTML-comment task id in the PR
body (cheap, no extra scope) or a label. `decidePrAdoption` prefers the marker over sha
identity; the reconciler demotes a cached link to a divergence when the live PR carries a
*different* instance's marker. This also answers **Q17-4** (when may Viberr drop a PR
reference it once wrote) with a mechanical rule instead of a hand-repair.

### P2 — honesty and hardening

**B7 · Logger redaction + audit-details filter — S**
`logger.server.ts:48-80` serializes any field verbatim, and audit `details` secret-freedom
is a doc comment (`audit-recorder.server.ts:10-11`). The run path is already exemplary
(`run-sink.server.ts:117-147`) — reuse that redactor as a serializer hook and as a filter
in `recordAuditEvent`. NFR7's promise covers "general application logs" explicitly.

**B8 · Assert the transport boundary at boot — S**
NFR6 is satisfied by deployment, not by the app. Validate `BETTER_AUTH_URL`'s scheme in
`env.server.ts` and fail (or loudly warn) in production on a non-`https` origin with no
explicit opt-out; assert the `secure` cookie attribute rather than inheriting it.

**B9 · Push the timeline window into SQL — S**
`task-query.server.ts:95-100` reads every event then slices in memory (`:149`). A `LIMIT`
+ `OFFSET` keyed on the same 30-event contract removes the only unbounded growth on the
task page. Pairs with B4.

**B10 · Board keyboard lane traversal, or amend the spec — S (amend) / M (build)**
`ux-design-specification.md:620` asks for it; modernization A2 deliberately shipped the
StageMenu instead and recorded that only in an implementation note. Either add arrow-key
traversal across columns (independent of drag) or amend the spec to record the StageMenu
as the accessible path. Carried **D19 / Q17-10**.

**B11 · Doc-canon reconciliation (the R17-3 closing step, run again) — S**
All verified in this tree today:
- `design/prd.md` has diverged from canon again — md5 `783177bc…` vs `d3911299…`; canon
  carries pass-17's FR14/FR20/FR27 amendments and the design copy does not. **Ruling 27 /
  R15-8 requires both maintained.**
- Ruling 7 still says the packet-kind set is "eight"; `task-file.schema.ts:68-87` has
  **nine** (`archive_task`). Carried D2, unfixed for three passes.
- The `decisions.md` route map omits four live routes: `/projects`, `/prefs/theme`,
  `/notifications/read`, `/resources/search` (`app/routes.ts:19-39`). Carried D3.
- `planning/README.md:21-24` still says completed discovery passes "are not retained here";
  eight are. Carried D11.
- FR33 needs the two retention exemptions (B5a); NFR8 needs the R16-5 note (Q17-2).

**B12 · Small UX debts — S each**
- *Waiting-on hint is hover-only.* `task-side-panels.tsx:462-473` answers F17-2 with a
  `title` attribute — invisible to touch and keyboard users, and the product's own rule is
  that explanations are rendered copy in place, never a `title`. Render it.
- *UXO-3:* the board header counts every task while off-screen columns hide them — a
  momentary "where's my task?" at narrow widths (`LIVE-VERIFY-SESSION.md` UXO-3).
- *F18-1b:* the reconciler could stamp a superseded closed-PR packet immediately instead of
  leaving it for the next operator tick (~50 s of contradictory cards).
- *Run-log tail is reload-only* on disconnect (`use-run-log-stream.ts:453-466`) while the
  topbar's SSE banner offers a retry — give the log tail the same affordance.
- *UXO-1 (archived pills)* — a fix is **already uncommitted in the working tree**
  (`app/features/task-detail/task-main-sections.tsx`, drops readiness/validation pills on an
  archived task). Land or revert it deliberately; don't let it rot.

### P3 — Phase 2 (PRD `:190`, correctly absent today)

Verified absent, not drifted: throughput / governance-load **analytics** (no `throughput`
or `analytics` symbol in `app/`), **task-graph + subtasks** (no `subtask`/`parentTask`/
`dependsOn` anywhere), deeper validation workflows, richer agent-profile templates (the
"Add from library" copy path exists, `agents-page.tsx:421`), collaboration ergonomics,
audit export (B5c). Build these when the operating model is proven, per the PRD's own
staging — not because an audit found them missing.

---

## 6. Deliberately rejected — DO NOT build

These were removed or refused by the owner. Re-adding one is a regression, not a fix.
Source: `design/CONVERSATION-SUMMARY.md` unless noted.

**Copy and vocabulary**
- **"govern / governor / governance" in rendered UI copy** — banned; say *Maintainer*,
  *Permissions*, "managed". Now machine-enforced: `app/features/copy-ban.test.ts` (passes).
  Agent system prompts under `app/server/` are deliberately out of scope.
- No "in-app" phrasing for notifications; **no email notifications at all** (ruling 13
  narrowed the prefs to one `app` toggle per category — verified: no email toggle in
  `profile-page.tsx`).
- No SDK/exec mentions ("claude exec" / "codex exec"); no subtexts on agent cards.

**Surfaces that were built and then removed**
- **Sessions & security** panel (profile). **Quality-gate** panel (settings). **Notification
  routing** side-panel. Policy-page intro/explainer copy, the RBAC legend footnote, agent
  guardrail extras, the "durable across restarts" subtext, the "enforced per action" pill.
- **No persistent live/SSE indicator** in the topbar — only the honest degraded
  "live updates paused — retry" (`topbar.tsx:156-165`). Verified still true.
- **No "Secrets · Isolated" row** in the task Permissions panel. Verified absent.

**Interaction decisions**
- Comments address via **@ mentions only** — no Team/Specialist addressee toggle, no
  separate hint line under the composer (the placeholder carries it).
- No **Duplicate** button on agent profiles; no **AGENTS.md preview/generator** in the
  profile modal; no field-explainer notes.
- No colored card accents, colored inset left edges, or hover lift/pop-shadow on board
  cards — neutral shadow always, hover is a subtle tint.
- Popups/overlays are preferred over pages for profile, notifications, connection editing
  and resource creation.

**Model and scope decisions (rulings)**
- **Never simulate** (R7-2) — an unavailable backend produces an honest error and a typed
  blocked packet, never a fake run, verdict or evidence, in product or seed.
- **Task-level repo override** — struck (FR7); the toggle and its copy were deleted.
- **The "Lightweight · 3 stages" preset** — deleted (ruling 15); Standard 5-stage only.
- **The sub-768px review-first mode** — retired, not deferred (PRD `:161`). Same surface,
  reflowed; every action renders at every width.
- **Do NOT move Codex to workspace-write** (R-C, pass 11) — injection guardrails stay
  prompt-level on both backends.
- **Do NOT force-reset the remote task branch at execution start** (R18-4) — the
  branch-collision packet plus a human resolve is an intentional safety checkpoint.
- **MCP grants stay outside the capability matrix** (ruling 39 / R16-5) — granting a server
  *is* the grant; do not add per-tool gating to pretend otherwise. Pinned by a test that
  asserts the *absence* of an `mcp__*` deny rule.
- **`merge-pull-request` stays ALWAYS_HUMAN** (ruling 40 / R16-6) — do not let a
  full-autonomy operator merge. "Done" legitimately means two things.
- **PAT-only GitHub auth**, scopes checked at connect/update time only; **whitelist** model
  for OAuth users (no invites).
- `tweaks-panel.jsx` is not ported (ruling 8). `data-screen-label` stays app-wide
  (ruling 16) — 37 occurrences, one test consumer; **keep it, stop re-filing it** (D20).

---

## 7. Open questions for the owner

Ordered by what it costs to leave them open.

**QN-1 — Does a drag into Done get a confirmation dialog?** *(new, blocks B1)*
Ruling R6-4 (pass 6) established "drag = acceptance", and the board's toast honestly says
"Accepted …". Ruling 20 / R15-1 (pass 15) then said **every** acceptance passes through a
dialog naming what merges and any missing signal. Both are in force; on the board they
disagree, and the board wins today — one drag performs a real merge with no dialog. Either
(a) all three paths route through `accept-confirm.tsx` (recommended: the gates already
compute everything the dialog needs), or (b) R15-1's clause is narrowed in writing to "the
task-detail acceptance controls", which makes the board a deliberate express lane.

**QN-2 — Is project creation admin-only?** *(new)*
FR5 says "Admin users can create and configure governed delivery projects." Configuration
is admin-gated; creation is deliberately self-serve for any signed-in user
(`app/routes/_index.tsx:174` states the choice explicitly, and the creator becomes that
project's admin). For a small self-hosted team this is probably the better product — but
the PRD says otherwise, and an audit re-derives this as drift every pass. Amend FR5, or add
the gate.

**QN-3 — F18-9 could not be reproduced in code; what did you see?** *(record correction)*
FINDINGS records F18-9 as "the new agent-profile modal pre-selects ALL org skills ON".
Both creation modals initialize a **new** profile with empty grants and say so in a
comment: `create-profile-modal.tsx:806-812` (`{ skills: [], mcps: [], kb: [] }`, "A NEW
profile starts with NOTHING pre-selected") and `agent-template-modal.tsx:123-131`
(`initial ? match(...) : []`). Chips render `on` only when selected (`:311-318`). The
observation likely came from an **edit** of a seeded profile or from "Add from library"
(which copies the source profile's grants — correct behavior). Either the finding is
withdrawn, or it needs a live repro naming the exact surface before anyone changes a
default.

**QN-4 — NFR8 vs the MCP carve-out.** *(carried Q17-2)*
Ruling 39 is settled behavior; the PRD still reads as though every agent action is
capability-bounded, and an org MCP server with write powers is reachable by an agent whose
`execute-code-or-write-repo` is deliberately withheld. Cheapest close: an NFR8 amendment
note. Separately: should an MCP server carry a `writes: true` flag a project may refuse, or
is the per-profile grant the whole story forever?

**QN-5 — Measure NFR1–NFR4, or replace them with the observed envelope?** *(carried Q17-8)*
Never measured; the board query has no bound and loads archived rows on top of the 200.
Fund B4 and keep the numbers, or amend them to the small-team envelope the product actually
targets — the PRD's own success criteria lean on "feels immediate", not on the numbers.

**QN-6 — NFR14 vs polling.** *(carried Q17-7, sharpened)*
The cadence question stands (5-minute poll vs "10 seconds of detection"), but B2 is the
part that does not need a ruling: two failure classes reach **no** surface on the automated
path. Decide separately whether webhook ingress goes on the roadmap — it needs a public
ingress the single-node reverse-proxy story does not assume.

**QN-7 — Continuity Recovery Panel: build it (B3), or retire it from the spec?**
*(carried Q17-9)* G8 closed the classification third of it this pass. The remaining
question is whether Journey 4 gets its surface or the spec records "the typed warning event
plus the canonical task file IS the recovery affordance".

**QN-8 — When may Viberr drop a PR reference it once wrote?** *(carried Q17-4)*
B6 proposes a mechanical answer (durable marker → demote on mismatch). The alternative is
to declare the collision packet the only path and document hand-repair.

**QN-9 — Is human-attributed merge permanent?** *(carried Q17-3)*
R16-6 made the divergence visible; it did not decide whether it is forever. Keep merge
human-only (and fix ruling 7's stale "acceptance triggers a real async merge" sentence), or
let a project that already granted `completion-for-acceptance: direct` grant an equally
explicit `merge-pull-request: direct`.

---

## 8. Uncertainty — what this analysis could not prove

- **NFR1–NFR4 numbers.** Nothing here measured latency. The states above describe
  *mechanism and bounds*, not observed timings. No claim in §3.7 about those four should be
  read as "fast enough" or "too slow".
- **F18-9** — code contradicts the recorded live observation; see QN-3. Marked unresolved
  rather than closed.
- **The uncommitted UXO-1 fix** in the working tree was read but not tested; it is not part
  of any commit and could disappear.
- **Pass-18 work is unmerged** (PR #140 open). Every citation above is against
  `pass18/product-fixes`; the same audit against `main` would additionally show F18-1…F18-13
  and G1…G8 as open.
- **Live behavior beyond `LIVE-VERIFY-SESSION.md`.** J1/J2 are called DONE partly on that
  session's evidence. Not re-executed here: skill-decoy loading, Claude-side MCP tool-mount
  parity, secondary specialist assignment.
</content>
</invoke>
