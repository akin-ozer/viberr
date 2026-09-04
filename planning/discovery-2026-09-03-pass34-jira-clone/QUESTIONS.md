# Pass 34 — owner questions (asked as they arise, with background)

| id | asked | answer |
|---|---|---|
| Q34-1 | 08:05Z — The Claude account connected on the owner's profile (`codex@hepapi.com`, Max 20x) is refused by Anthropic with 403 `oauth_org_not_allowed`; every run bills it (ruling 127). Reconnect another account / paste an API key / enable Claude Code in that org? | **Enable Claude Code in the hepapi org and keep this account.** Done by ~08:50Z; the retry ran. |
| Q34-2 | 09:19Z — Empty repository (F34-4): Viberr pushed `jc-1` (GitHub made it the default branch), the PR failed 422 `base: invalid`, every surface said "GitHub unreachable · fix credentials"; no path creates `main`. How should Viberr handle a repo with no default-branch ref? | **Viberr bootstraps `main` itself**: with no default ref, author an initial commit through the Git Data API, create the default branch from it, then the task branch and the PR as usual; disclose on timeline/audit; honest wording for 422 base-invalid. (→ to be recorded as the next ruling in the fix phase.) |
| Q34-3 | 09:19Z — Unblock the run now: create `main` at the Developer's own root commit `d2e0fb0` via the API and set it default, or the owner does it, or fix Viberr first? | **Observer creates `main` at `d2e0fb0` via the API** (ref move only, no hand-written code), then resolves JC-1's packet so the operator re-delivers. Done 09:21Z. |
| Q34-4 | 09:19Z — Three 08:59Z profile updates audited under plain `arda@viberr.dev` (effort max on Operator/Developer/Reviewer): the owner in the UI? Set effort max on the jc-* deployments via the UI since the toolkit cannot (G34-1)? | **Yes, that was the owner; set effort max on jc-* through the Agents UI** and keep G34-1 filed. |
| Q34-5 | 09:41Z — Stale delivering workspaces (F34-6): cloned once at triage, reused without refresh; agents cannot fetch. Fix shape? | **Refresh on every reuse**: fetch the mirror's heads into `origin/*`; if the checkout is unborn or clean on the default branch, fast-forward it; a diverged task branch keeps `update_branch_from_base`. |
| Q34-6 | 09:41Z — Unblock the four root-commit branches now: hand repair inside docker-data (fetch + rebase --root onto origin/main), fix Viberr now + rebuild, or delete workspaces and let the agents redo the specs? | **Hand repair now**, recorded as a manual unblock; code fix in the fix phase. |
| Q34-7 | 09:45Z — Owner statement (unprompted): after the 5-hour window ran out they switched the connected Claude account; "viberr should be able to offer that in the decision packet". Recorded as a product ask: the quota/auth failure packet should name the person's own remedy (a different account or key on Profile → Agent accounts, with the reset time) rather than the generic "fix the credential / retry on the other backend". Folded into the F34-1 fix plan; confirm wording in the fix phase. | (owner statement, no options asked) |
| Q34-8 | 09:50Z — The owner re-saved the stock Developer/Reviewer/Operator deployments to `opus[1m]` at 09:48Z. Deliberate? What should the rest of the run use? | **Deliberate: keep Opus (1M) for the stock three, fable for the four jc-* agents.** (F34-7: the alias path drops `[1m]`, so those three actually run plain `opus`.) |
| Q34-9 | 10:09Z — Collision and scope-violation paths need fixtures: may the observer push one fixture commit to a task branch to provoke a real branch collision? Scope violation needs a reduced-scope PAT. | **Yes, push the collision fixture; skip the scope violation.** |
| Q34-10 | 10:39Z — GitHub rejected JC-6's push: the connection's classic PAT lacks the `workflow` scope needed to add `.github/workflows/ci.yml`; required scopes are `repo` + `pull_request:write` only; no violation surfaced except the operator's packet (G34-2). Rotate the PAT / ship without CI / leave blocked? | **Ship without CI for now** (redirect the Developer to drop ci.yml); the scope gap stays filed as G34-2 for the fix phase (probe or require `workflow`, or say so at attach time). |

## Q34-11 · Cross-goal dependencies (asked 11:23Z)

Three of five chains stalled behind goal-1 (JC-7, JC-9; goal-3/goal-5 link 2 next). Operators
caught it every time and opened hold packets; each hold is a human decision, nothing watches
the dependency, and a person must re-resolve every held task when the foundation lands.

**Owner: task-level blocked-by, auto-released.** A task names the task(s) or goal link(s) it
waits on (settable by operator, controller, humans); shown on board + task page; the operator
does not nudge it; Viberr re-triggers the operator when the dependency reaches Done;
chain-created tasks inherit dependencies the controller declares on the goal link.
→ ruling 131 (`docs/architecture/decisions.md`), implemented in pass 34 A8–A15.

## Q34-12 · Drift definition after a base refresh (asked 11:23Z)

F34-14: `compare(reviewedSha...head).ahead_by` counts main's own merged commits and the merge
commit as "unreviewed"; the operator's read said no drift.

**Owner: authored commits only.** Drift = commits since the reviewed revision that are not on
the base branch and are not clean merge commits (a conflict-resolving merge counts). Base
refreshes reported separately ("base refreshed · 1 merge commit · 0 authored commits since
review"). Operator read, accept dialog, review queue and completion record share one function.

## Q34-13 · Engaged deliverer at any stage (asked 11:31Z)

F34-16: the conflict packet's recommended option could not execute at Review (deliverer scoped
to Backlog + Design); a human @mention ran the same agent at Review because mention-resumes
skip the stage rule.

**Owner: yes — an engaged deliverer acts at any stage.** Stage eligibility decides which
profiles the operator may ENGAGE at a stage. Once a deliverer owns the branch, the operator, a
human mention and the built-in packets may all prompt it at any stage for rework, conflict
resolution and follow-ups. Reviewers stay stage-scoped. The Agents surface says so.

## Q34-14 · Who may hand delivery to another profile (asked 2026-09-04, fix phase)

F34-16's remaining half: `operatorDispatchAgent` lets an operator switch a task's delivering
agent by itself (ruling 98(a)). Live on JC-6 it used that to substitute the stock Opus Developer
for the fable one, to get around a stage wall that ruling 133 now removes.

**Owner, verbatim:** *"operator is allowed to do agent switching however it wants, human can
already redirect over a chat with operator or agent allocation."*

So ruling 98(a) stands unchanged: no gate, no recommendation card, no new control, and no new
ruling number. `decisions.md` carries a dated confirmation note under 98(a), and the operator
doctrine's sentence about hand-offs is rewritten so it reads as guidance about WHO should build,
never as a prohibition. Regression guard: a test that fails the moment anybody re-gates the
direct hand-off.

## Q34-15 · The `workflow` scope (asked 2026-09-04, fix phase)

G34-2: the delivery token lacks the `workflow` scope, so any push touching
`.github/workflows/**` is rejected; the code promises a scope violation and implements none.

**Owner: optional, disclosed and enforced early (the recommended option).** Keep `workflow`
optional (requiring it would reverse ruling 18 and is unprovable on fine-grained tokens); show a
classic token's granted scopes as an advisory at attach time; refuse before the push, with a
named remedy, when the branch changes a workflow file and the bound token is known to lack it;
classify a rejection GitHub does send as a scope violation instead of a generic push failure.
Recorded as ruling 144, amending ruling 18.
