# Viberr documentation

This directory is the code-verified reference for Viberr as it is built. The whole set has
been verified end to end twice: against `main` @ `68b5480` on 2026-09-01 (ledger:
[validation/2026-09-01-doc-validation.md](validation/2026-09-01-doc-validation.md)) and
against `main` @ `7d9fbf72` on 2026-09-23, after rulings 177–450 (ledger:
[validation/2026-09-23-doc-sweep.md](validation/2026-09-23-doc-sweep.md)). Each page's
header names the commit it was last verified against. Between sweeps, a change updates the
pages it touches in the same PR (`AGENTS.md`). Viberr is **pre-production**: formats and
schemas change without migrations, so trust the dated header and the code over anything
undated.

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
| [product/glossary.md](product/glossary.md) | Terms and enums: readiness, waiting, validation, packet kinds, capability modes, roles, run states, agent accounts and the credential principal … |
| [product/requirements-status.md](product/requirements-status.md) | Every PRD requirement (FR1–41, NFR1–18) with status and code location; amendment chronology; drift the PRD does not record |

### Architecture

| Page | What it answers |
|---|---|
| [architecture/overview.md](architecture/overview.md) | The system in one read: stack, layer rules, read/write path, boot, timers, security |
| [architecture/codebase-map.md](architecture/codebase-map.md) | Directory-by-directory map of the repository: the top level, `app/` module by module, `db/`, `scripts/`, `test-support/`, `tools/` |
| [architecture/data-model.md](architecture/data-model.md) | Data-root layout including the per-person runtime homes, every SQLite table (primary vs derived vs config), indexes, retention, ids |
| [architecture/file-formats.md](architecture/file-formats.md) | The canonical `project.md`, `task.md`, goal and agent-profile formats; timeline grammar; packet YAML (the `## Packet` section is pinned by a test) |
| [architecture/projections-and-events.md](architecture/projections-and-events.md) | Writers, watcher, tolerant parsing and diagnostics, rebuilder, rescan/rebuild, SSE broker and client |
| [architecture/decisions.md](architecture/decisions.md) | Conventions, 450 numbered owner rulings in numeric order (117 records a number that was never used), each carrying a dated pointer when a later ruling changed it; the unnumbered owner decisions of 2026-08-20 → 2026-09-01; the route map |

### Domain

| Page | What it answers |
|---|---|
| [domain/task-lifecycle.md](domain/task-lifecycle.md) | Governed mutation shape, RBAC matrix, creation, stages and boundaries, transitions, readiness/waiting/validation, ownership, engagements, packets, recommendations, schedules, delivery, the acceptance endings, archive, timeline, notifications, file leases |
| [domain/operator.md](domain/operator.md) | The per-task coordinator: authority and gates, triggers and the settle-time backstop, the turn and its snapshot, the `viberr` tools (up to 19), packets, guardrails |
| [domain/agents-and-runtime.md](domain/agents-and-runtime.md) | Backends, the credential principal and per-person runtime homes (ruling 127), models, a run's life (persistence, admission, streaming, failure kinds, resume), specialist dispatch and tools, capability catalog and enforcement, context mounting, workspaces and git, boot recovery, seeded catalog |
| [domain/controller-and-goals.md](domain/controller-and-goals.md) | The instance controller: the dock on every surface, conversation scopes and the per-turn context read (ruling 121), the asker's own Claude account (ruling 127), the 57 `viberr_controller` tools, the four `viberr_ops` tools, deployment locks and grant requests, knowledge-base corrections and their undo (rulings 483, 497), chained goals |
| [domain/github-delivery.md](domain/github-delivery.md) | PATs and connections, repo attach, the delivery pipeline, base refreshes (`update_branch_from_base`), PR adoption and collisions, revisions and verdicts, the reconciler, scope violations |
| [domain/auth-and-rbac.md](domain/auth-and-rbac.md) | better-auth setup, CSRF, OAuth whitelist, org and project roles, enforcement, Instance settings, audit, insights, profile (incl. Agent accounts) |

### Operations

