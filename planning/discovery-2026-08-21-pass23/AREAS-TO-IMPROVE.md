# Pass 23 — areas to improve (discovery backlog)

Critical, prioritized backlog of genuine gaps for the next implementation phase.
Every item is grounded in code read this pass (file:line, all paths relative to
the repo root) or in this pass's live log; claim/behavior pairs were verified
against the named server modules, not inferred from UI copy alone.

Already fixed this pass and NOT re-listed: **BUG-1** (web-egress editor display
+ silent on→off flip) → **PR #194**; **BUG-2** (@operator "picking it up" toast
on a refused run) → **PR #195**. Pass-22's shipped F1–F4 (boot self-heal, seed
Developer→Claude, model-availability signal, github_read) are DONE and excluded.

Severity: **HIGH** = an admin/user is actively misled, or work/data is lost;
**MEDIUM** = confusing, wasteful, or a real gap with a workaround; **LOW** =
polish. Items are ordered by severity within each theme.

---

## A. Coherence / honesty (UI says X, the runtime does Y)

### A1. HIGH — BUG-1's display fix reached only the editor: the capability MATRIX, read-only profile DETAIL, and POLICY counts still misrepresent absent permissive-default grants

The owner ruling on BUG-1 kept web egress ON for an absent
`use-web-search-fetch` grant and fixed the EDITOR to seed absent toggles from
the runtime-effective mode (`app/features/agents/create-profile-modal.tsx:148-185`,
PR #194). Every OTHER capability surface still renders only PERSISTED grants:

- `effectiveProfileView` builds a specialist's grants from
  `deployment.capabilities` alone — an absent grant produces NO row
  (`app/features/agents/agents-query.server.ts:310-319`, buckets at `:389`).
  The one materialization that exists is operator-only `deliver-review-pr`
  (`agents-query.server.ts:295-309`) — the exact pattern the rest needs.
- The **capability matrix** maps "in no bucket" to **"Not granted"**
  (`app/features/agents/capability-matrix-modal.tsx:25-32`, legend `:118-121`).
- The **profile detail** columns filter the same buckets, so an absent
  capability is OMITTED entirely (`app/features/agents/agents-page.tsx:648-653`,
  columns `:807-811`).
- The **Policy page** per-profile counts ("N direct") sum the same buckets
  (`app/features/policy/policy-page.tsx:319-333`).

Live instances on a FRESH SEEDED install (the default experience): the seeded
Operator, Developer and Reviewer all omit "Search & fetch from the web"
(`app/server/seed/agent-catalog.server.ts:110-112,153-155,179-184`), so the
matrix shows their web-egress cells as **"Not granted"** while WebFetch/
WebSearch run (live-proven in BUG-1; operator polarity at
`app/server/runtimes/operator-run.server.ts:991,2355` — absent ⇒ tools kept).
The matrix's own footnote — "The Claude operator can reach the web … when
Search & fetch from the web is granted" (`capability-matrix-modal.tsx:272-276`)
— sits directly under a cell claiming it is not granted. Same family: the
seeded Developer omits `attach-evidence-references` (catalog default `direct`,
`app/shared/capabilities.ts:138`) — the matrix says "Not granted", the
completion pipeline honors it.

Why it matters: post-#194 the three read surfaces now contradict the EDITOR
too (editor "Allowed"; matrix/detail/policy "Not granted"/omitted). An admin
auditing egress from the matrix — the surface built for exactly that audit —
gets the wrong answer; the BUG-1 threat model is unchanged on those surfaces.

Fix direction: materialize every catalog capability for display at its
runtime-effective mode in `effectiveProfileView` (mirror the
`deliver-review-pr` materialization, keyed off `GRANT_REQUIRED_CAPABILITY_IDS`
+ catalog `defaultMode` — the single source of truth PR #194 established at
`app/shared/capabilities.ts:393-400`). One writer, all four surfaces agree.
Optionally distinguish "granted (default)" from "granted (explicit)" in the
cell title so an explicit `off` (a real withholding) stays readable as such.

### A2. HIGH — KB delete-confirm hides that every DOCUMENT is permanently destroyed, and its grant count sees only org templates

Two dishonesties in one dialog (`app/features/org-settings/resources-panel.tsx`):

1. **Undisclosed permanent data loss.** The whole disclosure is "The index is
   removed from the store." (`resources-panel.tsx:290-293`) — but the server
   runs `rmSync(kbDirPath(kb.dir), { recursive: true, force: true })`
   (`app/server/org/resources.server.ts:412`): the entire folder of documents
   (uploads, agent-appended docs) is irreversibly deleted, not "the index".
   The sibling folder-delete in the store browser discloses correctly ("N
   files inside will be removed…",
   `app/features/kb-browser/store-browser.tsx:517-525`) and the KB row already
   carries a `fileCount` the dialog could cite.
2. **The grant tail counts only ORG TEMPLATES.** `usedBy` filters `gagents`
   (`resources-panel.tsx:136-137`); zero ⇒ "No agent template grants it."
   (`:36-40`, used `:290-303`) — read as "nothing uses this". Meanwhile the
   delete ALSO walks every `project.md` and silently drops the grant from
   every project DEPLOYMENT
   (`app/server/org/resource-references.server.ts:138-182`). Live this pass
   (UC-18): the Viberr developer granted the KB, the tail said no template
   grants it, and the grant was dropped without a word. The >0 branch is wrong
   too — "dropped … from every project that deployed them" also covers
   project-CREATED agents that never came from a template.

Fix direction: cite the real file count and "permanently deletes the folder";
compute a second server-side count of project-deployment grants (the read-only
twin of `rewriteProjects`' walk) and render "N template grant(s) + M project
agent grant(s) will be dropped". The MCP/skill dialogs share the grant-tail
half of the defect (`resources-panel.tsx:294-303`). Related residue: the
reference rewrite itself is best-effort per file — per-file failures are
`logger.warn` only and NOT counted, and every caller ignores even the returned
`updated` count (`resource-references.server.ts:119-127,172-180`; callers at
`resources.server.ts:350,415,1583,1727,2034,2110`), so a partially-failed
rename leaves stale grants with a success toast.

### A3. HIGH — remove-member confirm promises a task reassignment that does not exist

The dialog says "Task assignments return to the operator for reassignment."
(`app/features/org-settings/users-panel.tsx:802-812`, copy at `:806`). The
server (`app/server/org/org-users.server.ts` — `deleteOrgUser` `:372-416` +
`pruneUserFromProjects` `:328-361`) prunes memberships, deletes the identity
and sessions — nothing anywhere touches task ownership; no return-to-operator
mechanism exists in `app/server/tasks/`. Owned tasks keep `owner_user_id`
pointing at a deleted account (`app/server/projections/board-query.server.ts:164-174`
renders the ghost). The owner seat carries acceptance authority (R6-2), so a
removed member's tasks strand at the review boundary while the admin believes
they flowed back to the operator. Fix direction: either build the promised
behavior (clear `ownerUserId` + operator packet per affected task) or tell the
truth in the dialog and list the tasks that will be left ownerless.

### A4. MEDIUM — removing an org GitHub connection silently kills bound projects' sync while the dialog reassures the opposite

Confirm copy: "Projects already created from X keep their repos; new projects
can no longer select it." (`app/features/org-settings/connections-panel.tsx:357-376`).
But `removeConnection` also deletes the PAT (`app/server/org/connections.server.ts:578-579`),
and `deletePat`'s own contract is "project bindings cascade"
(`app/server/secrets/pat-store.server.ts:181-198`) — every project bound to
that credential loses branch/PR sync on the click. The project-side "Remove
credential" dialog discloses exactly this ("Branch and PR sync go offline…",
`app/features/github/credential-card.tsx:184-189`); the org-side one names
only the harmless consequences. (The default connection is protected —
`connections.server.ts:571-576` — so single-connection installs cannot hit it;
multi-connection ones can.) Fix direction: count the bound projects and say
"N project(s) lose branch/PR sync until a new credential is bound."

### A5. MEDIUM — delete-project dialog over-claims: audit logs are NOT removed

Both the dialog and the danger row say "Removes tasks, timelines, and audit
logs. This cannot be undone."
(`app/features/project-settings/settings-page.tsx:1424-1428,1533-1535`). The
server deliberately KEEPS audit rows and even writes a fresh `project.deleted`
row (`app/features/project-settings/settings-actions.server.ts:969-1015`, its
contract comment: "Audit logs keep the trail"). Reverse dishonesty — someone
deleting a project to scrub history is told the trail goes too; it also
contradicts the app's consistent "the audit trail always survives" vocabulary
elsewhere (archive dialogs, member removal). One-line copy fix.

### A6. MEDIUM — the human-only Done boundary is stated unconditionally on two surfaces that the Review queue contradicts

The canonical exception (a full-autonomy operator holding
`completion-for-acceptance: direct` accepts into Done itself) is disclosed
conditionally on the Review queue (`app/features/review/review-page.tsx:213-228`)
and Policy → Workflow rules (`app/features/policy/policy-page.tsx:533-583`),
with `TRANSITION_TO_DONE_EXCEPTION`'s doc ordering "Do not inline the phrasing
anywhere else — import it" (`app/features/policy/policy-data.ts:63-95`). Two
surfaces still state the boundary flatly:

- Task-detail Permissions panel: "Human decision, locked at the review
  boundary" on every project
  (`app/features/task-detail/task-side-panels.tsx:419-423`).
- Org agent-template editor: "Done is closed by a human, never by an agent"
  (`app/features/org-settings/agent-template-modal.tsx:298`; the code comment
  above it acknowledges the exception the rendered copy omits).

On a full-autonomy project the task page is flatly false one click from the
queue that says the opposite — the P13-D-9 defect class on the surface users
read most. Fix: import the canonical conditional phrasing on both.

### A7. MEDIUM — manual "Run operator" toast lies when the run was refused (BUG-2's sibling in a second route)

`app/routes/project.task.tsx:905-931` (`run-operator` intent): the route calls
`runOperator` and checks `started.refused` ONLY to decide whether to record
the steer comment (`:913`); the toast (`:928-931`) branches on `queued` alone,
so a refused start (`refused: "open-packet" | "terminal-stage"`,
`app/server/runtimes/operator-run.server.ts:1052-1084`) toasts **"Operator
running · Claude · full autonomy"** for a run that never started. Reachable
when a packet opens after page load (SSE race) or via a crafted POST — the
same class PR #195 fixed for `commentToAgent`. Fix identically: branch the
toast on `started.refused` ("resolve the open decision" / "reopen the task").

### A8. MEDIUM — @mention comment whose agent run fails to start: the comment IS posted, but the user sees only an error (BUG-2's shape, specialist branch)

PR #195 covered the operator refusal. The SPECIALIST paths still have the
partial-success gap: `commentToAgent` records the comment FIRST, then
`startAgentRun`/`resumeRun` can throw — single-flight conflict, backend not
configured, stage eligibility
(`app/server/tasks/task-actions.server.ts:1252-1318`; the throw reaches the
route catch at `app/routes/project.task.tsx:987-989`). An `AppError` becomes a
bare error toast (`app/server/auth/form-action.server.ts:24-30`); anything
else hits the error boundary. Nothing says "your comment DID post — only the
run didn't start". Fix: catch run-start failures inside `commentToAgent`,
return `triggered: null` + a typed reason, toast "Comment posted · run not
started: <reason>".

### A9. MEDIUM — acceptance proceeds without saying the PR-head check could not run

`verifyPrHeadContainsDelivery` returns `null` for BOTH "verified: PR contains
the delivered revision" and "could not verify" (GitHub unreachable, compare
failed — `app/server/tasks/task-actions.server.ts:6115-6147`, catch `:6141-6147`
logs "treated as unknown"). The acceptance ceremony (which carefully discloses
merge/revision/verdict) shows no "head could not be verified" caveat, so the
human cannot distinguish a verified accept from an unverifiable one — an R15-1
disclosure-completeness gap on the highest-stakes click.

