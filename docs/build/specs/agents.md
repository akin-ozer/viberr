# Spec: Agents view (`design/html-app/app/agents.jsx` → `app/features/agents/`)

Source of truth: `design/html-app/app/agents.jsx` (696 lines), shared primitives in
`design/html-app/app/ui.jsx`, data shapes in `design/html-app/app/data.js` (`AGENTS`, `TASKS`,
`STAGES`), host wiring in `design/html-app/app/main.jsx`. CSS contract:
`design/html-app/app/viberr.css` (ported verbatim — **class names are the contract**, do not
rename or replace with Tailwind).

---

## 1. Purpose & entry points

The Agents view is the project's **agent-governance surface**: a roster of reusable agent
*profiles* (one system Operator + N specialist profiles), each with eligible stages, a
three-bucket capability policy (acts directly / recommends only / reserved for humans), context
resources (skills, MCP servers, knowledge bases), and execution backend/model. It also shows
**live deployment state** — which profiles are engaged on which tasks right now, in what
engagement role, and whether they're working or waiting — both per-profile (detail panel) and
globally (Live tab table). Finally it hosts three modals: **create/edit profile**, **delete
confirm**, and the read-only **capability matrix** (profiles × actions grid).

This view maps to FR8/FR9 in the mock's own comments ("Agent profiles — reusable capability
definitions").

### Entry points (mock → real)

| Mock | Real app |
|---|---|
| `main.jsx` renders `<Agents tasks={tasks} onOpen={(k) => setOpenKey(k)} />` when `view === "agents"` | Route `/projects/:slug/agents` |
| Hash `#agents` pre-selects the view (regex in `main.jsx:133`) | Real route above |
| Rail nav item `{ id: "agents", label: "Agents", icon: "agents" }` | Same shell (Phase 4) |
| Deploy-row / live-row click → `onOpen(task.key)` → task detail replaces board view | Navigate to `/projects/:slug/tasks/:key` |
| Policy view (`policy.jsx:208`) also opens `CapabilityMatrixModal` with `[A.operator, ...A.profiles]` | The matrix modal must be a **shared component** importable by both the agents and policy features |

Props in the mock:

- `tasks` — the merged task array from the app root (base + created + overrides). Used **only**
  to derive live deployments; never mutated here.
- `onOpen(key)` — open task detail.

No `push` (toast) prop is passed — this view shows **no toasts** in the mock.

---

## 2. Component tree

```
Agents                       – root; owns tab/selection/profile-CRUD session state
├─ board-head                – h1 "Agents", subtitle, Profiles/Live seg, Capability matrix btn, New profile btn
├─ ag-stats                  – 4 stat tiles (profiles / operators / working / waiting)
├─ (tab === "profiles") agents-layout
│   ├─ aside.profile-list
│   │   ├─ ProfileItem       – operator row (group label "Orchestration")
│   │   ├─ ProfileItem ×N    – specialist rows (group label "Specialist profiles" + inline + btn)
│   │   │   ├─ ProfileGlyph  – icon tile; " op" class variant for operator
│   │   │   └─ ActiveBadge   – pulsing count of distinct active tasks, or "idle"
│   │   └─ ag-newbtn         – "New specialist profile" footer button
│   └─ ProfileDetail         – hero, description, 4 panels, inline delete-confirm dialog
│       ├─ (confirm) confirm-scrim + confirm-card   – delete alertdialog
│       ├─ ag-hero           – glyph lg, name, role pill, running/idle badge, Delete + Edit buttons
│       ├─ panel "Eligible stages"        – stage-chips (elig/off)
│       ├─ panel "Capability policy"      – CapColumn ×3 (direct/recommend/forbidden)
│       ├─ panel "Context resources & runtime" – ResGroup ×3 + runtime-row (backend/model/continuity)
│       │   └─ BackendChip   – glyph + "Claude Code" | "Codex"
│       └─ panel "Active deployments"     – deploy-list of deploy-row buttons (or empty state)
├─ (tab === "live") LiveRoster            – live-table: Agent/Backend/Task/Engagement/Status rows
├─ (creating) CreateProfileModal          – create mode
├─ (editing)  CreateProfileModal          – edit mode (initial=profile)
│   ├─ TagInput              – DEFINED BUT UNUSED (dead code; see Porting notes)
│   ├─ cap-matrix accordion  – CAP_CATALOG groups × 4-way cap-seg segmented control
│   └─ cap-matrix accordion  – RES_CATALOG groups × pick-chip toggles
└─ (matrixOpen) CapabilityMatrixModal     – wide modal, profiles × actions table
```

Shared primitives consumed from `ui.jsx`: `Icon`, `Pill`, `AgentGlyph`. (No `ReadinessPill`,
`Avatar`, `Identity`, or toasts here.)

One-liners:

- **Agents** — state: `removed: string[]`, `added: profile[]`, `edits: {[id]: profile}`,
  `creating: bool`, `editing: profile|null`, `matrixOpen: bool`, `sel: string` (default
  `"operator"`), `tab: "profiles"|"live"` (default `"profiles"`). All profile CRUD is
  session-local (see §5/§7).
- **deployments(tasks)** — pure derivation of engagement instances from tasks (see §3.3).
- **statusKind(s)** — status string → pill kind (see §3.4).
- **BackendChip** — `span.be-chip` with `AgentGlyph` + label `Claude Code`/`Codex`.
- **ProfileGlyph** — `span.agent-glyph[ lg][ op]` with `title={a.role}` and `<Icon name={a.icon}/>`.
- **ActiveBadge** — `count > 0` → `span.ag-active` with pulsing `span.working` dot + count; else
  `span.ag-idle` with text `idle`.
- **ProfileItem** — whole-row `<button className="ag-item[ on]">`; glyph, name, role, badge.
- **CapColumn** — one policy bucket column; head icon+label, then one `cap-item` per action label.
- **ResGroup** — labeled chip list; empty → literal `None` placeholder.
- **ProfileDetail** — the right-hand detail; owns only local `confirm` boolean.
- **LiveRoster** — sorted global engagement table.
- **CreateProfileModal** — create *and* edit form (edit when `initial` prop set).
- **CapabilityMatrixModal** — read-only profiles × actions grid; ALSO used by `policy.jsx`.

---

## 3. Data consumed

### 3.1 Agent profiles (`window.VIBERR.agents`)

