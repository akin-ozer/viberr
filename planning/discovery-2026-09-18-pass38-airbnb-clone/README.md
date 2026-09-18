# Pass 38 — Viberr builds an Airbnb clone

2026-09-18. Viberr's own controller was given one goal (`goal-1.md`) in a fresh
instance-scoped conversation and built a short-term-stay marketplace in
`akin-ozer/airbnb-clone` through Viberr's own machinery. I drove the controller, watched
live, rejected pull requests on purpose, let one diverge after review, and fixed what
broke in Viberr. I wrote none of the clone.

Two lenses carried the whole way, because both were unswept:

1. **Does Viberr enforce what it tells agents it is enforcing** — declared path sets,
   don't push, don't open a PR, file leases, held tasks refusing dispatch, withheld
   repo-write, denied tools. Ruling 186 was that shape and it was a HIGH.
2. **One fact, several surfaces: do they agree** — rulings 338 and 346, both found by
   accident last pass.

| file | what it is |
|---|---|
| [`goal-1.md`](goal-1.md) | the goal, verbatim |
| [`FINDINGS.md`](FINDINGS.md) | confirmed findings, each with its measurement, refutation attempt, fix and red-proof |
| [`CANDIDATES.md`](CANDIDATES.md) | every candidate, including the ones that died and what killed them |
| [`LENS1-ENFORCEMENT-SWEEP.md`](LENS1-ENFORCEMENT-SWEEP.md) | the enforcement-claim sweep (agent-written; every claim verified before it became a finding) |
| [`LENS2-SURFACE-AGREEMENT-SWEEP.md`](LENS2-SURFACE-AGREEMENT-SWEEP.md) | the surface-agreement sweep (agent-written; same rule) |

Rulings from **347** in `docs/architecture/decisions.md`. Fixes on
`pass38/airbnb-clone-fixes`.

## Setup the controller built for itself (one turn, unaided)

Project `Airbnb Clone Marketplace` / slug `airbnb-clone-marketplace` / key `BNB`, on
`akin-ozer/airbnb-clone`, policy `balanced`, six stages (Triage, Design, Build, Review,
Verify, Done; `verify → done` human and locked). Three knowledge bases
(`airbnb-clone-architecture`, `-conventions`, `-rulings`), five skills, six agent
templates, all Claude / `opus` / `high` because Codex was out of quota until Sep 19.
Its stack decision, made from the measured host (no docker, no python, no go, no
browser): SQLite through `node:sqlite`, one file per service, Node child processes
supervised by `scripts/stack.mjs` behind `make up`; the booking service owns both
availability and reservations so a hold is one transaction.

## The board, as it ran

| when (UTC) | what |
|---|---|
| 02:02 | goal given; controller turn ran 17 min: project, 3 KBs, 5 skills, 6 profiles, 8 goals, 30 tasks |
| 02:13 | BNB-1 dispatched (infrastructure engineer, Claude opus); the operator bootstrapped the empty repo with an initial commit itself |
| 02:37 | PR #1 opened by Viberr's delivery; Review; code reviewer engaged |
| 02:44 | **request_changes** — a false premise in decision record 0001 (the registry DOES report per-version ages); rule 9 respected (not an environment complaint) |
| 02:50 | rework delivered as revision `b130929`; reviewer approved at 02:53; Verify; integration verifier engaged |

Rejection and divergence plan (the goal asks for both): close two clone PRs on GitHub
without merging once they are in review, and watch the closure record, the recovery packet
and the "no fresh PR until a person answers" rule (ruling 160); after a reviewer approves a
later revision, push one external commit to that PR branch through the GitHub API and watch
ruling 179's "Revision moved after review" disclosure void the verdict and return the task
to the review stage. Neither is clone code: one is a click on GitHub, the other a one-line
README change used as a stimulus.
| 03:11 | integration verifier approved; the operator's react chain had hit its depth cap, so no recommendation was filed (ruling 258 skipped the stuck packet correctly; noted in CANDIDATES) |
| 03:15 | rulings 347–355 deployed (`cd74ec667455`, verified by the deploy script) |
| 03:17 | **BNB-1 accepted by me** in the UI: PR #1 merged by Viberr's acceptance ceremony; the dialog named the revision, the verdicts and the base refresh |
| 03:18 | BNB-9 (goal-1 link 2, shared packages db/http/testing) dispatched; the controller's `run_agent_on_task` on the held BNB-2 was refused with the hold sentence verbatim (VERIFIED.md) |
| 03:43 | PR #2 opened for BNB-9 (`3263230`, 4 commits); Review |
| 03:50 | BNB-9 **request_changes** from the code reviewer: three defects it reproduced on this host, after verifying 89 tests green and path ownership clean; back to Build for rework |
| 04:12 | BNB-9 rework approved by the code reviewer; Verify next. The hermetic e2e suite ran (Playwright's chromium had to be installed on this host): 70 green after one stale locator was fixed (spec 05's @operator comment leaves a timeline note quoting the accept card's title, so spec 06 now targets the heading) |
| 04:27 | **Rejection 1.** With BNB-9 acceptable (both approvals on `5d36862`), I closed PR #2 on GitHub without merging, with the reason as a PR comment. Before the next reconcile the task page still read "PR #2 · in review · Checked 2m ago" and offered acceptance (an honest stale read). At 04:30:21 the 5-minute reconcile saw the close: policy-engine note "Divergence: PR #2 was closed on GitHub without merging, but BNB-9 is still active", operator woken (`pr-diverged`), and at 04:30:47 the operator opened the recovery packet: rework (a note becomes the steer) / archive keeping the branch / archive deleting it, with the PR card reading "closed", the acceptance gate refusing ("was closed on GitHub without merging, so it can't be accepted") and the observation that "nothing on the timeline explains the close as a quality rejection — whoever closed it holds the reason" (true: the reason lives on GitHub as a PR comment, which Viberr does not read). I chose rework with the reason as the note. |
| 04:47 | Recovery: the rework landed as `568e7f5` and Viberr opened a **fresh PR #3** (PR #2 stays closed, never resurrected — ruling 160). The operator, still at Verify, engaged the integration verifier first (approve, validation `changed` because the code reviewer's approval was on the superseded revision), then moved the task back to Review and engaged the code reviewer for the new revision — verdicts bind to revisions (rulings 178/242) and the record said so at every step |
| 05:01 | code reviewer approved PR #3's revision; this time the operator filed the acceptance recommendation itself (the react chain had been reset by the packet resolution) |
| 05:03 | **BNB-9 accepted by me**: PR #3 merged by the ceremony; goal-1 link 3 minted next |
| 05:25 | PR #4 opened for BNB-10 (contract core: primitives, error codes, money, dates; head `e17ecac`, platform architect); Review |
| 05:45 | **Divergence.** With both approvals on BNB-10's `e17ecac`, I pushed one external README commit (`3f492ec`) to `bnb-10` through the GitHub API. At 05:46:29 the operator (unaware) recommended acceptance for `e17ecac`; at 05:47:43 it withdrew that offer for an unrelated follow-up packet it raised on the verifier's behalf. At 05:50:23 the reconcile saw the head move: policy-engine note "Revision moved after review (ruling 179): PR #4's head is now `3f492ec`, 1 authored commit since review merges unreviewed. The verdict on `e17ecac` no longer binds…", `workRevision.kind: external`, validation `changed`, operator woken |
