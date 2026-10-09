# Product overview

> What Viberr is, who it is for, what it promises, and where it stands. Distilled
> from the canonical PRD and checked against the code. Requirement-by-requirement
> status is in [requirements-status.md](requirements-status.md).
> Source of truth: [prd.md](prd.md), [decisions.md](../architecture/decisions.md), `app/`.
> Verified against `main` @ `7d9fbf72` (2026-09-23).

## 1. One paragraph

Viberr is a self-hosted, multi-user web application for **governed AI software
delivery**. Small AI-forward engineering teams let persistent coding agents do
real delivery work while engineers keep control of flow, review and acceptance.
The unit of coordination is the **task**, stored as one readable markdown file
that carries state, execution context, decisions, timeline and evidence. A
dedicated **operator** agent coordinates each active task, **specialist** agents
do the stage work in isolated git workspaces, GitHub carries the branches and
review PRs, and humans govern through policy, comments, decision packets and
explicit acceptance. A board's tasks usually change its repository, but a board can
also deliver results: each task is one piece of a person's work (an estimate from an
inventory, a report from a brief), and its result comes back saved on the task, with
no pull request (ruling 268). Above the per-task operators sits one instance-wide
**controller**: a conversational agent every signed-in user can address, from its
own page or from a dock on every page, which acts strictly within that user's own
permissions and can plan work into **epics**, the named bodies of work that tasks join
and leave one at a time, as in Jira and Linear. Every agent
run bills one person's own Claude or Codex account: the task owner's, or the asker's
for a controller turn.

## 2. Why it exists

Coding agents are improving fast, but task systems remain human-native: humans
are the default workers and AI helps at the edges. Persistent agent work cannot
be governed through scattered chats, branches and status labels. Viberr inverts
the responsibility model: agents own task execution, engineers own movement,
approvals and quality boundaries, and the task file is the durable contract
between humans, agents and GitHub.

What makes it different, in the PRD's words: agent-native project management, the
canonical task as operating contract, persistent operator-and-specialist threads,
and governed AI delivery through a familiar board/task surface.

## 3. Who uses it

| Persona | What they do in Viberr |
|---|---|
| **Arda**, senior engineer (primary) | Supervises several agent threads across a project from the board; opens tasks to read the packet, execution profile and timeline; comments where guidance or acceptance is needed; accepts completions. |
| **Elif**, workflow owner / admin | Creates projects, configures stages and boundaries, the repository, human RBAC and the agent capability matrix, agent profiles and their resources. |
| **Murat**, escalation / troubleshooting | Investigates continuity failures: reads the continuity warning, confirms the task file holds enough context, drops into the provider-native session when needed. |

## 4. The operating model

