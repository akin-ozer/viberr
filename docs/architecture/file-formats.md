# Canonical file formats (file-native store)

Decided and owned by Phase 3. Files under `${VIBERR_DATA_ROOT}` are the ONLY
canonical business truth for projects and tasks; SQLite holds projections.
Humans and agents may edit these files directly — the watcher (250 ms
debounce) and the manual rescan reconcile them into projections. The UI
always renders the REAL store-relative path (`projects/<slug>/tasks/<KEY>/task.md`),
never the mock's `.viberr/…` (orchestrator ruling 3).

Data-root layout (created at boot by `app/server/files/file-store-root.server.ts`):

```
${VIBERR_DATA_ROOT}/
  projects/<slug>/project.md              ← project truth
  projects/<slug>/tasks/<KEY>/task.md     ← task truth (+ attachments/ later)
  projects/<slug>/tasks/<KEY>/workspace/  ← the agent's git clone; NOT canonical,
                                             not watched, not projected
  agents/profiles/<id>.md                 ← org-level agent profile templates
  runtimes/claude-home/ runtimes/codex-home/
                                          ← NDJSON run logs + SDK session homes
  kb/<dir>/  skills/<slug>/               ← knowledge-base and skill folders
  state/projection.sqlite                 ← SQLite (never canonical for tasks)
```

