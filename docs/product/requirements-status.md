# Requirements status: PRD versus code

> Every functional and non-functional requirement in the canon PRD
> (`planning/planning-artifacts/prd.md`, mirrored byte-for-byte into `design/prd.md` by
> `app/shared/docs/prd-sync.test.ts`), judged against the code on `main` @ `68b5480`
> (2026-09-01). Where the PRD carries a dated amendment, the status is judged against
> the amended text and says "as amended". Vocabulary: IMPLEMENTED · PARTIAL · NOT
> IMPLEMENTED · UNVERIFIABLE. Edit the canon PRD only; the mirror follows.
> Updated 2026-09-02 for ruling 121 (branch `claude/per-user-codex-auth-difdnn`): FR19,
> NFR7, NFR9 and NFR10 re-judged against per-person agent accounts, plus a new drift item
> in §5.

## 1. Summary

| Set | Total | Implemented | Partial | Not implemented |
|---|---|---|---|---|
| Functional (FR1–FR41) | 41 | 39 (12 of them as amended) | 2 (FR6, FR8) | 0 |
| Non-functional (NFR1–NFR18) | 18 | 16 (4 as amended) | 2 (NFR6, NFR9) | 0 |

The two PRD copies are identical today. Every amendment through 2026-08-31 (rulings
102–104) is in both. Rulings 100, 101, 105, 106, 107, 108 and **121** changed behaviour
after the PRD's last note and are not yet reflected in it (§5). *(FR19 joined the amended
set on 2026-09-02 under ruling 121: profiles still execute via Codex/Claude, but on the
credential principal's own account rather than a deployment-wide one.)*

## 2. Functional requirements

