# Feature — Assign & run a specialist from task detail

Lets a user **assign a deployed specialist agent to a task** and **start a real
agent run** for it from the task-detail UI, then watch it stream in the agent
logs. Before this, runs only appeared from seed data or the operator-scheduling
reaction; there was no way to deploy a specialist to a task and run it.

Gates at close: `npm run typecheck` clean, `npm test` **776/776** (756 prior +
20 new), `npm run build` clean. Live-verified in the running dev server against
the `containerless` demo (CTL-1 + the `dev` specialist) — the assign control
renders and its menu lists the deployed `dev` agent. **`./data` was NOT
modified and NOT reseeded** (verified: `git status --short data/` is empty; the
browser check only opened/closed the menu, never submitted an intent).

## What was added

### Server — `app/server/tasks/specialist-run.server.ts` (new)

- **`assignSpecialist(db, {projectSlug, taskKey, profileId}, actor, ctx?)`** —
  resolves the profile from the project's `agents:` deployments (via the same
  template+definition merge the Agents surface uses, `effectiveProfileView`);
  errors (typed `AppError`) if the id is not a deployed *specialist* (an
  operator, or an unknown id). Writes `specialist = {profileId, backend, role}`
  frontmatter + appends a typed `agent` timeline event
  `Deployed **<name>** (<role>, <backend>) as the primary specialist.` →
  reproject → `recordAudit("task.specialist.assigned")` → SSE rides the
  reproject.
- **`startSpecialistRun(db, {projectSlug, taskKey}, actor, ctx?)`** — requires
  an assigned specialist (typed error otherwise); resolves backend/model from
  it. Builds an analyze prompt from the task title + goal, hands off to the
  Phase-8 `startRun` with role `"Primary specialist"`, kind `"primary"`, the
  specialist backend/model, and a **realistic simulated fallback script**
  (system·init → `ls -R` / read `package.json` tool lines → an assistant
  findings summary → a final `result`/`turn.completed` with usage). Appends a
  typed `agent` event `Started a <backend> run for the <role> specialist —
  streaming to the agent logs.` and audits `task.specialist.run_started`
  (`runtime.run.started` is emitted by `startRun`, not double-counted — asserted
  in tests).
- **`listDeployedSpecialists` / `resolveDeployedSpecialist` / `hasRunningRun`** —
  loader/action helpers.
- **RBAC (both fns): admin|maintainer**, checked against project membership
  (`requireRuntimeRole`), mirroring transition/interrupt — contracts §3.2 "Open
  agent runtime sessions". Reviewer/viewer/non-member → typed 403.

### Real vs simulated

- The requested backend is the specialist's first `backends` entry (codex|claude;
  defaults to claude). When a real credential IS present
  (`isBackendAvailable(backend)`), `startRun` uses the real SDK and ignores the
  script. With no credential the simulated engine replays the analyze script so
  the console streams meaningfully — `simulated=1`, requested backend kept for
  glyph fidelity (Phase-8 behavior).
- The demo machine has no keys, so every run is simulated — exactly as briefed.

### Repo clone

- `startSpecialistRun` best-effort `git clone --depth 1` of the task/project
  repo into `<taskDir>/workspace/<repo-name>` and points the run's workdir
  there (new optional `workdir` on `StartRunInput`). The PAT is injected
  (`getProjectCredential` → `getPatToken`, `https://x-access-token:<tok>@…`) when
  a project credential is bound, else a plain clone (public repos). On any
  failure it falls back to the task dir and adds *"Clone the repo yourself from
  https://github.com/<repo> if needed."* to the prompt.
- **The clone only runs when a real backend is available** — the simulated
  engine needs no checkout, so with no credential the network clone is skipped
  (keeps the demo + test suite fast and offline). Still best-effort even when
  real.

### Route — `app/routes/project.task.tsx`

