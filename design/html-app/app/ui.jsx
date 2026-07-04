/* Viberr — shared UI primitives. Exported to window for other babel scripts. */
const { useState, useEffect, useRef } = React;

/* ---------- Icons (stroke, 24x24) ---------- */
const ICON_PATHS = {
  board: '<rect x="3" y="3" width="7" height="18" rx="1.5"/><rect x="14" y="3" width="7" height="11" rx="1.5"/>',
  review: '<path d="M4 5h16M4 12h16M4 19h10"/>',
  inbox: '<path d="M3 12h5l2 3h4l2-3h5"/><path d="M5 6h14l2 6v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6z"/>',
  shield: '<path d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/>',
  agents: '<rect x="5" y="8" width="14" height="11" rx="2"/><path d="M12 8V4M9 4h6M9 13h.01M15 13h.01M9 16h6"/>',
  github: '<path d="M9 19c-4 1.5-4-2.5-6-3m12 5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.3 4.3 0 0 0-.1-3.2s-1-.3-3.4 1.3a11.5 11.5 0 0 0-6 0C6.3 3.3 5.3 3.6 5.3 3.6a4.3 4.3 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 10c0 4.6 2.7 5.7 5.5 6-.4.4-.5.9-.5 1.8V21"/>',
  activity: '<path d="M3 12h4l3 8 4-16 3 8h4"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4"/>',
  filter: '<path d="M3 5h18l-7 8v6l-4-2v-4z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  branch: '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="7" r="2.5"/><path d="M6 8.5v7M18 9.5c0 4-6 2.5-6 6.5"/>',
  pr: '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M6 8.5v7M18 15.5V11a3 3 0 0 0-3-3h-3l2.5-2.5M11.5 8 14 10.5"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  alert: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17h.01"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 20c1.5-4 4.5-6 8-6s6.5 2 8 6"/>',
  cpu: '<rect x="7" y="7" width="10" height="10" rx="1.5"/><path d="M9 1.5v3M15 1.5v3M9 19.5v3M15 19.5v3M1.5 9h3M1.5 15h3M19.5 9h3M19.5 15h3"/>',
  message: '<path d="M21 12a8 8 0 0 1-11.5 7.2L4 20l1-4.8A8 8 0 1 1 21 12z"/>',
  sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4M21 4v5h-5"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  bolt: '<path d="M13 3L5 13h6l-1 8 8-10h-6z"/>',
  memory: '<rect x="4" y="6" width="16" height="12" rx="2"/><path d="M8 6V3M12 6V3M16 6V3M8 18v3M12 18v3M16 18v3"/>',
  dot: '<circle cx="12" cy="12" r="4"/>',
  send: '<path d="M4 12l16-8-6 16-3-6z"/>',
  hand: '<path d="M7 11V6a1.5 1.5 0 0 1 3 0v4M10 10V4.5a1.5 1.5 0 0 1 3 0V10M13 10V6a1.5 1.5 0 0 1 3 0v6c0 4-2.5 7-6 7s-6-2.5-6-6v-1l1.5-1.5"/>',
  flag: '<path d="M5 21V4M5 4h10l-1.5 3L15 10H5"/>',
  bell: '<path d="M18 9a6 6 0 1 0-12 0c0 6-2 7.5-2 7.5h16S18 15 18 9"/><path d="M10.3 20a2 2 0 0 0 3.4 0"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  sliders: '<path d="M4 6h8M16 6h4M4 12h2M10 12h10M4 18h10M18 18h2"/><circle cx="14" cy="6" r="2"/><circle cx="8" cy="12" r="2"/><circle cx="16" cy="18" r="2"/>',
  grip: '<circle cx="9" cy="5.5" r="1"/><circle cx="15" cy="5.5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18.5" r="1"/><circle cx="15" cy="18.5" r="1"/>',
  ext: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  term: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M7 9.5l3 3-3 3M13 15.5h4"/>',
};

function Icon({ name, className }) {
  const inner = ICON_PATHS[name] || ICON_PATHS.dot;
  return (
    <svg className={"ico " + (className || "")} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"
      dangerouslySetInnerHTML={{ __html: inner }} aria-hidden="true" />
  );
}

/* ---------- Pill ---------- */
function Pill({ kind, children, dot, sm }) {
  return (
    <span className={"pill " + (kind || "") + (sm ? " sm" : "")}>
      {dot && <span className="pdot" />}
      {children}
    </span>
  );
}

const READINESS = {
  ready:   { kind: "ready",   label: "ready" },
  input:   { kind: "input",   label: "input required" },
  risk:    { kind: "risk",    label: "inconsistency risk" },
  blocked: { kind: "blocked", label: "blocked" },
  done:    { kind: "done",    label: "accepted" },
};
function ReadinessPill({ value, sm }) {
  const r = READINESS[value] || READINESS.ready;
  return <Pill kind={r.kind} dot sm={sm}>{r.label}</Pill>;
}

