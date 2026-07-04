# Porting spec — Activity view (`activity.jsx`)

Source: `design/html-app/app/activity.jsx` (143 lines). Shared helpers: `design/html-app/app/ui.jsx`. Data: `design/html-app/app/data.js`. Shell wiring: `design/html-app/app/main.jsx` (lines ~130–260).

The porting engineer is expected to work from this document alone.

---

## 1. Purpose & entry points

The Activity view is the **project-wide, cross-task activity feed**. It has two columns:

1. **Stream** (left, wider) — every timeline event from every task in the project, flattened into one reverse-chronological feed, grouped by day, filterable by actor kind (All / Humans / Agents / System).
2. **Audit logs** (right) — the project's policy & access event log (policy violations, blocked agent actions, policy changes, human audit events). *Not* affected by the actor filter.

It is **read-only**: no mutations originate here. Every row links back to its task via a clickable task-key chip.

### Entry points in the mock

- Hash route `#activity` (read once at boot in `main.jsx`: `/^#(board|review|agents|policy|github|activity|settings)$/`; the mock never writes the hash back).
- Left rail nav item `{ id: "activity", label: "Activity", icon: "activity" }`.
- Rendered by the app shell as:

```jsx
<Activity tasks={tasks} extra={extra} onOpen={(k) => setOpenKey(k)} scopeGranted={scopeGranted} />
```

  - `tasks` — merged array: `window.VIBERR.tasks` + session-created tasks, with per-key `overrides` spread on top.
  - `extra` — `{ [taskKey]: event[] }` of events created **during the session** (comments, decisions, ownership changes...), prepended per task. All treated as day `"Today"`.
  - `onOpen(key)` — opens the task-detail overlay for that task key.
  - `scopeGranted` — boolean; `true` after the user grants the missing `pull_request:write` PAT scope (the VIB-142 demo storyline). Used only to flip the audit-log violation row from "open" to "resolved".

### Entry point in the real app

- Route: a project-scoped page, e.g. `/projects/:project/activity` (RRv7 route module with a loader).
- Loader supplies: (a) a **cross-task timeline-event projection** (all typed events from every task file in the project, already merged — the `extra` split disappears), and (b) the **audit/policy event log** for the project.
- `onOpen` becomes a `<Link>` to the task detail route.
- `scopeGranted` must be replaced by per-violation resolution state (see §7).

---

## 2. Component tree

```
Activity                      — root; owns filter state; builds grouped stream
├─ (header)                   — h1 "Activity", subtitle, filter segment
├─ Stream panel (inline JSX)  — day-grouped, filtered event rows; count in head
│   └─ per-row: Icon, RichA, task-key keybtn
└─ AuditLogs                  — right panel; renders POLICY.events rows
    └─ per-row: Icon, RichA, optional task keybtn, optional status Pill

RichA                         — micro rich-text renderer: **bold** and `code` only
useStream(tasks, extra)       — memoized hook: normalize → flatten → day-group → sort
```

Shared primitives consumed from `ui.jsx` (ported elsewhere; reuse):
- `Icon({ name, className })` — 24×24 stroke SVG from `ICON_PATHS`, `class="ico"`, `aria-hidden="true"`.
- `Pill({ kind, children, dot, sm })` — `<span class="pill {kind}{ sm}">`.

`RichA` is exported to `window` and **also used by `notifications.jsx`** — port it as a shared utility (e.g. `app/components/rich-text.tsx`), not as a private helper of the activity route.

### RichA — verbatim (port semantics exactly)

```jsx
/* tiny rich text: **bold** and `code` */
function RichA({ text }) {
  const parts = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0, m, i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("**")) parts.push(<strong key={i++}>{tok.slice(2, -2)}</strong>);
    else parts.push(<code key={i++} className="mono">{tok.slice(1, -1)}</code>);
    last = m.index + tok.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <React.Fragment>{parts}</React.Fragment>;
}
```

Only these two tokens. No links, no escaping, no nesting. `<code>` gets class `mono`.

---

## 3. Data consumed — exact shapes

### 3.1 Task timeline events (Stream)

