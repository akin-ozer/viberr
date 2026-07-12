# Pass 4 — implementation ledger (2026-07-12)

Branch `full-pass-2026-07-12` → merged to `main` (`b938f05`). Verified at merge:
**typecheck clean · 1185 unit tests · 13/13 e2e**. A parallel **Codex session** was
refactoring the runtime/adapter/MCP layer concurrently; its work (Codex SDK 0.144.1,
CODEX_ACCESS_TOKEN auth, GPT-5.6 model catalog, git-clone-auth, wire-format ErrorItem
handling) is also in this merge and is owned by that session for the combined re-check.

## Shipped (finding → fix → validation)

### Critical / High
- **F-MIG1 (CRITICAL)** — `db/schema-reconcile.server.ts`: boot-time reconciler parses the
  migration files and ADDs any column missing from an existing table, healing the
  `projects.archived` drift (and any future added-column drift). *Test:*
  `schema-reconcile.test.ts` reproduces the broken DB. *Live:* the real Docker container
  (which had the drift) recovered once the reconciler shipped.
- **WI-1 (HIGH)** — `review-queue.server.ts` filters `resolveStageRoles().reviewId`, not the
  literal `"review"`. *Test:* lightweight-board regression in `review-queue.server.test.ts`.
- **XS-1 (HIGH)** — `resumeRun` now threads disallowedTools/env(git-ceiling)/mcpServers/
  systemPrompt; `commentToAgent` recomputes them via `resolveResumeConfinement`. *Test:*
  `run-service.server.test.ts` asserts the resumed RunSpec carries the confinement.
- **XS-4 (HIGH)** — deny covers `git checkout -B` / `git switch -C`; the delivery-contract
  prompt only instructs steps the capabilities permit (`resolveDeliveryPermissions`). *Test:*
  `specialist-tool-policy.test.ts`.
- **XS-13** — `execute-code-or-write-repo` deny includes MultiEdit.
- **F-OP1 (HIGH, NEW)** — a failed real Claude operator run now escalates a blocked recovery
  packet (parity with the Codex no-plan path); *found live in the Docker container* where the
  Codex operator quota-failed and the Claude path was silent.
- **XS-9/XS-10** — reconcile-github / grant-github-scope / interruptRun / run-operator consult
  `roleCan(...)`; setMemberRole enforces `manage-members`. Single ACTION_ROLES source, no
  hardcoded tiers.
- **Ruling 5 + WI-2/WI-3** — better-auth membership is the authoritative org role
  (`resolveOrgRole` in `authenticate`); admin email edit syncs the better-auth user
  (`syncIdentityEmail`); delete removes the identity + sessions. *Tests:* identity + org-users.
- **Ruling 7 + XS-8** — toggleable capability catalog reduced to runtime-consulted ids only
  (11 fake advisory toggles removed); `execute-code-or-write-repo` made expressible. *Tests:*
  capability-catalog + agents-route updated.
- **Ruling 6 + XS-2/XS-14** — Policy copy discloses the Q1 full-autonomy acceptance exception
  and that a direct operator crosses approval/human boundaries; ownership footnote corrected to
  contributor+ (Q5).

### Medium / Low
- **XS-12** — execution-profile owner controls gate on `roleCan(own-task)` (viewers no longer
  see 403-only buttons).
- **MU-1** — profile Connect GitHub uses the real `/api/auth/sign-in/social` flow.
- **MU-3/MU-4** — board + home Re-scan gated by role; board surfaces `{ok:false}` errors.
- **MU-6** — `accept_completion` operator tool description no longer claims a merge it doesn't do.
- **WI-4** — Codex `resumeThread` applies the model/effort override.
- **WI-8/9/10** — loader perf: shared actor resolver; home GROUP BY aggregation; github n+1
  provenance prepared once + 30s repo-access cache.
- **DC-1..11 / ED-1..6** — dead code deleted (line-buffer, Identity, invited-status remnants,
  duplicated AgentDeploymentDefinition, unused exports/imports/props, stale selftest markers);
  env + docstring drift fixed.
- **e2e determinism** — `VIBERR_FORCE_SIMULATED_RUNTIME` + operator-ordering-robust assertions.

## Deferred to the combined Codex re-check (runtime/MCP layer overlap)
The Codex session was mid-refactor on the adapter/runtime/MCP files, so these were left to avoid
merge conflicts and are best done against its final shape:
- **Ruling 8 (MCP secret:// injection)** — the secret store resolve-and-inject; Codex is already
  reworking `specialist-mcp` + Codex MCP translation.
- **MU-2 (onPhase)** — adapters emit real phase/step (adapter-layer, Codex's area).
- **XS-7** — Codex operator run isolated workdir.
- **F-ISO1 (NEW)** — account-managed skills/subagents leak into real runs even in a clean
  container (verified live); needs an SDK-option investigation or honest S3-style labeling.
- **WI-5/6/7/15/16** — run-log tail dedupe, operator-lease release token, interruptRun view,
  claude interrupt pre-query, simulated raw-jsonl dir (all in run-service/run-sink/claude-runtime
  which Codex touched).

## Remaining pass-4 polish (non-conflicting; not yet done)
MU-5 (login flash), WI-11 (goal-editor error), WI-12 (org.settings double auth), WI-13 (guard
order), WI-14 (profile error mapping), WI-17 (GHE host in github-view), XS-11 (advisory row
labeling in the matrix), TD-1/TD-2 (operator-glyph dark-mode + star token in app.css), N5
(/projects redirect), N11 (agents tab URL state).
