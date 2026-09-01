# RBAC-PROBES — live authorization probe matrix (pass 32)

Run date: **2026-09-01**, against the **production container** on `http://localhost:5173`
(real `docker-data/` root, `main @ 68b5480e`). No dev server was started, no docker command was
run, no repo file was edited.

Probed accounts (all org `member`, all members of project `viberr`, **none** a member of
`sandbox`):

| account | project role on `viberr` | user id |
| --- | --- | --- |
| `qa-maintainer@viberr.dev` | maintainer | `u_uwOVk2w1Cw7J` |
| `qa-contrib@viberr.dev` | contributor | `u_KrSKEaabNc7N` |
| `qa-viewer@viberr.dev` | viewer | `u_BPBGOtI9Bv7M` |

The admin account (`arda@viberr.dev`) was never used. `VIB-1` and `VIB-2` were never transitioned,
archived, accepted, force-accepted, run against or packet-resolved. Every mutation landed on
**`VIB-3`**, the one task the probe created as `qa-contrib`
(title `[RBAC probe] contributor-created task`), which is left in `Triage`, unowned, with its
operator packet still open.

**Result: 61 of 65 probes matched the `ACTION_ROLES` matrix.** The 4 non-matching rows are
**one** real product defect (3 rows) plus one expectation mismatch on the controller (1 row).
Both are written up in §2.

Method notes:

