# Testing

> The gates, what each one actually runs, the harnesses under `test-support/`, the tests
> that pin docs and config, the lint rules, and the e2e flow. Source of truth:
> `package.json` scripts, `vitest.config.ts`, `test-support/*`, `app/shared/docs/*`,
> `.oxlintrc.json`, `tools/oxlint/anti-slop/`, `playwright.config.ts`, `scripts/e2e.ts`,
> `compose.e2e.yml`, `e2e/*`, `.github/workflows/ci.yml`. Requires Node 26+ and `npm ci`.
> Verified against `main` @ `7d9fbf72` (2026-09-23).

## 1. The five gates

```sh
npm run lint        # oxlint + vendored anti-slop plugin; must exit 0
npm run typecheck   # react-router typegen + tsc
npm test            # vitest run, app/**/*.test.{ts,tsx}
npm run build       # react-router build (production build)
node scripts/measure-routes.mjs --check   # bundle ratchet over build/client (ruling 457)
npm run e2e         # playwright against the production Docker image (Docker required)
```

CI (`.github/workflows/ci.yml`, push and PR on `main`) runs two jobs on `ubuntu-latest`
with Node 26: `verify` = `npm ci` → lint → typecheck → test → build → the bundle ratchet (`measure-routes.mjs --check`); `e2e` = `npm ci` →
`npx playwright install --with-deps chromium` → `npm run e2e`, uploading
`playwright-report/` for 7 days on failure. No secrets are needed: the unit setup file
seeds synthetic ones and `compose.e2e.yml` carries its own.

## 2. Unit and integration suite (Vitest)

- `vitest.config.ts`: `include: ["app/**/*.test.{ts,tsx}"]`, `environment: "node"`,
  `setupFiles: [test-support/setup-env.ts, test-support/setup-dom.ts]`, the tsconfig
  `~/*` alias resolved natively (`resolve.tsconfigPaths`), and one global
  `testTimeout: 20_000` (pinned by `app/shared/docs/vitest-config.test.ts`; raise it
  there, never per test). A component test opts into jsdom per file with a
  `// @vitest-environment jsdom` comment (61 files). `db/`, `scripts/`, `e2e/`,
  `test-support/` and `tools/` are not collected; cover script behaviour by extracting it
  into `app/` (the CLIs are thin wrappers over `app/server` modules) or through e2e.
  The tree holds 397 test files under `app/`, 258 of them `*.server.test.ts` (counted
  2026-09-23).
