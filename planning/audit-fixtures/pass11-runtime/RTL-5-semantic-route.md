> Scope: Audit semantic delivery routing for RTL-5 without relying on a named profile.

# Semantic routing audit

## Routing decision

The operator selected an eligible delivery profile by matching its declared resources to the
task. The selected profile declares the docs-style skill and testing-conventions knowledge base,
which are the exact resources needed to author and validate this inert Markdown fixture. No
profile name or specialist identity is assumed by this decision.

After delivery, the operator should select an eligible read-only reviewer on the Claude backend.
That reviewer is opposite to the Codex delivery backend and must not edit the fixture or any
other repository file.

## Loaded completion markers

- The docs-style skill was loaded with marker `DOCS-STYLE-MARKER-P7`.
- The testing-conventions knowledge base was loaded with marker `KB-MARKER-P7`.

## Repository findings

Viberr is a TypeScript application built with React Router 8 and React 19. Canonical Markdown
records flow through parsers and guarded writers into SQLite projections, while route loaders and
actions serve the interface. Server-sent events prompt revalidation and run-log updates.

Runtime dependencies include the Claude Agent SDK, Codex SDK, Better Auth, Better SQLite3, Zod,
and YAML tooling. Development and validation use Vite, TypeScript, Vitest, Testing Library, and
Playwright.

The runtime stores project and task records in Markdown, global agent profiles and declared
resources in dedicated directories, and projected state and audit data in SQLite. Delivering and
supporting runs reuse the same task workspace.

Notable risks and gaps are shared-workspace races, whole-tree staging during Review delivery,
uneven backend capability enforcement, and process-level rather than security-grade workspace
isolation. Semantic routing must therefore match declared resources and stage eligibility instead
of depending on profile names.

## Testing conventions

Unit tests belong beside their sources as `*.test.ts` files and run with `npm test`. The test
environment uses a temporary data root rather than developer data, and every tested form POST
includes a `_csrf` field. Playwright end-to-end tests run through `npm run e2e` with an isolated
data root and deterministic runtime, so they do not spend real tokens. Tests should prefer real
server actions over mocked internals.

This document is an inert audit fixture. It defines no executable behavior and requires no test
suite execution.

Last reviewed: 2026-07-20
