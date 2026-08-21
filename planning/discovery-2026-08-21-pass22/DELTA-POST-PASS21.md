# Delta since pass 21 — d1bc4a2..26fca45 (2026-08-20 → 2026-08-21)

Every commit between the pass-21 close (d1bc4a2, merge of PR #175, 2026-08-19) and
current main HEAD (26fca45). Ten PRs merged: **#176, #177, #179–#186** — twelve
non-merge commits, all owner-directed product changes made against live incidents on
the owner's own instance. **PR #178 does not exist in this range** (number skipped;
presumably closed unmerged or never opened — nothing in the git history references it).

All file:line citations are at HEAD (26fca45). Suite counts are the ones each commit
message reports; the merges chain linearly (each branch forked from the previous
merge), so the count at HEAD is **4152** (#186's message: it built on #185's 4159,
removed the hand-off/popover-suite rows, added 2 pins). Every commit reports tsc
clean and oxlint 0.

**decisions.md**: rulings now run to **92**. New in this window: **91 (R21-8)** and
**92 (R21-9)** — `docs/architecture/decisions.md:1109` and `:1123`. Rulings 89
(R21-6, behavioral triage gate) and 90 (R21-7, FILES.md deleted) are dated 2026-08-20
but were already present at d1bc4a2 — they belong to pass 21, not this delta.
**Eight of the ten clusters landed with NO decisions.md entry** (see Probe candidates).

---

## #176 — browser-implies-egress (86c5e35)

**What changed.** Granting "Drive a live web browser" (`use-browser`) now forces
"Search & fetch from the web" (`use-web-search-fetch`) to `direct` with it, at three
layers. Before, the two rows were independently editable, and the live failure was an
admin granting the browser, leaving egress off, and every run honestly reporting
"browser not mounted" against a matrix that said Allowed — `resolveBrowserMcp`
refuses to mount the pair in disagreement because the browser IS network egress.

**Why.** Owner ruling 2026-08-20, from a live incident on the owner's instance. The
contradiction expresses no policy (the mount fails closed either way), so it was made
inexpressible. This **deliberately diverges from B-AG1** (the delivery-headline repair
respects an explicit `off`): there the withheld state is enforceable; here it
preserves nothing but the trap. Documented in a long comment at the rule itself —
`app/shared/capabilities.ts:456-474`. **No decisions.md ruling was recorded.**

**Surfaces.**
- Shared rule: `BROWSER_CAP_ID`/`WEB_EGRESS_CAP_ID` at `app/shared/capabilities.ts:453-454`;
  `repairBrowserEgressGrants` at `:475` (fires only when browser mode is exactly
  `"direct"` and egress isn't — adds or upgrades the egress grant, returns a
  `browser-egress` notice); `applyGrantCouplings` at `:510` chains delivery repair
  (B-AG1) then browser repair and returns `notices[]` (both can fire on one save).
- Save layer: create, edit, and deploy-from-library all pass grants through
  `applyGrantCouplings` — `app/features/agents/agent-profile-actions.server.ts:315,378,542`.
  `carryCouplingNotices` (`:146-160`) stamps each decision onto the audit row under
  its own keys — `browserEgress` / `browserEgressNote` (delivery keeps
  `deliveryGrants` / `deliveryNote`) — and onto the save result as `notices[]`
  (`ProfileSaveResult.notices`, `:67-75`). The route surfaces notices to page toasts:
  `app/routes/project.agents.tsx:117-129,164,181,199`.
- Editor: `coupleGrants` runs on every capability-state write AND on modal seed
  (`app/features/agents/create-profile-modal.tsx:140,151,174,767`), so a stored
  pre-rule contradiction opens showing what the next save will persist (F19 UX-13
  round-trip honesty). While browser is Allowed the egress row renders disabled,
  pinned Allowed, with the reason in the accessible name and tooltip (`:697-749`).
