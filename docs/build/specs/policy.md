# Porting spec — Policy view

Source: `design/html-app/app/policy.jsx` (213 lines) plus the shared `CapabilityMatrixModal` defined in `design/html-app/app/agents.jsx` (lines 531–596), which the Policy view renders. Shared primitives come from `design/html-app/app/ui.jsx`; data from `design/html-app/app/data.js`. The porting engineer is expected to work from this document alone.

---

## 1. Purpose & entry points

The Policy screen is the governance surface for a project ("Viberr Core"). It shows — and lets authorized humans edit — **two deliberately separate policy surfaces** plus the workflow boundary rules:

1. **Human access (RBAC)** — project members, their role (Admin / Maintainer / Reviewer / Viewer), and a read-only action×role grant table.
2. **Agent capability** — read-only summary of every agent profile's capability policy (direct / recommend / human-reserved action counts), the globally human-reserved actions, and a full capability matrix modal.
3. **Workflow rules** — the stage flow and, per stage transition, an editable automation boundary: Auto-advance / Human approval / Human only. `Review → Done` is hard-locked to Human only.

### Entry points (mock)

- Hash route `#policy`. In `main.jsx` the initial view is parsed from `location.hash` via `/^#(board|review|agents|policy|github|activity|settings)$/`; nav item is `{ id: "policy", label: "Policy", icon: "shield" }` in the left rail. Note: the mock **reads** the hash on load but never writes it back on navigation — in the real app this becomes a proper route (e.g. `/projects/:key/policy`).
- Mounted in `main.jsx` as `<Policy tasks={tasks} onNav={goView} push={push} />`. `tasks` is passed but **never used** inside Policy — drop it in the port.
- Inbound cross-links from other screens (all call `onNav("policy")` / `onPolicy`):
  - `settings.jsx` Stages panel: "Who may move tasks between stages is set in **Policy → Workflow rules**" (a `.keybtn` inline button).
  - `settings.jsx` Members panel: "New members join as Viewer. Roles are managed in **Policy → Human access**".
  - `profile.jsx`: "Your role is assigned by an admin and enforced on every governed action. Changes go through **Policy → Human access**".
  - `review.jsx` Review queue header: a clickable `.hero-file` chip with title "Review → Done is locked to humans — see Policy".
  - `task.jsx` `PolicyPanel` inside the task workspace (its `onPolicy` closes the task and switches to policy view).
- Outbound navigation from Policy: `onNav("agents")` only (clicking a profile row or "Manage profiles"). Policy does **not** link to Settings in the mock; the GitHub credential/scope violation UI lives in `settings.jsx`/`github.jsx`, not here (see Open questions).

The mock has no per-view authorization gate: any signed-in user can flip roles and boundaries. Per the RBAC table itself, only **Admin** has "Edit workflow & policy" and "Manage members & roles" — the real app must enforce this in the action layer and should render the controls disabled/read-only for non-admins.

---

## 2. Component tree

```
Policy (root; data-screen-label="Policy")
├── header block (.board-head): h1, subtitle, "last change" chip, Capability matrix button
├── .policy-wrap
│   ├── .policy-cols  (2-col grid, collapses to 1 col on narrow screens)
│   │   ├── HumanAccess        — members list with role picker + RBAC grant table + two notes
│   │   └── AgentCapability    — profile capability summary rows + human-reserved list + actions
│   └── WorkflowRules          — stage flow map + per-transition boundary segmented controls
└── CapabilityMatrixModal      — (conditional) wide modal, action × profile matrix  [defined in agents.jsx]
```

One-liners:

- **`Policy({ tasks, onNav, push })`** — root; reads `window.VIBERR.policy` / `.agents` / `.stages`; owns local `roles`, `bounds`, `matrixOpen` state; implements the last-admin guard and toast messaging.
- **`HumanAccess({ P, roles, setRole })`** — "Human access · RBAC" panel: member rows with a 4-way role segmented radiogroup, then a scrollable action×role grant table whose column headers include live member counts per role.
- **`AgentCapability({ profiles, onNav, onMatrix })`** — "Agent capability" panel: one clickable row per profile (operator first) showing direct/recommend/human action counts as colored-dot stats; an "Always reserved for humans" list; footer buttons to open the matrix or go to Agents.
- **`WorkflowRules({ P, stages, bounds, setBound })`** — "Workflow rules" panel: horizontal stage-chip flow map, then one row per transition rule with a 3-option boundary segmented control (`cap-seg`), locked styling for `review→done`.
- **`CapabilityMatrixModal({ profiles, onClose })`** — shared with the Agents screen. Renders `CAP_CATALOG` groups as an action × profile dot-matrix with sticky header row and sticky first column; actions not in the catalog are collected into an "Other actions" group.

