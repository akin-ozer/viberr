/* Viberr — Agents view (profiles, capability policy, live deployment) */
const { useState: useStateAg, useMemo: useMemoAg } = React;

/* ---------- live deployment derivation ---------- */
function deployments(tasks) {
  const inst = [];
  tasks.forEach((t) => {
    if (t.stage === "done") return;
    if (t.operator) {
      inst.push({ profile: "operator", role: "Operator", backend: "claude", engagement: "operator", task: t,
        status: t.waiting === "human" ? "packet open" : "coordinating", since: t.operator.since });
    }
    if (t.specialist) {
      inst.push({ profile: t.specialist.role.toLowerCase(), role: t.specialist.role, backend: t.specialist.backend, engagement: "primary", task: t,
        status: t.waiting === "agent" ? "working" : t.waiting === "human" ? "waiting on human" : "on call", since: (t.operator || {}).since });
    }
    (t.consultants || []).forEach((c) => {
      inst.push({ profile: c.role.toLowerCase(), role: c.role, backend: c.backend, engagement: "consultant", task: t,
        status: "anchored · on call", since: (t.operator || {}).since });
    });
  });
  return inst;
}

function statusKind(s) {
  if (s === "working" || s === "coordinating") return "agent";
  if (s === "packet open") return "input";
  if (s === "waiting on human") return "info";
  return "neutral";
}

/* ---------- small parts ---------- */
function BackendChip({ b }) {
  return (
    <span className="be-chip">
      <AgentGlyph backend={b} />
      {b === "claude" ? "Claude Code" : "Codex"}
    </span>
  );
}

function ProfileGlyph({ a, lg }) {
  return (
    <span className={"agent-glyph" + (lg ? " lg" : "") + (a.kind === "operator" ? " op" : "")} title={a.role}>
      <Icon name={a.icon} />
    </span>
  );
}

function ActiveBadge({ count }) {
  if (count > 0) return <span className="ag-active"><span className="working" />{count}</span>;
  return <span className="ag-idle">idle</span>;
}

/* ---------- profile list ---------- */
function ProfileItem({ a, count, on, onClick }) {
  return (
    <button type="button" className={"ag-item" + (on ? " on" : "")} onClick={onClick}>
      <ProfileGlyph a={a} />
      <span className="ag-item-main">
        <span className="nm">{a.name}</span>
        <span className="sub">{a.role}</span>
      </span>
      <ActiveBadge count={count} />
    </button>
  );
}

/* ---------- capability matrix ---------- */
const CAP_META = {
  direct: { label: "Acts directly", icon: "check" },
  recommend: { label: "Recommends only", icon: "arrow" },
  forbidden: { label: "Reserved for humans", icon: "lock" },
};
function CapColumn({ group, items }) {
  const m = CAP_META[group];
  return (
    <div className={"cap-col " + group}>
      <div className="cap-col-head"><Icon name={m.icon} />{m.label}</div>
      <div className="cap-list">
        {items.map((x, i) => (
          <div className="cap-item" key={i}><Icon name={m.icon} /><span>{x}</span></div>
        ))}
      </div>
    </div>
  );
}

/* ---------- resources ---------- */
function ResGroup({ label, icon, items }) {
  return (
    <div className="res-group">
      <div className="lbl">{label}</div>
      <div className="res-chips">
        {items.length
          ? items.map((x, i) => <span className="res-chip" key={i}><Icon name={icon} />{x}</span>)
          : <span className="sub" style={{ fontSize: ".8rem", color: "var(--placeholder)" }}>None</span>}
      </div>
    </div>
  );
}

