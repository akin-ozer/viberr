# PRD / UX-spec alignment — pass 20

> Reviewed 2026-08-14 against `main @b97ad02` in the pass-20 inspection worktree.
> Canon read: `planning/planning-artifacts/prd.md`, `…/ux-design-specification.md`,
> `docs/architecture/decisions.md` (rulings 1–75). Current state read:
> `planning/discovery-2026-08-14-pass20/reference/UI-INVENTORY.md`, `NOTES.md`,
> `FINDINGS.md`, `USE-CASES.md`, the 34 top-level screenshots and the `screenshots/uc/`
> set, plus direct reads of the tree for every claim below.
>
> Method note. Per `planning/README.md`, docs are living: where the app and a doc
> disagree and the app is right, the doc gets corrected with a note. So **List 1 is
> not a defect list** — it records divergences the canon already sanctions, with the
> ruling that sanctions each, so the next pass does not re-file them as gaps.
> **List 2 is the critical list**: app behaviour that differs from a canon statement
> with *no* amendment note and *no* ruling behind it. **List 3 is independent of the
> canon** — coherence problems a demanding reviewer would flag even if the PRD did
> not exist.
>
> No app code was modified in producing this document.

---

## List 1 — Deliberate divergences (sanctioned)

Each row: what the doc says, what the app does, and the ruling / amendment that
sanctions it. "Recorded in place" means the PRD or UX spec already carries the
amendment note; "decisions.md only" means the divergence is sanctioned but the
requirement text still reads the old way in at least one place.

