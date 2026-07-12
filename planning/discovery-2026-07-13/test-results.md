# Live test results

All campaigns used the Docker Compose production build at `http://127.0.0.1:5173`. The historical
sections preserve the first campaign's failures. The final section records corrected-build proof
without reclassifying old VDV model outcomes as successes.

## Final post-fix release evidence

### Automated and build gates: PASS

- TypeScript typecheck: clean.
- Full Vitest regression: 146 files and 1,318 tests passed.
- Terminal/reviewer focused regression: 152 tests passed; the broader routing/governance focused
  run passed 165 tests.
- Production build: passed.
- Playwright: 19/19 passed in 20.5 seconds. This includes contributor-owner repo-less completion,
  repository merge-pending behavior, Agents URL Back/Forward, org-admin archive/read-only/Restore,
  and final hydration coverage.
- Final browser console, after `2026-07-12T23:39:27Z`: zero warning/error entries.

### Docker, projection, and health: PASS

- The final Compose image started healthy; final application logs contained no warning/error.
- `BETTER_AUTH_URL` resolved to `http://127.0.0.1:5173` in the Compose runtime.
- Health returned `ok: true`, integrity `ok: true`, `recoveryRequired: false`, 5 projects, 38 tasks,
  and watcher active.
- Claude and Codex each reported `configured: true` and `status: unknown`, with no recent run signal.
  This is the intended distinction between configured credentials and verified runtime health; no
  provider execution success is inferred.
- A separate Compose container forced a complete rescan: 5 projects, 38 tasks, 43 changed records,
  zero errors in 172 ms. The running app remained integrity-healthy afterward.

### Browser and role matrix: PASS

- Final desktop captures cover Home, Board, Review, Agents/profile, Policy, GitHub, Activity,
  Settings, task details, Notifications, Profile, and organization Users/Resources/Connections.
- Final 390×844 captures cover Board, task detail, and the open project navigation drawer.
- Elif is an explicit VDV project Admin; Murat is a VDV Contributor and VDV-11 owner while remaining
  a Viberr Core Maintainer; Selin is a VDV Viewer; Arda is intentionally not a VDV member and enters
  with the visible, audited organization-admin override.
- The contributor-owner completion controls, reviewer fingerprint/cycle state, and org-admin
  emergency controls were visible according to the final policy. The UI no longer personalizes
  project-wide work as waiting on the current user.
- Viberr Live Six was archived in the live app: Board/Settings became readable but mutation controls
  were inert, active work was stopped by policy, and Restore returned the project to active state.

### MCP: PASS

- A real DeepWiki HTTP MCP connection was re-tested from the application: healthy, three tools,
  1,477 ms.
- The resource declares Claude and Codex support and is attached to API Specialist. This live
  initialize/tools-list result complements the focused tests for encrypted explicit secret
  references and HTTP/stdio injection.

### GitHub state matrix: PARTIAL BY INTENTIONAL CREDENTIAL NON-BINDING

- External authenticated truth was verified with GitHub CLI: PR #20 merged; PR #21 closed without
  merge; PR #22 opened for the open-state case, then deliberately closed and its branch deleted.
- Viberr had no bound GitHub credential. Its GitHub page therefore remained stale and correctly
  displayed an offline/no-credential state; no live in-app reconcile, authenticated clone, push,
  merge, or PR-state freshness is claimed.
- The logged-in host GitHub credential was intentionally not imported without explicit owner
  confirmation. Credential-dependent product paths are covered by unit/integration tests and the
  independent remote-state matrix, not represented as a live app success.
- The merged fixture `test-support/deep-validation/VDV-13.md` remains on `origin/main` at this
  checkpoint. Removing it is required before publishing the final product PR.

### VDV 24-case interpretation

