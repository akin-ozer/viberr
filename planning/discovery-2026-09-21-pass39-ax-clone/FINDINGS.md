# Pass 39 findings — ax clone (2026-09-21)

Severity: **HIGH** = viberr lies, loses work, or blocks a path with no way out ·
**MED** = makes a person or an agent do something absurd · **LOW** = noted, not worked.

---

## F39-1 · MED · The host toolchain inventory is a fixed, npm-shaped list — nothing can probe for anything else

**What happened.** The instance had no Go toolchain at all (`/resources/health` →
`"go": null`) on a pass whose gates are `gofmt`, `go vet`, `golangci-lint`, `go test`.
The owner authorised installing Go into the image for this pass (Dockerfile layer,
deliberately untracked), so the pass could proceed.

**The finding is the second half.** `Toolchain` (`app/server/ops/toolchain.server.ts`) is a
FIXED struct — node, npm, git, python3, go, make, docker, pnpm, yarn, curl, codexCli,
claudeAgentSdk. Ruling 191 added five names after pass 37 logged 75 `command not found`
lines, but the *shape* did not change: the list is hardcoded and npm-centric. There is no
way for the controller — or anyone — to ask "is `golangci-lint` on PATH?" without spending a
whole delivery task on it.

**Evidence.** The controller, briefed with the four Go gates, read `instance_health` first
(good), then wrote into its own project KB:

> | **golangci-lint** | **NOT preinstalled** (see section 3) |
> … Task AX-1 establishes the truth empirically and records the result here.

golangci-lint *is* installed on this host. The controller could not know that, so it
budgeted a task to discover it and wrote a wrong fact into the KB that every run on the
project then reads. It behaved correctly given what it could see; the surface was the
problem.

**Proposed fix.** `viberr_ops` gains a bounded command-presence probe (e.g.
`instance_health({ probe: ["golangci-lint", "goimports"] })`, ≤8 names, `[A-Za-z0-9._-]+`
only, no shell, `command -v` + `--version`, 5s each, memoized per name per process), and the
controller guide tells it to probe before promising a gate.

---

## F39-2 · LOW · The Claude model picker offers no plain `opus`, only `opus[1m]`

Live catalog on this account: `default`, `opus[1m]`, `claude-fable-5-1[1m]`, `sonnet`,
`haiku`. The curated fallback (`model-catalog.server.ts`) lists plain `opus`/`sonnet`/`haiku`.
So which Opus you can pick depends on whether the live `supportedModels()` fetch succeeded,
and the two lists disagree about whether a 200k-context Opus is selectable. Noted, not
blocking: `opus[1m]` was set for the controller and runs.

---

## F39-3 · MED · A knowledge-base document has to fit in one JSON string argument, and a big one fails as malformed JSON

`save_knowledge_base` takes the whole document body as one inline JSON string. On this pass
the controller's second KB doc (7356 bytes of markdown containing Go snippets and tables)
came back:

```
InputValidationError: mcp__viberr_controller__save_knowledge_base was called with input that
could not be parsed as JSON.
You sent (first 200 of 7356 bytes): {"id": "kb_HZpcYS3sovrJ", "name": "ax-clone-rulings", …
Common causes: unescaped backslashes in file paths (use / or \\), unescaped control
characters, or truncated output.
```

The controller recovered (it said so in the transcript: *"The KB write was malformed on my
side (truncated JSON) — retrying it smaller"*) and the second attempt landed. So nothing was
lost — but the retry re-emitted several thousand output tokens, and the same shape governs
every `save_skill`, `save_global_agent` persona and KB doc. The bigger and more useful the
document, the likelier the write fails.

**Proposed fix.** Give the doc writers an append mode: `save_knowledge_base` /
`save_skill` accept `doc.append: true` (or a `section` argument) so a long document is
written in two or three bounded calls instead of one large one, and say so in the tool
description. Cheap, no schema migration, removes a whole failure class.

---

## F39-4 · HIGH · `get_project` shows advisory persona text as a granted authority — and the setter then refuses to change it

**The lie.** `UNIFIED_CAP_CATALOG` (`app/shared/capabilities.ts:145-155`) has two kinds of
row. Rows with a `group` are real: a runtime consumer enforces them and an admin can toggle
them. Rows with `group: null` are *"Advisory persona guidance (no runtime consumer —
matrix-only, no toggle)"* — `move-task-to-review`, `run-unit-integration-validation`,
`read-repo-diff`, `run-validation-suites`, `post-quality-flags`, `approve-review`,
`request-changes`, `author-test-cases`, `read-task-repo`, `flag-underspecified-tasks`.

Three surfaces disagree about them:

| surface | filter | result |
|---|---|---|
| Agents page editor | `capability-catalog.ts:42` `group !== null` | advisory rows hidden ✅ |
| `list_capabilities` | `controller-toolkit.server.ts:430` `group !== null` | advisory rows hidden ✅ |
| **`get_project`** | **`controller-toolkit.server.ts:1496` — no filter** | **advisory rows shown as `{capabilityId, mode:"direct", label}`, byte-identical in shape to an enforced grant** ❌ |

`get_project`'s own description tells the reader this is the authoritative pre-flight read:
*"deployed agents with their RESOLVED grants (every catalogued capability id at the mode the
runtime applies … ruling 139: read this before update_agent_deployment)"*. It is not: some of
those rows are at no mode the runtime applies, because no runtime applies them.

**What it cost, live.** The controller read `get_project`, saw `move-task-to-review: direct`
on the Developer, tried to turn it off, was refused by `update_agent_deployment` (which
filters by the *settable* list), and reported to the owner, in writing:

> *"Some deployed capabilities aren't in the settable catalogue — the Developer carries
> `move-task-to-review` and `run-unit-integration-validation`, the Reviewer `approve-review`
> … I could not turn `move-task-to-review` off, so the Developer can advance a task to Review
> on its own even though I routed delivery through the operator."*

Every clause of that conclusion is false, and viberr is what made it false. The Developer
cannot advance a task on its own: the capability has no consumer. The instance's own manager
read the authoritative surface, reasoned correctly, and told its owner a wrong thing about
who may do what — the exact shape of `ground-truth-displaced-by-prose`.

**The write side is already right — checked.** `capabilityPatchRefusal`
(`capability-catalog.ts:265`) already answers an advisory id with exactly the right sentence:
*"…is a matrix-only capability with no toggle: it describes persona guidance and cannot be
granted or withheld."* And the controller **never called it** — grepped the run log: there is
no `update_agent_deployment` attempt carrying `move-task-to-review`. It reasoned from
`get_project` alone and reported the conclusion as fact. So the defect is exactly one site,
and a better refusal would not have prevented it.

**Proposed fix.** `get_project` marks an advisory row inline, in the reply the controller
actually reads, so the false inference is unavailable:

```json
{ "capabilityId": "move-task-to-review", "mode": "direct", "label": "Move the task to Review",
  "advisory": "persona guidance only: no runtime consumer enforces this, and it has no toggle" }
```

Enforced rows are unchanged (no `advisory` key), and the tool description says what the key
means. Test: an advisory row in a deployment carries `advisory`, an enforced row does not
(canary: drop the marking and the test goes red).

---

## F39-5 · MED · The same missing scope is a "Policy violation" on the task record and "not required" on the credential card

Live on AX-1, within one minute of each other, viberr said both of these about one fact:

- `task.md` timeline, rendered with the coral shield whose label is literally
  **"Policy violation"** (`event-meta.ts:31`):
  > **Policy violation:** active PAT is missing `checks:read`. Reading the pull request's
  > check results was refused during reconcile…
- GitHub page, credential card, at the same time:
  > `repo` · `pull_request:write` — **All required scopes proven.** Secrets stay isolated…

Both are "true" by the code's own definitions, and ruling 360 settled the substance:
`credentialAdvisories()` (`pat-store.server.ts:408`) says in as many words —

> Ruling 360 (pass 38, F38-14): the check-runs read GitHub refused with this token.
> **Not a missing REQUIRED scope — merging never needed it** — but the reason every task
> page and accept dialog says "checks not readable".

The advisory text on the card is excellent. The **timeline event is not**:
`policyViolationText()` (`scope-flag.server.ts:47`) is a single string used for *every*
scope, so the optional one is written into the permanent task record under the word
"violation", with a red shield, next to a card that says nothing is missing. The advisory
is the considered wording; the timeline never got it.

**Proposed fix.** Split the two cases at the one place they are written. A scope the
project actually requires keeps "**Policy violation:**". A scope ruling 360 classes as
advisory (`checks:read` today) writes "**Credential advisory:**" with the same consequence
sentence, and `event-meta.ts` gives that variant a neutral label and icon rather than the
violation shield. One list of required-vs-advisory scopes, read by both writers, so they
cannot drift again. Test: flagging `checks:read` produces an advisory-worded event and
leaves "All required scopes proven" true; flagging a required scope still produces the
violation wording (canary: swap the classification and the test goes red).

---

## F39-6 · MED · A human cannot attach a file to a task — and the instance's own controller plans around one

`task-attachments.server.ts:9-18` says it outright:

> Files land here through two writers: the browser MCP server's `--output-dir` … and the
> agent evidence drop … The read side is deliberately dumb — the DIRECTORY is the truth,
> **no projection table, no upload path**, no retention machinery.

