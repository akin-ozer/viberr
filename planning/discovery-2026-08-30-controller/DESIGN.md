# The Viberr CONTROLLER — design (2026-08-30)

Owner directive: one instance-level conversational agent, machinery like the operator but
above it. Users ask it questions and ask it to act; what it answers and applies is gated by
THAT user's own permission level, evaluated separately per scope. It is never a privilege
escalation channel. Chained goals are the one new product concept. Preprod: breaking
changes allowed, no backwards compatibility.

This document is the deep-reasoning pass the directive requires: every design decision,
with the code fact that forced it.

## 1. What the controller IS

- A third profile kind: `kind: controller`, exactly one per instance, seeded as
  `agents/profiles/controller.md` + `agents/definitions/controller.md` (its system
  prompt), plus its own skill (`skills/controller-guide/`) and its own knowledge base
  (`kb/controller-handbook/`). Its MCP connections resolve from the org registry through
  `resources.mcps`, like every profile.
- Only org admins modify the controller itself (profile, resources, prompt): the org
  settings agent editor is already admin-gated; `saveGlobalAgentProfile` gains guards —
  the controller row cannot change kind, cannot be deleted, and no second
  `kind: controller` profile can be created.
- It is NOT deployable to projects. It spans the instance; a project-scoped conversation
  is the same controller bound to a project context. The project deploy list never offers
  it.
- Backend: **Claude only, enforced, and disclosed** — the same security decision as
  `read-github-api` (ruling: the toolkit is in-process; DB handles and sealed credentials
  never cross a process boundary; Codex has no in-process tool channel, and its
  single-shot plan executor cannot serve a conversation that must read mid-turn).
  If no Claude credential is configured the controller surface says so honestly.

## 2. Authority model (the heart)

The asking user's authority is the ceiling. Mechanism, not prompt-hope:

- Every conversation belongs to a user (`onBehalfOf`). Every TOOL handler resolves that
  user's live authority at call time (never snapshotted at conversation start).
- **Instance scope** (org-role axis):
  - org admin required: users read/create/update, KBs, skills, MCP connections, global
    agent templates, audit-log inspection, run-analytics inspection — parity with
    /org/settings and /insights gates (`requireRole("admin")`).
  - any signed-in user: list/read their visible projects; **create projects** — parity
    with FR5 ("creation is self-serve for any signed-in user; the creator is seeded as
    the new project's admin"). The org-role axis decides the floor; for creation the
    product's floor is `member`.
- **Project scope** (project-role axis): every tool maps to a canonical `RbacAction` and
  goes through the SAME guards humans use — `assertProjectAction` / `requireAction` with
  `actor = the asking user` — so the D2 org-admin override, the denial audit rows
  (`project.authority.denied`), the archived-project read-only gate and members-only
  visibility (R15-4) all apply identically and for free.
- **Attribution**: authority actor is `{userId: asker.id, label: "<email> · via controller"}`
  — guards bind to the human; audit rows disclose the instrument. The controller's own
  timeline comments use a new `controller` actor ref (renders "Controller"), and its
  @mentions notify through the shared `notifyMentionedUsers` (NEW-4).
- **Refusal out loud**: a denied tool returns `[denied] <the guard's own sentence>`; the
  controller's prompt requires relaying the refusal and the missing tier plainly. Org-scope
  denials are audited (`controller.authority.denied`) to match the project-scope precedent
  (P13-D-8: an attempt to exceed a role never leaves a clean log).
- **Always-human invariants stay human**: the toolkit simply has NO tool for merge,
  acceptance, force-accept, packet resolution, or a terminal-stage move — the move tool
  refuses a Done target and points at the task page's acceptance ceremony (ruling 88's
  disclosure requirement is why: the confirm dialog IS the contract, and chat cannot
  impersonate it). Policy edits ARE offered (the owner's verb list includes them) because
  a project admin's explicit conversational directive is the human action — the
  `change-project-policy` ALWAYS_HUMAN entry bounds AGENT-initiated policy change, and the
  controller never initiates: it executes a directive under the asker's `edit-policy`.
- **No deletes anywhere**: no delete tools exist, in either scope.
- **Secrets never travel through chat**: `save_mcp_server` takes no credential parameter
  (the controller directs admins to Org settings for the secret); the one exception is the
  single-use temp password from `create_user`/`reset_password`, which is relayed because
  the account is unusable without it and `pwreset_required` forces a change at first
  sign-in.

## 3. Conversations

- Store of record: app-owned SQLite (`controller_conversations`, `controller_messages`) —
  the same family as notifications/sessions/audit (file-formats §5). Conversations are
  single-writer app collaboration state, not board truth; nothing hand-edits them.
- Each user message drives one run through the EXISTING run machinery (`startRun` /
  `resumeRun`, `agent_runs.kind = 'controller'`, task columns NULL): raw NDJSON, redaction,
  SSE `run.log-appended`, `/resources/run-log` paging, token accounting, insights rollup —
  all for free, and the full working transcript stays readable back later.
- Session continuity mirrors the specialist pattern: resume the provider session per turn;
  a missing transcript re-anchors on a bounded recent-transcript injection.
- Single-flight per conversation with a FIFO of queued user messages (operator-lease
  pattern; token-matched release).
- Visibility: the owner and org admins. Replies also land as a `controller` notification
  so an answer that arrives after the user navigated away is not silent (NFR3 spirit).

## 4. Chained goals (the new product concept)

A goal is a project-scoped, ordered chain of tasks the controller creates, tracks and
advances. Design follows the store's own constraints (files are canonical; projections are
disposable; no cross-file transactions; Done is human unless the project's own autonomy
says otherwise).

