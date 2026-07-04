# Porting spec — Login (`design/html-app/app/login.jsx` → `/login`)

Source of truth: `design/html-app/app/login.jsx` (165 lines), host page `design/html-app/Viberr Login.html`, shared helpers `design/html-app/app/ui.jsx`, data/session shim `design/html-app/app/data.js`, org/user shapes `design/html-app/app/org-settings.jsx`. CSS: `home.css` ("Login" section, lines ~452–483) + `viberr.css` (`.btn`, `.field`, `.cred-warn`, `.mark`, `.mono`). Class names are the contract — port markup 1:1.

---

## 1. Purpose & entry points

The sign-in screen for a self-hosted Viberr instance. One centered card, two jobs:

1. **OAuth providers (GitHub / Google)** — whitelist-based: whitelisted people "just sign in", no invite emails. In the mock these are stubbed: clicking fakes a 900 ms "Checking whitelist…" then shows an info banner saying OAuth isn't wired and pointing at the local demo account.
2. **Local account** — email + password form. The mock validates against hardcoded `arda@viberr.dev` / localStorage-stored password (default `2828`). On success it writes a localStorage session and hard-navigates to `Viberr Home.html`.

There is a second full-card state: **forced password reset**. If an admin flagged the user (`pwreset: true` on the org user record — set from Org Settings → Users → "Reset password"), a successful credential check does NOT log in; instead the card is replaced by a "Set a new password" form. Saving stores the new password, clears the flag, and completes login.

### Entry points / redirect rules (mock)

- `Viberr Login.html` loads `data.js`, `ui.jsx`, `login.jsx` (React 18 UMD + Babel standalone, no build).
- Module scope guard — **before rendering anything**:

  ```jsx
  if (window.VIBERR.session.get()) {
    location.replace("Viberr Home.html");
  } else {
    ReactDOM.createRoot(document.getElementById("root")).render(<LoginApp />);
  }
  ```

- Successful login: `finish()` → `window.VIBERR.session.set(...)` then `location.href = "Viberr Home.html"`.
- Every other page (`home.jsx:633`, `main.jsx:323`) does the inverse guard: no session → `location.replace("Viberr Login.html")`.
- Sign out (user menu in `home.jsx:479` / `main.jsx:64`): `window.VIBERR.session.clear(); location.href = "Viberr Login.html"`.

### Entry points (real app, per CONVENTIONS route map)

- `GET /login` — loader: if a valid session cookie exists → `redirect("/")`. Otherwise render page. If the session is in "must reset password" state, render the reset step (see §4.3) — server-decided, not client state.
- `POST /login` — action (intents `login` and `set-password`, or two routes; see §5).
- `POST /logout` — clears server session + cookie, redirects to `/login` (consumed by shell spec, listed here for symmetry).
- `/auth/github`, `/auth/github/callback`, `/auth/google`, `/auth/google/callback` — real OAuth, only active when env credentials exist (Phase 2 build plan).
- Unauthenticated access to any protected route → redirect to `/login` (auth middleware).

---

## 2. Component tree

Mock is a single component + module-scope guard. Suggested real structure (`app/routes/login.tsx` thin, delegating to `app/features/auth/`):

| Mock | One-liner | Real-app home |
|---|---|---|
| module guard (lines 161–165) | Redirect to home when already authenticated | `/login` loader |
| `LoginApp` | Whole page; owns email/pw/err/info/busy/reset/npw/npw2 state; renders one of two cards | `LoginPage` (feature component) |
| — brand block | `V` mark tile + `h1` + subtitle | inline JSX |
| — provider buttons | GitHub (inverted dark) + Google (`G` glyph) whitelist buttons with per-button busy state | `ProviderButtons` or inline |
| — info banner (`cred-warn`) | Amber notice under providers: OAuth-not-wired hint or forgot-password guidance | inline, rendered from action/loader data |
| — local form | Email (`mono`) + password fields, error row, primary submit, "Forgot password?" foot | `<Form method="post">` |
| — tagline (`login-tag`) | Mono footer line explaining whitelist-based access | inline |
| reset card (lines 75–103) | Full replacement card: new password + confirm + error + "Save & continue" | separate render branch driven by server state |
| `Icon` (from `ui.jsx`) | 24×24 stroke SVG by name; used here: `alert`, `refresh`, `github` | `app/ui/icon.tsx` (ported once, Phase 1/4) |

