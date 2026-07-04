/* Viberr — Task detail (operator-first) */
const { useState: useStateT, useMemo: useMemoT, useRef: useRefT } = React;

/* ---------- Decision packet ---------- */
function DecisionPacket({ task, onResolve, onAsk }) {
  const p = task.packet;
  const [sel, setSel] = useStateT(Math.max(0, p.options.findIndex((o) => o.rec)));
  const isBlocked = p.type === "blocked";
  return (
    <div className={"packet " + (isBlocked ? "blocked" : "input")}>
      <div className="packet-top">
        <Pill kind={isBlocked ? "blocked" : "input"} dot>{p.kind}</Pill>
        <span className="from">
          from <span className="agent-glyph op"><Icon name="shield" /></span> <strong style={{ fontFamily: "var(--font-display)" }}>{p.from}</strong>
        </span>
      </div>
      <div className="packet-body">
        <h2>{p.title}</h2>
        <p style={{ color: "var(--muted)", fontSize: ".92rem", lineHeight: 1.55, margin: 0 }}>{p.body}</p>

        <div className="packet-obs">
          {p.observations.map((o, i) => (
            <div className="obs" key={i}>
              <span className="k">{o.k}</span>
              <span>{o.code ? <code>{o.v}</code> : o.v}</span>
            </div>
          ))}
        </div>

        <div className="options" role="radiogroup" aria-label="Decision options">
          {p.options.map((o, i) => (
            <button key={i} role="radio" aria-checked={sel === i} className={"opt" + (sel === i ? " sel" : "") + (o.rec ? " recommend" : "")} onClick={() => setSel(i)}>
              <span className="radio" />
              <span>
                <div className="ot">{o.t}</div>
                <div className="od">{o.d}</div>
              </span>
              {o.rec && <span className="rec-tag"><Pill kind="info" sm>operator pick</Pill></span>}
            </button>
          ))}
        </div>

        <div className="packet-actions">
          <button className="btn primary" onClick={() => onResolve({ option: p.options[sel], packet: p })}>
            <Icon name="check" />{p.options[sel] ? p.options[sel].t : "Confirm"}
          </button>
          <button className="btn ghost" onClick={onAsk}>
            <Icon name="message" />Ask operator
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------- Owner control: assign / take over / hand off / release ---------- */
function OwnerControl({ task, me, myRole, onOwner, onRelease }) {
  const o = task.owner;
  const mine = !!(o && me && o.name === me.name);
  const admin = myRole === "admin";
  const [open, setOpen] = useStateT(false);
  const ref = useRefT(null);
  React.useEffect(() => {
    if (!open) return;
    const f = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", f);
    return () => document.removeEventListener("mousedown", f);
  }, [open]);
  if (!o) {
    return (
      <button type="button" className="rev-add" onClick={() => onOwner("take")} title="Take ownership — review & acceptance, this task only">
        <Icon name="plus" />Assign me
      </button>
    );
  }
  const members = (window.VIBERR.policy.members || []).filter((m) => m.status === "active" && m.p.name !== o.name && m.p.name !== (me && me.name));
  return (
    <div className="own-wrap" ref={ref}>
      <button type="button" className={"own-btn" + (open ? " open" : "")} onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open}>
        Manage<Icon name="chevron" />
      </button>
      {open && (
        <div className="own-menu" role="menu" aria-label="Manage task ownership">
          {!mine && (
            <button type="button" className="menu-item" role="menuitem" onClick={() => { setOpen(false); onOwner("take"); }}>
              <Icon name="user" />Take over ownership
            </button>
          )}
          {members.length > 0 && <div className="own-lbl">Hand off to</div>}
          {members.map((m) => (
            <button type="button" className="menu-item" role="menuitem" key={m.p.name} onClick={() => { setOpen(false); onOwner("assign", m.p); }}>
              <Avatar person={m.p} />{m.p.name}<span className="own-role">{m.role}</span>
            </button>
          ))}
          {mine && (
            <React.Fragment>
              <div className="menu-sep" />
              <button type="button" className="menu-item danger" role="menuitem" onClick={() => { setOpen(false); onRelease(); }}>
                <Icon name="x" />Release ownership…
              </button>
            </React.Fragment>
          )}
          {!mine && admin && (
            <React.Fragment>
              <div className="menu-sep" />
              <button type="button" className="menu-item danger" role="menuitem" onClick={() => { setOpen(false); onRelease(); }}>
                <Icon name="x" />Release {o.name.split(" ")[0]}…<span className="own-role">admin</span>
              </button>
            </React.Fragment>
          )}
        </div>
      )}
    </div>
  );
}

function ReleaseConfirm({ task, me, myRole, onCancel, onConfirm, onOwner }) {
  React.useEffect(() => {
    const f = (e) => { if (e.key === "Escape") onCancel(); };
    window.addEventListener("keydown", f);
    return () => window.removeEventListener("keydown", f);
  }, []);
  const o = task.owner || me;
  const mine = !!(me && o.name === me.name);
  const packet = task.packet;
  const members = (window.VIBERR.policy.members || [])
    .filter((m) => m.status === "active" && m.p.name !== o.name)
    .sort((a, b) => (me && b.p.name === me.name ? 1 : 0) - (me && a.p.name === me.name ? 1 : 0));
  return (
    <React.Fragment>
      <div className="confirm-scrim" onClick={onCancel}></div>
      <div className="modal-card release-card" role="alertdialog" aria-modal="true" aria-label={"Release ownership of " + task.key} data-screen-label="Release ownership dialog">
        <div className="modal-head">
          <span className="agent-glyph lg warn"><Icon name="hand" /></span>
          <div className="mh-main">
            <h2>Release ownership?</h2>
            <div className="mh-sub"><span className="mono">{task.key}</span> · {task.title}</div>
          </div>
          <button className="icon-btn modal-close" onClick={onCancel} aria-label="Close"><Icon name="x" /></button>
        </div>
        <div className="modal-body" style={{ gap: "1.05rem" }}>
          <div className="packet-obs" style={{ margin: 0 }}>
            <div className="obs"><span className="k">Owner</span><span className="rel-owner"><Avatar person={o} /><strong>{o.name}</strong><span style={{ color: "var(--faint)" }}>{mine ? "· you" : ""}</span>{!mine && <Pill kind="info" sm>admin release</Pill>}</span></div>
            <div className="obs"><span className="k">Open now</span><span>
              {packet
                ? <span className="rel-open"><Pill kind={packet.type === "blocked" ? "blocked" : "input"} sm dot>{packet.kind}</Pill> waiting on the owner</span>
                : task.waiting === "human" ? "A human decision is pending on this task" : "Agent work in progress — no boundary is waiting"}
            </span></div>
            <div className="obs"><span className="k">After</span><span>Unowned — review & acceptance stall until another member takes the seat</span></div>
          </div>
          {members.length > 0 && (
            <div>
              <div className="rel-lbl">Hand off instead — keeps the boundary owned</div>
              <div className="rel-row">
                {members.map((m) => {
                  const isMe = !!(me && m.p.name === me.name);
                  return (
                    <button type="button" className="handoff-chip" key={m.p.name} onClick={() => { onCancel(); onOwner(isMe ? "take" : "assign", m.p); }}>
                      <Avatar person={m.p} /><span className="nm">{m.p.name.split(" ")[0]}{isMe ? " · you" : ""}</span><span className="rl">{m.role}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
        <div className="modal-foot">
          <span className="foot-hint">{mine ? "Recorded as a typed ownership event on the timeline." : "Admin release — recorded as a typed event and in the audit trail."}</span>
          <div className="foot-actions">
            <button className="btn ghost" onClick={onCancel}>{mine ? "Keep ownership" : "Cancel"}</button>
            <button className="btn danger" onClick={onConfirm}><Icon name="x" />{mine ? "Release" : "Release " + o.name.split(" ")[0]}</button>
          </div>
        </div>
      </div>
    </React.Fragment>
  );
}

/* ---------- Execution profile ---------- */
function ExecutionProfile({ task, me, myRole, onOwner, onRelease }) {
  const sp = task.specialist;
  const o = task.owner;
  const mine = !!(o && me && o.name === me.name);
  return (
    <div className="panel">
      <div className="panel-head">
        <Icon name="agents" />
        <h2>Execution profile</h2>
        <span className="right"><Pill kind="agent" dot>operator active</Pill></span>
      </div>
      <div className="profile-grid">
        <div className="profile-cell">
          <div className="lbl">Operator</div>
          <div className="val">
            <span className="agent-glyph"><Icon name="shield" /></span>
            <span><div className="nm">Operator</div><div className="sub">coordinator · {task.operator ? task.operator.since : "—"}</div></span>
          </div>
        </div>
        <div className="profile-cell">
          <div className="lbl">Primary specialist</div>
          <div className="val">
            {sp
              ? <React.Fragment><AgentGlyph backend={sp.backend} /><span><div className="nm">{sp.name}</div><div className="sub">{sp.role} · {sp.backend === "claude" ? "Claude Code" : "Codex"}</div></span></React.Fragment>
              : <span className="sub">None yet — the operator assigns one when execution starts</span>}
          </div>
        </div>
        <div className="profile-cell">
          <div className="lbl">Consultants</div>
          <div className="val">
            {task.consultants && task.consultants.length
              ? <div className="consultants">
                  {task.consultants.map((c, i) => (
                    <span className="who-chip" key={i} style={{ padding: ".25rem .5rem", border: "1px solid var(--hairline)", borderRadius: "999px" }}>
                      <AgentGlyph backend={c.backend} /><span className="nm" style={{ fontSize: ".8rem" }}>{c.name} · {c.role}</span>
                    </span>
                  ))}
                </div>
              : <span className="sub">None engaged</span>}
          </div>
        </div>
        <div className="profile-cell">
          <div className="lbl">Human owner · reviews & accepts</div>
          <div className="val">
            <div className="rev-row">
              {o && (
                <span className="rev-chip">
                  <Avatar person={o} />
                  <span className="nm">{o.name}{mine ? " · you" : ""}</span>
                </span>
              )}
              {!o && <span className="sub">Unowned — open to any project member</span>}
              <OwnerControl task={task} me={me} myRole={myRole} onOwner={onOwner} onRelease={onRelease} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------- Timeline ---------- */
const EVENT_META = {
  comment:    { node: "", icon: "message", label: "commented" },
  completion: { node: "completion", icon: "check", label: "Completion report" },
  github:     { node: "github", icon: "github", label: "GitHub" },
  policy:     { node: "policy", icon: "shield", label: "Policy violation" },
  quality:    { node: "quality", icon: "flag", label: "Quality flag" },
  transition: { node: "transition", icon: "arrow", label: "Transition request" },
  blocked:    { node: "blocked", icon: "alert", label: "Blocked decision" },
  agent:      { node: "agent", icon: "agents", label: "Operator" },
  assign:     { node: "transition", icon: "user", label: "Ownership" },
};

function RichText({ text }) {
  // bold **x**, code `x`, and @mentions
  const parts = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|@[A-Za-z][\w-]*)/g;
  let last = 0, m, i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("**")) parts.push(<strong key={i++}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith("`")) parts.push(<code key={i++} className="mono">{tok.slice(1, -1)}</code>);
    else parts.push(<span key={i++} className="mention">{tok}</span>);
    last = m.index + tok.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <React.Fragment>{parts}</React.Fragment>;
}

function TimelineItem({ ev }) {
  const meta = EVENT_META[ev.type] || EVENT_META.comment;
  const actor = ev.actor;
  const isTyped = ev.type !== "comment";
  return (
    <div className="tl-item">
      <div className="tl-rail">
        <div className={"tl-node " + meta.node}><Icon name={meta.icon} /></div>
        <div className="tl-line" />
      </div>
      <div className="tl-body">
        <div className="tl-meta">
          <span className="tl-actor">{actor.name}{actor.role ? " · " + actor.role : ""}</span>
          {isTyped && <Pill kind={typedKind(ev.type)} sm>{meta.label}</Pill>}
          {actor.kind === "agent" && <Pill kind="agent" sm>agent</Pill>}
          {actor.kind === "human" && actor.guest && <Pill kind="neutral" sm>app user · not in project</Pill>}
          <span className="tl-time">{ev.day && ev.day !== "Today" ? ev.day + " · " + ev.t : ev.t}</span>
        </div>

        {ev.type === "comment" ? (
          <div className={"comment-card" + (ev.to === "agent" ? " toagent" : "")}>
            <div className="tl-text"><RichText text={ev.text} /></div>
          </div>
        ) : (
          <React.Fragment>
            {ev.title && <div className="tl-text"><strong>{ev.title}</strong></div>}
            <div className="tl-text"><RichText text={ev.text} /></div>
            {ev.evidence && (
              <div className="tl-card evidence">
                {ev.evidence.map((e, i) => (
                  <div className="ev-row" key={i}>
                    <span>{e.label}</span>
                    <span><span className="add">{e.add}</span> <span className="del">{e.del}</span></span>
                  </div>
                ))}
              </div>
            )}
          </React.Fragment>
        )}
      </div>
    </div>
  );
}

function typedKind(type) {
  return { completion: "done", github: "neutral", policy: "input", quality: "risk", transition: "info", blocked: "blocked", agent: "agent", assign: "info" }[type] || "neutral";
}

const TL_FILTERS = [
  { id: "all", label: "All" },
  { id: "typed", label: "Important events" },
  { id: "comment", label: "Comments" },
];

function Timeline({ task, extra, onComment, ask }) {
  const [f, setF] = useStateT((window.VIBERR.prefs && window.VIBERR.prefs.tlDefault) || "all");
  const [draft, setDraft] = useStateT("");
  const taRef = useRefT(null);
  const seenAsk = useRefT(ask);
  React.useEffect(() => {
    if (ask && ask !== seenAsk.current) {
      seenAsk.current = ask;
      setDraft((d) => (d.trim() ? d : "@operator "));
      if (taRef.current) taRef.current.focus();
    }
  }, [ask]);
  const all = useMemoT(() => [...(extra || []), ...task.timeline], [task, extra]);
  const items = all.filter((e) => f === "all" ? true : f === "comment" ? e.type === "comment" : e.type !== "comment");

  const send = () => {
    if (!draft.trim()) return;
    onComment(draft.trim());
    setDraft("");
  };

  return (
    <div className="panel">
      <div className="panel-head">
        <Icon name="activity" />
        <h2>Timeline</h2>
        <span className="right tl-filter">
          {TL_FILTERS.map((x) => (
            <button key={x.id} className={f === x.id ? "on" : ""} onClick={() => setF(x.id)}>{x.label}</button>
          ))}
        </span>
      </div>

      <div className="composer">
        <div className="composer-box">
          <textarea ref={taRef} placeholder="Add a comment… type @ to tag the operator, an agent, or a teammate" value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send(); }} />
          <div className="composer-foot">
            <span style={{ fontSize: ".72rem", color: "var(--placeholder)" }}>Open to every registered user · @mentions route to agents</span>
            <span style={{ marginLeft: "auto", fontSize: ".72rem", color: "var(--placeholder)" }} className="mono">⌘↵ to send</span>
            <button className="btn primary sm" onClick={send}><Icon name="send" />Comment</button>
          </div>
        </div>
      </div>

      <div className="timeline" style={{ marginTop: "1.1rem" }}>
        {items.length === 0
          ? <div className="empty">No activity yet — this task hasn't started its operator loop.</div>
          : items.map((ev, i) => <TimelineItem key={i} ev={ev} />)}
      </div>
    </div>
  );
}

/* ---------- Side panels ---------- */
function GithubTrace({ task, push }) {
  if (!task.branch && !task.pr) {
    return (
      <div className="panel">
        <div className="panel-head"><Icon name="github" /><h2>GitHub</h2></div>
        <div className="empty" style={{ padding: "1rem .5rem" }}>No branch yet. A task-key branch is created when execution starts.</div>
      </div>
    );
  }
  return (
    <div className="panel flush">
      <div className="gh-bar">
        <Icon name="github" />
        <span className="repo">{task.repo}</span>
        {task.pr
          ? <Pill kind={task.pr.state === "merged" ? "done" : "info"} sm>{task.pr.state === "merged" ? "merged" : "PR #" + task.pr.number}</Pill>
          : <Pill kind="neutral" sm>no PR</Pill>}
      </div>
      <div className="gh-body">
        <div className="kv-row"><span className="k">Branch</span><span className="v"><Icon name="branch" /><span className="mono">{task.branch}</span></span></div>
        {task.changed && <div className="kv-row"><span className="k">Diff</span><span className="v mono">{task.changed.files} files · <span style={{ color: "var(--teal-dark)" }}>+{task.changed.add}</span> <span style={{ color: "var(--coral-dark)" }}>−{task.changed.del}</span></span></div>}
        {task.commits && task.commits.length > 0 && (
          <div style={{ marginTop: ".7rem" }}>
            <div className="lbl" style={{ fontSize: ".68rem", fontWeight: 900, letterSpacing: ".05em", textTransform: "uppercase", color: "var(--placeholder)", marginBottom: ".3rem" }}>Commits</div>
            {task.commits.map((c, i) => (
              <div className="commit" key={i}><span className="sha">{c.sha}</span><span className="msg">{c.msg}</span></div>
            ))}
          </div>
        )}
        <button className="btn ghost sm" style={{ marginTop: ".8rem", width: "100%" }} onClick={() => push && push("External links are stubbed in this prototype")}><Icon name="ext" />Open on GitHub</button>
      </div>
    </div>
  );
}

function PolicyPanel({ task, myRole, onPolicy }) {
  const admin = myRole === "admin";
  const rows = [
    { k: "Your role", v: (myRole || "viewer").charAt(0).toUpperCase() + (myRole || "viewer").slice(1), icon: "user" },
    { k: "Task owner", v: "Reviews & accepts · that task only", icon: "flag" },
    { k: "Ownership", v: admin ? "Take / release · admin: anyone" : "Take / release · yours", icon: "plus" },
    { k: "Comments", v: "Every registered user", icon: "message" },
    { k: "Agent may", v: "Request transition", icon: "cpu" },
    { k: "Transition to done", v: "Human owner only", icon: "lock" },
  ];
  return (
    <div className="panel">
      <div className="panel-head"><Icon name="shield" /><h2>Permissions</h2></div>
      {rows.map((r, i) => (
        <div className="policy-line" key={i}>
          <span className="k"><Icon name={r.icon} />{r.k}</span>
          <span className="v">{r.v}</span>
        </div>
      ))}
      <button className="btn ghost sm" style={{ width: "100%", marginTop: ".8rem" }} onClick={onPolicy}><Icon name="shield" />View project policy</button>
    </div>
  );
}

/* ---------- Task detail root ---------- */
function TaskDetail({ task, onComment, onResolve, onAsk, ask, extraEvents, onPolicy, push, me, myRole, onOwner }) {
  const stage = window.VIBERR.stages.find((s) => s.id === task.stage) || {};
  const runtime = (window.VIBERR.runtime || {})[task.key] || [];
  const [logSel, setLogSel] = useStateT(null);
  const [releasing, setReleasing] = useStateT(false);
  return (
    <div className="detail" key={task.key} data-screen-label={"Task " + task.key}>
      <div className="detail-main">
        <div className="task-hero">
          <span className="key">{task.key}</span>
          <h1>{task.title}</h1>
          <div className="hero-meta">
            <Pill kind="neutral"><span className="col-stage-dot" style={{ background: stage.color, width: ".5rem", height: ".5rem" }} />{stage.name}</Pill>
            <ReadinessPill value={task.readiness} />
            <ValidationPill value={task.validation} />
            <span className="hero-file"><Icon name="file" /><span>{".viberr/tasks/" + task.key + "/task.md"}</span></span>
          </div>
          <p className="goal">{task.goal}</p>
        </div>

        <LiveRunPanel runtime={runtime} onViewLogs={(id) => setLogSel(id)} push={push} />

        {task.packet && <DecisionPacket task={task} onResolve={onResolve} onAsk={onAsk} />}

        <ExecutionProfile task={task} me={me} myRole={myRole} onOwner={onOwner} onRelease={() => setReleasing(true)} />

        <AgentLogsPanel runtime={runtime} sel={logSel} onSel={setLogSel} />

        <Timeline task={task} extra={extraEvents} onComment={onComment} ask={ask} />
      </div>

      <div className="detail-side">
        <GithubTrace task={task} push={push} />
        <div className="panel">
          <div className="panel-head"><Icon name="bolt" /><h2>Current state</h2></div>
          <div className="kv">
            <div className="kv-row"><span className="k">Stage</span><span className="v">{stage.name}</span></div>
            <div className="kv-row"><span className="k">Waiting on</span><span className="v">{task.waiting === "human" ? <span style={{ color: "var(--blue-pressed)" }}>Human decision</span> : task.waiting === "agent" ? <span style={{ color: "var(--agent-dark)" }}>Agent work</span> : "Nothing"}</span></div>
            <div className="kv-row"><span className="k">Owner</span><span className="v">
              {task.owner
                ? <span className="rev-stack" title="Human owner — reviews & accepts, this task only">
                    <Avatar person={task.owner} />
                    <span className="rs-names">{task.owner.name.split(" ")[0]}{me && task.owner.name === me.name ? " (you)" : ""}</span>
                    {me && (task.owner.name === me.name || myRole === "admin") && (
                      <button type="button" className="own-x" title={task.owner.name === me.name ? "Release ownership" : "Release " + task.owner.name.split(" ")[0] + " (admin)"} aria-label="Release owner" onClick={() => setReleasing(true)}><Icon name="x" /></button>
                    )}
                  </span>
                : <button type="button" className="rev-add sm" onClick={() => onOwner("take")}><Icon name="plus" />Assign me</button>}
            </span></div>
            <div className="kv-row"><span className="k">Repo</span><span className="v mono">{task.repo}</span></div>
          </div>
        </div>
        <PolicyPanel task={task} myRole={myRole} onPolicy={onPolicy} />
      </div>
      {releasing && <ReleaseConfirm task={task} me={me} myRole={myRole} onCancel={() => setReleasing(false)} onConfirm={() => { setReleasing(false); onOwner("release"); }} onOwner={onOwner} />}
    </div>
  );
}

Object.assign(window, { TaskDetail });
