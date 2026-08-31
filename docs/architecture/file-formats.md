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
                                             not watched, not projected. 11-16 MB per
                                             task; reclaimed at boot once the task
                                             reaches its terminal stage
  projects/<slug>/goals/<id>.md           ← chained-goal truth (ruling 99)
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
    role: admin                   # admin | maintainer | contributor | viewer
                                  # (strict tier; `reviewer` was renamed `contributor` —
                                  # ruling 2 amendment. Source of truth: app/shared/rbac.ts)
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
  requiredScopes: [repo, pull_request:write]   # the exact minimum (ruling 18);
                                  # `workflow` and `read:org` were dropped 2026-07-25
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
previousStageId: impl             # where the task CAME from (null until the
                                  # first transition) — the operator's agent
                                  # choice weighs it (ruling 98)
readiness: input_required         # canonical 4-value enum ONLY (ruling 1):
                                  # ready | input_required |
                                  # inconsistency_risk_detected | blocked
waiting: human                    # human | agent | none (secondary signal)
ownerUserId: u_abc123             # ONE human owner; null when unowned
engagements:                      # ONE uniform list of engaged agents (G1),
  - profileId: developer          # written by the DISPATCH since ruling 98 —
    backend: codex                # running an unengaged deployed profile
    role: Developer               # engages it (delivering iff no deliverer AND
    delivers: true                # repo-write; supporting otherwise). At most
    verdictCapable: false         # one entry has delivers: true — the
  - profileId: reviewer           # workspace/branch/PR owner. verdictCapable
    backend: claude               # is snapshotted from an EXPLICIT
    role: Review & validation     # report-validation-verdict:direct grant and
    delivers: false               # makes a supporting engagement a REQUIRED
    verdictCapable: true          # reviewer.
operator:                         # null in triage (ruling 16: store stage id;
  assignedAtStageId: triage       # UI renders "stage <1-based index>")
recommendations: []               # pending operator recommendation cards
schedules: []                     # pending/fired scheduled runs (O-3, ruling 98:
                                  # run-operator | run-agent; the agent arm pins
                                  # profileId + prompt, nothing else)
urgent: true                      # optional; absent ≡ false
validation: changed               # healthy | changed | failing | none | bypassed
                                  # (`bypassed` = a human force-accepted past the
                                  # verdict gate, N20-14) — DERIVED cache,
                                  # recomputed on every write. This list IS
                                  # VALIDATION_VALUES (task-file.schema.ts), and
                                  # task_projections' CHECK mirrors it (F21-1)
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
archived: false                   # R14-3: abandoned work, kept for the record —
                                  # leaves the board's default view and the review
                                  # queue, keeps its timeline, restorable
noChanges: true                   # optional; R17-2/R19-1 — this task completes
                                  # with NOTHING to deliver (see the note below)
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

`PACKET_OPTION_KINDS` in `app/schemas/task-file.schema.ts` is the source of truth for the
option kinds; the list below mirrors it. *(Corrected 2026-08-06, pass 19 — N19-3. This block
said "The 8 kinds" and omitted `archive_task`, which arrived with R14-3 (the task archive).
Updated 2026-08-15, pass 20 — F20-6/R20-2 added `discard_branch` (decisions.md ruling 7), so
the block that said "The 9 kinds" was itself the straggler. Updated 2026-08-31, pass 31 —
F31-6 added `resolve_remote_collision`, the branch-collision remedy (close the unowned PR,
delete the stale remote branch, re-deliver the local work). Eleven is the count today —
re-derive it from the schema rather than from here.)*

*(Corrected 2026-08-31, pass 31 — A3. The option sample below carried an `accept: true` field
annotated "acceptance path marker — human-only". `packetOptionSchema` has no such field:
acceptance is gated **solely** on `kind === "accept_completion"`, plus the admin|maintainer
re-check in `resolvePacket`. The schema is `.loose()`, so an `accept:` key copied out of this
doc would round-trip as an unknown field and be read by nothing — a silent no-op that looked
load-bearing. Beyond the four keys shown, the fields the schema actually defines on an option
are `ev`, `backend`, `profileId` and `deleteBranch`.)*

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
  - kind: accept_completion       # STABLE kind (ruling 7). The 11 kinds:
    t: Accept completion          #   accept_completion | request_edit |
    d: Mark task done …           #   block_on_policy | hold_runtime_debug |
    rec: true                     #   redirect | retry_other_backend |
                                  #   edit_goal | archive_task | discard_branch |
                                  #   resolve_remote_collision | custom
                                  # There is NO acceptance marker field: the
                                  # acceptance path is gated on the KIND alone.
                                  # Source of truth: PACKET_OPTION_KINDS in
                                  # app/schemas/task-file.schema.ts.
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
  generic-agents pass (2026-07-19), and the legacy-key ABSORPTION was deleted in the
  dynamic-dispatch rework (ruling 98, 2026-08-29 — preprod, no back-compat by owner
  ruling). A file still carrying those keys parses with whatever `engagements:` says
  (or none) and keeps the legacy keys verbatim as unknown fields; nothing reads them.
  Engagements are created by the dispatch itself — write `engagements` directly only
  when hand-authoring a required reviewer (`delivers: false, verdictCapable: true`).
