# Runbook — operating Viberr

Quick reference for the common operational tasks and failure modes. All commands run
from the repo root (or `docker compose exec app …` inside the container).

## Health & liveness

- `GET /resources/health` → `{ ok, projections: { projects, tasks }, watcher }`.
  `ok:false` / HTTP 503 means the SQLite projection DB is unreachable. `watcher` reports
  whether the file-watch service is alive.
- Boot log (structured JSON to stdout) prints a startup integrity line: data-root dirs,
  applied migrations, and projection counts. Grep it after a deploy.

## Files are canonical; the DB is a cache

Authoritative state is the markdown under `$VIBERR_DATA_ROOT/projects/`. SQLite holds
*projections* derived from those files plus app-management data (users, sessions, PATs,
audit, notifications). Anything projection-shaped can be rebuilt from files.

## Rescan vs. rebuild

- **Re-scan** (Home store strip, or `npm run rescan`): incremental — re-reads changed
  files (content-hash short-circuit) and updates projections. Use after editing task/
  project files directly, or if the watcher missed a change.
- **Rebuild projections** (Home, admin-only, confirm dialog; or the boot reconcile): drops
  all derived projection rows and rebuilds them from files in one transaction. Use if
  projections look inconsistent, after restoring only `projects/` without the DB, or after
  a schema migration that changes projection shape. Users/sessions/PATs/audit are **not**
  touched.

The file watcher (chokidar, 250 ms trailing debounce) drives incremental rebuilds automatically in
both dev and prod; boot also runs a reconciling rescan so out-of-band edits made while the
app was down converge before the first request. (Chokidar replaced the native `fs.watch`
recursion in the 2026-08-03 modernization; the domain layer — debounce, ignore rules,
projection rebuilds — is unchanged.)

## Diagnostics (a task looks wrong / stuck)

Malformed or inconsistent task files never crash the app — they produce diagnostics and a
readiness downgrade (tolerant parsing):

- Invalid frontmatter / unparseable → the task's DiagnosticsPanel lists findings, the board
  pill and readiness reflect the severity (`input_required` / `inconsistency_risk_detected`
  / `blocked`), and an entry appears under Activity → Audit logs.
- Fix the file on disk → the watcher re-projects within ~1 s and the diagnostic clears
  (or run `npm run rescan`).
- Unknown workflow stage → warning + readiness floor until the stage is added in project
  settings or the task is moved. Duplicate `## Goal`/`## Packet`/`## Timeline` sections →
  warning, first occurrence wins.

## GitHub / PAT issues

- Per-project credential health and scope violations show on the GitHub view and the task.
  Diagnostics distinguish `insufficient_scope`, `expired`, `revoked`, `repo_not_found`,
  `org_approval_missing`, `network_error`.
- Accept-completion merges the review PR; a missing `pull_request:write` scope surfaces as
  an open scope violation with a Grant-scope action (re-validate the PAT) rather than a
  silent failure.
- PR/branch state refreshes on a background poller: once at boot, then every 5 minutes
  over every project with branched tasks. It emits divergence events, notifications,
  recommendation withdrawals and merge-pending nudges with no human in the loop. The
  **Update status** button on the GitHub view forces an immediate reconcile; the page
  shows how old the cached state is.

## Agent runtimes

- A backend with **no** credential is **unavailable**: a run started on it fails fast with
  an honest "backend unavailable" error and a blocked recovery packet. Detection is
  presence-only (no paid call) and happens at process start, so set the variable and
  restart. Six credential paths count, and the triage is "which of these is set?":

  | backend | any one of these makes it available |
  |---|---|
  | Claude | `ANTHROPIC_API_KEY` · `CLAUDE_CODE_OAUTH_TOKEN` · `VIBERR_CLAUDE_USE_CLI_AUTH=1` (the host `claude` CLI is already logged in) |
  | Codex | `CODEX_ACCESS_TOKEN` · `CODEX_API_KEY` · `OPENAI_API_KEY` · `VIBERR_CODEX_USE_CLI_AUTH=1` **and** `$CODEX_HOME/auth.json` present on disk |

