> Scope: pass 11 Claude-to-Codex routing fixture

# Pass 11 Claude to Codex routing fixture

This fixture is an inert audit artifact for task RTL-1. It documents the
routing contract between the Claude-backed docs-author profile and a
read-only Codex style reviewer; it performs no runtime action.

## Declared resources

Delivery for this fixture is routed to the Claude-backed docs-author profile
with both of its declared resources attached:

- The `docs-style` skill, confirmed loaded via marker DOCS-STYLE-MARKER-P7.
- The `testing-conventions` knowledge base, confirmed loaded via marker
  KB-MARKER-P7.

## Review handoff

After the docs-author profile produces this fixture, a read-only Codex style
reviewer must inspect it and report a revision-bound verdict tied to the
exact commit SHA under review. The reviewer does not edit files and does not
push or open a pull request; Viberr owns push and PR delivery for this task.

Last reviewed: 2026-07-20
