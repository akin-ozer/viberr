/* Viberr — app root */
const { useState: useStateA, useMemo: useMemoA } = React;

const NAV = [
  { id: "board", label: "Board", icon: "board" },
  { id: "review", label: "Review queue", icon: "inbox" },
  { id: "agents", label: "Agents", icon: "agents" },
  { id: "policy", label: "Policy", icon: "shield" },
  { id: "github", label: "GitHub", icon: "github" },
  { id: "activity", label: "Activity", icon: "activity" },
  { id: "settings", label: "Settings", icon: "sliders" },
];

function Rail({ view, onNav, tasks, violations, membersCount }) {
  const counts = {
    board: tasks.length,
    review: tasks.filter((t) => t.stage === "review").length,
  };
  return (
    <nav className="rail" aria-label="Primary">
      <button type="button" className="project-switch" onClick={() => { location.href = "Viberr Home.html"; }} title="All projects">
        <span>
          <div className="pj-name">Viberr Core</div>
          <div className="pj-meta">akin-ozer/viberr · {membersCount} members</div>
        </span>
        <Icon name="chevron" />
      </button>

      <div className="rail-label">Workspace</div>
      {NAV.map((n) => (
        <button type="button" key={n.id} className={"nav-item" + (view === n.id ? " active" : "")} onClick={() => onNav(n.id)}>
          <Icon name={n.icon} className="ico" />
          {n.label}
          {n.id === "board" && <span className="count">{counts.board}</span>}
          {n.id === "review" && <span className="count">{counts.review}</span>}
          {n.id === "settings" && violations > 0 && <span className="count" style={{ color: "var(--coral-dark)", fontWeight: 700 }}>{violations}</span>}
        </button>
      ))}

      <div className="rail-spacer" />
    </nav>
  );
}

function TopUser({ me, theme, onTheme, onNav, onProfile, unread }) {
  const [menu, setMenu] = useStateA(false);
  return (
    <div className="home-user-wrap">
      {menu && (
        <React.Fragment>
          <div className="menu-scrim" onClick={() => setMenu(false)} />
          <div className="user-menu from-top" role="menu">
            <div className="user-menu-head">
              <Avatar person={{ ...window.VIBERR.people.ARDA, initials: initialsOf(me.name) }} lg />
              <span>
                <div className="who">{me.name}</div>
                <div className="role">arda@viberr.dev</div>
              </span>
            </div>
            <button type="button" className="menu-item" role="menuitem" onClick={() => { setMenu(false); onProfile(); }}><Icon name="user" />Profile &amp; preferences</button>
            <button type="button" className="menu-item" role="menuitem" onClick={() => { setMenu(false); location.href = "Viberr Home.html"; }}><Icon name="board" />Switch project</button>
            <button type="button" className="menu-item" role="menuitem" onClick={() => onTheme(theme === "light" ? "dark" : theme === "dark" ? "system" : "light")}><Icon name="sparkle" />Theme · <span style={{ color: "var(--faint)" }}>{theme === "system" ? "System" : theme === "dark" ? "Dark" : "Light"}</span></button>
            <div className="menu-sep" />
            <button type="button" className="menu-item danger" role="menuitem" onClick={() => { window.VIBERR.session.clear(); location.href = "Viberr Login.html"; }}><Icon name="ext" />Sign out</button>
          </div>
        </React.Fragment>
      )}
      <button type="button" className={"home-user" + (menu ? " open" : "")} onClick={() => setMenu((m) => !m)} aria-haspopup="menu" aria-expanded={menu} aria-label="Account menu">
        <Avatar person={{ ...window.VIBERR.people.ARDA, initials: initialsOf(me.name) }} lg />
      </button>
    </div>
  );
}

