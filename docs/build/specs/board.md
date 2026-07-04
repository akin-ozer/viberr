# Spec: Board view (`design/html-app/app/board.jsx` → `app/features/board/`)

Source of truth: `design/html-app/app/board.jsx` (247 lines), shared primitives in
`design/html-app/app/ui.jsx`, data shapes in `design/html-app/app/data.js`, host wiring in
`design/html-app/app/main.jsx`. CSS contract: `design/html-app/app/viberr.css` (ported verbatim —
**class names are the contract**, do not rename or replace with Tailwind).

---

## 1. Purpose & entry points

The Board is the project's primary work surface: an **agent-aware kanban** with one column per
workflow stage, plus a flat list mode. Cards surface the governance state of each task at a
glance — readiness, who/what it's waiting on, owner vs. agent specialist, branch/PR trace,
urgency. It also hosts the **create-task modal** (mock FR11) and a **manual re-scan** action that
reconciles the UI with the file-native store.

There is **no drag-and-drop**. Stage transitions are governed workflow actions that happen
elsewhere (task detail / review queue), never by dragging cards. Do not add DnD.

### Entry points (mock → real)

| Mock | Real app |
|---|---|
| `main.jsx` renders `<Board tasks={tasks} onOpen={(k)=>setOpenKey(k)} onCreate={createTask} push={push} />` when `view === "board"` and no task is open | Route `/projects/:slug/board` (default redirect target of `/projects/:slug`) |
| Hash `#board` pre-selects the view; `#task/VIB-142` deep-links a task | Real routes: `/projects/:slug/board`, `/projects/:slug/tasks/:key` |
| Rail nav item `board` (shows total task count badge); breadcrumb "Board" | Same shell, ported in Phase 4 |
| Card click → `onOpen(task.key)` → task detail panel replaces board | Card click navigates to `/projects/:slug/tasks/:key` (use `<Link>`/`navigate`; keep `.card` class on the clickable element) |

Board props in the mock:

- `tasks` — merged array (base data + session-created + per-key overrides) from the app root.
- `onOpen(key)` — open task detail.
- `onCreate({ title, goal, stage })` — create a task (logic lives in `main.jsx`, see §5).
- `push(text)` — toast.

---

## 2. Component tree

```
Board                     – top-level view; owns filter/group/creating state
├─ board-head             – h1 "Board", subtitle counts, view toggle, Re-scan, New task
├─ filter-bar             – 4 filter chips (All / Waiting on me / Agent working / Needs attention)
├─ (group === "stage") .board
│   └─ Column ×5          – one per stage; header (dot, name, count, + button) + card list
│       └─ TaskCard ×N    – whole-card <button>; opens task detail
│           ├─ ReadinessPill (ui.jsx)  – colored dot-pill for readiness state
│           ├─ OwnerLine   – specialist (agent glyph) OR owner avatar OR unassigned placeholder
│           ├─ ReviewerStack – small owner avatar stack (only when owner AND specialist)
│           └─ WaitTag     – "agent working" (pulsing dot) / "waiting on you" (hand icon)
├─ (group === "list") ListView – flat rows reusing .card with inline row styles
└─ NewTaskModal (creating != null) – title/stage/goal form; creates canonical task file
```

Shared primitives consumed from `ui.jsx` (port once into `app/ui/`): `Icon`, `Pill`,
`ReadinessPill` (+`READINESS` map), `AgentGlyph`, `Avatar`. (`ValidationPill` exists but is **not**
rendered on the board — validation state only feeds the "Needs attention" filter.)

One-liners:

- **Board** — state: `filter` (`"all"|"human"|"agent"|"risk"`, default `"all"`), `group`
  (`"stage"|"list"`, default `"stage"`), `creating` (stage id string or `null`).
