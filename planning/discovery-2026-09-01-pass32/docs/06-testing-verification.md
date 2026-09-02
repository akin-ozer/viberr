# 06 — Testing & verification

Discovery pass 32, 2026-09-01. Every claim and every `path:line` below was
re-resolved against the working tree at `68b5480e` (main). Measurements marked
"measured this session" were taken here, once, in this order: full vitest run →
`npm run lint` → `npm run typecheck`.

**Headline changes since pass 31 (2026-08-31):**

| | pass 31 | now |
| --- | --- | --- |
| vitest | 292 files / 4,666 tests | **295 files / 4,818 tests**, 47.3 s, exit 0 |
| `npm run lint` | 25 errors, 3 warnings, **exit 1** | **0 errors, 2 warnings, exit 0** |
| GitHub Actions | billing-broken, jobs never start | **live and green again** — last 4 runs `verify` + `e2e` both success |
| Radius / spacing scale locks | missing (pass-31 finding) | **landed** (`app/app.css.test.ts:2588`, `:2651`) |
| Browser matrix | Safari + Firefox declared, never run | **Chromium-only** (ruling 103) — declaration now matches coverage |

---

## 1. The five gates

`package.json` is the only script surface. `engines.node >= 26`
(`package.json:6-8`); the host runs Node v26.5.0, the image `node:26-slim`
(`Dockerfile:17`, `:34`, `:48`).

| Command | package.json | What it is | Config |
| --- | --- | --- | --- |
| `npm test` | `:15` | `vitest run` — unit + integration | `vitest.config.ts` |
| `npm run typecheck` | `:13` | `react-router typegen && tsc` | `tsconfig.json` |
| `npm run lint` | `:14` | `oxlint` + the vendored `anti-slop` plugin | `.oxlintrc.json`, `tools/oxlint/anti-slop/` |
| `npm run e2e` | `:16` | `tsx scripts/e2e.ts` — Playwright vs the production Docker image | `playwright.config.ts`, `compose.e2e.yml` |
| `npm run build` | `:11` | `react-router build` | `vite.config.ts` |

The other eight scripts (`package.json:9-24`: `dev`, `start`, `seed`,
`seed:demo`, `rescan`, `store:check`, `backup`, `restore`, `keys`) are
operational, not gates — §3.6.

### 1.1 Unit suite

- `vitest.config.ts:21` includes **only** `app/**/*.test.{ts,tsx}` — **295
  files** today. **Measured this session: 295 files / 4,818 tests, all passed,
  47.32 s wall, exit 0.**
- Default environment is **node** (`vitest.config.ts:11`). jsdom is opt-in **per
  file** via a `// @vitest-environment jsdom` comment on line 1 — **52 files**
  do this. Without it a component test dies on `document is not defined`.
- Setup files, run before any app module loads (`vitest.config.ts:15`):
  `test-support/setup-env.ts`, `test-support/setup-dom.ts`.
- `db/**/*.test.ts` was dropped in pass 12 and the reason is preserved in the
  config itself (`vitest.config.ts:16-20`): the glob matched zero files once the
  migrations were squashed into `db/0001_baseline.sql`, and "a glob matching
  nothing still advertises a convention." The runner's own test lives at
  `app/server/db/migration-runner.server.test.ts`.
- **`scripts/` is deliberately not collected** (`docs/testing.md:14-19`) and the
  doc names the cost: the pass-13 `npm run seed` regression shipped through the
  hole. Cover script behaviour by moving it into `app/`, or via e2e, which runs
  real CLI entrypoints.
- **No `testTimeout` is configured**, so vitest's 5 s default applies. That is
  not academic — see §6 and the findings.

Subset: `npx vitest run app/features/copy-ban.test.ts`.

### 1.2 Hermetic env (`test-support/setup-env.ts`)

This is why `npm test` needs no `.env`. Four jobs, each with an incident behind
it:

1. `test-support/setup-env.ts:19-23` — seeds `VIBERR_SESSION_SECRET` and
   `VIBERR_SECRET_ENCRYPTION_KEY` with `??=`.
2. `:44-58` — **blanks every real-backend credential** (`ANTHROPIC_API_KEY`,
   `CLAUDE_CODE_OAUTH_TOKEN`, `VIBERR_CLAUDE_USE_CLI_AUTH`, `CODEX_ACCESS_TOKEN`,
   `CODEX_API_KEY`, `OPENAI_API_KEY`, `VIBERR_CODEX_USE_CLI_AUTH`,
   `VIBERR_BROWSER_EXECUTABLE`). Assigned `""`, **never `delete`d** — the
   rationale is at `:37-42`: `env.server.ts` calls `loadEnvFile()` at module
   scope, i.e. *after* setup, and fills any key not already present, so `delete`
   hands the developer's `.env` value back. Risk closed: **a paid provider call
   from `npm test`**.
3. `:85-89` — pins `CLAUDE_CONFIG_DIR` / `CODEX_HOME` to a fresh `mkdtemp` with
   `projects/` and `sessions/` pre-created. An *empty existing* dir is
   deterministic (`missing`); a missing one reports `unknown` (`:60-84`). Before
   this, the same test passed on CI and failed on a laptop.
4. `:111` — `GIT_ALLOW_PROTOCOL=file`, so https/ssh `git clone` fails instantly
   and offline. Two tests reach `cloneRepo` with a publicly-resolvable repo name
   (`:95-97`).

`test-support/setup-dom.ts:13-28` polyfills
`HTMLDialogElement.showModal/show/close` (the app uses native `<dialog>`) and
`:35-42` stubs `ResizeObserver` for dnd-kit. Both probe with `Object.hasOwn`,
not `in` — lib.dom *declares* both, so `!(x in y)` narrows the polyfill branch
to `never` (`:6-11`).

### 1.3 `VIBERR_DATA_ROOT`

Controls where canonical markdown + SQLite projections live; defaults to
`./data` (`app/server/files/file-store-root.server.ts:43-45`; layout documented
at `:8-23`). For any manual run that touches the store:
`VIBERR_DATA_ROOT=$(mktemp -d) npm test` (`docs/testing.md:102-116`). Most tests
already `mkdtemp` their own roots via `test-support/test-db.ts:24` /
`test-support/test-app.ts:37`.

### 1.4 Typecheck — `tsc` is the gate, `npm run build` is NOT

`npm run typecheck` = `react-router typegen && tsc` (`package.json:30`). Typegen
is not optional: route module types live in `.react-router/types/**`, which
`tsconfig.json` lists in `include` and `rootDirs`.

**`npm run build` is not a typecheck** — Vite/esbuild transpiles without
checking. Pass 12 recorded two self-inflicted bugs a green build waved through
and `tsc` caught. `tsconfig.json` is `strict` + `noUnusedLocals` +
`noUnusedParameters` + `verbatimModuleSyntax` + `erasableSyntaxOnly`. Excluded:
`data`, `docker-data`, `build`, `node_modules`, `tools/oxlint/anti-slop`.

**Measured this session: `npm run typecheck` clean, exit 0** (TypeScript 7.0.2).

### 1.5 Lint — the gate is real again

`.oxlintrc.json:18-19` loads the repo's **own** plugin
(`jsPlugins: [{ name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" }]`)
and `:21-37` enables all 15 generic rules at `"error"`:
`no-chained-type-assertions`, `no-conditional-empty-object-spread`,
`no-known-value-widening`, `no-module-mocking`, `no-object-parameters`,
`no-reflect-apply`, `no-reflect-get`, `no-runtime-typeof`,
`no-shape-in-symbol-names`, `no-unknown-parameters`, `no-unknown-returns`,
`no-unknown-type-aliases`, `no-unsafe-dictionary-type`, `no-widen-then-assert`,
`require-safety-comment-for-type-assertion`. Source:
`tools/oxlint/anti-slop/rules/` (15 files), registered in
`tools/oxlint/anti-slop/index.ts:20-38`. The `effect/` sub-plugin exists but is
**not** registered. `.oxlintrc.json:3-17` ignores every agent-config dir plus
`design/**` and the plugin's own source.

The vendored tree is a byte-identical copy of
`.claude/skills/install-anti-slop/assets/anti-slop/` (verified with `diff -rq`
this session; the skill dir is untracked, so nothing gates the copy).

> **THE LINT GATE IS RESTORED.** Pass 31's A1 fixed all 26 findings properly —
> **fixed, not allowlisted**, which `docs/testing.md:41-45` records with the
> instruction *"If you find it false in future, that is the bug; amending this
> sentence is not the fix."*
>
> **Measured this session on `main`:**
>
> ```
> npm run lint → 0 errors, 2 warnings, exit code 0
> ```
>
> Both warnings are `eslint(require-yield)` on
> `app/server/runtimes/claude-runtime.server.test.ts:666` and `:707`. Warnings
> do not fail the gate (`docs/testing.md:29-30`).
>
> **Acceptance is back to absolute zero errors**, not the pass-30/31 "delta vs
> main" rule. If a branch reports an `anti-slop` error, it is that branch's.

