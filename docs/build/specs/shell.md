# Porting spec — App shell (`design/html-app/app/main.jsx`)

Source of truth: `/Users/akinozer/projects/viberr/design/html-app/app/main.jsx` (327 lines), with shared
primitives from `app/ui.jsx` and data shapes from `app/data.js`. The CSS design system
(`app/viberr.css`) is ported verbatim — **class names below are the contract**; do not rename them.

Target: React Router v7 SSR app with real loaders/actions, SQLite (projections, notifications,
sessions), and a file-native task store (`.viberr/tasks/<KEY>/task.md`).

---

## 1. Purpose & entry points

`main.jsx` is the **workspace shell** for one project ("Viberr Core"). It owns:

- The left **rail** (primary nav with live counts) and the **topbar** (brand, breadcrumbs, search,
  notification bell popover, user menu).
- **View routing** between the seven workspace views (Board, Review queue, Agents, Policy, GitHub,
  Activity, Settings) and the task-detail view.
- The **toast system**, **theme cycling**, and two full-page **overlays** (Profile & preferences,
  Notifications).
- All cross-view **mutation handlers**: task create, packet resolve, ownership take/hand/release,
  comment post, scope grant, notification read / read-all. Child views receive these as props and
  never mutate on their own.

### Mock entry flow (to be replaced)

```jsx
if (!window.VIBERR.session.get()) {
  location.replace("Viberr Login.html");
} else {
  ReactDOM.createRoot(document.getElementById("root")).render(<App />);
}
```

- Session = `localStorage["viberr:session"]` (JSON, or `null`). Missing session → hard redirect to
  the login page.
- Initial view/task come from the location hash, **read once at boot** (no `hashchange` listener,
  and navigation never writes the hash back — back/forward is broken in the mock):

```jsx
const initialView = ((location.hash || "").match(/^#(board|review|agents|policy|github|activity|settings)$/) || [])[1] || "board";
const initialTask = ((location.hash || "").match(/^#task\/([A-Za-z]+-\d+)$/) || [])[1] || null;
```

### Real entry flow

- Route module layout, e.g. `routes/workspace.tsx` as a layout route for
  `/projects/:projectId` with children `board` (index), `review`, `agents`, `policy`, `github`,
  `activity`, `settings`, and `task/:taskKey`. The hash grammar maps 1:1 onto URL paths; deep links
  like `#task/VIB-142` become `/projects/viberr-core/task/VIB-142`.
- Session guard in the layout loader: no session cookie → `redirect("/login")`. The mock's
  `location.replace("Viberr Login.html")`, `location.href = "Viberr Home.html"` hops become
  `redirect()` / `<Link>` to `/login` and `/home` (the all-projects page).
- Task-key pattern for route matching: `/^[A-Za-z]+-\d+$/` (e.g. `VIB-142`). Unknown key → 404
  boundary (the mock silently renders nothing useful — `open` is `undefined` and TaskDetail crashes;
  real app must handle it).

---

## 2. Component tree

```
<App>                         — shell state owner (view, openKey, overrides, toasts, theme, notifs…)
├─ <Rail>                     — left nav: project switch button, 7 nav items with counts
├─ .main
│  ├─ .topbar
│  │  ├─ home-brand button    — "V / Viberr", hops to Home (all projects)
│  │  ├─ .crumbs              — Viberr Core › [Board ›] current-view-or-task
│  │  ├─ .top-search          — decorative search input + ⌘K hint (NOT wired in mock)
│  │  ├─ <TopBell>            — bell icon + unread badge + notifications popover (role=dialog)
│  │  └─ <TopUser>            — avatar button + account menu (profile / switch / theme / sign out)
│  └─ one of:
│     ├─ <TaskDetail>         — when a task is open (defined in task.jsx)
│     ├─ <Board>              — board.jsx
│     ├─ <ReviewQueue>        — review.jsx
│     ├─ <Agents>             — agents.jsx
│     ├─ <Policy>             — policy.jsx
│     ├─ <GithubView>         — github.jsx
│     ├─ <Activity>           — activity.jsx
│     └─ <Settings>           — settings.jsx
├─ <PageOverlay label="Profile & preferences"> <Profile/>       — when overlay === "profile"
├─ <PageOverlay label="Notifications">        <Notifications/>  — when overlay === "notifications"
└─ <ToastHost>                — fixed toast stack, aria-live polite
```

Shared primitives consumed from `ui.jsx` (ported once, globally): `Icon` (inline stroke SVG by
name), `Avatar` (initials chip, `tone` color variant), `initialsOf(name)`, `useToasts`/`ToastHost`,
`PageOverlay` (scrim + dialog + Escape-to-close). Also relevant: `Identity`, `AgentGlyph`, `Pill`,
`ReadinessPill`, `ValidationPill`, `TglP` (used by child views).

---

## 3. Data consumed

### 3.1 Tasks (`window.VIBERR.tasks` → real: SQLite projection of the file-native store)

The shell composes the working task list from three layers (all in-memory in the mock):

```jsx
const tasks = useMemo(
  () => [...base, ...created].map((t) => ({ ...t, ...(overrides[t.key] || {}) })),
  [base, created, overrides]
);
```