Confirmed in the routes: `app/routes/task-attachment.ts` exports a `loader` and no `action`;
`routes.ts:76` registers only `projects/:slug/tasks/:key/attachments/:file`; there is no
`<input type="file">` anywhere under `app/features/task-detail/`. The only file inputs in the
app are in `store-browser.tsx` — a human may upload a document into a **knowledge base**, but
not onto a **task**.

The attachments panel's empty state is honest about it ("A browser-capable agent on this task
saves the screenshots and files it captures here"). The problem is upstream of the panel.
Asked where a human-supplied artifact would genuinely help, the controller answered:

> **The task: AX-4. The file: captured help output from the real `google/ax` binary** …
> A human-supplied transcript turns that from self-consistency into fidelity.
> … when AX-1 completes and goal-1 link 2 ("Object model") gets its task, attach a **real
> multi-document `ax` manifest** … a human-supplied fixture stops the decoder from being
> tested against a fixture it wrote for itself.

That reasoning is correct and it is exactly the kind of input a governed delivery product
should accept. Viberr cannot. The only way to do it on this instance is to write into
`docker-data/projects/<slug>/tasks/<KEY>/attachments/` on the server's volume by hand, which
is what this pass had to do. An agent then reads it normally — the read side works fine.

**Proposed fix.** An `attach-file` intent on the task route: multipart, project-membership
gated at contributor or above, size-capped, extension-checked against the same whitelist the
read side already enforces, written through a writer into the task's attachments dir, with a
typed timeline event and an audit row naming the uploader. A small drop zone in the
attachments panel (and the panel rendering for every task, not only browser-capable ones).
Test: a contributor uploads and the file lists + a timeline event names them; a viewer is
refused; a traversal name and a `.html` are refused.

---

## F39-7 · MED · The operator answers a conflicting-scope block with a comment, so the work keeps going the wrong way

**Setup.** A human (project admin) put an authoritative upstream fixture on AX-7 and said, on
the timeline, that it contradicts the project's settled `architecture.md` on the wire format
(`ax.io/v1alpha1` vs `ax.dev/v1`, `atespace` vs `namespace`, and the whole Task/Workspace/
Gateway/Model spec shape), and asked the operator to decide and say so — explicitly: *"do not
let an agent quietly pick one and write tests that confirm its own guess."*

**What the operator did.** It reasoned correctly and reported honestly:

> @Arda I've recorded the conflict. The settled ax-clone-rulings architecture.md §2 governs
> this run … the upstream fixture is evidence for a possible future scope change, not
> permission to diverge. The Developer is already running with that architecture-bound
> directive, so it will not choose between the two. **Upstream wire fidelity would require a
> human update to the goal or ruling before rework.**

Nothing there is wrong. The problem is the *shape* it used. Measured on the task file
straight afterwards: `queuedQuestions: []`, no packet, `waiting: agent`. So:

- the task is **not** waiting on a human — it does not show in "waiting on you", the review
  queue, or the board's human filter;
- the delivering agent **kept running** and is building the format the human just said is
  wrong;
- the only signal is a mention notification (which did arrive correctly).

The operator's own playbook picks the other shape for exactly this case
(`viberr-app-expertise.skill.md`): *"Open a decision packet only for a real human choice or
block: **conflicting scope**, policy/credential trouble, or repeated no progress."* An
authoritative artifact contradicting a settled ruling, where the operator's own sentence is
"this needs a human update before rework", **is** conflicting scope. It holds
`generate-packets: direct`, so it could have.

A comment and a packet are not interchangeable: a packet sets `waiting: human`, holds the
task, and is the thing the product's whole decision surface is built around. Choosing the
comment converts a blocking decision into a notification, and pays for it in rework.

**Proposed fix (doctrine, not code).** In `viberr-app-expertise.skill.md`, make the trigger
testable instead of adjectival: *if your own answer to a human contains "this needs a human
decision / a ruling change / rework before X", that is a packet, not a comment — open it and
stop the work it blocks.* And add the converse to the hand-off truth section: *a comment does
not stop a run; if the run in flight is now building the wrong thing, say so and interrupt it
rather than letting it finish.*

---

## F39-8 · HIGH · A human moves a task and cannot say why — and the operator is told to read the reason

**The gap, end to end.** The `transition` intent reads exactly two things from the form:
`to` and, for a move into the final stage, the acceptance disclosure
(`project.task.tsx:966`). `transitionStage` (`task-actions.server.ts:6347`) has no `reason`
or `note` in its input at all. The UI sends `_csrf`, `intent`, `to` and nothing else
(`task-detail-page.tsx:646-656`). The event it writes is the whole record:

> **Transition:** moved AX-9 from Review to Verify.

A manual stage move is one of the strongest signals a person sends — *not ready*, *do this
first*, *I disagree with the verdict* — and it is mute. Every other governed human action
carries its words: a packet resolution has a note, a force-accept has a reason, a comment is
all words. This one has none.

**What the operator is told to do with the reason that does not exist**
(`viberr-app-expertise.skill.md`, Hand-off truth):

> After a human moves the task, read why (their note, decision, or steer) and act on it. **If
> the reason is not visible, ask them with one @mention comment and stop.**

**What it cost, live.** AX-9 was approved and at Review. I moved it back to Verify to ask for
one specific change — the rulings require `go test -race` but `make gate` does not run it, so
the gate does not enforce its own rule — and passed a `note` describing exactly that. The
field does not exist, so it was dropped. The operator, finding no reason attached to the
move, did not ask and stop; it reached for the most recent prior decision and dispatched:

> @Developer Honor Arda's 2026-09-22 decision: rerun the required race gate on a cgo-capable
> host … Do not change scope unless verification exposes a real defect; commit only if a
> necessary fix is made.

That is a re-verification of something already verified, not the change that was asked for.
Nobody lied and nothing was lost from the record — the record never had it. A run was spent
on the wrong work, and a person who typed their reason had no way to know it went nowhere.

**Both halves need fixing**: the transition needs to carry a reason, and the operator needs to
actually ask-and-stop when there is none. Shape put to the owner as a design question.


---

## F39-9 · MEDIUM · Compaction deletes the operator's answer to a human and keeps the question

**Provoked deliberately.** The compression guardrail was set to 20 over HTTP and a comment
posted on AX-9 (62 events) to drive a pass. It behaved as advertised on every count I could
check: 0 typed events lost, 0 human comments lost, 0 controller comments lost, and the marker's
"_2 earlier routine comments compacted_" is the true number.

**What it folded.** One of the two was this, at 05:17:05:

> @Arda Agreed—the corrected evidence settles the diagnosis: `/usr/bin/ld` was present, and
> the prior failure was the missing gold linker. I've submitted the non-binding correction
> against `environment-and-gates.md`; the required reviewer run remains in flight, so no
> workflow transition or acceptance action is warranted yet.

That is the operator answering a person, by name, about a correction that person had just
filed. Arda's question at 05:15 survives — it is human prose, protected. The answer is gone.
Canonical `task.md` now reads as a human correcting the record and nobody replying, and
`task.md` is what the next agent anchors on.

**And the notification still quotes it.** `/notifications` carries the row verbatim —
"Operator · mentioned you — '@Arda Agreed—the corrected evidence settles the diagnosis…'" —
with a button to AX-9. Follow it and the comment is not there. Same shape as ruling 317, which
protected a verdict's justification because a stored record pointed at it: a notification is a
live pointer too, and viberr sent it precisely because the comment named a person.

**Why it is not simply the designed behaviour.** `isRoutineComment` carves out eight cases by
now, each one added after something that mattered was deleted: human prose (B-FD9), controller
prose (257), verdict reasoning (317), evidence pointers (209), attachment pointers (211(e)),
`toAgent` hand-offs, existing markers. Every one of them is "this comment is addressed or
pointed at". A comment that @mentions a person is both, by viberr's own NEW-4 convention —
agents and the operator MUST tag the human they answer, and the tag MUST notify.

**Severity is MEDIUM, not HIGH**, because on this occasion the substance survived by luck: the
operator had also filed the same content as a typed `quality` event (`propose_ruling`), which
compaction never touches. A plain answer with no typed twin is lost outright.

Shape put to the owner as a design question.


---

## F39-10 · HIGH · The record blames the capability policy for refusals no policy made

**On AX-9's timeline, twice, twelve minutes apart:**

> **The operator's plan was not carried out in full.** This step was refused by its capability
> policy:
> - `update_branch_from_base` — AX-9 is at Review, the acceptance boundary: the branch is
>   brought up to date once, at acceptance time, and merged in the same ceremony.

**On the same project's Agents page, at the same moment:** `update-task-branch — direct`. The
capability is wide open. What ruled the step out is the task's STAGE (ruling 162). A person who
follows that sentence to the policy surface finds nothing to change, and the obvious "fix" —
widening a grant — would have done nothing, because it is already as wide as it goes. The
event carries the coral `policy` shield, which the activity feed and every reader take as a
governance signal.

**This is a documented invariant, already stated in the code that broke it.**
`OperatorActionResult` says it in as many words:

> **noop = nothing to do / the task's state ruled it out** … A state conflict returned as
> `denied` therefore tells the human the project's policy blocked work it never blocked — the
> misblame class LV-03 exists to prevent.

`narrateRefusedActions` splits on exactly that field, and does it correctly. Three refusals
were on the wrong side of it:

