/* Viberr — Policy view: human RBAC and agent capability, managed separately (FR2, FR6–FR9) */
const { useState: useStateP, useMemo: useMemoP } = React;

const ROLE_IDS = ["admin", "maintainer", "reviewer", "viewer"];
const ROLE_LABEL = { admin: "Admin", maintainer: "Maintainer", reviewer: "Reviewer", viewer: "Viewer" };
const BOUNDARIES = [
  { id: "auto", label: "Auto-advance" },
  { id: "approval", label: "Human approval" },
  { id: "human", label: "Human only" },
];
const BCLS = { auto: "direct", approval: "recommend", human: "human" };

/* TglP moved to ui.jsx (shared by Home + workspace) */

/* ---------- Surface 1: human access ---------- */
function HumanAccess({ P, roles, setRole }) {
  const counts = useMemoP(() => {
    const c = { admin: 0, maintainer: 0, reviewer: 0, viewer: 0 };
    P.members.forEach((m) => (c[roles[m.p.name]] += 1));
    return c;
  }, [P, roles]);
  return (
    <div className="panel">
      <div className="panel-head"><Icon name="user" /><h2>Human access · RBAC</h2>
        <span className="right sub" style={{ fontSize: ".76rem", color: "var(--faint)" }}>{P.members.length} members</span>
      </div>
      <div className="pol-note"><Icon name="board" /><span>Roles decide what each member may approve, accept, and configure — enforced on every project and task action.</span></div>

      <div className="member-list">
        {P.members.map((m) => (
          <div className="member-row" key={m.p.name}>
            <Avatar person={m.p} />
            <span className="member-main">
              <div className="nm">{m.p.name}</div>
              <div className="em">{m.email}</div>
            </span>
            <div className="mini-seg" role="radiogroup" aria-label={"Role for " + m.p.name}>
              {ROLE_IDS.map((r) => (
                <button type="button" key={r} className={roles[m.p.name] === r ? "on" : ""} onClick={() => setRole(m, r)}>{ROLE_LABEL[r]}</button>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="rbac-scroll">
        <table className="rbac-table">
          <thead>
            <tr>
              <th>Action</th>
              {ROLE_IDS.map((r) => <th key={r}>{ROLE_LABEL[r]} · {counts[r]}</th>)}
            </tr>
          </thead>
          <tbody>
            {P.rbac.map((row) => (
              <tr key={row.action}>
                <td className="act">{row.action}</td>
                {ROLE_IDS.map((r) => (
                  <td key={r}>{row.grant[r] ? <span className="rbac-yes"><Icon name="check" /></span> : <span className="rbac-no">—</span>}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="pol-note" style={{ marginTop: ".85rem" }}><Icon name="message" /><span>Rules that reach beyond project roles: <strong>commenting is app-wide</strong> — every registered user may comment on any task; any project member may <strong>take or release task ownership</strong> (the owner is the task's human reviewer and acceptance authority, scoped to that task); and <strong>admins may release any owner</strong> — recorded in the audit trail.</span></div>
    </div>
  );
}

/* ---------- Surface 2: agent capability ---------- */
function AgentCapability({ profiles, onNav, onMatrix }) {
  return (
    <div className="panel">
      <div className="panel-head"><Icon name="agents" /><h2>Agent capability</h2>
        <span className="right sub" style={{ fontSize: ".76rem", color: "var(--faint)" }}>{profiles.length} profiles</span>
      </div>
      <div className="pol-note"><Icon name="shield" /><span>Agents never hold human roles. What an agent may do comes only from its profile's capability policy — act directly, recommend, or stay out.</span></div>

      <div className="pcap-list">
        {profiles.map((p) => (
          <button type="button" className="pcap-row" key={p.id} onClick={() => onNav("agents")} title={"Open " + p.name + " in Agents"}>
            <span className={"agent-glyph" + (p.kind === "operator" ? " op" : "")}><Icon name={p.icon} /></span>
            <span className="pcap-main">
              <span className="nm">{p.name}</span>
              <span className="sub">{p.role}</span>
            </span>
            <span className="pcap-counts">
              <span className="cs"><span className="d" style={{ background: "var(--teal-dark)" }}></span>{p.actions.direct.length} direct</span>
              <span className="cs"><span className="d" style={{ background: "var(--blue)" }}></span>{p.actions.recommend.length} recommend</span>
              <span className="cs"><span className="d" style={{ background: "var(--coral-dark)" }}></span>{p.actions.forbidden.length} human</span>
            </span>
          </button>
        ))}
      </div>

      <div className="human-only">
        <div className="flabel" style={{ color: "var(--coral-dark)" }}>Always reserved for humans</div>
        {["Merge a pull request", "Transition a task to Done", "Change project policy"].map((x) => (
          <div className="ho-row" key={x}><Icon name="lock" /><span>{x}</span><Pill kind="risk" sm>all profiles</Pill></div>
        ))}
      </div>

      <div className="pol-actions">
        <button className="btn ghost sm" onClick={onMatrix}><Icon name="shield" />Capability matrix</button>
        <button className="btn sm" onClick={() => onNav("agents")}><Icon name="agents" />Manage profiles</button>
      </div>
    </div>
  );
}

/* ---------- Workflow rules ---------- */
function WorkflowRules({ P, stages, bounds, setBound }) {
  const S = (id) => stages.find((s) => s.id === id) || {};
  return (
    <div className="panel">
      <div className="panel-head"><Icon name="board" /><h2>Workflow rules</h2>
        <span className="right sub" style={{ fontSize: ".76rem", color: "var(--faint)" }}>{stages.length} stages · {P.transitions.length} transition rules</span>
      </div>

      <div className="flow-map">
        {stages.map((s, i) => (
          <React.Fragment key={s.id}>
            {i > 0 && <span className="flow-arr"><Icon name="arrow" /></span>}
            <span className="stage-chip elig"><span className="sdot" style={{ background: s.color }}></span>{s.name}</span>
          </React.Fragment>
        ))}
      </div>

      <div className="trans-list">
        {P.transitions.map((t) => {
          const k = t.from + ">" + t.to, f = S(t.from), o = S(t.to);
          return (
            <div className="trans-row" key={k}>
              <span className="trans-path">
                <span className="sdot" style={{ background: f.color }}></span>{f.name}
                <Icon name="arrow" />
                <span className="sdot" style={{ background: o.color }}></span>{o.name}
              </span>
              <span className="trans-by">{t.by}</span>
              <div className={"cap-seg" + (t.locked ? " locked" : "")} title={t.locked ? "Completion is human-authorized in V1 — this boundary can't be delegated" : undefined}>
                {BOUNDARIES.map((b) => (
                  <button type="button" key={b.id} className={BCLS[b.id] + (bounds[k] === b.id ? " on" : "")} onClick={() => setBound(t, b.id)}>{b.label}</button>
                ))}
              </div>
              {t.locked && <span className="trans-lock"><Icon name="lock" />locked · V1</span>}
            </div>
          );
        })}
      </div>

      <div className="pol-note" style={{ marginTop: ".85rem" }}><Icon name="lock" /><span>Only a human can accept completion. Operators request <strong>Review → Done</strong>; a human accepts it — no agent profile can be granted this boundary.</span></div>
    </div>
  );
}

/* ---------- root ---------- */
function Policy({ tasks, onNav, push }) {
  const P = window.VIBERR.policy;
  const A = window.VIBERR.agents;
  const stages = window.VIBERR.stages;
  const profiles = useMemoP(() => [A.operator, ...A.profiles], [A]);

  const [roles, setRoles] = useStateP(() => { const m = {}; P.members.forEach((x) => (m[x.p.name] = x.role)); return m; });
  const [bounds, setBounds] = useStateP(() => { const m = {}; P.transitions.forEach((t) => (m[t.from + ">" + t.to] = t.boundary)); return m; });
  const [matrixOpen, setMatrixOpen] = useStateP(false);

  const setRole = (m, r) => {
    if (roles[m.p.name] === r) return;
    if (roles[m.p.name] === "admin" && r !== "admin") {
      const admins = P.members.filter((x) => roles[x.p.name] === "admin").length;
      if (admins <= 1) { push("Viberr Core needs at least one admin — promote someone else first"); return; }
    }
    setRoles((prev) => ({ ...prev, [m.p.name]: r }));
    push(m.p.name.split(" ")[0] + " is now " + ROLE_LABEL[r] + " · enforced on the next action");
  };

  const setBound = (t, b) => {
    const k = t.from + ">" + t.to;
    if (bounds[k] === b) return;
    setBounds((prev) => ({ ...prev, [k]: b }));
    const f = stages.find((s) => s.id === t.from).name, o = stages.find((s) => s.id === t.to).name;
    push(f + " → " + o + ": " + BOUNDARIES.find((x) => x.id === b).label.toLowerCase() + " · applies to future transitions");
  };

  return (
    <div className="board-wrap" data-screen-label="Policy">
      <div className="board-head">
        <div>
          <h1>Policy</h1>
          <div className="sub">Human access and agent capability — two surfaces, managed separately</div>
        </div>
        <div className="board-tools">
          <span className="hero-file"><Icon name="clock" />last change · {P.edited.by} · {P.edited.t}</span>
          <button className="btn ghost sm" onClick={() => setMatrixOpen(true)}><Icon name="shield" />Capability matrix</button>
        </div>
      </div>

      <div className="policy-wrap">
        <div className="policy-cols">
          <HumanAccess P={P} roles={roles} setRole={setRole} />
          <AgentCapability profiles={profiles} onNav={onNav} onMatrix={() => setMatrixOpen(true)} />
        </div>

        <WorkflowRules P={P} stages={stages} bounds={bounds} setBound={setBound} />
      </div>

      {matrixOpen && <CapabilityMatrixModal profiles={profiles} onClose={() => setMatrixOpen(false)} />}
    </div>
  );
}

Object.assign(window, { Policy, TglP });
