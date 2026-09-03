# Pass 33 — findings ledger

Ids: `F33-*` defect · `U33-*` UX/coherence · `D33-*` doc/canon · `G33-*` gap ·
`Q33-*` question for the owner. Status: `open` → `confirmed` / `refuted` → `fixed`.

| id | area | severity | status | one line |
|---|---|---|---|---|
| F33-1 | delivery / github | high | **fixed** (ruling 122) | A **merged** historical PR on a task-key branch raises a "branch name collision" that stops the operator and demands a human decision — but the delivery it says is blocked succeeds on the first try. |
| F33-2 | packets | medium | **fixed** | The packet decision event states the remedy's effect in the PAST TENSE before the effect is attempted; when the effect refuses, the canonical timeline holds a false claim followed by its own correction. |
| F33-3 | packets / github | medium | **fixed** | A collision packet is not withdrawn when a later delivery makes it moot; its confirm dialog then calls the task's OWN live branch "the unrelated one squatting on this task's branch name" and offers to delete it. |
| F33-4 | packets / operator | medium | **fixed** | A `resolve_remote_collision` that REFUSES leaves the task `waiting: human` with no packet and no recommendation — ruling 110's "never strands" guarantee only covers the arm where the re-delivery happens. |
| F33-6 | acceptance | high | **fixed** (ruling 123) | **Force-accept bypasses the archived-task gate**: an admin can force an ARCHIVED task straight to Done, producing `archived: true` + `stage: done` + `acceptance: forced` — a state the rest of the product says is impossible ("an archived task cannot be moved"). |
| F33-8 | controller toolkit | high | **fixed** | Every resource grant made through the controller is **dangling**: `save_global_agent` stores the ids its own list tools return, while the runtime matches skills by folder name, MCP by registry name and KBs by dir. The tool reports success and the roster counts the grants. |
| F33-7 | controller toolkit | high | **fixed** | `save_global_agent` is a FULL REPLACE whose `skills`/`mcps`/`kbs` are optional and default to `[]`, and no read tool exposes them — so a partial update through chat silently erases a template's grants. |
| F33-10 | engagements | high | **fixed** | `release-agent` works on a **terminal** task: removing the required-reviewer engagement from a Done + merged task re-derived `validation` from `healthy` to `changed`, rewriting the review history of work that was already accepted and merged. |
| F33-9 | mentions / RBAC | high | **fixed** | Mentioning a NON-MEMBER routes them a notification naming the project, the task key and the comment text — for a project they then 404 on. The picker offers every registered user and the fan-out has no membership filter. |
| U33-10 | policy page | low | **fixed** | A two-word agent profile name overlapped its capability counts: `.pcap-counts` was `flex: none`, so the ruling-109 "advisory on Codex" badge squeezed the name box to ZERO width and the text painted over the numbers. |
| R33-1 | task detail | — | **refuted** | "The Comment button never posts." My selector `button:has-text("Comment")` matched the *Comments* filter tab. `button:text-is("Comment")` posts correctly. |
| F33-5 | packets / copy | medium | **fixed** (ruling 122 removes the clause and the need) | The collision note tells the human to "give this task a different branch", and both operator packets built an option for it — Viberr has NO in-app way to set a task's branch name. |
| U33-4 | policy page | low | **fixed** (ruling 125) | The Policy page renders member-role buttons, guardrail toggles and the profile link DISABLED for viewers/contributors, against the product's own "withdrawn, not disabled" rulings (37, 65). |
| U33-5 | agents page | low | **fixed** | Clicking a roster profile and immediately pressing "Edit profile" can open the editor for the PREVIOUSLY selected profile; a save then writes to the wrong agent. |
| U33-6 | dialogs | low | **fixed** | The shared `ConfirmDialog` carries no `data-screen-label`, so a whole family of confirms (stage removal, schedule cancel, resource + credential + user deletion, project delete) is unaddressable — while `docs/ui/surfaces.md §4` says every dialog has one. |
| U33-7 | agents | low | **fixed** | KB grants render by **display name** in the global template editor and the controller settings, but by **directory** in the project profile editor — one concept, two vocabularies. |
| U33-8 | controller page | low | **fixed** | The full controller page opens a blank composer on plain navigation while the dock reopens the newest thread of the scope (ruling 121), so the same person gets two different continuity rules. |
| D33-2 | docs | low | **fixed** | `docs/ui/surfaces.md §4` claims every dialog carries `data-screen-label`; `ConfirmDialog`, `capability-matrix-modal` and `create-profile-modal` do not, and no test can fail for it. |
| D33-3 | docs / a11y | low | **fixed** | `InsightsPage` is the only full-page surface with no `data-screen-label`, and `Insights` is absent from the §4 label list. |
| U33-9 | project settings | low | **fixed** | Project name and task prefix commit on blur with no save affordance and no confirmation; I renamed the project by accident while reaching for another control. |
| U33-1 | task detail | low | **fixed** | Timeline empty state claims "this task hasn't started its operator loop" while the live-run strip on the same page shows the operator preparing. |
| U33-2 | onboarding | medium | **fixed** | A project bound to a repository that does not exist says so ONLY on its GitHub page — board, home card and rail are silent; the creation warning is a transient toast. |
| U33-3 | org settings | low | **fixed** | Store browser destination reads "/ (store root)" although the browser only ever opens a KB or skill folder; files land in the resource folder, the label lies. |
| D33-1 | canon | low | **fixed** (ruling 117 records the gap) | Ruling **117 does not exist** — `decisions.md` jumps 116 → 118 and nothing in the tree cites 117. |

