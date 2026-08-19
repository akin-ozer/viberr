# TESTING-INFRA — Viberr current state (pass 20)

> Verified against `main @b97ad02` on 2026-08-14 (pass 20). Every anchor below
> was re-read at this SHA; the pass-19 doc's anchors had all drifted (the
> pass-19 merge, PR #157 @4184e95, landed session B's ~37 extra test files).

The test setup, the hermetic environment, the fake runtime, the e2e model, the
static gates, and the test additions since the pass-19 merge.
Vitest 4.1.10, Node 26.5.0, Playwright 1.62.1, jsdom 30.
Test command: `npm test` → `vitest run`. Typecheck: `npm run typecheck`
(`react-router typegen && tsc`). E2E: `npm run e2e`.

**Measured at HEAD** (full run, exit 0): **256 files / 3702 tests passed in
31 s**. The suite is cheap — run all of it, always.

---

## 1. Test runner config (`vitest.config.ts`)

Single config, **no** workspace/project split. Unchanged since pass 19.

- **Environment**: `node` globally (`vitest.config.ts:11`). There is no separate
  jsdom project — the **46** component/UI test files opt into jsdom **per-file**
  via a `// @vitest-environment jsdom` header comment (e.g.
  `app/features/profile/profile-page.test.tsx:1`).
- **Setup files** (:15): `["./test-support/setup-env.ts", "./test-support/setup-dom.ts"]`.
- **Include** (:21): `["app/**/*.test.{ts,tsx}"]`, no explicit exclude. (A former
  `db/**/*.test.ts` glob was dropped, :16-20.)
- **Path alias**: `resolve.tsconfigPaths: true` (:7) — Vite 8 native `~/*`
  resolution (the `vite-tsconfig-paths` plugin was removed).
- **Coverage**: none configured.

`vite.config.ts` is the app dev/build config (React Router plugin), not the test
config; it excludes the runtime data root from the dev watcher.

---

## 2. Hermetic environment (`test-support/setup-env.ts`, 111 lines)

Runs before any app module. Guarantees a suite can never make a paid provider
call, read host credentials, **or open a socket**:

- **Seeds required secrets** so boot validation passes on a fresh clone with no
  `.env`: `VIBERR_SESSION_SECRET` (:19) and a 32-byte base64
  `VIBERR_SECRET_ENCRYPTION_KEY` (:22-23), both via `??=` so real exports still win.
- **Credential scrub (F10-10 fail-closed)** (:44-58): sets `ANTHROPIC_API_KEY`,
  `CLAUDE_CODE_OAUTH_TOKEN`, `VIBERR_CLAUDE_USE_CLI_AUTH`, `CODEX_ACCESS_TOKEN`,
  `CODEX_API_KEY`, `OPENAI_API_KEY`, `VIBERR_CODEX_USE_CLI_AUTH` and — **new,
  R19-19** — `VIBERR_BROWSER_EXECUTABLE` (:52-55) to `""` (NOT `delete` —
  `env.server.ts` runs `loadEnvFile()` at module scope AFTER setup and would
  refill deleted keys, re-opening the leak; `""` reads as absent yet blocks the
  refill). The browser var is scrubbed for the same reason: a dev host pointing
  it at a local Chrome would change the mounted MCP argv out from under
  `specialist-browser-mcp.server.test.ts`.
- **Transcript stores pinned to empty temp dirs (P13-D-2)** (:85-89):
  `CLAUDE_CONFIG_DIR` and `CODEX_HOME` point at empty temp subdirs, so the
  continuity probe is deterministic (store exists but empty → `missing`) and
  `CODEX_HOME` stays out of the scrub list (an empty dir with no `auth.json`
  keeps CLI-auth false by construction).
- **Network fail-closed for git (N19-6)** (:111): `GIT_ALLOW_PROTOCOL = "file"`.
  Two tests reach `cloneRepo` with a publicly-resolvable name
  (`akin-ozer/viberr`), so `npm test` used to make a real `git clone` and flake
  under parallel load. Git's own allow-list makes every https/ssh transport fail
  instantly and offline; `git init`/`add`/`commit` and `file://` remotes (the
  skill-mount fixtures) are unaffected. **This is new since the pass-19 doc**,
  which did not mention it.