| FR | Requirement (as amended) | Status | Where |
|---|---|---|---|
| FR1 | Team members sign in and reach shared workspaces | IMPLEMENTED | `routes/login.tsx`, `server/auth/login.server.ts`, `lib/auth.server.ts` (local credentials always; GitHub/Google OAuth optional, whitelist-based; forced reset for one-time passwords) |
| FR2 | Admins manage membership and roles; permissions enforced by role | IMPLEMENTED | org roles `admin\|member` (`shared/mapping/user.server.ts`); project roles + grant matrix `shared/rbac.ts`; `server/auth/project-authority.server.ts` |
| FR3 | Shared visibility into task state changes | IMPLEMENTED | SSE `routes/resources.events.ts`, `server/events/sse-broker.server.ts`, `features/live-updates/` |
| FR4 | Commenting within visible projects; projects members-only (R15-4) | IMPLEMENTED as amended | `server/auth/require-project.server.ts`; the "non-member comments are labelled" clause is now reachable only for historical events and org-admin override comments |
| FR5 | Project creation self-serve; creator seeded admin | IMPLEMENTED as amended | `routes/_index.tsx`, `features/home/project-create.server.ts` |
| FR6 | Admins define stages, allowed transitions, approval boundaries | **PARTIAL** | Stages and per-transition boundaries are editable (`features/project-settings/settings-actions.server.ts`, `features/policy/policy-actions.server.ts`); transitions are an auto-wired linear chain in stage order (`shared/workflow/transitions.ts`, P13-D-1); no transitions editor, no arbitrary graph |
| FR7 | One repository per project; task override struck | IMPLEMENTED as amended | `schemas/project-file.schema.ts` `repo`; `features/github/github-actions.server.ts` |
| FR8 | Separate human RBAC and agent capability policy per project | **PARTIAL** | Agent policy is per project (`shared/capabilities.ts`, `features/agents/agent-profile-actions.server.ts`); human RBAC is role *assignment* from one fixed matrix, admins cannot redefine what a role may do per project (recorded in decisions.md ruling 2, unannotated in FR8) |
| FR9 | Reusable agent profiles: stages, actions, resources, web reach incl. browser, backend | IMPLEMENTED | `server/org/gagents.server.ts`, `server/files/agent-profile-file.server.ts`, `server/tasks/specialist-browser-mcp.server.ts`, `server/tasks/specialist-mcp.server.ts` |
| FR10 | File-native store, inspectable, reconciles direct edits | IMPLEMENTED | `server/files/file-store-root.server.ts`, `file-watch.service.server.ts`, tolerant schemas, `store-check.server.ts`, `projections/rescan.server.ts` |
| FR11 | Humans create tasks; two human-rooted exceptions (controller, goal advancement) | IMPLEMENTED as amended | `task-actions.createTask`; the operator toolkit has no create tool; `controller-toolkit.create_task` under the asker's RBAC; `goal-actions.server.ts` |
| FR12 | Canonical operating record | IMPLEMENTED | `schemas/task-file.schema.ts`, `server/files/task-file.server.ts`; format in [../architecture/file-formats.md](../architecture/file-formats.md) |
| FR13 | Tasks move through project-defined stages under governed rules | IMPLEMENTED | `task-actions.transitionStage`, `shared/workflow/transitions.ts` |
| FR14 | Uniform `engagements[]`; required reviewers; dispatch writes engagements (ruling 98) | IMPLEMENTED as amended | `engagementSchema`, `deliveringEngagement`, `requiredReviewers`; retired vocabulary pinned by `features/retired-vocabulary.test.tsx` |
| FR15 | Agents flag underspecified tasks and request clarification | IMPLEMENTED | operator triage gate (`operator-run.server.ts`), `ask_human` question packets, `quality` events; `flag-underspecified-tasks` is advisory persona text |
| FR16 | Typed important events + conversation in one chronology | IMPLEMENTED | `TIMELINE_EVENT_TYPES` (11), `features/task-detail/timeline.tsx` |
| FR17 | Validation outcomes, evidence incl. posted files, change summaries, compressed history | IMPLEMENTED | verdicts, evidence rows, attachments (`server/files/task-attachments.server.ts`, `routes/task-attachment.ts`), `timeline-compaction.server.ts`, `comment-guardrails.server.ts` |
| FR18 | Dedicated operator per active task | IMPLEMENTED | `runtimes/operator-run.server.ts` (per-task lease, single-flight) |
| FR19 | Execute profiles via Codex / Claude backends | IMPLEMENTED as amended | `runtimes/runtime-registry.server.ts` (adapters + spawn-env filtering), `claude-runtime.server.ts`, `codex-runtime.server.ts`; since ruling 121 the account a run executes on is the **credential principal's**, resolved by `run-principal.server.ts` and built by `runCredentialFor` (`backend-credentials.server.ts`), never a deployment-wide key |
| FR20 | Operator recommends, triggers work, re-engages supporters | IMPLEMENTED | `RECOMMENDATION_KINDS`, `operator-toolkit.server.ts`, `features/task-detail/operator-recommendations.tsx` |
| FR21 | Specialists execute stage work; append outcomes, blockers, evidence | IMPLEMENTED | `specialist-run.server.ts`, `agent-outcome.server.ts`, `agent-reply.server.ts` |
| FR22 | Threads resume across stages; re-anchor when history is gone | IMPLEMENTED | `run-service.resumeRun`, continuity event, `run-recovery.server.ts` |
| FR23 | Authorized users reach the native runtime session for debugging | IMPLEMENTED (interpretation) | `routes/resources.session-export.ts` (export + resume locally), raw log console; no in-app live attach |
| FR24 | Board by stage; cards show stage, agent, waiting, validation | IMPLEMENTED | `features/board/board-page.tsx`, `projections/board-query.server.ts` |
| FR25 | Task detail prioritizes state, execution profile, latest packet before timeline | IMPLEMENTED | `features/task-detail/task-detail-page.tsx` |
| FR26 | Structured blocking/decision packets | IMPLEMENTED | `taskPacketSchema`, `PACKET_OPTION_KINDS` (11), `task-actions.resolvePacket`, `features/task-detail/decision-packet.tsx` |
| FR27 | Approve/reject/redirect; Done human by default; verdict gate; Force-accept; full-autonomy acceptance = merge pending; "Completed — no changes" | IMPLEMENTED, all amendments | `task-actions` acceptance paths, `operator-actions.operatorAcceptCompletion`, `no-change-completion.server.ts`, `features/task-detail/accept-confirm.tsx`, `shared/acceptance-disclosure.ts` |
| FR28 | Progress review without raw logs | IMPLEMENTED | live phase/step in `features/runtime/runs-panels.tsx`, evidence separation, typed events |
| FR29 | Authenticate to GitHub, access authorized repos | IMPLEMENTED | sealed PATs (`server/secrets/*`), `server/github/github-client.server.ts`, connections; PAT-only, no GitHub App |
| FR30 | Every task executes against its project's repo | IMPLEMENTED | `project-file.schema.ts`, `pr-open.server.ts` |
| FR31 | Task-key branches; delivery is an operator decision; agents never push; review-without-PR announced | IMPLEMENTED as amended | `branch-sync.server.ts`, `pr-open.server.ts`, `task-actions.performDelivery`, `specialist-tool-policy.ts` |
| FR32 | Branch/PR status alongside task state | IMPLEMENTED | `features/github/github-view.tsx`, `github-pills.ts`, 5-min reconcile poller |
| FR33 | Auditable history; 90-day retention; export-before-purge; admin download | IMPLEMENTED | `server/audit/*`, `server/db/retention.server.ts`, `routes/org.settings.audit-export.ts`, S3 push; the pass also runs every 6 h (the PRD says "on every boot") |
| FR34 | Secrets isolated from artifacts, comments, audit | IMPLEMENTED | spawn-env filter, sink and git-output redaction, `GIT_ASKPASS`, audit `details` rule |
| FR35 | Quality issues and policy violations as first-class events | IMPLEMENTED | `projections/policy-violations.server.ts`, `github/scope-flag.server.ts`, `quality`/`policy` events |
| FR36 | Manual re-scan / reconciliation | IMPLEMENTED | Home store strip (org admin), project rescan (admin/maintainer), `npm run rescan` |
| FR37 | One human owner per task governs any open decision | IMPLEMENTED | `ownerUserId`, acceptance and packet authority in `task-actions`, `pr-human-approval.server.ts` |
| FR38 | Contributor+ take/release ownership; admins release any | IMPLEMENTED | `shared/rbac.ts` `own-task`, `release-any-ownership` |
| FR39 | Schedule a future run; server fires; canonical; never on terminal; no pinned backend | IMPLEMENTED as amended | `tasks/schedule.server.ts`, `execution-profile.tsx` |
| FR40 | One instance controller; per-tool live RBAC; no escalation, no deletes; admin-only config | IMPLEMENTED | `server/controller/*`; rulings 100, 106, 107, 108 landed after the PRD note |
| FR41 | Chained goals | IMPLEMENTED | `tasks/goal-actions.server.ts`, `schemas/goal-file.schema.ts`, `features/controller/controller-page.tsx` |

