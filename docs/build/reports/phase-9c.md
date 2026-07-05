# Phase 9C report — Feeds & personal surfaces (Review queue · Activity · Notifications · Profile)

Status: complete. Gates at close: `npm run typecheck` clean, `npm test`
**722/722** green (651 prior + 71 new), `npm run build` clean (only the
pre-existing RR v8 future-flag warnings). Live-verified end to end (see
"Live verification"); store re-seeded pristine after
(`npm run seed -- --reset` → identical counts, clean-tree rescan
0 changed / 13 unchanged, arda's unread back to 6, VIB-142 back at
review/human, seeded violation `open`).

No new deps. **No migration 0009** — nothing needed a net-new table: the
review queue and activity stream are projections over the existing
`task_projections`/`task_events`, the audit panel reads the real
`scope_violations` + `audit_events` tables, notifications were seeded in
phase 3, and every profile preference rides the phase-4 `user_prefs`
key-value table. routes.ts untouched (placeholder/minimal route CONTENTS
replaced only). seed.ts untouched.

## File inventory

```
app/
  server/projections/
    review-queue.server.ts     [test]  # getReviewQueue: stage='review' split on
                                       #   waiting (review+none → still-with-agents),
                                       #   packet header + newest-event text per row
    activity-feed.server.ts    [test]  # listActivityStream (task_events flattened,
                                       #   occurred_at DESC, title folded **T.** t) +
                                       #   listAuditLog (scope_violations ⊕ whitelisted
                                       #   audit_events → violation/blockedact/change/
                                       #   audit entries w/ per-row open/resolved)
  features/review/                     # NEW (the phase-5 report's unclaimed dir)
    review-page.tsx                    # ReviewQueuePage + RQRow, mock 1:1 (copy
                                       #   verbatim; wait-tag "your acceptance" stays
                                       #   divergent from the board per ruling 14)
    review-page.test.tsx       [jsdom] # header counts, chip, rows, empty states
    review-route.server.test.ts        # auth/404/seed split/subline precedence
  features/activity/                   # NEW
    activity-page.tsx                  # ActivityPage + AuditLogs + ACT_ICON/PEV_META
                                       #   + groupStreamByDay/auditTimeLabel helpers
    activity-page.test.tsx     [jsdom] # grouping/filter/empty copy/violation pills
    activity-route.server.test.ts      # loader shape, 32-event stream, audit rows
    rich-text-shared.test.ts           # ruling-14 guard: no feature forks the
                                       #   tokenizer; 9C surfaces import ~/ui/rich-text
  features/notifications/             # EXTENDED (phase-4 files kept)
    notification-meta.ts               # + ntfPill (kind→type-pill; meta/stripper
                                       #   unchanged — still the ONE shared copy)
    notifications-page.tsx             # full page: NtfNeedsYou cards + NtfStream
                                       #   day groups + All/Unread + splitNotifications
    notifications-page.test.tsx [jsdom]# split/filter/pills/dots/keybtn/empty copy
    notifications-route.server.test.ts # sort DESC, cross-project soft refs, resolve
                                       #   auto-mark (verified, not rebuilt), read-all
  features/profile/                    # NEW
    notification-prefs.ts              # PROFILE_NTF verbatim + defaults + THE plural↔
                                       #   singular kind map + schema-only email/nudge
    profile-query.server.ts            # getProfileView (memberships most-active-first,
                                       #   derived access role, prefs, hasPassword,
                                       #   githubConnected := users.idp === 'github')
    profile-actions.server.ts          # identity save, notif/motion/tlDefault prefs,
                                       #   changeOwnPassword (phase-2 scrypt machinery,
                                       #   kills OTHER sessions), github disconnect
    profile-page.tsx                   # all panels incl. MOUNTED ProfileAppearance
                                       #   (ruling 13) + Change-password panel
    profile-page.test.tsx      [jsdom] # appearance mount, RBAC per role, toggles,
                                       #   password validation, degraded no-membership
    profile-route.server.test.ts       # loader shape, all 6 intents, CSRF, guards
  routes/
    project.review.tsx                 # REPLACED placeholder: projection loader only
    project.activity.tsx               # REPLACED placeholder: stream + audit loader
    notifications.tsx                  # REPLACED minimal page: full surface in the
                                       #   same PageOverlay route; + user-scope SSE
    profile.tsx                        # REPLACED minimal page: full loader + 6-intent
                                       #   action (identity/set-notif/set-motion/
                                       #   set-tl-default/change-password/gh-disconnect)
  root.tsx                             # ADDITIVE: loader reads user_prefs "motion" →
                                       #   <html data-motion> SSR (the CSS hook existed
                                       #   since phase 1; phase-2 report deferred the
                                       #   wiring to phase 9)
```

