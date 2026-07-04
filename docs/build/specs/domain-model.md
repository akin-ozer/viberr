# Domain Model Spec — `design/html-app/app/data.js`

Porting specification for the Viberr mock's canonical data module. This is the **domain-model source of truth**: every entity shape, every enum value observed, and the full inventory of seed records. Later phases build the SQLite schemas, `task.md` frontmatter, and the seed script **from this document alone** — the porting engineer will not read the mock file.

Cross-referenced files (read for contracts consumed here):
- `design/html-app/app/ui.jsx` — enum→pill label contracts (`READINESS`, `VALIDATION`), `Identity`/`Avatar`/`AgentGlyph` rendering of actor shapes, prefs init.
- `design/html-app/app/runs.jsx` — `RUN_STATE` labels, raw wire-format reconstruction of log lines.
- `design/html-app/app/task.jsx` — `EVENT_META`/`typedKind` timeline event contracts, `DecisionPacket` packet contract.
- `design/html-app/app/org-settings.jsx` — `ORG_DEFAULTS` (org users, KBs, MCPs, skills, global agents) + `loadOrg`/`saveOrg`.
- `design/html-app/app/login.jsx` — session record shape, local-account password store.
- `design/html-app/app/main.jsx` — how the globals are consumed/mutated at runtime.

---

## 1. Purpose & entry points

`data.js` is a **plain (non-JSX) script** loaded before all Babel-compiled app scripts. It is an IIFE that:

1. Defines all seed data (stages, tasks, runtime runs, agent profiles, policy, notifications, people).
2. Publishes everything on **`window.VIBERR`** (the app-wide global every other script reads).
3. Applies persisted **notification read-state** from `localStorage["viberr:notifs:read"]` onto the seed notifications at load time.
4. Exposes three impure helpers on the global: `session.get/set/clear` (localStorage `"viberr:session"`) and `markNotifsRead(ids)`.

The full export surface:

```js
window.VIBERR = {
  project: { name: "Viberr Core", repo: "akin-ozer/viberr", members: 4 },
  stages:        STAGES,          // Array<Stage>
  tasks:         TASKS,           // Array<Task> (10 records)
  runtime:       RUNTIME,         // { [taskKey]: Array<Run> } (8 keys, 18 runs)
  people:        { ARDA, ELIF, MURAT, SELIN, DENIZ },
  agents:        AGENTS,          // { operator: AgentProfile, profiles: AgentProfile[4] }
  policy:        POLICY,
  notifications: NOTIFICATIONS,   // Array<Notification> (10 records after splices)
  session:       { get(), set(s), clear() },       // localStorage "viberr:session"
  markNotifsRead(ids),                             // localStorage "viberr:notifs:read"
};
```

`ui.jsx` later **augments the same global** with `window.VIBERR.prefs` and `window.VIBERR.savePrefs(patch)` (localStorage `"viberr:prefs"`). `org-settings.jsx` exports `ORG_DEFAULTS`, `loadOrg()`, `saveOrg(org)` on `window` (localStorage `"viberr:org:v10"`). These are documented here because they complete the domain model.

In the real app, **none of this is a global**: each slice becomes a loader-provided projection (SQLite query or file read), the session becomes a server cookie session, and localStorage persistence becomes real per-user rows.

---

## 2. Component tree

`data.js` renders nothing — it defines data + three helper closures. The relevant "components" are the **shape-builder functions**, which are the constructors the seed script must reproduce:

| Builder | One-liner |
|---|---|
| `codex(role)` | Agent identity `{ kind:"agent", backend:"codex", name:"Codex", role }` |
| `claude(role)` | Agent identity `{ kind:"agent", backend:"claude", name:"Claude Code", role }` |
| `human(name, initials, tone)` | Human identity `{ kind:"human", name, initials, tone }` |
| `cc.*` (init/text/tool/out/err/res) | Claude Agent SDK stream-json display log line builders |
| `cx.*` (start/turn/think/exec/out/msg/diff/done) | Codex SDK `runStreamed()` ThreadEvent display log line builders |
| `OP` | The operator agent identity constant `{ kind:"agent", name:"Operator" }` (note: **no `backend`** field) |
| IIFE `initPrefs()` (in ui.jsx) | Loads/merges/persists per-device prefs and applies theme/motion to `<html data-theme data-motion>` |

Rendering contracts that give the enums meaning (defined in `ui.jsx`/`runs.jsx`/`task.jsx`, consumed everywhere):

| Contract | One-liner |
|---|---|
| `READINESS` (ui.jsx) | readiness enum → pill kind + user-visible label |
| `VALIDATION` (ui.jsx) | validation enum → pill kind + user-visible label |
| `RUN_STATE` (runs.jsx) | run state enum → pill kind + label |
| `EVENT_META` + `typedKind` (task.jsx) | timeline event type → node class, icon, label, pill kind |
| `Identity` (ui.jsx) | dispatches on `who.kind` = `"agent" \| "system" \| (human)` |

---

## 3. Data consumed — exact shapes

### 3.1 Stage (`STAGES`)

```ts
type Stage = { id: string; name: string; color: string /* hex */ };
```

Seed (order matters — this is board column order and workflow order):

| id | name | color |
|---|---|---|
| `triage` | Triage | `#a5a8b5` |
| `ready` | Ready | `#187574` |
| `impl` | In Progress | `#7b61ff` |
| `review` | Review | `#5b76fe` |
| `done` | Done | `#00b473` |

Real app: per-project `stages` table (or ordered JSON column on the project). `main.jsx` **mutates** `window.VIBERR.stages` when the user reorders/renames stages in Settings, so the real app needs a stage-update action.

### 3.2 Actor identities (the polymorphic `who`/`actor`/`from` shape)

Four variants appear throughout tasks, timelines, runtime, and notifications. `Identity` in ui.jsx dispatches on `kind`:

```ts
type AgentActor  = { kind: "agent"; backend: "codex" | "claude"; name: "Codex" | "Claude Code"; role: string };
type OperatorActor = { kind: "agent"; name: "Operator" };            // NO backend, NO role
type HumanActor  = { kind: "human"; name: string; initials: string; tone: "" | "rose" | "teal" | "violet"; guest?: true };
type SystemActor = { name: "Policy engine"; kind: "system" };        // only instance observed
```

- Agent `role` values observed: `"Developer"`, `"Reviewer"`, `"Consultant"`.
- `OperatorActor` is rendered with the shield glyph (`agent-glyph op` in runs.jsx `RunGlyph`, because the run has `op: true`; in timelines it renders through `Identity` as a plain agent chip). It appears in timelines as `{ name: "Operator", kind: "agent" }`.
- One timeline literal uses `{ name: "Operator", kind: "agent" }` inline; RUNTIME uses the shared `OP` constant — same shape.
- `HumanActor.tone` selects the avatar color class (`avatar rose|teal|violet`; `""` = default). `guest: true` marks an app user who is **not a member of this project** — may comment, nothing else (renders pill `app user · not in project` in timeline).

### 3.3 People (`window.VIBERR.people`)

| const | name | initials | tone | guest | project role (POLICY.members) | org role (ORG_DEFAULTS.users) | email |
|---|---|---|---|---|---|---|---|
| `ARDA` | Arda Kaya | AK | `""` | — | admin | admin (`you: true`, idp `local`) | arda@viberr.dev |
| `ELIF` | Elif Demir | ED | rose | — | admin | admin (idp `github`) | elif@viberr.dev |
| `MURAT` | Murat Yıldız | MY | teal | — | maintainer | member (idp `google`) | murat@viberr.dev |
| `SELIN` | Selin Aksoy | SA | violet | — | reviewer | member (idp `local`) | selin@viberr.dev |
| `DENIZ` | Deniz Şahin | DŞ | `""` | **true** | — (not a member) | — (not in org seed) | — |

`DENIZ` is built as `{ ...human("Deniz Şahin", "DŞ", ""), guest: true }`. Note the non-ASCII initials `DŞ`. **Arda is the signed-in user** everywhere in the mock.

### 3.4 Task (`TASKS`)

```ts
type Task = {
  key: string;                     // "VIB-<n>" — primary key, also branch/PR prefix
  title: string;
  stage: StageId;                  // "triage" | "ready" | "impl" | "review" | "done"
  goal: string;                    // one-paragraph goal statement
  readiness: "input" | "ready" | "done";   // (enum also defines "risk" | "blocked" — see §3.10)
  specialist: AgentActor | null;   // primary specialist identity
  owner: HumanActor | null;        // human acceptance authority
  operator: { name: "Operator"; since: string } | null;  // since: "stage 1" | "stage 2" | "stage 3"
  consultants: AgentActor[];       // 0..1 observed
  waiting: "human" | "agent" | "none";
  urgent?: boolean;                // true only on VIB-142; ABSENT (undefined) on VIB-139/VIB-141
  validation: "healthy" | "changed" | "failing" | "none";
  branch: string | null;           // "vib-<n>-<slug>"
  repo: string;                    // always "akin-ozer/viberr"
  pr: { number: number; state: "review" | "merged"; title: string } | null;
  commits?: Array<{ sha: string; msg: string }>;          // only VIB-142
  changed?: { files: number; add: number; del: number };  // only VIB-142
  packet?: Packet;                 // only VIB-142 (input) and VIB-160 (blocked)
  timeline: TimelineEvent[];       // newest-first
};
```