`test-support/setup-dom.ts` is the jsdom shim: polyfills
`HTMLDialogElement.showModal/show/close` (:7-22) and stubs `ResizeObserver` for
dnd-kit (:29-36); no-ops under node.

**Harness-hermeticity self-test**:
`app/server/runtimes/harness-hermeticity.server.test.ts` (`describe` :43) asserts
every credential is `""` not deleted (:50), both backends report unavailable
(:56), `CODEX_HOME` exists with no `auth.json` (:61), and a `.env` carrying all
credentials cannot reload into the process (:74). A second `describe` (:109)
enforces import hygiene — no app import resolves only through npm hoisting
(:150).

---

## 3. Test helpers (`test-support/`)

| File | Provides |
| --- | --- |
| `test-db.ts` | `createTestDbContext()` (:24) → `{ makeDb(), makeTempDir(), cleanup() }`. `makeDb()` opens a temp SQLite DB + runs migrations (:34-41). |
| `test-store.ts` | `setupTestStore(ctx)` (:52) → temp data root + migrated DB + a seeded `viberr-core` project with 5 users at distinct project roles (:74-78: arda=admin, murat=maintainer, selin=**contributor**, elif=viewer, deniz=registered non-member). Exports `writeProject` (:102), `baseTaskFrontmatter` (:113), `writeTask` (:143). ⚠ the file's own header comment (:26) still says "selin → reviewer" — stale, the code says `contributor`. |
| `test-app.ts` | `setupAppTest()` — route-level harness (:36): temp data root, resets env+db singletons, **installs the fake runtime** (:62-63), returns `cookieFor()`/`csrfFor()`/`request()` builders for real signed-cookie + CSRF requests. Exports `APP_TEST_PASSWORD` (:34). |
| `fake-runtime.ts` | The agent-runtime stub (below). |
| `fake-github.ts` | Fake GitHub API/client. |
| `demo-seed.ts`, `demo-data.ts` | Demo fixture seeding (also used by the e2e stack). Exports `SEED_DEFAULT_PASSWORD`. |
| `audit-log.ts`, `custom-board.ts` | Smaller fixtures. |

**Fake runtime** (`fake-runtime.ts`, 177 lines) — so no real Claude/Codex is
spawned: `installFakeRuntime()` (:45-53) clears queued runs + started specs and
calls `configureRunServiceForTests({ claude, codex })` with fake adapters;
`queueFakeRun(run, backend)` (:41) enqueues scripted output lines;
`startedRunSpecs()` (:32) and **`lastRunSpec()`** (:37) let a test assert exactly
what reached the runtime (prompt/systemPrompt, denylist, mounted skills, mounted
MCP servers). `createFakeAdapter().start()` (:55-62) pushes the spec, then
`playFakeRun` (:64-102) replays queued/default lines via `queueMicrotask` and
calls `onExit` deterministically; `interrupt()` exits with `interrupted`. This is
the seam the KB/skill/browser-mount tests assert on
(`lastRunSpec()?.systemPrompt`, `…?.mcpServers`).

---

## 4. Scale (pass 20, measured)

- `npx vitest --version` → `vitest/4.1.10 darwin-arm64 node-v26.5.0`.
- **256 test files** (`app/**/*.test.{ts,tsx}`) — **211** `.test.ts` +
  **45** `.test.tsx`. (Pass-19 doc: 219 = 183+36. The +37 came with the pass-19
  merge @4184e95; 7 more were added in the 12 commits after it.)
- **3702 tests, all passing**, 30.8 s wall (`npx vitest run --reporter=dot`,
  run at HEAD for this doc). Static `it(`/`test(` grep reads 3587 — it under-reads
  `it.each` expansions, so trust the run, not the grep.
- **46 files carry `// @vitest-environment jsdom`** — 44 of the 45 `.test.tsx`
  plus 2 `.test.ts` (`app/ui/roving-radio.test.ts`,
  `app/features/kb-browser/local-files.test.ts`). The one `.tsx` WITHOUT the
  header is `app/features/retired-vocabulary.test.tsx` — it scans seeded assets,
  never renders.

---

## 5. e2e model (production Docker image; dev server banned)

Unchanged since pass 19 apart from the image layers (§5b).

