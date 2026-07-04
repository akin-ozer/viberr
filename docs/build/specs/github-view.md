# Spec: GitHub view (`design/html-app/app/github.jsx` → `app/features/github/`)

Porting spec for the GitHub surface: repository panel (connection + credential health),
pull-request list, execution-branch table with sync states, and the scope-violation
banner with its cross-surface resolution path. Written for an engineer who will NOT
read the mock file. Mock source is 120 lines; everything load-bearing is quoted here.

Header comment in the mock: `/* Viberr — GitHub view: repository health, branch & PR
traceability (FR29–FR32) */`.

---

## 1. Purpose & entry points

**Purpose.** Read-mostly dashboard proving the task→branch→commit→PR traceability
story for one project. Three panels:

1. **Repository** — which repo the project executes against, connection status,
   the credential (masked PAT) and its scope health. This is where the
   `pull_request:write` scope violation surfaces as a warning banner.
2. **Pull requests** — every task that has a PR, as clickable rows (open task detail).
3. **Execution branches** — every task that has a branch, as a 4-column table with a
   derived per-task sync pill (`synced` / `behind main` / `merged`).

There is exactly one mutation-shaped affordance on the page (Reconcile); everything
else is navigation. The **resolution** of the scope violation happens on the Settings
surface, but this spec documents the full path because the GitHub view is where the
violation is most prominently presented.

### Entry points (mock → real)

- Mock: hash route `#github`, matched in `main.jsx`
  (`/^#(board|review|agents|policy|github|activity|settings)$/`), rendered as
  `<GithubView tasks={tasks} onOpen={(k) => setOpenKey(k)} onNav={goView} push={push} scopeGranted={scopeGranted} />`.
- Real: route `/projects/:slug/github` (per `docs/build/CONVENTIONS.md` route map),
  feature dir `app/features/github/`.
- Rail nav item `github` (label "GitHub", icon `github`) navigates here.
- Row clicks call `onOpen(task.key)` → real: navigate to `/projects/:slug/tasks/:key`.
- "Fix in Settings" calls `onNav("settings")` → real: `/projects/:slug/settings`
  (ideally with a fragment/anchor to the Repository & credentials panel — see Open
  questions).

### Cross-surface tie-ins (same `scopeGranted` state)

The mock keeps one app-level boolean in `main.jsx`:

```jsx
const [scopeGranted, setScopeGranted] = useStateA(false); // credential policy fix (wired to VIB-142)
```

It feeds four surfaces simultaneously:

- **GithubView** (this page): banner + scope chips.
- **Settings → RepoSettings** (`settings.jsx`): identical card, but with the actual
  **Grant scope** button (the resolution).
- **Activity → AuditLogs** (`activity.jsx`): the violation audit-log entry renders as
  resolved when `scopeGranted` is true.
- **Rail** (`main.jsx` line 262): `violations={scopeGranted ? 0 : 1}` — a coral count
  badge on the *Settings* nav item (note: on Settings, not on GitHub).

In the real app this must be ONE server-derived fact (the stored scope-check result
for the project credential), consumed by all four surfaces via their loaders, not a
client boolean.

---

## 2. Component tree

```
GithubView({ tasks, onOpen, onNav, push, scopeGranted })   — page root, no local state
├─ ghSync(t)                     — module-level pure helper: task → {label, kind} sync pill
├─ header (.board-head)          — h1 "GitHub", sub line, two toolbar buttons
├─ .policy-wrap                  — page column layout (same wrapper as Policy/Settings/Activity)
│  ├─ .policy-cols               — 2-column grid row
│  │  ├─ Repository panel        — .panel: kv rows + .cred-card (scope chips, warn/ok footer)
│  │  └─ Pull requests panel     — .panel: .rq-list of .rq-row buttons + .pol-note
│  └─ Execution branches panel   — .panel: .gh-table > .live-table (+ .pol-note)
└─ (toasts via push() render in the shell's ToastHost)
```

Shared primitives from `ui.jsx` (already ported per `ui-primitives.md`): `Icon`
(names used here: `refresh`, `ext`, `github`, `lock`, `check`, `alert`, `sliders`,
`pr`, `branch`) and `Pill` (`kind` ∈ `ready|info|done|risk`, props `sm`, `dot`).

