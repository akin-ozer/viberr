# Cross-cutting contracts

Shared shapes, enums, and rules every phase must agree on, synthesized from all 19 specs in this directory. Where the mock and BUILD-PLAN/CONVENTIONS disagree, §7 records the conflict and the recommended resolution. **Rule of thumb everywhere: canonical/long enum values live in schemas, files, and SQLite; the mock's short values live on as CSS class names and pill labels via one mapping module** (`app/shared/mapping/` or the pill components themselves).

---

## 1. Canonical task shape + timeline events

### 1.1 Task (frontmatter of `tasks/<KEY>/task.md`, projected to SQLite)

```ts
type Task = {
  key: string;                     // "VIB-142" — PK, branch prefix, file path segment; /^[A-Za-z]+-\d+$/
  title: string;
  stage: StageId;                  // resolves against the project's stage list (per-project, editable)
  goal: string;                    // default on create: "Goal to be refined at the triage quality gate."
  readiness: Readiness;            // see §2 — canonical long values in storage
  waiting: "human" | "agent" | "none";
  urgent?: boolean;                // optional — absent on some seeds; treat undefined as false
  validation: "healthy" | "changed" | "failing" | "none";
  owner: HumanRef | null;          // ONE human owner = reviewer + acceptance authority
  specialist: AgentRef | null;     // primary specialist
  operator: { name: "Operator"; since: string } | null;  // null for triage tasks (no operator until they leave triage)
  consultants: AgentRef[];         // 0..n
  branch: string | null;           // "vib-142-attach-workspace" (task-key branches)
  repo: string;                    // project default, task-level override allowed
  // GitHub PROJECTIONS — not frontmatter truth (cached from GitHub API):
  pr: { number: number; state: "review" | "merged"; title: string } | null;
  commits?: { sha: string; msg: string }[];
  changed?: { files: number; add: number; del: number };
  packet?: Packet;                 // newest unresolved operator packet (projection over events)
  timeline: TimelineEvent[];       // append-only typed event log — rendered NEWEST-FIRST everywhere
};
```

Create defaults (board New-task modal → action): `readiness: input_required`, `waiting: human`, `validation: none`, `urgent: false`, everything else null/empty, operator assigned **unless stage is triage**. Key allocation is an atomic per-project counter; prefix from project config (never `key.slice(4)`).

### 1.2 Packet (operator decision packet)

```ts
type Packet = {
  type: "input" | "blocked";       // card tint + pill kind
  kind: string;                    // pill label: "Completion report" | "Blocked decision"
  from: "Operator";
  title: string; body: string;
  observations: { k: string; v: string; code: boolean }[];  // k ∈ Observed|Changed|Validation|Branch|Flag (open set)
  options: {
    t: string; d: string;
    rec: boolean;                  // exactly one true → "operator pick" tag + default selection
    accept?: true;                 // acceptance path (human-only Review→Done)
    ev?: string;                   // pre-authored timeline text written when chosen
  }[];
};
```

**Port requirement (shell §7, task-detail §7):** give options a stable `id` + `kind` enum — `accept | send_back | block_policy | hold_debug | resume | fresh_specialist` — and drive resolve actions off `kind`, never the English title string. Keep `ev` as the event-text template. Resolve side effects (exact, from shell §5.4 / task-detail §5.3):

| option kind | patch | event written |
|---|---|---|
| accept | stage→done, readiness→done/accepted, waiting→none, packet→null, pr.state→merged | `completion`, title "Completion accepted" |
| block_policy | readiness→blocked, waiting→human; navigate to Settings | `blocked` |
| hold_debug | readiness→blocked | `blocked` |
| send_back / resume / fresh_specialist (default) | waiting→agent, readiness→ready, packet→null | `transition` (text = `ev` or fallback "**Decision:** {t}. Operator re-engages the specialist with a summon note.") |

Every resolve also marks that task's packet+approval notifications read (server-side), and must be idempotent (packet already resolved → no-op/409 + toast, not a crash).

### 1.3 Timeline event — the 9 types (contract for parser, projection, and renderer)

