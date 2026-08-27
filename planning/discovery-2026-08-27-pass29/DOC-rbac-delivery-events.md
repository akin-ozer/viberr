# Discovery doc — RBAC, GitHub delivery, event-sourcing/projection

Pass 29, 2026-08-27. Read-only discovery over the working tree at
`/Users/akinozer/projects/viberr/.claude/worktrees/viberr-app-inspection-e1b87f`.
Every claim below is cited to a real `file:line`; nothing is inferred from
naming alone.

---

## 1. RBAC

### 1.1 Roles

**Org roles (2):** `admin` | `member` — `app/shared/mapping/user.server.ts:10`
(`export const USER_ROLES = ["admin", "member"] as const;`). Stored on
`users.role`; validated by `user-admin.server.ts:42` (`z.enum(USER_ROLES)`).
This is the **only** org-level role axis — there is no better-auth
organizations/membership plugin (`app/server/auth/identity.server.ts:18`:
"Org roles remain in `users.role`; project roles remain file-native.").

**Project roles (4), strict tier `viewer ⊂ contributor ⊂ maintainer ⊂ admin`:**
`app/shared/rbac.ts:31-43` (`ROLE_RANK`, `ROLE_LABEL`). Sourced from
`app/schemas/project-file.schema.ts` (`PROJECT_ROLES`, re-exported at
`rbac.ts:29`). A project role lives on `project.md`'s `members[]` frontmatter
array, not a DB table — it is file-native, mirrored into the
`project_members` projection table by the rebuilder
(`app/server/projections/rebuilder.server.ts:233-239`).

### 1.2 The ACTION_ROLES matrix (single source of truth)

`app/shared/rbac.ts:61-93` — `RBAC_DEFINITIONS`, a flat array of
`{ id, label, roles }`. Compiled into a `Map<RbacAction, readonly ProjectRole[]>`
called `ACTION_ROLES` (`rbac.ts:97-101`), consumed via `rolesForAction(action)`
(`rbac.ts:110-116`) and `roleCan(role, action)` (`rbac.ts:104-107`). The
**same object** feeds both server enforcement (`requireAction` et al.) and
the Policy page's rendered permission table, so display and enforcement
cannot drift (`rbac.ts:8-11`).

`view` and `comment` are held by all four roles and are **not** gated by
`ACTION_ROLES` at the call site at all — their only enforcement is the outer
membership gate (a non-member 404s), per `rbac.ts:22-26`.

Notable actions → allowed roles (from `rbac.ts:61-88`):

| Action id | Roles | Notes |
|---|---|---|
| `view`, `comment` | A, M, C, V | enforced only by membership, not `requireAction` |
| `create-task`, `own-task`, `edit-task-meta` | A, M, C | |
| `approve-transition` | A, M | stage transitions, archive, discard-branch |
| `resolve-packet` | A, M | |
| `accept-completion` | A, M | **+ owner exception** — see §1.4 |
| `update-goal` | A, M | distinct from `edit-task-meta` |
| `run-agents` | A, M | start/interrupt runs, @mention triggers, manual delivery |
| `reorder-board` | A, M | |
| `reconcile-github` | A, M | |
| `grant-github-scope` | A, M | |
| `rescan-project` | A, M | |
| `release-any-ownership`, `manage-members`, `manage-agents`, `edit-policy` | A only | |
| `force-accept-completion` | A only | admin-only escape hatch past the review gate (DG-2) |

### 1.3 How a route/action authorizes

Chokepoint: `requireAction(db, project, actor, action, what)` —
`app/server/tasks/task-actions.server.ts:282-297`. It (1) calls
`requireProjectMutable` to freeze mutations on an archived project
(`task-actions.server.ts:292`, impl at
`app/server/auth/project-authority.server.ts:136-147`), then (2) delegates to
`requireProjectAuthority` → `resolveProjectAuthority`
(`project-authority.server.ts:265-282`, `173-258`), which:

1. Looks up the actor's live role in `project.memberRoles` (read fresh from
   `project.md`, not the DB) and checks it against `rolesForAction(action)`.
2. If that fails, checks `isOrgAdmin(db, userId)` (`project-authority.server.ts:152-157`,
   reads `users.role = 'admin'` directly) and grants **project-admin-equivalent**
   authority as the audited "D2" emergency override — every such grant writes a
   `project.org_admin.override` audit row (`project-authority.server.ts:215-229`),
   collapsed to at most one row per 60s per `(actor, project, what)` key for the
   `"any-member"` gate only (never for a named `RbacAction`).
3. Otherwise denies, and (per "P13-D-8") writes a `project.authority.denied`
   audit row unless the caller opted into `silentDeny` (`project-authority.server.ts:232-256`;
   the one `silentDeny` caller is `canRunAgents`'s @mention path,
   `project-authority.server.ts:311-327`).

Config surfaces without a loaded project context use
`assertProjectAction(db, action, projectSlug, actor, what, opts)`
(`project-authority.server.ts:337-390`), which reads `project.md` fresh,
applies the archived gate (unless `allowArchived`), and calls the same
`resolveProjectAuthority`.

Two named exceptions on top of the matrix:
- **Owner exception** (`ownerException`, `task-actions.server.ts:300-311`): a
  live contributor-or-higher who is the task's own `ownerUserId` may accept
  their own task's completion (`requireAcceptCompletion`,
  `task-actions.server.ts:314-323`) even without `accept-completion`.