The whole view is a single component — no dialogs, no menus, no local state, no
effects. Suggested real files: `app/features/github/github-view.tsx` +
`app/routes/projects.$slug.github.tsx` (thin loader/action module).

### The sync helper (verbatim — this is the contract for the Sync column)

```jsx
function ghSync(t) {
  if (t.validation === "failing") return { label: "behind main", kind: "risk" };
  if (t.pr && t.pr.state === "merged") return { label: "merged", kind: "done" };
  return { label: "synced", kind: "ready" };
}
```

⚠️ Note what this actually does: the mock **derives "behind main" from
`validation === "failing"`** — a prototype conflation (the only failing-validation
task, VIB-160, also happens to be "2 commits behind main" in its packet copy).
See Porting notes §7.3.

---

## 3. Data consumed (exact shapes + real-app source)

### 3.1 `tasks` prop (mock: merged `window.VIBERR.tasks` + session overrides)

Fields actually read by this view, per task:

| Field | Type | Used for |
|---|---|---|
| `key` | `"VIB-142"` style string | row key, `#{key}` open target, sub-line text |
| `title` | string | branch-table Task cell |
| `branch` | `string \| null` (e.g. `"vib-142-attach-workspace"`) | filter for branch table; branch cell; PR sub-line |
| `pr` | `{ number: number, state: "review" \| "merged", title: string } \| null` | filter for PR list; PR pills; sync derivation |
| `validation` | `"healthy" \| "changed" \| "failing" \| "none"` | sync derivation only (`failing` → "behind main") |

Derived lists (order = task order in the store; the mock does NOT sort):

```jsx
const branches = tasks.filter((t) => t.branch);
const prs = tasks.filter((t) => t.pr);
```

Seed data reality check (from `data.js`): 9 tasks; 6 have branches
(VIB-142, 151, 153, 160, 145, 139, 141 — 7 actually; VIB-148/166 + one more are
branchless), 4 have PRs: `#318 review` (VIB-142), `#311 review` (VIB-145),
`#298 merged` (VIB-139), `#287 merged` (VIB-141). VIB-160 is the
`validation: "failing"` task → renders the single "behind main" risk pill.

**Real source:** projection query. `task_projections` must expose per task:
`branch_name`, `pr_number`, `pr_state`, `pr_title`, `validation_status` (or a
dedicated `sync_state` — see §7.3). Loader shape suggestion:

```ts
type GithubViewData = {
  repo: { fullName: string; connected: boolean };
  credential: { label: string; masked: string;
                scopes: { id: string; ok: boolean; flaggedTaskKey?: string }[] };
  prs:      { taskKey: string; number: number; state: "review"|"merged"; title: string; branch: string }[];
  branches: { taskKey: string; title: string; branch: string;
              pr: { number: number; merged: boolean } | null;
              sync: "synced" | "behind_main" | "merged" }[];
};
```

Live behavior to preserve: when the VIB-142 completion is accepted in task detail,
the mock's override sets `pr.state = "merged"` and the PR pill + sync pill on this
page update on next render. Real app: revalidate on `task.updated` SSE.

### 3.2 `window.VIBERR.policy.repo` (mock `data.js` `POLICY.repo`, verbatim)

```js
repo: {
  name: "akin-ozer/viberr", override: true,
  credential: "viberr-bot · fine-grained PAT", masked: "github_pat_••••42af",
  scopes: [
    { id: "repo", ok: true },
    { id: "workflow", ok: true },
    { id: "read:org", ok: true },
    { id: "pull_request:write", ok: false, task: "VIB-142" },
  ],
},
```

Used fields: `name`, `credential`, `masked`, `scopes[]` (`id`, `ok`, and `task` on
the missing one). `override` is used only by Settings, not here. The view computes:

```jsx
const missing = P.repo.scopes.find((s) => !s.ok);   // first not-ok scope
```

and per-chip: `const ok = s.ok || scopeGranted;` — i.e. `scopeGranted` force-greens
every chip without mutating the data (prototype hack; see §7.2).

**Real source:**
- Repo name + connection: project record (SQLite) → the org-level GitHub connection
  chosen at project creation (`org-settings.jsx` connection flow).