- Runtime: the `resolveBrowserMcp` mount gate is untouched as the backstop for
  hand-edited files (`app/server/tasks/specialist-browser-mcp.server.ts:106-118`).
  Note the gates agree on the `recommend` edge: `effectiveCollabMode`
  (`app/server/tasks/agent-outcome.server.ts:377-389`) treats a `recommend` grant
  as absent (default off for browser), so a stored `use-browser: recommend` neither
  mounts nor triggers the coupling — consistent.

**Tests.** +8: shared-rule unit suite in `app/shared/capabilities.test.ts` (+85 lines),
end-to-end route save with stored-file and audit assertions in
`app/features/agents/agents-route.server.test.ts` (+88), editor pin/flip incl. a
canary-hardened flip check in `app/features/agents/agents-page.test.tsx` (+82).
Live-verified: one click on the browser row → saved project.md carries both grants.

## #177 — comment-attachment-previews (ba0ea9c)

**What changed.** Two render-side fixes so a run's posted files are visible where they
were posted. (1) The timeline event's attachment strip renders **image** attachments
as small thumbnail previews (`.tl-attach-thumb`) on the producing message; non-image
files keep filename chips (`.tl-attach-chip`) — `app/features/task-detail/timeline.tsx:291-334`.
(2) Markdown **attachment link repair**: when a comment link's or embedded image's
href is attachment-shaped (`attachments/<name>` under any relative prefix, or the
bare filename) AND the filename names a file the task really has, the href is
rewritten to the member-only serving route (`projects/:slug/tasks/:key/attachments/:file`,
`app/routes.ts:51`, handler `app/routes/task-attachment.ts`). Absolute URLs, foreign
paths, and unknown names pass through verbatim — the same no-guessing contract as
R19-19 evidence linkify.

**Why.** Owner report from live VIB-1: the Developer's screenshot landed in the side
panel, but the comment showed only chips, and the agent's own link
`[page-….png](../../attachments/page-….png)` 404'd (workspace-relative path resolved
against the task URL). For a task whose deliverable is a picture, the human had to
leave the message to see it.

**Surfaces.**
- `repairAttachmentHref` — `app/ui/markdown.tsx:150-163`; applied to both `a` and
  `img` in `componentsFor` (`:178-196`). Enabled only when the caller supplies the
  task's real attachment name set + route base — `Markdown` props `attachmentNames` /
  `attachmentsBase` (`:247-249`); every other Markdown surface renders verbatim.
- Wired from `CollapsibleComment` → `Markdown` (`app/features/task-detail/timeline.tsx:60-107`);
  `TimelineItem` threads the names/base down (`:251-252,274-275`).
- `IMAGE_RE` exported from the panel as the one image-name test —
  `app/features/task-detail/attachments-panel.tsx:24` (`/\.(png|jpe?g|webp|gif)$/i`).

**Tests.** 7 new/updated, canaried both ways: `app/ui/markdown.test.tsx` (+68 lines),
`app/features/task-detail/attachments-panel.test.tsx` (+44). Live-verified against
the exact VIB-1 comment shape (real names rewritten, `missing.png` left alone).

## #179 — task-attachments-drop (461b781, c0bc031)