- `test-support/setup-env.ts` runs before any app module loads and makes the suite
  hermetic:
  - seeds `VIBERR_SESSION_SECRET` and `VIBERR_SECRET_ENCRYPTION_KEY` (`??=`, so an
    explicit export still wins);
  - **blanks the ambient vendor keys a dev machine or CI host might carry**
    (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_AUTH_TOKEN`,
    `CODEX_ACCESS_TOKEN`, `CODEX_API_KEY`, `OPENAI_API_KEY`, plus
    `VIBERR_BROWSER_EXECUTABLE`), assigning `""` rather than deleting, because
    `loadEnvFile()` runs later and would refill a deleted key from someone's `.env`. This
    is belt and braces: `filteredSpawnEnv()` strips credential-shaped names by regex
    (`CREDENTIAL_ENV_RE`) anyway, and the risk it guards against is a paid provider call
    from `npm test`. There are no ambient vendor homes to pin: a run reads its home from
    the credential principal's `runtimes/users/<id>/…`, which every harness roots in its
    own temp data root;
  - sets `GIT_ALLOW_PROTOCOL=file`, so every https/ssh git transport fails instantly and
    offline;
  - sets `VIBERR_DATA_ROOT` (`??=`) to a fresh `mkdtemp` directory, so a test path that
    forgets its explicit `dataRoot` writes somewhere harmless instead of into the
    developer's `.env` root (the dual-writer hazard);
  - **primes the toolchain** (ruling 182, narrowed by 185): `cachedToolchain()` would
    otherwise spawn `npm`, `git`, `python3`, `go`, `make`, `docker`, `pnpm`, `yarn` and
    `curl` once per process, so `test-support/toolchain.ts` writes a fixed reading
    (`HERMETIC_TOOLCHAIN`) into the `Symbol.for("viberr.toolchainOverride")` slot the
    server module reads — the same shape as `setBackendBinariesForTests`.
    `toolchain.server.test.ts` clears it with `primeToolchain(null)` to drive the
    resolver with injected fakes, and restores it with `primeHermeticToolchain()`.
- `test-support/setup-dom.ts` (a no-op under node) polyfills `<dialog>`
  `show/showModal/close`, stubs `ResizeObserver` (dnd-kit reads it on import) and makes
  `HTMLCanvasElement.getContext` return `null` quietly (the run console's
  `thinking-orbs` canvas, ruling 366).
- **Availability is a fact about a PERSON, so a test seeds it like data (ruling 127).**
  `test-support/backend-credentials.ts` gives `connectFakeBackend(db, userId, backend)`,
  `connectFakeBackends(db, userId)` and `disconnectFakeBackend(db, userId, backend)`,
  which go through the REAL `setBackendApiKey` / `disconnectBackend` with an injected
  `fetch` that answers 200 without a socket, so a test cannot end up with a row shape the
  product would not produce. `fakeBackendSecret(backend)` returns the plaintext those
  helpers seal, which is what a redaction test asserts on. Connect the backend for the
  run's PRINCIPAL: the task owner for a task run, the asker for a controller turn.
- No `.env` is required.
- `harness-hermeticity.server.test.ts` pins the hermetic setup (credentials scrubbed to
  `""`, no vendor home or app configuration in the base spawn env, a `.env` credential
  cannot be reloaded), the principal's credential as the only credential in a run's
  child env, every imported package declared in `package.json`, and, by name, every key
  Viberr ADDS to a run's child env: on a Claude run `ANTHROPIC_API_KEY`,
  `CLAUDE_CONFIG_DIR`, `GIT_CEILING_DIRECTORIES` and `VIBERR_RUN_ID` (ruling 371). No
  kind carries a context-window key (ruling 376: `CONTEXT_ENV_KEYS` is empty). A key added
  anywhere on the run path without a line there fails the suite.

### Harnesses

| Module | Gives you |
|---|---|
| `test-db.ts` | `createTestDbContext()` → `makeDb()` (a migrated temp SQLite), `makeTempDir(prefix = "viberr-test-")`, `cleanup()` (closes the databases, then removes the dirs) |
| `temp-dirs.ts` | `createTempDirs()` → `make(prefix)` (an `mkdtemp` dir under the OS temp dir) and `cleanup()`, which removes every dir made since the last one; for a test with no database (`createTestDbContext` keeps its dirs through it). Register `afterAll(temp.cleanup)` when a `describe` makes a dir at collection time and shares it across its cases |
| `test-store.ts` | `setupTestStore(ctx)` → temp data root + project `viberr-core` (governed template, prefix `VIB`, next number 100, repo `akin-ozer/viberr`, no agents) with users arda (org admin, project admin), murat (maintainer), selin (contributor), elif (viewer), deniz (non-member), each with a unique `@viberr.test` email; `writeProject`, `writeTask`, `baseTaskFrontmatter`; `actorOf(user)` → the `{ userId, label }` actor a user writes as (label = email); `insertTestUser(db, id)` → a lone org-member users row (name = id, email `<id>@viberr.test`) for a test that needs a real user without the store |
| `projected-store.ts` | `setupProjectedStore(ctx)` → `setupTestStore(ctx)` with the SQLite projection already rebuilt; kept apart so a test that never projects does not load the rebuilder |
| `test-app.ts` | `setupAppTest()` route-level harness: `NODE_ENV=test`, fresh secrets, its own temp `VIBERR_DATA_ROOT`, `VIBERR_SEED_ADMIN_*` cleared, env cache reset, fake runtime installed; `cookieFor(userId)` signs in through better-auth with `APP_TEST_PASSWORD` (clearing that user's login rate-limit bucket first), `csrfFor(sessionId)`, `request(url, { cookie, … })` adds `Origin: http://localhost:5173`, `cleanup()` |
| `fake-runtime.ts` | `installFakeRuntime()`, `queueFakeRun({ lines, extraFacts, backend, occurredAt, sessionId, keepRunning, outcome, gate })`, `startedRunSpecs()`, `lastRunSpec()`; completion compaction (ruling 376): `queueFakeCompaction(backend, outcome, onCompact?)`, `compactedRunSpecs()`; `drainRunCompletions(timeoutMs = 5_000)` waits for the work a run's exit and its completion callbacks set off (a callback `void`s its effects, so nothing a test awaits covers them) — await it in `afterEach` before cleanup, or the chain meets a closed database; past the ceiling it stops waiting instead of failing. `installRunAdapters(adapters)` installs a test's own adapters with the same tracking |
| `fake-github.ts` | `fakeGithubFetch({ "GET /user": spec \| fn })` → `{ fetchImpl, calls, callsTo }`; unmatched → 404; `unreachableFetch()`; `unreadableResponse()` → a 200 whose headers throw on read (a throw from inside a GitHub pass) |
| `git-origin.ts` | a local GitHub stand-in for the real git paths: `createLocalOrigin(origins, { repo, files?, empty? })` → a bare repo with `advance()` (one more commit on `main`); `withLocalGithub(root, work)` rewrites `https://github.com/` to it through a temp `GIT_CONFIG_GLOBAL`; `gitOut(cwd, args)` and its sync twin `gitOutSync(cwd, args)` (runs git in `cwd`, stderr piped) → trimmed stdout |
| `demo-seed.ts`, `demo-data.ts`, `custom-board.ts` | the demo fixture: `runDemoSeed(db, { dataRoot, reset?, adminPassword? })` (arda, elif, murat, selin, deniz, each signing in with `SEED_DEFAULT_PASSWORD` from `app/server/seed/seed-credentials.ts` unless `adminPassword` sets arda's; `viberr-core` plus the stub projects `deploy-pipeline` and `billing-service`; twelve tasks, VIB-139…168 with full timelines plus DEP-31 and BIL-9; Arda's inbox, the VIB-142 scope violation, Arda's Home pins; the demo Developer stays Codex-backed) → the counts plus `userIds`, each seeded user's id by handle, so a test signs in as one without looking it up by email; `CUSTOM_3_STAGE_BOARD` (`todo` / `doing` / `done`) |
| `backend-credentials.ts` | `connectFakeBackend(db, userId, backend)`, `connectFakeBackends(db, userId)`, `disconnectFakeBackend(db, userId, backend)`, `fakeBackendSecret(backend)` |
| `fake-vendor-binary.ts` | `writeFakeVendorBinaries()` → executable `claude` / `codex` stand-ins (mode 0o755) for `deps.binaries`, with `cleanup()`; `setFakeVendorMode("success" \| "fail" \| "hang")`, `setFakeVendorLoggedOut()`, `setFakeVendorLogoutExit()`, `resetFakeVendorEnv()`; the evidence readers `fakeVendorEnv/Argv/Stdin/Terminated/Logout(home)`; `FAKE_DEVICE_CODE`, `FAKE_CLAUDE_URL`, `FAKE_CODEX_URL`, `ANSI_ESCAPE` |
| `mcp-tool-meta.ts` | reads a mounted in-process MCP server the way a model sees it: `toolLoading(server)` (tools loaded up front vs deferred to ToolSearch), `publishedSchemas(server)` (the JSON Schema through a real MCP client, ruling 296), `publishedInstructions(server)` (ruling 297); `callToolText(tools, toolName, args)` calls one controller tool (`viberr_controller` or `viberr_ops`) by name on a toolkit the test built as its asker and returns the text reply |
| `strict-schema.ts` | `assertStrictSchema(node)` — the OpenAI strict structured-output rule (every object `additionalProperties: false`, every key `required`) walked recursively over the Codex agent envelope and operator plan |
| `toolchain.ts` | `HERMETIC_TOOLCHAIN`, `primeToolchain(reading \| null)`, `primeHermeticToolchain()` |
| `audit-log.ts` | `listAuditEvents(db, { limit, action })` — raw `audit_events` rows, newest first |
| `fake-claude-query.ts` | `fakeClaudeQuery(...messages)` → a Claude SDK query (the `ClaudeQuery` the real adapter reads, one layer below `fake-runtime.ts`) that yields `messages`, then completes; `interrupt()` resolves. Type-only import, so it loads nothing at module scope |
| `process-liveness.ts` | for tests on real processes: `alive(pid)` (signal-0 probe; any throw = not alive, unlike the product's `isProcessAlive`, where `EPERM` counts as alive) and `gone(pid, withinMs = 3000)` (polls every 25 ms) |
| `polling.ts` | the delivery tests' fire-and-forget settling: `flush()` (5 microtask turns, then a 5 ms timer) and `waitFor(cond, what, timeoutMs = 2_000)` (polls every 5 ms, throws `timed out waiting for <what>`). Suites that poll at other cadences keep their own loops |
| `delivery-operator.ts` | `deployDeliveryOperator(store, "full" \| "supervised")` → the store's project deploys ONLY an operator with a direct `deliver-review-pr` grant and that autonomy (repo `akin-ozer/viberr`), then re-projects |
| `data-root-lock.ts` | `lockPath(dataRoot)` → `<dataRoot>/state/writer.lock`, the single-writer lock file (B-FD1) |

A `test-support/` helper has no test of its own: the tests that use it are its coverage
(ruling 458(m)). A helper that breaks fails the suites built on it, and the collected tree
(`app/**`) does not reach `test-support/` anyway.

Import route modules **after** `setupAppTest()` so they see the test env. A route action
takes the React Router 8 argument shape, including `url`, `pattern` and a
`RouterContextProvider`:

```ts
const ctx = await setupAppTest();
const { runDemoSeed } = await import("../../test-support/demo-seed");
const { userIds } = await runDemoSeed(ctx.db, { dataRoot: ctx.dataRoot });
const { action } = await import("~/routes/project.board");
const { cookie, sessionId } = await ctx.cookieFor(userIds.arda);
const request = ctx.request("/projects/viberr-core/board", {
  method: "POST",
  cookie,
  body: new URLSearchParams({
    _csrf: await ctx.csrfFor(sessionId),
    intent: "create-task",
    title: "A task",
    goal: "",
    stage: "triage",
  }),
});
const res = await action({
  request,
  url: new URL(request.url),
  params: { slug: "viberr-core" },
  pattern: "/projects/:slug/board",
  context: new RouterContextProvider(),
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
   written by the product into the fixture store must land just as clean. Migrate the
   fixture in the same change that changes a schema.

### Doc-pinning tests

Every test under `app/shared/docs/`, and the two elsewhere that read a doc:

- `app/shared/docs/prd-sync.test.ts` (ruling 27): `design/prd.md` must be byte-identical
  to `planning/planning-artifacts/prd.md`; a failure names the diverging lines.
- `app/shared/docs/file-formats-sync.test.ts`: `docs/architecture/file-formats.md` §2
  documents every `TASK_FRONTMATTER_KEYS` entry and §4 every `AGENT_PROFILE_KNOWN_KEYS`
  entry; the `## Packet` section enumerates `PACKET_OPTION_KINDS` in schema order under a
  "The N kinds:" marker, and every count it states (outside quotation marks) equals the
  schema's length.
- `app/shared/docs/rulings-supersession.test.ts` (ruling 341):
  `docs/architecture/decisions.md` still states its own supersession convention, and
  every ruling that a later one says it supersedes, replaces, retires, reverses or
  narrows carries a marker in its own text.
- `app/shared/docs/runbook-db-read.test.ts` (ruling 158): `docs/operations/runbook.md`
  and `docs/operations/deployment.md` never run `sqlite3` against
  `state/projection.sqlite` or open it with `DatabaseSync(` in a bash block; the runbook
  shows the copy-first recipe (projection and `-wal`) and names the controller's
  `viberr_ops` tools as the reader to ask first; both pages say "copy first" and "never a
  second connection"; every in-container `npm run backup` passes an absolute `--out`
  outside `/data` and is copied out with `docker compose cp`; a host-side backup in a
  stop recipe comes after `docker compose down`; and `docs/development/scripts.md`'s
  `npm run backup` section describes the copy, not a read-only connection to the live
  root.
- `app/shared/docs/anti-slop-vendor-sync.test.ts`: `tools/oxlint/anti-slop/` matches the
  committed `tools/oxlint/anti-slop.manifest.json` file for file (SHA-256; re-pin with
  `node scripts/anti-slop-manifest.mjs`), is byte-identical to the install-anti-slop
  skill's assets when `.claude/skills/` is present locally, and keeps the vendored
  `effect/` sub-plugin unregistered in `.oxlintrc.json`.
- `app/shared/docs/vitest-config.test.ts`: `vitest.config.ts` declares
  `testTimeout: 20_000`.
- `app/features/shell/nav.test.ts`: `docs/architecture/codebase-map.md` contains the
  sentence `` `nav.ts` order: `` followed by the workspace rail's labels in order.
- `app/server/files/task-file.server.test.ts`: `docs/architecture/file-formats.md`'s
  append contract never says "display sorts by timestamp" and keeps "it does not undo
  it".
- `app/server/config/env.server.test.ts`: every raw `process.env.VIBERR_*` read under
  `app/` is declared in the env schema, and every raw read and every key the schema
  declares appears in `.env.example` (as `NAME=` or `#NAME=`; the declared keys because
  ruling 458(c)'s knobs have no raw read left), except three named test-only hooks and
  the runbook-only `VIBERR_SECRET_ENCRYPTION_KEY_PREVIOUS`.

### Source-scan gates

- `app/features/retired-vocabulary.test.tsx`: seeded assets, skills, KB docs and
  templates must not teach the retired "primary specialist" model.
- `app/features/toast-honesty.test.ts`: every `push(...)` in `features` / `routes` /
  `ui` whose message literal is refusal-shaped passes an explicit `"error"` kind.
- `app/features/copy-ban.test.ts`: no "govern / governor / governance / governed" in
  copy a human reads (rendered JSX and every server string literal, with a narrow
  per-file allowlist for agent prompt text and the seeded KB doc).
- `app/app.css.test.ts`: every `var(--x)` resolves to a declared token, the focus ring
  and utility vocabulary hold, no file that imports an unstyled primitive carries
  utility-shaped classes, and no styling toolchain (`tailwindcss`,
  `class-variance-authority`, `lucide-react`, `shadcn`, …) is in `package.json`
  (ruling 166).
- `app/server/audit/audit-coverage.server.test.ts`: a table of governed actions, each
  run for real and asserting the audit row it writes. A new governed action is covered
  once it has a row in that table.

### Tests that pin a live catch

- `app/server/runtimes/codex-app-server.server.test.ts` (ruling 376) scripts the Codex
  app-server over pipes and pins the JSON-RPC exchange a completion compaction makes, the
  notification that settles it, and the ways it ends without one (a refusal on any step,
  a dead server, the timeout, a spawn that throws).
- `app/routes/project.task.run-agent.server.test.ts` (ruling 375) POSTs the Run-an-agent
  intent with a prompt through the real route and pins the order that keeps a prompted
  dispatch to ONE run: the person's `@<agent>` comment predates the run, so ruling 203's
  redelivery window finds nothing. Canary: move the record below the start and the
  developer runs twice. The same file pins ruling 449's `refresh-and-review` intent (a
  409 for a task with no open pull request).

### Behaviours tests should expect

- Operator narration is stored **verbatim** (no write-time length cap, ruling 104);
  length is handled view-side by `CollapsibleComment`. The other guardrails
  (`meaningful-comment`, `evidence-separation`, `no-duplicate-summary`,
  `compression-threshold`) are enforced per project through `project.md` `guardrails`,
  edited on the Policy page's Guardrails card (ruling 112).
- **A run needs a connected principal, not a flipped switch (ruling 127).** A test that
  wants a real-looking run connects the backend for the person who will pay for it, with
  `connectFakeBackend`. A test that wants the refusal asserts the sentence
  `principalRefusalMessage` produces, for one of three shapes: an unowned task, a disabled
  or deleted owner, or an owner with nothing connected. A refusal writes an honest
  `run·unavailable` error run through the normal completion pipeline, so the packet and
  timeline effects are observable without any process having started.
- **Agent isolation is off in the suite, and a test turns it on with a stand-in launcher
  (ruling 460).** No host running the suite has `/usr/local/libexec/viberr-launch`, so
  `agentIsolation()` is `off` and runs spawn as the test process. A test of the launched
  path calls `resetAgentIsolationForTests({ status: "on", … }, { launcher })` with a
  0o755 shell script that logs its argv and environment (and, for the sign-in, `exec`s
  `$VIBERR_LAUNCH_EXEC`), and resets it in `afterEach`. What only the kernel can answer —
  another uid refused, the setuid drop, the signal relay — is the in-image check's, not
  the suite's.
- **The hosted sign-in is driven by a FAKE BINARY, never a mock.** `backend-login.server.ts`
  takes its vendor binaries through `deps.binaries` (route-level tests use
  `setBackendBinariesForTests`), so its tests hand it the pair
  `writeFakeVendorBinaries()` (`test-support/fake-vendor-binary.ts`) writes to a temp dir
  (mode 0o755, a shebang naming the node running the suite): a small Node script that
  prints the vendor's exact lines, waits on stdin for the code (Claude) or sleeps and
  exits (Codex), writes a credential file into the home the env hands it, and answers
  `auth status` / `login status`. That is a real child process over a real pipe: URL
  capture, ANSI stripping, code submission, success rows and audit, failure exits,
  timeouts, cancel and session replacement are all exercised end to end. Each fake drops
  its evidence INSIDE the home it was handed, which is where the assertions read it from:
  `fake-env.json` (the whole child env), `fake-argv.json`, `fake-stdin.txt` (Claude only,
  proving nothing but the code reached stdin) and `fake-terminated.txt`, written from a
  `SIGTERM` handler so a test can prove a replaced or cancelled child really died instead
  of being orphaned. The same pair serves the credential store's DISCONNECT tests: the
  vendors' `logout` branches drop `fake-logout.json` (argv plus the whole child env), so
  `backend-credentials.server.test.ts` proves the vendor's own logout ran, ran against the
  home that call named, and saw no credential of the server's. The knobs are
  `VIBERR_FAKE_VENDOR_*` variables on the worker's own env, so call
  `resetFakeVendorEnv()` in `afterEach`. `no-module-mocking` is a lint rule (no
  `vi.mock`), and a mocked spawn would prove nothing about the parsing this module exists
  to do.
- **Process teardown is tested on REAL processes (ruling 174).** `run-processes.server.test.ts`
  and `claude-spawn.server.test.ts` spawn held `node` children, a SIGTERM-ignoring one, a
  shell whose `&` child is orphaned to init, and a two-member group, then assert the
  kernel's answer (`/proc` on Linux, `ps -E` on macOS): the right pids die, another run's and
  an unmarked process live. Each carries a run id no real run can have, and `afterEach`
  SIGKILLs whatever a failed assertion left. The adapters' own tests drive the SDK's side
  of `spawnClaudeCodeProcess` with a stand-in child through the `spawnCli`,
  `signalProcess` and `reapProcesses` deps.
- Clocks a policy reads are injected, never the wall clock: the resume policy's tests pass
  `nowIso` (ruling 372), and `run-sink.server.test.ts` reads its fixture dates against a
  `FROZEN_NOW`, so a test cannot pass today and fail on a later date.
- Never mutate `node_modules` while `vitest run` is in flight (it once produced 688
  phantom failures).

## 3. Lint

`npm run lint` is bare `oxlint` with `.oxlintrc.json`: it ignores agent directories
(`.agent`, `.agents`, `.claude`, `.codex`, `.continue`, `.cursor`, `.gemini`,
`.opencode`, `.pi`, `.roo`, `.windsurf`), `design/**` and the plugin's own source, loads
`tools/oxlint/anti-slop/index.ts` as a JS plugin, and sets all 15 `anti-slop/*` rules to
`error`. There is no override, allowlist or baseline file anywhere, so every anti-slop
finding fails CI (ruling 86). The rules:

`no-chained-type-assertions`, `no-conditional-empty-object-spread`,
`no-known-value-widening`, `no-module-mocking` (no `vi.mock`; use real seams),
`no-object-parameters`, `no-reflect-apply`, `no-reflect-get`, `no-runtime-typeof`
(decode with Zod instead), `no-shape-in-symbol-names`, `no-unknown-parameters`,
`no-unknown-returns`, `no-unknown-type-aliases`, `no-unsafe-dictionary-type`,
`no-widen-then-assert`, `require-safety-comment-for-type-assertion` (every non-const
`as` needs a `SAFETY:` comment).

The plugin is a vendored copy of the install-anti-slop skill's assets, held to
`tools/oxlint/anti-slop.manifest.json` by `anti-slop-vendor-sync.test.ts` (§2). The
vendored `effect/` sub-plugin (`no-service-constructor-imports`) is deliberately left
unregistered.

A checkout without `node_modules` prints nothing and "passes"; install first. In a
worktree that must not touch the lockfile:

```sh
npm i --no-save oxlint@1.79 @oxlint/plugins@1.79
```

`doctor.config.ts` (react-doctor via `npx`) and `.react-doctor/false-positives.md` belong
to a separate, manual tool, not to the lint gate.

## 4. End-to-end suite (Playwright)

`npm run e2e` runs `scripts/e2e.ts`, never a dev server. Extra arguments pass through to
Playwright (`npm run e2e -- e2e/01-home-board.spec.ts`).

1. `docker compose -f compose.e2e.yml -p viberr-e2e down --volumes --remove-orphans`.
2. `up --build --detach --wait --wait-timeout 300`: the `seed` service builds the
   Dockerfile's `build` stage (which still contains `test-support/`), runs
   `npm run seed:demo` as root on the named volume `e2e-data`, then hands `/data` to the
   final image's UID-1000 `node` user; `app` (the production image, `hostname:
   viberr-e2e`, `init: true`, a random loopback host port) starts once seeding
   succeeded. Both services read one `x-e2e-env` anchor in `compose.e2e.yml`, which is
   where the e2e **data root is set** (`VIBERR_DATA_ROOT: /data`) along with the two
   synthetic secrets — seed and app must share them or the app cannot read what the seed
   wrote. Nothing in `playwright.config.ts` or `scripts/e2e.ts` sets the data root. If
   `up` fails, the script prints the last 100 log lines of the stack and tears it down.
3. Reads the mapped port (`compose port app 3000`), polls `/resources/health` for
   `200` + `ok: true` up to 60 s.
4. Ruling 460: requires `agentIsolation.status` `on` in that body (the stack's store is a
   named volume, so anything else is a fault) and runs
   `docker compose exec -T app sh scripts/check-agent-isolation.sh` inside the running
   app container, failing the run on a non-zero exit. That script is the one place the
   kernel's side of the isolation is asserted: as two throwaway agent uids through the
   real setuid launcher it checks the server's `/proc/<pid>/environ`, the projection
   database and another person's home are refused, its own home and a shared workspace
   are writable, an agent's own git runs the hooks it planted while a workspace git
   launched with the server's overrides runs none, the server's own git cannot read a
   checkout only its agent can while a fetch through the launcher's `git-upload-pack`
   can (pass 40 review, R-seams-1), the launcher relays SIGTERM, SIGUSR2 kills the agent's group with a
   grandchild, PDEATHSIG takes the agent down with its server, `--reap` finds a detached
   process by marker, and every refusal (a uid below the floor, uid 0, a relative exec, a
   home outside `runtimes/users/`, a `..`, another agent's home, a malformed marker, an
   agent executing the launcher) holds.
5. `npx playwright test <args>` with `VIBERR_E2E_BASE_URL`; on failure prints the last
   100 app log lines.
6. `down --volumes --remove-orphans` unless `VIBERR_E2E_KEEP=1`. Exit code is
   Playwright's (or 1 when step 4 failed).

`playwright.config.ts` throws without `VIBERR_E2E_BASE_URL`; `testDir: "e2e"`,
`fullyParallel: false`, `workers: 1`, `forbidOnly` and `retries: 1` on CI (0 locally),
`timeout: 45 s`, `expect.timeout: 10 s`, `trace: "retain-on-failure"`, `list` reporter
(+ `html` on CI). Two projects: `setup` (`e2e/auth.setup.ts` logs in as
`arda@viberr.dev` with `SEED_DEFAULT_PASSWORD` through the real `/login` and stores
`e2e/.auth/arda.json`, which is gitignored) and `chromium` (Desktop Chrome, that storage
state, depends on `setup`). Chromium is the whole declared browser matrix (ruling 103).

The specs share one seeded store and run in file order on one worker, so a later spec
sees what an earlier one wrote (06 finds VIB-142's accept card by role because 05's
comment quotes the same title).

| Spec | Tests | Covers |
|---|---|---|
| `01-home-board.spec.ts` | 7 | seeded projects, board columns, drag-and-drop reorder and cross-stage moves (the solid lifted card, the hole it leaves and the one preview, told apart by dnd-kit's `data-dnd-*` attributes; the column read after a drop counts real `a.card`s, never the landing preview; a same-lane reorder held in flight with `page.route` draws its landing preview in the requested slot, and every commit until the answer draws the card exactly once), Escape cancels, a Done-stage drop asks first (dismissing writes nothing) and confirming still meets the verdict gate |
| `02-feeds-profile.spec.ts` | 6 | review-queue partitions and row labels, activity day groups, mark-all-read, theme cookie, Agent accounts with both backends unconnected |
| `03-org-settings-store.spec.ts` | 4 | instance settings tabs, heading scope, the instance pages under the app header (ruling 145), store browser creates a folder |
| `04-palette-mobile.spec.ts` | 6 | ⌘K palette, the board's own filter (`?q=`), 375 px rail collapse, non-member 404 copy, Home's palette trigger and its touch target at 375 px |
| `05-task-comment-composer.spec.ts` | 7 | Lexical composer keys, @-mention, undo, combobox a11y, zero page errors |
| `06-activity-hydration.spec.ts` | 2 | clean hydration in `Pacific/Auckland`: the activity page and the task page (VIB-142 with its open accept card); both assert zero `pageerror` and a timestamp-only SSR first pass |
| `07-accessibility.spec.ts` | 35 generated | axe WCAG 2.2 AA on 12 surfaces and 4 dialogs × 2 themes, plus the mobile rail overlay and login in both themes |
| `08-controller-dock.spec.ts` | 2 | the dock follows the surface you stand on and stays off the controller pages; at 375 px it is a bottom sheet with no sideways scroll |

The tree holds 69 tests plus the setup project (counted from the spec files on
2026-09-23; Playwright counts the setup itself, so its own total reads 70). The last full
`npm run e2e` on record, 2026-09-11, passed 70; `06-activity-hydration.spec.ts` changed
after it (2026-09-18). The e2e gate is the only one that runs a real CLI entrypoint, and
only `npm run seed:demo`: `backup`, `restore`, `rescan`, `keys`, `store:check` and
`deploy` are exercised by no gate.

The task-page half of `06-activity-hydration.spec.ts` covers the open-accept-card shape
only, because the e2e stack holds no provider credential and so never has a running run.
The RUNNING-run shape is gated by the interrupted-hydration unit gate beside it,
`app/features/task-detail/hydration-determinism.test.tsx` (pass 34, C6 + C8): a real
`renderToString` of the task page in the server's environment (UTC, 23:59:59Z) hydrated
with `hydrateRoot` in the viewer's (Pacific/Auckland, 00:00:01Z) with React's
`onRecoverableError` collected, over a live run with a streaming console and an
`accept_completion` card, plus the interrupted case that mirrors `entry.client.tsx`
(hydration inside `startTransition`, a discrete event before the flush, then a
`run.log-appended` update through the workspace layout's EventSource, the tab's one
stream, and the console's `/resources/run-log` tail fetch). The zones are applied per environment with `vi.resetModules()` and a dynamic
import, because `shared/dates/format.ts` builds its `Intl.DateTimeFormat` instances at
import time.
