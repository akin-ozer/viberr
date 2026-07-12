# Stage transitions — test-plan marker

Source of truth: `GOVERNED_TEMPLATE` in `app/shared/workflow/templates.ts`
(boundary values defined in `app/schemas/project-file.schema.ts` as
`BOUNDARY_VALUES = ["auto", "approval", "human"]`).

## The 5 default stages ("Governed · 5 stages")

| # | Stage id | Stage name    |
|---|----------|----------------|
| 1 | `triage` | Triage         |
| 2 | `ready`  | Ready          |
| 3 | `impl`   | In Progress    |
| 4 | `review` | Review         |
| 5 | `done`   | Done           |

## Boundary types per transition

| From     | To       | Boundary   | Moved by                                                            | Locked |
|----------|----------|------------|----------------------------------------------------------------------|--------|
| `triage` | `ready`  | `auto`     | Operator, once the goal is scoped — flags underspecified tasks instead | no  |
| `ready`  | `impl`   | `auto`     | Operator, when a primary specialist is assigned                     | no     |
| `impl`   | `review` | `approval` | Operator transition request, with evidence attached                 | no     |
| `review` | `done`   | `human`    | Human acceptance of the completion report                           | yes    |

The `review → done` boundary is locked `human` in V1 — human acceptance is the
only path to Done (see `docs/architecture` ADR-002).
