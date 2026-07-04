# Porting spec — `runs.jsx`

Source: `design/html-app/app/runs.jsx` (263 lines)
Shared helpers: `design/html-app/app/ui.jsx` (`Icon`, `Pill`, `AgentGlyph`)
Data source: `design/html-app/app/data.js` (`window.VIBERR.runtime` — the `RUNTIME` map)
CSS: `design/html-app/app/viberr.css` lines ~1808–1925 ("AGENT RUNTIME — live run strip + streamed SDK logs" section)
Build-plan home: **Phase 8 — Runtimes** (`app/server/runtimes/`, SSE `run.log-appended`, NDJSON persisted under data root `runtimes/`). Panels render inside the task-detail surface (Phase 5 shell, Phase 8 wiring).

This spec is exhaustive; the porting engineer should not need to open the mock file.

---

## 1. Purpose & entry points

`runs.jsx` implements the **agent-runtime surface of the task detail page**: two sibling panels plus a shared dropdown.

1. **`LiveRunPanel`** ("Live run" strip) — a highlighted banner shown **only while at least one agent run for the current task is in state `running`**. Shows a pulsing live indicator, current phase + step, elapsed/turns/tokens/model stats (with 1-second client tickers), a "View logs" jump button, an "Interrupt" button (stubbed in the mock), and — when 2+ runs are executing concurrently — a dropdown to switch between the running agents.
2. **`AgentLogsPanel`** ("Agent logs") — a dark console showing the raw SDK event stream of one agent thread at a time, with a thread dropdown (all threads, any state), a running/idle/finished/continuity-error state pill, an SDK/session metadata line, a **raw JSON toggle** (reconstructs the real wire envelope per line), an **auto-follow toggle** (with scroll-position auto-detection), a blinking cursor line while running, a state-dependent footer sentence, and an event count.
3. **`AgentPicker`** — the shared dropdown component used by both panels.

### Mount points (from `task.jsx` `TaskDetail`, lines 443–467)

```jsx
const runtime = (window.VIBERR.runtime || {})[task.key] || [];
const [logSel, setLogSel] = useStateT(null);
...
<LiveRunPanel runtime={runtime} onViewLogs={(id) => setLogSel(id)} push={push} />
{task.packet && <DecisionPacket ... />}
<ExecutionProfile ... />
<AgentLogsPanel runtime={runtime} sel={logSel} onSel={setLogSel} />
<Timeline ... />
```

Layout order inside `.detail-main`: task hero → **Live run strip** → decision packet → execution profile → **Agent logs** → timeline. Both panels receive the *same* per-task runtime array; the "View logs" button in the strip simply sets the logs panel's selected-thread id (state lives in the task detail parent). There is **no scroll-into-view** on "View logs" in the mock — consider adding one in the port (see Open questions).

Exports (prototype module system): `Object.assign(window, { LiveRunPanel, AgentLogsPanel })`. `AgentPicker`, `RunGlyph`, `rawLine`, and the small helpers are file-local.

### File-header comments worth preserving as doc comments

```
/* Viberr — Agent runtime: live run strip + streamed SDK logs (Claude Code / Codex). */

/* Claude Code: NDJSON envelopes from `--output-format stream-json` (system·init,
   assistant text/tool_use, user tool_result, final result with usage + cost).
   Codex SDK: ThreadEvents from `thread.runStreamed()` (thread.started, turn.started,
   item.started/completed with typed items, turn.completed with usage). */
```

---

## 2. Component tree

```
LiveRunPanel({ runtime, onViewLogs, push })     — the "Live run" strip; null when no run is running
├─ Pill (ui.jsx)                                — "N agent(s) running" count pill, kind="agent" sm
├─ AgentPicker (only when 2+ running)           — switch between concurrent running agents
│  └─ RunGlyph                                  — operator shield / backend glyph per item
├─ RunGlyph + who-chip (when exactly 1 running) — static identity chip instead of dropdown
└─ (body) run-phase / run-stats / run-actions   — spinner+phase+step, 4 stat cells, 2 buttons

AgentLogsPanel({ runtime, sel, onSel })         — the "Agent logs" panel; empty-state when runtime []
├─ AgentPicker (always, all threads)            — choose which agent thread's stream to view
├─ Pill                                         — thread state pill (running/idle/finished/continuity error)
├─ fchip × 2                                    — "{ } raw" toggle, "follow" toggle
├─ .console                                     — dark scrollable log box (role="log")
│  └─ .log-line × N (+ trailing cursor line while running)
└─ .logs-foot                                   — state sentence + "N events" count

AgentPicker({ items, value, onChange, label })  — shared listbox-style dropdown
└─ RunGlyph                                     — per current selection and per menu item

RunGlyph({ run })                               — run.op ? shield glyph (class "agent-glyph op") : AgentGlyph(run.backend)

Helpers (file-local):
  RUN_STATE       — state → { kind, label } map for pills/states
  runLabel(run)   — "who.name" or "who.name · who.role"        e.g. "Codex · Developer", "Operator"
  roleShort(run)  — "operator" | "primary" | "consultant"      (op flag / role === "Primary specialist")
  fmtClock(s)     — seconds → "mm:ss" or "h:mm:ss" (zero-padded mins/secs; hours unpadded)
  fmtTok(n)       — ≥100000 → "128k" (rounded); ≥1000 → "38.4k" (1 decimal); else raw digits
  useTicker(active) — returns int that +1s every 1000ms while active (interval cleared when inactive)
  fakeId(run, i, prefix, len)  — deterministic FNV-1a-style hash of (run.sid + ":" + i) → base-58-ish id string
  lastToolIdx(lines, i)        — index of nearest preceding line with ev === "tool", or −1
  rawLine(run, l, i, lines)    — reconstructs the raw wire-envelope JSON string for a line (see §5 tables)
```

### The `RUN_STATE` map (canonical state vocabulary)

