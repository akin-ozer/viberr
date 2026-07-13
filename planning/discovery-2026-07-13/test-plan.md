# Fresh live test plan

## Test environment

Primary project: Viberr Deep Validation, prefix VDV, repository akin-ozer/viberr, Standard
five-stage workflow, Balanced/Supervised policy. It is created through the product UI in the
Docker Compose deployment.

Secondary projects are allowed only for project-level non-PR probes such as Lightweight workflow,
archive, delete/recreate, and custom-stage graph behavior. All PR-producing work uses the primary
project and the Viberr repository.

Role fixture for the controlled post-fix pass:

- Arda: org admin, deliberately not a project member (emergency-override case).
- Elif: project admin.
- Murat: contributor.
- Selin: viewer.
- Deniz: maintainer for the maintainer tier, then authenticated nonmember where the protected-route
  case needs it. Record each role mutation in the result so the actor context is unambiguous.

Custom agents:

- Docs Writer: Claude, Documentation role, In Progress eligible, conventional-commits skill.
- Test Engineer: Codex, Review eligible, reviewer role.
- API Specialist: Claude, In Progress eligible, api-design skill, API KB, credentialed MCP when
  available.
- Performance Engineer: Codex, In Progress eligible, developer-expertise skill; intentionally
  unsuitable for unrelated documentation/API work so routing rationale can be tested.

## Twenty-four independent task cases

Each task is created in Viberr Deep Validation and carries a distinct purpose. Some cases span
multiple actions, but no task exists merely to inflate the count.

| Task | Case | Primary assertions |
| --- | --- | --- |
| VDV-1 | Supervised full lifecycle with Codex | controlled Triage assessment; no direct transition while input-required; correct primary choice; reviewer; acceptance; honest PR state |
| VDV-2 | Supervised full lifecycle with Claude | explicit implementation intent before specialist start; same lifecycle/records/copy as VDV-1 despite provider differences |
| VDV-3 | Underspecified Triage goal | input_required; no fabricated execution; operator asks for scope rather than advancing |
| VDV-4 | Ownership role matrix | viewer denied; contributor take/release own and task-scoped accept; maintainer cannot release another; project/org admin can; owner copy matches actual authority |
| VDV-5 | Owner/member removal | removing/demoting/deleting current owner cannot leave ghost owner or strand sole admin; explicit resolution path |
| VDV-6 | Primary stage eligibility | impl-only Docs Writer rejected in Ready/review; accepted and runnable only in eligible stage |
| VDV-7 | Reviewer stage eligibility | review-only Test Engineer rejected before Review at assignment and run boundaries |
| VDV-8 | Multiple reviewers and rework round | isolated workspaces; duplicate idempotence; exact non-simulated JSON verdicts; two reviewers; any rejection returns to implementation; new evidence invalidates old verdicts; all current reviewers approve; remove reviewer |
| VDV-9 | Comment and mention routing | plain comment app-wide; contributor/viewer mention recorded but runtime denied; maintainer mention runs exact target; ambiguity handled |
| VDV-10 | Recommendation lifecycle | apply as maintainer; contributor denied; dismiss; stale recommendation clears after manual conflicting action |
| VDV-11 | Packet ownership versus acceptance | contributor owner resolves ordinary packet and accepts that owned task only; non-owner contributor/viewer denied; clear copy |
| VDV-12 | Validation anti-laundering | failing/changed/none all refuse acceptance; only healthy Review may accept; no automatic healthy without evidence |
| VDV-13 | Real merged PR | tiny useful test/marker; authenticated server-owned push; exact remote SHA + non-empty PR; app links; gh squash merge; reconcile/accept to Done only after merged |
| VDV-14 | Rejected/closed PR | tiny marker PR closed unmerged; app reflects closed/rejected and does not call it in review |
| VDV-15 | Open review PR | tiny marker PR observed open; acceptance records accepted/merge-pending and stays Review without fabricated merge; close/delete fixture after capture |
| VDV-16 | Evidence changed after review | new remote commit resets validation/evidence state and is visible after reconcile |
| VDV-17 | Exact skill isolation | declared skill present; unrelated project skills absent; any Claude ambient skill/plugin leak fails closed under D5 |
| VDV-18 | KB injection and budget | correct KB only; canonical task/persona ordering; bounded truncation marker; no unrelated KB |
| VDV-19 | Public MCP | real initialize/tools-list and one tool call; correct per-agent availability; failed probe is honest |
| VDV-20 | Credentialed MCP | encrypted secret ref resolves through D4's explicit header/env mapping; initialize/tools-list works; never logs secret; auth/protocol failure differs from network failure |
| VDV-21 | Codex/Claude confinement parity | Viberr lifecycle parity; withheld capability behavior tested per backend and UI discloses enforcement differences |
| VDV-22 | Interrupt and resume | role-gated interrupt, exact run selected, terminal event/SSE; resumed run retains persona/model/effort/git ceiling/skills/KB/MCP |
| VDV-23 | Run-log burst and phase | duplicate append events do not duplicate seq; real phase/step shown; reconnect/stale state visible |
| VDV-24 | Delivery failure and recovery | invalid credential/checkout/push failure fails fast before model start; durable blocked event, recovery options, notification, human waiting; retry on alternate backend |