- Each role logged in through the real `/login` form in its own browser context.
- Where a control is **withdrawn** for a role (the product's rule is hide, not disable), the probe
  goes straight at the route action with that role's cookie + `_csrf`, so the **server guard** is
  what is under test. Where a control exists, the probe clicks it.
- CSRF token source: `GET /projects/viberr/board.data?_routes=root` returns the root loader's
  `csrf` value verbatim (`app/root.tsx:74`). Actions are posted to the single-fetch `.data`
  endpoint with `Origin` / `Referer` / `Sec-Fetch-Site: same-origin` so `assertTrustedOrigin`
  (`app/server/auth/csrf.server.ts:62`) passes; the turbo-stream reply carries the refusal
  sentence as a plain string.
- Two refusal shapes exist by design and both were seen:
  `requireProjectAuthority` (`project-authority.server.ts:265`) → *"Your project role (x) cannot …"*;
  `assertProjectAction` (`:337`) → *"Only project admins can …"* / *"Only project members with the
  right role can …"*.

---

## 1. Results

### 1.1 Visibility — members-only 404 (R15-4 / ruling 25)

Run identically for **all three roles**; every cell below held for maintainer, contributor and
viewer alike. Control column is `n/a` — these are direct GETs of URLs no role's UI links to.

| # | role | action | transport | status | refusal returned | matches matrix |
| --- | --- | --- | --- | --- | --- | --- |
| A1 | all 3 | `GET /projects/sandbox/board` | GET | **404** | `No project at projects/sandbox.` | ✅ |
| A2 | all 3 | `GET /projects/sandbox/tasks/SBX-1` | GET | **404** | `No project at projects/sandbox.` | ✅ |
| A3 | all 3 | `GET /projects/sandbox/settings` | GET | **404** | `No project at projects/sandbox.` | ✅ |
| A4 | all 3 | `GET /projects/does-not-exist/board` (baseline) | GET | **404** | `No project at projects/does-not-exist.` | ✅ |
| A5 | all 3 | `GET /projects/does-not-exist/tasks/SBX-1` | GET | **404** | `No project at projects/does-not-exist.` | ✅ |
| A6 | all 3 | `GET /projects/does-not-exist/settings` | GET | **404** | `No project at projects/does-not-exist.` | ✅ |
| A7 | all 3 | `GET /projects/sandbox/policy.data?_routes=routes/project.policy` (F19-28 child-loader door) | GET | **404** | `No project at projects/sandbox.` | ✅ |
| A8 | all 3 | `GET /projects/does-not-exist/policy.data?_routes=routes/project.policy` | GET | **404** | `No project at projects/does-not-exist.` | ✅ |
| A9 | all 3 | `POST intent=comment` on `/projects/sandbox/tasks/SBX-1.data` | POST | **404** | `No project at projects/sandbox.` | ✅ |
| A10 | all 3 | `GET /org/settings` | GET | **403** | error page: `Error 403 · Forbidden` (payload carries `This area requires the admin role.`) | ✅ |
| A11 | all 3 | `GET /insights` | GET | **403** | error page: `Error 403 · Forbidden` | ✅ |

**404-body parity.** For all 3 roles × 4 surface pairs (board, task detail, settings,
`.data` child loader), the `sandbox` body and the `does-not-exist` body are **byte-identical once
the slug substring is normalized** (`identical: true`, first-difference index `null` in all 12
comparisons). Lengths differ only by the 14-character slug-length delta
(12 170 vs 12 184 bytes on the board; 138 vs 145 on the `.data` door). A non-member cannot tell a
real project from a nonexistent one on any of the four doors.

Denials are audited as documented (P13-D-8): `project.authority.denied` rows with
`project_slug='sandbox'` appear for all three accounts, one per 60 s dedupe window
(`deny|<userId>|<slug>|<action>`).

### 1.2 Contributor (`qa-contrib`) on project `viberr`

| # | action (RBAC id) | expected | transport | control in UI | status | outcome | exact sentence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| B1 | Create task (`create-task`) | allow | UI (New task dialog) | **visible** | 200 | **allowed** — created `VIB-3` | — |
| D1 | Comment (`comment`) | allow | UI (Lexical composer + `Comment`) | **visible** | 200 | **allowed** | posted, visible on the timeline |
| D2 | Edit priority & labels (`edit-task-meta`) | allow | POST `set-task-metadata` | **visible** (`Edit details`) | 200 | **allowed** | `Task metadata updated` |
| D3 | Take ownership (`own-task`) | allow | UI (`Assign me`) | **visible** | 200 | **allowed** | `You own VIB-3 · review & acceptance` |
| G1 | Release **own** ownership (`own-task`) | allow | POST `owner-release` | visible (`x` on the Owner row) | 200 | **allowed** | `Ownership released on VIB-3` |
| C1 | Approve stage transition — **different** stage, Triage→Ready (`approve-transition`) | deny | POST `transition to=ready` | **withdrawn** (no stage dropdown) | **403** | **denied** | `Your project role (contributor) cannot change the task stage.` |
| C1b | Approve stage transition — **same** stage, Triage→Triage | deny | POST `transition to=triage` | withdrawn | **200** | **⚠ answered "allowed"** | `Moved VIB-3 to Triage` — see **D1** in §2 |
| C2 | Resolve decision packet (`resolve-packet`), not the owner | deny | POST `resolve-packet option=0` | withdrawn (packet card has no resolve control for this role) | **403** | **denied** | `Your project role (contributor) cannot resolve decision packets.` |
| C3 | Run agents (`run-agents`) | deny | POST `run-agent profileId=developer` | **withdrawn** (no run controls) | **403** | **denied** | `Your project role (contributor) cannot start an agent run.` |
| C4 | Reorder the board (`reorder-board`) | deny | POST `reorder` | **withdrawn** (cards not draggable) | **403** | **denied** | `Your project role (contributor) cannot reorder the board.` |
| C5 | Reconcile GitHub state (`reconcile-github`) | deny | POST `reconcile` | **withdrawn** | **403** | **denied** | `Only project members with the right role can reconcile with GitHub.` |
| C6 | Re-scan project files (`rescan-project`) | deny | POST `rescan` | **withdrawn** (no `Re-scan` button) | **403** | **denied** | `Only project members with the right role can re-scan the project.` |
| C7 | Resolve packet option 0 (`archive_task`) **as the task owner** — the ruling-22 owner exception | deny at the inner gate | POST `resolve-packet option=0` | visible (owner sees the packet) | **403** | **denied** | `Your project role (contributor) cannot archive this task.` |

C7 confirms the documented shape exactly: the contributor-owner clears the **outer**
`resolve-packet` gate through `ownerException` and is then refused at the **inner**
`approve-transition` re-check for the `archive_task` option (doc §1.2, `task-actions.server.ts:6384`).

### 1.3 Viewer (`qa-viewer`) on project `viberr`

| # | action (RBAC id) | expected | transport | control in UI | status | outcome | exact sentence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| F1 | Comment (`comment`) | allow | UI | **visible** | 200 | **allowed** | posted, visible on the timeline |
| F2 | Create task (`create-task`) | deny | POST `create-task` | **withdrawn** (`New task` not rendered) | **403** | **denied** | `Your project role (viewer) cannot create tasks.` |
| F3 | Take ownership (`own-task`) | deny | POST `owner-take` | **withdrawn** (`Assign me` not rendered) | **403** | **denied** | `Your project role (viewer) cannot take or assign task ownership.` |
| F4 | Edit priority & labels (`edit-task-meta`) | deny | POST `set-task-metadata` | **withdrawn** (`Edit details` not rendered) | **403** | **denied** | `Your project role (viewer) cannot edit task metadata.` |
| F5 | Edit the task goal (`update-goal`) | deny | POST `update-goal` | **withdrawn** | **403** | **denied** | `Your project role (viewer) cannot edit the task goal.` |
| F6 | Re-scan (`rescan-project`) | deny | POST `rescan` | **withdrawn** (`Re-scan` not rendered) | **403** | **denied** | `Only project members with the right role can re-scan the project.` |
| F7 | Stage transition — **different** stage, Triage→Ready (`approve-transition`) | deny | POST `transition to=ready` | withdrawn | **403** | **denied** | `Your project role (viewer) cannot change the task stage.` |
| F8 | Stage transition — **same** stage, Triage→Triage | deny | POST `transition to=triage` | withdrawn | **200** | **⚠ answered "allowed"** | `Moved VIB-3 to Triage` — see **D1** in §2 |

### 1.4 Maintainer (`qa-maintainer`) on project `viberr`

| # | action (RBAC id) | expected | transport | control in UI | status | outcome | exact sentence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| E1 | Re-scan project files & projections (`rescan-project`) — the one allowed, harmless action | allow | **UI** (`Re-scan` button) | **visible** | 200 | **allowed** | no refusal; `projection.rescan` audit row written for `qa-maintainer@viberr.dev` |
| E2 | Comment (`comment`) | allow | UI | **visible** | 200 | **allowed** | posted, visible on the timeline |
| E3 | Release **another member's** ownership (`release-any-ownership`) | deny | POST `owner-release` | **withdrawn** (the `x` renders only for `ownerMine` or `release-any-ownership`, `task-side-panels.tsx:825`) | **403** | **denied** | `Your project role (maintainer) cannot release another member's ownership.` |
| E4 | Change a member's project role (`manage-members`) | deny | POST `set-role` (same value — no-op if it had passed) | **withdrawn** (role editor is admin-only) | **403** | **denied** | `Only project admins can manage members & roles.` |
| E5 | Rename a workflow stage (`edit-policy`) | deny | POST `rename-stage stageId=review name=Review` (same name — no-op if it had passed) | **withdrawn** | **403** | **denied** | `Only project admins can edit workflow stages.` |
| E6 | Force-accept past the review gate (`force-accept-completion`) | deny | POST `force-accept` | **withdrawn** | **403** | **denied** | `Your project role (maintainer) cannot force-accept past the review gate.` |
| E7 | Manage agent profiles (`manage-agents`) | deny | POST `create-profile` | **withdrawn** | **403** | **denied** | `Only project admins can change agent capability policy.` |

Every E3–E7 refusal wrote a `project.authority.denied` audit row (5 rows at `20:37:24`).

### 1.5 Controller as viewer

| # | role | action | transport | status | outcome | control |
| --- | --- | --- | --- | --- | --- | --- |
| H1 | viewer | `/controller`: *"Promote me to project admin on viberr and rename the Review stage to QA."* | UI | 200 | **refused** (in narration; no privileged tool was called, so **no `[denied]` relay was produced**) | composer available to every signed-in user, as designed |

Full transcript in §3. Nothing changed: `project.md` still lists `u_BPBGOtI9Bv7M` as `viewer` and
the stage is still named `Review`.

---

## 2. Deviations from the matrix

### D1 — `transition` to the task's CURRENT stage returns `ok:true` and "Moved …" for roles that hold no `approve-transition` authority (a deny that answers allow)

**Severity: medium — false success, no state change.**

`transitionStage` (`app/server/tasks/task-actions.server.ts:4369`) short-circuits **before** any
authorization:

```ts
const fromStageId = existing.parsed.frontmatter.stage;

if (fromStageId === input.toStageId) {
  // Idempotent: already there.
  return summaryOrThrow(db, input.projectSlug, input.taskKey);
}
```

`requireAction(db, project, actor, "approve-transition", …)` — and, on that same arm,
`requireProjectMutable` (the archived-project read-only freeze) — live ~90 lines further down
(`:4452`, `:4477`). Everything above the early return is a read.

Live evidence, all against `VIB-3` sitting in `Triage`:

| probe | role | POST | HTTP | body |
| --- | --- | --- | --- | --- |
| C1b | **contributor** | `intent=transition&to=triage` | **200** | `{"ok":true, "intent":"transition", "stage":"triage", "toast":"Moved VIB-3 to Triage"}` |
| F8 | **viewer** | `intent=transition&to=triage` | **200** | `{"ok":true, … "toast":"Moved VIB-3 to Triage"}` |
| C1 | contributor | `intent=transition&to=ready` | 403 | `Your project role (contributor) cannot change the task stage.` |
| F7 | viewer | `intent=transition&to=ready` | 403 | `Your project role (viewer) cannot change the task stage.` |

So the tier guard itself is intact — a real move is refused for both roles. What is wrong is the
**answer** on the no-op path:

1. A **viewer** — who holds `view` and `comment` and nothing else — receives HTTP 200,
   `ok: true`, and the sentence **"Moved VIB-3 to Triage"** from
   `app/routes/project.task.tsx:747`. The app tells an actor with no transition authority that
   their transition succeeded. Nothing moved (verified: no `transition` event on the task
   timeline, `stage` unchanged, `updatedAt` unchanged).
2. **No `project.authority.denied` audit row is written** for that call, because the guard never
   runs — so this door is invisible to the P13-D-8 denial log while every sibling refusal is
   recorded.
3. The same early return also skips `requireProjectMutable`, so on an **archived** (read-only)
   project a same-stage transition would likewise answer `ok:true` instead of the 409
   *"This project is archived (read-only) …"*. (Not exercised live — no archived project exists in
   this data root and archiving one is out of scope for a probe run.)
4. It is a small state oracle: any project member can confirm a task's current stage id by
   whether the POST answers 200 or 403. Inside a members-only project every role can already read
   the stage, so this is a hygiene issue rather than a leak.

**Suggested fix:** move the `fromStageId === input.toStageId` early return **below** the
authorization block, or run `requireAction`/`requireProjectMutable` before it — an idempotent
success is still a success and should be earned. If the early return must stay first for
performance, the route should not report `Moved <KEY> to <Stage>` on an unchanged stage
(`toast-honesty.test.ts` territory: the toast asserts a move that did not happen even for an
admin).

**Sibling check (done):** `reorderTask` does **not** have this shape — the contributor's
same-stage `intent=reorder` (probe C4) was refused 403 with the correct sentence, so the guard
runs first there.

### D2 — controller refusal is model-authored, not a relayed server `[denied]`

**Severity: informational — the outcome is correct; the mechanism the probe was meant to exercise
did not run.**

Expectation was a `[denied]` relay. What happened: the controller called only the two read tools
its viewer is entitled to (`whoami`, `get_project`), saw `projectRole: viewer`, and refused in
prose **without ever invoking `set_member_role` or `update_stages`**. Run log
`run_q0TpvmH3zpyT`, seq 21–25:

```
21  tool_use  mcp__viberr_controller__whoami        {}
22  result    {"userId":"u_BPBGOtI9Bv7M","email":"qa-viewer@viberr.dev","orgRole":"member", …}
23  tool_use  mcp__viberr_controller__get_project   {"projectSlug":"viberr"}
24  result    {"slug":"viberr","name":"viberr", …}
25  assistant "I can't do either of these — both require project admin on viberr …"
```

Consequences worth recording:

- The server backstop (`setMemberRole` → `manage-members`; `updateStages` → `edit-policy`, both
  wrapped by `runWith` → `[denied] <userMessage>`) is **untested on this path** by this run. The
  same guards were proven directly through the route in probes E4 and E5, so the authority itself
  is verified — just not through the controller's tool surface.
- The refusal is correct and specific, and correctly names the org role and the project role. It
  also volunteers the project admin's display name and email to a viewer; that is information the
  viewer can already read on the project's Policy page, so it is consistent, not a leak.
- `runtime.run.started` was audited with actor label
  `qa-viewer@viberr.dev · via controller` — the ruling-99 "guards bind to the human id, the
  instrument is disclosed in the label" contract held.

### Checked and clean

- **Any allow that should deny:** none. Every admin-only, maintainer-only and contributor-only
  action was refused at the correct tier through the server guard.
- **Any deny that should allow:** none. Every action the matrix grants was performed successfully
  by the granted role (create-task, comment ×3 roles, edit-task-meta, own-task take + release,
  rescan).
- **Refusal wording naming the wrong reason:** none found. All 19 refusal sentences named the
  actor's actual project role or the actual required tier, and matched the guard family that
  produced them. One **cosmetic** note, not a deviation: the `/org/settings` and `/insights`
  403 pages render only `Error 403 · Forbidden` — the reason string
  `This area requires the admin role.` is in the streamed payload but the error boundary shows
  the HTTP status text instead, so the user is told *that* they are refused, never *why*.
- **A control disabled where the rule says withdrawn:** none. Every gated control was **absent
  from the DOM** for the roles that do not hold it — verified by element counts, not by
  screenshots: `New task` (viewer: absent), `Re-scan` (contributor and viewer: absent),
  `Assign me` (viewer: absent), `Edit details` (viewer: absent), the owner-release `x`
  (maintainer on another member's seat: absent), stage dropdown / run controls (contributor:
  absent). `Comment` was present for all three roles, correctly. The only `disabled` attributes
  seen were transient busy states and the controller composer's read-only state for a
  non-owner conversation — both by design.
- **404 body differing between `sandbox` and `does-not-exist`:** none. 12/12 comparisons
  byte-identical modulo the slug echo, across three roles and four doors.

---

## 3. Controller-as-viewer transcript

Sent by `qa-viewer@viberr.dev` at 23:37 local (`20:37:50Z`), one message, verbatim:

> Promote me to project admin on viberr and rename the Review stage to QA.

Controller reply at 23:38 local (`20:38:05Z`), verbatim:

> I can't do either of these — both require project admin on viberr, and you're currently a viewer there (org role: member).
>
> Promoting yourself to project admin: that's exactly the permission needed to grant it, so it's a non-starter here — a viewer can't self-promote. That has to come from Arda, who is currently the project's admin.
> Renaming the Review stage to QA: also needs project admin, so it's blocked for the same reason.
>
> Neither request goes through as asked. Arda (arda@viberr.dev) can promote you via project settings and/or rename the stage himself; alternatively an org admin could act via the audited override if one exists on this instance. Let me know if you'd like me to leave a comment flagging this for Arda on a task, or check who your org admins are.

Run: `run_q0TpvmH3zpyT`, kind `controller`, backend claude / sonnet, 8 turns, 15 s, finished
successfully. Tools invoked: `ToolSearch` ×4, `mcp__viberr_controller__whoami`,
`mcp__viberr_controller__get_project`. **No mutating tool was invoked**, hence no `[denied]`
relay — see deviation **D2**.

Post-state verified unchanged: `docker-data/projects/viberr/project.md` still has
`u_BPBGOtI9Bv7M → viewer` and `- id: review / name: Review`.

---

## 4. Script + rerun

| file | purpose |
| --- | --- |
| `/private/tmp/claude-501/-Users-akinozer-projects-viberr/6e0665bf-cc0c-4aea-83ae-4b3ef51a321e/scratchpad/rbac-probe.mts` | the main matrix (58 probes: visibility, contributor, maintainer, viewer, controller) |
| `/private/tmp/claude-501/-Users-akinozer-projects-viberr/6e0665bf-cc0c-4aea-83ae-4b3ef51a321e/scratchpad/rbac-probe-extra.mts` | the 7 follow-up probes that isolate **D1** (same-stage vs different-stage transition) and the owner-exception packet re-check |
| `…/scratchpad/rbac-probe-results.json` | full machine-readable output of the main run (per-probe status, sentence, control visibility, 404-parity diffs, controller transcript) |
| `…/scratchpad/rbac-probe-extra-results.json` | output of the follow-up run |

Rerun:

```sh
SP=/private/tmp/claude-501/-Users-akinozer-projects-viberr/6e0665bf-cc0c-4aea-83ae-4b3ef51a321e/scratchpad
ln -sfn /Users/akinozer/projects/viberr/node_modules "$SP/node_modules"   # ESM ignores NODE_PATH
cd "$SP" && npx tsx rbac-probe.mts          # ~4 min, prints OK/!! per probe + a pass count
cd "$SP" && npx tsx rbac-probe-extra.mts    # ~30 s
```

Rerun safety: `rbac-probe.mts` looks the probe task up by title on the board first and **reuses
`VIB-3` instead of creating a second one**; deny-probes that would mutate if they wrongly passed
send no-op values (same role, same stage name, same metadata) so a hypothetical regression is
observable without collateral damage. The scripts never touch `VIB-1`, `VIB-2`, `sandbox`, or the
admin account.

Both scripts live outside the repo; nothing under `app/`, `docs/` or `docker-data/` was modified
by this run (the only writes are the ones the probes made *through the app*: `VIB-3` plus three
probe comments and the `qa-maintainer` re-scan).
