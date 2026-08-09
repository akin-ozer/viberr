# G19-c · FR23 — reach an agent's native runtime session (live runbook)

**Proves:** FR23 ("Authorized users reach an agent's native runtime session for deep debugging").
Unit-pinned by `app/server/runtimes/session-export.server.test.ts` (probeSessionContinuity by
filename AND content; a filename miss is not a dead session).

**Preconditions:** a task with at least one finished agent run (e.g. VC-10 or VC-12 in Viberr Core).
**Steps:**
1. Open the task detail → Agent logs panel. It shows the run's `@anthropic-ai/claude-agent-sdk ·
   stream-json · session <id>` header with **Export** and **{ } raw** controls.
2. Click **Export** → the raw NDJSON session transcript downloads (the native runtime session).
3. Click **{ } raw** → the telemetry envelope (token/rate-limit accounting) expands inline.
**PASS:** the export contains the real session id from the header and the model's turns; a run whose
provider transcript was lost surfaces a `continuity` typed event + the D18 panel instead (not a
silent gap). **FAIL → finding:** Export empty / 404, or a lost session shows nothing.
**Cleanup:** none (read-only).
