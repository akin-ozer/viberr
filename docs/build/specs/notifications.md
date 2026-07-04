# Porting spec — Notifications page + bell popover

Source files (mock, React+Babel prototype):
- `design/html-app/app/notifications.jsx` (the page — 120 lines, fully covered here)
- `design/html-app/app/main.jsx` — workspace shell: `TopBell` popover + overlay wiring + read-state callbacks
- `design/html-app/app/home.jsx` — Home shell: its own inline bell popover + overlay wiring (duplicated markup)
- `design/html-app/app/data.js` — `NOTIFICATIONS` fixture, `markNotifsRead`, localStorage read-state
- `design/html-app/app/ui.jsx` — `Icon`, `Pill`, `PageOverlay`, prefs (`notifs` routing defaults)
- `design/html-app/app/activity.jsx` — `RichA` mini-markdown renderer
- `design/html-app/app/viberr.css` — all classes referenced below (ported verbatim; **class names are the contract**)

Mock header comment: *"Notifications: typed events & mentions routed to you (FR16, FR24–FR26)"*.

---

## 1. Purpose & entry points

The Notifications surface is a **user-global** (cross-project) stream of typed events routed to the
signed-in user: decision packets, approval requests, mentions/replies, quality flags, and policy
events. It exists in two forms that share data and read state:

1. **Bell popover** — compact dropdown from the top-bar bell button. Present in BOTH shells:
   - Workspace shell (`main.jsx` → `TopBell` component, rendered in `.topbar`)
   - Home shell (`home.jsx` → inline JSX in the header, functionally identical)
2. **Full Notifications page** — the `Notifications` component from `notifications.jsx`, rendered
   inside a `PageOverlay` (full-page modal with scrim, Escape-to-close, close X). Opened by:
   - "See all" button in the bell popover footer (both shells)
   - On Home only: deep link hash `#notifications` opens the overlay on load
     (`/^#(profile|notifications)$/` parsed into initial overlay state; closing the overlay strips
     the hash via `history.replaceState`)
   - The workspace shell has **no** hash entry for notifications (its hash router only matches
     `#(board|review|agents|policy|github|activity|settings)` and `#task/KEY`).

In the real app this should become a real route (e.g. `/notifications`) with a loader, and the bell
popover should consume the same loader data / a lightweight projection endpoint. See Open questions.

Related but separate surface (do not port here): Profile → "Notification routing" panel
(`profile.jsx`, `ProFileNotifications`) which toggles per-kind delivery prefs. Referenced in §7.

---

## 2. Component tree

```
Notifications({ items, onRead, onReadAll, onOpen, onNav })   — page root; filter state; splits items
├── NtfNeedsYou({ items, onRead, onOpen })                   — "Waiting on you" panel: packet+approval rows (rq-row cards)
└── NtfStream({ items, onRead, onOpen })                     — "Everything else" panel: mention/quality/policy log lines grouped by day

TopBell({ notifs, unread, onRead, onReadAll, onOpenTask, onSeeAll, push })  — workspace bell + popover (main.jsx)
(HomeApp inline bell JSX)                                    — home bell + popover, same markup (home.jsx)

Module-level helpers in notifications.jsx:
  ntfMeta(n)  — maps kind (+ptype) → { icon, cls } for the pev-ico chip
  ntfPill(n)  — maps kind (+ptype) → { kind, label } for the type Pill

Shared primitives consumed:
  Icon(name)        — ui.jsx; inline stroke SVG, aria-hidden
  Pill({kind,sm})   — ui.jsx; span.pill.<kind>(.sm)
  PageOverlay       — ui.jsx; scrim + role="dialog" aria-modal + Escape handler + overlay-x close button
  RichA({text})     — activity.jsx; renders **bold** → <strong>, `code` → <code class="mono">
  useToasts/ToastHost — ui.jsx; shells push toasts on mark-all-read and cross-project dead ends
```

`onNav` is passed to `Notifications` by both shells as `() => {}` / unused inside the component —
**dead prop, drop it in the port.**

