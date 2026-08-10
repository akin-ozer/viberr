# TESTING-INFRA — Viberr current state (pass 19)

> Verified against main @65063b8 on 2026-08-06 (pass 19).

The test setup, the hermetic environment, the fake runtime, the e2e model, and
the pass-18/19 test additions. Anchors re-verified against `main @65063b8`.
Vitest 4.1.10, Node 26.5.0. Test command: `npm test` → `vitest run`.

---

## 1. Test runner config (`vitest.config.ts`)

Single config, **no** workspace/project split.

- **Environment**: `node` globally (`vitest.config.ts:11`). There is no separate
  jsdom project — the **38** component/UI test files opt into jsdom **per-file**
  via a `// @vitest-environment jsdom` header comment (e.g.
  `app/features/profile/profile-page.test.tsx:1`).
- **Setup files** (:15): `["./test-support/setup-env.ts", "./test-support/setup-dom.ts"]`.
- **Include** (:21): `["app/**/*.test.{ts,tsx}"]`, no explicit exclude. (A former
  `db/**/*.test.ts` glob was dropped, :16-20.)
- **Path alias**: `resolve.tsconfigPaths: true` — Vite 8 native `~/*` resolution
  (the `vite-tsconfig-paths` plugin was removed).
- **Coverage**: none configured.

`vite.config.ts` is the app dev/build config (React Router plugin), not the test
config; it excludes the runtime data root from the dev watcher.

---

## 2. Hermetic environment (`test-support/setup-env.ts`)

Runs before any app module. Guarantees a suite can never make a paid provider call
or read host credentials:

- **Seeds required secrets** so boot validation passes on a fresh clone with no
  `.env`: `VIBERR_SESSION_SECRET` (:19) and a 32-byte base64
  `VIBERR_SECRET_ENCRYPTION_KEY` (:22-23), both via `??=` so real exports still win.
- **Credential scrub (F10-10 fail-closed)** (:44-54): sets `ANTHROPIC_API_KEY`,
  `CLAUDE_CODE_OAUTH_TOKEN`, `VIBERR_CLAUDE_USE_CLI_AUTH`, `CODEX_ACCESS_TOKEN`,
  `CODEX_API_KEY`, `OPENAI_API_KEY`, `VIBERR_CODEX_USE_CLI_AUTH` to `""` (NOT
  `delete` — `env.server.ts` runs `loadEnvFile()` at module scope AFTER setup and
  would refill deleted keys, re-opening the leak; `""` reads as absent yet blocks
  the refill).
- **Transcript stores pinned to empty temp dirs (P13-D-2)** (:81-85): `CLAUDE_CONFIG_DIR`
  and `CODEX_HOME` point at empty temp subdirs, so the continuity probe is
  deterministic (store exists but empty → `missing`) and `CODEX_HOME` stays out of
  the scrub list (an empty dir with no `auth.json` keeps CLI-auth false by
  construction).

`test-support/setup-dom.ts` is the jsdom shim: polyfills
`HTMLDialogElement.showModal/show/close` and stubs `ResizeObserver` for dnd-kit;
no-ops under node.

**Harness-hermeticity self-test**:
`app/server/runtimes/harness-hermeticity.server.test.ts` (`describe` :43) asserts
every credential is `""` not deleted (:50), both backends report unavailable (:56),
`CODEX_HOME` exists with no `auth.json` (:61), and a `.env` carrying all
credentials cannot reload into the process (:74). A second `describe` (:109)
enforces import hygiene (no phantom/hoisted imports).

---

## 3. Test helpers (`test-support/`)

