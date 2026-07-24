# Testing quickstart

Run these from the repository root after `npm ci`, using Node.js 26 or newer.

## Unit tests

Run the Vitest unit and integration suite:

```sh
npm test
```

### Run the unit suite

Use `npm run test` before pushing changes to verify the unit tests still pass.

## Typecheck

Generate React Router types and run TypeScript checks:

```sh
npm run typecheck
```

## Production build

Build the same artifact CI validates:

```sh
npm run build
```

## End-to-end

CI's second job. It is the only gate that runs a real CLI entrypoint, so run it
before opening a PR even when the three above are green:

```sh
npm run e2e
```
