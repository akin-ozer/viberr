# Glossary

> The vocabulary the code, the UI and the rulings use. Where a term has an
> enum behind it, the enum is the truth and is named. Verified against `main`
> @ `68b5480` (2026-09-01); the ruling-121 terms re-verified against the
> working tree on 2026-09-03. Updated 2026-09-02 for ruling 127 (branch
> `claude/per-user-codex-auth-difdnn`): **Backend** rewritten, **Agent account** and
> **Credential principal** added.

**Acceptance** — the human act that closes a task into the terminal stage. Verdict-gated (ruling 20), requires the review PR head to contain the delivered revision, refuses while the PR is closed unmerged (ruling 37), and must carry the disclosure echo the human was shown (ruling 88). Two other endings exist: **force-accept** (admin-only override of the verdict gate, audited `task.acceptance.forced`, recorded as `acceptance: forced` and rendered `bypassed`) and **Completed, no changes** (a verified empty diff or no branch; still verdict-gated, merges nothing).

**Actor reference** — how a file names who did something: `user:<id> (Name)`, `agent:<backend>/<profileId>`, `operator`, `controller`, `system:<id>`. Codec in `app/server/files/actor-ref.server.ts`.

**Agent account** — one person's connection to one backend, on Profile → Agent accounts (ruling 127). One row per `(user, backend)` in `user_backend_credentials`, replaced when they connect a different way. Three `kind`s: `login` (a hosted sign-in run by the unmodified vendor binary; the credential file lives in that person's runtime home under `runtimes/users/<userId>/`, and Viberr holds no secret at all), `api_key` and `access_token` (a pasted value, sealed, shown only as its last 4 characters). `method` records which vendor flow signed in: `claudeai | console | device`.

