# TESTING-INFRA — Viberr current state (pass 21)

> **Verified 2026-08-19** against `main @ce2bc9e` (worktree
> `claude/viberr-app-inspection-1fe423`, identical to main). Every anchor,
> count and command below was re-run or re-read at this SHA.
>
> Drift since the pass-20 doc (`b97ad02`, 2026-08-14) is large: the pass-20
> branch merged (PR #169 → `6c94f2c`), then **two anti-slop lint commits
> rewrote 387 files including ~120 test files**. Almost every line number in
> the pass-20 doc's finding table has moved. See §11.

The test setup, the hermetic environment, the fake runtime, the e2e model,
the static gates, the new lint gate, and the conventions.

**Toolchain (measured):** vitest **4.1.10** · Node **v26.5.0** ·
TypeScript **7.0.2** · jsdom **30.0.1** · Playwright **1.62.1** ·
oxlint **1.79.0**.

---

## 0. Commands — the whole surface (Verified 2026-08-19)

From `package.json` (repo root; all commands run from the repo root):

| Command | What it is | In CI? |
| --- | --- | --- |
| `npm test` | `vitest run` — the unit/integration suite | yes |
| `npm run typecheck` | `react-router typegen && tsc` — **the** typecheck | yes |
| `npm run build` | `react-router build` — bundles; **NOT a typecheck** | yes |
| `npm run e2e` | `tsx scripts/e2e.ts` — production-image Playwright stack | yes (separate job) |
| `npm run lint` | `oxlint` — the anti-slop plugin gate | **NO — see §8** |
| `npm run seed:demo` | seeds the demo fixture (`test-support/`) into a data root | used by the e2e stack |

CI is `.github/workflows/ci.yml`: job `verify` = install → typecheck → test →
build; job `e2e` = install → `npx playwright install --with-deps chromium` →
`npm run e2e` → upload report on failure. **`npm run lint` is in neither
job.**

A git worktree has no `node_modules` of its own. If tooling fails with
`Cannot find package …`, run `npm ci` in the worktree (Vite's `fs.allow` also
needs a resolved `node_modules` — `vite.config.ts:25-33` handles that case
explicitly).

---

## 1. Test runner config — `vitest.config.ts` (Verified 2026-08-19)

Single config, **no** workspace/project split. Unchanged since pass 19/20.

- **Environment**: `node` globally (`vitest.config.ts:11`). There is no jsdom
  project — the **46** component/UI test files opt in **per file** with a
  `// @vitest-environment jsdom` header comment on line 1
  (e.g. `app/features/task-detail/mention-composer.test.tsx:1`).
- **Setup files** (`:15`): `["./test-support/setup-env.ts", "./test-support/setup-dom.ts"]`.
- **Include** (`:21`): `["app/**/*.test.{ts,tsx}"]`, no explicit exclude. A
  former `db/**/*.test.ts` glob was dropped (G10) — the comment at `:16-20`
  explains why (it matched zero files after migrations were squashed).
- **Path alias**: `resolve.tsconfigPaths: true` (`:7`) — Vite 8 native `~/*`
  resolution; the `vite-tsconfig-paths` plugin is gone.
- **Coverage**: none configured.

`vite.config.ts` is the app dev/build config (React Router plugin), not the
test config. It excludes the runtime data root from the dev watcher
(`vite.config.ts:48-51`) because task workspaces under it are full nested repo
clones with their own `tsconfig.json` (F10-36).

---

## 2. Hermetic environment — `test-support/setup-env.ts` (111 lines) (Verified 2026-08-19)

Byte-identical to pass 20. Runs before any app module loads. Guarantees a suite
can never make a paid provider call, read host credentials, **or open a
socket**:

- **Seeds required secrets** so boot validation passes on a fresh clone with no
  `.env`: `VIBERR_SESSION_SECRET` (`:19`) and a 32-byte base64
  `VIBERR_SECRET_ENCRYPTION_KEY` (`:22-23`), both via `??=` so a real export
  still wins.
- **Credential scrub, fail-closed (F10-10)** (`:44-58`): sets
  `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `VIBERR_CLAUDE_USE_CLI_AUTH`,
  `CODEX_ACCESS_TOKEN`, `CODEX_API_KEY`, `OPENAI_API_KEY`,
  `VIBERR_CODEX_USE_CLI_AUTH` and `VIBERR_BROWSER_EXECUTABLE` (R19-19,
  `:52-55`) to `""`.
  **Assign `""` — never `delete`.** `env.server.ts` runs `loadEnvFile()` at
  module scope, i.e. *after* this setup file, and refills every key that is
  "not present"; a deleted key hands the developer's `.env` value straight back
  and re-opens the leak. `""` reads as absent to `hasCredential()`/`parseEnv`
  yet blocks the refill.
- **Transcript stores pinned to empty temp dirs (P13-D-2)** (`:85-89`):
  `CLAUDE_CONFIG_DIR` and `CODEX_HOME` point at fresh `mkdtemp` subdirs with
  `projects/` and `sessions/` created. The continuity probe is therefore
  deterministic (store *exists* but is empty → `missing`, not `unknown`), and
  `CODEX_HOME` can stay out of the scrub list — an empty dir with no
  `auth.json` keeps CLI-auth false by construction.
- **Network fail-closed for git (N19-6)** (`:111`): `GIT_ALLOW_PROTOCOL = "file"`.
  Two tests reach `cloneRepo` with a publicly-resolvable name
  (`akin-ozer/viberr`), so `npm test` used to make a real `git clone` and flake
  under parallel load. Git's own allow-list makes every https/ssh transport
  fail instantly and offline; `git init`/`add`/`commit` and `file://` remotes
  (the skill-mount fixtures) are unaffected.

`test-support/setup-dom.ts` (36 lines) is the jsdom shim: polyfills
`HTMLDialogElement.showModal/show/close` (`:7-22` — toggles the `open`
attribute and fires `close`) and stubs `ResizeObserver` for dnd-kit (`:29-36`).
Both blocks are `typeof window !== "undefined"`-guarded, so they no-op under
node.

**Harness-hermeticity self-test** —
`app/server/runtimes/harness-hermeticity.server.test.ts` (176 lines, 5 tests):
`describe("test-harness hermeticity")` **:44** asserts every credential is `""`
not deleted (`:51`), both backends report unavailable (`:57`), `CODEX_HOME`
exists with no `auth.json` (`:62`), and a `.env` carrying all credentials
cannot reload into the process (`:75`). A second describe,
`"dependency hygiene: every imported package is declared (C6)"` **:110**,
enforces import hygiene — no app import resolves only through npm hoisting
(`:158`).

---

## 3. Test helpers — `test-support/` (Verified 2026-08-19)

| File | Provides |
| --- | --- |
| `test-db.ts` (49 lines) | `createTestDbContext()` (`:24`) → `{ makeDb(), makeTempDir(), cleanup() }`. `makeDb()` opens a temp SQLite DB under `state/test.sqlite` and runs migrations (`:34-41`). `cleanup()` closes DBs then `rmSync`s every temp dir. |
| `test-store.ts` (159 lines) | `setupTestStore(ctx)` (`:52`) → temp data root + migrated DB + a seeded `viberr-core` project (repo `akin-ozer/viberr`, prefix `VIB`, `GOVERNED_TEMPLATE` stages/workflow) with 5 users at distinct project roles (`:73-79`). Also exports `writeProject` (`:102`), `baseTaskFrontmatter` (`:113`), `writeTask` (`:143`). |
| `test-app.ts` (145 lines) | `setupAppTest()` (`:36`) — route-level harness: temp data root, `resetEnvCacheForTests()` + `closeDb()` (`:50-52`), **installs the fake runtime** (`:62-63`), returns `cookieFor()` / `csrfFor()` / `request()` builders producing real signed-cookie + CSRF + trusted-Origin Requests. Exports `APP_TEST_PASSWORD` (`:34`). |
| `fake-runtime.ts` (185 lines) | The agent-runtime stub — see below. |
| `fake-github.ts` | Fake GitHub API/client. |
| `demo-seed.ts` (+ `demo-data.ts`, 41 KB) | The demo fixture — see §4. |
| `audit-log.ts`, `custom-board.ts` | Smaller fixtures. |

**Roles seeded by `setupTestStore`** (`test-store.ts:73-79`): `arda` = org admin
+ **project admin**, `murat` = **maintainer**, `selin` = **contributor**,
`elif` = **viewer**, `deniz` = registered **non-member** (guest).
⚠ The file's own header comment at `:27` still says "selin → reviewer" —
**stale; the code says `contributor`** (`:76`). Same defect as pass 20;
trust the code.

**`test-app.ts` gotchas worth knowing:**
- Import route modules **after** `setupAppTest()` (dynamic `import()` inside
  the test) so their module graph reads the overridden env (`:14-15`).
- `cookieFor()` resets the per-`email|ip` login rate-limit bucket before
  signing in (`:103-106`) — otherwise a file that signs the same user in more
  than ten times starts failing with "Too many sign-in attempts". Tests that
  *assert* throttling drive `loginWithCredentials` directly.
- Every POST needs a `_csrf` form field; `csrfFor(sessionId)` mints it.

**Fake runtime** (`test-support/fake-runtime.ts`) — so no real Claude/Codex is
ever spawned:

- `installFakeRuntime()` (`:51`) clears queued runs + started specs and calls
  `configureRunServiceForTests({ claude, codex })` with fake adapters.
- `queueFakeRun(run, backend)` (`:47`) enqueues scripted `LogLine[]` (plus
  optional `occurredAt[]`, `sessionId`, `keepRunning`, `outcome`).
- **`startedRunSpecs()` (`:38`) and `lastRunSpec()` (`:43`)** are *the seam*: a
  test asserts exactly what reached the runtime — `prompt`, `systemPrompt`,
  `model`, denylist, mounted skills, `mcpServers`. Assert here, not on
  internals.
- `createFakeAdapter().start()` (`:61-69`) pushes the spec, then `playFakeRun`
  (`:71-109`) replays queued/default lines via `queueMicrotask` and calls
  `onExit` deterministically; `interrupt()` exits with `"interrupted"`.
- `defaultLines()` (`:171`) emits a **short** deterministic reply that still
  carries the task key (`Looked at VIB-123 and reported back.`). It
  deliberately does *not* echo the prompt — that used to make every test's cost
  scale with prompt length and fanned out any `@handle` the prompt contained.

---

## 4. The demo-seed fixture — `test-support/demo-seed.ts` (Verified 2026-08-19)

TEST/DEV-only. The **product** seed (`app/server/seed/seed.server.ts`, driven
by `npm run seed`) is a clean sheet and ships none of this (owner ruling
2026-07-24).

- `runDemoSeed(options)` (`demo-seed.ts:140`); `DemoSeedOptions` (`:56`) takes
  `{ dataRoot, reset?, adminPassword? }`; re-exports `SEED_DEFAULT_PASSWORD`
  (`:54`, originally from `~/server/seed/seed.server`).
- Contents (`:40-52`): the mock users **arda / elif / murat / selin / deniz**,
  `viberr-core` + two stub projects, tasks **VIB-139..168** with full
  timelines, Arda's notification inbox, the VIB-142 scope violation, Arda's
  Home pins. Data lives in `demo-data.ts` (`SEED_PEOPLE` `:74`,
  `seedProjects` `:145`, `seedTasks` `:334`, `seedStubTasks` `:698`,
  `seedNotifications` `:804`).
- **Idempotent**: users upserted by email, files overwritten, rescan
  reconciles projections, notification rows use deterministic ids. `--reset`
  wipes via the product seed's `resetStore` first.
- CLI: `scripts/seed-demo.ts` — takes the data-root **writer lock** first
  (B-FD1, `runWithDataRootWriterLock`), and imports `test-support/demo-seed`
  **dynamically** (`:26-40`) because the production image deliberately does not
  ship `test-support/`; the catch prints the real error *and* the "dev-only"
  explanation.

---

## 5. Scale — counts at `ce2bc9e` (Verified 2026-08-19)

Measured with `npx vitest list` (collect only, no test bodies executed):

- **261 test files** = **216** `.test.ts` + **45** `.test.tsx`.
- **3,890 tests.** (Pass-20 doc measured 3,702 at `b97ad02`; the PR #169 merge
  brought 4 more files, the lint commit 1 more and +12 tests.)
- **46 files carry `// @vitest-environment jsdom`** — 44 of the 45 `.test.tsx`
  plus 2 `.test.ts` (`app/ui/roving-radio.test.ts`,
  `app/features/kb-browser/local-files.test.ts`). The one `.tsx` **without** the
  header is `app/features/retired-vocabulary.test.tsx` — it scans seeded assets
  and never renders.

### Tests and files per area

| Area | Tests | Files |
| --- | ---: | ---: |
| `app/server` | 2130 | 144 |
| `app/features` | 1362 | 78 |
| `app/shared` | 123 | 11 |
| `app/` top level (`app.css.test.ts`, `root.test.tsx`) | 84 | 2 |
| `app/routes` | 72 | 14 |
| `app/ui` | 71 | 9 |
| `app/schemas` | 42 | 2 |
| `app/lib` | 6 | 1 |
| **total** | **3890** | **261** |

### Largest files (test count)

`board/board-page.test.tsx` 110 · `tasks/specialist-run.server.test.ts` 97 ·
`task-detail/task-detail-components.test.tsx` 96 ·
`tasks/operator-actions.server.test.ts` 89 ·
`task-detail/task-disposition.test.tsx` 84 · `app/app.css.test.ts` 80 ·
`tasks/task-governance.server.test.ts` 65 ·
`runtimes/operator-run.server.test.ts` 62 · `agents/agents-page.test.tsx` 61 ·
`tasks/task-actions.server.test.ts` 59.

> Do **not** trust a static `grep -c 'it('` — it under-reads `it.each`
> expansions. `npx vitest list | wc -l` is the honest count and costs a few
> seconds.

### Reproduce these numbers

```sh
npx vitest list > /tmp/list.txt          # one line per test
wc -l < /tmp/list.txt                     # 3890
cut -d'>' -f1 /tmp/list.txt | sed 's/ *$//' | sort -u | wc -l   # 261
```

---

## 6. e2e model — production Docker image; dev server banned (Verified 2026-08-19)

- **Playwright config** (`playwright.config.ts`, 54 lines): `testDir: "e2e"`
  (`:28`), `workers: 1`, `fullyParallel: false` (shared seeded store).
  **No `webServer` block** — the base URL comes from `VIBERR_E2E_BASE_URL`, and
  the config **throws** if it is unset (`:17-25`), enforcing "no bare
  `npx playwright test`". Timeout 45 s, `expect` 10 s,
  `trace: "retain-on-failure"`, CI retries 1, `forbidOnly` on CI.
- **Production-image discipline** (owner policy 2026-08-02, stated at
  `playwright.config.ts:3-15` and `scripts/e2e.ts:1-13`): anything that serves
  the app for a test runs the **production** image, never a dev server.
- **Orchestration** — `npm run e2e` → `tsx scripts/e2e.ts` (116 lines) drives
  `docker compose -f compose.e2e.yml -p viberr-e2e` (`:18-19`):
  1. `down --volumes --remove-orphans` (`:69`) — clean slate even after a crash;
  2. `up --build --detach --wait --wait-timeout 300` (`:71`);
  3. derive the random host port via `compose port app 3000` (`:79-86`);
  4. poll `/resources/health` until `{ok:true}`, 60 s budget (`:47-63, :89`);
  5. `npx playwright test` with `VIBERR_E2E_BASE_URL` in env (`:92-94`);
  6. `finally` → `down --volumes --remove-orphans`, unless `VIBERR_E2E_KEEP=1`
     (`:100-107`).
  Extra args pass through: `npm run e2e -- e2e/01-home-board.spec.ts`.
  On failure it dumps the last 100 app log lines (`:96-98`).
- **Compose stack** (`compose.e2e.yml`, 69 lines):
  - a **`seed`** one-shot built at `target: build` (the demo fixture never
    ships in the final image) runs `npm run seed:demo && chown -R 1000:1000 /data`
    (`:27`) — as root in the build stage, then hands ownership to the final
    stage's UID-1000 `node` user;
  - the **`app`** service runs the final production image, `NODE_ENV: production`,
    synthetic secrets only (`x-e2e-env` anchor `:12-16`),
    `hostname: viberr-e2e` (`:43`) so an app-only restart reclaims its own
    writer lock, **`init: true` (`:44`, F20-2 — reap orphaned children)**,
    project-scoped named volume `e2e-data`, `127.0.0.1::3000` random host port,
    node-based healthcheck on `/resources/health` (`:55-66`);
  - restart tests must use `--no-deps` so the seed one-shot cannot re-run and
    reset the volume mid-check (`:40-42`).
- **Auth** — `e2e/auth.setup.ts` (27 lines): the `setup` project logs in once
  through the real `/login` UI as `arda@viberr.dev` with `SEED_DEFAULT_PASSWORD`
  (imported from `test-support/demo-seed`) and saves storage state to
  `e2e/.auth/arda.json`; the `chromium` project `dependencies: ["setup"]` and
  reuses it (`playwright.config.ts:42-52`).
  **The hydration gotcha is codified here** (`auth.setup.ts:11-21`): the inputs
  are React-controlled, so a `fill` that lands before hydration is wiped. It
  `waitForLoadState("networkidle")` and then wraps fill→fill→click→waitForURL
  in `expect(async () => …).toPass({ timeout: 30_000 })`.

### Specs — 7 files + `auth.setup.ts`, **33** `test()` cases

| Spec | cases |
| --- | ---: |
| `e2e/01-home-board.spec.ts` | 7 |
| `e2e/02-feeds-profile.spec.ts` | 5 |
| `e2e/03-org-settings-store.spec.ts` | 3 |
| `e2e/04-palette-mobile.spec.ts` | 6 |
| `e2e/05-task-comment-composer.spec.ts` | 7 |
| `e2e/06-activity-hydration.spec.ts` | 1 |
| `e2e/07-accessibility.spec.ts` | 4 (`@axe-core/playwright` 4.12) |

`02-feeds-profile` / `05-task-comment-composer` selectors were re-fixed in
`02cf37e` after the pass-20 dialog wording/consolidation changes — if a dialog's
copy changes, expect an e2e selector to follow.

### Image layers the e2e build pays for

- `Dockerfile:60-73` (R19-19): Debian `chromium` + `fonts-liberation` (~700 MB)
  in the final stage, and `ENV VIBERR_BROWSER_EXECUTABLE=/usr/bin/chromium`
  (`:73`); the builder also passes `--no-sandbox`.
- `Dockerfile:85`: `COPY --from=ghcr.io/astral-sh/uv:0.12.3 /uv /uvx /usr/local/bin/`
  so Python MCP servers register; `UV_CACHE_DIR` lives on `/data` (`:101`).
- `Dockerfile:29,40`: **`npm ci --foreground-scripts` on both install lines.**
  A from-scratch install fails with `ETXTBSY` without it — esbuild's postinstall
  spawns its just-written binary while overlayfs still counts a writer
  (`:22-28` documents this). **Do not remove the flag.**

---

## 7. Static gates that are not ordinary unit tests (Verified 2026-08-19)

These fail in milliseconds and are what an implementer trips over most often.
**One is new since pass 20** (toast honesty, D5).

| Gate | File (lines / tests) | What it enforces |
| --- | --- | --- |
| **Stylesheet integrity** | `app/app.css.test.ts` (2385 lines, 19 describes, **80 tests**) | See the describe map below. |
| **Copy ban** | `app/features/copy-ban.test.ts` (966 lines, 7 tests) | See below. |
| **Retired vocabulary** | `copy-ban.test.ts:940` + `app/features/retired-vocabulary.test.tsx:53` (5 tests) | "primary specialist" is gone from copy, seeded assets, the mounted developer skill, the Task-contract KB, the workflow template, and operator chips (F19-12). |
| **Failure-toast honesty (NEW, D5)** | `app/features/toast-honesty.test.ts` (219 lines) — `describe` **:190** | Scans every `push(...)` call under `app/features`, `app/routes`, `app/ui` and fails on any whose **string-literal** message is refusal-shaped while the call passes no explicit `"error"` kind. Both toast kinds paint `var(--fg)`; only the glyph differs, so a refusal pushed with the default `"success"` renders a green tick over a refusal. Precision rules are in the header (`:21-31`): literals only, "has an error kind" = a quoted `"error"` anywhere in the call, comments and identifiers stripped first. |
| **PRD sync** | `app/shared/docs/prd-sync.test.ts:28` (1 test) | `design/prd.md` is byte-identical to the canon PRD (ruling 27); reports diverging line numbers on failure. |
| **Hermeticity + import hygiene** | `app/server/runtimes/harness-hermeticity.server.test.ts:44,:110` | See §2. |
| **Route membership gates** | `app/features/policy/project-authority-routes.server.test.ts:267,:322` | R15-4 on the ACTION side of every project-scoped route; every project-scoped route carries a membership gate. |
| **Sealed-store coverage** | `app/server/secrets/key-rotation.server.test.ts:198` | `SEALED_STORES` covers every sealed store (so a new encrypted store cannot escape key rotation). |
| **Every comment writer notifies** | `app/server/tasks/mention-notify.server.test.ts:277` | NEW-4: every comment writer calls `notifyMentionedUsers`. |

### `app/app.css.test.ts` — describe map (re-anchored)

```
 :110  custom properties (P13-D-18) — every var(--x) resolves
 :155  utility classes (P13-D-19)
 :177  keyboard focus ring (P16-UI-01)
 :255  dead-and-drifted rules (P16-UI-04)
 :388  select treatment (P16-UI-05)
 :426  secondary text tokens meet WCAG AA (P13-D-12)
 :602  defines every class the markup uses (P16-UI-02)
 :708  hover-revealed board actions (P16-F7)
 :734  search field vs palette trigger (P16-F6)
 :802  breakpoints (P16-F8)
 :861  palette reachability on touch (P16-G3)
:1074  draws a task key the same way everywhere (P16-F3 follow-on)
:1104  .obs label column fits its longest label (F19-3 follow-on)
:1116  owns static styling, not the JSX (P16-F3)
:1161  lets a container-sized button wrap (F19-42)
:1192  owns the shared idioms — hoisting is not an escape hatch (F19-33)
:1775  every pair it paints clears WCAG AA, in both themes (R19-12)
:2211  hides no control at any width (R19-12)
:2345  app/ gates no rendering on the viewport (R19-12)
```

**The `RENDERED_INSIDE` trap** (`app/app.css.test.ts:1542`): the contrast matrix
computes each element's backdrop from the sheet itself. When an element's
painting ancestor is not in its own selector, it needs an entry in
`RENDERED_INSIDE` naming the container **and why** — e.g. `log-line`,
`log-chip`, `log-file`, `lcaret`, `log-more` all resolve to `.console`, which
paints a fixed near-black fill in both themes. **An entry that stops being
consulted also fails** (`:1845-1846` — "never consulted"), so the map cannot
rot. Add a painted class inside an unnamed container and this is the test that
catches you.

### `app/features/copy-ban.test.ts` — anchors

- `const BANNED = /\bgovern(ance|ed|or|ors|ing|s)?\b/i;` at **`:142`**;
  `const RETIRED_VOCAB = /primary specialists?\b/i;` at **`:935`**.
- `describe("F18-14 …")` **:637**:
  - `:638` — no rendered UI copy under `app/features`, `app/routes`, `app/ui`
    (`ROOTS`, `:98-100`) or `app.css` contains a banned word;
  - **`:678` — every top-level entry under `app/` is claimed by a scan.** A NEW
    top-level directory under `app/` fails here until someone classifies it;
  - `:714` / `:741` — the hand-rolled comment stripper and literal lexer have
    their own tests (they back the two scans above);
  - `:783` — no string literal under `app/server`, `app/schemas`, `app/shared`,
    `app/lib` (`:122-125`) contains a banned word;
  - `:871` — no seeded agent definition or skill doc
    (`app/server/seed/assets`, `:139`) carries a banned word outside its named
    prompt text.
- `describe("F19-12 …")` **:940** → `:941`.

---

## 8. The anti-slop oxlint plugin — NEW since pass 20 (Verified 2026-08-19)

Two commits, both on main:

- **`54ffab8`** installed it: the plugin is **vendored** at
  `tools/oxlint/anti-slop/` (upstream `dmmulroy/anti-slop`), `oxlint` +
  `@oxlint/plugins` **1.79.0** as devDependencies, `npm run lint` script.
- **`ce2bc9e`** fixed the codebase: **2,843 → 26 findings**, 387 files changed
  (+13,361 / −7,734), "zero suppressions, zero `any`, runtime behavior
  preserved", suite green at 3,890 tests (+12 new).

### Configuration — `.oxlintrc.json`

- `jsPlugins`: `[{ "name": "anti-slop", "specifier": "./tools/oxlint/anti-slop/index.ts" }]`.
- **All 15 rules at `"error"`.**
- `ignorePatterns`: every agent dotdir (`.agent`, `.agents`, `.claude`,
  `.codex`, `.continue`, `.cursor`, `.gemini`, `.opencode`, `.pi`, `.roo`,
  `.windsurf`), `design/**`, and `tools/oxlint/anti-slop/**` (the plugin does
  not lint itself).
- `tsconfig.json:13` **excludes** `tools/oxlint/anti-slop` from `tsc` — the
  vendored plugin uses `.ts` import specifiers for Node type-stripping, which
  the app's `tsc` config rejects.
- The plugin's `effect/` subdirectory (an opt-in Effect-library rule) is
  vendored but **not registered** — `effect` is not a dependency.

### What the 15 rules enforce

| Rule | Enforces |
| --- | --- |
| `no-chained-type-assertions` | no chained `as` / angle-bracket assertions, including parenthesized chains (kills `x as unknown as T`) |
| `no-conditional-empty-object-spread` | no `...(cond ? {a} : {})` to omit fields |
| `no-known-value-widening` | a syntactically-known value may not flow into an explicitly broad/anonymous target type |
| `no-module-mocking` | **no `vi.mock` / `jest.mock`** — replace dependencies through real interfaces |
| `no-object-parameters` | no anonymous-object function parameters; use an owner-provided named type, parsed at its boundary |
| `no-reflect-apply` / `no-reflect-get` | no `Reflect.apply` / `Reflect.get` |
| `no-runtime-typeof` | no runtime `typeof` checks — decode external values at the I/O boundary |
| `no-shape-in-symbol-names` | the case-insensitive substring `"shape"` may not appear in any symbol name |
| `no-unknown-parameters` | no explicitly-`unknown` parameters **except `cause`** |
| `no-unknown-returns` | no `unknown` / `Promise<unknown>` return contracts |
| `no-unknown-type-aliases` | no type alias resolving to `unknown` |
| `no-unsafe-dictionary-type` | no `Record<K, unknown \| any \| object \| {}>`-shaped dictionaries |
| `no-widen-then-assert` | no local `const` that widens a known value before asserting it back down |
| `require-safety-comment-for-type-assertion` | **every non-`const` `as` needs a `// SAFETY:` comment** stating the invariant TypeScript cannot express (`tools/oxlint/anti-slop/rules/require-safety-comment-for-type-assertion.ts:23-36`: the comment may sit before the assertion or before its containing statement / declaration / return / throw) |

Consequences visible in the tree today: **336 `SAFETY:` comments across 125
files**, and **exactly one surviving `vi.mock`** in the whole repo
(`app/features/project-settings/settings-page.test.tsx:38`).

### The 26 remaining findings (`npx oxlint`, exit 1)

25 anti-slop **errors** + 1 built-in **warning**. Each is a deliberate,
documented survivor — do not "fix" one without reading its site comment.

| Rule | n | Sites |
| --- | ---: | --- |
| `no-runtime-typeof` | 13 | `test-support/setup-dom.ts:7:5, 7:38, 9:7, 29:5, 29:38` · `app/features/kb-browser/local-files.ts:123:9` · `app/features/live-updates/use-live-updates.ts:82:9` · `app/features/runtime/use-run-log-stream.ts:177:32, 406:9` · `app/features/shell/command-palette.tsx:121:39` · `app/features/task-detail/timeline.tsx:73:9` · `app/ui/toast.tsx:163:23` · `app/ui/use-shortcut-hint.ts:25:9` — all SSR / feature-detection guards (`typeof window`, `typeof proto.showModal`) |
| `no-unknown-parameters` | 10 | `app/server/auth/form-action.server.ts:21:41` · `app/server/errors/app-error.server.ts:93:35` · `app/server/runtimes/claude-runtime.server.ts:461:37, 573:35` · `app/server/runtimes/codex-runtime.server.ts:373:32, 414:10` · `app/server/runtimes/wire-format.server.ts:221:8` (`projectEnvelope(backend, raw: unknown, …)` — tolerant envelope projection) · `app/server/secrets/git-output-redact.server.ts:137:8` (`redactProviderText(raw: unknown, …)`), `:173:37` · `app/server/tasks/git-clone-auth.server.ts:264:10` — catch-binding and wire-boundary decoders (`unknown` is what the language gives a thrown value) |
| `no-unsafe-dictionary-type` | 1 | `app/server/runtimes/adapter.server.ts:61:16` — `RunSpec.mcpServers?: Record<string, unknown>` stays loose **on purpose**: governed callers go through `StartRunInput`/`ResumeRunInput`, which enforce the `RunMcpServers` union, while the adapters' own tolerance tests hand this field deliberately malformed configs (`adapter.server.ts:55-61`) |
| `no-module-mocking` | 1 | `app/features/project-settings/settings-page.test.tsx:38` — an rbac module mock whose only alternative seam would be a UI prop |
| `eslint(no-control-regex)` (warning) | 1 | `app/server/secrets/git-output-redact.server.ts:54:22` — `ANSI_CSI_RE`, the escape-sequence stripper for git's colourised `error:`/`hint:` output. Note the `// eslint-disable-next-line no-control-regex` at `:58` covers the *next* regex (the C0 stripper at `:59`), not this one |

Reproduce: `npx oxlint` from the repo root (needs `node_modules` — see §0).

### Practical implications for an implementer

1. **`npm run lint` exits 1 today.** It is not a CI gate, so "lint is red" is
   the expected baseline. Judge your change by **whether it adds a NEW
   finding**, not by exit code: run `npx oxlint` before and after and diff the
   output.
2. **New tests cannot use `vi.mock`.** The established replacement idiom is an
   **injection seam**: an options bag whose properties default to the real
   imports (the pre-existing `fetchImpl` idiom). `ce2bc9e` replaced 31 of 33
   module mocks this way — see
   `app/server/files/atomic-file.server.test.ts`, `app/server/logging/logger.server.test.ts`,
   `app/server/boot.server.test.ts` and the task-actions delivery paths for
   worked examples.
3. **Any `as` you write needs a `// SAFETY:` comment.** `as const` is exempt.
4. The lint commit rewrote decoders into **tolerant zod boundary schemas**
   (per-field `.catch`, truthiness-guarded fields as `.min(1)`, strip
   semantics, explicit sub-object defaults). If you touch a decoder, match that
   shape; `scripts/e2e.ts:24` is a compact example
   (`z.object({ ok: z.boolean().catch(false) }).catch({ ok: false })`).
5. sqlite row interfaces became **type aliases** (implicit index signature) so
   the single `as` on a row decode is compiler-checked field by field. Keep new
   row shapes as `type`, not `interface`.

---

## 9. Canary methodology (Verified 2026-08-19)

**The rule**: after adding a fix + its test, **revert the fix**, confirm the new
test goes red, then **restore** the fix. A test that stays green with the fix
reverted proves nothing. Record the canary per finding in the pass's
`FINDINGS.md`.

This is not folklore — it is written into the tree. **144 canary notes across
test files** (`grep -rn "Canary" app --include='*.test.ts*'`), typically
naming the exact edit that reproduces the failure. Two representative examples:

- `app/features/toast-honesty.test.ts:32-33` — *"Canary: drop the `, "error"`
  from any fixed site (e.g. connections-panel's 'Set another connection as
  default first') and this test goes red."*
- `app/features/task-detail/task-detail-components.test.tsx:1032` — *"Canary:
  bring back the `.force-accept .hint` sentence and this reads its …"*

Files carrying canary notes include `app/app.css.test.ts`,
`app/features/toast-honesty.test.ts`, `app/features/board/board-page.test.tsx`,
`app/features/board/board-filters.test.ts`,
`app/features/org-settings/org-settings-page.test.tsx`,
`app/features/runtime/runs-panels.test.tsx`,
`app/features/runtime/runs-helpers.test.ts`,
`app/features/agents/agents-page.test.tsx`,
`app/features/agents/agents-query.server.test.ts`,
`app/features/task-detail/task-disposition.test.tsx`,
`app/features/task-detail/task-detail-components.test.tsx`,
`app/features/review/review-page.test.tsx`.

**Sharp edge (pass-17 fact):** `git checkout` wipes uncommitted work — commit
before you canary, or revert the fix by hand-editing and hand-restoring.

**Known trap (pass-19, still commented in the tree):** an implementer once
inverted `app/server/tasks/acceptance-graph.server.test.ts:160` (F18-7) while
"fixing" it. If a canary makes you want to change the *assertion*, stop.

---

## 10. Conventions and recipes for a context-free implementer

### `tsc` is a required gate — `npm run build` is NOT a typecheck

`npm run build` (`react-router build`) bundles; it does not typecheck.
Run **`npm run typecheck`** (`react-router typegen && tsc`). This has been
re-proven every pass since 12 — pass 19's `b0f3f99` existed only because a
helper rename landed without its two call sites. `tsconfig.json` runs
`strict`, `noUnusedLocals`, `noUnusedParameters`, `verbatimModuleSyntax`,
`erasableSyntaxOnly`.

**Run the full suite + typecheck, never just the touched files.** The suite is
cheap (pass-20 measured 31 s wall for 3,702 tests; 3,890 now).

### Running a single test file fast (measured 2026-08-19)

```sh
npx vitest run app/shared/docs/prd-sync.test.ts        # 82 ms  (1 test)
npx vitest run app/features/board/board-page.test.tsx  # 1.76 s (110 tests, jsdom)
npx vitest run app/app.css.test.ts -t "focus ring"     # 257 ms (7 run, 73 skipped)
```

- Positional args are **path substrings**, so
  `npx vitest run board-page` also works.
- `-t "<substring>"` filters by test/describe name and skips the rest — the
  fastest way to iterate on one case inside a 2,385-line gate file.
- `npx vitest list` collects without executing; `npx vitest list <file>` lists
  one file's cases.
- Watch mode (`npx vitest`) exists but the whole suite is ~30 s, so a full
  `npm test` before you commit is the norm.

### jsdom recipes

- A `.test.tsx` (or a `.test.ts` that touches the DOM) **needs
  `// @vitest-environment jsdom` as line 1** — the default environment is
  `node` and there is no jsdom project.
- `showModal` / `show` / `close` and `ResizeObserver` come from
  `test-support/setup-dom.ts`; they are shims, not real implementations —
  `showModal()` only sets the `open` attribute.
- Dialogs close on a plain JS `.click()` in jsdom (no native modal behavior).
- A synthetic `Escape` keydown is **not** a dialog cancel in jsdom.
- Use `@testing-library/react` `render` + `afterEach(cleanup)`; route-rendering
  component tests wrap in `createRoutesStub` from `react-router`
  (see `app/features/task-detail/mention-composer.test.tsx:4`).

### Lexical (comment composer) recipes

`app/features/task-detail/mention-composer.test.tsx:19-30` states the contract
the whole family follows:

- **Drive the REAL editor.** Do not mock Lexical.
- **jsdom cannot synthesize typing into a `contenteditable`** — set text
  through editor updates instead (`$setParagraphPlainText` from
  `./lexical-mention-plugin`, plus `$createParagraphNode` / `$getRoot` /
  `$isParagraphNode` from `lexical`).
- **Keys fire as DOM `keydown` events on the contenteditable**; Lexical's own
  listeners dispatch the commands (`UNDO_COMMAND` etc. are imported to assert
  history).
- Every assertion reads the editor state or the submitted form — never an
  internal.
- Wrap editor mutations in `act()`; `waitFor` for the autocomplete popup.
- The pure-render sibling, `app/ui/rich-text.test.tsx`, shows the other half of
  the idiom: a `visibleText()` helper that clones the container and strips
  `.mention-vh` visually-hidden labels before comparing text.

### Other standing conventions

- **Never add a network dependency to a test.** `GIT_ALLOW_PROTOCOL=file` is
  set suite-wide (`setup-env.ts:111`).
- **New forms need a `_csrf` field**; the app-test harness supplies
  `csrfFor()`.
- **New rendered copy** must clear `copy-ban.test.ts` (no `govern*`, no
  "primary specialist"). **A new top-level directory under `app/`** fails
  `copy-ban.test.ts:678` until it is classified.
- **New painted classes** must clear `app.css.test.ts` — including a
  `RENDERED_INSIDE` entry (`:1542`) if the backdrop is not in the selector.
- **A new failure toast** must pass `"error"` explicitly or
  `toast-honesty.test.ts:190` goes red.
- **Assert on the runtime seam**, not on internals: `lastRunSpec()` /
  `startedRunSpecs()` from `test-support/fake-runtime.ts`.
- **React state in a rendered pane is async** — `await waitFor`, don't read
  immediately (pass-19 trap).
- **Live-verify recipe**: stop the container, point a worktree `.env` at
  `docker-data`, run the dev server — but **NEVER** run a host dev server and
  the container against the same `docker-data` root at once (the F18-5
  dual-writer hazard; the guard fails closed, but do not rely on it).
- **Timeline events use `occurred_at`, not `created_at`** (pass-19 trap).

---

## 11. Corrections vs the pass-20 doc

Read against
`planning/discovery-2026-08-14-pass20/reference/TESTING-INFRA.md`
(verified at `b97ad02`). Everything below is a correction, not a restatement.

**Counts**

1. **256 test files → 261** (216 `.test.ts` + 45 `.test.tsx`, was 211 + 45).
   PR #169 (`6c94f2c`) added 4; `ce2bc9e` added 1.
2. **3,702 tests → 3,890** (measured with `npx vitest list` at `ce2bc9e`).
3. Per-area counts are **new** in this doc; pass 20 had none.
4. e2e case count is **unchanged at 33** across 7 spec files — pass 20 was
   correct.
5. `app/app.css.test.ts` grew 2381 → **2385 lines** (still 19 describes,
   80 tests). `copy-ban.test.ts` 969 → **966 lines**.
   `fake-runtime.ts` 177 → **185 lines**.
   `harness-hermeticity.server.test.ts` → **176 lines**.

**New material pass 20 could not have**

6. **§8 (anti-slop oxlint) is entirely new.** `npm run lint`, the vendored
   plugin at `tools/oxlint/anti-slop/`, the 15 rules, the `// SAFETY:`
   requirement, the `vi.mock` ban, and the exact 26 remaining findings.
7. **`npm run lint` is NOT in CI** (`.github/workflows/ci.yml` runs typecheck,
   test, build, e2e only) and currently **exits 1**. Judge a change by whether
   it adds a *new* finding.
8. **New static gate: `app/features/toast-honesty.test.ts:190`** (D5 —
   failure toasts must pass the `"error"` kind). Pass 20's §6 gate table
   predates it.
9. Four other repo-scanning gates pass 20's table omitted:
   `project-authority-routes.server.test.ts:267,:322` (route membership),
   `key-rotation.server.test.ts:198` (`SEALED_STORES` coverage),
   `mention-notify.server.test.ts:277` (NEW-4 notify coverage),
   `kb-injection.server.test.ts:223` (`STORE_TEXT_EXTENSIONS` is the ONLY
   store text-doc list).
10. Five new test files since `b97ad02`:
    `app/features/toast-honesty.test.ts` (219 L, from `bbb8b0b`),
    `app/server/runtimes/model-availability.server.test.ts` (103 L, `1483544`),
    `app/server/files/atomic-file.server.test.ts` (123 L) and
    `app/server/logging/logger.server.test.ts` (107 L) (both `fefedff`,
    injection seams replacing `vi.mock`),
    `app/server/prefs/user-prefs.server.test.ts` (80 L, `ce2bc9e`).
11. `compose.e2e.yml:44` now sets **`init: true`** (F20-2, reap orphaned
    children). Pass 20's compose description omits it.

**Anchors that moved (pass-20 line → current line)**

12. `app/app.css.test.ts`: contrast matrix **1773 → 1775**; "no control hidden
    at any width" **2207 → 2211**; `RENDERED_INSIDE` **1540 → 1542**.
    (`:110`, `:155`, `:177`, `:255`, `:426`, `:602`, `:802`, `:861` unchanged.)
13. `app/features/copy-ban.test.ts`: new-top-level-directory guard
    **681 → 678**; comment stripper **717 → 714**; literal lexer **744 → 741**;
    server/schemas/shared/lib literal scan **786 → 783**; seeded-assets scan
    **874 → 871**; F19-12 describe **943 → 940**. (`BANNED` regex still `:142`.)
14. `harness-hermeticity.server.test.ts`: describes **43 → 44** and
    **109 → 110**; import-hygiene test **150 → 158**.
15. `test-support/fake-runtime.ts`: `startedRunSpecs` **32 → 38**;
    `lastRunSpec` **37 → 43**; `queueFakeRun` **41 → 47**;
    `installFakeRuntime` **45-53 → 51-59**; `createFakeAdapter` **55-62 → 61-69**;
    `playFakeRun` **64-102 → 71-109**.
16. `data-root-lock.server.test.ts` (F18-5): `verifyLockOwnership`
    **208 → 272**; `startDataRootLockGuard` **294 → 358**.
17. `skill-mount.server.test.ts`: `stripUngovernedRepoCatalog` **:57**
    (unchanged); reviewer-inheritance **:215** (unchanged); `isSdkSkillName`
    **:243**; `mountGrantedSkills` **:272**.
18. `specialist-run.server.test.ts` R18-1 describe **1881 → 1939**.
19. `delivery-requeue.server.test.ts` R18-2 describe **171 → 165**.
20. `ghost-members.server.test.ts` F18-6 **170 → 170** (`it` at `:170`,
    unchanged).
21. `resources.server.test.ts` F18-4 `folderExists:false` **251 → 322**.
22. `acceptance-graph.server.test.ts` F18-7 `it` **:160** and the
    "a pass-19 implementer inverted this test" note **:321** — both unchanged.
23. `task-detail-components.test.tsx`: force-accept describe **1151 → 1027**;
    UXO-1 archived pills **1995 → 2242**.
24. `board-page.test.tsx` "B1: accepting from the board asks first"
    **382 → 474**.
25. `users-panel.test.tsx` LV-F1 describe **132 → 132** (unchanged).
26. `roving-radio.test.ts` `rovingRadioKeyDown` describe now at **:49**.
27. `prd-sync.test.ts` **:28** unchanged.
28. `retired-vocabulary.test.tsx` describe **53** unchanged (5 tests).
29. `Dockerfile`: `uv` COPY still `:85`; `UV_CACHE_DIR` **101-102 → :101**.

**Corrections of fact**

30. The jsdom-header count is **still 46** despite +5 test files — the
    composition is unchanged: **44 of 45 `.tsx` + 2 `.ts`**
    (`app/ui/roving-radio.test.ts`, `app/features/kb-browser/local-files.test.ts`),
    and the only header-less `.tsx` remains
    `app/features/retired-vocabulary.test.tsx`. All five new files are `node`.
31. Pass 20's `test-store.ts` warning still stands and is still **not fixed**:
    the header comment (now `:27`, was `:26`) says "selin → reviewer" while the
    code says `contributor` (`:76`).
32. Pass 20 said `git-output-redact` was not discussed; this doc adds that its
    `no-control-regex` warning at `:54` is the **ANSI CSI** regex — the
    `eslint-disable-next-line` at `:58` covers a *different* regex on `:59`.
33. Pass 20's §8 ("Test additions since the pass-19 merge") is superseded by
    item 10 above plus §8; its R19-19 / R19-16 / P19-RC1 / R19-18 / R19-17 rows
    remain broadly accurate as descriptions but **their line numbers have
    drifted** — re-grep by describe name before citing any of them.
