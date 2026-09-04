# Pass 34 — Viberr builds a Jira clone (2026-09-03) — summary

> Status: OBSERVATION AND PLANNING COMPLETE. The fix phase is a separate, fresh session; this
> PR carries the findings and the plan, and touches no product code. Everything here is verified
> against the files on disk, the projections, the audit log and GitHub; the running log is
> [NOTES.md](NOTES.md), the ledger [FINDINGS.md](FINDINGS.md), the owner's answers
> [QUESTIONS.md](QUESTIONS.md), the fix plan [PLAN.md](PLAN.md).

## What this pass is

The owner asked Viberr to build a real product end to end through its own machinery — the
controller sets up the project, agents, resources and goals; operators and specialists do the
work; every delivery is a real branch and pull request on `akin-ozer/jira-clone` — while a
session observes every surface and files only the findings that make Viberr lie, lose work,
block a path with no way out, or make a person do something absurd.

## How it was run

- Container `viberr-app-1` (`main` @ `2a098e89`) on a fresh data root; the owner connected a
  Claude login and a GitHub connection beforehand and pinned the controller to
  `claude-fable-5[1m]` at max effort; the controller deployed four `jc-*` profiles on
  `claude-fable-5` max and kept the stock operator/developer/reviewer on `opus[1m]` (Q34-8).
- The observer drove ONLY the controller dock and the human surfaces (packets,
  recommendations, acceptance, approvals, comments, mentions, schedules, settings, ownership),
  logged in as the owner (admin), a maintainer, a contributor, a viewer and a non-member. It
  never wrote jira-clone code and pushed nothing to the clone except two owner-approved test
  fixtures (a human PR on a delivered head; a collision fixture). Six owner-approved by-hand
  unblocks were recorded, each a finding: creating `main` on the empty repo (F34-4), refetching
  four stale workspaces (F34-6), and closing PRs #7, #9, #10 and #4 because rework on an open
  PR is never pushed (F34-11).
- Screenshots (`screenshots/`, 140+), light and dark, desktop and mobile, of every surface as
  it changed; a Playwright driver did the seeing, the in-app Browser pane and the driver the
  sending. Read-only projection queries ran INSIDE the container (D34-1).

## What Viberr got right (worth saying, because the fixes below are about the rest)

- Operators read the merged specs before acting and refused to advance contradictory work:
  four scoping packets on the standalone specs, two on chain links whose foundation had not
  landed, one on a product contradiction the spec writer surfaced instead of resolving silently.
- Verdict binding to revisions held every time it was tested: a new authored commit re-gated
  acceptance; a fresh PR from the exact reviewed head accepted cleanly.
- Ruling 127 (per-person credentials) refused an Omar-owned task honestly, notified Omar, and
  the ownership dialog spelled out the consequences before the hand-off.
- The browser capability drove a real Next.js app in the agent container (navigate, snapshot,
  evaluate, console, screenshots into attachments) and the QA tester reported Docker's absence
  instead of faking the DB check.
- "Send back for another attempt" recovered a 22-turn, $4 spec-writer run and a 116-turn QA run
  after the quota killed them.

## Headline findings (ledger in FINDINGS.md)