- **Column** — `stage` object + pre-filtered `tasks` for that stage; renders header + body.
- **TaskCard** — a single `<button className="card …">`; no nested interactive elements.
- **WaitTag** — renders only for `waiting === "agent" | "human"`, else `null`.
- **OwnerLine** — precedence: specialist > owner > placeholder.
- **ReviewerStack** — owner avatar shown next to the specialist line; `label` prop adds "owner" text.
- **NewTaskModal** — controlled form, scrim + `.modal-card` dialog.
- **ListView** — same filtered tasks, single flat column of row-cards (ignores stage grouping).

---

## 3. Data consumed

### 3.1 Stages

Mock: `window.VIBERR.stages` (mutable global; Settings can edit it). Shape:

```js
{ id: "triage",  name: "Triage",       color: "#a5a8b5" }
{ id: "ready",   name: "Ready",        color: "#187574" }
{ id: "impl",    name: "In Progress",  color: "#7b61ff" }
{ id: "review",  name: "Review",       color: "#5b76fe" }
{ id: "done",    name: "Done",         color: "#00b473" }
```

Real app: from the project projection (project.md → SQLite), returned by the board loader.
`color` is **data applied as an inline style** (`style={{ background: stage.color }}` on
`.col-stage-dot` and the selected stage chip's `.sdot`) — keep it that way; these hexes live in
data, not CSS, so they are not a palette violation.

Column order = array order. The `done` column never shows a per-column "+" button, and the modal's
stage picker excludes `done` (`stages.filter((s) => s.id !== "done")`).

### 3.2 Tasks

Fields read by the board (exact mock shapes; see `data.js` TASKS for full examples):

| Field | Type / values | Used for |
|---|---|---|
| `key` | `"VIB-142"` | card key label, `onOpen`, React key |
| `title` | string | card `<h3>` |
| `stage` | stage id | column placement, list-view stage pill |
| `readiness` | `"ready" \| "input" \| "risk" \| "blocked" \| "done"` | ReadinessPill, risk filter |
| `waiting` | `"human" \| "agent" \| "none"` | WaitTag, `wait-human` card class, filters, header count |
| `urgent` | boolean | `urgent` card class, risk filter |
| `validation` | `"healthy" \| "changed" \| "failing" \| "none"` | risk filter only (no pill on board) |
| `specialist` | `null` or `{ kind:"agent", backend:"codex"\|"claude", name:"Codex"\|"Claude Code", role:"Developer"\|… }` | OwnerLine agent variant, ReviewerStack gate |
| `owner` | `null` or `{ kind:"human", name, initials, tone:""\|"rose"\|"teal"\|"violet" }` | OwnerLine human variant, ReviewerStack |
| `operator` | `null` or `{ name:"Operator", since:"stage 1" }` | only truthiness: unassigned placeholder says "awaiting owner" vs "unassigned" |
| `branch` | `null` or `"vib-142-attach-workspace"` | branch trace chip (truncated) |
| `pr` | `null` or `{ number: 318, state: "review"\|"merged", title }` | PR trace chip `#318` |

Readiness mapping to the real app (per CONVENTIONS.md the canonical values are
`ready | input_required | inconsistency_risk_detected | blocked`):

| Mock value | Real readiness value | Pill kind (CSS) | Pill label (user-visible, keep verbatim) |
|---|---|---|---|
| `ready` | `ready` | `pill ready` | `ready` |
| `input` | `input_required` | `pill input` | `input required` |
| `risk` | `inconsistency_risk_detected` | `pill risk` | `inconsistency risk` |
| `blocked` | `blocked` | `pill blocked` | `blocked` |
| `done` | (see Open questions — mock-only 5th value on done-stage tasks) | `pill done` | `accepted` |

Unknown readiness falls back to the `ready` pill in the mock (`READINESS[value] || READINESS.ready`)
— keep tolerant fallback, but real code should map real→mock-pill-kind in one place
(`app/features/board/` or `app/shared/mapping/`).

Real source: board loader queries **task projections from SQLite** (`task_projections` per Phase 3)
scoped to the project — never parses task.md at request time. Session (user identity) comes from
the auth middleware; it is needed later if "Waiting on me" becomes per-user (see Open questions).

### 3.3 Derived values

- `waitingHuman = tasks.filter(t => t.waiting === "human").length` — used in the header subtitle
  and the "Waiting on me" chip badge.
- Filter predicate (verbatim semantics):

```js
if (filter === "human") return t.waiting === "human";
if (filter === "agent") return t.waiting === "agent";
if (filter === "risk")  return t.readiness === "risk" || t.readiness === "blocked"
                            || t.validation === "failing" || t.urgent;
return true; // "all"
```

- Column counts (`.ct`) reflect the **filtered** set per column; the header subtitle counts the
  **unfiltered** total. Intentional — keep.
- `shortBranch(b) = b.length > 16 ? b.slice(0, 15) + "…" : b`.

---

## 4. UI states & interactions

### 4.1 Board header (`.board-head`)

- `<h1>Board</h1>`; subtitle `.sub`: **`{tasks.length} tasks · {waitingHuman} waiting on a human decision`**.
- View toggle `.seg` — two buttons, active one gets class `on`:
  - `<Icon name="board" />Board` → `group = "stage"`
  - `<Icon name="review" />List` → `group = "list"`
- **Re-scan** — `<button className="btn ghost sm" title="Reconcile the board with the file-native store"><Icon name="refresh" />Re-scan</button>`.
  Mock behavior (fake): toast `Re-scanning the .viberr store…`, then after 1000 ms toast
  `Re-scan complete — board matches the file-native store`. Real: POST action invoking the Phase-3
  manual rescan (reconcile file store → projections), revalidate on completion; keep both toast
  strings but the completion toast must fire on real completion, not a timer (see Porting notes on
  the ".viberr store" wording).
- **New task** — `<button className="btn primary sm"><Icon name="plus" />New task</button>` →
  opens modal with `initialStage = "triage"`.

### 4.2 Filter bar (`.filter-bar`)

Four chips, active chip gets `on`:

```js
const FILTERS = [
  { id: "all",   label: "All tasks",       icon: "board" },
  { id: "human", label: "Waiting on me",   icon: "hand"  },
  { id: "agent", label: "Agent working",   icon: "cpu"   },
  { id: "risk",  label: "Needs attention", icon: "alert" },
];
```

The `human` chip appends a count when nonzero:
`{f.id === "human" && waitingHuman > 0 && <span style={{ opacity: .7 }}>· {waitingHuman}</span>}`.
Chips are plain buttons; the mock sets no `aria-pressed` — adding it is a permitted a11y upgrade.

**Search:** the Board itself has no search input. The topbar search
(placeholder `Search tasks, branches, agents…`, `⌘K` kbd hint) lives in the shell (`main.jsx`) and
is a **non-functional stub** in the mock. Phase-4 plan says "search stub→real filter" — that's a
shell concern, not this file's.

### 4.3 Columns (`Column`)

Verbatim structure:

```jsx
<section className="column">
  <header className="col-head">
    <span className="col-stage-dot" style={{ background: stage.color }} />
    <span className="nm">{stage.name}</span>
    <span className="ct">{tasks.length}</span>
    {stage.id !== "done" && <button className="add" title="New task in this stage" onClick={onNew}><Icon name="plus" /></button>}
  </header>
  <div className="col-body">
    {tasks.length === 0
      ? <div className="empty">No tasks</div>
      : tasks.map((t) => <TaskCard key={t.key} task={t} onOpen={onOpen} />)}
  </div>
</section>
```

- The `+` button opens the modal preset to that column's stage (`setCreating(s.id)`).
- Per-column empty state: `.empty` div with text **`No tasks`** (this is also the whole-filter
  empty state — with an aggressive filter every column just shows "No tasks").
- `.board` is a CSS grid, `grid-auto-flow: column; grid-auto-columns: minmax(218px, 1fr)`,
  horizontal overflow scrolls; `.col-body` scrolls vertically per column.

### 4.4 Task card (`TaskCard`) — verbatim, this is the anatomy contract

```jsx
function TaskCard({ task, onOpen }) {
  const cls = ["card"];
  if (task.waiting === "human") cls.push("wait-human");
  if (task.urgent) cls.push("urgent");
  return (
    <button className={cls.join(" ")} onClick={() => onOpen(task.key)}>
      <div className="card-top">
        <span className="key">{task.key}</span>
        <span className="spacer" />
        <ReadinessPill value={task.readiness} sm />
      </div>
      <h3>{task.title}</h3>
      <div className="owner-row">
        <OwnerLine task={task} />
        <ReviewerStack task={task} />
      </div>
      <div className="card-foot">
        {task.branch
          ? <span className="trace ok"><Icon name="branch" />{shortBranch(task.branch)}</span>
          : <span className="trace"><Icon name="branch" />no branch</span>}
        {task.pr && <span className="trace pr"><Icon name="pr" />#{task.pr.number}</span>}
        <WaitTag task={task} />
      </div>
    </button>
  );
}
```

Chip semantics:

- **Readiness pill** (top right): dot + label, small size. Kinds/labels in §3.2.
- **Branch chip**: always present — `trace ok` (teal, mono) with truncated branch name, or plain
  `trace` with literal text **`no branch`**.
- **PR chip**: `trace pr` (blue), text `#`+number; only when `task.pr` exists.
- **Wait tag** (right-aligned via `margin-left:auto`):

```jsx
function WaitTag({ task }) {
  if (task.waiting === "agent") {
    return <span className="wait-tag agent"><span className="working" />agent working</span>;
  }
  if (task.waiting === "human") {
    return <span className="wait-tag human"><Icon name="hand" />waiting on you</span>;
  }
  return null;
}
```

  `.working` is a pulsing violet dot (`pulse-a` keyframes). Copy is exactly
  **`agent working`** / **`waiting on you`**.

- **Owner/agent line** — precedence specialist > owner > placeholder:

```jsx
function OwnerLine({ task }) {
  const sp = task.specialist;
  if (sp) {
    return (
      <div className="card-owner">
        <AgentGlyph backend={sp.backend} />
        <span className="nm">{sp.name}</span>
        <span className="lbl">· {sp.role}</span>
      </div>
    );
  }
  const o = task.owner;
  if (o) {
    return (
      <div className="card-owner">
        <Avatar person={o} />
        <span className="nm">{o.name.split(" ")[0]}</span>
        <span className="lbl">· owner</span>
      </div>
    );
  }
  return <div className="card-owner"><span className="avatar" style={{ opacity: .5 }}>?</span><span className="lbl">{task.operator ? "awaiting owner" : "unassigned"}</span></div>;
}
```

  Notes: human owner shows **first name only**. Unassigned copy depends on operator presence:
  **`awaiting owner`** (operator exists, needs a human acceptance seat) vs **`unassigned`**
  (pre-triage, no operator). `AgentGlyph` renders `agent-glyph codex` (violet, cpu icon) or
  `agent-glyph claude` (orange, sparkle icon) with `title` "Codex" / "Claude Code".

- **Reviewer stack** — shows the human owner alongside an agent specialist, communicating "agent
  does the work, this human reviews/accepts":

```jsx
function ReviewerStack({ task, label }) {
  const o = task.owner;
  if (!o || !task.specialist) return null;
  return (
    <span className="rev-stack" title={"Owner · human reviewer & acceptance: " + o.name}>
      {label && <span className="rs-lbl">owner</span>}
      <Avatar person={o} />
    </span>
  );
}
```

  On board cards `label` is omitted; the list view passes `label` (renders the small uppercase
  "owner" tag). The `title` tooltip string is user-visible copy — keep verbatim.

Card interaction: the whole card is one `<button>` (focusable, `:focus-visible` outline via CSS).
Enter/Space activate natively. In the real app render it as a link styled with `.card` (or a
button that navigates) — preserve keyboard operability and the class list.

### 4.5 List view (`ListView`)

Rendered when `group === "list"`, same `filtered` array, **flat** (not grouped; original array
order — mock data is not sorted by stage). Verbatim:

```jsx
function ListView({ tasks, onOpen }) {
  const stages = window.VIBERR.stages;
  const stageName = (id) => (stages.find((s) => s.id === id) || {}).name;
  return (
    <div className="board" style={{ gridAutoFlow: "row", gridAutoColumns: "auto", display: "block", padding: "0 1.4rem 1.4rem" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: ".6rem", maxWidth: 920 }}>
        {tasks.map((t) => (
          <button key={t.key} className="card" style={{ flexDirection: "row", alignItems: "center", gap: "1rem" }} onClick={() => onOpen(t.key)}>
            <span className="key" style={{ width: 64 }}>{t.key}</span>
            <h3 style={{ flex: 1 }}>{t.title}</h3>
            <span className="pill neutral sm">{stageName(t.stage)}</span>
            <OwnerLine task={t} />
            <ReviewerStack task={t} label />
            <ReadinessPill value={t.readiness} sm />
            <WaitTag task={t} />
          </button>
        ))}
      </div>
    </div>
  );
}
```

Notes: list rows drop the `wait-human`/`urgent` classes and the branch/PR chips; stage appears as
a neutral pill; inline styles are load-bearing (row layout on top of column-flex `.card`). Port the
inline styles verbatim, or move them to a clearly-appended `.card.row`-style class in `app.css` —
if you add a class, keep `card` in the class list. **The list view has no empty state** (zero
tasks renders an empty container) — see Porting notes.

### 4.6 New task modal (`NewTaskModal`) — verbatim

Opened with `initialStage` = `"triage"` (header button) or the column's stage (column `+`).

```jsx
function NewTaskModal({ initialStage, onClose, onCreate }) {
  const stages = window.VIBERR.stages.filter((s) => s.id !== "done");
  const [title, setTitle] = useStateB("");
  const [goal, setGoal] = useStateB("");
  const [stg, setStg] = useStateB(initialStage || "triage");
  const valid = title.trim().length >= 3;
  const submit = () => {
    if (!valid) return;
    onCreate({ title: title.trim(), goal: goal.trim(), stage: stg });
    onClose();
  };
  return (
    <React.Fragment>
      <div className="confirm-scrim" onClick={onClose} />
      <div className="modal-card" role="dialog" aria-label="New task" style={{ width: "min(560px, calc(100vw - 2rem))" }}>
        <div className="modal-head">
          <span className="agent-glyph lg"><Icon name="plus" /></span>
          <div className="mh-main">
            <h2>New task</h2>
            <div className="mh-sub">Creates a canonical task file in the store — agents anchor on it from the first event.</div>
          </div>
          <button className="icon-btn modal-close" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
        </div>
        <div className="modal-body">
          <div className="field">
            <label className="flabel">Title<span className="req">*</span></label>
            <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Reconcile PR state after force-push" autoFocus
              onKeyDown={(e) => { if (e.key === "Enter") submit(); }} />
          </div>
          <div className="field">
            <label className="flabel">Stage</label>
            <div className="pick-chips">
              {stages.map((s) => (
                <button type="button" key={s.id} className={"pick-chip" + (stg === s.id ? " on" : "")} onClick={() => setStg(s.id)}>
                  <span className="sdot" style={stg === s.id ? { background: s.color } : null} />{s.name}
                </button>
              ))}
            </div>
          </div>
          <div className="field">
            <label className="flabel">Goal<span className="fhint">what done means — the operator and specialists anchor on this</span></label>
            <textarea value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="One or two sentences. Underspecified goals get flagged at the triage quality gate." />
          </div>
        </div>
        <div className="modal-foot">
          <span className={"foot-hint" + (valid ? "" : " err")}>{valid ? "The task key is assigned on create." : "A title is required."}</span>
          <div className="foot-actions">
            <button className="btn ghost" onClick={onClose}>Cancel</button>
            <button className="btn primary" onClick={submit} disabled={!valid} style={!valid ? { opacity: .5, pointerEvents: "none" } : null}><Icon name="plus" />Create task</button>
          </div>
        </div>
      </div>
    </React.Fragment>
  );
}
```

Behavior summary:

- **Validation**: title trimmed length ≥ 3. Invalid → footer hint turns red (`foot-hint err`) with
  **`A title is required.`**; valid → **`The task key is assigned on create.`** Submit button gets
  `disabled` + inline `opacity:.5; pointerEvents:none`.
- **Keyboard**: Enter in the Title input submits; Enter in the Goal textarea inserts a newline
  (no submit). `autoFocus` on Title. **The mock does NOT close on Escape** (unlike `PageOverlay`
  in ui.jsx which does) — per CONVENTIONS ("Escape closes, scrim click closes") add an Escape
  handler in the port; also add `aria-modal="true"` and focus trapping/restoration, which the mock
  lacks.
- **Scrim** (`confirm-scrim`) click closes; Cancel closes; ✕ (`icon-btn modal-close`,
  `aria-label="Close"`) closes.
- Stage chips: selected chip gets `on` and its `.sdot` gets the stage color inline; unselected
  `.sdot` stays gray via CSS. `done` is never offered.
- Goal is optional; empty goal gets the server-side default (§5).
- On submit: `onCreate({title, goal, stage})` then immediately `onClose()` — in the real app,
  submit the action, keep the dialog open on server validation error (show the error in
  `foot-hint err`), close + revalidate on success.

---

## 5. Events / mutations produced

### 5.1 Create task (the only real mutation on this surface)

Mock logic (`main.jsx createTask`) — the contract to reproduce server-side as a route action:

```js
const createTask = ({ title, goal, stage }) => {
  const n = Math.max(...[...base, ...created].map((t) => parseInt(t.key.slice(4), 10))) + 1;
  const key = "VIB-" + n;
  const sName = (window.VIBERR.stages.find((s) => s.id === stage) || {}).name || stage;
  setCreated((c) => [...c, {
    key, title,
    goal: goal || "Goal to be refined at the triage quality gate.",
    stage, readiness: "input",
    specialist: null,
    owner: null,
    operator: stage === "triage" ? null : { name: "Operator", since: "stage 1" },
    consultants: [], waiting: "human", urgent: false, validation: "none",
    branch: null, repo: "akin-ozer/viberr", pr: null, timeline: [],
  }]);
  push(key + " created in " + sName + " — its task.md is in the store");
};
```

Real action (`/projects/:slug/board` action or a dedicated resource route):

1. Auth + RBAC: `member` or `admin` (a `viewer` must not create; the mock never gates this — the
   server must).
2. Validate with Zod: title trimmed ≥ 3 chars; stage must be an existing non-`done` stage id.
3. Allocate the next task key **atomically server-side** (max existing numeric suffix + 1). The
   mock hardcodes a 4-char `"VIB-"` prefix via `key.slice(4)` — derive the prefix from project
   config instead.
4. Write `projects/<slug>/tasks/<KEY>/task.md` via the frontmatter-preserving writer with the
   defaults above: `readiness: input_required`, `waiting: human`, `urgent: false`,
   `validation: none`, no owner/specialist/branch/pr; goal defaults to
   **`Goal to be refined at the triage quality gate.`** when blank; operator assigned unless stage
   is `triage`.
5. Re-parse → re-project → publish SSE `task.updated` (and whatever creation event the event
   vocabulary settles on); write an **audit event** (who/when/project/key). Timeline starts empty
   in the mock — a typed "created" timeline event is a reasonable addition but is a deviation to
   document (see Open questions).
6. Idempotency: retries must not mint two keys/files (idempotency key on the form POST or
   existence check).
7. Success feedback: toast **`{KEY} created in {Stage name} — its task.md is in the store`**;
   board revalidates (new card appears in its column; no optimistic insert — governed state).

### 5.2 Re-scan

Mock: fake (`push("Re-scanning the .viberr store…")` + 1 s `setTimeout` →
`push("Re-scan complete — board matches the file-native store")`). Real: POST to the Phase-3
manual rescan (reconcile files ↔ projections for the project), then revalidate; completion toast
only after the server responds. Governed action → audit event. Keep both toast strings (but see
Open questions re ".viberr store" wording vs. the real `./data` root).

### 5.3 Non-mutations (client-only state)

- Filter chip selection, Board/List toggle, modal open/close — client state. Recommended: mirror
  `filter` and `group` into URL search params (`?filter=human&view=list`) so they survive
  refresh/share; the mock loses them on reload. Deviation — document it.
- Opening a card — pure navigation.

### 5.4 Timeline events referenced (context for the create action)

The board itself writes no timeline events, but the tasks it renders carry typed events produced
elsewhere (`assign`, `comment`, `agent`, `github`, `policy`, `quality`, `transition`, `blocked`,
`completion`). The create action is the board's only touchpoint with that vocabulary.

---

## 6. CSS classes used (structural contract)

All already in `viberr.css` — port verbatim, no new definitions needed for this surface.

- Layout: `board-wrap` (+ `data-screen-label="Board"` attribute), `board-head` (`h1`, `.sub`),
  `board-tools`, `seg` (buttons, `.on`), `filter-bar`, `fchip` / `fchip on`, `board`, `column`,
  `col-head` (`.nm`, `.ct`, `.add`), `col-stage-dot`, `col-body`, `empty`.
- Card: `card`, modifiers `wait-human`, `urgent`; `card-top` (`.key`, `.spacer`), `card h3`,
  `owner-row` *(see Porting notes — no CSS rule exists for it)*, `card-owner` (`.nm`, `.lbl`),
  `rev-stack` (`.rs-lbl`), `card-foot`, `trace` / `trace ok` / `trace pr`, `wait-tag` /
  `wait-tag human` / `wait-tag agent` (`.working`).
- Shared primitives: `pill` (+`ready|input|risk|blocked|done|neutral`, `sm`, `.pdot`),
  `agent-glyph` (+`codex|claude|lg`), `avatar` (+`rose|teal|violet|lg`), `ico`, `btn` (+`primary`,
  `ghost`, `sm`), `icon-btn`.
- Modal: `confirm-scrim`, `modal-card`, `modal-head` (`mh-main`, `mh-sub`, `modal-close`),
  `modal-body`, `modal-foot` (`foot-hint`, `foot-hint err`, `foot-actions`), `field`, `flabel`,
  `req`, `fhint`, `pick-chips`, `pick-chip` / `pick-chip on`, `sdot`.

---

## 7. Porting notes

Prototype-only bits → replacements:

- `window.VIBERR.stages` / `.tasks` / `.people` globals → board **loader** returning
  `{ project, stages, tasks }` from SQLite projections. Session comes from auth middleware, not
  `localStorage viberr:session`.
- `useStateB`/`useMemoB` aliasing (Babel-global namespace collision workaround) → normal React
  imports.
- `Object.assign(window, { Board })` export → normal module export under `app/features/board/`.
- Fake re-scan `setTimeout` → real action (§5.2).
- `onOpen(key)` callback → route navigation to `/projects/:slug/tasks/:key`.
- Create-task client-side key minting and in-memory `created[]` → server action writing task.md
  (§5.1); after action, revalidate (no optimistic UI).
- SSE (Phase 6): board route subscribes to project stream; `task.updated` / `projection.rebuilt`
  trigger revalidation so cards move/update live.

Quirks and gotchas found in the mock (decide deliberately, don't silently "fix"):

1. **`.card.urgent` has no visual effect.** The only selector touching these modifiers is
   `.card.wait-human, .card.wait-human.urgent { box-shadow: var(--shadow-card); }` — which is the
   same shadow the base `.card` already has. So today neither `wait-human` nor `urgent` changes a
   card's appearance. Keep emitting both classes (contract), but flag to design (Open questions).
2. **`.owner-row` has no CSS rule** in `viberr.css` — the div works via default block flow, with
   `rev-stack` rendering inline after the `card-owner` div (which is `display:flex` but a block).
   Keep the markup; if visual QA against the mock shows a difference, match the mock's rendered
   output, not an imagined flex row.
3. **"Waiting on me" is a lie** — it filters `waiting === "human"` (any human), not the current
   user. Port as-is; raise in Open questions.
4. **List view has no empty state** (and the whole-board "no matches" state is just five "No
   tasks" columns). Consider adding an `.empty` div to the list view for parity — deviation to
   document.
5. **NewTaskModal misses Escape-to-close, `aria-modal`, and focus trap** — add them per
   CONVENTIONS; keep everything else byte-identical.
6. `key.slice(4)` assumes the `VIB-` prefix — server derives prefix per project.
7. `shortBranch` truncation (>16 chars → 15 + `…`) — keep exact.
8. Owner first-name display (`o.name.split(" ")[0]`) — keep exact.
9. Modal submit button uses `disabled` **plus** inline `opacity/pointerEvents` — keep both.
10. `data-screen-label="Board"` on `.board-wrap` was used by the prototype's screenshot/tweaks
    tooling — harmless; keep for CSS-selector stability or drop consistently across all surfaces.
11. Stage list can change (Settings edits stages in the mock) — don't hardcode the five stages;
    always render from loader data, including colors.
12. `ValidationPill` is imported-adjacent but unused here; don't add validation pills to cards.
13. Mock never disables "New task"/column "+" by role — the real UI should hide or disable create
    affordances for `viewer` (server enforces regardless).

Empty/error states:

- Column with no (filtered) tasks → `.empty` "No tasks".
- Board with zero tasks total → all columns show "No tasks"; header reads
  "0 tasks · 0 waiting on a human decision".
- Loader failure → route error boundary (Phase-4 shell concern); no board-specific error UI exists
  in the mock.
- Create-action failure → surface in the modal's `foot-hint err` (deviation; the mock cannot fail).

---

## 8. Open questions

1. **Per-user "Waiting on me"?** Mock filters any `waiting === "human"` task. Should the real chip
   filter tasks where the current user is owner (or the packet is addressed to them), and should
   the label change if we keep the global behavior?
2. **Readiness `done`** — CONVENTIONS defines only 4 readiness values, but done-stage mock tasks
   carry `readiness: "done"` rendered as the "accepted" pill. Is "accepted" derived
   (stage === done) in the real model, or a 5th readiness value? The board needs a decision to
   render done-column pills.
3. **Urgent visual treatment** — class exists, CSS is a no-op (Porting note 1). Does design want a
   real urgent treatment (border/badge), or is `urgent` intentionally only a filter input?
4. **Typed "created" timeline event** — mock creates tasks with an empty timeline. Should the real
   create action append a creation event to task.md (audit trail suggests yes)?
5. **Re-scan toast copy** says "`.viberr` store" but the real data root is `./data` per
   BUILD-PLAN. Keep the mock copy verbatim or align with the real store name?
6. **Filter/group in URL** — mock keeps them in component state. OK to promote to search params
   (recommended), or must reload semantics match the mock exactly?
7. **List view ordering** — mock preserves raw array order (mixed stages). Should the real list
   sort (by stage order, then key), or match the mock's projection order?
8. **Column `+` on `done`** is hidden and the modal excludes `done` — confirm the server also
   rejects direct creation into `done` (it should; human-only completion rule).
