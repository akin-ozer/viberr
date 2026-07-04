# Porting spec — Home (multi-project landing)

Source: `design/html-app/app/home.jsx` (637 lines), entry `design/html-app/Viberr Home.html`.
Shared helpers: `design/html-app/app/ui.jsx`. Mock data: `design/html-app/app/data.js`, `design/html-app/app/org-settings.jsx` (ORG_DEFAULTS/loadOrg/saveOrg).
Stylesheets loaded by the entry page: `app/viberr.css` then `app/home.css` (home.css layers page-specific rules on top; both are ported verbatim — class names below are the contract).

Target route: `/` (RR7 SSR). Related routes referenced from this page: `/projects/:slug/board`, `/projects/:slug/tasks/:key`, `/org/settings` (tabs), `/profile`, `/notifications`, `/login`, `/logout`.

---

## 1. Purpose & entry points

Post-login landing page for the whole instance (org level, above any single project board). It has its own header (NOT the workspace rail/topbar from `main.jsx`) and shows:

1. A greeting hero with org-wide agent activity stats.
2. The project directory: pinned + all projects, grid or list view, client-side search.
3. A "New governed project" modal (name/key/connection/repo/template/policy).
4. An org **Settings** panel with three tiles that deep-link into instance settings (GitHub connections / Users & access / Agent resources).
5. A footer "store strip" with a **Re-scan** action for the file-native task store.
6. Header widgets shared with the workspace: notifications bell + popover, user/account menu.
7. Full-page overlays for **Profile & preferences** and **Notifications** (rendered by components from `profile.jsx` / `notifications.jsx` — separate specs).

### Prototype entry & routing (to be replaced)

- `Viberr Home.html` boot: if `window.VIBERR.session.get()` is null → `location.replace("Viberr Login.html")`, else render `<HomeApp/>` into `#root`. **Real app:** the `/` loader requires a server session; unauthenticated → redirect `/login`.
- Hash routing inside the page (`parseRoute`):
  - `#settings` or `#settings/(connections|users|resources)` → renders `<OrgSettings tab=…/>` **in place of** `main.home-shell` (header stays). Default tab `connections`.
  - `#profile` / `#notifications` → open the corresponding `PageOverlay` on load. Closing the overlay clears the hash via `history.replaceState(null, "", location.pathname + location.search)`.
  - anything else → projects view.
  - `hashchange` listener keeps `route` in sync.
- Project cards all navigate to the single hard-coded workspace page: `const WORKSPACE = "Viberr Operator Workspace.html"` — every card's `<a href>` goes there regardless of project. **Real app:** each card links to `/projects/:slug/board` for its own project.
- **Real routing decision:** per `docs/build/CONVENTIONS.md`, org settings is `/org/settings` (tabbed), profile is `/profile`, notifications is `/notifications`. The mock renders org-settings inline under the Home header and profile/notifications as overlays over Home; keep the visual containers (`.page-overlay`, Home header above OrgSettings) but drive them with real routes (nested/parallel routes or state + URL sync — see Open questions).

---

## 2. Component tree

All in `home.jsx` unless noted. Suggested target: `app/features/home/`.

- **`HomeApp`** — page root; owns all state (view, stars, created, org, route, overlay, query, modal, menu, bell, scanning, theme, notifs, toasts).
  - `header.home-top > .home-top-in`
    - brand button (`.home-brand`) — back to projects view + scroll top.
    - `.top-search` — project filter input with ⌘K shortcut and `.kbd` hint.
    - `.home-user-wrap` #1 — bell button (`.bell-btn` + `.bell-badge`) and inline **notifications popover** (`.ntf-pop`, built inline in HomeApp, uses `homeNtfMeta` + `plainTxt` helpers).
    - `.home-user-wrap` #2 — avatar button (`.home-user`) and inline **user menu** (`.user-menu.from-top`).
  - When route = settings: **`OrgSettings`** (from `org-settings.jsx`, separate spec) with `{tab, onTab, onBack, org, patchOrg, push}`.
  - Else `main.home-shell`:
    - `.home-hero` — greeting `h1`, stats sentence `p.sub`, `.hero-actions` (grid/list `.seg` toggle + New project button).
    - `.empty-hero` — zero-projects empty state (behind dead `t.emptyPreview` flag in mock; must be real when project count is 0).
    - `section` "Pinned" (only when pinned exist) → `renderGroup(pinned)`.
    - `section` "Everything else"/"All projects" → `renderGroup(rest)` + `.pj-new` create tile.
    - `section.panel` "Settings" — three `.org-tile` buttons.
    - `footer.store-strip` — Re-scan button.
  - **`NewProjectModal`** `{connections, onClose, onCreate}` — create-project dialog.
  - **`PageOverlay`** (ui.jsx) wrapping **`Profile`** (profile.jsx) or **`Notifications`** (notifications.jsx).
  - **`ToastHost`** (ui.jsx).