No CSS additions — every class (rq-\*, pol-ev/pev-\*, act-\*, ntf-\*,
profile-\*, pref-row, cred-card, rbac-yes/no, login-err) was already in
the ported app.css.

## Surface notes

**Review queue** (`/projects/:slug/review`). Read-only, zero mutations:
rows navigate to task detail, the `hero-file` policy chip (tooltip kept)
navigates to Policy. Split is project-wide (ruling 10, labels unchanged);
qualification is the literal `stage === 'review'` — the same predicate as
the rail badge, so the "X of Y" pair and the badge share one projection.
`review + waiting:none` lands in "Still with agents" 1:1 (contracts §2.2)
— covered by a dedicated test. Subline precedence verbatim (packet
`kind — title` → newest event text through the shared `plainText`
stripper → the boundary placeholder). Row order: task-key number ASC
(deterministic; reproduces the mock's seed rendering — spec §8.2 decided
here). Rows leave live via the existing shell SSE revalidation — verified
both directions (acceptance removed VIB-142; a disk edit moved VIB-145
between panels with no navigation).

**Activity** (`/projects/:slug/activity`). Stream = ONE query over
`task_events` (`occurred_at DESC, id DESC`, capped at 200 — pagination is
an open Phase-10 question), `title` folded as `**{title}.** {text}` (mock
`norm()`), day-grouped at render with the ruling-4 formatter (the mock's
`evMins`/`"now"`/`DAY_ORDER` hacks are gone). Actor filter
All/Humans/Agents/System on `actor.kind` (client state, mock parity),
never touches the audit panel. Rich text renders through
`app/ui/rich-text.tsx` with `mentions={false}` (the RichA variant) —
enforced by the import-path guard test. Authored empty states per spec:
"No events match this filter." / "No activity yet." / "No policy or
access events yet."

**Audit panel** reads the REAL tables: `scope_violations` rows render as
`violation` entries with their own open/resolved pill (ruling 5; display
text composed from the scope so the task chip completes the sentence,
mock-style), and `audit_events` rows map through an explicit whitelist →
`change` (policy/stage/member/settings/agent-profile/credential actions),
`blockedact` (`github.pr.merge_refused`), `audit`
(`task.ownership.admin_released`, `runtime.run.interrupted`) with
per-action readable text templates (actor names resolved by user id,
label fallback). Unlisted actions (auth noise, task comments, org-level
events) stay out. Sparse on a fresh seed by design — the seeded VIB-142
violation is the one guaranteed row; the panel fills as 9A/9B-style
governed actions happen (the dev DB showed role/boundary/stage/credential
change rows from the 9A live pass immediately). Audit times render the
mock's freeform style, generated: `today 9:38` / `yesterday 16:04` /
`Mar 30`.