Shape (mock: `data.js:554-621`):

```js
AGENTS = {
  operator: {
    id: "operator", kind: "operator", name: "Operator", role: "Task coordinator", icon: "shield",
    backends: ["claude"], model: "orchestration runtime", scope: "System role · one per active task",
    desc: "A dedicated operator is instantiated for every active task. …",
    stages: ["triage","ready","impl","review","done"], spanAll: true,
    actions: { direct: [...labels], recommend: [...labels], forbidden: [...labels] },
    resources: { skills: [...], mcps: [...], kb: [...] },
  },
  profiles: [ { id, kind: "specialist", name, role, icon, backends, model, scope, desc,
                stages, actions, resources }, ... ],  // developer, reviewer, tester, consultant
}
```

Field notes (all consumed by this view):

| Field | Type / values | Used for |
|---|---|---|
| `id` | `"operator" \| "developer" \| "reviewer" \| "tester" \| "consultant"` (created: slug+rand) | selection, deployment join key (see §3.3 warning) |
| `kind` | `"operator" \| "specialist"` | op glyph styling, delete gate, hero pill kind, runtime cell variant |
| `name` | `"Developer"` etc. | list rows, hero h1, delete copy, matrix column head |
| `role` | `"Implementation"` etc. | list sub-line, hero pill, glyph `title` |
| `icon` | icon name: `shield`/`branch`/`check`/`bolt`/`message` (created: `"agents"`) | ProfileGlyph |
| `backends` | array of `"codex"\|"claude"` (operator: `["claude"]`) | BackendChip list in runtime row; modal single-pick seeds from `[0]` |
| `model` | display string, e.g. `"codex-large · claude-sonnet"`, operator `"orchestration runtime"` | runtime row Model cell (mono) |
| `scope` | display string, e.g. `"Global base · customized for Viberr Core"`, `"System role · one per active task"`, created: `"Created in Viberr Core"` | hero `.ag-scope` line |
| `desc` | 1–3 sentence description | `.ag-desc` paragraph, modal Definition textarea |
| `stages` | array of stage ids | eligible-stage chips, modal stage picker |
| `spanAll` | boolean (operator only) | stage panel right-hint text |
| `actions.direct / .recommend / .forbidden` | arrays of **display-label strings** | CapColumns, matrix modal, modal cap matrix (reverse-mapped) |
| `resources.skills / .mcps / .kb` | arrays of strings | ResGroup chips, modal resource picker |

The four seeded specialist profiles (developer / reviewer / tester / consultant) and the operator
must ship as **seed data** in the real app — copy their full field values verbatim from
`data.js:554-621`.

Real source: per BUILD-PLAN the runtime data root has an `agents/` directory; org-settings also
manages "agent profiles". Profiles should be file-native definitions (e.g. `agents/<id>.md` with
frontmatter) parsed → projected to SQLite, loaded by the agents route loader. Operator is a
system-defined profile (not deletable; see §4.3). **Exact storage location is an open question**
(§8) — coordinate with Phase 8/9 and org-settings spec.

### 3.2 Stages (`window.VIBERR.stages`)

Same 5-stage array as the board spec (`triage/ready/impl/review/done` with `name` + `color` hex).
Used for the eligible-stages chips (chip per stage, `sdot` inline `background: s.color` when
eligible) and the modal stage picker. Real: project projection via loader. **Note:** the mock
reads `window.VIBERR.stages` inside `ProfileDetail` and `CreateProfileModal` directly, and
Settings can mutate it; real code passes loader data down.

### 3.3 Live deployments — derived from tasks

Fields read from each task: `key`, `title`, `stage`, `waiting` (`"human"|"agent"|"none"`),
`operator` (`null | { name: "Operator", since: "stage 1" }`), `specialist`
(`null | { kind:"agent", backend:"codex"|"claude", name, role }`), `consultants`
(array of same agent shape).

Verbatim derivation (`agents.jsx:5-23`) — this is the heart of the surface:

```js
function deployments(tasks) {
  const inst = [];
  tasks.forEach((t) => {
    if (t.stage === "done") return;
    if (t.operator) {
      inst.push({ profile: "operator", role: "Operator", backend: "claude", engagement: "operator", task: t,
        status: t.waiting === "human" ? "packet open" : "coordinating", since: t.operator.since });
    }
    if (t.specialist) {
      inst.push({ profile: t.specialist.role.toLowerCase(), role: t.specialist.role, backend: t.specialist.backend, engagement: "primary", task: t,
        status: t.waiting === "agent" ? "working" : t.waiting === "human" ? "waiting on human" : "on call", since: (t.operator || {}).since });
    }
    (t.consultants || []).forEach((c) => {
      inst.push({ profile: c.role.toLowerCase(), role: c.role, backend: c.backend, engagement: "consultant", task: t,
        status: "anchored · on call", since: (t.operator || {}).since });
    });
  });
  return inst;
}
```

Semantics to preserve:

- **Done tasks contribute nothing.** Any non-done task with an `operator` object yields an
  operator engagement (even triage tasks — but the two mock triage tasks have `operator: null`,
  so they contribute nothing).
- Operator status: `waiting === "human"` → `packet open`, otherwise `coordinating`.
- Primary specialist status: `waiting === "agent"` → `working`; `waiting === "human"` →
  `waiting on human`; `waiting === "none"` → `on call`.
- Consultant status is always the literal string `anchored · on call`.
- Operator `backend` is hard-coded `"claude"` in the instance but **rendered as
  "orchestration"**, never "Claude Code", everywhere the operator row appears (see §4.4, §4.5).
- `since` is carried but **never rendered** in this view — drop or keep at your discretion.

**⚠ Join-key trap:** the mock joins engagement → profile via
`t.specialist.role.toLowerCase()` — i.e. the *display role string of the task's agent identity*
("Developer" → `developer`) happens to equal the profile id. This is string-coincidence, not a
real foreign key. In the real app, task assignment records must store the **profile id**
explicitly and the projection query must join on it. Do not port `.toLowerCase()` matching.

Real source: this derivation must become a **projection query** — active engagements per task
from the task projections (operator/specialist/consultant assignment fields + waiting state),
computed in the agents route loader (or a shared `app/server/projections/` helper). It should
refresh via SSE (`task.updated`) revalidation, since deployment state changes as tasks progress.

