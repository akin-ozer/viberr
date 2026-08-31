# Design: Jira Clone (goal-1, scope 1/5)

Short design doc covering the data model, API surface, and tech stack for a Jira-like
project/issue tracker: users, projects, boards, tasks (issues), and stages (workflow
columns). This is scope 1 of 5 for goal-1; later links implement the pieces sketched here.

## 1. Data model

Five core entities. Relationships: an org has many users; a project belongs to an org and
has many boards; a board belongs to one project and has many stages (ordered columns); a
stage belongs to one board and holds many tasks; a task belongs to one stage, one project,
one assignee (nullable), and one reporter.

### User
| field | type | notes |
|---|---|---|
| id | uuid | pk |
| email | string | unique |
| name | string | display name |
| passwordHash | string | nullable — omitted for OAuth-only accounts |
| createdAt | timestamp | |

### Project
| field | type | notes |
|---|---|---|
| id | uuid | pk |
| key | string | short unique code, e.g. `ENG` — prefixes task keys (`ENG-42`) |
| name | string | |
| ownerId | uuid → User | |
| createdAt | timestamp | |

- A project has many **boards** (1:N). Most projects start with one default board, but the
  model allows several (e.g. a sprint board and a backlog/kanban board over the same tasks).

### Board
| field | type | notes |
|---|---|---|
| id | uuid | pk |
| projectId | uuid → Project | |
| name | string | |
| type | enum | `kanban` \| `scrum` |
| createdAt | timestamp | |

- A board has many **stages** (1:N, ordered).

### Stage
| field | type | notes |
|---|---|---|
| id | uuid | pk |
| boardId | uuid → Board | |
| name | string | e.g. `Todo`, `In Progress`, `Done` |
| order | integer | column position, unique within a board |
| isDone | boolean | marks the terminal column(s) for burndown/reporting |

- A stage holds many **tasks** (1:N). A task's `stageId` is what a drag-and-drop move
  mutates; moving a task to a stage with `isDone = true` is a stage transition, not a
  separate task field.

### Task
| field | type | notes |
|---|---|---|
| id | uuid | pk |
| projectId | uuid → Project | denormalized for key generation and scoped queries |
| stageId | uuid → Stage | current column |
| key | string | `<projectKey>-<sequence>`, unique, immutable |
| title | string | |
| description | text | markdown |
| type | enum | `story` \| `bug` \| `task` \| `epic` |
| priority | enum | `low` \| `medium` \| `high` \| `urgent` |
| assigneeId | uuid → User | nullable |
| reporterId | uuid → User | |
| createdAt | timestamp | |
| updatedAt | timestamp | |

Relationships in one line each: **Org → Users** (1:N), **Project → Boards** (1:N),
**Board → Stages** (1:N ordered), **Stage → Tasks** (1:N), **Task → User** assignee/reporter
(N:1 each, assignee nullable). Comments and attachments are out of scope for this doc
(deferred to a later scope link).

## 2. API surface

REST, JSON, one resource root per entity, nested under project/board where a task is not
globally addressable outside its project.

**Auth**
- `POST /api/auth/register` — create user
- `POST /api/auth/login` — session cookie
- `POST /api/auth/logout`
- `GET /api/auth/me` — current session's user

**Users**
- `GET /api/users` — list (org-scoped)
- `GET /api/users/:id`
- `PATCH /api/users/:id`

**Projects**
- `GET /api/projects`
- `POST /api/projects`
- `GET /api/projects/:id`
- `PATCH /api/projects/:id`
- `DELETE /api/projects/:id`

**Boards**
- `GET /api/projects/:projectId/boards`
- `POST /api/projects/:projectId/boards`
- `GET /api/boards/:id`
- `PATCH /api/boards/:id`
- `DELETE /api/boards/:id`

**Stages**
- `GET /api/boards/:boardId/stages`
- `POST /api/boards/:boardId/stages`
- `PATCH /api/stages/:id` — rename, reorder (`order`), toggle `isDone`
- `DELETE /api/stages/:id` — rejected (409) while it still holds tasks

**Tasks**
- `GET /api/projects/:projectId/tasks` — filterable by `stageId`, `assigneeId`, `type`
- `POST /api/projects/:projectId/tasks`
- `GET /api/tasks/:id`
- `PATCH /api/tasks/:id` — title/description/priority/assignee edits
- `DELETE /api/tasks/:id`
- `POST /api/tasks/:id/transition` — body `{ stageId }`; the one endpoint for board moves,
  kept separate from the general `PATCH` so stage-transition side effects (timeline entry,
  `isDone` completion timestamp) live in one place instead of being inferred from a diff

All endpoints require an authenticated session except `POST /api/auth/register` and
`POST /api/auth/login`. Every response outside auth is scoped to the caller's org.

## 3. Tech stack

This repository is an existing React Router (framework mode, SSR) + TypeScript app — see
[README.md](README.md). A Jira clone is the same shape of product (multi-user CRUD over a
small relational entity graph, with a live board view), so this design aligns with the
stack already in place rather than introducing a second one:

- **React Router** (SSR, framework mode) for routing, loaders, and actions — route modules
  under `app/routes/`, one per surface, matching the existing layout.
- **TypeScript**, strict, no `any` at module boundaries.
- **`node:sqlite`** for storage — no separate DB server to run/operate, WAL mode for
  concurrent readers. The five entities above map directly to five tables plus indexes on
  `tasks(project_id, stage_id)` and `tasks(assignee_id)` for the common board/"my tasks"
  queries.
- **Zod** for request/response validation at the API boundary, colocated with each route
  module the way `app/schemas/` does today.
- **SSE** (not websockets) for live board updates — a task transition broadcasts to
  everyone viewing that board, consistent with this repo's existing live-updates approach.
- **Node >= 26**, native TypeScript execution for scripts (seed/migrate), no separate build
  step for tooling.

Divergence considered and rejected: a GraphQL surface was considered for the board view
(fetching a board with all its stages and tasks in one round trip), but the REST surface
above already expresses that as `GET /api/boards/:id` plus `GET
/api/projects/:projectId/tasks?stageId=...`, and a second query language would be pure
overhead on a five-entity domain — REST stays consistent with the rest of this codebase.
