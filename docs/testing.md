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
developer's local `./data` store.

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

See also: [testing-quickstart.md](./testing-quickstart.md).