## D33-1 — the ruling numbering skips 117

`docs/architecture/decisions.md` runs 1..116, then the "Owner decisions recorded outside
this file" section, then resumes at 118. `grep -rn 'ruling 117' app/ docs/ planning/`
returns nothing, so no code comment is dangling — but ruling numbers are declared stable
and never reused, and a hole means either a ruling was drafted and lost, or the pass-32
promotion mis-numbered. Needs an owner answer: was there a 117?

## U33-1 — the timeline empty state contradicts the live-run strip

`app/features/task-detail/timeline.tsx:575` prints "No activity yet. This task hasn't
started its operator loop." whenever `events.length === 0`. On a freshly created task the
operator IS running (`Preparing workspace · Cloning akin-ozer/viberr · 13%`), rendered by
the Live-run strip ~400px above. Ruling 87(b) exists precisely so a healthy pre-run phase
is distinguishable from a wedged one; this copy undoes half of that on the same page.
Seen live on VIB-1 (screenshot `17-task-vib1-operator-running.png`).
Fix: when a run is live, say the loop has started and its first events are coming.

## U33-2 — a project pointing at a repository that does not exist looks fine everywhere but one page

Creating a project pre-fills the repository name from the project name
(`new-project-modal.tsx:494`, a deliberate autocomplete). Typing "Sandbox" and not touching
the repo field produced `akin-ozer/sandbox`, which does not exist. Creation SUCCEEDED. The
`repoWarning` toast fires once (`new-project-modal.tsx:541`) and then the fact has no home:
the board, the home project card and the workspace rail say nothing, and only
`/projects/sandbox/github` shows a `repo not found` chip. Every agent run in that project
will fail its clone. Fix: a persistent signal where the work happens (board banner or rail
badge) for a project whose repository probe is failing.

## U33-3 — "store root" is never the store root

`app/features/kb-browser/store-browser.tsx:178` hardcodes `<option value="">/ (store
root)</option>`. `StoreBrowser` is mounted only from
`app/features/org-settings/resources-panel.tsx:290,300` — a knowledge-base folder or a
skill folder — and `app/server/org/resources.server.ts:2200` resolves the target as
"(kb dir / skill folder)". The write itself is correct (my `conventions.md` landed in
`kb/pass33-handbook/`), so this is copy only: the option should name the resource root.

