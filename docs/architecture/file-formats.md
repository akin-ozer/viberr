# Canonical file formats (file-native store)

Decided and owned by Phase 3. Files under `${VIBERR_DATA_ROOT}` are the ONLY
canonical business truth for projects and tasks; SQLite holds projections.
Humans and agents may edit these files directly — the watcher (250 ms
debounce) and the manual rescan reconcile them into projections. The UI
always renders the REAL store-relative path (`projects/<slug>/tasks/<KEY>/task.md`),
never the mock's `.viberr/…` (orchestrator ruling 3).

*Updated 2026-09-02 for ruling 127 (branch `claude/per-user-codex-auth-difdnn`): the
data-root layout below. No canonical FILE FORMAT changed.*

Data-root layout (created at boot by `app/server/files/file-store-root.server.ts`):

```
${VIBERR_DATA_ROOT}/
  projects/<slug>/project.md              ← project truth
  projects/<slug>/tasks/<KEY>/task.md     ← task truth
  projects/<slug>/tasks/<KEY>/attachments/ ← agent-posted evidence files (canonical bytes,
                                             served member-only, not projected — R19-19,
                                             ruling 96)
  projects/<slug>/tasks/<KEY>/workspace/  ← git clones (deliverer + operator share
                                             <repo>/; each supporting run gets
                                             support/<profileId>/<repo>/). NOT canonical,
                                             not watched, not projected; reclaimed for
                                             terminal-stage tasks at boot and on every
                                             maintenance pass when no run is live
  projects/<slug>/goals/<id>.md           ← chained-goal truth (ruling 99)
  projects/<slug>/.repo-mirror/           ← bare per-repo mirror (ruling 87); a cache
  agents/profiles/<id>.md                 ← org-level agent profile templates
  agents/definitions/{operator,controller}.md ← shipped doctrine files
  runtimes/<backend>/<runId>.jsonl        ← raw NDJSON run logs (the truth for run logs)
  runtimes/users/<userId>/claude-home/    ← one person's own agent home (ruling 127): the
  runtimes/users/<userId>/codex-home/       vendor's sign-in file, which only the vendor
                                            binary reads, plus their provider sessions,
                                            which session export serves and transcript
                                            retention prunes; mode 0700
  kb/<dir>/  skills/<slug>/               ← knowledge-base and skill folders
  audit-exports/audit-events-<date>.jsonl ← rows exported before the 90-day audit purge
  state/projection.sqlite                 ← SQLite (never canonical for tasks)
  state/writer.lock  state/shipped-assets.json
```

`DATA_ROOT_SUBDIRS` creates nine of these at boot (`projects`, `agents`, `agents/profiles`,
`runtimes`, `runtimes/users`, `kb`, `skills`, `audit-exports`, `state`); the rest
appear when first written, including each person's own
`runtimes/users/<userId>/{claude-home,codex-home}` (created 0o700 by
`ensureUserBackendHome` the first time they connect a backend). *(Layout corrected
2026-09-02 for ruling 127, branch `claude/per-user-codex-auth-difdnn` — the shared
`runtimes/claude-home` and `runtimes/codex-home` are gone: a credential in a shared home
is a credential every run bills to whoever owns it.)* There is no `cache/`, `auth/` or `logs/` directory — they were
removed on purpose (P11-56); application logs are structured JSON on stdout, and the secrets
Viberr stores live encrypted in SQLite (the one exception is a vendor's own sign-in file
inside a person's runtime home above, which the vendor binary writes and Viberr never reads;
the container image additionally keeps `runtimes/uv-cache` and
`runtimes/uv-python` for Python MCP servers). *(Layout corrected 2026-09-01; the full table
with retention is in [`data-model.md`](data-model.md).)* Note that `state/projection.sqlite`
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
  - profileId: operator
    autonomy: supervised          # operator only: supervised | full (ruling 67)
    capabilities: []
  - profileId: developer
    capabilities:                 # id-based against the shared catalog (ruling 2)
      - capabilityId: create-task-branch
        mode: direct              # direct | recommend | human | off — specialists have
                                  # no recommend lane; a stored recommend reads as off
                                  # (ruling 81). Modes: CAPABILITY_MODES
    extras:                       # display-only bespoke labels (near-misses)
      - label: Push commits to the branch
        mode: human
credentialPolicy:                 # NON-secret policy; the PAT itself lives
  credentialLabel: viberr-bot · fine-grained PAT     # AES-encrypted in SQLite (Phase 7)
  masked: github_pat_••••42af
  requiredScopes: [repo, pull_request:write]   # the exact minimum (ruling 18);
                                  # `workflow` and `read:org` were dropped 2026-07-25
