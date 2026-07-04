/* Viberr — instance-level settings (org admin, above boards).
   Sections: GitHub connections · Users & access · Agent resources.
   Exports: ORG_DEFAULTS, loadOrg, saveOrg, OrgSettings */
const { useState: useStateO, useRef: useRefO, useEffect: useEffectO } = React;

const ORG_LS = "viberr:org:v10";

const ORG_DEFAULTS = {
  connections: [
    { id: "akin-ozer", owner: "akin-ozer", method: "PAT", repos: 7, def: true, expires: "Jul 21, 2026", daysLeft: 18 },
    { id: "hepapi", owner: "hepapi", method: "PAT", repos: 12, def: false, expires: "Mar 1, 2027", daysLeft: 241 },
  ],
  users: [
    { id: "u-elif", name: "Elif Demir", email: "elif@viberr.dev", initials: "ED", tone: "rose", role: "admin", status: "active", idp: "github" },
    { id: "u-arda", name: "Arda Kaya", email: "arda@viberr.dev", initials: "AK", tone: "", role: "admin", status: "active", you: true, idp: "local" },
    { id: "u-murat", name: "Murat Yıldız", email: "murat@viberr.dev", initials: "MY", tone: "teal", role: "member", status: "active", idp: "google" },
    { id: "u-selin", name: "Selin Aksoy", email: "selin@viberr.dev", initials: "SA", tone: "violet", role: "member", status: "active", idp: "local" },
  ],
  domains: [
    { id: "d-1", domain: "@viberr.dev", role: "member" },
  ],
  kbs: [
    { id: "kb-arch", name: "Architecture notes", dir: "architecture-notes", refresh: "on change", last: "Jul 1", tree: [
      { type: "dir", name: "decisions", children: [
        { type: "file", name: "adr-001-task-store.md", size: "4.2 KB", added: "Mar 30" },
        { type: "file", name: "adr-002-operator-model.md", size: "6.8 KB", added: "Apr 14" },
        { type: "file", name: "adr-003-event-types.md", size: "3.1 KB", added: "May 2" },
      ] },
      { type: "dir", name: "diagrams", children: [
        { type: "file", name: "context-map.md", size: "2.4 KB", added: "Jun 11" },
      ] },
      { type: "file", name: "overview.md", size: "8.9 KB", added: "Jul 1" },
      { type: "file", name: "glossary.md", size: "5.5 KB", added: "Jun 20" },
    ] },
    { id: "kb-api", name: "API contracts", dir: "api-contracts", refresh: "on change", last: "Jun 28", tree: [
      { type: "dir", name: "endpoints", children: [
        { type: "file", name: "tasks.md", size: "12.1 KB", added: "Jun 28" },
        { type: "file", name: "projects.md", size: "7.3 KB", added: "Jun 15" },
        { type: "file", name: "agents.md", size: "9.0 KB", added: "Jun 21" },
      ] },
      { type: "dir", name: "schemas", children: [
        { type: "file", name: "task-contract.md", size: "11.2 KB", added: "May 30" },
        { type: "file", name: "event-types.md", size: "4.7 KB", added: "Jun 2" },
      ] },
      { type: "file", name: "versioning.md", size: "3.9 KB", added: "May 8" },
    ] },
    { id: "kb-runbooks", name: "Deploy runbooks", dir: "deploy-runbooks", refresh: "nightly", last: "Jul 3, 02:00", tree: [
      { type: "dir", name: "incidents", children: [
        { type: "file", name: "rollback.md", size: "5.2 KB", added: "Jun 9" },
        { type: "file", name: "hotfix-flow.md", size: "4.4 KB", added: "Jun 9" },
      ] },
      { type: "file", name: "release-checklist.md", size: "6.1 KB", added: "Jul 1" },
    ] },
  ],
  mcps: [
    { id: "mcp-gh", name: "github-mcp", transport: "HTTP", target: "https://mcp.internal:7801/sse", cred: "secret://mcp/github", tools: 14, up: true, last: "30s ago" },
    { id: "mcp-pg", name: "postgres-readonly", transport: "stdio", target: "npx -y @mcp/server-postgres", cred: "secret://mcp/postgres-ro", tools: 6, up: true, last: "1m ago" },
    { id: "mcp-bb", name: "browserbase", transport: "HTTP", target: "https://mcp.internal:7809/sse", cred: "secret://mcp/browserbase", tools: 0, up: false, last: "retry queued" },
  ],
  skills: [
    { id: "sk-1", name: "conventional-commits", summary: "Commit style and task-key prefixes for traceable history.", upd: "Mar 30",
      body: "## Commit format\n- `[VIB-<n>] <imperative summary>`\n- one logical change per commit\n- reference changed files in the body when >3 files\n\n## Why\nTask-key prefixes keep branch → commit → PR traceability intact.", tree: [
      { type: "file", name: "SKILL.md", size: "2.1 KB", added: "Mar 30" },
      { type: "file", name: "examples.md", size: "1.4 KB", added: "Mar 30" },
    ] },
    { id: "sk-2", name: "terraform-review", summary: "Module review checklist: state safety, drift, plan hygiene.", upd: "Jun 12",
      body: "## Review checklist\n- state safety: no destructive ops without a migration note\n- drift: plan output matches module inputs\n- plan hygiene: no orphaned resources\n\n## Escalate\nFlag anything touching IAM or networking for human review.", tree: [
      { type: "file", name: "SKILL.md", size: "3.4 KB", added: "Jun 12" },
      { type: "dir", name: "checklists", children: [
        { type: "file", name: "state-safety.md", size: "1.8 KB", added: "Jun 12" },
        { type: "file", name: "drift.md", size: "1.2 KB", added: "Jun 12" },
      ] },
    ] },
    { id: "sk-3", name: "api-design", summary: "REST conventions and versioning rules for public endpoints.", upd: "May 8",
      body: "## Conventions\n- resources are plural nouns; actions are sub-resources\n- version in the path (`/v1/`), never in headers\n- breaking changes require a deprecation window\n\n## Errors\nRFC 7807 problem+json with a stable `type` slug.", tree: [
      { type: "file", name: "SKILL.md", size: "2.8 KB", added: "May 8" },
      { type: "file", name: "conventions.md", size: "4.1 KB", added: "May 8" },
    ] },
    { id: "sk-4", name: "changelog-writer", summary: "Turns change summaries into human-readable release notes.", upd: "Jun 30",
      body: "## Style\n- lead with the user-visible change, not the implementation\n- group by area; link task keys\n- keep entries under 2 lines", tree: [
      { type: "file", name: "SKILL.md", size: "1.9 KB", added: "Jun 30" },
      { type: "dir", name: "templates", children: [
        { type: "file", name: "release-notes.md", size: "1.1 KB", added: "Jun 30" },
      ] },
    ] },
  ],
  gagents: [
    { id: "ga-1", name: "Developer", backend: "codex", summary: "Primary implementation specialist — owns branch work and change summaries.",
      stages: ["ready", "impl"], skills: ["sk-1", "sk-3"], mcps: ["mcp-gh"], kbs: ["kb-arch"], used: 4 },
    { id: "ga-2", name: "Reviewer", backend: "claude", summary: "Consultant on review boundaries — quality flags and PR review notes.",
      stages: ["review"], skills: ["sk-1"], mcps: ["mcp-gh"], kbs: ["kb-api"], used: 5 },
    { id: "ga-3", name: "Consultant", backend: "codex", summary: "Second opinion on architecture and thresholds; summoned on demand.",
      stages: ["impl", "review"], skills: ["sk-3"], mcps: [], kbs: ["kb-arch"], used: 2 },
    { id: "ga-4", name: "Test author", backend: "claude", summary: "Writes validation evidence: unit, integration, fixtures.",
      stages: ["impl"], skills: ["sk-2"], mcps: ["mcp-pg"], kbs: [], used: 1 },
  ],
};

