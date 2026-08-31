# 06 — Testing & verification

Discovery pass 31, 2026-08-31. Verified against the working tree at `626130a`
unless marked otherwise.

---

## 1. The five gates

`package.json` is the only script surface. `engines.node >= 26` (`.nvmrc` pins it).

| Command | What it is | Config |
| --- | --- | --- |
| `npm test` | vitest run — unit + integration | `vitest.config.ts` |
| `npm run typecheck` | `react-router typegen && tsc` | `tsconfig.json` |
| `npm run lint` | `oxlint` + the vendored `anti-slop` plugin | `.oxlintrc.json`, `tools/oxlint/anti-slop/` |
| `npm run e2e` | `tsx scripts/e2e.ts` — Playwright vs the production Docker image | `playwright.config.ts`, `compose.e2e.yml` |
| `npm run build` | `react-router build` | `vite.config.ts` |

### 1.1 Unit suite

- `vitest.config.ts` includes **only** `app/**/*.test.{ts,tsx}` — 292 files. Last
  recorded full-suite count: **4,666 green** (2026-08-31).
- Default environment is **node**. jsdom is opt-in **per file** via a
  `// @vitest-environment jsdom` comment on line 1 (51 files do this). Without it
  a component test dies on `document is not defined`.
- Setup files, run before any app module loads: `test-support/setup-env.ts`,
  `test-support/setup-dom.ts`.
- `db/**/*.test.ts` was dropped in pass 12 (migrations are squashed into
  `db/0001_baseline.sql`, so the glob matched nothing).
- **`scripts/` is deliberately not collected** (`docs/testing.md` records this and
  its cost: the pass-13 `npm run seed` regression shipped through the hole). Cover
  script behaviour by moving it into `app/`, or via e2e, which runs real CLI entrypoints.

Subset: `npx vitest run app/features/copy-ban.test.ts`.

### 1.2 Hermetic env (`test-support/setup-env.ts`)

This is why `npm test` needs no `.env`. Four jobs, each with an incident behind it:

1. Seeds `VIBERR_SESSION_SECRET` and `VIBERR_SECRET_ENCRYPTION_KEY` with `??=`.
2. **Blanks every real-backend credential** (`ANTHROPIC_API_KEY`,
   `CLAUDE_CODE_OAUTH_TOKEN`, `VIBERR_CLAUDE_USE_CLI_AUTH`, `CODEX_ACCESS_TOKEN`,
   `CODEX_API_KEY`, `OPENAI_API_KEY`, `VIBERR_CODEX_USE_CLI_AUTH`,
   `VIBERR_BROWSER_EXECUTABLE`). Assigned `""`, **never `delete`d** — `env.server.ts`
   calls `loadEnvFile()` at module scope, i.e. *after* setup, and fills any key not
   already present, so `delete` hands the developer's `.env` value back. Risk closed:
   **a paid provider call from `npm test`**.
3. Pins `CLAUDE_CONFIG_DIR` / `CODEX_HOME` to a fresh `mkdtemp` with `projects/` and
   `sessions/` pre-created. An *empty existing* dir is deterministic (`missing`); a
   missing one reports `unknown`. Before this, the same test passed on CI and failed
   on a laptop.
4. `GIT_ALLOW_PROTOCOL=file` so https/ssh `git clone` fails instantly and offline.
   Two tests reach `cloneRepo` with a publicly-resolvable repo name.

`setup-dom.ts` polyfills `HTMLDialogElement.showModal/show/close` (the app uses
native `<dialog>`) and stubs `ResizeObserver` for dnd-kit. Both probe with
`Object.hasOwn`, not `in` — lib.dom *declares* both, so `!(x in y)` narrows the
polyfill branch to `never`.

### 1.3 `VIBERR_DATA_ROOT`

Controls where canonical markdown + SQLite projections live; defaults to `./data`.
For any manual run that touches the store: `VIBERR_DATA_ROOT=$(mktemp -d) npm test`.
Most tests already `mkdtemp` their own roots via `test-db.ts` / `test-app.ts`.

### 1.4 Typecheck — `tsc` is the gate, `npm run build` is NOT

`npm run typecheck` = `react-router typegen && tsc`. Typegen is not optional: route
module types live in `.react-router/types/**`, which `tsconfig.json` lists in
`include` and `rootDirs`.

**`npm run build` is not a typecheck** — Vite/esbuild transpiles without checking.
Pass 12 recorded two self-inflicted bugs a green build waved through and `tsc`
caught. `tsconfig.json` is `strict` + `noUnusedLocals` + `noUnusedParameters` +
`verbatimModuleSyntax` + `erasableSyntaxOnly`. Excluded: `data`, `docker-data`,
`build`, `node_modules`, `tools/oxlint/anti-slop`.

