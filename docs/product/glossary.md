# Glossary

> The vocabulary the code, the UI and the rulings use. Where a term has an
> enum behind it, the enum is the truth and is named. Verified against `main`
> @ `68b5480` (2026-09-01).

**Acceptance** — the human act that closes a task into the terminal stage. Verdict-gated (ruling 20), requires the review PR head to contain the delivered revision, refuses while the PR is closed unmerged (ruling 37), and must carry the disclosure echo the human was shown (ruling 88). Two other endings exist: **force-accept** (admin-only override of the verdict gate, audited `task.acceptance.forced`, recorded as `acceptance: forced` and rendered `bypassed`) and **Completed, no changes** (a verified empty diff or no branch; still verdict-gated, merges nothing).

**Actor reference** — how a file names who did something: `user:<id> (Name)`, `agent:<backend>/<profileId>`, `operator`, `controller`, `system:<id>`. Codec in `app/server/files/actor-ref.server.ts`.

**Agent profile / template** — an org-level markdown file `agents/profiles/<id>.md` describing an agent: `kind` (`operator | specialist | controller`), backends, model, effort, eligible stages, resources (skills, MCPs, KBs), persona body. Templates are **deployed** into projects.

**Always-human capabilities** — `merge-pull-request`, `transition-to-done`, `change-project-policy`. A server invariant (`ALWAYS_HUMAN_CAPABILITY_IDS`); no stored grant can hand them to an agent.

**Attachments** — files under `projects/<slug>/tasks/<KEY>/attachments/` that a run granted `attach-evidence-references` (or the browser MCP) wrote. Served member-only at `/projects/:slug/tasks/:key/attachments/:file`; images render as timeline thumbnails.

**Autonomy** — the operator deployment's `supervised | full` setting. Supervised operators recommend at governed boundaries; full operators act. A per-run level is clamped to the configured ceiling (ruling 67).

**Backend** — `claude` (Claude Agent SDK) or `codex` (Codex SDK). `real` means a credential is present; `unavailable` means runs on it fail fast. Display label for `claude` is "Claude" (ruling 92).

