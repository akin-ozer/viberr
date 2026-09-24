# Working in this repository

> The conventions an agent or a human must follow to change Viberr without breaking
> its invariants. The short human guide is the root [CONTRIBUTING.md](../../CONTRIBUTING.md);
> this page is the longer, code-facing version. Source of truth: `package.json` scripts,
> `.env.example`, `app/server/config/env.server.ts`, `app/server/files/*-writer.server.ts`,
> `app/server/auth/form-action.server.ts`, `app/shared/rbac.ts`,
> `app/shared/capabilities.ts`, `db/migrations/0001_baseline.sql`, the tests listed in §5.
> Verified against `main` @ `7d9fbf72` (2026-09-23).

## 1. Setup

```sh
cp .env.example .env      # fill VIBERR_SESSION_SECRET (≥ 32 chars) and
                          # VIBERR_SECRET_ENCRYPTION_KEY (base64 of exactly 32 bytes)
npm ci                    # Node ≥ 26
npm run seed              # baseline store; refused while an app holds the writer lock
npm run dev               # http://localhost:5173 (PORT)
```

Without the two secrets the server dies at boot with `Invalid environment
configuration` listing every problem. Default sign-in after `npm run seed`:
`admin@viberr.dev` / `viberr-dev-2828` (or `VIBERR_SEED_ADMIN_EMAIL` /
`VIBERR_SEED_ADMIN_PASSWORD`, read while the users table is empty). `.env.example` sets
`VIBERR_DATA_ROOT=./docker-data`, the dev server's store. Until ruling 460 it was also the
directory `compose.yml` bind-mounted at `/data`; the container now mounts the named volume
`viberr-data` instead (a macOS bind mount enforces no file permissions between users, and
every agent runs as its person's own user), so the dev server and the container no longer
share a store — read the container's through the app or `docker compose exec` (the schema
default, used when the variable is unset, is `./data`). All variables are documented in
[../operations/configuration.md](../operations/configuration.md).

## 2. Before you push

Run what CI runs (details in [testing.md](testing.md)):

```sh
npm run lint && npm run typecheck && npm test && npm run build
node scripts/measure-routes.mjs --check   # the bundle ratchet, after the build (ruling 457)
npm run e2e     # Docker; the only gate that boots the shipped image
```

A change that makes a perf budget move fails `npm test` in either direction: lower the
ceiling to keep a win, or raise it with the reason beside it
([performance.md](performance.md)).

Lint has no suppression list: fix findings, never allowlist them (ruling 86). A change
that contradicts a numbered ruling in
[../architecture/decisions.md](../architecture/decisions.md) must say so and be re-ruled;
never reverse one silently. Rulings are appended under the next number; existing numbers
are cited by code comments and never renumbered. A ruling that narrows, replaces or
supersedes an earlier one obliges the earlier one to carry an inline marker
(`rulings-supersession.test.ts`, ruling 341).

## 3. Where code goes

- **Routes** stay thin: guard → server call → route-shaped data. Mutations go through
  `requireFormAction` (session + CSRF + `intent`) and return `{ ok, toast }` or
  `{ ok: false, error }` (`appErrorResponse` renders a caught `AppError` that way);
  loaders never mutate.
- **Governed task logic** lives in `app/server/tasks/*`; controller and goal logic in
  `app/server/controller/*` and `app/server/tasks/goal-actions.server.ts`; project and
  org logic beside its surface in `app/features/<surface>/*.server.ts` or
  `app/server/org/*`.
- **Never write canonical files directly.** Use the writers in `app/server/files/`:
  `updateTaskFile`, `appendTimelineEvent`, `patchTaskFrontmatter` (task-writer),
  `updateProjectFile` / `createProjectFile` (project-writer), `createGoalFile` /
  `updateGoalFile` (goal-writer). They hold the per-file mutex, preserve unknown keys and
  sections, write atomically, and refuse to overwrite a task file whose parse carries a
  hard-stop diagnostic (`FILE_NOT_TRUSTED`). The governed caller then re-projects
  (`reprojectTask`, `rebuildPath`); never write a projection row without file backing.
- **Every governed action** records audit (`recordAudit`) and, when user-visible, a
  typed timeline event. Add the action to the table in `audit-coverage.server.test.ts`.
- **Authorization** is `requireAction(...)` (`app/server/tasks/task-actions.server.ts`,
  through `requireProjectAuthority`) against `app/shared/rbac.ts` for humans, and the
  operator/specialist gates against `app/shared/capabilities.ts` for agents. Never
  duplicate a role check inline.
- **Derived values** have one home: readiness in
  `app/server/interpretation/readiness-policy.server.ts`, validation in the rebuilder,
  freshness in `shared/freshness.ts`, display-state mapping in
  `shared/mapping/task.server.ts`. Stage ids are never literals: use `resolveStageRoles`,
  `isTerminalStage` (`shared/workflow/stage-roles.ts`).
- **Schemas** are tolerant. A list whose loss would persist is parsed per row
  (`tolerantRowsOf`, `app/schemas/file-diagnostics.ts`), never with a whole-array
  fallback.
- **Client code** never imports a `.server` module except as `import type`. `app/ui/`
  imports nothing from `features/` or `server/`.
- **Errors** are typed `AppError`s (`app/server/errors/app-error.server.ts`) with a code
  from `error-codes.ts` and a user-safe message; never leak stacks or secrets.
