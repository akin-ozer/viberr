# Pass 18 — UX / UI coherence audit (code inspection)

Independent, page-by-page audit of every user-facing surface, done **by code
inspection only** (no app run, no browser — the live pass is separate). The
owner's stated priority is the frame: *"how UX is going on for the end users —
is UI/UX holistic and coherent overall?"*

**Tree audited:** branch `pass18/product-fixes` @ `1f6b689` (G1–G8, LV-F1, LV-F2
already landed). Every finding below was read at `file:line` before it was
recorded; candidates that did not survive verification are in the last section.

**Sources of intent consulted:** `design/CONVERSATION-SUMMARY.md` (copy bans +
reject list), `design/prd.md`, `docs/architecture/decisions.md`,
`planning/discovery-2026-08-04-pass17/UX-COHERENCE-REVIEW.md`,
`planning/discovery-2026-08-04-pass18/{FINDINGS,NEW-FINDINGS,LIVE-VERIFY-SESSION,NOTES}.md`
and `reference/UI-INVENTORY.md`.

---

## Tally

| Severity | Count | Ids |
| --- | --- | --- |
| **HIGH** | 0 | — |
| **MED** | 6 | UXA-1 … UXA-6 |
| **LOW** | 10 | UXA-7 … UXA-16 |
| Intended-by-design (verified, no action) | 6 | §Intended |
| Investigated, no defect | 9 | §No defect |

No HIGH. Nothing found breaks a user's task or misroutes an irreversible
action. The six MEDs are one honesty defect, one state-semantics divergence,
one incomplete propagation of a pass-18 fix, one a11y cluster, one hydration
class the siblings already fixed, and one vocabulary split.

**Headline:** the product is genuinely coherent. Every MED below is of the form
*"the app already solved this exactly once, and one sibling surface was never
brought along"* — which is the healthiest possible failure mode, and also the
one the goal's "holistic?" question is really asking about.

---

## HIGH

None.

---

## MED

### UXA-1 — The comment composer tells every reader "Open to every registered user". It isn't, and the Permissions panel on the SAME page says so.

**Severity:** MED (honesty) · **Surface:** Task detail → Timeline composer

**Evidence**
- `app/features/task-detail/timeline.tsx:363` — rendered footer copy:
  `Open to every registered user · @mentions route to agents`
- `app/features/task-detail/task-side-panels.tsx:280-289` — the Permissions
  panel's `Comments` row, whose own code comment records the fix:
  > *"E1: this was hardcoded 'Every registered user' — false, and false on a
  > surface whose whole job is stating what the server enforces. A signed-in
  > non-member 404s on this page and on the comment POST; membership is the
  > gate…"*
  It now renders `"You can comment — every project member can"` /
  `"Project members only"`, read from `roleCan(r, "comment")`.
- The members-only gate is R15-4 (re-verified live this pass —
  `LIVE-VERIFY-SESSION.md` §RBAC: a non-member gets **404** on every project
  surface).

**What the user experiences.** On one task page, the main column asserts
comments are open to every registered user while the right rail asserts they
are members-only. One of them is wrong, and it's the prominent one.

**Why it's wrong.** E1 fixed exactly this sentence in the Permissions panel and
never swept the composer, which is the more-read of the two. It is also a
governance claim on the app's flagship surface — the class of copy the product
is otherwise scrupulous about.

**Fix.** Replace with the enforced fact, e.g.
`Project members can comment · @mentions route to agents`. One line; the
existing `copy-ban.test.ts` scanner is the natural place to add a companion
assertion, or assert the string in `task-detail-components.test.tsx`.

---

### UXA-2 — The review queue paints a rejected (closed-unmerged) PR **neutral grey**; every other surface paints it **risk**. It carries a private colour map.