Real app: this whole layering disappears — loaders return the current projection; actions mutate the
store and revalidation refreshes it.

Task shape (exact, from `data.js`):

```
{
  key: "VIB-142",                 // "<PREFIX>-<n>"
  title: string,
  stage: "triage"|"ready"|"impl"|"review"|"done",   // stage.id, see stages below
  goal: string,
  readiness: "ready"|"input"|"risk"|"blocked"|"done",
  specialist: AgentIdentity | null,
  owner: HumanIdentity | null,
  operator: { name: "Operator", since: "stage 1" } | null,
  consultants: AgentIdentity[],
  waiting: "human"|"agent"|"none",
  urgent: boolean,
  validation: "healthy"|"changed"|"failing"|"none",
  branch: string | null,           // "vib-142-attach-workspace"
  repo: "akin-ozer/viberr",
  pr: { number: 318, state: "review"|"merged", title: string } | null,
  commits?: [{ sha, msg }],        // only on some tasks
  changed?: { files: 9, add: 412, del: 87 },
  packet?: {                       // pending decision packet, or absent/null
    type: "input"|"blocked",
    kind: "Completion report"|"Blocked decision",
    from: "Operator",
    title: string,
    body: string,
    observations: [{ k: string, v: string, code: boolean }],
    options: [{ t: string, d: string, rec: boolean, accept?: true, ev?: string }],
  },
  timeline: TimelineEvent[],       // newest first
}
```

Identity shapes (used across timeline, notifications, members):

```
HumanIdentity  = { kind: "human", name, initials, tone: ""|"rose"|"teal"|"violet", guest?: true }
AgentIdentity  = { kind: "agent", backend: "codex"|"claude", name: "Codex"|"Claude Code", role: "Developer"|"Reviewer"|"Consultant"|… }
SystemIdentity = { kind: "system", name: "Policy engine" }
OperatorRef    = { name: "Operator", kind: "agent" }          // note: no backend
```

TimelineEvent (the typed event record — must become first-class rows/file entries):

```
{
  type: "comment"|"completion"|"github"|"policy"|"quality"|"transition"|"agent"|"assign"|"blocked",
  actor: Identity,
  t: "9:41",                 // clock time; shell writes "now" for new events
  day?: "Yesterday"|"Mar 30",// absent = today
  text: string,              // inline markup: **bold** and `code` only
  title?: string,            // e.g. "Completion report", "Completion accepted"
  evidence?: [{ label, add: "+14", del: "0" }],   // completion events
  to?: "agent" | null,       // comment routed to an agent
}
```

### 3.2 Stages (`window.VIBERR.stages` → real: project workflow config in DB)

```
[{ id: "triage", name: "Triage", color: "#a5a8b5" },
 { id: "ready",  name: "Ready",  color: "#187574" },
 { id: "impl",   name: "In Progress", color: "#7b61ff" },
 { id: "review", name: "Review", color: "#5b76fe" },
 { id: "done",   name: "Done",   color: "#00b473" }]
```

Shell holds these in state and writes back to the global on change (Settings can reorder/edit):
`setStages` = `window.VIBERR.stages = next; setStagesRaw(next)`. Real: loader data + action.

### 3.3 Members (`window.VIBERR.policy.members` → real: project membership table)

```
[{ p: HumanIdentity, role: "admin"|"maintainer"|"reviewer"|"viewer", email: "arda@viberr.dev", status: "active" }, …]
```

Used by the shell for: `membersCount` (rail project-switch meta line) and

```jsx
const myRole = ((members.find((m) => m.p.name === me.name) || {}).role) || "viewer";
```

`myRole` is passed to TaskDetail (gates ownership/admin actions). **Real: role comes from the
session/membership row, never from a name match** — the mock breaks if the user renames themselves
in Profile to a non-member name (role silently degrades to "viewer"; ownership matching by
`owner.name !== me.name` also breaks — see §7).

### 3.4 Current user (`me` state → real: session)

Mock hardcodes `{ name: "Arda Kaya", title: "Senior engineer" }`, editable via the Profile overlay
(`setMe`). The user-menu email is a **hardcoded string** `arda@viberr.dev`. Avatar everywhere is
built as `{ ...window.VIBERR.people.ARDA, initials: initialsOf(me.name) }` — tone from the canonical
person, initials recomputed from the (possibly edited) display name. Real: user record from session
(id, name, email, initials, tone), role from membership.

### 3.5 Notifications (`window.VIBERR.notifications` → real: per-user notification rows in SQLite)

```
{
  id: "n-142-packet",
  kind: "packet"|"approval"|"mention"|"policy"|"quality",
  ptype?: "input"|"blocked",        // packet kind only
  unread: boolean,
  day: "Today"|"Yesterday", t: "9:41",
  from: Identity,                    // agent/system/human
  task: "VIB-142",                   // task key (may belong to ANOTHER project)
  project: "Viberr Core"|"Deploy Pipeline"|"Billing Service",  // defaulted to "Viberr Core"
  title?: string,                    // packet/approval have titles; policy/quality/mention are text-only
  text: string,                      // may contain **bold** / `code` markers
}
```