- Action intents (CSRF + requireUser, RBAC inside the server fns):
  - `assign-specialist` (formData `profileId`) → toast `Deployed <name> as specialist`
  - `run-specialist` → toast `<backend> run started · streaming to agent logs`
- Loader now returns `deployedSpecialists` (id/name/role/backend/model) and
  `runActive` (a run for this task is currently `running` → disables Run).

### UI — `app/features/task-detail/execution-profile.tsx` + `task-detail-page.tsx`

- In the **Primary specialist** cell, when no specialist is assigned and the
  viewer is admin|maintainer: a **`SpecialistControl`** "Assign specialist ▾"
  menu (mirrors `OwnerControl`: button opens a menu listing deployed specialists
  by name/role/backend-glyph; Escape/scrim close; picking one submits
  `assign-specialist` via a fetcher). Zero deployed specialists → a hint linking
  to the project Agents page.
- When a specialist IS assigned: a small primary **Run** button submits
  `run-specialist` (fetcher, CSRF), disabled while `runActive`.
- All affordances gated by `canRunAgents` (admin|maintainer, from `myRole`);
  the server re-checks. Design-system classes/tokens only; no Tailwind, no
  inline hex. A client-safe `DeployedSpecialistView` type is defined in the
  component (not imported from the server module) so no server code leaks into
  the client bundle.

### Audit catalog — `app/server/audit/audit-actions.ts`

- Added `task.specialist.assigned` + `task.specialist.run_started` (scope
  `task`) so the audit-coverage sweep stays green.

### Runtime — `app/server/runtimes/run-service.server.ts`

- `StartRunInput` gained an optional `workdir` (defaults to the task dir) so the
  specialist run can point at the freshly-cloned repo.

## Tests (20 new)

- `app/server/tasks/specialist-run.server.test.ts` (8): assign resolves the
  deployed profile + writes frontmatter/event/audit; RBAC-denied for
  reviewer/viewer, allowed for maintainer; error for unknown profile; run
  creates a `primary` row with the specialist backend + the simulated fallback
  streams >0 lines; RBAC; error when no specialist. (Runs are interrupted at
  test end so their realistic-cadence timer never outlives the test.)
- `app/features/task-detail/task-detail-route.server.test.ts` (7): loader
  exposes deployed specialists (operator excluded) + `runActive`; assign happy
  path + reviewer-denied + unknown-profile; run requires a specialist;
  run happy path (a `primary` run appears + streaming toast); reviewer-denied.
- `app/features/task-detail/task-detail-components.test.tsx` (5, jsdom): the
  assign menu lists specialists and submits the picked id; the empty-roster
  hint links to Agents; the Run button submits and disables while a run is
  active; non-privileged roles get no assign/run affordances.

## How to verify in the browser (assign `dev` to CTL-1 and run it)

Signed in as the demo admin, on `/projects/containerless/tasks/CTL-1`:

1. In the **Execution profile** panel → **Primary specialist** cell, click
   **"Assign specialist ▾"**.
2. Pick **dev** (developer) from the menu → toast **"Deployed dev as
   specialist"**; the cell now shows the dev glyph + "developer · Claude Code".
3. Click the **Run** button → toast **"Claude Code run started · streaming to
   agent logs"**; a live run strip appears and the **Agent logs** panel streams
   the analyze transcript (ls -R, read package.json, findings summary, result).
   The Run button reads "Running…" and is disabled while it streams.
4. Only admin|maintainer see the assign/run controls; reviewers/viewers see the
   read-only "the operator assigns one" copy.

## Follow-ups (not done, intentional)

- The clone is `--depth 1` and one repo per task under `workspace/`; no cleanup
  of that directory. Fine for the demo; a real deployment may want a GC.
- A machine running real backends needs `git` + a CA bundle in the image — a
  Dockerfile change for that was already present in the working tree (not mine).
- `resolveDeployedSpecialist` picks the *first* runnable backend; a future UI
  could let the user choose when a profile lists both codex and claude.
