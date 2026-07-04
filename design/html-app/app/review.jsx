/* Viberr — Review queue: the human acceptance boundary (FR25–FR27) */

function rqStripMd(s) { return (s || "").replace(/\*\*/g, "").replace(/`/g, ""); }

function RQRow({ t, onOpen, ready }) {
  const sub = t.packet
    ? t.packet.kind + " — " + t.packet.title
    : (t.timeline && t.timeline.length
      ? rqStripMd(t.timeline[0].text)
      : "Agent working — the packet arrives at the boundary.");
  return (
    <button className="rq-row" onClick={() => onOpen(t.key)}>
      <span className="rq-key">{t.key}</span>
      <span className="rq-main">
        <div className="ttl">{t.title}</div>
        <div className="sub">{sub}</div>
      </span>
      <span className="rq-meta">
        {t.pr && <Pill kind={t.pr.state === "merged" ? "done" : "info"} sm>PR #{t.pr.number}</Pill>}
        <ValidationPill value={t.validation} sm />
        {ready
          ? <span className="wait-tag human"><Icon name="hand" />your acceptance</span>
          : <span className="wait-tag agent"><span className="working" />agent working</span>}
      </span>
    </button>
  );
}

function ReviewQueue({ tasks, onOpen, onPolicy }) {
  const inReview = tasks.filter((t) => t.stage === "review");
  const ready = inReview.filter((t) => t.waiting === "human");
  const working = inReview.filter((t) => t.waiting !== "human");
  return (
    <div className="board-wrap" data-screen-label="Review queue">
      <div className="board-head">
        <div>
          <h1>Review queue</h1>
          <div className="sub">{inReview.length} task{inReview.length === 1 ? "" : "s"} at the review boundary · {ready.length} waiting on your acceptance</div>
        </div>
        <div className="board-tools">
          <button type="button" className="hero-file" style={{ cursor: "pointer" }} onClick={onPolicy} title="Review → Done is locked to humans — see Policy">
            <Icon name="lock" /><span>Review → Done · human only</span>
          </button>
        </div>
      </div>

      <div className="policy-wrap">
        <div className="panel">
          <div className="panel-head"><Icon name="hand" /><h2>Waiting on your acceptance</h2>
            <span className="right sub" style={{ fontSize: ".76rem", color: "var(--faint)" }}>{ready.length} of {inReview.length}</span>
          </div>
          {ready.length
            ? <div className="rq-list">{ready.map((t) => <RQRow key={t.key} t={t} onOpen={onOpen} ready />)}</div>
            : <div className="empty">Nothing waits on you. Completion reports land here when a task reaches the boundary.</div>}
          <div className="pol-note" style={{ marginBottom: 0, marginTop: ".9rem" }}>
            <Icon name="lock" />
            <span>Accepting a completion merges the review PR and moves the task to <strong>Done</strong> — always a human action, always in the audit log.</span>
          </div>
        </div>

        <div className="panel">
          <div className="panel-head"><Icon name="activity" /><h2>Still with agents</h2>
            <span className="right sub" style={{ fontSize: ".76rem", color: "var(--faint)" }}>{working.length}</span>
          </div>
          {working.length
            ? <div className="rq-list">{working.map((t) => <RQRow key={t.key} t={t} onOpen={onOpen} />)}</div>
            : <div className="empty">No review work in flight.</div>}
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { ReviewQueue });
