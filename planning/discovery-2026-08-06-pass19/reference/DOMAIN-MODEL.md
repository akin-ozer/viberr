# DOMAIN-MODEL — Viberr current state (pass 19)

> Verified against main @65063b8 on 2026-08-06 (pass 19).

Re-derived from the tree at `main @65063b8`. The two canonical file
formats — `task.md` and `project.md` — are defined by Zod schemas in
`app/schemas/`. Files are the source of truth; SQLite `*_projections` tables are
a rebuildable read-model (see ARCHITECTURE.md).

**Anchor correction (pass 19)**: every `task-file.schema.ts` anchor in the pass-18
copy of this doc was **6 lines low** — the file has not changed since pass 18, so
the pass-18 numbers were simply stale. All anchors below were re-read from the
current file. `project-file.schema.ts` anchors were correct and are unchanged.

Companion parsers: `app/server/files/task-file.server.ts` (assembles
`ParsedTaskFile`), `app/server/files/project-file.server.ts`. Serializer round-
trips unknown keys verbatim (tolerance contract, below).

---

## 1. Tolerance contract (both schemas)

`app/schemas/task-file.schema.ts:9-21`, `project-file.schema.ts:8-14`. The parser
NEVER throws and NEVER drops a whole file:

- Unknown frontmatter fields are **preserved verbatim** and re-emitted on write
  (`unknown` bag, built in `parseTaskFrontmatter` (:870) at
  `task-file.schema.ts:1094-1103`).
- Missing/invalid fields produce a structured `FileDiagnostic` + a safe fallback
  (`tolerant()` helper, `task-file.schema.ts:740`).
