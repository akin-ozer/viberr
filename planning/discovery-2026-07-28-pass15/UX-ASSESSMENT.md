# Is the UI/UX holistic and coherent? — pass 15 judgment

You asked me to focus on this, and my first pass answered it only by scattering individual defects
across `FINDINGS.md`. This is the synthesized judgment, made by walking every surface of the FIXED
build as an end user and harvesting the actual rendered copy rather than reading components.

**Verdict: yes, it is coherent — unusually so — and the incoherences are specific and nameable.**

## What makes it coherent (the parts worth protecting)

1. **Empty states teach instead of shrugging.** This is the app's strongest habit and it holds
   almost everywhere: "Nothing waits on you. Completion reports land here when a task reaches the
   boundary." · "Not currently engaged on any task. This profile is approved and available for
   assignment." · "None in the store yet — add knowledge bases in org settings." · "No execution
   branches yet — a task-key branch is created when execution starts." Each one says *why it is
   empty* and *what will fill it*. Most products write "No data."

2. **Every count names its scope.** Home, Board and Agents each count "waiting" differently, and
   each says which: "Nothing is waiting on you in any of your projects" · "8 tasks · 0 waiting on a
   human decision **in this project**" · "agent threads waiting on a human · **this project**".
   A prior pass caught three numbers answering three questions and fixed the labels rather than the
   numbers. That discipline held through this pass.

3. **Refusals are rendered copy, not disabled buttons.** The pattern is consistent post-fix:
   "Acceptance is blocked: VIB-11 has delivered work but no review pull request…",
   "Task closed — reopen it to run the operator", "Not acceptable yet. VIB-12 is at Triage, not QA…".
   The app tells you why it said no, in place, where the control would be.

4. **Honesty over reassurance.** "recorded at delivery — no background sync pass yet" ·
   "repo, pull_request:write unproven — verified when attached to a project" · "GitHub is
   unreachable — showing the last-known branch and PR state." The app consistently prefers an
   awkward truth to a comfortable claim. That is a *design voice*, and it is the reason the
   pass-15 defects were findable at all: where the app lied, it stood out.

5. **Two-surface mental model is taught, not assumed.** Policy: "Human access and agent capability
   — two surfaces, managed separately." Org settings: "Instance level — shared by every project…
   Board-level workflow & policy live inside each project." A newcomer can locate a setting from
   the subtitle alone.

## Where coherence breaks (found this pass, all now fixed unless noted)

| break | why it mattered | state |
|---|---|---|
| The **⌘K promise** — topbar said "Search tasks, branches, agents" and filtered one board | the most visible control in the app did not do what it said | fixed (R15-5 palette; the board filter now says "Filter this board…") |
| **Two `h1`s on Agents** — every other surface has exactly one | master-detail page announced itself twice; heading structure inconsistent with the rest of the app | fixed this pass, verified live on the rebuilt image |
| **A disabled control explaining itself only via `title`** | a `title` is unreachable on a disabled element for keyboard and touch — the reason effectively did not exist | fixed: rendered copy, matching the reviewer panel's existing pattern |
| **A refusal naming an escape hatch it does not offer** ("ask an admin to force-accept it" where force-accept is not surfaced) | sends the reader hunting for a button that is not there | fixed, verified live (F15-22) |
| **A confirm dialog promising a merge with nothing to merge** | the dialog adapted its facts but not its footer | fixed (F15-23) |
| **Timestamps in two timezones on one page** (agent logs UTC, timeline local) | the same event appeared to happen 3 hours apart | fixed |
| **Duplicated status badge** on the board card | same state asserted twice | fixed |
| **375px kept the 232px rail** | content squeezed to ~140px; the "same surface reflowed" promise unmet | fixed (off-canvas rail + toggle, 0 horizontal overflow) |
| **Silent 403s** on controls the UI offered | the worst failure mode: an offer the server refuses without saying so | fixed (owner authority widened per R15-3; refusals rendered) |

## Owner decisions (asked 2026-07-29, all answered and implemented)

These were the four design calls this assessment could not make on its own. The owner ruled on
each; every one is implemented, tested and canary-proven on this branch.

| question | ruling | how it landed |
|---|---|---|
| The board's five bare "No tasks" columns — the one empty state that doesn't teach, and the first thing a new user sees. P13-D-34 pinned it deliberately. | **R15-10 — teach only when the whole board is empty, and only once.** | The entry column says "No tasks yet — create one to start the flow" when the project has zero tasks; every other column stays bare, and all of them go bare again the moment one task exists. This *narrows* P13-D-34 instead of reversing it: that ruling guarded against repeating an explanation five times beside real work, which this does not do. |
| The Review queue has no primary action, though deciding is its whole job. | **R15-11 — keep it a triage list; give the rows a named action.** | Rows now read "Review ›" and carry an `aria-label` naming the task. Acceptance stays on the task page, because a decision belongs with its evidence. Deliberately NOT "Accept": acceptance is verdict-gated (R15-1) and can refuse, and a control must not name an outcome its surface cannot promise — the rule F15-22 was filed under. |
| "Viberr settings" (instance) collides with a project named Viberr, while the project's own page is titled bare "Settings". | **R15-13 — scope both titles.** | "Instance settings" and "Viberr · settings". The five wayfinding strings that pointed readers at "Viberr settings → GitHub connections" were updated with it, so no copy names a heading that no longer exists. |
| Advisory capability lines read oddly (a Docs writer listing "Move the task to Review (acts directly)" as advisory). | **R15-12 — collapse them under a labelled group; do not hide them.** | A `<details>` summarised "Advisory only · N lines the runtime does not read", collapsed by default, count always visible. Hiding "unenforced and role-irrelevant" capabilities was the alternative and was rejected: an omission the reader cannot see is worse than an awkward truth — and "role-irrelevant" is a judgment the code should not be making about policy. |

A fifth question lived in `USECASES.md` rather than here — whether a pre-existing project should keep
running delivery at `direct` by absence while a new strict project gets `recommend`. Ruled **R15-9**:
derive the absent grant from the project's own governance, so the answer stops depending on when the
project was created. Both the runtime gate and this panel now read it from one shared function,
because those two disagreeing is exactly what F15-20 was.

## Method note

Judged from rendered copy on the running app (h1/h2 inventory, subtitles, primary actions, empty
states, refusal text per surface) rather than from source, because coherence is a property of what
the user actually reads. Screenshots in `shots/` (111, pre-fix) and `shots/fixes/` (25+, post-fix).