| File | Provides |
| --- | --- |
| `test-db.ts` | `createTestDbContext()` → `{ makeDb(), makeTempDir(), cleanup() }`. `makeDb()` opens a temp SQLite DB + runs migrations (:34-41). |
| `test-store.ts` | `setupTestStore(ctx)` → temp data root + migrated DB + a seeded `viberr-core` project with 5 users at distinct project roles (arda=admin, murat=maintainer, selin=contributor, elif=viewer, deniz=non-member, :52-100). Exports `writeProject`, `baseTaskFrontmatter`, `writeTask`. |
| `test-app.ts` | `setupAppTest()` — route-level harness (:36): temp data root, resets env+db singletons, **installs the fake runtime** (:62-63), returns `cookieFor()`/`csrfFor()`/`request()` builders for real signed-cookie + CSRF requests. Exports `APP_TEST_PASSWORD`. |
| `fake-runtime.ts` | The agent-runtime stub (below). |
| `fake-github.ts` | Fake GitHub API/client. |
| `demo-seed.ts`, `demo-data.ts` | Demo fixture seeding (also used by the e2e stack). Exports `SEED_DEFAULT_PASSWORD`. |
| `audit-log.ts`, `custom-board.ts` | Smaller fixtures. |

**Fake runtime** (`fake-runtime.ts`) — so no real Claude/Codex is spawned:
`installFakeRuntime()` (:45-53) clears queued runs + started specs and calls
`configureRunServiceForTests({ claude, codex })` with fake adapters;
`queueFakeRun(run, backend)` (:41) enqueues scripted output lines;
`startedRunSpecs()` (:32) and **`lastRunSpec()`** (:37) let a test assert exactly
what reached the runtime (prompt/systemPrompt, denylist, mounted MCP servers). The
fake adapter's `start()` pushes the spec and replays queued/default lines via
`queueMicrotask`, then calls `onExit` deterministically (:55-103). This is the seam
the R18-1 KB test asserts on (`lastRunSpec()?.systemPrompt`).

---

## 4. Scale (pass 19)

- `npx vitest --version` → `vitest/4.1.10 darwin-arm64 node-v26.5.0`.
- **219 test files** (`app/**/*.test.{ts,tsx}`) — 183 `.test.ts` + 36 `.test.tsx`.
  216 existed at `6656d6f`; the three added since are
  `app/server/runtimes/skill-mount.server.test.ts`,
  `app/ui/roving-radio.test.ts`, `app/shared/docs/prd-sync.test.ts`.
  (The pass-18 doc said 215/179 — it was one low.)
- **~2874** `it()`/`test()` call sites by static count; the last branch commits
  report **2892** tests green from an actual run (the static count under-reads
  `it.each` expansions).
- 38 files carry the `// @vitest-environment jsdom` header.

---

## 5. e2e model (production Docker image; dev server banned)

- **Playwright config** (`playwright.config.ts`): `testDir: "e2e"`, single worker,
  `fullyParallel: false` (shared seeded store). **No `webServer` block** — the base
  URL comes from `VIBERR_E2E_BASE_URL`, and the config THROWS if it is unset
  (:17-25), enforcing the "no bare `npx playwright test`" discipline.
- **Production-image discipline** (owner policy 2026-08-02, documented at
  `playwright.config.ts:6-14` and `scripts/e2e.ts:1-13`): e2e ALWAYS runs the
  production Docker image, never a dev server.
- **Orchestration**: `npm run e2e` → `scripts/e2e.ts` runs
  `docker compose -f compose.e2e.yml -p viberr-e2e`: `down --volumes` → `up --build
  --wait` → derives the random host port via `compose port app 3000` → waits for
  `/resources/health` → runs `npx playwright test` with `VIBERR_E2E_BASE_URL` →
  tears down (`--volumes`, unless `VIBERR_E2E_KEEP=1`).
- **Compose stack** (`compose.e2e.yml`): a `seed` one-shot (`npm run seed:demo`,
  chowns `/data` to UID 1000) feeds an `app` service running the final production
  image (`NODE_ENV: production`, synthetic secrets only, project-scoped named
  volume). App build/run: `Dockerfile`, `compose.yml`, `scripts/docker-entrypoint.sh`.
- **Auth**: `e2e/auth.setup.ts` — the `setup` project logs in once through the real
  `/login` UI as `arda@viberr.dev` (`SEED_DEFAULT_PASSWORD`) and saves storage
  state to `e2e/.auth/arda.json`; the `chromium` project depends on `setup` and
  reuses it.