- **Per-entry** list parsing (`tolerantArray`, `project-file.schema.ts:267-313`):
  one bad `members[]`/`stages[]`/`agents[]` row drops only itself, never the
  whole list — a governance-integrity fix (a single malformed member row used to
  wipe every member's role).

---

## 2. task-file schema (`app/schemas/task-file.schema.ts`)

`taskFrontmatterSchema` at **:474-524**; key list `TASK_FRONTMATTER_KEYS` at
**:700-725**. Full parsed file `ParsedTaskFile` at **:1260-1269** (frontmatter +
unknownFrontmatter + goal + packet + timeline[] + extraSections[]).

### 2.1 Enums

| Enum | Values | Anchor |
| --- | --- | --- |
| `Readiness` | `ready`, `input_required`, `inconsistency_risk_detected`, `blocked` | :25-31 |
| `Waiting` | `human`, `agent`, `none` | :33-34 |
| `Validation` (derived) | `healthy`, `changed`, `failing`, `none` | :36-37 |
| Timeline event types (**11**) | comment, completion, github, policy, note, quality, transition, blocked, agent, assign, **continuity** | :47-64 |
| `PacketOptionKind` (**9**) | accept_completion, request_edit, block_on_policy, hold_runtime_debug, redirect, retry_other_backend, edit_goal, archive_task, custom | :68-89 |
| `RecommendationKind` | assign_specialist, assign_reviewer, transition, run_specialist, run_reviewer, accept_completion, delivery | :155-176 |
| `PrState` | review, merged, closed, accepted | :249 |
| `PrReviewState` | approved, changes_requested, review_required | :266-271 |
| `PrMergeable` | clean, conflicting, unknown | :291 |

Readiness is the canonical 4-value enum ONLY; "accepted" is a *derived display*
state, never stored (:19-21).

`continuity` (G8, :59-63) is a **warning-toned** typed event for a runtime
continuity reset (a resumed session's provider transcript was gone, so the agent
re-anchored on `task.md` in a fresh session) — deliberately not a neutral `note`
and not `policy`/`blocked`.

The packet-kind count is **nine**, not eight: `archive_task` (R14-3) is easy to
miss and a pass-18 owner-ruling doc still said eight (corrected in `220103b`).

### 2.2 Engagements (the G1 generic-agents model) — `engagementSchema` :113-128

The single uniform list that replaced the old `specialist` + `reviewers[]` slots.
Every engaged agent (deliverer AND reviewers) is one `Engagement` row:

- `profileId` — the join key (identity is the **profile id**, never the role
  string; :93-103, :1152-1164).
- `backend` (`codex`|`claude`), `role` (display snapshot at engage time).
- `delivers: boolean` — **exactly one** engagement may be `true`: the
  workspace/branch/PR owner (single-writer invariant). The parser demotes extras
  (`parseEngagements` :847-862).
- `verdictCapable: boolean` — file-local snapshot at engage time of whether this
  engagement held an explicit `report-validation-verdict: direct` grant (:125). A
  supporting engagement that does is a **required reviewer** whose approval of
  the current revision gates acceptance.

Helpers: `deliveringEngagement(fm)` → the one `delivers:true` or null (:131-136);
`supportingEngagements(fm)` (:138-142); `requiredReviewers(fm)` = non-delivering
+ verdictCapable (:539-541).

`deliveringEngagement` also drives **R18-1 reviewer-KB inheritance** at run time
(`specialist-run.server.ts:270`, AGENTS-RUNTIME.md §3.1).

Legacy absorption: a pre-engagements task.md's `specialist`/`reviewers`/
`consultants` keys are folded into `engagements` and NOT preserved as unknown
(`parseEngagements` :785-864; the exclusion at :1099).

### 2.3 Work revision + verdicts (F10-15 revision-bound review)

- `workRevisionSchema` :438-451 — the immutable identity of the delivered work up
  for review: `id`, full `headSha`, `treeSha` (content identity), `branch`,
  `createdAt`, `sourceProfileId` (the delivering engagement's profileId that
  produced it).
- `reviewVerdictSchema` :456-469 — one reviewer's verdict bound to the
  `revisionId` it judged (result ∈ `approve`|`request_changes`). A verdict on an
  OLD revision is automatically stale.
- `nextWorkRevision(current, input)` :670 — a head with the same tree (or same
  head when tree unavailable) is the SAME review subject → no new revision, prior
  verdicts survive. A different tree mints a new id → every prior verdict goes
  stale automatically (the whole of new-commit invalidation).

Derivation helpers (pure, testable):

- `currentVerdicts(fm)` :544 — verdicts bound to the current revision.
- `deriveValidation(fm)` :557 — recomputes the `validation` cache: `failing`
  if any required reviewer requests changes; `healthy` when every required
  reviewer approved; `changed` while pending/none-required; `none` before a
  revision exists.
- `acceptanceBlockedReason(fm)` :581 — the verdict gate as reason-or-null.
- Three more acceptance gates, each reason-or-null, one guard many call sites:
  `closedPrBlockedReason` :617 (PR closed unmerged = out-of-band rejection),
  `conflictingPrBlockedReason` :638 (a conflicting PR can't be merged),
  `archivedTaskBlockedReason` :657 (restore before accepting).

### 2.4 PR / branch model — `prRefSchema` :306-342

`pr` is the reconciler's cache of GitHub state (not human truth): `number`,
`state` (PrState, tolerant `.catch("review")`), `title`, and OPTIONAL keys where
an absent key means "never read" (distinct from a known-false): `checks`
(`prChecksSchema` :296-304), `review` (PrReviewState), `mergeable` (PrMergeable),
and `revisionDrift {aheadBy, headSha}` (**R17-1**: the PR head is strictly ahead
of the reviewed revision — extra commits ship unreviewed; surfaced at accept,
:326-339). `branch` is a top-level string (:503). `github` (`githubCacheSchema`
:346-366) caches commits + change stats + `unownedPr` (a collision PR on the
branch, recorded once).

`PrState` has ONE canonical pill map — `prStatePill` in
`app/features/github/github-pills.ts`. UXA-2 (`7ee2864`) removed the review
queue's private copy, which rendered a closed-unmerged (rejected) PR neutral
where every other surface renders it `risk`.

### 2.5 Packets vs recommendations vs schedules vs noChanges

- **Packet** (`taskPacketSchema` :400-426) — the ONE pending decision. `type`
  input|blocked, `kind` label, `observations[]`, `options[]` (each a
  `PacketOptionKind` — dispatch on `kind`, never the English title). `id` for
  replacement-safety, `awaiting: goal_edit` (an `edit_goal` option was
  confirmed — clears when the edited goal lands), `askedBy` (**R15-14**: the
  profileId of the agent that raised the question — resolving resumes that
  agent's own session, :419-423).
- **Recommendations** (`recommendationSchema` :178-192) — a supervised operator
  RECOMMENDS an action; each renders as a one-click card. A task can hold several
  at once (distinct from the single packet). `delivery` (R15-2) and
  `accept_completion` are the governance-heavy kinds. The `assign_specialist`
  card is labelled **"Delivering agent"** (UXA-6, `6ba5c77`), matching the rest
  of task detail — it used to read "Primary specialist".
- **Schedules** (`scheduleSchema` :216-242) — a governed future operator re-run
  (O-3). Lifecycle `pending → claimed → fired | failed | cancelled`
  (:208-214). `claimedAt` reserves an occurrence before the detached enqueue so a
  crash is recoverable; `retries` bounds it. Never fires on a terminal (Done)
  task. Server-side runner → backend-agnostic.
- **noChanges** (:510-517, optional) — **R17-2**: the last delivery confirmed the
  branch has no commits ahead of the default branch (goal already satisfied). The
  one signal that turns the "deliver the branch first" acceptance refusal into a
  first-class "Completed — no changes" close-to-Done. Set on a
  `nothing_to_review` delivery result (`task-actions.server.ts:3482`, `:3621`),
  cleared the moment a delivery opens a real PR (`:3543-3545`).

### 2.6 Other frontmatter fields

`key` (regex `^[A-Za-z]+-\d+$`), `title`, `stage` (an unresolvable stage →
blank marker + `unresolved_stage` warning; the card lands in the board's orphan
bucket, NOT a hardcoded `triage`, :923-949), `ownerUserId`, `operator`
(`operatorRefSchema` :146-149, stores `assignedAtStageId`), `urgent`, `archived`
(**R14-3** terminal disposition: leaves board default view + review queue, keeps
timeline, restorable, :489-494), `createdAt`/`updatedAt`, `boardRank` (sparse
rank for drag-reorder; null → task-key number, :521-523). Note `repo` is GONE
from the schema (**P13-D-5**, one project one repo) — an existing `repo:` line is
now an unknown key, preserved verbatim, ignored (:504-508).

`archived` also drives display: the task hero drops the readiness + validation
pills for an archived task and keeps only the stage (UXO-1, `d69af18` —
`task-main-sections.tsx:160-174`), because an archived task owes nobody a verdict.

### 2.7 Timeline + actor refs

`TaskFileEvent` :1243-1257 (newest-first): occurredAt, type, `actor`
(`FileActorRef` :1165-1176: human `user:<id>`, agent `agent:<backend>/<profileId>`,
operator, system, or tolerant `unknown` round-tripped verbatim), title, RichText
`text`, `toAgent`, `evidence` (`EvidenceRow[]` — a reference not a dump, ≤8 rows,
`normalizeEvidenceRows` :1220). `EVIDENCE_EMPTY_COLUMN = "—"` (:1210).

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

## 6. Delta (pass 19)

**No schema change since pass 18** — `app/schemas/` is byte-identical at
`6656d6f..65063b8` (confirmed: neither schema file appears in
`git diff --stat 6656d6f..HEAD -- app/`). The 12 app-touching commits consumed
existing fields only.

What changed AROUND the model:

- **R18-5** (`776e0ed`) added a run-time carrier for granted skills; no
  frontmatter field is involved (grants still live in `project.md`
  `agents[].definition.resources.skills`).
- **UXA-6** renamed the `assign_specialist` recommendation's display label to
  "Delivering agent" (§2.5) — label only, `RecommendationKind` unchanged.
- **UXA-2** collapsed the review queue onto the canonical `prStatePill` map (§2.4).
- **UXO-1** made `archived` suppress the readiness/validation hero pills (§2.6).
- **Anchors**: every `task-file.schema.ts` anchor moved +6 vs the pass-18 doc
  (a stale-doc artifact, not a code change). The `TIMELINE_EVENT_TYPES` count is
  **11** (the pass-18 doc said 10 and omitted `continuity`).