### A10. LOW — Review-queue footer states "Accepting a completion merges the review PR" absolutely

`app/features/review/review-page.tsx:259-277` — both footer variants promise a
merge unconditionally; the accept ceremony itself discloses the two designed
no-merge paths (verified no-change completion R17-2; no-PR auto-detect
F20-6/R20-2 — `accept-confirm.tsx`, `task-detail-page.tsx:852-858`). Soften
the footer to match.

---

## B. Capability model

### B1. MEDIUM — the profile EDITOR discloses no per-capability enforcement scope (the matrix's "Claude-enforced" tag is missing where grants are actually made)

The matrix tags claude-only rows ("Claude-enforced … advisory on Codex",
`app/features/agents/capability-matrix-modal.tsx:156-170`, legend `:122-125`)
via `capabilityEnforcement` (`app/shared/capabilities.ts:285-296`). The EDITOR
imports none of it (`create-profile-modal.tsx` — no `capabilityEnforcement`
usage, verified by grep). On a Codex-pinned profile:

- Granting **`read-github-api`** renders a normal "Allowed" toggle, but the
  tool is NEVER mounted on Codex (deliberate credential-security design,
  `app/shared/capabilities.ts:118-128,270-283`) — the grant is inert and the
  editor doesn't say so.
- Withholding **`execute-code-or-write-repo`** / scoped delivery /
  `comment-on-task` reads as enforcement but is advisory on Codex since R22
  removed the sandbox (`capabilities.ts:260-283`).

