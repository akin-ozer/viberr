# CONVERSATION SUMMARY — Viberr

## Amendment — July 4, 2026: INITIAL BUILD — Operator Workspace (board + task detail) + copy/UX polish
*(Chronologically this conversation PRECEDES all other amendments below — it created the workspace artifact they build on.)*

### Context
User asked for a product design from the PRD (`uploads/prd.md`) and attached the existing Viberr design language: `design-system.html`, `landing.html`, `index.html` (copied to `viberr/reference/`). Viberr = agent-native delivery workspace: agents execute tasks, humans decide. Built the missing product UI as an interactive React prototype.

### What was built
`viberr/Viberr Operator Workspace.html` + `viberr/app/`:
- `viberr.css` — extends the design system (white canvas, pastel semantic surfaces, `#5b76fe` primary, 999px pills, panel radii). **Manrope** stands in for Roobert PRO (not web-available); Noto Sans body, JetBrains Mono for keys/branches/evidence.
- `data.js` — `window.VIBERR`: 5 stages (Triage/Ready/In Progress/Review/Done), 10 VIB-xxx tasks, people (Arda/Elif/Murat), VIB-142 has the flagship decision packet + full timeline.
- `ui.jsx` — Icon (inline stroke SVG set), Pill (readiness/validation vocab), AgentGlyph/Avatar/Identity, toasts.
- `board.jsx` — agent-aware kanban: readiness pill, owner line, branch/PR trace, waiting-on-you vs agent-working tags; filter chips (All / Waiting on me / Agent working / Needs attention); Board/List segmented toggle.
- `task.jsx` — operator-first detail: **decision packet** (observations grid, radio options w/ "operator pick", accept/route actions), execution profile (Operator + primary specialist + consultants + continuity row), typed timeline (quality/transition/blocked/completion/policy/github event nodes) + comment composer, side rail (GitHub trace, current state, Permissions).
- `main.jsx` — shell: left rail (brand→home, project switch, nav w/ counts, user chip→quick menu), topbar (breadcrumbs→home, ⌘K search), routing, resolve/comment state with toasts.