- **Playwright config** (`playwright.config.ts`): `testDir: "e2e"` (:28), single
  worker, `fullyParallel: false` (shared seeded store). **No `webServer` block**
  — the base URL comes from `VIBERR_E2E_BASE_URL`, and the config THROWS if it is
  unset (:17-25), enforcing the "no bare `npx playwright test`" discipline.
  Timeout 45 s, expect 10 s, `trace: retain-on-failure`, CI retries 1.
- **Production-image discipline** (owner policy 2026-08-02, documented at
  `playwright.config.ts:3-15` and `scripts/e2e.ts:1-12`): e2e ALWAYS runs the
  production Docker image, never a dev server.
- **Orchestration**: `npm run e2e` → `tsx scripts/e2e.ts` runs
  `docker compose -f compose.e2e.yml -p viberr-e2e` (:17): `down --volumes` →
  `up --build --wait` → derives the random host port via `compose port app 3000`
  → waits for `/resources/health` → runs `npx playwright test` with
  `VIBERR_E2E_BASE_URL` → tears down (`--volumes`, unless `VIBERR_E2E_KEEP=1`).
  Extra args pass through: `npm run e2e -- e2e/01-home-board.spec.ts`.
- **Compose stack** (`compose.e2e.yml`): a `seed` one-shot built at
  `target: build` (the demo fixture never ships in the final image) runs
  `npm run seed:demo && chown -R 1000:1000 /data`, then the `app` service runs
  the final production image (`NODE_ENV: production`, synthetic secrets only,
  `hostname: viberr-e2e` so an app-only restart reclaims its own writer lock,
  project-scoped named volume, `127.0.0.1::3000` random host port, node-based
  healthcheck on `/resources/health`).
- **Auth**: `e2e/auth.setup.ts` — the `setup` project logs in once through the
  real `/login` UI as `arda@viberr.dev` (`SEED_DEFAULT_PASSWORD`) and saves
  storage state to `e2e/.auth/arda.json`; the `chromium` project depends on
  `setup` and reuses it.
- **Specs**: 7 spec files + `auth.setup.ts`, **33** `test()` cases —
  `01-home-board` 7, `02-feeds-profile` 5, `03-org-settings-store` 3,
  `04-palette-mobile` 6, `05-task-comment-composer` 7, `06-activity-hydration` 1,
  `07-accessibility` 4. The a11y spec uses `@axe-core/playwright` (4.12).
  (Pass-19 doc said "~32" — it is 33.)

### 5b. Image layers the e2e build now pays for (pass 20)

Four of the twelve post-merge commits are Dockerfile-only and touch no test, but
they change how long `npm run e2e` takes and how it fails:

- `Dockerfile:60-73` (R19-19) installs Debian `chromium` + `fonts-liberation`
  (~700 MB) in the final stage and sets `ENV VIBERR_BROWSER_EXECUTABLE=/usr/bin/chromium`.
- `Dockerfile:85` copies `uv`/`uvx` from `ghcr.io/astral-sh/uv:0.12.3` so Python
  MCP servers register; `UV_CACHE_DIR`/`UV_PYTHON_INSTALL_DIR` live on `/data`
  (:101-102).
- `Dockerfile:29,40` — **`npm ci --foreground-scripts` on both install lines**
  (`b97ad02`). A from-scratch install failed live with `ETXTBSY`: esbuild's
  postinstall spawns its just-written binary while overlayfs still counts a
  writer. If you see `ETXTBSY` in a build, this is the fix — do not remove the
  flag.
- `a1ceb78` / `fa773e0`: `npm prune` needs `--no-audit --no-fund` (it hung), and
  pruning no longer runs on every source change.

---

## 6. Static gates that are not ordinary unit tests

These fail in milliseconds and are the ones an implementer trips over most
often. None of them are in the pass-19 doc except in passing.

