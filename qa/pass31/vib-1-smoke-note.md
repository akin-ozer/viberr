PASS31-KB-LOADED

Pass-31 live QA started on 2026-08-31.

Fixture accounts used for this pass, by role name only:

- admin
- maintainer
- contributor

The pass exercises the standard 5-stage workflow end to end: a task begins
in Triage, where the operator scopes the goal and auto-advances it to Ready
(or flags it as underspecified); once a delivering agent is assigned it
auto-advances from Ready to In Progress; the operator then requests the
In Progress → Review transition with evidence attached, which requires
approval; and finally a human accepts the completion report to move the
task from Review to Done, the one locked, human-only boundary in the chain.

No other QA state is recorded in this note.