- **Logging** is the JSON logger (`app/server/logging/logger.server.ts`); never
  `console.log` in server code. Nothing credential-shaped may be logged
  (`CREDENTIAL_ENV_RE` in `runtime-registry.server.ts`, the token patterns in
  `git-output-redact.server.ts`). A caught value goes on a record as
  `err: toError(error)` and into text as `errorMessage(error)` (`app/shared/errors.ts`).
  Records inside a request carry its correlation
  (`request-context.server.ts`) with no call-site work; an id a request learns later
  goes on with `bindCorrelation` (identifiers only: the session guard binds `userId`,
  a run's launch binds `runId` and `taskKey` in its own `forkCorrelation`), and every
  response echoes the request id as `X-Request-Id` (ruling 458(d)).

## 4. Data and schema changes while pre-prod

There is one squashed migration, `db/migrations/0001_baseline.sql`, and no
back-compat obligation. To change a table or a CHECK constraint, edit the baseline and
recreate your local `state/projection.sqlite`. The boot WARN `projection schema drift`
tells you when a root lags the baseline and names the refused CHECK values and the
missing columns; a purely additive column drift can be closed with
`ALTER TABLE <table> ADD COLUMN <column>` instead. Recreating the file also drops the
rows no rescan can rebuild (users, sessions, sealed PATs, audit, notifications), so run
`npm run backup` first ([../operations/deployment.md](../operations/deployment.md)
§Re-baselining the projection database). Canonical file formats change the same way:
edit the schema, update
[../architecture/file-formats.md](../architecture/file-formats.md) (every task
frontmatter key in §2 and profile key in §4 is pinned), and migrate the demo fixture in
the same change so `demo-fixture.test.ts` stays green. Retired vocabulary must be removed
from seeded assets too (`retired-vocabulary.test.tsx`). A new `VIBERR_*` variable goes
into the env schema and `.env.example` (`env.server.test.ts`).

## 5. Docs that tests pin

| File | Pinned by | Rule |
|---|---|---|
| `design/prd.md` | `prd-sync.test.ts` | byte-identical to `planning/planning-artifacts/prd.md`; edit canon, copy over the mirror |
| `docs/architecture/file-formats.md` | `file-formats-sync.test.ts` | §2 documents every `TASK_FRONTMATTER_KEYS` entry, §4 every `AGENT_PROFILE_KNOWN_KEYS` entry; the `## Packet` "The N kinds:" enumeration equals `PACKET_OPTION_KINDS` in order, and every stated count equals its length |
| `docs/architecture/file-formats.md` (append contract) | `task-file.server.test.ts` | never says "display sorts by timestamp"; keeps "it does not undo it" |
| `docs/architecture/decisions.md` | `rulings-supersession.test.ts` | states its supersession convention, and every ruling a later one changes carries an inline marker (ruling 341) |
| `docs/operations/runbook.md`, `docs/operations/deployment.md`, `docs/development/scripts.md` | `runbook-db-read.test.ts` | copy first, never a second connection to a live projection; in-container backups use an absolute `--out` outside `/data` (ruling 158) |
| `docs/architecture/codebase-map.md` | `app/features/shell/nav.test.ts` | contains `` `nav.ts` order: `` and the rail labels in order |
| `.env.example` | `env.server.test.ts` | lists every key the env schema declares and every raw `process.env.VIBERR_*` read under `app/` (ruling 458(c)) |
| `vitest.config.ts` | `vitest-config.test.ts` | `testTimeout: 20_000` |
| `tools/oxlint/anti-slop/` | `anti-slop-vendor-sync.test.ts` | matches `tools/oxlint/anti-slop.manifest.json`; re-pin with `node scripts/anti-slop-manifest.mjs` |

Code comments cite `docs/architecture/decisions.md` (ruling numbers),
`docs/architecture/file-formats.md`, `docs/operations/deployment.md`,
`docs/operations/runbook.md`, `docs/development/scripts.md`, `docs/ui/surfaces.md`,
`docs/domain/auth-and-rbac.md` and `docs/domain/task-lifecycle.md` by path; keep those
paths stable.

## 6. UI rules in one place

The mock under `design/html-app/app/*.jsx` is the structural source; `app/app.css`
`:root` is the only token source (no Tailwind, no inline hex, new CSS only in the marked
appended sections). One typeface, Inter, for body and display (ruling 365); the faces a
first paint draws are preloaded from `features/shell/font-preloads.ts`, and a
metric-matched "Inter Fallback" face stands in until they arrive (ruling 457). Unstyled
primitive packages are allowed only behind an `app/ui/*` boundary, rendered with classes
`app.css` defines (ruling 166). One `Icon` component. A failure toast passes `"error"`
explicitly; success is the default kind (ruling 458(b)). Dialogs are native `<dialog>`
with Escape and scrim close. Every top-level surface
carries a `data-screen-label`. WCAG 2.2 AA in both themes is an e2e gate. Full list in
[../architecture/decisions.md#ui-porting-rules](../architecture/decisions.md#ui-porting-rules)
and [../ui/surfaces.md](../ui/surfaces.md).

## 7. Definition of done for a change

1. The five gates pass locally.
2. New behaviour has a test through the real writers or the route harness; no
   `vi.mock`.
3. Audit and typed events exist for any new governed action.
4. Docs that describe the changed behaviour are updated in the same PR, in present
   tense: correct the body where it is wrong rather than stacking a dated update note on
   the page header, and cite the ruling inline where it explains why. `decisions.md` is
   the exception: a ruling's text is never rewritten, and a later change to it is a dated
   note inside its block.
5. If an owner decision was taken, it is recorded as the next numbered ruling.