## 3. Non-functional requirements

| NFR | Requirement (as amended) | Status | Where / note |
|---|---|---|---|
| NFR1 | Board usable for the full task set; unbounded, not virtualized | IMPLEMENTED as amended (R19-9) | `board-query.server.ts` has no LIMIT |
| NFR2 | Decision-relevant truth first; depth loads progressively | IMPLEMENTED | `task-detail-page.tsx`, `timeline-slice.ts` |
| NFR3 | Every state-changing action acknowledges itself | IMPLEMENTED | fetcher pending states, `features/toast-honesty.test.ts` source scan |
| NFR4 | Shared updates converge without refresh | IMPLEMENTED | SSE + watcher + 5-min GitHub poller + boot rescan |
| NFR5 | Timeline usable without the full raw history | IMPLEMENTED | `timeline-slice.ts`, run-log paging |
| NFR6 | All traffic encrypted in transit | **PARTIAL** | The app speaks plain HTTP and delegates TLS to the proxy; boot warns on an `http://` production origin (`config/env.server.ts`) |
| NFR7 | No credentials in timelines, comments, audit, logs | IMPLEMENTED | redaction in `run-sink.server.ts` (now per run: `createRunSink(db, spec, { secrets })` carries the principal's own value into `createLineRedactor`), `git-output-redact.server.ts`; `user_backend_credentials.secret_box` is never selected by a reader, so a loader cannot spread it out |
| NFR8 | Separate human/agent boundaries on every action; MCP grants outside the matrix | IMPLEMENTED as amended | `shared/capabilities.ts`, `specialist-tool-policy.ts`, Codex sandbox parity (ruling 101) |
| NFR9 | Least-privilege credentials per project policy and task context | **PARTIAL** (narrower gap since ruling 121) | Per-project PAT, credential-less agents, repo-scoped read tool; and a run now carries exactly ONE person's backend credential (`filteredSpawnEnv()` + `runCredentialFor`), so an agent can no longer reach an instance-wide provider key. Still no per-task narrowing of the PAT beyond repo-path scoping, and "active task context" remains unmodelled (§5) |
| NFR10 | Security-relevant actions audited | IMPLEMENTED | denials, credential events, approvals; the ruling-121 family `profile.backend.connected` / `profile.backend.disconnected` (plus the sign-in driver's `login_started` / `login_failed` / `login_cancelled`) and `credentialUserId` on `runtime.run.started`; pinned by `server/audit/audit-coverage.server.test.ts` |
| NFR11 | Task-state consistency across restarts | IMPLEMENTED | writer lock, boot rescan, `reconcileRestartedWork`, schedule leases, self-heal |
| NFR12 | Continue from canonical state when runtime history is unavailable | IMPLEMENTED | `resumeRun`, `continuity-recovery.tsx` |
| NFR13 | Reconciliation never corrupts canonical state | IMPLEMENTED | the rebuilder contains no file writer; retention never touches markdown |
| NFR14 | GitHub failures surfaced with task context (no time budget) | IMPLEMENTED as amended | scope violations, poller failure notifications, git's own words (ruling 69) |
| NFR15 | Branch/commit/PR uniquely traceable to the task key | IMPLEMENTED | `taskBranchName`, PR body contract, adoption only by delivered head sha |
| NFR16 | Idempotent external actions | IMPLEMENTED | `openTaskPr`, operator lease, already-Done checks, unique open violation, schedule lease |
| NFR17 | Agent-identity continuity on resume, or explicit failure | IMPLEMENTED | session probe, `session_missing`, identity by `profileId` |
| NFR18 | Durable audit trail, bounded per FR33 | IMPLEMENTED (bounded) | `audit_events`, browse, export-before-purge, backup |

## 4. Amendment chronology recorded in the PRD

| Date | Where | Change |
|---|---|---|
| 2026-03-30 | header | authored |
| 2026-06-08 | header | scope simplified |
| 2026-07-04 | FR4, FR14, FR37, FR38 | commenting app-wide; task owner; self-service ownership; owner tracked separately from engagements |
| 2026-07-25 | permission boundaries, FR7, FR11, FR33, FR37, FR39, responsive | Q1 full-autonomy acceptance; task repo override struck; agent task creation struck; 90-day audit bound; owner governs any open decision; FR39 added; review-first mobile retired |
| 2026-07-28 | FR4, FR27, FR31, FR37 | R15-4 members-only; R15-1 verdict gate; R15-2 delivery as decision; R15-3 owner over recommendations |
| 2026-08-04 | FR14, FR20, FR27 | engagement vocabulary; R16-6 "Done" has two meanings |
| 2026-08-06/08 | FR5, FR27, NFR1–5 | self-serve creation; "Completed — no changes"; numeric targets struck (R19-9) |
| 2026-08-14/15 | NFR8, NFR14 | MCP grants outside the matrix; "within 10 seconds" struck |
| 2026-08-19/21 | browser matrix, FR9, FR17, FR38, FR39 | Safari/Firefox never exercised; browser capability; attachments drop; contributor floor; schedules pin no backend |
| 2026-08-29 | FR14, FR39 | ruling 98 dynamic dispatch |
| 2026-08-30 | FR11, FR40, FR41 | ruling 99 controller and chained goals |
| 2026-08-31 | FR33, browser matrix, phase 1 | ruling 102 export-before-purge; ruling 103 Chromium-only; ruling 104 no operator write cap |
| 2026-08-31 | FR17 | ruling 105 browser working-artifact prune + universal attachment card with Download and a text viewer |
| 2026-09-01 | FR40 | rulings 106 controller settings at agent-editor parity, 107 built-in `viberr_ops` diagnostics, 108 controller grants and instructions deployment-locked by default |
| 2026-09-02 | FR19/FR21, FR26, FR40 | rulings 109–116 (pass 32): Codex parity carve-out labeled "advisory on Codex"; the collision ceremony's order and its follow-up; audited `viberr_ops` reads; a Guardrails card under Policy; one capability-mode vocabulary; `accept_completion` refused at authoring off the acceptance boundary; the shared Claude MCP-log cache as a disclosed residual |
| 2026-09-02 | FR19, FR37/FR38, NFR7, NFR9, NFR10 | ruling 121: agent backends authenticate per person, every run carries a credential principal, task creation seats the creator as owner. **Not yet in the canon PRD** (§5 item 12) |

## 5. Drift the PRD does not record

1. **FR8** over-promises: role definitions are one shared constant; only assignment is per
   project.
2. **FR6** "allowed transitions": a linear chain; the owner ruling (P13-D-1) lives only in
   a code comment.
3. **FR33** "runs on every boot": also every 6 h and on disk pressure.
4. **FR23** reads as live attach; the product ships export-and-resume plus a raw console.
5. **NFR6** has no note that the app cannot enforce it.
6. **NFR9** "active task context" is not modelled.
7. **FR4** labelling clause is nearly vacuous after members-only.
8. **Success criteria** percentages are not measured anywhere; `/insights` measures runs,
   cost, tokens and outcomes.
9. **Phase 2 list** outrun by shipped work: analytics (`/insights`), audit exports, a
   linear form of task chaining (goals), recovery tooling (continuity panel, backup CLI,
   maintenance, transcript retention).
10. **FR40/FR41** post-dated rulings 100, 105–108; ruling 108 narrows "only org admins
    modify the controller" to "org admins change model and effort; skills, KBs, MCPs and
    instructions are deployment-locked unless unlocked at deploy time". *(FR17 and FR40
    now carry those amendments in the PRD itself — 2026-09-02, pass 32.)*
11. **Project classification** says "single-page"; the app is server-rendered with
    hydration.
12. **The PRD assumes instance-level agent credentials.** FR19 and the phase text read as
    though a deployment configures Codex/Claude once and every profile executes on it.
    Ruling 121 (2026-09-02) makes that per person: each user connects their own accounts
    on Profile → Agent accounts, every run bills ONE principal (the task owner, or the
    asker on a controller turn), and a task with no owner runs no agents. The canon PRD
    carries no amendment for this yet, so FR19, NFR9 and the "backend configured" phrasing
    behind them are judged against the ruling here.

## 6. README "Known gaps" re-verification

| Gap as stated | Still true? | What changed |
|---|---|---|
| No mailer; one-time passwords handed over by admins | Yes | |
| Org-level audit console missing | **No** | Org settings has an audit browse (newest 150, no filters or paging) plus export |
| Audit expires at 90 days with no export; pass runs on every boot; export is Phase 2 | **Mostly no** | The 90-day window is still a constant, but expiring rows are exported to `audit-exports/*.jsonl` first, admins can download CSV/JSON (100 000-row cap) or push to S3, and the pass runs at boot, every 6 h and on disk pressure |
| `provenance` has no retention | Yes (but it is not the only such table: `session`, `agent_runs`, `goal_projections`, `controller_messages`, `staged_outcomes`, `scope_violations` also have none) | |
| No cleartext-transport guard | Partly | Boot warns when a production origin would issue insecure cookies |
| Notifications page caps at newest 200 | Yes | |
| Fine-grained PAT validation partly assumed | Yes | `pull_request:write` reads "assumed" until first use unless `VIBERR_GITHUB_WRITE_PROBE` opts into the dry-run |

Two real gaps the README did not list: retention windows are compile-time constants, and
the org audit browse has no filtering or paging.

## 7. Method

Each row was traced to a module, not to a citation: 22 FRs and 10 NFRs are cited by
number in non-test source (FR39 with 24 sites and NFR16 with 15 are the most cited), and
absence of a citation was never read as absence of an implementation. Anything that would
require running the app over time (success metrics, propagation latency) is marked
rather than inferred.