**Notifications** (`/notifications`, PageOverlay route kept from
phase 4). Full notifications.jsx port: "Waiting on you" packet/approval
`rq-row` cards (type pills via the new shared `ntfPill`, inline unread
dot, mono task key + rich text subline) + "Everything else" day-grouped
stream (row click marks read only; the keybtn is the navigation
affordance and stopPropagations, exactly like the mock), All/Unread
filter, "Mark all read" with the verbatim toast. All reads go through the
ONE existing `/notifications/read` action; single-row marking is guarded
client-side to skip already-read rows (state is monotonic). Cross-project
rows navigate for real into the stub projects (DEP-31 lands on Deploy
Pipeline's in-shell 404 task panel — the phase-4 sanctioned dead end).
Packet/approval resolution auto-marking was VERIFIED against the phase-3
`resolvePacket` path (route-level test + observed live: accepting VIB-142
dropped the page to 5 unread without touching the bell). The overlay now
subscribes to the `user` SSE scope itself (phase-6 report listed overlay
routes as unsubscribed; one hook call closes that gap).

**Profile** (`/profile`, PageOverlay route kept). Loader widens the
session user (ruling 6) via `getProfileView`: real user row (never the
hash — `hasPassword` only), memberships from `project_members` by id
ordered most-active-project-first, access role = highest membership role,
prefs from `user_prefs`. Panels: Identity (dirty-only blur/Enter commit —
the mock's commit-on-every-blur is fixed per spec §7.7; membership kv
rows with role pills; signs-in-via; joined), Notification routing (5
`PROFILE_NTF` rows, app toggle only, ruling 13 — email/nudge stay
schema-only in `notification-prefs.ts`), **Appearance & workspace
MOUNTED** (theme via the existing `/prefs/theme` mechanism; reduce-motion
→ `user_prefs` + SSR `<html data-motion>` through the additive root
wiring; timeline default writes the phase-5 `tlDefault` key), Your access
(shared `RBAC_ROWS` from features/policy indexed by the REAL role,
pol-note keybtn → first membership's Policy; degrades to "No project
membership yet." + plain-text note), GitHub identity (state DERIVED from
`users.idp` per ruling 13; Connect is a real link into
`/auth/github?returnTo=/profile`; Disconnect flips idp→local with a
no-password lockout guard + audit `identity.github.disconnected`),
Change password (new panel per spec §7.8: current/new/confirm, login-flow
validation copy, scrypt via phase-2 `password.server`, signs out every
OTHER session, audit `auth.password.changed`; hidden for passwordless
accounts).

## Decisions / deviations

1. **root.tsx touched (additive)** — outside the 9C ownership list, but
   ruling 13's "MOUNT the Appearance panel" needs `data-motion` on
   `<html>` and the phase-2 report explicitly deferred that wiring to
   phase 9. Minimal change: root loader reads the `motion` user_pref
   (SQLite is the truth — no new cookie), Layout renders the attribute;
   profile applies it optimistically client-side. Signed-out pages
   default `full`.
2. **Project pill / keybtn prefix on the notifications page renders for
   EVERY row** with a known project (spec §8 open question C resolved as
   "always show"): the page is a global cross-project surface and the
   mock's `!== "Viberr Core"` literal was flagged as prototype leakage
   that must not survive. Bell popover behavior unchanged (it always
   showed the project).
3. **GitHub identity semantics**: with no personal-identity-link table
   and OAuth unconfigured in dev, connected := `users.idp === "github"`
   (the account signs in through GitHub). Connected copy attributes to
   the user's **email** (no GitHub handle is stored anywhere — the
   phase-2 callback keeps only the verified email); the masked-token slot
   renders honestly ("oauth" / "—", no fake `gho_…`). Connect starts the
   REAL phase-2 OAuth flow (unconfigured deployments land on the honest
   /login banner). A proper identity-link record (handle capture at
   callback time) is follow-up work if attribution-by-handle matters.
4. **Review-queue ordering** = key number ASC in both panels (spec §8.2's
   queue-time proposal would need packet-raised timestamps the projection
   doesn't carry; key order is deterministic and matches the mock's
   rendering).