No other `ui.jsx` helpers are used by this page (no Pill/Avatar/Toast). `data.js` is used only for `window.VIBERR.session`.

---

## 3. Data consumed

### 3.1 Session (mock: localStorage `viberr:session`)

`data.js:722–726`:

```js
session: {
  get: () => JSON.parse(localStorage.getItem("viberr:session") || "null"),
  set: (s) => localStorage.setItem("viberr:session", JSON.stringify(s)),
  clear: () => localStorage.removeItem("viberr:session"),
}
```

Session value written on login (`login.jsx:37`):

```js
{ user: "u-arda", name: "Arda Kaya", idp: "local", at: Date.now() }
```

**Real app:** server-side `sessions` table + HTTP-only signed cookie. Session row should carry at least `user_id`, `created_at`, `expires_at`, and a `must_reset_password`-style marker if you model forced reset as a partial session (see §7). The `name`/`idp` come from joining `users` at load time, not from the cookie.

### 3.2 Password (mock: localStorage `viberr:pw:arda`, default `"2828"`)

`login.jsx:5–7`. Single hardcoded account; email compare is `trim().toLowerCase()` and also accepts bare `"arda"`.

**Real app:** `users.password_hash` (scrypt per BUILD-PLAN Phase 2), verified in `app/server/auth/`. Seed the demo admin `arda@viberr.dev` with password `2828` so the mock's on-screen hints stay true for the seeded instance. Drop the `"arda"` shorthand — email only.

### 3.3 Forced-reset flag (mock: org blob `viberr:org:v10` → `users[].pwreset`)

`login.jsx:9–24` reads/clears it; Org Settings sets it (`org-settings.jsx:468`: `pwreset: true` + toast "Password reset — {name} sets a new password at next sign-in"). Org user record shape (from `ORG_DEFAULTS`, `org-settings.jsx:13–18`):

```js
{ id: "u-arda", name: "Arda Kaya", email: "arda@viberr.dev", initials: "AK",
  tone: "", role: "admin", status: "active", you: true, idp: "local", pwreset?: true }
```

- `idp`: `"github" | "google" | "local"` — which identity provider the account uses.
- `status`: `"active" | "whitelisted"` (whitelisted = allowed but has never signed in).
- `role`: `"admin" | "member"` (conventions add `viewer`).

**Real app:** boolean column on `users` (e.g. `password_reset_required`), set by the org-admin action, checked in the login action, cleared in the set-password action. Not a projection — this is SQLite-native auth data, no file backing (files are canonical for *task/project* state only).

### 3.4 Whitelist data (consumed indirectly — messaging only on this page)

Mock org also has `domains: [{ id: "d-1", domain: "@viberr.dev", role: "member" }]` — Google domain whitelist. The login page never reads users/domains for OAuth in the mock (providers are stubbed), but the real OAuth callbacks must: GitHub → match whitelisted handle; Google → match whitelisted email or domain; on first successful sign-in flip `status: "whitelisted" → "active"` and sync name/email from the IdP (org-settings copy: "Name & email sync from GitHub/Google at each sign-in").

### 3.5 Env

- `GITHUB_CLIENT_ID/SECRET`, `GOOGLE_CLIENT_ID/SECRET` (exact names per Phase 1 config module): presence decides whether provider buttons perform real OAuth or show the "not wired" info banner (BUILD-PLAN: "hide/disable buttons with the mock's 'not wired' messaging otherwise" — see §7).

### 3.6 Theme bootstrap

`Viberr Login.html` head has an inline script applying `data-theme`/`data-motion` from `viberr:prefs` before paint. Real app: cookie-based SSR-safe theme on `<html>` (per CONVENTIONS), shared with all routes — nothing login-specific beyond making sure `/login` gets it too (it renders outside the app shell).

