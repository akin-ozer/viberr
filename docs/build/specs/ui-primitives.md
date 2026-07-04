# Spec: UI primitives (`app/ui/*`)

Source of truth: `design/html-app/app/ui.jsx` (223 lines, read in full).
Related: `design/html-app/app/data.js` (identity shapes, `window.VIBERR` global), `design/html-app/app/viberr.css` (class contract), the three HTML entry pages (script order + FOUC guard).

This file is the shared-primitives layer of the mock. Every other mock screen consumes it via `window` globals. In the real app these become ES modules under `app/ui/` (per CONVENTIONS.md: `app/ui/` MUST NOT import from `app/features/`).

---

## 1. Purpose & entry points

`ui.jsx` does four things:

1. Defines **shared presentational primitives**: `Icon`, `Pill`, `ReadinessPill`, `ValidationPill`, `AgentGlyph`, `Avatar`, `Identity`, `PageOverlay`, `TglP` (toggle switch), `useToasts` + `ToastHost`, and the helper `initialsOf`.
2. Defines the **state-vocabulary maps** `READINESS` and `VALIDATION` (value → pill kind + user-visible label).
3. Runs an IIFE `initPrefs()` that owns **personal device preferences** (theme, motion, timeline default, notification routing, nudge, fake GitHub-connected flag), persisted to `localStorage["viberr:prefs"]`, and applies theme/motion to `<html>` via `data-theme` / `data-motion` datasets.
4. Exports everything onto `window` (prototype-only mechanism):

```js
Object.assign(window, {
  Icon, Pill, ReadinessPill, ValidationPill, READINESS, VALIDATION,
  AgentGlyph, Avatar, Identity, useToasts, ToastHost, initialsOf, TglP, PageOverlay,
});
```

Load order in the mock HTML pages: inline FOUC-guard script in `<head>` → React/Babel CDN → `app/data.js` (creates `window.VIBERR`) → `app/ui.jsx` (attaches `VIBERR.prefs`/`VIBERR.savePrefs`) → all screen scripts → `main.jsx`. `ui.jsx` therefore assumes `window.VIBERR` already exists.

**Target module layout** (suggested, matches CONVENTIONS layout):

| Mock export | Real module |
|---|---|
| `Icon`, `ICON_PATHS` | `app/ui/icon.tsx` |
| `Pill`, `ReadinessPill`, `ValidationPill`, `READINESS`, `VALIDATION` | `app/ui/pill.tsx` |
| `AgentGlyph`, `Avatar`, `Identity` | `app/ui/identity.tsx` (or split `avatar.tsx` / `agent-glyph.tsx`) |
| `PageOverlay` | `app/ui/page-overlay.tsx` |
| `TglP` | `app/ui/toggle.tsx` |
| `useToasts`, `ToastHost` | `app/ui/toast.tsx` |
| `initialsOf` | `app/shared/initials.ts` (pure, used server & client) |
| `initPrefs` IIFE | **replaced** — see §6/§7 (profile feature + theme cookie in `root.tsx`) |

---

## 2. Component tree

- **`Icon({ name, className })`** — 24×24 stroke SVG from a static path map; falls back to the `dot` icon for unknown names.
- **`Pill({ kind, children, dot, sm })`** — colored status chip; optional leading dot; optional small size.
- **`ReadinessPill({ value, sm })`** — `Pill` wrapper mapping readiness value → kind + fixed label; always renders the dot.
- **`ValidationPill({ value, sm })`** — `Pill` wrapper mapping validation state → kind + fixed label; never renders the dot.
- **`AgentGlyph({ backend, lg })`** — square "machine" chip (clip-path cut corners) identifying an agent backend (claude/codex); has a CSS-only third variant `.op` used raw by consumers.
- **`Avatar({ person, lg })`** — round human initials chip with optional color tone.
- **`Identity({ who, lg, sub })`** — polymorphic inline identity renderer (agent / system / human) producing a `.who-chip`. **Exported but never consumed by any other mock file** (see §7).
- **`PageOverlay({ label, onClose, children })`** — full-page-as-popup modal (scrim + centered panel + close X + Escape handling). Used to show Profile and Notifications over the current screen.
- **`TglP({ on, onChange, label })`** — accessible toggle switch (`role="switch"`).
- **`useToasts()` / `ToastHost({ toasts })`** — transient bottom-center toast stack, auto-dismiss 2.6 s.
- **`initialsOf(name)`** — pure helper: name → up-to-2-letter uppercase initials, `"?"` fallback.
- **`initPrefs()`** (IIFE, not a component) — device preferences store + theme/motion applier.

---

## 3. Data consumed (exact shapes + real-app source)

### 3.1 Identity shapes (from `data.js`)

`data.js` builds people/agents with these shorthand factories (verbatim, data.js:13–15):