Note the mock has **three** copies of the kind→icon/color mapping: `ntfMeta` (notifications.jsx),
`meta` (inside `TopBell`, main.jsx), `homeNtfMeta` (home.jsx:71). All identical. Port as ONE shared
helper. Same for the markdown-stripper: `plain` (TopBell) and `plainTxt` (home.jsx:70) are both
`(s) => (s || "").replace(/\*\*/g, "").replace(/`/g, "")`.

---

## 3. Data consumed

### 3.1 Notification object shape (exact, from data.js:676–706)

```js
{
  id: "n-160-packet",          // string, unique
  kind: "packet" | "approval" | "mention" | "quality" | "policy",
  ptype: "blocked" | "input",  // ONLY on kind:"packet"; distinguishes blocked-decision vs completion-report
  unread: true,                // boolean; flipped by read-state overlay at load
  day: "Today" | "Yesterday",  // display grouping string (mock only — derive from timestamp in port)
  t: "10:31",                  // HH:MM display string (mock only — derive from timestamp)
  from: Identity,              // who produced it; see 3.2
  task: "VIB-160",             // task key; may belong to another project ("DEP-31", "BIL-9")
  project: "Viberr Core",      // ALWAYS set: data.js backfills `if (!n.project) n.project = "Viberr Core"`
  title: "Blocked decision — pick a recovery path",  // ONLY packet + approval kinds have titles
  text: "…",                   // mini-markdown: **bold** and `code` spans only (RichA grammar)
}
```

### 3.2 `from` Identity shapes seen in the fixture

```js
{ name: "Operator", kind: "agent" }                                  // packets & approvals
{ name: "Policy engine", kind: "system" }                            // policy events
{ kind: "agent", backend: "claude", name: "Claude Code", role: "Reviewer" }  // quality flag (claude("Reviewer") builder)
{ kind: "human", name: "Elif Demir", initials: "ED", tone: "rose" }  // mentions (ELIF)
{ kind: "human", name: "Murat Yıldız", initials: "MY", tone: "teal" }// replies (MURAT)
```

The page only reads `from.name` (in `NtfStream`). The bell popover reads none of `from`.

### 3.3 Full fixture (verbatim copy — use as seed data; final render order after splices)

| # | id | kind | ptype | unread | day / t | task | project | title | text |
|---|----|------|-------|--------|---------|------|---------|-------|------|
| 1 | `n-160-packet` | packet | blocked | ✓ | Today 10:31 | VIB-160 | Viberr Core | Blocked decision — pick a recovery path | Provider history unavailable and two rehydrate checks failing. The specialist continues from \`task.md\` once you choose. |
| 2 | `n-dep-31` | packet | input | ✓ | Today 10:12 | DEP-31 | **Deploy Pipeline** | Completion report — staging promotion ready | Pipeline stage rework validated on a dry run. Promotion to staging needs your acceptance. |
| 3 | `n-142-packet` | packet | input | ✓ | Today 9:41 | VIB-142 | Viberr Core | Completion report — waiting on your acceptance | Workspace attach implemented, \*\*PR #318\*\* open, validation green. Only a human can move it to Done. |
| 4 | `n-bil-9` | approval | — | ✓ | Today 8:47 | BIL-9 | **Billing Service** | Transition request — Ready → In Progress | Strict human-gate project: execution can't start without a maintainer approval. |
| 5 | `n-145-approval` | approval | — | ✓ | Today 9:12 | VIB-145 | Viberr Core | Transition request — In Progress → Review | SSE fan-out demo recorded and evidence attached. This boundary needs a maintainer approval. |
| 6 | `n-142-policy` | policy | — | ✓ | Today 9:38 | VIB-142 | Viberr Core | — | \*\*Policy violation:\*\* the active PAT is missing \`pull_request:write\` — PR auto-sync will fail after merge. |
| 7 | `n-142-quality` | quality | — | ✗ | Today 9:20 | VIB-142 | Viberr Core | — | \*\*Quality flag:\*\* snapshot \`task_projection.json\` changed — confirm the compact shape before review. |
| 8 | `n-148-mention` | mention | — | ✗ | Today 8:20 | VIB-148 | Viberr Core | — | mentioned you — "needs a reviewer to own the acceptance gate. \*\*@arda\*\* can you take it?" |
| 9 | `n-145-blockedact` | policy | — | ✗ | Yesterday 16:04 | VIB-145 | Viberr Core | — | Blocked agent action: Developer (Codex) attempted \*\*Merge a pull request\*\* — reserved for humans. |
| 10 | `n-160-reply` | mention | — | ✗ | Yesterday 11:20 | VIB-160 | Viberr Core | — | replied to you — "opened the Developer runtime session to debug continuity; findings come back as task comments." |

(The mock builds this via two `splice` calls inserting the cross-project rows at positions 1 and 3 —
the table above is the resulting order. List order is **newest-first by convention, but literally
fixture order**; note #5 (9:12) sits after #4 (8:47) — the mock does NOT sort. The port should sort
by real timestamp descending.)

### 3.4 Read state

- Mock: `localStorage["viberr:notifs:read"]` = JSON array of read notification ids. Applied once at
  data load (`unread = false` for matching ids). `window.VIBERR.markNotifsRead(ids)` unions ids into
  the array. Monotonic — there is no "mark unread".
- Comment in data.js: *"Read-state is per user and shared across surfaces (Home + workspace)."*
- **Real app**: per-user read state in SQLite, e.g. `notification_reads(user_id, notification_id, read_at)`
  or a `read_at` column on a per-user notifications table. Must be shared by the bell popover, the
  page, and any future email digest logic.

### 3.5 Where the data must come from in the real app

- Notifications are **derived from typed timeline events** across all projects the user is a member
  of. The five kinds map to event/timeline types that already exist in the mock's task timelines:
  - `packet` (ptype blocked) ← Operator decision packet on a blocked task
  - `packet` (ptype input) ← Operator completion report awaiting human acceptance
  - `approval` ← Operator transition request at an approval boundary
  - `mention` ← comment events containing `@user` or replies to the user
  - `quality` ← specialist quality-flag events on tasks where the user owns review/acceptance
  - `policy` ← policy-engine violations and blocked-agent-action events on tasks the user can see
- Recommended: a **projection query** (SQLite) over the event log, materialized per user at event
  append time (fan-out on write) or computed on read, filtered by the user's routing prefs
  (`prefs.notifs[kind].app` — see §7). The mock does NOT filter by prefs; the real app should.
- `project` name and `task` key come from the owning project/task; cross-project rows must carry
  enough info to build a real link (project slug + task key).
- Session (mock: `localStorage["viberr:session"]`; both shells `location.replace` to login if
  absent) → real server session; the notifications loader requires an authenticated user.

---

## 4. UI states & interactions

### 4.1 Page root (`Notifications`)

Local state: `f` = `"all" | "unread"` (default `"all"`).

Derived:
- `unread` = count of `items` with `unread`
- `match(n)` = `f === "unread" ? n.unread : true`
- `needs` = items where `kind === "packet" || kind === "approval"` AND `match(n)` → NtfNeedsYou
- `rest` = all other kinds AND `match(n)` → NtfStream

Markup skeleton (structural classes are the contract):

```jsx
<div className="board-wrap" data-screen-label="Notifications">
  <div className="board-head">
    <div>
      <h1>Notifications</h1>
      <div className="sub">Everything routed to you, across all projects{unread > 0 ? " · " + unread + " unread" : " · all caught up"}</div>
    </div>
    <div className="board-tools">
      <div className="mini-seg" role="radiogroup" aria-label="Filter notifications">
        {[["all", "All"], ["unread", "Unread"]].map(([id, l]) => (
          <button type="button" key={id} className={f === id ? "on" : ""} onClick={() => setF(id)}>{l}</button>
        ))}
      </div>
      {unread > 0 && (
        <button className="btn ghost sm" onClick={onReadAll}><Icon name="check" />Mark all read</button>
      )}
    </div>
  </div>
  <div className="policy-wrap">
    <NtfNeedsYou items={needs} onRead={onRead} onOpen={onOpen} />
    <NtfStream items={rest} onRead={onRead} onOpen={onOpen} />
  </div>
