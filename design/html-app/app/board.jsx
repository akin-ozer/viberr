/* Viberr — Board view (agent-aware kanban) */
const { useState: useStateB, useMemo: useMemoB } = React;

function WaitTag({ task }) {
  if (task.waiting === "agent") {
    return <span className="wait-tag agent"><span className="working" />agent working</span>;
  }
  if (task.waiting === "human") {
    return <span className="wait-tag human"><Icon name="hand" />waiting on you</span>;
  }
  return null;
}

function OwnerLine({ task }) {
  const sp = task.specialist;
  if (sp) {
    return (
      <div className="card-owner">
        <AgentGlyph backend={sp.backend} />
        <span className="nm">{sp.name}</span>
        <span className="lbl">· {sp.role}</span>
      </div>
    );
  }
  const o = task.owner;
  if (o) {
    return (
      <div className="card-owner">
        <Avatar person={o} />
        <span className="nm">{o.name.split(" ")[0]}</span>
        <span className="lbl">· owner</span>
      </div>
    );
  }
  return <div className="card-owner"><span className="avatar" style={{ opacity: .5 }}>?</span><span className="lbl">{task.operator ? "awaiting owner" : "unassigned"}</span></div>;
}

function ReviewerStack({ task, label }) {
  const o = task.owner;
  if (!o || !task.specialist) return null;
  return (
    <span className="rev-stack" title={"Owner · human reviewer & acceptance: " + o.name}>
      {label && <span className="rs-lbl">owner</span>}
      <Avatar person={o} />
    </span>
  );
}

