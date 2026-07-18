> Scope: permissions test-suite fixture — viewer role denial for update-goal

# T13 update-goal by viewer (deny)

This fixture documents the expected RBAC outcome for the viewer role
attempting the update-goal action.

- Role: viewer
- Action: update-goal
- Expected outcome: deny

Consistent with `ACTION_ROLES` (`app/shared/rbac.ts`) and the RBAC probe
matrix covered by `app/features/policy/policy-rbac.server.test.ts`, where
`update-goal` requires maintainer or higher and viewer is denied.

Last reviewed: 2026-07-18