- **R14-2 owner decision authority** (`task-actions.server.ts:325-337`,
  `requireDecisionAuthority`): a task owner clears the outer packet/recommend
  gate on their own task regardless of project role; the inner mutation each
  recommendation drives still enforces its own cap.

### 1.4 Specialist capability cap (agent-side, separate axis from project RBAC)

Project RBAC governs *humans*; a parallel, file-native **capability grant**
system governs what a deployed *agent profile* (specialist/operator) may
actually do at runtime. Catalog: `app/shared/capabilities.ts:33-154`
(`UNIFIED_CAP_CATALOG`). Key invariants:
- **Polarity (P14-LV-01):** for `GRANT_REQUIRED_CAPABILITY_IDS`
  (`capabilities.ts:393-400` — repo-write, branch, commit-push, open-PR,
  merge-PR, report-verdict) an **absent** grant means withheld, not granted.
  Every other capability keeps the old permissive default when absent
  (`capabilities.ts:377-391`).
- **Enforcement scope** — `capabilityEnforcement(id)`
  (`capabilities.ts:288-296`): `"both"` (real tool-layer + server-side gate on
  both backends), `"claude-only"` (Claude Agent SDK `disallowedTools` deny
  rules; advisory on Codex since R22 removed its read-only sandbox — see
  `CLAUDE_ONLY_ENFORCED_CAPABILITY_IDS`, `capabilities.ts:270-283`), or
  `"advisory"` (persona guidance only, no runtime consumer).
- **Tool-layer confinement**: `app/server/tasks/specialist-tool-policy.ts` maps
  withheld capabilities to concrete `Bash(...)`/tool deny rules
  (`CAP_DENY_RULES`, lines 49-97) — e.g. withheld `create-task-branch` denies
  `git checkout -b/-B` and `git switch -c/-C` (lines 54-64); withheld
  `execute-code-or-write-repo` denies `Edit`/`Write`/`MultiEdit`/`NotebookEdit`
  and `git commit` (lines 75-78). `resolveDeliveryPermissions` (lines 190-209)
  derives the matching **prompt-side** permissions so the run's instructions
  never contradict what the tool layer will actually allow (XS-4).

### 1.5 ALWAYS_HUMAN

`ALWAYS_HUMAN_CAPABILITY_IDS` — `app/shared/capabilities.ts:211-215`:
`merge-pull-request`, `transition-to-done`, `change-project-policy`. These are
**structural locks**: `capabilityEnforcement` returns `"both"` for them
unconditionally, checked *before* the Claude-only set so they can never be
mislabeled advisory (`capabilities.ts:290-296`). `specialist-tool-policy.ts:47,137`
treats any `ALWAYS_HUMAN` id as withheld regardless of what a grant record
says. Every consumer (`agent-profile-actions.server.ts:265,301,353,548`,
`agents-query.server.ts:364`) forces these to mode `"human"` at write time, so
an agent profile can never be edited to hold them. The one deliberate
exception to "no agent ever transitions to Done" is the **operator**, not a
specialist, and only under full autonomy — see §4.3.

---

## 2. Event sourcing & projection

### 2.1 Canonical file format

Every `project.md` / `task.md` is `---\n<YAML frontmatter>\n---\n\n<markdown body>`.
Split/parse/serialize lives in `app/server/files/frontmatter.server.ts`:
- `splitFrontmatter` (lines 31-88) normalizes a BOM and **all CRLF/lone-CR to
  LF** (line 42-44) before fence detection. This is the **F28-D2 fix**: without
  it a Windows-touched file's `---\r\n` opening fence failed the plain-LF
  check, the whole file (frontmatter *and* body, both `\n`-split) fell back to
  defaults, and the rebuilder **projected that broken state** silently — the
  write-guard's `hardStop` only blocks writes, never reads/projections
  (`frontmatter.server.ts:33-41`).
- `serializeFrontmatterFile` (lines 99-111) composes known + preserved-unknown
  YAML keys (unknown fields round-trip, `frontmatter.server.ts:104-107`) plus
  the body, with `lineWidth: 0` (no folding) for diff-friendly writes.

Task events are **typed, newest-first** entries in `task.md`'s timeline
(`TaskFileEvent`, `app/schemas/task-file.schema.ts`), each carrying
`occurredAt`, `type`, `actor`, `title`, `text`, `toAgent`, `evidence`.
`appendTimelineEvent` (`app/server/files/task-writer.server.ts:225-234`)
`unshift`s onto `parsed.timeline` — i.e. **prepend**, so position 0 is always
the newest event.

### 2.2 Write path

`app/server/files/task-writer.server.ts`:
- Every mutation is a **locked read-modify-write** (`updateTaskFile`,
  lines 165-187) under a per-absolute-path in-process mutex
  (`withFileLock`, `app/server/files/file-mutex.server.ts`).
- **Read-your-own-writes repair** (`repairStaleRead`, lines 91-117): on
  Docker Desktop/VirtioFS a read milliseconds after this process's own atomic
  rename can return stale content; the module remembers its last write per
  path (`rememberWrite`, lines 69-80) and trusts it over a stale-looking disk
  read when mtime hasn't advanced past the write (100ms slack).
