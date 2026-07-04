# Phase 3 report — File store & projections

Status: complete. All gates pass: `npm run typecheck` clean, `npm test`
185/185 (100 phase-1/2 + 85 new), `npm run build` clean. Live-verified:
`npm run seed` populates ./data (3 projects / 10 tasks / 32 events /
10 notifications / 5 agent profiles, 0 diagnostics); `npm run dev` boots
with the watcher active; an external `perl -pi` edit of a seeded task.md
(title+stage) was reprojected within the 250 ms debounce (verified by
sqlite query + watcher log line); `npm run rescan` reports
0 changed / 13 unchanged on a clean tree; server killed after.

New deps: `chokidar@^5.0.0` (verified current; needs Node ≥ 20.19),
`yaml@^2.9.0`. New npm script: `npm run rescan` (`-- --force` bypasses the
hash short-circuit).

## File inventory

```
db/migrations/0003_projections.sql     # projects, project_members, task_projections,
                                       # task_events, diagnostics, provenance, notifications
docs/architecture/file-formats.md      # canonical file-format spec (READ THIS)
scripts/seed.ts                        # real demo seed (replaces placeholder); --reset
scripts/rescan.ts                      # npm run rescan [-- --force]
test-support/test-store.ts             # temp data-root + users + project fixture
app/
  schemas/
    file-diagnostics.ts                # FileDiagnostic + severity ctors (shared)
    task-file.schema.ts                # enums, packet/frontmatter zod, tolerant parsers [test]
    project-file.schema.ts             # project frontmatter zod + tolerant parser
  shared/
    capabilities.ts                    # CAP_CATALOG + ALWAYS_HUMAN_CAPABILITY_IDS (ruling 2)
    workflow/templates.ts              # Governed·5 + Lightweight·3 templates (ruling 15)
    mapping/actor.server.ts            # ActorRender + createActorResolver + initialsOfName
    mapping/project.server.ts          # ProjectRow→ProjectRecord, member mapping
    mapping/task.server.ts             # TaskProjectionRow→TaskSummary, packet/agent/operator render
    mapping/task-event.server.ts       # TaskEventRow→TimelineEventRender
    mapping/notification.server.ts     # NotificationRow→NotificationRecord
  server/
    boot.server.ts                     # + ensureDataRootDirs() + startFileWatcher()
    files/
      file-store-root.server.ts        # data-root bootstrap + path helpers + storeRelativePath
      file-mutex.server.ts             # per-path async mutex (HMR-safe)
      atomic-file.server.ts            # writeFileAtomic (tmp + rename)
      frontmatter.server.ts            # split/parse/serialize frontmatter (yaml)
      actor-ref.server.ts              # actor-ref codec (user:/agent:/operator/system:)
      task-file.server.ts              # task.md parse/serialize (round-trip) [test]
      project-file.server.ts           # project.md parse/serialize
      agent-profile-file.server.ts     # agents/profiles/<id>.md parse/serialize
      task-writer.server.ts            # create/update/append-event/set+clear packet (atomic, locked)
      project-writer.server.ts         # create/update + allocateTaskKey (atomic counter)
      path-debounce.server.ts          # per-key trailing debounce [test]
      file-watch.service.server.ts     # chokidar v5 watcher, 250ms, HMR-safe singleton
    interpretation/
      diagnostics-policy.server.ts     # severity model → readiness floors + copy
      readiness-policy.server.ts       # THE readiness derivation + isAcceptedDisplayState [test]
    events/projection-events.server.ts # in-process emitter (Phase 6 subscribes)
    projections/
      rebuilder.server.ts              # full rescan + single-file incremental [test]
      rescan.server.ts                 # rescanProjections (audited)
      board-query.server.ts            # getBoard/listProjects/listProjectTasks/members
      task-query.server.ts             # getTaskDetail/getTaskSummary/events/diagnostics
      notifications.server.ts          # create/list/markRead/markAllRead/markTaskPacketApprovalRead [test]
    tasks/task-actions.server.ts       # createTask/appendComment/setOwner/releaseOwner/
                                       # transitionStage/resolvePacket [2 test files]
    seed/
      demo-data.server.ts              # verbatim data.js transcription (tasks/packets/timelines/…)
      demo-seed.server.ts              # runDemoSeed (idempotent, --reset) [test]
```

