# DOMAIN-MODEL — Viberr current state (pass 21)

> **Verified 2026-08-19 against `main @ce2bc9e`** (worktree branch
> `claude/viberr-app-inspection-1fe423`, identical to main). Every anchor below
> was re-read at that commit.

**Read this before trusting the pass-20 copy.** The pass-20 doc
(`planning/discovery-2026-08-14-pass20/reference/DOMAIN-MODEL.md`) was pinned to
`main @b97ad02` — the **discovery baseline of pass 20, before pass 20's own
work landed**. Pass 20 then merged as **PR #169** (`6c94f2c`) and two anti-slop
lint commits followed (`54ffab8`, `ce2bc9e`). So the pass-20 doc does not
contain a single one of the pass-20 schema additions it is named after:
`task_projections.acceptance`, `task_projections.continuity`,
`org_mcp_servers.first_success_at`, `org_mcp_servers.heuristic_warmups`, the
`model_availability` table, the 10th packet kind `discard_branch`, the 5th
`validation` value `bypassed`, or the 23rd frontmatter key. All are below, and
a "Corrections vs pass-20 doc" list closes the file.

Viberr's two canonical file formats — `task.md` and `project.md` — are defined
by Zod schemas in `app/schemas/`. **Files are the source of truth**; the SQLite
`*_projections` tables are a rebuildable read-model (see ARCHITECTURE.md).
Companion parsers: `app/server/files/task-file.server.ts` (assembles
`ParsedTaskFile`), `app/server/files/project-file.server.ts`. The serializer
round-trips unknown keys verbatim (tolerance contract, §1).

---

## 1. Tolerance contract (both schemas)

> Verified 2026-08-19 against `app/schemas/task-file.schema.ts:9-21` and
> `app/schemas/project-file.schema.ts` (`tolerant` :254, `tolerantArray` :295).

The parser **NEVER throws and NEVER drops a whole file**:

- Unknown frontmatter fields are **preserved verbatim** and re-emitted on write
  (the `unknown` bag, built in `parseTaskFrontmatter` (`task-file.schema.ts:1019`)
  at **:1240-1249**; the project side keys off `PROJECT_FRONTMATTER_KEY_SET`
  (`project-file.schema.ts:231`)).
- Missing/invalid fields produce a structured `FileDiagnostic` + a safe fallback
  (`tolerant()` helper, `task-file.schema.ts:882`, `project-file.schema.ts:254`).
