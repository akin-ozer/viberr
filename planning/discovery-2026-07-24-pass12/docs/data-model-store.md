# Viberr data model, projections & events (pass 12, 2026-07-24)

Audience: implementation subagents with **zero** other context. Everything here was
re-verified against main @ 0981cfa (post-PR #87 pass-11 fixes + PR #90 clean-sheet
seed) on 2026-07-24. File:line references are to that state. Supersedes
`planning/discovery-2026-07-23-pass11/docs/data-model-store.md`.

**Core principle**: Viberr is a *file-native* store. Markdown files under
`${VIBERR_DATA_ROOT}` — `projects/<slug>/project.md` and
`projects/<slug>/tasks/<KEY>/task.md` — are the ONLY canonical business truth for
projects and tasks. SQLite (`state/projection.sqlite`) is a **derived projection**
that can be dropped and rebuilt from disk at any time. Humans and agents may edit
the files directly; a watcher + rescans reconcile them into SQLite. App-owned data
(users, sessions, notifications, audit, PATs, agent runs, org resources) lives only
in SQLite and is *not* file-derived.

Prior canonical format doc: `docs/architecture/file-formats.md` (275 lines, still
accurate on formats; this doc adds the projection/event/env/seed layers on top).

---

## 1. Env config (`app/server/config/env.server.ts`)

`getEnv()` (:167-175) parses `process.env` exactly once per process (zod, cached
under `Symbol.for("viberr.env")`, HMR-safe; `loadEnvFile()` at :4-8 reads `.env`
first, tolerating ENOENT). Empty-string values are treated as unset (:148-158).
A bad config throws one multi-line message listing every problem.
`resetEnvCacheForTests()` (:178) clears the cache.

Validated variables (`envSchema`, env.server.ts:12-127):