Shared primitives used (from `ui.jsx`): `Icon` (inline stroke SVG by name; used names here: `user`, `board`, `message`, `agents`, `shield`, `lock`, `arrow`, `clock`, `check`, `x`), `Avatar` (initials chip, tone class), `Pill` (`<span class="pill risk sm">`). `TglP`, `Identity`, `AgentGlyph` etc. are **not** used by this screen (note: `policy.jsx` line 213 re-exports `TglP` on `window` as a leftover of it moving to `ui.jsx` — ignore in port). Toasts come from `useToasts()` in the app root; Policy only calls the passed-in `push(text)`.

---

## 3. Data consumed (exact shapes + real-app source)

### 3.1 `window.VIBERR.policy` (mock `data.js` `POLICY`)

Only these four keys are read by this screen. (`POLICY.repo`, `.guardrails`, `.events` exist but are consumed by `settings.jsx`, `github.jsx`, `activity.jsx` — do not pull them into this route.)

```js
edited: { by: "Elif Demir", t: "Mar 30" }          // last-change attribution chip
members: [                                          // project members with role
  { p: { kind:"human", name:"Elif Demir",  initials:"ED", tone:"rose"   }, role:"admin",      email:"elif@viberr.dev",  status:"active" },
  { p: { kind:"human", name:"Arda Kaya",   initials:"AK", tone:""       }, role:"admin",      email:"arda@viberr.dev",  status:"active" },
  { p: { kind:"human", name:"Murat Yıldız",initials:"MY", tone:"teal"   }, role:"maintainer", email:"murat@viberr.dev", status:"active" },
  { p: { kind:"human", name:"Selin Aksoy", initials:"SA", tone:"violet" }, role:"reviewer",   email:"selin@viberr.dev", status:"active" },
]
rbac: [ { action: string, grant: { admin:0|1, maintainer:0|1, reviewer:0|1, viewer:0|1 } }, ... ]
transitions: [ { from: stageId, to: stageId, by: string, boundary: "auto"|"approval"|"human", locked?: true }, ... ]
```

The exact 9 RBAC rows (this table is **display-only** in the UI; treat it as the canonical permission catalog):

| action | admin | maintainer | reviewer | viewer |
|---|---|---|---|---|
| View board, tasks & timelines | 1 | 1 | 1 | 1 |
| Comment on tasks (app-wide) | 1 | 1 | 1 | 1 |
| Take / release task ownership | 1 | 1 | 1 | 1 |
| Release any task owner | 1 | 0 | 0 | 0 |
| Approve stage transitions | 1 | 1 | 0 | 0 |
| Accept completion → Done | 1 | 1 | 0 | 0 |
| Open agent runtime sessions | 1 | 1 | 0 | 0 |
| Manage members & roles | 1 | 0 | 0 | 0 |
| Edit workflow & policy | 1 | 0 | 0 | 0 |

The exact 4 transition rules:

```js
{ from:"triage", to:"ready",  by:"Human, after the quality gate — agents may flag underspecified tasks", boundary:"approval" }
{ from:"ready",  to:"impl",   by:"Operator, when a primary specialist is assigned",                      boundary:"auto" }
{ from:"impl",   to:"review", by:"Operator transition request, with evidence attached",                  boundary:"approval" }
{ from:"review", to:"done",   by:"Human acceptance of the completion report",                            boundary:"human", locked:true }
```

**Real-app source:** members + roles from SQLite (users/memberships tables, Phase 2 auth work) via the route loader; the RBAC grant catalog is static application policy (constant or seeded table — it is not editable in the UI); transition boundaries belong to the project's file-native policy (mock runtime logs reference a `.viberr/policy/` directory — e.g. `rg 'compression-threshold' .viberr/policy/`), projected into SQLite for querying. `edited` = last policy-change audit event (by, timestamp) from the timeline/audit projection, not a stored blob field.

### 3.2 `window.VIBERR.agents` (mock `AGENTS`)

Policy builds `profiles = [A.operator, ...A.profiles]` (operator always first). Fields read here: `id`, `kind` (`"operator" | "specialist"`), `name`, `role`, `icon`, `actions.direct[]`, `actions.recommend[]`, `actions.forbidden[]`. (Other profile fields — `backends`, `model`, `scope`, `desc`, `stages`, `spanAll`, `resources` — are Agents-screen concerns.)

The five profiles and their action-bucket sizes (drives the per-row counts):

| profile | icon | role | direct | recommend | forbidden |
|---|---|---|---|---|---|
| Operator (`kind:"operator"`) | shield | Task coordinator | 5 | 3 | 3 |
| Developer | branch | Implementation | 4 | 2 | 3 |
| Reviewer | check | Code review | 4 | 2 | 3 |
| Tester | bolt | Validation | 3 | 2 | 2 |
| Consultant | message | Advisory | 2 | 1 | 3 |

