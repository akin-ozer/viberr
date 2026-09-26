# Contributing to Viberr

Thanks for helping build Viberr. This guide covers environment setup, the branch/PR
workflow, running the test suite, and how changes get reviewed and accepted.

## Dev environment setup

Requirements: Node >= 26, npm.

```sh
git clone <this-repo> viberr && cd viberr

# 1. Environment — copy the template; every variable is optional (the two
#    secrets are generated into the data root on first run; see .env.example)
cp .env.example .env

# 2. Install
npm ci

# 3. Baseline data (migrations auto-apply at boot)
npm run seed

# 4. Run
npm run dev        # http://localhost:5173
```

`npm run seed` is a clean sheet: the built-in agent catalog, knowledge bases and skills,
plus a bootstrap admin (`admin@viberr.dev` / `viberr-dev-2828` unless
`VIBERR_SEED_ADMIN_EMAIL` / `VIBERR_SEED_ADMIN_PASSWORD` are set) when the users table is
empty. It ships no demo board data. If you want the mock dataset the route-level and e2e
specs are written against, run `npm run seed:demo` instead (sign in as
`arda@viberr.dev` with `VIBERR_SEED_ADMIN_PASSWORD`, or `viberr-dev-2828` when it is
unset).

`.env.example` points `VIBERR_DATA_ROOT` at `./docker-data`, the dev server's store. The
Docker setup mounts the named volume `viberr-data` instead (ruling 460: every agent runs
as its person's own OS user, and a macOS bind mount enforces no permissions between
users), so the dev server and the container no longer share a store. Only one process may
hold a store: a second one (or a seed against a running app) is refused by the data-root
writer lock.

See the [README](README.md) for the full quickstart, the bootstrap-admin credentials,
Docker setup, and pointers into the architecture docs, and
[`docs/README.md`](docs/README.md) for the code-verified documentation set (agents: read
[`AGENTS.md`](AGENTS.md) first).

## Branch / PR workflow

- Branch off `main`, using a short descriptive branch name (e.g. `fix-board-filter`,
  `generic-agents`).
- Keep commits focused and use clear, descriptive commit messages.
- Open a pull request against `main`. CI (`.github/workflows/ci.yml`) must pass before
  merge. It runs two jobs: `verify` (lint → typecheck → unit/integration tests → build) and
  `e2e` (Playwright against the production Docker image in an isolated Compose stack —
  `scripts/e2e.ts` builds it, seeds the demo fixture, and tears it down; never a dev
  server).
- Merge via GitHub once CI is green and the PR has been reviewed and accepted (see
  below).

## Running the test suite

Run these from the repository root after `npm ci`:

```sh
npm run lint        # oxlint + the vendored anti-slop plugin — a required gate (ruling 86)
npm run typecheck   # route typegen + tsc
npm test            # vitest unit + integration suite
npm run build       # production build, the `verify` job's final gate
npm run e2e         # Playwright vs the production Docker image — CI's second job
```

`npm run lint` must exit 0: findings are fixed, never left standing as "accepted" —
there is no suppression list, so anything it reports is new (ruling 86 / R21-3).

Don't skip `npm run e2e` because the other four are green. It is the only gate that
boots the shipped production image end to end (Docker required): the pass-13 install
regression passed typecheck, the whole unit suite and the build, and was caught here.

See [docs/development/testing.md](docs/development/testing.md) for what each gate runs,
the harnesses under `test-support/`, and the two sanctioned ways to build test state.

## Code review & acceptance

- Every change lands through a pull request — no direct pushes to `main`.
- CI must pass (lint, typecheck, tests, build, e2e) before a PR is considered mergeable.
- Keep route modules thin, put domain behavior in feature/server modules, and use the
  existing file writers so canonical markdown and SQLite projections stay in sync.
- Preserve authorization, audit, and typed error paths when changing governed actions.
- Follow the canonical file formats in
  [docs/architecture/file-formats.md](docs/architecture/file-formats.md) and the binding
  conventions in [docs/architecture/decisions.md](docs/architecture/decisions.md) where
  relevant — reviewers will check against these. If a change contradicts a numbered
  ruling, say so in the PR and get it re-ruled; do not reverse one silently.
- Reviewers look for: correctness, test coverage for the change, adherence to existing
  patterns, and no regressions to documented behavior (see the README's "Known gaps"
  section for deliberate scope boundaries — don't silently expand scope in an unrelated
  PR).
- A PR is accepted once it has passing CI and reviewer approval; the author or reviewer
  merges it into `main`.

## Where to look next

- [docs/README.md](docs/README.md) — the code-verified documentation set and reading order.
- [docs/development/contributing.md](docs/development/contributing.md) — where code goes,
  the invariants to preserve, and the definition of done.
- [README.md](README.md) — product overview, stack, quickstart, project layout.
- [docs/architecture/file-formats.md](docs/architecture/file-formats.md) — canonical
  task/project file formats.
- [docs/architecture/decisions.md](docs/architecture/decisions.md) — binding conventions
  and the numbered orchestrator rulings the code comments cite.
- [docs/operations/](docs/operations/) — deployment and day-2 operations runbooks.
