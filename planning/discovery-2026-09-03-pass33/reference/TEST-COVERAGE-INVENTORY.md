# Test coverage inventory — pass 33

Generated 2026-09-03 for pass 33 discovery. A read-only census of Viberr's automated
test suite: every vitest file under `app/**` plus the Playwright specs `scripts/e2e.ts`
runs, grouped by subsystem, with case counts taken by shell (`grep -c` on
`^\s*(it|test)(\.x)?\s*[(\`]`) rather than by reading each file. The point of the
document is the **Thin coverage** section: exported symbols and behaviours that no test
touches directly, cross-referenced against the source tree. Counts are a floor —
parametrized `for (…) it(…)` loops (the controller org-role probe matrix, the a11y
theme×surface matrix) each count as one line here but generate many cases at runtime.

**Totals: 307 vitest files / 4855 `it`/`test` lines, plus 8 Playwright specs
(38 `test(` lines, more at runtime) driven by `npm run e2e`.**

> **Closing note, 2026-09-03 (end of pass 33).** This census is the *discovery* snapshot —
> read it as "what was true when the pass opened". The **Thin coverage** gaps it names as
> having no test that can go red were then closed by the pass itself: ten new test files,
> 132 cases, covering `require-project.server.ts`, `github-context.server.ts`,
> `form-action.server.ts`, `controller-dock-query.server.ts`, `controller-conversations`'
> two access predicates plus `get_github_state`, `run-events.server.ts`,
> `claude-config.server.ts`, `write-cache.server.ts`, `task-mutation.server.ts` and
> `ACTION_ROLES` (`app/shared/rbac.test.ts`, which also pins the two domain doc tables
> against the code). Each was proven by breaking its source and watching the test go red.
> The suite closed at **319 files / 5201 cases**. The rows below are left as written —
> they are the record of what the gap was, not a live to-do list.

Config facts worth carrying into pass 33:

- `vitest.config.ts` — `include: ["app/**/*.test.{ts,tsx}"]`, single `node`
  environment, `testTimeout: 20_000` (one global budget, locked by
  `app/shared/docs/vitest-config.test.ts`; never raised per-test). Setup files:
  `test-support/setup-env.ts` (hermetic secrets), `test-support/setup-dom.ts`
  (`<dialog>` shim).
- No test files live outside `app/` — `test-support/` holds only helpers
  (`test-db.ts`, `test-store.ts`, `test-app.ts`, `fake-runtime.ts`,
  `fake-github.ts`, `audit-log.ts`, `demo-seed.ts`, `custom-board.ts`).
- `db/**/*.test.ts` was deliberately dropped from the include glob (G10) — it had
  matched zero files since migrations were squashed into `0001_baseline.sql`.
- e2e runs against the **production Docker image** in an isolated Compose stack
  (`compose.e2e.yml`, project `viberr-e2e`), one worker, `fullyParallel: false`,
  Chromium only, `auth.setup.ts` logging in through the real `/login` UI.

---

## Subsystem table

### `app/server`  — 171 files / 2764 cases

| Subsystem | Files | Cases | What is covered |
| --- | ---: | ---: | --- |
| `server/tasks` | 39 | 962 | The governance core: task actions, packet resolution, acceptance graph + refusal stack, delivery decisions/requeue, agent completion + outcomes + replies, operator actions/toolkit, specialist run + MCP + tool policy, schedules, goals, mentions, evidence, archive read-only, timeline compaction, workspace retention |
| `server/runtimes` | 18 | 450 | Claude + Codex adapters (streaming, failure classification, isolation, sandbox modes), run-service/sink/projection/recovery/concurrency, runtime registry, model catalog + availability, skill mount, KB injection, wire format, session export, harness hermeticity |
| `server/github` | 16 | 321 | Reconciler (63 cases), PR linker/adoption/open/human-approval/divergence-wake, branch sync + update-branch (+ operator arm), push-workspace, workspace delivery, github client, repo-access check, reconcile poller, scope flag, agent github read |
| `server/projections` | 16 | 184 | Rebuilder + rebuild, notifications, review queue, decisions, activity feed (×2), task activity, agent deployments, policy violations, project labels, single-flight, live-backend overlay, derivation version, diagnostics flow, honesty pins |
| `server/org` | 9 | 137 | Resources (KB/skill/MCP, 45 cases), store files, connections, global agents, org users, resource catalog + references, MCP warmup, org seed |
| `server/files` | 15 | 132 | task-file parse/write, task-writer, project-writer, goal-writer, atomic file, file mutex, store root, file + KB watch services, KB injection, skill body, attachments, actor ref, agent-profile file, store-check |
| `server/auth` | 12 | 103 | login, identity, password, CSRF, rate limit, require-user, session renewal, seed admin, user admin, OAuth providers + provisioning, project authority |
| `server/db` | 8 | 79 | data-root lock (30 cases), backup, retention, self-heal, sqlite, migration runner, CLI lock, projection-validation check |
| `server/controller` | 5 | 79 | Toolkit authority gates + task anchoring, context gathering/clipping, conversations, controller run, viberr_ops MCP |
| `server/secrets` | 5 | 65 | PAT validator + store, secret box, key rotation, git output redaction |
| `server/seed` | 6 | 57 | agent catalog, base agents, default assets, demo fixture, operator parity, seed |
| `server/ops` | 4 | 38 | maintenance, disk space, build info, transcript retention |
| `server/events` | 2 | 32 | SSE broker (scope parse/route/replay/heartbeat/shutdown), event publisher |
| `server/audit` | 5 | 29 | audit query/browse/export, S3 put, coverage pin |
| `server/config` | 1 | 19 | env schema/validation |
| `server/insights` | 1 | 18 | insights queries |
| `server/logging` | 2 | 16 | logger, request context |
| `server/interpretation` | 2 | 10 | readiness + freshness policies |
| `server/agents` | 1 | 9 | deployment view |
| `server/settings` | 1 | 7 | instance settings |
| `server/provenance` | 1 | 7 | provenance query |
| `server/prefs` | 1 | 6 | user prefs |
| `server/actions` | 1 | 4 | action watchdog |
| `server/(root)` | 1 | 12 | `boot.server.test.ts` |
| **`server/errors`** | **0** | **0** | **no tests** (`app-error.server.ts`, `error-codes.ts`) |
| **`server/theme`** | **0** | **0** | **no tests** (`theme-cookie.server.ts`) |