### 3.4 Status → pill kind

```js
function statusKind(s) {
  if (s === "working" || s === "coordinating") return "agent";
  if (s === "packet open") return "input";
  if (s === "waiting on human") return "info";
  return "neutral";   // "on call", "anchored · on call"
}
```

Status pills get `dot` (pulsing) only when `status === "working" || status === "coordinating"`.

### 3.5 Header stats (derived, `agents.jsx:639-642`)

```js
const all = deployments(tasks);
const running   = new Set(all.map((d) => d.task.key)).size;          // computed but NOT rendered
const operators = all.filter((d) => d.engagement === "operator").length;
const working   = all.filter((d) => d.status === "working").length;
const waiting   = all.filter((d) => d.status === "waiting on human" || d.status === "packet open").length;
```

Per-profile counts (`counts[profileId]`) = number of **distinct task keys** the profile is
engaged on (Set of `d.task.key` per `d.profile`). Used by `ActiveBadge` in the list and nowhere
else. Note `running` is dead code in the mock — the first stat tile shows `list.length`
(profile count), not `running`.

### 3.6 Modal catalogs (constants — port verbatim)

`CAP_CATALOG` (`agents.jsx:263-288`) — the curated governable-action catalog with default modes:

```js
const CAP_CATALOG = [
  { group: "Repository & execution", caps: [
    { id: "read", label: "Read the task & repository", def: "direct" },
    { id: "comment", label: "Comment on the task", def: "direct" },
    { id: "branch", label: "Create the task-key branch", def: "direct" },
    { id: "commit", label: "Commit & push to the branch", def: "direct" },
    { id: "openpr", label: "Open the review pull request", def: "recommend" },
    { id: "editother", label: "Edit another task's branch", def: "human" },
  ] },
  { group: "Validation & review", caps: [
    { id: "runval", label: "Run validation suites", def: "direct" },
    { id: "authortests", label: "Author test cases", def: "direct" },
    { id: "evidence", label: "Attach evidence references", def: "direct" },
    { id: "qualityflag", label: "Post quality-flag events", def: "direct" },
    { id: "verdict", label: "Report a validation verdict", def: "recommend" },
    { id: "approve", label: "Approve the review", def: "recommend" },
    { id: "changes", label: "Request changes", def: "recommend" },
    { id: "flagunder", label: "Flag underspecified tasks", def: "recommend" },
  ] },
  { group: "Workflow & approvals", caps: [
    { id: "toreview", label: "Move the task to Review", def: "recommend" },
    { id: "merge", label: "Merge a pull request", def: "human" },
    { id: "done", label: "Transition a task to Done", def: "human" },
    { id: "policy", label: "Change project policy", def: "human" },
  ] },
];
const CAP_MODES = [{ id: "direct", label: "Direct" }, { id: "recommend", label: "Recommend" },
                   { id: "human", label: "Human" }, { id: "off", label: "Off" }];
```

`RES_CATALOG` (`agents.jsx:308-324`) — grantable context resources with defaults:

```js
const RES_CATALOG = [
  { group: "Skills", key: "skills", mono: true, items: [
    { id: "repo-write", def: true }, { id: "test-runner", def: true }, { id: "lint-autofix", def: false },
    { id: "diff-review", def: false }, { id: "security-scan", def: false }, { id: "test-author", def: false },
    { id: "coverage-report", def: false }, { id: "refactor", def: false }, { id: "dependency-audit", def: false },
    { id: "domain-advisor", def: false },
  ] },
  { group: "MCP servers", key: "mcps", mono: true, items: [
    { id: "github", def: true }, { id: "filesystem", def: false }, { id: "viberr-task-store", def: false },
    { id: "http-fetch", def: false }, { id: "postgres", def: false }, { id: "docker", def: false },
  ] },
  { group: "Knowledge bases", key: "kb", mono: false, items: [
    { id: "Viberr Core architecture", def: true }, { id: "Coding standards", def: true }, { id: "Review checklist", def: false },
    { id: "Security guidelines", def: false }, { id: "Test strategy", def: false }, { id: "Product brief", def: false },
    { id: "Domain glossary", def: false }, { id: "Prior decisions", def: false },
  ] },
];
```

**⚠ Labels are the storage format.** Profile `actions` buckets store *display labels*, and the
modal reverse-maps labels → catalog ids via `CAP_LABEL_TO_ID`. Labels found in a profile that
aren't in the catalog are preserved as "extras" (`extraCaps`) and re-appended on save; the matrix
modal collects them into an "Other actions" group. The seeded mock profiles contain several
**near-miss labels** that silently fall outside the catalog (e.g. Tester has
`"Run the validation suite"` vs catalog `"Run validation suites"`; `"Validation verdict"` vs
`"Report a validation verdict"`; Reviewer's `"Push commits to the branch"` vs catalog
`"Commit & push to the branch"`). The real app must store **capability ids** with a
per-capability mode, render labels from the catalog, and keep a free-text extras list only if
product wants it (see §8).

### 3.7 Where data must come from in the real app

| Data | Real source |
|---|---|
| Profiles (operator + specialists) | file-native agent profile definitions → projection → agents loader; seeded from mock values |
| Stages | project projection (project.md) via loader |
| Live deployments | projection query over task assignments + waiting state; loader + SSE revalidate |
| Capability/resource catalogs | server-side constants (single module, shared with policy surface) |
| Session | only for RBAC gating of New/Edit/Delete actions (see §8) — nothing user-specific is rendered |
| Env | nothing |

---

## 4. UI states & interactions

### 4.1 Header (`.board-head`)

- `<h1>Agents</h1>`; subtitle `.sub`:
  **`Reusable profiles, eligible stages, and capability policy · global base, customized for Viberr Core`**
  (real: the project-name suffix should come from loader data).
- Tab seg `.seg` — active button gets `on`:
  - `<Icon name="agents" />Profiles`
  - `<Icon name="activity" />Live<span style={{ opacity: .6 }}>· {all.length}</span>` — the Live
    tab label always shows the total engagement count (e.g. `Live · 14`).
- `<button className="btn ghost sm"><Icon name="shield" />Capability matrix</button>` → opens
  `CapabilityMatrixModal`.
- `<button className="btn primary sm"><Icon name="plus" />New profile</button>` → opens
  `CreateProfileModal` in create mode.

