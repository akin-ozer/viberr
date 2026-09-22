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

## Noted, not worked (nitpicks, recorded so the next pass does not re-find them)

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
