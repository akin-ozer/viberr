# Requirements status: PRD versus code

> Every functional and non-functional requirement in the canon PRD judged against the
> code. Where the PRD carries a dated amendment, the status is judged against the
> amended text and says "as amended". Vocabulary: IMPLEMENTED · PARTIAL · NOT
> IMPLEMENTED · UNVERIFIABLE. Paths are relative to `app/`. Edit the canon PRD only;
> the mirror follows.
> Source of truth: `planning/planning-artifacts/prd.md` (mirrored byte-for-byte into
> `design/prd.md` by `app/shared/docs/prd-sync.test.ts`), [decisions.md](../architecture/decisions.md), `app/`.
> Verified against `main` @ `7d9fbf72` (2026-09-23).

## 1. Summary

| Set | Total | Implemented | Partial | Not implemented |
|---|---|---|---|---|
| Functional (FR1–FR41) | 41 | 39 (10 as amended; FR23 by interpretation; FR19 judged against ruling 127; FR41 judged against ruling 503) | 2 (FR6, FR8) | 0 |
| Non-functional (NFR1–NFR18) | 18 | 16 (3 as amended, 1 bounded) | 2 (NFR6, NFR9) | 0 |

The two PRD copies are identical. The PRD's last amendment is dated 2026-09-01 (ruling
108, on FR40); every ruling after it that changes what a requirement says is listed in
§5 rather than in the PRD. Where such a ruling moves a row, the row is judged against
the ruling and says so.

## 2. Functional requirements