### 1.5 Lint — version pin and the delta rule

`.oxlintrc.json` loads the repo's **own** plugin
(`jsPlugins: [{ name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" }]`)
and enables all 15 generic rules at `"error"`: `no-chained-type-assertions`,
`no-conditional-empty-object-spread`, `no-known-value-widening`, `no-module-mocking`,
`no-object-parameters`, `no-reflect-apply`, `no-reflect-get`, `no-runtime-typeof`,
`no-shape-in-symbol-names`, `no-unknown-parameters`, `no-unknown-returns`,
`no-unknown-type-aliases`, `no-unsafe-dictionary-type`, `no-widen-then-assert`,
`require-safety-comment-for-type-assertion`. Source: `tools/oxlint/anti-slop/rules/`
(the `effect/` sub-plugin exists but is **not** registered). It was installed from
`.claude/skills/install-anti-slop/`, whose `assets/anti-slop/` tree is the same rule
set — that skill is upstream, the repo copy is the vendored install.

**Version pin trick.** A worktree has no `node_modules`, so `npm run lint` prints
nothing and "passes" — the baseline is a lie. Restore without touching the lockfile:

```sh
npm i --no-save oxlint@1.79 @oxlint/plugins@1.79
```

Both must match. Installed today: 1.79.0 / 1.79.0.

> **Never run that while a background `vitest run` is in flight.** Mutating
> `node_modules` mid-run produced **688 phantom test failures** (2026-08-26).

**Lint-delta-vs-main rule** (controller pass, 2026-08-30): judge lint by **delta
versus `main`, not absolute zero.** Measured live this session on `main`:

```
npm run lint → 25 errors, 3 warnings, exit code 1
```

All 25 are pre-existing, mostly `app/server/**` and `*.server.test.ts`. Acceptance
is **delta 0** — same 25, none in files you touched. To compare, do **not**
`git checkout HEAD -- app`: that gesture ate an uncommitted fix in pass 28.

> ⚠️ **Doc drift.** `docs/testing.md`, `docs/testing-quickstart.md`,
> `CONTRIBUTING.md:62` and `README.md:83` all say lint "must exit 0" with "no
> suppression list or accepted-findings allowlist". True at ruling 86 / R21-3
> (2026-08-19); **false today**. See §7.

Related: `doctor.config.ts` (react-doctor, run via `npx`, not a dependency) ignores
`design/`, `.claude/`, `data/`, `*.server.test.ts`, `tools/oxlint/`, `test-support/`,
`planning/`. react-doctor's **bundled** `anti-slop` plugin duplicates this repo's own
rules, so every `anti-slop(*)` hit it reports on `app/` is the same oxlint-25
baseline — triage it there, not twice.

### 1.6 E2E — production image only

Owner policy 2026-08-02: **anything that serves the app for a test runs the
production image, never a dev server.** `playwright.config.ts` enforces it by
throwing at config load when `VIBERR_E2E_BASE_URL` is unset.

`scripts/e2e.ts`: `down --volumes --remove-orphans` (clean slate after a crash) →
`up --build --detach --wait --wait-timeout 300` (a `seed` one-shot writes the demo
fixture onto a fresh named volume `e2e-data`, then the final-stage image boots) →
`docker compose port app 3000` derives a random loopback port → poll
`/resources/health` up to 60s (a Zod `.catch()` means an error body, a proxy's HTML,
or a half-started reply all read as "not up yet") → `npx playwright test` with
`VIBERR_E2E_BASE_URL` → `down --volumes` in a `finally`.

```sh
npm run e2e                                  # full suite
npm run e2e -- e2e/01-home-board.spec.ts     # args pass through
VIBERR_E2E_KEEP=1 npm run e2e                # keep the stack up to debug
```

`compose.e2e.yml` never touches `compose.yml`'s project, `.env`, `./docker-data`, or
any host credential — synthetic secrets only (`x-e2e-env`: fixed session secret,
base64-of-32-zero-bytes key, shared so the app can read what the seed wrote). The
`seed` service builds `target: build`, because `test-support/` deliberately never
ships in the final image; it seeds as root then `chown -R 1000:1000 /data`. Restart
tests must pass `--no-deps` so the seed cannot re-run.

**One browser**: `chromium` / `devices["Desktop Chrome"]`, plus a `setup` project
that is a login fixture, not a browser. `fullyParallel: false`, `workers: 1` (shared
seeded store), `timeout: 45s`, `expect.timeout: 10s`, `trace: retain-on-failure`.
The PRD's matrix also names Safari and Firefox; **neither has ever been run here**
(pass 21, U6) — declared support, not coverage.

### 1.7 :5173 (docker) vs :5174 (hermetic) — the single-writer rule

