# Reconcile recon — cluster: ux-surfaces

Session A = this worktree (branch `claude/viberr-app-inspection-4e5bf2`, partly uncommitted, advisory).
Session B = `origin/pass19/product-fixes` (PR #154, settled). B's 24 UX-coherence fixes land in ONE commit,
`fe11c0a` ("fix(ux): 24 coherence defects"), plus satellites: `1836f00` (copy/a11y), `650e650` (.obs overlap),
`ddfa2f1` (quiet-chip naming), `e4973a5` (e2e board-drop confirm), `e90ab16` (health probe, board quiet, store),
`9ea40cd` (run-inputs disclosure). B's finding IDs in this domain: `UX-nn` / `UX19-nn` / `UXV19-n` / `F19-nn` /
`Gap-10` / `P19-G11` — do NOT equate B's F19-nn with A's F19-nn by number (though F19-5/F19-8/F19-9/F19-12/F19-13/F19-16
happen to coincide in meaning; B's F19-23/F19-24/F19-25/F19-27/F19-28 do NOT mean what A's do).

---

## 1. What Session B built, file by file

### Notifications (B-only surface — A untouched)
- **`app/features/notifications/notification-meta.ts`** — B's F19-24, the headline "completion report" pill fix, TWO halves:
  1. `ntfMeta`: non-blocked packet was `{icon:"check", cls:"act-completion"}` (completion checkmark on a scoping
     question); now `{icon:"hand", cls:"act-policy"}` — `hand` is the app's existing "waiting on a human" glyph
     (board WaitTag), `act-policy` matches `.pill.input`.
  2. `ntfPill`: the FALL-THROUGH `{kind:"input", label:"completion report"}` is gone. Packets:
     `blocked ? "blocked decision" : "decision required"`. Anything else gets the UI-57 honest fallback
     `{kind:"info", label: n.kind || "notification"}` — it names itself, never borrows decision vocabulary.
  Load-bearing note in the docblock: the label is DERIVED from `ptype` because the row doesn't carry the packet's
  stored `kind` string; B documents the honest end state (thread `packetKind` through `listNotifications`) as future work.
- **`app/features/notifications/notifications-page.tsx`** — B's F19-25: `unread` prop is the BELL BADGE number and
  F18-1 deliberately excludes orphan rows (project deleted out-of-band) from it, but the page RENDERS those rows with
  unread dots. Header said "all caught up" over visible unread rows and withdrew "Mark all read".
  Fix: `shownUnread = unread + items.filter(n => n.unread && n.targetMissing).length` (disjoint sets by construction,
  no double count); header text and Mark-all-read gating both use `shownUnread`.
- **`app/features/shell/top-bell.tsx`** — same F19-25 formula in the bell popover (fix duplicated across the two
  surfaces, small enough not to matter).
- Tests: `notification-item.test.tsx` re-fixtures titles to the literal `operatorOpenPacket` shape
  ("Decision needed: …"); `notifications-page.test.tsx` adds orphan-count and no-double-count tests.

### Home (B-only)
- **`new-project-modal.tsx` + `home-page.tsx`** — B's UX #14: the zero-connections note was a live link into
  `/org/settings` for EVERY reader; a member (project creation is deliberately self-serve) clicked it into a bare 403.
  New `isAdmin?: boolean` prop (home-page passes `user.role === "admin"`); fallback when absent:
  `storeRoot !== null` — the loader already encodes the admin fact there (`user.role === "admin" ? VIBERR_DATA_ROOT : null`),
  so the gate never guesses "admin". Member branch names the authority ("an org admin adds the PAT … Ask an admin").
  UX #20: the server refusal `.form-err` gets `role="alert"` (success already toasts; only the failure was silent).
- **`home-sections.tsx`** — archived-projects lede now says "A project admin can restore one…" instead of pointing
  every reader at Danger zone.
- **`new-project-modal.test.tsx`** (new) — pins admin-keeps-link / member-gets-authority / storeRoot fallback / role=alert.

### Org settings (B-only)
- **`users-panel.tsx`** — UX #20 twice: invite modal's and edit modal's `.cred-warn` server-refusal divs get
  `role="alert"` (the panel's other refusals toast; only the server's "no" was unannounced). + `users-panel.test.tsx`.

### Shell command palette (B-only)
- **`command-search.server.ts`** — two fixes:
  1. B's F19-8/R14-3: this is the one reader that queries `task_projections` directly, so it inherited none of the
     archived-exclusion contract and ranked a just-archived task FIRST. Not excluded (the palette is a legitimate way
     back, like the board's Archived chip) — LABELLED: selects `archived`, `archivedSub()` appends "· archived" to
     task and branch hit sublines.
  2. B's F19-16: agent hits linked the bare roster, which auto-opens the OPERATOR pane
     (`sel = searchParams.get("profile") ?? "operator"`) — deterministically the wrong agent. Now
     `href=…/agents?profile=<encodeURIComponent(agent.id)>` (`agent.id` = `resolved.profileId`, the same deep link the
     Policy page uses). A did not touch `agents-page.tsx`, so the `?profile=` consumer is intact post-merge.

### Runtime / runs console (B-only — A only touched `run-artifact-routes.server.test.ts`)
- **`runtime-types.ts`** — P19-G11: `RunInputs` interface (cwd/repo/cloned, personaChars, promptChars, verbatim
  `anchor`, skills {granted/native/injected}, knowledge, mcp {mounted/unresolved/unhealthy}, unresolvedResources,
  tools {denied/toolkit}, directive) + `RUN_INPUTS_TAG = "run·inputs"` + `isRunInputsLine`. Design: names-and-sizes,
  not bodies — EXCEPT the canonical anchor, carried verbatim because it exists nowhere else. The writer lives in the
  run starters (specialist-run/operator-run — server cluster's domain).
- **`runs-helpers.ts`** —
  - `hoistRunInputs()`: moves each `run·inputs` line to the head of its OWN block (blocks = UI-53 run boundaries),
    fixing the start-up sequence race; never crosses a boundary, never drops a line.
  - `runInputRows()`: pure `RunInputs → console rows` projection; EVERY row states its absence explicitly
    ("none granted", "no canonical task state") — absences are the point of the surface.
  - `roleShort()` UXV19-3: rendered copy "primary"→"delivering", "reviewer"→"supporting" (kind LITERALS stay
    internal); same mapping the Agents roster uses.
- **`runs-panels.tsx`** — AgentPicker option label now `runStatePill(r).label` (UXV19-5: `RUN_STATE` render
  projection collapsed interrupted/queued to "idle" four lines from the pill saying "interrupted"); the dot keeps the
  CSS render-state class. Expandable run-inputs disclosure (keyed on `entry.line.raw` so it survives streaming/paging,
  `aria-expanded` on the toggle, `raw` toggle wins). **WARNING: uses an inline `style={{whiteSpace:"pre-wrap"}}`-via-spread
  on the anchor row — see §5, it collides with A's app.css gates.**

### Agents
- **`agents-page.tsx`** (B-only) — UX19-11: DeleteConfirm's copy was false both ways ("threads keep running until the
  operator reassigns them"): R15-7 makes an unresolvable profile FULLY conservative (no delivery/comment/ask/evidence),
  and nothing auto-reassigns. New copy states both and names the human's next step. `project.agents.tsx` toast reworded
  to match.
- **`create-profile-modal.tsx`** (BOTH modified — see §2).
- **`capability-matrix-modal.tsx`** (BOTH modified — see §2).
- **`app/server/projections/agent-deployments.server.ts`** (B-only) — UXV19-7: `operatorStatus` derived "packet open"
  from `waiting === "human"` ALONE; roster was the only surface naming an ARTIFACT where every other names the STATE,
  and the only one that could be false. Now `operatorStatus(waiting, hasPacket)` — SQL adds
  `CASE WHEN packet_json IS NOT NULL AND packet_json <> '' THEN 1…` — falls back to "waiting on human".

### Health endpoint (B-only)
- **`resources.health.ts` + test** — liveness/readiness split on one route. Default = liveness (200 unless SQLite is
  dead); `?probe=readiness|ready` → 503 when `degraded[]` non-empty. Degraded = dead store watcher, dead KB watcher,
  missing single-writer lock, disk low/critical (`cachedDataRootSpace`, 5s TTL — route is unauthenticated and polled).
  DELIBERATELY not degraded: unavailable backends (a Claude-only deploy is correct; R17-5 neutral-not-alarming) and
  unmeasurable disk. Adds `status: ok|degraded|down`, `disk`, `maintenance` (pruner heartbeat), `build` fields.
  Signature is `loader(args?: { request?: Request })` with a defensive `requestedProbe()` so a bare `loader()` call
  gets liveness. Depends on B-only `app/server/ops/{disk-space,maintenance,build-info}.server.ts` (ops cluster).

### Board
- **`board-filters.ts` + test** (B-only file) — Gap-10: new `quiet` filter id + `FilterableTask.quiet?: boolean`.
  Load-bearing: the flag is SERVER-derived (`isQuiet`, `task-activity.server.ts`) — the client must not re-derive a
  time-dependent verdict or SSR/hydration disagree. Deliberately its OWN chip, not a clause in "Blocked or waiting"
  (that filter selects ASSERTED states; quiet is an inference from absence — R16-2 name-the-chip-for-what-it-selects).
- **`board-page.tsx`** (BOTH — the domain's hardest merge, see §2): B adds `BoardTask extends TaskSummary`
  (`lastActivityAt?`, `quiet?` — optional because `routes/project.tsx`'s annotate erased them; B fixed that too, below),
  `QuietTag` (neutral pill, "no activity · <LocalRelative>", renders only past threshold; LocalRelative because
  relative text depends on NOW), the "No activity" chip + tally (`quietCount` over liveTasks), B's own F19-8 archived
  handling and B's F19-13/UXV19-6 list-row pill duplication.
- Chip label history: `ddfa2f1` renamed the chip to "No activity" because the HOME project card already uses "quiet"
  for `running === 0` (healthy, nothing in flight) — two meanings one click apart. Keep the name "No activity".
- **`routes/project.tsx`** (BOTH, see §2): B = F19-9 rail-badge fix + generic `annotate<T extends TaskSummary>` (the
  type fix Gap-10 NEEDS to flow `quiet`/`lastActivityAt` to the board) + `ArchivedBanner` extracted with
  `canRestore = roleCan(myRole, "edit-policy")` (UX #15 — Q-V1 hides Danger zone from non-holders, so the banner now
  names "a project admin" instead of routing everyone to a panel they don't have).

### e2e
- **`e2e/01-home-board.spec.ts`** (`e4973a5`, B-only) — replaces the pre-ruling-53 Done-drop test (asserted the OLD
  drop→POST→error-toast flow; **CI has been red on main since** the board-drop confirm landed) with two tests:
  (1) drop asks first — dialog `aria-label="Accept completion"`, contains task key + "Merging is one-way";
  "Not yet" dismisses with ZERO posts; (2) confirming via `/^Accept →/` still meets the server's verdict gate
  (error toast, snap-back). **Verified against A's tree**: `board-page.tsx:832` has the aria-label, `:912` has
  "Accept → {stageName}", `accept-confirm.tsx` has "Not yet" (:332) and "Merging is one-way" (:325-327) — the spec
  should pass on A's implementation as-is, but A's accept-confirm has UNCOMMITTED edits in flight; re-run after the
  acceptance cluster merges.

### CSS
- **`app.css`** — one B hunk: `.obs { grid-template-columns: minmax(92px, max-content) 1fr }` (B's F19-23 — the fixed
  92px label column let "RECOMMENDATION", added by B's F19-3 acceptance-dialog work, print over its value).
- **`app.css.test.ts`** — one B describe: pins `.obs` uses `minmax(` and not a leading `92px`.

---

## 2. Same concern, different mechanism — verdicts

### `board-page.tsx` — B's per-view pills vs A's shared `StateSignals` → **A's architecture wins; port B's Gap-10 onto it**
Both fixed "the list row lacks the card's pills" (B: F19-13 + UXV19-6; A: F19-13) and both silenced archived cards
(both call it F19-8, same semantics: archived pill replaces readiness, obligation pills dropped, no Move/drag, list
row same, live neighbor still moves). Mechanisms differ:
- B duplicates the pill block INLINE into the list row (its own comment preaches "one board, two views, one
  vocabulary" while implementing it twice).
- A extracts **one `StateSignals` component** (PR-state → checks → review → validation → wait, archived→null) rendered
  by card AND `ListRow`; archived swaps in `ArchivedPill` (lock glyph + "archived" — the task hero's exact vocabulary).
- A additionally holds **D19/R19-10** (owner-ruled, B has no counterpart): roving tab stop across cards in both
  layouts, `role="list"`/`listitem"` lanes, `useRovingStageMenu` covering the Move trigger, `ListRow` extraction
  (hooks can't live in a `.map`).
Single-shared-implementation beats per-surface forks, and A carries a later owner ruling → **rebuild on A's file; graft
B's additions**: `BoardTask` type + `QuietTag` (render it inside `StateSignals` between validation and WaitTag — the
archived-null branch then gives B's `!archived && <QuietTag/>` for free), the `quiet` FILTERS entry
(label "No activity", icon "clock") + FilterBar `quiet` tally + `quietCount`, and the `visible()`/props re-typing.
Keep A's `ArchivedPill` (lock icon): B's tests only `toContain("archived")` so they pass against it.
Both test files added F19-8/F19-13 suites — union them (they assert the same behavior; duplication is harmless).
A's F19-27 board-confirm suites are acceptance-cluster property, untouched by B's board tests.

### `capability-matrix-modal.tsx` — the SAME `<li>` at the SAME insertion point → **pick ONE paragraph, drop the other's test**
Both add the Claude-native vs Codex-injected skills disclosure (both cite F19-16/R18-5, both quote
`SKILL_INJECTION_BUDGET` = 24,000). The prose differs and **each session pinned its own copy in
`agents-page.test.tsx`** (A: "discloses that granted skills are SDK-native on Claude…"; B: "…installed on Claude but
pasted under a budget elsewhere") — both tests cannot survive verbatim. Opinion: **keep A's paragraph** — it states two
facts B's omits ("announced as omitted" for a skill that no longer fits; the second fallback trigger — another live
run holding the workspace) — optionally appending B's closing advice sentence ("Keep a skill short if agents on both
backends must follow it"), and keep A's pinning test, deleting/adapting B's.

### `create-profile-modal.tsx` — **B is a strict superset; take B's file, keep A's tests**
A: F19-35 `aria-expanded` on both accordions + F19-5 `aria-pressed` on resource chips. B: the SAME two fixes (UX-21
adds conditional `aria-controls` too; B's chips comment even says "F19-5") PLUS: UX-13 locked segs for
`ALWAYS_HUMAN_CAPABILITY_IDS` (picker refuses what `agent-profile-actions.server.ts` rewrites; verdict row drops
"Human-only" since the server persists `off` for it) with a lock note; widened `seedCaps` (ANY non-`direct` stored
verdict seeds `off` — exactly what the save layer persists); UX-19 roving-radio arrow keys + single tab stop (module
`~/ui/roving-radio` already exists on main); UX-23 collapsed-summary counts get mode WORDS + the `.d.off` swatch.
A's two test blocks (F19-35, F19-5) pass against B's implementation — keep them alongside B's five UX-nn tests.
**Cross-check vs A's rulings**: R19-6 says capability `off` = hard refuse — B's UX-13 (don't offer modes the server
discards) points the same direction; no contradiction found in this file.

### `routes/project.tsx` — same F19-9, plus B-only extras → **B's file + A's predicate + A's comment**
Identical rail-badge fix (badges counted archived tasks; both destinations exclude them). A filters with the shared
`isArchived()` predicate + a long contract comment; B uses `t.archived !== true` inline. Take B's file (it also
carries the Gap-10 generic `annotate` typing and the `ArchivedBanner`/`canRestore` split — both must survive), swap
in A's `isArchived` import/predicate (single-shared-implementation), keep A's expanded docblock. A's
`project.server.test.ts` (new) and B's `project.test.tsx` (new) are different files — both land; they overlap on
F19-9 assertions harmlessly.

### `copy-ban.test.ts` — **UNION, then re-pin A's allowlists (real landmine)**
- B appends one describe: F19-12 retired-vocabulary line-scan (`/primary specialists?\b/i`) over NON-test sources in
  `features/routes/server/shared`, comments stripped, allowlist only the persisted id `assign-primary-specialist`.
- A rebuilt the F18-14 govern gate entirely (F19-39, two verifier rounds): string-LITERAL lexer scan over every
  pure-TS root, a coverage ASSERTION over `readdirSync(app/)` (new dirs fail until classified), marker-only
  exemptions, `app.css` joins the render scan, and **`ALLOWED_ASSET_LINES` — seed-asset prompt sentences exempted BY
  EXACT STRING with a rot check**.
- A also adds `retired-vocabulary.test.tsx` (new file): artifact-level F19-12 residuals — asserts the SHIPPED seeded
  files, `GOVERNED_TEMPLATE`, and the rendered recommendation chip, not source lines. Keep BOTH F19-12 gates: B's
  walk skips `.test.` files so A's regex literal doesn't trip it, and they police different layers.
- **Landmines**: (1) A's `ALLOWED_ASSET_LINES`/`ALLOWED_LITERALS` pin exact sentences from
  `operator.definition.md` / `operator-run.server.ts` / seed assets — B REWROTE `operator.definition.md`,
  `agent-catalog.server.ts`, `developer-expertise.skill.md`; after the merge the by-name entries and their rot checks
  will need re-pinning against the merged sentences. (2) B's F19-12 scan covers all of `app/server` + `app/shared`
  non-test code: any "primary specialist" STRING surviving from either side fails it (comments are safe). Run both
  gates first after every resolution round in this area.

### Small shared files (trivial conflicts, both sides kept)
- **`app/shared/capabilities.ts`**: identical F19-12 rename (`"Assign the delivering agent"`, id untouched — both
  sessions justified it identically). B additionally adds the `update-task-branch` capability + its
  `ENFORCED_CAPABILITY_IDS` entry (N19-9, owner-ruled). Merge = A's fuller comment (it documents the
  `capabilityByLabel` seed trap) + B's new capability rows.
- **`agents-route.server.test.ts`**: both flipped the same assertion to "Assign the delivering agent". A goes
  further: pins id-level resolution (`capabilityId === "assign-primary-specialist"` mode direct, NOT in `extras` —
  guards the label-drift-to-extra trap) and rewrites the non-member test to F19-28's 404-not-403 (A's R15-4 work).
  **A's version wins wholesale; B's one-line change is subsumed.**
- **`routes/project.agents.tsx`**: disjoint hunks — A's F19-28 loader guard comment/behavior + B's honest delete
  toast. Keep both.
- **`review-helpers.ts`** (review cluster's file, flagged here for the interface): A adds `state: PrState` (F19-32),
  B adds `lastActivityAt`/`quiet` (Gap-10). Same interface, disjoint fields — union. B's UXV19-1 (review-page reads
  the capability label from the catalog BY ID) actively protects the F19-12 rename both sessions made.
- **`operator-recommendations.tsx`**: both chose the IDENTICAL string `run_specialist: "Run delivering agent"`.
  A's hunk is that one label; B's file has larger acceptance-cluster changes around it. No fight.
- **`execution-profile.tsx`**: A's change is F19-11 only (eligibility sentence into the cell VALUE); B's 277-line
  rework contains its own F19-11 fix PLUS `EngagementVocabulary` (one vocabulary object for the whole cell), UX19-12
  (ghost engagement: Run disabled + names why), UX19-18 (popovers drop `role="menu"` for the UI-45 focus contract),
  R19-A autonomy-ceiling display. **B supersedes A here** — verify A's F19-11 sentence semantics survive
  (B's comment claims the same fix), then task-detail cluster owns the rest.
- **`settings-page.tsx`**: disjoint — B's UX #22 (visible labels on invite inputs) + #20 note (its refusal slot
  already announces; do NOT add a second `role="alert"` — see §5), A's F19-33 (panel-head counts). Keep both.
- **`app.css` / `app.css.test.ts`**: A's hunks (`.btn.full` wrap F19-42, `.continuity-panel`, `.cont-live`,
  `.pev-sub` R19-7) and B's hunk (`.obs` minmax) are DISJOINT rules → both land. Test file: A adds ~1,280 lines of
  gates (F19-42 wrap gate, F19-33 hoisted-style scan, R19-12 both-theme contrast sweep with baselined exceptions +
  rot guards, width-gating — some still in flight/uncommitted); B adds one 21-line `.obs` describe. **Policy is
  UNION — append B's describe into A's file; nothing in B's minmax value trips A's parsers (standard CSS).**

---

## 3. Pure Session-B additions (no A counterpart — auto-merge), with risks

Auto-merging clean: `notification-meta.ts`, `notifications-page.{tsx,test.tsx}`, `notification-item.test.tsx`,
`top-bell.tsx`, `home-page.tsx`, `home-sections.tsx`, `new-project-modal.{tsx,test.tsx}`, `users-panel.{tsx,test.tsx}`,
`command-search.server.{ts,test.ts}`, `runs-helpers.{ts,test.ts}`, `runs-panels.{tsx,test.tsx}`, `runtime-types.ts`,
`agents-page.tsx`, `agent-deployments.server.{ts,test.ts}`, `resources.health.{ts,test.ts}`,
`board-filters.{ts,test.ts}`, `e2e/01-home-board.spec.ts`, `project.test.tsx`.

Risks on the auto-merges:
1. **`runs-panels.tsx` inline style vs A's CSS gates** — B renders the verbatim-anchor row with
   `{...(row.pre ? { style: { whiteSpace: "pre-wrap" } } : {})}`. It textually evades main's P16-F3 `style={{` scan
   (spread form), but A's F19-33 gate exists precisely to close hoisting/indirection escapes and its in-flight width
   gates may widen the scan. Cheapest durable fix: add a `.lx.pre { white-space: pre-wrap }` rule and a class toggle.
2. **`resources.health.ts`** — `loader(args?)` optional-arg signature is unusual; fine under React Router (it always
   passes args) but any A-side direct `loader()` test keeps working by design. Docs for the probe live in B's
   `docs/operations/{runbook,deployment}.md` — `runbook.md` is ALSO modified by A → docs cluster must union.
3. **Gap-10's server legs live outside this cluster** — `task-activity.server.ts` (`isQuiet`, thresholds),
   `board-query.server.ts` annotations (B's 69-line change vs A's 5-line change → conflict, server cluster), and
   `review-helpers` fields. If any leg is dropped, `QuietTag` never renders and the chip tallies 0 — degradation is
   silent-but-safe by design ("a missing signal must never invent a cue"), but the chip would still be offered; keep
   the legs together or drop the feature whole.
4. **e2e spec pins dialog copy** owned by the acceptance cluster (`accept-confirm.tsx`, board confirm) — currently
   satisfied by A's tree (verified: aria-label, "Not yet", `Accept → `, "Merging is one-way") but A's files there are
   uncommitted; re-verify the four pinned strings after that cluster resolves.
5. **`command-search` "· archived" sublabel + B's F19-8** assumes `task_projections.archived` — schema col exists on
   main; no A migration touches it. Safe.
6. B's notifications `hand` icon and `act-policy` class both exist on main (WaitTag / event-meta) — no CSS additions
   needed; A's R19-12 contrast sweep will pick the pairing up automatically since it derives inputs from the sheet.

---

## 4. Textual conflicts in this domain (both sides modified vs main)

Will conflict; resolution per §2:
- `app/features/board/board-page.tsx` — **hardest**; rebuild on A, graft B's Gap-10 (§2).
- `app/features/board/board-page.test.tsx` — union of overlapping F19-8/F19-13 suites + B's Gap-10 suite + A's
  F19-27/D19 suites.
- `app/features/agents/capability-matrix-modal.tsx` — same `<li>`, pick one paragraph (§2).
- `app/features/agents/agents-page.test.tsx` — both append at end; union, EXCEPT keep only the chosen
  skills-asymmetry copy test.
- `app/features/agents/create-profile-modal.tsx` — take B (superset).
- `app/features/agents/agents-route.server.test.ts` — take A (superset).
- `app/routes/project.tsx` — B's file + A's `isArchived` + A's docblock.
- `app/routes/project.agents.tsx` — disjoint hunks, keep both.
- `app/shared/capabilities.ts` — A's comment + B's `update-task-branch` rows.
- `app/features/copy-ban.test.ts` — union describes; then RE-PIN A's exact-sentence allowlists against B's rewritten
  seed assets (§2 landmine).
- `app/app.css`, `app/app.css.test.ts` — disjoint hunks/gates; union (B's one describe appends). A's side is partly
  uncommitted ("in flight") — merge against whatever A settles.
- Shared-with-other-clusters but flagged here: `settings-page.{tsx,test.tsx}`, `execution-profile.tsx`,
  `operator-recommendations.tsx`, `task-main-sections.tsx` (B UX19-10 backend-honesty vs A F19-3 — disjoint hunks),
  `decision-packet.tsx`, `review-helpers.ts`, `board-query.server.ts`, `docs/operations/runbook.md`.

## 5. Semantic collisions that will NOT conflict textually

1. **Skills-asymmetry copy vs BOTH pinning tests** — the two `agents-page.test.tsx` additions merge textually
   (different hunks) but assert two different paragraphs for one `<li>`; whichever copy is chosen, the other test
   fails. Must be resolved by hand (§2).
2. **Double archive-packet ceremony risk — actually COMPOSES, verify it** — B's `PacketArchiveConfirm`
   (`decision-packet.tsx`, UX19-9: alertdialog naming the branch, "cannot be undone", what the archive withdraws;
   deliberately a LOCAL dialog, not a second AcceptDisclosure provider, because ruling 17 gives branch deletion one
   surface) intercepts `archive_task` options; A's task-detail-page intercepts `accept_completion` options with the
   shared AcceptConfirm (F19-7) and adds the UX19-4 redeliver note + "deletes branch" pill. Kinds are DISJOINT so no
   double dialog — but the merged `onResolve` interposition logic must route each kind to exactly one ceremony, and
   A's "deletes branch" pill + UX19-4 note should sit alongside B's dialog, not be dropped as superseded.
3. **Double-announcement of modal refusals** — B added `role="alert"` in four places (new-project, invite, edit-user;
   deliberately NOT the settings slot that already announces — B's #20 note says adding it there "would announce the
   same refusal twice"). A's a11y passes touched neighboring surfaces; when merging any refusal slot both sides
   touched, keep exactly ONE announcing mechanism per slot (toast OR role=alert, per B's own rule).
4. **A's app.css gates vs B's new markup** — B's inline pre-wrap style in `runs-panels.tsx` (§3.1); also B's
   `QuietTag`/"No activity" pill and locked cap-segs introduce new class pairings that A's R19-12 contrast sweep and
   width gates will scan on first run post-merge — expect baseline churn, not code bugs.
5. **Vocabulary gates vs B's server strings** — B's F19-12 line-scan (features/routes/server/shared) and A's
   artifact-level `retired-vocabulary.test.tsx` both run post-merge; every seed asset / template / chip B or A
   reworded must satisfy BOTH. Conversely A's F19-39 govern-literal gate scans everything B added (health route,
   runs-helpers copy, packet dialog copy) for "govern*" — B's copy looks clean but nobody has run A's lexer over B's
   tree yet: do that before declaring the merge green.
6. **"quiet" the word** — B renamed the board chip to "No activity" precisely because home's project card uses
   "quiet" for `running === 0`. Any A-side surface that later adopts the word (activity page, recovery panel) must
   respect the same split: `quiet` = healthy-idle (home), `no activity` = past-threshold silence (board/review).
7. **`roleShort` "supporting"/"delivering" (UXV19-3)** vs A's review/engagement vocabulary work — same shipped
   vocabulary by design (both map to the F10-20/Agents-roster words); if the task-detail cluster picks different
   engagement nouns, the runs picker must follow, not fork.