</div>
```

User-visible copy:
- Title: **"Notifications"**
- Subtitle: **"Everything routed to you, across all projects · 6 unread"** / **"… · all caught up"**
- Filter labels: **"All"**, **"Unread"**
- **"Mark all read"** button (ghost, small, check icon) — only rendered when `unread > 0`. Clicking
  invokes shell callback which marks everything read AND toasts **"All notifications marked read"**.

A11y as-built: the filter is `role="radiogroup"` but the buttons have no `role="radio"`/`aria-checked`
— active state is only the `on` class. Port may add proper radio semantics (visuals unchanged), but
keep the exact class names.

### 4.2 "Waiting on you" panel (`NtfNeedsYou`) — packet & approval cards

Verbatim JSX (this is the tricky packet-card markup — reproduce exactly):

```jsx
<div className="panel">
  <div className="panel-head"><Icon name="hand" /><h2>Waiting on you</h2>
    <span className="right sub" style={{ fontSize: ".76rem", color: "var(--faint)" }}>
      {items.length} decision{items.length === 1 ? "" : "s"}
    </span>
  </div>
  <div className="rq-list">
    {items.map((n) => {
      const m = ntfMeta(n);
      const p = ntfPill(n);
      return (
        <button type="button" className="rq-row" key={n.id} onClick={() => { onRead(n.id); onOpen(n.task); }}>
          <span className={"pev-ico " + m.cls}><Icon name={m.icon} /></span>
          <span className="rq-main">
            <div className="ttl">{n.title}{n.unread && <span className="unread-dot in" />}</div>
            <div className="sub"><span className="mono">{n.task}</span> · <RichA text={n.text} /></div>
          </span>
          <span className="rq-meta">
            {n.project && n.project !== "Viberr Core" && <Pill kind="neutral" sm>{n.project}</Pill>}
            <Pill kind={p.kind} sm>{p.label}</Pill>
            <span className="pev-t">{n.day === "Today" ? n.t : n.day.toLowerCase() + " " + n.t}</span>
          </span>
        </button>
      );
    })}
    {!items.length && <div className="empty">Nothing is waiting on you.</div>}
  </div>