- **Canonical file**: `projects/<slug>/goals/<goal-id>.md` — frontmatter
  `{id, title, status: active|paused|attention|completed|cancelled, createdBy,
  createdByLabel, onFailure: pause|continue, links: [{index, title, goal, taskKey|null,
  status: pending|active|done|failed|skipped, note}], createdAt, updatedAt}`, body =
  `## Description` + `## Timeline` reusing the task event grammar verbatim (parser and
  renderer already exist).
- **Task back-reference**: new tolerant task frontmatter field
  `goalRef: {goalId, linkIndex}`, projected to `task_projections.goal_id/goal_link_index`
  so board cards and the advance hook never join through files at read time. The
  project→task precedent (project.md owns stages; task.md carries `stage`) is the model.
- **Lazy task creation**: link 1's task is created with the goal; each later task is
  created only when its predecessor completes. The created task's Goal section carries the
  chain context (goal id, link position, predecessor outcome), and `createTask`'s existing
  `create` trigger hands it to that task's own operator — the controller sits above
  operators and never duplicates them.
- **Advance**: when a chained task reaches the terminal stage, `advanceGoalForTask` (called
  from the acceptance/transition write path, plus a boot/rescan reconciler for missed
  events) marks the link done and creates the next task. Authority at advance time is
  re-proven: the goal records `createdBy`, and the creator must STILL hold `create-task`
  in the project — if not, the chain pauses visibly (`attention`) instead of escalating
  (FR39's precedent: the one shape of unattended action, so it stays visible, cancellable,
  audited).
- **Failure**: a chained task that is archived marks its link `failed` with the reason;
  `onFailure: pause` (default) parks the chain in `attention` and notifies the creator;
  `continue` skips to the next link with the failure noted. Humans redirect through the
  Goals surface or the chat: retry (a fresh task for the failed link), skip, edit pending
  links, pause/resume, cancel. No goal is ever deleted.
- **Idempotency**: link advancement re-checks link status inside the goal file's own
  `withFileLock` (the packetIdentity pattern); task creation for a link is guarded by the
  link's recorded `taskKey`.
- **Projection**: `goal_projections` table + rebuilder arm + watcher path class + SSE
  `goal.updated`; status is DERIVED against live task rows on rebuild (the stored link
  status is a claim, reconciled like `noChanges`).

## 5. Surfaces

- **Instance**: `/controller` in the palette-shell layout (the /insights recipe), open to
  every signed-in user. Conversation list + transcript + composer; live status while a
  run is working, with the runtime console one click away. Entry points: Home hero
  button + ⌘K.
