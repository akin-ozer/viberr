# Pass 38 — what held up under live probing

Each entry: the claim, how it was probed on the live instance, and what was observed.

## A held task refuses dispatch at every door (rulings 186 / 240) — HELD

- **Task page, before the click (03:18Z):** BNB-2 (held by `goal-1 link 3`) shows the Run
  control disabled and, beneath it, the server's own sentence: "BNB-2 waits on goal-1 link 3
  and Viberr is holding it, so running an agent on it is refused. Viberr releases it when
  every entry is done; to release it sooner, change what it waits on."
- **Controller door (03:20Z):** asked in a fresh project conversation to start the BNB Backend
  Engineer on BNB-2 without touching its dependencies, the controller answered "No run
  started. The server answered, verbatim: > [error] BNB-2 waits on goal-1 link 3 and Viberr
  is holding it, so running an agent on it is refused…" — the same sentence, and no run row,
  no audit row and no packet were written.
- **Code (lens-1 sweep):** all 10 `startAgentRun` callers and all 3 `performDelivery` callers
  land on the gate; recovery re-invokes only the operator, whose dispatch is gated.

## The acceptance gate names the missing verdict (ruling 178) — HELD

At Verify with the code reviewer's approval on the current revision and the integration
verifier still running, the task page said: "Not acceptable yet. Waiting on 1 required
reviewer approval of the current revision." Once the verifier approved, the control became
"Accept completion → Done", and the dialog named the PR, the revision (`b130929b9800`), the
verdict state and the base refresh before the merge.

## The delivery pipeline, end to end — HELD

BNB-1: the operator bootstrapped the empty repository with an initial commit, cut `bnb-1`,
dispatched the infrastructure engineer, pushed its four commits and opened PR #1 with the
task's contract as the body; the required code reviewer requested changes on a real defect
(a false premise in the ADR, verified by running the registry gate); the rework was delivered
as revision `b130929`; the reviewer approved; Verify engaged the integration verifier; it
approved from a cold clone; I accepted; Viberr merged PR #1 (`4e63a07`), deleted the branch,
minted goal-1 link 2 as BNB-9, released it and dispatched its operator — 71 minutes end to end.

## Ruling 348, live on the new build (03:17Z)

The operator drive on BNB-9 showed `composing · mcp__viberr__read_board · {} answered` while it
thought after the call — the finished tool no longer reads as current.

## The run-inputs disclosure (rulings 339–346) — HELD

The verifier's run (`run_KjC5xWnv3w05`) recorded `denied: git checkout -b/-B, git switch
-c/-C, git push, git commit, gh pr create, gh pr merge`, a six-tool viberr toolkit, one skill,
three knowledge bases and no MCP servers; the deliverer's recorded only `gh pr merge` denied
(the push is fenced by the credential-less workspace, as the prompt says). Both match the
grants the controller set.

## The bell (lens-2 C7) — HELD

Bell "40 unread", popover header "40 unread" (03:00Z).

## Ruling 350, live (05:05Z)

The acceptance of BNB-9 interrupted a live operator drive (`reason: task-closed, cause:
accept`). On the deployed build the Agent-logs footer for that run reads "interrupted by
Arda; the thread can be resumed where the task still takes a run" — a closed task takes
none, and the old sentence would have promised "the thread stays resumable".

## Rejection 1 and its recovery — HELD (04:27Z → 05:03Z)

Closing PR #2 on GitHub with both approvals standing: the next 5-minute reconcile recorded the
closure, the policy engine wrote the divergence note, the operator was woken and opened a
three-option recovery packet naming the head, the verdicts, the acceptance refusal and the
absence of unreviewed drift; the acceptance control read "Acceptance is closed … Rework and
reopen the PR, or archive the task"; the rework, steered by my note, was delivered as a
fresh PR #3 (the closed PR was never resurrected); the verifier re-approved first (at Verify),
the operator moved the task back to Review for the code reviewer's verdict on the new
revision, then to Verify with the acceptance recommendation; the merge went through. Nothing
was lost and no door was closed without a named way out.

## Reviewed-revision drift (rulings 132 / 179) — HELD, on every surface (05:45Z → 05:52Z)

One README commit pushed to `bnb-10` through the GitHub API, 36 seconds after the second
approval landed on `e17ecac`:

- **Record:** `workRevision.kind: external`, head `3f492ec`, validation `changed`; policy-engine
  note "Revision moved after review (ruling 179): PR #4's head is now `3f492ec`, 1 authored
  commit since review merges unreviewed. The verdict on `e17ecac` no longer binds…".
- **Task page:** the Commits card lists the commit apart under "ALSO ON THE BRANCH · NOT THIS
  TASK'S"; the acceptance gate reads "Not acceptable yet. Waiting on 2 required reviewer
  approvals of the current revision."; the earlier acceptance offer (filed at 05:46:29 for
  `e17ecac`, 43 seconds after the push and before any reconcile) stands withdrawn.
- **Operator:** woken by the reconcile, it corrected its own open packet's stale sentence in a
  comment ("both required reviewers approved `e17ecac`" — "That was true when I wrote it"),
  observed that the workspace and its cached `origin/bnb-10` both sit at `e17ecac` so the
  commit "was not authored in this workspace on this timeline", refused to recommend
  acceptance, and sent the Integration Verifier back to judge the head and report who authored
  the commit.
- **Timing:** the reconcile is a 5-minute tick; between the push and the tick the page read
  "Checked 2m ago" and offered acceptance for the reviewed head — the acceptance ceremony
  re-reads the head before merging, so the window is a stale read, not a hole.

## Enforcement scans over every run on the instance (lens 1, 08:10Z)

- **Denied tools are denied.** 937 runs disclose a `tools.denied` list in their `run·inputs`
  line; across their 26,839 tool calls, 0 called a denied tool without the call being refused.
- **Non-delivering runs never push.** 527 runs disclose `delivers: false`; across their logs,
  0 real `git push` / `gh pr create` / `gh pr merge` commands were issued (dry-runs excluded).
  The claim has never been tested by an agent on this instance; the credential-less workspace
  remains the fence (L1-#17's disposition stands).

## Ruling 357 live (08:20Z, BNB-14)

The operator drive `run_qZ8FzLBZvkuC` (12 turns) refreshed the branch, delivered PR #10,
moved Design → Build → Review and engaged the code reviewer; it ended at 08:20:25.517 and the
lease release logged "drive delivered and kept going — no follow-up operator turn owed". No
second operator run started (the only live run is the reviewer's). Before the ruling, every
one of the board's 13 deliveries had been followed within 0.1 s by a two-turn no-op drive.

## Ruling 358 live (08:42Z, BNB-16)

BNB-14's acceptance minted goal-2 link 4 as BNB-16 at 08:42:45.723; the mint's own release
check cleared its wait ("goal-2 link 3, goal-1 link 4") at 08:42:45.849 and the operator
started at 08:42:48. No "operator run refused — the task waits on other work" line in the
app log this time; BNB-14, minted the same way at 07:54:45, had waited 57 s for the minute
tick with its `create` drive refused.
