# Viberr — testing & infrastructure reference (pass 17, 2026-08-04)

Current-state reference for the test infrastructure, written for an agent with
no other context. Everything below was re-verified against the tree at
`main` @ `8541a32` (the pass-16 merge, PR #125) on 2026-08-04. Paths are
repo-relative from the repository root.

Stack: Node ≥ 26, React Router 8.3 (SSR, framework mode), React 19.2, Vite 8,
TypeScript 7.0.2, Vitest 4.1, Playwright 1.62, `node:sqlite` (built-in),
better-auth 1.6.25, Lexical 0.49, dnd-kit 0.5, chokidar 5.

---

## 0. Delta from the pass-16 doc

The pass-16 file is `planning/discovery-2026-08-04/TESTING-INFRA.md`. It was
written at `2442945`, **before** the three implementation waves
(`5e03c6e`, `53b796d`, `71fa506`, `0955ac9`). Some of it was corrected in place
during wave 3; the rest had drifted. What changed:

| # | Pass-16 doc says | Current truth |
|---|---|---|
| 1 | 207 test files / ~2478 executed tests | **213 files / 2796 collected tests**, verified with `npx vitest list` (2796 lines out). Zero `.skip`/`.todo` anywhere in `app/`. |
| 2 | 144 `*.server.test.ts`, 33 `*.test.tsx`, 34 jsdom-pragma files | **147 / 35 / 36**. Plain non-server `*.test.ts` = 31. (147 + 31 + 35 = 213.) |
| 3 | e2e: 7 specs + setup, **41 tests** | 7 specs + setup, **62 tests** (61 chromium + 1 setup). Per spec: 01 = 6, 02 = 5, 03 = 3, **04 = 6** (was 4), 05 = 7, 06 = 1, **07 = 33** (was 14). |
| 4 | `07-accessibility.spec.ts` audits 6 surfaces × 2 themes + login × 2 = 14 | **12 surfaces × 2 = 24, plus 3 dialogs audited OPEN × 2 = 6, plus 1 mobile-rail-overlay test, plus login signed-out × 2 = 33.** Wave 2's UI-C widened the sweep to every workspace view, both page-as-popup routes, org settings and three dialogs. |
| 5 | `app/app.css.test.ts` mentioned only in passing (numbering note + file map) | It is now a **1006-line gate over a 3936-line stylesheet** and one of the two most load-bearing test files in the repo. It grew +753 lines in wave 2/3. It gets its own section here (§2). |
| 6 | `.dockerignore` "excludes `e2e`, `design`, `planning`, `docs` but **not** `test-support` — that omission is what makes this work" | No longer an omission: `.dockerignore:21-29` now carries an explicit **"NOT excluded, on purpose: test-support/"** comment block (`:21-29`) naming the consequence (adding it kills `npm run e2e`, and the symptom is an empty board, not a missing file). |
| 7 | No mention of `ETXTBSY` | **Known transient flake:** the `npm run e2e` Docker build can fail with `ETXTBSY` on `node_modules/esbuild/bin/esbuild` during `npm ci`. Retry clears it. Do not chase it. (§8.3) |
| 8 | Recipe line refs: `use-dialog.ts:34-45`, `mention-composer.test.tsx:85-90 / :97-112 / :114-120 / :123` | Drifted. Now `use-dialog.ts:36-42` and `mention-composer.test.tsx:88-89 / :97 / :114 / :122`. Logic identical in both files. |
| 9 | Toast recipe = one two-phase-dismissal test | `app/ui/toast.test.tsx` grew +204 lines → **3 describes / 9 tests**. New: the **live-region ordering recipe** (`instrumentPopover`, the `show:0` assertion) and a 4-deep stack cap. The old fake-timer recipe still lands at the same lines. (§4.2, §4.3) |
| 10 | — | Six test files are new since pass-16 discovery: `app/features/shell/use-command-palette.test.tsx`, `app/routes/project-visibility-actions.server.test.ts`, `app/routes/project.board.server.test.ts`, `app/server/seed/agent-catalog.server.test.ts`, `app/shared/text/plural.test.ts`, `app/ui/use-dismiss.test.tsx`. **No test file was deleted.** |
| 11 | — | `package.json` gained one dependency, `@lexical/utils@0.49.0` (finding C6 — it was imported but not declared). No new *devDependency*, no new script. The script list is unchanged. |

**Already correct in the pass-16 doc — do not "re-fix" these.** Wave 3 edited
that file in place for: the e2e renumbering (`05..10` → `02..06`, with `07`
deliberately keeping its number), the `db/**/*.test.ts` glob removal from
`vitest.config.ts` (G10), the new §3.7b better-auth schema-refresh procedure
(G8), and the `.env.example` `VIBERR_DATA_ROOT=./docker-data` change (B7). All
four are still true and are restated below.

**Unchanged across all three waves** (verified by `git diff b557060..HEAD`):
`test-support/**` (every file), `scripts/**`, `playwright.config.ts`,
`compose.yml`, `compose.e2e.yml`, `Dockerfile`, `doctor.config.ts`,
`.react-doctor/false-positives.md`, `.github/workflows/ci.yml`,
`CONTRIBUTING.md`, `docs/testing*.md`. The only infra files the waves touched
were `.dockerignore`, `.env.example`, `vitest.config.ts`, `app/app.css`,
`app/app.css.test.ts` and the `e2e/` specs.

---

## 1. Test layout

### 1.1 Unit / integration (Vitest)

Config: `vitest.config.ts` (23 lines, whole file).

```
resolve.tsconfigPaths: true                           # :7  — Vite 8 resolves ~/* natively
environment: "node"                                   # :11 — default for the whole suite
setupFiles: ["./test-support/setup-env.ts",
             "./test-support/setup-dom.ts"]           # :15
include:    ["app/**/*.test.{ts,tsx}"]                # :21
```

Counts (verified 2026-08-04 at `8541a32`):

| metric | value | how to reproduce |
|---|---|---|
| test files | **213**, all under `app/**` | `npx vitest list --filesOnly \| wc -l` |
| collected tests | **2796** | `npx vitest list \| wc -l` (collection only — no server, no docker) |
| skipped / todo | **0** | `grep -rnE "\b(it\|test\|describe)\.(skip\|todo)\(" app` → empty |
| `*.server.test.ts` | 147 | |
| `*.test.tsx` (component) | 35 | |
| plain `*.test.ts` (non-server) | 31 | |
| files with `// @vitest-environment jsdom` | 36 | |

Wave gate records, for provenance: wave 1 `2609 / 209`, wave 2 `2722 / 213`,
wave 3 `2794 / 213`, plus 2 more from `0955ac9` (the Codex-login-home fix, whose
CI failure is itself a lesson — §4.7) = **2796 / 213**.

Densest directories: `app/server/tasks` (28), `app/server/runtimes` (15),
`app/server/projections` (12), `app/server/files` (11), `app/server/auth` (11),
`app/server/github` (10), `app/ui` (8), `app/server/org` (8),
`app/features/task-detail` (8).

**Conventions.**

- Tests are **colocated** next to the module: `foo.server.ts` →
  `foo.server.test.ts`, `board-page.tsx` → `board-page.test.tsx`. There is no
  `__tests__` directory anywhere.
- The suffix `.server.test.ts` is load-bearing **twice**: react-router never
  bundles `.server.` modules client-side, and `doctor.config.ts:16` ignores
  `**/*.server.test.ts` so synthetic PAT fixtures are not scanned as client
  secrets.
- **jsdom is opt-in per file** via the first-line pragma
  `// @vitest-environment jsdom` (e.g. `app/ui/toast.test.tsx:1`). The global
  environment is `node`; forget the pragma and `document` is undefined.
- Every component test file ends with `afterEach(() => cleanup())` from
  `@testing-library/react` (`app/ui/toast.test.tsx:13-16`).
- Route-level tests import the route module **dynamically, after**
  `setupAppTest()`, so the module graph reads the overridden env.
- **Every POST in a route test needs `_csrf`** in the form body.

**There is no `db/` test convention** — don't invent one. The `"db/**/*.test.ts"`
glob was removed in wave 3 (G10) after matching zero files ever since the
migrations were squashed; the reasoning is inlined as a comment at
`vitest.config.ts:16-20`. The migration-runner test lives at
`app/server/db/migration-runner.server.test.ts`; schema behaviour is asserted by
the projection suites that own the tables.

### 1.2 Setup file 1 — `test-support/setup-env.ts` (hermetic env)

Unchanged in the waves. Runs **before any app module loads**. Three jobs:

1. **Seed required secrets** (`:19-23`). `getEnv()` fail-fast-validates
   `VIBERR_SESSION_SECRET` and `VIBERR_SECRET_ENCRYPTION_KEY` at first call and
   several test paths reach it. Uses `??=` so an explicitly exported real value
   still wins. Encryption key is `Buffer.alloc(32, 7).toString("base64")` (the
   schema requires exactly 32 decoded bytes).
2. **Blank every provider credential** (`:44-54`): `ANTHROPIC_API_KEY`,
   `CLAUDE_CODE_OAUTH_TOKEN`, `VIBERR_CLAUDE_USE_CLI_AUTH`, `CODEX_ACCESS_TOKEN`,
   `CODEX_API_KEY`, `OPENAI_API_KEY`, `VIBERR_CODEX_USE_CLI_AUTH`. The risk is a
   **billable provider call from `npm test`** (F10-10).
   **Assign `""` — never `delete`.** `env.server.ts` calls `loadEnvFile()` at
   module scope, i.e. *after* this setup file, and it fills any key not present.
   A deleted key is "not present" and the developer's `.env` value comes right
   back; `""` counts as present. `??=` is equally wrong here (preserves ambient).
3. **Pin provider transcript stores to a fresh empty temp dir** (`:81-85`):
   `CLAUDE_CONFIG_DIR=<tmp>/claude-home` (with `projects/`) and
   `CODEX_HOME=<tmp>/codex-home` (with `sessions/`). An *existing but empty*
   store makes the continuity probe deterministically answer `missing`; a
   *nonexistent* store answers `unknown`. Before this pin the same test passed
   on CI and failed on any laptop that had run the app. `CODEX_HOME` is
   deliberately **not** in the blank-list — the dir has no `auth.json`, so
   `codexCliAuthUsable()` is false by construction.

**This file is itself under test.** `app/server/runtimes/harness-hermeticity.server.test.ts`
mirrors the scrub list and asserts `isBackendAvailable` reports false after a
real module-scope `loadEnvFile()`. It grew +81 lines in the waves. If you edit
the scrub list, edit both — the mirror is the point.

### 1.3 Setup file 2 — `test-support/setup-dom.ts` (jsdom shims)

Unchanged. Both guards are `typeof window !== "undefined"`, so the file no-ops
under node.

- **`HTMLDialogElement` polyfill** (`:7-22`): jsdom ships the class without
  `showModal()` / `show()` / `close()`. The shim toggles the `open` attribute and
  dispatches a `close` event with `returnValue`.
- **`ResizeObserver` stub** (`:29-36`): jsdom has none; `@dnd-kit` references it
  at import time (board drag-and-drop). Inert `observe/unobserve/disconnect`.
  Component tests never exercise real geometry, so an inert stub is the honest
  shape — do **not** upgrade it to something that fakes rects.

**Not shimmed, and deliberately so:** `showPopover()` / `hidePopover()`. The
toast host feature-detects (`toast.tsx:160`), so jsdom takes the non-popover
path by default; the live-region tests install their own instrumented stubs per
test and restore them in a `finally` (§4.3).

### 1.4 Other `test-support/` helpers

All unchanged in the waves.

| file | purpose |
|---|---|
| `test-db.ts` | `createTestDbContext()` → `makeDb()` (temp dir + `openDatabase` + `runMigrations`), `makeTempDir()`, `cleanup()` (closes DBs, rm -rf dirs). Pair with `afterEach(ctx.cleanup)`. |
| `test-store.ts` | `setupTestStore(ctx)` → migrated DB + temp data root + `viberr-core` project with 5 users at distinct roles: arda = project admin, murat = maintainer, selin = contributor, elif = viewer, deniz = non-member. Plus `writeProject`, `writeTask`, `baseTaskFrontmatter`. |
| `test-app.ts` | Route-level harness: points `process.env.VIBERR_DATA_ROOT` at a temp dir (`:42`), resets env + DB singletons, **installs the fake runtime** (`:62-63`), returns `{ db, dataRoot, cookieFor(userId), csrfFor(sessionId), request(url, init), cleanup() }`. `cookieFor` (`:85`) signs in through better-auth for real and resets that email's login rate-limit bucket first (`:104`) — the limiter is a per-process global shared by every test in the worker. `request()` sets `Origin: http://localhost:5173` (`:130`) so `assertTrustedOrigin` passes. `APP_TEST_PASSWORD = "test-harness-password-000"` (`:34`). |
| `fake-runtime.ts` | `installFakeRuntime()` (`:45`), `queueFakeRun()` (`:41`), and — important — `startedRunSpecs()` (`:32`) / `lastRunSpec()` (`:37`) so a test can assert **what a path SENT** to the runtime (prompt, denylist, mcpServers), not just what it returned. |
| `fake-github.ts` | `fakeGithubFetch(...)` responder table + `unreachableFetch()` (simulates `ENOTFOUND api.github.com`). |
| `demo-seed.ts` | The demo fixture (§3.2). Re-exports `SEED_DEFAULT_PASSWORD`. |
| `demo-data.ts` | 41 KB of the mock dataset: `SEED_PEOPLE`, `seedProjects`, `seedTasks`, `seedStubTasks`, `seedNotifications`. |
| `audit-log.ts` | `listAuditEvents(db, …)` for asserting audit rows. |
| `custom-board.ts` | `CUSTOM_3_STAGE_BOARD` — non-governed workflow fixture. |

### 1.5 E2E (Playwright)

`e2e/` — 7 spec files + 1 setup file. **62 tests total** (61 chromium + the
setup login). All numbers below re-counted from the files.

| file | tests | purpose |
|---|---|---|
| `auth.setup.ts` | 1 (setup project) | Logs in through the **real `/login` UI** as `arda@viberr.dev` / `viberr-dev-2828` (`SEED_DEFAULT_PASSWORD`, imported from `test-support/demo-seed`), saves storage state to `e2e/.auth/arda.json`. Waits `networkidle` then retries the whole fill+submit inside `expect(...).toPass({timeout: 30_000})` — the inputs are React-controlled, so a fill landing before hydration gets wiped. |
| `01-home-board.spec.ts` | 6 | Home lists the three seeded projects; viberr-core board renders stage columns with VIB-142 in Review; **4 dnd-kit drag scenarios with real pointer input** (same-stage non-append slot on the wire, cross-stage append onto a column body, Escape cancels with zero requests, Done-stage drop without an accepted verdict refused with an error toast). Helpers: `column()`, `reorderPost()` (asserts on the submitted `intent=reorder` POST body), `liftOver()` (`mouse.down` → `mouse.move(..., {steps: 12})`). |
| `02-feeds-profile.spec.ts` | 5 | Review queue partitions VIB-142 correctly and its rows name their primary action (R15-11); activity feed renders day-grouped events; notifications mark-all-read clears every unread row; profile theme switch persists across reload. |
| `03-org-settings-store.spec.ts` | 3 | Org settings tabs render for an org admin; settings headings name their own scope (R15-13); **StoreBrowser performs a REAL file-store mkdir through the UI**. |
| `04-palette-mobile.spec.ts` | **6** (was 4) | ⌘K global palette jumps to the task (R15-5); the board keeps its own board-scoped filter; at 375px the workspace rail collapses behind a toggle with no sideways scroll (F15-18); a non-member gets the unknown-slug 404 on a project board (R15-4); **+ two new G3 tests** — at 375px Home keeps a way into the palette (its search box collapses to a 36px magnifier instead of vanishing), and the workspace palette trigger is a real touch target. |
| `05-task-comment-composer.spec.ts` | 7 | Lexical composer against the production image: typing plain text posts the trimmed draft; Enter = line break and ControlOrMeta+Enter sends multiline; @-mention keyboard selection inserts a live chip; @-mention click insertion with the posted bytes asserted on the wire; Escape closes the menu without inserting; undo cannot resurrect a sent comment; the composer is an accessible combobox wired to the mention listbox. **Every test gates on zero `pageerror`** via `beforeEach` collector + `afterEach` assertion (`:18-27`). |
| `06-activity-hydration.spec.ts` | 1 | Activity page hydrates clean under `test.use({ timezoneId: "Pacific/Auckland" })` — zero page errors and no `Today`/`Yesterday` in the SSR HTML. Auckland is chosen so the spec still discriminates when the Playwright host is itself UTC (CI), and because it pushes most UTC timestamps across a **day** boundary, exercising the day-bucket regroup and not just clock text. |
| `07-accessibility.spec.ts` | **33** (was 14) | WCAG 2.2 AA gate — see §1.6. |

**Numbering.** The specs used to run `01, 05..10`; `02`, `03`, `04` had been
deleted with the simulated runtime (R7-2, "don't simulate at all"). G10
renumbered them contiguously, because a permanent gap reads as "three specs are
missing" to everyone who did not live through R7-2. The prefix is
**presentation only** — `playwright.config.ts:28` takes the whole `testDir`, so
nothing selects a spec by number — but with `fullyParallel: false, workers: 1`
it *is* the run order, so `07-accessibility.spec.ts` deliberately kept its
number instead of sliding to `04`: it is the cross-cutting gate, it is nicer
last, and its filename is cited from `app/app.css.test.ts` (the static-token
check names its rendered-page counterpart).

### 1.6 The axe sweep — `e2e/07-accessibility.spec.ts` (33 tests)

The largest single change the waves made to the e2e layer (+201 lines).
`@axe-core/playwright` with tags `wcag2a` / `wcag2aa` / `wcag22aa` **only** —
best-practice rules are opinions, and failing CI on an opinion trains people to
ignore the gate.

- **`SURFACES` — 12 entries × 2 themes = 24 tests.** board, task detail, review
  queue, policy, home, agents (the original six), **plus** activity, project
  settings, github, org settings, and the two page-as-popup routes profile and
  notifications. The last two are the only places the sweep sees the top-layer /
  inert interaction between an overlay `<dialog>` and the toast host.
- **`DIALOGS` — 3 entries × 2 themes = 6 tests, audited OPEN.** Command palette
  (opened with `ControlOrMeta+k`, filled, waits for a `[role="option"]`), New
  task, and the create-profile modal (the densest form in the product). Rationale
  in the file: the sweep "never once opened a dialog", so the two densest forms
  and every page-as-popup route were outside the gate — the same shape as the
  R15-12 failure the `agents` entry was added to close.
  Note the honesty comment on the palette entry: axe 4.12 does **not** flag a
  missing `role="combobox"` / `aria-activedescendant`; that contract is gated by
  `command-palette.test.tsx`, and this entry exists so the palette's contrast,
  name-role-value and focus order are audited at all.
- **`mobile rail overlay` — 1 test** at 375×812: the dismiss scrim must be a
  decorative `DIV` with `aria-hidden="true"` and **no** `tabindex`, Escape must
  close the overlay **and** return focus to the toggle, then axe must be clean.
  It exists because the old scrim was a `<button aria-hidden tabIndex={-1}>`
  that passed axe only because its two attributes happened to agree.
- **`signed out` — login × 2 themes = 2 tests**, with
  `test.use({ storageState: { cookies: [], origins: [] } })`.

Two mechanics worth copying:

- `setTheme()` writes the `viberr_theme` cookie scoped to
  `new URL(page.url()).origin`. The stack serves on a derived 127.0.0.1 port, so
  a hard-coded host would silently never apply and every "dark theme" test would
  quietly audit light.
- `settle(page, selector)` awaits
  `el.getAnimations({ subtree: true }).map(a => a.finished)` before analysing.
  axe samples **computed** colours; auditing a mid-fade frame produces contrast
  failures that do not exist.

`report()` prints the offending selectors, not a count — "a bare count sends the
next person back to the browser to find them again."

### 1.7 How `npm run e2e` works

`"e2e": "tsx scripts/e2e.ts"`. **Docker is required.** Owner policy 2026-08-02:
*anything that serves the app for a test runs the PRODUCTION image — never a dev
server.* The old `webServer` path is deleted.

`scripts/e2e.ts` flow:

1. `PROJECT = "viberr-e2e"`, `COMPOSE = ["compose","-f","compose.e2e.yml","-p","viberr-e2e"]` (`:17-18`).
2. `down --volumes --remove-orphans` — clean slate even after a crashed run (`:64`).
3. `up --build --detach --wait --wait-timeout 300` (`:66`). Compose runs the
   **seed one-shot first**, then the app
   (`depends_on: service_completed_successfully`). On failure it dumps
   `logs --tail 100` and tears down (`:67-72`).
4. `docker compose port app 3000` → derive the random loopback host port →
   `baseUrl = http://127.0.0.1:<port>` (`:74-81`).
5. `waitForHealth(${baseUrl}/resources/health, 60_000)` (`:84`) — polls every
   500 ms for HTTP 200 **and** `body.ok === true` (`:41-58`).
6. `npx playwright test <passthrough argv>` with `VIBERR_E2E_BASE_URL=baseUrl`
   in the env (`:87-89`). Extra args pass straight through.
7. `finally`: `down --volumes --remove-orphans`, **unless** `VIBERR_E2E_KEEP=1`,
   in which case it prints the base URL and the manual teardown command
   (`:96-102`). Playwright failure also dumps the last 100 app log lines (`:90-93`).

**The seed one-shot runs from the BUILD stage.** `compose.e2e.yml:19-31`:

```yaml
seed:
  build: { context: ., target: build }
  command: sh -c "npm run seed:demo && chown -R 1000:1000 /data"
```

`test-support/` deliberately never ships in the final image (the runtime stage
copies only `node_modules`, `build`, `package.json`, `db`, `scripts`, `app`,
`tsconfig.json` — `Dockerfile:48-59`), but the build stage did `COPY . .` and so
still has the full source tree. The one-shot seeds the volume **as root**, then
`chown -R 1000:1000 /data` hands ownership to the final stage's UID-1000 `node`
user before the app boots.

`.dockerignore` excludes `e2e`, `design`, `planning`, `docs` and **explicitly
does not exclude `test-support`** — that is now a documented decision at
`.dockerignore:21-29`, not an accident. Adding it would shrink the image and
kill `npm run e2e`, and the failure would surface as an *empty board*, not a
missing file.

---

## 2. The stylesheet gate — `app/app.css.test.ts` (1006 lines)

Barely mentioned in the pass-16 doc; now the second-largest single test file in
the repo and the reason a whole class of CSS defect can no longer ship. It runs
under the default **node** environment and simply reads `app/app.css` (3936
lines, the app's ONE stylesheet) plus every `.tsx` under `app/` off disk. It
fails in milliseconds and names the offending token/class/site.

Premise, from the file header: *nothing checks CSS the way `tsc` checks
TypeScript — an undefined token or an undefined class is silently dropped by the
browser, so the page still renders, just wrong.*

All comments are stripped once into `CODE` before any check runs, because
comments legitimately name dead tokens.

**What it enforces** (14 describes; the ones that matter to a change author):

| gate | what fails the build |
|---|---|
| **Custom properties (P13-D-18)** | any `var(--x)` whose `--x` is declared nowhere. Origin: 11 such references, 7 with no fallback, which threw away the whole declaration — the Scheduled re-runs panel rendered with no border and no background in both themes. |
| **Class integrity (P16-UI-02)** | any `className` literal in `app/` with no rule in the sheet. **It scans the tree, not a list**: `classNameExpressions()` walks every `className={…}`, `stripNonClassLiterals()` drops comparison/argument operands (`view === "grid" ? …`, `mode.startsWith("kb")`), template-literal static chunks count, `${…}` holes do not, and the one imperative site (`classList.add` in `lexical-mention-plugin.tsx`) is picked up separately. A trailing-dash token (`"pev-ico act-"`) is treated as a runtime-completed **prefix** and only fails if *no* rule starts with it. Failure messages name the class **and its files**. |
| | Self-check: `files.length > 150`, `used.size > 500`, `used.has("btn")` — so a rename of `app/` or a changed attribute spelling cannot turn the whole block green for free. |
| | `CLASSLESS_BY_DESIGN` is **`{}` — empty on purpose**, capped at ≤ 3 entries, each needing a >20-char reason. Do not grow it to make a red build green: an entry is a class the markup ships and the sheet does not style, which is the exact defect. |
| **Inline styles (P16-F3)** | any `style={{…}}` in a non-test `.tsx` whose **every** property value is a bare literal. The rule: a literal is a design decision and belongs in the sheet where a theme/density/breakpoint rule can reach it; a value read at runtime (a stage colour, a tree row's depth, a measured popover position) belongs in the markup. 182 sites → 20 on that rule. A second test **holds the ceiling at 20** and a third asserts the scanner found >10 sites. |
| **Contrast (P13-D-12)** | `--faint` / `--placeholder` below 4.5:1 on `--surface` in **both** themes, the `--muted > --faint > --placeholder` subordination, 4.5:1 over the 4% `--fg` surface tint, the primary CTA and its hover in both themes, and the focus-ring colour at 3:1 against every surface it lands on. Implemented with local `luminance()` / `contrastRatio()` / `mixHex()` helpers (the last approximates `color-mix(in srgb, …)`). |
| **The UA `ButtonFace` pin (P16-UI-04)** | the element-level `button` reset losing `background`. This is the wave-2 regression: the reset took `font`, `color` and `cursor` but never `background`, so any button whose class declares no surface kept the UA `ButtonFace` — which Chrome resolves **per colour-scheme** (#efefef light, **#6b6b6b dark**). The org-settings tab rail painted that mid-grey block in dark at 3.2:1 (`--muted`) and 1.9:1 (`.count`). Fixed at the root with `background: none` and pinned here. |
| **Focus ring (P16-UI-01)** | one app-wide `:focus-visible` ring on the brand accent, wrapped in `:where()` so component rules still win, covering the control kinds the markup uses, with the four per-selector copies it replaced asserted **gone**. |
| **Breakpoints (P16-F8)** | a breakpoint value used that the named map does not contain, a breakpoint declared more than once, or a named breakpoint that is unused. Custom properties do not work inside media queries and `@custom-media` needs build config this project does not run, so **one occurrence** is the only mechanism that makes a half-update inexpressible. Nine `@media (max-width: 1100px)` blocks became one, and all eight collapses it carries are pinned. |
| **Hover-revealed controls (P16-F7)** | `.card-move` staying `opacity: 0` where hover cannot happen — `opacity: 0` still hit-tests, so a finger lands on a button nothing on screen names. It must draw unconditionally on a non-hover device, and **without** reintroducing a drag grip. |
| **Palette reachability (P16-G3)** | the shortcut chip hidden outside the workspace topbar, Home's search box deleted rather than collapsed to a trigger, or the collapsed triggers below a finger-sized target. |
| **Task key consistency** | `.card.list-row .key` diverging from `.card-top .key` on `font-family`, `font-size` or `color`. Every `.key` rule is scoped to a container the list row is not in, so its key alone rendered in the body face. |

`e2e/07-accessibility.spec.ts` is the **rendered-page counterpart**; this file is
the static one. Both are required — the axe sweep found the ButtonFace bug that
no static check could see, and this file catches undefined tokens the browser
silently drops without ever failing axe.

---

## 3. Seeds & fixtures

### 3.1 `scripts/seed.ts` — the PRODUCT seed (clean sheet)

`npm run seed` (`-- --reset` to wipe first). Seeds only:

- the built-in agent catalog templates (operator, developer, reviewer),
- org resources via `seedOrgResources` — knowledge bases with real files, skills,
  the domain allowlist. **No** MCP servers and **no** GitHub connection are
  fabricated (honest empty slate),
- on an **empty users table only**, the bootstrap admin from
  `VIBERR_SEED_ADMIN_EMAIL` / `VIBERR_SEED_ADMIN_PASSWORD`
  (defaults `admin@viberr.dev` / `SEED_DEFAULT_PASSWORD`).

`--reset` wipes `projects/`, agent profiles, runtime transcripts and all derived
tables; **users/auth and runtime credential homes survive**.

**Clean-sheet philosophy** (owner ruling 2026-07-24): a real instance starts with
an empty board. Demo/mock data is a *test fixture*, not product content. Never
reintroduce demo rows into `seed.server.ts` or a migration.

Wave 3 note (finding H16, recorded so it is not "fixed" again): the seeded
catalog grants KB dirs `architecture-notes` / `api-contracts` that do not exist
in a boot-backfilled store. That is already handled —
`default-assets.server.ts:238-253` strips KB grants on the backfill path
(`kbGrants: false`) and `npm run seed` creates the backing dirs via
`seedOrgResources`. The mechanism is correct; do not "fix" it.

### 3.2 `scripts/seed-demo.ts` + `test-support/demo-seed.ts` — the DEMO fixture

`npm run seed:demo` (`-- --reset`). **TEST/DEV ONLY.** Seeds the mock dataset the
e2e specs and route-level suites are written against:

- users arda / elif / murat / selin / deniz `@viberr.dev`,
- `viberr-core` plus two stub projects,
- tasks **VIB-139…VIB-168** with full timelines,
- Arda's notification inbox, the VIB-142 `pull_request:write` scope violation,
  Arda's Home pins.

Idempotent: users upserted by email, files overwritten, rescan reconciles
projections, notification rows use deterministic ids.

The script imports `test-support/demo-seed` **dynamically** so running it in the
production image fails with a clear "dev-only, needs `test-support/`" message.
The `catch` also `console.error(error)` first — an earlier version swallowed the
real cause and a Vite-only `?raw` import failing under `tsx` surfaced as a
misleading "not shipped in the production image".

**Password:** `SEED_DEFAULT_PASSWORD = "viberr-dev-2828"`, defined in
`app/server/seed/seed-credentials.ts` — a module with **zero imports**, on
purpose. Playwright's Babel transform has no `?raw` loader, and `seed.server.ts`
transitively imports shipped agent assets through Vite's `?raw`; importing the
constant from there once broke the entire e2e config load. Keep that module
import-free.

E2E login: **`arda@viberr.dev` / `viberr-dev-2828`**.

Wave 3 changed one seeded string (H15): seeded Developer/Reviewer profiles said
`Global base · customized for Viberr Core`, a workspace name that exists nowhere
in the product (a leftover design-mock literal). They now say `Global base`,
matching what the app itself writes.

### 3.3 `VIBERR_DATA_ROOT` hermetic-CI trick

Run vitest with `VIBERR_DATA_ROOT=<an empty directory>`:

```sh
mkdir -p /tmp/viberr-empty && VIBERR_DATA_ROOT=/tmp/viberr-empty npm test
```

Origin: a real product bug (`applyAgentCompletionEffects`'s failed-run branch
called `notifyTaskWatchers` without `ctx` — the only one of 5 call sites to omit
it — so recipient resolution read the *default* data root and failed-run
notifications were silently never delivered whenever `dataRoot ≠ ./data`). Every
dev machine masked it because `./data` happens to exist. Use it to catch the
"reads the ambient data root" class before CI does.

`test-app.ts:42` already overrides `VIBERR_DATA_ROOT` per test to a temp dir and
`setup-env.ts` pins the transcript stores — the trick catches whatever escapes
both.

---

## 4. Hard-won test recipes

Each re-verified against current code; paths and lines are live.

### 4.1 Driving Lexical in jsdom — `__lexicalEditor` + async `act`

jsdom **cannot synthesize typing into a contenteditable**. The composer suite
drives the real editor instead
(`app/features/task-detail/mention-composer.test.tsx`):

```ts
// :88-89 — grab the editor instance off the DOM node
const ce = utils.container.querySelector('[contenteditable="true"]') as HTMLElement;
const editor = (ce as unknown as { __lexicalEditor: LexicalEditor }).__lexicalEditor;

// :97 — set the whole draft through a real editor update.
// ASYNC act is mandatory: Lexical commits in a MICROTASK, so the act must flush
// it before the test fires keys at the (otherwise still-empty) editor.
async function setText(editor: LexicalEditor, text: string) {
  await act(async () => {
    editor.update(() => { /* $getRoot() / $createParagraphNode() / $setParagraphPlainText() */ });
  });
}

// :114 — read back through the editor state, never the DOM
function readText(editor: LexicalEditor): string {
  let out = "";
  editor.getEditorState().read(() => { out = $getRoot().getTextContent(); });
  return out;
}
```

Keys fire as **DOM `keydown` events on the contenteditable**
(`fireEvent.keyDown(ce, …)`) — Lexical's own listeners dispatch the commands.
Assertions read the editor state or the submitted form, never innerHTML. The
mention menu is found globally via `document.querySelector('[role="listbox"]')`
(`:122`) since it portals out. Prerequisites: the
`// @vitest-environment jsdom` pragma on line 1 **and** the `ResizeObserver`
stub from `setup-dom.ts`.

### 4.2 Fake timers for the toast

`app/ui/toast.test.tsx`. Two-phase dismissal: **2600 ms** alive, then `.leaving`
for **200 ms**, then unmount.

```ts
afterEach(() => { cleanup(); vi.useRealTimers(); });   // :13-16 — ALWAYS restore

vi.useFakeTimers();                                    // inside the it(), before render
fireEvent.click(getByText("push"));
act(() => vi.advanceTimersByTime(2600));               // advance INSIDE act()
expect(toast()!.classList.contains("leaving")).toBe(true);
act(() => vi.advanceTimersByTime(200));
expect(toast()).toBeNull();
```

Three variants elsewhere, pick deliberately:

- `vi.useFakeTimers({ shouldAdvanceTime: true })` + `await vi.advanceTimersByTimeAsync(200)`
  when the code under test also awaits real promises
  (`app/features/shell/command-palette.test.tsx`).
- `vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })` when a **native
  watcher must stay real** (`app/server/files/file-watch.service.server.test.ts:202`).
- `vi.setSystemTime(...)` for elapsed-time hooks (`app/features/runtime/use-elapsed.test.tsx`).

The stack is now **capped at four** toasts (P16-UI-13) and a dropped toast's own
timers firing later is explicitly tested — if you touch the stack, that test is
the canary.

### 4.3 NEW — asserting live-region ORDER, not just attributes

Wave 2's most subtle bug: the app's only live region was inert whenever a dialog
was open. The toast host entered the top layer (`showPopover()`) *in the same
commit that inserted the first toast*, and that is precisely the case screen
readers do not announce — so every dialog-driven confirmation in the product was
silent. The fix promotes the region **empty** and commits the message a frame
later.

An attribute assertion cannot see that. The recipe instruments the popover API
and records **how many children the host had at the moment of each call**
(`toast.test.tsx:91-111`):

```ts
function instrumentPopover() {
  const calls: string[] = [];
  const proto = HTMLElement.prototype as unknown as { showPopover?: () => void; hidePopover?: () => void };
  const original = { show: proto.showPopover, hide: proto.hidePopover };
  proto.showPopover = function (this: HTMLElement) { calls.push("show:" + this.childElementCount); };
  proto.hidePopover = function (this: HTMLElement) { calls.push("hide:" + this.childElementCount); };
  return { calls, restore() { proto.showPopover = original.show; proto.hidePopover = original.hide; } };
}

// the whole fix, in one assertion:
expect(popover.calls).toEqual(["show:0"]);
```

Always `restore()` in a `finally` — the stub is on `HTMLElement.prototype` and
leaks to every later test in the file otherwise.

Related, and counter-intuitive: `aria-atomic` is **`"false"`**, not `true`.
`role="status"` *implies* `true`, which would re-read the whole (now 4-deep)
stack on every arrival. The original instruction for this fix said `true` and
was wrong.

### 4.4 Dialog close is synchronous under jsdom (by design)

`app/ui/use-dialog.ts:36-42`:

```ts
dialog.dataset.closing = "";
// dialog[data-closing]'s transition-duration, read AFTER the attribute lands:
// 0/NaN in jsdom (no stylesheet) and ~0 under [data-motion="reduce"] —
// both mean close synchronously.
const seconds = parseFloat(getComputedStyle(dialog).transitionDuration);
if (!(seconds > 0.02)) { onCloseRef.current(); return; }
```

So in a component test, clicking Cancel closes the dialog **in the same tick** —
no `waitFor`, no timer advance. In a real browser it waits for `transitionend`,
filtered to `event.target === dialog` because **transitionend bubbles** and a
descendant's transform (the pressed Cancel button) would otherwise end the close
mid-fade, with a `seconds*1000 + 50` ms fallback timer.

Two live-browser gotchas that do **not** apply to jsdom but will bite you when
verifying by hand:

- A synthetic `element.click()` fires at (0,0) → the backdrop-click handler reads
  that as outside the card rect and **silently closes the dialog**. Use real
  pointer events.
- CDP-synthesized Escape does not fire `<dialog>`'s `cancel` event; dispatch
  `new Event("cancel")` instead.

Wave 3 extracted the shared outside-press/Escape/reflow logic into
`app/ui/use-dismiss.ts`, tested at `app/ui/use-dismiss.test.tsx` (6 tests,
including "subscribes nothing while closed and unsubscribes everything on
unmount"). New dismissable surfaces should use it rather than re-implementing.

### 4.5 Canary methodology — revert the fix, watch the test fail

The question that matters is **"would this test fail against the old behavior?"**
Not theoretical: in pass 14 an adversarial verifier found a fix whose test
exercised the *prompt builder*, so deleting the actual wiring left the suite
green. Pass 16 found the same shape in the RBAC matrix test — it derived its
expectation from the same map it guarded, so widening a tier passed silently.

Procedure, per fix:

1. Land the fix + its test; confirm green.
2. `git stash` / comment out **only the product change** (leave the test).
3. Re-run just that file: `npx vitest run <path/to/file.test.ts>`.
4. It must **fail**, and fail for the stated reason. If it passes, the test is
   asserting the wrong layer — rewrite it.
5. Restore the fix; re-run; green.

Corollary from `fake-runtime.ts`: assert what a path **sent** (`lastRunSpec()`,
`startedRunSpecs()`), not only what it returned — a test of the returned value
survives the wiring being deleted.

Wave-3 refinement worth copying: for authorization display, mock `roleCan` to
answer for **exactly one action id**, so swapping two ids that resolve to the
same role tier today still fails. A role-tier assertion caught none of the three
canary swaps in `settings-page.test.tsx`.

### 4.6 "Nothing reads it" is not proof something is dead

Two near-misses in wave 3, both now pinned by test:

- **`verification`** (better-auth table) reads as dead — no app query names it —
  and the pass came one edit from dropping it. better-auth's
  `createAuthContext` picks `account.storeStateStrategy || (isStateful ? "database" : "cookie")`
  and `isStateful` is just `!!options.database`; we pass one, so every OAuth
  sign-in INSERTs its signed state there and the callback reads-then-deletes it.
  Drop the table and GitHub/Google login dies. Pinned at
  `app/server/db/migration-runner.server.test.ts:71-76` with the reason, canaried
  by deleting the `CREATE TABLE`.
- **`task_projections.repo`** likewise looks dead but feeds the task-detail
  GitHub links. Only its comment was stale.

Before deleting a table, column or export because grep found no reader, check
whether a **library** or a **projection consumer** owns it.

### 4.7 `npm run build` ≠ typecheck — `tsc` is a required gate

```json
"build":     "react-router build",                 // Vite/esbuild, ZERO type checking
"typecheck": "react-router typegen && tsc"         // the ONLY type gate
```

A build that succeeds proves nothing about types. `typecheck` also runs
`react-router typegen` first, which regenerates `.react-router/types/**` — those
are in `tsconfig.json`'s `include` and `rootDirs`, so `tsc` alone (without
typegen) can fail or pass spuriously on route-module types after a route change.
This has produced self-inflicted bugs before (pass 12 — two of them).
`tsconfig.json` runs `strict`, `noUnusedLocals`, `noUnusedParameters`,
`verbatimModuleSyntax`, `erasableSyntaxOnly`.

**And green-on-your-box ≠ green on CI.** Commit `0955ac9` is the current
cautionary tale: `codexCliAuthDiagnostics(env)` takes an env but built
`defaultLoginPath` from `os.homedir()`, which reads `process.env` directly — so
it answered a question about the **machine**. A developer with a real
`~/.codex/auth.json` got one copy branch and a green test; CI got the other,
which the test never asserted. The fix covers **both** branches, each with
`$HOME` pointed at a temp dir it controls, restored in `afterEach`. If a helper
takes an env, every path inside it must read that env.

### 4.8 The WAL stale-read gotcha — verify via the UI, not the sqlite CLI

The running app holds state in the SQLite **WAL**. A `sqlite3` CLI read of
`docker-data/state/projection.sqlite` can return a **stale, pre-write
snapshot** — in one incident a phantom old user id and `notifications` count 0
while the server had in fact written the rows.

**Rule:** verify live behavior through the UI or the server logs. A CLI query of
the projection DB is not evidence that a write didn't happen. If you must query,
query from inside the running process's container (`docker compose exec app …`)
rather than from the host.

### 4.9 Baseline-vs-live-dev-DB schema comparison

Migrations stay **squashed into `db/migrations/0001_baseline.sql`**
pre-production (exactly one migration file today). Consequence chain:

- The runner records `0001` as applied. **Editing the baseline does not reach a
  DB that already recorded it applied.**
- Re-baselining (wipe + re-seed) **regenerates user ids**, and every file-based
  `project.md` `members:` entry points at the old ids — the memberships break.

So a *substantive* schema change with a live dev DB requires **both**:

1. Edit `db/migrations/0001_baseline.sql` (correct for fresh installs), **and**
2. A one-off `sqlite3 ALTER TABLE …` against `docker-data/state/projection.sqlite`
   — with the app stopped (§6.5).

Wave-3 exception worth knowing: **comment-only edits to the baseline need no
re-baseline.** Wave 3 changed 59 lines of `0001_baseline.sql` and most were
comments (the `verification` and `task_projections.repo` explanations).

To compare a baseline against a live DB:

```sh
# 1. schema of a FRESH migrated DB (what the baseline produces)
sqlite3 /tmp/fresh.sqlite \
  "SELECT type,name,sql FROM sqlite_master
   WHERE name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations'
   ORDER BY type,name;" > /tmp/fresh.schema

# 2. same query against the live dev DB (app STOPPED)
sqlite3 docker-data/state/projection.sqlite "…same query…" > /tmp/live.schema

# 3. diff — tables first, then indexes; per-object + per-column
diff /tmp/fresh.schema /tmp/live.schema
```

Extra `schema_migrations` rows in a live DB (e.g. 0015–0023 from an abandoned
branch) are harmless to the runner.

Historical note: a `scripts/gen-better-auth-schema.ts` generator and a
`db/better-auth-reference.sql` reference dump are referenced in older planning
notes — **neither exists on `main`**. Use §4.10; dumping the live schema only
tells you what the baseline already said.

### 4.10 better-auth schema refresh (G8)

`0001_baseline.sql` ends with four hand-inlined statements — `"user"`,
`"session"`, `"account"`, `"verification"` — plus their three indexes. They are
lower-cased and quoted (`"id" text not null primary key`) unlike everything else
in the file because they are **pasted `@better-auth/cli generate` output**.

`@better-auth/cli` is deliberately **not a dependency**: it is codegen run by
hand at version-bump time, it drags better-auth's whole plugin surface in, and it
would earn its install cost roughly once a year. Run it with `npx` at the pinned
version:

```sh
# check `generate --help` first: flag names have moved across majors,
# but the shape is always config-in, SQL-out.
npx @better-auth/cli@1.6.25 generate \
  --config app/lib/auth.server.ts --output /tmp/ba-schema.sql -y
diff <(sed -n '/CREATE TABLE "user"/,$p' db/migrations/0001_baseline.sql) /tmp/ba-schema.sql
```

Fold the diff in by hand. Three things to know:

- **`githubHandle` on `"user"` is ours**, from `user.additionalFields` in
  `buildAuthOptions` plus the GitHub provider's `mapProfileToUser`. The CLI emits
  it only when it successfully loads the config; if it vanishes, the CLI failed to
  read `auth.server.ts` — better-auth did not drop a column.
- **`verification` is live** (§4.6). There is no unit test for the OAuth path —
  the app has no OAuth credentials in test — so the table comment plus the
  migration-runner pin is the gate.
- A column ADDITION or a new plugin table pastes straight in; a **rename** means
  read the changelog first.

Then re-baseline (`npm run seed -- --reset`): there is no ALTER path.

### 4.11 Bonus conventions worth knowing

- `serializeTaskFile` emits frontmatter in **object-property order**. A new
  frontmatter field must sit exactly where the tolerant parser constructs it or
  the byte-identical round-trip test fails.
- **Stale-fetcher-data bug class:** `fetcher.data` persists after
  `state === "idle"`, so any fetcher-result effect with extra state in its deps
  re-fires on that state and replays the stale success. The repo idiom is a
  `handled = useRef` identity guard. Any **new** fetcher-result effect must use
  it — otherwise react-doctor's `no-effect-chain` will (correctly) flag it.
- Any timestamp or locale-dependent SSR text must render a **UTC-deterministic
  first pass** and swap in viewer-local after hydration (`app/ui/local-time.tsx`),
  or you ship a React #418 that regenerates the page client-side.

---

## 5. CI / local gates — what must be green

`.github/workflows/ci.yml`, two jobs, Node 26, `npm ci`, both on push-to-`main`
and PR-to-`main`:

**`verify`** — `npm run typecheck` → `npm test` → `npm run build`.
**`e2e`** — `npx playwright install --with-deps chromium` → `npm run e2e`
(uploads `playwright-report/` as an artifact on failure, 7-day retention).

Locally, before a change counts as done:

```sh
npm run typecheck   # react-router typegen && tsc   — the ONLY type gate
npm test            # vitest run                    — 213 files / 2796 tests
npm run build       # react-router build            — bundling/asset gate
npm run e2e         # tsx scripts/e2e.ts            — production image, Docker required
npx -y react-doctor@latest --json --yes   # React/a11y/architecture lint
```

**Do not skip `npm run e2e` because the other three are green.** From
`CONTRIBUTING.md:62-64`: the pass-13 install regression passed typecheck, 1663
unit tests and the build, and was caught only here. Same class in pass 14 (a new
`<select>` option shadowed an unscoped `getByText`; an `<option>` is never
"visible"), and **again in pass 16 — twice**, post-wave-2:

1. the dark-theme `ButtonFace` contrast failure on org settings (§2), and
2. the ⌘K spec breaking on an a11y fix, because giving the palette input
   `role="combobox"` **replaces** its implicit `textbox` role, so
   `getByRole("textbox")` matched nothing. The spec now asks for the combobox.

Both were only reachable through the production-image stack.

**react-doctor.** Two artifacts, both canonical, both unchanged in the waves:

- `doctor.config.ts` — the scanner-level ignore list:
  `**/design/**`, `**/.claude/**`, `**/data/**`, `**/*.server.test.ts`.
  `.claude/worktrees` and `data/` both hold live agent **checkouts of this same
  repo**, so scanning them double-counts every finding against stale copies;
  `design/` is the standalone static mockup bundle (its `support.js` alone
  produced 45 phantom `postmessage-origin-risk` hits). Corollary: those dirs also
  break naive repo-wide greps — filter `worktrees`, and "unused on main" may be
  used on a worktree branch.
- `.react-doctor/false-positives.md` (154 lines) — **the canonical step-2
  filter**. Diagnostics matching a pattern here are dropped before fixing.
  Entries that say "verify" require an actual Read/grep of the flagged site
  first — **never suppress on filename alone**, and lines drift. Documented FP
  classes: remount-keyed `useState(prop)`, capture-once optimistic state,
  fetcher-lifecycle effects, append-only index keys, `.includes()` over bounded
  tiny arrays, and the two `effect-needs-cleanup` "errors" that are FPs by the
  rule's own validation prompt (an effect-local `EventSource`/`addEventListener`
  needs no `removeEventListener` when cleanup calls `source.close()`) — they fire
  on every scan.

The react-doctor tool score wobbles ±1 between `@latest` runs at identical
findings. Don't chase it.

---

## 6. Docker / Compose

### 6.1 `Dockerfile` — two stages

- **`build`** (`node:26-slim`, `:7`): `npm ci` → `COPY . .` → `npm run build` →
  `npm prune --omit=dev`. **Has the full source tree, including `test-support/`.**
- **runtime** (`node:26-slim`, `:21`): installs `git` + `ca-certificates` (real
  agent runs clone repos and shell out to git). Env: `NODE_ENV=production` (`:33`),
  `VIBERR_DATA_ROOT=/data` (`:36`), `CLAUDE_CONFIG_DIR=/data/runtimes/claude-home`
  (`:39`), `CODEX_HOME=/data/runtimes/codex-home` (`:42`), `PORT=3000` (`:43`).
  Copies **only** `node_modules`, `build`, `package.json`, `db`, `scripts`, `app`,
  `tsconfig.json` (`:48-59`) — `db` + `scripts` + `app` are there so
  `docker compose exec app npm run seed` works via tsx. `mkdir -p /data &&
  chown node:node /data`, then `USER node` (`:64`).
- `ENTRYPOINT ["sh", "/app/scripts/docker-entrypoint.sh"]` (`:71`, sh-prefixed so
  the file's exec bit can't matter); it seeds Codex CLI auth from the optional
  read-only host mount then `exec`s the CMD.
- **CMD runs the server binary directly, NOT `npm run start`** (`:81`). With npm
  in between, npm is pid 1 and node is its child, and `docker compose stop`'s
  SIGTERM never reaches node — and node's shutdown handler is what **checkpoints
  the WAL and releases the data-root writer lock (B-FD1)**. The npm-wrapped
  version left a lock file behind on every stop and the next boot could refuse to
  start.

### 6.2 `compose.yml` — the production stack (dev/ops use)

- `hostname: viberr` — **pinned on purpose**. The data-root writer lock records
  its holder's hostname and a lock from a *different* host is refused (the one
  host it cannot probe for liveness). Compose's default hostname is the container
  id, so every `down && up` came back as a stranger to its own leftover lock.
- `env_file: .env`, then `environment:` **force-overrides** `NODE_ENV=production`,
  `VIBERR_DATA_ROOT=/data`, `CODEX_HOME=/data/runtimes/codex-home` even when
  `.env` carries the dev equivalents.
- Ports `"${PORT:-3000}:${PORT:-3000}"` — compose interpolates `${PORT}` from the
  same `.env` it injects, so the mapping always matches what the server listens on.
- Volumes: `./docker-data:/data` (everything stateful — canonical markdown, SQLite
  projections, run logs, KBs; back this up), plus
  `${CODEX_CLI_HOME:-~/.codex}:/host-codex:ro`. That second mount is a
  **directory** mount, not a file mount, because the Codex CLI rewrites
  `auth.json` via rename — a file mount would pin the dead inode and go silently
  stale.
- Healthcheck: in-container
  `node -e "fetch('http://127.0.0.1:'+PORT+'/resources/health')…"`, 30 s interval
  / 5 s timeout / 3 retries / 20 s start period. `/resources/health` returns
  `{ ok, projections, watcher, kbWatcher, backends }`; `watcher: false` is
  **real** (dead watcher), not "never started".

### 6.3 `compose.e2e.yml` — the e2e override stack

Not meant for `docker compose up` by hand. Never touches the main compose
project, `.env`, `./docker-data`, or any host credential.

- **Synthetic secrets only**, shared by seed and app via a YAML anchor (`:12-16`):
  `VIBERR_DATA_ROOT=/data`,
  `VIBERR_SESSION_SECRET=e2e-session-secret-0123456789abcdefghijklmnop`,
  `VIBERR_SECRET_ENCRYPTION_KEY=AAAA…AAA=` (base64 of 32 zero bytes).
- `seed` service (`:19-31`): `target: build`,
  `command: sh -c "npm run seed:demo && chown -R 1000:1000 /data"`, `restart: "no"`.
- `app` service (`:33-65`): `depends_on: seed: { condition: service_completed_successfully }`,
  `hostname: viberr-e2e` (`:43`, same writer-lock rationale), `NODE_ENV: production`,
  port `"127.0.0.1::3000"` (`:50` — random loopback host port, derived by the
  orchestrator).
- Healthcheck tighter than production's: 2 s interval / 5 s timeout /
  **30 retries** (`:63`) / 5 s start period.
- Project-scoped named volume `e2e-data`, removed by `down --volumes` after every
  run.

### 6.4 `--no-deps` for restarts

`compose.e2e.yml:40-42`: *"Restart tests must use `--no-deps` so the seed one-shot
cannot re-run and reset the volume mid-check."*

```sh
docker compose -f compose.e2e.yml -p viberr-e2e up -d --no-deps app     # app only
docker compose -f compose.e2e.yml -p viberr-e2e restart app             # also safe
```

Without `--no-deps`, compose re-evaluates the `seed` dependency and can wipe the
state the restart test is checking.

### 6.5 The docker-data dual-writer hazard — **one app process per data root, EVER**

The single most expensive mistake in this repo's history. **Two data-eating
incidents.**

What happened (2026-07-25): a host dev server (writer) was stopped while the
compose container was recreated → the container's `node:sqlite` handle over the
macOS VirtioFS bind mount **wedged** (`disk I/O error` on every query; a fresh
handle worked) → the un-checkpointed WAL was destroyed. **Lost:** `github_pats`,
`project_github_credentials` (a freshly re-added PAT), all `agent_runs` rows and
log lines, notifications, and ~12 minutes of audit rows. **Survived:** everything
file-canonical (task.md timelines, projects, users) — projections rebuilt from
files.

Why: SQLite WAL across host + container over a macOS bind mount has no shared
lock truth; kill/recreate windows corrupt or discard the WAL.

**How to apply:**

- Exactly **one** app process per data root, ever.
- Before starting a dev/preview server on `docker-data`, check `docker ps` for
  `viberr-app-1`. And vice versa.
- After any wipe/restart, restart whichever process stayed up.
- A container restart clears a wedged handle: `docker compose restart app`.
- The product has a boot-time writer lock (B-FD1,
  `app/server/db/data-root-lock.server.ts`, `DATA_ROOT_LOCK_FILENAME = "writer.lock"`,
  taken in `boot.server.ts`) — it refuses the second process rather than
  corrupting. Do not "force" past it casually.

### 6.6 `.env` vs `launch.json` data-root mismatch

```
.env (gitignored)          VIBERR_DATA_ROOT=…            # historically ./data, a STALE root
.env                       PORT=5173
.claude/launch.json        export VIBERR_DATA_ROOT=<repo>/docker-data
                           port 5173
```

A dev server launched via `.claude/launch.json` and the compose container
**share `./docker-data`** (the dual-writer hazard); a bare `npm run dev` reading
a stale `.env` uses a different, empty-or-stale root, and the symptom is "the app
doesn't show my data" with no error.

`.env` is gitignored, so the repo cannot fix the live one. What the repo *can* do,
and now does (B7): **`.env.example:21-34` sets `VIBERR_DATA_ROOT=./docker-data`
uncommented**, and explains in place why the value must match
`.claude/launch.json`. Fixing your own `.env` is still a manual step — do it, then
confirm with the boot log's data-root line before trusting anything in the UI.

Two more live facts from pass 16:

- **Do not export `CODEX_HOME` in `.claude/launch.json`.** Codex runs were
  refused because the launcher exported it at the run home, so auth source ==
  home and the credential mirror was a no-op. Dropping the export fixed it.
- `vite.config.ts:18` resolves `VIBERR_DATA_ROOT` the same way the app does, to
  exclude the data root from the dev watcher — task workspaces are full nested
  clones with their own `.git` and `tsconfig.json`, and Vite would treat them as
  app source (F10-36).

---

## 7. Playwright config details

`playwright.config.ts` (55 lines, unchanged in the waves):

| setting | value | note |
|---|---|---|
| `testDir` | `"e2e"` (`:28`) | |
| `baseURL` | `process.env.VIBERR_E2E_BASE_URL` (`:17,38`) | **Throws at config load if unset** (`:18-26`) with a message pointing at `npm run e2e`. A bare `npx playwright test` has no app to target. |
| `fullyParallel` | `false` (`:29`) | |
| `workers` | `1` (`:30`) | The specs share the seeded store. |
| `forbidOnly` | `!!process.env.CI` (`:31`) | |
| `retries` | `process.env.CI ? 1 : 0` (`:32`) | **Zero retries locally** — a local failure is a failure. |
| `reporter` | CI: `[["list"], ["html", {open:"never"}]]`; local: `"list"` (`:33`) | |
| `timeout` | `45_000` per test (`:34`) | |
| `expect.timeout` | `10_000` (`:35`) | |
| `use.trace` | `"retain-on-failure"` (`:39`) | Traces land in `test-results/`. |
| `webServer` | **absent — deliberately removed** | The dev-server path was deleted with the 2026-08-02 production-image policy. |

**Projects** (`:42-53`):

1. `setup` — `testMatch: /auth\.setup\.ts/` (`:44`). Logs in through the real UI.
2. `chromium` — `devices["Desktop Chrome"]`,
   `storageState: "e2e/.auth/arda.json"` (`:49`), `dependencies: ["setup"]`.

`/e2e/.auth/`, `/e2e/.tmp-data/`, `/test-results/` and `/playwright-report/` are
gitignored (`.gitignore:11-14`).

Single spec: `npm run e2e -- e2e/05-task-comment-composer.spec.ts`.
Keep the stack alive afterwards: `VIBERR_E2E_KEEP=1 npm run e2e`.

---

## 8. Known flaky areas — and telling flake from regression

### 8.1 The real-FS-event tests (E13 / KB watcher)

`app/server/files/file-watch.service.server.test.ts` and
`kb-watch.service.server.test.ts` drive **real filesystem events through
chokidar**. Under back-to-back full-suite runs, **macOS DROPS (not merely
delays) coalesced FSEvents** when the machine is churning temp dirs. Historical
rate: the E13 `unlinkDir` tests flaked roughly **2 in 5** back-to-back full runs.

Three mitigations are in the tree — understand them before touching:

1. **The real bug that was hiding behind the flake:** chokidar's `ENOENT` was
   treated as fatal, killing the watcher and cancelling the *queued unlink
   reconcile*, orphaning projections. Now benign and regression-tested
   (`file-watch.service.server.ts:240-246`, `kb-watch.service.server.ts:126-130`;
   test at `file-watch.service.server.test.ts:179-192`).
2. **Event re-offering inside the poll window.** `waitFor(cond, what, nudge)`
   (`file-watch.service.server.test.ts:35`) runs `nudge` every 4 s to **re-offer**
   the awaited event. `pokeDir()` (`:57-59`) writes a `poke-marker` file —
   deliberately **not** a dot/tmp name (ignored names can skip the rescan) and
   **not** a canonical basename (so the add reaches chokidar's differ but never
   the projection handlers). This forces the watcher to re-diff the listing and
   emit the missed unlink. The KB test applies the same idea as a periodic
   re-touch of the watched file inside its poll window.
3. **`await ready` before acting.** Chokidar arms **asynchronously**;
   `startWatcherReady()` (`:61-68`) awaits `watcher.once("ready")` — the initial
   scan completing. The listener attaches in the same synchronous frame as the
   start, so the event cannot have fired before it.

Timeouts: `WAIT_TIMEOUT_MS = 12_000` (`:25`) inside `waitFor`, per-test `15000`.

### 8.2 Distinguishing flake from regression

| signal | flake | regression |
|---|---|---|
| Re-run the single file in isolation (`npx vitest run <file>`) | **passes** | still fails |
| Failure message | `timed out waiting for: <what>` from the `waitFor` helper | a concrete assertion diff (`expected 1, received 2`) |
| Machine state | full suite running back-to-back, other watchers/temp-dir churn | reproduces on an idle machine |
| Convergence | eventually converges when nudged / on a quiet box | a genuinely broken reconcile path never converges and still times out |
| Scope | only the two real-FS-event describe blocks | anything else |

Rules of thumb:

- **Only the FS-event tests get this benefit of the doubt.** A flake anywhere
  else is a bug until proven otherwise — most often a real ordering/async defect.
- Confirm by running the file alone **three times**. Three greens in isolation +
  intermittent red in the full suite = environmental. Any red in isolation = real.
- If you touch a watcher, re-run the two watcher files back-to-back several times.
- E2E: `retries: 1` on CI, `0` locally. A local e2e failure is never "just
  flake" — reproduce it with `VIBERR_E2E_KEEP=1 npm run e2e -- <spec>` and open
  the trace from `test-results/`.

### 8.3 `ETXTBSY` in the e2e Docker build (transient, retry)

**Not in the pass-16 doc; recorded here for the first time.** `npm run e2e`'s
`docker compose up --build` can fail during the build stage's `npm ci` with:

```
ETXTBSY  node_modules/esbuild/bin/esbuild
```

It is a transient "text file busy" from the container's overlay/VirtioFS write
path, not a dependency or lockfile problem. **Retrying `npm run e2e` cleared it.**
Do not chase it, do not pin esbuild, do not add a retry loop to `scripts/e2e.ts`
on the strength of one occurrence — but do recognise it, because it reads like a
broken install and has cost a debugging session before.

### 8.4 Two e2e areas that are design-verified, not e2e-verified

Don't expect coverage, and don't file the absence as a gap:

- OS-level IME composition (the composer guards via `editor.isComposing()`).
- Touch dragging behind the 250 ms long-press — Playwright cannot synthesize full
  touch drags.

### 8.5 Harness artifacts that are NOT bugs

Recorded so they are not re-filed (pass-16 findings H14, plus the mention menu):

- A filter chip appearing blank in CDP screenshots, and `getComputedStyle`
  reporting `color == background`: both are harness artifacts (CDP snaps
  transitions; the computed style was read stale). A fresh read gave
  `rgb(27,29,37)` on `rgb(236,238,244)`. **Verify CSS conclusions twice, in a
  live browser, after animations settle.**
- The mention menu "not opening" on a bare `@`: it deliberately requires one
  character after the `@`.

---

## 9. Definition of done — follow verbatim

For any code change:

- [ ] **1. Colocate the test.** `foo.server.ts` → `foo.server.test.ts`;
      `foo.tsx` → `foo.test.tsx` with `// @vitest-environment jsdom` on **line 1**.
- [ ] **2. Canary the test.** Revert *only* the product change, run that file
      alone, confirm it **fails for the stated reason**, restore. A test that
      passes against the old behavior is not a test. (§4.5)
- [ ] **3. Assert at the right layer.** For runtime paths, assert what was
      **sent** (`lastRunSpec()` / `startedRunSpecs()`), not only what came back.
      For authorization display, mock `roleCan` per **action id**, not per role
      tier.
- [ ] **4. Route tests:** import the route module *after* `setupAppTest()`,
      include `_csrf` in every POST body, and `afterAll(() => app.cleanup())`.
- [ ] **5. `npm run typecheck`** — green. (`react-router typegen && tsc`. A green
      `npm run build` proves **nothing** about types. §4.7)
- [ ] **6. `npm test`** — green, no new skips, no increase in console noise.
      Baseline **213 files / 2796 tests, 0 skipped**.
- [ ] **7. Watcher/FS changes only:** run
      `npx vitest run app/server/files/file-watch.service.server.test.ts app/server/files/kb-watch.service.server.test.ts`
      **3× back-to-back**; all green. (§8.1)
- [ ] **8. Any CSS or `className` change:** `npx vitest run app/app.css.test.ts`.
      A new class needs a rule; a new `style={{…}}` must have at least one runtime
      value; the inline-style count must stay ≤ 20; do **not** add to
      `CLASSLESS_BY_DESIGN`. (§2)
- [ ] **9. `npm run build`** — green.
- [ ] **10. `npm run e2e`** — green (Docker required). **Never skip because the
      others are green**; it is the only gate that boots the shipped production
      image, and it has now caught regressions that passed everything else in
      three separate passes. (§5)
- [ ] **11. New/changed UI surface:** add or extend an e2e spec, and add the
      surface (or the dialog, in its OPEN state) to `SURFACES` / `DIALOGS` in
      `e2e/07-accessibility.spec.ts` so it is audited in **both** themes. A new
      interactive control shipping outside that sweep is a known past failure
      (R15-12), and the dark-only `ButtonFace` bug proves one theme is not enough.
- [ ] **12. New page/route:** gate on **zero `pageerror`** (the
      `05-task-comment-composer.spec.ts:18-27` pattern). Timestamp/locale SSR text
      must render a UTC-deterministic first pass. (§4.11)
- [ ] **13. Changed an ARIA role?** Re-run the e2e specs that query by role.
      `role="combobox"` **replaces** the implicit `textbox` role — the pass-16
      ⌘K spec broke exactly this way.
- [ ] **14. `npx -y react-doctor@latest --json --yes`** — no **new** unaddressed
      diagnostics. Filter through `.react-doctor/false-positives.md` (verify each
      flagged site by reading it; never suppress on filename alone) and check
      `filePath.startsWith("data/")` before triaging. New fetcher-result effects
      need the `handled = useRef` identity guard. (§5)
- [ ] **15. Schema change?** Edit `db/migrations/0001_baseline.sql` **and** apply
      a one-off `sqlite3 ALTER` to the live dev DB (app **stopped**). Comment-only
      baseline edits need neither. Re-baselining wipes user ids that `project.md`
      memberships reference. (§4.9)
- [ ] **16. Deleting something "nothing reads"?** Check for a library or
      projection consumer first, and pin the answer by test. (§4.6)
- [ ] **17. Verifying live?** Confirm exactly **one** app process owns the data
      root (`docker ps` vs. your dev server), and read state through the **UI or
      logs**, not a host `sqlite3` query (WAL stale reads). (§4.8, §6.5)
- [ ] **18. Don't reintroduce demo data into the product seed.** Mock content
      belongs in `test-support/demo-seed.ts` only. (§3.1)
- [ ] **19. Record it.** Follow `CONTRIBUTING.md`: branch off `main`, PR against
      `main`, CI green (both jobs), reviewer approval before merge. If a change
      contradicts a numbered ruling in `docs/architecture/decisions.md`, say so in
      the PR and get it re-ruled — never reverse one silently.

---

## Appendix — quick command reference

```sh
# unit / integration
npm test                                       # full vitest suite (213 files / 2796 tests)
npx vitest run app/app.css.test.ts             # one file
npx vitest run app/features/board/board-page.test.tsx
npx vitest list --filesOnly                    # 213 lines — file inventory, no execution
npx vitest list                                # 2796 lines — every test name, no execution
VIBERR_DATA_ROOT=/tmp/viberr-empty npm test    # hermetic-root canary (§3.3)
npx vitest run app/server/files/file-watch.service.server.test.ts \
               app/server/files/kb-watch.service.server.test.ts   # watcher pair, run 3×

# type / build
npm run typecheck                              # react-router typegen && tsc — the type gate
npm run build                                  # react-router build

# e2e (Docker required — never a dev server)
npm run e2e                                    # full production-image suite (62 tests)
npm run e2e -- e2e/01-home-board.spec.ts       # one spec
npm run e2e -- --grep "dark theme"             # any playwright arg passes through
VIBERR_E2E_KEEP=1 npm run e2e                  # keep the stack up afterwards
docker compose -f compose.e2e.yml -p viberr-e2e down --volumes --remove-orphans   # manual teardown
docker compose -f compose.e2e.yml -p viberr-e2e up -d --no-deps app               # restart app only
docker compose -f compose.e2e.yml -p viberr-e2e logs --tail 100 app

# seeds
npm run seed                                   # clean-sheet product seed
npm run seed -- --reset                        # re-baseline (regenerates user ids!)
npm run seed:demo                              # demo fixture (test/dev only)
npm run rescan                                 # rebuild projections from files

# lint
npx -y react-doctor@latest --json --yes
```

Key file map:

```
vitest.config.ts                       playwright.config.ts
scripts/e2e.ts                         compose.yml · compose.e2e.yml · Dockerfile · .dockerignore
scripts/seed.ts · scripts/seed-demo.ts · scripts/rescan.ts · scripts/docker-entrypoint.sh
test-support/setup-env.ts · setup-dom.ts · test-app.ts · test-db.ts · test-store.ts
test-support/demo-seed.ts · demo-data.ts · fake-runtime.ts · fake-github.ts
                          · audit-log.ts · custom-board.ts
e2e/auth.setup.ts · e2e/01..07-*.spec.ts
app/app.css (3936 lines) · app/app.css.test.ts (1006 lines)   # the stylesheet gate (§2)
app/server/runtimes/harness-hermeticity.server.test.ts        # the suite tests its own hermeticity
app/server/db/migration-runner.server.test.ts                 # pins `verification`
app/server/seed/seed-credentials.ts    # SEED_DEFAULT_PASSWORD, import-free on purpose
app/server/db/data-root-lock.server.ts # B-FD1 writer lock
app/ui/use-dialog.ts · app/ui/use-dismiss.ts   # synchronous close under jsdom; shared dismiss
app/ui/toast.tsx · app/ui/toast.test.tsx       # the app's ONE live region (§4.3)
doctor.config.ts · .react-doctor/false-positives.md
.github/workflows/ci.yml · CONTRIBUTING.md · docs/testing-quickstart.md · docs/testing.md
.env.example                           # VIBERR_DATA_ROOT=./docker-data, uncommented (B7)
```
