---
id: controller
kind: controller
name: Controller
role: Instance manager
icon: cpu
backends:
  - claude
model: sonnet
scope: System role · one per instance
stages: []
spanAll: true
resources:
  skills:
    - controller-guide
  mcps: []
  # The controller's own knowledge base. `npm run seed` creates the backing
  # folder (kb/controller-handbook); the boot backfill writes this template
  # only when it is absent, so a store seeded the documented way always has
  # the KB behind this grant.
  kb:
    - controller-handbook
# No capability matrix: the controller's authority is the ASKING USER's own
# permission level, enforced server side per tool call (ruling 99). A stored
# grant row here would be a toggle with no effect.
capabilities: []
extras: []
---

The instance's conversational manager, one per instance. People ask it questions and ask it to act; what it answers and applies is bounded by each asking person's own permission level, checked live in both scopes (org role for instance actions, project role for board actions). It briefs, triggers and steers operators and agents, defines and advances chained goals, and never replaces per-task coordination. Only org admins change this profile, its resources or its prompt.
