# Test and evidence log

Status: active. This file records executed checks only; planned cases belong in `TEST-PLAN.md`.

## Environment

- Revision: `afb22fe2cbab79169778db01d48fa4d92f519188`
- Local URL: `http://127.0.0.1:5173`
- App date/time zone: 2026-07-19, Europe/Istanbul
- Existing user change `.claude/launch.json` preserved.

## B00 — health and backend-adapter availability

Result: pass with caveat.

Observed response:

```json
{
  "ok": true,
  "projections": { "projects": 3, "tasks": 40 },
  "watcher": true,
  "backends": { "claude": "real", "codex": "real" }
}
```

The README still documents simulated production states that this endpoint no longer returns. `real` means the real adapter is configured/detected; this check did not validate provider authentication or make a paid request.

## B01 — principal route traversal

Result: pass for reachability; findings recorded separately.

Visited and captured: Login, Home, New Project, Board, Review queue, Agents/operator/profile/edit/new/capability/live, Policy, GitHub, Activity, Project settings, Task summary/execution/timeline, Organization GitHub/users/resources, Profile, Notifications.

Evidence: `SCREENSHOT-INDEX.md`.

## B02 — board search and view modes

Result: pass.

- Searching `VIB-30` reduced the board to the single matching Review task.
- List mode preserved the filter and rendered the same task.
- The new-task modal exposes title, stage, and optional goal only; agent assignment is expected to be operator-driven or performed after creation.

## B03 — profile forms without mutation

Result: fail for semantic consistency; no save performed.

- Current Developer runtime grants contain legacy `recommend` values.
- Profile query/UI coerces specialist `recommend` to direct/allowed.
- Runtime treats legacy verdict `recommend` as off for delivering engagements and direct when verdict is absent on supporting engagements.
- Saving an unrelated Developer edit would persist the coerced direct verdict grant and materially expand authority.
- The form also shows absent headline repository execution as Off while the runtime leaves unspecified capabilities available and the save path repairs it to direct when scoped grants are active.

## B04 — type checking

Command: `npm run typecheck`  
Result: pass.

## B05 — production build

Command: `npm run build`  
Result: pass. One bundler warning notes `operator-run.server.ts` is both statically and dynamically imported, so the dynamic import does not create a separate chunk.

## B06 — full unit/integration suite

Command: `npm test`  
Result: partial failure.

- Test files: 137 pass, 1 fail, 138 total.
- Tests: 1,399 pass, 4 fail, 1,403 total.
- All failures are in `app/server/files/file-watch.service.server.test.ts`.
- Repeated runtime error: `EMFILE: too many open files, watch`.
- Failed expectations: task-directory deletion pruning, project-directory deletion pruning, task file reprojection after edit, watcher liveness.

The log also contains noisy detached simulated-run callbacks against already-closed test databases. Those messages did not fail the suite but indicate incomplete async cleanup in tests.

## B07 — isolated watcher test rerun

Command: `npx vitest run app/server/files/file-watch.service.server.test.ts --maxWorkers=1`  
Result: same four failures, 3 passes, 7 total.

The host launchd soft `maxfiles` limit reports 256 even though the shell reports a much higher `ulimit -n`. The dev server also encountered `EMFILE` when started inside the sandbox. This makes the immediate trigger environment-sensitive, but Viberr's continuous two-second re-arm loop, log flood, unhealthy watcher state, and failed projection behavior under descriptor exhaustion remain real resilience findings.

## B08 — credential-scrubbed governance regression set

Result: pass.

The environment explicitly removed Claude, Codex, OpenAI, CLI-auth, and `CODEX_HOME` credentials before running 18 governance-heavy Vitest files covering capabilities, task/operator actions, specialist runtime/tool/MCP behavior, schedules, comments, review queue, human RBAC, GitHub reconcile/open/push/workspace delivery, resources, and runtime detection.

- Test files: 18 pass.
- Tests: 275 pass.
- Duration: 30.73 s.
- No real-provider authorization was available to the process.

The passing run still emitted noisy scripted operator and detached-cleanup logs. They came from test doubles/fixtures, did not fail the run, and should be cleaned up to make a real unexpected call obvious.

## B09 — credential-scrubbed safe suite excluding watcher service

Result: pass.

The broader safe Vitest run removed ambient provider authorization and excluded the already-isolated watcher service failure: 1,396 tests passed. Together with B06/B07 this localizes the current automated failure to watcher exhaustion/retry behavior, while B08 gives a focused authority/delivery signal.

## B10 — development-server stability during live task work

Result: fail.

While PXL-1 and PXL-2 workspaces were cloned/updated beneath the default `./data` root, the running Vite server treated files throughout each nested Viberr checkout as application changes. It logged repeated page reloads for design/planning files, detected each workspace's nested `tsconfig.json`, cleared the TypeScript cache, and forced full reloads. `vite.config.ts` has no data/workspace watch exclusion, even though Viberr's own projection watcher deliberately prunes those subtrees.

