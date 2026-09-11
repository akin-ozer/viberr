# Viberr documentation

This directory is the code-verified reference for Viberr as it is built. Every page was
checked against the tree on `main` @ `68b5480` (2026-09-01) and says so in its header;
the six pages ruling 121 touched carry a second, later stamp (2026-09-02, re-verified
2026-09-03 after the ruling's adversarial review);
where an older document was found wrong, the page says what changed and the full ledger
is in [validation/2026-09-01-doc-validation.md](validation/2026-09-01-doc-validation.md).
Viberr is **pre-production**: formats and schemas change without migrations, so trust the
dated header and the code over anything undated.

Updated 2026-09-02 for ruling 127 (branch `claude/per-user-codex-auth-difdnn`): agent backends
are connected **per person** on Profile → Agent accounts, not per instance. Every page that
described deployment-wide backend credentials, the shared runtime homes, the `/host-codex`
mount or the container entrypoint was rewritten in that change. The primary rewrite is
`domain/agents-and-runtime.md`, whose §2 carried the deployment-wide credential table and the
app-owned config homes; the rest are `architecture/decisions.md`,
`architecture/codebase-map.md`, `architecture/data-model.md`, `architecture/overview.md`,
`architecture/file-formats.md`, `domain/auth-and-rbac.md`, `domain/task-lifecycle.md`,
`domain/controller-and-goals.md`, `domain/operator.md`, `domain/github-delivery.md`,
`ui/surfaces.md`, `operations/configuration.md`, `operations/deployment.md`,
`operations/runbook.md`, `product/glossary.md`, `product/requirements-status.md`,
`development/testing.md` and `development/scripts.md`.

Updated 2026-09-11 for ruling 173 (branch `option-d/p0-decision-record`): the Cognipeer Agent
SDK was evaluated and not adopted. Rulings 174 to 176 port the gains it demonstrated onto the
two vendor SDKs, per `planning/option-d-2026-09-11/PLAN.md`; each updates the pages it
touches, starting with `domain/agents-and-runtime.md`, as it lands.

Updated 2026-09-11 for ruling 174 (branch `option-d/pr1-permissions-and-kill`): a settled
run leaves no live process. Every agent child carries `VIBERR_RUN_ID`, the adapters sweep by
it when a run settles and boot sweeps orphans, and the Claude CLI is spawned detached with
`allowDangerouslySkipPermissions` beside bypass. Pages: `architecture/decisions.md` (ruling
174, a note under 142), `domain/agents-and-runtime.md` (§§2.2, 2.4, 2.5, 3.4, 8),
`operations/configuration.md` (§3), `operations/runbook.md` (Agent runtimes),
`architecture/overview.md` (§6 shutdown) and `development/testing.md` (§2).

Updated 2026-09-11 for ruling 175 (branch `option-d/pr3-cost-cap-usage`): an org admin may
cap what one Claude run spends (Org settings, none by default; Codex has no budget option);
a run the cap stops is the `max_budget` cut-off; Claude's token and cost columns count every
call a run made (`modelUsage`). Pages: `architecture/decisions.md` (ruling 175),
`architecture/data-model.md`, `domain/agents-and-runtime.md` (§§2.4, 2.5, 3.1, 3.5),
`domain/auth-and-rbac.md` (§4, §5), `domain/task-lifecycle.md` (§7), `product/glossary.md`,
`operations/configuration.md` (§4), `operations/runbook.md` and `ui/surfaces.md`.

Updated 2026-09-11 for Option D PR 4 (branch `option-d/pr4-alwaysload-once-only`; no ruling):
the operator's and the specialists' in-process tools load up front instead of behind
ToolSearch (the controller's stay deferred: measured, it cost more than it saved), and a
Claude specialist's outcome is the first `report_outcome` it sends; a second is refused and
audited as `task.agent.outcome_duplicate`. Pages: `domain/agents-and-runtime.md` (§§2.4, 3.1,
4.2) and `architecture/data-model.md`.

Updated 2026-09-11 for ruling 176 (branch `option-d/pr2-mcp-tool-gating`): an org admin may
mark an MCP server's write tools in its editor, and a run that withholds repo write (every
operator run among them) does not get them, on Claude by name and on Codex as
`disabled_tools`. The P13-KM-04 prompt paragraph now names only unmarked servers. Pages:
`architecture/decisions.md` (ruling 176, a note under 39), `architecture/data-model.md`,
`domain/agents-and-runtime.md` (§§2.4, 2.5, 4.3, 6), `domain/auth-and-rbac.md` (§4),
`ui/surfaces.md` (§3), `product/glossary.md` and `product/overview.md`.

Updated 2026-09-11 for the ruling 101(e) amendment (Option D PR 5, branch
`option-d/pr5-pretooluse-deny`): a Claude run with command-level denies carries a PreToolUse
hook that refuses a denied command however it is wrapped (`git -C . push`, `sh -c 'git
push'`), with a reason naming the withheld capability that the model reads and the console
shows. Pages: `architecture/decisions.md` (the note under ruling 101) and
`domain/agents-and-runtime.md` (§2.4, §4.3).

Updated 2026-09-11 for Option D PR 6 (branch `option-d/pr6-hygiene`): stale docstrings and
drift notes corrected. Ruling 93's drift note now says R22 and ruling 101 both stand (the
Codex `read-only` sandbox is a live seam), ruling 109 carries the `permissions.rs` watch
item, and `domain/agents-and-runtime.md` §2.5 and gotcha 6 match.

