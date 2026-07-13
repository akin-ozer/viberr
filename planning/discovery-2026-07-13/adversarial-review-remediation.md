# Adversarial review remediation

This ledger reconciles the independent Claude Code review of
`codex/full-pass-2026-07-13` with the product rulings and the corrected
implementation. It exists so later implementation/review agents can distinguish
an intentional contract from an incidental patch.

## Scope and owner contract

- A contributor who owns a task may validate and accept that task's completion.
  Validation and acceptance are two separate human actions.
- An organization administrator has visible, audited emergency project-admin
  authority without receiving an implicit project membership.
- Viberr hard-filters impossible routing candidates, supplies skill/KB/MCP fit,
  backend health, organization-wide workload and observed cost, and leaves the
  final explainable choice to the intelligent operator. There is no static
  winner score.
- A project may deliberately have zero reviewers. At Review, an authorized
  human must record validation against the current immutable evidence before a
  separate acceptance action becomes valid.
- Simulated output is demonstration evidence only and never satisfies review or
  completion governance.
- The Codex process-argument secret exposure finding is intentionally outside
  this pass. The owner explicitly excluded security work from the current goal;
  this ledger does not misrepresent that finding as fixed.

## Remediation ledger

| Area | Corrected contract | Implementation state |
| --- | --- | --- |
| Date windows | SQLite comparisons use the same ISO-8601 representation as persisted run timestamps. | validated on final tree |
| Coalesced run copy | Codex/Claude coalesced runs retain their real backend label and never appear scripted merely because the backend is Codex. | validated on final tree |
| Merge feedback | A merge attempt that did not merge returns error-styled feedback even when the mutation itself completed normally. | validated on final tree |
| Toast accessibility | The persistent toast region owns polite live announcements across toast insertion/removal. | validated on final tree |
| Design tokens | Archived/warning UI uses defined yellow tokens. | validated on final tree |
| Mobile focus | SSE revalidation cannot repeatedly steal focus back to the drawer close control. | validated on final tree |
| Secret masking | Short values are never disclosed by the masked suffix presentation. | validated on final tree |
| MCP rename | A transient probe failure preserves the last known tool count. | validated on final tree |
| Workflow edits | Add/remove/reorder preserves an explicitly configured human-only boundary. | validated on final tree |
| GitHub head identity | Server-owned delivery persists a normalized full PR head on create, reuse and redelivery. Degraded reads preserve the last verified head. | implemented; focused GitHub matrix green |
| Review-to-PR handoff | Entering Review stages a durable repository/base/branch/review-revision handoff before `task.md` crosses the transition boundary. Boot promotes it only when that exact task incarnation and Review occurrence committed; a pre-transition orphan is cancelled. | validated on final tree |
| PR-open durability | Before any task-file write adopted from a cached or listed PR, Viberr creates an exact intent; before `POST /pulls`, it journals project, task incarnation, normalized repository, default branch, task branch, full head SHA, title/body and original actor/authority. An ambiguous POST becomes observation/manual-reconciliation only and is never blindly retried, including after empty/error observation; an observed PR is never posted again. | validated on final tree |
| Review fingerprints | Repository review is keyed to the full verified head plus semantic review revision; mutable commit-cache reshaping is ignored once the head is known. | implemented; focused GitHub matrix green |
| Pinned merge | Acceptance snapshots the reviewed head and every merge request carries that exact full SHA. An unpinned merge is impossible. | implemented; focused GitHub matrix green |
| Merge durability | The merge intent is staged before the irreversible GitHub PUT and binds repository, default/base branch, PR number, full reviewed head, task incarnation and original accepter/authority. The final merge callback repeats that complete immutable target. Retry and boot converge local merge/acceptance facts without re-crediting the retrier or merging a replacement task; acceptance-audit lookup is incarnation-scoped. | validated on final tree |
| Head-change recovery | A real replacement head is cached and stale evidence is invalidated once. Same-head 409/transient merge failures and stale callers do not erase a newer valid review. | implemented; focused GitHub matrix green |
| Acceptance invalidation | A same-PR replacement head atomically returns `accepted` to `review` as it clears old verdict/human evidence. Approval of the new head still requires a fresh, separate human acceptance. | validated on final tree |
| GitHub async ownership | PR open, reconcile, delivery and merge own the project lifecycle, carry an abort signal, and verify the exact task incarnation inside every post-network canonical write. | validated on final tree |
| Dispatch ownership | Durable `claiming` reserves capacity before a dispatch owns a run; automatic work never borrows a manual run id. | implemented; focused lifecycle matrix green |
| Dispatch restart | Recovery follows the persisted dispatch/run ownership matrix: an unlaunched claim may be requeued, an owned run is recovered exactly once, and an already-applied terminal effect is only converged. Recovery never blindly repeats an operator action. | validated on final tree |
| Dispatch lifecycle | Dispatches, triggers, leases, runs and completion effects carry the exact task incarnation. Archive/delete revokes new effects, cancels queued work, stops providers, drains acknowledged callbacks, and makes unapplied old effects inert before the canonical project mutation. Recreating the same slug cannot inherit old work. | validated on final tree |
| Dispatch wakeups | Deduplicated enqueue, budget expiry, lease release and freed capacity all wake durable queued work. | implemented; focused lifecycle matrix green |
| Dispatch effect durability | Operator actions are checkpointed as pending, applied or recovery; source-run completion advances only after the durable owner records its effect. A crash resumes the unfinished effect rather than claiming success or executing it twice. | validated on final tree |
| Trigger independence | Ordinary coalesced work and each completion-source reaction occupy independent durable slots. Finishing one source cannot erase another, and a free worker wakes queued work across slots. | validated on final tree |
| Scripted operator crash boundary | Every operator mode persists its run/effect identity before the first governed mutation. A scripted action failure becomes a durable error/recovery boundary; it cannot be narrated as a successful applied run. | validated on final tree |
| Run purpose | Every specialist/reviewer run persists `implementation`, `governance_review` or `conversation`; live completion and boot recovery use that purpose instead of role/prompt inference. | validated on final tree |
| Completion effect phases | Completion reply, delivery, evidence, verdict and operator-reaction phases advance monotonically under a per-project effect registry. A restart resumes the first unapplied phase against persisted context; swallowed partial completion is not treated as success. | validated on final tree |
| Acceptance durability | Human acceptance journals the evidence fingerprint, task incarnation, exact merge target when present, Done stage and original actor/authority before crossing merge or task-file boundaries. Repo-less full-autonomy completion uses the same durable contract with explicit non-human authority. Canonical Done may therefore be converged after a crash without repeating GitHub work or changing attribution. | validated on final tree |
| Locked task incarnation | Every delayed canonical task mutation verifies the expected `createdAt` inside the task-file lock. A pre/post check cannot authorize an old run while a same-key replacement is queued ahead of it. | validated on final tree |
| Reviewer side-effect convergence | A replayed reviewer verdict independently converges its canonical event, audit row and deduplicated watcher notification before the verdict phase advances. | validated on final tree |
| Provider shutdown | Project archive/delete waits for each stopped provider's exit acknowledgement and for its registered completion effects. A failed drain or timeout leaves canonical state unchanged and reopens admission only for the exact unchanged active project; an archived, deleted or replaced lifecycle remains revoked. | implemented; focused lifecycle matrix green |
| Canonical project lifecycle | Mutation admission reads `project.md`, not the rebuildable `projects` row. An archive/restore crash between canonical write and projection therefore cannot admit writes to archived history or permanently deny an active restore. | implemented; focused lifecycle matrix green |
| Lifecycle failure recovery | Archive/delete wrap every post-revocation hook, cancellation, provider wait, effect drain and canonical write in one recovery boundary. Hook failures, timeouts and failed writes cannot strand an unchanged active project with admission disabled. | implemented; focused lifecycle matrix green |
| Reviewer isolation | Reviewers use stable isolated workspaces, authenticated exact-branch fetch, detached checkout, no delivery permission, and an optional expected-head assertion. | implemented; focused completion matrix green |
| Reviewer Q&A | A conversational mention posts a reply but cannot replace or delete a governance verdict. | validated on final tree |
| Reviewer staleness | A late result outside Review or against a different fingerprint/head is retained as history and cannot move the task, alter validation or clear packets. | implemented; focused completion matrix green |
| Reviewer rejection | Request-changes returns active work to implementation but preserves an unrelated human decision packet. It cannot pull a terminal task back from Done. | implemented; focused completion matrix green |
| Rework proof | Stage bouncing and rendered prose are never proof of rework. A real primary implementation completion advances a typed semantic review revision. | implemented; focused completion matrix green |
| Zero-reviewer completion | Current human validation is recorded separately from acceptance and is invalidated by any evidence/reviewer change. | implemented; focused completion matrix green |
| Recovery occurrence | Recovery dedupes only the same run/attempt occurrence; a later failure with the same error code opens a fresh durable incident. | implemented; focused completion matrix green |
| Recovery replay convergence | A crash after the canonical recovery event independently converges projection, audit and deterministic watcher notifications on replay without duplicating the incident. | implemented; focused recovery matrix green |
| Orphan recovery identity | Restart recovery atomically terminalizes the orphan and records its retry marker, then carries the run's exact task incarnation into the system packet. A crash cannot lose the incident, and a deleted/recreated task with the same key cannot inherit the old blocker. | implemented; focused recovery matrix green |
| Operator launch failure lease | A synchronous launch failure releases its task lease in a `finally` even when writing the recovery packet also fails, so a successor cannot be permanently coalesced behind a dead launch. | implemented; focused operator matrix green |
| Resumed confinement | Resumed mentions reapply stage eligibility, Codex capability compatibility, denylist, MCP set, persona and task-scoped Git ceiling. | validated on final tree |
| Repo-less conversation | A real conversation without a repository receives an isolated task workspace instead of a repository-preflight blocker. | validated on final tree |
| Workspace identity | Workspace paths derive from the full normalized repository identity plus a digest, so repositories sharing a basename cannot reuse each other's checkout. | implemented; focused completion matrix green |
| Routing truth | `selected` is persisted only after direct action succeeds; supervised mode persists `recommended` only after the recommendation exists. | validated on final tree |
| Routing identity | Every intelligent routing choice receives one durable intent id. The exact id flows through primary/reviewer assignment or recommendation, timeline rationale and launched run `sourceIntentId`; a pending request rebuilds current eligibility/resource/backend/workload/cost context and cancels on drift before retry. Boot runs routing recovery again after orphan-run recovery so an ambiguous reserved run is terminalized before the intent is decided. A human fallback resumes its existing binding without fabricating a later routing decision. | validated on final tree |
| Lifecycle intent durability | Archive and restore journal the exact lifecycle edge, project identity, teardown counts and original actor/authority before `project.md` changes. A canonical intent marker lets boot converge projection and one deterministic audit fact; an uncommitted row is cancelled rather than guessed. | validated on final tree |
| Archived recovery fence | Boot rebuilds the in-memory revocation fence from canonical archived `project.md` files before PR, merge, acceptance or task-effect recovery. Retained intents remain deferred across archive with zero GitHub or task mutation until an explicit restore reopens admission. | validated on final tree |
| Ownership-cleanup durability | Member removal or role demotion is access-first and two-phase: exact owner-seat intents are staged while access is unchanged; the authorized role/member write commits the matching batch marker atomically; only then are task owners released. Pre-commit actor revocation or target conflict leaves access/seats/audits untouched and marker-less intents cancel. Retry/boot converges exact timeline, projection and deterministic audit facts while refusing a newer owner or replacement task. | validated on final tree |
| Commit-boundary authority | Role, transition-boundary, run, acceptance, merge and other governed paths reload the current enabled user and current project/org authority at their actual canonical or irreversible commit boundary. Audit records the authority used there, including visible organization-admin override authority. | validated on final tree |
| Delivery occurrence identity | Server-owned delivery timeline/audit provenance uses a structured source id containing the complete delivered SHA; merge and delivery facts include task incarnation so same-key task recreation is a distinct occurrence. | validated on final tree |
| Activity authority copy | Org-admin override disclosure is inserted without corrupting the task chip or trailing prose. | implemented; focused projection tests green |
| Browser origin | Compose defaults Better Auth to `localhost`, matching the normal browser/OAuth origin. | validated by fresh Docker/browser gate |
| Scope revalidation ownership | Grant/re-check owns the project lifecycle, aborts probes on revocation, snapshots each violation's task incarnation before network I/O, and refuses to write an old policy event to a replacement task. | implemented; focused scope matrix green |
| Viewer timezone | Resource and Policy relative/day labels render using the viewer timezone on server and client. | implemented; focused UI tests green |
| Live logs | Loader reseeding cannot discard a newer local/SSE suffix or strand a pending fetch target. | implemented; focused hook tests green |
| KB aliases | Legacy KB id/name/folder aliases canonicalize to one removable folder reference; only genuinely unknown legacy values survive. | implemented; focused UI tests green |
| Merge-pending movement | Manual stage movement is rejected while completion is accepted and awaiting merge. | implemented; focused completion matrix green |
| Shared authorization | Project UI permission checks consume the canonical RBAC action matrix, including effective org-admin override authority. | implemented; typecheck green |
| Shared adapters | Command execution, PR-state pills/mapping and workspace-key sanitization use shared helpers instead of divergent copies. | validated on final tree |
| Loader efficiency | Health integrity checks are briefly cached, routing builds primary/reviewer context from one fact pass, and org settings scans project dependencies once. | implemented; focused tests green |
| Operator status | Server status precedence is expressed as a named resolver rather than an eight-branch nested expression. | implemented; focused UI tests green |

## Evidence boundary

The same final tree completed the complete Vitest suite, typecheck, production
build, whitespace check, fresh Docker Compose boot, health/API checks,
Playwright, signed-in browser walkthrough, screenshots and log review. Real
provider and credentialed GitHub success remain explicitly outside the live
claim; the fresh organization honestly had no MCP server or GitHub connection.

## Final remediation gate

- Vitest: 158 files/1,565 tests in 30.25 seconds; typecheck/build/whitespace clean; independent
  recovery verification 197/197.
- Playwright: 19/19 in 22.1 seconds.
- Fresh Docker: 3 projects/12 tasks; rescan 0 changed/15 unchanged/0 removed/0 errors in 3 ms;
  health/integrity OK; watcher active; 0 application warnings/errors.
- Signed-in browser: critical project/organization routes passed, 12 new screenshots captured, and
  0 console warnings/errors.
- Publication: implementation commit `0c8c758` was pushed to existing draft PR #23; GitHub Actions
  `verify` passed in 5m51s (run 29258036588).
