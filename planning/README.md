# Planning

This directory contains the current product planning canon:

- [`planning-artifacts/prd.md`](planning-artifacts/prd.md)
- [`planning-artifacts/architecture.md`](planning-artifacts/architecture.md)
- [`planning-artifacts/ux-design-specification.md`](planning-artifacts/ux-design-specification.md)

These are living documents. When the app and a document disagree and the app is right,
the document is corrected — with a note saying when and why — rather than the app being
"fixed" back. Read a requirement's amendment notes before treating it as an instruction.

`design/` holds the build inputs, not the canon: the HTML mock, the design system, and an
older working copy of the PRD. That copy carried the 2026-07-04 reviewer and commenting
amendments (FR4, FR14, FR37, FR38) for a while and the canon copy did not; the amendments
were folded back in on 2026-07-25, so the two agree again. On any future divergence,
`planning-artifacts/` wins.

Implementation behavior is verified by the source and test suite; completed discovery
passes and generated handoff ledgers are not retained here. Binding conventions and the
numbered orchestrator rulings that code comments cite live in
[`docs/architecture/decisions.md`](../docs/architecture/decisions.md).