| Site | What actually ruled it out |
|---|---|
| `acceptanceBoundaryRefusal` (`update_branch_from_base`) | the task's stage |
| `mergeStageEntryRefusal` (`transition_stage`, ruling 162) | the PR's mergeability / delivered revision |
| the withdraw guard in `operatorResolvePacket` | who raised the open packet |

All three are task state, and the third sits one branch below `"No open decision packet to
resolve."`, which has always been a `noop`. Fixed by returning `noop`; nothing else changes,
because the message is unchanged and the agent-facing string was already carrying the whole
explanation. Test: `operator-run.server.test.ts` drives a real plan step at the boundary with
`update-task-branch: direct` and asserts the event is a `note` that does not blame the policy.
Canary: put `denied` back and both assertions flip.

---

## F39-11 · MEDIUM · 27KB of markdown went onto the record as one line

AX-12's deliverer finished the upstream fidelity report and its reply landed on canonical
`task.md` like this:

```
@Arda\n\n# AX-12 — upstream fidelity check\n\nDate: 2026-09-22 UTC\n\n## Scope and conclusion\n\n…
```

27,597 characters, **146 literal `\n` sequences and not one real newline**. Every heading,
table row and list item of a structured report, run together on a single line with the escape
showing.

**It is not viberr's escaping.** The run log has the model's own structured reply, and its
`summary` field already carried the doubled escape: the model escaped its own JSON string
twice. Viberr stored exactly what it was handed.

**It is still viberr's record.** `task.md` is the file the next agent re-anchors on, and this
one now carries a 27KB unreadable block in the middle of it. Viberr already sanitizes what
agents hand it — evidence cells are parsed and capped, structural lines are escaped, verdict
reasons are clipped, raw output is separated onto disk — so accepting a body whose line breaks
are visibly broken is the odd one out.

Frequency, measured across every task file on the board: **1 occurrence** in several hundred
comments. Rare, and total when it happens: it hit the single largest deliverable on the board.

Fixed with a deliberately narrow predicate — more than 200 characters, at least two `\n`
sequences, and **no real newline anywhere**. Prose that long never runs without a single
break, and a snippet that legitimately contains `\n` inside a string literal sits in a body
with real breaks around it (asserted). Only the newline escape is repaired; `\t`, `\"` and
`\\` are left exactly as written. It runs before every other guardrail, because a body that
is one 27KB line defeats the evidence-separation fence scan too.

---

## F39-12 · HIGH · "The review is clean" — on a task nobody reviewed

AX-12 was the standalone upstream-fidelity task. Its deliverer wrote a report, attached it,
committed nothing and opened no pull request. The operator moved it Design → Build → Verify →
Review in three minutes. Its own plan reasoning for the last of those, in the run log:

> The fidelity report is complete, posted, and attached with sources, comparisons, gaps, and
> unverifiable items. **Advance to Review for the required reviewer verdict.**

Sixty-one seconds later, with no reviewer run in between, it filed this card:

> **Accept completion and move AX-12 to Done**
> The review is clean and the work meets the goal. Accepting completion moves AX-12 to Done
> and merges the review PR when GitHub is reachable; otherwise it records the PR as accepted
> (merge pending).

The file at that moment: `validation: none`, `verdicts: []`, `engagements` holding only the
developer (`verdictCapable: false`), `pr` absent. **Apply was enabled, with no refusal
anywhere on the page.**

### (a) The sentence is a fixed string, not a reading

`operator-actions.server.ts` writes that detail on every acceptance offer it files. It is the
[ground truth displaced by prose] shape exactly: viberr HAS `validation`, `verdicts[]` and the
project's `requiredReviewers`, and a hand-written sentence overrode all three. **Fixed** — the
clause is derived now: who approved the revision being accepted, or "No review verdict is
recorded on this task, and the project requires Reviewer at Review."

### (b) "merges the review PR" for a task with no PR — R19-8, regressed through the flag

R19-8 already fixed this once: "the card must not promise a merge — the old single sentence
told a human that applying it 'merges the review PR', for a task that has no PR and never
will." Its fix keys on `noChangeApplies`, which is `noChanges === true && !pr` — the agent's
own flag AND no PR. AX-12's deliverer never set the flag, so the card fell through to the
merge promise. R20-2 had already learned this for the ACCEPT path and says so in its comment:
probe on `!fm.pr` alone, "because an envelope that forgot the flag left the server refusing
with advice that would open an EMPTY PR". The card never got the same treatment. **Fixed** —
the merge clause keys on `noChangeCandidate` (no PR), not on the flag.

### (c) The required reviewer was never owed anything — design question

`requiredReviewerRefusals` opens with:

```ts
const rev = activeWorkRevision(fm.workRevision);
if (!rev && !fm.pr) return [];   // "nothing for the reviewer to judge"
```

AX-12 has neither, so the project rule "Reviewer reviews at Review" held nothing. The
carve-out came from ruling 161, which is about a DISCARDED revision — genuinely nothing to
judge. A research task is not that: AX-12 produced a 27KB report whose entire purpose was to
be checked, and the board's own rule said who should check it. As it stands, **any task whose
deliverable is not a commit skips its project's required reviewer silently.** Put to the owner.

---

## F39-13 · MEDIUM · A red "4" on Settings, for four things the project does not require

The ax-clone rail carried a bold red **4** beside Settings. `countOpenPolicyViolations` is
what renders it, in `.count.violations` (`color: var(--danger); font-weight: 700`). The four
rows, from the audit log:

```
github.scope_violation.opened | {"scope": "checks:read"}   × 4
```

