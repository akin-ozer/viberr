# Implementation ledger

`validated` means the implementation is covered by the final automated regression and the relevant
Docker/API/file or browser evidence. Provider- or credential-dependent limits are named explicitly;
they are not silently counted as live proof.

| ID | Required change | Final status | Final evidence |
| --- | --- | --- | --- |
| F01 | Server-owned authenticated checkout, push, PR creation/reuse, remote-head and non-empty-diff verification | implemented; credentialed in-app path intentionally unverified | Delivery tests cover the server-owned path. GitHub CLI independently proved PR #20 merged, #21 closed unmerged, and #22 open then deliberately closed/deleted. The host credential was not imported without explicit confirmation, so Viberr's stale GitHub view is not claimed as reconcile/merge proof. |
| F02 | Reconcile identity removal; contributor-owner acceptance; audited org-admin emergency authority | validated | Centralized RBAC/lifecycle regression passed. Browser proved Elif project Admin, Murat Contributor and VDV-11 owner, Selin Viewer, and Arda as an org Admin/nonmember with a visible override. Contributor-owner terminal controls and org-admin override controls render according to policy. |
| F03 | Purge all project-keyed operational state on delete/recreate | validated | Canonical deletion/recreation regression covers runs/logs, credentials, violations, notifications, provenance, and audit isolation; the final clean database rebuilt without inherited projection errors. |
| F04 | Make stage order and workflow graph editing atomic | validated | Settings/policy regression covers deterministic adjacent-edge rewiring, governance preservation, and terminal human-edge locking; final Settings/Policy render cleanly. |
| F05 | Pass exact operator lease token through boot recovery | validated | Controlled race regression proves a stale predecessor cannot release its successor, while active triggers still coalesce. This fingerprint/race path is part of the final focused and full suites. |
| F06 | Persist operator failure independently of packet capability | validated | Failure/recovery tests prove the idempotent system fact and notification path even when packet authority is unavailable. |
| F07 | Own/cancel watchers, timers, run handles, and completion chains | validated | Full Vitest completed 1,318/1,318 without the earlier post-close writes or watcher re-arm failures; Compose watcher remained healthy. |
| F08 | Hydration-safe time rendering | validated | UTC-server/browser-hydration regression passed, Playwright passed 19/19, and final browser logs contain no warning/error after the evidence cutoff. |
| F09 | Make personal queues genuinely actionable | validated | Multi-role regression and final role views distinguish work actionable by the current user from project-wide human work. |
| F10 | Preserve review/PR states and honest merge-pending copy | validated with credential limit | Four-state review regression and the final Review/GitHub/task pages preserve blocked, closed, open, accepted-merge-pending, and merged semantics. The app's fixture states remained stale without a bound credential and are labelled as such. |
| F11 | Gate role-bound controls and protected destinations | validated | Cross-role browser evidence covers Admin, Contributor owner, Viewer, Maintainer, and org-admin override; protected controls and rail destinations follow the centralized role matrix. |
| F12 | Tie profile permissions to an explicit selected project | validated | URL-selected-project tests and browser role views show Murat as VDV Contributor while Viberr Core is Maintainer, without combining privileges across projects. |
| F13 | Replace false invitation delivery with truthful access provisioning | validated | Route/UI tests cover existing-account access and refusal to provision an unusable new account when OAuth is unconfigured; Settings copy says exactly which provider/account is required. |
| F14 | Resolve MCP secrets and perform a real initialize/tools-list probe | validated | Focused secret/handshake tests passed. A real DeepWiki HTTP MCP re-test was healthy in 1,477 ms with three tools, Claude and Codex support, and attachment to API Specialist. |
| F15 | Deploy an existing global profile into a project | validated | Governed reference-only deployment and URL preservation pass regression; final Agents/resource views reflect shared resources. |
| F16 | Index inline/global resource dependencies and enforce dependency semantics | validated | Dependency tests cover template-backed and inline deployments, exact consumers, and referenced rename/delete blocking. |
| F17 | Fail closed on omitted capabilities and preserve direct/recommend/human/off | validated | Capability/routing regression covers all four modes, omitted grants, and undeployed assignments; final Policy UI renders the contract. |
| F18 | Remove unsupported GitHub Enterprise/identity claims | validated | Client/profile tests and final copy consistently describe github.com and Better Auth account truth. |
| F19 | Emit real Claude/Codex phase/step and avoid fabricated live state | validated by adapter contract; no final real run signal | Registry/adapter/run tests cover phase/step. Final health truthfully reports both backends configured with `status: unknown` and no recent run signal; no live-provider success is invented. |
| F20 | Serialize and sequence-dedupe run-log fetches | validated | Burst/stale-response hook regression is included in the final clean suite. |
| F21 | Fail closed on Claude ambient skill/plugin leakage | validated by runtime envelope contract | Runtime tests cover empty account settings/skills/plugins/agents, strict MCP, and leaked-envelope rejection without persisting names. A final real Claude run was not used as proof because health had no run signal. |
| F22 | Disclose backend-specific confinement and hard-exclude incompatible routing | validated | Backend compatibility/routing regression passed; UI and current-state docs do not claim identical provider controls. |
| F23 | Give every Codex operator an isolated empty, repository-free workdir | validated | Operator-workdir regression is included in the 1,318-test suite. |
| F24 | Typed success/error feedback and response-aware notification actions | validated | Toast/notification tests cover success, error, and mutation completion; the final Notifications page hydrates and logs cleanly. |
| F25 | Make OAuth whitelist rejection visible | validated | Error-callback/loader/helper regression and production build passed; provider-unconfigured access copy remains truthful. |
| F26 | Make Agents tab/profile selection URL-addressable | validated | Query-authoritative tab/profile, Back/Forward, deleted-profile, and Playwright navigation tests passed; final profile URLs/screenshots were captured. |
| F27 | Expose SSE/navigation state and responsive project shell | validated | Lifecycle/navigation/drawer tests and Playwright passed. Desktop plus 390×844 Board/task/open-nav screenshots prove the responsive shell. |
| F28 | Separate configured credentials from verified provider health | validated | Final health reports Claude and Codex `configured: true`, `status: unknown`, with no run signal; it does not call credential presence verified availability. |
| F29 | Apply read-only archive/Restore semantics everywhere | validated | Route/mutation regression passed. Viberr Live Six was archived, active mutation surfaces became read-only, Board and Settings were captured, and Restore returned it to active state. |
| F30 | Remove seeded/fabricated running counts | validated | Home/Agents tests and final pages count only real non-simulated running rows; engaged/awaiting-agent copy is distinct from running. |
| F31 | Enforce the governed terminal path | validated | Terminal/reviewer focused suite passed 152 tests (and 165 in the broader focused run). Only exactly healthy Review work with all current approvals may accept; repo-less work may finish, while repo work stays Review until a real merge. Owner-control browser proof is captured. |
| F32 | Isolate reviewers and require one strict current-round verdict | validated | Stable reviewer workspaces, strict fingerprint parsing, stale-round invalidation, all-reviewer approval, and rejection-to-implementation are covered by the 152/165 focused runs and final VDV-8 UI evidence. |
| F33 | Give the operator full fit, availability, workload, and cost context without a static score | validated | Hard eligibility remains project-specific. Organization-wide workload/cost facts and project candidate skill/KB/MCP/backend context reach the operator, which makes the final intelligent decision and persists its rationale. Routing regression is in the final focused and full suites. |
| F34 | Share a truthful capability source for new-project templates | validated | Project-create/catalog regression passed and the fresh project loaded without unsupported catalog drift. |
| F35 | Make creation/Triage triggers visible and bounded | validated | Durable coalescing queue, concurrency/hourly observed-cost bounds, boot recovery, and placeholder-goal suppression pass regression. |
| F36 | Make readiness, recommendations, and transition authority atomic/auditable | validated | Structured readiness and authority regression freezes unresolved turns and preserves recommendation/direct provenance. |
| F37 | Prevent agents from inventing implementation scope | validated | Missing/placeholder intent remains input-required and opens durable human input rather than starting paid implementation. |
| F38 | Fail fast through one checkout/auth/tool preflight path | validated with credential limit | Fresh/resumed preflight/recovery tests passed. No credential was imported, so no final authenticated checkout was claimed; the app continued to show the honest blocker. |
| F39 | Separate operator configuration, queue, running, and finished state | validated | Deployment/dispatch/run status regression and final Agents views distinguish configured/engaged/queued/running/finished/failed. |
| F40 | Wait for exact-run interrupt acknowledgement | validated | Runtime/UI/route regression covers `Interrupting`, exact-run terminal convergence, and fallback messaging. |
| F41 | Detect/recover projection corruption and verify isolated write integrity | validated | Final health reports integrity `ok: true`, `recoveryRequired: false`; a second Compose container forced 5 projects/38 tasks/43 changes/0 errors in 172 ms and integrity stayed healthy. Single-process high-write stress and DB/health tests also passed. |
| DOC | Reconcile operational/current-state/planning documentation | validated | This dossier records final counts, screenshots, credential limits, historic baseline separation, and cleanup state. |
| REG | Full regression and live release evidence | validated | Typecheck clean; Vitest 146 files/1,318 tests; focused terminal/reviewer 152 plus broader focused 165; production build; Playwright 19/19 in 20.5 s; Docker/API/browser/log checks all passed. |

## Final environment snapshot

- Docker Compose final image: healthy at `http://127.0.0.1:5173`.
- Projection: 5 projects, 38 tasks, watcher active, integrity healthy, recovery not required.
- Backends: Claude and Codex configured, both honestly `unknown` because no final run signal existed.
- VDV: 24 cases retained as a discovery matrix. Its baseline model outcomes remain baseline evidence,
  not rewritten as post-fix live successes.
- GitHub cleanup: PR #22 was closed and its branch deleted. The branch was rebased onto PR #20's
  merge and the merged `test-support/deep-validation/VDV-13.md` fixture was removed before the
  final product PR was published.

## Previously deferred pass-4 checks folded into rows above

- MCP secret injection → F14.
- Adapter phase callbacks → F19.
- Codex operator workdir → F23.
- Claude account skill leakage → F21.
- Run-log dedupe → F20.
- Operator lease token → F05.
- Interrupt exact run and simulated raw-log placement → F07/F20/F40.
- OAuth flash → F25.
- Capability distinction → F17/F22.
- Agents query state → F26.
- Seeded eternal runs → F30.