function TaskCard({ task, onOpen }) {
  const cls = ["card"];
  if (task.waiting === "human") cls.push("wait-human");
  if (task.urgent) cls.push("urgent");
  return (
    <button type="button" className={cls.join(" ")} onClick={() => onOpen(task.key)}>
      <div className="card-top">
        <span className="key">{task.key}</span>
        <span className="spacer" />
        <ReadinessPill value={task.readiness} sm />
      </div>
      <h3>{task.title}</h3>
      <div className="owner-row">
        <OwnerLine task={task} />
        <ReviewerStack task={task} />
      </div>
      <div className="card-foot">
        {task.branch
          ? <span className="trace ok"><Icon name="branch" />{shortBranch(task.branch)}</span>
          : <span className="trace"><Icon name="branch" />no branch</span>}
        {task.pr && <span className="trace pr"><Icon name="pr" />#{task.pr.number}</span>}
        <WaitTag task={task} />
      </div>
    </button>
  );
}

function shortBranch(b) {
  return b.length > 16 ? b.slice(0, 15) + "…" : b;
}

function Column({ stage, tasks, onOpen, onNew }) {
  return (
    <section className="column">
      <header className="col-head">
        <span className="col-stage-dot" style={{ background: stage.color }} />
        <span className="nm">{stage.name}</span>
        <span className="ct">{tasks.length}</span>
        {stage.id !== "done" && <button type="button" className="add" title="New task in this stage" onClick={onNew}><Icon name="plus" /></button>}
      </header>
      <div className="col-body">
        {tasks.length === 0
          ? <div className="empty">No tasks</div>
          : tasks.map((t) => <TaskCard key={t.key} task={t} onOpen={onOpen} />)}
      </div>
    </section>
  );
}

/* ---------- New task modal (FR11) ---------- */
function NewTaskModal({ initialStage, onClose, onCreate }) {
  const stages = window.VIBERR.stages.filter((s) => s.id !== "done");
  const [title, setTitle] = useStateB("");
  const [goal, setGoal] = useStateB("");
  const [stg, setStg] = useStateB(initialStage || "triage");
  const valid = title.trim().length >= 3;
  const submit = () => {
    if (!valid) return;
    onCreate({ title: title.trim(), goal: goal.trim(), stage: stg });
    onClose();
  };
  return (
    <React.Fragment>
      <div className="confirm-scrim" onClick={onClose} />
      <div className="modal-card" role="dialog" aria-label="New task" style={{ width: "min(560px, calc(100vw - 2rem))" }}>
        <div className="modal-head">
          <span className="agent-glyph lg"><Icon name="plus" /></span>
          <div className="mh-main">
            <h2>New task</h2>
            <div className="mh-sub">Creates a canonical task file in the store — agents anchor on it from the first event.</div>
          </div>
          <button type="button" className="icon-btn modal-close" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
        </div>
        <div className="modal-body">
          <div className="field">
            <label className="flabel">Title<span className="req">*</span></label>
            <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Reconcile PR state after force-push" autoFocus
              onKeyDown={(e) => { if (e.key === "Enter") submit(); }} />
          </div>
          <div className="field">
            <label className="flabel">Stage</label>
            <div className="pick-chips">
              {stages.map((s) => (
                <button type="button" key={s.id} className={"pick-chip" + (stg === s.id ? " on" : "")} onClick={() => setStg(s.id)}>
                  <span className="sdot" style={stg === s.id ? { background: s.color } : null} />{s.name}
                </button>
              ))}
            </div>
          </div>
          <div className="field">
            <label className="flabel">Goal<span className="fhint">what done means — the operator and specialists anchor on this</span></label>
            <textarea value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="One or two sentences. Underspecified goals get flagged at the triage quality gate." />
          </div>
        </div>
        <div className="modal-foot">
          <span className={"foot-hint" + (valid ? "" : " err")}>{valid ? "The task key is assigned on create." : "A title is required."}</span>
          <div className="foot-actions">
            <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
            <button type="button" className="btn primary" onClick={submit} disabled={!valid} style={!valid ? { opacity: .5, pointerEvents: "none" } : null}><Icon name="plus" />Create task</button>
          </div>
        </div>
      </div>
    </React.Fragment>
  );
}

const FILTERS = [
  { id: "all", label: "All tasks", icon: "board" },
  { id: "human", label: "Waiting on me", icon: "hand" },
  { id: "agent", label: "Agent working", icon: "cpu" },
  { id: "risk", label: "Needs attention", icon: "alert" },
];

function Board({ tasks, onOpen, onCreate, push }) {
  const [filter, setFilter] = useStateB("all");
  const [group, setGroup] = useStateB("stage");
  const [creating, setCreating] = useStateB(null); // stage id or null

  const filtered = useMemoB(() => {
    return tasks.filter((t) => {
      if (filter === "human") return t.waiting === "human";
      if (filter === "agent") return t.waiting === "agent";
      if (filter === "risk") return t.readiness === "risk" || t.readiness === "blocked" || t.validation === "failing" || t.urgent;
      return true;
    });
  }, [tasks, filter]);

  const stages = window.VIBERR.stages;
  const waitingHuman = tasks.filter((t) => t.waiting === "human").length;

  const rescan = () => {
    push("Re-scanning the .viberr store…");
    setTimeout(() => push("Re-scan complete — board matches the file-native store"), 1000);
  };

  return (
    <div className="board-wrap" data-screen-label="Board">
      <div className="board-head">
        <div>
          <h1>Board</h1>
          <div className="sub">{tasks.length} tasks · {waitingHuman} waiting on a human decision</div>
        </div>
        <div className="board-tools">
          <div className="seg">
            <button type="button" className={group === "stage" ? "on" : ""} onClick={() => setGroup("stage")}><Icon name="board" />Board</button>
            <button type="button" className={group === "list" ? "on" : ""} onClick={() => setGroup("list")}><Icon name="review" />List</button>
          </div>
          <button type="button" className="btn ghost sm" onClick={rescan} title="Reconcile the board with the file-native store"><Icon name="refresh" />Re-scan</button>
          <button type="button" className="btn primary sm" onClick={() => setCreating("triage")}><Icon name="plus" />New task</button>
        </div>
      </div>

      <div className="filter-bar">
        {FILTERS.map((f) => (
          <button type="button" key={f.id} className={"fchip" + (filter === f.id ? " on" : "")} onClick={() => setFilter(f.id)}>
            <Icon name={f.icon} />{f.label}
            {f.id === "human" && waitingHuman > 0 && <span style={{ opacity: .7 }}>· {waitingHuman}</span>}
          </button>
        ))}
      </div>

      {group === "stage" ? (
        <div className="board">
          {stages.map((s) => (
            <Column key={s.id} stage={s} tasks={filtered.filter((t) => t.stage === s.id)} onOpen={onOpen} onNew={() => setCreating(s.id)} />
          ))}
        </div>
      ) : (
        <ListView tasks={filtered} onOpen={onOpen} />
      )}

      {creating && <NewTaskModal initialStage={creating} onClose={() => setCreating(null)} onCreate={onCreate} />}
    </div>
  );
}

function ListView({ tasks, onOpen }) {
  const stages = window.VIBERR.stages;
  const stageName = (id) => (stages.find((s) => s.id === id) || {}).name;
  return (
    <div className="board" style={{ gridAutoFlow: "row", gridAutoColumns: "auto", display: "block", padding: "0 1.4rem 1.4rem" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: ".6rem", maxWidth: 920 }}>
        {tasks.map((t) => (
          <button type="button" key={t.key} className="card" style={{ flexDirection: "row", alignItems: "center", gap: "1rem" }} onClick={() => onOpen(t.key)}>
            <span className="key" style={{ width: 64 }}>{t.key}</span>
            <h3 style={{ flex: 1 }}>{t.title}</h3>
            <span className="pill neutral sm">{stageName(t.stage)}</span>
            <OwnerLine task={t} />
            <ReviewerStack task={t} label />
            <ReadinessPill value={t.readiness} sm />
            <WaitTag task={t} />
          </button>
        ))}
      </div>
    </div>
  );
}

Object.assign(window, { Board });