| id | sev | one line |
|---|---|---|
| F34-11 | high | Rework or a conflict fix on a task with an open PR is never pushed: `deliver_for_review` no-ops on a cached open PR, `update_branch_from_base` reports the LOCAL branch, the reviewer approves an unpushed revision, acceptance refuses with "rebase and re-review", and the operator finally asks a human to push by hand. Three live instances (JC-3, JC-5, JC-6); the pipeline's wall. |
| F34-1 / F34-12 | high | Quota and auth refusals classify as `unknown` although the runtime receives a structured `rate_limit_event`; the generic recovery packet's recommended option asserts "I've updated the policy / credential", which the operator relayed as a credential change and the Developer used to restore the CI workflow the owner had dropped. Twelve runs died in two waves; the banner was posted as an agent comment. |
| F34-14 | high | Drift disclosure counts a base refresh as unreviewed work ("5 commits added since review; they merge unreviewed" for 4 main commits + 1 merge); the operator's read said none; the completion record keeps the false sentence. Ruling Q34-12: authored commits only. |
| F34-16 | high | The built-in conflict packet recommends what the dispatcher refuses when the deliverer is not stage-eligible; a human @mention of the same agent bypasses the same rule; at QA the operator substituted the stock (non-fable) Developer. Ruling Q34-13: an engaged deliverer acts at any stage. |
| F34-4 | high | An empty repository reads as "GitHub was unreachable (network error)" everywhere; nothing creates `main`. Ruling Q34-2: Viberr bootstraps `main`. |
| F34-6 | high | Workspaces are cloned once and reused without refresh; deliverers built on the base as of task creation. Ruling Q34-5: refresh on every reuse. |
| F34-2 | medium | `update_agent_deployment` accepts capability ids that do not exist and answers `[done]`; the QA profile ended up with full delivery grants nobody chose. |
| F34-10 | medium | `resolve_remote_collision` refuses on a cached-open PR and strands the task `blocked · waiting: human` with no packet, no run and no exit but GitHub. |
| F34-13 / F34-15 | medium | An `edit_goal` decision is invisible after a reload (live Confirm, silent 409); the accept card outlives the revision it was written for. |
| F34-5 / F34-7 / F34-8 / F34-9 / F34-3 | medium/low | Agents Live "working" from a flag; `opus[1m]` loses `[1m]`; a schedule into an open packet says "starting"; PR adoption leaves no trace; silent `default_branch_missing`. |
| G34-1..3, U34-1..11, D34-1 | — | Controller gaps (effort, `create_task` owner/due), copy and disclosure defects, the runbook's host-side DB read. |

## Owner rulings taken during the pass (QUESTIONS.md)

Q34-2 Viberr bootstraps `main` on an empty repository · Q34-5 workspaces refresh on every reuse
· Q34-7 the quota/auth packet names the person's own remedy · Q34-8 stock three stay on Opus ·
Q34-10 ship without CI when the token lacks `workflow` · Q34-11 task-level blocked-by,
auto-released · Q34-12 drift = authored commits only · Q34-13 an engaged deliverer acts at any
stage · 16:08Z move to plan + fixes now and resume the build on the fixed Viberr.

## Counts at hand-off (16:35Z)

| | |
|---|---|
| tasks | 16 (JC-1..16); 5 done, 3 held on the foundation (JC-7, JC-9, JC-16), 8 with open PRs |
| pull requests | 20 opened: 5 merged (#1, #2, #6, #11, #17), 7 closed, 8 open |
| goal chains | 5, 26 links; 10 links turned into tasks |
| runs | 261 (191 operator, 39 primary, 23 reviewer, 9 controller); 23 errors, 12 of them the two quota waves |
| spend reported by runs | $339.62 (fable $185.86 over 78 runs, opus[1m] $155.40 over 184 runs) |
| audit rows | 1,843 |
| findings | 16 F + 3 G + 11 U + 1 D |

The jira-clone project stays live in the container; after the fixes are deployed the same
tasks continue as the validation run (JC-6's scaffold QA→Review card, JC-11/JC-13 approved
specs, JC-10/JC-12/JC-15 packets, the held chain links).

## What this PR carries

Findings and plan only, no product code:

| file | what it is |
|---|---|
| [NOTES.md](NOTES.md) | the running timeline of the whole run, in UTC, with every observation and every by-hand unblock |
| [FINDINGS.md](FINDINGS.md) | the ledger: 16 F + 3 G + 11 U + 1 D findings, each with root cause, evidence and fix direction |
| [QUESTIONS.md](QUESTIONS.md) | Q34-1 … Q34-15 with the owner's answers verbatim |
| [TODO.md](TODO.md) | the fix plan: 53 items in three bands, each with root cause at file:line, mechanism, callers swept, tests with canaries and docs; rulings 128 … 144 drafted ready to paste; an order of work |
| [TESTPLAN.md](TESTPLAN.md) | 62 validation steps, unit and live, with an ordering that resolves the live subjects' mutually exclusive states |
| screenshots/ | 137 screenshots, light and dark, desktop and mobile |

Every plan item was written by an architect that read the code, then refuted by an adversarial
critic whose corrections are folded in and marked inline, then checked for coverage against the
ledger. The implementation is deliberately left to a fresh session working from TODO.md.
