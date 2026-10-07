# Contributing to Viberr

Thanks for helping build Viberr. This guide covers setting up a development environment,
the branch and pull-request workflow, the checks a change must pass, and how changes are
reviewed. If you work with a coding agent, point it at [AGENTS.md](AGENTS.md) first.

## Development setup

You need Node.js 26 or newer and npm. Docker is needed only for `npm run e2e`.

```sh
git clone https://github.com/akin-ozer/viberr.git && cd viberr
cp .env.example .env   # every variable is optional; the two secrets are generated on first run
npm ci
npm run seed           # baseline content and the bootstrap admin (migrations apply at boot)
npm run dev            # http://localhost:5173
```

`npm run seed` is a clean sheet: the built-in agent catalog, example knowledge bases and
skills, and, while the users table is empty, a bootstrap admin (`admin@viberr.dev` /
`viberr-dev-2828` unless `VIBERR_SEED_ADMIN_EMAIL` / `VIBERR_SEED_ADMIN_PASSWORD` are set).
It creates no board data. For the demo dataset the route-level and e2e specs are written
against, run `npm run seed:demo` instead and sign in as `arda@viberr.dev` with the same
password.

`.env.example` points `VIBERR_DATA_ROOT` at `./docker-data`, the dev server's store. The
Docker setup uses the named volume `viberr-data` instead (ruling 460), so the dev server
and the container never share a store. Only one process may hold a store: a second one,
or a seed against a running app, is refused by the data-root writer lock.

## Branches and pull requests

- Branch off `main` with a short descriptive name (`fix-board-filter`, `epic-filters`).
- Keep commits focused, with clear messages.
- Open a pull request against `main`. Every change lands through one; nothing is pushed
  to `main` directly.
- CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs two jobs: `verify`
  (lint, typecheck, the unit and integration suite, the build and the bundle ratchet) and
  `e2e` (Playwright against the production Docker image in an isolated Compose stack).
  Both must pass before merge.

## Checks to run before you push

```sh
npm run lint        # oxlint with the vendored anti-slop rules; must exit 0 (ruling 86)
npm run typecheck   # route typegen + tsc
npm test            # vitest unit + integration suite
npm run build       # production build
node scripts/measure-routes.mjs --check   # bundle budgets, after the build (ruling 457)
npm run e2e         # Playwright vs the production Docker image (needs Docker)
```

Lint has no suppression list: fix what it reports, never allowlist it. Performance
budgets only move down ([docs/development/performance.md](docs/development/performance.md)).
Don't skip `npm run e2e` because the others are green: it is the only check that boots
the image people actually install.

What each check runs, the test harnesses under `test-support/`, and the authoring rules
every new test meets: [docs/development/testing.md](docs/development/testing.md).

## Review and acceptance

- Keep route modules thin, put behaviour in feature and server modules, and write
  canonical files only through the writers in `app/server/files/`, so the markdown and
  the SQLite projections stay in step.
- Preserve authorization, audit and typed error paths when you change a governed action.
- Follow the canonical file formats in
  [docs/architecture/file-formats.md](docs/architecture/file-formats.md) and the binding
  rulings in [docs/architecture/decisions.md](docs/architecture/decisions.md). If a change
  contradicts a numbered ruling, say so in the pull request and get it re-ruled; never
  reverse one silently.
- Update the matching page under [`docs/`](docs/README.md) in the same pull request when
  you change behaviour.
- Reviewers look for correctness, a test at the boundary that owns the change, adherence
  to existing patterns, and no regression to documented behaviour. The README's
  [Known limitations](README.md#known-limitations) are deliberate scope boundaries; don't
  widen one inside an unrelated change.
- A pull request is accepted with green CI and a reviewer's approval.

## Where to look next

- [docs/README.md](docs/README.md): the documentation index and reading order.
- [docs/development/contributing.md](docs/development/contributing.md): where code goes,
  the invariants to keep, the docs that tests pin, and the definition of done.
- [docs/architecture/overview.md](docs/architecture/overview.md): the system in one read.
- [docs/operations/](docs/operations/): deployment, configuration and the runbook.