Action strings are free-text labels, e.g. Operator direct = `["Assign the primary specialist", "Summon consultant specialists", "Generate decision & blocking packets", "Append typed important events", "Compress long-running timelines"]`; every specialist's `forbidden` includes `"Merge a pull request"` and `"Transition a task to Done"`.

**Real-app source:** agent profile records (file-native profile definitions projected to SQLite; global base + per-project overrides per FR8/FR9). The Policy screen needs only a lightweight projection: id, kind, name, role, icon, and the three action-label arrays.

### 3.3 `window.VIBERR.stages` (mock `STAGES`)

```js
[ { id:"triage", name:"Triage",      color:"#a5a8b5" },
  { id:"ready",  name:"Ready",       color:"#187574" },
  { id:"impl",   name:"In Progress", color:"#7b61ff" },
  { id:"review", name:"Review",      color:"#5b76fe" },
  { id:"done",   name:"Done",        color:"#00b473" } ]
```

Used for the flow map and to resolve transition endpoint names/colors (`S(id)` falls back to `{}` if missing — keep that defensive lookup; stages are user-editable in Settings, so a transition referencing a renamed/missing stage must not crash). **Real-app source:** project workflow config (Settings screen mutates it), same store the Board reads.

### 3.4 Matrix catalog (`CAP_CATALOG`, in `agents.jsx`)

The modal groups matrix rows by this catalog (id → label → default mode). Three groups:

- **Repository & execution:** Read the task & repository (direct), Comment on the task (direct), Create the task-key branch (direct), Commit & push to the branch (direct), Open the review pull request (recommend), Edit another task's branch (human).
- **Validation & review:** Run validation suites (direct), Author test cases (direct), Attach evidence references (direct), Post quality-flag events (direct), Report a validation verdict (recommend), Approve the review (recommend), Request changes (recommend), Flag underspecified tasks (recommend).
- **Workflow & approvals:** Move the task to Review (recommend), Merge a pull request (human), Transition a task to Done (human), Change project policy (human).

Any action label a profile declares that is **not** in the catalog is appended under a synthetic group **"Other actions"** (in the mock, all 8 Operator-specific actions plus specialist extras like "Validation verdict", "Hold the task on failing checks", "Write to the repository", "Open or merge a PR", "Any stage transition" land here). Matching is by exact label string.

### 3.5 Session / env

Nothing directly. The mock's session (`localStorage viberr:session`) only gates app entry in `main.jsx`. In the real app the loader needs the session user to compute *their* role (to disable editing for non-admins) — mock computes `myRole` in the root but never passes it to Policy.

---

## 4. UI states & interactions

### 4.1 Page header

```jsx
<div className="board-wrap" data-screen-label="Policy">
  <div className="board-head">
    <div>
      <h1>Policy</h1>
      <div className="sub">Human access and agent capability — two surfaces, managed separately</div>
    </div>
    <div className="board-tools">
      <span className="hero-file"><Icon name="clock" />last change · {P.edited.by} · {P.edited.t}</span>
      <button className="btn ghost sm" onClick={() => setMatrixOpen(true)}><Icon name="shield" />Capability matrix</button>
    </div>
  </div>
  ...
```

- "last change · Elif Demir · Mar 30" is a static chip (not a button).
- "Capability matrix" appears **twice** (header + AgentCapability footer); both open the same modal.

### 4.2 HumanAccess panel

Panel head: `user` icon, `<h2>Human access · RBAC</h2>`, right-aligned count "`{P.members.length} members`" (styled `fontSize:.76rem; color:var(--faint)`).

Intro note (`.pol-note`, `board` icon): *"Roles decide what each member may approve, accept, and configure — enforced on every project and task action."*

**Member rows** — verbatim:

```jsx
<div className="member-row" key={m.p.name}>
  <Avatar person={m.p} />
  <span className="member-main">
    <div className="nm">{m.p.name}</div>
    <div className="em">{m.email}</div>
  </span>
  <div className="mini-seg" role="radiogroup" aria-label={"Role for " + m.p.name}>
    {ROLE_IDS.map((r) => (
      <button type="button" key={r} className={roles[m.p.name] === r ? "on" : ""}
              onClick={() => setRole(m, r)}>{ROLE_LABEL[r]}</button>
    ))}
  </div>
</div>
```

- `ROLE_IDS = ["admin","maintainer","reviewer","viewer"]`; `ROLE_LABEL = { admin:"Admin", maintainer:"Maintainer", reviewer:"Reviewer", viewer:"Viewer" }`.
- Selected role button gets class `on` (solid `--fg` background, inverted text).
- A11y gap to fix in port: the container claims `radiogroup` but children are plain buttons — give them `role="radio"` + `aria-checked`, arrow-key movement per WAI-ARIA radio pattern (mock has no keyboard handling beyond native button focus/Enter).

