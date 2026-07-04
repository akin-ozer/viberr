# Phase 5 report — Task detail workspace

Status: complete. Gates at close: `npm run typecheck` clean,
`npm run build` clean, `npm test` 334/334 green (46 new phase-5 tests).
Note: a **parallel Phase-7 agent** was working uncommitted in the same
tree during this phase (`app/server/github/`, `app/server/secrets/`,
`db/migrations/0005_github.sql`, additive edits to error-codes /
projection-events / policy-violations + its test). Mid-phase their
half-landed rewrite briefly failed the phase-4 policy-violations test
(verified not-phase-5 by stashing: clean tree passed); they fixed it
before phase close. No conflicts with phase 5 —
`countOpenPolicyViolations`'s signature contract held.

Live-verified against `npm run dev` (preview browser, signed in as
arda@viberr.dev): `/projects/viberr-core/tasks/VIB-142` renders the full
operator-first layout — hero (key/title/stage/readiness/validation pills +
real store path `projects/viberr-core/tasks/VIB-142/task.md`), packet card
with 4 observation rows + 3 options (rec preselected, "operator pick"
tag, primary button label = selected option title), execution profile
(operator "coordinator · stage 1" + shield glyph, Codex·Developer
specialist, Claude Code·Reviewer consultant chip, owner "Arda Kaya · you"
+ Manage ▾), truth strip (akin-ozer/viberr, PR #318 pill, branch, diff
9 files +412/−87, 3 commits, real "Open on GitHub" link), 9-event
timeline with all distinct node classes/pills/evidence rows. Selecting
"Request one edit" + resolve → packet cleared, `transition` decision
event with the authored `ev` text on top, readiness pill → ready,
Waiting on → Agent work, toast "Decision recorded: Request one edit".
Comment "@operator …" → toast "Comment posted · routed to mentioned
agent", `comment-card toagent` tint, mention span, draft cleared.
VIB-148 "Assign me" → toast "You own VIB-148 · review & acceptance" AND
the operator-scheduling reaction: operator `agent` event ("Acceptance
boundary now owned by **Arda Kaya** — scheduling execution against the
quality-gated scope.") above the assign event, readiness→ready,
waiting→Agent work. Manage ▾ menu (hand-off list minus owner/me,
Release…), release dialog (Owner/Open now/After obs rows, hand-off
chips, self copy) → "Ownership released on VIB-148". VIB-153 renders
Deniz's "app user · not in project" pill. VIB-160 (blocked packet,
continuity recovery options), VIB-139/141 (done, "accepted" pill, merged
PR), VIB-145 (unowned + "Assign me" in sidebar), VIB-151 (claude
specialist + codex consultant + admin own-x on Selin's seat), VIB-166
(triage: "coordinator · —", no operator pill, GitHub + timeline empty
states) all render. Bell packet row click-through lands on the task at
scroll-top with the packet in-viewport; board card click → detail with
"KEY · title" crumb (CSS truncation + full-text title attr). Browser
console clean (no errors/warnings). Server stopped, `npm run seed --
--reset` restored the pristine demo store.

No new deps. No new migrations. No CSS additions (the port reproduces
the mock's inline styles verbatim per spec §7; every class used already
exists in the ported viberr.css).

## File inventory

```
app/
  ui/
    rich-text.tsx                      # THE shared micro-format renderer (ruling 14):
                                       # **bold** / `code` / @mention; mentions=false = RichA variant
    rich-text.test.tsx                 # [jsdom] tokenizer contract incl. no-nesting, RichA mode
  features/task-detail/
    event-meta.ts                      # EVENT_META + typedKind (contracts §1.3, verbatim)
    timeline-slice.ts                  # progressive disclosure: clampTimelineLimit/sliceTimeline
    timeline-slice.test.ts             # slice math, clamping, hostile params
    decision-packet.tsx                # packet card: radiogroup (+arrow-key roving), rec preselect,
                                       # busy-disable, Ask operator
    execution-profile.tsx              # ExecutionProfile + OwnerControl (Manage ▾ menu) + the
                                       # TaskMemberView/OwnerAction types
    release-confirm.tsx                # packet-styled alertdialog (useDialog: trap/Escape/restore)
    timeline.tsx                       # Timeline (filters, composer, show-older) + TimelineItem
    runtime-slots.tsx                  # ═ PHASE 8 MOUNT POINTS ═ LiveRunSlot + AgentLogsSlot
                                       # (render null until runtime data exists; logSel wiring ready)
    task-detail-page.tsx               # root layout + hero + DiagnosticsPanel + GithubTrace +
                                       # Current state + PolicyPanel + fetcher/toast plumbing
    task-detail-components.test.tsx    # [jsdom] packet card, TimelineItem across all 9 types +
                                       # guest/toagent/evidence variants, ReleaseConfirm self/admin
    task-detail-route.server.test.ts   # route-level: VIB-142 loader fidelity, slicing, comment
                                       # routing, resolve dispatch + RBAC, ownership matrix,
                                       # VIB-148 scheduling, transition boundaries
  routes/project.task.tsx              # REPLACED phase-4 placeholder: full loader (detail +
                                       # timeline slice + tlDefault pref) + action (6 intents) +
                                       # kept meta/ErrorBoundary (in-shell 404)
  server/tasks/task-actions.server.ts  # + operatorSchedulesOnOwner + scheduling reaction in
                                       # setOwner (see below); audit details +operatorScheduled
```

## Route contract (unchanged for the shell, extended for phase 6)

Loader returns `{ task, timelineTotal, timelineHasMore, timelineRemaining,
timelineNextLimit, tlDefault }` where `task` = `getTaskDetail(...)` with
`timeline` REPLACED by the bounded newest-first slice (`?events=` param,
default 30, step 30, capped at the total; `clampTimelineLimit` sanitizes).
The crumb contract survives (`task.key`/`task.title` under route id
`"routes/project.task"`); members/myRole/user still come from the layout
loader (`useRouteLoaderData("routes/project")`) — the task route adds no
duplicate membership query.

Action intents (POST to the task URL, `_csrf` + `intent` fields; every
success returns `{ ok: true, toast }` — **the §5 verbatim toast copy
lives in this action**, errors return `data({ ok:false, error }, status)`):

| intent | fields | server fn | notes |
|---|---|---|---|
| `comment` | `text` | appendComment | returns `toAgent`; toast routed/plain variants |
| `resolve-packet` | `option` (index) | resolvePacket | returns `kind`; block_on_policy adds `navigateTo: …/settings`; 409 when already resolved |
| `owner-take` | — | setOwner(self) | may fire operator scheduling (below) |
| `owner-assign` | `userId` | setOwner | toast "Ownership handed to {First}" |
| `owner-release` | — | releaseOwner | returns `forced`; admin toast variant computed from the pre-release owner |
| `transition` | `to` (stage id) | transitionStage | no UI affordance yet (see decisions #4) |

## Operator scheduling (VIB-148 rule) — now implemented server-side

The brief said "phase-3 implements" — it did NOT (verified by grep before
building); phase 5 added it to `setOwner` as the documented Phase-8
stand-in. Generalized condition (contracts §3.3 / shell §5.2), evaluated
on the pre-mutation parse: task was **unowned** AND operator attached AND
`waiting === "human"` AND no open packet AND the newest operator (`agent`)
event's text starts with `**Quality gate:**` (that operator event IS the
"quality-gated" marker in the store — see VIB-148's seeded timeline).
Reaction inside the same atomic file write: `readiness → ready`,
`waiting → agent`, operator-authored `agent` event (actor ref `operator`,
same occurredAt as the assign event, prepended above it):
`Acceptance boundary now owned by **{Owner Name}** — scheduling execution
against the quality-gated scope.` Audit details carry
`operatorScheduled: true`. It cannot double-fire (after the reaction
`waiting === "agent"`), applies to take AND hand-off into an empty seat,
and Phase 8 should MOVE this block into the operator runtime's reaction
path (grep for `operatorSchedulesOnOwner`).

## Decisions / deviations

1. **tweaks-panel.jsx NOT ported** (ruling 8 — dev harness, dead code);
   BUILD-PLAN's "port tweaks-panel.jsx" line is overruled on record.
   review.jsx: only the packet/acceptance MECHANICS live here (resolve
   action + copy); the queue surface stays Phase 9 (`app/features/review/`).
2. **Packet body renders as plain text** (mock behavior kept, spec §8.2
   left open): backticks in `body`/observation values show literally.
   Flip to `<RichText/>` later if product decides — one-line change in
   decision-packet.tsx.
3. **"operator active" head pill renders only when `task.operator`
   exists** (mock showed it unconditionally; spec §8.7 says reflect
   reality). Real runtime states replace this in Phase 8.
4. **No stage-transition affordance on task detail** — the mock defines
   none (packets carry the governed decisions); inventing one would break
   mock parity. The `transition` action intent + route tests exist so the
   server boundary rules (auto→member, approval/human→admin|maintainer,
   review→done human-only) are exercised at route level; Phase 8/9
   surfaces can reuse the intent.
5. **Timeline slice bound = 30** (`?events=` param, "Show older events ·
   N more" ghost button, `preventScrollReset`). Chosen under the 40-event
   compression guardrail; seeded histories (≤9) never show the button —
   covered by unit + route tests instead.
6. **"Open on GitHub" is a real external link** (spec: toast goes away):
   PR URL when a PR exists, else branch tree URL; omitted when no repo.
   Phase 7 may refine targets (compare view).
7. **DiagnosticsPanel added** (brief: "diagnostics display where the
   projection carries them"): compact `.packet-obs` list under the hero,
   rendered only when the projection has findings; severity → pill kind
   (error→blocked, warning→input, info→neutral). Phase 10's console
   replaces it. Note: mutating a freshly-seeded task BEFORE the seed's
   latest wall-clock time (10:31 local) surfaces a benign
   `timeline.out_of_order` info finding — that's the phase-3 documented
   near-future-seed quirk, not a phase-5 bug.
8. **Toast copy computed in the route action** (not the client): the
   admin-release variant needs the pre-release owner's name, and one
   server-side source keeps the §5 strings verbatim for every caller.
   Errors (409 packet race, ownership conflicts) also surface as toasts
   per spec §7 "show a toast, not a crash" — the only non-success toasts
   in the app; revalidation has already refreshed the panel by then.
9. **Ownership identity by user id everywhere** (ruling 6): OwnerControl/
   ReleaseConfirm/sidebar compare `owner.userId === me.id`; members come
   from the layout loader (no `window.VIBERR`), all considered active
   (project.md membership has no status field).
10. **Remount-on-task-switch** via `<TaskDetailPage key={task.key}>`
    (resets composer draft, filter, dialogs, logSel — mock contract §1).
11. **Manage menu additions**: Escape-close added (spec asked); hand-off
    list = members − owner − me (menu) vs members − owner, me-first
    (dialog chips) — both exactly per mock.
12. **`tlDefault`** read from `user_prefs` key `"tlDefault"` (values
    `all|typed|comment`, tolerant fallback `all`). Phase 9's profile
    preferences UI should write the same key.
13. **jsdom smoke tests target the presentational pieces** (packet card,
    TimelineItem, ReleaseConfirm); composer/fetcher wiring is covered at
    route level (routing detection, draft-clearing logic is trivial
    effect code).

## Integration points for later phases

**Phase 6 (SSE revalidation).** The task route is pure loader/action —
`useRevalidator().revalidate()` on `task.updated` for
`{projectSlug, taskKey}` refreshes everything (packet presence, pills,
owner, timeline slice) with zero component changes; the layout loader
already revalidates rail counts + bell on the same tick. There is no
client-held governed state anywhere on the surface (only draft text,
filter tab, dialog/menu open flags, ask counter — all survive
revalidation because events/props are keyed by stable event ids). The
`?events=` param survives revalidation (it's URL state). Emitter is
already wired: every mutation path ends in `rebuildPath` → projection
event.

**Phase 8 (runtimes).** Mount points are `app/features/task-detail/
runtime-slots.tsx` — replace `LiveRunSlot`/`AgentLogsSlot` bodies with
the runs.jsx ports; `TaskDetailPage` already holds the `logSel` state +
setter pair the spec's parent-held selection contract requires, and the
layout positions (hero → run strip → packet / profile → agent logs →
timeline) are fixed. Feed `runtime` through the task route loader.
Also: move the `operatorSchedulesOnOwner` reaction out of `setOwner`
into the operator runtime, and replace decisions #3's static pill.

**Phase 9 (review queue).** RQRow's "open" navigation is the task route;
packet resolution mechanics (kinds, toasts, notification read-marking)
are done — the queue only lists and links. `app/features/review/` is
still unclaimed.

**Phase 10 (audit & recovery).** DiagnosticsPanel (task-detail-page.tsx)
is the placeholder to replace with the diagnostics console; it already
consumes `TaskDetail.diagnostics`.

## Known gaps (intentional)

- No SSE yet: after ANOTHER user's action, the page updates on next
  navigation/action revalidation (own actions revalidate immediately).
- Runtime strip/agent logs render nothing (no runtime data source until
  Phase 8) — deliberate per brief, incl. suppressing the mock's
  "No agent runs yet" empty state until the real panel exists.
- No @-mention autocomplete in the composer (mock had none; spec §8.5
  leaves the grammar open).
- Accept-completion still flips the mirrored `pr.state` only (ruling 12
  stand-in); the real async merge + failure state is Phase 7's — the
  Phase-7 agent's reconciler work was already appearing in the tree
  during this phase.
- Radiogroup roving uses Arrow keys but does not manage tabindex
  (buttons stay individually tabbable, like the mock).