### `app/features` — 83 files / 1568 cases

| Subsystem | Files | Cases | What is covered |
| --- | ---: | ---: | --- |
| `features/task-detail` | 13 | 398 | Components (124), disposition (80), route server (50), attachments panel, accept-confirm, continuity recovery, mention composer + autocomplete, execution profile, side panels, timeline slice, runtime route |
| `features/board` | 3 | 164 | Board page (123), filters, dnd model |
| `features/agents` | 5 | 142 | Agents page (73), route server, query server, capability catalog, model-catalog route |
| `features/project-settings` | 4 | 115 | Page, route server, settings actions, ghost members |
| `features/org-settings` | 6 | 111 | Org settings page (56), route server, controller admin panel, users panel, SSO panel, `useOrgAction` |
| `features/runtime` | 7 | 100 | runs helpers + panels, run-log stream hook, run artifact routes, log clock, log noise, elapsed hook |
| `features/github` | 5 | 93 | github view, route server, actions server, pills, copy |
| `features/policy` | 4 | 79 | policy RBAC server (31), page, route server, project-authority routes |
| `features/shell` | 7 | 72 | Shell components, workspace routes, command palette (+hook, +search server), nav, route pending bar |
| `features/home` | 6 | 66 | Home page, project create server, new-project modal, phase-10 route, home query, project name |
| `features/review` | 4 | 44 | Review page, helpers, route server, acceptance authority |
| `features/activity` | 2 | 31 | Activity page + route server |
| `features/controller` | 3 | 29 | Dock component (19), dock context (7), controller page (3) |
| `features/notifications` | 3 | 27 | Notifications page, route server, notification item |
| `features/profile` | 2 | 24 | Profile page + route server |
| `features/kb-browser` | 3 | 21 | Store browser, tree, local files |
| `features/live-updates` | 2 | 19 | `useLiveUpdates`, SSE route server |
| `features/insights` | 1 | 13 | Insights page |
| `features/(root)` | 3 | 20 | copy-ban lint, retired vocabulary, toast honesty |

### Cross-cutting

| Subsystem | Files | Cases | What is covered |
| --- | ---: | ---: | --- |
| `app/shared` | 15 | 148 | task mapping (41), capabilities (29), workflow transitions/stage-eligibility/stage-roles/guardrail-labels, dates, plural, actor + notification mapping, provider marker, docs-sync pins (PRD, file formats, vitest config, anti-slop vendor) |
| `app/ui` | 13 | 115 | markdown, label-input, stage-menu, calendar, date-picker, rich text, toast, task-meta, mention spans, roving radio, `useDismiss`, `useActionToast`, `useShortcutHint` |
| `app/routes` | 19 | 96 | health, run-log, controller resource route, task-attachment, login (server + page), project loaders (server/board/task/github), org settings audit/concurrency/upload, project visibility, insights, page titles, notifications |
| `app/schemas` | 2 | 50 | `task-file.schema` (46), `project-file.schema` (4) |
| `app/(root)` | 2 | 101 | `app.css.test.ts` (96 — token scales, contrast, specificity, one-breakpoint), `root.test.tsx` (5) |
| `app/lib` | 1 | 1 | better-auth wiring smoke test |

### e2e (`npm run e2e` → `scripts/e2e.ts` → `playwright.config.ts`, testDir `e2e`)