- **Per-entry** list parsing (`tolerantArray`, `project-file.schema.ts:295`):
  one bad `members[]`/`stages[]`/`agents[]`/`workflow[]` row drops only itself,
  never the whole list — a governance-integrity fix (a single malformed member
  row used to wipe every member's role). Applied at :423-426.

**Both `tolerant` helpers changed signature in the anti-slop lint pass**
(`ce2bc9e`): they now take `(diagnostics, data, path, schema, fallback, opts)`
and read `data[path]` themselves, instead of taking a pre-extracted `value`.
Behaviour is identical; only the call shape moved.

---

## 2. task-file schema (`app/schemas/task-file.schema.ts`, 1394 lines)

> Verified 2026-08-19 against `app/schemas/task-file.schema.ts`.

`taskFrontmatterFields` (the field-by-field map the tolerant parser reaches
into) is at **:502-566**; the composed strict schema `taskFrontmatterSchema` at
**:569**. Key list `TASK_FRONTMATTER_KEYS` at **:829-855** (**23 keys** — see
§2.6). Full parsed file `ParsedTaskFile` at **:1385-1394** (frontmatter +
unknownFrontmatter + goal + packet + timeline[] + extraSections[]).

### 2.1 Enums

| Enum | Values | Anchor |
| --- | --- | --- |
| `READINESS_VALUES` | `ready`, `input_required`, `inconsistency_risk_detected`, `blocked` (**4**) | :25-31 |
| `WAITING_VALUES` | `human`, `agent`, `none` | :33 |
| `VALIDATION_VALUES` | `healthy`, `changed`, `failing`, `none`, **`bypassed`** (**5** — was 4) | **:42** |
| `TIMELINE_EVENT_TYPES` | comment, completion, github, policy, note, quality, transition, blocked, agent, assign, **continuity** (**11**) | :53-70 |
| `PACKET_OPTION_KINDS` | accept_completion, request_edit, block_on_policy, hold_runtime_debug, redirect, retry_other_backend, edit_goal, archive_task, **discard_branch**, custom (**10** — was 9) | **:74-101** |
| `RECOMMENDATION_KINDS` | assign_specialist, assign_reviewer, transition, run_specialist, run_reviewer, accept_completion, delivery (**7**) | :168-188 |
| `SCHEDULE_ACTION_TYPES` | `run-operator` | :214 |
| `SCHEDULE_STATUS_VALUES` | pending, claimed, fired, failed, cancelled | :221-227 |
| `PR_STATE_VALUES` | review, merged, closed, accepted | :262 |
| `PR_REVIEW_VALUES` | approved, changes_requested, review_required | :279-284 |
| `PR_MERGEABLE_VALUES` | clean, conflicting, unknown | :304 |
| `WorkRevision.kind` | `delivered`, `verified` (absent ⇒ delivered) | :462-473 |
| `REVIEW_VERDICT_RESULTS` | approve, request_changes | :478 |

Readiness is the canonical 4-value enum ONLY; `"accepted"` is a *derived
display* state, never stored (:19-21).

**`bypassed` is NEW this pass (N20-14 / §5c of the pass-20 spec).** Read the
comment at **:36-41**: it is a *derived* value produced only by
`deriveValidation` when the task carries the durable `acceptance: "forced"`
fact. It is not hand-authored like the other four, but it rides the same
`validation` field the projection caches, so it must be a first-class enum
member for the round-trip and the derivation return type. If you add a
`validation` consumer, handle five values.

**`discard_branch` is the 10th packet kind (R20-2 / F20-6, :93-99).** It
discards the task's LOCAL, never-pushed workspace branch — **cleanup, not a
disposition**: the task stays on the board and closes through the ordinary
no-change acceptance. It refuses when the branch exists on the remote (remote
deletion stays ruling 17's `archive_task(+deleteBranch)` path). Resolution
enforces `approve-transition` (it destroys commits). Server side:
`resolvePacket`'s `case "discard_branch"` at
`app/server/tasks/task-actions.server.ts:4994` (the `approve-transition`
`requireAction` at :5000-5006), which records the decision and clears the packet;
the git work runs afterwards via `discardLocalTaskBranch` at :5235 / :5310
(`app/server/github/push-workspace.server.ts:783`, outcomes
`deleted | not_found | on_remote | no_workspace | failed` at :762-767).

The packet-kind count is **mechanically pinned**:
`app/shared/docs/file-formats-sync.test.ts` parses `docs/architecture/file-formats.md`'s
`## Packet` section and fails if its enumeration or its spelled count drifts
from `PACKET_OPTION_KINDS`. Edit the schema ⇒ the doc is a mechanical follow-up.

`continuity` (G8, :64-69) is a **warning-toned** typed event for a runtime
continuity reset (a resumed session's provider transcript was gone, so the agent
re-anchored on `task.md` in a fresh session) — deliberately not a neutral `note`
and not `policy`/`blocked`. Its one writer is `noteContinuityReset`
(`app/server/runtimes/run-service.server.ts:641`, called from the resume path at
**:795**). **Since pass 20 it is also projected** — see §5.1.

> **Stale code comment (still present, still ungated):** the doc-comment above
> `TIMELINE_EVENT_TYPES` (**:45**) reads "The 10 timeline event types" while the
> array holds 11. `file-formats-sync.test.ts` gates the packet count, nothing
> gates this one.

### 2.2 Engagements (the G1 generic-agents model) — `engagementSchema` :126-141

The single uniform list that replaced the old `specialist` + `reviewers[]`
slots. Every engaged agent (deliverer AND reviewers) is one `Engagement` row:

- `profileId` — the join key (identity is the **profile id**, never the role
  string; see `FileActorRef` :1276-1287 and its rationale at :1256-1275).
- `backend` (`codex`|`claude`), `role` (display snapshot at engage time).
- `delivers: boolean` — **exactly one** engagement may be `true`: the
  workspace/branch/PR owner (single-writer invariant). The parser demotes extras
  (`parseEngagements` :928).
- `verdictCapable: boolean` — file-local snapshot at engage time of whether this
  engagement held an explicit `report-validation-verdict: direct` grant
  (:133-138). A supporting engagement that does is a **required reviewer** whose
  approval of the current revision gates acceptance.

Helpers: `deliveringEngagement(fm)` → the one `delivers:true` or null (:144);
`supportingEngagements(fm)` (:151); `requiredReviewers(fm)` = non-delivering +
verdictCapable (:590).

Legacy absorption: a pre-engagements `task.md`'s `specialist`/`reviewers`/
`consultants` keys are folded into `engagements` and NOT preserved as unknown
(`parseEngagements` :928; the exclusion at **:1245**).

### 2.3 Work revision + verdicts (F10-15 revision-bound review)

- `workRevisionSchema` **:451-475** — the immutable identity of the delivered
  work up for review: `id`, full `headSha`, `treeSha` (content identity),
  `branch`, `createdAt`, `sourceProfileId`, and `kind`.
- **`kind: "delivered" | "verified"`** (R19-8, :462-473) — `delivered` is a
  commit a delivering run produced. `verified` is a **verification revision**:
  the default-branch head a reviewer judged on a task that has *nothing to
  deliver*, minted at verdict time so the verdict has a subject to bind to. A
  verification revision never carries a task branch (`branch: null`).
  **ABSENT reads as `delivered`** — test it as `=== "verified"`, never as
  `!== "delivered"`.
- `reviewVerdictSchema` **:481-493** — one reviewer's verdict bound to the
  `revisionId` it judged. A verdict on an OLD revision is automatically stale.
- `nextWorkRevision(current, input)` **:795-827** — a head with the same tree
  (or same head when the tree is unavailable) is the SAME review subject → no
  new revision, prior verdicts survive. A different tree mints a new id → every
  prior verdict goes stale automatically. It has ONE caller (a delivering run's
  reconcile), so everything it mints is stamped `kind: "delivered"` (:823); the
  `verified` revision is minted elsewhere, at verdict time
  (`recordAgentCompletion`).

`ReviewState` (**:576-586**) is the minimal review-relevant slice the pure
helpers take. It has **two optional fields**: `noChanges?: boolean` (R19-8) and
**`acceptance?: "forced" | null`** (N20-14, :583-585, NEW this pass).

Derivation helpers (pure, testable):

- `currentVerdicts(fm)` **:595** — verdicts bound to the current revision.
- **`deriveValidation(fm)` :608-659** — recomputes the `validation` cache. Read
  the arm ORDER; it is load-bearing and heavily commented:
  1. no `workRevision` ⇒ `none` (:611);
  2. any required reviewer `request_changes` on the current revision ⇒
     `failing` (:616);
  3. `required.length > 0` and every required reviewer approved ⇒ `healthy` (:619);
  4. **`fm.acceptance === "forced"` ⇒ `bypassed`** (**:656**, NEW — N20-14);
  5. `fm.noChanges && required.length === 0` ⇒ `none` (:657, F19-27);
  6. otherwise `changed` (:658).

  The `bypassed` arm sits **after** the two real-verdict arms on purpose: a
  reviewer who actually approved or requested changes is EVIDENCE and must not
  be erased by the bypass fact. Only the genuinely moot pending case yields.
  Without this arm a force-accepted, Done task re-derived "awaiting verdict" on
  every surface that renders the validation pill.
- `acceptanceBlockedReason(fm)` **:672-698** — the verdict gate as
  reason-or-null. Its "No reviewed revision yet" refusal names the escape route
  ("If this task requires no changes, run delivery once to verify and record
  that", :682-685) — the F19-21 dead end.
- **Five** reason-or-null guards, each one guard for many call sites:
  `closedPrBlockedReason` **:716** (PR closed unmerged = out-of-band rejection),
  `conflictingPrBlockedReason` **:737**, `archivedTaskBlockedReason` **:756**
  (restore before accepting), `archivedTaskMoveBlockedReason` **:775** (F19-8 —
  archived tasks cannot be moved between stages either), plus
  `acceptanceBlockedReason` itself.

**The live no-change gate lives outside the schema.** `noChanges` is a *claim
about a moment that has passed*, so a sixth gate re-establishes it with a LIVE
read before any writer closes a task to Done:
`app/server/tasks/no-change-completion.server.ts` (R19-8, extended by R20-2)
holds the whole contract — `noChangeApplies` (pure, **:69**),
`noChangeCandidate` (**:79**), `probeNothingToDeliver` (**:107**),
`acceptanceNoChangeCheck` (**:280**), `assertVerifiedNoChangeStillApplies`
(**:339**) and the one shared `noChangeCompletionEvent` (**:361**). It **fails
closed**: "we could not look" is never "there is nothing there". Verification
basis is one of `no_repo` / `no_branch` / `branch_empty`, with the base branch +
base sha it checked.

**R20-2 (F20-6) changed the acceptance path itself**: `acceptCompletion`
re-verifies the ACTUAL branch state under the lock and, when the server proves
the branch is empty/missing, **writes `noChanges = true` into the frontmatter**
before deriving validation
(`app/server/tasks/task-actions.server.ts:6076-6078` —
`if (noChange.applies && noChange.autoDetected) parsed.frontmatter.noChanges = true;`).
Without that, a task closed as "no changes" while its frontmatter said
otherwise and every later reader re-derived the pre-acceptance answer.

### 2.4 PR / branch model — `prRefSchema` :319-354

`pr` is the reconciler's cache of GitHub state (not human truth): `number`,
`state` (PrState, tolerant `.catch("review")`, see the note at :324), `title`,
and OPTIONAL keys where an absent key means "never read" (distinct from a
known-false): `checks` (`prChecksSchema` :309-317), `review` (PrReviewState),
`mergeable` (PrMergeable), `revisionDrift {aheadBy, headSha}` (R17-1: the PR
head is strictly ahead of the reviewed revision — extra commits ship
unreviewed; surfaced at accept), and a loose `humanApproval` slot
(`PR_HUMAN_APPROVAL_KEY = "humanApproval"`,
`app/server/github/pr-human-approval.server.ts:75` — R19-B: a project member's
GitHub approval counts as the approving verdict; schema + derivation at
:43-181, gate reason at :306).

`branch` is a top-level string (:531). `github` (`githubCacheSchema` :359-378)
caches commits + change stats + `unownedPr` (a collision PR on the branch,
recorded once).

`PrState` has ONE canonical pill map — `prStatePill` in
`app/features/github/github-pills.ts`.

### 2.5 Packets vs recommendations vs schedules vs noChanges vs acceptance

- **Packet** (`taskPacketSchema` **:413-438**) — the ONE pending decision.
  `type` input|blocked, `kind` label, `observations[]` (`packetObservationSchema`
  :381-387), `options[]` (each a `PacketOptionKind` — **dispatch on `kind`,
  never the English title**; `packetOptionSchema` :390-410, carrying optional
  `ev` pre-authored timeline text, `backend`/`profileId` for
  `retry_other_backend`, and `deleteBranch` for `archive_task`). `id` for
  replacement-safety (:415-419), `awaiting: "goal_edit"` (:429-431),
  `askedBy` (R15-14: the profileId of the agent that raised the question —
  resolving resumes that agent's own session, :432-436).

  **R20-1 (F20-5) rewrote packet resolution semantics.** In
  `resolvePacket` (`task-actions.server.ts:4621`):
  - EVERY settled decision consumes the packet approval —
    `markTaskPacketApprovalRead` is now unconditional (**:5096**), because the
    only kind that leaves the packet open is `edit_goal` (awaiting the goal),
    which is a made decision too.
  - EVERY settled decision **re-queues the operator**, except the documented
    `NO_REQUEUE` set (**:5101-5108**): `accept_completion` (task is Done),
    `archive_task` (left the board), `edit_goal` (packet still open),
    `hold_runtime_debug` (human asked for no run), `retry_other_backend`
    (starts its own run), `discard_branch` (cleanup only).
  - A manual "Run operator" while a packet is open is **refused, not paid for**:
    `refused: "open-packet"` (`operator-run.server.ts:1032`, the union at :222).
  - The operator gains a `packet-resolved` trigger carrying
    `resolvedOption {kind, title, note?}` (`operator-run.server.ts:139-157`,
    handled at :2699).
- **Recommendations** (`recommendationSchema` **:191-204**) — a supervised
  operator RECOMMENDS an action; each renders as a one-click card. A task can
  hold several at once (distinct from the single packet). `delivery` (R15-2) and
  `accept_completion` are the governance-heavy kinds.
- **Schedules** (`scheduleSchema` **:229-254**) — a governed future operator
  re-run (O-3). Lifecycle `pending → claimed → fired | failed | cancelled`.
  `claimedAt` reserves an occurrence before the detached enqueue so a crash is
  recoverable; `retries` bounds it. Never fires on a terminal (Done) task.
  Server-side runner (`app/server/tasks/schedule.server.ts`) → backend-agnostic.
- **`noChanges`** (**:552**, optional) — R17-2 + R19-8 + R20-2: this task
  completes with NOTHING to deliver. Acceptance of a `workRevision && !pr` task
  is normally refused ("deliver the branch & open the PR"); this flag turns that
  refusal into a first-class "Completed — no changes" close-to-Done. **Three
  producers now**: (1) a delivery attempt that found the branch empty
  (`performDelivery`'s `nothing_to_review` outcome, `task-actions.server.ts:3563`
  and its outcome union at :3549); (2) a reviewer approving a task that never
  needed a branch (`recordAgentCompletion`, which also mints the
  `kind: "verified"` revision); (3) **NEW (R20-2)** the accept path itself when
  it proves the branch empty (`task-actions.server.ts:6076`). Cleared the moment
  a delivery opens a real PR.
- **`acceptance`** (**:559**, `z.enum(["forced"]).nullable().optional()`) —
  **NEW this pass (N20-14).** A durable record that this task reached Done
  through a **force-accept**: the human deliberately bypassed the verdict gate.
  Written by exactly one line —
  `app/server/tasks/task-actions.server.ts:6084`
  (`if (input.forced) parsed.frontmatter.acceptance = "forced";`), set BEFORE
  `deriveValidation` runs on the next line. Reached through
  `forceAcceptCompletion` (**:6311**), which is `force-accept-completion`-gated
  RBAC, audits `task.acceptance.forced` with the exact bypassed gate, and
  refuses the one irreducible gate (`forceIrreducibleRefusal`) before writing
  the audit row.

### 2.6 Frontmatter key list (23 keys) + other fields

`TASK_FRONTMATTER_KEYS` (**:829-855**), in file order:

```
key · title · stage · readiness · waiting · ownerUserId · engagements ·
operator · recommendations · schedules · urgent · archived · validation ·
workRevision · verdicts · branch · pr · noChanges · acceptance · github ·
createdAt · updatedAt · boardRank
```

That is **23** (pass 20 recorded 22 — `acceptance` is the addition, at :850).
`repo` is deliberately NOT listed (P13-D-5, one project one repo): an existing
`repo:` line is an unknown key, preserved verbatim, ignored (:532-536).

Field notes: `key` (regex `^[A-Za-z]+-\d+$`, :503), `stage` (an unresolvable
stage → blank marker + `unresolved_stage` warning at :1065-1085; the card lands
in the board's orphan bucket, NOT a hardcoded `triage`), `operator`
(`operatorRefSchema` :159, stores `assignedAtStageId`), `archived` (**R14-3**
terminal disposition: leaves board default view + review queue, keeps timeline,
restorable, :517-522; also blocks stage moves since F19-8), `boardRank` (sparse
rank for drag-reorder; null → task-key number, :563-565).

### 2.7 Timeline + actor refs

`TaskFileEvent` **:1368-1382** (newest-first): `occurredAt`, `type`, `actor`
(`FileActorRef` **:1276-1287**: human `user:<id>`, agent
`agent:<backend>/<profileId>`, operator, system, or tolerant `unknown`
round-tripped verbatim), `title`, RichText `text`, `toAgent`, `evidence`
(`EvidenceRow[]` **:1301-1305** — a reference, not a dump).
`EVIDENCE_MAX_ROWS = 8` (**:1309**), `EVIDENCE_EMPTY_COLUMN = "—"` (**:1321**),
`normalizeEvidenceRows` (**:1338**, one row per line, `label · add · del`).

**The file union has 5 actor kinds; the projection column has 4.**
`task_events.actor_kind` CHECKs `('human','agent','operator','system')`
(`0001_baseline.sql:151`), and the rebuilder collapses `unknown → system` so a
tolerantly-kept unrecognized author still appears in every feed rather than
being dropped; the render side mirrors it with an "Unknown actor" system chip
(`app/shared/mapping/actor.server.ts`).

**R19-19 evidence linkify**: an evidence `label` whose tokens name a *real*
attachment filename renders as a link to the member-only attachment route
(`EvidenceLabel`, `app/features/task-detail/timeline.tsx:111`, wired at :236-239
with the `attachmentsBase` prop threaded from
`app/routes/project.task.tsx:931`). The schema is untouched — the label is still
a plain string; the linkify is a render-time join against the task's actual
attachment names (§6).

---

## 3. project-file schema (`app/schemas/project-file.schema.ts`, 455 lines)

> Verified 2026-08-19 against `app/schemas/project-file.schema.ts`.
>
> **Shape unchanged since pass 18 — but the FILE was refactored in `ce2bc9e`
> (anti-slop lint) and EVERY anchor moved.** Each frontmatter field's validator
> was hoisted into its own named `const` (:171-194) so the tolerant parse can
> reach it, `isRecord` was replaced by a `rawFrontmatterSchema`
> (`z.record(z.string(), z.unknown())`, :238), and `tolerant`/`tolerantArray`
> take `(data, path)` instead of a pre-extracted value. No field, enum or
> default changed. The pass-20 doc's claim that this file is "byte-identical
> since pass 18" is now false.

`projectFrontmatterSchema` at **:196-210**; key list `PROJECT_FRONTMATTER_KEYS`
at **:213-227** (13 keys); `ParsedProjectFile` = frontmatter +
unknownFrontmatter + description (**:247-252**).

- `name`, `slug` (regex `^[a-z0-9][a-z0-9-]*$`), `archived?` (R6-3 read-only),
  `repo` (`owner/name`, nullable — the sole repo, no task override, :180-183),
  `defaultBranch`, `taskPrefix` (`^[A-Za-z]+$` → `VIB-142`), `nextTaskNumber`
  (atomic per-project counter).
- `stages[]` (`stageSchema` **:40-48**: id, name, color — hex or `var(--*)`) —
  an empty list is a `project.no_stages` error (**:440**).
- `workflow[]` (`workflowBoundarySchema` **:50-60**) — `from`/`to`/`boundary`
  (`BOUNDARY_VALUES` = auto|approval|human, **:28**)/`by`/`locked`.
  `review→done` is locked `human` in V1, enforced server-side.
- `members[]` (`memberSchema` **:62-67**: userId + `ProjectRole`).
- `agents[]` (`agentDeploymentSchema` **:128-141**) — per-project deployment of
  an org template: `profileId`, `capabilities[]` (`capabilityGrantSchema`
  **:69-75**, `capabilityId` + `CapabilityMode`), `extras[]` (bespoke labels
  with no catalog id), and an optional loose `definition` override
  (`agentDeploymentDefinitionSchema` **:85-118** —
  kind/name/role/icon/backends/model/effort/scope/desc/persona/stages/spanAll/
  `autonomy` for operators/`resources{skills,mcps,kb}`). This is the SINGLE
  source for the deployment-definition shape; `agents-query` re-exports the type.
- `credentialPolicy` (**:146-152** — credentialLabel/masked/requiredScopes; the
  PAT itself is AES-encrypted in SQLite, never in files), `guardrails[]`
  (**:155-163** — id/desc/on/value/unit).

### 3.1 Project roles / capability modes

`PROJECT_ROLES` = `admin`, `maintainer`, `contributor`, `viewer` (**:23**; note
`contributor` was formerly `reviewer` — renamed to drop a misleading label).
`CAPABILITY_MODES` = `direct`, `recommend`, `human`, `off` (**:35**). These feed
RBAC-GOVERNANCE.md.

### 3.2 Capability catalog (`app/shared/capabilities.ts`, 473 lines)

`capabilities[].capabilityId` is a **persisted key** in every `project.md`, so
ids never get renamed (see the `assign-primary-specialist` note — the *label*
moved to "Assign the delivering agent", the id did not).
`UNIFIED_CAP_CATALOG` at **:33-137**; flat id+label view `CAP_CATALOG` at
**:189**.

Notable entries and sets:

- **`use-browser`** — "Drive a live web browser" (R19-19, **:111**). Kind
  `agent`, group `Collaboration`, **`defaultMode: "off"`**. In
  `ENFORCED_CAPABILITY_IDS` (**:206-241**, entry at **:240**) — enforcement is
  the **MOUNT**: granted ⇒ a viberr-owned Playwright MCP server joins the run's
  `mcpServers` on both backends; withheld ⇒ the tool surface does not exist. The
  mount additionally requires *effective* `use-web-search-fetch: direct` — the
  browser IS network egress (`resolveBrowserMcp`,
  `app/server/tasks/specialist-browser-mcp.server.ts:100`, the interlock at
  **:113-121**); the contradictory pair is **surfaced** through the P14-LV-09
  disclosure pipe, never resolved silently.
- `ALWAYS_HUMAN_CAPABILITY_IDS` (**:194-198**): merge-pull-request,
  transition-to-done, change-project-policy.
- `CLAUDE_ONLY_ENFORCED_CAPABILITY_IDS` (**:250**) + `capabilityEnforcement(id)`
  (**:263**) → `"both" | "claude-only" | "advisory"`.
- `defaultGrantsFor(kind)` (**:148**) vs `conservativeGrantsFor(kind)`
  (**:175**) — the latter withholds `execute-code-or-write-repo`,
  `SCOPED_DELIVERY_CAPABILITY_IDS` (**:346**) and
  `VERDICT_OUTCOME_CAPABILITY_IDS` (**:279**). `capabilities: []` does NOT mean
  "no powers" (P13-AP-06) — every creation path persists explicit grants.
- **`coerceSpecialistCapabilityMode` (:337-341) INVERTED this pass (R20-6 /
  F20-21).** It used to widen a specialist's `recommend` grant **up to
  `direct`** silently; it now normalizes **down to `off`** (withheld, the safe
  direction), at both the write path and the display read. The seed was made
  honest at the same time (`app/server/seed/agent-catalog.server.ts` writes
  `direct`, never `recommend`, for specialist grants). **Re-introducing a
  `recommend → direct` transform here is the F20-21 regression.** The operator
  keeps its real `recommend`.
- Reserved MCP names — `viberr`, `viberr_agent`/`viberr-agent`,
  `viberr_browser`/`viberr-browser` — are refused at save AND skipped by the
  resolver: `isReservedMcpName` (`app/server/org/resources.server.ts:1289`) and
  `RESERVED_MCP_NAMES` (`app/server/tasks/specialist-mcp.server.ts:84`, applied
  at :163).

---

## 4. Readiness enum + interpretation

> Verified 2026-08-19 against `app/server/interpretation/`.

The stored `readiness` is one of the 4 canonical values, but the UI reads a
**DERIVED** readiness computed by
`app/server/interpretation/readiness-policy.server.ts` (`deriveReadiness`
**:36**, `isAcceptedDisplayState` **:55**) and projected into
`task_projections.readiness`, with the raw file value kept in
`stored_readiness`. Severity→floor mapping and ranking live in
`diagnostics-policy.server.ts` (`READINESS_RANK` **:20**, `readinessEffectOf`
**:28**, `worstReadinessEffect` **:41**, `referenceDiagnostics` **:58**);
freshness in `freshness-policy.server.ts`. Derivation is confined to this
directory — see ARCHITECTURE.md §3.

---

## 5. The SQLite schema (`db/migrations/0001_baseline.sql`, 482 lines)

> Verified 2026-08-19 against `db/migrations/0001_baseline.sql` (the **only**
> file in `db/migrations/`) and `app/server/db/migration-runner.server.ts`.

**Still one squashed migration.** While pre-prod, schema changes are squashed
INTO the baseline and a schema change means wipe + re-seed
(`npm run seed -- --reset`), because the runner records and skips by **FILENAME
alone** (`runMigrations`, `migration-runner.server.ts:28`, tracking table
created at :33). There is no drift healer — an existing DB keeps its old schema
and every projection write touching a new column throws. The convention is
stated at `0001_baseline.sql:10-19`. **All five pass-20 schema changes rode it.**

### 5.1 Full table inventory

**Projection tables** (derived from files; dropped + rebuilt by
`rebuildProjections`):

| Table | Line | Notes |
| --- | --- | --- |
| `projects` | **:49-65** | slug PK, name, archived, repo, default_branch, task_prefix, description, stages_json, workflow_json, agent_policy_json, credential_policy_json, guardrails_json, source_path, content_hash, parsed_at |
| `project_members` | **:66-71** | (project_slug, user_id) PK; role CHECK `admin|maintainer|contributor|viewer`; CASCADEs off `projects` |
| `task_projections` | **:72-142** | see §5.2 |
| `task_events` | **:143-160** | id AUTOINCREMENT, position (0 = newest), occurred_at, type, `actor_kind` CHECK `human|agent|operator|system`, actor_ref, actor_json (denormalized render shape), title, text, to_agent, evidence_json |
| `diagnostics` | **:161-172** | severity CHECK `info|warning|error`, code, path, message, hard_stop, observed_at |
| `provenance` | **:173-181** | source_path, content_hash, observed_at, action (`projected|removed|error|rescan`), details_json |

**Canonical SQLite tables** (NOT projections — this is the data class the F18-5
dual-writer bug silently ate; `rebuildProjections` preserves them):

| Table | Line | Notes |
| --- | --- | --- |
| `users` | **:23-36** | id, email, name, title, role CHECK `admin|member`, idp, avatar_tone, pwreset_required, theme CHECK `light|dark|system`, disabled, timestamps, last_login_at, created_by, github_handle |
| `audit_events` | **:37-48** | occurred_at (NOT `created_at`), actor_user_id, actor_label, action, subject_kind/id, project_slug, task_key, details_json |
| `notifications` | **:182-196** | `kind` CHECK `('packet','approval','mention','quality','policy')` (**:185**, still 5); `ptype` CHECK `input|blocked`; read_at |
| `user_prefs` | **:197-203** | (user_id, key) PK, value_json |
| `github_pats` | **:204-213** | encrypted_token + token_suffix, validation_json |
| `project_github_credentials` | **:214-219** | project_slug PK → pat_id |
| `scope_violations` | **:220-230** | status CHECK `open|resolved`; partial unique index on open rows (:443) |
| `github_connections` | **:231-240** | id = slugify(owner), owner UNIQUE, pat_id, is_default, repos_count, expires_at |
| `oauth_providers` | **:247-256** | provider PK CHECK `github|google`, client_id, client_secret (**sealed box**), enabled, verified_at, verified_detail |
| `google_domain_allowlist` | **:257-262** | normalized `@company.dev`, role CHECK `admin|member` |
| `org_knowledge_bases` | **:263-272** | dir UNIQUE (folder under `${DATA_ROOT}/kb/`), refresh CHECK `manual|on change|nightly`, last_indexed_at |
| `org_mcp_servers` | **:273-304** | see §5.3 — **two new columns this pass** |
| **`model_availability`** | **:312-319** | **NEW this pass** — see §5.4 |
| `org_skills` | **:320-326** | name UNIQUE (folder `${DATA_ROOT}/skills/<name>/`), summary |
| `agent_runs` | **:327-369** | see §5.5 |
| `run_log_lines` | **:370-378** | run_id → agent_runs CASCADE, seq, raw_json, display_json |
| `staged_outcomes` | **:477-481** | outcome_key PK, outcome_json, created_at (P11-28 — the Claude `report_outcome` envelope, staged mid-run) |
| better-auth `user` / `session` / `account` / `verification` | **:406-420** | hand-inlined `@better-auth/cli@1.6.25 generate` output; the refresh recipe is at :390-405. `githubHandle` on `"user"` is OURS. **`verification` looks dead but is NOT** — better-auth's database state strategy writes it on EVERY OAuth sign-in (:409-419) |

Indexes are at **:424-468**. Two are load-bearing:
`idx_scope_violations__open_unique` (**:443-445**, partial on `status='open'`)
and **`idx_agent_runs__one_delivering`** (**:462-464**, partial unique on
`(project_slug, task_key) WHERE kind='primary' AND state IN ('queued','running')`
— F10-05: the DB-layer enforcement of one active delivering run per task;
`startRun` translates the constraint violation into a 409).

### 5.2 `task_projections` (`:72-142`) — the board/queue/inbox read model

One row per task, PK `(project_slug, task_key)`.

| Column | Line | Source | Note |
| --- | --- | --- | --- |
| `readiness` | :78 | DERIVED (readiness-policy) | what the UI reads; CHECK on the 4 values |
| `stored_readiness` | :81 | raw file value | NULL when missing/invalid |
| `waiting` | :82 | frontmatter | CHECK `human|agent|none` |
| `urgent` | :83 | frontmatter | |
| `archived` | :87 | frontmatter | R14-3 — so board/queue hide archived without re-reading files |
| `validation` | :88 | `deriveValidation(fm)` | **CHECK is still the 4 values `('healthy','changed','failing','none')`** — see the WARNING below |
| `validation_block_reason` | :93 | `acceptanceBlockReason` | NULL when acceptance-ready |
| **`acceptance`** | **:98** | frontmatter `acceptance` | **NEW (N20-14)** — `CHECK (acceptance IN ('forced'))`, NULL otherwise. The durable acceptance-override fact, projected so the hero/card display arm reads it without a file read |
| **`continuity`** | **:110** | DERIVED from the timeline | **NEW (D4)** — `CHECK (continuity IN ('degraded'))`. `'degraded'` when this task's timeline carries a `continuity` event. Persistent by design |
| `owner_user_id` | :111 | frontmatter | |
| `specialist_json` / `reviewers_json` | :112-113 | derived from `engagements[]` | the delivering / supporting split |
| `operator_json`, `branch`, `pr_json`, `github_json` | :114-122 | frontmatter | denormalized |
| `repo` | :120 | `project.repo ?? null` | denormalized onto every task (P13-D-5: no override) |
| `goal`, `packet_json` | :123-124 | parsed body | |
| `recommendation_count` | :128 | `recommendations.length` | so notification reconcile needs no file read |
| `schedules_json` | :132 | `schedules[]` | the schedule runner queries this for due entries |
| `event_count` / `comment_count` / `diagnostic_count` | :133-135 | counts | |
| `source_path`, `content_hash`, `parsed_at` | :138-140 | | the content-hash short-circuit key |
| `board_rank` | :140 | frontmatter `boardRank` | REAL; sparse rank for drag-reorder |

> **⚠ Live inconsistency worth knowing before you touch validation.** The
> `validation` CHECK constraint at **`0001_baseline.sql:88`** still lists only
> the four original values — it was NOT widened when `bypassed` joined
> `VALIDATION_VALUES` (`task-file.schema.ts:42`). The rebuilder writes
> `derivation.validation` into that column
> (`rebuilder.server.ts:495-546`), so a force-accepted task whose
> `deriveValidation` returns `"bypassed"` will hit the CHECK. If you are fixing
> anything in this area, verify the constraint against the enum first; the
> honest fix is to widen the CHECK in `0001_baseline.sql` (and re-baseline —
> there is no ALTER path), not to special-case the writer.

`workRevision.kind` and `noChanges` are **not** their own columns — they reach
the read model through `validation` / `validation_block_reason`, recomputed from
them on every write. `acceptance` and `continuity` ARE columns, precisely
because the display arms need them without a file read.

The rebuilder's UPSERT is one statement at **`rebuilder.server.ts:493-560`**
(column list :495-497, `ON CONFLICT` updates :505-511 incl. `acceptance` :510
and `continuity` :511, bound values from :539 — `fm.acceptance ?? null` at :544,
`continuity` at :546). `continuity` is derived just above, at **:487-489**:
`parsed.timeline.some((e) => e.type === "continuity") ? "degraded" : null`.

### 5.3 `org_mcp_servers` (`:273-304`) — two new columns this pass

Existing: `id`, `name` UNIQUE, `transport` CHECK `HTTP|stdio`, `target`
(endpoint or command), `cred_ref` (a `secret://`-style sealed reference only),
`tools_count`, `up` (1 up · 0 down · NULL never probed), `last_checked_at`,
`warming_since` (**:286**, R19-18), `last_error` (**:290**, R19-17).

**NEW (R20-4 / N20-2):**

- **`first_success_at`** (**:295**) — when this server first answered a probe
  successfully (ISO). NULL means it has never worked here, which is what makes a
  timeout on an npx/uvx-style command a plausible **first-run INSTALL** rather
  than a broken server. Stamped idempotently with `COALESCE`, never cleared
  (`mcp-warmup.server.ts:98`).
- **`heuristic_warmups`** (**:301**, `INTEGER NOT NULL DEFAULT 0`) — how many
  times the HEURISTIC (stderr said nothing install-y, but the command IS an
  installer and the row has never succeeded) armed a background warm-up.
  **Capped at 1** so a command that times out on EVERY probe still settles to
  `unreachable` instead of re-downloading forever. Incremented at *arm* time
  (`mcp-warmup.server.ts:75-79`, only when `options.heuristic`), and rolled back
  by `reapStaleWarmups` with `MAX(0, heuristic_warmups - 1)`
  (`mcp-warmup.server.ts:159`) because a warm-up a restart killed never got its
  15 minutes.

Supporting code: `isFirstRunInstallerCommand(argv)`
(`app/server/org/resources.server.ts:946` — matches `npx`/`bunx`/`uvx`/`pipx`,
`pnpm|yarn|bun dlx|x`, `uv tool`, **on argv, never the raw string**);
`StdioDiscoveryFailure.firstRunInstaller` (:908-911 — the probe reports it and
stays DB-free, because only the caller holds the row);
`startMcpWarmup(db, input, {heuristic})` (`mcp-warmup.server.ts:62`,
`WARMUP_CAP_MS = 15 min` at :35); `reapStaleWarmups` (:141, run at boot).

### 5.4 `model_availability` (`:312-319`) — NEW table (R20-3 / F20-4)

```sql
CREATE TABLE model_availability (
  backend    TEXT NOT NULL CHECK (backend IN ('claude','codex')),
  model      TEXT NOT NULL,
  reason     TEXT NOT NULL,        -- the provider's own redacted sentence
  marked_at  TEXT NOT NULL,
  run_id     TEXT,                 -- the run that proved it
  PRIMARY KEY (backend, model)
);
```

Org-level and unscoped (like `org_mcp_servers`): the credential is a deployment
fact, not a project one. The contract (comment at :305-311, module doc at
`app/server/runtimes/model-availability.server.ts:6-23`):

- **Presence of a row = unavailable.** **Absence = unknown-but-offered**, never
  "proven available" — a claim the app cannot make (ruling 19: chips render
  proven verdicts only).
- Written ONLY from a REAL run's failure whose redacted text matches
  `MODEL_UNSUPPORTED_RE` (**:30-31**:
  `/model is not supported|model .*(?:does not exist|not found|unavailable)|unknown model|invalid model/i`).
  **Never written by a synthetic probe.**
- Cleared by a real run's SUCCESS (`clearModelMark` **:57**).

API: `markModelUnavailable` (:34, upsert — newest failure's sentence wins),
`clearModelMark` (:57), `unavailableModels` (:79),
`noteModelAvailabilityFromFailure` (:106, gated on the regex at :117).

Wiring: `task-actions.server.ts:2521` (mark) / `:2582` (clear),
`operator-run.server.ts:2190` (mark) / `:2112` (clear),
`model-catalog.server.ts:337` (catalog reads the marks),
`app/features/agents/agents-query.server.ts:473-474` (the profile modal disables
a marked model with its reason).

The provider's own sentence is scrubbed by **`redactProviderText`**
(`app/server/secrets/git-output-redact.server.ts:136`, `PROVIDER_TEXT_CHARS = 240`
at :135) — it walks up to 3 levels of `Error.cause`, runs the shared
`redactGitOutput` scrubber, and keeps the LAST non-empty line (the provider
states its verdict at the tail).

**Seed half (R20-8):** the seeded Developer's default Codex model is now
`gpt-5.6-terra` (was `gpt-5.6-sol`, which a ChatGPT-account Codex refuses) —
`app/server/seed/agent-catalog.server.ts`.

### 5.5 `agent_runs` (`:327-369`) — read the `kind` comment

`kind TEXT NOT NULL CHECK (kind IN ('operator','primary','reviewer'))` is **NOT
a role taxonomy — it is the DELIVERY axis**, and the three values no longer mean
what their names suggest (**:332-342**): `operator` is the operator runtime's
own run; every other run is a generic agent engagement, tagged `primary` when
that engagement DELIVERS and `reviewer` when it merely supports
(`kind: delivers ? "primary" : "reviewer"`). **So a non-delivering developer is
stored as `reviewer`.** The engagement's real role rides the `role` column.
`idx_agent_runs__one_delivering` reads correctly *because* `primary` means
delivering.

Also: `outcome_key` (**:368**) is the staging key for a Claude `report_outcome`
envelope in `staged_outcomes`, persisted so boot recovery can look the staged
outcome up after a restart.

### 5.6 Typed projection events (unchanged — 8 variants)

`ProjectionEvent` (`app/server/events/projection-events.server.ts:11-43`) is a
**closed** typed union of **8** variants routed by user/project/task scope:
`task.updated`, `task.removed`, `project.updated`, `project.removed`,
`projection.rebuilt`, `notification.created`, `notification.read`,
`violation.updated`. **Nothing was added this pass either**, and that is
load-bearing: the MCP warm-up state settles by a 20 s poll on the settings page
precisely because an org-settings row fits none of these three scopes.

The wire union is separate and wider: `SSE_EVENT_NAMES`
(`app/schemas/sse-event.schema.ts:22-40`) holds **12** names — the 8 above plus
`run.log-appended`, `run.state-changed`, `stream.open`, `stream.resync`; the
discriminated `sseEventSchema` is at :49-150.

### 5.7 Rebuild entry points (anchors moved again)

- `reprojectTask(db, ctx, slug, key)` lives in
  **`app/server/tasks/task-mutation.server.ts:114`** — not `task-actions`. That
  module is a deliberate **cycle break**: `agent-toolkit` needed
  `loadProjectContext` (:78) / `taskRef` (:101) / `reprojectTask` (:114) and
  importing them from `task-actions` closed
  `specialist-run → agent-toolkit → task-actions ⇢ specialist-run`, whose hidden
  dynamic edge produced a half-evaluated namespace and a silently swallowed
  `retry_other_backend`. `task-actions.server.ts` re-exports all three.
- `app/server/projections/rebuilder.server.ts`: `rebuildProjectFile` **:150**,
  `rebuildTaskFile` **:348**, `rebuildPath` **:655** (the watcher + mutation
  entry point), `rebuildProject` **:695**, `rebuildAll` **:779**. Content-hash
  short-circuits at **:184** (project) and **:393** (task).
  `acceptanceBlockReason` (the projected gate, which mirrors
  `acceptanceRefusalReason` in `task-actions`) is at **:312-346**.

---

## 6. Task attachments — a third store (R19-19)

> Verified 2026-08-19 against `app/server/files/task-attachments.server.ts`,
> `app/server/files/file-store-root.server.ts`, `app/routes/task-attachment.ts`.

Not a file schema and not a projection: **the directory is the truth.** No
projection table, no upload path, no retention machinery.

- Location: `projects/<slug>/tasks/<KEY>/attachments/` — `taskAttachmentsDir`
  (`file-store-root.server.ts:87`), documented in the layout block at :5-23.
  Inside the task dir on purpose, so archive/delete flows move attachments with
  the task.
- One writer today: the browser MCP server's `--output-dir`
  (`specialist-browser-mcp.server.ts:137-138`). **Live-verified quirk**:
  default-named screenshots land in the output dir; self-named ones resolve
  against the child cwd (the run workspace), because the SDK's stdio config
  carries no `cwd`. The persona steers to default naming and says so.
- Read side: `listTaskAttachments` (**:35**, newest-first, `LIST_CAP = 100` at
  :33, skips dotfiles, tolerates a raced unlink), `resolveTaskAttachment`
  (**:67**, through the traversal-refusing `resolveStoreSegment`),
  `INLINE_TYPES` (**:78**) + `attachmentContentType` (**:91**).
- Serving: `GET /projects/:slug/tasks/:key/attachments/:file`
  (`app/routes.ts:49-53` → `app/routes/task-attachment.ts`). **Project
  membership** is the bar (`requireProjectMember`, :33 — same as
  `/resources/run-log`); traversal is a plain **404** with no oracle (:39-47);
  `MAX_ATTACHMENT_BYTES = 50 MB` (:29) → 413; every response carries
  `X-Content-Type-Options: nosniff` (:63) + `Content-Security-Policy: sandbox;
  default-src 'none'`; only whitelisted types render inline and **HTML/SVG/JS
  never do** (they download as `application/octet-stream`) — a stored page served
  on the app origin with the viewer's session attached is stored XSS.
- UI: `app/features/task-detail/attachments-panel.tsx:22` (newest-first, renders
  **nothing at zero**), gated on `runsVisible` at
  `app/routes/project.task.tsx:259-260`, with `attachmentsBase` passed at :931;
  plus the evidence linkify in §2.7.

---

## 7. Delta (pass-20 doc → pass 21)

Everything below landed **after** the pass-20 doc's `b97ad02` baseline, i.e. in
the pass-20 merge (`6c94f2c`, PR #169) and the two lint commits.

**`task-file.schema.ts`:**

| Change | Ruling | Anchor |
| --- | --- | --- |
| `VALIDATION_VALUES` gained **`bypassed`** (4 → 5) | N20-14 | :42 |
| `PACKET_OPTION_KINDS` gained **`discard_branch`** (9 → 10) | R20-2 / F20-6 | :93-99 |
| Frontmatter gained **`acceptance: "forced" \| null`** | N20-14 | :559 |
| `TASK_FRONTMATTER_KEYS` 22 → **23** | N20-14 | :850 |
| `ReviewState` gained optional `acceptance` | N20-14 | :583-585 |
| `deriveValidation` gained the `bypassed` arm, placed after the real-verdict arms | N20-14 | :656 |
| `noChanges` gained a **third** producer (the accept path itself) | R20-2 | `task-actions.server.ts:6076` |

**`project-file.schema.ts`:** no shape change; the file was **refactored**
(named per-field schemas, `rawFrontmatterSchema`, new `tolerant` signature) and
**every anchor moved** — `ce2bc9e`.

**SQLite baseline (`0001_baseline.sql`), still one file:**

- NEW column `task_projections.acceptance` (:98) — N20-14.
- NEW column `task_projections.continuity` (:110) — D4.
- NEW columns `org_mcp_servers.first_success_at` (:295) and `.heuristic_warmups`
  (:301) — R20-4 / N20-2.
- NEW table `model_availability` (:312-319) — R20-3 / F20-4.
- Not changed: the `validation` CHECK (see the ⚠ in §5.2), `notifications.kind`
  (still the same 5), the better-auth block, the index set.

**Capabilities:** `coerceSpecialistCapabilityMode` inverted from
`recommend → direct` to `recommend → off` (R20-6 / F20-21,
`capabilities.ts:337`).

**Unchanged, re-verified at `ce2bc9e`:** `TIMELINE_EVENT_TYPES` (11),
`RECOMMENDATION_KINDS` (7), `READINESS_VALUES` (4), `PROJECT_ROLES` (4),
`CAPABILITY_MODES` (4), `PROJECT_FRONTMATTER_KEYS` (13), the tolerance contract,
the engagement model, the work-revision/verdict model, `ProjectionEvent` (8),
`SSE_EVENT_NAMES` (12), `notifications.kind` (5), the attachments store.

---

## Corrections vs pass-20 doc

1. **Its baseline (`b97ad02`) predates pass 20's own merge.** It is a pass-20
   *discovery-time* snapshot, not a record of pass 20. Every "NEW this pass"
   item it lists is actually a pass-19 item, and none of the five schema changes
   the pass-20 work shipped appear in it.
2. **`VALIDATION_VALUES` is 5, not 4** — `bypassed` was added
   (`task-file.schema.ts:42`). Any consumer written from the pass-20 doc handles
   one value too few.
3. **`PACKET_OPTION_KINDS` is 10, not 9** — `discard_branch`
   (`task-file.schema.ts:93-99`). The pass-20 doc's "The packet-kind count is
   **nine**" is now wrong (and `file-formats-sync.test.ts` gates the new count).
4. **`TASK_FRONTMATTER_KEYS` is 23, not 22** — `acceptance`
   (`task-file.schema.ts:850`).
5. **`noChanges` has three producers, not two** — the accept path itself now
   writes it when it proves the branch empty
   (`task-actions.server.ts:6076`, R20-2).
6. **`project-file.schema.ts` is NOT "byte-identical since pass 18"** and none
   of the pass-20 doc's anchors for it hold. Correct anchors: sub-shapes
   :40/:50/:62/:69/:85/:128/:146/:155, `projectFrontmatterSchema` :196,
   `PROJECT_FRONTMATTER_KEYS` :213, `ParsedProjectFile` :247, `tolerantArray`
   :295.
7. **Every `task-file.schema.ts` anchor moved.** The pass-20 doc's
   `taskFrontmatterSchema :486-543`, `TASK_FRONTMATTER_KEYS :780-805`,
   `ParsedTaskFile :1340-1349`, `deriveValidation :579-617`,
   `acceptanceBlockedReason :630-656`, `nextWorkRevision :746-778`,
   `FileActorRef :1245-1256`, `TaskFileEvent :1323-1338` are all stale — the
   correct anchors are :502-566/:569, :829-855, :1385-1394, :608-659, :672-698,
   :795-827, :1276-1287, :1368-1382.
8. **`org_mcp_servers` has 4 state columns, not 2** — `first_success_at` and
   `heuristic_warmups` joined `warming_since` and `last_error`; and the
   `warming_since`/`last_error` line anchors it cited (`:265-269`, `:270-273`)
   are now :286 and :290.
9. **`model_availability` is missing entirely** from the pass-20 table list.
10. **`task_projections` spans `:72-142`** (not `:72-125`) and its column table
    omitted `acceptance`, `continuity`, `waiting`, `urgent`, `goal`,
    `packet_json` and the three counts.
11. **`coerceSpecialistCapabilityMode` inverted** — the pass-20 doc predates
    R20-6, so anything derived from it will assume a specialist's `recommend`
    widens to `direct`. It now narrows to `off`.
12. **The `validation` CHECK constraint was not widened with the enum** — a real
    inconsistency in the current tree, flagged in §5.2, and absent from the
    pass-20 doc because `bypassed` did not exist yet.
13. The pass-20 doc's `rebuilder.server.ts` anchors (`:618` / `:741`) are stale:
    `rebuildPath` is **:655**, `rebuildAll` is **:779**.
