# Testing quickstart

Run these from the repository root after `npm ci`, using Node.js 26 or newer.

## Unit tests

Run the Vitest unit and integration suite:

```sh
npm test
```

## Typecheck

Generate React Router types and run TypeScript checks:

```sh
npm run typecheck
```

## Playwright end-to-end tests

Install Chromium once with `npx playwright install chromium`, then run:

```sh
npm run e2e
```

For hermetic CI, run `export VIBERR_DATA_ROOT="$(mktemp -d)"` before the test gates.
Playwright also resets and uses its own `e2e/.tmp-data` sandbox.
