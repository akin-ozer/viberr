# Application and implementation map

## System flow

`entry.server.tsx` boots environment/directories, seeded assets, SQLite, projections, built-in deployments, the file watcher, run recovery, and schedules. Canonical Markdown flows through tolerant parsers and guarded writers into SQLite projections. React Router loaders/actions serve the UI; compact SSE events trigger revalidation and run-log tail reads.

### Durable and runtime storage

| Path or store | Responsibility |
|---|---|
| `projects/<slug>/project.md` | Project identity, repository, workflow, members, operator/profile deployments, capability policy, credentials references, archive state. |
| `projects/<slug>/tasks/<key>/task.md` | Goal, stage, readiness, waiting, ownership, engagements, packets, recommendations, schedules, validation, branch/PR projection, timeline. |
| `projects/<slug>/tasks/<key>/workspace/<repo>` | Reused task Git workspace. Current delivering and supporting runs share it. |
| `agents/profiles/<id>.md` | Global generic agent profile definitions. |
| `agents/definitions/*.md` | Legacy built-in persona override source still active; conflicts with the uniform-profile target. |
| `skills/<name>/SKILL.md` | Declared skill text injected into agent persona. |
| `kb/<dir>/` | Declared recursive knowledge material. |
| SQLite | Projections, Better Auth-related app state, notifications, audit, encrypted credential records, agent runs and log lines. |
| Provider config/session roots | Claude/Codex authentication and resumable transcripts. Current same-user agents can reach these paths. |

### Development-server boundary

The default `VIBERR_DATA_ROOT=./data` sits beneath the Vite application root. Viberr's projection watcher prunes task `workspace/` subtrees, but Vite has no corresponding ignore. Pass-10 workspace clones therefore triggered HMR reloads across nested repository files and a nested-`tsconfig` cache reset. Development runtime data should live outside the source root, with an explicit resolved-data-root Vite exclusion as defense in depth.

## Route map

| Surface | Route | Principal behavior |
|---|---|---|
| Login | `/login` | Local email/password and optional OAuth. “Forgot password?” only tells the user to ask an administrator; there is no self-service reset flow. |
| Home | `/` | Member-project cards, active run/decision counters, organization and personal settings entry. |
| Project board | `/projects/:slug/board` | Board/list views, filters/search, drag transitions, re-scan, task creation. |
| Review queue | `/projects/:slug/review` | Human decision cards. Browser and query implementation both confirm the current grouping includes blocked/failing/PR-less items under acceptance. |
| Agents | `/projects/:slug/agents` | Operator and generic profile cards, profile create/edit, capability matrix, live runs. |
| Policy | `/projects/:slug/policy` | Human RBAC matrix, member role editing, agent grant summary, workflow boundaries. |
| GitHub | `/projects/:slug/github` | Repository credential/status, scope display, linked PRs, manual reconcile. |
| Activity | `/projects/:slug/activity` | Timeline and audit event stream. Current run reports are rendered at excessive length. |
| Settings | `/projects/:slug/settings` | Identity, workflow stages, members, repository, archive/delete. |
| Task | `/projects/:slug/tasks/:key` | Goal/state, ownership, packets, recommendations, validation, GitHub, execution profile, live logs, comments, timeline. |
| Organization | `/org/settings` | GitHub connections; user/access tab; KB, MCP, skills, and global profile resource tab. |
| Profile | `/profile` | Membership, preferences, GitHub identity, password/security. |
| Notifications | `/notifications` | Unread/read decisions and events with links and bulk/read controls. |
| Health | `/resources/health` | Public projection, watcher, and backend-adapter detection summary. `real` means configured/detected, not provider-credential validation. |
| Model catalog | `/resources/model-catalog` | Authenticated backend model choices with curated fallback. |
| Events | `/resources/events` | SSE replay/resync and topic subscription. Membership behavior conflicts with app-wide read intent. |
| Run log | `/resources/run-log` | Authenticated raw/tail log by run ID; no project membership check. |
| Session export | `/resources/session-export` | Authenticated full provider transcript/resume bundle by run ID; no project membership check. |

## Task lifecycle

