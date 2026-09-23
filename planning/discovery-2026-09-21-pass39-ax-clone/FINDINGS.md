# Pass 39 findings — ax clone (2026-09-21)

Severity: **HIGH** = viberr lies, loses work, or blocks a path with no way out ·
**MED** = makes a person or an agent do something absurd · **LOW** = noted, not worked.

**Only what is still open is kept here.** The solved findings (F39-1 and F39-3 to F39-42) and
the improvement points were cleared on 2026-09-23 at the owner's request. Each one is recorded
in full, with its evidence, fix, test and canary, in its ruling (377 to 418) in
`docs/architecture/decisions.md`, and `PLAN.md` maps every finding to its ruling. The file as it
stood before the clear is in git history (`445dd449`).

---

## Found in the unattended 8-hour run (2026-09-23, from 01:07 local)

The owner asked for eight hours with no questions and a focus on the controller page for end
users. Design choices that would normally go to the owner are made here with the recommended
default and marked **(default, owner may revisit)**.

- **F39-43 (MED) — the round-5 deadlock packet recommends a question the operator asked in the
  run it escalates, and one a person declined earlier in the same streak.** AX-20, 22:08 UTC on
  2026-09-22: packet `pkt_qV5rjpJypcwX` "Reviewer has requested changes 5 times running". Its
  recommended option is "Ask Reviewer what else it would block on". But the run whose verdict
  raised it was dispatched at 21:59:29 with "provide the complete blocking set across your review
  surface, including anything you might otherwise defer" (the operator's ruling-410 question), and
  the answer was ONE blocker. Earlier in the same streak (18:48) the owner resolved the round-3
  packet with "Rework, not another question. I asked this reviewer for its complete set at round 2
  and it answered". The body hedges instead ("either it did ... or it did not ... The reviewer's
  own verdicts on the timeline say which"). Why the structure missed it: 416's signals are
  revision-shaped (`noReworkBehind`, `reviews > rounds`); the question was put on the first read of
  a reworked revision, and the round-2 answer predates the `reviews` field. Resolved as the owner:
  "Let the rework continue", with the reason and the one blocker (exit status lost across a
  control-plane restart). **It is the norm, not a one-off: three packets in 25 minutes.**
  AX-22 22:24 (round 5; the 22:17 directive said "Report all remaining blockers against this
  revision", the answer was two credential leaks) and AX-24 22:31 (round 4; the 22:20 directive
  said "Provide one complete verdict with every remaining blocker, including anything you might
  otherwise defer", the answer was one blocker). Every operator on this board folds ruling 410's
  question into the review that follows a rework, which is the efficient move, and every
  packet then recommended spending a reviewer run to ask it again. A fourth at 22:53 (AX-22
  round 6): that run judged only my two findings, but the question had been answered at round 5
  in the same streak, and the packet still recommended it. **Fixed: ruling 421.**

- **F39-44 (MED) — "waits on" sentences read a pending entry as done.** Ruling 356 put the done
  entries in a trailing parenthesis, `A (B is done)`. A goal link that has a task prints that
  task in a parenthesis too (`goal-2 link 1 (BNB-2)`), so the group reads as the last pending
  entry's annotation. "Other work: goal-1 link 2 (JC-3 is done)", pinned verbatim by a test, says
  goal-1 link 2 is done. It is the pending one. Live on the ax-clone Goals rail: "waits on
  goal-2 link 2 (AX-19), goal-3 link 2 (AX-20), goal-3 link 4 and goal-4 link 7 (AX-4, goal-2
  link 3 (AX-16) ... are done)" names AX-4 as goal-4 link 7's task. The same helper writes the
  task page's "Other work", the hold refusal, the run control, the operator's queue refusal and
  the skipped-schedule note. **Fixed: ruling 420.**

- **F39-45 (HIGH) — viberr's own workspace contract forbids a Codex agent from reading the
  rulings it is told bind it.** Found by the controller itself during a knowledge-base upkeep turn
  I asked for at 23:05 ("AX-19's developer couldn't read the rulings ... It's worth checking how
  agents get the rulings"). A Codex run has no `read_knowledge_doc` tool, so ruling 283's index
  tells it to read each document at its folder path (`/data/kb/ax-clone-rulings`), and ruling
  286 says the rulings bind it. The same prompt's workspace contract says "Work ONLY inside the
  current working directory ... One deliberate exception: ... the attachments folder ...
  Everything else outside the working directory stays off-limits." The runs are
  `danger-full-access` (verified in the rollouts), so nothing enforces the boundary, and agents
  split on which sentence to obey. They said so in their reports: AX-19 developer 22:13 ("the
  workspace-only filesystem boundary prevented access outside the checkout, and no
  knowledge-document reader was mounted"), AX-22 developer 22:44 ("I did not open the external
  ax-clone rulings documents because the workspace contract restricts reads to this checkout"),
  AX-24 reviewer 22:51 ("I could not open the attached rulings documents under the workspace
  restriction"). Others in the same hour read them anyway (the AX-22 reviewer, the AX-19
  reviewer). So every rulings upkeep (rulings 378 and 418, the controller's KB work tonight)
  reaches the agents that break the contract and misses the ones that keep it. **Fixed: ruling 422.**

- **F39-46 (MED) — every collision-aware directive stamps a false "delivery" policy note.** Ten on
  ax-clone between 22:00 and 23:25, all for a possessive before "open PR" ("AX-21's open PR also
  touches cli.go"), the sentence rulings 413 and 417 ask the operator to write. The task timeline
  showed a policy warning on nearly every dispatch. **Fixed: ruling 423.**

- **F39-47 (LOW-MED) — the operator plans the branch refresh the acceptance stage refuses, over and
  over.** Fifteen "The operator's plan was not carried out in full" notes across seven tasks
  (AX-9 ×3, AX-20 ×3, AX-22 ×3, AX-19 ×2, AX-24 ×2, AX-12, AX-18). Every one was
  `update_branch_from_base` at Review, which on this board is the acceptance stage. The doctrine said
  both "before you hand work to a reviewer" and "never at the acceptance stage", and reviews here
  run at the acceptance stage. The snapshot showed `baseBehindBy: 7`, and the intent quoted in the
  note said so ("the open PR is seven base commits behind"). The refusal was a sentence the model had
  to apply by working out which stage stands before Done, on a report's turn that returns before
  the stage rules. Cost: a wasted plan step and a timeline note a person reads as a failure, on
  nearly every rework. **Fixed: ruling 424.**

### The controller page, for the person using it (measured 2026-09-23, ax-clone, 6 chains)

- **U39-1 (MED) — Conversations and New sit under every goal chain.** Desktop 1440×900: the
  Conversations panel starts 4,419px down the page. Phone 375×812: 5,576px down, after the
  whole transcript. Starting or switching a conversation, the page's primary navigation, costs
  five or more screens of scrolling.
- **U39-2 (MED) — the page is a 10,876px scroll with ~3,000px of empty column.** The rail
  (goals 4,262px) scrolls with the page, and the grid row stretches the main column to the
  rail's height. The transcript scrolls inside the page, beside a rail that does not stick.
  On a phone the transcript is uncapped (12,625px) and the page scrolls to its end on every load
  (`scrollIntoView` scrolls every ancestor), past the header.
- **U39-3 (MED) — Cancel goal is one unconfirmed, irreversible click.** `cancel` is terminal:
  `resume` refuses a cancelled chain. Any other chain's link that waits on this chain's unstarted
  links then waits forever (`resolveDependencies` F37-63). The button is a plain ghost beside
  Pause and never sends the `reason` the route accepts. Skip on a failed link has the same shape.
- **U39-4 (LOW) — every chain renders every link, finished ones included.** Completed goal-1
  takes 479px to say four links are done. No chain states its progress.
- **U39-5 (LOW) — the controller console speaks task-engagement vocabulary.** "Controller ·
  supporting" (`roleShort` maps every non-delivering run to "supporting") and "thread can be
  re-engaged" on a conversation with no task.
- **U39-6 (LOW) — "⌘↵ sends" on every keyboard.** The page's and the dock's composers print the
  Mac glyph over a handler that takes Ctrl too. UI-55 fixed this elsewhere, and P13-D-39 called
  the comment composer "the last user-visible ⌘ in `app/`". It was not.

**All six fixed: ruling 419.** **Design calls made without the owner (default, owner may revisit):** New conversation lives
in the page head. On a phone a native select in the head switches threads. The rail puts
conversations first, sticks beside the conversation and scrolls itself. The transcript stays a
capped scroller at every width. Settled chains fold to one line. Cancel and Skip confirm, name
what they strand, and record an optional reason.

- **U39-7 (LOW) — the task page prints the operator's formatting marks, and every packet's note
  box asks about reopening.** AX-24's acceptance card read "Reviewer approved \`9471594\`." with
  the backticks showing. The operator writes a card's reason the way it writes every comment,
  and the card rendered it as plain text; a `run_agent` card's directive had the same problem.
  Under every decision packet (agent questions, deadlock rounds, conflicts) the note box's example
  was "e.g. what to change before reopening", which only fits the closed-pull-request packet.
  **Fixed:** the card renders its reason and directive with `RichText`, the one-line format
  renderer, and the example now reads "e.g. anything the operator should also know". Tests:
  `operator-recommendations.test.tsx` "inline format" (a canary on each of the two renders goes
  red) and the P21 custom-answer test pins the placeholder.

- **U39-8 (MED) — the Goals rail says what a link waits on in addresses, and calls a held link
  active.** Live on ax-clone (measured 2026-09-23 00:00): goal-6 link 1 read "active" over AX-6,
  which sits in Triage held by ten links. Goal-6 link 5's wait was a thirteen-entry sentence of
  references ("goal-4 link 6, goal-4 link 7, goal-5 link 1 (AX-5) …") that a person can only
  decode by scrolling to each chain. Goal-4 link 5 read "waits on AX-20 AX-21", AX-21 being its
  own task. **Fixed: ruling 425** (default, owner may revisit): held links read "blocked", as the board's
  card for the same task does; each wait
  is a count ("waits on 6 · 4 done") that opens to state, key and title per entry; the link's own
  task sits beside its title.

- **U39-9 (LOW) — the controller's working line speaks tool ids.** Live at 23:59 UTC, with a
  person watching their own question being worked on: "Controller is working… composing ·
  mcp__viberr_controller__read_default_branch_file · internal/client/client.go answered". The
  stored step is right for the run panel; the conversation row (and the dock's) is the person's.
  **Fixed:** `readableStep` drops the `mcp__server__` prefix and the underscores and reads a flat
  JSON input as its values ("get task · SHOP-31"). It leaves a payload the cap cut short exactly
  as stored, and keeps the stored text on the `title`. Tests: "U39-9" and the ruling-250 test,
  each red under its canary.

- **U39-10 (LOW-MED) — a person without Claude connected is told how to fix it in a placeholder.**
  Ruling 127's sentence ("…Connect it on your Profile → Agent accounts, then send your message
  again.") was the placeholder of the disabled composer, on the page and in the dock: placeholder
  grey on a disabled field, not a link, and cut after two lines on a phone, which is exactly
  where the remedy sits. Measured in a production preview with no Claude credential. The product's
  own rule for a disabled control is a visible note beside it (`.deny-note`). **Fixed:**
  `NotConnectedNote` prints the same sentence over both composers with "Profile → Agent accounts"
  linked. The box says "Connect Claude to send a message.", and the empty state's duplicate line is
  gone. Tests: the ruling-127 page and dock tests, each red when the note is dropped.
- **U39-11 (LOW-MED) — on a phone the agent-log console gives an agent's text 89px.** The 720px
  collapse only narrowed the three columns (54px time, 100px tag), so a 283px console printed the
  controller's report a word or two per line ("I didn't / touch AX- / 20, AX-22"). A long tool id
  such as `mcp__viberr_controller__write_knowledge_doc` pushed its detail past the edge into a
  sideways scroll (285px of 271). The same console is on every task page. **Fixed:** the console is
  a size container; under 30rem the time and tag share a row and the text takes the next one, full
  width (247px). A tool chip wraps, and its name may break anywhere. Tests: `app.css.test.ts`
  "U39-11" and the 1100px-collapse test, each red under its canary.
- **U39-12 (LOW) — the dock's header cuts the controller's own name on a phone.** At 375px the
  title and the scope pill share about 167px beside four icon buttons, and both were cut:
  "Contro…" next to "AX-21 · ax-cl…". **Fixed:** the pill shrinks first (`flex: 0 100 auto`),
  because the context line under the header names the scope in full. The title does not shrink at
  all: it is capped at 45% instead. A shrink weight alone still cost it a pixel in the production
  preview (79 of 80px, "Control…"). Measured after: title 80/80px, pill 85 of 103px, buttons
  inside the header. Test: `app.css.test.ts` "U39-12".
- **U39-13 (LOW) — a wrapped review-queue row scatters its chips.** Under 1100px the row wraps,
  and the chips kept the one-line row's right-justified 52% box. The first line hung indented, the
  rest fell back to the left edge, and "agent working" jumped to the far right. **Fixed:** once
  wrapped, the chips read left to right from the row's edge, and "Review ›" takes the end of their
  line. Checked with the rule injected at the pane's width and at 375px. Test: `app.css.test.ts`
  "U39-13".
- **Also (425(c) follow-up):** in the rail a long link title now wraps beside its pill (8rem
  basis) with the pill on the title's first line (`align-items: baseline`).
- **U39-14 (MED) — a decision notice in the notification stream is the whole packet body.** A
  resolved decision falls from "Waiting on you" to the stream, which printed `from · text` and no
  title. The text of a deadlock notice is the full packet body, so the notifications page showed
  fourteen-line walls (AX-20 round 7, AX-22 round 9). The bell already showed a title plus two
  clamped lines. **Fixed:** a titled notice reads as its title, then its body clamped to two lines,
  and the task holds the rest. Test: `notifications-page.test.tsx` "U39-14".
- **U39-15 (LOW) — `code` inside **bold** printed its backticks.** The lease notice's headline is
  written as "**AX-22 now holds `internal/controller/task.go`…**", and every notification row and
  timeline line using the one-line renderer showed the marks. A test pinned the limitation
  ("does not nest"). **Fixed:** `RichText` renders code inside a bold run. The test now pins the
  rendering, and the "U39-15" canary goes red without it.
- **U39-16 (MED) — on a phone the notification stream reads a word per line.** Measured at
  375px: the text column was 90px beside Mark read, the dot and the time, and the overlay scrolled
  sideways (372px of 241). **Fixed:** in the 560px block the trailing controls take their own line
  under the text. Checked in a production preview with the rule injected: text 201px, controls
  below. Test: `app.css.test.ts` "U39-16".
- **U39-17 (LOW) — a sha or a path in a notice pushed the phone overlay sideways.** A 40-character
  sha in `code` and bare paths like `internal/controller/gateway.go:1016` are unbreakable runs.
  The overlay measured 413px of scroll in a 323px box. **Fixed:** stream text wraps long tokens
  anywhere (`.pev-main`). Measured with the rule injected: 323 of 323. Test: `app.css.test.ts`
  "U39-17".
- **U39-18 (LOW) — the task page and the chain history name people by their address.** "Released:
  arda@viberr.dev · via controller cleared the wait on AX-22" on AX-20's timeline, and "Link 2
  edited by arda@viberr.dev · via controller" in the chain's history. The label is the audit form
  (ruling 99(b)). **Fixed:** `actorProseName` gives the display name, with the controller in words
  ("Arda (via the controller)"). Used by the release note, the link-wait mirror and every goal edit.
  The four tests that pinned the address now pin the name. Test: `dependencies.server.test.ts`
  "U39-18".
- **U39-19 (LOW) — conversation titles are 79 characters cut mid-word.** The rail and the phone's
  thread switcher read "Knowledge base check, please. Since the ax-clone knowledge bases were last
  writ…" and "AX-20 has to land before AX-22. AX-21, AX-5 and goal-6 wait o…". **Fixed:** a thread
  is titled by the person's first sentence when that names something (at least 20 characters) and
  fits (80 at most). Otherwise the text is clipped at a word. "(PR #19)." ends a sentence and
  "0.19.0" does not. Existing threads keep their stored titles. Test:
  `controller-conversations.server.test.ts` "U39-19".
- **U39-20 (LOW) — the home page's project card prints the description's backticks.** "A working
  Go clone of Google's \`ax\` (github.com/google/ax)…", as the controller wrote it. **Fixed:** the
  card renders it with `RichText`. Test: `home-page.test.tsx` "U39-20".
- **U39-21 (LOW) — a decision packet's options print their backticks.** The body already rendered
  inline code; the options, written the same way, did not ("It answered this on \`7920943\` in
  this streak" on every deadlock packet). **Fixed:** option titles and descriptions use the card's
  own `renderInlineCode`, on both the live and the decided card. Test:
  `task-detail-components.test.tsx` "U39-21".
- **U39-23 (LOW-MED) — an agent's question says "(Recommended)" twice, and could put the pill on
  the wrong option.** Codex agents mark their pick in the option title, as in "Coordinate core
  status work (Recommended)" on AX-27 at 01:21. The builder also marks the FIRST option `rec`, so
  the card showed the mark beside its own `recommended` pill. The answer, the summon note and the
  decision record carried it too: "**Decision:** Coordinate core status work (Recommended)." Four
  such questions on this board (AX-9, AX-12, AX-22, AX-27). Every one marked its first option. A
  mark on any later option would have put the pill on one choice and the agent's words on another,
  because the Codex envelope never said which option is presented as suggested; `ask_human` tells
  Claude. **Fixed:** `buildAgentQuestionPacket` strips a trailing "(Recommended)" and recommends
  the option it marked, or the first when none is. The envelope's `options` now says the first is
  presented as suggested. Test: `agent-outcome.server.test.ts` "U39-23".
- **U39-24 (MED) — the controller quotes UTC clocks on a page that prints local ones.** On the
  ax-clone controller page, in a bubble the page stamped 03:57: "AX-20 is back in Verify. The move
  went through as yours at 00:57:02 … Your 00:43 directive tells the operator …". The person reads
  in Istanbul (UTC+3), so every time in the reply was three hours off from the timeline beside
  it. The page renders every instant in the viewer's zone (`format.ts`), and every tool gives the
  controller UTC ISO strings. It copied the clock and dropped the `Z`, so nothing marked the times
  as UTC. **Fixed:** both composers post the browser's zone with each message. The engine
  normalizes it: anything `Intl` refuses, or anything too long to be a zone name, is dropped. A
  queued message carries its own zone. The turn's context read says "They read times in
  Europe/Istanbul (GMT+03:00), where it is 03:57 now", tells the controller to quote times in
  that zone, and to give the zone with a time it writes onto a task or goal, where others read
  in their own zones. Tests: `time-zone.test.ts`, `controller-context.server.test.ts` "U39-24",
  and the assembled-prompt, page and dock send tests.
- **U39-25 (LOW-MED) — every controller turn's console opens by calling itself a faulty
  specialist run.** The Live run panel on the controller page, 04:49: "Run inputs — supporting
  engagement · NO canonical anchor · persona 39315 chars · prompt 6999 chars · 1 skill · 2
  knowledge bases · 0 MCP servers". Two lines below, `system·init` reads "mcp: viberr_controller,
  viberr_ops". A controller turn is not an engagement. It is never handed a canonical block, so
  the capitalized NO flagged the design as a fault. It mounts two servers, not zero, because the
  count came from the prompt's list of org grants. Ruling 346 had fixed the same vocabulary in the
  expandable detail rows, by run kind, and left the headline everyone reads. **Fixed:** the
  headline takes the run's kind ("controller turn", "operator drive"; specialists unchanged) and
  drops the anchor bit where no anchor is ever given. A controller turn records every server it
  mounted. Tests: `run-inputs.server.test.ts` and `controller-run.server.test.ts` "ruling 344".
- **U39-26 (LOW-MED) — the Live run strip above the conversation printed raw tool ids.** 02:19,
  controller page: "composing · mcp__viberr_controller__read_knowledge_base_doc · id:
  kb_HZpcYS3sovrJ · path: architecture.md answered". U39-9 made the conversation's own working
  row readable and left the strip raw on purpose ("right for the run panel"). That was my call,
  and it was wrong for the people this page is for: the strip sits directly above the
  conversation, on every task page too, and the Agent logs console below it is already the
  technical record. **Fixed (default, owner may revisit):** the strip reads the step through the
  same `readableStep` (moved to `app/features/runtime/readable-step.ts`), with the stored text
  on hover. Test: `runs-panels.test.tsx` "U39-26".
- **U39-27 (LOW-MED) — the goal chains' controls were too small for a finger.** Measured on the
  controller page at 375px with a coarse pointer: 12 "waits on …" summaries and 6 "Show all N
  entries" buttons at 15px tall, 68 wait-entry keys and 21 link task keys at 16px, and "Show
  everyone's (org admin)" at 15px. WCAG 2.5.8 asks for 24px, and these sit in lists, not
  sentences. **Fixed:** on a coarse pointer each gets `padding-block: .3rem`, so the hit area
  grows and the text stays put (measured with the rule injected: 24.1 to 25.1px, no horizontal
  scroll, no two targets overlapping in an open list). A first overlap count of 81 was an
  artifact: Chrome lays out the contents of a closed `<details>`, so its hidden entries
  measured on top of each other. Test: `app.css.test.ts` "U39-27".

- **U39-28 (LOW) — the run loading its tools read as SDK jargon.** 03:28, the controller page's
  working row and Live run strip on a fresh turn: "composing · ToolSearch · query:
  select:mcp__viberr_controller__get_task,mcp__viberr_controller__list_decisions… answered". Nearly every
  controller turn opens this way (its MCP tools are deferred behind the SDK's `ToolSearch`), so
  the first thing a person reads about the work is the loader's query syntax. **Fixed:**
  `readableStep` reads it as "loading tools · get task, list decisions", and a keyword search as
  "looking up tools · …". The stored text stays on the `title`. Test:
  `controller-page.test.tsx` "U39-28".

- **F39-48 (HIGH) — an operator's lease parked the board's critical path behind its slowest
  review.** AX-22's operator leased `internal/controller/task.go` and `task_test.go` at 23:47
  (following a decision that said "resolve the overlap before delivery"), although AX-20's open
  PR #13 already changed both and AX-21, AX-5 and goal-6 waited on AX-20. AX-20's operator then
  made AX-20 wait on AX-22 at 00:09. The finished AX-20 rework could not be delivered or reviewed
  while AX-22 ran its ninth review round. Neither operator could see the chain. The owner had the
  controller move the lease (00:11, it reported the side effect: AX-22 can now deliver nothing until
  AX-20 merges). **Fixed: ruling 426.**
- **F39-49 (MED-HIGH) — the snapshot says a rework is on the pull request when it is not.**
  Right after the lease was moved, AX-20's operator dispatched the reviewer without delivering.
  `7ce74b2` (the rework) was only in the workspace, PR #13 carried `c5001a3` (rejected at 23:11),
  and the snapshot said `unpushedRevision: null`. The reviewer reads the pinned revision from the
  workspace, so its 00:21 verdict judged `7ce74b2` correctly. (I first logged that it re-reviewed
  the rejected head; its evidence says "pinned revision matches 7ce74b2".) What was false: GitHub
  showed the rejected code, the task page showed no unpushed notice, and nothing prompted a delivery
  before acceptance. Cause: the reconciler's never-pushed probe asked the 404 predicate of
  an endpoint that answers 422 (ruling 223 fixed only the acceptance probe), and its test fixture
  answered 404. **Fixed: ruling 427** (the live AX-20 record needs the deploy to correct itself).
- **F39-50 (MED) — a base refresh publishes work past a file lease.** At 00:11:38 AX-22's operator
  ran `update_branch_from_base` at Verify. The push "published it, so origin now carries the
  workspace head, including the 1 workspace commit origin was missing", which was the unreviewed
  allow-list rework. AX-22's branch changes `internal/controller/task.go`, leased to AX-20 a minute
  earlier. The delivery push would have refused it (ruling 245). The refresh door carried the
  store-layout gate (ruling 159(b)) and not the lease gate. **Fixed: ruling 428.**
- **F39-51 (HIGH) — the operator has no way to bring merged work into a rework at the acceptance
  stage.** AX-20 00:41: the deliverer could not build its WorkspaceController-backed regression
  without AX-19 (merged), and asked. I answered: move it back to Verify and refresh there. At
  00:47 the operator's `transition_stage` was refused and its plan aborted ("Coordination
  stopped"). The refusal read "rework needs a failing verdict or a revision that changed after
  one; this task has neither", although the revision HAD changed after its verdict. Ruling 162
  refused the refresh at Review, and ruling 163 licenses a changed revision only a move into
  Review, where it already stood. Every door was shut, and the refusal lied about why.
  **Fixed: ruling 429** (default, owner may revisit): the acceptance-stage refusal applies only to
  approved work, and the refused move now says where the re-verdict is given.
- **F39-52 (HIGH) — a plan keeps acting after its own step opened a blocking decision, and tells
  the agent something false.** AX-21 01:18, right after AX-20 merged: the operator's plan was
  [`update_branch_from_base`, `run_agent` Surface Developer]. The refresh conflicted (cli.go,
  client.go, server_test.go), aborted, and opened the blocking packet "`ax-21` conflicts with
  `main`". The dispatch still ran, with "The operator has updated the branch from the changed base;
  start from that branch". A run was spent on a stale branch while the task waited on a person.
  **Fixed: ruling 430.**
- **F39-53 (MED) — the operator quotes a lease that no longer exists.** Same directive: "AX-22
  currently holds `internal/server/server.go` and `internal/server/server_test.go`; do not change
  those paths while the lease is active". I had removed that lease at 00:52, the developer's prompt
  listed none, and `server_test.go` was one of the conflicting files. The operator's snapshot had no
  lease list, only the 23:47 timeline note. **Fixed: ruling 431.**

- **F39-54 (HIGH) — a clean run withdrew a standing branch conflict as "moot".** AX-21, 01:24:31.
  The conflict packet "`ax-21` conflicts with `main`" had opened at 01:18, and the same plan sent
  the Surface Developer onto the branch anyway (F39-52). The developer found the conflict, changed
  nothing, said so ("Blocked on the unresolved AX-21/main conflict; no lasting changes were made")
  and asked "Resolve the AX-21 conflict with main", which was held because a decision was open.
  Its run had ended without an error, so the timeline then read "**Packet withdrawn:** \"`ax-21`
  conflicts with `main`\" is moot. The Surface Developer agent run completed successfully after it
  was opened." The conflict stood, PR #15 was still `conflicting`, readiness went back to `ready`,
  and the held question pointed at a decision that no longer existed. The operator spent the 01:27
  turn reopening it ("The prior conflict packet was withdrawn after the run completed; this report
  confirms the conflict remains"). The owner ruling of 2026-07-18 was about stall packets. The code
  took every blocked packet without an acceptance option, which includes conflicts, lease orders,
  agent questions and every decision the operator writes. **Fixed: ruling 432.**

- **F39-55 (HIGH) — a Codex operator could name three option kinds and never complete them.**
  AX-27, 01:40. I answered the Surface Developer's question with "Offer me a create_task option
  for the Developer (the core owner)". The operator tried, and its plan was refused:
  "`open_packet` — \"Create core task: Persist terminal Task execution details\" is a
  create_task option with no task on it. Give newTask a title and a goal". The Codex plan's
  option object has no `newTask` field, nor the `blockedBy` of `block_on_dependencies` or the
  `dueAt` of `wait_for_window`. All three kinds were in its enum, and each refusal asked for a
  field the plan could not send. AX-4 hit the same refusal twice earlier in the pass. Ruling 270
  fixed exactly this on the Claude tool in pass 37. The Codex door was never touched, and on this
  board every operator is Codex. **Fixed: ruling 433.**

- **F39-56 (HIGH) — a torn Codex rollout stranded AX-5, and the packet blamed the credential.**
  01:49: I answered the Developer's question, it was resumed, and the resume died with "rollout
  at …/rollout-2026-09-23T01-25-02-01a0cbdd….jsonl does not start with session metadata (code
  -32603)". The file's first line was `task_started` (ordinal 1) written over the head of
  `session_meta`, whose tail sat on line two. 3 of 541 rollouts here have that shape, all Codex
  CLI 0.156, so the collision is inside the CLI. Viberr's part: the probe said `present`, the
  classifier said "Review its authentication and runtime configuration", and the run was never
  marked, so an @mention or an answered question (the two paths that resume) would have picked
  the same dead session again. The packet's options were fine: they dispatch through the
  operator, which starts fresh, and that is how AX-5 recovered at 02:18:49 (I first wrote that
  every option resumed; the live run showed otherwise). **Fixed: ruling 434.**

- **F39-57 (MED) — the operator was told a resolved PR still conflicted.** AX-21, 01:57:47: the
  refresh merged main in cleanly and pushed `5241ef1`. GitHub answers "unknown" for a while after a
  push, so the reconciler kept the last-known `conflicting`, as designed (P14-LV-07). Ruling 405
  pinned that value to the head it was measured on, and the acceptance gate and the pills read the
  pin. The operator's snapshot did not: at 01:58:49 it told the reviewer to "note whether the PR's
  current conflicting mergeability status prevents acceptance". The acceptance-stage refresh
  boundary (my own ruling 429) and the review queue's row read the raw field too. `clean` arrived
  at 02:01. **Fixed: ruling 435.**

- **F39-58 (HIGH) — the controller could not read the files its rules are about.** 02:08, during
  the rulings upkeep I asked for: `read_default_branch_file` on `internal/runtime/executor.go`
  came back from the Claude CLI as "result (57,835 characters across 1,930 lines) exceeds
  maximum allowed tokens. Output has been saved to …". Viberr's per-read cap was 60,000
  characters. The CLI's MCP limit is 25,000 tokens, and the controller has no `Read` tool for
  the saved file. Anything over the cap was clipped to 60,000, which the CLI refused just the
  same, and anything over 240 KB overflowed git's buffer and read as "unavailable". The
  controller said it plainly: §9 of the rulings "rests on reviews, not my own reading of the
  code", because it could not open `executor.go` or `local.go`. **Fixed: ruling 436** (pages of
  whole lines under the CLI's limit, `fromLine` on both the controller's and the operator's tool,
  each page naming the next).

- **F39-59 (LOW) — an agent learned it cannot fetch by failing, and spent the run on it.** AX-29,
  02:34: my answer to the Surface Developer's question said the branch would be brought up to
  date. It went to the asking agent (O39-a), which ran `git fetch origin`, got "could not read a
  username", and reported that it "could not refresh `origin/main`". The workspace contract
  says Viberr refreshed `origin/*` for the run and forbids `git push` ("no push credentials by
  design"), but never says a fetch cannot work, so an agent finds out by trying. The clone-failure
  branch of the same contract already warns that credential talk sends a person after a false
  lead. **Fixed:** a cloned workspace's line now says it holds no GitHub credentials, so `git
  fetch` and `git pull` cannot reach origin, and that the operator brings the branch up to date
  on the server. Test: `specialist-run.server.test.ts` "F39-59".

- **F39-60 (LOW) — the operator could not tell which packets were its own to withdraw.** AX-28
  02:12 and AX-31 02:39: each operator judged an agent's question already answered and planned
  `resolve_packet` on it, and each was refused ("raised by agent:codex/developer
  (Implementation), not by you. Only a human can resolve an agent's question"), leaving a "plan
  was not carried out in full" note. The snapshot handed over the packet's content "to judge
  whether the packet is now moot" and never who raised it. **Fixed: ruling 437.**

- **F39-61 (HIGH) — the operator refused the conflict resolution Viberr itself recommends.** AX-28
  02:45: after AX-32 merged, the refresh conflicted in `internal/controller/task.go` and the packet
  recommended "Have Surface Developer resolve the conflict … it merges and resolves the
  conflicting files". I routed it to the Developer instead (task.go is core). The operator
  answered "the operator rules prohibit agent-side merges" and opened "AX-28 base conflict has no
  supported resolution path", with "Provide a supported conflict-resolution path" as the
  recommended option. Its doctrine said "never ask an agent to rebase, merge, or force-push" with
  no exception, while the product's only in-product conflict path is an agent merge (rulings
  133(b), 163). On AX-21 at 01:40 the same answer had gone through. The fix was live the moment
  the persona file changed, since the operator reads it per run. **Fixed: ruling 438.**

- **F39-62 (HIGH) — a base refresh cost a passing approval, and pinned the reviewer to the code
  the refresh replaced.** AX-29, 02:43–03:16 UTC. The owner's directive was "wait on AX-32, then
  bring the branch up to date with main, rerun make gate and make race, and deliver", and the
  operator did exactly that. At 02:44:06 `update_branch_from_base` merged `main` onto the
  delivered revision `4e6c47d` as `278c1ed` and pushed it. At 02:45:47 the reviewer was dispatched
  to run the gates "after the AX-32 base refresh", but no PR existed yet, so ruling 238's re-pin
  (which reads a drift the reconciler measured at the PR head) had nothing to read, and the
  reviewer was detached at `4e6c47d`. Its gates failed on exactly the four runtime tests AX-32 had
  fixed. It approved only because it noticed on its own that `ax-29` had moved ("my initial runs
  were on the detached pinned commit `4e6c47d`, before I noticed the branch-ref mismatch") and
  reran on `278c1ed`. Sixty-five seconds later `deliver_for_review`'s post-push reconcile saw a
  workspace head whose tree differed from the revision's, because a base merge always changes the
  tree, and minted `278c1ed` as a new revision. The approval went stale, validation went back to
  `changed`, and the task sat at Review "Waiting on a human" with "Not acceptable yet. Waiting on 1
  required reviewer approval of the current revision". No reviewer was running. The operator's
  next two drives re-applied the finished directive: a wait on the already-merged AX-32 (held
  37 seconds, then "released" with "the base branch has changed since the hold") and a refresh
  that was already current. Ruling 238 rejected "minting a revision for every base refresh"
  because "it would stale passing approvals too, so a refresh on a task that was ready to accept
  would cost a full re-review round". That is what the delivery reconcile did, one step later.
  I got the task moving as the owner by pressing Run operator. **Fixed: ruling 439.**

- **F39-63 (LOW-MED) — a wait on a task that was already done was written, then released with
  a false sentence.** AX-29 02:59:49: the operator re-applied the finished directive's first
  step and added AX-32, merged sixteen minutes earlier. Viberr wrote "Waits on AX-32 … Held
  until every entry is done", released it 37 seconds later, and the release note said "the base
  branch has changed since the hold, so the work re-reads it before continuing". Nothing had
  merged. The operator drive that release paid for planned a refresh of a current branch ("AX-32
  landed after the hold") instead of the review it owed. **Fixed:** `setTaskDependencies`
  refuses an ADDED task entry that is already done ("AX-32 is already done, so waiting on it
  holds nothing. Leave it off the list."). The operator gets that sentence as the step's answer.
  An entry that finished while already on the list is still the engine's to release, and a
  settled goal link stays a valid wait (ruling 398(b)). Test: `dependencies.server.test.ts`
  "F39-63". Two existing tests had added a done task to set up a later state. They now add it
  while it is open and finish it afterwards, which is the order the product allows.

- **F39-64 (MED) — the refresh wrote "the heads are equal" one line below the merge it had just
  pushed.** AX-29 03:34:55, accepting as the owner: "Accepting the completion brought `ax-29` up
  to date with `main` (4 commits merged in, merge commit `8c73b62` …). The review PR's head now
  equals the reviewed revision." It did not: the reviewed revision was `278c1ed`. The reconcile
  after the push read PR #23 before GitHub showed the new head, so the task file still carries
  `pr.headSha: 278c1ed` and no drift. The ceremony merged `8c73b62` two seconds later, and the
  permanent completion record ("Human acceptance recorded …") says nothing about the refresh the
  acceptance shipped. That record is exactly what ruling 318 exists to keep honest, and the fact
  was in hand: Viberr had just pushed that sha. **Fixed, extending ruling 439:** when the PR's
  recorded head is not the pushed merge, the drift comes from Viberr's own refresh record, and
  when that cannot reach the head either, the sentence says the drift was not re-measured.
  AX-29's live record stays as written; it is history. Tests: `update-branch-operator.server.test.ts`
  "F39-64" and the ceremony test in `task-actions.server.test.ts`.

---

## Open: noted, not worked (nitpicks, recorded so the next pass does not re-find them)

- **A base conflict is narrated as a step that "did not apply".** AX-21 01:18 and AX-28 02:43:
  "The operator's plan was not carried out in full. This step did not apply to the task's
  current state: `update_branch_from_base` — `ax-28` CONFLICTS with `main` … Opened a blocking
  decision packet". The step did apply: it tried the merge and opened the decision. The body is
  accurate and the "Blocked: … conflicts" event above it says the same, so it is a headline
  repeated, not a lie that costs anyone. The conflict arm returns `noop` on purpose (the LV-03
  split keeps a state refusal from being blamed on policy, and five tests pin it). Returning
  `done` when the packet opened would drop the note, and ruling 430's pause note would still
  cover any later steps. Left for the next pass.

- **O39-a (owner's call) — an answer that routes work to ANOTHER agent summons the asking one.**
  AX-22 23:38: the developer asked "Route the Gateway CLI and documentation follow-up?" and
  offered "Hand off to Surface Developer (Recommended)". I picked it. `resolvePacket` summoned the
  ASKING agent ("@developer … This is the decision you were blocked on. Continue from where you
  stopped and act on it"), and the developer did the Surface Developer's edits itself (23:46,
  "The Surface Developer follow-up is committed"), crossing the ownership rule it had asked about.
  The work landed in the right PR, so nothing was lost, but the option said one thing and the
  routing did another. Two defensible designs: the summons goes to the operator whenever the chosen
  option names a different profile, or agent-authored options may not name another profile. Left
  for the owner. **Second instance, with a cost (AX-20, 00:43):** the developer asked "Synchronize
  AX-20 with current main?". My directive was addressed to the operator ("Operator: move AX-20
  back to Verify … update_branch_from_base"), and the developer was summoned with "Continue from
  where you stopped and act on it". It spent a run finding it has neither tool and asked me to
  have the operator do it (00:45:39). Meanwhile the operator's run from the developer's previous
  report posted "Recommend holding review until you resolve the existing packet's sync choice"
  (00:44:14), 23 seconds after I had resolved it, reading a snapshot taken before the answer.
  **Third instance (AX-27, 01:37):** the Surface Developer asked "Resolve missing status data for
  AX-27" with "Coordinate core status work" as its pick. My note asked for an operator action
  ("Offer me a create_task option for the Developer (the core owner)"). The Surface Developer was
  summoned, wrote out the task it would propose, and ended with "I can't create the task or post a
  separate timeline comment because this run has no Viberr task-creation or comment tool … cc
  @operator" (01:38). Three of three answers that named another actor went to an agent that could
  not act on them. Each cost one agent run, and each recovered on the operator's next turn.
  AX-27's operator did try the create_task option at 01:40, which is where F39-55 surfaced.
- **O39-b (owner's call) — a deadlock streak writes the same canned decision into the contract
  every round.** AX-22's goal now carries four identical "Let the rework continue — Each round has
  found something real and the work is converging on it" blocks, each followed by the same
  "part of the task's contract from here on" paragraph. The substance, my note each time, goes to
  the timeline and the summon (ruling 284). Ruling 329 chose deliberately that the option's `d` is
  contract text, and ruling 415's `humanDecisions` reads every decision from the timeline anyway.
  Options: treat "Let the rework continue" as process-only (ruling 189's own test: it decides
  what happens next, not what the work is), or append a repeated decision once. Not changed: it
  re-opens a ruling the owner made.

- ~~**A full 40-character sha scrolls a task page sideways on a phone.**~~ **Fixed, ruling 419(i)**
  (2026-09-23): re-measured on AX-19 the page no longer scrolled, but inline code (the sha, long
  file paths) still ran past the column and was clipped; inline code now breaks where it must.
- **O39-c (owner's call) — two green pull requests merged a minute apart left main red, and
  nothing in Viberr can notice.** AX-22 (PR #18, 01:53:45) made a Task's Model wait on Gateway
  routes. AX-26 (PR #20, 01:54:26) and AX-20 before it ship runtime tests that create a Model with
  no Gateway. Each branch passed its own gates and review. On main (`8f449da`) `go test
  ./internal/runtime` fails: Tasks stay Pending on "waiting for dependencies: no Gateway routes to
  Model \"model\" yet" (four tests). Every task's `make gate` now fails there, and AX-21's
  reviewer requested changes partly for it. Viberr was honest: the acceptance dialog says the
  checks are unreadable ("merging does not wait for it") and that the base is merged in first,
  and I accepted both. But nothing runs the head that actually merges, and nothing watches main
  afterwards. Two designs, for the owner: (1) when an acceptance brings base commits in and no
  check result can be read, the dialog recommends a verification run at the refreshed head
  before merging (ruling 238 already re-reviews at a refreshed head, only earlier); (2) after a
  merge, Viberr runs the project's gate on the default branch and raises one board-level
  decision if it fails. I asked the controller for an urgent core task to fix the fixtures.
- **A resumed controller session keeps the model identity it started with until it compacts.**
  After the switch to Opus 5.5 the controller found "Opus 5 ... claude-opus-5[1m]" in its own
  context: ruling 373 records its prompt on the session's first request and replays it. It trusted
  the SDK's start record instead and said why, so nothing it told a person was wrong, and the
  next completion compaction re-renders the prompt.

- **`mode: off` is written unquoted, which YAML 1.1 reads as `false`.** 21 instances in the
  live store, all of them `capabilities[].mode`, and it is the ONLY ambiguous bare value the
  store contains (no `on`/`yes`/`no` anywhere). Viberr itself is correct — the `yaml` package
  parses YAML 1.2 core, where `off` is a string — but "files are truth" means other tools read
  these files, and `python3 -c "yaml.safe_load(...)"` returns `False` here. Harmless in
  practice, since `off` and `false` mean the same thing to a reader; recorded so the next pass
  does not re-derive it, and because quoting the enum in the serializer would cost nothing.
  (Found by misreading it myself.)
- **The accept dialog hedges a fact it has.** AX-28 03:31: "ax-28 is brought up to date with
  main first. If the base has moved, that merge commit is pushed to the branch and becomes the
  merge head." The branch already contained main (`7022aa5`), which the PR's `mergeable: clean`
  at the reviewed head also says, so the merge head WAS the reviewed head. The sentence is
  accurate, and naming which case applies would spare the reader a look at GitHub.
- ~~**Insights "By task" lists controller conversations as `/cnv_…`.**~~ **Fixed, U39-22**
  (2026-09-23): controller turns are one row, "controller conversations". Test:
  `insights-query.server.test.ts` "U39-22".
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