## Project-level cases

PJT-1. Create primary project through New project UI and verify canonical project file, base agents,
policy preset, role bindings, repository, and absence of stale/unknown capability IDs.

PJT-2. Create a Lightweight repo-less project; verify review-stage role resolution.

PJT-3. Add/reorder/remove a custom stage and prove the visible order and workflow graph stay atomic.

PJT-4. Create a global specialist profile and deploy that existing profile into the primary project.

PJT-5. Rename/delete referenced KB, skill, and MCP is blocked with exact inline/global consumers; no
silent broken references.

PJT-6. Archive and prove Home treats it as inactive, direct routes stay readable, mutations/runs are
blocked, active runs stop, and Restore is the sole mutation.

PJT-7. Delete/recreate the same secondary slug and prove no credential/run/violation contamination.

PJT-8. Org disable/delete/member removal respects sole-admin and owner invariants.

## Post-review exact-intent recovery matrix

These cases supplement the original 24-task campaign. Fault seams must stop the
operation immediately before and after each named remote/canonical boundary,
then exercise both an explicit retry and boot recovery. Every assertion is
bound to the task's canonical `createdAt` incarnation, not key alone.

REC-1. Repo-less human acceptance crashes after the durable intent and after
the Done task-file write. Recovery preserves the original contributor-owner or
supervisor attribution, produces one terminal timeline/audit occurrence and
does not accept a replacement task.

REC-2. Repo-less full-autonomy operator completion crosses the same boundaries
without borrowing a human identity. Recovery retains
`operator_full_autonomy`, one occurrence and the exact evidence fingerprint.

REC-3. Repository acceptance crashes before/after the pinned merge PUT and
after GitHub reports the exact PR/head merged but before local convergence.
Recovery performs no second PUT, preserves the original accepter/authority and
moves only the exact accepted incarnation to Done.

REC-4. PR opening crashes before POST, after an ambiguous POST, and after the
exact PR is observed but before task-file projection/audit convergence.
Before an attempt, recovery may search the exact normalized
repo/base/branch/full-head target. Once an intent reaches ambiguous `posting`,
retry/boot is observation or manual reconciliation only: empty or failed
observation never authorizes another POST, and a wrong base, head or task
incarnation is never reused.

REC-5. Direct and supervised intelligent routing cover primary and reviewer
assignment/prompt paths. Assignment or recommendation, rationale timeline,
audit and run must share one exact `sourceIntentId`; boot cannot use a later
unrelated run as proof, and human fallback resumes an existing binding without
creating a routing decision.

