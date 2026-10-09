# Agents: start here

Viberr is a governed AI software-delivery app (React Router 8 SSR, Node ≥ 26, `node:sqlite`,
Zod 4, SSE). Canonical business state is markdown files under the data root; SQLite holds
projections plus app-owned rows. Schema changes edit the one baseline migration rather than
adding to a chain, and file formats carry no back-compat promise (ruling 5).

## Read first

1. [`docs/README.md`](docs/README.md) — the documentation index and reading order (all of
   it re-verified against the code on 2026-09-23, `main` @ `7d9fbf72`).
2. [`docs/architecture/decisions.md`](docs/architecture/decisions.md) — the binding rulings,
   each stated as it holds today and grouped by topic. Code comments cite them as "ruling N",
   and every citation must name a ruling the file defines (ruling 1).
3. [`docs/development/contributing.md`](docs/development/contributing.md) — where code goes,
   the invariants, and the definition of done.

## Commands

```sh
cp .env.example .env   # all optional; secrets are generated when unset (ruling 38)
npm ci && npm run seed && npm run dev
npm run lint && npm run typecheck && npm test && npm run build   # CI's verify job
node scripts/measure-routes.mjs --check   # ...then the bundle ratchet (ruling 11)
npm run e2e            # CI's e2e job: production image in Docker, the only gate that boots it
npm run deploy         # Docker deployment: stamp the build from git, build, up, read it back
```

## Invariants you must not break

- Files are truth. Write `task.md` / `project.md` / epic files only through the writers in
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
  (`backend-credentials.server.ts`, ruling 137), while `filteredSpawnEnv()` strips every
  ambient credential and the GitHub PAT stays server-side.
- Every agent process runs as its person's own OS user, never as the server's (ruling 139):
  anything that spawns a Claude or Codex CLI, the Codex compaction or a vendor sign-in goes
  through the launcher (`agent-isolation.server.ts`, `RunSpec.agent`), and a launch that
  cannot be prepared refuses the run — it never falls back to `node`. The store lives on the
  named volume (a macOS bind mount enforces no permissions), and a directory a run writes is
  created with `shareDirWithAgents`. A tree an agent can write is removed as its person
  (`removeAgentTree`, ruling 140), never with the server's own `rmSync`: what the server
  wrote there it only opens to the group (`chmod -R -P g+rwX`), and an emptied root it
  owns goes with its `rmdir` (ruling 140).
- `npm run lint` has no suppression list: fix findings, never allowlist.
- Docs pinned by tests are listed in `docs/development/contributing.md` §5: among them
  `docs/architecture/file-formats.md` (its key lists and the `## Packet` kinds), `docs/architecture/decisions.md` (every "ruling N"
  in the tree names a ruling it defines, ruling 1), the operations pages (never a second connection
  to a live projection, ruling 23) and `.env.example`.
- When you change behaviour, update the matching page under `docs/` in the same change.
  Record an owner decision in `decisions.md`: a new one as the next numbered ruling in its
  topic's section, a changed one by rewriting its ruling in place (ruling 1).
- The repository holds the app, its tests, its tooling and `docs/` (ruling 3). Planning
  notes, pass ledgers, QA evidence and design mocks do not go back into the tree: the
  outcome belongs in the code, a `docs/` page or a ruling, and the working notes in the PR.

## Do not

- Reverse a numbered ruling silently; say so and get it re-ruled.
- Add `vi.mock`, Tailwind, inline hex colours, `console.log` in server code, or a second
  definition of something that has one home.
- Add a test that fails the authoring gate in `docs/development/testing.md` §0 (ruling 8):
  it names the contract it owns and the edit that breaks it, lives at the one boundary that
  owns that contract, and needs no export, flag or `*ForTests` hook that only a test calls.
- Run `npx shadcn add` (or paste a shadcn/ReUI component). A registry component is a design
  reference, never an install. Ruling 14 permits only
  UNSTYLED primitive packages, rendered with class names `app/app.css` already defines and
  owned by one Viberr component; `app.css.test.ts` fails the build on a utility class
  or a Tailwind toolchain in `package.json`.
- Bypass the writer lock: `seed`, `seed:demo`, `rescan`, `restore`, `keys -- reseal` refuse
  against a running app on purpose.