const VALIDATION = {
  healthy: { kind: "ready",   label: "validation healthy" },
  changed: { kind: "input",   label: "evidence changed" },
  failing: { kind: "blocked", label: "validation failing" },
  none:    { kind: "neutral", label: "no validation" },
};
function ValidationPill({ value, sm }) {
  const v = VALIDATION[value] || VALIDATION.none;
  return <Pill kind={v.kind} sm={sm}>{v.label}</Pill>;
}

/* ---------- Agent glyph + human avatar ---------- */
function AgentGlyph({ backend, lg }) {
  const cls = backend === "claude" ? "claude" : "codex";
  return (
    <span className={"agent-glyph " + cls + (lg ? " lg" : "")} title={backend === "claude" ? "Claude Code" : "Codex"}>
      <Icon name={backend === "claude" ? "sparkle" : "cpu"} />
    </span>
  );
}

function Avatar({ person, lg }) {
  const tone = person && person.tone ? " " + person.tone : "";
  return <span className={"avatar" + (lg ? " lg" : "") + tone}>{(person && person.initials) || "?"}</span>;
}

/* Renders either an agent or a human identity inline */
function Identity({ who, lg, sub }) {
  if (!who) return <span className="who-chip"><span className="avatar">?</span></span>;
  if (who.kind === "agent") {
    return (
      <span className="who-chip">
        <AgentGlyph backend={who.backend} lg={lg} />
        <span>
          <span className="nm">{who.name}{who.role ? " · " + who.role : ""}</span>
          {sub && <div className="sub">agent specialist</div>}
        </span>
      </span>
    );
  }
  if (who.kind === "system") {
    return (
      <span className="who-chip">
        <span className="agent-glyph"><Icon name="shield" /></span>
        <span className="nm">{who.name}</span>
      </span>
    );
  }
  return (
    <span className="who-chip">
      <Avatar person={who} lg={lg} />
      <span>
        <span className="nm">{who.name}</span>
        {sub && <div className="sub">human · maintainer</div>}
      </span>
    </span>
  );
}

/* ---------- Page overlay (full page content as a popup) ---------- */
function PageOverlay({ label, onClose, children }) {
  useEffect(() => {
    const f = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", f);
    return () => window.removeEventListener("keydown", f);
  }, []);
  return (
    <React.Fragment>
      <div className="confirm-scrim" onClick={onClose}></div>
      <div className="page-overlay" role="dialog" aria-modal="true" aria-label={label} data-screen-label={label + " — overlay"}>
        <button className="icon-btn overlay-x" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
        <div className="page-overlay-body">{children}</div>
      </div>
    </React.Fragment>
  );
}

/* ---------- Toggle switch (shared) ---------- */
function TglP({ on, onChange, label }) {
  return (
    <button type="button" className={"tgl" + (on ? " on" : "")} role="switch" aria-checked={on} aria-label={label} onClick={onChange}>
      <span className="knob"></span>
    </button>
  );
}

/* ---------- Toast ---------- */
function useToasts() {
  const [toasts, setToasts] = useState([]);
  const push = (text) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t, { id, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 2600);
  };
  return { toasts, push };
}
function ToastHost({ toasts }) {
  return (
    <div className="toast-wrap" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div className="toast" key={t.id}><Icon name="check" />{t.text}</div>
      ))}
    </div>
  );
}

/* ---------- Personal preferences (persisted per device) ---------- */
function initialsOf(name) {
  return (name || "").trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase() || "?";
}

(function initPrefs() {
  const DEF = {
    theme: "system", motion: "full", tlDefault: "all", ghConnected: true,
    notifs: {
      packets: { app: true, email: true },
      approvals: { app: true, email: false },
      mentions: { app: true, email: true },
      policy: { app: true, email: true },
      quality: { app: true, email: false },
    },
    nudge: { on: true, hours: 2 },
  };
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem("viberr:prefs") || "{}"); } catch (e) {}
  const prefs = {
    ...DEF, ...saved,
    notifs: { ...DEF.notifs, ...(saved.notifs || {}) },
    nudge: { ...DEF.nudge, ...(saved.nudge || {}) },
  };
  const apply = () => {
    const dark = prefs.theme === "dark" || (prefs.theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    document.documentElement.dataset.motion = prefs.motion === "reduce" ? "reduce" : "full";
  };
  window.VIBERR.prefs = prefs;
  window.VIBERR.savePrefs = (patch) => {
    Object.assign(prefs, patch);
    try { localStorage.setItem("viberr:prefs", JSON.stringify(prefs)); } catch (e) {}
    apply();
  };
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { if (prefs.theme === "system") apply(); });
  apply();
})();

Object.assign(window, {
  Icon, Pill, ReadinessPill, ValidationPill, READINESS, VALIDATION,
  AgentGlyph, Avatar, Identity, useToasts, ToastHost, initialsOf, TglP, PageOverlay,
});