- Credential label + masked suffix: PAT metadata row (AES-256-GCM encrypted token in
  SQLite per conventions; loader returns ONLY label + last-4 mask, never the secret).
- Scope list + ok flags: the stored scope-check result from
  `app/server/github/` preflight validation (org-settings validates
  "repo · workflow · pull_request:write" minimum scopes on connect). The
  `task` linkage on a failing scope comes from the typed `policy` violation event
  recorded on that task's timeline (VIB-142's timeline has the matching event, and
  `POLICY.events[0]` mirrors it for the audit log).

### 3.3 `scopeGranted` (mock: App state; real: derived)

Boolean, initially `false`. Flipped only by Settings' Grant scope (§5.3). Real app:
`credential.scopes.every(s => s.ok)` from the loader — no separate flag.

### 3.4 Session / env

Nothing else. No role gating on this page in the mock (Reconcile and the banner
render for everyone; the actual Grant scope button lives in Settings, which the mock
also doesn't gate — flagged in `policy.md`/settings spec as an RBAC TODO: policy/PAT
changes are admin actions per conventions).

---

## 4. UI states & interactions

### 4.1 Page header

```jsx
<div className="board-wrap" data-screen-label="GitHub">
  <div className="board-head">
    <div>
      <h1>GitHub</h1>
      <div className="sub">Execution surface for Viberr Core — branches, pull requests, and credential health</div>
    </div>
    <div className="board-tools">
      <button className="btn ghost sm" onClick={rescan} title="Reconcile task state with GitHub"><Icon name="refresh" />Reconcile</button>
      <button className="btn ghost sm" onClick={() => push("External links are stubbed in this prototype")}><Icon name="ext" />Open on GitHub</button>
    </div>
  </div>
```

Real app: sub-line project name comes from loader (`Execution surface for
{project.name} — …`).

**Reconcile button.** `title="Reconcile task state with GitHub"`. Mock behavior:

```jsx
const rescan = () => {
  push("Reconciling branches and PRs with GitHub…");
  setTimeout(() => push("Reconciled — every branch and PR maps to its task key"), 1000);
};
```

Two toasts, 1s apart, no data change. Real: a route action (POST, intent
`reconcile`) that triggers the server-side GitHub reconciliation (fetch branch/PR
state for every task with a branch, update projections, publish
`projection.rebuilt` SSE). First toast on submit, second on action completion
(or driven by the SSE). Keep both toast strings verbatim. Must be idempotent-safe
per conventions. This is conceptually the GitHub-flavored sibling of VIB-166's
"manual re-scan" of the file store — decide whether it's the same endpoint or a
GitHub-only one (Open questions).

**Open on GitHub button.** Mock: toast `"External links are stubbed in this
prototype"`. Real: plain external anchor styled `btn ghost sm` →
`https://github.com/{repo.fullName}`, `target="_blank" rel="noopener noreferrer"`.
Drop the toast.

### 4.2 Repository panel

Panel head: `<Icon name="github" /><h2>Repository</h2>`.

Four `.kv-row`s (label → value), copy verbatim:

| `.k` label | `.v` value |
|---|---|
| `Default repository` | github icon + `<span className="mono">akin-ozer/viberr</span>` |
| `Connection` | `<Pill kind="ready" dot sm>connected</Pill>` |
| `Task attachment` | `project default · task-level override allowed` — rendered de-emphasized via inline style `{{ fontWeight: 400, fontFamily: "var(--font-body)", fontSize: ".8rem", color: "var(--faint)" }}` on the `.v` span |
| `Repos per task` | `1 · V1 limit` |

Note: "Connection" is hard-coded `connected` in the mock. Real: derive from the
connection record; a disconnected/invalid-token state needs a non-`ready` pill
(not designed in the mock — Open questions).
"Task attachment" copy should reflect the actual override setting
(Settings has the toggle; when off its own copy is "all tasks use the default").

**Credential card** (`.cred-card`), structure verbatim:

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
      return <span className={"scope-chip" + (ok ? "" : " miss")} key={s.id}><Icon name={ok ? "check" : "alert"} />{s.id}</span>;
    })}
  </div>
  {/* footer: cred-warn OR cred-ok, below */}
