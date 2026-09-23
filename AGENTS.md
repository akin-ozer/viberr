# Agents: start here

Viberr is a governed AI software-delivery app (React Router 8 SSR, Node ≥ 26, `node:sqlite`,
Zod 4, SSE). Canonical business state is markdown files under the data root; SQLite holds
projections plus app-owned rows. It is **pre-production**: schemas change without migrations.

## Read first

1. [`docs/README.md`](docs/README.md) — the documentation index and reading order (all of
   it re-verified against the code on 2026-09-23, `main` @ `7d9fbf72`).
2. [`docs/architecture/decisions.md`](docs/architecture/decisions.md) — the binding rulings.
   Code comments cite them as "ruling N"; numbers are never reused or renumbered.
3. [`docs/development/contributing.md`](docs/development/contributing.md) — where code goes,
   the invariants, and the definition of done.

## Commands

```sh
cp .env.example .env   # two required secrets, see docs/operations/configuration.md
npm ci && npm run seed && npm run dev
npm run lint && npm run typecheck && npm test && npm run build   # CI's verify job
npm run e2e            # CI's e2e job: production image in Docker, the only gate that boots it
npm run deploy         # Docker deployment: stamp the build from git, build, up, read it back
```

## Invariants you must not break

- Files are truth. Write `task.md` / `project.md` / goal files only through the writers in
  `app/server/files/` (per-file mutex, atomic write, unknown keys preserved), then
  re-project what you wrote (`reprojectTask` / `rebuildPath`) before you audit and publish.
- Every governed action records audit and, when user-visible, a typed timeline event.
- Authorization is `app/shared/rbac.ts` for humans and `app/shared/capabilities.ts` for
  agents; three capabilities are always human: merge a PR, transition to Done, change
  project policy.
- Readiness is derived in one place; stage ids are never literals; no optimistic UI for
  governed state.
- Secrets never reach files, logs, SSE payloads or agent environments. The one exception is
  the backend credential a run bills: a person's pasted key rides that run's CLI env
  (`backend-credentials.server.ts`, ruling 127), while `filteredSpawnEnv()` strips every
  ambient credential and the GitHub PAT stays server-side.
- `npm run lint` has no suppression list: fix findings, never allowlist.
- Docs pinned by tests are listed in `docs/development/contributing.md` §5: among them
  `design/prd.md` (a byte-for-byte mirror of the canon PRD), `docs/architecture/file-formats.md`
  (its key lists and the `## Packet` kinds), `docs/architecture/decisions.md` (a ruling a
  later one supersedes says so, ruling 341), the operations pages (never a second connection
  to a live projection, ruling 158) and `.env.example`.
- When you change behaviour, update the matching page under `docs/` in the same change,
  and record any owner decision as the next numbered ruling.

## Do not

- Reverse a numbered ruling silently; say so and get it re-ruled.
- Add `vi.mock`, Tailwind, inline hex colours, `console.log` in server code, or a second
  definition of something that has one home.
- Run `npx shadcn add` (or paste a shadcn/ReUI component). A registry component is a design
  reference, read the way `design/html-app` is — never an install. Ruling 166 permits only
  UNSTYLED primitive packages, rendered with class names `app/app.css` already defines and
  placed behind an `app/ui/*` boundary; `app.css.test.ts` fails the build on a utility class
  or a Tailwind toolchain in `package.json`.
- Bypass the writer lock: `seed`, `seed:demo`, `rescan`, `restore`, `keys -- reseal` refuse
  against a running app on purpose.
