/* Viberr — Settings view: board configuration for the project */
const { useState: useStateS } = React;

/* ---------- Project ---------- */
function ProjectSettings({ push }) {
  const [name, setName] = useStateS("Viberr Core");
  const [prefix, setPrefix] = useStateS("VIB");
  const [desc, setDesc] = useStateS("Core platform work — orchestration runtime, operator layer, and workspace surfaces.");
  const saved = () => push("Project settings saved");
  return (
    <div className="panel">
      <div className="panel-head"><Icon name="board" /><h2>Project</h2></div>
      <div className="set-fields">
        <div className="field-row" style={{ gridTemplateColumns: "1fr 120px" }}>
          <div className="field">
            <label className="flabel">Project name</label>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} onBlur={saved} />
          </div>
          <div className="field">
            <label className="flabel">Task prefix</label>
            <input type="text" className="mono" value={prefix} onChange={(e) => setPrefix(e.target.value.toUpperCase().slice(0, 4))} onBlur={saved} />
          </div>
        </div>
        <div className="field">
          <label className="flabel">Description</label>
          <textarea rows="2" value={desc} onChange={(e) => setDesc(e.target.value)} onBlur={saved}></textarea>
        </div>
      </div>
      <div className="kv" style={{ marginTop: ".4rem" }}>
        <div className="kv-row"><span className="k">Task keys</span><span className="v"><span className="mono">{prefix}-###</span></span></div>
        <div className="kv-row"><span className="k">Canonical task file</span><span className="v"><Icon name="file" /><span className="mono">{".viberr/tasks/<key>/task.md"}</span></span></div>
      </div>
    </div>
  );
}

/* ---------- Workflow stages (editable: rename, reorder, add, remove) ---------- */
const STAGE_LOCK = { triage: "it's the entry point", done: "human acceptance stays terminal" };
const NEW_STAGE_COLORS = ["var(--blue)", "var(--yellow-dark)", "var(--agent)", "var(--teal-dark)"];