---

## 4. UI states & interactions

State machine: `busy ∈ {null, "github", "google", "local"}`, `err: string|null`, `info: string|null`, `reset: boolean`. `err` renders inside the form (`login-err`); `info` renders under the providers (`cred-warn`). All actions early-return when `busy` is set.

### 4.1 Default card (`data-screen-label="Login"`)

Brand block:

- `V` tile (`span.mark`), `h1` **"Sign in to Viberr"**, sub **"Self-hosted · collaborative agentic AI delivery"** (interpunct `·`).

Provider buttons — verbatim:

```jsx
<div className="login-providers">
  <button className="btn provider github" onClick={() => provider("github")} style={busy === "github" ? { opacity: .7, pointerEvents: "none" } : null}>
    <Icon name={busy === "github" ? "refresh" : "github"} className={busy === "github" ? "spin" : ""} />
    {busy === "github" ? "Checking whitelist…" : "Continue with GitHub"}
  </button>
  <button className="btn provider" onClick={() => provider("google")} style={busy === "google" ? { opacity: .7, pointerEvents: "none" } : null}>
    {busy === "google" ? <Icon name="refresh" className="spin" /> : <span className="gmark lg">G</span>}
    {busy === "google" ? "Checking whitelist…" : "Continue with Google"}
  </button>
</div>
{info && <div className="cred-warn"><Icon name="alert" />{info}</div>}
```

Notes: the Google glyph is a **styled text span** `<span className="gmark lg">G</span>`, not an SVG icon. GitHub button is the inverted variant (`.btn.provider.github` → `background: var(--fg); color: var(--surface)`). Busy = label swap + ellipsis char `…` + refresh icon + inline `opacity:.7; pointerEvents:none`.

`provider(which)` (mock): clears `err` and `info`, sets `busy`, and after 900 ms sets info:

> `"GitHub OAuth isn't wired in this prototype — use the local account: arda@viberr.dev · password 2828."` (or `"Google OAuth isn't wired…"`)

Divider: `<div className="login-div">or a local account</div>` (hairline rules via `::before/::after`).

Local form:

- Email field: `label.flabel[htmlFor="lg-email"]` **"Email"**; `input#lg-email[type=text].mono` placeholder **"arda@viberr.dev"**.
- Password field: `label.flabel[htmlFor="lg-pw"]` **"Password"**; `input#lg-pw[type=password]` placeholder **"••••"** (four U+2022 bullets).
- Both inputs: `onChange` also clears `err`; `Enter` key submits (`onKeyDown` → `submit()`).
- Error row (renders between fields and button): `{err && <div className="login-err"><Icon name="alert" />{err}</div>}`
- Submit: `<button className="btn primary provider">` — label **"Sign in"**, busy label **"Signing in…"**, same inline busy style.
- Foot:

  ```jsx
  <div className="login-foot">
    <button className="linkish" style={{ fontSize: ".78rem", color: "var(--faint)" }}
      onClick={() => { setErr(null); setInfo("Ask an admin to reset your password — you'll be prompted to set a new one at your next sign-in."); }}>
      Forgot password?
    </button>
  </div>
  ```

  "Forgot password?" performs **no mutation** — it only swaps in that info banner (self-hosted model: no email-based self-service reset).

Tagline: `<div className="login-tag">whitelist-based access — GitHub &amp; Google accounts sign in directly once whitelisted</div>`.

### 4.2 Validation & error copy (exact strings, in check order)

`submit()` — client-side in mock; ALL must be re-validated in the server action:

1. Empty email → **"Enter your email."**
2. Email is neither `arda@viberr.dev` nor `arda` (after trim+lowercase) → **"No local account for that email — ask an admin to create one, or sign in with GitHub / Google if you're whitelisted."**
3. Password mismatch → **"Wrong password. Ask an admin to reset it if you're locked out."**
4. Otherwise: clear err, `busy="local"`, 700 ms fake delay, then: if `pwresetPending()` → switch to reset card (does NOT create a session); else `finish()`.