The project contains 24 designed cases and remains part of the 5-project/38-task final data set.
Those task files preserve useful baseline scenarios for assignment, stages, reviewers, secondary
assignments, comments, RBAC, routing, MCP/resource behavior, provider parity, lifecycle, PR state,
interrupts, and integrity. They were not all replayed as successful real-model runs after the fix:
many remain intentionally blocked or show stale GitHub state because no application credential was
bound. Final correctness is established by the focused/full automated suites, controlled
Playwright flows, real Docker/API health and rescan, real MCP handshake, cross-role UI, and external
GitHub truth described above.

## Pre-fix baseline

This is the first campaign's evidence. It is intentionally retained, but none of these counts or
failures is the corrected build's final regression result.

- Compose build/start: PASS.
- Health/watcher/projection counts: PASS.
- Backend detection at that time: Claude and Codex reported `real` from credential presence;
  validity was not proven. Current health separates configured from recent verified/degraded signals.
- Typecheck: PASS.
- Unit tests: FAIL — 1182 passed, 3 file-watcher tests failed; background runtime/watcher leaks
  observed. See F07.
- Production browser hydration: FAIL on /notifications; React #418. See F08.

## Fresh project campaign

### Setup: PASS with product findings

- Created `Viberr Deep Validation` through the production UI: slug `viberr-deep-validation`, prefix
  `VDV`, repository `akin-ozer/viberr`, Standard five-stage workflow, Balanced policy.
- Added Arda/admin, Elif/maintainer, Murat/contributor, and Selin/viewer through the UI. The UI said
  `Invite sent` even for locally provisioned users, confirming F13.
- Deployed seven profiles: Operator, Developer, Reviewer, Docs Writer (Claude/impl/
  `conventional-commits`), Test Engineer (Codex/review/`reviewer-expertise`), API Specialist
  (Claude/impl/`api-design` + `api-contracts`), and Performance Engineer
  (Codex/impl/`developer-expertise`).
- Created all 24 independent VDV tasks. The board initially showed all 24 as human decisions and
  `Waiting on me 24`, further exercising F09.
- Fresh canonical project.md contained the stale advisory capabilities described in F34.

### Automatic live-run wave: FAIL

Task creation launched a real Claude operator for every task, including all tasks created in Triage
with `readiness=input_required` (F35). All 24 initial operator rows finished. They left the projection
in this state at the evidence checkpoint:

- Triage: 3 tasks (VDV-3, VDV-5, VDV-21), all input-required/human.
- Ready: 5 tasks (VDV-4, VDV-12, VDV-14, VDV-23, VDV-24), all blocked/human.
- In Progress: 16 tasks; 12 blocked/human and 4 ready/agent.
- Primary assignments: 16 Codex Developer, 2 Claude Docs Writer, and 3 Claude API Specialist; three
  Triage tasks received no primary.
- All 16 Codex primary rows failed at zero turns/tokens after the clone fallback/runtime start.
- Claude primaries: VDV-18 and VDV-19 finished; VDV-2 was interrupted after 33 turns; VDV-6 and
  VDV-17 were still running at the checkpoint. Follow-up operator rows for VDV-18 and VDV-19 were
  also running.
- Every real operator and primary row had empty phase/step, confirming F19.

These are setup/exploratory outcomes, not completed verdicts for the 24 case contracts. The
automatic wave was not accepted as final evidence; corrected behavior is proven by the controlled
focused/full/Playwright/Docker/browser matrix at the top of this file.

### VDV-2 focused probe: FAIL with one successful lifecycle control

- Operator observed `readiness=input_required`, described a recommendation, then directly advanced
  Triage → Ready → In Progress (F36).
- It chose API Specialist for a generic Claude lifecycle case and told the agent to invent a small
  repository change (F33/F37).
- The clone had no private-repository credential; the empty-workspace specialist spent 33 turns
  probing network, repository identity, and absent tools instead of receiving a fail-fast recovery
  packet (F38).
- The task called the operator active after its run was finished (F39).
- Interrupt ultimately persisted correctly as `interrupted` with actor and finish timestamp. The UI
  announced success before it stopped showing the run as active, so the state-convergence portion of
  VDV-22 remains failed/unverified (F40).