### 4.2 Stat tiles (`.ag-stats`)

Four `.ag-stat` tiles, each `div.n` (number) + `div.l` (label). Verbatim:

```jsx
<div className="ag-stat"><div className="n">{list.length}</div><div className="l">profiles approved · incl. operator</div></div>
<div className="ag-stat"><div className="n">{operators}</div><div className="l">operators running · one per active task</div></div>
<div className="ag-stat"><div className="n" style={{ color: "var(--agent-dark)" }}>{working}</div><div className="l">specialists working right now</div></div>
<div className="ag-stat"><div className="n" style={{ color: "var(--blue-pressed)" }}>{waiting}</div><div className="l">threads waiting on a human</div></div>
```

### 4.3 Profiles tab — list + detail (`.agents-layout`)

Left rail `aside.profile-list`:

- `div.ag-group-label` **`Orchestration`**, then the operator `ProfileItem`.
- `div.ag-group-label.ag-group-row` **`Specialist profiles`** containing
  `<button className="ag-add" title="New specialist profile"><Icon name="plus" /></button>`
  (opens create modal).
- One `ProfileItem` per specialist (order: seeded order, then session-created appended).
- Footer `<button className="ag-newbtn"><Icon name="plus" />New specialist profile</button>`
  (same create modal).

`ProfileItem` (verbatim):

```jsx
<button className={"ag-item" + (on ? " on" : "")} onClick={onClick}>
  <ProfileGlyph a={a} />
  <span className="ag-item-main">
    <span className="nm">{a.name}</span>
    <span className="sub">{a.role}</span>
  </span>
  <ActiveBadge count={count} />
</button>
```

`ActiveBadge`: `count > 0` → `<span className="ag-active"><span className="working" />{count}</span>`
(pulsing dot + distinct-task count); else `<span className="ag-idle">idle</span>`.

Selection: `sel` state, default `"operator"`; `current = list.find(a => a.id === sel) || list[0]`
(fallback keeps the panel alive if the selected id vanishes). Deleting the selected profile
resets selection to `"operator"`.

#### ProfileDetail (`.ag-detail`)

**Hero** (`.ag-hero`): large glyph; `.ag-hero-top` row with `<h1>{a.name}</h1>`,
`<Pill kind={a.kind === "operator" ? "agent" : "neutral"} sm>{a.role}</Pill>`, and the activity
badge:

- engaged: `<span className="ag-running"><span className="working" />running on {n} {n > 1 ? "tasks" : "task"}</span>`
- idle: `<span className="ag-idle">idle · available</span>`

`.ag-scope` line shows `a.scope`. Hero actions (`.ag-hero-actions`):

- `Delete` — `<button className="btn ghost sm danger"><Icon name="x" />Delete</button>` —
  rendered **only when `a.kind !== "operator"`** (the operator can never be deleted). Opens the
  confirm dialog.
- `Edit profile` — `<button className="btn sm"><Icon name="user" />Edit profile</button>` —
  always rendered, **including for the operator** (operator edit is allowed; the modal preserves
  its kind/model/icon/scope).

Then `<p className="ag-desc">{a.desc}</p>`.

**Delete confirm dialog** — rendered inline inside `.ag-detail` (scrim + card), verbatim:

```jsx
<div className="confirm-scrim" onClick={() => setConfirm(false)} />
<div className="confirm-card" role="alertdialog" aria-label="Delete profile">
  <div className="confirm-icon"><Icon name="alert" /></div>
  <h3>Delete the {a.name} profile?</h3>
  <p>
    This removes <strong>{a.name}</strong> from Viberr Core's approved profiles. It can't be assigned to new tasks.
    {activeKeys.length > 0
      ? <> It is currently engaged on <strong>{activeKeys.length} active task{activeKeys.length > 1 ? "s" : ""}</strong> — those threads keep running until the operator reassigns them.</>
      : <> The global base definition is unaffected.</>}
  </p>
  <div className="confirm-actions">
    <button className="btn ghost" onClick={() => setConfirm(false)}>Cancel</button>
    <button className="btn danger" onClick={() => { setConfirm(false); onDelete(a.id); }}><Icon name="x" />Delete profile</button>
  </div>
</div>
```

Scrim click cancels. (The mock adds no Escape handler on this dialog — adding one is a permitted
a11y upgrade; `PageOverlay` in `ui.jsx` shows the house Escape pattern.)

**Panel: Eligible stages** — `.panel` with head `<Icon name="board" /><h2>Eligible stages</h2>`
and right-hint `span.right.sub` (inline `fontSize: ".76rem", color: "var(--faint)"`):
`a.spanAll ? "active across the whole lifecycle" : `${a.stages.length} of ${stages.length} stages``.
Body `.stage-chips` — one chip per stage in stage order:

```jsx
<span className={"stage-chip" + (elig ? " elig" : " off")}>
  <span className="sdot" style={elig ? { background: s.color } : null} />{s.name}
</span>
```

**Panel: Capability policy** — head `<Icon name="shield" /><h2>Capability policy</h2>`; body
`.cap-cols` with three `CapColumn`s in fixed order direct → recommend → forbidden. `CAP_META`
(verbatim; the group icon repeats on every item row):

```js
const CAP_META = {
  direct:    { label: "Acts directly",       icon: "check" },
  recommend: { label: "Recommends only",     icon: "arrow" },
  forbidden: { label: "Reserved for humans", icon: "lock" },
};
```

```jsx
<div className={"cap-col " + group}>
  <div className="cap-col-head"><Icon name={m.icon} />{m.label}</div>
  <div className="cap-list">
    {items.map((x, i) => <div className="cap-item" key={i}><Icon name={m.icon} /><span>{x}</span></div>)}
  </div>
</div>
```

**Panel: Context resources & runtime** — head `<Icon name="cpu" /><h2>Context resources &amp; runtime</h2>`.
Body `.res-groups` with three `ResGroup`s: `Skills` (icon `bolt`), `MCP servers` (icon `cpu`),
`Knowledge bases` (icon `file`). Each is `div.res-group` > `div.lbl` label + `div.res-chips` of
`span.res-chip` (icon + text). Empty list renders
`<span className="sub" style={{ fontSize: ".8rem", color: "var(--placeholder)" }}>None</span>`.

Below, `.runtime-row` with three `.rt-cell`s:

1. label `Runtime` (operator) / `Execution backend` (specialist). Value:
   - operator: `<span className="be-chip"><span className="agent-glyph op" style={{ width: 22, height: 22 }}><Icon name="shield" /></span>Orchestration runtime</span>`
   - specialist: `<div className="be-list">` of `BackendChip` per backend (`AgentGlyph` +
     `Claude Code`/`Codex`).
2. label `Model` — `<div className="rt-val mono" style={{ fontSize: ".82rem" }}>{a.model}</div>`.
3. label `Continuity` — `<div className="rt-val mem-row" style={{ marginTop: 0 }}><Icon name="memory" /><span>Re-anchors on <code className="mono">task.md</code></span></div>`
   (static copy, same for every profile).

**Panel: Active deployments** — head `<Icon name="activity" /><h2>Active deployments</h2>` with
right-hint `{insts.length} engagement{insts.length === 1 ? "" : "s"}`. `insts` =
`deployments(tasks).filter(d => d.profile === a.id)`.

- Empty: `<div className="empty" style={{ padding: "1rem .5rem" }}>Not currently engaged on any task. This profile is approved and available for assignment.</div>`
- Else `.deploy-list` of row buttons (verbatim):

```jsx
<button className="deploy-row" key={i} onClick={() => onOpen(d.task.key)}>
  <span className="deploy-eng">{d.engagement}</span>
  <span className="deploy-task"><span className="key mono">{d.task.key}</span> {d.task.title}</span>
  {d.backend && a.kind !== "operator" && <BackendChip b={d.backend} />}
  <Pill kind={statusKind(d.status)} sm dot={d.status === "working" || d.status === "coordinating"}>{d.status}</Pill>
</button>
```

Row click navigates to the task. Operator rows suppress the backend chip.

### 4.4 Live tab — `LiveRoster`

`div.live-wrap > div.live-table`. Header row:

```jsx
<div className="live-head">
  <span>Agent</span><span>Backend</span><span>Task</span><span>Engagement</span><span>Status</span>
</div>
```

Rows: all deployments sorted by
`a.task.key.localeCompare(b.task.key) || order[a.engagement] - order[b.engagement]` where
`order = { operator: 0, primary: 1, consultant: 2 }` — i.e. grouped by task key
(lexicographic), operator first within each task. Row (verbatim):

```jsx
<button className="live-row" key={i} onClick={() => onOpen(d.task.key)}>
  <span className="live-agent">
    <span className={"agent-glyph" + (isOp ? " op" : " " + (d.backend === "claude" ? "claude" : "codex"))}>
      <Icon name={isOp ? "shield" : d.backend === "claude" ? "sparkle" : "cpu"} />
    </span>
    <span className="live-role">{d.role}</span>
  </span>
  <span className="live-be">{isOp ? "orchestration" : d.backend === "claude" ? "Claude Code" : "Codex"}</span>
  <span className="live-task"><span className="key mono">{d.task.key}</span> <span className="ttl">{d.task.title}</span></span>
  <span><Pill kind={d.engagement === "operator" ? "agent" : d.engagement === "primary" ? "info" : "neutral"} sm>{d.engagement}</Pill></span>
  <span><Pill kind={statusKind(d.status)} sm dot={d.status === "working" || d.status === "coordinating"}>{d.status}</Pill></span>
</button>
```

Engagement pill kinds: operator → `agent`, primary → `info`, consultant → `neutral`. There is no
empty state for the Live tab in the mock (mock data always has engagements) — add a sensible
`.empty` fallback ("No agents are currently engaged." or similar; flag in phase report).

### 4.5 Create/Edit profile modal — `CreateProfileModal`

Scrim (`confirm-scrim`, click closes) + `div.modal-card` with
`role="dialog" aria-label={editing ? "Edit profile" : "New specialist profile"}`.

**Head** (`.modal-head`): `<span className="agent-glyph lg"><Icon name="agents" /></span>`;
`.mh-main` with `<h2>` = `"Edit " + initial.name` or `New specialist profile`; `.mh-sub` =
`Update this profile — changes apply to future assignments.` (edit) or
`A reusable agent the operator can assign to tasks.` (create); close button
`<button className="icon-btn modal-close" aria-label="Close"><Icon name="x" /></button>`.

**Body** (`.modal-body`) fields, in order:

1. `.field-row` with two `.field`s: **Name*** (`input[type=text]`, placeholder `e.g. Migrations`,
   `autoFocus`) and **Role*** (placeholder `e.g. Schema changes`). Required marker:
   `<span className="req">*</span>` inside `label.flabel`.
2. **Execution backend*** — hint `<span className="fhint">pick exactly one</span>`. `.pick-chips`
   with single-select chips (`BACKENDS = [{ id: "codex", label: "Codex" }, { id: "claude", label: "Claude Code" }]`
   — note Codex listed first):
   `<button type="button" className={"pick-chip" + (backend === b.id ? " on" : "")}><AgentGlyph backend={b.id} />{b.label}</button>`.
3. **Eligible stages*** — hint `stages this profile may work in`. Multi-select `.pick-chip`s, one
   per stage, with `<span className="sdot" style={selected ? { background: s.color } : null} />{s.name}`.
4. **Definition** (optional) — hint `what this agent is for, in your words — markdown ok`.
   `<textarea>` (inline `minHeight: "96px"`), placeholder:
   `e.g. Owns database schema changes. Writes and verifies migrations against a shadow DB, and never touches application code without operator sign-off.`
5. **Capability policy** — hint `how each action is enforced — adjust the defaults`. A
   `.cap-matrix` accordion of `CAP_CATALOG` groups; only the first group starts open. Group head
   (verbatim; `.open` class on both group and head when expanded):

```jsx
<button type="button" className={"cap-mghead" + (open ? " open" : "")} onClick={/* toggle */}>
  <Icon name="chevron" className="cap-chev" />
  <span className="cap-mglabel">{g.group}</span>
  <span className="cap-msum">
    {c.direct > 0 && <span className="cs"><span className="d" style={{ background: "var(--teal-dark)" }} />{c.direct}</span>}
    {c.recommend > 0 && <span className="cs"><span className="d" style={{ background: "var(--blue)" }} />{c.recommend}</span>}
    {c.human > 0 && <span className="cs"><span className="d" style={{ background: "var(--coral-dark)" }} />{c.human}</span>}
    {c.off > 0 && <span className="cs"><span className="d" style={{ background: "var(--placeholder)" }} />{c.off}</span>}
  </span>
</button>
```

   Group body: one `.cap-mrow` per capability — `<span className="cap-mname">{cap.label}</span>`
   plus a 4-way segmented control:

```jsx
<div className="cap-seg">
  {CAP_MODES.map((m) => (
    <button type="button" key={m.id} className={m.id + (caps[cap.id] === m.id ? " on" : "")}
      onClick={() => setCaps((p) => ({ ...p, [cap.id]: m.id }))}>{m.label}</button>
  ))}
</div>
```

   (Segment button className is the raw mode id — `direct on`, `recommend`, `human`, `off` — the
   CSS keys off those names.)

6. **Context resources** — hint `skills, MCP servers, knowledge bases this profile may load`.
   Same `.cap-matrix` accordion over `RES_CATALOG` (first group open). Group summary:
   `<span className="cap-msum"><span className="cs"><span className="d" style={{ background: "var(--blue)" }} />{sel.length} of {g.items.length}</span></span>`.
   Body is a `.pick-chips` of toggle chips; selected chips get a leading check icon; skills/MCP
   chips add the `mono` class:
   `<button type="button" className={"pick-chip" + (g.mono ? " mono" : "") + (sel.includes(it.id) ? " on" : "")}>{sel.includes(it.id) && <Icon name="check" />}{it.id}</button>`.

**Foot** (`.modal-foot`): `span.foot-hint` (adds class `err` when invalid) —
valid+editing: `Ready to save changes.`; valid+creating: `Ready to add to Viberr Core.`; invalid:
`Name, role, one execution backend, and at least one stage are required.` Then `.foot-actions`:
`Cancel` (`btn ghost`) and submit
`<button className="btn primary" disabled={!valid} style={!valid ? { opacity: .5, pointerEvents: "none" } : null}><Icon name="check" />{editing ? "Save changes" : "Create profile"}</button>`.

**Validation:** `valid = name.trim() && role.trim() && backend && stg.length` — Definition,
capabilities, and resources are never blocking.

**State seeding (edit mode):** `caps = reverseCaps(initial.actions)` (labels → catalog-id modes;
uncatalogued ids start `"off"`), `extra = extraCaps(initial.actions)` (non-catalog labels bucketed
by mode, held constant and re-appended on save), `backend = initial.backends[0]`, resources
copied. Create mode: `caps = CAP_DEFAULTS`, `res = RES_DEFAULTS` (from catalog `def` flags),
empty name/role/stages/definition, no backend selected.

**Submit payload** (`agents.jsx:370-390`):

- `id`: editing → unchanged; creating →
  `name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") + "-" + Math.random().toString(36).slice(2, 6)`
  (e.g. `migrations-x3k9`). Real: server-generated slug id with uniqueness check.
- `kind`: editing → preserved (so operator stays operator); creating → `"specialist"`.
- `icon`: editing → preserved; creating → `"agents"`.
- `backends`: `[backend]` (single). **Note:** even editing a seeded multi-backend profile
  (Developer has `["codex","claude"]`) collapses it to one backend — the modal only supports one.
- `model`: operator-edit → preserved; otherwise derived:
  `backend === "claude" ? "claude-sonnet" : "codex-large"`.
- `scope`: editing → preserved; creating → `"Created in Viberr Core"`.
- `desc`: `definition.trim()` or fallback `` `${name} — a ${role.toLowerCase()} specialist.` ``.
- `stages`: selected ids.
- `actions`: `{ direct: [...catalogLabels(direct), ...extra.direct], recommend: [...,...],
  forbidden: [...bucket("human"), ...extra.human] }` — note the UI mode `human` maps to the
  stored bucket name `forbidden`.
- `resources`: `{ skills, mcps, kb }` arrays as selected.

Note `spanAll` is **not** in the payload: editing the operator through this modal drops
`spanAll`, changing its stage-panel hint from "active across the whole lifecycle" to "5 of 5
stages". Minor mock wart; preserve or fix (flag in phase report).

### 4.6 Capability matrix modal — `CapabilityMatrixModal({ profiles, onClose })`

Shared with `policy.jsx` (which passes `[A.operator, ...A.profiles]`). Scrim + 
`div.modal-card.modal-wide` with `role="dialog" aria-label="Capability matrix"`.

Head: glyph `agent-glyph lg` with shield icon; `<h2>Capability matrix</h2>`; `.mh-sub`
`Every profile's permissions for each action in Viberr Core.`; standard close button.

Legend (`.mx-legend`, outside `.modal-body`):

```jsx
<span className="lg"><span className="d" style={{ background: "var(--teal-dark)" }} />Acts directly</span>
<span className="lg"><span className="d" style={{ background: "var(--blue)" }} />Recommends</span>
<span className="lg"><span className="d" style={{ background: "var(--coral-dark)" }} />Reserved for humans</span>
<span className="lg"><span className="d" style={{ background: "var(--ring)" }} />Not granted</span>
```

Body: `.mx-scroll` (horizontal scroll container) wrapping `table.cap-matrix-table`:

- `<thead>`: `<th className="corner">Action</th>` then one `<th>` per profile:
  `<div className="mx-col"><span className={"agent-glyph" + (p.kind === "operator" ? " op" : "")}><Icon name={p.icon} /></span>{p.name}</div>`.
- Rows: groups = `CAP_CATALOG` groups (label lists) **plus**, if any profile has action labels
  not in the catalog, a final group `Other actions` with every such label (first-seen order across
  profiles × direct→recommend→forbidden). Group separator row:
  `<tr className="grp"><td colSpan={profiles.length + 1}>{g.group}</td></tr>`.
- Per action row: `<td className="rowlabel">{label}</td>` then per profile a cell:

```jsx
<td key={p.id}>
  <span className={"mx-cell " + m}
        title={m === "off" ? "Not granted" : m === "human" ? "Reserved for humans" : m === "recommend" ? "Recommends" : "Acts directly"}>
    <span className="d" />
  </span>
</td>
```

  where `m = modeOf(p, label)`: `direct` if label ∈ `p.actions.direct`, else `recommend`, else
  `human` (from `forbidden`), else `off`.