The stream is **global to the user** — items from other projects appear (e.g. task `DEP-31` in
"Deploy Pipeline"). Read-state in the mock is persisted separately as an id list in
`localStorage["viberr:notifs:read"]` (shared across the Home page and workspace); `data.js` re-applies
it at load. Real: `read_at` column per (user, notification).

### 3.6 Prefs / theme (`window.VIBERR.prefs` → real: user prefs; theme also in a cookie)

Defaults (from `ui.jsx` `initPrefs`): `{ theme: "system", motion: "full", tlDefault: "all",
ghConnected: true, notifs: {packets/approvals/mentions/policy/quality × {app, email}}, nudge: {on, hours} }`,
persisted to `localStorage["viberr:prefs"]`. Applying theme sets
`document.documentElement.dataset.theme = "dark"|"light"` (resolving `"system"` via
`matchMedia("(prefers-color-scheme: dark)")`, with a change listener) and
`dataset.motion = "reduce"|"full"`. **The CSS keys off `[data-theme]` on `<html>`** — keep this
mechanism. Real: persist theme in a cookie so SSR renders the right `data-theme` (no flash);
`"system"` still needs the client media-query listener.

### 3.7 Scope-grant flag (`scopeGranted` state → real: derived from policy/credential state)

Mock: boolean, starts `false`, flipped by Settings ("Grant scope" on the repo credential). Drives:
rail Settings violation count (`violations = scopeGranted ? 0 : 1`), and is passed down to
GithubView / Activity / Settings so they can flip their violation UI. Real: derive from the project
credential scopes table — `policy.repo.scopes` shape:
`[{ id: "pull_request:write", ok: false, task: "VIB-142" }, …]`; violations = count of `ok: false`
scopes with an open policy-violation event.

---

## 4. UI states & interactions

### 4.1 Rail (`<Rail>`)

Nav model (order and copy are exact):

```jsx
const NAV = [
  { id: "board",    label: "Board",        icon: "board" },
  { id: "review",   label: "Review queue", icon: "inbox" },
  { id: "agents",   label: "Agents",       icon: "agents" },
  { id: "policy",   label: "Policy",       icon: "shield" },
  { id: "github",   label: "GitHub",       icon: "github" },
  { id: "activity", label: "Activity",     icon: "activity" },
  { id: "settings", label: "Settings",     icon: "sliders" },
];
```

- `<nav className="rail" aria-label="Primary">`.
- **Project switch** button at top (`.project-switch`, `title="All projects"`): name line
  `.pj-name` = "Viberr Core", meta line `.pj-meta` = `"akin-ozer/viberr · {membersCount} members"`,
  trailing chevron icon. Click → Home page (all projects). Real: `<Link to="/home">`.
- Section label `.rail-label` = "Workspace".
- Each item: `<button className={"nav-item" + (active ? " active" : "")}>` with `<Icon className="ico">`,
  the label, and an optional trailing `.count`:
  - **board** count = `tasks.length` (ALL tasks, every stage — not "open tasks").
  - **review** count = `tasks.filter(t => t.stage === "review").length`.
  - **settings** count = open policy violations, only rendered when `> 0`, styled inline
    `style={{ color: "var(--coral-dark)", fontWeight: 700 }}` (mock: 1 until scope granted).
- `.rail-spacer` pushes nothing below it in this file (Home page uses the slot); keep the div.
- Clicking a nav item = `goView(id)`: switch view **and clear any open task** (`setOpenKey(null)`).
  Real: `<NavLink>` per route; active state from the router instead of `view === n.id`.

### 4.2 Topbar

Layout order: brand, crumbs, search, bell, user. Verbatim structure:

```jsx
<div className="topbar">
  <button className="home-brand" onClick={() => { location.href = "Viberr Home.html"; }} title="Home — all projects">
    <span className="mark">V</span>
    <b>Viberr</b>
  </button>
  <div className="crumbs">
    <button className="crumb-root" onClick={goBoard}>Viberr Core</button>
    <span className="sep sep-root"><Icon name="chevron" /></span>
    {open
      ? <><button className="crumb-mid" onClick={goBoard}>Board</button>
          <span className="sep sep-mid"><Icon name="chevron" /></span>
          <span className="cur" title={open.key + " · " + open.title}>{open.key} · {open.title}</span></>
      : <span className="cur">{view === "notifications" ? "Notifications" : (NAV.find((n) => n.id === view) || {}).label}</span>}
  </div>
  <div className="top-search">
    <Icon name="search" />
    <input placeholder="Search tasks, branches, agents…" aria-label="Search tasks, branches, agents" />
    <span className="kbd">⌘K</span>
  </div>
  <TopBell … />
  <TopUser … />
</div>
```

- **Crumbs**: root crumb "Viberr Core" and (task open) mid crumb "Board" both navigate to the board.
  Current segment `.cur` gets a `title` tooltip with the full `KEY · Title` and ellipsizes via CSS.
  The `view === "notifications"` branch is **dead code** (notifications is an overlay, `view` is
  never set to it) — drop or keep for safety, but don't build a route for it.
