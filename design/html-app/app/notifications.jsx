/* Viberr — Notifications: typed events & mentions routed to you (FR16, FR24–FR26) */
const { useState: useStateN } = React;

const ntfMeta = (n) =>
  n.kind === "packet"
    ? (n.ptype === "blocked" ? { icon: "alert", cls: "act-blocked" } : { icon: "check", cls: "act-completion" })
    : n.kind === "approval" ? { icon: "arrow", cls: "act-transition" }
    : n.kind === "mention" ? { icon: "message", cls: "act-comment" }
    : n.kind === "quality" ? { icon: "flag", cls: "act-quality" }
    : { icon: "alert", cls: "act-policy" };

const ntfPill = (n) =>
  n.kind === "approval"
    ? { kind: "info", label: "approval" }
    : n.ptype === "blocked"
      ? { kind: "blocked", label: "blocked decision" }
      : { kind: "input", label: "completion report" };

/* ---------- Waiting on you: packets & approvals ---------- */
function NtfNeedsYou({ items, onRead, onOpen }) {
  return (
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
  );
}

/* ---------- Everything else: mentions, policy, quality ---------- */
function NtfStream({ items, onRead, onOpen }) {
  const days = [...new Set(items.map((n) => n.day))];
  return (
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
  );
}

/* ---------- root ---------- */
function Notifications({ items, onRead, onReadAll, onOpen, onNav }) {
  const [f, setF] = useStateN("all");
  const unread = items.filter((n) => n.unread).length;
  const match = (n) => (f === "unread" ? n.unread : true);
  const needs = items.filter((n) => (n.kind === "packet" || n.kind === "approval") && match(n));
  const rest = items.filter((n) => n.kind !== "packet" && n.kind !== "approval" && match(n));

  return (
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
  );
}

Object.assign(window, { Notifications });