</div>
```

Behavior details:
- Header: hand icon + **"Waiting on you"** + right-aligned count **"{N} decision"/"{N} decisions"**
  (count reflects the CURRENT filter, i.e. under "Unread" it counts unread decisions only).
- The whole row is one `<button>`: click **marks read then navigates** (`onRead` then `onOpen(task)`).
- Unread indicator: inline `unread-dot in` dot appended to the title (the `.in` variant is the
  inline-block version of the dot).
- Project pill (`Pill kind="neutral" sm`) shown **only for cross-project rows** (project !==
  "Viberr Core"; in the port: !== current/home project convention — see Open questions).
- Type pill via `ntfPill`:
  - `approval` → `Pill kind="info"` label **"approval"**
  - `packet` + `ptype:"blocked"` → `Pill kind="blocked"` label **"blocked decision"**
  - `packet` otherwise → `Pill kind="input"` label **"completion report"**
- Time: `"Today"` renders bare `t` (e.g. `10:31`); other days render lowercased day + time (e.g.
  `yesterday 16:04`) in `.pev-t` (mono, faint).
- Empty state copy: **"Nothing is waiting on you."** (shown when no packets/approvals match filter).

### 4.3 "Everything else" panel (`NtfStream`) — mention/quality/policy log lines

Grouped by `day` preserving first-appearance order (`[...new Set(items.map(n => n.day))]` — with
sorted real data this is just date-descending groups). Verbatim JSX for the log line:

```jsx
<div className="panel">
  <div className="panel-head"><Icon name="bell" /><h2>Everything else</h2></div>
  {days.map((day) => (
    <div key={day}>
      <div className="act-day">{day}</div>
      {items.filter((n) => n.day === day).map((n) => {
        const m = ntfMeta(n);
        return (
          <div className={"pol-ev ntf-ev" + (n.unread ? " unread" : "")} key={n.id}
            onClick={() => onRead(n.id)} title={n.unread ? "Click to mark read" : undefined}>
            <span className={"pev-ico " + m.cls}><Icon name={m.icon} /></span>
            <span className="pev-main">
              <strong className="act-actor">{n.from.name}</strong>
              <span className="act-sep">·</span>
              <RichA text={n.text} />
              {" "}<button type="button" className="keybtn" onClick={(e) => { e.stopPropagation(); onRead(n.id); onOpen(n.task); }}>{(n.project && n.project !== "Viberr Core" ? n.project + " · " : "") + n.task}</button>
            </span>
            {n.unread && <span className="unread-dot" />}
            <span className="pev-t">{n.t}</span>
          </div>
        );
      })}
    </div>
  ))}
  {!items.length && <div className="empty">You're caught up.</div>}
</div>
```

Behavior details:
- Header: bell icon + **"Everything else"**.
- Day group label: `.act-day` with raw day string (**"Today"**, **"Yesterday"**).
- Row click (anywhere) **only marks read** — it does NOT navigate. Tooltip `title="Click to mark
  read"` only while unread.
- The **task-key chip** (`.keybtn`) inside the text is the navigation affordance: it
  `stopPropagation()`s, marks read, then `onOpen(task)`. Label is `"VIB-148"` or, cross-project,
  `"Deploy Pipeline · DEP-31"` (no cross-project rows exist in the stream fixture today, but the
  code path exists).
- Line reads: **actor name** (bold, `.act-actor`) `·` (`.act-sep`) rich text, e.g.
  *"**Elif Demir** · mentioned you — "needs a reviewer to own the acceptance gate. **@arda** can you
  take it?" `VIB-148`"*.
- Unread: block-level `unread-dot` between text and time; `.ntf-ev.unread .pev-main` renders text in
  full-strength `--fg` (read rows are muted).
- Time: bare `.pev-t` `t` only (day is the group header).
- Empty state copy: **"You're caught up."**
- A11y as-built: the row is a clickable `<div>` (no role/tabindex) with a nested real `<button>`.
  Port should make the row keyboard-accessible without nesting interactive elements invalidly
  (e.g. row as button + inner chip as separate sibling-positioned button, preserving classes).

### 4.4 Kind → icon/color mapping (`ntfMeta` — single source of truth for BOTH page and popovers)

| kind | condition | Icon name | pev-ico class |
|------|-----------|-----------|----------------|
| packet | `ptype === "blocked"` | `alert` | `act-blocked` |
| packet | otherwise | `check` | `act-completion` |
| approval | | `arrow` | `act-transition` |
| mention | | `message` | `act-comment` |
| quality | | `flag` | `act-quality` |
| policy (and any unknown kind — default branch) | | `alert` | `act-policy` |

Rendered as `<span className={"pev-ico " + cls}><Icon name={icon} /></span>` everywhere.

### 4.5 Bell button + popover (both shells; markup identical — port ONCE)

Trigger button (verbatim):

```jsx
<button type="button" className="icon-btn bell-btn" aria-label={"Notifications" + (unread > 0 ? " — " + unread + " unread" : "")}
  aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((b) => !b)}>
  <Icon name="bell" />
  {unread > 0 && <span className="bell-badge">{unread}</span>}
</button>
```

(Home's aria-label uses `unread ?` instead of `unread > 0 ?` — same result; badge is the raw count,
no 99+ clamping.)

Popover (verbatim, workspace version; wrapped in `div.home-user-wrap` alongside the button, with a
`div.menu-scrim` behind it that closes on click — there is NO Escape handling on the popover):

```jsx
<div className="ntf-pop" role="dialog" aria-label="Notifications" data-screen-label="Notifications popover">
  <div className="ntf-pop-head">
    <h3>Notifications</h3>
    <span className="ct mono">{unread > 0 ? unread + " unread" : "caught up"}</span>
    {unread > 0 && <button className="btn ghost sm" onClick={onReadAll}>Mark all read</button>}
  </div>
  <div className="ntf-pop-list">
    {notifs.map((n) => {
      const m = meta(n);
      return (
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
      );
    })}
  </div>
  <div className="ntf-pop-foot">
    <button className="btn ghost sm" onClick={() => { setOpen(false); onSeeAll(); }}>See all<Icon name="arrow" /></button>
  </div>
</div>
```

Popover semantics:
- Lists **all** notifications, unfiltered, ungrouped, in stream order; `.ntf-pop-list` scrolls at
  `max-height: 420px`.
- Item title line `.tt`: `title` if present, else the **markdown-stripped** text (`plain()` removes
  `**` and `` ` `` — RichA is NOT used in the popover; text is plain).
- Second line `.tx` (2-line clamp): stripped text — only when a title exists.
- Meta line `.mt` (mono, faint): **"{project} · {task} · {time}"** — note project is ALWAYS shown
  here, including "Viberr Core", and day is NOT lowercased ("Yesterday 16:04"), unlike the page.
- Read items get class `read` (`.ntf-item.read .tt` drops to 600 weight, muted color).
- Click: mark read, close popover, then navigate; **cross-project rows dead-end with toast**
  "{project} — that workspace isn't built in this prototype" (mock-only; port must really navigate).
- Head copy: **"Notifications"**, count `"{N} unread"` / **"caught up"** (`.ct.mono`),
  **"Mark all read"** when unread > 0 (fires the same mark-all + toast).
- Foot: **"See all"** + arrow icon → closes popover, opens the full page/overlay.

### 4.6 Navigation targets (`onOpen` / `onOpenTask` semantics per shell)

- Workspace shell page overlay: `onOpen(k)` closes overlay; if a task with that key exists in this
  project → `setView("board"); setOpenKey(k)` (task detail). Else → toast
  **"{project} — that workspace isn't built in this prototype"** (looked up from the notification).
- Workspace bell: same, but the cross-project check happens on `project !== "Viberr Core"` before
  `onOpenTask` is called.
- Home shell (both popover and page): `goTask(key)` — cross-project → same toast; else full page nav
  to `Viberr Operator Workspace.html#task/KEY`.
- **Port**: all four collapse to a real router navigation `/{projectSlug}/tasks/{KEY}` (deep link
  target already exists in mock as workspace `#task/KEY`).

### 4.7 PageOverlay wrapper (page presentation)

From ui.jsx — Escape key closes; `confirm-scrim` click closes; markup:

```jsx
<div className="confirm-scrim" onClick={onClose}></div>
<div className="page-overlay" role="dialog" aria-modal="true" aria-label="Notifications" data-screen-label="Notifications — overlay">
  <button className="icon-btn overlay-x" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
  <div className="page-overlay-body">{children}</div>
</div>
```

CSS note: `.page-overlay .board-head { padding-right: 4.4rem; }` reserves room for the X button;
`.page-overlay .board-wrap { flex: none; }`.

### 4.8 Read-state side effect from task resolution (workspace shell)

`main.jsx onResolve` (resolving a decision packet inside task detail) also clears that task's
packet/approval notifications:

```js
setNotifs((ns) => ns.map((n) => (n.task === K && (n.kind === "packet" || n.kind === "approval") ? { ...n, unread: false } : n)));
window.VIBERR.markNotifsRead(notifs.filter((n) => n.task === K && (n.kind === "packet" || n.kind === "approval")).map((n) => n.id));
```

**Port requirement:** the real "resolve packet / approve transition" actions must mark the
corresponding notifications read server-side so the bell badge drops without visiting the page.

---

## 5. Events / mutations produced

The page itself only produces **read-state mutations and navigations** — it writes no timeline
events. Real actions required:

1. **`markNotificationRead(id)`** — single item. Fired by: needs-you row click, stream row click,
   stream keybtn click, popover item click. Idempotent; per-user.
2. **`markAllNotificationsRead()`** — page "Mark all read", popover "Mark all read". Success UX:
   toast **"All notifications marked read"** (toast fired by caller in mock; keep copy).
3. **Navigation** to task detail (cross-project capable) — a redirect, not a mutation.
4. **Implicit read on resolution** (§4.8): the accept/decision/approval actions elsewhere must mark
   this task's packet+approval notifications read for the acting user.

Upstream production (not this page's code, but its data contract): appending typed timeline events
(packet, transition-request/approval, mention, quality flag, policy violation, blocked agent action)
must **fan out notification rows** to routed users per their prefs (`prefs.notifs[kind].app`). The
mock fixture's comment: *"Notifications routed to the signed-in user (Arda) per their routing
preferences."* — the routing itself is real-app work.

No optimistic-UI requirements beyond instant unread-dot/badge updates (mock updates React state
synchronously then persists; port can use fetcher + optimistic UI or revalidation).

---

## 6. CSS classes used (the contract)

All defined in `viberr.css` (already ported verbatim). Key structural classes by area:

**Page:** `board-wrap`, `board-head` (+`h1`, `.sub`), `board-tools`, `mini-seg` (+ `button.on`),
`btn ghost sm`, `policy-wrap` (two-panel layout), `panel`, `panel-head` (+ `.right`, `.sub`),
`empty`.

**Needs-you rows:** `rq-list`, `rq-row` (hover: blue border, -1px translate, shadow), `rq-main`
(+ `.ttl`, `.sub`, `.mono`), `rq-meta`, `unread-dot in` (inline dot variant), `pev-t`.

**Stream rows:** `act-day`, `pol-ev` + `ntf-ev` (+ `.unread`), `pev-ico` + one of `act-blocked |
act-completion | act-transition | act-comment | act-quality | act-policy`, `pev-main`, `act-actor`,
`act-sep`, `keybtn`, `unread-dot`, `pev-t`, `mono` (inside RichA code spans).

**Pills:** `pill` + `info | blocked | input | neutral` + `sm` (via `Pill` component).

**Bell/popover:** `home-user-wrap`, `icon-btn bell-btn`, `bell-badge`, `menu-scrim`, `ntf-pop`,
`ntf-pop-head` (+ `.ct.mono`), `ntf-pop-list`, `ntf-item` (+ `.read`), `ntf-item-main` (+ `.tt`,
`.tx` 2-line clamp, `.mt`), `ntf-pop-foot`, `unread-dot`.

**Overlay:** `confirm-scrim`, `page-overlay`, `page-overlay-body`, `icon-btn overlay-x`.

Icons used (ui.jsx `Icon`, rendered as `svg.ico`): `hand`, `bell`, `check`, `alert`, `arrow`,
`message`, `flag`, `x`, plus `search`/`chevron` in surrounding shell.

Behavioral CSS worth knowing: `.ntf-ev` adds cursor/hover/radius on top of `.pol-ev`;
`.ntf-ev.unread .pev-main { color: var(--fg) }` is the entire unread text treatment;
`.unread-dot` is an 8px `--blue` circle (`.in` variant is inline with `.45rem` left margin);
`.ntf-pop-list { max-height: 420px; overflow-y: auto }`.

---

## 7. Porting notes

**Replace prototype mechanics:**
- `window.VIBERR.notifications` (module-scope array, mutated in place) → loader data from a per-user
  projection query. Note the two shells copy it differently (home clones each item, workspace uses
  the raw array reference) — irrelevant once it's loader data, but do NOT keep module-level mutable
  state.
- `localStorage["viberr:notifs:read"]` + `markNotifsRead` → SQLite per-user read state + action.
- `day`/`t` display strings → real timestamps. Reproduce the display rules exactly:
  - needs-you card time: today → `HH:MM`; else lowercased relative day + time (`yesterday 16:04`);
    older dates need a defined format (mock never shows any — suggest `Mar 30 16:04` matching
    activity feed style).
  - stream: day group headers `Today`/`Yesterday`/(date), bare `HH:MM` per row.
  - popover `.mt`: `{project} · {task} · {time}` with non-lowercased day (`Yesterday 16:04`).
- Sort by timestamp descending (mock relies on fixture order and is even slightly out of order).
- `"Viberr Core"` literal comparisons (project-pill suppression, cross-project dead-end toasts) →
  compare against the user's current project context (workspace shell) — and on a global
  notifications page, likely ALWAYS show the project pill (Open question C).
- Cross-project dead-end toast "{project} — that workspace isn't built in this prototype" → real
  navigation. This copy must NOT survive the port.
- `PageOverlay` presentation → either a real `/notifications` route (recommended) or a route-driven
  modal. Preserve Home's `#notifications` deep-link intent as a URL.
- Hash routing (`#task/KEY`, `Viberr Operator Workspace.html` hrefs) → router links.
- Duplicate meta/plain helpers (×3 / ×2) → single shared module.
- Drop the unused `onNav` prop; drop the vestigial `view === "notifications"` breadcrumb branch in
  main.jsx (view is never set to that value).
- Popover state (`open`/`bell` useState + `menu-scrim`) → keep the same interaction (scrim click to
  close). Consider Escape-to-close for the popover (mock only has it on the overlay).
- Mock inline style on the decisions count (`style={{ fontSize: ".76rem", color: "var(--faint)" }}`)
  — keep or promote to a class; it exists because `.right.sub` alone doesn't size it there.

**Routing prefs interplay (real work the mock skips):**
- `ui.jsx` prefs defaults: `notifs: { packets: {app,email}, approvals: {app,email}, mentions:
  {app,email}, policy: {app,email}, quality: {app,email} }` + `nudge: { on, hours }`. Profile UI
  (`PROFILE_NTF`) exposes only the `app` toggle. The mock never filters the stream by these — the
  real fan-out/projection SHOULD honor `app` per kind. Pref kind ids (`packets`, `approvals`,
  `mentions`, `policy`, `quality`) map to notification kinds (`packet`, `approval`, `mention`,
  `policy`, `quality`) — note the plural/singular mismatch.

**Edge cases:**
- Filter "Unread" with zero unread → both panels render their empty states ("Nothing is waiting on
  you." / "You're caught up.").
- Subtitle when all read: "… · all caught up"; "Mark all read" button disappears (page and popover).
- Decisions count is singular/plural aware and filter-dependent.
- `ntfMeta` default branch means unknown kinds render as policy (alert icon) — fine to keep as a
  fallback.
- Popover items without `title` (mention/quality/policy) promote stripped `text` into the `.tt`
  slot and render no `.tx`.
- `RichA` grammar is strictly `**bold**` and `` `code` `` — no links, no escaping; text containing
  `*` or backticks must be well-formed. Popover strips instead of rendering.
- Stream row = clickable div with nested button (invalid-ish HTML is avoided since it's div>button,
  but keyboard access is missing) — fix accessibility, keep classes.
- Bell badge shows the raw unread count with no upper clamp.
- Read state is monotonic; there is no unread-again path.
- Empty notifications list entirely: page shows both empty states; popover shows an empty scroll
  area (no dedicated empty copy in the popover — consider adding, Open question F).

**Error states:** none exist in the mock (all data local/synchronous). Port needs: loader failure
(standard error boundary) and mark-read action failure (toast + revert optimistic state).

---

## 8. Open questions

A. **Route vs overlay:** should `/notifications` be a standalone route (recommended for a global,
   cross-project surface — the overlay-over-shell pattern in the mock exists only because the
   prototype has two separate HTML pages), or a modal preserved over the current page? Home's
   `#notifications` deep link implies it must be URL-addressable either way.
B. **Notification storage model:** materialized per-user rows at event-append time (fan-out on
   write — needed anyway for the future email channel and nudge digests) vs on-read projection
   query? Spec assumes fan-out on write.
C. **Project pill on the page:** mock hides it for "Viberr Core" because the prototype's workspace
   IS Viberr Core. On a truly global page, should every row show its project pill, or hide the
   "current" project when opened from within a workspace context?
D. **Older-than-yesterday formatting:** fixture only has Today/Yesterday. Define the format for
   older items (suggest matching activity feed: `Mar 30` day groups, `Mar 30 16:04` in rq cards).
E. **Email channel & nudges:** prefs default includes `email` booleans and `nudge {on, hours:2}`
   (re-ping for unanswered decisions), with hour options `[1,2,4,8,24]` in profile — is any of that
   in scope for the port, or app-channel only for now?
F. **Popover empty state:** no copy exists when the list is empty — add "You're caught up." for
   parity with the page?
G. **Pagination/retention:** the popover renders ALL notifications (scroll-capped at 420px) and the
   page renders everything. Define a query limit (e.g. last 30 days / 100 rows) and whether the page
   needs "load more".
H. **Mark-unread:** not in the mock. Needed?
I. **Live updates:** bell badge and popover should update via the Phase 6 SSE channel — confirm the
   notifications projection publishes over the same stream.
J. **Approval rows for non-approvers:** mock routes approvals to Arda regardless of role; real
   routing presumably targets members whose role can approve that boundary (policy engine input) —
   confirm routing rules per kind (mentions → mentioned user; quality → review/acceptance owner;
   policy → "tasks you can see" per PROFILE_NTF copy).