| # | Canon statement | What ships | Sanction | Recorded in place? |
|---|---|---|---|---|
| 1 | **FR5** — "Admin users can create and configure governed delivery projects" | Project creation is self-serve for any authenticated user; the creator is seeded project **admin**. `create-project` consults no org role. | PRD FR5 amendment (2026-08-06, F19-29), promoted under **ruling 44** (R17-3) | Yes |
| 2 | **FR7** — repo default "and allow task-level overrides" | One repo per project, no task-level override; the toggle and its copy were deleted | PRD FR7 amendment (2026-07-25, owner ruling) | Yes |
| 3 | **FR11** — tasks created by users "and authorized agents" | Task creation is human-only; an agent that wants one routes a decision packet. Additionally, new tasks are created at the **entry stage only** | PRD FR11 amendment (2026-07-25); entry-stage restriction is **ruling 70** (R19-14) | FR11 yes; entry-stage rule decisions.md only |
| 4 | **FR14 / FR20** — "one primary specialist and additional consultant specialists" | One uniform `engagements[]` list: exactly one `delivers: true` (delivering engagement, single-writer of workspace/branch/PR), all others supporting; a supporting engagement with a `verdictCapable` snapshot is a *required reviewer* | PRD FR14/FR20 amendment (2026-08-04, pass 17 — D9 / Q17-5) | Yes |
| 5 | **FR27** — "transition to `done` … human-authorized" | Four sanctioned endings rather than one: (a) human acceptance → real async merge; (b) full-autonomy operator with an explicit `completion-for-acceptance: direct` grant → Done with **merge pending**, never a merge; (c) **"Completed — no changes"** — no PR, no merge, own timeline event; (d) audited admin **force-accept** | **ruling 2** (narrowed), **ruling 40** (R16-6), **rulings 43 + 62** (R17-2 / R19-8), **ruling 59** (R19-5) | Yes — FR27 carries all four amendment notes |
| 6 | **FR27** — acceptance is verdict-gated | A **project member's GitHub PR approval**, bound to the delivered revision and failing closed, satisfies the verdict gate | **ruling 68** (R19-B) | decisions.md only — FR27 does not mention the human-approval path |
| 7 | **FR31** — branch/PR creation tied to the review stage | Delivery (push + open PR) is an **operator decision**, not a stage side-effect; human delivery button is the escape hatch; entering a review stage with no PR writes a typed event | **ruling 21** (R15-2) | Yes |
| 8 | **FR4** — commenting is "app-wide … including projects they are not a member of" | Projects are **members-only**: a non-member gets a 404-equivalent on every project surface, so "app-wide" means "across visible projects" | **ruling 25** (R15-4) | Yes |
| 9 | **FR33** — "preserve an auditable history" | Audit rows are hard-deleted after **90 days** by a boot-time retention pass; no export in V1 | PRD FR33 bounding note (2026-07-25) | Yes |
| 10 | **NFR1–NFR4** — four numeric latency targets | All four struck and replaced by qualitative requirements; no performance harness exists | **ruling 63** (R19-9) | Yes — §Responsiveness rewritten |
| 11 | **NFR8** — separate permission boundaries "on every governed action" | **MCP server grants sit outside the capability matrix**: granting a server *is* the authorization for its tools, so a withheld `execute-code-or-write-repo` does not bound a granted server's write tools | **ruling 39** (R16-5) | **No — see D13.** Ruling 39 cites "the PRD/NFR8 amendment note"; `prd.md:278` carries no such note |
| 12 | **UX spec §Design System / §Color / §Typography** — token values, IBM Plex Sans/Mono, steel-blue accent | `app/app.css`'s `:root` is the only token source: Manrope / Noto Sans / JetBrains Mono, `#5b76fe` accent, violet agent tint, radius card 16 / panel 22, no `--pink` / `--dark-red` / `--radius-large` | UX spec amendment notes N19-2 and N19-4; decisions.md **§UI porting rules** clarification | Yes |
| 13 | **UX spec §Spacing & Layout** — 8px base scale, 12-column grid, elevation scale | No spacing scale, no 12-column grid, no elevation scale: per-component rem values and three named shadow tokens | UX spec superseding note (§Spacing & Layout) | Yes |
| 14 | **UX spec §Responsive** — three capability modes, review-first mode below 768px | **One surface, reflowed.** Nothing is gated on viewport; no control is hidden at any width; the two contracts became suite gates | PRD §Web App Requirements amendment (2026-07-25) + **ruling 66** (R19-12) | Yes |
| 15 | **UX spec §Component Strategy** — Continuity Recovery Panel and board keyboard traversal | Both were unbuilt for several passes and were **ruled built, not retired** — `app/features/task-detail/continuity-recovery.tsx` and the board's roving tab stop in `app/features/board/board-page.tsx` both exist at HEAD | **ruling 64** (R19-10) | Yes — both notes sit inline in the spec |
| 16 | **UX spec §Additional Patterns** — attention filter | The board's attention filter is labelled **"Blocked or waiting"** (not "Needs attention") and selects `blocked` + `inconsistency_risk_detected` + `input_required` | **ruling 36** (R16-2) | decisions.md only |
| 17 | **UX spec §Journey / §Navigation** — decisions live where the evidence is | The **Review queue is a triage list**: its rows say "Review", deliberately not "Accept", because acceptance is verdict-gated and may refuse | **ruling 30** (R15-11) | decisions.md only |
| 18 | **decisions.md ruling 15** — creation templates | The "Lightweight · 3 stages" preset was deleted; **Standard · 5 stages** is the only creation template | ruling 15 (narrowed, P13-AP-04) | Yes (in the ruling) |
| 19 | **UX spec §Accessibility / §Component Strategy** — one governed skills channel | Claude runs load granted skills through the SDK's **native** skills mechanism; **Codex keeps prompt-text injection** — a disclosed asymmetry, not a bug | **ruling 51** (R18-5) | decisions.md only |
| 20 | *(no canon statement — new capability)* | `use-browser` agent capability, **default off**, MOUNT-enforced on both backends and additionally requiring effective web egress; output lands in the task's `attachments/` | **ruling 75** (R19-19) | decisions.md only; PRD/UX spec do not mention browser capability at all |

**Verified non-findings** (checked because they *looked* like drift and are not):

- The Review queue's "always a human action, always in the audit log" footer and its
  "Review → Done · human only" chip are **conditional** on `operatorCanAccept`
  (`app/features/review/review-page.tsx:188-208`, P13-D-9). FR27's disclosure
  requirement is met here.
- The board card's validation pill is a **recorded** deliberate departure from the HTML
  mock (`app/features/board/board-page.tsx:275-284`, P13-D-6 / FR24), exactly as the
  §UI porting rules require.
- The first empty board's single teaching line in the entry column only
  (screenshot `10-board-fresh.png`) is **ruling 29** (R15-10), not a bare empty state.

---

## List 2 — Suspected drift (no sanctioning note found)

