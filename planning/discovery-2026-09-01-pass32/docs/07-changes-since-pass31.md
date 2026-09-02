# 07 — Changes since pass 31

Discovery pass 32, 2026-09-01. Written against **`main` @ `68b5480e`**.

Docs `00`–`06` in `planning/discovery-2026-08-31-pass31/docs/` were written against
**`f868f131`**. Everything below is the delta: `git log f868f131..HEAD` — 11
first-parent commits (10 merges + 1 direct ledger commit), 168 files, ~18,460
insertions / ~1,431 deletions (about 4,500 / 590 of that outside `planning/`).

**This document exists so an implementer does not have to read the diffs.** Every
claim carries a `path:line` resolved against the CURRENT tree. Where a prior doc
(00–06) contradicts this one, this one wins.

---

## 0. The map: merge → PR → ruling

| Merge | PR | Branch | Rulings | app/ scope |
| --- | --- | --- | --- | --- |
| `badd4b43` | #253 | `pass31/implementation` | none new (implements the pass-31 backlog; corrects canon on rulings 35 + 44) | 88 files |
| `9dc71393` | #254 | `pass31/owner-decisions` | **100, 101, 102, 103** | 16 files |
| `853353c7` | — | direct commit | — (ledger only, `planning/`) | 0 |
| `1dc5c705` | #257 | `fix/operator-narration-verbatim` | **104** | 10 files |
| `219da593` | #258 | `fix/attachment-debris-and-viewer` | **105** | 13 files |
| `2b718293` | #259 | `ruling-105/universal-download` | **105 addendum** | 5 files |
| `58e109d6` | #260 | `ruling-106/controller-settings-parity` | **106** | 15 files |
| `19b8c406` | #261 | `ruling-107/controller-ops-mcp` | **107** | 19 files |
| `af0093b3` | #262 | `ruling-108/controller-config-locks` | **108** | 9 files |
| `ecdf7abd` | #263 | `ruling-108/compose-unlock-vars` | 108 (surface) | 0 (`compose.yml`) |
| `68b5480e` | #264 | `ruling-108/unlock-enabled-disabled` | 108 (value rename) | 5 files |

Rulings 100–108 are canon in `docs/architecture/decisions.md:1423-1638`.

---

## 1. PR #253 — pass-31 implementation (`badd4b43`)

Seven commits: `b67c969b`, `3d25ebf3`, `18bc8b20`, `1b362434`, `9acd6352`,
`a912e9e5`, `d2568dd9`. The last is "Fix all 17 surviving findings from the
pass-31 self-review (V1-V19)" — 8 finder angles, 19 deduped candidates, 16
CONFIRMED / 1 PLAUSIBLE / 2 REFUTED. Gates at merge: vitest 4741, tsc 0, lint 0,
build, compose e2e.