## Canonical file formats (owned by this phase)

Full spec: `docs/architecture/file-formats.md`. Verbatim seeded sample
(`data/projects/viberr-core/tasks/VIB-142/task.md` — abridged only in the
middle of the timeline; the format doc has the full grammar):

````markdown
---
key: VIB-142
title: Attach execution workspace to task runtime
stage: review
readiness: input_required
waiting: human
ownerUserId: u_bGyO9Ri4Nbo_
specialist:
  profileId: developer
  backend: codex
  role: Developer
consultants:
  - profileId: reviewer
    backend: claude
    role: Reviewer
operator:
  assignedAtStageId: triage
urgent: true
validation: changed
branch: vib-142-attach-workspace
repo: null
pr:
  number: 318
  state: review
  title: Attach execution workspace
github:
  commits:
    - sha: a91f7c2
      msg: "[VIB-142] add repo attach policy gate"
    - sha: 4ce0b18
      msg: "[VIB-142] branch reconciler + task projection"
    - sha: 12dd9af
      msg: "[VIB-142] tests for PR sync boundary"
  changed:
    files: 9
    add: 412
    del: 87
createdAt: 2026-07-03T06:00:00.000Z
updatedAt: 2026-07-04T06:58:00.000Z
---

## Goal

Let the operator attach a single GitHub repo to a task, create the task-key branch, and reflect branch + PR state back into the canonical task file without treating GitHub as the source of truth.

## Packet

```yaml
type: input
kind: Completion report
from: operator
title: Accept completion, or send back for one fix?
body: The developer specialist reports the workspace attach flow is implemented and the review PR is open. All requested files changed and validation evidence is attached — but the PAT used in the run is missing `pull_request:write`, so PR status can't auto-sync after merge. Completion still requires explicit human acceptance.
observations:
  - k: Changed
    v: 9 files · +412 / −87
    code: true
  - k: Validation
    v: unit + integration green; 1 snapshot updated
    code: false
  - k: Branch
    v: vib-142-attach-workspace · synced
    code: true
  - k: Flag
    v: PAT scope missing pull_request:write
    code: false
options:
  - kind: accept_completion
    t: Accept completion
    d: Mark task done and merge the review PR. Human-authorized.
    rec: true
    accept: true
  - kind: request_edit
    t: Request one edit
    d: Ask the developer to widen PAT scope before acceptance.
    rec: false
    ev: "**Decision:** request one edit. Developer widens the PAT scope, then the completion report returns for acceptance."
  - kind: block_on_policy
    t: Block on policy
    d: Hold until Elif updates the project credential policy.
    rec: false
```

## Timeline

### 2026-07-04T06:58:00.000Z · comment · user:u_bGyO9Ri4Nbo_ (Arda Kaya)
to: agent

@operator if the PAT scope is the only blocker, let's widen it rather than block the whole task.

### 2026-07-04T06:41:00.000Z · completion · agent:codex/developer
title: Completion report

Implemented repo attach, branch creation, and PR-sync projection. Validation green except one snapshot intentionally updated.

evidence:
- unit/policy_gate_test · +14 · 0
- integration/pr_sync_test · +38 · −4

### 2026-07-04T06:38:00.000Z · policy · system:policy-engine

**Policy violation:** active PAT is missing `pull_request:write`. Auto-sync after merge will fail.

### 2026-07-03T12:12:00.000Z · assign · user:u_bGyO9Ri4Nbo_ (Arda Kaya)

Took task ownership — owner is the human reviewer and acceptance authority for this task.
````

Key format decisions (all in the format doc):

