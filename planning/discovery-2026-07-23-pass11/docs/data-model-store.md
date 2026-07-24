# Viberr data model, projections & events (pass 11, 2026-07-23)

Audience: implementation subagents with **zero** other context. Everything here was
verified against the code on 2026-07-23 (main, post-PR #84 — chokidar replaced by
`node:fs` watchers). File:line references are to that state.

**Core principle**: Viberr is a *file-native* store. Markdown files under
`${VIBERR_DATA_ROOT}` — `projects/<slug>/project.md` and
`projects/<slug>/tasks/<KEY>/task.md` — are the ONLY canonical business truth for
projects and tasks. SQLite (`state/projection.sqlite`) is a **derived projection**
that can be dropped and rebuilt from disk at any time. Humans and agents may edit
the files directly; a watcher + rescans reconcile them into SQLite. App-owned data
(users, sessions, notifications, audit, PATs, agent runs, org resources) lives only
in SQLite and is *not* file-derived.

Prior canonical format doc: `docs/architecture/file-formats.md` (275 lines, still
accurate on formats; this doc adds the projection/event/env layers on top).

---

## 1. Env config (`app/server/config/env.server.ts`)

`getEnv()` parses `process.env` exactly once per process (zod, cached under
`Symbol.for("viberr.env")`, HMR-safe; `loadEnvFile()` reads `.env` first,
tolerating ENOENT). Empty-string values are treated as unset. A bad config throws
one multi-line message listing every problem. `resetEnvCacheForTests()` clears the
cache.

Validated variables (env.server.ts:12-118):

