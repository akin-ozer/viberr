# Testing

> The gates, what each one actually runs, the harnesses under `test-support/`, and how
> test state is built. Source of truth: `vitest.config.ts`, `playwright.config.ts`,
> `scripts/e2e.ts`, `compose.e2e.yml`, `.github/workflows/ci.yml`, `test-support/*`.
> Verified against `main` @ `68b5480` (2026-09-01); §2 and §4 re-verified 2026-09-02
> against `pass32/implementation` @ `478bed0`. Requires Node 26+ and `npm ci`.
> Updated 2026-09-02 for ruling 121 (branch `claude/per-user-codex-auth-difdnn`): the
> `setup-env.ts` list, the `backend-credentials` harness and the fake-binary sign-in
> harness.

## 1. The five gates

```sh
npm run lint        # oxlint + vendored anti-slop plugin; must exit 0
npm run typecheck   # react-router typegen + tsc
npm test            # vitest, app/**/*.test.{ts,tsx}
npm run build       # production build
npm run e2e         # playwright against the production Docker image (Docker required)
```

CI (`.github/workflows/ci.yml`, push and PR on `main`) runs two jobs: `verify` = `npm
ci` → lint → typecheck → test → build on Node 26; `e2e` = `npm ci` → `npx playwright
install --with-deps chromium` → `npm run e2e`, uploading `playwright-report/` for 7 days
on failure. No secrets are needed: the unit setup file seeds synthetic ones and
`compose.e2e.yml` carries its own.

## 2. Unit and integration suite (Vitest)

- `include: ["app/**/*.test.{ts,tsx}"]`, `environment: "node"`, jsdom per file where
  a component test needs it. `db/` and `scripts/` are not collected; cover script
  behaviour by extracting it into `app/` (the CLIs are thin wrappers over `app/server`
  modules) or through e2e.
