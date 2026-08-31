# Testing quickstart

Run these from the repository root after `npm ci`, using Node.js 26 or newer.

## Unit tests

Run the Vitest unit and integration suite:

```sh
npm test
```

### Run the unit suite

Use `npm run test` before pushing changes to verify the unit tests still pass.

## Lint

Run oxlint with the vendored `anti-slop` plugin. It is a required CI gate and must
exit 0 — findings are fixed, not suppressed (ruling 86 / R21-3):

```sh
npm run lint
```

In a worktree (or any checkout without `node_modules`) the plugin silently fails to
load and the command "passes" without linting anything. Install both packages at the
same version first, off the lockfile — and never while a `vitest run` is in flight:

```sh
npm i --no-save oxlint@1.79 @oxlint/plugins@1.79
```

See [testing.md](./testing.md#lint) for why.

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
before opening a PR even when the four above are green (it runs one Playwright
browser project, `chromium`, behind a `setup` login fixture — since 2026-08-31
the PRD's browser matrix is Chromium-only, so this covers the declared matrix):

```sh
npm run e2e
```
