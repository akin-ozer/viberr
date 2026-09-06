# RBAC live probe: four project roles plus a non-member on k9c-k9s-clone

Instance `http://localhost:5173` (container `viberr-app-1`, branch `pass35/k9s-clone-observation`).
Probe window: 2026-09-06 14:20:07Z to 14:35Z (the UI renders local time, UTC+3, so a DB stamp of
14:26Z is the timeline's 17:26). Scripts: `scratchpad/rbac/*.mjs` driven by `drive.mjs`
(Playwright persistent profiles, one per identity); DB read in-container only (`rbac/audit.js`,
`rbac/audit2.js`, read-only `node:sqlite`). Raw outputs: `scratchpad/rbac/out-*.txt`.

Identities (verified in `project_members` before the run): Arda `arda@viberr.dev` org admin +
project admin (owner of KNC-9, KNC-10, KNC-14); Maya `maya@viberr.dev` maintainer; Omar
`omar@viberr.dev` contributor; Lena `lena@viberr.dev` viewer; Noah `noah@viberr.dev` org member,
not on the project. Expected column = reference `task-lifecycle-rbac-collab.md` section 25 rows
(R#) and section 4.4, plus the code cited there.

Typography note: this file contains no em-dash by instruction. Where the app's own copy carries one
(project name `k9c (em dash) k9s clone`, the archived-task refusal) it is written as ` - `.

Fixture drift the observer must know (all by `arda@viberr.dev` from another session, audit rows):
KNC-14 was ARCHIVED at 14:25:15Z (`task.archived`, `task.branch.discarded`), and KNC-10 was
FORCE-ACCEPTED into Done at 14:28:52Z (`task.transition` + `task.acceptance.forced`). The viewer and
contributor comment/metadata probes on KNC-10 ran at 14:26Z, before the force-accept; the
maintainer's Edit-details probe ran after the archive, which is why it moved to KNC-9 (below).

## 1. Probe table

Columns: probe | role | expected | observed | evidence | verdict.

### 1.1 Read surfaces (GET, full document navigation, `rbac/surfaces.mjs`)

| # | Probe | Role | Expected | Observed | Evidence | Verdict |
|---|---|---|---|---|---|---|
| 1 | Home `/` | V, C, M, A | 200, project listed for members | 200 for all four; h1 `Good afternoon, <name>`; screen `Home · project selection`; the project card is listed | out-surfaces-*.txt | ok |
| 2 | Board `/projects/k9c-k9s-clone` | V, C, M, A | 200 (index redirects to `/board`) | 200 at `/projects/k9c-k9s-clone/board`, h1 `Board`, `29 tasks · 26 waiting on a human`; `New task` present for C/M/A only; `Re-scan` for M/A only | same | ok |
| 3 | Task `/tasks/KNC-9` | V, C, M, A | 200 | 200, h1 `LICENSE and third-party notices`, screen `Task KNC-9` | same | ok |
| 4 | Review queue | V, C, M, A | 200 | 200, `1 task at the review boundary · 0 waiting on your acceptance` for every role | same | ok |
| 5 | Agents | V, C, M, A | 200 | 200, screen `Agents` | same | ok |
| 6 | Policy | V, C, M, A | 200 | 200, `last change · Arda · 16:57` | same | ok |
| 7 | GitHub view | V, C, M, A | 200 | 200, screen `GitHub` | same | ok |
| 8 | Activity | V, C, M, A | 200 | 200, screen `Activity` | same | ok |
| 9 | Controller page `/controller` (project) | V, C, M, A | 200 | 200 for all; V/C/M see `Managing the k9c - k9s clone board with your own permissions. Claude not connected`; A sees the thread list | same | ok (the `Claude not connected` line is a credential state, not a role gate) |
| 10 | Project settings | V, C, M, A | 200; edit form admin-only | 200 for all; V/C/M render `Read-only. Editing project settings need...`; A renders the editable form (`PROJECT NAME`, `TASK PREFIX`, ...) | same | ok |
| 11 | `/notifications` | V, C, M, A | 200 | 200, screen `Notifications · overlay`; V/C `all caught up`, M `32 unread · 24 decisions`, A `31 unread · 23 decisions` | same | ok |
| 12 | `/insights` | V, C, M | thrown 403, root boundary `Error 403` (R26) | 403; page text `Error 403 / error / This area requires the admin role. / Back to home` | same | ok (resolves the open question: the boundary prints the JSON body's `message`) |
| 13 | `/insights` | A | 200 | 200, h1 `Insights`, `116 Total runs` | same | ok |
| 14 | `/org/settings` | V, C, M | 403 as row 12 | 403, identical page | same | ok |
| 15 | `/org/settings` | A | 200 | 200, h1 `Instance settings` | same | ok |

### 1.2 Controls on the KNC-9 task page (Impl, open `Work stalled` packet, owner Arda; `rbac/controls.mjs`, `rbac/perms.mjs`)

| # | Probe | Role | Expected | Observed | Evidence | Verdict |
|---|---|---|---|---|---|---|
| 16 | Comment composer + `Comment` button | V, C, M, A | present for every member (`comment` is membership-wide) | present and enabled for all four (`[aria-label="Add a comment"]`, button `Comment`) | CONTROL composer/commentButton | ok |
| 17 | Goal `Edit` button (`.goal-edit-btn`) | V, C | absent (`update-goal` is M+) | absent | CONTROL editGoal | ok |
| 18 | Goal `Edit` button | M, A | present | present, label `Edit` | same | ok |
| 19 | `Edit details` (priority/labels/due) | V | absent | absent | CONTROL editDetails | ok |
| 20 | `Edit details` | C, M, A | present | present, enabled | same | ok |
| 21 | Owner seat: `Assign me` / `Release owner` | V | neither | neither (owner row shows `Arda`) | CONTROL assignMe/releaseOwner | ok |
| 22 | Owner seat | C, M | `Assign me` hidden because the seat is occupied; no release (not owner) | neither control; owner row `Arda` | same | ok (see note N4) |
| 23 | Owner seat | A | `Release owner` (release-any-ownership) | `Release owner` present (aria-label), title `Release Arda (admin)` equivalent | same | ok |
| 24 | `Run operator` / `Run` (agent) | V, C | absent; panel says who can | absent; Execution profile reads `RUN AN AGENT The operator dispatches agents as the task moves. Running one by hand needs the run-agents tier.` | CONTROL runOperator/runAgent, EXEC | ok |
| 25 | `Run operator` / `Run` | M, A | present | `Run` (agent) present and enabled; `Run operator` present but disabled with rendered reason `Open decision. Resolve it before running the operator.` | same | ok (F20-5 copy explains the dead control) |
| 26 | Packet radios + `Confirm decision` | V, C | radios inert, no Confirm, one deny note | 4 radios `aria-disabled=true`, no `Confirm decision`, deny note `You can't resolve this decision: a maintainer, an admin, or this task's owner can. You can still comment or ask the operator below.` | CONTROL packetOptions/confirmDecision, DENY | ok |
| 27 | Packet radios + `Confirm decision` | M, A | live | 5 radios (4 options + custom) enabled, `Confirm decision` enabled, `Ask operator` for everyone | same | ok |
| 28 | `Send to a maintainer` | C | only for a contributor-OWNER whose every option needs a higher tier; Omar is not the owner, so absent | absent for all four roles | CONTROL sendToMaintainer | ok (path not exercisable on this fixture, see N4) |
| 29 | `Accept completion` | V, C | absent | absent, no note | CONTROL acceptCompletion | ok |
| 30 | `Accept completion` | M, A | authority held but task is at Impl: no button, refusal text rendered | no button; deny note `Not acceptable yet. KNC-9 is at Impl, not Merge. A completion can only be accepted from the boundary the workflow puts before Done. Move the task through the workflow first.` | DENY | ok |
| 31 | `Archive task` | V, C | absent | absent | CONTROL archiveTask | ok |
| 32 | `Archive task` | M, A | present (`approve-transition`) | present, `btn ghost sm full danger`, hint `Keeps the record, takes the task off the board and out of the review queue. Reversible.` | same | ok |
| 33 | `Force accept` | V, C, M | absent | absent | CONTROL forceAccept | ok |
| 34 | `Force accept` | A | present | present: `Force accept (skips the remaining stages and the review gate)` | same | ok |
| 35 | Stage change (`Change stage (currently Impl)` menu) | V, C | static stage text, no menu | `.stage-static` = `Impl`, no menu button | CONTROL stageMenu/stageStatic | ok |
| 36 | Stage change | M, A | menu | menu button present, enabled | same | ok |
| 37 | Permissions panel text | V | rows match the matrix | `Your role = Viewer`, `Comments = You can comment (every project member can)`, `Task ownership = View only (contributor+ to own)`, `Accept completion = Maintainer, admin, or the task's own owner`, `Run agents = Maintainer or admin only`, `Merge → Done = Human decision, locked at the review boundary` | PERMS viewer | ok, consistent with rows 16-36 |
| 38 | Permissions panel text | C | same, ownership row `Take / release your own seat` | as expected (`Your role = Contributor`, ownership `Take / release your own seat`, accept `Maintainer, admin, or the task's own owner`, run `Maintainer or admin only`) | PERMS contributor | ok |
| 39 | Permissions panel text | M | `You can accept → Done`, `You can run agents` | as expected (`Your role = Maintainer`, ownership `Take / release your own seat`) | PERMS maintainer | ok |
| 40 | Permissions panel text | A | ownership `Take / release · you can release anyone` | as expected (`Your role = Admin`) | PERMS admin | ok |

### 1.3 Mutations (UI where a control exists, otherwise the same door over HTTP with the session cookie, `_csrf` and same-origin headers; `rbac/viewer.mjs`, `rbac/contributor.mjs`, `rbac/maintainer.mjs`, `rbac/maya-meta.mjs`)

Audit rows are quoted from `audit_events` (`out-audit2.txt`); `DEN` = `project.authority.denied`.

| # | Probe | Role | Expected | Observed | Evidence | Verdict |
|---|---|---|---|---|---|---|
| 41 | Post comment on KNC-10 (composer) | V | R2: 200, toast `Comment posted`, audit `task.comment {toAgent:false}` (every member may comment; the brief's "expect refusal" contradicts the matrix) | POST `/tasks/KNC-10.data` 200 `{ok:true, intent:"comment", toAgent:false, toast:"Comment posted"}`; toast `Comment posted`; DB `14:26:35 lena task.comment KNC-10 {"toAgent":false}` | out-viewer.txt | ok versus the matrix; see mismatch list M1 |
| 42 | `owner-take` KNC-10 | V | R5: 403 `Your project role (viewer) cannot ...`; DEN `own-task` | 403 `Your project role (viewer) cannot take or assign task ownership.`; DEN 14:26:37 `{action:"own-task", what:"take or assign task ownership", memberRole:"viewer"}` | same | ok |
| 43 | `set-task-metadata` priority=high KNC-10 | V | R9: 403 `... cannot edit task metadata.`; DEN `edit-task-meta` | 403 `Your project role (viewer) cannot edit task metadata.`; DEN `edit-task-meta` | same | ok |
| 44 | `resolve-packet` option 3 KNC-9 | V | R12: 403 `... cannot resolve decision packets.`; DEN `resolve-packet` | exact sentence; DEN `resolve-packet` | same | ok |
| 45 | `transition` to=design KNC-9 | V | R11: 403 `... cannot change the task stage.`; DEN `approve-transition` | exact; DEN `{action:"approve-transition", what:"change the task stage"}` | same | ok |
| 46 | `update-goal` KNC-9 | V | R10: 403 `... cannot edit the task goal.`; DEN `update-goal` | exact; DEN `update-goal` | same | ok |
| 47 | `force-accept` KNC-9 | V | R16: 403 `... cannot force-accept past the review gate.`; DEN `force-accept-completion` | exact; DEN present | same | ok |
| 48 | `run-operator` KNC-9 | V | R17: 403 `... cannot <what>`; DEN `run-agents` | 403 `Your project role (viewer) cannot run the operator.`; DEN `{action:"run-agents", what:"run the operator"}` | same | ok (the explicit run door is audited; only the @mention path is `silentDeny`) |
| 49 | `archive-task` KNC-9 | V | R19: 403 `... cannot archive this task.`; DEN `approve-transition` deduped with row 45 (same action id inside 60 s) | 403 `Your project role (viewer) cannot archive this task.`; no second row (dedupe, as predicted) | same | ok |
| 50 | Board `create-task` | V | R4: 403 `... cannot create tasks.`; DEN `create-task` | exact; DEN `create-task` | same | ok |
| 51 | Settings `invite` | V | R21: 403 `Only project admins can manage members & roles.`; DEN `manage-members` | exact; DEN `manage-members` | same | ok |
| 52 | Post comment `RBAC probe: contributor comment` on KNC-10 (composer) | C | 200 `Comment posted`; audit `task.comment` | 200, toast `Comment posted`; DB `14:26:43 omar task.comment KNC-10` | out-contributor.txt | ok |
| 53 | Take ownership of KNC-10 | C | seat is OCCUPIED (Arda): UI hides `Assign me`; R6: 403 `This task already has an owner. Taking it over needs completion-acceptance authority (maintainer or admin); ask them to reassign it.` and NO denied row | no `Assign me`, owner row `Owner A Arda`; HTTP 403 with that exact sentence; no DEN row for `own-task` from omar | same + out-audit2.txt | ok; take-then-release was not possible on any of the three allowed tasks (all owned by Arda), see N4 |
| 54 | Release KNC-10's seat | C | R8: 403, not the owner | 403 `Your project role (contributor) cannot release another member's ownership.`; DEN 14:26:45 `{action:"release-any-ownership", what:"release another member's ownership", memberRole:"contributor"}` | same | ok |
| 55 | `Edit details` priority High on KNC-10 (UI) | C | R9: 200, audit `task.metadata.updated` | select `priority` normal→high, Save; POST 200 `{ok:true, intent:"set-task-metadata", toast:"Task metadata updated"}`; reload shows `high`; DB `14:26:47 omar task.metadata.updated {"priority":"high"}`; reverted to normal (`14:26:51 ... {"priority":"normal"}`) | same | ok |
| 56 | Resolve the KNC-9 packet | C (not owner) | R12: UI deny note, no Confirm; HTTP 403 `Your project role (contributor) cannot resolve decision packets.`; DEN `resolve-packet` | UI as row 26; HTTP exact sentence; DEN 14:26:54 `resolve-packet` | same | ok |
| 57 | `request-maintainer-decision` KNC-9 | C (not owner) | R14: 403 `... cannot resolve decision packets.`; no `Send to a maintainer` control | 403 same sentence as row 56; control absent; second DEN collapsed into row 56 (same action id) | same | ok; Maya received no escalation (none was sent) |
| 58 | `update-goal`, `transition`, `run-operator`, `force-accept`, `archive-task`, settings `invite` | C | 403 each with `(contributor)`; DEN `update-goal`, `approve-transition`, `run-agents`, `force-accept-completion`, `manage-members` | all six 403 with the exact `Your project role (contributor) cannot ...` / `Only project admins can manage members & roles.` sentences; five DEN rows at 14:26:54 (archive deduped into `approve-transition`) | same | ok |
| 59 | `Edit details` priority High on KNC-14 | M | R9: 200 | control ABSENT: KNC-14 had been archived at 14:25:15Z by Arda; panel reads `Archived. Restore this task to edit its details.`; HTTP `set-task-metadata` on it: 400 `KNC-14 is archived - restore it before editing its priority, labels or due date.` (server freeze matches the UI, F26-13) | out-maintainer.txt, out-maya-meta.txt | ok versus the freeze rule; the brief's fixture had moved (N2) |
| 60 | `Edit details` priority High on KNC-9 (substitute) | M | 200, audit row | UI normal→high, POST 200 `Task metadata updated`; Details panel after reload `Priority high`; DB `14:32:44 maya task.metadata.updated KNC-9 {"priority":"high"}`; reverted (`14:32:48 ... normal`) | out-maya-meta.txt | ok |
| 61 | Post comment `RBAC probe: maintainer comment` on KNC-14 (archived) | M | 200 (comments stay open on closed tasks: `This task is closed. Comments are still recorded.`) | 200, toast `Comment posted`; DB `14:31:12 maya task.comment KNC-14`; timeline shows `Maya Chen 17:31 RBAC probe: maintainer comment` | out-maintainer.txt, out-maya-knc14.txt | ok |
| 62 | `force-accept` KNC-9 | M | R16: 403 `Your project role (maintainer) cannot force-accept past the review gate.`; DEN | exact; DEN 14:31:16 `force-accept-completion` memberRole maintainer | out-maintainer.txt | ok |
| 63 | `request-maintainer-decision` KNC-9 | M | R14: 400 `You can resolve this decision yourself; there is no need to route it to a maintainer.` | exact, status 400 | same | ok |
| 64 | Settings `invite`, Policy `set-role` | M | R21: 403 `Only project admins can manage members & roles.`; DEN `manage-members` | both 403 exact; one DEN row (second collapsed) | same | ok |
| 65 | Maya's notifications after the contributor probes | M | no escalation (row 57 never fired) | page lists only the pre-existing packet/policy items; no `RBAC probe` or `maintainer authority` text; `notifications` table since 14:20Z holds only KNC-14 PR-closed rows for arda/maya at 14:23Z | out-maya-notifs.txt, out-audit2.txt | ok |
| 66 | Admin mutations | A | none performed (brief) | none; controls verified in 1.2 only | | n/a |

### 1.4 Non-member Noah (`rbac/noah.mjs doors`, `rbac/oracle.mjs`, `rbac/noah-send.mjs`, `rbac/noah-poll.mjs`)

| # | Probe | Role | Expected | Observed | Evidence | Verdict |
|---|---|---|---|---|---|---|
| 67 | Board `/projects/k9c-k9s-clone` | N | 404 page `Page not found` / `No project at projects/k9c-k9s-clone.` / `Back to home` | index 302 to `/board`, then document 404; page text exactly `Page not found error No project at projects/k9c-k9s-clone. Back to home`; screenshot `rbac-noah-404.png` | out-noah-doors.txt | ok |
| 68 | Task page `/tasks/KNC-9` | N | same 404 | 404, identical text | same | ok |
| 69 | Made-up slug `/projects/no-such-project-zzz` (+ `/board`, task, `.data`, attachment) | N | byte-identical shape to rows 67-68 | 302 to `/board` then 404 for both slugs; `.data` bodies and attachment bodies identical apart from the echoed slug | out-noah-oracle.txt | ok (no existence oracle) |
| 70 | `/tasks/KNC-9.data` | N | 404, same sentence | 404 `text/x-script`, turbo-stream `["ErrorResponse", "No project at projects/k9c-k9s-clone.", 404, ...]` for both `routes/project` and `routes/project.task` | out-noah-doors.txt | ok |
| 71 | `/policy.data?_routes=routes/project.policy` (single-fetch bypass) | N | 404 same body | 404, same `ErrorResponse` | same | ok |
| 72 | Attachment `/tasks/KNC-9/attachments/nothing.png` | N | 404 `No project at projects/<slug>.` | 404 `application/json` body `"No project at projects/k9c-k9s-clone."` | same | ok |
| 73 | Run log `/resources/run-log?runId=run_s_lSlebNJwZ-` (a project run) | N | 404 bare `Not found.` | 404 `application/json` body `"Not found."` | same | ok |
| 74 | Run log, no `runId` / unknown id | N | 400 validation / 404 JSON | 400 `{"error":{"code":"validation_failed","message":"runId is required."}}`; 404 `{"error":{"code":"not_found","message":"Run run_doesnotexist not found."}}` | same | ok (open question resolved: the literal is `validation_failed`) |
| 75 | Session export `/resources/session-export?run=<project run>` | N | 404 `Not found.` | 404 `"Not found."` | same | ok |
| 76 | Dock GET `/resources/controller?project=k9c-k9s-clone` (and `&task=KNC-9`) | N | 200 `{view:{unavailable:true, scope.contextLine:"Not available here: this project or task is not open to you."}}` | 200, `unavailable:true`, `contextLine` exact, `conversation:null`, `messages:[]`; note the payload also carries `projectName:"k9c - k9s clone"` and `label:"KNC-9 · k9c - k9s clone"` | same | ok, but see mismatch M2 |
| 77 | Dock POST `/resources/controller` intent=send with `project=k9c-k9s-clone` | N | 404 `{ok:false, error:"That project or task is not open to you."}` | exact; identical for `project=no-such-project-zzz`; DEN 14:31:56 `{action:"any-member", what:"talk to the controller about this project", memberRole:null}` | out-noah-send.txt, out-audit2.txt | ok |
| 78 | Task POST `/tasks/KNC-9.data` intent=comment | N | 404 before the intent switch | 404 `ErrorResponse "No project at projects/k9c-k9s-clone."` | out-noah-doors.txt | ok |
| 79 | `/org/settings`, `/insights`, `/org/settings/audit-export?format=json` | N | 403 | 403 HTML boundary (rows 12/14 page), 403, and 403 `{"error":{"code":"forbidden","message":"This area requires the admin role."}}` | same | ok |
| 80 | Home `/` | N | project absent from every list | `No projects yet. Create your first project below.`; no `/projects/` links | out-noah-dock.txt HOME | ok |
| 81 | Dock on the 404 page | N | reference expectation: the `Not available here` panel | NO dock rendered at all on the 404 page (`.dock` absent, trigger absent) | out-noah-doors.txt BODY `dock:null` | observation, see M3 (resolves the reference's open question) |
| 82 | Dock on Home: send `list the tasks on the k9c-k9s-clone board` | N | `[denied] No project "k9c-k9s-clone" is visible to you.` relayed | composer DISABLED before any send, placeholder `The controller runs on your own Claude account, and Claude isn't connected for you yet. Connect it on your Profile → Agent accounts, then send your message again.`; `Send` disabled | out-noah-dockdebug.txt SNAP | not exercisable as Noah (no Claude credential; the observer must not enter one), see N3 |
| 83 | Same message over HTTP POST `/resources/controller` (instance scope, no `project`) | N | n/a (extra) | 200 `{ok:true, conversationId:"cnv_mfmJAEye0VvS"}`; the conversation then holds two messages: user text and a `controller` reply with the same credential sentence as row 82; `turn.working:false`; no run, no `controller.authority.denied` row | out-noah-send.txt, out-noah-poll.txt | ok as a refusal; see M4 for the UI/HTTP asymmetry |

### 1.5 Audit (`rbac/audit2.js`, `audit_events` since 14:20:00Z)

| # | Probe | Role | Expected | Observed | Evidence | Verdict |
|---|---|---|---|---|---|---|
| 84 | `project.authority.denied` rows | all | one per user/slug/action per minute | 21 rows (listed in section 3): lena 9, omar 7, maya 2, noah 3; every row's `memberRole` matches the identity; task_key is always null | out-audit2.txt | ok |
| 85 | `controller.authority.denied` rows | all | none (no instance-scope admin tool was reached) | 0 rows | same | ok |
| 86 | `project.org_admin.override` rows | A | none (Arda is a member) | 0 rows | same | ok |
| 87 | Dedupe (`deny|user|slug|action`, no `what`) | all | collapsed rows | confirmed four times: lena archive→transition, omar request-maintainer→resolve-packet, maya set-role→invite, noah's `.data`/attachment/run-log/session-export/controller-GET doors → one row `what:"read this project"` at 14:25:43 and one at 14:28:36 | same | ok, matches D-25c |
| 88 | Positive rows for the mutations | V, C, M | `task.comment` x3, `task.metadata.updated` x4 | exactly those seven rows with the right actors and payloads (section 3) | same | ok |

Probe rows: 88.

## 2. Mismatches and candidate findings

None of the 88 rows shows a role doing what it must not, a role refused what the matrix grants, or a
page that lies about a role. The items below are the only divergences from the brief or the
reference; M2 and M4 are the two worth a ruling.

- M1 (brief vs code, not a product defect): the brief expected a viewer's comment to be refused. The
  canonical matrix (`app/shared/rbac.ts`, `comment` held by every role) and the Permissions panel
  (`You can comment (every project member can)`) both say otherwise, and the server agrees: Lena's
  comment posted (row 41). Treat the brief's expectation as wrong, not viberr.
- M2 (information shape, low): the non-member dock GET (row 76) answers `unavailable:true` as
  designed, but the JSON still carries `projectName: "k9c - k9s clone"` and a label built from it.
  Every other door hides everything but the slug the caller typed. A non-member can therefore learn
  a hidden project's display name from `/resources/controller?project=<slug>`. Candidate finding
  (`app/features/controller/controller-dock-query.server.ts`, `unavailableDockView` spreads
  `describeDockScope(db, binding)`, which resolves `projectName`/`label` from the project record
  before the membership answer is applied).
- M3 (reference open question, resolved, no defect): the dock is NOT rendered on the 404 page for a
  non-member (row 81); the reference guessed it would show the `Not available here` panel. The page
  offers `Back to home`, so nothing is stranded. Update the reference.
- M4 (UI/HTTP asymmetry, low): with no Claude credential the dock disables the composer and `Send`
  (row 82), yet the resource POST accepts the send with `{ok:true}` and creates a conversation whose
  only reply is the credential sentence (row 83). Outcome is the same (nothing runs), but the door
  says yes where the UI says no. Not a role leak.
- M5 (fixture, not viberr): the brief's KNC-14 (`standalone, editable`) was archived by the owner's
  other session four minutes into the run, and KNC-10 was force-accepted two minutes later. The
  maintainer priority edit was re-targeted at KNC-9 (row 60) and reverted; the archived-task freeze
  behaved correctly on both the UI and the HTTP door (row 59).

## 3. Audit rows since 14:20:00Z (UTC), verbatim from `audit_events`

`project.authority.denied` (actor_label, details_json):

```
14:25:43.172 noah@viberr.dev {"action":"any-member","what":"read this project","projectSlug":"k9c-k9s-clone","memberRole":null}
14:26:37.767 lena@viberr.dev {"action":"own-task","what":"take or assign task ownership","projectSlug":"k9c-k9s-clone","memberRole":"viewer"}
14:26:37.806 lena@viberr.dev {"action":"edit-task-meta","what":"edit task metadata","projectSlug":"k9c-k9s-clone","memberRole":"viewer"}
14:26:37.837 lena@viberr.dev {"action":"resolve-packet","what":"resolve decision packets","projectSlug":"k9c-k9s-clone","memberRole":"viewer"}
14:26:37.858 lena@viberr.dev {"action":"approve-transition","what":"change the task stage","projectSlug":"k9c-k9s-clone","memberRole":"viewer"}
14:26:37.871 lena@viberr.dev {"action":"update-goal","what":"edit the task goal","projectSlug":"k9c-k9s-clone","memberRole":"viewer"}
14:26:37.884 lena@viberr.dev {"action":"force-accept-completion","what":"force-accept past the review gate","projectSlug":"k9c-k9s-clone","memberRole":"viewer"}
14:26:37.894 lena@viberr.dev {"action":"run-agents","what":"run the operator","projectSlug":"k9c-k9s-clone","memberRole":"viewer"}
14:26:37.918 lena@viberr.dev {"action":"create-task","what":"create tasks","projectSlug":"k9c-k9s-clone","memberRole":"viewer"}
14:26:37.931 lena@viberr.dev {"action":"manage-members","what":"manage members & roles","projectSlug":"k9c-k9s-clone","memberRole":"viewer"}
14:26:45.700 omar@viberr.dev {"action":"release-any-ownership","what":"release another member's ownership","projectSlug":"k9c-k9s-clone","memberRole":"contributor"}
14:26:54.818 omar@viberr.dev {"action":"resolve-packet","what":"resolve decision packets","projectSlug":"k9c-k9s-clone","memberRole":"contributor"}
14:26:54.866 omar@viberr.dev {"action":"update-goal","what":"edit the task goal","projectSlug":"k9c-k9s-clone","memberRole":"contributor"}
14:26:54.892 omar@viberr.dev {"action":"approve-transition","what":"change the task stage","projectSlug":"k9c-k9s-clone","memberRole":"contributor"}
14:26:54.900 omar@viberr.dev {"action":"run-agents","what":"run the operator","projectSlug":"k9c-k9s-clone","memberRole":"contributor"}
14:26:54.911 omar@viberr.dev {"action":"force-accept-completion","what":"force-accept past the review gate","projectSlug":"k9c-k9s-clone","memberRole":"contributor"}
14:26:54.934 omar@viberr.dev {"action":"manage-members","what":"manage members & roles","projectSlug":"k9c-k9s-clone","memberRole":"contributor"}
14:28:36.109 noah@viberr.dev {"action":"any-member","what":"read this project","projectSlug":"k9c-k9s-clone","memberRole":null}
14:31:16.818 maya@viberr.dev {"action":"force-accept-completion","what":"force-accept past the review gate","projectSlug":"k9c-k9s-clone","memberRole":"maintainer"}
14:31:16.865 maya@viberr.dev {"action":"manage-members","what":"manage members & roles","projectSlug":"k9c-k9s-clone","memberRole":"maintainer"}
14:31:56.266 noah@viberr.dev {"action":"any-member","what":"talk to the controller about this project","projectSlug":"k9c-k9s-clone","memberRole":null}
```

`controller.authority.denied`: none. `project.org_admin.override`: none.

Positive rows left by the probe identities on the project:

```
14:26:35.914 lena@viberr.dev task.comment KNC-10 {"toAgent":false}
14:26:43.807 omar@viberr.dev task.comment KNC-10 {"toAgent":false}
14:26:47.627 omar@viberr.dev task.metadata.updated KNC-10 {"priority":"high"}
14:26:51.187 omar@viberr.dev task.metadata.updated KNC-10 {"priority":"normal"}
14:31:12.057 maya@viberr.dev task.comment KNC-14 {"toAgent":false}
14:32:44.675 maya@viberr.dev task.metadata.updated KNC-9 {"priority":"high"}
14:32:48.199 maya@viberr.dev task.metadata.updated KNC-9 {"priority":"normal"}
```

Dedupe note (D-25c confirmed): the key is `deny|<userId>|<slug>|<action>` with no `what`, so the
archive refusal (Lena), the maintainer-routing refusal (Omar), the set-role refusal (Maya) and all of
Noah's non-page doors (`.data`, policy bypass, attachment, run-log, session-export, dock GET) left no
row of their own; the surviving row names only the FIRST door of the minute (`read this project`).
Anyone reading the audit log to prove "the attachment door refused a non-member" cannot; only the
HTTP status can.

End state of the three fixture tasks (`task_projections` at 14:35Z): KNC-9 impl, priority normal,
not archived, owner Arda; KNC-10 done (forced), priority normal, owner Arda; KNC-14 merge, archived,
priority normal, owner Arda. Net change from this probe: three comments (`RBAC probe: viewer
comment` on KNC-10, `RBAC probe: contributor comment` on KNC-10, `RBAC probe: maintainer comment`
on KNC-14) and the four audited metadata writes that net to no change. No Playwright profile typed a
credential.

## 4. Notes for the observer

- N1 Time base: `audit_events.occurred_at` is UTC; every timestamp the UI shows is UTC+3.
- N2 The fixture moved under the probe (M5). Rows 41, 52-55 ran on KNC-10 while it was still at
  Validation; anything re-run on KNC-10 now hits a Done task (comments still post; `Edit details`
  still renders on a closed, non-archived task).
- N3 Only Arda holds a Claude credential. Every controller relay claim (`[denied] No project ...`,
  `[denied] Running agents needs the maintainer role ...`) can be exercised live only by a member
  who has connected Claude on Profile → Agent accounts; for Lena, Omar, Maya and Noah the dock
  composer is disabled before any RBAC gate is reached. The project-scope door itself (row 77) does
  refuse a non-member with the 404 sentence and audits it.
- N4 All three permitted tasks are owned by Arda, so the contributor take-then-release path and the
  contributor-owner `Send to a maintainer` path were not exercisable without an admin release
  (excluded by the brief). Their refusal halves (rows 53, 54, 57) are proven.
- N5 A member's Home shows, under `Settings`, `GITHUB CONNECTIONS 1 connection akin-ozer` and a
  `USERS & ACCESS` avatar strip (A, MC, OR, LF) even for Noah who is on no project. Instance-level
  information, not project RBAC; flagging only because the brief asks what a non-member sees.
- N6 Screenshots (light, 1280x900, full page): `shots/rbac-viewer-knc9.png`,
  `shots/rbac-contributor-knc9.png`, `shots/rbac-maintainer-knc9.png`, `shots/rbac-admin-knc9.png`,
  `shots/rbac-noah-404.png`; extras `shots/rbac-noah-dock-debug.png` (disabled composer) and
  `shots/rbac-noah-dock.png` (the credential reply in the thread).
- N7 Scripts: `rbac/lib.mjs` (helpers), `rbac/surfaces.mjs`, `rbac/controls.mjs`, `rbac/perms.mjs`,
  `rbac/viewer.mjs`, `rbac/contributor.mjs`, `rbac/maintainer.mjs`, `rbac/maya-meta.mjs`,
  `rbac/maya-knc14.mjs`, `rbac/maya-notifs.mjs`, `rbac/noah.mjs`, `rbac/oracle.mjs`,
  `rbac/noah-dockdebug.mjs`, `rbac/noah-send.mjs`, `rbac/noah-poll.mjs`, `rbac/audit.js`,
  `rbac/audit2.js`; outputs `rbac/out-*.txt`, all under the session scratchpad.