## F33-1 — the merged-PR collision blocks a delivery that works

**What happened, live, on VIB-1 (the very first task of a fresh data root).** The
Developer committed `qa/pass33/CONVENTIONS.md` on `vib-1`. The workspace reconcile
raised `github.unownedPr: 265` and the policy engine wrote the branch-collision note;
the operator then opened a decision packet whose body says the collision "would block a
clean push/PR" and stopped. I pressed **Deliver branch & open PR** with the packet still
open: it pushed and opened **PR #270** on the first attempt, no conflict, no remediation
(`github.pr.opened {prNumber: 270, created: true}` → `github.delivery.manual {status:
"delivered"}`, 21:56:13Z). The collision note was re-emitted 3 seconds *before* that
successful delivery.

**Why it happens.** Two code paths ask GitHub different questions about the same branch:

| path | query | sees a merged PR? |
|---|---|---|
| `openTaskPr` → `prAlreadyOnHead` (`app/server/github/pr-open.server.ts:~400`) | `state: "open"` | no |
| `reconcileWorkspaceDelivery` → `findPrForBranch` (`app/server/github/pr-linker.server.ts:386`) | `state: "all"`, newest first | yes |

So the *reconcile* finds PR #265 (merged, head `vib-1`, from an earlier data root),
applies the adoption rule, gets refusal `merged`, and records a collision — while the
*delivery* path it is protecting cannot even see that PR.

**Why the refusal is wrong for `merged` specifically.** `refusalCause("merged")`
(`pr-adoption.server.ts:83`) says it itself: "that PR is already merged and its work is
on the base branch, so a fresh delivery fast-forwards cleanly". Pass 17 (F17-L4, recorded
under ruling 35) split `not_open` into `merged` and `closed` precisely because "the two
carry opposite delivery hazards and must not share one sentence" — the **sentences** were
split, the **consequence** was not: both still block delivery and demand a human packet.
Ruling 50's rationale for the human gate is "not clobbering unrelated remote history";
a merged PR has no unrelated history to clobber.

**Why it matters more than it looks.** Ruling 34 names this exact situation as the normal
one: "keys restart at 1 on a new data root". A re-created store against a repo with any
delivery history hits a human gate on every task whose key was used before, for a PR that
cannot conflict. It also cost a full operator turn and a human decision here, on task #1.

Additional premise error in the note: it asserts "This happens when a task key is reused …
**while the old branch still exists on GitHub**". `vib-1` did not exist on the origin
before this run — `ensureTaskBranch` created it from `main` 35 seconds earlier
(`github.branch.created {from: "main"}`, 21:52:24Z). Nothing stale existed.

**Suggested shape (owner call — see QUESTIONS.md Q33-1):** a `merged` refusal proceeds
with delivery and records a typed note naming the historical PR; `closed`,
`head_mismatch`, `head_unknown` and `no_revision` keep the human gate.

## F33-2 — a decision event claims the effect before the effect is attempted

`app/server/tasks/task-actions.server.ts:6509` writes, unconditionally:

> **Decision:** Clear stale branch/PR #265 and re-deliver VIB-1's commit. The stale remote
> branch is removed and this task's local work is re-delivered.

The comment two lines above says so plainly: "the GitHub work and the re-delivery run
AFTER the resolution write, below." When the GitHub work refuses, the canonical timeline
ends up holding both, one millisecond apart:

```
21:58:24.802Z · note · system:policy-engine
  The branch collision was **not** cleared: PR #270 is still open on `vib-1` … Nothing was re-delivered.
21:58:24.793Z · transition · user:… (Arda)
  **Decision:** … The stale remote branch is removed and this task's local work is re-delivered.
```