| Spec | `test(` lines | Covers |
| --- | ---: | --- |
| `e2e/auth.setup.ts` | (setup project) | Real `/login` UI sign-in, stores `e2e/.auth/arda.json` |
| `e2e/01-home-board.spec.ts` | 7 | Home project list; board columns; same-stage pointer reorder; cross-stage drop; Escape-cancels-drag; Done-stage drop confirm + dismiss; verdict gate on confirm |
| `e2e/02-feeds-profile.spec.ts` | 5 | Review queue rows + primary action; day-grouped activity feed; mark-all-read; theme cookie persistence |
| `e2e/03-org-settings-store.spec.ts` | 3 | Org settings tabs + headings; StoreBrowser real `mkdir` through the UI |
| `e2e/04-palette-mobile.spec.ts` | 6 | ⌘K palette → task; board-scoped filter; 375px rail collapse + no sideways scroll; non-member 404; mobile palette entry + touch target |
| `e2e/05-task-comment-composer.spec.ts` | 7 | Lexical composer: plain post, Enter vs ⌘Enter, @-mention keyboard + click insert, Escape closes menu, undo cannot resurrect, combobox a11y wiring |
| `e2e/06-activity-hydration.spec.ts` | 1 | Non-UTC (Pacific/Auckland) hydration cleanliness |
| `e2e/07-accessibility.spec.ts` | 7 (matrix) | axe WCAG 2.2 AA over surfaces × light/dark, dialogs, mobile rail overlay, signed-out login |
| `e2e/08-controller-dock.spec.ts` | 2 | Dock follows the surface and stays off controller pages; 375px bottom sheet |

---

## Thin coverage

### 1. Server modules with **no sibling test file at all**

The following `app/server/**` modules have no `*.test.ts` beside them. The ones marked
**(no test file imports it)** are additionally never imported by any test — nothing in
the suite reaches them except transitively through a route or action.

| Module | Lines | Exports | Status |
| --- | ---: | ---: | --- |
| `app/server/runtimes/backend-quota.server.ts` | 467 | 15 | Only 3 test files touch it, all indirectly |
| `app/server/runtimes/run-store.server.ts` | 472 | 19 | Widely imported; several exports never asserted (below) |
| `app/server/projections/board-query.server.ts` | 336 | 16 | Widely imported; ordering primitives never asserted |
| `app/server/controller/controller-profile.server.ts` | 323 | 11 | 3 test files |
| `app/server/projections/task-query.server.ts` | 260 | 8 | Widely imported; `listTaskEvents` never asserted |
| `app/server/runtimes/adapter.server.ts` | 237 | 10 | Type/spec surface |
| `app/server/org/org-view.server.ts` | 214 | 3 | 2 test files |
| `app/server/tasks/task-mutation.server.ts` | 212 | 9 | **(no test file imports it)** — see §7 |
| `app/server/auth/user-store.server.ts` | 185 | 11 | Imported by 62 test files (as a fixture helper), never asserted on its own |
| `app/server/audit/s3-config.server.ts` | 164 | 5 | 2 test files |
| `app/server/auth/oauth-credential-test.server.ts` | 161 | 4 | 1 test file |
| `app/server/controller/controller-tool-guards.server.ts` | 152 | 7 | 2 test files; no export asserted directly |
| `app/server/ops/health-snapshot.server.ts` | 140 | 4 | 1 test file |
| `app/server/events/projection-events.server.ts` | 129 | 5 | 6 test files |
| `app/server/files/frontmatter.server.ts` | 111 | 6 | 1 test file |
| `app/server/errors/app-error.server.ts` | 98 | 4 | 10 test files, none asserting the class itself |
| `app/server/seed/ensure-base-agents.server.ts` | 90 | 1 | 1 test file |
| `app/server/auth/require-project.server.ts` | 89 | 1 | **(no test file imports it)** — `requireProjectMember`, the membership chokepoint |
| `app/server/audit/audit-recorder.server.ts` | 89 | 7 | Asserted only through `test-support/audit-log.ts` |
| `app/server/github/github-context.server.ts` | 85 | 5 | **(no test file imports it)** — `getProjectGithubContext`, every GitHub call's entry gate |
| `app/server/provenance/provenance-recorder.server.ts` | 80 | 4 | 2 test files |
| `app/server/interpretation/diagnostics-policy.server.ts` | 75 | 4 | **(no test file imports it)** |
| `app/server/files/write-cache.server.ts` | 71 | 3 | **(no test file imports it)** — the stale-read shield |
| `app/server/files/project-file.server.ts` | 69 | 3 | 4 test files |
| `app/server/runtimes/run-events.server.ts` | 66 | 2 | **(no test file imports it)** — publishes `run.log-appended` / `run.state-changed` |
| `app/server/github/branch-cleanup.server.ts` | 57 | 3 | 3 test files |
| `app/server/projections/rescan.server.ts` | 54 | 2 | 2 test files |
| `app/server/runtimes/claude-config.server.ts` | 53 | 2 | **(no test file imports it)** |
| `app/server/theme/theme-cookie.server.ts` | 47 | 7 | **(no test file imports it)** |
| `app/server/auth/form-action.server.ts` | 30 | 2 | **(no test file imports it)** |
| `app/server/errors/error-codes.ts` | 28 | 2 | 3 test files |
| `app/server/org/resource-events.server.ts` | 27 | 2 | **(no test file imports it)** |
| `app/server/db/transaction.server.ts` | 13 | 1 | **(no test file imports it)** |
| `app/server/seed/seed-credentials.ts` | 12 | 1 | **(no test file imports it)** |

