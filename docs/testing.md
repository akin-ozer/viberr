# Running the test suites

Run these from the repository root after `npm ci`, using Node.js 26+.

## Unit suite

```sh
npm test
```

Runs Vitest over `app/` and `db/` only (`vitest.config.ts`). Env secrets are
seeded automatically, so no `.env` file is required.

`scripts/` is deliberately outside the include globs — the dead glob was
removed in pass 12 — so a `scripts/*.test.ts` file is never collected. Cover
script behavior by extracting it into `app/` and testing it there, or through
the e2e suite, which actually executes the CLI entrypoints. This is not a
theoretical gap: `scripts/` is the one directory whose lack of coverage let the
pass-13 `npm run seed` regression through.

## Lint

```sh
npm run lint
```

Oxlint with the vendored `anti-slop` plugin (`tools/oxlint/anti-slop`, config
`.oxlintrc.json`). A required CI gate since 2026-08-19 (ruling 86 / R21-3): it
must exit **0**, and there is no suppression list or accepted-findings allowlist,
so anything it reports at `error` severity is a new violation to fix. Warnings are
printed but do not fail the gate.

**Install the two packages before you trust a green.** A fresh worktree has no
`node_modules`, so `npm run lint` prints nothing and "passes" — a green that means
the plugin never loaded. Restore it without touching the lockfile; the two versions
must match:

```sh
npm i --no-save oxlint@1.79 @oxlint/plugins@1.79
```

Never run that while a `vitest run` is in flight — mutating `node_modules`
mid-run produced 688 phantom test failures (2026-08-26).

*(Restored 2026-08-31, pass 31 — A1. The "must exit 0" promise above had gone
false: the tree carried 26 `anti-slop` errors across 15 files. They were FIXED, not
allowlisted — which is the only remedy ruling 86 / R21-3 permits — so the promise
holds again. If you find it false in future, that is the bug; amending this sentence
is not the fix.)*

## E2E suite

```sh
npm run e2e
```

Runs the whole Playwright suite against the **production Docker image** in an
isolated Compose stack — **never a dev server** for any app-serving test (owner
policy, 2026-08-02). `npm run e2e` runs `scripts/e2e.ts`, which drives
`compose.e2e.yml` (project `viberr-e2e`): it tears down any leftover stack,
brings a fresh one up on a project-scoped **named Docker volume** (a seed
one-shot writes the store, then the production app boots against it), waits for
`/resources/health`, runs `playwright test` against the derived base URL, and
tears the stack down with its volume afterwards. It never touches a developer's
local `./data` store. `VIBERR_E2E_KEEP=1` keeps the stack up for debugging.
The seed is the **demo fixture** (`npm run seed:demo`), not the product seed —
the specs are written against the mock dataset, which the product seed no longer
ships.

**One browser: chromium.** `playwright.config.ts` declares a single BROWSER
project (`chromium` / `devices["Desktop Chrome"]`) and CI installs that browser
alone. The config's other project, `setup`, is a login fixture — it signs in
once through the real `/login` UI and stores the session state the chromium
project depends on — not a second browser.
The PRD's browser matrix is Chromium-only (owner decision 2026-08-31: Safari
and Firefox were declared intent that nothing ever exercised, so they were
struck rather than left implied). This suite's chromium project therefore
covers the whole declared matrix.

## Test data: two sanctioned ways to build state

1. **Through the product's own actions** (`createTask`, `transitionStage`,
   `assignSpecialist`, `resolvePacket`, …) on a minimal store from
   `test-support/test-store.ts`. Prefer this for behavior tests — state built
   by the real writers can never drift from what the product does.
2. **The demo fixture** (`test-support/demo-seed.ts` + `demo-data.ts`): the
   hand-written mock dataset the route-level and e2e suites are written
   against. Hand-written canonical files are a REAL input class here — the
   store is human-editable by design — so this is legitimate coverage, but it
   can silently go stale as the schema evolves (loose parsing tolerates
   unknown keys without a diagnostic). Two drift guards in
   `app/server/seed/demo-fixture.test.ts` trip that wire: every fixture file
   must parse with **zero unknown frontmatter** and round-trip the current
   serializers, and a task written by the real `createTask` must land just as
   clean in the fixture store. When a schema change fails those guards,
   migrate the fixture in the same change.

Known residual risk: a field the schema still *knows* but the product no
longer *writes* (dead-but-tolerated) passes both guards — that class is
caught by the periodic full product passes, not automation.

## Hermetic runs with `VIBERR_DATA_ROOT`

`VIBERR_DATA_ROOT` controls where the app reads/writes canonical files and
SQLite projections; it defaults to `./data`. The e2e config already sets
it to a scratch directory for you. For the unit suite — or any manual/ad
hoc run that touches the file store — point it at a temp directory first
so the run stays isolated from real project data:

```sh
VIBERR_DATA_ROOT=$(mktemp -d) npm test
```

Useful if you're iterating locally and don't want a run to seed, mutate,
or delete files under your real `./data`.

## Operator narration is stored verbatim

Tests that exercise operator comments should expect the narration to reach the
canonical record UNTRUNCATED, however long (owner ruling 2026-08-31 removed the
old operator-brevity hard cap, which destroyed the overflow at write time).
Length is handled view-side: the timeline's `CollapsibleComment`
(`app/features/task-detail/timeline.tsx`) clamps tall comments behind a
Show more toggle, for operator narration and agent replies alike. The
remaining write-time guardrails (`meaningful-comment`, `evidence-separation`,
`no-duplicate-summary`, `compression-threshold`) are still enforced per
project through the `guardrails` array in the project's canonical frontmatter.

See also: [testing-quickstart.md](./testing-quickstart.md).
