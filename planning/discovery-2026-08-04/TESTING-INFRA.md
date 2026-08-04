# Viberr — testing & infrastructure reference (2026-08-04)

Written for an implementation agent with no other context. Everything below was
verified against the tree at `main` @ `2442945` on 2026-08-04. Paths are
repo-relative from `/Users/akinozer/projects/viberr`.

Stack: Node ≥ 26, React Router 8.3 (SSR, framework mode), React 19.2, Vite 8,
TypeScript 7.0.2, Vitest 4.1, Playwright 1.62, `node:sqlite` (built-in), better-auth.

---

## 1. Test layout

### 1.1 Unit / integration (Vitest)

Config: `vitest.config.ts` (21 lines, whole file).

```
environment: "node"                                   # default for the suite
setupFiles: ["./test-support/setup-env.ts",
             "./test-support/setup-dom.ts"]           # vitest.config.ts:15
include:    ["app/**/*.test.{ts,tsx}"]                # :16-19 (see gotcha)
resolve.tsconfigPaths: true                           # :7 — Vite 8 resolves ~/* natively
```

Counts (2026-08-04):

| metric | value |
|---|---|
| test files matched | **207**, all under `app/**` |
| `test(` / `it(` call sites | **2434** (IMPLEMENTATION.md records **2478** executed tests — loops/`describe.each` inflate) |
| `*.server.test.ts` (node env, server modules) | 144 |
| `*.test.tsx` (component) | 33 |
| files with `// @vitest-environment jsdom` | 34 |

Densest directories: `app/server/tasks` (28), `app/server/runtimes` (15),
`app/server/projections` (12), `app/server/files` (11), `app/server/auth` (11),
`app/server/github` (10).

**Conventions.**

- Tests are **colocated** next to the module: `foo.server.ts` → `foo.server.test.ts`,
  `board-page.tsx` → `board-page.test.tsx`. There is no `__tests__` directory.
- Suffix `.server.test.ts` marks a server-only test. That suffix is load-bearing
  twice: react-router never bundles `.server.` modules client-side, and
  `doctor.config.ts:16` ignores `**/*.server.test.ts` so synthetic PAT fixtures
  aren't scanned as client secrets.
- **jsdom is opt-in per file** via the first-line pragma `// @vitest-environment jsdom`
  (e.g. `app/features/task-detail/mention-composer.test.tsx:1`). The global
  environment is `node`; forget the pragma and `document` is undefined.
- Every component test file ends with `afterEach(() => cleanup())` from
  `@testing-library/react` (`app/ui/toast.test.tsx:12-15`).
- Route-level tests import the route module **dynamically, after** `setupAppTest()`
  so the module graph reads the overridden env
  (`app/routes/login.server.test.ts:29-31`, harness note `test-support/test-app.ts:16`).
- **Every POST in a route test needs `_csrf`** in the form body — see
  `app/features/org-settings/org-settings-route.server.test.ts:66`,
  `app/features/shell/workspace-routes.server.test.ts:339`.

**There is no `db/` test convention** — don't invent one. `include` carried a
`"db/**/*.test.ts"` glob that had matched zero files ever since the migrations
were squashed (`db/` holds `db/migrations/0001_baseline.sql` and nothing else);
G10 removed it. A glob matching nothing is not harmless: it advertises a
convention, and the next person to write a schema test puts it somewhere the
`app/**` glob never reaches. The migration-runner test lives at
`app/server/db/migration-runner.server.test.ts`; schema behaviour is asserted by
the projection suites that own the tables.

### 1.2 Setup file 1 — `test-support/setup-env.ts` (hermetic env)

Runs **before any app module loads**. Three jobs:

1. **Seed required secrets** (`:19-23`). `getEnv()` fail-fast-validates
   `VIBERR_SESSION_SECRET` and `VIBERR_SECRET_ENCRYPTION_KEY` at first call and
   several test paths reach it. Uses `??=` so an explicitly exported real value
   still wins. Encryption key is `Buffer.alloc(32, 7).toString("base64")` (the
   schema requires exactly 32 decoded bytes).
2. **Blank every provider credential** (`:44-54`): `ANTHROPIC_API_KEY`,
   `CLAUDE_CODE_OAUTH_TOKEN`, `VIBERR_CLAUDE_USE_CLI_AUTH`, `CODEX_ACCESS_TOKEN`,
   `CODEX_API_KEY`, `OPENAI_API_KEY`, `VIBERR_CODEX_USE_CLI_AUTH`. The risk is a
   **billable provider call from `npm test`** (finding F10-10).
   **Assign `""` — never `delete`.** `env.server.ts` calls `loadEnvFile()` at
   module scope, i.e. *after* this setup file, and it fills any key not present.
   A deleted key is "not present" and the developer's `.env` value comes right
   back; `""` counts as present. `??=` is equally wrong here (preserves ambient).
   Documented at `:36-42`.
3. **Pin provider transcript stores to a fresh empty temp dir** (`:81-85`):
   `CLAUDE_CONFIG_DIR=<tmp>/claude-home` (with `projects/` created) and
   `CODEX_HOME=<tmp>/codex-home` (with `sessions/` created). Rationale at `:56-79`:
   an *existing but empty* store makes the continuity probe deterministically
   answer `missing`; a *nonexistent* store answers `unknown`. Before this pin the
   same test passed on CI and failed on any laptop that had run the app.
   `CODEX_HOME` is deliberately **not** in the blank-list — the dir has no
   `auth.json`, so `codexCliAuthUsable()` is false by construction.

### 1.3 Setup file 2 — `test-support/setup-dom.ts` (jsdom shims)

Both guards are `typeof window !== "undefined"` so the file no-ops under node.

- **`HTMLDialogElement` polyfill** (`:7-22`): jsdom ships the class without
  `showModal()` / `show()` / `close()`. The shim toggles the `open` attribute and
  dispatches a `close` event with `returnValue`.
- **`ResizeObserver` stub** (`:29-36`): jsdom has none; `@dnd-kit` references it
  at import time (board drag-and-drop). Inert `observe/unobserve/disconnect`.
  Component tests never exercise real geometry, so an inert stub is the honest
  shape — do **not** upgrade it to something that fakes rects.