### 2. Packet resolution kinds (all 11)

`PACKET_OPTION_KINDS` in `app/schemas/task-file.schema.ts:129` — every kind reaches
`resolvePacket` (`app/server/tasks/task-actions.server.ts:5995`) in at least one test, so
there is **no unresolved kind**. Depth is very uneven, though:

| Kind | `resolvePacket` test files | Assessment |
| --- | --- | --- |
| `accept_completion` | 8 | Deep — acceptance graph, closed-PR, no-change, RBAC, route |
| `custom` | 5 | Deep |
| `request_edit` | 5 | Good |
| `discard_branch` | 2 | Adequate (`delivery-decision`, `task-governance`) |
| `archive_task` | 2 | Adequate |
| `resolve_remote_collision` | 3 | Adequate |
| `hold_runtime_debug` | 4 | Shallow — appears as packet fixture, effects rarely asserted |
| `block_on_policy` | 3 | Shallow |
| `edit_goal` | 2 | Two dedicated cases (`task-governance.server.test.ts:2034`, `:2096`) |
| `redirect` | 2 | Thin — only `task-governance.server.test.ts:1059` (fallback copy) plus fixture uses |
| **`retry_other_backend`** | **1** | **Thinnest** — only `task-governance.server.test.ts:1076` and `:1164` |

Concrete gaps:

- `retry_other_backend` is tested for the happy path and for engagement pinning, but
  never for: the target backend being quota-exhausted, an absent `profileId` on a
  reviewer retry, or the option authored on a task whose engagement is gone.
- `hold_runtime_debug` and `block_on_policy` have no test asserting what they leave on
  the task file (readiness, packet clearing) — they are used as fixtures for
  *other* assertions (delivery requeue, packet listing).
- Authoring-side guards are tested (`task-actions.server.ts:2482` scoping,
  `:2503` `accept_completion` exclusion) but the pairing rule "`discard_branch` is
  refused exactly when `resolve_remote_collision` applies" has no negative case for
  a packet that carries **both** options.

### 3. Acceptance refusal stack

`acceptanceRefusalReason` (`app/server/tasks/task-actions.server.ts:7207`) chains eight
guards. Coverage by arm:

| Arm | Helper | Coverage |
| --- | --- | --- |
| Archived task | `archivedTaskBlockedReason` | Covered (`archive-readonly.server.test.ts`) |
| Closed PR (R16-3) | `closedPrBlockedReason` | Covered (`acceptance-closed-pr.server.test.ts`, 16 cases) |
| Stage/graph gate | `acceptanceStageBlockedReason:7171` | Covered — sentence asserted from a real server path at `operator-actions.server.test.ts:1518` (`/In Progress, not Review/`) |
| Required reviewers | `acceptanceBlockedReason` | Covered |
| No-change has-work | `noChangeWorkRefusal` | Covered (`no-change-acceptance.server.test.ts`) |
| Verdict gate | `verdictGateReason` | Covered |
| Open blocked packet | inline string | Covered (6 files) |
| Conflicting PR | `conflictingPrBlockedReason` (`task-file.schema.ts:877`) | Covered server-side (`acceptance-graph.server.test.ts:409/440/462/469/912`) and on the board (`board-page.test.tsx:1228-1258`) |

The chain itself is well covered. The thin parts are the **derived shape** around it:

- The refusal sentences the *task-detail components* render are hand-built literals in
  `task-disposition.test.tsx:288/797/880` and `task-detail-components.test.tsx:1497`,
  and they use a different punctuation shape than the live server string
  (`…, not Review — a completion…` vs the source's `…, not Review. A completion…`).
  Nothing pins the component fixtures to the server's own copy, so the two can drift
  silently.

- `resolveAcceptanceAffordance:7587` returns `blockedReasonViaPacket` (the F19-7
  packet-path refusal, deliberately computed with `blockedPacket: false`). Its only four
  test occurrences are hand-built `null` literals in component fixtures
  (`task-disposition.test.tsx:102`/`:1300`, `task-side-panels.test.tsx:30`,
  `continuity-recovery.test.tsx:425`). **No server test asserts the two fields diverge
  on the same task** — which is the entire reason the field exists.
- `verdictSatisfiedBy` (R19-B human GitHub approval sentence) is asserted in
  `pr-human-approval.server.test.ts` but not through `resolveAcceptanceAffordance`.
- `ERROR_CODES.ACCEPT_DISCLOSURE_MISSING` / `ACCEPT_DISCLOSURE_STALE` each appear in
  exactly **one** test file. `app/shared/acceptance-disclosure.ts` has **no sibling
  test**: `parseAcceptanceDisclosure:85` and `acceptanceDisclosureDrift:137` — the
  drift comparison that decides "stale" — are only exercised indirectly through
  `project.task.tsx` / `project.board.tsx` route tests.
- `ERROR_CODES.UNAUTHORIZED`, `INTERNAL`, `DB_MIGRATION_FAILED` have **zero**
  occurrences in any test. `UNAUTHORIZED` is the V11-4 (pass 32) code the SSE
  subscribe route answers with (`app/routes/resources.events.ts:69`) — the very
  regression it was added to prevent is unpinned.

### 4. Goal chain reconciliation

`app/server/tasks/goal-actions.server.test.ts` is strong (20 cases: advance, park,
retry, convergence, concurrency, authority re-proof, archived-project freeze). The gaps
are the **entry points**, not the algorithm:

- `startGoalRunner` (`goal-actions.server.ts:921`) — **0 test references**. The interval
  loop that drives reconciliation in production is untested; every test calls
  `reconcileGoal` directly.
- `reconcileAllGoals` (`:884`) — **0 test references**. The sweep-all path (partial
  failure isolation, ordering) is unproven.
- `maybeReconcileGoalForTask` (`:847`) — **0 test references**. This is the hook task
  mutations call to wake a chain; nothing pins that a task completion actually reaches
  reconciliation through it.
- `toGoalView` (`:974`) and `GOAL_MAX_LINKS` (`:67`) — **0 references**; the 20-link cap
  has no refusal test.
- `app/schemas/goal-file.schema.ts` has **no sibling test and is named by no test file**.
  `allLinksSettled:125` and `currentLinkIndex:134` — the two predicates the whole chain
  advances on — are untested in isolation, as are the tolerant-parse fallbacks for
  `goalFrontmatterSchema`.

### 5. Controller toolkit (38 tools)

Extracted from `app/server/controller/controller-toolkit.server.ts`. All 38 exist; 15
admin tools get a parametrized org-role probe (`controller-toolkit.server.test.ts:140`),
and the project-scope tools get role-arm tests.

- **`get_github_state` — zero test references anywhere in `app/**` or `e2e/`.** Defined
  at `controller-toolkit.server.ts:1281`. The only one of the 38 with no gate probe and
  no behavioural test.
- **Gate probe only, no behaviour/output test** (the admin probe asserts only that the
  org-role refusal is absent, and explicitly tolerates a validation failure):
  `inspect_audit_log`, `inspect_run_analytics`, `test_mcp_server`, `list_knowledge_bases`,
  `list_skills`, `list_mcp_servers`, `list_global_agents`.
- **One incidental reference only**: `deploy_agent` (`:539`), `update_agent_deployment`
  (`:541`), `invite_member` (`:536`) — all three appear solely inside the
  maintainer-refused/admin-granted probe list at `controller-toolkit.server.test.ts:521`.
  Nothing asserts what a *successful* deploy/undeploy/invite writes.
- `list_goals` / `get_goal` have one read assertion each (`:602`, `:604`); no test for a
  goal in another project, a redirected chain, or an unknown id.
- `update_project_settings` and `update_stages` are gate-probed only — no test that a
  successful stage rewrite lands in `project.md` or that a stage rename re-keys tasks.

Supporting controller modules with untested exports (all **0 test references**):

- `app/server/controller/controller-conversations.server.ts`: `canAccessConversation:121`,
  `canReadControllerRunLog:141` — the conversation ACL. Reached only indirectly via
  `app/routes/resources.controller.test.ts` (7 cases) and `resources.run-log.test.ts`
  (5 cases). Also `recentMessages:290`, `deriveTitle:390`,
  `publishConversationUpdated:396`.
- `app/server/controller/controller-run.server.ts`: `conversationTurnState:500`,
  `transcriptDigest:625`.
- `app/server/controller/controller-tool-guards.server.ts`: **every** export —
  `controllerToolGuards:79`, `notVisible:48`, `NotVisibleError:54`,
  `controllerToolText:42`. This is the module the "not visible" 404-posture depends on.
- `app/server/controller/controller-profile.server.ts`: `readControllerDefinition:114`
  (the `FALLBACK_CONTROLLER_DEFINITION` path when the on-disk definition is missing or
  unreadable).

### 6. Capability enforcement per backend

`app/shared/capabilities.test.ts` (29 cases) pins the **classification**
(`capabilityEnforcement` → `both` / `claude-only` / `advisory`), and
`specialist-tool-policy.test.ts` (27) pins the **Claude** denylist. `resolveCodexSandboxMode`
(`codex-runtime.server.ts:392`) is tested at the flag level
(`codex-runtime.server.test.ts:1050-1200`: repo-write withheld → read-only, evidence
carve-out → workspace-write, operator → read-only, egress-withheld stays workspace-write).

Gaps:

- **No test maps a capability id to Codex enforcement end-to-end.** Not one of the 31
  catalog ids appears as a literal in `codex-runtime.server.test.ts` or
  `codex-config.server.test.ts`; the Codex tests take pre-derived booleans
  (`repoWriteWithheld`, `evidenceGranted`). Nothing proves the *id →* flag derivation in
  `specialistGrantModes` / `specialist-run.server.ts` feeds the sandbox correctly. A
  rename or polarity flip in that derivation would pass every Codex test.
- Capability ids with **zero** occurrences in any test:
  `flag-underspecified-tasks`, `run-unit-integration-validation`, `run-validation-suites`.
  These are advisory (prompt-only), but nothing pins that classification.
- Capability ids with **one** occurrence: `author-test-cases`, `read-task-repo`.
- `resolveUndeployedDisallowedTools` (`specialist-tool-policy.ts:174`) is covered; the
  parallel operator confinement on Codex (`confineOperator`) has one case
  (`codex-runtime.server.test.ts:213`) shared with three other assertions.
- `CLAUDE_ONLY_ENFORCED_CAPABILITY_IDS` is asserted as a *set*
  (`capabilities.test.ts:65`) but there is no test proving a claude-only cap is
  **inert** on Codex — the honest asymmetry the label promises.

### 7. RBAC edge cases

- **`app/shared/rbac.ts` has no sibling test.** `roleCan:104` and `rolesForAction:110`
  are the single-source predicates every guard funnels through; neither has a unit test.
  In particular `rolesForAction`'s `throw new Error("unknown RBAC action: …")` path
  (`:116`) — the type-escape guard — is unreachable in the suite.
- `ROLE_RANK:31` and `ROLE_LABEL:38` have no direct assertions.
- Action ids appearing in **one** test file only: `edit-task-meta`, `approve-transition`,
  `update-goal`, `reorder-board`, `reconcile-github`, `rescan-project`, `manage-agents`.
  `view` appears in 4 files but never as a denial case for a null (non-member) role at
  the `roleCan` level.
- `app/server/auth/require-project.server.ts` (`requireProjectMember:33`) — the
  membership + unknown-slug-posture chokepoint — has **no sibling test and no test file
  imports it**. All 8 grep hits are prose comments, except
  `project-authority-routes.server.test.ts:475`, which greps the *route source* for
  `/requireProjectMember\(|requireVisibleProject\(/` — a call-site pin, not a
  behavioural test. It is exercised only through loaders (`policy-rbac.server.test.ts`,
  `workspace-routes.server.test.ts`) and e2e (`e2e/04-palette-mobile.spec.ts:85`), so
  the 403-vs-404 posture, the archived-project arm, and the org-admin override have no
  isolated cases.
- `app/server/tasks/task-mutation.server.ts` (**no test file imports it**) holds
  `notifyTaskWatchers:149` with its `scope`/`exceptUserId`/`exceptUserIds` recipient
  algebra, plus `loadProjectContext:81`, `taskRef:104`, `reprojectTask:117`.
  `notifyTaskWatchers` is called from only two places in the whole suite
  (`task-actions.server.test.ts:1536`, `:1552`) — the maintainer-scope branch
  (`task-mutation.server.ts:159`) and the double-exclusion path have no dedicated case.

### 8. Schedule runner

`schedule.server.test.ts` (25 cases) is thorough on `fireDueSchedules` — claim leases,
crash re-drive, Done/archive races, cancelled entries, run-agent without a profileId.

- **`startScheduleRunner` (`schedule.server.ts:791`) — 0 test references.** Same class of
  gap as `startGoalRunner`: the production timer/interval that actually calls
  `fireDueSchedules` is never started in a test.
- `tasksWithUnresolvedSchedules:280` is covered indirectly; `claimLeaseMs:322` has one
  case (`:602`).
- `cancelScheduledAction:221` has two cases (`:373`, `:393`); no test for cancelling an
  already-fired or already-cancelled occurrence, or cancelling as a non-creator.

### 9. GitHub reconciler

`github-reconciler.server.test.ts` is the largest single GitHub file (63 cases). Result
variants by test-literal frequency:

| Variant | Mentions | |
| --- | ---: | --- |
| `reconciled` / `no_branch` / `network_unavailable` / `auth_failed` / `scope_violation` | 22 / 16 / 14 / 8 / 7 | Covered |
| `task_not_found` | 2 | Thin |
| **`task_error`** | **1** | **Thin** — the F21-9 per-task catch-all (a pass that throws for one task must not fail the sweep) has essentially one assertion |
| `mergeTaskPr` → `head_changed`, `pr_not_found` | 1 each | Thin — `head_changed` is the race guard between the acceptance read and the merge |
| `mergeTaskPr` → `no_pr`, `not_mergeable` | 3 / 4 | Adequate |
| `deleteTaskRemoteBranch` → `already_gone` | 1 | Thin |
| **`resolveRemoteBranchCollision` → `cleared`** | **0** | **The success path is never asserted.** The only two direct callers are `task-governance.server.test.ts:1704` (the `refused` system-actor arm) and `audit-coverage.server.test.ts:314` (asserts an audit row exists, not the outcome). Nothing proves the unowned PR is closed, the stale remote ref deleted, and the work re-delivered |
| `RECONCILE_POLL_TASK_BUDGET` (`:966`) | 0 | The 20-task poll budget is never asserted — a poller that silently stops mid-project would pass |

`reconcileProject:996` has 17 references; `RECONCILE_TASK_CONCURRENCY:958` has 3. No test
drives a project with more than the concurrency limit of tasks to prove the batching.

### 10. Notification routing

`notifications.server.test.ts` (30 cases) covers the projection well; all six
`NOTIFICATION_KINDS` are exercised.

- The **fan-out** side is the gap — see §7 on `notifyTaskWatchers`.
- `indexDecisionInbox:156`, `markTaskPacketApprovalRead:325`, `isTaskViewNavigation:387`,
  `markTaskNotificationsSeen:411` — the "opening the task marks its decision read"
  chain — are asserted only inside `notifications.server.test.ts` and
  `task-detail-route.server.test.ts`; `isTaskViewNavigation` (a `Request`-sniffing
  predicate, easy to break on a React Router upgrade) has no isolated case.
- `deleteProjectNotifications:250` — cascade on project deletion — appears once.
- `reconcile-poller.server.ts:161` fans a divergence notice to every project member;
  `reconcile-poller.server.test.ts` has 11 cases but none asserting the recipient set
  excludes viewers or the acting user.

### 11. SSE broker

`sse-broker.server.test.ts` (23 cases) is one of the better-covered modules: scope parse,
project/task/user/broadcast routing, ring-buffer replay, `stream.resync` on both
buffer-overrun and server-life change, heartbeat re-authorization, drop-on-failed-write,
shutdown.

Gaps:

- **Three of the 15 `SSE_EVENT_NAMES` are never published or routed in any test**
  (`app/schemas/sse-event.schema.ts:22`):
  - `controller.updated` — the ruling-99 event routed to the conversation **owner
    only**. Its single grep hit (`org-settings-route.server.test.ts:606`) is the
    unrelated audit action `"org.controller.updated"`. A routing mistake here leaks
    controller activity across users and nothing pins it.
  - `resource.updated` — the pass-32 (F32-2) broadcast. Named only in a test *title*
    (`org-settings-page.test.tsx:1111`), which asserts the page opens an EventSource,
    not that the broker routes the event.
  - `run.state-changed` — mentioned only in prose comments
    (`use-run-log-stream.test.tsx:14`, `:521`). The hook's fake EventSource emits
    `run.log-appended` five times and `run.state-changed` **zero** times, so the
    revalidate-on-lifecycle-change path the comments describe is unexercised.
- `task.removed` (1), `project.removed` (2), `stream.resync` (2) are thin.
- `armProcessShutdown:412` — **0 references**; only `runProcessShutdown:416` (2) is
  called, so the arming side (idempotency, double-arm) is unproven.
- `app/schemas/sse-event.schema.ts` has **no sibling test**; the discriminated union's
  per-variant payload validation is only exercised through the broker's happy paths.
- `app/server/runtimes/run-events.server.ts` (`publishRunLogAppended:12`,
  `publishRunStateChanged:42`) — **no test file imports it**, which is why
  `run.state-changed` has no coverage.

### 12. Controller dock

Client side is well covered: `controller-dock.test.tsx` (19 cases — focus management,
Escape in/out, restore-without-stealing-focus, stale selection, scope refusal, thread
switching, polling lifecycle, animation gating) and `controller-dock-context.test.ts`
(7 cases — `dockContextFromMatches`, hidden routes, self-stream routes, scope/URL
encoding). e2e adds 2 cases (`e2e/08-controller-dock.spec.ts`).

Server side is the gap. **`app/features/controller/controller-dock-query.server.ts` has
no sibling test and not one of its exports is referenced by any test**:

- `describeDockScope:80` — the scope→prose the trigger label renders
- `conversationMatchesScope:123` — the predicate that keeps a task thread out of a board
  dock (the cross-scope leak guard)
- `getControllerDock:133` — the view builder
- `dockTaskExists:201` — the "the anchored task is gone" probe
- `unavailableDockView:211` — the refusal view
- `DOCK_NEW_CONVERSATION:78`

They are reached only through `app/routes/resources.controller.test.ts` (7 cases), which
asserts route-level behaviour ("refuses a thread from another scope") but never the
predicate in isolation. Likewise `DOCK_HIDDEN_ROUTE_IDS`
(`controller-dock-context.ts:43`) has 0 direct references — the hidden-route list is
asserted only by name-checking two routes in `:107`, so adding a route to the list has
no pin.

`app/features/controller/controller-query.server.ts` (`getControllerSurface:57`) has 2
references; the full controller **page** has only 3 component test cases against a
16.6 KB component.

### 13. Other feature modules with no test and no test-file import

Never rendered or imported by any test (transitive rendering through a page test may
still exercise some of them, but nothing asserts them):

- Org settings resource UI: `resources-panel.tsx`, `resource-rows.tsx`,
  `resource-modals.tsx`, `resource-helpers.ts`, `connections-panel.tsx`,
  `agent-template-modal.tsx`, `mini-modal.tsx` — 7 of the 12 files in
  `app/features/org-settings/`
- Task detail: `agent-select.tsx`, `archive-confirm.tsx`, `attachment-image.tsx`,
  `comment-composer.tsx`, `event-meta.ts`, `mention-menu.tsx`,
  `use-mention-autocomplete.ts`
- `app/features/github/credential-visibility.server.ts` — the PAT-visibility predicate
  (R19-11), no direct test
- `app/features/shell/csrf-result.server.ts`, `app/features/shell/theme-preference.ts`
- `app/features/activity/feed-limits.ts`, `app/features/notifications/notification-meta.ts`
- `app/features/home/home-sections.tsx`, `app/features/kb-browser/icons.tsx`
- `app/routes/api.auth.$.ts` (the better-auth splat allow-list),
  `app/routes/palette-shell.tsx`, `app/routes/project._index.tsx`
- UI primitives: `avatar.tsx`, `confirm-dialog.tsx`, `csrf-input.tsx`, `icon.tsx`,
  `initials.ts`, `local-time.tsx`, `page-overlay.tsx`, `pill.tsx`, `skip-link.tsx`,
  `toggle.tsx`, `use-dialog.ts`, `use-fetcher-result.ts`, `use-relative-time.ts`
- Shared: `app/shared/auth/password-policy.ts`, `app/shared/auth/auth-paths.ts`,
  `app/shared/freshness.ts`, `app/shared/ids/slugify.ts`,
  `app/shared/mapping/project.server.ts`

`app/lib/auth.server.test.ts` has **1** case for the entire better-auth wiring.

### 14. Untested exports in otherwise-tested modules

Exports with **zero** references in any test file:

- `app/server/projections/board-query.server.ts`: `taskKeyNumber:42`,
  `effectiveBoardRank:52`, `compareBoardOrder:60`, `removedAccountLabel:145`,
  `resolveTaskOwner:165` — the board's entire ordering algebra and the deleted-account
  label. Board order is proven end-to-end (e2e drag, `reorderTask`) but never at the
  comparator level, where an off-by-one in `BOARD_RANK_BASE` arithmetic would live.
- `app/server/projections/task-query.server.ts`: `listTaskEvents:121`
- `app/server/runtimes/run-store.server.ts`: `listRunLinesTail:333` (log tail paging),
  `runLineStats:377`, `runIdsWithMissingSession:405` (the continuity-recovery detector
  consumed by `agent-reply.server.ts:258`), `appendRawLine:444`, `nextSeq:261`
- `app/server/runtimes/backend-quota.server.ts`: `quotaExhaustionEvidence:176` has 1
  reference, `parseQuotaResetAt:285` has 6 — both are free-text provider-banner parsers
  and the highest-value unit-test targets in the module; the remaining record/clear
  functions have 2-4 references each.
- `app/server/events/sse-broker.server.ts`: `armProcessShutdown:412`
- `app/server/tasks/goal-actions.server.ts`: `startGoalRunner`, `reconcileAllGoals`,
  `maybeReconcileGoalForTask`, `toGoalView`, `GOAL_MAX_LINKS`
- `app/server/tasks/schedule.server.ts`: `startScheduleRunner:791`

---

## Skipped tests

The suite has **no** `it.skip`, `describe.skip`, `test.skip`, `it.only`, `it.todo`,
`test.fixme`, or `runIf` anywhere in `app/`, `e2e/`, or `test-support/`. The only
conditional skips are two `skipIf` cases:

| Location | Condition | Why |
| --- | --- | --- |
| `app/shared/docs/anti-slop-vendor-sync.test.ts:55` — *"lists the same files"* | `!existsSync(.claude/skills/install-anti-slop/assets/anti-slop)` | `.claude/skills/` is a **local developer tool, not part of the repository**, so the byte-identity half of the vendored-tree pin can only run on a machine that has the skill installed. |
| `app/shared/docs/anti-slop-vendor-sync.test.ts:59` — *"holds byte-identical content for every file"* | same | same |

Both are deliberate and **already compensated**: pass-32 review finding F14 observed
that a local-only pin is not a gate, so the same file adds
`"matches the committed manifest, file for file (the CI gate)"` (`:67`), which hashes
`tools/oxlint/anti-slop/` against `tools/oxlint/anti-slop.manifest.json` and runs
everywhere. Re-pin with `node scripts/anti-slop-manifest.mjs` after a skill refresh.

Caution carried from the pass-32 memory: **`skipIf` pins are not gates.** When pass 33
adds any conditional test, pair it with an unconditional committed-artifact check the
same way this file does.

---

## Method

```sh
# file + case census
find app -name "*.test.ts" -o -name "*.test.tsx" | wc -l          # 307
grep -cE "^[[:space:]]*(it|test)(\.[a-zA-Z]+)?[[:space:]]*[(\`]"   # per file → 4855

# source-without-sibling-test
for f in $(find app/server -name "*.ts" -not -name "*.test.ts"); do
  [ -f "${f%.ts}.test.ts" ] || echo "$f"; done

# symbol reachability
grep -rho "\bSYMBOL\b" --include='*.test.ts' --include='*.test.tsx' app | wc -l
```

Counts are literal-frequency measures, so a symbol referenced only inside a `describe`
string (e.g. `report_outcome`, `github_read` in
`app/server/tasks/agent-toolkit.server.test.ts:163`, `:387`) can read as 0 on a
double-quoted grep while being well covered. Every "zero coverage" claim above was
re-checked with a bare `grep -rn` across `app/` and `e2e/`.