Note the mock deliberately distinguishes "unknown account" from "wrong password". Keep the copy as-is (design decision favoring admin-mediated self-hosted UX over enumeration resistance — see Open questions).

`info` is cleared on submit and on provider click; `err` is cleared on any input change, provider click, and Forgot click. They occupy different slots and are never both freshly set by one interaction.

### 4.3 Forced password-reset step (`data-screen-label="Login — set new password"`)

Entered only after correct email+password when the user record has `pwreset: true`. Entire card is replaced — verbatim:

```jsx
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
        <input id="npw" type="password" value={npw} autoFocus onChange={...clears err}
          onKeyDown={(e) => { if (e.key === "Enter") saveNew(); }} />
      </div>
      <div className="field">
        <label className="flabel" htmlFor="npw2">Confirm password</label>
        <input id="npw2" type="password" value={npw2} onChange={...clears err}
          onKeyDown={(e) => { if (e.key === "Enter") saveNew(); }} />
      </div>
      {err && <div className="login-err"><Icon name="alert" />{err}</div>}
      <button className="btn primary provider" onClick={saveNew}>Save &amp; continue</button>
    </div>
  </div>
</div>
```

No provider buttons, no divider, no tagline, no forgot link. First field has `autoFocus`. `saveNew()` validation (exact copy):

1. Length < 4 → **"New password needs at least 4 characters."**
2. Mismatch → **"Passwords don't match."**
3. Else: persist new password, clear `pwreset` flag, clear err, `finish()` (session + redirect home). No busy state on this button in the mock.

### 4.4 Keyboard / a11y inventory

- Enter submits in all four inputs (email, pw, npw, npw2).
- All labels are real `<label htmlFor>` pairs; ids: `lg-email`, `lg-pw`, `npw`, `npw2`.
- `Icon` renders `aria-hidden="true"` SVGs (from `ui.jsx`).
- Mock gaps to fix in port (allowed as a11y enhancement, not structural change): error/info divs have no `role="alert"`/`aria-live`; busy buttons use inline `pointerEvents:none` instead of `disabled`/`aria-busy`; email input is `type="text"` (keep — avoids browser email validation fighting server errors — but add `autoComplete="username"` / `autoComplete="current-password"` / `autoComplete="new-password"`).
- `data-screen-label` is mock screenshot tooling — drop in the port (do this consistently across all pages).

---

## 5. Events / mutations produced

**No typed timeline events.** Login is not task-scoped; nothing is written into any `task.md`. This page is the exception to the "every action writes a timeline event" habit.

Real actions to implement (Phase 2):

| Mock behavior | Real mutation |
|---|---|
| `submit()` happy path → `session.set(...)` + `location.href` | `POST /login` intent `login` `{ email, password }`: verify scrypt hash; on success create session row, set cookie, `redirect("/")`. On `password_reset_required` → do NOT issue a full session; return/redirect to reset step with a server-held partial credential (short-lived reset token or flagged session that every other loader rejects). CSRF-protected like all actions. |
| `saveNew()` → `localStorage.setItem(PW_KEY, npw)` + `clearPwReset()` + `finish()` | `POST /login` intent `set-password` `{ newPassword, confirm }`: requires the partial-auth state from above; validate (≥4 chars, match); hash + update `users.password_hash`; clear `password_reset_required`; upgrade to full session; `redirect("/")`. |
| provider stub (900 ms + info banner) | With env creds: `GET /auth/github` → OAuth dance → callback checks whitelist (`users` by handle/email, `domains` by suffix), flips `whitelisted→active`, syncs name/email, creates session, redirects `/`. Without env creds: no navigation — the action/loader supplies the info-banner copy (adapted, see §6/§8). Whitelist-rejected callback → back to `/login` with an error banner. |
| Forgot password? | No mutation, ever. Pure info banner. Client-side state is fine. |
| Module-scope `location.replace` guard | `/login` loader redirect when already authenticated. |
| Sign-out (from shell) | `POST /logout`: delete session row, clear cookie, redirect `/login`. |

