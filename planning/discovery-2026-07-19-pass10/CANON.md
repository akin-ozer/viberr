# Current product canon

This document records the best current interpretation of Viberr at revision `afb22fe2cbab`. It is an audit reference, not a replacement for unresolved owner decisions.

## Pass-10 remediation status (2026-07-19)

The pass-10 findings were validated and remediated in-app (see `DECISIONS.md`
for the signed rulings). Several invariants below were flagged as violated at
`afb22fe2cbab`; after remediation:

- **Invariant 6 (sticky failure until real rework)** — now implemented: review
  state is derived from per-engagement verdicts bound to an immutable commit
  SHA+tree work revision; a rejection clears only when a NEW revision is
  delivered, never on a comment or stage bounce.
- **Invariant 14 (capabilities actually constrain runtime/delivery)** — now
  honest: supporting agents are physically read-only, server-owned delivery
  honors the repo-write grant, Claude's env is secret-filtered, and the
  capability matrix states where enforcement actually happens. The remaining
  gap (a Codex specialist's in-run tool control is advisory) is disclosed, and
  the read-only sandbox + server-side delivery gate are the real constraints.
- **Invariant 15 (only declared resources injected; contained)** — skill/KB
  resolution is now traversal/symlink-contained beneath its store root.
- **Verdict authority is explicit-only**; the review model requires unanimous
  current-revision approval from the required (verdict-capable) reviewer set.

Security scope was ruled **in-app mitigations only** — no per-run OS container
isolation. Cross-project/OS-level isolation claims therefore remain
unverified/false at the process boundary; do not treat specialist processes as a
security sandbox.

## Source precedence

Resolve contradictions at the **decision level**, not by assigning one whole document permanent supremacy. For each behavior, use the newest applicable evidence in this order:

1. A later explicit owner ruling.
2. The July 19 generic-agent decisions and pass-9 owner answers.
3. Current implementation plus live evidence, clearly labeled as observed behavior rather than intent. An implementation does not become intended merely because it is newer.
4. Pass-9 runtime, delivery, RBAC/file-format, and UI maps.
5. July 17 product-canon material where it has not been superseded.
6. Original PRDs, architecture, briefs, and design summaries where later work did not change them.
7. Historical build specifications and mock implementation details only as provenance.

The root README, `planning/README.md`, `docs/architecture/file-formats.md`, `docs/build/**`, and the Better Auth migration note contain known stale claims. Do not treat their self-declared “canonical” or “source of truth” labels as authoritative without applying the order above.

Every implementation handoff should label a rule as one of:

- **Target** — supported by current owner intent and safe to implement.
- **Observed** — what revision `afb22fe2cbab` currently does; it may be accidental.
- **Violated target** — a target with directly conflicting code/live evidence.
- **Decision required** — plausible alternatives remain and implementation must wait.

## Product thesis

Viberr is a governed AI software-delivery workspace for small teams. Humans define policy and retain accountability; AI agents are first-class workers. Work is task-centered, inspectable, recoverable, and normally delivered through a real repository branch and pull request.

Canonical project, task, agent, skill, and knowledge-base files are durable operating contracts. SQLite is a rebuildable projection plus application/runtime state store; it is not the sole source of product truth.

Production must never fabricate a successful agent run. Claude and Codex are real backends or honestly unavailable. The simulated runtime is a test adapter only.

## Current vocabulary

| Term | Meaning |
|---|---|
| Operator | The only behaviorally special agent. It coordinates governed task actions; it is not a coding specialist. |
| Agent profile | Generic non-operator definition: description, persona, backend, effort, stage eligibility, resources, and capability grants. |
| Engagement | A task-to-profile relationship with backend, role text, and `delivers` ownership. |
| Delivering agent | The zero-or-one engagement that owns repository delivery for a task. |
| Supporting agent | Any non-delivering engagement. It may research, review, test, document, or advise according to its profile. |
| Reviewing agent | UI wording for a supporting engagement expected to validate work. Authority comes from verdict capability, not the label. |
| Human owner | A human accountable for task decisions and, while still contributor-or-higher, eligible for the owner acceptance exception. |
| Validation verdict | Agent-authored approval or request-changes result that can gate acceptance. |
| Decision packet | Structured question/escalation awaiting a governed human or operator resolution. |
| Recommendation | Proposed action that still requires the applicable authority unless a documented autonomy rule promotes it. |

Avoid using “reviewer” alone. It is overloaded across a removed project role, an agent profile name, a supporting engagement, an internal run kind, and historical human language.

## Core domain invariants

These are **targets**, not a claim that the current revision satisfies every item. Items 3, 6, 14, and 15 are materially violated or incomplete in current behavior.

1. At most one engagement on a task has `delivers: true`.
2. Non-operator profiles are generic data; the system must not hard-code behavior by profile name.
3. Agent selection should consider profile description, capabilities, declared resources, stage eligibility, backend availability, and availability. Workload, cost, and rationale remain unresolved/incomplete.
4. Workflow meaning derives from the configured graph, not literal stage names.
5. Readiness, waiting party, workflow stage, validation, acceptance, and GitHub state are separate axes.
6. A failing verdict remains sticky until actual revision-bearing rework; a later unrelated approval must not silently erase another agent's unresolved failure. Current code incorrectly treats any later stage transition, or a later delivering-agent comment, as sufficient rework evidence.
7. Bare transition to a terminal stage is prohibited. Completion must use the acceptance path.
8. A human task owner may accept only while still contributor-or-higher.
9. Archived projects are read-only for operational, credential, policy, and task mutations; accepted Done tasks remain commentable when not archived.
10. Real delivery is server-orchestrated for both backends: workspace, commit attribution, push, PR open/update, reconcile, and merge attempt. Specialists commit locally but must not push or open PRs. PXL-1 proved the structural specialist prompt follows this target while the operator's generated instructions can contradict it.
11. Out-of-band PR state never silently advances workflow. It creates visible divergence and notifications.
12. Accepted-but-merge-pending is a valid Done condition when the governed acceptance succeeds but GitHub merge cannot complete.
13. Provider/model differences must be visible; “parity” means equivalent governed outcomes, not identical tools or transports.
14. Capabilities shown as enforced must actually constrain runtime and delivery. Current code violates this invariant for several repository actions.
15. Declared skills, KBs, and MCPs must be the only profile resources injected. Missing resources must fail or degrade honestly, and unrelated host resources must not leak in. Codex receives declared portable MCP definitions, but credential headers/environment are intentionally stripped; that provider difference must be explicit in configuration and run evidence.

## Roles and authority

There are three independent layers:

- Organization role: admin or member, sourced from Better Auth organization membership.
- Project role: admin, maintainer, contributor, or viewer.
- Agent capability mode: direct, recommend, human, or off.

The latest owner intent describes the following human model, while pass-10 evidence shows inconsistent implementation and leaves transcript privacy unresolved:

- Any authenticated app user can view app-wide readable task/board surfaces and comment, even without project membership. Current navigation and SSE behavior do not apply this consistently.
- Viewer: read/comment only.
- Contributor: create tasks, comment, take/release permitted ownership, and do contributor-level work.
- Maintainer: approve transitions, edit goals, resolve ordinary packets, run/engage agents, accept eligible work, reorder, reconcile GitHub.
- Project admin: manage policy, members, profiles, credentials, workflow configuration, and exceptional release actions.
- Organization admin: audited emergency override, not silent membership in every project.

## Operator model

The operator is event-driven, not a continuous daemon. Important triggers include task creation, non-operator stage changes, goal edits, `@operator`, manual run, agent completion, schedules, and boot recovery.

Operator actions are governed through a shared action layer. Claude uses in-process tools; Codex emits a structured action plan that Viberr executes. Missing credentials must produce a visible failure/recovery packet, never a fake run. A health label of `real` currently means the real adapter is configured/detected; it does not prove provider authentication or successful execution.

The operator uses a process-local per-task/project lease with one coalesced pending trigger and bounded completion reactions. This is not safe for multi-process deployment and has race limitations documented in `FINDINGS.md`.

The operator may select and summon agents, but it does not own repository delivery. Its generated instructions must be assembled from the same server-owned delivery contract given to specialists. PXL-1 demonstrates why this must be a typed invariant rather than free-form model knowledge.

## Acceptance ambiguity awaiting owner confirmation

The original product thesis and current new-project copy say completion remains human-authorized for every autonomy preset. Later owner rulings and implementation add one narrow exception: a full-autonomy operator with explicit direct completion capability may accept and move work to Done. This pass has asked whether the exception remains desired. Until answered, do not “fix” either behavior or copy in isolation.

## Review ambiguities awaiting specification

- Is absent verdict capability a temporary migration shim or an implicit grant for every non-delivering engagement?
- Is multi-agent review strict AND, sticky-failure-until-rework, or another aggregation rule?
- What invalidates prior approvals: new commit, changed diff/tree hash, rework stage, deliverer rerun, profile disengagement, or another mutation? A stage transition or comment alone is not evidence of rework.
- May a supporting agent mutate repository files when its goal is review/testing? Current runtime permits it despite the conceptual read-only model.

These are decision prerequisites for capability migration and the review-state implementation plan.