- `test-support/setup-env.ts` seeds `VIBERR_SESSION_SECRET` and
  `VIBERR_SECRET_ENCRYPTION_KEY` (`??=`) and **blanks the ambient vendor keys a dev machine
  or CI host might carry** (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`,
  `ANTHROPIC_AUTH_TOKEN`, `CODEX_ACCESS_TOKEN`, `CODEX_API_KEY`, `OPENAI_API_KEY`, plus
  `VIBERR_BROWSER_EXECUTABLE`), assigning `""` rather than deleting, because
  `loadEnvFile()` runs later and would refill a deleted key from someone's `.env`. This is
  belt and braces: `filteredSpawnEnv()` strips every one of them by regex anyway, and the
  risk it guards against is a paid provider call from `npm test`. Then
  `GIT_ALLOW_PROTOCOL=file` so nothing can clone over the network. It does **not** set
  `VIBERR_DATA_ROOT`; every harness below uses its own `mkdtemp` root, so `VIBERR_DATA_ROOT=$(mktemp -d) npm test` is unnecessary unless you write a harness-less test that calls `getEnv()`.
  *(Corrected 2026-09-02, ruling 121 — the file used to blank `VIBERR_CLAUDE_USE_CLI_AUTH`
  / `VIBERR_CODEX_USE_CLI_AUTH` and point `CLAUDE_CONFIG_DIR` / `CODEX_HOME` at empty temp
  dirs. Those variables no longer exist: a run reads its home from the credential
  principal's `runtimes/users/<id>/…`, which every harness roots in its own temp data root,
  so there is no ambient path left for a probe to find.)*
- **Availability is now a fact about a PERSON, so a test seeds it like data.** There is no
  `setBackendAvailability` any more. `test-support/backend-credentials.ts` gives
  `connectFakeBackend(db, userId, backend)`, `connectFakeBackends(db, userId)` and
  `disconnectFakeBackend(db, userId, backend)`, which go through the REAL
  `setBackendApiKey` / `disconnectBackend` with an injected `fetch` that answers 200
  without a socket, so a test cannot end up with a row shape the product would not produce.
  `fakeBackendSecret(backend)` returns the plaintext those helpers seal, which is what a
  redaction test asserts on. Connect the backend for the run's PRINCIPAL: the task owner
  for a task run, the asker for a controller turn.
- `test-support/setup-dom.ts` polyfills `<dialog>` `show/showModal/close` and stubs
  `ResizeObserver` under jsdom.
- No `.env` is required.

### Harnesses

| Module | Gives you |
|---|---|
| `test-db.ts` | `createTestDbContext()` → migrated temp SQLite, `makeTempDir()`, `cleanup()` |
| `test-store.ts` | `setupTestStore(ctx)` → temp data root + project `viberr-core` (governed template, prefix `VIB`, no agents) with users arda (org admin, project admin), murat (maintainer), selin (contributor), elif (viewer), deniz (non-member); `writeProject`, `writeTask`, `baseTaskFrontmatter` |
| `test-app.ts` | `setupAppTest()` route-level harness: `NODE_ENV=test`, fresh secrets, temp root, env cache reset, fake runtime installed; `cookieFor(userId)` signs in through better-auth, `csrfFor(sessionId)`, `request(url, { cookie, … })` adds `Origin: http://localhost:5173`, `cleanup()` |
| `fake-runtime.ts` | `installFakeRuntime()`, `queueFakeRun({ lines, backend, outcome, keepRunning, sessionId })`, `startedRunSpecs()`, `lastRunSpec()` |
| `fake-github.ts` | `fakeGithubFetch({ "GET /user": spec \| fn })` → `{ fetchImpl, calls, callsTo }`; unmatched → 404; `unreachableFetch()` |
| `demo-seed.ts`, `demo-data.ts`, `custom-board.ts` | the demo fixture (arda & co, three projects, twelve tasks) and its 3-stage custom board |
| `backend-credentials.ts` | `connectFakeBackend(db, userId, backend)`, `connectFakeBackends(db, userId)`, `disconnectFakeBackend(db, userId, backend)`, `fakeBackendSecret(backend)` — the ruling-121 replacement for `setBackendAvailability` |
| `fake-vendor-binary.ts` | `writeFakeVendorBinaries()` → executable `claude` / `codex` stand-ins (mode 0o755) for `deps.binaries`, with `cleanup()`; `setFakeVendorMode("success" \| "fail" \| "hang")`, `setFakeVendorLoggedOut()`, `setFakeVendorLogoutExit()`, `resetFakeVendorEnv()`; the evidence readers `fakeVendorEnv/Argv/Stdin/Terminated/Logout(home)`; `FAKE_DEVICE_CODE`, `FAKE_CLAUDE_URL`, `FAKE_CODEX_URL` |
| `audit-log.ts` | `listAuditEvents(db, { limit, action })` |

Import route modules **after** `setupAppTest()` so they see the test env:

```ts
const ctx = await setupAppTest();
const { action } = await import("~/routes/project.board");
const { cookie, sessionId } = await ctx.cookieFor(userId);
const form = new FormData();
form.set("_csrf", await ctx.csrfFor(sessionId));
form.set("intent", "create-task");
const res = await action({
  request: ctx.request("/projects/viberr-core/board", { method: "POST", body: form, cookie }),
  params: { slug: "viberr-core" },
  context: {},
});
ctx.cleanup();
```

### Two sanctioned ways to build state

1. **Through the product's own writers** (`createTask`, `transitionStage`,
   `assignSpecialist`, `resolvePacket`, …) on a `setupTestStore` root. Prefer this for
   behaviour tests: state built by the real writers cannot drift from the product.
2. **The demo fixture** (`npm run seed:demo` in e2e; `test-support/demo-seed.ts` in
   route suites). Hand-written canonical files are a real input class, so this is
   legitimate coverage, but the loose schemas tolerate unknown keys silently.
   `app/server/seed/demo-fixture.test.ts` trips the wire: every fixture file must parse
   with zero unknown frontmatter and round-trip the current serializers, and a task
   written by `createTask` must land just as clean. Migrate the fixture in the same
   change that changes a schema.

