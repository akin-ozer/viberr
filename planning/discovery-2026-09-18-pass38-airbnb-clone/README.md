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


## Summary (living)

**What stood up.** Viberr's controller planned the Airbnb clone (8 goals, 30 tasks, 6 profiles)
in one turn and its operator drove every task through design, build, review and verify with its
own deliveries, PRs, verdicts and acceptance ceremonies. Merged so far: PRs #1, #3, #4, #6, #7, #8,
#9, #10, #11 (BNB-1, 9, 10, 2, 11, 12, 13, 14, 15); goal-1 (Foundation) complete; the contracts
(goal-2) at link 4 with two decision-created amendments (BNB-15 merged, BNB-17 in review); the
gateway (BNB-16) building. Rejection 1 (PR #2), rejection 2 (PR #5, mid-review) and the drift on
PR #4 were exercised for real and recovered through Viberr's own packets and fresh PRs.

**What broke in Viberr, fixed one by one** (rulings 347–361, each with a red-proven test; see
FINDINGS.md): the tool manifest's names (347), the live step (348), queued-vs-working (349), the
Agent-logs footer (350), the controller guide (351), stage colours (352), the lease gate's
baseline (353), holds at two packet arms (354), the hold refusal on a dead entry (355) and on a
done entry (356), the operator's self-triggered no-op drive after its own delivery (357), the
minute a minted link waited on the task that minted it (358), the Controller page's link waits
(359), the check-runs read GitHub refuses on this token — 89 merges past a dialog silent about red
CI (360) — and the inbox naming the Operator as the author of 816 things it never did (361).

**Method.** Two background code sweeps (enforcement claims; one fact on several surfaces) for the
first nine; then watching the live board through `audit_events`, `agent_runs`, `run_log_lines`
and `notifications` for the rest, measuring every candidate on the instance before believing it
and writing down what killed the ones that died (CANDIDATES.md). Live proofs of the shipped
rulings are in VERIFIED.md.

**Open, for the owner** (saved for the end, as asked): see the questions at the bottom.

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
| 05:57 | The verifier re-judged the moved head `3f492ec`: **request_changes, scope only** — the commit is authored outside Viberr (it printed the author and time), touches README.md, which BNB-10 does not own, and it corrected the operator's own note (in its checkout `origin/bnb-10` already stood at `3f492ec`). Meanwhile I confirmed the operator's follow-up packet: BNB-11 "Reconcile packages/http ctx.caller with the frozen forwarded-identity contract" was created and BNB-3 now waits on it |
| 06:01 | The architect reverted the external note forward-only (`git checkout aaf010c -- README.md`, new head `ae4cd55`; `3f492ec` stays in history) and corrected the operator's directive: "My workspace was already at `3f492ec` when this run started — Viberr fast-forwarded it before invocation" (the operator's sentence was true at 05:52 and stale by 05:59). Viberr delivered `ae4cd55` to PR #4; re-review begins |
| 06:06–06:14 | both reviewers re-approved `ae4cd55`; the operator recommended acceptance |
| 06:16 | **BNB-10 accepted by me**: PR #4 merged after the full drift cycle (external commit → verdicts voided → reverted forward-only → re-approved) |
| 06:15 | BNB-10 merged → BNB-2 released, BNB-11 released, goal-1 link 4 minted as BNB-12; three operator drives at once. BNB-12's operator held it at Triage with a scope packet: the done signal says `make up` starts a `gateway` placeholder that exists nowhere and belongs to no task (rule 2). I chose its recommended option: widen BNB-12 to ship a health-only gateway placeholder |
| 06:34 | PR #5 opened for BNB-11 (`3244837`); Review; code reviewer engaged. BNB-12's edit-goal decision opened the goal editor with the operator's widened draft (3,868 chars, naming `services/gateway/**`); I saved it |
| 06:35 | **Rejection 2**, mid-review this time: I closed PR #5 on GitHub while the code reviewer was still judging it, with the reason as a PR comment |
| 06:40 | Rejection 2 recorded: the reconcile saw PR #5 closed while the code reviewer was still judging it; the operator's recovery packet said so exactly ("no reviewer verdict was ever recorded on this revision (the BNB Code Reviewer run was still in flight when the PR closed)") and recommended rework; at 06:41 the reviewer approved `3244837` anyway, and at 06:42 the operator corrected its own packet in a comment ("That was true when I wrote it and is no longer true"). I chose rework with my reason as the note |
| 06:52 | First run parked behind the concurrency cap: BNB-2's reviewer queued at 06:52:07 while BNB-2's own operator drive still streamed, so its card read "agent working" — true, an agent of the task was streaming (ruling 349 turns the card to "agent queued" only when no run of the task streams); the queue drained in under a minute when that drive ended |
| 06:54 | BNB-2's rework approved by the code reviewer; Verify |
| 07:02 | BNB-11's rework (ctx.caller removed, per my note) delivered as a **fresh PR #7**; PR #5 stays closed |
| 07:05 | **BNB-2 accepted by me** (contracts: identity and listings; PR #6 merged, revision `8065fba`); goal-2 link 2 minted next |
| 07:04 | goal-2 link 2 minted as BNB-13 (contracts: booking, availability, payments); its architect started at once — three specialists live (BNB-11, BNB-12, BNB-13) |
| 07:09 | BNB-11's fresh PR #7 approved by the code reviewer; Verify next |
| 07:16 | PR #8 opened for BNB-12 (the local stack: supervisor, manifests, make targets, plus the health-only gateway placeholder I widened it to); Review |
| 07:19 | BNB-11's PR #7 approved by the integration verifier too — acceptable |
| 07:22 | **BNB-11 accepted by me**: PR #7 merged (the second rejected task, recovered through a fresh PR); BNB-3 (identity accounts) released by it |
| 07:34 | BNB-12 approved by the integration verifier; acceptance recommended. BNB-13's operator refreshed its branch from main (11 commits) and delivered **PR #9** (contracts: booking, availability, payments); Review, code reviewer engaged |
| 07:37 | **BNB-12 accepted by me**: the acceptance-time base refresh brought `bnb-12` up to date (11 commits, merge `e9205ae`), the reconcile saw it synced, PR #8 merged; **goal-1 (Foundation) complete**, 4 of 4 links |
| 07:38 | F38-10 found on BNB-3's page (the hold sentence naming done entries as waited on, beside the rail marking them done) → ruling 356, red-proven on three layers; deploy waits for a quiet moment |
| 07:41 | BNB-13's PR #9 approved by the code reviewer; the operator refreshed `bnb-13` from main mid-review (7 commits, merge `0cb7bff`; the reviewed revision stays `a1752c4` on every surface, and the verifier named its report after the refreshed head); Verify; integration verifier engaged |
| 07:47 | BNB-13 approved by the integration verifier; acceptance recommended for `a1752c4`. The board is quiet (everything else held), so I hold the acceptance while ruling 357 lands and deploys |
| 07:55 | F38-11: every operator delivery on this board was followed by a paid no-op operator drive (its own `delivered` trigger queued behind its own lease; 330 such drives instance-wide) → ruling 357, four canaries red |
| 07:53 | rulings 356–357 deployed (`a722d4342ff7`, verified by the deploy script) in the quiet window before BNB-13's acceptance |
| 07:54 | **BNB-13 accepted by me**: the dialog disclosed revision `a1752c4`, merge head `0cb7bff` ("base refreshed · 1 merge commit · 7 base commits · 0 authored commits since review"); the acceptance-time refresh was `already_current`; PR #9 merged (`46c1e15`); goal-2 link 3 minted as BNB-14 (contracts: messaging, reviews, two-sided rules) |
| 07:55 | BNB-14 was born waiting on goal-2 link 2 (BNB-13, done in the ceremony that minted it); its `create` drive was refused and the minute tick released it 57 s later → F38-12, ruling 358 (release at the mint), canary red |
| 08:05 | F38-13: the Controller page's link rows still printed declared waits raw beside done pills → ruling 359 (the list read resolves the states; the row prints 356's sentence), two canaries red |
| 08:19 | PR #10 opened for BNB-14 (contracts: messaging, reviews, two-sided rules; head `e9577e2`) by the operator's own delivery, then Design → Build → Review in the same drive — the first delivery under ruling 357: no follow-up no-op drive is expected when this drive ends |
| 08:20 | **Ruling 357 held live**: BNB-14's delivering drive ended with "drive delivered and kept going — no follow-up operator turn owed" and no second operator run started (every earlier delivery had been followed by one); code reviewer running on PR #10 |
| 08:26 | BNB-14's PR #10 approved by the code reviewer (validation healthy); the operator reacts (Verify next) |
| 08:35 | BNB-14 approved by the integration verifier; acceptance recommended; then the operator withdrew the offer for an input packet ("Two notes the contracts freeze would otherwise swallow — route them now?": a listings rating projection gap and a `publishedAt` reading), recommending a contract-amendment task |
| 08:38 | rulings 358–359 deployed (`bad66ba67728`, verified) in the quiet window while BNB-14 waited on the packet; the unfinished ruling-360 edits were stashed for the build |
| 08:39 | I chose the packet's recommended option: **BNB-15** "Contract amendment: the listing rating projection in search results" created under my authority; BNB-14's Accept offer stands again |
| 08:40 | F38-14: every merged PR on this board had failing GitHub check-runs (the clone's `ci.yml` under the account's Actions billing block) and no Viberr surface said so — the project token cannot read check-runs (403), the reconciler swallowed the refusal, and "never read" rendered as nothing on the PR card, the accept dialog and the GitHub page → ruling 360 (the refusal is a fact: persisted, flagged as `checks:read` on the credential, printed as "checks not readable" with GitHub's reason), eight canaries red |
| 08:42 | **BNB-14 accepted by me**: PR #10 merged (`4bbbd90`); BNB-15 released (it waited on BNB-14); goal-2 link 4 minted as **BNB-16** ("The gateway: the only public entry") and — **ruling 358 held live** — released 126 ms after its creation in the same ceremony (before the ruling, BNB-14 had waited 57 s for the tick with its `create` drive refused); both operators started at once |
| 08:55 | PR #11 opened for BNB-15 (the contract amendment) by the operator's own delivery; Review next. BNB-16 (the gateway) still building |
| 08:57 | F38-15: the inbox named the Operator as the author of every reviewer verdict and dependency release (816 rows) → ruling 361 (a notice must name its actor; no default author), two canaries red, one test rewritten that required the default |
| 09:01 | BNB-15's PR #11 approved by the code reviewer; Verify next. BNB-16's architect reported; its operator reacts (delivery expected) |
| 09:05 | hermetic e2e re-run on the branch head (rulings 356–361, UI included): **70 passed** in 38.6 s |
| 09:04 | BNB-16: design done, Build handed to the backend engineer; the operator raised an input packet on the architect's behalf (two out-of-scope gaps: no session-introspection contract; the shared HTTP client drops an upstream error's typed details), recommending a contracts amendment task for session introspection with BNB-3 waiting on it |
| 09:06 | I chose BNB-16's packet's recommended option: the session-introspection contracts amendment task is created under my authority (BNB-3 to wait on it); BNB-16's build continues untouched |
| 09:06 | BNB-15's PR #11 approved by the integration verifier too; acceptance recommendation expected. BNB-17 ("Contract amendment: session introspection for the gateway trust edge") created from BNB-16's packet; BNB-3 now also waits on it |
| 09:08 | **BNB-15 accepted by me**: PR #11 merged (the first decision-created amendment task, end to end in 26 minutes) |
| 09:17 | PR #12 opened for BNB-17 (session-introspection contract amendment; the architect designed and wrote it in ten minutes); Review next. BNB-16's backend engineer still building the gateway |
| 09:22 | BNB-17's PR #12 approved by the code reviewer; Verify next |
| 09:30 | BNB-17's PR #12 approved by the integration verifier; acceptance recommended for `1fe1996` (the second decision-created amendment, minted at 09:05, acceptable at 09:30) |