**No new ruling.** Two canon CORRECTIONS landed in `decisions.md` with dated
notes: ruling 35's refusal set is now `merged | closed | no_revision |
head_unknown | head_mismatch` (was `not_open | …`), and ruling 44 is reaffirmed
as "the code is the source of truth for enumerations".

### 1.1 The five headline threads

**F31-6 — `resolve_remote_collision`, the 11th packet option kind.**
The remedy for a task-key BRANCH COLLISION (an unrelated remote branch, usually
with an unowned PR, sits on this task's branch name so the delivery push
conflicts). Confirming closes the recorded unowned PR, deletes the stale REMOTE
branch, and re-delivers this task's LOCAL work. It is the exact opposite of
`discard_branch`.

- Kind declared `app/schemas/task-file.schema.ts:163` (doc `:155-162`).
- Resolution switch-case `app/server/tasks/task-actions.server.ts:6438`; gated on
  `approve-transition`; listed in `NO_REQUEUE` at `:6574` ("the re-delivery's own
  machinery owns the follow-up").
- The three-step remedy runs AFTER the resolution write:
  `app/server/tasks/task-actions.server.ts:6846-6909`. Each step is best-effort;
  every non-success lands on the timeline in plain words. A fully successful
  resolution lifts `readiness: blocked → ready` (`:6891-6893`) — the refused arms
  leave the block standing.
- The GitHub half is `resolveRemoteBranchCollision`
  (`app/server/github/github-reconciler.server.ts:1580`, result type
  `RemoteCollisionResult` `:1563`): PATCH the unowned PR closed (best-effort,
  `:1603-1634`), then `deleteTaskRemoteBranch` (its refusals still bind, `:1636`),
  then clear `github.unownedPr` (`:1641-1645`).
- **New audit action:** `github.pr.closed_unowned`
  (`app/server/github/github-reconciler.server.ts:1625`). (`github.branch.deleted`
  at `:1533` pre-dates this PR.)
- Authoring coherence: `operatorOpenPacket` REFUSES `discard_branch` on a task
  with a delivered revision or an occupied branch name, naming the collision verb
  instead — `app/server/tasks/operator-actions.server.ts:1023-1046`.
- Both operator legs teach it: option-kind description
  `app/server/tasks/operator-toolkit.server.ts:436`, `deliver_for_review`
  description `:585`.
- Supersession: `withdrawSupersededDeliveryPacket` now matches collision packets
  too — `app/server/tasks/task-actions.server.ts:2475-2499` (V10, closes an F29-7
  regression).
- `prAdoptionRefusalNote` points at the verb instead of manual delete/rename
  instructions — `app/server/github/pr-adoption.server.ts:112-120`.

**F31-1 — the reconciler's POSITIVE-PROVENANCE rule.**
A colliding branch's footprint is never recorded as this task's.
`app/server/github/github-reconciler.server.ts:534-595`:

- `unownedPr = pr && !ownsAPr ? pr : null` (`:444`).
- `deliveredThisBranch = ownsAPr || fm.pr !== null || fm.workRevision?.branch === branch` (`:561-562`).
- `provenBranchHead = deliveredThisBranch && !unownedPr` (`:563`) — the compare/PR
  footprint records nothing unless this holds.
- A cache with no delivery record behind it is DROPPED, not carried
  (`cachedCommits`/`cachedChanged`, `:580-583`).
- V5 corrected the first cut: the test is positive evidence, **not** "no unowned
  PR" — a PR-less stale branch carrying foreign `[KEY]`-prefixed commits passed
  the absence test and told the same lie with no collision row to explain it
  (`:542-546`).

**F31-11 / V18 — `heldAtStage` + `strandedResume`: one nudge per settle.**
A settle-time auto-stage resume re-fired a paid operator drive on every stranding
(measured: 14 drives on one no-op task).

- `RunOperatorInput.strandedResume?: boolean` —
  `app/server/runtimes/operator-run.server.ts:195`; carried on the lease token
  (`:315`, set `:1431`); coalescing preserves it (`:446-447`, V13); a cross-boot
  plan recovery deliberately resets it to `false` (`:2048`).
- Frontmatter field `heldAtStage: z.string().nullable().default(null)` —
  `app/schemas/task-file.schema.ts:620`, in `TASK_FRONTMATTER_KEYS` `:973`,
  tolerant-parsed `:1273-1278`.
- **Set** at exactly one place: `app/server/runtimes/operator-run.server.ts:813`,
  when a NUDGED drive strands again — plus a policy-engine timeline note
  (`:814-824`) saying coordination is paused here.
- **Read** at `:786-795`: while `heldAtStage === stage`, the backstop stays quiet
  (logs and returns false).
- **Cleared** at 5 sites in `app/server/tasks/task-actions.server.ts`: creation
  default `:502`, goal edit `:590`, every real stage transition `:4548`, packet
  resolution `:6522`, acceptance-to-Done `:7882`. Both stage writers in the
  server (`frontmatter.stage = …` at `:4539` and `:7879`) clear it. A manual
  operator drive deliberately does NOT.

**T13 / V2 — per-recipient notification dedupe.**
`operatorOpenPacket` notifies watchers itself, so a caller that also sent its own
"run failed" row produced two rows about one event.

- `TaskWatcherNotice.exceptUserIds?: readonly string[]` —
  `app/server/tasks/task-mutation.server.ts:145`, applied `:190`.
- `StuckLoopEscalation` — `app/server/tasks/task-actions.server.ts:2248-2260`:
  `{status:"opened", notifiedUserIds}` | `{status:"already_open"}` |
  `{status:"failed"}`. **Only `"opened"` means the packet notification went out**;
  the other two leave the caller responsible for telling anyone.
- Wired: `failureNotice.exceptUserIds = escalation.notifiedUserIds` at `:3689`.
- `OperatorActionResult.notifiedUserIds?: string[]` —
  `app/server/tasks/operator-actions.server.ts:185`.

**F31-C4 / V6 — the CLAUDE.md excludes file is a PRECONDITION, not a hope.**
An in-container canary proved live (2026-08-31) that the SDK silently drops
`Options.managedSettings.claudeMdExcludes` (restrictive-only allowlist filter),
leaving the repo's `CLAUDE.md` ingress OPEN with exactly the options viberr passed.

- The real channel is `<workspace>/.claude/settings.json`, written by
  `mountGrantedSkills` after every strip+mount —
  `app/server/runtimes/skill-mount.server.ts:349` (`writeCatalogSettings`),
  `CATALOG_SETTINGS_FILE = "settings.json"` `:409`, content is **excludes only,
  never hooks or permissions** (`:377-400`).
- New export `ensureCatalogSettings(repoDir): boolean` — `:472` (re-checks and
  repairs at run start).
- New `SkillMount.settingsWritten?: boolean` — `:264`.
- The adapter never opens `settingSources: ['project']` on faith:
  `nativeSkillsForRun(spec)` — `app/server/runtimes/claude-runtime.server.ts:371`
  — returns `[]` (no native skills, `Skill` stays denied) when the file cannot be
  established; call site `:784`. `MANAGED_SETTINGS` (`:401`) rides along as an
  inert belt.

### 1.2 Everything else, by area

**Schemas / file layer**

| File | What changed |
| --- | --- |
| `app/schemas/file-diagnostics.ts` | NEW export `tolerantRowsOf<T>` `:75` — the F18 per-ROW tolerance idiom, once (V17). Three hand-rolled copies had drifted in wording and path shape. |
| `app/schemas/project-file.schema.ts` | `tolerantArray`'s inline loop → `tolerantRowsOf` `:326`. Pure dedup. |
| `app/schemas/task-file.schema.ts` | `resolve_remote_collision` `:163`; `heldAtStage` `:620`; `tolerantRows` → `tolerantRowsOf` `:1092`. |
| `app/server/files/task-file.server.ts` | **F31-C5 behavior change**: `parsePacketSection` probes `raw.options` per-row BEFORE the whole-packet parse — `:380-403` (call `:392`). One malformed option drops itself with diagnostic code `packet.invalid_option`; the packet and the human's open decision survive. This **supersedes F20-6's whole-packet-null arm**, which was durable loss (the next `updateTaskFile` serialized the packet section away). |
| `app/shared/mapping/task.server.ts` | `TaskSummary.unownedPr: number \| null` `:222`, mapped `:641`. |

**GitHub**

| File | What changed |
| --- | --- |
| `github-reconciler.server.ts` | Provenance rewrite (above) + `resolveRemoteBranchCollision` `:1580` / `RemoteCollisionResult` `:1563`. |
| `pr-adoption.server.ts` | Refusal note names the collision verb `:112-120`. |
| `pr-open.server.ts` | NEW exported interface `DeliveredPrParts` `:179` (type extraction only). |
| `update-branch-operator.server.ts` | `updateBranchGate` reduced to `gate(authority, UPDATE_BRANCH_CAPABILITY)` `:75-78` — the polarity moved into `absentPolarityGate`. |
| `pr-divergence-operator.server.test.ts` | RENAMED → `pr-divergence-wake.server.test.ts` (identical blob; the seam is `OperatorWake`). |

**Operator / gates**

- `absentPolarityGate(authority, capabilityId)` —
  `app/server/tasks/operator-actions.server.ts:466-490`, consulted INSIDE `gate()`
  at `:500-505`. Table: `deliver-review-pr` → derived from governance;
  `dispatch-agents` → `direct`; `update-task-branch` → follows `deliverGate`;
  `use-web-search-fetch` → `direct`; everything else → absent-means-off. The
  dedicated gates remain as thin documented fronts.
  Mirrored in the display path's comment at
  `app/features/agents/agents-query.server.ts:371`.
- **F31-3 — `OperatorTaskSnapshot.orgResources`**
  (`app/server/tasks/operator-actions.server.ts:1540`, built `:1883-1887`): the
  instance catalog NAMES for KBs, skills and MCP servers, so a "does not exist"
  claim is checkable. The always-injected remedy instruction teaches the
  distinction at `app/server/runtimes/operator-run.server.ts:3193-3195`: a name in
  `orgResources` under no `deployedSpecialists[].resources` is "exists, not
  granted here", never "does not exist".
  V12 made the readers names-only — `listKnowledgeBaseNames`
  (`app/server/org/resources.server.ts:269`), `listMcpServerNames` `:812`,
  `listSkillNames` `:1971` — because the full view builders walk every store
  directory and read every `SKILL.md` body, all discarded for `.name`, on the
  operator's most-called tool.
- `OperatorTaskSnapshot.unownedPr?: number | null` — `:1475`, populated `:1851`.
- **C9** — `AGENT_QUESTION_PACKET_KIND = "Agent question"` exported at
  `app/server/tasks/agent-outcome.server.ts:435`. The value is load-bearing:
  resolution routes an answer back to the asking agent only when the kind matches
  exactly. It was an untyped literal duplicated at writer and reader.

**Runtime / quota**

- **D5 + V4 — a second, independent quota channel.** The live `rate_limit_event`
  telemetry is Claude-only, so a spent Codex subscription reported nothing at all.
  Now a `·quota`-classified failure line records exhaustion — but ONLY when the
  PROVIDER's own sentence evidences a spent usage window:
  - `USAGE_LIMIT_RE` `app/server/runtimes/backend-quota.server.ts:124-125`
    (deliberately excludes "rate limit" / "too many requests" / "429").
  - `providerSentence()` splits on the literal marker
    `"\n\nThe provider reported: "` (`:135`) — the adapter's canonical prose says
    "usage limit" for every member of the class, so judging the WHOLE line would
    defeat the gate.
  - `quotaExhaustionEvidence(text)` `:152` is the only call the recording seam makes.
  - `parseQuotaResetAt` `:261`, `QuotaReset` `:158`,
    `recordBackendQuotaExhaustion` `:298`, `clearBackendQuotaExhaustion` `:319`,
    `BackendQuotaExhaustion` `:93`.
  - Retirement: `QUOTA_RESET_GRACE_MS = 24h` `:342` (prose-derived resets only —
    an `exact` provider-emitted instant gets 0 grace, `:366`);
    `UNDATED_EXHAUSTION_TTL_MS = 6h` `:354`.
  - Recorded off the REDACTED display line, wired at
    `app/server/runtimes/run-sink.server.ts:376-410`; cleared when a run reaches
    `state === "finished"` (`:501-507`) — "the real run IS the re-probe (ruling 19)".
    Only `finished`; an interrupted or errored run proves nothing.
- `claudeIdleTimeoutMs()` now reads the validated env —
  `app/server/runtimes/claude-runtime.server.ts:176`.
- **`RunKind` is a DELIVERY axis, not a role taxonomy** —
  `app/features/runtime/runtime-types.ts:24-33` (C7). `reviewer` = ANY supporting,
  non-delivering specialist run; a Developer dispatched `delivers: false` is
  stored as `reviewer`. Two partial unique indexes on `agent_runs` and the CHECK
  in `0001_baseline.sql` depend on this reading — renaming means a baseline change.
- `AgentRunRow.outcome_key: string | null`
  (`app/server/runtimes/run-store.server.ts:50`), `RunPatch.outcomeKey`
  (`:159`), column map `:181`. `registerAgentCompletion` moved off a raw
  `UPDATE agent_runs SET outcome_key = ?` onto `patchRun` —
  `app/server/tasks/task-actions.server.ts:3106`. (C1: the store's types used to
  deny the column existed.)

**Env / config (C3) — three knobs that existed but were undeclared**

`app/server/config/env.server.ts:163-165` declares (doc block `:145-162`)
`VIBERR_GIT_CLONE_TIMEOUT_MS`, `VIBERR_TRANSCRIPT_RETENTION_DAYS`,
`VIBERR_SESSION_HOME_RETENTION_DAYS` (all `z.string().optional()`), documented in
`.env.example:152-169` (values at `:157`, `:163`, `:169`). Every timeout knob became a LAZY function so
`resetEnvCacheForTests` can reach it and an invalid env cannot throw at import:

| Was | Is |
| --- | --- |
| `CLONE_TIMEOUT_MS` (const, frozen at import) | `cloneTimeoutMs()` `app/server/tasks/git-clone-auth.server.ts:200` |
| `CLAIM_LEASE_MS` (const) | `claimLeaseMs()` `app/server/tasks/schedule.server.ts:322` |
| `MIRROR_TIMEOUT_MS` (const) | `mirrorTimeoutMs()` `app/server/tasks/repo-mirror.server.ts:199` |

`transcript-retention.server.ts` reads both windows off `getEnv()` via `days()`
(renamed from `envDays`); `0` stays a real value meaning "keep forever".

**Instance settings**

`getSetting` / `setSetting` un-privatized and exported, new
`deleteSetting(db, key)` — `app/server/settings/instance-settings.server.ts:72`;
`InstanceSettingValue` widened to a recursive JSON type `:21-27`. Backend-quota
(V14) now rides these shared accessors instead of hand-rolled SQL.

**Insights (D6 + V3)**

- `OversightSummary.coordination` —
  `app/server/insights/insights-query.server.ts:96-100`
  (`coordinationCostUsd`, `totalCostUsd`, `share`). Coordination is
  `operator` + `controller` (V3 folded the controller in and deleted a third
  aggregate); computed in the SAME SQL aggregate as the totals (`:446-470`) so
  numerator and denominator cannot disagree. `share` is **null** when nothing
  reported a cost — never a fake 0%.
- "Coordination overhead" StatCard — `app/features/insights/insights-page.tsx:216-226`.
- `BackendQuotaPanel` gained a 4th honest state and a newest-reading-wins rule:
  `observedAfter()` `:233`, refusal selection `:263-267`, full bar + "usage limit
  reached" + "from a refused run" + a date-only `retry after` for `prose`-precision
  resets (`:279-350`). V9: only an `exact` reset renders as an instant.
- `/insights` finally has a document title — `app/routes/insights.tsx:12-14`.

**Misc**

- `setMemberRole` toast uses the FULL display name, not `.split(" ")[0]` —
  `app/features/policy/policy-actions.server.ts:159`, `:175` (D2).
- `isCorruptionError` decodes `errcode` through a zod schema instead of a
  hand-narrow — `app/server/db/self-heal.server.ts:62-66`; `copyTable` returns the
  named `CopyTableCounts` `:162`.
- `boot.server.ts:599` — an empty `skipped` set now logs `undefined` (which
  `JSON.stringify` drops) so the record carries no key at all.

**CSS (locks, no visual change)**

`app/app.css:131-146` documents the radius scale and the sanctioned non-steps;
`:148-160` documents the nine-step spacing ladder. Two literal
`border-radius: .3rem` were snapped to `var(--radius-small)`
(`app/app.css:4736`, `:4759`). Both scales are now gated with **no allowlist** in
`app/app.css.test.ts`: `describe("app.css radius scale (pass 30)")` `:2588` and
`describe("app.css spacing scale (pass 30)")` `:2651`. A value that reaches ten
spacing sites is treated as a de-facto step and must be one of the nine.

### 1.3 Tests added (PR #253)

| File | Locks |
| --- | --- |
| `app/app.css.test.ts:2588,2651` | six radius tokens and only those; every `border-radius` is a token or a sanctioned non-step; no bare copy of a token's value; exactly nine de-facto spacing steps; every declared step in real use |
| `app/server/github/github-reconciler.server.test.ts:546,588,632,678,728,781` | F31-1 colliding footprint never recorded; V5 PR-less squatter excluded; a delivered branch records commits with no PR; an unproven cache is DROPPED; a delivered branch KEEPS its workspace cache under collision; the collision reaches the projection |
| `app/server/tasks/task-governance.server.test.ts:1082,1331,1391` | `retry_other_backend` pins the engagement; collision refused at contributor-owner tier + honest degradation with no GitHub; full remedy (PATCH close + DELETE ref + record cleared + redelivery outcome) |
| `app/server/tasks/delivery-decision.server.test.ts:255,429,488` | T3 a REAL non-fast-forward push refuses `push_conflict` with NO PR (drives real git); V10 supersession matches the collision verb; V11 success lifts the readiness block |
| `app/server/tasks/operator-actions.server.test.ts:2025,2290,2309` | authoring refusal + acceptance of the collision verb; the snapshot names the instance catalog; the snapshot names `unownedPr` |
| `app/server/runtimes/operator-run.server.test.ts` | a re-stranded resume records a deliberate hold; a recorded hold keeps the backstop quiet (no duplicate note, no paid nudge); V13 the marker survives machine-trigger coalescing |
| `app/server/tasks/acceptance-graph.server.test.ts:282` | V18 a real stage move clears `heldAtStage` |
| `app/server/tasks/agent-completion.server.test.ts:966,1072` | V2 a watcher who silenced packet notifications still gets the quality row; watchers are still notified when the packet could NOT be opened |
| `app/server/runtimes/run-sink.server.test.ts` (9 new) | both providers' reset clauses parsed / null rather than guessed; exhaustion recorded off a `·quota` line with its evidence; **transient rate limiting is NOT recorded**; undated records expire on age; prose resets held through grace; exact resets retire to the second; other failure classes ignored; a COMPLETED run retires the flag; a passed reset retires the record |
| `app/server/runtimes/skill-mount.server.test.ts` | a successful mount writes the excludes; preserving a live mount preserves nothing else; a mount of nothing re-establishes the excludes for the preserved run; `ensureCatalogSettings` accepts only viberr's own file, never creates a catalog, never writes through a symlink; **mounts NOTHING when the excludes cannot be written** |
| `app/server/runtimes/run-concurrency.server.test.ts` (new) | T11 raising the cap alone drains the queue; a dispatch past the cap lands `queued` and drains to `running` on the real `startAgentRun` path |
| `app/server/runtimes/run-recovery.server.test.ts` | `patchRun` writes `outcome_key` and `getRun` reads it back |
| `app/server/runtimes/operator-kb-injection.server.test.ts` (new) | a second KB cannot re-arm the budget the first one spent |
| `app/server/auth/login.server.test.ts:355` (new coverage) | T14 a minted temp password signs in under the forced gate and a re-issue kills the old one immediately |
| `app/server/projections/notifications.server.test.ts:361` | T16 the category toggle silences ONE user and re-enabling restores (asserts kind MEMBERSHIP, not same-millisecond order — `a912e9e5` deflake) |
| `app/server/tasks/schedule.server.test.ts:233,393,479` | T17 creator attribution round-trips; a cancelled schedule never fires; two racing ticks claim exactly once |
| `app/server/tasks/specialist-run.server.test.ts:725,767,2204,2251` | T7 `backendOverride` outranks an opposite pin and re-pins; the engagement snapshot is the floor; T5 `skills:[]` carries a KB and no skill body; KBs share ONE budget and say so |
| `app/schemas/task-file.schema.test.ts` + `app/server/files/task-file.server.test.ts:173,191` | F31-C5: an unknown/malformed option drops only ITSELF (supersedes F20-6's whole-packet arm) |
| `app/features/insights/insights-page.test.tsx:128,…` | coordination spend covers operator AND controller; the refusal state names its source; prose reset renders as a date, exact as an instant; a NEWER reading beats the refusal; an older reading does not |
| `app/features/task-detail/task-detail-components.test.tsx:1411,2384,2463,2514` | the collision row on `GithubTrace`; the collision ceremony asks first and names deletes/keeps; V16 a blocked option states its tier in description + title + deny note; all three destructive ceremonies render the SAME alertdialog shell |
| `app/features/task-detail/task-disposition.test.tsx:1554` | V1 page-level: the page hands the ceremony `task.unownedPr` (a component test could not see the omission at the one production call site) |
| `app/server/config/env.server.test.ts:140` | the tuning knobs pass through as raw strings; `"0"` round-trips as a real value |

Fixture-only updates (`unownedPr: null` / `heldAtStage: null`):
`board-page.test.tsx:59`, `continuity-recovery.test.tsx:456`,
`execution-profile.test.tsx:60`, `task-side-panels.test.tsx:63`,
`test-support/demo-data.ts:317`, `test-support/test-store.ts:123`.

### 1.4 Design decisions worth carrying (PR #253)

- **"One row per kind, consulted from every site."**
  `app/features/task-detail/decision-packet.tsx:525-534`: five kinds were gated
  through six parallel `o.kind === "…"` chains, and `resolve_remote_collision`
  shipped inert and hover-titled with NO description clause — the one reason a
  keyboard or touch user can reach said nothing. `PACKET_TIER_GATES` `:536` is now
  consulted by `gateFor(kind)` `:762`; `PacketDestructiveConfirm` `:140` is the one
  shell all three ask-first ceremonies use; `CONFIRM_FIRST_KINDS` `:607`;
  `pendingConfirm` is ONE slot, not one per kind (`:692`).
- **"Positive evidence, not the absence of a stranger."** (reconciler, `:542-546`)
- **"The producing event must never claim a file the directory does not hold."**
  (foreshadows ruling 105 — see §5.)
- **A row with no enforcement would be decorative** — the ruling-Q3 failure mode,
  invoked repeatedly (and applied literally in PR #257).
- Prose-derived quota reset instants can be 12–14 h off (unknown provider
  timezone): rendered date-only, never as a wall-clock time
  (`backend-quota.server.ts:196-199`, `insights-page.tsx` V9 branch).

---

## 2. PR #254 — owner rulings 100–103 (`9dc71393`)

Single commit `958247a4`. Gates at merge: vitest 4749, tsc 0, lint 0, build,
compose e2e **63/63**.

### Ruling 100 — recorded only

> "Ruling 99's two review-flagged asymmetries are INTENDED (owner, 2026-08-31)."
> (`docs/architecture/decisions.md:1423`)

(a) the controller applies policy/workflow edits with no confirm ceremony; (b) org
admins read project-scoped controller transcripts for projects they are not
members of. No code changed.

### Ruling 101 — repo-write parity

> "Repo-write parity (owner, 2026-08-31 — partially supersedes R22): write posture
> is GRANTS-derived and binds the SAME on both backends."
> (`docs/architecture/decisions.md:1433-1434`)

| File | What changed |
| --- | --- |
| `app/shared/capabilities.ts` | `execute-code-or-write-repo` REMOVED from `CLAUDE_ONLY_ENFORCED_CAPABILITY_IDS` (`:281`) and added to `ENFORCED_CAPABILITY_IDS` (`:259`) — **note it was already present at `:228`; see the ledger**. `capabilityEnforcement` checks claude-only FIRST (`:303-304`), so the removal is what actually flipped the answer to `"both"`. |
| `app/server/runtimes/codex-runtime.server.ts` | `resolveCodexSandboxMode` rewritten — `:377-401`. `kind === "operator"` → `read-only` (`:380`). `spec.repoWriteWithheld` → `read-only`, **unless** `attachmentsWritableDir` is set → `workspace-write` (`:385-386`, the owner's disclosed evidence carve-out; the sandbox cannot express "read-only except attachments/", and blocking it was the F22-03 defect). Only a fully-autonomous DELIVERING run with egress reaches `danger-full-access` (`:396-399`). Call site `:742`. |
| `app/server/runtimes/claude-runtime.server.ts` | `SUPPORTING_DENIED_BUILTINS` **renamed** `SUPPORTING_DELIVERY_DENIED_BUILTINS` and narrowed from 9 entries to 3 — `:259-263`: `Bash(git push:*)`, `Bash(gh pr create:*)`, `Bash(gh pr merge:*)`. Applied `:909`. Local-write denies now ride the grant-derived `disallowedTools`. |
| `app/server/tasks/specialist-tool-policy.ts` | Doc-comment reframing around `repoWriteWithheldFromDenylist`; `repoWriteWithheld` derived `:204`. No logic change. |
| `app/server/runtimes/run-service.server.ts` | `StartRunInput.repoWriteWithheld` doc `:309-310`; derivation `:840-843`; `repoWriteWithheldFromDenylist` `:594`. |
| `app/features/runtime/runs-helpers.ts` | The per-run console's Codex denial sentence rewritten (`:228-238`): the repo-write and web families now bind via sandbox and search toggles; **command-level entries remain advisory** on Codex. |

### Ruling 102 — audit export before purge

> "FR33 audit purge exports before it deletes (owner, 2026-08-31)."
> (`docs/architecture/decisions.md:1461`)

`app/server/db/retention.server.ts`:

- `RetentionOptions` `:85`; `AUDIT_EXPORT_DIRNAME = "audit-exports"` `:98`;
  `auditPurgeExportPath(now, dataRoot)` `:106` →
  `<dataRoot>/audit-exports/audit-events-<YYYY-MM-DD>.jsonl` (one file per
  calendar day, APPENDED across same-day passes).
- `auditRowSchema` `:124` is a **`looseObject`** on purpose: a column a later
  migration adds rides through to the export instead of being silently stripped.
- `exportExpiringAuditEvents` `:165`; `applyRetention(db, now, options = {})` `:200`.
- **FAIL CLOSED** `:214-221`: the `DELETE` runs only if the export returned
  `true`. Any failure logs `"audit purge skipped: expiring rows could not be
  exported"` and the rows survive for the next pass. Rationale in the header
  (`:37-41`): a purge deferred by six hours costs disk the next pass reclaims;
  a purge without a record is irreversible.