Every one of them is the scope **ruling 360 settled as not required** ("merging never needed
it") and **ruling 380(b) taught the timeline and the credential card to call an advisory**.
380(b) said "one `ADVISORY_SCOPES` list now drives both". There were three surfaces, not two:
the row stays `open` by design, so the count kept lighting the badge — a red number pointing a
person at a page where nothing can be done about it (the fix, if you want one, is on GitHub,
and the credential card already says so).

Fixed on the same list. The record is untouched (ruling 360's call); only the count learns.
`listScopeViolations` still returns them, and a scope the project really does require still
counts, beside them (asserted).

**Considered and left**: the notification `kind` for these is still `"policy"`. Its TEXT is
already right after 380(b) — "Credential advisory: the active PAT has no `checks:read`, which
this project does not require" — and the kind drives routing and grouping, not the words a
person reads. Changing it would split one policy-engine stream into two for a distinction the
sentence already makes.

---

## F39-14 · LOW · Viberr's own diagnostic caught viberr writing the record out of order

The AX-12 task page carried a HEADS UP finding: "Timeline entries are not strictly
newest-first. The page renders file order, so an entry may sit out of place until the file is
rewritten." Checked against the files across the board: AX-11 and AX-12 clean, **AX-9 had one
out-of-order pair** — a `transition` at `05:18:52.004Z` above the "Recommendation withdrawn"
note at `05:18:52.005Z`.

The cause is viberr's own write order. `transitionStage` builds its event before taking the
lock, `withdrawAcceptanceOffers` stamps and unshifts its note inside the lock, and the move
was unshifted last — so the older event went on top. It reads backwards too: the withdrawal
is caused by the move, and a newest-first list showed the consequence below its cause.

Worth recording as much for the method as the fix: the diagnostic was right, nobody had
followed it, and following it found a real ordering bug in one line. The other three
withdrawal sites were checked and are already correct.

---

## F39-15 · HIGH · Ruling 385 held a task nothing could release — and the board demonstrated it

Ruling 385 made the required reviewer hold a task whose deliverable is not a commit. AX-12,
the same task that produced the ruling, then showed what that hold costs when nothing
downstream of it knows about non-commit work. Within twenty minutes of the deploy:

```
stage: review    waiting: human    validation: none    verdicts: []
2026-09-22T07:24:15Z · quality · Reviewer
  title: Changes requested
  **Validation:** none. Review & validation requested changes.
2026-09-22T07:26:41Z · note · operator
  **Coordination stopped:** the `transition_stage` step failed
  (No allowed transition from Review to Verify.). The remaining plan was not executed.
```

Three things, one cause — **everything downstream of review was keyed on `workRevision`**:

1. **The verdict was never stored.** `if (rev && reviewerProfileId)` — no revision, no record.
   The reviewer's request-changes exists only as prose on the timeline.
2. **`deriveValidation` opens with `if (!activeWorkRevision(...)) return "none"`.** So the
   record printed "**Validation:** none. Review & validation requested changes." in one
   sentence.
3. **`requiredReviewerApproved` needs an approve bound to the active revision.** With no
   revision it returns false forever, so ruling 385's hold was **unsatisfiable**: force-accept
   was the only door. And with `validation: none`, ruling 163's backward rework move was not
   licensed either, so the operator's own route out was shut and coordination stopped.

That is a path with no way out, and I shipped the hold that closed it. Ruling 388 gives a
non-commit delivery the identity everything else already had: `deliveredAt`, stamped when the
DELIVERER saves files, and `reviewSubjectId` as the one place that decides what a review binds
to — the revision id, or `files:<deliveredAt>`. A later save moves it and stales the old
verdict, which is the same rule a new revision follows. A reviewer's own captures never move
it (they are evidence for the verdict being written, and stamping them would stale it on the
way in); a person's upload never did (ruling 379 writes no list).

It also **removed** the plumbing ruling 385 added an hour earlier: `runSavedFiles(timeline)`
threaded through seven call sites became one frontmatter field, because the same fact has to
identify what a verdict was given ON, which no boolean can do.

---

## F39-16 · MEDIUM · The packet told the owner to check auth, above the provider saying the network dropped

AX-11's deliverer committed `fe7232b`, reported `make gate` and `go test -race ./...` green,
and then its run died. The packet:

> **Work stalled: pick a recovery path**
> The Implementation agent run failed: Codex run failed: Codex execution failed. **Review its
> authentication and runtime configuration.** Coordination is paused until a human chooses how
> to proceed.
>
> | Provider said | `Reconnecting... waiting for network (Connection failed: error sending request)` |

Viberr captured the true cause and printed the wrong one directly above it.
`LOCAL_NETWORK_FAILURE_RE` has "connection **error**" and not "connection **failed**", and
nothing for "error sending request" — reqwest's standard transport failure, which the Codex
Rust CLI surfaces unchanged.

**It is not only wording.** `kind` selects the packet: `backendFailure` (quota / auth /
unavailable / overloaded) builds one that offers waiting and retrying; `unknown` builds the
generic stalled-work packet whose **recommended** option is "Redirect with sharper guidance".
So a dropped connection was about to buy a re-prompted specialist run, on a task whose work
was already committed and green — the exact "read the workspace before starting anything
over" hazard viberr's own note two lines up warns about.

Same shape as ruling 384 and F39-13, in a third place: viberr holds the fact and a fixed
sentence speaks over it.

---

## F39-17 · MEDIUM · A standing instruction to the controller survives exactly one conversation

The owner's rule for this instance — controller on opus/high, **every other agent on luna at
MAX** — was stated once, hours before the first task existed. Three profiles honour it. The
fourth, `surface-developer`, was deployed in a later conversation at **`effort: xhigh`**.

Asked where such a rule could live so that tomorrow's controller reads it without being told
again, the controller did something better than answer. It:

- read the mechanism correctly and unprompted: **a skill is injected verbatim every turn; a
  knowledge base is injected as an INDEX of names and headings**, bodies on demand (confirmed
  against `kb-injection.server.ts` — "the index names every document, with its size and its
  heading outline");
- refused to edit `controller-guide` or `controller-handbook`, calling that self-modification.
  Ruling 108 locks both for everyone, so it was right;
- wrote the rule into a NEW knowledge base with **the rule as the heading**, because the
  heading is the part that reaches the prompt;
- found the deeper cause I had missed: the **global template** `surface-developer` carried
  `effort: xhigh` as its default, so every future `deploy_agent` would have reproduced it. It
  fixed the template as well as the deployment;
- and then stopped, in its own words: *"I created the resource, I cannot grant it to myself."*

So the ask existed only as prose in a conversation about to end, and the document sat in the
store unread. Owner's call: keep the controller out of its own resources and give the ask a
durable, human-visible home.

One thing the owner's chosen option assumed and the product does not have: **no admin can
grant it in-app.** Ruling 108 makes controller grants a deployment decision, "locked out of
in-app editing for EVERYONE, org admins included", unlocked only by an environment variable
and a restart. So the request surface names the variable, the value and the restart rather
than offering a button that nothing behind it could honour.

---

## F39-19 · HIGH · The operator told an agent to read a timeline no agent can read

AX-12, verbatim, from the operator to its deliverer:

> @Developer Act on Arda's latest steer: **read the Reviewer's request-changes findings in the
> timeline**, correct the report attachment accordingly, and save the corrected report again.

Six minutes later the Developer raised a decision packet:

> **Reviewer findings needed.** Please paste the Reviewer's request-changes findings into the
> next directive, or provide an authenticated/readable task-timeline view. … The Viberr task
> page redirects to sign-in.

**The agent was right.** A specialist's whole view of the record is:

- the canonical anchor, which clamps every timeline entry to **220 characters** — shorter than
  any verdict worth reworking against;
- `read_board`, whose own description is "its title, stage, readiness, what it waits on,
  whether it is archived, and its goal" — **no timeline**;
- nothing else. It tried the task page over HTTP and got the sign-in redirect, which is right.

So the directive named a source the agent cannot reach, and the agent spent a run and a human
decision asking for what the operator already had in front of it. The operator's own playbook
says to do the opposite — "`run_agent` the delivering profile with **the concrete findings as
its prompt**" — and it delegated the reading instead.

Both halves fixed. The doctrine now says it as a fact about the machinery rather than a style
note: *an agent cannot read this task's timeline; your prompt is its only channel*, with "see
the comment above" and "act on what Arda said" named as the same mistake. And the anchor now
carries **the standing verdicts whole** (ruling 392) — stored, already clipped at 2,000
characters by ruling 292, and the one part of the record a rework run cannot proceed without.
On this incident that alone would have prevented the packet.

---

## F39-20 · MEDIUM · The force dialog showed one bypassed gate; the audit recorded two

Found by force-accepting AX-12 for real, which was the honest call: the Reviewer had approved
at 08:08 and viberr could not bind the verdict, so the gate could never clear itself.

The dialog I confirmed:

> **BYPASSING** Waiting on 1 required reviewer approval of the current revision.

The audit row it wrote:

```json
"bypassedGates": [
  "Waiting on 1 required reviewer approval of the current revision.",
  "Required reviewer Reviewer (project rule at Review) has not approved revision 76dabee."
]
```

U35-3 built one shared builder for exactly this, after KNC-10 recorded a skipped stage
boundary and never the failing verdict beside it. Its docstring says the builder exists "so
the timeline, the audit log and the confirm dialog list the same bypasses" — and the dialog
was the one that never received the list, because the task page passes
`acceptance.blockedReason`, the FIRST gate. Ruling 88's premise is that you cannot accept
blind, and an override is the case that most needs it.

---

## F39-21 · CRITICAL · A finished run reported as a failed one, and its work abandoned

The worst finding of the pass, caught twice inside ten minutes on the live board.

At 08:33 UTC the AX-2 timeline recorded these three events inside 53 milliseconds:

```
08:33:08.181  comment  agent  "@operator Done on branch `ax-2`, commit `3e0396ab...`.
                               ... `make gate` and `go test -race ./...` pass."
08:33:08.205  blocked  agent  "The Implementation agent run did not complete. ...
                               Nothing was delivered to a pull request ..."
08:33:08.234  blocked  operator "Work stalled: pick a recovery path."
```

Viberr wrote down the agent's completion report and then, in the next breath, told the owner
the run had not completed. AX-3 did the same thing eight minutes later.

**The work was real and it was still there.** `tasks/AX-2/workspace/ax-clone` is on branch
`ax-2` with a clean tree at `3e0396a`, "[AX-2] Implement reconciler framework and status
helpers": 1,531 insertions across seven files, four of them tests. AX-3 carries two commits,
`04c8c50` and `4a9a588`.

**What the provider actually streamed** (`runtimes/codex/run_Ys0uzCRS_twA.jsonl`, last four
lines):

```
item.completed  agent_message  {"evidence":[{"label":"make gate","add":"1 passed"},...],
                                "summary":"@operator Done on branch `ax-2`, ...",
                                "verdict":null,"question":null}
turn.completed  usage{ input 2,310,342 / output 26,375 }
error           "Reconnecting... waiting for network (Connection failed: error sending request)"
compacted       source viberr, trigger completion
```

A complete, schema-valid outcome envelope. Then the provider's own `turn.completed`. Then
the socket died — while Viberr ran its **own** end-of-run compaction (ruling 376), which is
an `app-server` call and needs the network. Viberr's optional housekeeping, failing, is what
converted a successful run into a failed one.

The defect is one line, and the docstring above it states the rule it gets wrong:

```ts
// codex-runtime.server.ts — "Success is gated on seeing `turn.completed`
// with no TOP-LEVEL `turn.failed`/`error`"
if (sawTurnCompleted && !sawFatalError) return settle("finished");
```

A conjunction over the whole stream, blind to **order**. That rule is right for an error that
arrives before or instead of completion and wrong for one that arrives after it. The thrown
path was worse still: the `catch` never consulted `sawTurnCompleted` at all. The Claude
adapter had the same hole — a terminal non-error `result` followed by a thrown stream error
fell straight through to `settleError`.

**What it cost.** Both tasks sat `waiting: human`, `readiness: blocked` for hours behind a
packet whose observations were all true and whose premise was false. Its **recommended**
option:

> *Retry @developer on Codex now: this deployment could not reach the provider, nothing was
> changed* — `rec: true`

Every option on the packet was a recovery from a failure that had not happened, and none of
them said "the agent finished." Ruling 333 had already taught the failure note not to claim
"No changes were delivered" — it duly reported "the run had 1 turn behind it when it
stopped" — but a softened sentence on a wrong verdict is still a wrong verdict.

Fixed as ruling 394: both adapters track whether anything was in flight after the last
completed turn, and a drop behind a finished turn settles `finished` and is recorded on its
own `run·transport·after-turn` line — deliberately not an `err` line, since
`runFailureReason` reads the last of those as the run's cause and this run has no cause.

Its sibling, same morning, same regex family as ruling 389: AX-3's drop read
`Reconnecting... 5/5 (request timed out)`. `LOCAL_NETWORK_FAILURE_RE` listed
`connection timed out` and not `request timed out`, so the network drop classified `unknown`
and the packet told the owner to *"Review its authentication and runtime configuration"* —
the exact sentence ruling 389 exists to prevent, one variant of wording away.

---

## F39-22 · MEDIUM · Insights printed an unreported cache figure as a measured zero

The Prompt cache table, live, for the Codex half of this instance:

```
GROUP      RUNS  WARM STARTS  WRITTEN  READ    WRITE / READ  LIFETIME
primary    21    16%          0        45.0M   0.000         not reported
reviewer   11    0%           0        15.9M   0.000         not reported
controller  6    0%           447.9K   6.0M    0.075         6 × 1h
```

Codex declares `cache_write_input_tokens` in the SDK's own types — "the number of input
tokens written to the prompt cache during the turn" — and returns exactly **0** for it. Not
sometimes: 101 of 101 usage envelopes under this data root, against 67.2M tokens reported
read. One value and never any other is not a measurement.

The page prints it as one, and then divides by it. Someone asking whether pass 39's own
prompt-cache work (rulings 369-376, PR #315) does anything on Codex reads `0.000` on the row
with 21 delivery runs behind it and has their answer — from a field the provider never fills.

What makes it a finding rather than a rounding choice is that **every neighbour on the page
already refuses to do this**: the cost breakdowns print "not reported" rather than `$0.00`,
the quota panel prints "no reading yet", the lifetime column *in the same row* prints "not
reported", the caption already says "Claude reports it; Codex does not" about that column,
and the schema says it one column over (`cache_ttl_bucket`: "NULL on Codex (no such
figure)"). The panel's own docstring states the rule: *"a rate with no first call behind it
prints n/a, never 0%."* The write column is the one place the rule was not applied.

Fixed as ruling 395. A genuine zero from a backend that DOES report stays a zero — Claude
answering "none" is a measurement, and the fix must not swallow it.

---

## F39-23 · HIGH · File leases are enforced against people who cannot see them

Found by auditing what the controller wrote into the project knowledge base — the question the
goal asks directly. Section 7 of `ax-clone-rulings/architecture.md`, added by the controller on
2026-09-22 when the cycle chains were re-cut so several tasks build at once, is genuinely good
work: it splits the tree between the Developer and the Surface Developer, says read across the
line freely and never write across it, and names the enforcement:

> "Viberr FILE LEASES are the enforcement, not this paragraph: a branch that changes a path
> leased to another task is refused at delivery, by name. **Current leases are on the project's
> settings page.**"

Every clause of that is true except the last, and the last one is the one an agent acts on.

Leases are real and they bite. `push-workspace.server.ts` refuses the push before anything
reaches GitHub, and the refusal reads:

> "AX-5 changes `go.mod`, which AX-9 holds (...). One task owns a shared file until it merges,
> so AX-5 waits for AX-9 before delivering it for review. Drop the change, or **clear the lease**
> once AX-9 has landed."

There was nowhere to clear it. Grepping `app/features` and `app/routes` for any lease reader
returns nothing. The whole feature lived between two controller tools and a prompt injection:

| | |
|---|---|
| Declared by | `set_file_leases`, a controller tool |
| Read by | `read_project`, a controller tool |
| Delivered to agents | `specialist-run.server.ts:544`, into the prompt |
| Enforced at | `push-workspace.server.ts:975`, refusing a real push |
| Visible to a person | nowhere |

Ruling 245's own docstring says a lease "is read where a person or an agent asks 'may I touch
this'". `staleFileLeases`' says the spent ones are named "so a surface can offer to tidy them".
Neither surface was ever built, and the module has been shipped since pass 37.

So the controller did not hallucinate. It inferred, correctly, that a product which refuses a
delivery in a named task's name must show a person that name somewhere, and it named the only
page that could plausibly hold it. Fixed as ruling 396 by building that panel, which makes the
controller's sentence true rather than correcting it.

**Also found on the way in**: `settings-actions.server.ts` carried one raw NUL byte — a
composite-key separator written as a literal rather than `\u0000`. grep reads the file as
binary and answers nothing, silently, for every search anyone runs against its 1,400 lines.
That is how this finding took five minutes longer than it should have.

---

## F39-24 · MEDIUM · The failure note stands on top of the report and outranks it

F39-21's other half, and the one ruling 394 cannot close. 394 stops a completed turn being
called a failure; it cannot stop a genuinely cut run from leaving a report behind.

The two events on AX-2, 24 milliseconds apart:

```
08:33:08.181  comment  agent  "Done on branch `ax-2`, commit `3e0396ab`.
                               make gate and go test -race ./... pass."
08:33:08.205  blocked  agent  "The Implementation agent run did not complete …
                               Nothing was delivered to a pull request."
```

"Nothing was delivered to a pull request" is **true**, and it is about the pull request. A
reader takes it to be about the work. Ruling 333 already softened the old absolute ("No
changes were delivered") into a clause that names the turns and files behind the run — but a
softened sentence sitting on top of a completion report still reads as the verdict on it,
because it is newer and because it is the one the packet quotes.

The operator had the report in its own snapshot window the whole time (rows are capped at
1,500 chars and this one was 450), and re-dispatched anyway. Nothing in its turn instruction
told it that a failure event can be standing on a finished report, or which of the two to
believe.

Owner's call: the operator decides, rather than the human picking a new packet option. Fixed
as ruling 397 — the snapshot names the pair, and the turn instruction leads with it on every
trigger, states both arms, and names the one fact that settles them.

---

## F39-25 · HIGH · A goal could only ever put one task on the board

**Found by the controller, not by me** — the only finding of this pass whose diagnosis I did
not make. I told it to widen the board by cutting cycles into smaller links. It refused, with
three facts, and the third one was a viberr defect:

> "Smaller links will not widen the board. A chain creates link N+1's task only when link N
> completes — `blockedBy` on a pending link doesn't change that, because the task doesn't
> exist yet to be released. So concurrency equals the number of *active chains*, not the
> number of links. Cutting cycle 3 from 4 links into 8 gives you the same one task at a time,
> for twice as long."

It is right, and it is in the code:

```ts
// reconcileGoal
const index = currentLinkIndex(fm.links);   // the FIRST unsettled link. Singular.
...
} else if (link && !link.taskKey && link.status === "pending") {
  startIndex = link.index;                  // and only that one is ever started
}
```

Meanwhile the per-link `blockedBy` documents itself as the thing that holds a link: *"so a
link that waits on a sibling chain's link is born held instead of paying a triage turn that
has to discover the wait."* It had nothing to hold. A link's task did not exist until its
predecessor finished, whatever it declared.

The consequence is a product shape nobody chose: **board concurrency equals the number of
active GOALS.** To run six tasks at once you write six goals, and the goal's structure gets
dictated by the scheduler rather than by the work. The controller's own plan for the ax-clone
board was to shard each cycle into short parallel chains for exactly this reason.

Nothing lies about it — `create_goal`'s description says "an ordered chain … each later task
is created when the previous link completes", and the controller read it correctly. So this is
a design ceiling rather than a false statement, which is why it went to the owner as a design
question. Owner's call (2026-09-22): fan out, no cap.

Fixed as ruling 398. Three further defects surfaced while building it, each real on its own:

- **A sequence was not expressible in one call.** To say "link 2 waits on link 1" you need
  `goal-7 link 1`, and the goal id is minted while the goal is being written. Under chain
  semantics the ORDER carried that meaning; once order stops holding anything, a sequential
  goal would have taken a create plus one `update_goal` per link, against an id the author
  never chose. `link 2` is now accepted on input and stored absolute.
- **A dead wait would have gone silent.** The old advance discovered an unsatisfiable wait by
  ATTEMPTING the start and catching the throw. A selector that skips unsatisfied links never
  attempts it, so the link would have sat pending forever with nothing saying why. It parks
  the goal by name now.
- **A settled link's archived task killed every wait behind it.** `resolveDependencies` and
  `validateDependencyRefs` both went straight to the task's state, so archiving a link's task
  after it completed turned every `goal-N link M` wait on it into a dead one — and an
  onFailure=continue ride-through refused its own next link in the name of the failure it was
  riding past. `reconcileGoal` already refused to undo a link's settlement on an archive
  ("archiving a COMPLETED link's task does not retroactively fail the link"); the two readers
  did not know.

Every pre-existing goal test relied on chain order and now declares it — 25 of them failed the
first time the selector changed, which is the honest measure of how much meaning was riding on
list position.

---

## What the controller did well (the goal asks; this is the answer)

Three of this pass's questions were about the controller's own judgement rather than about
viberr's code. Recording the answers, because they are not all flattering to viberr.

**Does it build good knowledge bases?** Yes, and better than the bar. Asked to freeze an API
surface contract so that "depends only on the interface" would be a claim an agent could
check, it wrote `ax-clone-rulings/surface-contract.md` with a provenance section that
distinguishes three levels in one document:

> Section 1 was READ out of `internal/server/server.go` as `main` has it — the code AX-11
> merged in PR #4. Section 2 was READ out of AX-2's delivered branch, PR #5 head `22e3daf`,
> which was IN REVIEW and NOT merged when this was written, so section 2 is provisional until
> that PR merges. Section 3 is not a read at all: it is a controller decision, and it says so.
>
> This document is DESCRIPTIVE, not aspirational. Where it and the code disagree, the CODE is
> right: say so on your task timeline with the file and the line.

I asked for provenance. It invented the three-way split, the provisional marker and the
precedence rule on its own.

**Does it keep the project KB current as the project evolves?** Yes, unprompted. When the
cycle chains were re-cut so several tasks build at once, it added section 7 to
`architecture.md` — a surface-ownership split between the Developer (core) and the Surface
Developer (edge), with a read-across/never-write-across rule and a named escalation path. Its
one wrong sentence in that section is F39-23, and it was wrong in viberr's favour: it assumed
a product that enforces leases must show them somewhere.

**Does it make good decisions about viberr?** It made the best one of the pass. Told to widen
the board by cutting cycles into smaller links, it refused with three facts and the third was
a defect I had not seen (F39-25 / ruling 398). It also declined to edit its own skill as
self-modification, found a root cause I had missed (a global template carrying
`effort: xhigh`), and said "I created the resource, I cannot grant it to myself" — which
became ruling 390.

**Where it is weak**: it asserts mechanisms it has not verified when the assertion is
plausible and the product would be better if it were true (F39-23). Everything else it
asserted this pass and I checked, held.

---


### The agents it wrote, judged by what they did under pressure

Three specialists, all `gpt-5.6-luna` at `effort: max` as the owner required, selected by
capability rather than name. The controller split implementation in two along
architecture.md section 7 — a core `Developer` (`internal/apis`, `store`, `controller`,
`sandbox`, `runtime`) and a `Surface Developer` (`internal/server`, `client`, `cli`,
`cmd/ax`, `docs`, `examples`) — and wrote the boundary into the persona itself:

> You READ those packages freely — you must, to build against them honestly. You do not
> edit them. If your task genuinely cannot be done without a change on the other side of
> that line … you stop and say so on the timeline: name the file, name the change, name why
> your task needs it, and let the operator decide. **Reaching across quietly is the one
> failure mode this split exists to prevent, and it shows up later as an unmergeable
> branch, not as an error now.**

It also assigns the unowned files (`go.mod`, `Makefile`, `.golangci.yml`) a rule of their
own, and says the rulings knowledge base wins over the agent's instincts.

That instruction closed the loop live. On AX-21 the Surface Developer needed a one-line fix
in `internal/sandbox/local.go` — core-owned. It stopped, named the file, named the change,
named why, and raised it as a decision rather than reaching across:

> Blocked on core-owned `internal/sandbox/local.go`: stderr pipe ends are reversed, so real
> Task stderr cannot reach the log store. Surface changes and tests are uncommitted on
> branch `ax-21`; no new commit SHA and no PR URL.

A persona written on day one producing exactly the behaviour it describes, on a collision
it could not have anticipated, is the strongest evidence in this pass that the controller
writes agents rather than job titles.

### The knowledge base it keeps

Five documents, and it added `v0-2-scope.md` when the owner settled that the agent-workload
half of upstream `ax` becomes a named v0.2 rather than a seventh cycle. It is the best
single artefact the controller produced: nine omissions, each with the AX-12 disposition
that sourced it; a section separating deliberate divergences from gaps; and a cost section
that states, before anyone starts, that the work amends a human ruling and will turn
AX-14's drift test red — with the instruction not to route around it:

> THAT IS THE MECHANISM WORKING, not a defect and not a regression to route around. The fix
> is to write the new fields into the reference; never to weaken or skip the drift test.

It also kept the document consistent with a change it had made an hour earlier, moving
`describe`, `delete` and `ctx` OUT of the v0.2 list because they had just become goal-4
links 6-8 ("Do not re-file them here").

Two flaws, neither of them reasoning errors:

- The section headed "Two divergences that are decisions, not gaps" contains four bullets.
- It **promoted a proposal without retiring it**. The operator filed a ruling proposal from
  AX-9's evidence (the cgo/race linker misdiagnosis, ruling 378), the controller then
  rewrote sections 1, 3 and 4 of `environment-and-gates.md` to settle exactly that question
  and logged the amendment — and left the proposal sitting under "Proposed (not binding)".
  The document's own header says the promoter "promotes an entry into the settled text
  above, **or deletes it**", so the workflow is written down and was half-followed. The two
  texts agree, so nothing contradicts; the cost is that every run on this board now reads a
  settled fact twice, once as settled and once as explicitly not binding.

  Not raised as a viberr defect: `propose_ruling` is an append, the retirement is a normal
  KB edit the controller already has, and the instruction is already in the document. It is
  the housekeeping half of the loop, and it is worth watching whether it accumulates on a
  longer project than this one.

## F39-26 · HIGH · The pause that explains what happened got it backwards

Three consecutive AX-4 timeline entries, spanning 37 milliseconds:

```
11:08:34  note  operator        The operator's plan was not carried out in full.
                                - open_packet — "Create a follow-on task for the
                                  missing logs baseline" is a create_task option
                                  with no task on it. Give newTask a title and a
                                  goal … Without them the confirm would create
                                  nothing.
11:16:44  note  operator        (the same refusal, verbatim, on the retry)
11:16:44  note  policy-engine   this stage auto-advances, but the operator held
                                it twice in a row WITHOUT … OPENING A PACKET —
                                treating that as a DELIBERATE HOLD. Coordination
                                is paused here: RUN THE OPERATOR MANUALLY when
                                the hold should end.
```

It tried to open a packet. Twice. Viberr refused the step both times, for a reason it
stated precisely. Then Viberr said it had not tried, called that a deliberate choice, and
told the reader to do the one thing that reproduces it.

The remedy is the worst part. The operator had already been re-invoked once with the
`plan-refused` instruction — *"Do NOT plan the same refused action again; it will be refused
again and this is the only automatic nudge"* — and planned it again anyway. So "run the
operator manually" is advice viberr had already tested and watched fail, in the run
immediately before the one writing the advice.

And the fact was never missing. `planWhollyRefused` is read **eleven lines above** the note,
to decide the task is stranded at all (ruling 228). The same function held the truth and
wrote its opposite.

Ruling 202 fixed this exact sentence once before, for a drive that had DELIVERED, and its
comment enumerates "the three other ways a drive can act — a transition by `movedToStageId`,
a dispatch by the live-run check, a packet or a recommendation by `operatorLeftTaskStranded`".
A refused plan is the fourth, and it was covered by nothing.

Fixed as ruling 399. The pause stays, because something genuinely is wrong; only the account
of it changes.

**Two things worth separating out.** The operator re-planning a step it had just been told
was refused is an agent-quality problem, not a viberr one — the instruction it got was clear
and specific. And viberr's refusal message itself is excellent: it names the option, the
missing fields, and why they matter ("the goal is the contract the new task is worked to").
The machinery around this defect is good. The defect is one sentence at the end of it.

---

## F39-27 · MEDIUM · The retry that exists to break a loop told the operator to go and read

F39-26's other half, found by asking why the operator repeated a step it had just been told
not to repeat.

The `plan-refused` nudge — ruling 228's single automatic retry, the last paid drive before
coordination pauses — said:

> "The refusals are on the timeline, and each one names what to do instead — read them and
> follow them."

That is the instruction ruling 392 retired for agents, three days earlier, in this same pass:
*"An agent cannot read this task's timeline. Your prompt is its only channel … A directive
that delegates reading costs a run."* The operator CAN read its timeline, so it is not the
same defect exactly — but it is the same bet, made at the worst moment: the one turn whose
entire purpose is to stop a loop, spending its instruction budget on a pointer instead of the
content.

The refusal sentences were three lines away. `narrateRefusedActions` has them as
`RefusedPlanStep[]`, and the very next statement sets `planWhollyRefused = true` on the run
context that the nudge reads. Nothing was missing; nothing was joined up.

Fixed as ruling 400: the sentences ride from the refusal to the retry's prompt and are quoted
in full. The standing prohibition is kept in both branches rather than lost to the quote.

**Honest note on what this does and does not fix.** The operator planning a malformed option
twice is agent quality, not a viberr defect — the `newTask` contract is a `strictObject` whose
`title` and `goal` are required and precisely described, and the refusal message names both.
Ruling 400 removes viberr's contribution to the loop. It does not guarantee the operator
reads better.

---

## F39-28 · MEDIUM · A red pill on a finished task, for a branch that does not exist

Found by diffing the GitHub page's Execution branches table against GitHub itself — the pass's
first method, on a surface I had not yet checked.

The page:

```
AX-12  Upstream fidelity check: our named surface vs. github.com/google/ax
       ax-12        no PR        behind main        <- risk fill
```

GitHub:

```
$ gh api repos/akin-ozer/ax-clone/branches --jq '.[].name'
ax-16 ax-19 ax-20 ax-4 main
```

No `ax-12`. Not in the mirror either. AX-12 is **done**, `noChanges: true`, zero commits, no
PR — it delivered an upstream comparison as an attachment, which ruling 391 settled is real
delivered work.

What produced the pill: viberr allocates a task's branch NAME at creation, so the row exists
from birth; the sync column then reads the newest reconcile's `behindBy` for that task file.
AX-12's recorded revision is `workRevision.branch: main`, head `76dabee` — main's head at the
time, now twenty commits back. So the comparison is real, and it is a comparison of something
other than what the row claims to be about.

The result is a standing false alarm with no exit: a `risk`-filled demand, on work that is
finished, naming a branch nobody can update because it was never created. It cannot clear,
because nothing about a completed task moves again.

`SyncState` already carries the precedent. UI-05 added `unknown` ("not compared") because
*"'we never measured this' is NOT 'synced'"*. This is the same sentence one step further
along: we measured something, and it was not this branch. Fixed as ruling 401 with a
`no_branch` state, evaluated before the compare — because the compare is exactly what
produces the wrong answer.

**Checked and not a finding**, for the record: the page's "14 task-key branches" count
includes rows whose remote branch was deleted on merge, but every one of those rows renders
`merged`, so the state is disclosed per row and the count is a count of task records. And
AX-4 reads "behind main" where GitHub says `diverged` (ahead 2, behind 20) — incomplete, but
"behind" is the actionable half and `update_branch_from_base` merges rather than
fast-forwards, so the word matches the remedy.

---

## F39-29 · HIGH · The operator is told it is link 1 of 5 and shown one link

Found by asking why AX-4's operator wanted to create a task the project had already planned.

Its goal text opens:

> Part of goal goal-4 (Cycle 4 — CLI: apply, get, watch, logs), **link 1 of 5**.

And it planned a decision packet offering to *"Create a follow-on task for the missing logs
baseline"*. But `ax logs` **is goal-4 link 5**, and its declared wait is `AX-4` — the very
task the operator was coordinating. It was about to ask a human to authorise a duplicate of
the next-but-three item in its own chain.

It could not have known. Checked all three ways it might have:

| | |
|---|---|
| `OperatorTaskSnapshot` | no `goalRef`, no links — only `goal`, the link's own text |
| operator toolkit | no goal read of any kind (17 tools, none of them `get_goal`) |
| `read_board` | lists TASKS; goal-4 link 5 is pending and has no task |

The third is the sharp one, because `read_board`'s own description sends the operator there
for exactly this question:

> "Call it BEFORE you offer a create_task option or write a blockedBy … work you are about to
> ask for **may already have an owner**."

Sound instruction. The tool it names cannot answer it, because the owner of planned work is
the plan, and the plan is a goal file the operator cannot read. Ruling 392's shape from the
other end: there, the operator told an agent to read something it could not reach; here,
viberr told the operator to check something it could not see.

Fixed as ruling 402: `goalChain` on the snapshot — every link with its index, title, status,
`taskKey` and declared wait — plus `read_board` saying what it cannot see, and the operator
skill saying that a link with `taskKey: null` is work already decided and not yet started.

---

## Noted, not worked (nitpicks, recorded so the next pass does not re-find them)

- **`mode: off` is written unquoted, which YAML 1.1 reads as `false`.** 21 instances in the
  live store, all of them `capabilities[].mode`, and it is the ONLY ambiguous bare value the
  store contains (no `on`/`yes`/`no` anywhere). Viberr itself is correct — the `yaml` package
  parses YAML 1.2 core, where `off` is a string — but "files are truth" means other tools read
  these files, and `python3 -c "yaml.safe_load(...)"` returns `False` here. Harmless in
  practice, since `off` and `false` mean the same thing to a reader; recorded so the next pass
  does not re-derive it, and because quoting the enum in the serializer would cost nothing.
  (Found by misreading it myself.)
- **Insights "By task" lists controller conversations as `/cnv_…`.** Every real row reads
  `ax-clone/AX-9`; a controller turn reads `/cnv_tjVMn13JkW-0` — a leading slash, no project,
  and not a task at all. Honest about the cost, misleading about the subject. One label.
- **The model picker's two lists disagree about Opus.** The live `supportedModels()` catalogue
  for this account offers `opus[1m]` and no plain `opus`; the curated fallback offers plain
  `opus`. Which one you can pick depends on whether the live fetch succeeded. Not a defect:
  `claudeModelRunsVerbatim` already stops a picker rewriting a stored value the runtime would
  run verbatim (pass 34, F34-7), so nothing is silently changed. (F39-2)
- **An auto-boundary chain costs one operator run per stage.** AX-1 walked
  Design→Build→Verify→Review with no work at Build or Verify: five operator runs to one
  specialist run. Documented behaviour (a transition re-triggers the operator), and on an
  all-Codex fleet it is nearly free — but on a six-stage board it is the dominant run count,
  and Insights' own "Coordination overhead" metric cannot measure it because Codex reports
  no cost. Worth a look if a board ever puts its fleet on a metered backend.


---

## Not a viberr finding, but the pass's own lesson twice over

**Two independent agents reached the same wrong diagnosis from the same message.** After
this pass added gcc to the image, `make gate` with cgo enabled failed while linking the
pinned golangci-lint with `collect2: fatal error: cannot find 'ld'`. The Developer reported
"this image lacks the `ld` linker"; the Reviewer, running its own gates a few minutes later
and with no sight of that report at the time it ran, wrote "the pinned v2.6.0 linter build
failed because the host linker `ld` is unavailable". Both reasonable. Both wrong:
`/usr/bin/ld` was present the whole time (GNU ld 2.44). The real cause is that Go's external
linker invokes `gcc -fuse-ld=gold` on linux/arm64 and Debian ships only `ld.bfd`, so gcc
cannot find the *gold* linker and says it cannot find "ld".

Recorded here for two reasons. It is the exact shape F39-1 is about — a toolchain fact
nobody could see, guessed at instead of measured, and written into the record as fact — and
`instance_health({ probe: ["ld.gold"] })` now answers it in one call. And it is a caution
about agent reports generally: two careful agents agreeing is not corroboration when they
read the same misleading string.

Fixed by adding `binutils-gold` to the image; `make gate` with cgo enabled now exits 0
including the pinned lint, and the record on AX-9 was corrected by hand.

## F39-30 · HIGH · Every compaction note says the agent's context was summarized to 0k

82 of the board's 84 compaction notes read:

> Context compacted: the provider summarized Surface Developer's conversation
> **from 213k to 0k tokens** (auto).

The two that carry a real figure say 18k and 22k. A conversation is not summarized to zero
tokens, and this is the one number a human would use to judge whether the compaction was
safe. It is on the record that files-are-truth says is testable.

The zero is viberr's own. `markCompaction` seeds `{ preTokens: lastPrompt, postTokens: 0 }`
and fills the post size from the first `token_count` line AFTER the marker. Ruling 376's
completion compaction is the run's LAST act, so no such line exists. Measured on six
rollouts, hours after the fact:

```
rollout-2026-09-22T16-47-16-…  compactions=2 last@428/429 token_count_after=[]
rollout-2026-09-22T16-42-53-…  compactions=2 last@340/341 token_count_after=[]
rollout-2026-09-22T16-45-51-…  compactions=2 last@410/411 token_count_after=[]
```

The compaction is the final line of the file every time. Not a race: the figure is
genuinely unknowable there.

The codebase already knew. The type's own comment: *"the first one after (0 when no later
call landed)"*. And `run-sink.server.ts:533` guards `postTokens !== null && postTokens > 0`
before trusting it. The sentinel meant "unmeasured" in every place except the sentence a
human reads.

Ruling 403. `postTokens` becomes `number | null`, null renders "a summary".

## F39-31 · MEDIUM · A task tells its own agent it is the last link while three more follow

goal-4 was created with 5 links. The controller added links 6, 7 and 8 on 2026-09-22.
Nothing rewrites a chain task's frozen goal body, so:

```
STALE AX-21: says 'link 5 of 5' but goal-4 has 8 links
STALE AX-4:  says 'link 1 of 5' but goal-4 has 8 links
STALE AX-6:  says 'link 1 of 5' but goal-6 has 6 links
```

AX-21 was in flight. The goal body is the agent's ONLY channel for chain context — the
operator skill's own rule is that an agent cannot read the timeline — so a specialist
deciding how much to tie off was being told its chain ended with it.

Ruling 402's doc comment quotes "link 1 of 5" as the thing that tells the operator other
links exist, which made the stale total load-bearing in two places at once.

Owner's call: stop claiming a total. Ruling 404.

## F39-32 · HIGH · A conflict verdict outlived the commit that resolved it, and stranded the task

AX-18's Surface Developer resolved the conflict in `internal/cli/render.go` and committed
`d44e874`. The operator pushed it. Fifteen seconds later, twice:

> `transition_stage` — AX-18's review PR #16 conflicts with the base branch. GitHub can't
> merge it, so it can't be accepted.

The stored verdict was measured at `5ae0752` — the commit `d44e874` had just superseded.
GitHub said `UNKNOWN` at that moment (it recomputes asynchronously) and `MERGEABLE`/`CLEAN`
nine minutes later. The conflict never existed on the head being judged.

Both facts were in the same `pr:` block:

```yaml
  mergeable: conflicting          # no head
  paths:
    headSha: 5ae0752…             # where the last full read was taken
  headSha: d44e874…               # what is actually there now
```

`paths` has carried that pin since ruling 236 — *"a list read for a DIFFERENT head than the
one now live is dropped rather than shown stale"*. The verdict that BLOCKS had none. The
reconciler's fallback rule ("an unread value keeps the last-known one for the same PR") was
written for a read that FAILED; a PR is not a fixed thing, and its head had moved.

Ruling 405. `pr.mergeableAt` travels with the verdict.

## F39-33 · HIGH · Viberr told the operator what to do, then paused coordination for doing it

The refusal above ends: *"Open the conflict packet (update_branch_from_base) or deliver the
revision instead of moving the task."*

The operator's next drive read it and reasoned correctly:

> PR #16 conflicts with the base, so the transition was refused. Update the task branch from
> base first; then re-deliver and re-review on the next invocation.

It planned exactly `update_branch_from_base`. The call succeeded. Because the branch was
already current it moved nothing and recorded no base refresh — and a base refresh is not a
transition, a dispatch, a delivery or a packet, which are the four effects the stranded
backstop recognises. So:

> **Note:** this stage auto-advances, but the operator held it twice in a row without
> advancing, dispatching, or opening a packet — treating that as a deliberate hold.
> Coordination is paused here.

`heldAtStage` was stamped and AX-18 sat at `waiting: human` until a person moved the stage by
hand. Viberr named the remedy, the operator performed it, and viberr recorded that it had
done nothing.

This is the fourth amendment to the same verdict — ruling 152(a) added a transition that
landed elsewhere, 202 added delivery, 228 added the wholly-refused plan. Ruling 406 stops
enumerating effects and records the fact: the drive ACTED.

## F39-34 · MEDIUM · A permanent traceability failure, drawn on a task that delivered a report

/insights, read live:

> **Branch & PR traceability · 95%** — 18 of 19 delivered tasks carry branch + PR — **AX-12**

AX-12's deliverable was the upstream-fidelity comparison against `github.com/google/ax`,
delivered as 20 attachments. `noChanges: true`, zero commits, no PR, force-accepted, Done.
It carries a `workRevision`, so the metric counts it as a delivery, finds no PR, and reports
it as the exception.

The demand can never be met. Nothing about a finished task moves again, so AX-12 will sit in
that card at 95% forever, named as the failure.

Ruling 290 built these cards specifically to count exceptions a person can ACT on, and to
name them rather than withhold the name. This inverts it: the name is there, and there is
nothing to do with it.

Same shape as F39-28 (ruling 401), which dropped the same task's "behind main" pill on the
same reasoning — a demand, drawn as a problem, on finished work, for a branch that does not
exist. I fixed one surface and not the other. Ruling 407.

## F39-35 · HIGH · The operator re-planned a step viberr had just refused, because the plan was only PARTLY refused

AX-18, 17:07:51. The operator's plan:

```
actions: ['deliver_for_review', 'transition_stage']
```

The delivery ran — it pushed `d44e874` to PR #16. The transition was refused. So:

```js
if (ctx.operatorRun && plan.actions.length > 0 && refused.length === plan.actions.length) {
    ctx.operatorRun.planWhollyRefused = true;
    ctx.operatorRun.refusedPlanSteps = refused.map(...);   // ruling 400's carry
}
```

`1 !== 2`. Nothing recorded. Fourteen seconds later the next drive planned:

```
actions: ['transition_stage']
```

…and was refused with a byte-identical message. Those two drives are precisely what tripped
the two-in-a-row hold in F39-33, which stranded the task and cost a human stage move.

Ruling 400 exists because "the refusals are on the timeline, read them" does not work. It is
gated on the rarer half of the cases. The commoner half — a plan that got somewhere and was
stopped partway — recorded nothing and taught the next drive nothing.

**The finding behind the finding:** three rulings in this pass (399, 406, 408) all tripped on
the same partial-versus-whole boundary. 399 because `planWhollyRefused` was false when one
step had succeeded; 406 because the effect list did not include the action the operator
actually took; 408 because the carry is inside the wholly-refused branch. The pattern is
viberr reasoning about a drive by what it FAILED to produce rather than by what it did.

Ruling 408.

## F39-36 · HIGH · The operator reached for the option viberr recommends, and the schema told it not to

AX-18, 18:04. The operator's own reasoning, recorded on the refusal note:

> Reviewer has issued two consecutive request-changes outcomes; the latest developer rework
> is delivered, but the current revision has no approval. Hold for the owner's governed
> choice before commissioning another review/rework round.

It planned an `open_packet` with a `question_reviewer` option. Refused:

> `open_packet` — A question_reviewer option needs the reviewer it asks — "Run one complete
> review of the current revision" names none. Pass profileId, or put the question in a
> comment instead.

The refusal is correct (ruling 237) and well worded. The problem is what the operator was
told beforehand. The option-level `profileId` in the Codex plan schema said:

> "retry_other_backend only: the agent profile to re-run. Null re-runs the agent whose run
> failed."

And `question_reviewer` appears **nowhere** in the packet-authoring guidance, which names
seven other kinds (`edit_goal`, `retry_other_backend`, `accept_completion`,
`block_on_policy`, `archive_task`, `discard_branch`, `resolve_remote_collision`) and their
required fields.

So the model read the schema it is structurally constrained by, concluded correctly that the
field did not apply to its option, and was refused for omitting it — twice, because the one
automatic retry re-planned the same step. Then the task stranded and a human had to move the
stage by hand.

This is ruling 377's shape one layer in: not a surface lying to a person, a schema lying to
the model it constrains. Ruling 409.

## F39-37 · HIGH · Five identical human decisions in one afternoon, on a call the operator could make

Found by asking the controller where the operator is weakest. It answered with my own
behaviour:

> The "reviewer is paying out findings one at a time → ask it for the complete blocking set"
> call has now been made by **you**, not the operator, on AX-4, AX-19 (16:42:46), AX-20
> (17:03:50) and AX-18 (17:31:03). […] In every one of those, the operator's response to the
> second request-changes was the same mechanical loop: move Review→Verify, post a rework
> directive, start the Developer.

A fifth followed on AX-22 at 21:47. The cause it named:

> It is the **policy engine**, not the operator, that counts consecutive verdicts and opens
> the packet. Nothing in its skill file or in `get_task` carries *"what the human decided in
> this situation last time"* — task.md holds only this task's decisions. Until something
> does, you will keep making this call once per task.

Verified: `REVIEW_DEADLOCK_ROUNDS = 2`, and the packet is raised inside the same locked write
that records the verdict — so the operator's next turn finds `waiting: human` and the
decision already gone.

Owner's call: give the operator the move rather than the memory. Ruling 410.

## Improvement points (not defects, and labelled as such)

The goal asks for improvement points in the operator's runtime as well as its bugs. These
are things viberr does correctly but incompletely; none of them is a lie or a lost piece of
work, so none became a ruling.

### The one cross-task fact viberr already computes, and does not give the operator

Ruling 236 computes, for every row of the review queue, which OTHER open pull request that
row's diff collides with, by shared repository path. Read live, all five open PRs carry one:

```
AX-18  PR #16  collides with AX-21
AX-19  PR #11  collides with AX-22
AX-20  PR #13  collides with AX-22
AX-21  PR #15  collides with AX-18
AX-22  PR #18  collides with AX-19, AX-20
```

`PrOverlap` is consumed by exactly one surface, `review-page.tsx`, which describes it as
"read-only and quiet by design: it orders nothing". `OperatorTaskSnapshot` has no overlap
field, and the operator is the actor that decides what to dispatch, when to deliver, and
whether to refresh a branch from its base.

This is the concrete half of what the controller named as the operator's third weakness:

> The operator cannot see another task's reviewer findings; `get_task` is single-task. So
> every cross-task correlation on this board is currently done by you.

Ruling 402 gave the operator its goal chain for the same reason. The overlap is the other
cross-task fact viberr already has and already computes, and it costs a projection read.

Not raised as a defect: nothing states a falsehood, the feature is explicitly informational,
and the collisions above have not yet cost this board a merge. Worth doing before they do.

### The file-lease system is manual and nothing proposes a lease

Ruling 396 gave file leases a human surface. Nothing SUGGESTS one — and AX-20 and AX-21
spent an afternoon contending over `internal/sandbox/local.go` (AX-21 blocked, a packet
raised, a human decision spent) which is exactly the collision a lease exists to prevent.
A lease proposed from the overlap above would have been the mechanism working ahead of the
problem instead of after it.

## F39-38 · MEDIUM · The op that unblocks a link did not start it, and the reply talked about a different link

Asked whether ten pending links were genuinely gated on AX-19 and AX-20, the controller
judged correctly that `ax apply -f` was not, and found why it looked gated: **one clause of
its acceptance** — "applying `examples/task.yaml` against a live control plane in a test
produces a Task that reaches `Succeeded`" — needs the Executor and the Workspace controller.
"One acceptance sentence was serialising the whole command behind both core tasks." It
rewrote the acceptance to what the merged surface can prove, named what was explicitly NOT
in the task, and cleared the wait.

Then:

```
AX-24 created 2026-09-22T19:12:06.394Z  goalRef (goal-4, 2)   ← the periodic tick
AX-25 created 2026-09-22T19:12:10.988Z  goalRef None          ← the controller, 4.6s later
```

Its own account: *"two reads showed link 2 with no task, so I created one (AX-25) — and four
seconds earlier the chain had already created AX-24."*

Both reads were honest. `edit_link` is the most direct way to make a pending link startable
and it was the ONLY `update_goal` op that did not advance the chain afterwards — `resume`,
`skip_link` and `add_link` all set `advanceAfter`. So the link sat until the tick. And the
reply could not have told the controller otherwise: `activeTaskKey` names the link the chain
currently rides on, which since ruling 398's fan-out is a different link.

`adopt_task` refused the duplicate correctly. The window that produced it was between the
edit and the tick.

**Two lessons.** Ruling 398 is mine, from this pass: I changed *when* a link starts without
sweeping the op that makes one startable. And the first fix I wrote here was a doc warning
asserting the behaviour already worked that way — which was false. The controller's account
of its own mistake is what sent me to read `advanceAfter` instead of shipping it.

Credit: it caught the duplicate, retitled AX-25 "DUPLICATE of AX-24 — do not work, archive
me", held it on AX-24 so no run could start, and said plainly that archiving is a human
surface it does not have. Ruling 411.
