/* Viberr — Agent runtime: live run strip + streamed SDK logs (Claude Code / Codex). */
const { useState: useStateR, useEffect: useEffectR, useRef: useRefR } = React;

const RUN_STATE = {
  running: { kind: "agent",   label: "running" },
  idle:    { kind: "neutral", label: "idle" },
  done:    { kind: "done",    label: "finished" },
  error:   { kind: "blocked", label: "continuity error" },
};

function runLabel(run) {
  return run.who.name + (run.who.role ? " · " + run.who.role : "");
}
function roleShort(run) {
  return run.op ? "operator" : run.role === "Primary specialist" ? "primary" : "consultant";
}
function fmtClock(s) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  const p = (n) => String(n).padStart(2, "0");
  return h ? h + ":" + p(m) + ":" + p(x) : p(m) + ":" + p(x);
}
function fmtTok(n) {
  return n >= 100000 ? Math.round(n / 1000) + "k" : n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n);
}
function useTicker(active) {
  const [n, setN] = useStateR(0);
  useEffectR(() => {
    if (!active) return;
    const id = setInterval(() => setN((x) => x + 1), 1000);
    return () => clearInterval(id);
  }, [active]);
  return n;
}

function RunGlyph({ run }) {
  if (run.op) return <span className="agent-glyph op"><Icon name="shield" /></span>;
  return <AgentGlyph backend={run.backend} />;
}

/* ---------- Agent dropdown (shared by live strip + logs) ---------- */
function AgentPicker({ items, value, onChange, label }) {
  const [open, setOpen] = useStateR(false);
  const ref = useRefR(null);
  useEffectR(() => {
    const f = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", f);
    return () => document.removeEventListener("mousedown", f);
  }, []);
  const cur = items.find((r) => r.id === value) || items[0];
  return (
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
  );
}

/* ---------- Live run strip (only while an agent run is executing) ---------- */
function LiveRunPanel({ runtime, onViewLogs, push }) {
  const running = runtime.filter((r) => r.state === "running");
  const [selId, setSelId] = useStateR(running.length ? running[0].id : null);
  const run = running.find((r) => r.id === selId) || running[0];
  const tick = useTicker(!!run);
  if (!run) return null;
  return (
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
          <button type="button" className="btn ghost sm" onClick={() => onViewLogs(run.id)}><Icon name="term" />View logs</button>
          <button type="button" className="btn ghost sm" onClick={() => push && push("Interrupt is a governed action — stubbed in this prototype")}><Icon name="hand" />Interrupt</button>
        </div>
      </div>
    </div>
  );
}

/* ---------- Raw wire-event rendering, faithful to each SDK ---------- */
/* Claude Code: NDJSON envelopes from `--output-format stream-json` (system·init,
   assistant text/tool_use, user tool_result, final result with usage + cost).
   Codex SDK: ThreadEvents from `thread.runStreamed()` (thread.started, turn.started,
   item.started/completed with typed items, turn.completed with usage). */