- `runMaintenancePass` forwards its `dataRoot` — `app/server/ops/maintenance.server.ts:153-157`.
- `app/features/org-settings/org-settings-page.tsx` — the audit card copy now
  discloses the export; the audit `<ul>` gained `tabIndex={0}` `:275` +
  `aria-label="Recent audit events"` `:276` (axe `scrollable-region-focusable`,
  surfaced once the seeded log outgrew its cap).

### Ruling 103 — Chromium-only matrix

> "The declared browser matrix is Chromium-only (owner, 2026-08-31)."
> (`docs/architecture/decisions.md:1479`)

Docs/PRD only. Re-adding an engine requires a Playwright project that runs it.

### Also in #254

Two time-of-day-dependent e2e failures that reproduce on pristine `main`:
`e2e/01-home-board.spec.ts` board append-drop became a deterministic two-phase
gesture; `e2e/02-feeds-profile.spec.ts` activity assertion scoped to the feed's
`.act-actor` cell (it was matching a hidden `<select>` option).

### Tests (#254)

- `capabilities.test.ts` — `capabilityEnforcement("execute-code-or-write-repo")`
  is `"both"`; the claude-only set no longer holds it; the matrix badge keeps the
  three SCOPED delivery labels claude-only while the headline reads "both".
- `codex-runtime.server.test.ts` — withheld → `read-only` (primary AND reviewer);
  evidence carve-out → `workspace-write`, never full access; write-granted
  reviewer → `workspace-write`; operator → `read-only`.
