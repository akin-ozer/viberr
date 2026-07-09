/* Viberr — Home: org-level project selection. Post-login landing.
   Loads after data.js + ui.jsx (shared Icon/Avatar/Pill/toasts) + tweaks-panel.jsx. */
const { useState: useStateH, useEffect: useEffectH, useMemo: useMemoH, useRef: useRefH } = React;

/* ---------- local icons (not in shared set) ---------- */
function StarIco({ on }) {
  return (
    <svg className="ico" viewBox="0 0 24 24" fill={on ? "currentColor" : "none"}
      stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z" />
    </svg>
  );
}

/* ---------- org data (project directory) ---------- */
const HOME = (() => {
  const P = window.VIBERR.people;
  const projects = [
    {
      id: "viberr-core", name: "Viberr Core", key: "VIB", repo: "akin-ozer/viberr",
      desc: "The governed delivery layer itself — operator agents, policy engine, and the file-native task store.",
      dist: { triage: 2, ready: 3, impl: 4, review: 3, done: 2 },
      running: 3, waiting: 2, members: [P.ARDA, P.ELIF, P.MURAT, P.SELIN], updated: "2m ago", starred: true,
    },
    {
      id: "deploy-pipeline", name: "Deploy Pipeline", key: "DEP", repo: "akin-ozer/deploy-pipeline",
      desc: "Release automation with human-gated promotion. Agents draft, humans authorize every environment step.",
      dist: { triage: 1, ready: 2, impl: 3, review: 1, done: 5 },
      running: 2, waiting: 1, members: [P.MURAT, P.ARDA], updated: "18m ago", starred: true,
    },
    {
      id: "docs-engine", name: "Docs Engine", key: "DOC", repo: "akin-ozer/docs-engine",
      desc: "Living documentation generated from task contracts and change summaries.",
      dist: { triage: 3, ready: 1, impl: 2, review: 0, done: 7 },
      running: 1, waiting: 0, members: [P.SELIN, P.ELIF], updated: "1h ago", starred: false,
    },
    {
      id: "billing-service", name: "Billing Service", key: "BIL", repo: "akin-ozer/billing-service",
      desc: "Usage metering and invoicing. Strict human-gate policy — agents recommend, never merge.",
      dist: { triage: 2, ready: 2, impl: 1, review: 2, done: 3 },
      running: 0, waiting: 1, members: [P.ELIF, P.ARDA, P.MURAT], updated: "3h ago", starred: false,
    },
    {
      id: "mobile-companion", name: "Mobile Companion", key: "MOB", repo: "akin-ozer/mobile-companion",
      desc: "Review-first tablet surface: current state, latest packet, safe lightweight actions.",
      dist: { triage: 4, ready: 1, impl: 1, review: 0, done: 1 },
      running: 1, waiting: 0, members: [P.SELIN], updated: "yesterday", starred: false,
    },
    {
      id: "infra-modules", name: "Infra Modules", key: "INF", repo: "akin-ozer/infra-modules",
      desc: "Shared Terraform modules for the on-prem deployment. Quiet — consultants re-engage on demand.",
      dist: { triage: 1, ready: 0, impl: 0, review: 1, done: 9 },
      running: 0, waiting: 0, members: [P.MURAT, P.ELIF], updated: "3d ago", starred: false,
    },
  ];
  return { projects };
})();

const LS_KEY = "viberr:home";
function loadHomeState() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || "{}"); } catch (e) { return {}; }
}
function saveHomeState(patch) {
  const cur = loadHomeState();
  try { localStorage.setItem(LS_KEY, JSON.stringify({ ...cur, ...patch })); } catch (e) {}
}

const WORKSPACE = "Viberr Operator Workspace.html";