During an active PXL-1 run, React also logged a hydration mismatch: server `Elapsed` text was `00:55` and client text was `00:56`. `useElapsed()` initializes from `Date.now()` during SSR and again during client hydration, so a second-boundary crossing is nondeterministic.

No source change was made. These observations are recorded as F10-36 and F10-37 and should be reproduced with an isolated development-server harness.

## Live project and GitHub cases

### L00 — create separate Viberr-only project

Result: pass.

- Name: `Viberr Pass 10 Lab`
- Slug: `viberr-pass-10-lab`
- Task key: `PXL`
- Repository: `akin-ozer/viberr`
- Workflow: Standard, five stages
- Agent policy: Balanced
- Initial tasks: zero
- Initial member: Arda Kaya

The key field rejects digits while its placeholder/example does not explain the letters-only rule; the attempted `P10` normalized to `P`, so the valid key `PXL` was used.

This project isolates canonical project/task data and UI membership only. It does **not** isolate specialist processes, the operating-system user, provider homes, credentials, or task checkouts from the live Viberr data root. Destructive/security scenarios were therefore deferred.

Evidence: current project file, [final lab home](screenshots/47-home-lab-complete.png), and the evidence manifest. The initially referenced 22/23 captures were never persisted and are marked dead references rather than silently replaced.

### L01 — create purpose-specific agent roster

Result: pass for persistence/UI; selected profiles were later exercised in L04/L05.

Six new profiles were created in the separate lab project:

| Profile | Backend | Eligible stages | Repository | Verdict | Exact resources |
|---|---|---|---|---|---|
| P10 Docs Writer | Claude | Ready, In Progress | direct | off | `docs-style`, `testing-conventions` |
| P10 Code Analyst | Codex | Ready, In Progress | direct | off | `developer-expertise` |
| P10 Security Reviewer | Claude | Review | off | direct | `reviewer-expertise` |
| P10 Style Reviewer | Codex | Review | off | direct | `docs-style` |
| P10 Test Designer | Codex | Ready, In Progress | direct | off | `reviewer-expertise`, `testing-conventions` |
| P10 MCP Researcher | Claude | Ready, In Progress | off | off | `notes-fixture` MCP |

The descriptions deliberately make operator selection semantic and mutually distinguish documentation, code analysis, test design, security review, style review, and MCP lookup. The MCP profile targets a registry entry that was labeled stale before retest.

Evidence: [agent roster](screenshots/30-pass10-agent-roster.png), canonical lab project file, and L04/L05 task timelines. The initially referenced 24–29 form captures were not persisted.

### L02 — retest the registered notes MCP

Result: pass with portability caveat.

- Transport: stdio.
- Probe result: healthy.
- Tool count: one.
- Probe latency: 35 ms.
- Tool: `get_note`.
- Deterministic call oracle: `NOTE[<key>]=PASS8-MCP-MARKER`.

The server lives under a Claude scratch directory in `/private/tmp`; it is working now but is not a durable organization resource path. A machine restart or temporary-file cleanup can invalidate profiles that depend on it.

Evidence: `screenshots/31-mcp-healthy.png` and the read-only server fixture inspection.

### L03 — verify isolated-project GitHub readiness

Result: pass inside Viberr; external tooling caveat.

- Repository: `akin-ozer/viberr`.
- Viberr connection: connected.
- Required scopes UI: all granted (`repo`, `workflow`, `read:org`, `pull_request:write`).
- Initial linked PRs/branches: zero.
- Credential remains masked in the UI.

The connected GitHub app available to this Codex session cannot see the repository (404), and `/opt/homebrew/bin/gh auth status` reports the cached `akin-ozer` token invalid. Viberr's own encrypted PAT is separate and appears healthy, so branch/PR/open/merge tests can proceed through Viberr. Request-changes, manual close, and other out-of-band divergence tests need either reauthenticated `gh` or an existing logged-in browser session.

Evidence: initial zero-count state recorded during navigation, current canonical task files, and [final GitHub state](screenshots/48-pass10-github-final.png). The initially referenced 32 capture was not persisted.

### L04 — Claude delivery, exact resources, Codex review, and human acceptance

Task: PXL-1, `[P10-01] Docs resource and operator routing`  
Result: lifecycle pass with a high-priority operator-contract failure.