| Gate | File | What it enforces |
| --- | --- | --- |
| **Stylesheet integrity** | `app/app.css.test.ts` (2381 lines, 19 describes) | Every `var(--x)` resolves (:110); every `className` literal in `app/` has a rule (:602); focus ring (:177); dead/drifted rules (:255); WCAG AA on secondary tokens (:426); breakpoints (:802); touch reachability (:861); **the R19-12 whole-sheet contrast matrix (:1773) and the "no control hidden at any width" check (:2207)**. |
| **Copy ban** | `app/features/copy-ban.test.ts` (969 lines) | `govern/governance/governed/…` (regex :142) may not appear in rendered copy under `app/features`, `app/routes`, `app/ui`, `app.css` (:641), nor in string literals under `app/server`, `app/schemas`, `app/shared`, `app/lib` (:786), nor in seeded agent/skill assets outside named prompt text (:874). A hand-rolled comment stripper + literal lexer back it (:717, :744). :681 fails if a NEW top-level directory under `app/` is claimed by no scan. |
| **Retired vocabulary** | `app/features/copy-ban.test.ts:943` + `app/features/retired-vocabulary.test.tsx:53` | "primary specialist" is gone from copy, seeded assets, the mounted developer skill, the Task-contract KB, the workflow template, and operator chips (F19-12). |
| **PRD sync** | `app/shared/docs/prd-sync.test.ts:28` | `design/prd.md` is byte-identical to the canon PRD (ruling 27); reports diverging line numbers on failure. |
| **Hermeticity + import hygiene** | `app/server/runtimes/harness-hermeticity.server.test.ts:43,:109` | See §2. |

**The app.css trap worth knowing**: the contrast matrix computes each element's
backdrop from the sheet itself. When an element's painting ancestor is not in its
own selector, it needs an entry in `RENDERED_INSIDE`
(`app/app.css.test.ts:1540`+) naming the container and WHY — e.g. `log-line`,
`log-chip`, `log-file`, `lcaret`, `log-more` all resolve to `.console`, which
paints a fixed near-black fill in both themes. **An entry that stops being
consulted also fails**, so the map cannot rot. If you add a painted class inside
an unnamed container, expect this test to be the one that catches you.

---

## 7. Where a pass-18/19 finding's test lives (re-anchored at `b97ad02`)

Every anchor below was re-checked; **all of the pass-19 doc's line numbers had
moved**, and one row was outright wrong (see the R18-3 note).

| Finding | Test file | Describe / it (current line) |
| --- | --- | --- |
| **F18-5** writer lock | `app/server/db/data-root-lock.server.test.ts` | `verifyLockOwnership (F18-5 fail-closed)` :208; `startDataRootLockGuard (F18-5)` :294. |
| **R18-3 / F18-8** catalog strip | `app/server/runtimes/skill-mount.server.test.ts` | `stripUngovernedRepoCatalog (R18-3 / F18-8)` :57 — 5 `it`s incl. F19-15 live-mount preservation (:103) and the forged-marker case (:172). ⚠ **the pass-19 doc's §6 pointed at `specialist-run.server.test.ts:1510`; the function and its tests MOVED** — `specialist-run.server.test.ts:1821` is now only a comment saying so. |
| **R18-1** reviewer KB | `app/server/tasks/specialist-run.server.test.ts` | `R18-1 — a reviewer inherits the delivering engagement's KBs` :1881. Narrowed by `reviewer inheritance is KBs only (F19-2 / ruling 57)` at `skill-mount.server.test.ts:215`. |
| **R18-2 / F18-10** autonomy re-queue | `app/server/tasks/delivery-requeue.server.test.ts` | `R18-2 — a full-autonomy delivery re-queues the operator` :171. |
| **F18-6** ghost admin | `app/features/project-settings/ghost-members.server.test.ts` | :170. |
| **F18-13** force-accept | `app/features/task-detail/task-detail-components.test.tsx` | :1151. |
| **F18-4** KB folder-missing | `app/server/org/resources.server.test.ts` | :251 (`folderExists:false`). |
| **F18-1** notifications | `app/server/projections/notifications.server.test.ts` | :82 (unread badge excludes deleted-project rows). |
| **F18-7** apply-rec 409 | `app/server/tasks/acceptance-graph.server.test.ts` | :160. Note the comment at :321 — a pass-19 implementer once inverted this test. |
| **R18-5** native skill mounting | `app/server/runtimes/skill-mount.server.test.ts` (557 lines) | `isSdkSkillName` :243; `mountGrantedSkills` :272 — 10 `it`s: whole-folder copy (:273), grant-only (:301), frontmatter normalization (:323), symlink/unsafe-name refusal (:365), **no-checkout isolation gate** (:402), git stays clean and `.claude` never commits (:432, real git fixture), idempotence (:460), stripping an earlier run's `.claude` (:489), empty-mount rollback (:519), and F19-15 (:535). |
| **UXO-1** archived pills | `app/features/task-detail/task-detail-components.test.tsx` | :1995. |
| **B1** board acceptance confirm | `app/features/board/board-page.test.tsx` | `B1: accepting from the board asks first` :382. |
| **UXA-7** roving radiogroup | `app/ui/roving-radio.test.ts` | `rovingRadioKeyDown` (jsdom-headered `.test.ts`). |
| **LV-F1** password re-issue | `app/features/org-settings/users-panel.test.tsx` | :132. |
| **Ruling 27** PRD sync | `app/shared/docs/prd-sync.test.ts` | :28. |

