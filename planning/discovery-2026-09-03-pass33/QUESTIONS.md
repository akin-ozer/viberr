# Pass 33 — questions for the owner

Each question states the background (what I found, why it matters) before the ask, so the
decision can be made without re-deriving it.

## Q33-1 — should a *merged* historical PR still gate delivery behind a human decision?

**Background.** Ruling 34/35 make a name-matched PR a collision that blocks delivery, and
ruling 50 keeps that gate human "against clobbering unrelated remote history". Pass 17
(F17-L4) then split the refusal reason `not_open` into `merged` and `closed` because "the
two carry opposite delivery hazards and must not share one sentence": a merged stranger
PR's tip is already an ancestor of the base, so a fresh delivery fast-forwards; a
closed-unmerged one carries commits that are not on the base. The **sentences** were split;
the **behaviour** was not — both still stop delivery and open a packet.

Live on VIB-1 this cost a whole operator turn and a human decision, and the delivery it
blocked then succeeded on the first press with no remediation (PR #270). Because task keys
restart at 1 on a new data root — the situation ruling 34 names — this fires on every task
whose key was ever used before.

**The ask.** Should a `merged` refusal deliver anyway and record a typed note naming the
historical PR (keeping the human gate for `closed`, `head_mismatch`, `head_unknown`,
`no_revision`)? Or is the uniform stop deliberate, and the defect only that the operator's
packet and the note overstate the hazard?

## Q33-2 — should force-accept be offered on a task that has never had any work?

**Background.** Ruling 59 (R19-5) deliberately keeps force-accept visible off-boundary — "a
pre-work wedge must be escapable; there is no off-boundary hiding" — and the label names
the skip. The consequence is that an org admin sees "Force accept (skips the remaining
stages and the review gate)" in the GitHub card of *every* non-terminal task, including a
task created 10 seconds ago with no branch, no PR, no revision and no run, directly above
"No branch yet". The Current-state panel underneath simultaneously says "Not acceptable
yet … Move the task through the workflow first."

**The ask.** Keep it as ruled (a wedge can happen at triage too), or withdraw it until the
task has *something* — a run, a branch, or an engagement — so it reads as an escape hatch
rather than a standing offer?

## Q33-3 — disabled controls on the Policy page vs "withdrawn, not disabled"

**Background.** Ruling 65 settled that a role which cannot act on a thing should not be
shown its controls: the credential card is *withdrawn* for a viewer, and ruling 37's
precedent is quoted — "a withdrawn affordance is honest, a disabled one invites a support
question." The Policy page does the opposite: a viewer sees every member's four role
buttons and all five guardrail controls, rendered `disabled`. The page's other job — being
the readable explanation of the policy, rendered from the same `rbac.ts` the guards use —
argues for showing the state.

**The ask.** Leave it (the disabled radio is how the current role is displayed), or render
a read-only value for roles that cannot edit, keeping buttons only for those who can?

## Q33-4 — may force-accept override the archive?

**Background.** Force-accept is ruled (59 / R19-5) as the escape hatch that "may skip the
remaining stages AND the review gate — but it must SAY so", and the ruling enumerates the
two things it may never bypass: ruling 37's closed-PR fact and ruling 20's PR-head
containment. The archived-task gate is not in that list, and `force` skips the shared
refusal helper that contains it, so an admin can force an archived task to Done. I did:
SBX-1 is now `stage: done` + `archived: true` + `acceptance: forced`, visible only under the
archived filter as "Done · archived". The dialog disclosed the bypass by name.

Everywhere else archive is terminal: a stage move on an archived task is a 409, and the
task-lifecycle doc says "an archived task cannot be moved".

**The ask.** Three options: (a) make archive irreducible for force too (restore first — the
dialog already tells you to); (b) keep the bypass but have it RESTORE the task as part of
accepting, so no task is ever both archived and Done; (c) leave it, and record it as a
ruling so the next pass does not re-file it.

## Q33-5 — coordination overhead is 69% of spend; is that the intended ratio?

**Background.** Two small single-file tasks produced 16 operator runs against 2 delivering
runs and 2 reviewer runs. Insights reports **coordination overhead 69%** — operator and
controller runs spent $2.27 of $3.30. Per task: VIB-1 = 7 operator runs ($0.78) vs one
Developer run ($0.28) and one Reviewer run ($0.25); VIB-2 = 9 operator runs ($1.49) vs
$0.21 + $0.29. Ruling R29-1 already settled that "operator proactivity is intended (no
throttle on the multi-run cascade)", so this is not drift — but it was ruled before
Insights could measure it, and the measurement is now unflattering: the coordinator costs
2-3x the work it coordinates.

**The ask.** Is 2-3x the accepted price of the governance model, or is there a cheaper
operator turn worth designing (e.g. a single re-triage instead of one run per transition,
or a cheaper model for the pure-bookkeeping triggers)? I can measure the split by trigger
kind if that helps the call.

---

# Owner answers (2026-09-03, batch 1)

| # | question | answer |
|---|---|---|
| Q33-1 | merged-PR branch collision | **New design, not one of the offered options:** *"if branch previously exists, viberr creates a new one with a unique suffix"* — Viberr allocates a unique task branch name instead of colliding. |
| Q33-4 | force-accept vs archive | **Make archive irreducible** — force-accept refuses an archived task the way it refuses a closed PR. |
| Q33-5 | 69% coordination overhead | **Accept it as the price.** R29-1 stands; no throttling work. |
| Q33-2 | force-accept on a pre-work task | **Withhold until there is work** — show it only once the task has a run, a branch or an engagement. |

## What Q33-1's answer means for the build

The collision stops being a decision the human resolves and becomes a name Viberr picks.
Consequences to design (a sharp follow-up is queued in Q33-6):

- Branch allocation becomes a real step instead of a pure function of the key. The
  `task.md` `branch:` field already wins over `taskBranchName(key)` at every reader
  (`pr-open.server.ts:390`, `push-workspace.server.ts:324`, `branch-sync.server.ts:274`),
  so the allocated name has a home already.
- It also answers F33-5: "give this task a different branch" stops being advice with no
  affordance, because the product does it itself.
- The collision packet and `resolve_remote_collision` do not disappear — they still cover
  the genuinely unowned-PR case — but the common path stops reaching them.

# Owner answers (2026-09-03, batch 2)

| # | question | answer |
|---|---|---|
| Q33-6 | what makes a branch name "taken" | **A live ref OR any past PR** on that name (open, closed or merged). |
| Q33-7 | when to allocate, and the suffix shape | **At first branch creation**, suffix is a **short hash** (`vib-1-a3f9`). |
| Q33-3 | Policy page disabled controls | **Read-only values, no dead buttons** — buttons only for roles that can act. |
| D33-1 | the missing ruling 117 | **Record the gap as intentional** — an entry at 117 saying the number was skipped and never used. |
