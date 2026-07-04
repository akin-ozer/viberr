# Porting spec — Task detail (`task.jsx` → route module)

Source: `design/html-app/app/task.jsx` (500 lines). Callback wiring lives in `design/html-app/app/main.jsx` (`App`), shared primitives in `design/html-app/app/ui.jsx`, data shapes in `design/html-app/app/data.js`. The porting engineer is expected to work from this spec alone.

The CSS design system is ported verbatim. **Class names in this document are the contract** — use them exactly.

---

## 1. Purpose & entry points

The task detail is the operator-first workspace for a single task: the human sees, top to bottom, *what is running right now*, *what decision is waiting on them*, *who is executing*, *raw agent logs*, and *the unified timeline*. Everything a human must decide is surfaced as a **decision packet** at the top; everything an agent did is a typed timeline event below.

Entry points in the mock (all become real routes/links):

- Hash route `#task/VIB-142` — regex `/^#task\/([A-Za-z]+-\d+)$/` parsed on load in `App`. Real app: route like `/projects/:projectSlug/tasks/:taskKey` with an RR7 loader.
- Board card click, Review-queue row click, Agents view, GitHub view, Activity feed, notification popover item (`onOpenTask(key)`) — all call `setOpenKey(key)`.
- Breadcrumb while open: `Viberr Core › Board › {key} · {title}` (crumb buttons navigate back to board).

The mock renders `TaskDetail` *instead of* the board inside the same `.main` shell (topbar stays). Real app: child route rendered in the project layout.

Root element:

```jsx
<div className="detail" key={task.key} data-screen-label={"Task " + task.key}>
  <div className="detail-main">…</div>
  <div className="detail-side">…</div>
</div>
```

`key={task.key}` forcibly remounts on task switch (resets composer draft, filter, dialogs, log selection). Preserve this behavior (RR7 does this naturally per-navigation only if state is keyed — keep an explicit key or derive state from the loader).

---

## 2. Component tree

```
TaskDetail                      root; owns logSel (agent-logs selection) + releasing (dialog open) state
├─ .task-hero                   inline block, not a component: key, title, stage/readiness/validation pills, task.md path, goal
├─ LiveRunPanel                 (defined in runs.jsx — separate spec) live "runbar" strip; only when a runtime entry is state:"running"
├─ DecisionPacket               only when task.packet exists; radiogroup of options + resolve/ask buttons
├─ ExecutionProfile             4-cell grid: Operator / Primary specialist / Consultants / Human owner
│  └─ OwnerControl              "Assign me" button OR "Manage" dropdown menu (take over / hand off / release)
├─ AgentLogsPanel               (defined in runs.jsx — separate spec) per-agent log console with raw-wire toggle
└─ Timeline                     filter tabs + comment composer + event list
   └─ TimelineItem (×n)         one rail node + body per event
      └─ RichText               inline **bold** / `code` / @mention renderer
side column:
├─ GithubTrace                  branch/PR strip: repo bar, branch, diff stats, commits, "Open on GitHub"
├─ "Current state" panel        inline: stage / waiting-on / owner (with inline release ×) / repo
└─ PolicyPanel                  static permissions summary derived from myRole + "View project policy"
overlay:
└─ ReleaseConfirm               alertdialog confirming ownership release, with hand-off-instead chips
```

Shared primitives used (from `ui.jsx`, ported globally): `Icon`, `Pill`, `ReadinessPill`, `ValidationPill`, `AgentGlyph`, `Avatar`.

**Layout order is intentional and load-bearing** (operator-first): hero → live run → decision packet → execution profile → agent logs → timeline. Do not reorder.

---

## 3. Data consumed

### 3.1 Props of `TaskDetail` (mock signature)

```
TaskDetail({ task, onComment, onResolve, onAsk, ask, extraEvents, onPolicy, push, me, myRole, onOwner })
```

- `task` — full task object (below).
- `extraEvents` — session-local optimistic events prepended to `task.timeline` (mock-only; replaced by real revalidation).
- `ask` — an integer counter; each increment means "Ask operator" was clicked (drives composer prefill, §4.2).
- `push(text)` — toast.
- `me` — `{ name, title }` of signed-in user (mock hardcodes `Arda Kaya`). Real: session user.
- `myRole` — `"admin" | "maintainer" | "reviewer" | "viewer"`, derived in mock as `members.find(m => m.p.name === me.name)?.role || "viewer"`. Real: membership row for session user in this project.
- `onComment/onResolve/onOwner/onAsk/onPolicy` — become actions / navigation (§5).

### 3.2 Task shape (exact fields read by this surface)

From `window.VIBERR.tasks[]` in `data.js`. Real source: **projection query** over the file-native task store (`.viberr/tasks/{KEY}/task.md` + typed events log), joined with GitHub sync state.

```js
{
  key: "VIB-142",                      // task key, also branch prefix and file path segment
  title: "Attach execution workspace to task runtime",
  stage: "review",                     // stage id; resolved against project stages list
  goal: "…",                           // one-paragraph goal, shown under hero
  readiness: "input",                  // "ready"|"input"|"risk"|"blocked"|"done"  → ReadinessPill
  validation: "changed",               // "healthy"|"changed"|"failing"|"none"     → ValidationPill
  waiting: "human",                    // "human"|"agent"|"none"
  urgent: true,                        // NOT used on this surface (board only)
  specialist: { kind:"agent", backend:"codex"|"claude", name:"Codex"|"Claude Code", role:"Developer" } | null,
  owner: { kind:"human", name:"Arda Kaya", initials:"AK", tone:""|"rose"|"teal"|"violet" } | null,
  operator: { name:"Operator", since:"stage 1" } | null,   // null for untriaged tasks
  consultants: [ agentShape, … ],      // may be []
  branch: "vib-142-attach-workspace" | null,
  repo: "akin-ozer/viberr",
  pr: { number: 318, state: "review"|"merged", title: "…" } | null,
  commits: [ { sha:"a91f7c2", msg:"[VIB-142] add repo attach policy gate" }, … ],  // optional
  changed: { files: 9, add: 412, del: 87 },                                        // optional
  packet: PacketShape | undefined,     // present only when a decision is open
  timeline: [ EventShape, … ],         // newest first; rendered top-to-bottom in array order
}
```