- **`StarIco`** `{on}` — local star SVG (filled when on); NOT in the shared `Icon` set — port alongside.
- **`StageMeter`** `{dist}` — horizontal stacked bar of task counts per stage.
- **`ProjectStats`** `{p}` — "N tasks · N agents running / quiet" + "N waiting on you" pill.
- **`MemberStack`** `{members}` — overlapping `Avatar` row inside `span.stack`.
- **`ProjectCard`** `{p, starred, onStar, showDesc}` — grid card.
- **`ProjectRow`** `{p, starred, onStar}` — list row.
- **`keyFromName`** — derives task key from project name (see §5.9).
- Helpers: `plainTxt(s)` strips `**` and `` ` `` from notification text; `homeNtfMeta(n)` maps notification kind → icon+color class (see §5.3).

From `ui.jsx` (shared, ported once to `app/ui/`): `Icon` (stroke SVG set — home uses `search, github, plus, x, bell, arrow, chevron, board, review, sliders, user, sparkle, ext, refresh, alert, check, message, flag, lock, shield, bolt, memory`), `Pill`, `Avatar`, `AgentGlyph`, `PageOverlay`, `TglP`, `useToasts`/`ToastHost`.

---

## 3. Data consumed

### 3.1 Project directory (mock: hard-coded `HOME.projects` inside home.jsx)

Exact per-project shape consumed by the UI:

```js
{
  id: "viberr-core",            // slug — becomes :slug in real routes
  name: "Viberr Core",
  key: "VIB",                   // task key prefix, ≤4 uppercase letters
  repo: "akin-ozer/viberr",     // owner/name of default GitHub repo
  desc: "The governed delivery layer itself — …",   // 1–2 sentence description
  dist: { triage: 2, ready: 3, impl: 4, review: 3, done: 2 },  // task count per stage id
  running: 3,                   // active agent runs in this project
  waiting: 2,                   // decisions waiting on the signed-in user
  members: [P.ARDA, P.ELIF, …], // people: { name, initials, tone } (tone: "" | "rose" | "teal" | "violet")
  updated: "2m ago",            // relative time of last activity (display string in mock)
  starred: true,                // seed pin state (mock only)
  accent: "#5b76fe",            // assigned at runtime, see below
}
```

Accent assignment (mock): `HOME.projects` entries have **no** accent; `HomeApp` assigns `ACCENTS[i % ACCENTS.length]` over the combined `[...created, ...HOME.projects]` list, with `ACCENTS = ["#5b76fe", "#187574", "#e8a800", "#c2602e", "#7b61ff", "#00b473"]`. Because created projects are *prepended*, creating a project shifts every existing project's accent — a mock bug. **Real app:** store the accent on the project record at creation (cycle through the palette or hash the id) so it is stable.

**Real sources:**
- Project list + name/key/repo/desc/members: project projection (SQLite `projects` + membership, backed by project file in the store).
- `dist`: aggregate over `task_projections` grouped by stage per project. Stage ids/names/colors come from the project's workflow definition; the mock's canonical five are `window.VIBERR.stages` (data.js lines 4–10): `triage #a5a8b5 "Triage"`, `ready #187574 "Ready"`, `impl #7b61ff "In Progress"`, `review #5b76fe "Review"`, `done #00b473 "Done"`. StageMeter must iterate the project's *own* stage list, not a global constant.
- `running`: count of active agent runs per project (runs table).
- `waiting`: count of open packets/approvals addressed to the **current user** in that project ("waiting on you" is user-specific — see Open questions).
- `updated`: most recent event/projection timestamp per project; format relative on render.
- `starred` (pins) and `view` (grid/list): per-user preferences. Mock persists in `localStorage["viberr:home"]` as `{ view, stars: {id: bool}, created: [...] }`. Real: user-prefs storage (DB) so pins follow the user.

### 3.2 Session / identity

- `sessName`: `((window.VIBERR.session.get() || {}).name || "Arda Kaya").split(" ")[0]` — first name only, in the greeting. Real: session user's name from the loader.
- `me = window.VIBERR.people.ARDA` (hard-coded) used for user-menu avatar and as sole member of newly created projects. Real: session user.
- User-menu email is a hard-coded string `arda@viberr.dev`. Real: session user's email.
- `meProf` local state `{ name: "Arda Kaya", title: "Senior engineer" }` fed to `Profile` — real: user record via loader/fetcher.

### 3.3 Notifications (mock: `window.VIBERR.notifications`, data.js lines 676–711)

Item shape:

```js
{
  id: "n-142-packet",
  kind: "packet" | "approval" | "mention" | "quality" | "policy",
  ptype: "input" | "blocked",           // packet kind only
  unread: true,
  day: "Today" | "Yesterday",           // display bucket
  t: "9:41",                            // display time
  from: { name, kind: "agent"|"system" } | person,   // not rendered in the popover
  task: "VIB-142",                      // task key — click target
  project: "Viberr Core",               // defaulted to "Viberr Core" when absent
  title: "Completion report — waiting on your acceptance",  // optional; falls back to text
  text: "Workspace attach implemented, **PR #318** open, …" // may contain **bold** and `code` markers
}
```

The popover strips markdown markers with `plainTxt` (no rich rendering in the popover; the full Notifications page does render them). Read state in the mock is shared across Home and workspace via `localStorage["viberr:notifs:read"]` (array of ids) + `window.VIBERR.markNotifsRead(ids)`. **Real:** notifications projection scoped to the user, `unread` from a per-user read-state table; mark-read is an action.

### 3.4 Org settings summary (mock: `loadOrg()` from org-settings.jsx, persisted at `localStorage["viberr:org:v10"]`)

Home reads only counts/labels from `org` for the three tiles:

- `org.connections`: `[{ id, owner, method: "PAT", repos, def: bool, expires, daysLeft }]` — tile shows `connections.length` and `connections.map(c => c.owner).join(" · ")` (or "none connected"). Also passed into `NewProjectModal`.
- `org.users`: `[{ id, name, email, initials, tone, role: "admin"|"member", status, you?, idp }]` — tile shows first 5 avatars, total count, `X admins · Y members` split (`role === "admin"` vs rest).
- `org.gagents` (length → "N global agents"), `org.kbs`, `org.mcps`, `org.skills` (lengths → "X knowledge bases · Y MCP · Z skills").

**Real:** one loader query over org tables (connections, users, agent profiles, KBs, MCP servers, skills). `patchOrg` is only used by OrgSettings, not by Home itself.

### 3.5 Misc