From each task in `tasks`: `task.key` (e.g. `"VIB-142"`) and `task.timeline` (array, may be empty or missing — code guards with `task.timeline || []`). Timeline event shape as found in `data.js`:

```js
{
  type: "comment" | "completion" | "github" | "policy" | "quality"
      | "transition" | "blocked" | "agent" | "assign",
  actor: Actor,              // see 3.3
  t: "9:41",                 // string "H:MM" 24h, or "now" for session events
  day: "Yesterday",          // OPTIONAL — absent means "Today"; also "Mar 30"
  title: "Completion report",// OPTIONAL — only on completion-style events
  text: "…**bold** and `code` markup…",
  // fields present in data but IGNORED by this view:
  evidence: [{ label, add, del }],  // completion events
  to: "agent",                       // comment routing marker
}
```

Normalization applied per event (`norm`):

```js
const norm = (ev) => ({
  type: ev.type, actor: ev.actor, t: ev.t,
  text: ev.title ? "**" + ev.title + ".** " + ev.text : ev.text,
});
```

i.e. **`title` is folded into `text` as a leading bold sentence** (`**Completion report.** …`). The row also carries `task` (the task key) and `day` (`ev.day || "Today"`; `extra` events are always `"Today"`).

### 3.2 Grouping & ordering (`useStream`)

```js
const DAY_ORDER = ["Today", "Yesterday", "Mar 30"];
const evMins = (t) => {
  if (t === "now") return 100000;
  const m = /^(\d{1,2}):(\d{2})$/.exec(t || "");
  return m ? (+m[1]) * 60 + (+m[2]) : -1;
};
```

- Rows from `extra` are pushed **first**, then all task timelines, in task-array order.
- Day buckets: fixed order `Today`, `Yesterday`, `Mar 30`, then any unknown day labels appended in first-seen order.
- Within a day: sorted by `evMins` **descending** (newest first). `"now"` sorts above everything (100000); unparseable times sort last (−1).
- Memoized on `[tasks, extra]`.

**Real-app source**: one projection query over the event store — all typed timeline events for the project's tasks, `ORDER BY occurred_at DESC`, grouped into calendar-day buckets (`Today` / `Yesterday` / formatted date) server-side or in the loader. Real timestamps kill the `evMins`/`"now"`/`DAY_ORDER` hacks entirely (see §7).

### 3.3 Actor shapes

Three kinds appear in timelines (built by `data.js` helpers):

```js
// human   — e.g. ARDA = { kind: "human", name: "Arda Kaya", initials: "AK", tone: "" }
//           tones: "" | "rose" | "teal" | "violet"; DENIZ additionally has guest: true
// agent   — codex("Developer") = { kind: "agent", backend: "codex",  name: "Codex",       role: "Developer" }
//           claude("Reviewer") = { kind: "agent", backend: "claude", name: "Claude Code", role: "Reviewer" }
//           Operator          = { name: "Operator", kind: "agent" }        // NOTE: no backend, no role
// system  — { name: "Policy engine", kind: "system" }
```

The Stream renders only `actor.name` (bold) and filters on `actor.kind`. Missing actor renders `"—"` and only matches the "All" filter.

### 3.4 Icon mapping (Stream)

```js
const ACT_ICON = {
  comment: "message", completion: "check", github: "github", policy: "shield",
  quality: "flag", transition: "arrow", blocked: "alert", agent: "agents", assign: "user",
};
```

Fallback icon for unknown type: `"dot"`. Icon names refer to `ICON_PATHS` in `ui.jsx`.

### 3.5 Audit log events (right panel)

Read **directly from the global** inside the component: `const P = window.VIBERR.policy;` — only `P.events` is used. Shape:

```js
POLICY.events = [
  { kind: "violation",  t: "today 9:38",     text: "Project credential is missing `pull_request:write` — flagged by the policy engine on", task: "VIB-142", open: true },
  { kind: "blockedact", t: "yesterday 16:04", text: "Blocked: Developer (Codex) attempted **Merge a pull request** — reserved for humans — on", task: "VIB-145" },
  { kind: "audit",      t: "yesterday 11:20", text: "Murat opened the Developer runtime session for debugging — recorded per audit policy on", task: "VIB-160" },
  { kind: "change",     t: "Mar 30",          text: "Elif locked **Review → Done** to human-only acceptance." },
  { kind: "change",     t: "Mar 30",          text: "Human RBAC and agent capability split into separate policy surfaces —", task: "VIB-139" },
];
```

