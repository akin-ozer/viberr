# The controller dock: the controller available everywhere, with the context of where it is

> Discovery pass, 2026-09-02. Owner ask: "make controller available as a helper hover icon
> across the app, controller gets context wherever it is, if it's in a specific board it
> does the work on that board, if it's in tasks it gathers the task.md into context and
> does the work." Design lenses applied: Emil Kowalski's design-engineering rules,
> Apple's fluid-interface principles, and the animation-opportunity gate (frequency,
> purpose, speed, function). Everything below was verified against `main` @ `793b14c2`
> and the running app on `:5174` (hermetic data root) on 2026-09-02.

## 0. What exists today (verified live)

| Surface | Today |
|---|---|
| `/controller` | Instance-scoped conversation page. Entry: Home hero button, Org settings → Controller tab. |
| `/projects/:slug/controller` | Board-scoped conversation page plus the Goals panel. Entry: rail item, task hero goal chip. |
| Every other page | No way to reach the controller without leaving the page. |
| Conversation binding | `controller_conversations.project_slug` (null = instance). No task binding exists. |
| Per-turn context | A digest of the last 30 messages. **No product state is gathered**: the model must call `get_project` / `get_task` before it knows anything about where the person is. |
| Tool defaults | `projectSlug` defaults to the bound project (`slugOf`). `taskKey` is always explicit. |
| Task writes the controller can do | comment, move (not into Done), own/assign, run operator/agent. **No goal or metadata edit** (the task page has both). |

Screenshots of the live surfaces are in `screenshots/` (Home, Board, Task, Review queue,
Controller page, Controller settings tab).

## 1. The product decision

**One floating "Controller" button, bottom-right, on every signed-in surface.** It opens a
docked, non-modal conversation panel bound to the place the person is standing:

| Where the person is | Scope | The conversation is bound to | What the server gathers per turn |
|---|---|---|---|
| `/`, `/notifications`, `/profile`, `/insights`, `/org/settings` | **instance** | nothing (`project_slug` null, `task_key` null) | the person's visible projects (as `whoami` reports them) |
| `/projects/:slug/{board,review,agents,policy,github,activity,settings}` | **board** | the project (`project_slug`, `task_key` null) | a bounded board snapshot: stages with counts, members, the open task table, goal chains |
| `/projects/:slug/tasks/:key` | **task** | the project **and the task** (`project_slug`, `task_key`) | **the task's canonical `task.md`, verbatim and bounded**, plus a derived header (stage, next stages, owner, engaged agents, PR, open packet) |
| `/controller`, `/projects/:slug/controller`, `/login` | hidden | — | the page is the controller; a second composer for the same thing is noise |

Three principles, stated once so every detail below can be checked against them:

1. **Same controller, same authority.** The dock is another entry into ruling 99's
   machinery: one conversation store, one run engine, one toolkit, one guard set. Nothing
   in the dock widens or narrows what the person may do. A task-bound conversation is a
   conversation whose tools default to that task, not a new kind of agent.
2. **Context is a server read, disclosed.** "The controller gets context" means the
   server gathers it at the start of every turn and labels it as a read taken at that
   instant. The dock shows one quiet line naming what the controller knows, so the person
   is never surprised by what it saw. The doctrine's rule that facts come from a read in
   the same turn holds by construction.
3. **The page stays usable.** The panel is non-modal (no scrim, no focus trap, no body
   scroll lock). The person reads the board or the task while the controller works.
   That is the whole reason to have a dock instead of a page.

## 2. The dock, as designed

### 2.1 The trigger

- A 44 px circular button, `position: fixed`, 20 px from the bottom-right corner
  (safe-area aware: `bottom: max(20px, env(safe-area-inset-bottom))`).
- Icon: the controller's own `cpu` glyph on the agent tint (`--agent-soft` /
  `--agent-dark`), the same identity the Controller page header and the rail item use, so
  the same thing looks the same everywhere (Apple: familiarity).
- Accessible name: `Controller · <scope label>` (e.g. `Controller · VIB-1 · viberr`);
  `aria-haspopup="dialog"`, `aria-expanded`.