- Greeting: `new Date().getHours()` → `<12` "Good morning", `<18` "Good afternoon", else "Good evening". Client-local time — beware SSR hydration mismatch (see Porting notes).
- Theme: `window.VIBERR.prefs.theme` + `window.VIBERR.savePrefs({theme})` (ui.jsx `initPrefs`, `localStorage["viberr:prefs"]`, applies `document.documentElement.dataset.theme/.motion`). Real: per Conventions — profile pref + cookie for SSR-safe first paint.
- `t = { density: "comfortable", descriptions: true, emptyPreview: false }` — hard-coded leftover of a removed tweaks panel (the file header still mentions `tweaks-panel.jsx`, which `Viberr Home.html` does not even load). `t.density` → `data-density="comfortable"` on the root div; `t.descriptions` → show card descriptions in grid; `t.emptyPreview` → force empty state. **Real:** drop the flag object; root keeps `data-density="comfortable"` as a static attribute; descriptions always on; empty state driven by actual `projects.length === 0`.

---

## 4. Verbatim markup for tricky pieces

### 4.1 StageMeter (proportional stacked bar)

```jsx
function StageMeter({ dist }) {
  const stages = window.VIBERR.stages;                    // real: project's workflow stages
  const total = stages.reduce((a, s) => a + (dist[s.id] || 0), 0);
  if (!total) return <div className="pj-meter empty" title="No tasks yet"></div>;
  const label = stages.map((s) => (dist[s.id] || 0) + " " + s.name.toLowerCase()).join(" · ");
  return (
    <div className="pj-meter" title={label}>
      {stages.map((s) => {
        const n = dist[s.id] || 0;
        if (!n) return null;
        return <span key={s.id} style={{ flex: n, background: s.color, opacity: s.id === "done" ? 0.45 : 1 }}></span>;
      })}
    </div>
  );
}
```

Notes: segments are flex-weighted by count; `done` renders at 0.45 opacity; tooltip like `"2 triage · 3 ready · 4 in progress · 3 review · 2 done"`; zero-task projects get `.pj-meter.empty` with `title="No tasks yet"`.

### 4.2 ProjectStats

```jsx
<div className="pj-stats">
  <span>{total + " task" + (total === 1 ? "" : "s")}</span>
  {p.running > 0 && (
    <React.Fragment>
      <span>·</span>
      <span className="running"><span className="working"></span>{p.running + " agent" + (p.running === 1 ? "" : "s") + " running"}</span>
    </React.Fragment>
  )}
  {p.running === 0 && total > 0 && <React.Fragment><span>·</span><span>quiet</span></React.Fragment>}
  {p.waiting > 0 && <Pill kind="input" sm>{p.waiting} waiting on you</Pill>}
</div>
```

`.working` is the pulsing activity dot (CSS animation). A project with 0 tasks and 0 running shows only "0 tasks".

### 4.3 ProjectCard (grid) — star button is a SIBLING of the link, not inside it

```jsx
<article className="pj-card" data-screen-label={"Project card — " + p.name}>
  <a className="pj-link" href={WORKSPACE} aria-label={"Open " + p.name + " board"}>
    <div className="pj-top">
      <span className="pj-mark" style={{ boxShadow: "inset 0 -8px 0 " + p.accent }}>{p.name[0]}</span>
      <span className="pj-name">
        <span className="nm">{p.name}<span className="key">{p.key}</span></span>
        <span className="repo"><Icon name="github" />{p.repo}</span>
      </span>
    </div>
    {showDesc && <p className="pj-desc">{p.desc}</p>}
    <StageMeter dist={p.dist} />
    <ProjectStats p={p} />
    <div className="pj-foot">
      <MemberStack members={p.members} />
      <span className="upd">updated {p.updated}</span>
    </div>
  </a>
  <button className={"pj-star" + (starred ? " on" : "")} onClick={() => onStar(p.id)}
    aria-label={(starred ? "Unpin " : "Pin ") + p.name} title={starred ? "Unpin" : "Pin"}>
    <StarIco on={starred} />
  </button>
</article>
```

`pj-mark` shows the first character of the name; the accent is an inline `box-shadow: inset 0 -8px 0 <accent>` underline (this dynamic inline style is intentional — keep it, do not tokenize).

### 4.4 ProjectRow (list) — same pieces flattened, plus chevron

```jsx
<article className="pj-row" data-screen-label={"Project row — " + p.name}>
  <a className="pj-link" href={WORKSPACE} aria-label={"Open " + p.name + " board"}>
    <span className="pj-mark" style={{ boxShadow: "inset 0 -7px 0 " + p.accent }}>{p.name[0]}</span>
    <span className="pj-name">
      <span className="nm">{p.name}<span className="key">{p.key}</span></span>
      <span className="repo"><Icon name="github" />{p.repo}</span>
    </span>
    <StageMeter dist={p.dist} />
    <ProjectStats p={p} />
    <MemberStack members={p.members} />
    <span className="go"><Icon name="chevron" /></span>
  </a>
  <button className={"pj-star" + (starred ? " on" : "")} …same as card… </button>
</article>
```

Note the inset is `-7px` in rows vs `-8px` in cards.

### 4.5 MemberStack

```jsx
<span className="stack" aria-label={members.map((m) => m.name).join(", ")}>
  {members.map((m, i) => <Avatar key={i} person={m} />)}
</span>
```

### 4.6 Notification popover item

