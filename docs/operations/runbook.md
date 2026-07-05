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

The file watcher (chokidar, 250 ms debounce) drives incremental rebuilds automatically in
both dev and prod; boot also runs a reconciling rescan so out-of-band edits made while the
app was down converge before the first request.

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
- PR/branch state refreshes on the explicit **Reconcile** action (no scheduled poll in V1).

## Agent runtimes

- With no `ANTHROPIC_API_KEY` / `CODEX_API_KEY`, runs use the **simulated** backend
  (labelled as such) so the app is fully functional offline. Add a key and restart to
  enable the real Claude Agent SDK / Codex SDK backends.
- Raw run logs are append-only under `$VIBERR_DATA_ROOT/runtimes/<backend>/`; the log
  panel projects them. Interrupt is admin/maintainer-gated and audited.

## Auth / access

- Sessions live in SQLite (`sessions`); expired sessions are swept at boot and daily.
- Locked out / forgotten password: an admin resets it in Org settings → Users
  (`resetPassword` sets a one-time temp password + forces a reset at next sign-in). The
  bootstrap admin comes from `VIBERR_SEED_ADMIN_*` on first boot of an empty DB.
- OAuth sign-in only succeeds for a whitelisted account/domain (no self-signup).

## Growth / cleanup (known follow-up)

`audit_events`, `provenance`, and `run_log_lines` grow without an automated retention
policy in V1. If the DB gets large, with the app stopped you can prune old rows by date
via SQLite (e.g. `DELETE FROM provenance WHERE observed_at < …;` then `VACUUM;`) — audit
rows are the compliance record, so prune those conservatively. Projections rebuild from
files regardless, so pruning derived/log tables is safe.

## Backup / restore

See [deployment.md](./deployment.md#persistence-backup--restore). Short version: back up
the whole data-root directory; to restore, put it back and start. If only the SQLite file
is lost, rebuild projections from the surviving `projects/` files.