function TopBell({ notifs, unread, onRead, onReadAll, onOpenTask, onSeeAll, push }) {
  const [open, setOpen] = useStateA(false);
  const meta = (n) =>
    n.kind === "packet" ? (n.ptype === "blocked" ? { icon: "alert", cls: "act-blocked" } : { icon: "check", cls: "act-completion" })
    : n.kind === "approval" ? { icon: "arrow", cls: "act-transition" }
    : n.kind === "mention" ? { icon: "message", cls: "act-comment" }
    : n.kind === "quality" ? { icon: "flag", cls: "act-quality" }
    : { icon: "alert", cls: "act-policy" };
  const plain = (s) => (s || "").replace(/\*\*/g, "").replace(/`/g, "");
  return (
    <div className="home-user-wrap">
      {open && (
        <React.Fragment>
          <div className="menu-scrim" onClick={() => setOpen(false)} />
          <div className="ntf-pop" role="dialog" aria-label="Notifications" data-screen-label="Notifications popover">
            <div className="ntf-pop-head">
              <h3>Notifications</h3>
              <span className="ct mono">{unread > 0 ? unread + " unread" : "caught up"}</span>
              {unread > 0 && <button type="button" className="btn ghost sm" onClick={onReadAll}>Mark all read</button>}
            </div>
            <div className="ntf-pop-list">
              {notifs.map((n) => {
                const m = meta(n);
                return (
                  <button type="button" key={n.id} className={"ntf-item" + (n.unread ? "" : " read")}
                    onClick={() => {
                      onRead(n.id); setOpen(false);
                      if ((n.project || "Viberr Core") !== "Viberr Core") { push(n.project + " — that workspace isn't built in this prototype"); return; }
                      onOpenTask(n.task);
                    }}>
                    <span className={"pev-ico " + m.cls}><Icon name={m.icon} /></span>
                    <span className="ntf-item-main">
                      <span className="tt">{n.title || plain(n.text)}</span>
                      {n.title && <span className="tx">{plain(n.text)}</span>}
                      <span className="mt">{(n.project || "Viberr Core") + " · " + n.task + " · " + (n.day === "Today" ? n.t : ((n.day || "") + " " + n.t).trim())}</span>
                    </span>
                    {n.unread && <span className="unread-dot"></span>}
                  </button>
                );
              })}
            </div>
            <div className="ntf-pop-foot">
              <button type="button" className="btn ghost sm" onClick={() => { setOpen(false); onSeeAll(); }}>See all<Icon name="arrow" /></button>
            </div>
          </div>
        </React.Fragment>
      )}
      <button type="button" className="icon-btn bell-btn" aria-label={"Notifications" + (unread > 0 ? " — " + unread + " unread" : "")}
        aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((b) => !b)}>
        <Icon name="bell" />
        {unread > 0 && <span className="bell-badge">{unread}</span>}
      </button>
    </div>
  );
}

function App() {
  const base = window.VIBERR.tasks;
  const initialView = ((location.hash || "").match(/^#(board|review|agents|policy|github|activity|settings)$/) || [])[1] || "board";
  const initialTask = ((location.hash || "").match(/^#task\/([A-Za-z]+-\d+)$/) || [])[1] || null;
  const [view, setView] = useStateA(initialView);
  const [openKey, setOpenKey] = useStateA(initialTask);
  const [stages, setStagesRaw] = useStateA(window.VIBERR.stages);
  const setStages = (next) => { window.VIBERR.stages = next; setStagesRaw(next); };
  const [members, setMembersRaw] = useStateA(window.VIBERR.policy.members);
  const setMembers = (next) => { window.VIBERR.policy.members = next; setMembersRaw(next); };
  const [created, setCreated] = useStateA([]); // tasks created in-session (FR11)
  const [overrides, setOverrides] = useStateA({}); // key -> partial task changes
  const [extra, setExtra] = useStateA({}); // key -> prepended events
  const [scopeGranted, setScopeGranted] = useStateA(false); // credential policy fix (wired to VIB-142)
  const [ask, setAsk] = useStateA(0); // "Ask operator" -> focus the composer
  const [overlay, setOverlay] = useStateA(null); // "profile" | "notifications" popup pages
  const { toasts, push } = useToasts();
  const [me, setMe] = useStateA({ name: "Arda Kaya", title: "Senior engineer" });
  const [theme, setThemeRaw] = useStateA(window.VIBERR.prefs.theme);
  const setTheme = (v) => { setThemeRaw(v); window.VIBERR.savePrefs({ theme: v }); };
  const [notifs, setNotifs] = useStateA(window.VIBERR.notifications);
  const unread = notifs.filter((n) => n.unread).length;
  const readNotif = (id) => { setNotifs((ns) => ns.map((n) => (n.id === id ? { ...n, unread: false } : n))); window.VIBERR.markNotifsRead && window.VIBERR.markNotifsRead([id]); };

  const tasks = useMemoA(
    () => [...base, ...created].map((t) => ({ ...t, ...(overrides[t.key] || {}) })),
    [base, created, overrides]
  );
  const open = openKey ? tasks.find((t) => t.key === openKey) : null;
  const myRole = ((members.find((m) => m.p.name === me.name) || {}).role) || "viewer";

  const goBoard = () => { setOpenKey(null); setView("board"); };
  const goView = (v) => { setView(v); setOpenKey(null); };

  const addEvent = (key, ev) => setExtra((e) => ({ ...e, [key]: [ev, ...(e[key] || [])] }));

  const onComment = (text) => {
    const toAgent = /@(agent|operator|codex|claude)\b/i.test(text);
    addEvent(open.key, { type: "comment", actor: window.VIBERR.people.ARDA, t: "now", text, to: toAgent ? "agent" : null });
    push(toAgent ? "Comment posted · routed to mentioned agent" : "Comment posted");
  };

  const onOwnerAction = (action, person) => {
    const K = open.key;
    const P = window.VIBERR.people;
    if (action === "release") {
      const cur = open.owner;
      const forced = cur && cur.name !== me.name;
      setOverrides((o) => ({ ...o, [K]: { ...(o[K] || {}), owner: null } }));
      addEvent(K, { type: "assign", actor: P.ARDA, t: "now", text: forced
        ? "Released **" + cur.name + "** from task ownership (admin) — the seat is open to any project member."
        : "Released task ownership — review & acceptance stall until another member takes the seat." });
      push(forced ? cur.name.split(" ")[0] + " released from " + K + " · admin action" : "Ownership released on " + K);
      return;
    }
    if (action === "assign" && person) {
      setOverrides((o) => ({ ...o, [K]: { ...(o[K] || {}), owner: person } }));
      addEvent(K, { type: "assign", actor: P.ARDA, t: "now", text: "Handed task ownership to **" + person.name + "** — they hold review & acceptance for this task now." });
      push("Ownership handed to " + person.name.split(" ")[0]);
      return;
    }
    const cur = open.owner;
    const patch = { owner: P.ARDA };
    addEvent(K, { type: "assign", actor: P.ARDA, t: "now", text: cur
      ? "Took over task ownership from **" + cur.name + "** — owner is the human reviewer and acceptance authority."
      : "Took task ownership — owner is the human reviewer and acceptance authority for this task." });
    if (K === "VIB-148") {
      patch.readiness = "ready";
      patch.waiting = "agent";
      addEvent(K, { type: "agent", actor: { name: "Operator", kind: "agent" }, t: "now", text: "Acceptance boundary now owned by **Arda Kaya** — scheduling execution against the quality-gated scope." });
    }
    setOverrides((o) => ({ ...o, [K]: { ...(o[K] || {}), ...patch } }));
    push("You own " + K + " · review & acceptance");
  };

  const createTask = ({ title, goal, stage }) => {
    const n = Math.max(...[...base, ...created].map((t) => parseInt(t.key.slice(4), 10))) + 1;
    const key = "VIB-" + n;
    const sName = (window.VIBERR.stages.find((s) => s.id === stage) || {}).name || stage;
    setCreated((c) => [...c, {
      key, title,
      goal: goal || "Goal to be refined at the triage quality gate.",
      stage, readiness: "input",
      specialist: null,
      owner: null,
      operator: stage === "triage" ? null : { name: "Operator", since: "stage 1" },
      consultants: [], waiting: "human", urgent: false, validation: "none",
      branch: null, repo: "akin-ozer/viberr", pr: null, timeline: [],
    }]);
    push(key + " created in " + sName + " — its task.md is in the store");
  };

  const onResolve = ({ option }) => {
    const K = open.key;
    const choice = option.t;
    setNotifs((ns) => ns.map((n) => (n.task === K && (n.kind === "packet" || n.kind === "approval") ? { ...n, unread: false } : n)));
    window.VIBERR.markNotifsRead && window.VIBERR.markNotifsRead(notifs.filter((n) => n.task === K && (n.kind === "packet" || n.kind === "approval")).map((n) => n.id));

    if (choice === "Block on policy") {
      addEvent(K, { type: "blocked", actor: window.VIBERR.people.ARDA, t: "now", text: "**Decision:** hold on policy. " + K + " stays blocked until the project credential policy is updated." });
      setOverrides((o) => ({ ...o, [K]: { ...(o[K] || {}), readiness: "blocked", waiting: "human" } }));
      setOpenKey(null);
      setView("settings");
      push("Task held on policy · opening repository settings");
      return;
    }
    if (choice === "Hold for runtime debug") {
      addEvent(K, { type: "blocked", actor: window.VIBERR.people.ARDA, t: "now", text: "**Decision:** hold for runtime debug. " + K + " stays blocked while the provider-native session is inspected — findings come back as task comments." });
      setOverrides((o) => ({ ...o, [K]: { ...(o[K] || {}), readiness: "blocked" } }));
      push("Held for runtime debug — the session is recorded per audit policy");
      return;
    }
    if (option.accept) {
      addEvent(K, { type: "completion", actor: window.VIBERR.people.ARDA, t: "now", title: "Completion accepted", text: "Human acceptance recorded. Task transitioned to **Done** and review PR approved for merge." });
      setOverrides((o) => ({ ...o, [K]: { ...(o[K] || {}), stage: "done", readiness: "done", waiting: "none", packet: null, pr: open.pr ? { ...open.pr, state: "merged" } : open.pr } }));
      push("Completion accepted · " + K + " moved to Done");
      return;
    }
    addEvent(K, { type: "transition", actor: window.VIBERR.people.ARDA, t: "now", text: option.ev || ("**Decision:** " + choice + ". Operator re-engages the specialist with a summon note.") });
    setOverrides((o) => ({ ...o, [K]: { ...(o[K] || {}), waiting: "agent", readiness: "ready", packet: null } }));
    push("Decision recorded: " + choice);
  };

  const grantScope = () => {
    setScopeGranted(true);
    addEvent("VIB-142", { type: "policy", actor: { name: "Policy engine", kind: "system" }, t: "now", text: "**Policy update:** `pull_request:write` granted on the project credential. The earlier violation is resolved — PR auto-sync will work after merge." });
    push("Scope granted · VIB-142 policy flag resolved");
  };

  return (
    <div className="app">
      <Rail view={view} onNav={goView} tasks={tasks} violations={scopeGranted ? 0 : 1} membersCount={members.length} />
      <div className="main">
        <div className="topbar">
          <button type="button" className="home-brand" onClick={() => { location.href = "Viberr Home.html"; }} title="Home — all projects">
            <span className="mark">V</span>
            <b>Viberr</b>
          </button>
          <div className="crumbs">
            <button type="button" className="crumb-root" onClick={goBoard}>Viberr Core</button>
            <span className="sep sep-root"><Icon name="chevron" /></span>
            {open
              ? <React.Fragment><button type="button" className="crumb-mid" onClick={goBoard}>Board</button><span className="sep sep-mid"><Icon name="chevron" /></span><span className="cur" title={open.key + " · " + open.title}>{open.key} · {open.title}</span></React.Fragment>
              : <span className="cur">{view === "notifications" ? "Notifications" : (NAV.find((n) => n.id === view) || {}).label}</span>}
          </div>
          <div className="top-search">
            <Icon name="search" />
            <input placeholder="Search tasks, branches, agents…" aria-label="Search tasks, branches, agents" />
            <span className="kbd">⌘K</span>
          </div>
          <TopBell notifs={notifs} unread={unread} onRead={readNotif}
            onReadAll={() => { setNotifs((ns) => ns.map((n) => ({ ...n, unread: false }))); window.VIBERR.markNotifsRead && window.VIBERR.markNotifsRead(notifs.map((n) => n.id)); push("All notifications marked read"); }}
            onOpenTask={(k) => { setView("board"); setOpenKey(k); }} onSeeAll={() => setOverlay("notifications")} push={push} />
          <TopUser me={me} theme={theme} onTheme={(v) => { setTheme(v); push("Theme · " + (v === "system" ? "System (follows your OS)" : v === "dark" ? "Dark" : "Light")); }} onNav={goView} onProfile={() => setOverlay("profile")} unread={unread} />
        </div>

        {open
          ? <TaskDetail task={open} extraEvents={extra[open.key]} onComment={onComment} onResolve={onResolve}
              onAsk={() => setAsk((a) => a + 1)} ask={ask} push={push} me={me} myRole={myRole} onOwner={onOwnerAction}
              onPolicy={() => { setOpenKey(null); setView("policy"); }} />
          : view === "board"
            ? <Board tasks={tasks} onOpen={(k) => setOpenKey(k)} onCreate={createTask} push={push} />
            : view === "review"
              ? <ReviewQueue tasks={tasks} onOpen={(k) => setOpenKey(k)} onPolicy={() => goView("policy")} />
              : view === "agents"
                ? <Agents tasks={tasks} onOpen={(k) => setOpenKey(k)} />
                : view === "policy"
                  ? <Policy tasks={tasks} onNav={goView} push={push} />
                  : view === "github"
                    ? <GithubView tasks={tasks} onOpen={(k) => setOpenKey(k)} onNav={goView} push={push} scopeGranted={scopeGranted} />
                    : view === "activity"
                      ? <Activity tasks={tasks} extra={extra} onOpen={(k) => setOpenKey(k)} scopeGranted={scopeGranted} />
                      : <Settings tasks={tasks} stages={stages} setStages={setStages} members={members} setMembers={setMembers} onOpen={(k) => setOpenKey(k)} onNav={goView} push={push} scopeGranted={scopeGranted} onGrantScope={grantScope} />}
      </div>
      {overlay === "profile" && (
        <PageOverlay label="Profile & preferences" onClose={() => setOverlay(null)}>
          <Profile me={me} setMe={setMe} theme={theme} setTheme={setTheme} onNav={(v) => { setOverlay(null); goView(v); }} push={push} />
        </PageOverlay>
      )}
      {overlay === "notifications" && (
        <PageOverlay label="Notifications" onClose={() => setOverlay(null)}>
          <Notifications items={notifs} onRead={readNotif}
            onReadAll={() => { setNotifs((ns) => ns.map((n) => ({ ...n, unread: false }))); window.VIBERR.markNotifsRead && window.VIBERR.markNotifsRead(notifs.map((n) => n.id)); push("All notifications marked read"); }}
            onOpen={(k) => { setOverlay(null); if (tasks.some((t) => t.key === k)) { setView("board"); setOpenKey(k); } else { const n = notifs.find((x) => x.task === k) || {}; push((n.project || "That project") + " — that workspace isn't built in this prototype"); } }}
            onNav={() => {}} />
        </PageOverlay>
      )}
      <ToastHost toasts={toasts} />
    </div>
  );
}

if (!window.VIBERR.session.get()) {
  location.replace("Viberr Login.html");
} else {
  ReactDOM.createRoot(document.getElementById("root")).render(<App />);
}