```js
const codex  = (role) => ({ kind: "agent", backend: "codex",  name: "Codex",       role });
const claude = (role) => ({ kind: "agent", backend: "claude", name: "Claude Code", role });
const human  = (name, initials, tone) => ({ kind: "human", name, initials, tone });
```

Sample people (data.js:17–21): `human("Arda Kaya","AK","")`, `human("Elif Demir","ED","rose")`, `human("Murat Yıldız","MY","teal")`, `human("Selin Aksoy","SA","violet")`. Tones observed: `""` (default blue), `"rose"`, `"teal"`, `"violet"` — exactly the tone classes that exist in CSS.

System actors appear in timeline/notification data as `{ name: "Policy engine", kind: "system" }`; the Operator appears as `{ kind: "agent", name: "Operator" }` (no backend — see §7 edge cases).

**Consumed fields per component:**

| Component | Fields read | Real-app source |
|---|---|---|
| `Avatar` | `person.initials`, `person.tone` | `users` table row (name → `initialsOf(name)` at render; tone: see Open questions). Session user for "me" contexts. |
| `AgentGlyph` | `backend` string (`"claude"` \| anything-else-means-codex) | agent profile / run row (`backend` column) from projections |
| `Identity` | `who.kind` (`"agent"`\|`"system"`\|else=human), `who.backend`, `who.name`, `who.role`, plus Avatar fields for humans | timeline event actor (typed events in task.md → projection), run participants |
| `ReadinessPill` | readiness value string | task projection `readiness` — **note mapping**, §3.3 |
| `ValidationPill` | validation value string | task projection validation status |

### 3.2 Preferences shape (owned by this file in the mock)

Defaults (verbatim, ui.jsx:187–197):

```js
const DEF = {
  theme: "system", motion: "full", tlDefault: "all", ghConnected: true,
  notifs: {
    packets:   { app: true, email: true },
    approvals: { app: true, email: false },
    mentions:  { app: true, email: true },
    policy:    { app: true, email: true },
    quality:   { app: true, email: false },
  },
  nudge: { on: true, hours: 2 },
};
```

Field semantics (from consumers in `profile.jsx`, `main.jsx`, `home.jsx`, `task.jsx`):

- `theme`: `"light" | "dark" | "system"`. Read/written by the theme segment in the user menu (main.jsx:149, home.jsx:319) and Profile → Appearance.
- `motion`: `"full" | "reduce"` → `<html data-motion="reduce|full">`; CSS uses it to pause pulses/animation.
- `tlDefault`: `"all" | "typed" | "comment"` — default filter of the task timeline (task.jsx:326). UI labels: All / Important / Comments.
- `ghConnected`: boolean — **prototype fake** for the GitHub connection state, flipped in Profile → Connections (profile.jsx:161). Real app: derive from PAT presence in SQLite; NOT a preference.
- `notifs`: routing matrix; category ids `packets | approvals | mentions | policy | quality`, channels `app` and `email`. Category display copy lives in `profile.jsx` (`PROFILE_NTF`): "Decision packets for you", "Approval requests", "Mentions & replies", "Policy events", "Quality flags". Note: the profile UI currently renders **only the `app` channel toggle**; `email` booleans exist in the pref object but have no UI.
- `nudge`: `{ on: boolean, hours: 1|2|4|8|24 }` — "nudge me about packets waiting on me after N hours" (hours options `PROFILE_NUDGE_HOURS = [1,2,4,8,24]` in profile.jsx).

Persistence: `localStorage["viberr:prefs"]`, merged over defaults with a **one-level deep merge for `notifs` and `nudge` only** (everything else shallow).

**Real-app source:** per-user preferences in SQLite (e.g. `users.prefs` JSON column or a `user_preferences` table), loaded by the root/profile loaders. Theme additionally mirrored to a **cookie** for SSR-safe first paint (CONVENTIONS: "Theme: light/dark/system, persisted per user (profile) + cookie for SSR-safe first paint"). `ghConnected` dropped (derived). `tlDefault` read by the task-detail loader/client. `motion` applied same as theme.

### 3.3 Readiness/validation vocabulary mapping (IMPORTANT)

Mock `READINESS` map (verbatim, ui.jsx:63–69):

```js
const READINESS = {
  ready:   { kind: "ready",   label: "ready" },
  input:   { kind: "input",   label: "input required" },
  risk:    { kind: "risk",    label: "inconsistency risk" },
  blocked: { kind: "blocked", label: "blocked" },
  done:    { kind: "done",    label: "accepted" },
};
```

Unknown value falls back to `ready`.

The real readiness enum (CONVENTIONS) is `ready | input_required | inconsistency_risk_detected | blocked` — the mock uses short keys. The port must map:

| Real readiness value | Mock key / pill kind | Label shown |
|---|---|---|
| `ready` | `ready` | `ready` |
| `input_required` | `input` | `input required` |
| `inconsistency_risk_detected` | `risk` | `inconsistency risk` |
| `blocked` | `blocked` | `blocked` |
| (accepted/done — not a readiness value) | `done` | `accepted` |

