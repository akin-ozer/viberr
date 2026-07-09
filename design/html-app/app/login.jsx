/* Viberr — sign in. Local accounts authenticate here; GitHub/Google are
   whitelist-based (stubbed in this prototype). Session → localStorage. */
const { useState: useStateL } = React;

const PW_KEY = "viberr:pw:arda";
const ORG_KEY = "viberr:org:v10";
const getPw = () => { try { return localStorage.getItem(PW_KEY) || "2828"; } catch (e) { return "2828"; } };

function pwresetPending() {
  try {
    const org = JSON.parse(localStorage.getItem(ORG_KEY) || "{}");
    const u = (org.users || []).find((x) => x.id === "u-arda");
    return !!(u && u.pwreset);
  } catch (e) { return false; }
}
function clearPwReset() {
  try {
    const org = JSON.parse(localStorage.getItem(ORG_KEY) || "{}");
    if (org.users) {
      org.users = org.users.map((x) => (x.id === "u-arda" ? { ...x, pwreset: false } : x));
      localStorage.setItem(ORG_KEY, JSON.stringify(org));
    }
  } catch (e) {}
}

function LoginApp() {
  const [email, setEmail] = useStateL("");
  const [pw, setPw] = useStateL("");
  const [err, setErr] = useStateL(null);
  const [info, setInfo] = useStateL(null);
  const [busy, setBusy] = useStateL(null);     // "github" | "google" | "local"
  const [reset, setReset] = useStateL(false);  // set-new-password step
  const [npw, setNpw] = useStateL("");
  const [npw2, setNpw2] = useStateL("");

  const finish = () => {
    window.VIBERR.session.set({ user: "u-arda", name: "Arda Kaya", idp: "local", at: Date.now() });
    location.href = "Viberr Home.html";
  };

  const provider = (which) => {
    if (busy) return;
    setErr(null); setInfo(null); setBusy(which);
    setTimeout(() => {
      setBusy(null);
      setInfo((which === "github" ? "GitHub" : "Google") + " OAuth isn't wired in this prototype — use the local account: arda@viberr.dev · password 2828.");
    }, 900);
  };

  const submit = () => {
    if (busy) return;
    const e = email.trim().toLowerCase();
    setInfo(null);
    if (!e) { setErr("Enter your email."); return; }
    if (e !== "arda@viberr.dev" && e !== "arda") { setErr("No local account for that email — ask an admin to create one, or sign in with GitHub / Google if you're whitelisted."); return; }
    if (pw !== getPw()) { setErr("Wrong password. Ask an admin to reset it if you're locked out."); return; }
    setErr(null);
    setBusy("local");
    setTimeout(() => {
      setBusy(null);
      if (pwresetPending()) { setReset(true); return; }
      finish();
    }, 700);
  };

  const saveNew = () => {
    if (npw.length < 4) { setErr("New password needs at least 4 characters."); return; }
    if (npw !== npw2) { setErr("Passwords don't match."); return; }
    try { localStorage.setItem(PW_KEY, npw); } catch (e) {}
    clearPwReset();
    setErr(null);
    finish();
  };

  if (reset) {
    return (
      <div className="login-wrap" data-screen-label="Login — set new password">
        <div className="login-card">
          <div className="login-brand">
            <span className="mark">V</span>
            <div>
              <h1>Set a new password</h1>
              <div className="sub">An admin reset your password — choose a new one to continue.</div>
            </div>
          </div>
          <div className="login-form">
            <div className="field">
              <label className="flabel" htmlFor="npw">New password</label>
              <input id="npw" type="password" value={npw} autoFocus onChange={(e) => { setNpw(e.target.value); setErr(null); }}
                onKeyDown={(e) => { if (e.key === "Enter") saveNew(); }} />
            </div>
            <div className="field">
              <label className="flabel" htmlFor="npw2">Confirm password</label>
              <input id="npw2" type="password" value={npw2} onChange={(e) => { setNpw2(e.target.value); setErr(null); }}
                onKeyDown={(e) => { if (e.key === "Enter") saveNew(); }} />
            </div>
            {err && <div className="login-err"><Icon name="alert" />{err}</div>}
            <button type="button" className="btn primary provider" onClick={saveNew}>Save &amp; continue</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="login-wrap" data-screen-label="Login">
      <div className="login-card">
        <div className="login-brand">
          <span className="mark">V</span>
          <div>
            <h1>Sign in to Viberr</h1>
            <div className="sub">Self-hosted · collaborative agentic AI delivery</div>
          </div>
        </div>

        <div className="login-providers">
          <button type="button" className="btn provider github" onClick={() => provider("github")} style={busy === "github" ? { opacity: .7, pointerEvents: "none" } : null}>
            <Icon name={busy === "github" ? "refresh" : "github"} className={busy === "github" ? "spin" : ""} />
            {busy === "github" ? "Checking whitelist…" : "Continue with GitHub"}
          </button>
          <button type="button" className="btn provider" onClick={() => provider("google")} style={busy === "google" ? { opacity: .7, pointerEvents: "none" } : null}>
            {busy === "google" ? <Icon name="refresh" className="spin" /> : <span className="gmark lg">G</span>}
            {busy === "google" ? "Checking whitelist…" : "Continue with Google"}
          </button>
        </div>
        {info && <div className="cred-warn"><Icon name="alert" />{info}</div>}

        <div className="login-div">or a local account</div>

        <div className="login-form">
          <div className="field">
            <label className="flabel" htmlFor="lg-email">Email</label>
            <input id="lg-email" type="text" className="mono" value={email} placeholder="arda@viberr.dev"
              onChange={(e) => { setEmail(e.target.value); setErr(null); }}
              onKeyDown={(e) => { if (e.key === "Enter") submit(); }} />
          </div>
          <div className="field">
            <label className="flabel" htmlFor="lg-pw">Password</label>
            <input id="lg-pw" type="password" value={pw} placeholder="••••"
              onChange={(e) => { setPw(e.target.value); setErr(null); }}
              onKeyDown={(e) => { if (e.key === "Enter") submit(); }} />
          </div>
          {err && <div className="login-err"><Icon name="alert" />{err}</div>}
          <button type="button" className="btn primary provider" onClick={submit} style={busy === "local" ? { opacity: .7, pointerEvents: "none" } : null}>
            {busy === "local" ? "Signing in…" : "Sign in"}
          </button>
          <div className="login-foot">
            <button type="button" className="linkish" style={{ fontSize: ".78rem", color: "var(--faint)" }}
              onClick={() => { setErr(null); setInfo("Ask an admin to reset your password — you'll be prompted to set a new one at your next sign-in."); }}>
              Forgot password?
            </button>
          </div>
        </div>

        <div className="login-tag">whitelist-based access — GitHub &amp; Google accounts sign in directly once whitelisted</div>
      </div>
    </div>
  );
}

if (window.VIBERR.session.get()) {
  location.replace("Viberr Home.html");
} else {
  ReactDOM.createRoot(document.getElementById("root")).render(<LoginApp />);
}
