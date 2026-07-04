# Spec: Project Settings view (`design/html-app/app/settings.jsx` → `app/features/project-admin/`)

Source of truth: `design/html-app/app/settings.jsx` (307 lines), shared primitives in
`design/html-app/app/ui.jsx`, data shapes in `design/html-app/app/data.js` (`STAGES`, `POLICY`),
host wiring in `design/html-app/app/main.jsx`. CSS contract: `design/html-app/app/viberr.css`
(ported verbatim — **class names are the contract**, do not rename or replace with Tailwind).

Scope of this spec: the per-project **Settings** view — project identity, workflow-stages editor,
members management, repository & credential panel (incl. scope-violation + grant flow), danger
zone. Workflow *rules* (who may transition between stages) live in the **Policy** view
(`policy.jsx`, separate spec); Settings only cross-links to them — see §4.2 and §4.6.

---

## 1. Purpose & entry points

Settings is the project-admin surface: rename the project / change the task-key prefix, edit the
workflow stages that drive the board columns, invite/remove members, inspect the attached GitHub
repository and its credential (PAT) scopes, and resolve credential scope violations. It also hosts
the archive/delete danger zone (denied in the mock — RBAC-gated in the real app).

It is the *destination* of the credential scope-violation flow that starts on task VIB-142: the
policy engine flags a missing PAT scope, and both the task-detail "Block on policy" decision and
the GitHub view route the user here to press **Grant scope**.

### Entry points (mock → real)

| Mock | Real app |
|---|---|
| `main.jsx` renders `<Settings tasks={tasks} stages={stages} setStages={setStages} members={members} setMembers={setMembers} onOpen={(k)=>setOpenKey(k)} onNav={goView} push={push} scopeGranted={scopeGranted} onGrantScope={grantScope} />` when `view === "settings"` | Route `/projects/:slug/settings` (hash grammar maps 1:1 per shell spec) |
| Hash `#settings` pre-selects the view | Same route, SSR loader |
| Rail nav item `settings` (label "Settings", icon `sliders`); shows a red violation count badge when `violations > 0`: `{n.id === "settings" && violations > 0 && <span className="count" style={{ color: "var(--coral-dark)", fontWeight: 700 }}>{violations}</span>}` — mock computes `violations = scopeGranted ? 0 : 1` | Badge = count of open policy violations from the projection (PAT diagnostics), not a hardcoded 1 |
| Task-detail decision **"Block on policy"** (VIB-142 packet option) closes the task and does `setView("settings")` + toast `"Task held on policy · opening repository settings"` | Redirect to `/projects/:slug/settings` after the blocked-decision action |
| Stage-settings & members panels cross-link out via `onNav("policy")` | `<Link to="/projects/:slug/policy">` keeping the `.keybtn` class |
| `cred-warn` task link via `onOpen("VIB-142")` | `<Link to="/projects/:slug/tasks/VIB-142">` keeping `.keybtn` |

Props in the mock:

- `tasks` — merged task array (used only for per-stage counts in the stages editor).
- `stages` / `setStages` — lifted to app root; setter also writes `window.VIBERR.stages` so the
  Board columns follow live.
- `members` / `setMembers` — lifted to app root; setter also writes
  `window.VIBERR.policy.members`; the rail's `membersCount` (project-switch line
  `"akin-ozer/viberr · {N} members"`) counts this array **including pending invites**.
- `onOpen(key)` — open a task (used by the cred-warn "Flagged on VIB-142" link).
- `onNav(view)` — switch main view (used by the two `pol-note` cross-links to `policy`).
- `push(text)` — toast.
- `scopeGranted` / `onGrantScope` — the scope-violation fix flow, owned by the app root because
  it also affects the rail badge, GithubView, and Activity (see §5.4).

---

## 2. Component tree

```
Settings                    – root; reads window.VIBERR.policy; owns repo-override toggle state
└─ .board-wrap[data-screen-label="Settings"]
   ├─ .board-head           – h1 "Settings", sub "Board configuration for Viberr Core"
   └─ .policy-wrap
      ├─ .policy-cols (row 1)
      │  ├─ ProjectSettings – name / prefix / description fields + task-key & task-file KV
      │  └─ StageSettings   – stages list: rename (inline input), reorder (HTML5 DnD), add, remove
      ├─ .policy-cols (row 2)
      │  ├─ MembersPanel    – member list w/ pending-invite pills, remove, invite form
      │  └─ RepoSettings    – default repo, override toggle, V1 limit, credential card
      │                       (scope chips, cred-warn w/ Grant scope OR cred-ok)
      └─ DangerZone         – archive + delete rows, both denied in the mock
```

