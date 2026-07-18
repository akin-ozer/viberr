> Scope: T08 RBAC fixture note — assign-reviewer by maintainer

# T08: assign-reviewer by maintainer (allow)

Validates that a project **maintainer** is allowed to engage an agent as a
reviewer via `@mention` (`assignReviewer` in
`app/server/tasks/specialist-run.server.ts`), gated by the `run-agents`
authority tier (`admin|maintainer`) checked in
`hasRuntimeRole` (`app/server/tasks/task-actions.server.ts`).

Verdict: **PASS**. Maintainer is within the allowed tier for this action,
matching the doc comment on `assignReviewer` ("RBAC: admin|maintainer") and
the `rolesForAction("run-agents")` policy.

Coverage note: `specialist-run.server.test.ts` has an explicit positive
`"allows maintainer"` case for `assignSpecialist`, but the
`assignReviewer` describe block only exercises the admin actor (`arda`) for
the positive path and covers the negative path with a contributor + a
viewer. Adding a maintainer-actor positive case to the `assignReviewer`
block would close this asymmetry and give T08 direct unit coverage.

Last reviewed: 2026-07-18