**Role change behavior (`setRole(m, r)` in root):**

1. No-op if the member already has role `r`.
2. **Last-admin guard:** if the member is currently `admin` and `r !== "admin"`, count members whose *current live* role is admin; if `<= 1`, abort with toast **"Viberr Core needs at least one admin — promote someone else first"** (no state change).
3. Otherwise update `roles` map and toast **"`{FirstName}` is now `{RoleLabel}` · enforced on the next action"** (first name = `name.split(" ")[0]`).

**RBAC table** — verbatim structure:

```jsx
<div className="rbac-scroll">
  <table className="rbac-table">
    <thead>
      <tr>
        <th>Action</th>
        {ROLE_IDS.map((r) => <th key={r}>{ROLE_LABEL[r]} · {counts[r]}</th>)}
      </tr>
    </thead>
    <tbody>
      {P.rbac.map((row) => (
        <tr key={row.action}>
          <td className="act">{row.action}</td>
          {ROLE_IDS.map((r) => (
            <td key={r}>{row.grant[r]
              ? <span className="rbac-yes"><Icon name="check" /></span>
              : <span className="rbac-no">—</span>}</td>
          ))}
        </tr>
      ))}
    </tbody>
  </table>
</div>
```

- Column headers embed **live member counts per role** ("Admin · 2", "Maintainer · 1"…), recomputed via `useMemo` over the local `roles` state — flipping a member's role immediately updates the header counts. Preserve this coupling in the port.
- Grant cells are purely informational; there is no editing of the grant matrix anywhere.

Footer note (`.pol-note`, `message` icon, `marginTop:.85rem`) — exact copy including the bolded segments:

> Rules that reach beyond project roles: **commenting is app-wide** — every registered user may comment on any task; any project member may **take or release task ownership** (the owner is the task's human reviewer and acceptance authority, scoped to that task); and **admins may release any owner** — recorded in the audit trail.

### 4.3 AgentCapability panel

Panel head: `agents` icon, `<h2>Agent capability</h2>`, right count "`{profiles.length} profiles`" (= 5 in mock).

Intro note (`shield` icon): *"Agents never hold human roles. What an agent may do comes only from its profile's capability policy — act directly, recommend, or stay out."*

**Profile rows** — each is a full-width `<button>`, verbatim:

```jsx
<button type="button" className="pcap-row" key={p.id} onClick={() => onNav("agents")}
        title={"Open " + p.name + " in Agents"}>
  <span className={"agent-glyph" + (p.kind === "operator" ? " op" : "")}><Icon name={p.icon} /></span>
  <span className="pcap-main">
    <span className="nm">{p.name}</span>
    <span className="sub">{p.role}</span>
  </span>
  <span className="pcap-counts">
    <span className="cs"><span className="d" style={{ background: "var(--teal-dark)" }}></span>{p.actions.direct.length} direct</span>
    <span className="cs"><span className="d" style={{ background: "var(--blue)" }}></span>{p.actions.recommend.length} recommend</span>
    <span className="cs"><span className="d" style={{ background: "var(--coral-dark)" }}></span>{p.actions.forbidden.length} human</span>
  </span>
</button>
```

- Note the count vocabulary: the `forbidden` bucket is rendered as "**human**" (e.g. "3 human"), matching the tri-color legend used everywhere (teal-dark = direct, blue = recommend, coral-dark = human-reserved).
- Clicking any row navigates to the Agents view (mock does not deep-link to the specific profile; real app should route to the profile, e.g. `/agents#developer` or `/agents/:id` — see Open questions).

**Human-reserved block:**

```jsx
<div className="human-only">
  <div className="flabel" style={{ color: "var(--coral-dark)" }}>Always reserved for humans</div>
  {["Merge a pull request", "Transition a task to Done", "Change project policy"].map((x) => (
    <div className="ho-row" key={x}><Icon name="lock" /><span>{x}</span><Pill kind="risk" sm>all profiles</Pill></div>
  ))}
</div>
```

- The three items are **hard-coded in the JSX**, not derived from the profiles (although every profile's `forbidden` list happens to agree). Port decision: derive from the server-side invariant list rather than duplicating strings (see Open questions).
- `Pill kind="risk" sm` renders `<span class="pill risk sm">all profiles</span>`.

**Footer actions:**

```jsx
<div className="pol-actions">
  <button className="btn ghost sm" onClick={onMatrix}><Icon name="shield" />Capability matrix</button>
  <button className="btn sm" onClick={() => onNav("agents")}><Icon name="agents" />Manage profiles</button>
</div>
```

### 4.4 WorkflowRules panel

Panel head: `board` icon, `<h2>Workflow rules</h2>`, right count "`{stages.length} stages · {P.transitions.length} transition rules`" ("5 stages · 4 transition rules").

**Flow map** — stage chips joined by arrow icons:

```jsx
<div className="flow-map">
  {stages.map((s, i) => (
    <React.Fragment key={s.id}>
      {i > 0 && <span className="flow-arr"><Icon name="arrow" /></span>}
      <span className="stage-chip elig"><span className="sdot" style={{ background: s.color }}></span>{s.name}</span>
    </React.Fragment>
  ))}
</div>
```

**Transition rows** — verbatim (this is the trickiest markup on the screen):

```jsx
{P.transitions.map((t) => {
  const k = t.from + ">" + t.to, f = S(t.from), o = S(t.to);
  return (
    <div className="trans-row" key={k}>
      <span className="trans-path">
        <span className="sdot" style={{ background: f.color }}></span>{f.name}
        <Icon name="arrow" />
        <span className="sdot" style={{ background: o.color }}></span>{o.name}
      </span>
      <span className="trans-by">{t.by}</span>
      <div className={"cap-seg" + (t.locked ? " locked" : "")}
           title={t.locked ? "Completion is human-authorized in V1 — this boundary can't be delegated" : undefined}>
        {BOUNDARIES.map((b) => (
          <button type="button" key={b.id} className={BCLS[b.id] + (bounds[k] === b.id ? " on" : "")}
                  onClick={() => setBound(t, b.id)}>{b.label}</button>
        ))}
      </div>
      {t.locked && <span className="trans-lock"><Icon name="lock" />locked · V1</span>}
    </div>
  );
})}
```

- `BOUNDARIES = [ {id:"auto", label:"Auto-advance"}, {id:"approval", label:"Human approval"}, {id:"human", label:"Human only"} ]`.
- `BCLS = { auto:"direct", approval:"recommend", human:"human" }` — i.e. the button *CSS class* reuses the capability color language: Auto-advance selected → `direct on` (teal), Human approval → `recommend on` (blue), Human only → `human on` (red). Class names are the contract; keep this mapping exactly.
- Transition key format `"from>to"` (e.g. `"impl>review"`) is used for the `bounds` state map.
- **Locked row (`review>done`):** container gets `cap-seg locked`; the CSS rule `.cap-seg.locked { opacity:.55; pointer-events:none; }` is the *only* enforcement in the mock — there is **no JS guard** in `setBound`. A keyboard user could still activate the buttons in the mock. The port must (a) add `disabled` on the buttons and (b) reject the mutation server-side.
- Tooltip on the locked control (container `title`): **"Completion is human-authorized in V1 — this boundary can't be delegated"**. Adjacent badge text: **"locked · V1"** with a `lock` icon.

**Boundary change behavior (`setBound(t, b)` in root):** no-op if unchanged; else update `bounds[k]` and toast **"`{FromStage}` → `{ToStage}`: `{boundary label lowercased}` · applies to future transitions"** (e.g. "In Progress → Review: auto-advance · applies to future transitions"). Note it resolves stage display names via `stages.find(...).name` — this will throw if a stage id is missing (unlike `S()` in the child); harden in the port.

Footer note (`lock` icon): *"Only a human can accept completion. Operators request **Review → Done**; a human accepts it — no agent profile can be granted this boundary."*

### 4.5 CapabilityMatrixModal (shared, from `agents.jsx`)

Opened by either "Capability matrix" button (`matrixOpen` boolean). Rendered as a sibling of the page content:

```jsx
{matrixOpen && <CapabilityMatrixModal profiles={profiles} onClose={() => setMatrixOpen(false)} />}
```

Structure — verbatim (abridged only where repetitive):

```jsx
<React.Fragment>
  <div className="confirm-scrim" onClick={onClose} />
  <div className="modal-card modal-wide" role="dialog" aria-label="Capability matrix">
    <div className="modal-head">
      <span className="agent-glyph lg"><Icon name="shield" /></span>
      <div className="mh-main">
        <h2>Capability matrix</h2>
        <div className="mh-sub">Every profile's permissions for each action in Viberr Core.</div>
      </div>
      <button className="icon-btn modal-close" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
    </div>
    <div className="mx-legend">
      <span className="lg"><span className="d" style={{ background: "var(--teal-dark)" }} />Acts directly</span>
      <span className="lg"><span className="d" style={{ background: "var(--blue)" }} />Recommends</span>
      <span className="lg"><span className="d" style={{ background: "var(--coral-dark)" }} />Reserved for humans</span>
      <span className="lg"><span className="d" style={{ background: "var(--ring)" }} />Not granted</span>
    </div>
    <div className="modal-body">
      <div className="mx-scroll">
        <table className="cap-matrix-table">
          <thead>
            <tr>
              <th className="corner">Action</th>
              {profiles.map((p) => (
                <th key={p.id}><div className="mx-col"><span className={"agent-glyph" + (p.kind === "operator" ? " op" : "")}><Icon name={p.icon} /></span>{p.name}</div></th>
              ))}
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <React.Fragment key={g.group}>
                <tr className="grp"><td colSpan={profiles.length + 1}>{g.group}</td></tr>
                {g.labels.map((label) => (
                  <tr key={label}>
                    <td className="rowlabel">{label}</td>
                    {profiles.map((p) => {
                      const m = modeOf(p, label);
                      return <td key={p.id}><span className={"mx-cell " + m} title={m === "off" ? "Not granted" : m === "human" ? "Reserved for humans" : m === "recommend" ? "Recommends" : "Acts directly"}><span className="d" /></span></td>;
                    })}
                  </tr>
                ))}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  </div>
</React.Fragment>
```

Behavior details:

- `modeOf(p,label)` precedence: `direct` → `recommend` → `forbidden`("human") → `"off"`. Cell class is `mx-cell direct|recommend|human|off`; cell `title` gives the accessible label ("Acts directly" / "Recommends" / "Reserved for humans" / "Not granted").
- Row groups: the three `CAP_CATALOG` groups in order, then "Other actions" appended **only if** any profile declares a label outside the catalog (always true in mock data because of the Operator).
- Sticky rendering is pure CSS: `thead th` sticky-top, `td.rowlabel` and `th.corner` sticky-left, group rows sticky-left with uppercase micro-label styling; whole table scrolls inside `.mx-scroll` (both axes).
- Close paths: scrim click, X button. **No Escape handler and no focus trap in the mock** (unlike `PageOverlay` in `ui.jsx`, which does bind Escape). Port should add Escape + `aria-modal="true"` + focus management.
- When opened from Policy, `profiles` is the static `[operator, ...profiles]` from data. When opened from the Agents screen, it receives the live-edited list — the ported component must stay presentation-only and take profiles as a prop.

### 4.6 Toasts

All three mutations surface via the shared toast system (`useToasts` in `ui.jsx`: 2.6 s auto-dismiss, rendered in `.toast-wrap[role=status][aria-live=polite]`, each toast is a check-icon + text). Exact strings:

| Trigger | Toast |
|---|---|
| Role changed | `{FirstName} is now {Admin|Maintainer|Reviewer|Viewer} · enforced on the next action` |
| Demoting the only admin (blocked) | `Viberr Core needs at least one admin — promote someone else first` |
| Boundary changed | `{From} → {To}: {auto-advance|human approval|human only} · applies to future transitions` |

Note the project name "Viberr Core" is hard-coded inside the guard toast — parameterize by project in the port.

### 4.7 Keyboard / a11y inventory

- Role picker: `role="radiogroup"` + `aria-label="Role for {name}"`; children need proper radio semantics (mock gap).
- Boundary picker (`cap-seg`): no group role/label in mock — add `role="radiogroup"` `aria-label` like `"Boundary for {From} → {To}"` in the port, and `disabled`/`aria-disabled` on locked rows.
- Matrix modal: `role="dialog" aria-label="Capability matrix"`; add `aria-modal`, Escape, focus trap.
- All icons are `aria-hidden="true"` (built into `Icon`).
- The matrix cell meaning is conveyed by color + `title` only; the port can keep this (title text is the accessible name) but consider `aria-label` on the cell span.

---

## 5. Events / mutations produced

The mock keeps everything in component state (lost on refresh). The real app needs these actions:

1. **`updateMemberRole(projectId, userId, role)`**
   - Guards (server-side, mirrored client-side): actor must hold "Manage members & roles" (admin); reject demoting the last admin with the same message semantics as the toast; no-op if unchanged.
   - Persists to the membership table; must take effect "on the next action" (i.e. permission checks read live role — no session-cached role).
   - Writes a **typed policy/audit event** to the project stream. Mock `POLICY.events` shows the expected shape/kind vocabulary — role/policy edits appear as `{ kind:"change", t, text }` entries (e.g. *"Human RBAC and agent capability split into separate policy surfaces"*), consumed by the Activity screen. Suggested event: kind `policy.role_changed` with actor, subject user, old→new role.

2. **`updateTransitionBoundary(projectId, from, to, boundary)`**
   - Guards: actor must hold "Edit workflow & policy"; **hard-reject any change to `review→done`** (locked invariant "Completion is human-authorized in V1"); validate `boundary ∈ {auto, approval, human}` and that `from`/`to` are adjacent stages in the project workflow.
   - Persists to the file-native project policy (`.viberr/policy/…`) and refreshes the SQLite projection; "applies to future transitions" — must not retro-affect in-flight transition requests.
   - Writes a typed policy event, matching the mock's audit example *"Elif locked **Review → Done** to human-only acceptance."* → kind `policy.boundary_changed` with from/to/boundary/actor.

3. **Read-only derived data** (no mutation): `edited` chip should be derived from the latest policy event; RBAC header counts derived per render from members.

Enforcement side (not UI work, but this screen documents the contract the engine must honor): boundary `auto` lets the operator advance the transition directly; `approval` requires a human approval of an operator transition request; `human` means only a human can perform it. Blocked agent attempts surface elsewhere as `POLICY.events` kind `blockedact` (e.g. *"Blocked: Developer (Codex) attempted **Merge a pull request** — reserved for humans"*) and as Policy-engine notifications — the Policy screen itself does not render them.

---

## 6. CSS classes used (contract)

Ported verbatim from `design/html-app/app/viberr.css`. Structural classes this screen depends on:

- **Page scaffold:** `board-wrap` (+ `data-screen-label="Policy"`), `board-head`, `sub`, `board-tools`, `hero-file`, `btn`, `btn ghost sm`, `btn sm`, `policy-wrap`, `policy-cols` (2-col grid; media query collapses to 1 col — see `.policy-cols { grid-template-columns: 1fr; }` in the narrow breakpoint), `panel`, `panel-head`, `right sub`.
- **Notes:** `pol-note` (icon + text callout; `strong` children get `--fg` color), `pol-actions` (flex footer, buttons `flex:1`).
- **Members / RBAC:** `member-list`, `member-row` (flex, hairline separators, wraps), `member-main` with `nm` / `em`, `avatar` (+ tone class from person), `mini-seg` (+ child button `.on` = solid fg), `rbac-scroll` (`overflow-x:auto` — the table must scroll inside it, never the page), `rbac-table`, `td.act`, `rbac-yes` (teal check chip), `rbac-no` (`--ring` dash).
- **Agent capability:** `pcap-list`, `pcap-row` (button; hover lifts via `translateY(-1px)` + border), `agent-glyph` (+ `op` modifier for the operator), `pcap-main` (`nm`/`sub`), `pcap-counts` with `cs` stat spans and `d` color dots, `human-only`, `flabel`, `ho-row`, `pill risk sm`.
- **Workflow rules:** `flow-map`, `flow-arr`, `stage-chip elig`, `sdot` (stage color dot — inline `background` style from stage data), `trans-list`, `trans-row`, `trans-path`, `trans-by`, `trans-lock`, `cap-seg` (+ `locked` modifier = `opacity:.55; pointer-events:none`), cap-seg button classes **`direct` / `recommend` / `human`** with `on` modifier (`direct.on` teal-light/teal-dark, `recommend.on` blue-soft/blue-pressed, `human.on` red-light/coral-dark).
- **Matrix modal:** `confirm-scrim`, `modal-card modal-wide` (`min(1060px, calc(100vw - 2rem))`), `modal-head`, `mh-main`, `mh-sub`, `icon-btn modal-close`, `mx-legend` (`lg` + `d`), `modal-body`, `mx-scroll` (bordered, both-axis scroll), `cap-matrix-table` (sticky `thead th`, `th.corner` z-3, `td.rowlabel` sticky-left min-width 230px, `tr.grp td` uppercase group band), `mx-col`, `mx-cell direct|recommend|human|off` with inner `d` dot.
- **Shared:** `ico` (on every `Icon`), `toast-wrap`/`toast` (host lives in app root).

Color tokens referenced inline (keep as CSS vars, never hex): `--teal-dark`, `--blue`, `--coral-dark`, `--ring`, `--faint`. Stage dot colors are the only raw hex on this screen and they come from stage **data**, not CSS.

---

## 7. Porting notes

- **Prototype state → real persistence.** `roles`, `bounds`, `matrixOpen` are `useState` seeded from globals; role/boundary edits vanish on refresh. Replace with loader data + fetcher-backed actions (optimistic UI is fine; the toast copy already says "enforced on the next action" / "applies to future transitions", which matches eventual server confirmation).
- **`window.VIBERR.*` globals → loader.** `P = window.VIBERR.policy`, `A = window.VIBERR.agents`, `stages = window.VIBERR.stages` become one loader returning `{ edited, members, rbacCatalog, transitions, profiles, stages, myRole }`.
- **Member identity is keyed by display name** (`roles[m.p.name]`, React `key={m.p.name}`) — replace with stable user ids throughout; two members with the same name would collide in the mock.
- **Transition identity is `"from>to"` string** — fine to keep as a composite key, but the action should take explicit `from`/`to` ids.
- **Locked boundary is CSS-only** (`pointer-events:none`); add real `disabled` attributes and a server-side invariant. Keep the `title` tooltip text and the "locked · V1" badge verbatim.
- **`setBound`'s stage-name lookup** (`stages.find(...).name`) crashes on unknown ids while `WorkflowRules.S()` is defensive — normalize to defensive lookups; stages are editable in Settings so ids can drift in future data.
- **`tasks` prop is dead** — remove. Likewise `Object.assign(window, { Policy, TglP })` is prototype wiring (and `TglP` isn't even used here); components become module exports.
- **Hard-coded strings to parameterize:** project name "Viberr Core" in the last-admin toast and in the matrix subtitle "Every profile's permissions for each action in Viberr Core."; the three "Always reserved for humans" items should come from the server-side invariant list (they duplicate every profile's forbidden set today).
- **`CapabilityMatrixModal` is shared with the Agents screen** — port it once (it lives in `agents.jsx` in the mock) as a presentational component taking `profiles`; both routes render it. Its `CAP_CATALOG`/`CAP_LABEL` constants belong with the agent-profile domain module, not the Policy route.
- **Matrix matching is by exact label string.** In the real app capability grants should be id-based (the catalog already has ids: `read`, `commit`, `merge`, `done`, `policy`, …) with labels only for display; preserve the "Other actions" fallback for free-text/custom actions.
- **A11y upgrades** (mock gaps): radio semantics on `mini-seg`, group semantics + disabled state on `cap-seg`, Escape/focus-trap/`aria-modal` on the matrix modal.
- **RBAC header counts must track live roles** — derive from the same members array the role picker mutates, not a separate cached count.
- **Boundary↔class mapping** (`BCLS`: auto→`direct`, approval→`recommend`, human→`human`) is deliberate visual language reuse; do not "fix" it to semantic class names.
- **Empty/error states (undefined in mock — define in port):**
  - Zero members can't happen (last-admin guard + you must be a member to view), but render the member list defensively.
  - Zero agent profiles: the operator always exists (system role), so `profiles.length >= 1`; if specialists list is empty, the panel still renders operator + human-only block + actions.
  - Missing stage referenced by a transition: render the row with an unnamed/uncolored dot rather than crashing (mock's `S()` fallback behavior).
  - Action failures (role change, boundary change): surface the server error as a toast and roll back optimistic state; the mock has no failure path.
- **Responsive:** `policy-cols` collapses to one column on narrow viewports (CSS already handles it); `rbac-scroll` and `mx-scroll` own horizontal overflow — verify the page body never scrolls horizontally.
- **`data-screen-label`** attributes are used by the mock's screenshot tooling; harmless to keep, not required.

---

## 8. Open questions

1. **Where do transition boundaries live canonically?** The runtime mock hints at `.viberr/policy/` files; confirm the file format/name for workflow boundary rules and whether the SQLite side is a pure projection (edit file → project) or the write path goes DB-first with file export.
2. **Non-admin rendering:** should Reviewer/Viewer see the Policy screen read-only (controls disabled), or hidden entirely? The mock renders it fully editable for everyone. Recommendation: visible read-only with disabled controls, since the RBAC table doubles as documentation.
3. **Profile deep-linking:** `pcap-row` click goes to the Agents view generically (`onNav("agents")`, title says "Open {name} in Agents"). Should the port deep-link to the specific profile (route param / anchor)? Recommendation: yes.
4. **"Always reserved for humans" source of truth:** hard-coded 3-item list vs. computed intersection of all profiles' `forbidden` vs. a server invariant list. Recommendation: server invariant list (it also backs the policy engine's blocked-action events).
5. **`edited` provenance:** mock shows a single `{by, t}`. Should it link to the Activity view filtered to policy events?
6. **Settings overlap:** Settings has its own Members panel (add/remove, with its own last-admin guard toast "…is the only admin — assign another admin in Policy first") while Policy owns roles. Confirm the real app keeps this split (Settings = membership CRUD, Policy = role assignment) and that both write to the same membership store so the cross-links stay truthful. Also confirm whether Policy should gain a link **to** Settings for the GitHub credential violation surface (the FOCUS mentions settings links; in the mock the violation lives in Settings/GitHub and the rail badge on the Settings nav item, not here).
7. **RBAC catalog mutability:** the grant table is display-only. Is it ever project-configurable in V1, or a fixed application-level catalog? Spec assumes fixed.
8. **Boundary vocabulary vs. agent capability:** boundaries reuse the direct/recommend/human color classes. Confirm the engine treats `auto` as "operator may act directly" and `approval` as "operator may only raise a transition-request packet" — that's what the transitions' `by` copy and the notifications data imply (e.g. approval notification *"This boundary needs a maintainer approval."*).
