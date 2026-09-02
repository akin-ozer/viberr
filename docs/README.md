# Viberr documentation

This directory is the code-verified reference for Viberr as it is built. Every page was
checked against the tree on `main` @ `68b5480` (2026-09-01) and says so in its header;
the six pages ruling 121 touched carry a second, later stamp (2026-09-02, re-verified
2026-09-03 after the ruling's adversarial review);
where an older document was found wrong, the page says what changed and the full ledger
is in [validation/2026-09-01-doc-validation.md](validation/2026-09-01-doc-validation.md).
Viberr is **pre-production**: formats and schemas change without migrations, so trust the
dated header and the code over anything undated.

## Reading order for an agent new to the repo

1. [product/overview.md](product/overview.md) — what Viberr is, for whom, the operating
   model, what ships, what is deliberately out.
2. [product/glossary.md](product/glossary.md) — the vocabulary and every enum, in one place.
3. [architecture/overview.md](architecture/overview.md) — stack, layers, request and boot
   lifecycles, background services, security posture.
4. [architecture/decisions.md](architecture/decisions.md) — the binding rulings (numbered,
   stable, cited by code as "ruling N"). Read the dated correction notes; superseded
   rulings are kept, marked, never deleted.
5. The domain page for whatever you are touching (below).
6. [development/contributing.md](development/contributing.md) — where code goes and the
   definition of done.

## Pages

### Product

| Page | What it answers |
|---|---|
| [product/overview.md](product/overview.md) | Vision, personas, operating model, V1 scope, boundaries, phases |
| [product/glossary.md](product/glossary.md) | Terms and enums: readiness, waiting, validation, packet kinds, capability modes, roles, run states … |
| [product/requirements-status.md](product/requirements-status.md) | Every PRD requirement (FR1–41, NFR1–18) with status and code location; amendment chronology; drift the PRD does not record |

### Architecture

| Page | What it answers |
|---|---|
| [architecture/overview.md](architecture/overview.md) | The system in one read: stack, layer rules, read/write path, boot, timers, security |
| [architecture/codebase-map.md](architecture/codebase-map.md) | Directory-by-directory map of `app/`, `db/`, `scripts/`, `test-support/` |
| [architecture/data-model.md](architecture/data-model.md) | Data-root layout, every SQLite table (primary vs derived vs config), indexes, retention, ids |
| [architecture/file-formats.md](architecture/file-formats.md) | The canonical `project.md`, `task.md`, goal and agent-profile formats; timeline grammar; packet YAML (the `## Packet` section is pinned by a test) |
| [architecture/projections-and-events.md](architecture/projections-and-events.md) | Writers, watcher, tolerant parsing and diagnostics, rebuilder, rescan/rebuild, SSE broker and client |
| [architecture/decisions.md](architecture/decisions.md) | Conventions, 121 numbered owner rulings, the unrecorded decisions since 2026-08-20, the route map |

### Domain

| Page | What it answers |
|---|---|
| [domain/task-lifecycle.md](domain/task-lifecycle.md) | Governed mutation shape, RBAC matrix, creation, stages and boundaries, transitions, readiness/waiting/validation, ownership, engagements, packets, recommendations, schedules, delivery, the acceptance endings, archive, timeline, notifications |
| [domain/operator.md](domain/operator.md) | The per-task coordinator: authority and gates, triggers, the turn, the 12 `viberr` tools, packets, guardrails |
| [domain/agents-and-runtime.md](domain/agents-and-runtime.md) | Backends and credentials, models, a run's life (persistence, admission, streaming, failure kinds, resume), specialist dispatch and tools, capability catalog and enforcement, context mounting, workspaces and git, boot recovery, seeded catalog |
| [domain/controller-and-goals.md](domain/controller-and-goals.md) | The instance controller: the dock on every surface, conversation scopes and the per-turn context read (ruling 121), the 38 `viberr_controller` tools, `viberr_ops`, deployment locks, chained goals |
| [domain/github-delivery.md](domain/github-delivery.md) | PATs and connections, repo attach, the delivery pipeline, PR adoption and collisions, revisions and verdicts, the reconciler, scope violations |
| [domain/auth-and-rbac.md](domain/auth-and-rbac.md) | better-auth setup, CSRF, OAuth whitelist, org and project roles, enforcement, org settings, audit, insights, profile |

### Operations

| Page | What it answers |
|---|---|
| [operations/configuration.md](operations/configuration.md) | Every environment variable (required, schema-validated, raw reads), non-env settings, what the image bakes in |
| [operations/deployment.md](operations/deployment.md) | Single-node Docker: secrets, TLS proxy, backends in the container, first run, persistence, backup/restore, re-baselining, the writer lock |
| [operations/runbook.md](operations/runbook.md) | Day-2: store check, health fields and probes, rescan vs rebuild, diagnostics, GitHub and runtime issues, auth, retention, lock refusals, self-heal, backup |

### Development

| Page | What it answers |
|---|---|
| [development/contributing.md](development/contributing.md) | Setup, gates, where code goes, invariants, schema changes while pre-prod, pinned docs, definition of done |
| [development/testing.md](development/testing.md) | Vitest config and harnesses, how state is built, doc-pinning tests, lint rules, the e2e flow and spec table, CI |
| [development/scripts.md](development/scripts.md) | Every npm script and CLI, which ones take the writer lock, seed/backup/restore internals |

### UI

| Page | What it answers |
|---|---|
| [ui/surfaces.md](ui/surfaces.md) | Every route with its guard, purpose and form intents; the shell; screen labels; copy rules tests enforce |

### Validation

| Page | What it answers |
|---|---|
| [validation/2026-09-01-doc-validation.md](validation/2026-09-01-doc-validation.md) | What the previous documentation claimed, what the code does, and what was changed or left |

## Other documentation in the repository

- `README.md`, `CONTRIBUTING.md`, `AGENTS.md`, `CLAUDE.md` at the root: entry points; they
  point here.
- `planning/planning-artifacts/prd.md`: the **canon PRD** (requirements). `design/prd.md`
  is a byte-identical mirror pinned by `app/shared/docs/prd-sync.test.ts`; edit canon only.
- `planning/planning-artifacts/architecture.md` and `ux-design-specification.md`: the
  original design documents. Intent and history; stale in places (see the validation
  ledger). The code and this `docs/` set win on conflict.
- `planning/discovery-*/`: per-pass ledgers, notes and generated reference docs. History,
  not canon.
- `design/`: the HTML mock and design system (structural source for the UI), plus
  `better-auth-migration.md` and `CONVERSATION-SUMMARY.md`, which describe a plan that
  was not followed as written (see the validation ledger).
- `.env.example`: the documented environment template; `configuration.md` is the superset.
- `qa/`: canary and smoke artifacts written by agents during live passes.

## Keeping this set honest

- A page's header names its verification commit. When you change behaviour, update the
  page in the same PR and move the commit reference forward.
- Corrections to `decisions.md`, `file-formats.md`, `deployment.md` and `runbook.md` are
  made as dated notes, never by silently rewriting a ruling; ruling numbers are stable
  because code comments cite them.
- Two files are pinned mechanically (`design/prd.md`, the Packet section of
  `file-formats.md`); everything else relies on the pass-close re-read that ruling 44
  requires.
- An owner decision that lives only in a code comment or a pass ledger is not recorded.
  Promote it to the next ruling number.