function loadOrg() {
  try {
    const saved = JSON.parse(localStorage.getItem(ORG_LS) || "{}");
    return { ...ORG_DEFAULTS, ...saved };
  } catch (e) { return { ...ORG_DEFAULTS }; }
}
function saveOrg(org) {
  try { localStorage.setItem(ORG_LS, JSON.stringify(org)); } catch (e) {}
}

/* ---------- small shared bits ---------- */
function EditIco() {
  return (
    <svg className="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 20l1-4L16 5a2.1 2.1 0 0 1 3 3L8 19z" /><path d="M13.5 7.5l3 3" />
    </svg>
  );
}

function ConfirmDelete({ what, detail, onCancel, onConfirm }) {
  return (
    <React.Fragment>
      <div className="confirm-scrim" onClick={onCancel}></div>
      <div className="confirm-card" role="alertdialog" aria-modal="true">
        <div className="confirm-icon"><Icon name="alert" /></div>
        <h3>Remove {what}?</h3>
        <p>{detail}</p>
        <div className="confirm-actions">
          <button className="btn ghost" onClick={onCancel}>Cancel</button>
          <button className="btn danger" onClick={onConfirm}>Remove</button>
        </div>
      </div>
    </React.Fragment>
  );
}

function MiniModal({ icon, title, sub, onClose, canSave, saveLabel, onSave, footHint, children, screen }) {
  useEffectO(() => {
    const f = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", f);
    return () => window.removeEventListener("keydown", f);
  }, []);
  return (
    <React.Fragment>
      <div className="confirm-scrim" onClick={onClose}></div>
      <div className="modal-card" role="dialog" aria-modal="true" aria-label={title} data-screen-label={screen || title}>
        <div className="modal-head">
          <span className="conn-ico" style={{ width: 34, height: 34, borderRadius: 10 }}>{icon}</span>
          <span className="mh-main">
            <h2>{title}</h2>
            {sub && <div className="mh-sub">{sub}</div>}
          </span>
          <button className="icon-btn modal-close" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
        </div>
        <div className="modal-body">{children}</div>
        <div className="modal-foot">
          {footHint && <span className="foot-hint mono">{footHint}</span>}
          <span className="foot-actions">
            <button className="btn ghost" onClick={onClose}>Cancel</button>
            <button className="btn primary" onClick={onSave} style={!canSave ? { opacity: .55, pointerEvents: "none" } : null}>{saveLabel}</button>
          </span>
        </div>
      </div>
    </React.Fragment>
  );
}