1. **Files are truth.** Projects, tasks and epics are markdown under a data root that humans and agents may edit directly. SQLite holds projections for fast reads plus app-management data (users, sessions, secrets, audit, notifications, run history).
2. **A task moves through per-project stages** under governed boundaries: `auto` (operator may cross), `approval` (human approves the operator's request), `human` (human decides). The move into the terminal stage is always human, with one disclosed exception: a full-autonomy operator holding an explicit `completion-for-acceptance: direct` grant may accept, leaving the merge pending for a human.
3. **The operator coordinates, specialists execute.** The operator triages the goal, dispatches deployed agents (delivering or supporting posture derives from the agent's own grants), opens decision packets when a human must decide, recommends or performs transitions, and decides when to deliver. Specialists never push or open PRs; the server does.
4. **Humans and agents are governed separately.** Project roles (`admin | maintainer | contributor | viewer`) gate human actions through one RBAC table. Agent capabilities (`direct | recommend | human | off`) gate agent actions, enforced at run time on both backends where the runtime can, and disclosed as advisory where it cannot.
5. **Everything consequential is typed, audited and visible.** Typed timeline events, audit rows for every governed action, notifications for the people who must act, and live updates over SSE.
6. **Honesty over silence.** Malformed files become diagnostics, never crashes. A missing credential is a typed degraded state. A failed clone or push surfaces git's redacted words. Numbers the product cannot measure are not printed, and a figure a provider never reports is not shown as zero.

## 5. What ships today (V1 scope)

- Multi-user authenticated app: local credentials plus optional GitHub/Google OAuth (whitelist model, configurable in-app).
- File-native store with tolerant parsing, watcher-driven projections, manual rescan and rebuild.
- Rule-driven workflow: the "Standard · 5 stages" template (`Triage → Ready → In Progress → Review → Done`), custom stages per project with twenty named colour presets, a maintained transition chain, three policy presets at creation (`strict`, `balanced`, `auto`).
- One operator per task; dynamic dispatch of any deployed agent; required reviewers declared per review stage and verdicts bound to the work under review, commit or not; task dependencies (`blockedBy`) with a hold and a release engine; per-file leases that order deliveries on shared paths; scheduled runs.
- Claude and Codex backends via the official SDKs, each person connecting their own account (hosted sign-in or a pasted key) on Profile → Agent accounts; per-run isolated workspaces cut from a per-project mirror; governed skills, knowledge bases (delivered as an index) and MCP mounting, with admin-marked MCP write tools; a project rulings knowledge base every run reads and the operator may propose changes to; a governed headless browser; a read-only GitHub API tool; file attachments as evidence, by agents and people; an instance spending cap per Claude run; prompt-cache measurement and end-of-run session compaction.
- One GitHub repository per project that delivers software (bootstrapped when empty), and none needed for a board that delivers results; any board can start with none, and its operator asks for one once, when a task needs it (ruling 224); task-key branches; server-side delivery and PR opening; reconciliation every 5 minutes; PR adoption and branch-collision safety; base refreshes that keep the reviewed revision; branch cleanup; human approval on the PR counting as a verdict.
- Board, review queue (the decisions waiting on you on your own tasks, packets and operator recommendations, each answered in a dialog, with collision chips between open PRs), task detail (packet, execution profile, live run strip with its console, timeline), agents, policy, GitHub, activity, settings, org settings (connections, users, SSO, resources, controller, audit), notifications, profile, ⌘K palette, insights.
- The instance controller with a governed toolkit, a built-in read-only diagnostics MCP, and a dock on every signed-in page. Before it designs a project it settles whether the board delivers software or results, and builds a results board out of stages, agents, skills, knowledge bases and reviewers rather than an app (ruling 268).
- Boards that deliver results: a task's deliverable can be the files its delivering agent saves on it, judged by the required reviewer and accepted without a pull request (rulings 81, 84 and 235), with no gates owed (ruling 104).
- Epics (ruling 272): a project's Epics page and one page per epic (description, status, lead, dates, progress bar, tasks, history), task membership edited from the task page, the epic page, the board's New task and the controller, and an epic filter on the board.
- Operations: single-writer lock, self-healing projection DB, boot recovery of stranded work, retention and disk-pressure maintenance, backup/restore, key rotation, audit export (download, S3, and export-before-purge).

## 6. Deliberate boundaries and known gaps

- **No mailer.** Notifications are in-app only; admins hand over one-time passwords shown at creation. An open tab still says when a decision waits (ruling 74): its title carries the count of unread decisions, and a browser the person opted in on Profile shows a system notification for a new one while no Viberr tab is in front of them. Nothing leaves the browser: no push service, no service worker, no outbound webhook.
- **No shared agent credential.** A task with no owner runs no agents, and a person who has not connected a backend cannot be billed for one (ruling 137).
- **Codex runs are not OS-sandboxed.** Every Codex run is `danger-full-access`; Viberr's own boundaries are the boundary, so capabilities the Codex runtime cannot enforce (repo write among them) are advisory there and labelled so (ruling 144).
- **Chromium only.** The declared browser matrix is Chromium; Safari and Firefox were struck on 2026-08-31 because nothing exercised them (ruling 4).
- **Desktop-first, one surface reflowed.** Narrow viewports get the same interface with columns collapsed; nothing is hidden by width.
- **Audit retention is 90 days**, exported to JSONL before purge; an org-admin download exists (100k-row cap) and an optional S3 target. Org-scoped rows have no file counterpart past the export.
- **`provenance` has no retention** and grows unboundedly; prune by hand.
- **Notifications page caps at the newest 200 rows**; the table keeps 500 per user.
- **Plain HTTP.** TLS termination is the deployment's job; set `BETTER_AUTH_URL` behind the proxy.
- **Fine-grained PAT validation is partly probe-based**; some scopes read "unproven" until first use.
- **MCP grants sit outside the capability matrix.** Granting a server authorizes its tools, except the ones an admin marks as write tools, which a run that withholds repo write does not get (ruling 188). Viberr makes no claim about unmarked tools.
- **The spending cap binds Claude only.** Codex has no budget option (ruling 159).
- **Single node.** SQLite plus local file authority plus an in-process SSE bus; one instance per data root.
- **One schema baseline, no migration chain.** Migrations are squashed into one baseline. At boot, an older database gets the columns, tables and indexes the release lists for it, and `notifications` is rebuilt when its `kind` CHECK lags and `user_backend_credentials` when it still has its one-account shape; any other schema change reaches fresh databases only. Boot warns, with the remedy, when `task_projections` or `task_events` lacks a column or one of four checked CHECK constraints refuses a value; other drift goes unreported. There is no backwards compatibility promise for file formats (owner rulings 180 and 247 were explicitly no-back-compat; ruling 5 kept the convention at launch).

Held spec-vs-app gaps that stay noted rather than silently closed (ruling 4): the
decision packet's impact/confidence/severity fields, the Continuity Recovery Panel's
escalated and paused states plus the execution-truth-strip continuity fact, and
skeleton loaders.

## 7. Phases

- **Phase 1 (V1, shipping):** everything in §5.
- **Phase 2 (post-MVP):** richer profile templates, analytics on throughput and governance load, deeper validation workflows, collaboration ergonomics, task-graph and subtask orchestration, better reporting, refined runtime recovery tooling. Parts have landed early: `/insights`, audit export, chained goals and task dependencies.
- **Phase 3:** broader organizational rollout, advanced policy models, deeper lifecycle coverage, additional backends, enterprise deployment and scale.

## 8. Where the canon lives

- Requirements: [prd.md](prd.md). Its last amendment is dated 2026-09-01; what has been decided since is listed in [requirements-status.md §5](requirements-status.md#5-drift-the-prd-does-not-record).
- Binding conventions and numbered rulings: [docs/architecture/decisions.md](../architecture/decisions.md).
- The design: the shipped app itself, with `app/app.css`'s `:root` as the one token source. The original architecture and UX specifications and the HTML mock the UI was ported from are in git history (ruling 3).

When the app and a document disagree and the app is right, the document is corrected.
Read a requirement's amendment notes before treating its head sentence as an instruction.
