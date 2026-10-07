# Viberr documentation

This directory is the reference for Viberr as it is built, written against the code. Each
page's header names its source files and the commit it was last verified against. A change
that alters behaviour corrects the pages it touches in the same pull request, so trust the
code first, then a page's dated header, then anything undated.

Schema changes edit one baseline migration rather than adding to a chain, and file formats
carry no back-compat promise (ruling 683):
[development/contributing.md §4](development/contributing.md#4-data-and-schema-changes) says
what that means for a change.

## Where to start

**Running an instance.** [getting-started.md](getting-started.md) takes a new instance from
`docker compose up` to a task's first agent run. After that:
[operations/deployment.md](operations/deployment.md) for TLS, backups and upgrades,
[operations/configuration.md](operations/configuration.md) for every setting, and
[operations/runbook.md](operations/runbook.md) for day-2 problems.

**Using Viberr.** [product/overview.md](product/overview.md) for the operating model and
what V1 covers, [product/glossary.md](product/glossary.md) for the vocabulary, then
[ui/surfaces.md](ui/surfaces.md) and the domain page for the area you work in.

**Changing Viberr** (people and coding agents). Read in this order:

1. [`../AGENTS.md`](../AGENTS.md): the invariants and the things never to do.
2. [architecture/overview.md](architecture/overview.md): stack, layers, request and boot
   lifecycles, background services, security posture.
3. [architecture/decisions.md](architecture/decisions.md): the binding rulings (numbered,
   stable, cited by code as "ruling N"). Superseded rulings are kept and marked, never
   deleted; read the dated notes.
4. The domain page for whatever you are touching (below).
5. [development/contributing.md](development/contributing.md): where code goes, the gates
   and the definition of done.

## Pages

### Getting started

| Page | What it answers |
|---|---|
| [getting-started.md](getting-started.md) | Install with Docker or from source, first sign-in, the setup checklist (GitHub, people, agent accounts, first project), a first task, sign-in providers, putting it behind TLS |

### Product

| Page | What it answers |
|---|---|
| [product/overview.md](product/overview.md) | Vision, personas, operating model, V1 scope, boundaries, phases |
| [product/glossary.md](product/glossary.md) | Terms and enums: readiness, waiting, validation, packet kinds, capability modes, roles, run states, agent accounts and the credential principal … |
| [product/prd.md](product/prd.md) | The product requirements canon: FR1–FR41 and NFR1–NFR18 with their dated amendments |
| [product/requirements-status.md](product/requirements-status.md) | Every PRD requirement with status and code location; amendment chronology; drift the PRD does not record |

### Architecture

| Page | What it answers |
|---|---|
| [architecture/overview.md](architecture/overview.md) | The system in one read: stack, layer rules, read/write path, boot, timers, security |
| [architecture/codebase-map.md](architecture/codebase-map.md) | Directory-by-directory map of the repository: the top level, `app/` module by module, `db/`, `scripts/`, `test-support/`, `tools/` |
| [architecture/data-model.md](architecture/data-model.md) | Data-root layout including the per-person runtime homes, every SQLite table (primary vs derived vs config), indexes, retention, ids |
| [architecture/file-formats.md](architecture/file-formats.md) | The canonical `project.md`, `task.md`, epic and agent-profile formats; timeline grammar; packet YAML (the `## Packet` section is pinned by a test) |
| [architecture/projections-and-events.md](architecture/projections-and-events.md) | Writers, watcher, tolerant parsing and diagnostics, rebuilder, rescan/rebuild, SSE broker and client |
| [architecture/decisions.md](architecture/decisions.md) | Conventions, the 688 numbered owner rulings in numeric order (117 records a number that was never used), each carrying a dated pointer when a later ruling changed it; the unnumbered owner decisions of 2026-08-20 → 2026-09-01; the route map |

### Domain

| Page | What it answers |
|---|---|
| [domain/task-lifecycle.md](domain/task-lifecycle.md) | Governed mutation shape, RBAC matrix, creation, stages and boundaries, transitions, readiness/waiting/validation, ownership, engagements, packets, recommendations, schedules, delivery, the acceptance endings, archive, timeline, notifications, file leases |
| [domain/operator.md](domain/operator.md) | The Operator, the one agent on every task: authority and gates, triggers and the settle-time backstop, the turn and its snapshot, the `viberr` tools, packets, guardrails |
| [domain/agents-and-runtime.md](domain/agents-and-runtime.md) | Backends, the credential principal and per-person runtime homes (ruling 127), models, a run's life (persistence, admission, streaming, failure kinds, resume), the run console's rows, specialist dispatch and tools, capability catalog and enforcement, context mounting, workspaces and git, boot recovery, seeded catalog |
| [domain/controller-and-epics.md](domain/controller-and-epics.md) | The instance controller: the dock on every surface, conversation scopes and the per-turn context read, the asker's own Claude account, the `viberr_controller` toolkit and the `viberr_ops` diagnostics, deployment locks and grant requests, knowledge-base corrections and their undo; and epics (ruling 503): the epic file, task membership, progress, the Epics pages, the agents' epic tools |
| [domain/github-delivery.md](domain/github-delivery.md) | PATs and connections, repo attach, the delivery pipeline, base refreshes, PR adoption and collisions, revisions and verdicts, the reconciler, scope violations |
| [domain/auth-and-rbac.md](domain/auth-and-rbac.md) | better-auth setup, CSRF, OAuth whitelist, org and project roles, enforcement, Instance settings, audit, insights, profile (incl. Agent accounts) |

### Operations

| Page | What it answers |
|---|---|
| [operations/configuration.md](operations/configuration.md) | Every environment variable (required, schema-validated, raw reads), non-env settings including the per-person backend credentials, what the image bakes in |
| [operations/deployment.md](operations/deployment.md) | Single-node Docker: secrets, TLS proxy, per-person agent accounts in the container, first run, `npm run deploy`, persistence, backup/restore, upgrades, re-baselining, the writer lock, the e2e compose file |
| [operations/runbook.md](operations/runbook.md) | Day-2: store check, health fields and probes, rescan vs rebuild, diagnostics, GitHub and runtime issues, auth, retention, lock refusals, self-heal, backup |

### Development

| Page | What it answers |
|---|---|
| [development/contributing.md](development/contributing.md) | Setup, gates, where code goes, invariants, schema changes, pinned docs, definition of done |
| [development/testing.md](development/testing.md) | Vitest config and harnesses, how state is built, doc-pinning tests, lint rules, the e2e flow and spec table, CI |
| [development/scripts.md](development/scripts.md) | Every npm script and CLI, which ones take the writer lock, seed/backup/restore internals |
| [development/performance.md](development/performance.md) | The journeys, the deterministic metrics, the ratchet that only moves down (ruling 457), the measuring harnesses |

### UI

| Page | What it answers |
|---|---|
| [ui/surfaces.md](ui/surfaces.md) | Every route with its guard, purpose and form intents; the shell; screen labels; copy rules tests enforce |

## Other documentation in the repository

- [`README.md`](../README.md), [`CONTRIBUTING.md`](../CONTRIBUTING.md),
  [`AGENTS.md`](../AGENTS.md) and `CLAUDE.md` at the root: the entry points. They point here.
- [`.env.example`](../.env.example): the documented environment template, pinned to the env
  schema's keys and the code's raw `VIBERR_*` reads by `env.server.test.ts`;
  [operations/configuration.md](operations/configuration.md) is the superset.
- [`LICENSE`](../LICENSE): Viberr's licence, MIT.
- [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md): the licences of code adapted from other
  projects.
- `app/server/seed/assets/*.md`: the seeded agents' definitions, profiles and skills. They
  are product prompts, not documentation, and are pinned by the seed tests.
- History: the original architecture and UX specifications, the HTML mock the UI was ported
  from, the discovery-pass ledgers, QA evidence and the documentation-sweep ledgers left
  the tree before launch (ruling 682). They are in git history; `d423716` is the last
  commit that holds them. A pass or finding id a code comment cites (`F18-14`,
  `P13-D-34`) resolves there.

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
  everything else relies on re-reading the docs a change touches before it closes
  (ruling 44).
- An owner decision that lives only in a code comment or a pull request is not recorded.
  Promote it to the next ruling number.
- Planning notes, ledgers and QA evidence stay out of the tree (ruling 682): put the
  outcome in the code, a page here or a ruling, and the working notes in the pull request.
