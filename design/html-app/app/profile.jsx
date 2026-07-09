/* Viberr — Profile & preferences (personal, account-level: FR1/FR2, NFR10, WCAG light+dark) */
const { useState: useStateP } = React;

/* ---------- Identity ---------- */
function ProfileIdentity({ me, setMe, push }) {
  const commit = () => push("Profile saved — visible to Viberr Core members");
  return (
    <div className="panel">
      <div className="panel-head"><Icon name="user" /><h2>Profile</h2></div>
      <div className="profile-id">
        <span className="avatar xl">{initialsOf(me.name)}</span>
        <div className="profile-fields">
          <div className="field-row">
            <div className="field">
              <label className="flabel">Display name</label>
              <input type="text" value={me.name} onChange={(e) => setMe({ ...me, name: e.target.value })} onBlur={commit} />
            </div>
            <div className="field">
              <label className="flabel">Title</label>
              <input type="text" value={me.title} onChange={(e) => setMe({ ...me, title: e.target.value })} onBlur={commit} />
            </div>
          </div>
          <div className="field">
            <label className="flabel">Email <span className="fhint">local account · admins can edit</span></label>
            <input type="text" value="arda@viberr.dev" disabled />
          </div>
        </div>
      </div>
      <div className="kv" style={{ marginTop: ".9rem" }}>
        <div className="kv-row"><span className="k">Member of</span><span className="v">Viberr Core<Pill kind="info" sm>maintainer</Pill></span></div>
        <div className="kv-row"><span className="k">Signs in via</span><span className="v"><Icon name="lock" /><span className="mono">local account</span></span></div>
        <div className="kv-row"><span className="k">Joined</span><span className="v">Feb 18</span></div>
      </div>
    </div>
  );
}

/* ---------- Role-derived access (read-only view of RBAC) ---------- */
function ProfileAccess({ onNav }) {
  const P = window.VIBERR.policy;
  return (
    <div className="panel">
      <div className="panel-head"><Icon name="shield" /><h2>Your access</h2>
        <span className="right"><Pill kind="info" sm>maintainer</Pill></span>
      </div>
      <div className="kv">
        {P.rbac.map((r) => (
          <div className="kv-row" key={r.action}>
            <span className="k" style={{ color: "var(--fg)" }}>{r.action}</span>
            {r.grant.maintainer
              ? <span className="rbac-yes"><Icon name="check" /></span>
              : <span className="rbac-no">—</span>}
          </div>
        ))}
      </div>
      <div className="pol-note" style={{ margin: ".9rem 0 0" }}>
        <Icon name="lock" />
        <span>Your role is assigned by an admin and enforced on every governed action. Changes go through <button type="button" className="keybtn" onClick={() => onNav("policy")}>Policy → Human access</button></span>
      </div>
    </div>
  );
}

/* ---------- Notifications: routing for typed important events ---------- */
const PROFILE_NTF = [
  { id: "packets", n: "Decision packets for you", d: "Blocked decisions and completion reports waiting on your acceptance." },
  { id: "approvals", n: "Approval requests", d: "Operator transition requests at boundaries you can approve." },
  { id: "mentions", n: "Mentions & replies", d: "Comments addressed to you in task timelines." },
  { id: "policy", n: "Policy events", d: "Violations and blocked agent actions on tasks you can see." },
  { id: "quality", n: "Quality flags", d: "Specialist flags on tasks where you own review or acceptance." },
];
const PROFILE_NUDGE_HOURS = [1, 2, 4, 8, 24];

