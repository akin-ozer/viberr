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
  projects/<slug>/tasks/<KEY>/workspace/  ← primary + reviewer execution workspaces
  agents/profiles/<id>.md                 ← org-level agent profile templates
  kb/<dir>/                               ← knowledge-base files
  skills/<name>/SKILL.md                  ← skill files
  runtimes/                               ← NDJSON run logs + isolated SDK homes
  state/projection.sqlite                 ← projections + app-owned identity/secrets/audit/runtime state
  cache/  auth/  logs/
```

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
repo: akin-ozer/viberr            # default GitHub repo; tasks may override
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
    role: admin                   # admin | maintainer | contributor | viewer
agents:                           # per-project DEPLOYMENT of profile templates
  - profileId: developer
    capabilities:                 # id-based against CAP_CATALOG (ruling 2)
      - capabilityId: create-task-branch
        mode: direct              # direct | recommend | human | off
    definition:                   # optional per-project profile overrides
      model: gpt-5-codex
      resources:
        skills: [repo-write]
        mcps: [github]
        kb: [Architecture notes]
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
specialist:                       # primary specialist; null in triage
  profileId: developer
  backend: codex                  # codex | claude
  role: Developer                 # display
reviewers: []                     # 0..n, same shape as specialist
reviewerVerdicts: []              # latest real structured verdict per required reviewer
operator:                         # null in triage (ruling 16: store stage id;
  assignedAtStageId: triage       # UI renders "stage <1-based index>")
recommendations: []               # pending governed operator recommendations
urgent: true                      # optional; absent ≡ false
validation: changed               # healthy | changed | failing | none
branch: vib-142-attach-workspace  # task-key branch; null before creation
repo: null                        # per-task override; null → project default
pr:                               # GitHub projection mirrored into the file
  number: 318                     # (Phase 7 reconciler owns sync)
  state: review                   # review | accepted | merged | closed
  title: Attach execution workspace
github:                           # more GitHub cache: commits + change stats
  commits: [{ sha: a91f7c2, msg: "[VIB-142] …" }]
  changed: { files: 9, add: 412, del: 87 }
createdAt: 2026-07-03T06:00:00.000Z
updatedAt: 2026-07-04T06:58:00.000Z
boardRank: null                   # sparse within-stage board order
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
  - kind: accept_completion       # STABLE kind (ruling 7):
    t: Accept completion          #   accept_completion | request_edit |
    d: Mark task done …           #   block_on_policy | hold_runtime_debug |
    rec: true                     #   redirect | custom
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

### Timeline entry grammar (append contract for agents)

- Entries are NEWEST FIRST. To append an event, prepend a block directly
  under `## Timeline` (writers do this; external appenders that append at
  the bottom are tolerated — display sorts by timestamp and an
  `timeline.out_of_order` info diagnostic is recorded).
- Heading line: `### <UTC ISO> · <type> · <actor-ref>` — separator is
  `<space>·<space>` (U+00B7). `type` is one of the 9 contract types
  (`comment completion github policy quality transition blocked agent
  assign`); unknown types are kept and render as plain comments.
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

### Reviewer and completion invariants

- Each engaged reviewer has a stable, isolated checkout under
  `workspace/reviewer-<profileId>/<repo>/`; reviewers never share a mutable working tree.
- A real reviewer run must end with exactly one single-line
  `VIBERR_REVIEW_VERDICT: {"verdict":"approve|request_changes","summary":"..."}` marker.
  Ordinary prose and simulated runs never become governance state.
- `reviewerVerdicts` stores the latest real verdict per profile with `summary`, exact `runId`, and
  `reviewedAt`. Entering a new review evidence cycle invalidates prior verdicts. Every currently
  assigned reviewer must approve; any request-changes sends the task back to the work stage.
- Completion is accepted only from the governed Review stage with `validation: healthy`. A
  repository-backed task also requires a linked review PR. If acceptance cannot complete a real
  merge, it stays in Review with `pr.state: accepted`; only the later real merge moves it to Done.
  A healthy repo-less task may move directly to Done.
- Completion authority belongs project-wide to maintainers/admins, task-locally to a current
  contributor+ owner, and exceptionally to an audited organization-admin override. The override
  does not alter canonical membership.

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
  kb: [Viberr Core architecture, Coding standards]
---

Profile description (markdown body).
```

## 5. What is deliberately NOT in files

- Secrets (PATs, session data) — SQLite/env only, never under `projects/`.
- Notification rows, read state, sessions, users, audit — app-owned SQLite.
- GitHub PATs, MCP organization secrets/config metadata, backend-health observations, and automatic
  operator dispatches — app-owned SQLite/process state.
- Derived readiness — files store the canonical stored readiness; the
  effective value (after diagnostic floors) lives only in the projection.
  Completion acceptance while merge is pending is stored as `pr.state: accepted`; a Done-stage
  accepted/merged pill is otherwise derived display.