### 1.4 Other `test-support/` helpers

| file | purpose |
|---|---|
| `test-db.ts` | `createTestDbContext()` → `makeDb()` (temp dir + `openDatabase` + `runMigrations`), `makeTempDir()`, `cleanup()` (closes DBs, rm -rf dirs). Pair with `afterEach(ctx.cleanup)`. |
| `test-store.ts` | `setupTestStore(ctx)` → migrated DB + temp data root + `viberr-core` project with 5 users at distinct roles: arda=project admin, murat=maintainer, selin=contributor, elif=viewer, deniz=non-member. Plus `writeProject`, `writeTask`, `baseTaskFrontmatter`. |
| `test-app.ts` | Route-level harness: points `process.env.VIBERR_DATA_ROOT` at a temp dir, resets env + DB singletons, **installs the fake runtime**, returns `{ db, dataRoot, cookieFor(userId), csrfFor(sessionId), request(url, init), cleanup() }`. `cookieFor` signs in through better-auth for real and resets that email's login rate-limit bucket first (`:96-106`) — the limiter is a per-process global shared by every test in the worker. `request()` sets `Origin: http://localhost:5173` so `assertTrustedOrigin` passes. `APP_TEST_PASSWORD = "test-harness-password-000"`. |
| `fake-runtime.ts` | `installFakeRuntime()`, `queueFakeRun()`, and — important — `startedRunSpecs()` / `lastRunSpec()` (`:32-38`) so a test can assert **what a path SENT** to the runtime (prompt, denylist, mcpServers), not just what it returned. |
| `fake-github.ts` | `fakeGithubFetch(...)` responder table + `unreachableFetch()` (simulates `ENOTFOUND api.github.com`). |
| `demo-seed.ts` | The demo fixture (see §2). Re-exports `SEED_DEFAULT_PASSWORD`. |
| `demo-data.ts` | 41 KB of the mock dataset: `SEED_PEOPLE`, `seedProjects`, `seedTasks`, `seedStubTasks`, `seedNotifications`. |
| `audit-log.ts` | `listAuditEvents(db, …)` for asserting audit rows. |
| `custom-board.ts` | `CUSTOM_3_STAGE_BOARD` — non-governed workflow fixture. |

### 1.5 E2E (Playwright)

`e2e/` — 7 spec files + 1 setup file. **41 tests total** (40 specs + the setup login).

| file | tests | purpose |
|---|---|---|
| `auth.setup.ts` | 1 (setup project) | Logs in through the **real `/login` UI** as `arda@viberr.dev` / `viberr-dev-2828` (`SEED_DEFAULT_PASSWORD`, imported from `test-support/demo-seed`), saves storage state to `e2e/.auth/arda.json`. Waits `networkidle` then retries the whole fill+submit inside `expect(...).toPass({timeout: 30_000})` — the inputs are React-controlled, so a fill landing before hydration gets wiped. |
| `01-home-board.spec.ts` | 6 | Golden path (a): Home lists the three seeded projects, viberr-core board renders stage columns with VIB-142 in Review; **plus 4 dnd-kit drag scenarios with real pointer input** (same-stage non-append slot on the wire, cross-stage append onto a column body, Escape cancels with zero requests, Done-stage drop without an accepted verdict refused with an error toast). Helpers: `column()`, `reorderPost()` (asserts on the submitted `intent=reorder` POST body), `liftOver()` (`mouse.down` → `mouse.move(..., {steps: 12})`). |
| `02-feeds-profile.spec.ts` | 5 | Review queue partitions VIB-142 correctly and its rows name their primary action (R15-11); activity feed renders day-grouped events; notifications mark-all-read clears every unread row; profile theme switch persists across reload. |
| `03-org-settings-store.spec.ts` | 3 | Org settings tabs render for an org admin; settings headings name their own scope (R15-13); **StoreBrowser performs a REAL file-store mkdir through the UI**. |
| `04-palette-mobile.spec.ts` | 4 | ⌘K global palette jumps to the task (R15-5); the board keeps its own board-scoped filter; at 375px the workspace rail collapses behind a toggle with no sideways scroll (F15-18); a non-member gets the unknown-slug 404 on a project board (R15-4). |
| `05-task-comment-composer.spec.ts` | 7 | Lexical composer against the production image: typing plain text posts the trimmed draft; Enter = line break and ControlOrMeta+Enter sends multiline; @-mention keyboard selection inserts a live chip; @-mention click insertion with the posted bytes asserted on the wire; Escape closes the menu without inserting; undo cannot resurrect a sent comment; the composer is an accessible combobox wired to the mention listbox. **Every test gates on zero `pageerror`** via `beforeEach` collector + `afterEach` assertion (`:17-27`). |
| `06-activity-hydration.spec.ts` | 1 | Activity page hydrates clean under `test.use({ timezoneId: "Pacific/Auckland" })` — zero page errors and no `Today`/`Yesterday` in the SSR HTML. Auckland is chosen so the spec still discriminates when the Playwright host itself is UTC (CI), and because it pushes most UTC timestamps across a **day** boundary, exercising the day-bucket regroup and not just clock text. |
| `07-accessibility.spec.ts` | 14 | WCAG 2.2 AA gate (P13-D-12). 6 surfaces (board, task detail, review, policy, home, agents) × 2 themes = 12, plus login signed-out × 2 themes. `@axe-core/playwright` with tags `wcag2a`/`wcag2aa`/`wcag22aa` **only** — best-practice rules are opinions and failing CI on an opinion trains people to ignore the gate (`:16-19`). Theme is set via the `viberr_theme` cookie scoped to `new URL(page.url()).origin` (the stack serves on a derived 127.0.0.1 port; a hard-coded host silently never applies). Login waits on `getAnimations({subtree:true})` finishing before axe samples computed colors. |