Each item: the canon statement, precisely what the app does instead, product impact,
and the question I would put to the owner. I spot-checked `decisions.md` for a
sanctioning ruling on every one of these and found none.

### D1 · The Agents page advertises operator acceptance authority the runtime refuses — HIGH

**Canon.** FR27: the completion-for-acceptance grant "is disclosed in the UI wherever
the human-only claim would otherwise be made"; **ruling 2** and **ruling 67 (R19-A)**
make project autonomy a *ceiling* on every run.

**What ships.** The operator's capability card buckets grants through
`capabilitiesToActionLabels` (`app/features/agents/agents-query.server.ts:100-128`),
which applies exactly one gate — `applyVerdictOutcomeGate`. The runtime gate for the
same capability is `authority.autonomy !== "full" || gate(...) !== "direct"`
(`app/server/tasks/operator-actions.server.ts:2580`). So an operator profile holding
`completion-for-acceptance: direct` on a project deployed **supervised** renders
"Accept completion into Done" under **ACTS DIRECTLY** — authority the server will
refuse. Live in `screenshots/uc/UC-19-06-supervised-card-still-direct-accept.png`.

Second half, same card: **"Accept completion into Done" sits under ACTS DIRECTLY while
"Transition a task to Done" sits under RESERVED FOR HUMANS**, with no reconciliation.
The Policy page carries exactly the note that resolves this
(`app/features/policy/policy-data.ts:61-76`, `policy-page.tsx:516-527`); the Agents
page renders bare label lists (`agents-page.tsx:705`) and carries none.

**Why it matters.** This is the F15-06 class verbatim — the defect
`applyVerdictOutcomeGate` exists to prevent, left unfixed one axis over. An admin
reads the capability card as policy truth.

**Ask the owner.** Should the display gate mirror the runtime gate (autonomy-aware
buckets, the same way verdict outcomes are gated), or should the card keep the raw
grant and carry the Policy page's exception sentence inline? And should the
always-human "Transition a task to Done" row carry its exception note on *every*
surface that prints it, not just Policy?

### D2 · Below 1100px the task page puts current state and the primary Accept button after the entire timeline — HIGH

**Canon.** UX spec §Breakpoint Strategy, verbatim: "the task detail's side-by-side
regions stack, **preserving reading order: current state, latest packet, next action,
then the timeline**". Reinforced by FR25 and NFR2.

**What ships.** `.detail` is a two-column grid (`app/app.css:1004-1013`). At
`max-width: 1100px` it collapses to one column (`app/app.css:3974-3980`) with
`.detail-side` following `.detail-main` in source order — so the stacked order becomes
hero → live run → diagnostics → continuity → packet → recommendations → schedules →
execution profile → run console → attachments → **timeline** → GitHub trace →
**Current state** → Permissions. The **"Accept completion → Done"** primary button
lives in the Current-state panel, so at ≤1100px the product's most consequential
action sits below every timeline entry. The same source order is what a screen reader
gets at *any* width.

**Why it matters.** R19-12's new gates check that nothing is *hidden* at any width and
that nothing is gated on `matchMedia` — neither checks reading order, so this contract
has no guard behind it. It is the one breakpoint promise the spec states as an ordered
list.

**Ask the owner.** Is the fix a CSS `order` swap at the 1100px breakpoint (cheap, does
not touch source order for screen readers), a DOM reorder (fixes both, touches the
page), or is the spec sentence the thing that should change?

### D3 · The board acceptance dialog discloses less than the task-detail one, from a forked implementation — HIGH

**Canon.** FR27 (R15-1): "Every acceptance, gated or forced, passes through a
confirmation dialog stating what will merge and naming any missing signals."
**Ruling 53** (R18-7) required the board drag / Move-menu accept to raise a
confirmation "matching the task-detail dialog". **Ruling 14**: shared single
implementations — "never fork these per surface".