function ProfileNotifications({ push }) {
  const [ntf, setNtf] = useStateP(window.VIBERR.prefs.notifs);
  const [nudge, setNudge] = useStateP(window.VIBERR.prefs.nudge);

  const flip = (row, ch) => {
    const next = { ...ntf, [row.id]: { ...ntf[row.id], [ch]: !ntf[row.id][ch] } };
    setNtf(next);
    window.VIBERR.savePrefs({ notifs: next });
    push(row.n + " notifications " + (next[row.id][ch] ? "on" : "off"));
  };

  return (
    <div className="panel">
      <div className="panel-head"><Icon name="bell" /><h2>Notification routing</h2></div>
      <div>
        {PROFILE_NTF.map((row) => (
          <div className="pref-row" key={row.id}>
            <span className="pref-main">
              <div className="pn">{row.n}</div>
              <div className="pd">{row.d}</div>
            </span>
            <span className="ntf-cols">
              <span className="ntf-cell"><TglP on={!!ntf[row.id].app} onChange={() => flip(row, "app")} label={row.n} /></span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------- Appearance & workspace ---------- */
function ProfileAppearance({ theme, setTheme, push }) {
  const [motion, setMotion] = useStateP(window.VIBERR.prefs.motion);
  const [tl, setTl] = useStateP(window.VIBERR.prefs.tlDefault);
  const THEMES = [["light", "Light"], ["dark", "Dark"], ["system", "System"]];
  const TLS = [["all", "All"], ["typed", "Important"], ["comment", "Comments"]];

  const pickTheme = (v, l) => { setTheme(v); push("Theme · " + l + (v === "system" ? " (follows your OS)" : "")); };
  const flipMotion = () => {
    const next = motion === "reduce" ? "full" : "reduce";
    setMotion(next);
    window.VIBERR.savePrefs({ motion: next });
    push(next === "reduce" ? "Motion reduced — pulses and animation paused" : "Motion restored");
  };
  const pickTl = (v, l) => { setTl(v); window.VIBERR.savePrefs({ tlDefault: v }); push("Timeline opens on “" + l + "”"); };

  return (
    <div className="panel">
      <div className="panel-head"><Icon name="sparkle" /><h2>Appearance &amp; workspace</h2></div>
      <div>
        <div className="pref-row">
          <span className="pref-main">
            <div className="pn">Theme</div>
            <div className="pd">Light and dark both hold the WCAG AA baseline. Applies on this device.</div>
          </span>
          <span className="mini-seg">
            {THEMES.map(([v, l]) => (
              <button type="button" key={v} className={theme === v ? "on" : ""} onClick={() => pickTheme(v, l)}>{l}</button>
            ))}
          </span>
        </div>
        <div className="pref-row">
          <span className="pref-main">
            <div className="pn">Reduce motion</div>
            <div className="pd">Pauses live pulses and interface animation.</div>
          </span>
          <TglP on={motion === "reduce"} onChange={flipMotion} label="Reduce motion" />
        </div>
        <div className="pref-row">
          <span className="pref-main">
            <div className="pn">Timeline opens showing</div>
            <div className="pd">Default filter when you open a task — typed important events are kept either way.</div>
          </span>
          <span className="mini-seg">
            {TLS.map(([v, l]) => (
              <button type="button" key={v} className={tl === v ? "on" : ""} onClick={() => pickTl(v, l)}>{l}</button>
            ))}
          </span>
        </div>
      </div>
    </div>
  );
}

/* ---------- GitHub identity (attribution, not execution) ---------- */
function ProfileGithub({ onNav, push }) {
  const [gh, setGh] = useStateP(window.VIBERR.prefs.ghConnected !== false);
  const flip = (v, msg) => { setGh(v); window.VIBERR.savePrefs({ ghConnected: v }); push(msg); };
  return (
    <div className="panel">
      <div className="panel-head"><Icon name="github" /><h2>GitHub identity</h2></div>
      <div className="kv">
        <div className="kv-row"><span className="k">Workspace identity</span><span className="v"><span className="mono">arda@viberr.dev</span></span></div>
        <div className="kv-row"><span className="k">GitHub account</span><span className="v"><span className="mono">{gh ? "github.com/arda-kaya" : "not connected"}</span></span></div>
      </div>
      <div className="cred-card">
        <div className="cred-top">
          <Icon name="github" />
          <span className="cred-name">Personal OAuth identity</span>
          <span className="mono" style={{ marginLeft: "auto", color: "var(--faint)" }}>{gh ? "gho_••••7c1e" : "—"}</span>
        </div>
        <div className="scope-chips">
          <span className={"scope-chip" + (gh ? "" : " miss")}><Icon name={gh ? "check" : "alert"} />read:user</span>
          <span className={"scope-chip" + (gh ? "" : " miss")}><Icon name={gh ? "check" : "alert"} />user:email</span>
        </div>
        {gh ? (
          <div className="cred-ok">
            <Icon name="check" />
            <span>Connected — your approvals, acceptances, and runtime-session opens are attributed to <strong>arda-kaya</strong> in audit records.</span>
            <button type="button" className="btn ghost sm" style={{ marginLeft: "auto" }} onClick={() => flip(false, "GitHub disconnected — audit falls back to your workspace identity")}>Disconnect</button>
          </div>
        ) : (
          <div className="cred-warn">
            <Icon name="alert" />
            <span>Not connected — governance actions record under your workspace identity only, and your GitHub review approvals can't be matched back to you.</span>
            <button type="button" className="btn sm" style={{ marginLeft: "auto" }} onClick={() => flip(true, "GitHub connected as arda-kaya")}><Icon name="github" />Connect</button>
          </div>
        )}
      </div>
      <div className="pol-note" style={{ margin: ".9rem 0 0" }}>
        <Icon name="lock" />
        <span>This identity only attributes <strong>your</strong> actions. Agents execute with the project credential in <button type="button" className="keybtn" onClick={() => onNav("settings")}>Settings → Repository &amp; credentials</button> — secrets never appear in task records.</span>
      </div>
    </div>
  );
}

/* ---------- root ---------- */
function Profile({ me, setMe, theme, setTheme, onNav, push }) {
  return (
    <div className="board-wrap" data-screen-label="Profile & preferences">
      <div className="board-head">
        <div>
          <h1>Profile &amp; preferences</h1>
          <div className="sub">Personal to your account — project policy and roles stay in Policy</div>
        </div>
      </div>
      <div className="policy-wrap">
        <div className="profile-cols">
          <div className="profile-col">
            <ProfileIdentity me={me} setMe={setMe} push={push} />
            <ProfileNotifications push={push} />
          </div>
          <div className="profile-col">
            <ProfileAccess onNav={onNav} />
            <ProfileGithub onNav={onNav} push={push} />
          </div>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { Profile });