Shared primitives consumed from `ui.jsx` (ported once in ui-primitives spec): `Icon`, `Pill`
(kind `input`, `sm` — the "invite pending" pill), `Avatar`, `TglP` (toggle switch,
`role="switch"`).

One-liners:

- **Settings** — layout + repo-override local state seeded from `policy.repo.override`.
- **ProjectSettings** — three controlled inputs saved on blur; derived KV rows showing the task-key
  pattern and canonical task-file path.
- **StageSettings** — full CRUD + reorder over the `stages` array with lock rules for `triage`
  (entry point) and `done` (terminal).
- **MembersPanel** — member list with self/last-admin removal guards and a name+email invite form.
- **RepoSettings** — read-only repo facts + override toggle + credential card with per-scope chips
  and the missing-scope warning/grant flow.
- **DangerZone** — archive/delete rows whose buttons only toast an RBAC denial in the mock.

---

## 3. Data consumed

### 3.1 `stages` (mock: `window.VIBERR.stages`, lifted to app-root state)

```js
const STAGES = [
  { id: "triage",  name: "Triage",         color: "#a5a8b5" },
  { id: "ready",   name: "Ready",          color: "#187574" },
  { id: "impl",    name: "In Progress",    color: "#7b61ff" },
  { id: "review",  name: "Review",         color: "#5b76fe" },
  { id: "done",    name: "Done",           color: "#00b473" },
];
```

- `color` is applied as inline `style={{ background: s.color }}` on `.sdot`. Seed stages use hex;
  **stages added in the editor use CSS-variable strings** — both work as inline backgrounds:

  ```js
  const NEW_STAGE_COLORS = ["var(--blue)", "var(--yellow-dark)", "var(--agent)", "var(--teal-dark)"];
  ```
- Lock table (module const in `settings.jsx`) — values are the human-readable reasons used in
  titles and toasts:

  ```js
  const STAGE_LOCK = { triage: "it's the entry point", done: "human acceptance stays terminal" };
  ```
- **Real app**: stages live in the project file (canonical), projected to SQLite for queries; the
  stages editor writes through the frontmatter-preserving project-file writer → re-parse →
  re-project → SSE. Board columns and the transition policy read the same projection.

### 3.2 `tasks` — only for counts

`StageSettings` uses `tasks.filter((t) => t.stage === id).length` for the per-row
"N tasks" count and the cannot-remove-non-empty guard. **Real app**: a
`SELECT stage, COUNT(*) FROM task_projections WHERE project_id = ? GROUP BY stage` in the loader
is enough; do not ship the whole task list to this route.

### 3.3 `members` (mock: `window.VIBERR.policy.members`, lifted to app-root state)

```js
members: [
  { p: ELIF,  role: "admin",      email: "elif@viberr.dev",  status: "active" },
  { p: ARDA,  role: "admin",      email: "arda@viberr.dev",  status: "active" },
  { p: MURAT, role: "maintainer", email: "murat@viberr.dev", status: "active" },
  { p: SELIN, role: "reviewer",   email: "selin@viberr.dev", status: "active" },
]
// where e.g. ELIF = { kind: "human", name: "Elif Demir", initials: "ED", tone: "rose" }
```

- `p.tone` ∈ `"" | "rose" | "teal" | "violet"` → `Avatar` class suffix. Invite flow cycles
  `MEMBER_TONES = ["", "rose", "teal", "violet"]` by `members.length % 4`.
- `status` ∈ `"active" | "invited"`. Invited rows get the `invite pending` pill and count into
  the header as "· N invited".
- **Role-model mismatch (important)**: the mock uses 4 roles
  (`admin | maintainer | reviewer | viewer`); CONVENTIONS.md fixes the real RBAC at 3 roles
  (`admin | member | viewer`). See Open questions §8.1. The last-admin guard must survive the
  mapping either way.
- **Real app**: members come from SQLite (org `users` × project membership), `status: "invited"`
  from invitation rows; email is the identity key (mock dedupes and removes by exact `email`
  match). The signed-in user ("you" tag, self-removal guard) comes from the session — the mock
  hardcodes `const me = "Arda Kaya"` inside `MembersPanel` and compares by **name**; the real app
  must compare by user id.

### 3.4 `policy.repo` (mock: `window.VIBERR.policy.repo`)

```js
repo: {
  name: "akin-ozer/viberr", override: true,
  credential: "viberr-bot · fine-grained PAT", masked: "github_pat_••••42af",
  scopes: [
    { id: "repo",               ok: true },
    { id: "workflow",           ok: true },
    { id: "read:org",           ok: true },
    { id: "pull_request:write", ok: false, task: "VIB-142" },
  ],
}
```

- `masked` is the display-only masked PAT. **Real app**: the PAT is AES-256-GCM encrypted in
  SQLite; the loader returns only credential label + masked suffix + scope diagnostics from the
  Phase-7 PAT validator (`app/server/secrets/`). The raw token must never reach this route's
  loader data.
