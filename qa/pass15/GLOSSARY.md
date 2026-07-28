# Viberr Glossary

- **Task** — the canonical, file-native record that carries a unit of work's state, execution context, timeline, decisions, and evidence as the durable contract between humans, agents, and GitHub.
- **Stage** — a task's current position in its project's configured workflow (e.g. analysis, implementation, review), shown on the board and advanced through rule-driven transitions.
- **Operator** — the dedicated agent assigned to a task that manages its flow: assigning and re-engaging specialists, recommending stage transitions, and raising decision packets for human review.
- **Specialist** — a persistent agent thread the operator engages to do the actual stage work (e.g. developer, reviewer), appending outcomes, blockers, and evidence to the task.
- **Decision packet** — a concise, structured record the operator raises when a task is blocked or needs a human call, stating what was observed, what changed, and the recommended options.
