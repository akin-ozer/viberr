# Spec: Review queue (`design/html-app/app/review.jsx` → `app/features/review/`)

Source of truth: `design/html-app/app/review.jsx` (74 lines — the whole file is reproduced in
fragments below), shared primitives in `design/html-app/app/ui.jsx`, data shapes in
`design/html-app/app/data.js`, host wiring in `design/html-app/app/main.jsx` (lines 133, 293–294).
CSS contract: `design/html-app/app/viberr.css` (ported verbatim — **class names are the
contract**, do not rename or replace with Tailwind).

File header comment in the mock: `/* Viberr — Review queue: the human acceptance boundary
(FR25–FR27) */`.

---

## 1. Purpose & entry points

The Review queue is the **human acceptance boundary** made visible as a dedicated surface. It
answers one question: *of everything at the Review stage, what is waiting on a human right now,
and what is still with agents?* It is a **read-only triage list** — no mutation happens on this
screen. Every row navigates to the task detail workspace, where the actual acceptance/send-back
decision (the packet resolution) lives. The only other affordance is a policy chip that navigates
to the Policy surface to explain *why* Review → Done is human-only.

Design intent baked into the copy: acceptance is always a human action, always audited, and
completion reports "land at the boundary" — the queue is where they surface.

### Qualification rule (which tasks appear)

```js
const inReview = tasks.filter((t) => t.stage === "review");
const ready    = inReview.filter((t) => t.waiting === "human");   // panel 1
const working  = inReview.filter((t) => t.waiting !== "human");   // panel 2
```

- **Only `stage === "review"` qualifies.** A task carrying a packet in another stage (e.g.
  VIB-160, a "Blocked decision" packet at stage `impl`) does **not** appear here — it surfaces
  via notifications and the board instead.
- The split is purely on `waiting`. Seed values of `waiting` are `"human" | "agent" | "none"`;
  anything not `"human"` goes to "Still with agents" (including `"none"` — see Porting notes §7).
- The list is **project-wide, not per-user**: "Waiting on **your** acceptance" is not filtered by
  `owner === current user` in the mock (see Open questions).

With seed data: panel 1 = VIB-142 (owner Arda, completion-report packet, PR #318, validation
`changed`, `urgent: true`); panel 2 = VIB-145 (no owner, no packet, PR #311, validation
`healthy`, waiting `agent`).

### Entry points (mock → real)

| Mock | Real app |
|---|---|
| `main.jsx` renders `<ReviewQueue tasks={tasks} onOpen={(k) => setOpenKey(k)} onPolicy={() => goView("policy")} />` when `view === "review"` and no task is open | Route `/projects/:slug/review` (per CONVENTIONS route map) |
| Hash `#review` pre-selects the view at page load (`main.jsx` line 133; hash is read once, never written back) | Real route, real URL |
| Rail nav item `review` (label "Review queue", icon `inbox`) with count badge `tasks.filter((t) => t.stage === "review").length` — i.e. **all** review-stage tasks, not just the ones waiting on a human | Same badge semantics in the ported shell (see shell spec) |
| Row click → `onOpen(task.key)` → task detail replaces the view | Navigate to `/projects/:slug/tasks/:key` |
| Policy chip click → `onPolicy()` → `goView("policy")` (clears any open task, switches view) | Navigate to `/projects/:slug/policy` |

Props in the mock:

- `tasks` — the merged array (base data + session-created + per-key overrides) from the app root.
- `onOpen(key)` — open task detail.
- `onPolicy()` — go to the Policy view.

Real-app loader: a **projection query** — `task_projections` for the project filtered
`stage = 'review'`, returning the row fields in §3. Revalidate on SSE `task.updated` /
`projection.rebuilt` so accepted tasks leave the queue live (no optimistic UI for governed
state per CONVENTIONS).

---

## 2. Component tree

