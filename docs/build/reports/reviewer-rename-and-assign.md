# Feature — rename "consultant" → "reviewer" + assign/run/remove reviewers on a task

Two linked asks: (1) a task's non-primary agents were called **consultants** and
couldn't be assigned from the task UI — only displayed; (2) the concept should be
renamed to **reviewer** everywhere. Delivered as a full data-model rename plus a
new assign/run/remove reviewer surface with parity to the primary specialist.

Gates at close: `npm run typecheck` clean · `npm test` **882/882** (+12 new) ·
`npm run build` clean. Verified live in the UI against a **copy** of the running
container's data (migration 0011 applied to that real data; assign→run→remove
cycle exercised).

---

## Part A — full rename `consultant` → `reviewer`

### Data model

- **task.md frontmatter** `consultants:` → `reviewers:` (`app/schemas/task-file.schema.ts`).
  Tolerant back-compat: the parser reads a pre-rename `consultants:` key as
  `reviewers` (`data.reviewers ?? data.consultants`) and does NOT preserve the
  legacy key as "unknown", so a rewrite emits only `reviewers:` — never both.
- **DB** `db/migrations/0011_reviewer_rename.sql`:
  - widens `agent_runs.kind` CHECK from `('operator','primary','consultant')` →
    `(…,'reviewer')`, mapping any historical `kind='consultant'` → `'reviewer'`.
    SQLite can't ALTER a CHECK in place, and the migration runs in a transaction
    where `PRAGMA foreign_keys` can't be toggled, so a naive parent-table drop
    would cascade-delete `run_log_lines`. The migration therefore backs the child
    rows into a constraint-free table, drops the child, rebuilds the parent,
    rebuilds the child (FK → new parent), and restores the rows — **all run +
    log-line data preserved** (validated on a populated DB before shipping).
  - renames `task_projections.consultants_json` → `reviewers_json`.
- **Enums** `RunKind` (`runtime-types`) and `Engagement` (`agent-types`):
  `"consultant"` → `"reviewer"`. Thread-prefix map + roleShort + agents-page
  ordering + agent-deployments projection updated to match. The deployments
  projection accepts both `r<idx>` (app-started) and legacy `c<idx>` reviewer
  threads.
- **Projection writer/reader**: `rebuilder.server.ts` (INSERT + values),
  `task.server.ts` mapping (`Row`/`TaskSummary.reviewers`), `board-filters`.
- **Capability** `summon-consultants` → `summon-reviewers` (id + label);
  the two dev-dataset files that referenced the id were updated too.
- **Seeds**: runtime-seed-data run `kind`/`role`, demo-data frontmatter field +
  the demo advisory agent's display strings (`Consultant` → `Advisor`, role
  `Advisory`), keeping the internal `consultant` profile id (there is already a
  separate `reviewer` demo agent — the advisory one is a distinct persona).

No user-visible "Consultant" string remains; only internal seed identifiers
(`profileId: "consultant"`, a helper variable) stay for id stability.

### Audit

`audit-actions.ts` gains `task.reviewer.assigned` / `.removed` / `.run_started`.

---

## Part B — assign / run / remove reviewers (the missing feature)

### Server (`app/server/tasks/specialist-run.server.ts`)

- **`assignReviewer`** — resolves a deployed specialist, appends its `AgentRef`
  to `reviewers[]` (idempotent — a profile already engaged is `alreadyEngaged:
  true`), typed `agent` event, reproject, audit. RBAC admin|maintainer.
- **`removeReviewer`** — drops the ref by profile id (no-op when absent),
  event + audit.
- **`startReviewerRun`** — the reviewer counterpart of `startSpecialistRun`:
  same analyze prompt + best-effort clone + simulated-fallback, but `kind:
  "reviewer"` on a `r<index>-<uid>` thread and stamped with the reviewer's
  `agentName`/`agentProfileId` so it groups under its own Agent-logs entry.

### Route (`app/routes/project.task.tsx`)

New CSRF-checked intents `assign-reviewer` · `run-reviewer` · `remove-reviewer`
with verbatim toast copy.

### UI (`execution-profile.tsx` + `task-detail-page.tsx` + `app.css`)

- The cell is relabeled **Reviewers**; each reviewer renders as a `.reviewer-chip`
  (glyph + role + backend) with a **Run** button (gated on `runActive`, same
  single-run model as the primary) and a **×** remove.
- A **`ReviewerControl`** menu ("Add reviewer") offers deployed specialists NOT
  already engaged; empty/all-engaged/none-deployed states handled.
- A dedicated `reviewerFetcher` wires the three callbacks; server re-checks RBAC.
- New `.reviewers` / `.reviewer-chip` / `.rc-run` / `.rc-x` styles on
  `--viberr` tokens (no Tailwind, no inline hex).

---

## Tests (+12)

| File | Added |
| --- | --- |
| `task-file.schema.test.ts` | +2 — legacy `consultants` read as `reviewers`; `reviewers` wins over stale `consultants` |
| `specialist-run.server.test.ts` | +6 — assignReviewer (write/event/audit, idempotent), removeReviewer (drop + no-op), RBAC, startReviewerRun (errors unassigned; kind='reviewer' on `r0-…` thread, streams, audit) |
| `task-detail-components.test.tsx` | +4 — Reviewers cell chip Run/remove fire; Add-reviewer menu excludes engaged + submits; Run disabled on runActive; RBAC read-only |
| existing `consultant` tests | migrated to `reviewer` (enum/tuple/field renames) |

---

## Browser verification (containerless / CTL-1)

Ran the built app against a **copy** of the container's `docker-data` on port
5174 (migration 0011 applied to the copy: `reviewers_json` present,
`consultants_json` gone, recorded in `schema_migrations`):

1. Execution-profile cell reads **Reviewers**; **Add reviewer** menu lists the
   project's deployed specialists.
2. Assigning `analyst` wrote `reviewers:\n  - profileId: analyst` to task.md (no
   `consultants:` key) + an "Engaged **analyst** … as a reviewer" event; a chip
   with Run + × appeared.
3. **Run** created a `kind='reviewer'` run (thread `r0-…`, `agent_name`/
   `agent_profile_id` = `analyst`); the Agent-logs picker labeled it
   **"analyst · reviewer"**.
4. **Remove** reset the cell to `reviewers: []` + a "Released reviewer
   **analyst**" event.

---

## Notes

- Reviewer runs are gated on `runActive` (one streaming run per task, matching
  the primary). Reviewers are also engageable by `@`-mention like any agent.
- The `agent_runs` kind-CHECK rebuild is the one heavy migration step; it was
  validated to preserve all runs + log lines and map `consultant`→`reviewer`
  before shipping. Applying it to the live container is a one-time rebuild of
  the two runtime tables.