REC-6. Archive and restore crash before and after `project.md` carries the
exact lifecycle marker, and after the file commit but before projection/audit.
Boot cancels uncommitted rows, converges marker-backed rows once with original
actor/authority, and handles a same-state retry idempotently.

REC-7. Member removal and contributor demotion stage exact owner seats while
access is unchanged, then crash before/after the atomic role/member change plus
batch marker, and before/after owner release. Pre-commit actor revocation or
target conflict leaves access, seats and audits unchanged. Retry/boot converges
one cleanup occurrence for each exact task incarnation and refuses to clear a
newer owner or recreated task.

REC-8. Project deletion purges completion, merge, PR-open, routing, lifecycle
and ownership-cleanup intents in addition to earlier project-keyed operational
state. Recreating the slug/key cannot inherit any old work or attribution.

REC-9. Disable/delete/demote the initiating user, change task ownership, and
remove project/org authority between admission and each canonical/irreversible
boundary. The action must stop when the current grant no longer permits it;
successful org-admin emergency actions must audit `org_admin_override`, while
successful contributor acceptance must audit `task_owner`.

REC-10. Deliver two full SHAs sharing a short prefix and recreate a same-key
task that references the same PR/head. Provenance and merge/acceptance audit
must distinguish task incarnation and full SHA while a retry of the identical
intent remains exact-once.

## Cross-role/browser cases

RB-1. Every ACTION_ROLES action through all four project roles; UI affordances and server results
must agree.

RB-2. Deniz sees board/task/comment only and does not see links to protected project surfaces; direct
protected routes are 403 without leaking project details.

RB-3. Home/settings/profile/review personalized counts and copy are correct for each role and owner.

RB-4. Org admin behavior follows D2 consistently in UI, route loaders, actions, and SSE.

ROUTE-1. For tasks with several eligible specialists, inspect the candidate context delivered to the
operator: stage/capability eligibility, declared skills/KB/MCPs, backend health, active/recent
workload, and cost signal. The operator's choice and explanation must be persisted/auditable.

ROUTE-2. Create input-required and ready tasks singly and in a burst. Verify the documented trigger
policy, bounded concurrency/cost, trigger provenance, and that Triage never advances or starts a
specialist until readiness and recommendation authority are resolved.

## Authentication, feedback, and navigation

UX-1. Local login success/failure/disabled/rate-limit/forced reset.

UX-2. OAuth configured/unconfigured and whitelist rejection inline flash if providers can be tested.

UX-3. Profile and Notifications direct-link hydration/close/return path in a browser timezone that
differs from Docker.

UX-4. All success/error toasts, optimistic mutations, navigation pending, SSE reconnect/stale.

UX-5. Desktop, tablet, and phone project shell; keyboard/touch alternative for board reorder.

UX-6. Agents Profiles/Live/profile state survives link, reload, back, and forward.

## GitHub outcome matrix

- At least one tiny PR merged with gh squash.
- At least one tiny PR closed unmerged.
- At least one tiny PR is observed open for review-state validation, then may be closed/deleted as
  fixture cleanup.
- All PRs use VDV task-key branches/commits and task backlinks.
- Remote head SHA and non-empty diff are verified before the app may report delivery complete.
- No accepted PR bloats the product; only useful test additions or small test-support markers merge.

## Evidence rules

For each case record:

1. Action actor and role.
2. UI result and screenshot when visual state matters.
3. HTTP/action status and returned error for negative cases.
4. Canonical project/task markdown delta.
5. Projection, audit, notification, run, and log rows where applicable.
6. Provider init envelope for confinement/resource claims.
7. Remote Git branch/commit/PR state for delivery cases.
8. Post-restart behavior for lease/recovery/persistence cases.
9. Operator trigger provenance, candidate comparison/rationale, and checkout preflight result.
10. Exact intent id, task incarnation, sourceIntentId, original actor and authority for every
    cross-boundary recovery case.
11. Remote call counts (especially PR POST and merge PUT) plus deterministic timeline/audit ids
    before and after retry/boot.