- **Truncation tiers** are pure CSS (`viberr.css` — ported verbatim, listed here so nobody "fixes" them):
  - base: `.crumbs { flex: 1 1 auto; min-width: 0; overflow: hidden }`, `.cur` = `white-space: nowrap;
    overflow: hidden; text-overflow: ellipsis; flex: 0 1 auto; min-width: 0` — the task title
    ellipsizes before anything else moves.
  - `@media (max-width: 1080px)`: hide `.home-brand b` (wordmark, "V" mark stays), hide `.kbd`, hide
    `.crumb-root` + `.sep-root`; search shrinks (`flex-basis: 260px; min-width: 130px`).
  - `@media (max-width: 760px)`: also hide `.crumb-mid` + `.sep-mid`; search shrinks further.
- **Search**: purely decorative in the mock — no onChange, no ⌘K key binding, no results. Port the
  markup as-is; wiring real search (and the ⌘K palette) is out of scope for the shell port unless
  separately specced (see Open questions).

### 4.3 Bell popover (`<TopBell>`)

Trigger button:

```jsx
<button type="button" className="icon-btn bell-btn"
  aria-label={"Notifications" + (unread > 0 ? " — " + unread + " unread" : "")}
  aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((b) => !b)}>
  <Icon name="bell" />
  {unread > 0 && <span className="bell-badge">{unread}</span>}
</button>
```

Popover (rendered as sibling **before** the trigger, inside `.home-user-wrap`; a `.menu-scrim` div
behind it closes on click; **no Escape handling in the mock** — add it in the port):

```jsx
<div className="ntf-pop" role="dialog" aria-label="Notifications" data-screen-label="Notifications popover">
  <div className="ntf-pop-head">
    <h3>Notifications</h3>
    <span className="ct mono">{unread > 0 ? unread + " unread" : "caught up"}</span>
    {unread > 0 && <button className="btn ghost sm" onClick={onReadAll}>Mark all read</button>}
  </div>
  <div className="ntf-pop-list">…items…</div>
  <div className="ntf-pop-foot">
    <button className="btn ghost sm" onClick={() => { setOpen(false); onSeeAll(); }}>See all<Icon name="arrow" /></button>
  </div>
</div>
```

Per-item icon/color mapping (exact — the `act-*` classes are the timeline event palette):

```jsx
const meta = (n) =>
  n.kind === "packet"   ? (n.ptype === "blocked" ? { icon: "alert", cls: "act-blocked" }
                                                 : { icon: "check", cls: "act-completion" })
  : n.kind === "approval" ? { icon: "arrow",   cls: "act-transition" }
  : n.kind === "mention"  ? { icon: "message", cls: "act-comment" }
  : n.kind === "quality"  ? { icon: "flag",    cls: "act-quality" }
  :                         { icon: "alert",   cls: "act-policy" };   // "policy" + fallback
const plain = (s) => (s || "").replace(/\*\*/g, "").replace(/`/g, "");  // strip md markers
```

Item markup (verbatim — note `.read` modifier is applied when NOT unread, and the meta line's
time format: today shows bare time, other days show `"{day} {t}"`):

```jsx
<button type="button" key={n.id} className={"ntf-item" + (n.unread ? "" : " read")}
  onClick={() => {
    onRead(n.id); setOpen(false);
    if ((n.project || "Viberr Core") !== "Viberr Core") { push(n.project + " — that workspace isn't built in this prototype"); return; }
    onOpenTask(n.task);
  }}>
  <span className={"pev-ico " + m.cls}><Icon name={m.icon} /></span>
  <span className="ntf-item-main">
    <span className="tt">{n.title || plain(n.text)}</span>
    {n.title && <span className="tx">{plain(n.text)}</span>}
    <span className="mt">{(n.project || "Viberr Core") + " · " + n.task + " · " + (n.day === "Today" ? n.t : ((n.day || "") + " " + n.t).trim())}</span>
  </span>
  {n.unread && <span className="unread-dot"></span>}
