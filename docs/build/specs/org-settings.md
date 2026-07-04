# Porting spec — Org settings (instance-level admin)

Source: `design/html-app/app/org-settings.jsx` (1016 lines), loaded only by `design/html-app/Viberr Home.html`.
Companion module: `design/html-app/app/kb-browser.jsx` (391 lines) — defines `StoreBrowser`, `FolderIco`, `countKbFiles`, `prettySize`; **org-settings is its only consumer**, and there is no separate spec for it, so it is fully specified here (§4.6, §5.7).
Shared helpers: `design/html-app/app/ui.jsx` (`Icon`, `Pill`, `Avatar`, `AgentGlyph`, `initialsOf`, `useToasts`/`ToastHost`).
Mock data: `ORG_DEFAULTS` at the top of org-settings.jsx itself (NOT data.js), persisted whole to localStorage key `viberr:org:v10`. From data.js only `window.VIBERR.stages` is consumed (agent-profile stage chips).
Stylesheets: `app/viberr.css` + `app/home.css` (both ported verbatim; §6 says which file owns which class — class names are the contract).

Target route: `/org/settings` (tabbed), per `docs/build/CONVENTIONS.md`. Suggested feature dir: `app/features/org-admin/`.

---

## 1. Purpose & entry points

Instance-level ("above boards") admin surface with three tabbed sections:

1. **GitHub connections** — PAT-backed owner connections that projects pick at creation; add / update token / set default / remove, with scope validation gating every save.
2. **Users & access** — whitelist-based instance accounts (GitHub / Google / Local IdPs), Google **domain allowlist**, role toggles (admin/member), edit user, local-account password reset, remove user/domain.
3. **Agent resources** — four panels: Knowledge bases, MCP servers, Skills, Global agent profiles; each with CRUD dialogs, plus a file-manager popup (`StoreBrowser`) for KB/skill folders in the file-native store.

### Mock entry & routing (to be replaced)

- In the mock this page renders **inside Viberr Home** (`home.jsx`): hash route `#settings` or `#settings/(connections|users|resources)` swaps `<OrgSettings/>` in place of `main.home-shell`; the Home header (search, bell, user menu) stays above it. Default tab: `connections`.
- Props from `HomeApp`: `{ tab, onTab, onBack, org, patchOrg, push }`.
  - `onTab(id)` → `location.hash = "settings/" + id`.
  - `onBack()` → `location.hash = ""` (back to project directory).
  - `org` = `loadOrg()` result (localStorage merge over `ORG_DEFAULTS`); `patchOrg(patch)` shallow-merges and `saveOrg`s the whole object; `push(text)` = toast.
- Deep links: Home's Settings panel has three `.org-tile` buttons calling `goSettings("connections"|"users"|"resources")` (see home.md §); Home's New-project modal links here when no connections exist ("Add one in **Viberr settings → GitHub connections** first").
- **Real app:** `/org/settings` route (loader + actions), tab in the URL — either `/org/settings/:tab?` or `?tab=`; back button navigates to `/`. Admin-only surface (see Open questions — the mock has **no RBAC guard**). The page keeps the Home header chrome in the mock; decide whether `/org/settings` reuses the home header layout or the app shell (mock reality: home header).

---

## 2. Component tree

All in `org-settings.jsx` unless noted.

- **`OrgSettings`** `{tab, onTab, onBack, org, patchOrg, push}` — page shell: `.set-head` (back button + title), `.set-layout` = `.set-nav` (3 tab buttons with counts) + `.set-content` (active panel).
- **`ConnectionsPanel`** `{org, patchOrg, push}` — GitHub connections list + add/update/remove/set-default.
- **`ConnectionModal`** `{initial, existing, onClose, onDone}` — add connection / replace token dialog with simulated scope validation.
- **`UsersPanel`** `{org, patchOrg, push}` — domain allowlist rows + user rows, role toggles, invite/edit/remove.
- **`IdpChip`** `{idp}` — small chip: GitHub icon / "G" mark / lock icon + label.
- **`InviteModal`** `{onClose, onInvite}` — "Allow access" dialog: IdP picker (GitHub/Google/Local), conditional fields, role segment.
- **`EditUserModal`** `{user, onClose, onSave, onReset}` — edit name/email/role; local-only password-reset block.
- **`ResourcesPanel`** `{org, patchOrg, push}` — 2×2 grid of the four resource panels + all resource modals/browsers/confirms.
- **`KBModal`** `{initial, onClose, onSave}` — knowledge base create/edit (name + re-index cadence).
- **`McpModal`** `{initial, onClose, onSave}` — MCP server create/edit (name, transport, target, credential ref).
- **`SkillModal`** `{initial, onClose, onSave}` — skill create/edit (name, summary, SKILL.md markdown body).
- **`AgentModal`** `{initial, org, onClose, onSave}` — global agent profile create/edit (name, backend, summary, eligible stages, loadable context pickers).
- **`MiniModal`** `{icon, title, sub, onClose, canSave, saveLabel, onSave, footHint, children, screen}` — shared dialog chrome used by every modal above (Escape/scrim close, header icon+title+sub, footer hint + Cancel/Save).
- **`ConfirmDelete`** `{what, detail, onCancel, onConfirm}` — shared destructive-confirm card (`role="alertdialog"`).
- **`EditIco`** — local pencil SVG (NOT in the shared `Icon` set — port alongside; same stroke style as `Icon`).
- **`slugify(s)`** — lowercase, non-alphanumerics → `-`, trim leading/trailing `-`. Used for connection ids, KB dirs, MCP/skill names.
- From `kb-browser.jsx`: **`StoreBrowser`** (file-manager popup, §4.6), **`FolderIco`** `{open}` (folder SVG, open/closed variants), **`countKbFiles(nodes)`** (recursive file count), **`prettySize(bytes)`** (`"512 B" / "4.2 KB" / "1.1 MB"`), plus internal `UploadIco`, `FolderUpIco`, `countKbDirs`, `mapAt`, `mergeNodes`, `buildFromPaths`, `entryToNode`, `flatten`.
- From `ui.jsx`: `Icon` (used names: `github, user, memory, cpu, bolt, agents, plus, x, check, lock, shield, alert, refresh, arrow, file, chevron, sparkle`), `Pill`, `Avatar`, `AgentGlyph`, `initialsOf`.

---

## 3. Data consumed