### 3.3 Packet shape

```js
packet: {
  type: "input" | "blocked",          // drives card tint class + pill kind
  kind: "Completion report" | "Blocked decision" | …,   // pill label
  from: "Operator",                   // display name after "from"
  title: "Accept completion, or send back for one fix?",
  body:  "…prose paragraph…",
  observations: [ { k: "Changed", v: "9 files · +412 / −87", code: true }, … ],
  //   k = row label; v = value; code:true wraps v in <code>
  options: [
    { t: "Accept completion", d: "Mark task done and merge the review PR. Human-authorized.",
      rec: true,        // recommended → "operator pick" tag + default selection
      accept: true },   // acceptance option → resolving it completes the task (§5.3)
    { t: "Request one edit", d: "…", rec: false,
      ev: "**Decision:** request one edit. …" },  // optional: pre-authored timeline text for this decision
    { t: "Block on policy", d: "…", rec: false },
  ],
}
```

Two real packet instances exist in mock data: VIB-142 (`type:"input"`, completion acceptance with a PAT-scope flag) and VIB-160 (`type:"blocked"`, continuity-degraded recovery with options *Resume rehydrated thread* / *Start a fresh specialist* / *Hold for runtime debug*).

Real source: the open decision packet is part of the task projection (operator writes it; resolving clears it).

### 3.4 Timeline event shape

```js
{
  type: "comment"|"completion"|"github"|"policy"|"quality"|"transition"|"blocked"|"agent"|"assign",
  actor: humanShape | agentShape | { name:"Policy engine", kind:"system" } | { name:"Operator", kind:"agent" },
  //   humans may carry guest:true → "app user · not in project" pill
  t: "9:41",                 // preformatted clock string in mock
  day: "Yesterday"|"Mar 30", // optional; absent or "Today" ⇒ show time only
  text: "…",                 // markdown-ish: **bold**, `code`, @mentions (see RichText)
  title: "Completion report",// optional, typed events only — rendered bold above text
  evidence: [ { label:"unit/policy_gate_test", add:"+14", del:"0" }, … ],  // optional, typed only
  to: "agent" | null,        // comments only — comment was routed to an agent (tinted card)
}
```

### 3.5 Other inputs