The numbering used to run `01, 05..10` — `02`, `03`, `04` had been deleted with
the simulated runtime (ruling R7-2, "don't simulate at all"), and the survivors
were rewritten to describe seeded state rather than the mutations those specs
produced (`02-feeds-profile.spec.ts:8-11`). G10 renumbered them contiguously,
because a permanent gap reads as "three specs are missing" to everyone who did
not live through R7-2. The prefix is **presentation only** —
`playwright.config.ts:28` takes the whole `testDir`, so nothing selects a spec by
number — but with `fullyParallel: false, workers: 1` it *is* the run order, so
`07-accessibility.spec.ts` deliberately kept its number instead of sliding to
`04`: it is the cross-cutting gate, it is nicer last, and its filename is cited
from `app/app.css.test.ts` (the static-token check names the rendered-page
counterpart).

### 1.6 How `npm run e2e` works now

`"e2e": "tsx scripts/e2e.ts"` (`package.json:14`). **Docker is required.**
Owner policy 2026-08-02: *anything that serves the app for a test runs the
PRODUCTION image — never a dev server.* The old `webServer` path is deleted.

`scripts/e2e.ts` flow:

1. `PROJECT = "viberr-e2e"`, `COMPOSE = ["compose","-f","compose.e2e.yml","-p","viberr-e2e"]` (`:17-18`).
2. `down --volumes --remove-orphans` — clean slate even after a crashed run (`:64`).
3. `up --build --detach --wait --wait-timeout 300` (`:66`). Compose runs the
   **seed one-shot first**, then the app (`depends_on: service_completed_successfully`).
   On failure it dumps `logs --tail 100` and tears down (`:67-72`).
4. `docker compose port app 3000` → derive the random loopback host port →
   `baseUrl = http://127.0.0.1:<port>` (`:74-81`).
5. `waitForHealth(${baseUrl}/resources/health, 60_000)` — polls every 500 ms for
   HTTP 200 **and** `body.ok === true` (`:41-58`).
6. `npx playwright test <passthrough argv>` with `VIBERR_E2E_BASE_URL=baseUrl`
   in the env (`:87-89`). Extra args pass straight through:
   `npm run e2e -- e2e/01-home-board.spec.ts`.
7. `finally`: `down --volumes --remove-orphans`, **unless** `VIBERR_E2E_KEEP=1`,
   in which case it prints the base URL and the manual teardown command (`:95-102`).
   Playwright failure also dumps the last 100 app log lines (`:90-93`).

**The seed one-shot runs from the BUILD stage.** `compose.e2e.yml:19-31`:

```yaml
seed:
  build: { context: ., target: build }
  command: sh -c "npm run seed:demo && chown -R 1000:1000 /data"
```

`test-support/` deliberately never ships in the final image (the Dockerfile's
runtime stage copies only `node_modules`, `build`, `package.json`, `db`,
`scripts`, `app`, `tsconfig.json` — `Dockerfile:48-59`), but the build stage did
`COPY . .` (`Dockerfile:14`) and so still has the full source tree. The one-shot
seeds the volume **as root**, then `chown -R 1000:1000 /data` hands ownership to
the final stage's UID-1000 `node` user before the app boots. `.dockerignore`
excludes `e2e`, `design`, `planning`, `docs` but **not** `test-support` — that
omission is what makes this work.

---

## 2. Seeds & fixtures

### 2.1 `scripts/seed.ts` — the PRODUCT seed (clean sheet)

`npm run seed` (`--reset` to wipe first). Seeds only:

- the built-in agent catalog templates (operator, developer, reviewer),
- org resources via `seedOrgResources` — knowledge bases with real files, skills,
  the domain allowlist. **No** MCP servers, **no** GitHub connection are
  fabricated (honest empty slate),
- on an **empty users table only**, the bootstrap admin from
  `VIBERR_SEED_ADMIN_EMAIL` / `VIBERR_SEED_ADMIN_PASSWORD`
  (defaults `admin@viberr.dev` / `SEED_DEFAULT_PASSWORD`).

`--reset` wipes `projects/`, agent profiles, runtime transcripts and all derived
tables; **users/auth and runtime credential homes survive** (`scripts/seed.ts:10-12`).

**Clean-sheet philosophy** (owner ruling 2026-07-24): a real instance starts with
an empty board. Demo/mock data is a *test fixture*, not product content. Never
reintroduce demo rows into `seed.server.ts` or a migration.

### 2.2 `scripts/seed-demo.ts` + `test-support/demo-seed.ts` — the DEMO fixture

`npm run seed:demo` (`--reset`). **TEST/DEV ONLY.** Seeds the mock dataset the
e2e specs and route-level suites are written against:

- users arda / elif / murat / selin / deniz `@viberr.dev`,
- `viberr-core` plus two stub projects,
- tasks **VIB-139…VIB-168** with full timelines,
- Arda's notification inbox, the VIB-142 `pull_request:write` scope violation,
  Arda's Home pins.

Idempotent: users upserted by email, files overwritten, rescan reconciles
projections, notification rows use deterministic ids.

The script imports `test-support/demo-seed` **dynamically** (`scripts/seed-demo.ts:21-36`)
so running it in the production image fails with a clear "dev-only, needs
`test-support/`" message. The `catch` also `console.error(error)` first — an
earlier version swallowed the real cause and a Vite-only `?raw` import failing
under `tsx` surfaced as a misleading "not shipped in the production image".

**Password:** `SEED_DEFAULT_PASSWORD = "viberr-dev-2828"`, defined in
`app/server/seed/seed-credentials.ts:12` — a module with **zero imports**, on
purpose. Playwright's Babel transform has no `?raw` loader, and `seed.server.ts`
transitively imports shipped agent assets through Vite's `?raw`; importing the
constant from there once broke the entire e2e config load. Keep that module
import-free.

E2E login: **`arda@viberr.dev` / `viberr-dev-2828`**.

### 2.3 `VIBERR_DATA_ROOT` hermetic-CI trick

Run vitest with `VIBERR_DATA_ROOT=<an empty directory>`:

```sh
mkdir -p /tmp/viberr-empty && VIBERR_DATA_ROOT=/tmp/viberr-empty npm test
```

Origin: a real product bug (`applyAgentCompletionEffects`'s failed-run branch
called `notifyTaskWatchers` without `ctx` — the only one of 5 call sites to omit
it — so recipient resolution read the *default* data root and failed-run
notifications were silently never delivered whenever `dataRoot ≠ ./data`). Every
dev machine masked it because `./data` happens to exist. The full suite passes
under an empty root today; use it to catch the "reads the ambient data root"
class before CI does.