That is the complete set `DATA_ROOT_SUBDIRS` creates. There is no `cache/`, `auth/` or
`logs/` directory — they were removed on purpose (P11-56); application logs are structured
JSON on stdout, and secrets live encrypted in SQLite. Note that `state/projection.sqlite`
is *never canonical for tasks*, but it **is** primary storage for users, sessions, PATs,
audit and notifications; see
[`docs/operations/deployment.md`](../operations/deployment.md#persistence-backup--restore).

General rules for both file kinds:

- **Frontmatter** is YAML between `---` fences; UTF-8; timestamps are UTC
  ISO 8601 strings. Unknown frontmatter fields are ALWAYS preserved by the
  writers (round-trip safe for future/foreign fields).
- **Tolerant parsing** (`app/schemas/*.schema.ts`): missing/invalid fields
  produce structured diagnostics + safe fallbacks. Parsing never throws and
  never drops an entity. Diagnostics floor readiness (warning →
  `input_required`, error → `inconsistency_risk_detected`, hard stop →
  `blocked`) — see `app/server/interpretation/`.
- **Atomic writes**: writers stage to `<file>.<rand>.tmp` and rename; the
  watcher ignores dotfiles and `*.tmp`. All writer mutations run under a
  per-file in-process mutex.

---

## 1. `projects/<slug>/project.md`

Frontmatter (all governed project state) + markdown body (description).

```markdown
---
name: Viberr Core
slug: viberr-core
repo: akin-ozer/viberr            # THE project's GitHub repo (one per project)
defaultBranch: main
taskPrefix: VIB                   # task keys: VIB-142
nextTaskNumber: 169               # atomic per-project key counter
stages:                           # per-project, ordered (ruling 15)
  - id: triage
    name: Triage
    color: "#a5a8b5"              # hex or var(--*) both accepted
  # … ready / impl / review / done
workflow:                         # governed boundaries: auto|approval|human
  - from: triage
    to: ready
    boundary: approval
    by: Human, after the quality gate — agents may flag underspecified tasks
    locked: false
  - from: review
    to: done
    boundary: human               # locked human in V1, server-enforced
    locked: true
members:                          # project roles (4-role system, contracts §3.2)
  - userId: u_abc123
    role: admin                   # admin | maintainer | reviewer | viewer
agents:                           # per-project DEPLOYMENT of profile templates
  - profileId: developer
    capabilities:                 # id-based against CAP_CATALOG (ruling 2)
      - capabilityId: create-task-branch
        mode: direct              # direct | recommend | human
    extras:                       # display-only bespoke labels (near-misses)
      - label: Push commits to the branch
        mode: human
credentialPolicy:                 # NON-secret policy; the PAT itself lives
  credentialLabel: viberr-bot · fine-grained PAT     # AES-encrypted in SQLite (Phase 7)
  masked: github_pat_••••42af
  requiredScopes: [repo, workflow, read:org, pull_request:write]
guardrails:
  - id: compression-threshold
    desc: Long timelines compress once routine events pass the threshold; typed events are always kept.
    on: true
    value: 40
    unit: events
---

Project description prose (markdown body).
```

Notes:

- `nextTaskNumber` backs `allocateTaskKey` (project-writer): the counter is
  read+bumped under the project.md mutex; a max-scan of existing
  `tasks/<PREFIX>-<n>` directories rescues a stale/missing counter. Concurrent
  creates can never mint the same key.
- Membership is authoritative here (files are truth); `project_members` in
  SQLite is its projection. Guest detection (the "app user · not in project"
  pill) derives from this list at projection time.
- **Two-layer agent model**: `agents/profiles/<id>.md` are ORG templates
  (backends, eligible stages, base capability policy, resources, description
  body). A project's `agents:` list *deploys* templates by `profileId` and
  carries the project-effective capability policy (may override the
  template). Task assignments store `profileId` — never joined by role text.
- The three always-human capabilities (`merge-pull-request`,
  `transition-to-done`, `change-project-policy`) are a server invariant list
  (`ALWAYS_HUMAN_CAPABILITY_IDS` in `app/shared/capabilities.ts`) — stored
  modes can never grant them to agents.

## 2. `projects/<slug>/tasks/<KEY>/task.md`

Frontmatter (scalar task state) + three body sections: `## Goal`,
`## Packet` (only while a decision packet is open), `## Timeline`.
Unknown `## Sections` are preserved verbatim.

````markdown
---
key: VIB-142
title: Attach execution workspace to task runtime
stage: review                     # id into the project's stage list
readiness: input_required         # canonical 4-value enum ONLY (ruling 1):
                                  # ready | input_required |
                                  # inconsistency_risk_detected | blocked
waiting: human                    # human | agent | none (secondary signal)
ownerUserId: u_abc123             # ONE human owner; null when unowned
engagements:                      # ONE uniform list of engaged agents (G1).
  - profileId: developer          # At most one entry has delivers: true — that
    backend: codex                # is the workspace/branch/PR owner.
    role: Developer               # display snapshot, taken at engage time
    delivers: true
    verdictCapable: false
  - profileId: reviewer           # a supporting engagement; verdictCapable is
    backend: claude               # snapshotted from an EXPLICIT
    role: Review & validation     # report-validation-verdict:direct grant, and
    delivers: false               # makes this a REQUIRED reviewer
    verdictCapable: true
operator:                         # null in triage (ruling 16: store stage id;
  assignedAtStageId: triage       # UI renders "stage <1-based index>")
recommendations: []               # pending operator recommendation cards
schedules: []                     # pending/fired scheduled operator re-runs (O-3)
urgent: true                      # optional; absent ≡ false
validation: changed               # healthy | changed | failing | none — DERIVED
                                  # cache, recomputed on every write
workRevision:                     # the immutable revision under review, or null
  id: rev_9f2c
  headSha: a91f7c2e…              # full SHA
  treeSha: 4d81b0a…               # null when git could not resolve it
  branch: vib-142-attach-workspace
  createdAt: 2026-07-04T06:41:00.000Z
  sourceProfileId: developer
verdicts:                         # per-engagement, each bound to a revision
  - profileId: reviewer
    revisionId: rev_9f2c
    headSha: a91f7c2e…
    result: approve               # approve | request_changes
    reason: Scope matches the goal.
    at: 2026-07-04T06:52:00.000Z
branch: vib-142-attach-workspace  # task-key branch; null before creation
repo: null                        # always null — see the note below
pr:                               # GitHub projection mirrored into the file
  number: 318                     # (Phase 7 reconciler owns sync)
  state: review
  title: Attach execution workspace
github:                           # more GitHub cache: commits + change stats
  commits: [{ sha: a91f7c2, msg: "[VIB-142] …" }]
  changed: { files: 9, add: 412, del: 87 }
createdAt: 2026-07-03T06:00:00.000Z
updatedAt: 2026-07-04T06:58:00.000Z
boardRank: 300                    # sparse rank for drag-to-reorder; null falls
                                  # back to the task-key number
---

## Goal

One-paragraph goal statement (prose).

## Packet

```yaml
type: input                       # input | blocked (card tint)
kind: Completion report           # pill label
from: operator                    # actor ref (see §3)
title: Accept completion, or send back for one fix?
body: Plain paragraph.
observations:
  - k: Changed                    # Observed|Changed|Validation|Branch|Flag (open set)
    v: 9 files · +412 / −87
    code: true                    # true → render v as <code>
options:
  - kind: accept_completion       # STABLE kind (ruling 7). The 8 kinds:
    t: Accept completion          #   accept_completion | request_edit |
    d: Mark task done …           #   block_on_policy | hold_runtime_debug |
    rec: true                     #   redirect | retry_other_backend |
    accept: true                  #   edit_goal | custom
                                  # (acceptance path marker — human-only)
  - kind: request_edit
    t: Request one edit
    d: …
    rec: false
    ev: "**Decision:** request one edit. …"   # pre-authored timeline copy
```

## Timeline

### 2026-07-04T06:58:00.000Z · comment · user:u_abc123 (Arda Kaya)
to: agent

@operator if the PAT scope is the only blocker, let's widen it rather than block the whole task.

### 2026-07-04T06:41:00.000Z · completion · agent:codex/developer
title: Completion report

Implemented repo attach, branch creation, and PR-sync projection.

evidence:
- unit/policy_gate_test · +14 · 0
- integration/pr_sync_test · +38 · −4
````

Notes:

- **`engagements` replaced `specialist:` / `reviewers:` / `consultants:`** in the
  generic-agents pass (2026-07-19). There is now one uniform list; the delivering
  engagement is the entry with `delivers: true`, not a separate slot. The parser still
  absorbs the legacy keys — a file carrying `specialist:` + `consultants:` migrates on the
  next write, and the legacy keys are dropped rather than preserved as unknown fields. An
  explicit `engagements:` always wins over them.
  **Watch the migration cost:** a legacy entry migrates with `verdictCapable: false`,
  because verdict capability is a snapshot of an explicit
  `report-validation-verdict: direct` grant, and the legacy shape never carried one. A
  hand-written `consultants:` reviewer therefore comes across as a supporting engagement
  that is *not* a required reviewer — acceptance will not wait for it, silently. Write
  `engagements` directly if you mean a required reviewer.
- `validation`, `workRevision` and `verdicts` are a set. `validation` is a derived cache
  recomputed from the other two plus the required-reviewer set on every write; do not
  hand-edit it as a source of truth. A verdict names the `revisionId` it judged, so a new
  revision automatically staleness-expires every prior verdict.
- **`repo` is vestigial and always `null`.** The task-level repository override was
  struck by owner ruling on 2026-07-25: one project, one repository. The read path still
  honours a non-null value, but nothing in the product ever writes one and no UI offers
  it. Do not hand-set it — a task pointing at a different repository still authenticates
  with the *project's* credential, so a cross-owner value fails authentication with no
  useful diagnosis, and such a task is never reconciled by the background poller.
- Unknown top-level frontmatter keys are preserved verbatim on write (the legacy
  engagement keys above are the deliberate exception).

### Timeline entry grammar (append contract for agents)

- Entries are NEWEST FIRST. To append an event, prepend a block directly
  under `## Timeline` (writers do this; external appenders that append at
  the bottom are tolerated — display sorts by timestamp and an
  `timeline.out_of_order` info diagnostic is recorded).
- Heading line: `### <UTC ISO> · <type> · <actor-ref>` — separator is
  `<space>·<space>` (U+00B7). `type` is one of the 10 contract types
  (`comment completion github policy note quality transition blocked agent
  assign`); unknown types are kept and render as plain comments.
  `note` was split out of `policy` in pass 13 (P13-LV-03): `policy` is now
  reserved for genuine governance violations and refusals, which render with a
  coral shield, and every neutral system remark — a goal edit, a divergence
  note, a scheduled re-run — is a `note`. Do not emit `policy` for anything a
  human would not read as a violation.
- Optional metadata lines immediately after the heading (before the first
  blank line): `title: <text>` (completion events) and `to: agent`
  (comments routed to the operator — `comment-card toagent` tint).
- Then a blank line and the event text (RichText micro-format: `**bold**`,
  `` `code` ``, `@mention`). Multi-line text is allowed.
- **Body-line escaping** (structure-like text): an event-body line whose raw
  form would read as file structure — starting with `## `, `### `,
  `title:<ws>`, `to:<ws>`, or a line that is only (whitespace and)
  `evidence:` — is written with ONE leading backslash: `\## Notes`,
  `\### 2026-01-01T00:00:00Z · completion · operator`, `\title: x`,
  `\evidence:`. Lines that already start with backslashes in front of such a
  pattern gain one more on write. Readers strip exactly one backslash from
  any line matching `^\\+(## |### |title:\s|to:\s|\s*evidence:\s*$)` when
  reconstructing the text; all other lines (including `\` before
  non-structural text) pass through verbatim. The mapping is bijective, so
  round-trips stay byte-stable, and free text (including fenced code blocks
  quoting headings) can never split sections, forge timeline events, or
  override the real `## Packet`. External appenders MUST apply the same
  escape to body lines they write.
- **Duplicate known sections**: if `## Goal`, `## Packet` or `## Timeline`
  appears more than once, the FIRST occurrence wins (never last-wins); each
  duplicate is preserved verbatim as an unrecognized extra section and
  flagged with a `body.duplicate_section` warning diagnostic (floors
  readiness at `input_required`).
- Optional evidence block (completion events): a line containing exactly
  `evidence:` followed by `- <label> · <add> · <del>` rows; add/del are the
  signed display strings (`+14`, `0`, `−4` with U+2212).
- Malformed entries are skipped with a warning diagnostic (readiness floors
  at `input_required`) — the task itself is never dropped.

## 3. Actor references (contracts §3.1)

| Actor | File encoding | Render shape |
|---|---|---|
| Human | `user:<userId>` or `user:<userId> (Display Name)` | `{ kind:"human", userId, name, initials, tone, guest? }` — resolved from the users table at projection time; the parenthetical is a snapshot fallback for deleted users; `guest` derives from project membership |
| Agent | `agent:<backend>/<role-slug>` e.g. `agent:codex/developer` | `{ kind:"agent", backend, name:"Codex"\|"Claude Code", role }` |
| Operator | `operator` | `{ kind:"agent", name:"Operator" }` (NO backend, NO role) |
| System | `system:<id>` e.g. `system:policy-engine` | `{ kind:"system", name:"Policy engine" }` |

## 4. `agents/profiles/<id>.md` (org templates)

```markdown
---
id: developer
kind: specialist                  # operator | specialist
name: Developer
role: Implementation
desc: Implements the change on the task branch and reports what it did.
                                  # one scannable paragraph — what the OPERATOR
                                  # reads when picking a profile. Distinct from
                                  # the markdown body (the long persona).
icon: branch                      # ui.jsx Icon name
backends: [codex, claude]
model: codex-large · claude-sonnet
scope: Global base · customized for Viberr Core
stages: [ready, impl]             # eligible stages
spanAll: false                    # operator only
capabilities:                     # same id-based shape as project deployments
  - { capabilityId: create-task-branch, mode: direct }
extras: []
resources:
  skills: [repo-write, test-runner, lint-autofix]
  mcps: [github, filesystem]
  kb: [viberr-core-architecture, coding-standards]
---

Profile description (markdown body).
```

Every value in `resources:` is a **store folder name, never a display name**. For
`skills:` and `mcps:` the slug *is* the folder, so the two coincide. For `kb:` they do
not: a knowledge base has a display name and a directory as separate columns, and the
grant resolves against `${VIBERR_DATA_ROOT}/kb/<dir>`. A `kb:` entry written as the
display name resolves to nothing — `readKbBody` returns an empty string with only a
`logger.warn`, so the run proceeds *without* the knowledge base while every UI still shows
it attached. Use the directory. (Renaming a KB's directory orphans existing grants for the
same reason; re-attach them.)

## 5. What is deliberately NOT in files

- Secrets (PATs, session data) — SQLite/env only, never under `projects/`.
- Notification rows, read state, sessions, users, audit — app-owned SQLite.
- Derived readiness — files store the canonical stored readiness; the
  effective value (after diagnostic floors) lives only in the projection.
  The "accepted" pill is a display state of done-stage tasks, never stored.