`done`/"accepted" is NOT part of the readiness enum; in the mock it is set on tasks in the Done stage. The `ReadinessPill` port should accept the real enum plus an `accepted` presentation state, with the CSS class names staying exactly `ready/input/risk/blocked/done` (class names are the contract).

Mock `VALIDATION` map (verbatim, ui.jsx:75–80):

```js
const VALIDATION = {
  healthy: { kind: "ready",   label: "validation healthy" },
  changed: { kind: "input",   label: "evidence changed" },
  failing: { kind: "blocked", label: "validation failing" },
  none:    { kind: "neutral", label: "no validation" },
};
```

Unknown value falls back to `none`. Values `healthy | changed | failing | none` come from the task's validation/evidence status in the projection.

### 3.4 Session (context only)

`ui.jsx` itself doesn't read the session, but its consumers combine it with these primitives: `main.jsx` renders `me` (from `window.VIBERR.session.get()`, localStorage key `"viberr:session"`) as `<Avatar person={{ ...window.VIBERR.people.ARDA, initials: initialsOf(me.name) }} lg />`. Real app: session user from the root loader (SQLite `sessions`/`users`), never localStorage.

---

## 4. Component contracts (props, markup, behavior)

### 4.1 `Icon`

Props: `name: string` (key of `ICON_PATHS`), `className?: string`.

Rendered markup (verbatim, ui.jsx:44–51):

```jsx
function Icon({ name, className }) {
  const inner = ICON_PATHS[name] || ICON_PATHS.dot;
  return (
    <svg className={"ico " + (className || "")} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"
      dangerouslySetInnerHTML={{ __html: inner }} aria-hidden="true" />
  );
}
```

Contract points:
- Class is always `ico` (plus optional extra). Sizing is done entirely by contextual CSS (`svg.ico { width:16px; height:16px; flex:none; }` base, overridden per context: `.nav-item .ico` 17px, `.agent-glyph .ico` 14px, `.toast .ico` 16px, `.btn .ico` 15px, `.icon-btn .ico` 17px, `.trace .ico` 12px, etc. — never size icons inline).
- Stroke icons only: `fill="none" stroke="currentColor" strokeWidth="1.7"` round caps/joins. Color inherits from text color.
- `aria-hidden="true"` always — icons are decorative; accompany with text or `aria-label` on the parent.
- Unknown `name` silently renders the `dot` icon (a filled-looking circle path). Keep this fallback; optionally warn in dev.

**Complete `ICON_PATHS` map (verbatim — the port must reproduce these paths exactly; 41 names):**

```js
const ICON_PATHS = {
  board: '<rect x="3" y="3" width="7" height="18" rx="1.5"/><rect x="14" y="3" width="7" height="11" rx="1.5"/>',
  review: '<path d="M4 5h16M4 12h16M4 19h10"/>',
  inbox: '<path d="M3 12h5l2 3h4l2-3h5"/><path d="M5 6h14l2 6v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6z"/>',
  shield: '<path d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/>',
  agents: '<rect x="5" y="8" width="14" height="11" rx="2"/><path d="M12 8V4M9 4h6M9 13h.01M15 13h.01M9 16h6"/>',
  github: '<path d="M9 19c-4 1.5-4-2.5-6-3m12 5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.3 4.3 0 0 0-.1-3.2s-1-.3-3.4 1.3a11.5 11.5 0 0 0-6 0C6.3 3.3 5.3 3.6 5.3 3.6a4.3 4.3 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 10c0 4.6 2.7 5.7 5.5 6-.4.4-.5.9-.5 1.8V21"/>',
  activity: '<path d="M3 12h4l3 8 4-16 3 8h4"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4"/>',
  filter: '<path d="M3 5h18l-7 8v6l-4-2v-4z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  branch: '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="7" r="2.5"/><path d="M6 8.5v7M18 9.5c0 4-6 2.5-6 6.5"/>',
  pr: '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M6 8.5v7M18 15.5V11a3 3 0 0 0-3-3h-3l2.5-2.5M11.5 8 14 10.5"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  alert: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17h.01"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 20c1.5-4 4.5-6 8-6s6.5 2 8 6"/>',
  cpu: '<rect x="7" y="7" width="10" height="10" rx="1.5"/><path d="M9 1.5v3M15 1.5v3M9 19.5v3M15 19.5v3M1.5 9h3M1.5 15h3M19.5 9h3M19.5 15h3"/>',
  message: '<path d="M21 12a8 8 0 0 1-11.5 7.2L4 20l1-4.8A8 8 0 1 1 21 12z"/>',
  sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4M21 4v5h-5"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  bolt: '<path d="M13 3L5 13h6l-1 8 8-10h-6z"/>',
  memory: '<rect x="4" y="6" width="16" height="12" rx="2"/><path d="M8 6V3M12 6V3M16 6V3M8 18v3M12 18v3M16 18v3"/>',
  dot: '<circle cx="12" cy="12" r="4"/>',
  send: '<path d="M4 12l16-8-6 16-3-6z"/>',
  hand: '<path d="M7 11V6a1.5 1.5 0 0 1 3 0v4M10 10V4.5a1.5 1.5 0 0 1 3 0V10M13 10V6a1.5 1.5 0 0 1 3 0v6c0 4-2.5 7-6 7s-6-2.5-6-6v-1l1.5-1.5"/>',
  flag: '<path d="M5 21V4M5 4h10l-1.5 3L15 10H5"/>',
  bell: '<path d="M18 9a6 6 0 1 0-12 0c0 6-2 7.5-2 7.5h16S18 15 18 9"/><path d="M10.3 20a2 2 0 0 0 3.4 0"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  sliders: '<path d="M4 6h8M16 6h4M4 12h2M10 12h10M4 18h10M18 18h2"/><circle cx="14" cy="6" r="2"/><circle cx="8" cy="12" r="2"/><circle cx="16" cy="18" r="2"/>',
  grip: '<circle cx="9" cy="5.5" r="1"/><circle cx="15" cy="5.5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18.5" r="1"/><circle cx="15" cy="18.5" r="1"/>',
  ext: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  term: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M7 9.5l3 3-3 3M13 15.5h4"/>',
};
```

