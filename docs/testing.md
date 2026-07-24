# Running the test suites

Run these from the repository root after `npm ci`, using Node.js 26+.

## Unit suite

```sh
npm test
```

Runs Vitest over `app/`, `db/`, and `scripts/`. Env secrets are seeded
automatically, so no `.env` file is required.

## E2E suite

```sh
npm run e2e
```

Runs Playwright against a real dev server. The config wipes and reseeds an
isolated data root (`e2e/.tmp-data`) before each run, so it never touches a
developer's local `./data` store. It seeds the **demo fixture**
(`npm run seed:demo`), not the product seed — the specs are written against
the mock dataset, which the product seed no longer ships.

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

## Operator-brevity guardrail

Tests that exercise operator comments should expect narration to be hard-capped
at `OPERATOR_BREVITY_MAX_CHARS` (1000 chars), with overflow trimmed and a
marker appended; this is enforced in
`app/server/tasks/comment-guardrails.server.ts` (`enforceOperatorBrevity`), is
ON by default for every project via `DEFAULT_GUARDRAILS` in
`app/shared/workflow/templates.ts`, and can be toggled per project through the
`guardrails` array in that project's canonical frontmatter.

See also: [testing-quickstart.md](./testing-quickstart.md).
