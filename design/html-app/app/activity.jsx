/* Viberr — Activity view: project stream + audit logs */
const { useState: useStateAc, useMemo: useMemoAc } = React;

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

const ACT_ICON = {
  comment: "message", completion: "check", github: "github", policy: "shield",
  quality: "flag", transition: "arrow", blocked: "alert", agent: "agents", assign: "user",
};

/* ---------- Audit logs (policy & access) ---------- */
const PEV_META = {
  violation:  { icon: "alert", cls: "violation" },
  blockedact: { icon: "lock", cls: "blockedact" },
  change:     { icon: "shield", cls: "change" },
  audit:      { icon: "user", cls: "audit" },
};
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

/* ---------- Stream data — single-sourced from task timelines ---------- */
const norm = (ev) => ({
  type: ev.type, actor: ev.actor, t: ev.t,
  text: ev.title ? "**" + ev.title + ".** " + ev.text : ev.text,
});

const DAY_ORDER = ["Today", "Yesterday", "Mar 30"];
const evMins = (t) => {
  if (t === "now") return 100000;
  const m = /^(\d{1,2}):(\d{2})$/.exec(t || "");
  return m ? (+m[1]) * 60 + (+m[2]) : -1;
};

function useStream(tasks, extra) {
  return useMemoAc(() => {
    const rows = [];
    Object.entries(extra || {}).forEach(([key, evs]) => evs.forEach((ev) => rows.push({ ...norm(ev), task: key, day: "Today" })));
    tasks.forEach((task) => (task.timeline || []).forEach((ev) => rows.push({ ...norm(ev), task: task.key, day: ev.day || "Today" })));
    const days = [...DAY_ORDER, ...[...new Set(rows.map((r) => r.day))].filter((d) => !DAY_ORDER.includes(d))];
    return days.map((day) => ({
      day,
      rows: rows.filter((r) => r.day === day).sort((a, b) => evMins(b.t) - evMins(a.t)),
    }));
  }, [tasks, extra]);
}

/* ---------- root ---------- */
function Activity({ tasks, extra, onOpen, scopeGranted }) {
  const P = window.VIBERR.policy;
  const [f, setF] = useStateAc("all");
  const groups = useStream(tasks, extra);
  const match = (r) => f === "all" || (r.actor && r.actor.kind === f);
  const shown = groups.map((g) => ({ ...g, rows: g.rows.filter(match) })).filter((g) => g.rows.length);
  const total = shown.reduce((n, g) => n + g.rows.length, 0);

  return (
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

          <AuditLogs P={P} onOpen={onOpen} scopeGranted={scopeGranted} />
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { Activity, RichA });