</div>
```

Scope chip states: ok → default chip + `check` icon (teal); missing →
`scope-chip miss` + `alert` icon (coral tint via CSS).

**Scope-violation banner** (`.cred-warn`) — shown iff `missing && !scopeGranted`,
verbatim:

```jsx
<div className="cred-warn">
  <Icon name="alert" />
  <span>Missing <code className="mono">{missing.id}</code> — PR status can't auto-sync after merge. Flagged on</span>
  <button type="button" className="keybtn" onClick={() => onOpen(missing.task)}>{missing.task}</button>
  <button className="btn sm" style={{ marginLeft: "auto" }} onClick={() => onNav("settings")}><Icon name="sliders" />Fix in Settings</button>
</div>
```

Reads as one sentence: *"Missing `pull_request:write` — PR status can't auto-sync
after merge. Flagged on [VIB-142] [Fix in Settings]"* where `[VIB-142]` is a
`.keybtn` (kbd-style inline button) opening the task and `[Fix in Settings]` is a
solid small button (icon `sliders`) navigating to Settings.

**All-good state** (`.cred-ok`) — shown otherwise, copy verbatim:

```jsx
<div className="cred-ok"><Icon name="check" />All required scopes granted. Secrets stay isolated from task records and timelines.</div>
```

### 4.3 Pull requests panel

Panel head with a right-aligned count:

```jsx
<div className="panel-head"><Icon name="pr" /><h2>Pull requests</h2>
  <span className="right sub" style={{ fontSize: ".76rem", color: "var(--faint)" }}>{prs.length} linked to tasks</span>
</div>
```

Rows — every task with a `pr`, whole row is a `<button>` (verbatim):

```jsx
<div className="rq-list">
  {prs.map((t) => (
    <button className="rq-row" key={t.key} onClick={() => onOpen(t.key)}>
      <span className="rq-key">#{t.pr.number}</span>
      <span className="rq-main">
        <div className="ttl">{t.pr.title}</div>
        <div className="sub"><span className="mono">{t.branch}</span> → main · {t.key}</div>
      </span>
      <span className="rq-meta">
        <Pill kind={t.pr.state === "merged" ? "done" : "info"} sm dot>{t.pr.state === "merged" ? "merged" : "in review"}</Pill>
      </span>
    </button>
  ))}
</div>
```

Pill vocabulary: `merged` → `done` pill; anything else → `info` pill labeled
`in review`. Sub-line format: `` `{branch}` → main · {key} `` (base branch is
hard-coded `main`).

Footer note (`.pol-note`, with inline `style={{ marginBottom: 0, marginTop: ".9rem" }}`),
copy verbatim:

> lock icon · *"Merging stays reserved for humans — accepting a completion in the
> review queue merges its PR."*

### 4.4 Execution branches panel

Panel head: `<Icon name="branch" /><h2>Execution branches</h2>` + right count
`{branches.length} task-key branches` (same inline style as §4.3).

Table: `.gh-table` wraps a `.live-table` (shared roster-table component family from
the Agents view). Header row + one button-row per branch task (verbatim):

```jsx
<div className="gh-table">
  <div className="live-table">
    <div className="live-head"><span>Task</span><span>Execution branch</span><span>Pull request</span><span>Sync</span></div>
    {branches.map((t) => {
      const s = ghSync(t);
      return (
        <button className="live-row" key={t.key} onClick={() => onOpen(t.key)}>
          <span className="live-task"><span className="key mono">{t.key}</span> <span className="ttl">{t.title}</span></span>
          <span className="trace ok" style={{ fontSize: ".74rem" }}><Icon name="branch" />{t.branch}</span>
          <span>{t.pr
            ? <Pill kind={t.pr.state === "merged" ? "done" : "info"} sm>#{t.pr.number}</Pill>
            : <span style={{ color: "var(--placeholder)", fontSize: ".8rem" }}>—</span>}</span>
          <span><Pill kind={s.kind} sm dot>{s.label}</Pill></span>
        </button>
      );
    })}
  </div>