</button>
```

Behaviors:

- **Click item** → mark that notification read (state + persisted), close popover, then:
  - same-project → open the task (`setView("board"); setOpenKey(key)`; real: navigate to
    `/projects/…/task/KEY`).
  - other project → toast `"{project} — that workspace isn't built in this prototype"`.
    **Real app: navigate to that project's task instead** — the guard is prototype-only.
- **Mark all read** → all notifs read + persist + toast `"All notifications marked read"`.
- **See all** → close popover, open the Notifications page-overlay.
- Popover shows the **full list** (no cap) in a scrollable `.ntf-pop-list`.

### 4.4 User menu (`<TopUser>`)

Trigger: `<button className={"home-user" + (menu ? " open" : "")} aria-haspopup="menu"
aria-expanded={menu} aria-label="Account menu">` containing `<Avatar lg>`.

Menu (same scrim pattern; `role="menu"`, items `role="menuitem"`; class `user-menu from-top`):

- **Head** (`.user-menu-head`): `<Avatar lg>` + `.who` = display name, `.role` = `arda@viberr.dev`
  (hardcoded — real: session email).
- **Profile & preferences** (icon `user`) → close menu, open Profile overlay.
- **Switch project** (icon `board`) → Home page hop. Real: `<Link to="/home">`.
- **Theme · {Light|Dark|System}** (icon `sparkle`) → cycles `light → dark → system → light`
  (`onTheme(theme === "light" ? "dark" : theme === "dark" ? "system" : "light")`). The current value
  is rendered in `var(--faint)` inside the label. **The menu intentionally stays open** so the user
  can keep cycling. App-level wrapper also toasts:
  `"Theme · System (follows your OS)"` / `"Theme · Dark"` / `"Theme · Light"`.
- `.menu-sep` divider.
- **Sign out** (`.menu-item.danger`, icon `ext`) → clear session, hop to Login. Real: POST to a
  `/logout` action that destroys the session cookie and redirects to `/login`.

No Escape-close or arrow-key navigation on this menu in the mock (scrim click / item click only) —
add Escape at minimum in the port. Note: `unread` and `onNav` props are passed to TopUser but
**never used** — drop them.

### 4.5 View routing

```jsx
{open
  ? <TaskDetail task={open} extraEvents={extra[open.key]} onComment={onComment} onResolve={onResolve}
      onAsk={() => setAsk((a) => a + 1)} ask={ask} push={push} me={me} myRole={myRole} onOwner={onOwnerAction}
      onPolicy={() => { setOpenKey(null); setView("policy"); }} />
  : view === "board"    ? <Board tasks={tasks} onOpen={setOpenKey…} onCreate={createTask} push={push} />
  : view === "review"   ? <ReviewQueue tasks={tasks} onOpen={…} onPolicy={() => goView("policy")} />
  : view === "agents"   ? <Agents tasks={tasks} onOpen={…} />
  : view === "policy"   ? <Policy tasks={tasks} onNav={goView} push={push} />
  : view === "github"   ? <GithubView tasks={tasks} onOpen={…} onNav={goView} push={push} scopeGranted={scopeGranted} />
  : view === "activity" ? <Activity tasks={tasks} extra={extra} onOpen={…} scopeGranted={scopeGranted} />
  :                       <Settings tasks={tasks} stages={stages} setStages={setStages} members={members} setMembers={setMembers}
                                    onOpen={…} onNav={goView} push={push} scopeGranted={scopeGranted} onGrantScope={grantScope} />}