| Data | Mock source | Real source |
|---|---|---|
| `stages` | `window.VIBERR.stages` — `[{ id, name, color }]` (triage/ready/impl/review/done, colors `#a5a8b5 #187574 #7b61ff #5b76fe #00b473`) | project workflow config (DB), part of project loader data |
| `runtime` | `window.VIBERR.runtime[task.key] || []` — array of agent run threads (`{ id, op?, role, who, backend, sdk, model, sid, state:"running"|"idle"|"done"|"error", phase?, step?, elapsed?, finished?, turns, tokens, lines[], live[] }`) — consumed by `LiveRunPanel` and `AgentLogsPanel` (spec'd with runs.jsx) | agent-runtime service; live lines over SSE |
| `members` | `window.VIBERR.policy.members` — `[{ p: humanShape, role, email, status:"active" }]` — used by OwnerControl + ReleaseConfirm hand-off lists (filter `status === "active"`) | SQLite project membership query |
| `prefs.tlDefault` | `window.VIBERR.prefs` (localStorage `viberr:prefs`) — default timeline filter `"all"|"typed"|"comment"` | user preference (decide: per-user DB column vs client store) |
| `me`, `myRole` | App state, hardcoded Arda Kaya | server session + membership |

---

## 4. UI states & interactions

### 4.1 Hero (`.task-hero`)

```jsx
<div className="task-hero">
  <span className="key">{task.key}</span>
  <h1>{task.title}</h1>
  <div className="hero-meta">
    <Pill kind="neutral"><span className="col-stage-dot" style={{ background: stage.color, width: ".5rem", height: ".5rem" }} />{stage.name}</Pill>
    <ReadinessPill value={task.readiness} />
    <ValidationPill value={task.validation} />
    <span className="hero-file"><Icon name="file" /><span>{".viberr/tasks/" + task.key + "/task.md"}</span></span>
  </div>
  <p className="goal">{task.goal}</p>
</div>
```

- Stage looked up by id: `stages.find(s => s.id === task.stage) || {}` (tolerates unknown stage — renders empty name; keep the guard).
- Pill vocabularies (from `ui.jsx`, verbatim labels):
  - Readiness: `ready→"ready"`, `input→"input required"`, `risk→"inconsistency risk"`, `blocked→"blocked"`, `done→"accepted"`; pill kind equals the readiness id; falls back to `ready`.
  - Validation: `healthy→kind ready "validation healthy"`, `changed→kind input "evidence changed"`, `failing→kind blocked "validation failing"`, `none→kind neutral "no validation"`; falls back to `none`.
- The `hero-file` path is the canonical file identity — real app should render the actual store path.

### 4.2 Decision packet (`DecisionPacket`)

Rendered only when `task.packet` exists, directly under the live-run strip.

Container: `className={"packet " + (isBlocked ? "blocked" : "input")}` where `isBlocked = p.type === "blocked"`.

Header row:

```jsx
<div className="packet-top">
  <Pill kind={isBlocked ? "blocked" : "input"} dot>{p.kind}</Pill>
  <span className="from">
    from <span className="agent-glyph op"><Icon name="shield" /></span>{" "}
    <strong style={{ fontFamily: "var(--font-display)" }}>{p.from}</strong>
  </span>
</div>
```

Body: `<h2>{p.title}</h2>`, then body prose `<p style={{ color:"var(--muted)", fontSize:".92rem", lineHeight:1.55, margin:0 }}>{p.body}</p>` (note: plain text, **not** RichText — packet body markdown like `` `pull_request:write` `` renders literally in the mock; see Open questions).

Observations block:

```jsx
<div className="packet-obs">
  {p.observations.map((o, i) => (
    <div className="obs" key={i}>
      <span className="k">{o.k}</span>
      <span>{o.code ? <code>{o.v}</code> : o.v}</span>
    </div>
  ))}
</div>
```

Options — an ARIA radiogroup made of buttons:

```jsx
<div className="options" role="radiogroup" aria-label="Decision options">
  {p.options.map((o, i) => (
    <button key={i} role="radio" aria-checked={sel === i}
      className={"opt" + (sel === i ? " sel" : "") + (o.rec ? " recommend" : "")}
      onClick={() => setSel(i)}>
      <span className="radio" />
      <span>
        <div className="ot">{o.t}</div>
        <div className="od">{o.d}</div>
      </span>
      {o.rec && <span className="rec-tag"><Pill kind="info" sm>operator pick</Pill></span>}
    </button>
  ))}
</div>
```

- Initial selection: `useState(Math.max(0, p.options.findIndex(o => o.rec)))` — the recommended option, or **option 0 when none is recommended** (`findIndex` returns −1, clamped to 0).
- Recommended options get the `recommend` class AND an `operator pick` info pill.
- No keyboard arrow-key roving in the mock (each radio is a focusable button). Consider adding proper radiogroup arrow navigation in the port; at minimum keep `role`/`aria-checked`.

Actions row:

```jsx
<div className="packet-actions">
  <button className="btn primary" onClick={() => onResolve({ option: p.options[sel], packet: p })}>
    <Icon name="check" />{p.options[sel] ? p.options[sel].t : "Confirm"}
  </button>
  <button className="btn ghost" onClick={onAsk}>
    <Icon name="message" />Ask operator
  </button>
</div>
```

- **The primary button's label is the selected option's title** ("Accept completion", "Resume rehydrated thread", …). Fallback label `Confirm` if options are empty (guard exists but resolving would pass `option: undefined` — real app must not render a packet with zero options).
- **Ask operator** does not mutate anything: it bumps the `ask` counter; `Timeline` watches it and (a) prefills the composer draft with `"@operator "` *only if the draft is empty/whitespace*, (b) focuses the textarea. Implement as scroll-to + focus + prefill of the composer.

### 4.3 Execution profile (`ExecutionProfile`)

Panel with head `Icon agents` + `<h2>Execution profile</h2>` + right pill `<Pill kind="agent" dot>operator active</Pill>` (mock shows this pill unconditionally — real app should reflect actual operator runtime state, see Porting notes).

`.profile-grid` with four `.profile-cell`s, each `.lbl` + `.val`:

1. **Operator** — always the shield glyph:
   `<span className="agent-glyph"><Icon name="shield" /></span>` + `<div className="nm">Operator</div><div className="sub">coordinator · {task.operator ? task.operator.since : "—"}</div>`
2. **Primary specialist** — if `task.specialist`: `<AgentGlyph backend={sp.backend} />` + `<div className="nm">{sp.name}</div><div className="sub">{sp.role} · {sp.backend === "claude" ? "Claude Code" : "Codex"}</div>`. Else: `<span className="sub">None yet — the operator assigns one when execution starts</span>`.
3. **Consultants** — if any, a `.consultants` wrapper of chips:

   ```jsx
   <span className="who-chip" style={{ padding: ".25rem .5rem", border: "1px solid var(--hairline)", borderRadius: "999px" }}>
     <AgentGlyph backend={c.backend} /><span className="nm" style={{ fontSize: ".8rem" }}>{c.name} · {c.role}</span>
   </span>
   ```

   Else `<span className="sub">None engaged</span>`. (Inline styles here should be promoted to a CSS rule in the port — see Porting notes.)
4. **Human owner · reviews & accepts** — `.rev-row` containing:
   - if owned: `<span className="rev-chip"><Avatar person={o} /><span className="nm">{o.name}{mine ? " · you" : ""}</span></span>`
   - if unowned: `<span className="sub">Unowned — open to any project member</span>`
   - always: `<OwnerControl …/>` (below).

`AgentGlyph` (shared): `span.agent-glyph.claude` with `sparkle` icon and title "Claude Code", or `.codex` with `cpu` icon and title "Codex".

### 4.4 Ownership control (`OwnerControl`)

Props: `task, me, myRole, onOwner(action, person?), onRelease()`. `mine = owner && me && owner.name === me.name`; `admin = myRole === "admin"`.

**Unowned state** — a single button, no menu:

```jsx
<button type="button" className="rev-add" onClick={() => onOwner("take")}
  title="Take ownership — review & acceptance, this task only">
  <Icon name="plus" />Assign me
</button>
```

**Owned state** — `.own-wrap` with a `Manage` trigger and dropdown:

- Trigger: `<button className={"own-btn" + (open ? " open" : "")} aria-haspopup="menu" aria-expanded={open}>Manage<Icon name="chevron" /></button>`
- Closes on outside `mousedown` (document listener bound while open). No Escape handling in the mock (add it in the port).
- Menu: `<div className="own-menu" role="menu" aria-label="Manage task ownership">` containing, in order:
  1. If **not** mine: `menu-item` role=menuitem — `<Icon name="user" />Take over ownership` → `onOwner("take")`.
  2. Hand-off list: label `<div className="own-lbl">Hand off to</div>` (only if candidates exist), then per member: `<button className="menu-item" role="menuitem"><Avatar person={m.p} />{m.p.name}<span className="own-role">{m.role}</span></button>` → `onOwner("assign", m.p)`. Candidates = `policy.members` filtered to `status === "active"` and excluding the current owner **and me**.
  3. If mine: `<div className="menu-sep" />` then danger item `<Icon name="x" />Release ownership…` → `onRelease()` (opens dialog).
  4. If not mine but admin: `menu-sep` then danger item `<Icon name="x" />Release {owner first name}…<span className="own-role">admin</span>` → `onRelease()`.

Every menu action first closes the menu.

### 4.5 Release confirm dialog (`ReleaseConfirm`)

Opened by `releasing` state in `TaskDetail` (set from OwnerControl's release item or the sidebar `own-x` button). Full-screen scrim + card:

```jsx
<div className="confirm-scrim" onClick={onCancel}></div>
<div className="modal-card release-card" role="alertdialog" aria-modal="true"
  aria-label={"Release ownership of " + task.key} data-screen-label="Release ownership dialog">
  <div className="modal-head">
    <span className="agent-glyph lg warn"><Icon name="hand" /></span>
    <div className="mh-main">
      <h2>Release ownership?</h2>
      <div className="mh-sub"><span className="mono">{task.key}</span> · {task.title}</div>
    </div>
    <button className="icon-btn modal-close" onClick={onCancel} aria-label="Close"><Icon name="x" /></button>
  </div>
  …
</div>
```

- Escape closes (window keydown listener). Scrim click closes. No focus trap in the mock — **add one in the port** (alertdialog).
- `const o = task.owner || me` (defensive; dialog should only open when owned). `mine = o.name === me.name`.

Body (`.modal-body`, `gap: 1.05rem` inline) — reuses the packet observations look:

1. `.packet-obs` (margin 0 inline) with three `.obs` rows:
   - **Owner** — `.rel-owner`: `<Avatar person={o} /><strong>{o.name}</strong>` + faint `· you` when mine; when **not** mine an extra `<Pill kind="info" sm>admin release</Pill>`.
   - **Open now** — one of:
     - packet exists: `.rel-open` → `<Pill kind={packet.type === "blocked" ? "blocked" : "input"} sm dot>{packet.kind}</Pill> waiting on the owner`
     - else `task.waiting === "human"`: `A human decision is pending on this task`
     - else: `Agent work in progress — no boundary is waiting`
   - **After** — `Unowned — review & acceptance stall until another member takes the seat`
2. Hand-off-instead section (only if candidates exist): label `<div className="rel-lbl">Hand off instead — keeps the boundary owned</div>` then `.rel-row` of chips:

   ```jsx
   <button type="button" className="handoff-chip" key={m.p.name}
     onClick={() => { onCancel(); onOwner(isMe ? "take" : "assign", m.p); }}>
     <Avatar person={m.p} /><span className="nm">{m.p.name.split(" ")[0]}{isMe ? " · you" : ""}</span><span className="rl">{m.role}</span>
   </button>
   ```

   Candidates here = active members excluding the current owner but **including me** (unlike the Manage menu), sorted so the signed-in user's chip comes first. Clicking my own chip performs `take` (admin flow: take over instead of releasing to nobody).

Footer (`.modal-foot`):

- `.foot-hint`: mine → `Recorded as a typed ownership event on the timeline.` / admin-release → `Admin release — recorded as a typed event and in the audit trail.`
- `.foot-actions`: ghost button `Keep ownership` (mine) or `Cancel` (admin), and `<button className="btn danger"><Icon name="x" />{mine ? "Release" : "Release " + o.name.split(" ")[0]}</button>` → `onConfirm()` → closes dialog and calls `onOwner("release")`.

### 4.6 Timeline (`Timeline`)

Panel head: `Icon activity` + `<h2>Timeline</h2>` + right-aligned `.tl-filter` segmented buttons:

```js
const TL_FILTERS = [
  { id: "all", label: "All" },
  { id: "typed", label: "Important events" },
  { id: "comment", label: "Comments" },
];
```

Active tab gets class `on`. Initial value = `prefs.tlDefault || "all"`. Filtering: `all` → everything; `comment` → `e.type === "comment"`; `typed` → `e.type !== "comment"`.

Composer (above the list — newest events render at the top, so the composer sits adjacent to the newest):

```jsx
<div className="composer">
  <div className="composer-box">
    <textarea ref={taRef}
      placeholder="Add a comment… type @ to tag the operator, an agent, or a teammate"
      value={draft} onChange={…}
      onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send(); }} />
    <div className="composer-foot">
      <span style={{ fontSize: ".72rem", color: "var(--placeholder)" }}>Open to every registered user · @mentions route to agents</span>
      <span style={{ marginLeft: "auto", fontSize: ".72rem", color: "var(--placeholder)" }} className="mono">⌘↵ to send</span>
      <button className="btn primary sm" onClick={send}><Icon name="send" />Comment</button>
    </div>
  </div>
</div>
```

- Send: trims; ignores empty; calls `onComment(text)`; clears draft. Keyboard: **Cmd/Ctrl+Enter**.
- "Ask operator" integration: effect watches the `ask` counter; on change, sets draft to `"@operator "` (only when current draft is blank) and focuses the textarea.
- There is **no** @-mention autocomplete in the mock — routing is regex-based server-side-in-spirit (§5.1). Autocomplete is a port-time enhancement (Open questions).

Event list: `<div className="timeline" style={{ marginTop: "1.1rem" }}>`; merged items = `[...(extraEvents || []), ...task.timeline]` (optimistic prepend), rendered in array order (newest first). Empty state: `<div className="empty">No activity yet — this task hasn't started its operator loop.</div>`.

### 4.7 Timeline item rendering (`TimelineItem`)

Per-type metadata (verbatim):

```js
const EVENT_META = {
  comment:    { node: "",           icon: "message", label: "commented" },
  completion: { node: "completion", icon: "check",   label: "Completion report" },
  github:     { node: "github",     icon: "github",  label: "GitHub" },
  policy:     { node: "policy",     icon: "shield",  label: "Policy violation" },
  quality:    { node: "quality",    icon: "flag",    label: "Quality flag" },
  transition: { node: "transition", icon: "arrow",   label: "Transition request" },
  blocked:    { node: "blocked",    icon: "alert",   label: "Blocked decision" },
  agent:      { node: "agent",      icon: "agents",  label: "Operator" },
  assign:     { node: "transition", icon: "user",    label: "Ownership" },
};
```

Unknown types fall back to `comment` meta. Typed-event pill color kinds:

```js
function typedKind(type) {
  return { completion: "done", github: "neutral", policy: "input", quality: "risk",
           transition: "info", blocked: "blocked", agent: "agent", assign: "info" }[type] || "neutral";
}
```

Full item markup (verbatim — this is the contract for every event type):

```jsx
<div className="tl-item">
  <div className="tl-rail">
    <div className={"tl-node " + meta.node}><Icon name={meta.icon} /></div>
    <div className="tl-line" />
  </div>
  <div className="tl-body">
    <div className="tl-meta">
      <span className="tl-actor">{actor.name}{actor.role ? " · " + actor.role : ""}</span>
      {isTyped && <Pill kind={typedKind(ev.type)} sm>{meta.label}</Pill>}
      {actor.kind === "agent" && <Pill kind="agent" sm>agent</Pill>}
      {actor.kind === "human" && actor.guest && <Pill kind="neutral" sm>app user · not in project</Pill>}
      <span className="tl-time">{ev.day && ev.day !== "Today" ? ev.day + " · " + ev.t : ev.t}</span>
    </div>

    {ev.type === "comment" ? (
      <div className={"comment-card" + (ev.to === "agent" ? " toagent" : "")}>
        <div className="tl-text"><RichText text={ev.text} /></div>
      </div>
    ) : (
      <React.Fragment>
        {ev.title && <div className="tl-text"><strong>{ev.title}</strong></div>}
        <div className="tl-text"><RichText text={ev.text} /></div>
        {ev.evidence && (
          <div className="tl-card evidence">
            {ev.evidence.map((e, i) => (
              <div className="ev-row" key={i}>
                <span>{e.label}</span>
                <span><span className="add">{e.add}</span> <span className="del">{e.del}</span></span>
              </div>
            ))}
          </div>
        )}
      </React.Fragment>
    )}
  </div>
</div>
```

Notes:

- `isTyped = ev.type !== "comment"` — comments get **no** type pill; the `label: "commented"` in EVENT_META is dead copy.
- Comments routed to an agent (`to: "agent"`) get the `toagent` tinted card variant.
- Evidence rows: `add` and `del` values are display strings that already include signs (`"+14"`, `"−4"`, `"0"`); `.add`/`.del` classes color them.
- Time: `"Yesterday · 15:12"`, `"Mar 30 · 17:26"`, or just `"9:41"` for today. Real app stores timestamps and formats to this pattern.

### 4.8 Markdown-ish inline formatting (`RichText`)

Single-pass tokenizer, verbatim regex: `/(\*\*[^*]+\*\*|`[^`]+`|@[A-Za-z][\w-]*)/g`

- `**text**` → `<strong>`
- `` `text` `` → `<code className="mono">`
- `@word` (letter start, then word chars/hyphens) → `<span className="mention">`
- Everything else passes through as plain text. No links, no nesting, no escaping needed (JSX escapes). Port this exact 15-line renderer — do **not** substitute a full markdown library (it would change rendering of the seeded event text).

### 4.9 Sidebar

Column `.detail-side`, top to bottom:

**GithubTrace** — branch/PR strip.

Empty state (no branch and no PR):

```jsx
<div className="panel">
  <div className="panel-head"><Icon name="github" /><h2>GitHub</h2></div>
  <div className="empty" style={{ padding: "1rem .5rem" }}>No branch yet. A task-key branch is created when execution starts.</div>
</div>
```

Populated (`.panel.flush`):

```jsx
<div className="gh-bar">
  <Icon name="github" />
  <span className="repo">{task.repo}</span>
  {task.pr
    ? <Pill kind={task.pr.state === "merged" ? "done" : "info"} sm>{task.pr.state === "merged" ? "merged" : "PR #" + task.pr.number}</Pill>
    : <Pill kind="neutral" sm>no PR</Pill>}
</div>
<div className="gh-body">
  <div className="kv-row"><span className="k">Branch</span><span className="v"><Icon name="branch" /><span className="mono">{task.branch}</span></span></div>
  {task.changed && <div className="kv-row"><span className="k">Diff</span><span className="v mono">{task.changed.files} files · <span style={{ color: "var(--teal-dark)" }}>+{task.changed.add}</span> <span style={{ color: "var(--coral-dark)" }}>−{task.changed.del}</span></span></div>}
  {/* commits list, only when non-empty: */}
  <div className="lbl" style={{ fontSize:".68rem", fontWeight:900, letterSpacing:".05em", textTransform:"uppercase", color:"var(--placeholder)", marginBottom:".3rem" }}>Commits</div>
  <div className="commit"><span className="sha">{c.sha}</span><span className="msg">{c.msg}</span></div>
  <button className="btn ghost sm" style={{ marginTop:".8rem", width:"100%" }} onClick={() => push("External links are stubbed in this prototype")}>
    <Icon name="ext" />Open on GitHub
  </button>
</div>
```

Real app: "Open on GitHub" becomes a real external link (branch compare or PR URL); the toast goes away.

**Current state panel** — `.panel` head `Icon bolt` + `<h2>Current state</h2>`, `.kv` of `.kv-row`s:

- **Stage** — `{stage.name}`
- **Waiting on** — `task.waiting === "human"` → `<span style={{ color: "var(--blue-pressed)" }}>Human decision</span>`; `"agent"` → `<span style={{ color: "var(--agent-dark)" }}>Agent work</span>`; else `Nothing`.
- **Owner** — if owned:

  ```jsx
  <span className="rev-stack" title="Human owner — reviews & accepts, this task only">
    <Avatar person={task.owner} />
    <span className="rs-names">{task.owner.name.split(" ")[0]}{me && task.owner.name === me.name ? " (you)" : ""}</span>
    {me && (task.owner.name === me.name || myRole === "admin") && (
      <button type="button" className="own-x"
        title={task.owner.name === me.name ? "Release ownership" : "Release " + task.owner.name.split(" ")[0] + " (admin)"}
        aria-label="Release owner" onClick={() => setReleasing(true)}><Icon name="x" /></button>
    )}
  </span>
  ```

  If unowned: `<button className="rev-add sm" onClick={() => onOwner("take")}><Icon name="plus" />Assign me</button>` — note this takes ownership **directly**, no dialog.
- **Repo** — `<span className="v mono">{task.repo}</span>`

**PolicyPanel** — static rows derived from `myRole` (`admin = myRole === "admin"`), head `Icon shield` + `<h2>Permissions</h2>`:

| icon | k | v |
|---|---|---|
| user | Your role | `myRole` capitalized (fallback `Viewer`) |
| flag | Task owner | `Reviews & accepts · that task only` |
| plus | Ownership | admin: `Take / release · admin: anyone` / else: `Take / release · yours` |
| message | Comments | `Every registered user` |
| cpu | Agent may | `Request transition` |
| lock | Transition to done | `Human owner only` |

Each row: `<div className="policy-line"><span className="k"><Icon name={icon} />{k}</span><span className="v">{v}</span></div>`. Footer button `btn ghost sm` full-width: `<Icon name="shield" />View project policy` → `onPolicy()` → navigate to the policy view (mock: closes task, `setView("policy")`).

### 4.10 Embedded runtime panels (contract only — full spec with runs.jsx)

- `LiveRunPanel({ runtime, onViewLogs, push })` — renders `null` unless some run has `state === "running"`. Its "View logs" button calls `onViewLogs(run.id)`.
- `AgentLogsPanel({ runtime, sel, onSel })` — `TaskDetail` holds `logSel` state and passes it as `sel`; LiveRunPanel's `onViewLogs` sets it, which selects that thread in the logs panel. When `runtime` is empty it renders its own empty state ("No agent runs yet — runtime streams appear here once the operator engages a specialist."). Preserve this parent-held selection wiring.

---

## 5. Events / mutations produced

All of these are `App`-level closures in the mock (`main.jsx` lines ~165–252) mutating in-memory state (`overrides`, `extra`) and toasting. Each becomes a real RR7 **action** that appends a typed event to the task's event log in the file-native store, updates the projection, and revalidates (plus SSE fan-out). The mock hardcodes actor `ARDA`; real actions use the session user.

### 5.1 Post comment — `onComment(text)`

- Mock routing: `const toAgent = /@(agent|operator|codex|claude)\b/i.test(text)` → event `{ type:"comment", actor: me, t:"now", text, to: toAgent ? "agent" : null }` prepended.
- Toast: `Comment posted · routed to mentioned agent` / `Comment posted`.
- Real action: `POST comment` — persist a `comment` event; if mentions resolve to agents/operator, route the comment into that agent runtime (the `to:"agent"` flag on the stored event drives the `toagent` card tint). Mention resolution should use the real agent registry + project members, not this regex.

### 5.2 Ownership — `onOwner(action, person?)`

All variants write a typed **`assign`** event (exact mock copy below; real app should store structured data — action, from, to, forced — and render copy from it):

| action | task patch | event text | toast |
|---|---|---|---|
| `take` (unowned) | `owner = me` | `Took task ownership — owner is the human reviewer and acceptance authority for this task.` | `You own {KEY} · review & acceptance` |
| `take` (owned by other) | `owner = me` | `Took over task ownership from **{prev.name}** — owner is the human reviewer and acceptance authority.` | same |
| `assign` (hand off) | `owner = person` | `Handed task ownership to **{person.name}** — they hold review & acceptance for this task now.` | `Ownership handed to {First}` |
| `release` (self) | `owner = null` | `Released task ownership — review & acceptance stall until another member takes the seat.` | `Ownership released on {KEY}` |
| `release` (admin, other) | `owner = null` | `Released **{owner.name}** from task ownership (admin) — the seat is open to any project member.` | `{First} released from {KEY} · admin action` |

Demo-only special case: taking ownership of **VIB-148** also patches `readiness:"ready"`, `waiting:"agent"` and appends an operator (`type:"agent"`) event: `Acceptance boundary now owned by **Arda Kaya** — scheduling execution against the quality-gated scope.` — Generalize: when a quality-gated, unowned task gains an owner, the **operator runtime** (not the client) decides to schedule execution and writes its own event. Do not port the client-side special case.

Admin release must additionally be recorded in the audit trail (the dialog's foot-hint promises this).

### 5.3 Resolve decision packet — `onResolve({ option, packet })`

Mock dispatches on the option (literal title matching — **replace with stable option ids/kinds**, see Open questions):

1. Marks all packet/approval notifications for this task read (real: server-side).
2. `option.t === "Block on policy"` → append `blocked` event `**Decision:** hold on policy. {KEY} stays blocked until the project credential policy is updated.`; patch `readiness:"blocked", waiting:"human"`; navigate to repository settings; toast `Task held on policy · opening repository settings`.
3. `option.t === "Hold for runtime debug"` → append `blocked` event `**Decision:** hold for runtime debug. {KEY} stays blocked while the provider-native session is inspected — findings come back as task comments.`; patch `readiness:"blocked"`; toast `Held for runtime debug — the session is recorded per audit policy`.
4. `option.accept` (acceptance path) → append `completion` event `{ title:"Completion accepted", text:"Human acceptance recorded. Task transitioned to **Done** and review PR approved for merge." }`; patch `stage:"done", readiness:"done", waiting:"none", packet:null`, and `pr.state = "merged"` if a PR exists; toast `Completion accepted · {KEY} moved to Done`.
5. Anything else (send-back / resume paths) → append `transition` event with text `option.ev` if authored, else fallback `**Decision:** {option.t}. Operator re-engages the specialist with a summon note.`; patch `waiting:"agent", readiness:"ready", packet:null`; toast `Decision recorded: {option.t}`.

Real action: `resolvePacket(taskKey, packetId, optionId)` — must be idempotent/guarded (packet may already be resolved by someone else), clear the packet from the projection, write the typed decision event, apply stage/readiness transitions per option kind, and let the operator runtime react (re-engage specialist, merge PR, etc.). The "accept" path is the **human-only Review → Done boundary** — enforce `myRole` per the RBAC table (accept completion: admin/maintainer only) and/or owner-only, server-side.

### 5.4 Client-only interactions (no mutation)

- "Ask operator" → composer prefill/focus only.
- Timeline filter → local state (default from prefs).
- Manage menu open/close, release dialog open/close, agent-log thread selection.
- "Open on GitHub" / "Interrupt" (LiveRunPanel) → stub toasts in mock; real: external link / governed runtime action.

### Typed events this surface can write (summary)

`comment` (with agent-routing flag), `assign` (take / take-over / hand-off / release / admin-release), `blocked` (hold decisions), `transition` (send-back / resume decisions), `completion` (acceptance). The operator/agents write the rest (`github`, `policy`, `quality`, `agent`) — this surface only renders those.

---

## 6. CSS classes used (structural contract)

Layout: `detail`, `detail-main`, `detail-side`, `panel`, `panel flush`, `panel-head` (+ `h2`, `.right`), `empty`.

Hero: `task-hero`, `key`, `hero-meta`, `hero-file`, `goal`, `col-stage-dot`.

Packet: `packet` (+ modifier `input` | `blocked`), `packet-top`, `from`, `packet-body`, `packet-obs`, `obs` (+ children `k`), `options`, `opt` (+ `sel`, `recommend`), `radio`, `ot`, `od`, `rec-tag`, `packet-actions`.

Buttons/pills (shared): `btn primary|ghost|danger` (+ `sm`), `icon-btn`, `pill` + kinds `ready|input|risk|blocked|done|info|agent|neutral` (+ `sm`, `pdot`), `mono`.

Profile: `profile-grid`, `profile-cell`, `lbl`, `val`, `nm`, `sub`, `consultants`, `who-chip`, `rev-row`, `rev-chip`, `rev-add` (+ `sm`), `agent-glyph` (+ `op`, `lg`, `warn`, `claude`, `codex`), `avatar` (+ tone classes `rose|teal|violet`, `lg`).

Ownership menu: `own-wrap`, `own-btn` (+ `open`), `own-menu`, `menu-item` (+ `danger`), `own-lbl`, `own-role`, `menu-sep`.

Release dialog: `confirm-scrim`, `modal-card release-card`, `modal-head`, `mh-main`, `mh-sub`, `modal-close`, `modal-body`, `modal-foot`, `foot-hint`, `foot-actions`, `rel-owner`, `rel-open`, `rel-lbl`, `rel-row`, `handoff-chip` (+ children `nm`, `rl`).

Timeline: `tl-filter` (+ `on`), `composer`, `composer-box`, `composer-foot`, `timeline`, `tl-item`, `tl-rail`, `tl-node` (+ modifiers `completion|github|policy|quality|transition|blocked|agent`), `tl-line`, `tl-body`, `tl-meta`, `tl-actor`, `tl-time`, `tl-text`, `comment-card` (+ `toagent`), `tl-card evidence`, `ev-row` (+ children `add`, `del`), `mention`.

Sidebar: `gh-bar` (+ `repo`), `gh-body`, `kv`, `kv-row` (+ children `k`, `v`), `commit` (+ `sha`, `msg`), `policy-line`, `rev-stack`, `rs-names`, `own-x`.

Icons used (names into shared `Icon`): `shield, check, message, plus, user, chevron, x, hand, agents, activity, github, branch, file, bolt, flag, lock, cpu, arrow, alert, send, ext` (+ `term` inside the runs panels).

CSS variables referenced inline: `--font-display, --muted, --faint, --hairline, --placeholder, --teal-dark, --coral-dark, --blue-pressed, --agent-dark`.

---

## 7. Porting notes

**Prototype-only mechanisms and their replacements**

- `window.VIBERR.*` globals (`tasks`, `stages`, `runtime`, `policy.members`, `prefs`, `people`) → RR7 loader data: task projection + project stages + membership + runtime snapshot; SSE for live runtime lines and timeline revalidation. **OwnerControl and ReleaseConfirm read `window.VIBERR.policy.members` directly inside the components** — thread members through props/loader instead.
- Hash routing / `setOpenKey` → real nested route with `:taskKey` param; breadcrumb from route matches.
- `extraEvents` optimistic-prepend + `overrides` patch map → server mutation + revalidation (optionally `useFetcher` optimistic UI). Timeline order contract: newest first.
- Hardcoded actor `window.VIBERR.people.ARDA` in every mutation → session user.
- `t: "now"` timestamps and preformatted `t`/`day` strings → store real timestamps; format as `HH:mm` for today, `Yesterday · HH:mm`, `Mon D · HH:mm` otherwise (match `ev.day !== "Today"` display rule).
- Option matching by literal English titles (`"Block on policy"`, `"Hold for runtime debug"`) and the `accept` boolean → give packet options stable `id` + `kind` (`accept | send_back | block_policy | hold_debug | resume | fresh_specialist`), and drive both the resolve action and post-resolve state transitions from `kind`.
- VIB-148 take-ownership side effect → operator-runtime behavior, not client code (§5.2).
- Notification read-marking inside `onResolve` → server-side effect of packet resolution.
- Toast copy: keep the strings (§5) but they come back from the action/fetcher.
- `data-screen-label` attributes are prototype screenshot/tooling hooks — harmless; keep or drop consistently across the port.
- `useToasts`/`ToastHost` → whatever global toast mechanism the real shell ports from `ui.jsx`.
- Inline styles: the mock leans on a handful of inline styles (packet body prose, consultant chips, composer footer hints, GithubTrace commits label, diff +/− colors, sidebar waiting-on colors, timeline top margin, GithubTrace/modal spacing). Either reproduce them verbatim or promote to classes in the ported stylesheet — but do not swap in off-palette values; they all reference `--viberr-*`-derived tokens listed in §6.

**Permissions to enforce server-side** (mock enforces in UI only): take/release ownership — any member (release-any: admin only); resolve packet / accept completion — per RBAC (`Accept completion → Done`: admin+maintainer; also consider owner-gating, see Open questions); comment — every registered app user, including non-members (guests render with the `app user · not in project` pill).

**Edge cases the mock already handles — keep them**

- No packet → no DecisionPacket panel at all.
- Packet with no `rec` option → first option preselected (`Math.max(0, -1)`).
- `p.options[sel]` missing → button label falls back to `Confirm` (but treat a packet with zero options as a data error server-side).
- `task.operator === null` (triage tasks VIB-166/168) → operator cell sub shows `coordinator · —`.
- `specialist: null` / `consultants: []` / `owner: null` → explicit empty copy (§4.3).
- No branch & no PR → GithubTrace empty state; branch but no PR → `no PR` neutral pill; `commits`/`changed` optional rows.
- `runtime` missing for key → `[]`; LiveRunPanel renders null; AgentLogsPanel renders its empty state.
- Empty timeline → empty-state copy (§4.6).
- Unknown stage id → blank stage name, no crash.
- Guest commenter (`actor.guest`) → neutral pill.
- Release dialog when `task.owner` is null → guarded by `task.owner || me` (shouldn't happen; keep the guard).

**Error states to add (mock has none)**: comment post failure (keep draft, show error), packet already resolved by another user (revalidate → packet gone; show a toast, not a crash), ownership conflict (someone else took it first), task not found (loader 404).

**Accessibility inventory to preserve**: options radiogroup (`role="radiogroup"` aria-label `Decision options`, `role="radio"` + `aria-checked`); Manage button `aria-haspopup="menu"` + `aria-expanded`; menu `role="menu"`/`menuitem` + aria-label `Manage task ownership`; release dialog `role="alertdialog"` + `aria-modal` + aria-label `Release ownership of {KEY}` + Escape-to-close; close buttons aria-label `Close`; sidebar release button aria-label `Release owner`; icons `aria-hidden`. Add in port: focus trap + initial focus in the dialog, Escape for the Manage menu, arrow-key roving for the radiogroup.

**React details**: timeline/observation/option lists use index keys — switch to event ids once events have identities. The outside-click close uses a `mousedown` document listener bound only while open — fine to keep.

---

## 8. Open questions

1. **Who may resolve a packet?** The mock lets anyone click resolve. RBAC says accept-completion is admin/maintainer; the product copy repeatedly says the *owner* "reviews & accepts". Owner-only? Owner-or-maintainer? Must be decided before the action guard is written.
2. **Packet body formatting** — packet `body` and observation values contain backticked code (`` `pull_request:write` ``) but are rendered as plain text (no RichText) in the mock. Bug or intent? Recommend running `body` through the same RichText renderer.
3. **Option identity & authored decision text** — `option.ev` is pre-authored markdown for the resulting timeline event. Who authors it in the real system (operator runtime at packet-creation time?) and is the fallback string acceptable?
4. **"Ask operator"** — purely a composer prefill in the mock. Should it also ping the operator runtime / create a notification, or is posting the resulting `@operator` comment enough?
5. **Mention routing** — regex `@(agent|operator|codex|claude)` is a stand-in. Real resolution needs the agent registry + member usernames, plus a composer autocomplete. What is the mention grammar (display names vs handles)?
6. **`tlDefault` preference** — per-device localStorage in the mock. Move to per-user server-side prefs or keep client-side?
7. **"operator active" pill** on Execution profile is unconditional in the mock. Should reflect the operator runtime state (`running/idle/none`) — confirm desired states and copy.
8. **Admin release audit** — dialog promises "recorded … in the audit trail". Define the audit record shape (separate from the `assign` timeline event?) and whether a reason field is required.
9. **"Open on GitHub"** target — branch page, compare view, or PR when one exists?
10. **Accept-completion side effects** — mock flips `pr.state` to `merged` instantly. Real flow: does acceptance trigger an actual merge via the GitHub integration (async, may fail — PAT scope flag in VIB-142 is exactly this), or just approve-for-merge? Needs an async/failure state on the accept path.
11. **Timeline compression** — policy guardrail `compression-threshold` (40 events) implies long timelines arrive compressed. Does the detail view need "expand compressed span" UI, or does the projection handle it invisibly?
12. **Concurrent ownership changes** — last-write-wins or optimistic-locking on the owner field?
