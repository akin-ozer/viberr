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