### Projection corruption incident and recovery: RECOVERED; PRE-FIX ATTRIBUTION INCONCLUSIVE

- VDV-6 began returning `SQLITE_CORRUPT` while concurrent agent logs were being ingested.
- The canonical task record remained intact; integrity checking confirmed damage across run-log,
  event, notification, and task-projection b-trees/indexes.
- The container was stopped before further writes and the database/WAL/SHM were preserved.
- SQLite recovery produced an integrity-clean database retaining users, auth/session state,
  memberships, audits, 78 run rows, and 2,220 run-log lines.
- Restarting Docker rebuilt all 5 projects and 38 task projections from canonical files; VDV-6
  loaded normally with its operator recommendation and surviving log tail.
- Derived notifications were rebuilt empty and some damaged historical projection/log rows survive
  only in the forensic copy. No claim is made that recovery was lossless.
- Because read-only host sqlite queries were made against the live Docker bind-mounted WAL database,
  the pre-fix incident could not be attributed solely to the product. The live protocol now forbids
  that access pattern. See F41.

Post-fix evidence: boot and health run a bounded SQLite quick-check and expose an explicit
recovery-required 503; an isolated 5,000-line single-process write stress remained integrity-clean.
The final production container reported integrity healthy, and a separate Compose container forced
a 5-project/38-task/43-change rescan with zero errors in 172 ms without disturbing that state.

### Live RBAC probes: EXPECTED GAPS CONFIRMED

- Arda temporarily took VDV-11 and handed it to Murat. The handoff menu also offered Selin, a
  Viewer, even though Viewer ownership is rejected by the server (F11).
- As contributor-owner, Murat could select and submit the ordinary `hold_runtime_debug` packet
  outcome. The packet intentionally remained visible in its held state. This confirms the existing
  task-owner exception for non-completion packet actions.
- Murat's Home simultaneously claimed 20 VDV decisions were “waiting on you,” despite only VDV-11
  being routed to him as owner. This is the live personalized-queue failure in F09.
- Elif was promoted to project Admin and removed Arda from the project. Arda remained able to see
  VDV on Home because he is an organization Admin, but direct VDV Settings access returned 403:
  “Only project members can view this project's settings.” This is the exact pre-fix emergency
  org-admin authority gap in F02.
- The fixture intentionally remains with Elif as explicit project Admin and Arda as nonmember org
  Admin so the post-fix override can be validated without manufacturing a second scenario.

### Real GitHub PR matrix: REMOTE FIXTURES CREATED

- VDV-13: PR #20 (`codex/VDV-13-merged-pr`) was squash-merged into `main`; it added only
  `test-support/deep-validation/VDV-13.md` as the merged-state fixture.
- VDV-14: PR #21 (`codex/VDV-14-closed-pr`) was closed without merge and its branch deleted, with
  an explicit rejection-fixture comment.
- VDV-15: PR #22 (`codex/VDV-15-open-pr`) was opened and left unmerged for the open-state test,
  then deliberately closed and its branch deleted after evidence capture.
- These remote states are proven through the authenticated host GitHub CLI. Viberr still has no
  project PAT, so app-owned clone/reconcile/merge remains unverified until the credential is bound.
- The final branch was rebased onto the merged fixture commit and removed
  `test-support/deep-validation/VDV-13.md`, so the published product tree retains no validation
  marker file.

### Baseline-to-final reconciliation

- Cross-role acceptance, owner authority, reviewer cycles, archive behavior, resource use, URL/SSE
  navigation, terminal validation, routing context, and integrity are now covered by the final
  automated/Docker/browser evidence at the top of this file.
- The operator lease race and exact reviewer verdict fingerprint are specifically covered in the
  focused regression; the contributor-owner terminal path is covered by UI and Playwright.
- App-owned authenticated GitHub actions remain deliberately unverified in the browser because no
  GitHub credential was bound. This is an evidence boundary, not a claim that the path failed.
- The 24 task records remain a discovery/baseline matrix; they are not relabelled as live post-fix
  successes where execution remained blocked or externally stale.