guardrails:                       # four defaults (shared/workflow/templates.ts):
                                  # meaningful-comment, no-duplicate-summary,
                                  # compression-threshold (value 40), evidence-separation;
                                  # delete-branch-after-merge is a fifth row whose
                                  # ABSENCE means on (ruling 24). The four defaults are
                                  # edited on Policy → Guardrails (ruling 112), the fifth
                                  # on Settings → GitHub
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
heldAtStage: null                 # durable deliberate-hold marker (V18): the
                                  # stage the operator held twice in a row on
                                  # purpose; while it names the CURRENT stage
                                  # the stranded backstop stays quiet. Cleared
                                  # by transitions, packet resolutions and
                                  # goal edits (not by manual operator runs)
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
recommendations: []               # pending operator recommendation cards; an
                                  # accept_completion card carries `forHeadSha`, the
                                  # work revision it binds to, and is withdrawn on the
                                  # record when that changes (ruling 137)
                                  # (ruling 137), the work revision it was
                                  # authored against, and is withdrawn on the
                                  # record when that revision changes
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
baseRefreshes: []                 # ruling 132: every base refresh the operator's
                                  # update_branch_from_base landed on the branch,
                                  # recorded as it is pushed: { mergeSha, baseSha,
                                  # base, commits, at }. A merge listed here is a
                                  # CLEAN merge Viberr made (that path aborts on
                                  # conflict), which is how the reconciler tells a
                                  # base refresh from authored drift. The refresh merges
                                  # with --no-ff, so mergeSha is always a two-parent
                                  # merge commit, never the base tip itself
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
  headSha: 60049586…              # ruling 135: the PR head as GitHub last reported
                                  # it (optional key; carried across a reuse of the
                                  # SAME number, never inherited by a different PR)
  revisionDrift:                  # ruling 132: AUTHORED commits since the reviewed
    headSha: 60049586…            # revision, with a base refresh reported apart —
    authored: 0                   # never as unreviewed work; describeRevisionDrift
    baseRefresh:                  # (app/shared/revision-drift.ts) is the ONE
      merges: 1                   # sentence every surface prints; null baseRefresh
      commits: 4                  # when the head carries none; merges: 0 = a
                                  # fast-forward refresh
  unpushedRevision:               # ruling 135: the DELIVERED revision is not on
    revisionSha: 385047c…         # the PR — behind (a plain push fast-forwards),
    prHeadSha: 60049586…          # diverged (a push is refused non-fast-forward)
    relation: unknown             # or unknown (GitHub does not have the sha at
                                  # all: never pushed). Written by the reconciler
                                  # and by the workspace reconcile the moment a run
                                  # mints a new revision on an open PR; cleared by
                                  # a delivery that pushes; never for `verified`
github:                           # more GitHub cache: commits + change stats
  commits: [{ sha: a91f7c2, msg: "[VIB-142] …" }]
  changed: { files: 9, add: 412, del: 87 }
priority: normal                  # R26-1: normal | high | urgent-ish metadata the OPERATOR
                                  # reads (advisory); never in the specialist prompt
labels: []                        # R26-2: free-text labels, searchable on the board and ⌘K
dueDate: null                     # R26-1: ISO date or null — advisory metadata
blockedBy:                        # ruling 131: what this task WAITS ON, in exactly
  - JC-6                          # two spellings (app/shared/dependencies.ts): a
  - goal-1 link 3                 # task key, or `<goal-id> link <n>`. Non-empty
                                  # floors the derived readiness at `blocked`,
                                  # settles `waiting: none`, refuses the operator's
                                  # create/transition/scheduled triggers, and is
                                  # cleared by the release engine when every entry
                                  # is done. States are resolved at read time,
                                  # never stored. Parsed per row. `GOAL` is a
                                  # reserved taskPrefix: `GOAL-1` would read as
                                  # a goal reference missing its link