Real-app sourcing: task scalar fields → `task.md` frontmatter in `.viberr/tasks/<KEY>/task.md` (the mock's runtime logs literally anchor on `".viberr/tasks/VIB-151/task.md"` etc.); `timeline` → append-only typed event log (file-native, projected into SQLite for querying); `pr`/`commits`/`changed`/`branch` → GitHub projection (cached in SQLite, **GitHub is not the source of truth** — the canonical file is); `packet` → the newest unresolved operator packet (a projection over typed events, or its own record resolved/cleared by decision actions).

### 3.5 Packet (operator decision packet)

```ts
type Packet = {
  type: "input" | "blocked";       // drives card styling: "packet input" | "packet blocked"
  kind: string;                    // pill label: "Completion report" | "Blocked decision"
  from: "Operator";
  title: string;                   // headline question
  body: string;                    // plain paragraph
  observations: Array<{ k: string; v: string; code: boolean }>;  // k: "Observed"|"Changed"|"Validation"|"Branch"|"Flag"
  options: Array<{
    t: string;                     // option title
    d: string;                     // option description
    rec: boolean;                  // exactly one true per packet — "operator pick"
    accept?: true;                 // marks the completion-acceptance option (VIB-142 opt 1 only)
    ev?: string;                   // markdown-ish text of the typed timeline event written if chosen
  }>;
};
```

`observations[].code === true` renders `v` in `<code>`. `options[].ev` is the exact text appended to the timeline as a `transition`-type event when that option is confirmed (see §5). Options without `ev` get a generated fallback or bespoke handling in `main.jsx`.

### 3.6 TimelineEvent

```ts
type TimelineEvent = {
  type: "comment" | "completion" | "github" | "policy" | "quality"
      | "transition" | "blocked" | "agent" | "assign";
  actor: AgentActor | OperatorActor | HumanActor | SystemActor;
  t: string;                       // clock "H:MM" (or "now" for events written at runtime)
  day?: string;                    // absent = today; "Yesterday" | "Mar 30" observed
  text: string;                    // rich text: **bold**, `code`, @mentions (see RichText, §6)
  title?: string;                  // only on type "completion" ("Completion report" | "Completion accepted")
  evidence?: Array<{ label: string; add: string; del: string }>;  // only on completion; add/del are display strings ("+14", "0", "−4")
  to?: "agent" | null;             // only on comments; "agent" = directed at the operator (renders comment-card toagent)
};
```

The five **typed important events** of the product spec map to types `quality`, `transition`, `blocked`, `completion`, `policy`. Types `github`, `agent`, `assign` are additional system/coordination events; `comment` is the only non-typed event (`isTyped = ev.type !== "comment"`).

Display contract (task.jsx — the seed data must keep satisfying it):

| type | tl-node class | icon | pill label | pill kind (`typedKind`) |
|---|---|---|---|---|
| comment | `""` (plain) | message | *(no pill; "commented")* | — |
| completion | `completion` | check | Completion report | `done` |
| github | `github` | github | GitHub | `neutral` |
| policy | `policy` | shield | Policy violation | `input` |
| quality | `quality` | flag | Quality flag | `risk` |
| transition | `transition` | arrow | Transition request | `info` |
| blocked | `blocked` | alert | Blocked decision | `blocked` |
| agent | `agent` | agents | Operator | `agent` |
| assign | `transition` | user | Ownership | `info` |

### 3.7 Task seed inventory (all 10)

| key | title | stage | readiness | waiting | validation | urgent | owner | specialist | consultants | operator.since | branch | pr | packet |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| VIB-142 | Attach execution workspace to task runtime | review | input | human | changed | **true** | ARDA | codex Developer | claude Reviewer | stage 1 | `vib-142-attach-workspace` | #318 review "Attach execution workspace" | input / Completion report |
| VIB-148 | Validate PAT scope before GitHub sync | ready | input | human | none | false | null | null | — | stage 1 | null | null | — |
| VIB-151 | Compress long-running task timelines | impl | ready | agent | healthy | false | SELIN | claude Developer | codex Consultant | stage 2 | `vib-151-timeline-compression` | null | — |
| VIB-153 | Operator brevity guardrail for packets | impl | ready | agent | healthy | false | null | codex Developer | — | stage 2 | `vib-153-operator-brevity` | null | — |
| VIB-160 | Rehydrate specialist from canonical file | impl | input | human | failing | false | MURAT | claude Developer | codex Consultant | stage 3 | `vib-160-rehydrate` | null | blocked / Blocked decision |
| VIB-145 | Board card SSE revalidation | review | ready | agent | healthy | false | null | codex Developer | — | stage 2 | `vib-145-sse-revalidate` | #311 review "SSE board revalidation" | — |
| VIB-139 | Separate human RBAC from agent capability policy | done | done | none | healthy | *(absent)* | ELIF | null | — | stage 1 | `vib-139-policy-split` | #298 merged "Policy split" | — |
| VIB-141 | Typed important-event schema | done | done | none | healthy | *(absent)* | MURAT | codex Developer | — | stage 1 | `vib-141-typed-events` | #287 merged "Typed events" | — |
| VIB-166 | Manual re-scan & state reconciliation | triage | input | human | none | false | null | null | — | **null** | null | null | — |
| VIB-168 | Agent profile templates (eligible stages) | triage | input | human | none | false | null | null | — | **null** | null | null | — |

One-line goals (verbatim, for the seed script):

- **VIB-142**: "Let the operator attach a single GitHub repo to a task, create the task-key branch, and reflect branch + PR state back into the canonical task file without treating GitHub as the source of truth."
- **VIB-148**: "Pre-flight the project's GitHub credential against required scopes and surface a typed policy event if anything is missing, before any branch is created."
- **VIB-151**: "Apply the compression threshold so long task histories stay readable: collapse routine chatter, keep typed important events, preserve continuity for re-anchoring."
- **VIB-153**: "Constrain operator packets to observed → changed → recommended → decision, rejecting verbose or duplicated summaries."
- **VIB-160**: "When provider-side runtime history is unavailable, continue specialist work from the canonical task file and record a continuity warning instead of failing."
- **VIB-145**: "Push task-state changes to all connected users within 5 seconds using server-sent events and route-local revalidation."
- **VIB-139**: "Model human roles and agent capabilities as two distinct policy surfaces so managing people and managing agents never collide."
- **VIB-141**: "Define the five typed events — quality flag, transition request, blocked decision, completion report, policy violation — as first-class records."
- **VIB-166**: "Give users a manual re-scan action that reconciles the file-native store when automated change detection misses a directly-edited task file."
- **VIB-168**: "Reusable agent profiles defining eligible stages, permitted actions, context resources, and backend — global base with per-project overrides."

VIB-142 extras:

```js
commits: [
  { sha: "a91f7c2", msg: "[VIB-142] add repo attach policy gate" },
  { sha: "4ce0b18", msg: "[VIB-142] branch reconciler + task projection" },
  { sha: "12dd9af", msg: "[VIB-142] tests for PR sync boundary" },
],
changed: { files: 9, add: 412, del: 87 },
```

### 3.8 Packet seeds (verbatim)

**VIB-142** — `type: "input"`, `kind: "Completion report"`, `from: "Operator"`:

- title: `"Accept completion, or send back for one fix?"`
- body: `"The developer specialist reports the workspace attach flow is implemented and the review PR is open. All requested files changed and validation evidence is attached — but the PAT used in the run is missing `pull_request:write`, so PR status can't auto-sync after merge. Completion still requires explicit human acceptance."`
- observations:
  - `{ k: "Changed",    v: "9 files · +412 / −87", code: true }`
  - `{ k: "Validation", v: "unit + integration green; 1 snapshot updated", code: false }`
  - `{ k: "Branch",     v: "vib-142-attach-workspace · synced", code: true }`
  - `{ k: "Flag",       v: "PAT scope missing pull_request:write", code: false }`
- options:
  1. `{ t: "Accept completion", d: "Mark task done and merge the review PR. Human-authorized.", rec: true, accept: true }`
  2. `{ t: "Request one edit", d: "Ask the developer to widen PAT scope before acceptance.", rec: false, ev: "**Decision:** request one edit. Developer widens the PAT scope, then the completion report returns for acceptance." }`
  3. `{ t: "Block on policy", d: "Hold until Elif updates the project credential policy.", rec: false }`

**VIB-160** — `type: "blocked"`, `kind: "Blocked decision"`, `from: "Operator"`:

- title: `"Continuity degraded — pick a recovery path"`
- body: `"Provider-side history for the Developer thread is unavailable. The specialist was rehydrated from the canonical task file and can continue safely, but two rehydrate-path checks are failing and the earlier direction may be stale."`
- observations:
  - `{ k: "Observed",   v: "provider session 404 · thread claude-dev-160", code: true }`
  - `{ k: "Changed",    v: "specialist rehydrated from task.md · continuity warning recorded", code: false }`
  - `{ k: "Validation", v: "2 rehydrate-path checks failing", code: false }`
  - `{ k: "Branch",     v: "vib-160-rehydrate · 2 commits behind main", code: true }`
- options:
  1. `{ t: "Resume rehydrated thread", d: "Continue from canonical state; re-run the failing checks before any new commits.", rec: true, ev: "**Decision:** resume the rehydrated thread. Operator re-anchors Claude Code (Developer) on `task.md` and re-runs the failing checks before new commits." }`
  2. `{ t: "Start a fresh specialist", d: "Retire the degraded thread; a new Developer anchors on task.md.", rec: false, ev: "**Decision:** start a fresh specialist. The degraded thread is retired and a new Developer thread anchors on the canonical file." }`
  3. `{ t: "Hold for runtime debug", d: "Keep the task blocked while the provider-native session is inspected.", rec: false }`

### 3.9 Timeline seeds (every event, newest-first, verbatim text)

**VIB-142** (9 events):

| type | actor | day/t | title/extra | text |
|---|---|---|---|---|
| comment | ARDA | 9:58 | `to: "agent"` | `@operator if the PAT scope is the only blocker, let's widen it rather than block the whole task.` |
| completion | codex Developer | 9:41 | title `Completion report`; evidence `[{label:"unit/policy_gate_test",add:"+14",del:"0"},{label:"integration/pr_sync_test",add:"+38",del:"−4"}]` | `Implemented repo attach, branch creation, and PR-sync projection. Validation green except one snapshot intentionally updated.` |
| github | codex Developer | 9:39 | | ``Opened **PR #318** from `vib-142-attach-workspace` into `main`.`` |
| policy | Policy engine (system) | 9:38 | | ``**Policy violation:** active PAT is missing `pull_request:write`. Auto-sync after merge will fail.`` |
| quality | claude Reviewer | 9:20 | | ``**Quality flag:** snapshot `task_projection.json` changed — confirm the new compact shape is intended before review.`` |
| transition | Operator (agent) | 9:02 | | `**Transition request:** move VIB-142 from In Progress to Review. Branch healthy, evidence attached.` |
| agent | Operator (agent) | 8:30 | | ``Re-engaged **Claude Code (Reviewer)** as consultant; re-anchored on `task.md` before review.`` |
| comment | codex Developer | 8:12 | | `Branch work complete. Handing back to operator for the review boundary.` |
| assign | ARDA | Yesterday 15:12 | | `Took task ownership — owner is the human reviewer and acceptance authority for this task.` |

**VIB-148** (2 events):

| type | actor | day/t | text |
|---|---|---|---|
| agent | Operator (agent) | 8:36 | `**Quality gate:** goal and scope are executable. Waiting on a human owner for the acceptance boundary before execution is scheduled.` |
| comment | ELIF | 8:20 | `Scoped the pre-flight checks. Needs an owner on the acceptance gate before any branch is created.` |

**VIB-151** (5 events):

| type | actor | day/t | text |
|---|---|---|---|
| comment | claude Developer | 10:24 | `Threshold sweep running against the 40-event fixture. Typed events survive every compression pass so far.` |
| agent | Operator (agent) | 9:47 | ``Re-anchored **Codex (Consultant)** on `task.md` for a second opinion on threshold defaults.`` |
| github | claude Developer | 9:31 | ``Pushed 2 commits to `vib-151-timeline-compression` — compaction map and threshold config.`` |
| assign | SELIN | Yesterday 14:20 | `Took task ownership ahead of the review boundary.` |
| agent | Operator (agent) | Yesterday 14:05 | ``Assigned **Claude Code (Developer)** as primary specialist — branch `vib-151-timeline-compression` created.`` |

**VIB-153** (3 events):

| type | actor | day/t | text |
|---|---|---|---|
| comment | DENIZ (guest) | 10:12 | `Following from the platform team — this packet budget will matter for our ops rollout too.` |
| comment | codex Developer | 10:02 | `Brevity linter drafted — packets past the length budget bounce back to the operator with a diff of what to cut.` |
| agent | Operator (agent) | 8:58 | ``Assigned **Codex (Developer)** as primary specialist — branch `vib-153-operator-brevity` created.`` |

**VIB-160** (6 events):

| type | actor | day/t | text |
|---|---|---|---|
| blocked | Operator (agent) | 10:31 | `**Blocked decision:** provider history unavailable and two rehydrate checks failing — recovery packet raised for human review.` |
| quality | codex Consultant | 10:18 | `**Quality flag:** the rehydrate path drops evidence references recorded before the continuity break.` |
| agent | Operator (agent) | 10:05 | `**Continuity warning:** runtime history unavailable — re-anchored **Claude Code (Developer)** on the canonical task file.` |
| github | claude Developer | 9:52 | ``Pushed `vib-160-rehydrate` — recovery shim and continuity marker.`` |
| quality | codex Consultant | Yesterday 12:10 | `**Validation failing** on the rehydrate path — evidence attached, re-run requested.` |
| comment | MURAT | Yesterday 11:20 | `Opened the Developer runtime session to debug continuity — session recorded per audit policy.` |

**VIB-145** (3 events):

| type | actor | day/t | text |
|---|---|---|---|
| transition | Operator (agent) | 9:12 | `**Transition request:** move VIB-145 from In Progress to Review — SSE fan-out demo recorded, evidence attached.` |
| comment | codex Developer | 8:51 | `Review build is green across the three desktop browser targets. Reviewer thread can start on the diff.` |
| github | codex Developer | Yesterday 16:40 | ``Opened **PR #311** from `vib-145-sse-revalidate` into `main`.`` |

**VIB-139** (2 events):

| type | actor | day/t | title | text |
|---|---|---|---|---|
| completion | ELIF | Mar 30 17:26 | `Completion accepted` | `Human acceptance recorded — **PR #298** merged. Human RBAC and agent capability are now separate policy surfaces.` |
| transition | Operator (agent) | Mar 30 17:10 | | `**Transition request:** move VIB-139 from Review to Done — both policy surfaces validated.` |

**VIB-141** (2 events):

| type | actor | day/t | text |
|---|---|---|---|
| github | MURAT | Mar 30 15:02 | `Merged **PR #287** — the typed important-event schema is live.` |
| quality | claude Reviewer | Mar 30 14:31 | `**Quality flag resolved:** typed payloads carry actor identity and task references.` |

**VIB-166**, **VIB-168**: `timeline: []` (empty — triage tasks with no operator yet).

### 3.10 Enum → label contracts (ui.jsx — the CSS/pill contract)

```ts
// READINESS (ui.jsx). NOTE: "risk" and "blocked" are defined but UNUSED in seed tasks.
READINESS = {
  ready:   { kind: "ready",   label: "ready" },
  input:   { kind: "input",   label: "input required" },
  risk:    { kind: "risk",    label: "inconsistency risk" },
  blocked: { kind: "blocked", label: "blocked" },
  done:    { kind: "done",    label: "accepted" },
};
// VALIDATION (ui.jsx)
VALIDATION = {
  healthy: { kind: "ready",   label: "validation healthy" },
  changed: { kind: "input",   label: "evidence changed" },
  failing: { kind: "blocked", label: "validation failing" },
  none:    { kind: "neutral", label: "no validation" },
};
// RUN_STATE (runs.jsx)
RUN_STATE = {
  running: { kind: "agent",   label: "running" },
  idle:    { kind: "neutral", label: "idle" },
  done:    { kind: "done",    label: "finished" },
  error:   { kind: "blocked", label: "continuity error" },
};
```

`kind` becomes a class on `.pill` (e.g. `pill input sm`); fallbacks: unknown readiness → `ready`, unknown validation → `none`.

### 3.11 Run (`RUNTIME` — agent runtime threads per task)

`RUNTIME` is keyed by task key. **8 keys** (`VIB-142, VIB-151, VIB-153, VIB-160, VIB-145, VIB-148, VIB-139, VIB-141`); VIB-166/VIB-168 have **no** runtime entry (consumers must handle missing keys). **18 runs total.**

```ts
type Run = {
  id: "op" | "primary" | "c0";     // stable within a task; "c0" = first consultant
  op?: true;                       // marks the operator run (shield glyph, viberr-task-store MCP)
  role: "Operator" | "Primary specialist" | "Consultant";
  who: AgentActor | OperatorActor; // OP constant for operator runs
  backend: "claude" | "codex";
  sdk: "Claude Agent SDK" | "Codex SDK";
  model: "claude-sonnet-4-5" | "gpt-5.4-codex";
  sid: string;                     // session/thread id — UUID-like for claude, "0199…" uuidv7-like for codex
  state: "running" | "idle" | "done" | "error";
  phase?: string;                  // present on running + idle runs — human status line
  step?: string;                   // present on running runs — current tool step, monospace ("Bash · npm test -- --filter=long-fixture")
  started?: string;                // running runs — clock string
  elapsed?: number;                // running runs — seconds at page load (UI adds a live ticker: elapsed + tick, tokens + tick*42)
  finished?: string;               // done/error runs — "9:41" or "Mar 30 · 17:26"
  turns: number;
  tokens: number;
  lines: LogLine[];                // already-streamed lines
  live?: LogLine[];                // running runs only — lines replayed one-per-1200ms to fake streaming
};
```

#### LogLine variants

Common: `{ t: "HH:MM:SS", ev: string, tag: string, text: string }`. `ev` is the renderer switch; `tag` is the displayed wire-format label. All builders and resulting extras:

**Claude Code (`cc`, mirrors `claude -p --output-format stream-json` NDJSON):**

| builder | ev | tag | extra fields |
|---|---|---|---|
| `cc.init(t, s)` | `init` | `system·init` | — |
| `cc.text(t, s)` | `text` | `assistant` | — |
| `cc.tool(t, n, s, input)` | `tool` | `tool_use` | `name: n` (e.g. `"Bash"`, `"Read"`, `"Grep"`, `"Edit"`), `input: object \| null` (e.g. `{ file_path }`, `{ pattern, path }`) |
| `cc.out(t, s)` | `out` | `tool_result` | — |
| `cc.err(t, s)` | `err` | `tool_result` | `isError: true` |
| `cc.res(t, s, stats)` | `result` | `result` | `stats: { dur, api, turns, cost, in, cached, out, subtype? } \| null` (ms, ms, n, USD, tokens×3; `subtype: "error_during_execution"` on the VIB-160 error run) |

**Codex SDK (`cx`, mirrors `thread.runStreamed()` JSONL ThreadEvents):**

| builder | ev | tag | extra fields |
|---|---|---|---|
| `cx.start(t, s)` | `init` | `thread.started` | — |
| `cx.turn(t, s)` | `meta` | `turn.started` | — |
| `cx.think(t, s)` | `think` | `reasoning` | — |
| `cx.exec(t, s)` | `tool` | `command_execution` | `name: "exec"` |
| `cx.out(t, s, exit)` | `out` if exit falsy, `err` if truthy | `aggregated_output` | `exit: number` (default 0) |
| `cx.msg(t, s)` | `text` | `agent_message` | — |
| `cx.diff(t, s, changes)` | `diff` | `file_change` | `changes: Array<{ path: string; kind: "add" \| "update" }> \| null` |
| `cx.done(t, s, usage)` | `result` | `turn.completed` | `usage: { input_tokens, cached_input_tokens, output_tokens } \| null` |

Full `ev` enum across both: `init | text | tool | out | err | result | meta | think | diff`.

**Raw-mode reconstruction:** `runs.jsx#rawLine()` deterministically re-synthesizes full NDJSON/JSONL wire envelopes from these display lines (fake `msg_01…`/`toolu_01…`/`item_N` ids hashed from `sid`, claude `system.init` envelope with `cwd:"/work/viberr"`, `permissionMode:"acceptEdits"`, tools list `["Task","Bash","Glob","Grep","Read","Edit","Write","WebFetch","TodoWrite"]`, MCP servers `viberr-task-store` for op runs / `github`+`filesystem` for others; `out/err` lines attach to the **most recent preceding `tool` line** via `lastToolIdx`). In the real app this inverts: **store the raw NDJSON/JSONL as the source of truth** (file-native evidence log per run) and derive the display `LogLine` projection from it.

#### Run inventory (all 18)

| task | id | role | who | backend/model | sid | state | phase / step / times | turns | tokens |
|---|---|---|---|---|---|---|---|---|---|
| VIB-142 | op | Operator | OP | claude / claude-sonnet-4-5 | `e4b8a1c2-0142-4d6f-9a3b-7c5e8f01d442` | idle | phase "Waiting on human acceptance" | 11 | 18700 |
| VIB-142 | primary | Primary specialist | codex Developer | codex / gpt-5.4-codex | `0199a1f3-4c02-7d31-8b6e-2f41aa90c4d7` | done | finished "9:41" | 9 | 128400 |
| VIB-142 | c0 | Consultant | claude Reviewer | claude / claude-sonnet-4-5 | `a91f7c2e-8b4d-4e0a-b6c1-3d5f9e214298` | done | finished "9:20" | 4 | 41200 |
| VIB-151 | primary | Primary specialist | claude Developer | claude / claude-sonnet-4-5 | `51d8f0e2-3a7b-4c1b-9e0a-6f4d2b8c7151` | **running** | "Running validation sweep" / "Bash · npm test -- --filter=long-fixture" / started 10:18, elapsed 402 | 14 | 38400 |
| VIB-151 | c0 | Consultant | codex Consultant | codex / gpt-5.4-codex | `0199a2c4-7b31-7802-9f4e-51cb22ee8f21` | **running** | "Advisory pass on threshold defaults" / "exec · rg 'compression-threshold' .viberr/policy/" / started 10:29, elapsed 74 | 3 | 51200 |
| VIB-151 | op | Operator | OP | claude / claude-sonnet-4-5 | `b7e2c9a4-1151-4f8d-a0b3-5c6d7e8f9151` | idle | phase "Supervising — next boundary: Review" | 6 | 12100 |
| VIB-153 | primary | Primary specialist | codex Developer | codex / gpt-5.4-codex | `0199a0b8-53c9-7f10-a2d4-8e7b3c150953` | **running** | "Implementing brevity guardrail" / "exec · npm test -- --filter=brevity" / started 8:58, elapsed 5462 | 6 | 96300 |
| VIB-153 | op | Operator | OP | claude / claude-sonnet-4-5 | `c8f3d0b5-2153-4a9e-b1c4-6d7e8f0a1153` | idle | phase "Supervising — validation healthy" | 3 | 6400 |
| VIB-160 | primary | Primary specialist | claude Developer | claude / claude-sonnet-4-5 | `d9a4e1c6-3160-4b0f-92d5-7e8f9a0b2160` | **error** | finished "10:31" | 5 | 22800 |
| VIB-160 | c0 | Consultant | codex Consultant | codex / gpt-5.4-codex | `0199a29d-60aa-7433-b1c8-4d92e07f6a60` | done | finished "10:18" | 2 | 22400 |
| VIB-160 | op | Operator | OP | claude / claude-sonnet-4-5 | `e0b5f2d7-4160-4c1a-83e6-8f9a0b1c3160` | idle | phase "Blocked — waiting on human decision" | 7 | 15600 |
| VIB-145 | primary | Primary specialist | codex Developer | codex / gpt-5.4-codex | `0199a145-9e77-7b05-8c3a-6f2d81b4e145` | **running** | "Standing by on review thread" / "exec · rg 'revalidate' src/board/ -n" / started 9:14, elapsed 4820 | 12 | 88200 |
| VIB-145 | op | Operator | OP | claude / claude-sonnet-4-5 | `f1c6a3e8-5145-4d2b-94f7-9a0b1c2d4145` | idle | phase "Transition request pending approval" | 5 | 9800 |
| VIB-148 | op | Operator | OP | claude / claude-sonnet-4-5 | `a2d7e4f1-0148-4b3c-85a9-1c2d3e4f5148` | idle | phase "Waiting on a human owner" | 2 | 3100 |
| VIB-139 | op | Operator | OP | claude / claude-sonnet-4-5 | `b3c8f5a2-0139-4c4d-96b0-2d3e4f5a6139` | done | finished "Mar 30 · 17:26" | 9 | 14800 |
| VIB-141 | primary | Primary specialist | codex Developer | codex / gpt-5.4-codex | `0199a141-77e2-7c08-b5d6-9a0b1c2d3141` | done | finished "Mar 30 · 14:52" | 7 | 74200 |
| VIB-141 | c0 | Consultant | claude Reviewer | claude / claude-sonnet-4-5 | `d5e0b7c4-1141-4e6f-b8d2-4f5a6b7c8141` | done | finished "Mar 30 · 14:31" | 3 | 28600 |
| VIB-141 | op | Operator | OP | claude / claude-sonnet-4-5 | `c4d9a6b3-0141-4d5e-a7c1-3e4f5a6b7141` | done | finished "Mar 30 · 15:02" | 8 | 13900 |

Note: run **order within each task's array** is the dropdown order and matters (VIB-142 lists op first; VIB-151/153/160/145 list primary first with op last).

#### Run log lines (complete, as builder calls — the seed script reproduces these exactly)

**VIB-142 / op** — `lines`:
```js
cc.init("08:02:11", "session e4b8a1c2 · claude-sonnet-4-5 · 9 tools · mcp: viberr-task-store · cwd /work/viberr"),
cc.text("09:02:20", "Transition request raised: In Progress → Review, evidence attached."),
cc.text("09:41:12", "Completion report received from the Developer. Packet raised for human acceptance."),
cc.text("09:58:30", "Arda's guidance noted — PAT-scope preference recorded against the open decision."),
```

**VIB-142 / primary** — `lines`:
```js
cx.start("08:12:04", "thread 0199a1f3-4c02… resumed · gpt-5.4-codex"),
cx.turn("08:12:05", "turn 9"),
cx.exec("08:12:31", "npm test -- --filter=pr-sync"),
cx.out("08:13:02", "integration/pr_sync: 38 passed · 0 failed"),
cx.diff("09:12:40", "9 files · +412 −87 · policy gate, branch reconciler, task projection", [
  { path: "src/github/policy_gate.ts", kind: "update" },
  { path: "src/github/reconciler.ts", kind: "add" },
  { path: "src/task/projection.ts", kind: "update" },
]),
cx.exec("09:39:12", "gh pr create --title 'Attach execution workspace' --base main"),
cx.out("09:39:15", "PR #318 created · vib-142-attach-workspace → main"),
cx.msg("09:40:58", "Completion report drafted with validation evidence — handing back to the operator."),
cx.done("09:41:02", "turn 9 · in 128k (cached 96k) · out 6.2k tokens · 92m", { input_tokens: 128034, cached_input_tokens: 96410, output_tokens: 6188 }),
```

**VIB-142 / c0** — `lines`:
```js
cc.init("08:30:02", "session a91f7c2e resumed · claude-sonnet-4-5 · re-anchored on task.md"),
cc.tool("08:31:10", "Bash", "gh pr diff 318 --stat"),
cc.out("08:31:14", "9 files changed, 412 insertions(+), 87 deletions(-)"),
cc.tool("09:18:40", "Bash", "npm run snapshot:verify"),
cc.err("09:19:02", "task_projection.json changed — compact shape not confirmed"),
cc.text("09:20:11", "Raising a quality flag: confirm the new compact shape is intended before review."),
cc.res("09:20:15", "success · 4 turns · 2m 12s api · $0.31", { dur: 132400, api: 98120, turns: 4, cost: 0.31, in: 812, cached: 38210, out: 2140 }),
```

**VIB-151 / primary** — `lines`:
```js
cc.init("10:18:02", "session 51d8f0e2 · claude-sonnet-4-5 · 9 tools · mcp: github, filesystem · cwd /work/viberr"),
cc.text("10:18:09", "Re-anchoring on the canonical task file before continuing stage work."),
cc.tool("10:18:11", "Read", ".viberr/tasks/VIB-151/task.md", { file_path: ".viberr/tasks/VIB-151/task.md" }),
cc.out("10:18:12", "412 lines · anchor ok · last typed event: consultant re-engaged 9:47"),
cc.tool("10:18:20", "Grep", "COMPRESS_THRESHOLD src/", { pattern: "COMPRESS_THRESHOLD", path: "src/" }),
cc.out("10:18:21", "3 matches · timeline/compress.ts:41,88 · config/defaults.ts:12"),
cc.tool("10:18:44", "Edit", "timeline/compress.ts — always keep typed events above threshold", { file_path: "src/timeline/compress.ts" }),
cc.out("10:18:45", "ok · +18 −6"),
cc.tool("10:19:03", "Bash", "npm test -- --filter=compression"),
cc.out("10:19:31", "40-event fixture: 12 passed · snapshot compaction_map updated"),
cc.text("10:19:40", "Typed events survive every pass. Running the long-fixture sweep next."),
cc.tool("10:19:46", "Bash", "npm test -- --filter=long-fixture"),
```
`live`:
```js
cc.out("10:24:12", "400-event fixture: compaction 6.2:1 · continuity anchors kept"),
cc.text("10:24:20", "Threshold 40 holds. Checking the re-anchor read path against compressed history."),
cc.tool("10:24:24", "Read", "timeline/reanchor.ts", { file_path: "src/timeline/reanchor.ts" }),
cc.out("10:24:25", "202 lines"),
cc.tool("10:24:58", "Edit", "timeline/reanchor.ts — read compressed spans lazily", { file_path: "src/timeline/reanchor.ts" }),
cc.out("10:24:59", "ok · +9 −2"),
cc.tool("10:25:07", "Bash", "npm test -- --filter=reanchor"),
cc.out("10:25:19", "8 passed · 0 failed (4.1s)"),
cc.text("10:25:26", "Green. Committing the compaction map and lazy reads."),
cc.tool("10:25:31", "Bash", "git commit -m '[VIB-151] compaction map + lazy compressed reads'"),
cc.out("10:25:33", "2 files changed · +27 −8 · vib-151-timeline-compression"),
```

**VIB-151 / c0** — `lines`:
```js
cx.start("10:29:41", "thread 0199a2c4-7b31… resumed · gpt-5.4-codex"),
cx.turn("10:29:42", "turn 3"),
cx.think("10:29:48", "Compare threshold defaults against long-task readability before advising."),
cx.exec("10:29:55", "git diff main...vib-151-timeline-compression --stat"),
cx.out("10:29:57", "7 files changed · +214 −41"),
```
`live`:
```js
cx.exec("10:30:14", "rg 'compression-threshold' .viberr/policy/"),
cx.out("10:30:15", "guardrails.yml:12 · value: 40 · typed events always kept"),
cx.think("10:30:24", "Policy already owns the value — the constant in defaults.ts should defer to it."),
cx.msg("10:30:33", "Recommend reading the threshold from project guardrails with 40 as fallback. Posting advisory to the task timeline."),
cx.done("10:30:36", "turn 3 · in 51.2k (cached 38.9k) · out 1.9k tokens", { input_tokens: 51234, cached_input_tokens: 38912, output_tokens: 1954 }),
cx.turn("10:30:41", "turn 4"),
cx.exec("10:30:49", "rg 'COMPRESS_THRESHOLD' src/config/"),
cx.out("10:30:50", "defaults.ts:12 · fallback candidate confirmed"),
```

**VIB-151 / op** — `lines`:
```js
cc.init("09:47:00", "session b7e2c9a4 · operator runtime · anchored .viberr/tasks/VIB-151/task.md"),
cc.text("09:47:05", "Re-engaged the Codex consultant for a second opinion on threshold defaults."),
cc.text("10:18:00", "Primary specialist resumed for the validation sweep. Watching for the review boundary."),
```

**VIB-153 / primary** — `lines`:
```js
cx.start("08:58:31", "thread 0199a0b8-53c9… started · gpt-5.4-codex"),
cx.turn("08:58:32", "turn 1"),
cx.think("08:58:40", "Draft a linter that enforces the packet length budget with a bounce-back diff."),
cx.exec("08:59:02", "rg 'packet' src/operator/ --files-with-matches"),
cx.out("08:59:03", "4 files · authoring.ts, budget.ts, packet.ts, verbosity.ts"),
cx.diff("09:58:12", "src/operator/brevity.ts (+64) · budget wired to observed → changed → recommended → decision", [
  { path: "src/operator/brevity.ts", kind: "add" },
]),
cx.msg("10:02:19", "Linter drafted — over-budget packets bounce back with a diff of what to cut."),
```
`live`:
```js
cx.turn("10:26:02", "turn 6"),
cx.exec("10:26:11", "npm test -- --filter=brevity"),
cx.out("10:26:29", "6 passed · 0 failed (3.2s)"),
cx.think("10:26:40", "Wire the reject path into packet authoring so violations never reach the timeline."),
cx.exec("10:27:04", "git commit -m '[VIB-153] brevity linter + bounce-back diff'"),
cx.out("10:27:06", "2 files changed · +71 −3 · vib-153-operator-brevity"),
cx.msg("10:27:18", "Reject path wired. Starting duplicate-summary detection next."),
```

**VIB-153 / op** — `lines`:
```js
cc.init("08:58:12", "session c8f3d0b5 · operator runtime · anchored .viberr/tasks/VIB-153/task.md"),
cc.text("08:58:20", "Assigned Codex as primary specialist — branch vib-153-operator-brevity created."),
```

**VIB-160 / primary** (the error run) — `lines`:
```js
cc.init("10:04:41", "resume claude-dev-160 — provider session lookup"),
cc.err("10:04:44", "provider session 404 · runtime history unavailable"),
cc.init("10:05:02", "rehydrated from .viberr/tasks/VIB-160/task.md · continuity warning recorded"),
cc.text("10:05:20", "Continuing from canonical state — earlier direction may be stale, verifying."),
cc.tool("10:09:33", "Bash", "npm test -- --filter=rehydrate"),
cc.err("10:10:04", "2 failed · evidence refs dropped before the continuity break"),
cc.res("10:31:00", "halted · operator raised a blocked decision packet", { subtype: "error_during_execution", dur: 1579000, api: 402000, turns: 5, cost: 0.87, in: 1424, cached: 51200, out: 3810 }),
```

**VIB-160 / c0** — `lines`:
```js
cx.start("10:12:20", "thread 0199a29d-60aa… resumed · gpt-5.4-codex"),
cx.exec("10:15:40", "git log --oneline vib-160-rehydrate ^main"),
cx.out("10:15:41", "2 commits · recovery shim, continuity marker"),
cx.msg("10:18:09", "Quality flag: the rehydrate path drops evidence references recorded before the break."),
cx.done("10:18:12", "turn 2 · in 22.4k (cached 18.2k) · out 0.8k tokens", { input_tokens: 22391, cached_input_tokens: 18240, output_tokens: 812 }),
```

**VIB-160 / op** — `lines`:
```js
cc.init("10:05:00", "session e0b5f2d7 · operator runtime · anchored .viberr/tasks/VIB-160/task.md"),
cc.text("10:05:08", "Continuity warning recorded — specialist re-anchored on the canonical file."),
cc.text("10:31:02", "Blocked decision packet raised — waiting on a human recovery path."),
```

**VIB-145 / primary** — `lines`:
```js
cx.start("09:14:02", "thread 0199a145-9e77… resumed · gpt-5.4-codex"),
cx.turn("09:14:03", "turn 11"),
cx.exec("09:14:30", "npm run e2e -- --browsers=chromium,firefox,webkit"),
cx.out("09:16:22", "3/3 browser targets green · fan-out latency p95 3.8s"),
cx.msg("09:17:04", "Review build green. Holding the thread open for reviewer questions."),
```
`live`:
```js
cx.turn("10:32:40", "turn 12"),
cx.exec("10:32:51", "rg 'revalidate' src/board/ -n"),
cx.out("10:32:52", "6 matches · sse.ts, cache.ts"),
cx.msg("10:33:20", "Prefetching answers for the review thread — no new commits planned."),
```

**VIB-145 / op** — `lines`:
```js
cc.init("09:10:44", "session f1c6a3e8 · operator runtime · anchored .viberr/tasks/VIB-145/task.md"),
cc.text("09:12:10", "Transition request raised: In Progress → Review — SSE fan-out demo recorded."),
```

**VIB-148 / op** — `lines`:
```js
cc.init("08:24:30", "session a2d7e4f1 · operator runtime · anchored .viberr/tasks/VIB-148/task.md"),
cc.tool("08:35:52", "Read", ".viberr/tasks/VIB-148/task.md", { file_path: ".viberr/tasks/VIB-148/task.md" }),
cc.out("08:35:53", "96 lines · goal + scope present · no owner on the acceptance boundary"),
cc.text("08:36:04", "Quality gate passed: goal and scope are executable."),
cc.text("08:36:10", "Waiting on a human owner for the acceptance boundary before scheduling execution."),
```

**VIB-139 / op** — `lines`:
```js
cc.init("16:58:00", "session b3c8f5a2 · operator runtime · anchored .viberr/tasks/VIB-139/task.md"),
cc.text("17:10:12", "Transition request raised: Review → Done — both policy surfaces validated."),
cc.text("17:26:31", "Human acceptance recorded by Elif — PR #298 merged. Closing operator session."),
cc.res("17:26:40", "success · 9 turns · session closed on completion", { dur: 2412000, api: 186000, turns: 9, cost: 0.42, in: 1120, cached: 42800, out: 2960 }),
```

**VIB-141 / primary** — `lines`:
```js
cx.start("13:40:11", "thread 0199a141-77e2… started · gpt-5.4-codex"),
cx.turn("13:40:12", "turn 7"),
cx.exec("14:31:20", "npm test -- --filter=typed-events"),
cx.out("14:31:44", "21 passed · 0 failed (6.8s)"),
cx.diff("14:40:02", "src/events/schema.ts (+120) · src/events/types.ts · five typed events as first-class records", [
  { path: "src/events/schema.ts", kind: "add" },
  { path: "src/events/types.ts", kind: "update" },
]),
cx.msg("14:51:38", "Typed important-event schema complete — payloads carry actor identity and task references."),
cx.done("14:52:01", "turn 7 · in 74.2k (cached 60.1k) · out 3.4k tokens", { input_tokens: 74212, cached_input_tokens: 60110, output_tokens: 3421 }),
```

**VIB-141 / c0** — `lines`:
```js
cc.init("14:12:08", "session d5e0b7c4 resumed · claude-sonnet-4-5 · re-anchored on task.md"),
cc.tool("14:20:15", "Bash", "npm run schema:lint"),
cc.out("14:20:19", "clean · 0 warnings"),
cc.text("14:31:02", "Quality flag resolved — typed payloads carry actor identity and task references."),
cc.res("14:31:10", "success · 3 turns · 1m 41s api · $0.19", { dur: 98400, api: 101000, turns: 3, cost: 0.19, in: 640, cached: 26100, out: 1480 }),
```

**VIB-141 / op** — `lines`:
```js
cc.init("13:38:50", "session c4d9a6b3 · operator runtime · anchored .viberr/tasks/VIB-141/task.md"),
cc.text("13:40:05", "Assigned Codex as primary specialist — branch vib-141-typed-events created."),
cc.text("15:02:12", "Completion accepted — Murat merged PR #287. Closing operator session."),
cc.res("15:02:20", "success · 8 turns · session closed on completion", { dur: 5010000, api: 154000, turns: 8, cost: 0.36, in: 980, cached: 38400, out: 2410 }),
```

### 3.12 Agent profiles (`AGENTS`)

```ts
type AgentProfile = {
  id: "operator" | "developer" | "reviewer" | "tester" | "consultant";
  kind: "operator" | "specialist";
  name: string;  role: string;
  icon: "shield" | "branch" | "check" | "bolt" | "message";   // Icon name from ui.jsx ICON_PATHS
  backends: Array<"claude" | "codex">;
  model: string;                   // display string, e.g. "codex-large · claude-sonnet"
  scope: string;                   // display string
  desc: string;
  stages: StageId[];               // eligible stages
  spanAll?: true;                  // operator only
  actions: { direct: string[]; recommend: string[]; forbidden: string[] };
  resources: { skills: string[]; mcps: string[]; kb: string[] };
};
// AGENTS = { operator: AgentProfile, profiles: AgentProfile[] }
```

Seed inventory:

**operator** — kind `operator`, role "Task coordinator", icon `shield`, backends `["claude"]`, model `"orchestration runtime"`, scope `"System role · one per active task"`, stages all five + `spanAll: true`.
- desc: "A dedicated operator is instantiated for every active task. It coordinates specialists, keeps the canonical task file authoritative, and turns agent work into concise decision packets for human review. It never writes code and never closes a task itself."
- direct: Assign the primary specialist · Summon consultant specialists · Generate decision & blocking packets · Append typed important events · Compress long-running timelines
- recommend: Stage transitions · Completion for human acceptance · Owner re-assignment
- forbidden: Execute code or write to the repo · Transition a task to Done · Change project policy
- resources: skills `packet-authoring, timeline-compression, continuity-reanchor`; mcps `viberr-task-store`; kb `Project workflow rules, Agent capability matrix`

**developer** — kind `specialist`, role "Implementation", icon `branch`, backends `["codex","claude"]`, model `"codex-large · claude-sonnet"`, scope `"Global base · customized for Viberr Core"`, stages `["ready","impl"]`.
- desc: "Implements stage work on the task-key branch: writes code, runs local validation, and opens the review PR. Hands back to the operator at the review boundary."
- direct: Create the task-key branch · Commit & push to the branch · Run unit & integration validation · Open the review pull request
- recommend: Move the task to Review · Report a validation verdict
- forbidden: Merge a pull request · Transition a task to Done · Edit another task's branch
- resources: skills `repo-write, test-runner, lint-autofix`; mcps `github, filesystem`; kb `Viberr Core architecture, Coding standards`

**reviewer** — kind `specialist`, role "Code review", icon `check`, backends `["claude"]`, model `"claude-sonnet"`, scope `"Global base · customized for Viberr Core"`, stages `["review"]`.
- desc: "Reviews the diff at the review boundary, raises typed quality flags, and recommends approve or request-changes. Re-anchors on the canonical task file before each review."
- direct: Read the repository & diff · Run validation suites · Post quality-flag events · Comment on the task
- recommend: Approve the review · Request changes
- forbidden: Merge a pull request · Transition a task to Done · Push commits to the branch
- resources: skills `diff-review, security-scan`; mcps `github`; kb `Review checklist, Security guidelines`

**tester** — kind `specialist`, role "Validation", icon `bolt`, backends `["codex"]`, model `"codex-large"`, scope `"Global base · default settings"`, stages `["impl","review"]`.
- desc: "Authors and runs the validation suite, attaches evidence to the task, and reports a clear pass/fail verdict — keeping raw validation output out of the timeline."
- direct: Author test cases · Run the validation suite · Attach evidence references
- recommend: Validation verdict · Hold the task on failing checks
- forbidden: Merge a pull request · Transition a task to Done
- resources: skills `test-author, coverage-report`; mcps `github, filesystem`; kb `Test strategy`

**consultant** — kind `specialist`, role "Advisory", icon `message`, backends `["claude","codex"]`, model `"claude-sonnet · codex-large"`, scope `"Global base · customized for Viberr Core"`, stages `["triage","ready","impl","review"]`.
- desc: "Persistent expert memory the operator can re-engage across stages. Reads and advises only — never writes to the repository or moves the task."
- direct: Read the task & repository · Comment with guidance
- recommend: Flag underspecified tasks
- forbidden: Write to the repository · Open or merge a PR · Any stage transition
- resources: skills `domain-advisor`; mcps `github`; kb `Product brief, Domain glossary, Prior decisions`

### 3.13 Project policy (`POLICY`)

```ts
type Policy = {
  edited: { by: "Elif Demir"; t: "Mar 30" };
  members: Array<{ p: HumanActor; role: "admin"|"maintainer"|"reviewer"|"viewer"; email: string; status: "active" }>;
  rbac: Array<{ action: string; grant: { admin: 0|1; maintainer: 0|1; reviewer: 0|1; viewer: 0|1 } }>;
  transitions: Array<{ from: StageId; to: StageId; by: string; boundary: "approval"|"auto"|"human"; locked?: true }>;
  repo: { name: string; override: boolean; credential: string; masked: string;
          scopes: Array<{ id: string; ok: boolean; task?: string }> };
  guardrails: Array<{ id: string; desc: string; on: boolean; value?: number; unit?: string }>;
  events: Array<{ kind: "violation"|"blockedact"|"audit"|"change"; t: string; text: string; task?: string; open?: true }>;
};
```

**members** (4 rows — project-level roles, distinct from org roles):

| person | role | email | status |
|---|---|---|---|
| ELIF | admin | elif@viberr.dev | active |
| ARDA | admin | arda@viberr.dev | active |
| MURAT | maintainer | murat@viberr.dev | active |
| SELIN | reviewer | selin@viberr.dev | active |

**rbac** (9 rows; 1 = granted):

| action | admin | maintainer | reviewer | viewer |
|---|---|---|---|---|
| View board, tasks & timelines | 1 | 1 | 1 | 1 |
| Comment on tasks (app-wide) | 1 | 1 | 1 | 1 |
| Take / release task ownership | 1 | 1 | 1 | 1 |
| Release any task owner | 1 | 0 | 0 | 0 |
| Approve stage transitions | 1 | 1 | 0 | 0 |
| Accept completion → Done | 1 | 1 | 0 | 0 |
| Open agent runtime sessions | 1 | 1 | 0 | 0 |
| Manage members & roles | 1 | 0 | 0 | 0 |
| Edit workflow & policy | 1 | 0 | 0 | 0 |

**transitions** (workflow boundaries):

| from → to | by | boundary | locked |
|---|---|---|---|
| triage → ready | "Human, after the quality gate — agents may flag underspecified tasks" | approval | |
| ready → impl | "Operator, when a primary specialist is assigned" | auto | |
| impl → review | "Operator transition request, with evidence attached" | approval | |
| review → done | "Human acceptance of the completion report" | human | **true** |

**repo** (project GitHub binding):

```js
{ name: "akin-ozer/viberr", override: true,
  credential: "viberr-bot · fine-grained PAT", masked: "github_pat_••••42af",
  scopes: [
    { id: "repo", ok: true }, { id: "workflow", ok: true }, { id: "read:org", ok: true },
    { id: "pull_request:write", ok: false, task: "VIB-142" },   // the seeded violation
  ] }
```

**guardrails** (5 rows, all `on: true`):

| id | desc | extra |
|---|---|---|
| `meaningful-comment` | Agent comments must add information — status chatter is rejected before it reaches the timeline. | |
| `operator-brevity` | Operator packets keep to observed → changed → recommended → decision required. | |
| `no-duplicate-summary` | A summary that restates an earlier one is dropped instead of appended. | |
| `compression-threshold` | Long timelines compress once routine events pass the threshold; typed events are always kept. | `value: 40, unit: "events"` |
| `evidence-separation` | Raw validation output stays in evidence references — never inline in the task record. | |

**events** (policy audit feed, 5 rows). Note: `text` is written to be followed by a task chip in the UI — several strings deliberately end mid-sentence with "on"/"—":

| kind | t | task | open | text |
|---|---|---|---|---|
| violation | today 9:38 | VIB-142 | true | ``Project credential is missing `pull_request:write` — flagged by the policy engine on`` |
| blockedact | yesterday 16:04 | VIB-145 | | `Blocked: Developer (Codex) attempted **Merge a pull request** — reserved for humans — on` |
| audit | yesterday 11:20 | VIB-160 | | `Murat opened the Developer runtime session for debugging — recorded per audit policy on` |
| change | Mar 30 | — | | `Elif locked **Review → Done** to human-only acceptance.` |
| change | Mar 30 | VIB-139 | | `Human RBAC and agent capability split into separate policy surfaces —` |

### 3.14 Notifications (`NOTIFICATIONS`)

```ts
type Notification = {
  id: string;                       // "n-<task#>-<slug>" or "n-dep-31"/"n-bil-9"
  kind: "packet" | "approval" | "policy" | "quality" | "mention";
  ptype?: "input" | "blocked";      // only when kind === "packet"
  unread: boolean;                  // seed value, then overridden by localStorage read-ids
  day: "Today" | "Yesterday";
  t: string;                        // clock
  from: OperatorActor | SystemActor | AgentActor | HumanActor;
  task: string;                     // task key — may reference OTHER projects (DEP-31, BIL-9)
  project: string;                  // set post-hoc: defaults to "Viberr Core"
  title?: string;                   // packet + approval kinds only
  text: string;                     // rich text (**bold**, `code`)
};
```

The stream is **global to the user** (Arda) across all projects. Two cross-project items are spliced in; **final array order** (position matters — this is the inbox order):

| # | id | kind | ptype | unread | day t | from | task | project | title | text |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | n-160-packet | packet | blocked | true | Today 10:31 | Operator (agent) | VIB-160 | Viberr Core | Blocked decision — pick a recovery path | ``Provider history unavailable and two rehydrate checks failing. The specialist continues from `task.md` once you choose.`` |
| 2 | n-dep-31 | packet | input | true | Today 10:12 | Operator (agent) | DEP-31 | **Deploy Pipeline** | Completion report — staging promotion ready | `Pipeline stage rework validated on a dry run. Promotion to staging needs your acceptance.` |
| 3 | n-142-packet | packet | input | true | Today 9:41 | Operator (agent) | VIB-142 | Viberr Core | Completion report — waiting on your acceptance | `Workspace attach implemented, **PR #318** open, validation green. Only a human can move it to Done.` |
| 4 | n-bil-9 | approval | — | true | Today 8:47 | Operator (agent) | BIL-9 | **Billing Service** | Transition request — Ready → In Progress | `Strict human-gate project: execution can't start without a maintainer approval.` |
| 5 | n-145-approval | approval | — | true | Today 9:12 | Operator (agent) | VIB-145 | Viberr Core | Transition request — In Progress → Review | `SSE fan-out demo recorded and evidence attached. This boundary needs a maintainer approval.` |
| 6 | n-142-policy | policy | — | true | Today 9:38 | Policy engine (system) | VIB-142 | Viberr Core | — | ``**Policy violation:** the active PAT is missing `pull_request:write` — PR auto-sync will fail after merge.`` |
| 7 | n-142-quality | quality | — | false | Today 9:20 | claude Reviewer | VIB-142 | Viberr Core | — | ``**Quality flag:** snapshot `task_projection.json` changed — confirm the compact shape before review.`` |
| 8 | n-148-mention | mention | — | false | Today 8:20 | ELIF | VIB-148 | Viberr Core | — | `mentioned you — “needs a reviewer to own the acceptance gate. **@arda** can you take it?”` |
| 9 | n-145-blockedact | policy | — | false | Yesterday 16:04 | Policy engine (system) | VIB-145 | Viberr Core | — | `Blocked agent action: Developer (Codex) attempted **Merge a pull request** — reserved for humans.` |
| 10 | n-160-reply | mention | — | false | Yesterday 11:20 | MURAT | VIB-160 | Viberr Core | — | `replied to you — “opened the Developer runtime session to debug continuity; findings come back as task comments.”` |

(Mention texts use **curly quotes** `“ ”` — preserve verbatim.) Note the order is not strictly time-sorted (10:12 sits above 9:41, 8:47 above 9:12) because the splices insert by index — see Open questions.

At load, `data.js` reads `localStorage["viberr:notifs:read"]` (JSON array of ids) and flips matching `unread` to `false`. Real app: a `notification_reads(user_id, notification_id)` table (or `read_at` column on per-user notification rows); read-state is per user, shared across surfaces (Home + workspace).

### 3.15 Session

```ts
// localStorage "viberr:session" — written by login.jsx:
{ user: "u-arda", name: "Arda Kaya", idp: "local", at: number /* Date.now() */ }
```

`session.get()` returns the parsed record or `null` (all three helpers swallow storage errors). `main.jsx` line 323 redirects to the login page when `session.get()` is falsy. Login extras (login.jsx): local password stored at `localStorage["viberr:pw:arda"]` defaulting to `"2828"`; only local account is `arda@viberr.dev` (or shorthand `arda`); admins can set a `pwreset: true` flag on the org user record which forces a set-new-password step at next login (min 4 chars). Real app: server session cookie + `users` table with password hash; the pwreset flag becomes a `must_reset_password` column.

### 3.16 Personal preferences (ui.jsx `initPrefs`, localStorage `"viberr:prefs"`)

```js
DEF = {
  theme: "system",          // "system" | "light" | "dark" → <html data-theme="dark|light">
  motion: "full",           // "full" | "reduce" → <html data-motion>
  tlDefault: "all",         // default timeline filter: "all" | "typed" | "comment"
  ghConnected: true,
  notifs: {                 // per-kind routing: { app: bool, email: bool }
    packets:   { app: true, email: true },
    approvals: { app: true, email: false },
    mentions:  { app: true, email: true },
    policy:    { app: true, email: true },
    quality:   { app: true, email: false },
  },
  nudge: { on: true, hours: 2 },
};
```

Merge is deep for `notifs`/`nudge` only, shallow elsewhere. `savePrefs(patch)` does `Object.assign` + persist + re-apply theme. Listens to `prefers-color-scheme` changes when theme is `"system"`. Real app: per-user prefs row (or per-device where noted); theme applied server-side or on hydration to avoid flash.

### 3.17 Org / instance settings (`ORG_DEFAULTS`, org-settings.jsx, localStorage `"viberr:org:v10"`)

Instance-level (above boards). `loadOrg()` = `{ ...ORG_DEFAULTS, ...saved }` (**shallow** merge per top-level key), `saveOrg(org)` persists whole object.

**connections** (GitHub PAT connections):
```ts
{ id, owner, method: "PAT", repos: number, def: boolean, expires: string, daysLeft: number }
```
| id/owner | repos | def | expires | daysLeft |
|---|---|---|---|---|
| akin-ozer | 7 | true | Jul 21, 2026 | 18 |
| hepapi | 12 | false | Mar 1, 2027 | 241 |

**users** (org accounts — note org `role` is `admin|member`, distinct from project roles):
```ts
{ id, name, email, initials, tone, role: "admin"|"member", status: "active", idp: "github"|"google"|"local", you?: true, pwreset?: boolean }
```
| id | name | role | idp | flags |
|---|---|---|---|---|
| u-elif | Elif Demir | admin | github | |
| u-arda | Arda Kaya | admin | local | `you: true` |
| u-murat | Murat Yıldız | member | google | |
| u-selin | Selin Aksoy | member | local | |

**domains** (IdP auto-provisioning): `[{ id: "d-1", domain: "@viberr.dev", role: "member" }]`

**kbs** (knowledge bases — directory trees of markdown):
```ts
type KbNode = { type: "dir"; name: string; children: KbNode[] } | { type: "file"; name: string; size: string; added: string };
type Kb = { id: string; name: string; dir: string; refresh: "on change" | "nightly"; last: string; tree: KbNode[] };
```
| id | name | dir | refresh | last | tree summary |
|---|---|---|---|---|---|
| kb-arch | Architecture notes | architecture-notes | on change | Jul 1 | decisions/(adr-001-task-store.md 4.2 KB Mar 30, adr-002-operator-model.md 6.8 KB Apr 14, adr-003-event-types.md 3.1 KB May 2), diagrams/(context-map.md 2.4 KB Jun 11), overview.md 8.9 KB Jul 1, glossary.md 5.5 KB Jun 20 |
| kb-api | API contracts | api-contracts | on change | Jun 28 | endpoints/(tasks.md 12.1 KB Jun 28, projects.md 7.3 KB Jun 15, agents.md 9.0 KB Jun 21), schemas/(task-contract.md 11.2 KB May 30, event-types.md 4.7 KB Jun 2), versioning.md 3.9 KB May 8 |
| kb-runbooks | Deploy runbooks | deploy-runbooks | nightly | Jul 3, 02:00 | incidents/(rollback.md 5.2 KB Jun 9, hotfix-flow.md 4.4 KB Jun 9), release-checklist.md 6.1 KB Jul 1 |

**mcps** (MCP server registry):
```ts
{ id, name, transport: "HTTP"|"stdio", target, cred: "secret://…", tools: number, up: boolean, last: string }
```
| id | name | transport | target | cred | tools | up | last |
|---|---|---|---|---|---|---|---|
| mcp-gh | github-mcp | HTTP | https://mcp.internal:7801/sse | secret://mcp/github | 14 | true | 30s ago |
| mcp-pg | postgres-readonly | stdio | npx -y @mcp/server-postgres | secret://mcp/postgres-ro | 6 | true | 1m ago |
| mcp-bb | browserbase | HTTP | https://mcp.internal:7809/sse | secret://mcp/browserbase | 0 | **false** | retry queued |

**skills** (agent skill definitions with markdown body + file tree):
```ts
{ id, name, summary, upd, body: string /* markdown */, tree: KbNode[] }
```
| id | name | summary | upd |
|---|---|---|---|
| sk-1 | conventional-commits | Commit style and task-key prefixes for traceable history. | Mar 30 |
| sk-2 | terraform-review | Module review checklist: state safety, drift, plan hygiene. | Jun 12 |
| sk-3 | api-design | REST conventions and versioning rules for public endpoints. | May 8 |
| sk-4 | changelog-writer | Turns change summaries into human-readable release notes. | Jun 30 |

(Bodies are multi-section markdown; copy verbatim from `org-settings.jsx` lines 61–85 when seeding. Trees contain `SKILL.md` + supporting files.)

**gagents** (global agent templates — reference skills/mcps/kbs by id):
```ts
{ id, name, backend: "codex"|"claude", summary, stages: StageId[], skills: string[], mcps: string[], kbs: string[], used: number }
```
| id | name | backend | stages | skills | mcps | kbs | used |
|---|---|---|---|---|---|---|---|
| ga-1 | Developer | codex | ready, impl | sk-1, sk-3 | mcp-gh | kb-arch | 4 |
| ga-2 | Reviewer | claude | review | sk-1 | mcp-gh | kb-api | 5 |
| ga-3 | Consultant | codex | impl, review | sk-3 | — | kb-arch | 2 |
| ga-4 | Test author | claude | impl | sk-2 | mcp-pg | — | 1 |

Real-app sourcing summary for §3: tasks + timelines + run logs → **file-native store** (`.viberr/tasks/<KEY>/task.md` + event log + run NDJSON) projected into SQLite; stages/policy/members/rbac/guardrails/agents/org → SQLite tables; notifications → SQLite per-user; session → cookie; prefs → user row; GitHub credential → env/secret store (never the DB in plaintext); `repo`/`pr`/branch state → GitHub API projection cache.

---

## 4. UI states & interactions

`data.js` itself has no UI, but its helpers define behavior other surfaces depend on:

- **`session.get()`** — returns parsed session or `null`; `main.jsx` gates the whole app: `if (!window.VIBERR.session.get()) location.href = "Viberr Login.html"` (real app: loader redirect to `/login`).
- **`session.set(s)` / `session.clear()`** — called by login (`Sign in` button → sets `{ user:"u-arda", name:"Arda Kaya", idp:"local", at }`) and Sign out menu item (clears, then navigates to login).
- **`markNotifsRead(ids)`** — unions ids into `localStorage["viberr:notifs:read"]`. Called: when a notification is clicked (single id), on **"Mark all read"** (all ids), and when a decision packet or approval is resolved on a task (`main.jsx` marks all `packet`/`approval` notifications for that task read).
- **Read-state hydration** — on every page load, seeds get `unread=false` for any persisted id. Real app: same projection done in the notifications loader.
- Load-order contract: `data.js` must run **before** `ui.jsx` (which attaches `prefs` to `window.VIBERR`) and before all screens.

Copy contract for enum values (user-visible strings the real app must render identically):
- readiness pills: `ready`, `input required`, `inconsistency risk`, `blocked`, `accepted`
- validation pills: `validation healthy`, `evidence changed`, `validation failing`, `no validation`
- run states: `running`, `idle`, `finished`, `continuity error`
- typed event pill labels: `Completion report`, `GitHub`, `Policy violation`, `Quality flag`, `Transition request`, `Blocked decision`, `Operator`, `Ownership`
- packet footer buttons: primary = selected option title (e.g. `Accept completion`), secondary = `Ask operator`; recommended option tag = `operator pick`
- guest pill: `app user · not in project`; agent pill: `agent`

Verbatim packet-card JSX (task.jsx `DecisionPacket` — the class names and structure are the port contract):

```jsx
<div className={"packet " + (isBlocked ? "blocked" : "input")}>
  <div className="packet-top">
    <Pill kind={isBlocked ? "blocked" : "input"} dot>{p.kind}</Pill>
    <span className="from">
      from <span className="agent-glyph op"><Icon name="shield" /></span> <strong style={{ fontFamily: "var(--font-display)" }}>{p.from}</strong>
    </span>
  </div>
  <div className="packet-body">
    <h2>{p.title}</h2>
    <p style={{ color: "var(--muted)", fontSize: ".92rem", lineHeight: 1.55, margin: 0 }}>{p.body}</p>
    <div className="packet-obs">
      {p.observations.map((o, i) => (
        <div className="obs" key={i}>
          <span className="k">{o.k}</span>
          <span>{o.code ? <code>{o.v}</code> : o.v}</span>
        </div>
      ))}
    </div>
    <div className="options" role="radiogroup" aria-label="Decision options">
      {p.options.map((o, i) => (
        <button key={i} role="radio" aria-checked={sel === i} className={"opt" + (sel === i ? " sel" : "") + (o.rec ? " recommend" : "")} onClick={() => setSel(i)}>
          <span className="radio" />
          <span>
            <div className="ot">{o.t}</div>
            <div className="od">{o.d}</div>
          </span>
          {o.rec && <span className="rec-tag"><Pill kind="info" sm>operator pick</Pill></span>}
        </button>
      ))}
    </div>
    <div className="packet-actions">
      <button className="btn primary" onClick={() => onResolve({ option: p.options[sel], packet: p })}>
        <Icon name="check" />{p.options[sel] ? p.options[sel].t : "Confirm"}
      </button>
      <button className="btn ghost" onClick={onAsk}><Icon name="message" />Ask operator</button>
    </div>
  </div>
</div>
```

Verbatim timeline-item JSX (task.jsx `TimelineItem` body — shows how every event field renders):

```jsx
<div className="tl-item">
  <div className="tl-rail">
    <div className={"tl-node " + meta.node}><Icon name={meta.icon} /></div>
    <div className="tl-line" />
  </div>
  <div className="tl-body">
    <div className="tl-meta">
      <span className="tl-actor">{actor.name}{actor.role ? " · " + actor.role : ""}</span>
      {isTyped && <Pill kind={typedKind(ev.type)} sm>{meta.label}</Pill>}
      {actor.kind === "agent" && <Pill kind="agent" sm>agent</Pill>}
      {actor.kind === "human" && actor.guest && <Pill kind="neutral" sm>app user · not in project</Pill>}
      <span className="tl-time">{ev.day && ev.day !== "Today" ? ev.day + " · " + ev.t : ev.t}</span>
    </div>
    {ev.type === "comment" ? (
      <div className={"comment-card" + (ev.to === "agent" ? " toagent" : "")}>
        <div className="tl-text"><RichText text={ev.text} /></div>
      </div>
    ) : (
      <React.Fragment>
        {ev.title && <div className="tl-text"><strong>{ev.title}</strong></div>}
        <div className="tl-text"><RichText text={ev.text} /></div>
        {ev.evidence && (
          <div className="tl-card evidence">
            {ev.evidence.map((e, i) => (
              <div className="ev-row" key={i}>
                <span>{e.label}</span>
                <span><span className="add">{e.add}</span> <span className="del">{e.del}</span></span>
              </div>
            ))}
          </div>
        )}
      </React.Fragment>
    )}
  </div>
</div>
```

`RichText` micro-format used by `text` fields everywhere (timeline, notifications): regex `(\*\*[^*]+\*\*|`[^`]+`|@[A-Za-z][\w-]*)` → `**x**` becomes `<strong>`, `` `x` `` becomes `<code class="mono">`, `@name` becomes `<span class="mention">`. The real app should keep this exact micro-format (or migrate to real markdown while preserving these three tokens).

---

## 5. Events / mutations produced

The mock mutates the in-memory globals; each becomes a real action + typed event write:

| Mock mutation (main.jsx) | Real action | Typed timeline event written |
|---|---|---|
| `addEvent(key, { type:"comment", actor: ARDA, t:"now", text, to })` | POST comment action | `comment` (with `to:"agent"` when directed at operator) |
| Packet resolve — option with `accept: true` (VIB-142 opt 1) | accept-completion action: stage→done, readiness→done, clear packet, merge PR | `completion` with title `"Completion accepted"`, text `"Human acceptance recorded. Task transitioned to **Done** and review PR approved for merge."` |
| Packet resolve — option `"Block on policy"` | hold action | `blocked`: `"**Decision:** hold on policy. <KEY> stays blocked until the project credential policy is updated."` |
| Packet resolve — option `"Hold for runtime debug"` | hold action | `blocked`: `"**Decision:** hold for runtime debug. <KEY> stays blocked while the provider-native session is inspected — findings come back as task comments."` |
| Packet resolve — any other option | decision action | `transition`: `option.ev` if present, else `"**Decision:** " + choice + ". Operator re-engages the specialist with a summon note."` |
| Packet/approval resolve side-effect | mark related notifications read | `markNotifsRead(ids of that task's packet/approval notifications)` |
| Owner control (take / assign / hand off / release) | ownership action | `assign` event |
| Stage edit in Settings (`setStages`) | workflow-update action (admin-only per RBAC) | policy `change` event |
| Members edit (`setMembers`) | member-management action (admin-only) | policy `change` event |
| Notification click / "Mark all read" | read-state action | — (toast `"All notifications marked read"`) |
| `savePrefs(patch)` | prefs update action | — |
| Login submit / sign out | create/destroy session | — |
| `saveOrg(org)` (org settings edits, incl. `pwreset`) | org admin actions | — |
| Live-run "Interrupt" button | governed interrupt action (stubbed: toast `"Interrupt is a governed action — stubbed in this prototype"`) | presumably an `agent` event |

Events that seed data implies agents/system produce (must become server-side writers): `github` (branch push / PR opened / merged), `policy` (violation from credential pre-flight), `quality` (reviewer/consultant flags), `transition` (operator requests), `blocked` (operator packet raised), `agent` (operator coordination notes), plus notification fan-out per `prefs.notifs` routing and run-log append (NDJSON/JSONL evidence files).

---

## 6. CSS classes used

`data.js` renders nothing, but its **data values are class-name inputs**. Structural contract (all from the verbatim-ported CSS):

- Pills: `pill`, kinds `ready | input | risk | blocked | done | neutral | info | agent`, modifiers `sm`, child `pdot`.
- Avatars/identities: `avatar [lg] [rose|teal|violet]` (from `person.tone`), `agent-glyph [claude|codex|op] [lg]`, `who-chip`, `nm`, `sub`, `mention`.
- Packet: `packet input|blocked`, `packet-top`, `from`, `packet-body`, `packet-obs`, `obs`, `k`, `options`, `opt [sel] [recommend]`, `radio`, `ot`, `od`, `rec-tag`, `packet-actions`.
- Timeline: `tl-item`, `tl-rail`, `tl-node <node>` where node ∈ `"" | completion | github | policy | quality | transition | blocked | agent`, `tl-line`, `tl-body`, `tl-meta`, `tl-actor`, `tl-time`, `tl-text`, `comment-card [toagent]`, `tl-card evidence`, `ev-row`, `add`, `del`.
- Runtime: `runbar`, `runbar-head`, `live-dot`, `runbar-body`, `run-phase`, `run-spin`, `ph`, `step mono`, `run-stats`, `run-cell`, `lbl`, `val mono`, `run-actions`, `rdot <state>`, `rsel`, `rsel-btn [open]`, `rsel-menu`, `rsel-item [on]`, `ri-txt`, `ri-nm`, `ri-sub`, `ri-state <state>`.
- Shared: `btn [primary|ghost] [sm]`, `icon-btn`, `ico`, `toast-wrap`, `toast`, `tgl [on]`, `knob`, `confirm-scrim`, `page-overlay`, `page-overlay-body`, `overlay-x`, `mono`.

The enum values in this document (`readiness`, `validation`, run `state`, event `type`→node, pill `kind`, avatar `tone`, glyph backend) **are** class names or map 1:1 onto them — renaming any enum value breaks the ported CSS.

---

## 7. Porting notes

1. **`window.VIBERR` global → loaders.** Every consumer reads the global synchronously; the port replaces this with route loaders returning typed projections: `project`, `stages`, `tasks` (list + detail), `runtime[taskKey]`, `agents`, `policy`, `notifications`. No client-side singleton.
2. **In-place mutation → actions + revalidation.** `main.jsx` literally mutates `window.VIBERR.stages`, `policy.members`, and pushes onto `task.timeline`. Each becomes a POST action writing to SQLite/task files, with SSE-driven revalidation (VIB-145's own feature) replacing React state lifting.
3. **Task file layout is already prescribed by the seeds:** runtime logs anchor on `.viberr/tasks/<KEY>/task.md` and policy files under `.viberr/policy/` (`guardrails.yml` with `compression-threshold: 40`). Use exactly these paths for the file-native store. `task.md` frontmatter should carry the §3.4 scalar fields; timeline/typed events are the append log; `commits`/`changed`/`pr` are **GitHub projections, not frontmatter** (the mock stores them inline only for convenience).
4. **Run logs: store raw, derive display.** The mock stores display-shaped `LogLine`s and *reconstructs* raw NDJSON/JSONL (`rawLine()` in runs.jsx). The real app inverts this: persist the actual `claude --output-format stream-json` NDJSON and Codex `runStreamed()` JSONL per run (file-native evidence), and derive the `{t, ev, tag, text, …}` display projection. The `ev` enum in §3.11 is the projection contract. The `live` array + 1200 ms replay + fake ticker (`elapsed + tick`, `tokens + tick*42`) are replaced by real SSE streaming of run events.
5. **Timestamps are display strings** (`"9:41"`, `day: "Yesterday"`, `"Mar 30"`, `"today 9:38"`, `finished: "Mar 30 · 17:26"`). The real schema needs real timestamps (epoch/ISO) plus a formatter reproducing these exact display forms (`t` for today, `day + " · " + t` otherwise). Seed script should back-date records to produce identical rendered strings.
6. **Read-state, session, prefs, org move server-side:** `viberr:notifs:read` → per-user read rows; `viberr:session` → cookie session; `viberr:prefs` → user prefs (theme/motion may stay client-side for no-flash, but notif routing + nudge are server data); `viberr:org:v10` → org tables; `viberr:pw:arda` (default `"2828"`) → password hash column; `pwreset` flag → `must_reset_password`.
7. **Two parallel role systems — keep them separate** (this is VIB-139's whole point): org roles (`admin|member` in ORG users), project roles (`admin|maintainer|reviewer|viewer` in POLICY.members/rbac), and agent capability profiles (AGENTS.actions direct/recommend/forbidden). Murat is org `member` but project `maintainer`. Don't unify.
8. **Actor identity denormalization.** Timeline/notification actors are embedded objects, not FKs. In SQLite, store `actor_kind` + `actor_ref` (user id / agent profile id / "system") + denormalized display fields, so events survive member removal (audit requirement).
9. **Packets are derived-but-addressable.** Only the newest unresolved packet appears on a task (`task.packet`). Model as its own record (type, kind, title, body, observations JSON, options JSON) with `resolved_at` + a link to the typed event that raised it and the event written on resolution (`options[].ev` text).
10. **Guest capability**: `DENIZ` (guest) can comment app-wide but nothing else — matches rbac row "Comment on tasks (app-wide)" being all-roles. Enforce server-side: non-members may comment; everything else requires membership.
11. **Missing-key edge cases**: `RUNTIME` has no entry for VIB-166/VIB-168 (runtime panel hidden); tasks with `operator: null`, `owner: null`, `specialist: null`, `branch: null`, `pr: null`, `timeline: []` must all render (VIB-166/168 exercise all of these at once). `urgent` is absent (not `false`) on VIB-139/141 — treat as optional boolean.
12. **Cross-project notifications** reference tasks (DEP-31, BIL-9) and projects ("Deploy Pipeline", "Billing Service") that don't exist in `TASKS`/`project`. Seed script must either create stub projects/tasks or make notification task refs soft (string key + project name, no FK) — recommend soft refs since the inbox is user-global.
13. **`markNotifsRead` is a set-union, idempotent** — the real action should be too (INSERT OR IGNORE).
14. **Non-ASCII data**: names (`Murat Yıldız`, `Selin Aksoy`, `Deniz Şahin`, initials `DŞ`), typographic `·`, `—`, `→`, curly quotes in mention texts, and U+2212 minus (`−87`, `−4`) in diff strings. Keep UTF-8 end to end; the seed script must copy these verbatim, not re-type them.
15. **Notification routing prefs** (`prefs.notifs`) map kinds 1:1: `packets→packet`, `approvals→approval`, `mentions→mention`, `policy→policy`, `quality→quality`, each with app/email booleans + nudge `{on, hours}` — this becomes the fan-out policy for the real notifier.

---

## 8. Open questions

1. **Unused readiness values** — `risk` ("inconsistency risk") and `blocked` are in the `READINESS` contract but no seed task uses them. Keep in the schema enum; confirm what transitions set them (likely file-store reconciliation → `risk`, packet raised → `blocked`?).
2. **`viewer` project role has no member** and org roles have no `maintainer|reviewer|viewer` — is the org→project role mapping (`member` → which project role?) defined anywhere? Domains auto-provision org `member` only.
3. **`operator.since` semantics** — `"stage 1|2|3"` reads like "operator attached since Nth stage of its lifecycle"; confirm whether it's ordinal stage index or a lifecycle counter, and whether it belongs in frontmatter or is derived from the event log.
4. **Notification ordering** — the spliced array is not time-sorted (10:12 above 9:41; 8:47 above 9:12 within "Today"). Is inbox order intentional (grouping by project attention?) or a mock artifact? Real app should probably sort by real timestamp; confirm before locking the seed order.
5. **`pr.state` enum** — only `"review"` and `"merged"` observed. Real GitHub adds `open/draft/closed`; define the projection mapping.
6. **`commits`/`changed` only on VIB-142** — confirm these are pure GitHub projections (derivable) and not task-file data; other tasks with branches have neither.
7. **Run `id` scheme** — `"op" | "primary" | "c0"` implies at most one primary and consultants `c0..cN`. Confirm multi-consultant support and whether a replaced specialist gets a new run row (`primary-2`?) — the VIB-160 "Start a fresh specialist" option implies retired threads persist as `error`/`done` rows.
8. **`tokens + tick*42` and `elapsed + tick`** — fake live counters. Real app needs run heartbeat/usage events over SSE; decide granularity (per line? per turn?).
9. **Policy `events` trailing "on"/"—" strings** — the text expects a task chip appended by the UI. In the real schema, store `text` + `task_key` separately and let the renderer compose; confirm the composition rule ("text + task chip" only when `task` present).
10. **`AGENTS` (project-customized profiles) vs `ORG_DEFAULTS.gagents` (global templates)** — two overlapping registries (`developer` vs `ga-1 Developer`, etc.), consistent with VIB-168 ("global base with per-project overrides"). Confirm the real model: `gagents` = org-level template rows; `AGENTS.profiles` = per-project override/instantiation referencing a template id?
11. **`repo.override: true`** — presumably "project overrides the org default connection". Confirm relation to `ORG_DEFAULTS.connections[].def`.
12. **DEP-31 / BIL-9** — should the seed create the "Deploy Pipeline" and "Billing Service" projects (with minimal tasks) so notification links resolve, or are dead links acceptable in phase 1?
13. **`prefs.ghConnected`** — a per-device boolean that duplicates real connection state (`POLICY.repo`, org `connections`). Probably drop in the real app; confirm.
14. **Password default `"2828"` / localStorage PW** — mock-only. Real auth (Phase 2) presumably seeds Arda with a proper hash; confirm the dev-login story so the seed script can include a working credential.