| FR | Requirement (as amended) | Status | Where |
|---|---|---|---|
| FR1 | Team members sign in and reach shared workspaces | IMPLEMENTED | `routes/login.tsx`, `server/auth/login.server.ts`, `lib/auth.server.ts` (local credentials always; GitHub/Google OAuth optional, whitelist-based; forced reset for one-time passwords) |
| FR2 | Admins manage membership and roles; permissions enforced by role | IMPLEMENTED | org roles `admin\|member` (`USER_ROLES`, `shared/mapping/user.server.ts`); project roles + grant matrix `shared/rbac.ts`; `server/auth/project-authority.server.ts` |
| FR3 | Shared visibility into task state changes | IMPLEMENTED | SSE `routes/resources.events.ts`, `server/events/sse-broker.server.ts`, `features/live-updates/` |
| FR4 | Commenting within visible projects; projects members-only (R15-4) | IMPLEMENTED as amended | `routes/project-visibility.server.ts`, `server/auth/require-project.server.ts`; the "non-member comments are labelled" clause is reachable only for historical events and org-admin override comments |
| FR5 | Project creation self-serve; creator seeded admin | IMPLEMENTED as amended | `routes/_index.tsx`, `features/home/project-create.server.ts` |
| FR6 | Admins define stages, allowed transitions, approval boundaries | **PARTIAL** | Stages and per-transition boundaries are editable (`features/project-settings/settings-actions.server.ts`, `features/policy/policy-actions.server.ts`); transitions are an auto-wired linear chain in stage order (`shared/workflow/transitions.ts`, P13-D-1); no transitions editor, no arbitrary graph |
| FR7 | One repository per project; task override struck | IMPLEMENTED as amended | `schemas/project-file.schema.ts` `repo`; `features/github/github-actions.server.ts`; the `change-repo` intent changes which repository the project uses (ruling 539) |
| FR8 | Separate human RBAC and agent capability policy per project | **PARTIAL** | Agent policy is per project (`shared/capabilities.ts`, `features/agents/agent-profile-actions.server.ts`); human RBAC is role *assignment* from one fixed matrix, admins cannot redefine what a role may do per project (recorded in decisions.md ruling 2, unannotated in FR8) |
| FR9 | Reusable agent profiles: stages, actions, resources, web reach incl. browser, backend | IMPLEMENTED | `server/org/gagents.server.ts`, `server/files/agent-profile-file.server.ts`, `server/tasks/specialist-browser-mcp.server.ts`, `server/tasks/specialist-mcp.server.ts` |
| FR10 | File-native store, inspectable, reconciles direct edits | IMPLEMENTED | `server/files/file-store-root.server.ts`, `server/files/file-watch.service.server.ts`, tolerant schemas, `server/files/store-check.server.ts`, `server/projections/rescan.server.ts` |
| FR11 | Humans create tasks; agents do not invent them; human-rooted exceptions | IMPLEMENTED as amended | `createTask` (`server/tasks/task-edits.server.ts`); the operator toolkit has no create tool; the controller's `create_task` under the asker's RBAC; the one-time goal-to-epic conversion, which makes a task for each unstarted link of a running chain on that chain's creator's re-proven authority (`server/tasks/goal-epic-conversion.server.ts`, ruling 503); and a third human-rooted route the PRD does not name: a `create_task` packet option, which creates the task under the RESOLVING person's authority (ruling 269; §5 item 13) |
| FR12 | Canonical operating record | IMPLEMENTED | `schemas/task-file.schema.ts`, `server/files/task-file.server.ts`; format in [../architecture/file-formats.md](../architecture/file-formats.md) |
| FR13 | Tasks move through project-defined stages under governed rules | IMPLEMENTED | `transitionStage` (`server/tasks/task-transitions.server.ts`), `shared/workflow/transitions.ts`; a manual backward move carries a reason (ruling 381) |
| FR14 | Uniform `engagements[]`; required reviewers; dispatch writes engagements (ruling 98) | IMPLEMENTED as amended | `engagementSchema`, `deliveringEngagement`; required reviewers per review stage in `project.md` `requiredReviewers` (ruling 178), holding any delivered work (ruling 385); retired vocabulary pinned by `features/retired-vocabulary.test.tsx` and `features/copy-ban.test.ts` |
| FR15 | Agents flag underspecified tasks and request clarification | IMPLEMENTED | operator triage gate (`server/runtimes/operator-run.server.ts`), `ask_human` question packets, `quality` events; `flag-underspecified-tasks` is advisory persona text |
| FR16 | Typed important events + conversation in one chronology | IMPLEMENTED | `TIMELINE_EVENT_TYPES` (11), `features/task-detail/timeline.tsx` |
| FR17 | Validation outcomes, evidence incl. posted files, change summaries, compressed history | IMPLEMENTED as amended | verdicts, evidence rows, attachments (`server/files/task-attachments.server.ts`, `routes/task-attachment.ts`), `server/tasks/timeline-compaction.server.ts`, `server/tasks/comment-guardrails.server.ts`; people attach files too (ruling 379) and text files open in a code reader (ruling 363) and markdown opens rendered (ruling 614), beyond the PRD's "files an agent posts" (§5 item 14) |
| FR18 | Dedicated operator per active task | IMPLEMENTED | `server/runtimes/operator-run.server.ts` (per-task lease, single-flight) |
| FR19 | Execute profiles via Codex / Claude backends | IMPLEMENTED (judged against ruling 127) | `server/runtimes/runtime-registry.server.ts` (adapters + spawn-env filtering), `server/runtimes/claude-runtime.server.ts`, `server/runtimes/codex-runtime.server.ts`; a run executes on the **credential principal's** own account, resolved by `server/runtimes/run-principal.server.ts` and built by `runCredentialFor` (`server/runtimes/backend-credentials.server.ts`), never a deployment-wide key; every Codex run gets a private `CODEX_HOME` (ruling 181) and runs `danger-full-access` (ruling 185) |
| FR20 | Operator recommends, triggers work, re-engages supporters | IMPLEMENTED | `RECOMMENDATION_KINDS` (4), `server/tasks/operator-toolkit.server.ts`, `features/task-detail/operator-recommendations.tsx` |
| FR21 | Specialists execute stage work; append outcomes, blockers, evidence | IMPLEMENTED | `server/tasks/specialist-run.server.ts`, `server/tasks/agent-outcome.server.ts`, `server/tasks/agent-reply.server.ts` |
| FR22 | Threads resume across stages; re-anchor when history is gone | IMPLEMENTED | `resumeRun` (`server/runtimes/run-service.server.ts`), the `continuity` event, `server/runtimes/run-recovery.server.ts`; a large session is compacted at the end of its run (ruling 376) and one idle past its cache lifetime above 150k starts fresh through the continuity reset (ruling 372) |
| FR23 | Authorized users reach the native runtime session for debugging | IMPLEMENTED (interpretation) | `routes/resources.session-export.ts` (export + resume locally), raw log console; no in-app live attach |
| FR24 | Board by stage; cards show stage, agent, waiting, validation | IMPLEMENTED | `features/board/board-page.tsx`, `server/projections/board-query.server.ts`; the card (ruling 365) shows the stage by its lane, the agent as a badge in its avatar stack, the wait in its one status chip, and validation as a problem chip when failing or bypassed |
| FR25 | Task detail prioritizes state, execution profile, latest packet before timeline | IMPLEMENTED | `features/task-detail/task-detail-page.tsx` (source order head, packet, side column, main; U35-2) |
| FR26 | Structured blocking/decision packets | IMPLEMENTED | `taskPacketSchema`, `PACKET_OPTION_KINDS` (18), `resolvePacket` (`server/tasks/packet-resolution.server.ts`), `features/task-detail/decision-packet.tsx`; Viberr raises some packets itself (`from: policy-engine`, e.g. a review deadlock, ruling 237) |
| FR27 | Approve/reject/redirect; Done human by default; verdict gate; Force-accept; full-autonomy acceptance = merge pending; "Completed — no changes" | IMPLEMENTED, all amendments | acceptance paths in `server/tasks/task-acceptance.server.ts`, `operatorAcceptCompletion` (`server/tasks/operator-actions.server.ts`), `server/tasks/no-change-completion.server.ts`, `features/task-detail/accept-confirm.tsx`, `shared/acceptance-disclosure.ts`; the force dialog lists every gate the record will say it bypassed (ruling 393); `refresh-and-review` updates a behind branch and re-reviews before acceptance (ruling 449) |
| FR28 | Progress review without raw logs | IMPLEMENTED | live phase/step in `features/runtime/runs-panels.tsx`, evidence separation, typed events |
| FR29 | Authenticate to GitHub, access authorized repos | IMPLEMENTED | sealed PATs (`server/secrets/*`), `server/github/github-client.server.ts`, org connections; PAT-only, no GitHub App |
| FR30 | Every task executes against its project's repo | IMPLEMENTED | `schemas/project-file.schema.ts`, `server/github/pr-open.server.ts` |
| FR31 | Task-key branches; delivery is an operator decision; agents never push; review-without-PR announced | IMPLEMENTED as amended | `server/github/branch-sync.server.ts`, `server/github/pr-open.server.ts`, `server/github/push-workspace.server.ts`, `performDelivery` (`server/tasks/task-delivery.server.ts`), `server/tasks/specialist-tool-policy.ts`; also, beyond the PRD: an empty repository is bootstrapped (ruling 128, `server/github/repo-bootstrap.server.ts`), rework reaches the open PR (ruling 134), and per-file leases refuse a delivery on another task's paths (rulings 245, 417; `server/tasks/file-leases.server.ts`) |
| FR32 | Branch/PR status alongside task state | IMPLEMENTED | `features/github/github-view.tsx`, `features/github/github-pills.ts`, the 5-minute reconcile poller (`server/github/reconcile-poller.server.ts`) |
| FR33 | Auditable history; 90-day retention; export-before-purge; admin download | IMPLEMENTED | `server/audit/*`, `server/db/retention.server.ts`, `routes/org.settings.audit-export.ts`, S3 push; the pass also runs every 6 h and on disk pressure (the PRD says "on every boot") |
| FR34 | Secrets isolated from artifacts, comments, audit | IMPLEMENTED | spawn-env filter, sink and git-output redaction, `GIT_ASKPASS`, audit `details` rule |
| FR35 | Quality issues and policy violations as first-class events | IMPLEMENTED | `server/projections/policy-violations.server.ts`, `server/github/scope-flag.server.ts`, `quality`/`policy` events; an advisory scope is a `note`, not a violation (ruling 380) |
| FR36 | Manual re-scan / reconciliation | IMPLEMENTED | Home store strip (org admin), project rescan (admin/maintainer), `npm run rescan` |
| FR37 | One human owner per task governs any open decision | IMPLEMENTED | `ownerUserId`, acceptance and packet authority in `server/tasks/task-action-core.server.ts` (`ownerException`), `server/tasks/task-acceptance.server.ts` and `server/tasks/packet-resolution.server.ts`, `server/github/pr-human-approval.server.ts` |
| FR38 | Contributor+ take/release ownership; admins release any | IMPLEMENTED | `shared/rbac.ts` `own-task`, `release-any-ownership` |
| FR39 | Schedule a future run; server fires; canonical; never on terminal; no pinned backend | IMPLEMENTED as amended | `server/tasks/schedule.server.ts`, `features/task-detail/execution-profile.tsx`; a task resting on a schedule reads `waiting: schedule` (ruling 225) |
| FR40 | One instance controller; per-tool live RBAC; no escalation, no deletes; admin-only config, deployment-locked resources | IMPLEMENTED as amended | `server/controller/*`; beyond the PRD: the dock on every surface with instance, board and task scopes and a per-turn context read (ruling 121), a grant request an admin sees (ruling 390), unseen-reply marks (ruling 448) |
| FR41 | Chained goals | IMPLEMENTED (judged against ruling 503, §5 item 15) | `schemas/epic-file.schema.ts`, `server/tasks/epic-actions.server.ts`, `server/projections/epic-query.server.ts`, `features/epics/`; the chains became epics that tasks join and leave one at a time, and the order a chain gave its links is each task's own `blockedBy` (ruling 131) |