1. A contributor creates a task with title, starting stage, and optional goal.
2. The operator may run automatically, assess goal quality, propose/ask, transition, and select engagements.
3. At most one delivering engagement owns branch and PR delivery; supporting engagements may research/review/test.
4. Runs resolve the latest profile, backend/model/effort, capabilities, stage eligibility, declared skills/KB/MCP, and the task workspace.
5. Deliverer completion can transition toward Review. For a non-default task branch, Review entry best-effort stages the whole dirty workspace, commits if needed, pushes the branch, and opens/reuses a PR. Whole-tree staging remains a scope/authority risk even though it is conditional on the delivery path.
6. Verdict-capable supporting agents report approval/request changes. Current compatibility defaults and UI persistence do not agree on who has verdict authority.
7. Human acceptance invokes the acceptance path and attempts a real merge. A failed merge may leave Done + accepted + merge pending.
8. Manual reconciliation discovers out-of-band merge/close changes and records divergence without moving workflow automatically.

## Agent backend parity

| Concern | Claude | Codex | Current implication |
|---|---|---|---|
| Transport | Claude Agent SDK with native tools | Codex SDK with structured outcome | Governed outcomes should converge. |
| Autonomy | `bypassPermissions` | `danger-full-access` for specialists | Both are currently unsafe as isolation boundaries. |
| Environment | Full server environment plus overrides | Secret-filtered spawn environment | Critical secret exposure asymmetry. |
| Collaboration | In-process tools for comments/questions/outcomes | Structured final envelope | Mid-run behavior is not identical. |
| External MCP | Profile MCP definitions plus decrypted credentials | Declared portable HTTP/stdio MCP definitions are mounted; credential headers/environment are stripped | Credentialed MCP parity is intentionally absent and must be shown before a Codex run. |
| Skills | Exact declared skill text is injected; bundled Skill tool denied | Exact declared text in prompt | Isolation must be tested from run evidence, not just UI. |
| Capability enforcement | Partial Claude tool denylist | Denylist ignored by Codex | Capability matrix overclaims enforcement. |
| Workspace | Shared per-task workspace | Shared per-task workspace | Supporting/delivering concurrency can race and mix changes. |

## Operator and concurrency

The operator uses governed actions and should route using profile semantics rather than profile names. Its lease and pending-trigger queue are process-local. Delivering single-flight checks the database before expensive asynchronous setup and inserts the run later; without a unique database invariant, simultaneous starts can race. Supporting runs are allowed concurrently but use the same task workspace and the UI disables all run buttons whenever any run is active.

PXL-1 showed a separate prompt-contract fault: the operator correctly chose the semantic documentation profile, then twice claimed the specialist owned push/PR delivery. The specialist's structural prompt correctly said Viberr owns delivery on Review entry and escalated the contradiction. Operator prompts and specialist prompts currently derive delivery authority from different sources.

## GitHub delivery

- Repository credentials are encrypted at rest and decrypted server-side.
- Task workspaces are cloned/reused locally.
- Delivering agent commit identity is profile-attributed (`<profileId>@viberr.local`).
- On the non-default task-branch delivery path, Review entry stages the entire dirty tree, commits if needed, pushes, and opens/reuses a PR.
- Manual reconcile updates cached state and divergence notifications.
- Acceptance attempts a REST merge; merge failure does not necessarily undo accepted/Done.

The live pass-10 project targets only `akin-ozer/viberr`. Canonical records say PR #76 added one inert audit Markdown fixture and PR #77 deleted exactly that file; both were human-accepted and are shown merged, and the audited checkout does not contain/track the fixture. The remote commit objects were unavailable for independent local diff reconstruction. Viberr left the remote `pxl-1` and `pxl-2` branches behind.

## Known implementation boundary

Current task workspaces are a Git convention, not a security sandbox. Claude and Codex specialist processes can reach broader same-user paths. Treat capability, resource, and cross-project isolation claims as unverified/false until process/container isolation exists.

Active-run elapsed time is also not SSR-stable: the initial `Date.now()` is evaluated independently on server and client, so crossing a second boundary can produce a React hydration mismatch before the client timer starts.
