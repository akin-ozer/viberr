# Porting spec — Profile & preferences overlay (`profile.jsx`)

Source: `design/html-app/app/profile.jsx` (228 lines). Shared helpers: `design/html-app/app/ui.jsx` (`PageOverlay`, `TglP`, `Icon`, `Pill`, `initialsOf`, `useToasts`, and the `initPrefs` IIFE). Data: `design/html-app/app/data.js` (`POLICY.rbac`, people). Shell wiring: `design/html-app/app/main.jsx` (lines ~45–73, 146–160, 284, 305–309) and `design/html-app/app/home.jsx` (lines ~297–340, 460–486, 615–620). Password machinery referenced in Porting notes: `design/html-app/app/login.jsx` (lines 5–25) and `design/html-app/app/org-settings.jsx` (lines ~410–470).

The porting engineer is expected to work from this document alone.

---

## 1. Purpose & entry points

"Profile & preferences" is the signed-in user's **personal, account-level settings surface**. It is deliberately scoped: page subtitle says *"Personal to your account — project policy and roles stay in Policy"*. It contains four panels in a 2-column grid:

1. **Profile** (identity) — display name, title, read-only email, membership facts.
2. **Notification routing** — per-category in-app notification toggles.
3. **Your access** — read-only view of the project RBAC matrix for the user's role, with a link out to Policy.
4. **GitHub identity** — personal OAuth connection used for **attribution only** (not execution), with connect/disconnect.

