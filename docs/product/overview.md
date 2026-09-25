# Product overview

> What Viberr is, who it is for, what it promises, and where it stands. Distilled
> from the canonical PRD and checked against the code. Requirement-by-requirement
> status is in [requirements-status.md](requirements-status.md).
> Source of truth: `planning/planning-artifacts/prd.md`, [decisions.md](../architecture/decisions.md), `app/`.
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
explicit acceptance. Above the per-task operators sits one instance-wide
**controller**: a conversational agent every signed-in user can address, from its
own page or from a dock on every page, which acts strictly within that user's own
permissions and can define **chained goals** the server carries forward. Every agent
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

1. **Files are truth.** Projects, tasks and goals are markdown under a data root that humans and agents may edit directly. SQLite holds projections for fast reads plus app-management data (users, sessions, secrets, audit, notifications, run history).
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
- One GitHub repository per project (bootstrapped when empty); task-key branches; server-side delivery and PR opening; reconciliation every 5 minutes; PR adoption and branch-collision safety; base refreshes that keep the reviewed revision; branch cleanup; human approval on the PR counting as a verdict.
- Board, review queue (with collision chips between open PRs), task detail (packet, execution profile, live run strip with its console, timeline), agents, policy, GitHub, activity, settings, org settings (connections, users, SSO, resources, controller, audit), notifications, profile, ⌘K palette, insights.
- The instance controller with a governed toolkit, a built-in read-only diagnostics MCP, and a dock on every signed-in page; chained goals.
- Operations: single-writer lock, self-healing projection DB, boot recovery of stranded work, retention and disk-pressure maintenance, backup/restore, key rotation, audit export (download, S3, and export-before-purge).

## 6. Deliberate boundaries and known gaps

- **No mailer.** Notifications are in-app only; admins hand over one-time passwords shown at creation. An open tab still says when a decision waits (ruling 481(c)): its title carries the count of unread decisions, and a browser the person opted in on Profile shows a system notification for a new one while no Viberr tab is in front of them. Nothing leaves the browser: no push service, no service worker, no outbound webhook.
- **No shared agent credential.** A task with no owner runs no agents, and a person who has not connected a backend cannot be billed for one (ruling 127).
- **Codex runs are not OS-sandboxed.** Every Codex run is `danger-full-access`; Viberr's own boundaries are the boundary, so capabilities the Codex runtime cannot enforce (repo write among them) are advisory there and labelled so (ruling 185).
- **Chromium only.** The declared browser matrix is Chromium; Safari and Firefox were struck on 2026-08-31 because nothing exercised them (ruling 103).
- **Desktop-first, one surface reflowed.** Narrow viewports get the same interface with columns collapsed; nothing is hidden by width.
- **Audit retention is 90 days**, exported to JSONL before purge; an org-admin download exists (100k-row cap) and an optional S3 target. Org-scoped rows have no file counterpart past the export.
- **`provenance` has no retention** and grows unboundedly; prune by hand.
- **Notifications page caps at the newest 200 rows**; the table keeps 500 per user.
- **Plain HTTP.** TLS termination is the deployment's job; set `BETTER_AUTH_URL` behind the proxy.
- **Fine-grained PAT validation is partly probe-based**; some scopes read "unproven" until first use.
- **MCP grants sit outside the capability matrix.** Granting a server authorizes its tools (ruling 39), except the ones an admin marks as write tools, which a run that withholds repo write does not get (ruling 176). Viberr makes no claim about unmarked tools.
- **The spending cap binds Claude only.** Codex has no budget option (ruling 175).
- **Single node.** SQLite plus local file authority plus an in-process SSE bus; one instance per data root.
- **Pre-production.** Migrations are squashed into one baseline; schema changes reach fresh databases only; there is no backwards compatibility promise for file formats (owner rulings 98 and 99 were explicitly no-back-compat).

Held spec-vs-app gaps that stay noted rather than silently closed (ruling 80): the
decision packet's impact/confidence/severity fields, the Continuity Recovery Panel's
escalated and paused states plus the execution-truth-strip continuity fact, and
skeleton loaders.

## 7. Phases

- **Phase 1 (V1, shipping):** everything in §5.
- **Phase 2 (post-MVP):** richer profile templates, analytics on throughput and governance load, deeper validation workflows, collaboration ergonomics, task-graph and subtask orchestration, better reporting, refined runtime recovery tooling. Parts have landed early: `/insights`, audit export, chained goals and task dependencies.
- **Phase 3:** broader organizational rollout, advanced policy models, deeper lifecycle coverage, additional backends, enterprise deployment and scale.

## 8. Where the canon lives

- Requirements: `planning/planning-artifacts/prd.md` (byte-identical mirror at `design/prd.md`, pinned by `app/shared/docs/prd-sync.test.ts`). Its last amendment is dated 2026-09-01; what has been decided since is listed in [requirements-status.md §5](requirements-status.md#5-drift-the-prd-does-not-record).
- Architecture decision document: `planning/planning-artifacts/architecture.md`.
- UX specification: `planning/planning-artifacts/ux-design-specification.md`.
- Binding conventions and numbered rulings: [docs/architecture/decisions.md](../architecture/decisions.md).
- The design mock that the UI was ported from: `design/html-app/` (prototype only; the app's `:root` tokens in `app/app.css` are the token source, not the mock).

When the app and a document disagree and the app is right, the document is corrected.
Read a requirement's amendment notes before treating its head sentence as an instruction.