Semantic usage across the app (so the port keeps names, not appearance-guesses): `board/review/inbox/shield/agents/github/activity` = nav rail sections; `shield` also = Operator/system/policy identity; `sparkle` = Claude backend (+ Appearance panel); `cpu` = Codex backend; `branch`/`pr` = git branch / pull request; `check` = success/toast/capability-allowed; `alert` = warnings/violations; `clock` = waiting/time; `lock` = restricted/forbidden; `x` = close/remove; `bolt` = actions/runs; `memory` = context/memory resources; `send` = composer submit; `hand` = human gate/approval; `flag` = quality flags; `bell` = notifications; `chevron` = disclosure/breadcrumb; `sliders` = tweaks panel; `grip` = drag handle; `ext` = external link; `term` = terminal/SDK logs; `dot` = generic bullet/fallback.

### 4.2 `Pill` (+ `ReadinessPill`, `ValidationPill`)

Verbatim (ui.jsx:54–61):

```jsx
function Pill({ kind, children, dot, sm }) {
  return (
    <span className={"pill " + (kind || "") + (sm ? " sm" : "")}>
      {dot && <span className="pdot" />}
      {children}
    </span>
  );
}
```

- `kind`: one of `ready | input | risk | blocked | info | agent | neutral | done` (CSS classes; omitted kind renders base `.pill`, which is styled identically to `ready` — teal). Never invent new kinds; every kind has a light-bg/dark-text token pair in CSS.
- `dot`: renders `<span className="pdot"/>` — a `.42rem` circle in `currentColor`, used to signal "live/state" pills.
- `sm`: compact variant (`.66rem` font instead of `.72rem`).
- Children: plain text almost always; occasionally an inline element (task.jsx:453 puts a colored stage dot span inside a pill).

`ReadinessPill({ value, sm })` → `<Pill kind={r.kind} dot sm={sm}>{r.label}</Pill>` — **always dotted**.
`ValidationPill({ value, sm })` → `<Pill kind={v.kind} sm={sm}>{v.label}</Pill>` — **never dotted**.

Observed pill kind usage across surfaces (contract examples the port must be able to express): `kind="ready" dot` "connected"; `kind="done"|"info"` "merged"/"in review"/"PR #241"; `kind="agent"` "operator active", "agent", "2 agents running"; `kind="neutral"` stage names, "no PR", "app user · not in project"; `kind="input"` "3 waiting on you", "invite pending", "expires in 30 days"; `kind="risk"` "all profiles"; `kind="blocked"|"input"` packet kind pills on decision packets.

### 4.3 `AgentGlyph`

Verbatim (ui.jsx:87–94):

```jsx
function AgentGlyph({ backend, lg }) {
  const cls = backend === "claude" ? "claude" : "codex";
  return (
    <span className={"agent-glyph " + cls + (lg ? " lg" : "")} title={backend === "claude" ? "Claude Code" : "Codex"}>
      <Icon name={backend === "claude" ? "sparkle" : "cpu"} />
    </span>
  );
}
```

