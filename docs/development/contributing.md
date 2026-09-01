# Working in this repository

> The conventions an agent or a human must follow to change Viberr without breaking
> its invariants. The short human guide is the root [CONTRIBUTING.md](../../CONTRIBUTING.md);
> this page is the longer, code-facing version. Verified against `main` @ `68b5480`
> (2026-09-01).

## 1. Setup

```sh
cp .env.example .env      # fill VIBERR_SESSION_SECRET (≥ 32 chars) and
                          # VIBERR_SECRET_ENCRYPTION_KEY (base64 of exactly 32 bytes)
npm ci                    # Node ≥ 26
npm run seed              # baseline store; refused while an app holds the writer lock
npm run dev               # http://localhost:5173
```

Without the two secrets the server dies at module init with `Invalid environment
configuration` listing every problem. Default sign-in after `npm run seed`:
`admin@viberr.dev` / `viberr-dev-2828`. All variables are documented in
[../operations/configuration.md](../operations/configuration.md).

## 2. Before you push

Run what CI runs (details in [testing.md](testing.md)):

```sh
npm run lint && npm run typecheck && npm test && npm run build
npm run e2e     # Docker; the only gate that boots the shipped image
```

Lint has no suppression list: fix findings, never allowlist them (ruling 86). A change
that contradicts a numbered ruling in
[../architecture/decisions.md](../architecture/decisions.md) must say so and be re-ruled;
never reverse one silently. Rulings are appended under the next number; existing numbers
are cited by code comments and never renumbered.

## 3. Where code goes

- **Routes** stay thin: guard → server call → route-shaped data. Mutations go through
  `requireFormAction` (session + CSRF + `intent`) and return `{ ok, toast }` or
  `{ ok: false, error }`; loaders never mutate.
- **Governed task logic** lives in `app/server/tasks/*`; project and org logic beside
  its surface in `app/features/<surface>/*.server.ts` or `app/server/org/*`.
- **Never write canonical files directly.** Use `updateTaskFile`, `appendTimelineEvent`,
  `patchTaskFrontmatter`, the project writer, the goal writer. They hold the per-file
  mutex, preserve unknown keys, write atomically and re-project. Never write a
  projection row without file backing.
- **Every governed action** records audit (`recordAudit`) and, when user-visible, a
  typed timeline event. The audit-coverage test will tell you if you forgot.
- **Authorization** is `requireAction(...)` against `app/shared/rbac.ts` (humans) and the
  operator/specialist gates against `app/shared/capabilities.ts` (agents). Never
  duplicate a role check inline.
- **Derived values** have one home: readiness in `readiness-policy.server.ts`,
  validation in the rebuilder, freshness in `shared/freshness.ts`, display-state
  mapping in `shared/mapping/task.server.ts`. Stage ids are never literals: use
  `resolveStageRoles`, `isTerminalStage`.
- **Schemas** are tolerant. A list whose loss would persist is parsed per row
  (`tolerantRows`), never with a whole-array fallback.
- **Client code** never imports a `.server` module except as `import type`. `app/ui/`
  imports nothing from `features/` or `server/`.
- **Errors** are typed `AppError`s with a code from `error-codes.ts` and a user-safe
  message; never leak stacks or secrets.
- **Logging** is the JSON logger; never `console.log` in server code. Nothing that
  matches the credential regex may be logged.

## 4. Data and schema changes while pre-prod

There is one squashed migration, `db/migrations/0001_baseline.sql`, and no
back-compat obligation. To change a table or a CHECK constraint, edit the baseline and
recreate your local `state/projection.sqlite` (the boot WARN `projection schema drift`
tells you when a root lags the baseline). Canonical file formats change the same way:
edit the schema, update
[../architecture/file-formats.md](../architecture/file-formats.md), and migrate the demo
fixture in the same change so `demo-fixture.test.ts` stays green. Retired vocabulary
must be removed from seeded assets too (`retired-vocabulary.test.tsx`).

## 5. Docs that tests pin

| File | Pinned by | Rule |
|---|---|---|
| `design/prd.md` | `prd-sync.test.ts` | byte-identical to `planning/planning-artifacts/prd.md`; edit canon, copy over the mirror |
| `docs/architecture/file-formats.md` `## Packet` | `file-formats-sync.test.ts` | the "The N kinds:" enumeration equals `PACKET_OPTION_KINDS` in order, and every stated count equals its length |

Code comments cite `docs/architecture/decisions.md` (ruling numbers),
`docs/architecture/file-formats.md` and `docs/operations/deployment.md` by path; keep
those paths stable.

## 6. UI rules in one place

The mock under `design/html-app/app/*.jsx` is the structural source; `app/app.css`
`:root` is the only token source (no Tailwind, no inline hex, new CSS only in the marked
appended sections). One `Icon` component. Toast kind is passed explicitly. Dialogs are
native `<dialog>` with Escape and scrim close. Every top-level surface carries a
`data-screen-label`. WCAG 2.2 AA in both themes is an e2e gate. Full list in
[../architecture/decisions.md#ui-porting-rules](../architecture/decisions.md#ui-porting-rules)
and [../ui/surfaces.md](../ui/surfaces.md).

## 7. Definition of done for a change

1. The five gates pass locally.
2. New behaviour has a test through the real writers or the route harness; no
   `vi.mock`.
3. Audit and typed events exist for any new governed action.
4. Docs that describe the changed behaviour are updated in the same PR (this `docs/`
   set, and a dated correction note when an older doc was wrong).
5. If an owner decision was taken, it is recorded as the next numbered ruling.