### Doc-pinning tests

- `app/shared/docs/prd-sync.test.ts`: `design/prd.md` must be byte-identical to
  `planning/planning-artifacts/prd.md`.
- `app/shared/docs/file-formats-sync.test.ts`: the `## Packet` section of
  `docs/architecture/file-formats.md` must enumerate `PACKET_OPTION_KINDS` in schema
  order under a "The N kinds:" marker, and every count it states must equal the
  schema's length.
- `app/features/retired-vocabulary.test.tsx`: seeded assets, skills, KB docs and
  templates must not teach the retired "primary specialist" model.
- `app/features/toast-honesty.test.ts`: source scan for actions that could show a
  success tick on failure.
- `app/server/audit/audit-coverage.server.test.ts`: every governed action writes audit.

### Behaviours tests should expect

- Operator narration is stored **verbatim** (no write-time length cap, ruling 104);
  length is handled view-side by `CollapsibleComment`. The other guardrails
  (`meaningful-comment`, `evidence-separation`, `no-duplicate-summary`,
  `compression-threshold`) are enforced per project through `project.md` `guardrails`,
  edited on the Policy page's Guardrails card (ruling 112).
- **A run needs a connected principal, not a flipped switch (ruling 121).** A test that
  wants a real-looking run connects the backend for the person who will pay for it, with
  `connectFakeBackend`. A test that wants the refusal asserts the sentence
  `principalRefusalMessage` produces, for one of three shapes: an unowned task, a disabled
  or deleted owner, or an owner with nothing connected. A refusal writes an honest
  `run·unavailable` error run through the normal completion pipeline, so the packet and
  timeline effects are observable without any process having started.
- **The hosted sign-in is driven by a FAKE BINARY, never a mock.** `backend-login.server.ts`
  takes its vendor binaries through `deps.binaries`, so its tests hand it the pair
  `writeFakeVendorBinaries()` (`test-support/fake-vendor-binary.ts`) writes to a temp dir
  (mode 0o755): a small Node script that prints the vendor's exact lines, waits on stdin for
  the code (Claude) or sleeps and exits (Codex), writes a credential file into the home the
  env hands it, and answers `auth status` / `login status`. That is a real child process over a
  real pipe: URL capture, ANSI stripping, code submission, success rows and audit, failure
  exits, timeouts, cancel and session replacement are all exercised end to end. Each fake
  drops its evidence INSIDE the home it was handed, which is where the assertions read it
  from: `fake-env.json` (the whole child env), `fake-argv.json`, `fake-stdin.txt` (Claude
  only, proving nothing but the code reached stdin) and `fake-terminated.txt`, written from
  a `SIGTERM` handler so a test can prove a replaced or cancelled child really died instead
  of being orphaned. The same pair serves the credential store's DISCONNECT tests: the
  vendors' `logout` branches drop `fake-logout.json` (argv plus the whole child env), so
  `backend-credentials.server.test.ts` proves the vendor's own logout ran, ran against the
  home that call named, and saw no credential of the server's — one fake vendor in the
  repo, not two. `no-module-mocking` is a lint rule (no `vi.mock`), and a mocked spawn
  would prove nothing about the parsing this module exists to do.
- Never mutate `node_modules` while `vitest run` is in flight (it once produced 688
  phantom failures).

## 3. Lint

`npm run lint` is bare `oxlint` with `.oxlintrc.json`: it ignores agent directories,
`design/**` and the plugin's own source, loads `tools/oxlint/anti-slop/index.ts` as a JS
plugin, and sets all 15 `anti-slop/*` rules to `error`. There is no override, allowlist
or baseline file anywhere, so every anti-slop finding fails CI (ruling 86). The rules:

`no-chained-type-assertions`, `no-conditional-empty-object-spread`,
`no-known-value-widening`, `no-module-mocking` (no `vi.mock`; use real seams),
`no-object-parameters`, `no-reflect-apply`, `no-reflect-get`, `no-runtime-typeof`
(decode with Zod instead), `no-shape-in-symbol-names`, `no-unknown-parameters`,
`no-unknown-returns`, `no-unknown-type-aliases`, `no-unsafe-dictionary-type`,
`no-widen-then-assert`, `require-safety-comment-for-type-assertion` (every non-const
`as` needs a `SAFETY:` comment).

A checkout without `node_modules` prints nothing and "passes"; install first. In a
worktree that must not touch the lockfile:

```sh
npm i --no-save oxlint@1.79 @oxlint/plugins@1.79
```

`doctor.config.ts` (react-doctor via `npx`) and `.react-doctor/false-positives.md` belong
to a separate, manual tool, not to the lint gate.

## 4. End-to-end suite (Playwright)

`npm run e2e` runs `scripts/e2e.ts`, never a dev server:

1. `docker compose -p viberr-e2e -f compose.e2e.yml down --volumes --remove-orphans`.
2. `up --build --detach --wait` (300 s): the `seed` service builds the Dockerfile's
   `build` stage (which still contains `test-support/`) and runs `npm run seed:demo` on
   the named volume `e2e-data`; then `app` (the production image, `hostname:
   viberr-e2e`, `init: true`, random host port) starts once seeding succeeded. Both
   services read one `x-e2e-env` anchor in `compose.e2e.yml`, which is where the e2e
   **data root is set** (`VIBERR_DATA_ROOT: /data`) along with the two synthetic
   secrets — seed and app must share them or the app cannot read what the seed wrote.
   Nothing in `playwright.config.ts` or `scripts/e2e.ts` sets the data root.
3. Reads the mapped port, polls `/resources/health` for `200` + `ok:true` up to 60 s.
4. `npx playwright test <args>` with `VIBERR_E2E_BASE_URL`; on failure prints the last
   100 app log lines.
5. `down --volumes` unless `VIBERR_E2E_KEEP=1`. Exit code is Playwright's.

`playwright.config.ts` throws without `VIBERR_E2E_BASE_URL`; `workers: 1`, `retries:
CI ? 1 : 0`, `timeout: 45 s`, trace on failure, `list` reporter (+ `html` on CI). Two
projects: `setup` (logs in as `arda@viberr.dev` through the real `/login`, stores
`e2e/.auth/arda.json`) and `chromium` (Desktop Chrome, depends on `setup`). Chromium is
the whole declared browser matrix (ruling 103).

| Spec | Tests | Covers |
|---|---|---|
| `01-home-board.spec.ts` | 7 | seeded projects, board columns, drag-and-drop reorder and cross-stage moves, Escape cancels, Done-drop shows the accept dialog and still fails the verdict gate |
| `02-feeds-profile.spec.ts` | 5 | review-queue partitions and row labels, activity day groups, mark-all-read, theme cookie |
| `03-org-settings-store.spec.ts` | 3 | org settings tabs, heading scope, store browser creates a folder |
| `04-palette-mobile.spec.ts` | 6 | ⌘K palette, board `?q=`, 375 px rail collapse, non-member 404 copy, touch targets |
| `05-task-comment-composer.spec.ts` | 7 | Lexical composer keys, @-mention, undo, combobox a11y, zero page errors |
| `06-activity-hydration.spec.ts` | 1 | clean hydration in `Pacific/Auckland` |
| `07-accessibility.spec.ts` | 33 generated | axe WCAG 2.2 AA on 12 surfaces × 2 themes, dialogs, mobile rail, login |

62 tests plus the setup project. The e2e gate is the only one that runs a real CLI
entrypoint, and only `npm run seed:demo`: `backup`, `restore`, `rescan`, `keys` and
`store:check` are exercised by no gate.