```ts
type TimelineEvent = {
  type: "comment" | "completion" | "github" | "policy" | "quality"
      | "transition" | "blocked" | "agent" | "assign";
  actor: HumanActor | AgentActor | OperatorActor | SystemActor;   // §3.1
  t: string;                       // mock: "H:MM" display / "now" — real: UTC ISO occurredAt, formatted
  day?: string;                    // mock display bucket; real: derived from timestamp
  text: string;                    // RichText micro-format: **bold**, `code`, @mention
  title?: string;                  // completion events only ("Completion report" | "Completion accepted")
  evidence?: { label: string; add: string; del: string }[];  // completion only; signed display strings "+14"/"−4"/"0"
  to?: "agent" | null;             // comments only — routed to operator/agent (tinted card)
};
```

Display contract (`EVENT_META` + `typedKind`, task.jsx — seed data must keep satisfying it):

| type | tl-node class | icon | pill label | pill kind |
|---|---|---|---|---|
| comment | `""` | message | *(none — comments are untyped)* | — |
| completion | `completion` | check | Completion report | `done` |
| github | `github` | github | GitHub | `neutral` |
| policy | `policy` | shield | Policy violation | `input` |
| quality | `quality` | flag | Quality flag | `risk` |
| transition | `transition` | arrow | Transition request | `info` |
| blocked | `blocked` | alert | Blocked decision | `blocked` |
| agent | `agent` | agents | Operator | `agent` |
| assign | `transition` | user | Ownership | `info` |

The product's "five typed important events" = `quality`, `transition`, `blocked`, `completion`, `policy`. `github`/`agent`/`assign` are additional system/coordination events; `comment` is the only untyped one (`isTyped = type !== "comment"`). Unknown type → comment meta / `dot` icon fallback (keep tolerant). Writers by surface: task-detail writes `comment/assign/blocked/transition/completion`; operator/agents/system write `github/policy/quality/agent/transition/blocked/completion`; run interrupt is **not** a sixth typed kind (audit + operator note instead, per runs §5.1).

Activity feed folds `title` into text as `**{title}.** {text}`. Actor identity is denormalized on the event (snapshot), keyed by user/profile id for joins — events must survive member removal.

### 1.4 Rich text micro-format

