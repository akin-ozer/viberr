# Code map: interpretation & decision layers (what decides what you see)

Three server layers turn task files into display state: (1) `app/server/interpretation/`
derives per-task readiness at projection time, (2) `app/server/projections/decisions.server.ts`
answers "which open decisions need THIS user", (3) `review-queue.server.ts` splits the review
boundary. Consumers (board, review queue, home, notifications) read projections, never files.

## 1. Interpretation layer — `app/server/interpretation/`

### Readiness derivation (`readiness-policy.server.ts`)
- `deriveReadiness` is documented as THE only place readiness is derived
  (readiness-policy.server.ts:8-11). Rule: stored readiness is respected unless diagnostics
  force a WORSE value; derivation never improves it (readiness-policy.server.ts:36-48).
  Missing/invalid stored readiness defaults to `ready` (readiness-policy.server.ts:41).
- Severity → floor mapping lives in `diagnostics-policy.server.ts:28-38`:
  `hardStop → blocked`, `error → inconsistency_risk_detected`, `warning → input_required`,
  `info → none`. Rank order in `READINESS_RANK` (diagnostics-policy.server.ts:20-25).
- `referenceDiagnostics` adds a **warning** (→ `input_required` floor) when the task's stage
  is not in the project stage list (diagnostics-policy.server.ts:58-75).
- `isAcceptedDisplayState` — "accepted" is a display state, never stored: true iff the task
  sits in the last stage id (readiness-policy.server.ts:55-61; falls back to literal `"done"`
  when the stage list is empty, line 59).
- `freshness-policy.server.ts:19-24` is a re-export door onto `~/shared/freshness`
  (reconcile-chip / MCP-health staleness); it does not affect task chips.

### Where derivation runs — projection rebuild (`rebuilder.server.ts`)
- `deriveReadiness` is called once per task at (re)projection (rebuilder.server.ts:362-365)
  over parse diagnostics + stage-reference diagnostics (rebuilder.server.ts:332-335); result
  stored in `task_projections.readiness` (rebuilder.server.ts:415).
- **Terminal-stage waiting normalization (LV-20)**: a task in the project's terminal stage
  projects `waiting = "none"` regardless of the file's stored value
  (rebuilder.server.ts:351-356) — this single normalization feeds every waiting-sensitive
  surface (comment at rebuilder.server.ts:346-350). The file itself is untouched.
- `validation_block_reason` is projected via `acceptanceBlockedReason(fm)`
  (rebuilder.server.ts:421): null = acceptance-ready; otherwise "no reviewed revision" /
  "requests changes" / "waiting on N required reviewer approvals"
  (app/schemas/task-file.schema.ts:540-558).

### The `waiting` flag lifecycle (who writes human/agent/none)
- Run start → `markWaitingAgent` sets `waiting: "agent"` (task-actions.server.ts:2463-2474).
- Run end → `clearWaitingToHuman` settles to `"human"`, EXCEPT terminal-stage tasks with no
  packet and no recommendations, which settle to `"none"` (task-actions.server.ts:2443-2450).
- Operator/agent actions also set it directly (e.g. packet creation → human,
  operator-actions.server.ts:420,565; resolution paths → none, task-actions.server.ts:2906).

## 2. `decisions.server.ts` — the single "waiting on you" source

`decisionsRequiring(db, userId, {projectSlug?})` (decisions.server.ts:62) is documented as THE
source every counting surface must consult (decisions.server.ts:9-15).

- **What is an open decision**: a non-archived task row with an open packet
  (`packet_json` non-empty) OR `recommendation_count > 0` (SQL at decisions.server.ts:84-96),
  in a NON-terminal stage (decisions.server.ts:103, via `isTerminalStage`,
  app/shared/workflow/stage-roles.ts:71-77). One decision per task; packet wins as `kind`
  when both exist (decisions.server.ts:109-112).
- **`mine` (actionable)**: maintainer+ on the project (`roleCan(role, "resolve-packet")`,
  decisions.server.ts:118) OR the task's owner with contributor+ (`own-task`) role — R14-2
  widened the owner to govern every decision on their own task (decisions.server.ts:124-127).