Notes:
- `t` here is a **freeform display string** (`"today 9:38"`, `"yesterday 16:04"`, `"Mar 30"`) — different format from timeline `t`. Rendered verbatim, never parsed or sorted; array order is display order.
- `task` is optional; when present a task-key chip is appended after the text (the texts are written to end with "on" / "—" so the chip completes the sentence).
- `open: true` on the violation exists in data but is **ignored** — the component uses the `scopeGranted` prop instead (see §7).

Kind → icon/class mapping:

```js
const PEV_META = {
  violation:  { icon: "alert",  cls: "violation" },
  blockedact: { icon: "lock",   cls: "blockedact" },
  change:     { icon: "shield", cls: "change" },
  audit:      { icon: "user",   cls: "audit" },
};
// unknown kind falls back to PEV_META.change
```

**Real-app source**: a dedicated audit/policy event table in SQLite (violations, blocked agent actions, policy edits, runtime-session audit entries), queried per project, ordered newest first, with real timestamps and — for violations — a resolution state.

### 3.6 Other inputs

- `scopeGranted: boolean` — prop from the shell; in the real app, derive from the credential/violation record.
- Subtitle hardcodes the project name: `"…across Viberr Core"` — must come from the project record.
- No session, env, or localStorage reads in this file (the `ui.jsx` prefs IIFE is unrelated shell concern).

---

## 4. UI states & interactions

### 4.1 Page skeleton — verbatim

```jsx
<div className="board-wrap" data-screen-label="Activity">
  <div className="board-head">
    <div>
      <h1>Activity</h1>
      <div className="sub">Human decisions, agent events, and policy changes across Viberr Core</div>
    </div>
    <div className="board-tools">
      <div className="mini-seg" role="radiogroup" aria-label="Filter activity">
        {[["all", "All"], ["human", "Humans"], ["agent", "Agents"], ["system", "System"]].map(([id, l]) => (
          <button type="button" key={id} className={f === id ? "on" : ""} onClick={() => setF(id)}>{l}</button>
        ))}
      </div>
    </div>
  </div>

  <div className="policy-wrap">
    <div className="activity-cols">
      {/* Stream panel */}
      {/* AuditLogs panel */}
    </div>
  </div>
</div>
```

### 4.2 Actor filter

- Local state `f`, default `"all"`. Values/labels: `all`→"All", `human`→"Humans", `agent`→"Agents", `system`→"System".
- Predicate: `f === "all" || (r.actor && r.actor.kind === f)`.
- After filtering, **day groups with zero rows are dropped** (no empty day headers), and the head count is recomputed: `total = shown.reduce((n, g) => n + g.rows.length, 0)`.
- Active button gets class `on`. Container has `role="radiogroup" aria-label="Filter activity"` but the buttons are plain `<button type="button">` — no `role="radio"`/`aria-checked` in the mock. Porting: keep the exact classes; upgrading the buttons to proper radio semantics (or `aria-pressed`) is a permitted a11y improvement.
- The filter does **not** apply to the Audit logs panel.
- Filter is ephemeral client state (not in URL) in the mock.

### 4.3 Stream panel — verbatim

```jsx
<div className="panel">
  <div className="panel-head"><Icon name="activity" /><h2>Stream</h2>
    <span className="right sub" style={{ fontSize: ".76rem", color: "var(--faint)" }}>{total} events</span>
  </div>
  {shown.map((g) => (
    <div key={g.day}>
      <div className="act-day">{g.day}</div>
      {g.rows.map((r, i) => (
        <div className="pol-ev" key={i}>
          <span className={"pev-ico act-" + r.type}><Icon name={ACT_ICON[r.type] || "dot"} /></span>
          <span className="pev-main">
            <strong className="act-actor">{r.actor ? r.actor.name : "—"}</strong>
            <span className="act-sep">·</span>
            <RichA text={r.text} />
            {" "}<button type="button" className="keybtn" onClick={() => onOpen(r.task)}>{r.task}</button>
          </span>
          <span className="pev-t">{r.t}</span>
        </div>
      ))}
    </div>
  ))}
  {!shown.length && <div style={{ fontSize: ".85rem", color: "var(--faint)", padding: ".6rem 0" }}>No events match this filter.</div>}
</div>
```