- `backend === "claude"` → class `claude`, icon `sparkle`, title `Claude Code`. **Any other value** (including `"codex"`, undefined) → class `codex`, icon `cpu`, title `Codex`.
- Visual identity: 26×26 square with clip-path cut corners ("machine" look), `.lg` = 34×34. Codex bg `#eee9ff` (violet-ish), Claude bg `#ffe9dd` / text `#8a4b22` (hardcoded hexes in viberr.css — they are part of the ported-verbatim CSS, leave them).
- **Third variant used raw by consumers, not via this component:** `.agent-glyph.op` (black `var(--fg)` background, white icon) always paired with the `shield` icon, representing the **Operator / orchestration runtime**:
  - runs.jsx:36 `if (run.op) return <span className="agent-glyph op"><Icon name="shield" /></span>;`
  - task.jsx:14 `from <span className="agent-glyph op"><Icon name="shield" /></span> <strong>…</strong>` (packet header)
  - agents.jsx:192 with inline `style={{ width: 22, height: 22 }}`
  The ported component should support this as a first-class variant (e.g. `variant="op"` or `backend="operator"`), keeping the exact class output `agent-glyph op`.

### 4.4 `Avatar`

Verbatim (ui.jsx:96–99):

```jsx
function Avatar({ person, lg }) {
  const tone = person && person.tone ? " " + person.tone : "";
  return <span className={"avatar" + (lg ? " lg" : "") + tone}>{(person && person.initials) || "?"}</span>;
}
```

- `person`: `{ initials: string, tone?: "" | "rose" | "teal" | "violet" }`. Missing person or initials → renders `"?"`.
- Sizes: base 26×26 (`.72rem` font), `.lg` 34×34 (`.86rem`), and a CSS-only `.xl` 56×56 (`1.3rem`) used raw in profile.jsx:11 (`<span className="avatar xl">{initialsOf(me.name)}</span>`) — the port should expose `size: "md" | "lg" | "xl"`.
- Default tone (no class) = blue (`--blue-soft` bg / `--blue-pressed` text). Tones map to the token palette in viberr.css (`.avatar.rose`, `.avatar.teal`, `.avatar.violet`).

### 4.5 `Identity`

Verbatim (ui.jsx:102–132):

```jsx
function Identity({ who, lg, sub }) {
  if (!who) return <span className="who-chip"><span className="avatar">?</span></span>;
  if (who.kind === "agent") {
    return (
      <span className="who-chip">
        <AgentGlyph backend={who.backend} lg={lg} />
        <span>
          <span className="nm">{who.name}{who.role ? " · " + who.role : ""}</span>
          {sub && <div className="sub">agent specialist</div>}
        </span>
      </span>
    );
  }
  if (who.kind === "system") {
    return (
      <span className="who-chip">
        <span className="agent-glyph"><Icon name="shield" /></span>
        <span className="nm">{who.name}</span>
      </span>
    );
  }
  return (
    <span className="who-chip">
      <Avatar person={who} lg={lg} />
      <span>
        <span className="nm">{who.name}</span>
        {sub && <div className="sub">human · maintainer</div>}
      </span>
    </span>
  );
}
```

- Three branches: `kind === "agent"` (glyph + "Name · Role"), `kind === "system"` (default-toned agent-glyph + shield + name), else human (Avatar + name). `sub` adds a hardcoded sub-line: `agent specialist` / `human · maintainer` (prototype copy — see §7).
- **Caution:** despite being exported, no other mock file renders `<Identity>`; screens hand-roll `who-chip` markup instead (e.g. task.jsx:203, board.jsx:19). Port it anyway as the canonical actor renderer and use it to replace the hand-rolled copies where markup matches, but verify per-surface markup against each surface's own spec — several sites add extra elements inside the chip.

### 4.6 `PageOverlay`

Verbatim (ui.jsx:135–150):

```jsx
function PageOverlay({ label, onClose, children }) {
  useEffect(() => {
    const f = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", f);
    return () => window.removeEventListener("keydown", f);
  }, []);
  return (
    <React.Fragment>
      <div className="confirm-scrim" onClick={onClose}></div>
      <div className="page-overlay" role="dialog" aria-modal="true" aria-label={label} data-screen-label={label + " — overlay"}>
        <button className="icon-btn overlay-x" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
        <div className="page-overlay-body">{children}</div>
      </div>
    </React.Fragment>
  );
}
```

Behavior contract:
- Scrim click closes; Escape closes; X button (`.icon-btn.overlay-x`, `aria-label="Close"`) closes.
- `role="dialog" aria-modal="true" aria-label={label}` — keep.
- `data-screen-label={label + " — overlay"}` is mock screenshot-tooling metadata (no CSS rule targets it) — drop in the port unless kept deliberately for e2e selectors.
- Panel: fixed, centered, `min(1080px, 100vw − 2.5rem)` × `min(780px, 100vh − 3rem)`, z-index 61 over scrim z-60; body scrolls (`.page-overlay-body` `overflow-y:auto`, flex column). Contextual overrides exist: `.page-overlay .board-head { padding-right: 4.4rem; }` (clears the X button), `.page-overlay .board-wrap { flex:none; }`, `.page-overlay .policy-wrap { … }`.
- Usage in the mock: `main.jsx` and `home.jsx` wrap the full Profile page and Notifications page: `<PageOverlay label="Profile & preferences" onClose={…}>` and `<PageOverlay label="Notifications" onClose={…}>`.
- **Known mock defects to fix in the port** (behavior parity not required for bugs):
  1. `useEffect` deps are `[]` but the handler closes over `onClose` → stale closure if `onClose` identity changes. Fix with a ref or `[onClose]` deps.
  2. No focus trap, no initial focus, no focus-return-on-close, no body scroll lock. The real app should add these (focus the dialog or X on open, trap Tab, restore focus) while keeping the exact DOM classes.

