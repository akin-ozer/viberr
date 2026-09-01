# Agents: start here

Viberr is a governed AI software-delivery app (React Router 8 SSR, Node ≥ 26, `node:sqlite`,
Zod 4, SSE). Canonical business state is markdown files under the data root; SQLite holds
projections plus app-owned rows. It is **pre-production**: schemas change without migrations.

## Read first

1. [`docs/README.md`](docs/README.md) — the documentation index and reading order (all of
   it verified against the code on 2026-09-01).
2. [`docs/architecture/decisions.md`](docs/architecture/decisions.md) — the binding rulings.
   Code comments cite them as "ruling N"; numbers are never reused or renumbered.
3. [`docs/development/contributing.md`](docs/development/contributing.md) — where code goes,
   the invariants, and the definition of done.

## Commands

```sh
cp .env.example .env   # two required secrets, see docs/operations/configuration.md
npm ci && npm run seed && npm run dev
npm run lint && npm run typecheck && npm test && npm run build   # what CI runs
npm run e2e            # production image in Docker; the only gate that boots the real thing
```

## Invariants you must not break

- Files are truth. Write `task.md` / `project.md` / goal files only through the writers in
  `app/server/files/` (mutex, atomic write, unknown keys preserved, re-projection).
- Every governed action records audit and, when user-visible, a typed timeline event.
- Authorization is `app/shared/rbac.ts` for humans and `app/shared/capabilities.ts` for
  agents; three capabilities are always human: merge a PR, transition to Done, change
  project policy.
- Readiness is derived in one place; stage ids are never literals; no optimistic UI for
  governed state.
- Secrets never reach files, logs, SSE payloads or agent environments.
- `npm run lint` has no suppression list: fix findings, never allowlist.
- Two docs are pinned by tests: `design/prd.md` mirrors the canon PRD byte-for-byte, and
  the `## Packet` section of `docs/architecture/file-formats.md` mirrors
  `PACKET_OPTION_KINDS`.
- When you change behaviour, update the matching page under `docs/` in the same change,
  and record any owner decision as the next numbered ruling.

## Do not

- Reverse a numbered ruling silently; say so and get it re-ruled.
- Add `vi.mock`, Tailwind, inline hex colours, `console.log` in server code, or a second
  definition of something that has one home.
- Bypass the writer lock: `seed`, `seed:demo`, `rescan`, `restore`, `keys -- reseal` refuse
  against a running app on purpose.