**Severity:** MED (state semantics — the goal's #1 priority) · **Surface:** Review queue

**Evidence**
- `app/features/review/review-page.tsx:56-68` — an inline, file-local map:
  ```
  kind={ t.pr.state === "merged" ? "done"
       : t.pr.state === "closed"  ? "neutral"
       : "info" }
  ```
- Canonical mapping `app/features/github/github-pills.ts:47-52` —
  `closed → { kind: "risk", label: "closed" }`.
- `closed` is a **first-class row state** in this queue:
  `app/server/projections/review-queue.server.ts:53,127-131` emits it, and
  `app/features/review/review-helpers.ts:72` gives it the top-priority subline
  (`"…was closed on GitHub without merging — rework and reopen it, or archive
  the task."`, the R16-3 ruling).
- The sibling surfaces all render through `prStatePill`:
  `app/features/task-detail/task-side-panels.tsx:128` (whose comment is
  literally **UI-36: "this branched only on merged/accepted, so a PR CLOSED
  WITHOUT MERGING … rendered … visually identical to a PR still in review"**),
  `app/features/board/board-page.tsx` (R16-6), `app/features/github/github-view.tsx:161,252`.

**What the user experiences.** A rejected PR sits in "Still in review" wearing
the same neutral pill the app uses for informational chrome, next to a rose
line telling them to rework or archive. Pill and prose disagree.

**Why it's wrong.** UI-36 is the same defect, already ruled and fixed once; the
review queue is the surface it was never applied to. Pass-17's own review lists
"one pill vocabulary" as the app's #2 coherence strength — this is the one
place it is not one vocabulary.

**Fix.** `import { prStatePill }` and render
`<Pill kind={prStatePill(t.pr.state).kind} sm>PR #{n} · {prStatePill(...).label}</Pill>`.
(The `accepted` state is genuinely out of scope here — see §Intended — but
`closed` is not.)

---

### UXA-3 — Project Settings: the LV-F2 read-only note reached 3 of the 4 panels. The Repository panel still disables a control with no explanation.

**Severity:** MED (incomplete fix of a pass-18 finding) · **Surface:** Project settings → Repository & credentials

**Evidence**
- The LV-F2 pattern landed on three panels:
  `app/features/project-settings/settings-page.tsx:97-105` (Project),
  `:762-784` (Stages), `:870-878` (Members) — each a `.pol-note` naming the
  missing grant.
- `RepoPanel` starts at `settings-page.tsx:1068` and contains **no** `pol-note`
  (grep for `pol-note` in this file returns only 97 / 762 / 870 / 951).
- `settings-page.tsx:1163-1168` — the "After merge · delete the task branch on
  GitHub" checkbox is `disabled={!canRepair || repairBusy}`, with no `title`,
  no inline note, and the sibling "Repair…" button hidden entirely
  (`:1130`-ish, `canRepair &&`). The only cue is
  `style={{ cursor: canRepair ? "pointer" : "default" }}` (`:1161`).

**What the user experiences.** A maintainer (or any non-admin) sees a live-looking
checkbox for a real repository behaviour that silently refuses to toggle, on the
one panel of four that never says why.

**Why it's wrong.** LV-F2's own record: *"A disabled control cannot explain
itself (`title` never opens on one)"* — and P14-LV-08 before it. Three panels
honour that; this one doesn't.

**Fix.** Add the same `.pol-note` to `RepoPanel`, gated on `!canRepair`, naming
the **Edit workflow & policy** grant (the action `canRepair` actually resolves).

---

### UXA-4 — `pick-chip` / `cap-seg` selection is conveyed by CSS class alone — 13 groups, including the capability **Direct / Recommend / Human / Off** control.

**Severity:** MED (a11y 1.4.1 + 4.1.2; same class as G3/G5, which fixed only `mini-seg`/`seg`) · **Surfaces:** New-project modal, agent-profile modal, org agent-template modal, board New-task modal

G3 and G5 swept `mini-seg` and `seg`. The `pick-chip` and `cap-seg` families
were never touched. Every one of these is a `<button>` whose only selected-state
signal is `className={… + (sel ? " on" : "")}`:

| file:line | control | container ARIA |
| --- | --- | --- |
| `app/features/agents/create-profile-modal.tsx:573-586` | **capability mode: Direct / Recommend / Human / Off** (`.cap-seg`) | inside `role="group"` (`:516`), children bare |
| `app/features/agents/create-profile-modal.tsx:239-253` | Execution backend ("pick exactly one") | `role="group"` + `aria-labelledby` (`:230`) |
| `app/features/agents/create-profile-modal.tsx:299-307` | Default autonomy | `role="group"` (`:284`) |
| `app/features/agents/create-profile-modal.tsx:424-435` | Eligible stages (multi) | `role="group"` (`:417`) |
| `app/features/agents/create-profile-modal.tsx:662-680` | Resource grants (skills/MCP/KB) | `role="group"` (`:616`) |
| `app/features/board/board-page.tsx:645-656` | New-task Stage picker | `role="group" aria-labelledby` (`:639-643`) |
| `app/features/home/new-project-modal.tsx:129-140` | GitHub connection | **no role, no label** (`:125`) |
| `app/features/home/new-project-modal.tsx:280,288,296` | Agent policy preset | **no role, no label** (`:279`) |
| `app/features/org-settings/agent-template-modal.tsx:291-299` | Default eligible stages | **no role, no label** (`:289`) |
| `app/features/org-settings/agent-template-modal.tsx:312-319 / :335-342 / :358-366` | Skills / MCP / KB grants | **no role, no label** (`:310 / :333 / :356`) |

**What the user experiences.** A screen-reader user configuring an agent profile
hears "Direct, button / Recommend, button / Human, button / Off, button" for
every one of ~44 capabilities, with no way to hear which is currently set — on
the app's single most consequential configuration screen. Same for the policy
preset that decides how autonomous a whole new project is.

**Why it's wrong.** The app's own convention, stated twice in comments: board
`:634-636` (*"A chip-button group has no labelable control for htmlFor, so the
name is attached via role=group"*) and create-profile `:228-229`. Policy's
`.cap-seg` at `policy-page.tsx:462-484` **does** carry `role="radiogroup"` +
`role="radio"` + `aria-checked` — the identical CSS class, done right one file
away.

**Fix.** `aria-pressed` on every multi-select chip; `role="radio"` +
`aria-checked` (inside the existing `role="group"`, or `role="radiogroup"`) on
the single-select ones, mirroring `policy-page.tsx:474-475`. Add
`role="group" + aria-labelledby` to the six unlabelled containers.

---

### UXA-5 — The notifications page renders viewer-local timestamps during SSR with no hydration guard, and uses one as its day **grouping key**.

**Severity:** MED (React #418 → full client re-render; wrong day labels for one frame) · **Surface:** `/notifications`

**Evidence**
- `react-router.config.ts:4` — `ssr: true`; `/notifications` is a normal loader
  route (`app/routes/notifications.tsx:37-47`).
- `app/features/notifications/notifications-page.tsx:5` imports
  `formatClock, formatDayBucket` **directly** (not the hydration-safe wrappers):
  - `:122` — `formatDayBucket(n.occurredAt, now)` is the day **grouping key**
  - `:133` — the same call re-filters rows into that group
  - `:185` — `formatClock(n.occurredAt)` per row
- `app/features/notifications/notifications-page-helpers.ts:64-65` —
  `needsYouTime` does the same for the "Waiting on you" rows.
- Both helpers are viewer-timezone dependent by construction:
  `app/shared/dates/format.ts:52` (`d.getHours()`), `:65` (`sameLocalDay`).
- The three siblings all guard: activity page
  (`activity-page.tsx:259` `useHydrated`, `:361` `local ? formatClock : formatClockUTC`),
  run console (`runs-panels.tsx:15,362`), task detail
  (`timeline.tsx:158`, `task-main-sections.tsx:333`, `task-side-panels.tsx:160`
  via `LocalDayDotTime` / `LocalRelative`).
- `app/ui/local-time.tsx:8-13` states the contract, and
  `format.ts:110-116` documents `formatDayBucketUTC` as existing **precisely**
  because a grouping key that straddles UTC midnight *"would mismatch every
  header at once."*

**What the user experiences.** On a production UTC container with a non-UTC
viewer, the first paint groups notifications by the server's day; React detects
the mismatch and re-renders the whole page client-side (visible flash, lost
scroll/filter state, a console error). Around midnight the "Today"/"Yesterday"
headers are momentarily wrong.

**Why it's wrong.** This is the one page of four that skipped the pattern the
other three adopted deliberately, and it's the page that uses the unsafe value
as a *grouping key* — the case the helper's own docblock singles out.

**Fix.** Mirror `activity-page.tsx`: `const local = useHydrated()` and swap in
`formatClockUTC` / `formatDayBucketUTC` (both already exported) for the first
pass; do the same in `needsYouTime`.

---

### UXA-6 — Two names for one actor on one page: "Primary specialist / Run specialist" (recommendation cards) vs "Delivering agent" (execution profile).

**Severity:** MED (copy discipline / naming coherence) · **Surface:** Task detail

**Evidence**
- `app/features/task-detail/operator-recommendations.tsx:42,44` — rendered
  labels `"Primary specialist"`, `"Run specialist"` (drawn at `:86-87`).
- `app/features/task-detail/execution-profile.tsx:287` — the button reads
  `Assign delivering agent`; `:291` menu label `"Assign a delivering agent"`;
  `:671` the column label is `Delivering agent`; `:694` tooltip *"Start an agent
  run for the delivering agent"*.
- Both render in the same main column of `project.task.tsx`, recommendations
  directly above the execution profile.
- A third register on the Agents page:
  `app/features/agents/agents-page.tsx:1243` *"specialists in a working state"*,
  `:1277` *"New specialist profile"*, `create-profile-modal.tsx:144`
  *"New specialist profile"*.

**What the user experiences.** The operator recommends "Primary specialist ·
Assign Developer"; the panel underneath calls the resulting seat "Delivering
agent". A first-time user cannot tell whether these are the same thing.

**Why it's wrong.** Pass-17's review credits the app for teaching its vocabulary
once; this is the one concept with two rendered names in one viewport.
(`profile` vs `agent` is a legitimate definition-vs-instance split and is NOT
part of this finding.)

**Fix.** Pick one and sweep. `Delivering agent` is the better term — it names the
role, matches the execution-profile column and the server's own
`performDelivery` vocabulary, and doesn't collide with "specialist profile" (the
definition). So: `assign_specialist → "Delivering agent"`,
`run_specialist → "Run delivering agent"`. Leave the Agents page's *profile*
nouns ("New specialist profile") alone — that's the definition layer.

---

## LOW

### UXA-7 — Policy's two `role="radiogroup"`s have no roving tabindex / arrow-key handling; the canonical fix exists in `decision-packet.tsx`.
`app/features/policy/policy-page.tsx:150-160` (member role toggles) and
`:461-484` (transition boundary) declare `role="radiogroup"` with `role="radio"`
+ `aria-checked` children, but no `onKeyDown` and no `tabIndex` management — so
the ARIA contract promises arrow-key traversal the markup never wires (the exact
complaint UI-58 raised for activity/notifications, and the exact thing
`app/features/task-detail/decision-packet.tsx:145,193-224` implements correctly:
*"UI-44: roving tabindex + real focus movement"*). Every radio is also a
separate tab stop. **Fix:** lift the decision-packet keydown+tabIndex pattern
into a small shared helper and use it in both places.

### UXA-8 — Two wide grid tables have no mobile collapse and no `overflow-x` wrapper, unlike their siblings.
`.gh-table` (GitHub → Execution branches, `app/app.css:2353`, 4 fr-columns) and
`.live-wrap` (Agents → Live roster, `:1636`, 5 fr-columns) appear in **no**
`@media` block (`grep '@media' app/app.css` → 18 blocks; `gh-table` appears only
at `:2353`; `.live-wrap` only at `:1621`), and neither wrapper declares
`overflow-x`. The app knows the pattern elsewhere: `.rbac-scroll { overflow-x:
auto }` (`:1986`), `.mx-scroll { overflow: auto }` (`:1920`), `.md-table-wrap`
(`:2998`). Columns 3–4 of `.gh-table` are bare `<span>`s with no `min-width: 0`
(`github-view.tsx:276,307`), so pill content sets their min-content width.
**Fix:** wrap both in an `overflow-x: auto` container (one declaration each),
matching `.rbac-scroll`. *Needs a 375 px live confirmation to grade the actual
clipping; the missing-affordance fact is verified statically.*

### UXA-9 — `MiniModal`'s disabled Save never names the unmet requirement; the two other modal families do.
`app/features/org-settings/mini-modal.tsx:63-72` disables Save on `!canSave`
with only `opacity: .55`; the adjacent `footHint` (`:58`) is caller-supplied
policy copy, never the missing field. Seven callers rely on it
(`connections-panel.tsx:52`, `resource-modals.tsx:20/111/285`,
`users-panel.tsx:105/364`, `agent-template-modal.tsx:151`). Contrast
`new-project-modal.tsx:346` and `create-profile-modal.tsx:729`
(*"Name, role, one execution backend, and at least one stage are required."*),
and `board-page.tsx:684` (*"A title is required."*). **Fix:** give `MiniModal` an
optional `unmetHint` that replaces `footHint` while `!canSave`.

### UXA-10 — The profile page states the same "no memberships" fact two different ways, and "Joined" can render a year-less day.
`app/features/profile/profile-page.tsx:190-193` renders `Member of — ` (a bare
em dash) while `:482` renders `No project membership yet.` for the same
condition, on the same page. Separately `:204` uses
`formatDayBucket(user.createdAt)` for **Joined**, which yields
`"Today" | "Yesterday" | "Mar 30"` (`format.ts:64-71`) — a three-year-old account
reads "Mar 30" with no year, while the app already has `formatCalendarDate`
("Jul 3, 2027", used at `connections-panel.tsx:225`). It is also the same
unguarded-SSR class as UXA-5. **Fix:** reuse the `:482` sentence for the kv row;
switch Joined to `formatCalendarDate`.

### UXA-11 — The connection modal locks the owner field with no explanation.
`app/features/org-settings/connections-panel.tsx:110` —
`<input id="cn-owner" … disabled={!!initial} />`. The modal's title is
*"Update token — {owner}"* and its sub is *"The current token is never shown —
paste a replacement"*; neither says the owner is immutable. The same file's
sibling pattern is done right in `users-panel.tsx:409,422` (a `def-note`:
*"Name & email sync from GitHub/Google at each sign-in and can't be edited
here."*). **Fix:** one `def-note` under the field.

### UXA-12 — The login value-proposition panel is `aria-hidden="true"`.
`app/routes/login.tsx:426` marks the whole `.login-aside` — containing an `<h2>`
("Managed AI delivery for small teams") and three unique product claims
(`:428-438`) — hidden from assistive tech. This content appears nowhere else, so
an AT user gets a bare sign-in form where a sighted user gets the product's
positioning. **Fix:** drop `aria-hidden` (it is text, not decoration); if the
intent was to keep it out of the tab order, nothing in it is focusable anyway.

### UXA-13 — The "org-admin override" pill explains itself only through a `title` on a non-focusable `<span>`.
`app/features/shell/topbar.tsx:145-152` — the D2 authority surface. The visible
text is two words; the sentence that matters (*"You are not a member of this
project — you're acting with org-admin emergency authority. Every override is
recorded in the audit log."*) lives in a `title` on a `<span>`, which keyboard
and screen-reader users never reach. Note the sibling `livePaused` pill three
lines below (`:156-167`) IS a `<button>` with `role="status"`. **Fix:** make it a
`<button>` (or add `tabIndex={0}` + `aria-describedby`) so the explanation is
reachable, per R15-11 (*refusals/authority are rendered copy in place*).

### UXA-14 — "Save goal" disables below 3 characters with no hint anywhere.
`app/features/task-detail/task-main-sections.tsx:194-200` —
`disabled={goalFetcher.state !== "idle" || draft.trim().length < 3}` with no
`title` and no inline copy in the whole `goal-edit` form (`:173-212`). A user who
types one or two characters gets a dead button and no reason. The board's New
Task modal handles the identical requirement correctly (`board-page.tsx:684`).
**Fix:** a `.foot-hint err` line under the textarea, shown once the field has been
touched.

### UXA-15 — The Agents page never says it is read-only for a reader without `manage-agents`.
`app/features/agents/agents-page.tsx:1034` computes `canManage` and uses it only
to **hide** — New profile (`:1204`), Library (`:1217`), the group "+" (`:1273`),
Edit / Delete on the detail hero (`:659-668`, `:606`). A Contributor therefore
sees a full profile browser with zero actions and no statement of authority.
Policy (`policy-page.tsx:438-443`) and project Settings (LV-F2,
`settings-page.tsx:97/762/870`) both name the missing grant on the same shape of
surface, and Policy's *"Manage profiles"* button (`policy-page.tsx:346-349`)
sends the reader straight here. **Fix:** one `.pol-note` in the Agents header
when `!canManage`, naming the **Manage agent profiles** grant.

### UXA-16 — Policy's "last change" stamp is computed in the SERVER's timezone and carries no year.
`app/features/policy/policy-query.server.ts:69-71` builds the display string
server-side with `formatDayBucket(row.occurred_at)` and ships it to the client,
so in a UTC container the Policy header reads the server's day while every other
timestamp in the app is viewer-local. It also yields `"Mar 30"` with no year and
no time for anything older than yesterday. (The ternary is additionally a no-op:
`formatDayBucket(x) === "Today" ? "Today" : formatDayBucket(x)`.) **Fix:** send
the raw ISO and render with `LocalDayDotTime` / `formatCalendarDate`, as the rest
of the app does.

---

## Intended by design — verified, do NOT "fix"

1. **Review queue never renders `pr.state: "accepted"`.** Ruled out in
   `planning/discovery-2026-08-04-pass17/DOMAIN-MODEL.md:1196` — *"structurally
   out of scope, because the queue lists review-stage tasks and a merge-pending
   task is already in Done."* Only the `closed` branch (UXA-2) is a defect.
2. **Hiding an unauthorized control instead of disabling it.** Stated in
   `task-side-panels.tsx:585` and `operator-recommendations.tsx:93-95` —
   *"hide them from lower roles rather than render a button that 403s."* UXA-15
   asks for the *explanation*, not for inert buttons.
3. **Board drag-and-drop is pointer-only, with `StageMenu` as the keyboard
   path.** `board-page.tsx:122`, plus `UI-INVENTORY.md §5`. The absence of drag
   `aria-live` announcements is already recorded there.
4. **No live/SSE indicator in the topbar** — only the honest degraded
   `livePaused` retry pill (`topbar.tsx:156-167`). Design reject list,
   `CONVERSATION-SUMMARY.md:24`.
5. **Review-queue wait-tag copy deliberately differs from the board**
   ("your acceptance" vs "waiting on you") — `review-page.tsx:17-19` says
   explicitly *"do not unify."*
6. **`GOVERNED_TEMPLATE` is an identifier, not copy** — its rendered `label` is
   `"Standard · 5 stages"` (`app/shared/workflow/templates.ts:34-35`), and
   `copy-ban.test.ts:40-50` allowlists only the identifier forms.

---

## Carried from earlier records (not re-reported, confirmed still present)

- **UXO-1** (archived task keeps its pre-archive pills) — still live at
  `task-main-sections.tsx:147-167`: `archived` + stage + `ReadinessPill` +
  `ValidationPill` all render side by side, with nothing marking the last three
  as frozen. Recorded in `LIVE-VERIFY-SESSION.md`.
- **UXO-3** (board header "1 task" over three "No tasks" columns at narrow
  widths) — `board-page.tsx:754-772` computes `countLine` project-wide; the
  columns are horizontally scrolled. Recorded.
- **Run-log tail disconnect is reload-only** vs the topbar's retry —
  `use-run-log-stream.ts:453-466`. Recorded in `UI-INVENTORY.md §5`.
- **F18-9** (new-profile modal defaults all org skills ON) — unchanged by
  ruling; it is a live rough edge, awaiting an owner decision.
- **F18-1b** (recovery packet not stamped `superseded` immediately) — explicitly
  optional, left for a future pass.
- No regression of G1–G8, LV-F1 or LV-F2 was found: G2's `readinessEffect` pill
  is in place (`task-main-sections.tsx:59-65`), G3/G4/G5's ARIA and copy fixes
  hold, LV-F1's re-issue button and LV-F2's three settings notes are present.

---

## What's genuinely good (must not regress)

1. **One pill vocabulary, centrally owned.** `app/ui/pill.tsx` is the single
   readiness/validation mapping; a whole-tree grep finds only **four** raw
   `className="pill …"` sites (`home-sections.tsx:71`, `board-page.tsx:506`,
   `topbar.tsx:147,159`), three of which are buttons that structurally cannot be
   the `<span>` component. `github-pills.ts` is the single PR/CI/review/sync
   mapping. UXA-2 is the *only* private colour map left in the tree.

2. **Confirmation dialogs state exactly what happens, including the parts that
   hurt.** `accept-confirm.tsx:73-143` names the PR number, the merge target
   branch, the delivered revision sha, the verdict, the *drift* ("N commits added
   since review; they merge unreviewed"), the bypassed gate on a force-accept,
   and closes with "Merging is one-way." `archive-confirm.tsx:36-107` enumerates
   what the archive **withdraws** by name and insists "this is a disposition, not
   a delete." `settings-page.tsx:1262-1272` requires typing the project name.
   This is the best-executed pattern in the product.

3. **Refusals are rendered copy, not tooltips.** The rule is written down
   (`task-side-panels.tsx:557-559`: *"The reason has to be TEXT, not a `title`: a
   disabled control gets no pointer events"*) and implemented in `deny-note` /
   `pol-note` across decision packet (`:300`), acceptance (`:560`), danger zone
   (`settings-page.tsx:1321`), Policy (`:438`), Settings (`:97/762/870`). UXA-3,
   UXA-9, UXA-11, UXA-14 are the four remaining gaps in an otherwise complete
   sweep.

4. **Counts name their own scope.** P14-WL-04's fix holds everywhere: board
   *"N waiting on a human decision in this project"* (`board-page.tsx:769-772`),
   Agents *"agent threads waiting on a human · this project"* (`:1253`), Home
   *"across all your projects"* (`home-sections.tsx:190`), plus the filtered
   `"N of M tasks"` line so a filter never reads as data loss.

5. **Truncation and caps are always disclosed.** `top-bell.tsx:151-155`,
   `notifications-page.tsx:273-278`, `activity-page.tsx:389-394`, `:217-221`,
   timeline `:410-419` — and UI-47's fix means "Show older · N more" never
   promises rows the ceiling can't load.

6. **Icon-only buttons: 32 of them, 0 without an accessible name** — and most
   carry a *specific* one (`aria-label={"Delete " + kb.name}`), not a generic
   "Delete".

7. **Empty states have a voice and, at their best, a next action.** The 1-2-3
   `EmptyHero` (`home-sections.tsx:242-268`), *"No agents deployed — deploy one
   on the Agents page"* (`execution-profile.tsx:270`), *"Every global profile is
   already deployed here. Create more in org settings…"* (`agents-page.tsx:475`),
   and the filter-aware variants that distinguish "nothing exists" from "nothing
   matches" (`timeline.tsx:395-404`, `board-filters.ts:183-195`,
   `activity-page.tsx:367-373`).

8. **The command palette's ARIA is textbook.** `combobox` + `aria-controls` +
   `aria-activedescendant` + `aria-autocomplete="list"` over a real
   `listbox`/`option` tree with `aria-selected`, plus a `role="status"` for the
   one thing `aria-activedescendant` cannot say (`command-palette.tsx:135-213`).

9. **The design reject-list is respected.** No "Secrets · Isolated" Permissions
   row, no addressee Team/Specialist toggle (mentions only —
   `timeline.tsx:363`), no AGENTS.md preview in the profile modal, no colored
   card edges, no persistent SSE indicator. The `govern*` ban is now enforced by
   a real lint (`app/features/copy-ban.test.ts`) rather than by eye.

10. **The stylesheet gate is the real thing.** `app/app.css.test.ts` scans the
    whole tree with **no allowlist**, asserts every class used in markup has a
    rule, holds inline styling to a shrinking budget, and gates WCAG AA contrast
    in both themes.

---

## Investigated — no defect

- **Pill semantics across board / task detail / GitHub / review** — one mapping
  module, consistent tones (`ready` green, `input` amber, `risk` amber-rose,
  `blocked` crimson, `done` green, `neutral` grey). Only UXA-2 diverges.
- **G2 (diagnostics colour)** — properly fixed: the panel renders the
  server-computed `readinessEffect` through the same `ReadinessPill` as the hero
  (`task-main-sections.tsx:56-71`), with a neutral "heads-up" for info findings.
- **Banned-word sweep beyond the linted roots** — `app/ui`, `app/shared`,
  `app/lib` contain `govern*` only in code comments and identifiers
  (`rbac.ts:6`, `capabilities.ts:88/101/391`, `workflow/*`); nothing renders.
- **Confirm-dialog contract** — all 11 destructive dialogs (`role="alertdialog"`
  on a native `<dialog>`, `useDialog` for Escape/backdrop/focus-restore) state
  the consequence; `ConfirmDelete` callers pass grant-count tails
  (`resources-panel.tsx:236-250`), the profile delete names active engagements
  (`agents-page.tsx:288-300`), user disable names the session kill
  (`users-panel.tsx:534-537`).
- **Toast honesty** — `ToastKind` is explicit and a failure never renders the
  success tick (`toast.tsx:19-26`); the stack is capped oldest-drops with a
  documented rationale (`:32-49`); one `role="status" aria-live="polite"` host.
- **Shell consistency** — identical rail + topbar on every project surface,
  `aria-current` on both the rail items and the breadcrumb, a real mobile
  adaptation (rail → overlay at 720 px, `app.css:2873-2913`) rather than a
  broken desktop layout.
- **Icon-only button names / listbox+option contracts / `role="group"` +
  `aria-pressed` on `mini-seg` and `seg`** — verified clean after G3/G5 (the
  remaining gap is the `pick-chip`/`cap-seg` family, UXA-4).
- **Error boundary theme + shell retention (F18-1)** — `root.tsx:178-220` renders
  a themed panel and `Layout` keeps `data-theme` + the boot script; a thrown
  `data("<message>", { status })` becomes the page copy rather than a raw router
  string.
- **Responsive breakpoints** — the consolidated `@media (max-width: 1100px)`
  block (`app.css:3930-3956`) collapses every 2-up layout, the review row, the
  agents rail, the run console and the log grid; 720 px handles the shell and
  F18-12's profile-grid. Only the two tables in UXA-8 have no rule.
