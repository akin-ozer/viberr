# Release notes — July 2026 hardening pass

Reliability, GitHub delivery, and access-control fixes from live testing. No new features.

## Runs & reliability

- **Server restarts no longer strand runs.** A run interrupted by a restart is now cleanly marked failed instead of showing "running" forever with a stuck elapsed-time counter.
- **The home page's "runs active" count is now honest** about demo/simulated runs instead of letting them look identical to real work indefinitely.
- **Fixed a bug that could eventually stop all agent runs from starting** on long-lived installs, where runs would fail instantly with no explanation as history accumulated.
- **Runs that fail within milliseconds of starting are no longer silent** — you'll now get a notification and timeline entry instead of a task stuck with no explanation.
- Confirmed working: dragging a task straight into Done already counts as accepting it.

## GitHub delivery

- **Completed work now reliably gets pushed for review**, instead of sometimes sitting committed locally with no PR ever opened.
- **Empty changes are now flagged, not hidden** — if an agent's work produces no actual diff, you'll see a clear notice instead of the task quietly stalling.

## Docker / Codex

- **Codex authentication problems in Docker are now caught early** with a clear message, instead of every run failing with an unreadable error.
- Confirmed working: Docker/Codex failure messages already distinguish between different causes (auth, config, sandbox).

## Permissions

- **Task owners can now accept their own completed work**, matching the intended permission rules.
- **Archived tasks are now properly locked from further edits.**

## UI

- Fixed overlapping text on the decision-packet confirmation button.

## Known issues

- Codex's live run panel still shows 0 turns/tokens while a run is in progress; usage only appears once the run finishes. Cosmetic, not yet fixed.