```js
const RUN_STATE = {
  running: { kind: "agent",   label: "running" },
  idle:    { kind: "neutral", label: "idle" },
  done:    { kind: "done",    label: "finished" },
  error:   { kind: "blocked", label: "continuity error" },
};
```

`kind` values are `Pill` CSS modifiers (`.pill.agent`, `.pill.neutral`, `.pill.done`, `.pill.blocked`). Unknown states fall back to `RUN_STATE.idle`. Note the build plan's run lifecycle is `queued/running/finished/error/interrupted` — the mock only renders these four; map `queued`→idle-like and `interrupted`→a new label at port time (Open question 3).

---

## 3. Data consumed

### 3.1 The runtime array (per task)

Mock: `window.VIBERR.runtime[taskKey]` → array of **run/thread objects**, one per agent thread on the task (operator, primary specialist, consultants). Real app: a **projection query** over the runtimes registry (SQLite `run`/`thread` rows projected from the file-native store + adapter state), scoped to the task key, loaded in the task-detail route loader and updated via SSE (`run.log-appended`, plus a run-state-changed event — Open question 2).

Full field inventory (every field the components read):

| Field | Type | Present on | Read by | Notes |
|---|---|---|---|---|
| `id` | string | all | both panels, picker | Thread id unique **within the task** — mock uses `"op"`, `"primary"`, `"c0"`. Selection state (`selId`, `logSel`) stores this. |
| `op` | `true` (optional) | operator thread only | `RunGlyph`, `roleShort`, claude `init` rawLine | Operator flag → shield glyph, "operator" short-role, `mcp_servers: [viberr-task-store]` in raw init. |
| `role` | string | all | picker item subline, `roleShort` | Exactly `"Operator"` \| `"Primary specialist"` \| `"Consultant"`. `roleShort`: op→`operator`, `"Primary specialist"`→`primary`, anything else→`consultant`. |
| `who` | identity object | all | `runLabel`, picker | `{ kind:"agent", backend?, name, role? }`. Specialists: `{kind:"agent", backend:"codex", name:"Codex", role:"Developer"}` etc. Operator: `{ kind:"agent", name:"Operator" }` — **no `backend`, no `role`** (so `runLabel` = just "Operator"). |
| `backend` | `"claude"` \| `"codex"` | all | `RunGlyph` (non-op), `rawLine` branch, logs-meta line | Run-level backend, independent of `who.backend`. Operator runs are `backend:"claude"`. |
| `sdk` | string | all | picker item subline | `"Claude Agent SDK"` \| `"Codex SDK"`. Display string only. |
| `model` | string | all | Live strip "Runtime" cell, claude rawLine | e.g. `"claude-sonnet-4-5"`, `"gpt-5.4-codex"`. |
| `sid` | string | all | logs-meta (sliced + `title`), rawLine (`session_id`/`thread_id`), `fakeId` seed | Provider session/thread id. Claude sids are UUIDv4-shaped; Codex sids are UUIDv7-shaped (`0199…`). |
| `state` | `"running"`\|`"idle"`\|`"done"`\|`"error"` | all | everything | Drives pills, dots, cursor line, footer, streaming simulation, live-strip inclusion. |
| `phase` | string | running + idle | Live strip `.ph` | Human phrase, e.g. `"Running validation sweep"`, `"Supervising — next boundary: Review"`, `"Blocked — waiting on human decision"`. Only the live strip renders it (running only), but idle runs carry it too. |
| `step` | string | running only | Live strip `.step` | Current tool invocation, mono. Format observed: `"Bash · npm test -- --filter=long-fixture"` (claude) / `"exec · rg 'compression-threshold' .viberr/policy/"` (codex). |
| `started` | string `"10:18"` | running | **not rendered** | Present in data; no component reads it. Keep in the projection anyway (useful for tooltips later). |
| `elapsed` | number (seconds) | running | Live strip Elapsed cell | Base value; UI adds the client ticker: `fmtClock((run.elapsed || 0) + tick)`. |
| `finished` | string | done/error | logs-foot ("run finished at …") | e.g. `"9:41"`, `"Mar 30 · 17:26"`. Fallback `"—"` when absent. |
| `turns` | number | all | Live strip Turns cell | Static in mock. |
| `tokens` | number | all | Live strip Tokens cell | Base; UI fakes growth: `fmtTok(run.tokens + tick * 42)` — **replace with real usage updates** (see §7). |
| `lines` | LogLine[] | all | logs console | The already-persisted stream. |
| `live` | LogLine[] (optional) | running threads | logs console (simulated streaming) | Mock-only split: lines that "arrive" on a timer after mount. In the real app there is one persisted NDJSON stream + SSE tail; the `lines`/`live` split disappears. |

### 3.2 LogLine shape (the mock's internal line model)

Built by the `cc.*` / `cx.*` builders in `data.js` (lines 299–316). Every line:

| Field | Type | Meaning |
|---|---|---|
| `t` | string `"HH:MM:SS"` | Wall-clock timestamp, rendered verbatim in the `.lt` column. |
| `ev` | string | Render class + raw-envelope selector. Values: `init`, `text`, `tool`, `out`, `err`, `result` (both SDKs) plus `think`, `meta`, `diff` (codex only). |
| `tag` | string | Rendered verbatim in the `.ltag` column. Claude: `system·init`, `assistant`, `tool_use`, `tool_result`, `result`. Codex: `thread.started`, `turn.started`, `reasoning`, `command_execution`, `aggregated_output`, `agent_message`, `file_change`, `turn.completed`. |
| `text` | string | Main content, rendered in `.lx`. |
| `name` | string (tool lines) | Claude tool name (`Bash`, `Read`, `Grep`, `Edit`…); codex exec lines use `name:"exec"`. Rendered bold before `text`. |
| `input` | object \| null (claude tool) | Real tool input for the raw view, e.g. `{ file_path: "..." }`, `{ pattern, path }`. When null, raw view synthesizes from `text` (Bash → `{command}`, else `{file_path}`). |
| `isError` | true (claude `err`) | Set by builder; rawLine actually keys off `ev === "err"`, not this flag. |
| `exit` | number (codex out/err) | Non-zero exit turns the line into `ev:"err"` and raw `status:"failed"`. |
| `stats` | object \| null (claude `result`) | `{ subtype?, dur, api, turns, cost, in, cached, out }` → raw result envelope fields. `subtype` e.g. `"error_during_execution"` on the continuity-error run. |
| `usage` | object \| null (codex `result`) | `{ input_tokens, cached_input_tokens, output_tokens }` → raw `turn.completed.usage`. |
| `changes` | array \| null (codex `diff`) | `[{ path, kind: "add"|"update" }, …]` → raw `file_change.changes`. |

