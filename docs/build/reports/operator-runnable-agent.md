# Operator as a runnable, governed agent

## What changed

The operator used to be a data-model concept: a `operator` frontmatter marker, a
`RunKind`, and a cosmetic simulated run (`buildOperatorScript`) that *narrated*
coordination without doing it. It is now a real agent that drives a task
end-to-end under a capability policy, on the Claude Code (or Codex) backend, and
it can run under full autonomy.

## How it works

- **In-process governance tools.** The Claude adapter now passes `systemPrompt`,
  `mcpServers`, and `allowedTools` to the Agent SDK `query()`. Operator runs
  execute in the app process, so `operator-toolkit.server.ts` builds an
  in-process SDK MCP server (`viberr`) whose tools call Viberr's own server
  functions with the DB + task context closed over. The run is confined to those
  `mcp__viberr__*` tools — it can never write code.
- **Capability-gated actions.** `operator-actions.server.ts` performs each action
  as the operator (`{kind:"operator"}` actor, `operator` audit actor) gated by the
  operator deployment's capability policy: `direct` acts, `recommend` posts a
  recommendation (and, for completion, opens a decision packet), `human`/`off`
  refuse. The shared mutations (`assignSpecialist`, `transitionStage`, …) gained
  an `operatorAuthorized` context flag that skips the human RBAC (operator
  authority is enforced upstream) and attributes the action to the operator.
- **Autonomy.** `supervised` recommends at governed boundaries; `full` promotes
  recommend→direct **and** lets the operator accept completion to Done. That last
  step is the one deliberate, audited exception to the human-only-Done invariant
  (`task.operator.accepted_completion`); it fires only under full autonomy and
  only for the operator. Every other agent, and every supervised operator, still
  cannot reach Done.
- **Backend selection + fallback.** Claude with a live credential runs the
  tool-driven operator. Codex (no in-process tool channel) and offline both take a
  deterministic scripted drive that calls the same operator-actions, so the board
  still advances honestly. `operator-run.server.ts` resolves the deployment, picks
  the backend, and builds the system prompt.
- **Shipped assets.** The operator's own agent definition
  (`assets/operator.definition.md`) and a `viberr-app-expertise` skill
  (`assets/viberr-app-expertise.skill.md`) are bundled into the server build
  (`?raw`) and seeded into the store on boot (`seedDefaultOperatorAssets`), then
  loaded into the operator's system prompt.
- **RBAC modes.** Added an `off` capability mode ("don't recommend") so operator
  assignment RBAC is recommend / assign(direct) / don't-recommend(off).
- **Preinstall.** The operator template ships with `backends: [claude, codex]` and
  the expertise skill; app-created projects now deploy the default roster (operator
  + specialists) so the operator has agents to assign.

## Verified

- 912 unit tests pass (incl. `operator-actions.server.test.ts` — gating, the
  scripted drive, and accept-completion under full autonomy). Typecheck + build
  clean. Container healthy (`claude`+`codex` real; assets seeded into the volume).
- **Live E2E on the real Claude Code backend:** a fresh task under full autonomy —
  the operator called `get_task`, posted a plan, assigned `dev` as primary
  specialist, moved Triage → Ready → In Progress, ran the developer, moved to
  Review, engaged + ran a reviewer, posted progress comments, and accepted
  completion → **Done**. Confirmed on the board and timeline in the UI, with the
  operator backend + autonomy run control on the task's execution profile.
