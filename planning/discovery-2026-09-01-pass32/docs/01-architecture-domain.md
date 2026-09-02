# 01 — Server core & domain model (pass 32, 2026-09-01)

Audience: an implementer who must change server code without re-reading the tree.
Everything below is cited `path:line`, re-resolved against **main @ 68b5480e**
(2026-09-01, after PRs #253–#264). Paths are repo-relative to
`/Users/akinozer/projects/viberr`.

Supersedes `planning/discovery-2026-08-31-pass31/docs/01-architecture-domain.md`,
whose citations predate PR #253 (pass-31 implementation), #254 (rulings 100–103),
#257 (ruling 104), #258/#259 (ruling 105), #260 (ruling 106), #261 (ruling 107)
and #262–#264 (ruling 108). Rulings 100–108 live in
`docs/architecture/decisions.md:1422` (100), `:1432` (101), `:1457` (102),
`:1464` (103), `:1469` (104), `:1490` (105), `:1519` (106), `:1552` (107),
`:1606` (108).

---

## 0. The one-paragraph model

Viberr is **file-canonical with a SQLite projection**. The business truth for
projects, tasks and goals is Markdown-with-YAML-frontmatter under
`${VIBERR_DATA_ROOT}`; `state/projection.sqlite` is a *derived read model* for
those three entity kinds and **primary storage** for everything app-owned
(users, sessions, PATs, audit, notifications, runs, org resources, controller
conversations). Every UI action is a React Router route `action` that (a) checks
CSRF + authority, (b) performs a locked read-modify-write on the canonical `.md`,
(c) synchronously re-projects that one file, (d) emits an in-process projection
event which the SSE broker fans out. A chokidar watcher does the same for hand
edits. There is exactly **one app process per data root, ever** — enforced by an
O_EXCL `writer.lock`.

Layer map (`docs/architecture/file-formats.md:1`, `docs/architecture/decisions.md`):

```
routes/*.tsx  action()  ──▶ app/server/tasks/*.server.ts     (governed mutations)
                            │  authority: app/shared/rbac.ts + auth/project-authority
                            ▼
                        app/server/files/*.server.ts          (atomic locked writers)
                            │  parse/serialize: app/schemas/*.schema.ts (tolerant)
                            ▼
                        app/server/projections/rebuilder.server.ts   (files → sqlite)
                            │
                            ├─▶ app/server/events/projection-events.server.ts (EventEmitter)
                            │        └─▶ events/event-publisher → events/sse-broker → clients
                            └─▶ app/server/provenance/ (audit trail of every projection act)
```

**What changed in this domain since pass 31** (detail in each section):

| # | change | where |
|---|---|---|
| 1 | `resolve_remote_collision` — an **eleventh** packet option kind | `app/schemas/task-file.schema.ts:155` |
| 2 | `heldAtStage` — new task frontmatter key (durable deliberate-hold marker) | `app/schemas/task-file.schema.ts:620` |
| 3 | `tolerantRowsOf` — the F18 per-row idiom extracted and shared | `app/schemas/file-diagnostics.ts:75` |
| 4 | packet **options** now parse per-row (C5); `observations` still do NOT | `app/server/files/task-file.server.ts:378-403` |
| 5 | audit purge **exports before it deletes** (ruling 102, FR33) | `app/server/db/retention.server.ts:164-260` |
| 6 | `effort` is a first-class agent-profile frontmatter key, tolerant | `app/server/files/agent-profile-file.server.ts:51` |
| 7 | health snapshot extracted so the route and `viberr_ops` share one derivation | `app/server/ops/health-snapshot.server.ts:64` |
| 8 | `viberr_ops` — the controller's built-in, non-removable diagnostics MCP | `app/server/controller/controller-ops-mcp.server.ts:127` |
| 9 | shared controller tool guards (one refusal voice, two servers) | `app/server/controller/controller-tool-guards.server.ts:79` |
| 10 | `RESERVED_MCP_NAMES` single-sourced across writer/picker/**resolver** | `app/shared/mcp-reserved.ts:29` |
| 11 | controller config sections **deployment-locked by default** (ruling 108) | `app/server/controller/controller-profile.server.ts:84,203` |
| 12 | browser working-artifact prune + text-attachment viewer whitelist | `app/server/files/task-attachments.server.ts:146-260` |
| 13 | operator narration stored **verbatim** (brevity cap + guardrail row deleted) | `app/server/tasks/comment-guardrails.server.ts:73`, `app/shared/workflow/templates.ts:93` |
| 14 | repo-write parity: `execute-code-or-write-repo` is **both-backend** enforced again | `app/shared/capabilities.ts:253,281` |
| 15 | `outcome_key` writes through the typed `RunPatch` (raw UPDATE removed) | `app/server/runtimes/run-store.server.ts:153,181` |
| 16 | six env keys declared (three C3 + four unlock flags), gaps remain | `app/server/config/env.server.ts:163-176` |
| 17 | `unownedPr` on `TaskSummary`; coordination-overhead insight | `app/shared/mapping/task.server.ts:220`, `app/server/insights/insights-query.server.ts:96` |

---

## 1. Event-sourcing / file-native architecture

### 1.1 Data-root layout

`DATA_ROOT_SUBDIRS` — the complete set created at boot —
`app/server/files/file-store-root.server.ts:26-41`:

```
${VIBERR_DATA_ROOT}/
  projects/<slug>/project.md                 ← project truth
  projects/<slug>/tasks/<KEY>/task.md        ← task truth
  projects/<slug>/tasks/<KEY>/attachments/   ← browser-run outputs (member-only route)
  projects/<slug>/tasks/<KEY>/workspace/     ← git clone; NOT canonical, NOT watched
  projects/<slug>/goals/<id>.md              ← chained-goal truth (ruling 99)
  agents/profiles/<id>.md                    ← org agent-profile templates
  agents/definitions/<id>.md                 ← operator/controller doctrine bodies (NOT in SUBDIRS)
  runtimes/claude-home/ runtimes/codex-home/ ← NDJSON run logs + SDK session homes
  kb/<dir>/    skills/<slug>/                ← knowledge bases + skills
  audit-exports/audit-events-<YYYY-MM-DD>.jsonl  ← ruling 102 pre-purge record (NOT in SUBDIRS)
  state/projection.sqlite                    ← the projection DB
  state/writer.lock                          ← single-writer lock (not in SUBDIRS)
  state/shipped-assets.json                  ← shipped-asset SHA manifest
```

There is deliberately **no** `cache/`, `auth/` or `logs/` dir (P11-56;
`docs/architecture/file-formats.md:28`). Logs are structured JSON on stdout.

`agents/definitions/` and `audit-exports/` are created **lazily** by their
writers (`writeFileAtomic` mkdir -p; `mkdirSync` at
`app/server/db/retention.server.ts:180`) and are therefore absent from
`DATA_ROOT_SUBDIRS` and from the layout block in `file-formats.md`.

Path helpers (all take an optional `dataRoot` override for tests):
`getDataRoot` `:43`, `ensureDataRootDirs` `:48`, `projectFilePath` `:64`,
`taskDir` `:68`, `taskFilePath` `:72`, `taskAttachmentsDir` `:87`,
`goalsDir` `:96`, `goalFilePath` `:102`, `agentProfileFilePath` `:121`,
`kbDirPath` `:168`, `skillDirPath` `:178`, `storeRelativePath` `:187`.
(All unchanged since pass 31.)

**Traversal guard**: `resolveStoreSegment(root, name)`
(`file-store-root.server.ts:141`) rejects `""`, `.`, `..`, `/`, `\`, `\0` and
absolute paths, then re-checks the resolved child stays under root. Every
segment that can arrive from a form field, a `readdir`, or a profile's
`resources:` array goes through it — KB/skill content is injected as *trusted
persona material*, so an escape crosses a prompt trust boundary.

`VIBERR_DATA_ROOT` defaults to `./data` (`app/server/config/env.server.ts:80`);
compose points it at `docker-data`.

### 1.2 File format: frontmatter + sections

`splitFrontmatter` (`app/server/files/frontmatter.server.ts:31`) — unchanged:

- strips a BOM and normalizes `CRLF`/lone-`CR` → `LF` **before** the fence check
  (`:42-44`). F28-D2: without this a `---\r\n` file failed the opening-fence
  test and the *whole* file fell back to defaults — and the rebuilder projected
  that (the write-guard only refuses writes, never reads).
- missing fence → `frontmatter.missing` **hardStop** error `:47`;
  unterminated → `frontmatter.unterminated` hardStop `:59`;
  bad YAML → `frontmatter.invalid_yaml` hardStop `:77`.
- `toYaml` uses `lineWidth: 0` (no folding, round-trip friendly) `:91`.
- `serializeFrontmatterFile(known, unknown, body)` `:99` merges known keys in
  canonical order (insertion order of `known`), then any unknown key not already
  present — **unknown frontmatter keys round-trip verbatim**.

`task.md` body grammar — parse/serialize in
`app/server/files/task-file.server.ts` (596 lines):

- Sections split on `^## ` (`SECTION_RE :64`, `splitSections :126`). Known:
  `Goal`, `Packet`, `Timeline`. Everything else is preserved verbatim in
  `extraSections` (including the pre-first-section preamble, title `""`).
- **Duplicate known section → FIRST occurrence wins**, the duplicate is kept as
  an extra section and flagged `body.duplicate_section` (warning ⇒ readiness
  floors at `input_required`) — `duplicateSection :478-487`, dispatch `:489-520`.
- Timeline entries are **newest first**; heading is
  `### <UTC ISO> · <type> · <actor-ref>` with `SEP = " · "` (U+00B7) `:66`.
  Optional metadata lines directly after the heading: `title: …`, `to: agent`
  (`:202-217`). Then blank line, then body text, then optional `evidence:` and
  `attachments:` blocks (`:219-269`).
- 11 event types, `TIMELINE_EVENT_TYPES`
  (`app/schemas/task-file.schema.ts:108-125`): `comment completion github policy
  note quality transition blocked agent assign continuity`. Unknown types are
  KEPT with a `timeline.unknown_type` info diagnostic and render as comments
  (`task-file.server.ts:178-186`).
- **Body-line escaping** is bijective. `STRUCTURAL_LINE_SRC` `:73` =
  `## |### |title:\s|to:\s|\s*evidence:\s*$|\s*attachments:\s*$`. Serialize adds
  one `\` to any line matching `NEEDS_ESCAPE_RE = ^\\*(?:…)` `:75,80`; parse
  strips exactly one from `ESCAPED_LINE_RE = ^\\+(?:…)` `:77,86`. Goal prose uses
  the narrower `NEEDS_SECTION_ESCAPE_RE = /^\\*## /` `:104` — only `## ` can
  close a section, and escaping `title:` in prose would mangle sentences.
  Without the goal escape, an agent-authored goal containing `## Timeline` could
  **forge the history the acceptance decision reads** (`:90-103`).
- Out-of-order timeline (external appenders adding at the bottom) is tolerated
  with a `timeline.out_of_order` info diagnostic `:543-552`.
- Malformed heading → `timeline.malformed_heading`, entry SKIPPED `:152-161`;
  unparseable timestamp → `timeline.invalid_timestamp`, skipped `:168-176`;
  unrecognized actor → `timeline.unknown_actor` warning but the entry is **kept
  verbatim** `:191-200`. The task itself is never dropped.

Packet section is a single fenced ```yaml block, parsed by `parsePacketSection`
`:348`. A packet with options but ≠1 `rec: true` emits `packet.rec_count` info
`:407-416`.

**NEW (C5 / pass 31)** — packet **options** now parse per-row `:378-403`: an
`z.object({options: z.array(z.unknown())}).loose()` probe pulls the raw options
out, `tolerantRowsOf` validates each against `packetOptionSchema` (bad rows drop
with `packet.invalid_option` warnings), and the repaired object is then fed to
`taskPacketSchema`. Rationale in the comment at `:379-385`: a whole-array parse
voided the WHOLE packet on one malformed row, the human lost the card while the
task still read `waiting: human`, and the next `updateTaskFile` serialized the
packet section away entirely (`serializeTaskFile` writes `## Packet` only
`if (parsed.packet)` `:578`). **`observations` was not given the same treatment
— see Findings.**

**Actor refs** — codec `app/server/files/actor-ref.server.ts` (unchanged):

| kind | encoding | regex |
|---|---|---|
| human | `user:<id> (Name)` | `HUMAN_RE :28` |
| agent | `agent:<codex\|claude>/<profileId> (Role)` | `AGENT_RE :32` |
| operator | `operator` | literal `:98` |
| controller | `controller` | literal `:100` |
| system | `system:<id>` | `SYSTEM_RE :33` |
| unknown | verbatim raw | fallthrough `:122` |

`decodeActorRef` is **total** — it never returns null. VIB-12: a strict decoder
rejected `&` in a role slug, decode returned null, and the timeline parser
silently DROPPED the reviewer's comment on every re-parse (`:22-26`). Agent
identity is the **profileId**, never the role string (`:14-21`).
`sanitizeHint` `:66` strips ` · ` and newlines so a display hint can never
corrupt the heading it lives in.

Goal files (`app/schemas/goal-file.schema.ts`) use a deliberately *simpler*
grammar: `## Description` prose + `## Timeline` bullets `- <ISO> · <text>`
(`:14-17`) — single-writer app narration needs no escaping machinery. Unlike
task/project files, goal parsing is **all-or-nothing**:
`parseGoalFileContent` (`app/server/files/goal-writer.server.ts:67`) returns
`null` on any schema failure, and `diagnoseGoalFileContent :119` emits every
issue as a **hardStop** — documented at `:106-117` ("a goal whose frontmatter the
schema rejects has no partially usable form"). `updateGoalFile :265` refuses with
a 409 rather than writing over an unreadable file `:276-280`, so there is no
durable-loss path here.

### 1.3 Tolerant parsing + diagnostics

Contract (`app/schemas/file-diagnostics.ts:3-17`): parsing never throws, never
drops an entity; missing/invalid fields yield a fallback plus a
`FileDiagnostic { severity, code, path?, message, hardStop? }` (`:21`).
Constructors: `diagInfo :34`, `diagWarning :44`, `diagError :54`.

Severity → readiness floor (`app/server/interpretation/diagnostics-policy.server.ts`):

| severity | floor | rank |
|---|---|---|
| `info` | none | — |
| `warning` | `input_required` | 1 |
| `error` | `inconsistency_risk_detected` | 2 |
| `hardStop` (any severity) | `blocked` | 3 |

`READINESS_RANK :20`, `readinessEffectOf :28`, `worstReadinessEffect :41`.
`referenceDiagnostics({stage, knownStageIds})` `:58` adds
`reference.unknown_stage` (warning) when the task's stage id is not in the
project's list — the *only* project-context check today.

`deriveReadiness` (`app/server/interpretation/readiness-policy.server.ts:36`)
is **THE** readiness derivation: stored readiness is respected, diagnostics can
only make it WORSE, never better (`:44-47`). `"accepted"` is a display state
derived from being in the terminal stage (`isAcceptedDisplayState :55`) and is
never stored.

**Three parse helpers now, and the difference matters a lot:**

- `tolerant(...)` — **whole-value**; a bad value falls back to the default
  (`task-file.schema.ts:1029`).
- `tolerantRows(...)` — **per-row** over a named frontmatter key
  (`task-file.schema.ts:1074`, docblock `:1064-1073`). Project-file twin
  `tolerantArray` (`project-file.schema.ts:296`).
- **NEW: `tolerantRowsOf(diagnostics, rows, element, code, describe)`**
  (`app/schemas/file-diagnostics.ts:75`) — the extracted loop body (V17). Both
  `tolerantRows` `:1092` and `tolerantArray` `:326` now delegate to it, and so
  does the packet-option probe in `task-file.server.ts:391`. Callers keep their
  own container handling (absent field, non-array value) because that part
  legitimately differs per site (`file-diagnostics.ts:65-72`).

F18 reason, quoted at `task-file.schema.ts:1064-1073`: the whole-array path
emptied the ENTIRE list on one bad row, the diagnostic was only a warning (so the
file stayed writable), and the next `updateTaskFile` serialized the emptied list
back — a **durable, silent loss**.

Per-row lists today: task `engagements` (`parseEngagementRows :1112`, used by
`parseEngagements :1124`), `recommendations :1313`, `schedules :1322`,
`labels :1347`, `verdicts :1381`; packet `options`
(`task-file.server.ts:391`); project `stages :418`, `workflow :419`,
`members :420`, `agents :421`, `guardrails :434` (a wiped `members[]` is an ACL
wipe; a wiped `guardrails[]` reads as "everything off").

Identity rescue: task `key` falls back to the **directory name** and the
directory wins on mismatch (`frontmatter.key_mismatch`, error) —
`task-file.schema.ts:1189-1220`. Same for project `slug`
(`project-file.schema.ts:356-388`). A missing `stage` becomes `""` +
`frontmatter.unresolved_stage` warning, never an invented `triage`
(`task-file.schema.ts:1235-1250`) — the blank stage lands the card in the
board's "unknown stage" bucket instead of silently relocating it.

Extra invariants enforced at parse time in `parseEngagements`
(`task-file.schema.ts:1124`): profileId uniqueness (first wins,
`frontmatter.duplicate_engagement :1146`) and **at most one `delivers: true`**
(extras demoted, `frontmatter.multiple_deliverers :1165`).

### 1.4 Writers: atomic + mutex + write-guard + stale-read repair

`writeFileAtomic(absPath, content)` — `app/server/files/atomic-file.server.ts:31`:
mkdir -p, write `<file>.<8 hex>.tmp`, `rename` over the target. On failure the
tmp file is `rmSync`'d (Gap 16 — failed writes used to leak permanent litter the
watcher ignores). `ENOSPC` → a named error `:57`; `ESTALE`/`EIO` → a typed 503
`AppError` "data root unreachable" `:69-77` (F20-1: a dead VirtioFS bind mount
used to peg the event loop instead of erroring).

`withFileLock(key, fn)` — `app/server/files/file-mutex.server.ts:1` — is a
one-line wrapper over the Web Locks API (`navigator.locks.request`). Per-file,
in-process only.

`updateTaskFile(ref, mutate)` — `app/server/files/task-writer.server.ts:165` —
is the single locked read-modify-write:
1. `withFileLock(absPath, …)`
2. `readTaskFile` (404 if absent)
3. `repairStaleRead` `:91`
4. `assertTaskFileTrusted` `:144`
5. `mutate(parsed)`, then `frontmatter.updatedAt = now`
6. `serializeTaskFile` → `writeFileAtomic` → `rememberWrite` `:72`

**Write guard** (`taskFileWriteBlockers :138`, `assertTaskFileTrusted :144`):
any `hardStop` diagnostic refuses the write with
`ERROR_CODES.FILE_NOT_TRUSTED` / 409. Gap 22: tolerant parsing is right for
reading and catastrophic for writing — appending one comment to a file with
unparseable YAML serialized the DEFAULTS over it (owner, stage, engagements, PR
link gone) and an unterminated fence also erased the goal and whole timeline.
`hardStop` is exactly the right line: unknown fields, unknown sections, dropped
packet options and skipped timeline entries are *not* hardStop and still write.

**Stale-read repair** (`repairStaleRead :91`, project twin
`repairStaleProjectRead` at `project-writer.server.ts:75`): on VirtioFS a read
milliseconds after this process's own rename can return the PREVIOUS content.
Live VIB-1 2026-07-17: a reviewer comment landed, the verdict write 2 ms later
read pre-comment content and erased it. `lastWritten: Map<path,{content,
wroteAtMs}>` (cap 500, insertion-ordered eviction `task-writer :69-80`); if the
locked read disagrees AND `mtimeMs <= wroteAtMs + 100`, our own write wins. An
external editor bumps mtime past the slack and wins as before.
**`goal-writer.server.ts` has no such cache** — see Findings.

Other writers with the same shape: `createTaskFile :190`,
`appendTimelineEvent :225` (unshift = newest-first prepend),
`patchTaskFrontmatter :237`, `updateProjectFile
(project-writer.server.ts:100)`, `createProjectFile :120`,
`createGoalFile`/`updateGoalFile` (`files/goal-writer.server.ts:228,265`,
with a whole-`goals/`-dir lock `withGoalsLock :220`).

**Task key allocation** — `allocateTaskKey`
(`project-writer.server.ts:166`): under the project.md mutex, read
`nextTaskNumber`, take `max(counter, scanMaxTaskNumber(prefix)+1)`, persist
`next+1`, return `<PREFIX>-<n>`. The dir scan `:147` rescues a stale or
missing counter. Concurrent creates can never mint the same key.

### 1.5 Projections: files → SQLite

`app/server/projections/rebuilder.server.ts` (1199 lines) is the ONLY writer of
`projects`, `project_members`, `task_projections`, `task_events`,
`goal_projections`, `diagnostics`. **Byte-identical to pass 31** — every citation
below re-verified.

Entry points:
- `rebuildPath(db, absPath, opts)` `:938` — routes an absolute path by regex:
  `TASK_PATH_RE :930`, `PROJECT_PATH_RE :931`, `GOAL_PATH_RE :932`; anything else
  is `ignored`. **All throws are caught here** `:958` → logs "projection rebuild
  failed", records `action: "error"` provenance, returns `{action:"error"}`.
- `rebuildProjectFile :159`, `rebuildTaskFile :376`, `rebuildGoalFile :733`.
- `rebuildProject(db, slug)` `:982` — project-scoped rescan + prune (F20: the
  Board "Re-scan" gate is project-scoped, so its effect must be too).
- `rebuildAll(db)` `:1085` — full walk + prune of vanished rows.

**Content-hash short-circuit**: `sha256(content)` `:97` compared against the
row's `content_hash`; equal + not `force` ⇒ `unchanged`, no provenance row
(`:196`, `:426`, `:769`).

**Sentinel-hash commit marker (F28-D3)**: the row is INSERTed with
`content_hash = ""` (`:239`, `:629`) and the real hash is written **last**
(`:264`, `:709`) after `project_members` / `task_events` / `diagnostics` have
landed. A crash mid-projection therefore leaves an unmatched hash and the next
rebuild re-runs instead of short-circuiting on a torn row. Removals delete
dependents FIRST and the probe's own row LAST for the same reason (`:174-177`,
`:396-404`).

**Project→task cascade**: project-derived data (stage-reference diagnostics,
effective repo, guest flags) is baked into task rows, so a changed project row
force-reprojects every task `:281-288`. `rebuildAll`/`rebuildProject` pass
`skipTaskCascade: true` (`:69`) and do their own forced walk instead (`:1013`,
`:1132`) so tasks are not projected twice per rescan.

**Derivations performed at projection time** (`rebuildTaskFile`):
- `derivedValidation = deriveValidation(fm)` `:443` — the column carries the
  FRESH derivation, never `fm.validation` (which is only a cache). UX19-3: a
  stale cache put "validation healthy" on the card while the gate one argument
  away read "no approving verdict yet".
- `acceptanceBlockReason(fm, {validation, blockedPacket})` `:340` →
  `validation_block_reason` `:582`. Order mirrors `acceptanceRefusalReason`:
  `closedPrBlockedReason` → `acceptanceBlockedReason` → `verdictGateReason` →
  open blocked packet → `conflictingPrBlockedReason`. Three gates are
  deliberately absent: `archived` and the STAGE boundary (per-reader state every
  consumer filters on) and the no-change WORK refusal (needs a live async GitHub
  probe) — documented at `:303-338`.
- `projectedWaiting` `:481` — a task in the **terminal stage** projects
  `waiting: "none"` regardless of the file (LV-20: a Done+merged task reported
  "Waiting on: Human decision" forever). The canonical file is untouched.
- `continuity` `:520` — `"degraded"` iff the timeline carries any `continuity`
  event.
- `storedReadiness` is NULL when a `readiness`-path diagnostic exists `:491`.
- `specialist_json` = `deliveringEngagement(fm)`, `reviewers_json` =
  `supportingEngagements(fm)` `:594-595` (derived legacy shapes).
- `repo` = `project?.repo ?? null` unconditionally `:598` (P13-D-5: no
  task-level override).
- `work_revision_sha` = `fm.workRevision?.headSha ?? null` `:608`.

`heldAtStage` is **not projected** — it is a file-only marker read by the
operator resume backstop (`operator-run.server.ts:787`).

`task_events` are **replaced wholesale** per task (`DELETE` then re-INSERT with
`position` = file order, 0 = newest) `:633-686`. Actor kind/ref are flattened
and `actor_json` carries a denormalized render snapshot resolved through
`createActorResolver` `:507` (so events survive member removal).
`unknown` actors project as `system` so their events stay visible (D7 `:646-655`).

**Goal link reconciliation** `:811-844`: link statuses stored in the goal file
are the advance engine's *claims*; the projection re-derives from live task rows
— archived ⇒ `failed` (unless already `done`), terminal stage ⇒ `done`, and a
stored `done`/`failed` contradicted by a live non-terminal task ⇒ `active`.
`skipped` is never overridden. An unparseable goal file records `action:"error"`
provenance + diagnostics and **leaves the existing row standing** `:783-801`
(visible-but-stale beats vanished).

Every acting rebuild records provenance (`recordProvenance`,
`app/server/provenance/provenance-recorder.server.ts:49`) with
`action ∈ projected | removed | error | rescan`.

### 1.6 Watchers (chokidar)

`startFileWatcher` — `app/server/files/file-watch.service.server.ts:133`
(unchanged).

- Watches `projectsDir()` only `:152,271`; `ignoreInitial: true`,
  `followSymlinks: false`, `atomic: true` `:271-276`.
- Ignore matcher `shouldIgnoreWatchPath :104`: any dot-prefixed path segment,
  any `*.tmp`, and anything deeper than 4 segments that is not exactly
  `<slug>/tasks/<KEY>/task.md` `:110-111`. This prunes traversal into
  `workspace/` clones entirely (F-SPAWN1).
- `WATCH_DEBOUNCE_MS = 250` `:33`, trailing debounce **per path**, separate
  `fileTimers` / `dirTimers` maps `:114-125`.
- Handled events: `add`/`change`/`unlink` → `onFile :258` (accepts
  `project.md`, `task.md`, and `<slug>/goals/<id>.md` `:261-266`);
  `unlinkDir` → `rebuildDir :183`, which maps a vanished directory onto the
  rows it backed (projects root → every project; `<slug>` or `<slug>/tasks` →
  whole project incl. explicit task-row prune, since a `projects` row deletion
  does NOT cascade task rows `:196-205`; `<slug>/goals` → prune goal rows;
  `<slug>/tasks/<KEY>` → schedule the task.md removal).
- Error handling `:285`: `ENOENT` is logged at debug and **ignored**. Any other
  error clears the handle so `isFileWatcherAlive() :350` and `/resources/health`
  report the truth; a transient errno (`EMFILE ENFILE ENOSPC EPERM EACCES`)
  schedules ONE owned, generation-guarded 2 s re-arm `:317-338` (F10-08).
- HMR-safe via `Symbol.for("viberr.fileWatcher")` + a separate lifecycle slot
  carrying `{generation, reArmTimer}` `:48,68`.

`startKbWatcher` (`app/server/files/kb-watch.service.server.ts`) is the
knowledge-base twin: `KB_WATCH_DEBOUNCE_MS = 250 :32` per KB dir,
`ignoreInitial: true` (the initial scan must not bump `last_indexed_at` on every
boot), `followSymlinks: false`; entry point
`reindexKnowledgeBaseByDir` (`org/resources.server.ts:521`), which returns null
when `refresh === "manual"`. Same ENOENT-is-not-broken and
clear-handle-then-re-arm error policy as the file watcher (DM-2).

`ignoreInitial: true` pairs with the **boot rescan** — offline drift is
reconciled before the watcher starts. Route actions project synchronously and
never depend on the watcher.

### 1.7 Projection events → SSE

`app/server/events/projection-events.server.ts` is a `node:events` EventEmitter
on `Symbol.for("viberr.projectionEvents")`, channel `"projection"`, max
listeners 100 `:54-77`.

`ProjectionEvent` union `:11-52`: `task.updated`, `task.removed`,
`project.updated`, `project.removed`, `projection.rebuilt`,
`notification.created`, `notification.read`, `violation.updated`,
`goal.updated`. Payloads are **compact facts + references, never fat objects**.

`collectProjectionEvents(fn)` `:108` defers emission into a module-local buffer
so a write transaction's subscribers never observe uncommitted state; a throw
DISCARDS the buffer. Nested collections buffer into the innermost.
`onProjectionEvent(listener)` `:123` returns an unsubscribe.

The wire contract is `app/schemas/sse-event.schema.ts`: `SSE_EVENT_NAMES :22`
adds `run.log-appended`, `run.state-changed` (published straight to the broker
from the run service, not through the projection emitter),
`controller.updated`, plus the broker control events `stream.open` (carries the
head event id for resume) and `stream.resync` (Last-Event-ID predates the ring
buffer). Every payload is `{type, entityId, occurredAt, data}` and is
zod-parsed before it goes on the wire `:56`.

`armProcessShutdown()` (`events/sse-broker.server.ts:412`) just materializes the
broker state so its signal handlers are registered. `runProcessShutdown() :416`
runs, in order: close SSE connections → `stopFileWatcher()` →
`stopKbWatcher()` → `stopDataRootLockGuard()` → `shutdownDatabase()` →
`releaseDataRootLock()`. Both watchers are detached BEFORE the DB closes so no
debounced rebuild fires into a shut-down database.

SSE authorization is re-resolved on every 25 s heartbeat:
`applyReauthorization` (`sse-broker.server.ts:233`) calls the connection's own
`reauthorize` hook (`:129`, wired at `:301`, declared `:278`); `[]` drops the
connection, and a THROW keeps the existing scopes `:239-247` (a check that could
not run must neither widen access nor tear down a healthy stream).

### 1.8 SQLite: WAL, pragmas, migrations, self-heal

`openDatabase(dbPath)` — `app/server/db/sqlite.server.ts:12` — sets
`journal_mode = WAL`, `foreign_keys = ON`, `busy_timeout = 5000`.
`openDatabaseReadOnly :29` exists for the read-only CLIs (`npm run backup`,
`npm run keys -- status`) which must work against a LIVE instance and therefore
cannot take the writer lock; it runs **no** migrations.

`getDb()` `:82` is the process-wide handle behind `Symbol.for("viberr.db")`,
lazily opening + migrating + `ensureSingleFlightIndexes`. After
`shutdownDatabase()` `:158` it **refuses to reopen** (`DB_SHUTDOWN_KEY`, F21-24).
`shutdownDatabase` does `PRAGMA wal_checkpoint(TRUNCATE)` then closes; the flag
latches in a `finally`.

`ensureSingleFlightIndexes(db)` `:114` is an idempotent `IF NOT EXISTS` backstop
for indexes added to the baseline after a root already applied it — needed
because migrations are **squashed**.

`runMigrations(db, dir)` — `app/server/db/migration-runner.server.ts:28`:
applies `db/migrations/*.sql` in filename order, each inside its own
transaction with its `schema_migrations` row; **skips by FILENAME alone**. A
failure becomes `ERROR_CODES.DB_MIGRATION_FAILED` `:71`.

**The squashed-baseline convention** (`db/migrations/0001_baseline.sql:10-19`):
pre-prod, schema changes are edited INTO `0001_baseline.sql`. Because the runner
skips by filename, editing it reaches **fresh databases only** — an existing
root keeps its old schema and every projection write touching a new column
throws. There is no drift healer. The remedy is to wipe and re-seed
(`npm run seed -- --reset`), which regenerates user ids because auth lives in
the same file. *(The baseline is byte-identical to pass 31 — no new columns
landed in #253–#264; `heldAtStage` is file-only and `outcome_key` already
existed.)*

Boot therefore *detects* the drift in two ways (`app/server/boot.server.ts`):
- `projectionValidationGaps(db) :160` — reads the live `task_projections` DDL out
  of `sqlite_master` and reports which `VALIDATION_VALUES` members its CHECK
  refuses (F21-1: `bypassed` was missed).
- `projectionMissingColumns(db) :198` — runs the real migrations against a
  throwaway `:memory:` DB and diffs `PRAGMA table_info` for
  `task_projections` + `task_events`.

Both feed `logBootIntegrity :242`, which emits one `boot integrity check` info
line and, on drift, a separate loud WARN carrying impact + remedy.

`selfHealProjectionDbIfCorrupt(path)`
(`app/server/db/self-heal.server.ts:217`, called at `boot.server.ts:588`)
runs BEFORE the first handle opens: if the file is corrupt it salvages the
non-reconstructable rows, moves the corrupt file aside for forensics and builds
a fresh valid one; projections rebuild from `.md` on the boot rescan.
`isCorruptionError :70`, `projectionDbState :125`, `copyTable :167`,
`REBUILT_FROM_FILES :41`.
**Changed (anti-slop, pass 31)**: the SQLite result code is now decoded through
`sqliteErrcodeSchema` (a zod `.catch(NO_ERRCODE = -1)`) at `:54-66` instead of a
hand-written type assertion, and `copyTable` binds `iterate()`'s
`SQLOutputValue` rows directly `:180-196`. Behaviour is unchanged.

Retention: `applyRetention` (`app/server/db/retention.server.ts:200`) with
`RUN_LOG_RETENTION_DAYS = 30 :51`, `AUDIT_RETENTION_DAYS = 90 :53`,
`NOTIFICATION_MAX_PER_USER = 500 :77`, and `IDEMPOTENCY_AUDIT_ACTIONS :72`
(rows retained longer because they back idempotency checks:
`task.agent.replied`, `runtime.operator.plan_executed`).

**NEW — export before purge (ruling 102 / FR33)**, `retention.server.ts:29-47`,
`:96-198`:
- `AUDIT_EXPORT_DIRNAME = "audit-exports" :98`; one file per purge DAY,
  APPENDED to: `auditPurgeExportPath :104` →
  `<dataRoot>/audit-exports/audit-events-<YYYY-MM-DD>.jsonl`.
- `auditRowSchema :124` is `z.looseObject` over the raw snake_case columns, so a
  column added by a later migration rides through to the export.
- `expiringAuditRows(now) :144` builds the predicate ONCE
  (`WHERE occurred_at < ? AND action NOT IN (…)`) so the export and the DELETE
  cannot disagree about which rows are expiring.
- `exportExpiringAuditEvents :164` **fails closed**: unparseable rows, an
  un-creatable directory, or a write error all return `false`, and
  `applyRetention :213-220` then skips that pass's DELETE and reports
  `auditEvents: 0`. An empty result is a vacuous success (no file created).
- `RetentionOptions.dataRoot :86-92` is forwarded from
  `runMaintenancePass` (`ops/maintenance.server.ts:153-157`).
- `audit/audit-export.server.ts` is deliberately NOT reused (`:42-47`): it
  camelCases into a single JSON array/CSV under a 100k cap, which is the right
  shape for an admin download and the wrong one for an append-only machine
  record.

Backup/restore: `createBackup :177` / `restoreBackup :442` /
`restoreStoreFile :600` (`app/server/db/backup.server.ts`), format
`viberr-backup/1 :67`, `BACKED_UP_STORE_DIRS = projects agents kb skills :74`,
`OPTIONAL_STORE_DIRS = runtimes :82`, `COUNTED_TABLES :85`.
**`audit-exports/` is in neither list — see Findings.**

### 1.9 The single-writer lock

`app/server/db/data-root-lock.server.ts` — **the** most important operational
invariant, unchanged. ONE app process per data root, EVER (B-FD1).

- Lock file `state/writer.lock` (`DATA_ROOT_LOCK_FILENAME :50`), created with
  `openSync(path, "wx")` — O_CREAT|O_EXCL (`writeLockFile :444`).
- Holder JSON: `{pid, hostname, startedAt, bootId?, procStartedAt?}`
  (`LockHolder :58`). `bootId` is a per-PROCESS `randomUUID` on
  `Symbol.for("viberr.processBootId")` `:192-207` — needed because compose PINS
  the hostname. `procStartedAt` is field 22 of `/proc/<pid>/stat`
  (`readProcessStartTicks :250`, parsed after the LAST `)`).
- `classifyLock(holder, self, isAlive, readProcStartTicks) :307` — verdicts
  `stale | held | unknown-holder`:
  1. `holder.bootId === self.bootId` ⇒ **stale** (our own HMR-orphaned lock).
  2. different hostname ⇒ **held** (we cannot probe that pid).
  3. `holder.pid === self.pid` with a recorded `procStartedAt` ⇒ compare live
     start ticks: equal ⇒ held, different ⇒ stale (**F20-8(b)** — pid 1 + pinned
     hostname made `isAlive(self.pid)` a self-probe that always said "alive").
  4. otherwise `isAlive(holder.pid)` — `EPERM` counts as alive `:239`.
- `acquireDataRootLock :458` retries 3×. Refusal is a `DataRootLockedError`
  whose `message` (`refusalMessage :404`) names the holder and both remedies
  (delete the file, or `VIBERR_FORCE_DATA_ROOT_LOCK=1`).
- Release: `release()` unlinks + closes; `abandon()` closes WITHOUT unlinking
  `:507-524`. Registered on `process.once("exit")` AND called explicitly by the
  signal shutdown, because the app's handler **re-raises** SIGINT/SIGTERM
  (`releaseDataRootLock :222`, docblock `:209-221`).
- **Fail-closed ownership guard** `startDataRootLockGuard :614`, interval
  `DATA_ROOT_LOCK_GUARD_INTERVAL_MS = 20_000 :555`. Every tick
  `verifyLockOwnership :379`: fstat our fd → stat the path (ENOENT ⇒ stolen) →
  compare inode+dev → and, when our identity carries a `bootId`, re-read the
  file and check it still names us. A `stolen` verdict calls
  `loudlyShutDownOnStolenLock :584` (`writeFatalSync` → `abandon()` →
  `process.exit(1)`). `unverifiable` retries next tick. F18-5.
- `heldDataRootLock()` is what the health snapshot reads
  (`ops/health-snapshot.server.ts:76`).

CLI counterpart: `acquireCliWriterLock` / `runWithDataRootWriterLock`
(`app/server/db/cli-lock.server.ts:89,109`) for write-mode scripts.

### 1.10 Boot ordering (`app/server/boot.server.ts:531` `bootServer`)

Exact sequence — **line numbers shifted by +2 after `:596`** relative to pass 31
(the self-heal log line grew by two).

| # | step | line | why here |
|---|---|---|---|
| 0 | `installCrashVisibilityHandlers()` | `:534`, def `:96` | F20-8(a) — a fatal must never vanish; `writeFatalSync` (`logging/logger.server.ts:116`) flushes ONE sync stderr line before `process.exit`. |
| 1 | `bootFlags()[BOOT_KEY]` re-entry guard | `:535-536` | HMR-safe idempotence via `Symbol.for("viberr.booted")`. |
| 2 | `getEnv()` + `BETTER_AUTH_URL` warnings | `:538-556` | fail fast on bad config; warn on OAuth-without-URL and on `http://` origin in production (`insecureAuthOriginWarning`, `config/env.server.ts:284`). |
| 3 | `ensureDataRootDirs()` | `:559` | |
| 4 | **`takeDataRootWriterLock(env)`** | `:565`, def `:499` | BEFORE anything opens the DB or writes a file. A `DataRootLockedError` is printed to stderr and `process.exit(1)` — a refusal, not a crash. |
| 5 | `armProcessShutdown()` | `:570` | registers the handler that RELEASES the lock. |
| 6 | `startDataRootLockGuard()` | `:576` | F18-5 fail-closed guard. |
| 7 | `seedDefaultAgentAssets()` | `:581` | ships default agent skills/definitions/profile templates before anything reads them; idempotent, best-effort. |
| 8 | `selfHealProjectionDbIfCorrupt(getProjectionDbPath())` | `:588` | before the first handle opens. |
| 9 | `getDb()` (opens + migrates) | `:603` | |
| 10 | `await seedInitialAdmin(db, …)` | `:605` | |
| 11 | `startEventPublisher()` | `:612` | SSE bridge FIRST so the rescan below and every later mutation reach clients. |
| 12 | `rescanProjections(db)` | `:619` | reconciles edits made while down. Hash short-circuit makes it cheap. Failures never block boot. |
| 13 | `ensureBaseAgentsDeployed(db)` | `:636` | after the rescan (project list populated), before the watcher (no concurrent writer). |
| 14 | `startFileWatcher()` | `:645` | |
| 15 | `startKbWatcher()` | `:649` | |
| 16 | `startStoreMaintenance(db)` | `:656`, def `:346` | `reapStaleWarmups` → `runMaintenancePass({reason:"boot", reclaimWorkspaces:false})` → `startMaintenanceScheduler`. **`reclaimWorkspaces:false` is deliberate** — the reclaim belongs to step 17. |
| 17 | `void reconcileRestartedWork(db)` | `:662`, def `:411` | fire-and-forget; must not hold up serving. |
| 18 | `startScheduleRunner(db)` | `:668` | fires due schedules once, then on an interval; unref'd. |
| 19 | `startGithubReconcilePoller(db)` | `:674` | boot + every 5 min. |
| 20 | `startGoalRunner(db)` + `recoverControllerConversations(db)` | `:680-682` | the latter at `controller/controller-run.server.ts:491`. |
| 21 | `logBootIntegrity(db)` | `:689` | |

`reconcileRestartedWork` `:411` is itself a strictly ordered chain:
0. `finalizeOrphanedRuns(db)` `:426` — a run row left `running`/`queued` has no
   live process in a fresh boot; finalize to `error` and re-invoke the operator.
   Its `.reinvokes` promise is **kept** and joined at `:446`.
1. `await recoverUnreactedAgentRuns(db)` — a run that finished before its
   in-process reply callback fired.
2. `await recoverStrandedOperatorPlans(db)` — Codex operators coordinate AFTER
   the run finishes, so a restart loses the whole turn.
3. workspace reclaim — **only after** joining `orphanReinvokes`, and **only if
   `activeRunCount(db) === 0`** `:455`. P14-RT-09. Every step is self-catching.

---

## 2. Domain model

### 2.1 Canonical (file) entities

**Project** — `projects/<slug>/project.md`.
Schema `app/schemas/project-file.schema.ts:197` (`projectFrontmatterSchema`),
keys in canonical write order at `:214`, parser `parseProjectFrontmatter :350`.

| field | type | notes |
|---|---|---|
| `name` | string | falls back to slug |
| `slug` | `/^[a-z0-9][a-z0-9-]*$/` | directory name wins on mismatch `:356-388` |
| `archived` | bool? | archived projects are **read-only** (R6-3) |
| `repo` | `owner/name` \| null | ONE repo per project (P13-D-5) |
| `defaultBranch` | string | default `main` |
| `taskPrefix` | `/^[A-Za-z]+$/` | derived from slug when absent (`derivePrefix :339`) |
| `nextTaskNumber` | int \| null | atomic key counter |
| `stages[]` | `{id,name,color}` | `stageSchema :41`; per-project, ordered; empty ⇒ `project.no_stages` error |
| `workflow[]` | `{from,to,boundary,by,locked}` | `workflowBoundarySchema :51`; `BOUNDARY_VALUES = auto\|approval\|human :29` |
| `members[]` | `{userId, role}` | `PROJECT_ROLES = admin\|maintainer\|contributor\|viewer :24`; **files are the ACL truth** |
| `agents[]` | `AgentDeployment` | `:129` — `{profileId, capabilities[], extras[], definition?}` |
| `credentialPolicy` | `{credentialLabel, masked, requiredScopes[]}` \| null | NON-secret; the PAT is sealed in SQLite |
| `guardrails[]` | `{id,desc,on,value?,unit?}` | defaults `DEFAULT_GUARDRAILS` (`app/shared/workflow/templates.ts:93`) |

Markdown body = the project description.

**`DEFAULT_GUARDRAILS` changed (ruling 104)** — the `operator-brevity` row was
**deleted** (`templates.ts:83-92` explains why: a row with no enforcement would
be decorative, the ruling-Q3 failure mode). Remaining four:
`meaningful-comment`, `no-duplicate-summary`, `compression-threshold` (value 40
events), `evidence-separation`. Stale `operator-brevity` rows in existing
`project.md` files are inert (`guardrailOn` looks up by id).

**AgentDeployment.definition** (`:86` `agentDeploymentDefinitionSchema`) is the
loose per-project override: `kind, name, role, icon, backends[], model, effort,
scope, desc, persona, stages[], spanAll, autonomy (supervised|full),
resources{skills[],mcps[],kb[]}`.

**Two-layer agent model**: `agents/profiles/<id>.md` are ORG templates
(backends, eligible stages, base capability policy, resources, markdown-body
persona); a project's `agents:` list *deploys* a template by `profileId` and
carries the project-effective capability policy
(`docs/architecture/file-formats.md:116-120`, `:405-443`). Task assignments
store `profileId` — never joined by role text.

**Task** — `projects/<slug>/tasks/<KEY>/task.md`.
Fields `app/schemas/task-file.schema.ts:599` (`taskFrontmatterFields`), write
order `TASK_FRONTMATTER_KEYS :968`, parser `parseTaskFrontmatter :1181`.

| field | type | line |
|---|---|---|
| `key` | `/^[A-Za-z]+-\d+$/` | `:600` |
| `title` `stage` | string | `:601-602` |
| `previousStageId` | string\|null | `:608` — where the task CAME from (ruling 98) |
| **`heldAtStage`** | **string\|null** | **`:620` — NEW (V18/F31-11)** |
| `readiness` | `READINESS_VALUES` = `ready \| input_required \| inconsistency_risk_detected \| blocked` | `:26` |
| `waiting` | `human \| agent \| none` | `:34` |
| `ownerUserId` | string\|null | `:624` |
| `engagements[]` | `Engagement` | `:625` (schema `:194`) |
| `operator` | `{assignedAtStageId}` \| null | `:626` |
| `recommendations[]` | `Recommendation` | `:628` (schema `:267`) |
| `schedules[]` | `TaskSchedule` | `:630` |
| `urgent` / `priority` / `labels[]` / `dueDate` | bool / `low\|normal\|high\|urgent` `:47` / string[] / `YYYY-MM-DD` | `:634-641`; `urgent` is derived from `priority` at write time |
| `archived` | bool | `:647` (R14-3) |
| `validation` | `healthy\|changed\|failing\|none\|bypassed` `:43` | `:651` — DERIVED cache |
| `workRevision` | `WorkRevision` \| null | `:653` (schema `:548`) |
| `verdicts[]` | `ReviewVerdict` | `:655` (schema `:578`) |
| `branch` | string\|null | `:656` |
| `pr` | `PrRef` \| null | `:662` (schema `:416`) |
| `noChanges` | bool? | `:677` (R17-2/R19-8) |
| `acceptance` | `"forced"` \| null | `:684` (N20-14) |
| `github` | `GithubCache` \| null | `:685` (schema `:456`) |
| `goalRef` | `{goalId, linkIndex}` \| null | `:693` (ruling 99) |
| `createdAt` `updatedAt` `boardRank` | | `:704` and around |

`repo` is **not** in the schema (P13-D-5) — an existing `repo:` line is an
unknown key, preserved verbatim and read by nothing.

**`heldAtStage` (NEW)** — a durable deliberate-hold marker (docblock
`task-file.schema.ts:610-619`). Set to the CURRENT stage when a stranded-resume
nudge ends stranded again; while it names the task's current stage the
settle-time stranded backstop stays quiet
(`runtimes/operator-run.server.ts:786-795`) instead of paying a fresh operator
drive and duplicating the hold note on every external trigger. Written at
`operator-run.server.ts:813` together with a `policy-engine` note. Cleared by
exactly four writers, all verified:
`createTask` birth value `task-actions.server.ts:502`, goal edit `:590`,
`transitionStage` `:4548`, packet resolution `:6522`, acceptance write `:7882`.
`grep 'frontmatter\.stage = '` returns **only** `:4539` and `:7879`, and both
clear the marker — the invariant "every stage writer clears it" holds. A manual
operator drive deliberately does NOT clear it. Documented in
`docs/architecture/file-formats.md:140-145`.

Sub-shapes:
- `Engagement :194` — `{profileId, backend, role, delivers, verdictCapable,
  pinnedBackend?}`. At most one `delivers: true` (workspace/branch/PR owner).
  `verdictCapable` is a snapshot of an EXPLICIT `report-validation-verdict:
  direct` grant taken at engage time. `pinnedBackend` is a *sticky* retry pin
  from `retry_other_backend` that outranks the live profile's primary.
  Helpers: `deliveringEngagement :221`, `supportingEngagements :228`,
  `requiredReviewers :729`, `currentVerdicts :734`.
- `Recommendation :267` — `{id, kind, profileId?, prompt?, delivers?,
  toStageId?, label, detail}`; `RECOMMENDATION_KINDS = transition | run_agent |
  accept_completion | delivery :245`. Several may be pending at once.
- `TaskSchedule :307`-ish (`scheduleSchema`) — `{id, action, dueAt, profileId,
  prompt, createdBy, createdByLabel, createdAt, status, firedAt, claimedAt,
  retries}`. `SCHEDULE_ACTION_TYPES = run-operator | run-agent :299`;
  `SCHEDULE_STATUS_VALUES = pending → claimed → fired | failed | cancelled :307`.
  `claimed` reserves the occurrence *before* the detached enqueue so a crash is
  recoverable; the claim lease is re-stamped as the drive begins
  (`tasks/schedule.server.ts:562-586`). R22: a schedule pins only the profile
  *id* — backend/model/capabilities resolve from the LIVE deployment at fire time.
- `PrRef :416` — `{number, state, title, checks?, review?, mergeable?,
  revisionDrift?}`. `PR_STATE_VALUES = review|merged|closed|accepted :359`;
  `PR_REVIEW_VALUES = approved|changes_requested|review_required :376`;
  `PR_MERGEABLE_VALUES = clean|conflicting|unknown :401`. `checks/review/
  mergeable` are optional KEYS: absent ≠ "no checks", it means "never read".
  Every one carries `.catch(null)` so a hand-edited garbage value cannot null the
  WHOLE ref.
- `GithubCache :456` — `{commits[], changed, unownedPr?}`. `unownedPr :473`
  (R15-15) is a PR found on this task's branch that this task did NOT open — the
  branch-collision signature, now surfaced on `TaskSummary` and consumed by
  `resolve_remote_collision`.
- `WorkRevision :548` — `{id, headSha, treeSha, branch, createdAt,
  sourceProfileId, kind?}`; `kind ∈ delivered | verified`, ABSENT reads as
  `delivered`.
- `ReviewVerdict :578` — `{profileId, revisionId, headSha, result, reason, at}`;
  `REVIEW_VERDICT_RESULTS = approve | request_changes :575`.
- `TaskPacket :510` — `{id?, type: input|blocked, kind, from, title, body,
  observations[], options[], awaiting?, askedBy?}`; `.loose()`.
  `PacketObservation :478` = `{k: string, v: string, code: boolean}`.
  `PacketOption :487` = `{kind, t, d, rec, ev?, backend?, profileId?,
  deleteBranch?}`. **`PACKET_OPTION_KINDS` `:129` is the source of truth** —
  today **ELEVEN**, verified by enumeration at `:130-165`:
  `accept_completion, request_edit, block_on_policy, hold_runtime_debug,
  redirect, retry_other_backend, edit_goal, archive_task, discard_branch,
  resolve_remote_collision, custom`. There is **no** `accept:` marker field —
  acceptance is gated on the KIND alone plus `resolvePacket`'s
  admin|maintainer re-check (doc corrected at
  `docs/architecture/file-formats.md:220-227`). The doc/schema count is pinned by
  `app/shared/docs/file-formats-sync.test.ts:83-131`.
- `EvidenceRow` — `EVIDENCE_MAX_ROWS = 8 :1524`, empty column sentinel
  `EVIDENCE_EMPTY_COLUMN = "—" :1541`, `normalizeEvidenceRows :1558` flattens
  newlines and strips ` · ` from count columns so a row can never forge columns.
- `sanitizeEventAttachmentNames :1601` — `EVENT_ATTACHMENTS_MAX = 20 :1591`,
  rejects path separators, control chars, and names that do not survive the
  parser's `trim()`.

**Goal (chain)** — `projects/<slug>/goals/<id>.md`,
`app/schemas/goal-file.schema.ts:68` (`goalFrontmatterSchema`).
`{id, title, status, createdBy, createdByLabel, onFailure, links[], createdAt,
updatedAt}`, write order `GOAL_FRONTMATTER_KEYS :85`.
`GOAL_STATUS_VALUES = active|paused|attention|completed|cancelled :32`;
`GOAL_LINK_STATUS_VALUES = pending|active|done|failed|skipped :41`;
`GOAL_ON_FAILURE_VALUES = pause|continue :50`.
`goalLinkSchema :53` = `{index (1-based), title, goal, taskKey, status, note}`.
Helpers `allLinksSettled :125`, `currentLinkIndex :134`.
`createdBy` is the authority chain advancement **re-proves** every time a link
task is created with nobody present. **Goal files are never deleted by the
product.** Unknown frontmatter keys are preserved via
`unknownFrontmatter` (`goal-writer.server.ts:96-104`).

**Agent profile template** — `agents/profiles/<id>.md`
(`docs/architecture/file-formats.md:405`), reader
`app/server/files/agent-profile-file.server.ts`:
`agentProfileFrontmatterSchema :27` is `.loose()` at every level;
`AGENT_PROFILE_KNOWN_KEYS :90` now holds **16** keys (id, kind, name, role, desc,
icon, backends, model, **effort**, scope, stages, spanAll, capabilities, extras,
resources — plus `id` seeded from the filename). An unknown top-level key is
preserved but emits `agent_profile.unknown_field :157`.
`parseAgentProfileContent :119`, `serializeAgentProfile :168`.

**NEW — `effort` (ruling 106)** `:51`:
`effort: z.string().optional().catch(undefined)`. Only the controller profile is
edited through this key today (deployed specialists carry model+effort on their
`project.md` `agents:` entry), but the key is schema-level so carrying it is
never "drift". **Deliberately tolerant** (review D2): a hand-edited `effort:`
(YAML null) or `effort: 3` reads as absent rather than failing the WHOLE profile
parse — a strict field here bricked the controller config
("profile missing from the store") over one junk line with no in-app repair path.

> **`resources:` values are STORE FOLDER NAMES, never display names.** For
> skills/mcps the slug *is* the folder so they coincide; for KB they do not — a
> KB has a display name and a `dir` as separate columns. A `kb:` entry written
> as the display name resolves to nothing: `readKbBody` returns `""` with only a
> `logger.warn`, so the run proceeds *without* the KB while every UI still shows
> it attached (`docs/architecture/file-formats.md:435-442`). Renaming a KB dir
> orphans existing grants the same way.

### 2.2 App-owned (SQLite) entities

All DDL in `db/migrations/0001_baseline.sql` — **unchanged since pass 31**, so
every line number below is re-verified as-is.

| table | line | owner module | notes |
|---|---|---|---|
| `users` | `:23` | `auth/user-store.server.ts` | org role `admin\|member`, `idp`, `disabled`, `pwreset_required`, `theme` |
| `audit_events` | `:37` | `audit/audit-recorder.server.ts` | `{occurred_at, actor_user_id, actor_label, action, subject_kind, subject_id, project_slug, task_key, details_json}` |
| `projects` | `:49` | rebuilder | projection of project.md |
| `project_members` | `:66` | rebuilder | `ON DELETE CASCADE` from `projects` |
| `task_projections` | `:72` | rebuilder | see below |
| `task_events` | `:177` | rebuilder | replaced wholesale per task |
| `goal_projections` | `:203` | rebuilder | link statuses RECONCILED, not copied |
| `diagnostics` | `:226` | rebuilder | keyed by `source_path` |
| `provenance` | `:238` | `provenance/` | `projected\|removed\|error\|rescan`; never pruned by retention |
| `notifications` | `:247` | `projections/notifications.server.ts` | kinds `packet\|approval\|mention\|quality\|policy\|controller` `:252`; `ptype input\|blocked` |
| `user_prefs` | `:264` | `prefs/user-prefs.server.ts` | `(user_id,key)` JSON |
| `instance_settings` | `:276` | `settings/instance-settings.server.ts` | **NEVER store a secret here** `:271-275` |
| `s3_audit_config` | `:284` | `audit/s3-config.server.ts` | `secret_box` sealed column |
| `github_pats` | `:294` | `secrets/pat-store.server.ts` | `encrypted_token`, `token_suffix`, `validation_json` |
| `project_github_credentials` | `:304` | | project → PAT binding |
| `scope_violations` | `:310` | `projections/policy-violations.server.ts` | partial unique index on OPEN rows `:574` |
| `github_connections` | `:321` | `org/connections.server.ts` | id = `slugify(owner)` |
| `oauth_providers` | `:337` | `auth/oauth-providers.server.ts` | sealed `client_secret`; `enabled` needs `verified_at` |
| `google_domain_allowlist` | `:347` | | |
| `org_knowledge_bases` | `:353` | `org/resources.server.ts` | `dir` UNIQUE; `refresh` CHECK still admits `'nightly'` `:358` |
| `org_mcp_servers` | `:363` | `org/resources.server.ts`, `org/mcp-warmup.server.ts` | `warming_since`, `last_error`, `first_success_at`, `heuristic_warmups` |
| `model_availability` | `:402` | `runtimes/model-availability.server.ts` | presence = unavailable; absence = unknown-but-offered |
| `org_skills` | `:410` | `org/resources.server.ts` | `name` = folder under `skills/` |
| `controller_conversations` | `:423` (+ index `:437`) | `controller/controller-conversations.server.ts` | `{id, user_id, user_label, project_slug (NULL = instance scope), title, created_at, updated_at, last_message_at}` |
| `controller_messages` | `:439` | same | `{id, conversation_id (CASCADE), seq, author IN (user, controller), user_id, text, run_id, created_at}`, `UNIQUE (conversation_id, seq)` |
| `agent_runs` | `:454` | `runtimes/run-store.server.ts` | see below |
| `run_log_lines` | `:501` | `runtimes/run-store.server.ts` | `(run_id, seq)` unique `:611` |
| `staged_outcomes` | `:623` | `tasks/agent-outcome.server.ts` | Claude `report_outcome` envelope, keyed by `outcome_key` |
| `user` / `session` / `account` / `verification` | `:537-551` | better-auth 1.6.25, hand-inlined | `verification` looks dead but better-auth writes it on EVERY OAuth sign-in |
| `schema_migrations` | created by the runner | `db/migration-runner.server.ts:33` | |

**`task_projections`** (`:72-176`) columns worth knowing:
`readiness` (DERIVED) vs `stored_readiness` (raw, NULL when invalid);
`waiting` (terminal-stage-normalized); `priority` + `labels_json` + `due_date`;
`archived`; `validation` **with a hand-written CHECK that mirrors
`VALIDATION_VALUES`** `:102-103`; `validation_block_reason`;
`acceptance ∈ {forced}`; `continuity ∈ {degraded}`; `owner_user_id`;
`specialist_json` / `reviewers_json` / `operator_json`; `branch`; `repo`
(denormalized project repo); `pr_json`; `github_json`; `work_revision_sha`;
`goal`; `packet_json`; `recommendation_count`; `schedules_json`; `event_count`;
`comment_count`; `goal_id` + `goal_link_index`; `diagnostic_count`;
`board_rank`; `source_path` + `content_hash` + `parsed_at`.
PK `(project_slug, task_key)`. **No `held_at_stage` column** — the marker is
file-only by design.

**`agent_runs`** (`:454`) — the `kind` column is **not a role taxonomy, it is
the DELIVERY axis** (`:460-473`): `operator` = the operator runtime's own run;
`primary` = an engagement that DELIVERS; `reviewer` = an engagement that merely
SUPPORTS — *so a non-delivering developer is stored as `reviewer`*. The real
role rides `role`. `controller` rows carry `project_slug = ''` and
`task_key = <conversationId>` so every task-scoped query misses them. (C7 pass 31
documented these semantics at the `RunKind` type too.)
Two partial unique indexes enforce single-flight atomically:
- `idx_agent_runs__one_delivering :593` — one live `primary` run per task
  (F10-05; `startRun` translates the constraint violation to a 409).
- `idx_agent_runs__one_live_per_support :608` — one live `reviewer` run *per
  profile* per task (P8's `workspace/support/<profileId>/`). DIFFERENT profiles
  still run concurrently. Existing roots predate this line, hence
  `ensureSingleFlightIndexes` at boot.

`outcome_key :499` persists the staging key for a Claude `report_outcome`
envelope so boot recovery can find the structured verdict instead of falling
back to the prose regex. **C1 (pass 31)**: it is now declared on `AgentRunRow`
(`runtimes/run-store.server.ts:46`) and written through `RunPatch.outcomeKey`
(`:153`, mapped `:181`, covered by the `satisfies Record<keyof RunPatch, …>`
exhaustiveness check). The raw
`UPDATE agent_runs SET outcome_key = ?` in `registerAgentCompletion` is gone.

**Controller conversations** — app-owned collaboration state (ruling 99);
`0001_baseline.sql:418-422` explains why they are not file-canonical (nothing
hand-edits a transcript; the deep working record lives on the turns' `agent_runs`
rows + raw NDJSON). Access gates in
`controller/controller-conversations.server.ts`:
`canAccessConversation :105` (owner, or a **live** org-admin re-check — the
session's claimed role is a hint only `:111-115`) and
`canReadControllerRunLog :125`, which was moved here in ruling 107 so the run-log
route, the session export and `viberr_ops` all ask one question without importing
the run engine (`:118-124`). Other exports: `getConversation :137`,
`requireConversation :148`, `createConversation :168`, `listConversations :192`,
`listMessages :221`, `recentMessages :234`, `appendMessage :259`,
`deriveTitle :312`, `publishConversationUpdated :318`.

### 2.3 Org resources, secrets, seed, ops, audit

**Resources — `app/server/org/resources.server.ts` (2224 lines)**, owner of
`org_knowledge_bases`, `org_mcp_servers`, `org_skills` and of `kb/*` +
`skills/*` on disk. Core invariant: **disk is truth, the row is metadata on
top** — listings scan real folders and layer rows over them, and a folder with
no row renders under a synthetic `disk:<name>` id (`DISK_ID_PREFIX :78`,
`diskNameFromId :84` rejects `..`/separators). `subDirNames :114` uses
`readdirSync(withFileTypes)+isDirectory()`, **never `statSync`** — `statSync`
dereferences, so `kb/notes -> /etc` was listed as a first-class KB and injected
as trusted context (C5, `:103-113`).

- **KB**: `KB_REFRESH_MODES = ["on change","manual"] :162` controls **metadata
  only** — runs always read the live folder. `KbView :166` carries
  `injectableCount` beside `fileCount` plus `folderExists :187/:221`.
  `listKnowledgeBases :243`; `getKnowledgeBase :296`;
  `saveKnowledgeBase :311` does `dir = slugify(name)` and `renameSync`s the
  folder. **C4 ordering `:340-395`: the folder move and the row write are ONE
  synchronous block and `updateResourceReferences` runs after** — otherwise the
  KB watcher's 250 ms debounce observes a disk/row disagreement and adopts the
  moved folder as a new KB, blowing the `dir` UNIQUE constraint.
  `reindexKnowledgeBaseByDir :521` is the watcher entry point; it returns null
  when `refresh === "manual"`.
- **NEW names-only readers (F31-3 / review V12)** — the operator snapshot needs
  the CATALOG, not the contents, and `buildKb`/`buildSkill` walk every store
  directory (`scanStoreTree` stats each file; `buildSkill` reads up to 256 KB of
  SKILL.md), which is far too heavy for `get_task`:
  `listKnowledgeBaseNames :269`, `listMcpServerNames :812`, `listSkillNames
  :1971`. Same union-of-disk-and-rows membership, same `dir`→name fallback.
- **MCP**: `openMcpCredential :700` lazily re-seals under a retired key; a
  credential that opens under **no** key returns `unreadable` `:712` and the
  server is **not mounted** (A9). `openedForNewRow :781` deliberately does not
  re-seal (which is why the batch rotation pass exists). `mcpSpawnEnv :911`
  gives stdio children `filteredSpawnEnv()`, not `process.env` (F10-02);
  `defaultSpawn :919` is `detached` and `killProcessTree :945` signals `-pid`
  (F20-2). `splitMcpCommand :990` is shared with the run path so probe and run
  never disagree. `discoverStdioMcpTools :1026` — 20 s timeout, `STDERR_CAP =
  8000 :1083`, stderr scrubbed by value, and `child.stdin?.on("error") :1147`
  folds EPIPE into `down` (an unhandled EPIPE was fatal in 5/40 live iterations,
  F20-8). `MCP_CLIENT_CAPABILITIES :1237` must advertise
  `{roots:{listChanged:true},sampling:{},elicitation:{}}` — `{}` made a server
  hide tools. `probeMcpTarget :1305`. `saveMcpServer :1457`: blank credential
  means **keep** (`input.clearCred` `:1483` is the only removal), **8-char
  credential floor `:1496-1500` (F20-7)**, reserved names refused `:1516`, and a
  rename rewrites grants `:1625` (P14-KM-01).
- **Skills**: `SKILL_BODY_MAX_BYTES = 256 KB :1808`. `readSkillBody :1840`
  routes through the **injector's own** `resolveContainedSkillFile` so editor
  and injector answer identically (A5); `assertSkillBodyWritable :1866` refuses
  to save through a symlinked `SKILL.md` or folder and uses `lstat`.
  `listSkills :1948`.
- `resolveStoreTarget :2191` is the KB/skill lookup `viberr_ops`'s
  `read_store_doc` uses.
- **Warm-ups** (`org/mcp-warmup.server.ts`): `WARMUP_CAP_MS = 15 min :35`;
  `heuristic_warmups` is bumped at ARM time `:93` and rolled back by
  `reapStaleWarmups :181` (`:199`); **every verdict write is `AND target = ?`
  scoped `:123,:138`** (docblock `:110`) — an admin may re-point the row
  mid-warm-up and an id-only write would stamp the OLD command's verdict onto
  the NEW one.

**Reserved MCP names — NEW single source** `app/shared/mcp-reserved.ts`:
`RESERVED_MCP_NAMES :29` (a `ReadonlySet` carrying BOTH spellings of `viberr`,
`viberr_agent`, `viberr_browser`, `viberr_controller`, `viberr_ops` — a Codex run
sees the hyphen form of a name the Claude side writes with an underscore),
`isReservedMcpName :42`. Three layers read it and used to disagree
(docblock `:9-28`):
1. the **writer** `saveMcpServer` (`org/resources.server.ts:1516`) — no org row
   can be created under one (P13-KM-12);
2. the **picker** `buildResourceCatalog` (`org/resource-catalog.server.ts:67`) —
   a grant cannot be made to something no run will mount (P14-KM-14);
3. the **resolver** `resolveSpecialistMcpServersDetailed`
   (`tasks/specialist-mcp.server.ts:138,142,175`) — the layer that decides what a
   run actually MOUNTS. Its private copy never learned `viberr_controller`
   (ruling 99) or `viberr_ops` (ruling 107), so a row reaching the registry any
   way but `saveMcpServer` (written straight into SQLite, restored from a backup,
   created before the guard) resolved normally and, because org servers mount
   LAST, **replaced the built-in server under its own mount key**.
`org/resource-catalog.server.ts:41` still exports `RESERVED_OPERATOR_MCP =
"viberr"` for the operator-specific copy.

`org/resource-references.server.ts` is referential integrity (P13-KM-07). Two
reference homes: `agents/profiles/<id>.md` `resources.*` and `project.md`
`agents[].definition.resources.*`. `updateResourceReferences :48` rewrites on
rename, drops on delete, best-effort per file. **`nextList :78` treats a grant
list as a SET** (P14-KM-07). `countTemplateGrants :232` walks profile **files**,
not `listGlobalAgentProfiles` (which drops `controller.md`/`operator.md`), since
the delete rewrites every file. *(Ruling 108 explicitly leaves this path as an
open side door on the controller's locked grants —
`docs/architecture/decisions.md:1629-1637`.)*

`org/store-files.server.ts` (the StoreBrowser layer).
**`assertInsideRoot :162` is two-layer**: lexical `path.relative` **plus**
`realpathSync` on the existing part `:176-185`. `writeStoreFiles :281`
pre-flights so a conflict writes NOTHING; `readStoreDoc :412` (per-read ceiling
+ a `truncated` flag — the honesty contract `viberr_ops` relays);
`writeStoreDoc :448` requires explicit `overwrite`. GitHub import
`importGithubSnapshot :630`: `IMPORT_MAX_FILES = 100`,
`IMPORT_MAX_BLOB_BYTES = 1 MB`, provenance dotfile `.viberr-import.json :551`,
**refresh-in-place** when the marker matches `:851-866`, and
**`COLLISION_CAP = 32` `:849`** (F20-1: an unbounded `existsSync` loop pegged the
event loop on a ghost inode).

`org/gagents.server.ts` — global profile templates. **`summary` is frontmatter
`desc`, `persona` is the markdown body `:41-52`.** `usedByProject :117`
**excludes archived projects**. Create starts from
`conservativeGrantsFor("agent") :309`.

`org/org-users.server.ts` — `statusOf :85` reads a local account with **no
password** as `invited`, not `active` (F20-12). `updateOrgUser :235` must call
`syncIdentityEmail :261`. `pruneUserFromProjects :329` runs `releaseTasksOwnedBy`
in **every** project `:361-366`. `deleteOrgUser :403` prunes BEFORE deleting rows.
`findDomainAllowlistRole :588` is the hook live Google OAuth calls.

`org/org-view.server.ts` — the org-settings read model.
`countGrants(kbs.map(k => k.dir), "kb", …)` at `:191` (deployment grants) and
`:196` (template grants): **KBs count by `dir`, MCPs and skills by `name`**.

`org/connections.server.ts` — `CONNECTION_REQUIRED_SCOPES` is an **alias** of
`DEFAULT_REQUIRED_SCOPES :61` (B-GH6). `CONNECTION_REVALIDATE_AFTER_MS = 24 h
:235`; `ensureConnectionFresh :253` does at most ONE probe and **a
`network_error` is never a downgrade** `:280`. Nothing is persisted unless
validation passes (`createConnection :434`, `replaceConnectionToken :494`);
removing the default connection is refused `:585`.

**Secrets (`app/server/secrets/`)** — unchanged.
`secret-box.server.ts` — box format `v1$<iv b64>$<ct b64>$<tag b64> :17`,
AES-256-GCM, random 12-byte IV per seal. `previousSecretKeys :55` reads
`VIBERR_SECRET_ENCRYPTION_KEY_PREVIOUS` from **raw `process.env`, not
`getEnv()`** (an operational rotation-window value); malformed entries are
skipped **in silence** `:68`. `openSecretRotating :88` returns
`{plaintext, staleKey}`. `openSecret :144` throws typed
`SECRET_BOX_INVALID`/500, **never garbage plaintext**.

`key-rotation.server.ts` — **`SEALED_STORES :43` is the registry**:
`github_pats.encrypted_token`, `org_mcp_servers.cred_ref`,
`oauth_providers.client_secret` (id column is `provider`), `s3_audit_config
.secret_box`. **`key-rotation.server.test.ts` fails if a third home of
`sealSecret(` appears.** `secretKeyRotationStatus :195` is READ-ONLY;
`resealSecrets :283` **writes and needs the writer lock**, and leaves an
unreadable box exactly as it is `:318-321`.

`pat-store.server.ts` — `DEFAULT_REQUIRED_SCOPES = ["repo","pull_request:write"]
:38`. **`getPatToken :208` is server-internal** and lazily re-seals in place.
`markWriteScopeProven :270` takes **the patId that actually made the call**
(F28-U2b). With no bound PAT the health source is **always `"none"`** `:491-497`.

`pat-validator.server.ts` — **health checks do not write** (A8 `:48-62`):
repo-write is proven read-only from `GET /repos/{r}`'s `permissions`; the old
dry-run `PUT` survives only as opt-in `VIBERR_GITHUB_WRITE_PROBE :98` (read
straight off `process.env`). `repoPermissionsSchema :113` is **per-FIELD tolerant
(F21-11)**. A **5xx is `network_error`, not a rejection**.
`REVALIDATE_COOLDOWN_MS = 60_000 :543` reuses only a `valid` result, and only for
the **same repo** `:645-653`. `WRITE_EVIDENCE_SCOPES :556` — a write scope's
violation clears only on `header`/`probe` evidence, never `assumed` `:677-685`.

`git-output-redact.server.ts` `redactGitOutput :79` — three layers, strongest
first: **by value** (`split`/`join`, **no length floor** `:87-95`), then URL
userinfo `:102`, then anchored patterns `:104`. Then ANSI/C0 stripping and a
clamp **from the END** (`MAX_DETAIL_LINES = 8`, `MAX_DETAIL_CHARS = 600`).

**Seed (`app/server/seed/`).** `runSeed :127` ships built-in templates + a
bootstrap admin **only on an empty users table** + a rescan; no projects, tasks
or mock data (that is `test-support/demo-seed.ts`). `DERIVED_TABLES :76` is what
`--reset` deletes. **`resetStore :104` deletes only `runtimes/<backend>/`
transcript dirs — never `codex-home/auth.json` or `claude-home`** (P11-04).

`default-assets.server.ts` — assets are **read from disk at runtime, not Vite
`?raw`** `:5-27`; `readAsset :33` fails LOUDLY rather than shipping an empty
persona. `SHIPPED_MANIFEST_REL = state/shipped-assets.json :165`;
**`PRIOR_SHIPPED_HASHES :184` must be appended by hand when you edit a shipped
asset**, and an unrecognized hash fails SAFE (store copy preserved + WARN).

`agent-catalog.server.ts` — `SEED_AGENT_PROFILES :83` (operator, developer,
reviewer). `mapActions :30` resolves action LABELS via `capabilityByLabel`, and
an unmatched label **degrades to a display-only extra**. The operator
deliberately carries **no `viberr` MCP grant** `:91-96`. Developer defaults to
Claude and ships `use-browser` + web egress **as a pair**, both `direct`
(`:154-161`) — note this is DIRECT by default, not off. Reviewer forbids
`"Commit & push to the branch"` using the **exact catalog label** `:192`.
`ensure-base-agents.server.ts:32` — the operator is unconditionally ensured on
every project; base specialists are backfilled **only into a project with no
specialist deployments at all** `:51-62`.

**Ops (`app/server/ops/`).** `maintenance.server.ts` introduces **no new
writer** — a timer inside the process that already holds the lock, on the same
`getDb()` handle `:35-43`. `DEFAULT_MAINTENANCE_INTERVAL_MS = 6 h :65`,
`DEFAULT_DISK_CHECK_INTERVAL_MS = 5 min :68`, **`MIN_PRESSURE_PASS_GAP_MS =
30 min :71`**. `MaintenanceOptions.dataRoot :93` is now threaded into
`applyRetention` `:153-157` (ruling 102), `pruneRuntimeTranscripts` `:172`,
`reclaimTerminalTaskWorkspaces` `:192` and `measureDataRootSpace` `:201`.
`activeRunCount :120` **returns 1 on an unreadable table** `:131-134`.
`runMaintenancePass :142`; `checkDiskPressure :328`;
`startMaintenanceScheduler :376` runs **no immediate pass**.
`maintenanceState()` is what the health snapshot reports.

`transcript-retention.server.ts` — four rules `:36-49`: only under the data root
(a redirected `CLAUDE_CONFIG_DIR`/`CODEX_HOME` is untouched), **only `*.jsonl`**,
mtime not DB state, best-effort. Both windows default to 30 days; `0` disables
that half. **C3 (pass 31)**: the two window variables are now read through
`getEnv()` rather than `process.env[name]` (comment at `:79`).

`disk-space.server.ts` — **absolute bytes, not percentages** (a workspace clone
is 11-16 MB). `DEFAULT_DISK_LOW_FREE_BYTES = 2 GiB :45`,
`DEFAULT_DISK_CRITICAL_FREE_BYTES = 512 MiB :47`; `envBytes :64` reads
`VIBERR_DISK_LOW_FREE_MB` / `VIBERR_DISK_CRITICAL_FREE_MB` off raw
`process.env`; `diskThresholds :78` clamps `low = max(low, critical) :86`.
`measureDataRootSpace :102` returns **`null`, never a fabricated zero** (R17-5);
`cachedDataRootSpace :138` with `DISK_MEASUREMENT_TTL_MS = 5_000 :128` (the
health probe is unauthenticated and polled). **The block-size arithmetic at
`:109-111` is wrong on virtiofs — see Findings / F32-1.**

`build-info.server.ts` — identity from something REAL or reported absent `:19`.
Build env vars → `package.json` version → `.git` **file reads only**; resolved
once and cached.

**NEW — `app/server/ops/health-snapshot.server.ts` (ruling 107 prep).**
`healthSnapshot(db) :64` assembles the whole `/resources/health` reading in one
place so the route and the controller's `viberr_ops` tool cannot drift
(docblock `:11-23`). `HealthSnapshot :35` = `{status, degraded[], projections
{projects,tasks}, watcher, kbWatcher, lock{pid,hostname,startedAt}|null, backends
{claude,codex}, browser, disk, maintenance, build}`. **KEY ORDER IS PART OF THE
CONTRACT** `:56-59`: `app/routes/resources.health.ts:65-74` spreads it straight
into the body after `ok`, so the wire bytes are unchanged; insert new fields at
the END. `degraded` is computed from `watcher | kbWatcher | lock | disk` `:83-87`.
It throws only when SQLite is unreachable — the route turns that into its 503
(`resources.health.ts:83`).

**Audit (`app/server/audit/`).** `recordAudit :61` — `details` must be
secret-free, and recording must never break the action that triggered it
(failures logged and swallowed `:83-88`). `AuditDetailValue :38-45` names the
value type. Actors `SYSTEM_ACTOR :23` / `OPERATOR_AUDIT_ACTOR :28`; actions are
lowercase dot-separated facts.
`audit-query.server.ts`: `RECONCILE_TASK_AUDIT_ACTION :31` is written
unconditionally after every early return, and `latestProjectReconcileCheckAt :80`
**UNIONs both actions** (F19-22).
`audit-export.server.ts` — `AUDIT_EXPORT_MAX_ROWS = 100_000 :16`, every filter is
a bound placeholder `:61-63`, and **`csvField :145` neutralizes formula
injection** by prefixing `'` to a cell starting with `= + - @` (F26-10).
`s3-config.server.ts` — the secret lives in its **own `secret_box` column**
`:10-16`; `getS3AuditConfigForUse :67` opens rotating + lazily re-seals (F26-8).

**Injection budgets.** `SKILL_INJECTION_BUDGET = 24_000`
(`files/skill-body.server.ts:36`) and `KB_INJECTION_BUDGET = 24_000`
(`files/kb-injection.server.ts:64`) are **shared across the whole declared list,
not per item**. Per-doc `### <rel>` headings are **charged** against the budget
(`kb-injection.server.ts:222-225`). When nothing fits, the "omitted entirely"
marker is returned on its own plus a structured `unresolved` `:236-254`.
`isInjectableKbDoc :58` is owned by the injector so count and injection answer
the same question. `collectKbDocs :75` realpaths the root, keeps a `visited`
cycle guard, caps depth at 32, re-checks containment per directory and
`lstat`-skips symlinks. `KB_PRECEDENCE_NOTE :343-353` is emitted **only alongside
real KB text**. `resolveContainedSkillFile :82` refuses a symlinked folder or
`SKILL.md`, with a realpath containment check as defense in depth `:116-122`.
The shared text-extension set is `app/shared/text/store-extensions.ts`.

**Attachments** (`files/task-attachments.server.ts`, now 260 lines) — **the
directory is the truth**: no table, no upload path, no retention machinery
`:14-17`. `LIST_CAP = 100 :35` with a sibling `countTaskAttachments :78`.
`resolveTaskAttachment :212` goes through `resolveStoreSegment`; a traversal
throws and the route turns that into a **404, never an oracle** `:20-21`.

**NEW (ruling 105 + its review round):**
- `attachmentNamesSince(slug, key, sinceIso) :108` — every file whose mtime is
  at-or-after the run's start, newest first. **Deliberately UNCAPPED** `:102-106`:
  it used to ride `listTaskAttachments`, whose `LIST_CAP` silently limited the
  window to the newest 100 files, permanently orphaning the overflow in the exact
  drowning case the prune targets.
- `MCP_STAMPED_NAME_RE :146` =
  `/^[a-z][a-z0-9_]*-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\./` — the
  classifier is the **machine timestamp itself**, not a prefix allowlist, so a
  future MCP tool's sibling artifact cannot start drowning the panel.
  `VISUAL_EVIDENCE_RE :151` (`png|jpe?g|webp|gif|pdf`) always wins.
- `isBrowserWorkingArtifact(name) :165` = stamped AND not visual evidence.
- `pruneBrowserWorkingArtifacts(slug, key, names, citedIn, dataRoot) :178` —
  deletes the uncited working artifacts and returns `{kept, pruned}`. A citation
  (the exact filename appearing anywhere in the corpus) keeps the file. **ENOENT
  on unlink counts as PRUNED, not kept** `:198-205` — the producing event must
  never claim a file the directory does not hold; any other error keeps it listed.
- **`INLINE_TYPES :223` is a WHITELIST** — png/jpg/jpeg/webp/gif/pdf/txt/log/md/
  json, plus **NEW** `yml`/`yaml`/`csv` served as `text/plain` `:235-238` so the
  in-app read-only viewer can fetch them. HTML/SVG/JS are never inline: a stored
  page served on the app origin would be stored XSS with the viewer's session.
  `attachmentContentType :241` falls back to `application/octet-stream`.

Prune wiring lives in `applyAgentCompletionEffects`
(`tasks/task-actions.server.ts:3139`):
`runAttachmentsRaw` from `attachmentNamesSince` `:3196`; a sibling-live-run count
`:3334-3342` (a task-wide mtime window means a finishing run must not delete a
still-working sibling's files before that sibling's citations exist); the
citation corpus `:3347-3358` = final reply + the raw Codex envelope `fullText` +
evidence rows + the ask-human question title/body + every timeline text since the
run started; the prune itself `:3359-3370`, gated on
`finished.state === "finished" && siblingLiveRuns === 0`; survivors become
`runAttachments :3383`, which is what the producing event claims.

### 2.4 Read models (loader shapes)

`TaskSummary` (`app/shared/mapping/task.server.ts:146`) is what board cards,
the review queue and the inbox render from — it is built from
`task_projections` ALONE, which is why facts like `acceptance :171`,
`continuity :182`, `blockReason :186`, `atAcceptanceBoundary :204`,
**`unownedPr :220` (NEW)** and `workRevisionSha` had to be projected rather than
re-derived. Mapper `mapTaskProjectionRow :578`; `unownedPr` is read out of the
`github` cache at `:641`.
Other mappers: `actor.server.ts` (`createActorResolver`),
`project.server.ts`, `notification.server.ts`, `task-event.server.ts`,
`user.server.ts`.

Query modules (all read-only over the projection):
`projections/board-query.server.ts` (`getBoard :293`, `listProjectTasks :177`,
`compareBoardOrder :60`, `BOARD_RANK_BASE = 1_000_000 :39`),
`task-query.server.ts` (`getTaskSummary :79`, `getTaskDetail :223`,
`listTaskEvents :121`, `listTaskDiagnostics :191`),
`review-queue.server.ts` (`getReviewQueue :114`),
`decisions.server.ts` (`decisionsRequiring :84`),
`notifications.server.ts`, `activity-feed.server.ts`
(`ACTIVITY_STREAM_LIMIT = 200 :42`, `AUDIT_SCAN_CAP = 1000 :527`),
`task-activity.server.ts` (`QUIET_AFTER_AGENT_MS = 1 h :46`,
`QUIET_AFTER_HUMAN_MS = 72 h :57`),
`policy-violations.server.ts`, `agent-deployments.server.ts`,
`insights/insights-query.server.ts`, `provenance/provenance-query.server.ts`.

**NEW — coordination overhead (F31-D6)**, `insights/insights-query.server.ts`:
`OversightSummary.coordination :96` = `{coordinationCostUsd, totalCostUsd,
share}`. Coordination is `operator` **+ `controller`** (both are machinery that
decides what the working agents do; the runtime already treats them as one
class). The numerator is one extra `CASE` column in the SAME totals aggregate
`:452-454` (declared `totals_schema.coordination_cost :138`) rather than a second
scan; the ratio is computed at `:465-471` and threaded into
`oversightSummary(db, filter, coordination) :270-275,:430`.
**`share` is null when nothing reported cost — never a fake 0%.**

### 2.5 The controller (server side)

Modules under `app/server/controller/` (5283 lines incl. tests):

- **`controller-profile.server.ts` (307 lines)** — the controller's own
  configuration (ruling 99 + 106 + 108).
  `CONTROLLER_PROFILE_ID = "controller" :39`;
  `readControllerDefinition :139` reads the BODY of
  `agents/definitions/controller.md` (path built at `definitionFilePath :129`),
  falling back to `FALLBACK_CONTROLLER_DEFINITION :120`;
  `resolveControllerConfig :171` is tolerant (a missing/invalid template degrades
  to defaults and reports `profilePresent: false`), and **`effort` now flows
  through it** `:177`. Note the magic string at `:176`: a stored model of
  `"orchestration runtime"` is treated as "unset".
  `saveControllerConfig(db, input, actor, ctx) :203` writes the profile template
  (resources + model + effort) and, when a non-blank body was given AND
  instructions are unlocked, the definition file `:279-289`; audit
  `org.controller.updated :290` with `definitionEdited` reflecting whether a write
  actually happened `:303`.
  **RBAC is the CALLER's** — `/org/settings` gates on org admin
  (`app/routes/org.settings.tsx:198`).

- **Ruling 108 locks** — `ControllerSectionLocks :49` (`skills | kb | mcps |
  instructions`, `true` = locked), `CONTROLLER_UNLOCK_ENV :58`
  (`VIBERR_UNLOCK_CONTROLLER_SKILLS/_KB/_MCPS/_INSTRUCTIONS`),
  `CONTROLLER_SECTION_LABEL :67` (shared by the refusal sentence and the panel
  note), `CONTROLLER_UNLOCK_VALUE = "enabled" :77`, `unlockFlag :78`
  (case-insensitive, trimmed; **anything else — `disabled`, a typo, unset — keeps
  it locked, i.e. fails closed**), and `controllerSectionLocks(env = getEnv())
  :84` typed as `Pick<Env, …>` so the schema keys are pinned.
  Enforcement is in `saveControllerConfig`, not the route, so **every** save path
  is bound (`ctx.locks` exists for tests only, `:215-221`):
  - `resolveGrant(section, stored) :234` — an unlocked section writes the input;
    a locked section writes the **STORED list verbatim** (order and duplicates
    included), so no save can perturb the on-disk grants; only a **non-empty
    list that is a different SET** (`sameSet :222`) is refused.
  - Blank means keep. The panel renders locked sections read-only and posts
    BLANK for them, which is why a stale page copy can never be posted back as a
    change.
  - Instructions `:254-261`: a non-blank body differing from the stored doctrine
    is refused; blank keeps it; a locked save never rewrites the file.
  - `lockedChange :226` throws a 403 naming the section label and its unlock
    variable and value.
  - **Model and effort are deliberately not sections** `:44-47` — picking a tier
    is day-to-day admin work; rewriting what the controller IS operates above the
    org.
  - `viberr_ops` is **not** a section and stays mounted under every flag
    combination.
  Scope is deliberately narrow (`docs/architecture/decisions.md:1629-1637`): the
  lock covers the settings tab only. Deleting/renaming a resource on the Agent
  resources tab still prunes the controller's grant via the shared
  `resource-references` rewrite, and editing a granted skill's or KB's file
  contents still changes what the controller loads.

- **`controller-tool-guards.server.ts` (152 lines, NEW in ruling 107)** — the
  refusal machinery both in-process controller servers share, so they refuse in
  ONE voice (`:14-26`). `ControllerToolUser :29`; `ControllerToolText :38` (a type
  ALIAS, not an interface — only an alias picks up the implicit index signature
  the SDK's tool-result parameter needs `:35-37`); `notVisible(slug) :48`
  (uniform "no project … is visible to you", R15-4); `NotVisibleError :54`;
  `controllerToolGuards(db, user, dataRoot) :79` returning
  `{actor, orgAdmin, requireOrgAdmin, requireVisible, run, runWith, json}`.
  - `actor :84` = `{userId: user.id, label: "<email> · via controller"}` — the
    instrument is disclosed in the audit label.
  - `orgAdmin :87` resolves **LIVE** per call (`isOrgAdmin`), never snapshotted at
    conversation start.
  - `requireOrgAdmin :89` writes a `controller.authority.denied` audit row before
    throwing (P13-D-8 parity: instance denials must not read cleaner than project
    ones).
  - `requireVisible :101` calls `assertProjectAction(db, "any-member", …,
    {allowArchived: true})` and converts ANY failure into the uniform
    `NotVisibleError`.
  - `run :112` / `runWith :136` map an `AppError` to `[denied]` (403/401) or
    `[error]`, relay a `NotVisibleError` verbatim, and turn anything else into one
    generic `[error]` sentence after logging.
  - `json :150` is `JSON.stringify(value, null, 1)`.

- **`controller-ops-mcp.server.ts` (369 lines, NEW — `viberr_ops`, ruling 107)**.
  `CONTROLLER_OPS_MCP_NAME = "viberr_ops" :75`,
  `CONTROLLER_OPS_INSTRUCTIONS :77`, `ControllerOpsDeps :59`,
  `ControllerOpsMcp :66`, builder `buildControllerOpsMcp :127`.
  **NOT REMOVABLE BY CONSTRUCTION** `:39-46`: no config is read, no grant row
  exists, the mount key is reserved at all three layers. **READ-ONLY** `:48-50`.
  Authority is the asking person's own, resolved LIVE per call through the shared
  guards `:52-56`. Three tools:
  - `instance_health :163` — `healthSnapshot(db)` spread, plus
    `backendCredentials` (`backendCredential :117`) and
    `runs: runConcurrencySnapshot(db)` (`runtimes/run-service.server.ts:1367`).
    The READING is ungated because it is what `/resources/health` already serves
    unauthenticated; only the credential **detail sentence** is org-admin gated,
    because it names the deployment's config directory `:170-184`.
  - `read_run_log :200` — `DEFAULT_LOG_LINES = 200 :98`, `MAX_LOG_LINES = 500
    :99`, bounded on EVERY path. `requireRunVisible :149` applies exactly the
    `/resources/run-log` gate: a controller run authorizes through
    `canReadControllerRunLog`, everything else through project membership, and a
    **missing run answers the same not-visible sentence** (`notVisibleRun :104`)
    so a probe cannot walk run ids. `since` with `before` is **refused** rather
    than letting one silently win. Backward mode delegates the bound to
    `getRunLog`; forward mode slices tool-side because `getRunLog` ignores `limit`
    there BY DESIGN (the console's live tail is bounded by its own cursor) — the
    tradeoff is written down at `:252-259` (if the unbounded SELECT ever bites,
    push a LIMIT into `listRunLines`, never grow the reply).
    `headSeq/oldestSeq/hasMore` are **not relayed**: they are page-local cursors
    for a stateful console and a model with no second source reads them as facts
    about the run `:262-266`. In their place: `page.{firstSeq,lastSeq,olderExist,
    newerExist,next}` computed against `runLineStats(db, runId)`
    (`run-store.server.ts:351`), plus `run.logLines` = the run's TRUE total.
  - `read_store_doc :329` — one text document out of a KB or skill folder,
    **org admins only** (`requireOrgAdmin`), via `resolveStoreTarget` +
    `readStoreDoc`; `truncated` is reported, never hidden (a clipped document that
    reads as complete is how a model states a half-read file as fact).

- **`controller-run.server.ts` (696 lines)** — `buildControllerMounts :150` is
  where the two in-process servers and the org grants come together
  (docblock `:133-149`): `viberr_controller` (toolkit) + `viberr_ops` spread
  first, org servers LAST, and org servers cannot shadow either because the
  RESOLVER refuses to resolve a reserved name. `runControllerTurn :180`,
  `settleTurnForTests :386`, `conversationTurnState :473`,
  `recoverControllerConversations :491`, `transcriptDigest :595`,
  `buildControllerSystemPrompt :626`. The persona now says "org MCP servers" in
  both arms so it cannot claim "no MCP servers are attached" one line above
  "Built-in diagnostics (viberr_ops) are always attached".

- **`controller-toolkit.server.ts` (1651 lines)** — the governed CRUD toolkit
  (ruling 99). Its private refusal machinery moved wholesale into
  `controller-tool-guards.server.ts`.

---

## 3. The action layer

### 3.1 Shape of a governed mutation

Every governed write lives in `app/server/tasks/*.server.ts` and takes
`(db, input, actor: TaskActor, ctx: TaskMutationContext)`.

`TaskActor` (`tasks/task-mutation.server.ts:44`) = `{userId, label}` where
`label` is the audit label (the email).
`TaskMutationContext :50` = `{dataRoot?, operatorAuthorized?, operatorRun?}`.
**`operatorAuthorized` is in-process operator authority — routes must never set
it** `:54`. `operatorRun :56` carries `{backend, autonomy, reactDepth,
transitionDepth?}` for the bounded loops.

`task-actions.server.ts` widens that for its own callers:
`TaskActionDeps :228` (`pushWorkspaceBranch`, `openTaskPr`, `mergeTaskPr`,
`runOperator`) and **`TaskActionContext = TaskMutationContext & {deps?,
fetchImpl?}` `:239`** — the injectable seams for the delivery/acceptance
collaborators this module reaches through dynamic imports, plus the mock GitHub
transport. Production callers pass a plain `TaskMutationContext`.

Three substrate helpers live in `task-mutation.server.ts` *specifically to break
an import cycle* (`:16-42`): `specialist-run → agent-toolkit → task-actions ⇢
(dynamic) specialist-run`. Hiding that cycle behind `await import()` produced a
live failure — `resolvePacket`'s `retry_other_backend` arm imported a
half-evaluated `specialist-run` namespace and `startAgentRun` threw
`ReferenceError: Cannot access '__vite_ssr_import_30__' before initialization`
inside a `catch` that only logged. The helpers:
- `loadProjectContext(ctx, slug) :81` → `ProjectContext {slug, stages,
  workflow, memberRoles, archived}` read straight from project.md (type `:67`).
- `taskRef :104`, `reprojectTask :117` (calls `rebuildPath` on the one file).
- `notifyTaskWatchers :149` — owner + project admins/maintainers, honouring each
  recipient's routing prefs; a **deliberate fail-open** on a corrupt project/task
  file. `TaskWatcherNotice.exceptUserId :140` and **NEW
  `exceptUserIds :144`** (V2/T13 per-recipient dedupe: the packet row and the
  quality fallback must never both land in one person's queue, but a watcher
  whose prefs dropped the packet row still needs the fallback), applied at `:190`.

Canonical mutation body:
```
const project = loadProjectContext(ctx, slug);
requireAction(db, project, actor, "<rbac-action>", "<what>");   // + archive freeze
const existing = readTaskFile(taskRef(ctx, slug, key));         // pre-checks
await updateTaskFile(taskRef(...), (parsed) => { ...mutate... }); // locked RMW
reprojectTask(db, ctx, slug, key);                              // synchronous
recordAudit(db, { action, actor, subjectKind, subjectId, projectSlug, taskKey, details });
return summaryOrThrow(db, slug, key);
```
`setTaskArchived` (`tasks/task-actions.server.ts:5802`) is a compact, complete
example: idempotence check `:5820`, note event `:5850`, locked write cancelling
packet/recs/schedules `:5862-5880`, reproject `:5887`,
`markTaskPacketApprovalRead :5888`, audit `:5890`, fire-and-forget goal
reconcile `:5906-5912`.

Routes with `action` exports (all under `app/routes/`; URL mapping in
`app/routes.ts`):

| file:line | purpose |
|---|---|
| `_index.tsx:78` | Home — `pin`, `view`, `rescan` (org-admin + single-flight), `rebuild-projections`, `create-project` |
| `controller.tsx:41` | instance controller conversation — `send` |
| `login.tsx:67` | `login`, `set-password` (origin check only, no session yet) |
| `logout.tsx:11` | revoke session, audit `auth.logout` |
| `notifications.read.tsx:21` | `read` / `read-all`; emits user-scoped `notification.read` |
| `prefs.theme.tsx:19` | persists `users.theme` **and** the `viberr_theme` cookie |
| `profile.tsx:67` | `identity`, `set-notif`, `set-motion`, `set-tl-default`, `change-password`, `github-disconnect` |
| `org.settings.tsx:198` | org admin — connections, members, resources, MCP, OAuth, **controller** (manual CSRF) |
| `project.agents.tsx:135` | `create-profile`, `deploy-profile`, `update-profile`, `delete-profile` |
| `project.board.tsx:45` | `create-task`, `reorder` (carries the acceptance ack on a terminal drop), `rescan` |
| `project.controller.tsx:64` | `send`, `goal-op` (pause/resume/cancel/skip_link/retry_link) |
| `project.github.tsx:105` | `reconcile`, `grant-scope`, `set-credential`/`clear-credential` |
| `project.policy.tsx:44` | `set-role`, `set-boundary` (admin) |
| `project.settings.tsx:82` | project save, stage CRUD, members, repo repair, branch cleanup, archive/delete |
| `project.task.tsx:406` | **23 `case` labels** — comment `:424`, update-goal `:470`, set-task-metadata `:478`, resolve-packet `:500`, request-maintainer-decision `:574`, complete-merge `:598`, accept-completion `:610`, deliver-review `:648`, archive-task/restore-task `:673-674` (one block), force-accept `:685`, owner-take `:701`, owner-assign `:713`, owner-release `:730`, transition `:747`, run-interrupt `:778`, run-agent `:795`, release-agent `:849`, apply-recommendation `:863`, dismiss-recommendation `:888`, run-operator `:900`, schedule-action `:983`, cancel-schedule `:1038` |
| `api.auth.$.ts:15` | forwards the raw Request to better-auth; **no app CSRF** |
| `resources.events.ts` | `GET /resources/events` — the SSE stream (plain 401 JSON, not a redirect) |
| `resources.health.ts:65` | unauthenticated probe; body = `{ok, ...healthSnapshot(db)}`; 503 `{ok:false,status:"down"}` when SQLite is unreadable `:83` |

*(pass 31 said "24 intents"; the actual `case` count is 23 —
`archive-task`/`restore-task` share one block.)*

**End-to-end example — `intent=set-task-metadata`:**
1. `project.task.tsx:406` `requireFormAction` → auth, db, formData, CSRF.
2. `:420` `requireVisibleProject(...)` **outside** the try (404, not 403).
3. `:478-497` parse the three axes and call `setTaskMetadata(db, input, actor)`.
4. `task-actions.server.ts:678-679` `loadProjectContext` →
   `requireAction(..., "edit-task-meta", ...)` → archive freeze + role check.
5. `:680-705` **all validation before any write** — a bad value fails the whole
   edit before any file write (never a half-applied patch).
6. `:706-730` preconditions: file exists `:706`; archived-task guard `:714`
   (F26-13); no-op short-circuit when every provided axis already holds its
   target `:730`.
7. `:746` `updateTaskFile` → lock → read → stale-read repair → **write guard** →
   mutate (`priority`, derived `urgent`, `labels`, `dueDate`, and a `note`
   timeline event unshifted) → `updatedAt` → serialize → atomic write →
   `rememberWrite`.
8. `:765` `reprojectTask` → `rebuildPath` → `rebuildTaskFile` (hash
   short-circuit, diagnostics, readiness derivation, upsert, `task_events`
   rewrite, provenance, **commit-marker hash last**) →
   `emitProjectionEvent("task.updated")`.
9. `:770` `recordAudit("task.metadata.updated", …)` with only the axes that
   actually changed.
10. Publisher hydrates `readTaskFacts`, `sseEventSchema.parse`s, and
    `publishSseEvent`s to every matching connection; clients revalidate their
    own loaders (the payload is a reference, not the new state).
11. `{ok:true, intent, toast}`. Any `AppError` is caught at
    `project.task.tsx:1063` by `appErrorResponse`; anything else is re-thrown to
    the root `ErrorBoundary`.

### 3.2 Authority

`requireAction(db, project, actor, action, what)` —
`tasks/task-actions.server.ts:290` — is the chokepoint. It first calls
`requireProjectMutable(project, what)` (the **R6-3 archived-project freeze**) and
then `requireProjectAuthority(db, project, actor, rolesForAction(action), …)`.

`app/shared/rbac.ts` is the single source for enforcement AND the Policy page's
permission table. `RBAC_DEFINITIONS :61` (19 actions), `ACTION_ROLES :97`,
`roleCan :104`, `rolesForAction :110`. Roles are a strict tier
`ROLE_RANK viewer 0 < contributor 1 < maintainer 2 < admin 3 :31`.
Membership is the outer gate on **every** action (R15-4): a non-member gets the
unknown-slug 404 from the layout loader / `requireVisibleProject`, and `view` +
`comment` have no role narrowing at all — that membership gate *is* their whole
enforcement `:20-27`.

Three deliberate short-circuits, each of which re-asserts the archive freeze
**first** because it skips `requireAction`:
- `requireAcceptCompletion :322` — the live task OWNER (contributor+) may accept
  their own task.
- `requireDecisionAuthority :352` — R14-2: the owner governs decisions on their
  own task (packets AND recommendations).
- `requireAnyMember :277` — the loosest gate, for idempotent/no-op paths.

Agent authority is capability-based, not role-based: `app/shared/capabilities.ts`.
`UNIFIED_CAP_CATALOG :33` carries `{id, label, kinds, group, defaultMode,
promotable}`. Key invariants:
- `ALWAYS_HUMAN_CAPABILITY_IDS = merge-pull-request, transition-to-done,
  change-project-policy :211` — a server invariant list; stored modes can never
  grant these to agents.
- `GRANT_REQUIRED_CAPABILITY_IDS :403` — **absence is withholding, not
  permission** (P14-LV-01) for the six repo-write/verdict capabilities.
  Everything else keeps the permissive default when absent (notably
  `use-web-search-fetch`, whose catalog default is `direct`).
- `capabilityEnforcement(id) :298` → `both | claude-only | advisory`, checking
  ALWAYS_HUMAN **first** `:302` so `merge-pull-request` is never mislabeled
  "advisory on Codex".
- **CHANGED (ruling 101, repo-write parity)**: `execute-code-or-write-repo`
  moved OUT of `CLAUDE_ONLY_ENFORCED_CAPABILITY_IDS :281` and back INTO
  `ENFORCED_CAPABILITY_IDS :253`. A write-withheld Codex run gets the read-only
  sandbox back (`resolveCodexSandboxMode`, the P13-RT-02 shape R22 removed), so
  the headline write family binds on BOTH backends; write-GRANTED runs are never
  confined for their role's name. One disclosed carve-out: an evidence-granted
  write-withheld Codex run keeps workspace-write because the sandbox cannot
  express "read-only except attachments/". The SCOPED delivery commands
  (`create-task-branch`, `commit-push-branch`, `open-review-pr`,
  `comment-on-task`) remain claude-only `:281-296`.
  `tasks/specialist-tool-policy.ts:20-29` documents the two derived flags that
  carry grants to Codex: `webSearchWithheldFromDenylist → webSearchMode:
  "disabled"` and **NEW** `repoWriteWithheldFromDenylist → the read-only sandbox`.
- `coerceSpecialistCapabilityMode :372` — a specialist `recommend` normalizes
  **DOWN to `off`**, never up to `direct` (F20-21).
- `applyVerdictOutcomeGate :335` — the three advisory verdict outcomes
  (`VERDICT_OUTCOME_CAPABILITY_IDS :314`) are only as granted as
  `report-validation-verdict`.
- `applyGrantCouplings :570` = `repairDeliveryGrants :459` then
  `repairBrowserEgressGrants :535`. Delivery: an ABSENT headline is materialized
  `direct`, an EXPLICIT `off`/`human` is **respected** and reported (B-AG1).
  Browser→egress: the browser IS network egress and the mount fails closed either
  way, so an `off` egress under a `direct` browser is repaired UP.
- `defaultGrantsFor :165` vs `conservativeGrantsFor :192` — org-template
  creation (no capability UI) starts delivery + verdict outcomes WITHHELD.
- `capabilityByLabel :596`; `absentDeliverReviewPrMode(humanGatedBeforeWork)
  :625` — R15-9, derived from the workflow graph so runtime and policy display
  cannot drift.

### 3.3 CSRF and the form-action preamble

`app/server/auth/csrf.server.ts` runs **two independent layers**, both required
(unchanged).

**Layer 1 — origin proof** (`assertTrustedOrigin :62`), fails closed on all
three browser signals: `Sec-Fetch-Site` present and not `same-origin`/`none`
⇒ 403 `:63`; `Origin === "null"` or `Origin !== url.origin` ⇒ 403 `:77`;
`Referer` present with a foreign origin ⇒ 403 `:84`. The load-bearing clause is
`:96` — **none of the three present ⇒ 403** "Request origin could not be
verified." (§7.10/A7).

**Layer 2 — stateless double-submit token.**
`csrfTokenForSession(sessionId, secret)` `:25` =
`HMAC-SHA256(secret, "viberr-csrf:" + sessionId).base64url`. Issued by the root
loader (`app/root.tsx:74`) and rendered by `app/ui/csrf-input.tsx` as
`<input type="hidden" name="_csrf">`; `useCsrfToken()` serves programmatic
`fetcher.submit`. `assertCsrfWithSecret :102` reads `X-Csrf-Token` else the
`_csrf` field (`CSRF_FIELD_NAME :18`, `csrfFieldSchema = z.string().min(1) :22`
so a File part / empty string reads as "no token"), then `timingSafeEqual` with
a length pre-check `:121-126`.

Failure shape: `forbidden(reason) :36` throws a **raw `Response`** 403 with
`{"error":{"code":"forbidden","message":…}}`.

`requireFormAction(request)` — `app/server/auth/form-action.server.ts:7` — is
the whole preamble, in this order:
```
requireAuth(request)  →  getDb()  →  await request.formData()
                      →  assertCsrf(request, auth.sessionId, formData)
→ { auth, db, formData, actor: {userId, label: email}, intent }
```
`formData` is passed in because a body can only be read once. `intent` (a form
field) is the universal dispatch key.

`appErrorResponse(cause)` **re-throws anything that is not an `AppError`** so
genuine defects reach the error boundary.

Two deliberately different failure ergonomics:
- document-form routes let the thrown 403 `Response` hit the error boundary;
- fetcher routes use `app/features/shell/csrf-result.server.ts` `csrfError(...)`,
  which catches it and returns `{ok:false, error:"That request expired…"}` at
  403 — UI-32. Used at `routes/notifications.read.tsx:31` and
  `routes/prefs.theme.tsx:26`.

Exceptions to `requireFormAction`: `routes/login.tsx` (origin check only — no
session yet — plus rate limiting), `routes/logout.tsx`,
`routes/org.settings.tsx:198` (manual, so one session lookup serves both the
role gate and CSRF), and `routes/api.auth.$.ts:15` (**no app CSRF** —
better-auth enforces its own `trustedOrigins` check).

### 3.4 Identity and the authority resolver

`app/server/auth/require-user.server.ts` (unchanged):
- `authenticateWithHeaders :77` calls better-auth `getSession({headers,
  returnHeaders:true})`. **F10-17**: rolling sessions (30 d expiry, 1 d
  updateAge) emit a renewal `Set-Cookie` the old code discarded. Only the root
  loader uses the headers variant; `authenticate :114` drops them.
- Identity invariant: better-auth `user.id` === `users.id`. A missing or
  `disabled` user gets `DELETE FROM session WHERE id = ?` and reads as signed
  out `:88-91`.
- `requireAuth :161` → `{user, pwresetRequired, sessionId, sessionToken}` or
  `loginRedirect :135`, which normalizes single-fetch `.data` URLs;
  `safeReturnTo :121` strips `\t\n\r` **before** checking, because URL parsing
  removes them and `"/<TAB>/evil"` would reach the browser as `//evil`.
- Org roles: `ROLE_ORDER {member:1, admin:2} :181`, `requireRole :208`,
  `requireRoleAuth :222`.

`app/server/auth/project-authority.server.ts` is **THE** single authority
resolution path (R7-1). `resolveProjectAuthority(db, project, actor, allowed,
audit) :173` is non-throwing with three outcomes:
1. member role suffices `:180` — no audit row;
2. **org-admin emergency override (D2)** `:187` — `isOrgAdmin :152`, grants
   `role:"admin"` and writes a `project.org_admin.override` audit row. F19-30:
   `"any-member"` grants used to be exempt, which was false. Repeats collapse
   per 60 s on `ovr|${userId}|${slug}|${what}`; RbacAction gates are **never**
   collapsed `:208`;
3. denial `:232` — `project.authority.denied`, deduped 60 s unless
   `audit.silentDeny`. Dedupe state is a `WeakMap<DatabaseSync, Map<string,
   number>>` keyed per DB handle `:108-124`.

Throwing wrappers: `requireProjectAuthority :265`,
**`requireProjectMutable(project, what) :136`** (the single R6-3 implementation
— 409 `CONFLICT`), `requireRunAgents :293` (mutable-gate **then** `run-agents`),
`canRunAgents :311` (non-throwing @mention sibling with `silentDeny: true`), and
`assertProjectAction(db, action, slug, actor, what, opts) :337` — the
**slug-only** guard for config surfaces, which re-reads `project.md` fresh and is
what the controller guards call.

`requireProjectMember :33` (`auth/require-project.server.ts`) **collapses both
failure modes into one 404** `:81` (F19-28: throwing the 403 was a
project-existence oracle, because single-fetch honours a client `?_routes=`
filter). The 404 body echoes the slug only when the URL positionally named it.

Action-side twin: `routes/project-visibility.server.ts` `requireVisibleProject
:28`. React Router runs a child **action** without the parent's loader, so a
POST to `/projects/<slug>/tasks/<key>` reached the mutation for any
authenticated user. It is called **outside** the try block
(`project.task.tsx:420`, `project.board.tsx:53`).

**ALWAYS_HUMAN enforcement has three server-side points**, not one:
1. write coercion — `app/features/agents/agent-profile-actions.server.ts:301`
   (edit), `:353` and `:548` (create/deploy) force `mode = "human"` whatever the
   form said;
2. runtime tool denial — `app/server/tasks/specialist-tool-policy.ts:139`
   `isWithheld()` returns true unconditionally for an ALWAYS_HUMAN id, before
   any grant lookup; `CAP_DENY_RULES :51` maps
   `merge-pull-request → ["Bash(gh pr merge:*)"]`;
3. labelling — `capabilities.ts:302` checks ALWAYS_HUMAN **before** the
   claude-only set.

### 3.5 Action watchdog

`app/server/actions/action-watchdog.server.ts`.
`ACTION_WATCHDOG_MS = 30_000 :6`; `withActionWatchdog(label, fn, timeoutMs) :28`
races `fn()` against a timer that logs `action watchdog fired` and rejects with
a 503 `AppError`. Timer is `unref()`'d `:49` and cleared in `finally` `:53`.

Two things to know: it **cannot interrupt a synchronous CPU spin** `:19-26`
(the live F20-1 spin was exactly that — closed at the source: the bounded
collision loop in `org/store-files.server.ts:849` and the ESTALE/EIO arm in
`atomic-file.server.ts:69`); and despite the docblock, it still has **exactly
one production call site** — `app/features/home/project-create.server.ts:285`.

### 3.6 Errors and logging

- `AppError` (`app/server/errors/app-error.server.ts:26`) carries
  `{code, status, userMessage, details?}`; `details` is **scalars only** `:9`.
  Statics: `notFound :43` (404), `validation :55` (400), `forbidden :67` (403),
  `conflict :75` (409), `internal :83` (500). `isAppError :96`.
- `ERROR_CODES` (`errors/error-codes.ts:6`) — **never rename an existing
  value**: `internal_error, not_found, validation_failed, forbidden, conflict,
  db_migration_failed, secret_box_invalid, file_not_trusted,
  accept_disclosure_missing, accept_disclosure_stale`.
- An `AppError.message` is rendered to humans, so the **copy ban applies to
  server strings too** — `app/features/copy-ban.test.ts` scans user-facing
  `AppError` messages under `app/server/**`.
- Logging: `app/server/logging/logger.server.ts` — structured JSON on stdout,
  levels debug/info/warn/error (**there is no `fatal`**; `writeFatalSync :116`
  is the app's fatal channel, a synchronous `fs.writeSync(2, …)` used before any
  `process.exit`; rationale documented at `boot.server.ts:87-94`).
  `logging/request-context.server.ts` carries request correlation.

### 3.7 Interpretation layer

`app/server/interpretation/` is the *only* place derivation lives. It holds
readiness (`deriveReadiness`), diagnostics severity (`diagnostics-policy`) and
freshness. `freshness-policy.server.ts:19` merely **re-exports**
`~/shared/freshness` (`isMcpHealthStale`, `isReconcileStale`, `isStale`,
`STALE_AFTER_MS`) because the MCP rule is evaluated in a *client* component and
`.server.ts` modules are stripped from the client bundle — one definition, two
doors.

---

## 4. Task lifecycle

### 4.1 Stages and the workflow graph

Stages are **per project** and freely renamed/reordered. Nothing may hard-code
`triage`/`ready`/`review`/`done`. `resolveStageRoles(stages, workflow)`
(`app/shared/workflow/stage-roles.ts:41`) derives four structural roles:

- `entryId` = `stages[0]`
- `terminalId` = `stages[last]` (the human-only Done stage)
- `reviewId` = the first stage with an edge INTO terminal, falling back to
  `stages[length-2]`
- `workId` = the first stage with an edge INTO review

`isTerminalStage :107`, `stageName :75`, `stageLockReason :31`,
`humanGatesPreWorkAdvance :97` (R15-9 — the `strict` preset's signature read
straight off the graph; the preset itself is never stored).

`workflow` is maintained as a **CHAIN over `stages` order**
(`app/shared/workflow/transitions.ts:20-39`):
- `spliceStageIntoChain :118` — inserting at *i* replaces `prev→next` with
  `prev→new` + `new→next`, both inheriting the replaced edge's boundary.
- `rejoinChainAroundStage :183` — removing a stage merges its neighbours with
  the **stricter** boundary.
- `realignChainToStages :249` — a reorder re-aligns; a pair without a rule
  inherits the boundary guarding **entry into the target stage**.
- Two facts are always RECOMPUTED, never carried: a rule into terminal is forced
  `human`, and `locked` marks exactly the human-into-terminal rules
  (`withLock :73`, `createdRule :86`).
- `stageFlowPath :291` walks the *real* rules and returns `{chain, offChain}`.
- `strictestBoundary :48`, `defaultTransitionBy :57`.

Default template: `GOVERNED_TEMPLATE` (`app/shared/workflow/templates.ts:34`) —
5 stages `triage/ready/impl/review/done` with boundaries
`auto, auto, approval, human(locked)`. The "Lightweight · 3 stages" preset was
DELETED (P13-AP-04) `:16-23`.

### 4.2 `transitionStage` (`tasks/task-actions.server.ts:4329`)

Inputs beyond the target stage: `manual` (board dropdown, ANY stage,
admin|maintainer), `rework` (operator-only BACKWARD move on a `failing` task,
R7-4), `recommendationAuthorized` (set ONLY by `applyRecommendation`; never by a
route), `ack` (the acceptance disclosure echo, ruling 88).

Order of checks:
1. Same-stage ⇒ idempotent return.
2. Target must be a real stage — otherwise `AppError.validation :4377`.
3. `archivedTaskMoveBlockedReason` ⇒ **409** `:4388-4394` (F19-8).
4. Boundary lookup `:4396`; `isReworkMove` vetting `:4404`; otherwise a
   non-manual, non-boundary move is a validation error `:4415`.
5. **A human moving a task INTO the terminal stage IS accepting completion**
   `:4429-4442` — it routes through `acceptCompletion` (real merge attempt,
   `completion` event, packet/recs cleared), never a bare transition.
6. Operator authority `:4446` skips human RBAC but is **forbidden** from a bare
   move to terminal `:4451-4455`. Otherwise: `manual` ⇒ `requireProjectMutable`
   + `approve-transition` `:4462-4464`; `auto` boundary ⇒ `requireProjectMutable`
   + any member `:4473`; `approval` ⇒ `approve-transition` `:4479-4481`;
   `human` ⇒ `requireAcceptCompletion` `:4486`.
7. The write re-checks the stage **inside the file lock** `:4518-4534` (U3 /
   NFR16): already-there ⇒ write nothing; moved elsewhere ⇒ 409, because every
   guard above was evaluated against `fromStageId` and the event text already
   says "from <that stage>". `moved` `:4521` carries the in-lock verdict back out
   so the event, the audit row and the operator re-trigger follow the ONE write.
8. On success: `stage = toStageId :4539`; `previousStageId = fromStageId :4544`;
   **`heldAtStage = null :4548`**; terminal ⇒ `waiting = "none"`; leaving the
   entry stage attaches the operator (`operator = {assignedAtStageId}`) and
   clears the triage-time `input_required` gate.

Runaway backstops: `OPERATOR_REACT_DEPTH_CAP = 4 :175`,
`OPERATOR_TRANSITION_CHAIN_CAP = 8 :188` (enforced `:4635-4650`),
`nextTransitionChainDepth :192` (a human-authored transition restarts the chain
at 0), `operatorShouldReactToReply :197`.

### 4.3 Revisions, verdicts, validation

`nextWorkRevision(current, input)` (`task-file.schema.ts:934`): a head with the
**same tree** (or same head when the tree is unavailable) is the SAME review
subject — no new revision, prior verdicts stay valid. Anything else mints a new
id, which makes every prior verdict stale automatically. This helper has exactly
one caller (a delivering run's reconcile) and always mints `kind: "delivered"`.

`deriveValidation(fm)` `:747`, in order:
1. no `workRevision` ⇒ `none`
2. any required reviewer `request_changes` on the current revision ⇒ `failing`
3. required reviewers exist and ALL approved ⇒ `healthy`
4. `acceptance === "forced"` ⇒ `bypassed` (N20-14)
5. `noChanges && required.length === 0` ⇒ `none` `:796`
6. else ⇒ `changed`

Arm order is load-bearing: a recorded verdict is EVIDENCE and must never be
erased into "nothing to see".

`acceptanceBlockedReason(fm)` `:811` — required reviewers must have approved the
CURRENT revision. With no revision and required reviewers it names the way out
`:821-824` (F19-21). Sibling gates, all shaped reason-or-null:
`closedPrBlockedReason :855` (P13-D-4), `conflictingPrBlockedReason :876`
(P14-LV-07), `archivedTaskBlockedReason :895`,
`archivedTaskMoveBlockedReason :914`.

### 4.4 Acceptance ceremony (ruling 53 + 88)

`app/shared/acceptance-disclosure.ts` — the ceremony must DISCLOSE what it
accepts, and the confirmed click must **echo** the three displayed facts back:
`AcceptanceDisclosure {pr, revision, verdict}` `:35`, form fields
`ACCEPT_DISCLOSURE_FIELDS = {ackPr, ackRevision, ackVerdict} :48`,
`parseAcceptanceDisclosure :85` (deliberately strict), `acceptanceDisclosureDrift
(live, echoed, scope) :137` with `scope: "full"` pre-merge and `"in-lock"` (PR
fact excluded).

A **bare POST carries no echo and is refused** `:8-14`. Server side:
`acceptanceDisclosureOf` (`tasks/task-actions.server.ts:7687`) derives the
comparison from the task file using the same expression the projection stores in
`work_revision_sha` (`fm.workRevision?.headSha ?? "none"`, rebuilder `:608`).
`ack` is three-state, documented at `:7697-7712`.

Related server surface: `acceptanceTerminallyBlocked :7191`,
`acceptancePrHeadCheck :7276`, `acceptancePrHeadMismatch :7328`,
`acceptanceRefusalFor :7421`, `resolveAcceptanceAffordance :7505`,
`revisionDriftNote :7592`, `applyAcceptanceWrite :7769` (writes stage `:7879`,
`previousStageId` `:7877`, clears `heldAtStage` `:7882`, recomputes `validation`
`:7889`), `forceAcceptCompletion :8305` (admin-only, DG-2),
`completeTaskMerge :8401`.

### 4.5 Packets, recommendations, schedules

`resolvePacket` (`:5943`) dispatches on the stable `PacketOption.kind`, never on
English titles (ruling 7). `packetIdentity(p) :5927` is the packet id, or a
content fingerprint when absent — captured before the lock and re-checked inside
it `:6513-6518`, so a REPLACEMENT packet opened in the read→await→lock window
cannot be resolved by the stale action (F10-09). The write also clears
`heldAtStage` `:6522` and stamps `awaiting: "goal_edit"` for the `edit_goal` arm
`:6525-6527`.

Kind arms in the resolution switch: `hold_runtime_debug :6303`,
`edit_goal :6329`, `retry_other_backend :6351`, `archive_task :6376`,
`discard_branch :6408`, **`resolve_remote_collision :6438` (NEW)**, default
(`request_edit | redirect | custom`) `:6464`.
`NO_REINVOKE_KINDS`-style list at `:6569-6574` names the kinds that do **not**
re-invoke the operator, and now includes `resolve_remote_collision` ("the
re-delivery's own machinery owns the follow-up").

Post-write effects: `archive_task :6644` runs the real R14-3 archive contract
(with `deleteBranch: true` it deletes the remote branch, refused while the PR is
open); `discard_branch :6756` deletes the LOCAL never-pushed workspace branch
only (R20-2/F20-6);
**`resolve_remote_collision :6846` (NEW, F31-6)** — the three-step remedy, each
step best-effort AFTER the resolution write so the decision stands even when
GitHub misbehaves:
1. `resolveRemoteBranchCollision(db, ref, actor, ctx)`
   (`github/github-reconciler.server.ts:1580`) closes the recorded unowned PR and
   deletes the stale remote branch through the audited
   `deleteTaskRemoteBranch` path (its refusals still bind), then clears
   `github.unownedPr` `:1642-1643`;
2. on `status === "cleared"`, re-deliver through `manualDeliverForReview` — the
   same audited door the task page's "Deliver branch & open PR" uses;
3. a locked write `:6879-6905` lifts `readiness: blocked → ready` **only** when a
   delivery actually landed, and drops a `policy-engine` note naming any
   degradation. `waiting` stays `"human"`.
Its resolution requires `approve-transition` `:6443-6449` (it deletes a remote
ref).

**Authoring coherence (F31-6)**: `operatorOpenPacket`
(`tasks/operator-actions.server.ts:987`) now REFUSES a `discard_branch` option on
a task with a delivered revision or an occupied branch name `:1032-1046`, naming
`resolve_remote_collision` as the correct verb (live-caught: an operator authored
a remote-deletion promise onto the local-discard kind). Both operator legs' turn
guidance teaches the new verb (`:2488-2493`).

Recovery packets: opened when the bounded operator loop stalls
(`task-actions.server.ts:2262`), withdrawn after successful agent work
(`withdrawSupersededStuckPacket :2388`). The delivery-conflict withdrawal
(`withdrawSupersededDeliveryPacket :2485`) is scoped by the packet carrying
**either** `discard_branch` **or** `resolve_remote_collision` `:2495-2500` —
V10: keying on `discard_branch` alone would reopen F29-7 now that F31-6 refuses
that kind exactly when work stands on the branch. A reject-recovery packet
(`archive_task`) and any `accept_completion` packet are deliberately left alone.

`requestPacketMaintainerDecision :6975` escalates when the resolver lacks
authority.

Recommendation flow: `applyRecommendation :8507` / `dismissRecommendation :8705`
(audit action `RECOMMENDATION_DISMISSED_AUDIT_ACTION :8698`). Applying passes
`recommendationAuthorized` to the inner mutation, whose OWN cap still applies.

Schedules (`tasks/schedule.server.ts`): `scheduleTaskAction :131` /
`cancelScheduledAction :221` / `tasksWithUnresolvedSchedules :280` (reads
`schedules_json` from the projection, not every task file) / `fireDueSchedules
:335` / `startScheduleRunner :791`. Never fires on a terminal or archived task;
archiving cancels `pending`/`claimed` entries
(`task-actions.server.ts:5875-5879`). The claim lease is **re-stamped as the
drive begins** `:562-586` — stamped at claim time, a long clone made a later tick
read the claim as crashed and re-drive it (the FR39 double-drive the lease exists
to prevent).

### 4.6 No-change completion (R17-2 / R19-8)

`noChanges` marks a task that completes with nothing to deliver. Two producers:
a delivery attempt that found the branch empty (`performDelivery`'s
`nothing_to_review`), and a reviewer approving a task that never needed a branch
(`recordAgentCompletion`, which also mints the `kind: "verified"` revision the
verdict binds to). It is a **claim about a moment that has passed**, so
`acceptanceNoChangeCheck` (`tasks/no-change-completion.server.ts:280`)
re-verifies it against the LIVE remote before any writer closes the task to
Done; `assertVerifiedNoChangeStillApplies :339` is the in-lock assertion.
Cleared the moment a delivery opens a PR. Do not hand-set it.
Also here: `noChangeApplies :69`, `noChangeCandidate :79`,
`probeNothingToDeliver :107`, `noChangeCompletionEvent :361`.

### 4.7 Engagements are written by the DISPATCH (ruling 98)

`startAgentRun` → `dispatchAgentRun`
(`tasks/specialist-run.server.ts:1099`, `:1116`). Running an agent that is not
yet engaged **engages it** — the pre-assignment ceremony is gone `:1140-1151`:
- posture derives from the profile's own capability grants: delivering iff the
  task has no deliverer AND the profile holds a repo-write grant
  (`view.capabilities?.delivery === true` `:1162`); supporting otherwise.
- a delivering request against a profile with no repo-write grant is **refused
  by name** with the remedy `:1169` (R21-2 posture), on BOTH doors to
  `delivers: true` — the second door (`input.delivers === true` on an already
  supporting engagement, `:1205`) got the same check `:1222`.
- `assignSpecialist :673` / `assignReviewer :848` are the actual engagement
  writers; `removeReviewer :980`.
- Single-flight: a delivering dispatch refuses with 409 when a live `primary`
  run exists `:1258-1274`; supporting runs get their own isolated checkout
  `workspace/support/<profileId>/<repo>` and are serialized per profile
  `:1275-1290` (DIFFERENT profiles still run concurrently).

### 4.8 Comments and narration (ruling 104)

`tasks/comment-guardrails.server.ts` shrank: `enforceOperatorBrevity` and
`OPERATOR_BREVITY_MAX_CHARS` are **gone**, and `CommentTrim :73` narrowed to the
single value `"evidence-separation"`. What survives:
`isMeaninglessComment :33` (the `meaningful-comment` guardrail),
`separateEvidence :48` (long fenced dumps → a trimmed block + a note),
`applyCommentGuardrails :100`, `commentOutcomeMessage :135`,
`guardrailOn :158`, `guardrailValue :175`.

`writeOperatorComment` (`tasks/operator-actions.server.ts`, guardrail call
`:647`) therefore stores the operator's narration **verbatim**; length is handled
view-side by `CollapsibleComment`, exactly as for agent replies. Brevity survives
as the style instruction on the operator's `post_comment` tool. The
regression lock lives at the WRITE PATH (`operatorPostComment :1894`), not just
the pure helper.

Two review-round consequences worth knowing:
- **B-FD8b** — the @mention fan-out scans the **PRE-trim** text: the operator
  path passes the caller's original `text` `:718-724` (comment at `:715-717`),
  and the agent-reply paths thread `mentionSourceText` through `PreparedReply`
  (`task-actions.server.ts:1808`, set `:1937`, used `:2109`, `:2701`, `:2970`).
  A handle inside a fenced block that evidence-separation cut away still notifies.
- **`withAmbiguityDisclosure`** (`tasks/mention-notify.server.ts:195`) now
  **balances an unclosed ``` fence** before appending the S5-G3 ambiguity note
  `:204-207` — the one job the deleted brevity truncation did that had to survive
  it; the append site is the only tail-adder.
  Siblings: `resolveMentionTargets :92`, `ambiguousMentionNote :135`,
  `ambiguousMentionHandles :160`, `mentionNotifiesUser :175`,
  `fanOutMentions :244` (ambiguity is judged over ALL enabled users, **before**
  the author exclusion `:240-243`), `notifyMentionedUsers :277`,
  `mentionedUserIdsOf :286`.

`AGENT_QUESTION_PACKET_KIND = "Agent question"`
(`tasks/agent-outcome.server.ts:434`, used `:463`) — C9: `TaskPacket.kind` is
free display text, but THIS value is load-bearing (packet resolution routes the
human's answer back to the asking agent only when the kind matches exactly), and
it used to be an untyped literal duplicated at the writer and the reader.

---

## 5. Gotchas — the sharp edges

1. **One process per data root, ever.** Never run a host dev server against
   `docker-data` while the container is up. The lock refuses the second boot
   (`data-root-lock.server.ts:458`), but a *different hostname* also refuses a
   genuinely dead holder — that is deliberate (`classifyLock :318`). Clear it
   with `VIBERR_FORCE_DATA_ROOT_LOCK=1` or by deleting `state/writer.lock`.
   Never wipe `<dataRoot>/state` while a process is running: the guard will
   `process.exit(1)` (`:584`).

2. **Migrations are squashed and forward-only.** Editing
   `db/migrations/0001_baseline.sql` reaches FRESH databases only
   (`:10-19`). Adding a column or widening a CHECK requires a re-baseline
   (`npm run seed -- --reset`), which regenerates user ids and destroys sealed
   PATs / audit / notifications. Boot warns about both drift shapes
   (`boot.server.ts:160,198`). When you widen `VALIDATION_VALUES`, widen the
   CHECK at `0001_baseline.sql:102-103` in the same commit
   (`projection-validation-check.test.ts` pins them).

3. **Tolerant parse ≠ tolerant write.** Reads never throw and never drop an
   entity; writes REFUSE on any `hardStop`
   (`task-writer.server.ts:144`, `ERROR_CODES.FILE_NOT_TRUSTED`). The reverse
   asymmetry also exists: `splitFrontmatter`'s CRLF normalization matters
   because the write guard only refuses WRITES — the READ/projection path
   happily projects a broken file.

4. **Whole-array vs per-row parsing.** Any list whose loss would PERSIST must go
   through `tolerantRows` / `tolerantArray` / `tolerantRowsOf`. The failure mode
   is silent: one bad row empties the list, the diagnostic is only a warning so
   the file stays writable, and the next write serializes the empty list over the
   good rows (`task-file.schema.ts:1064-1073`). **Packet `options` were fixed in
   C5; packet `observations` were not (see Findings).** This is a recurring bug
   class in this repo — grep every sibling when you fix one.

5. **`validation` in the file is a CACHE, not truth.** Always call
   `deriveValidation(fm)`. The projection does (`rebuilder.server.ts:443`).

6. **Projection columns that intentionally diverge from the file.**
   `waiting` is forced to `none` in the terminal stage (`:481`);
   `repo` is always the project's (`:598`);
   `validation_block_reason` omits three gates by design (`:303-338`).
   Do not "fix" these to match the file.

7. **Boot re-baseline vs boot rescan.** The rescan (`boot.server.ts:619`) only
   reconciles PROJECTION rows from files. It cannot recover users, sessions,
   PATs, audit or notifications. Run `npm run backup` before deleting
   `projection.sqlite` — but note the backup does **not** carry
   `audit-exports/` (Findings).

8. **The reclaim/recovery ordering at boot is load-bearing.** Do not move the
   workspace reclaim earlier: recovered completions LAUNCH runs that clone
   exactly the paths the reclaim `rmSync`s, so the chain joins `orphanReinvokes`
   AND re-asks `activeRunCount(db) > 0` (`boot.server.ts:446-468`).

9. **Watcher blind spots.** `ignoreInitial: true` means an external edit landing
   inside the sub-second initial scan window is picked up only on its next touch
   or a manual rescan. Anything deeper than `<slug>/tasks/<KEY>/task.md` is
   ignored outright (`file-watch.service.server.ts:110-111`) — `workspace/` and
   `attachments/` are invisible to it, on purpose. A `projects` row deletion does
   NOT cascade task rows, so the directory reconcile prunes them explicitly
   (`:196-205`).

10. **Read-your-own-writes on VirtioFS.** The task and project writers keep an
    in-process `lastWritten` cache and prefer it when the disk read disagrees and
    mtime has not advanced past `wroteAtMs + 100`
    (`task-writer.server.ts:91`, `project-writer.server.ts:75`). **The goal
    writer does not have this** (Findings).

11. **`agent_runs.kind` is a delivery axis, not a role.** `reviewer` means "does
    not deliver" — a non-delivering *developer* is stored as `reviewer`
    (`0001_baseline.sql:460-473`). Every query that means "reviews" must read
    `role` / `verdictCapable`, not `kind`.

12. **`capabilities: []` is not "no powers."** An unspecified capability is
    GRANTED unless it is in `GRANT_REQUIRED_CAPABILITY_IDS`
    (`capabilities.ts:403`). Every creation path must persist EXPLICIT grants
    (`defaultGrantsFor :165` / `conservativeGrantsFor :192`).

13. **KB grants resolve by DIRECTORY, not display name.** A wrong `kb:` entry
    degrades to a `logger.warn` and an empty body while the UI still shows the KB
    attached (`docs/architecture/file-formats.md:435-442`).

14. **The seeded operator's grants are spelled as catalog LABELS** and resolved
    via `capabilityByLabel` (`seed/agent-catalog.server.ts:30`). A label edited in
    `UNIFIED_CAP_CATALOG` does not error — the grant silently degrades to a
    display-only `extra`.

15. **Timeline body escaping is a security boundary, not formatting.** An
    unescaped `## Timeline` in a goal or comment forges the history the
    acceptance decision reads (`task-file.server.ts:90-103`). External appenders
    MUST apply the same escape.

16. **Duplicate `## Goal`/`## Packet`/`## Timeline`: FIRST wins**
    (`task-file.server.ts:474-487`).

17. **`operatorAuthorized` must never come from a request.** Same for
    `recommendationAuthorized` and `rework` on `transitionStage`
    (`task-mutation.server.ts:54`, `task-actions.server.ts:4336-4356`).

18. **Acceptance requires the echo.** Any new door to Done must thread `ack`
    and go through `acceptCompletion`; a bare POST is refused with
    `accept_disclosure_missing` (`acceptance-disclosure.ts:8-31`). And any new
    writer that lands `stage = done` must call `closedPrBlockedReason` **and**
    clear `heldAtStage` — today only `transitionStage :4539` and
    `applyAcceptanceWrite :7879` write `frontmatter.stage`, and both do.

19. **In-lock re-checks, not pre-checks.** The idempotence/state checks outside
    the file lock are FAST PATHS. `transitionStage :4518`, `resolvePacket`'s
    packet-identity re-check `:6513`, `withdrawSupersededDeliveryPacket :2506`,
    and `recordDeliveredNextStep` all re-run the decision inside the lock.

20. **Dynamic `await import()` inside this module graph is dangerous.** It hides
    real cycles and can resolve to a half-evaluated namespace at runtime
    (`task-mutation.server.ts:16-42`). Put shared leaf helpers in
    `task-mutation.server.ts`, not `task-actions.server.ts`.

21. **`rebuildPath` swallows every throw** into `{action:"error"}` +
    "projection rebuild failed" (`rebuilder.server.ts:958`). A row that silently
    stops updating almost always means a schema/CHECK problem — check the boot
    integrity WARN and `provenance` rows with `action = 'error'`.

22. **`npm run rescan` counts THROWS, not untrusted files.** A malformed file
    never throws, so it reports `0 errors`. Use `npm run store:check`
    (`files/store-check.server.ts:202` `checkStore`) or
    `untrustedFileReport(db) :329`. Recovery is `npm run restore -- --file <path>
    --from <artefact>`.

23. **Never put a secret in `instance_settings`.** Sealed secrets need their own
    column so key rotation can reseal them (`0001_baseline.sql:271-282`,
    `SEALED_STORES`). The store's accessors are now EXPORTED
    (`settings/instance-settings.server.ts:35 getSetting`, `:56 setSetting`,
    `:72 deleteSetting`) and `InstanceSettingValue :21` is recursive — so a knob
    can be a record (backend-quota's readings), but never a secret.

24. **`verification` looks dead — keep it.** better-auth writes it on every
    OAuth sign-in (`0001_baseline.sql:540-550`).

25. **Stage ids are never literals.** Use `resolveStageRoles` /
    `isTerminalStage` (`app/shared/workflow/stage-roles.ts`).

26. **`readdirSync(withFileTypes)`, never `statSync`, when listing store
    folders** (`org/resources.server.ts:103-114`). Every store reader also needs
    the two-layer containment check (`org/store-files.server.ts:162`): lexical
    `path.relative` **plus** `realpathSync`.

27. **Injection budgets are shared across the whole grant list, not per item**
    (24 000 chars each), and headings are charged against them
    (`files/skill-body.server.ts:36`, `files/kb-injection.server.ts:64,222`).

28. **`org_knowledge_bases.refresh` CHECK still permits `'nightly'`**
    (`0001_baseline.sql:358`) though the product removed it. A hand-written
    `'nightly'` row passes the DB and is silently coerced to `"on change"`
    (`org/resources.server.ts:215`).

29. **Grant slugs are asymmetric.** KBs are referenced by `dir` (the slugified
    name); MCPs and skills by `name`. `org/org-view.server.ts:191,196` and
    `org/resource-catalog.server.ts:31,51-57` both depend on it.

30. **`PRIOR_SHIPPED_HASHES` needs manual maintenance.** Editing any file under
    `app/server/seed/assets/` without appending the outgoing hash
    (`seed/default-assets.server.ts:175-184`) strands pre-manifest stores on the
    old version forever.

31. **Never inherit `process.env` into a spawned MCP child.** Use
    `filteredSpawnEnv()` (`org/resources.server.ts:911`). Spawn `detached` and
    kill by process group (`killProcessTree :945`).

32. **The redactor has no length floor.** `redactGitOutput` scrubs by VALUE
    first (`secrets/git-output-redact.server.ts:87-95`). Clamp from the END.

33. **Health probes must not write** (`secrets/pat-validator.server.ts:48-62`);
    the write probe is opt-in behind `VIBERR_GITHUB_WRITE_PROBE :98`. A 5xx is
    `network_error`. A write scope's violation clears only on `header`/`probe`
    evidence `:677-685`.

34. **Attachment serving is whitelist-only.** `INLINE_TYPES`
    (`files/task-attachments.server.ts:223`) excludes HTML/SVG/JS on purpose; the
    ruling-105 additions (`yml`/`yaml`/`csv`) are served as **`text/plain`**, not
    as their real media types, so the viewer can read them without the origin
    ever rendering them. A traversal in the name must 404, never 403.

35. **404, not 403, for project visibility** (`auth/require-project.server.ts:81`,
    F19-28). The action-side twin `requireVisibleProject` must be called
    **outside** the try block (`routes/project.task.tsx:420`,
    `routes/project.board.tsx:53`).

36. **CSRF fails closed on a request with no origin signals at all**
    (`auth/csrf.server.ts:96`). Fetcher routes must use `csrfError(...)`, not the
    thrown `Response` (UI-32).

37. **Only a `valid` verdict is ever cached or reused.** Connection freshness
    (`org/connections.server.ts:235,280`) and PAT revalidation
    (`pat-validator.server.ts:543,645`) both refuse to reuse a failing or
    `network_error` result, and cache reuse additionally requires the **same
    repo**.

38. **The single-flight helper is a cooldown, not a mutex**
    (`projections/single-flight.server.ts:10-16`), and it stamps the timestamp
    **before** the work runs so a throw still holds the cooldown. Never wrap a
    correctness-critical rebuild in it.

39. **`rebuildProjections` must emit only after commit** — it DELETEs the four
    derived tables and re-projects inside one transaction, wrapped in
    `collectProjectionEvents`, re-emitting afterwards
    (`projections/rebuild.server.ts:52-53`).

40. **SSE authorization is re-resolved on every heartbeat.**
    `applyReauthorization` (`events/sse-broker.server.ts:233`) runs each 25 s
    tick; returning `[]` drops the connection, and a THROW keeps the existing
    scopes `:239-247`.

41. **NEW — a reserved MCP name must be refused at the RESOLVER, not only at the
    writer.** `~/shared/mcp-reserved.ts` is the one list; org servers mount LAST,
    so a row that reached the registry any other way would replace an in-process
    server under its own key (`app/shared/mcp-reserved.ts:20-27`).

42. **NEW — the controller's grant/instruction sections are locked by default.**
    `saveControllerConfig` is the chokepoint (`controller-profile.server.ts:215`);
    a locked section writes the STORED list **verbatim** (byte-stable) and blank
    means keep, so only a non-empty different SET is refused. Any new controller
    config door must go through this function, not around it. Model and effort
    stay editable; `viberr_ops` is not a section.

43. **NEW — the audit purge fails CLOSED on export failure.** If
    `exportExpiringAuditEvents` cannot write, `applyRetention` skips the DELETE
    for that pass and reports `auditEvents: 0`
    (`db/retention.server.ts:213-220`). A "0 purged" reading is therefore not
    proof there was nothing to purge — check the
    `audit purge skipped: expiring rows could not be exported` WARN.

44. **NEW — `read_run_log`'s forward mode is bounded tool-side, not in SQL.**
    `getRunLog` ignores `limit` when `since` is given, by design
    (`controller-ops-mcp.server.ts:252-259`). If the unbounded `listRunLines`
    SELECT ever becomes a problem, push a LIMIT down — do not grow the reply.

---

## Findings for the pass-32 ledger

**A1 — Packet `observations` is still a whole-array tolerant-parse sibling
(the exact C5 class C5 fixed for `options`).**
Where: `app/schemas/task-file.schema.ts:478` (`packetObservationSchema` requires
`k: z.string(), v: z.string()`), consumed by `taskPacketSchema.observations`
`:524`; parse site `app/server/files/task-file.server.ts:405-425`.
Why it matters: the C5 fix at `:378-403` repairs only `options` before handing
`raw` to `taskPacketSchema`. One malformed observation row (e.g. a hand-edited
`v: 9`, which YAML parses as a number) fails the whole-object parse, the code
falls to `:419-425` and emits `packet.invalid` — a **`diagError`, not a
hardStop**, so the write guard still permits writes — and returns `null`. The
task then reads `waiting: human` with no card to answer, and the next
`updateTaskFile` drops the section entirely, because `serializeTaskFile` writes
`## Packet` only `if (parsed.packet)` (`task-file.server.ts:578`). That is the
identical durable-loss shape the C5 comment describes. Confidence: **high**
(mechanism verified by reading; the triggering value is a hand edit or a future
writer, so live likelihood is medium).

**A2 — `goal-writer.server.ts` has no stale-read repair, and goal files are a
third canonical kind.**
Where: `app/server/files/goal-writer.server.ts:265` (`updateGoalFile`) — no
`lastWritten` map, no `rememberWrite`, no mtime slack; compare
`app/server/files/task-writer.server.ts:69-91` and
`app/server/files/project-writer.server.ts:63-90`.
Why it matters: pass 31's gotcha 10 predicted exactly this ("If you add a third
canonical file kind with its own writer, it needs this too"). On VirtioFS a read
milliseconds after this process's own rename can return the PREVIOUS content;
`withGoalsLock` serializes writers but does not make the read fresh. Two
back-to-back link-status writes from the goal runner could therefore apply the
second mutation to a stale base and lose the first — the VIB-1 2026-07-17 shape.
Confidence: **medium** (the gap is certain; whether the goal write cadence is
tight enough to hit the 100 ms window in practice is not proven).

**A3 — `audit-exports/` is outside the backup set, so ruling 102's durable
record is not carried by `npm run backup`.**
Where: written at `app/server/db/retention.server.ts:104-110,180`;
`BACKED_UP_STORE_DIRS = ["projects","agents","kb","skills"]`
(`app/server/db/backup.server.ts:74`), `OPTIONAL_STORE_DIRS = ["runtimes"]`
`:82`.
Why it matters: ruling 102's whole point is that the purge "must leave a durable
record of what it removed". The record lives under the data root but in a
directory no backup artefact copies, so the standard recovery drill
(`npm run backup` → wipe → restore) silently discards it. Confidence: **high**.

**A4 — `audit-exports/` and `agents/definitions/` are undocumented in the
data-root layout that calls itself complete.**
Where: `docs/architecture/file-formats.md:24-33` ("That is the complete set
`DATA_ROOT_SUBDIRS` creates. There is no `cache/`, `auth/` or `logs/`
directory…"); `DATA_ROOT_SUBDIRS` at
`app/server/files/file-store-root.server.ts:26-41`.
Why it matters: both directories exist on every real deployment (definitions are
seeded by `seedDefaultAgentAssets`; audit-exports appears at the first purge).
The sentence is literally true about `DATA_ROOT_SUBDIRS` but reads as an
inventory of the data root, so an operator auditing the store will not know
either folder exists — one holds the controller's doctrine, the other holds
deleted audit rows. Confidence: **high** (doc-vs-reality drift).

**A5 — `effort` is a schema-level agent-profile key but is missing from the
`file-formats.md` profile block.**
Where: `app/server/files/agent-profile-file.server.ts:51` and
`AGENT_PROFILE_KNOWN_KEYS :99`; doc block
`docs/architecture/file-formats.md:407-430` lists `model`, `scope`, `stages`,
`spanAll`, `capabilities`, `extras`, `resources` but no `effort`.
Why it matters: `file-formats.md` is the canonical contract for hand-editable
files, and only `PACKET_OPTION_KINDS` has a drift lock
(`app/shared/docs/file-formats-sync.test.ts`). A hand-editor following the doc
will not know the key exists, and a future pass reading the doc could delete it
as drift. Confidence: **high**.

**A6 — Five environment variables are still read straight off `process.env`,
undeclared in the env schema and (mostly) absent from `.env.example`, after the
C3 commit claimed to close the env-schema gaps.**
Where: `VIBERR_MAINTENANCE_INTERVAL_MS` and `VIBERR_DISK_CHECK_INTERVAL_MS`
(`app/server/ops/maintenance.server.ts:263,268`);
`VIBERR_DISK_LOW_FREE_MB` and `VIBERR_DISK_CRITICAL_FREE_MB`
(`app/server/ops/disk-space.server.ts:65,78-81`);
`VIBERR_GITHUB_WRITE_PROBE` (`app/server/secrets/pat-validator.server.ts:98`).
Schema at `app/server/config/env.server.ts:16-183`; `.env.example` has none of
the five. `VIBERR_BROWSER_EXECUTABLE` is declared (`env.server.ts:96`) but not in
`.env.example`.
Why it matters: C3's own comment (`env.server.ts:157-159`) says the schema and
`.env.example` are "the two places an operator looks for 'what can I
configure'". Three keys were added; five equivalent ones were left behind, so
the stated invariant is still false. (`VIBERR_SECRET_ENCRYPTION_KEY_PREVIOUS` is
a deliberate exception — documented at `secrets/secret-box.server.ts:55`.)
Confidence: **high**.

**A7 — Free-disk arithmetic is wrong on virtiofs: `bavail`/`blocks` are counted
in `frsize` units, not `bsize`.**
Where: `app/server/ops/disk-space.server.ts:109-111` — `blockSize =
Number(stats.bsize)` is applied to both `stats.blocks` and `stats.bavail`.
Why it matters: live-observed this pass (already logged as F32-1 in
`planning/discovery-2026-09-01-pass32/NOTES.md`): `df -h /data` inside the
container reports 3.7 G available, while the org-settings card says "1004.2 GB
free of 62747.4 GB" and `viberr_ops instance_health` told the owner "~1.07 TiB
free out of ~57 TiB". The ratio (~274) is virtiofs `bsize` (~1 MiB) over `frsize`
(4 KiB). Consequences reach three surfaces that all read one derivation:
`classifyFreeBytes` never fires `low`/`critical`, so `checkDiskPressure`
(`ops/maintenance.server.ts:328`) never reclaims under pressure; the health
snapshot's `degraded` list never names `disk`; and the controller states the
wrong number as fact. Node's `statfsSync` does not expose `frsize`, so the fix
needs another source (`df -B1 --output=…`, or a native statvfs). Confidence:
**high** (measured live).

**A8 — `mapTaskProjectionRow` reads `unownedPr` out of a whole-value-tolerant
`github` cache, so one malformed commit row erases the collision record.**
Where: `github` is parsed with the whole-value `tolerant(...)`
(`app/schemas/task-file.schema.ts:1412`) against `githubCacheSchema :456`, whose
`commits` is `z.array({sha, msg})` `:458`. `unownedPr :473` lives in the same
object.
Why it matters: `commits`/`changed` are rebuildable from the next GitHub poll,
but `unownedPr` is a **decision record** (R15-15) that
`resolve_remote_collision` reads to know which PR to close
(`github/github-reconciler.server.ts:1592`). A single bad commit row nulls the
whole cache — including the PR number — and the next write persists the null, so
the remedy silently degrades to "delete the branch, close nothing". A per-row
`commits` parse (or hoisting `unownedPr` out of the cache) would close it.
Confidence: **medium** (mechanism certain; requires a malformed `commits` row,
which today only a hand edit produces).

**A9 — `resolveControllerConfig` treats the literal string
`"orchestration runtime"` as "no model".**
Where: `app/server/controller/controller-profile.server.ts:176`.
Why it matters: an undocumented magic string with no named constant and no test
reference in the module. An admin who legitimately types that value into the
model field gets it silently discarded; a future refactor of the seeded profile
that changes the placeholder leaves this branch dead. Confidence: **medium**
(clearly intentional legacy handling, but unlabelled and unlocked).

**A10 — `saveControllerConfig`'s `effort` handling destroys a junk value on the
next save, contradicting the "unknown keys round-trip verbatim" posture.**
Where: `agentProfileFrontmatterSchema.effort` is
`.optional().catch(undefined)` (`app/server/files/agent-profile-file.server.ts:51`),
so `effort: 3` parses as absent; `saveControllerConfig` then `delete`s the key
when the input effort is blank
(`app/server/controller/controller-profile.server.ts:272-274`) and rewrites the
file. Why it matters: the tolerant read is deliberate and documented (review D2),
but the tolerant-read/destructive-write pair means a hand-edited value is
silently erased with no diagnostic — `effort` is a KNOWN key, so the
unknown-key preservation in `serializeFrontmatterFile:99` does not cover it.
This is the mild version of the Gap-22 asymmetry. Confidence: **low/medium**
(arguably the intended repair behaviour; flagged because nothing tells the admin
their value was dropped).

**A11 — `agents/definitions/` paths are built with a `..` segment rather than a
first-class path helper.**
Where: `app/server/controller/controller-profile.server.ts:129-136` —
`path.join(agentProfilesDir(dataRoot), "..", "definitions", `${id}.md`)`.
Why it matters: `file-store-root.server.ts` owns every other store path and
carries the traversal guard; this one reaches out of `agents/profiles/` by string
and is invisible to `DATA_ROOT_SUBDIRS`, `store-check`, the backup dir list, and
anyone grepping for path helpers. The id is a module constant today so there is
no traversal risk, but a `definitionsDir()`/`agentDefinitionFilePath()` helper
belongs beside its siblings. Confidence: **medium** (hygiene, not a live bug).

**A12 — Raw `DELETE FROM notifications` in a feature module bypasses the owning
store.**
Where: `app/features/project-settings/settings-actions.server.ts:1027`
(project deletion), versus the owner
`app/server/projections/notifications.server.ts`.
Why it matters: it is documented and deliberate (F2 — orphaned "waiting on you"
rows dead-ended on a 404), and the surrounding `rebuildAll` does emit
`project.removed`, so clients revalidate. But it is the one write to that table
outside its module, it emits no `notification.read`/removal event of its own, and
a later change to the notifications store (a soft-delete column, an SSE contract)
will not be applied here. Confidence: **low** (works today; a maintenance
liability).

**A13 — `docs/architecture/file-formats.md` says the packet block "mirrors"
`PACKET_OPTION_KINDS`, and the count lock covers only that one list.**
Where: `app/shared/docs/file-formats-sync.test.ts:83-131` locks the kind list and
its numeral; nothing locks the task-frontmatter key list
(`TASK_FRONTMATTER_KEYS`, `app/schemas/task-file.schema.ts:968`) against the
`task.md` block at `docs/architecture/file-formats.md:130-207`, nor the
agent-profile key list.
Why it matters: `heldAtStage` was added to the doc by hand this pass and `effort`
was not (A5) — which is exactly the outcome an unlocked mirror produces. The
lock's own docblock claims the doc "mirrors" the schema, which a reader will
generalize beyond the one list it actually checks. Confidence: **medium**
(process/doc drift, not a runtime bug).