The refusal itself is *correct and well designed* — ruling 110's delete-first ordering
protected the live PR, and it said so clearly. Only the past-tense claim above it is
wrong. Same shape at `:6480` for `discard_branch` ("The task's local workspace branch is
discarded."), which can also refuse. Fix: state the decision, not its outcome, and let the
outcome note carry the result.

## F33-3 — a moot collision packet still offers to delete the task's own live branch

After PR #270 opened, `github.unownedPr` was still `265` and the packet stayed open.
The confirm dialog (`Packet collision dialog`) then read:

> DELETES — The stale branch `vib-1` on GitHub, **the unrelated one squatting on this
> task's branch name**, and closes its pull request #265.

`vib-1` was by then the task's own branch carrying its own commit and its own open PR
#270. `performDelivery` withdraws a stale *push-conflict* packet
(`docs/domain/task-lifecycle.md §10`) but not a collision packet, and nothing re-checks
`unownedPr` against the now-linked PR. The delete guard saved it, so this is a near-miss
rather than data loss — but the human was shown a destructive, confidently-worded offer
about the wrong branch. Fix: a delivery that links a PR on the branch clears `unownedPr`
and withdraws the collision packet, the same way it withdraws a push-conflict packet.

## F33-4 — the refusing arm of the collision remedy strands the task

Ruling 110 closes with "**And it never strands**": the re-delivery the remedy owns
re-queues a full-autonomy operator, and under supervised autonomy records the
server-attributed "Move to <review>" card, "exactly the one an operator-authorized
delivery would have written (R18-2 / R19-4 left that half owned by nobody; live on VIB-1
the task sat at In Progress, `waiting: human`, with an open PR and nothing to click)."

That guarantee is attached to the re-delivery. When the remedy **refuses** — the safe path,
the one ruling 110's delete-first ordering exists to produce — no re-delivery runs, so no
card is recorded. VIB-1 landed in the exact state the ruling quotes:

```
stage: impl        readiness: ready     waiting: human
recommendations: []   (no ## Packet section)   pr: 270 (open)
```

The Current-state panel still points somewhere ("Not acceptable yet … Move the task through
the workflow first"), so it is not a total dead end — but the app's own model of what waits
for a human is empty while it says a human is waiting. Fix: the refusal arm records the
same follow-up it records on success (or flips `waiting` off the human).

## F33-5 — the product tells the human to do something it cannot do

`app/server/github/pr-adoption.server.ts:118` ends the shared collision sentence with:

> … or give this **task a different branch**, before delivering.

There is no in-app path to that. A task's branch is `fm.branch ?? taskBranchName(key)`
(`pr-open.server.ts:390`, `push-workspace.server.ts:324`); nothing writes `fm.branch`
except delivery, `set-task-metadata` covers priority/labels/due date only, and no intent
or control names a branch. The only way is to hand-edit `task.md`.

Because the note is the operator's evidence, both collision packets built an option out of
it — VIB-1: "Assign a different branch name to this task"; VIB-2: "Rename this task's
branch instead". A human who picks it gets a `custom` resolution that re-queues the
operator to do something impossible. This is ruling 85's failure mode from the other side:
ruling 85 required a packet to name the product's OWN remedy instead of workarounds; here
the server's own sentence supplies a workaround that is not a remedy at all.

Fix: either drop the clause, or make the branch name settable (a task-metadata field), and
say which.

## U33-4 — disabled where the product's rulings say withdrawn

Signed in as `vera@viberr.dev` (viewer) the Policy page renders all 16 member-role buttons
`disabled`, all five guardrail controls `disabled`, and the "Manage profiles" link. Ruling
65 (R19-11) settled the principle for exactly this shape — "the card is **withdrawn, not
disabled** (ruling 37's precedent — a withdrawn affordance is honest, a disabled one
invites a support question)" — and applied it to the credential card, which this same
viewer correctly does NOT see. The Policy page is the product's read-only explanation of
policy, so showing the *state* is right; showing four dead buttons per member and five
dead toggles is the pattern the rulings reject. Worth an owner call (Q33-3).

## U33-5 — the profile editor can open the previously selected agent

On `/projects/:slug/agents`, clicking a roster entry and then "Edit profile" without a
pause opened the editor for the profile that was selected before (the default, Operator).
I saved from it and the grant landed on the **operator** — verified in `project.md`
(`operator.resources.skills` gained `developer-expertise`), then reverted by hand. With a
deliberate wait between the two clicks the correct profile opens every time, so this is a
render-timing race, not a wrong binding. It is low-probability for a human but the failure
is silent and lands on governance data.

## F33-6 — force-accept can accept an archived task

**Proven live on SBX-1.** Archived the task, pressed **Force accept** (the task page offers
it on an archived task), confirmed. Result:

```
stage: done      archived: true     waiting: none     acceptance: forced
audit  task.acceptance.forced {"bypassed":"SBX-1 is archived. Restore it before accepting the completion."}
```

**Why it gets through.** `acceptCompletion` runs every gate through ONE shared helper, and
its own comment names them: "graph position, required reviewers, the R15-1 verdict gate,
blocked packet, closed/conflicting PR, **archived task** — comes from ONE shared helper …
`force` is the audited admin override" (`task-actions.server.ts:8148-8153`). `force` skips
that whole helper; the only thing it still honours is `forceIrreducibleRefusal`, which
covers the closed PR and nothing else. `forceAcceptCompletion` adds no archived check, and
`resolveAcceptanceAffordance` returns `terminallyBlocked: false` for an archived task, so
the button renders.

**Why it matters.** Every other path treats archive as terminal: `transitionStage` refuses
an archived task with a 409 (`docs/domain/task-lifecycle.md §5` step 2), and §12 states
"An archived task cannot be moved." Ruling 59 enumerates what force may NOT bypass — the
ruling-37 terminal GitHub fact and ruling 20's PR-head containment — and says nothing about
archive. The result is a task that is archived AND accepted at once: it is absent from the
board and from the review queue, and appears only under the archived filter, reading
"Done · archived". On a task WITH an open PR the same path would run the real merge.

The disclosure is exemplary — the dialog printed "BYPASSING: SBX-1 is archived. Restore it
before accepting the completion." — so the question is whether the bypass should exist at
all (Q33-4), not whether it is hidden.

## F33-7 — `save_global_agent` is a blind full replace

`app/server/controller/controller-toolkit.server.ts:596`: `skills`, `mcps`, `kbs` and
`persona` are optional; the handler passes `args.skills ?? []` (and `?? []` for the other
two) into `saveGlobalAgentProfile`, which merges `{...existing.resources, ...resources}` —
and since all three keys are always present, the merge overwrites all three with empty
arrays. Its sibling `update_agent_deployment` documents the opposite in its own
description: *"Merge semantics: only the fields you pass change."*

`list_global_agents` (`:574`) returns `{id, name, backend, summary, stages,
usedByProjects}` — no persona, no resources. So the model has no read that shows what a
partial write is about to erase.

**Corroborated by the controller itself.** Asked to change only the Docs Writer summary and
"leave everything else exactly as it is", it refused and explained the defect in its own
words: *"unlike `update_agent_deployment` (which explicitly says 'only the fields you pass
change'), it carries no such merge guarantee. `list_global_agents` also doesn't expose the
template's persona text or its knowledge-base/MCP/skill grants, so I have no read anywhere
that shows me what's currently in those fields … I'd rather check than guess on something
that could quietly erase the template's persona."* A less careful turn would have wiped it.
(`persona` itself is safe — `persona || existing.description` keeps a blank one, P13-AP-02.
The three resource lists are not.)

Fix: give `save_global_agent` merge semantics (omitted list = unchanged), and have
`list_global_agents` return the current grants.

## F33-8 — grants made through the controller never load

Asked to create a template granted `developer-expertise`, `pass33-probe` and
`pass33-handbook`, the controller reported all three granted. What landed in
`agents/profiles/docs-writer.md`:

```yaml
resources:
  skills: [disk:developer-expertise]
  mcps:   [mcp_IIWTf6kB6cdd]
  kb:     [kb_ilN51XiiPkJA]
```

Those are the **ids** the controller's own read tools hand back (`list_skills` →
`{id, name}`, `list_mcp_servers` → `{id, name, …}`, `list_knowledge_bases` →
`{id, name, dir}`), and `saveGlobalAgentProfile` (`app/server/org/gagents.server.ts:239`)
stores whatever it is given verbatim. The runtime keys off something else entirely:

| resource | what the runtime matches | what the controller stored |
|---|---|---|
| skill | the `skills/<slug>` folder name (`mountGrantedSkills`) | `disk:developer-expertise` |
| MCP | the registry **name** — `byName.get(name)`, unmatched is dropped as "no MCP server by that name in the org registry" (`specialist-mcp.server.ts`) | `mcp_IIWTf6kB6cdd` |
| KB | the **directory** (glossary: "Grants reference the directory, never the display name") | `kb_ilN51XiiPkJA` |

The template editor proves it end-to-end: opening Docs Writer renders the three real chips
OFF and three extra dangling chips ON — `disk:developer-expertise [ON]`,
`mcp_IIWTf6kB6cdd [ON]`, `kb_ilN51XiiPkJA [ON]` — the `MissingChips` shape ruling 106 added
for grants the store lost. Meanwhile the roster row reads "**3 context resources**" and the
controller told the user all three were granted. A run would mount none of them.

Fix: the three params take store-facing keys (skill folder, MCP name, KB dir) and say so in
the tool description; the server normalizes an id it recognises rather than storing it; and
the list tools lead with the key the grant field wants.

The `Docs Writer` template is left in the store deliberately as the fixture to verify the
fix against.

## F33-9 — a mention reaches across the members-only boundary

**Live.** As Arda (admin) I commented on `sandbox/SBX-3` mentioning `@Elif Maintainer`, who
is a member of *Viberr* but **not** of *Sandbox*. Elif's inbox now shows:

> Arda · mentioned you — "@Elif Maintainer can you look at this sandbox probe?" **Sandbox · SBX-3**

Opening it: **"Page not found — No project at projects/sandbox."**

Two failures in one row:

1. **A dead-end notification.** The product routed a person to a task it then refuses to
   show them. Nothing in the inbox says why.
2. **It crosses ruling 25.** Members-only is not just "may you open it": the layout loader
   and every action return the same 404 bytes for a non-member and an unknown slug so that
   "a probe cannot learn a project exists" — a sentence the controller guards repeat
   verbatim. This notification tells a non-member that a project named Sandbox exists, that
   it has a task SBX-3, and what someone wrote on it.

**Why it happens.** `getMentionables` (`app/server/tasks/mention-suggestions.server.ts:146`)
lists "project members first (in membership order), **then any remaining registered,
non-disabled app users**", so the picker offered Elif inside a project she cannot see. The
fan-out resolves against `enabledUsers(db)` — `SELECT id, email, name FROM users WHERE
disabled = 0` (`mention-notify.server.ts`) — with no membership filter at all, so the
notification is created.

Fix: scope both the picker and the fan-out to project members (the same set the guards
use), and make a mention that resolves to a non-member a visible non-delivery for the
author, the way `ambiguousMentionNote` already handles an ambiguous handle.

## R33-1 — refuted: "the Comment button never posts"

Recorded because the class matters more than the finding. I watched two independent
automation stacks click "Comment" with no POST, and had the code open at
`send()`'s `if (!text || busy) return`. The cause was my selector:
`button:has-text("Comment")` substring-matches the **Comments** filter tab, which sits
earlier in the DOM. `button:text-is("Comment")` posts every time. The app's own e2e spec
carries the warning I needed — `e2e/05-task-comment-composer.spec.ts:47`: *"exact: the
'Comments' filter tab also matches a bare 'Comment' name."* Ruling 54's class, from the
tooling side: read the existing test before believing a UI observation.

## F33-10 — a closed task's reviewer seat can still be released, and it rewrites the record

**Live on VIB-2** (stage `done`, PR #272 merged, accepted with `validation: healthy` and an
approving verdict bound to `65b7470c`). The Execution-profile panel disables every other
runtime control on a closed task — the run controls read "Task closed. Reopen it to run an
agent" and the when-picker is `disabled` — but the supporting engagement still carries an
enabled ✕ titled *"Release this agent from the task"*. One click, no confirm, no refusal:

```
engagements: developer(delivers) + reviewer(verdictCapable)   →   developer only
validation:  healthy                                          →   changed
```

The verdict row itself survives in `verdicts[]`, so the history is not deleted — it is
**disconnected**. `deriveValidation` reads the required-reviewer set out of `engagements`,
so dropping the seat means the task no longer has a required reviewer, and a merged task
now renders as never-validated on the hero, the board card and the review queue, while its
own timeline and audit still say it was accepted with a healthy verdict.

`removeReviewer` (`app/server/tasks/specialist-run.server.ts:1015`) checks
`requireRuntimeRole` and nothing else — no terminal-stage gate, no archived gate. The
validation re-derivation inside it is deliberate and correct for an open task (UX19-3: the
opposite bug was a stale `healthy` cache), which is exactly why the missing gate bites.

Ruling 118 froze the **owner** seat on a closed task on the reasoning that "the owner's
authority … has nothing left to act on". The engagement seat deserves the freeze more: the
owner seat has no derived consequences, and this one is the input to `validation`.

(Restored by hand on the store so the pass's fixtures stay honest.)

## U33-6 / D33-2 — the shared confirm dialog is unaddressable

`app/ui/confirm-dialog.tsx` renders `<dialog role="alertdialog" aria-label={title}>` with no
`data-screen-label`. It backs at least seven confirms (project settings ×2, org-settings
`mini-modal`, the schedule cancel and reviewer release in `execution-profile.tsx`, two in
`task-detail-page.tsx`). `docs/ui/surfaces.md §4` states the contract as universal — "Every
top-level surface and dialog carries `data-screen-label` so tests and agents can address it
by name" — and lists nine dialogs, none of them these. `capability-matrix-modal.tsx` and
`create-profile-modal.tsx` are unlabelled too.

Accessibility is fine (`alertdialog` + `aria-label`), so this is an addressability and
docs-honesty gap, not an a11y one. It cost me real time twice this pass: a `ConfirmDialog`
is invisible to a screen-label sweep, so both the stage removal and the schedule cancel
looked like buttons that did nothing.

## U33-7 — two vocabularies for one grant

The project profile editor lists KB chips by **directory** (`pass33-handbook`); the global
template editor and the Controller settings tab list them by **display name**
(`pass33 handbook`). Ruling 106 fixed the controller tab to display names "stored by dir",
and ruling 113 unified capability-mode wording on the same grounds — the project editor was
not brought along. A reader comparing the two editors cannot tell whether they are looking
at one thing or two.

## U33-8 — the page and the dock disagree about which thread to open

Ruling 121 gave the dock a continuity rule: "the dock opens on the newest thread of the
current scope". Navigating to `/controller` opens a blank composer with the threads listed
in a side rail instead. Both are defensible alone; together they mean the same person, on
the same scope, gets a different answer depending on which entry point they used.

## U33-9 — governed identity fields save on blur

`settings-page.tsx:168,182,196` wire `onBlur={saveIfDirty}` to the project name, the task
prefix and the description. There is no Save control and no confirmation. I renamed the
project to "QA Gate" by typing into what I thought was the stage field and then clicking
elsewhere — the rename persisted immediately and silently. The task prefix is the more
consequential of the two: it is the identity every future task key and branch name is built
from. Contrast the app's own posture everywhere else ("no optimistic UI for governed
state", a confirm on every consequential act).