- **Project**: an eighth `WORKSPACE_NAV` item, `projects/:slug/controller` — same chat
  bound to the project, plus the **Goals** panel (chain cards: per-link status, the live
  task chip, and redirect controls). Task detail shows a goal chip linking back.
- Transcript rows reuse the timeline visual grammar; the composer reuses
  `CommentComposer`. New CSS goes in one appended, banner-marked app.css section using
  existing tokens only.

## 6. Product-canon amendments this ships with

- FR11 (agents cannot create tasks) is amended: the controller creates tasks as the
  instrument of an authorized asking user, and goal-chain advancement creates tasks under
  the goal creator's re-proven authority. The bar on agents INVENTING tasks stands.
- decisions.md gains ruling 99 (the controller contract) — including why policy-edit via
  controller does not breach the ALWAYS_HUMAN list, and why merge/acceptance/Done are not
  in its verb set.
- PRD gains the controller + chained-goals FRs; `design/prd.md` stays byte-identical
  (prd-sync.test.ts).
- file-formats.md documents the goal file and `goalRef`; README's surface list gains the
  controller.

## 7. Test contract

Unit/integration: every tool's permission arms in both scopes (allowed AND the lower-tier
refusal), the org-admin override audit, no-escalation probes (member ↛ user admin;
viewer ↛ create-task; contributor ↛ move; maintainer ↛ policy edit; non-member ↛
project reads), terminal-move refusal, controller singleton guards, goal lifecycle
(advance, failure, pause/redirect/cancel, authority re-proof at advance, idempotent
advance), conversation round-trip + queueing, seed idempotency. Live: converse as admin
and as a low-tier member on :5174, build a customized project through the controller,
define and run a chained goal end to end, screenshot every surface.

## Live validation record (2026-08-30, hermetic :5174)

Data root: `./data` re-baselined onto the new schema with users/PATs preserved
(one-off copy script; the documented wipe recipe loses sealed credentials).
Claude backend real via the host OAuth token. Everything below is a real run.

- **Instance conversation (admin)**: asked for an instance overview; the
  controller read all three boards through its tools (36 turns) and answered
  with grounded facts: VIB-1 acceptance-ready with its PR mergeable, VQP-4's
  blocked packet, VQP-5 stalled at triage, the pending invite.
- **Customized project in one request**: "Release Ops" (ROPS) on
  akin-ozer/viberr — five custom stages (Shipped terminal, locked human),
  Plan→Execute forced to approval, qa-contrib seeded maintainer — landed as one
  project.md write, verified byte-level. Same turn: reset qa-contrib's
  password; the one-time temp password was relayed and worked at the real
  login, forcing the reset gate.
- **Chained goal end to end**: goal-1 (2 links) defined conversationally on
  the project surface; ROPS-1 created immediately with `goalRef` and the chain
  context in its Goal; ROPS-1's own operator started unprompted. Admin
  force-accept (full ceremony: skipped stages + gate bypass enumerated) closed
  ROPS-1 → the chain advanced on its own: link 2 marked ROPS-2, task created
  under the creator's authority, `controller` notification delivered. The
  Goals panel showed done/active links; the MAINTAINER paused the chain from
  it (redirect arm, live).
- **Custom governance honored by operators**: ROPS-2's operator triaged from
  the repo checkout, crossed Intake→Plan (auto) itself, then STOPPED at the
  Plan→Execute approval boundary with a recommendation — exactly the boundary
  the controller was asked to tighten. No branch was pushed; GitHub untouched.
- **No-escalation, live**: as qa-contrib (org member), one message asked for
  the user list (org-gated), the viberr board (not a member), and a task on
  release-ops (maintainer). The reply: refusal with the reason and a pointer,
  the not-found posture with no existence oracle, and ROPS-3 created. Audit:
  `controller.authority.denied` for the probe, `goal.created` for the chain,
  the D2 override rows for admin reads.
- **Zero server errors** across the whole session.

Gates: typecheck clean · lint zero-delta vs main (25 pre-existing local
version-drift errors untouched) · vitest 4595 green (43 new controller/goal
tests) · production build clean · e2e (production-image stack) exit 0.