The editor already holds the profile's backend state (model picker), so a
per-row scope hint is cheap and stops an admin trusting a toggle that cannot
bind on the chosen backend.

### B2. MEDIUM — backend QUOTA exhaustion still has zero pre-run signal (carried from pass 22, refined by live VIB-5)

Deliberate: quota/auth failures are never persisted as availability marks
(`app/server/runtimes/model-availability.server.ts:25-31` — only "model not
supported" sentences match), so pass-22 F3's run-control warning covers the
unsupported-model class only. Live (VIB-5): the operator engaged the Codex
Dev, the run failed on quota, the recovery packet ("Retry on Claude") closed
the loop — graceful, but every future assignment to that profile until the
provider's own stated retry date ("Sep 18") repeats the fail-then-recover
cycle with no hint at assignment or on the run control. Fix direction: a
short-TTL TRANSIENT signal (`kind: "quota"` + `expiresAt` parsed from the
provider sentence) surfaced in the same slot F3 built — auto-expiring so it
never becomes the stale pseudo-check ruling 19 bans. Needs the owner's nod
(pass-22 Q2 left it open).

---

## C. Silent drops / error handling (user-facing failures that only reach the server log)

This codebase is unusually disciplined about surfacing failures; these are the
residual genuinely-silent paths, ranked.

### C1. MEDIUM — `autoInvokeOperator` swallows every failure: the operator silently never wakes

`app/server/tasks/task-actions.server.ts:668-725` (catch `:718-723`,
`logger.error` only). This is THE seam that wakes the operator on `create`,
`transition`, `goal-updated`, `pr-diverged`, `delivered`, `packet-resolved` —
every caller is fire-and-forget. A throw before a run row exists means the
human creates a task or resolves a packet and coordination just… stops: no
timeline note, no toast, no waiting-state change. Fix: on failure, write a
system timeline note ("the operator could not be started — <reason>; run it
manually") and/or notify watchers.

### C2. MEDIUM — queued @operator human turns can be dropped at the cap or die at fire time, with only a log

`app/server/runtimes/operator-run.server.ts`: beyond 8 queued human comments
the OLDEST is shifted off with `logger.warn` (`:363-401`); a queued trigger
that throws when fired gets `logger.error` only (`:461-466`, `:489-494`) and
nothing flips the waiting state. The comments sit on the timeline looking
delivered (a later drive MAY read them in its snapshot — the drop is of the
dedicated turn, not necessarily of the answer), but the module's own doc
claims "no trigger is ever silently dropped" (`:1087-1093`). Fix: timeline
note on drop/fire-failure, or at least a notification to the commenter.

### C3. MEDIUM — an agent's final reply can vanish: the reply-posting pipeline is a floating promise with a log-only catch

`app/server/tasks/task-actions.server.ts:1712-1719` — the timeline comment,
`recordAgentRepliedAudit`, and the @mention fan-out to humans all ride one
promise whose `.catch` is `logger.error("agent reply comment write failed")`.
The run shows finished; its report and any human notifications are gone; only
the raw run log holds the text and nothing points there. Fix: retry once, then
write a fallback system note ("the agent's report could not be posted — see
the run log").

### C4. MEDIUM — a completion-effects crash leaves the board on "agent working" until the next restart

`app/server/tasks/task-actions.server.ts:2434-2442` (completion handler
failed), `app/server/runtimes/run-service.server.ts:146-152,1196-1202`
(callback failures), waiting-flip fallbacks at
`task-actions.server.ts:2963-2973,2983-2996` — all log-only. If
`applyAgentCompletionEffects` throws, reply/verdict/reconcile/react and the
waiting flip are lost; the task reads `waiting: agent` with no live run. Boot
recovery (`run-recovery.server.ts`) replays — but only after a restart, and
its own re-invoke/replay caps are warn-only too
(`run-recovery.server.ts:122-131,274-282,326-333`). Fix: a failed completion
handler should stamp the task with a visible continuity problem (the
continuity-recovery surface already exists).

### C5. MEDIUM — a verdict-granted reviewer that finishes with no determinable verdict is logged, never surfaced

`app/server/tasks/task-actions.server.ts:2589-2605` — fail-safe on the gate
(validation left unchanged — correct), but the human sees a completed review
run with no verdict recorded and no timeline note that the judgment was lost;
they must diff run logs against validation state to notice. Fix: a system
timeline note ("the reviewer finished without a readable verdict — validation
unchanged; re-run or record one manually").

### C6. MEDIUM — an MCP registry read failure erases the disclosure layer for ALL declared MCPs

`app/server/tasks/specialist-mcp.server.ts:133-137` — `listMcpServers` throw ⇒
`return { servers: {}, unresolved: [] }`: every declared grant vanishes with
no `unresolved` entry, no log — the exact silence the module's own P13-KM-11
comments say was fixed (its normal path lands every dropped grant in the
run-inputs disclosure). Same shape in `verifyStdioMcpMountsForRun`'s registry
read (`:239-243`, returns unchanged — less harmful). Fix: registry failure ⇒
every requested name lands in `unresolved` with "registry unreadable".

### C7. MEDIUM — persistent GitHub reconcile-poller failure is invisible: out-of-band merges stop reconciling forever with only a repeating warn

`app/server/github/reconcile-poller.server.ts:140-146` (per-project),
`:149-156` (nudge), `:197-211` (tick) — a revoked PAT or network issue means
PRs GitHub merged/closed days ago still show open on the board, and every
5-minute tick logs the same warn with no notification, timeline note, or
health surface. (The Repository page's Connection pill only updates when that
page runs its check.) Fix: after N consecutive failures for a project, raise
one deduped policy notification ("GitHub sync failing since <t> — check the
credential").

### C8. LOW/MEDIUM — attachments store: silent 100-file truncation, no quota, no retention (carried from pass 22 — still open)

`app/server/files/task-attachments.server.ts:35,64` — `LIST_CAP = 100`,
`slice(0, LIST_CAP)`, no truncation flag; the panel renders no "N more not
shown" (`app/features/task-detail/attachments-panel.tsx` — verified by grep).
Browser-capable agents save snapshots every run (live VIB-4), so a long-lived
task silently hides its OLDEST evidence. No size quota or retention exists
(module header `:8-25`, deliberate). Fix: return `{ entries, total }`, render
"showing 100 of N"; owner decision on quota/retention.

### C9. LOW — workspace reclamation is boot-only; storage has no visibility anywhere

`app/server/tasks/workspace-retention.server.ts:39-41` — terminal-stage
workspace reclamation runs at boot only, so a never-restarted container
accumulates Done-task clones indefinitely; `.repo-mirror` caches are unbounded
by design (`app/server/tasks/repo-mirror.server.ts:23-49`) and nothing in
Instance settings shows disk usage for mirrors/workspaces/attachments. Fix: a
periodic reclamation tick + a storage line in diagnostics.

### C10. LOW — smaller silent-drop residue (one line each)

- `notifyTaskWatchers` recipient-resolution failure ⇒ notifies nobody, callers
  can't tell (`app/server/tasks/task-mutation.server.ts:149-171`).
- Post-run delivery reconcile is double-swallowed: `{status:"skipped",
  reason:"unexpected error (swallowed)"}` at `logger.info`
  (`app/server/github/workspace-delivery.server.ts:635-650`) and both callers
  ignore `status` (`task-actions.server.ts:2817-2826,4076-4085`).
- Empty-branch cleanup after a no-change acceptance: refusals get timeline
  notes, THROWS get only a warn — the branch quietly persists
  (`task-actions.server.ts:6925-6931`).
- Stuck-loop escalation failing/refused leaves `waiting: human` with no card
  saying why (`task-actions.server.ts:1825-1836`).
- `.git/info/exclude` write failure can leak mounted skill files into the
  delivered PR — warn only (`app/server/runtimes/skill-mount.server.ts:337-349`).
- Schedule runner: boot catch-up failure has an EMPTY catch
  (`app/server/tasks/schedule.server.ts:582`), and the interval handle is
  module-scoped (`:573-574`) instead of the `Symbol.for` slot the
  reconcile-poller documents as the HMR-safe convention
  (`reconcile-poller.server.ts:168-184`) — a dev reload can stack intervals
  and double-fire schedules (duplicate operator runs).
- Audit writes fail open with `logger.error` — the compliance trail silently
  thins (`app/server/audit/audit-recorder.server.ts:83-89`).
- A hand-edited/stale shipped `operator.md` ("doctrine N releases old") is
  disclosed only as a boot warn, never in the UI
  (`app/server/seed/default-assets.server.ts:354-368`).
- Run reservation write failure ⇒ the run prepares invisibly (no strip row)
  (`app/server/runtimes/run-service.server.ts:386-392`).

---

## D. UX / first-run

### D1. MEDIUM — first task in a project: "Preparing workspace · Cloning owner/repo" is a static label for a multi-minute cold clone (live: ~2 min on a 129 MB repo)

The R21-4 reservation made the strip EXIST during the clone, but nothing
changes for the whole download: the step is set once
(`app/server/tasks/specialist-run.server.ts:1294-1296`) and next updates only
AFTER the clone (`:1333-1336`); the clone runs with no `--progress` capture
(`app/server/tasks/repo-mirror.server.ts:288-291` mirror create, `:433-435`
local cut); the strip shows the static step + elapsed clock
(`app/features/runtime/runs-panels.tsx:210-241`). Only the FIRST task pays
this (the mirror serves later tasks in seconds) — which is exactly why it
lands on the first-run experience and "looks stalled for minutes" (LIVE-LOG
VIB-1). Fix (either/both): (1) cheap honesty — `cloneWorkspaceRepo` knows when
it is CREATING the mirror; thread that out so the step reads "first task in
this project — this can take a few minutes"; (2) real progress — spawn the
mirror-create clone with `--progress`, parse "Receiving objects: NN%" and call
`pending.reservation.phase(...)` on a throttle (the reservation API already
supports step updates, `specialist-run.server.ts:1333`).

### D2. MEDIUM — one destination, two names: nav says "Org settings", the page and every direction say "Instance settings"

The only nav entry is "Org settings"
(`app/features/shell/user-menu.tsx:181`); the page H1 is "Instance settings"
(`app/features/org-settings/org-settings-page.tsx:92`); directions split —
"Instance settings →" (`app/features/home/new-project-modal.tsx:168-199`,
`app/features/home/project-create.server.ts:289,321`) vs "org settings"
(`app/server/github/github-actions.server.ts` — via
`app/features/github/credential-card.tsx:187-188`,
`app/features/project-settings/settings-actions.server.ts:414`,
`app/features/profile/profile-page.tsx:166`). Users — especially non-admins
relaying an error message to their admin — hunt for a surface whose advertised
name is not in the menu. Pick one name.

### D3. LOW — board "New task" is a silent no-op on a stage-less project

`app/features/board/board-page.tsx:1994-2000` — `onNew={() => { if (stages[0])
setCreating(true); }}`: the button renders enabled and the click does nothing
(no dialog, no toast, no reason) — the repo's own refusal-must-never-be-silence
rule (P14-LV-08/MU-4). Disable with a stated reason or toast.

### D4. LOW — org profile empty state advertises a "model" field the org editor doesn't have

`app/features/org-settings/resource-rows.tsx:496-500` says a profile defines
"its backend, model, skills and grants"; the org `AgentModal` has no model
picker (model is chosen per-project at deploy,
`create-profile-modal.tsx`). First-run guidance promising a control the next
screen lacks.

### D5. LOW — a model-catalog fetch failure deadlocks profile Save with no error and no retry

`app/features/agents/create-profile-modal.tsx:1091-1098,1129-1130,1160-1175` —
if the `/resources/model-catalog` load fails, `modelPending` stays true
forever and the footer instructs "Pick a model … Saving is held until this
profile has one" over an empty picker. Add an error state + retry.

### D6. LOW — "1 profiles" on the Policy page

`app/features/policy/policy-page.tsx:283-285` — the one un-pluralized count in
a codebase that pluralizes fastidiously via `countLabel`. A project rendering
only its operator shows "1 profiles".

---

## E. Test coverage (risky logic with missing/weak tests — coverage is otherwise strong)

### E1. MEDIUM — the mirror-CLONE-failure fallback arm is untested

`app/server/tasks/repo-mirror.server.ts:427-453` — the tested fallback
(`repo-mirror.server.test.ts:199`) breaks mirror CREATION; the arm where the
mirror is healthy but `git clone <mirror> <dest>` (or the origin rewrite)
fails — warn + `rmSync(destination)` + direct GitHub clone — has no test. If
the `rmSync` cleanup regresses, the half-written destination makes the
fallback clone refuse the non-empty dir and EVERY run on that project fails at
clone, attributed to GitHub. (Verified against the hot-spot list: rebuild-
after-2-failures `:263`, stale-serve `:238`, read-side no-create are all
covered — this is the one missing arm.)

### E2. MEDIUM — preparation-failure reservation release is unit-tested but never through the real throw sites

`app/server/tasks/specialist-run.server.ts:1059-1067` (wrapper catch →
`abandon`) and `app/server/runtimes/operator-run.server.ts:1225-1231`
(abandon + lease release): `run-service.server.test.ts:1148-1254` proves
`abandon()` semantics by calling it directly; no test makes `dispatchAgentRun`
throw AFTER `reserveRun` (`:1284`) or an operator launch throw while holding
the lease. A wiring regression leaves a phantom `running` row holding the
delivering single-flight slot — the task refuses every further run until
restart (the R21-4 failure the code comments warn about).

### E3. MEDIUM — `decidePrAdoption` fail-closed arms have zero tests; the module has no direct test

`app/server/github/pr-adoption.server.ts:52-74` — the codified fix for the
live H8/VIB-4 incident (a fresh task wearing a merged stranger-PR's badge).
`workspace-delivery.server.test.ts:406,455` cover `merged`/`head_mismatch`;
nothing covers `no_revision`, `head_unknown` (fail closed), the
`closed`-vs-`merged` refusal split, or the per-arm refusal copy. A flipped
falsy check silently re-enables cross-instance PR adoption. Pure decision
table — cheap to pin.

### E4. MEDIUM — reconcile-poller failure isolation and lifecycle untested

`app/server/github/reconcile-poller.server.ts:128-146,149-156,192-218` — all
5 existing tests cover `pollGithubReconcile` happy/skip/nudge. No test proves
one project's throw doesn't abort the remaining projects, a nudge failure
doesn't fail the poll, or a second `start` is a no-op. Regression: one
misconfigured PAT silences divergence detection for every other project,
invisibly (compounds C7).

### E5. MEDIUM — `org.settings.tsx` action has essentially no route-level tests

`app/routes/org.settings.tsx:161-470` — intents with zero test references:
`connection-add/default/replace`, `user-edit`, `invite-github/google`,
`oauth-remove`, `mcp-save/test/delete`, `skill-delete`, `agent-delete`. The
org functions are tested; route-only logic is not — notably the self-demotion
guard DUPLICATED in `user-edit` (`:221-226`; only its `user-role` twin
`:213-219` is tested) and the `agent-delete` in-use → 409 mapping
(`:454-457`). A regressed `user-edit` guard lets an admin self-demote — org
lockout when they were the last one.

### E6. LOW/MEDIUM — `withActionWatchdog` (F20-1's wall-clock guard) is completely untested

`app/server/actions/action-watchdog.server.ts:28-56` — no test that the timer
fires the typed 503, is cleared on success, or spares a slow-but-successful
action. It is meant to wrap every mutating entry point, so a regression scales
with adoption.

### E7. LOW/MEDIUM — `pruneStaleMirrors` is an untested recursive delete beside the live mirror

`app/server/tasks/repo-mirror.server.ts:373-385` — `rmSync(recursive)` on
every sibling keyed on a `basename` comparison. No test changes a project's
repo and asserts the old mirror is evicted while the new survives. A wrong
comparison silently deletes the just-built mirror every clone (re-paying the
full download — the failure policy absorbs it invisibly) or never evicts
(unbounded growth). Related: no retention-side test runs
`reclaimTerminalTaskWorkspaces` with a `.repo-mirror` present.

### E8. LOW — `repo-access-check` GitHub-error classification untested

`app/server/github/repo-access-check.server.ts:41-84` — the regex mapping
(expired vs revoked vs org-approval vs forbidden vs network) drives the
Repository page's Connection pill; drift misdiagnoses a revoked PAT as a
network blip. Pure and cheap to table-test.

### E9. LOW — route-glue dispatch untested for several governance intents

`app/routes/project.task.tsx:519-542` (`request-maintainer-decision`),
`:933-960` (`schedule-action` — the route-only `requireRunAgents` gate and the
`delayMinutes` NaN→1 clamp), `app/routes/project.settings.tsx:170-190`
(`repair-repo`, `set-branch-cleanup`), plus `run-reviewer`. Functions tested,
authority-gate placement and field parsing not. Also: the four-surface
capability display of A1 needs a cross-surface agreement test against
`resolveSpecialistDisallowedTools` (the F15-20 "display asserts a mode the
runtime does not use" class — third recurrence: F15-20, BUG-1, A1), and the
`workspace-delivery` outer catch-all contract (`workspace-delivery.server.ts:635-650`)
is untested.

---

## F. Other / held (owner decisions, carried forward)

- **Browser-agent authenticated browsing** (pass-22 A1 / Q1) — still held; the
  agent browser sees only the public web. Owner call.
- **D7 / D10 / D11 / D12** (pass-20 R20-5 held list: packet
  impact/confidence/severity fields, continuity-panel escalated/paused states,
  execution-truth-strip continuity, skeleton loaders) — never-built PRD
  features, still held.
- **Residual layering** (pass-22 B6) — server modules still import from
  `features/agents`: `app/server/tasks/specialist-run.server.ts:37,76-78`,
  `app/server/tasks/operator-actions.server.ts:8,60`,
  `app/server/tasks/task-actions.server.ts:135`,
  `app/server/org/resource-catalog.server.ts:4`,
  `app/server/projections/agent-deployments.server.ts:7`. The deliberate
  deferred refactor: relocate the display-view engine (`effectiveProfileView`)
  server-side.
- **Stale cross-reference** — `app/server/tasks/specialist-mcp.server.ts:227-229`
  still says the operator "should call this after resolving too — see the TODO
  left at its mount site"; F21-3 resolved that TODO
  (`app/server/runtimes/operator-run.server.ts:2401-2417`). One-line doc fix.

---

## Verified-clean (checked this pass, no findings — do not "fix")

Task-detail fetcher/toast wiring (all 13 fetchers route through
`useActionFeedback` with error toasts), org-settings `useOrgAction`, home
pin/rescan/rebuild feedback, timeline empty states + "Show older · N more",
notifications filter/caps/orphan handling, activity feed caps, board drag
ceremony + archived view, store-browser upload/delete feedback, SSO panel
claims, credential scope-chip honesty, mirror rebuild/stale-serve arms (tested),
`reserveRun`/`abandon` unit semantics, push/delivery token redaction. The
operator's refusal/queue design itself (open-packet, terminal-stage, B10
queueing) is sound — the gaps above are about SURFACING, not behavior.
