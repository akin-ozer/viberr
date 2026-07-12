# Runbook — operating Viberr

Quick reference for the common operational tasks and failure modes. All commands run
from the repo root (or `docker compose exec app …` inside the container).

## Health & liveness

- `GET /resources/health` →
  `{ ok, integrity, projections: { projects, tasks }, watcher, backends }`.
  `integrity` is the bounded SQLite quick-check result. HTTP 503 means the database is unreadable
  or structurally unhealthy; `integrity.recoveryRequired=true` is the explicit stop-and-recover
  contract. `watcher` reports whether the file-watch service is alive.
- `backends.{claude,codex}.status` is `unconfigured`, `unknown`, `verified`, or `degraded`.
  Health never calls a provider: a credential establishes `configured`; only recent real-run results
  establish verified/degraded.
- Boot log (structured JSON to stdout) prints a startup integrity line: data-root dirs,
  applied migrations, and projection counts. Grep it after a deploy.

## File-native product truth and app-owned database state

Authoritative project/task state is the markdown under `$VIBERR_DATA_ROOT/projects/`. Agent
profiles, KBs, and skills are file-native too. SQLite holds their projections plus app-owned users,
sessions, GitHub/MCP secrets, audit, notifications, org-resource metadata, runtime rows, and operator
dispatches. Projection-shaped rows can be rebuilt; the app-owned rows cannot.

## Rescan vs. rebuild

- **Re-scan** (Home store strip, or `npm run rescan`): incremental — re-reads changed
  files (content-hash short-circuit) and updates projections. Use after editing task/
  project files directly, or if the watcher missed a change.
- **Rebuild projections** (Home, admin-only, confirm dialog; or the boot reconcile): drops
  all derived projection rows and rebuilds them from files in one transaction. Use if
  projections look inconsistent, after restoring only `projects/` without the DB, or after
  a schema migration that changes projection shape. Users/sessions/PATs/audit are **not**
  touched.

The file watcher (chokidar, 250 ms debounce) drives incremental rebuilds automatically in
both dev and prod; boot also runs a reconciling rescan so out-of-band edits made while the
app was down converge before the first request.

Neither operation repairs a structurally corrupt SQLite file. Rebuild drops and reprojects derived
rows inside the existing healthy database; it deliberately preserves app-owned rows.

## SQLite integrity incident

1. Stop the app immediately: `docker compose stop app`.
2. Preserve `docker-data/state/projection.sqlite` and any `projection.sqlite-wal` /
   `projection.sqlite-shm` files together before experimenting.
3. Never open the live bind-mounted WAL database from both Docker Desktop and a host SQLite process.
   Inspect only an offline copy after the container has stopped.
4. Prefer restoring a complete data-root backup. This restores canonical files and app-owned DB state
   together.
5. If no DB backup exists, the project/task files still preserve their canonical records, but a fresh
   DB loses users, sessions, secrets, audit, notifications, org metadata, and dispatch history.
   Re-provision identity and repair canonical member/owner ids before claiming recovery. Do not call
   that process lossless.

For this pass's disposable demo database only, the breaking fresh-schema procedure is: stop the app;
move the SQLite/WAL/SHM trio out of `docker-data/state/`; rebuild the image; then run
`docker compose run --rm app npm run seed`. `seed -- --reset` is a separate destructive content
reset: it removes every project/profile/runtime/KB/skill, MCP configuration, and domain allowlist,
then replaces the demo fixtures while preserving users, installed GitHub credentials, and encrypted
org-secret values.

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
- Completion acceptance requires the governed Review stage, exactly healthy validation, and an
  explicit structured approval from every assigned reviewer. A repository-backed task also requires
  a linked review PR.
- Acceptance attempts the merge. If it cannot prove a real merge, the task stays in Review with
  `pr.state=accepted` and **merge pending**; only a later successful merge moves it to Done. A
  repo-less healthy task may finish directly.
- A missing `pull_request:write` scope surfaces as an open scope violation with a Grant-scope action
  (re-validate the PAT) rather than a silent failure.
- PR/branch state refreshes on the explicit **Reconcile** action (no scheduled poll in V1).

Viberr owns remote delivery after a specialist finishes: it uses the stored project credential to
push the local task branch, verifies the exact remote head and a non-empty comparison, then opens or
reuses the task PR. The credential is never handed to the model run.