**What changed.** Agents can now deliberately post files on the task thread. The
mechanic already half-existed (attachments dir next to the run workspace; completion
pipeline stamps files written there during the run onto the agent's reply; timeline
renders images inline — #177). What was missing: (a) any instruction telling agents
the drop exists, (b) write access from a Codex `workspace-write` sandbox, and — found
live when VIB-2 still refused twice — (c) an exception named INSIDE the workspace
contract, whose "never touch anything outside the working directory" otherwise
outranks the persona section.

**Why.** Owner ask 2026-08-20, live: "I need the developer to post it here, not just
as a file in a PR." The operator honestly answered no tool exists and improvised a
GitHub blob URL, which renders a broken image (blob/ serves HTML). **No decisions.md
ruling was recorded.**

**Surfaces.**
- Persona section "Posting files on the task thread" —
  `attachmentsDropSection`, `app/server/tasks/specialist-browser-mcp.server.ts:167-178`.
  Emitted for any profile granted `attach-evidence-references`, browser or not
  (the browser's default-named screenshots are a special case of this mechanic):
  gate `collab.evidence && realBackend` at `app/server/tasks/specialist-run.server.ts:1403-1406`
  (persona input `attachmentsDrop`, type at `:1833`), rendered at `:2014-2015`.
- Workspace-contract exception (c0bc031): `buildAnalyzePrompt` input
  `attachmentsDropRel` (`:2098`, set at `:1456-1460`) renders "One deliberate
  exception: you may COPY files INTO the task's attachments folder …" immediately
  after the confinement rule (`:2135-2141`), cross-referencing the persona section.
- Dir pre-created before the run so a plain `cp` cannot fail on a missing path —
  `mkdirSync(attachmentsDir, { recursive: true })` at `:1372-1377` (idempotent with
  the browser mount's own mkdir).
- Sandbox plumbing: `RunSpec.attachmentsWritableDir`
  (`app/server/runtimes/adapter.server.ts:98`; `StartRunInput` mirror
  `app/server/runtimes/run-service.server.ts:242-244,714-715`; set only for
  evidence-granted runs at `specialist-run.server.ts:1653-1655`). The Codex adapter
  adds it as `additionalDirectories` **only at `workspace-write`**
  (`app/server/runtimes/codex-runtime.server.ts:650-652`) — full access already
  writes it, and widening a read-only run would break P13-RT-02 honesty (matrix said
  closed, sandbox stays closed). Claude runs at bypassPermissions and need no widening.

**Tests.** `app/server/runtimes/codex-runtime.server.test.ts` (+41: additional-dir
only at workspace-write, both canary directions), `app/server/tasks/specialist-run.server.test.ts`
(+20 persona section, then +31 pinning the exception INSIDE the contract after the
confinement rule, canaried).

## #180 — questionnaire-packet-density (f638ffe)

**What changed.** Restyle only of the decision-packet card — every behavior stands
(roving radiogroup, digit shortcuts + kbd chips, composed write-your-own choice,
archive/discard ceremonies, role blocks, accessible names). The card had drifted into
a "billboard": full-card amber wash, 1.25rem headline, 13px-radius option slabs with
hover lift/shadow, always-tall note box, two stretched full-width buttons. Reference
is shadcn's base questionnaire: quiet, dense, one glance.

Semantic tone (question amber / blocked coral) moved from full-card gradient into a
3px left accent + the kind pill; card is plain surface with hairline border. Title
1rem, lede .84, observation rows .8 on a 3% fg tint. Choice rows .5rem padding;
selection = soft blue fill + dot; hover = border shift only. Note field loses its
dead vertical minimum. Actions natural-width, right-aligned, **ending on the primary**:
Ask operator (ghost) moved BEFORE Confirm decision in the row (flex-end ordering) —
`app/features/task-detail/decision-packet.tsx:856-870` (button + N20-15 comment),
`app/app.css:1206` (`.packet-actions { justify-content: flex-end; }`).

**Why.** Owner ruling 2026-08-20 (recorded only in the commit message — no
decisions.md entry). Files: `app/app.css` (80 lines churned around `:1102-1206`),
`decision-packet.tsx` (29 lines). No new tests (CSS-only; `app.css.test.ts` gates the
class inventory). Live-verified both themes against a real 5-option blocked packet.

## #181 — input-required-yields-to-agent (9317ccc) — **ruling 91 / R21-8**

**What changed.** While an agent actively carries a task, `input_required` yields to
"agent working" on every surface. Supersedes the C3/F15-09 both-pills arrangement
while keeping its actual requirement (hero and board agree mid-run). The yield gate
is `waiting === "agent"`; raising a packet flips `waiting` to `"human"`, so the
human's turn instantly reasserts "input required" everywhere, even while a run winds
down. `blocked` / `inconsistency_risk_detected` **never** yield — a run does not
answer those. Stored readiness is untouched; the triage gate still clears only on
leaving the entry stage (task-actions.server.ts).

**Why.** Owner-reported live: a fresh triage task with a live run read
"input required · agent working" side by side — but the pill claims a human is needed
RIGHT NOW, which is false mid-run. `docs/architecture/decisions.md:1109-1122`.

**Surfaces.**
- Task hero: readiness pill swaps to an "agent working" pill when
  `agentWorking && displayReadiness === "input_required" && waiting !== "human"` —
  `app/features/task-detail/task-main-sections.tsx:188-206` (prop `agentWorking`
  declared `:90-103`). `agentWorking` = `anyRunLive` from the page:
  `waiting === "agent"` OR any runtime row running/queued (operator, specialist, or
  reviewer) — `app/features/task-detail/task-detail-page.tsx:292-297`, passed at `:672`.
- Board card top slot and list-row slot go **quiet** (render nothing — the foot's
  WaitTag already says "agent working", so the claim is made exactly once, F15-09):
  `app/features/board/board-page.tsx:542-544` (card) and `:798-800` (list row).
- "Blocked or waiting" filter stops matching an agent-carried input_required task
  (R16-2's name-the-chip rule mirrored — those belong to the "Agent working" chip):
  `app/features/board/board-filters.ts:80-87`.
- `ReadinessPill` renders nowhere else with task readiness (checked: only board card,
  list row, hero, and the diagnostics findings' readiness-EFFECT pills), so the four
  touched sites are the complete surface set.

**Tests.** `board-filters.test.ts` (+37), `board-page.test.tsx` (+30),
`task-detail-components.test.tsx` (+48). Live-verified: board card, both filter
chips, hero, and the SSE reassert on `waiting: human`.

## #182 — packet-minimal-redesign (287b6b8)

**What changed.** Second restyle pass on the same card, hours after #180, from owner
feedback on the live result ("incoherent and screen-filling"). Same content at ~half
the height (~744px vs ~1530px for a 5-option input packet), one visual system:
- Packet observations become EVIDENCE, not a form: the boxed two-column grid (which
  turned long operator-authored labels like "SCREENSHOT INFRA EXISTS" into a huge
  label gutter) is now one flowing line per row — inline caps label then value —
  behind a thin left rule echoing the card accent
  (`app/app.css:1132-1142`, `.packet-body .packet-obs` / `.packet-body .obs`).
  The acceptance/archive **dialogs keep the grid** (short fixed vocabulary; alignment
  is the point there) — `decision-packet.tsx` release/discard cards still use
  `.packet-obs flush` (`:211,333`).
- One type ramp (title .92 / lede .8 / obs .76 / option title .82 / detail .72,
  `app/app.css:1121` etc.); only boxed sub-surfaces are the selectable option rows;
  option markers top-align to the title line; the custom choice loses its dashed
  border (same solid frame as every row).
- The boxed filled operator glyph — the brightest object on the card — becomes a bare
  text-size shield; kind pill drops to `sm` — `decision-packet.tsx:575-588`.
- Note field rows=1 with a shorter hint ("optional · recorded on the decision");
  custom directive rows=2 ("resolves this decision · handed to the operator") —
  `decision-packet.tsx:753-762,791-800`.

No behavior change, no new tests. **No decisions.md entry** for either restyle pass.

## #183 — live-agent-backend (9b86de1)

**What changed.** Every surface that DISPLAYS an engaged agent's backend now overlays
the live deployment's backend over the engage-time snapshot in task.md. The run path
already followed the live profile (specialist-run resolves the current profile and
discloses "switched from …" on the next run); only display trusted the snapshot,
which the run start heals merely as a side effect of running. Live failure: Developer
profile switched to the other backend, but the task page's Delivering-agent card still
said Codex — and its Run button would have started a Claude run under that label.

**Surfaces.**
- `primaryRunBackend` is now THE primary-backend rule (first real backend in the
  profile's `backends` list, else claude) — `app/features/agents/agents-query.server.ts:383-390`.
  Previously written twice; both `effectiveProfileView` (`:489`) and specialist-run's
  `pickBackend` (`app/server/tasks/specialist-run.server.ts:201`) now delegate.
- `deployedSpecialistBackends(projectSlug, dataRoot)` builds the live
  `profileId → backend` map from project.md (operators excluded; ANY read/parse
  failure = empty map, display falls back to the snapshot, never 500s a board) —
  `agents-query.server.ts:408-428`.
- `withLiveAgentBackends(summary, live)` patches specialist + reviewers — backend AND
  display name via `agentBackendName` — pure, reference-preserving when nothing
  changes; a profile absent from the map (undeployed since engagement) keeps its
  snapshot, exactly the run path's own fallback —
  `app/shared/mapping/task.server.ts:369-388`.
- Applied in `getTaskSummary` (`app/server/projections/task-query.server.ts:112-118` —
  task page + detail), `listProjectTasks` (`app/server/projections/board-query.server.ts:219-229`
  — board, review queue, every read model that goes through it; ONE map per query),
  and `listAgentDeployments` (`app/server/projections/agent-deployments.server.ts:98-106`
  — the agents-page engagement rows, which chipped the stale backend directly under
  the profile card the human had just edited).
- Known accepted wart: board-query → agents-query is a **call-time-only circular
  import edge** (agents-query already imports getProject); function declarations
  hoist across the cycle, so module init is safe in both orders (commit message
  documents this; nothing in the code guards it).

**Tests.** New integration file
`app/server/projections/live-backend-overlay.server.test.ts` (142 lines, incl. an
overlay-neutered canary run), +4 mapping tests in `app/shared/mapping/task.server.test.ts`
(+57 lines). Demo seed doubles as the fixture: VIB-151 snapshots drift from the
deployed backends in both directions (`test-support/demo-data.ts:435+`). Live-verified
end to end with no run in between; task.md still snapshots the old backend. **No
decisions.md entry**, though R21-9's text later cites "the R21-8/#183 law".

## #184 — attachment-lightbox (8906342)

**What changed.** Clicking a posted screenshot opens an in-app lightbox popup instead
of a raw-file tab. New `AttachmentLightboxProvider` + `useAttachmentLightbox` —
`app/features/task-detail/attachment-lightbox.tsx` (whole file, 112 lines): the
provider mounts once around the task page
(`app/features/task-detail/task-detail-page.tsx:605,988`); the hook returns a
click-handler factory. A plain left click intercepts into a modal-card dialog (the
app's one dialog contract — `useDialog`: showModal, Escape, backdrop click, animated
close) showing the picture, filename, and an "Open original" link keeping the
raw-file tab one click away. Modified clicks (cmd/ctrl/shift/alt/middle) pass through
the real anchor untouched (`attachment-lightbox.tsx:49-56`); with no provider mounted
the handler is inert, so bare renders and other surfaces keep the old link behavior.

**Wired on all four image-evidence surfaces:**
1. Timeline thumbnail strip (the reported case) — `timeline.tsx:307-310`.
2. Attachments panel preview grid — `attachments-panel.tsx:44-47,86`.
3. Evidence-linkified filenames naming an image (non-images keep the plain link) —
   `timeline.tsx:141-163` (`IMAGE_RE`-gated onClick).
4. Inline markdown embeds of task attachments — `markdown.tsx` gains optional
   `onAttachmentImageClick` factory (`:165-171,250-252`); the embed becomes a real
   `<button class="md-img-btn">` (keyboard-reachable) ONLY when the src resolves under
   the task's serving route (`:198-215`). Non-image chips keep the plain link ("a
   popup cannot render a yml").

CSS at `app/app.css:4424-4451` (`.lightbox-card` etc.). **Tests** +7 in
`attachments-panel.test.tsx` (+107 lines): open, modifier passthrough, no-provider
inertness, close, markdown embed, chip non-interception, panel. Live-verified with
LAB-1's real capture. No decisions.md entry (pure UI affordance).

## #185 — operator-card-simplify (01daead) — **ruling 92 / R21-9**

Two owner instructions, one surface — `docs/architecture/decisions.md:1123-1138`.

**A. The label is "Claude", not "Claude Code"** — at every backend DISPLAY site:
- The one mapping: `agentBackendName` — `app/server/files/actor-ref.server.ts:122-124`.
- Actor display names (`app/shared/mapping/actor.server.ts:119`), run/toast/timeline
  copy (`app/server/tasks/task-actions.server.ts:2539,2627,5149`;
  `app/server/runtimes/run-service.server.ts:209-213` SDK_LABEL, `:831,877,903`),
  the operator prompt's own backend line
  (`app/server/runtimes/operator-run.server.ts:2620`), the profile editor's backend
  segment, roster chips, runs panel, schedule modal, run-operator toast
  (`app/routes/project.task.tsx:926`), glyph tooltip (`app/ui/identity.tsx:33`).
- References to the actual Claude Code PRODUCT keep their name (CLI login recipe in
  runtime-registry, transcript retention, the coding harness, and the credential
  errors at `run-service.server.ts:801-803` — see Probe candidates). Stored records
  are not rewritten. Demo fixtures updated.

**B. The operator run control SHOWS, it does not pick.** The per-run backend/autonomy
dropdowns are gone from the operator card. Both are configured on the deployed
operator profile and the run resolves the LIVE profile (the same law the
delivering-agent card follows, #183), so the card states the backend
(`.op-backend`), keeps Run operator, and adds an **optional steer input** —
`OperatorRunControl`, `app/features/task-detail/execution-profile.tsx:478-575`
(steer input `:521-535`, Enter submits; CSS `app/app.css:1309-1323`).

**The steer** rides the `@operator` mention machinery: recorded as the human's OWN
timeline comment (a directive that reaches an agent off the record is invisible to
supervision) via the low-level `appendComment(…, forceToAgent: true)` — NOT
`commentToAgent`, because this call already starts the run and the mention path would
start a second one — and passed as the run's `humanComment` with `trigger: "manual"` —
`app/routes/project.task.tsx:901-923`. `humanCommentBy` is the DISPLAY name via the
newly-exported `userName()` (the mention path's own lookup,
`app/server/tasks/task-actions.server.ts:354`) — live-caught on the first steered
run: `actor.label` is the email, and the operator's reply tagged "@arda@viberr.dev",
which chips and notifies nobody (NEW-4); the re-run tagged "@Arda". Client submit
sends only `intent` + optional `steer` — `app/features/task-detail/task-main-sections.tsx:589-600`.

**Kept invariants:** F20-9's mirror survives as a caption — full autonomy announces
itself on the run surface ("Full autonomy: this run can move the task and accept
completion itself", `execution-profile.tsx:565-572`); supervised is the quiet
default. P11-41 survives without a picker — an unconfigured profile backend disables
Run with the reason rendered as copy (`:553-562`).

**Tests.** +3 rewritten operator-control cases in `task-detail-components.test.tsx`;
label assertions updated across 9 test files. Live-verified twice with REAL operator
runs: the steer landed as the human's @operator comment, and the operator did exactly
what the steer asked, both times.

## #186 — owner-cell-no-manage (e0ea9f0)

**What changed.** The "HUMAN OWNER · REVIEWS & ACCEPTS" cell on the task page shows
the owner chip **alone** when the task is owned — the Manage popover (take-over /
hand-off / release) is gone. `OwnerControl` shrinks to the unowned affordance:
"Unowned. Any contributor or above can take it" + Assign me, Q5 tiering intact —
`app/features/task-detail/execution-profile.tsx:199-247` (owned branch returns
`null` at `:241-247` with the rationale comment).

**Capability accounting (per the commit):** nothing is stranded — release lives one
panel away on the Current-state Owner row (`own-x`: self-release for the owner,
anyone for the `release-any-ownership` tier, ReleaseConfirm ceremony intact), and a
hand-off is release + take. Dead `members`/`onRelease` plumbing removed from
`ExecutionProfile`, `ExecutionSection`, and the page call
(`task-detail-page.tsx`, `task-main-sections.tsx` — the page keeps both for the side
panel and the release dialog). The `own-wrap`/`own-btn`/`own-menu` CSS is NOT dead —
still used by the specialist/reviewer manage popovers (`execution-profile.tsx:297,406`)
and settings page (`settings-page.tsx:485-506`).

**Tests.** The hand-off candidate test and the ownership rows of the two
parameterized popover suites removed with the menu; two new pins assert owned cell =
chip with NO Manage control, unowned cell keeps Assign me
(`task-detail-components.test.tsx`, `task-disposition.test.tsx`,
`execution-profile.test.tsx`). Live-verified full circle (assign → no Manage →
own-x release → back to Unowned). **No decisions.md entry.**

---

## Docs & planning-artifacts status

- `docs/architecture/decisions.md` — updated only for #181 (ruling 91) and #185
  (ruling 92). The other eight clusters cite "owner ruling/ask 2026-08-20/21" only in
  commit messages and code comments. Given this repo's convention that owner rulings
  land as numbered decisions.md entries, #176 (a real policy rule: browser implies
  egress, with a documented B-AG1 divergence) and #179 (a new agent capability
  surface) are the two most conspicuous gaps.
- `planning/` had **zero commits** in this window. `planning/planning-artifacts/prd.md`
  still says "Codex / Claude Code backends" (`prd.md:73,179,233`) — defensible as
  product references under R21-9's carve-out, but nothing in the PRD, architecture.md,
  or ux-design-specification.md mentions: the attachments drop (a genuinely new agent
  capability), browser-implies-egress coupling, the operator steer input, or the
  no-Manage owner cell. The prd/ux docs describe the pre-#185 operator run picker and
  pre-#186 ownership management if read literally.
- `planning/discovery-2026-08-21-pass22/reference/` exists in this worktree but is
  **untracked** (generated for pass 22, not part of the delta).
- R21-7 (pass 21) deleted FILES.md; nothing in this window regressed that.

---

## Probe candidates

Ordered by how much a live probe could plausibly find.

1. **`run-operator` still honors backend/autonomy form overrides no UI sends**
   (#185). `app/routes/project.task.tsx:877-890` parses `backend` and `autonomy`
   from the POST and passes them into `runOperator` as per-run overrides. After
   #185 the only UI caller sends neither (`task-main-sections.tsx:593-600`), so a
   crafted POST by anyone holding `run-agents` can still run a supervised-configured
   operator at **full autonomy** — the exact "second place for the same decision"
   R21-9 abolished, surviving as an invisible server path. The comment block at
   `:863-865` is also stale ("The backend … and autonomy … are chosen for this
   run"), as is the P11-76 picker-default comment at `:872-876`. Probe: POST
   `intent=run-operator&autonomy=full` on a supervised project; decide whether the
   fields should be dropped or the doctrine says "form field = deliberate act".

2. **Schedule modal still picks per-run backend AND autonomy** (#185 missed
   surface?). `app/features/task-detail/task-main-sections.tsx:424-451` — the
   scheduled-re-run form kept both dropdowns (autonomy offers "Full" whenever the
   project ceiling allows). R21-9's rationale (profile is the one place for this
   decision) applies identically to a scheduled run, and a scheduled run executes
   hours later against whatever the profile THEN says — with a stored per-run
   backend override frozen at schedule time, the #183 stale-display bug's temporal
   twin. Probe: schedule a re-run, switch the operator profile backend, watch which
   backend fires; ask the owner whether the schedule modal should also show-not-pick.

3. **Attachments-drop honesty gap on read-only Codex runs** (#179). The persona
   "Posting files" section + workspace-contract exception are gated only on
   `collab.evidence && realBackend` (`specialist-run.server.ts:1403,1456`), but the
   Codex adapter widens the sandbox only at `workspace-write`
   (`codex-runtime.server.ts:650-652`), and reviewer runs / repo-write-withheld runs
   are forced `read-only` (`:356-358`). An evidence-granted Codex **reviewer** is
   told it may copy files into the drop while the sandbox physically refuses the
   write — the same prompt-vs-enforcement contradiction class as XS-4/P13-RT-02.
   (Claude is asymmetric: write-withheld Claude runs deny Edit/Write but not
   `Bash(cp …)` — `specialist-tool-policy.ts:75` — so the drop works there.) Probe:
   evidence-granted Codex reviewer asked to post a capture.

4. **"Claude Code is unavailable" run-refusal copy** (#185).
   `run-service.server.ts:801-803` are user-facing failure strings surfaced on the
   task page when Claude credentials are missing. They name env vars
   (CLAUDE_CODE_OAUTH_TOKEN) so they were likely kept deliberately as product
   references, but R21-9 says run copy displays "Claude" — confirm intent, since
   this is the one place a human still reads "Claude Code" as a backend name.

5. **Steer comment vs. refused/queued run race** (#185). The steer is appended as a
   real @operator timeline comment BEFORE `runOperator` is called
   (`project.task.tsx:911-918`). If the run is then refused (open-packet manual
   refusal, F20-5/R20-1 — the UI disables the button, but state can change between
   render and submit) the comment stands with no run answering it; if queued (B10),
   the comment lands now and the steered run drains later. Probe both windows —
   does the drained run still carry `humanComment`, and does a refused run leave a
   dangling @operator mention that the NEXT mention-triggered run then answers twice?

6. **Hero vs. board yield asymmetry** (#181). The hero yields on
   `anyRunLive` (`waiting === "agent"` OR any running/queued runtime row —
   including an operator run, `task-detail-page.tsx:292-297`); the board yields only
   on the projection's `waiting === "agent"`. If an operator run can be live while
   `waiting` stays `input_required`-compatible (e.g. the pre-lease window, or a
   run kind that doesn't flip `waiting`), the hero says "agent working" while the
   board card still shows "input required" — the exact mid-run disagreement C3
   complained about, in a narrow window. Probe: hero + board side by side at
   operator-run start on an input-required task.

7. **`deployedSpecialistBackends` cost + silent catch** (#183). Every
   `listProjectTasks` / `getTaskSummary` / `listAgentDeployments` call does a
   project-file read plus a template read per deployed profile
   (`agents-query.server.ts:408-428`) on what board-query's own comment calls "the
   hottest loader path in the app" — no memoization. And the bare `catch { return
   map; }` silently degrades to snapshot display on any parse error, indistinguishable
   from "no drift". Probe: board latency with many profiles; corrupt a template file
   and confirm the fallback is acceptable (and invisible) behavior.

8. **UI-less ownership server actions after #186.** The Manage popover's take-over
   and hand-off flows are gone from the UI, but the server owner-action machinery
   (`setOwner` to another user, `release` by the release-any-ownership tier) still
   accepts them. That's deliberate for `own-x` release, but check whether a
   hand-off-shaped POST (assign a DIFFERENT member) still passes — if yes it's now
   an untested, UI-less path; if it was removed, confirm nothing (operator packets,
   seeds) still emits it. Also note the product regression built in: a hand-off is
   now release + take, leaving a window where the task is Unowned and ANY
   contributor can grab the owner seat before the intended recipient does.

9. **Markdown embed button loses browser link affordances** (#184). The inline
   embed becomes a `<button>` (`markdown.tsx:206-214`) — cmd-click/middle-click
   can't open it in a new tab (no anchor to pass through; the factory's modifier
   passthrough only helps the three anchor surfaces), and in a bare render where
   `CollapsibleComment` passes the factory but no provider is mounted, the button's
   click is a silent no-op. Cosmetic, but it diverges from the "modified clicks
   keep the browser's own intents" contract the other three surfaces honor.

10. **Decisions.md coverage gap** (process). #176's browser-implies-egress is a
    binding capability-policy rule with a documented divergence from B-AG1, and
    #179 adds an agent-facing capability surface — both live only in code comments
    and commit messages. If pass-22 re-derives policy from decisions.md (as prior
    passes did), these two rules are invisible to it. Recommend recording both as
    rulings 93+, and updating prd.md's capability/FR text for the attachments drop.