Audit: record `auth`-domain audit events for login success/failure, forced-reset completion, OAuth whitelist rejection, logout (audit_events table; they surface later in Activity/org audit views). Conventions' governed-action list doesn't name login explicitly — flagged in Open questions, but recording is cheap and matches the "audit policy" tone of the product.

Validation errors return as action data rendered into the same `login-err` / `cred-warn` slots — reuse the mock's exact strings from §4.2/§4.3.

---

## 6. CSS classes used (the contract)

All already exist in the ported stylesheets — **no new CSS needed except one fix (spin, below)**.

Structural (from `home.css` "Login" section, lines ~452–483):

- `login-wrap` — full-viewport grid, centers the card (`min-height: 100vh; place-items: center`).
- `login-card` — `min(430px, 100%)` surface panel, `--radius-panel`, `--shadow-card`, column flex `gap: 1.1rem`.
- `login-brand` (+ nested `.mark`, `h1`, `.sub`) — centered brand stack; `.mark` is the shared V-tile (`viberr.css:127`) with a login-specific 46px override.
- `login-providers` — column flex of provider buttons.
- `btn provider` — full-width 44px-min centered button; `btn provider github` — inverted (fg-on-surface); `btn primary provider` — blue primary, full width (submit + Save & continue).
- `gmark lg` — the Google "G" text glyph (`home.css:404–405`, `.btn.provider .gmark.lg` at 1.05rem).
- `login-div` — "or a local account" divider with hairline `::before/::after`.
- `login-form`, `field`, `flabel` — form stack; `flabel` is the uppercase micro-label (`viberr.css:1102–1113` for field/input styling); `mono` on the email input.
- `login-err` — coral-tinted error row with `alert` icon.
- `cred-warn` — amber info banner (`viberr.css:1384`); shared with credential warnings elsewhere; its sibling `cred-ok` is used by org-settings, not here.
- `login-foot` — right-aligned foot row; `linkish` — unstyled button-as-link (`home.css:409`).
- `login-tag` — mono, centered, placeholder-colored footer tagline.
- `ico` (inside `Icon`), `spin` — see gotcha below.

**Gotcha:** the only `spin` animation rule is scoped `.store-strip .spin` (`home.css:282`), so the login page's `Icon className="spin"` never actually animates in the mock (`@keyframes spin` does exist at `home.css:283`). In the port, add a global `.spin { animation: spin 1s linear infinite; }` in the appended section of `app/app.css` so the "Checking whitelist…" refresh icon really spins.

---

## 7. Porting notes

Prototype-only → replacement:

1. **Module-scope redirect + `location.href`/`location.replace` page hops** → loader redirects and `redirect()` from actions. Targets: `Viberr Home.html` → `/`, `Viberr Login.html` → `/login`.
2. **`window.VIBERR.session` (localStorage)** → server sessions + HTTP-only cookie. Nothing on the client stores identity.
3. **`viberr:pw:arda` localStorage password + `getPw()` default `"2828"`** → scrypt-hashed `users.password_hash`; seed `arda@viberr.dev` / `2828` (+ Selin as the second `idp: local` seed user).
4. **`viberr:org:v10` blob + `pwresetPending()/clearPwReset()`** → `users.password_reset_required` column; read in login action, cleared in set-password action; set by org-admin action (org-settings spec).
5. **`setTimeout` fake latencies (900 ms provider / 700 ms local)** → delete; use React Router pending state (`useNavigation`) to drive the exact same busy labels ("Checking whitelist…", "Signing in…").
6. **Client-only forced-reset gating** — in the mock, `finish()` is reachable from devtools regardless of the flag, and the reset step is just `useState`. The real reset step MUST be server-authoritative: correct credentials + flag ⇒ no full session; the set-password action must require proof of the credential check (short-lived token or flagged partial session). A user who closes the tab mid-reset and comes back must land on the reset step again after re-entering credentials.
7. **`"arda"` bare-username shorthand** (`login.jsx:55`) → drop; real accounts match on email only (still trim+lowercase before lookup).
8. **Hardcoded single account** → lookup in `users` where `idp = 'local'`. A local-account email that exists but with `idp: github|google` should get messaging steering to the right provider (mock never handles this — see Open questions).
9. **Provider stub info copy** references "this prototype" — when OAuth env creds are absent, keep the banner mechanism and adapt copy, e.g. "GitHub OAuth isn't configured on this instance — use a local account…" (BUILD-PLAN explicitly wants the mock's "not wired" messaging preserved in spirit; exact copy in Open questions). When creds ARE present, buttons become real links/forms to `/auth/github|google` and the banner slot is used for OAuth/whitelist errors instead.
10. **Inline busy styles** `{ opacity: .7, pointerEvents: "none" }` → keep visuals but use `disabled` + `aria-busy="true"` (style `.btn:disabled` equivalently in appended CSS if needed).
11. **`data-screen-label`** attributes → drop (screenshot tooling).
12. **Icon component** — needs only `alert`, `refresh`, `github` here; comes from the shared `app/ui/icon.tsx` port of `ui.jsx`'s `ICON_PATHS` (note: mock uses `dangerouslySetInnerHTML` — fine to keep).
13. **Fonts/CSP** — host HTML pulls Google Fonts + unpkg React; the real app self-hosts fonts and bundles (Phase 1 concern, but `/login` is the first page that will expose a miss).
14. **Theme flash guard** — replicate via SSR cookie theme on `<html>` so `/login` honors dark mode on first paint.

Edge cases & empty/error states:

- Both `err` and `info` slots empty by default; page has no loading/empty skeleton — it's fully static until interaction.
- `err` clears on every keystroke in any input (mock behavior — keep; with server-returned errors, clear client-side on change).
- Double-submit guarded by `busy` check — real app: disable while `navigation.state !== "idle"`; the action itself must also be safe under retry (login is naturally idempotent; set-password should tolerate a retried identical submit).
- Reset step keeps NO memory of the entered login password; it does not re-prompt email. Server must carry that context.
- Whitespace/caps in email are forgiven (`trim().toLowerCase()`); password is compared exactly (no trim) — preserve both.
- Enter in the confirm field submits even if the first field is empty → server returns the length error; same UX as mock.
- If a logged-in user somehow POSTs to `/login`, just redirect `/` (don't create a second session).

---

## 8. Open questions

1. **OAuth-not-configured copy** — exact production wording for the `cred-warn` banner (and whether to hide vs. disable the buttons; BUILD-PLAN says "hide/disable … with the mock's 'not wired' messaging", pick one). Suggested: keep buttons visible+clickable and show adapted banner, preserving the mock's discoverability.
2. **Whitelist-rejection copy** for real OAuth callbacks (mock has none). Suggested tone: mirror error #2 — "That GitHub account isn't whitelisted on this instance — ask an admin to add you."
3. **`redirectTo` support** — mock always lands on Home. Should `/login?redirectTo=/projects/x/tasks/y` round-trip through login (and OAuth state param)? Recommended yes for deep links.
4. **Password policy** — mock minimum is 4 chars (and seed password `2828` is exactly 4). Keep 4 for seed compatibility or raise (and change seeds + on-screen hint copy)?
5. **Account-enumeration stance** — mock intentionally distinguishes "no local account" from "wrong password". Keep verbatim (self-hosted, admin-mediated) or collapse to one message?
6. **Rate limiting / lockout** on the login action ("Ask an admin to reset it if you're locked out." implies a lockout concept that the mock never implements).
7. **Session lifetime** & sliding expiry; no "remember me" UI exists in the mock — confirm none should be added.
8. **Audit granularity** — log failed login attempts, or only successes + resets? (Conventions' governed-action list omits login.)
9. **Local account with pending setup** — org-settings creates local accounts with status `whitelisted` and copy "they set a password from the setup link", but no setup-link flow exists anywhere in the mock. Does first-login-with-flagged-reset double as the setup flow, or is a real setup-link flow in scope for Phase 2?
10. **Google button glyph** — keep the text-span `G` (`gmark lg`) verbatim, or substitute a real logo asset? (Keep the span: it's the CSS contract and avoids brand-asset licensing.)