Note `test-app.ts:42` already overrides `VIBERR_DATA_ROOT` per test to a temp dir,
and `setup-env.ts` pins the transcript stores — the trick catches whatever escapes
both.

---

## 3. Hard-won test recipes

Each verified against current code; paths and lines are live.

### 3.1 Driving Lexical in jsdom — `__lexicalEditor` + async `act`

jsdom **cannot synthesize typing into a contenteditable**. The composer suite
drives the real editor instead (`app/features/task-detail/mention-composer.test.tsx`):

```ts
// :85-90 — grab the editor instance off the DOM node
const ce = utils.container.querySelector('[contenteditable="true"]') as HTMLElement;
const editor = (ce as unknown as { __lexicalEditor: LexicalEditor }).__lexicalEditor;
expect(editor).toBeTruthy();

// :97-112 — set the whole draft through a real editor update.
// ASYNC act is mandatory: Lexical commits in a MICROTASK, so the act must flush
// it before the test fires keys at the (otherwise still-empty) editor.
async function setText(editor: LexicalEditor, text: string) {
  await act(async () => {
    editor.update(() => {
      const root = $getRoot();
      const first = root.getFirstChild();
      if ($isParagraphNode(first)) { $setParagraphPlainText(first, text); return; }
      root.clear();
      const paragraph = $createParagraphNode();
      root.append(paragraph);
      $setParagraphPlainText(paragraph, text);
    });
  });
}

// :114-120 — read back through the editor state, never the DOM
function readText(editor: LexicalEditor): string {
  let out = "";
  editor.getEditorState().read(() => { out = $getRoot().getTextContent(); });
  return out;
}
```

Keys fire as **DOM `keydown` events on the contenteditable** (`fireEvent.keyDown(ce, …)`)
— Lexical's own listeners dispatch the commands. Assertions read the editor state
or the submitted form, never innerHTML. The mention menu is found globally via
`document.querySelector('[role="listbox"]')` (`:123`) since it portals out.
Prerequisite: the `// @vitest-environment jsdom` pragma on line 1 **and** the
`ResizeObserver` stub from `setup-dom.ts`.

### 3.2 Fake timers for the toast

`app/ui/toast.test.tsx`. The toast is a two-phase dismissal: **2600 ms** alive,
then `.leaving` for **200 ms**, then unmount.

```ts
afterEach(() => { cleanup(); vi.useRealTimers(); });   // :12-15 — ALWAYS restore

vi.useFakeTimers();                                    // :28 — inside the it(), before render
fireEvent.click(getByText("push"));
act(() => vi.advanceTimersByTime(2600));               // :40 — advance INSIDE act()
expect(toast()!.classList.contains("leaving")).toBe(true);
act(() => vi.advanceTimersByTime(200));                // :44
expect(toast()).toBeNull();
```

Two variants elsewhere, pick deliberately:

- `vi.useFakeTimers({ shouldAdvanceTime: true })` + `await vi.advanceTimersByTimeAsync(200)`
  when the code under test also awaits real promises
  (`app/features/shell/command-palette.test.tsx:75,82`).
- `vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })` when a **native
  watcher must stay real** (`app/server/files/file-watch.service.server.test.ts:202`).
- `vi.setSystemTime(...)` for elapsed-time hooks (`app/features/runtime/use-elapsed.test.tsx:43-44`).

### 3.3 Dialog close is synchronous under jsdom (by design)

`app/ui/use-dialog.ts:34-45`:

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
mid-fade (`:54-59`), with a `seconds*1000 + 50` ms fallback timer (`:62`).

Two live-browser gotchas that do **not** apply to jsdom but will bite you when
verifying by hand:

- A synthetic `element.click()` fires at (0,0) → `useDialog`'s backdrop-click
  handler (`:96-108`) reads that as outside the card rect and **silently closes
  the dialog**. Use real pointer events.
- CDP-synthesized Escape does not fire `<dialog>`'s `cancel` event; dispatch
  `new Event("cancel")` instead.

### 3.4 Canary methodology — revert the fix, watch the test fail

The question that matters is **"would this test fail against the old behavior?"**
This is not theoretical: in pass 14 an adversarial verifier found a fix whose test
exercised the *prompt builder*, so deleting the actual wiring left the suite green.

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

### 3.5 `npm run build` ≠ typecheck — `tsc` is a required gate

```json
"build":     "react-router build",                 // package.json:11 — Vite/esbuild, ZERO type checking
"typecheck": "react-router typegen && tsc"         // package.json:10 — the only type gate
```

A build that succeeds proves nothing about types. `typecheck` also runs
`react-router typegen` first, which regenerates `.react-router/types/**` — those
are in `tsconfig.json`'s `include` and `rootDirs`, so `tsc` alone (without typegen)
can fail or pass spuriously on route-module types after a route change. This has
produced self-inflicted bugs before (pass 12 — two of them). `tsconfig.json` runs
`strict`, `noUnusedLocals`, `noUnusedParameters`, `verbatimModuleSyntax`,
`erasableSyntaxOnly`.

### 3.6 The WAL stale-read gotcha — verify via the UI, not the sqlite CLI

The running app holds state in the SQLite **WAL**. A `sqlite3` CLI read of
`docker-data/state/projection.sqlite` can return a **stale, pre-write snapshot** —
in one incident a phantom old user id and `notifications` count 0 while the server
had in fact written the rows.

**Rule:** verify live behavior through the UI (`/notifications`, the page itself)
or the server logs. A CLI query of the projection DB is not evidence that a write
didn't happen. If you must query, query from inside the running process's
container (`docker compose exec app …`) rather than from the host.

### 3.7 Baseline-vs-live-dev-DB schema comparison

Ruling: migrations stay **squashed into `db/migrations/0001_baseline.sql`**
pre-production (there is exactly one migration file today). Consequence chain:

- The runner records `0001` as applied. **Editing the baseline does not reach a DB
  that already recorded it applied.**
- Re-baselining (wipe + re-seed) **regenerates user ids**, and every file-based
  `project.md` `members:` entry points at the old ids — the memberships break.

So a schema change with a live dev DB requires **both**:

1. Edit `db/migrations/0001_baseline.sql` (correct for fresh installs), **and**
2. A one-off `sqlite3 ALTER TABLE …` against `docker-data/state/projection.sqlite`
   — with the app stopped (see §5 dual-writer hazard).

To compare a baseline against a live DB, or to regenerate the baseline after a
better-auth bump:

```sh
# 1. schema of a FRESH migrated DB (what the baseline produces)
node -e '…openDatabase(tmp); runMigrations(tmp)…'   # or: npx tsx a throwaway script
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

Historical note, now stale: a `scripts/gen-better-auth-schema.ts` generator and a
`db/better-auth-reference.sql` reference dump are referenced in older planning
notes — **neither exists on `main` today**. Use §3.7b instead; dumping the live
schema only tells you what the baseline already said, not what the new
better-auth wants.

### 3.7b better-auth schema refresh (G8)

`0001_baseline.sql` ends with four hand-inlined statements — `"user"`,
`"session"`, `"account"`, `"verification"` — plus their three indexes. They are
lower-cased and quoted (`"id" text not null primary key`) unlike everything else
in the file, because they are **pasted `@better-auth/cli generate` output**, not
hand-written. Until G8 nothing in the repo said so, and there was no way to tell
a deliberate divergence from a stale paste.

`@better-auth/cli` is deliberately **not a dependency**. It is codegen run by
hand at version-bump time, it drags better-auth's whole plugin surface in, and it
would earn its install cost roughly once a year. Run it with `npx` at the pinned
version instead:

```sh
# check `generate --help` first: the flag names have moved across majors,
# but the shape is always config-in, SQL-out.
npx @better-auth/cli@1.6.25 generate \
  --config app/lib/auth.server.ts --output /tmp/ba-schema.sql -y