function fakeId(run, i, prefix, len) {
  let h = 2166136261;
  const seed = (run.sid || "seed") + ":" + i;
  for (let k = 0; k < seed.length; k++) { h ^= seed.charCodeAt(k); h = Math.imul(h, 16777619); }
  const AB = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz123456789";
  let s = "";
  for (let k = 0; k < len; k++) { h = Math.imul(h ^ (h >>> 13), 1597334677); s += AB[Math.abs(h) % AB.length]; }
  return prefix + s;
}
function lastToolIdx(lines, i) {
  for (let k = i - 1; k >= 0; k--) if (lines[k].ev === "tool") return k;
  return -1;
}
function rawLine(run, l, i, lines) {
  const J = JSON.stringify;
  if (run.backend === "codex") {
    switch (l.ev) {
      case "init":  return J({ type: "thread.started", thread_id: run.sid });
      case "meta":  return J({ type: "turn.started" });
      case "think": return J({ type: "item.completed", item: { id: "item_" + i, type: "reasoning", text: l.text } });
      case "tool":  return J({ type: "item.started", item: { id: "item_" + i, type: "command_execution", command: "bash -lc " + J(l.text), aggregated_output: "", exit_code: null, status: "in_progress" } });
      case "out": case "err": {
        const k = lastToolIdx(lines, i);
        return J({ type: "item.completed", item: { id: "item_" + (k >= 0 ? k : i), type: "command_execution", command: k >= 0 ? "bash -lc " + J(lines[k].text) : undefined, aggregated_output: l.text + "\n", exit_code: l.exit || 0, status: l.exit ? "failed" : "completed" } });
      }
      case "diff":  return J({ type: "item.completed", item: { id: "item_" + i, type: "file_change", changes: l.changes || [], status: "completed" } });
      case "result": return J({ type: "turn.completed", usage: l.usage || {} });
      default:      return J({ type: "item.completed", item: { id: "item_" + i, type: "agent_message", text: l.text } });
    }
  }
  const sid = run.sid;
  switch (l.ev) {
    case "init": return J({ type: "system", subtype: "init", cwd: "/work/viberr", session_id: sid, model: run.model, permissionMode: "acceptEdits", tools: ["Task", "Bash", "Glob", "Grep", "Read", "Edit", "Write", "WebFetch", "TodoWrite"], mcp_servers: run.op ? [{ name: "viberr-task-store", status: "connected" }] : [{ name: "github", status: "connected" }, { name: "filesystem", status: "connected" }] });
    case "tool": {
      const input = l.input || (l.name === "Bash" ? { command: l.text } : { file_path: l.text });
      return J({ type: "assistant", message: { id: fakeId(run, i, "msg_01", 22), type: "message", role: "assistant", model: run.model, content: [{ type: "tool_use", id: fakeId(run, i, "toolu_01", 22), name: l.name, input }], stop_reason: null }, parent_tool_use_id: null, session_id: sid });
    }
    case "out": case "err": {
      const k = lastToolIdx(lines, i);
      return J({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: fakeId(run, k >= 0 ? k : i, "toolu_01", 22), content: l.text, is_error: l.ev === "err" }] }, session_id: sid });
    }
    case "result": {
      const s = l.stats || {};
      return J({ type: "result", subtype: s.subtype || "success", is_error: !!s.subtype && s.subtype !== "success", duration_ms: s.dur, duration_api_ms: s.api, num_turns: s.turns, total_cost_usd: s.cost, usage: { input_tokens: s.in, cache_read_input_tokens: s.cached, output_tokens: s.out }, session_id: sid });
    }
    default: return J({ type: "assistant", message: { id: fakeId(run, i, "msg_01", 22), type: "message", role: "assistant", model: run.model, content: [{ type: "text", text: l.text }], stop_reason: null }, parent_tool_use_id: null, session_id: sid });
  }
}

/* ---------- Agent logs (separate section, dropdown per agent thread) ---------- */
function AgentLogsPanel({ runtime, sel, onSel }) {
  const cur = runtime.find((r) => r.id === sel) || runtime.find((r) => r.state === "running") || runtime[0];
  const [liveN, setLiveN] = useStateR(0);
  const [follow, setFollow] = useStateR(true);
  const [raw, setRaw] = useStateR(false);
  const boxRef = useRefR(null);

  // Simulated stream: append live lines on a timer, the way SDK events arrive.
  useEffectR(() => {
    setLiveN(0);
    if (!cur || cur.state !== "running" || !(cur.live || []).length) return;
    let stop = false, tid, i = 0;
    const step = () => {
      if (stop || i >= cur.live.length) return;
      tid = setTimeout(() => { i += 1; setLiveN(i); step(); }, 1000 + ((i * 733) % 2200));
    };
    step();
    return () => { stop = true; clearTimeout(tid); };
  }, [cur && cur.id]);

  const shown = cur ? cur.lines.concat((cur.live || []).slice(0, liveN)) : [];

  useEffectR(() => {
    const el = boxRef.current;
    if (el && follow) el.scrollTop = el.scrollHeight;
  }, [shown.length, raw, cur && cur.id, follow]);

  if (!runtime.length) {
    return (
      <div className="panel" data-comment-anchor="agent-logs">
        <div className="panel-head"><Icon name="term" /><h2>Agent logs</h2></div>
        <div className="empty">No agent runs yet — runtime streams appear here once the operator engages a specialist.</div>
      </div>
    );
  }

  const st = RUN_STATE[cur.state] || RUN_STATE.idle;
  return (
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
  );
}

Object.assign(window, { LiveRunPanel, AgentLogsPanel });