5. **Audit-panel violation text is composed from the record's scope**
   ("Project credential is missing `{scope}` — flagged by the policy
   engine on" + chip) rather than rendering the row's `detail` blob —
   avoids the seeded detail's duplicated task key and keeps the mock's
   chip-completes-the-sentence convention.
6. **`markRead` on the page skips already-read rows** (the mock POSTs
   redundantly on every click; the server is idempotent either way).
7. **Password change keeps the acting session** (deletes only other
   sessions) — forced-reset's full rotation stays reserved for the
   admin-reset flow; toast: "Password updated — other sessions were
   signed out".
8. **Membership ordering** is task-count DESC then name — the first
   membership drives the "Profile saved — visible to {project} members"
   toast and the Policy/Settings links, so it should be the project the
   user actually works in (alphabetical would have picked the
   billing-service stub for arda).
9. **"Your access" shows the HIGHEST role across memberships** (mock was
   single-project). Per-project access display is a fine Phase-10+
   refinement; the RBAC matrix itself is imported from
   `features/policy/policy-data.ts`, never restated.
10. **Identity toast is membership-parameterized** ("… visible to
    {first project} members", plain "Profile saved" with no memberships)
    — the mock hard-coded "Viberr Core".
11. **Stream/audit caps**: activity stream 200 rows, audit log 60,
    notifications page 200 — documented limits instead of pagination
    (spec §8.1/G open questions; Phase 10 can add "load more").
12. `data-screen-label` attributes kept (ruling 16 app-wide decision).

## What Phase 10 should deepen in the audit panel

- **The whitelist** (`AUDIT_ACTION_KINDS` in activity-feed.server.ts) is
  the seam: today it maps ~19 actions with per-action text templates and
  drops everything else. Phase 10's audit console should replace this
  with a complete, filterable view over `audit_events` (org + project
  scope, actor filter, action-family grouping) — the 9A/9B reports carry
  full action/details tables.
- **Blocked agent actions**: only `github.pr.merge_refused` exists today.
  When the capability-enforcement engine lands (direct/recommend/human
  modes on agent-triggered actions), its `blockedact`-style audit rows
  should flow into the same kind so the mock's "Blocked: Developer
  (Codex) attempted **Merge a pull request**" row becomes real.
- **Runtime-session audit**: the mock's "Murat opened the Developer
  runtime session" row has no producer yet (`runtime.run.interrupted` is
  the only runtime audit action); wire session-open auditing in the
  runtime layer and add the action to the map.
- **Violation ↔ resolution correlation**: the panel shows per-row
  open/resolved from `scope_violations`; Phase 10 could link the resolved
  pill to the resolving `github.scope_violation.resolved` audit event +
  the typed policy timeline event (activity spec §8.6).
- **Retention/pagination** for both the stream (200-row cap) and the
  audit list (60-row cap), plus the Policy header's "last change" chip
  deep-linking into a filtered audit view (9A report suggestion).

## Live verification (dev :5173, preview browser)

`npm run seed -- --reset`, `npm run dev`, signed in as arda@viberr.dev.
Browser console: **zero warnings/errors** for the whole pass.

- **/projects/viberr-core/review**: header "2 tasks at the review
  boundary · 1 waiting on your acceptance", rail badge 2; panel 1 =
  VIB-142 (packet subline verbatim, PR #318 info pill, "evidence
  changed", "your acceptance" tag), panel 2 = VIB-145 (stripped
  transition-request subline, pulsing "agent working"); pol-note + chip
  tooltip verbatim. **Accepted VIB-142's completion via the real
  resolve-packet action while the queue stayed open → the row left
  panel 1 live** (header → "1 task … · 0 waiting", exact empty copy).
  Reverse live check: disk-editing VIB-145 `waiting: agent→human` moved
  it into panel 1 ~2 s later with zero navigation (watcher → SSE →
  revalidation). Row click → task detail; policy chip → /policy.
- **/projects/viberr-core/activity**: subtitle with the real project
  name; Stream "33 events" (32 seeded + the acceptance decision event)
  day-grouped with actors/rich text/keybtn chips/times; System filter →
  "1 events", only Policy engine rows, empty day groups dropped, audit
  panel untouched. Audit panel showed the REAL tables: the seeded
  VIB-142 violation (`open` pill, "today …" time) plus the dev DB's 9A
  history (role/boundary/stage/member/credential `change` rows, an
  `audit` runtime-interrupt row with task chip) — sparse-degradation and
  richness both observed.
- **/notifications**: "Waiting on you" 5 decision cards + "Everything
  else" Today/Yesterday stream; unread was **5** on arrival — the
  acceptance had already auto-marked VIB-142's packet row (phase-5
  contract verified live). DEP-31 card click → real navigation to
  `/projects/deploy-pipeline/tasks/DEP-31` (stub project shell, designed
  404 panel) and marked the row read. Unread filter → "3 decisions" + 1
  stream row; Mark all read → verbatim toast, subtitle "· all caught
  up", button gone, both exact empty states, bell badge cleared.
- **/profile**: all six panels (Appearance MOUNTED); identity title edit
  → blur commit → toast "Profile saved — visible to Viberr Core members"
  (task-count-first membership ordering); memberships kv listed all 3
  projects with role pills; "Your access" admin pill + 9/9 grants; theme
  Dark → `data-theme="dark"` instantly AND after full reload (cookie +
  users.theme); Reduce motion → `data-motion="reduce"` instantly AND
  after reload (user_prefs → root SSR); "Timeline opens on “Important”"
  curly-quote toast; notif toggle off/on round trip with verbatim
  toasts; GitHub panel honest not-connected state (miss chips, real
  Connect href); Change password panel present (3 fields); Escape closes
  the overlay. All mutated prefs/fields restored, server stopped,
  `npm run seed -- --reset` → pristine (counts identical, rescan
  0 changed / 13 unchanged, unread 6, VIB-142 review/human, violation
  open).

## Known gaps (intentional)

- Notification fan-out does not yet filter by the routing prefs
  (ruling 13: display-only in V1; the fan-out lives in phase-3
  task-actions). The plural↔singular map ships ready
  (`notification-prefs.ts`).
- Email channel + nudge prefs remain schema-only (no mailer).
- GitHub identity stores no handle (decision 3) — attribution renders
  the workspace email.
- Activity/audit/notifications have caps, not pagination (decision 11).
- The motion cookie-less SSR reads `user_prefs` on every document
  request (one indexed SQLite get — measured negligible).