```jsx
<button type="button" key={n.id} className={"ntf-item" + (n.unread ? "" : " read")} onClick={() => openNotif(n)}>
  <span className={"pev-ico " + m.cls}><Icon name={m.icon} /></span>
  <span className="ntf-item-main">
    <span className="tt">{n.title || plainTxt(n.text)}</span>
    {n.title && <span className="tx">{plainTxt(n.text)}</span>}
    <span className="mt">{(n.project || "Viberr Core") + " · " + n.task + " · " + (n.day === "Today" ? n.t : ((n.day || "") + " " + n.t).trim())}</span>
  </span>
  {n.unread && <span className="unread-dot"></span>}
</button>
```

Meta line examples: `Viberr Core · VIB-142 · 9:41` (today) / `Viberr Core · VIB-145 · Yesterday 16:04`.

### 4.7 Hero stats sentence (exact copy)

```jsx
<p className="sub">
  {t.emptyPreview
    ? "No projects yet — create your first governed project below."
    : <React.Fragment>
        Your agents kept working — <b><span className="working"></span>{totalRunning} runs active</b> across {activeIn} projects,{" "}
        <b>{totalWaiting} decisions</b> waiting on you.
      </React.Fragment>}
</p>
```

`totalRunning = Σ p.running`, `totalWaiting = Σ p.waiting`, `activeIn = count(p.running > 0)` — computed over ALL projects (not the filtered list).

### 4.8 Org settings tile (one of three; all share the structure)

```jsx
<button className="org-tile go" onClick={() => goSettings("connections")}>
  <span className="lbl"><Icon name="github" />GitHub connections</span>
  <span className="val">
    <span>
      <span className="nm">{org.connections.length} connection{org.connections.length === 1 ? "" : "s"}</span>
      <div className="sub">{org.connections.map((c) => c.owner).join(" · ") || "none connected"}</div>
    </span>
  </span>
  <span className="foot go-hint">Manage<Icon name="arrow" /></span>
</button>
```

Users tile `val` additionally leads with `<MemberStack members={org.users.slice(0, 5)} />`; resources tile leads with `<span className="glyphs"><AgentGlyph backend="codex" /><AgentGlyph backend="claude" /></span>` and `nm` = `{org.gagents.length} global agents`, `sub` = `{org.kbs.length} knowledge bases · {org.mcps.length} MCP · {org.skills.length} skills`.

### 4.9 New project modal — full structure (abridged only where repetitive)

```jsx
<React.Fragment>
  <div className="confirm-scrim" onClick={onClose}></div>
  <div className="modal-card" role="dialog" aria-modal="true" aria-label="New project" data-screen-label="New project modal">
    <div className="modal-head">
      <span className="pj-mark" style={{ boxShadow: "inset 0 -8px 0 color-mix(in srgb, var(--blue), transparent 55%)" }}>{(name.trim()[0] || "•").toUpperCase()}</span>
      <span className="mh-main">
        <h2>New governed project</h2>
        <div className="mh-sub">One board, one repo, agents under policy from day one</div>
      </span>
      <button className="icon-btn modal-close" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
    </div>
    <div className="modal-body">
      <div className="key-row">
        <div className="field">
          <label className="flabel" htmlFor="np-name">Project name<span className="req">*</span></label>
          <input id="np-name" type="text" ref={nameRef} value={name} placeholder="e.g. Payments Gateway"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submit(); }} />
        </div>
        <div className="field">
          <label className="flabel" htmlFor="np-key">Task key</label>
          <input id="np-key" type="text" className="mono" value={effKey} placeholder="PAY"
            onChange={(e) => { setKeyTouched(true); setKey(e.target.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4)); }} />
        </div>
      </div>
      <div className="field">
        <span className="flabel">GitHub connection <span className="fhint">sets the repository root</span></span>
        <div className="pick-chips">
          {connections.map((c) => (
            <button key={c.id} className={"pick-chip" + (connId === c.id ? " on" : "")} onClick={() => setConnId(c.id)}>
              <Icon name="github" />{c.owner}/
            </button>
          ))}
        </div>
        {connections.length === 0 && (
          <div className="def-note"><Icon name="alert" /><span>No GitHub connections. Add one in <b>Viberr settings → GitHub connections</b> first.</span></div>
        )}
      </div>
      <div className="field">
        <label className="flabel" htmlFor="np-repo">GitHub repository <span className="fhint">project default · task-level override later</span></label>
        <div className="repo-input">
          <span className="pre">{conn.owner}/</span>
          <input id="np-repo" type="text" value={repo} placeholder={effRepo || "repo-name"} onChange={(e) => setRepo(e.target.value)} />
        </div>
      </div>
      <div className="field">
        <span className="flabel">Workflow template</span>
        <div className="pick-chips">
          <button className={"pick-chip" + (template === "governed" ? " on" : "")} onClick={() => setTemplate("governed")}>
            <span className="sdot" style={{ background: "var(--blue)" }}></span>Governed default · 5 stages
          </button>
          <button className={"pick-chip" + (template === "light" ? " on" : "")} onClick={() => setTemplate("light")}>
            <span className="sdot" style={{ background: "var(--teal-dark)" }}></span>Lightweight · 3 stages
          </button>
        </div>
      </div>
      <div className="field">
        <span className="flabel">Agent policy preset</span>
        <div className="pick-chips">
          <button className={"pick-chip" + (policy === "strict" ? " on" : "")} onClick={() => setPolicy("strict")}><Icon name="lock" />Strict human-gate</button>
          <button className={"pick-chip" + (policy === "balanced" ? " on" : "")} onClick={() => setPolicy("balanced")}><Icon name="shield" />Balanced · recommended</button>
          <button className={"pick-chip" + (policy === "auto" ? " on" : "")} onClick={() => setPolicy("auto")}><Icon name="bolt" />Autonomous within policy</button>
        </div>
        <div className="def-note">
          <Icon name="shield" />
          <span>Completion stays human-authorized in every preset. Stages, RBAC and the agent capability matrix can be refined in project settings.</span>
        </div>
      </div>
    </div>
    <div className="modal-foot">
      <span className="foot-hint mono">creates ~/viberr/projects/{effKey || "KEY"}/</span>
      <span className="foot-actions">
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={!ok} style={!ok ? { opacity: 0.55, pointerEvents: "none" } : null} onClick={submit}>
          <Icon name="plus" />Create project
        </button>
      </span>
    </div>
  </div>
</React.Fragment>
```