```
ReviewQueue                       – stateless view; derives ready/working from props
├─ board-wrap                     – column layout (+ data-screen-label="Review queue", drop in port)
│  ├─ board-head                  – h1 "Review queue", counts subtitle, board-tools
│  │  └─ button.hero-file         – policy chip "Review → Done · human only" → onPolicy
│  └─ policy-wrap                 – scrolling column (class reused from Policy view CSS)
│     ├─ panel                    – "Waiting on your acceptance" (hand icon, "X of Y" count)
│     │  ├─ rq-list → RQRow×N (ready)   – or .empty fallback
│     │  └─ pol-note              – lock icon + acceptance explanation (always rendered)
│     └─ panel                    – "Still with agents" (activity icon, count)
│        └─ rq-list → RQRow×N (working) – or .empty fallback
RQRow({ t, onOpen, ready })       – one task = one whole-row <button className="rq-row">
├─ rq-key                         – mono task key ("VIB-142")
├─ rq-main                        – .ttl title + .sub one-line summary (ellipsized)
└─ rq-meta                        – [PR pill?] + ValidationPill + wait-tag
rqStripMd(s)                      – strips ** and ` from markdown-ish timeline text
```

One-liners:

- **ReviewQueue** — no local state, no effects; pure function of `tasks`.
- **RQRow** — the entire row is a single `<button>` (no nested interactive elements); `ready`
  prop only switches the trailing wait-tag variant.
- **rqStripMd** — `(s) => (s || "").replace(/\*\*/g, "").replace(/`/g, "")`; module-local helper,
  duplicate it (or share with the notifications `plain()` helper — same regexes).

Shared primitives consumed from `ui.jsx` (see ui-primitives spec): `Icon` (names used here:
`hand`, `activity`, `lock`), `Pill`, `ValidationPill` (+ its `VALIDATION` map). Nothing else —
no `ReadinessPill`, no `Avatar`, no `AgentGlyph` on this surface.

---

## 3. Data consumed

Per task row, exactly these fields (all read-only here):

| Field | Type / values | Used for | Real-app source |
|---|---|---|---|
| `key` | `"VIB-142"` (matches `^[A-Za-z]+-\d+$`) | `rq-key`, React key, `onOpen(key)` | projection (task id/key) |
| `title` | string | `.ttl` | projection ← `task.md` frontmatter |
| `stage` | `"review"` (filter) | queue membership | projection (governed stage) |
| `waiting` | `"human" \| "agent" \| "none"` | panel split + wait-tag | projection (derived: open packet addressed to human vs. agent run in flight) |
| `packet` | `null` or object; row reads only `packet.kind` (`"Completion report"`, `"Blocked decision"`) and `packet.title` | preferred `.sub` line | projection of the pending packet for the task |
| `timeline` | array of typed events, **newest-first**; row reads only `timeline[0].text` | fallback `.sub` line | projection: latest timeline event from `task.md` |
| `pr` | `null` or `{ number, state: "review" \| "merged", title }` | optional `Pill` "PR #318" | projection ← GitHub sync state |
| `validation` | `"healthy" \| "changed" \| "failing" \| "none"` | `ValidationPill` | projection ← validation evidence status |

Full packet shape for reference (VIB-142, `data.js` lines 47–64) — the queue reads only
`kind` + `title`, the rest is consumed by task detail:

```js
packet: {
  type: "input",
  kind: "Completion report",
  from: "Operator",
  title: "Accept completion, or send back for one fix?",
  body: "…",
  observations: [ { k, v, code } … ],
  options: [ { t, d, rec, accept?, ev? } … ],
}
```

Subline (`sub`) precedence, verbatim:

```js
const sub = t.packet
  ? t.packet.kind + " — " + t.packet.title
  : (t.timeline && t.timeline.length
    ? rqStripMd(t.timeline[0].text)
    : "Agent working — the packet arrives at the boundary.");
```

Seed-data renderings of that line:

- VIB-142 → `Completion report — Accept completion, or send back for one fix?`
- VIB-145 → `Transition request: move VIB-145 from In Progress to Review — SSE fan-out demo
  recorded, evidence attached.` (bold markers stripped by `rqStripMd`)
- A review-stage task with neither packet nor timeline → the hardcoded fallback
  `Agent working — the packet arrives at the boundary.`

Other inputs:

- **Session**: none read directly. The "your" in the copy refers to the signed-in user but no
  per-user filtering happens (Open questions §8.1).
- **File store**: everything above must ultimately derive from canonical `task.md` files via the
  projection pipeline — the loader must never read task files directly per CONVENTIONS.
- **Env**: none.
- **Ordering**: the mock preserves seed-array order (VIB-142 before VIB-145 only because of
  `TASKS` array position). The real loader must pick a deterministic `ORDER BY` (Open
  questions §8.2).

---

## 4. UI states & interactions

### 4.1 Header

```jsx
<div className="board-head">
  <div>
    <h1>Review queue</h1>
    <div className="sub">{inReview.length} task{inReview.length === 1 ? "" : "s"} at the review boundary · {ready.length} waiting on your acceptance</div>
  </div>
  <div className="board-tools">
    <button type="button" className="hero-file" style={{ cursor: "pointer" }} onClick={onPolicy} title="Review → Done is locked to humans — see Policy">
      <Icon name="lock" /><span>Review → Done · human only</span>
    </button>
  </div>
</div>
```

- Subtitle copy is exact; note the singular/plural handling applies to the **first** count only
  (`1 task` / `2 tasks`), and the second clause is always `… waiting on your acceptance` even
  when `ready.length === 1`.
- The policy chip reuses the `hero-file` class (a file-chip style from the home page) with an
  inline `cursor: pointer` override, a native `title` tooltip (`Review → Done is locked to
  humans — see Policy`), and a lock icon. Keep all three; the tooltip is the only place that
  explains the chip before clicking.
- Chip click navigates to Policy. It is a navigation, not a toggle — no pressed state.

### 4.2 Panel 1 — "Waiting on your acceptance"

```jsx
<div className="panel">
  <div className="panel-head"><Icon name="hand" /><h2>Waiting on your acceptance</h2>
    <span className="right sub" style={{ fontSize: ".76rem", color: "var(--faint)" }}>{ready.length} of {inReview.length}</span>
  </div>
  {ready.length
    ? <div className="rq-list">{ready.map((t) => <RQRow key={t.key} t={t} onOpen={onOpen} ready />)}</div>
    : <div className="empty">Nothing waits on you. Completion reports land here when a task reaches the boundary.</div>}
  <div className="pol-note" style={{ marginBottom: 0, marginTop: ".9rem" }}>
    <Icon name="lock" />
    <span>Accepting a completion merges the review PR and moves the task to <strong>Done</strong> — always a human action, always in the audit log.</span>
  </div>
</div>
```

- Head count reads `"{ready} of {inReview}"` (e.g. `1 of 2`) in a `span.right.sub` with the two
  inline styles shown (keep them; `.right` handles `margin-left: auto`).
- Empty state (exact copy): **"Nothing waits on you. Completion reports land here when a task
  reaches the boundary."**
- The `pol-note` explainer renders **always** — populated or empty — below the list, with inline
  `marginBottom: 0, marginTop: ".9rem"` overriding the class default. "Done" is wrapped in
  `<strong>` (the CSS colors `pol-note strong` with `var(--fg)`).

### 4.3 Panel 2 — "Still with agents"

```jsx
<div className="panel">
  <div className="panel-head"><Icon name="activity" /><h2>Still with agents</h2>
    <span className="right sub" style={{ fontSize: ".76rem", color: "var(--faint)" }}>{working.length}</span>
  </div>
  {working.length
    ? <div className="rq-list">{working.map((t) => <RQRow key={t.key} t={t} onOpen={onOpen} />)}</div>
    : <div className="empty">No review work in flight.</div>}
</div>
```

- Head count is a bare number (no "of" phrasing).
- Empty state (exact copy): **"No review work in flight."**
- No pol-note in this panel.

### 4.4 Row anatomy (RQRow) — verbatim

```jsx
<button className="rq-row" onClick={() => onOpen(t.key)}>
  <span className="rq-key">{t.key}</span>
  <span className="rq-main">
    <div className="ttl">{t.title}</div>
    <div className="sub">{sub}</div>
  </span>
  <span className="rq-meta">
    {t.pr && <Pill kind={t.pr.state === "merged" ? "done" : "info"} sm>PR #{t.pr.number}</Pill>}
    <ValidationPill value={t.validation} sm />
    {ready
      ? <span className="wait-tag human"><Icon name="hand" />your acceptance</span>
      : <span className="wait-tag agent"><span className="working" />agent working</span>}
  </span>
</button>
```

Behavioral details:

- **Whole row is one `<button>`** — the only interactive element; there are `<div>`s inside a
  `<button>` (`.ttl`/`.sub`), which the mock tolerates; the port may keep it (browsers accept it)
  or switch the inner `div`s to `span`s with the same classes — visual classes are what matter.
  If ported as a `<Link>`, keep `className="rq-row"` and verify the anchor resets (the CSS sets
  `width: 100%; text-align: left` on the class already).
- **Meta cluster, left → right**: PR pill (only if `t.pr` exists; `kind="done"` when
  `pr.state === "merged"`, else `kind="info"`; label `PR #{number}`), then ValidationPill
  (**always** rendered — `value: "none"` shows the neutral "no validation" pill; unknown values
  also fall back to it), then the wait tag.
- **Wait tag copy** — this surface uses `your acceptance` (with `hand` icon), **not** the board's
  "waiting on you". The agent variant is `agent working` with the pulsing `.working` dot (no
  icon). Do not unify the two copies.
- ValidationPill label map (from `ui.jsx`): `healthy` → "validation healthy" (kind `ready`),
  `changed` → "evidence changed" (kind `input`), `failing` → "validation failing" (kind
  `blocked`), `none` → "no validation" (kind `neutral`). Never dotted.
- **Hover** (CSS): border turns `var(--blue)`, `translateY(-1px)`, soft blue shadow. Keyboard
  focus comes from the global button focus styles — no extra work, but do not remove the
  native-button (or anchor) focusability.
- **Accessibility**: the row has no `aria-label`; its accessible name is the concatenated text
  (key + title + sub + pill labels + wait-tag text), which is deliberately informative. Icons are
  `aria-hidden` (built into `Icon`). The `.working` dot is decorative; the sibling text "agent
  working" carries the meaning.
- **Motion**: `.working` pulses via `@keyframes pulse-a` (1.6s infinite). The global
  `[data-motion="reduce"]` rule in `viberr.css` kills all animation — the port's reduced-motion
  preference must keep setting `data-motion` on `<html>` (see profile/settings spec).
- **Responsive**: `@media (max-width: 1100px)` lets `.rq-row` wrap and gives `.rq-main` a
  220px minimum — comes free with the ported CSS.

### 4.5 Whole-surface states

- **Both panels always render**, each with its own empty text — there is no separate
  all-empty hero screen. A project with zero review-stage tasks shows header
  "0 tasks at the review boundary · 0 waiting on your acceptance" plus the two empty panels
  and the pol-note.
- No loading state in the mock (data is synchronous). Real app: loader-rendered; on SSE-driven
  revalidation rows appear/disappear without local state to reconcile (component is stateless).
- No error state in the mock. Real app: route error boundary.
- No pagination, search, or filters — the queue is intentionally small; do not add tools.

---

## 5. Events / mutations produced

**None on this surface.** Both interactions are navigations:

| Interaction | Mock | Real |
|---|---|---|
| Row click | `onOpen(t.key)` → `setOpenKey(key)` in `main.jsx` | navigate `/projects/:slug/tasks/:key` |
| Policy chip | `onPolicy()` → `goView("policy")` | navigate `/projects/:slug/policy` |

### Downstream contract the queue depends on (implemented in task detail, not here)

The queue's reason to exist is the acceptance flow. In the mock, resolving the completion packet
happens in `TaskDetail` via `onResolve` (`main.jsx` lines 223–252). The "Accept completion"
option does, atomically from the user's perspective:

1. Prepends a typed timeline event to the task:
   `{ type: "completion", actor: <human>, title: "Completion accepted", text: "Human acceptance
   recorded. Task transitioned to **Done** and review PR approved for merge." }`
2. Overrides the task: `stage: "done"`, `readiness: "done"`, `waiting: "none"`, `packet: null`,
   `pr.state: "merged"`.
3. Toast: `Completion accepted · VIB-142 moved to Done`.

In the real app this becomes a governed action on the task route that: writes the typed
`completion` timeline event into `task.md` (file first), transitions the stage, merges the review
PR via the GitHub integration, emits an audit event, re-projects, and publishes SSE
(`task.updated`). **The review queue's only obligation is to revalidate on that SSE event so the
task leaves panel 1.** Same for send-back decisions (`waiting` flips to `"agent"`, task moves to
panel 2) and for transition requests that move new tasks into `stage: "review"` (task appears in
the queue).

The pol-note copy ("always a human action, always in the audit log") is a **product invariant**
the backend must actually enforce: the Review → Done transition must be rejected server-side for
agent actors (see the seed policy event: "Blocked: Developer (Codex) attempted **Merge a pull
request** — reserved for humans").

---

## 6. CSS classes used (structural contract)

All already in the ported `viberr.css`; listed here as the contract for this surface:

- Layout: `board-wrap` (+ `data-screen-label="Review queue"` — drop in port, screenshot tooling
  only), `board-head` (`h1`, `.sub`), `board-tools`, `policy-wrap` (shared with the Policy view —
  scroll container, `.15rem 1.4rem 1.4rem` padding, `1.1rem` gap).
- Header chip: `hero-file` (+ inline `cursor: pointer`).
- Panels: `panel`, `panel-head` (`h2`, `.ico`, `.right` + `.sub`), `pol-note` (`strong`), `empty`.
- Rows: `rq-list`, `rq-row`, `rq-key`, `rq-main` (`.ttl`, `.sub`), `rq-meta`.
- Pills: `pill` + kinds `info` / `done` / `ready` / `input` / `blocked` / `neutral`, size `sm`
  (via `Pill` / `ValidationPill`).
- Wait tags: `wait-tag`, `wait-tag human`, `wait-tag agent`, inner `working` (pulse-a animation).
- Icons: `ico` (via `Icon`).

Note: `viberr.css` also has `.rq-main .sub .mono` rules, but the mock never renders `.mono`
spans in the subline — it strips backticks instead (`rqStripMd`). Keep the stripping behavior;
the CSS rule is dormant (see Open questions §8.6).

---

## 7. Porting notes

1. **Prototype bits to replace**: `window.VIBERR.tasks` + in-memory overrides → projection query
   in a route loader; `view === "review"` switch in `main.jsx` → route module
   `/projects/:slug/review`; `#review` hash → real URL (the mock reads the hash once at load and
   never writes it back — the real router fixes this for free); `Object.assign(window,
   { ReviewQueue })` → normal module export; `onOpen`/`onPolicy` callbacks → `<Link>`/`navigate`.
2. **Feature location**: CONVENTIONS' `features/` list does not name a review directory even
   though the route map includes `/review`. Recommend `app/features/review/` (own loader; it is
   not a board sub-view). Flagged in Open questions.
3. **Derive, don't store**: `ready`/`working` are derived each render. Either have the loader
   return the pre-split lists (recommended: `{ ready: [...], working: [...] }` from one
   `stage = 'review'` query split on `waiting`) or return the flat list and filter in the
   component — but never cache the split in state.
4. **Rail badge parity**: the shell's Review queue badge counts **all** review-stage tasks
   (`inReview.length`), and the panel-1 count is the "X of Y" pair. Both numbers must come from
   the same projection so they can't drift.
5. **`waiting === "none"` at review stage** lands in "Still with agents" with the "agent
   working" pulsing tag — arguably misleading (nothing is running). The mock has no such seed
   row (done tasks are `waiting: "none"` but stage `done`). Port the mock behavior 1:1; if the
   projection can produce `review` + `none`, flag it (Open questions §8.4).
6. **`rqStripMd` fidelity**: only `**` and `` ` `` are stripped; any other markdown in
   `timeline[0].text` passes through raw. Port identically — do not introduce a markdown
   renderer for the subline (it's a one-line ellipsized summary).
7. **`timeline[0]` means newest**: seed timelines are newest-first. The projection must supply
   the *latest* event's text for the fallback subline — if the real store orders oldest-first,
   invert before projecting.
8. **Fallback subline** ("Agent working — the packet arrives at the boundary.") is reachable in
   the real app (e.g. a task file hand-moved to `stage: review` with an empty timeline via the
   file-native store + re-scan). Keep it — it doubles as the "projection is thin" placeholder.
9. **Inline styles**: three of them (`cursor: pointer` on the chip, the two panel-head count
   styles, the pol-note margins) — keep them verbatim rather than minting new classes, per the
   ported-CSS-verbatim rule.
10. **PR pill `done` kind is live behavior, not dead code**: after acceptance the mock sets
    `pr.state = "merged"` while the task leaves the queue, so `kind="done"` looks unreachable —
    but a re-projected task could transiently be `stage: review` with a merged PR (e.g. manual
    file edits). Keep the conditional.
11. **No DnD, no bulk actions, no per-row accept button** — acceptance requires opening the task
    and reading the packet. This is intentional friction at the boundary; do not "improve" it.
12. **Sub-agent copy divergence is intentional**: board wait-tag says "waiting on you", review
    row says "your acceptance". Do not extract a shared component that unifies the copy;
    parameterize if sharing.
13. **`data-screen-label`** — drop (screenshot tooling), consistent with board/ui-primitives
    specs.

---

## 8. Open questions

1. **Per-user scoping**: "Waiting on your acceptance" lists every `waiting: "human"` review task
   project-wide, including tasks owned by someone else (seed VIB-142 happens to be owned by the
   signed-in user, so the mock is ambiguous). Should the real queue (a) stay project-wide
   (recommended — matches copy "0 of N" and the boundary framing), (b) split "yours" vs
   "others'", or (c) filter to `owner = me`? Needs a product call before the loader is written.
2. **Row ordering**: mock order is seed-array order. Proposal: panel 1 by packet-raised time
   (oldest waiting first — it's a queue), panel 2 by last-activity desc. Confirm before choosing
   `ORDER BY`.
3. **Feature directory**: CONVENTIONS `features/` list omits `review/` — confirm
   `app/features/review/` vs folding into `features/board/`.
4. **`review` + `waiting: "none"`**: can the projection legally produce this combination, and if
   so should panel 2 suppress the pulsing "agent working" tag for it?
5. **Should the rail badge count `ready` instead of all review-stage tasks?** Mock says all;
   notification-minded users may expect only actionable ones. Keep mock behavior unless product
   says otherwise.
6. **Dormant `.rq-main .sub .mono` CSS**: an earlier design apparently rendered backtick spans as
   `.mono`; the shipped mock strips them. Confirm stripping is final (spec assumes yes).
7. **Owner display**: rows show no owner/specialist identity (unlike board cards). Confirm this
   is intentional minimalism, not an omission — especially relevant if 8.1 resolves to
   "project-wide".
