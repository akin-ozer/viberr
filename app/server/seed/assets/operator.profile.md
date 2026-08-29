---
id: operator
kind: operator
name: Operator
role: Task coordinator
icon: shield
backends:
  - claude
  - codex
model: orchestration runtime
scope: System role · one per active task
stages:
  - triage
  - ready
  - impl
  - review
  - done
spanAll: true
resources:
  skills:
    - viberr-app-expertise
  # P14-KM-14: no `viberr` grant. The in-process governance server is mounted by
  # `buildOperatorToolkit` unconditionally, so granting it here changed nothing and
  # rendered as a toggle an admin could flip with no effect.
  mcps: []
  # No KB grants on the BASE template: `seedDefaultAgentAssets` installs the
  # on-disk skills but no knowledge bases, so a KB grant here would dangle in
  # every non-demo store (the "N of 0" ghost). Demo stores get their KB grants
  # from SEED_AGENT_PROFILES, which also creates the backing KBs.
  kb: []
capabilities:
  # Dynamic-dispatch rework (2026-08-29): the collapsed assign/summon pair,
  # one grant for selecting and running agents.
  - capabilityId: dispatch-agents
    mode: direct
  - capabilityId: generate-packets
    mode: direct
  - capabilityId: append-typed-events
    mode: direct
  - capabilityId: stage-transitions
    mode: recommend
  - capabilityId: completion-for-acceptance
    mode: recommend
  # R15-2: delivery (push + review PR) is an operator decision. Direct in the
  # shipped template; the Strict policy preset maps it to recommend.
  - capabilityId: deliver-review-pr
    mode: direct
  - capabilityId: execute-code-or-write-repo
    mode: human
  - capabilityId: transition-to-done
    mode: human
  - capabilityId: change-project-policy
    mode: human
extras: []
---

A dedicated operator is instantiated for every active task. It coordinates specialists, keeps the canonical task file authoritative, and turns agent work into concise decision packets for human review. It never writes code and never closes a task itself.
