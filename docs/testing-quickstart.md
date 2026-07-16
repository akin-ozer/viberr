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

For hermetic local or CI runs, use `VIBERR_DATA_ROOT=$(mktemp -d) npm run e2e`.
This isolates files, SQLite projections, and logs from real data.