- **Write-guard (`assertTaskFileTrusted`, lines 144-158 / `taskFileWriteBlockers`,
  lines 138-142):** refuses to write over a file the parser could only read
  via `hardStop` fallback defaults (unparseable YAML, missing/unterminated
  fence) — writing over such a file would serialize the defaults and destroy
  the real content (owner, stage, engagements, PR link, goal, timeline).
- Writes go through `writeFileAtomic` (temp file + rename,
  `app/server/files/atomic-file.server.ts`).

### 2.3 Torn-write protection: hash written LAST (F28-D3)

`app/server/projections/rebuilder.server.ts` — both `rebuildProjectFile` and
`rebuildTaskFile` write a **sentinel** `content_hash = ""` on the initial
`INSERT ... ON CONFLICT` (lines 226-231 for projects, 608-613 for tasks — `""`
is never a real sha256), then write every dependent row (`project_members`,
`diagnostics`, `task_events`), and **only then** `UPDATE ... SET content_hash =
<real hash>` as the last statement (lines 253-258 for projects, 684-690 for
tasks). If the process crashes between the sentinel and the commit-marker
update, the row's hash never matches the file's real hash, so the next
rebuild re-runs instead of short-circuiting "unchanged" on a torn projection
whose `task_events`/diagnostics never got rewritten. Row *removal* uses the
mirror-image order — dependents deleted **first**, the owning row **last**
(`rebuilder.server.ts:163-168` for projects, `382-395` for tasks) — so an
interrupted removal is finished by the next rebuild rather than orphaning
`task_events` no later rebuild would revisit.

The content-hash **short-circuit** itself: `sha256(content)` compared to the
stored `content_hash`; unchanged ⇒ `action: "unchanged"`, no re-projection
(`rebuilder.server.ts:180-189`, `408-419`).

### 2.4 Same-timestamp tie-ordering (F28-D1)

`task_events.position` is the file's timeline **array index** (0 = newest,
written via `parsed.timeline.forEach((event, position) => ...)`,
`rebuilder.server.ts:627`) — it is *not* derived from `occurred_at`. The task
page orders by `position ASC` (file order = newest-first). The **activity
feed** (`app/server/projections/activity-feed.server.ts:161-188`) instead
queries `task_events` directly and must independently order
`occurred_at DESC`; on a timestamp tie it breaks with **`id ASC`, not `id
DESC`** (`activity-feed.server.ts:172-183`). Rationale: `task_events` is
rebuilt *wholesale* per task with position-0 (newest) inserted **first**, so
the smallest `id` is the newest event — the opposite convention from the
append-only `notifications`/`audit_events` tables, where `id DESC` is right
because a larger id genuinely is newer there. Using `id DESC` here reversed
same-tick events (e.g. up to 4 events one reconcile pass stamps in a single
tick) relative to the task page.

### 2.5 The watcher

`app/server/files/file-watch.service.server.ts` — chokidar-based, one
watcher instance per data root, kept on a `globalThis` symbol so HMR reuses
it (`WATCHER_KEY`, lines 47, 76-85). Key behavior:
- **250ms trailing debounce per path** (`WATCH_DEBOUNCE_MS`, line 33;
  `schedule`, lines 113-124) — editors fire event bursts.
- **Ignore rule** (`shouldIgnoreWatchPath`, lines 103-111): dotfiles, `*.tmp`
  staging files, and anything deeper than `projects/<slug>/tasks/<key>/task.md`
  (keeps the watcher out of per-task `workspace/` clones entirely — F-SPAWN1).
- On `add`/`change`/`unlink` of `project.md`/`task.md`: debounce, then
  `rebuildPath(db, absPath, {dataRoot})` (lines 154-171, 243-249).
- On `unlinkDir`: `rebuildDir` (lines 182-238) maps the vanished directory
  onto the projection rows it backed (project root → reconcile every
  project; `<slug>` → reconcile that project; `<slug>/tasks/<key>` →
  reproject that one task as removed) — a project-row removal does **not**
  cascade to task rows in the DB, so tasks are pruned explicitly
  (lines 195-201).
- **Transient-error self-heal**: `EMFILE/ENFILE/ENOSPC/EPERM/EACCES` re-arm
  the watcher after a 2s backoff, generation-guarded so a stale re-arm can't
  resurrect a watcher after an intentional stop (lines 291-318, F10-08).
  `ENOENT` on a vanishing path is explicitly *not* treated as watcher failure
  (lines 268-276) — killing the watcher there would drop the queued
  `unlinkDir` reconcile.
- `ignoreInitial: true` (line 252) — the watcher emits nothing for what's
  already on disk at start; that gap is covered by the **boot rescan**.

### 2.6 Rebuilding the projection

Three tiers, all funneling through `rebuildPath`/`rebuildProjectFile`/`rebuildTaskFile`
(`app/server/projections/rebuilder.server.ts`):
1. **Boot rescan** — `rescanProjections(db)` (`app/server/projections/rescan.server.ts:23`
   → `rebuildAll`), called once at server start
   (`app/server/boot.server.ts:577`) *before* `startFileWatcher()` (line 603)
   — reconciles any offline drift (edits made while the server was down) via
   the content-hash short-circuit, cheap on a clean tree.
