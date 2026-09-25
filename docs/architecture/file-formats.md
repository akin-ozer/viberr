# Canonical file formats (file-native store)

The markdown files under `${VIBERR_DATA_ROOT}` that Viberr treats as canonical business truth,
field by field: `project.md`, `task.md` (frontmatter, packet and timeline grammar), goal
files, agent profile templates and the smaller files beside them. SQLite holds projections of
them; [data-model.md](data-model.md) has the tables and the full data-root layout.
Source of truth: `app/schemas/project-file.schema.ts`, `app/schemas/task-file.schema.ts`,
`app/schemas/goal-file.schema.ts`, `app/server/files/agent-profile-file.server.ts` (schemas);
`app/server/files/task-file.server.ts`, `frontmatter.server.ts`, `project-writer.server.ts`,
`task-writer.server.ts`, `goal-writer.server.ts`, `actor-ref.server.ts` (parsers and writers).
Verified against `main` @ `7d9fbf72` (2026-09-23).

Humans and agents may edit these files directly. The watcher (250 ms debounce) and the manual
rescan reconcile them into projections. The UI always renders the REAL store-relative path
(`projects/<slug>/tasks/<KEY>/task.md`), never the mock's `.viberr/…` (orchestrator ruling 3).

Data-root layout (the nine `DATA_ROOT_SUBDIRS` are created at boot by
`app/server/files/file-store-root.server.ts`, the rest when first written; the full list is
[data-model.md §2](data-model.md#2-data-root-layout)):

```
${VIBERR_DATA_ROOT}/
  projects/<slug>/project.md              ← project truth
  projects/<slug>/tasks/<KEY>/task.md     ← task truth
  projects/<slug>/tasks/<KEY>/attachments/ ← files agents save and people upload on the task
                                             (canonical bytes, served member-only, not
                                             projected; ruling 96, ruling 379)
  projects/<slug>/tasks/<KEY>/workspace/  ← git clones (deliverer + operator share
                                             <repo-name>/; each supporting run gets
                                             support/<profileId>/<repo-name>/). NOT canonical,
                                             not watched, not projected; reclaimed for
                                             terminal-stage tasks at boot and on
                                             maintenance passes when no run is live
  projects/<slug>/goals/<id>.md           ← chained-goal truth (ruling 99)
  projects/<slug>/.repo-mirror/           ← bare per-repo mirror (ruling 87); a cache
  agents/profiles/<id>.md                 ← org-level agent profile templates
  agents/definitions/{operator,controller}.md ← shipped doctrine files
  agents/controller-requests.md           ← the controller's resource requests (ruling 390)
  runtimes/<backend>/<runId>.jsonl        ← raw NDJSON run logs (the truth for run logs)
  runtimes/users/<userId>/claude-home/    ← one person's own agent home (ruling 127): the
  runtimes/users/<userId>/codex-home/       vendor's sign-in file, which only the vendor
                                            binary reads, plus their provider sessions,
                                            which session export serves and transcript
                                            retention prunes; mode 0700
  kb/<dir>/  skills/<name>/SKILL.md       ← knowledge-base and skill folders
  audit-exports/audit-events-<date>.jsonl ← rows exported before the 90-day audit purge
  state/projection.sqlite                 ← SQLite (never canonical for tasks)
  state/writer.lock  state/shipped-assets.json
```

There is no `cache/`, `auth/` or `logs/` directory (P11-56). Application logs are structured
JSON on stdout, and the secrets Viberr stores live sealed in SQLite. The one exception is a
vendor's own sign-in file inside a person's runtime home, which the vendor binary writes and
Viberr never reads. `state/projection.sqlite` is *never canonical for tasks*, but it **is**
primary storage for users, sessions, PATs, audit and notifications; see
[`docs/operations/deployment.md`](../operations/deployment.md#persistence-backup--restore).

General rules for the canonical files:

- **Frontmatter** is YAML between `---` fences; UTF-8; timestamps are UTC ISO 8601 strings.
  A leading BOM is dropped and CRLF / lone CR line endings are read as LF. Unknown
  frontmatter fields are ALWAYS preserved by the writers of `project.md`, `task.md` and goal
  files (round-trip safe for future/foreign fields).
- **YAML output** (`toYaml`) never folds lines, and double-quotes any string a YAML 1.1 reader
  would take for a boolean (`mode: "off"`, `"yes"`), so other tools read the same value.
- **Tolerant parsing** (`app/schemas/*.schema.ts`): missing/invalid fields produce structured
  diagnostics + safe fallbacks, and list fields parse one row at a time (a bad row drops only
  itself, with an indexed diagnostic). `project.md` and `task.md` share one set of these readers
  (`app/schemas/file-diagnostics.ts`), and a field that falls back names the value it used:
  ``Frontmatter field `readiness` is missing; using "ready".`` (ruling 458(h)). Parsing never
  throws and never drops a task or project.
  Diagnostics floor readiness (warning → `input_required`, error →
  `inconsistency_risk_detected`, hard stop → `blocked`) — see
  `app/server/interpretation/diagnostics-policy.server.ts`. Goal files and agent profiles are
  the stricter exceptions (§2b, §4).
- **Write guard**: a hard stop means the file's own fields could not be read at all (no
  frontmatter, an unterminated fence, unparseable YAML, frontmatter that is not a mapping).
  The project and task writers refuse to rewrite such a file (409 `FILE_NOT_TRUSTED`), because
  a read-modify-write would serialize the defaults over it; `npm run store:check` names the
  line. The goal writer likewise refuses to change a goal file it cannot parse.
- **Atomic writes**: writers stage to `<file>.<rand>.tmp` and rename; the watcher ignores
  dot-prefixed paths and `*.tmp`. All writer mutations run under a per-file in-process mutex.

---

## 1. `projects/<slug>/project.md`

Frontmatter (all governed project state) + markdown body (description).

```markdown
---
name: Viberr Core
slug: viberr-core                 # must match the directory; the directory name wins
archived: true                    # optional; only an archived project carries the key
repo: akin-ozer/viberr            # THE project's GitHub repo (one per project)
defaultBranch: main
taskPrefix: VIB                   # letters only; task keys: VIB-142. `GOAL` is reserved
nextTaskNumber: 169               # atomic per-project key counter
stages:                           # per-project, ordered (ruling 15)
  - id: triage
    name: Triage
    color: slate                  # one of twenty preset names (ruling 364); absent = slate
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
    capabilities: []
    definition:                   # optional per-field override of the template
      autonomy: supervised        # operator only: supervised | full (ruling 67)
  - profileId: developer
    capabilities:                 # id-based against the shared catalog (ruling 2)
      - capabilityId: create-task-branch
        mode: direct              # direct | recommend | human | off — specialists have
                                  # no recommend lane; a stored recommend reads as off
                                  # (ruling 81). Modes: CAPABILITY_MODES
    extras:                       # display-only bespoke labels (near-misses)
      - label: Push commits to the branch
        mode: human
    definition:                   # kind, name, role, icon, backends, model, effort,
      model: sonnet               # scope, desc, persona, stages, spanAll, autonomy,
      effort: high                # resources — each optional, template wins when absent
      resources:                  # ruling 156: the deploy-time COPY of the template's
        skills: [developer-expertise]  # grants; a run mounts this copy
        mcps: []
        kb: []
credentialPolicy:                 # NON-secret policy; the PAT itself lives
  credentialLabel: viberr-bot · fine-grained PAT     # sealed in SQLite
  masked: github_pat_••••42af
  requiredScopes: [repo, pull_request:write]   # the exact minimum (ruling 18)
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
requiredReviewers:                # ruling 178: reviewers the project REQUIRES per review
                                  # stage — a non-terminal stage id and a deployed
                                  # verdict-capable profile id; `[]` (the default) means
                                  # only the reviewers an operator engages are required.
                                  # Edited on Settings → Required reviewers or by the
                                  # controller's set_required_reviewers; read on Policy.
  - stageId: review
    profileId: reviewer
rulingsKb: viberr-rulings         # ruling 239: the project's rulings knowledge base, by
                                  # store directory, or null. Every agent run on the
                                  # project reads it, and the controller while scoped here
fileLeases:                       # ruling 245: which TASK owns which shared paths
                                  # until it merges — the ordering statement
                                  # `blockedBy` cannot make (`blockedBy` says "do not
                                  # START until done"). Enforced at DELIVERY: another
                                  # task whose branch changes a leased path is refused
                                  # before anything reaches GitHub, and every run's
                                  # canonical anchor names what it may not touch.
                                  # Globs: `*` within one segment, `**` spans segments
                                  # and covers the directory itself. `[]` is the default.
                                  # Set by set_file_leases (edit-policy).
  - paths: ["pnpm-lock.yaml"]
    taskKey: SHOP-11
    reason: regenerating it for the cart importer
gates:                            # ruling 482: the commands VIBERR runs on every
                                  # delivered revision, in order, each with `sh -c`
                                  # in a fresh checkout of the revision's sha, as the
                                  # task owner's agent uid (ruling 460), with no
                                  # credential. A plain acceptance waits until every
                                  # one exited 0 on the revision under review. Absent
                                  # (not `[]`) when the project declares none; at most
                                  # 10; `timeoutSeconds` 1..3600, 600 when absent. Set
                                  # on Settings → Gates or by set_project_gates
                                  # (edit-policy).
  - name: install
    command: pnpm install --frozen-lockfile
  - name: build
    command: pnpm build
    timeoutSeconds: 900
---

Project description prose (markdown body).
```

Notes:

- `nextTaskNumber` backs `allocateTaskKey` (project-writer): the counter is
  read+bumped under the project.md mutex; a max-scan of existing
  `tasks/<PREFIX>-<n>` directories rescues a stale/missing counter. Concurrent
  creates can never mint the same key.
- Every list (`stages`, `workflow`, `members`, `agents`, `guardrails`,
  `requiredReviewers`, `fileLeases`, `gates`) parses per row, and each deployment's `capabilities`
  per grant: one malformed grant costs only itself, with a diagnostic. A missing `stages`
  list is an error diagnostic (`project.no_stages`).
- Membership is authoritative here (files are truth); `project_members` in
  SQLite is its projection. Guest detection (the "app user · not in project"
  pill) derives from this list at projection time.
- **Two-layer agent model**: `agents/profiles/<id>.md` are ORG templates
  (backends, eligible stages, base capability policy, resources, description
  body). A project's `agents:` list *deploys* templates by `profileId` and
  carries the project-effective capability policy (may override the
  template) and an optional `definition` whose fields override the template's one by one.
  Task assignments store `profileId` — never joined by role text.
  `definition.resources` is a COPY of the template's grants taken at deploy
  time (ruling 156): it changes only through the project editor,
  `update_agent_deployment`, the org resource-rename rewriter, or a propagation
  from the template (`save_global_agent { propagate }`, the org modal's box, the
  Agents page's "Use the template's grants", the operator's template included, ruling
  479(c)), and a run mounts the copy.
  `definition.persona` is a snapshot the same way: the project editor,
  `update_agent_deployment`'s `persona` and a template save that changes the persona
  with `propagate` rewrite it (ruling 467).
- A lease whose holder task is archived, in the terminal stage or gone binds nobody
  (resolved at read time by `activeFileLeases`, ruling 247); the row stays in the file until
  someone clears it.
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
key: VIB-142                      # must match the directory; the directory name wins
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
                                  # ruling 225: the PROJECTION also derives a
                                  # fourth value, `schedule`, for a task resting
                                  # on a pending occurrence with nothing pending
                                  # on a person. Never written to a task file.
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
recommendations: []               # pending operator recommendation cards:
                                  # transition | run_agent | accept_completion |
                                  # delivery. An accept_completion card carries
                                  # `forHeadSha`, the work revision it binds to,
                                  # and is withdrawn on the record when that
                                  # changes (ruling 137)
schedules: []                     # pending/fired scheduled runs (O-3, ruling 98:
                                  # run-operator | run-agent; the agent arm pins
                                  # profileId + prompt, nothing else)
queuedQuestions: []               # ruling 241: reviewer questions a dependency
                                  # hold refused (ruling 186 refuses every agent
                                  # dispatch while `blockedBy` is non-empty).
                                  # Each entry pins profileId + the directive
                                  # text + who decided; `announceRelease` drains
                                  # the list before it re-invokes the operator,
                                  # emptying it first so no reviewer is asked
                                  # the same question twice.
urgent: false                     # derived at write time: priority == urgent
                                  # (kept for the board's highlight); absent ≡ false
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
  kind: delivered                 # delivered (absent = delivered) | verified (a
                                  # no-change verification, names the base sha) |
                                  # discarded (ruling 161: a person discarded the
                                  # never-pushed branch; the record stays so the
                                  # verdicts read as history, readers go through
                                  # `activeWorkRevision`, which answers null) |
                                  # external (ruling 179: the reconciler minted it
                                  # from a PR head moved by commits Viberr did not
                                  # deliver, so older verdicts stop binding)
  pushedAt: 2026-09-06T19:10:35Z  # ruling 161: stamped by the delivery push that
                                  # published this head (pushed, or up_to_date with
                                  # it). Absent = no delivery has seen it on origin;
                                  # `revisionLeftWorkspace` reads it (never
                                  # `github.commits`, which the workspace reconcile
                                  # writes from the local clone)
deliveredAt: null                 # ruling 388: when a DELIVERER last saved files
                                  # into attachments/ — this task's delivery when
                                  # the deliverable is not a commit (a report, a
                                  # design note, an audit). It is what a review
                                  # binds to in that case, and a later save moves
                                  # it, which stales the old verdict exactly as a
                                  # new revision does. Only the delivering
                                  # engagement sets it: a reviewer's own captures
                                  # are evidence, and a person's upload is an
                                  # input (ruling 379), not the work.
verdicts:                         # per-engagement, each bound to a SUBJECT
  - profileId: reviewer
    revisionId: rev_9f2c          # ruling 388: the workRevision.id, or
                                  # files:<deliveredAt> for a non-commit delivery
    headSha: a91f7c2e…            # absent when the subject is not a commit
    result: approve               # approve | request_changes
    reason: Scope matches the goal.
    at: 2026-07-04T06:52:00.000Z
    rounds: 1                     # ruling 204: times this reviewer returned THIS
                                  # result on THIS revision (absent reads 1)
baseRefreshes: []                 # ruling 132: every base refresh the operator's
                                  # update_branch_from_base landed on the branch,
                                  # recorded as it is pushed: { mergeSha, baseSha,
                                  # base, commits, at, onto }. A merge listed here is
                                  # a CLEAN merge Viberr made (that path aborts on
                                  # conflict), which is how the reconciler tells a
                                  # base refresh from authored drift. The refresh merges
                                  # with --no-ff, so mergeSha is always a two-parent
                                  # merge commit, never the base tip itself. `onto`
                                  # (ruling 439) is the branch head the merge was made
                                  # on, which lets a revision be followed through
                                  # Viberr's own refreshes instead of re-minted
branch: vib-142-attach-workspace  # task-key branch; null before creation
archived: false                   # R14-3: abandoned work, kept for the record —
                                  # leaves the board's default view and the review
                                  # queue, keeps its timeline, restorable
noChanges: true                   # optional; R17-2/R19-1 — this task completes
                                  # with NOTHING to deliver (see the note below)
pr:                               # GitHub projection mirrored into the file
  number: 318                     # (Phase 7 reconciler owns sync)
  state: review                   # review | merged | closed | accepted; an unknown
                                  # string reads as review
  title: Attach execution workspace
  checks: { total: 4, passing: 4, failing: 0, pending: 0 }
  review: approved                # approved | changes_requested | review_required
  mergeable: clean                # clean | conflicting | unknown
  mergeableAt: 60049586…          # ruling 405: the head `mergeable` was measured on;
                                  # a conflict measured on an older head stops blocking
  headSha: 60049586…              # ruling 135: the PR head as GitHub last reported
                                  # it (optional key; carried across a reuse of the
                                  # SAME number, never inherited by a different PR)
  revisionDrift:                  # ruling 132: AUTHORED commits since the reviewed
    headSha: 60049586…            # revision, with a base refresh reported apart —
    authored: 0                   # never as unreviewed work; describeRevisionDrift
    baseRefresh:                  # (app/shared/revision-drift.ts) is the ONE
      merges: 1                   # sentence every surface prints; null baseRefresh
      commits: 4                  # when the head carries none
  unpushedRevision:               # ruling 135: the DELIVERED revision is not on
    revisionSha: 385047c…         # the PR — behind (a plain push fast-forwards),
    prHeadSha: 60049586…          # diverged (a push is refused non-fast-forward)
    relation: unknown             # or unknown (GitHub does not have the sha at
                                  # all: never pushed). Written by the reconciler
                                  # and by the workspace reconcile the moment a run
                                  # mints a new revision on an open PR; cleared by
                                  # a delivery that pushes; never for `verified`
  closure:                        # ruling 160: a person closed this PR without
    at: 2026-09-06T19:33:19Z      # merging. Stamped by the reconciler on the
    by: akin-ozer                 # transition into `closed` (the closer's GitHub
    answered:                     # login, or null); `answered` is stamped when a
      at: 2026-09-06T19:40:02Z    # person resolves a packet while the PR is closed
      byUserId: u_arda            # (null until then). Until answered, delivery
                                  # refuses `closed_by_human`; dropped on reopen
  bodyWritten:                    # ruling 474: the PR body Viberr last wrote, set
    sha256: 03a8caef…             # on create and on every rewrite: its hash (CRLF
    revision: 60049586…           # read as LF) and the revision it describes (the
    keptRevision: 60049586…       # PR head when the task records none, else null);
                                  # keptRevision: the revision a person's edit was
                                  # found and kept at (one note each). Absent = never
                                  # recorded, and a delivery treats the body as its
                                  # own. Carried for the same PR, never inherited
  reviewRelay:                    # ruling 484 (a loose key, like humanApproval):
    relayed: [review:2197, comment:88410]  # the GitHub reviews and line comments
                                  # the reconciler relayed to the deliverer, stamped
                                  # in the write that appends their comment (a
                                  # review with nothing to relay is stamped alone);
                                  # newest 500 kept; carried for the same PR
github:                           # more GitHub cache: commits + change stats
  commits: [{ sha: a91f7c2, msg: "[VIB-142] …", pushed: true }]
  changed: { files: 9, add: 412, del: 87 }
  unownedPr: 232                  # R15-15: a PR on the branch name this task did
                                  # not open (null/absent = no collision)
  foreignHead:                    # ruling 161 (U35-8): origin's branch carries
    sha: d5f23aa…                 # commits this task's record does not account
    prNumber: 232                 # for. Written by the reconciler while it holds
                                  # (the unowned PR's head, else the compare's tip;
                                  # null when GitHub named neither), dropped the
                                  # pass the head is proven this task's; the
                                  # archive ceremony's delete-branch row reads it
priority: normal                  # low | normal | high | urgent (PRIORITY_VALUES,
                                  # default normal): advisory metadata the OPERATOR
                                  # reads; never in the specialist prompt
labels: []                        # R26-2: free-text labels, searchable on the board and ⌘K
dueDate: null                     # R26-1: `YYYY-MM-DD` or null — advisory metadata
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
gateRun:                          # optional; ruling 482 — the project's gates as VIBERR
  id: gate_Xk2…                   # last ran them, bound to a revision like a verdict.
  revisionId: rev_9f2c            # The workRevision.id and the full sha checked out.
  headSha: a91f7c2e…              # status: queued | running | finished | error (the
  status: finished                # run could not execute; `error` says why). Written
  reason: delivery                # by the server alone: a delivery, a new head while a
  requestedAt: 2026-09-25T10:14:58Z  # PR stands, the reconciler's external revision, a
  startedAt: 2026-09-25T10:15:00Z    # changed gate list or a person's "Run gates" asks;
  finishedAt: 2026-09-25T10:16:12Z   # each result lands as it finishes. A malformed
  error: null                     # record reads as absent (gates not run: fail closed)
  results:
    - name: build
      command: pnpm build
      exitCode: 0                 # null when killed at its timeout or never started
      timedOut: false
      wallMs: 41230
      log: gate-a91f7c2-02-build-20260925T101512Z.log  # the task attachment holding
                                  # the combined output (null when it could not be saved)
headCheckWaiver:                  # optional; ruling 226 — a maintainer took a merge whose
  prNumber: 114                   # containment check GitHub refused to run. Pinned to all
  revisionHeadSha: a1b2c3d…       # three: the gate re-reads the LIVE head and honours it only
  liveHeadSha: f9e8d7c…           # while the triple still matches, so it cannot outlive the
  at: 2026-09-14T02:40:00.000Z    # head it was granted for and become a standing permission.
  byUserId: u_abc123
  byLabel: Arda
goalRef: null                     # ruling 99: { goalId, linkIndex } for a chained-goal task
createdAt: 2026-07-03T06:00:00.000Z
updatedAt: 2026-07-04T06:58:30.000Z
boardRank: 300                    # sparse rank for drag-to-reorder; null falls
                                  # back to the task-key number
---

## Goal

One-paragraph goal statement (prose).

## Packet

`PACKET_OPTION_KINDS` in `app/schemas/task-file.schema.ts` is the source of truth for the
option kinds; the enumeration below mirrors it, and `file-formats-sync.test.ts` fails when
the two differ. The section holds ONE fenced yaml block.

```yaml
id: pkt_Qm3v8LwTnA2c              # stamped when the packet is opened (F10-09)
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
  - kind: accept_completion       # STABLE kind (ruling 7). The 18 kinds:
    t: Accept completion          #   accept_completion | request_edit |
    d: Mark task done …           #   block_on_policy | hold_runtime_debug |
    rec: true                     #   redirect | retry_other_backend |
                                  #   edit_goal | archive_task | discard_branch |
                                  #   resolve_remote_collision | force_accept |
                                  #   move_stage | wait_for_window |
                                  #   accept_unverified_head |
                                  #   block_on_dependencies |
                                  #   question_reviewer | create_task | custom
                                  # There is NO acceptance marker field: the
                                  # acceptance path is gated on the KIND alone.
                                  # Source of truth: PACKET_OPTION_KINDS in
                                  # app/schemas/task-file.schema.ts.
  - kind: request_edit
    t: Request one edit
    d: …
    rec: false
    ev: "**Decision:** request one edit. …"   # pre-authored timeline copy
  - kind: move_stage              # ruling 164: the stage the resolution moves to,
    t: Move KNC-16 back to Review #   on the stage picker's own path. Required on
    d: So the reviewer can run.   #   this option, refused on every other, and the
    toStage: review               #   terminal stage is refused (that is an accept).
    rec: false
  - kind: edit_goal
    t: Align the goal to the merged spec
    d: Why the goal should change.
    rec: false
    goalDraft: |                  # ruling 138: the proposed goal text itself,
      Deliverable: …              # written AS a goal; what the editor opens with.
      Acceptance: …               # Absent → the editor prefills t + d verbatim.
                                  # Refused on any other option.
awaiting: goal_edit               # set when an edit_goal option was confirmed;
decided:                          # ruling 138: WHICH option, so a reload renders
  optionIndex: 3                  # the packet as decided (chosen option locked,
  at: 2026-07-04T07:00:00.000Z    # one "Edit the goal" control) and rebuilds the
  byUserId: u_abc123              # same draft; both clear with the packet
```

## Timeline

### 2026-07-04T06:58:30.000Z · comment · operator
notified: u_abc123

@Arda the PAT scope is the only blocker; widening it is a Settings change.

### 2026-07-04T06:58:00.000Z · comment · user:u_abc123 (Arda Kaya)
to: agent

@operator if the PAT scope is the only blocker, let's widen it rather than block the whole task.

### 2026-07-04T06:41:00.000Z · completion · agent:codex/developer (Implementation)
title: Completion report

Implemented repo attach, branch creation, and PR-sync projection.

evidence:
- unit/policy_gate_test · +14 · 0
- integration/pr_sync_test · +38 · −4

attachments:
- pr-sync-panel.png
````

Notes:

- **`engagements` replaced `specialist:` / `reviewers:` / `consultants:`** (generic-agents
  pass, 2026-07-19), and the legacy-key absorption was deleted in the dynamic-dispatch rework
  (ruling 98; preprod, no back-compat). A file still carrying those keys parses with whatever
  `engagements:` says (or none) and keeps the legacy keys verbatim as unknown fields; nothing
  reads them. The parser keeps the first engagement per `profileId` and demotes every
  `delivers: true` after the first, each with a warning. Engagements are created by the
  dispatch itself — write `engagements` directly only when hand-authoring a required reviewer
  (`delivers: false, verdictCapable: true`).
- `validation`, `workRevision`, `deliveredAt` and `verdicts` are a set. `validation` is a
  derived cache recomputed from the others plus the required-reviewer set on every write; do
  not hand-edit it as a source of truth. A verdict names the subject it judged
  (`reviewSubjectId`: the active revision's id, else `files:<deliveredAt>`), so a new subject
  staleness-expires every prior verdict. A head reached from the reviewed one only through
  Viberr's own recorded base refreshes is the same subject (ruling 439). A `kind: discarded`
  revision (ruling 161) is a retired record: `validation` derives to `none` over it, no
  verdict binds to it, and the next delivered head mints a fresh id even for the same tree.
- **`repo` is not a task frontmatter key.** The task-level repository override was struck by
  owner ruling (P13-D-5): one project, one repository. A `repo:` line in an existing `task.md`
  is an UNKNOWN key, preserved verbatim on round-trip and ignored by every resolver.
- **`noChanges` is the no-change completion flag** (R17-2, made reachable by R19-1). It marks
  a task that completes with nothing to deliver, turning acceptance's normal "deliver the
  branch & open the PR" refusal into the first-class "Completed — no changes" close. Two
  producers: a delivery attempt that found the branch empty, and a reviewer approving a task
  that never needed a branch at all. It is a claim about a moment that has passed, so it is
  re-verified against the live remote before any writer closes the task to Done — a branch
  that has since gained commits cannot ride a stale flag into Done. Cleared the moment a
  delivery opens a PR. Do not hand-set it.
- **Nested fields the sample does not show:**
  - `engagements[].pinnedBackend` (set by a `retry_other_backend` resolution so the switch
    sticks, F27-B1) and `engagements[].question: { kind: completeness, runId, at }` (ruling
    421: the run putting the completeness question to this reviewer, consumed by the verdict
    that run returns);
  - `recommendations[]`: `id`, `kind`, `label`, `detail`, and per kind `profileId`, `prompt`,
    `delivers`, `completeness` (`run_agent`), `toStageId` (`transition`), `forHeadSha`
    (`accept_completion`);
  - `schedules[]`: `id`, `action` (`run-operator | run-agent`), `dueAt`, `profileId` (null for
    `run-operator`), `prompt`, `createdBy`, `createdByLabel`, `createdAt`, `status`
    (`SCHEDULE_STATUS_VALUES`: `pending | claimed | fired | failed | cancelled`), `claimedAt`,
    `firedAt`, `retries`;
  - `queuedQuestions[]`: `id`, `profileId`, `directive`, `decidedBy`, `decidedByLabel`,
    `decidedAt`, `heldBy`;
  - `verdicts[].reviews` (ruling 416(b): same-result reviews of the revision, fought or not;
    absent reads as `rounds`) and `verdicts[].answers: completeness` (ruling 421: the reviewer
    answered the completeness question on this revision in the current same-result streak);
  - `pr.checksUnread: { status, message, at }` (ruling 360: the last refused check-runs read,
    kept only while `checks` has never been read) and `pr.paths: { headSha, changed,
    truncated }` (ruling 236: the paths the PR changes, pinned to the head they were read at,
    capped at `PR_PATHS_MAX` = 300). Every `pr` fact is an optional key: absent means never
    read, and an unparseable value reads as null without dropping the PR;
  - `github.otherCommits` (ruling 179: branch commits without this task's `[KEY]` prefix) and
    `github.commits[].pushed` (ruling 187: whether the remote has the commit; absent = not
    judged).
- **Identity fallbacks**: a `key` that differs from the task directory is an error
  diagnostic and the directory name wins; a missing `key` is inferred from the directory. A
  missing or invalid `stage` becomes a blank stage with a `frontmatter.unresolved_stage`
  warning, so the card lands in the board's unknown-stage bucket instead of moving.
- Unknown top-level frontmatter keys, the legacy engagement keys among them, are preserved
  verbatim on write.

Packet notes:

- Beyond `kind`, `t`, `d` and `rec`, an option carries the payload its kind needs. Authoring
  refuses a required payload that is missing, and refuses `goalDraft`, `toStage`, `dueAt`,
  `blockedBy` and `newTask` on any other kind. `accept_unverified_head` is never authored by
  an operator: the acceptance gate writes it itself, pinned to the shas it read (ruling 226).

  | Field | Kind | Meaning |
  |---|---|---|
  | `ev` | any | pre-authored timeline text written when the option is chosen |
  | `backend` | `retry_other_backend` | the backend to re-run the failed agent on |
  | `profileId` | `retry_other_backend`, `question_reviewer` | the reviewer to retry, or the engaged non-delivering reviewer the question goes to (ruling 237; required) |
  | `deleteBranch` | `archive_task` | also delete the remote branch (refused while the PR is open) |
  | `goalDraft` | `edit_goal` | the proposed goal text (ruling 138) |
  | `toStage` | `move_stage` | the stage id the resolution moves the task to (ruling 164; required) |
  | `dueAt` | `wait_for_window` | the instant the provider said its window reopens; the resolution schedules a `run-operator` resume a minute after it (ruling 224; required) |
  | `blockedBy` | `block_on_dependencies` | what this task will wait on, in `blockedBy` spellings (ruling 230) |
  | `newTask` | `create_task` | `{ title, goal, blockedBy?, blocks?, labels? }`: the task the resolution creates; `blocks` names existing tasks that must wait on it (rulings 269, 287) |
  | `rework` | `redirect` | set by the branch-conflict packet: the resolution returns a task standing at or past the review stage to it in the same write (ruling 163) |
  | `reply` | `custom` (an agent's question) | `true` when choosing the option needs the person's typed answer: the card requires the answer box and `resolvePacket` refuses the option without a note (ruling 478(e)). Written by `ask_human` and the Codex envelope; the options-less fallback always carries it |

  The schema is `.loose()`, so an unknown option key round-trips and is read by nothing. There
  is no `accept:` field: acceptance is gated **solely** on `kind === "accept_completion"`, plus
  the admin|maintainer re-check in `resolvePacket`.
- Packet-level fields beside the sample's: `cause` (ruling 315: the shared cause string,
  `backend:<backend>:<kind>:<credentialUserId>`, stamped on a quota, auth or unavailable
  failure; answering one such packet applies the same option to every sibling still carrying
  it, ruling 319), `stalled: true` (ruling 432: a stall escalation, the only kind a later
  successful run may withdraw), and `askedBy` (R15-14: the profile of the agent that raised
  the question; resolving it resumes that agent's session).
- `options` and `observations` parse per row: a malformed row drops only itself
  (`packet.invalid_option`, `packet.invalid_observation`). A packet with more than one
  `rec: true` gets a `packet.rec_count` info diagnostic. None is legitimate: an agent's
  question carries `rec` only on the option the agent marked "(Recommended)" (ruling 478(e)).
- The writer fences the block with more backticks than the longest run inside it, and the
  reader closes it only on a fence at least as long, so packet prose that quotes a code fence
  stays inside the block.
- `decided` and `goalDraft` stay as above on disk; the projection's packet render derives one
  more field from them, `goalDraft` on the render itself (`mapPacket`,
  `app/shared/mapping/task.server.ts`): `goalDraftForOption` of the option
  `decided.optionIndex` names, present exactly while `awaiting: goal_edit` and a decision is
  recorded. It is never written to the file. Every door into the goal editor reads that one
  field. The render also derives `answerTo` (ruling 478(e)): the asking agent's display name,
  set exactly when `kind` is `Agent question` and `askedBy` is set, the packets whose answer
  `resolvePacket` sends back to that agent; the card names its answer box after it.

### Timeline entry grammar (append contract for agents)

- Entries are NEWEST FIRST. To append an event, prepend a block directly
  under `## Timeline`. Appending at the BOTTOM is parsed without error, but
  nothing repairs it: every reader is file order (`listTaskEvents` is
  `ORDER BY position ASC`, and the task page slices the first N off the
  front), so a bottom-appended entry renders as the OLDEST thing on the task
  and falls outside the initial slice. A `timeline.out_of_order` info
  diagnostic is recorded when it happens; that diagnostic reports the damage,
  it does not undo it.
- Heading line: `### <UTC ISO> · <type> · <actor-ref>` — separator is
  `<space>·<space>` (U+00B7). `type` is one of the 12 contract types in
  `TIMELINE_EVENT_TYPES` (`comment completion github policy note quality transition blocked
  agent assign continuity proposal`); unknown types are kept (info diagnostic) and render as plain
  comments. `proposal` is a proposed knowledge-base correction (ruling 483), titled
  "Proposed ruling change" or "Proposed knowledge-base correction"; it asks a person to
  decide, so it is neither a review verdict (`quality`, where ruling 378 filed it) nor a
  neutral `note`. `continuity` marks a runtime-continuity RESET — a resumed session whose provider
  transcript was gone, so the agent re-anchored on `task.md` in a fresh one. It is
  warning-toned on purpose: nothing was violated (not `policy`) and nothing is stuck (not
  `blocked`), but a supervisor scanning the board must get a cue that context was lost and
  recovered. `policy` is reserved for genuine governance violations and refusals, which render
  with a coral shield; every neutral system remark — a goal edit, a divergence note, a
  scheduled re-run — is a `note` (P13-LV-03). An unrecognized actor ref is kept verbatim
  (warning diagnostic) and projects as a system actor.
- Optional metadata lines immediately after the heading (before the first
  blank line), each one line: `title: <text>` (a completion's heading, `Review verdict` on a
  reviewer's verdict report, `Compacted` on a compaction marker), `to: agent` (a comment
  routed to the operator — `comment-card toagent` tint) and `notified: <id>, <id>` (ruling
  382: the users this event's own notification reached, after routing preferences).
- Then a blank line and the event text: GFM markdown for every event type, comments and
  typed events alike (ruling 478(a); `@mention` chips for known names). Multi-line text,
  paragraphs and fenced blocks are allowed. The activity and notification feeds render it
  through the inline `RichText` micro-format (`**bold**`, `` `code` ``, `@mention`).
- **Body-line escaping** (structure-like text): an event-body line whose raw
  form would read as file structure — starting with `## `, `### `,
  `title:<ws>`, `to:<ws>`, `notified:<ws>`, or a line that is only (whitespace and)
  `evidence:` or `attachments:` — is written with ONE leading backslash: `\## Notes`,
  `\### 2026-01-01T00:00:00Z · completion · operator`, `\title: x`,
  `\evidence:`. Lines that already start with backslashes in front of such a
  pattern gain one more on write. Readers strip exactly one backslash from
  any line matching
  `^\\+(## |### |title:\s|to:\s|notified:\s|\s*evidence:\s*$|\s*attachments:\s*$)` when
  reconstructing the text; all other lines (including `\` before
  non-structural text) pass through verbatim. The mapping is bijective, so
  round-trips stay byte-stable, and free text (including fenced code blocks
  quoting headings) can never split sections, forge timeline events, or
  override the real `## Packet`. External appenders MUST apply the same
  escape to body lines they write. A `title:` is folded onto one line on write. The `## Goal`
  section uses the narrower form of the same rule: only a line starting `## ` is escaped.
- **Duplicate known sections**: if `## Goal`, `## Packet` or `## Timeline`
  appears more than once, the FIRST occurrence wins (never last-wins); each
  duplicate is preserved verbatim as an unrecognized extra section and
  flagged with a `body.duplicate_section` warning diagnostic (floors
  readiness at `input_required`).
- Optional evidence block on outcome events (a completion, a reviewer's verdict, an agent's
  report — P13-D-26): a line containing exactly `evidence:` followed by
  `- <label> · <add> · <del>` rows; add/del are the signed display strings (`+14`, `0`, `−4`
  with U+2212). An optional `attachments:` block follows the same way, one `- <file name>`
  per file the event's run saved under `tasks/<KEY>/attachments/` (ruling 96); the directory
  stays the truth.
- **Compaction**: when the project's `compression-threshold` guardrail is on and a timeline
  passes its `value` (40 by default), writers fold older routine comments into ONE `comment`
  titled `Compacted` in the oldest folded entry's slot (`timeline-compaction.server.ts`). The
  newest `min(24, max(4, ⌊value / 2⌋))` entries (20 at the default) are never touched, and
  neither is a typed event, a human or controller
  comment, a `to: agent` hand-off, a comment titled `Compacted` or `Review verdict`, a comment
  with `notified`, `evidence` or `attachments`, or the newest agent reply in the older region.
- Malformed entries (a heading without both separators, an unparseable timestamp, an
  evidence row without three parts) are skipped with a warning diagnostic (readiness floors
  at `input_required`) — the task itself is never dropped.

## 2b. `projects/<slug>/goals/<goal-id>.md` (chained goals — ruling 99)

Frontmatter + `## Description` (the outcome, prose) + `## Timeline` (history
bullets, newest first: `- <UTC ISO> · <text>`). Goal ids are `goal-<n>`, the next free number
in the project's `goals/`.

```markdown
---
id: goal-1
title: Ship the billing revamp
status: active                    # active | paused | attention | completed | cancelled
createdBy: u_abc123               # the authority chain advancement re-proves
createdByLabel: arda@viberr.dev
conversationId: cnv_3fQk9x2LmP0a  # ruling 476(h): the controller conversation whose
                                  # turn created the chain (null when none, or for a
                                  # chain written before the key); the project's
                                  # Controller page links back to it
onFailure: pause                  # pause (default) | continue
links:
  - index: 1                      # 1-based chain position
    title: Extract billing interfaces
    goal: Deliverable + done signal (becomes the created task's ## Goal)
    taskKey: VIB-12               # null until the chain reaches this link
    status: done                  # pending | active | done | failed | skipped
    note: null                    # failure reason / redirect note
    redeclared: false             # ruling 192(b): edit_link re-declared a FAILED
                                  # link, so the retry builds from the link rather
                                  # than the failed task; cleared by that retry
    blockedBy: []                 # ruling 131(c): what this link's task waits on
                                  # (task keys / `goal-2 link 1`); copied onto the
                                  # task the chain creates for the link, validated
                                  # then, so the task is born held. Ruling 155:
                                  # once the link is active the TASK's list is the
                                  # wait and this mirrors it on every change (a
                                  # person, the controller, the operator, the
                                  # release engine), so a retry is born on the
                                  # list the record last held
createdAt: 2026-08-30T10:00:00.000Z
updatedAt: 2026-08-30T12:00:00.000Z
---
```

Notes:

- `links[].blockedBy` is the ONLY thing that holds a link back (ruling 398): the goal starts
  every link whose wait is already satisfied, so a link with an empty list starts as soon as
  the goal is written, whatever its position. The goal writer accepts `link 2` for a sibling
  of the same goal and stores the absolute spelling (`goal-1 link 2`).
- The chain file owns the ordered list; each member task carries the tolerant
  back-reference `goalRef: {goalId, linkIndex}` in its own frontmatter (the
  project→task shape: project.md owns stages, task.md carries `stage`).
- Link statuses are the advance engine's claims; `goal_projections` re-derives
  each linked task's real state from task rows on rebuild, so an out-of-band
  task move cannot leave the chain lying.
- Goal files are app-written and never deleted by the product; terminal chains
  stay readable. `goals/*.md` is watched and projected like every canonical file.
- `conversationId` is read from the file (`readGoalFileFacts`, the Controller page's one
  read of each chain's file beside its history); `goal_projections` does not carry it.
- The goal parser is **strict**, unlike the task and project parsers: any schema failure makes
  the file unreadable, and the store doctor reports every finding as a hard stop, so hand
  edits must round-trip exactly. Unknown frontmatter keys are still preserved on write.
- A `## Description` line starting `## ` (after optional whitespace) is written with one
  leading backslash, the same convention as task.md, so prose cannot close the description
  early and forge history bullets.

## 3. Actor references (contracts §3.1)

| Actor | File encoding | Render shape |
|---|---|---|
| Human | `user:<userId>` or `user:<userId> (Display Name)` | `{ kind:"human", userId, name, initials, tone, guest? }` — resolved from the users table at projection time; the parenthetical is a snapshot fallback for deleted users; `guest` derives from project membership |
| Agent | `agent:<backend>/<profileId>` e.g. `agent:codex/developer`, optionally with a role snapshot `agent:codex/developer (Implementation)` | `{ kind:"agent", backend, name, role }` — the second segment is the **profile id**, never a role slug; `name` is the deployed agent's own name, falling back to the backend label "Codex" or "Claude" (ruling 92) |
| Operator | `operator` | `{ kind:"agent", name:"Operator" }` (NO backend, NO role) |
| Controller | `controller` | `{ kind:"agent", name:"Controller" }` (ruling 99 — instance machinery, same backend-less shape) |
| System | `system:<id>` e.g. `system:policy-engine`; `system:goal-chain` signs the creation events of a task a goal chain starts (ruling 477(b)) | `{ kind:"system", name:"Policy engine" }` |

Any other string decodes as an unknown actor: it is re-encoded verbatim and renders as
`{ kind:"system", name:"Unknown actor" }`, so an event is never dropped over its author. The
encoder turns ` · ` and newlines inside a display snapshot into ` - ` and spaces, so a snapshot
can never break the heading line.

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
icon: branch                      # an ICON_PATHS name (app/ui/icon.tsx); default cpu
backends: [codex, claude]
model: sonnet                     # ONE catalog id for the first backend (see
                                  # docs/domain/agents-and-runtime.md §2.3);
                                  # ruling 153: the template's DEFAULT, taken by a
                                  # library deploy when no override is given
effort: high                      # optional reasoning effort: the controller (ruling
                                  # 106) and, ruling 153, a specialist template's
                                  # default that a library deploy copies onto the
                                  # deployment when the backend offers the tier. A
                                  # non-string value reads as absent
scope: Global base · customized for Viberr Core
stages: [ready, impl]             # eligible stages
spanAll: false                    # operator only
capabilities:                     # same id-based shape as project deployments
  - { capabilityId: create-task-branch, mode: direct }
extras: []
resources:
  skills: [developer-expertise]
  mcps: [github]
  kb: [viberr-core-architecture, coding-standards]
---

Profile description (markdown body).
```

A profile whose frontmatter fails the schema (a missing `name`, an unknown `kind`) is
unreadable: the parse returns nothing with an `agent_profile.invalid` warning. Unknown
top-level keys are kept (the schema is `.loose()`) and raise an `agent_profile.unknown_field`
drift warning against `AGENT_PROFILE_KNOWN_KEYS`. A `kind: controller` profile is instance
machinery: never deployed into a project's `agents:` list.

Every value in `resources:` is a **store folder name, never a display name**. For
`skills:` and `mcps:` the slug *is* the folder, so the two coincide. For `kb:` they do
not: a knowledge base has a display name and a directory as separate columns, and the
grant resolves against `${VIBERR_DATA_ROOT}/kb/<dir>`. A `kb:` entry written as the
display name resolves to nothing — `readKbIndexDetailed` returns an empty index with a
`logger.warn` and an unresolved-grant row (which the run's prompt names), so the run
proceeds *without* the knowledge base while every UI still shows it attached. Use the
directory. (Renaming a KB's directory orphans existing grants for the same reason;
re-attach them.)

## 5. What is deliberately NOT in files

- Secrets (PATs, session data) — SQLite/env only, never under `projects/`.
- Notification rows, read state, sessions, users, audit, controller conversations —
  app-owned SQLite.
- Derived readiness — files store the canonical stored readiness; the
  effective value (after diagnostic floors) lives only in the projection.
  The "accepted" pill is a display state of done-stage tasks, never stored.

## 6. Other files under the data root

| File | Written by | Format |
|---|---|---|
| `agents/definitions/{operator,controller}.md` | boot (`seedDefaultAgentAssets`) | frontmatter `id`, `name`, `backend` + the doctrine body. The controller's body is the instructions its settings edit (locked by default, ruling 108); a save keeps the frontmatter head. |
| `agents/controller-requests.md` | the controller's `request_resource_grant` tool (ruling 390); Instance settings lists the open ones | frontmatter `requests:`, newest first, each `{ id, kind (skills \| kb \| mcps), name, reason, askedAt, askedByUserId, askedByLabel, status (open \| granted \| declined \| withdrawn), closedAt, closedByLabel }`, parsed per row, + a one-line header body. One open request per (`kind`, `name`). A request leaves `open` through `closeResourceRequest`: `granted` when a Controller-tab save (`saveControllerConfig`) leaves the resource in the controller's resolved grants, `declined` from the tab's Decline button. Either stamps `closedAt` and `closedByLabel` (the admin's email), and the closed row stays as history. Nothing in the app writes `withdrawn`. |
| `skills/<name>/SKILL.md` | the org skill writers and the store browser | markdown; every writer judges the body with `assertSkillBodyWellFormed` (ruling 183). A mounted copy gets normalized frontmatter. |
| `kb/<dir>/**` | the KB store browser, uploads, GitHub import; a proposal filed from a task (ruling 483) | any documents; agents read the live folder at run time. A document may end in a proposals section (§7) |
| `state/shipped-assets.json` | boot | JSON map of store-relative asset path → SHA-256 of the bytes last shipped |
| `audit-exports/audit-events-<YYYY-MM-DD>.jsonl` | the audit purge | one `audit_events` row per line, exactly as the table stores it, appended per purge day |
| `runtimes/<backend>/<runId>.jsonl` | the run sink | one raw provider envelope per line; the truth `run_log_lines` projects |

## 7. A knowledge-base document's proposals section (ruling 483)

An agent that proves a line of a knowledge-base document wrong files the correction in
that document (`fileKbProposal`, `app/server/org/kb-proposals.server.ts`). The section is
the record: an entry is open while it stands under the heading, and nothing else lists
proposals.

```markdown
## Proposed corrections (not binding)

Raised by agents from evidence on a task. **Nothing here is binding.** A person, or the controller when a person asks it, promotes an entry into the settled text above or dismisses it.

- **[WEB-3, 2026-09-24, Platform Engineer]** The build writes dist/worker and dist/client.
  Line: T-013: output in dist/server/
  Evidence: `ls dist` after `npm run build` listed client and worker.
```

- The heading is `KB_PROPOSALS_HEADING`, created at the END of the document the first
  time; later entries are filed at the end of the section, in order. The reader also
  takes ruling 378's `## Proposed (not binding)` as the section, and the next filing
  renames it. A heading inside a fenced block is not the section; the section ends at
  the next `#` or `##` heading.
- An entry is a list item opening with a bold `[<task key>, <YYYY-MM-DD>, <filer>]`
  stamp (ruling 378's entries have no filer), then the correction; its other lines are
  indented two spaces: `Line:` (the settled line it corrects, absent when it adds
  something) and `Evidence:`. Blank lines inside a value are dropped, since they would
  end the list item.
- An entry's id is `kp-` and the first ten hex characters of the SHA-256 of
  `<kb>\n<doc>\n<entry text>`: stable while nobody edits that entry.
- The settled text is the document without this section. A filed `line` must stand in
  it (compared without case, emphasis, quotes or runs of whitespace), and a promotion's
  `replaces` must stand in it exactly once. Promoting or dismissing the last entry
  removes the heading and the intro with it.
