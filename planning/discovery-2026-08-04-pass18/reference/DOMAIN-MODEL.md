# DOMAIN-MODEL — Viberr current state (pass 18)

Re-derived from the tree at `pass18/product-fixes`. The two canonical file
formats — `task.md` and `project.md` — are defined by Zod schemas in
`app/schemas/`. Files are the source of truth; SQLite `*_projections` tables are
a rebuildable read-model (see ARCHITECTURE.md). All line anchors are current.

Companion parsers: `app/server/files/task-file.server.ts` (assembles
`ParsedTaskFile`), `app/server/files/project-file.server.ts`. Serializer round-
trips unknown keys verbatim (tolerance contract, below).

---

## 1. Tolerance contract (both schemas)

`app/schemas/task-file.schema.ts:9-21`, `project-file.schema.ts:8-14`. The parser
NEVER throws and NEVER drops a whole file:

- Unknown frontmatter fields are **preserved verbatim** and re-emitted on write
  (`unknown` bag, `parseTaskFrontmatter` returns it at `task-file.schema.ts:1088-1097`).
- Missing/invalid fields produce a structured `FileDiagnostic` + a safe fallback
  (`tolerant()` helper, `task-file.schema.ts:734-766`).
- **Per-entry** list parsing (`tolerantArray`, `project-file.schema.ts:267-313`):
  one bad `members[]`/`stages[]`/`agents[]` row drops only itself, never the
  whole list — a governance-integrity fix (a single malformed member row used to
  wipe every member's role).

---

## 2. task-file schema (`app/schemas/task-file.schema.ts`)

`taskFrontmatterSchema` at **:468-518**; key list `TASK_FRONTMATTER_KEYS` at
**:694-719**. Full parsed file `ParsedTaskFile` at **:1254-1263** (frontmatter +
unknownFrontmatter + goal + packet + timeline[] + extraSections[]).

### 2.1 Enums

| Enum | Values | Anchor |
| --- | --- | --- |
| `Readiness` | `ready`, `input_required`, `inconsistency_risk_detected`, `blocked` | :25-31 |
| `Waiting` | `human`, `agent`, `none` | :33-34 |
| `Validation` (derived) | `healthy`, `changed`, `failing`, `none` | :36-37 |
| Timeline event types (10) | comment, completion, github, policy, note, quality, transition, blocked, agent, assign | :47-58 |
| `PacketOptionKind` | accept_completion, request_edit, block_on_policy, hold_runtime_debug, redirect, retry_other_backend, edit_goal, archive_task, custom | :62-83 |
| `RecommendationKind` | assign_specialist, assign_reviewer, transition, run_specialist, run_reviewer, accept_completion, delivery | :149-170 |
| `PrState` | review, merged, closed, accepted | :243 |
| `PrReviewState` | approved, changes_requested, review_required | :260-265 |
| `PrMergeable` | clean, conflicting, unknown | :285 |

Readiness is the canonical 4-value enum ONLY; "accepted" is a *derived display*
state, never stored (:19-21).

### 2.2 Engagements (the G1 generic-agents model) — `engagementSchema` :107-122

The single uniform list that replaced the old `specialist` + `reviewers[]` slots.
Every engaged agent (deliverer AND reviewers) is one `Engagement` row:

- `profileId` — the join key (identity is the **profile id**, never the role
  string; :87-97, :1146-1158).
- `backend` (`codex`|`claude`), `role` (display snapshot at engage time).
- `delivers: boolean` — **exactly one** engagement may be `true`: the
  workspace/branch/PR owner (single-writer invariant). The parser demotes extras
  (`parseEngagements` :841-856).
- `verdictCapable: boolean` — file-local snapshot at engage time of whether this
  engagement held an explicit `report-validation-verdict: direct` grant. A
  supporting engagement that does is a **required reviewer** whose approval of
  the current revision gates acceptance (:114-119).

Helpers: `deliveringEngagement(fm)` → the one `delivers:true` or null (:124-129);
`supportingEngagements(fm)` (:132-136); `requiredReviewers(fm)` = non-delivering
+ verdictCapable (:533-535).

Legacy absorption: a pre-engagements task.md's `specialist`/`reviewers`/
`consultants` keys are folded into `engagements` and NOT preserved as unknown
(`parseEngagements` :779-858; the exclusion at :1093).

### 2.3 Work revision + verdicts (F10-15 revision-bound review)

- `workRevisionSchema` :432-445 — the immutable identity of the delivered work up
  for review: `id`, full `headSha`, `treeSha` (content identity), `branch`,
  `createdAt`, `sourceProfileId` (the delivering engagement's profileId that
  produced it).
- `reviewVerdictSchema` :450-463 — one reviewer's verdict bound to the
  `revisionId` it judged (result ∈ `approve`|`request_changes`). A verdict on an
  OLD revision is automatically stale.
- `nextWorkRevision(current, input)` :664-692 — a head with the same tree (or same
  head when tree unavailable) is the SAME review subject → no new revision, prior
  verdicts survive. A different tree mints a new id → every prior verdict goes
  stale automatically (the whole of new-commit invalidation).

Derivation helpers (pure, testable):

- `currentVerdicts(fm)` :538-545 — verdicts bound to the current revision.
- `deriveValidation(fm)` :551-569 — recomputes the `validation` cache: `failing`
  if any required reviewer requests changes; `healthy` when every required
  reviewer approved; `changed` while pending/none-required; `none` before a
  revision exists.
- `acceptanceBlockedReason(fm)` :575-593 — the verdict gate as reason-or-null.
- Three more acceptance gates, each reason-or-null, one guard many call sites:
  `closedPrBlockedReason` :611-617 (PR closed unmerged = out-of-band rejection),
  `conflictingPrBlockedReason` :632-640 (a conflicting PR can't be merged),
  `archivedTaskBlockedReason` :651-657 (restore before accepting).

### 2.4 PR / branch model — `prRefSchema` :300-336

`pr` is the reconciler's cache of GitHub state (not human truth): `number`,
`state` (PrState, tolerant `.catch("review")`), `title`, and OPTIONAL keys where
an absent key means "never read" (distinct from a known-false): `checks`
(`prChecksSchema` :290-298), `review` (PrReviewState), `mergeable` (PrMergeable),
and `revisionDrift {aheadBy, headSha}` (**R17-1**: the PR head is strictly ahead
of the reviewed revision — extra commits ship unreviewed; surfaced at accept,
:320-333). `branch` is a top-level string (:497). `github` (`githubCacheSchema`
:340-360) caches commits + change stats + `unownedPr` (a collision PR on the
branch, recorded once).

### 2.5 Packets vs recommendations vs schedules vs noChanges

- **Packet** (`taskPacketSchema` :394-420) — the ONE pending decision. `type`
  input|blocked, `kind` label, `observations[]`, `options[]` (each a
  `PacketOptionKind` — dispatch on `kind`, never the English title). `id` for
  replacement-safety (:396-400), `awaiting: goal_edit` (an `edit_goal` option was
  confirmed — clears when the edited goal lands), `askedBy` (**R15-14**: the
  profileId of the agent that raised the question — resolving resumes that
  agent's own session, :413-417).
- **Recommendations** (`recommendationSchema` :172-186) — a supervised operator
  RECOMMENDS an action; each renders as a one-click card. A task can hold several
  at once (distinct from the single packet). `delivery` (R15-2) and
  `accept_completion` are the governance-heavy kinds.
- **Schedules** (`scheduleSchema` :210-236) — a governed future operator re-run
  (O-3). Lifecycle `pending → claimed → fired | failed | cancelled`
  (:202-208). `claimedAt` reserves an occurrence before the detached enqueue so a
  crash is recoverable; `retries` bounds it. Never fires on a terminal (Done)
  task. Server-side runner → backend-agnostic.
- **noChanges** (:504-511, optional) — **R17-2**: the last delivery confirmed the
  branch has no commits ahead of the default branch (goal already satisfied). The
  one signal that turns the "deliver the branch first" acceptance refusal into a
  first-class "Completed — no changes" close-to-Done. Cleared the moment a
  delivery opens a real PR (task-actions.server.ts:3516-3521).

### 2.6 Other frontmatter fields

`key` (regex `^[A-Za-z]+-\d+$`), `title`, `stage` (an unresolvable stage →
blank marker + `unresolved_stage` warning; the card lands in the board's orphan
bucket, NOT a hardcoded `triage`, :917-943), `ownerUserId`, `operator`
(`operatorRefSchema` :140-143, stores `assignedAtStageId`), `urgent`, `archived`
(**R14-3** terminal disposition: leaves board default view + review queue, keeps
timeline, restorable, :483-488), `createdAt`/`updatedAt`, `boardRank` (sparse
rank for drag-reorder; null → task-key number, :515-517). Note `repo` is GONE
from the schema (**P13-D-5**, one project one repo) — an existing `repo:` line is
now an unknown key, preserved verbatim, ignored (:498-502, :711-712).

### 2.7 Timeline + actor refs

`TaskFileEvent` :1237-1251 (newest-first): occurredAt, type, `actor`
(`FileActorRef` :1159-1170: human `user:<id>`, agent `agent:<backend>/<profileId>`,
operator, system, or tolerant `unknown` round-tripped verbatim), title, RichText
`text`, `toAgent`, `evidence` (`EvidenceRow[]` — a reference not a dump, ≤8 rows,
`normalizeEvidenceRows` :1214-1234). `EVIDENCE_EMPTY_COLUMN = "—"` (:1204).

---

## 3. project-file schema (`app/schemas/project-file.schema.ts`)

`projectFrontmatterSchema` at **:168-192**; key list at **:194-208**;
`ParsedProjectFile` = frontmatter + unknownFrontmatter + description (:216-221).

- `name`, `slug` (regex `^[a-z0-9][a-z0-9-]*$`), `archived?` (R6-3 read-only),
  `repo` (`owner/name`, nullable — the sole repo, no task override),
  `defaultBranch`, `taskPrefix` (`^[A-Za-z]+$` → `VIB-142`), `nextTaskNumber`
  (atomic per-project counter).
- `stages[]` (`stageSchema` :40-48: id, name, color) — an empty list is a
  `project.no_stages` error (:463-471).
- `workflow[]` (`workflowBoundarySchema` :50-60) — `from`/`to`/`boundary`
  (`Boundary` = auto|approval|human, :28-29)/`by`/`locked`. `review→done` is
  locked `human` in V1.
- `members[]` (`memberSchema` :62-67: userId + `ProjectRole`).
- `agents[]` (`agentDeploymentSchema` :128-142) — per-project deployment of an
  org template: `profileId`, `capabilities[]` (`capabilityGrantSchema` :69-76,
  id + `CapabilityMode`), `extras[]` (bespoke labels with no catalog id), and an
  optional loose `definition` override (`agentDeploymentDefinitionSchema`
  :85-118 — kind/name/role/backends/model/effort/persona/stages/spanAll/
  `autonomy` for operators/`resources{skills,mcps,kb}`). This is the SINGLE
  source for the deployment-definition shape; agents-query re-exports the type.
- `credentialPolicy` (:146-153 — label/masked/requiredScopes; the PAT itself is
  AES-encrypted in SQLite, never in files), `guardrails[]` (:155-164).

### 3.1 Project roles / capability modes

`PROJECT_ROLES` = `admin`, `maintainer`, `contributor`, `viewer` (:23; note
`contributor` was formerly `reviewer` — renamed to drop a misleading label).
`CAPABILITY_MODES` = `direct`, `recommend`, `human`, `off` (:35). These feed
RBAC-GOVERNANCE.md.

---

## 4. Readiness enum + interpretation

The stored `readiness` is one of the 4 canonical values, but the UI reads a
**DERIVED** readiness computed by `app/server/interpretation/readiness-policy.server.ts`
and projected into `task_projections.readiness`, with the raw file value kept in
`stored_readiness` (see the column comments below). Interpretation/freshness/
diagnostics policies live in `app/server/interpretation/` (readiness-policy,
freshness-policy, diagnostics-policy) — detailed in ARCHITECTURE.md §readiness.

---

## 5. How the file maps to projections

Files are canonical; the SQLite `*_projections` tables are derived and
rebuildable per-table. `db/migrations/0001_baseline.sql` defines the schema.

`task_projections` (`0001_baseline.sql:72-124`) is the board/queue/inbox read
model — one row per task, e.g.:

| Column | Source | Note |
| --- | --- | --- |
| `readiness` | DERIVED (readiness-policy) | what the UI reads |
| `stored_readiness` | raw file value | NULL when missing/invalid |
| `validation` | `deriveValidation(fm)` | recomputed on every write |
| `validation_block_reason` | `acceptanceBlockedReason` | NULL when acceptance-ready (projected so the review queue avoids file I/O) |
| `specialist_json` / `reviewers_json` | derived from `engagements[]` | the delivering / supporting split |
| `operator_json`, `branch`, `pr_json`, `github_json` | frontmatter | denormalized |
| `repo` | `project.repo ?? null` | denormalized onto every task (P13-D-5: no override) |
| `recommendation_count` | `recommendations.length` | so notification reconcile needs no file read |
| `schedules_json` | `schedules[]` | the schedule runner queries this for due entries |
| `archived` | frontmatter | so board/queue hide archived without re-reading files |

Sibling projection tables: `task_events`, `diagnostics`, `provenance`,
`notifications`, `project_members`, `projects`, and the run tables
(`agent_runs`, `run_log_lines`). Org-level SQLite tables (`users`, `github_pats`,
`org_knowledge_bases`, `org_mcp_servers`, `org_skills`, better-auth `user`/
`session`/`account`) are NOT projections — they are canonical in SQLite (this is
the data class the F18-5 dual-writer bug silently ate; see ARCHITECTURE.md).

Rebuild entry points: `reprojectTask(db, ctx, slug, key)`
(`app/server/tasks/task-actions.server.ts:394`), `rebuildPath` / `rebuildAll`
(`app/server/projections/rebuilder.server.ts:584`, `:707`), driven on every file
change by the chokidar watcher (ARCHITECTURE.md).

---

## 6. Pass-18 delta vs pass-17

The task/project schemas themselves are **unchanged** since pass 17 — no new
frontmatter field was added. Pass-18 fixes consumed existing fields:
`deliveringEngagement(fm)` now drives reviewer-KB inheritance (R18-1,
AGENTS-RUNTIME.md), and the `delivered` operator trigger keys off `pr.state`
transitions in `performDelivery` (R18-2). `noChanges`, `revisionDrift`, and the
verdict/acceptance-gate helpers behave exactly as pass 17 documented — verified
against the tree above.