| Var | Required | Effect |
|---|---|---|
| `NODE_ENV` | no (default `development`) | mode; `test` disables SSE signal handlers (sse-broker.server.ts:146) |
| `PORT` | no (default 5173) | HTTP port |
| `VIBERR_SESSION_SECRET` | **yes**, ≥32 chars | signs the session cookie |
| `BETTER_AUTH_SECRET` | no (defaults to session secret) | better-auth cookie signing, rotate independently |
| `BETTER_AUTH_URL` | no (required behind a reverse proxy) | absolute public origin for OAuth callbacks/cookies |
| `VIBERR_SECRET_ENCRYPTION_KEY` | **yes**, base64 of exactly 32 bytes | AES-256-GCM key for stored secrets (GitHub PATs); parsed into a `Buffer` |
| `VIBERR_DATA_ROOT` | no (default `./data`) | root of the file-native store + SQLite + run logs |
| `GITHUB_OAUTH_CLIENT_ID/SECRET`, `GOOGLE_OAUTH_CLIENT_ID/SECRET` | no | OAuth login buttons stay disabled when unset |
| `VIBERR_SEED_ADMIN_EMAIL` / `VIBERR_SEED_ADMIN_PASSWORD` | no | initial admin seeded at boot when the users table is empty |
| `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `VIBERR_CLAUDE_USE_CLI_AUTH` | no | Claude backend availability (presence check only — never a paid probe) |
| `CLAUDE_CONFIG_DIR` | no | Claude Agent SDK session dir; point under the data volume so resumed sessions survive restarts (compose uses `runtimes/claude-home`) |
| `CODEX_ACCESS_TOKEN`, `CODEX_API_KEY`, `OPENAI_API_KEY`, `VIBERR_CODEX_USE_CLI_AUTH` | no | Codex backend availability |
| `CODEX_HOME` | no | Codex `codex login` auth dir (compose: `runtimes/codex-home`) |

**Env vars read OUTSIDE the schema** (raw `process.env`, no validation):

- `VIBERR_CLAUDE_MAX_TURNS` — Claude run turn cap (claude-runtime.server.ts:272).
- `VIBERR_CODEX_IDLE_TIMEOUT_MS` — Codex idle timeout, default 15 min
  (codex-runtime.server.ts:173).
- `VIBERR_GIT_ASKPASS_USERNAME` / `VIBERR_GIT_ASKPASS_PASSWORD` — internal
  handshake for the git-clone askpass helper (git-clone-auth.server.ts:5-6);
  set by the app for child git processes, not user config.
- `VIBERR_CLAUDE_TEST_MARKER` / `VIBERR_CODEX_TEST_MARKER` — test hooks.
- `LOG_LEVEL` — logger threshold (logger.server.ts:15); default `info` in prod,
  `debug` otherwise.

### Data-root layout

Created at boot by `ensureDataRootDirs()` (file-store-root.server.ts:24-55):

```
${VIBERR_DATA_ROOT}/
  projects/<slug>/project.md              ← project truth (canonical)
  projects/<slug>/tasks/<KEY>/task.md     ← task truth (canonical)
  projects/<slug>/tasks/<KEY>/workspace/  ← agent working clone (NOT projected/watched)
  agents/profiles/<id>.md                 ← org-level agent profile templates
  runtimes/<backend>/<sessionOrRunId>.jsonl ← raw NDJSON run logs (canonical run truth,
                                              run-store.server.ts:8-11)
  runtimes/claude-home/  runtimes/codex-home/ ← backend auth/session homes (compose mounts)
  kb/<dir>/                               ← knowledge-base folders (store://kb/<dir>/)
  skills/<name>/SKILL.md                  ← skill folders (store://skills/<name>/)
  state/projection.sqlite                 ← SQLite projection DB (+ WAL files)
  cache/  auth/  logs/                    ← created but currently unused (see §9 gaps)
```

Path helpers + traversal containment: `resolveStoreSegment()`
(file-store-root.server.ts:104-123) rejects any kb/skill name with separators,
dot-segments, absolute paths or NUL — bad references are DENIED loudly, never
resolved outside the root. `storeRelativePath()` (:150-153) renders the
UI-visible `projects/<slug>/tasks/<KEY>/task.md` form.

### Boot sequence (`app/server/boot.server.ts:73-177`)

1. `getEnv()` → fail fast; `ensureDataRootDirs()`; `seedDefaultAgentAssets()`.
2. `getDb()` — opens `state/projection.sqlite` (WAL, FK on, busy_timeout 5000 —
   sqlite.server.ts:15-17), applies `db/migrations/*.sql` in filename order, each
   inside its own transaction, recorded in `schema_migrations`
   (migration-runner.server.ts:28-81). **Skips by filename only** — never edit an
   applied migration; add `0003_…`.
3. `seedInitialAdmin` (empty users table only).
4. `startEventPublisher()` — projection emitter → SSE broker bridge.
5. Boot rescan `rescanProjections(db)` — converges projections with offline
   edits (hash short-circuited, cheap on a clean tree; failure never blocks boot).
6. `ensureBaseAgentsDeployed` — operator/developer/reviewer into every project.
7. `startFileWatcher()` — dev AND prod.
8. `finalizeOrphanedRuns` (running/queued runs with no live process → `error`),
   `applyRetention` (§7.4), `recoverUnreactedAgentRuns` (fire-and-forget),
   `startScheduleRunner` (O-3, 60 s tick — schedule.server.ts:36).
9. Boot integrity log (dirs, migrations, projection counts).
   All idempotent, cached under `Symbol.for("viberr.booted")`.

---

## 2. File formats

Shared rules (frontmatter.server.ts):

- Frontmatter = YAML between `---` fences on their own lines; body after.
  BOM tolerated. Missing/unterminated fence or bad YAML → `frontmatter.missing` /
  `frontmatter.unterminated` / `frontmatter.invalid_yaml` **error + hardStop**
  diagnostics and an empty mapping — parsing never throws.
- Serialization: `YAML.stringify(value, { lineWidth: 0 })` (no folding, stable
  round-trips). `serializeFrontmatterFile()` writes known keys in canonical
  order, then unknown keys **that don't collide with known keys** (known wins),
  then the body; file always ends with a single trailing newline
  (frontmatter.server.ts:87-99).
- **Unknown frontmatter fields and unknown `## Sections` survive every write**
  (round-trip safety for foreign/future fields).
- Timestamps: UTC ISO 8601 strings.

### 2.1 `projects/<slug>/project.md` (`app/schemas/project-file.schema.ts`)

Frontmatter = all governed project state. Body = markdown project description.

Annotated example (real shape, from `data/projects/viberr/project.md`):

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
    #   kind: specialist         # carry their FULL definition here (name/role/icon/backends/
    #   persona: …               # model/effort/scope/desc/persona/stages/spanAll/autonomy/resources)
credentialPolicy: null           # non-secret credential requirements ({credentialLabel, masked,
                                 # requiredScopes[]}); the PAT itself lives AES-encrypted in SQLite
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
  `tolerantArray` :265-311): one malformed row drops only itself with an indexed
  diagnostic — a bad `members[1]` can no longer wipe the whole ACL.
- Scalar fields fall back individually (`tolerant` :225-255) with
  `frontmatter.missing_field` / `invalid_field` warnings.
- Unknown keys collected into `unknown` and re-serialized verbatim.

### 2.2 `projects/<slug>/tasks/<KEY>/task.md`

Schema: `app/schemas/task-file.schema.ts`. Parse/serialize:
`app/server/files/task-file.server.ts`. Layout:

```
---  frontmatter (tolerant)  ---
## Goal        prose (the task's goal — editable via updateTaskGoal)
## Packet      ONE fenced ```yaml block — the active decision packet (section absent when none)
## Timeline    typed event log, NEWEST FIRST
## <anything>  unrecognized sections preserved verbatim, in order
```

Annotated modern frontmatter (from `data/projects/viberr-pass-11-runtime-lab/tasks/RTL-1/task.md`):

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
validation: healthy               # DERIVED cache: healthy|changed|failing|none; recomputed by
                                  # deriveValidation() from workRevision+verdicts on every write
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
  title: "[RTL-1] …"
github:                           # GitHub projection cache mirrored by the reconciler +
  commits:                        # workspace delivery — NOT human-edited truth
    - sha: 0b84e4f
      msg: "[RTL-1] Add inert Markdown audit fixture…"
  changed: { files: 1, add: 25, del: 0 }
createdAt: 2026-07-19T23:24:07.128Z
updatedAt: 2026-07-19T23:58:40.130Z   # bumped automatically by updateTaskFile
boardRank: null                   # sparse drag-to-reorder rank; null → key-number × 1_000_000
```

**Legacy absorption** (task-file.schema.ts:576-666): older files carry
`specialist:` / `reviewers:` (or the still-older `consultants:`) instead of
`engagements:` — many live files still do (e.g. `data/projects/viberr/tasks/VIB-2/task.md`).
They are absorbed into engagements on read (specialist → `delivers: true`,
reviewers → supporting, all `verdictCapable: false`) and NOT preserved as
unknown; the next write emits `engagements:` only. An explicit `engagements:`
key always wins. Invariants enforced with diagnostics: profileId-unique
(first occurrence kept), ≤1 deliverer (extras demoted).

**Review-state derivation** (pure helpers, task-file.schema.ts:396-503):
`requiredReviewers` = non-delivering + verdictCapable; `currentVerdicts` =
verdicts matching `workRevision.id`; `deriveValidation` → failing (any required
request_changes) / healthy (all required approved) / changed (revision under
review) / none (no revision); `acceptanceBlockedReason` → human-readable gate;
`nextWorkRevision` → same treeSha (or headSha when tree unknown) = same review
subject, no invalidation — otherwise mint a new revision id (F10-32).

#### `## Packet` — the active decision packet

One fenced ` ```yaml ` block (missing fence + non-empty section →
`packet.no_yaml_block`; bad YAML → `packet.invalid_yaml`; schema-invalid →
`packet.invalid` — packet ignored, never a crash). Shape (taskPacketSchema
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

#### `## Timeline` — typed event log

Newest-first. Each entry (task-file.server.ts:22-53):

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
  comments (`timeline.unknown_type` info).
- Malformed heading / unparseable timestamp → entry skipped with a warning.
  Content outside any `###` → `timeline.stray_content`. Out-of-order entries
  tolerated with `timeline.out_of_order` info (display sorts by timestamp).
- **Body escaping** (bijective, :59-76): free text lines that would read as
  structure (`## `, `### `, `title: `, `to: `, bare `evidence:`) are prefixed
  with one backslash on write and lose exactly one on read — comment text can
  never split sections, forge events, or override the real `## Packet`.
- Duplicate `## Goal`/`## Packet`/`## Timeline` sections: FIRST occurrence wins;
  the duplicate is flagged and preserved as an unrecognized extra section
  (task-file.server.ts:333-342).

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
by profileId and may override capabilities/definition per project.

---

## 3. Read/write machinery

### 3.1 Writers (`app/server/files/task-writer.server.ts`, `project-writer.server.ts`)

- **Atomic writes** (`writeFileAtomic`, atomic-file.server.ts:10-15): write to a
  sibling `<file>.<8hex>.tmp`, then `renameSync` over the target. Readers and
  the watcher never see a half-written file; the watcher ignores `*.tmp`.
- **Per-file mutex** (`withFileLock`, file-mutex.server.ts): `navigator.locks`
  (Web Locks in Node) keyed by absolute path — in-process serialization of every
  read-modify-write. NOT cross-process.
- **`updateTaskFile(ref, mutate)`** (task-writer.server.ts:117-137): lock → read
  + tolerant parse → *stale-read repair* → mutate in place (or return
  replacement) → auto-bump `frontmatter.updatedAt` → serialize → atomic write →
  remember write. Throws notFound when the file is absent.
- **Stale-read repair** (VirtioFS/Docker Desktop hazard, :57-110): the process
  remembers the last content it wrote per path (bounded map, 500 entries). If a
  locked read returns different content AND the file's mtime has not advanced
  past our write time + 100 ms slack (i.e., no external writer), the remembered
  content is trusted over disk. Real external edits win via mtime.
  **Task files only** — `updateProjectFile` has no equivalent (see gaps).
- `createTaskFile` (409 on existing), `appendTimelineEvent` (unshift = prepend,
  optional frontmatter patch), `patchTaskFrontmatter`.
- **`allocateTaskKey`** (project-writer.server.ts:111-125): under the
  project.md lock — `max(nextTaskNumber, scan of existing <PREFIX>-<n> dirs)+…`,
  persists the bumped counter, returns `VIB-<n>`. Concurrent calls can never
  mint the same key; a stale/missing counter self-heals from the dir scan.
- **Mutations do not rely on the watcher**: every action layer writes the file
  then synchronously calls `rebuildPath(db, absPath)` itself ("write file →
  reproject") — e.g. task-actions.server.ts:330, operator-actions.server.ts:207,
  schedule.server.ts:56, github/pr-open.server.ts:317,
  github/github-reconciler.server.ts:337. The watcher is for EXTERNAL edits.

### 3.2 Diagnostics model (`app/schemas/file-diagnostics.ts`, `app/server/interpretation/`)

Every parse emits `FileDiagnostic { severity: info|warning|error, code, path?,
message, hardStop? }`. Readiness effect (diagnostics-policy.server.ts):
info → none; warning → floor `input_required`; error → floor
`inconsistency_risk_detected`; hardStop → floor `blocked`.
`deriveReadiness` (readiness-policy.server.ts:36-48) is THE only readiness
derivation: stored readiness is respected unless the diagnostic floor is worse
(never improves). `referenceDiagnostics` adds project-context checks — currently
only `reference.unknown_stage` (stage id not in project's stage list).
"accepted" is a display state = task sits in the project's last stage
(`isAcceptedDisplayState`).

### 3.3 File watching (`app/server/files/file-watch.service.server.ts`)

- `node:fs watch(projectsDir, { recursive: true, ignore })` — chokidar was
  removed in PR #84. Watches **only** `${dataRoot}/projects`.
- Filtering (`shouldIgnoreWatchPath` :66-74): dotfile path segments and `*.tmp`
  ignored; depth ≥4 ignored except exactly
  `projects/<slug>/tasks/<KEY>/task.md` — so task `workspace/` churn never
  triggers projection work.
- 250 ms trailing debounce per path (`WATCH_DEBOUNCE_MS`), separate timer maps
  for files and dirs. File events on `project.md`/`task.md` → `rebuildPath`.
  `rename` events additionally schedule a **directory reconcile** (E13,
  :145-196): a vanished `projects/<slug>` or `.../tasks` reconciles the whole
  project (project row + every projected task checked against disk); a vanished
  `.../tasks/<KEY>` reprojects that task (file gone → row removed); the projects
  ROOT vanishing reconciles every projected project. A null filename falls back
  to a root-dir reconcile.
- Error handling (E8/F10-08): any watcher error clears the global handle (so
  `/resources/health` reports the truth) and closes it; transient FS-pressure
  codes (EMFILE/ENFILE/ENOSPC/EPERM/EACCES) schedule ONE owned, cancellable,
  generation-guarded re-arm after 2 s — teardown can never be resurrected and a
  deleted root can't loop.
- HMR-safe singleton behind `Symbol.for("viberr.fileWatcher")`;
  `isFileWatcherAlive()` feeds the health route.

---

## 4. Projections (files → SQLite)

### 4.1 Rebuilder (`app/server/projections/rebuilder.server.ts`)

Single-file incremental (`rebuildPath` :518-547) routes on the store-relative
path (`projects/<slug>/project.md` / `projects/<slug>/tasks/<KEY>/task.md`;
everything else `ignored`). Errors are caught, logged, and recorded as
provenance `error` rows — a rebuild never throws to the watcher.

- **Content-hash short-circuit**: sha256 of file content vs the stored
  `content_hash`; unchanged files are not re-projected (and record no
  provenance). `force` bypasses.
- **`rebuildProjectFile`** (:157-275): absent file + existing row → delete row +
  its diagnostics, provenance `removed`, emit `project.removed`. Otherwise
  upsert `projects` (name, archived, repo, default_branch, task_prefix,
  description, stages/workflow/agents/credential-policy/guardrails as JSON,
  source_path, content_hash, parsed_at), replace `project_members`, replace
  `diagnostics` for the path, provenance `projected`, emit `project.updated`.
  Then **cascade**: when the project row was created or its hash changed,
  force-reproject every task of the project (stage-reference diagnostics,
  effective repo and member context are baked into task rows).
  `skipTaskCascade` suppresses this for the walk-based rescans.
- **`rebuildTaskFile`** (:287-507): absent + existing → delete
  `task_projections` + `task_events` + diagnostics rows, provenance `removed`,
  emit `task.removed`. Otherwise parse; add `referenceDiagnostics` (unknown
  stage); compute derived readiness (stored readiness is NULL in the row when a
  readiness-path diagnostic exists); upsert `task_projections`; wholesale
  replace `task_events` (position 0 = newest, actor snapshot denormalized as
  `actor_json`, unknown actors projected as `system` so their events stay
  visible); replace diagnostics; provenance `projected`; emit `task.updated`.
  Legacy shape note: the delivering engagement fills `specialist_json`, the
  supporting engagements fill `reviewers_json`.
- **`rebuildProject(db, slug)`** (:558-636) — SCOPED rescan (F20): reprojects
  one project.md + its task files, prunes only THAT project's vanished rows,
  provenance `rescan` (scope: "project"), emits
  `projection.rebuilt {scope:"project"}`. Backs the Board "Re-scan" action so a
  project-scoped gate has a project-scoped effect.
- **`rebuildAll`** (:641-736) — full walk over every project dir + task dir,
  prunes any projected row whose backing file is gone, provenance `rescan`,
  emits `projection.rebuilt {scope:"full", changed}`.

Wrappers:

- `rescanProjections` / `rescanProject` (rescan.server.ts) — audit-recording
  fronts (`projection.rescan`) for Home "Re-scan store" (org admin), the Board
  re-scan, `npm run rescan`, and the boot reconcile.
- `rebuildProjections` (rebuild.server.ts) — the recovery hammer: inside ONE
  transaction, DELETE task_events/diagnostics/task_projections/projects
  (project_members cascades), then `rebuildAll({force:true})`. Projection events
  raised inside are **buffered** via `collectProjectionEvents` and emitted only
  after commit — SSE can never observe a half-built or rolled-back projection.
  NOT dropped: users, sessions, notifications, audit_events, provenance, PATs,
  violations, agent_runs/run_log_lines, org resources.

### 4.2 SQLite tables (`db/migrations/0001_baseline.sql` + `0002`)

The baseline is a squashed pre-prod schema (old 13-migration chain collapsed).
**Never add columns to 0001** — the runner skips by filename; new migrations only.

File-derived (dropped + rebuilt by `rebuildProjections`):

| Table | Fed by | Notes |
|---|---|---|
| `projects` | rebuildProjectFile | one row per project.md; stages/workflow/agents/guardrails as `*_json`; `content_hash` powers the short-circuit |
| `project_members` | rebuildProjectFile | replaced wholesale per project; CHECK on the 4 roles |
| `task_projections` | rebuildTaskFile | one row per task.md; derived `readiness` + raw `stored_readiness`; `specialist_json`/`reviewers_json` derived from engagements; effective `repo` (task override else project default); `packet_json`, `recommendation_count`+`recommendation_kinds`, `schedules_json` (schedule-runner queries this, not files), `event_count`, `comment_count`, `diagnostic_count`, `board_rank` |
| `task_events` | rebuildTaskFile | replaced wholesale per task; `position` 0 = newest; `actor_kind` CHECK (human/agent/operator/system), `actor_ref`, denormalized `actor_json` render snapshot, `to_agent`, `evidence_json` |
| `diagnostics` | replaceDiagnostics on every (re)projection | per source_path; severity/code/path/message/hard_stop |

Projection bookkeeping (kept across rebuilds):

| Table | Fed by |
|---|---|
| `provenance` | recordProvenance — one row per acting rebuild (`projected`/`removed`/`error`) + one `rescan` summary row per rescan |
| `schema_migrations` | migration runner |

App-owned (never file-derived):

| Table | Fed by |
|---|---|
| `users` | app user store (`app/server/auth/user-store.server.ts`), seed-admin, oauth provisioning |
| `user`, `session`, `account`, `verification` | **better-auth** tables (migration Option B bridge — coexist with legacy `users`) |
| `notifications` | `createNotification` (§6) |
| `audit_events` | `recordAudit` (§7) |
| `user_prefs` | per-user key/value prefs (notification routing etc.) |
| `github_pats`, `project_github_credentials`, `github_connections` | PAT store (`app/server/secrets/pat-store.server.ts`, AES-GCM encrypted token) / org connections |
| `google_domain_allowlist` | org user admin |
| `scope_violations` | `openScopeViolation`/`resolveScopeViolation` (policy-violations.server.ts) via `app/server/github/scope-flag.server.ts` (reconciler + PAT validator); partial unique index = at most one OPEN row per (project, scope, task) |
| `org_knowledge_bases`, `org_mcp_servers`, `org_skills` | org resource catalog (`app/server/org/resources.server.ts`); kb/skills content lives on disk under `kb/` and `skills/` (store-files.server.ts scans/mutates the real folders) |
| `agent_runs` | run store (`app/server/runtimes/run-store.server.ts`); migration 0002 adds a partial unique index — at most ONE queued/running `kind='primary'` run per task (single-delivering-flight, 409 on race) |
| `run_log_lines` | run sink — DB projection of the canonical `.jsonl` under `runtimes/` |

### 4.3 Read models (`app/server/projections/*.server.ts`)

Pure queries over the tables (no mutations): `board-query` (board columns in
stage order, orphan bucket for unknown stages, sparse `boardRank` ordering with
key-number×1e6 default), `task-query` (detail + timeline + diagnostics; actor
render overlays the CURRENT users table so renames show immediately),
`activity-feed` (project stream over task_events + audit-log panel merging
scope_violations and a whitelisted subset of audit_events), `decisions` (THE
single source of "which open decisions require this user" — open packet or ≥1
pending recommendation on a non-terminal-stage task, member-scoped with the
narrow owner exception), `review-queue` (resolved review-stage tasks split by
acceptance readiness via `acceptanceBlockedReason` — note it re-reads task
FILES for in-review tasks), `agent-deployments` (engagements joined with live
agent_runs), `notifications`, `policy-violations`.

---

## 5. Events

### 5.1 In-process projection emitter (`app/server/events/projection-events.server.ts`)

`ProjectionEvent` union (:11-44) — compact facts only, never fat objects:

| Type | Emitted from |
|---|---|
| `task.updated` | rebuildTaskFile (:499) after every task (re)projection |
| `task.removed` | rebuildTaskFile (:311) when the file vanished |
| `project.updated` | rebuildProjectFile (:252) |
| `project.removed` | rebuildProjectFile (:173) |
| `projection.rebuilt {scope: full\|file\|project, changed}` | rebuildAll (:728, scope "full"), rebuildProject (:628, scope "project"); **scope "file" is declared but never emitted** |
| `notification.created {userId}` | createNotification (notifications.server.ts:89) |
| `notification.read {userId}` | markNotificationsRead / markAllNotificationsRead / markTaskPacketApprovalRead (per affected user) |
| `violation.updated {projectSlug, taskKey\|null}` | openScopeViolation / resolveScopeViolation (policy-violations.server.ts) |

Singleton `EventEmitter` behind `Symbol.for("viberr.projectionEvents")`.
`collectProjectionEvents(fn)` defers emission inside write transactions
(buffered, re-emitted after commit; discarded on throw) — used by
`rebuildProjections`.

### 5.2 Publisher bridge (`app/server/events/event-publisher.server.ts`)

`startEventPublisher()` (boot) subscribes the emitter and translates each
ProjectionEvent into the CONVENTIONS wire shape
`{ type, entityId, occurredAt, data }` + an `SseRoute`, zod-parsing against
`sseEventSchema` before publish (malformed = loud log, never on the wire).
`task.updated` is enriched with projected facts (stage, readiness) read back
from `task_projections`. Routing: task/project events → project(+task) scoped;
`projection.rebuilt` → broadcast; notification events → **user-targeted** (only
that user's `user`-scoped connections).

### 5.3 SSE wire contract (`app/schemas/sse-event.schema.ts`)

Event names: `task.updated, task.removed, project.updated, project.removed,
projection.rebuilt, notification.created, notification.read, violation.updated,
run.log-appended, run.state-changed, stream.open, stream.resync`.
`stream.open` (first message; carries head event id) and `stream.resync`
(Last-Event-ID predates the ring buffer / restart reset ids → client
revalidates once) are broker control events, never buffered.

**High-frequency runtime stream**: `run.log-appended {runId, threadId, seq}` and
`run.state-changed {…, state}` are published **straight to the broker** by
`app/server/runtimes/run-events.server.ts:12-58` (from the run sink/adapters) —
deliberately NOT through the projection emitter (that path implies a projection
rebuild per event). Payloads are reference-only; the logs consumer fetches
lines since `seq`.

### 5.4 Broker (`app/server/events/sse-broker.server.ts`)

- Per-connection scopes: `project:<slug>` | `task:<slug>/<key>` | `projects`
  (all-projects firehose) | `user` (`parseSseScope` :53-61).
- `routeMatchesConnection` (:79-102): userId-routed events require BOTH the
  matching user AND a `user` scope; broadcast hits everyone; project/task routes
  match `projects`, matching `project`, or matching `task` scopes.
- Ring buffer of last 256 events with a monotonic id; reconnect with
  `Last-Event-ID` replays missed events scope-filtered, or sends
  `stream.resync` when out of window. Heartbeat comment `: hb` every 25 s
  (unref'd). Any throwing write drops+closes that connection (backpressure-safe;
  slow clients can't block the publisher). HMR-safe global state; SIGINT/SIGTERM
  closes all connections then re-raises.

### 5.5 The stream route (`app/routes/resources.events.ts`)

`GET /resources/events?scope=…` (repeatable). Session-cookie auth; 401 JSON for
unauthenticated (EventSource can't render redirects), 400 on malformed/absent
scopes. **Authorization (D9)**: org admins subscribe to anything; non-admins get
the `projects` firehose EXPANDED into per-project scopes of their member
projects only, explicit project/task scopes kept only when a member, `user`
always passes; only-foreign-scopes → 403. Wire: a never-ending `ReadableStream`
Response, `Cache-Control: no-store, no-transform`, `X-Accel-Buffering: no`;
backpressure limit 1024 queued chunks — beyond it the write throws and the
broker drops the connection; aborts and stream cancel both close the broker
handle.

---

## 6. Notifications (`app/server/projections/notifications.server.ts`)

SQLite-owned per-user inbox rows (`notifications` table; kinds
`packet | approval | mention | quality | policy`, `ptype` input|blocked for
packet rows). **Single insert point** `createNotification`:

- Consults the recipient's routing prefs (`isNotifKindEnabled`) unless
  `bypassPrefs` (demo seed only); opt-out model — no pref / prefs error =
  deliver. Returns null when silenced.
- Emits `notification.created {userId}` (user-targeted SSE).
- Fan-out: `notifyTaskWatchers` (task-actions.server.ts:191-239) — project
  admins+maintainers + the task owner, minus the triggering user; @mention
  notifications at task-actions.server.ts:672.

Read state is **monotonic** (no mark-unread) and idempotent:
`markNotificationsRead(ids)`, `markAllNotificationsRead`, and
`markTaskPacketApprovalRead(project, task)` — the packet-resolution side effect
that marks that task's packet+approval rows read for EVERY user, one
`notification.read` per affected user. `listNotifications` joins live task
state: `waitingOnYou` is recomputed at read time from `decisionsRequiring`
(member-scoped; never a stored flag), and actor snapshots are overlaid with
current user identities. Unread badge = `countUnreadNotifications`.

## 7. Audit, logging, retention

### 7.1 Audit (`app/server/audit/audit-recorder.server.ts`)

`recordAudit(db, { action, actor {userId|null, label}, subjectKind?, subjectId?,
projectSlug?, taskKey?, details? })` → `audit_events` row (`evt_…` id). Rules:
details must be secret-free; failures are logged and swallowed (recording never
breaks the action). Actions are lowercase dot-separated facts. ~30 modules
record: auth (login, oauth, user-admin), org (users, connections, resources,
store files, gagents), projects (create, settings, policy, agent profiles),
tasks (task/operator/agent-toolkit actions, schedules, specialist runs),
secrets (PAT store/validator), projections (`projection.rescan`,
`projection.rebuild`), runtimes (run service/recovery). Coverage is enforced by
`app/server/audit/audit-coverage.server.test.ts`. Surfaced in the Activity
"audit log" panel through a whitelist mapping
(activity-feed.server.ts:113+, fallback template guarantees no raw JSON in UI).

### 7.2 Logging (`app/server/logging/logger.server.ts`)

Dependency-free JSON-lines logger to **stdout** (`{level, time, msg, …fields}`),
levels debug/info/warn/error, threshold `LOG_LEVEL` (default info in prod,
debug elsewhere). Must never import other server modules. Note: nothing writes
to `${DATA_ROOT}/logs/`.

### 7.3 Run logs

Canonical: append-only NDJSON at `runtimes/<backend>/<sessionOrRunId>.jsonl`
(run-store.server.ts:8-11). Projection: `agent_runs` + `run_log_lines` rows;
SSE fan-out via §5.3.

### 7.4 Retention (`app/server/db/retention.server.ts`, boot best-effort)

`run_log_lines` > 30 days deleted; `audit_events` > 90 days deleted;
`notifications` capped at newest 500 per user. Canonical files never touched.

---

## 8. End-to-end flows (cheat sheet)

- **In-app mutation**: action → RBAC (`requireAction`; archived = read-only) →
  `updateTaskFile` (lock, parse, mutate, bump updatedAt, atomic write) →
  `rebuildPath` → row upsert + `task.updated` → publisher → SSE → clients
  revalidate. Audit + notifications recorded by the action layer.
- **External edit** (human/agent edits task.md directly): fs event → 250 ms
  debounce → `rebuildPath` → same tail. Offline edits are caught by the boot
  rescan.
- **Task create**: `allocateTaskKey` (project.md counter, atomic) →
  `createTaskFile` → reproject task + project (counter changed).
- **Delivery/review**: delivering run produces a head → `nextWorkRevision`
  mints/keeps a revision → reviewer verdicts bind to `revisionId` →
  `deriveValidation` cache → acceptance gated by `acceptanceBlockedReason`.

---

## Suspicious / gaps

1. **`projection.rebuilt` scope `"file"` is declared but never emitted** —
   `app/server/events/projection-events.server.ts:28` and
   `app/schemas/sse-event.schema.ts:86` allow `"full" | "file" | "project"`, but
   the only emitters use `"project"` (rebuilder.server.ts:630) and `"full"`
   (rebuilder.server.ts:730). Dead enum member; clients handling `"file"` are
   handling an event that cannot occur.
2. **Stale doc comment claiming a seeded mock violation** —
   `app/server/projections/policy-violations.server.ts:25-26` says "Migration
   0005 seeds the mock's VIB-142 `pull_request:write` violation"; the squashed
   baseline explicitly removed that seed (`db/migrations/0001_baseline.sql:8`
   "minus the mock scope-violation the old 0005 seeded"). The comment describes
   behavior that no longer exists.
3. **Stale "(future) Phase-7 reconciler" comment** —
   `app/schemas/task-file.schema.ts:243-244` describes the `github` cache as
   mirrored by a *future* reconciler; the reconciler exists and writes it
   (`app/server/github/github-reconciler.server.ts:278`,
   `app/server/github/workspace-delivery.server.ts:380`).
4. **Stale-read repair is task-file-only** — the VirtioFS read-your-own-writes
   repair (task-writer.server.ts:57-110) has no counterpart in
   `project-writer.server.ts:50-64` (`updateProjectFile`) or `allocateTaskKey`
   (:111-125). The same Docker-Desktop stale-read window that erased a comment
   (VIB-1) applies to project.md read-modify-writes (member/agent/policy edits,
   the task-number counter): a stale read + write could resurrect old project
   state or, worst case, rewind `nextTaskNumber` (partially mitigated by the
   dir-scan fallback).
5. **`updateProjectFile` does not bump any timestamp** — project.md has no
   `updatedAt` field at all (project-file.schema.ts:168-189), so project-level
   change freshness is only observable via `projects.parsed_at` (projection
   time), unlike tasks. Inconsistent, possibly intentional.
6. **`cache/`, `auth/`, `logs/` data-root dirs are created but unused** —
   `file-store-root.server.ts:38-40` creates them at boot; no app code reads or
   writes them (logger writes stdout only). Reserved-or-dead; new contributors
   may assume file logging exists.
7. **Dual user-table worlds** — legacy `users` (app RBAC, org roles) and
   better-auth `user`/`session`/`account`/`verification` coexist in the same DB
   (`db/migrations/0001_baseline.sql:20-33` vs :286-289) per the in-progress
   Option-B bridge. Projections/audit/notifications all key on `users.id`
   (`u_…`); anything joining better-auth ids directly would silently mismatch.
   Known-in-progress, but a real trap for implementers.
8. **Legacy projection column names** — `task_projections.specialist_json` /
   `reviewers_json` (0001_baseline.sql:83-84) are derived views of the
   `engagements` model (rebuilder.server.ts:410-414); the `delivers` key rides
   along inside the JSON. Any consumer treating these as the source model (vs
   the file's `engagements`) diverges — e.g. `verdictCapable` is only visible in
   `reviewers_json` entries, not as a column.
9. **`env.server.ts` is not the complete env surface** — `VIBERR_CLAUDE_MAX_TURNS`
   (claude-runtime.server.ts:272), `VIBERR_CODEX_IDLE_TIMEOUT_MS`
   (codex-runtime.server.ts:173), `VIBERR_GIT_ASKPASS_*`
   (git-clone-auth.server.ts:5-6) and `LOG_LEVEL` (logger.server.ts:15) are read
   from raw `process.env`, bypassing the "fail fast with a clear message"
   contract and `.env.example` discoverability claims of env.server.ts:130.
10. **`review-queue` breaks the projection boundary** —
    `app/server/projections/review-queue.server.ts:4,79-80` re-reads task FILES
    (`readTaskFile`) inside a read model to compute `acceptanceBlockedReason`,
    because `workRevision`/`verdicts` are not projected into any
    `task_projections` column. Small set (in-review tasks only), but it's file
    I/O on a loader path and the only read model that does this; projecting a
    `validation_block_reason` (or the revision/verdict JSON) would remove it.
11. **Watcher `ignore` predicate + manual filter are redundant twins** —
    `file-watch.service.server.ts:204` re-runs `shouldIgnoreWatchPath` inside
    `onChange` even though the same predicate is passed as the `watch()` `ignore`
    option (:214). Harmless belt-and-braces (the option exists in Node 26's
    types), but if the two ever drift only one of them wins.
12. **`notifications.kind` CHECK vs code** — DB CHECK allows exactly
    `packet|approval|mention|quality|policy` (0001_baseline.sql:158); the
    TypeScript `NotificationKind` mirrors it by hand
    (app/shared/mapping/notification.server.ts:11). No single source; adding a
    kind requires a migration + type edit in lockstep or inserts throw at
    runtime.
13. **In-process-only concurrency primitives** — the file mutex
    (file-mutex.server.ts, `navigator.locks`) and the SSE broker/emitter
    singletons are per-process. A second server process on the same data root
    (or `npm run` scripts running alongside the server) gets no mutual
    exclusion beyond atomic rename; last-writer-wins on frontmatter merges.
    Fine for the single-node design, but nothing enforces single-node.