Builder → (ev, tag) mapping, verbatim from `data.js`:

```js
const cc = { // Claude Agent SDK / stream-json
  init: (t, s) => ({ t, ev: "init", tag: "system·init", text: s }),
  text: (t, s) => ({ t, ev: "text", tag: "assistant", text: s }),
  tool: (t, n, s, input) => ({ t, ev: "tool", tag: "tool_use", name: n, text: s, input: input || null }),
  out:  (t, s) => ({ t, ev: "out", tag: "tool_result", text: s }),
  err:  (t, s) => ({ t, ev: "err", tag: "tool_result", text: s, isError: true }),
  res:  (t, s, stats) => ({ t, ev: "result", tag: "result", text: s, stats: stats || null }),
};
const cx = { // Codex SDK runStreamed() ThreadEvents
  start: (t, s) => ({ t, ev: "init", tag: "thread.started", text: s }),
  turn:  (t, s) => ({ t, ev: "meta", tag: "turn.started", text: s }),
  think: (t, s) => ({ t, ev: "think", tag: "reasoning", text: s }),
  exec:  (t, s) => ({ t, ev: "tool", tag: "command_execution", name: "exec", text: s }),
  out:   (t, s, exit) => ({ t, ev: exit ? "err" : "out", tag: "aggregated_output", text: s, exit: exit || 0 }),
  msg:   (t, s) => ({ t, ev: "text", tag: "agent_message", text: s }),
  diff:  (t, s, changes) => ({ t, ev: "diff", tag: "file_change", text: s, changes: changes || null }),
  done:  (t, s, usage) => ({ t, ev: "result", tag: "turn.completed", text: s, usage: usage || null }),
};
```

**Porting direction:** in the real app this flows the *opposite* way — the adapters persist real NDJSON/JSONL envelopes under the data root (`runtimes/`), and a server-side normalizer derives this display model (`t`, `ev`, `tag`, `text`, `name`) *from* the envelopes. The mock's `rawLine` (§5.4) is the inverse function and is the authoritative catalog of which envelope maps to which display line. Keep the normalized shape as the loader/SSE payload so the console renders identically; keep the raw envelope alongside (or refetchable) for the raw toggle.

### 3.3 Where each datum must come from in the real app

| Mock source | Real source |
|---|---|
| `window.VIBERR.runtime[task.key]` | Task-detail loader: projection query over run registry (SQLite) filtered by task key, ordered operator-last or as stored (mock order varies by task: VIB-142 op-first; VIB-151 primary/consultant/op; preserve stored order — it defines dropdown order and the default logs selection). |
| `lines` + `live` | Persisted NDJSON run log files under data root `runtimes/` (per BUILD-PLAN Phase 8), tailed live via SSE `run.log-appended` `{ type, entityId, occurredAt, data }`. |
| `elapsed` ticker | Client interval seeded from server `startedAt` (UTC ISO per CONVENTIONS) — compute elapsed from timestamps, do not trust a shipped seconds count. |
| `tokens + tick*42` fake growth | Real cumulative usage from `turn.completed` / `result` usage envelopes; update on SSE, no fake ticker. |
| `state` | Run lifecycle from the runtimes registry (`queued/running/finished/error/interrupted`). |
| `sid` | Provider session id captured by the adapter (claude `session_id` from `system:init`; codex `thread_id` from `thread.started`). |
| Interrupt button | Real governed action → route action → adapter interrupt (see §5). |
| Access control | Session user's role. Mock policy data (`POLICY.rbac`) says **"Open agent runtime sessions" is admin/maintainer only** and the audit example ("Murat opened the Developer runtime session for debugging — recorded per audit policy") implies viewing is audit-logged. See Open question 4 for how this maps to the 3-role RBAC in CONVENTIONS. |

No env vars, no localStorage, no session reads inside this file. Everything is props + `window.VIBERR.runtime`.

---

## 4. UI states & interactions

### 4.1 `AgentPicker` (shared dropdown)

Verbatim structure:

```jsx
<div className="rsel" ref={ref}>
  <button type="button" className={"rsel-btn" + (open ? " open" : "")} onClick={() => setOpen(!open)}
    aria-haspopup="listbox" aria-expanded={open} aria-label={label}>
    <RunGlyph run={cur} />
    <span className="rsel-nm">{cur.who.name}<span className="rsel-role"> · {roleShort(cur)}</span></span>
    <span className={"rdot " + cur.state} />
    <Icon name="chevron" className="caret" />
  </button>
  {open && (
    <div className="rsel-menu" role="listbox" aria-label={label}>
      {items.map((r) => (
        <button type="button" key={r.id} role="option" aria-selected={r.id === cur.id}
          className={"rsel-item" + (r.id === cur.id ? " on" : "")}
          onClick={() => { onChange(r.id); setOpen(false); }}>
          <RunGlyph run={r} />
          <span className="ri-txt">
            <span className="ri-nm">{runLabel(r)}</span>
            <span className="ri-sub">{r.role} · {r.sdk}</span>
          </span>
          <span className={"ri-state " + r.state}><span className={"rdot " + r.state} />{RUN_STATE[r.state].label}</span>
        </button>
      ))}
    </div>
  )}
</div>
```