| Var | Required | Effect |
|---|---|---|
| `NODE_ENV` | no (default `development`) | mode; `test` disables SSE signal handlers (sse-broker.server.ts:146) |
| `PORT` | no (default 5173) | HTTP port |
| `VIBERR_SESSION_SECRET` | **yes**, ≥32 chars | signs the session cookie |
| `BETTER_AUTH_SECRET` | no (defaults to session secret) | better-auth cookie signing, rotate independently |
| `BETTER_AUTH_URL` | no (required behind a reverse proxy) | absolute public origin for OAuth callbacks/cookies |
| `VIBERR_SECRET_ENCRYPTION_KEY` | **yes**, base64 of exactly 32 bytes | AES-256-GCM key for stored secrets (GitHub PATs); parsed into a `Buffer` (:50-73) |
| `VIBERR_DATA_ROOT` | no (default `./data`) | root of the file-native store + SQLite + run logs |
| `GITHUB_OAUTH_CLIENT_ID/SECRET`, `GOOGLE_OAUTH_CLIENT_ID/SECRET` | no | OAuth login buttons stay disabled when unset |
| `VIBERR_SEED_ADMIN_EMAIL` / `VIBERR_SEED_ADMIN_PASSWORD` | no | bootstrap-admin credentials, consumed by boot AND `npm run seed` (§8) |
| `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `VIBERR_CLAUDE_USE_CLI_AUTH` | no | Claude backend availability (presence check only — never a paid probe) |
| `CLAUDE_CONFIG_DIR` | no | Claude Agent SDK session dir; point under the data volume so resumed sessions survive restarts (compose uses `runtimes/claude-home`) |
| `CODEX_ACCESS_TOKEN`, `CODEX_API_KEY`, `OPENAI_API_KEY`, `VIBERR_CODEX_USE_CLI_AUTH` | no | Codex backend availability |
| `CODEX_HOME` | no | Codex `codex login` auth dir (compose: `runtimes/codex-home`) |
| `VIBERR_CLAUDE_MAX_TURNS` | no (default 2000) | Claude runaway turn cap — **now in the schema** (:125), consumed via `getEnv()` at claude-runtime.server.ts:273 |
| `VIBERR_CODEX_IDLE_TIMEOUT_MS` | no (default 15 min) | Codex idle-hang window — **now in the schema** (:126), consumed at codex-runtime.server.ts:174 |

**Env vars still read OUTSIDE the schema** (raw `process.env` — a deliberate,
much-reduced residue):

- `VIBERR_GIT_ASKPASS_USERNAME` / `VIBERR_GIT_ASKPASS_PASSWORD` — internal
  handshake for the git-clone askpass helper
  (**app/server/tasks/**git-clone-auth.server.ts:5-6); set by the app for child
  git processes, not user config.
- `LOG_LEVEL` — logger threshold (logger.server.ts:15); default `info` in prod,
  `debug` otherwise. The logger must stay dependency-free, so it cannot import
  env.server.
- `VIBERR_CLAUDE_TEST_MARKER` / `VIBERR_CODEX_TEST_MARKER` — test-only hooks
  (runtime-registry.server.test.ts).

### Data-root layout

Created at boot by `ensureDataRootDirs()` (file-store-root.server.ts:44-51;
`DATA_ROOT_SUBDIRS` :23-37):

```
${VIBERR_DATA_ROOT}/
  projects/<slug>/project.md              ← project truth (canonical)
  projects/<slug>/tasks/<KEY>/task.md     ← task truth (canonical)
  projects/<slug>/tasks/<KEY>/workspace/  ← agent working clone (NOT projected/watched)
  agents/profiles/<id>.md                 ← org-level agent profile templates
  runtimes/<backend>/<sessionOrRunId>.jsonl ← raw NDJSON run logs (canonical run truth,
                                              run-store.server.ts:8-11)
  runtimes/claude-home/  runtimes/codex-home/ ← backend auth/session homes (compose mounts;
                                              NEVER wiped by seed --reset, P11-04)
  kb/<dir>/                               ← knowledge-base folders (store://kb/<dir>/)
  skills/<name>/SKILL.md                  ← skill folders (store://skills/<name>/)
  state/projection.sqlite                 ← SQLite projection DB (+ WAL files)
```

The pass-11 `cache/ auth/ logs/` created-but-unused dirs are GONE (removed from
`DATA_ROOT_SUBDIRS`; pass-11 gap #6 closed). Nothing writes file logs — the
logger is stdout-only.

Path helpers + traversal containment: `resolveStoreSegment()`
(file-store-root.server.ts:100-119) rejects any kb/skill name with separators,
dot-segments, absolute paths or NUL — bad references are DENIED loudly, never
resolved outside the root. `storeRelativePath()` (:146-149) renders the
UI-visible `projects/<slug>/tasks/<KEY>/task.md` form.

### Boot sequence (`app/server/boot.server.ts:75-203`)

1. `getEnv()` (:79) → fail fast; `ensureDataRootDirs()` (:94);
   `seedDefaultAgentAssets()` (:99).
2. `getDb()` (:100) — opens `state/projection.sqlite` (WAL, FK on, busy_timeout
   5000 — sqlite.server.ts:15-17), applies `db/migrations/*.sql` in filename
   order, each inside its own transaction, recorded in `schema_migrations`
   (migration-runner.server.ts). **Skips by filename only** — and while
   pre-prod there is deliberately only ONE file, `0001_baseline.sql` (§4.2).
3. `seedInitialAdmin` (:102, empty users table only — §8).
4. `startEventPublisher()` (:109) — projection emitter → SSE broker bridge.
5. Boot rescan `rescanProjections(db)` (:116) — converges projections with
   offline edits (hash short-circuited; failure never blocks boot).
6. `ensureBaseAgentsDeployed` (:133) — operator/developer/reviewer into every project.
7. `startFileWatcher()` (:142) — dev AND prod.
8. `startKbWatcher()` (:146) — **NEW** (R-D/P11-60): re-indexes a knowledge base
   when its `kb/<dir>` files change (§3.4).
9. `finalizeOrphanedRuns` (:153, running/queued runs with no live process →
   `error`), `applyRetention` (:164, §7.4), `recoverUnreactedAgentRuns` (:176,
   fire-and-forget), `startScheduleRunner` (:186, O-3, 60 s tick —
   schedule.server.ts:36).
10. `startGithubReconcilePoller(db)` (:191) — **NEW** (P11-14): reconciles every
    active branched project at boot then every 5 min, so out-of-band PR
    merges/closes surface without the manual "Update status" click. HMR-safe
    singleton behind `Symbol.for` (reconcile-poller.server.ts:75); the boot poll
    sits inside the idempotence guard (63cfe53).
11. Boot integrity log. All idempotent, cached under `Symbol.for("viberr.booted")` (:28).

---

## 2. File formats

Shared rules (frontmatter.server.ts):

- Frontmatter = YAML between `---` fences on their own lines; body after
  (`splitFrontmatter` :24). BOM tolerated. Missing/unterminated fence or bad
  YAML → `frontmatter.missing` / `frontmatter.unterminated` /
  `frontmatter.invalid_yaml` **error + hardStop** diagnostics and an empty
  mapping — parsing never throws.
- Serialization: `YAML.stringify(value, { lineWidth: 0 })` (no folding, stable
  round-trips). `serializeFrontmatterFile()` (:87-99) writes known keys in
  canonical order, then unknown keys **that don't collide with known keys**
  (known wins), then the body; file always ends with a single trailing newline.
- **Unknown frontmatter fields and unknown `## Sections` survive every write**
  (round-trip safety for foreign/future fields).
- Timestamps: UTC ISO 8601 strings.

### 2.1 `projects/<slug>/project.md` (`app/schemas/project-file.schema.ts`)

Frontmatter = all governed project state (`projectFrontmatterSchema` :168-223).
Body = markdown project description. Annotated example (real shape):

```markdown
---
name: viberr                     # display name; falls back to slug
slug: viberr                     # /^[a-z0-9][a-z0-9-]*$/; DIRECTORY NAME WINS on mismatch
archived: false                  # archived → hidden + read-only (only archived files carry the key;
                                 # tolerant parse fills false)
repo: akin-ozer/viberr           # project default GitHub repo ("owner/name") or null; tasks may override
defaultBranch: main
taskPrefix: VIB                  # /^[A-Za-z]+$/ → task keys VIB-142; fallback derived from slug letters
nextTaskNumber: 37               # atomic per-project key counter (null → rescan of task dirs)
stages:                          # ordered board columns; EMPTY LIST = project.no_stages error
  - id: triage
    name: Triage
    color: "#a5a8b5"             # hex or var(--*) both accepted; default var(--muted)
  # … ready / impl / review / done
workflow:                        # governed transition boundaries: auto | approval | human
  - from: impl
    to: review
    boundary: approval
    by: Operator transition request, with evidence attached   # display copy only
    locked: false
  - from: review
    to: done
    boundary: human              # review→done is locked `human` in V1 (server-enforced)
    locked: true
members:                         # the 4-role project RBAC (admin|maintainer|contributor|viewer)
  - userId: u_TuOTt9q3UvMB       # org-user id (users table)
    role: admin
agents:                          # per-project DEPLOYMENTS of org profile templates
  - profileId: operator          # joins agents/profiles/<id>.md; PROFILE ID IS IDENTITY
    capabilities:                # id-based policy into CAP_CATALOG (app/shared/capabilities.ts)
      - capabilityId: assign-primary-specialist
        mode: direct             # direct | recommend | human | off
      - capabilityId: execute-code-or-write-repo
        mode: human
    extras: []                   # bespoke labels without a catalog id (kept, mode-bearing)
    # definition:                # optional loose per-field override; project-created profiles
    #   kind: specialist         # carry their FULL definition here
credentialPolicy: null           # non-secret credential requirements; the PAT itself lives
                                 # AES-encrypted in SQLite
guardrails:                      # anti-noise guardrails; ENFORCED by
  - id: writer-loop              # app/server/tasks/comment-guardrails.server.ts
    desc: …
    on: true
---

Project description prose (markdown body).
```

Tolerant parse specifics (`parseProjectFrontmatter`, project-file.schema.ts:322-479):

- Slug: frontmatter slug vs directory name mismatch → `frontmatter.slug_mismatch`
  error, **directory wins**. No valid slug + no fallback → `unknown-project` +
  hardStop.
- List fields (stages/workflow/members/agents) parse **per-entry** (F18,
  `tolerantArray` :265-320): one malformed row drops only itself with an indexed
  diagnostic — a bad `members[1]` can no longer wipe the whole ACL.
- Scalar fields fall back individually (`tolerant` :225-263) with
  `frontmatter.missing_field` / `invalid_field` warnings.
- Unknown keys collected into `unknown` and re-serialized verbatim.
- Still **no `updatedAt` field** on project.md (schema :168-223); project change
  freshness is only observable via `projects.parsed_at`.

### 2.2 `projects/<slug>/tasks/<KEY>/task.md`

Schema: `app/schemas/task-file.schema.ts`. Parse/serialize:
`app/server/files/task-file.server.ts` (`parseTaskFileContent` :309). Layout:

```
---  frontmatter (tolerant)  ---
## Goal        prose (the task's goal — editable via updateTaskGoal)
## Packet      ONE fenced ```yaml block — the active decision packet (section absent when none)
## Timeline    typed event log, NEWEST FIRST
## <anything>  unrecognized sections preserved verbatim, in order
```

Annotated modern frontmatter:

```yaml
key: RTL-1                        # /^[A-Za-z]+-\d+$/; DIRECTORY NAME WINS on mismatch
title: "[P11-A] Claude docs author to Codex style review"
stage: done                       # board column id; missing/invalid → "" (blank marker →
                                  # orphan bucket + unresolved_stage warning; NEVER invented)
readiness: ready                  # stored value; canonical 4-enum: ready | input_required |
                                  # inconsistency_risk_detected | blocked ("accepted" is display-only)
waiting: none                     # human | agent | none
ownerUserId: null                 # human owner (users.id) or null
engagements:                      # G1 uniform agent list (replaces specialist/reviewers slots)
  - profileId: p11-claude-docs-author
    backend: claude               # codex | claude
    role: Inert Markdown delivery # display SNAPSHOT taken at engage time
    delivers: true                # ≤1 delivering engagement = workspace/branch/PR owner
    verdictCapable: false         # snapshot: explicit report-validation-verdict:direct grant?
  - profileId: p11-codex-style-reviewer
    backend: codex
    role: Markdown style verdict
    delivers: false
    verdictCapable: true          # true ⇒ REQUIRED reviewer: gates acceptance (F10-15)
operator:
  assignedAtStageId: ready        # stage id captured when the operator attached
recommendations: []               # pending operator recommendation cards; each:
                                  # {id, kind: assign_specialist|assign_reviewer|transition|
                                  #  run_specialist|run_reviewer|accept_completion,
                                  #  profileId?, toStageId?, label, detail}
schedules: []                     # O-3 scheduled actions; each: {id, action: run-operator, dueAt,
                                  # backend, autonomy, note, createdBy, createdByLabel, createdAt,
                                  # status: pending|claimed|fired|failed|cancelled,
                                  # firedAt, claimedAt, retries}  (F10-16 claim/lease lifecycle)
urgent: false
validation: healthy               # DERIVED cache: healthy|changed|failing|none; recomputed via
                                  # deriveValidation() at the action sites that change
                                  # engagements/verdicts/revision (task-actions.server.ts:1478,
                                  # :2496; workspace-delivery.server.ts:378)
workRevision:                     # F10-15: immutable identity of the delivered work under review
  id: rev_93dQFMKQAPVr
  headSha: 0b84e4f4635dc52268c73c429b6872f993dff1db   # FULL commit sha
  treeSha: 326178e25a82d89cdab034fc05ed6ff6512cf376   # content identity; same tree ⇒ same revision
  branch: rtl-1
  createdAt: 2026-07-19T23:26:14.189Z
  sourceProfileId: p11-claude-docs-author
verdicts:                         # per-engagement verdicts BOUND to the revision they judged;
  - profileId: p11-codex-style-reviewer               # a new revision id makes old verdicts stale
    revisionId: rev_93dQFMKQAPVr
    headSha: 0b84e4f…
    result: approve               # approve | request_changes
    reason: |-
      APPROVE — …
    at: 2026-07-19T23:27:49.040Z
branch: rtl-1                     # delivery branch or null
repo: null                        # task-level repo override; null → project default
pr:                               # PR ref cache or null
  number: 79
  state: merged                   # review | merged | closed | accepted;
                                  # unknown strings COERCE to "review" (.catch), never drop the ref
github:                           # GitHub projection cache mirrored by the reconciler +
  commits:                        # workspace delivery — NOT human-edited truth
    - sha: 0b84e4f
      msg: "[RTL-1] Add inert Markdown audit fixture…"
  changed: { files: 1, add: 25, del: 0 }
createdAt: 2026-07-19T23:24:07.128Z
updatedAt: 2026-07-19T23:58:40.130Z   # bumped automatically by updateTaskFile
boardRank: null                   # sparse drag-to-reorder rank; null → key-number × 1_000_000
                                  # (BOARD_RANK_BASE, board-query.server.ts:28)
```

**Legacy absorption** (task-file.schema.ts:580-666): older files carry
`specialist:` / `reviewers:` (or the still-older `consultants:`) instead of
`engagements:`. They are absorbed into engagements on read (specialist →
`delivers: true`, reviewers → supporting, all `verdictCapable: false`) and NOT
preserved as unknown (:888-891 drops the legacy keys from `unknown`); the next
write emits `engagements:` only. An explicit `engagements:` key always wins.
Invariants enforced with diagnostics: profileId-unique (first occurrence kept),
≤1 deliverer (`frontmatter.multiple_deliverers`, extras demoted :655-664).

**Review-state derivation** (pure helpers, task-file.schema.ts:408-503):
`requiredReviewers` (:408) = non-delivering + verdictCapable; `currentVerdicts`
(:413) = verdicts matching `workRevision.id`; `deriveValidation` (:426) →
failing (any required request_changes) / healthy (all required approved) /
changed (revision under review) / none (no revision); `acceptanceBlockedReason`
(:450) → human-readable gate — **now also projected into
`task_projections.validation_block_reason` (P11-50)**; `nextWorkRevision`
(:475) → same treeSha (or headSha when tree unknown) = same review subject, no
invalidation — otherwise mint a new revision id (F10-32).

#### `## Packet` — the active decision packet

One fenced ` ```yaml ` block (missing fence + non-empty section →
`packet.no_yaml_block`; bad YAML → `packet.invalid_yaml`; schema-invalid →
`packet.invalid` — packet ignored, never a crash). Shape (`taskPacketSchema`
:291-312):

```yaml
type: blocked                # input | blocked
kind: Blocked decision       # pill label ("Completion report" | "Blocked decision" | …)
from: operator               # actor ref string; "operator" in every observed packet
title: Work stalled — pick a recovery path
body: "…"
observations:                # k/v fact rows; code: true renders monospace
  - k: Agent
    v: "@implementation"
    code: false
options:                     # dispatch on KIND, never on English titles (ruling 7)
  - kind: redirect           # accept_completion | request_edit | block_on_policy |
    t: Redirect with sharper guidance      # hold_runtime_debug | redirect |
    d: Re-engage the operator…             # retry_other_backend | edit_goal | custom
    rec: true                # exactly 1 recommended option expected (info diag otherwise)
    # ev: …                  # pre-authored timeline text written when chosen
    # backend/profileId      # retry_other_backend payload
# id: pk_…                   # F10-09 stable packet id — resolution re-checks it under the
                             # lock so a replacement packet can't be resolved by a stale action
# awaiting: goal_edit        # edit_goal confirmed → packet auto-clears when the goal lands
```

The stuck-loop packet is also how the **operator transition-chain cap** lands
(63cfe53): `OPERATOR_TRANSITION_CHAIN_CAP = 8` (task-actions.server.ts:103);
`transitionDepth` threads RunOperatorInput → ctx.operatorRun → transitionStage
(:83-108, :563-575). At the cap the transition still lands but coordination
pauses on the existing stuck-loop packet instead of another LLM run
(:2540-2560); any human action or agent reply restarts the chain at 0.

#### `## Timeline` — typed event log

Newest-first. Each entry (task-file.server.ts:30-58; `SEP = " · "` :57,
`### ` heading prefix):

```
### <UTC ISO> · <type> · <actor-ref>
title: Completion accepted        (optional metadata — completion events only)
to: agent                         (optional — comments routed to the operator/agent)

<text — RichText micro-format: **bold**, `code`, @mention>

evidence:                          (optional — completion events only)
- <label> · <+add> · <-del>
```

- Separator is ` · ` (space-middot-space). 9 contract types:
  `comment, completion, github, policy, quality, transition, blocked, agent,
  assign` (TIMELINE_EVENT_TYPES); unknown types are kept and rendered as plain
  comments (`timeline.unknown_type` info, :135-140).
- Malformed heading / unparseable timestamp → entry skipped with a warning.
  Content outside any `###` → `timeline.stray_content` (:225). Out-of-order
  entries tolerated with `timeline.out_of_order` info (:401; display sorts by
  timestamp).
- **Body escaping** (bijective, :47-76): free text lines that would read as
  structure (`## `, `### `, `title: `, `to: `, bare `evidence:`) are prefixed
  with one backslash on write (`escapeEventText` :67) and lose exactly one on
  read (`unescapeEventTextLine` :74) — comment text can never split sections,
  forge events, or override the real `## Packet`.
- Duplicate `## Goal`/`## Packet`/`## Timeline` sections: FIRST occurrence wins;
  the duplicate is flagged (`body.duplicate_section`) and preserved as an
  unrecognized extra section (task-file.server.ts:330-342, applied :352/:359/:366).

#### Actor refs (`app/server/files/actor-ref.server.ts`)

```
user:u_ab12cd34ef (Arda Kaya)        human — userId is identity, name is display snapshot
agent:codex/reviewer (Review & validation)   agent — PROFILE ID is identity (D7),
                                     parenthesized role snapshot for display
operator                             the coordinating operator
system:policy-engine                 system actors
```

`decodeActorRef` is **total**: an unrecognized ref becomes
`{ kind: "unknown", raw }` and re-encodes verbatim — an event is never dropped
over its author (the VIB-12 failure class). Legacy `agent:<backend>/<role-slug>`
refs decode with the slug as profileId and a null roleHint. Hints are sanitized
(no ` · `, no newline) before embedding into headings.

### 2.3 `agents/profiles/<id>.md` (org agent-profile templates)

`app/server/files/agent-profile-file.server.ts`. Frontmatter: `id`, `kind`
(operator|specialist), `name`, `role`, `desc` (short picker copy), `icon`,
`backends[]`, `model`, `scope`, `stages[]`, `spanAll`, `capabilities[]`
({capabilityId, mode}), `extras[]`, `resources{skills[], mcps[], kb[]}`. Body =
the long persona/instructions. Parsing is whole-file tolerant-ish: schema
failure → `agent_profile.invalid` warning and `parsed: null` (not per-field).
Two-layer model: templates define the base; `project.md agents:` entries deploy
by profileId and may override capabilities/definition per project. The built-in
catalog (operator/developer/reviewer) now lives as PRODUCT data in
`app/server/seed/agent-catalog.server.ts` (§8).

---

## 3. Read/write machinery

### 3.1 Writers (`app/server/files/task-writer.server.ts`, `project-writer.server.ts`)

- **Atomic writes** (`writeFileAtomic`, atomic-file.server.ts:10-15): write to a
  sibling `<file>.<8hex>.tmp`, then `renameSync` over the target. Readers and
  the watcher never see a half-written file; the watcher ignores `*.tmp`.
- **Per-file mutex** (`withFileLock`, file-mutex.server.ts): `navigator.locks`
  (Web Locks in Node) keyed by absolute path — in-process serialization of every
  read-modify-write. NOT cross-process.
- **`updateTaskFile(ref, mutate)`** (task-writer.server.ts:117-138): lock → read
  + tolerant parse → *stale-read repair* → mutate in place (or return
  replacement) → auto-bump `frontmatter.updatedAt` → serialize → atomic write →
  remember write. Throws notFound when the file is absent.
- **Stale-read repair** (VirtioFS/Docker Desktop hazard): the process remembers
  the last content it wrote per path (bounded map, 500 entries —
  task-writer.server.ts:70-115). If a locked read returns different content AND
  the file's mtime has not advanced past our write time + 100 ms slack (:102 —
  i.e., no external writer), the remembered content is trusted over disk. Real
  external edits win via mtime. **Now covers project.md too** (P11-51,
  pass-11 gap #4 closed): project-writer.server.ts:52-98 implements the same
  repair (`rememberProjectWrite`/`repairStaleProjectRead`), applied inside
  `updateProjectFile` (:100) and — before advancing the counter —
  `allocateTaskKey` (:166-185, repair at :173).
- `createTaskFile` (:140, 409 on existing), `appendTimelineEvent` (:175,
  unshift = prepend, optional frontmatter patch), `patchTaskFrontmatter` (:187).
- **`allocateTaskKey`** (project-writer.server.ts:166-185): under the
  project.md lock — stale-read repair, then `max(nextTaskNumber, scan of
  existing <PREFIX>-<n> dirs)+1`, persists the bumped counter, returns
  `VIB-<n>`. Concurrent calls can never mint the same key; a stale/missing
  counter self-heals from the dir scan.
- `updateProjectFile` still bumps **no timestamp** — project.md has no
  `updatedAt` field (see §2.1, Findings).
- **Mutations do not rely on the watcher**: every action layer writes the file
  then synchronously calls `rebuildPath(db, absPath)` itself ("write file →
  reproject") — e.g. task-actions.server.ts:353 (task) / :455 (project.md),
  operator-actions.server.ts:241, schedule.server.ts:56,
  github/pr-open.server.ts:317, github/github-reconciler.server.ts:343 & :595.
  The watcher is for EXTERNAL edits.

### 3.2 Diagnostics model (`app/schemas/file-diagnostics.ts`, `app/server/interpretation/`)

Every parse emits `FileDiagnostic { severity: info|warning|error, code, path?,
message, hardStop? }`. Readiness effect (diagnostics-policy.server.ts:
`readinessEffectOf` :28, `worstReadinessEffect` :41): info → none; warning →
floor `input_required`; error → floor `inconsistency_risk_detected`; hardStop →
floor `blocked`. `deriveReadiness` (readiness-policy.server.ts:36) is THE only
readiness derivation: stored readiness is respected unless the diagnostic floor
is worse (never improves). `referenceDiagnostics` (:58 of
diagnostics-policy.server.ts) adds project-context checks — currently only
`reference.unknown_stage` (:69, stage id not in project's stage list).
"accepted" is a display state = task sits in the project's last stage
(`isAcceptedDisplayState`, readiness-policy.server.ts:55).

### 3.3 File watching (`app/server/files/file-watch.service.server.ts`)

- `node:fs watch(projectsDir, { recursive: true, ignore })` (:213-214) —
  chokidar was removed in PR #84. Watches **only** `${dataRoot}/projects`.
- Filtering (`shouldIgnoreWatchPath` :66): dotfile path segments and `*.tmp`
  ignored; depth ≥4 ignored except exactly
  `projects/<slug>/tasks/<KEY>/task.md` — so task `workspace/` churn never
  triggers projection work. The predicate is applied twice: as the `watch()`
  `ignore` option (:214) AND re-run inside `onChange` (:204) — redundant twins.
- 250 ms trailing debounce per path (`WATCH_DEBOUNCE_MS` :21), separate timer
  maps for files and dirs. File events on `project.md`/`task.md` →
  `rebuildPath`. `rename` events additionally schedule a **directory
  reconcile** (E13, `rebuildDir` :145-196): a vanished `projects/<slug>` or
  `.../tasks` reconciles the whole project (project row + every projected task
  checked against disk); a vanished `.../tasks/<KEY>` reprojects that task
  (file gone → row removed); the projects ROOT vanishing reconciles every
  projected project. A null filename falls back to a root-dir reconcile.
- Error handling (E8/F10-08): any watcher error clears the global handle (so
  `/resources/health` reports the truth — resources.health.ts:38) and closes
  it; transient FS-pressure codes (EMFILE/ENFILE/ENOSPC/EPERM/EACCES, :239)
  schedule ONE owned, cancellable, generation-guarded re-arm after 2 s —
  teardown can never be resurrected and a deleted root can't loop.
- HMR-safe singleton behind `Symbol.for("viberr.fileWatcher")` (:23);
  `isFileWatcherAlive()` (:272) feeds the health route.

### 3.4 KB watching (`app/server/files/kb-watch.service.server.ts`) — NEW

- `node:fs watch(kbRoot, { recursive: true })` over `${dataRoot}/kb`
  (started at boot :146). The changed path's FIRST segment under `kb/` names
  the KB dir (`kbDirOfChange` :35-42); 250 ms per-KB debounce
  (`KB_WATCH_DEBOUNCE_MS` :23); re-index via `reindexKnowledgeBaseByDir`
  (org/resources.server.ts — bumps `last_indexed_at`, recomputes doc count;
  a KB pinned to `manual` is skipped inside). Makes the `on change` refresh
  mode real instead of a decorative label (R-D/P11-60).
- HMR-safe singleton behind `Symbol.for("viberr.kbWatcher")` (:25);
  `stopKbWatcher()` for tests. **No error recovery parity with the projects
  watcher** — see Findings.

---

## 4. Projections (files → SQLite)

### 4.1 Rebuilder (`app/server/projections/rebuilder.server.ts`)

Single-file incremental (`rebuildPath` :522-551) routes on the store-relative
path (`projects/<slug>/project.md` / `projects/<slug>/tasks/<KEY>/task.md`;
everything else `ignored`). Errors are caught, logged, and recorded as
provenance `error` rows — a rebuild never throws to the watcher.

- **Content-hash short-circuit**: sha256 of file content vs the stored
  `content_hash` (project :187-190, task :327-331); unchanged files are not
  re-projected (and record no provenance). `force` bypasses.
- **`rebuildProjectFile`** (:158-276): absent file + existing row → delete row +
  its diagnostics, provenance `removed`, emit `project.removed` (:174).
  Otherwise upsert `projects` (name, archived, repo, default_branch,
  task_prefix, description, stages/workflow/agents/credential-policy/guardrails
  as JSON, source_path, content_hash, parsed_at), replace `project_members`,
  replace `diagnostics` for the path, provenance `projected`, emit
  `project.updated` (:253). Then **cascade** (:268): when the project row was
  created or its hash changed, force-reproject every task of the project
  (stage-reference diagnostics, effective repo and member context are baked
  into task rows). `skipTaskCascade` suppresses this for walk-based rescans.
- **`rebuildTaskFile`** (:288-511): absent + existing → delete
  `task_projections` + `task_events` + diagnostics rows, provenance `removed`,
  emit `task.removed` (:312). Otherwise parse; add `referenceDiagnostics`
  (unknown stage); compute derived readiness (stored readiness is NULL in the
  row when a readiness-path diagnostic exists); upsert `task_projections` —
  including `validation_block_reason` = `acceptanceBlockedReason(fm)` (:412,
  P11-50) and the legacy-shaped engagement columns (:414-418: the delivering
  engagement fills `specialist_json`, the supporting engagements fill
  `reviewers_json`; `delivers` rides along in the JSON); wholesale replace
  `task_events` (position 0 = newest, actor snapshot denormalized as
  `actor_json`, unknown actors projected as `system` so their events stay
  visible); replace diagnostics; provenance `projected`; emit `task.updated`
  (:503).
- **`rebuildProject(db, slug)`** (:562-640) — SCOPED rescan (F20): reprojects
  one project.md + its task files, prunes only THAT project's vanished rows,
  provenance `rescan` (scope: "project"), emits
  `projection.rebuilt {scope:"project"}` (:632). Backs the Board "Re-scan"
  action.
- **`rebuildAll`** (:645-740) — full walk over every project dir + task dir,
  prunes any projected row whose backing file is gone, provenance `rescan`,
  emits `projection.rebuilt {scope:"full", changed}` (:732).

Wrappers:

- `rescanProjections` / `rescanProject` (rescan.server.ts) — audit-recording
  fronts (`projection.rescan`) for Home "Re-scan store" (org admin), the Board
  re-scan, `npm run rescan`, and the boot reconcile.
- `rebuildProjections` (rebuild.server.ts:40-52) — the recovery hammer: inside
  ONE transaction, DELETE task_events/diagnostics/task_projections/projects
  (project_members cascades), then `rebuildAll({force:true})`. Projection
  events raised inside are **buffered** via `collectProjectionEvents` (:52) and
  emitted only after commit — SSE can never observe a half-built or rolled-back
  projection. NOT dropped: users, sessions, notifications, audit_events,
  provenance, PATs, violations, agent_runs/run_log_lines, org resources.

### 4.2 SQLite schema (`db/migrations/0001_baseline.sql` — the ONLY migration)

**Squash convention (owner ruling, pass 11 — header :10-19)**: while pre-prod,
schema changes are squashed INTO the baseline; no incremental chain is kept.
The old `0002_delivering_single_flight.sql` was folded in and deleted (63cfe53).
The runner records the filename in `schema_migrations` and skips by FILENAME
alone, so editing the baseline reaches FRESH databases only — an existing DB
keeps its old schema and projection writes touching a new column throw (no
drift healer). Accepted recipe after pulling a baseline change: wipe the sqlite
and `npm run seed -- --reset`. Because users/auth live in the same file, a wipe
regenerates user ids. Revisit at first real deployment. The baseline carries
zero demo data (the old 0005 mock scope-violation seed is gone — header :8).

File-derived (dropped + rebuilt by `rebuildProjections`):

| Table (0001 line) | Fed by | Notes |
|---|---|---|
| `projects` (:49) | rebuildProjectFile | one row per project.md; stages/workflow/agents/guardrails as `*_json`; `content_hash` powers the short-circuit |
| `project_members` (:66) | rebuildProjectFile | replaced wholesale per project; CHECK on the 4 roles |
| `task_projections` (:72-123) | rebuildTaskFile | one row per task.md; derived `readiness` + raw `stored_readiness`; **`validation_block_reason` (:89, P11-50)** — NULL when the current revision is acceptance-ready; `specialist_json`/`reviewers_json` (:91-92) derived from engagements; effective `repo` (task override else project default); `packet_json`, `recommendation_count`+`recommendation_kinds` (:104-109), `schedules_json` (:113 — schedule-runner queries this, not files), `event_count`, `comment_count`, `diagnostic_count`, `board_rank` (:121) |
| `task_events` (:124) | rebuildTaskFile | replaced wholesale per task; `position` 0 = newest; `actor_kind` CHECK (human/agent/operator/system), `actor_ref`, denormalized `actor_json` render snapshot, `to_agent`, `evidence_json` |
| `diagnostics` (:142) | replaceDiagnostics on every (re)projection | per source_path; severity/code/path/message/hard_stop |

Projection bookkeeping (kept across rebuilds): `provenance` (:154, one row per
acting rebuild `projected`/`removed`/`error` + one `rescan` summary per rescan);
`schema_migrations` (created by the runner).

App-owned (never file-derived):

| Table (0001 line) | Fed by |
|---|---|
| `users` (:23-36) | app user store (`app/server/auth/user-store.server.ts`), seed-admin, oauth provisioning |
| `user`, `session`, `account`, `verification` (:294-297) | **better-auth** tables (migration Option B bridge — coexist with legacy `users`) |
| `notifications` (:163-177, kind CHECK :166) | `createNotification` (§6) |
| `audit_events` (:37) | `recordAudit` (§7) |
| `user_prefs` (:178) | per-user key/value prefs (notification routing etc.) |
| `github_pats` (:185), `project_github_credentials` (:195), `github_connections` (:212) | PAT store (`app/server/secrets/pat-store.server.ts`, AES-GCM encrypted token) / org connections |
| `google_domain_allowlist` (:222) | org user admin |
| `scope_violations` (:201) | `openScopeViolation`/`resolveScopeViolation` (policy-violations.server.ts) via `app/server/github/scope-flag.server.ts`; partial unique index (:320-322) = at most one OPEN row per (project, scope, task) |
| `org_knowledge_bases` (:228), `org_mcp_servers` (:238), `org_skills` (:250) | org resource catalog (`app/server/org/resources.server.ts`); kb/skills content lives on disk under `kb/` and `skills/` |
| `agent_runs` (:257-284) | run store (`app/server/runtimes/run-store.server.ts`); partial unique index `idx_agent_runs__one_delivering` (:337-339, **formerly migration 0002**) — at most ONE queued/running `kind='primary'` run per task; startRun translates the constraint violation into a 409 |
| `run_log_lines` (:285) | run sink — DB projection of the canonical `.jsonl` under `runtimes/` |
| `staged_outcomes` (:352-356) | **NEW (P11-28)** — the Claude `report_outcome` toolkit envelope, staged mid-run keyed by the run's outcomeKey and consumed exactly once when the run's completion is recorded. Dual-layer with an in-process map (agent-outcome.server.ts:155-220: `STAGED_MAX` 500, orphan prune `STAGED_TTL_MS` 24 h); persisted so a restart between run-finish and completion-callback doesn't lose the structured verdict/question — boot recovery reads the row instead of the prose-regex fallback |

### 4.3 Read models (`app/server/projections/*.server.ts`)

Pure queries over the tables (no mutations): `board-query` (board columns in
stage order, orphan bucket for unknown stages, sparse `boardRank` ordering with
key-number×`BOARD_RANK_BASE`(1e6) default :28,:45), `task-query` (detail +
timeline + diagnostics; actor render overlays the CURRENT users table so
renames show immediately), `activity-feed` (project stream over task_events +
audit-log panel merging scope_violations and a whitelisted subset of
audit_events; whitelist :108+, fallback template guarantees no raw JSON in UI
:254), `decisions` (`decisionsRequiring` :70 — THE single source of "which open
decisions require this user": open packet or ≥1 pending recommendation on a
non-terminal-stage task, member-scoped with the narrow owner exception),
`review-queue` (resolved review-stage tasks split by acceptance authority +
readiness — **no longer reads task files**: `blockReason` comes straight from
the projected `validation_block_reason` (P11-50); pass-11 gap #10 closed),
`agent-deployments` (engagements joined with live agent_runs; the `exportable`
flag now uses `transcriptExists` — session-export.server.ts:157-200, a
filename-only probe with a 30 s TTL / 500-entry cache instead of the heavy
`locateTranscript` content scan, 63cfe53/P11-43), `notifications`,
`policy-violations`.

---

## 5. Events

### 5.1 In-process projection emitter (`app/server/events/projection-events.server.ts`)

`ProjectionEvent` union (:11-44) — compact facts only, never fat objects:

| Type | Emitted from |
|---|---|
| `task.updated` | rebuildTaskFile (:503) after every task (re)projection |
| `task.removed` | rebuildTaskFile (:312) when the file vanished |
| `project.updated` | rebuildProjectFile (:253) |
| `project.removed` | rebuildProjectFile (:174) |
| `projection.rebuilt {scope: full\|project, changed}` | rebuildAll (:732, "full"), rebuildProject (:632, "project"). The dead `"file"` enum member was REMOVED (:28; pass-11 gap #1 closed) |
| `notification.created {userId}` | createNotification (notifications.server.ts:89) |
| `notification.read {userId}` | markNotificationsRead / markAllNotificationsRead / markTaskPacketApprovalRead (per affected user) |
| `violation.updated {projectSlug, taskKey\|null}` | openScopeViolation / resolveScopeViolation (policy-violations.server.ts) |

Singleton `EventEmitter` behind `Symbol.for("viberr.projectionEvents")` (:46).
`collectProjectionEvents(fn)` (:82) defers emission inside write transactions
(buffered, re-emitted after commit; discarded on throw) — used by
`rebuildProjections`.

### 5.2 Publisher bridge (`app/server/events/event-publisher.server.ts`)

`startEventPublisher()` (:173, boot) subscribes the emitter and translates each
ProjectionEvent into the CONVENTIONS wire shape
`{ type, entityId, occurredAt, data }` + an `SseRoute`, zod-parsing against
`sseEventSchema` before publish (:186; malformed = loud log, never on the
wire). `task.updated` is enriched with projected facts (stage, readiness) read
back from `task_projections` (:152). Routing: task/project events →
project(+task) scoped; `projection.rebuilt` → broadcast; notification events →
**user-targeted** (only that user's `user`-scoped connections).

### 5.3 SSE wire contract (`app/schemas/sse-event.schema.ts`)

Event names (:25-39): `task.updated, task.removed, project.updated,
project.removed, projection.rebuilt, notification.created, notification.read,
violation.updated, run.log-appended, run.state-changed, stream.open,
stream.resync`. `projection.rebuilt`'s scope is `z.enum(["full","project"])`
(:86 — "file" removed). `stream.open` (first message; carries head event id)
and `stream.resync` (Last-Event-ID predates the ring buffer / restart reset
ids → client revalidates once) are broker control events, never buffered.

**High-frequency runtime stream**: `run.log-appended {runId, threadId, seq}`
and `run.state-changed {…, state}` are published **straight to the broker** by
`app/server/runtimes/run-events.server.ts` (:12 / :36, from the run
sink/adapters) — deliberately NOT through the projection emitter (that path
implies a projection rebuild per event). Payloads are reference-only; the logs
consumer fetches lines since `seq`.

### 5.4 Broker (`app/server/events/sse-broker.server.ts`)

- Per-connection scopes: `project:<slug>` | `task:<slug>/<key>` | `projects`
  (all-projects firehose) | `user` (`parseSseScope` :53-61).
- `routeMatchesConnection` (:79): userId-routed events require BOTH the
  matching user AND a `user` scope; broadcast hits everyone; project/task routes
  match `projects`, matching `project`, or matching `task` scopes.
- Ring buffer of last 256 events (`RING_BUFFER_SIZE` :36, trim :312) with a
  monotonic id; reconnect with `Last-Event-ID` replays missed events
  scope-filtered, or sends `stream.resync` when out of window. Heartbeat
  comment `: hb` (:169) every 25 s (`HEARTBEAT_INTERVAL_MS` :35, unref'd :292).
  Any throwing write drops+closes that connection (backpressure-safe; slow
  clients can't block the publisher). HMR-safe global state; SIGINT/SIGTERM
  (:154-155, skipped when `NODE_ENV === "test"` :146) closes all connections
  then re-raises.

### 5.5 The stream route (`app/routes/resources.events.ts`)

`GET /resources/events?scope=…` (repeatable). Session-cookie auth; 401 JSON for
unauthenticated (:58 — EventSource can't render redirects), 400 on
malformed/absent scopes. **Authorization (D9)**: org admins subscribe to
anything; non-admins get the `projects` firehose EXPANDED into per-project
scopes of their member projects only, explicit project/task scopes kept only
when a member, `user` always passes; only-foreign-scopes → 403 (:126). Wire: a
never-ending `ReadableStream` Response, `Cache-Control: no-store,
no-transform`, `X-Accel-Buffering: no` (:176); backpressure limit
`MAX_QUEUED_CHUNKS` 1024 (:51) — beyond it the write throws and the broker
drops the connection; aborts and stream cancel both close the broker handle.

---

## 6. Notifications (`app/server/projections/notifications.server.ts`)

SQLite-owned per-user inbox rows (`notifications` table; kinds
`packet | approval | mention | quality | policy`, `ptype` input|blocked for
packet rows). **Single insert point** `createNotification`:

- Consults the recipient's routing prefs (`isNotifKindEnabled` :59-61) unless
  `bypassPrefs` (:40 — FIXTURE inserts only, i.e. the test-only demo seed;
  keeps the fixture deterministic against leftover prefs); opt-out model — no
  pref / prefs error = deliver. Returns null when silenced.
- Emits `notification.created {userId}` (:89, user-targeted SSE).
- Fan-out: `notifyTaskWatchers` (task-actions.server.ts:214-…) — project
  admins+maintainers + the task owner, minus the triggering user; @mention
  fan-out at task-actions.server.ts:681-…
- Read state is **monotonic** (no mark-unread) and idempotent:
  `markNotificationsRead(ids)` (:174), `markAllNotificationsRead` (:192), and
  `markTaskPacketApprovalRead(project, task)` (:211) — the packet-resolution
  side effect that marks that task's packet+approval rows read for EVERY user,
  one `notification.read` per affected user. `listNotifications` (:105) joins
  live task state: `waitingOnYou` is recomputed at read time from
  `decisionsRequiring` (member-scoped; never a stored flag), and actor
  snapshots are overlaid with current user identities. Unread badge =
  `countUnreadNotifications` (:151).

The TS `NotificationKind` (app/shared/mapping/notification.server.ts:24) still
mirrors the DB CHECK by hand, but a pin test now anchors it to the
`CREATE TABLE notifications` block of the baseline
(app/shared/mapping/notification.server.test.ts:14-20, 63cfe53) — drift breaks
CI instead of throwing at insert time.

## 7. Audit, logging, retention

### 7.1 Audit (`app/server/audit/audit-recorder.server.ts`)

`recordAudit(db, { action, actor {userId|null, label}, subjectKind?, subjectId?,
projectSlug?, taskKey?, details? })` → `audit_events` row (`evt_…` id). Rules:
details must be secret-free; failures are logged and swallowed (recording never
breaks the action). Actions are lowercase dot-separated facts. ~30 modules
record: auth, org, projects, tasks, secrets, projections (`projection.rescan`,
`projection.rebuild`), runtimes, and now `seed.baseline` (seed.server.ts:176).
Coverage is enforced by `app/server/audit/audit-coverage.server.test.ts`.
Surfaced in the Activity "audit log" panel through a whitelist mapping
(activity-feed.server.ts:108+, fallback template :254 guarantees no raw JSON in
UI).

### 7.2 Logging (`app/server/logging/logger.server.ts`)

Dependency-free JSON-lines logger to **stdout** (`{level, time, msg, …fields}`),
levels debug/info/warn/error, threshold `LOG_LEVEL` (:15; default info in prod,
debug elsewhere). Must never import other server modules. Nothing writes file
logs.

### 7.3 Run logs

Canonical: append-only NDJSON at `runtimes/<backend>/<sessionOrRunId>.jsonl`
(run-store.server.ts:8-11). Projection: `agent_runs` + `run_log_lines` rows;
SSE fan-out via §5.3.

### 7.4 Retention (`app/server/db/retention.server.ts`, boot best-effort)

`run_log_lines` > 30 days deleted (:21); `audit_events` > 90 days deleted
(:23); `notifications` capped at newest 500 per user (:25). Canonical files
never touched.

---

## 8. Seeding — clean-sheet product seed vs demo fixture (NEW, PR #90)

Owner ruling 2026-07-24: **the product ships zero demo data**. Two separate
entry points:

### `npm run seed` (scripts/seed.ts → `runSeed`, app/server/seed/seed.server.ts:116-194)

1. **Bootstrap admin** — the same `seedInitialAdmin` boot runs
   (app/server/auth/seed-admin.server.ts): created ONLY while the users table
   is empty; email from `VIBERR_SEED_ADMIN_EMAIL` (lowercased) else
   `DEFAULT_SEED_ADMIN_EMAIL = "admin@viberr.dev"` (:20); password from
   `VIBERR_SEED_ADMIN_PASSWORD` else `SEED_DEFAULT_PASSWORD =
   "viberr-dev-2828"` (seed.server.ts:55). At BOOT with no env password, a
   random password is generated, logged exactly once (clearly marked) and
   `pwreset_required = 1` forces a change at first login. P11-01 recovery
   (seed.server.ts:133-159): an existing admin whose stored credential is in a
   legacy/unverifiable format is re-hashed to the configured password
   (a valid better-auth hash is left untouched) — `npm run seed` restores
   access instead of leaving the admin locked out.
2. **Agent catalog templates** — `SEED_AGENT_PROFILES`
   (app/server/seed/agent-catalog.server.ts:79-…): operator, developer,
   reviewer org-profile files, written atomically to `agents/profiles/<id>.md`.
   This catalog is PRODUCT data (also consumed by boot's default-asset backfill
   and project creation's preinstalled roster). `mapActions` (:23-40) maps
   action labels onto CAP_CATALOG ids; unmatched labels become display-only
   extras.
3. **Projection rescan** — `rebuildAll({force:true})` over whatever REAL
   project files exist (none on a fresh/reset store; the board starts empty by
   design). Audit `seed.baseline` (:176).
4. **Org resources** (scripts/seed.ts:33 → `seedOrgResources`,
   app/server/org/org-seed.server.ts): KBs with real files under `kb/`, skills,
   the Google domain allowlist. No MCP servers and no GitHub connection are
   fabricated (honest empty slate).

`npm run seed -- --reset` → `resetStore` (seed.server.ts:93-114): wipes
`projects/`, `agents/profiles`, the per-backend TRANSCRIPT dirs
(`runtimes/claude`, `runtimes/codex`) — **never** the credential homes
`runtimes/claude-home` / `runtimes/codex-home` (P11-04: deleting those logged
the instance out) — and the `DERIVED_TABLES` (:72-83): staged_outcomes,
run_log_lines, agent_runs, notifications, provenance, diagnostics,
task_events, task_projections, project_members, projects. Users/auth tables
survive. (`scope_violations` is NOT in the list — see Findings.)

### `npm run seed:demo` (scripts/seed-demo.ts → `runDemoSeed`, test-support/demo-seed.ts)

TEST/DEV ONLY — the former production demo seed, kept verbatim as the fixture
the route-level suites are written against: mock users
(arda/elif/murat/selin/deniz @viberr.dev), viberr-core + two stub projects,
tasks VIB-139…168 with full timelines/packets, Arda's notification inbox
(inserted with `bypassPrefs`), the VIB-142 `pull_request:write` scope violation
(raw `INSERT OR IGNORE INTO scope_violations`, demo-seed.ts:240), Home pins.
Dataset content lives in `test-support/demo-data.ts` (831 lines, canonical file
formats, mock copy preserved exactly). Idempotent; `--reset` reuses the product
`resetStore`. Playwright seeds it explicitly (playwright.config.ts:77:
`rm -rf e2e/.tmp-data && npm run seed:demo && npm run dev`).

**Drift guards** (625eb71): `app/server/seed/demo-fixture.test.ts` (300 lines)
shape-pins the fixture (counts, credential verifiability, file round-trips,
board/notification/task-detail projections); `seed.server.test.ts` pins the
clean-sheet properties of the product seed.

---

## 9. End-to-end flows (cheat sheet)

- **In-app mutation**: action → RBAC (`requireAction`; archived = read-only) →
  `updateTaskFile` (lock, parse, stale-read repair, mutate, bump updatedAt,
  atomic write) → `rebuildPath` → row upsert + `task.updated` → publisher →
  SSE → clients revalidate. Audit + notifications recorded by the action layer.
- **External edit** (human/agent edits task.md directly): fs event → 250 ms
  debounce → `rebuildPath` → same tail. Offline edits are caught by the boot
  rescan.
- **Task create**: `allocateTaskKey` (project.md counter, atomic, repair-first)
  → `createTaskFile` → reproject task + project (counter changed).
- **Delivery/review**: delivering run produces a head → `nextWorkRevision`
  mints/keeps a revision → reviewer verdicts bind to `revisionId` →
  `deriveValidation` cache + projected `validation_block_reason` → acceptance
  gated by `acceptanceBlockedReason`.
- **Fresh install**: boot alone gives a working instance (bootstrap admin with
  one-time logged password); `npm run seed` adds the agent catalog + org
  resources; the board starts empty. Demo board only via `seed:demo`.

---

## Delta since pass 11 (2026-07-23 doc → main @ 0981cfa)

Landed via PR #87 tail (incl. 63cfe53) and PR #90 (e306248 + 625eb71):

1. **Migrations squashed into `0001_baseline.sql`** (63cfe53, standing owner
   ruling): `0002_delivering_single_flight.sql` deleted; the one-delivering
   partial unique index now lives at 0001:337-339. Header :10-19 documents the
   squash convention + the wipe-and-reseed upgrade step. The pass-11 warning
   "never edit an applied migration; add 0003" is now WRONG pre-prod — the
   convention is the opposite: edit the baseline, wipe, reseed.
2. **`task_projections.validation_block_reason`** (P11-50, e6cf7a3): column
   0001:89, written by the rebuilder (:412) from `acceptanceBlockedReason(fm)`;
   `review-queue.server.ts` no longer re-reads task files on a loader path —
   pass-11 gap #10 CLOSED.
3. **`staged_outcomes` table** (P11-28): 0001:352-356 +
   agent-outcome.server.ts:155-220 — persisted staging of the Claude
   `report_outcome` envelope (dual with an in-process map; 24 h orphan TTL;
   consumed exactly once) so restarts don't lose structured verdicts.
4. **Project-writer stale-read repair** (P11-51, f38a4b0): pass-11 gap #4
   CLOSED — `updateProjectFile` and `allocateTaskKey` now share the VirtioFS
   read-your-own-writes repair (project-writer.server.ts:52-98, :173).
5. **Live KB watcher** (R-D/P11-60, 544b6f3): `kb-watch.service.server.ts`,
   started at boot :146 — "on change" KB refresh is real.
6. **GitHub reconcile poller at boot** (P11-14; 63cfe53 hardened): 5-min PR
   status reconciliation, HMR singleton (reconcile-poller.server.ts:75).
7. **Env surface completed** (pass-11 gap #9 mostly closed):
   `VIBERR_CLAUDE_MAX_TURNS` / `VIBERR_CODEX_IDLE_TIMEOUT_MS` moved INTO the
   schema (env.server.ts:125-126); consumers use `getEnv()`
   (claude-runtime :273, codex-runtime :174). Remaining raw reads are
   deliberate: askpass handshake, LOG_LEVEL, test markers. Note
   git-clone-auth.server.ts lives under `app/server/tasks/` (the pass-11 doc's
   §3.1-adjacent references implied `github/`).
8. **`projection.rebuilt` scope `"file"` removed** (efca1a2): pass-11 gap #1
   CLOSED (projection-events :28, sse-event.schema :86 — now
   `"full" | "project"`).
9. **`cache/ auth/ logs/` data-root dirs removed** (efca1a2): pass-11 gap #6
   CLOSED.
10. **Stale comments fixed**: policy-violations.server.ts header now states no
    violation is seeded (:25-28, gap #2 CLOSED); the task-file `github` cache
    comment no longer calls the reconciler "future" (:243-244, gap #3 CLOSED).
11. **Clean-sheet seed split** (e306248 + 625eb71): product seed = agent
    catalog + org KBs/skills + env-configured bootstrap admin
    (admin@viberr.dev default), created only on an empty users table; ZERO demo
    board data. Demo dataset lives ONLY in `test-support/demo-seed.ts` +
    `demo-data.ts`, seeded via `npm run seed:demo` (scripts/seed-demo.ts);
    playwright seeds it explicitly. Fixture drift guards in
    `app/server/seed/demo-fixture.test.ts`. Catalog extracted to
    `app/server/seed/agent-catalog.server.ts` (PRODUCT data). `--reset` spares
    the runtime credential homes (P11-04) and re-hashes a
    legacy-format admin credential (P11-01).
12. **`transcriptExists` probe** (P11-43, 63cfe53):
    session-export.server.ts:157-200 — filename-only existence probe (30 s TTL,
    500-entry cache) feeds the run projection's `exportable` flag; the heavy
    `locateTranscript` (content scan + whole-file stats) is export-route-only.
    Codex walk split into byFilename/byContent passes.
13. **Operator transition-chain cap** (63cfe53):
    `OPERATOR_TRANSITION_CHAIN_CAP = 8` (task-actions.server.ts:103) with
    `transitionDepth` threaded through the operator drive; at the cap the
    transition lands but coordination pauses on the stuck-loop packet.
14. **NotificationKind pin test** anchored to the notifications CREATE TABLE
    block (63cfe53) — pass-11 gap #12 downgraded from trap to guarded.
15. Line-number drift throughout (files grew): boot :75-203; rebuilder blocks
    +4; task-actions call sites :353/:455, notifyTaskWatchers :214, mentions
    :681; operator-actions :241; github-reconciler :343/:595;
    file-store-root helpers :44/:100/:146; env schema :12-127; baseline table
    offsets as tabled in §4.2.

Pass-11 gaps still OPEN and re-verified: #5 (no project.md `updatedAt`),
#7 (dual user tables, 0001:23-36 vs :294-297), #8 (legacy
`specialist_json`/`reviewers_json` columns, rebuilder :414-418), #11 (watcher
double filter, :204/:214), #13 (in-process-only mutex/broker singletons).

---

## Findings candidates (pass 12)

Verified while reading; each cites current source.

1. **KB watcher has no error recovery or health surfacing — asymmetric with the
   projects watcher.** `kb-watch.service.server.ts:106-108` handles watcher
   errors by logging only; the dead `FSWatcher` handle stays cached under
   `Symbol.for("viberr.kbWatcher")`, so every later `startKbWatcher()` call
   returns the dead watcher (:52 `if (existing && existing.root === root)
   return existing.watcher`) and nothing ever re-arms. Contrast
   `file-watch.service.server.ts:216-266` (error clears the handle, transient
   FS-pressure codes re-arm once, generation-guarded). `/resources/health`
   (app/routes/resources.health.ts:38) reports only `isFileWatcherAlive()` —
   a dead KB watcher is invisible; "on change" KBs silently go stale, which is
   exactly the decorative-label failure R-D was meant to end.
2. **`resetStore` does not clear `scope_violations`.** `DERIVED_TABLES`
   (app/server/seed/seed.server.ts:72-83) omits `scope_violations`, so
   `npm run seed -- --reset` wipes all projects/tasks but keeps OPEN violation
   rows referencing them. Recreating a same-slug project (trivial under the
   clean-sheet flow, and guaranteed by `seed:demo` re-seeding viberr-core)
   resurrects a phantom open violation → Settings rail badge with no backing
   task state. The demo path is only saved by `INSERT OR IGNORE` + the partial
   unique index (test-support/demo-seed.ts:240). Either add `scope_violations`
   to the wipe list or document why governance records outlive their subjects.
3. **Demo fixture inserts scope violations via raw SQL, bypassing
   `openScopeViolation`.** test-support/demo-seed.ts:240 writes the VIB-142 row
   directly — no `violation.updated` projection event and no audit row, unlike
   every runtime opener (policy-violations.server.ts). Deterministic-fixture
   intent is clear, but any future fixture consumer asserting audit/SSE
   behavior around violations will chase a ghost. Worth a comment at minimum.
4. **The `validation` frontmatter cache is only recomputed at three write
   sites** (task-actions.server.ts:1478, :2496;
   workspace-delivery.server.ts:378), not centrally in `updateTaskFile` — an
   external/manual edit that changes `verdicts` or
   `workRevision` leaves a stale `validation:` value in the file until the next
   in-app review action. The projection is honest (the rebuilder recomputes
   `validation_block_reason` from the parsed frontmatter via
   `acceptanceBlockedReason(fm)` rebuilder.server.ts:412) but the row's
   `validation` column (:84 CHECK) copies the file's cached value (`fm.validation`,
   :410) rather than re-deriving — file-edited tasks can project
   `validation: healthy` alongside a non-null `validation_block_reason`.
   Inconsistent derivation depth for two columns born from the same model.
5. **Residual (carried from pass 11, still true)**: (a) project.md has no
   `updatedAt` and `updateProjectFile` bumps nothing —
   project-file.schema.ts:168-223, project-writer.server.ts:100; (b) dual
   user-table worlds `users` vs better-auth `user/session/account/verification`
   — 0001_baseline.sql:23-36 vs :294-297; projections/audit/notifications key
   on `users.id` (`u_…`); (c) `specialist_json`/`reviewers_json` are derived
   legacy views of `engagements` — 0001:91-92, rebuilder.server.ts:414-418;
   `verdictCapable` visible only inside `reviewers_json` JSON; (d) watcher
   `ignore` option + in-handler re-check are redundant twins —
   file-watch.service.server.ts:204,:214; (e) file mutex
   (`navigator.locks`) and broker/emitter singletons are per-process only —
   nothing enforces single-node on a shared data root.