- `scopes[].ok` comes from the PAT validator; `task` is the task key where the violation was
  flagged (used for the `keybtn` deep link). **Real app**: link scope diagnostics to the policy
  violation event's task via the projection.
- `override` seeds the "Task-level override" toggle — mock keeps it in **local component state
  only** (never persisted; leaving and re-entering Settings resets it to `true`). Real app:
  a project-policy field persisted through the project file writer.
- "Repos per task" is a hardcoded literal: `1 · V1 limit` — a product constraint, not data.

### 3.5 `scopeGranted` (mock: app-root boolean, starts `false`)

Session-wide flag for "the missing PAT scope has been granted". Drives (all in `main.jsx`):
rail settings badge (`violations = scopeGranted ? 0 : 1`), `GithubView`, `Activity`, and this
view's cred-card. **Real app**: not a boolean — derive from PAT diagnostics (re-validate the PAT
after the grant action; the violation clears when the validator sees the scope).

### 3.6 Project identity (mock: local state defaults inside `ProjectSettings`)

`name = "Viberr Core"`, `prefix = "VIB"`, `desc = "Core platform work — orchestration runtime,
operator layer, and workspace surfaces."` — the mock never reads these from data.js (quirk).
**Real app**: from the project file (canonical) via projection; prefix rules: uppercased, max 4
chars (mock enforces `toUpperCase().slice(0, 4)` on change).

### 3.7 Workflow rules (context only — rendered in Policy view, not here)

The `pol-note` under the stages editor points at `POLICY.transitions`:

```js
transitions: [
  { from: "triage", to: "ready",  by: "Human, after the quality gate — agents may flag underspecified tasks", boundary: "approval" },
  { from: "ready",  to: "impl",   by: "Operator, when a primary specialist is assigned",                       boundary: "auto" },
  { from: "impl",   to: "review", by: "Operator transition request, with evidence attached",                   boundary: "approval" },
  { from: "review", to: "done",   by: "Human acceptance of the completion report", boundary: "human", locked: true },
]
```

Settings must keep transitions consistent when stages change (see §7.4).

---

## 4. UI states & interactions

### 4.1 ProjectSettings panel

Header: `panel-head` with `Icon board` + `<h2>Project</h2>`.

Fields (all controlled; **save on blur**, each blur fires toast `"Project settings saved"` even if
nothing changed — real app should only save when dirty):

- **Project name** — text input, label `Project name` (`.flabel`).
- **Task prefix** — text input with class `mono`, label `Task prefix`; on change value is
  `e.target.value.toUpperCase().slice(0, 4)`. Grid: the two sit in a
  `.field-row` with inline `style={{ gridTemplateColumns: "1fr 120px" }}` (overrides the default
  1fr/1fr).
- **Description** — `<textarea rows="2">`, label `Description`.

Derived KV block (`.kv` with inline `style={{ marginTop: ".4rem" }}`):

```jsx
<div className="kv-row"><span className="k">Task keys</span><span className="v"><span className="mono">{prefix}-###</span></span></div>
<div className="kv-row"><span className="k">Canonical task file</span><span className="v"><Icon name="file" /><span className="mono">{".viberr/tasks/<key>/task.md"}</span></span></div>
```