acceptance: forced                # optional; N20-14 — set when an admin force-accepted
goalRef: null                     # ruling 99: { goalId, linkIndex } for a chained-goal task
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
are `ev`, `backend`, `profileId`, `deleteBranch` and, since pass 34 (ruling 138), `goalDraft` on
an `edit_goal` option.)*

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
awaiting: goal_edit               # only after an edit_goal confirm (ruling 138)
decided:                          # stamped beside `awaiting` (ruling 138)
  optionIndex: 0
  at: 2026-09-04T10:00:00.000Z
  byUserId: u_arda
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
  - kind: edit_goal
    t: Align the goal to the merged spec
    d: Why the goal should change.
    rec: false
    goalDraft: |                  # ruling 138: the proposed goal text itself,
      Deliverable: …              # written AS a goal; what the editor opens with.
      Acceptance: …               # Absent → the editor prefills t + d verbatim.
                                  # Refused on any other kind.
awaiting: goal_edit               # set when an edit_goal option was confirmed;
decided:                          # ruling 138: WHICH option, so a reload renders
  optionIndex: 2                  # the packet as decided (chosen option locked,
  at: 2026-07-04T07:00:00.000Z    # one "Edit the goal" control) and rebuilds the
  byUserId: u_abc123              # same draft; both clear with the packet
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
- **Fields the sample omits** (all in `taskFrontmatterSchema`, added here 2026-09-01):
  `priority` (`PRIORITY_VALUES`, default `normal`), `labels` (string list) and `dueDate`
  (ISO or null) — advisory metadata that reaches the operator only (R26-1) and is
  searchable on the board and in ⌘K; `acceptance: forced` when an admin force-accepted;
  `goalRef: { goalId, linkIndex }` back-reference to a chained goal; `engagements[].pinnedBackend`
  (set by a `retry_other_backend` resolution so the switch sticks, F27-B1); `pr.checks`,
  `pr.review`, `pr.mergeable`, `pr.headSha`, `pr.revisionDrift`, `pr.unpushedRevision`
  (reconciler cache, shown above); each `schedules[]`
  row carries `action` (`run-operator | run-agent`), `dueAt`, `profileId`, `prompt`,
  `status` (`SCHEDULE_STATUS_VALUES`), `claimedAt`, `firedAt`.
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
  (comments routed to the operator — `comment-card toagent` tint). An
  `attachments:` block (file names under `tasks/<KEY>/attachments/`) may follow
  the text of an agent event, like `evidence:` (ruling 96).
- Then a blank line and the event text (RichText micro-format: `**bold**`,
  `` `code` ``, `@mention`). Multi-line text is allowed.
- **Body-line escaping** (structure-like text): an event-body line whose raw
  form would read as file structure — starting with `## `, `### `,
  `title:<ws>`, `to:<ws>`, or a line that is only (whitespace and)
  `evidence:` or `attachments:` — is written with ONE leading backslash: `\## Notes`,
  `\### 2026-01-01T00:00:00Z · completion · operator`, `\title: x`,
  `\evidence:`. Lines that already start with backslashes in front of such a
  pattern gain one more on write. Readers strip exactly one backslash from
  any line matching `^\\+(## |### |title:\s|to:\s|\s*evidence:\s*$|\s*attachments:\s*$)` when
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
    blockedBy: []                 # ruling 131(c): what this link's task waits on
                                  # (task keys / `goal-2 link 1`); copied onto the
                                  # task the chain creates for the link, validated
                                  # then, so the task is born held
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
- The goal parser is **strict**, unlike the task and project parsers: any schema failure is
  a hard stop for that file (surfaced as a diagnostic), so hand edits must round-trip
  exactly. *(Noted 2026-09-01.)*

## 3. Actor references (contracts §3.1)

| Actor | File encoding | Render shape |
|---|---|---|
| Human | `user:<userId>` or `user:<userId> (Display Name)` | `{ kind:"human", userId, name, initials, tone, guest? }` — resolved from the users table at projection time; the parenthetical is a snapshot fallback for deleted users; `guest` derives from project membership |
| Agent | `agent:<backend>/<profileId>` e.g. `agent:codex/developer`, optionally with a role snapshot `agent:codex/developer (Implementation)` | `{ kind:"agent", backend, name:"Codex"\|"Claude", role }` — the second segment is the **profile id**, never a role slug, and the backend label is "Claude" (ruling 92). *(Corrected 2026-09-01.)* |
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
model: sonnet                     # ONE catalog id for the first backend (see
                                  # docs/domain/agents-and-runtime.md §2.3);
effort: high                      # optional reasoning effort (controller today, ruling 106;
                                  # specialists carry model+effort per deployment)
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

Unlike task and project files, unknown top-level keys in a profile raise a drift warning
and are **dropped** by the serializer (`AGENT_PROFILE_KNOWN_KEYS`). A `kind: controller`
profile is instance machinery: never deployed into a project's `agents:` list.

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