- Timeline entries: `### <UTC ISO> · <type> · <actor-ref>` heading; optional
  `title:` / `to: agent` metadata lines; blank line; RichText body; optional
  `evidence:` block with `- label · add · del` rows. Newest first; round-trip
  parse→write→parse is structurally identical AND byte-stable (tested).
- Actor refs: `user:<id> (Name snapshot)` / `agent:codex/developer` /
  `operator` / `system:policy-engine` — parser + rebuilder resolve to the
  mock render shapes (operator has NO backend; guest flag derived from
  membership at projection time; snapshots survive member removal).
- Packet options carry the stable `kind` enum (ruling 7):
  `accept_completion | request_edit | block_on_policy | hold_runtime_debug | redirect | custom`.
  Mock mapping: VIB-142 accept/request/block → first three; VIB-160
  resume/fresh-specialist → `redirect`, hold → `hold_runtime_debug`.
- `pr` and `github` (commits/changed) live in frontmatter as a mirrored
  GitHub PROJECTION cache (Phase 7's reconciler owns their sync) — this keeps
  the store rebuild-idempotent with no second source of truth in Phase 3.
- project.md carries `nextTaskNumber` (atomic key counter with max-scan
  rescue), 4-role members, workflow boundaries with review→done locked
  human, per-profile agent deployments (`{capabilityId, mode}` + extras
  against `CAP_CATALOG`), non-secret credentialPolicy, guardrails.

## Interfaces for Phase 4/5

All queries/mutations take the better-sqlite3 handle from `getDb()`.
Everything returns camelCase render shapes from `app/shared/mapping/*`.

### Queries (loaders)

```ts
// app/server/projections/board-query.server.ts
listProjects(db): ProjectRecord[]
getProject(db, slug): ProjectRecord | null            // stages, workflow, agentPolicy, guardrails…
listProjectMembers(db, slug): ProjectMemberRecord[]   // { projectSlug, userId, role }
listProjectTasks(db, slug): TaskSummary[]
getBoard(db, slug): BoardData | null
// BoardData = { project, members: (ProjectMemberRecord & {user: ActorRender})[],
//               columns: {stage:{id,name,color}, tasks: TaskSummary[]}[], orphanTasks }

// app/server/projections/task-query.server.ts
getTaskSummary(db, slug, key): TaskSummary | null
getTaskDetail(db, slug, key): TaskDetail | null       // + timeline, diagnostics, stages
listTaskEvents(db, slug, key): TimelineEventRender[]  // newest first
listTaskDiagnostics(db, slug, key): DiagnosticRecord[]

// app/server/projections/notifications.server.ts
listNotifications(db, userId, {limit?}): NotificationRecord[]   // real-timestamp DESC
countUnreadNotifications(db, userId): number
markNotificationsRead(db, userId, ids): number        // idempotent
markAllNotificationsRead(db, userId): number
```

`TaskSummary` (board card): `{ projectSlug, key, title, stage, readiness,
displayReadiness, waiting, urgent, validation, owner: ActorRender|null,
specialist: AgentRender|null, consultants, operator: {name,
assignedAtStageId, sinceStageIndex, sinceLabel}|null, branch, repo, pr,
commits, changed, goal, packet: PacketRender|null, eventCount, commentCount,
diagnosticCount, createdAt, updatedAt, filePath }`.
**Feed `displayReadiness` straight into `ReadinessPill`** — it is the
canonical enum plus the derived `"accepted"` for done-stage tasks (ruling 1;
the rule lives in `isAcceptedDisplayState`, readiness-policy). `filePath` is
the store-relative path to render (ruling 3). `operator.sinceLabel` is the
"stage 2" copy (ruling 16).

### Mutations (actions) — `app/server/tasks/task-actions.server.ts`

All are `async`, enforce project RBAC internally (pass the session user as
`actor: { userId, label }`), follow file write → incremental reproject →
audit → notification fan-out, and are idempotent-safe. `ctx.dataRoot` is
test-only; omit it in routes.

```ts
createTask(db, { projectSlug, title, goal?, stageId?, urgent? }, actor, ctx?)
  → { key, task: TaskSummary, stageName }   // toast: `${key} created in ${stageName} — its task.md is in the store`
appendComment(db, { projectSlug, taskKey, text }, actor, ctx?)
  → { task, toAgent, mentionedUserIds }     // toAgent = /@(agent|operator|codex|claude)\b/i
setOwner(db, { projectSlug, taskKey, targetUserId }, actor, ctx?)  → TaskSummary
  // targetUserId === actor.userId → take/take-over; else hand-off (owner or admin)
releaseOwner(db, { projectSlug, taskKey }, actor, ctx?)            → TaskSummary
  // self-release, or admin releases anyone (audited forced)
transitionStage(db, { projectSlug, taskKey, toStageId }, actor, ctx?) → TaskSummary
  // must match a workflow boundary; auto→any member, approval/human→admin|maintainer
resolvePacket(db, { projectSlug, taskKey, optionIndex }, actor, ctx?)
  → { task, option }                        // dispatches on option.kind; accept_completion
                                            // is admin|maintainer; 409 when already resolved
```

Errors are `AppError` (403 forbidden / 400 validation / 404 / 409 conflict) —
catch with `toErrorResponse` or map to form errors. Exact typed-event copy
from the specs is written by these functions (ownership §5.2 strings,
packet-resolve §5.3 strings, completion-accepted copy).

Rescan (board Re-scan button): `rescanProjections(db, { actor })` from
`app/server/projections/rescan.server.ts` → `RescanSummary`.

## Event-emitter contract (Phase 6)

`app/server/events/projection-events.server.ts`:

```ts
onProjectionEvent((e: ProjectionEvent) => void): () => void   // returns unsubscribe
emitProjectionEvent(e)
type ProjectionEvent =
  | { type: "task.updated";  projectSlug; taskKey; occurredAt }
  | { type: "task.removed";  projectSlug; taskKey; occurredAt }
  | { type: "project.updated"; projectSlug; occurredAt }
  | { type: "project.removed"; projectSlug; occurredAt }
  | { type: "projection.rebuilt"; scope: "full"|"file"; occurredAt; changed }
  | { type: "notification.created"; userId; occurredAt }
```

Every rebuild path (watcher, mutations, rescan, seed) emits through this
singleton (global-symbol cached, HMR-safe). Payloads are compact facts —
translate 1:1 into SSE events.

## Seed

`npm run seed` (idempotent; `npm run seed -- --reset` wipes
`projects/`, `agents/profiles/` and all derived tables first).

Credentials (all compliant with the min-8 policy):

| user | email | org role | project role (viberr-core) | password |
|---|---|---|---|---|
| Arda Kaya | arda@viberr.dev | admin | admin | `viberr-dev-2828` (VIBERR_SEED_ADMIN_PASSWORD when set) |
| Elif Demir | elif@viberr.dev | member | admin | `viberr-dev-2828` |
| Murat Yıldız | murat@viberr.dev | member | maintainer | `viberr-dev-2828` |
| Selin Aksoy | selin@viberr.dev | member | reviewer | `viberr-dev-2828` |
| Deniz Şahin | deniz@viberr.dev | member | — (guest) | `viberr-dev-2828` |

Existing users (e.g. the phase-2 boot-seeded admin) keep their password;
only display fields (name/tone/org role) are aligned.

Content: viberr-core (5 mock stages, workflow, agent deployments,
credential policy, guardrails) + stub projects deploy-pipeline (DEP,
governed template) and billing-service (BIL, Lightweight·3 template) per
ruling 9; all 10 mock tasks (VIB-139…VIB-168) with full timelines
back-dated to local wall-clock times matching the mock display strings
(ruling 4: today 9:41 → today 09:41 local, "Yesterday", "Mar 30" of the
current year); packets with stable option kinds; Arda's 10-row notification
inbox (unread flags per mock; sorted by real timestamp DESC — deliberately
NOT the mock's splice order); 5 org agent profile templates as files.
Runtime NDJSON logs are NOT seeded (Phase 8 extends the seed).

## Decisions / deviations

1. **Migration number**: BUILD-PLAN said "migration 0002" for projections;
   0002 was taken by auth — it is `0003_projections.sql` (per orchestrator
   brief).
2. **Mutations live in `app/server/tasks/`** — not in the CONVENTIONS
   server-dir list; they orchestrate files+projections+audit+notifications
   and fit none of the existing dirs (mirrors the auth/user-admin pattern:
   route-level auth, function-level RBAC + audit actor).
3. **`pr`/`github` cache in task frontmatter** (see format doc): contracts
   call them "GitHub projections, not frontmatter truth"; keeping the cache
   in the file keeps rescans idempotent without a Phase-3 GitHub table.
   Phase 7's reconciler becomes the writer of those fields.
4. **Readiness of done tasks**: mock stores `readiness:"done"`; files store
   `ready` and the accepted pill derives from the stage (ruling 1).
   `isAcceptedDisplayState` = task sits in the project's LAST stage
   (fallback: literal id `done` when the stage list is unknown).
5. **Org role of Elif is `member`** per the phase brief ("Arda admin,
   others members") — diverges from mock ORG_DEFAULTS where Elif is org
   admin. Her PROJECT role stays admin (mock policy.members).
6. **Unchanged files record no provenance** on rescan (nothing was rebuilt);
   each full rescan records one summary `rescan` row + per-file rows only
   for projected/removed/error. Keeps the table from exploding.
7. **Membership/repo changes in project.md cascade** a forced re-projection
   of that project's tasks (guest flags + effective repo are baked into
   task rows/event snapshots).
8. **Transition event copy** for human-approved moves
   (`**Transition:** moved KEY from X to Y.`) is authored — the mock only
   shows operator-side "Transition request:" events. Documented as new copy.
9. **resolvePacket semantics** follow contracts §1.2 exactly:
   block_on_policy / hold_runtime_debug KEEP the packet (task blocked while
   held); accept/request_edit/redirect clear it. Accept also merges the
   mirrored `pr.state` (real async merge arrives in Phase 7 per ruling 7).
10. **Lightweight·3 template stages** defined as todo/doing/done (mock left
    them undefined), doing→done locked human.
11. **`initialsOf` duplicated**: server-side `initialsOfName` in
    `app/shared/mapping/actor.server.ts` (avatar.tsx is client-only JSX).
    Phase 9 may consolidate into `app/shared/initials.ts`.
12. **Mention resolution** matches email local-part OR first name
    (lowercased) against `@handle`; reserved handles
    (agent/operator/codex/claude) route to the agent instead. Real agent
    registry routing lands with Phase 8.
13. **Watcher scope** is `projects/` only (per plan); agent profile template
    edits need a manual rescan… actually they are not projected at all —
    they are read from files on demand (`agent-profile-file.server.ts`).
14. **Timestamps in seeded events can be near-future** if the seed runs
    before 10:31 local time (mock's latest "today" event) — accepted, demo
    data must render the mock strings (ruling 4).
15. **Re-seed restores mock notification read-state** (INSERT OR REPLACE on
    deterministic mock ids) — documented behavior, not a bug.

## Known gaps (intentional, later phases)

- No SSE yet: Phase 6 subscribes `/resources/events` to the projection
  emitter. No UI surfaces for board/task yet (Phase 4/5).
- Packet RAISING (operator side) is Phase 8; Phase 3 only resolves packets
  and fans out mention notifications. packet/approval/quality/policy
  notification rows come from the seed until the operator runtime exists.
- Accept-completion flips only the mirrored `pr.state`; the real
  (async, failable) GitHub merge is Phase 7.
- Capability enforcement on AGENT-triggered actions (direct/recommend/human
  modes, blockedact events) is Phase 8/10; the invariant list + policy
  storage are in place.
- Attachments dirs, runtime NDJSON, `.viberr`-style KB browsing — later
  phases. `member@viberr.dev` in the dev DB is leftover phase-2 manual test
  data (not seed-created; harmless).