Updated 2026-09-11 for rulings 181 and 182 (pass 36, branch `pass36/headlamp-clone-fixes`,
Cluster 3): every Codex run gets a private `CODEX_HOME` forked from the person's home
(`runs/<runId>/`: sign-in and config copied, sessions/skills/memories linked,
`CODEX_SQLITE_HOME` shared, the refreshed sign-in carried back under a per-person lock);
the Codex sandbox is probed once per process with the CLI's own sandbox helper, reported
as `toolchain` — appended LAST — on `/resources/health`, `instance_health` and the boot
integrity line, and a confined Codex run is refused with a named remedy while the probe
fails; `compose.yml` lifts Docker's seccomp profile for bubblewrap. Pages:
`domain/agents-and-runtime.md` (§2.2, §2.5), `operations/deployment.md` (new "Codex
sandbox (seccomp)"), `operations/runbook.md` (Agent runtimes: the `bwrap` and
`codex-linux-sandbox` symptoms), `architecture/data-model.md` (data-root layout) and
`development/testing.md` (§2, the hermetic toolchain).

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
| [architecture/codebase-map.md](architecture/codebase-map.md) | Directory-by-directory map of `app/`, `db/`, `scripts/`, `test-support/` |
| [architecture/data-model.md](architecture/data-model.md) | Data-root layout including the per-person runtime homes, every SQLite table (primary vs derived vs config), indexes, retention, ids |
| [architecture/file-formats.md](architecture/file-formats.md) | The canonical `project.md`, `task.md`, goal and agent-profile formats; timeline grammar; packet YAML (the `## Packet` section is pinned by a test) |
| [architecture/projections-and-events.md](architecture/projections-and-events.md) | Writers, watcher, tolerant parsing and diagnostics, rebuilder, rescan/rebuild, SSE broker and client |
| [architecture/decisions.md](architecture/decisions.md) | Conventions, 176 numbered owner rulings (1–176; 117 records a number that was never used), the unrecorded decisions since 2026-08-20, the route map |

### Domain

| Page | What it answers |
|---|---|
| [domain/task-lifecycle.md](domain/task-lifecycle.md) | Governed mutation shape, RBAC matrix, creation, stages and boundaries, transitions, readiness/waiting/validation, ownership, engagements, packets, recommendations, schedules, delivery, the acceptance endings, archive, timeline, notifications |
| [domain/operator.md](domain/operator.md) | The per-task coordinator: authority and gates, triggers, the turn, the 12 `viberr` tools, packets, guardrails |
| [domain/agents-and-runtime.md](domain/agents-and-runtime.md) | Backends, the credential principal and per-person runtime homes (ruling 127), models, a run's life (persistence, admission, streaming, failure kinds, resume), specialist dispatch and tools, capability catalog and enforcement, context mounting, workspaces and git, boot recovery, seeded catalog |
| [domain/controller-and-goals.md](domain/controller-and-goals.md) | The instance controller: the dock on every surface, conversation scopes and the per-turn context read (ruling 121), the asker's own Claude account (ruling 127), the 41 `viberr_controller` tools, `viberr_ops`, deployment locks, chained goals |
| [domain/github-delivery.md](domain/github-delivery.md) | PATs and connections, repo attach, the delivery pipeline, PR adoption and collisions, revisions and verdicts, the reconciler, scope violations |
| [domain/auth-and-rbac.md](domain/auth-and-rbac.md) | better-auth setup, CSRF, OAuth whitelist, org and project roles, enforcement, org settings, audit, insights, profile (incl. Agent accounts) |

### Operations

| Page | What it answers |
|---|---|
| [operations/configuration.md](operations/configuration.md) | Every environment variable (required, schema-validated, raw reads), non-env settings including the per-person backend credentials, what the image bakes in |
| [operations/deployment.md](operations/deployment.md) | Single-node Docker: secrets, TLS proxy, per-person agent accounts in the container, first run, persistence, backup/restore, re-baselining, the writer lock |
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