Because seeded profiles use mostly bespoke labels, the mock's matrix has a **large
"Other actions" group** (all 11 operator actions plus the near-miss labels from §3.6). This is
expected mock behavior; the real fix is id-based capabilities (§7).

### 4.7 Keyboard / aria inventory

- Delete confirm: `role="alertdialog" aria-label="Delete profile"`; scrim click closes.
- Create/edit modal: `role="dialog"` with mode-specific `aria-label`; close button
  `aria-label="Close"`; scrim click closes. First field `autoFocus`.
- Matrix modal: `role="dialog" aria-label="Capability matrix"`; same close/scrim.
- **No Escape-to-close on any of the three dialogs in the mock** — add it (house pattern per
  CONVENTIONS "Escape closes, scrim click closes"); also add focus trapping if the shared dialog
  primitive provides it.
- Tab seg / pick-chips / cap-seg buttons carry no `aria-pressed` in the mock — permitted upgrade.
- Every clickable row (ag-item, deploy-row, live-row) is a real `<button>` — keep that; no nested
  interactive elements inside them.

---

## 5. Events/mutations produced

Everything below is **session-local state in the mock** (lost on refresh) and must become real
actions:

| Mock behavior | Real action |
|---|---|
| `onCreate(profile)` — appends to `added`, selects it, closes modal | `POST` create-profile action: validate (name/role/backend/≥1 stage), server-generate id, write agent profile file → re-project → revalidate. Audit event (`agent_profile.created` or similar per Phase-8 naming). |
| `onSave(profile)` — stores in `edits[id]` overlay, selects, closes | update-profile action: rewrite profile file (frontmatter-preserving), re-project, revalidate. Audit event. Changes apply to **future assignments only** (per modal sub-copy) — running engagements are untouched. |
| `onDelete(id)` — appends to `removed`, reselects operator | delete-profile action. Server must enforce: operator profile is not deletable (mock hides the button; real must also reject server-side). Per the confirm copy, deletion with active engagements is **allowed** — running threads continue until the operator reassigns. Audit event. |
| Deploy-row / live-row click → `onOpen(task.key)` | client navigation to `/projects/:slug/tasks/:key` (Link/navigate) |
| Tab switch, selection, accordion open/close | pure client state (useState); optionally reflect tab in URL (`?tab=live`) — deviation to note in phase report |