### 4.7 `TglP` (toggle switch)

Verbatim (ui.jsx:153–159):

```jsx
function TglP({ on, onChange, label }) {
  return (
    <button type="button" className={"tgl" + (on ? " on" : "")} role="switch" aria-checked={on} aria-label={label} onClick={onChange}>
      <span className="knob"></span>
    </button>
  );
}
```

- Fully controlled; `onChange` takes no arguments (caller flips its own state).
- Classes: `.tgl` / `.tgl.on` (blue fill when on), `.knob` slides 2px→17px. 36×21px.
- `aria-label` is required by every call site (they pass human copy like row names, `"Reduce motion"`, `"Task-level repository override"`).
- Note: `policy.jsx` also re-exports `TglP` on window (`Object.assign(window, { Policy, TglP })` at policy.jsx:213 with comment "TglP moved to ui.jsx") — harmless double-export in the mock; in the port there is exactly one module.

### 4.8 Toasts: `useToasts` + `ToastHost`

Verbatim (ui.jsx:162–179):

```jsx
function useToasts() {
  const [toasts, setToasts] = useState([]);
  const push = (text) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t, { id, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 2600);
  };
  return { toasts, push };
}
function ToastHost({ toasts }) {
  return (
    <div className="toast-wrap" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div className="toast" key={t.id}><Icon name="check" />{t.text}</div>
      ))}
    </div>
  );
}
```

- Toast record: `{ id: string, text: string }`. Auto-dismiss after **2600 ms**; multiple toasts stack bottom-center (column, newest last).
- `ToastHost` is mounted once per page root (`main.jsx:318`, `home.jsx:628`) and `push` is prop-drilled to every child that needs it. The mock has **no toast context** — see §7 for the port decision.
- Every toast shows the `check` icon (teal-tinted) regardless of message sentiment — the mock uses toasts only for confirmations, never errors.
- Container: `.toast-wrap` fixed bottom-center z-100, `role="status" aria-live="polite"`. Toast: dark (`var(--fg)`) bg, white text, `rise` animation.
- Representative toast copy from consumers (exact strings, for parity tests): `"Theme · Dark"`, `"Theme · System (follows your OS)"`, `"Motion reduced — pulses and animation paused"`, `"Motion restored"`, `"Timeline opens on “Important”"`, `"<Category name> notifications on"`/`"… off"`.

### 4.9 `initialsOf`

Verbatim (ui.jsx:182–184):

```js
function initialsOf(name) {
  return (name || "").trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase() || "?";
}
```

- First character of the first two whitespace-separated words, uppercased; `"?"` for empty/undefined.
- Consumers: user-menu avatar (`main.jsx:54,69`), profile XL avatar, org-settings member rows (github handle → `initialsOf(p.handle)`, google email local-part, invited name — org-settings.jsx:452–454).
- Port to `app/shared/initials.ts`; it will run on both server (projection/loader shaping) and client. Turkish names appear in seed data ("Murat Yıldız" → "MY") — plain `w[0]` + `toUpperCase()` is acceptable; do not add locale-specific casing.

### 4.10 `initPrefs` IIFE (theme/motion application)

Verbatim core (ui.jsx:205–217):

```js
const apply = () => {
  const dark = prefs.theme === "dark" || (prefs.theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.documentElement.dataset.motion = prefs.motion === "reduce" ? "reduce" : "full";
};
window.VIBERR.prefs = prefs;
window.VIBERR.savePrefs = (patch) => {
  Object.assign(prefs, patch);
  try { localStorage.setItem("viberr:prefs", JSON.stringify(prefs)); } catch (e) {}
  apply();
};
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { if (prefs.theme === "system") apply(); });
apply();
```

Contract points:
- `<html>` gets `data-theme="dark"|"light"` (always resolved — never `"system"` in the DOM) and `data-motion="reduce"|"full"`. All theming CSS keys off these two datasets.
- `theme === "system"` tracks `prefers-color-scheme` live via a `matchMedia` change listener.
- `savePrefs(patch)` is a **shallow** merge (`Object.assign`) — callers that change nested `notifs` pass the entire next `notifs` object (profile.jsx:81 does this correctly). Keep that calling convention or make the port's action accept full sub-objects.
- Every mock HTML entry additionally has an inline `<head>` FOUC-guard duplicating `apply()` from localStorage before first paint:

```html
<script>try{var p=JSON.parse(localStorage.getItem("viberr:prefs")||"{}");var d=p.theme==="dark"||((p.theme||"system")==="system"&&matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.dataset.theme=d?"dark":"light";if(p.motion==="reduce")document.documentElement.dataset.motion="reduce";}catch(e){}</script>
```

Real-app replacement (§6): theme+motion come from the user record via the root loader and a cookie; SSR renders `data-theme` on `<html>` directly for `light|dark`; only the `system` case needs a tiny inline script (blocking, in `<head>` of `root.tsx`) to resolve `matchMedia` pre-hydration, plus the same live `matchMedia` listener client-side.

---

## 5. Events / mutations produced

These primitives are presentational; the only mutation in this file is preference writes.

| Mock behavior | Real action |
|---|---|
| `VIBERR.savePrefs(patch)` → localStorage + re-apply datasets | `POST` to a profile/preferences action (e.g. `/profile` route action or a dedicated resource route): update the user's prefs in SQLite, set/refresh the theme cookie, return updated prefs. Client applies `data-theme`/`data-motion` optimistically (this is personal UI state, NOT governed state — optimistic is fine here and matches the mock's instant feel). |
| Theme change from user menu (`main.jsx`/`home.jsx` call `savePrefs({ theme })`) | Same action; fetcher submit; no revalidation storm needed. |
| Notification routing / nudge changes (profile) | Same prefs action. These influence which notifications the server generates/routes — server must read prefs when fanning out notifications. |
| `ghConnected` flip | **Delete.** GitHub connection state is derived from stored PAT rows; connect/disconnect are real actions in the GitHub feature (own spec). |

No typed timeline events and no audit events originate from this file (prefs are personal, not governed). Toasts are client-only ephemera — never persisted, never server-sent; in the port they fire on fetcher/action completion.

---

## 6. CSS classes used (the contract)

Structural classes emitted by these components — all already exist verbatim in the ported CSS; do not rename, do not restyle:

- **Icon:** `ico` (+ contextual size overrides listed in §4.1).
- **Pill:** `pill`, kind modifiers `ready` `input` `risk` `blocked` `info` `agent` `neutral` `done`, size `sm`, dot child `pdot`.
- **Agent glyph:** `agent-glyph`, modifiers `codex` `claude` `op` `lg`.
- **Avatar:** `avatar`, tones `rose` `teal` `violet`, sizes `lg` `xl`.
- **Identity:** `who-chip` with children `nm` (name, display font 700) and `sub` (faint sub-line). NOTE: `nm`/`sub` are generic class names reused in many other contexts (`.col-head .nm`, `.ag-item-main .nm`, `.card-owner .nm`…) with per-context styling — the who-chip variants are `.who-chip .nm` / `.who-chip .sub`.
- **PageOverlay:** `confirm-scrim` (shared with confirm dialogs, z-60), `page-overlay` (z-61), `page-overlay-body`, `overlay-x` combined with `icon-btn`.
- **Toggle:** `tgl`, `on`, `knob`.
- **Toasts:** `toast-wrap`, `toast`.
- **Misc referenced by consumers of these primitives:** `icon-btn` (38×38 grid-centered bordered button), `empty` (empty-state text for lists), `menu-scrim`/`user-menu` (menus, other spec).
- **Theming hooks:** `html[data-theme="dark"|"light"]`, `html[data-motion="reduce"|"full"]`.

Key visual facts (for review parity, all from viberr.css): pill = inline-flex chip, `.72rem`/900 weight, `--radius-chip`; agent-glyph = 26px square, clip-path `polygon(22% 0, 100% 0, 100% 78%, 78% 100%, 0 100%, 0 22%)`; avatar = 26px circle, display font 800; toast = dark bg white text, `rise` keyframes; scrim = `color-mix(in srgb, var(--fg), transparent 70%)`; overlay pops with `pop-center` keyframes.

---

## 7. Porting notes

**Prototype-only → replace:**
1. `window` global exports & Babel-in-browser → ES modules under `app/ui/` with named exports; screens import them. No `window.*` anywhere.
2. `window.VIBERR.prefs` / `savePrefs` / `localStorage["viberr:prefs"]` → user prefs in SQLite + theme cookie + prefs action (§5, §4.10). Define a Zod schema for the prefs object in `app/schemas/` (values enumerated in §3.2) so tolerant parsing applies to stored prefs too.
3. FOUC-guard inline script per HTML page → single inline script in `root.tsx` `<head>`, cookie-first: server writes resolved `data-theme` when theme is `light|dark`; script only handles `system` resolution and motion.
4. `data-screen-label` attribute → drop (screenshot tooling).
5. `ghConnected` pref → derived state, delete from prefs.
6. `Math.random()` toast ids → `crypto.randomUUID()` or a module counter (SSR-safe: ids are only created client-side on push, so either works).
7. Hardcoded `Identity` sub-copy (`"agent specialist"`, `"human · maintainer"`) → make `sub` a string prop (callers pass real role copy from data); mock only ever renders those two strings, and only when `sub` is truthy.