**Agent profile / template** — an org-level markdown file `agents/profiles/<id>.md` describing an agent: `kind` (`operator | specialist | controller`), backends, model, effort, eligible stages (`stages` / `spanAll`: where the profile may be **newly engaged** on a task, resolved per board by R14-1's three steps; ruling 133), resources (skills, MCPs, KBs), persona body. Templates are **deployed** into projects.

**Always-human capabilities** — `merge-pull-request`, `transition-to-done`, `change-project-policy`. A server invariant (`ALWAYS_HUMAN_CAPABILITY_IDS`); no stored grant can hand them to an agent.

**Attachments** — files under `projects/<slug>/tasks/<KEY>/attachments/` that a run granted `attach-evidence-references` (or the browser MCP) wrote. Served member-only at `/projects/:slug/tasks/:key/attachments/:file`; images render as timeline thumbnails. Every kind opens an in-app card with a Download button — images the picture, text files a read-only reader, anything else a "no in-app preview" note — and at run completion the browser MCP's machine-stamped working artifacts are pruned unless the run cited the exact filename (ruling 105).

**Autonomy** — the operator deployment's `supervised | full` setting. Supervised operators recommend at governed boundaries; full operators act. A per-run level is clamped to the configured ceiling (ruling 67).

**Backend** — `claude` (Claude Agent SDK) or `codex` (Codex SDK). Since ruling 127 a backend is not "configured" or "unavailable" for the instance: it is connected, or not, **per person**, and a run's answer is the health of its own credential principal (`userBackendHealth`: `available` plus a `verification` of `credential | file | presence | none`). The only instance-level number is `connectedUsers`, on `/resources/health`. Display label for `claude` is "Claude" (ruling 92). *(Rewritten 2026-09-02 — the old entry said "`real` means a credential is present", which was an environment probe that no longer exists.)*

**Boundary** — the rule on a workflow edge: `auto` (the operator may cross it), `approval` (a human approves the operator's request), `human` (a human decides). The edge into the terminal stage is always `human` and `locked`.

**Capability** — an id in `UNIFIED_CAP_CATALOG` (`app/shared/capabilities.ts`) with a per-deployment mode `direct | recommend | human | off`. Enforcement scope is `both`, `claude-only` or `advisory` per capability (`capabilityEnforcement`). Specialists never hold `recommend`; a stray one normalizes to `off` (ruling 81).

**Connection** — an org-level GitHub owner + PAT (`github_connections`). Distinct from a user's stored PAT (`github_pats`) and from a project's credential binding (`project_github_credentials`).

**Controller** — the single instance-level conversational agent (`kind: controller`) reachable at `/controller`, `/projects/:slug/controller` and, on every signed-in surface, through the controller dock. Every tool call runs under the asking user's live authority (ruling 99). Its configuration is deployment-locked by default (ruling 108).

**Controller dock** — the floating Controller button (bottom-right, every signed-in surface except the controller pages and login) and its non-modal panel, bound to the place the person is standing (ruling 121). A **conversation scope** is that binding: instance, one board, or one task; the server gathers the scope as a **context read** at the start of every turn (the task's `task.md` verbatim and bounded, or a board snapshot, or the person's projects). A user message's **surface** is the page it was sent from.

**Credential principal** — the ONE person an agent run bills, persisted as `agent_runs.credential_user_id` (ruling 127). Task runs (operator, specialist, resume, scheduled, boot recovery, retry) use the **task owner**; controller turns use the **asker**. Resolved by `run-principal.server.ts`, which either returns the principal and their backend health or a typed refusal (`unowned`, `owner-missing`, `no-credential`) whose single human sentence comes from `principalRefusalMessage`. A refused run writes an honest `run·unavailable` error run and starts no process; the column is NULL only on such a run.

**Data root** — `VIBERR_DATA_ROOT`. Holds canonical files, SQLite, run logs, KBs, skills and the per-person agent homes under `runtimes/users/` (ruling 127). One app process per data root, enforced by `state/writer.lock`.

**Decision packet** — the one open structured question on a task (`## Packet` in `task.md`): `type` `input | blocked`, observations, and options whose `kind` is one of `PACKET_OPTION_KINDS` (`accept_completion`, `request_edit`, `block_on_policy`, `hold_runtime_debug`, `redirect`, `retry_other_backend`, `edit_goal`, `archive_task`, `discard_branch`, `resolve_remote_collision`, `force_accept`, `move_stage`, `custom`). Resolution dispatches on the kind, never the title (ruling 7), which is why an option's title is a promise its kind has to keep: a send-back option whose words describe a force-accept, a stage move or an agent-profile edit is refused where it is authored, and named for the kind that performs it (ruling 164). A failed run's recovery packet names the cause Viberr classified and the credential principal's own remedy, and a recovery option's label states what the human asserts; its recorded decision is that label or its pre-authored `ev` (ruling 130).

**Delivery** — pushing the task branch and opening the review PR. An operator decision (capability `deliver-review-pr`, ruling 21) executed by the server; specialists never push and nobody pushes by hand. Humans can trigger it directly (`deliver-review` intent). Delivery is defined by the remote (ruling 134): the push reads origin's head first, answers `up_to_date` when it already carries the workspace head, and otherwise pushes and says what moved; rework on a task whose PR is already open is delivered the same way and moves that PR's head.

**Repository bootstrap** — ruling 128: when the project's default branch has no ref (an empty repository, or one whose only refs are task branches), Viberr creates it before a task's first branch, by an initial commit or at the first commit of GitHub's current default, disclosed on the timeline and audited as `github.repo.bootstrapped`.

**Deployment** — a `project.md` `agents[]` entry `{profileId, capabilities, extras, definition?}` that puts a template on a project with a project-effective capability policy.

**Diagnostics** — tolerant-parse findings (`info | warning | error`, `hardStop`). Warnings floor readiness at `input_required`, errors at `inconsistency_risk_detected`, hard stops at `blocked`; a hard-stop file is read-only to the app (`file_not_trusted`).

**Dispatch** — running a deployed agent on a task (`run_agent` for the operator, `run-agent` intent for humans). Running an unengaged profile **engages** it; delivering iff the task has no deliverer and the profile holds repo-write, supporting otherwise (ruling 98). Refused outright on an **archived** task, like every other governed mutation on one. *(Added 2026-09-05: the dispatch checked nothing, so an abandoned task could still start a billable run — and a seat it auto-engaged could not be released again, because `removeReviewer` refuses on archived. The STAGE is a separate question: ruling 133 licenses engaging an eligible profile at any stage, terminal included.)*

**Engagement** — an entry in `task.md` `engagements[]`: `{profileId, backend, role, delivers, verdictCapable, pinnedBackend?}`. At most one has `delivers: true` (the **delivering engagement**, owner of workspace, branch and PR). Others are **supporting engagements**; a supporting engagement with `verdictCapable: true` is a **required reviewer**. Stage eligibility gates NEW engagements only (ruling 133): once a profile is the task's delivering engagement it may be prompted or resumed on that task at every stage, while a supporting engagement runs only at the stages its profile declares.

**Goal (chained goal)** — one outcome decomposed into an ordered chain of tasks, canonical at `projects/<slug>/goals/<id>.md` (`status` `active | paused | attention | completed | cancelled`, `onFailure` `pause | continue`, links with `pending | active | done | failed | skipped`). Tasks are created lazily as links complete; each task carries `goalRef`.

**Guardrails** — per-project anti-noise rows in `project.md`: `meaningful-comment`, `no-duplicate-summary`, `compression-threshold` (default 40 events), `evidence-separation`; plus the `delete-branch-after-merge` row the branch-cleanup policy reads. `operator-brevity` was removed (ruling 104). Edited on Policy → Guardrails (toggle, threshold value, removal of retired rows; ruling 112); the branch-cleanup row is edited on Settings → GitHub.

**Guest** — a registered user who is not a member of the surrounding project. Renders as a pill on their comments.

**Knowledge base (KB)** — a folder under `kb/<dir>/` whose text documents are injected into granted runs. Grants reference the **directory**, never the display name. Repo-documented conventions outrank KB guidance (ruling 56).

**MCP server** — an org-registered Model Context Protocol server (`HTTP` or `stdio`) a profile may be granted. Granting a server is the whole authorization for its tools (ruling 39). Names in `RESERVED_MCP_NAMES` (`viberr`, `viberr_agent`, `viberr_browser`, `viberr_controller`, `viberr_ops` and their hyphen forms) belong to Viberr's in-process servers.

**Operator** — the per-task coordination agent (`kind: operator`, one deployment per project, attached to a task when it leaves the entry stage). It triages, dispatches agents, opens packets, recommends or performs transitions, and decides delivery. It never writes code.

**Org role** — `users.role`: `admin | member`. Governs instance surfaces (org settings, insights, audit export). Distinct from project roles.

**Owner** — the one human on a task (`ownerUserId`), seated at creation as the creator (ruling 127) or as the member named at creation, before the first operator run (ruling 140(a)). Contributor or above may take or release; the owner governs any open decision on their own task, including accepting completion (FR37, rulings 22), and every agent run on the task bills the owner's own agent accounts, so an unowned task cannot run agents at all.

**PR state** — the `task.md` `pr.state` cache: `review` (open or draft), `merged`, `closed` (closed unmerged), `accepted` (a full-autonomy operator accepted; merge pending for a human). Sync pill precedence: merged > behind > synced.

**Project role** — `admin | maintainer | contributor | viewer`, a strict tier stored in `project.md` `members[]` and enforced through `app/shared/rbac.ts`. Membership is the outer gate: non-members get a 404 (ruling 25).

**Projection** — a SQLite row derived from a canonical file. **Rescan** reconciles changed files by content hash; **rebuild** drops all derived rows and re-projects everything.

**Provenance** — the `provenance` table: what the projector and reconciler observed, and when. Not retained; not user-facing except freshness chips.

**Blocked by** — a task's `blockedBy` list (ruling 131): the task keys and goal links (`goal-1 link 3`) in the same project it waits on. While non-empty the derived readiness is floored at `blocked`, the card, list row and task page say what it waits on and in what state (resolved at read time), the task is never "gone quiet", and Viberr releases it itself when every entry is done. No project may take `GOAL` as its task prefix: `GOAL-1` reads as a goal reference missing its link, so its tasks could never be waited on.

**Readiness** — the stored 4-value enum `ready | input_required | inconsistency_risk_detected | blocked` (ruling 1), derived only in `readiness-policy.server.ts`; a non-empty `blockedBy` floors the derived value at `blocked` (ruling 131). Surfaces additionally render the derived display value `agent_working` while `waiting === "agent"` (ruling 91) and "accepted" for done-stage tasks.

**Recommendation** — a pending card the supervised operator leaves on a task: kinds `transition`, `run_agent`, `accept_completion`, `delivery`. Apply executes the same mutation a human would; Dismiss records it. An `accept_completion` card binds to the work revision it was made for (`forHeadSha`) and is withdrawn, on the record, when that revision is replaced, a packet opens, or the task leaves the acceptance boundary (ruling 137).

**Revision (work revision)** — the immutable identity of the work under review: `{id, headSha, treeSha, branch, createdAt, sourceProfileId, kind: delivered | verified}`. A new head with a different tree mints a new revision, which stales every prior verdict.

**Revision drift** — how far the PR head has moved past the reviewed revision, recorded by the reconciler as `pr.revisionDrift {headSha, authored, baseRefresh}` (ruling 132). `authored` counts commits since the review that are the branch's own and not a merge Viberr recorded in `baseRefreshes`; `baseRefresh` counts the base commits and clean merges an `update_branch_from_base` brought in. `describeRevisionDrift` prints the one sentence every surface shows; only authored commits are "unreviewed". A base refresh is reported as a base refresh.

**Ruling** — a numbered owner decision recorded in [decisions.md](../architecture/decisions.md). Code comments cite them as "ruling N"; superseded rulings are kept and marked, never deleted.

**Run** — one execution of an agent through a backend: `agent_runs` row + raw NDJSON transcript. `kind` is a delivery axis (`operator | primary | reviewer | controller`); `state` is `queued | running | finished | error | interrupted`. An `interrupted` run names who stopped it (`interrupted_by`, a person) or why (`interrupted_reason: restart`, boot recovery); a restart is never an error.

**Schedule** — a future run recorded in `task.md` `schedules[]`: `run-operator` (optional steer) or `run-agent` (a profile id + prompt). Statuses `pending | claimed | fired | failed | cancelled`. Resolves the live deployment at fire time; never fires on a terminal task.

**Scope violation** — a recorded PAT permission gap (`scope_violations`), opened by the reconciler or a refused push, resolved by re-validating the credential. The rail Settings badge is the open count.

**Session export** — `/resources/session-export?run=<id>`: a bash installer carrying the provider transcript so a run can be resumed locally with `claude --resume` / `codex resume`.

**Skill** — a folder `skills/<name>/SKILL.md` (plus supporting files). Claude runs load granted skills through the SDK's native skills mechanism; Codex runs get the body injected as prompt text (ruling 51).

**Stage roles** — `entry`, `ready`, `work`, `review`, `terminal`, derived from the per-project stage list and workflow graph (`resolveStageRoles`). Stage ids are never hard-coded.

**Timeline event** — a `### <ISO> · <type> · <actor>` block in `task.md`, `type` one of `TIMELINE_EVENT_TYPES` (`comment`, `completion`, `github`, `policy`, `note`, `quality`, `transition`, `blocked`, `agent`, `assign`, `continuity`). `policy` is reserved for genuine violations and refusals; neutral system remarks are `note`.

**Validation** — the derived review-state cache in `task.md`: `healthy | changed | failing | none | bypassed` (`deriveValidation`). Never hand-edit it.

**Verdict** — a required reviewer's `approve | request_changes`, bound to a revision id. A project member's GitHub approval on the PR, bound to the delivered head, counts as an approving verdict (ruling 68).

**Decided packet** — an `edit_goal` packet whose option was confirmed: `awaiting: goal_edit` plus `decided { optionIndex, at, byUserId }`. It reads as decided on every surface (display readiness `goal_edit_pending`), and its only way out is saving the edited goal, prefilled by `goalDraftForOption` from the option's `goalDraft` (ruling 138).

**Waiting** — `human | agent | none`: whose turn it is. Forced to `none` in the terminal stage; `none` while a task waits on other work with no packet or recommendation open (ruling 131).

**Workspace** — the delivering engagement's git clone under `tasks/<KEY>/workspace/<repo>`; supporting runs get `workspace/support/<profileId>/<repo>`. Cut from a per-project mirror; reclaimed once the task is terminal.
