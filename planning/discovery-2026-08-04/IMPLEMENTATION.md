# Implementation record — pass 16 (2026-08-04)

Tracks what was actually changed, by whom, with the canary evidence. Owner rulings R16-1..R16-4 are in FINDINGS.md.

## Wave 1 — correctness (R16-4: correctness first, with tests)

Four workstreams, disjoint file ownership so they can run concurrently.

| WS | Owns | Items |
|----|------|-------|
| WS1 delivery/acceptance | `app/server/github/**`, `app/server/tasks/task-actions.server.ts`, `app/features/task-detail/**` | R16-1 (stale-PR adoption), A2 (acceptance head gate universal), A3 (delivery failure modes + shallow-clone guard), B9, B11, R16-3 (refusal ordering + hide force-accept), E3 (task-detail action ids + Permissions panel honesty) |
| WS2 operator loop | `operator-actions/-toolkit.server.ts`, `operator-run.server.ts`, `run-recovery.server.ts`, `seed/assets/operator.*.md` | A4 (undeployed operator can deliver), A6 (persona provenance + MCP governance), B1–B8, B10 |
| WS3 runtime/resources | `app/server/runtimes/**` (minus operator-run, run-recovery), `org/**`, `secrets/**`, `files/**`, `tasks/specialist-*`, `tasks/agent-toolkit`, `package.json` | A1 (env leak in model probe), A5 (skill symlink containment), A8 (destructive scope probe), A9 (silent MCP cred downgrade), C1 (silent KB/skill grant misses), C2 (skill budget), C4 (rename/watcher race), C5, C6 (phantom dep), D1 (Codex home misconfig diagnostic), D2 |
| WS4 RBAC/board | `app/shared/rbac.ts`, `features/policy/**`, `features/board/**`, `routes/project.board.tsx`, `auth/project-authority`, `auth/csrf`, review-queue projection | E1 (display contradicts enforcement), E2 (403 leak), E5 (fail-open predicate), R16-2 (attention filter + rename), CSRF origin fail-closed, RBAC test matrix for 8 undriven actions |

### Wave 1 outcome — LANDED (commit `5e03c6e`, 89 files, +6331/−661)

Gates at commit: **2609 unit tests / 209 files green, `npm run typecheck` clean.**

Highlights beyond the literal backlog items:

- **R16-1 was traced to its real source.** The reconciler was only one of three adoption
  sites; `workspace-delivery.server.ts` was what actually bound PR #113 to VIB-4 (it asked
  `gh pr view <branch>` and took whatever came back, any state). One rule now governs all
  three: `app/server/github/pr-adoption.server.ts`, adopting only an OPEN PR whose head sha
  IS the delivered revision — identity, not containment, deliberately stricter than the
  acceptance gate (which tolerates a commit on top of the delivery).
- **A2 was fixed structurally**, not per-caller: the head gate moved inside
  `applyAcceptanceWrite`, the shared Done write, so `operatorAcceptCompletion` is covered
  without editing the operator, and force cannot relax it. Because a network read cannot
  run under the file lock, the verified (PR, revision) pair is re-asserted inside the lock.
- **E1 was fixed by deleting the concept**, not editing the sentence: `appWide` is gone from
  `rbac.ts`, so the Policy table, the Profile page and the task Permissions panel now all
  read the one matrix and cannot drift apart again.
- **The action matrix itself is now pinned** (`policy-rbac.server.test.ts`). The existing
  matrix test derived its expectation from the same map it guarded, so widening a tier
  passed silently — proven by canary, then closed.
- **A1 was a live credential leak**, not a theoretical one: the Claude model probe spawned
  with the full server environment (GitHub PAT, session secret, encryption key, every
  provider key) and the operator's own `~/.claude`, reachable from the agent-edit UI.

Corrections made to this pass's own documents (recorded so they are not re-derived):

- `DOMAIN-MODEL.md` §12 item 26 was wrong about `scanStoreTree`; the real symlink hole was
  `subDirNames`, in the opposite direction. Corrected in place.
- A "phantom KB grant" I started fixing in the seed catalog is already handled by
  `default-assets.server.ts` (`kbGrants: false` on the backfill path). Reverted; recorded as
  FINDINGS H16 so it is not "fixed" again.
- An apparent contrast bug and an apparent mention-menu bug were both harness artifacts
  (stale `getComputedStyle`; the menu deliberately requires one character after `@`).

## Wave 2 — UI/UX (R16-4: then the full UI list)

Source: UI-INVENTORY.md §8 (27 rough edges) + live walkthrough items F1–F20 in FINDINGS.md.
Grouped so each agent owns a disjoint slice:

- **UI-A shell & primitives**: app-wide `:focus-visible` ring; the 10 orphan class names + `.composer-box`
  `position: relative`; dead `--font-display` duplicate + dead token block; `.card.wait-human` no-op;
  `.board-wrap::after` always-on fade; `.stg-x` drift; `.gh-table .live-head` grid override leak;
  unbounded toast stack; `<select>` design-system rule.