Plus (rendered inside panel 2's column in the mock source order): **Appearance & workspace** — theme (Light/Dark/System), reduce motion, default timeline filter. **Note:** `ProfileAppearance` is defined in `profile.jsx` but is **not rendered** by the `Profile` root in the current mock (see §2 and Open questions) — the root renders only Identity + Notifications in the left column and Access + GitHub in the right. The theme *state* still flows through `Profile`'s props because `ProfileAppearance` used to consume it; port the component and decide placement (recommendation: render it, see §8 Q1).

It is **not a page** in the mock — it is an overlay (`PageOverlay`) that floats above whatever screen is active, in **both** shells:

### Entry points in the mock

- **Workspace shell** (`main.jsx`): user menu (avatar, top-right) → menu item "Profile & preferences" → `setOverlay("profile")`. No hash route; `#profile` is *not* in the workspace's boot-hash regex.
- **Home shell** (`home.jsx`): same user-menu item, **plus** hash `#profile` opens the overlay directly at boot:
  ```js
  const [overlay, setOverlay] = useStateH(() => ((/^#(profile|notifications)$/.exec(location.hash) || [])[1] || null));
  ```
  Closing clears the hash: `history.replaceState(null, "", location.pathname + location.search)`.
- Both shells mount it identically:
  ```jsx
  <PageOverlay label="Profile & preferences" onClose={...}>
    <Profile me={me} setMe={setMe} theme={theme} setTheme={setTheme} onNav={...} push={push} />
  </PageOverlay>
  ```
  Differences in props:
  - Workspace: `me`/`setMe` is app-level `useState({ name: "Arda Kaya", title: "Senior engineer" })`; `onNav = (v) => { setOverlay(null); goView(v); }` (closes overlay, switches workspace view).
  - Home: `me`/`setMe` is a *separate* local `meProf` state (same initial value — the two shells do not share edits!); `onNav = (v) => { location.href = WORKSPACE + "#" + v; }` where `WORKSPACE = "Viberr Operator Workspace.html"` (cross-page navigation into the workspace).

### Entry points in the real app

- Route: an account-scoped overlay/route, e.g. `/account/profile` or a `?profile` search-param overlay available from every authenticated layout. Since the mock treats it as an overlay over any screen and Home supports deep-link via `#profile`, the cleanest RRv7 mapping is a **route rendered in an overlay outlet of the authenticated root layout** so it is deep-linkable (`/profile`) and dismissable back to the underlying page.
- Loader supplies: current user record (name, title, email, auth method, joined date), project membership + role, the RBAC matrix for the user's role, notification prefs, appearance prefs, GitHub identity connection state.
- The two `onNav` targets become plain links: "Policy → Human access" → policy route; "Settings → Repository & credentials" → project settings route.

---

## 2. Component tree

```
Profile                       — root; board-wrap layout, h1 + sub, 2-column grid
├─ ProfileIdentity            — avatar + display name/title inputs + read-only email + kv facts
├─ ProfileNotifications       — 5 pref-rows, one in-app toggle each (TglP)
├─ ProfileAccess              — RBAC matrix rows for role "maintainer", link to Policy
└─ ProfileGithub              — workspace/GitHub identity kv + cred-card with connect/disconnect

ProfileAppearance             — theme mini-seg, reduce-motion toggle, timeline-default mini-seg
                                (defined, currently NOT rendered by Profile root — see §8 Q1)
```

Module constants:
- `PROFILE_NTF` — the 5 notification categories (id, name, description); see §3.
- `PROFILE_NUDGE_HOURS = [1, 2, 4, 8, 24]` — **dead**: never rendered (nudge UI was cut; `nudge` state in `ProfileNotifications` is also read-only dead state).

Shared primitives consumed from `ui.jsx` (ported per `ui-primitives.md`; reuse):
- `PageOverlay({ label, onClose, children })` — scrim + `role="dialog" aria-modal="true"` panel with close X; Escape closes.
- `TglP({ on, onChange, label })` — `role="switch"` toggle button.
- `Icon`, `Pill`, `initialsOf(name)`.
- `push(text)` from `useToasts` (owned by the shell, passed down).

---

## 3. Data consumed

### 3.1 `me` (props `me`, `setMe`)

Mock shape (shell-local React state, **not** persisted, resets on reload):

```js
{ name: "Arda Kaya", title: "Senior engineer" }
```

Real app: the authenticated user row (SQLite `users` table): `name`, `title`, `email`, plus `created_at` (for "Joined"), auth method. Loaded from session → user query. Edits go through an action (§5).

### 3.2 Hardcoded identity facts (must become real data)

All of these are string literals in the mock and must come from session/user/membership queries:

| Mock literal | Where shown | Real source |
|---|---|---|
| `arda@viberr.dev` | disabled Email input; GitHub panel "Workspace identity" | `users.email` |
| `Viberr Core` + pill `maintainer` | kv "Member of" | project membership query (project name + role) |
| `local account` | kv "Signs in via" | `users.auth_method` (local vs OAuth IdP) |
| `Feb 18` | kv "Joined" | `users.created_at`, formatted |
| `maintainer` pill in "Your access" head | ProfileAccess | session user's role in the active project |
| `github.com/arda-kaya`, `arda-kaya`, `gho_••••7c1e` | ProfileGithub | user's GitHub identity link record (login, masked token) |

### 3.3 RBAC matrix — `window.VIBERR.policy.rbac`

Exact mock shape (`data.js` lines 632–642):

```js
rbac: [
  { action: "View board, tasks & timelines",  grant: { admin: 1, maintainer: 1, reviewer: 1, viewer: 1 } },
  { action: "Comment on tasks (app-wide)",    grant: { admin: 1, maintainer: 1, reviewer: 1, viewer: 1 } },
  { action: "Take / release task ownership",  grant: { admin: 1, maintainer: 1, reviewer: 1, viewer: 1 } },
  { action: "Release any task owner",         grant: { admin: 1, maintainer: 0, reviewer: 0, viewer: 0 } },
  { action: "Approve stage transitions",      grant: { admin: 1, maintainer: 1, reviewer: 0, viewer: 0 } },
  { action: "Accept completion → Done",       grant: { admin: 1, maintainer: 1, reviewer: 0, viewer: 0 } },
  { action: "Open agent runtime sessions",    grant: { admin: 1, maintainer: 1, reviewer: 0, viewer: 0 } },
  { action: "Manage members & roles",         grant: { admin: 1, maintainer: 0, reviewer: 0, viewer: 0 } },
  { action: "Edit workflow & policy",         grant: { admin: 1, maintainer: 0, reviewer: 0, viewer: 0 } },
]
```

`ProfileAccess` checks **`r.grant.maintainer` hardcoded** — it does *not* use the session user's actual role. Real app: read the RBAC matrix from the project policy file/projection (same source the Policy screen uses — see `policy.md`) and index `grant[sessionRole]`.

### 3.4 Preferences — `window.VIBERR.prefs` (localStorage `viberr:prefs`)

Defaults from the `initPrefs` IIFE in `ui.jsx` (lines 186–218):

```js
{
  theme: "system",            // "light" | "dark" | "system"
  motion: "full",             // "full" | "reduce"
  tlDefault: "all",           // "all" | "typed" | "comment"
  ghConnected: true,          // bool — GitHub identity linked
  notifs: {
    packets:   { app: true, email: true  },
    approvals: { app: true, email: false },
    mentions:  { app: true, email: true  },
    policy:    { app: true, email: true  },
    quality:   { app: true, email: false },
  },
  nudge: { on: true, hours: 2 },   // dead in current UI
}
```

Persistence: `window.VIBERR.savePrefs(patch)` shallow-merges the patch, writes JSON to localStorage, then re-applies `document.documentElement.dataset.theme` (`"dark"`/`"light"`, resolving `"system"` via `matchMedia("(prefers-color-scheme: dark)")`, with a change listener re-applying when theme is `"system"`) and `dataset.motion` (`"reduce"`/`"full"`).

Real app: per-user preferences. Recommended split:
- `theme`, `motion`, `tlDefault` — user prefs persisted server-side (SQLite `user_prefs` or a JSON column) **and** mirrored to a cookie so SSR can set `data-theme`/`data-motion` on `<html>` without a flash (see Porting notes).
- `notifs` — server-side rows/JSON; these drive real notification routing, so they cannot stay client-only.
- `ghConnected` — not a pref at all in the real app: derived from whether a GitHub identity row exists for the user (OAuth link).

### 3.5 Notification categories — `PROFILE_NTF` (module constant, port verbatim)

```js
const PROFILE_NTF = [
  { id: "packets",   n: "Decision packets for you", d: "Blocked decisions and completion reports waiting on your acceptance." },
  { id: "approvals", n: "Approval requests",        d: "Operator transition requests at boundaries you can approve." },
  { id: "mentions",  n: "Mentions & replies",       d: "Comments addressed to you in task timelines." },
  { id: "policy",    n: "Policy events",            d: "Violations and blocked agent actions on tasks you can see." },
  { id: "quality",   n: "Quality flags",            d: "Specialist flags on tasks where you own review or acceptance." },
];
```

These ids must match the notification `kind` taxonomy used by the notifications projection (`packet`, `approval`, `mention`, `policy`, `quality` — see `data.js` NOTIFICATIONS and the notifications spec).

### 3.6 Theme (props `theme`, `setTheme`)

Theme state is **owned by the shell**, not by Profile: `const [theme, setThemeRaw] = useState(window.VIBERR.prefs.theme); const setTheme = (v) => { setThemeRaw(v); window.VIBERR.savePrefs({ theme: v }); }`. The shell's user menu also cycles it (Light → Dark → System) independently of this overlay. Keep theme a shared, app-level concern in the real app (root layout state + fetcher action), not overlay-local.

---

## 4. UI states & interactions

### 4.0 Overlay chrome (`PageOverlay`, from ui.jsx — for reference)

```jsx
<React.Fragment>
  <div className="confirm-scrim" onClick={onClose}></div>
  <div className="page-overlay" role="dialog" aria-modal="true" aria-label={label} data-screen-label={label + " — overlay"}>
    <button className="icon-btn overlay-x" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
    <div className="page-overlay-body">{children}</div>
  </div>
</React.Fragment>
```

- `label` = `"Profile & preferences"`.
- **Escape** closes (window keydown listener). Scrim click closes. X button closes. No focus trap in the mock (add one — see Porting notes).

### 4.1 Page header

- `h1`: **"Profile & preferences"** (rendered as `Profile &amp; preferences`).
- `.sub`: **"Personal to your account — project policy and roles stay in Policy"**.
- Root wrapper: `<div className="board-wrap" data-screen-label="Profile & preferences">`, then `.policy-wrap > .profile-cols > .profile-col ×2`.

### 4.2 ProfileIdentity panel — "Profile"

- Panel head: `Icon name="user"` + `h2` "Profile".
- Left: `<span className="avatar xl">{initialsOf(me.name)}</span>` — initials recompute live as the name is edited (`initialsOf` = first letters of first two words, uppercased, `"?"` fallback).
- Fields (`.profile-fields`):
  - Row (`.field-row`) with two `.field`s:
    - **Display name** — text input bound to `me.name`; `onChange` updates state live; `onBlur` fires `commit`.
    - **Title** — text input bound to `me.title`; same live-update + blur-commit.
  - **Email** — label: `Email` with hint `<span className="fhint">local account · admins can edit</span>`; `<input type="text" value="arda@viberr.dev" disabled />`.
- `commit` (both name and title blur) → toast: **"Profile saved — visible to Viberr Core members"**. It fires on *every* blur, even with no change (fix in port: only on dirty).
- Facts block (`.kv` with `style={{ marginTop: ".9rem" }}`):

```jsx
<div className="kv-row"><span className="k">Member of</span><span className="v">Viberr Core<Pill kind="info" sm>maintainer</Pill></span></div>
<div className="kv-row"><span className="k">Signs in via</span><span className="v"><Icon name="lock" /><span className="mono">local account</span></span></div>
<div className="kv-row"><span className="k">Joined</span><span className="v">Feb 18</span></div>
```

### 4.3 ProfileNotifications panel — "Notification routing"

- Panel head: `Icon name="bell"` + `h2` "Notification routing".
- One `.pref-row` per `PROFILE_NTF` entry:

```jsx
<div className="pref-row" key={row.id}>
  <span className="pref-main">
    <div className="pn">{row.n}</div>
    <div className="pd">{row.d}</div>
  </span>
  <span className="ntf-cols">
    <span className="ntf-cell"><TglP on={!!ntf[row.id].app} onChange={() => flip(row, "app")} label={row.n} /></span>
  </span>
</div>
```

- **Only the `app` channel is surfaced.** The pref shape carries `email` booleans per category, but no email column is rendered (the `ntf-cols`/`ntf-cell` scaffolding suggests a second column existed once). Port only the app toggle; keep the email fields in the data model.
- Toggle behavior (`flip`): immutably flips `ntf[row.id][ch]`, saves via `savePrefs({ notifs: next })`, toast: `row.n + " notifications on"` / `"… off"` — e.g. **"Decision packets for you notifications off"**.
- `TglP` markup (a11y contract): `<button type="button" class="tgl on?" role="switch" aria-checked aria-label={row.n}><span class="knob"/></button>`.
- Dead state in this component: `const [nudge, setNudge] = useStateP(window.VIBERR.prefs.nudge);` — never rendered, never set. Do not port the UI; see Open questions Q3.

### 4.4 ProfileAppearance panel — "Appearance & workspace" (currently unmounted; port anyway)

- Panel head: `Icon name="sparkle"` + `h2` "Appearance & workspace".
- Three `.pref-row`s:

1. **Theme** — `pn` "Theme"; `pd` **"Light and dark both hold the WCAG AA baseline. Applies on this device."** Control: 3-button segment

   ```jsx
   <span className="mini-seg">
     {[["light","Light"],["dark","Dark"],["system","System"]].map(([v, l]) => (
       <button type="button" key={v} className={theme === v ? "on" : ""} onClick={() => pickTheme(v, l)}>{l}</button>
     ))}
   </span>
   ```

   `pickTheme(v, l)` → `setTheme(v)` (shell persists + applies `data-theme`) + toast `"Theme · " + l` with suffix `" (follows your OS)"` when `v === "system"` — e.g. **"Theme · System (follows your OS)"**.

2. **Reduce motion** — `pn` "Reduce motion"; `pd` "Pauses live pulses and interface animation." Control: `TglP` with `on={motion === "reduce"}`, `label="Reduce motion"`. Flip toggles `"reduce"`/`"full"`, `savePrefs({ motion: next })` (which sets `document.documentElement.dataset.motion`), toast: **"Motion reduced — pulses and animation paused"** / **"Motion restored"**. CSS hook (viberr.css:1723): `[data-motion="reduce"] *` kills animations/transitions.

3. **Timeline opens showing** — `pn` "Timeline opens showing"; `pd` "Default filter when you open a task — typed important events are kept either way." Control: mini-seg over `[["all","All"],["typed","Important"],["comment","Comments"]]` (note the value↔label mapping). `pickTl(v, l)` → `savePrefs({ tlDefault: v })`, toast: `'Timeline opens on "' + l + '"'` **with curly quotes** — e.g. **Timeline opens on “Important”**. Consumer: task detail timeline filter seeds from it (`task.jsx:326`: `useState((window.VIBERR.prefs && window.VIBERR.prefs.tlDefault) || "all")`).

### 4.5 ProfileAccess panel — "Your access"

- Panel head: `Icon name="shield"` + `h2` "Your access" + right-aligned `<span className="right"><Pill kind="info" sm>maintainer</Pill></span>`.
- Body: `.kv` of one `.kv-row` per rbac entry: left `<span className="k" style={{ color: "var(--fg)" }}>{r.action}</span>`; right either `<span className="rbac-yes"><Icon name="check" /></span>` (granted) or `<span className="rbac-no">—</span>`.
- Footer note (verbatim, includes the in-copy nav button):

```jsx
<div className="pol-note" style={{ margin: ".9rem 0 0" }}>
  <Icon name="lock" />
  <span>Your role is assigned by an admin and enforced on every governed action. Changes go through <button type="button" className="keybtn" onClick={() => onNav("policy")}>Policy → Human access</button></span>
</div>
```

- **Link behavior:** from the workspace shell this closes the overlay and switches to the Policy view; from Home it hard-navigates to `Viberr Operator Workspace.html#policy`. Real app: close overlay + navigate to the policy route of the active project.

### 4.6 ProfileGithub panel — "GitHub identity"

- Panel head: `Icon name="github"` + `h2` "GitHub identity".
- kv facts:
  - "Workspace identity" → `<span className="mono">arda@viberr.dev</span>`
  - "GitHub account" → `<span className="mono">{gh ? "github.com/arda-kaya" : "not connected"}</span>`
- Credential card — verbatim (this is the tricky markup):

```jsx
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
      <button className="btn ghost sm" style={{ marginLeft: "auto" }} onClick={() => flip(false, "GitHub disconnected — audit falls back to your workspace identity")}>Disconnect</button>
    </div>
  ) : (
    <div className="cred-warn">
      <Icon name="alert" />
      <span>Not connected — governance actions record under your workspace identity only, and your GitHub review approvals can't be matched back to you.</span>
      <button className="btn sm" style={{ marginLeft: "auto" }} onClick={() => flip(true, "GitHub connected as arda-kaya")}><Icon name="github" />Connect</button>
    </div>
  )}
</div>
```

- Connected/disconnected state: `const [gh, setGh] = useStateP(window.VIBERR.prefs.ghConnected !== false);` — persisted via `savePrefs({ ghConnected: v })`. Toasts: **"GitHub connected as arda-kaya"** / **"GitHub disconnected — audit falls back to your workspace identity"**.
- Footer note (verbatim; second in-copy nav link):

```jsx
<div className="pol-note" style={{ margin: ".9rem 0 0" }}>
  <Icon name="lock" />
  <span>This identity only attributes <strong>your</strong> actions. Agents execute with the project credential in <button type="button" className="keybtn" onClick={() => onNav("settings")}>Settings → Repository &amp; credentials</button> — secrets never appear in task records.</span>
</div>
```

### 4.7 Keyboard & a11y summary

- Escape closes the overlay (PageOverlay). Scrim click closes. Close button has `aria-label="Close"`.
- Overlay is `role="dialog" aria-modal="true" aria-label="Profile & preferences"`.
- All toggles are `role="switch"` with `aria-checked` and human `aria-label`s (the category name / "Reduce motion").
- Mini-seg theme buttons carry no `aria-pressed` in the mock — add `aria-pressed` or a radiogroup in the port.
- Toasts render into `ToastHost` (`role="status" aria-live="polite"`), owned by the shell.
- No focus trap and no focus restore in the mock — add both (dialog opens → focus close button or first field; close → restore trigger focus).

---

## 5. Events / mutations produced

Every mutation in the mock is either local React state or a `savePrefs` localStorage write plus a toast. Real actions to build:

| Mock behavior | Real action | Persistence | Timeline/audit event? |
|---|---|---|---|
| Name/Title blur-commit (toast "Profile saved — visible to Viberr Core members") | `POST /profile` (fetcher form, submit on blur when dirty) updating `users.name`, `users.title` | SQLite `users` | No task timeline event. Optional org-level audit entry (`profile.updated`) — mock writes none. |
| Notification toggle flip | `POST /profile/notifications` with `{ category, channel: "app", on }` | server-side user prefs | No. |
| Theme pick | shared theme action (cookie + user pref row); applies `data-theme` on `<html>` | cookie + SQLite | No. |
| Reduce-motion flip | same pattern; applies `data-motion` | cookie + SQLite | No. |
| Timeline-default pick | user pref update (`tlDefault`) | SQLite | No. |
| GitHub **Connect** | real OAuth flow: redirect to GitHub authorize (scopes `read:user`, `user:email`), callback stores identity link (login, masked token) | `user_identities` table | **Yes — audit-relevant.** Connecting/disconnecting changes how governance actions are attributed; write an org/user audit log entry (e.g. `identity.github.connected` / `identity.github.disconnected`). The mock's copy explicitly ties this to audit records. Not a *task* timeline event. |
| GitHub **Disconnect** | `POST /profile/github/disconnect` deleting/disabling the identity link | same | Same as above. |

Notes:
- **No typed task-timeline events originate from this surface.** The profile is account-level; the copy explicitly pushes project-affecting changes to Policy/Settings.
- The mock's `push(...)` toasts should be reproduced verbatim after successful actions (they double as the spec for success feedback).
- Edits are optimistic in the mock (state updates before "save"). Fetcher-based optimistic UI is fine; on failure, revert and show an error state (mock has none — see §7).

---

## 6. CSS classes used (contract)

Structural (all already in the ported `viberr.css`):

- Overlay: `confirm-scrim`, `page-overlay`, `page-overlay-body`, `icon-btn overlay-x`.
- Layout: `board-wrap`, `board-head`, `sub`, `policy-wrap`, `profile-cols` (2-col grid, collapses to 1 col at the responsive breakpoint ~viberr.css:1628), `profile-col`.
- Panels: `panel`, `panel-head` (with `h2`, `right`).
- Identity: `profile-id`, `avatar xl`, `profile-fields`, `field-row`, `field`, `flabel`, `fhint`.
- Facts: `kv`, `kv-row`, `k`, `v`, `mono`.
- Pref rows: `pref-row`, `pref-main`, `pn`, `pd`, `ntf-cols`, `ntf-cell`.
- Controls: `tgl` / `tgl on` / `knob` (TglP), `mini-seg` (+ per-button `on`), `keybtn`.
- RBAC: `rbac-yes`, `rbac-no`.
- GitHub card: `cred-card`, `cred-top`, `cred-name`, `scope-chips`, `scope-chip` (+ `miss`), `cred-ok`, `cred-warn`.
- Notes/buttons: `pol-note`, `btn`, `btn ghost sm`, `btn sm`, `pill info sm`, `ico`.
- Inline styles to keep: `kv` `marginTop:".9rem"`; `pol-note` `margin:".9rem 0 0"`; rbac action `color:"var(--fg)"`; cred-card token & buttons `marginLeft:"auto"` (token also `color:"var(--faint)"`).

---

## 7. Porting notes

**Prototype-only bits and their replacements**

1. `window.VIBERR.prefs` / `savePrefs` / localStorage `viberr:prefs` → server-persisted per-user prefs + a theme/motion cookie read by the root loader so SSR renders `<html data-theme=… data-motion=…>` with no flash. The `matchMedia` listener for `theme === "system"` must survive the port (client-side effect in the root layout), as must the `prefers-color-scheme` resolution.
2. Two divergent `me` states (workspace `me` vs Home `meProf`) → one user record from the DB. In the mock, editing your name on Home doesn't show in the workspace and vice-versa; a name edit also changes `myRole` resolution in the workspace (`members.find((m) => m.p.name === me.name)` — name-keyed!). Real app: key membership by user id, never by display name.
3. `ghConnected` pref-flag + fake token `gho_••••7c1e` → real GitHub OAuth identity link. The Connect button becomes a redirect to the OAuth flow; Disconnect a destructive action (consider a confirm — mock has none). Masked token comes from the stored credential, masked server-side; scopes rendered from what the grant actually returned, with `scope-chip miss` for missing ones.
4. Hardcoded `r.grant.maintainer` → `r.grant[sessionUserRole]`, RBAC matrix loaded from the same policy source as `policy.md`. The maintainer pill in the panel head and in "Member of" likewise comes from the session's membership.
5. `onNav("policy")` / `onNav("settings")` cross-shell hacks → real links (close overlay + navigate). From any surface these go to the *active project's* Policy and Settings routes; decide what they do when the overlay is opened from Home with no active project (disable, or link into the last-visited project — mock hard-codes the single workspace HTML file).
6. `data-screen-label` attributes are design-review scaffolding in the mock; keep or drop per the shell convention already chosen (other specs keep them).
7. Blur-commit fires unconditionally → only submit when dirty; also submit on Enter.
8. **Password change (in scope for the real profile, absent in the mock).** The mock has **no password UI in the profile**. Password machinery lives elsewhere:
   - `login.jsx`: password stored per-user in localStorage key `viberr:pw:arda`, default `"2828"` (`getPw`); a "Set a new password" step runs at sign-in when the org user record has `pwreset: true` (validation: min 4 chars — *"New password needs at least 4 characters."*; match check — *"Passwords don't match."*).
   - `org-settings.jsx`: admins trigger resets ("Reset password" button; *"No email is sent — they're prompted to set a new password at their next sign-in."*; pill *"password reset pending"*).
   - Real app: passwords are bcrypt/argon2 hashes in SQLite (Phase 2 auth). The profile surface is the natural home for a **self-serve "Change password" block** for `local account` users (current password + new + confirm, reusing `.field`/`.flabel` and the login flow's validation copy). Confirm placement with design — see Open questions Q2. It must be hidden for OAuth-only users ("Signs in via" ≠ local account).
9. **Empty/error states** (mock has none):
   - Loader failure → standard route error boundary.
   - Action failure → inline field error (reuse the login screen's error styling) + keep edited values; do not show the success toast.
   - GitHub OAuth callback failure → return to profile with the `cred-warn` state + an error toast.
   - RBAC matrix empty (mis-configured policy) → render the panel with just the `pol-note` footer.
   - Display name blank → `initialsOf` yields `"?"`; decide whether to reject empty names in the action (recommended: require non-empty, trim).
10. **A11y additions:** focus trap + focus restore on the dialog; `aria-pressed` (or radiogroup semantics) on mini-seg buttons; keep `role="switch"` toggles.
11. The email field hint *"local account · admins can edit"* implies email edits happen in org settings (admin surface), not here. Keep the input disabled.

---

## 8. Open questions

1. **Is `ProfileAppearance` in or out?** It is fully built (theme segment, reduce motion, timeline default) and its prefs are consumed elsewhere (`task.jsx` seeds the timeline filter from `tlDefault`; `data-motion` CSS exists; the shell menu cycles theme), but the `Profile` root never renders it — likely an accidental drop when the layout went 2-column. Recommendation: render it (left column under Notifications, or a third row); confirm with design.
2. **Where does self-serve password change live?** The build focus lists "password change" for this surface, but the mock only implements admin-reset → set-at-next-login. Confirm the profile gets a Change-password block for local-account users, and its exact copy/validation (proposed: reuse login-flow strings, min length raised to something sane rather than the prototype's 4).
3. **Nudge prefs (`nudge: { on, hours }`, `PROFILE_NUDGE_HOURS`)** — dead in the UI but present in defaults. Drop entirely, or keep in the schema for a future "remind me about waiting packets every N hours" feature?
4. **Email notification channel** — pref shape has per-category `email` booleans that the UI never surfaces, and the app has no mailer. Keep schema-only, or cut until email exists?
5. **"Joined Feb 18" / "Member of Viberr Core"** — when the user belongs to multiple projects, does the profile show the active project's membership (as mocked) or a list of all memberships? Mock is single-project.
6. **Deep link** — Home honors `#profile`; the workspace does not. Should the real app make the profile overlay deep-linkable from every authenticated route (recommended), and what is the canonical URL?
7. **GitHub disconnect confirmation** — disconnect currently fires immediately. Given the audit-attribution consequences, should it get a confirm dialog (`confirm-card` pattern used elsewhere)?
