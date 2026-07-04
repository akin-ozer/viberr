/* Viberr — GitHub view: repository health, branch & PR traceability (FR29–FR32) */

function ghSync(t) {
  if (t.validation === "failing") return { label: "behind main", kind: "risk" };
  if (t.pr && t.pr.state === "merged") return { label: "merged", kind: "done" };
  return { label: "synced", kind: "ready" };
}

function GithubView({ tasks, onOpen, onNav, push, scopeGranted }) {
  const P = window.VIBERR.policy;
  const branches = tasks.filter((t) => t.branch);
  const prs = tasks.filter((t) => t.pr);
  const missing = P.repo.scopes.find((s) => !s.ok);
  const rescan = () => {
    push("Reconciling branches and PRs with GitHub…");
    setTimeout(() => push("Reconciled — every branch and PR maps to its task key"), 1000);
  };
  return (
    <div className="board-wrap" data-screen-label="GitHub">
      <div className="board-head">
        <div>
          <h1>GitHub</h1>
          <div className="sub">Execution surface for Viberr Core — branches, pull requests, and credential health</div>
        </div>
        <div className="board-tools">
          <button className="btn ghost sm" onClick={rescan} title="Reconcile task state with GitHub"><Icon name="refresh" />Reconcile</button>
          <button className="btn ghost sm" onClick={() => push("External links are stubbed in this prototype")}><Icon name="ext" />Open on GitHub</button>
        </div>
      </div>

      <div className="policy-wrap">
        <div className="policy-cols">
          <div className="panel">
            <div className="panel-head"><Icon name="github" /><h2>Repository</h2></div>
            <div className="kv">
              <div className="kv-row"><span className="k">Default repository</span><span className="v"><Icon name="github" /><span className="mono">{P.repo.name}</span></span></div>
              <div className="kv-row"><span className="k">Connection</span><span className="v"><Pill kind="ready" dot sm>connected</Pill></span></div>
              <div className="kv-row"><span className="k">Task attachment</span><span className="v" style={{ fontWeight: 400, fontFamily: "var(--font-body)", fontSize: ".8rem", color: "var(--faint)" }}>project default · task-level override allowed</span></div>
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
                  return <span className={"scope-chip" + (ok ? "" : " miss")} key={s.id}><Icon name={ok ? "check" : "alert"} />{s.id}</span>;
                })}
              </div>
              {missing && !scopeGranted
                ? <div className="cred-warn">
                    <Icon name="alert" />
                    <span>Missing <code className="mono">{missing.id}</code> — PR status can't auto-sync after merge. Flagged on</span>
                    <button type="button" className="keybtn" onClick={() => onOpen(missing.task)}>{missing.task}</button>
                    <button className="btn sm" style={{ marginLeft: "auto" }} onClick={() => onNav("settings")}><Icon name="sliders" />Fix in Settings</button>
                  </div>
                : <div className="cred-ok"><Icon name="check" />All required scopes granted. Secrets stay isolated from task records and timelines.</div>}
            </div>
          </div>

          <div className="panel">
            <div className="panel-head"><Icon name="pr" /><h2>Pull requests</h2>
              <span className="right sub" style={{ fontSize: ".76rem", color: "var(--faint)" }}>{prs.length} linked to tasks</span>
            </div>
            <div className="rq-list">
              {prs.map((t) => (
                <button className="rq-row" key={t.key} onClick={() => onOpen(t.key)}>
                  <span className="rq-key">#{t.pr.number}</span>
                  <span className="rq-main">
                    <div className="ttl">{t.pr.title}</div>
                    <div className="sub"><span className="mono">{t.branch}</span> → main · {t.key}</div>
                  </span>
                  <span className="rq-meta">
                    <Pill kind={t.pr.state === "merged" ? "done" : "info"} sm dot>{t.pr.state === "merged" ? "merged" : "in review"}</Pill>
                  </span>
                </button>
              ))}
            </div>
            <div className="pol-note" style={{ marginBottom: 0, marginTop: ".9rem" }}>
              <Icon name="lock" /><span>Merging stays reserved for humans — accepting a completion in the review queue merges its PR.</span>
            </div>
          </div>
        </div>

        <div className="panel">
          <div className="panel-head"><Icon name="branch" /><h2>Execution branches</h2>
            <span className="right sub" style={{ fontSize: ".76rem", color: "var(--faint)" }}>{branches.length} task-key branches</span>
          </div>
          <div className="gh-table">
            <div className="live-table">
              <div className="live-head"><span>Task</span><span>Execution branch</span><span>Pull request</span><span>Sync</span></div>
              {branches.map((t) => {
                const s = ghSync(t);
                return (
                  <button className="live-row" key={t.key} onClick={() => onOpen(t.key)}>
                    <span className="live-task"><span className="key mono">{t.key}</span> <span className="ttl">{t.title}</span></span>
                    <span className="trace ok" style={{ fontSize: ".74rem" }}><Icon name="branch" />{t.branch}</span>
                    <span>{t.pr
                      ? <Pill kind={t.pr.state === "merged" ? "done" : "info"} sm>#{t.pr.number}</Pill>
                      : <span style={{ color: "var(--placeholder)", fontSize: ".8rem" }}>—</span>}</span>
                    <span><Pill kind={s.kind} sm dot>{s.label}</Pill></span>
                  </button>
                );
              })}
            </div>
          </div>
          <div className="pol-note" style={{ marginBottom: 0, marginTop: ".9rem" }}>
            <Icon name="branch" /><span>Branch names and commit messages carry the task key — task → branch → commit → PR stays traceable without asking.</span>
          </div>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { GithubView });
