# "Waiting on you" / decision-count trace

Read-only code trace (main @ 8041134). Goal: locate every place a
"decision waiting on you" counter is computed, so they can be reworked to a
single **member-scoped "requires MY action"** semantic.

## TL;DR — why three different numbers appear

There is **no shared "open decision" helper**. Three independent predicates,
each with different inputs and different (or absent) scoping, back the surfaces:

| # | Surface | Predicate (what counts) | Scoped to viewer? |
|---|---------|--------------------------|-------------------|
| P1 | Home headline + project cards | SQL `packet_json present OR recommendation_count > 0`, non-terminal stage, **per project, all tasks** | Only the *set of projects* is membership-scoped (admins get all); the per-project count is project-global |
| P2 | `/notifications` "Waiting on you" | per-notification `kind ∈ {packet,approval}` **AND** live `task_has_packet=1` / `recommendation_count>0`, non-terminal | Per-user (notification recipient) but "task has *any* packet", not per-packet; read-state ignored |
| P3 | Board "Waiting on me" chip + subtitle + review queue | task-level `waiting === "human"` **enum** | Not scoped at all — every human-waiting task in the project |

P1/P2 read packet/recommendation *presence*; P3 reads the *separate* `waiting`
enum (maintained independently of the packet field). None consults per-user
role/assignment. That is the entire source of the divergence the owner observed.

---

## 1. Home headline — "N decisions waiting on you"

- **Rendered**: `app/features/home/home-page.tsx:826-828`
  (`{totalWaiting} … decisions … waiting on you.`), inside `HomeHero`.
- **Computed**: `app/features/home/home-page.tsx:1294`
  `const totalWaiting = active.reduce((a, p) => a + p.waiting, 0);`
  where `active = projects.filter((p) => !p.archived)` (`home-page.tsx:1287`).
- **`projects` source**: loader `app/routes/_index.tsx:43`
  `listHomeProjectsForUser(db, { id: user.id, role: user.role })`.
- **Membership scoping**: `app/features/home/home-query.server.ts:79-96`.
  - Org **admin** → `return all` (`:84`) — **every** project, including ones
    they are not a member of. This is why Arda's headline includes playground.
  - Member → filtered to `project_members` slugs (`:88-95`).
  - **Within a project, `p.waiting` is project-global** — it is NOT reduced to
    the tasks this user must act on. The headline is therefore `Σ(project-global
    waiting)` over the projects visible to the viewer.

## 2. Project card — "N waiting on you" (per project)

- **Rendered**: `app/features/home/home-page.tsx:142-146`
  (`<Pill kind="input">{p.waiting} waiting on you</Pill>`), in the card meta row.
- **Source query**: `app/features/home/home-query.server.ts:118-141` —
  ```
  SUM(CASE WHEN (packet_json IS NOT NULL AND packet_json <> '')
             OR recommendation_count > 0
           THEN 1 ELSE 0 END) AS w
  FROM task_projections GROUP BY project_slug, stage
  ```
- **Terminal-stage exclusion + sum**: `home-query.server.ts:194-200`
  (`if (!isTerminalStage(stage, project.stages)) waiting += w`).
- **Scoping**: none beyond project-visibility. Every task in the project with an
  open packet or ≥1 pending recommendation counts, regardless of who owns it or
  whether the viewer holds `resolve-packet`/`accept-completion`. `viberr 3 +
  playground 2 = 5` is exactly `Σ p.waiting`, which is why the headline (item 1)
  and the cards agree with each other but not with the notifications overlay.

## 3. Notifications overlay — "Waiting on you" list

- **Rendered (count)**: `app/features/notifications/notifications-page.tsx:46-51`
  (`{items.length} decision…`) where `items = needs`.
- **`needs` derivation**: `app/features/notifications/notifications-page-helpers.ts:17-28`
  `needsYou(n) = (n.kind === "packet" || n.kind === "approval") && n.waitingOnYou`.
  The split ALSO applies the All/Unread filter `f`, but `f` defaults to `"all"`
  (`notifications-page.tsx:186`), so **read-state does not remove a card**.
- **Data source**: the per-user **`notifications` table** (not live packet state
  directly), with each row's `waitingOnYou` **reconciled against live
  `task_projections`** by a LEFT JOIN at read time.
  - Query: `app/server/projections/notifications.server.ts:104-131`; the JOIN and
    selected live columns are `:111-118`
    (`task_has_packet = packet_json present`, `task_recommendation_count`).
  - Reconciliation predicate: `app/shared/mapping/notification.server.ts:74-84`
    (`liveWaitingOnYou`): packet → `task_has_packet === 1`; approval →
    `recommendation_count > 0`; **false** if terminal stage or the task row does
    not resolve locally.
- **Dedupe by task?** No. One card per notification row
  (`notifications-page.tsx:54-93`). A task with both a `packet` and an `approval`
  notification produces two cards.