- A **working dot** (`.live-dot`, the app's existing pulse) sits on the button while a turn
  is in flight in the dock's current conversation. State indication, nothing else.
- Press feedback on pointer-down: `transform: scale(.94)` over `.1s var(--ease-out)`
  (`.icon-btn`'s own values). Hover, pointer-fine only: `--shadow-lift` and a 1 px rise.
- The trigger is never covered by a toast: the toast stack stays where it is (bottom
  centre) and the button lives in the corner. Verified against `.toast` geometry in
  app.css during implementation.

### 2.2 The panel

- 400 px wide, `min(640px, 100dvh - 96px)` tall, docked above the trigger. Surface
  `--surface`, border `--border`, radius `--radius-panel`, shadow `--shadow-pop`. The
  panel is a `<section role="dialog" aria-modal="false" aria-label="Controller dock"
  data-screen-label="Controller dock" tabIndex={-1}>`.
- **Header**: `cpu` icon · `Controller` · a scope pill (`Instance` / `viberr` /
  `VIB-1 · viberr`) · **Threads** (count) · **New** · **Open page** (`ext` icon, links to
  the full surface with `?c=<id>`) · **Close** (`x`).
- **Context line** (one line, `fine xs dim`): what the controller knows here. Copy per
  scope:
  - instance: `Knows your projects and org role · acts with your permissions`
  - board: `Knows the <name> board: stages, members, open tasks, goal chains · acts with your permissions`
  - task: `Knows the <KEY> task file and its place in the <name> workflow · acts with your permissions`
    *(Corrected 2026-09-03: it used to promise board knowledge the task read does not
    gather — the task scope reads the file and a derived header, not a board snapshot.)*
- **Body**: the transcript (markdown replies through the shared `Markdown` component;
  user messages right-aligned on `--tint-well`, controller messages on `--surface` with the
  agent border, exactly the page's vocabulary), the `… is working` status row, and at the
  bottom the composer (textarea, ⌘↵ / Ctrl↵ sends, Send button). The composer takes focus
  when the panel opens: opening the dock means wanting to type.
- **Threads view**: a toggle in the header swaps the transcript for the list of this
  context's conversations (title, last message time). Selecting one returns to the
  transcript. `New` starts a fresh conversation in this context.
- **Escape** closes the panel and returns focus to the trigger. A press outside does
  **not** close it (the bell and account menu already hold that rule, and a helper you
  are working beside must survive a click on the page).
- **Refusals and errors** surface where they already do: refusals are written into the
  transcript by the run engine; transport failures (expired session, stale CSRF token)
  come back as `{ ok: false, error }` and show as an error toast, never as the root error
  page.

### 2.3 Continuity

- The dock reopens **the most recent conversation of the current context** (recommended;
  owner question Q2). Threads are per context: moving from a task to its board swaps the
  panel to the board's threads; coming back to the task returns to the thread you were in
  (the dock remembers the selected conversation per context for the life of the tab).
- The open/closed state and the per-context selection survive a reload
  (`sessionStorage`, wrapped in try/catch, absent in SSR). A page reload must not close a
  helper you were mid-sentence with.
- Navigating while a turn is working keeps the turn: it is a server run; the dock only
  changes what it looks at. The working dot follows the conversation the dock is showing.

### 2.4 Live updates

- The dock's data is a root-owned `fetcher.load` of `/resources/controller`. React
  Router re-runs root-owned fetcher loads on every revalidation (verified in
  `router.js` `getMatchesToLoad`: `isRevalidationRequired` is set by `revalidate()`), so on
  every surface that already holds an SSE stream with the `user` scope (Home, the
  workspace, Notifications, Org settings) the owner-routed `controller.updated` event
  refreshes the dock for free.
- While the panel is **open** the dock also mounts its own `useLiveUpdates([user])` (a
  child component, so the hook is not conditional) for the surfaces without a stream
  (Profile, Insights). Closed = zero listeners, the `useDismiss` philosophy.
- While a turn is working the dock polls every 5 s exactly as the page does (a paused
  stream must not read as a hang).

### 2.5 Small screens (≤ 720 px, the rail's own breakpoint)

- The panel becomes a **bottom sheet**: full width, `min(80dvh, 640px)` tall, top
  corners `--radius-card`, entering and leaving along the same edge
  (`translateY(100%)` ↔ `0`). *(Corrected 2026-09-03: this said the trigger hides while
  the sheet is open. It does not, and must not — R19-12 forbids removing a control under
  a width query. It rides above the sheet, smaller, as a second close, and travels on the
  sheet's own clock rather than jumping there a beat early.)* Nothing scrolls sideways.

### 2.6 Motion (the gate applied; the full report is in `ANIMATION-OPPORTUNITIES.md`)

| Moment | Frequency | Purpose | Spec |
|---|---|---|---|
| Trigger press | tens/day | feedback | `:active { transform: scale(.94) }`, `transition: transform .1s var(--ease-out)` |
| Panel open (pointer) | occasional | spatial consistency: grows from its trigger | `transform-origin: bottom right`; from `opacity: 0; transform: translateY(8px) scale(.97)` to settled, `.18s var(--ease-out)` |
| Panel close (pointer) | occasional | same path back, faster | `[data-closing]`: to `opacity: 0; translateY(6px) scale(.98)`, `transition .12s var(--ease-out)`; unmount on `transitionend` (the `useDialog` close recipe) |
| Panel close (Escape) | keyboard | none | instant, no transition |
| New reply arrives while open | occasional | prevents a teleporting block of text | `.dock-msg` mount: from `opacity: 0; translateY(4px)`, `.2s var(--ease-out)`; only nodes mounted after the panel settled animate |
| Working state | continuous | state indication | the existing `.live-dot` pulse; held still under reduced motion |
| Mobile sheet | occasional | spatial consistency | `translateY(100%)` ↔ `0`, `.22s var(--ease-out)`, exit same edge |
| Reduced motion (`prefers-reduced-motion` and the in-app `[data-motion="reduce"]`) | | | opacity-only fades at `.12s ease`; no transforms; the working dot is static |

Rejected: a stagger on the transcript when the panel opens (information the person is
reading); smooth scrolling to the newest message (functional, instant); any hover effect
on messages; a shimmer on the working row; a keyboard shortcut (none is added, so no
keyboard-initiated open exists to keep unanimated).

## 3. The server contract

### 3.1 Conversation scope

`controller_conversations` gains `task_key TEXT` with
`CHECK (task_key IS NULL OR project_slug IS NOT NULL)`. Pre-prod: the baseline is edited,
no migration. A conversation is one of three shapes: instance (`NULL, NULL`), board
(`slug, NULL`), task (`slug, key`). The row is immutable in scope: a conversation never
changes what it is bound to.

`controller_messages` gains `surface TEXT` (owner question Q4): the pathname and query the
person was looking at when they sent a user message (`/projects/viberr/board?filter=waiting`).
Null on controller rows and on messages sent from the full pages before this change. The
full Controller page renders it as a small chip on the user message (`from Board`), so a
transcript read back later still says where the ask came from.

`createConversation` takes `taskKey` and refuses a task binding with no project.
*(Corrected 2026-09-03: this said the store verifies the task exists. It does not —
existence is checked by the resource route, the only caller that can answer for it.)* `listConversations` filters on `taskKey`
(`undefined` = any binding, `null` = board-only, a key = that task). The project Controller
page lists board **and** task threads with a task chip; `?c=` opens either.

### 3.2 The per-turn context read

`runControllerTurn` gains `surface?: string`. `startTurnRun` calls
`gatherControllerContext(db, conversation, user, dataRoot)` (new module
`controller-context.server.ts`) and prepends its text to the turn prompt as:

```
Context gathered by the server when this turn started (a read as of <ISO>; the store is
the truth for anything that changed since, and every action still runs through a tool):

## Task VIB-1 (project viberr)
stage: Review (3 of 5) · readiness: ready · waiting: human · owner: Arda Kaya
next stages: Done (human) · engaged: developer/claude (delivering) · PR #232 review
open packet: none

### task.md
```markdown
---
key: VIB-1
…
```
[12 older timeline entries omitted; get_task reads more]
```

Rules:

- **Task scope**: the derived header comes from `getTaskSummary` and the project file
  (stage name by id, next stages from the workflow graph, the terminal stage marked
  human). The body is the file `readTaskFile(...).content` **verbatim**, bounded by
  `TASK_FILE_CONTEXT_CHARS = 24_000` (the same figure as the skill and KB budgets). Over
  budget, the head (frontmatter, `## Goal`, `## Packet`) stays whole and the `## Timeline`
  keeps as many **newest** entries as fit (entries are newest-first in the file, so this
  is a prefix cut on `\n### ` boundaries), closed by a marker line naming how many were
  omitted. A head that alone exceeds the budget is clipped with the same marker. The file
  is fenced so its own `## ` headings cannot read as prompt structure.
- **Board scope**: project name, slug, archived flag, description (first 600 chars),
  stages with live counts, members with roles, the open-task table newest-updated first
  (key · title · stage · readiness · waiting · owner · priority) capped at
  `BOARD_CONTEXT_TASKS = 40` rows and `BOARD_CONTEXT_CHARS = 12_000`, and goal chains
  (id · title · status · current link). Archived tasks are excluded and counted, never
  listed. *(Corrected 2026-09-03: this promised a fallback to archived rows on a board
  with no open tasks. It was never implemented, and ruling 121(b) and the domain page
  both say "open-task table" with no fallback — the design sentence was the outlier, so
  it is withdrawn rather than built.)* Members and goal chains are capped at 20 each,
  each with a marker naming what was left out.
- **Instance scope**: the same projects list `whoami` reports (slug · name · role ·
  archived), capped at 40, plus the org role. Small on purpose.
- **Surface hint**: when the turn carries a `surface`, one line: `They are looking at:
  /projects/viberr/board?filter=waiting`. The model reads the query string itself.
- The block is always under `CONTEXT_BLOCK_CHARS = 32_000` in total; the transcript
  digest that follows keeps its own 24 000 budget.

### 3.3 The system prompt

The "This conversation" block gains the task binding:

> This conversation is anchored to task `VIB-1` in project `viberr`: tools default to
> both, and every turn opens with the task's canonical file as a server read.

The doctrine (`controller.definition.md`) and the skill (`controller-guide.skill.md`) gain
one paragraph each on the context read (treat it as this turn's read; act through tools;
say when the read is older than an action you just took), and lose the two recorded
drifts: `list_projects` (it does not exist; visible projects come from `whoami`) and "a
comment mention can start a run" (`comment_on_task` only notifies humans). Both shipped
files are hash-upgraded at boot through `PRIOR_SHIPPED_HASHES`, so an existing store
picks the new text up on restart without a re-seed.

### 3.4 The toolkit

- `buildControllerToolkit` takes `taskKey`; a `keyOf(given?)` helper mirrors `slugOf`
  and every task tool's `taskKey` becomes optional with "defaults to this conversation's
  task" in its description: `get_task`, `move_task`, `comment_on_task`, `set_task_owner`,
  `run_agent_on_task`, and the new `update_task`.
- `whoami` reports `conversationTask`.
- **New tool `update_task`** (owner question Q3; recommended): `goal` (→ `updateTaskGoal`,
  gated `update-goal`), `priority` / `labels` / `dueDate` (→ `setTaskMetadata`, its own
  gate). Full-replace semantics for metadata exactly as the task page's editor submits
  them; a bad value throws before any write. Parity with the task page, nothing more; no
  title edit because no title writer exists.
- `CONTROLLER_TOOLKIT_INSTRUCTIONS` names the defaults.

### 3.5 The resource route `/resources/controller`

`routes/resources.controller.ts`, a fetcher target with no UI (the `notifications/read`
family):

- `GET ?project=&task=&c=` → `{ view: ControllerDockView }`. Guards: `requireAuth`; a
  project scope passes `requireVisibleProject` (the byte-identical members-only 404); a
  task scope additionally requires the task to exist (`No task <key> in
  projects/<slug>.`, the task route's own 404 copy). `c` is validated by
  `canAccessConversation` and must match the requested scope, else 404.
- `POST` intent `send` (`text`, `conversationId?`, `project?`, `task?`, `surface?`) →
  creates the conversation when absent (scope re-proven), runs the turn, answers
  `{ ok: true, conversationId }`. CSRF failures answer `{ ok: false, error }` through
  `csrfError` (the fetcher renders a toast, not the root boundary). Every `AppError` maps
  through `appErrorResponse`.
- The view is compact: `available`, `controllerName`, `scope { projectSlug, taskKey,
  projectName, label, contextLine }`, `conversation`, `messages`, `turn`, `threads[]`,
  `viewerOwnsActive`. No goals (the full page has them).

### 3.6 Authority and audit (unchanged by design)

Every tool call still resolves the asking user's live authority; the actor label stays
`<email> · via controller`; task-scoped conversations are owned and read exactly like the
others (owner, or a live org admin). The dock adds no audit action: sending is the same
turn the page sends. `controller.updated` and `goal.updated` are unchanged.

## 4. Full-page changes

- `/projects/:slug/controller`: the Conversations list shows task threads with a
  `VIB-1` chip; the header of a task-bound conversation says `VIB-1 · <name>`; the
  composer keeps the binding. The header line uses the project **name** (today it prints
  the slug: "Managing the viberr board").
- Both page actions map CSRF failures to `{ ok: false, error }` (today a stale token
  renders the root error page; the dock must not, and the page should not either).
- User messages carry the `surface` chip when present.
- The composer takes focus on the page too (parity with the dock).

## 5. Documentation to update (same change)

`docs/architecture/decisions.md` (ruling 121, route map), `docs/domain/controller-and-goals.md`
(§2 surfaces, §3 storage and turn, §4 tools, §9 drift), `docs/ui/surfaces.md` (route table,
§2 shell, §4 screen labels), `docs/architecture/data-model.md` (columns),
`docs/architecture/codebase-map.md` (routes, feature files), `docs/product/glossary.md`
(Controller dock, conversation scope), `docs/product/requirements-status.md` (FR40 row),
`docs/README.md` (verification commit). `AGENTS.md` and `README.md` need no change.

## 6. Out of scope, on purpose

- A keyboard shortcut for the dock (no request; a shortcut would need an unanimated open
  path and a palette-style conflict check). Recorded as a question, default no.
- A ⌘K "Ask the controller" row (the docs say the palette deliberately has none).
- Streaming the reply token by token into the dock (the run engine settles a turn as one
  message; the page has the same shape).
- Goals in the dock (the project page owns the chain controls).
