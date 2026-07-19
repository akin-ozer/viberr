# Viberr discovery pass 10

Status: discovery and bounded live validation complete; implementation not started  
Audit date: 2026-07-19  
Audited revision: `afb22fe2cbab79169778db01d48fa4d92f519188`  
Scope: planning and evidence only; no product-code changes

This directory is the current audit dossier for Viberr. It reconciles the latest owner rulings, the July 19 generic-agent redesign, the running application, current source code, automated checks, and controlled live tests.

## How to use this dossier

Read these in order before assigning implementation work:

1. [CANON.md](CANON.md) — current product model, source precedence, vocabulary, and invariants.
2. [APP-MAP.md](APP-MAP.md) — routes, persistence, authority, runtime, operator, and delivery flows.
3. [FINDINGS.md](FINDINGS.md) — confirmed defects, contradictions, UX gaps, and open product questions.
4. [TEST-PLAN.md](TEST-PLAN.md) — the safety-gated test matrix and execution boundaries.
5. [TEST-LOG.md](TEST-LOG.md) — executed checks and evidence, including GitHub artifacts.
6. [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md) — prioritized remediation plan; planning only.
7. [DECISIONS.md](DECISIONS.md) — owner questions and rulings from this pass.
8. [SCREENSHOT-INDEX.md](SCREENSHOT-INDEX.md) — route-by-route browser evidence.
9. [EVIDENCE-MANIFEST.md](EVIDENCE-MANIFEST.md) — capture integrity, dimensions, hashes, and dead references.

All listed files are present. Earlier discovery passes remain valuable evidence, but this dossier supersedes their status summaries where they conflict with current code or later owner rulings.

## Audit method

- Read original PRDs, design summaries, architecture, mock source, owner rulings, and all July 19 current-state documents.
- Inspect implementation paths for persistence, RBAC, task actions, agent runtimes, operator behavior, capabilities, resources, schedules, SSE, and GitHub delivery.
- Traverse the running application in the in-app browser and capture each principal surface.
- Run type checking, production build, unit/integration tests, and selected browser/API probes.
- Create one separate project targeting only `https://github.com/akin-ozer/viberr` for controlled live agent and GitHub scenarios.
- Keep product source unchanged. Any accepted GitHub test artifact must be small, inert, easy to remove, and outside production code.

The separate project was a data/UX boundary, **not a runtime isolation boundary**. Once that was established, live agent work was limited to one inert file-add lifecycle and its exact cleanup; no hostile, secret-reading, traversal, concurrency, or capability-bypass prompt was executed.

## Safety boundary discovered during audit

Current specialist runtimes are not sufficiently isolated from the Viberr server process or data store. Claude receives the full server environment; Codex specialists run with full filesystem access; and repository-write capability restrictions are not reliable confinement. Therefore secret-reading, cross-project access, capability-bypass, destructive concurrency, and hostile path tests must **not** be run against this live data root. Those cases remain designed but deferred until an isolated disposable deployment exists.

## Baseline at start of pass

- App health: projections healthy, watcher reported alive, Claude and Codex configured for their real adapters. This does not validate provider credentials or a paid provider request.
- Production build: pass.
- Type checking: pass.
- Unit/integration: 1,399 pass, 4 file-watcher tests fail under repeated `EMFILE` (`too many open files`); the same four fail in an isolated rerun.
- Existing repository state: user-owned `.claude/launch.json` modification preserved and untouched.

## Bounded live outcome

- `Viberr Pass 10 Lab` was created with six purpose-specific profiles and exact skill, knowledge-base, MCP, backend, stage, and capability declarations.
- PXL-1 selected the Claude documentation profile, honored its declared resources, created one inert Markdown fixture, then used a Codex style reviewer. Human Review entry opened PR [#76](https://github.com/akin-ozer/viberr/pull/76); human acceptance merged it.
- PXL-2 recorded the exact fixture deletion through Codex implementation and Claude review. Human Review entry opened PR [#77](https://github.com/akin-ozer/viberr/pull/77); human acceptance merged it. The paired task records and audited checkout show the fixture absent; unavailable remote commit objects prevent an independent local reconstruction of both PR diffs.
- Two remote task branches remain because the external `gh` credential available to this audit is invalid and Viberr has no branch-cleanup action. No further credential workarounds were attempted.
- The run exposed a serious contract conflict: the operator twice instructed the delivering specialist to push/open a PR even though Viberr's structural specialist prompt says the server owns delivery on Review entry. The specialist correctly refused and escalated.
- The handoff contains 37 prioritized findings, 75 dispatch-ready test/use cases split by safety class, and an eight-wave implementation plan. No product code was changed.