/* ---------- profile detail ---------- */
function ProfileDetail({ a, tasks, onOpen, onDelete, onEdit }) {
  const stages = window.VIBERR.stages;
  const insts = useMemoAg(() => deployments(tasks).filter((d) => d.profile === a.id), [a, tasks]);
  const activeKeys = [...new Set(insts.map((d) => d.task.key))];
  const [confirm, setConfirm] = useStateAg(false);
  const canDelete = a.kind !== "operator";

  return (
    <div className="ag-detail">
      {confirm && (
        <React.Fragment>
          <div className="confirm-scrim" onClick={() => setConfirm(false)} />
          <div className="confirm-card" role="alertdialog" aria-label="Delete profile">
            <div className="confirm-icon"><Icon name="alert" /></div>
            <h3>Delete the {a.name} profile?</h3>
            <p>
              This removes <strong>{a.name}</strong> from Viberr Core's approved profiles. It can't be assigned to new tasks.
              {activeKeys.length > 0
                ? <React.Fragment> It is currently engaged on <strong>{activeKeys.length} active task{activeKeys.length > 1 ? "s" : ""}</strong> — those threads keep running until the operator reassigns them.</React.Fragment>
                : <React.Fragment> The global base definition is unaffected.</React.Fragment>}
            </p>
            <div className="confirm-actions">
              <button type="button" className="btn ghost" onClick={() => setConfirm(false)}>Cancel</button>
              <button type="button" className="btn danger" onClick={() => { setConfirm(false); onDelete(a.id); }}><Icon name="x" />Delete profile</button>
            </div>
          </div>
        </React.Fragment>
      )}
      <div className="ag-hero">
        <ProfileGlyph a={a} lg />
        <div className="ag-hero-main">
          <div className="ag-hero-top">
            <h1>{a.name}</h1>
            <Pill kind={a.kind === "operator" ? "agent" : "neutral"} sm>{a.role}</Pill>
            {activeKeys.length > 0
              ? <span className="ag-running"><span className="working" />running on {activeKeys.length} {activeKeys.length > 1 ? "tasks" : "task"}</span>
              : <span className="ag-idle">idle · available</span>}
          </div>
          <div className="ag-scope">{a.scope}</div>
        </div>
        <div className="ag-hero-actions">
          {canDelete && <button type="button" className="btn ghost sm danger" onClick={() => setConfirm(true)}><Icon name="x" />Delete</button>}
          <button type="button" className="btn sm" onClick={() => onEdit(a)}><Icon name="user" />Edit profile</button>
        </div>
      </div>

      <p className="ag-desc">{a.desc}</p>

      <div className="panel">
        <div className="panel-head"><Icon name="board" /><h2>Eligible stages</h2>
          <span className="right sub" style={{ fontSize: ".76rem", color: "var(--faint)" }}>
            {a.spanAll ? "active across the whole lifecycle" : a.stages.length + " of " + stages.length + " stages"}
          </span>
        </div>
        <div className="stage-chips">
          {stages.map((s) => {
            const elig = a.stages.includes(s.id);
            return (
              <span key={s.id} className={"stage-chip" + (elig ? " elig" : " off")}>
                <span className="sdot" style={elig ? { background: s.color } : null} />{s.name}
              </span>
            );
          })}
        </div>
      </div>

      <div className="panel">
        <div className="panel-head"><Icon name="shield" /><h2>Capability policy</h2>
        </div>
        <div className="cap-cols">
          <CapColumn group="direct" items={a.actions.direct} />
          <CapColumn group="recommend" items={a.actions.recommend} />
          <CapColumn group="forbidden" items={a.actions.forbidden} />
        </div>
      </div>

      <div className="panel">
        <div className="panel-head"><Icon name="cpu" /><h2>Context resources &amp; runtime</h2></div>
        <div className="res-groups">
          <ResGroup label="Skills" icon="bolt" items={a.resources.skills} />
          <ResGroup label="MCP servers" icon="cpu" items={a.resources.mcps} />
          <ResGroup label="Knowledge bases" icon="file" items={a.resources.kb} />
        </div>
        <div className="runtime-row">
          <div className="rt-cell">
            <div className="lbl">{a.kind === "operator" ? "Runtime" : "Execution backend"}</div>
            <div className="rt-val">
              {a.kind === "operator"
                ? <span className="be-chip"><span className="agent-glyph op" style={{ width: 22, height: 22 }}><Icon name="shield" /></span>Orchestration runtime</span>
                : <div className="be-list">{a.backends.map((b, i) => <BackendChip key={i} b={b} />)}</div>}
            </div>
          </div>
          <div className="rt-cell">
            <div className="lbl">Model</div>
            <div className="rt-val mono" style={{ fontSize: ".82rem" }}>{a.model}</div>
          </div>
          <div className="rt-cell">
            <div className="lbl">Continuity</div>
            <div className="rt-val mem-row" style={{ marginTop: 0 }}><Icon name="memory" /><span>Re-anchors on <code className="mono">task.md</code></span></div>
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head"><Icon name="activity" /><h2>Active deployments</h2>
          <span className="right sub" style={{ fontSize: ".76rem", color: "var(--faint)" }}>{insts.length} engagement{insts.length === 1 ? "" : "s"}</span>
        </div>
        {insts.length === 0
          ? <div className="empty" style={{ padding: "1rem .5rem" }}>Not currently engaged on any task. This profile is approved and available for assignment.</div>
          : <div className="deploy-list">
              {insts.map((d, i) => (
                <button type="button" className="deploy-row" key={i} onClick={() => onOpen(d.task.key)}>
                  <span className="deploy-eng">{d.engagement}</span>
                  <span className="deploy-task"><span className="key mono">{d.task.key}</span> {d.task.title}</span>
                  {d.backend && a.kind !== "operator" && <BackendChip b={d.backend} />}
                  <Pill kind={statusKind(d.status)} sm dot={d.status === "working" || d.status === "coordinating"}>{d.status}</Pill>
                </button>
              ))}
            </div>}
      </div>
    </div>
  );
}