Regex-level contract, NOT a markdown library: `(\*\*[^*]+\*\*|`[^`]+`|@[A-Za-z][\w-]*)` → `<strong>`, `<code class="mono">`, `<span class="mention">`. Two mock variants exist — `RichText` (task.jsx, handles @mentions) and `RichA` (activity.jsx, bold+code only, reused by notifications). **Port ONE shared renderer** with mention support optional per call site. Popovers/sublines strip instead of render: `plain(s) = s.replace(/\*\*/g,"").replace(/`/g,"")` (duplicated ×3 in the mock — one shared helper).

---

## 2. Readiness / waiting / validation / run-state enums as the UI uses them

### 2.1 Readiness — THE naming split (see §7 #1)

| Canonical (CONVENTIONS, storage) | Mock key = pill CSS class | User-visible label |
|---|---|---|
| `ready` | `ready` | ready |
| `input_required` | `input` | input required |
| `inconsistency_risk_detected` | `risk` | inconsistency risk |
| `blocked` | `blocked` | blocked |
| *(not a readiness value — display state)* | `done` | accepted |

- Storage/Zod/derivation (`readiness-policy.server.ts`) use ONLY the 4 canonical values.
- The mock's 5th value `done` ("accepted") appears on done-stage tasks; model it as a derived display state (stage === done / completion accepted), not a stored readiness value. `ReadinessPill` accepts canonical enum + the accepted state and translates to mock CSS kinds internally. Never put long enum values in class names.
- Unknown readiness → `ready` pill fallback; `risk` and `blocked` are defined-but-unused in seed tasks (keep in schema; readiness derivation sets them: parse/inconsistency findings → risk, packet-hold decisions → blocked).

### 2.2 Waiting (secondary signal): `human | agent | none`. Drives board wait tags ("waiting on you" / "agent working"), review-queue panel split ("your acceptance" copy — deliberately different from board), rail/header counts, agents-view deployment statuses. `review + none` lands in "Still with agents" (mock behavior — port 1:1, flag).

### 2.3 Validation: `healthy | changed | failing | none` → pill kinds `ready | input | blocked | neutral`, labels "validation healthy / evidence changed / validation failing / no validation". Unknown → `none`. Never dotted. Not shown on board cards (feeds the "Needs attention" filter only: `readiness ∈ {risk, blocked} || validation === failing || urgent`).

### 2.4 Run state: mock renders `running | idle | done | error` → pill kinds `agent | neutral | done | blocked`, labels "running / idle / finished / continuity error". BUILD-PLAN lifecycle is `queued | running | finished | error | interrupted` — map `queued`→neutral "queued", `interrupted`→needs a label+footer copy decision (runs §8.3). Deployment statuses (agents view, derive server-side, display verbatim): `coordinating`, `packet open`, `working`, `waiting on human`, `on call`, `anchored · on call` → pill kinds via `statusKind` (agent/input/agent/info/neutral/neutral); dot only on working/coordinating.

### 2.5 Workflow boundaries: `auto | approval | human` per transition (`review→done` locked `human` in V1, server-enforced). Boundary UI reuses capability color classes: auto→`direct` (teal), approval→`recommend` (blue), human→`human` (coral) — deliberate, don't "fix".

---

## 3. People, roles, ownership

### 3.1 Actor identity variants (polymorphic `who`/`actor`/`from`)

```ts
type AgentActor    = { kind: "agent"; backend: "codex" | "claude"; name: "Codex" | "Claude Code"; role: string };  // role: Developer|Reviewer|Consultant
type OperatorActor = { kind: "agent"; name: "Operator" };        // NO backend, NO role — branch on operator BEFORE backend (AgentGlyph fallback renders codex!)
type HumanActor    = { kind: "human"; name; initials; tone: "" | "rose" | "teal" | "violet"; guest?: true };
type SystemActor   = { name: "Policy engine"; kind: "system" };  // only instance observed
```

`guest: true` = registered app user who is not a project member → may comment (only), renders pill "app user · not in project". Operator renders with the shield glyph (`agent-glyph op`), never a backend glyph.

### 3.2 Three separate role systems — keep them separate (VIB-139 is literally about this)

1. **Org roles** (`org.users.role`): `admin | member`. Admin = instance settings, whitelist, connections, resources, password resets.
2. **Project roles** (`policy.members.role`): `admin | maintainer | reviewer | viewer` — the 9-row RBAC grant table (canonical permission catalog, display-only in UI):

| action | admin | maintainer | reviewer | viewer |
|---|---|---|---|---|
| View board, tasks & timelines | ✓ | ✓ | ✓ | ✓ |
| Comment on tasks (app-wide) | ✓ | ✓ | ✓ | ✓ |
| Take / release task ownership | ✓ | ✓ | ✓ | ✓ |
| Release any task owner | ✓ | — | — | — |
| Approve stage transitions | ✓ | ✓ | — | — |
| Accept completion → Done | ✓ | ✓ | — | — |
| Open agent runtime sessions | ✓ | ✓ | — | — |
| Manage members & roles | ✓ | — | — | — |
| Edit workflow & policy | ✓ | — | — | — |

3. **Agent capability policy** (per profile): `direct | recommend | forbidden("human")` buckets (+ `off` in the editor). Agents never hold human roles. Always-human invariants: **Merge a pull request · Transition a task to Done · Change project policy** (server-side invariant list, not hard-coded UI strings).

⚠ CONVENTIONS says 3 roles (`admin | member | viewer`) — conflict, see §7 #2.

### 3.3 Ownership rules

- One human **owner** per task = reviewer + acceptance authority, scoped to that task.
- Any active member may take/hand-off/release ownership; **admins may release anyone** (recorded in audit trail). All ownership changes write a typed `assign` event with the exact copy in task-detail §5.2 / shell §5.2.
- All comparisons by **user id**, never display name (mock's name-matching breaks on rename — myRole, owner === me, settings self-guard all affected).
- Guards (client UX + server-enforced): can't remove self from project; can't demote/remove the last admin ("needs at least one admin — promote someone else first"); invited members join as Viewer.
- Human-only, server-enforced: transition to done / completion acceptance / PR merge. Blocked agent attempts surface as policy `blockedact` audit events + notifications.
- Operator scheduling rule (generalize the VIB-148 hack): when a quality-gated, unowned Ready task gains an owner, the **operator runtime** (not the client) flips waiting→agent and writes its own `agent` event.

### 3.4 Agents on a task

One **operator** per active task (none in triage; claude-backed orchestration runtime, `viberr-task-store` MCP); one **primary specialist**; 0..n **consultants**. Specialists get `github`+`filesystem` MCPs. Assignment records store the **profile id** (never join by `role.toLowerCase()`). Profiles: system `operator` (undeletable, spanAll) + `developer/reviewer/tester/consultant` seeds; global org templates (`gagents`) vs per-project profiles is a two-layer model (open question, agents §8.1 / org-settings §8.1).

---

## 4. Notification kinds

```ts
type Notification = {
  id: string;
  kind: "packet" | "approval" | "mention" | "quality" | "policy";
  ptype?: "input" | "blocked";     // packet only
  unread: boolean;                 // per-user read state (monotonic; no mark-unread)
  day: string; t: string;          // real: single UTC timestamp, sorted DESC (mock fixture is NOT sorted)
  from: Actor;
  task: string; project: string;   // soft refs — may point at other projects (DEP-31 "Deploy Pipeline", BIL-9 "Billing Service")
  title?: string;                  // packet + approval ONLY; mention/quality/policy are text-only
  text: string;                    // RichText bold/code (stripped in popover)
};
```

Kind → icon/color (ONE shared helper — mock duplicates it ×3): packet+blocked → `alert`/`act-blocked`; packet → `check`/`act-completion`; approval → `arrow`/`act-transition`; mention → `message`/`act-comment`; quality → `flag`/`act-quality`; policy + unknown → `alert`/`act-policy`. Page type pills: approval → info "approval"; packet blocked → blocked "blocked decision"; packet input → input "completion report".

Sources (derived from typed events, fanned out per user): packet ← operator packet raised; approval ← operator transition request at approval boundary; mention ← @mention/reply in comments; quality ← specialist quality flags on tasks you own review/acceptance; policy ← policy-engine violations + blocked agent actions.

Read state: per-user rows (`notification_reads` or `read_at` column), idempotent INSERT OR IGNORE; packet/approval resolution auto-marks that task's rows read; "Mark all read" + toast "All notifications marked read". Routing prefs (`prefs.notifs`) use **plural ids** `packets/approvals/mentions/policy/quality` mapping to the singular kinds (+ `email` booleans and `nudge {on, hours}` — schema-only for now); real fan-out must honor the `app` toggle (mock doesn't filter).

---

## 5. Shared UI primitives inventory

From `ui.jsx` → `app/ui/*` (may not import from `features/`):

| Primitive | Contract highlights |
|---|---|
| `Icon` | 41 verbatim stroke paths; `class="ico"`, `aria-hidden`, unknown→`dot`; sized by context CSS only |
| `Pill` | kinds `ready·input·risk·blocked·done·info·agent·neutral`, `sm`, `dot`→`.pdot`; kinds are CSS classes — never invent new ones |
| `ReadinessPill` | canonical enum + accepted state → mock kinds; always dotted |
| `ValidationPill` | never dotted; unknown→none |
| `AgentGlyph` | `claude`(sparkle)/`codex`(cpu, also fallback)/`op`(shield, black) — support op as first-class variant |
| `Avatar` | initials + tone `""·rose·teal·violet`; sizes md/lg/xl; missing→"?" |
| `Identity` | agent/system/human branches; exported-but-unused in mock — adopt only where markup is byte-identical |
| `PageOverlay` | scrim + dialog + Escape + X; add focus trap/restore + scroll lock in port |
| `TglP` | `role="switch"` toggle; aria-label required |
| `useToasts`/`ToastHost` | 2600 ms auto-dismiss, check icon, `role="status" aria-live="polite"`; port as ToastProvider context; success-only |
| `initialsOf` | first letters of first two words, uppercased, "?" fallback → `app/shared/initials.ts` |

Cross-surface composites (build once, reuse — the specs name their sharing explicitly):
- **RichText/RichA** unified renderer + `plain()` stripper (§1.4).
- **`ntfMeta`** notification kind→icon/class helper (§4).
- **CapabilityMatrixModal** — shared by Agents and Policy; presentational, takes `profiles`.
- **CredentialCard** (`cred-card`/`scope-chips`/`cred-warn`/`cred-ok`) — GitHub view (Fix in Settings) + Project settings (Grant scope) + Profile (personal identity) + org-settings modals; one component with a footer-action slot.
- **`rq-row` family** — Review queue rows, GitHub PR list, Notifications "Waiting on you".
- **`live-table` family** — Agents Live roster, GitHub branch table (grid override).
- **`pol-ev`/`pev-ico act-*` palette** — Activity stream, Audit logs, Notifications stream, bell popover.
- **MiniModal + ConfirmDelete** (org-settings) — dialog chrome for all org CRUD.
- **StoreBrowser** + `FolderIco`/`countKbFiles`/`prettySize` (kb-browser).
- **`keybtn`** — inline task-key/nav chip used by Activity, GitHub, Settings, Profile, Notifications.
- **`mini-seg` / `seg` / `fchip` / `pick-chip` / `cap-seg`** segmented-control families.
- **StarIco, EditIco, FolderIco/UploadIco/FolderUpIco** — local SVGs outside the Icon set; port alongside their surfaces.
- Global fix: `.spin { animation: spin 1s linear infinite }` (mock scopes it to `.store-strip` — login and kb-browser spinners silently don't spin).

Theming: `<html data-theme="dark|light" data-motion="reduce|full">`; theme cookie for SSR first paint; `system` resolved client-side via matchMedia listener. Class names and `--viberr` tokens are the contract — no Tailwind, no inline hex (stage colors from data are the sanctioned exception).

---

## 6. Navigation map (every cross-surface link observed)

```
/login ──success──▶ /            all protected routes ──no session──▶ /login (+ redirectTo)
POST /logout ──▶ /login          /auth/github|google(/callback) ──whitelist ok──▶ /

/ (home)
 ├─ project card/row ──▶ /projects/:slug/board        (mock: hard-coded single workspace — must be per-project)
 ├─ org tiles ──▶ /org/settings#{connections|users|resources}
 ├─ New-project modal ── zero connections warning ──▶ /org/settings (connections)
 ├─ bell item / notifications overlay ──▶ /projects/:slug/tasks/:key   (cross-project: real nav, NOT the prototype toast)
 ├─ #profile / #notifications deep links ──▶ /profile, /notifications (URL-addressable overlays)
 └─ user menu ──▶ /profile · theme · POST /logout

/projects/:slug (workspace shell layout)
 ├─ rail ──▶ board | review | agents | policy | github | activity | settings   (settings shows violations badge)
 ├─ brand + project-switch + user-menu "Switch project" ──▶ /
 ├─ bell item ──▶ tasks/:key (any project) · "See all" ──▶ /notifications
 ├─ crumbs (task open): "Viberr Core" + "Board" ──▶ board
 ├─ board card / column ──▶ tasks/:key
 ├─ review row ──▶ tasks/:key · policy chip ──▶ policy
 ├─ agents deploy-row / live-row ──▶ tasks/:key · matrix modal (shared w/ policy)
 ├─ policy pcap-row / "Manage profiles" ──▶ agents (should deep-link profile)
 ├─ github PR/branch rows ──▶ tasks/:key · violation keybtn ──▶ tasks/VIB-142 · "Fix in Settings" ──▶ settings(#repository)
 ├─ activity stream/audit keybtn ──▶ tasks/:key
 ├─ settings pol-notes ──▶ policy (Workflow rules · Human access) · cred-warn keybtn ──▶ tasks/:key
 └─ task detail:
     ├─ "View project policy" / PolicyPanel ──▶ policy
     ├─ packet "Block on policy" resolve ──▶ settings (action redirect) 
     ├─ GithubTrace "Open on GitHub" ──▶ external github.com link (real, not toast)
     └─ LiveRunPanel "View logs" ──▶ AgentLogsPanel selection (same page)

/profile: keybtn ──▶ /projects/:slug/policy · keybtn ──▶ /projects/:slug/settings   (needs an "active project" rule from Home)
/org/settings: back ──▶ /   (renders under Home header chrome in mock)
/notifications: rows/keybtns ──▶ /projects/:slug/tasks/:key (cross-project capable)
```

Route-map deltas vs CONVENTIONS to lock down: task route `tasks/:key` (CONVENTIONS) vs shell spec's `task/:taskKey` — **use `/projects/:slug/tasks/:key`**; `/projects/:slug` redirects to `board`; unknown task key → 404 boundary (mock crashes). SSE at `/resources/events` (per-project + per-task streams) triggers revalidation on `task.updated`, `projection.rebuilt`, `run.log-appended`.

---

## 7. Inconsistencies + recommended resolutions

Ranked roughly by blast radius. "Resolution" = what phase agents should build; deviations from the mock get documented in phase reports.

1. **Readiness value naming — mock `input`/`risk`/`done` vs canonical `input_required`/`inconsistency_risk_detected` (+ no `done`).** The mock stores and class-names short values; CONVENTIONS mandates the long enum with derivation only in `readiness-policy.server.ts`; `done`→"accepted" is a mock-only 5th value on done-stage tasks. **Resolution:** canonical 4-value enum in files/Zod/SQLite; ONE mapping module to mock pill kinds/labels (CSS classes stay `input`/`risk`/`done`); "accepted" is a derived display state of done-stage/accepted tasks, not a readiness value. Decided in Phase 3, consumed by 4/5/9.

2. **Project role model — mock 4 roles (`admin|maintainer|reviewer|viewer`, 9-row RBAC table, "joins as Viewer", approval gates on maintainer) vs CONVENTIONS 3 roles (`admin|member|viewer`).** The entire Policy/Settings/Profile UI and the boundary/notification copy ("needs a maintainer approval") are built on 4. **Resolution:** keep the mock's 4 project roles and treat CONVENTIONS' 3-role line as the org-level model (org roles are `admin|member` in the mock — consistent); document the deviation in the Phase 2 report. Collapsing maintainer+reviewer→member would rewrite the RBAC table, seeds, and copy for no product gain.

3. **Task-file path — mock renders/anchors `.viberr/tasks/<KEY>/task.md` + `.viberr/policy/` everywhere (task hero, run logs, settings KV, guardrails), BUILD-PLAN's data root is `$VIBERR_DATA_ROOT/projects/<slug>/tasks/<KEY>/task.md`.** **Resolution:** real store per BUILD-PLAN (files under `projects/<slug>/...`); the UI renders the actual store-relative path (keep the copy *pattern*, substitute the real path). Board rescan toast's ".viberr store" wording → align with the real store name. Decide once in Phase 3; all display strings follow.

4. **Timestamps are display strings** (`t:"9:41"`, `day:"Yesterday"`, `"now"`, audit `"today 9:38"`, run `finished:"Mar 30 · 17:26"`, `updated:"2m ago"`, file `added:"just now"`). **Resolution:** UTC ISO everywhere at boundaries (CONVENTIONS); one shared formatter reproducing the exact display forms (today→`H:MM`, else `{day} · {t}`; lowercased day variant on notification cards; relative for home/store). Seed script back-dates so rendering matches the mock byte-for-byte.

5. **`scopeGranted` is one client boolean feeding four surfaces** (GitHub view chips/banner, Settings card, Activity violation pill, rail badge) and force-greens *every* scope. **Resolution:** server-derived per-scope check results from the Phase 7 PAT validator + per-violation open/resolved state (violation records carry their own resolution, not a global flag); rail badge = count of open violations; `grantScope` = re-validate PAT (or accept replacement token), clear diagnostic, write the typed `policy` event to the flagged task (`scopes[].task`, not hard-coded VIB-142), audit + SSE.

6. **Identity matching by display name** — `myRole` lookup, `owner.name === me.name`, Settings self-guard (`"Arda Kaya"` hard-coded), Policy `roles[m.p.name]` keys, two divergent `me` states (workspace vs Home). **Resolution:** user id everywhere from the session/membership row; display names are render-only snapshots. Phase 2 delivers the session; Phases 4/5/9 must not port name matching.

7. **Capability policy stored as free-text labels with near-miss mismatches** (Tester "Run the validation suite" vs catalog "Run validation suites"; Reviewer "Push commits to the branch" vs "Commit & push to the branch") — the matrix modal dumps them into a big "Other actions" group; deployments join profiles by `role.toLowerCase()` string coincidence. **Resolution:** id-based capabilities (`{capabilityId, mode}`) against the shared CAP_CATALOG, display-only extras for bespoke labels (operator actions); profile-id FK on task assignments. Normalize exact matches at seed time, keep near-misses as extras pending product sign-off (agents §8.3).

8. **Packet/option dispatch by English title string** (`option.t === "Block on policy"`) and the accept path's instant `pr.state = "merged"`. **Resolution:** stable option `kind` enum (§1.2); accept-completion triggers a real (async, failable) merge via Phase 7 — the VIB-142 PAT-scope flag is exactly the failure case; design the async/failure state (task-detail §8.10).

9. **BUILD-PLAN Phase 5 says "Port task.jsx + tweaks-panel.jsx" but the tweaks-panel spec's verdict is DO NOT PORT** (dead code, omelette dev harness, `@ds-adherence-ignore`). **Resolution:** exclude; note the exclusion in the Phase 5 report so the discrepancy with BUILD-PLAN is on record. Likewise `review.jsx`: Phase 5 mentions "review.jsx-related pieces" while Phase 9 lists the Review queue — split as: packet/acceptance mechanics in Phase 5, the queue surface in Phase 9. CONVENTIONS' `features/` list also omits `review/` — add `app/features/review/`.

10. **Notification fixture order is not time-sorted** (splices put 10:12 above 9:41, 8:47 above 9:12) and cross-project rows reference projects/tasks that don't exist (DEP-31 "Deploy Pipeline", BIL-9 "Billing Service"); the popover dead-ends cross-project clicks with a prototype toast. **Resolution:** sort by real timestamp DESC; store task/project as soft refs (string key + slug/name, no FK); real navigation to other projects (seed stub projects or accept 404-guarded links — recommend soft refs + seeding two stub projects so the demo inbox works).

11. **"Waiting on you / your acceptance" is project-wide, not per-user** — board filter is `waiting === "human"` (any human), review queue lists everyone's review tasks, home cards say "N waiting on you". **Resolution:** product call needed before the loaders are written; recommended: keep project-wide behavior for V1 (matches "X of Y" copy and boundary framing) and revisit per-user scoping; do not silently change the labels.

12. **Run lifecycle mismatch** — mock renders 4 states, BUILD-PLAN specifies `queued/running/finished/error/interrupted`; interrupt has no mock UI beyond a stub toast; token/elapsed counters are fabricated (`tick*42`). **Resolution:** map queued→neutral "queued", author "interrupted" copy at port time; elapsed derived from `startedAt`, tokens from real usage envelopes; store raw NDJSON/JSONL as truth and derive the display LogLine projection (invert the mock's `rawLine`).

13. **`pr.state` only knows `review|merged`; sync pill derives "behind main" from `validation === "failing"`.** Real GitHub has open/draft/closed-unmerged and real ahead/behind counts. **Resolution (Phase 7):** map merged→done, open/draft→"in review"/info, closed-unmerged→pick a rendering (suggest risk "closed") and document; sync from real compare data captured at reconcile, precedence merged > behind > synced.

14. **Prefs contain derived/dead state** — `ghConnected` duplicates real connection state (drop; derive from PAT/identity rows), `nudge` + per-kind `email` booleans have no UI/mailer (keep schema-only), `ProfileAppearance` is built but unmounted (recommend mounting it), pref kind ids are plural vs singular notification kinds (keep both, map explicitly).

15. **Duplicated helpers and copy divergence risks** — 3× notification meta, 2× markdown stripper, 2 rich-text renderers, 2 cred-cards, bell popover markup duplicated across shells, board "waiting on you" vs review "your acceptance" (intentional — do NOT unify copy, share the component parameterized). **Resolution:** single shared modules per §5; treat all §4/§5 toast and empty-state strings across specs as copy contract, verbatim.

16. **Stage catalog scope** — stages are per-project (editable in Settings; home StageMeter must use each project's own list; light template = 3 undefined stages) but org-level AgentModal needs an instance stage list, and stage colors mix hex (seeds) with `var(--*)` strings (editor-added). **Resolution:** per-project stages in the project file; define an instance-default workflow for org surfaces + the "Lightweight · 3 stages" template before Phase 4's create-project action; accept both color string forms as inline backgrounds.

17. **Minor but load-bearing quirks to decide deliberately** (each flagged in its spec): board rail count includes Done tasks; `.card.urgent` has no visual treatment; list view has no empty state; login's 4-char password minimum + "2828" seed + account-enumeration copy; `operator.since` (`"stage 1"`) semantics undefined; `data-screen-label` attributes keep-or-drop must be one app-wide decision; Escape/focus-trap gaps on nearly every mock dialog (add per CONVENTIONS without changing markup).