## 3. Non-functional requirements

| NFR | Requirement (as amended) | Status | Where / note |
|---|---|---|---|
| NFR1 | Board usable for the full task set; unbounded, not virtualized | IMPLEMENTED as amended (R19-9) | `server/projections/board-query.server.ts` has no LIMIT |
| NFR2 | Decision-relevant truth first; depth loads progressively | IMPLEMENTED | `features/task-detail/task-detail-page.tsx`, `features/task-detail/timeline-slice.ts` |
| NFR3 | Every state-changing action acknowledges itself | IMPLEMENTED | fetcher pending states, `features/toast-honesty.test.ts` source scan |
| NFR4 | Shared updates converge without refresh | IMPLEMENTED | SSE + watcher + 5-min GitHub poller + boot rescan; a hidden tab closes its streams and, on return, the broker replays what it missed (ruling 301; ruling 457) |
| NFR5 | Timeline usable without the full raw history | IMPLEMENTED | `features/task-detail/timeline-slice.ts`, run-log paging (`routes/resources.run-log.ts`) |
| NFR6 | All traffic encrypted in transit | **PARTIAL** | The app speaks plain HTTP and delegates TLS to the proxy; boot warns on an `http://` production origin (`server/config/env.server.ts`) |
| NFR7 | No credentials in timelines, comments, audit, logs | IMPLEMENTED | redaction in `server/runtimes/run-sink.server.ts` (per run: `createRunSink(db, spec, { secrets })` carries the principal's own value into `createLineRedactor`), `server/secrets/git-output-redact.server.ts`; `user_backend_credentials.secret_box` is never selected by a reader, so a loader cannot spread it out |
| NFR8 | Separate human/agent boundaries on every action; MCP grants outside the matrix | IMPLEMENTED as amended | `shared/capabilities.ts` (`capabilityEnforcement`: `both`, `claude-only`, `advisory`), `server/tasks/specialist-tool-policy.ts`; admin-marked MCP write tools withheld from read-only runs (ruling 176). Codex runs are not OS-sandboxed (ruling 185), so repo write is advisory on Codex and labelled so |
| NFR9 | Least-privilege credentials per project policy and task context | **PARTIAL** | Per-project PAT, credential-less agents, repo-scoped read tool, and a run carries exactly ONE person's backend credential (`filteredSpawnEnv()` + `runCredentialFor`), so an agent never reaches an instance-wide provider key. No per-task narrowing of the PAT beyond repo-path scoping, and "active task context" is not modelled (§5) |
| NFR10 | Security-relevant actions audited | IMPLEMENTED | denials, credential events, approvals; `profile.backend.*` (connect, disconnect and the sign-in driver's start, failure and cancel) and `credentialUserId` on `runtime.run.started`; pinned by `server/audit/audit-coverage.server.test.ts` |
| NFR11 | Task-state consistency across restarts | IMPLEMENTED | writer lock, boot rescan, `reconcileRestartedWork`, schedule leases, self-heal |
| NFR12 | Continue from canonical state when runtime history is unavailable | IMPLEMENTED | `resumeRun`, `features/task-detail/continuity-recovery.tsx`; a torn Codex rollout starts a fresh session and says why (ruling 434) |
| NFR13 | Reconciliation never corrupts canonical state | IMPLEMENTED | the rebuilder contains no file writer; retention never touches markdown |
| NFR14 | GitHub failures surfaced with task context (no time budget) | IMPLEMENTED as amended | scope violations, poller failure notifications, git's own words (ruling 69); an unreachable GitHub is not reported as a broken credential (ruling 334) |
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
| 2026-09-01 | FR40 | ruling 108: controller grants and instructions deployment-locked by default; org admins change model and effort |

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
   cost, tokens, outcomes and prompt-cache behaviour.
9. **Phase 2 list** outrun by shipped work: analytics (`/insights`), audit exports, task
   grouping (epics, which replaced goal chains) and task dependencies, recovery tooling (continuity panel, backup CLI,
   maintenance, transcript retention).
10. **FR40** records ruling 108 only. Rulings 106 (controller settings at agent-editor
    parity), 107 (the built-in `viberr_ops` diagnostics MCP), 121 (the dock on every
    signed-in surface, conversation scopes, the per-turn context read, `update_task`,
    the recorded surface on user messages), 390 (grant requests) and 448 (unseen replies)
    are not in it.
11. **Project classification** says "single-page"; the app is server-rendered with
    hydration.
12. **The PRD assumes instance-level agent credentials.** FR19 and the phase text read as
    though a deployment configures Codex/Claude once and every profile executes on it.
    Ruling 127 (2026-09-02) makes that per person: each user connects their own accounts
    on Profile → Agent accounts, every run bills ONE principal (the task owner, or the
    asker on a controller turn), and a task with no owner runs no agents. Task creation
    seats the creator as owner (FR37/FR38). FR19, NFR7, NFR9 and NFR10 are judged against
    the ruling here.
13. **FR11 names two human-rooted exceptions; there are three.** A `create_task` packet
    option (ruling 269) creates a task under the authority of the person who resolves the
    packet. The operator still has no create tool.
14. **FR17 says "files an agent posts".** A person holding `attach-file` attaches files
    too (ruling 379), and a file a delivering run saved is delivered work a required
    reviewer must judge (rulings 385, 388).
15. **FR41 describes chained goals, which ruling 503 retired.** The owner replaced them
    with epics (2026-09-26): a named body of work in a project that tasks join and leave
    one at a time, as in Jira and Linear, with a manual status and a progress counted
    from its tasks. Nothing creates a task lazily any more: planned work is created as
    tasks, and what one waits on is its own `blockedBy`, which the release engine honours.
    Every existing chain became the epic with its number at the upgrade. The row is
    judged against the ruling.
16. **FR19/FR21 and NFR8 predate the Codex sandbox removal.** Every Codex run is
    `danger-full-access` and gets a private `CODEX_HOME` (rulings 181, 185); capabilities
    the Codex runtime cannot enforce are labelled advisory there (rulings 109–116 began
    that labelling).
17. **Rulings after the last PRD note that extend requirements without contradicting
    them**, recorded here so the PRD's silence is not read as absence: repository
    bootstrap (128, FR31); classified run failures and the person's own remedy (130,
    FR22); task dependencies with a hold and a release engine (131, FR13/FR27);
    authored-only revision drift (132); rework reaches its own open PR (134, FR31); the
    unpushed-revision acceptance gate (135, FR27); the collision ceremony reads GitHub
    first (136); the `workflow` scope stays optional (144, NFR9); the spending cap per
    Claude run (175); MCP write tools (176, NFR8); required reviewers per project (178,
    FR14); per-file leases (245, 396, 417, 426; FR31); the project rulings knowledge base
    (239, 378, 418; FR9); prompt-cache measurement and end-of-run compaction (369–376,
    FR22); twenty stage colour presets (364, FR6); a manual backward move says why (381,
    FR13); refresh-and-review before acceptance (449, FR27).

## 6. README "Known gaps" re-verification

| Gap as stated in the README | Still true? | Note |
|---|---|---|
| No mailer; one-time passwords handed over by admins | Yes | |
| Org audit browse is minimal: newest 150 org-scoped rows, "no filtering or paging" | **Partly** | No paging, but the browse has a text filter and an "Org-scoped" toggle backed by its own query; the unscoped window shows 150 rows of every scope except the poller heartbeat (ruling 234) |
| Retention windows are compile-time constants (run logs 30 days, audit 90 with export first, notifications 500 per user; boot, every 6 h, disk pressure) | Yes | `RUN_LOG_RETENTION_DAYS`, `AUDIT_RETENTION_DAYS`, `NOTIFICATION_MAX_PER_USER` in `server/db/retention.server.ts` |
| Several tables have no retention (`provenance`, `session`, `agent_runs`, an upgraded root's `goal_projections`, `controller_messages`, `scope_violations`, `model_availability`) | Yes | `staged_outcomes` is not among them: each insert prunes rows past its TTL (`server/tasks/agent-outcome.server.ts`) |
| No cleartext-transport guard in the app itself | Yes | Boot warns when a production origin would issue insecure cookies |
| Notifications page caps at newest 200 | Yes | `NOTIF_PAGE_LIMIT` in `routes/notifications.tsx` |
| Fine-grained PAT validation partly assumed | Yes | `pull_request:write` reads "assumed" until first use unless `VIBERR_GITHUB_WRITE_PROBE` opts into the dry-run |
| Codex runs receive MCP servers without credentials | **No longer** (ruling 461) | A credentialed server is reached through Viberr's loopback MCP gateway on both backends; the credential stays in the server process and the run holds a run-scoped token |

## 7. Method

Each row was traced to a module, not to a citation: 19 FRs and 11 NFRs are cited by
number in non-test source (FR39 and NFR16, with 12 occurrences each, are the most cited),
and absence of a citation was never read as absence of an implementation. Anything that
would require running the app over time (success metrics, propagation latency) is marked
rather than inferred.