## Agent runtimes

- Without a supported credential, runs use the **simulated** backend (labelled as such) so the app is
  functional offline. Claude supports `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, or explicit
  cached CLI auth. Codex supports `CODEX_ACCESS_TOKEN`, `CODEX_API_KEY`/`OPENAI_API_KEY`, or explicit
  cached CLI auth. Restart after changing credentials.
- Raw run logs are append-only under `$VIBERR_DATA_ROOT/runtimes/<backend>/`; the log
  panel projects them. Interrupt is admin/maintainer-gated (or an audited org-admin emergency
  override), shows a pending acknowledgement, and reports success only when the exact run is terminal.
- Each reviewer gets a stable isolated workspace namespace. A real reviewer result governs validation
  only when it contains exactly one line
  `VIBERR_REVIEW_VERDICT: {"verdict":"approve|request_changes","summary":"..."}`. Simulated runs and
  ordinary prose do not satisfy review. Any request-changes returns the task to implementation; every
  currently assigned reviewer must approve the next evidence round.

### Automatic operator dispatch

- Task creation and human lifecycle transitions enqueue durable dispatches; repeated active triggers
  for the same task coalesce. A placeholder goal records awaiting input and starts no paid turn.
- Defaults: two automatic runs concurrently, one dollar of observed/reserved cost per rolling hour,
  and five cents reserved per run. Configure with `VIBERR_OPERATOR_AUTO_CONCURRENCY`,
  `VIBERR_OPERATOR_AUTO_HOURLY_BUDGET_USD`, and `VIBERR_OPERATOR_AUTO_ESTIMATED_RUN_USD`.
- Boot requeues interrupted dispatcher rows. Timeline/audit records trigger provenance and routing
  decisions.
- Hard stage, deployment, capability, MCP-compatibility, and backend constraints remove impossible
  profiles within the current project. The operator receives remaining project candidate
  skill/KB/MCP/backend-health facts plus organization-wide current workload and observed-cost
  context, makes the final choice without a static score, and persists its reason.

### MCP resources

- Org Settings stores encrypted organization secrets separately from MCP configuration. Auth mappings
  use explicit `Header-Name=secret://org/name` for HTTP or `ENV_NAME=secret://org/name` for stdio.
- **Test connection** performs MCP initialize and tools/list; authentication/protocol failures are not
  reported as network reachability success.
- Only MCPs selected on the deployed profile are injected. Backend-incompatible configurations are
  excluded during routing/run preflight rather than silently dropped.

## Auth / access

- Sessions live in SQLite (`sessions`); expired sessions are swept at boot and daily.
- Locked out / forgotten password: an admin resets it in Org settings → Users
  (`resetPassword` sets a one-time temp password + forces a reset at next sign-in). The
  bootstrap admin comes from `VIBERR_SEED_ADMIN_*` on first boot of an empty DB.
- OAuth sign-in only succeeds for a whitelisted account/domain (no self-signup).
- A contributor+ current task owner may resolve that task's packets and accept its completion;
  maintainers/admins retain project-wide authority. Organization admins have audited emergency
  project-admin authority without being added to the project. That emergency authority does not put
  every project decision into the admin's personal queue.

## Archive / restore

An archived project is readable history through direct routes, but all project mutations and new
runs are rejected. Archiving stops queued/running project sessions. Settings becomes read-only except
for **Restore**; restoration re-enables the ordinary role-bound controls. Archived projects are not
presented as active work on Home.

## Growth / cleanup (known follow-up)

`audit_events`, `provenance`, and `run_log_lines` grow without an automated retention
policy in V1. If the DB gets large, with the app stopped you can prune old rows by date
via SQLite (e.g. `DELETE FROM provenance WHERE observed_at < …;` then `VACUUM;`) — audit
rows are the compliance record, so prune those conservatively. Projections rebuild from
files regardless, so pruning derived/log tables is safe.

## Backup / restore

See [deployment.md](./deployment.md#persistence-backup--restore). Short version: back up
the whole data-root directory; to restore, put it back and start. If only SQLite is lost, surviving
files preserve canonical project/task content but not identity, secrets, audit, org metadata, or
runtime/dispatch history. Follow the integrity-incident procedure; a projection rebuild is not a
complete database restore.