2. **Scoped rescan** — `rebuildProject(db, slug, options)`
   (`rebuilder.server.ts:750-829`): reprojects one project's `project.md` +
   all its task files and prunes only that project's vanished rows. This is
   the `rescan-project` RBAC action's target (Board "Re-scan" button) —
   confined to the caller's own project so it can't trigger an instance-wide
   rebuild (F20).
3. **Full drop-and-rebuild** — `rebuildProjections(db, options)`
   (`app/server/projections/rebuild.server.ts:35-60`): the Phase-10 recovery
   hammer for a corrupted/suspect DB. Inside **one transaction**: `DELETE`
   every file-derived table (`task_events`, `diagnostics`, `task_projections`,
   `projects` — `project_members` cascades), then `rebuildAll(db, {force:
   true})`. Projection SSE events are collected during the transaction and
   emitted only after commit, so a subscriber never observes a half-built or
   rolled-back projection (`rebuild.server.ts:50-53`). NOT dropped: users,
   sessions, notifications, audit_events, provenance, PAT/violations,
   agent_runs/run_log_lines — anything not purely file-derived.

The incremental single-file path (`rebuildPath`, `rebuilder.server.ts:710-739`)
is what both the watcher and every in-process mutation call after a write —
routes on `TASK_PATH_RE` / `PROJECT_PATH_RE` (lines 703-704).

---

## 3. GitHub delivery (end-to-end)

There are **two parallel delivery paths**, both converging on the same
`task.md` `pr:`/`branch:`/`workRevision:` fields:

### 3.1 Server-owned delivery (F-GH3) — the primary path