`.claude/launch.json` has two configs, and the difference is data safety:

- **`viberr-dev` → :5173**, `VIBERR_DATA_ROOT=…/viberr/docker-data`. Its command
  **refuses to start** when `viberr-app-1` is running: *"SQLite WAL over a bind mount
  tolerates ONE writer per data root (host+container dual writers have eaten PATs and
  run logs before)."*
- **`viberr-dev-hermetic` → :5174**, `VIBERR_DATA_ROOT=$PWD/data`. Every recent pass
  live-validated here.

**One app process per data root, ever.** A host dev server and a compose container
sharing `docker-data` over VirtioFS clobbered the WAL and lost users, encrypted PATs,
notifications and run logs — while `PRAGMA integrity_check` passed before *and*
after, because it does not detect lost transactions.

Enforced in code (`app/server/db/cli-lock.server.ts`): `bootServer()` has held the
data-root lock since F18-5, and every **writing** CLI (`seed`, `seed:demo`, `rescan`)
goes through `runWithDataRootWriterLock` and fails **closed** naming the holder.
Read-only CLIs (`backup`, `store:check`, `keys -- status`) deliberately do not take
it and open the projection read-only. `compose.yml` pins `hostname: viberr` (B-FD1)
so a recreated container reclaims its own leftover lock, sets `init: true` (F20-2,
reaping chromium/crashpad zombies), and forces `NODE_ENV=production` /
`VIBERR_DATA_ROOT=/data` over `.env`.

---

## 2. The meta-gates

Four files assert properties of the *source*, not of runtime behaviour. Ran green
this session: **4 files, 109 tests, 659 ms.**

### 2.1 `app/app.css.test.ts` (2,584 lines)

`app/app.css` is the app's only stylesheet. Nothing checks CSS the way `tsc` checks
TypeScript — an undefined token or class is silently dropped, so the page still
renders, just wrong. What it locks:

- **Tokens**: every `var(--x)` resolves to a declared token, reported **by name, not
  count** (P13-D-18: 11 undefined tokens, 7 without fallback, killed a whole panel's
  border and background).
- **Classes**: every `className` literal anywhere in `app/` has a rule behind it —
  it **scans the tree, not a hand list** (P13-D-19 shipped a four-name hand list; the
  next nine orphans survived three passes).
- **Contrast**, computed from the sheet's own hex literals: `--faint` /
  `--placeholder` ≥ 4.5:1 on `--surface` in both themes and over the 4% `--fg` tint
  and `--blue-soft` fill; the `--muted > --faint > --placeholder` subordination; the
  primary CTA and its hover; `--border-control` at 3:1. Plus a **whole-sheet sweep**
  (R19-12) resolving every pair the sheet paints in both themes at 4.5:1 text / 3:1
  large text and meaningful glyphs.