- **`overrideEligible`**: org admin whose own project role is insufficient — surfaced
  separately, never folded into `mine` (decisions.server.ts:128-134).
- Viewer / contributor-non-owner → counted for nobody (decisions.server.ts:135-136).
- Note `waiting` plays NO part here: a packet-carrying task counts even if `waiting: agent`.
- Projects missing from `stagesBySlug` are skipped entirely (decisions.server.ts:103).

## 3. Review queue (`review-queue.server.ts`)

- Qualification: tasks whose stage equals the RESOLVED review id — the stage with a workflow
  edge into the terminal stage, positional fallback (review-queue.server.ts:64-70;
  stage-roles.ts:50-56). No literal `"review"` matching.
- Split (review-queue.server.ts:147-151): `ready` ("Waiting on your acceptance") requires
  `waiting === "human"` AND viewer acceptance authority (`canAccept`: maintainer+ or owner
  with own-task role; unscoped calls pass everything — lines 136-141) AND
  `blockReason === null` AND `pr.state !== "closed"` (a rejected PR can't be accepted, NEW-1).
  Everything else at the review stage → `working` ("Still in review").
- Sublines (`review-helpers.ts:49-63`): blockReason > packet header > live PR state
  (`prStateSub`, review-helpers.ts:34-45) > newest timeline event > waiting-based fallback
  ("Waiting at the review boundary…" vs "Agent working…").
- The queue does NOT require a decision object — a human-waiting review task with no packet
  still lands in `ready` for an authorized viewer (comment review-queue.server.ts:111-117).

## 4. Consumers — which state produces which chip

### Board (`routes/project.tsx` + `features/board/`)
- Loader annotates `waitingOnMe` per task as the UNION of `decisionsRequiring(...).mine` and
  `getReviewQueue(...).ready` keys (project.tsx:61-72, UI-48 — the two predicates disagree
  without the union).
- Filters (`board-filters.ts:32-56`): `archived` → archived only; archived excluded from all
  others; `human` ("Waiting on me") → `waitingOnMe === true` ONLY (line 38 — NOT
  `waiting === "human"`); `agent` → `waiting === "agent"` (line 39); `risk` ("Needs
  attention") → readiness risk/blocked OR validation failing OR urgent OR PR closed-unmerged
  (lines 40-53). `all` → everything non-archived.
- Card chips: `WaitTag` renders "agent working" for `waiting === "agent"`, and for
  `waiting === "human"` renders "waiting on you" iff `waitingOnMe` else "waiting on a human"
  (board-page.tsx:62-82). `waiting === "none"` renders no tag (line 81).
- Subtitle stat is project-wide unscoped `waiting === "human"` count (board-page.tsx:1084);
  the "Waiting on me" chip count is the `waitingOnMe` filter count (board-page.tsx:1086).
- Readiness pill: canonical enum → mock kinds (`ready/input/risk/blocked`), plus derived
  `accepted`/`merged` display states (app/ui/pill.tsx:59-64). `displayReadiness` becomes
  `merged` when accepted AND `pr.state === "merged"`, else `accepted` (terminal stage), else
  raw readiness (app/shared/mapping/task.server.ts:286-290). Validation pill: healthy /
  "awaiting verdict" (changed) / failing / none (pill.tsx:91-98).
- Orphan-stage tasks are listed in `orphanTasks`, never dropped (board-query.server.ts:66-67,
  209-213).

### Home (`features/home/home-query.server.ts`)
- Card `waiting` = viewer's `decisionsRequiring(...).mine` count per project;
  `overrideWaiting` separate (home-query.server.ts:106-117); rendered as "N waiting on you"
  (home-page.tsx:164-176). Unscoped fallback in `listHomeProjects` re-implements the
  packet/rec + non-terminal rule in SQL (home-query.server.ts:153-165, 232-235).
- `running` counts live `agent_runs.state = 'running'` rows, NOT `waiting === "agent"`
  (home-query.server.ts:196-205).
- Home does NOT union the review-queue predicate — only `decisionsRequiring`.

### Notifications (`projections/notifications.server.ts`)
- `waitingOnYou` on a packet/approval notification = task in the viewer's
  `decisionsRequiring(...).mine` set (notifications.server.ts:134-146). Also no review-queue
  union.

### Rail counts (`routes/project.tsx`)
- board = all tasks incl. Done; review = count of tasks in the resolved review stage —
  ready + working together (project.tsx:95-103, matching review queue `total`).

## 5. Fall-through — where work goes invisible

- **Human-waiting, no packet/rec, NOT in the review stage**: `decisionsRequiring` skips it
  (no decision object), review queue skips it (wrong stage). It matches NO board filter
  except "all" — the `human` filter needs `waitingOnMe` (board-filters.ts:38), which nobody
  gets. Home "waiting on you" = 0, notifications never flag it. Only signals: the unscoped
  "waiting on a human" WaitTag on its card and the board subtitle count
  (board-page.tsx:1084).
- **Decision with no eligible actor**: a packet on a task owned by a removed account in a
  project with no maintainer+ members lands in nobody's `mine` — only org-admins'
  `overrideEligible` (decisions.server.ts:128-136), which renders as a de-emphasized
  "override-available" chip on Home (home-page.tsx:172-176), not a personal inbox item.
- **`input_required` readiness**: the pill says "input required" but the state matches no
  filter (`risk` needs risk/blocked, board-filters.ts:42-43) and no count — a
  warning-diagnostic task is chip-visible only.
- **Cross-surface disagreement (UI-48 fixed only on the board)**: a review-stage,
  human-waiting, packet-less task counts in the board's "Waiting on me" chip and the review
  queue's acceptance panel, but Home's "waiting on you" and the notification `waitingOnYou`
  flag use bare `decisionsRequiring` (home-query.server.ts:106; notifications.server.ts:135)
  — Home can say 0 while the project's review queue shows "1 waiting on your acceptance".
- **Stale `waiting: "agent"`**: the flag is a governance display bit, flipped by run
  start/end; a dead run strands it (run-recovery targets `waiting = 'agent'` stalls,
  run-recovery.server.ts:180, 208) — until recovery runs, the card claims "agent working"
  with nothing in flight, and the task matches only the `agent` filter.
- **Project row missing for a projected task**: `decisionsRequiring` `continue`s
  (decisions.server.ts:103) — the decision silently leaves every inbox.

## Suspect areas

- Home/notifications lack the UI-48 union with `getReviewQueue(...).ready`
  (project.tsx:61-68 vs home-query.server.ts:106, notifications.server.ts:135): the
  acceptance-without-packet case is "waiting on you" on the board but invisible on Home and
  in the bell.
- Non-review-stage `waiting: "human"` with no decision object is unreachable from every
  filter/count except the board subtitle — the clearest invisible-work bucket (see §5).
- `input_required` matches no filter; whether "Needs attention" should include it is a
  product call nobody has made in code (board-filters.ts:40-53).
- Duplicate open-decision predicate: `listHomeProjects`' SQL (home-query.server.ts:156-158)
  re-implements decisions.server.ts:85-88 by hand — a future packet-shape change must touch
  both.
- `getReviewQueue` is called twice per board load (project.tsx:65 for the union; the review
  route again) and `decisionsRequiring` runs an unbounded org-wide scan per notification list
  — cost, not correctness.

## Open questions

- Should `overrideEligible` decisions in an actor-less project escalate (notify org admins)
  instead of relying on the passive Home chip?
- Is the review queue's unscoped fallback (`canAccept` returns true with no viewer,
  review-queue.server.ts:137) ever hit by a production caller, or is it test-only as the
  comment claims?
- The `human` board filter shows only `waitingOnMe` tasks — is there any surface where a
  maintainer can list "waiting on a human (not me)" tasks, or is the subtitle count the only
  trace?
- Orphan-stage tasks keep their stored `waiting` (terminal normalization keys off the stage
  list, rebuilder.server.ts:351-356) — intended, or should orphans settle to a diagnostic
  state?