- **Specs**: 7 spec files (`e2e/01-home-board.spec.ts` … `07-accessibility.spec.ts`)
  + `auth.setup.ts`, ~32 `test()` cases. The a11y spec uses `@axe-core/playwright`.

---

## 6. Pass-18 test additions (per finding)

Every pass-18 fix was canary-verified (each test fails when its fix is reverted).

| Finding | Test file | Describe / it |
| --- | --- | --- |
| **F18-5** writer lock | `app/server/db/data-root-lock.server.test.ts` | `verifyLockOwnership (F18-5 fail-closed)` :208; `verifyLockOwnership (injected probes)` :238; `startDataRootLockGuard (F18-5)` :294. UI: `home-page.test.tsx:414` names the writer holder. |
| **R18-3** SDK catalog strip | `app/server/tasks/specialist-run.server.test.ts` | `stripUngovernedRepoCatalog (R18-3 / F18-8)` :1510 — asserts the strip stages no `.claude` deletion into the delivery diff. Also `claude-runtime.server.test.ts:313` (only Viberr-granted MCP reach a run). |
| **R18-1** reviewer KB | `app/server/tasks/specialist-run.server.test.ts` | `R18-1 — a reviewer inherits the delivering engagement's KBs` :1559, incl. the no-double-inject case :1625. Asserts `lastRunSpec().systemPrompt` carries the deliverer's KB sentinel. |
| **R18-2 / F18-10** autonomy re-queue | `app/server/tasks/delivery-requeue.server.test.ts` (new) | `R18-2 — a full-autonomy delivery re-queues the operator` :134 — one follow-up operator run with the `delivered` trigger; supervised does NOT re-trigger; `created:false` reuse does not; no-operator no-op. |
| **F18-6** ghost admin | `app/features/project-settings/ghost-members.server.test.ts` | `F18-6: a GHOST admin that is the project's ONLY admin IS removable` :170. |
| **F18-13** force-accept | `app/features/task-detail/task-detail-components.test.tsx` | `F18-13: renders NO force-accept … on a terminal task` :966. |
| **F18-4** KB folder-missing | `app/features/org-settings/org-settings-page.test.tsx:542` + `app/server/org/resources.server.test.ts:208` (`folderExists:false`). |
| **F18-3** OAuth | `app/features/org-settings/users-panel.test.tsx:90` (modal keys off configured providers); `app/features/profile/profile-page.test.tsx:184` (quiet one-liner). |
| **F18-1** notifications | `app/server/projections/notifications.server.test.ts:81` (unread badge excludes deleted-project rows). |
| **F18-7** apply-rec 409 | `app/features/.../acceptance-graph.server.test.ts:158` (unknown recommendation id 409s). |