</div>
```

Column semantics:
1. **Task** — `key` (mono, faint) + `title` (muted), single line, ellipsized by CSS.
2. **Execution branch** — `.trace.ok` (teal mono trace chip) with branch icon;
   inline `fontSize: ".74rem"`.
3. **Pull request** — `#N` pill (`done` if merged, `info` otherwise, NO dot here,
   unlike the PR panel) or an em-dash `—` placeholder
   (`color: var(--placeholder)`, `.8rem`) when the task has a branch but no PR yet.
4. **Sync** — `ghSync` pill, with dot: `synced`/`ready`, `behind main`/`risk`,
   `merged`/`done`.

Grid columns come from the CSS contract:
`.gh-table .live-head, .gh-table .live-row { grid-template-columns: 1.8fr 1.4fr .9fr 1fr; }`
(viberr.css line ~1581) overriding the base 5-column `.live-table` grid.

Footer note (`.pol-note`, same inline margins), copy verbatim:

> branch icon · *"Branch names and commit messages carry the task key — task →
> branch → commit → PR stays traceable without asking."*

### 4.5 Keyboard / a11y inventory

- Every PR row and branch row is a real `<button>` → tab-focusable, Enter/Space
  activates. Keep as buttons (or convert to anchors/`<Link>` for real navigation —
  either way they must remain single focusable elements per row).
- `Icon` renders `aria-hidden="true"` SVGs; all meaning is in text.
- Toasts render in the shell `ToastHost` with `role="status" aria-live="polite"`.
- No dialogs, menus, or roving focus on this page. Reconcile has a `title` tooltip.
- `data-screen-label="GitHub"` on `.board-wrap` — prototype tooling hook
  (screenshot labeling); harmless to keep, safe to drop (match the decision in
  `activity.md`/`board.md`).

### 4.6 Toast inventory (exact strings)

| Trigger | Toast |
|---|---|
| Reconcile (immediately) | `Reconciling branches and PRs with GitHub…` |
| Reconcile (+1s / completion) | `Reconciled — every branch and PR maps to its task key` |
| Open on GitHub (mock only) | `External links are stubbed in this prototype` — REPLACE with real link |

---

## 5. Events / mutations produced (incl. the resolution path)

### 5.1 On this page

**Reconcile** → real action. Server work: enumerate tasks with branches for the
project, query GitHub for branch/PR state, reconcile `task_projections` (and, where
GitHub state changes a task's recorded PR state, write through the file store —
files stay canonical), publish SSE (`projection.rebuilt` and/or `task.updated`),
append an audit event (governed-ish action; cheap and useful). Response drives the
completion toast. No timeline events for a no-op reconcile.

Nothing else on the page mutates. Row clicks/`Fix in Settings` are navigation.

### 5.2 Upstream: how the violation came to exist (seed/reference)

The violation is a **typed `policy` timeline event** on VIB-142 (data.js, verbatim):

```js
{ type: "policy", actor: { name: "Policy engine", kind: "system" }, t: "9:38",
  text: "**Policy violation:** active PAT is missing `pull_request:write`. Auto-sync after merge will fail." }
```

mirrored in the audit log (`POLICY.events[0]`):

```js
{ kind: "violation", t: "today 9:38", text: "Project credential is missing `pull_request:write` — flagged by the policy engine on", task: "VIB-142", open: true }
```

and as a notification (`kind: "policy"`, from "Policy engine", task VIB-142):
*"**Policy violation:** the active PAT is missing `pull_request:write` — PR
auto-sync will fail after merge."*

Real app: the scope preflight (VIB-148's whole premise) detects the missing scope →
writes the typed `policy` event into the flagged task's `task.md`, an audit event,
and a notification; the scope-check result row is what this view's loader reads.

### 5.3 The resolution path (lives in Settings, must clear this page)

Settings → RepoSettings renders the **same** `.cred-card`/`.cred-warn`, except the
right-hand button is Grant scope instead of Fix in Settings:

```jsx
<button className="btn sm" style={{ marginLeft: "auto" }} onClick={onGrantScope}><Icon name="check" />Grant scope</button>
```

`onGrantScope` = `grantScope` in `main.jsx` (verbatim):

```jsx
const grantScope = () => {
  setScopeGranted(true);
  addEvent("VIB-142", { type: "policy", actor: { name: "Policy engine", kind: "system" }, t: "now", text: "**Policy update:** `pull_request:write` granted on the project credential. The earlier violation is resolved — PR auto-sync will work after merge." });
  push("Scope granted · VIB-142 policy flag resolved");
};
```

So the real "grant scope" action must:

1. Update the credential's scope-check record (re-validate the PAT against required
   scopes; in reality the user first widens the PAT on GitHub — see Open questions).