| Page | What it answers |
|---|---|
| [operations/configuration.md](operations/configuration.md) | Every environment variable (required, schema-validated, raw reads), non-env settings including the per-person backend credentials, what the image bakes in |
| [operations/deployment.md](operations/deployment.md) | Single-node Docker: secrets, TLS proxy, per-person agent accounts in the container, first run, `npm run deploy`, persistence, backup/restore, re-baselining, the writer lock, the e2e compose file |
| [operations/runbook.md](operations/runbook.md) | Day-2: store check, health fields and probes, rescan vs rebuild, diagnostics, GitHub and runtime issues, auth, retention, lock refusals, self-heal, backup |

### Development

| Page | What it answers |
|---|---|
| [development/contributing.md](development/contributing.md) | Setup, gates, where code goes, invariants, schema changes while pre-prod, pinned docs, definition of done |
| [development/testing.md](development/testing.md) | Vitest config and harnesses, how state is built, doc-pinning tests, lint rules, the e2e flow and spec table, CI |
| [development/scripts.md](development/scripts.md) | Every npm script and CLI, which ones take the writer lock, seed/backup/restore internals |
| [development/performance.md](development/performance.md) | The journeys, the deterministic metrics, the ratchet that only moves down (ruling 457), the measuring harnesses, and what the first pass measured |

### UI

| Page | What it answers |
|---|---|
| [ui/surfaces.md](ui/surfaces.md) | Every route with its guard, purpose and form intents; the shell; screen labels; copy rules tests enforce |

### Validation

| Page | What it answers |
|---|---|
| [validation/2026-09-01-doc-validation.md](validation/2026-09-01-doc-validation.md) | What the documentation before 2026-09-01 claimed, what the code did, and what was changed or left |
| [validation/2026-09-23-doc-sweep.md](validation/2026-09-23-doc-sweep.md) | The second end-to-end sweep: what each page said that the code no longer did, what was added, and the code defects the sweep found |

## Other documentation in the repository

- `README.md`, `CONTRIBUTING.md`, `AGENTS.md`, `CLAUDE.md` at the root: entry points; they
  point here.
- `planning/planning-artifacts/prd.md`: the **canon PRD** (requirements). `design/prd.md`
  is a byte-identical mirror pinned by `app/shared/docs/prd-sync.test.ts`; edit canon only.
- `planning/planning-artifacts/architecture.md` and `ux-design-specification.md`: the
  original design documents. Intent and history; stale in places (see the 2026-09-01
  ledger). The code and this `docs/` set win on conflict. Code comments cite them by
  section name, never by line number, because amendments keep moving the lines.
- `planning/discovery-*/`, `planning/qa/`, `qa/`, `test-artifacts/`: per-pass ledgers,
  notes, canaries and generated reference docs. History, not canon; `planning/README.md`
  says where each pass starts.
- `design/`: the HTML mock and design system (structural source for the UI), plus
  `better-auth-migration.md` (its status banner says what was never built) and
  `CONVERSATION-SUMMARY.md`, a design-conversation digest.
- `.env.example`: the documented environment template, pinned to the env schema's keys
  and the code's raw `VIBERR_*` reads by `env.server.test.ts`; `configuration.md` is the
  superset.
- `app/server/seed/assets/*.md`: the seeded agents' definitions, profiles and skills. They
  are product prompts, not documentation, and are pinned by the seed tests.

## Keeping this set honest

- A page's header names its verification commit. When you change behaviour, correct the
  page's body in the same PR, in present tense, and move the commit reference forward; do
  not stack dated "Updated for ruling N" notes on the header (the git history keeps that
  record).
- `decisions.md` is the exception: a ruling's text is never rewritten. A later change is a
  dated note inside the earlier ruling's block, naming the later ruling, and ruling
  numbers are stable because code comments cite them.
- The pinned files are listed in
  [development/contributing.md §5](development/contributing.md#5-docs-that-tests-pin);
  everything else relies on the pass-close re-read that ruling 44 requires and on the
  periodic end-to-end sweep.
- An owner decision that lives only in a code comment or a pass ledger is not recorded.
  Promote it to the next ruling number.