Behavior:
- **Trigger button** shows: glyph, `who.name` + ` · ` + short role (`operator`/`primary`/`consultant`, faint), a state dot (`rdot running|done|error|<idle default>` — running pulses), rotated chevron caret (points down closed, up open via CSS transform).
- **Fallback selection:** `const cur = items.find(r => r.id === value) || items[0];` — never renders empty if items exist.
- **Menu item** shows: glyph, primary line `runLabel(r)` (e.g. `"Codex · Developer"`, `"Claude Code · Reviewer"`, `"Operator"`), subline `"{role} · {sdk}"` (e.g. `"Primary specialist · Codex SDK"`), and right-aligned state chip: pulsing/colored dot + label (`running` / `idle` / `finished` / `continuity error`), colored by `.ri-state.running|done|error`.
- **Close on outside click:** `mousedown` listener on `document`, closes when the click target is outside the ref'd root. Listener attached for component lifetime.
- **No keyboard handling in the mock** — no Escape, no arrow keys, no focus trap. The port should add Escape-close + arrow navigation per CONVENTIONS ("keyboard menus/dialogs"), keeping the ARIA pattern (`aria-haspopup="listbox"`, `role="listbox"`/`role="option"`, `aria-selected`).
- `aria-label` values used: `"Select running agent"` (live strip), `"Select agent log stream"` (logs panel).

`RunGlyph`: `run.op` → `<span className="agent-glyph op"><Icon name="shield" /></span>` (black shield chip); otherwise `AgentGlyph` from ui.jsx: `<span className="agent-glyph claude|codex" title="Claude Code"|"Codex"><Icon name="sparkle"|"cpu" /></span>`.

### 4.2 `LiveRunPanel`

Visibility: `runtime.filter(r => r.state === "running")`; **returns `null` when empty** (no placeholder). Mounts with `data-comment-anchor="live-run"` (prototype design-review anchor; see §7).

Verbatim full render:

```jsx
<div className="runbar" data-comment-anchor="live-run">
  <div className="runbar-head">
    <span className="live-dot" />
    <h2>Live run</h2>
    <Pill kind="agent" sm>{running.length === 1 ? "1 agent running" : running.length + " agents running"}</Pill>
    <span className="right">
      {running.length > 1
        ? <AgentPicker items={running} value={run.id} onChange={setSelId} label="Select running agent" />
        : <span className="who-chip"><RunGlyph run={run} /><span className="nm">{runLabel(run)}</span></span>}
    </span>
  </div>
  <div className="runbar-body">
    <div className="run-phase">
      <span className="run-spin" aria-hidden="true" />
      <span>
        <div className="ph">{run.phase}</div>
        <div className="step mono">{run.step}</div>
      </span>
    </div>
    <div className="run-stats">
      <div className="run-cell"><div className="lbl">Elapsed</div><div className="val mono">{fmtClock((run.elapsed || 0) + tick)}</div></div>
      <div className="run-cell"><div className="lbl">Turns</div><div className="val mono">{run.turns}</div></div>
      <div className="run-cell"><div className="lbl">Tokens</div><div className="val mono">{fmtTok(run.tokens + tick * 42)}</div></div>
      <div className="run-cell"><div className="lbl">Runtime</div><div className="val mono">{run.model}</div></div>
    </div>
    <div className="run-actions">
      <button className="btn ghost sm" onClick={() => onViewLogs(run.id)}><Icon name="term" />View logs</button>
      <button className="btn ghost sm" onClick={() => push && push("Interrupt is a governed action — stubbed in this prototype")}><Icon name="hand" />Interrupt</button>
    </div>
  </div>
</div>
```

Details:
- **Pulsing indicator:** `.live-dot` — 9px agent-purple dot; `::after` ring animates `livePulse` 1.7s infinite (scale .45→1.2, fade out). Pure CSS, ships with the ported stylesheet.
- **Spinner:** `.run-spin` — 18px ring, agent-color top border, `runSpin .9s linear infinite`. `aria-hidden="true"`.
- **Concurrent-run dropdown:** only when `running.length > 1` (VIB-151 has two concurrent running threads — primary Claude + consultant Codex — this is the demo case). Exactly one running run (VIB-153, VIB-145) renders the static `who-chip` instead. The dropdown lists **only running runs**.
- **Selection fallback:** `selId` initialized once to the first running run's id; `const run = running.find(r => r.id === selId) || running[0];`. If the selected run stops running, display silently falls back to the first still-running run (stale `selId` retained). Acceptable to reproduce; the port should reset selection when the id disappears.
- **Tickers:** one shared `useTicker(!!run)` counter. Elapsed = server-provided seconds + tick. Tokens = base + `tick * 42` (a fake "42 tokens/sec" stream). **Both are prototype theater** — see §7. Ticker state never resets when switching selected runs, so switching agents mid-tick shows base+sharedTick for the new agent (mock quirk; the real elapsed derives from timestamps so this disappears).
- **Stat cell labels (exact copy):** `Elapsed`, `Turns`, `Tokens`, `Runtime` (uppercase via CSS). Values are `.mono`.
- **Buttons (exact copy):** `View logs` (icon `term`), `Interrupt` (icon `hand`). Interrupt in the mock only fires a toast: **"Interrupt is a governed action — stubbed in this prototype"**. Port: real action (§5).
- Responsive: `@media (max-width: 1100px)` `.run-actions { margin-left: 0; width: 100%; }` (buttons wrap to their own full-width row).

### 4.3 `AgentLogsPanel`

**Empty state** (task has no runtime threads at all, e.g. VIB-166/VIB-168):

```jsx
<div className="panel" data-comment-anchor="agent-logs">
  <div className="panel-head"><Icon name="term" /><h2>Agent logs</h2></div>
  <div className="empty">No agent runs yet — runtime streams appear here once the operator engages a specialist.</div>
</div>
```

**Populated state** — verbatim skeleton:

```jsx
<div className="panel" data-comment-anchor="agent-logs">
  <div className="panel-head">
    <Icon name="term" />
    <h2>Agent logs</h2>
    <span className="right"><AgentPicker items={runtime} value={cur.id} onChange={onSel} label="Select agent log stream" /></span>
  </div>

  <div className="logs-bar">
    <Pill kind={st.kind} sm dot={cur.state === "running"}>{st.label}</Pill>
    <span className="logs-meta mono" title={cur.sid}>
      {cur.backend === "codex"
        ? "@openai/codex-sdk · runStreamed() · thread " + String(cur.sid || "").slice(0, 13) + "…"
        : "@anthropic-ai/claude-agent-sdk · stream-json · session " + String(cur.sid || "").slice(0, 8) + "…"}
    </span>
    <span className="spacer" />
    <button type="button" className={"fchip" + (raw ? " on" : "")} onClick={() => setRaw(!raw)} title="Show raw stream events">{"{ } raw"}</button>
    <button type="button" className={"fchip" + (follow ? " on" : "")}
      onClick={() => { const n = !follow; setFollow(n); if (n && boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight; }}>
      <Icon name="arrow" />follow
    </button>
  </div>

  <div className="console" ref={boxRef} role="log" aria-live="off" aria-label={"Log stream for " + runLabel(cur)}
    onScroll={(e) => { const el = e.currentTarget; setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 48); }}>
    {shown.map((l, i) => (
      <div className={"log-line " + l.ev} key={i}>
        <span className="lt">{l.t}</span>
        <span className="ltag">{l.tag}</span>
        <span className="lx">{raw ? rawLine(cur, l, i, shown) : <React.Fragment>{l.name ? <b className="ln">{l.name} </b> : null}{l.text}</React.Fragment>}</span>
      </div>
    ))}
    {cur.state === "running" && (
      <div className="log-line cursor"><span className="lt"></span><span className="ltag"></span><span className="lx"><span className="lcaret">▌</span></span></div>
    )}
  </div>

  <div className="logs-foot">
    <span>
      {cur.state === "running" ? "streaming — raw output stays here as evidence, never in the task record"
        : cur.state === "done" ? "run finished at " + (cur.finished || "—") + " — thread can be re-engaged"
        : cur.state === "error" ? "stream ended on a continuity error — see the blocked packet"
        : "thread alive — no run executing"}
    </span>
    <span className="mono">{shown.length} events</span>
  </div>
</div>
```

Behavior inventory:

- **Thread selection:** `cur = runtime.find(r => r.id === sel) || runtime.find(r => r.state === "running") || runtime[0]` — when nothing is explicitly selected (`sel` null), defaults to the **first running thread**, else the first thread. `onSel` lifts to the parent so the live strip's "View logs" can drive it. The dropdown lists **all** threads (any state).
- **Thread dropdown states:** each menu item shows its live state chip; the four visible labels are exactly `running`, `idle`, `finished`, `continuity error`.
- **State pill (logs-bar):** `Pill kind={st.kind} sm dot={cur.state === "running"}` — dot only when running (dot inherits `currentColor` and does *not* animate here; only `.rdot.running` pulses, `.pdot` doesn't).
- **Metadata line (exact copy):**
  - Codex: `@openai/codex-sdk · runStreamed() · thread 0199a2c4-7b31…` (sid sliced to 13 chars + `…`)
  - Claude: `@anthropic-ai/claude-agent-sdk · stream-json · session 51d8f0e2…` (sid sliced to 8 chars + `…`)
  - Full sid exposed via `title` attribute (hover tooltip).
- **Raw toggle:** chip literally labeled `{ } raw` (brace-space-brace, space, "raw"), `title="Show raw stream events"`. Toggles per-line rendering between friendly text and reconstructed JSON envelope (§5.4). Toggle is panel-wide, not per-line. State is local component state (resets on remount, not persisted).
- **Follow toggle + auto-follow:**
  - `follow` starts `true`.
  - An effect scrolls `console` to bottom whenever `[shown.length, raw, cur.id, follow]` change *and* follow is on.
  - **Scroll auto-detection:** `onScroll` sets `follow = (scrollHeight - scrollTop - clientHeight) < 48` — scrolling up more than 48px disengages follow; scrolling back to (near) bottom re-engages it. This means the chip state flips implicitly with user scrolling.
  - Clicking the chip on → immediately jumps to bottom.
  - The chip's `arrow` icon is rotated 90° by CSS (`.logs-bar .fchip .ico { transform: rotate(90deg); }`) to point down.
- **Simulated streaming (prototype-only):** effect keyed on `cur.id`: resets `liveN` to 0; if the thread is running and has `live` lines, schedules them one at a time with delay `1000 + ((i * 733) % 2200)` ms (pseudo-random 1.0–3.2s cadence). `shown = cur.lines.concat((cur.live || []).slice(0, liveN))`. Switching away and back **replays** the live lines from zero. Port: replace entirely with SSE-appended lines; `shown` becomes the full normalized stream.
- **Cursor line:** while the thread is running, a trailing `log-line cursor` row with empty `lt`/`ltag` and a `▌` glyph in `lcaret` (blinks via `caretBlink 1.1s steps(2) infinite`).
- **Console a11y:** `role="log"` `aria-live="off"` (deliberate — high-frequency stream, do not announce), `aria-label="Log stream for {runLabel}"`. `overscroll-behavior: contain` and `color-scheme: dark` come from CSS.
- **Footer sentences (exact copy, one of four):**
  - running: `streaming — raw output stays here as evidence, never in the task record`
  - done: `run finished at {finished} — thread can be re-engaged` (fallback `—` for missing `finished`)
  - error: `stream ended on a continuity error — see the blocked packet`
  - idle (default): `thread alive — no run executing`
- **Event count:** `{shown.length} events` — counts rendered envelope lines for the selected thread (excludes the cursor row). In the port this is the count of normalized events currently loaded (mind pagination — Open question 5).

### 4.4 Per-envelope log-line rendering (friendly mode)

Grid columns: `60px` time / `126px` tag / flexible text. Row class = `log-line {ev}`. Coloring (dark console palette, hex is in the ported CSS verbatim):

| `ev` | Row class | `.ltag`/`.lx` colors | Friendly `.lx` content |
|---|---|---|---|
| `init` | `.log-line.init` | both `#8fb2ff` (blue) | `text` — e.g. `session 51d8f0e2 · claude-sonnet-4-5 · 9 tools · mcp: github, filesystem · cwd /work/viberr` / `thread 0199a1f3-4c02… resumed · gpt-5.4-codex` |
| `text` | `.log-line.text` (no dedicated rule → default `#c9d1e3`) | default | `text` (assistant / agent_message prose) |
| `think` | `.log-line.think` | `.lx` `#8f9ab3` *italic* | `text` (codex reasoning summary) |
| `tool` | `.log-line.tool` | tag `#b79dff`, text `#d9ccff` | `<b className="ln">{name} </b>{text}` — bold tool name (`.ln` `#e6dcff`), then argument summary. Claude: `Bash npm test -- --filter=compression`, `Read .viberr/tasks/VIB-151/task.md`, `Edit timeline/compress.ts — always keep typed events above threshold`. Codex: `exec rg 'packet' src/operator/ --files-with-matches`. |
| `out` | `.log-line.out` | `.lx` `#93a0b8` | `text` (tool/command output summary) |
| `err` | `.log-line.err` | both `#ff9a94` (red) | `text` (error output; codex = non-zero exit) |
| `diff` | `.log-line.diff` | both `#ffd28f` (amber) | `text` — e.g. `9 files · +412 −87 · policy gate, branch reconciler, task projection` |
| `result` | `.log-line.result` | both `#7fe6bd` (green) | `text` — e.g. `success · 4 turns · 2m 12s api · $0.31` / `turn 3 · in 51.2k (cached 38.9k) · out 1.9k tokens` |
| `meta` | `.log-line.meta` | both `#5f6a85` (dim) | `text` — codex `turn N` markers |
| (cursor) | `.log-line.cursor` | — | `▌` in `.lcaret` |

Timestamps (`.lt`, `#4d566b`) and tags (`.ltag`, ellipsized, nowrap) render for every real line. `.lx` is `pre-wrap` + `break-word`, so multi-line output and long raw JSON wrap properly.

---

## 5. Events / mutations produced

The mock produces **zero real mutations**. Inventory of what must become real:

### 5.1 Interrupt (the only stubbed governed action)

- Mock: toast `"Interrupt is a governed action — stubbed in this prototype"` via the `push` prop.
- Port (per CONVENTIONS "Every governed action … → audit event + (where user-visible) typed timeline event" and BUILD-PLAN Phase 8 "interrupt"):
  - Route action on the task-detail route (e.g. intent `run.interrupt`, payload: task key + thread/run id), server-side capability + RBAC check.
  - Adapter-level interrupt of the spawned process; run state → `interrupted` (new lifecycle state the mock never renders — pick its `RUN_STATE` mapping, see Open question 3).
  - **Audit event** written (run interrupt is listed among governed actions in CONVENTIONS).
  - **Typed timeline event** in `task.md`: the mock's five typed events are quality flag / transition request / blocked decision / completion report / policy violation — an interrupt is not one of them; record it as an operator/system timeline entry + audit event rather than inventing a sixth typed kind unless architecture says otherwise (Open question 3).
  - Idempotent-safe (interrupting a non-running run is a no-op with a friendly result, not an error).
  - No optimistic UI: revalidate on action completion + SSE run-state event.

### 5.2 View logs / thread selection

Pure client state in the mock (`logSel` in `TaskDetail`). Port options: keep as client state, optionally mirror to a URL search param (`?thread=`) for deep-linking (Open question 6). Add scroll-into-view of the logs panel when triggered from the strip.

**However:** the mock's policy data implies opening agent runtime sessions is itself audit-relevant — `POLICY.rbac` row `"Open agent runtime sessions"` (admin ✓, maintainer ✓, reviewer ✗, viewer ✗) and the audit event `"Murat opened the Developer runtime session for debugging — recorded per audit policy on VIB-160"`. If the logs panel is treated as "opening a runtime session", the loader must gate the log payload by role and write an audit event on first open per user+run. Decide at port time (Open question 4).

### 5.3 Raw / follow toggles

Local UI state only; nothing persisted. Keep them ephemeral.

### 5.4 Raw envelope reconstruction (`rawLine`) — the wire-format contract

In the mock, raw mode *reconstructs* plausible envelopes from display lines. In the real app the adapters persist real envelopes, so **this function becomes the spec for the parser/normalizer** (read it in reverse). Exact reconstruction, by backend and `ev`:

**Codex (`run.backend === "codex"`)** — `J = JSON.stringify`, `i` = index of the line within the *currently shown* array:

| `ev` | Envelope |
|---|---|
| `init` | `{ type: "thread.started", thread_id: run.sid }` |
| `meta` | `{ type: "turn.started" }` |
| `think` | `{ type: "item.completed", item: { id: "item_"+i, type: "reasoning", text } }` |
| `tool` | `{ type: "item.started", item: { id: "item_"+i, type: "command_execution", command: "bash -lc " + J(text), aggregated_output: "", exit_code: null, status: "in_progress" } }` |
| `out`/`err` | Pairs with the nearest **preceding** `tool` line (`lastToolIdx`): `{ type: "item.completed", item: { id: "item_"+k, type: "command_execution", command: "bash -lc " + J(lines[k].text), aggregated_output: text + "\n", exit_code: l.exit \|\| 0, status: l.exit ? "failed" : "completed" } }` (falls back to own index / `command: undefined` when no prior tool). |
| `diff` | `{ type: "item.completed", item: { id: "item_"+i, type: "file_change", changes: l.changes \|\| [], status: "completed" } }` |
| `result` | `{ type: "turn.completed", usage: l.usage \|\| {} }` |
| default (`text`) | `{ type: "item.completed", item: { id: "item_"+i, type: "agent_message", text } }` |

**Claude Code (default branch)**:

| `ev` | Envelope |
|---|---|
| `init` | `{ type: "system", subtype: "init", cwd: "/work/viberr", session_id: sid, model: run.model, permissionMode: "acceptEdits", tools: ["Task","Bash","Glob","Grep","Read","Edit","Write","WebFetch","TodoWrite"], mcp_servers: run.op ? [{ name:"viberr-task-store", status:"connected" }] : [{ name:"github", status:"connected" }, { name:"filesystem", status:"connected" }] }` — note the **operator gets the task-store MCP; specialists get github+filesystem**, matching the friendly init lines. |
| `tool` | `{ type: "assistant", message: { id: fakeId(run,i,"msg_01",22), type: "message", role: "assistant", model: run.model, content: [{ type: "tool_use", id: fakeId(run,i,"toolu_01",22), name: l.name, input }], stop_reason: null }, parent_tool_use_id: null, session_id: sid }` where `input = l.input \|\| (l.name === "Bash" ? { command: l.text } : { file_path: l.text })`. |
| `out`/`err` | `{ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: fakeId(run, k, "toolu_01", 22), content: l.text, is_error: l.ev === "err" }] }, session_id: sid }` — `tool_use_id` recomputed from the paired tool line's index `k`, so the ids **match** the preceding `tool_use` envelope (deterministic hash of `sid + ":" + index`). |
| `result` | `{ type: "result", subtype: s.subtype \|\| "success", is_error: !!s.subtype && s.subtype !== "success", duration_ms: s.dur, duration_api_ms: s.api, num_turns: s.turns, total_cost_usd: s.cost, usage: { input_tokens: s.in, cache_read_input_tokens: s.cached, output_tokens: s.out }, session_id: sid }` |
| default (`text`) | `{ type: "assistant", message: { id: fakeId(...), type: "message", role: "assistant", model: run.model, content: [{ type: "text", text: l.text }], stop_reason: null }, parent_tool_use_id: null, session_id: sid }` |

`fakeId` implementation (only needed if the port keeps simulated backends; the real adapters have real ids):

```js
function fakeId(run, i, prefix, len) {
  let h = 2166136261;
  const seed = (run.sid || "seed") + ":" + i;
  for (let k = 0; k < seed.length; k++) { h ^= seed.charCodeAt(k); h = Math.imul(h, 16777619); }
  const AB = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz123456789";
  let s = "";
  for (let k = 0; k < len; k++) { h = Math.imul(h ^ (h >>> 13), 1597334677); s += AB[Math.abs(h) % AB.length]; }
  return prefix + s;
}
```

Raw output is a single `JSON.stringify` line (no pretty-printing); the console's `pre-wrap` handles wrapping. **Port note:** since real envelopes will be persisted, raw mode should render the *stored* envelope verbatim instead of reconstructing — keep the single-line presentation. The `simulated` backend (BUILD-PLAN Phase 8) can reuse this reconstruction to fabricate its stored envelopes so raw mode is uniform.

---

## 6. CSS classes used (the contract)

All defined in `viberr.css` under `/* AGENT RUNTIME — live run strip + streamed SDK logs */` (~lines 1811–1925) unless noted. Ported verbatim — do not rename.

**Live strip:** `runbar`, `runbar-head` (+ child `h2`, `.right`), `runbar-body`, `live-dot` (pulse via `@keyframes livePulse`), `run-phase` (+ `.ph`, `.step`), `run-spin` (`@keyframes runSpin`), `run-stats`, `run-cell` (+ `.lbl`, `.val`), `run-actions` (goes full-width ≤1100px).

**Dropdown:** `rsel`, `rsel-btn` (+ `.open`, child `.caret` rotated 90°/−90°), `rsel-nm`, `rsel-role`, `rsel-menu` (right-aligned, `rise` animation), `rsel-item` (+ `.on`), `ri-txt`, `ri-nm`, `ri-sub`, `ri-state` (+ `.running` `.done` `.error`), `rdot` (+ `.running` pulsing via `pulse-a`, `.done`, `.error`; idle = default placeholder grey).

**Logs panel:** `panel`, `panel-head` (shared panel chrome), `logs-bar` (+ `.spacer`), `logs-meta`, `fchip` (+ `.on`; shared filter-chip primitive, ~line 474; logs-bar variant shrinks padding and rotates the icon), `console` (fixed 320px height, `#0e1117` bg, `color-scheme: dark`; dark-theme override `#0b0d12`), `log-line` + ev modifiers `init|text|think|tool|out|err|diff|result|meta|cursor`, `lt`, `ltag`, `lx`, `ln`, `lcaret` (`@keyframes caretBlink`), `logs-foot` (+ `.mono`), `empty` (shared empty-state).

**Shared primitives referenced:** `pill` (+ `agent|neutral|done|blocked`, `sm`, `pdot`), `btn ghost sm`, `who-chip` (+ `.nm`), `agent-glyph` (+ `op|claude|codex`; `.op` is black/white shield, dark-theme variants exist), `mono`, `right`, `ico`. Icons used: `term`, `hand`, `chevron`, `arrow`, `shield`, `sparkle`, `cpu`.

Dark-theme overrides that must survive: `:root[data-theme="dark"] .console`, `... .run-cell`, `... .agent-glyph.claude/.codex`.

---

## 7. Porting notes

Prototype-only bits and their replacements:

1. **`window.VIBERR.runtime` global** → task-detail route loader data (projection query) + SSE. Components become props-driven exactly as they already are — `runtime`, `sel`/`onSel`, `onViewLogs` prop shapes can survive unchanged; only the parent wiring changes.
2. **`lines` + `live` split with `setTimeout` streaming** (`1000 + ((i*733) % 2200)` ms cadence, replay-on-reselect) → delete. One event list from the loader; new lines appended via SSE `run.log-appended`; `follow` behavior already handles append-scrolling. Do not replay on thread switch.
3. **Fake tickers**: `elapsed + tick` → derive elapsed from `startedAt` (UTC ISO) vs client clock (keep the 1s `useTicker` for smooth display); `tokens + tick * 42` → **remove the ×42 fabrication**, show last-known cumulative usage, updated when usage-bearing envelopes arrive.
4. **Interrupt toast stub** → real governed action (see §5.1) with confirm affordance if desired (mock has none — it's one click straight to a stub).
5. **`rawLine` reconstruction** → render persisted envelopes; keep the function's mapping as the normalizer spec and for the `simulated` backend.
6. **`data-comment-anchor="live-run"` / `"agent-logs"`** — attributes consumed by the *design-review harness*, not by any app code (repo-wide grep: no JS consumer). Harmless to keep; safe to drop; be consistent with what other ported surfaces did.
7. **`Object.assign(window, …)` exports** → proper module exports under `app/features/task-detail/` (or a `runs`/`runtime` feature folder per Phase 8).
8. **`React.Fragment` / `useStateR` aliases** → normal imports/JSX.

Edge cases to preserve or handle:

- **No runtime at all** → logs panel renders the exact empty-state sentence; live strip renders nothing. (Mock tasks VIB-166, VIB-168.)
- **Runtime exists but nothing running** → no live strip; logs panel defaults to first thread; footer shows the idle/done/error sentence. (VIB-142 after completion, VIB-139, VIB-141.)
- **Two agents running concurrently** → dropdown in the strip header (VIB-151). Test both branches of the header-right slot.
- **Error thread** (VIB-160 primary): state pill `continuity error` (kind `blocked`), footer "stream ended on a continuity error — see the blocked packet", result envelope with `subtype: "error_during_execution"` and `is_error: true`. The footer cross-references the blocked decision packet rendered above the logs panel — keep both on the same page.
- **Missing fields:** `run.elapsed || 0`; `cur.finished || "—"`; `String(cur.sid || "")` before slicing; `l.input || synthesized`; `l.stats/usage/changes || defaults`. Keep all guards — real adapter data will hit them.
- **Selection staleness:** both panels fall back gracefully when the selected id vanishes (`|| items[0]`, `|| first running || runtime[0]`). Keep the fallbacks; additionally reset stored selection when its thread disappears from the list.
- **`key={i}` on log lines** — index keys are fine for an append-only stream, but if the port ever paginates/prepends, switch to stable event ids (the persisted envelopes will have them).
- **Keyboard support:** add Escape-close and arrow-key navigation to `AgentPicker` (mock only has outside-mousedown close); keep the existing ARIA attributes verbatim.
- **48px follow threshold and 320px console height** are load-bearing UX numbers — keep them.
- **Do not announce log lines** — keep `aria-live="off"`; the console is high-frequency output, and `role="log"`'s implicit politeness must stay suppressed.
- **Idle-state dot:** `.rdot` with no modifier (placeholder grey) — `RUN_STATE.idle` items render `rdot idle` (class `idle` has no CSS rule; base style applies). Fine — don't "fix" by adding a rule.
- **`fmtTok` boundaries:** 999 → `999`; 1000 → `1.0k`; 99999 → `100.0k`; 100000 → `100k`; 128442 → `128k`. `fmtClock`: 402 → `06:42`; 5462 → `1:31:02` (hours unpadded).
- **Copy discipline:** every user-visible string in §4 is exact and should be ported verbatim, including the `·` separators, em dashes, and the `▌` cursor glyph.

---

## 8. Open questions

1. **Log persistence granularity & pagination.** BUILD-PLAN says NDJSON under data root `runtimes/`; long real runs will dwarf the mock's ~10-line streams. Does the loader send the full stream, a tail (e.g. last N events with "load earlier"), or virtualize? Affects the "N events" footer semantics.
2. **SSE events for run state.** `run.log-appended` is specified; is there a `run.state-changed` (or does the client infer state flips from `result`/`turn.completed` envelopes)? The strip's appear/disappear and the logs pill need timely state, not just log lines.
3. **Lifecycle states beyond the mock's four.** Registry lifecycle is `queued/running/finished/error/interrupted`. Proposed mapping: `queued` → neutral pill "queued"; `interrupted` → blocked-or-neutral pill "interrupted" + a footer sentence (none exists in the mock — needs copy). Also: is an interrupt recorded as one of the five typed timeline events or only as audit + plain timeline entry?
4. **RBAC for viewing logs.** Mock project policy gates "Open agent runtime sessions" to admin/maintainer and audit-logs the open (VIB-160 example), but CONVENTIONS defines org roles admin/member/viewer. Decide: (a) is the logs panel visible-but-empty, hidden, or fully visible for viewer-level users; (b) does rendering the panel constitute "opening a runtime session" for audit purposes, or only a future interactive session feature?
5. **Raw mode source of truth.** Recommend rendering stored envelopes verbatim (this spec §5.4 then only constrains the simulated backend + the normalizer). Confirm, since stored real envelopes will contain fields the mock omits (e.g. streaming deltas, `parent_tool_use_id` chains) — render them anyway or filter to the mock's shapes?
6. **Deep-linking the selected thread** (`?thread=<id>` on the task route) — worth adding for "view logs" links from notifications/audit surfaces?
7. **"Runtime" stat cell shows `model`** (e.g. `claude-sonnet-4-5`) — label vs content mismatch is in the design on purpose? Port as-is unless design says relabel.
8. **Token growth while running.** With the ×42 fake removed, cumulative tokens only update at usage-bearing envelopes (claude: final `result`; codex: per-turn `turn.completed`) — long Claude turns will show a static number. Acceptable, or should adapters estimate from streamed deltas?
9. **`started` field** is stored but never rendered — include in the projection for future use (tooltips, sort), or drop?