diff <(sed -n '/CREATE TABLE "user"/,$p' db/migrations/0001_baseline.sql) /tmp/ba-schema.sql
```

Fold the diff in by hand. Three things to know:

- **`githubHandle` on `"user"` is ours**, from `user.additionalFields` in
  `buildAuthOptions` plus the GitHub provider's `mapProfileToUser`. The CLI emits
  it only when it successfully loads the config; if it vanishes from the output,
  the CLI failed to read `auth.server.ts`, not better-auth dropped a column.
- **`verification` is live, despite no app code naming it.** `createAuthContext`
  picks `account.storeStateStrategy || (isStateful ? "database" : "cookie")` and
  `isStateful` is just `!!options.database` — we pass one, so every OAuth
  sign-in INSERTs its signed state there (`generateGenericState`) and the
  callback reads-then-deletes it (`parseGenericState`, `dist/state.mjs`). Drop
  the table and GitHub/Google login dies with better-auth's own *"there is a
  verification table in the database"* error. There is no unit test for this —
  the app has no OAuth credentials in test — so the comment on the table is the
  gate.
- A column ADDITION or a new plugin table pastes straight in; a **rename** means
  read the changelog first, since better-auth does not rename core columns
  outside a major.

Then re-baseline (`npm run seed -- --reset`): there is no ALTER path, per the
squashed-baseline convention above.

### 3.8 Bonus conventions worth knowing

- `serializeTaskFile` emits frontmatter in **object-property order**. A new
  frontmatter field must sit exactly where the tolerant parser constructs it or
  the byte-identical round-trip test fails.
- **Stale-fetcher-data bug class:** `fetcher.data` persists after `state === "idle"`,
  so any fetcher-result effect with extra state in its deps re-fires on that state
  and replays the stale success. The repo idiom is a `handled = useRef` identity
  guard (timeline composer, store-browser). Any **new** fetcher-result effect must
  use it — otherwise react-doctor's `no-effect-chain` will (correctly) flag it.

---

## 4. CI / local gates — what must be green

`.github/workflows/ci.yml`, two jobs, Node 26, `npm ci`:

**`verify`** — `npm run typecheck` → `npm test` → `npm run build`.
**`e2e`** — `npx playwright install --with-deps chromium` → `npm run e2e`
(uploads `playwright-report/` as an artifact on failure, 7-day retention).

Locally, before a change counts as done:

```sh
npm run typecheck   # react-router typegen && tsc   — the ONLY type gate
npm test            # vitest run                    — 207 files / ~2478 tests
npm run build       # react-router build            — bundling/asset gate
npm run e2e         # tsx scripts/e2e.ts            — production image, Docker required
npx -y react-doctor@latest --json --yes   # React/a11y/architecture lint
```

**Do not skip `npm run e2e` because the other three are green.** From
`CONTRIBUTING.md:61-63`: the pass-13 install regression passed typecheck, 1663
unit tests and the build, and was caught only here. Same class again in pass 14 —
a new `<select>` option shadowed an unscoped `getByText` (an `<option>` is never
"visible"), caught by e2e after 2123 unit tests + typecheck + build all passed.

**react-doctor.** Two artifacts, both canonical:

- `doctor.config.ts` — the scanner-level ignore list:
  `**/design/**`, `**/.claude/**`, `**/data/**`, `**/*.server.test.ts`.
  `.claude/worktrees` and `data/` both hold live agent **checkouts of this same
  repo**, so scanning them double-counts every finding against stale copies;
  `design/` is the standalone static mockup bundle (its `support.js` alone
  produced 45 phantom `postmessage-origin-risk` hits). Corollary: those dirs also
  break naive repo-wide greps — filter `worktrees`, and "unused on main" may be
  used on a worktree branch.
- `.react-doctor/false-positives.md` (154 lines) — **the canonical step-2 filter**.
  Diagnostics matching a pattern here are dropped before fixing. Entries that say
  "verify" require an actual Read/grep of the flagged site first — **never suppress
  on filename alone**, and lines drift. Documented FP classes include:
  remount-keyed `useState(prop)`, capture-once optimistic state, fetcher-lifecycle
  effects, append-only index keys, `.includes()` over bounded tiny arrays, and the
  two `effect-needs-cleanup` "errors" that are FPs by the rule's own validation
  prompt (an effect-local `EventSource`/`addEventListener` needs no
  `removeEventListener` when cleanup calls `source.close()`) — they will fire on
  every future scan.

The react-doctor tool score wobbles ±1 between `@latest` runs at identical
findings. Don't chase it.

---

## 5. Docker / Compose

### 5.1 `Dockerfile` — two stages

- **`build`** (`node:26-slim`): `npm ci` → `COPY . .` → `npm run build` →
  `npm prune --omit=dev`. **Has the full source tree, including `test-support/`.**
- **runtime** (`node:26-slim`): installs `git` + `ca-certificates` (real agent runs
  clone repos and shell out to git). Env: `NODE_ENV=production`,
  `VIBERR_DATA_ROOT=/data`, `CLAUDE_CONFIG_DIR=/data/runtimes/claude-home`,
  `CODEX_HOME=/data/runtimes/codex-home`, `PORT=3000`. Copies **only**
  `node_modules`, `build`, `package.json`, `db`, `scripts`, `app`, `tsconfig.json`
  (`:48-59`) — `db` + `scripts` + `app` are there so `docker compose exec app npm run seed`
  works via tsx. `mkdir -p /data && chown node:node /data`, then `USER node`.
- `ENTRYPOINT ["sh", "/app/scripts/docker-entrypoint.sh"]` (sh-prefixed so the
  file's exec bit can't matter); it seeds Codex CLI auth from the optional
  read-only host mount then `exec`s the CMD.
- **CMD runs the server binary directly, NOT `npm run start`** (`:74-81`). With npm
  in between, npm is pid 1 and node is its child, and `docker compose stop`'s
  SIGTERM never reaches node — and node's shutdown handler is what **checkpoints
  the WAL and releases the data-root writer lock (B-FD1)**. The npm-wrapped
  version left a lock file behind on every stop and the next boot could refuse to
  start.

### 5.2 `compose.yml` — the production stack (dev/ops use)

- `hostname: viberr` — **pinned on purpose** (`:6-10`). The data-root writer lock
  records its holder's hostname and a lock from a *different* host is refused (the
  one host it cannot probe for liveness). Compose's default hostname is the
  container id, so every `down && up` came back as a stranger to its own leftover
  lock. Pinned, a recreated container probes its predecessor's pid and reclaims it.
- `env_file: .env`, then `environment:` **force-overrides** `NODE_ENV=production`,
  `VIBERR_DATA_ROOT=/data`, `CODEX_HOME=/data/runtimes/codex-home` even when `.env`
  carries the dev equivalents.
- Ports `"${PORT:-3000}:${PORT:-3000}"` — compose interpolates `${PORT}` from the
  same `.env` it injects, so the mapping always matches what the server listens on.
- Volumes: `./docker-data:/data` (everything stateful — canonical markdown, SQLite
  projections, run logs, KBs; back this up), plus
  `${CODEX_CLI_HOME:-~/.codex}:/host-codex:ro`. That second mount is a **directory**
  mount, not a file mount, because the Codex CLI rewrites `auth.json` via rename —
  a file mount would pin the dead inode and go silently stale.
- Healthcheck: in-container `node -e "fetch('http://127.0.0.1:'+PORT+'/resources/health')…"`,
  30 s interval / 5 s timeout / 3 retries / 20 s start period.
  `/resources/health` returns `{ ok, projections, watcher, kbWatcher, backends }`;
  `watcher: false` is **real** (dead watcher), not "never started"
  (`app/routes/resources.health.ts:13-16,37-40`).

### 5.3 `compose.e2e.yml` — the e2e override stack

Not meant for `docker compose up` by hand. Never touches the main compose project,
`.env`, `./docker-data`, or any host credential.

- **Synthetic secrets only**, shared by seed and app via a YAML anchor (`:12-16`):
  `VIBERR_DATA_ROOT=/data`,
  `VIBERR_SESSION_SECRET=e2e-session-secret-0123456789abcdefghijklmnop`,
  `VIBERR_SECRET_ENCRYPTION_KEY=AAAA…AAA=` (base64 of 32 zero bytes).
- `seed` service: `target: build`, `command: sh -c "npm run seed:demo && chown -R 1000:1000 /data"`,
  `restart: "no"`.
- `app` service: `depends_on: seed: { condition: service_completed_successfully }`,
  `hostname: viberr-e2e` (same writer-lock rationale), `NODE_ENV: production`,
  port `"127.0.0.1::3000"` (random loopback host port, derived by the orchestrator).
- Healthcheck is tighter than production's: 2 s interval / 5 s timeout / **30
  retries** / 5 s start period.
- Project-scoped named volume `e2e-data`, removed by `down --volumes` after every run.

### 5.4 `--no-deps` for restarts

`compose.e2e.yml:41-42`: *"Restart tests must use `--no-deps` so the seed one-shot
cannot re-run and reset the volume mid-check."*

```sh
docker compose -f compose.e2e.yml -p viberr-e2e up -d --no-deps app     # app only
docker compose -f compose.e2e.yml -p viberr-e2e restart app             # also safe
```

Without `--no-deps`, compose re-evaluates the `seed` dependency and can wipe the
state the restart test is checking.

### 5.5 The docker-data dual-writer hazard — **one app process per data root, EVER**

The single most expensive mistake in this repo's history. **Two data-eating
incidents.**

What happened (2026-07-25): a host dev server (writer) was stopped while the
compose container was recreated → the container's `node:sqlite` handle over the
macOS VirtioFS bind mount **wedged** (`disk I/O error` on every query; a fresh
handle worked) → the un-checkpointed WAL was destroyed. **Lost:** `github_pats`,
`project_github_credentials` (a freshly re-added PAT), all `agent_runs` rows and
log lines, notifications, and ~12 minutes of audit rows. **Survived:** everything
file-canonical (task.md timelines, projects, users) — projections rebuilt from files.

Why: SQLite WAL across host + container over a macOS bind mount has no shared lock
truth; kill/recreate windows corrupt or discard the WAL.

**How to apply:**

- Exactly **one** app process per data root, ever.
- Before starting a dev/preview server on `docker-data`, check `docker ps` for
  `viberr-app-1`. And vice versa.
- After any wipe/restart, restart whichever process stayed up.
- A container restart clears a wedged handle: `docker compose restart app`.
- The product now has a boot-time writer lock (B-FD1,
  `app/server/db/data-root-lock.server.ts`, `DATA_ROOT_LOCK_FILENAME = "writer.lock"`
  at `:40`, taken in `boot.server.ts:140`) — it refuses the second process rather
  than corrupting. Do not "force" past it casually.

### 5.6 `.env` vs `launch.json` data-root mismatch (live fact)

```
.env:4                     VIBERR_DATA_ROOT=./data       # a STALE Jul-20 root
.env:5                     PORT=5173
.claude/launch.json        export VIBERR_DATA_ROOT=/Users/akinozer/projects/viberr/docker-data
                           export CODEX_HOME=…/docker-data/runtimes/codex-home
                           port 5173
