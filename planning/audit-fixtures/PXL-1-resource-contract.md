> Scope: PXL-1 audit fixture on why exact resource scoping matters for agent work.

## Why exact resource scoping matters

Exact resource scoping keeps an agent's changes limited to the files a task explicitly names,
so unrelated code, tests, and configuration stay untouched while the goal is pursued. This
precision keeps the audit trail small and reviewable, letting reviewers confirm the agent's
actions matched its authorized scope without wading through unrelated diffs.

Last reviewed: 2026-07-19