Behavior notes:
- Head count copy: `{total} events` (e.g. "37 events") — count of rows **after** filtering.
- Every stream row ends with a `keybtn` chip showing the task key (`VIB-142`); click → `onOpen(r.task)` → task detail. In the real app: `<Link className="keybtn" to={...}>` — keep class.
- Times render raw (`9:41`, `15:12`, `now`) in `pev-t` (mono font).
- Empty state (filter matches nothing): the exact copy **"No events match this filter."** with the inline style shown. Only rendered when *no groups* remain.
- Day-group `<div>`s must remain **direct children of `.panel`** — CSS rule `.panel > div:first-of-type .act-day { padding-top: .1rem; }` depends on this DOM shape.

### 4.4 Audit logs panel — verbatim

```jsx
function AuditLogs({ P, onOpen, scopeGranted }) {
  return (
    <div className="panel">
      <div className="panel-head"><Icon name="lock" /><h2>Audit logs</h2>
        <span className="right sub" style={{ fontSize: ".76rem", color: "var(--faint)" }}>policy &amp; access</span>
      </div>
      <div className="pev-list">
        {P.events.map((e, i) => {
          const m = PEV_META[e.kind] || PEV_META.change;
          const resolved = e.kind === "violation" && scopeGranted;
          return (
            <div className="pol-ev" key={i}>
              <span className={"pev-ico " + m.cls}><Icon name={m.icon} /></span>
              <span className="pev-main">
                <RichA text={e.text} />
                {e.task && <React.Fragment>{" "}<button type="button" className="keybtn" onClick={() => onOpen(e.task)}>{e.task}</button></React.Fragment>}
                {e.kind === "violation" && <React.Fragment>{" "}<Pill kind={resolved ? "done" : "input"} sm>{resolved ? "resolved" : "open"}</Pill></React.Fragment>}
              </span>
              <span className="pev-t">{e.t}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

Behavior notes:
- Head: lock icon, "Audit logs", right-aligned faint "policy & access".
- Violation rows get a small pill: **"open"** (`pill input sm`) until resolved, then **"resolved"** (`pill done sm`). In the mock, *all* violations flip together off the single `scopeGranted` boolean — in the real app resolution must be per-violation (see §7).
- No actor column, no day grouping, no filtering — flat list in array order inside `.pev-list`.
- No empty state exists in the mock (data always non-empty) — the port needs one (suggested copy, matching the stream's style: "No policy or access events yet.").

### 4.5 Keyboard / a11y summary

- All interactive elements are native `<button type="button">` — inherently keyboard-focusable/activatable. No custom key handlers, no dialogs, no menus in this view.
- `role="radiogroup" aria-label="Filter activity"` on the filter container (see §4.2 caveat).
- Icons are `aria-hidden="true"` (from the shared `Icon`).
- `data-screen-label="Activity"` on the root — prototype tooling hook (screenshot labeling); harmless to keep, safe to drop.

### 4.6 Important user-visible strings (exact copy)

| Where | String |
|---|---|
| Page title | `Activity` |
| Subtitle | `Human decisions, agent events, and policy changes across Viberr Core` (project name must become dynamic) |
| Filter labels | `All` · `Humans` · `Agents` · `System` |
| Stream panel head | `Stream` · `{total} events` |
| Stream empty state | `No events match this filter.` |
| Audit panel head | `Audit logs` · `policy & access` |
| Violation status pills | `open` / `resolved` |
| Missing-actor placeholder | `—` |

---

## 5. Events / mutations produced

**None.** The Activity view performs no writes; it needs only a loader. But it is the *display surface* for events produced elsewhere, so the port must guarantee those writers emit compatible typed events. In the mock, `main.jsx` writes these session events (all with `t: "now"`, prepended via `addEvent` into `extra`), and each must become a real action that appends a typed timeline event to the task's event store:

| Producer (mock) | Event written | Shape highlights |
|---|---|---|
| `onComment` | `{ type: "comment", actor: ARDA, t: "now", text, to: "agent"\|null }` | `to` set when text matches `/@(agent\|operator\|codex\|claude)\b/i` |
| `onOwnerAction` (take/release/assign) | `{ type: "assign", actor, t: "now", text: "Took task ownership — …" }` | plus a follow-up `{ type: "agent", actor: Operator }` event for VIB-148 |
| `onResolve` — block on policy / hold | `{ type: "blocked", actor: ARDA, t: "now", text: "**Decision:** hold on policy. …" }` | |
| `onResolve` — accept completion | `{ type: "completion", actor: ARDA, t: "now", title: "Completion accepted", text: "Human acceptance recorded. …" }` | `title` present → stream shows `**Completion accepted.** …` |
| `onResolve` — other options | `{ type: "transition", actor: ARDA, t: "now", text: option.ev \|\| "**Decision:** …" }` | |
| `grantScope` | `{ type: "policy", actor: { name: "Policy engine", kind: "system" }, t: "now", text: "**Policy update:** \`pull_request:write\` granted …" }` | also flips `scopeGranted` |

Real-app contract: the activity loader is a **pure projection** of (a) typed timeline events across the project's task files and (b) the audit-event table. Anything a task-detail action writes must show up here on the next load/revalidation (or via SSE push, Phase 6).

---

## 6. CSS classes used (the contract)

Structural (all present in `viberr.css`, ported verbatim):

- Layout: `board-wrap`, `board-head`, `board-tools`, `sub`, `policy-wrap`, `activity-cols` (grid `1.55fr 1fr`, collapses to `1fr` under a media query), `panel`, `panel-head`, `right`.
- Filter: `mini-seg`, active button modifier `on`.
- Event rows (shared with the Policy view): `pev-list`, `pol-ev`, `pev-ico`, `pev-main`, `pev-t`.
- Stream-specific: `act-day` (day header), `act-actor` (bold actor name), `act-sep` (the `·`), and the per-type icon tints `pev-ico.act-comment`, `.act-completion`, `.act-github`, `.act-policy`, `.act-quality`, `.act-transition`, `.act-blocked`, `.act-agent`, `.act-assign` (note: `.act-assign` is defined further down the stylesheet, ~line 1951 — it exists, don't re-add).
- Audit-specific icon tints: `pev-ico.violation`, `.blockedact`, `.change`, `.audit`.
- Misc: `keybtn` (task chip), `pill` + kinds `input`/`done` + `sm` (via `Pill`), `mono` (RichA `<code>`), `ico` (Icon svg).

Structural dependencies to preserve:
- `pev-ico` gets the modifier class **concatenated** (`"pev-ico act-" + type`); an unknown type yields no tint class and falls back to base `pev-ico` styling — acceptable.
- Day groups as direct children of `.panel` (see §4.3).
- Two inline styles are part of the mock's look: panel-head right label (`fontSize: ".76rem", color: "var(--faint)"`) and the stream empty state (`fontSize: ".85rem", color: "var(--faint)", padding: ".6rem 0"`). Reproduce (inline or tokenized) — do not substitute Tailwind utilities; stay on `--viberr-*`/existing classes per the design-language rule.

---

## 7. Porting notes

**Time model (biggest rewrite).** Replace the string-time system wholesale:
- `t: "H:MM" | "now"` → real timestamps (epoch/ISO) on every event; display as `HH:MM` (and keep the mono `pev-t` styling). Nothing should ever render the literal `now`.
- `evMins` (with its `"now" → 100000` and `unparseable → −1` hacks) → plain `ORDER BY occurred_at DESC`.
- `DAY_ORDER = ["Today", "Yesterday", "Mar 30"]` → compute day buckets from timestamps in the viewer's locale/timezone: `Today`, `Yesterday`, then a formatted date (`Mar 30`) for older days, newest bucket first. The hardcoded `"Mar 30"` is demo data leakage.
- Audit `t` strings (`"today 9:38"`) → same timestamp treatment; pick one display format for both panels or intentionally keep the audit panel's longer relative format — but generate it, don't store it.

**`extra` merging disappears.** The mock splits events into static `task.timeline` and session-created `extra` because it has no persistence. The real app has one event store; the loader returns the merged, ordered feed. Post-action freshness comes from RRv7 revalidation (and later SSE).

**`norm()` title folding.** Either keep folding `title` into the text (`**Title.** text`) in the projection layer, or return `title` structured and render `<strong>{title}.</strong> {text}` — visually identical; the latter is cleaner. Do not lose the trailing period + space.

**`scopeGranted` → per-violation resolution.** The mock resolves *every* violation row when one global boolean flips, and ignores the `open: true` field already present in the data. Real app: violation audit records carry their own `open/resolved` state (resolved when the credential scope is granted — the `grantScope` action in Settings must update the violation record *and* append the `policy` timeline event to VIB-142). Render the pill from the record.

**`window.VIBERR.policy` global.** `AuditLogs` reads the global directly instead of taking props from the shell. In the port, audit events are loader data — no globals.

**Filter semantics.** `actor.kind` is the discriminator; guests (e.g. Deniz Şahin, `guest: true`) are `kind: "human"` and correctly appear under "Humans". The Operator actor is `kind: "agent"` **without** `backend`/`role` — don't assume those fields exist. Events with no actor appear only under "All" (none exist in mock data; possible with future system events — decide whether such events should get a synthetic system actor instead). Consider putting the filter in the URL (`?actor=agent`) so it survives reload; the mock keeps it in component state.

**Hardcoded project name.** Subtitle says "across Viberr Core" — take from the project record.

**Unknown event types / kinds.** Stream: unknown `type` → `dot` icon, untinted `pev-ico`. Audit: unknown `kind` → `change` meta. Keep these fallbacks; the event schema will grow.

**Pagination.** The mock renders every event ever (fine for ~30 rows). A real event-sourced store needs a cap: suggest loader default of the most recent N days or N events with a "load more" — decide before Phase 9 (see Open questions).

**Empty states.** Stream-with-filter empty state exists (copy in §4.6). Two states the mock never hits and the port must handle: a brand-new project with zero events (suggest reusing the same style with e.g. "No activity yet."), and an empty audit log (§4.4).

**Row keys.** Mock uses array-index keys (`key={i}`). Real events have IDs — use them.

**a11y polish (optional but cheap).** Give filter buttons `role="radio"` + `aria-checked` (or switch container to a real group of inputs) without touching classes.

**`data-screen-label`.** Prototype screenshot/tooling hook; drop or keep harmlessly.

**Stable sort caveat.** Same-minute events rely on JS stable sort + insertion order (extra events first, then task order). With real timestamps (second/ms precision) this ambiguity disappears; use `occurred_at DESC, id DESC` as a total order.

---

## 8. Open questions

1. **Retention / pagination**: how much history should the stream load — all events, last 14 days, or paged? Event sourcing makes this unbounded.
2. **Audit log scope**: per-project (as mocked) or also an org-level surface? The RBAC table implies org admins may want a global view.
3. **Filter ↔ audit panel**: is it intentional that the actor filter leaves Audit logs untouched? (Mock says yes; confirm.)
4. **SSE (Phase 6)**: does the Activity page subscribe to live event pushes, or is load-time freshness enough for v1?
5. **Day-bucket timezone**: bucket by server time or per-viewer timezone? (Affects "Today"/"Yesterday" boundaries for distributed teams.)
6. **Violation resolution source of truth**: is a resolved violation a *mutated* audit record, or does resolution append a new `change` event and the violation row derives state by correlation? Event-sourcing purity suggests the latter; the mock's UI implies the former.
7. **Audit `t` display format**: unify with the stream (`HH:MM` + day grouping) or keep the freeform relative style (`today 9:38`)? Mock has two formats side by side.
8. **`to: "agent"` comment routing**: ignored by this view — confirm it stays timeline-only metadata and never surfaces in the feed.