2. Write a typed `policy` timeline event to the flagged task's `task.md`, actor
   "Policy engine" (`kind: "system"`), text exactly:
   *"**Policy update:** `pull_request:write` granted on the project credential. The
   earlier violation is resolved — PR auto-sync will work after merge."*
3. Append an audit event (PAT/policy change is a governed action per conventions).
4. Publish SSE so every surface revalidates.
5. Toast: `Scope granted · VIB-142 policy flag resolved` (real: interpolate the
   scope id + task key).

Observable effects to verify after resolution, across surfaces:
- GithubView: `pull_request:write` chip turns green, `.cred-warn` → `.cred-ok`.
- Settings: same card flips.
- Rail: coral violations badge on the Settings nav item disappears
  (`violations={scopeGranted ? 0 : 1}` — real: count of open violations from a
  projection/audit query, not a hard-coded 1).
- Activity → Audit logs: the `violation` entry renders resolved
  (`const resolved = e.kind === "violation" && scopeGranted;` in `activity.jsx`).
- VIB-142 task timeline shows the new policy-update event.

Also note: the mock's VIB-142 packet option "Request one edit" ("Ask the developer
to widen PAT scope before acceptance") and "Block on policy" (holds the task,
navigates to Settings, toast "Task held on policy · opening repository settings")
both route humans toward this same Settings card — the banner here is the third
road in. Those flows are specced in `task-detail.md`/`review-queue.md`; just keep
the Settings anchor consistent.

---

## 6. CSS classes used (contract — do not rename)

- Layout: `board-wrap` (+ `data-screen-label`), `board-head` (`h1`, `.sub`),
  `board-tools`, `policy-wrap`, `policy-cols`, `panel`, `panel-head` (`h2`,
  `.right.sub` count), `pol-note`.
- Buttons/pills: `btn`, `btn ghost sm`, `btn sm`, `keybtn`, `pill` via `Pill`
  (kinds used: `ready`, `info`, `done`, `risk`; modifiers `sm`, `dot`/`pdot`),
  `icon`/`ico` via `Icon`.
- Repository panel: `kv`, `kv-row`, `k`, `v`, `mono`, `cred-card`, `cred-top`,
  `cred-name`, `scope-chips`, `scope-chip`, `scope-chip miss`, `cred-warn`,
  `cred-ok`.
