# Testing

> The gates, what each one actually runs, the harnesses under `test-support/`, the tests
> that pin docs and config, the lint rules, and the e2e flow. Source of truth:
> `package.json` scripts, `vitest.config.ts`, `test-support/*`, `app/shared/docs/*`,
> `.oxlintrc.json`, `tools/oxlint/anti-slop/`, `playwright.config.ts`, `scripts/e2e.ts`,
> `compose.e2e.yml`, `e2e/*`, `.github/workflows/ci.yml`. Requires Node 26+ and `npm ci`.
> Verified against `claude/test-audit` @ `8748a583` (2026-09-27, ruling 512).

## 0. Before you add or change a test

Ruling 512 adopts one value bar for every test in the repository. A test earns its place
by protecting something a person, an agent or a file on disk would notice; everything
else is maintenance cost. The audit workflow around this bar (discovery, evidence, edit
shape, validation) is the `test-audit` skill, `.claude/skills/test-audit/SKILL.md`.

**Four questions.** Answer them before the test goes in; a missing answer means it does
not go in yet.

1. **What does it protect?** Name the contract: a governed action's audit row or typed
   timeline event, a route's `{ ok, toast }` or refusal, a canonical-file key, an SSE
   payload, a stage rule, a prompt byte an agent reads, a ruling, a perf budget, a
   sentence a person reads.
2. **What edit breaks it?** Write it down as the `CANARY:` comment the suites already
   use ("move the record below the start and the developer runs twice"). A bug's
   regression test fails on the pre-fix code for that reason: revert the fix, watch it go
   red, restore it.
3. **Why does nothing already catch it?** Each contract has ONE owning test, at the
   strongest boundary that reaches it:
   - governed logic: its server suite (`app/server/**/*.server.test.ts`), through the real
     writers on a `setupTestStore` root;
   - what a route adds (session, CSRF, `intent` parsing, status, response shape): the
     route suite (`setupAppTest`, a real `Request`);
   - rendering and interaction: the component suite (jsdom);
   - what only a browser or the shipped image shows (hydration, 375 px layout,
     drag-and-drop, axe in both themes, the in-image isolation check): `e2e/`;
   - a figure: one perf budget, not a second exact pin of the same count.

   Another layer gets a test only for a risk of its own that the owner cannot reach (a
   transport, a lifecycle, a hydration). Prefer a row in an existing `it.each` table to a
   near-copy `it`, and fold duplicated setup into one helper in the same change.
4. **Does it need a seam no production caller needs?** No `*ForTests` export, exported
   internal, env flag, parameter or injection hook for the test's sake, and no `vi.mock`
   (`no-module-mocking` fails lint). Drive the real boundary with the harnesses below: a
   fake network (`fakeGithubFetch`), a fake process (`writeFakeVendorBinaries`), a local
   git origin (`createLocalOrigin`), the fake runtime adapters (`installFakeRuntime`), the
   real writers (`setupTestStore`, `connectFakeBackend`). A reset hook for process-global
   state (`resetSseBrokerForTests`, `configureRunServiceForTests`) is the exception, kept
   only where a test in the file needs a fresh instance.

**Junk patterns.** A test that matches one fails the gate unless the retention bar below
names the contract it independently guards:

- no assertion, or one that cannot fail: a self-comparison, `toContain` of a key that is
  always there, a count asserted right after an exact list of the same things, a refusal
  asserted as `rejects.toBeDefined()`;
- an expected value produced by the code under test: the constant the renderer reads, a
  fixture built by the serializer under test, a helper that computes the answer;
- a copied inventory: an export list, a constant restated in full, a retired id kept as a
  tombstone, one CSS declaration's value with no ruling behind it;