### 4.10 Empty state (`.empty-hero`)

```jsx
<div className="empty-hero" data-screen-label="Empty state">
  <span className="plus"><Icon name="plus" /></span>
  <h2>Create your first governed project</h2>
  <p>A project is one board, one repo, and a policy that decides what agents may do on their own — and what waits for you.</p>
  <div className="empty-steps">
    <span className="st"><span className="n">1</span>Connect a repository</span>
    <span className="st"><span className="n">2</span>Define workflow stages</span>
    <span className="st"><span className="n">3</span>Put agents under policy</span>
  </div>
  <button className="btn primary" onClick={() => setModal(true)}><Icon name="plus" />New project</button>
</div>
```

---

## 5. UI states & interactions (complete inventory)

### 5.1 Header / brand
- `.home-brand` button (`title="Viberr"`, contents `<span className="mark">V</span><b>Viberr</b>`): navigates to projects view (`location.hash = ""`) and `window.scrollTo({ top: 0 })`. Works as "leave settings sub-page" too.

### 5.2 Search (`.top-search`)
- Input `placeholder="Find a project…"`, `aria-label="Find a project"`; `.kbd` shows `⌘K`.
- Global keydown: `(metaKey || ctrlKey) + "k"` → `preventDefault()` + focus the input.
- Filter: case-insensitive substring over `p.name + " " + p.key + " " + p.repo`. Applies to both pinned and rest groups.
- Typing while on the settings sub-page navigates back to the projects view first (`if (route.page !== "projects") goProjects()`).
- No results: `.empty` div with text `No project matches “{query}”.` (curly quotes, trailing period) — shown in the second section only; the `.pj-new` tile is hidden whenever `query` is non-empty.

### 5.3 Notifications bell + popover
- Bell button: `.icon-btn.bell-btn`, `aria-label` = `"Notifications"` or `"Notifications — N unread"`, `aria-haspopup="dialog"`, `aria-expanded`, toggles `bell`. Badge `.bell-badge` with raw unread count when > 0.
- Popover `.ntf-pop` (`role="dialog"`, `aria-label="Notifications"`) with `.menu-scrim` behind (click closes). No Escape handling in mock (add it — Conventions require Escape on dialogs).
- Head: `<h3>Notifications</h3>`, `.ct.mono` = `"{unread} unread"` or `"caught up"`; when unread > 0 a `.btn.ghost.sm` **Mark all read** → marks all + toast `All notifications marked read`.
- List: all notifications (no cap in mock), item markup in §4.6. Icon/color mapping (`homeNtfMeta`):
  - `packet` + `ptype:"blocked"` → icon `alert`, class `act-blocked`
  - `packet` (other) → `check`, `act-completion`
  - `approval` → `arrow`, `act-transition`
  - `mention` → `message`, `act-comment`
  - `quality` → `flag`, `act-quality`
  - anything else (i.e. `policy`) → `alert`, `act-policy`
- Item click (`openNotif`): mark that id read, then `goTask(n.task)`.
- `goTask` prototype guard: if the notification's project ≠ "Viberr Core" → toast `{project} — that workspace isn't built in this prototype` and do NOT navigate; else `location.href = WORKSPACE + "#task/" + key`. **Real:** always navigate to `/projects/:slug/tasks/:key` (needs project slug on the notification row); delete the guard and toast.
- Foot: `.btn.ghost.sm` **See all** with trailing `arrow` icon → closes popover, opens the Notifications overlay.

### 5.4 User menu
- Trigger: `.home-user` button (`.open` class while open), `aria-haspopup="menu"`, `aria-expanded`, `aria-label="Account menu"`, contents `<Avatar person={me} lg />`.
- Menu `.user-menu.from-top` (`role="menu"`) + `.menu-scrim`. Head: large avatar + `.who` (name) + `.role` (email — hard-coded `arda@viberr.dev` in mock, must come from session).
- Items (`.menu-item`, `role="menuitem"`):
  1. `Profile & preferences` (icon `user`) → close menu, open profile overlay.
  2. `Theme · {System|Dark|Light}` (icon `sparkle`; current value in `color: var(--faint)` span) → cycles `light → dark → system → light` and persists via `savePrefs`. Menu stays open so the label updates in place.
  3. `.menu-sep` divider.
  4. `Sign out` (`.menu-item.danger`, icon `ext`) → `session.clear()` + go to login. **Real:** POST `/logout` action.
- No Escape/arrow-key handling in mock; scrim click closes.

### 5.5 Hero
- `h1`: `{greet}, {firstName}` (greet rule §3.5).
- Stats sentence §4.7 (or the empty-state sentence when no projects).
- View toggle: `.seg` with `role="group"` `aria-label="View"`; buttons `Grid` (icon `board`) and `List` (icon `review`); active gets class `on`; persisted (`saveHomeState({view})`).
- **New project** `.btn.primary` (icon `plus`) → opens modal. Also present in the empty state and as `.pj-new` tile(s).

### 5.6 Sections & pinning
- Pinned section only when `pinned.length > 0`: `.sec-h` = filled `StarIco on` + `<h2>Pinned</h2>` + `.ct` count. `data-screen-label="Pinned projects"`.
- Second section `.sec-h` = icon `board` + `<h2>` `Everything else` (when pinned exist) or `All projects` + `.ct` count. `data-screen-label="All projects"`.
- `renderGroup`: grid → `.pj-grid` of `ProjectCard` (with `showDesc`); list → `.pj-list` of `ProjectRow`.
- Create tile after the rest-group (only when `!query`):
  - grid: `<button className="pj-new"><span className="plus"><Icon name="plus" /></span>New project</button>`
  - list: same button with inline styles `{ minHeight: 0, padding: ".7rem", marginTop: ".5rem" }` and inner `<span style={{ display:"inline-flex", alignItems:"center", gap:".45rem" }}><Icon name="plus" />New project</span>` (port these inline styles as-is or promote to a `.pj-new.row` rule in the appended CSS section).
- Star toggle (card & row): optimistic flip + persist + toast `Pinned — it will stay at the top` / `Unpinned`. `aria-label`/`title` `Pin {name}` / `Unpin {name}`. Pinned projects move between the two sections immediately.

### 5.7 Settings panel
- `.panel` with `.panel-head` = icon `sliders` + `<h2>Settings</h2>`; `data-screen-label="Settings"`.
- Three `.org-tile.go` buttons (§4.8): navigate to `#settings/connections|users|resources` → real: `/org/settings?tab=…` or nested routes. Footer label on each: `Manage` + `arrow` icon.
- Pluralization: `connection{s}`, `user{s}`; admins/members line: `{X} admins · {Y} members` (no singularization in mock).