- `validation`, `workRevision` and `verdicts` are a set. `validation` is a derived cache
  recomputed from the other two plus the required-reviewer set on every write; do not
  hand-edit it as a source of truth. A verdict names the `revisionId` it judged, so a new
  revision automatically staleness-expires every prior verdict.
- **`repo` is GONE from the task frontmatter.** The task-level repository override was
  struck by owner ruling on 2026-07-25 (P13-D-5): one project, one repository. *(Corrected
  2026-08-06, pass 19 — this note used to say the field was "vestigial and always null" and
  that "the read path still honours a non-null value". Neither is true: `repo` is not in
  `taskFrontmatterSchema` at all, and every `frontmatter.repo` read in the tree is on
  `project.md`.)* A `repo:` line in an existing `task.md` is now simply an UNKNOWN key —
  preserved verbatim on round-trip, ignored by every resolver. Do not hand-set it expecting
  an effect; there is none.
- **`noChanges` is the no-change completion flag** (R17-2, made reachable by R19-1). It marks
  a task that completes with nothing to deliver, turning acceptance's normal "deliver the
  branch & open the PR" refusal into the first-class "Completed — no changes" close. Two
  producers: a delivery attempt that found the branch empty, and a reviewer approving a task
  that never needed a branch at all. It is a claim about a moment that has passed, so it is
  re-verified against the live remote before any writer closes the task to Done — a branch
  that has since gained commits cannot ride a stale flag into Done. Cleared the moment a
  delivery opens a PR. Do not hand-set it.
- Unknown top-level frontmatter keys are preserved verbatim on write (the legacy
  engagement keys above are the deliberate exception).

### Timeline entry grammar (append contract for agents)

- Entries are NEWEST FIRST. To append an event, prepend a block directly
  under `## Timeline` (writers do this; external appenders that append at
  the bottom are tolerated — display sorts by timestamp and an
  `timeline.out_of_order` info diagnostic is recorded).
- Heading line: `### <UTC ISO> · <type> · <actor-ref>` — separator is
  `<space>·<space>` (U+00B7). `type` is one of the 11 contract types
  (`comment completion github policy note quality transition blocked agent
  assign continuity`); unknown types are kept and render as plain comments.
  `continuity` (added pass 18, G8; count corrected here 2026-08-06, pass 19,
  against `TIMELINE_EVENT_TYPES`) marks a runtime-continuity RESET — a resumed
  session whose provider transcript was gone, so the agent re-anchored on
  `task.md` in a fresh one. It is warning-toned on purpose: nothing was violated
  (not `policy`) and nothing is stuck (not `blocked`), but a supervisor scanning
  the board must get a cue that context was lost and recovered.
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

## 2b. `projects/<slug>/goals/<goal-id>.md` (chained goals — ruling 99)

Frontmatter + `## Description` (the outcome, prose) + `## Timeline` (history
bullets, newest first: `- <UTC ISO> · <text>`).

```markdown
---
id: goal-1
title: Ship the billing revamp
status: active                    # active | paused | attention | completed | cancelled
createdBy: u_abc123               # the authority chain advancement re-proves
createdByLabel: arda@viberr.dev
onFailure: pause                  # pause (default) | continue
links:
  - index: 1                      # 1-based chain position
    title: Extract billing interfaces
    goal: Deliverable + done signal (becomes the created task's ## Goal)
    taskKey: VIB-12               # null until the chain reaches this link
    status: done                  # pending | active | done | failed | skipped
    note: null                    # failure reason / redirect note
createdAt: 2026-08-30T10:00:00.000Z
updatedAt: 2026-08-30T12:00:00.000Z
---
```

Notes:

- The chain file owns the ordered list; each member task carries the tolerant
  back-reference `goalRef: {goalId, linkIndex}` in its own frontmatter (the
  project→task shape: project.md owns stages, task.md carries `stage`).
- Link statuses are the advance engine's claims; `goal_projections` re-derives
  each linked task's real state from task rows on rebuild, so an out-of-band
  task move cannot leave the chain lying.
- Goal files are app-written and never deleted by the product; terminal chains
  stay readable. `goals/*.md` is watched and projected like every canonical file.

## 3. Actor references (contracts §3.1)

| Actor | File encoding | Render shape |
|---|---|---|
| Human | `user:<userId>` or `user:<userId> (Display Name)` | `{ kind:"human", userId, name, initials, tone, guest? }` — resolved from the users table at projection time; the parenthetical is a snapshot fallback for deleted users; `guest` derives from project membership |
| Agent | `agent:<backend>/<role-slug>` e.g. `agent:codex/developer` | `{ kind:"agent", backend, name:"Codex"\|"Claude Code", role }` |
| Operator | `operator` | `{ kind:"agent", name:"Operator" }` (NO backend, NO role) |
| Controller | `controller` | `{ kind:"agent", name:"Controller" }` (ruling 99 — instance machinery, same backend-less shape) |
| System | `system:<id>` e.g. `system:policy-engine` | `{ kind:"system", name:"Policy engine" }` |

## 4. `agents/profiles/<id>.md` (org templates)

```markdown
---
id: developer
kind: specialist                  # operator | specialist | controller (ruling 99)
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