- a `readFileSync` of a `.ts`/`.tsx`/`.css` file and a regex, unless it guards a
  user-facing key, byte or path and survives renaming an identifier everywhere (the copy
  bans, the ⌘ ban and `app.css`'s whole-sheet invariants are the model);
- a private helper exported so a test can call it, when the public function that owns
  the behaviour is tested (move the case to the public function and drop the `export`);
- the same contract again at a weaker layer: a component test with hand-built loader data
  replaying what the route suite proves through the real loader, a route test replaying a
  server table, a perf file re-proving what its owner suite proves, a finding-numbered
  regression file replaying a scenario a domain suite owns;
- a `vi.fn` or `vi.spyOn` whose implementation is the behaviour asserted, or one fake
  standing in for two different APIs;
- a fixture that hands the code the receipt, admission or ordering its owner should
  produce (a row inserted by hand where a writer exists), or persistence asserted against
  a store the path never writes;
- a negative that passes for another reason: a 403 from CSRF or the session guard where
  the name promises an RBAC refusal, a 404 because the fixture lacks the project, a
  non-member where the name says viewer;
- a name or fixture that promises more than the input exercises;
- a per-test timeout at or below `vitest.config.ts`'s budget (it changes nothing, or
  tightens it by accident; only a test waiting on a real process, a CLI or a watcher, may
  raise its own, with the reason beside it), a fixed sleep, or a wall clock a policy should
  take injected (`nowIso`, `FROZEN_NOW`, `pinPerfClock`, a frozen `Date`);
- a test of a `test-support/` helper (ruling 458(m)), or of production code only tests
  call (delete the code instead).

**Retention bar.** Keep a test that independently enforces a route or resource shape, a
canonical-file format, a migration or storage invariant, a security or isolation rule
(ruling 460), an SSE payload, a default, a prompt byte an agent depends on, an audit row,
or a numbered ruling. Keep call ordering when the order is observable (ruling 375). Keep a
doc pin when the doc mirrors a code-owned list (file-format keys, packet kinds,
`.env.example`, the PRD mirror) or forbids a dangerous recipe (ruling 158); a pin on a
sentence's wording is not a contract. Static or slow is never a reason to delete, and a
test that must change for a behaviour-preserving refactor is suspect, not automatically
deletable: show the stronger proof first. A retained test that fails on a clean checkout
is a product bug until shown otherwise; repair the owner.

## 1. The six gates

```sh
npm run lint        # oxlint + vendored anti-slop plugin; must exit 0
npm run typecheck   # react-router typegen + tsc
npm test            # vitest run, app/**/*.test.{ts,tsx}
npm run build       # react-router build (production build)
node scripts/measure-routes.mjs --check   # bundle ratchet over build/client (ruling 457)
npm run e2e         # playwright against the production Docker image (Docker required)
```

CI (`.github/workflows/ci.yml`, push and PR on `main`) runs two jobs on `ubuntu-latest`
with Node 26: `verify` = `npm ci` → lint → typecheck → test → build → the bundle ratchet
(`measure-routes.mjs --check`); `e2e` = `npm ci` → `npx playwright install --with-deps
chromium` → `npm run e2e`, uploading `playwright-report/` for 7 days on failure. No secrets
are needed: the unit setup file seeds synthetic ones and `compose.e2e.yml` carries its own.