const slugify = (s) => (s || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/* ---------- GitHub connections ---------- */
function ConnectionModal({ initial, existing, onClose, onDone }) {
  const [owner, setOwner] = useStateO(initial ? initial.owner : "");
  const [token, setToken] = useStateO("");
  const [checking, setChecking] = useStateO(false);
  const [err, setErr] = useStateO(null);
  const canSave = !checking && (!!initial || owner.trim().length > 1) && token.trim().length > 0;
  const apply = () => {
    if (!canSave) return;
    const o = owner.trim();
    if (!initial && existing.some((c) => c.id === slugify(o))) { setErr("That connection already exists."); return; }
    setErr(null); setChecking(true);
    setTimeout(() => {
      setChecking(false);
      if (!/^ghp_/.test(token.trim())) {
        setErr("Validation failed — token is missing pull_request:write. Minimum scopes: repo · workflow · pull_request:write. Nothing was saved.");
        return;
      }
      onDone(o);
    }, 900);
  };
  const enter = (e) => { if (e.key === "Enter") apply(); };
  return (
    <MiniModal icon={<Icon name="github" />} title={initial ? "Update token — " + initial.owner : "New GitHub connection"}
      sub={initial ? "The current token is never shown — paste a replacement" : "A PAT authenticates every repo action for this owner"}
      onClose={onClose} canSave={canSave}
      saveLabel={checking ? "Verifying scopes…" : initial ? "Validate & replace" : "Validate & connect"}
      footHint={initial ? "the old token stays active unless validation passes" : "nothing is saved unless validation passes"}
      onSave={apply}>
      <div className="field">
        <label className="flabel" htmlFor="cn-owner">Organization or user<span className="req">*</span></label>
        <div className="repo-input">
          <span className="pre">github.com/</span>
          <input id="cn-owner" type="text" value={owner} disabled={!!initial} placeholder="owner"
            onChange={(e) => { setOwner(e.target.value); setErr(null); }} onKeyDown={enter} autoFocus={!initial} />
        </div>
      </div>
      <div className="field">
        <label className="flabel" htmlFor="cn-token">Personal access token<span className="req">*</span> <span className="fhint">stored encrypted · never displayed</span></label>
        <input id="cn-token" type="text" className="mono" value={token} placeholder="ghp_…"
          onChange={(e) => { setToken(e.target.value); setErr(null); }} onKeyDown={enter} autoFocus={!!initial} />
      </div>
      <div className="field">
        <span className="flabel">Required scopes</span>
        <span className="scope-chips" style={{ marginTop: 0 }}>
          <span className="scope-chip">repo</span>
          <span className="scope-chip">workflow</span>
          <span className="scope-chip">pull_request:write</span>
        </span>
        <div className="def-note">
          <Icon name="shield" />
          <span>Verified when you apply. If any scope is missing the token is refused and nothing is saved.</span>
        </div>
      </div>
      {err && <div className="cred-warn"><Icon name="alert" />{err}</div>}
    </MiniModal>
  );
}

function ConnectionsPanel({ org, patchOrg, push }) {
  const [modal, setModal] = useStateO(null); // { item: conn | null }
  const [confirm, setConfirm] = useStateO(null);
  const conns = org.connections;

  const setDefault = (id) => {
    patchOrg({ connections: conns.map((c) => ({ ...c, def: c.id === id })) });
    push("Default connection updated — new projects start from it");
  };
  const remove = (c) => {
    if (c.def) { push("Set another connection as default first"); return; }
    setConfirm(c);
  };
  const done = (ownerName) => {
    if (modal.item) {
      patchOrg({ connections: conns.map((c) => (c.id === modal.item.id ? { ...c, expires: "Jul 3, 2027", daysLeft: 365 } : c)) });
      push("Token for " + modal.item.owner + " replaced — scopes verified, expires Jul 3, 2027");
    } else {
      patchOrg({ connections: [...conns, { id: slugify(ownerName), owner: ownerName, method: "PAT", repos: 5, def: false, expires: "Jul 3, 2027", daysLeft: 365 }] });
      push(ownerName + " connected — scopes verified, expires Jul 3, 2027");
    }
    setModal(null);
  };

  return (
    <section className="panel" data-screen-label="Settings — GitHub connections">
      <div className="panel-head">
        <Icon name="github" /><h2>GitHub connections</h2>
        <span className="right"><button className="btn sm" onClick={() => setModal({ item: null })}><Icon name="plus" />Add connection</button></span>
      </div>
      <div className="pol-note">
        <Icon name="shield" />
        <span><strong>{conns.length} connection{conns.length === 1 ? "" : "s"}.</strong> Every project picks one at creation — it sets the repository root. Each authenticates with a <strong>PAT</strong>, validated against the minimum scopes before anything is saved.</span>
      </div>
      <div className="conn-list">
        {conns.map((c) => (
          <div className="conn-row" key={c.id}>
            <span className="conn-ico"><Icon name="github" /></span>
            <span className="conn-main">
              <b>{c.owner}<span className="mono pre">/</span></b>
              <span className="sub mono">PAT · {c.repos} repos · expires {c.expires || "—"}</span>
              <span className="scope-chips">
                <span className="scope-chip"><Icon name="check" />repo</span>
                <span className="scope-chip"><Icon name="check" />workflow</span>
                <span className="scope-chip"><Icon name="check" />pull_request:write</span>
              </span>
            </span>
            {c.daysLeft != null && c.daysLeft <= 30 && <Pill kind="input" sm>expires in {c.daysLeft} days</Pill>}
            {c.def && <Pill kind="info" sm>default</Pill>}
            <button className="btn ghost sm" onClick={() => setModal({ item: c })}>Update token</button>
            {!c.def && <button className="btn ghost sm" onClick={() => setDefault(c.id)}>Set default</button>}
            <button className="stg-x" aria-label={"Remove " + c.owner} onClick={() => remove(c)}><Icon name="x" /></button>
          </div>
        ))}
      </div>
      {modal && <ConnectionModal key={modal.item ? modal.item.id : "new"} initial={modal.item} existing={conns} onClose={() => setModal(null)} onDone={done} />}
      {confirm && (
        <ConfirmDelete what={confirm.owner} detail={"Projects already created from " + confirm.owner + " keep their repos; new projects can no longer select it."}
          onCancel={() => setConfirm(null)}
          onConfirm={() => { patchOrg({ connections: conns.filter((c) => c.id !== confirm.id) }); push(confirm.owner + " disconnected"); setConfirm(null); }} />
      )}
    </section>
  );
}

/* ---------- Users & access ---------- */
function IdpChip({ idp }) {
  if (idp === "github") return <span className="idp-chip"><Icon name="github" />GitHub</span>;
  if (idp === "google") return <span className="idp-chip"><span className="gmark">G</span>Google</span>;
  return <span className="idp-chip"><Icon name="lock" />Local</span>;
}

function InviteModal({ onClose, onInvite }) {
  const [idp, setIdp] = useStateO("github");
  const [handle, setHandle] = useStateO("");
  const [email, setEmail] = useStateO("");
  const [name, setName] = useStateO("");
  const [role, setRole] = useStateO("member");
  const g = email.trim();
  const isDomain = idp === "google" && (g.startsWith("@") || (g.includes("@") && !g.split("@")[0]));
  const canSave = idp === "github" ? handle.trim().replace(/^@/, "").length > 1
    : idp === "google" ? (g.includes("@") && (g.split("@")[1] || "").includes("."))
    : name.trim().length > 1 && email.includes("@");
  const submit = () => canSave && onInvite({ idp, handle: handle.trim().replace(/^@/, ""), email: g, name: name.trim(), role, isDomain });
  const enter = (e) => { if (e.key === "Enter") submit(); };
  return (
    <MiniModal icon={<Icon name="user" />} title="Allow access" sub="Whitelist who can sign in — no invite emails, access on first login"
      onClose={onClose} canSave={canSave}
      saveLabel={idp === "local" ? "Create account" : isDomain ? "Whitelist domain" : "Whitelist " + (idp === "github" ? "user" : "account")}
      footHint={idp === "github" ? "allowed the moment they sign in with GitHub" : idp === "google" ? (isDomain ? "everyone " + g + " can sign in with Google" : "allowed the moment they sign in with Google") : "they set a password from the setup link"}
      onSave={submit}>
      <div className="field">
        <span className="flabel">Sign-in method</span>
        <div className="be-pick three">
          <button type="button" className={"be-opt" + (idp === "github" ? " on" : "")} onClick={() => setIdp("github")} aria-pressed={idp === "github"}>
            <span className="be-ic"><Icon name="github" /></span>
            <span className="bnm">GitHub</span>
            <span className="bcheck"><Icon name="check" /></span>
          </button>
          <button type="button" className={"be-opt" + (idp === "google" ? " on" : "")} onClick={() => setIdp("google")} aria-pressed={idp === "google"}>
            <span className="be-ic"><span className="gmark lg">G</span></span>
            <span className="bnm">Google</span>
            <span className="bcheck"><Icon name="check" /></span>
          </button>
          <button type="button" className={"be-opt" + (idp === "local" ? " on" : "")} onClick={() => setIdp("local")} aria-pressed={idp === "local"}>
            <span className="be-ic"><Icon name="lock" /></span>
            <span className="bnm">Local</span>
            <span className="bcheck"><Icon name="check" /></span>
          </button>
        </div>
      </div>
      {idp === "github" && (
        <div className="field">
          <label className="flabel" htmlFor="inv-gh">GitHub username<span className="req">*</span> <span className="fhint">name &amp; avatar come from GitHub when they sign in</span></label>
          <div className="repo-input">
            <span className="pre">github.com/</span>
            <input id="inv-gh" type="text" value={handle} placeholder="username" onChange={(e) => setHandle(e.target.value)} onKeyDown={enter} autoFocus />
          </div>
        </div>
      )}
      {idp === "google" && (
        <div className="field">
          <label className="flabel" htmlFor="inv-mail">Google account or domain<span className="req">*</span> <span className="fhint">@company.dev whitelists the whole org</span></label>
          <input id="inv-mail" type="text" className="mono" value={email} placeholder="name@company.dev · or · @company.dev" onChange={(e) => setEmail(e.target.value)} onKeyDown={enter} autoFocus />
        </div>
      )}
      {idp === "local" && (
        <div className="key-row" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <div className="field">
            <label className="flabel" htmlFor="inv-name">Full name<span className="req">*</span></label>
            <input id="inv-name" type="text" value={name} placeholder="Full name" onChange={(e) => setName(e.target.value)} onKeyDown={enter} autoFocus />
          </div>
          <div className="field">
            <label className="flabel" htmlFor="inv-email">Email<span className="req">*</span></label>
            <input id="inv-email" type="text" className="mono" value={email} placeholder="name@company.dev" onChange={(e) => setEmail(e.target.value)} onKeyDown={enter} />
          </div>
        </div>
      )}
      <div className="field">
        <span className="flabel">{isDomain ? "Role for everyone joining via this domain" : "Instance role"}</span>
        <span className="mini-seg" style={{ alignSelf: "flex-start" }}>
          <button className={role === "admin" ? "on" : ""} onClick={() => setRole("admin")}>Admin</button>
          <button className={role === "member" ? "on" : ""} onClick={() => setRole("member")}>Member</button>
        </span>
      </div>
    </MiniModal>
  );
}

function EditUserModal({ user, onClose, onSave, onReset }) {
  const isLocal = (user.idp || "local") === "local";
  const [name, setName] = useStateO(user.name);
  const [email, setEmail] = useStateO(user.email);
  const [role, setRole] = useStateO(user.role);
  const canSave = !isLocal || (name.trim().length > 1 && email.includes("@"));
  return (
    <MiniModal icon={<Icon name="user" />} title={"Edit " + user.name}
      sub={isLocal ? "Local account" : "Signs in with " + (user.idp === "github" ? "GitHub" : "Google")}
      onClose={onClose} canSave={canSave} saveLabel="Save changes"
      footHint={user.you ? "this is your own account" : undefined}
      onSave={() => canSave && onSave(user, { name: name.trim(), email: email.trim(), role })}>
      <div className="key-row" style={{ gridTemplateColumns: "1fr 1fr" }}>
        <div className="field">
          <label className="flabel" htmlFor="eu-name">Full name{isLocal && <span className="req">*</span>}</label>
          <input id="eu-name" type="text" value={name} disabled={!isLocal} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label className="flabel" htmlFor="eu-email">Email{isLocal && <span className="req">*</span>}</label>
          <input id="eu-email" type="text" className="mono" value={email} disabled={!isLocal} onChange={(e) => setEmail(e.target.value)} />
        </div>
      </div>
      {!isLocal && (
        <div className="def-note" style={{ marginTop: "-.6rem" }}>
          <Icon name="lock" />
          <span>Name &amp; email sync from {user.idp === "github" ? "GitHub" : "Google"} at each sign-in and can't be edited here.</span>
        </div>
      )}
      <div className="field">
        <span className="flabel">Instance role</span>
        <span className="mini-seg" style={{ alignSelf: "flex-start" }}>
          <button className={role === "admin" ? "on" : ""} onClick={() => setRole("admin")}>Admin</button>
          <button className={role === "member" ? "on" : ""} onClick={() => setRole("member")}>Member</button>
        </span>
      </div>
      {isLocal && (
        <div className="field">
          <span className="flabel">Password</span>
          {user.pwreset
            ? <div className="cred-ok"><Icon name="check" /><span>Reset pending — {user.name} will be prompted to set a new password at next sign-in.</span></div>
            : <div>
                <button className="btn ghost sm" onClick={() => onReset(user)}><Icon name="lock" />Reset password</button>
                <div className="def-note" style={{ marginTop: ".55rem" }}>
                  <Icon name="lock" />
                  <span>No email is sent — they're prompted to set a new password at their next sign-in.</span>
                </div>
              </div>}
        </div>
      )}
    </MiniModal>
  );
}

function UsersPanel({ org, patchOrg, push }) {
  const [confirm, setConfirm] = useStateO(null);
  const [inviting, setInviting] = useStateO(false);
  const [editing, setEditing] = useStateO(null);
  const users = org.users;

  const setRole = (id, role) => {
    const u = users.find((x) => x.id === id);
    if (u.you && role !== "admin") { push("You can't demote yourself"); return; }
    patchOrg({ users: users.map((x) => (x.id === id ? { ...x, role } : x)) });
    push(u.name + " → " + role);
  };
  const invite = (p) => {
    if (p.idp === "google" && p.isDomain) {
      const domain = p.email.startsWith("@") ? p.email : "@" + p.email.split("@")[1];
      if ((org.domains || []).some((d) => d.domain === domain)) { push(domain + " is already whitelisted"); return; }
      patchOrg({ domains: [...(org.domains || []), { id: "d-" + Date.now().toString(36), domain, role: p.role }] });
      setInviting(false);
      push("Anyone with " + domain + " can now sign in with Google — joins as " + p.role);
      return;
    }
    let name = p.name, email = p.email, initials, status = "whitelisted";
    if (p.idp === "github") { name = "@" + p.handle; email = "github.com/" + p.handle; initials = initialsOf(p.handle); }
    else if (p.idp === "google") { name = p.email.split("@")[0]; initials = initialsOf(name); }
    else { initials = initialsOf(p.name); status = "invited"; }
    patchOrg({ users: [...users, { id: "u-" + Date.now().toString(36), name, email, initials, tone: "teal", role: p.role, status, idp: p.idp }] });
    setInviting(false);
    push(p.idp === "local" ? "Account created — setup link generated for " + email
      : p.idp === "github" ? "@" + p.handle + " whitelisted — allowed at first GitHub sign-in"
      : email + " whitelisted — allowed at first Google sign-in");
  };
  const saveUser = (u, data) => {
    if (u.you && data.role !== "admin") { push("You can't demote yourself"); return; }
    patchOrg({ users: users.map((x) => (x.id === u.id ? { ...x, ...data } : x)) });
    push(u.you ? "Profile updated" : (data.name || u.name) + " updated");
    setEditing(null);
  };
  const resetPw = (u) => {
    patchOrg({ users: users.map((x) => (x.id === u.id ? { ...x, pwreset: true } : x)) });
    push("Password reset — " + u.name + " sets a new password at next sign-in");
  };

  return (
    <section className="panel" data-screen-label="Settings — Users & access">
      <div className="panel-head">
        <Icon name="user" /><h2>Users &amp; access</h2>
        <span className="right"><button className="btn sm" onClick={() => setInviting(true)}><Icon name="plus" />Allow access</button></span>
      </div>
      <div className="pol-note">
        <Icon name="shield" />
        <span><strong>{users.length} instance accounts</strong> — GitHub &amp; Google access is whitelist-based: allowed people simply sign in, no invite emails. Board permissions are granted per project.</span>
      </div>
      {(org.domains || []).length > 0 && (
        <div className="member-list" style={{ marginBottom: 0 }}>
          {org.domains.map((d) => (
            <div className="member-row" key={d.id}>
              <span className="dom-ic"><span className="gmark">G</span></span>
              <span className="member-main">
                <div className="nm">{d.domain}</div>
                <div className="em">any Google account with this domain · joins as {d.role}</div>
              </span>
              <Pill kind="ready" sm>domain allowlist</Pill>
              <button className="stg-x" aria-label={"Remove " + d.domain}
                onClick={() => setConfirm({ kind: "domain", item: d })}>
                <Icon name="x" />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="member-list">
        {users.map((u) => (
          <div className="member-row" key={u.id}>
            <Avatar person={u} />
            <span className="member-main">
              <div className="nm">{u.name}{u.you && <span className="you-tag">you</span>}</div>
              <div className="em">{u.email}</div>
            </span>
            <IdpChip idp={u.idp || "local"} />
            {u.status === "invited" && <Pill kind="neutral" sm>setup pending</Pill>}
            {u.status === "whitelisted" && <Pill kind="neutral" sm>whitelisted</Pill>}
            {u.pwreset && <Pill kind="input" sm>password reset pending</Pill>}
            <span className="mini-seg">
              <button className={u.role === "admin" ? "on" : ""} onClick={() => setRole(u.id, "admin")}>Admin</button>
              <button className={u.role === "member" ? "on" : ""} onClick={() => setRole(u.id, "member")}>Member</button>
            </span>
            <button className="stg-x" title="Edit user" aria-label={"Edit " + u.name} onClick={() => setEditing(u)}><EditIco /></button>
            <button className={"stg-x" + (u.you ? " off" : "")} aria-label={"Remove " + u.name}
              onClick={() => { if (u.you) { push("You can't remove your own account"); return; } setConfirm({ kind: "user", item: u }); }}>
              <Icon name="x" />
            </button>
          </div>
        ))}
      </div>
      {inviting && <InviteModal onClose={() => setInviting(false)} onInvite={invite} />}
      {editing && (() => {
        const live = users.find((x) => x.id === editing.id) || editing;
        return <EditUserModal key={live.id} user={live} onClose={() => setEditing(null)} onSave={saveUser} onReset={resetPw} />;
      })()}
      {confirm && confirm.kind === "user" && (
        <ConfirmDelete what={confirm.item.name} detail={"Their comments and decisions stay in the audit history. Task assignments return to the operator for reassignment."}
          onCancel={() => setConfirm(null)}
          onConfirm={() => { patchOrg({ users: users.filter((x) => x.id !== confirm.item.id) }); push(confirm.item.name + " removed"); setConfirm(null); }} />
      )}
      {confirm && confirm.kind === "domain" && (
        <ConfirmDelete what={confirm.item.domain} detail={"New Google sign-ins from this domain are refused. Accounts that already signed in keep their access."}
          onCancel={() => setConfirm(null)}
          onConfirm={() => { patchOrg({ domains: org.domains.filter((x) => x.id !== confirm.item.id) }); push(confirm.item.domain + " removed from the allowlist"); setConfirm(null); }} />
      )}
    </section>
  );
}

/* ---------- resource modals ---------- */
function KBModal({ initial, onClose, onSave }) {
  const [name, setName] = useStateO(initial ? initial.name : "");
  const [refresh, setRefresh] = useStateO(initial ? initial.refresh : "on change");
  const canSave = name.trim().length > 1;
  return (
    <MiniModal icon={<Icon name="memory" />} title={initial ? "Edit knowledge base" : "New knowledge base"}
      sub="A folder in the store — drop docs in, or let agents append" onClose={onClose}
      canSave={canSave} saveLabel={initial ? "Save changes" : "Create & index"}
      footHint={"store://kb/" + (slugify(name) || "name") + "/"}
      onSave={() => canSave && onSave({ name: name.trim(), dir: slugify(name), refresh })}>
      <div className="field">
        <label className="flabel" htmlFor="kb-name">Name<span className="req">*</span> <span className="fhint">names its folder in the knowledge-base store</span></label>
        <input id="kb-name" type="text" value={name} placeholder="e.g. Architecture notes" onChange={(e) => setName(e.target.value)} autoFocus />
      </div>
      <div className="field">
        <span className="flabel">Re-index</span>
        <span className="mini-seg" style={{ alignSelf: "flex-start" }}>
          {["manual", "on change", "nightly"].map((r) => (
            <button key={r} className={refresh === r ? "on" : ""} onClick={() => setRefresh(r)}>{r}</button>
          ))}
        </span>
        <div className="def-note">
          <Icon name="file" />
          <span>Content is plain files inside the folder — inspectable and editable outside Viberr. Indexing just makes it retrievable for agents.</span>
        </div>
      </div>
    </MiniModal>
  );
}

function McpModal({ initial, onClose, onSave }) {
  const [name, setName] = useStateO(initial ? initial.name : "");
  const [transport, setTransport] = useStateO(initial ? initial.transport : "HTTP");
  const [target, setTarget] = useStateO(initial ? initial.target : "");
  const [cred, setCred] = useStateO(initial ? initial.cred : "");
  const canSave = slugify(name).length > 1 && target.trim().length > 3;
  return (
    <MiniModal icon={<Icon name="cpu" />} title={initial ? "Edit MCP server" : "Add MCP server"}
      sub="Tools become loadable context for agent profiles" onClose={onClose}
      canSave={canSave} saveLabel={initial ? "Save & re-test" : "Add & test connection"}
      footHint={transport === "stdio" ? "spawned per run, sandboxed" : "health-checked every 60s"}
      onSave={() => canSave && onSave({ name: slugify(name), transport, target: target.trim(), cred: cred.trim() })}>
      <div className="key-row">
        <div className="field">
          <label className="flabel" htmlFor="mcp-name">Server name<span className="req">*</span></label>
          <input id="mcp-name" type="text" className="mono" value={name} placeholder="e.g. github-mcp" onChange={(e) => setName(e.target.value)} autoFocus />
        </div>
        <div className="field">
          <span className="flabel">Transport</span>
          <span className="mini-seg" style={{ alignSelf: "flex-start" }}>
            <button className={transport === "HTTP" ? "on" : ""} onClick={() => setTransport("HTTP")}>HTTP</button>
            <button className={transport === "stdio" ? "on" : ""} onClick={() => setTransport("stdio")}>stdio</button>
          </span>
        </div>
      </div>
      <div className="field">
        <label className="flabel" htmlFor="mcp-target">{transport === "stdio" ? "Command" : "Endpoint"}<span className="req">*</span></label>
        <input id="mcp-target" type="text" className="mono" value={target}
          placeholder={transport === "stdio" ? "npx -y @mcp/server-postgres" : "https://mcp.internal:7801/sse"}
          onChange={(e) => setTarget(e.target.value)} />
      </div>
      <div className="field">
        <label className="flabel" htmlFor="mcp-cred">Credential <span className="fhint">optional · secret reference</span></label>
        <input id="mcp-cred" type="text" className="mono" value={cred} placeholder="secret://mcp/…" onChange={(e) => setCred(e.target.value)} />
        <div className="def-note">
          <Icon name="lock" />
          <span>Referenced at runtime only. Secrets never appear in task timelines, comments, or audit records.</span>
        </div>
      </div>
    </MiniModal>
  );
}

function SkillModal({ initial, onClose, onSave }) {
  const [name, setName] = useStateO(initial ? initial.name : "");
  const [summary, setSummary] = useStateO(initial ? initial.summary : "");
  const [body, setBody] = useStateO(initial ? (initial.body || "") : "");
  const canSave = slugify(name).length > 1 && summary.trim().length > 3;
  return (
    <MiniModal icon={<Icon name="bolt" />} title={initial ? "Edit skill" : "New skill"}
      sub="Reusable instructions an agent loads on demand" onClose={onClose}
      canSave={canSave} saveLabel={initial ? "Save changes" : "Create skill"}
      footHint={"store://skills/" + (slugify(name) || "name") + "/"}
      onSave={() => canSave && onSave({ name: slugify(name), summary: summary.trim(), body })}>
      <div className="field">
        <label className="flabel" htmlFor="sk-name">Skill name<span className="req">*</span></label>
        <input id="sk-name" type="text" className="mono" value={name} placeholder="e.g. terraform-review" onChange={(e) => setName(e.target.value)} autoFocus />
      </div>
      <div className="field">
        <label className="flabel" htmlFor="sk-sum">Summary<span className="req">*</span> <span className="fhint">shown to the operator when choosing context</span></label>
        <input id="sk-sum" type="text" value={summary} placeholder="What does this skill teach the agent?" onChange={(e) => setSummary(e.target.value)} />
      </div>
      <div className="field">
        <label className="flabel" htmlFor="sk-body">SKILL.md <span className="fhint">markdown</span></label>
        <textarea id="sk-body" rows={body ? Math.min(18, body.split("\n").length + 2) : 6} value={body} placeholder={"## When reviewing a module\n- check state safety\n- flag drift between plan and apply\n- …"} onChange={(e) => setBody(e.target.value)} />
      </div>
    </MiniModal>
  );
}

function AgentModal({ initial, org, onClose, onSave }) {
  const [name, setName] = useStateO(initial ? initial.name : "");
  const [backend, setBackend] = useStateO(initial ? initial.backend : "codex");
  const [summary, setSummary] = useStateO(initial ? initial.summary : "");
  const [stages, setStages] = useStateO(initial ? initial.stages : ["impl"]);
  const [skills, setSkills] = useStateO(initial ? initial.skills : []);
  const [mcps, setMcps] = useStateO(initial ? initial.mcps : []);
  const [kbs, setKbs] = useStateO(initial ? initial.kbs : []);
  const stageOpts = window.VIBERR.stages.filter((s) => s.id !== "done");
  const toggle = (list, set, id) => set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  const canSave = name.trim().length > 1 && stages.length > 0;
  return (
    <MiniModal icon={<AgentGlyph backend={backend} />} title={initial ? "Edit agent profile" : "New agent profile"}
      sub="Global base definition — projects grant eligibility & capabilities" onClose={onClose}
      canSave={canSave} saveLabel={initial ? "Save changes" : "Create profile"}
      footHint={(initial && initial.used > 0) ? "used in " + initial.used + " projects — changes apply on next run" : "not deployed yet"}
      onSave={() => canSave && onSave({ name: name.trim(), backend, summary: summary.trim(), stages, skills, mcps, kbs })}>
      <div className="field">
        <label className="flabel" htmlFor="ga-name">Profile name<span className="req">*</span></label>
        <input id="ga-name" type="text" value={name} placeholder="e.g. Security reviewer" onChange={(e) => setName(e.target.value)} autoFocus />
      </div>
      <div className="field">
        <span className="flabel">Backend</span>
        <div className="be-pick">
          <button type="button" className={"be-opt" + (backend === "codex" ? " on" : "")} onClick={() => setBackend("codex")} aria-pressed={backend === "codex"}>
            <AgentGlyph backend="codex" />
            <span>
              <span className="bnm">Codex</span>
            </span>
            <span className="bcheck"><Icon name="check" /></span>
          </button>
          <button type="button" className={"be-opt" + (backend === "claude" ? " on" : "")} onClick={() => setBackend("claude")} aria-pressed={backend === "claude"}>
            <AgentGlyph backend="claude" />
            <span>
              <span className="bnm">Claude Code</span>
            </span>
            <span className="bcheck"><Icon name="check" /></span>
          </button>
        </div>
      </div>
      <div className="field">
        <label className="flabel" htmlFor="ga-sum">Role summary</label>
        <input id="ga-sum" type="text" value={summary} placeholder="One line the operator sees when assigning work" onChange={(e) => setSummary(e.target.value)} />
      </div>
      <div className="field">
        <span className="flabel">Default eligible stages<span className="req">*</span> <span className="fhint">Done is human-only, always</span></span>
        <div className="pick-chips">
          {stageOpts.map((s) => (
            <button key={s.id} className={"pick-chip" + (stages.includes(s.id) ? " on" : "")} onClick={() => toggle(stages, setStages, s.id)}>
              <span className="sdot" style={{ background: s.color }}></span>{s.name}
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <span className="flabel">Loadable context <span className="fhint">what this profile may pull into a run</span></span>
        <div className="ctx-groups">
          <div className="ctx-group">
            <span className="ctx-lbl">Skills</span>
            <div className="pick-chips">
              {org.skills.map((s) => (
                <button key={s.id} className={"pick-chip mono" + (skills.includes(s.id) ? " on" : "")} onClick={() => toggle(skills, setSkills, s.id)}>{s.name}</button>
              ))}
              {org.skills.length === 0 && <span className="ctx-none">none defined</span>}
            </div>
          </div>
          <div className="ctx-group">
            <span className="ctx-lbl">MCP servers</span>
            <div className="pick-chips">
              {org.mcps.map((m) => (
                <button key={m.id} className={"pick-chip mono" + (mcps.includes(m.id) ? " on" : "")} onClick={() => toggle(mcps, setMcps, m.id)}>{m.name}</button>
              ))}
              {org.mcps.length === 0 && <span className="ctx-none">none defined</span>}
            </div>
          </div>
          <div className="ctx-group">
            <span className="ctx-lbl">Knowledge bases</span>
            <div className="pick-chips">
              {org.kbs.map((k) => (
                <button key={k.id} className={"pick-chip" + (kbs.includes(k.id) ? " on" : "")} onClick={() => toggle(kbs, setKbs, k.id)}>{k.name}</button>
              ))}
              {org.kbs.length === 0 && <span className="ctx-none">none defined</span>}
            </div>
          </div>
        </div>
      </div>
    </MiniModal>
  );
}

/* ---------- Agent resources ---------- */
function ResourcesPanel({ org, patchOrg, push }) {
  const [reindexing, setReindexing] = useStateO(null);
  const [testing, setTesting] = useStateO(null);
  const [modal, setModal] = useStateO(null); // { kind, item|null }
  const [browsing, setBrowsing] = useStateO(null); // { kind: "kb"|"skill", id }
  const [confirm, setConfirm] = useStateO(null); // { kind, item }

  const reindex = (kb) => {
    setReindexing(kb.id);
    setTimeout(() => {
      setReindexing(null);
      patchOrg({ kbs: org.kbs.map((x) => (x.id === kb.id ? { ...x, last: "just now" } : x)) });
      push(kb.name + " re-indexed — " + countKbFiles(kb.tree || []) + " docs");
    }, 1000);
  };
  const testMcp = (m) => {
    setTesting(m.id);
    setTimeout(() => {
      setTesting(null);
      if (m.up) push(m.name + " healthy — " + m.tools + " tools · 41ms");
      else push(m.name + " unreachable — connection refused, retry queued");
    }, 900);
  };

  const saveKb = (data) => {
    if (modal.item) {
      patchOrg({ kbs: org.kbs.map((x) => (x.id === modal.item.id ? { ...x, ...data } : x)) });
      push(data.name + " updated");
    } else {
      patchOrg({ kbs: [...org.kbs, { id: "kb-" + Date.now().toString(36), ...data, tree: [], last: "just now" }] });
      push(data.name + " created — folder ready at store://kb/" + data.dir + "/");
    }
    setModal(null);
  };
  const saveMcp = (data) => {
    if (modal.item) {
      patchOrg({ mcps: org.mcps.map((x) => (x.id === modal.item.id ? { ...x, ...data, up: true, last: "just now" } : x)) });
      push(data.name + " saved — reconnected, " + (modal.item.tools || 8) + " tools");
    } else {
      patchOrg({ mcps: [...org.mcps, { id: "mcp-" + Date.now().toString(36), ...data, tools: 8, up: true, last: "just now" }] });
      push(data.name + " connected — 8 tools discovered");
    }
    setModal(null);
  };
  const saveSkill = (data) => {
    const skillTree = (tree, body) => {
      const rest = (tree || []).filter((n) => n.name !== "SKILL.md");
      return [{ type: "file", name: "SKILL.md", size: prettySize(Math.max((body || "").length, 400)), added: "just now" }, ...rest];
    };
    if (modal.item) {
      patchOrg({ skills: org.skills.map((x) => (x.id === modal.item.id ? { ...x, ...data, upd: "just now", tree: skillTree(x.tree, data.body) } : x)) });
      push("Skill " + data.name + " updated — SKILL.md rewritten");
    } else {
      patchOrg({ skills: [...org.skills, { id: "sk-" + Date.now().toString(36), ...data, upd: "just now", tree: skillTree([], data.body) }] });
      push("Skill " + data.name + " created — SKILL.md written");
    }
    setModal(null);
  };
  const saveAgent = (data) => {
    if (modal.item) {
      patchOrg({ gagents: org.gagents.map((x) => (x.id === modal.item.id ? { ...x, ...data } : x)) });
      push(data.name + " updated — running threads re-anchor on next turn");
    } else {
      patchOrg({ gagents: [...org.gagents, { id: "ga-" + Date.now().toString(36), ...data, used: 0 }] });
      push(data.name + " created — grant it eligibility in a project's policy to deploy");
    }
    setModal(null);
  };

  const doDelete = () => {
    const { kind, item } = confirm;
    if (kind === "kb") { patchOrg({ kbs: org.kbs.filter((x) => x.id !== item.id) }); push(item.name + " deleted — agents lose it on next context load"); }
    if (kind === "mcp") { patchOrg({ mcps: org.mcps.filter((x) => x.id !== item.id) }); push(item.name + " removed"); }
    if (kind === "skill") { patchOrg({ skills: org.skills.filter((x) => x.id !== item.id) }); push("Skill " + item.name + " deleted"); }
    if (kind === "agent") { patchOrg({ gagents: org.gagents.filter((x) => x.id !== item.id) }); push(item.name + " deleted"); }
    setConfirm(null);
  };

  const usedBy = (kind, id) => org.gagents.filter((a) => (a[kind] || []).includes(id)).length;

  return (
    <div className="rsrc-wrap" data-screen-label="Settings — Agent resources">
      <div className="rsrc-grid">
        <section className="panel">
          <div className="panel-head">
            <Icon name="memory" /><h2>Knowledge bases</h2>
            <span className="right"><button className="btn sm" onClick={() => setModal({ kind: "kb", item: null })}><Icon name="plus" />New</button></span>
          </div>
          <div className="rsrc-list">
            {org.kbs.map((kb) => (
              <div className="rsrc-row" key={kb.id}>
                <span className="rsrc-main">
                  <b><button className="linkish" onClick={() => setBrowsing({ kind: "kb", id: kb.id })}>{kb.name}</button></b>
                  <span className="sub mono">store://kb/{kb.dir || slugify(kb.name)}/ · {countKbFiles(kb.tree || [])} docs</span>
                  <span className="sub">re-index {kb.refresh} · indexed {kb.last}{usedBy("kbs", kb.id) > 0 ? " · " + usedBy("kbs", kb.id) + " profiles" : ""}</span>
                </span>
                <span className="rsrc-acts">
                  <button className="stg-x" title="Browse files" aria-label={"Browse files in " + kb.name} onClick={() => setBrowsing({ kind: "kb", id: kb.id })}><FolderIco /></button>
                  <button className="stg-x" title="Re-index now" aria-label={"Re-index " + kb.name} onClick={() => reindex(kb)}>
                    <Icon name="refresh" className={reindexing === kb.id ? "spin" : ""} />
                  </button>
                  <button className="stg-x" title="Edit" aria-label={"Edit " + kb.name} onClick={() => setModal({ kind: "kb", item: kb })}><EditIco /></button>
                  <button className="stg-x" title="Delete" aria-label={"Delete " + kb.name} onClick={() => setConfirm({ kind: "kb", item: kb })}><Icon name="x" /></button>
                </span>
              </div>
            ))}
            {org.kbs.length === 0 && <div className="empty">No knowledge bases yet.</div>}
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <Icon name="cpu" /><h2>MCP servers</h2>
            <span className="right"><button className="btn sm" onClick={() => setModal({ kind: "mcp", item: null })}><Icon name="plus" />Add</button></span>
          </div>
          <div className="rsrc-list">
            {org.mcps.map((m) => (
              <div className="rsrc-row" key={m.id}>
                <span className={"stat-dot" + (m.up ? " up" : " down")} title={m.up ? "connected" : "unreachable"}></span>
                <span className="rsrc-main">
                  <b className="mono-b">{m.name}</b>
                  <span className="sub mono">{m.transport} · {m.target}</span>
                  <span className="sub">{m.up ? m.tools + " tools · checked " + m.last : "unreachable · " + m.last}{m.cred ? " · auth: " + m.cred : ""}</span>
                </span>
                <span className="rsrc-acts">
                  <button className="stg-x" title="Test connection" aria-label={"Test " + m.name} onClick={() => testMcp(m)}>
                    <Icon name="refresh" className={testing === m.id ? "spin" : ""} />
                  </button>
                  <button className="stg-x" title="Edit" aria-label={"Edit " + m.name} onClick={() => setModal({ kind: "mcp", item: m })}><EditIco /></button>
                  <button className="stg-x" title="Remove" aria-label={"Remove " + m.name} onClick={() => setConfirm({ kind: "mcp", item: m })}><Icon name="x" /></button>
                </span>
              </div>
            ))}
            {org.mcps.length === 0 && <div className="empty">No MCP servers yet.</div>}
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <Icon name="bolt" /><h2>Skills</h2>
            <span className="right"><button className="btn sm" onClick={() => setModal({ kind: "skill", item: null })}><Icon name="plus" />New</button></span>
          </div>
          <div className="rsrc-list">
            {org.skills.map((s) => (
              <div className="rsrc-row" key={s.id}>
                <span className="rsrc-main">
                  <b className="mono-b"><button className="linkish" onClick={() => setBrowsing({ kind: "skill", id: s.id })}>{s.name}</button></b>
                  <span className="sub">{s.summary}</span>
                  <span className="sub mono">store://skills/{s.name}/ · {countKbFiles(s.tree || [])} file{countKbFiles(s.tree || []) === 1 ? "" : "s"} · updated {s.upd}{usedBy("skills", s.id) > 0 ? " · " + usedBy("skills", s.id) + " profiles" : ""}</span>
                </span>
                <span className="rsrc-acts">
                  <button className="stg-x" title="Browse files" aria-label={"Browse files in " + s.name} onClick={() => setBrowsing({ kind: "skill", id: s.id })}><FolderIco /></button>
                  <button className="stg-x" title="Edit" aria-label={"Edit " + s.name} onClick={() => setModal({ kind: "skill", item: s })}><EditIco /></button>
                  <button className="stg-x" title="Delete" aria-label={"Delete " + s.name} onClick={() => setConfirm({ kind: "skill", item: s })}><Icon name="x" /></button>
                </span>
              </div>
            ))}
            {org.skills.length === 0 && <div className="empty">No skills yet.</div>}
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <Icon name="agents" /><h2>Global agent profiles</h2>
            <span className="right"><button className="btn sm" onClick={() => setModal({ kind: "agent", item: null })}><Icon name="plus" />New</button></span>
          </div>
          <div className="rsrc-list">
            {org.gagents.map((a) => {
              const res = (a.skills || []).length + (a.mcps || []).length + (a.kbs || []).length;
              const stageNames = (a.stages || []).map((id) => ((window.VIBERR.stages.find((s) => s.id === id) || {}).name || id)).join(" · ");
              return (
                <div className="rsrc-row" key={a.id}>
                  <AgentGlyph backend={a.backend} />
                  <span className="rsrc-main">
                    <b>{a.name}</b>
                    <span className="sub">{a.summary}</span>
                    <span className="sub mono">{a.backend === "claude" ? "Claude Code" : "Codex"} · {stageNames || "no stages"} · {res} context resources · {a.used > 0 ? "used in " + a.used + " project" + (a.used === 1 ? "" : "s") : "not deployed"}</span>
                  </span>
                  <span className="rsrc-acts">
                    <button className="stg-x" title="Edit" aria-label={"Edit " + a.name} onClick={() => setModal({ kind: "agent", item: a })}><EditIco /></button>
                    <button className="stg-x" title="Delete" aria-label={"Delete " + a.name}
                      onClick={() => { if (a.used > 0) { push("Detach " + a.name + " from its " + a.used + " projects first"); return; } setConfirm({ kind: "agent", item: a }); }}>
                      <Icon name="x" />
                    </button>
                  </span>
                </div>
              );
            })}
          </div>
        </section>
      </div>
      <div className="def-note" style={{ marginTop: ".8rem" }}>
        <Icon name="shield" />
        <span>These are the shared base definitions. Each project's policy decides which profiles are eligible, which of their context resources may load, and what they may do — without changing the global.</span>
      </div>

      {modal && modal.kind === "kb" && <KBModal initial={modal.item} onClose={() => setModal(null)} onSave={saveKb} />}
      {browsing && (() => {
        if (browsing.kind === "kb") {
          const kb = org.kbs.find((k) => k.id === browsing.id);
          if (!kb) return null;
          const dir = kb.dir || slugify(kb.name);
          return (
            <StoreBrowser title={kb.name} root={"store://kb/" + dir}
              subMono={"store://kb/" + dir + "/ · re-index " + kb.refresh} metaTail={"indexed " + kb.last}
              tree={kb.tree || []} push={push}
              onChange={(tree) => patchOrg({ kbs: org.kbs.map((x) => (x.id === kb.id ? { ...x, tree, last: "just now" } : x)) })}
              onClose={() => setBrowsing(null)} />
          );
        }
        const sk = org.skills.find((k) => k.id === browsing.id);
        if (!sk) return null;
        return (
          <StoreBrowser title={sk.name} root={"store://skills/" + sk.name}
            subMono={"store://skills/" + sk.name + "/ · SKILL.md + supporting files"} metaTail={"updated " + sk.upd}
            tree={sk.tree || []} push={push} captureText="SKILL.md"
            onCaptureText={(text) => {
              patchOrg({ skills: org.skills.map((x) => (x.id === sk.id ? { ...x, body: text, upd: "just now" } : x)) });
              push("SKILL.md content captured — fully editable in the skill editor");
            }}
            onChange={(tree) => patchOrg({ skills: org.skills.map((x) => (x.id === sk.id ? { ...x, tree, upd: "just now" } : x)) })}
            onClose={() => setBrowsing(null)} />
        );
      })()}
      {modal && modal.kind === "mcp" && <McpModal initial={modal.item} onClose={() => setModal(null)} onSave={saveMcp} />}
      {modal && modal.kind === "skill" && <SkillModal initial={modal.item} onClose={() => setModal(null)} onSave={saveSkill} />}
      {modal && modal.kind === "agent" && <AgentModal initial={modal.item} org={org} onClose={() => setModal(null)} onSave={saveAgent} />}
      {confirm && (
        <ConfirmDelete what={confirm.item.name}
          detail={confirm.kind === "kb" ? "The index is removed from the store. Profiles referencing it simply stop loading it — nothing else breaks."
            : confirm.kind === "mcp" ? "Profiles referencing this server lose its tools on their next run."
            : confirm.kind === "skill" ? "store://skills/" + confirm.item.name + ".md is deleted. Profiles referencing it stop loading it."
            : "The base definition is deleted. It isn't deployed anywhere."}
          onCancel={() => setConfirm(null)} onConfirm={doDelete} />
      )}
    </div>
  );
}

/* ---------- shell ---------- */
const SETTINGS_TABS = [
  { id: "connections", label: "GitHub connections", icon: "github" },
  { id: "users", label: "Users & access", icon: "user" },
  { id: "resources", label: "Agent resources", icon: "memory" },
];

function OrgSettings({ tab, onTab, onBack, org, patchOrg, push }) {
  const counts = {
    connections: org.connections.length,
    users: org.users.length,
    resources: org.kbs.length + org.mcps.length + org.skills.length + org.gagents.length,
  };
  return (
    <main className="home-shell" data-screen-label="Viberr settings">
      <div className="set-head">
        <button className="btn ghost sm" onClick={onBack}><Icon name="arrow" className="r180" />Projects</button>
        <div>
          <h1>Viberr settings</h1>
          <p className="sub">Instance level — shared by every project and board. Board-level workflow &amp; policy live inside each project.</p>
        </div>
      </div>
      <div className="set-layout">
        <nav className="set-nav" aria-label="Settings sections">
          {SETTINGS_TABS.map((t) => (
            <button key={t.id} className={"nav-item" + (tab === t.id ? " active" : "")} onClick={() => onTab(t.id)}>
              <Icon name={t.icon} className="ico" />
              {t.label}
              <span className="count">{counts[t.id]}</span>
            </button>
          ))}
        </nav>
        <div className="set-content">
          {tab === "connections" && <ConnectionsPanel org={org} patchOrg={patchOrg} push={push} />}
          {tab === "users" && <UsersPanel org={org} patchOrg={patchOrg} push={push} />}
          {tab === "resources" && <ResourcesPanel org={org} patchOrg={patchOrg} push={push} />}
        </div>
      </div>
    </main>
  );
}

Object.assign(window, { ORG_DEFAULTS, loadOrg, saveOrg, OrgSettings });