**What ships.** Two independent components: `app/features/task-detail/accept-confirm.tsx`
(labelled rows APPLYING / MERGES / REVISION / VERDICT / BYPASSING + "Merging is
one-way" — see `screenshots/26-accept-ceremony.png` and `28-force-accept-dialog.png`)
and `AcceptOnBoardConfirm` in `app/features/board/board-page.tsx:~800-960`. The board
version reuses the shared *pill* vocabulary but not the ceremony: it does not name the
**merge target branch**, the **delivered revision sha**, who or what **satisfied the
verdict**, or the **no-changes disposition**. Two humans accepting the same task from
two surfaces are shown different facts before the same irreversible merge.

**Ask the owner.** Should `AcceptConfirm` be lifted into a shared component both
surfaces render (ruling 14's posture), or is a deliberately lighter board ceremony the
intent — in which case it wants a recorded ruling, because ruling 53 currently reads
as "matching".

### D4 · "Degraded continuity" exists on one panel and nowhere else in the supervision surface — MED-HIGH

**Canon.** UX spec §Semantic Product Patterns, Health and Waiting State Pattern: the
state set "appears inside **task cards, task headers, packet surfaces, and queue
rows**", and §State Semantics pattern rules: "Every state must mean the same thing
everywhere it appears" / "Persistent state language belongs in the base interface".
§Additional Patterns: "Default filters should support states such as needs me,
blocked, waiting on human, and **degraded continuity**."

**What ships.** `continuity-recovery.tsx` renders on the task page only. There is no
continuity cue on the board card, none in the review queue row, and the board's filter
row is `All tasks · Waiting on me · Agent working · Blocked or waiting · No activity`
(`screenshots/10-board-fresh.png`) — **degraded continuity has no filter and no card
presence at all**, and "waiting on human" has no chip of its own either (it is folded
into "Blocked or waiting" under ruling 36, which sanctions the *rename* but says
nothing about dropping continuity). The root cause is structural: continuity is not a
projected task field, so it cannot reach a card even if someone wanted it there.

**Why it matters.** The Murat journey is one of three critical journeys the spec names
for explicit testing, and it begins "Continuity warning appears on task **or board**".
Today it can only appear on the task the user already opened.

**Ask the owner.** Is continuity deliberately a task-page-only concern (in which case
the spec's pattern list and journey want correcting), or should it be projected onto
the card and the filter row like every other health state?

### D5 · Failure toasts render the success tick — MED-HIGH

**Canon.** decisions.md §UI porting rules, stated as a rule: "A failure toast must not
render the success tick — pass the toast kind explicitly." UX spec §Feedback Patterns:
error feedback "must explain what failed, what remains true, and what the user can do
next", and must not rely on colour alone.

**What ships.** Roughly ten call sites push a refusal or error message through the
default (success) toast kind, so a refusal such as a self-removal denial or a failed
save renders under a green check. The rule exists and is written down; the violations
are simply un-swept, and nothing goes red when a new one lands.

**Ask the owner.** Sweep the existing sites and add a gate (a lint or a test over toast
call sites), or accept the current state and drop the rule from decisions.md? A rule
with ten live violations and no check is the exact "decoration" failure ruling 63
called out for numbers.

### D6 · Several consequential and destructive actions have no confirmation at all — MED-HIGH

**Canon.** UX spec §Button Hierarchy: "Destructive actions … require stronger
confirmation language and should never resemble routine task-flow actions."

**What ships.** The product's confirmation coverage is uneven rather than tiered.
Confirmed with a full ceremony: accept, force-accept, archive task, delete project
(typed name), delete agent profile, remove org resource. **Unconfirmed, single click:**
removing a workflow stage, removing a project member, releasing another user's task
ownership, cancelling a scheduled operator re-run, dismissing an operator
recommendation, interrupting a live run. Removing a person from a project and removing
a stage are governance changes that write audit rows; they are one click, while
archiving a task — explicitly labelled reversible — takes a three-row dialog
(`screenshots/uc/UC-17-16-archive-dialog.png`).

**Ask the owner.** What is the intended bar? My proposal: anything that removes a
person, a stage, or a queued/pending action gets a confirm naming the outcome;
everything reversible and self-scoped stays one click.

### D7 · The Decision Packet is missing three of its six spec'd anatomy fields — MED

**Canon.** UX spec §Decision Packet, Anatomy: "packet type, **severity**, observed
issue, **impact summary**, recommended options, **confidence/risk framing**, next
action area." States: "informational, warning, blocked, completion-ready,
policy-related, continuity-related."

**What ships.** Severity is effectively two-valued and never printed as severity — the
header renders a kind label ("Blocked decision" in `screenshots/23-vib1-blocked-packet.png`,
"Decision required" in `28-force-accept-dialog.png`). There is no impact-summary field
and no confidence/risk field in the packet schema, so the model folds impact into free
prose when it remembers to. Options do carry the stable `kind` set (ruling 7's nine
kinds) and their labels do name outcomes — that half is solid.

**Ask the owner.** Add `impact` and `confidence` as first-class packet fields (the
operator already writes both in prose), or amend the spec's anatomy to the shipped
four?

### D8 · Empty states: roughly thirteen are bare labels, against a spec rule the codebase itself cites — MED

**Canon.** UX spec §Additional Patterns: "Empty states should orient users toward the
next meaningful action. They should explain what is absent, why it matters, and what
the user can do next."

**What ships.** The product does this beautifully in places — the first-run home
(`screenshots/01-home-empty.png`: what a project is, three numbered steps, one CTA),
the entry-lane teaching line, the review queue's "Nothing waits on you. Completion
reports land here when a task reaches the boundary."
(`screenshots/11-project-review.png`). And then roughly thirteen surfaces render a bare
noun phrase — the four org-resources tabs are the worst cluster, one file away from a
connections panel that does it right — and the attachments panel **renders nothing at
all** when empty, so a user who was promised browser evidence has no surface telling
them none arrived.

**Ask the owner.** Is the good copy the standard (in which case this is a sweep), or is
"bare where there is genuinely no next action" acceptable? Note the spec's rule has no
such carve-out today.

### D9 · Board moves are announced to no one — MED

**Canon.** UX spec §Accessibility Strategy: "clear screen-reader announcements for
consequential state changes"; WCAG 2.2 AA is the PRD baseline for core workflows, and
the board is the surface the product asks people to live on.

**What ships.** Board drag is pointer-only by design and keyboard users are routed to
the Move menu — that part is deliberate and documented. But nothing announces a pickup,
a drop, a server refusal, or a completed move: the dnd-kit accessibility plugin was
removed with a reason recorded at the site (a nested-interactive axe violation) and no
`aria-live` replacement was added. Ruling 64 built the *traversal* half of the board's
accessibility story; the announcement half was never ruled either way.

**Ask the owner.** Add a polite `aria-live` region owned by the board (announcing move
requested / moved to <stage> / refused, which also covers the server's 409 on an
off-boundary move), or record pointer-only-and-silent as the deliberate posture?

### D10 · The Continuity Recovery Panel ships two of its four spec'd states — LOW-MED

**Canon.** UX spec §Continuity Recovery Panel, States: "degraded but recoverable,
escalated, paused pending review, recovered." Ruling 64 says "the anatomy, states, and
content guidance above stand as the build target."

**What ships.** The panel covers the degraded and recovered ends; "escalated" and
"paused pending review" do not exist as states anywhere in the type, so the escalation
path the spec anatomy names ("escalation options") has no state to move into.

**Ask the owner.** Finish the state set, or narrow the spec to the two states that have
a real producer?

### D11 · The Execution Truth Strip is three components in two columns, and omits runtime continuity — LOW-MED

**Canon.** UX spec §Execution Truth Strip: "**Top section** of task detail", anatomy
"branch status, PR reference, validation state, **runtime continuity state**, latest
sync health."

**What ships.** The facts are all present and well-built, but split across the GitHub
trace card and the Current-state card in the **right rail**, with validation living in
the hero chip row instead. Runtime continuity is not in any of them (it is the separate
panel of D4/D10). No note sanctions the relocation.

**Ask the owner.** Is the right-rail placement the intended shape (then the spec's "top
section" sentence wants correcting), and should continuity join the strip?

### D12 · No skeletons anywhere — LOW

**Canon.** UX spec §Additional Patterns: "Skeletons or placeholder structures are
preferable to large spinners when the page shape is already known."

**What ships.** A top route-pending bar (`app/features/shell/route-pending-bar.tsx`)
and inline pending states on fetchers. No skeletons, and — to the app's credit — no
large spinners either, so the *anti*-pattern the sentence guards against is absent.
Flagging only because the spec states a preference the build did not take and nothing
records the choice. Defensible as-is.

### D13 · Canon-hygiene drift in the documents themselves — MED (for the NFR8 note), LOW otherwise

Three concrete cases, all of the class **ruling 44** exists to prevent:

1. **Ruling 39 (R16-5) cites "the PRD/NFR8 amendment note" that does not exist.**
   `prd.md:278` reads as originally written. The MCP-outside-the-matrix boundary is a
   deliberate, load-bearing honesty limit — an agent with `execute-code-or-write-repo`
   set to `off` can still reach a granted MCP server's write tools — and NFR8 is the
   requirement it qualifies. A reader of the PRD alone gets the opposite impression.
2. **NFR14 still prints an unmeasured 10-second budget** ("must be surfaced … within 10
   seconds of detection") after ruling 63 struck NFR1–NFR4 for exactly that reason. The
   only code citing NFR14 (`app/server/github/pr-open.server.ts:148`) implements the
   *surfacing*, not the budget; no harness measures it. Ruling 63's standing rule — a
   latency budget lands in the same change as the harness — was applied to four numbers
   and missed the fifth.
3. **Ruling 75 cites `app/routes/task-attachment.tsx`**; the shipped file is
   `app/routes/task-attachment.ts`. Trivial, but decisions.md is the file code comments
   cite by path.

**Ask the owner.** Add the NFR8 note (I would treat this as required by ruling 44),
strike or fund NFR14's figure, and correct the ruling-75 path.

---

## List 3 — UX-coherence critique (independent of the canon)

Concrete, cited, and limited to things a demanding reviewer would actually raise.

### C1 · The same "you cannot accept yet" sentence renders twice, ~350px apart

`GithubTrace` prints "Acceptance is blocked: {reason}"
(`app/features/task-detail/task-side-panels.tsx:125`) and the Current-state panel
prints "**Not acceptable yet.** {same reason}" (`:721`) — in every task screenshot I
looked at (`22`, `23`, `25`, `uc/UC-17-16`, `uc/UC-17-19`) both are on screen
simultaneously with byte-identical reason text. A previous pass fixed these two panels
*disagreeing*; the fix made them duplicates. The PRD lists "no-duplicate-summary" as an
anti-noise guardrail.

**Fix direction.** One owner for the sentence. The Current-state panel is the better
home (it is where the Accept button lives); GithubTrace should carry only the GitHub
fact and let the panel say what it blocks.

### C2 · Live-obligation pills are withdrawn on archived tasks but not on accepted ones

The readiness and validation pills drop only on `archived`
(`task-main-sections.tsx:172-180`; board `board-page.tsx:~460-474`). The rationale
recorded at both sites — UXO-1 / F19-8, "readiness is an ACTIONABLE claim … on
abandoned work nobody owes a verdict" — applies word-for-word to an **accepted, Done**
task, where nobody owes a verdict either. So a force-accepted task reads
`accepted · awaiting verdict` on the task hero, and its card carries the same pair.
The known force-accept nit is not a one-off: it is this predicate being keyed on one
terminal condition out of two.

**Fix direction.** Extend the existing archived predicate to any terminal/accepted
task, reusing the same swap (`ArchivedPill`'s slot already proves the shape).

### C3 · One chip slot carries two vocabularies, and the two surfaces disagree while a run is live

The task hero swaps the readiness pill for an `agent working` pill when a run is live
*and* readiness is `input_required` (`task-main-sections.tsx:172-177`). The board card
does not swap. So during an operator run the same task reads **"input required" on the
board and "agent working" on the task page at the same instant** — a direct hit on the
spec's "every state must mean the same thing everywhere it appears", and the swap hides
the one readiness value that most needs a human. Screenshot `22-vib1-task-page.png`
shows the hero mid-run; `25-move-review-recommendation.png` shows the same slot holding
`ready`.

**Fix direction.** Give "agent working" its own slot (the card already separates
readiness in `card-top` from the wait tag in the foot — copy that split into the hero)
rather than letting a run suppress a readiness claim.

### C4 · Five noun phrases for "a human owes something", split across three scopes

Board subtitle: "0 **waiting on a human decision** in this project" (project-wide).
Board filter chip: "**Waiting on me**" (member-scoped). Board card foot: "**waiting on
you**". Task page rail: "Waiting on — **Human decision**" (never "you", even when it is
you). Review queue: "**waiting on your acceptance**". Screenshots `10`, `22`, `23`,
`11-project-review`. Each of the two *scopes* is individually sanctioned (ruling 10 and
its R8-3 board narrowing); the five *spellings* are not, and the board header puts two
different scopes in one sentence with one chip.

**Fix direction.** Pick one phrase per scope — "waiting on you" (viewer) and "waiting
on a human" (project) — and use them everywhere, including the task rail, which is the
one surface that never personalises.

### C5 · Stage names collide with readiness labels: the hero can read "Ready ready"

Stage names are user-authored and the default workflow ships a **Ready** stage, so the
hero chip row renders `Ready` (stage) immediately followed by `ready` (readiness),
distinguishable only by capitalisation and dot colour —
`screenshots/uc/UC-17-16-archive-dialog.png`.

**Fix direction.** The readiness chip should be self-labelling (an icon or a
"readiness:" affordance), or the stage chip should carry a stage glyph strong enough to
read as a different class of object.

### C6 · Two confirmation grammars, and exactly one typed confirmation in the whole product

The hand-written ceremonies share a genuinely excellent shape — labelled rows, a
footnote about what is recorded, a confirm button naming the outcome ("Archive VIB-4",
"Force-accept VIB-2", "Apply → Done & merge") and an opt-out phrased as a decision
("Not yet", "Keep on the board"). Screenshots `26`, `28`, `uc/UC-17-16`, `uc/UC-17-19`.
Against that, the shared `ConfirmDelete` used by five org-settings destructive paths
ends in a generic **"Remove"**. Meanwhile the *only* typed confirmation in the product
guards delete-project, while removing an org KB or MCP server that N agent profiles
depend on is one click and a generic verb. (See also D6 for the paths with no
confirmation at all.)

**Fix direction.** Parameterise `ConfirmDelete`'s confirm label the way the hand-written
dialogs do, and state the blast radius ("3 agent profiles reference this knowledge
base") where the server already knows it.

### C7 · Decision packets leak machine exhaust into their structured fields

Packet observation rows are agent-authored key/value pairs rendered as uppercase
schema-style labels, so a human reads field names like **"NOCHANGES FLAG — false"** and
**"ORIGIN/MAIN TEST-ARTIFACTS/PASS20-VIB1.TXT"** (a file path used as a field label),
and a packet titled with the raw tool name `accept_completion`
(`screenshots/28-force-accept-dialog.png`). Separately, in
`screenshots/23-vib1-blocked-packet.png` the packet's body sentence and its `SIGNAL`
row are byte-identical, doubled period included. The spec's packet guidance is "keep
concise … avoid raw logs inside the primary packet", and the PRD lists
"evidence-separation" as an anti-noise guardrail.

**Fix direction.** Normalise observation labels at the writer (length cap, reject
path-shaped and camelCase-derived labels, title-case the rest) and dedupe the summary
sentence against the first observation before render.

### C8 · The task page's most valuable slot holds a scheduling form for nothing

Panel order is Live run → Diagnostics → Continuity → Packet → Recommendations →
**Scheduled re-runs** → Execution profile (`task-detail-page.tsx:560-598`). On a task
with no packet and no recommendation — the common case — the first thing under the goal
is "Scheduled re-runs", rendering **"No scheduled operator re-runs."** plus a full
four-control form (`screenshots/22-vib1-task-page.png`), above the Execution profile
that holds Run operator, the delivering agent, the reviewers and the owner.

**Fix direction.** Move Scheduled re-runs below Execution profile and collapse the
form behind a one-line "Schedule a re-run" disclosure; render the panel expanded only
when a schedule actually exists.

### C9 · The GitHub card changes identity between states, and its pill row truncates at 1440px

In `22-vib1-task-page.png` the card header is an icon plus "GitHub"; in `23`, `25` and
`26` the same card's header is the repo slug plus a state pill. In `25` and `26` the
pill row overflows the card and the checks pill is clipped mid-word — **"1/2 checks
faili"** — at a 1440px viewport, i.e. squarely inside the desktop target.

**Fix direction.** Keep one header identity (repo slug, with the state pill as a
sibling row), and let the pill row wrap rather than clip. Worth a look alongside the
R19-12 width gates, which prove nothing is *hidden* but say nothing about clipping.

### C10 · Agents-page status strings bypass the pill vocabulary

The Agents page prints run/engagement status as raw text ("working", "packet open",
"waiting on human") rather than through the shared pill mapper every other surface
uses, and its "waiting on human" drops the article that the board's "waiting on a
human" carries. Screenshot `uc/UC-19-06`.

**Fix direction.** Route these through the same mapper; the vocabulary then follows any
future rename automatically, which is the whole point of ruling 14's single
implementations.

### C11 · "Specialist" survives on the Agents page after the task page renamed it

UXA-6 settled on "delivering agent" for the task surface; the Agents page still names
the group **"SPECIALIST PROFILES"** with a "New specialist profile" button
(`screenshots/uc/UC-19-06`), and FR14's amendment says the shipped model's words are
*delivering* and *supporting engagements*. Three vocabularies for one object, one click
apart.

**Fix direction.** Finish the rename on the Agents page, or record the split
deliberately (profiles are reusable definitions; engagements are per-task) with the
distinction stated on the page.

### C12 · An unrecognised readiness value renders as green "ready"

The readiness pill's lookup falls back to the `ready` entry for any value it does not
know (`app/ui/pill.tsx:~68-98`). A malformed or future readiness value therefore
greenwashes: the one thing a tolerant-parsing product must never do is report an
unparsed state as healthy, and decisions.md §Behavior rules requires malformed input to
produce "a readiness downgrade … never a silent drop".

**Fix direction.** Fall back to a neutral "unknown" pill and let the diagnostics panel
carry the reason.

### C13 · The home page's store-maintenance strip describes a board that is not on the page

The footer strip reads "Store maintenance · admins only — **the board** is a projection
of the task files on disk. Neither action edits a task file."
(`screenshots/01-home-empty.png`, on a workspace with zero projects and no board
anywhere).

**Fix direction.** Say "projects and boards are a projection of the task files on
disk"; the sentence is otherwise the right one and does real work.

### C14 · The archive dialog can claim nothing is pending while a run is live on screen

In `screenshots/uc/UC-17-16-archive-dialog.png` the page behind the dialog shows a
**Live run — 1 agent running** panel and a rail reading "Waiting on — Agent work",
while the dialog's third row reads "**WITHDRAWN** — Nothing is pending on this task
right now." The row means "no *packets or recommendations* are pending", but on a
ceremony whose job is to state consequences, a live run is exactly the pending thing a
human would want named before archiving.

**Fix direction.** Include the live run in the withdrawn/consequence row ("an operator
run is in flight and will be interrupted"), or narrow the row's label to what it
actually surveys.

---

## Summary

**Counts.** List 1 — **20** sanctioned divergences (plus 3 verified non-findings).
List 2 — **13** suspected drifts: 3 HIGH, 4 MED-HIGH, 2 MED, 3 LOW-MED, 1 LOW.
List 3 — **14** UX-coherence items.

**Five highest-impact items overall**

1. **D1 — the Agents capability card advertises acceptance authority the runtime
   refuses.** A supervised operator holding `completion-for-acceptance: direct` renders
   under "ACTS DIRECTLY" because the display applies only the verdict gate, never the
   autonomy gate the server enforces; and the same card prints "Reserved for humans:
   Transition a task to Done" beside it with none of the Policy page's reconciling
   note. Live-captured. This is the F15-06 defect class, one axis over.
2. **D2 — at ≤1100px the task page stacks current state, execution truth and the
   primary "Accept completion → Done" button below the entire timeline**, against an
   explicitly ordered spec contract, and the same order is what every screen reader
   gets at any width.
3. **D3 — the board acceptance dialog discloses less than the task-detail one**, from a
   forked implementation: no merge target, no delivered revision, no verdict
   attribution, before the same irreversible merge. Ruling 53 asked for a dialog
   "matching the task-detail" one; ruling 14 forbids the fork.
4. **D6 — remove a project member, remove a workflow stage, cancel a scheduled run,
   dismiss a recommendation and interrupt a live run are all single-click**, while
   archiving a task (explicitly reversible) takes a three-row ceremony. The
   confirmation tiering does not track consequence.
5. **D5 — failure toasts render the success tick** at ~10 sites, violating a written
   decisions.md rule with no check behind it: a refusal currently reads as a success.

**Runner-up worth reading with those five:** **C2** — live-obligation pills are
withdrawn on archived tasks but not on accepted ones, so every force-accepted task
wears `accepted · awaiting verdict`. The known force-accept nit is one instance of a
predicate keyed on one terminal state out of two, and the fix is to extend a rationale
already written at both call sites.