**Version pin trick.** A worktree has no `node_modules`, so `npm run lint`
prints nothing and "passes" — the baseline is a lie. Restore without touching
the lockfile (`docs/testing.md:33-39`, `docs/testing-quickstart.md:26-34`):

```sh
npm i --no-save oxlint@1.79 @oxlint/plugins@1.79
```

Both must match. Installed today: **oxlint 1.79.0 / @oxlint/plugins 1.79.0**.

> **Never run that while a background `vitest run` is in flight.** Mutating
> `node_modules` mid-run produced **688 phantom test failures** (2026-08-26);
> the warning is now in the docs too (`docs/testing.md:38-39`).

**Prove the plugin bites before trusting a green.** oxlint 1.79 prints no
summary line, so "no output" and "plugin never loaded" look identical. Probe it
(§7.3) — this session's probe fired `no-unknown-parameters`,
`no-unknown-returns` and `no-unsafe-dictionary-type` on a synthetic file, so the
measured zero is a real zero.

Related: `doctor.config.ts` (react-doctor, run via `npx`, not a dependency)
ignores `design/`, `.claude/`, `data/`, `*.server.test.ts`, `tools/oxlint/`,
`test-support/`, `planning/` (`doctor.config.ts:21-29`, with the reasoning at
`:1-20`). react-doctor's **bundled** `anti-slop` plugin duplicates this repo's
own rules, so any `anti-slop(*)` hit it reports on `app/` should be triaged
against `npm run lint`, not twice.

### 1.6 E2E — production image only

Owner policy 2026-08-02: **anything that serves the app for a test runs the
production image, never a dev server.** `playwright.config.ts:17-25` enforces it
by throwing at config load when `VIBERR_E2E_BASE_URL` is unset.

`scripts/e2e.ts` flow: `down --volumes --remove-orphans` (`:69`, clean slate
after a crash) → `up --build --detach --wait --wait-timeout 300` (`:71` — the
`seed` one-shot writes the demo fixture onto a fresh named volume `e2e-data`,
then the final-stage image boots) → `docker compose port app 3000` derives a
random loopback port (`:79-86`) → poll `/resources/health` up to 60 s (`:89`; a
Zod `.catch()` at `:24` means an error body, a proxy's HTML, or a half-started
reply all read as "not up yet") → `npx playwright test` with
`VIBERR_E2E_BASE_URL` (`:92-94`) → `down --volumes` in a `finally` (`:100-107`).

```sh
npm run e2e                                  # full suite
npm run e2e -- e2e/01-home-board.spec.ts     # args pass through (scripts/e2e.ts:66)
VIBERR_E2E_KEEP=1 npm run e2e                # keep the stack up to debug (:101)
```

`compose.e2e.yml` never touches `compose.yml`'s project, `.env`,
`./docker-data`, or any host credential — synthetic secrets only (`:12-16`:
fixed session secret, base64-of-32-zero-bytes key, shared so the app can read
what the seed wrote). The `seed` service builds `target: build` (`:19-31`),
because `test-support/` deliberately never ships in the final image; it seeds as
root then `chown -R 1000:1000 /data`. `hostname: viberr-e2e` (`:43`) so an
app-only restart reclaims its own writer lock — restart tests must pass
`--no-deps` so the seed cannot re-run (`:39-42`). `init: true` (`:44-45`) reaps
chromium/crashpad zombies. Host port is `127.0.0.1::3000` (`:52`), i.e. random.

**One browser**: `chromium` / `devices["Desktop Chrome"]`
(`playwright.config.ts:45-52`), plus a `setup` project (`:44`) that is a login
fixture, not a browser. `fullyParallel: false`, `workers: 1` (shared seeded
store), `timeout: 45s`, `expect.timeout: 10s`, `trace: retain-on-failure`
(`:29-40`).

**The matrix is now Chromium-only** (ruling 103, `docs/architecture/decisions.md:1464-1468`;
`planning/planning-artifacts/prd.md:160`). Safari and Firefox were struck rather
than left implied, so `docs/testing.md:75-77` is right to say this suite covers
the whole declared matrix. Pass 31's finding #5 is closed by decision, not by
new coverage.

### 1.7 :5173 (docker) vs :5174 (hermetic) — the single-writer rule

`.claude/launch.json` has two configs, and the difference is data safety:

- **`viberr-dev` → :5173** (`.claude/launch.json:5-13`),
  `VIBERR_DATA_ROOT=/Users/akinozer/projects/viberr/docker-data`. Its command
  **refuses to start** when `viberr-app-1` is running: *"SQLite WAL over a bind
  mount tolerates ONE writer per data root (host+container dual writers have
  eaten PATs and run logs before)."*
- **`viberr-dev-hermetic` → :5174** (`:14-23`), `VIBERR_DATA_ROOT=$PWD/data`.
  Every recent pass live-validated here.

**One app process per data root, ever.** A host dev server and a compose
container sharing `docker-data` over VirtioFS clobbered the WAL and lost users,
encrypted PATs, notifications and run logs — while `PRAGMA integrity_check`
passed before *and* after, because it does not detect lost transactions
(`docs/operations/deployment.md:265-270`).

Enforced in code (`app/server/db/cli-lock.server.ts:109`): `bootServer()` has
held the data-root lock since F18-5, and every **writing** CLI goes through
`runWithDataRootWriterLock` and fails **closed** naming the holder. The current
callers are `scripts/seed.ts:31`, `scripts/seed-demo.ts:46`,
`scripts/rescan.ts:24`, `scripts/restore.ts:56` (whole-root restore only) and
`scripts/secret-keys.ts:55` (`reseal` only). Read-only CLIs (`backup`,
`store:check`, `keys -- status`) deliberately do not take it and open the
projection read-only.

`compose.yml:10` pins `hostname: viberr` (B-FD1) so a recreated container
reclaims its own leftover lock; `:17` sets `init: true` (F20-2, reaping
chromium/crashpad zombies); `:20-23` forces `NODE_ENV=production` /
`VIBERR_DATA_ROOT=/data` over `.env`. New since pass 31: `:43-55` surfaces the
four ruling-108 controller unlock vars, each defaulting to `"disabled"` (locked).

---

## 2. The meta-gates

Six files assert properties of the *source*, not of runtime behaviour.
**Measured this session: 6 files, 117 tests, 595 ms, exit 0.**

### 2.1 `app/app.css.test.ts` (2,702 lines)

`app/app.css` is the app's only stylesheet. Nothing checks CSS the way `tsc`
checks TypeScript — an undefined token or class is silently dropped, so the page
still renders, just wrong. 24 `describe` blocks. What it locks:

- **Tokens** (`:110`): every `var(--x)` resolves to a declared token, reported
  **by name, not count** (P13-D-18: 11 undefined tokens, 7 without fallback,
  killed a whole panel's border and background).
- **Classes** (`:163`, `:642`): every `className` literal anywhere in `app/` has
  a rule behind it — it **scans the tree, not a hand list** (P13-D-19 shipped a
  four-name hand list; the next nine orphans survived three passes).
- **Contrast** (`:437`, `:1858`), computed from the sheet's own hex literals:
  `--faint` / `--placeholder` ≥ 4.5:1 on `--surface` in both themes and over the
  4 % `--fg` tint and `--blue-soft` fill; the `--muted > --faint > --placeholder`
  subordination; the primary CTA and its hover; `--border-control` at 3:1. Plus
  a **whole-sheet sweep** (R19-12, `:1858`) resolving every pair the sheet paints
  in both themes at 4.5:1 text / 3:1 large text and meaningful glyphs.
- **Responsive honesty**: no interactive element is removed under a width query
  (`:2294`; a component boundary is treated as opaque, and "renders no control"
  claims are re-proved against each component's own file); `app/` gates no
  *rendering* on the viewport (`:2428`, `matchMedia` for user preferences only);
  breakpoints come from one named map, each declared once and each actually used
  (`:843`).
- **Type scale** (`:2541`): 13 steps — `.62 .68 .74 .8 .86 .92 .98 1.05 1.18 1.3
  1.5 1.7 1.9` rem (`:2545-2548`). Every `font-size` must be one (or `0` /
  `inherit`). Only weights the loaded fonts ship (`400 500 600 700 800 inherit`);
  `font-weight: 800` is legal only where the display face (Manrope) resolves or
  an `h1`–`h4` is selected (`:2568-2581`) — 800 on a body/mono rule silently
  clamps.
- **Radius scale** (`:2588`, NEW in pass 31): six tokens, values pinned exactly —
  `--radius-small 6px`, `--radius-button 8px`, `--radius-box 12px`,
  `--radius-chip 999px`, `--radius-card 16px`, `--radius-panel 22px`
  (`:2593-2600`). Three locks: exactly those six declared, once each (`:2612`);
  every `border-radius` **corner value** is a token, a sanctioned micro radius
  (`2px`/`3px`/`4px`, `:2606`) or a non-step (`50%`/`0`/`inherit`, `:2610`)
  — checked per corner because shorthands round individual corners (`:2623`);
  and no corner is a **bare copy of a token's own value** (`:2637`) — the literal
  that survives a token change. **No allowlist.**
- **Spacing scale** (`:2651`, NEW in pass 31): nine steps (`0 .125 .25 .375 .5
  .75 1 1.5 2` rem, `:2662-2665`). Deliberately *not* a per-usage lock — the
  comment at `:2652-2661` explains that 81 of 944 spacing declarations are
  legitimate one-site decisions (negative optical nudges, sub-step chip padding,
  fixed panel measures), and snapping them "would be 81 layout changes wearing a
  lint fix's clothes." Instead the **shape** is locked: any value reaching
  ≥ `DE_FACTO_STEP_AT` = 10 spacing sites (`:2668`) is a de-facto step, and that
  set must be exactly the nine (`:2685`); and every declared step must still
  reach 10 sites (`:2692`), so a step nothing uses fails too.
- **Other**: one `:focus-visible` ring wrapped in `:where()` (`:185`); one select
  base rule (`:396`); static styling lives in the sheet, not JSX `style={{…}}`
  (`:1206`, census capped at **24** at `:1243`); no style object may restate a
  utility class's declarations (`:1291`); field chrome covers every text-like
  input type (`:2481`).

**"No allowlist" is structural, not claimed.** Every exemption bucket is empty or
rot-checked: `CLASSLESS_BY_DESIGN = {}` (`:640`, capped ≤ 3 at `:705`),
`UNFIXED_BELOW_AA = {}` (`:1715-1716`, **emptied by pass 30** — the fixes are
itemized in its docblock at `:1704-1714`), `BELOW_AA_BY_DESIGN` = 2 entries
(`:1694-1697`) each citing a WCAG clause (`.pj-star.on` under 1.4.11;
`.log-more:disabled` under 1.4.3's inactive-component exemption). Baselines are
asserted as an **exact set** (`:1902-1908`), so *fixing* a pair fails until its
line is deleted — a `toBeLessThanOrEqual` ceiling was rejected explicitly at
`:1903-1905`: "that is how a baseline becomes a suppression file." Stale entries
fail their own rot guard (`:1910-1930`), and every exemption's `why` must be
**> 60 characters** (`:1932-1944`) — a label is not a reason.

**Gates to update when touching these areas**: the breakpoint map (`:843`), the
inline-style cap 24 (`:1243`), the `.fine` font-size pin, the select border pin
(`--border-control`, `:396`), "no style object restates a utility" (`:1291`),
and now the radius (`:2588`) and spacing (`:2651`) blocks — a spacing snap that
pushes a tenth site onto an off-scale value fails `:2676` by design.

### 2.2 `app/features/copy-ban.test.ts` (1,031 lines)

**(a) The `govern*` ban (F18-14).** `/\bgovern(ance|ed|or|ors|ing|s)?\b/i`
(`:142`). Source: `design/CONVERSATION-SUMMARY.md:22` — use *Maintainer*,
*Permissions*, *managed*. The ban is about copy a **human reads**, not agent
system prompts. Three scans, split by **syntax** not importance (`.tsx` cannot be
lexed as TypeScript — `</div>` reads as an unterminated regex):

| Scan | Roots | Method |
| --- | --- | --- |
| Render (`:637`) | `app/features`, `app/routes`, `app/ui` (`:97`) + `root.tsx`, `entry.client.tsx`, `entry.server.tsx`, **`app.css`** (`:109`) | line-wise |
| Literal | `app/server`, `app/schemas`, `app/shared`, `app/lib` (`:121`) + `app/routes.ts` (`:128`) | hand-written lexer (`:240-465`), **every string literal** |
| Assets | `app/server/seed/assets/**` (`:139`) | line-wise, `ALLOWED_ASSET_LINES` by name (`:540`) |

`app.css` is in scope because a stylesheet renders copy through `content:`.

This gate's design is the repo's best lesson in gates that hold:

- **Coverage is an assertion** (`:694-711`). Every entry `readdirSync(app/)`
  returns must be claimed by a scan or named in `IGNORED_ENTRIES` (`:137`,
  **`{}` today**). A verifier planted the word in a new top-level directory *and*
  a new top-level `.tsx` and the suite stayed green — the same hole had already
  produced this finding twice (`app/schemas`, then `app/ui`).
- **An exemption covers the marker, not the line.** `redact()` (`:177`) cuts
  allowed markers out (longest first) and scans what remains. A line-granular
  allowlist let a verifier append
  `const hole = "Off the governed path — ask a Maintainer.";` to a line already
  containing `isGoverned` (docblock `:169-176`).
- **Allowlists are rot-checked.** Five of nine render entries suppressed nothing
  — `\b` already fails against `GOVERNED_` / `isGoverned` (`:154-161`). Four
  survive (`:162-167`): `const governed =`, `governed.{direct,recommend,forbidden}`.
- **The comment stripper is one alternation, one left-to-right pass**, with its
  own test. Two sequential passes blind the gate in *both* directions
  (block-first: a `//` comment mentioning `app/server/**` blanks every line to
  the next `*/`; line-first: `/* note // see above */` leaves an unterminated
  `/*`). Both found by canarying.
- **Non-vacuity is asserted.** `MUST_SEE_COPY` (`:611-614`) requires the literal
  scan to actually reach `schemas/task-file.schema.ts` and
  `server/tasks/task-actions.server.ts`, matched on `SENTENCE` shape (`:617`),
  not on wording — proving reach without pinning copy.
- **No rendered-copy exception** (`:149-152`) — the login tagline had "governed"
  removed at design time and is not allowlisted.

**(b) Em/en dash ban (P21, owner 2026-08-20).** `/[–—]/` (`:931`), tested at
`:940`.
- Scope is the **render roots + seed assets only**. `app/server/**` prompt
  machinery is deliberately ungated — model-addressed prose where a dash harms
  nobody, and gating it would need a hundred-entry allowlist that rots.
- **Legal:** the middle dot `·`, the minus sign `−` (U+2212), arrows `→`.
  **Comments keep their dashes.**
- `DASH_ALLOW = []` on purpose (`:938`), with the instruction *"Do NOT grow it to
  keep a red build green — reword the sentence instead."*
- Rationale: dashes are the most reliable tell of machine-written prose, and this
  app's copy was written entirely by models.

**(c) Retired `primary specialist` vocabulary (F19-12).** `/primary specialists?\b/i`
(`:1000`) over `app/features`, `app/routes`, `app/server`, `app/shared` — wider
than the dash ban because these strings are built **server-side** and rendered
verbatim. One allowed marker (`:1003`): the capability **id**
`assign-primary-specialist`, stored in every `project.md` and never rendered.

### 2.3 `app/features/retired-vocabulary.test.tsx` (357 lines)

Sibling to (c), deliberately separate because **the two bans have opposite
exemption rules**: `govern*` is *exempt* in prompt text; "primary specialist" is
at its **worst** there — the developer skill doc is mounted natively into every
developer run, so it *teaches* the retired model to the agent, which speaks it
back into the timeline.

Every case asserts the **shipped artifact**: the seeded `.md` assets on disk with
a non-vacuity check (`:62`); the skill as materialized by
`seedDefaultAgentAssets` into a temp data root (`:82`); the seeded Task-contract
KB doc (`:97`); `GOVERNED_TEMPLATE`'s `ready → impl` rationale, rendered on
Policy *and* persisted into every new `project.md` (`:112`); and
`renderToString` HTML for `OperatorRecommendations` (`:132`), `LiveRoster`
(`:196`), `AgentStats` (`:208`), `CapabilityMatrixModal` (`:271`),
`ProfileDetail` (`:323`). Each also **pins the surrounding copy**, so "deleted"
and "fixed" are not the same green.

### 2.4 `app/features/toast-honesty.test.ts` (219 lines)

Rule (`docs/architecture/decisions.md` §UI porting rules, `:103`): *a failure
toast must not render the success tick — pass the toast kind explicitly.* The
rule was written down and ~10 sites violated it (`:15-16`).

A **character scanner** (not a regex) strips comments while preserving strings
(`:56-59`); `extractArgs` walks balanced parens; `stringLiterals` pulls each
literal. Flagged when a literal matches `REFUSAL` (`:160`) and no quoted
`"error"` (`:164`) appears anywhere in the call. `STANDALONE_PUSH` (`:166`)
excludes member calls. Precision by design (`:21-31`): only **string-literal**
messages (`push(d.toast)` routes through `useActionToast`/`useOrgAction`, which
already pass `"error"`); the ternary form
`push(cond ? … : …, cond ? "success" : "error")` passes. **The gate self-tests**
— `"catches a planted violation (the gate actually bites)"` (`:201`) runs
synthetic sources through the matcher. Its docblock (`:32-33`) ships a canary
instruction: drop the `, "error"` from connections-panel's *"Set another
connection as default first"* and it goes red.

Roots: `app/features`, `app/routes`, `app/ui` (`:37-41`).

### 2.5 `app/shared/docs/prd-sync.test.ts` (54 lines)

Ruling 27 / R15-8: `design/prd.md` is a **byte-identical mirror** of
`planning/planning-artifacts/prd.md` (`:25-26`, asserted at `:29`). The rule
failed twice by memory alone (`:11-17`), so the mirror is now a mechanical
follow-up: edit the canon copy, copy it over. On divergence the test names the
diverging **lines** (`:38-52`), because the failure mode was that nobody could
see which requirement had gone stale.

### 2.6 `app/shared/docs/file-formats-sync.test.ts` (135 lines)

N19-3: `docs/architecture/file-formats.md`'s `## Packet` section enumerates
exactly `PACKET_OPTION_KINDS` from `app/schemas/task-file.schema.ts:129`, **in
the schema's order** (`:84-93`). The count is **11** today —
`accept_completion`, `request_edit`, `block_on_policy`, `hold_runtime_debug`,
`redirect`, `retry_other_backend`, `edit_goal`, `archive_task`,
`discard_branch`, `resolve_remote_collision` (added by pass 31's F31-6),
`custom`.

The second test (`:95-133`) is the subtle one: it scans every place the section
commits to a **number** — `"The N kinds:"`, `"N is the count"`, `"corrected to
N"` — in digits or spelled words (`:32-39`), and holds each to
`PACKET_OPTION_KINDS.length`. Quoted spans are stripped first (`:100`) because
the doc's own correction note *cites* its stale `"The 8 kinds"`; a quotation of a
wrong count is not a wrong count.

---

## 3. Seed and demo data

### 3.1 Two seeds, not interchangeable

| | `npm run seed` (`scripts/seed.ts`) | `npm run seed:demo` (`scripts/seed-demo.ts`) |
| --- | --- | --- |
| Purpose | **product** baseline, clean sheet (`:1-8`) | **test/dev-only** mock dataset (`:1-11`) |
| Ships | agent catalog, KBs, skills, org resources, bootstrap admin | arda & co, `viberr-core` + 2 stub projects, VIB-139…168 with full timelines, Arda's inbox, org resources |
| Admin | `admin@viberr.dev` / `SEED_DEFAULT_PASSWORD` (override with `VIBERR_SEED_ADMIN_EMAIL` / `_PASSWORD`, `scripts/seed.ts:35-41`) | `arda@viberr.dev`, same password |
| Reset | `-- --reset` wipes projects, agent profiles, transcripts and derived tables; users/auth + credential homes survive (`scripts/seed.ts:10-12`) | `-- --reset` calls the product seed's `resetStore` first |

`SEED_DEFAULT_PASSWORD = "viberr-dev-2828"`
(`app/server/seed/seed-credentials.ts:12` — a module with **no imports**, because
`playwright.config.ts` used to read it and Playwright's Babel transform has no
`?raw` loader; the rationale is at `:1-11`). Demo users:
`arda|elif|murat|selin|deniz @viberr.dev` (`test-support/demo-data.ts:84-89`).
`auth.setup.ts:17-18` logs in as `arda@viberr.dev` with that constant.

The product seed has shipped none of the demo data since the owner ruling of
2026-07-24. With no seed at all, an empty users table makes the server mint the
same bootstrap admin at boot (random password logged once).

`scripts/seed-demo.ts:26-40` imports `test-support/demo-seed` **dynamically**,
because `test-support/` never ships in the production image; the catch block
prints the real error *then* the "dev-only" message (P13: the guard used to
swallow the reason).

`test-support/demo-seed.ts` is idempotent — users upsert by email, files
overwrite, `rebuildAll(db, { force: true })` reconciles projections (forced,
because renames change actor snapshots without changing file hashes), and
notification / scope-violation / user-pref rows use deterministic ids with
`INSERT OR IGNORE`, so a re-seed keeps a resolved violation resolved and a
user's own pins. One deliberate divergence (`test-support/demo-seed.ts:157-172`):
the fixture pins the **Developer profile to Codex** (`backends: ["codex","claude"]`
at `:166`, `model: "gpt-5.6-terra"`) while the product catalog defaults to Claude
(owner ruling 2026-08-21) — so the
mock dataset still exercises both backends, the Codex delivery path, the "Codex"
actor glyphs and the live-backend-overlay drift scenarios.

Pass-31 changes to the fixture: `test-support/demo-data.ts:182-184` now points
`guardrails` at the one canonical `DEFAULT_GUARDRAILS` instead of a hand copy
(the copy had diverged every time the set changed), and both `demo-data.ts:317`
and `test-store.ts:123` carry the new `heldAtStage: null` frontmatter key.

### 3.2 Two sanctioned ways to build test state (`docs/testing.md:80-100`)

1. **Through the product's own actions** — `createTask`, `transitionStage`,
   `assignSpecialist`, `resolvePacket` on a minimal store from
   `test-support/test-store.ts`. **Prefer this for behaviour tests**: state built
   by the real writers cannot drift from what the product does.
   `setupTestStore(ctx)` (`test-support/test-store.ts:52`) gives a temp root +
   migrated DB + five users with distinct project roles (`:26-27`, `:74-78`):
   arda → project admin, murat → maintainer, selin → contributor, elif → viewer,
   deniz → registered non-member.
2. **The demo fixture** — legitimate coverage, because a hand-written canonical
   file is a **real input class** here (the store is human-editable by design).
   Two drift guards in `app/server/seed/demo-fixture.test.ts`: every fixture file
   parses with **zero unknown frontmatter** and round-trips the current
   serializers (`:116`), and a task written by the real `createTask` lands just
   as clean (`:160`). Migrate the fixture in the same change that breaks them.

**Documented residual risk** (`docs/testing.md:98-100`): a field the schema still
*knows* but the product no longer *writes* passes both guards. That class is
caught by full product passes, not automation.

### 3.3 `test-support/` helpers

- **`test-db.ts`** — `createTestDbContext()` (`:24`) → `makeDb()` (temp dir +
  migrated DB), `makeTempDir()`, `cleanup()`. Pair with `afterEach(ctx.cleanup)`.
- **`test-app.ts`** — `setupAppTest()` (`:36`): temp data root (`:37`), env + db
  singleton reset (`:46-52`), **fake runtime installed** (`:54-60`),
  `cookieFor()`, `csrfFor()`, `request()` with trusted-origin headers (interface
  at `:18-32`). **Import route modules *after* it** (dynamic import, `:14-16`) so
  their graph reads the overridden env; **every form needs `_csrf`** (`:25`). It
  fails **closed** on the runtime — without `installFakeRuntime()` a test
  reaching `autoInvokeOperator` either constructs a real adapter (a paid call
  from `npm test`) or reports "unavailable" and drives an async failure
  escalation that races the assertions.
- **`fake-runtime.ts`** — queued `FakeRun`s per backend (`:12`, `:47`,
  `installFakeRuntime` at `:51`), plus `startedRunSpecs()` (`:38`) and
  `lastRunSpec()` (`:43`) so a test can assert what a path **sent** (prompt,
  denylist, mounted MCP servers).
- **`fake-github.ts`** — canned `fetchImpl` (`fakeGithubFetch`, `:61`), routes
  keyed `"METHOD /path"`; responders may be functions of the recorded call
  (`FakeCall`, `:15`) for first-call-fails retry tests. `unreachableFetch()`
  (`:124`) models a DNS failure. **No live GitHub calls in tests** — every
  service takes a `fetchImpl` injection.
- **`custom-board.ts`** — `CUSTOM_3_STAGE_BOARD` (`:19`), kept after the
  "Lightweight" template was deleted so non-default-stage-id behaviour keeps
  coverage without the product shipping an unworkable preset.
- **`audit-log.ts`** — raw `audit_events` reader (`listAuditEvents`, `:41`);
  production reads the display query.

### 3.4 A clean instance

```sh
VIBERR_DATA_ROOT=$(mktemp -d) npm run seed:demo            # scratch, no docker
rm -rf ./data && npm run seed:demo -- --reset              # the :5174 hermetic root
```

> **Correction to the pass-31 doc.** It said "Docker: `docker compose up --build
> -d` then `docker compose exec app npm run seed`." That is **refused** — and by
> design. `scripts/seed.ts:14-20`: *"`docker compose exec app npm run seed`
> against a RUNNING container is exactly the two-writers-on-one-root shape that
> has already cost this project a WAL — it is now refused rather than silently
> corrupting."* Seed **before** starting the app, or `docker compose stop app`
> first.

### 3.5 Re-baselining the projection DB

**(a) Documented wipe** (`docs/operations/deployment.md:226-241`). Boot prints a
`projection schema drift` **WARN** when `task_projections` CHECK constraints no
longer admit every value the running build produces (F21-1); migrations are
squashed and forward-only, so a root opened by an older build keeps its old
constraint.

```sh
npm run backup                              # FIRST
docker compose down                         # one writer per root
rm ./docker-data/state/projection.sqlite*   # -wal and -shm too
docker compose up -d
```

**Name the cost** (`docs/operations/deployment.md:243-250`). The projection
*tables* rebuild from `projects/`, but the file also holds rows that exist
nowhere else: users and better-auth credentials, sessions, **AES-sealed PATs and
MCP credentials**, the audit trail, notifications, org resources, run history.
`projection.sqlite` is **never** "safe to delete." A `projects/`-only restore
does not degrade gracefully either: surviving files still carry the **old** user
ids in `members[].userId` / `ownerUserId`, which resolve to nobody, and there is
no re-mapping tool. Restoring the backup afterwards puts the drifted schema
back, so it is a safety net for the data, not a way to undo the re-baseline.

**(b) Preserve-copy re-baseline** (controller pass, 2026-08-30) — the wipe loses
users and PATs. This variant creates a **fresh schema** and does a
**column-intersection copy** of the users / auth / PAT / org tables with
**foreign keys OFF**, keeping the root's credentials. **Still no script in the
repo** (`ls scripts/` = `backup.ts docker-entrypoint.sh e2e.ts measure-routes.mjs
rescan.ts restore.ts secret-keys.ts seed-demo.ts seed.ts store-check.ts`); the
shape lives only in a session scratchpad. Pass 31 did not land it.

**(c) Hermetic-data copy** (pass 30) — a realistic :5174 root without becoming a
second writer: `rsync docker-data → data` minus the `workspace/` dirs, a
`.backup` of `projection.sqlite` (not `cp`, because of the WAL), delete
`state/writer.lock`.

### 3.6 Read-only ops tools

- `npm run store:check` (`scripts/store-check.ts`) — the **store doctor**.
  Parses every canonical file and names the ones the app can no longer trust,
  with the parse error and the offending line. Exists because parsing is
  deliberately tolerant: nothing throws, so `npm run rescan` reported `0 errors`
  over a file whose fields had all silently fallen back to defaults (`:7-12`).
  Read-only, DB-free, no lock (`:14-15`), **exit 1 when any file is untrusted**
  (`:17`, `:26`) — can gate a deploy or a cron.
- `npm run rescan [-- --force]` — takes the writer lock (`scripts/rescan.ts:24`);
  while the app is up, use Home → store strip → "Re-scan store" instead.
- `npm run backup` — **no writer lock, deliberately**: it opens the projection
  read-only, so it works on a live instance (`scripts/backup.ts:15`).
- `npm run restore` — **two different postures** (`scripts/restore.ts:8-16`).
  `--from <artefact>` alone is a whole-root restore: it replaces
  `state/projection.sqlite` and the canonical files, so it **takes the writer
  lock and refuses while the app runs** (`:56-70`). `--from … --file <path>`
  writes one markdown file, touches no SQLite, and takes **no** lock (`:46-53`)
  — the live-instance recovery path for a botched hand-edit.
- `npm run keys -- status` — opens the projection read-only, no lock, answers on
  a live instance (`scripts/secret-keys.ts:46-53`). `npm run keys -- reseal`
  writes, so it takes the lock (`:55`).

---

## 4. E2E patterns and jsdom traps

### 4.1 The suite — 63 tests across 8 files

- `auth.setup.ts` — login through the real `/login` UI → `e2e/.auth/arda.json`
  (`:26`). One `setup` "test".
- `01-home-board` (7) — Home projects, stage columns, dnd-kit: same-stage
  reorder, cross-stage append, Escape-cancels-lift, Done-stage confirm + verdict
  gate.
- `02-feeds-profile` (5) — review queue, activity day-grouping, mark-all-read,
  theme persistence.
- `03-org-settings-store` (3) — settings tabs, heading scope (R15-13), **a real
  file-store `mkdir` through the UI**.
- `04-palette-mobile` (6) — ⌘K palette, board filter scoping, 375 px rail
  collapse, non-member 404 (R15-4), touch targets.
- `05-task-comment-composer` (7) — Lexical: Enter vs ⌘+Enter, @-mention keyboard
  and click insert, Escape, undo-after-post, combobox a11y.
- `06-activity-hydration` (1) — React #418 under
  `test.use({ timezoneId: "Pacific/Auckland" })` (`:22`).
- `07-accessibility` (33) — 2 themes × (**12 surfaces** `:31-77` + **3 dialogs**
  `:82`: command palette, new task, create profile), audited **in their open
  state**; plus the mobile rail overlay (`:216`) and login signed-out in both
  themes (`:251`).

### 4.2 Login fixture — the pre-hydration trap

`e2e/auth.setup.ts:11-21`:

```ts
await page.goto("/login");
await page.waitForLoadState("networkidle");
await expect(async () => {
  await page.fill('input[name="email"]', "arda@viberr.dev");
  await page.fill('input[name="password"]', SEED_DEFAULT_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL("/", { timeout: 5_000 });
}).toPass({ timeout: 30_000 });
```

**The inputs are React-controlled: a fill that lands before hydration is wiped
when React takes over** (`:12-14`). Hence `networkidle` plus a `toPass` retry of
the *whole* login. For ad-hoc scripts, wait `networkidle` **plus ~1 s** before
filling.

### 4.3 The Playwright driver on :4999

When the Browser pane wedges (hidden, 0×0 viewport, stale composite, scroll
timeouts — seen in passes 20, 29, 30), the working fallback is a **persistent
ad-hoc Playwright driver**: a scratchpad `driver.mjs` running an HTTP command
server on **:4999**, driving real chromium against the hermetic :5174 server. Two
details matter:

- Import playwright by **absolute path**
  (`/Users/akinozer/projects/viberr/node_modules/playwright/index.mjs`) — **ESM
  ignores `NODE_PATH`**, so a bare `import "playwright"` from a scratchpad file
  fails.
- `page.fill` + `click` works headless for login; the Browser pane's own
  classifier blocks typed passwords, and a pane-synthetic Escape is **not** a
  native `<dialog>` cancel (close via backdrop click instead).

### 4.4 Hermetic e2e patterns

- **Timezone pinning** (`06-activity-hydration.spec.ts:22`) keeps the hydration
  spec discriminating even when the host runs in UTC (CI); Auckland also pushes
  most timestamps across a **day** boundary, exercising the day-bucket regroup,
  not just clock text. The spec listens on `page.on("pageerror")` (`:26-29`) and
  asserts an empty list.
- **Theme cookie** (`viberr_theme`, `07-accessibility.spec.ts:29`, `:155-162`) is
  set directly to audit both themes without clicking through the UI.
- **Axe rule set is `wcag2a` / `wcag2aa` / `wcag22aa` only**
  (`07-accessibility.spec.ts:165-169`) — best-practice rules are opinions, and
  failing CI on an opinion trains people to ignore the gate.
- **Serial by construction** — `workers: 1`; the specs share one seeded store.
- A same-tick toggle+save inside `page.evaluate` **races React**: click, settle,
  save separately.

**Three time-of-day fixes landed in pass 31** — all three failures reproduced on
`main` and were caused by the wall clock moving the seeded data, not by the
change under test:

1. **Board append-drop** (`e2e/01-home-board.spec.ts:131-152`). Due-date chips
   push seeded cards past the fold as the clock moves, and a single move onto the
   last card's bottom half is unstable — the insert preview shifts the card
   *down* under the pointer, putting the same screen point back in its top half.
   Fix: **two-phase** — hover the last card, wait for `.card-drop-preview`, read
   the *settled* rect, then a corrective move to just below it. `liftOver()` lost
   its `at: "bottom" | "center"` parameter entirely (`:35-46`) — **but not its
   docblock, which still documents both values** (`:32-34`; see F32-T16).
2. **Activity actor** (`e2e/02-feeds-profile.spec.ts:63-73`). The stream's actor
   **filter `<select>`** carries "Arda Kaya" as a hidden `<option>`, so once the
   day's events put her in the filter a bare `getByText` resolved to the option
   first and failed visibility. Fix: scope to `.act-actor`.
3. **Org-settings audit list** — fixed in the *app*, not the spec: the
   `.audit-list` caps at 15 rem and scrolls, and axe's
   `scrollable-region-focusable` fired the first time the seed log grew past the
   cap. `app/features/org-settings/org-settings-page.tsx:275-276` now sets
   `tabIndex={0}` + `aria-label="Recent audit events"` on the `.audit-list`
   `<ul>` (`:268`), with the incident recorded in the comment at `:270-274`.

### 4.5 jsdom / vitest traps

1. **`vi.spyOn` on an already-spied method returns the SAME mock with accumulated
   calls** — `mockClear()` before asserting absence.
2. **A module-level crash shows up as a FAILED FILE with zero failed tests.**
   Grep for suite-level errors, not just test counts (`agents-page.test.tsx`
   slipped a triage).
3. **ESM ignores `NODE_PATH`** — ad-hoc scripts must use absolute `node_modules`
   paths.
4. **`// @vitest-environment jsdom` is per file**; the default env is node
   (`vitest.config.ts:11`). 52 files opt in.
5. **jsdom never simulates `showModal()` focus stealing** — a bug where
   `showModal()` steals focus right after `autoFocus`, firing
   `onBlur → setTouched` on first paint, is invisible to it (pass 30, board
   new-task modal opened red).
6. **`data()` throws a `DataWithResponseInit`, not a `Response`** — assert
   `thrown.init?.status`; loaders need a thrown `Response`, not an `AppError`.
   And `init?.status ?? status` is a trap — `AppError` also has `status`.
7. **Lexical jsdom tests**: drive via `ce.__lexicalEditor` inside an async `act`
   — updates commit in microtasks. Pattern at
   `app/features/task-detail/mention-composer.test.tsx:65`, `:104`.
8. **`useDialog` reads computed `transition-duration`**
   (`app/ui/use-dialog.ts:34-42`), which is 0/NaN in jsdom (no stylesheet) and
   ~0 under `[data-motion="reduce"]`, so close is **synchronous** and tests stay
   green without a fake timer. Threshold is `> 0.02` s.
9. **Restoring a canaried file via `mv` rewinds mtime**, so vite/vite-node dep
   caches serve **stale** transforms (vitest is fine; a running dev server is
   not).
10. **Known flake**: `app/features/notifications/notifications-route.server.test.ts`
    — an in-flight operator drive writes into the temp root while `cleanup`
    `rmSync`s it (ENOTEMPTY). All its tests pass; only teardown fails,
    intermittently. Not re-observed this session (the full run was green), and
    nothing in the file records it.
11. **Test seams are idiomatic here** (`resetOperatorLeasesForTests`,
    `configureRunServiceForTests`) — exporting a private function to pin an
    invariant is accepted practice, not a smell. Note
    `anti-slop/no-module-mocking` is on (`.oxlintrc.json:25`), so module mocking
    is **not** the alternative.
12. **Pin `TZ` in `beforeAll`, and assert the pin.**
    `app/features/runtime/log-clock.test.ts:16-29` is the pattern: set
    `process.env.TZ = "Europe/Berlin"`, restore in `afterAll`, and open with a
    "guards against a vacuous suite" test asserting the two DST offsets. The
    docblock (`:8-13`) records why: CI runners are UTC and the repo sets no `TZ`,
    so an offset-*derived* expectation held for a no-op helper and green-lit the
    bug forever.

---

## 5. Canary discipline

**Canary every test by actually reverting the fix, and check it fails for the
RIGHT reason.** Re-learned in passes 15, 17, 19, 30, the 2026-08-30 bug sweep,
and pass 31 (whose 15 regression locks are all recorded as individually canaried,
commit `1b362434`).

**Why it keeps mattering.** In the bug sweep, **five** of the author's own
regression tests passed against *unfixed* code: `init?.status ?? status`
(AppError also has `status`); `indexOf` comparisons where an absent entry is
`-1`; fixtures whose two derivations happened to agree; a stale claim the tick
re-stamps anyway; and a queued-start test where the **fake runtime made the start
succeed**. Pass 15 recorded three vacuous "proving" tests from the same cause. A
test never watched failing is not evidence.

**The `git checkout` trap.** `git checkout <file>` for a canary **wipes all
uncommitted work on that file** — it cost two fixes in pass 17 (D1 pr-open, then
all of D3's task-actions edits) and an uncommitted refinement in pass 28 (via
`git checkout HEAD -- app` for an oxlint base compare). **Commit before
canarying, or neuter the specific line by hand.**

**The verifier trap: verifiers read the WORKING TREE.** Fixing while verification
runs makes adversarial agents refute their colleagues' *true* findings — "the
code state it describes is already gone." **Six of the first seven refutations**
in the bug sweep were this artifact. **Judge those by the canary, not the
verdict.** Freeze the tree during verification, or hand verifiers a pinned
revision.

Corollaries carried into pass 32:
- The sweep found a bug **in its own fix** (a goal `attention` un-parked on the
  absence of a failed link, oscillating every 60 s and re-notifying). Narrow an
  un-park to the cause the same pass watched disappear.
- Over-correction is real: routing a delivery flag through
  `resolveDeliveryPermissions` wholesale flipped headline-only profiles too.
  Target the reported state precisely.
- Fixes come in **families** — the 2026-08-31 review of PR #248 found ~12 of 15
  findings were **siblings** the sweep's own fixes left exposed. **Grep every
  sibling when fixing a class.** Pass 31's C5 is the canonical example: the last
  whole-array tolerant-parse sibling, found by grepping the class.
- A test whose fix is "assert membership, not order" is a deflake, and pass 31
  did one deliberately (`a912e9e5`, T16: "assert notification-kind membership,
  not same-millisecond newest-first order"). Same-millisecond ordering is not a
  contract.
- `qa/pass2*-canary.md` are **artifacts left by live agent runs** (e.g.
  `qa/pass25-canary.md:1`: "Pass 25 QA canary - safe to delete"), not testing
  docs. `qa/smoke/README.md` defines the pass-note format for live smoke
  evidence (`pass<NN>-<topic>.md`). `qa/pass31/` holds this cycle's three live
  notes. `test-results/` and `playwright-report/` are gitignored run output
  (`.gitignore:11-12`); **`test-artifacts/` is NOT** — it is 12 tracked files
  used as tiny payloads for live PR experiments.

---

## 6. CI — **live again**

`.github/workflows/ci.yml` — two jobs on `push`/`pull_request` to `main`,
`ubuntu-latest`, `node-version: 26`, npm cache:

- **`verify`** (`:10-33`): `npm ci` → **Lint** → **Typecheck** → **Unit +
  integration tests** → **Build**. Lint runs **first** deliberately (ruling 86 /
  R21-3, pass 21).
- **`e2e`** (`:35-60`): `npm ci` → `npx playwright install --with-deps chromium`
  → `npm run e2e` → uploads `playwright-report/` on failure (7-day retention).

`playwright.config.ts:31-33` branches on `CI`: `forbidOnly: true`, `retries: 1`,
`reporter: [["list"], ["html", { open: "never" }]]`.

> ### The billing block is GONE (verified 2026-09-01 via `gh run list`)
>
> Pass 31 and the project memory record GitHub Actions as billing-broken — jobs
> never start, the failure surfaces only as a repository annotation. **That is no
> longer true.** Runs resumed some time between `2026-08-31T20:51Z` (last
> no-step "failure", the billing shape) and `2026-09-01T06:52Z`.
>
> **The last eight runs (every run since `2026-09-01T12:33Z`, i.e. PRs #261-#264
> and their merges) are `success`, with both jobs green.** Example: run
> `33538981232` (push, `main`, 68b5480e) — `verify` success 7 m 40 s, `e2e`
> success 5 m. **CI can gate branches again.** `CONTRIBUTING.md:42` and `:74`
> ("CI must pass") are satisfiable for the first time since PR #230.
>
> **But main went red once in between.** Run `33479481246` (push of `58e109d6`,
> the PR #260 merge) failed `verify` at "Unit + integration tests": `Failed Tests
> 6` across 3 files. Breakdown from the log: **five "Test timed out in 5000ms"**
> and **one real assertion**, `agent-completion.server.test.ts` — *"reviewer reply
> must survive the stale-read write: expected undefined to be truthy"*
> (`app/server/tasks/agent-completion.server.test.ts:791`). Files:
> `app/features/agents/agents-route.server.test.ts` (2),
> `app/server/db/self-heal.server.test.ts` (3),
> `app/server/tasks/agent-completion.server.test.ts` (1). **Nothing in PRs #261
> to #264 touched any of those three files**, and every run since has been green
> — so these are flakes under CI load, not a fixed bug. See the findings.

**The local gate set still matters** (it is what a worktree or an offline pass
runs, and it is faster than waiting on CI):

```sh
npm run typecheck    # clean — measured this session
npm test             # 295 files / 4,818 tests green — measured this session
npm run lint         # 0 errors, 2 warnings, exit 0 — measured this session
npm run build        # production build (not measured this session)
npm run e2e          # needs docker; the only real-CLI gate (not run this session)
```

---

## 7. Recipes

Everything below is verbatim-runnable from the repo root. Absolute paths where
they matter.

### 7.1 Run one suite / one test

```sh
npx vitest run app/features/copy-ban.test.ts
npx vitest run app/app.css.test.ts app/features/toast-honesty.test.ts   # several files
npx vitest run app/server/tasks/schedule.server.test.ts -t "T17"        # by title
```

The meta-gate set in one go (6 files, 117 tests, ~0.6 s):

```sh
npx vitest run app/app.css.test.ts app/features/copy-ban.test.ts \
  app/features/retired-vocabulary.test.tsx app/features/toast-honesty.test.ts \
  app/shared/docs/prd-sync.test.ts app/shared/docs/file-formats-sync.test.ts
```

### 7.2 Run the gates and keep the exit code

> **`cmd | tail` masks the exit code.** `$?` after a pipeline is the *last*
> command's status, so `npm test | tail -5` reports 0 on a red suite. Redirect
> instead, then read the file.

```sh
LOG=/tmp/viberr-gates.log
npm test        > "$LOG" 2>&1; echo "test    exit=$?"; tail -8 "$LOG"
npm run lint    > "$LOG" 2>&1; echo "lint    exit=$?"; cat "$LOG"
npm run typecheck > "$LOG" 2>&1; echo "tsc     exit=$?"; tail -20 "$LOG"
npm run build   > "$LOG" 2>&1; echo "build   exit=$?"; tail -20 "$LOG"
```

If you must use `${PIPESTATUS[0]}`, do it in the same command:

```sh
npm test 2>&1 | tail -5; echo "exit=${PIPESTATUS[0]}"
```

**Before trusting a green lint**, prove the plugin loaded (oxlint 1.79 prints no
summary line, so silence is ambiguous):

```sh
node -p "require('./node_modules/oxlint/package.json').version"
node -p "require('./node_modules/@oxlint/plugins/package.json').version"   # must match
cat > /tmp/slop-probe.ts <<'EOF'
export function probe(input: unknown): unknown { return input; }
export type Bag = Record<string, unknown>;
EOF
npx oxlint -c .oxlintrc.json /tmp/slop-probe.ts     # must report 3 anti-slop errors
```

### 7.3 Canary a test (the only proof it bites)

```sh
git status --porcelain                 # 1. tree must be clean for the file you touch
git add -A && git commit -m "wip"      #    (or commit first — `git checkout` EATS edits)

# 2. break the fix, not the test: neuter the ONE line the fix added.
#    Edit by hand; do NOT `git checkout HEAD -- <file>`.

npx vitest run <the test file> > /tmp/canary.log 2>&1; echo "exit=$?"
grep -E 'FAIL|AssertionError|Test timed out' /tmp/canary.log   # 3. RED, and for the right reason

git checkout -- <the file you neutered>                        # 4. restore (safe: it was committed)
npx vitest run <the test file> > /tmp/canary.log 2>&1; echo "exit=$?"   # 5. GREEN again
```

Two traps: a canary that fails with a *different* error (a crash, a timeout)
proves nothing; and restoring with `mv` rewinds mtime, so a running dev server
serves a stale transform — `git checkout --` or a real edit is safer.

### 7.4 Run e2e without masking the exit code

```sh
docker ps --format '{{.Names}}'        # `viberr-app-1` may keep running: e2e uses its OWN project
npm run e2e                > /tmp/e2e.log 2>&1; echo "e2e exit=$?"
tail -40 /tmp/e2e.log

npm run e2e -- e2e/07-accessibility.spec.ts   # one spec
VIBERR_E2E_KEEP=1 npm run e2e                 # leave the stack up; tear down with:
#   docker compose -f compose.e2e.yml -p viberr-e2e down --volumes --remove-orphans
```

A bare `npx playwright test` throws by design (`playwright.config.ts:18-25`) —
there is no app to target.

### 7.5 Inspect the running container's database

**Never point the host's `sqlite3` at `docker-data/state/projection.sqlite`.**
Reading a live WAL database from the host over VirtioFS gives stale or partial
reads and can leave `-shm` debris in the container's root. Read it **inside** the
container with `node:sqlite` opened `readOnly` — `node` is in the image
(`Dockerfile:48`), `python3` deliberately is not (`:84`).

```sh
docker exec viberr-app-1 node -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('/data/state/projection.sqlite', { readOnly: true });
console.log(db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' ORDER BY name\").all().map(r=>r.name).join(' '));
db.close();
"
```

Verified this session. The 34 tables include `agent_runs` (**not** `runs`),
`run_log_lines`, `audit_events`, `task_projections`, `task_events`,
`notifications`, `users`, `session`, `account`, `github_pats`,
`controller_conversations`, `controller_messages`, `instance_settings`,
`goal_projections`, `scope_violations`.

```sh
# the last few runs
docker exec viberr-app-1 node -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('/data/state/projection.sqlite', { readOnly: true });
for (const r of db.prepare('SELECT id, kind, state, task_key, started_at FROM agent_runs ORDER BY started_at DESC LIMIT 5').all()) console.log(r);
db.close();
"

# the newest audit rows
docker exec viberr-app-1 node -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('/data/state/projection.sqlite', { readOnly: true });
for (const r of db.prepare('SELECT occurred_at, action, actor_label, project_slug FROM audit_events ORDER BY occurred_at DESC LIMIT 10').all()) console.log(r);
db.close();
"
```

`occurred_at`, not `created_at` — the column trap from pass 19.

### 7.6 Read a run log

Canonical raw truth is one NDJSON file per run:
`${VIBERR_DATA_ROOT}/runtimes/<backend>/<runId>.jsonl`
(`app/server/runtimes/run-store.server.ts:399`, path built at `:414`; appended at
`:426`). The projection copy lives in `run_log_lines`, and the sink documents why
both exist (`app/server/runtimes/run-sink.server.ts:37`, `:93`): if the DB write
fails the `.jsonl` still holds the stream, and the console says so
(`:290`).

```sh
docker exec viberr-app-1 sh -c 'ls -t /data/runtimes/claude/*.jsonl | head -3'
docker exec viberr-app-1 sh -c 'tail -5 /data/runtimes/claude/run_XXXX.jsonl'
docker exec viberr-app-1 sh -c 'grep -c . /data/runtimes/claude/run_XXXX.jsonl'   # line count
```

Through the app instead (member-scoped, scrubbed, paged):
`GET /resources/run-log?runId=<id>` (`app/routes.ts:45` →
`app/routes/resources.run-log.ts`). Two modes (`:12-41`):
`?since=<seq>` reads **forward** from a cursor; `?before=<seq>&limit=<n>` reads
the newest `n` lines **older** than `seq`, with `limit` clamped to 1…500
(`:58-61`). It authorizes **project membership** (org admins pass via the D2
override), and a `kind === "controller"` run is scoped to the conversation's
owner instead (`:71-80`). Raw run logs are sensitive (F10-06/F10-33) — the sink
scrubs injected credentials and token-shaped strings, which is a filter, not a
guarantee.

Health: `GET /resources/health` (`app/routes.ts:47`) — `{ ok, projections,
watcher }`, the same probe `scripts/e2e.ts:89` and both compose healthchecks poll.

### 7.7 Rebuild and restart the container

```sh
docker compose up -d --build          # rebuild the image and recreate
docker compose logs -f app | head -60 # boot lines: integrity check, schema drift WARN, lock holder
docker compose restart app            # no rebuild
```

The build context is the **main working tree**, never a worktree — a fix that
lives only in a worktree will not be in the image. `compose.yml:20-23` forces
`NODE_ENV=production` and `VIBERR_DATA_ROOT=/data` over whatever `.env` says.
Bump `PRIOR_SHIPPED_HASHES` when you edit a shipped asset, or the seed will not
overwrite the old copy on the volume.

### 7.8 The two dev servers

```sh
# :5174, hermetic, VIBERR_DATA_ROOT=$PWD/data — the one every recent pass used
PORT=5174 VIBERR_DATA_ROOT="$PWD/data" npm run dev -- --port 5174

# :5173, docker-data — REFUSES to start while viberr-app-1 is running
```

Both are in `.claude/launch.json` (`viberr-dev-hermetic`, `viberr-dev`). Seed the
hermetic root first: `rm -rf ./data && npm run seed:demo -- --reset`. Log in as
`arda@viberr.dev` / `viberr-dev-2828`.

### 7.9 GitHub CLI for PR / CI experiments

Read-only inspection (safe, used this session):

```sh
gh run list --limit 10
gh run view <runId> --json jobs | jq -r '.jobs[] | "\(.name) \(.conclusion)"'
gh run view <runId> --log-failed | sed 's/\x1b\[[0-9;]*m//g' | grep -E 'FAIL|Test timed out|AssertionError'
gh pr view <n> --json number,state,mergeable,headRefOid,statusCheckRollup
gh pr checks <n>
```

Mutating (owner-authorized live experiments only — merge is a **human** act by
ruling, and the agent denylist blocks `gh pr merge` inside runs):

```sh
gh pr create --fill --base main
gh pr merge <n> --squash --delete-branch     # the "human merged it outside Viberr" fixture
gh pr close <n>                              # the unowned-PR / collision fixture
```

Live PR experiments use tiny files under `test-artifacts/` so the diff never
bloats a real change. After a `gh` merge, the local branch's origin ref is stale
— `git fetch --prune` before reading state (pass-29 trap).

---

## 8. Findings for the pass-32 ledger

**F32-T1 — CI is green again and no doc says so; the local-gates-only contract
is now stale.** `.github/workflows/ci.yml` runs and passes (last eight runs, both
jobs). Pass 31's §6, the project memory, and every pass note since #230 say CI
cannot gate a branch. Nothing in the repo records the change, so the next pass
will again treat annotations as the only signal and merge on local gates alone.
*Where:* `.github/workflows/ci.yml:10-60`; evidence `gh run view 33538981232`.
*Why it matters:* the acceptance contract in `CONTRIBUTING.md:42` and `:74` is
satisfiable again — and a PR that skips CI now skips a real gate.
*Confidence:* **high** (measured).

**F32-T2 — Five tests time out on CI at the default 5 s; `vitest.config.ts` sets
no `testTimeout`.** Run `33479481246` (`58e109d6` on main) reported
`Failed Tests 6` across 3 files; the raw log carries **"Test timed out in
5000ms"** for five of the six (the string appears 10 × because vitest prints each
failure in both the list and the detail block) and one real assertion (F32-T3).
The three files are `app/server/db/self-heal.server.test.ts` (3 — it builds and
corrupts real SQLite files; `:160` is one of them),
`app/features/agents/agents-route.server.test.ts` (2) and
`app/server/tasks/agent-completion.server.test.ts` (1). The same files are
untouched by PRs #261-#264 and every later run is green, so this is runner speed,
not a bug. *Where:* `vitest.config.ts:9-22` (no `testTimeout` key);
`app/server/db/self-heal.server.test.ts:160`, `:186`.
*Why it matters:* now that CI gates again, a 2-core runner under load can fail
`main` for no product reason — and a red CI that is usually spurious is a gate
people learn to re-run rather than read. *Confidence:* **high**.

**F32-T3 — A genuine flaky assertion: the VirtioFS stale-read test.**
`"the reviewer's reply survives a following stale-read write"` failed on CI with
*"expected undefined to be truthy"* — a real assertion, not a timeout. The test
writes a file, reverts it on disk to simulate a stale read, then appends through
`updateTaskFile` and asserts the reviewer comment survived. It has passed every
run since. *Where:*
`app/server/tasks/agent-completion.server.test.ts:766-791`.
*Why it matters:* this is the one failure in that run that could be a real
read-modify-write race rather than slowness; an intermittently-red data-loss test
is exactly the one you cannot afford to dismiss. *Confidence:* **medium** (one
observation, not reproduced locally).

**F32-T4 — `docker compose exec app npm run seed` is documented in the pass-31
doc and refused by the code.** `scripts/seed.ts:14-20` refuses to run against a
live container (writer lock, B-FD1). The pass-31 §3.4 recipe tells the reader to
do exactly that. *Where:* `scripts/seed.ts:14-20` vs
`planning/discovery-2026-08-31-pass31/docs/06-testing-verification.md:414`.
*Why it matters:* a discovery doc that hands the next pass a refused command
costs a debugging cycle; corrected in §3.4 above. *Confidence:* **high**.

**F32-T5 — Pass 31 mis-stated the ops-CLI lock posture; `restore` and
`keys -- reseal` DO take the writer lock.** Pass 31 §3.6 lists `backup` and
`restore` together as "read-only," and names only `seed`, `seed:demo`, `rescan`
as lock-takers. In fact `scripts/restore.ts:56` (whole-root) and
`scripts/secret-keys.ts:55` (`reseal`) both take it and refuse on a live
instance; only `--file` restore (`:46-53`), `backup` (`scripts/backup.ts:15`),
`store:check` and `keys -- status` are lock-free. *Where:* the five
`runWithDataRootWriterLock` call sites. *Why it matters:* someone planning a
live-instance recovery from the old doc would expect a whole-root restore to work
with the app up. *Confidence:* **high**.

**F32-T6 — Pass 31 called `test-artifacts/` gitignored run output; it is 12
TRACKED files.** `.gitignore:11-13` covers `playwright-report/`, `test-results/`,
`e2e/.tmp-data/` — not `test-artifacts/`, which holds six pass-20 `.txt` payloads
and six `controller-live/*.png`. *Where:* `.gitignore:1-16`; `git ls-files
test-artifacts`. *Why it matters:* an agent told it is scratch output will delete
the live-PR fixtures other passes reuse. *Confidence:* **high**.

**F32-T7 — Doc drift: `npm test` does not cover `db/`.** `docs/testing.md:11`
("Runs Vitest over `app/` and `db/` only") and `README.md:85` ("vitest unit +
integration suite (`app/` + `db/`)") both claim a `db/` glob that
`vitest.config.ts:16-21` removed in pass 12 — and `docs/testing.md:14` says so
three lines later, so the file contradicts itself in one paragraph.
*Why it matters:* it advertises coverage of the migration baseline that does not
exist. *Confidence:* **high**.

**F32-T8 — Doc drift: `README.md`'s "All npm scripts" table is missing four
scripts.** It lists 9 of the 13 in `package.json:9-24`; `store:check`, `backup`,
`restore` and `keys` are absent — the four an operator most needs during an
incident, all documented elsewhere (`docs/operations/runbook.md`). *Where:*
`README.md:78-89`. *Confidence:* **high**.

**F32-T9 — Doc drift: `docs/testing.md` says the e2e config sets
`VIBERR_DATA_ROOT` for you.** `docs/testing.md:104-105` — actually
`compose.e2e.yml:13` sets it to `/data` inside the container, and
`playwright.config.ts` sets no data root at all; the host value is irrelevant to
e2e. Harmless but wrong about where the isolation comes from. *Confidence:*
**high**.

**F32-T10 — A gate's own docblock is stale: the toast rationale.**
`app/features/toast-honesty.test.ts:11` says *"both kinds paint `var(--fg)`; only
the glyph differs"*. Since P13-D-10 the glyph **colour** differs too —
`app/app.css:1858` paints `.toast .ico` `--teal-light` and `:1862` paints
`.toast[data-kind="error"] .ico` `--coral-light`. The gate's behaviour is
unaffected; its stated reason is out of date. *Why it matters:* the docblock is
what a future pass reads to decide whether the gate is still needed.
*Confidence:* **high**.

**F32-T11 — Nothing checks the vendored anti-slop plugin against its upstream
skill.** `tools/oxlint/anti-slop/` is a byte-identical copy of
`.claude/skills/install-anti-slop/assets/anti-slop/` (verified by `diff -rq` this
session), but the skill dir is untracked and no test asserts the equality — the
same class the PRD mirror (`prd-sync.test.ts`) and the file-formats mirror
(`file-formats-sync.test.ts`) each got a gate for after drifting twice.
*Where:* `.oxlintrc.json:19`, `tools/oxlint/anti-slop/index.ts`.
*Why it matters:* low today (zero drift), but the two precedents in this repo
both drifted silently before anyone noticed. *Confidence:* **high** (the gap),
**low** (the risk).

**F32-T12 — `scripts/measure-routes.mjs` has no runner and no reference.** No
`package.json` script, no CI step, no doc mention outside its own header; it was
the modernization pass's bundle-size gate. *Where:*
`scripts/measure-routes.mjs:1-12`. *Why it matters:* dead tooling that reads as a
gate. *Confidence:* **high**.

**F32-T13 — `e2e/.tmp-data/` is a dead gitignore entry.** `.gitignore:13` names a
directory the e2e stack stopped using when it moved to the named volume
`e2e-data` (`compose.e2e.yml:68-69`). Cosmetic. *Confidence:* **high**.

**F32-T14 — `scripts/` still has zero unit coverage, by design.** Unchanged from
pass 31 and still the one directory whose lack of coverage shipped a regression
(`docs/testing.md:14-19`). E2E covers `scripts/e2e.ts` and the seed path
transitively; `backup.ts`, `restore.ts`, `secret-keys.ts`, `store-check.ts` and
`rescan.ts` are exercised only by hand. *Confidence:* **high** (accepted, not a
defect).

**F32-T15 — The preserve-copy re-baseline still has no script.** Carried from
pass 31 finding #3, unchanged: the recipe that keeps users and PATs across a
schema re-baseline exists only as prose in a session scratchpad, while the
lossy wipe is the one the docs teach (`docs/operations/deployment.md:236-241`).
*Why it matters:* the documented remedy destroys credentials; the safe one is not
written down anywhere durable. *Confidence:* **high**.

**F32-T16 — A pass-31 e2e helper's docblock outlived its parameter.**
`e2e/01-home-board.spec.ts:32-34` still documents `liftOver`'s `bottom` /
`center` modes ("`bottom` aims at the blank space under a column's cards
(append)") — the exact behaviour the two-phase fix deleted, immediately above the
now-mode-less signature at `:35-39`. *Why it matters:* the comment teaches the
reader the single-move approach that was proven unstable, which is how the flake
comes back. *Confidence:* **high**.

**Closed since pass 31** (recorded so the next pass does not re-file them):

- *Lint docs contradict reality* (pass-31 #1) — **fixed**. `npm run lint` exits 0
  with no allowlist; `CONTRIBUTING.md:62`, `README.md:83`, `docs/testing.md:28-45`
  and `docs/testing-quickstart.md:19-20` are all true again.
- *No spacing or radius scale gate* (pass-31 #2) — **fixed**.
  `app/app.css.test.ts:2588` (radius, no allowlist, 2 literals snapped) and
  `:2651` (spacing, locked by de-facto step shape).
- *Safari and Firefox are declared support with zero coverage* (pass-31 #5) —
  **resolved by decision**, ruling 103. The PRD matrix is Chromium-only
  (`planning/planning-artifacts/prd.md:160`), so the declaration now matches what
  the suite runs.
- *CI is unusable* (pass-31 #6) — **no longer true**; see F32-T1.