### 5.8 Store strip (Re-scan)
- `footer.store-strip` with one `.btn.ghost.sm`: icon `refresh` (class `spin` while scanning), label `Scanning…` / `Re-scan`. Guarded against double-click while scanning.
- Mock: 1200 ms fake delay then toast `Store re-scanned — {N} project dirs, no drift found` (N = total project count). **Real:** action that triggers a task-store scan (watcher/projection rebuild) and reports actual dirs scanned + drift findings in the toast; error toast on failure.

### 5.9 New project modal behavior
- Opens from: hero button, `.pj-new` tiles, empty-state button. Closes on: scrim click, `.modal-close` X (`aria-label="Close"`), Cancel. **No Escape handling and no focus trap in mock** — add Escape close per Conventions; consider focus trap.
- Autofocus project-name input on mount.
- Task key derivation `keyFromName(name)`: uppercase, strip non `[A-Z ]`; multiple words → first letter of each word; single word → first 3 chars; result truncated to 4. Shown live until the user edits the key field once (`keyTouched`), after which manual value wins. Manual key input is uppercased, letters-only, max 4.
- Repo default `effRepo`: explicit repo input, else slugified name (`lowercase`, non-alphanumeric runs → `-`, trimmed of leading/trailing `-`). Repo input is prefixed with a static `.pre` = `{conn.owner}/`; the input placeholder is the derived slug or `repo-name`.
- Connection selection: default = connection with `def: true`, else first. Chips labeled `{owner}/` with github icon. Zero connections → `.def-note` warning (copy in §4.9) and the Create button stays disabled.
- Template: `governed` (default) / `light`. Policy: `strict` / `balanced` (default) / `auto`.
- Validity `ok`: trimmed name length > 1 AND effective key length ≥ 2 AND at least one connection. Invalid → Create button `disabled` + inline style `{opacity:.55, pointerEvents:"none"}`.
- Enter in the **name field only** submits (key/repo fields do not).
- Footer live hint: `creates ~/viberr/projects/{effKey || "KEY"}/` in `.foot-hint.mono` — real path should reflect the configured store root env var.
- Submit payload: `{ name, key: effKey, repo: conn.owner + "/" + (effRepo || "new-project"), connection: conn.id, template, policy }`.
- Modal-head `pj-mark` previews the first letter of the name (or `•`) with a blue `color-mix` accent (verbatim inline style, §4.9).

### 5.10 Post-create behavior (mock `createProject`)
- Builds project `{ id: key.toLowerCase()+"-"+Date.now().toString(36), name, key, repo, desc: synthesized, dist: {}, running: 0, waiting: 0, members: [me], updated: "just now", accent: "#5b76fe" }`.
- Synthesized desc: `"{Governed 5-stage workflow|Lightweight 3-stage workflow} · {strict human-gate policy.|agents act within policy.|balanced agent policy.}"` (light→first alt; strict/auto/balanced map in order shown).
- Prepends to `created` (persisted in `viberr:home.created`), closes modal, toast: `{KEY} initialized — task store created at ~/viberr/projects/{KEY}`.
- New project renders with the empty `.pj-meter.empty` bar ("No tasks yet") and "0 tasks" stats.
- **Real:** see §6.1.

### 5.11 Overlays
- `PageOverlay` (ui.jsx): `.confirm-scrim` (click closes) + `.page-overlay` (`role="dialog"`, `aria-modal="true"`, `aria-label`), `.overlay-x` close button, **Escape closes** (window keydown listener).
- Profile overlay: `label="Profile & preferences"`, renders `Profile({ me, setMe, theme, setTheme, onNav, push })`; `onNav` in mock jumps to workspace hash pages (`location.href = WORKSPACE + "#" + v`) — real: `navigate()` to the equivalent route.
- Notifications overlay: `label="Notifications"`, renders `Notifications({ items, onRead, onReadAll, onOpen, onNav })`; `onRead(id)` → mark one; `onReadAll` → mark all + toast; `onOpen` = `goTask`; `onNav` = no-op on Home.
- Deep links `#profile` / `#notifications` open the overlay on first paint (real: routes `/profile`, `/notifications`, possibly rendered as overlay over `/` — Open question).