### Core design convention (carry forward)
**Agent vs human identity split**: agents = angular clip-path glyph, violet (`--agent` #7b61ff family), Codex=cpu icon / Claude=sparkle; humans = round avatars, blue. "Waiting on you" (blue, hand icon) vs "agent working" (violet, pulsing dot).

### Copy/UX decisions from iteration (RESPECT THESE)
- **"govern/governor/governance" is BANNED** — use **Maintainer** (human role), **Permissions** (panel), "managed".
- No "Secrets · Isolated" row in Permissions.
- No live/SSE indicator in topbar (built "SSE live" → renamed "Live" → removed entirely).
- No "inconsistency risk" readiness label (VIB-160 retagged `input`).
- Comments address via **@ mentions** (`@operator` / `@agent` / `@name`), NOT addressee toggle buttons (Team/Specialist toggle removed). Hint lives in the textarea placeholder ONLY — the separate gray hint line under the composer was removed. `.mention` renders violet-highlighted in timeline; `onComment` infers agent routing from mention regex.
- Brand logo (rail) and "Viberr Core" breadcrumb both navigate home.
- User chip (bottom rail) opens quick menu popup: profile & preferences, switch project, notifications, theme, sign out — scrim click-away, caret rotates.
- Accepting a completion packet: task → Done, readiness `done`, packet cleared, completion event prepended, toast.

### Gotchas hit
- `.rail-user > span { flex:1 }` squashed the avatar — selector must exclude `.avatar`.
- Base `svg.ico { 16px }` needed; oversized chevrons otherwise.
- Screenshot tool doesn't paint the animated user-menu popover; verify via DOM rect.

## Amendment — July 4, 2026: Agents page (profiles, create/edit, capability matrix) + board hover polish

### Context
Built the **Agents** view in `viberr/Viberr Operator Workspace.html` (was a placeholder), grounded in PRD FR8/FR9/FR18–23. All state is view-local React state (not persisted); data in `VIBERR.agents` (`data.js`).

### 1. Agents view (`app/agents.jsx`, view `"agents"` in rail)
- **Stats strip**: profiles approved / operators running (one per active task) / specialists working / threads waiting on a human — derived live from task data via `deployments(tasks)` (operator + primary owner + consultants per non-done task).
- **Profiles tab** — master-detail: left list (pinned **Operator** under "Orchestration" group label; specialists under their own label with hover-reveal "+"), right detail:
  - Hero: glyph, name, role pill, running-on-N-tasks / idle badge, scope line; actions = **Delete** (ghost, specialists only) + **Edit profile**.
  - Panels: Eligible stages (chips; ineligible struck), Capability policy (3 columns: Acts directly / Recommends only / Reserved for humans), Context resources & runtime (skills/MCP/KB chips + backend + model + re-anchors-on-task.md), Active deployments (clickable rows → task).
- **Live tab**: agent-centric roster table (Agent / Backend / Task / Engagement / Status), operators+primaries+consultants sorted by task key.
- Profiles in data: Operator (system role, orchestration runtime) + Developer, Reviewer, Tester, Consultant specialists.

### 2. Create + Edit profile modal (`CreateProfileModal`, shared for both)
- Entry: toolbar "New profile", "+" next to group label, dashed "New specialist profile" at list bottom; Edit via detail hero button (pre-fills everything; `initial` prop ⇒ editing mode, "Save changes").
- Fields: Name*, Role*, **Execution backend*** — single-select (Codex or Claude Code, exactly one; picking one deselects the other; none ⇒ red error hint + disabled submit), **Eligible stages*** (multi chips), **Definition** — plain textarea in user's words (NO generated AGENTS.md preview — user explicitly rejected it; real AGENTS.md is compiled at the backend from definition + form; explanatory note under field also removed), **Capability policy** — pre-filled catalog `CAP_CATALOG` of 18 actions in 3 collapsible accordion groups (Repository & execution / Validation & review / Workflow & governance), each action a Direct/Recommend/Human/Off segmented control with sensible defaults (merge, Done-transition, policy-change default Human); collapsed headers show color-dot counts; first group open, **Context resources** — same accordion pattern (`RES_CATALOG`: Skills 10 / MCP servers 6 / KBs 8 as toggle chips, "N of M" summary, defaults pre-granted).
- Edit preserves non-catalog data: `reverseCaps`/`extraCaps` keep custom action phrasings (e.g. Developer's "Run unit & integration validation") and actual governance through round-trip; operator editable too (keeps its runtime).
- Root state: `added[]`, `removed[]`, `edits{}` (`applyEdit` overlay), `onCreate`/`onSave`/`onDelete`.
- Delete = confirm dialog (`.confirm-card`) warning when profile engaged on active tasks; centering bug fixed via dedicated `pop-center` keyframe (generic `rise` keyframe was clobbering `translate(-50%,-50%)` — reuse `pop-center` for any centered modal).
- Stale-state bug fixed: chip toggles use functional `set(arr=>…)` updates.

### 3. Capability matrix modal (toolbar button)
- `CapabilityMatrixModal`: wide modal (`.modal-wide`, 1060px), table of every profile (columns, sticky header) × every catalog action (rows, grouped; plus "Other actions" group for non-catalog/operator-specific ones), cells color-coded Direct(teal)/Recommend(blue)/Human(red)/Off(grey dot) with legend; reads live profile list so edits reflect.

### 4. Board polish (user-requested)
- **Removed colored inset left-edge bars** on wait-human/urgent cards and the hover lift+pop-shadow; cards keep neutral `--shadow-card` always, hover = subtle grey bg tint (`color-mix(fg, transparent 96%)`) + border darken. Don't re-add colored card shadows/edges.
- Rail user role text: wraps (no ellipsis), .75rem.
- Removed "enforced per action" pill from Capability policy panel head.

### CSS added (`viberr.css`)
`.ag-*` (stats, list items, hero, group labels, add buttons), `.stage-chip`, `.cap-col*` (3-col policy), `.cap-m*` (accordion matrix + segmented controls), `.res-*`, `.deploy-row`, `.live-*` (roster table), `.confirm-*` + `pop-center`, `.modal-*` (create/edit + `.modal-wide`), `.pick-chip(.mono)`, `.tagbox`/`.tag` (TagInput still in code but unused in modal), `.mx-*` (matrix table), `.def-note` (unused now), `.foot-hint.err`.

### Notes
- Script order: `agents.jsx` after `task.jsx`, before `main.jsx`.
- User rejections to respect: no Duplicate button, no AGENTS.md preview/generator, no field explainer notes, no colored card accents.

## Amendment — July 4, 2026: Board settings page, editable stages, members, Activity + audit logs (workspace)

### Context
Work on `viberr/Viberr Operator Workspace.html`, grounded in PRD (`uploads/prd-6f9565c4.md`). Built the board-level Policy page, then split it into Policy / Settings / Activity.

### 1. Policy page (`app/policy.jsx`) — final shape after trims
- View `"policy"` in rail. Header sub: "Human access and agent capability — two surfaces, managed separately".
- **Human access** (role select per member) + **Agent capability** panels side by side (`.policy-cols`).
- **Workflow rules**: per-transition boundary select (agent-allowed / human-only / operator-auto); matrix collapsible.
- Things user REMOVED from Policy — do not re-add: intro/explainer copy, RBAC matrix legend footnote, "policies are enforced" phrasing must stay (never "governed" — banned word), agent guardrail extras, quality-gate panel, "durable across restarts" subtext.
- Repository & credentials panel MOVED to Settings; Audit logs panel MOVED to Activity (see below). `Policy` no longer takes `onOpen`/`scopeGranted`/`onGrantScope` props. Exports `TglP` (used by Settings).

### 2. Settings page (`app/settings.jsx`) — NEW view `"settings"` (rail item, `sliders` icon)
- **Project** panel: editable name / task prefix (VIB, ≤4 chars uppercased) / description; task-key + canonical file kv rows.
- **Workflow stages** panel — fully interactive: drag grip to reorder (board columns update live via shared `stages` state in `main.jsx`, `window.VIBERR.stages` kept in sync), click name to inline-rename (Enter/Esc), × to remove, "Add stage" inserts before Done. Guards: Triage first / Done last (locked rows show lock icon, `STAGE_LOCK`), non-empty stages can't be removed (toast says move N tasks first). Links to Policy → Workflow rules for transition permissions.
- **Members** panel (user creation/management, NOT roles): invite by name+email → joins as Viewer with "invite pending" pill; × removes/revokes with guards (can't remove self, can't remove last admin). Members state lifted to `main.jsx` (`members`, syncs `window.VIBERR.policy.members`); rail member count live. Roles stay in Policy → Human access (note links there). Member rows have `status: active|invited` in `data.js`.
- **Repository & credentials** (moved from Policy): default repo, task-level override toggle, repos-per-task limit, credential card with scope chips; missing `pull_request:write` warning → links VIB-142 + "Grant scope" button (resolves violation badge, flips audit-log pill to resolved).
- **Danger zone**: archive/delete, denied via RBAC toast (signed in as maintainer).
- Quality-gate panel was built here then REMOVED on request — don't re-add.
- "Block on policy" packet decision in `main.jsx` now navigates to `"settings"` (was policy). Scope-violation rail badge sits on Settings nav item.

### 3. Activity page (`app/activity.jsx`) — rebuilt from placeholder, view `"activity"`
- Two-column layout (`.activity-cols`, 1.55fr/1fr, collapses <1100px):
  - **Stream**: day-grouped (Today / Yesterday / Mar 30). Today = live task timelines + runtime `extra` events (so packet resolutions appear immediately); older days curated. Rows: actor-typed icon (`ACT_ICON`/`act-*` CSS), bold actor name, rich text (`RichA`: **bold** + `code`), task keybtn link, time. Header filter: All/Humans/Agents/System.
  - **Audit logs** (moved from Policy): `P.events` with kind icons (violation/blockedact/change/audit), task links, violation pill open→resolved on `scopeGranted`. Subtext "policy & access".

### CSS added (`viberr.css`)
`.stg-*` (editable stage rows: grip handle, inline input, hover ×, drag states), `.you-tag`, `.invite-row`, `.danger-panel`/`.dz-*`, `.set-fields`, `.activity-cols`, `.act-day`/`.act-actor`/`.act-sep`, `.pev-ico.act-*` tones. Icons added to `ui.jsx`: `sliders`, `grip`.

### Script order (workspace HTML)
`policy.jsx` → `activity.jsx` → `settings.jsx` (before `main.jsx`).

## Amendment — July 4, 2026: Full PRD audit + fix pass (workspace)

### Context
Page-by-page audit of `viberr/Viberr Operator Workspace.html` against the PRD (`uploads/prd-6f9565c4.md`), then holistic fixes until clean. All flows verified in-browser (no console errors).

### New views (were placeholder stubs)
- **`app/review.jsx` — Review queue** (FR25–FR27): split panels "Waiting on your acceptance" vs "Still with agents", clickable rows → task; "Review → Done · human only" lock links to Policy.
- **`app/github.jsx` — GitHub** (FR29–FR32): repo panel, credential card with scope chips (missing `pull_request:write` warning → links VIB-142 + "Fix in Settings"), PR list, task-key branch traceability table, Reconcile action. Both registered in workspace HTML script tags.

### Fixes by page
- **Board** (`board.jsx` rewritten): 5 columns fit laptop widths (col min 290→218px, ≤1400px media step); New task modal creates keyed task (title required, stage chips — no Done, goal hint re triage gate); Re-scan + per-column "+" wired; List view; Done cards show "accepted" (readiness `done` in data).
- **Task detail** (`task.jsx`): packet "from Operator" shows operator shield glyph (was Codex glyph); canonical path unified to `.viberr/tasks/<key>/task.md`; "Ask operator" focuses composer prefilled `@operator`; timeline times show day prefix for non-Today; "Open on GitHub" toasts (stubbed); radio a11y on packet options.
- **Data** (`data.js`): filled all 8 empty timelines with cross-consistent events; **VIB-160 got a blocked-decision packet** (PRD Journey 2: resume rehydrated thread / fresh specialist / hold for runtime debug) + continuity-degraded timeline.
- **Resolve semantics** (`main.jsx`): `onResolve({option})` with per-option `accept`/`ev` fields — fixes bug where any first option marked task Done. Accepting completion also flips PR to merged. "Hold for runtime debug" / "Block on policy" paths added. `scopeGranted` state: Settings grant resolves the VIB-142 policy flag + rail violation badge.
- **Activity** (`activity.jsx`): stream single-sourced from task timelines (no duplicate curated copy), grouped Today/Yesterday/Mar 30, time-sorted desc.
- **Misc**: `data-screen-label` on all views; toast aria-live; thin styled scrollbars; `.rq-row` / `.gh-table` CSS added.

### Caveat
Board still scrolls horizontally <~1250px by design (PRD scopes narrow screens to review-first).

## Amendment — July 4, 2026: Profile & preferences page, Notifications page (workspace)

### Context
Work on `viberr/Viberr Operator Workspace.html` only, grounded in PRD (`uploads/prd-6f9565c4.md`). Built two user-level views inside the workspace app.

### 1. Profile & preferences (`app/profile.jsx`)
- Reached via avatar menu (bottom-left rail) → view `"profile"`.
- Two balanced column stacks (`.profile-cols`/`.profile-col`, 1fr 1fr, collapses <1100px):
  - Left: **Profile** (editable display name/title — rail avatar+name update live; email disabled, "managed by identity provider") + **Notification routing** (per-typed-event in-app/email toggles: packets, approvals, mentions, policy, quality; waiting-on-you reminder stepper 1/2/4/8/24 h).
  - Right: **Your access** (read-only maintainer RBAC from `VIBERR.policy.rbac`, links to Policy) + **Appearance & workspace** (theme Light/Dark/System, reduce motion, default timeline filter — applied in `task.jsx`) + **GitHub identity** (personal OAuth attribution, connect/disconnect; distinct from project execution credential in Settings).
- **Sessions & security panel was built then removed on request** — don't re-add.

### 2. Theme system / preferences persistence
- Prefs stored in `localStorage` key `viberr:prefs` via `window.VIBERR.prefs` + `VIBERR.savePrefs(patch)` (initialized in `ui.jsx`; also exports `initialsOf`).
- Full **dark theme** added at end of `viberr.css`: `:root[data-theme="dark"]` token swap + fixups; `[data-motion="reduce"]` kills animation. FOUC-guard boot script in workspace HTML `<head>` sets `data-theme`/`data-motion` before CSS loads. System theme follows `prefers-color-scheme` live.
- Avatar-menu Theme item cycles Light → Dark → System.

### 3. Notifications page (`app/notifications.jsx`, data in `VIBERR.notifications`)
- Entry: topbar **bell button with unread badge** (`.bell-btn`/`.bell-badge`) + avatar-menu item showing unread count. View `"notifications"`.
- Full-width stacked layout (routing side-panel was built then **removed on request**): top **Waiting on you** (decision packets + approval requests as clickable rows → opens task; resolving a packet in task view clears its unread), below **Everything else** (mentions, policy events, quality flags, grouped by day; click marks read, blue unread dots).
- Header: All/Unread filter + Mark all read. Unread state lives in `main.jsx` (`notifs` state, `readNotif`, `readAllNotifs`).

### Note on ordering
The "Home page / org settings / auth" amendment below describes a LATER conversation that restructured some of this (profile & notifications became popup overlays shared across pages). This amendment records the original in-workspace page versions.

## Amendment — July 4, 2026: Home (boards) page, global org settings, auth

### Context
Viberr = self-hosted, collaborative agentic AI delivery tool (Kanban-style boards where AI agents execute tasks under human policy). Existing artifact: `viberr/Viberr Operator Workspace.html` (single-project board view). PRD at `uploads/prd-6f9565c4.md`.

### What was built this conversation

**1. `viberr/Viberr Home.html` — post-login landing (board/project selection)**
- Separate page linking into the workspace; users pick a **project** (one board each in V1) and land on its board.
- Project cards grid + starred/pinned projects + New project tile (no hint subtext).
- New-project modal: picks a **GitHub connection at creation** (sets repo root).
- Greeting uses signed-in user's name from session.

**2. Global settings (`#settings/...` on Home) — org level, not board level**
- **GitHub connections**: PAT-only (no GitHub App). Multiple connections; each project selects one at creation. Scopes are immutable on PATs → validation happens **at connection time only**; refused if minimum (repo · workflow · pull_request:write) missing. Rows show PAT capabilities needed by the app + expiration date. New connection and PAT update both happen in a popup — token never displayed, empty field on update, validate-on-apply (fails = not saved). Re-scan action kept; no project-dir/last-scan clutter.
- **Users**: local + GitHub + Google sign-in. No invites — **whitelisting** only (user is allowed in after OAuth if whitelisted; Google supports whole-org whitelist via `@company.com`). Admins edit users and reset passwords on local accounts → user is prompted for a new password at next login. Invite/creation via popup.
- **Agent resources**: knowledge base, MCP servers, skills, global agents — each a section with create/update/delete via popups.
  - **Knowledge base**: file-system browser; nested folder creation; multi-file upload; drag-to-upload onto hovered folder; import from GitHub link; distinct hover actions; deletions require confirm. Stored in a predefined KB folder (no external stores).
  - **Skills**: same folder-management UX; folder upload carried as-is (name + contents intact); `SKILL.md` is the required marker — if uploaded, shown fully and editable.

**3. Notifications — global to the user**
- Same bell button/popup in header on both pages (consistent position, search bar length matched).
- Popup items deep-link straight to the target project/task (not to a notifications page).
- "See all" opens the full notifications list as a **popup overlay**, not a page.

**4. Profile & preferences — global, outside any board**
- Reachable from avatar menu on both pages; rendered as a **popup overlay** (X top-right, outside-click, Esc to close) via shared `PageOverlay` in `ui.jsx`.

**5. `viberr/Viberr Login.html` — login page**
- Local account: `arda@viberr.dev` / password **2828** (Arda converted to a local user for testing). Distinct inline errors for unknown email / wrong password.
- GitHub & Google buttons: whitelist-check stubs (OAuth not wired in prototype).
- Session in `localStorage` (`viberr:session`): Home + workspace redirect to login when signed out; login redirects to Home when signed in; Sign out in both avatar menus clears session.
- Admin password-reset loop works end-to-end: reset in Users → next local login prompts "set a new password" (replaces 2828, stored at `viberr:pw:arda`).
- Tagline: "Self-hosted · collaborative agentic AI delivery" (word "governed" removed).

### Key decisions / constraints (carry forward)
- PAT-only GitHub auth; scope checks only at connect/update time.
- No email notifications (in-app only, don't mention "in-app").
- No SDK/exec mentions ("claude exec"/"codex exec" removed); no subtexts on agent cards.
- Whitelist model for OAuth users; local users get admin-driven password resets.
- Popups/overlays preferred over separate pages for profile, notifications, connection editing, resource creation.
- Board page ("Viberr Core" workspace) header matches Home header exactly; V logo button → Home.

### File map
- `viberr/Viberr Login.html` + `app/login.jsx`
- `viberr/Viberr Home.html` + `app/home.jsx`, `app/home.css`, `app/org-settings.jsx`, `app/kb-browser.jsx`, `app/notifications.jsx`, `app/profile.jsx`
- `viberr/Viberr Operator Workspace.html` + `app/main.jsx`, `app/board.jsx`, `app/settings.jsx`, `app/policy.jsx`, …
- Shared: `app/ui.jsx` (Icon, Pill, Avatar, toasts, `TglP`, `PageOverlay`), `app/data.js` (mock data + `VIBERR.session`), `app/viberr.css`
- Org state persists in `localStorage` key `viberr:org:v10`.
