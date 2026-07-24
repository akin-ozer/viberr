# Contributing to Viberr

Thanks for helping build Viberr. This guide covers environment setup, the branch/PR
workflow, running the test suite, and how changes get reviewed and accepted.

## Dev environment setup

Requirements: Node >= 26, npm.

```sh
git clone <this-repo> viberr && cd viberr

# 1. Environment — copy the template and fill in the two required secrets
cp .env.example .env
#    VIBERR_SESSION_SECRET       — generate: openssl rand -base64 48
#    VIBERR_SECRET_ENCRYPTION_KEY — generate: openssl rand -base64 32
#    (every other variable is optional; see .env.example for docs)

# 2. Install
npm ci

# 3. Demo data (migrations auto-apply at boot)
npm run seed

# 4. Run
npm run dev        # http://localhost:5173
```

See the [README](README.md) for the full quickstart, demo accounts, Docker setup, and
architecture overview.
`GET /resources/health` returns backend availability.

## Branch / PR workflow

- Branch off `main`, using a short descriptive branch name (e.g. `fix-board-filter`,
  `generic-agents`).
- Keep commits focused and use clear, descriptive commit messages.
- Open a pull request against `main`. CI (`.github/workflows/ci.yml`) must pass —
  typecheck, unit/integration tests, and build — before merge.
- Merge via GitHub once CI is green and the PR has been reviewed and accepted (see
  below).

## Running the test suite

Run these from the repository root after `npm ci`:

```sh
npm run typecheck   # route typegen + tsc
npm test            # vitest unit + integration suite
npm run build       # production build, same as CI's final gate
```

See [docs/testing-quickstart.md](docs/testing-quickstart.md) for the short test guide.

## Code review & acceptance

- Every change lands through a pull request — no direct pushes to `main`.
- CI must pass (typecheck, tests, build) before a PR is considered mergeable.
- Keep route modules thin, put domain behavior in feature/server modules, and use the
  existing file writers so canonical markdown and SQLite projections stay in sync.
- Preserve authorization, audit, and typed error paths when changing governed actions.
- Follow the canonical file formats in
  [docs/architecture/file-formats.md](docs/architecture/file-formats.md) where
  relevant — reviewers will check against these.
- Reviewers look for: correctness, test coverage for the change, adherence to existing
  patterns, and no regressions to documented behavior (see the README's "Known gaps"
  section for deliberate scope boundaries — don't silently expand scope in an unrelated
  PR).
- A PR is accepted once it has passing CI and reviewer approval; the author or reviewer
  merges it into `main`.

## Where to look next

- [README.md](README.md) — product overview, stack, quickstart, project layout.
- [docs/architecture/file-formats.md](docs/architecture/file-formats.md) — canonical
  task/project file formats.
- [docs/operations/](docs/operations/) — deployment and day-2 operations runbooks.