The specialist commits **locally only**; it never gets push credentials on
either backend (Codex runs sandboxed with no network for this; a Claude
clone's origin remote is credential-free). Viberr itself pushes + opens the
PR at the Review-stage transition. Confirmed directly in the run prompt
builder: `app/server/tasks/specialist-run.server.ts:1495-1497`
("Delivery is SERVER-SIDE for BOTH backends (F-GH3): the agent commits
locally but NEVER pushes") and the prompt text itself,
`specialist-run.server.ts:2342-2344` ("Do NOT run `git push` and do NOT open
a PR — even if an operator directive tells you to... Viberr owns delivery").

1. **Workspace push** — `pushWorkspaceBranch`
   (`app/server/github/push-workspace.server.ts`): re-supplies the project's
   PAT via a short-lived git-askpass mechanism
   (`app/server/tasks/git-clone-auth.server.ts`) and pushes the workspace's
   task branch to `origin`. Never throws; every failure mode is a typed
   result (`PushWorkspaceResult`, lines 63-108) — `push_conflict`
   (non-fast-forward — a real history divergence, not a credential problem,
   B-GH1/F15-15) is distinguished from `push_failed`/`no_pat`/`no_branch`/
   `no_commits`/`grant_withheld`.
2. **`performDelivery`** — `app/server/tasks/task-actions.server.ts:4452-4899`
   orchestrates: push, then branch/create via `ensureTaskBranch`
   (`app/server/github/branch-sync.server.ts:250-419`) if needed, then
   `openTaskPr`. On `push_conflict` or `push_failed` it **refuses to open a
   PR** rather than open one over stale/missing remote content (lines
   4499-4547) — this is the direct fix for the historical F15-15 failure
   ("a PR opened over stale remote junk was approved by a reviewer that only
   read the local branch").
   - Called from `manualDeliverForReview` (human-triggered, gated by
     `run-agents` or the task-owner exception,
     `task-actions.server.ts:4906-4934`) and from the automatic
     Review-transition path (`task-actions.server.ts:8049`).
3. **Branch creation** — `ensureTaskBranch`
   (`app/server/github/branch-sync.server.ts:250-419`): idempotent (existing
   ref ⇒ success), reads the default branch's head sha via the git-refs API
   and creates `refs/heads/<branch>` from it; a 422 "already exists" race is
   treated as success (lines 322-329). Branch naming: `taskBranchName(key) =
   key.toLowerCase()` (`branch-sync.server.ts:45-47`) — one deterministic
   branch per task, no title slug.
4. **PR open** — `openTaskPr`
   (`app/server/github/pr-open.server.ts:316-643`): idempotent twice over —
   reuses a cached live PR (lines 345-381) and, failing that, checks for an
   already-open PR on the deterministic head branch before creating
   (`prAlreadyOnHead`, lines 404-457). PR body composed by `composePrBody`
   (lines 43-87) with a back-link to the Viberr task, goal, live-compare
   change summary (`deliveredDiffStats`, lines 148-175 — the **actual**
   `base...head` diff, not the possibly-stale reconciled cache, F22-10), and
   evidence bullets. On success, `markWriteScopeProven(db, gh.patId)`
   (lines 522, 571) flips the cached `pull_request:write` scope from
   "unproven" to proven — the F28-U2a/F28-U2b fix, proven on the **credential
   that made the call**, not whatever is bound now.

### 3.2 Agent-self-delivered reconciliation — the complement path

For a specialist that branched/committed/pushed/opened a PR **with its own
git/gh credentials** outside viberr's PAT flow (notably Codex running with
danger-full-access) —
`app/server/github/workspace-delivery.server.ts:34-53` (module header).
`reconcileWorkspaceDelivery` (lines 231-651) runs **after** the run finishes,
inspects the run's workspace git repo, and reconciles `task.md` from what the
agent actually did: real branch (lines 310-322), real commits ahead of
default (with a shallow-clone deepen guard, lines 336-361), a fresh
`workRevision` mint (lines 378-402), and best-effort PR detection via `gh pr
view` (lines 472-625). Entirely best-effort and **never throws** — no
workspace/git/gh/creds/repo all no-op quietly (lines 47-53, try/catch at
lines 635-650).

### 3.3 Adopt-existing-PR-by-head-sha (R16-1)

`app/server/github/pr-adoption.server.ts` — `decidePrAdoption` (lines
52-74): a PR occupying a task's deterministic head branch may be **adopted**
only when it is `OPEN` **and** its head sha **equals** the task's delivered
`workRevision.headSha` — identity, not containment. This closes a real
production bug (H8): a brand-new `VIB-4` on a fresh data root (keys restart
at 1) adopted merged PR #113 from a *previous* instance's `VIB-4`, wearing a
false "merged" badge for work never delivered. A name-matched PR that fails
the identity check is reported as a **branch collision**
(`prAdoptionRefusalNote`, lines 104-118) and blocks delivery rather than
binding silently. Consumed by both `openTaskPr`'s `prAlreadyOnHead`
(`pr-open.server.ts:414-435`) and the workspace-reconcile path
(`workspace-delivery.server.ts:509-559`).

### 3.4 Divergence / periodic reconciliation

`app/server/github/reconcile-poller.server.ts` — `pollGithubReconcile`
(line 215) runs every 5 minutes (`RECONCILE_POLL_MS`, line 41) across every
branched task, budgeted at `RECONCILE_POLL_TASK_BUDGET = 20` tasks/project/tick
(line 884, in `github-reconciler.server.ts`) with an in-memory resume cursor
per project (`reconcileCursors`, line 891) so a large board is fully visited
across multiple ticks rather than spending the whole rate-limit budget at
once. `reconcileTask` (`github-reconciler.server.ts:827-855`) is
per-task-locked (`withTaskReconcileLock`) and never lets one task's
unexpected failure abort the whole project sweep (F21-9, lines 838-852). An
out-of-band PR-state transition (merged/closed on GitHub without going
through Viberr) **wakes the task's operator** (`OperatorWake`, trigger
`"pr-diverged"` — see `pr-divergence-operator.server.test.ts:27-40`) so the
divergence becomes a real decision packet instead of silent prose, and the
inverse (a closed PR reopened) both leaves a note and wakes the operator to
withdraw the now-moot packet.

### 3.5 Bring the branch up to date

`app/server/github/update-branch.server.ts` /
`update-branch-operator.server.ts` — merging the default branch into the
task branch is an **operator decision** (owner ruling N19-9, same shape as
delivery R15-2), gated by the `update-task-branch` capability
(`capabilities.ts:72-76`); the server executes the merge+push, agents never
rebase or force-push.

---

## 4. Acceptance & disclosure

### 4.1 The disclosure contract

`app/shared/acceptance-disclosure.ts` — Ruling 88 (F21-2). The accept-confirm
dialog renders three facts (what merges — the PR state; what was delivered —
the revision head sha; what the review said — the validation pill) and the
confirmed click must **echo them back** as three form fields
(`ACCEPT_DISCLOSURE_FIELDS`, lines 48-52: `ackPr`/`ackRevision`/`ackVerdict`).
`parseAcceptanceDisclosure` (lines 85-98) is deliberately strict: a
half-filled or unrecognized echo parses to `null`, which is treated
identically to a bare POST with no echo at all.

This closes a real regression: the pass-19 `AcceptDisclosure` server-side
enforcement was **lost in a two-session branch merge**
(`acceptance-disclosure.ts:11-12`), leaving the whole "human saw what merges"
contract as client architecture only — any bare POST (stale tab, replayed
form, script, browser console `fetch`) merged silently.

Server-side enforcement: `assertAcceptanceDisclosure`
(`app/server/tasks/task-actions.server.ts:7157-7187`), three-state `ack`
parameter:
- an `AcceptanceDisclosure` object — compared via `acceptanceDisclosureDrift`
  (`acceptance-disclosure.ts:137-157`) against `acceptanceDisclosureOf(fm)`
  (`task-actions.server.ts:7124-7132`, always derived from the canonical
  file, never the projection); any drift throws `ACCEPT_DISCLOSURE_STALE`
  (409) — the task moved under the dialog.
- `null` — the caller *is* a disclosure-bearing HTTP door and the request
  carried none; throws `ACCEPT_DISCLOSURE_MISSING` (400).
- **omitted** — an in-process caller (packet resolution's own identity pin,
  `applyRecommendation`, the full-autonomy operator) that carries its own
  disclosure/authority contract; skipped entirely (line 7163).

Checked **twice**: once in `acceptCompletion` right after the authority gate
and before any GitHub write (`task-actions.server.ts:7402-7412`, scope
`"full"`), and again **inside the write lock** in `applyAcceptanceWrite`
(`task-actions.server.ts:7266-7271`, scope `"in-lock"` — the PR-state fact is
skipped there because this very acceptance may just have merged it; revision
and verdict are still re-compared since nothing on this path writes them
first).

### 4.2 The "forced" fact

`app/server/tasks/task-actions.server.ts:7223-7228, 7303-7308` —
`applyAcceptanceWrite`'s `forced?: boolean` input sets
`parsed.frontmatter.acceptance = "forced"` as a **durable frontmatter field**
(N20-14 §5c), so the board/hero don't recompute a stale "awaiting verdict"
state onto an already-Done task force-accepted past the review gate. This is
gated by the admin-only `force-accept-completion` RBAC action (§1.2) and
audited (`task.acceptance.forced`); it bypasses process gates (verdict,
blocked packet — R19-5 also skips the workflow-graph position check) but
**never** the "irreducible" GitHub-terminal-fact gate
(`forceIrreducibleRefusal`, checked at both the outer call and again inside
the lock, `task-actions.server.ts:7286-7294`) — force cannot stamp "accepted"
over a PR GitHub actually closed mid-merge-attempt.

### 4.3 Merge is human-only, even at full autonomy

`attemptAcceptanceMerge` (`task-actions.server.ts:5173-5185`): `if
(!actor.userId) return { kind: "pending", cause: UNREACHABLE_MERGE_CAUSE }` —
a merge is **only attempted when the actor carries a real user identity**.
`mergeTaskPr`'s signature enforces this at the type level:
`actor: AuditActor & { userId: string }`
(`app/server/github/github-reconciler.server.ts:1119-1123`, required, not
optional).

The operator's full-autonomy acceptance path
(`operatorAcceptCompletion`, `app/server/tasks/operator-actions.server.ts:2806-2985`)
is the **one deliberate exception** to "an agent never transitions a task to
Done" (owner ruling Q1) — but even there, the comment is explicit
(lines 2919-2922): *"A REAL PR merge is attributed to a human (mergeTaskPr
requires a user identity), so the operator cannot merge — it records the PR
as 'accepted' (merge pending), never a false 'merged'. A human merges /
reconciles later."* The write always passes `prState: "accepted"`
(line 2939), never `"merged"`. Gated by the `completion-for-acceptance`
capability at mode `direct` **and** `authority.autonomy === "full"`
(line 2880); under supervised autonomy (or `recommend` mode) it only posts an
`accept_completion` recommendation card for a human to apply
(lines 2870-2917).

### 4.4 Reject → recovery → branch-deleted flow

Packet resolution options in `task-actions.server.ts` (~lines 5900-6270):
- `archive_task` (lines 5925-5955): requires `approve-transition`; optional
  `deleteBranch` triggers the *remote* branch delete via
  `deleteTaskRemoteBranch` (`github-reconciler.server.ts:1380`) after the
  resolution write.
- `discard_branch` (lines 5957-5985, R20-2/F20-6): discards the task's
  **local, never-pushed** workspace branch (destroys commits, so it also
  requires `approve-transition`); the actual git deletion and `fm.branch`
  clear happen after the resolution write records the decision
  (`push-workspace.server.ts:777` owns the local delete mechanics).
- `retry_other_backend` (lines 5900-5924): re-runs on the named backend and
  pins it via the engagement's `pinnedBackend` (F27-B1) so the switch sticks
  across later prompts.

**Post-merge branch cleanup** is a separate, opt-out policy:
`app/server/github/branch-cleanup.server.ts` — `branchCleanupOnMerge`
(lines 32-57), owner ruling R15-6: a merged PR's head branch is deleted by
default (**absence of the guardrail row means ON** — every pre-ruling
project keeps the old behavior without a rewrite; only an explicit `on:
false` guardrail turns it off). Deletion mechanics
(`deleteTaskRemoteBranch`) never touch the default branch or a branch with a
still-open PR.

---

## 5. Reviewer verdicts

### 5.1 The verdict gate (R15-1 / R19-B)

`verdictGateReason` — `app/server/github/pr-human-approval.server.ts:306-360`
— the **one** definition read by both the runtime acceptance path
(`acceptanceRefusalReason` in `task-actions.server.ts`) and the projection
(`acceptanceBlockReason` in `rebuilder.server.ts`), so the review queue and
the task page's accept button can never disagree. Logic:
- No `workRevision` at all ⇒ acceptable (planning/non-repo work never needed
  a verdict).
- Delivered work with **no PR** ⇒ refused, unless the branch is verified
  empty (durable `noChanges`, a live auto-detect just proven, or a
  `"verified"`-kind revision) — R17-2/R19-8/F28-L1.
- `validation === "healthy" | "failing"` clears/names the gate directly.
- **R19-B**: a project **member's own GitHub PR approval**, bound to the
  exact delivered revision (`humanVerdictApproval`, lines 210-220), **counts
  as the approving verdict** — closing the prior asymmetry where a human's
  *disapproval* (closing the PR) already bound the gate but their *approval*
  was inert. Fails closed with a named reason
  (`humanApprovalRefusalNote`, lines 247-286) when the handle is unlinked,
  ambiguous, non-member, or bound to a stale (superseded) commit —
  never silent.
- Otherwise: refused, naming the escape hatches (run a review, approve on
  GitHub, or admin force-accept).

### 5.2 Revision-bound review (F15-15)

Every `workRevision` mint is guarded by `nextWorkRevision`
(`app/schemas/task-file.schema.ts:877`) so a verdict binds to an immutable
`{id, headSha, treeSha}` triple — a new tree mints a new revision id, which
invalidates every prior verdict (F10-32 exception: same tree ⇒ same subject,
verdicts survive).

The reviewer's run prompt is **pinned** to that revision, not the local
workspace tip: `specialist-run.server.ts:1503-1511` computes `reviewSubject =
{headSha, prNumber}` from `existing.parsed.frontmatter.workRevision` for any
non-delivering engagement, and the prompt text (lines 2317-2326) instructs
the agent to verify `git rev-parse HEAD` (or ancestry via `merge-base
--is-ancestor`) actually equals that sha before judging, to diff the pinned
sha directly (`git diff <default>...<sha>`) if the local branch disagrees,
and explicitly: *"Never approve the local tree as a stand-in for the
delivered revision."* This is the direct fix for a live incident named in
the same comment block (line 2243): *"a PR opened over stale remote junk was
APPROVED by a reviewer that only ever read the local branch."*

A supporting (reviewing) run is also **workspace-isolated per engagement**
(pass 25's P8): it gets its own checkout under
`workspace/support/<profileId>/<repo>`, cloned from the delivering
checkout — so nothing it writes can ride `git add -A` into the delivered PR
even without tool-level enforcement (advisory on Codex since R22 removed the
sandbox). Prompt text: `specialist-run.server.ts:2317-2318`.

---

## 6. GOTCHAS & INVARIANTS for implementers

- **RBAC role checks must go through `ACTION_ROLES`/`requireAction`, never a
  hand-rolled role comparison.** The Policy page renders the exact same map
  (`rbac.ts:8-11`); a bespoke check silently drifts from what the UI
  advertises.
- **`view`/`comment` are not in the gate at all** — their enforcement is
  membership alone. Don't add a `requireAction(..., "view", ...)` call
  expecting it to do anything project-role-specific.
- **An org admin's override is a *fallback*, never a fast path** — it only
  fires when the actor's own membership role would be denied, and it always
  writes an audit row (except the rate-collapsed `"any-member"` case).
- **`capabilities: []` on an agent profile means full power for
  non-grant-required capabilities**, but withheld for the
  `GRANT_REQUIRED_CAPABILITY_IDS` set — the two axes have opposite defaults
  by design (`capabilities.ts:160-172, 377-391`). Every profile-creation path
  must persist explicit grants; never trust an empty array.
- **`content_hash` is written LAST, always.** Any new projection table added
  under the file-derived umbrella must follow the sentinel-then-commit-marker
  pattern (§2.3) or a crash mid-write becomes a permanently "unchanged"
  (and therefore never-repaired) projection row.
- **CRLF normalization happens once, in `splitFrontmatter`, before fence
  detection** — do not add a second normalization point; the closing-fence
  search already tolerated CRLF, which is precisely why the opening-fence gap
  was an *unconsidered* asymmetry (F28-D2), not a deliberate contract.
  Anything that re-parses `content` outside this function bypasses the fix.
- **`task_events.id` ordering direction is table-specific.** `id DESC` is
  correct for append-only tables (`notifications`, `audit_events`); it is
  **wrong** for `task_events`, which is rebuilt wholesale with position-0
  (newest) inserted first. Copy the tie-break, not the idiom.
- **The watcher's `ignoreInitial: true` depends on the boot rescan running
  first.** Starting the watcher before `rescanProjections` (or skipping the
  boot rescan) means any edit made while the server was down is silently
  never picked up until its next on-disk touch or a manual rescan.
- **Server-side delivery is the ONLY normal path that pushes/opens PRs**;
  agents are told never to `git push`/`gh pr create` even under an explicit
  operator directive (the contract "outranks any operator directive",
  `specialist-run.server.ts:2338-2341`). The workspace-reconciliation path
  (§3.2) exists only to catch an agent that bypassed this (own git/gh creds)
  — it is a safety net, not a second sanctioned delivery mechanism.
- **PR adoption is identity (head sha ==), never containment.** The
  acceptance gate's own head check (`acceptancePrHeadMismatch`) *does* accept
  containment (a PR head that contains the delivered commit, e.g. an
  auto-commit on top) — don't conflate the two; adoption is the stricter
  claim.
- **A merge always requires a real `userId`.** Any new acceptance/merge path
  must check this before calling `mergeTaskPr`, or it will throw at the type
  level (`userId: string`, non-optional) rather than degrade gracefully —
  the existing callers all pre-check and degrade to `"pending"` instead.
- **The acceptance disclosure echo is compared to the FILE, never the
  projection**, and is re-checked a second time inside the write lock. A new
  Done-writing path that skips either check reopens the exact hole R88/F21-2
  closed (and which was *previously* closed once already, then lost in a
  merge — see §4.1).
- **Force bypasses process gates, never GitHub-terminal facts.** Any new
  "force" style override must call the same `forceIrreducibleRefusal`
  pattern, both at the initial check and again inside the write lock.

---

## 7. SUSPECTED ISSUES

These are things noticed while reading, not independently reproduced in this
pass — flagged for follow-up verification, not asserted as bugs.

1. **Codex repo-write enforcement is advisory only, by design (R22), and the
   server-owned delivery gate is the sole real boundary for that backend.**
   `CLAUDE_ONLY_ENFORCED_CAPABILITY_IDS` (`capabilities.ts:270-283`) admits
   this outright ("the whole repo-write family is claude-only now"). The
   comment frames this as a deliberate trade for removing Codex's OS sandbox
   ("viberr itself is the sandbox"), but it does mean a Codex run with
   `execute-code-or-write-repo` withheld can still `Edit`/`Write`/commit
   inside its own workspace — the *server* just won't push/PR it. Worth
   re-confirming this framing still holds for whatever Codex is doing today
   (e.g. can a withheld Codex specialist still push directly with its own
   `gh`/network access if it has one, sidestepping the "no push creds"
   assumption in §3.1?).

2. **The `execute-code-or-write-repo` absence-repair in
   `specialistGrantModes`** (`specialist-tool-policy.ts:119-131`) only fires
   when the headline capability is **absent** and a scoped delivery grant
   (branch/commit-push/open-PR) is `direct`/`recommend`. An explicit `off` on
   the headline is never overturned (documented as intentional, lines
   103-118) — but this means a profile authored with `execute-code-or-write-repo:
   off` plus `commit-push-branch: direct` will have push-branch **shown** as
   grantable in the editor / advertised in the matrix while the tool layer
   denies `git commit` outright. Whether the UI actually surfaces that
   incoherent combination clearly (vs. just letting the run fail confusingly)
   wasn't verified in this pass.

3. **`reconcileWorkspaceDelivery`'s PR-detection step (§3.2) shells out to the
   run's own `gh` binary** (`workspace-delivery.server.ts:477-491`) using
   whatever auth context that process had. If a Codex run's sandbox is now
   network-enabled by default under `workspace-write` (per the R22 change
   noted in memory), this reconciliation path and the "no push credentials"
   framing in §3.1 may be describing two different eras of the sandbox model
   — worth cross-checking against the current Codex runtime config
   (`app/server/runtimes/`) rather than assuming the F-GH3-era comments still
   describe the live default.

4. **The `AUDIT_DEDUPE_MS` window (60s) for `project.authority.denied` rows**
   (`project-authority.server.ts:104-124`) is keyed on `(actor, project,
   action)` without the `what` copy fragment for the *denial* case (only the
   override case's key includes `what`, line 212). Two different denied
   actions by the same actor within 60s that happen to share an `RbacAction`
   id (e.g. two different `run-agents` attempts with different `what` text)
   would collapse into one audit row, potentially under-recording distinct
   probes. Not verified live; flagged from reading the key construction at
   lines 239-241 vs. 212.

5. **`no_repo` exclusion from the F28-L1 auto-detect** — per session memory
   this was a recent fix ("F28-L1: re-apply the no_repo auto-detect
   exclusion, lost in a checkout") and is mentioned in
   `workspace-delivery.server.ts:280` (`if (!repo) return noop("no_repo",
   ...)`). Given the memory note that this exact exclusion was previously
   lost via `git checkout -- app`, it's worth a quick regression check that
   it's still present on `main` (this pass only confirms it exists in the
   current worktree, not that it survived the merge to main).

---

## Appendix: file index

| Area | Path |
|---|---|
| RBAC matrix | `app/shared/rbac.ts` |
| Org roles | `app/shared/mapping/user.server.ts` |
| Authority resolution | `app/server/auth/project-authority.server.ts` |
| Capability catalog | `app/shared/capabilities.ts` |
| Specialist tool policy | `app/server/tasks/specialist-tool-policy.ts` |
| Frontmatter parse/serialize | `app/server/files/frontmatter.server.ts` |
| Task file writer | `app/server/files/task-writer.server.ts` |
| Project file writer | `app/server/files/project-writer.server.ts` |
| Projection rebuilder | `app/server/projections/rebuilder.server.ts` |
| Full rebuild (drop+rebuild) | `app/server/projections/rebuild.server.ts` |
| Scoped/boot rescan | `app/server/projections/rescan.server.ts` |
| Activity feed (tie-order) | `app/server/projections/activity-feed.server.ts` |
| File watcher | `app/server/files/file-watch.service.server.ts` |
| Boot sequence | `app/server/boot.server.ts` |
| Branch create/compare | `app/server/github/branch-sync.server.ts` |
| Server-side push | `app/server/github/push-workspace.server.ts` |
| PR open/reuse | `app/server/github/pr-open.server.ts` |
| PR adoption rule | `app/server/github/pr-adoption.server.ts` |
| Agent-self-delivery reconcile | `app/server/github/workspace-delivery.server.ts` |
| Merge / branch delete / reconcile | `app/server/github/github-reconciler.server.ts` |
| Poller | `app/server/github/reconcile-poller.server.ts` |
| Branch cleanup policy | `app/server/github/branch-cleanup.server.ts` |
| Human PR-approval-as-verdict | `app/server/github/pr-human-approval.server.ts` |
| Acceptance disclosure contract | `app/shared/acceptance-disclosure.ts` |
| Acceptance/accept-write/reject flow | `app/server/tasks/task-actions.server.ts` |
| Operator full-autonomy acceptance | `app/server/tasks/operator-actions.server.ts` |
| Reviewer prompt / revision pinning | `app/server/tasks/specialist-run.server.ts` |