**Not ID-tagged by a test**: **F18-12** (mobile profile-grid) has NO test
referencing the ID or `.profile-grid` — it was live-verified at 375 px only, and
the grid stack is guarded indirectly by the `app.css.test.ts` breakpoint validation
(:782-802). Profile rendering is covered generally by `profile-page.test.tsx`.
Also untested by ID: F18-2, F18-9, F18-11 (F18-11's fix ships as the R18-1 test).

---

## 6b. Pass-19 test additions (the 12 app-touching commits after `6656d6f`)

| Finding | Test file | Describe / it |
| --- | --- | --- |
| **R18-5** native skill mounting | `app/server/runtimes/skill-mount.server.test.ts` (NEW, 385 lines) | `stripUngovernedRepoCatalog (R18-3 / F18-8)` :56; `isSdkSkillName` :103; `mountGrantedSkills` :132 — 9 `it`s covering whole-folder copy (:133), grant-only mounting (:161), frontmatter normalization (:183), symlink + unsafe-name refusal (:225), the **no-checkout isolation gate** (:262), `git status` staying clean and `.claude` never reaching a commit (:292, real git fixture), mount idempotence (:320), stripping an EARLIER run's `.claude` (:340), and the empty-mount rollback (:370). |
| **R18-5** adapter shape | `app/server/runtimes/claude-runtime.server.test.ts` | asserts `settingSources:['project']` + `skills:[…]` + `Skill` un-denied with mounted skills (:349), the unsafe-name filter (:378, :385), and that bundled SDK skills still need the deny (:407). |
| **R18-5** persona seam | `app/server/tasks/specialist-run.server.test.ts` | `does NOT inject a natively-mounted skill's body, but still injects the ones that did not mount` :1528 (incl. the stale-mount case :1573); `granted skills reach a Claude run NATIVELY (pass-18)` :1681 — covers the Codex leg (:1768), the no-workspace leg (:1786) and resume parity (:1800). |
| **R18-5** resume plumbing | `app/server/tasks/agent-reply.server.test.ts`, `app/server/runtimes/run-service.server.test.ts` | `resolveResumeConfinement` is async and re-applies `skills` on resume. |
| **R18-1** rename repair + **UXO-1** | `app/features/task-detail/task-detail-components.test.tsx:1508` | `UXO-1: an archived task drops the readiness + validation pills, keeps the stage` (canaried: neutering either guard reproduces "archived · Review · ready · awaiting verdict"). |
| **B1** board acceptance confirm | `app/features/board/board-page.test.tsx:370` | `B1: accepting from the board asks first` — 3 tests incl. `cancelling the confirm never posts the acceptance` :393. |
| **UXA-2** PR-state map | `app/features/review/review-page.test.tsx` | the R16-3 test now asserts the **rejection tone** instead of the incidental neutral class. |
| **UXA-7** roving radiogroup | `app/ui/roving-radio.test.ts` (NEW) | `rovingRadioKeyDown` :40 — forward/back + key claim :41, wrap :52, skips disabled :61, starts from the checked option :68, ignores unowned keys :75. |
| **UXA-4** capability radiogroup | `app/features/agents/agents-page.test.tsx` | asserts the `role="radiogroup"` contract and that exactly one option is `aria-checked`. |
| **UXA-16** Policy stamp | `app/features/policy/policy-route.server.test.ts` | `latestPolicyChange` returns raw `at`, not a server-formatted `t`. |
| **LV-F1** password re-issue | `app/features/org-settings/users-panel.test.tsx:132` | `LV-F1: a pending reset never hides the re-issue action` — new account still offers a new temp password (:165); an established account keeps plain Reset (:178). |
| **LV-F2 / UXA-3** read-only settings | `app/features/project-settings/settings-page.test.tsx` | `explains the read-only state to a role without the grant` :142; `tells a non-admin WHY the stages are inert, and stops giving drag/rename instructions` :258. |
| **UXA-15** agents read-only | `app/features/agents/agents-page.test.tsx` | the lock note naming the **Manage agents** grant. |
| **Ruling 27** PRD sync | `app/shared/docs/prd-sync.test.ts` (NEW) | `ruling 27: the two PRD copies stay in sync` :28 → `design/prd.md is byte-identical to the canon PRD` :29 — reports the DIVERGING LINE NUMBERS on failure. |

**Q-V1** (Danger zone hidden from non-lifecycle members, `0efe0d7`) ships with
**no new test** — the commit body records it as an owner ruling applied to a
render gate, and notes the PAT half is deliberately NOT implemented.

---

## 7. Conventions for future implementers

- **Canary rule**: after adding a fix + test, revert the fix and confirm the new
  test fails, then restore. Recorded per finding in `FINDINGS.md`.
- **`tsc` is a required gate** — `npm run build` is NOT a typecheck; run `tsc`
  separately (pass-12 self-bug). **Re-proven in pass 19**: `b0f3f99` exists only
  because a helper rename landed without its two call sites, leaving `tsc` red
  and 9 tests failing on the branch. Run the FULL suite + `tsc`, never just the
  touched files.
- **Live-verify recipe**: stop the container, point a worktree `.env` at
  `docker-data`, run the dev server — but NEVER run a host dev server and the
  container against the same `docker-data` root at once (the F18-5 dual-writer
  hazard; the guard now fails closed, but do not rely on it).
- New forms need a `_csrf` field; the app-test harness supplies `csrfFor()`.
- jsdom caveats: dialogs close on a JS `.click()`; `showModal`/`ResizeObserver`
  come from `setup-dom.ts`.