/* ---------- live roster ---------- */
function LiveRoster({ tasks, onOpen }) {
  const insts = useMemoAg(() => deployments(tasks), [tasks]);
  const order = { operator: 0, primary: 1, consultant: 2 };
  const sorted = [...insts].sort((a, b) => a.task.key.localeCompare(b.task.key) || order[a.engagement] - order[b.engagement]);
  return (
    <div className="live-wrap">
      <div className="live-table">
        <div className="live-head">
          <span>Agent</span><span>Backend</span><span>Task</span><span>Engagement</span><span>Status</span>
        </div>
        {sorted.map((d, i) => {
          const isOp = d.engagement === "operator";
          return (
            <button type="button" className="live-row" key={i} onClick={() => onOpen(d.task.key)}>
              <span className="live-agent">
                <span className={"agent-glyph" + (isOp ? " op" : " " + (d.backend === "claude" ? "claude" : "codex"))}>
                  <Icon name={isOp ? "shield" : d.backend === "claude" ? "sparkle" : "cpu"} />
                </span>
                <span className="live-role">{d.role}</span>
              </span>
              <span className="live-be">{isOp ? "orchestration" : d.backend === "claude" ? "Claude Code" : "Codex"}</span>
              <span className="live-task"><span className="key mono">{d.task.key}</span> <span className="ttl">{d.task.title}</span></span>
              <span><Pill kind={d.engagement === "operator" ? "agent" : d.engagement === "primary" ? "info" : "neutral"} sm>{d.engagement}</Pill></span>
              <span><Pill kind={statusKind(d.status)} sm dot={d.status === "working" || d.status === "coordinating"}>{d.status}</Pill></span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ---------- create-profile modal ---------- */
// Curated catalog of governable actions, with sensible default governance per action.
const CAP_CATALOG = [
  { group: "Repository & execution", caps: [
    { id: "read", label: "Read the task & repository", def: "direct" },
    { id: "comment", label: "Comment on the task", def: "direct" },
    { id: "branch", label: "Create the task-key branch", def: "direct" },
    { id: "commit", label: "Commit & push to the branch", def: "direct" },
    { id: "openpr", label: "Open the review pull request", def: "recommend" },
    { id: "editother", label: "Edit another task's branch", def: "human" },
  ] },
  { group: "Validation & review", caps: [
    { id: "runval", label: "Run validation suites", def: "direct" },
    { id: "authortests", label: "Author test cases", def: "direct" },
    { id: "evidence", label: "Attach evidence references", def: "direct" },
    { id: "qualityflag", label: "Post quality-flag events", def: "direct" },
    { id: "verdict", label: "Report a validation verdict", def: "recommend" },
    { id: "approve", label: "Approve the review", def: "recommend" },
    { id: "changes", label: "Request changes", def: "recommend" },
    { id: "flagunder", label: "Flag underspecified tasks", def: "recommend" },
  ] },
  { group: "Workflow & approvals", caps: [
    { id: "toreview", label: "Move the task to Review", def: "recommend" },
    { id: "merge", label: "Merge a pull request", def: "human" },
    { id: "done", label: "Transition a task to Done", def: "human" },
    { id: "policy", label: "Change project policy", def: "human" },
  ] },
];
const CAP_DEFAULTS = (() => { const m = {}; CAP_CATALOG.forEach((g) => g.caps.forEach((c) => (m[c.id] = c.def))); return m; })();
const CAP_LABEL = (() => { const m = {}; CAP_CATALOG.forEach((g) => g.caps.forEach((c) => (m[c.id] = c.label))); return m; })();
const CAP_LABEL_TO_ID = (() => { const m = {}; Object.keys(CAP_LABEL).forEach((id) => (m[CAP_LABEL[id]] = id)); return m; })();
// Reverse a profile's action buckets into the catalog's mode-map, plus any non-catalog actions to preserve.
function reverseCaps(actions) {
  const c = {}; CAP_CATALOG.forEach((g) => g.caps.forEach((cap) => (c[cap.id] = "off")));
  const set = (arr, mode) => (arr || []).forEach((label) => { const id = CAP_LABEL_TO_ID[label]; if (id) c[id] = mode; });
  set((actions || {}).direct, "direct"); set((actions || {}).recommend, "recommend"); set((actions || {}).forbidden, "human");
  return c;
}
function extraCaps(actions) {
  const e = { direct: [], recommend: [], human: [] };
  const keep = (arr, key) => (arr || []).filter((l) => !CAP_LABEL_TO_ID[l]).forEach((l) => e[key].push(l));
  keep((actions || {}).direct, "direct"); keep((actions || {}).recommend, "recommend"); keep((actions || {}).forbidden, "human");
  return e;
}
const CAP_MODES = [{ id: "direct", label: "Direct" }, { id: "recommend", label: "Recommend" }, { id: "human", label: "Human" }, { id: "off", label: "Off" }];

// Curated catalog of grantable context resources, with sensible defaults granted.
const RES_CATALOG = [
  { group: "Skills", key: "skills", mono: true, items: [
    { id: "repo-write", def: true }, { id: "test-runner", def: true }, { id: "lint-autofix", def: false },
    { id: "diff-review", def: false }, { id: "security-scan", def: false }, { id: "test-author", def: false },
    { id: "coverage-report", def: false }, { id: "refactor", def: false }, { id: "dependency-audit", def: false },
    { id: "domain-advisor", def: false },
  ] },
  { group: "MCP servers", key: "mcps", mono: true, items: [
    { id: "github", def: true }, { id: "filesystem", def: false }, { id: "viberr-task-store", def: false },
    { id: "http-fetch", def: false }, { id: "postgres", def: false }, { id: "docker", def: false },
  ] },
  { group: "Knowledge bases", key: "kb", mono: false, items: [
    { id: "Viberr Core architecture", def: true }, { id: "Coding standards", def: true }, { id: "Review checklist", def: false },
    { id: "Security guidelines", def: false }, { id: "Test strategy", def: false }, { id: "Product brief", def: false },
    { id: "Domain glossary", def: false }, { id: "Prior decisions", def: false },
  ] },
];
const RES_DEFAULTS = (() => { const m = {}; RES_CATALOG.forEach((g) => (m[g.key] = g.items.filter((i) => i.def).map((i) => i.id))); return m; })();

function TagInput({ items, onChange, placeholder, mono }) {
  const [v, setV] = useStateAg("");
  const add = () => {
    const t = v.trim();
    if (t && !items.includes(t)) onChange([...items, t]);
    setV("");
  };
  return (
    <div className={"tagbox" + (mono ? "" : " sent")} onClick={(e) => e.currentTarget.querySelector("input").focus()}>
      {items.map((x, i) => (
        <span className="tag" key={i}>{x}<button type="button" aria-label={"Remove " + x} onClick={(e) => { e.stopPropagation(); onChange(items.filter((y) => y !== x)); }}><Icon name="x" /></button></span>
      ))}
      <input value={v} placeholder={items.length ? "" : placeholder} onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(); }
          else if (e.key === "Backspace" && !v && items.length) onChange(items.slice(0, -1));
        }}
        onBlur={add} />
    </div>
  );
}

function CreateProfileModal({ initial, onClose, onSubmit }) {
  const editing = !!initial;
  const stages = window.VIBERR.stages;
  const [name, setName] = useStateAg(initial ? initial.name : "");
  const [role, setRole] = useStateAg(initial ? initial.role : "");
  const [stg, setStg] = useStateAg(initial ? [...(initial.stages || [])] : []);
  const [backend, setBackend] = useStateAg(initial ? (initial.backends || [])[0] || "" : "");
  const [definition, setDefinition] = useStateAg(initial ? (initial.desc || "") : "");
  const [caps, setCaps] = useStateAg(initial ? reverseCaps(initial.actions) : CAP_DEFAULTS);
  const [extra] = useStateAg(initial ? extraCaps(initial.actions) : { direct: [], recommend: [], human: [] });
  const [openGroups, setOpenGroups] = useStateAg({ [CAP_CATALOG[0].group]: true });
  const [res, setRes] = useStateAg(initial
    ? { skills: [...((initial.resources || {}).skills || [])], mcps: [...((initial.resources || {}).mcps || [])], kb: [...((initial.resources || {}).kb || [])] }
    : RES_DEFAULTS);
  const [openRes, setOpenRes] = useStateAg({ [RES_CATALOG[0].group]: true });

  const toggleRes = (key, item) => setRes((p) => ({ ...p, [key]: p[key].includes(item) ? p[key].filter((x) => x !== item) : [...p[key], item] }));

  const toggle = (set, v) => set((arr) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]));
  const valid = name.trim() && role.trim() && backend && stg.length;

  const submit = () => {
    if (!valid) return;
    const id = initial ? initial.id : (name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") + "-" + Math.random().toString(36).slice(2, 6));
    const isOp = initial && initial.kind === "operator";
    const model = isOp ? initial.model : (backend === "claude" ? "claude-sonnet" : "codex-large");
    const bucket = (mode) => Object.keys(caps).filter((k) => caps[k] === mode).map((k) => CAP_LABEL[k]);
    onSubmit({
      ...(initial || {}),
      id, kind: initial ? initial.kind : "specialist", name: name.trim(), role: role.trim(),
      icon: initial ? initial.icon : "agents",
      backends: [backend], model, scope: initial ? initial.scope : "Created in Viberr Core",
      desc: definition.trim() || (name.trim() + " — a " + role.trim().toLowerCase() + " specialist."),
      stages: [...stg],
      actions: {
        direct: [...bucket("direct"), ...extra.direct],
        recommend: [...bucket("recommend"), ...extra.recommend],
        forbidden: [...bucket("human"), ...extra.human],
      },
      resources: { skills: [...res.skills], mcps: [...res.mcps], kb: [...res.kb] },
    });
  };

  const BACKENDS = [{ id: "codex", label: "Codex" }, { id: "claude", label: "Claude Code" }];

  return (
    <React.Fragment>
      <div className="confirm-scrim" onClick={onClose} />
      <div className="modal-card" role="dialog" aria-label={editing ? "Edit profile" : "New specialist profile"}>
        <div className="modal-head">
          <span className="agent-glyph lg"><Icon name="agents" /></span>
          <div className="mh-main">
            <h2>{editing ? "Edit " + initial.name : "New specialist profile"}</h2>
            <div className="mh-sub">{editing ? "Update this profile — changes apply to future assignments." : "A reusable agent the operator can assign to tasks."}</div>
          </div>
          <button type="button" className="icon-btn modal-close" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
        </div>

        <div className="modal-body">
          <div className="field-row">
            <div className="field">
              <label className="flabel">Name<span className="req">*</span></label>
              <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Migrations" autoFocus />
            </div>
            <div className="field">
              <label className="flabel">Role<span className="req">*</span></label>
              <input type="text" value={role} onChange={(e) => setRole(e.target.value)} placeholder="e.g. Schema changes" />
            </div>
          </div>

          <div className="field">
            <label className="flabel">Execution backend<span className="req">*</span><span className="fhint">pick exactly one</span></label>
            <div className="pick-chips">
              {BACKENDS.map((b) => (
                <button type="button" key={b.id} className={"pick-chip" + (backend === b.id ? " on" : "")} onClick={() => setBackend(b.id)}>
                  <AgentGlyph backend={b.id} />{b.label}
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <label className="flabel">Eligible stages<span className="req">*</span><span className="fhint">stages this profile may work in</span></label>
            <div className="pick-chips">
              {stages.map((s) => (
                <button type="button" key={s.id} className={"pick-chip" + (stg.includes(s.id) ? " on" : "")} onClick={() => toggle(setStg, s.id)}>
                  <span className="sdot" style={stg.includes(s.id) ? { background: s.color } : null} />{s.name}
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <label className="flabel">Definition<span className="fhint">what this agent is for, in your words — markdown ok</span></label>
            <textarea value={definition} onChange={(e) => setDefinition(e.target.value)} style={{ minHeight: "96px" }}
              placeholder="e.g. Owns database schema changes. Writes and verifies migrations against a shadow DB, and never touches application code without operator sign-off." />
          </div>

          <div className="field">
            <label className="flabel">Capability policy<span className="fhint">how each action is enforced — adjust the defaults</span></label>
            <div className="cap-matrix">
              {CAP_CATALOG.map((g) => {
                const open = !!openGroups[g.group];
                const c = { direct: 0, recommend: 0, human: 0, off: 0 };
                g.caps.forEach((x) => (c[caps[x.id]] += 1));
                return (
                  <div className={"cap-mgroup" + (open ? " open" : "")} key={g.group}>
                    <button type="button" className={"cap-mghead" + (open ? " open" : "")} onClick={() => setOpenGroups((p) => ({ ...p, [g.group]: !p[g.group] }))}>
                      <Icon name="chevron" className="cap-chev" />
                      <span className="cap-mglabel">{g.group}</span>
                      <span className="cap-msum">
                        {c.direct > 0 && <span className="cs"><span className="d" style={{ background: "var(--teal-dark)" }} />{c.direct}</span>}
                        {c.recommend > 0 && <span className="cs"><span className="d" style={{ background: "var(--blue)" }} />{c.recommend}</span>}
                        {c.human > 0 && <span className="cs"><span className="d" style={{ background: "var(--coral-dark)" }} />{c.human}</span>}
                        {c.off > 0 && <span className="cs"><span className="d" style={{ background: "var(--placeholder)" }} />{c.off}</span>}
                      </span>
                    </button>
                    {open && (
                      <div className="cap-mbody">
                        {g.caps.map((cap) => (
                          <div className="cap-mrow" key={cap.id}>
                            <span className="cap-mname">{cap.label}</span>
                            <div className="cap-seg">
                              {CAP_MODES.map((m) => (
                                <button type="button" key={m.id} className={m.id + (caps[cap.id] === m.id ? " on" : "")}
                                  onClick={() => setCaps((p) => ({ ...p, [cap.id]: m.id }))}>{m.label}</button>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="field">
            <label className="flabel">Context resources<span className="fhint">skills, MCP servers, knowledge bases this profile may load</span></label>
            <div className="cap-matrix">
              {RES_CATALOG.map((g) => {
                const open = !!openRes[g.group];
                const sel = res[g.key];
                return (
                  <div className={"cap-mgroup" + (open ? " open" : "")} key={g.group}>
                    <button type="button" className={"cap-mghead" + (open ? " open" : "")} onClick={() => setOpenRes((p) => ({ ...p, [g.group]: !p[g.group] }))}>
                      <Icon name="chevron" className="cap-chev" />
                      <span className="cap-mglabel">{g.group}</span>
                      <span className="cap-msum"><span className="cs"><span className="d" style={{ background: "var(--blue)" }} />{sel.length} of {g.items.length}</span></span>
                    </button>
                    {open && (
                      <div className="cap-mbody">
                        <div className="pick-chips">
                          {g.items.map((it) => (
                            <button type="button" key={it.id} className={"pick-chip" + (g.mono ? " mono" : "") + (sel.includes(it.id) ? " on" : "")} onClick={() => toggleRes(g.key, it.id)}>
                              {sel.includes(it.id) && <Icon name="check" />}{it.id}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <div className="modal-foot">
          <span className={"foot-hint" + (valid ? "" : " err")}>{valid ? (editing ? "Ready to save changes." : "Ready to add to Viberr Core.") : "Name, role, one execution backend, and at least one stage are required."}</span>
          <div className="foot-actions">
            <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
            <button type="button" className="btn primary" onClick={submit} disabled={!valid} style={!valid ? { opacity: .5, pointerEvents: "none" } : null}><Icon name="check" />{editing ? "Save changes" : "Create profile"}</button>
          </div>
        </div>
      </div>
    </React.Fragment>
  );
}

/* ---------- capability matrix ---------- */
function CapabilityMatrixModal({ profiles, onClose }) {
  const modeOf = (p, label) => {
    const A = p.actions || {};
    if ((A.direct || []).includes(label)) return "direct";
    if ((A.recommend || []).includes(label)) return "recommend";
    if ((A.forbidden || []).includes(label)) return "human";
    return "off";
  };
  const known = new Set(Object.values(CAP_LABEL));
  const groups = CAP_CATALOG.map((g) => ({ group: g.group, labels: g.caps.map((c) => c.label) }));
  const extras = [];
  profiles.forEach((p) => ["direct", "recommend", "forbidden"].forEach((k) => ((p.actions || {})[k] || []).forEach((l) => { if (!known.has(l) && !extras.includes(l)) extras.push(l); })));
  if (extras.length) groups.push({ group: "Other actions", labels: extras });

  return (
    <React.Fragment>
      <div className="confirm-scrim" onClick={onClose} />
      <div className="modal-card modal-wide" role="dialog" aria-label="Capability matrix">
        <div className="modal-head">
          <span className="agent-glyph lg"><Icon name="shield" /></span>
          <div className="mh-main">
            <h2>Capability matrix</h2>
            <div className="mh-sub">Every profile's permissions for each action in Viberr Core.</div>
          </div>
          <button type="button" className="icon-btn modal-close" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
        </div>
        <div className="mx-legend">
          <span className="lg"><span className="d" style={{ background: "var(--teal-dark)" }} />Acts directly</span>
          <span className="lg"><span className="d" style={{ background: "var(--blue)" }} />Recommends</span>
          <span className="lg"><span className="d" style={{ background: "var(--coral-dark)" }} />Reserved for humans</span>
          <span className="lg"><span className="d" style={{ background: "var(--ring)" }} />Not granted</span>
        </div>
        <div className="modal-body">
          <div className="mx-scroll">
            <table className="cap-matrix-table">
              <thead>
                <tr>
                  <th className="corner">Action</th>
                  {profiles.map((p) => (
                    <th key={p.id}><div className="mx-col"><span className={"agent-glyph" + (p.kind === "operator" ? " op" : "")}><Icon name={p.icon} /></span>{p.name}</div></th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => (
                  <React.Fragment key={g.group}>
                    <tr className="grp"><td colSpan={profiles.length + 1}>{g.group}</td></tr>
                    {g.labels.map((label) => (
                      <tr key={label}>
                        <td className="rowlabel">{label}</td>
                        {profiles.map((p) => {
                          const m = modeOf(p, label);
                          return <td key={p.id}><span className={"mx-cell " + m} title={m === "off" ? "Not granted" : m === "human" ? "Reserved for humans" : m === "recommend" ? "Recommends" : "Acts directly"}><span className="d" /></span></td>;
                        })}
                      </tr>
                    ))}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </React.Fragment>
  );
}

/* ---------- root ---------- */
function Agents({ tasks, onOpen }) {
  const A = window.VIBERR.agents;
  const [removed, setRemoved] = useStateAg([]);
  const [added, setAdded] = useStateAg([]);
  const [edits, setEdits] = useStateAg({});
  const [creating, setCreating] = useStateAg(false);
  const [editing, setEditing] = useStateAg(null);
  const [matrixOpen, setMatrixOpen] = useStateAg(false);
  const applyEdit = (p) => edits[p.id] || p;
  const specialists = useMemoAg(
    () => [...A.profiles, ...added].filter((p) => !removed.includes(p.id)).map(applyEdit),
    [A, added, removed, edits]
  );
  const list = useMemoAg(() => [applyEdit(A.operator), ...specialists], [A, specialists, edits]);
  const [sel, setSel] = useStateAg("operator");
  const [tab, setTab] = useStateAg("profiles");

  const onDelete = (id) => {
    setRemoved((r) => [...r, id]);
    setSel((s) => (s === id ? "operator" : s));
  };
  const onCreate = (profile) => {
    setAdded((a) => [...a, profile]);
    setSel(profile.id);
    setCreating(false);
  };
  const onSave = (profile) => {
    setEdits((e) => ({ ...e, [profile.id]: profile }));
    setSel(profile.id);
    setEditing(null);
  };

  const all = useMemoAg(() => deployments(tasks), [tasks]);
  const counts = useMemoAg(() => {
    const c = {};
    all.forEach((d) => { c[d.profile] = c[d.profile] || new Set(); c[d.profile].add(d.task.key); });
    const out = {}; Object.keys(c).forEach((k) => (out[k] = c[k].size));
    return out;
  }, [all]);

  const running = new Set(all.map((d) => d.task.key)).size;
  const operators = all.filter((d) => d.engagement === "operator").length;
  const working = all.filter((d) => d.status === "working").length;
  const waiting = all.filter((d) => d.status === "waiting on human" || d.status === "packet open").length;

  const current = list.find((a) => a.id === sel) || list[0];

  return (
    <div className="board-wrap" data-screen-label="Agents">
      <div className="board-head">
        <div>
          <h1>Agents</h1>
          <div className="sub">Reusable profiles, eligible stages, and capability policy · global base, customized for Viberr Core</div>
        </div>
        <div className="board-tools">
          <div className="seg">
            <button type="button" className={tab === "profiles" ? "on" : ""} onClick={() => setTab("profiles")}><Icon name="agents" />Profiles</button>
            <button type="button" className={tab === "live" ? "on" : ""} onClick={() => setTab("live")}><Icon name="activity" />Live<span style={{ opacity: .6 }}>· {all.length}</span></button>
          </div>
          <button type="button" className="btn ghost sm" onClick={() => setMatrixOpen(true)}><Icon name="shield" />Capability matrix</button>
          <button type="button" className="btn primary sm" onClick={() => setCreating(true)}><Icon name="plus" />New profile</button>
        </div>
      </div>

      <div className="ag-stats">
        <div className="ag-stat"><div className="n">{list.length}</div><div className="l">profiles approved · incl. operator</div></div>
        <div className="ag-stat"><div className="n">{operators}</div><div className="l">operators running · one per active task</div></div>
        <div className="ag-stat"><div className="n" style={{ color: "var(--agent-dark)" }}>{working}</div><div className="l">specialists working right now</div></div>
        <div className="ag-stat"><div className="n" style={{ color: "var(--blue-pressed)" }}>{waiting}</div><div className="l">threads waiting on a human</div></div>
      </div>

      {tab === "profiles" ? (
        <div className="agents-layout">
          <aside className="profile-list">
            <div className="ag-group-label">Orchestration</div>
            <ProfileItem a={applyEdit(A.operator)} count={counts.operator || 0} on={sel === "operator"} onClick={() => setSel("operator")} />
            <div className="ag-group-label ag-group-row">Specialist profiles
              <button type="button" className="ag-add" title="New specialist profile" onClick={() => setCreating(true)}><Icon name="plus" /></button>
            </div>
            {specialists.map((p) => (
              <ProfileItem key={p.id} a={p} count={counts[p.id] || 0} on={sel === p.id} onClick={() => setSel(p.id)} />
            ))}
            <button type="button" className="ag-newbtn" onClick={() => setCreating(true)}><Icon name="plus" />New specialist profile</button>
          </aside>
          <ProfileDetail a={current} tasks={tasks} onOpen={onOpen} onDelete={onDelete} onEdit={setEditing} />
        </div>
      ) : (
        <LiveRoster tasks={tasks} onOpen={onOpen} />
      )}

      {creating && <CreateProfileModal onClose={() => setCreating(false)} onSubmit={onCreate} />}
      {editing && <CreateProfileModal initial={editing} onClose={() => setEditing(null)} onSubmit={onSave} />}
      {matrixOpen && <CapabilityMatrixModal profiles={list} onClose={() => setMatrixOpen(false)} />}
    </div>
  );
}

Object.assign(window, { Agents, CapabilityMatrixModal });