```

So a dev server launched via `.claude/launch.json` and the compose container
**share `./docker-data`**, while a bare `npm run dev` reading `.env` uses the stale
`./data`. Both facts bite: the first is exactly the dual-writer hazard, the second
means "the app doesn't show my data" is often just the wrong root. Always confirm
which root a process is on before concluding anything about state.

`.env` is gitignored, so the repo cannot fix the live one. What the repo *can*
do, and now does (B7): **`.env.example` sets `VIBERR_DATA_ROOT=./docker-data`
uncommented**, and says in place why the value must match `.claude/launch.json`.
The old example left it commented out at the `./data` default, which is how the
mismatch reads as a deliberate choice instead of a leftover. Fixing your own
`.env` is still a manual step — do it, then confirm with the boot log's data-root
line before trusting anything you see in the UI.

Note `vite.config.ts:18` resolves the same variable to exclude the data root from
the dev watcher (task workspaces are full nested clones with their own `.git` and
`tsconfig.json`; Vite would treat them as app source — F10-36).

---

## 6. Playwright config details

`playwright.config.ts` (55 lines, whole file):

| setting | value | note |
|---|---|---|
| `testDir` | `"e2e"` | |
| `baseURL` | `process.env.VIBERR_E2E_BASE_URL` | **Throws at config load if unset** (`:17-25`) with a message pointing at `npm run e2e`. A bare `npx playwright test` has no app to target. |
| `fullyParallel` | `false` | |
| `workers` | `1` | The specs share the seeded store. |
| `forbidOnly` | `!!process.env.CI` | |
| `retries` | `process.env.CI ? 1 : 0` | **Zero retries locally** — a local failure is a failure. |
| `reporter` | CI: `[["list"], ["html", {open:"never"}]]`; local: `"list"` | |
| `timeout` | `45_000` per test | |
| `expect.timeout` | `10_000` | |
| `use.trace` | `"retain-on-failure"` | Traces land in `test-results/`. |
| `webServer` | **absent — deliberately removed** | The dev-server path was deleted with the 2026-08-02 production-image policy. |

**Projects** (`:42-53`):

1. `setup` — `testMatch: /auth\.setup\.ts/`. Logs in through the real UI.
2. `chromium` — `devices["Desktop Chrome"]`, `storageState: "e2e/.auth/arda.json"`,
   `dependencies: ["setup"]`.

`e2e/.auth/` and `test-results/` are gitignored (`.gitignore:11-14`).

To run a single spec: `npm run e2e -- e2e/05-task-comment-composer.spec.ts`.
To keep the stack alive for manual poking: `VIBERR_E2E_KEEP=1 npm run e2e`.

---

## 7. Known flaky areas — and telling flake from regression

### 7.1 The real-FS-event tests (E13 / KB watcher)

`app/server/files/file-watch.service.server.test.ts` and
`kb-watch.service.server.test.ts` drive **real filesystem events through chokidar**.
Under back-to-back full-suite runs, **macOS DROPS (not merely delays) coalesced
FSEvents** when the machine is churning temp dirs. Historical rate: the E13
`unlinkDir` tests flaked roughly **2 in 5** back-to-back full runs.

Three mitigations are already in the tree — understand them before touching:

1. **The real bug that was hiding behind the flake:** chokidar's `ENOENT` was
   treated as fatal, killing the watcher and cancelling the *queued unlink
   reconcile*, orphaning projections. Now benign and regression-tested:
   `file-watch.service.server.ts:240-246`, `kb-watch.service.server.ts:126-130`;
   test at `file-watch.service.server.test.ts:179-192`
   ("ENOENT is benign: deleting a watched path must not kill the watcher").
2. **Event re-offering inside the poll window.** `waitFor(cond, what, nudge)`
   (`file-watch.service.server.test.ts:35-51`) runs `nudge` every 4 s to
   **re-offer** the awaited event. `pokeDir()` (`:57-59`) writes a `poke-marker`
   file — deliberately **not** a dot/tmp name (ignored names can skip the rescan
   entirely) and **not** a canonical basename (so the add reaches chokidar's
   differ but never the projection handlers). This forces the watcher to re-diff
   the listing and emit the missed unlink. The KB test applies the same idea as a
   periodic re-touch of the watched file inside its poll window
   (`kb-watch.service.server.test.ts:140-151`, `touches` counter).
3. **`await ready` before acting.** Chokidar arms **asynchronously**;
   `startWatcherReady()` (`:61-68`) awaits `watcher.once("ready")` — the initial
   scan completing. The listener attaches in the same synchronous frame as the
   start, so the event cannot have fired before it.

Timeouts: `WAIT_TIMEOUT_MS = 12_000` inside `waitFor`, per-test `15000`.

Post-fix record: **4/4 consecutive full-suite runs green (2475/2475)**
(IMPLEMENTATION.md:113-118).

### 7.2 Distinguishing flake from regression

| signal | flake | regression |
|---|---|---|
| Re-run the single file in isolation (`npx vitest run <file>`) | **passes** | still fails |
| Failure message | `timed out waiting for: <what>` from the `waitFor` helper | a concrete assertion diff (`expected 1, received 2`) |
| Machine state | full suite running back-to-back, other watchers/temp-dir churn | reproduces on an idle machine |
| Convergence | eventually converges when nudged / on a quiet box | *"a genuinely broken reconcile path never converges regardless and still times out"* (`file-watch.service.server.test.ts:32-33`) |
| Scope | only the two real-FS-event describe blocks | anything else |

Rules of thumb:

- **Only the FS-event tests get this benefit of the doubt.** A flake anywhere else
  is a bug until proven otherwise — most often a real ordering/async defect.
- Confirm by running the file alone **three times**. Three greens in isolation +
  intermittent red in the full suite = environmental. Any red in isolation = real.
- If you touch a watcher, re-run the two watcher files back-to-back several times;
  don't trust a single green.
- E2E: `retries: 1` on CI, `0` locally. A local e2e failure is never "just flake" —
  reproduce it with `VIBERR_E2E_KEEP=1 npm run e2e -- <spec>` and open the trace
  from `test-results/`.
- Two e2e areas are **design-verified, not e2e-verified**, so don't expect coverage:
  OS-level IME composition (the composer guards via `editor.isComposing()`), and
  touch dragging behind the 250 ms long-press (Playwright cannot synthesize full
  touch drags).

---

## 8. Definition of done — follow verbatim

For any code change:

- [ ] **1. Colocate the test.** `foo.server.ts` → `foo.server.test.ts`;
      `foo.tsx` → `foo.test.tsx` with `// @vitest-environment jsdom` on **line 1**.