Still untested-by-ID: F18-2, F18-9, F18-11, F18-12 (mobile profile grid — guarded
only indirectly by the `app.css.test.ts` breakpoint block, now :802), and **Q-V1**
(danger-zone render gate, owner ruling, shipped with no test).

---

## 8. Test additions since the pass-19 merge (`4184e95..b97ad02`, 12 commits)

Seven new test files; four commits are Dockerfile-only (§5b).

| Change | Test file(s) | What is asserted |
| --- | --- | --- |
| **R19-19** agents get a real browser | `app/server/tasks/specialist-browser-mcp.server.test.ts` (**NEW**, 137 lines) | `R19-19 resolveBrowserMcp` :28 — mounts NOTHING without an explicit direct grant (off/absent/recommend all withheld, :29); mounts the Playwright MCP CLI writing into the task's attachments dir (:48); **REFUSES the mount when web egress is withheld** (:76); absent egress = granted (catalog default, :92); image responses omitted on codex (:103); `--executable-path` + `--no-sandbox` only when `VIBERR_BROWSER_EXECUTABLE` is set (:120). |
| **R19-19** capability catalog | `app/shared/capabilities.test.ts:92`, `app/features/agents/capability-catalog.test.ts:40,52` | `capabilityEnforcement("use-browser") === "both"` — withheld ⇒ never mounted on either backend; `MODAL_CAP_IDS` is now **13** and lists `use-browser`. |
| **R19-19** no org-row spoofing | `app/server/tasks/specialist-mcp.server.test.ts:66` | `resolveSpecialistMcpServers` skips `viberr_browser` **and** `viberr-browser` org rows — the browser is capability-mounted, never a row. |
| **R19-19** attachments store | `app/server/files/task-attachments.server.test.ts` (**NEW**) | `listTaskAttachments` :30 (newest-first, skips dotfiles/dirs); `resolveTaskAttachment` :54 (**refuses traversal**: separators, dot-segments, absolute paths, :63); `attachmentContentType` :71 — images/pdf/text inline, **never html/svg/unknown** (:81, stored pages must not execute on the app origin). |
| **R19-19** member-only route | `app/routes/task-attachment.test.ts` (**NEW**) | :69 — inline image is sandboxed + nosniff + private (:70); stored HTML is download-only with a generic type (:81); a signed-in NON-member gets the same 404 an unknown project gets (R15-4, :88); missing file and every traversal shape 404 without an oracle (:93). |
| **R19-19** evidence linkify | `app/features/task-detail/attachments-panel.test.tsx` (**NEW**) | `AttachmentsPanel` :21 (nothing when empty; thumbnails from the member-only route; URL-encoded odd names, :45) and `TimelineItem evidence linkify` :69 — links a cited filename only when it names a REAL attachment (:70), **no guessed links** (:88), bare render for non-members (:99). |
| **R19-19** hermeticity | `test-support/setup-env.ts:52-55` | `VIBERR_BROWSER_EXECUTABLE` joins the scrub list (see §2). |
| **R19-18** background MCP warmup | `app/server/org/mcp-warmup.server.test.ts` (**NEW**, 121 lines) | `startMcpWarmup (R19-18)` :68 — flags the row `installing` then turns it green on its own (:69); records a real failure when the install never produces a server (:87); **a restart never leaves a row claiming to install with nothing running** (:103). Row copy: `org-settings-page.test.tsx:400` ("installing on first use", not "unreachable"). |
| **R19-17 / 17b / 17c** MCP failure honesty | `app/server/org/resources.server.test.ts:480` (`mcp servers`) | a crashing stdio server explains itself on stderr (:554, the reason carries the spawn's own words e.g. `ENOENT`, :696); a still-fetching command is not a broken one (:595); the reason **PERSISTS on the row** (:626). UI: `org-settings-page.test.tsx:373` (why, not just a red dot) and :428 (healthy shows no error line). |
| **P19-RC1** run console | `app/features/runtime/runs-helpers.test.ts` + `runs-panels.test.tsx` (765 lines) | `groupThoughts` :232 (folds a RUN of reasoning lines, never across intervening work :242, lone line stays a row :256, **NO-OP under raw** :262); `thoughtLabel` :276 (measures the span from stored clocks, omits what it cannot measure); `toolChip` :299. Panel-side: folded reasoning with the raw toggle still complete (:144), tool/file chips (:175), multi-line output lifted into a bounded copyable block (:212), diff polarity (:238), telemetry folded into one row (:269). |
| **P19-RC1** stylesheet | `app/app.css.test.ts:1549-1556` | New `RENDERED_INSIDE` entries (`log-chip`, `log-file`) pin the new chips' backdrop to `.console`. |
| **R19-16** GitHub/Google sign-in | `app/server/auth/oauth-providers.server.test.ts` (**NEW**, 217 lines) | `R19-16 oauth provider store` :22 — the stored column is never plaintext (:23); **saving never enables, and enabling REFUSES without a passing test** (:38); changing a credential clears the verdict and switches the method off (:61); a FAILED test takes a live provider back off (:85); omitted secret keeps the stored one (:101); fingerprint moves on every change the auth instance must see (:113); every mutation lands in the audit trail (:143). `R19-16 credential test` :172 — GitHub 401=bad / 404=good (:173), Google `invalid_client`=bad / `invalid_grant`=good (:187), **an unreachable provider is a negative result, never a throw** (:206). |
| **R19-16** UI + rotation | `app/features/org-settings/sso-panel.test.tsx` (**NEW**) | per-provider callback URL (:41); Set up before Test/Turn-on (:54); Turn on stays DISABLED until credentials pass (:66); states the LIMIT of a passing test (:75); says when the app's OFF switch overrides the deployment env (:93). `app/server/secrets/key-rotation.server.test.ts:224,234` adds `oauth_providers` to the rotation inventory. |
| **Public-repo import** | `app/server/org/store-files.server.test.ts:185` | imports a PUBLIC repo with NO connection at all, sending no `Authorization`. Route side: `org-settings-route.server.test.ts:298` (an anonymous import that 404s is the honest failure; the transport is stubbed to keep the suite hermetic). |

---

## 9. Conventions for future implementers

- **Canary rule**: after adding a fix + test, revert the fix and confirm the new
  test fails, then restore. Recorded per finding in `FINDINGS.md`.
- **`tsc` is a required gate** — `npm run build` is NOT a typecheck; run
  `npm run typecheck` (`react-router typegen && tsc`). Re-proven in pass 19
  (`b0f3f99` existed only because a helper rename landed without its two call
  sites). Run the FULL suite + typecheck, never just the touched files — the
  suite is 31 s.
- **Never add a network dependency to a test.** `GIT_ALLOW_PROTOCOL=file` is set
  suite-wide (`setup-env.ts:111`); a test that needs a real transport must set it
  for its own child process, and should not exist here.
- **New rendered copy** must clear `copy-ban.test.ts` (no `govern*`, no "primary
  specialist"). **New painted classes** must clear `app.css.test.ts` — including a
  `RENDERED_INSIDE` entry if the backdrop is not in the selector. **A new
  top-level directory under `app/`** fails `copy-ban.test.ts:681` until it is
  classified.
- **Live-verify recipe**: stop the container, point a worktree `.env` at
  `docker-data`, run the dev server — but NEVER run a host dev server and the
  container against the same `docker-data` root at once (the F18-5 dual-writer
  hazard; the guard fails closed, but do not rely on it).
- New forms need a `_csrf` field; the app-test harness supplies `csrfFor()`.
- jsdom caveats: dialogs close on a JS `.click()`; `showModal`/`ResizeObserver`
  come from `setup-dom.ts`; a `.test.tsx` still needs the
  `// @vitest-environment jsdom` header — the default environment is `node`.
- Assert on the runtime seam, not on internals: `lastRunSpec()` /
  `startedRunSpecs()` from `test-support/fake-runtime.ts` is where prompt,
  systemPrompt, denylist, mounted skills and mounted MCP servers are visible.