### 5.12 Toasts
- `useToasts` / `ToastHost` (ui.jsx): `role="status"`, `aria-live="polite"`, check icon + text, auto-dismiss 2600 ms. All toast strings in this page: pin/unpin, mark-all-read, cross-project guard (delete in real app), create-project, re-scan.

### 5.13 Keyboard & a11y summary
- ⌘K/Ctrl-K → focus search (global).
- Enter in modal name field → submit.
- Escape closes PageOverlay only (mock); extend to popover/menu/modal in port.
- All interactive elements are real `<button>`/`<a>`; cards are fully clickable links with `aria-label="Open {name} board"`; star buttons are separate siblings so pinning never triggers navigation.
- `data-screen-label` attributes exist on: root, cards, rows, modal, empty state, sections, settings panel, store strip, popover, overlays — prototype screenshot tooling; keep or drop consistently (Open question).

---

## 6. Events / mutations produced

Mock mutations and their real counterparts:

| # | Mock behavior | Real action | Side effects / events |
|---|---|---|---|
| 6.1 | `createProject` → localStorage `viberr:home.created`, toast | `POST` action `project.create` with `{name, key, repo, connectionId, template, policy}` | Validate key uniqueness + repo; create project dir under the store root (`~/viberr/projects/KEY/` in mock copy — use configured env root); write project file (workflow stages from template, policy preset, default repo/connection, creator as member); insert projection row; **audit event** `project.created`; SSE `projection.rebuilt` (or a project-level event). No task timeline exists yet (no tasks). Idempotency-safe per Conventions. Post-create: mock stays on Home with the new card first — decide whether to redirect to the new board (Open question). |
| 6.2 | Pin/unpin star → `viberr:home.stars` | user-pref mutation (fetcher) `home.pin` `{projectId, pinned}` | Per-user, not governed; no audit/timeline. Optimistic OK (not governed state). |
| 6.3 | Grid/list toggle → `viberr:home.view` | user-pref mutation `home.view` `{view: "grid"|"list"}` | Same as above; also SSR-read so first paint honors it. |
| 6.4 | Mark notification(s) read → `viberr:notifs:read` + local state | action `notifications.markRead` `{ids}` / `notifications.markAllRead` | Per-user read-state rows; revalidates bell badge; consider SSE `notification.read` for multi-tab. |
| 6.5 | Theme cycle → `savePrefs` + `dataset.theme` | profile-pref action + cookie (SSR-safe) | Per Conventions §Theme. |
| 6.6 | Sign out → `session.clear()` + `location.href` login | `POST /logout` | Destroys server session; audit optional. |
| 6.7 | Re-scan → fake 1200 ms + toast | action `store.rescan` (org- or instance-level) | Runs the file-store scan/reconcile; returns `{projectDirs, driftCount}` for the toast; **audit event** `store.rescanned` (admin-triggered maintenance). Long-op: server-derived progress, no spinner-forever. |
| 6.8 | Navigation (cards, tiles, brand, overlays, goTask) | plain `<Link>`/`navigate` | No mutations. |

**Typed timeline events:** Home itself writes none into any `task.md` (it never touches tasks). The only file-writing mutation is project creation (project file + store dir). Everything else is user-preference or session state.

---

## 7. CSS classes used (structural contract)

Ported verbatim; do not rename. File of origin noted (viberr.css = shared, home.css = page layer; some appear in both — home.css overrides).

**Page scaffold (home.css unless noted):** `home` (root, with `data-density`, also in viberr.css), `home-top`, `home-top-in`, `home-shell`, `home-hero`, `hero-actions`, `sec-h`, `ct` (both), `empty` (both), `store-strip`, `spin`.

**Header (viberr.css):** `home-brand` (+ inner `mark`), `top-search` (home.css) + `kbd`, `home-user-wrap`, `home-user` (+ `open`), `user-menu` + `from-top`, `user-menu-head`, `who`, `role`, `menu-item` (+ `danger`), `menu-sep`, `menu-scrim`, `icon-btn`, `bell-btn`, `bell-badge`.

**Notifications popover (viberr.css; container also in home.css):** `ntf-pop`, `ntf-pop-head`, `ntf-pop-list`, `ntf-pop-foot`, `ntf-item` (+ `read`), `ntf-item-main`, `tt`, `tx`, `mt`, `unread-dot`, `pev-ico` with kind classes `act-blocked`, `act-completion`, `act-transition`, `act-comment`, `act-quality`, `act-policy`.

**Project directory (home.css):** `pj-grid`, `pj-list`, `pj-card`, `pj-row`, `pj-link`, `pj-top`, `pj-mark`, `pj-name` (+ `nm`, `key`, `repo` — also in viberr.css), `pj-desc`, `pj-meter` (+ `empty`), `pj-stats` (+ `running`), `pj-foot`, `upd`, `pj-star` (+ `on`), `pj-new` (+ inner `plus`), `stack`, `go`, `working` (both).

**Empty state (home.css):** `empty-hero`, `plus`, `empty-steps`, `st`, `n`.

**Settings panel:** `panel`, `panel-head` (viberr.css), `org-tiles`, `org-tile` (+ `go`), `lbl`, `val`, `nm`, `sub`, `glyphs`, `foot`, `go-hint` (home.css).

**Modal (viberr.css; some in home.css too):** `confirm-scrim`, `modal-card`, `modal-head`, `mh-main`, `mh-sub`, `modal-close`, `modal-body`, `modal-foot`, `foot-hint` + `mono`, `foot-actions`, `key-row` (home.css), `field`, `flabel`, `req`, `fhint`, `repo-input` + `pre` (home.css), `pick-chips`, `pick-chip` (+ `on`), `sdot`, `def-note`.