```

Prop contract per child (what the real routes must supply via loader/action instead):

| Child | Mock props | Real source |
|---|---|---|
| TaskDetail | `task, extraEvents, onComment, onResolve, onAsk/ask, push, me, myRole, onOwner, onPolicy` | task loader (file store + projection); actions: comment, resolve, owner; `me/myRole` from session |
| Board | `tasks, onOpen, onCreate, push` | project tasks loader; create action |
| ReviewQueue | `tasks, onOpen, onPolicy` | loader (review-stage filter can be server-side) |
| Agents | `tasks, onOpen` | loader (+ `window.VIBERR.runtime` streams — separate spec) |
| Policy | `tasks, onNav, push` | policy loader |
| GithubView | `tasks, onOpen, onNav, push, scopeGranted` | loader incl. credential scope state |
| Activity | `tasks, extra, onOpen, scopeGranted` | activity/event projection loader (`extra` merge disappears) |
| Settings | `tasks, stages, setStages, members, setMembers, onOpen, onNav, push, scopeGranted, onGrantScope` | settings loader; stage/member/scope actions |

The `ask` mechanism: TaskDetail focuses its comment composer whenever the numeric `ask` prop
increments ("Ask operator" button). Prototype-only imperative-via-prop trick; in the port keep it
local to the task route (ref + callback or a `?compose=1` search param).

### 4.6 Overlays

`PageOverlay` (ui.jsx): `.confirm-scrim` click-to-close + `.page-overlay` with `role="dialog"
aria-modal="true" aria-label={label}`, an `.icon-btn.overlay-x` close button (`aria-label="Close"`),
`Escape` keydown closes, children inside `.page-overlay-body`.

- `overlay === "profile"` → `<Profile me setMe theme setTheme onNav push />`; `onNav` closes the
  overlay then switches view.
- `overlay === "notifications"` → `<Notifications items onRead onReadAll onOpen onNav />`; `onOpen`
  closes the overlay, opens the task if it exists in this project, else toasts the
  "isn't built in this prototype" message; `onNav` is a no-op here.

Real app: these can stay overlays (nested/parallel routes or modal state), but Profile edits and
read-state changes must be actions. Consider making them URL-addressable (`/profile`,
`/notifications`) since the Home page has the same surfaces.

### 4.7 Toasts

`useToasts` (ui.jsx): `push(text)` appends `{id: random, text}`, auto-removes after **2600 ms**.
`ToastHost`: `<div className="toast-wrap" role="status" aria-live="polite">` with
`<div className="toast"><Icon name="check" />{text}</div>` per toast. All toasts use the check icon
regardless of semantics. Keep as a client-side concern; drive from action results (fetcher data or
a flash-session message) rather than optimistic local pushes where the action can fail.

---

## 5. Events / mutations produced

Every handler below currently mutates React state only (`overrides`, `extra`, `created`, `notifs`)
and is lost on reload. Each must become a **real action** that (a) writes to the task file /
DB, (b) appends **typed timeline events** to the task record, (c) revalidates. Event text strings
below are the exact copy the mock writes — reuse them. All events are written with `actor` = the
signed-in human (`people.ARDA` in the mock) and `t: "now"` (real: server timestamp).

### 5.1 Comment (`onComment(text)`) → action on task route

- Agent-routing detection: `/@(agent|operator|codex|claude)\b/i.test(text)`.
- Writes: `{ type: "comment", actor: ME, t: now, text, to: toAgent ? "agent" : null }`.
- Toast: `"Comment posted · routed to mentioned agent"` or `"Comment posted"`.
- Real: also actually notify/route to the operator runtime when `to === "agent"`.

### 5.2 Ownership (`onOwnerAction(action, person)`) → action on task route

Three branches:

1. **`release`** — `forced` = current owner exists and isn't me (admin releasing someone else).
   - Patch: `owner: null`.
   - Event (`type: "assign"`):
     - forced: `` Released **{name}** from task ownership (admin) — the seat is open to any project member. ``
     - self: `Released task ownership — review & acceptance stall until another member takes the seat.`
   - Toast: forced → `"{FirstName} released from {KEY} · admin action"`; self → `"Ownership released on {KEY}"`.
   - RBAC (from `policy.rbac`): take/release own ownership = every role; "Release any task owner" =
     admin only. Enforce server-side.
2. **`assign` + person** — hand to a member.
   - Patch: `owner: person`.
   - Event: `` Handed task ownership to **{name}** — they hold review & acceptance for this task now. ``
   - Toast: `"Ownership handed to {FirstName}"`.
3. **default (take)** —
   - Patch: `owner: ME`.
   - Event: taking over → `` Took over task ownership from **{name}** — owner is the human reviewer and acceptance authority. ``;
     fresh take → `Took task ownership — owner is the human reviewer and acceptance authority for this task.`
   - **VIB-148 demo script**: additionally patches `readiness: "ready"`, `waiting: "agent"` and
     appends an operator event (`type: "agent"`, actor `{ name: "Operator", kind: "agent" }`):
     `` Acceptance boundary now owned by **Arda Kaya** — scheduling execution against the quality-gated scope. ``
     **Generalize in the real app**: when a Ready-stage task that was waiting only on a human owner
     gains one, the operator runtime reacts and schedules execution — this is operator behavior, not
     a client-side special case keyed to a task id.
   - Toast: `"You own {KEY} · review & acceptance"`.

### 5.3 Task create (`createTask({ title, goal, stage })`) → action on board route

- Key allocation: `max(existing numeric suffixes) + 1` → `"VIB-" + n` (mock parses with
  `t.key.slice(4)` — prefix-length assumption; real: atomic per-project counter in SQLite).
- New task record defaults (exact):

```
goal: goal || "Goal to be refined at the triage quality gate.",
stage, readiness: "input", specialist: null, owner: null,
operator: stage === "triage" ? null : { name: "Operator", since: "stage 1" },
consultants: [], waiting: "human", urgent: false, validation: "none",
branch: null, repo: "akin-ozer/viberr", pr: null, timeline: [],
```

  Note the rule: **no operator is instantiated for Triage-stage tasks**; any other starting stage
  gets one immediately.
- Toast: `"{KEY} created in {StageName} — its task.md is in the store"` (stage name resolved via
  `stages.find(s => s.id === stage).name`, falling back to the raw id).
- Real: create `.viberr/tasks/{KEY}/task.md` + projection row; if not triage, spin up the operator.

### 5.4 Packet resolve (`onResolve({ option })`) → action on task route

First, regardless of branch: mark this task's `packet` and `approval` notifications read (state +
persisted read-ids). Real: same, as part of the action.

Then branch **by option title string** (fragile — see Porting notes; `choice = option.t`):

1. **`"Block on policy"`** (VIB-142 packet option):
   - Event `type: "blocked"`: `` **Decision:** hold on policy. {KEY} stays blocked until the project credential policy is updated. ``
   - Patch: `readiness: "blocked", waiting: "human"`.
   - Navigation: close task, go to **Settings** view.
   - Toast: `"Task held on policy · opening repository settings"`.
2. **`"Hold for runtime debug"`** (VIB-160 packet option):
   - Event `type: "blocked"`: `` **Decision:** hold for runtime debug. {KEY} stays blocked while the provider-native session is inspected — findings come back as task comments. ``
   - Patch: `readiness: "blocked"` (waiting unchanged).
   - Toast: `"Held for runtime debug — the session is recorded per audit policy"`.
3. **`option.accept === true`** ("Accept completion"):
   - Event `type: "completion"`, `title: "Completion accepted"`:
     `` Human acceptance recorded. Task transitioned to **Done** and review PR approved for merge. ``
   - Patch: `stage: "done", readiness: "done", waiting: "none", packet: null,`
     `pr: pr ? { ...pr, state: "merged" } : pr`.
   - Toast: `"Completion accepted · {KEY} moved to Done"`.
   - RBAC: "Accept completion → Done" = admin/maintainer only; Review → Done is the human-locked
     boundary (`policy.transitions`). Enforce server-side.
4. **default** (send-back options like "Request one edit", "Resume rehydrated thread",
   "Start a fresh specialist"):
   - Event `type: "transition"`, text = `option.ev` if present, else
     `` **Decision:** {choice}. Operator re-engages the specialist with a summon note. ``
     (`option.ev` carries option-specific copy authored in the packet — see `data.js` packets.)
   - Patch: `waiting: "agent", readiness: "ready", packet: null`.
   - Toast: `"Decision recorded: {choice}"`.

### 5.5 Scope grant (`grantScope()`) → action on settings route

- Sets `scopeGranted` (real: update credential scopes; `pull_request:write.ok = true`).
- Appends to **VIB-142** a `type: "policy"` event, actor `{ name: "Policy engine", kind: "system" }`:
  `` **Policy update:** `pull_request:write` granted on the project credential. The earlier violation is resolved — PR auto-sync will work after merge. ``
- Toast: `"Scope granted · VIB-142 policy flag resolved"`.
- Real: the "which task gets the event" link comes from the violating scope's `task` field
  (`policy.repo.scopes[].task`), not a hardcoded key. Also resolve the open violation in
  `policy.events` (`open: true` → closed).

### 5.6 Notification reads → actions (fetchers, no navigation)

- `readNotif(id)`: mark one read; persist (`markNotifsRead([id])` in mock).
- Read-all: map all to read; persist all ids; toast `"All notifications marked read"`.
- Packet resolution auto-reads related packet/approval notifs (§5.4).
- Real: `UPDATE notifications SET read_at = … WHERE user_id = ? AND id IN (…)`; unread badge count
  comes from the layout loader and revalidates.

### 5.7 Theme change → client-side + persisted pref

`setTheme(v)` = state + `savePrefs({ theme: v })` (persist + re-apply `data-theme`). Real: cookie
write (action or client fetch) + immediate DOM apply for responsiveness.

### 5.8 Stage / member edits (Settings passes through the shell)

`setStages` / `setMembers` write back to the globals so re-mounts see fresh data. Real: settings
actions; drop the pass-through props entirely (Settings loads its own data).

---

## 6. CSS classes used (structural contract)

Shell layout: `app`, `rail`, `main`, `topbar`.

Rail: `project-switch`, `pj-name`, `pj-meta`, `rail-label`, `nav-item` (+ `active`), `count`
(inside nav-item), `rail-spacer`, `ico` (icon sizing inside nav).

Topbar: `home-brand` (+ inner `mark`, `<b>` wordmark), `crumbs`, `crumb-root`, `crumb-mid`,
`sep sep-root`, `sep sep-mid`, `cur`, `top-search`, `kbd`, `icon-btn`, `bell-btn`, `bell-badge`.

Popovers/menus: `home-user-wrap` (positioning wrapper — used by BOTH bell and user menu),
`menu-scrim`, `user-menu from-top`, `user-menu-head`, `who`, `role`, `menu-item` (+ `danger`),
`menu-sep`, `home-user` (+ `open`).

Notifications popover: `ntf-pop`, `ntf-pop-head`, `ct mono`, `ntf-pop-list`, `ntf-item` (+ `read`),
`pev-ico` + one of `act-blocked | act-completion | act-transition | act-comment | act-quality |
act-policy`, `ntf-item-main`, `tt`, `tx`, `mt`, `unread-dot`, `ntf-pop-foot`, `btn ghost sm`.

Overlay: `confirm-scrim`, `page-overlay`, `overlay-x`, `page-overlay-body`.

Toasts: `toast-wrap`, `toast`.

Shared primitives: `avatar` (+ `lg`, tone `rose|teal|violet`), `agent-glyph` (+ `claude|codex`, `lg`),
`who-chip`, `nm`, `sub`, `pill` (+ kind `ready|input|risk|blocked|done|neutral`, `sm`, `pdot`),
`tgl` (+ `on`, `knob`).

Also load-bearing: `data-theme` / `data-motion` attributes on `<html>`, and `data-screen-label`
attributes on dialogs (used by the design-review tooling/screenshots — keep them).

---

## 7. Porting notes

**Prototype-only mechanics → replacements**

| Mock mechanic | Replace with |
|---|---|
| Hash routing, read once at boot, never updated | RR v7 routes: workspace layout + child routes + `task/:taskKey`; `<NavLink>`/`navigate()`; back/forward work for free |
| `window.VIBERR.*` globals | Loaders: task projection (SQLite over the file store), stages/policy/members, notifications, session user |
| `localStorage["viberr:session"]` + `location.replace("Viberr Login.html")` | Cookie session; layout-loader guard → `redirect("/login")`; sign-out = logout action |
| `location.href = "Viberr Home.html"` (brand, project switch, user menu) | `<Link to="/home">` |
| `created` / `overrides` / `extra` in-memory layering | Gone entirely — actions mutate store, loaders return current truth, revalidation replaces the memo |
| `setStages`/`setMembers` writing back to `window.VIBERR` | Settings-route actions |
| `localStorage["viberr:notifs:read"]` + `markNotifsRead` | Per-user read rows in SQLite (shared with Home surfaces by construction) |
| `me` state + name-matched `myRole` | Session user + membership-row role; ownership comparisons by **user id**, not display name |
| Cross-project notification guard toast ("…isn't built in this prototype") | Real navigation to `/projects/{other}/task/{KEY}` |
| VIB-148 special case in take-ownership | Operator-runtime rule: Ready-stage + quality-gate-passed + owner acquired → schedule execution + typed operator event |
| VIB-142 hardcoded in `grantScope` | Violating scope's `task` reference drives which task gets the policy event |
| `onResolve` branching on `option.t` strings | Typed option kinds on the packet record, e.g. `action: "accept" \| "send_back" \| "block_policy" \| "hold_debug"`; keep `ev` copy as the event-text template |
| `t: "now"` event timestamps | Server timestamps; render relative/day-bucketed like existing data (`day` + `t`) |
| `ask` increment-counter prop for composer focus | Route-local ref/callback or search param |
| Key allocation `max+1` via `key.slice(4)` | Atomic per-project sequence in SQLite; prefix from project config |
| `unread`/`onNav` props on TopUser | Drop (unused) |

**Edge cases & gaps to handle**

- Unknown task key in URL: mock crashes (finds `undefined`, TaskDetail explodes). Real: 404 boundary.
- Board count is **all tasks** including Done — confirm intent before "improving" it (see Open
  questions); Review count is stage-filtered.
- `plain()` markdown-stripping in the bell must match wherever notification text renders richly
  (Notifications page renders `**bold**`/`` `code` `` — the popover deliberately strips it).
- Timezone/time buckets: notification meta shows `t` alone only when `day === "Today"`; otherwise
  `"{day} {t}"` trimmed. Keep the same formatter server-side or ship raw timestamps + shared
  formatter.
- Bell popover and user menu have no Escape/arrow-key handling in the mock (scrim only). Add
  Escape-close; PageOverlay already handles Escape but doesn't trap focus or restore it — add both.
- Toast auto-dismiss 2600 ms, ids from `Math.random()` — fine to keep client-side; don't SSR toasts.
- Theme: resolve on the server from a cookie to avoid FOUC; `system` still needs the
  `prefers-color-scheme` listener client-side; keep `data-motion` for reduced motion.
- Notifications list in the popover is unbounded; with real data cap it (e.g. latest 8) — the
  "See all" overlay is the full list. Mock shows all 10.
- Empty states: zero notifications renders an empty `.ntf-pop-list` (header says "caught up") — mock
  never exercises it; design a minimal empty row. Zero tasks → board/review counts render "0"
  (mock always has data).
- `violations` badge: only the Settings nav item shows it, and only when `> 0`.
- Concurrency: two users resolving the same packet — action must be idempotent/guarded
  (packet already null → 409 or no-op with toast).
- The session-guard boot also implies: signed-out users deep-linking to `/projects/...` land on
  login and should be returned post-auth (`?redirectTo=`) — mock loses the hash.

**Deliberate mock behaviors to KEEP**

- Theme menu item does not close the menu (rapid cycling UX).
- Crumb `title` tooltip carries the untruncated `KEY · Title`.
- "Mark all read" button only rendered when there are unread items; header count text flips to
  `"caught up"`.
- Nav click always closes an open task (task view is "inside" Board for crumb purposes only).
- Packet resolution "Block on policy" navigates to Settings — a cross-view jump triggered by an
  action result (implement as action → `redirect` or client navigate on success).

---

## 8. Open questions

1. **Board rail count semantics** — `tasks.length` includes Done tasks. Intended ("all tasks in the
   project") or should it be open-tasks-only in the real app?
2. **Search & ⌘K** — the topbar search is inert in the mock. Is a command palette in scope for the
   shell port, or does the input stay decorative (disabled?) until a search spec exists?
3. **Overlay routing** — should Profile / Notifications overlays be URL-addressable routes
   (shareable, back-button-friendly) or ephemeral UI state? The Home page reuses both surfaces,
   which argues for routes.
4. **Cross-project notification navigation** — target URL scheme for other projects
   (`Deploy Pipeline`, `Billing Service`) once multi-project exists; until then, keep the toast or
   hide foreign items?
5. **Operator scheduling side-effects** (VIB-148 generalization) — does taking ownership *always*
   flip `waiting → agent` when the quality gate has passed, or only when the operator confirms? Who
   writes the `readiness: "ready"` patch — the ownership action or the operator runtime reacting to
   it?
6. **Packet option typing** — proposed `action` enum in §7; confirm the canonical set and where
   option copy (`t`, `d`, `ev`) lives in the task file schema.
7. **`me.name` editing** — Profile lets the user rename themselves; in the real app does display
   name propagate to historical timeline events (actor snapshots vs. user-id joins)?
8. **`data-screen-label` attributes** — keep in production markup or strip (currently used by
   design tooling)?