const plainTxt = (s) => (s || "").replace(/\*\*/g, "").replace(/`/g, "");
const homeNtfMeta = (n) =>
  n.kind === "packet" ? (n.ptype === "blocked" ? { icon: "alert", cls: "act-blocked" } : { icon: "check", cls: "act-completion" })
  : n.kind === "approval" ? { icon: "arrow", cls: "act-transition" }
  : n.kind === "mention" ? { icon: "message", cls: "act-comment" }
  : n.kind === "quality" ? { icon: "flag", cls: "act-quality" }
  : { icon: "alert", cls: "act-policy" };

/* ---------- small pieces ---------- */
function StageMeter({ dist }) {
  const stages = window.VIBERR.stages;
  const total = stages.reduce((a, s) => a + (dist[s.id] || 0), 0);
  if (!total) return <div className="pj-meter empty" title="No tasks yet"></div>;
  const label = stages.map((s) => (dist[s.id] || 0) + " " + s.name.toLowerCase()).join(" · ");
  return (
    <div className="pj-meter" title={label}>
      {stages.map((s) => {
        const n = dist[s.id] || 0;
        if (!n) return null;
        return <span key={s.id} style={{ flex: n, background: s.color, opacity: s.id === "done" ? 0.45 : 1 }}></span>;
      })}
    </div>
  );
}

function ProjectStats({ p, mono }) {
  const total = Object.values(p.dist).reduce((a, b) => a + b, 0);
  return (
    <div className="pj-stats">
      <span>{total + " task" + (total === 1 ? "" : "s")}</span>
      {p.running > 0 && (
        <React.Fragment>
          <span>·</span>
          <span className="running"><span className="working"></span>{p.running + " agent" + (p.running === 1 ? "" : "s") + " running"}</span>
        </React.Fragment>
      )}
      {p.running === 0 && total > 0 && <React.Fragment><span>·</span><span>quiet</span></React.Fragment>}
      {p.waiting > 0 && <Pill kind="input" sm>{p.waiting} waiting on you</Pill>}
    </div>
  );
}

function MemberStack({ members }) {
  return (
    <span className="stack" aria-label={members.map((m) => m.name).join(", ")}>
      {members.map((m, i) => <Avatar key={i} person={m} />)}
    </span>
  );
}

function ProjectCard({ p, starred, onStar, showDesc }) {
  return (
    <article className="pj-card" data-screen-label={"Project card — " + p.name}>
      <a className="pj-link" href={WORKSPACE} aria-label={"Open " + p.name + " board"}>
        <div className="pj-top">
          <span className="pj-mark" style={{ boxShadow: "inset 0 -8px 0 " + p.accent }}>{p.name[0]}</span>
          <span className="pj-name">
            <span className="nm">{p.name}<span className="key">{p.key}</span></span>
            <span className="repo"><Icon name="github" />{p.repo}</span>
          </span>
        </div>
        {showDesc && <p className="pj-desc">{p.desc}</p>}
        <StageMeter dist={p.dist} />
        <ProjectStats p={p} />
        <div className="pj-foot">
          <MemberStack members={p.members} />
          <span className="upd">updated {p.updated}</span>
        </div>
      </a>
      <button type="button" className={"pj-star" + (starred ? " on" : "")} onClick={() => onStar(p.id)}
        aria-label={(starred ? "Unpin " : "Pin ") + p.name} title={starred ? "Unpin" : "Pin"}>
        <StarIco on={starred} />
      </button>
    </article>
  );
}

function ProjectRow({ p, starred, onStar }) {
  return (
    <article className="pj-row" data-screen-label={"Project row — " + p.name}>
      <a className="pj-link" href={WORKSPACE} aria-label={"Open " + p.name + " board"}>
        <span className="pj-mark" style={{ boxShadow: "inset 0 -7px 0 " + p.accent }}>{p.name[0]}</span>
        <span className="pj-name">
          <span className="nm">{p.name}<span className="key">{p.key}</span></span>
          <span className="repo"><Icon name="github" />{p.repo}</span>
        </span>
        <StageMeter dist={p.dist} />
        <ProjectStats p={p} />
        <MemberStack members={p.members} />
        <span className="go"><Icon name="chevron" /></span>
      </a>
      <button type="button" className={"pj-star" + (starred ? " on" : "")} onClick={() => onStar(p.id)}
        aria-label={(starred ? "Unpin " : "Pin ") + p.name} title={starred ? "Unpin" : "Pin"}>
        <StarIco on={starred} />
      </button>
    </article>
  );
}

/* ---------- new project modal ---------- */
function keyFromName(name) {
  const w = (name || "").trim().toUpperCase().replace(/[^A-Z ]/g, "");
  if (!w) return "";
  const parts = w.split(/\s+/);
  return (parts.length > 1 ? parts.map((x) => x[0]).join("") : w.slice(0, 3)).slice(0, 4);
}

function NewProjectModal({ connections, onClose, onCreate }) {
  const [name, setName] = useStateH("");
  const [key, setKey] = useStateH("");
  const [keyTouched, setKeyTouched] = useStateH(false);
  const [repo, setRepo] = useStateH("");
  const [template, setTemplate] = useStateH("governed");
  const [policy, setPolicy] = useStateH("balanced");
  const [connId, setConnId] = useStateH(() => ((connections.find((c) => c.def) || connections[0] || {}).id));
  const conn = connections.find((c) => c.id === connId) || connections[0] || { owner: "github", method: "" };
  const nameRef = useRefH(null);
  useEffectH(() => { nameRef.current && nameRef.current.focus(); }, []);

  const effKey = keyTouched ? key : keyFromName(name);
  const effRepo = repo || (name || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const ok = name.trim().length > 1 && effKey.length >= 2 && connections.length > 0;

  const submit = () => {
    if (!ok) return;
    onCreate({ name: name.trim(), key: effKey, repo: conn.owner + "/" + (effRepo || "new-project"), connection: conn.id, template, policy });
  };

  return (
    <React.Fragment>
      <div className="confirm-scrim" onClick={onClose}></div>
      <div className="modal-card" role="dialog" aria-modal="true" aria-label="New project" data-screen-label="New project modal">
        <div className="modal-head">
          <span className="pj-mark" style={{ boxShadow: "inset 0 -8px 0 color-mix(in srgb, var(--blue), transparent 55%)" }}>{(name.trim()[0] || "•").toUpperCase()}</span>
          <span className="mh-main">
            <h2>New governed project</h2>
            <div className="mh-sub">One board, one repo, agents under policy from day one</div>
          </span>
          <button type="button" className="icon-btn modal-close" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
        </div>
        <div className="modal-body">
          <div className="key-row">
            <div className="field">
              <label className="flabel" htmlFor="np-name">Project name<span className="req">*</span></label>
              <input id="np-name" type="text" ref={nameRef} value={name} placeholder="e.g. Payments Gateway"
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") submit(); }} />
            </div>
            <div className="field">
              <label className="flabel" htmlFor="np-key">Task key</label>
              <input id="np-key" type="text" className="mono" value={effKey} placeholder="PAY"
                onChange={(e) => { setKeyTouched(true); setKey(e.target.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4)); }} />
            </div>
          </div>
          <div className="field">
            <span className="flabel">GitHub connection <span className="fhint">sets the repository root</span></span>
            <div className="pick-chips">
              {connections.map((c) => (
                <button type="button" key={c.id} className={"pick-chip" + (connId === c.id ? " on" : "")} onClick={() => setConnId(c.id)}>
                  <Icon name="github" />{c.owner}/
                </button>
              ))}
            </div>
            {connections.length === 0 && (
              <div className="def-note"><Icon name="alert" /><span>No GitHub connections. Add one in <b>Viberr settings → GitHub connections</b> first.</span></div>
            )}
          </div>
          <div className="field">
            <label className="flabel" htmlFor="np-repo">GitHub repository <span className="fhint">project default · task-level override later</span></label>
            <div className="repo-input">
              <span className="pre">{conn.owner}/</span>
              <input id="np-repo" type="text" value={repo} placeholder={effRepo || "repo-name"} onChange={(e) => setRepo(e.target.value)} />
            </div>
          </div>
          <div className="field">
            <span className="flabel">Workflow template</span>
            <div className="pick-chips">
              <button type="button" className={"pick-chip" + (template === "governed" ? " on" : "")} onClick={() => setTemplate("governed")}>
                <span className="sdot" style={{ background: "var(--blue)" }}></span>Governed default · 5 stages
              </button>
              <button type="button" className={"pick-chip" + (template === "light" ? " on" : "")} onClick={() => setTemplate("light")}>
                <span className="sdot" style={{ background: "var(--teal-dark)" }}></span>Lightweight · 3 stages
              </button>
            </div>
          </div>
          <div className="field">
            <span className="flabel">Agent policy preset</span>
            <div className="pick-chips">
              <button type="button" className={"pick-chip" + (policy === "strict" ? " on" : "")} onClick={() => setPolicy("strict")}><Icon name="lock" />Strict human-gate</button>
              <button type="button" className={"pick-chip" + (policy === "balanced" ? " on" : "")} onClick={() => setPolicy("balanced")}><Icon name="shield" />Balanced · recommended</button>
              <button type="button" className={"pick-chip" + (policy === "auto" ? " on" : "")} onClick={() => setPolicy("auto")}><Icon name="bolt" />Autonomous within policy</button>
            </div>
            <div className="def-note">
              <Icon name="shield" />
              <span>Completion stays human-authorized in every preset. Stages, RBAC and the agent capability matrix can be refined in project settings.</span>
            </div>
          </div>
        </div>
        <div className="modal-foot">
          <span className="foot-hint mono">creates ~/viberr/projects/{effKey || "KEY"}/</span>
          <span className="foot-actions">
            <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
            <button type="button" className="btn primary" disabled={!ok} style={!ok ? { opacity: 0.55, pointerEvents: "none" } : null} onClick={submit}>
              <Icon name="plus" />Create project
            </button>
          </span>
        </div>
      </div>
    </React.Fragment>
  );
}

/* ---------- page ---------- */
const ACCENTS = ["#5b76fe", "#187574", "#e8a800", "#c2602e", "#7b61ff", "#00b473"];

function HomeApp() {
  const saved = loadHomeState();
  const t = { density: "comfortable", descriptions: true, emptyPreview: false };
  const [view, setViewRaw] = useStateH(saved.view || "grid");
  const setView = (v) => { setViewRaw(v); saveHomeState({ view: v }); };
  const [stars, setStarsRaw] = useStateH(() => {
    const base = {}; HOME.projects.forEach((p) => { base[p.id] = p.starred; });
    return { ...base, ...(saved.stars || {}) };
  });
  const [created, setCreatedRaw] = useStateH(saved.created || []);
  const [org, setOrgRaw] = useStateH(() => loadOrg());
  const patchOrg = (patch) => setOrgRaw((o) => { const n = { ...o, ...patch }; saveOrg(n); return n; });
  const parseRoute = () => {
    const h = location.hash || "";
    const m = h.match(/^#settings(?:\/(connections|users|resources))?$/);
    return m ? { page: "settings", tab: m[1] || "connections" } : { page: "projects", tab: "connections" };
  };
  const [route, setRoute] = useStateH(parseRoute);
  const [overlay, setOverlay] = useStateH(() => ((/^#(profile|notifications)$/.exec(location.hash) || [])[1] || null));
  const closeOverlay = () => {
    setOverlay(null);
    if (/^#(profile|notifications)$/.test(location.hash)) history.replaceState(null, "", location.pathname + location.search);
  };
  useEffectH(() => {
    const f = () => setRoute(parseRoute());
    window.addEventListener("hashchange", f);
    return () => window.removeEventListener("hashchange", f);
  }, []);
  const goSettings = (tab) => { location.hash = "settings/" + tab; };
  const goProjects = () => { location.hash = ""; };
  const [query, setQuery] = useStateH("");
  const [modal, setModal] = useStateH(false);
  const [menu, setMenu] = useStateH(false);
  const [scanning, setScanning] = useStateH(false);
  const [theme, setThemeRaw] = useStateH(window.VIBERR.prefs.theme);
  const setTheme = (v) => { setThemeRaw(v); window.VIBERR.savePrefs({ theme: v }); };
  const { toasts, push } = useToasts();
  const searchRef = useRefH(null);
  const me = window.VIBERR.people.ARDA;
  const [meProf, setMeProf] = useStateH({ name: "Arda Kaya", title: "Senior engineer" });
  const [notifs, setNotifs] = useStateH(() => window.VIBERR.notifications.map((n) => ({ ...n })));
  const [bell, setBell] = useStateH(false);
  const unread = notifs.filter((n) => n.unread).length;
  const markRead = (ids) => {
    setNotifs((ns) => ns.map((n) => (ids.includes(n.id) ? { ...n, unread: false } : n)));
    window.VIBERR.markNotifsRead && window.VIBERR.markNotifsRead(ids);
  };
  const goTask = (key) => {
    const n = notifs.find((x) => x.task === key) || {};
    if ((n.project || "Viberr Core") !== "Viberr Core") { push((n.project || "That project") + " — that workspace isn't built in this prototype"); return; }
    location.href = WORKSPACE + "#task/" + key;
  };
  const openNotif = (n) => {
    markRead([n.id]);
    goTask(n.task);
  };

  useEffectH(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); searchRef.current && searchRef.current.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const all = useMemoH(() => {
    const list = [...created, ...HOME.projects];
    return list.map((p, i) => ({ ...p, accent: p.accent || ACCENTS[i % ACCENTS.length] }));
  }, [created]);

  const filtered = t.emptyPreview ? [] : all.filter((p) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return (p.name + " " + p.key + " " + p.repo).toLowerCase().includes(q);
  });
  const pinned = filtered.filter((p) => stars[p.id]);
  const rest = filtered.filter((p) => !stars[p.id]);

  const toggleStar = (id) => {
    setStarsRaw((s) => {
      const next = { ...s, [id]: !s[id] };
      saveHomeState({ stars: next });
      push(next[id] ? "Pinned — it will stay at the top" : "Unpinned");
      return next;
    });
  };

  const createProject = (spec) => {
    const proj = {
      id: spec.key.toLowerCase() + "-" + Date.now().toString(36),
      name: spec.name, key: spec.key, repo: spec.repo,
      desc: (spec.template === "light" ? "Lightweight 3-stage workflow" : "Governed 5-stage workflow") +
        " · " + (spec.policy === "strict" ? "strict human-gate policy." : spec.policy === "auto" ? "agents act within policy." : "balanced agent policy."),
      dist: {}, running: 0, waiting: 0,
      members: [me], updated: "just now", accent: "#5b76fe",
    };
    setCreatedRaw((c) => {
      const next = [proj, ...c];
      saveHomeState({ created: next });
      return next;
    });
    setModal(false);
    push(spec.key + " initialized — task store created at ~/viberr/projects/" + spec.key);
  };

  const rescan = () => {
    if (scanning) return;
    setScanning(true);
    setTimeout(() => { setScanning(false); push("Store re-scanned — " + all.length + " project dirs, no drift found"); }, 1200);
  };

  const totalRunning = all.reduce((a, p) => a + p.running, 0);
  const totalWaiting = all.reduce((a, p) => a + p.waiting, 0);
  const activeIn = all.filter((p) => p.running > 0).length;
  const hour = new Date().getHours();
  const greet = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const sessName = (((window.VIBERR.session.get() || {}).name) || "Arda Kaya").split(" ")[0];

  const renderGroup = (list) =>
    view === "grid"
      ? <div className="pj-grid">{list.map((p) => <ProjectCard key={p.id} p={p} starred={!!stars[p.id]} onStar={toggleStar} showDesc={t.descriptions} />)}</div>
      : <div className="pj-list">{list.map((p) => <ProjectRow key={p.id} p={p} starred={!!stars[p.id]} onStar={toggleStar} />)}</div>;

  return (
    <div className="home" data-density={t.density} data-screen-label="Home — project selection">
      <header className="home-top">
        <div className="home-top-in">
          <button type="button" className="home-brand" onClick={() => { goProjects(); window.scrollTo({ top: 0 }); }} title="Viberr">
            <span className="mark">V</span>
            <b>Viberr</b>
          </button>
          <div className="top-search" style={{ marginLeft: "auto" }}>
            <Icon name="search" />
            <input ref={searchRef} placeholder="Find a project…" aria-label="Find a project"
              value={query} onChange={(e) => { setQuery(e.target.value); if (route.page !== "projects") goProjects(); }} />
            <span className="kbd">⌘K</span>
          </div>
          <div className="home-user-wrap">
            {bell && (
              <React.Fragment>
                <div className="menu-scrim" onClick={() => setBell(false)}></div>
                <div className="ntf-pop" role="dialog" aria-label="Notifications" data-screen-label="Notifications popover">
                  <div className="ntf-pop-head">
                    <h3>Notifications</h3>
                    <span className="ct mono">{unread > 0 ? unread + " unread" : "caught up"}</span>
                    {unread > 0 && <button type="button" className="btn ghost sm" onClick={() => { markRead(notifs.map((n) => n.id)); push("All notifications marked read"); }}>Mark all read</button>}
                  </div>
                  <div className="ntf-pop-list">
                    {notifs.map((n) => {
                      const m = homeNtfMeta(n);
                      return (
                        <button type="button" key={n.id} className={"ntf-item" + (n.unread ? "" : " read")} onClick={() => openNotif(n)}>
                          <span className={"pev-ico " + m.cls}><Icon name={m.icon} /></span>
                          <span className="ntf-item-main">
                            <span className="tt">{n.title || plainTxt(n.text)}</span>
                            {n.title && <span className="tx">{plainTxt(n.text)}</span>}
                            <span className="mt">{(n.project || "Viberr Core") + " · " + n.task + " · " + (n.day === "Today" ? n.t : ((n.day || "") + " " + n.t).trim())}</span>
                          </span>
                          {n.unread && <span className="unread-dot"></span>}
                        </button>
                      );
                    })}
                  </div>
                  <div className="ntf-pop-foot">
                    <button type="button" className="btn ghost sm" onClick={() => { setBell(false); setOverlay("notifications"); }}>See all<Icon name="arrow" /></button>
                  </div>
                </div>
              </React.Fragment>
            )}
            <button type="button" className="icon-btn bell-btn" aria-label={"Notifications" + (unread ? " — " + unread + " unread" : "")}
              aria-haspopup="dialog" aria-expanded={bell} onClick={() => setBell((b) => !b)}>
              <Icon name="bell" />
              {unread > 0 && <span className="bell-badge">{unread}</span>}
            </button>
          </div>
          <div className="home-user-wrap">
            {menu && (
              <React.Fragment>
                <div className="menu-scrim" onClick={() => setMenu(false)}></div>
                <div className="user-menu from-top" role="menu">
                  <div className="user-menu-head">
                    <Avatar person={me} lg />
                    <span>
                      <div className="who">{me.name}</div>
                      <div className="role">arda@viberr.dev</div>
                    </span>
                  </div>
                  <button type="button" className="menu-item" role="menuitem" onClick={() => { setMenu(false); setOverlay("profile"); }}>
                    <Icon name="user" />Profile &amp; preferences
                  </button>
                  <button type="button" className="menu-item" role="menuitem" onClick={() => { setTheme(theme === "light" ? "dark" : theme === "dark" ? "system" : "light"); }}>
                    <Icon name="sparkle" />Theme · <span style={{ color: "var(--faint)" }}>{theme === "system" ? "System" : theme === "dark" ? "Dark" : "Light"}</span>
                  </button>
                  <div className="menu-sep"></div>
                  <button type="button" className="menu-item danger" role="menuitem" onClick={() => { window.VIBERR.session.clear(); location.href = "Viberr Login.html"; }}><Icon name="ext" />Sign out</button>
                </div>
              </React.Fragment>
            )}
            <button type="button" className={"home-user" + (menu ? " open" : "")} onClick={() => setMenu((m) => !m)} aria-haspopup="menu" aria-expanded={menu} aria-label="Account menu">
              <Avatar person={me} lg />
            </button>
          </div>
        </div>
      </header>

      {route.page === "settings" ? (
        <OrgSettings tab={route.tab} onTab={goSettings} onBack={goProjects} org={org} patchOrg={patchOrg} push={push} />
      ) : (
      <main className="home-shell">
        <div className="home-hero">
          <div>
            <h1>{greet}, {sessName}</h1>
            <p className="sub">
              {t.emptyPreview
                ? "No projects yet — create your first governed project below."
                : <React.Fragment>
                    Your agents kept working — <b><span className="working"></span>{totalRunning} runs active</b> across {activeIn} projects,{" "}
                    <b>{totalWaiting} decisions</b> waiting on you.
                  </React.Fragment>}
            </p>
          </div>
          <div className="hero-actions">
            <div className="seg" role="group" aria-label="View">
              <button type="button" className={view === "grid" ? "on" : ""} onClick={() => setView("grid")}><Icon name="board" />Grid</button>
              <button type="button" className={view === "list" ? "on" : ""} onClick={() => setView("list")}><Icon name="review" />List</button>
            </div>
            <button type="button" className="btn primary" onClick={() => setModal(true)}><Icon name="plus" />New project</button>
          </div>
        </div>

        {t.emptyPreview ? (
          <div className="empty-hero" data-screen-label="Empty state">
            <span className="plus"><Icon name="plus" /></span>
            <h2>Create your first governed project</h2>
            <p>A project is one board, one repo, and a policy that decides what agents may do on their own — and what waits for you.</p>
            <div className="empty-steps">
              <span className="st"><span className="n">1</span>Connect a repository</span>
              <span className="st"><span className="n">2</span>Define workflow stages</span>
              <span className="st"><span className="n">3</span>Put agents under policy</span>
            </div>
            <button type="button" className="btn primary" onClick={() => setModal(true)}><Icon name="plus" />New project</button>
          </div>
        ) : (
          <React.Fragment>
            {pinned.length > 0 && (
              <section data-screen-label="Pinned projects">
                <div className="sec-h"><StarIco on /><h2>Pinned</h2><span className="ct">{pinned.length}</span></div>
                {renderGroup(pinned)}
              </section>
            )}
            <section data-screen-label="All projects">
              <div className="sec-h">
                <Icon name="board" /><h2>{pinned.length > 0 ? "Everything else" : "All projects"}</h2><span className="ct">{rest.length}</span>
              </div>
              {rest.length === 0 && query
                ? <div className="empty">No project matches “{query}”.</div>
                : (
                  view === "grid"
                    ? <div className="pj-grid">
                        {rest.map((p) => <ProjectCard key={p.id} p={p} starred={!!stars[p.id]} onStar={toggleStar} showDesc={t.descriptions} />)}
                        {!query && (
                          <button type="button" className="pj-new" onClick={() => setModal(true)}>
                            <span className="plus"><Icon name="plus" /></span>
                            New project
                          </button>
                        )}
                      </div>
                    : <React.Fragment>
                        <div className="pj-list">{rest.map((p) => <ProjectRow key={p.id} p={p} starred={!!stars[p.id]} onStar={toggleStar} />)}</div>
                        {!query && (
                          <button type="button" className="pj-new" style={{ minHeight: 0, padding: ".7rem", marginTop: ".5rem" }} onClick={() => setModal(true)}>
                            <span style={{ display: "inline-flex", alignItems: "center", gap: ".45rem" }}><Icon name="plus" />New project</span>
                          </button>
                        )}
                      </React.Fragment>
                )}
            </section>
          </React.Fragment>
        )}

        <section className="panel" data-screen-label="Settings">
          <div className="panel-head">
            <Icon name="sliders" />
            <h2>Settings</h2>
          </div>
          <div className="org-tiles">
            <button type="button" className="org-tile go" onClick={() => goSettings("connections")}>
              <span className="lbl"><Icon name="github" />GitHub connections</span>
              <span className="val">
                <span>
                  <span className="nm">{org.connections.length} connection{org.connections.length === 1 ? "" : "s"}</span>
                  <div className="sub">{org.connections.map((c) => c.owner).join(" · ") || "none connected"}</div>
                </span>
              </span>
              <span className="foot go-hint">Manage<Icon name="arrow" /></span>
            </button>
            <button type="button" className="org-tile go" onClick={() => goSettings("users")}>
              <span className="lbl"><Icon name="user" />Users &amp; access</span>
              <span className="val">
                <MemberStack members={org.users.slice(0, 5)} />
                <span>
                  <span className="nm">{org.users.length} user{org.users.length === 1 ? "" : "s"}</span>
                  <div className="sub">{org.users.filter((u) => u.role === "admin").length} admins · {org.users.filter((u) => u.role !== "admin").length} members</div>
                </span>
              </span>
              <span className="foot go-hint">Manage<Icon name="arrow" /></span>
            </button>
            <button type="button" className="org-tile go" onClick={() => goSettings("resources")}>
              <span className="lbl"><Icon name="memory" />Agent resources</span>
              <span className="val">
                <span className="glyphs"><AgentGlyph backend="codex" /><AgentGlyph backend="claude" /></span>
                <span>
                  <span className="nm">{org.gagents.length} global agents</span>
                  <div className="sub">{org.kbs.length} knowledge bases · {org.mcps.length} MCP · {org.skills.length} skills</div>
                </span>
              </span>
              <span className="foot go-hint">Manage<Icon name="arrow" /></span>
            </button>
          </div>
        </section>

        <footer className="store-strip" data-screen-label="Store strip">
          <button type="button" className="btn ghost sm" onClick={rescan}>
            <Icon name="refresh" className={scanning ? "spin" : ""} />{scanning ? "Scanning…" : "Re-scan"}
          </button>
        </footer>
      </main>
      )}

      {modal && <NewProjectModal connections={org.connections} onClose={() => setModal(false)} onCreate={createProject} />}
      {overlay === "profile" && (
        <PageOverlay label="Profile & preferences" onClose={closeOverlay}>
          <Profile me={meProf} setMe={setMeProf} theme={theme} setTheme={setTheme}
            onNav={(v) => { location.href = WORKSPACE + "#" + v; }} push={push} />
        </PageOverlay>
      )}
      {overlay === "notifications" && (
        <PageOverlay label="Notifications" onClose={closeOverlay}>
          <Notifications items={notifs} onRead={(id) => markRead([id])}
            onReadAll={() => { markRead(notifs.map((n) => n.id)); push("All notifications marked read"); }}
            onOpen={goTask} onNav={() => {}} />
        </PageOverlay>
      )}
      <ToastHost toasts={toasts} />
    </div>
  );
}

if (!window.VIBERR.session.get()) {
  location.replace("Viberr Login.html");
} else {
  ReactDOM.createRoot(document.getElementById("root")).render(<HomeApp />);
}