function StageSettings({ tasks, stages, setStages, onNav, push }) {
  const [editingId, setEditingId] = useStateS(null);
  const [dragId, setDragId] = useStateS(null);
  const [overId, setOverId] = useStateS(null);

  const count = (id) => tasks.filter((t) => t.stage === id).length;

  const commitName = (s, raw) => {
    setEditingId(null);
    const v = raw.trim();
    if (!v || v === s.name) return;
    setStages(stages.map((x) => (x.id === s.id ? { ...x, name: v } : x)));
    push('Stage renamed to "' + v + '" — board and policy follow');
  };

  const remove = (s) => {
    if (STAGE_LOCK[s.id]) { push(s.name + " can't be removed — " + STAGE_LOCK[s.id]); return; }
    const n = count(s.id);
    if (n > 0) { push("Move " + n + (n === 1 ? " task" : " tasks") + " out of " + s.name + " first"); return; }
    setStages(stages.filter((x) => x.id !== s.id));
    push('Stage "' + s.name + '" removed');
  };

  const addStage = () => {
    const st = {
      id: "stage-" + Date.now().toString(36),
      name: "New stage",
      color: NEW_STAGE_COLORS[stages.length % NEW_STAGE_COLORS.length],
    };
    const next = [...stages];
    const doneIdx = next.findIndex((s) => s.id === "done");
    next.splice(doneIdx < 0 ? next.length : doneIdx, 0, st);
    setStages(next);
    setEditingId(st.id);
    push("Stage added — it appears on the board immediately");
  };

  const drop = (targetId) => {
    const src = dragId;
    setDragId(null); setOverId(null);
    if (!src || src === targetId) return;
    let next = [...stages];
    const [moved] = next.splice(next.findIndex((s) => s.id === src), 1);
    next.splice(next.findIndex((s) => s.id === targetId), 0, moved);
    // triage stays first, done stays last
    next = [next.find((s) => s.id === "triage"), ...next.filter((s) => s.id !== "triage" && s.id !== "done"), next.find((s) => s.id === "done")].filter(Boolean);
    setStages(next);
    push("Stage order updated — board columns follow");
  };

  return (
    <div className="panel">
      <div className="panel-head"><Icon name="branch" /><h2>Workflow stages</h2>
        <span className="right sub" style={{ fontSize: ".76rem", color: "var(--faint)" }}>{stages.length} stages</span>
      </div>
      <div className="stg-list">
        {stages.map((s) => {
          const locked = STAGE_LOCK[s.id];
          const n = count(s.id);
          return (
            <div
              className={"stg-row" + (dragId === s.id ? " dragging" : "") + (overId === s.id && dragId !== s.id ? " over" : "")}
              key={s.id}
              draggable={!locked && editingId !== s.id}
              onDragStart={(e) => { setDragId(s.id); e.dataTransfer.effectAllowed = "move"; }}
              onDragOver={(e) => { e.preventDefault(); if (overId !== s.id) setOverId(s.id); }}
              onDragLeave={() => { if (overId === s.id) setOverId(null); }}
              onDrop={() => drop(s.id)}
              onDragEnd={() => { setDragId(null); setOverId(null); }}
            >
              <span className={"stg-handle" + (locked ? " off" : "")} title={locked ? s.name + " is fixed — " + locked : "Drag to reorder"}>
                <Icon name={locked ? "lock" : "grip"} />
              </span>
              <span className="sdot" style={{ background: s.color }}></span>
              {editingId === s.id ? (
                <input
                  type="text" className="stg-input" defaultValue={s.name} autoFocus
                  onFocus={(e) => e.target.select()}
                  onBlur={(e) => commitName(s, e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") e.target.blur(); if (e.key === "Escape") setEditingId(null); }}
                />
              ) : (
                <button type="button" className="stg-name" onClick={() => setEditingId(s.id)} title="Rename stage">{s.name}</button>
              )}
              <span className="stg-count">{n} {n === 1 ? "task" : "tasks"}</span>
              <button type="button" className={"stg-x" + (locked ? " off" : "")} aria-label={"Remove " + s.name} title={locked ? s.name + " can't be removed" : "Remove stage"} onClick={() => remove(s)}>
                <Icon name="x" />
              </button>
            </div>
          );
        })}
      </div>
      <button type="button" className="btn ghost sm" style={{ width: "100%", marginTop: ".8rem" }} onClick={addStage}><Icon name="plus" />Add stage</button>
      <div className="pol-note" style={{ marginBottom: 0, marginTop: ".8rem" }}>
        <Icon name="shield" />
        <span>Drag to reorder · click a name to rename. Who may move tasks between stages is set in <button type="button" className="keybtn" onClick={() => onNav("policy")}>Policy → Workflow rules</button></span>
      </div>
    </div>
  );
}

/* ---------- Members ---------- */
const MEMBER_TONES = ["", "rose", "teal", "violet"];
function MembersPanel({ members, setMembers, onNav, push }) {
  const [nm, setNm] = useStateS("");
  const [em, setEm] = useStateS("");
  const me = "Arda Kaya";
  const pending = members.filter((m) => m.status === "invited").length;

  const invite = () => {
    const name = nm.trim(), email = em.trim().toLowerCase();
    if (!name || !email.includes("@")) { push("Enter a name and a valid email"); return; }
    if (members.some((m) => m.email === email)) { push(email + " is already a member"); return; }
    const initials = name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
    const p = { name, initials, tone: MEMBER_TONES[members.length % MEMBER_TONES.length] };
    setMembers([...members, { p, email, role: "viewer", status: "invited" }]);
    setNm(""); setEm("");
    push("Invite sent to " + email + " · joins as Viewer");
  };

  const remove = (m) => {
    if (m.p.name === me) { push("You can't remove yourself from Viberr Core"); return; }
    if (m.role === "admin" && members.filter((x) => x.role === "admin").length <= 1) { push(m.p.name + " is the only admin — assign another admin in Policy first"); return; }
    setMembers(members.filter((x) => x.email !== m.email));
    push(m.status === "invited" ? "Invite revoked · " + m.email : m.p.name + " removed from Viberr Core");
  };

  return (
    <div className="panel">
      <div className="panel-head"><Icon name="user" /><h2>Members</h2>
        <span className="right sub" style={{ fontSize: ".76rem", color: "var(--faint)" }}>
          {members.length - pending} active{pending > 0 ? " · " + pending + " invited" : ""}
        </span>
      </div>
      <div className="member-list" style={{ marginBottom: 0 }}>
        {members.map((m) => (
          <div className="member-row" key={m.email}>
            <Avatar person={m.p} />
            <span className="member-main">
              <div className="nm">{m.p.name}{m.p.name === me && <span className="you-tag">you</span>}</div>
              <div className="em">{m.email}</div>
            </span>
            {m.status === "invited" && <Pill kind="input" sm>invite pending</Pill>}
            <button type="button" className="stg-x" aria-label={"Remove " + m.p.name} title={m.status === "invited" ? "Revoke invite" : "Remove member"} onClick={() => remove(m)}>
              <Icon name="x" />
            </button>
          </div>
        ))}
      </div>
      <div className="invite-row">
        <input type="text" placeholder="Full name" value={nm} onChange={(e) => setNm(e.target.value)} />
        <input type="text" placeholder="email@company.dev" value={em} onChange={(e) => setEm(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") invite(); }} />
        <button type="button" className="btn sm" onClick={invite}><Icon name="send" />Invite</button>
      </div>
      <div className="pol-note" style={{ marginBottom: 0, marginTop: ".8rem" }}>
        <Icon name="shield" />
        <span>New members join as Viewer. Roles are managed in <button type="button" className="keybtn" onClick={() => onNav("policy")}>Policy → Human access</button></span>
      </div>
    </div>
  );
}

/* ---------- Repository & credentials ---------- */
function RepoSettings({ P, override, onOverride, scopeGranted, onGrantScope, onOpen }) {
  const missing = P.repo.scopes.find((s) => !s.ok);
  return (
    <div className="panel">
      <div className="panel-head"><Icon name="github" /><h2>Repository &amp; credentials</h2></div>
      <div className="kv">
        <div className="kv-row"><span className="k">Default repository</span><span className="v"><Icon name="github" /><span className="mono">{P.repo.name}</span></span></div>
        <div className="kv-row">
          <span className="k">Task-level override</span>
          <span className="v" style={{ gap: ".6rem" }}>
            <span style={{ fontSize: ".78rem", color: "var(--faint)", fontFamily: "var(--font-body)", fontWeight: 400 }}>{override ? "tasks may attach a different repo" : "all tasks use the default"}</span>
            <TglP on={override} onChange={onOverride} label="Task-level repository override" />
          </span>
        </div>
        <div className="kv-row"><span className="k">Repos per task</span><span className="v">1 · V1 limit</span></div>
      </div>

      <div className="cred-card">
        <div className="cred-top">
          <Icon name="lock" />
          <span className="cred-name">{P.repo.credential}</span>
          <span className="mono" style={{ marginLeft: "auto", color: "var(--faint)" }}>{P.repo.masked}</span>
        </div>
        <div className="scope-chips">
          {P.repo.scopes.map((s) => {
            const ok = s.ok || scopeGranted;
            return (
              <span className={"scope-chip" + (ok ? "" : " miss")} key={s.id}>
                <Icon name={ok ? "check" : "alert"} />{s.id}
              </span>
            );
          })}
        </div>
        {missing && !scopeGranted ? (
          <div className="cred-warn">
            <Icon name="alert" />
            <span>Missing <code className="mono">{missing.id}</code> — PR status can't auto-sync after merge. Flagged on</span>
            <button type="button" className="keybtn" onClick={() => onOpen(missing.task)}>{missing.task}</button>
            <button type="button" className="btn sm" style={{ marginLeft: "auto" }} onClick={onGrantScope}><Icon name="check" />Grant scope</button>
          </div>
        ) : (
          <div className="cred-ok"><Icon name="check" />All required scopes granted. Secrets stay isolated from task records and timelines.</div>
        )}
      </div>
    </div>
  );
}

/* ---------- Danger zone ---------- */
function DangerZone({ push }) {
  const deny = (what) => push(what + " is admin-only — you're signed in as a maintainer");
  return (
    <div className="panel danger-panel">
      <div className="panel-head"><Icon name="alert" /><h2>Danger zone</h2></div>
      <div className="dz-row">
        <span className="dz-main">
          <div className="dn">Archive Viberr Core</div>
          <div className="dd">Board becomes read-only, running agents stop, timelines are preserved.</div>
        </span>
        <button type="button" className="btn ghost sm" onClick={() => deny("Archiving")}>Archive</button>
      </div>
      <div className="dz-row">
        <span className="dz-main">
          <div className="dn">Delete project</div>
          <div className="dd">Removes tasks, timelines, and audit logs. This cannot be undone.</div>
        </span>
        <button type="button" className="btn danger sm" onClick={() => deny("Deletion")}>Delete project</button>
      </div>
    </div>
  );
}

/* ---------- root ---------- */
function Settings({ tasks, stages, setStages, members, setMembers, onOpen, onNav, push, scopeGranted, onGrantScope }) {
  const P = window.VIBERR.policy;
  const [override, setOverride] = useStateS(P.repo.override);
  const toggleOverride = () => {
    setOverride((v) => !v);
    push(override ? "Task-level repo override disabled" : "Task-level repo override enabled");
  };
  return (
    <div className="board-wrap" data-screen-label="Settings">
      <div className="board-head">
        <div>
          <h1>Settings</h1>
          <div className="sub">Board configuration for Viberr Core</div>
        </div>
      </div>
      <div className="policy-wrap">
        <div className="policy-cols">
          <ProjectSettings push={push} />
          <StageSettings tasks={tasks} stages={stages} setStages={setStages} onNav={onNav} push={push} />
        </div>
        <div className="policy-cols">
          <MembersPanel members={members} setMembers={setMembers} onNav={onNav} push={push} />
          <RepoSettings P={P} override={override} onOverride={toggleOverride} scopeGranted={scopeGranted} onGrantScope={onGrantScope} onOpen={onOpen} />
        </div>
        <DangerZone push={push} />
      </div>
    </div>
  );
}

Object.assign(window, { Settings });