- `claude-runtime.server.test.ts` — a bare reviewer spec KEEPS local-write tools
  (`not.toContain("Edit")`); delivery denies present; explicit `disallowedTools`
  pass through.
- `runtime-registry.server.test.ts`, `pass29-scenarios.server.test.ts` — parity
  contract rewritten.
- `retention.server.test.ts` — exact rows exported as JSONL + table cleared;
  every DB column carried (`PRAGMA table_info` drift canary); a fresh row is
  neither exported nor deleted; **FAILS CLOSED** (a file where the export dir
  belongs makes `mkdirSync` throw → 0 deleted, rows survive, warn fired, the
  sibling `notifications` sweep unaffected); two same-day purges append to one file.
- `org-settings-page.test.tsx` — the card names `audit-exports/`, "one JSON object
  per line", "before the retention sweep deletes them".

---

## 3. PR #257 — ruling 104, operator narration verbatim (`1dc5c705`)

> "Operator narration is stored verbatim; no write-time length cap (owner,
> 2026-08-31)." (`docs/architecture/decisions.md:1484-1485`)

Commits `759e527f` + `2280c098` (adversarial review: 17 agents, 13 verified
findings, 6 acted on).

| File | What changed |
| --- | --- |
| `app/server/tasks/comment-guardrails.server.ts` | `enforceOperatorBrevity` and `OPERATOR_BREVITY_MAX_CHARS` **deleted** (zero remaining references anywhere). `applyCommentGuardrails` lost its brevity leg. `CommentTrim` narrowed to the single member `"evidence-separation"` — `:73`. Header `:18-24`: "There is deliberately NO length cap on operator narration … brevity is now a style instruction on the operator's `post_comment` tool, not an enforcement." |
| `app/server/tasks/operator-actions.server.ts` | Brevity wiring removed from `writeOperatorComment`; the @mention fan-out scans the caller's PRE-trim `text` (`:637-639`: "Operator narration is stored VERBATIM"). |
| `app/server/tasks/task-actions.server.ts` | `PreparedReply.mentionSourceText: string` `:1808`, set `:1937` (`= replyText`), consumed `:2109`, `:2701`, `:2970` — the agent-reply fan-out also scans PRE-trim text, so a handle inside a fenced block that evidence-separation cuts away still notifies the tagged human (B-FD8b, made TRUE rather than re-asserted). |
| `app/server/tasks/mention-notify.server.ts` | `withAmbiguityDisclosure` `:195-208` now **balances an unclosed ``` fence** before appending the S5-G3 note — the one job the deleted truncation did that had to survive it. Callers: `agent-toolkit.server.ts:127`, `task-actions.server.ts:1907,1916,3782,3961`, `operator-actions.server.ts:662,808`. |
| `app/shared/workflow/templates.ts` | `operator-brevity` row removed from `DEFAULT_GUARDRAILS` — 4 rows remain at `:93-98` (`meaningful-comment`, `no-duplicate-summary`, `compression-threshold`, `evidence-separation`). `:88-91`: "There is deliberately no operator-brevity row." Stale rows in existing `project.md` files are inert and tolerated. |
| `test-support/demo-data.ts` | The `viberr-core` seed uses `DEFAULT_GUARDRAILS` instead of a hand-copy that diverged every time the set changed. |

**Accepted interaction, recorded in the ruling:** the no-duplicate check compares
stored text byte-for-byte, so without the cap two long near-identical narrations
no longer collapse to an identical trimmed prefix. `heldAtStage` (pass 31) is the
guard against repeat-narration loops.

**Tests** — `comment-guardrails.server.test.ts`: a ~14k-char narration passes
verbatim (`trimmedBy === []`); `operator-actions.server.test.ts:2881,2909`: the
verbatim guarantee is locked at the **WRITE PATH** (`writeOperatorComment`), not
just the pure helper, and a handle inside a cut fence still notifies;
`mention-notify.server.test.ts:262`: fence balance;
`agent-completion-notify.server.test.ts`: the agent-reply leg of B-FD8b.

---

## 4. PR #258 — ruling 105, prune + text viewer (`219da593`)

> "Browser working artifacts are not deliverables; text attachments get an in-app
> viewer (owner, 2026-08-31)." (`docs/architecture/decisions.md:1508-1509`)

Commits `ff7bf6a2` + `3fda3883` (review: 21 agents, 15 CONFIRMED findings across
9 distinct defects, all acted on). Full vitest 4766 at merge.

### The prune

`app/server/files/task-attachments.server.ts`:

- `MCP_STAMPED_NAME_RE` `:146-147` —
  `/^[a-z][a-z0-9_]*-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\./`. **The stamp
  itself is the classifier, not a prefix allowlist** (`:140-145`): pinning
  prefixes just leaves the next MCP tool's sibling artifact drowning the panel.
- `VISUAL_EVIDENCE_RE` `:151` — `png|jpe?g|webp|gif|pdf` always stay.
- `isBrowserWorkingArtifact(name)` `:165-167` = stamped AND not visual.
- `pruneBrowserWorkingArtifacts(slug, key, names, citedIn, dataRoot)` `:178` —
  keeps a file whose EXACT name appears in `citedIn`; **ENOENT counts as pruned**,
  any other failure keeps the file listed (`:196-200`): the producing event must
  never claim a file the directory does not hold.
- `attachmentNamesSince` `:108` is deliberately **UNCAPPED** (`:102`): it used to
  ride `listTaskAttachments`' 100-file `LIST_CAP`, permanently orphaning overflow
  in the exact drowning case.

`app/server/tasks/task-actions.server.ts` — the wiring inside
`applyAgentCompletionEffects`:

- **FINISHED runs only** (`:3326-3327`): an errored/interrupted browsing run never
  got to cite anything and its console dump is often its only diagnostic.
- **No prune while a SIBLING run is live on the task** (`:3328-3342`): the mtime
  window is task-wide, so a finishing run would delete a still-working sibling's
  files before that sibling's citations exist. The sibling prunes its own window
  when it completes.
- Trigger `:3359-3368`.
- **Citation corpus**: the final reply, `fullText` (a Codex envelope's raw text —
  `replyText` is narrowed to its summary), the evidence rows, the ask-human
  question title/body, and any timeline text since run start.
- The persona discloses the cleanup on both sections
  (`app/server/tasks/specialist-browser-mcp.server.ts`).

### The viewer

- `app/features/task-detail/attachment-lightbox.tsx` — `IMAGE_RE` MOVED here
  (`:38`; `attachments-panel.tsx:8` re-exports it), new
  `TEXT_VIEW_RE = /\.(txt|log|md|json|ya?ml|csv)$/i` `:43`,
  `TEXT_VIEW_MAX_CHARS = 200_000` `:81`, `readTextCapped` with `reader.cancel()`
  `:105` (stream-read and cancelled at the display cap rather than `res.text()`
  buffering up to the route's 50 MB). A **redirected** response (expired session →
  `/login`) is a load failure, never rendered as content. A zero-byte file says
  "This file is empty."
- `app/routes/task-attachment.ts` — `?download=1` read `:56-57`, applied to the
  `content-disposition` at `:66`. Content type is unchanged; only the disposition
  flips.
- Inert-text whitelist lives in `INLINE_TYPES`
  (`app/server/files/task-attachments.server.ts:223-239`) — `yml`/`yaml`/`csv`
  joined `txt`/`log`/`md` as `text/plain`. `nosniff` + sandbox unchanged;
  HTML/SVG still never render.
- Factory rename `onAttachmentImageClick` → **`onAttachmentOpen`**
  (`app/ui/markdown.tsx:191`), wired on the panel rows, timeline chips, evidence
  linkify and markdown attachment links.
- New CSS: `.modal-card.lightbox-card.text` `app/app.css:5004`,
  `.lightbox-text` `:5005`, `.lightbox-text-status` `:5013`.

**Tests** — prune unit + completion integration
(`agent-completion.server.test.ts:301,358,393`: uncited pruned / cited + visual
survive; errored run keeps everything; no prune while a sibling is live), route
(`task-attachment.test.ts`: yml serves inert `text/plain` inline; `?download=1`
forces the save dialog without changing content-type), viewer jsdom
(open/content/download/failure/non-viewable). All canaried in one combined revert
run.

**Pre-existing artifacts in old tasks are left in place.**

---

## 5. PR #259 — ruling 105 addendum, universal Download (`2b718293`)

> "Addendum (owner, same day): the Download button is universal."
> (`docs/architecture/decisions.md:1522`)

Commits `d5ccf421` + `c1631354` (the review of the addendum found six defect
clusters, all in the addendum itself).

- The lightbox factory's kind gate is **gone**: every attachment kind opens the
  card. Images show the picture (previously only "Open original"), text files the
  reader, anything else a no-preview note.
- **Fall-through survivors**: modified clicks (⌘/ctrl/shift/alt, non-primary
  button) and provider-less renders still go to the real anchor.
- The markdown `a` renderer intercepts only a CLEAN single-segment name under the
  attachments base — `app/ui/markdown.tsx:279-284`; an author-written URL with a
  query, fragment or nested path stays a plain anchor. `safeDecodeName` `:179-185`
  guards the pre-existing `decodeURIComponent` render crash on a malformed escape.
- **Copy**: "no **in-app** preview" is the honest phrasing
  (`app/features/task-detail/attachment-lightbox.tsx:238-240`) — the route serves
  PDFs inline, so "no preview" was false, and it serves other kinds with
  attachment disposition, so "open the original in a new tab" promised a second
  download rather than a view.
- **Proven-failure suppression**: the no-preview card probes the URL once (a GET
  whose body is cancelled at the headers, `:206-224`) and hides Download when the
  response proved the file unservable — 404 after the prune, 413 over the 50 MB
  cap, an auth redirect. Rationale: some browsers save a failed download's error
  body as a file bearing the real name. The **image** branch never suppresses,
  because `<img onError>` cannot distinguish a 404 from a corrupt-but-servable file.
- The Download anchor carries the `download` attribute so a failed response cannot
  replace the task page.

**Tests** (`attachments-panel.test.tsx`) — a zip chip opens the no-preview card
with a `?download=1` Download (zip lock INVERTED from the previous "no card"
assertion); a query-string link keeps a plain anchor; a 404'd file's card hides
Download; the image lightbox carries the same Download button (parity proof).

---

## 6. PR #260 — ruling 106, controller settings parity (`58e109d6`)

> "Controller settings speak the agent-editor language, and stay admin-only
> (owner, 2026-09-01)." (`docs/architecture/decisions.md:1527-1528`)

Commits `805810c1`, `4fce468d`, `a26a4370`, `bd7c450a` (review: 3 finders,
15 verifiers; D1–D4 confirmed, 7 refuted).

### New shared module

`app/shared/model-ids.ts` — the STATIC half of the server's `isKnownModel` rule,
shared so a client-side picker asks the same question:

- `CLAUDE_MODEL_ALIASES` `:14` (`sonnet`/`opus`/`haiku`) — must stay in step with
  the curated `CLAUDE_MODELS` in `model-catalog.server.ts` (**locked by test**).
- `DATED_CLAUDE_ID_RE = /^claude-.*\d/` `:26` — deliberately does NOT match seed
  display labels (`"claude-sonnet"` has no digit).
- `claudeModelRunsVerbatim(model)` `:36-38`.

`model-catalog.server.ts` dropped its private `DATED_CLAUDE_ID_RE` and imports
this one.

### Extracted editor primitives

`app/features/agents/create-profile-modal.tsx`:
`CatalogModel` `:74`, `ModelCatalog` `:84`, `effortLabel` `:100`,
`ModelCatalogState` `:118`, `useModelCatalog(...)` `:128`, `ModelEffortFields`
`:510`. The caller owns `model`/`effort` state and seeds from its own source.

`app/features/org-settings/agent-template-modal.tsx`: `kbDirsOf` `:34`,
`kbLegacyOf` `:49`, `MissingChips` `:69` (all previously module-private; the
kb helpers' param widened to a structural `readonly {dir,name}[]`).

### D1 — the silent model repin

`useModelCatalog`'s seed effect used to rewrite ANY stored model the SERVED
catalog does not list to the default. But `resolveRunModel("claude", …)` runs
dated ids and family aliases VERBATIM — so opening the tab plus one Save silently
repinned a deliberately-chosen model. The hook now rewrites only what a run would
itself substitute, and the select preserves the raw id. **This also fixed the same
latent rewrite in the profile modal.**

### D2 — `effort` as a tolerant frontmatter key

`app/server/files/agent-profile-file.server.ts:53` —
`effort: z.string().optional().catch(undefined)`, in `AGENT_PROFILE_KNOWN_KEYS`
at `:99`. A strict `z.string()` made a hand-edited `effort: null` / `effort: 3`
fail the WHOLE profile parse; the controller config then read "profile missing
from the store" and `saveControllerConfig` refused to repair it. **Only the
controller reads profile-level `effort`** (`controller-profile.server.ts:177`);
deployed specialists carry model+effort on their engagement.
`SaveControllerConfigInput.effort` persists it, and blank REMOVES the key
(`controller-profile.server.ts:272-274`) so the file reads like one that never
carried it. The route reads `field("effort")` (`app/routes/org.settings.tsx`).

### The panel

`app/features/org-settings/controller-admin-panel.tsx` — free-text model `<input>`
and checkbox `<ul>` grants gone; `ModelEffortFields` + `useModelCatalog` with
**backend fixed to Claude** (that is what controller runs resolve); `GrantChips`
`:103` renders `pick-chips` toggles (KBs by NAME, stored by DIR, with the
reference editor's `kbDirsOf` display-name repair on open — D3/P13-KM-01); a grant
the store lost renders through the shared `MissingChips` as a removable red chip
(D4/P14-KM-10) instead of an unremovable "not in the store" row. Fields wear
`.field`/`.flabel`; the doctrine textarea keeps a 12-row editing area (the tab is
a page, not a modal).

`app/app.css` — dead `.ctladm-*` removed. **Only `.ctladm` `:5253` and
`.ctladm-foot` `:5254` remain.**

**Access re-verified admin-only end to end**: `/org/settings` loader AND action
`requireRole(admin)` (members 403, route-tested); every nav entry into the tab is
admin-gated. One deliberate consequence: opening the panel now shows the default
model/effort where the stored value was blank, so the first save makes them explicit.

**Tests** — `controller-admin-panel.test.tsx` (new, 243 lines then): model comes
from a catalog `select` and the free-text input is gone for good (`:128-143`);
an empty stored model seeds to the catalog default `:145`; save posts
model+effort+grants in one intent; grants are `aria-pressed` toggles; a store-lost
grant is a removable red chip; **a dated Claude id absent from the catalog is
preserved** (D1); a display-name KB grant repairs to dir on open (D3).
`org-settings-route.server.test.ts`: model+effort round-trip with no drift; blank
effort REMOVES the key. `agent-profile-file.server.test.ts`: `effort` is a known
key and round-trips; junk degrades to absent without failing the profile.
`model-catalog.server.test.ts`: the shared alias list matches the curated
`CLAUDE_MODELS` values (drift pin).

---

## 7. PR #261 — ruling 107, `viberr_ops` (`19b8c406`)

> "The controller has a built-in diagnostics MCP, and no one can take it away
> (owner, 2026-09-01)." (`docs/architecture/decisions.md:1560-1561`)

Eight commits: `4ad25076` (prep), `bd983ebf`, `89dbd842`, `82720e58`, `ba5597e4`,
`3373675c`, `83b1cdb3`, `ab8e5931`.

### Prep — two extractions with byte-stable contracts

- `app/server/ops/health-snapshot.server.ts` (new): `BackendPresence` `:26`,
  `BrowserHealth` `:31`, `HealthSnapshot` `:35`, `healthSnapshot(db)` `:64`.
  **`:50-52`: "KEY ORDER IS PART OF THE CONTRACT: the route spreads this object
  straight into its response body after `ok`, so the wire bytes are what they were
  before the extraction. Insert new fields at the END."**
  `app/routes/resources.health.ts:65` is now one call plus a spread.
- `app/server/controller/controller-tool-guards.server.ts` (new): the controller's
  refusal machinery, so both in-process servers refuse in ONE voice.
  `ControllerToolUser` `:29`, `ControllerToolText` `:38` (a type ALIAS, not an
  interface — the SDK's tool-result parameter carries an index signature and only
  an alias picks up the implicit one), `controllerToolText` `:42`, `notVisible`
  `:48`, `NotVisibleError` `:54`, `ControllerToolGuards` `:56`,
  `controllerToolGuards(db, user, dataRoot?)` `:79`. `:12-13`: "AUTHORITY is
  resolved LIVE, per call, against the ASKING USER: no controller server holds
  authority of its own." `controller-toolkit.server.ts` now destructures all of it.
- `canReadControllerRunLog` MOVED to
  `app/server/controller/controller-conversations.server.ts:125` (it answers a
  conversation-access question, and importing the run engine to answer it made a
  cycle). Both route callers follow: `app/routes/resources.run-log.ts:75`,
  `app/routes/resources.session-export.ts:48`.

### The server

`app/server/controller/controller-ops-mcp.server.ts` (369 lines):
`ControllerOpsDeps` `:59`, `ControllerOpsMcp` `:66`,
`CONTROLLER_OPS_MCP_NAME = "viberr_ops"` `:75`, `CONTROLLER_OPS_INSTRUCTIONS`
`:77`, `buildControllerOpsMcp(deps)` `:127`. READ-ONLY: nothing writes, deletes or
starts anything — diagnostics that could change the instance would be a second
authority surface beside the toolkit.

| Tool | Line | Gate |
| --- | --- | --- |
| `instance_health` | `:163` | READING open to anyone (it is what the unauthenticated `/resources/health` probe already serves, plus availability per backend and three load integers with no name or project in them). The credential **DETAIL** is org-admin only, because `backendCredentialHealth` names the deployment's config directory — a member of no project was reading a host path through an ungated tool. |
| `read_run_log` | `:200` | `canReadControllerRunLog` for controller turns, project membership otherwise. A missing run, a forbidden project and a forbidden conversation all answer ONE not-visible sentence, so a probe cannot walk run ids. |
| `read_store_doc` | `:329` | org admins only, like the store browser it comes from; reports `truncated` honestly `:349`. |

**Every log page is bounded and says where it sits.** `DEFAULT_LOG_LINES = 200`
`:98`, `MAX_LOG_LINES = 500` `:99`, clamped on every path `:248-249`. `since`
together with `before` is REFUSED instead of one silently winning. The reply
carries `page.{firstSeq,lastSeq,olderExist,newerExist,next:{older,newer}}`
`:281-313` computed against the run's REAL bounds (`stats.minSeq`/`maxSeq`) plus
`run.logLines` `:301`. It **never relays** `getRunLog`'s `headSeq`/`oldestSeq`/
`hasMore` — those are page-local cursors for a stateful console that a model with
no second source reads as facts about the run. `getRunLog` ignores `limit` in
forward mode BY DESIGN, so the forward page is sliced tool-side; the written-down
tradeoff is that if the unbounded SELECT ever bites, the fix is a `LIMIT` pushed
into `listRunLines`, never a bigger reply. Measured cost of the old default:
**2.5 MB on a 1,500-line run**.

### Not removable by construction

- `buildControllerMounts(db, input)` —
  `app/server/controller/controller-run.server.ts:150`
  (`ControllerMountInput` `:118`, `ControllerMounts` `:128`) — attaches
  `viberr_ops` on every turn with **no config read and no grant row**, so there is
  nothing to clear and no toggle that could do nothing (P14-KM-14).
- **`app/shared/mcp-reserved.ts` (new)** — `RESERVED_MCP_NAMES` `:29` (both
  underscore and hyphen spellings of `viberr`, `viberr_agent`, `viberr_browser`,
  `viberr_controller`, `viberr_ops`), `isReservedMcpName` `:42`. **THREE layers
  read this one list**: the WRITER `app/server/org/resources.server.ts:1516`, the
  PICKER `app/server/org/resource-catalog.server.ts:67`, and the RESOLVER
  `app/server/tasks/specialist-mcp.server.ts:138,142,175`. The resolver kept a
  private copy that fell two rulings behind, so a row reaching the registry any
  way but `saveMcpServer` (hand-written SQL, restored backup, created before the
  name was reserved) resolved and — because org servers mount LAST — REPLACED the
  built-in server under its own mount key.
- The panel discloses it as a **pinned chip that is deliberately NOT a control**:
  `PinnedChip` `app/features/org-settings/controller-admin-panel.tsx:93`, rendered
  as a `<span>` with a lock icon, not a disabled button ("a disabled control is a
  toggle that does nothing, and its `title` never opens"). It never enters the
  save payload or `mountedMcps`.
- Persona: `mountedMcps` is ORG grants only, so both arms now say "**org** MCP
  servers" — `app/server/controller/controller-run.server.ts:662-668` — one line
  above "Built-in diagnostics (viberr_ops) are always attached" `:674`. The flat
  negation used to contradict it in consecutive breaths.

**Scope is CONTROLLER-ONLY**: agents and the operator are untouched.

**Tests** — `controller-ops-mcp.server.test.ts` (new, 587 lines) drives each gate
arm by arm; the three answers are declared as **zod contracts and parsed**, not
asserted into shape (the anti-slop type-assertion rule); the truncation lock reads
a document longer than one `readStoreDoc` read (a canary of the honest-truncation
claim had passed against a hardcoded `false` because the only fixture was short);
the run-bounds lock walks the older cursor to seq 0 (a canary had passed against a
page-local floor).
`controller-run.server.test.ts` (new) pins the mount on a turn with **zero
grants**, the coexistence with org grants, that a registry row literally named
`viberr_ops` cannot steal the key, and the persona disclosure sentence.
`resources.server.test.ts` — every reserved name refused at save.
`specialist-mcp.server.test.ts:132-148` — ONE list guards writer, picker and
resolver (drift pin).
`controller-admin-panel.test.tsx` — the pin is an untoggleable chip that survives
zero granted MCP servers.

---

## 8. PR #262 — ruling 108, controller config locks (`af0093b3`)

> "The controller's configuration is deployment-locked by default (owner,
> 2026-09-01)." (`docs/architecture/decisions.md:1608-1609`)

Commits `ff218357`, `3216a5d1` (review: 3 finders, 20 verifiers — 7 confirmed
defect clusters), `7993614c` (owner scope).

### Server

`app/server/controller/controller-profile.server.ts`:

- `ControllerSectionLocks {skills, kb, mcps, instructions: boolean}` `:49`
  (`true` = LOCKED). `:42-47`: "Model and effort are deliberately not sections:
  picking the model tier is day-to-day admin work, while rewriting what the
  controller IS operates above the org."
- `CONTROLLER_UNLOCK_ENV` `:58`, `CONTROLLER_SECTION_LABEL` `:67` — shared by the
  refusal sentence and the panel note so they can never call one thing two names.
- `controllerSectionLocks(env = getEnv())` `:84`, typed
  `Pick<Env, "VIBERR_UNLOCK_CONTROLLER_…">` so the schema keys are pinned.
- Enforced in `saveControllerConfig` `:203`, **not the route** (`:218-220`: "so
  every save path is bound; `ctx.locks` exists for tests only"). Read at `:221`.
- `resolveGrant(section, stored)` `:234-243`: unlocked → write the input as given;
  locked → refuse only a **NON-EMPTY** list that differs by `sameSet`, and
  otherwise return the **STORED array verbatim** (order and duplicates included) —
  byte-stable by construction. Refusal `:227-229`.
- Doctrine: blank has always meant "keep"; under an instructions lock a non-blank
  DIFFERING body is refused and a locked save never rewrites the file `:254-261`.
- Audit `org.controller.updated` `:291`; `definitionEdited: writeDefinition`
  `:303` — true only when the doctrine file was actually rewritten (review #12;
  every locked save used to log `true`).

`app/server/config/env.server.ts:173-176` — the four flags, `z.string().optional()` (doc block `:166-172`).

### Panel

`app/features/org-settings/controller-admin-panel.tsx`:

- `ControllerSectionLocks` `:60` (client mirror), `CONTROLLER_UNLOCK_ENV_VIEW`
  `:70`, module-private `SECTION_LABEL` `:83` — all **drift-pinned against the
  server's** by test.
- A locked `GrantChips` group renders **granted-only read-only `<span>`s**, not
  disabled buttons: `aria-pressed` is a toggle's need, and dropping it from a
  disabled chip was the F19-5 a11y regression. The ungranted-option clutter is gone.
- A `.pol-note` `:319` lists the locked sections with their unlock variables.
- **A locked section posts BLANK** — the server reads blank as "keep the stored
  value", so a page loaded before the doctrine changed can never post its stale
  copy back as a change, and model/effort edits always succeed under a lock
  (review #2).
- Under a lock the KB display-name repair still runs for **DISPLAY** (the payload
  is lock-aware, so the repair can no longer become a write) — review #8/#16.
- Instructions render `<textarea readOnly>` when locked.
- A dangling grant under a lock is still disclosed, just not removable.

`app/app.css` — `.field textarea[readonly], .field input[readonly]` `:2267`
(muted fill, `resize: none`) and its focus override `:2270`
("The only read-only field in the app, so this rule is its"); `.lbl-lock` `:2276`
sized for small-caps labels (16px icons rendered flush against `.flabel` text).

`app/features/org-settings/org-settings-page.tsx` gained a required
`controllerLocks` prop; `app/routes/org.settings.tsx:129` supplies
`controllerSectionLocks()` from the loader.

### Scope (owner, narrow)

The lock covers the controller **SETTINGS tab** — the grant lists and the doctrine
file edited there. It is deliberately NOT airtight, and the panel note + ruling say
so: deleting or renaming a resource on the Agent resources tab still prunes the
controller's grant (the shared `resource-references` rewrite), and editing a
granted skill's or KB's file CONTENTS still changes what the controller loads as
trusted context. `viberr_ops` is not a section and stays mounted under every flag
combination.

**Tests** — `controller-admin-panel.test.tsx` `describe("… ruling 108: deployment
locks")`: each locked section renders read-only with the unlock note; a locked save
posts blank per section; sections lock independently; nothing locked → no note,
full editability; a dangling grant is disclosed but not removable; the view's maps
are pinned against the server's.
`org-settings-route.server.test.ts` `describe("controller config locks (ruling
108)")` `:421-640`: a grant change per locked section is refused naming the
variable; blank keeps the stored value; an identical round-trip and a
model/effort-only edit pass under FULL lock; each flag opens exactly its own
section; a reordered same-set input still writes the stored list; a locked/blank
save never claims `definitionEdited`; `controllerSectionLocks` defaults to locked.

---

## 9. PR #263 — compose surface (`ecdf7abd`)

`compose.yml:43-55` — the four unlock knobs surfaced in the app service's
`environment`, each `"${VAR:-disabled}"` (after #264), documented inline so an
operator sees they exist without reading `.env.example`. Shipped behavior
unchanged; unlocking is a visible one-word edit. No `app/` files.

---

## 10. PR #264 — `enabled`/`disabled`, not `0`/`1` (`68b5480e`)

Commit `e54a2e08`, per owner request.

- `CONTROLLER_UNLOCK_VALUE = "enabled"` —
  `app/server/controller/controller-profile.server.ts:77`;
  `unlockFlag(raw)` = `raw?.trim().toLowerCase() === CONTROLLER_UNLOCK_VALUE`
  `:78-80`. **`disabled`, unset, and any other value — a typo included — keep the
  section LOCKED (fails safe/closed).**
- `CONTROLLER_UNLOCK_VALUE_VIEW = "enabled"` —
  `app/features/org-settings/controller-admin-panel.tsx:79`, used in the lock note
  `:335`, drift-pinned against the server's at
  `controller-admin-panel.test.tsx:427`.
- Refusal sentence interpolates the constant —
  `controller-profile.server.ts:228`.
- `.env.example:179-190` (block header `:179`, values `:187-190`), `compose.yml:43-55`
  (defaults `disabled`), `env.server.ts:166-172` comment.
- **This is a behavior NARROWING**, not a string swap: `"1"`, `"true"`, `"YES"`
  used to unlock and now do not. `org-settings-route.server.test.ts:615-640` locks
  that `enabled` / `" ENABLED "` unlock while `disabled` and a stale `"1"` do not.

---

## What an implementer must know now

1. **Reserved MCP names live in ONE list.** `app/shared/mcp-reserved.ts:29` — both
   underscore AND hyphen spellings of `viberr`, `viberr_agent`, `viberr_browser`,
   `viberr_controller`, `viberr_ops`. Adding an in-process server means adding both
   spellings here FIRST; the writer, the picker and the run-time resolver all read
   it, and the resolver is the layer that actually decides what mounts.
2. **`viberr_ops` is unremovable by construction, not by a guard.**
   `buildControllerMounts` (`controller-run.server.ts:150`) reads no config and
   writes no grant row. Do not add a toggle for it — a toggle with no effect is the
   P14-KM-14 class this ruling exists to avoid.
3. **Every `read_run_log` page is bounded.** `DEFAULT_LOG_LINES = 200` /
   `MAX_LOG_LINES = 500` (`controller-ops-mcp.server.ts:98-99`), clamped on both
   directions; `since` with `before` is refused, never silently resolved.
4. **Never relay `getRunLog`'s `headSeq`/`oldestSeq`/`hasMore` to a model.** They
   are page-local cursors for a stateful console. Report
   `page.{firstSeq,lastSeq,olderExist,newerExist,next}` against the run's real
   bounds plus `run.logLines` (`:281-313`).
5. **`instance_health`'s reading is open; its credential DETAIL is org-admin only**
   — the detail names the deployment's config directory, i.e. a host path.
6. **Controller config sections are LOCKED by default.**
   `controllerSectionLocks()` (`controller-profile.server.ts:84`) is env-only; the
   unlock value is the literal string `enabled` (trimmed, case-insensitive).
   `disabled`, `1`, `true`, unset — all keep it locked.
7. **Lock enforcement lives in `saveControllerConfig`, not the route** (`:203`), so
   every save path is bound. `ctx.locks` exists for tests only.
8. **Blank keeps.** Under a lock, an empty grant list or blank doctrine means "keep
   the stored value" and PASSES; only a non-empty differing value is refused. The
   panel deliberately posts blank for locked sections so a stale page copy can
   never read as a change.
9. **A locked section writes the STORED array verbatim** (order and duplicates) —
   byte-stable by construction (`:242`). Never re-serialize it from a Set.
10. **Model and effort are NOT sections** and stay editable under every lock.
    `definitionEdited` in the audit row is true only when the doctrine file was
    actually rewritten (`:303`).
11. **`effort` is an agent-profile frontmatter key, and it must stay tolerant** —
    `z.string().optional().catch(undefined)`
    (`agent-profile-file.server.ts:53`). A strict key here bricked the whole config
    as "profile missing from the store" over one hand-edited line. Only the
    controller reads it (`controller-profile.server.ts:177`).
12. **Never rewrite a stored Claude model a run would execute verbatim.**
    `claudeModelRunsVerbatim` (`app/shared/model-ids.ts:36`) — family aliases plus
    `DATED_CLAUDE_ID_RE = /^claude-.*\d/`. A picker that "corrects" one of these to
    the catalog default performs a silent model change.
13. **Reuse the editor primitives, do not re-copy them**: `useModelCatalog` /
    `ModelCatalogState` / `ModelEffortFields`
    (`create-profile-modal.tsx:128/:118/:510`), `MissingChips` / `kbDirsOf` /
    `kbLegacyOf` (`agent-template-modal.tsx:69/:34/:49`). KBs display by NAME,
    store by DIR, and the display-name repair runs on open.
14. **`.ctladm-*` is down to two rules** (`app.css:5253-5254`); the controller tab
    uses `.field` / `.flabel` / `.pick-chips`. Read-only fields use the
    `[readonly]` rules at `:2267,:2270`; lock glyphs use `.lbl-lock` `:2276`, which
    is only sized inside `.flabel` / `.ctx-lbl`.
15. **The radius and spacing scales are gated with NO allowlist** —
    `app.css.test.ts:2588` and `:2651`. A seventh radius or a tenth de-facto
    spacing value is a deliberate widening of the scale, made in that file.
16. **`PACKET_OPTION_KINDS` is 11** (`task-file.schema.ts:117-165`).
    `resolve_remote_collision` `:163` keeps the LOCAL delivery and clears the
    REMOTE; `discard_branch` `:154` destroys LOCAL commits. Never offer discard for
    a collision — authoring refuses it (`operator-actions.server.ts:1023-1046`).
17. **Packet UI has ONE destructive shell and ONE tier table.**
    `PacketDestructiveConfirm` (`decision-packet.tsx:140`), `PACKET_TIER_GATES`
    `:536` consulted via `gateFor` `:762`, `CONFIRM_FIRST_KINDS` `:607`,
    `pendingConfirm` as a single slot `:692`. A new gated or destructive kind is a
    row in the map — never a sixth `o.kind === "…"` chain.
18. **`resolve_remote_collision` resolution order**: resolution write → close the
    unowned PR (best-effort, audit `github.pr.closed_unowned`) → delete the remote
    ref through the audited path (its refusals bind) → clear `github.unownedPr` →
    `manualDeliverForReview` → lift `readiness: blocked → ready` ONLY on success
    (`task-actions.server.ts:6846-6909`). Every degradation lands on the timeline.
19. **Reconciler positive-provenance rule**: record a branch footprint only when
    `provenBranchHead = deliveredThisBranch && !unownedPr`
    (`github-reconciler.server.ts:561-563`). The absence of a stranger's PR is NOT
    evidence. A footprint with no provenance is DROPPED, not carried forward.
20. **`unownedPr` is threaded end to end**: github cache → `TaskSummary`
    (`shared/mapping/task.server.ts:222,641`) → `GithubTrace` collision row
    (`task-side-panels.tsx:295`) → `PacketArchiveDisclosure` (required,
    `decision-packet.tsx:125`) from `task-detail-page.tsx:738` → the operator
    snapshot (`operator-actions.server.ts:1475`). A new TaskSummary consumer must
    supply it.
21. **`heldAtStage` has exactly one writer and five clearers.** Written at
    `operator-run.server.ts:813` (a nudged drive that strands AGAIN); cleared at
    `task-actions.server.ts:502, 590, 4548, 6522, 7882`. Both `frontmatter.stage =`
    writers clear it — any new stage writer must too. A manual operator drive
    deliberately does NOT clear it.
22. **`strandedResume` is the one-paid-nudge marker.** It survives trigger
    coalescing (`operator-run.server.ts:446-447`) and is deliberately `false` on
    cross-boot plan recovery (`:2048`).
23. **`tolerantRowsOf` (`file-diagnostics.ts:75`) is the per-row tolerance idiom.**
    Use it; do not hand-roll a fourth copy. Container handling (absent field,
    non-array value) legitimately differs per site and stays with the caller.
24. **A malformed packet OPTION drops only itself** (`task-file.server.ts:392`,
    diagnostic `packet.invalid_option`). This supersedes F20-6's whole-packet-null
    arm, which was durable loss.
25. **`notifyTaskWatchers` takes `exceptUserIds`** (`task-mutation.server.ts:145`,
    applied `:190`) for per-recipient dedupe.
26. **`StuckLoopEscalation`** (`task-actions.server.ts:2248`) is
    `{status:"opened", notifiedUserIds}` | `{status:"already_open"}` |
    `{status:"failed"}`. **Only `"opened"` means a notification went out**; the
    other arms leave the caller owing one.
27. **The @mention fan-out scans PRE-trim text.** `mentionSourceText` on
    `PreparedReply` (`task-actions.server.ts:1808`, set `:1937`, read `:2109`,
    `:2701`, `:2970`); the operator path uses its own pre-trim `text`.
28. **Operator narration is stored VERBATIM.** No write-time cap exists;
    `CommentTrim` is the single member `"evidence-separation"`
    (`comment-guardrails.server.ts:73`); `DEFAULT_GUARDRAILS` is 4 rows
    (`templates.ts:93`). Re-introducing a cap anywhere on the write path fails the
    `operatorPostComment` lock.
29. **`withAmbiguityDisclosure` balances an unclosed ``` fence** before appending
    (`mention-notify.server.ts:195-208`) — it is the only tail-adder, and this is
    the one job the deleted truncation did that had to survive.
30. **The audit purge exports first and fails CLOSED.**
    `<dataRoot>/audit-exports/audit-events-<YYYY-MM-DD>.jsonl`
    (`retention.server.ts:106`); a failed export SKIPS that pass's DELETE
    (`:214-221`). The row schema is a `looseObject` on purpose. `runMaintenancePass`
    must keep forwarding its `dataRoot` (`maintenance.server.ts:153`).
31. **Repo-write is a BOTH-backend enforced capability again.** Codex binds it
    through `resolveCodexSandboxMode` (`codex-runtime.server.ts:377`): withheld →
    `read-only`; withheld AND evidence-granted (`attachmentsWritableDir`) →
    `workspace-write` (the one disclosed carve-out); operator → `read-only`.
    The three SCOPED delivery commands stay claude-only at the tool layer — the
    sandbox is all-or-nothing.
32. **Claude's kind-based supporting denylist is delivery-only now**:
    `SUPPORTING_DELIVERY_DENIED_BUILTINS` (`claude-runtime.server.ts:259`) =
    `git push`, `gh pr create`, `gh pr merge`. Local-write posture rides the
    grant-derived `disallowedTools`. A write-GRANTED supporting agent may edit its
    own isolated checkout.
33. **Native Claude skills are gated on the excludes FILE, not on
    `managedSettings`.** The SDK silently drops `claudeMdExcludes` (live-verified).
    `nativeSkillsForRun` (`claude-runtime.server.ts:371`) mounts nothing unless
    `ensureCatalogSettings(workdir)` (`skill-mount.server.ts:472`) holds. The file
    carries excludes ONLY — never hooks, never permissions.
34. **Browser working artifacts are classified by the machine STAMP, not a prefix
    allowlist** (`task-attachments.server.ts:146`), and visual evidence
    (`png/jpe?g/webp/gif/pdf`, `:151`) always stays.
35. **The prune runs only on success paths**: `state === "finished"` AND zero live
    sibling runs on the task (`task-actions.server.ts:3326-3368`). An errored run's
    console dump is often its only diagnostic; the mtime window is task-wide.
36. **A citation of the EXACT filename keeps a file** — reply text, Codex
    `fullText`, evidence rows, the ask-human question, or any timeline text since
    run start. ENOENT on unlink counts as PRUNED; any other failure keeps the file
    listed, because the producing event must never claim a file the directory does
    not hold. `attachmentNamesSince` (`:108`) deliberately bypasses the 100-file
    `LIST_CAP`.
37. **Lightbox factory contract**: it intercepts EVERY plain click on EVERY
    attachment kind (image → picture, viewable text → reader, anything else →
    no-preview card); modified clicks and provider-less renders fall through to the
    real anchor. The markdown `a` renderer intercepts only a clean single-segment
    name under the attachments base (`markdown.tsx:279-284`).
38. **Download is universal**, via `?download=1`
    (`routes/task-attachment.ts:56,66`) plus the `download` attribute. It is hidden
    ONLY where a fetch PROVED the file unservable; the image branch never hides it,
    because `<img onError>` cannot tell a 404 from a corrupt-but-servable file. The
    text viewer caps display at 200 000 chars and cancels the stream
    (`attachment-lightbox.tsx:81,105`); a redirected response is a load failure,
    never content.
39. **Quota exhaustion needs the PROVIDER's own sentence.** `·quota` classification
    alone is not enough — both classifiers fold transient 429s into the class.
    `quotaExhaustionEvidence` (`backend-quota.server.ts:152`) reads only the half
    after `"\n\nThe provider reported: "`. Undated records expire after 6 h; prose
    resets get a 24 h grace; an exact provider-emitted instant gets none. A run
    reaching `finished` retires the flag — the real run IS the re-probe.
40. **`RunKind` is a DELIVERY axis, not a role taxonomy**
    (`runtime-types.ts:24-33`): `reviewer` = any non-delivering specialist run.
    Two partial unique indexes and the `0001_baseline.sql` CHECK depend on this
    reading. Read `role`/`agent_profile_id` for "who"; read `kind` only for "does
    this run own delivery". And every timeout knob is now a LAZY function
    (`cloneTimeoutMs()`, `claimLeaseMs()`, `mirrorTimeoutMs()`,
    `claudeIdleTimeoutMs()`) so `resetEnvCacheForTests` reaches it.

---

## Findings for the pass-32 ledger

Candidates from these diffs — defects, incomplete thread-throughs, dead code and
copy inconsistencies. None was fixed here; this document is read-only reference.

**P32-A — `execute-code-or-write-repo` is listed TWICE in `ENFORCED_CAPABILITY_IDS`.**
`app/shared/capabilities.ts:228` and `:259`, inside the same `new Set([...])`
literal. Ruling 101's commit added `:259` without noticing the entry already at
`:228` (verified: `git show f868f131:app/shared/capabilities.ts` has it at 228 too,
while ALSO being in `CLAUDE_ONLY_ENFORCED_CAPABILITY_IDS`). The `Set` de-dupes so
behavior is correct, but the decisions.md sentence "the capability moves back to
`ENFORCED_CAPABILITY_IDS`" is imprecise: it never left. What actually flipped the
answer to `"both"` was its REMOVAL from the claude-only set, which
`capabilityEnforcement` checks first (`:303-304`). **Confidence: high (verified
both sides). Impact: cosmetic, but it hides which line is load-bearing.**

**P32-B — `SkillMount.settingsWritten` has no production consumer.**
Declared `app/server/runtimes/skill-mount.server.ts:264`, set at `:308`, `:315`,
`:372`; read only by `skill-mount.server.test.ts:231,245,750`. The one caller that
receives a `SkillMount` (`specialist-run.server.ts:1564`, `:2805`) uses `.mounted`
and `.skipped` and ignores it. The gap is documented in code
(`claude-runtime.server.ts:364-369`): when the excludes file goes missing AFTER the
mount and the repair also fails, the persona has already announced the skills to
the agent and they are not enabled — "a real capability loss for that run", closable
by threading `settingsWritten` into `buildSpecialistPersona`. **Confidence: high
(the code says so). Classic pass-28 shape: a new field one consumer reads and
another ignores.**

**P32-C — the `"\n\nThe provider reported: "` marker is duplicated five ways with
no drift pin.** Exported const `app/server/tasks/agent-reply.server.ts:548`;
private copy `app/server/runtimes/backend-quota.server.ts:135` (documented as
deliberate, to avoid an import cycle); inline literals at
`claude-runtime.server.ts:725`, `:1034` and `codex-runtime.server.ts:685`; and a
DIFFERENT shape (single leading space, no blank line) at
`controller-run.server.ts:423`. Nothing tests that the writers and
`providerSentence` agree. If a writer's literal drifts, `quotaExhaustionEvidence`
silently falls back to judging the WHOLE line — which its own comment
(`backend-quota.server.ts:139-143`) says "would defeat `USAGE_LIMIT_RE` entirely",
i.e. transient 429s start recording as exhaustion again (the V4 defect). PR #253
added the consumer that makes this load-bearing. **Confidence: high on the
duplication and the missing pin; medium on likelihood of drift.**

**P32-D — `resolveCodexSandboxMode`'s docblock claims the controller is read-only;
the code never checks for it.** `codex-runtime.server.ts:365-366` says "The
operator (and the Claude-only controller) are coordination machinery … structurally
`read-only`", but the early return at `:380` is `spec.kind === "operator"` only,
and `isDeliverer = spec.kind !== "reviewer"` at `:396` treats `controller` as a
deliverer — so an autonomous controller run with egress would resolve to
`danger-full-access`. Unreachable today (ruling 106 fixes the controller backend to
Claude), but it is a latent trap the comment actively conceals.
**Confidence: high on the mismatch; impact currently nil.**

**P32-E — a locked controller section cannot be cleared, and says nothing.**
`resolveGrant` (`controller-profile.server.ts:238-243`) refuses only a NON-EMPTY
differing list. A caller that posts an empty list under a lock — intending "remove
every grant" — gets a silent no-op with no refusal and no message, indistinguishable
from the panel's own blank-keeps post. Deliberate (the blank-keeps fix for review
#2 needs it), but the asymmetry is undocumented outside the code comment, and a
scripted caller is told nothing. **Confidence: high that this is the behavior;
medium that it deserves a fix (a refusal cannot be added without breaking
blank-keeps, so the honest remedy is docs).**

**P32-F — `resolve_remote_collision` silently no-ops for an actor with no
`userId`.** `task-actions.server.ts:6846` guards the whole remedy block with
`option.kind === "resolve_remote_collision" && actor.userId`. The guard is needed
(`resolveRemoteBranchCollision` uses `actor.userId!` at
`github-reconciler.server.ts:1618`), but the false arm resolves the packet, clears
it, and does nothing — no PR closed, no branch deleted, no re-delivery, and no
timeline note explaining why. The `approve-transition` tier should make a
userId-less actor unreachable today. **Confidence: high on the code shape; low on
reachability. Worth a defensive note or an explicit refusal.**

**P32-G — `ControllerSectionLocks` is declared twice, structurally.**
`app/server/controller/controller-profile.server.ts:49` (server) and
`app/features/org-settings/controller-admin-panel.tsx:60` (client mirror), likewise
`CONTROLLER_SECTION_LABEL` vs the panel's private `SECTION_LABEL` `:83`. The
env-var map and the unlock VALUE are drift-pinned by test
(`controller-admin-panel.test.tsx:427`), but the interface and the label map are
hand copies. A client/server split makes some duplication unavoidable (the server
module is `.server.ts`), but the labels could live in a shared module the way
`mcp-reserved` and `model-ids` now do. **Confidence: high. Impact: low, partly
mitigated by the drift test.**

**P32-H — the audit-list keyboard fix has no automated lock.**
`org-settings-page.tsx:275-276` added `tabIndex={0}` + `aria-label="Recent audit
events"` for axe `scrollable-region-focusable`; the new test in
`org-settings-page.test.tsx` asserts only the rewritten card COPY. The regression it
fixes reappears the moment someone rewrites that `<ul>`. **Confidence: high (no
matching assertion found). Impact: low.**

**P32-I — the `retry after` date in the quota panel is rendered from
`toISOString().slice(0,10)`, i.e. UTC, for prose-derived resets.**
`insights-page.tsx` V9 branch. This is deliberate (the account's timezone is
unknown, so a to-the-minute local time would be a claim the app cannot stand
behind), but a UTC calendar date is still a specific timezone's answer and can be a
day off for a user near a date boundary. The code comment says "the calendar DATE it
named" — which is the provider's date, not necessarily UTC's.
**Confidence: medium. Impact: low, cosmetic honesty.**

**P32-J — `.env.example` gained a trailing blank line** at the end of the ruling-108
block (file is 191 lines; `:191` is empty). Cosmetic; noted only because the file is a shipped
reference document. **Confidence: high. Impact: nil.**

**Not findings (checked and clean):** no `TODO`/`FIXME`/`HACK` was introduced
anywhere in the range; no new SSE event was added; `canReadControllerRunLog` has no
stale importers after the move; both `frontmatter.stage =` writers clear
`heldAtStage`; `github.branch.deleted` pre-dates this range (only
`github.pr.closed_unowned` is new).