Timeline events: this view writes **no typed timeline events** into any task.md — profile CRUD is
project/agent-policy-level, so it produces **audit events** (per CONVENTIONS: every governed
action → audit event), not task timeline entries. If Phase 8 models "capability policy change" as
a policy-surface event (the Policy view's event feed shows `change` entries like "Elif locked
Review → Done…"), profile create/edit/delete should also surface there — coordinate with the
policy spec.

Capability enforcement itself (blocking a forbidden agent action, e.g. the mock policy event
"Blocked: Developer (Codex) attempted **Merge a pull request**") is **not** this surface's job —
this view only edits the policy that Phase 8's runtime enforces server-side.

---

## 6. CSS classes used (structural contract)

All verified present in `viberr.css`. Do not rename.

- **Page scaffold:** `board-wrap` (+ `data-screen-label="Agents"`), `board-head`, `board-tools`,
  `seg` (+ `on`), `btn` / `ghost` / `sm` / `primary` / `danger`, `sub`, `right`.
- **Stats:** `ag-stats`, `ag-stat` (`.n`, `.l`).
- **List:** `agents-layout`, `profile-list`, `ag-group-label`, `ag-group-row`, `ag-add`,
  `ag-item` (+ `on`), `ag-item-main` (`.nm`, `.sub`), `ag-active`, `ag-idle`, `working`
  (pulsing dot), `ag-newbtn`.
- **Glyphs/chips:** `agent-glyph` (+ `lg`, `op`, `claude`, `codex`), `be-chip`, `be-list`,
  `pill` kinds `agent` / `info` / `input` / `neutral` (+ `sm`, `pdot` via `Pill dot`).
- **Detail:** `ag-detail`, `ag-hero`, `ag-hero-main`, `ag-hero-top`, `ag-hero-actions`,
  `ag-running`, `ag-scope`, `ag-desc`, `panel`, `panel-head`, `stage-chips`,
  `stage-chip` (+ `elig` / `off`), `sdot`, `cap-cols`, `cap-col` (+ `direct` / `recommend` /
  `forbidden`), `cap-col-head`, `cap-list`, `cap-item`, `res-groups`, `res-group`, `lbl`,
  `res-chips`, `res-chip`, `runtime-row`, `rt-cell`, `rt-val`, `mono`, `mem-row`,
  `deploy-list`, `deploy-row`, `deploy-eng`, `deploy-task`, `key`, `empty`.
- **Live:** `live-wrap`, `live-table`, `live-head`, `live-row`, `live-agent`, `live-role`,
  `live-be`, `live-task` (`.ttl`).
- **Dialogs:** `confirm-scrim`, `confirm-card`, `confirm-icon`, `confirm-actions`, `modal-card`,
  `modal-wide`, `modal-head`, `mh-main`, `mh-sub`, `icon-btn`, `modal-close`, `modal-body`,
  `modal-foot`, `foot-hint` (+ `err`), `foot-actions`.
- **Form:** `field`, `field-row`, `flabel`, `req`, `fhint`, `pick-chips`,
  `pick-chip` (+ `on`, `mono`), `cap-matrix`, `cap-mgroup` (+ `open`), `cap-mghead` (+ `open`),
  `cap-chev`, `cap-mglabel`, `cap-msum`, `cs`, `d`, `cap-mbody`, `cap-mrow`, `cap-mname`,
  `cap-seg` (mode buttons keyed by class names `direct` / `recommend` / `human` / `off` + `on`),
  `tagbox` (+ `sent`) / `tag` (only if TagInput is kept — see §7).
- **Matrix modal:** `mx-legend` (`.lg`, `.d`), `mx-scroll`, `cap-matrix-table`, `corner`,
  `mx-col`, `grp`, `rowlabel`, `mx-cell` (+ `direct` / `recommend` / `human` / `off`).

Inline styles that are part of the design (keep as inline styles, they carry data or one-off
sizing): stage/`sdot` colors from stage data; stat-number colors `var(--agent-dark)` /
`var(--blue-pressed)`; cap-summary dot colors `var(--teal-dark)` / `var(--blue)` /
`var(--coral-dark)` / `var(--placeholder)`; legend dot `var(--ring)`; right-hint
`fontSize: ".76rem", color: "var(--faint)"`; ResGroup empty placeholder; operator runtime glyph
`width/height: 22`; model cell `fontSize: ".82rem"`; textarea `minHeight: 96px`; Live tab count
`opacity: .6`; disabled submit `opacity: .5, pointerEvents: "none"` (real code can use the
`:disabled` attribute + CSS instead, keeping visual parity).

---

## 7. Porting notes

**Prototype-only bits → replacements**

- `window.VIBERR.agents` / `window.VIBERR.stages` globals → agents route loader returning
  `{ profiles, operator, stages, deployments }` from projections. No client-side global reads.
- `deployments(tasks)` client derivation → server-side projection query (§3.3). Keep the exact
  status vocabulary (`coordinating`, `packet open`, `working`, `waiting on human`, `on call`,
  `anchored · on call`) as user-visible strings, but derive them server-side from real
  engagement + waiting state. Live tab should feel live: revalidate on SSE `task.updated`.
- The `.toLowerCase()` role→profile join → real profile-id foreign key on assignment records.
- Session-local `removed`/`added`/`edits` overlays → real create/update/delete actions with
  revalidation; no optimistic UI for these (governed state).
- Client-generated random ids → server-generated ids.
- Label-string capability storage → **id-based capabilities**: store
  `{ capabilityId: "merge", mode: "human" }` (+ optional free-text extras), render labels from
  the shared catalog module. Seed migration must map the mock profiles' labels to ids where they
  match and keep the bespoke ones (operator actions etc.) as extras — the rendered UI (detail
  columns + matrix) must still show the same strings as the mock.
- `React.Fragment` shorthand, `useStateAg` aliases → ordinary modern React/TS.
- `Object.assign(window, { Agents, CapabilityMatrixModal })` → normal module exports;
  `CapabilityMatrixModal` lives somewhere shareable (e.g. `app/features/agents/capability-matrix-modal.tsx`)
  because the policy feature imports it too.

**Dead code in the mock — do not port blindly**

- `TagInput` (`agents.jsx:327-347`) is defined but **never rendered** (a leftover from an earlier
  free-text resources UI; the `tagbox`/`tag`/`sent` CSS still exists). Skip it unless another
  spec claims it.
- `running` (distinct active task count) is computed in `Agents` but unused.
- `since` on deployment instances is derived but never rendered.
- `extra` in the modal uses `useState` with no setter — it's constant per mount; treat it as
  derived data, not state.

**Edge cases**

- Empty profile deployments → exact empty-state copy in §4.3. Live tab has no mock empty state —
  add one (deviation, note in report).
- Deleting the selected profile → selection falls back to operator. Deleting a profile whose id
  is referenced by active engagements is allowed; the engagement rows keep rendering under other
  profiles' filters won't match anymore (in the mock the deploy rows for a deleted profile simply
  disappear from the profiles list but remain in the Live tab, since Live derives from tasks, not
  profiles — preserve this: Live is engagement-truth, not profile-truth).
- Editing the operator: allowed; preserves `kind`/`model`/`icon`/`scope`, but the modal forces a
  single backend and drops `spanAll` (§4.5). Decide: either replicate exactly or exclude the
  operator from editing/normalize `spanAll` server-side — flag choice in the phase report.
- Multi-backend seeded profiles (Developer, Consultant) lose their second backend if edited
  through the modal (single-pick). Same decision point as above; the detail view must still
  render multiple `BackendChip`s for seeded profiles either way.
- Unknown/missing `icon` name → `Icon` falls back to the `dot` glyph (ui.jsx behavior) — keep
  tolerant.
- `counts` uses distinct task keys, but the "Active deployments" panel counts **engagements**
  (a profile can appear twice on one task in theory) — mock data never exercises that; keep both
  as-is.

**Error states (real app additions, no mock equivalent)**

- Create/edit action failure → inline error in the modal foot (reuse `foot-hint err`), keep the
  modal open with entered values.
- Delete failure (e.g. RBAC) → surface as toast/dialog per house pattern; profile stays.
- Loader failure → route error boundary per shell conventions.

---

## 8. Open questions

1. **Profile storage location & scope.** BUILD-PLAN's data root lists a top-level `agents/` dir,
   the mock's copy says "global base, customized for Viberr Core", `scope` strings distinguish
   "Global base · …" from "Created in Viberr Core", and org-settings has its own "agent profiles"
   admin. Is a profile org-global with per-project overrides (two layers), or per-project flat?
   The delete-confirm copy ("The global base definition is unaffected.") implies delete only
   removes the *project* approval. Phase 9 must pick one model and document it; the UI copy
   should stay verbatim either way.
2. **RBAC for this surface.** Who may create/edit/delete profiles? Mock has no gating (any
   signed-in user). Policy RBAC table has "Edit workflow & policy" = admin-only — capability
   policy plausibly falls under it. Confirm whether New/Edit/Delete buttons hide or disable for
   non-admins.
3. **Capability catalog vs. seeded labels.** Should the seed profiles be normalized onto catalog
   ids (changing some rendered strings, e.g. "Run the validation suite" → "Run validation
   suites"), or preserved verbatim as extras? Preserving verbatim keeps pixel/string parity with
   the mock; normalizing makes the matrix modal's "Other actions" group much smaller and the
   policy machine-enforceable. Recommendation: id-normalize where labels match exactly, keep the
   rest as display-only extras, and get product sign-off on the near-miss trio.
4. **Live deployment truth source.** Should Live rows derive purely from task projections (as the
   mock does) or from Phase 8's runtime session records (`runtimes/` NDJSON / runs table), which
   also know about finished sessions? The mock's `runs.jsx` surface handles per-task runtime
   streams separately, so keeping this view projection-derived (assignments + waiting) is the
   1:1 port; confirm with Phase 8.
5. **`readiness`-style enum mapping.** Deployment status strings (`packet open`, etc.) are pure
   presentation in the mock. Define the real enum (e.g. `coordinating | packet_open | working |
   waiting_on_human | on_call | anchored`) in schemas, map to display strings in one place.
6. **Does profile edit/delete emit an SSE event?** Other clients viewing the Agents page should
   see roster changes; propose `project.agents-updated` or reuse `projection.rebuilt`.
