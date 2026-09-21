# Planning

This directory contains the current product planning canon:

- [`planning-artifacts/prd.md`](planning-artifacts/prd.md)
- [`planning-artifacts/architecture.md`](planning-artifacts/architecture.md)
- [`planning-artifacts/ux-design-specification.md`](planning-artifacts/ux-design-specification.md)

These are living documents. When the app and a document disagree and the app is right,
the document is corrected — with a note saying when and why — rather than the app being
"fixed" back. Read a requirement's amendment notes before treating it as an instruction.

`design/` holds the build inputs, not the canon: the HTML mock, the design system, and a
working copy of the PRD. The two copies have drifted in both directions — the design copy
carried the 2026-07-04 reviewer and commenting amendments (FR4, FR14, FR37, FR38) before
the canon did, and the canon then carried the 2026-07-25 live-use amendments the design
copy lacked. On 2026-07-28 the design copy absorbed the full 2026-07-25 set plus the
pass-15 rulings (FR4, FR27, FR31), so the two agree again. On any future divergence,
`planning-artifacts/` wins.

Implementation behavior is verified by the source and test suite. The code-verified
description of the system as built lives in [`docs/`](../docs/README.md) (2026-09-01);
`planning-artifacts/architecture.md` and `ux-design-specification.md` remain the design
intent and history, and where they disagree with the code the code wins — the known
disagreements are listed in
[`docs/validation/2026-09-01-doc-validation.md`](../docs/validation/2026-09-01-doc-validation.md).
Requirement-by-requirement status against the PRD is in
[`docs/product/requirements-status.md`](../docs/product/requirements-status.md). Completed
discovery passes and generated handoff ledgers under `discovery-*/` are retained as history
only. Binding conventions and the
numbered orchestrator rulings that code comments cite live in
[`docs/architecture/decisions.md`](../docs/architecture/decisions.md).

The 2026-08-03 dependency/subsystem modernization (chokidar, dnd-kit, Lexical, full
dependency currency, production-image e2e) is recorded in
[`modernization-2026-08-03/PLAN.md`](modernization-2026-08-03/PLAN.md) and
[`modernization-2026-08-03/IMPLEMENTATION.md`](modernization-2026-08-03/IMPLEMENTATION.md).

The 2026-09-21 prompt-cache pass (why operator runs are warm, why specialist starts are
cold, why two controller resumes wrote 900k tokens, and what to change on both backends)
is recorded in [`prompt-cache-2026-09-21/RESEARCH.md`](prompt-cache-2026-09-21/RESEARCH.md),
its implementation plan in [`prompt-cache-2026-09-21/PLAN.md`](prompt-cache-2026-09-21/PLAN.md)
and the goal that drives the implementation in
[`prompt-cache-2026-09-21/GOAL.md`](prompt-cache-2026-09-21/GOAL.md).
