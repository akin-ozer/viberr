# DOMAIN-MODEL — Viberr current state (pass 20)

> Verified against `main @b97ad02` on 2026-08-14 (pass 20).

Re-derived from the tree at `main @b97ad02`. The two canonical file formats —
`task.md` and `project.md` — are defined by Zod schemas in `app/schemas/`. Files
are the source of truth; SQLite `*_projections` tables are a rebuildable
read-model (see ARCHITECTURE.md).

**Baseline correction (pass 20)**: the pass-19 copy of this doc was verified
against `65063b8`, which is the pass-19 *session* tree — one commit BEFORE the
pass-19 merge (`4184e95`, PR #157) landed on main. That merge changed
`task-file.schema.ts` by +98/−9 (R19-8 verification revisions, F19-8
archived-move guard), so the pass-19 doc's headline claim — "no schema change
since pass 18, `app/schemas/` is byte-identical" — was true of its own baseline
and false the moment pass 19 shipped. **Every `task-file.schema.ts` anchor below
was re-read from the current file**; `project-file.schema.ts` has not changed
since pass 18 and its anchors are unchanged again.

Companion parsers: `app/server/files/task-file.server.ts` (assembles
`ParsedTaskFile`), `app/server/files/project-file.server.ts`. Serializer round-
trips unknown keys verbatim (tolerance contract, below).

---

## 1. Tolerance contract (both schemas)

`app/schemas/task-file.schema.ts:9-21`, `project-file.schema.ts:8-14`. The parser
NEVER throws and NEVER drops a whole file:

- Unknown frontmatter fields are **preserved verbatim** and re-emitted on write
  (`unknown` bag, built in `parseTaskFrontmatter` (:950) at
  `task-file.schema.ts:1174-1183`).
- Missing/invalid fields produce a structured `FileDiagnostic` + a safe fallback
  (`tolerant()` helper, `task-file.schema.ts:820`).
- **Per-entry** list parsing (`tolerantArray`, `project-file.schema.ts:267-313`):
  one bad `members[]`/`stages[]`/`agents[]` row drops only itself, never the
  whole list — a governance-integrity fix (a single malformed member row used to
  wipe every member's role).

---

## 2. task-file schema (`app/schemas/task-file.schema.ts`)

`taskFrontmatterSchema` at **:486-543**; key list `TASK_FRONTMATTER_KEYS` at
**:780-805**. Full parsed file `ParsedTaskFile` at **:1340-1349** (frontmatter +
unknownFrontmatter + goal + packet + timeline[] + extraSections[]).

### 2.1 Enums

| Enum | Values | Anchor |
| --- | --- | --- |
| `Readiness` | `ready`, `input_required`, `inconsistency_risk_detected`, `blocked` | :25-31 |
| `Waiting` | `human`, `agent`, `none` | :33-34 |
| `Validation` (derived) | `healthy`, `changed`, `failing`, `none` | :36-37 |
| Timeline event types (**11**) | comment, completion, github, policy, note, quality, transition, blocked, agent, assign, **continuity** | :47-64 |
| `PacketOptionKind` (**9**) | accept_completion, request_edit, block_on_policy, hold_runtime_debug, redirect, retry_other_backend, edit_goal, archive_task, custom | :68-89 |
| `RecommendationKind` (**7**) | assign_specialist, assign_reviewer, transition, run_specialist, run_reviewer, accept_completion, delivery | :155-176 |
| `ScheduleStatus` | pending, claimed, fired, failed, cancelled | :208-214 |
| `PrState` | review, merged, closed, accepted | :249 |
| `PrReviewState` | approved, changes_requested, review_required | :266-271 |
| `PrMergeable` | clean, conflicting, unknown | :291 |
| `WorkRevision.kind` (**new**) | `delivered`, `verified` (absent ⇒ delivered) | :449-460 |
| `ReviewVerdict.result` | approve, request_changes | :465 |

Readiness is the canonical 4-value enum ONLY; "accepted" is a *derived display*
state, never stored (:19-21).

`continuity` (G8, :58-63) is a **warning-toned** typed event for a runtime
continuity reset (a resumed session's provider transcript was gone, so the agent
re-anchored on `task.md` in a fresh session) — deliberately not a neutral `note`
and not `policy`/`blocked`.

The packet-kind count is **nine**, not eight: `archive_task` (R14-3) is easy to
miss. It is now *mechanically* pinned — `app/shared/docs/file-formats-sync.test.ts`
(N19-3, new since pass 19) parses `docs/architecture/file-formats.md`'s `##
Packet` section and fails if its enumeration or its spelled count drifts from
`PACKET_OPTION_KINDS`. Edit the schema; the doc becomes a mechanical follow-up.

> **Stale comment in the code**: the doc-comment above `TIMELINE_EVENT_TYPES`
> (`:39`) still reads "The 10 timeline event types" while the array holds 11
> (`continuity` was added under it). Harmless, but it is the same shape of drift
> N19-3 just gated for packet kinds — nothing gates this one.

### 2.2 Engagements (the G1 generic-agents model) — `engagementSchema` :113-128

The single uniform list that replaced the old `specialist` + `reviewers[]` slots.
Every engaged agent (deliverer AND reviewers) is one `Engagement` row:

- `profileId` — the join key (identity is the **profile id**, never the role
  string; :96-103, :1245-1256).
- `backend` (`codex`|`claude`), `role` (display snapshot at engage time).
- `delivers: boolean` — **exactly one** engagement may be `true`: the
  workspace/branch/PR owner (single-writer invariant). The parser demotes extras
  (`parseEngagements` :865-948).
- `verdictCapable: boolean` — file-local snapshot at engage time of whether this
  engagement held an explicit `report-validation-verdict: direct` grant (:120-125).
  A supporting engagement that does is a **required reviewer** whose approval of
  the current revision gates acceptance.

Helpers: `deliveringEngagement(fm)` → the one `delivers:true` or null (:131-135);
`supportingEngagements(fm)` (:138-142); `requiredReviewers(fm)` = non-delivering
+ verdictCapable (:561-563).

`deliveringEngagement` also drives **R18-1 reviewer-KB inheritance** at run time
(`specialist-run.server.ts:303-307`, AGENTS-RUNTIME.md §3.1).

Legacy absorption: a pre-engagements task.md's `specialist`/`reviewers`/
`consultants` keys are folded into `engagements` and NOT preserved as unknown
(`parseEngagements` :865-948; the exclusion at :1179).

### 2.3 Work revision + verdicts (F10-15 revision-bound review)

- `workRevisionSchema` :438-463 — the immutable identity of the delivered work up
  for review: `id`, full `headSha`, `treeSha` (content identity), `branch`,
  `createdAt`, `sourceProfileId` (the delivering engagement's profileId that
  produced it), and **`kind`** (R19-8, :449-460).
- **`kind: "delivered" | "verified"` (new since pass 19)** — `delivered` is a
  commit a delivering run produced (the only kind that existed before pass 19).
  `verified` is a **verification revision**: the default-branch head a reviewer
  judged on a task that has *nothing to deliver*, minted at verdict time so the
  verdict has a subject to bind to. A verification revision never carries a task
  branch (`branch: null`). **ABSENT reads as `delivered`** — read it as
  `=== "verified"`, never as `!== "delivered"`.
- `reviewVerdictSchema` :468-481 — one reviewer's verdict bound to the
  `revisionId` it judged (result ∈ `approve`|`request_changes`). A verdict on an
  OLD revision is automatically stale.
- `nextWorkRevision(current, input)` :746-778 — a head with the same tree (or same
  head when tree unavailable) is the SAME review subject → no new revision, prior
  verdicts survive. A different tree mints a new id → every prior verdict goes
  stale automatically (the whole of new-commit invalidation). It has ONE caller
  (a delivering run's reconcile), so everything it mints is stamped
  `kind: "delivered"` (:771-774); the `verified` revision is minted elsewhere, at
  verdict time (`recordAgentCompletion`).

Derivation helpers (pure, testable):

- `currentVerdicts(fm)` :566-573 — verdicts bound to the current revision.
- `deriveValidation(fm)` :579-617 — recomputes the `validation` cache: `failing`
  if any required reviewer requests changes; `healthy` when every required
  reviewer approved; **`none` when `fm.noChanges && required.length === 0`**
  (F19-27, :615 — a verified no-change completion has a revision but nothing
  inside it to review, and used to sit in Done wearing "awaiting verdict");
  `changed` while pending/none-required; `none` before a revision exists. The
  `noChanges` arm is placed LAST and narrowed to *zero* required reviewers on
  purpose: a verify-only task whose required reviewer has not yet approved stays
  `changed`, because the acceptance gate is genuinely holding.
  `ReviewState` (:550-557) gained the optional `noChanges` field for this.
- `acceptanceBlockedReason(fm)` :630-656 — the verdict gate as reason-or-null.
  Its "No reviewed revision yet" refusal now names the escape route ("If this
  task requires no changes, run delivery once to verify and record that",
  :640-643) — the F19-21 dead end where a verification-only task could only be
  force-accepted or manually marked Done.
- **Five** reason-or-null guards now, each one guard for many call sites:
  `closedPrBlockedReason` :674-680 (PR closed unmerged = out-of-band rejection),
  `conflictingPrBlockedReason` :695-703 (a conflicting PR can't be merged),
  `archivedTaskBlockedReason` :714-720 (restore before accepting), and **new**
  `archivedTaskMoveBlockedReason` :733-739 (**F19-8**: an archived task could be
  dragged/keyboard-moved/API-transitioned between stages while every surface
  called it abandoned; the same reasoning as the accept guard, one step earlier).

**The live no-change gate lives outside the schema** — `noChanges` is a *claim
about a moment that has passed*, so a sixth gate re-establishes it with a LIVE
remote read before any writer closes a task to Done:
`app/server/tasks/no-change-completion.server.ts` (R19-8) holds the whole
contract in one module — `noChangeApplies` (pure, :52), `probeNothingToDeliver`
(:74), `acceptanceNoChangeCheck` (:237),
`assertVerifiedNoChangeStillApplies` (:276) and the one shared
`noChangeCompletionEvent` (:295). It **fails closed**: "we could not look" is
never "there is nothing there". Verification basis is one of `no_repo` /
`no_branch` / `branch_empty`, with the base branch + base sha it checked.

### 2.4 PR / branch model — `prRefSchema` :306-342

`pr` is the reconciler's cache of GitHub state (not human truth): `number`,
`state` (PrState, tolerant `.catch("review")`), `title`, and OPTIONAL keys where
an absent key means "never read" (distinct from a known-false): `checks`
(`prChecksSchema` :296-304), `review` (PrReviewState), `mergeable` (PrMergeable),
and `revisionDrift {aheadBy, headSha}` (**R17-1**: the PR head is strictly ahead
of the reviewed revision — extra commits ship unreviewed; surfaced at accept,
:326-339). `branch` is a top-level string (:515). `github` (`githubCacheSchema`
:346-366) caches commits + change stats + `unownedPr` (a collision PR on the
branch, recorded once).

`PrState` has ONE canonical pill map — `prStatePill` in
`app/features/github/github-pills.ts`. UXA-2 removed the review queue's private
copy, which rendered a closed-unmerged (rejected) PR neutral where every other
surface renders it `risk`.

### 2.5 Packets vs recommendations vs schedules vs noChanges

- **Packet** (`taskPacketSchema` :400-426) — the ONE pending decision. `type`
  input|blocked, `kind` label, `observations[]` (:368-375), `options[]` (each a
  `PacketOptionKind` — dispatch on `kind`, never the English title; :377-398).
  `id` for replacement-safety, `awaiting: goal_edit` (an `edit_goal` option was
  confirmed — clears when the edited goal lands, :416-418), `askedBy` (**R15-14**:
  the profileId of the agent that raised the question — resolving resumes that
  agent's own session, :419-423).
- **Recommendations** (`recommendationSchema` :178-192) — a supervised operator
  RECOMMENDS an action; each renders as a one-click card. A task can hold several
  at once (distinct from the single packet). `delivery` (R15-2) and
  `accept_completion` are the governance-heavy kinds. The `assign_specialist`
  card is labelled **"Delivering agent"** (UXA-6) — label only,
  `RecommendationKind` unchanged.
- **Schedules** (`scheduleSchema` :216-242) — a governed future operator re-run
  (O-3). Lifecycle `pending → claimed → fired | failed | cancelled` (:208-214).
  `claimedAt` reserves an occurrence before the detached enqueue so a crash is
  recoverable; `retries` bounds it. Never fires on a terminal (Done) task.
  Server-side runner → backend-agnostic.
- **noChanges** (:522-536, optional) — **R17-2 + R19-8**: this task completes with
  NOTHING to deliver. Acceptance of a `workRevision && !pr` task is normally
  refused ("deliver the branch & open the PR"); this flag is the ONE signal that
  turns that refusal into a first-class "Completed — no changes" close-to-Done.
  It now has **two producers** (pass 19 added the second):
  1. a delivery attempt that found the branch empty (`performDelivery`'s
     `nothing_to_review` result — `task-actions.server.ts:3639`, `:3822`);
  2. a reviewer approving a task that never needed a branch at all
     (`recordAgentCompletion`, which also mints the `kind: "verified"` revision
     the verdict binds to — `task-actions.server.ts:1905`).

  Cleared the moment a delivery opens a real PR (`task-actions.server.ts:3716-3718`).
  Re-verified live before Done (§2.3).

### 2.6 Other frontmatter fields

`key` (regex `^[A-Za-z]+-\d+$`), `title`, `stage` (an unresolvable stage →
blank marker + `unresolved_stage` warning; the card lands in the board's orphan
bucket, NOT a hardcoded `triage`, :1003-1029), `ownerUserId`, `operator`
(`operatorRefSchema` :146-149, stores `assignedAtStageId`), `urgent`, `archived`
(**R14-3** terminal disposition: leaves board default view + review queue, keeps
timeline, restorable, :501-506), `createdAt`/`updatedAt`, `boardRank` (sparse
rank for drag-reorder; null → task-key number, :540-542). Note `repo` is GONE
from the schema (**P13-D-5**, one project one repo) — an existing `repo:` line is
now an unknown key, preserved verbatim, ignored (:516-520).

`archived` also drives display: the task hero drops the readiness + validation
pills for an archived task and keeps only the stage (UXO-1 —
`task-main-sections.tsx`), because an archived task owes nobody a verdict. Since
pass 19 it also blocks *stage moves*, not just acceptance (§2.3).

### 2.7 Timeline + actor refs

`TaskFileEvent` :1323-1338 (newest-first): occurredAt, type, `actor`
(`FileActorRef` :1245-1256: human `user:<id>`, agent `agent:<backend>/<profileId>`,
operator, system, or tolerant `unknown` round-tripped verbatim), title, RichText
`text`, `toAgent`, `evidence` (`EvidenceRow[]` :1270-1274 — a reference not a
dump, ≤8 rows, `normalizeEvidenceRows` :1300). `EVIDENCE_MAX_ROWS = 8` (:1278);
`EVIDENCE_EMPTY_COLUMN = "—"` (:1290).

**The file union has 5 actor kinds; the projection column has 4.** `task_events.
actor_kind` CHECKs `('human','agent','operator','system')`, and the rebuilder
collapses `unknown → system` so a tolerantly-kept unrecognized author still
appears in every feed rather than being dropped (D7 —
`rebuilder.server.ts:546-555`; the render side mirrors it with an "Unknown actor"
system chip, `app/shared/mapping/actor.server.ts:119-120`).

**R19-19 evidence linkify**: an evidence `label` whose tokens name a *real*
attachment filename renders as a link to the member-only attachment route
(`app/features/task-detail/timeline.tsx:105-127`). The schema is untouched — the
label is still a plain string; the linkify is a render-time join against the
task's actual attachment names (§6).

---

## 3. project-file schema (`app/schemas/project-file.schema.ts`)

Unchanged since pass 18. `projectFrontmatterSchema` at **:168-191**; key list at
**:194-208**; `ParsedProjectFile` = frontmatter + unknownFrontmatter +
description (:216-221).

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

### 3.2 Capability catalog (`app/shared/capabilities.ts`)

`capabilities[].capabilityId` is a **persisted key** in every `project.md`, so
ids never get renamed (see the `assign-primary-specialist` note at
`capabilities.ts:36-51` — the *label* moved to "Assign the delivering agent",
the id did not). One addition since pass 19:

- **`use-browser`** — "Drive a live web browser" (R19-19,
  `capabilities.ts:101-111`). Kind `agent`, group `Collaboration`,
  **`defaultMode: "off"`** (same reasoning as `report-validation-verdict`: a
  casually created profile must not silently acquire a driven browser). It is in
  `ENFORCED_CAPABILITY_IDS` (`:237-240`) — enforcement is the **MOUNT**: granted ⇒
  a viberr-owned Playwright MCP server joins the run's `mcpServers` on both
  backends; withheld ⇒ the tool surface does not exist (no deny rule needed).
  The mount additionally requires *effective* `use-web-search-fetch` — the
  browser IS network egress, and a profile whose egress was revoked must not
  re-acquire it one row down (`resolveBrowserMcp`,
  `app/server/tasks/specialist-browser-mcp.server.ts`); the contradictory pair is
  surfaced through the P14-LV-09 disclosure pipe, never resolved silently.
- `viberr_browser` (and the hyphen spelling) joined `RESERVED_MCP_NAMES`
  (`app/server/tasks/specialist-mcp.server.ts:60-66`) alongside
  `viberr`/`viberr_agent` — these are built in-process and are never org-registry
  grants.

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
rebuildable per-table. `db/migrations/0001_baseline.sql` defines the schema — and
it is still the **only** migration file: while pre-prod, schema changes are
squashed INTO the baseline and a schema change means wipe + re-seed
(`npm run seed -- --reset`), because the runner skips by FILENAME alone
(`0001_baseline.sql:10-19`). Two pass-19/20 changes landed exactly that way
(`oauth_providers`, the two `org_mcp_servers` columns).

`task_projections` (`0001_baseline.sql:72-125`) is the board/queue/inbox read
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
| `board_rank` | frontmatter `boardRank` | REAL; sparse rank for drag-reorder |

`workRevision.kind` and `noChanges` are **not** their own columns — they reach the
read model through `validation` / `validation_block_reason`, which are recomputed
from them on every write.

Sibling projection tables: `task_events`, `diagnostics`, `provenance`,
`notifications`, `project_members`, `projects`, and the run tables
(`agent_runs`, `run_log_lines`).

Org-level SQLite tables are NOT projections — they are canonical in SQLite (this
is the data class the F18-5 dual-writer bug silently ate; see ARCHITECTURE.md):
`users`, `user_prefs`, `audit_events`, `github_pats`,
`project_github_credentials`, `github_connections`, `google_domain_allowlist`,
**`oauth_providers`**, `org_knowledge_bases`, `org_mcp_servers`, `org_skills`,
`scope_violations`, `staged_outcomes`, and better-auth `user`/`session`/
`account`/`verification`.

### 5.1 New / changed SQLite since pass 19

- **`oauth_providers`** (R19-16, `0001_baseline.sql:224-239`) — NEW table.
  `provider` PK CHECK `('github','google')`, `client_id`, `client_secret` (a
  sealed secret box, never plaintext), `enabled`, `verified_at`,
  `verified_detail`, timestamps. Contract: an app row **overrides** the
  deployment env (`GITHUB_OAUTH_*` / `GOOGLE_OAUTH_*` stay a bootstrap default),
  including when it is configured-and-disabled; and `enabled` cannot be set
  without a `verified_at` written by a live provider round-trip, which is cleared
  the moment either credential changes. Reader:
  `app/server/auth/oauth-providers.server.ts` — `resolveOAuthProvider` (:304)
  returns an `OAuthSource` of `"app" | "env" | "none"` (:288), and
  `oauthConfigFingerprint` (:356) is a NON-secret fingerprint the better-auth
  instance cache is keyed on so a change applies with no restart.
- **`org_mcp_servers.last_error`** (R19-17b, `:270-273`) — why the last probe
  failed, in the command's own words, already scrubbed of the `MCP_CREDENTIAL`
  the child was spawned with (`redactGitOutput`). NULL when the server is up or
  was never probed — the up path CLEARS it, because a stale reason under a green
  dot is worse than none.
- **`org_mcp_servers.warming_since`** (R19-18, `:265-269`) — set while a first-run
  install runs in the BACKGROUND for this server. The row reads INSTALLING — its
  own state, neither green nor red. `reapStaleWarmups` clears the flag at boot
  (the flag means "running HERE"). Both columns surface on
  `McpView` (`app/server/org/resources.server.ts:507-546`) as
  `lastError` / `warmingSince`.

### 5.2 Typed events (unchanged)

`ProjectionEvent` (`app/server/events/projection-events.server.ts:11-44`) is a
**closed** typed union of 8 variants routed by user/project/task scope:
`task.updated`, `task.removed`, `project.updated`, `project.removed`,
`projection.rebuilt`, `notification.created`, `notification.read`,
`violation.updated`. Nothing was added this pass — and that is load-bearing: the
MCP warm-up state (§5.1) settles by a **20s poll** on the settings page precisely
because an org-settings row fits none of these three scopes, and a new name plus
a new scope would be a lot of plumbing for one transient state.

`notifications.kind` remains the 5-value CHECK `('packet','approval','mention',
'quality','policy')` (`0001_baseline.sql:168`).

### 5.3 Rebuild entry points (**moved since pass 19**)

- `reprojectTask(db, ctx, slug, key)` is now in
  **`app/server/tasks/task-mutation.server.ts:114`** — not `task-actions.server.ts`.
  That module is a deliberate **cycle break**, not tidying: `agent-toolkit`
  needed `loadProjectContext` (:78) / `taskRef` (:101) / `reprojectTask` (:114)
  and importing them from `task-actions` closed
  `specialist-run → agent-toolkit → task-actions ⇢ specialist-run`, whose hidden
  dynamic edge produced a half-evaluated namespace and a silently swallowed
  `retry_other_backend` (see the header comment, `:13-39`). `task-actions.server.ts`
  re-exports all three, so existing importers are unaffected.
- `rebuildPath` / `rebuildAll` → `app/server/projections/rebuilder.server.ts:618`,
  `:741` (were `:584` / `:707`).

Both are driven on every file change by the chokidar watcher (ARCHITECTURE.md).

---

## 6. Task attachments — a third store (R19-19, new)

Not a file schema and not a projection: **the directory is the truth**.

- Location: `projects/<slug>/tasks/<KEY>/attachments/`
  (`taskAttachmentsDir`, `app/server/files/file-store-root.server.ts:80-93`) —
  inside the task dir on purpose, so archive/delete flows move attachments with
  the task and no retention machinery is needed.
- One writer today: the browser MCP server's `--output-dir`
  (`specialist-browser-mcp.server.ts`). Live-verified quirk: **default-named**
  screenshots land in the output dir, **self-named** ones resolve against the
  child cwd — the persona steers to default naming and says so.
- Read side: `app/server/files/task-attachments.server.ts` —
  `listTaskAttachments` (:35, newest-first, capped at 100),
  `resolveTaskAttachment` (:67, through the traversal-refusing
  `resolveStoreSegment`), `attachmentContentType` (:91).
- Serving: `GET /projects/:slug/tasks/:key/attachments/:file`
  (`app/routes.ts:38-43` → `app/routes/task-attachment.ts`). **Project
  membership** is the bar (same as `/resources/run-log`, not the app-wide task
  summary); traversal is a plain 404 with no oracle; every response carries
  `nosniff` + `Content-Security-Policy: sandbox`; only a whitelist of extensions
  renders inline and **HTML/SVG/JS never do** — a stored page served on the app
  origin with the viewer's session attached is stored XSS. 50 MB read bound.
- UI: newest-first panel on the task page
  (`app/features/task-detail/attachments-panel.tsx`), plus the evidence linkify
  in §2.7.

---

## 7. Delta (pass 20)

Schema/model changes since the pass-19 doc's baseline (`65063b8`), i.e. the
pass-19 merge itself plus the 12 commits on top of it:

**`task-file.schema.ts` (from the pass-19 merge — the pass-19 doc missed these):**

- `workRevision.kind: "delivered" | "verified"` (R19-8) — verification revisions,
  minted at verdict time for tasks with nothing to deliver, so an approval has a
  subject to bind to (§2.3). Absent ⇒ `delivered`.
- `ReviewState.noChanges` + `deriveValidation`'s trailing `none` arm (F19-27),
  narrowed to `required.length === 0` so a pending required reviewer still reads
  `changed` (§2.3).
- `acceptanceBlockedReason`'s "No reviewed revision yet" copy now names the
  escape route (F19-21).
- `archivedTaskMoveBlockedReason` (F19-8) — a **fifth** reason-or-null guard;
  archived tasks can no longer be moved between stages (§2.3).
- `noChanges` gained a second producer (`recordAgentCompletion`) and a **live
  accept-time re-verification** in the new
  `app/server/tasks/no-change-completion.server.ts`, which fails closed (§2.5).

**SQLite baseline (post-merge commits):**

- NEW table `oauth_providers` (R19-16) — in-app OAuth config that overrides the
  deployment env; `enabled` requires a live-verified credential pair (§5.1).
- NEW columns `org_mcp_servers.last_error` (R19-17b) and `.warming_since`
  (R19-18) (§5.1).
- Still one migration file; both changes rode the pre-prod squash convention.

**Capabilities:**

- NEW `use-browser` (R19-19), default **off**, enforced by MOUNT on both
  backends, interlocked with `use-web-search-fetch` (§3.2). `viberr_browser`
  joined the reserved MCP names.

**New store:**

- Task attachments (§6) — directory-as-truth under the task dir, member-only
  serving route, evidence-label linkify.

**Unchanged, re-verified:** `project-file.schema.ts` (byte-identical since pass
18, all anchors hold); `ProjectionEvent` union; `TIMELINE_EVENT_TYPES` (11);
`PACKET_OPTION_KINDS` (9, now mechanically gated by
`app/shared/docs/file-formats-sync.test.ts`); `RECOMMENDATION_KINDS` (7);
`TASK_FRONTMATTER_KEYS` (22 keys, no additions).

**Corrections to the pass-19 doc, beyond the new material:**

1. Its baseline `65063b8` predates the pass-19 merge, so "no schema change since
   pass 18" did not survive pass 19 landing. Every `task-file.schema.ts` anchor
   moved again (the ranges above are re-read, not adjusted).
2. `reprojectTask` is at `task-mutation.server.ts:114`, not
   `task-actions.server.ts:394`.
3. `rebuildPath`/`rebuildAll` are at `rebuilder.server.ts:618`/`:741`, not
   `:584`/`:707`.
4. `task_projections` spans `0001_baseline.sql:72-125`, and the doc's column
   table omitted `board_rank`.
5. The `noChanges` set/clear anchors it cited (`task-actions.server.ts:3482`,
   `:3621`, `:3543-3545`) are all stale, and there are now more writers (§2.5).
6. Its "org-level SQLite tables" list was partial — it omitted `audit_events`,
   `user_prefs`, `scope_violations`, `project_github_credentials`,
   `github_connections`, `google_domain_allowlist` and `staged_outcomes` (§5).
7. It did not record that the 5-kind `FileActorRef` union collapses to the
   4-value `task_events.actor_kind` CHECK (`unknown → system`, §2.7).
8. The `TIMELINE_EVENT_TYPES` doc-comment in the code still says "10" while the
   array holds 11 — the pass-19 doc corrected the prose count but not the code
   comment, and nothing gates it (§2.1).