- PR list: `rq-list`, `rq-row`, `rq-key`, `rq-main` (`.ttl`, `.sub`), `rq-meta`
  (shared with the Review queue — already ported there; reuse, don't fork).
- Branch table: `gh-table` (grid override `1.8fr 1.4fr .9fr 1fr`), `live-table`,
  `live-head`, `live-row`, `live-task` (`.key.mono`, `.ttl`), `trace ok`
  (shared with Agents' live roster — reuse).
- Inline styles that are part of the design (keep verbatim or promote to appended
  `app.css` classes, one decision app-wide): panel-head count spans
  (`fontSize:.76rem; color:var(--faint)`), Task-attachment value de-emphasis,
  masked-PAT `marginLeft:auto; color:var(--faint)`, branch trace `fontSize:.74rem`,
  no-PR dash `color:var(--placeholder); fontSize:.8rem`, banner button
  `marginLeft:auto`, pol-note `marginBottom:0; marginTop:.9rem`.

---

## 7. Porting notes (prototype-only bits → real)

1. **`window.VIBERR.policy` read inside the component** (`const P =
   window.VIBERR.policy;`) → loader data (`GithubViewData`, §3.1). No globals.
2. **`scopeGranted` chip hack.** The mock never mutates `P.repo.scopes`; chips green
   via `s.ok || scopeGranted`. Real app: the loader returns the current scope-check
   result and the UI renders `s.ok` directly — delete the `|| scopeGranted` branch
   and the prop.
3. **`ghSync` conflates validation with branch sync.** Keep the pill vocabulary
   (`synced`/`ready`, `behind main`/`risk`, `merged`/`done`) but compute it from a
   real per-branch comparison (GitHub compare API: behind/ahead counts, captured
   during reconcile into the projection), not from `validation === "failing"`.
   Precedence when both apply: mock checks failing→behind first, then merged, then
   synced; for real data prefer `merged` (branch's PR merged) > `behind main`
   (behindBy > 0) > `synced`. Document any deviation in the phase report.
4. **Fake reconcile `setTimeout`** → real action + SSE-driven completion (§5.1).
5. **"Open on GitHub" stub toast** → real external link (§4.1).
6. **Hard-coded strings to parameterize:** project name in the sub-line; `main` as
   base branch (fine to keep constant for V1 if that's the product rule — state it);
   toast/task-key interpolation in the grant-scope path; `1 · V1 limit`,
   `connected`, and the Task-attachment copy should come from project config.
7. **Rail violation count** `scopeGranted ? 0 : 1` → real count of open policy
   violations for the project (audit/projection query). It badges the **Settings**
   nav item; keep that placement.
8. **PR state mapping.** Mock only knows `"review"` and `"merged"`. Real GitHub PRs
   are open/draft/closed/merged. Minimum viable mapping: merged → `merged`/`done`;
   open or draft → `in review`/`info`; closed-unmerged has NO design — pick a
   rendering (suggest `risk` pill `closed`) and flag it in the phase report.
9. **Empty states — not designed in the mock** (seed data always populates all
   panels). Needed: (a) zero PRs — keep the panel, add an empty line in the
   `.rq-list` area (suggest reusing `.pol-note`-style muted copy, e.g. "No pull
   requests yet — the developer specialist opens one at the review boundary");
   (b) zero branches — same treatment in the table area; (c) repo not
   connected / token invalid — Connection pill must not claim `connected`
   (suggest `blocked` pill `disconnected` + banner pointing at org settings).
   All three are additions; keep them visually quiet and note them as deviations.
10. **Errors.** Reconcile can fail (GitHub down, token revoked). Conventions: typed
    `AppError`, no secret leakage; render as toast + keep last-known projection data
    (this page is read-mostly, so stale-but-labeled beats blank).
11. **Ordering.** Mock preserves store order. Real: pick a deterministic order
    (suggest PRs by number desc, branches by task key) — deviation, note it.
12. **Reuse, don't fork:** `rq-row` family is the Review queue's row; `live-table`
    family is Agents' roster table; the `.cred-card` block appears twice (here and
    Settings) — build ONE `CredentialCard` component with a `footerAction` slot
    (`Fix in Settings` here, `Grant scope` in Settings) so the two can't drift.

---

## 8. Open questions

1. **Grant-scope realism.** In the mock, one click "grants" `pull_request:write`.
   Really the user must edit the PAT on GitHub (or paste a new token — org-settings
   already has a "Validate & replace" flow). Is "Grant scope" actually
   "Re-check scopes now" (re-validate current PAT), or does it deep-link into the
   org-settings token-replace modal? Recommend: re-check + link to replace-token on
   failure.
2. **Reconcile scope.** Same endpoint as VIB-166's file-store re-scan, or a
   GitHub-only reconcile? The toasts talk only about branches/PRs, so probably a
   dedicated `github.reconcile` action — confirm against Phase 7 plan.
3. **Where does `Fix in Settings` land?** Route only, or with an anchor/scroll to
   the Repository & credentials panel (`/projects/:slug/settings#repository`)?
4. **Closed-unmerged PRs and deleted branches** — rendering undefined (see §7.8/7.9).
5. **Sync-state freshness.** Is sync computed only at reconcile time (manual +
   scheduled?) or also refreshed by webhooks/polling in Phase 7? The pill's honesty
   depends on it; consider a "last reconciled at" line if it's manual-only.
6. **Should PR rows link to GitHub too?** Mock only opens the task. A secondary
   external-link affordance per row is a natural addition but is NOT in the design —
   don't add without a decision.
7. **Multiple missing scopes.** `missing = scopes.find(!ok)` shows only the first;
   banner copy is singular. Fine for V1? If multiple can fail, list them or show the
   first + count.