Everything lives in one `org` object. Mock persistence: whole object JSON in localStorage `viberr:org:v10`; `loadOrg()` = `{ ...ORG_DEFAULTS, ...saved }` (shallow — a saved key fully replaces the default array). **Real app:** split per entity as noted below; the loader for `/org/settings` returns all slices (they're small) or per-tab.

### 3.1 `org.connections` — GitHub owner connections

```js
{ id: "akin-ozer",        // slugify(owner) — uniqueness key
  owner: "akin-ozer",     // GitHub org or user
  method: "PAT",          // only value used
  repos: 7,               // count shown in sub line
  def: true,              // exactly one default
  expires: "Jul 21, 2026",// display string; "—" fallback when absent
  daysLeft: 18 }          // number; ≤30 shows warning pill; may be null
```

**Real source:** SQLite table (e.g. `github_connections`) with AES-256-GCM-encrypted PAT (per CONVENTIONS). `repos`, `expires`, `daysLeft`, and verified scopes come from GitHub API at validation time and on refresh — never trusted from the client. Scope set is fixed copy in the UI: `repo · workflow · pull_request:write`.

### 3.2 `org.users` — instance accounts

```js
{ id: "u-arda",
  name: "Arda Kaya",          // for github-whitelisted-but-never-signed-in: "@handle"
  email: "arda@viberr.dev",   // github placeholder: "github.com/handle"
  initials: "AK",             // via initialsOf(); Avatar fallback "?"
  tone: "",                   // avatar hue: "" | "rose" | "teal" | "violet" (new invitees hard-coded "teal")
  role: "admin",              // "admin" | "member"
  status: "active",           // "active" | "whitelisted" (idp user, not yet signed in) | "invited" (local, setup pending)
  you: true,                  // only on the signed-in user's row
  idp: "github",              // "github" | "google" | "local" (missing ⇒ treated as "local")
  pwreset: true }             // optional; local-only "password reset pending"
```

**Real source:** SQLite `users` table; `you` derived from the server session, never stored. `status` derives from auth state (has the account ever completed sign-in / setup). `pwreset` is a server-side flag consumed at next local login.

### 3.3 `org.domains` — Google domain allowlist

```js
{ id: "d-1", domain: "@viberr.dev", role: "member" }  // role granted to anyone joining via this domain
```

**Real source:** SQLite table (e.g. `google_domain_allowlist`); checked by the Google OAuth callback.

### 3.4 `org.kbs` — knowledge bases

```js
{ id: "kb-arch",
  name: "Architecture notes",
  dir: "architecture-notes",     // folder under store://kb/ ; slugify(name) fallback
  refresh: "on change",          // "manual" | "on change" | "nightly"
  last: "Jul 1",                 // last-indexed display ("just now" after mutation)
  tree: [ /* Node[] */ ] }
// Node = { type:"dir", name, children: Node[] }
//      | { type:"file", name, size:"4.2 KB", added:"Mar 30" }   // size & added are display strings
```

**Real source:** the **file-native store** is canonical for the tree — a real directory (e.g. `store/kb/<dir>/`); the tree is read from disk (or a projection of the last scan). Metadata (`refresh` cadence, `last` indexed timestamp) lives in DB/projection. Sizes/dates come from `fs.stat`, formatted server-side or client-side from bytes + ISO timestamps.

### 3.5 `org.mcps` — MCP servers

```js
{ id: "mcp-gh",
  name: "github-mcp",                       // slugified on save
  transport: "HTTP",                        // "HTTP" | "stdio"
  target: "https://mcp.internal:7801/sse",  // endpoint (HTTP) or command line (stdio)
  cred: "secret://mcp/github",              // optional secret *reference* — never the secret itself
  tools: 14,                                // discovered tool count
  up: true,                                 // health
  last: "30s ago" }                         // last check display; "retry queued" when down
```

**Real source:** DB config table; `tools`/`up`/`last` from server-side health checks (mock copy promises "health-checked every 60s" for HTTP, "spawned per run, sandboxed" for stdio). `cred` resolves via the secrets layer at runtime only.

### 3.6 `org.skills`

```js
{ id: "sk-2",
  name: "terraform-review",     // slug; also the folder name store://skills/<name>/
  summary: "Module review checklist: state safety, drift, plan hygiene.",
  upd: "Jun 12",                // last-updated display
  body: "## Review checklist\n- …",   // SKILL.md markdown content
  tree: [ { type:"file", name:"SKILL.md", size:"3.4 KB", added:"Jun 12" }, /* + supporting files/dirs */ ] }
```

**Real source:** file-native store folder `store/skills/<name>/`; `SKILL.md` is a real file the editor round-trips (`body` = its contents). Tree from disk.

### 3.7 `org.gagents` — global agent profiles

```js
{ id: "ga-1",
  name: "Developer",
  backend: "codex",             // "codex" | "claude" (display: "Codex" / "Claude Code")
  summary: "Primary implementation specialist — owns branch work and change summaries.",
  stages: ["ready", "impl"],    // stage ids; "done" is never offered
  skills: ["sk-1", "sk-3"],     // ids into org.skills
  mcps: ["mcp-gh"],             // ids into org.mcps
  kbs: ["kb-arch"],             // ids into org.kbs
  used: 4 }                     // count of projects whose policy references this profile
```

**Real source:** DB (or an org-level file — Open question §8.1). `used` must be a **projection query** counting project policies that grant this profile — it gates deletion and drives footer copy.

### 3.8 `window.VIBERR.stages` (data.js)

```js
[ { id:"triage", name:"Triage", color:"#a5a8b5" }, { id:"ready", name:"Ready", color:"#187574" },
  { id:"impl", name:"In Progress", color:"#7b61ff" }, { id:"review", name:"Review", color:"#5b76fe" },
  { id:"done", name:"Done", color:"#00b473" } ]
```

Consumed by `AgentModal` (stage chips, `done` filtered out) and the profile row's stage-name join. **Real source:** the canonical stage catalog (Open question §8.2 — stages are per-project in the real app; this org-level surface needs an instance-default stage list).

### 3.9 Derived values

- Tab counts: `connections.length`, `users.length`, `kbs.length + mcps.length + skills.length + gagents.length`.
- `usedBy(kind, id)` = number of `gagents` whose `skills`/`mcps`/`kbs` array includes `id` — shown as "· N profiles" on KB and skill rows.
- `countKbFiles(tree)` — recursive file count ("N docs" / "N files").

---

## 4. UI states & interactions

### 4.0 Page shell

```jsx
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
      {/* per tab: */}
      <button className={"nav-item" + (active ? " active" : "")}>
        <Icon name={t.icon} className="ico" />{t.label}<span className="count">{counts[t.id]}</span>
      </button>
    </nav>
    <div className="set-content">{/* active panel */}</div>
  </div>
</main>
```

Tabs (`SETTINGS_TABS`): `connections` "GitHub connections" (icon `github`), `users` "Users & access" (icon `user`), `resources` "Agent resources" (icon `memory`). Clicking a tab calls `onTab(id)` (URL change).

### 4.1 GitHub connections panel

`section.panel[data-screen-label="Settings — GitHub connections"]`

- Head: `Icon github` + `h2` "GitHub connections"; right-aligned `btn sm` **"Add connection"** (with `plus` icon) → opens `ConnectionModal` (new).
- Policy note (`.pol-note`, shield icon): **"N connection(s).** Every project picks one at creation — it sets the repository root. Each authenticates with a **PAT**, validated against the minimum scopes before anything is saved." (bold via `<strong>`; count pluralized.)
- Connection row — verbatim:

```jsx
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
```

- **Set default**: makes clicked connection the only `def:true`; toast **"Default connection updated — new projects start from it"**.
- **Remove**: if it's the default → toast **"Set another connection as default first"**, no dialog. Else `ConfirmDelete`: heading "Remove {owner}?", detail **"Projects already created from {owner} keep their repos; new projects can no longer select it."** Confirm → row removed, toast **"{owner} disconnected"**.
- **No empty state** in the mock when `connections` is empty (list just renders nothing) — Home's tile shows "none connected" and the New-project modal shows a def-note warning instead. Decide whether to add one (§7.5).

#### ConnectionModal (add / update token)

`MiniModal`, icon `github`. Two modes keyed by `initial`:

| | New | Update token |
|---|---|---|
| Title | "New GitHub connection" | "Update token — {owner}" |
| Sub | "A PAT authenticates every repo action for this owner" | "The current token is never shown — paste a replacement" |
| Owner field | editable, autoFocus | disabled |
| Token field | autoFocus? no | autoFocus |
| Save label | "Validate & connect" | "Validate & replace" |
| Save label (busy) | "Verifying scopes…" | "Verifying scopes…" |
| Foot hint | "nothing is saved unless validation passes" | "the old token stays active unless validation passes" |

Fields:
- **Organization or user*** — `.repo-input` with `.pre` prefix "github.com/", placeholder "owner".
- **Personal access token*** — mono input, placeholder "ghp_…"; label hint (`.fhint`): "stored encrypted · never displayed".
- **Required scopes** — read-only `.scope-chips`: `repo`, `workflow`, `pull_request:write`; `.def-note` (shield): "Verified when you apply. If any scope is missing the token is refused and nothing is saved."

Behavior:
- `canSave` = not busy AND (editing OR owner.trim().length > 1) AND token nonempty. Enter in either input submits.
- Duplicate guard (new only): `existing.some(c => c.id === slugify(owner))` → inline error `.cred-warn` **"That connection already exists."** (no server round-trip).
- Simulated validation: 900 ms delay, then token must match `/^ghp_/` else `.cred-warn`: **"Validation failed — token is missing pull_request:write. Minimum scopes: repo · workflow · pull_request:write. Nothing was saved."** Typing in either field clears the error.
- Success → `onDone(owner)`:
  - New: appends `{ id: slugify(owner), owner, method:"PAT", repos: 5, def: false, expires: "Jul 3, 2027", daysLeft: 365 }`; toast **"{owner} connected — scopes verified, expires Jul 3, 2027"**.
  - Update: patches only `expires`/`daysLeft` on the row; toast **"Token for {owner} replaced — scopes verified, expires Jul 3, 2027"**.
  - All of `repos: 5`, the expiry date, and the `ghp_` check are **prototype fakes** — real action calls GitHub, verifies the three scopes, counts accessible repos, reads token expiry (§7.2).

### 4.2 Users & access panel

`section.panel[data-screen-label="Settings — Users & access"]`

- Head: `Icon user` + "Users & access"; right `btn sm` **"Allow access"** (plus icon) → `InviteModal`.
- Policy note (shield): "**N instance accounts** — GitHub & Google access is whitelist-based: allowed people simply sign in, no invite emails. Board permissions are granted per project."
- **Domain allowlist rows** (only when `org.domains` non-empty; own `.member-list` with `style={{marginBottom:0}}`):

```jsx
<div className="member-row" key={d.id}>
  <span className="dom-ic"><span className="gmark">G</span></span>
  <span className="member-main">
    <div className="nm">{d.domain}</div>
    <div className="em">any Google account with this domain · joins as {d.role}</div>
  </span>
  <Pill kind="ready" sm>domain allowlist</Pill>
  <button className="stg-x" aria-label={"Remove " + d.domain} onClick={…}><Icon name="x" /></button>
</div>
```

- **User rows** (`.member-list`):

```jsx
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
  <button className={"stg-x" + (u.you ? " off" : "")} aria-label={"Remove " + u.name} onClick={…}><Icon name="x" /></button>
</div>
```

- `IdpChip`: `github` → `<span className="idp-chip"><Icon name="github"/>GitHub</span>`; `google` → `<span className="idp-chip"><span className="gmark">G</span>Google</span>`; else → `<span className="idp-chip"><Icon name="lock"/>Local</span>`.
- **Role toggle** (`setRole`): self-demote guard — if `u.you && role !== "admin"` → toast **"You can't demote yourself"**, no change. Else patch + toast **"{name} → {role}"** (e.g. "Murat Yıldız → member"). Server must enforce the same guard (§7.4).
- **Remove user**: the button gets class `off` on your own row but stays clickable — click shows toast **"You can't remove your own account"**. Others → `ConfirmDelete` "Remove {name}?" detail **"Their comments and decisions stay in the audit history. Task assignments return to the operator for reassignment."** Confirm → toast **"{name} removed"**.
- **Remove domain**: `ConfirmDelete` "Remove {domain}?" detail **"New Google sign-ins from this domain are refused. Accounts that already signed in keep their access."** Confirm → toast **"{domain} removed from the allowlist"**.

#### InviteModal ("Allow access")

`MiniModal`, icon `user`, title **"Allow access"**, sub **"Whitelist who can sign in — no invite emails, access on first login"**.

- **Sign-in method** — three-way `.be-pick.three` of `.be-opt` buttons (GitHub / Google / Local), each `aria-pressed`, with `.be-ic` (github icon / `.gmark.lg` "G" / lock icon), `.bnm` label, `.bcheck` check. Verbatim option:

```jsx
<button type="button" className={"be-opt" + (idp === "github" ? " on" : "")} onClick={() => setIdp("github")} aria-pressed={idp === "github"}>
  <span className="be-ic"><Icon name="github" /></span>
  <span className="bnm">GitHub</span>
  <span className="bcheck"><Icon name="check" /></span>
</button>
```

- Conditional fields (Enter submits in all of them):
  - **GitHub**: "GitHub username*" (fhint "name & avatar come from GitHub when they sign in") — `.repo-input` pre "github.com/", placeholder "username", autoFocus.
  - **Google**: "Google account or domain*" (fhint "@company.dev whitelists the whole org") — mono input, placeholder `name@company.dev · or · @company.dev`, autoFocus.
  - **Local**: two-column `.key-row` — "Full name*" (autoFocus) + "Email*" (mono, placeholder "name@company.dev").
- **Domain detection** (`isDomain`): idp is google AND (input starts with "@" OR contains "@" with an empty local part). Changes role label to **"Role for everyone joining via this domain"** (else "Instance role") and the save label/foot hint.
- **Role** — `.mini-seg` Admin / Member (default member).
- `canSave`: github → handle (leading "@" stripped) length > 1; google → contains "@" and the domain part contains "."; local → name length > 1 and email contains "@".
- Save label: local **"Create account"**; google-domain **"Whitelist domain"**; github **"Whitelist user"**; google-account **"Whitelist account"**.
- Foot hint: github "allowed the moment they sign in with GitHub"; google-domain "everyone {input} can sign in with Google"; google-account "allowed the moment they sign in with Google"; local "they set a password from the setup link".
- `onInvite(p)` behavior (in `UsersPanel.invite`):
  - **Google domain**: normalize to `"@" + domainpart` if user typed a full address; dedupe → toast **"{domain} is already whitelisted"** and modal stays open; else append `{ id: "d-"+Date.now().toString(36), domain, role }`, close, toast **"Anyone with {domain} can now sign in with Google — joins as {role}"**.
  - **GitHub user**: row `{ name: "@"+handle, email: "github.com/"+handle, initials: initialsOf(handle), tone: "teal", role, status: "whitelisted", idp: "github" }` — placeholder identity until first sign-in syncs real name/avatar. Toast **"@{handle} whitelisted — allowed at first GitHub sign-in"**.
  - **Google account**: `name = email local part`, status "whitelisted". Toast **"{email} whitelisted — allowed at first Google sign-in"**.
  - **Local**: status **"invited"** (renders "setup pending" pill). Toast **"Account created — setup link generated for {email}"**. Real app must actually mint a setup link/token (§7.4).

#### EditUserModal

`MiniModal`, icon `user`, title **"Edit {name}"**, sub: "Local account" (local) or "Signs in with GitHub"/"Signs in with Google".

- Two-column `.key-row`: Full name / Email — **disabled unless local** (required markers `*` only for local). Non-local shows a `.def-note` (lock, `style={{marginTop:"-.6rem"}}`): **"Name & email sync from {GitHub|Google} at each sign-in and can't be edited here."**
- **Instance role** `.mini-seg` Admin/Member (same self-demote guard on save: toast "You can't demote yourself", modal stays open).
- **Password** field (local only) — verbatim:

```jsx
{user.pwreset
  ? <div className="cred-ok"><Icon name="check" /><span>Reset pending — {user.name} will be prompted to set a new password at next sign-in.</span></div>
  : <div>
      <button className="btn ghost sm" onClick={() => onReset(user)}><Icon name="lock" />Reset password</button>
      <div className="def-note" style={{ marginTop: ".55rem" }}>
        <Icon name="lock" />
        <span>No email is sent — they're prompted to set a new password at their next sign-in.</span>
      </div>
    </div>}
```

- **Reset password** (`resetPw`) sets `pwreset: true` immediately (does not close the modal) + toast **"Password reset — {name} sets a new password at next sign-in"**. The panel re-renders the modal from the **live** user record (`users.find(x => x.id === editing.id)`) so the cred-ok state appears in the open dialog — keep this live-lookup pattern (or revalidate) in the port.
- `canSave`: non-local always; local needs name > 1 and email contains "@". Save label "Save changes". Foot hint **"this is your own account"** when `user.you`.
- Save toast: **"Profile updated"** (self) or **"{name} updated"**.

### 4.3 Agent resources — Knowledge bases panel

`div.rsrc-wrap[data-screen-label="Settings — Agent resources"] > div.rsrc-grid` (four `section.panel`s), followed by a grid-wide `.def-note` (shield): **"These are the shared base definitions. Each project's policy decides which profiles are eligible, which of their context resources may load, and what they may do — without changing the global."**

KB panel head: `memory` icon, "Knowledge bases", right `btn sm` "New" (plus) → `KBModal` (new). Row:

```jsx
<div className="rsrc-row" key={kb.id}>
  <span className="rsrc-main">
    <b><button className="linkish" onClick={() => setBrowsing({ kind: "kb", id: kb.id })}>{kb.name}</button></b>
    <span className="sub mono">store://kb/{kb.dir || slugify(kb.name)}/ · {countKbFiles(kb.tree || [])} docs</span>
    <span className="sub">re-index {kb.refresh} · indexed {kb.last}{usedBy("kbs", kb.id) > 0 ? " · " + usedBy("kbs", kb.id) + " profiles" : ""}</span>
  </span>
  <span className="rsrc-acts">
    <button className="stg-x" title="Browse files" aria-label={"Browse files in " + kb.name} onClick={…}><FolderIco /></button>
    <button className="stg-x" title="Re-index now" aria-label={"Re-index " + kb.name} onClick={() => reindex(kb)}>
      <Icon name="refresh" className={reindexing === kb.id ? "spin" : ""} />
    </button>
    <button className="stg-x" title="Edit" aria-label={"Edit " + kb.name} onClick={…}><EditIco /></button>
    <button className="stg-x" title="Delete" aria-label={"Delete " + kb.name} onClick={…}><Icon name="x" /></button>
  </span>
</div>
```

- **Re-index now**: refresh icon spins (`.spin`) for 1000 ms, then `last = "just now"` + toast **"{name} re-indexed — N docs"**. Real: server action; spin while pending.
- **Delete** → shared resource `ConfirmDelete` (detail strings in §4.5). Empty state: `<div className="empty">No knowledge bases yet.</div>`.
- **KBModal**: icon `memory`; title "New knowledge base" / "Edit knowledge base"; sub **"A folder in the store — drop docs in, or let agents append"**; foot hint live-updates: `store://kb/{slugify(name) || "name"}/`; save label **"Create & index"** / "Save changes".
  - **Name*** (fhint "names its folder in the knowledge-base store", placeholder "e.g. Architecture notes", autoFocus). `canSave` = name.trim().length > 1.
  - **Re-index** `.mini-seg` of `manual` / `on change` / `nightly` (lowercase labels).
  - `.def-note` (file icon): "Content is plain files inside the folder — inspectable and editable outside Viberr. Indexing just makes it retrievable for agents."
  - Save emits `{ name, dir: slugify(name), refresh }` — **note: editing recomputes `dir` from the new name**, i.e. a rename implies a folder rename/move in the real store (§7.3).
  - Create: `{ id: "kb-"+ts36, …data, tree: [], last: "just now" }`, toast **"{name} created — folder ready at store://kb/{dir}/"**. Edit toast: **"{name} updated"**.

### 4.4 MCP servers, Skills, Global agent profiles panels

**MCP servers** (head: `cpu`, "MCP servers", right "Add"):

```jsx
<div className="rsrc-row" key={m.id}>
  <span className={"stat-dot" + (m.up ? " up" : " down")} title={m.up ? "connected" : "unreachable"}></span>
  <span className="rsrc-main">
    <b className="mono-b">{m.name}</b>
    <span className="sub mono">{m.transport} · {m.target}</span>
    <span className="sub">{m.up ? m.tools + " tools · checked " + m.last : "unreachable · " + m.last}{m.cred ? " · auth: " + m.cred : ""}</span>
  </span>
  <span className="rsrc-acts">{/* Test connection (refresh/spin) · Edit · Remove — same stg-x pattern */}</span>
</div>
```

- **Test connection**: spin 900 ms → toast **"{name} healthy — {tools} tools · 41ms"** (up) or **"{name} unreachable — connection refused, retry queued"** (down). Mock never flips `up` on test; real action returns actual health and updates the row. Empty state "No MCP servers yet."
- **McpModal**: icon `cpu`; sub "Tools become loadable context for agent profiles"; save "Add & test connection" / "Save & re-test"; foot hint by transport: stdio → **"spawned per run, sandboxed"**, HTTP → **"health-checked every 60s"**.
  - `.key-row`: **Server name*** (mono, placeholder "e.g. github-mcp", autoFocus; slugified on save) + **Transport** mini-seg HTTP/stdio.
  - **Endpoint*/Command*** (label switches with transport; placeholders `https://mcp.internal:7801/sse` / `npx -y @mcp/server-postgres`).
  - **Credential** (fhint "optional · secret reference", placeholder "secret://mcp/…"); `.def-note` (lock): **"Referenced at runtime only. Secrets never appear in task timelines, comments, or audit records."**
  - `canSave` = slug(name).length > 1 && target.trim().length > 3.
  - Save (edit): forces `up: true, last: "just now"`, toast **"{name} saved — reconnected, {tools||8} tools"**; (new): `tools: 8, up: true`, toast **"{name} connected — 8 tools discovered"** — the `8` is fake; real action performs the connect/discover.

**Skills** (head: `bolt`, "Skills", right "New"): row has `mono-b` linkish name (opens StoreBrowser), `.sub` summary, `.sub.mono` `store://skills/{name}/ · N file(s) · updated {upd}[ · N profiles]`; acts Browse/Edit/Delete. Empty "No skills yet."
- **SkillModal**: icon `bolt`; sub "Reusable instructions an agent loads on demand"; foot hint `store://skills/{slug || "name"}/`; save "Create skill" / "Save changes".
  - **Skill name*** (mono, placeholder "e.g. terraform-review", autoFocus, slugified on save); **Summary*** (fhint "shown to the operator when choosing context", placeholder "What does this skill teach the agent?"); **SKILL.md** textarea (fhint "markdown"), `rows = body ? Math.min(18, lines+2) : 6`, placeholder `"## When reviewing a module\n- check state safety\n- flag drift between plan and apply\n- …"`.
  - `canSave` = slug(name).length > 1 && summary.trim().length > 3.
  - Save rebuilds the tree via `skillTree`: SKILL.md is pinned first with `size = prettySize(max(body.length, 400))`, `added: "just now"`, all other tree nodes preserved. Toasts: **"Skill {name} created — SKILL.md written"** / **"Skill {name} updated — SKILL.md rewritten"**. Real action writes the actual `SKILL.md` file.

**Global agent profiles** (head: `agents` icon, "Global agent profiles", right "New"):

```jsx
<div className="rsrc-row" key={a.id}>
  <AgentGlyph backend={a.backend} />
  <span className="rsrc-main">
    <b>{a.name}</b>
    <span className="sub">{a.summary}</span>
    <span className="sub mono">{a.backend === "claude" ? "Claude Code" : "Codex"} · {stageNames || "no stages"} · {res} context resources · {a.used > 0 ? "used in " + a.used + " project" + (a.used === 1 ? "" : "s") : "not deployed"}</span>
  </span>
  <span className="rsrc-acts">{/* Edit · Delete */}</span>
</div>
```

`stageNames` = stage ids mapped through `window.VIBERR.stages` names, joined " · "; `res` = skills+mcps+kbs count. **Delete guard**: `used > 0` → toast **"Detach {name} from its {N} projects first"**, no dialog. **No empty state** in the mock for this panel (add one for parity with the others — §7.5).

- **AgentModal**: icon `<AgentGlyph backend={backend}/>` (live-updates with selection); sub **"Global base definition — projects grant eligibility & capabilities"**; save "Create profile" / "Save changes"; foot hint: `initial.used > 0` → **"used in {N} projects — changes apply on next run"**, else **"not deployed yet"**.
  - **Profile name*** (placeholder "e.g. Security reviewer", autoFocus).
  - **Backend** — two-up `.be-pick` of `.be-opt` (Codex / Claude Code) with `AgentGlyph`, `.bnm`, `.bcheck`, `aria-pressed`.
  - **Role summary** (placeholder "One line the operator sees when assigning work").
  - **Default eligible stages*** (fhint **"Done is human-only, always"**) — `.pick-chips` of toggleable `.pick-chip` buttons, one per stage except `done`, each with a `.sdot` colored `style={{background: s.color}}`:

```jsx
<button key={s.id} className={"pick-chip" + (stages.includes(s.id) ? " on" : "")} onClick={() => toggle(stages, setStages, s.id)}>
  <span className="sdot" style={{ background: s.color }}></span>{s.name}
</button>
```

  - **Loadable context** (fhint "what this profile may pull into a run") — `.ctx-groups` of three `.ctx-group`s (labels `.ctx-lbl` "Skills" / "MCP servers" / "Knowledge bases"), each a `.pick-chips` of toggle chips over `org.skills` / `org.mcps` / `org.kbs` (skill & MCP chips get extra class `mono`; KB chips don't). Empty group renders `<span className="ctx-none">none defined</span>`.
  - `canSave` = name.trim().length > 1 && stages.length > 0.
  - Save toasts: **"{name} updated — running threads re-anchor on next turn"** / **"{name} created — grant it eligibility in a project's policy to deploy"** (new gets `used: 0`).

### 4.5 Shared dialog chrome

**MiniModal** (all create/edit dialogs) — verbatim skeleton:

```jsx
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
```

- Escape closes (window keydown listener registered on mount). Scrim click closes. **No focus trap** in the mock — add one in the port; also replace the inline-style "disabled" save button with a real `disabled` attribute + `aria-disabled` (visuals must stay: 0.55 opacity).
- Field primitives used inside: `.field` wrapper, `.flabel` label, `.req` required star, `.fhint` inline hint, `.key-row` (2-col grid, sometimes via `style={{gridTemplateColumns:"1fr 1fr"}}`), `.repo-input` (prefix + input), `.mini-seg` segmented buttons, `.cred-warn` inline error (alert icon), `.cred-ok` inline success (check icon), `.def-note` info note.

**ConfirmDelete** — verbatim:

```jsx
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
```

No Escape handler on ConfirmDelete in the mock (only scrim click / Cancel) — add Escape for consistency. Resource-delete detail strings (ResourcesPanel):
- kb: **"The index is removed from the store. Profiles referencing it simply stop loading it — nothing else breaks."** → toast **"{name} deleted — agents lose it on next context load"**.
- mcp: **"Profiles referencing this server lose its tools on their next run."** → toast **"{name} removed"**.
- skill: **"store://skills/{name}.md is deleted. Profiles referencing it stop loading it."** (mock copy says `.md` though skills are folders — see §8.6) → toast **"Skill {name} deleted"**.
- agent: **"The base definition is deleted. It isn't deployed anywhere."** → toast **"{name} deleted"**.

### 4.6 StoreBrowser (file-manager popup, from kb-browser.jsx)

Opened by clicking a KB/skill name or the folder button. Props wired by ResourcesPanel:

- KB: `title={kb.name}`, `root={"store://kb/" + dir}`, `subMono={"store://kb/" + dir + "/ · re-index " + kb.refresh}`, `metaTail={"indexed " + kb.last}`, `tree`, `push`, `onChange(tree)` → patches that KB's tree + `last: "just now"`, `onClose`.
- Skill: `root={"store://skills/" + sk.name}`, `subMono={…"/ · SKILL.md + supporting files"}`, `metaTail={"updated " + sk.upd}`, plus `captureText="SKILL.md"` and `onCaptureText(text)` → patches `{ body: text, upd: "just now" }` + toast **"SKILL.md content captured — fully editable in the skill editor"**. `onChange` bumps `upd: "just now"`.

Chrome: `.modal-card.modal-wide`, `role="dialog"`, `aria-label={"Files — " + title}`, header like MiniModal (icon `memory`, `.mh-sub.mono` = subMono), Escape + scrim close. Footer: `.foot-hint.mono` = `"{N} folder(s) · {N} file(s)[ · {metaTail}]"` + single primary **"Done"** button (closes).

Toolbar (`.fm-toolbar`): **"Upload files"** (multi `<input type="file">`), **"Upload folder"** (hidden input with `webkitdirectory`), **"Add from GitHub"** (toggles `.fm-gh` inline row: mono URL input placeholder `https://github.com/owner/repo/tree/main/docs`, Enter or **"Import"** button; while importing the button shows spinning refresh icon + "Importing…"), **"New folder"** (`btn ghost sm`), and `.fm-hint` copy **"drag files or folders onto a folder to upload there"**.

Tree (`.fm-tree`): directories sorted before files at each level; expansion tracked by path key (`"a/b"`); row markup:

```jsx
<div className={"fm-row " + (isDir ? "dir" : "file") + (isDropTarget ? " droptgt" : "")}
  style={{ paddingLeft: (0.6 + depth * 1.3) + "rem" }}
  onClick={isDir ? () => toggle(key) : undefined}
  onDragOver={…} onDrop={…}>
  <span className="twist">{isDir && <Icon name="chevron" className={open ? "r90" : ""} />}</span>
  {isDir ? <FolderIco open={open} /> : <Icon name="file" />}
  <span className="fm-name">{node.name}</span>
  {isDir ? <span className="fm-meta">{n + " file" + (n === 1 ? "" : "s")}</span>
         : <span className="fm-meta">{node.size}{node.added ? " · " + node.added : ""}</span>}
  <span className="fm-acts" onClick={(e) => e.stopPropagation()}>
    {isDir && <>
      <button className="fm-act" title="Upload here" aria-label={"Upload into " + node.name}>…</button>
      <button className="fm-act" title="New subfolder" aria-label={"New folder in " + node.name}>…</button>
    </>}
    <button className="fm-act del" title="Delete" aria-label={"Delete " + node.name}>…</button>
  </span>
</div>
```

Behaviors:
- **Uploads** merge into the target path (`mergeNodes`: same-name dirs merge recursively, same-name files replace); dotfiles/`.DS_Store` are skipped; target folders auto-expand. Toasts: **"N file(s) added to {root}/{path}/"**; folder upload: **"Folder “{names}” uploaded as-is — N file(s)"**.
- **Drag & drop**: HTML5 file drag onto the tree root or any dir row (`droptgt` highlight, root key `""`); uses `webkitGetAsEntry` to walk whole dropped folders, falls back to flat file list. Cleared on window `dragend`/`drop`.
- **New folder**: inline `.fm-row.dir` with `.fm-newinp` input (placeholder "folder name", aria-label "New folder name", auto-focused); Enter or blur commits, Escape cancels. Name may contain `/` to create nested folders in one go (backslashes sanitized to `-`); collides with an existing **file** name → toast **"A file named “{h}” already exists here"**; success toast **"Folder {path}/ ready"**; existing dirs are reused.
- **GitHub import** (prototype fake): URL parsed by `/github\.com\/([\w.-]+)\/([\w.-]+)(?:\/(?:tree|blob)\/[\w.-]+\/?(.*))?/`; bad input → `.cred-warn` **"Paste a GitHub link — a repo, or a folder like github.com/owner/repo/tree/main/docs."**; success: after 1100 ms a new dir named after the last path segment (or repo, `.git` stripped; name deduped with `-2`, `-3`…) is added at root containing 4 hard-coded files (README.md 3.1 KB, getting-started.md 6.4 KB, architecture.md 9.8 KB, api-reference.md 14.2 KB); toast **"4 files imported from {owner}/{repo}[/{path}] — snapshot, not a live sync"**. Real app: server-side fetch of the repo tree via a stored connection (§8.5).
- **Delete node**: per-row `x` opens a **nested** confirm (scrim z-index 70, card 71, over the wide modal): heading **"Delete “{name}”{ and its contents}?"**; body: dir with files → **"N file(s) inside will be removed from the store. Agents lose them on their next context load."**; empty dir → "The empty folder is removed from the store."; file → "The file is removed from the store. Agents lose it on their next context load." Buttons Cancel / **"Delete folder"|"Delete file"** (danger). Toasts: **"Folder “{name}” deleted"** / **"“{name}” deleted"**.
- **SKILL.md capture**: when `captureText` is set and a file with that exact name is uploaded/dropped **at root level**, its text is read (`File.text()`) and passed to `onCaptureText` — this is how the skill editor's body stays in sync with an uploaded SKILL.md.
- Empty tree (and no pending new-folder input): `.fm-empty` — **"Empty — drag files or folders here, upload, or import from GitHub."**
- Bottom `.def-note` (file icon): **"This is the real folder on disk — files added outside Viberr appear after the next re-scan. Deleting here deletes from the store."** — in the real app this must be literally true: every op is a filesystem mutation under the store root.

---

## 5. Events / mutations produced

The mock funnels everything through `patchOrg` (whole-slice array replacement into localStorage). Each becomes a real action (form POST to `/org/settings` route actions, or per-tab resource routes). Per CONVENTIONS every governed action here → **audit event** in SQLite `audit_events`; these are org-scoped, not task-scoped, so **no task.md timeline events** are written by this surface (typed timeline events belong to task-visible actions only — PAT/policy changes surface in timelines elsewhere when a task consumes them). Mutations must be idempotent-safe.

| # | Mock mutation | Real action | Audit event (suggested type) | Server-side rules |
|---|---|---|---|---|
| 1 | add connection | `connection.create` — verify PAT scopes (`repo`, `workflow`, `pull_request:write`) against GitHub **before** persisting; encrypt PAT; fetch repo count + expiry | `github.connection-added` | reject on missing scope with the §4.1 error copy; reject duplicate owner; never store unvalidated token |
| 2 | update token | `connection.replace-token` — same validation; only swap on success ("the old token stays active unless validation passes") | `github.token-replaced` | never return/echo the old or new token |
| 3 | set default connection | `connection.set-default` | `github.default-connection-changed` | exactly one default, transactionally |
| 4 | remove connection | `connection.delete` | `github.connection-removed` | refuse when `def` ("Set another connection as default first"); existing projects keep their repos |
| 5 | whitelist github/google user | `user.allow` (creates whitelisted user row) | `org.user-whitelisted` | placeholder identity until first sign-in; dedupe |
| 6 | whitelist google domain | `domain.allow` | `org.domain-whitelisted` | normalize to `@domain`; dedupe (mock toast "already whitelisted") |
| 7 | create local account | `user.create-local` + mint setup token/link | `org.user-created` | status "invited" until setup completes; no email sent — link surfaced to admin |
| 8 | change user role | `user.set-role` | `org.user-role-changed` | server-enforced self-demote guard; RBAC: admin only |
| 9 | edit user (name/email) | `user.update` | `org.user-updated` | local accounts only; idp accounts sync from provider |
| 10 | reset local password | `user.password-reset` | `org.user-password-reset` | sets flag consumed at next local login; no email |
| 11 | remove user | `user.delete` | `org.user-removed` | keep authored comments/decisions in audit history; return their task assignments to the operator (copy promise — see §8.7) |
| 12 | remove domain | `domain.delete` | `org.domain-removed` | existing accounts keep access |
| 13 | create/edit KB | `kb.create` / `kb.update` — create/rename dir under `store/kb/`, persist refresh cadence | `org.kb-created/updated` | rename ⇒ dir move (§7.3) |
| 14 | delete KB | `kb.delete` — remove index (dir? see §8.6) | `org.kb-deleted` | profiles referencing it just stop loading it |
| 15 | re-index KB | `kb.reindex` | `org.kb-reindexed` (or log-only) | returns doc count for the toast |
| 16 | KB/skill file ops (upload / folder upload / mkdir / delete / GH import) | store file actions — real fs writes under the store root | `org.store-files-changed` (batched) | path-traversal protection; dotfile skip; merge semantics of §4.6 |
| 17 | create/edit MCP | `mcp.create` / `mcp.update` — then connect & discover tools | `org.mcp-added/updated` | `cred` stored as secret reference only; never in logs/SSE/errors |
| 18 | delete MCP | `mcp.delete` | `org.mcp-removed` | — |
| 19 | test MCP | `mcp.test` (read-only; updates health) | none (diagnostic) | returns latency/tool count or failure reason |
| 20 | create/edit skill | `skill.create` / `skill.update` — write `store/skills/<name>/SKILL.md` | `org.skill-created/updated` | SKILL.md pinned first in tree; body ↔ file round-trip |
| 21 | delete skill | `skill.delete` | `org.skill-deleted` | — |
| 22 | create/edit agent profile | `agent-profile.create` / `agent-profile.update` | `org.agent-profile-created/updated` | referenced stage/skill/mcp/kb ids must exist |
| 23 | delete agent profile | `agent-profile.delete` | `org.agent-profile-deleted` | refuse when `used > 0` (projection over project policies) with the "Detach…" copy |

Post-action: revalidate loader data (no optimistic UI for governed state) and show the exact toast strings from §4. Whether org mutations also publish SSE is an open question (§8.4).

---

## 6. CSS classes used (structural contract)

Ported verbatim; `(h)` = defined in `home.css`, `(v)` = `viberr.css`, `(hv)` = both.

- Shell: `home-shell` (h) · `set-head` (h) · `set-layout` (h) · `set-nav` (h) · `nav-item` + `.active` (h) · `count` (h) · `set-content` (h) · `panel`, `panel-head`, `right` (v) · `sub`, `mono`, `ico` (v).
- Notes & pills: `pol-note` (v) · `def-note` (v) · `cred-warn`, `cred-ok` (v) · `pill` kinds used here: `input`, `info`, `neutral`, `ready` + `sm` (v) · `empty` (v).
- Connections: `conn-list`, `conn-row`, `conn-ico`, `conn-main` (h) · `pre` (h, inside `conn-main b`) · `scope-chips`, `scope-chip` (hv).
- Users: `member-list`, `member-row`, `member-main`, `nm`, `em` (v) · `you-tag` (v) · `idp-chip` (h) · `gmark` + `.lg` (h) · `dom-ic` (h) · `mini-seg` + `.on` (v) · `avatar` + tones (v) · `stg-x` + `.off` (hv).
- Resources: `rsrc-wrap`, `rsrc-grid`, `rsrc-list`, `rsrc-row`, `rsrc-main`, `rsrc-acts` (h) · `linkish` (h) · `mono-b` (h) · `stat-dot` + `.up`/`.down` (h) · `agent-glyph` + `.codex`/`.claude` (v).
- Dialog chrome: `confirm-scrim`, `confirm-card`, `confirm-icon`, `confirm-actions` (v) · `modal-card` + `.modal-wide`, `modal-head`, `mh-main`, `mh-sub`, `modal-body`, `modal-foot`, `foot-hint`, `foot-actions`, `modal-close`, `icon-btn` (v) · `btn` + `sm`/`ghost`/`primary`/`danger` (v).
- Form primitives: `field`, `flabel`, `req`, `fhint` (v) · `key-row` (h) · `repo-input` + `pre` (h) · `be-pick` + `.three`, `be-opt` + `.on`, `be-ic`, `bnm`, `bcheck` (h) · `pick-chips`, `pick-chip` + `.on`/`.mono` (hv) · `sdot` (h) · `ctx-groups`, `ctx-group`, `ctx-lbl`, `ctx-none` (h).
- StoreBrowser: `fm-toolbar`, `fm-hint`, `fm-gh`, `fm-tree` + `.droptgt`, `fm-row` + `.dir`/`.file`/`.droptgt`, `twist`, `fm-name`, `fm-meta`, `fm-acts`, `fm-act` + `.del`, `fm-newinp`, `fm-empty` (h).
- Icon modifiers: `spin` (rotation animation), `r90`, `r180` (rotations) (v).
- Toasts: `toast-wrap`, `toast` (v) via shared `ToastHost`.

Since `/org/settings` renders standalone in the real app (not inside home.jsx), make sure the **home.css rules this page needs are available on this route** — either load home.css here too or move the `(h)` classes above into the appended sections of `app.css`.

---

## 7. Porting notes

### 7.1 Prototype-only bits → replacements

| Mock | Replace with |
|---|---|
| `localStorage["viberr:org:v10"]` + `loadOrg/saveOrg/patchOrg` whole-object writes | Loader data + per-entity actions (§5); SQLite for connections/users/domains/mcps/agent-profiles; file store for kb/skill content |
| `setTimeout` fakes: 900 ms PAT check, 900 ms MCP test, 1000 ms re-index, 1100 ms GH import | Real server work; drive spinners/labels ("Verifying scopes…", `.spin`, "Importing…") from navigation/fetcher pending state |
| Hard-coded results: `repos: 5`, `tools: 8`, `expires "Jul 3, 2027"`, `daysLeft: 365`, `41ms`, 4-file GH import | Real values from GitHub / MCP handshake / fs scan |
| `/^ghp_/` token check | Real GitHub scope verification (note: fine-grained PATs start `github_pat_` — do not replicate the prefix check as validation) |
| Display-string dates ("Jul 1", "just now", "30s ago") | ISO timestamps from server, formatted client-side; "just now" via relative formatting |
| `window.VIBERR.stages` | Stage catalog from loader (§8.2) |
| `initials`/`tone` stored on the user | Derive initials via shared `initialsOf`; tone assignment policy TBD (mock hard-codes "teal" for new invitees) |
| id minting `"u-"+Date.now().toString(36)` etc. | Server-generated ids |
| Inline-style disabled save button (`opacity:.55; pointerEvents:none`) | Real `disabled` attribute (+ keep visuals via CSS) |

### 7.2 Connection validation contract

The whole modal is designed around "**nothing is saved unless validation passes**". The real action must: validate scopes first, return a structured error rendered as `.cred-warn` (exact copy §4.1 for missing scopes; "That connection already exists." for duplicates), and only on success write the encrypted PAT + metadata. On token replace, the old token must remain active on failure. The token value must never appear in loader data, logs, or errors.

### 7.3 KB rename semantics

`KBModal` recomputes `dir = slugify(name)` on every save, including edits. A rename therefore implies moving `store/kb/<old>/` → `store/kb/<new>/` (or: keep `dir` immutable on edit and only change the display name — deviation to document). Collision with an existing dir must be rejected. Same consideration for skill rename (`store/skills/<name>/`).

### 7.4 Server-enforced guards (mock enforces client-side only)

- You can't demote yourself; you can't remove your own account.
- Default connection can't be removed.
- Agent profile with `used > 0` can't be deleted.
- Domain/owner dedupe.
- Local-account create requires name+email; whitelists require plausible handle/address.
- Whole surface: admin-only (RBAC per CONVENTIONS) — the mock renders for everyone.

### 7.5 Empty & error states

- Present in mock: "No knowledge bases yet." / "No MCP servers yet." / "No skills yet." / StoreBrowser `.fm-empty`.
- Missing in mock (decide): empty connections list (Home shows "none connected"); empty agent-profiles panel; empty users list (can't happen — you exist).
- Inline errors use `.cred-warn` inside modals; there is no field-level error styling — keep that pattern.
- Action failures (network, GitHub down, MCP unreachable) have no mock treatment beyond the "unreachable" toast — surface as toast + `.cred-warn` in the open dialog.

### 7.6 Accessibility inventory to preserve

- `role="dialog"`/`aria-modal` + `aria-label` on every modal; `role="alertdialog"` on confirms; `aria-label="Close"` on X buttons.
- `aria-pressed` on `.be-opt` pickers; `aria-label`s on every icon-only `stg-x`/`fm-act` button (exact strings in §4 snippets); `title` tooltips on resource actions and `stat-dot`.
- Escape closes MiniModal and StoreBrowser (add to ConfirmDelete); scrim click closes everywhere.
- Add (mock lacks): focus trap + focus restore, real `disabled` on save, `aria-current` or similar on the active `.nav-item`.
- `mini-seg` role toggles are plain buttons with `.on` — keep markup, consider `aria-pressed`.

### 7.7 Misc behaviors easy to miss

- `EditUserModal` is re-rendered from the **live** user record so "Reset password" flips to the `cred-ok` "Reset pending" state without closing the dialog.
- `ConnectionModal` gets `key={item.id | "new"}` and `EditUserModal` `key={live.id}` — state resets per subject.
- Panel copy pluralizations: "connection(s)", "file(s)", "project(s)", "N docs" — match exactly.
- The resources def-note and each modal's `sub`/`footHint` strings are product copy, not filler — port verbatim (they encode the governance model).
- `AgentGlyph` in the AgentModal header switches live as the backend selection changes.
- `IdpChip` treats a missing `idp` as "local".
- StoreBrowser dirs-before-files ordering and initial expansion = all **top-level** dirs expanded.

---

## 8. Open questions

1. **Where do global agent profiles live?** DB table (`agent_profiles`) vs. an org-level file in the file-native store. `used` must be computable from project policies either way. Data.js frames them as "global base with per-project overrides" — the override mechanism is a project-policy concern, not this page's.
2. **Stage catalog at org level.** Stages are per-project in the real app; the AgentModal needs an instance-level stage list for "Default eligible stages". Instance-default workflow? Union of project stages? Needs an architecture decision; mock uses the single hard-coded 5-stage list.
3. **Tab routing shape**: `/org/settings/:tab?` (path, matches mock `#settings/users`) vs `?tab=`. Path segments recommended; default `connections`.
4. **SSE for org data**: do org mutations publish events (e.g. `projection.rebuilt`-style) so other sessions' settings pages update live, or is post-action revalidation enough for this admin surface?
5. **GitHub import in StoreBrowser**: real implementation needs server-side repo-tree fetch — via which connection/PAT (the default? a picker?), and the "snapshot, not a live sync" semantics confirmed.
6. **Skill delete copy bug**: confirm dialog says `store://skills/{name}.md is deleted` but skills are folders (`store://skills/{name}/` with SKILL.md inside). Fix copy to the folder form or keep verbatim? (Recommend fixing to `store://skills/{name}/`.)
7. **User removal cascade**: the dialog promises "Task assignments return to the operator for reassignment" — define the actual mechanism (ownership release events on their tasks? which "operator"?) and whether it emits per-task timeline events.
8. **Local account setup link**: "setup link generated for {email}" — where does the admin see/copy the link? Mock never shows it. Needs a UI decision (e.g. show the link in a follow-up dialog or on the pending row).
9. **KB "re-index" semantics**: what indexing actually exists in the real app (phase 3 store scan vs. a retrieval index)? The button must do something honest — possibly just re-scan the folder and refresh counts.
10. **MCP health checking**: is the promised "health-checked every 60s" loop in scope, or is health only refreshed on test/save? Affects whether `stat-dot` state can go stale.
11. **Header chrome**: does `/org/settings` render under the Home header (mock reality: search/bell/user menu stay visible) or a plain page header? The `.set-head` back button assumes Home is one navigation away.