- **Responsive honesty**: no interactive element is removed under a width query (a
  component boundary is treated as opaque, and "renders no control" claims are
  re-proved against each component's own file); `app/` gates no *rendering* on the
  viewport (`matchMedia` for user preferences only); breakpoints come from one named
  map, each declared once and each actually used.
- **Type scale (pass 30)**: 13 steps — `.62 .68 .74 .8 .86 .92 .98 1.05 1.18 1.3 1.5
  1.7 1.9` rem. Every `font-size` must be one (or `0` / `inherit`). Only weights the
  loaded fonts ship (`400 500 600 700 800 inherit`); `font-weight: 800` is legal only
  where the display face (Manrope) resolves or an `h1`–`h4` is selected — 800 on a
  body/mono rule silently clamps.
- **Other**: one `:focus-visible` ring wrapped in `:where()`; one select base rule;
  static styling lives in the sheet, not JSX `style={{…}}` (census capped at **24**
  sites); no style object may restate a utility class's declarations.

**"No allowlist" is structural, not claimed.** Every exemption bucket is empty or
rot-checked: `CLASSLESS_BY_DESIGN = {}` (capped ≤ 3), `UNFIXED_BELOW_AA = {}`
(**emptied by pass 30**), `BELOW_AA_BY_DESIGN` = 2 entries each citing a WCAG clause
(`.pj-star.on` under 1.4.11; `.log-more:disabled` under 1.4.3's inactive-component
exemption). Baselines are asserted as an **exact set**, so *fixing* a pair fails
until its line is deleted — a `toBeLessThanOrEqual` ceiling was rejected explicitly:
"that is how a baseline becomes a suppression file." Every exemption's `why` must be
**> 60 characters** — a label is not a reason. Stale entries fail their own rot guard.

**Gates to update when touching these areas** (pass-30 record): the breakpoint map,
the inline-style cap (24), the `.fine` font-size pin (`.74rem`), the select border
pin (`--border-control`), and "no style object restates a utility" — a spacing snap
can create accidental collisions; move the inline declaration into a class.

> **Gap found this pass.** Memory records pass 30 as locking "type/spacing/radius
> scales". Only the **type** scale has an automated lock. The 6-step radius family
> (`--radius-small|button|box|chip|card|panel`) and the spacing snap live only in
> `app.css` comments: **47 of 226 `border-radius` declarations are still literals**
> (31 × `50%`, plus `2px`, `3px`, `4px`, `.3rem`). Nothing stops a new
> `border-radius: 7px`. `app/app.css.test.ts:2541` is the template to close it.

### 2.2 `app/features/copy-ban.test.ts` (1,031 lines)

**(a) The `govern*` ban (F18-14).** `/\bgovern(ance|ed|or|ors|ing|s)?\b/i`. Source:
`design/CONVERSATION-SUMMARY.md:22` — use *Maintainer*, *Permissions*, *managed*. The
ban is about copy a **human reads**, not agent system prompts. Three scans, split by
**syntax** not importance (`.tsx` cannot be lexed as TypeScript — `</div>` reads as
an unterminated regex):

| Scan | Roots | Method |
| --- | --- | --- |
| Render | `app/features`, `app/routes`, `app/ui` + `root.tsx`, `entry.client.tsx`, `entry.server.tsx`, **`app.css`** | line-wise |
| Literal | `app/server`, `app/schemas`, `app/shared`, `app/lib` + `app/routes.ts` | hand-written lexer, **every string literal** |
| Assets | `app/server/seed/assets/**` | line-wise, `ALLOWED_ASSET_LINES` by name |

`app.css` is in scope because a stylesheet renders copy through `content:`.

This gate's design is the repo's best lesson in gates that hold:

- **Coverage is an assertion.** Every entry `readdirSync(app/)` returns must be claimed
  by a scan or named in `IGNORED_ENTRIES` (**empty today**). A verifier planted the word
  in a new top-level directory *and* a new top-level `.tsx` and the suite stayed green —
  the same hole had already produced this finding twice (`app/schemas`, then `app/ui`).
- **An exemption covers the marker, not the line.** `redact()` cuts allowed markers out
  (longest first) and scans what remains. A line-granular allowlist let a verifier append
  `const hole = "Off the governed path — ask a Maintainer.";` to a line already
  containing `isGoverned`.
- **Allowlists are rot-checked.** Five of nine render entries suppressed nothing — `\b`
  already fails against `GOVERNED_` / `isGoverned`. Four survive: `const governed =`,
  `governed.{direct,recommend,forbidden}`.
- **The comment stripper is one alternation, one left-to-right pass**, with its own test.
  Two sequential passes blind the gate in *both* directions (block-first: a `//` comment
  mentioning `app/server/**` blanks every line to the next `*/`; line-first:
  `/* note // see above */` leaves an unterminated `/*`). Both found by canarying.
- **No rendered-copy exception** — the login tagline had "governed" removed at design
  time and is not allowlisted.

**(b) Em/en dash ban (P21, owner 2026-08-20).** `/[–—]/`.
- Scope is the **render roots + seed assets only**. `app/server/**` prompt machinery
  is deliberately ungated — model-addressed prose where a dash harms nobody, and
  gating it would need a hundred-entry allowlist that rots.
- **Legal:** the middle dot `·`, the minus sign `−` (U+2212), arrows `→` — typography
  for counts and direction, not prose punctuation. **Comments keep their dashes.**
- `DASH_ALLOW = []` on purpose, with an instruction in the source: *"Do NOT grow it to
  keep a red build green — reword the sentence instead."*
- Rationale: dashes are the most reliable tell of machine-written prose, and this
  app's copy was written entirely by models.

**(c) Retired `primary specialist` vocabulary (F19-12).** `/primary specialists?\b/i`
over `app/features`, `app/routes`, `app/server`, `app/shared` — wider than the dash
ban because these strings are built **server-side** and rendered verbatim. One allowed
marker: the capability **id** `assign-primary-specialist`, stored in every
`project.md` and never rendered.

### 2.3 `app/features/retired-vocabulary.test.tsx` (357 lines)

Sibling to (c), deliberately separate because **the two bans have opposite exemption
rules**: `govern*` is *exempt* in prompt text; "primary specialist" is at its **worst**
there — the developer skill doc is mounted natively into every developer run, so it
*teaches* the retired model to the agent, which speaks it back into the timeline.

Every case asserts the **shipped artifact**: the seeded `.md` assets on disk (with a
non-vacuity check that `developer-expertise.skill.md` and `reviewer-expertise.skill.md`
are in the set); the skill as materialized by `seedDefaultAgentAssets` into a temp
data root; the seeded Task-contract KB doc; `GOVERNED_TEMPLATE`'s `ready → impl`
rationale (rendered on Policy *and* persisted into every new `project.md`); and
`renderToString` HTML for `OperatorRecommendations`, `LiveRoster`, `AgentStats`,
`CapabilityMatrixModal`, `ProfileDetail`. Each also **pins the surrounding copy**, so
"deleted" and "fixed" are not the same green.

### 2.4 `app/features/toast-honesty.test.ts` (219 lines)

Rule (`docs/architecture/decisions.md` §UI porting rules): *a failure toast must not
render the success tick — pass the toast kind explicitly.* The icon is the whole
signal (both kinds paint `var(--fg)`; only the glyph differs — `app/ui/toast.tsx`), so
a refusal on the default `"success"` kind renders a green check over "that was
refused." The rule was written down and ~10 sites violated it.

A **character scanner** (not a regex) strips comments while preserving strings;
`extractArgs` walks balanced parens; `stringLiterals` pulls each literal. Flagged when
a literal matches `REFUSAL` and no quoted `"error"` appears anywhere in the call.
Precision by design: only **string-literal** messages (`push(d.toast)` routes through
`useActionToast`/`useOrgAction`, which already pass `"error"`); the ternary form
`push(cond ? … : …, cond ? "success" : "error")` passes. **The gate self-tests** —
`"catches a planted violation (the gate actually bites)"` runs four synthetic sources
through the matcher. Its docblock ships a canary instruction: drop the `, "error"` from
connections-panel's *"Set another connection as default first"* and it goes red.

---

## 3. Seed and demo data

### 3.1 Two seeds, not interchangeable

| | `npm run seed` (`scripts/seed.ts`) | `npm run seed:demo` (`scripts/seed-demo.ts`) |
| --- | --- | --- |
| Purpose | **product** baseline, clean sheet | **test/dev-only** mock dataset |
| Ships | agent catalog, KBs, skills, bootstrap admin | arda & co, `viberr-core` + 2 stub projects, VIB-139…168 with full timelines, Arda's inbox, org resources |
| Admin | `admin@viberr.dev` / `SEED_DEFAULT_PASSWORD` (override with `VIBERR_SEED_ADMIN_EMAIL` / `_PASSWORD`) | `arda@viberr.dev`, same password |
| Reset | `-- --reset` wipes board + derived state | `-- --reset` calls the product seed's `resetStore` first |

`SEED_DEFAULT_PASSWORD = "viberr-dev-2828"` (`app/server/seed/seed-credentials.ts:12`).
Demo users: `arda|elif|murat|selin|deniz @viberr.dev` (`test-support/demo-data.ts:84-89`).

The product seed has shipped none of the demo data since the owner ruling of
2026-07-24. With no seed at all, an empty users table makes the server mint the same
bootstrap admin at boot (random password logged once).

`scripts/seed-demo.ts` imports `test-support/demo-seed` **dynamically**, because
`test-support/` never ships in the production image; the catch block prints the real
error *then* the "dev-only" message (P13: the guard used to swallow the reason).

`test-support/demo-seed.ts` is idempotent — users upsert by email, files overwrite,
`rebuildAll(db, { force: true })` reconciles projections (forced, because renames
change actor snapshots without changing file hashes), and notification /
scope-violation / user-pref rows use deterministic ids with `INSERT OR IGNORE`, so a
re-seed keeps a resolved violation resolved and a user's own pins. One deliberate
divergence: the fixture pins the **Developer profile to Codex** (`backends:
["codex","claude"]`, `model: "gpt-5.6-terra"`) while the product catalog defaults to
Claude — so the mock dataset still exercises both backends, the Codex delivery path,
the "Codex" actor glyphs and the live-backend-overlay drift scenarios.

### 3.2 Two sanctioned ways to build test state (`docs/testing.md`)

1. **Through the product's own actions** — `createTask`, `transitionStage`,
   `assignSpecialist`, `resolvePacket` on a minimal store from
   `test-support/test-store.ts`. **Prefer this for behaviour tests**: state built by
   the real writers cannot drift from what the product does. `setupTestStore(ctx)`
   gives a temp root + migrated DB + five users with distinct project roles
   (arda→project admin, murat→maintainer, selin→contributor, elif→viewer,
   deniz→registered non-member).
2. **The demo fixture** — legitimate coverage, because a hand-written canonical file
   is a **real input class** here (the store is human-editable by design). Two drift
   guards in `app/server/seed/demo-fixture.test.ts`: every fixture file parses with
   **zero unknown frontmatter** and round-trips the current serializers, and a task
   written by the real `createTask` lands just as clean. Migrate the fixture in the
   same change that breaks them.

**Documented residual risk:** a field the schema still *knows* but the product no
longer *writes* passes both guards. That class is caught by full product passes, not
automation.

### 3.3 `test-support/` helpers

- **`test-db.ts`** — `createTestDbContext()` → `makeDb()` (temp dir + migrated DB),
  `makeTempDir()`, `cleanup()`. Pair with `afterEach(ctx.cleanup)`.
- **`test-app.ts`** — `setupAppTest()`: temp data root, env + db singleton reset,
  **fake runtime installed**, `cookieFor()`, `csrfFor()`, `request()` with
  trusted-origin headers. **Import route modules *after* it** (dynamic import) so
  their graph reads the overridden env; every form needs `_csrf`. It fails **closed**
  on the runtime — without `installFakeRuntime()` a test reaching `autoInvokeOperator`
  either constructs a real adapter (a paid call from `npm test`) or reports
  "unavailable" and drives an async failure escalation that races the assertions.
- **`fake-runtime.ts`** — queued `FakeRun`s per backend, plus `startedRunSpecs()` so a
  test can assert what a path **sent** (prompt, denylist, mounted MCP servers).
- **`fake-github.ts`** — canned `fetchImpl`, routes keyed `"METHOD /path"`; responders
  may be functions of the recorded call (first-call-fails retry tests). **No live
  GitHub calls in tests** — every service takes a `fetchImpl` injection.
- **`custom-board.ts`** — `CUSTOM_3_STAGE_BOARD`, kept after the "Lightweight" template
  was deleted so non-default-stage-id behaviour keeps coverage without the product
  shipping an unworkable preset.
- **`audit-log.ts`** — raw `audit_events` reader (production reads the display query).

### 3.4 A clean instance

```sh
VIBERR_DATA_ROOT=$(mktemp -d) npm run seed:demo            # scratch, no docker
rm -rf ./data && npm run seed:demo -- --reset             # the :5174 hermetic root
```

Docker: `docker compose up --build -d` then `docker compose exec app npm run seed`.
Stop the container before any host-side seed on `docker-data` — the lock refuses anyway.

### 3.5 Re-baselining the projection DB

**(a) Documented wipe** (`docs/operations/deployment.md`). Boot prints a `projection
schema drift` **WARN** when `task_projections` CHECK constraints no longer admit every
value the running build produces (F21-1); migrations are squashed and forward-only, so
a root opened by an older build keeps its old constraint.

```sh
npm run backup                              # FIRST
docker compose down                         # one writer per root
rm ./docker-data/state/projection.sqlite*   # -wal and -shm too
docker compose up -d
```

**Name the cost.** The projection *tables* rebuild from `projects/`, but the file also
holds rows that exist nowhere else: users and better-auth credentials, sessions,
**AES-sealed PATs and MCP credentials**, the audit trail, notifications, org resources,
run history. `projection.sqlite` is **never** "safe to delete." A `projects/`-only
restore does not degrade gracefully either: surviving files still carry the **old**
user ids in `members[].userId` / `ownerUserId`, which resolve to nobody, and there is
no re-mapping tool.

**(b) Preserve-copy re-baseline** (controller pass, 2026-08-30) — the wipe loses users
and PATs. This variant creates a **fresh schema** and does a **column-intersection
copy** of the users / auth / PAT / org tables with **foreign keys OFF**, keeping the
root's credentials. **No script exists in the repo**; the shape lived in a session
scratchpad. If pass 31 touches the schema, land it under `scripts/`.

**(c) Hermetic-data copy** (pass 30) — a realistic :5174 root without becoming a second
writer: `rsync docker-data → data` minus the `workspace/` dirs, `sqlite3 .backup` for
`projection.sqlite` (not `cp`, because of the WAL), delete `writer.lock`.

### 3.6 Read-only ops tools

- `npm run store:check` — the **store doctor**. Parses every canonical file and names
  the ones the app can no longer trust, with the parse error and the offending line.
  Exists because parsing is deliberately tolerant: nothing throws, so `npm run rescan`
  reported `0 errors` over a file whose fields had all silently fallen back to
  defaults. Read-only, DB-free, no lock, **exit 1 when any file is untrusted** — can
  gate a deploy or a cron.
- `npm run rescan [-- --force]` — takes the writer lock; while the app is up, use Home
  → store strip → "Re-scan store" instead.
- `npm run backup` / `npm run restore -- --from <artefact> --file <path>` — read-only
  (a backup that refused to run on a live instance would be no backup).

---

## 4. E2E patterns and jsdom traps

### 4.1 The suite

- `auth.setup.ts` — login through the real `/login` UI → `e2e/.auth/arda.json`.
- `01-home-board` — Home projects, stage columns, dnd-kit (same-stage reorder,
  cross-stage append, Escape-cancels-lift, Done-stage confirm + verdict gate).
- `02-feeds-profile` — review queue, activity day-grouping, mark-all-read, theme.
- `03-org-settings-store` — settings tabs, heading scope (R15-13), **a real
  file-store `mkdir` through the UI**.
- `04-palette-mobile` — ⌘K palette, board filter scoping, 375px rail collapse,
  non-member 404 (R15-4), touch targets.
- `05-task-comment-composer` — Lexical: Enter vs ⌘+Enter, @-mention keyboard and
  click insert, Escape, undo-after-post, combobox a11y.
- `06-activity-hydration` — React #418 under `test.use({ timezoneId: "Pacific/Auckland" })`.
- `07-accessibility` — axe over 12 surfaces + 3 dialogs **in their open state**, both themes.

### 4.2 Login fixture — the pre-hydration trap

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

**The inputs are React-controlled: a fill that lands before hydration is wiped when
React takes over.** Hence `networkidle` plus a `toPass` retry of the *whole* login. For
ad-hoc scripts, wait `networkidle` **plus ~1 s** before filling.

### 4.3 The Playwright driver on :4999

When the Browser pane wedges (hidden, 0×0 viewport, stale composite, scroll timeouts —
seen in passes 20, 29, 30), the working fallback is a **persistent ad-hoc Playwright
driver**: a scratchpad `driver.mjs` running an HTTP command server on **:4999**,
driving real chromium against the hermetic :5174 server. Two details matter:

- Import playwright by **absolute path**
  (`/Users/akinozer/projects/viberr/node_modules/playwright/index.mjs`) — **ESM ignores
  `NODE_PATH`**, so a bare `import "playwright"` from a scratchpad file fails.
- `page.fill` + `click` works headless for login; the Browser pane's own classifier
  blocks typed passwords, and a pane-synthetic Escape is **not** a native `<dialog>`
  cancel (close via backdrop click instead).

### 4.4 Hermetic e2e patterns

- **Timezone pinning** keeps `06-activity-hydration` discriminating even when the host
  runs in UTC (CI); Auckland also pushes most timestamps across a **day** boundary,
  exercising the day-bucket regroup, not just clock text. The spec listens on
  `page.on("pageerror")` and asserts an empty list.
- **Theme cookie** (`viberr_theme`) is set directly to audit both themes without
  clicking through the UI.
- **Axe rule set is `wcag2a` / `wcag2aa` / `wcag22aa` only** — best-practice rules are
  opinions, and failing CI on an opinion trains people to ignore the gate.
- **Serial by construction** — `workers: 1`; the specs share one seeded store.
- A same-tick toggle+save inside `page.evaluate` **races React**: click, settle, save
  separately.

### 4.5 jsdom / vitest traps

1. **`vi.spyOn` on an already-spied method returns the SAME mock with accumulated
   calls** — `mockClear()` before asserting absence.
2. **A module-level crash shows up as a FAILED FILE with zero failed tests.** Grep for
   suite-level errors, not just test counts (`agents-page.test.tsx` slipped a triage).
3. **ESM ignores `NODE_PATH`** — ad-hoc scripts must use absolute `node_modules` paths.
4. **`// @vitest-environment jsdom` is per file**; the default env is node.
5. **jsdom never simulates `showModal()` focus stealing** — a bug where `showModal()`
   steals focus right after `autoFocus`, firing `onBlur → setTouched` on first paint,
   is invisible to it (pass 30, board new-task modal opened red).
6. **`data()` throws a `DataWithResponseInit`, not a `Response`** — assert
   `thrown.init?.status`; loaders need a thrown `Response`, not an `AppError`. And
   `init?.status ?? status` is a trap — `AppError` also has `status`.
7. **Lexical jsdom tests**: drive via `ce.__lexicalEditor` inside an async `act` —
   updates commit in microtasks.
8. **`useDialog` reads computed `transition-duration`**, which is 0/NaN in jsdom and
   under `[data-motion="reduce"]`, so close is synchronous and tests stay green.
9. **Restoring a canaried file via `mv` rewinds mtime**, so vite/vite-node dep caches
   serve **stale** transforms (vitest is fine; a running dev server is not).
10. **Known flake**: `app/features/notifications/notifications-route.server.test.ts` —
    an in-flight operator drive writes into the temp root while `cleanup` `rmSync`s it
    (ENOTEMPTY). All its tests pass; only teardown fails, intermittently.
11. **Test seams are idiomatic here** (`resetOperatorLeasesForTests`,
    `configureRunServiceForTests`) — exporting a private function to pin an invariant is
    accepted practice, not a smell. Note `anti-slop/no-module-mocking` is on, so module
    mocking is **not** the alternative.

---

## 5. Canary discipline

**Canary every test by actually reverting the fix, and check it fails for the RIGHT
reason.** Re-learned in passes 15, 17, 19, 30 and the 2026-08-30 bug sweep.

**Why it keeps mattering.** In the bug sweep, **five** of the author's own regression
tests passed against *unfixed* code: `init?.status ?? status` (AppError also has
`status`); `indexOf` comparisons where an absent entry is `-1`; fixtures whose two
derivations happened to agree; a stale claim the tick re-stamps anyway; and a
queued-start test where the **fake runtime made the start succeed**. Pass 15 recorded
three vacuous "proving" tests from the same cause. A test never watched failing is not
evidence.

**The `git checkout` trap.** `git checkout <file>` for a canary **wipes all uncommitted
work on that file** — it cost two fixes in pass 17 (D1 pr-open, then all of D3's
task-actions edits) and an uncommitted refinement in pass 28 (via
`git checkout HEAD -- app` for an oxlint base compare). **Commit before canarying, or
neuter the specific line by hand.**

**The verifier trap: verifiers read the WORKING TREE.** Fixing while verification runs
makes adversarial agents refute their colleagues' *true* findings — "the code state it
describes is already gone." **Six of the first seven refutations** in the bug sweep were
this artifact. **Judge those by the canary, not the verdict.** Freeze the tree during
verification, or hand verifiers a pinned revision.

Corollaries for pass 31:
- The sweep found a bug **in its own fix** (a goal `attention` un-parked on the absence
  of a failed link, oscillating every 60 s and re-notifying). Narrow an un-park to the
  cause the same pass watched disappear.
- Over-correction is real: routing a delivery flag through `resolveDeliveryPermissions`
  wholesale flipped headline-only profiles too. Target the reported state precisely.
- Fixes come in **families** — the 2026-08-31 review of PR #248 found ~12 of 15 findings
  were **siblings** the sweep's own fixes left exposed. **Grep every sibling when fixing
  a class.**
- `qa/pass2*-canary.md` are **artifacts left by live agent runs** (e.g.
  `qa/pass25-canary.md`: "Pass 25 QA canary - safe to delete"), not testing docs.
  `qa/smoke/README.md` defines the pass-note format for live smoke evidence.
  `test-artifacts/`, `test-results/`, `playwright-report/` are gitignored run output.

---

## 6. CI

`.github/workflows/ci.yml` — two jobs on `push`/`pull_request` to `main`,
`ubuntu-latest`, `node-version: 26`, npm cache:

- **`verify`**: `npm ci` → **Lint** → **Typecheck** → **Unit + integration tests** →
  **Build**. Lint runs **first** deliberately (ruling 86 / R21-3, pass 21).
- **`e2e`**: `npm ci` → `npx playwright install --with-deps chromium` → `npm run e2e` →
  uploads `playwright-report/` on failure (7-day retention).

`playwright.config.ts` branches on `CI`: `forbidOnly: true`, `retries: 1`,
`reporter: [["list"], ["html", { open: "never" }]]`.

> ### ⚠️ GitHub Actions is BILLING-BROKEN (2026-08-30, unchanged 2026-08-31)
>
> **CI jobs never start.** There is no run to read — the failure surfaces as a
> repository **annotation**, not a job log. So:
>
> - **Read the annotations** when a PR shows no checks.
> - **CI cannot gate any branch.** PR #248 merged on local gates only; every pass since
>   #230 has recorded gates as **LOCAL**.
> - **The local gate set is the real gate set**, run in full before calling a branch
>   mergeable:
>
>   ```sh
>   npm run typecheck    # clean
>   npm test             # full suite green (4,666 at last count)
>   npm run lint         # delta 0 vs main (25-error baseline)
>   npm run build        # production build clean
>   npm run e2e          # needs docker; the only real-CLI gate
>   ```
>
> `CONTRIBUTING.md:74` still says "CI must pass … before a PR is considered mergeable."
> That is currently unsatisfiable.

---

## 7. Open items for the implementation phase

1. **Lint docs contradict reality.** `docs/testing.md`, `docs/testing-quickstart.md`,
   `CONTRIBUTING.md`, `README.md` claim `npm run lint` must exit 0 with no accepted
   findings. Measured: **25 errors, 3 warnings, exit 1.** Clear the baseline or write
   the delta rule into the docs — leaving it is how a stated gate becomes folklore.
2. **No spacing or radius scale gate** — type scale only; 47 literal `border-radius`
   values remain. `app/app.css.test.ts:2541` is the template.
3. **The preserve-copy re-baseline has no script**; it exists only as a description.
4. **`scripts/` has no unit coverage by design** — accepted, but it already cost one
   shipped regression.
5. **Safari and Firefox are declared support with zero coverage.**
6. **CI is unusable** — until billing is fixed, §6's local list is the contract.