- [ ] **2. Canary the test.** Revert *only* the product change, run that file
      alone, confirm it **fails for the stated reason**, restore. A test that
      passes against the old behavior is not a test. (§3.4)
- [ ] **3. Assert at the right layer.** For runtime paths, assert what was **sent**
      (`lastRunSpec()` / `startedRunSpecs()`), not only what came back.
- [ ] **4. Route tests:** import the route module *after* `setupAppTest()`, include
      `_csrf` in every POST body, and `afterAll(() => app.cleanup())`.
- [ ] **5. `npm run typecheck`** — green. (`react-router typegen && tsc`. A green
      `npm run build` proves **nothing** about types. §3.5)
- [ ] **6. `npm test`** — green, no new skips, no increase in console noise.
      Baseline ≈ 207 files / 2478 tests.
- [ ] **7. Watcher/FS changes only:** run
      `npx vitest run app/server/files/file-watch.service.server.test.ts app/server/files/kb-watch.service.server.test.ts`
      **3× back-to-back**; all green. (§7)
- [ ] **8. `npm run build`** — green.
- [ ] **9. `npm run e2e`** — green (Docker required). **Never skip because 5–8 are
      green**; it is the only gate that boots the shipped production image, and it
      has caught regressions that passed all of the above twice. (§4)
- [ ] **10. New/changed UI surface:** add or extend an e2e spec, and if it is one
      of the PRD "core workflows", add it to `SURFACES` in
      `e2e/07-accessibility.spec.ts` so it is audited in **both** themes. A new
      interactive control shipping outside that sweep is a known past failure (R15-12).
- [ ] **11. New page/route:** gate on **zero `pageerror`** (the
      `05-task-comment-composer.spec.ts:17-27` pattern). Any timestamp or
      locale-dependent SSR text must render a **UTC-deterministic first pass** and
      swap in viewer-local after hydration (`app/ui/local-time.tsx`), or you ship a
      React #418 that regenerates the page client-side.
- [ ] **12. `npx -y react-doctor@latest --json --yes`** — no **new** unaddressed
      diagnostics. Filter through `.react-doctor/false-positives.md` (verify each
      flagged site by reading it; never suppress on filename alone) and check
      `filePath.startsWith("data/")` before triaging anything. New fetcher-result
      effects need the `handled = useRef` identity guard. (§3.8, §4)
- [ ] **13. Schema change?** Edit `db/migrations/0001_baseline.sql` **and** apply a
      one-off `sqlite3 ALTER` to the live dev DB (app **stopped**). Re-baselining
      wipes user ids that `project.md` memberships reference. (§3.7)
- [ ] **14. Verifying live?** Confirm exactly **one** app process owns the data root
      (`docker ps` vs. your dev server), and read state through the **UI or logs**,
      not a host `sqlite3` query (WAL stale reads). (§3.6, §5.5)
- [ ] **15. Don't reintroduce demo data into the product seed.** Mock content
      belongs in `test-support/demo-seed.ts` only. (§2.1)
- [ ] **16. Record it.** Follow `CONTRIBUTING.md`: branch off `main`, PR against
      `main`, CI green (both jobs), reviewer approval before merge. If a change
      contradicts a numbered ruling in `docs/architecture/decisions.md`, say so in
      the PR and get it re-ruled — never reverse one silently.

---

## Appendix — quick command reference

```sh
npm test                                    # full vitest suite
npx vitest run app/features/board/board-dnd.test.ts   # one file
VIBERR_DATA_ROOT=/tmp/empty npm test        # hermetic-root canary (§2.3)
npm run typecheck                           # typegen + tsc — the type gate
npm run build
npm run e2e                                 # full production-image e2e (Docker)
npm run e2e -- e2e/01-home-board.spec.ts    # one spec
VIBERR_E2E_KEEP=1 npm run e2e               # keep the stack up afterwards
docker compose -f compose.e2e.yml -p viberr-e2e down --volumes --remove-orphans   # manual teardown
docker compose -f compose.e2e.yml -p viberr-e2e up -d --no-deps app               # restart app only
npm run seed                                # clean-sheet product seed
npm run seed -- --reset
npm run seed:demo                           # demo fixture (test/dev only)
npm run rescan                              # rebuild projections from files
npx -y react-doctor@latest --json --yes
```

Key file map:

```
vitest.config.ts                      playwright.config.ts
scripts/e2e.ts                        compose.yml · compose.e2e.yml · Dockerfile
scripts/seed.ts · scripts/seed-demo.ts
test-support/setup-env.ts · setup-dom.ts · test-app.ts · test-db.ts · test-store.ts
test-support/demo-seed.ts · demo-data.ts · fake-runtime.ts · fake-github.ts
app/server/seed/seed-credentials.ts   # SEED_DEFAULT_PASSWORD, import-free on purpose
app/server/db/data-root-lock.server.ts # B-FD1 writer lock
app/ui/use-dialog.ts                  # synchronous close under jsdom
doctor.config.ts · .react-doctor/false-positives.md
.github/workflows/ci.yml              CONTRIBUTING.md · docs/testing-quickstart.md
```