1. The operator correctly routed a Markdown-only goal to `P10 Docs Writer` (Claude), not the code analyst, test designer, MCP researcher, or generic developer; it advanced Triage → Ready → In Progress.
2. The specialist created only `planning/audit-fixtures/PXL-1-resource-contract.md`, committed as `46582143dbed29c366b69eefe838ed3870ba21cf`, and left a clean tree. Its report demonstrated the declared `docs-style` skill marker and treated the declared testing KB as not applicable; it did not claim unrelated resources.
3. The operator twice contradicted the structural server-owned delivery contract by ordering the specialist to push/open a PR. The specialist refused, classified the conflict as possible prompt injection, and opened `ask_human`. The human chose “Keep original contract,” after which the operator correctly told the agent not to push.
4. Human Review transition made Viberr push and open [PR #76](https://github.com/akin-ozer/viberr/pull/76).
5. The operator correctly selected `P10 Style Reviewer` (Codex). It stayed read-only, evaluated the declared style contract, and approved the exact commit.
6. Human acceptance merged PR #76 and moved the task to Done.

Pass oracles: exact profile/resource selection, one-file commit, clean tree, server-owned delivery, explicit verdict, human Review/Done gates, real PR/merge. Failed oracle: every operator instruction must agree with the typed delivery authority.

Evidence: PXL-1 canonical timeline and screenshots [34](screenshots/34-delivery-contract-conflict.png), [35](screenshots/35-review-recommendation.png), [36](screenshots/36-style-reviewer-selected.png), [37](screenshots/37-healthy-review-completion-recommendation.png), and [38](screenshots/38-pr76-merged-done.png).

### L05 — Codex cleanup delivery and Claude review

Task: PXL-2, `[P10-CLEANUP] Remove merged audit fixture`  
Result: pass with a routing-observability question.

- The operator chose generic Developer/Codex for the exact deletion rather than P10 Docs Writer. This is defensible—deleting an existing fixture is implementation, not prose authoring—but the selection trace does not expose candidates or tie-breaking.
- Codex deleted only the fixture, committed `78e6369e8ede69fe598e8d282af2170c40eb7b8f`, did not push/open a PR, and reported a clean tree.
- Human Review entry opened [PR #77](https://github.com/akin-ozer/viberr/pull/77).
- The operator chose generic Reviewer/Claude; it verified exactly one deletion and approved without modifying the checkout.
- Human acceptance merged PR #77 and moved PXL-2 to Done. The paired task records describe the exact inverse change and the audited checkout no longer contains/tracks the fixture; unavailable remote commit objects prevent an independent local reconstruction of both PR diffs.

Evidence: PXL-2 canonical timeline and screenshots [39](screenshots/39-cleanup-task-form.png), [41](screenshots/41-cleanup-completion-recommendation.png), and [42](screenshots/42-pr77-merged-tree-restored.png). Capture 40 is excluded from the evidence index because it is severely clipped.

### L06 — viewer and non-member RBAC probes

Result: mixed; server mutations were not attempted.

- As a viewer of the original Viberr project, Selin could not create tasks or run/reassign agents. Review queue copy correctly separated zero items waiting on her acceptance from four items still in review.
- Ordinary Settings fields were disabled, but Archive and Delete project buttons appeared enabled. Neither destructive control was clicked.
- As a non-member of the lab, Selin could not discover it from Home and direct lab Settings returned 403.
- A direct PXL-1 URL nevertheless loaded the full completed task, operator/agent history, session control/export affordance, and raw-run path.
- The non-member successfully posted one inert plain comment: `[P10 RBAC] Non-member viewer comment probe; no agent mention and no action requested.` No agent/operator route was triggered; the UI labeled the author “app user · not in project.” This matches the broad comment rule but exposes the unresolved privacy split.

Evidence: direct viewer-session browser inspection, screenshots [43](screenshots/43-viewer-settings-danger-buttons.png), [44](screenshots/44-viewer-task-session-export.png), and [45](screenshots/45-nonmember-task-session-access.png), plus the PXL-1 timeline. Capture 43 shows viewer access to Settings but not the lower danger area; that button observation is recorded from navigation, not claimed from the crop.

### L07 — GitHub cleanup and external-control boundary

Result: repository tree clean; branch cleanup and out-of-band scenarios blocked.

- PR #76 added one inert file; PR #77 deleted exactly that file. Both are merged.
- Remote task branches `pxl-1` and `pxl-2` remain. Viberr exposes no post-merge branch deletion control.
- External `gh` authentication for `akin-ozer` is invalid in this audit environment, and the connected GitHub connector returns 404 for the private repository. Therefore request-changes, close/reopen, out-of-band merge, branch deletion, and GitHub-side review-state cases were not simulated.
- Viberr's encrypted PAT was not extracted or repurposed to bypass this boundary.

Evidence: [final GitHub page](screenshots/48-pass10-github-final.png), canonical PXL-1/PXL-2 metadata, and PRs [#76](https://github.com/akin-ozer/viberr/pull/76) / [#77](https://github.com/akin-ozer/viberr/pull/77).

### L08 — live safety stop

Result: pass.

After proving the lab project shares the live OS/data/runtime boundary, the audit stopped live agent execution. No test asked an agent to read secrets, traverse resource paths, access another task workspace, bypass repository grants, race another run, mutate product code, close/reject arbitrary PRs, or invoke undeclared host resources. These scenarios are specified in `TEST-PLAN.md` as disposable-environment-only cases.