The task-file path updates nothing — it is informational copy. Keep it verbatim (note the literal
`<key>` placeholder; in JSX it's a string expression to avoid parsing as a tag).

### 4.2 StageSettings panel (stages editor)

Header: `panel-head` with `Icon branch` + `<h2>Workflow stages</h2>` + right-aligned counter
`<span className="right sub" style={{ fontSize: ".76rem", color: "var(--faint)" }}>{stages.length} stages</span>`.

Each stage renders as a `.stg-row`. Full row markup (verbatim — the drag/edit wiring is the tricky
part):

```jsx
<div
  className={"stg-row" + (dragId === s.id ? " dragging" : "") + (overId === s.id && dragId !== s.id ? " over" : "")}
  key={s.id}
  draggable={!locked && editingId !== s.id}
  onDragStart={(e) => { setDragId(s.id); e.dataTransfer.effectAllowed = "move"; }}
  onDragOver={(e) => { e.preventDefault(); if (overId !== s.id) setOverId(s.id); }}
  onDragLeave={() => { if (overId === s.id) setOverId(null); }}
  onDrop={() => drop(s.id)}
  onDragEnd={() => { setDragId(null); setOverId(null); }}
>
  <span className={"stg-handle" + (locked ? " off" : "")} title={locked ? s.name + " is fixed — " + locked : "Drag to reorder"}>
    <Icon name={locked ? "lock" : "grip"} />
  </span>
  <span className="sdot" style={{ background: s.color }}></span>
  {editingId === s.id ? (
    <input
      type="text" className="stg-input" defaultValue={s.name} autoFocus
      onFocus={(e) => e.target.select()}
      onBlur={(e) => commitName(s, e.target.value)}
      onKeyDown={(e) => { if (e.key === "Enter") e.target.blur(); if (e.key === "Escape") setEditingId(null); }}
    />
  ) : (
    <button type="button" className="stg-name" onClick={() => setEditingId(s.id)} title="Rename stage">{s.name}</button>
  )}
  <span className="stg-count">{n} {n === 1 ? "task" : "tasks"}</span>
  <button type="button" className={"stg-x" + (locked ? " off" : "")} aria-label={"Remove " + s.name} title={locked ? s.name + " can't be removed" : "Remove stage"} onClick={() => remove(s)}>
    <Icon name="x" />
  </button>
</div>
```

Behaviors:

- **Rename** (allowed for ALL stages, including locked `triage`/`done` — lock only blocks remove
  and drag). Click `.stg-name` → inline `.stg-input` (uncontrolled, `defaultValue`, autofocus +
  select-all). Enter blurs (commits); Escape cancels (`setEditingId(null)` without commit); blur
  commits. Commit: trim; if empty or unchanged → silently exit edit mode; else update stage name
  and toast `Stage renamed to "{name}" — board and policy follow`.
- **Reorder** — native HTML5 DnD on the rows. `draggable` unless locked or currently editing.
  Source row gets `.dragging` (45% opacity), hovered target gets `.over` (inset top bar). On drop:
  splice the dragged stage in front of the target, then **normalize**: `triage` forced first,
  `done` forced last:

  ```js
  next = [next.find((s) => s.id === "triage"), ...next.filter((s) => s.id !== "triage" && s.id !== "done"), next.find((s) => s.id === "done")].filter(Boolean);
  ```

  Toast: `Stage order updated — board columns follow`. Drop on self or with no source is a no-op.
- **Remove** — `.stg-x` is always rendered and clickable, `.off` (dimmed, hover suppressed) when
  locked. Guards, in order:
  1. Locked → toast `` `{name} can't be removed — {reason}` `` (e.g. `Triage can't be removed —
     it's the entry point`, `Done can't be removed — human acceptance stays terminal`).
  2. Non-empty → toast `Move {n} task out of {name} first` / `Move {n} tasks out of {name} first`.
  3. Else remove + toast `Stage "{name}" removed`.
- **Add** — full-width footer button
  `<button className="btn ghost sm" style={{ width: "100%", marginTop: ".8rem" }}>` with
  `Icon plus` + label `Add stage`. Creates
  `{ id: "stage-" + Date.now().toString(36), name: "New stage", color: NEW_STAGE_COLORS[stages.length % 4] }`,
  inserted **immediately before `done`** (appended if no `done` exists), then enters edit mode on
  the new row. Toast: `Stage added — it appears on the board immediately`.
- **Cross-link note** (`.pol-note`, inline `style={{ marginBottom: 0, marginTop: ".8rem" }}`,
  `Icon shield`): copy — `Drag to reorder · click a name to rename. Who may move tasks between
  stages is set in ` + `<button type="button" className="keybtn" onClick={() => onNav("policy")}>Policy → Workflow rules</button>`.

### 4.3 MembersPanel

Header: `panel-head` with `Icon user` + `<h2>Members</h2>` + right-aligned counter:
`{members.length - pending} active` plus ` · {pending} invited` only when `pending > 0`
(mock data: `4 active`).

Member row (verbatim):

```jsx
<div className="member-row" key={m.email}>
  <Avatar person={m.p} />
  <span className="member-main">
    <div className="nm">{m.p.name}{m.p.name === me && <span className="you-tag">you</span>}</div>
    <div className="em">{m.email}</div>
  </span>
  {m.status === "invited" && <Pill kind="input" sm>invite pending</Pill>}
  <button type="button" className="stg-x" aria-label={"Remove " + m.p.name} title={m.status === "invited" ? "Revoke invite" : "Remove member"} onClick={() => remove(m)}>
    <Icon name="x" />
  </button>
</div>
```

(the member list wrapper is `.member-list` with inline `style={{ marginBottom: 0 }}`; note the
remove button **reuses `.stg-x`**.)

**Remove guards**, in order:

1. Self (`m.p.name === "Arda Kaya"`) → toast `You can't remove yourself from Viberr Core`.
2. Last admin (`m.role === "admin"` and admins ≤ 1) → toast
   `{name} is the only admin — assign another admin in Policy first`.
3. Else remove; toast `Invite revoked · {email}` if the row was invited, else
   `{name} removed from Viberr Core`.

**Invite form** (`.invite-row` — grid `1fr 1.2fr auto`):

```jsx
<div className="invite-row">
  <input type="text" placeholder="Full name" value={nm} onChange={...} />
  <input type="text" placeholder="email@company.dev" value={em} onChange={...} onKeyDown={(e) => { if (e.key === "Enter") invite(); }} />
  <button className="btn sm" onClick={invite}><Icon name="send" />Invite</button>
</div>
```

Invite logic: trim name, trim+lowercase email. Validation: name required AND email contains
`"@"` → else toast `Enter a name and a valid email`. Duplicate email → toast
`{email} is already a member`. Success: build initials
(`name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase()`), tone from
`MEMBER_TONES[members.length % 4]`, append
`{ p: { name, initials, tone }, email, role: "viewer", status: "invited" }`, clear both inputs,
toast `Invite sent to {email} · joins as Viewer`. Enter in the **email** field submits (not the
name field).

Cross-link note (`.pol-note`, same inline style as §4.2, `Icon shield`): copy —
`New members join as Viewer. Roles are managed in ` +
`<button type="button" className="keybtn" onClick={() => onNav("policy")}>Policy → Human access</button>`.

### 4.4 RepoSettings (repository & credentials)

Header: `panel-head` with `Icon github` + `<h2>Repository &amp; credentials</h2>`.

KV block:

- **Default repository** — `Icon github` + `<span className="mono">akin-ozer/viberr</span>`.
- **Task-level override** — value cell gets inline `style={{ gap: ".6rem" }}` and contains a
  status caption + the toggle:

  ```jsx
  <span className="v" style={{ gap: ".6rem" }}>
    <span style={{ fontSize: ".78rem", color: "var(--faint)", fontFamily: "var(--font-body)", fontWeight: 400 }}>{override ? "tasks may attach a different repo" : "all tasks use the default"}</span>
    <TglP on={override} onChange={onOverride} label="Task-level repository override" />
  </span>
  ```

  Toggling fires toast `Task-level repo override enabled` / `Task-level repo override disabled`
  (note: the toast text is computed from the **pre-toggle** value in `Settings`, so "enabled" shows
  when turning ON — correct, keep that mapping, not the stale-state bug it looks like:
  `push(override ? "…disabled" : "…enabled")` reads the old value).
- **Repos per task** — literal `1 · V1 limit`.

Credential card (verbatim, including the whole conditional — this is the scope-violation flow):

```jsx
<div className="cred-card">
  <div className="cred-top">
    <Icon name="lock" />
    <span className="cred-name">{P.repo.credential}</span>
    <span className="mono" style={{ marginLeft: "auto", color: "var(--faint)" }}>{P.repo.masked}</span>
  </div>
  <div className="scope-chips">
    {P.repo.scopes.map((s) => {
      const ok = s.ok || scopeGranted;
      return (
        <span className={"scope-chip" + (ok ? "" : " miss")} key={s.id}>
          <Icon name={ok ? "check" : "alert"} />{s.id}
        </span>
      );
    })}
  </div>
  {missing && !scopeGranted ? (
    <div className="cred-warn">
      <Icon name="alert" />
      <span>Missing <code className="mono">{missing.id}</code> — PR status can't auto-sync after merge. Flagged on</span>
      <button type="button" className="keybtn" onClick={() => onOpen(missing.task)}>{missing.task}</button>
      <button className="btn sm" style={{ marginLeft: "auto" }} onClick={onGrantScope}><Icon name="check" />Grant scope</button>
    </div>
  ) : (
    <div className="cred-ok"><Icon name="check" />All required scopes granted. Secrets stay isolated from task records and timelines.</div>
  )}
</div>
```

Notes:

- `missing = P.repo.scopes.find((s) => !s.ok)` — only the **first** missing scope surfaces in the
  warning; the chips show all of them.
- `ok = s.ok || scopeGranted` — the mock's single boolean flips **every** missing chip at once. In
  the real app, re-validate per scope.
- The `{missing.task}` keybtn deep-links to the flagged task (VIB-142).
- After granting, the card flips to `cred-ok` with the exact copy above.

### 4.5 DangerZone

Panel gets an extra class: `panel danger-panel` (coral border, coral header icon). Header:
`Icon alert` + `<h2>Danger zone</h2>`. Two rows:

```jsx
<div className="dz-row">
  <span className="dz-main">
    <div className="dn">Archive Viberr Core</div>
    <div className="dd">Board becomes read-only, running agents stop, timelines are preserved.</div>
  </span>
  <button className="btn ghost sm" onClick={() => deny("Archiving")}>Archive</button>
</div>
<div className="dz-row">
  <span className="dz-main">
    <div className="dn">Delete project</div>
    <div className="dd">Removes tasks, timelines, and audit logs. This cannot be undone.</div>
  </span>
  <button className="btn danger sm" onClick={() => deny("Deletion")}>Delete project</button>
</div>
```

Both buttons only toast in the mock:
`Archiving is admin-only — you're signed in as a maintainer` /
`Deletion is admin-only — you're signed in as a maintainer`. (Mock inconsistency: the signed-in
user Arda is an **admin** in `POLICY.members` — the copy pretends otherwise to demo the denial
path. Real app: show the buttons enabled only for admins, or keep them visible and return a real
403-style denial; see §8.3.)

### 4.6 Toasts (complete list produced by this view)

| Trigger | Toast text |
|---|---|
| Any project field blur | `Project settings saved` |
| Stage rename commit | `Stage renamed to "{name}" — board and policy follow` |
| Remove locked stage | `{name} can't be removed — {reason}` |
| Remove non-empty stage | `Move {n} task(s) out of {name} first` |
| Remove stage OK | `Stage "{name}" removed` |
| Add stage | `Stage added — it appears on the board immediately` |
| Reorder stages | `Stage order updated — board columns follow` |
| Invite invalid | `Enter a name and a valid email` |
| Invite duplicate | `{email} is already a member` |
| Invite OK | `Invite sent to {email} · joins as Viewer` |
| Remove self | `You can't remove yourself from Viberr Core` |
| Remove last admin | `{name} is the only admin — assign another admin in Policy first` |
| Remove invited member | `Invite revoked · {email}` |
| Remove active member | `{name} removed from Viberr Core` |
| Override toggle | `Task-level repo override enabled` / `…disabled` |
| Grant scope (app root) | `Scope granted · VIB-142 policy flag resolved` |
| Danger zone deny | `{Archiving\|Deletion} is admin-only — you're signed in as a maintainer` |

### 4.7 Keyboard / aria inventory

- Stage rename input: Enter commits (via blur), Escape cancels; auto-focus + select-all on entry.
- Invite email input: Enter submits the invite.
- Remove buttons: `aria-label="Remove {stage name}"` / `aria-label="Remove {member name}"`;
  `title` differs for locked stages and invited members ("Revoke invite").
- Override toggle: `TglP` renders `role="switch" aria-checked aria-label="Task-level repository
  override"`.
- Drag handles: `title` explains lock reason or "Drag to reorder". HTML5 DnD has no keyboard
  path in the mock — acceptable to keep, but see §8.4.

---

## 5. Events / mutations produced

Every mutation below is a real action in the port (POST to the settings route or a resource
route), each writing an audit event; file-backed state goes through the project-file writer →
re-parse → re-project → SSE (`project.updated` or similar), per CONVENTIONS.

### 5.1 Project identity

`updateProject { name, prefix, description }` — mock: local state + toast on blur. Real: action
persists to the project file; **changing `prefix` must NOT rewrite existing task keys** (mock
implies keys are `{prefix}-###` going forward; existing keys are immutable file paths). Audit
event: project settings changed.

### 5.2 Stages

- `renameStage { stageId, name }` — board columns, transition rules display, and policy follow
  via projection (mock toast says so explicitly).
- `reorderStages { orderedIds }` — server re-applies the triage-first / done-last normalization;
  never trust client order.
- `addStage { name?, color? }` — server generates the id (slug or nanoid — do not copy the
  `Date.now().toString(36)` scheme), inserts before `done`, assigns color by cycling
  `NEW_STAGE_COLORS`.
- `removeStage { stageId }` — server re-checks: not locked (`triage`/`done`), zero tasks in the
  stage (count from projections at action time, not from the client). Also must decide what
  happens to `POLICY.transitions` rows referencing the removed stage (§7.4).

All stage mutations: audit event + SSE so open Boards re-render columns.

### 5.3 Members

- `inviteMember { name, email }` — creates an invitation (role `viewer`, per the on-screen
  promise "New members join as Viewer"; map to real 3-role model, §8.1), sends the invite email
  in the real app (mock only toasts). Server-side validation: real email format (mock's
  `includes("@")` is a placeholder), dedupe against members AND pending invites.
- `removeMember { email | userId }` / `revokeInvite { invitationId }` — server re-checks the
  self-removal and last-admin guards (client-side guards in the mock are UX sugar only). RBAC:
  mock's `Manage members & roles` grant is admin-only — enforce server-side.

Audit events for all three; membership changes should also update the rail member count via
revalidation/SSE.

### 5.4 Grant scope (the credential fix flow) — writes a **typed timeline event**

Mock implementation in `main.jsx` (verbatim, this is the contract):

```js
const grantScope = () => {
  setScopeGranted(true);
  addEvent("VIB-142", { type: "policy", actor: { name: "Policy engine", kind: "system" }, t: "now", text: "**Policy update:** `pull_request:write` granted on the project credential. The earlier violation is resolved — PR auto-sync will work after merge." });
  push("Scope granted · VIB-142 policy flag resolved");
};
```

Real action `grantScope` (Phase 7 wiring):

1. Re-validate the stored PAT (or accept a replacement PAT) via the PAT validator; confirm the
   missing scope is now present. "Grant scope" in the real app likely means "re-check after the
   user widened the PAT on GitHub" or "save a new PAT" — see §8.2.
2. Clear the policy-violation diagnostic in the projection.
3. Write a **typed `policy` timeline event** (system actor "Policy engine") into the flagged
   task's `task.md` with the copy above (markdown: bold lead-in + backticked scope id).
4. Audit event (PAT change / policy resolution).
5. SSE so the rail badge, GithubView, Activity, and this card update everywhere. Mock side
   effects to reproduce: rail settings badge 1→0, all `.miss` chips flip to ok, `cred-warn` →
   `cred-ok`, GithubView and Activity violation UI clears.

### 5.5 Override toggle

`setRepoOverride { enabled }` — mock: local state + toast only (not even persisted to the global —
resets on remount). Real: persist as project policy; task-detail's repo-attach UI reads it to
decide whether tasks may pick a non-default repo.

### 5.6 Archive / delete

Real actions with confirm dialogs (none exist in the mock — the buttons never get past the RBAC
toast). Archive: board read-only, stop running agents, preserve timelines (copy is the spec).
Delete: destructive, removes tasks/timelines/audit logs, "cannot be undone" — gate behind
type-the-project-name confirmation (pattern to add; mock has none). Both admin-only, audited.

---

## 6. CSS classes used (structural contract)

All in `viberr.css` (verified present). Do not rename.

- Layout: `board-wrap` (+ `data-screen-label="Settings"`), `board-head`, `policy-wrap`,
  `policy-cols` (2-col grid, collapses to 1 col ≤1100px via media query), `panel`, `panel-head`
  (+ `.right.sub` right-aligned counter), `sub`.
- Project fields: `set-fields`, `field-row` (inline-overridden to `1fr 120px`), `field`, `flabel`,
  `mono`, `kv`, `kv-row` (+ child `.k` / `.v`).
- Stages: `stg-list`, `stg-row` (+ state classes `dragging`, `over`), `stg-handle` (+ `off`),
  `sdot` (inline background color), `stg-name`, `stg-input`, `stg-count`, `stg-x` (+ `off`).
- Notes/links: `pol-note`, `keybtn`.
- Members: `member-list`, `member-row`, `member-main` (+ child `.nm` / `.em`), `you-tag`,
  `invite-row`, plus `avatar` (+ tone classes) and `pill input sm` from ui-primitives.
- Repo/credential: `cred-card`, `cred-top`, `cred-name`, `scope-chips`, `scope-chip` (+ `miss`),
  `cred-warn`, `cred-ok`, `tgl` (+ `on`, child `knob`) via `TglP`.
- Danger zone: `danger-panel` (modifier on `panel`), `dz-row`, `dz-main` (+ child `.dn` / `.dd`).
- Buttons: `btn sm`, `btn ghost sm`, `btn danger sm`.
- Icons used: `board`, `branch`, `lock`, `grip`, `x`, `plus`, `shield`, `user`, `send`, `github`,
  `check`, `alert`, `file`.

Inline styles that are part of the look (keep as inline styles or promote to one-off utility
rules, but reproduce the values): field-row `1fr 120px`; panel-head counters
`fontSize:.76rem; color:var(--faint)`; kv `marginTop:.4rem`; pol-note `marginTop:.8rem;
marginBottom:0`; add-stage button `width:100%; marginTop:.8rem`; member-list `marginBottom:0`;
override caption `fontSize:.78rem; color:var(--faint); fontFamily:var(--font-body);
fontWeight:400`; override `.v` `gap:.6rem`; masked PAT `marginLeft:auto; color:var(--faint)`;
Grant-scope button `marginLeft:auto`.

---

## 7. Porting notes

1. **`window.VIBERR.policy` → loader data.** Everything the view reads
   (`repo`, `members`, `stages`, task counts) comes from a single `/projects/:slug/settings`
   loader: project projection (name/prefix/description/stages/override), membership query,
   per-stage task counts, PAT metadata + scope diagnostics (never the token). `scopeGranted`
   disappears — it's the absence of an open PAT-scope violation in diagnostics.
2. **Blur-save → explicit form semantics.** The mock saves project fields on blur with an
   unconditional toast. Port as a fetcher-submitting form on blur (only when dirty), or add a
   Save button; keep the toast copy `Project settings saved`. No optimistic UI for governed state;
   revalidate after action.
3. **Stage editor state → server round-trips.** Rename/add/remove/reorder each become fetcher
   actions. Keep the optimistic *edit-mode* UX (inline input, DnD highlight classes) but the list
   itself re-renders from revalidated data. Server owns: id generation, lock enforcement,
   non-empty guard (recheck counts at action time — client counts can be stale), order
   normalization.
4. **Removing/renaming stages vs. transitions & tasks.** The mock ignores this. Real app must
   decide: transition rules referencing a removed stage are deleted (or the action is refused
   while rules reference it), and stage `id`s referenced by task files must remain resolvable
   (tolerant parsing: a task whose stage id no longer exists → readiness downgrade + diagnostic,
   never a crash). Renames are safe because ids are stable — only `name` changes.
5. **Member identity.** Replace name-based self-check (`m.p.name === "Arda Kaya"` hardcoded
   inside the panel — it doesn't even use the app-level `me` state, so renaming yourself in
   Profile breaks the guard in the mock) with session user id. Keep both guards server-side;
   client copies of the toasts are fine for fast feedback but the action must fail safely too.
6. **Invite `p` shape quirk.** The mock builds the invited person **without** `kind: "human"`
   (`{ name, initials, tone }`); `Avatar` tolerates it. In the real app, derive initials/tone
   server-side with the shared `initialsOf` logic so Board/task views render invited users
   consistently once they join.
7. **Stage colors.** Support both hex strings and `var(--*)` strings in `stages[].color` — the
   seed data uses hex, editor-added stages use CSS variables, and both are applied as inline
   `background`. Persist whatever string is chosen; render verbatim.
8. **First-missing-scope only.** `cred-warn` shows one violation at a time
   (`scopes.find(s => !s.ok)`). Keep that (it matches the "one flagged task" copy) but make the
   chips reflect true per-scope state from the validator, not a single boolean.
9. **HTML5 DnD.** Fine to port as-is (same events, same class toggling). It will not work on
   touch or keyboard; if that matters, add up/down buttons later without changing classes (§8.4).
10. **Danger zone.** Replace toast-denial with real RBAC: hide-or-disable per role, real confirm
    dialogs, real archive/delete actions (archive = project state flag; delete = destructive with
    typed-name confirmation). Copy in §4.5 is the behavioral spec for what archive/delete must do.
11. **Empty/error states the mock never shows.** Members list can't be empty (you're always in
    it). Stage list minimum is `triage` + `done` (both locked). No-PAT / no-repo state: the mock
    always has a credential; Phase 7 requires a degraded mode — when no PAT is configured, the
    cred-card should show a "connect credential" affordance instead of scope chips (new UI, reuse
    `cred-card`/`cred-warn` classes). Invite failure (SMTP down etc.) → error toast + row not
    added. Action-level errors follow the typed `AppError` convention.