- **Codex's CLI-auth path has a second condition, and it is the recurring docker trap.**
  The flag alone is not enough — the file must exist. `CODEX_HOME` defaults to
  `/data/runtimes/codex-home` under Compose, which lives on the `./docker-data` volume,
  so recreating that directory silently drops `auth.json` while `VIBERR_CODEX_USE_CLI_AUTH=1`
  stays set in `.env`. Codex then reports **unavailable** with a correct, actionable
  message naming the missing file. Fix it by copying the credential back, not by
  re-setting the flag:
  `docker compose cp ~/.codex/auth.json app:/data/runtimes/codex-home/auth.json`
  (readable/writable by uid 1000). Full matrix:
  [deployment.md](./deployment.md#agent-backends-in-the-container).
- Raw run logs are append-only under `$VIBERR_DATA_ROOT/runtimes/<backend>/`; the log
  panel projects them. Interrupt is admin/maintainer-gated and audited.

## Auth / access

- Sessions live in SQLite (`sessions`); expired sessions are swept at boot and daily.
- Locked out / forgotten password: an admin resets it in Org settings → Users
  (`resetPassword` sets a one-time temp password + forces a reset at next sign-in). The
  bootstrap admin comes from `VIBERR_SEED_ADMIN_*` on first boot of an empty DB.
- OAuth sign-in only succeeds for a whitelisted account/domain (no self-signup).

## Retention & growth

A retention pass (`applyRetention`) runs on **every boot**, best-effort, before the first
request. It is not optional and none of its windows is env-configurable:

| table | policy |
|---|---|
| `run_log_lines` | deleted after **30 days** |
| `audit_events` | deleted after **90 days** — **except two recovery-marker actions (below)** |
| `notifications` | trimmed to the **newest 500 per user** |

**Two audit actions are exempt from the 90-day delete**, because boot recovery uses them as
IDEMPOTENCY KEYS rather than as history:

| exempt action | boot-recovery reader |
|---|---|
| `task.agent.replied` | `recoverUnreactedAgentRuns` |
| `runtime.operator.plan_executed` | `recoverStrandedOperatorPlans` |

Recovery decides whether an effect already happened by asking whether its audit row exists
(`NOT EXISTS (SELECT 1 FROM audit_events …)`), so pruning one of these does not merely lose
history — it makes the **next boot redo the work**. A >90-day-old task still sitting at
`waiting=agent` would have its finished run's reply posted a second time. They are listed
explicitly in `IDEMPOTENCY_AUDIT_ACTIONS` (`app/server/db/retention.server.ts`), never
pattern-matched, so adding a recovery marker is a deliberate act. The lesson generalises:
a row with **no display reader is not a dead row** — these are load-bearing precisely
because a background reader depends on them.

Two consequences worth internalising:

- **Audit is not kept forever.** Do not plan a compliance process around "the audit table
  has it". Task-scoped history also lives in the canonical `task.md` and survives
  indefinitely, but org- and auth-scoped rows (`auth.login.*`, `org.user.*`,
  `org.connection.token_replaced`, `github.pat.*`) have no file counterpart and are gone
  at 90 days. There is no export path in V1 — if you need a longer window, snapshot the
  data root (which contains the SQLite file) on a schedule.
- **`provenance` is the one table with no retention** and is the one that actually grows
  without bound. It is derived observational state, so pruning it is safe: with the app
  stopped, `DELETE FROM provenance WHERE observed_at < …;` then `VACUUM;`.

### Task workspaces (disk, not SQLite)

Every task that has run a specialist holds a full git clone at
`projects/<slug>/tasks/<KEY>/workspace/<repo>` — 11-16 MB each on a real repository. These
are **not** covered by `applyRetention`, which only compacts SQLite tables.

A separate pass on every boot removes the workspace of any task sitting in its project's
**terminal stage**, and logs `reclaimed finished task workspaces` with the count and MB when
it removes anything. It runs after run recovery, so nothing in flight is touched.

The clone is a cache, never canonical: the record is `task.md` and delivered work is on the
remote branch. Reopening a finished task simply re-clones on its next run. If disk is tight
before a restart, removing a finished task's `workspace/` directory by hand is safe —
removing one for a task still in progress only forces a re-clone, but will interrupt a
running agent.

Canonical Markdown files are never touched by retention.

## Backup / restore

See [deployment.md](./deployment.md#persistence-backup--restore). Short version: back up
the whole data-root directory — **including `state/projection.sqlite`** — and to restore,
put it back and start. Rebuilding projections from `projects/` recovers the derived tables
only; users, sessions, PATs, audit and notifications live nowhere else and cannot be
reconstructed from files.
