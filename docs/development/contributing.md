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
cp .env.example .env      # every variable optional (ruling 504)
npm ci                    # Node ≥ 26
npm run seed              # baseline store; refused while an app holds the writer lock
npm run dev               # http://localhost:5173 (PORT)
```

Left unset, `VIBERR_SESSION_SECRET` and `VIBERR_SECRET_ENCRYPTION_KEY` are generated once
into `<data root>/state/instance-secrets.json` by the first process that reads the env, and
every process after it reads them back (ruling 504). Default sign-in after `npm run seed`:
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

CI runs `npm test` in the image's Debian base as an unprivileged user (ruling 622); as root,
or on another coreutils, the agent-tree suites fail for reasons of the host, not the change.
[testing.md](testing.md) §1 has the command that runs it as CI does.

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
  `{ ok: false, error }` (`appErrorResponse` renders a caught `AppError` that way, with
  `field` when the refusal names the form field it is about: `AppError.fieldValidation`,
  ruling 514); loaders never mutate.
- **Governed task logic** lives in `app/server/tasks/*`; controller logic in
  `app/server/controller/*`, and epic logic in `app/server/tasks/epic-actions.server.ts`
  (ruling 503); project and
  org logic beside its surface in `app/features/<surface>/*.server.ts` or
  `app/server/org/*`.
- **Never write canonical files directly.** Use the writers in `app/server/files/`:
  `updateTaskFile`, `appendTimelineEvent`, `patchTaskFrontmatter` (task-writer),
  `updateProjectFile` / `createProjectFile` (project-writer), `createEpicFile` /
  `updateEpicFile` (epic-writer). They hold the per-file mutex, preserve unknown keys and
  sections, write atomically, and refuse to overwrite a task file whose parse carries a
  hard-stop diagnostic (`FILE_NOT_TRUSTED`). The governed caller then re-projects
  (`reprojectTask`, `rebuildPath`); never write a projection row without file backing.
- **Every governed action** records audit (`recordAudit`) and, when user-visible, a
  typed timeline event. Add the action to the table in `audit-coverage.server.test.ts`.
- **Authorization** is `requireAction(...)` (`app/server/tasks/task-action-core.server.ts`,
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

## 4. Data and schema changes

There is one squashed migration, `db/migrations/0001_baseline.sql`, and no
back-compat obligation (ruling 683 kept this convention at launch). To change a table or a CHECK constraint, edit the baseline and, in the same change, give
existing roots a way to get it: a new column goes into `BASELINE_COLUMNS` in a form `ALTER TABLE … ADD COLUMN`
accepts on a table that has rows (with a backfill when the default misdescribes older rows),
a new table into `BASELINE_TABLES` and a new index into `BASELINE_INDEXES`
(`app/server/db/sqlite.server.ts`). A changed constraint reaches existing roots only through
an in-place rebuild of its table, as `widenNotificationKindCheck` and
`ensureBackendAccountsTable` do, or a re-baseline; listing a CHECK over an enum the build
derives into in `projectionCheckGaps` (`app/server/boot.server.ts`) only makes boot name the
gap. Recreating your local `state/projection.sqlite` hides a missing entry. The boot WARN `projection schema drift` names only a column
`task_projections` / `task_events` lacks and a value one of the four CHECKs
`projectionCheckGaps` reads refuses, and any other lag is silent; a missing column can be
closed with `ALTER TABLE <table> ADD COLUMN <column>`. Recreating the file also drops the
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
| `docs/architecture/file-formats.md` | `file-formats-sync.test.ts` | §2 documents every `TASK_FRONTMATTER_KEYS` entry, §4 every `AGENT_PROFILE_KNOWN_KEYS` entry; the `## Packet` "The N kinds:" enumeration equals `PACKET_OPTION_KINDS` in order, and every stated count equals its length |
| `docs/architecture/file-formats.md` (append contract) | `task-file.server.test.ts` | never says "display sorts by timestamp"; keeps "it does not undo it" |
| `docs/architecture/decisions.md` | `rulings-supersession.test.ts` | states its supersession convention, and every ruling a later one changes carries an inline marker (ruling 341) |
| `docs/operations/runbook.md`, `docs/operations/deployment.md`, `docs/development/scripts.md` | `runbook-db-read.test.ts` | copy first, never a second connection to a live projection; in-container backups use an absolute `--out` outside `/data` (ruling 158) |
| `README.md`, `docs/operations/deployment.md` | `store-volume-wiring.test.ts` | the first shell block that runs Compose is the install: it runs `docker compose up`, with no `.env` copy and no `docker volume create` (ruling 504) |
| `docs/architecture/codebase-map.md` | `app/features/shell/nav.test.ts` | contains `` `nav.ts` order: `` and the rail labels in order |
| `.env.example` | `env.server.test.ts` | lists every key the env schema declares and every raw `process.env.VIBERR_*` read under `app/` (ruling 458(c)) |
| `tools/oxlint/anti-slop/` | `anti-slop-vendor-sync.test.ts` | matches `tools/oxlint/anti-slop.manifest.json`; re-pin with `node scripts/anti-slop-manifest.mjs` |
| `app/server/runtimes/humanizer/`, `THIRD_PARTY_NOTICES.md` | `humanizer.server.test.ts` | holds only upstream's `SKILL.md` (matching `HUMANIZER_SKILL_SHA256`) and its `LICENSE`, and the notices name the repository, the commit and the licence; re-vendor from upstream and move the pin and `HUMANIZER_SOURCE` with it (ruling 502) |

Code comments cite `docs/architecture/decisions.md` (ruling numbers),
`docs/architecture/file-formats.md`, `docs/operations/deployment.md`,
`docs/operations/runbook.md`, `docs/development/scripts.md`, `docs/ui/surfaces.md`,
`docs/domain/auth-and-rbac.md` and `docs/domain/task-lifecycle.md` by path; keep those
paths stable.

## 6. UI rules in one place

The shipped app is the design source (ruling 682): reuse what an existing surface already
draws, and record a deliberate departure in a comment at its site. `app/app.css`
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

1. The six gates pass locally ([testing.md](testing.md) §1).
2. New behaviour has ONE owning test at the boundary that owns it ([testing.md](testing.md)
   §0, ruling 512), through the real writers or the route harness: no `vi.mock` and no
   production seam that only a test calls.
3. Audit and typed events exist for any new governed action.
4. Docs that describe the changed behaviour are updated in the same PR, in present
   tense: correct the body where it is wrong rather than stacking a dated update note on
   the page header, and cite the ruling inline where it explains why. `decisions.md` is
   the exception: a ruling's text is never rewritten, and a later change to it is a dated
   note inside its block.
5. If an owner decision was taken, it is recorded as the next numbered ruling.