12. **Toast copy is contract.** Reuse the §4.6 strings verbatim (project name interpolated where
    the mock hardcodes "Viberr Core": self-removal toast and archive row title use the project
    name).

---

## 8. Open questions

1. **Role model.** Mock: `admin | maintainer | reviewer | viewer` (4 roles, used by the RBAC
   table in `policy.jsx` and the "joins as Viewer" copy). CONVENTIONS.md: `admin | member |
   viewer` (3 roles). Which wins for the port? If 3 roles: "joins as Viewer" copy stands, the
   last-admin guard stands, but the Policy cross-link copy ("Roles are managed in Policy → Human
   access") and the RBAC matrix need re-mapping (maintainer+reviewer → member?).
2. **What does "Grant scope" actually do?** The mock flips a boolean. A real PAT's scopes can't
   be widened by our app — options: (a) button opens a "paste updated PAT" dialog, then
   re-validates; (b) button just re-runs validation assuming the user already widened it on
   GitHub; (c) both ("Re-check" + "Replace credential"). The timeline event + audit + SSE fanout
   in §5.4 apply regardless.
3. **Danger-zone visibility for non-admins.** Hide the panel, disable the buttons, or keep the
   mock's "deny with toast" behavior? Mock deliberately demos the denial path with copy that
   contradicts its own data (Arda is admin).
4. **Stage reorder accessibility.** HTML5 DnD only — is a keyboard fallback (move up/down) in
   scope for the port, and if so does it need new classes (proposal: reuse `stg-x`-style icon
   buttons inside `stg-row`)?
5. **Prefix change semantics.** Mock allows editing `prefix` freely. Real app: new tasks get the
   new prefix, old keys immutable — confirm, and decide whether a confirm dialog is needed
   ("existing task keys keep VIB-").
6. **Does `override` belong in the project file or SQLite-only policy?** It gates task-level repo
   attachment (task-detail + Phase 7); file-canonical per conventions suggests project file, but
   it's coupled to credential policy.