- **UI-B interaction patterns**: one shared popover hook to replace the 6 hand-rolled Escape+outside-click
  implementations; unify the 3 "row actions on hover" idioms (and make them touch-reachable); settings-page
  stage list still uses hand-rolled HTML5 drag *with a grip* — the opposite affordance from the board
  (dnd-kit, whole-card, no grip); KB browser is a third drag idiom.
- **UI-C accessibility**: ⌘K listbox structure (`role=combobox`/`aria-activedescendant`, options as direct
  children) — the composer next door already does it right and is the model; `.mention` chips are colour-only;
  only two `aria-live` regions app-wide; mobile rail scrim is a clickable `aria-hidden` button; extend the axe
  sweep to activity / project settings / github / org settings / profile / notifications AND to dialogs in
  their open state.
- **UI-D copy & small truths**: "1 instance accounts" pluralization; `input_required` chip wording alignment
  with the renamed "Blocked or waiting" filter; audit timestamps ("today 0:18"); new-task dialog showing
  "A title is required" before first input; new-project repo-name auto-derive appending after manual edit;
  PAT input `type="text"` despite "never displayed"; home footer exposing Re-scan / Rebuild projections as
  bare buttons on the landing surface; profile copy "customized for Viberr Core" on a project named Viberr;
  Agents page showing a profile "available" when its backend has no credential (task view already tells the
  truth); board card not surfacing a closed/declined PR.
- **UI-E structure**: split the three >1200-line files (task-detail-page 1761, home-page 1691,
  resources-panel 1471) along their existing seams; move the 184 inline `style={{}}` blocks that are static
  typography/colour into the sheet.

## Verification protocol (every wave)

1. `npm run typecheck` (`react-router typegen && tsc`) — required gate; `npm run build` does NOT typecheck.
2. `npm test` (vitest).
3. Live UI verification in the running dev server with screenshots for anything user-visible.
4. `npm run e2e` (production-image compose stack) — run ONCE at the end, by the parent only, after the dev
   server is stopped (single-writer rule).

### Wave 2 outcome — LANDED (commit `53b796d`, 63 files, +6379/−3022)

Gates at commit: **2722 unit tests / 213 files green, `npm run typecheck` clean.**

What the wave actually turned up, beyond the listed items:

- **The app's only live region was inert whenever a dialog was open.** The toast host entered
  the top layer at the same instant its first message appeared, and that is precisely the case
  screen readers do not announce — so every dialog-driven confirmation in the product was
  silent. The fix takes the slot empty and commits the message a frame later. `aria-atomic` is
  `false`, not `true`: `role="status"` implies `true`, which would re-read the whole (now
  4-deep) stack on every arrival. My original instruction said `true` and was wrong.
- **Project settings dragged stages with a grip and reordered optimistically** — the exact
  opposite of the board's whole-card, server-authoritative language, which had rejected the
  grip on purpose. Worse, dragging onto a neighbour POSTed a no-op reorder and toasted success
  for a change that never happened.
- **A CSS/TSX integrity test now scans every className in `app/` against the sheet** (628
  classes, no allowlist) and caught a regression mid-wave. `CLASSLESS_BY_DESIGN` is empty.

Two findings were closed as NOT bugs after investigation, and are recorded in FINDINGS.md (H14,
H16) so a later pass does not re-file them.

## Post-wave-2 verification — two real regressions caught by the extended gates

Running the full production-image e2e stack after wave 2 failed twice, and both were mine:

- **Dark-theme contrast on org settings.** The global `button` reset took `font`, `color` and
  `cursor` but never `background`, so any button whose class declares no surface kept the UA
  `ButtonFace` — which Chrome resolves PER COLOR-SCHEME (#efefef light, #6b6b6b dark). The
  settings tab rail (`.nav-item`) painted that mid-grey block in dark mode: `--muted` at 3.2:1
  and its `.count` at 1.9:1. Measured live before and after (9.81:1 and 6.64:1 now). Fixed at
  the root — `background: none` in the element reset, so the next such button is covered — and
  pinned in `app.css.test.ts`. This existed before the pass; only extending the axe sweep to
  org settings in BOTH themes exposed it. A live sweep of every audited surface found exactly
  one other UA-background control (`.rail-toggle`), which is `display:none` above its media
  query and so never painted.
- **The ⌘K e2e spec broke on the a11y fix.** Giving the palette input `role="combobox"`
  REPLACES its implicit `textbox` role, so `getByRole("textbox")` matched nothing. The spec now
  asks for the combobox — the shape the palette should be held to.

## Wave 3 — closing the backlog honestly

Before writing an outcome record I ran a **disposition audit**: seven agents, one per findings
section, each determining every item's true state from the tree rather than from the commit
messages. Result over 70 items: 42 fixed, 3 not-a-bug, 7 owner-question, **7 open, 11 partial**.
Several "fixed" items were fixed only in part, and the audit named exactly what was left. That
list became wave 3.

| WS | Owns | Items |
|----|------|-------|
| W1 RBAC display | `project-settings/settings-page`, `policy/policy-page`, `task-detail/decision-packet`, `projections/notifications`, `home/home-query` | E3-rest (MembersPanel action id), E4 (disabled controls with no reason), E6 (two answers to "waiting on you") |
| W2 review queue | `features/review/**`, `projections/rebuilder`, `projections/review-queue` | G2 (terminal GitHub facts outrank process gates in the QUEUE too) |
| W3 mentions | `ui/rich-text`, `task-detail/timeline` | F20 (chip only real names; multi-word names chip whole) |
| W4 runtime hygiene | `server/runtimes/**`, `specialist-run`, `secrets/pat-validator`, `org/resources`, `files/**` | D4 (allowedTools never reaches a run, cannot survive resume), D5 (three lying docstrings), B3, B11-rest, A5-followup, C5-followup |
| W6 repo hygiene | `vitest.config`, `.dockerignore`, `db/migrations/0001_baseline.sql`, `auth/identity`, `profile-actions`, `seed/default-assets`, `.env.example` | E8, G7, G8, G10, B7-rest |
| W7 structure | `features/home/**` | F10 (the one >1200-line file wave 2 missed) |
| W5 stylesheet | `app.css`, `app.css.test.ts`, `style={{}}` props app-wide | F3, F6-rest, F7-rest, F8-rest, G3 |

Parent-held work (files no workstream owned): R16-5, R16-6, and the five handoffs the
workstreams reported.

### Two items came back as "not a defect" — and that is the useful result

- **`verification` is not a dead table.** It reads as dead (no app query names it) and pass 16
  came within one edit of dropping it. better-auth writes it on every social sign-in, so
  dropping it kills GitHub login — and nothing in the suite would have said so. It is now
  pinned by `migration-runner.server.test.ts` with the reason, canaried by deleting the CREATE
  TABLE.
- **`task_projections.repo` is load-bearing**, not dead: the task-detail GitHub links render
  off it. Only the stale comment was wrong. Removing the column is a real product change, not
  hygiene, so it was not done under a hygiene brief.

### Wave 3 outcome — LANDED

Gates: **2794 unit tests / 213 files green, `npm run typecheck` clean.**

What the wave produced beyond closing the list:

- **E3 is now tier-coincidence-proof.** The remaining `myRole === "admin"` literal in
  project settings was replaced by the action id each panel's own SERVER guard checks —
  which turned out not to be admin: `edit-policy` governs the identity, stages and repo
  panels, `manage-members` only the members panel. The new tests mock `roleCan` to answer
  for exactly ONE action id, so swapping two ids that resolve to the same role tier today
  still fails. A role-tier assertion would have caught none of the three canary swaps.
- **E4 was two different defects wearing one number.** The policy radios were disabled with
  no visible reason at all; the decision-packet Confirm button put its reason in `title` on
  a `disabled` element, which can never surface it — while the option radios twelve lines
  above used `aria-disabled` and their titles *did* work. Role refusals are now
  `aria-disabled` + a refusing click handler (so the control keeps focus and its
  description), with the reason as visible text bound by `aria-describedby`; `busy` and
  "no options" stay genuinely `disabled`. `title` is gone, asserted by test.
- **E6 was resolved in code, not in a comment.** Both surfaces now call one
  `indexDecisionInbox`, which makes the mine/override-eligible split once. The conclusion —
  an org admin's override reach is governance, not a personal inbox item — is now
  structurally impossible to answer two ways.
- **F3 is enforced, not documented.** 182 → 20 inline styles, and the new test parses each
  surviving style object and fails any site whose values are all literals. The rule it
  encodes: a literal value is a design decision and belongs in the sheet where a
  theme/density/breakpoint rule can reach it; a value read at runtime belongs in the markup.
- **F8's mechanism is consolidation, and the test says why.** Custom properties do not work
  inside media queries and `@custom-media` needs build config this project does not run, so
  the only mechanism that makes a half-update *inexpressible* is one occurrence. Nine
  `@media (max-width: 1100px)` blocks became one, and the whole nine-value breakpoint
  inventory is pinned with the job each does.
- **G3 was reclassified from question to defect and fixed.** Below 900px Home hid its search
  box outright and a global rule hid the `.kbd` chip below 1080px, so a phone lost both the
  project finder AND the only palette trigger — with a keyboard shortcut as the "answer".
  The box now collapses to a 36px magnifier button. New e2e assertions cover it at 375px.
- **One inconsistency surfaced by the F3 migration, not caused by it.** The board LIST row's
  task key matched no `.key` rule (every one is scoped to a container the row is not in), so
  it alone rendered in the body face. Fixed and pinned against the grid card's treatment.

Parent-held items landed alongside: R16-5 (MCP-outside-the-matrix disclosure + the test that
pins the *absence* of an `mcp__*` deny rule), R16-6's card half via the shared `prStatePill`
mapping, the C5 dedupe into an isomorphic `app/shared/text/store-extensions.ts` (the store
browser runs in the browser and cannot import a `.server` module), the `verification` gate,
and the five e2e filename references the renumbering left behind.

R16-6's review-queue half turned out to be structurally out of scope: the queue lists
review-stage tasks only, and a merge-pending task is in Done. It is surfaced on the board
card, the task detail page and the GitHub view instead.