**Component API hardening (keep DOM output identical):**
- TypeScript unions for `Pill.kind`, avatar `tone`/`size`, `AgentGlyph` variant (`"claude" | "codex" | "op"` — preserve "unknown → codex" fallback for resilience), `Icon.name` as `keyof typeof ICON_PATHS`.
- `ReadinessPill` should accept the real enum (`ready | input_required | inconsistency_risk_detected | blocked`) plus the accepted/done display state, and translate to the mock CSS kinds internally (§3.3). Do NOT push the long enum values into class names.
- `Icon` may keep `dangerouslySetInnerHTML` (paths are static trusted constants; it's SSR-compatible) or be converted to pre-parsed JSX per icon — either way the emitted SVG attributes must match §4.1 exactly.
- `PageOverlay`: fix the stale-`onClose` effect; add focus management (initial focus, trap, restore) and body scroll lock; keep scrim/Escape/X close paths and all class names/aria attributes.
- Toasts: mock instantiates `useToasts` per page root and prop-drills `push`. For the port, a `ToastProvider` + `useToast()` context in the root layout is cleaner and avoids threading `push` through every feature; keep `ToastHost` markup and the 2600 ms auto-dismiss. Consider a variant prop later for error toasts (mock never shows errors as toasts — errors in the real app should typically render inline/route-level, per CONVENTIONS error rules).

**Edge cases and states:**
- `Icon` unknown name → `dot` (silent). `Avatar` no person/initials → `"?"`. `Identity` falsy `who` → lone `"?"` avatar in a who-chip. Empty `initialsOf` → `"?"`. Keep all four fallbacks — timeline/notification data can reference actors that no longer resolve.
- Operator actor rows in data have `{ kind: "agent", name: "Operator" }` with **no `backend`** — via `AgentGlyph` fallback they'd render as Codex, which is why consumers hand-roll `.agent-glyph.op` + shield for the Operator instead. When porting actor rendering, branch on operator/system BEFORE backend.
- Pills must truncate gracefully: CSS already sets `max-width:100%; white-space:nowrap` — don't wrap pills in containers narrower than their content without an ellipsis strategy.
- `prefers-color-scheme` listener must be cleaned up if moved into a React effect (mock leaks it deliberately as a page-lifetime singleton).
- Prefs merge: unknown/missing keys fall back to defaults; nested merge is one level deep for `notifs`/`nudge` only — replicate in the Zod schema with `.default()`s so a user row with partial prefs never crashes (tolerant parsing rule).
- No loading/error states exist in this file; all primitives are synchronous. Empty states of consuming lists use `.empty` ("…" copy owned by each surface's spec).

---

## 8. Open questions

1. **Avatar tone assignment.** Mock hardcodes tone per person (`""`, `rose`, `teal`, `violet`). Real app: store a `tone` column on `users`, or derive deterministically (e.g. `hash(userId) % 4` over `["", "rose", "teal", "violet"]`)? Deterministic derivation avoids a migration and keeps parity; needs a decision before user-facing surfaces render.
2. **`Identity` adoption.** It is exported but unused in the mock (screens hand-roll `who-chip`s with slight variations). Port it and consolidate call sites, or keep per-surface markup verbatim? Recommendation: port it, adopt it only where a surface's markup is byte-identical to one of its three branches.
3. **Overlay-vs-route for Profile/Notifications.** Mock shows both ONLY inside `PageOverlay` over the current screen; the target route map has top-level `/profile` and `/notifications`. Decide: plain full pages, or routes that render inside `PageOverlay` above the previous location (location-state / parallel-route pattern). Affects whether `PageOverlay` needs router integration (close = `navigate(-1)`).
4. **Email notification channel.** Prefs carry `email` booleans per category but the profile UI renders only the `app` toggle, and no email infrastructure is in the plan. Drop `email` from the ported prefs schema, or keep it dormant for parity?
5. **Nudge delivery.** `nudge: { on, hours }` implies a server-side scheduler ("packet waiting on you for N hours" reminders). Which phase owns that (notifications feature? a cron in the runtime phase?) — this spec only guarantees the pref is stored.
6. **Toast error variant.** Mock toasts are success-only (check icon). Confirm the real app keeps toasts success-only and surfaces failures via route/action error UI, or add a visual error variant (new CSS would have to go in the appended section of `app.css`).
7. **`title` attribute on `AgentGlyph`** provides the only text alternative for the backend identity. Sufficient, or add `aria-label`/visually-hidden text for screen readers?