- **Drops superseded / resolved / applied?**
  - **Resolved** packet → task file sets `packet = null` → `packet_json` NULL →
    `task_has_packet=0` → **drops**. ✔
  - **Superseded** packet → **does NOT drop** (the observed bug). A task carries
    exactly one packet field; a new packet overwrites the old, so
    `task_has_packet` is still `1`. The OLD packet's notification row still
    reconciles to `waitingOnYou = true` because the check is "task has *any*
    packet", not "*this* packet is still open" — packet identity is never
    compared. ✘
  - **Applied** recommendation → `recommendation_count` decrements; an approval
    card drops only when the count hits 0. An unrelated still-pending
    recommendation keeps an already-applied one's card "waiting". ✘
- **Read-state effect**: none on this list (see `f` default above). A read
  notification with `waitingOnYou=true` stays — matching the owner's report that
  a read, superseded packet still appeared under "Waiting on you · 4".
- **Note on scoping**: this list *is* inherently per-user (rows are `WHERE
  user_id = ?`), so it does not over-count for non-members the way P1/P3 do — but
  it over-counts stale packet/recommendation cards, hence a *different* number
  again (4 vs the headline's 5).

## 4. Board "Waiting on me · N" filter chip

- **Chip definition**: `app/features/board/board-page.tsx:547`
  `{ id: "human", label: "Waiting on me", icon: "hand" }`.
- **Predicate**: `app/features/board/board-filters.ts:18-22`
  `if (filter === "human") return task.waiting === "human";`.
- **Header subtitle count**: `app/features/board/board-page.tsx:891`
  `const waitingHuman = allTasks.filter((t) => t.waiting === "human").length;`
  rendered at `board-page.tsx:576` (`{waitingHuman} waiting on a human decision`).
- **Scoping**: the board loader is per-project (`app/routes/project.board.tsx`),
  but the chip/subtitle are **not user-scoped** — every `waiting === "human"`
  task counts. An org-admin non-member who opens the board sees them too. "Board
  'Waiting on me' counts them" is literally `waiting === "human"` with no `me`.
- **Different input**: this is the `waiting` **enum**, NOT packet/recommendation
  presence. A task can be `waiting: "human"` with no open packet (e.g. a bare
  hand-off) and, conversely, carry a packet while `waiting` is something else —
  so P3 can disagree with P1/P2 on the very same task.

## 5. Is there a single "open decision requiring a user" helper?

**No.** Three independent definitions, none member-scoped:

- **P1** (home headline + project cards): `home-query.server.ts:121-123` (SQL
  `packet_json present OR recommendation_count > 0`) + `:199` (non-terminal).
- **P2** (`/notifications`): `notification.server.ts:74-84` (`liveWaitingOnYou`)
  + `notifications-page-helpers.ts:17-28` (`needsYou`).
- **P3** (board chip + subtitle + review queue): `waiting === "human"` at
  `board-filters.ts:22`, `board-page.tsx:891`, and
  `app/server/projections/review-queue.server.ts:86`
  (`ready = rows.filter((r) => r.waiting === "human")`).

Related but distinct (stage count, not a decision count): the workspace rail
review badge `app/routes/project.tsx:59-66` counts tasks **at the review stage**,
not decisions. `agent-deployments.server.ts:43-49` also branches on `waiting` for
status labels (not a counter).

**Who is actually allowed to act** (the missing scoping input) lives entirely in
RBAC, not in any of these counters:
- `resolve-packet` and `accept-completion` → roles `[admin, maintainer]`
  (`app/shared/rbac.ts:85-86`); the task **owner** (contributor+) is additionally
  allowed at the `resolvePacket` call site for non-completion packets
  (`rbac.ts:52` note; `task-actions.server.ts` resolve path).
- Org-admin override: `app/server/auth/project-authority.server.ts:114-153`
  (`resolveProjectAuthority`) grants a non-member/underprivileged **org admin**
  admin-equivalent authority as the audited **D2 emergency override**
  (`isOrgAdminOverride: true`, `:150`), distinct from a genuine member grant
  (`isOrgAdminOverride: false`, `:126`). This flag is the natural seam for
  representing "override-eligible" separately (see proposed unification).

## 6. Packet lifecycle — what marks a decision stale, and do the counters see it?

- **Cardinality**: a task carries **at most one packet** (single decision) —
  schema `app/schemas/task-file.schema.ts:201-217`; recommendations are a **list**
  (several may be pending) — `:116-130`, `:232-233`.
- **Projection write**: `app/server/projections/rebuilder.server.ts:411-412`
  — `packet_json = parsed.packet ? JSON.stringify(parsed.packet) : null`,
  `recommendation_count = fm.recommendations.length`.
- **Resolve → clears**: `app/server/tasks/task-actions.server.ts:2742` `resolvePacket`
  sets `parsed.packet = null` (`:2958`, `:3170`); operator path
  `app/server/tasks/operator-actions.server.ts:583` `operatorResolvePacket`
  (`:607`). Recommendation resolution removes the entry from the list → the count
  decrements.
- **"Superseded" has no explicit flag**: a new packet **overwrites** the single
  `packet` field. The prior packet stops existing in the file, but its
  **notification row persists** (a distinct `notifications` row). No counter keys
  off a packet ID, so none can distinguish a live packet from a superseded one.
- **`waiting` enum is maintained separately**: flipped to `human`/`agent`/`none`
  by task-actions independently of `packet_json` (e.g.
  `task-actions.server.ts:2842` `waiting=none`, `:2864/:2902` `waiting=human`,
  `:2924/:2944` `waiting=agent`; `:1918` agent→human). P3 tracks this enum and
  **never consults `packet_json`**.
- **Net**: P1/P2 correctly drop **resolved** decisions (packet_json null /
  count→0). They **cannot** drop a **superseded** packet (identity lost) or an
  **applied** recommendation while a sibling recommendation is still pending
  (count-based, not id-based). P3 drops only when the `waiting` enum is flipped,
  on its own schedule.

---

## Proposed unification

### The single helper

Introduce one server projection, member-scoped, that every surface consults:

```
// app/server/projections/decisions.server.ts  (new)
interface DecisionRef {
  projectSlug: string;
  taskKey: string;
  kind: "packet" | "completion" | "recommendation";
  recommendationId?: string;   // present for kind === "recommendation"
  stage: string;
}
interface DecisionsForUser {
  mine: DecisionRef[];        // decisions THIS user is authorized to act on
  overrideEligible: DecisionRef[]; // open decisions the user could only act on
                                   // via the D2 org-admin override (NOT mine)
}
function decisionsRequiring(
  db, userId, opts?: { projectSlug?: string },
): DecisionsForUser
```

**What "an open decision" is (one definition, replacing P1/P2/P3):** an open
decision is a `task_projections` row that is **not in its terminal stage** and
carries either (a) a non-null `packet_json` whose packet is not `awaiting:
goal_edit` (a decided-but-parked packet), or (b) ≥1 pending recommendation.
Completion packets (`accept-completion`) are distinguished from ordinary packets
so the owner-allowance rule can differ. `waiting === "human"` is **dropped** as a
counter input — it stays only as a board *display* hint, not a decision source.

**Fixing the staleness bugs at the source** (so the helper is honest without
per-call reconciliation):
- Give each packet a stable `id`; project it as `packet_id`. Reconcile a
  notification against `packet_id`, not "task has any packet" — a superseded
  packet's notification then falls out immediately.
- Recommendations already have ids (`recommendationSchema`); the approval
  notification should carry the `recommendationId` and reconcile against *that*
  id's presence, not the aggregate count.
- Alternatively (cheaper, no schema change): the helper returns *task-level*
  decision refs and the notifications page **dedupes by `(taskKey, kind)`** and
  drops any decision notification whose task no longer carries a packet of the
  matching id — but the id is the robust fix.

**Member-scoping (the core change):** a decision is `mine` iff
`resolveProjectAuthority(db, project, {userId}, rolesForAction(action), …)`
returns `allowed && !isOrgAdminOverride`, where `action` is `resolve-packet` for
a packet, `accept-completion` for a completion packet (plus the task-owner
allowance for non-completion packets), or the recommendation's governing action.
A decision the user could act on **only** because they are an org admin
(`isOrgAdminOverride === true`) goes to `overrideEligible`, never `mine`.

### Call sites that adopt it

1. **Home headline** — `home-page.tsx:1294` / `:826-828`: replace
   `Σ p.waiting` with `decisionsRequiring(userId).mine.length`. Copy becomes a
   true personal count.
2. **Project cards** — `home-page.tsx:142-146` and the SQL in
   `home-query.server.ts:118-141,194-200`: `p.waiting` becomes the count of
   `mine` decisions for that `projectSlug` (group the helper's result by slug).
3. **Notifications "Waiting on you"** — `notifications-page-helpers.ts:17-28`
   and `notification.server.ts:74-84`: `waitingOnYou` becomes "this
   notification's `(taskKey, packet_id | recommendationId)` is in the viewer's
   `mine` set", which fixes superseded/applied leakage and the missing dedupe.
4. **Board "Waiting on me"** — `board-filters.ts:22`, `board-page.tsx:547,891`:
   the chip filters/counts tasks whose decision is in `mine`, not
   `waiting === "human"`. Rename honestly or keep "Waiting on me" now that it is
   actually *me*.
5. **Review queue** — `review-queue.server.ts:86`: `ready` becomes the
   review-stage tasks whose decision is `mine` (keeps org-admins from seeing a
   personal "waiting on your acceptance" bucket for projects they don't belong
   to).

### Representing org-admin override-eligible items separately

`overrideEligible` is **never** folded into the personal count. Surfacing options,
in order of restraint:
- **Default**: show only `mine` everywhere above; org admins on a non-member
  project get `0` in their personal counters (correct — nothing is waiting on
  *them* personally).
- **Optional admin affordance**: a separate, clearly-labelled control (e.g. an
  "N override-eligible across the org" line on Home, or a distinct board chip
  "Override available") driven by `overrideEligible.length`, so an org admin can
  still find work that needs an emergency decision — but it reads as *governance
  reach*, not *your inbox*. Any action taken through it flows through the
  existing D2 override audit (`project-authority.server.ts:135-149`), unchanged.

This keeps one definition of "open decision", one authorization source
(`resolveProjectAuthority`), and one honest separation between "waiting on me"
and "I *could* override this".