The test step runs on the image's userland, not the runner's (ruling 622): `npm test`
inside `node:26-slim`, the Dockerfile's base, with the git and ca-certificates its
runtime stage adds, as the runner's own uid. The server shells out to `rm`, `chmod` and
`git`, and the runner's Ubuntu carries other versions of them (its coreutils 9.4 has no
`chmod -P`; the image's 9.7 does). The agent-tree suites prove refusals that root never
meets, so they need an unprivileged user, and `--init` reaps orphans as the app's
`init: true` does (the process suites wait for a killed group's members to go). Run the
same step locally as a non-root user
whose uid is outside the agent range (20001 to 59999), from the checkout:

```sh
docker run --rm --init -v "$PWD:/w" -w /w -e DEBIAN_FRONTEND=noninteractive \
  -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" node:26-slim sh -euc '
    apt-get update -qq
    apt-get install -y -qq --no-install-recommends git ca-certificates > /dev/null
    exec setpriv --reuid="$HOST_UID" --regid="$HOST_GID" --clear-groups env HOME=/tmp npm test'
```

From 2026-09-07 GitHub refused to start any job ("recent account payments have failed or
your spending limit needs to be increased"), and the six commands above, run locally, were
the only gates. Jobs run again since 2026-10-01.

## 2. Unit and integration suite (Vitest)

- `vitest.config.ts`: `include: ["app/**/*.test.{ts,tsx}"]`, `environment: "node"`,
  `setupFiles: [test-support/setup-env.ts, test-support/setup-dom.ts]`, the tsconfig
  `~/*` alias resolved natively (`resolve.tsconfigPaths`), `server.fs.strict: false` (a
  git worktree resolves `node_modules` from the primary checkout), and one budget for
  tests and hooks alike, `testTimeout: 20_000` and `hookTimeout: 20_000` (a suite that
  seeds the demo store in `beforeAll` needs the same room as its tests; raise them there,
  and let a test raise its own only while it waits on a real process). A component test
  opts into jsdom per file with a `// @vitest-environment jsdom` comment (100 files).
  `db/`, `scripts/`, `e2e/`, `test-support/` and `tools/` are not collected; cover script
  behaviour by extracting it into `app/` (the CLIs are thin wrappers over `app/server`
  modules) or through e2e. The tree holds 510 test files under `app/`, 290 of them
  `*.server.test.ts` (counted 2026-09-27).
- `test-support/setup-env.ts` runs before any app module loads and makes the suite
  hermetic:
  - seeds `VIBERR_SESSION_SECRET` and `VIBERR_SECRET_ENCRYPTION_KEY` (`??=`, so an
    explicit export still wins), so `getEnv()` never generates random ones into the
    data root (ruling 504);
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
  `show/showModal/close`, stubs `ResizeObserver` (dnd-kit reads it on import), defines an
  `AnimationEvent` (React picks the event name `onAnimationEnd` listens for once, as it
  loads, and falls back to one no test can fire without it; ruling 451(g)) and
  `Range.prototype.getBoundingClientRect` (Lexical measures a selection with it). jsdom
  30 ships none of the four. It stubs no canvas: the run console's orb is CSS since
  ruling 499, and nothing in the app draws on one.
- **Availability is a fact about a PERSON, so a test seeds it like data (ruling 127).**
  `test-support/backend-credentials.ts` gives `connectFakeBackend(db, userId, backend)`,
  `connectFakeBackends(db, userId)` and `disconnectFakeBackend(db, userId, backend)`,
  which go through the REAL `setBackendApiKey` / `disconnectBackendAccount` with an injected
  `fetch` that answers 200 without a socket, so a test cannot end up with a row shape the
  product would not produce. `fakeBackendSecret(backend)` returns the plaintext those
  helpers seal, which is what a redaction test asserts on. Connect the backend for the
  run's PRINCIPAL: the task owner for a task run, the asker for a controller turn.
- No `.env` is required.
- `harness-hermeticity.server.test.ts` pins the hermetic setup (credentials scrubbed to
  `""`, a `.env` credential cannot be reloaded, no ambient vendor home in a run's child
  env; `runtime-registry.server.test.ts` pins what the base spawn env strips), the
  principal's credential as the only credential in a run's child env, every imported
  package declared in `package.json`, and, by name, every key Viberr ADDS to a run's child
  env: on a Claude run `ANTHROPIC_API_KEY`, `CLAUDE_CONFIG_DIR`, `GIT_CEILING_DIRECTORIES`
  and `VIBERR_RUN_ID` (ruling 371); on a Codex run with a pasted Platform key
  `CODEX_API_KEY`, `CODEX_HOME`, `CODEX_SQLITE_HOME`, `GIT_CEILING_DIRECTORIES` and
  `VIBERR_RUN_ID`. No
  kind carries a context-window key (ruling 376). A key added
  anywhere on the run path without a line there fails the suite.

### Harnesses

| Module | Gives you |
|---|---|
| `test-db.ts` | `createTestDbContext()` → `makeDb()` (a migrated temp SQLite), `makeTempDir(prefix = "viberr-test-")`, `cleanup()` (closes the databases, then removes the dirs) |
| `temp-dirs.ts` | `createTempDirs()` → `make(prefix)` (an `mkdtemp` dir under the OS temp dir) and `cleanup()`, which removes every dir made since the last one; for a test with no database (`createTestDbContext` and `setupAppTest` keep their dirs through it). Register `afterAll(temp.cleanup)` when a `describe` makes a dir at collection time and shares it across its cases, `afterEach` otherwise. Whatever no cleanup removed goes when the test file finishes (an `afterAll` the module registers as the file loads), so a file that forgets one still leaves nothing in the OS temp folder |
| `test-store.ts` | `setupTestStore(ctx)` → temp data root + project `viberr-core` (governed template, prefix `VIB`, next number 100, repo `akin-ozer/viberr`, no agents) with users arda (org admin, project admin), murat (maintainer), selin (contributor), elif (viewer), deniz (non-member), each with a unique `@viberr.test` email; `writeProject`, `writeTask`, `baseTaskFrontmatter`; `actorOf(user)` → the `{ userId, label }` actor a user writes as (label = email); `insertTestUser(db, id)` → a lone org-member users row (name = id, email `<id>@viberr.test`) for a test that needs a real user without the store; `MERGE_STAGE_BOARD` (the k9s board: a Merge stage past Review, pass 35) and `REVIEW_STAGE_REVIEWER` (a verdict-capable reviewer eligible at Review only) |
| `projected-store.ts` | `setupProjectedStore(ctx)` → `setupTestStore(ctx)` with the SQLite projection already rebuilt; kept apart so a test that never projects does not load the rebuilder |
| `stale-mount.ts` | `staleViewOf(absPath)` → `{ serve() }`: take it before a write and call `serve()` after, and the path names the file that write replaced again, same inode, bytes and mtime: the view a stale VirtioFS mount hands a reader (VIB-1, ruling 513). The writers' stale-read tests make one this way; rewriting the file in place would be another writer, which the repair lets win |
| `test-app.ts` | `setupAppTest()` route-level harness: `NODE_ENV=test`, fresh secrets, its own temp `VIBERR_DATA_ROOT`, `VIBERR_SEED_ADMIN_*` cleared, env cache reset, fake runtime installed; `cookieFor(userId)` signs in through better-auth with `APP_TEST_PASSWORD` (hashed on the file's first sign-in and shared by every later one, since scrypt is deliberately slow; clearing that user's login rate-limit bucket first), `csrfFor(sessionId)`, `sessionFor(userId)` (one signed-in session and its CSRF token per person, made on first use; `forgetSession` drops one a test signed out), `request(url, { cookie, … })` adds `Origin: http://localhost:5173`, `cleanup()` |
| `fake-runtime.ts` | `installFakeRuntime()`, `queueFakeRun({ lines, extraFacts, backend, occurredAt, sessionId, keepRunning, outcome, gate })`, `startedRunSpecs()`, `lastRunSpec()`; completion compaction (ruling 376): `queueFakeCompaction(backend, outcome, onCompact?)`, `compactedRunSpecs()`; `drainRunCompletions(timeoutMs = 5_000)` waits for the work a run's exit and its completion callbacks set off (a callback `void`s its effects, so nothing a test awaits covers them) — await it in `afterEach` before cleanup, or the chain meets a closed database; past the ceiling it stops waiting instead of failing. `installRunAdapters(adapters)` installs a test's own adapters with the same tracking |
| `fake-github.ts` | `fakeGithubFetch({ "GET /user": spec \| fn })` → `{ fetchImpl, calls, callsTo }`; unmatched → 404; `unreachableFetch()`; `unreadableResponse()` → a 200 whose headers throw on read (a throw from inside a GitHub pass) |
| `git-origin.ts` | a local GitHub stand-in for the real git paths: `createLocalOrigin(origins, { repo, files?, empty? })` → a bare repo with `advance()` (one more commit on `main`); `withLocalGithub(root, work)` rewrites `https://github.com/` to it through a temp `GIT_CONFIG_GLOBAL`; `gitOut(cwd, args)` and its sync twin `gitOutSync(cwd, args)` (runs git in `cwd`, stderr piped) → trimmed stdout |
| `demo-seed.ts`, `demo-data.ts`, `custom-board.ts` | the demo fixture: `runDemoSeed(db, { dataRoot, reset?, adminPassword? })` (arda, elif, murat, selin, deniz, each signing in with `SEED_DEFAULT_PASSWORD` from `app/server/seed/seed-credentials.ts` unless `adminPassword` sets arda's, each distinct password hashed once per seed; `viberr-core` plus the stub projects `deploy-pipeline` and `billing-service`; twelve tasks, VIB-139…168 with full timelines plus DEP-31 and BIL-9; Arda's inbox, the VIB-142 scope violation, Arda's Home pins; the demo Developer stays Codex-backed) → the counts plus `userIds`, each seeded user's id by handle, so a test signs in as one without looking it up by email; `CUSTOM_3_STAGE_BOARD` (`todo` / `doing` / `done`) |
| `backend-credentials.ts` | `connectFakeBackend(db, userId, backend)`, `connectFakeBackends(db, userId)`, `disconnectFakeBackend(db, userId, backend)`, `fakeBackendSecret(backend)` |
| `fake-vendor-binary.ts` | `writeFakeVendorBinaries()` → executable `claude` / `codex` stand-ins (mode 0o755) for `deps.binaries`, with `cleanup()`; `setFakeVendorMode("success" \| "fail" \| "hang")`, `setFakeVendorLoggedOut()`, `setFakeVendorLogoutExit()`, `setFakeVendorEvidenceDir()`, `resetFakeVendorEnv()`; the evidence readers `fakeVendorEnv/Argv/Stdin/Terminated/Logout(home)` and, outside every home, `fakeVendorLogouts/Terminations(dir)`; `FAKE_DEVICE_CODE`, `FAKE_CLAUDE_URL`, `FAKE_CODEX_URL`, `ANSI_ESCAPE` |
| `mcp-tool-meta.ts` | reads a mounted in-process MCP server the way a model sees it: `toolLoading(server)` (tools loaded up front vs deferred to ToolSearch), `publishedSchemas(server)` (the JSON Schema through a real MCP client, ruling 296), `publishedInstructions(server)` (ruling 297); `callToolText(tools, toolName, args)` calls one controller tool (`viberr_controller` or `viberr_ops`) by name on a toolkit the test built as its asker and returns the text reply |
| `strict-schema.ts` | `assertStrictSchema(node)` — the OpenAI strict structured-output rule (every object `additionalProperties: false`, every key `required`) walked recursively over the Codex agent envelope and operator plan |
| `toolchain.ts` | `HERMETIC_TOOLCHAIN`, `primeToolchain(reading \| null)`, `primeHermeticToolchain()` |
| `audit-log.ts` | `listAuditEvents(db, { limit, action })` — raw `audit_events` rows, newest first; rows of one millisecond in the order written (`rowid`), as the app's own audit readers order them, so `[0]` is the row the last write made |
| `fake-claude-query.ts` | `fakeClaudeQuery(...messages)` → a Claude SDK query (the `ClaudeQuery` the real adapter reads, one layer below `fake-runtime.ts`) that yields `messages`, then completes; `interrupt()` resolves. Type-only import, so it loads nothing at module scope |
| `process-liveness.ts` | for tests on real processes: `alive(pid)` (signal-0 probe; any throw = not alive, unlike the product's `isProcessAlive`, where `EPERM` counts as alive) and `gone(pid, withinMs = 3000)` (polls every 25 ms) |
| `polling.ts` | the delivery tests' fire-and-forget settling: `flush()` (5 microtask turns, then a 5 ms timer) and `waitFor(cond, what, timeoutMs = 2_000)` (polls every 5 ms, throws `timed out waiting for <what>`); the runtime suites' `settle()` (thirty zero-delay timer turns) and the agent suites' `pollUntil(cond, timeoutMs = 6_000)` (every 25 ms, resolves to whether `cond` held, so a miss is the caller's to assert). A suite at another cadence keeps its own loop |
| `delivery-operator.ts` | `deployDeliveryOperator(store, "full" \| "supervised")` → the store's project deploys ONLY an operator with a direct `deliver-review-pr` grant and that autonomy (repo `akin-ozer/viberr`), then re-projects |
| `data-root-lock.ts` | `lockPath(dataRoot)` → `<dataRoot>/state/writer.lock`, the single-writer lock file (B-FD1) |
| `operator-snapshot.ts` | `operatorSnapshot(over?)` → the `OperatorTaskSnapshot` an operator prompt-byte test hands `buildOperatorTurnPrompt` / `buildCodexOperatorPrompt` (VIB-1, ready at the work stage, waiting on nobody); pass only the fields the case is about |
| `profile-data.ts` | `PROFILE_DATA`, a maintainer's profile with neither GitHub nor an agent account connected, shared by the Profile page's tests and the route's |
| `task-detail.ts` | `taskSummary(patch?)` and `taskDetail(patch?)` → VIB-151 as the task projection hands it over (open, undelivered, unowned, waiting on its agent, three stages); pass only the fields the case is about |
| `run-view.ts` | `NO_RUN_CACHE` (the cache record of a run that has reported nothing yet) and `controllerRun(patch?)` (a controller turn in flight, one line in its console) |
| `static-run-log-store.ts` | `staticRunLogStore({ linesByThread, olderByThread?, streamError?, onLoadOlder? })` → a `RunLogStore` over lines in hand, for a console a test feeds by props |
| `fake-event-source.ts` | `FakeEventSource`, the `EventSource` a test stubs as the global: it records every source a page opens (`instances`, `last()`, `open()`), `emit(name, lastEventId?, data?)` reaches that name's listeners, `fail()` fails the connection as a non-200 answer does; a file that frames a payload keeps that framing local |
| `data-router.tsx` | `DataRouter`, a render `wrapper` with a real data router whose one route counts its loader runs, for a hook that calls `useRevalidator`; `resetDataRouter()` before each test, `loaderRunCount()` |
| `env.ts` | `withEnv(vars, run)` → `run` with `vars` in `process.env` and the env cache dropped on the way in and out: a switch a deployment sets in its env, reached the way production reaches it (ruling 512(c)) |
| `controller-dock-stub.tsx` | `mountDock(opts)`: the controller dock under a routed stub shaped like the app (root, the workspace layout, a board, a task, the project controller page, the dock's two resource routes, run through their real `clientLoader` and `clientAction`), shared by the dock's behaviour and perf tests (ruling 121); `reachable: () => false` takes the server away |
| `client-data.ts` | `clientLoaderOver(module, server)` and `clientActionOver(module, server)` → a stub route's loader or action that runs a fetcher's request as framework mode does: through the route module's `clientLoader` or `clientAction` over `server` (the server's handler, answering what single fetch decodes), or `server` alone when the module has none; `unreachable()` throws what `fetch` rejects with when no answer comes (ruling 457) |
| `memory-storage.ts` | `MemoryStorage`, an in-memory `Storage` for a component test that reads `localStorage` (Node 26 defines none without `--localstorage-file`); install it with `vi.stubGlobal` |
| `mcp-upstream.ts` | real MCP servers for the gateway's tests (ruling 461): Streamable HTTP (`startHttpUpstream`, `startSessionfulHttpUpstream`), legacy SSE (`startSseUpstream`) and stdio (`writeStdioUpstream`, `writeSilentStdioUpstream`) upstreams that require their bearer and record the calls that arrived |
| `mcp-oauth-server.ts` | `startOAuthMcpServer(options)`: an in-test MCP server that signs in with OAuth the way Cloudflare's does (401 with `resource_metadata`, dynamic client registration, PKCE S256, refresh and revocation), and `signInWithOAuth` / `consentAt`, which go through the real `startMcpOAuthSignIn` / `completeMcpOAuthSignIn` (ruling 469) |
| `cloudflare-read-only-grant.ts` | `CLOUDFLARE_READ_ONLY_SCOPES` / `CLOUDFLARE_READ_ONLY_GRANT`: the 194 read scopes Cloudflare's read-only consent template granted the live sign-in (ruling 486) |
| `kb-legacy-proposals.ts` | `withLegacyProposals(text, inputs)`: a knowledge-base document with a "Proposed corrections (not binding)" section, byte for byte the way rulings 378 and 483 filed them, for the readers that still meet one after ruling 498 |
| `resource-boards.ts` | `writeBoardHolding(dataRoot, slug, resources, more?)`: one board's `project.md` whose Scout holds the given skills, knowledge bases and MCP servers beside an Operator, for the suites that ask which boards are given a resource (ruling 681) |
| `css-rules.ts` | the one parser of `app/app.css` the stylesheet gates share (`cssRules`, `declsFor`, `requiredDecls`, `selectorParts`) |
| `perf-*.ts`, `perf-budgets/`, `render-counter.ts`, `revalidation-harness.tsx`, `static-imports.ts`, `console-fixture.ts` | the ruling-457 perf harnesses and budget tables; [performance.md](performance.md) §4 documents them |

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

Every test under `app/shared/docs/`, and the ones elsewhere that read a doc or a vendored file:

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
  `viberr_ops` tools as the reader to ask first; every in-container `npm run backup`
  passes an absolute `--out`
  outside `/data` and is copied out with `docker compose cp`; a host-side backup in a
  stop recipe comes after `docker compose down`; and `docs/development/scripts.md`'s
  `npm run backup` section describes the copy, not a read-only connection to the live
  root.
- `app/shared/docs/anti-slop-vendor-sync.test.ts`: `tools/oxlint/anti-slop/` matches the
  committed `tools/oxlint/anti-slop.manifest.json` file for file (SHA-256; re-pin with
  `node scripts/anti-slop-manifest.mjs`).
- `app/shared/docs/perf-budgets-sync.test.ts` (ruling 457): every budget id in
  `test-support/perf-budgets/` is asserted inside an `expectWithinBudget(…)` call of some
  `*.perf.test.*` file, every perf file asserts a budget, every perf file that loads
  through the server pins the clock, and every `bundle.json` id names a route.
- `app/shared/docs/vite-config.test.ts` (ruling 457): `vite.config.ts` never inlines a
  font, and the client build's own chunk namers put the npm code every page loads in
  `vendor` and the shared app code in `shell`.
- `app/server/ops/store-volume-wiring.test.ts` (ruling 504): `compose.yml` mounts the
  Compose-owned `viberr-data` volume and needs no `.env`, and the first shell block that
  runs Compose in `README.md` and `docs/operations/deployment.md` is the install itself.
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
- `app/server/runtimes/humanizer.server.test.ts` (ruling 502): the vendored
  `app/server/runtimes/humanizer/` holds only upstream's `SKILL.md`, matching
  `HUMANIZER_SKILL_SHA256`, and its MIT `LICENSE`, and `THIRD_PARTY_NOTICES.md` names the
  repository, the pinned commit and the licence text. Re-vendor from upstream and move
  the pin with it; never edit the copy in place.

### Source-scan gates

- `app/features/retired-vocabulary.test.tsx`: seeded agent assets must not teach the
  retired "primary specialist" model, and neither the recommendation chips nor the
  Agents page call an agent a "specialist" (copy-ban's F19-12 scan covers the rest of the
  copy).
- `app/features/toast-honesty.test.ts`: every `push(...)` in `features` / `routes` /
  `ui`, and every call through a name bound by `const X = useToast()`, whose message
  literal is refusal-shaped passes an explicit `"error"` kind; a floor on the calls it
  reads keeps the scan from passing on an empty set.
- `app/features/copy-ban.test.ts`: no "govern / governor / governance / governed" in
  copy a human reads (rendered JSX and every server string literal, with a narrow
  per-file allowlist for agent prompt text and the seeded KB doc), no em or en dash in
  rendered copy or seed assets (P21) or in any string literal under `app/server`,
  `app/schemas`, `app/shared` or `app/lib` (ruling 571), and no "primary specialist"
  (F19-12).
- `app/features/shortcut-glyph.test.ts` (ruling 419(d)): no ⌘ glyph in copy; the key is
  spelled for the platform that reads it.
- `app/features/live-updates/one-event-source.test.ts` (ruling 457): exactly one module
  under `app/` opens an `EventSource`, the live-updates hook every page shares.
- `app/server/runtimes/tool-description-hygiene.test.ts` (ruling 342): a tool's
  description says each thing once.
- The static-closure walkers built on `test-support/static-imports.ts` (performance.md
  §4): a named module or package never enters a budgeted client closure.
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
  a dead server, the timeout, a spawn that throws, and, ruling 599, a compaction turn the
  CLI reports failed).
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
  home that call named, and saw no credential of the server's. Ruling 507 removes an
  account's whole home when it is disconnected, and an abandoned sign-in's new home once
  its process has exited, so the in-home evidence is gone by the time a test asserts:
  `setFakeVendorEvidenceDir(dir)` makes every logout and every `SIGTERM` also record
  itself in a directory outside all homes, read back with `fakeVendorLogouts(dir)` and
  `fakeVendorTerminations(dir)`. The knobs are
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
- A file's mtime is not `new Date()`. Linux stamps a new file from a coarse clock (the
  last timer tick), which trails the wall clock by a few milliseconds, so a file written
  just after a run's `started_at` can read as older than the run. A test that needs files
  inside a run's window (`attachmentNamesSince`) stamps them with `utimesSync`, as
  `saveInRunWindow` in `agent-completion.server.test.ts` does.
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
   can (pass 40 review, R-seams-1), a checkout two agent uids wrote 0700 directories into
   defeats the server's own `rm -rf` half-way while the server's replace
   (`removeAgentTree`, run with the image's `tsx`) removes it as its persons and a fresh
   clone lands in the freed path (ruling 485), the host kernel protects hard links
   (`fs.protected_hardlinks` 1, the host's setting and not the image's: an agent cannot
   link a server file it cannot write) and the server's `chmod -R -P` follows no link it
   is handed, the real skill mount leaves a run's plugin 2775 and group-readable for its
   person to read and `rm`, a plugin written the pre-495 way is opened by the server and
   removed by the person, an emptied workspace root no agent uid may unlink goes with the
   server's `rmdir`, and the server opens and removes nothing through a folder an agent
   swapped for a link, its own link or one of the server's it moved there (ruling 495), the launcher
   relays SIGTERM, SIGUSR2 kills the agent's group with a
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
| `01-home-board.spec.ts` | 6 | board columns and a real click through to VIB-142, drag-and-drop reorder and cross-stage moves (the solid lifted card, the hole it leaves and the one preview, told apart by dnd-kit's `data-dnd-*` attributes; the column read after a drop counts real `a.card`s, never the landing preview; a same-lane reorder held in flight with `page.route` draws its landing preview in the requested slot, and every commit until the answer draws the card exactly once), Escape cancels, a Done-stage drop asks first (dismissing writes nothing) and confirming still meets the verdict gate |
| `02-feeds-profile.spec.ts` | 3 | mark-all-read (which leaves 07 a fully read inbox to audit), the theme cookie surviving a reload, Agent accounts with both backends unconnected |
| `03-org-settings-store.spec.ts` | 3 | each instance settings tab renders its own panel, heading scope (R15-13), the instance pages under the app header (ruling 145) |
| `04-palette-mobile.spec.ts` | 3 | at 375 px: the rail collapses behind a toggle with no sideways scroll, Home keeps a way into the palette, and the workspace palette trigger is a real touch target |
| `05-task-comment-composer.spec.ts` | 5 | the Lexical composer in a real browser: a plain post, Enter versus Ctrl/Meta+Enter, @-mention by keyboard and by click (the posted bytes carry the mention), undo cannot resurrect a sent comment, zero page errors |
| `06-activity-hydration.spec.ts` | 2 | clean hydration in `Pacific/Auckland`: the activity page and the task page (VIB-142 with its open accept card); both assert zero `pageerror` and a timestamp-only SSR first pass |
| `07-accessibility.spec.ts` | 37 generated | axe WCAG 2.2 AA on 13 surfaces and 4 dialogs × 2 themes, plus the mobile rail overlay and login in both themes |
| `08-controller-dock.spec.ts` | 4 | the dock follows the surface you stand on and stays off the controller pages; at 375 px it is a bottom sheet with no sideways scroll; a dock the tab remembers open comes back after a reload without its entrance; a click on the trigger while the dock closes turns it back open |
| `09-epics.spec.ts` | 5 | a new epic opens on its own page (the chain's first test creates `epic-1`), tasks join and leave it from its page and from their own, the epic page reads in one column at 375 px (ruling 560), and the epic page and its dialogs pass axe (ruling 503) |
| `10-notification-anchors.spec.ts` | 1 | with Chrome's scroll anchoring off, a notification about an event on another task lands on it in view after the page's long comments fold (rulings 497, 547) |
| `11-label-editor-press.spec.ts` | 2 | one press on the Labels editor's Save, made where Save stood with the label list open, saves: after a pick and with a label half typed (ruling 561) |

The tree holds 71 tests plus the setup project (counted from the spec files on
2026-09-28; Playwright counts the setup itself, so its own total reads 72). `npm run e2e`
on 2026-09-27 read `68 passed (43.8s)`, 64 s end to end with the image build.
Two gates run a real CLI entrypoint: e2e runs `npm run seed:demo`, and
`app/server/seed/default-assets.server.test.ts` runs `npm run seed` inside `npm test`.
`backup`, `restore`, `rescan`, `keys`, `store:check`, `store:to-volume` and `deploy` are
exercised by no gate.

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