**Shared primitives (viberr.css):** `btn` (+ `primary`, `ghost`, `sm`), `seg` (+ `on` buttons), `pill` (+ kind `input`, size `sm`), `pdot`, `avatar` (+ `lg`, tones `rose`/`teal`/`violet`), `agent-glyph` (+ `codex`/`claude`), `ico`, `toast-wrap`, `toast`, `page-overlay`, `page-overlay-body`, `overlay-x`.

---

## 8. Porting notes

Prototype-only → replacements:

1. **`window.VIBERR` globals** (`stages`, `people`, `notifications`, `session`, `prefs`, `markNotifsRead`) → loader data + actions. `HOME.projects` is defined inside home.jsx itself (not data.js) — it is seed/demo data; the real page lists projects from the DB/store. Keep it as seed-script content if useful.
2. **localStorage state** — `viberr:home` (view/stars/created), `viberr:org:v10`, `viberr:notifs:read`, `viberr:session`, `viberr:prefs` → server-side per-user prefs/session; theme keeps a cookie for first paint.
3. **Hash routing + `location.href` page hops** → RR7 routes/Links. `WORKSPACE + "#task/" + key` → `/projects/:slug/tasks/:key`. `#settings/*` → `/org/settings` tabs. Brand button → `<Link to="/">`.
4. **Cross-project guard** in `goTask` (toast "…that workspace isn't built in this prototype") → delete; navigate normally. Notification rows need project slugs.
5. **Dead `t` tweaks object** → remove; keep `data-density="comfortable"` static; descriptions always shown in grid; empty state = real `projects.length === 0` (the mock's `.empty-hero` markup is the real empty state, currently unreachable behind `emptyPreview: false`).
6. **Accent instability** — index-based accents shift when projects are created (§3.1). Persist accent per project at creation.
7. **StageMeter stage source** — reads global `window.VIBERR.stages`; must use each project's own workflow stages so a "light" 3-stage project renders correctly.
8. **Re-scan fake timeout** → real store scan action with server-derived result in the toast.
9. **Hard-coded identity** — `me = ARDA`, email string, `meProf` default, session-name fallback `"Arda Kaya"` → session user everywhere. No fallback name in real app (session always has a user).
10. **Greeting hydration** — `new Date().getHours()` differs server vs client; compute client-side after mount, or from a user-timezone-aware server value; avoid hydration warning.
11. **Escape/focus** — mock lacks Escape close on popover/menu/modal and any focus trap (only PageOverlay handles Escape). Conventions require Escape + scrim close on dialogs; add without changing markup.
12. **`dangerouslySetInnerHTML` Icon** — fine to port as-is into `app/ui/icon.tsx` (static path table).
13. **`data-screen-label`** attributes are prototype screenshot tooling — decide keep/drop globally (harmless if kept; must be consistent across ported pages).
14. **`~/viberr/projects/KEY/` copy** in modal footer + create toast should reflect the real configured store root (env) — keep the copy pattern, substitute the actual path or keep the `~`-style display form.
15. **Inline styles to preserve verbatim:** `pj-mark` accent box-shadows (−8px card / −7px row), modal-head `color-mix` accent, disabled Create button style, list-view `.pj-new` sizing overrides, `sdot` backgrounds (`var(--blue)`, `var(--teal-dark)`), theme label `color: var(--faint)`.
16. **Edge cases:** project with `dist: {}` (empty meter + "0 tasks", no dot separator, no pill); single task → "1 task"; `running===0 && total>0` → "quiet"; search hides `.pj-new`; pinned-only result set leaves second section showing count 0 with no empty text (mock shows the "No project matches" empty only when `rest.length === 0 && query`); pinned section disappears entirely when no pinned project matches the query; notifications `day` bucket other than "Today" is prefixed into the meta time; `title`-less notifications promote `text` into the `.tt` slot.
17. **Error states (new in real app):** create-project action failures (duplicate key, store write failure, no connection) need inline modal error presentation — mock has none; use `.def-note` with `alert` icon pattern for field-level errors and toast for transport errors. Re-scan failure → error toast. Loader failures follow global error boundary.

---

## 9. Open questions

1. **Project URL slug:** mock ids are kebab slugs (`viberr-core`) but created ids are `key.toLowerCase() + "-" + Date.now().toString(36)`. What is the canonical slug for `/projects/:slug` — stored slug from name, or the task key?
2. **"Waiting on you" semantics:** per-user (packets addressed to me) or project-wide open decisions? The copy says "waiting on you"; hero total says "{N} decisions waiting on you" — implies per-user. Confirm the projection query.
3. **Post-create navigation:** stay on Home with the new card first (mock) or redirect to the new project's board?
4. **Lightweight template stages:** "Lightweight · 3 stages" — which three? Not defined anywhere in the mock. Needs a workflow-template definition before the create action can write a project file.
5. **Profile/Notifications as routes vs overlays:** Conventions route map lists `/profile` and `/notifications` as routes; the mock renders them as overlays above Home (and the workspace renders its own versions). Render route content inside `PageOverlay` over `/`? Decide and document in the phase report.
6. **Notifications popover cap/ordering:** mock shows the entire list, newest first as authored. Cap (e.g. 8) with "See all", or keep unbounded scroll?
7. **Re-scan authorization:** admin-only or any member? It is instance-level maintenance surfaced to everyone in the mock.
8. **Pinned/view prefs storage:** dedicated `user_prefs` table vs JSON column on `users` — align with however profile prefs land in Phase 2/9.
9. **`updated` freshness:** relative strings ("2m ago") need either client-side re-rendering ticks or server format; also feeds from which event source — latest timeline event, projection rebuild time, or file mtime?
10. **Org tile counts for non-admins:** should members see Users/Connections/Resources tiles (read-only counts) or is the Settings panel admin-only? Mock shows it unconditionally.