**Boundary** — the rule on a workflow edge: `auto` (the operator may cross it), `approval` (a human approves the operator's request), `human` (a human decides). The edge into the terminal stage is always `human` and `locked`.

**Capability** — an id in `UNIFIED_CAP_CATALOG` (`app/shared/capabilities.ts`) with a per-deployment mode `direct | recommend | human | off`. Enforcement scope is `both`, `claude-only` or `advisory` per capability (`capabilityEnforcement`). Specialists never hold `recommend`; a stray one normalizes to `off` (ruling 81).

**Connection** — an org-level GitHub owner + PAT (`github_connections`). Distinct from a user's stored PAT (`github_pats`) and from a project's credential binding (`project_github_credentials`).

**Controller** — the single instance-level conversational agent (`kind: controller`) reachable at `/controller` and `/projects/:slug/controller`. Every tool call runs under the asking user's live authority (ruling 99). Its configuration is deployment-locked by default (ruling 108).

**Data root** — `VIBERR_DATA_ROOT`. Holds canonical files, SQLite, run logs, KBs and skills. One app process per data root, enforced by `state/writer.lock`.

**Decision packet** — the one open structured question on a task (`## Packet` in `task.md`): `type` `input | blocked`, observations, and options whose `kind` is one of `PACKET_OPTION_KINDS` (`accept_completion`, `request_edit`, `block_on_policy`, `hold_runtime_debug`, `redirect`, `retry_other_backend`, `edit_goal`, `archive_task`, `discard_branch`, `resolve_remote_collision`, `custom`). Resolution dispatches on the kind, never the title (ruling 7).

**Delivery** — pushing the task branch and opening the review PR. An operator decision (capability `deliver-review-pr`, ruling 21) executed by the server; specialists never push. Humans can trigger it directly (`deliver-review` intent).

**Deployment** — a `project.md` `agents[]` entry `{profileId, capabilities, extras, definition?}` that puts a template on a project with a project-effective capability policy.

**Diagnostics** — tolerant-parse findings (`info | warning | error`, `hardStop`). Warnings floor readiness at `input_required`, errors at `inconsistency_risk_detected`, hard stops at `blocked`; a hard-stop file is read-only to the app (`file_not_trusted`).

**Dispatch** — running a deployed agent on a task (`run_agent` for the operator, `run-agent` intent for humans). Running an unengaged profile **engages** it; delivering iff the task has no deliverer and the profile holds repo-write, supporting otherwise (ruling 98).

**Engagement** — an entry in `task.md` `engagements[]`: `{profileId, backend, role, delivers, verdictCapable, pinnedBackend?}`. At most one has `delivers: true` (the **delivering engagement**, owner of workspace, branch and PR). Others are **supporting engagements**; a supporting engagement with `verdictCapable: true` is a **required reviewer**.

**Goal (chained goal)** — one outcome decomposed into an ordered chain of tasks, canonical at `projects/<slug>/goals/<id>.md` (`status` `active | paused | attention | completed | cancelled`, `onFailure` `pause | continue`, links with `pending | active | done | failed | skipped`). Tasks are created lazily as links complete; each task carries `goalRef`.

**Guardrails** — per-project anti-noise rows in `project.md`: `meaningful-comment`, `no-duplicate-summary`, `compression-threshold` (default 40 events), `evidence-separation`; plus the `delete-branch-after-merge` row the branch-cleanup policy reads. `operator-brevity` was removed (ruling 104).

**Guest** — a registered user who is not a member of the surrounding project. Renders as a pill on their comments.

**Knowledge base (KB)** — a folder under `kb/<dir>/` whose text documents are injected into granted runs. Grants reference the **directory**, never the display name. Repo-documented conventions outrank KB guidance (ruling 56).

**MCP server** — an org-registered Model Context Protocol server (`HTTP` or `stdio`) a profile may be granted. Granting a server is the whole authorization for its tools (ruling 39). Names in `RESERVED_MCP_NAMES` (`viberr`, `viberr_agent`, `viberr_browser`, `viberr_controller`, `viberr_ops` and their hyphen forms) belong to Viberr's in-process servers.

**Operator** — the per-task coordination agent (`kind: operator`, one deployment per project, attached to a task when it leaves the entry stage). It triages, dispatches agents, opens packets, recommends or performs transitions, and decides delivery. It never writes code.

**Org role** — `users.role`: `admin | member`. Governs instance surfaces (org settings, insights, audit export). Distinct from project roles.

**Owner** — the one human on a task (`ownerUserId`). Contributor or above may take or release; the owner governs any open decision on their own task, including accepting completion (FR37, rulings 22).

**PR state** — the `task.md` `pr.state` cache: `review` (open or draft), `merged`, `closed` (closed unmerged), `accepted` (a full-autonomy operator accepted; merge pending for a human). Sync pill precedence: merged > behind > synced.

**Project role** — `admin | maintainer | contributor | viewer`, a strict tier stored in `project.md` `members[]` and enforced through `app/shared/rbac.ts`. Membership is the outer gate: non-members get a 404 (ruling 25).

**Projection** — a SQLite row derived from a canonical file. **Rescan** reconciles changed files by content hash; **rebuild** drops all derived rows and re-projects everything.

**Provenance** — the `provenance` table: what the projector and reconciler observed, and when. Not retained; not user-facing except freshness chips.

**Readiness** — the stored 4-value enum `ready | input_required | inconsistency_risk_detected | blocked` (ruling 1), derived only in `readiness-policy.server.ts`. Surfaces additionally render the derived display value `agent_working` while `waiting === "agent"` (ruling 91) and "accepted" for done-stage tasks.

**Recommendation** — a pending card the supervised operator leaves on a task: kinds `transition`, `run_agent`, `accept_completion`, `delivery`. Apply executes the same mutation a human would; Dismiss records it.

**Revision (work revision)** — the immutable identity of the work under review: `{id, headSha, treeSha, branch, createdAt, sourceProfileId, kind: delivered | verified}`. A new head with a different tree mints a new revision, which stales every prior verdict.

**Ruling** — a numbered owner decision recorded in [decisions.md](../architecture/decisions.md). Code comments cite them as "ruling N"; superseded rulings are kept and marked, never deleted.

**Run** — one execution of an agent through a backend: `agent_runs` row + raw NDJSON transcript. `kind` is a delivery axis (`operator | primary | reviewer | controller`); `state` is `queued | running | finished | error | interrupted`.

**Schedule** — a future run recorded in `task.md` `schedules[]`: `run-operator` (optional steer) or `run-agent` (a profile id + prompt). Statuses `pending | claimed | fired | failed | cancelled`. Resolves the live deployment at fire time; never fires on a terminal task.

**Scope violation** — a recorded PAT permission gap (`scope_violations`), opened by the reconciler or a refused push, resolved by re-validating the credential. The rail Settings badge is the open count.

**Session export** — `/resources/session-export?run=<id>`: a bash installer carrying the provider transcript so a run can be resumed locally with `claude --resume` / `codex resume`.

**Skill** — a folder `skills/<name>/SKILL.md` (plus supporting files). Claude runs load granted skills through the SDK's native skills mechanism; Codex runs get the body injected as prompt text (ruling 51).

**Stage roles** — `entry`, `ready`, `work`, `review`, `terminal`, derived from the per-project stage list and workflow graph (`resolveStageRoles`). Stage ids are never hard-coded.

**Timeline event** — a `### <ISO> · <type> · <actor>` block in `task.md`, `type` one of `TIMELINE_EVENT_TYPES` (`comment`, `completion`, `github`, `policy`, `note`, `quality`, `transition`, `blocked`, `agent`, `assign`, `continuity`). `policy` is reserved for genuine violations and refusals; neutral system remarks are `note`.

**Validation** — the derived review-state cache in `task.md`: `healthy | changed | failing | none | bypassed` (`deriveValidation`). Never hand-edit it.

**Verdict** — a required reviewer's `approve | request_changes`, bound to a revision id. A project member's GitHub approval on the PR, bound to the delivered head, counts as an approving verdict (ruling 68).

**Waiting** — `human | agent | none`: whose turn it is. Forced to `none` in the terminal stage.

**Workspace** — the delivering engagement's git clone under `tasks/<KEY>/workspace/<repo>`; supporting runs get `workspace/support/<profileId>/<repo>`. Cut from a per-project mirror; reclaimed once the task is terminal.
