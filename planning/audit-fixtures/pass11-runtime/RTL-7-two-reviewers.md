> Scope: Concise repository audit and immutable two-reviewer delivery fixture for RTL-7.

# RTL-7 repository audit

## Delivery contract

This file is documentation only. It defines no commands, scripts, configuration, or runtime
behavior. One documentation author owns the delivery. Both required P11 supporting reviewer
profiles must independently inspect the same committed revision without writing to the repository.
The revision is eligible for acceptance only when both reviewers approve that exact revision.

## Structure

- `app/routes` contains thin React Router loaders, actions, and page entry points.
- `app/features` groups interface code by product surface, while `app/ui` holds shared primitives.
- `app/server` contains file storage, projections, runtimes, GitHub, authentication, audit, and
  event services.
- `app/schemas` defines shared Zod contracts, and `app/shared` contains cross-surface helpers.
- `db/migrations` holds SQL migrations; `e2e` and colocated test files cover browser and unit flows.
- `planning` and `docs` preserve product decisions, architecture, operations, and audit evidence.

## Dependencies

The application uses React 19 and React Router 8 in server-rendered framework mode. TypeScript 7,
Zod 4, and Vite 8 provide typed development and builds. Better Auth handles authentication,
better-sqlite3 provides the projection database, Chokidar watches canonical files, and server-sent
events carry live updates. Claude Agent SDK and Codex SDK provide real agent backends. Vitest and
Playwright cover unit, integration, and end-to-end verification.

## Architecture

Markdown project and task files under the configured data root are canonical business truth.
Watchers and explicit rescans parse those files, derive readiness, and materialize read models in
SQLite. The database also stores application concerns such as users, sessions, encrypted secrets,
audit records, and runtime projections. Server services coordinate agent runs, GitHub delivery,
events, and recovery; routes expose those capabilities to feature-oriented React surfaces.

## Notable risks and gaps

- File-to-database projection drift requires boot rescans, watcher reliability, and diagnostics.
- Agent and knowledge-base content crosses a trust boundary, so resource isolation and contained
  path resolution remain security-critical.
- Real agent execution and GitHub delivery depend on valid external credentials and must fail
  honestly when unavailable.
- Concurrent delivery, reviewer verdicts, and reconciliation must remain bound to one immutable
  revision or stale approval could satisfy the wrong change.
- Operational gaps include no mailer, no organization-wide audit console, capped notification
  history, and no scheduled GitHub reconciliation.

## Testing conventions

Unit tests live beside their sources as `*.test.ts` and run through `npm test`. Test setup points
`VIBERR_DATA_ROOT` to a temporary directory and must never use a developer's real data root. Every
form POST fixture includes a `_csrf` field. Playwright uses an isolated data root and deterministic
test runtime, so it cannot spend real tokens. Tests should drive real server actions in preference
to mocking internal implementation details.

Last reviewed: 2026-07-20
