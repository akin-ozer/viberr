# RULINGS-DIGEST — every binding ruling 1–92

## Pass-22 revision (2026-08-21)

> Re-verified against `main @26fca45` (HEAD, post PR #186). Since this doc's
> original baseline (`ce2bc9e`, the pass-21 discovery commit) two waves landed:
> pass 21's implementation (PR #175 → `d1bc4a2`, which promoted **rulings
> 84–90** into canon) and the post-pass21 PRs #176–186 (which added **rulings
> 91–92**). `decisions.md` is now **1157 lines**; every Part 1–6 line citation
> below was spot-checked and still holds — the only post-`d1bc4a2` edit to the
> file is one hunk appending rulings 91–92 after `:1106`, and pass 21's own
> additions (84–90) also landed after the Part 1–6 ruling texts.
>
> - **NEW: Part 7 (rulings 84–92)** below, digested from `decisions.md:979-1137`
>   and each enforcement home confirmed present at HEAD on 2026-08-21.
> - **Supersession map extended**: 20→88 (the acceptance disclosure becomes a
>   SERVER invariant), 36↔91 (agent-carried `input_required` leaves the
>   board's attention chip), 67→92 (the per-run autonomy/backend pickers are
>   gone entirely), 75→85, and ruling 86 retires architecture.md's "no linter,
>   by decision".
> - **Worth probing live (ruling-44 class):** the **browser→egress save-layer
>   coupling** (commit `86c5e35`, PR #176) is an owner ruling dated 2026-08-20
>   that lives ONLY in code comments (`app/shared/capabilities.ts:456-474`,
>   `create-profile-modal.tsx:133`) — it is NOT a numbered entry in
>   `decisions.md`, despite deliberately diverging from B-AG1's
>   respect-the-explicit-off posture. Same class for the owner rulings behind
>   PR #180 (packet density) and PR #186 (owner cell) — arguably UI
>   preference, but the egress coupling changes governance semantics and
>   looks canon-worthy.
> - Ruling 7's packet-kind count stays **TEN** (`task-file.schema.ts:74-102`).

> **Verified 2026-08-19 against `main @ce2bc9e`.** Compressed from
> `docs/architecture/decisions.md` (997 lines at that sha; **1157 at HEAD**),
> which is the **normative** copy
> and wins on any conflict with this digest. Line citations below are
> `decisions.md:NNN` for the ruling text.
>
> **These rulings are LAW for this codebase. An implementer must not contradict
> one.** If a change appears to require contradicting a ruling, that is an owner
> decision, not an implementation decision — stop and ask. Rulings 44 (R17-3) and
> 64 (R19-10) exist precisely because *a ruling that lives only in a code comment
> is a ruling that gets silently reversed*.
>
> **How to read a SUPERSEDED ruling.** Several have been narrowed or reversed by a
> later owner decision. They are kept, never deleted: the number is still cited
> in code, and knowing what the old rule *was* is how you avoid re-implementing
> it. **Never restore a superseded rule because you found the ruling text.**
>
> **Legend.** ✓ = the named file/symbol was confirmed present in the tree on
> 2026-08-19. Unmarked homes are those the ruling names but this pass did not
> re-open. `RNN-x` in bold is the ruling's own pass-local id (how code comments
> usually cite it); the leading number is the canonical citation ("orchestrator
> ruling N").

---

## Part 1 — Foundational conventions (1–16)

These 16 predate the numbered-pass era; several carry later amendments.

**1 — Readiness.** (`decisions.md:134`) One canonical 4-value enum
(`ready | input_required | inconsistency_risk_detected | blocked`) in files, Zod
and SQLite; ONE mapping module maps it to the mock's pill kinds. "Accepted" is a
*derived* display state (stage done + accepted), never a stored readiness.
*Enforced:* derivation lives ONLY in
`app/server/interpretation/readiness-policy.server.ts` ✓.

**2 — Roles: three separate systems, kept separate.** (`:137`) Org roles
`admin|member`; project membership roles in `project.md` enforced server-side;
agent capability policy per profile (`direct|recommend|human`), id-based against
a shared catalog, with an always-human server invariant list (merge PR,
transition to done, change project policy).
*Amended:* project roles are `admin | maintainer | contributor | viewer`
(`reviewer` was renamed `contributor`), a strict tier, in ONE table.
*Superseded in part by ruling 25*: FR4's "any authenticated user holds `view`
and `comment`" now means *within projects you are a member of*.
*Enforced:* `app/shared/rbac.ts` ✓ (matrix `:61-88`),
`app/shared/capabilities.ts` ✓ (`ALWAYS_HUMAN_CAPABILITY_IDS:194-198`),
`db/migrations/0001_baseline.sql:28` ✓ (org roles).

**3 — Task-file store** at
`$VIBERR_DATA_ROOT/projects/<slug>/tasks/<KEY>/task.md` (`:151`); the UI renders
the REAL store-relative path wherever the mock showed `.viberr/…`.
*Enforced:* `app/server/files/file-store-root.server.ts` ✓.

**4 — Timestamps.** (`:153`) UTC ISO 8601 at all boundaries; one shared formatter
in `app/shared/dates/` ✓ reproducing the mock's display forms.

**5 — PAT scope violations.** (`:156`) Server-derived per-scope validator results
plus per-violation open/resolved records; the rail badge is the open-violation
count; granting or re-validating writes a typed timeline event to the
violation's OWN task, plus audit and SSE. **No global boolean.**

**6 — Identity.** (`:160`) Compare by **user id** everywhere; display names are
render-only; the session user id is authoritative.

**7 — Packet options carry a stable `kind`** — never dispatch on English titles.
(`:162`) Accept-completion on the HUMAN path triggers a real async PR merge with
an explicit failure state. *Amended by ruling 40:* that holds only on the human
path — a full-autonomy operator acceptance records the PR `accepted` (merge
pending). *Extended:* the kind set is **TEN** — `accept_completion`,
`request_edit`, `block_on_policy`, `hold_runtime_debug`, `redirect`,
`retry_other_backend`, `edit_goal`, `archive_task`, `discard_branch`, `custom`
(`discard_branch` added 2026-08-15 by ruling 77). The same ruling governs the
capability catalog: agent policy is id-based against the shared catalog, and
advisory ids with no runtime consumer get **no toggle**.
*Enforced:* `PACKET_OPTION_KINDS` in `app/schemas/task-file.schema.ts:74-101` ✓
(the source of truth for the count); toggle pruning pinned by
`app/features/agents/capability-catalog.test.ts:40-71` ✓.

**8 — `tweaks-panel.jsx` is not ported** (dev harness, dead code). (`:176`)
Review-queue packet and acceptance mechanics ship before the queue surface; the
queue lives in `app/features/review/` ✓.

**9 — Notifications** are per-user SQLite rows sorted by real timestamp DESC;
task/project references are soft refs. (`:179`) *SUPERSEDED in part* (clean-sheet
seed, 2026-07-24): the two stub projects it seeded are demo data, living in
`npm run seed:demo` only — the product seed ships no board data.

**10 — "Waiting on you" / the review queue stay project-wide in V1.** (`:184`)
*SUPERSEDED for the board* (R8-3): the board's "Waiting on me" chip and the home
card's waiting count are **member-scoped** — a decision the viewer can actually
act on, not the project-wide `waiting === "human"` enum. The review queue itself
stays project-wide.
*Enforced:* `waitingOnMe` derived per-viewer at `app/routes/project.tsx:94-121` ✓;
rendered `app/features/board/board-page.tsx:209-214`, filter chip `:1145` ✓.

**11 — Run lifecycle** is `queued|running|finished|error|interrupted` mapped to
the mock pills. (`:190`) Raw NDJSON/JSONL is truth; the log-line display is a
projection. Elapsed derives from `startedAt`; tokens come from real usage
envelopes only, **never estimates**.

**12 — PR states.** (`:195`) merged → done pill; open/draft → "in review";
closed-unmerged → risk pill "closed". Sync-pill precedence is
merged > behind > synced, derived from real compare data.
*Enforced:* the one PR-state map `app/features/github/github-pills.ts`
(`prStatePill`) ✓ — F19-14 caught a raw internal token leaking past it.

**13 — Prefs.** (`:198`) Drop `ghConnected` (derive from the user row); mount the
Appearance panel; map plural pref ids ↔ singular notification kinds explicitly,
once. *Narrowed:* no mailer in V1, so email/nudge shapes were removed rather than
kept schema-only; each category carries a single in-app `app` toggle.

**14 — Shared single implementations** for notification meta, the markdown-ish
stripper + rich-text renderer, the credential card, and the bell popover
(parameterized). (`:203`) **Never fork these per surface.** Toast, empty-state
and boundary copy in the specs is a verbatim contract, including the
intentionally divergent board-vs-review wording.

**15 — Stages** are a per-project list in `project.md` (hex or `var(--*)` colors
both accepted), created from an instance-default workflow template. (`:207`)
*Narrowed* (owner ruling 2026-07-24): the "Lightweight · 3 stages" preset was
**deleted**; the Standard 5-stage board is the only creation template. Custom
stage lists still exist and are edited per project after creation.

**16 — Deliberate keeps.** (`:212`) Board rail count includes Done; `.card.urgent`
stays visually untreated; `data-screen-label` kept app-wide. *Additions:* a
minimal list-view empty state; Escape-close, focus-trap and scrim-click on every
dialog; `operator` stores the stage id and the UI renders "stage \<1-based
index\>"; login keeps the mock's copy but the password minimum is 8 characters.

---

## Part 2 — Pass 14–15 rulings (17–34)

**17 — PR divergence recovery.** (`:218`) Out-of-band PR transitions are
coordination events: the reconciler fires a `pr-diverged` operator trigger
(closed / merged / reopened). On a closed PR the operator opens ONE recovery
packet: rework (custom + note), `archive_task`, or `archive_task` +
`deleteBranch`. **Remote-branch deletion exists ONLY as that packet resolution**
(refuses open PRs and the default branch).
*Enforced:* `archive_task` case in `app/server/tasks/task-actions.server.ts:4962-4970`
✓ (re-checks `approve-transition` inside the case).

**18 — Minimum GitHub scopes are exactly `repo` + `pull_request:write`.** (`:224`)
`workflow` and `read:org` were dropped; a refused workflow-file push surfaces as
a scope violation when it matters. Fine-grained tokens prove write permission via
empty-payload dry-run probes (**422 = authorized, 403 = refused**).

**19 — Scope chips render proven verdicts only.** (`:228`) A chip is evidence:
scope header, live probe, or open violation. `assumed`/`unchecked` render as an
honest "unproven" line, never as a pseudo-check. *(Ruling 78 reapplies this
posture to model availability: mark from a REAL 400, never a synthetic probe.)*

**20 — R15-1: acceptance requires a verdict.** (`:231`) Human acceptance of a
completion requires a healthy reviewer verdict on the **delivered revision**; the
audited admin Force-accept is the only bypass, and it never bypasses the
PR-head-must-contain-the-delivered-commit check. **Every** accept — force
included — shows a confirm dialog stating what merges and any missing signals.
*Narrowed by 59; extended by 42, 62, 68, and 88 (the dialog's disclosure now
travels WITH the acceptance and the server refuses a bare or stale POST).*
*Enforced:* `acceptanceBlockedReason` `app/schemas/task-file.schema.ts:672` ✓,
composed by `acceptanceRefusalReason` `task-actions.server.ts:5577` ✓; the ONE
dialog `app/features/task-detail/accept-confirm.tsx` ✓ (six modes).

**21 — R15-2: delivery is an OPERATOR decision.** (`:236`) Push + review-PR
opening is no longer a stage side-effect: the operator holds a
`deliver-review-pr` capability and decides when delivery is plausible, opening a
packet when unsure. The server still executes the mechanics; **specialists never
push or open PRs.** Entering the review-role stage with no PR writes a typed
event — never silence. A human delivery button (maintainer+ / task owner) is the
escape hatch.
*Enforced:* `deliverGate` `app/server/tasks/operator-actions.server.ts:473` ✓;
`performDelivery` `app/server/tasks/task-actions.server.ts:3563` ✓.

**22 — R15-3: owner authority covers recommendations.** (`:243`) A task's owner
may apply or dismiss ANY operator recommendation on their own task, including
stage transitions — **the click is the authorization**.
*Enforced:* `ownerException` / `requireDecisionAuthority`
`task-actions.server.ts:284-333` ✓; `applyRecommendation`'s owner-authorized flag
`:3118`, `:3220` ✓.

**23 — R15-5: global ⌘K palette.** (`:246`) Real workspace-wide search (tasks,
branches, agents, projects), scoped to projects the user can see.
*Enforced:* `app/routes/resources.search.ts` ✓.

**24 — R15-6: per-project delete-branch-on-merge setting** (default on): a
successful accept-merge deletes the remote task branch. (`:248`)

**25 — R15-4: projects are members-only.** (`:250`) Non-members cannot open a
project's board, tasks, or any project surface — **404-style**, never 403 (WI-13
secrecy generalized). FR4's app-wide commenting applies within visible projects.
*Enforced:* layout loader `app/routes/project.tsx:75,89-91` ✓;
`requireVisibleProject` `app/routes/project-visibility.server.ts:28-43` ✓;
`requireProjectMember` + `projectNotFound`
`app/server/auth/require-project.server.ts:33-93` ✓ (F19-28 collapsed the 403
oracle and stopped echoing the slug on run-addressed resource routes).

**26 — R15-7: ghost profiles are fully conservative.** (`:253`) A run whose
profile can no longer be resolved gets **nothing permissive** — no delivery, no
comments, no ask-human, no evidence.
*Enforced:* `withheldAgentGrants()` `app/server/tasks/specialist-run.server.ts:237`,
`:1163-1166` ✓.

**27 — R15-8: `design/prd.md` is re-synced** with the canon PRD and both are
maintained. (`:256`) *Re-affirmed pass 18:* the rule had failed a SECOND time, so
"maintained" now means **byte-identical**, pinned by a test rather than by
memory. **Edit the canon copy (`planning/planning-artifacts/prd.md`); the design
copy is a mirror.**
*Enforced:* `app/shared/docs/prd-sync.test.ts` ✓.

**28 — R15-9: an absent `deliver-review-pr` grant resolves from the project's own
governance, not a constant.** (`:266`) The capability postdates R15-2, so
"absent" is normal on every pre-existing project; a flat `direct` would make two
identically-governed projects behave differently **by creation date alone**. The
rule reads the EFFECT off the workflow graph (`humanGatesPreWorkAdvance`: no
pre-terminal boundary advances automatically ⇒ `recommend`). Gate and policy
surface share ONE function so they cannot drift (that drift was F15-20). An
explicit grant always wins.
*Enforced:* `absentDeliverReviewPrMode` `app/shared/capabilities.ts:469-473` ✓,
consumed by `deliverGate` `operator-actions.server.ts:496` ✓.

**29 — R15-10: the first empty board teaches, once.** (`:276`) A project with zero
tasks shows ONE teaching line in the entry column; every other column stays bare,
and the moment any task exists every column is bare again.

**30 — R15-11: the Review queue stays a triage list, but its rows name their
action.** (`:281`) Decisions belong with their evidence, so acceptance stays on
the task page. The row says **"Review", deliberately not "Accept"**: acceptance
is verdict-gated and may refuse, and a control must not name an outcome its
surface cannot promise.

**31 — R15-12: unenforced capability lines are collapsed, never hidden.** (`:286`)
They render in a `<details>` labelled with their count. **An omission the reader
cannot see is worse than an awkward truth.**

**32 — R15-13: settings headings name their own scope.** (`:291`) Instance
settings are titled "Instance settings"; a project's are "<name> · settings".

**33 — R15-14: a resolved agent question goes back to the AGENT THAT ASKED, by
resuming its own session.** (`:295`) `ask_human` still ends the run. The packet
records `askedBy` (profile id, not display label), and resolution routes through
the same path an @mention reply takes — resume the session, re-apply confinement,
re-anchor on `task.md`. The operator hand-off remains the fallback for operator
packets and for an asker whose session or profile is gone, so **no decision is
ever swallowed**.

**34 — R15-15: a task owns a PR only if that task opened it.** (`:305`)
`openTaskPr` ✓ is the sole writer that establishes the link; the reconciler keeps
an owned link honest, never mints one. A PR discovered on the task's branch that
the task does not already reference is a **branch-name COLLISION**, reported as
one — never adopted (a task-key branch is not a unique identifier: a new data
root restarts keys at 1). *Extended by ruling 35.*

---

## Part 3 — Pass 16–17 rulings (35–46)

**35 — R16-1: a pre-existing PR is adopted ONLY IF it is open AND its head sha IS
the task's delivered revision.** (`:313`) Identity, not containment — adoption is
a stronger claim than the acceptance gate, and a task that delivered nothing
adopts nothing. A name-matched PR that fails is reported as a collision
(`prAdoptionRefusalNote`; refusals `not_open | no_revision | head_unknown |
head_mismatch`) and **blocks delivery** — never silently bound, never silently
dropped.
*Enforced:* `app/server/github/pr-adoption.server.ts` ✓.

**36 — R16-2: `input_required` joins the board's attention predicate**, and the
chip is renamed **"Blocked or waiting"** so its label names what it selects.
(`:327`) *Narrowed by 91: an `input_required` task an agent is actively
carrying (`waiting === "agent"`) no longer matches — it belongs to the "Agent
working" chip.*
*Enforced:* `app/features/board/board-filters.ts` ✓, `board-page.tsx` ✓.

**37 — R16-3: terminal GitHub facts outrank process gates in refusal copy.**
(`:334`) When acceptance is blocked, a **closed, unmerged PR** is named FIRST,
ahead of any process gate. While the PR is closed, admin **Force-accept is
WITHDRAWN (hidden), not disabled** — force exists to bypass a wedged *process*
gate, not a settled GitHub state it cannot change. *Extends 20.*
*Enforced:* `forceIrreducibleRefusal` `task-actions.server.ts:5660` ✓ (server-side,
per ruling 59); client withdrawal `task-detail-hooks.ts:167-169` ✓.

**38 — R16-4: correctness first with tests, then the full UI/a11y list — nothing
deferred out of the pass.** (`:342`) The **disposition audit** — every backlog
item's state re-derived from the tree after the fix waves — is what proves "done"
is not "partial". *Extended by ruling 80.*

**39 — R16-5: MCP grants stay OUTSIDE the capability matrix — granting a server
IS the grant.** (`:347`) An MCP server's tools are not enumerated as capabilities
and not gated by the `direct|recommend|human|off` matrix. **Stated plainly: a
withheld `execute-code-or-write-repo` does NOT bound a granted server's tools.**
A deliberate honesty boundary, not a gap.
*Enforced:* pinned by the **ABSENCE** of any `mcp__*` deny rule
(`app/server/tasks/specialist-tool-policy.test.ts` ✓) and disclosed in
`app/features/agents/capability-matrix-modal.tsx` ✓. *(Ruling 75 is the deliberate exception: a browser
must not ride this gap.)*

**40 — R16-6: merge stays human-only — "Done" has two meanings.** (`:357`)
`merge-pull-request` is and stays `ALWAYS_HUMAN`, so a full-autonomy operator
that accepts completion **cannot merge**: it records `pr.state: "accepted"`
(merge pending), moves the task to Done, and a human completes the real merge
later. A *human* acceptance triggers a real async merge. The difference must be
visible where the task lives (board card **and** review queue). Corrects ruling
7's flat claim.
*Enforced:* `operatorAcceptCompletion` `operator-actions.server.ts:2613` ✓;
`complete-merge` ceremony mode `accept-confirm.tsx:41` ✓.

**41 — R16-7: the stale `codex/gpt-5-6-sol-agents` branch was deleted.** (`:366`)
*Premise correction:* the deletion stands, but the claim that certain
contributor/testing docs "no longer exist" was wrong — `docs/contributing-quickstart.md`
and `docs/testing-quickstart.md` both exist. **Discard the missing-docs premise.**

**42 — R17-1: acceptance may accept a head AHEAD of the reviewed revision, but
MUST surface the divergence.** (`:372`) The gate stays **containment-based**. The
accept dialog AND the force dialog must show the ACTUAL merge head and an
"N commits added since review" warning; the audit names the real merge head, not
the reviewed sha. A head that has DIVERGED (no longer contains the delivered
commit) still refuses.
*Enforced:* `pr.revisionDrift` rendered `accept-confirm.tsx:333-346` ✓.

**43 — R17-2: a verified no-diff task is a first-class "Completed — no changes"
outcome.** (`:382`) A task whose branch carries no diff against the base (or has
no branch) may close to Done WITHOUT a PR or merge, through its own acceptance
path, its own timeline event, operator-recommendable. **Amended by ruling 62 —
the "reviewer verdict optional" clause is SUPERSEDED**; the no-change path now
passes the same verdict gate.

**44 — R17-3: rulings live in `decisions.md`; a docs-canon re-read is a required
closing step of every pass.** (`:392`) **A ruling a code comment cites but no
canon file records is a ruling that gets reversed.** Every owner ruling a pass
produces is promoted into that file, in this numbering, before the pass closes;
and re-reading the operational docs (`file-formats.md`, `deployment.md`,
`runbook.md`, `testing.md`) against the tree is itself a required closing phase,
alongside the disposition audit.

**45 — R17-4: the local sign-in form leads when NO OAuth provider is configured.**
(`:401`) With neither GitHub nor Google configured, the provider buttons are not
rendered at all — the local form comes first and SSO shrinks to a one-line
footnote. With at least one configured, SSO-first stands (including the D12
disabled button for the other). *Enforced:* `app/routes/login.tsx`.

**46 — R17-5: "never synced" is neutral; only a genuinely stale cache warns.**
(`:409`) `reconcile.at: null` reads neutral ("Not synced yet", clock icon); only
`stale && at !== null` keeps the alert tone. Matches the MCP-health precedent
where "never checked" was already "unknown", not "stale".
*Enforced:* `app/features/github/github-view.tsx` ✓.

---

## Part 4 — Pass 18 rulings (47–54)

**47 — R18-1: a reviewer inherits the DELIVERING engagement's KBs.** (`:419`) A
specialist engaged as REVIEWER gets the UNION of its own KB grants and the KB
grants the delivering engagement used, so deliverer and reviewer judge against
the same conventions. Deduped, non-delivering runs only, tolerant of an
undeployed deliverer, same on the resumed/@mention path.
*Enforced:* `deliveringContextGrants` / `withDeliveringGrants` in
`app/server/tasks/specialist-run.server.ts` ✓. *Re-affirmed by ruling 57.*

**48 — R18-2: a full-autonomy delivery re-queues the operator.** (`:435`) Opening
the review PR is delivery, NOT a stage transition, so the every-transition
re-trigger never fired after it — an autonomous task sat `waiting:human` with no
packet or card. Under **FULL** autonomy the server re-queues the operator with a
`delivered` trigger. **SUPERVISED deliberately does NOT re-trigger** (ruling 58
covers that case instead). Only a NEWLY opened PR fires it; the chain shares
`OPERATOR_TRANSITION_CHAIN_CAP` ✓.
*Enforced:* `performDelivery` `task-actions.server.ts:3563` ✓; the `delivered`
trigger in `app/server/runtimes/operator-run.server.ts` ✓.

**49 — R18-3: the SDK-native skill/command catalog is governed OUT of runs.**
(`:446`) A run loads ONLY Viberr's granted skills. The workspace clone's own
`.claude` catalog is stripped before the run (git-invisibly, via `--skip-worktree`
so delivery never ships a `.claude` deletion into the PR), and the Claude launch
carries `strictMcpConfig: true`. **Accepted limitation:** a run whose task is to
edit the repo's OWN `.claude` cannot deliver those edits — that is the posture,
not a bug.
*Enforced:* `stripUngovernedRepoCatalog` in `specialist-run.server.ts` ✓ (and
`operator-run.server.ts` ✓); `app/server/runtimes/claude-runtime.server.ts` ✓.

**50 — R18-4: branch-collision stays a human-gated packet — do NOT auto-reset.**
(`:458`) A stale remote task branch forces a collision packet before delivery.
The rejected alternative was "always force-reset the remote task branch to base
at execution start"; the packet is kept as an intentional safety checkpoint
against clobbering unrelated remote history.

**51 — R18-5: granted skills reach a Claude run through the SDK's NATIVE skills
mechanism, not injected prompt text.** (`:465`) `skills: ["<granted>", …]` +
`settingSources` loads NAME + DESCRIPTION at startup and pulls a body only on
invocation; the allow-list is also what contains the SDK's ~16 compiled-in
skills. Isolation: only Viberr-granted skills mounted (after ruling 49's strip),
`plugins: []`, no `'user'` setting source, `.claude/` excluded from git.
**Codex keeps prompt-text injection** — its CLI has no equivalent; the asymmetry
is disclosed, not silent.

**52 — R18-6: `design/prd.md` is re-synced to canon and pinned by a test.**
(`:483`) See ruling 27; "maintained" = byte-identical, enforced by
`app/shared/docs/prd-sync.test.ts` ✓.

**53 — R18-7: accepting from the BOARD asks first.** (`:488`) Dragging a card into
the final stage runs the full acceptance contract — a real PR merge — so the
board drag and the keyboard Move menu raise a confirmation stating the
consequence and that merging is one-way. The drag stays possible; only the
silence goes.
*Enforced:* `AcceptOnBoardConfirm` `app/features/board/board-page.tsx:924` ✓,
state `:1521`, keyboard path `:1649-1656`, render `:2044` ✓.

**54 — R18-8: F18-9 is closed as NOT REPRODUCIBLE.** (`:494`) The claim that the
agent-profile modal defaults every org skill to ON could not be reproduced — both
modals initialise a new profile with empty grants. Acting on the note would have
introduced the over-granting it warned about. **Recorded as a class: a finding
taken from a UI impression and never re-verified in code can survive several
passes as fact.**

---

## Part 5 — Pass 19 rulings (55–75)

**55 — R19-1: the operator gets a FULL read-only clone of the project repo before
it triages.** (`:501`) Live, the operator's cwd held only `task.md` and the model
wrote a packet reporting "no docs/ or README found" about a repo that has both,
then invented options from that emptiness. A packet must be grounded in the REAL
repository. The clone is the SAME per-task checkout a specialist run uses, and an
EXISTING checkout is returned untouched. Read-only is a posture, not a filesystem
mode. **A clone failure is a first-class `unavailable` arm carrying git's own
redacted complaint — never silence**, because a run that does not KNOW it is
blind falls back to describing the task folder.
*Enforced:* `app/server/runtimes/operator-run.server.ts:776-800`, `:1139`,
`:1478`, `:2032` ✓. *(The ruling's symbol name `operatorWorkspaceView` no longer
appears verbatim — grep "R19-1" in that file.)*

**56 — R19-2: repo-documented conventions OUTRANK knowledge bases; the KB
supplements.** (`:525`) Where a repo file states a convention (README,
CONTRIBUTING, `docs/`, a linter config, or the established pattern of the files
being edited) the **repository wins**; KB guidance applies where the repo is
silent; a genuine conflict is followed **repo-first and reported by name** as a
typed context-conflict event; an existing file family is never rewritten into a
KB's style. Ships as ONE constant emitted immediately before the KB bodies it
ranks, imported by both runtimes, and emitted **only when real KB text is
present**.
*Enforced:* `KB_PRECEDENCE_NOTE` in `app/server/files/kb-injection.server.ts` ✓
(consumed by `specialist-run.server.ts` ✓ and `operator-run.server.ts` ✓).

**57 — R19-3: reviewer inheritance stays KBs ONLY — ruling 47 stands.** (`:541`)
A docstring claimed the inheritance had been "widened to SKILLS by LV-F3"; it
never was, and the owner declined the widening. Skills are **deliberately not
inherited**; the absence is pinned by a test. Same class as ruling 54: a claim
that lives only in a comment is a claim nobody re-derives.

**58 — R19-4: a SUPERVISED delivery must leave an actionable next step, and the
SERVER guarantees it.** (`:553`) Live, a supervised operator delivered, narrated
"no further action needed", and recorded nothing — leaving the human with nothing
to act on. `performDelivery` now ensures a "Move to \<review\>" recommendation (or
equivalent packet) exists whenever an operator-authorized supervised delivery
recorded none. Deliberately conservative (adds nothing when an open packet IS the
next step, when the task is already at/past review, or when no edge exists) and
idempotent.
*Enforced:* folded into `performDelivery` /`addRecommendation` in
`app/server/tasks/task-actions.server.ts:3880`, `:4169` ✓. *(Citation drift: the
ruling names `ensureDeliveredNextStep` in `operator-actions.server.ts`; the
session merge inlined it into `task-actions.server.ts` — grep the comment
"ensureDeliveredNextStep".)*

**59 — R19-5: force-accept MAY skip the remaining stages AND the review gate — but
it must SAY so.** (`:572`) An implementer added a server 409 refusing an
off-boundary force; **the owner REVERTED it** — force exists to unstick a wedged
board, and a refusal turns the one escape hatch into another wall. The burden is
HONESTY: the affordance is labeled with what it does and the confirm dialog
**enumerates the stages being skipped**. What force does NOT bypass: ruling 37's
terminal GitHub fact (server-side) and ruling 20's PR-head containment check.
*Narrows 20; extends 37 and 42. Ruling 88 later put this honesty burden behind
a server check: the force dialog's disclosure (skipped stages included) must
reach the server with the acceptance.*
*Enforced:* `forceIrreducibleRefusal` `task-actions.server.ts:5660` ✓; the
force-only `Skips` row `accept-confirm.tsx:202`, `:373` ✓.

**60 — R19-6: a capability set to `off` is a HARD REFUSE by every route — no card,
no audit row.** (`:587`) With `completion-for-acceptance: off` the operator still
produced an `accept_completion` card by **rerouting through a plain
terminal-stage transition**. `off` is a withheld capability, not a routing hint:
the gate is checked FIRST, before any read, card or audit row, on every path
including the terminal-target reroute; `human` refuses the same way while saying
the decision is reserved for a human. **The operator refuses out loud** — a silent
reroute is worse than a refusal.
*Enforced:* `operator-actions.server.ts:2459-2466` (reroute), `:2566-2600`
(refusal helper), `:2619-2626` (first statement of the acceptance path) ✓.

**61 — R19-7: the Activity audit column compacts consecutive runtime-session-open
rows.** (`:600`) 8 of 9 visible rows read "operator opened the \<role\> runtime
session", burying the events the column exists for. Consecutive runs fold into
ONE expandable "N runtime sessions opened" row; **nothing is deleted** (entries
are handed back on expand with real per-row timestamps). **The recognizer is
anchored at the END of the sentence, and that anchoring is load-bearing
(F19-40):** `entry.text` OPENS with the actor's display name, so an unanchored
matcher let a member named `Mallory (opened the dev runtime session)` fold their
own `task.acceptance.forced` and `project.org_admin.override` rows.
*Enforced:* `app/features/activity/activity-page.tsx` ✓.

**62 — R19-8: a "Completed — no changes required" task passes the SAME verdict
gate as every other acceptance** — ruling 43's "verdict optional" clause is
SUPERSEDED. (`:618`) Reaching the outcome meant minting a `workRevision` anchored
to the real default-branch head (a verdict needs a subject). "Nothing needed
changing" is a CLAIM about the repository and is exactly the claim worth a second
pair of eyes. The path keeps the ceremony and only loses the PR. **Counterpart
honesty rule:** `defaultBranchEvidence.verified` from push-workspace is required
on BOTH doors (`no_branch`, `no_commits`), so a dirty tree, local commits on the
default branch, an abandoned task branch or a swallowed auto-commit failure all
stay a genuine delivery failure.
*Enforced:* `app/server/tasks/no-change-completion.server.ts` ✓
(`probeNothingToDeliver:107`, `acceptanceNoChangeCheck:280`,
`assertVerifiedNoChangeStillApplies:339`, `noChangeCompletionEvent:361`);
`app/server/github/push-workspace.server.ts` ✓.

**63 — R19-9: the numeric NFR1–NFR5 performance targets are DROPPED from canon — a
target nobody measures is a claim, not a requirement.** (`:645`) None of the four
figures was ever measured; the damage is the *precision* — printing an unenforced
number teaches the reader that the enforced requirements might be decorative too.
They are replaced by qualitative requirements. **NFR5 is KEPT**, re-cast from
timing into behaviour (bounded newest-first timeline slice + bounded run-log
window, console pages backwards on demand). **Standing rule: a latency budget
lands in the SAME change as the harness that measures it, never before it.**
*Enforced:* `app/features/task-detail/timeline-slice.ts` ✓,
`app/routes/project.task.tsx` ✓, `app/routes/resources.run-log.ts` ✓.

**64 — R19-10: the two unshipped spec'd components get BUILT.** (`:671`) The
Continuity Recovery Panel (D18) and board arrow-key traversal (D19) stop being
debt: both sit on the product's trust story rather than its feature list.
Recorded alongside the build so the ruling survives independently of any single
implementation attempt.
*Enforced:* `app/features/task-detail/continuity-recovery.tsx` ✓;
D19's roving tab stop in `app/features/board/board-page.tsx:691`, `:754`, `:1775`
✓.

**65 — R19-11: a read-only Viewer does not see the project credential card — the
PAT half of Q-V1 is implemented, not deferred.** (`:692`) The card advertises a
secret's existence, fingerprint, scope verdicts and rotate/remove controls to
someone whose role cannot touch any of it. Three consequences: the card is
**withdrawn, not disabled** (ruling 37's precedent); the predicate is the SAME
`ACTION_ROLES` entry the route's action guard enforces (**`grant-github-scope`**);
and **the loader redacts on that same rule**, because a client-only gate leaves
the token tail in the HTML. Requires a full-page render at Viewer asserting the
card is ABSENT, canaried by removing the gate — *an owner ruling whose guard
cannot go red is a ruling that gets reverted in silence.* *Extends 25 from "may
you open it" to "may you see what is inside it".*
*Enforced:* `app/features/github/github-view.tsx:136-148`, `:471`, `:638` ✓;
`app/routes/project.github.tsx:95-120` ✓.

**66 — R19-12: both accessibility gates get built.** (`:717`) A systematic
both-theme WCAG AA contrast sweep, and a check enforcing the spec's "no control
is hidden or disabled at any width" contract. The width contract is **a
correctness rule wearing accessibility clothing**: hiding a control below a
breakpoint makes the surface dishonest about what the user may do, so a narrow
window must reflow the same interface and **nothing may be gated on
`matchMedia`**. Both become suite-failing gates, like the no-undeclared-token
rule.
*Enforced:* `app/app.css` + `app/app.css.test.ts` ✓ (no-allowlist integrity gate).

**67 — R19-A: a run may never exceed the project's configured operator autonomy —
the per-run level is a CEILING, not a pin.** (`:739`) Any `run-agents` role could
launch one turn at `full` on a `supervised` project, promoting every `recommend`
capability to direct execution with no confirm and no distinct audit row. **The
Policy page presents autonomy as PROJECT configuration; a per-run dropdown that
silently outranks it makes that page a lie.** Choosing LESS autonomy stays
allowed and is not a clamp; omitting the override is not a clamp. The clamp is
audited **only when it bites**, via `task.operator.autonomy_clamped`.
*Enforced:* `clampAutonomy:224` / `auditAutonomyClamp:246` / `operatorAutonomyFor:334`
in `app/server/tasks/operator-actions.server.ts` ✓ (anchors +3 at HEAD:
`clampAutonomy:227`, `auditAutonomyClamp:249`, `operatorAutonomyFor:337`).
*Extended to the DISPLAY by ruling 82. Ruling 92 then removed the per-run
autonomy (and backend) dropdowns from the operator card entirely — the clamp
machinery survives server-side as the invariant behind it.*

**68 — R19-B: a project member's GitHub approval on the PR counts as the approving
verdict.** (`:756`) Closes the asymmetry where a human's disapproval bound the
gate (ruling 37) while their approval was inert — forcing every acceptance on an
agent-less project to be an audited force-accept. Four things make it evidence:
(1) bound to the delivered revision (`commit_id` must equal the delivered head,
checked on record AND on every read, so re-delivery invalidates it); (2) the
approver must be a project member via `users.github_handle`; (3) it **fails
closed** (no handle, two claimants, non-member ⇒ does not count, reason
recorded); (4) it is **never silent** — the gate names the human, handle and
commit. Composes with rulings 20 and 62; it cannot fire on a no-change
verification revision.
*Enforced:* `humanVerdictApproval:210` / `verdictGateReason:306` in
`app/server/github/pr-human-approval.server.ts` ✓, threaded through
`app/server/projections/rebuilder.server.ts:336-337` ✓; disclosed in the dialog
at `accept-confirm.tsx:352-361` ✓.

**69 — R19-13: git's own failure text is SURFACED to the human, redacted, where it
used to be dropped whole.** (`:777`) Clone and push failures scrubbed git's
stderr entirely, so a failed delivery recorded its reason NOWHERE. The credential
lives in the askpass env (never in argv or the URL), so a token-SHAPE backstop
redaction plus ANSI/C0 stripping is sufficient; git's redacted complaint is now
surfaced in the run log, in fenced "What the checkout/push reported:" timeline
blocks, and in a ≤240-char delivery reason. **One redactor module, one choke
point.** *(B's instruction to record this as "ruling 59" is VOID — 59 is R19-5.)*
*Enforced:* `app/server/secrets/git-output-redact.server.ts` ✓.

**70 — R19-14: new tasks are created at the ENTRY stage only.** (`:792`) Every
non-terminal lane used to carry a "New task in this stage" button, so a human
could drop a brand-new task straight into Review and skip the triage quality gate
(FR15). `createTask` refuses any non-entry `stageId` (naming the entry stage in
the refusal) and the board offers the per-lane button on the entry lane alone.
Existing tasks are unaffected; file-level fixtures (`createTaskFile`) stay as
they are.
*Enforced:* `createTask` `app/server/tasks/task-actions.server.ts:399+` ✓; the
`Column` header in `app/features/board/board-page.tsx` ✓.

**71 — R19-15: notifications are auto-read on VIEWING their target.** (`:805`)
Loading a task page marks ALL of that user's unread notifications for that task
read (every kind). The write lives in the task route's loader deliberately: no
link prefetch, idempotent and monotonic (`read_at IS NULL` guard), the emitted
`notification.read` event converges, and it runs **only after authorization** so
the members-only 404 path stays pure.
*Enforced:* `markTaskNotificationsSeen` in
`app/server/projections/notifications.server.ts` ✓, called from
`app/routes/project.task.tsx` ✓.

**72 — R19-16: OAuth sign-in is configured IN THE APP.** (`:819`) A new
org-settings **Sign-in & SSO** tab; credentials saved there **override** the
deployment env; enabling a method **requires a passing credential test**. Three
honesty rules: saving never enables; changing either half of the pair clears the
verdict AND switches the method off; a passing test says what it proved (the
pair) and what it did not (the callback registration, shown with a copy button).
Secrets are sealed; the running auth handler picks changes up per-request via
`oauthConfigFingerprint` — no restart.
*Enforced:* `app/server/auth/oauth-providers.server.ts` ✓,
`oauth-credential-test.server.ts` ✓, `app/features/org-settings/sso-panel.tsx` ✓,
`app/shared/auth/auth-paths.ts` ✓.

**73 — R19-17: a failed MCP command's OWN WORDS are surfaced — and kept.** (`:833`)
stderr is captured (piped, 8KB cap), scrubbed by value + token-shape through the
shared `redactGitOutput` (the child holds `MCP_CREDENTIAL`, so this is ruling
69's credential-safety bar), appended to the probe verdict, **persisted** as
`last_error`, and rendered under the row. A first-run INSTALL is distinguished
from a hung command so "downloading cpython" is not reported as "unreachable".
*Enforced:* `discoverStdioMcpTools` in `app/server/org/resources.server.ts` ✓;
`app/features/org-settings/resource-rows.tsx` ✓.

**74 — R19-18: first-run MCP installs FINISH IN THE BACKGROUND.** (`:845`) A
`uvx`/`npx` server that installs on first use could never go green — the probe
killed it at the deadline and uv only commits its cache on completion, so every
retest restarted from zero. Warm-up starts **automatically** when a probe gives
up on a visibly-installing command, capped at **15 minutes**, with the page
re-checking (~20s) until the row becomes a real verdict. Same handshake, bigger
deadline — not a second code path; a boot reaper clears orphaned flags.
*Enforced:* `app/server/org/mcp-warmup.server.ts` ✓; reaper in
`app/server/boot.server.ts` ✓; polling in
`app/features/org-settings/resources-panel.tsx` ✓. *Extended by 79.*

**75 — R19-19: agents get a REAL BROWSER — as a first-class capability.** (`:859`)
Four explicit decisions. **(a) Governance:** a new `use-browser` agent capability
(**default off**), enforced on BOTH backends by mounting or withholding a
viberr-owned Playwright MCP server per run — deliberately NOT a bare
org-registry mount riding ruling 39's instruction-only gap; the mount
**additionally requires effective `use-web-search-fetch`**, so revoked egress
cannot be re-acquired one row down. **(b) Injection stance:** prompt-level
guardrails — page content is data, never instructions; never enter credentials;
**the browser widens no authority**. **(c) Deployment:** chromium ships IN the
app image. **(d) Output:** artifacts land in the task's canonical `attachments/`
dir — **member-only serving**, rendered on the task page, citable in evidence
references.
*Enforced:* `app/shared/capabilities.ts:101-111`, `:240` ✓;
`app/server/tasks/specialist-browser-mcp.server.ts:100-142` ✓; `Dockerfile` ✓;
`app/server/files/file-store-root.server.ts:87` ✓; `app/routes/task-attachment.ts`
✓. *Extended by 85 (a gap packet names the grant remedy) and by the 2026-08-20
owner ruling (PR #176, un-numbered): granting the browser IMPLIES web egress —
the save layer repairs `use-web-search-fetch` to `direct` under a `direct`
browser (`repairBrowserEgressGrants` `capabilities.ts:475`), the editor pins
the egress row, and the mount gate stays as the backstop for hand-edited
files.*

---

## Part 6 — Pass 20 rulings (76–83)

**76 — R20-1 (F20-5): confirming a recovery option on a failure packet RESOLVES it
and RE-QUEUES the operator — no repeat confirms, and the label says exactly what
happens.** (`:879`) Live: the "Operator run failed" packet offered "Update the
policy / credential and unblock" whose recorded effect was a HOLD; the open
packet then accepted "Confirm decision" three times, writing three identical
decision entries; and a human-pressed "Run operator" burned a paid no-op. The
ruling: confirming ANY recovery option resolves the packet (a settled decision
refuses the next confirm), option labels must state their real effect, a settled
decision re-queues the operator automatically (except the documented NO_REQUEUE
set), and a repeat failure opens a NEW packet with a fresh decision record. A
manual "Run operator" is **refused while a packet is open**
(`refused: "open-packet"`) rather than paid for. *Extends 7 and 17.*
*Enforced:* `resolvePacket` `app/server/tasks/task-actions.server.ts:4621` ✓; the
`packet-resolved` trigger and `refused: "open-packet"` in
`app/server/runtimes/operator-run.server.ts:139-222` ✓.

**77 — R20-2 (F20-6): `accept_completion` re-verifies the ACTUAL branch state, and
the packet's discard option actually deletes the never-pushed branch.** (`:894`)
Live (VIB-2): a verification-only task whose branch stayed byte-identical to main
and was never pushed; the completion did not set `noChanges`, so
`accept_completion` refused with advice that would have opened an EMPTY PR, and
the operator's chosen "delete the branch" option was **unexecutable**. The accept
path now re-verifies branch state — empty or missing routes into the no-change
acceptance path, **with disclosure, regardless of the agent's `noChanges` flag**
— and a new **`discard_branch`** packet kind (ruling 7's tenth) deletes the
never-pushed LOCAL branch on confirm. `discardLocalTaskBranch` refuses an
on-remote branch (remote deletion stays ruling 17's packet path). Consistent with
ruling 62 — the no-change path keeps the full verdict gate.
*Enforced:* `app/server/tasks/no-change-completion.server.ts` ✓;
`discardLocalTaskBranch` called at `task-actions.server.ts:5225-5235`, `:5300-5310`
✓; `PACKET_OPTION_KINDS` `app/schemas/task-file.schema.ts:95-101` ✓.

**78 — R20-3 (F20-4): the provider's OWN WORDS reach the packet and timeline
(redacted), and model availability is validated against the account.** (`:908`)
Live: a seeded Developer shipping `gpt-5.6-sol` on a ChatGPT-account Codex that
rejects it (400), while the blocked packet said only "Codex execution failed.
Review its authentication and runtime configuration." Both halves ship: a
redacted `providerText` from `classifyCodexFailure` / `classifyClaudeError`
reaches the persisted `err` line, the packet observation, the escalation and the
timeline (`redactProviderText`, its own 240-char clamp beside ruling 69's git
redactor); AND model availability is marked from a **REAL 400** and cleared on a
real success — no synthetic probe (ruling 19's posture) — in a
`model_availability` table, so a marked model is disabled **with a reason**.
*Extends 69.*
*Enforced:* `redactProviderText` ✓ (`app/server/runtimes/claude-runtime.server.ts`,
`app/server/tasks/agent-reply.server.ts`);
`app/server/runtimes/model-availability.server.ts` ✓, `model-catalog.server.ts` ✓;
`app/server/secrets/git-output-redact.server.ts` ✓.

**79 — R20-4 (N20-2): a first-ever probe of an npx/bunx-style stdio command that
times out is treated as visibly-installing.** (`:923`) uvx already warmed a
first-run install in the background (ruling 74), but a cold `npx -y …` exceeding
the 20s probe showed a bare "timed out" because npx's progress output did not
match the heuristic. Same 15-minute cap, same polling row. Backed by
`first_success_at` + `heuristic_warmups` columns so the warm-up is armed **at most
once per command** and rolled back if it fails. *Extends 74.*
*Enforced:* `app/server/org/resources.server.ts` ✓,
`app/server/org/mcp-warmup.server.ts` ✓, `db/migrations/0001_baseline.sql` ✓.

**80 — R20-5 (scope): pass 20 fixes EVERY defect and every UX-coherence/drift item
that is a defect or inconsistency — only pure never-built PRD features are HELD.**
(`:935`) The whole ledger (F20-1..30, N20-1..14, C1..C14, D2..D13) is committed
todos: no deferral, each validated. The only HELD items are net-new features:
**D7** (Decision-Packet impact/confidence/severity fields), **D10/D11**
(Continuity-Recovery-Panel escalated/paused states; the Execution-truth-strip
runtime-continuity fact), **D12** (skeleton loaders). Each held item stays noted
as a spec-vs-app gap, not silently dropped. *Extends 38.*

**81 — R20-6 (F20-21): specialists act DIRECTLY or are WITHHELD — `recommend` is
dropped for the specialist kind.** (`:946`) `coerceSpecialistCapabilityMode`
silently widened a specialist `recommend` to `direct` while the seeded canonical
`project.md` shipped `recommend` for the Developer's `move-task-to-review` and the
Reviewer's `approve-review`/`request-changes` — so the file said one thing and
every rendered surface said another, **with the dangerous polarity
(recommend→direct) as the silent one**. The ruling makes file = enforcement =
display: remove the silent widening (a stray `recommend` normalizes DOWN to
`off`) AND make the seed honest (write `direct`). The operator keeps its real
`recommend`. *Extends 2.*
*Enforced:* `coerceSpecialistCapabilityMode` `app/shared/capabilities.ts:337-341`
✓ (docblock `:321-336` names re-introducing the widening as the F20-21
regression); `SPECIALIST_CAP_MODES` `app/features/agents/capability-catalog.ts:149-153`
✓; `app/server/seed/agent-catalog.server.ts` ✓.

**82 — R20-7 (F20-9 / D1): the capability display MIRRORS the runtime gate — the
Agents card and the Capability matrix bucket grants autonomy-aware.** (`:957`) An
operator profile holding `completion-for-acceptance: direct` on a **supervised**
project rendered "Accept completion into Done" under ACTS DIRECTLY — authority
the server refuses. The display gate now applies the autonomy ceiling the same
way it already applies the verdict gate, so under a supervised project the row
renders gated/conditional; and the Agents card carries the Policy page's
reconciling note for the always-human "Transition a task to Done" row beside it.
*Extends 67 and 2.*
*Enforced:* `applyAutonomyCeiling` + `capabilitiesToActionLabels`
`app/features/agents/agents-query.server.ts:119`, `:153-165`, `:178-205` ✓;
`app/features/agents/agents-page.tsx` ✓; the runtime mirror at
`app/server/tasks/operator-actions.server.ts:2674` ✓.

**83 — R20-8 (F20-4 seed half): the seeded Developer's default Codex model becomes
`gpt-5.6-terra`.** (`:972`) The seed shipped `gpt-5.6-sol`, which this
deployment's ChatGPT-account Codex cannot run; the CLI default is what the
account actually runs. Ruling 78 still ships — a future mismatch is surfaced with
the provider's own words and marked unavailable — so this changes the **default**,
not the honesty machinery.
*Enforced:* `app/server/seed/agent-catalog.server.ts` ✓.

---

## Part 7 — Pass 20 late + pass 21–22 rulings (84–92) — Verified 2026-08-21

**84 — R20-9 (F20-31): the operator MAY gather a delegated ask itself, and the
packet must SAY it stands in for the delivering agent.** (`:979`) A goal can
delegate a clarifying question to the agent that will do the work; holding scope
hostage until that agent spins up stalls the task for no gain, so the operator
may collect the answer at triage with its own `open_decision_packet` (type
`"input"`) — but the packet body must state it is gathering the answer **on the
delivering agent's behalf**. Enforcement is **MECHANICAL, not advisory**: the
run remembers which agents it prompted this turn and the packet-open path
APPENDS the disclosure to the body it writes, so omission is impossible rather
than discouraged (the prompt clause stays as guidance layered over a
guarantee). Sits beside the standing rule that the operator may not WITHDRAW an
agent's ask (`operatorResolvePacket` refuses a packet carrying `askedBy`).
*Provenance note:* ruled in pass 20's own ledger, promoted to canon in pass 21
(U4) after the id was cited by a shipped prompt and its test while no canon
file recorded it — ruling 44's failure class, reproduced one pass later. Pass
21's other id `R21-1` (a mid-pass Codex re-auth step) is deliberately NOT
promoted: operational steps are not law.
*Enforced:* `consultationDisclosure`
`app/server/tasks/operator-toolkit.server.ts:207`, appended at `:236` ✓; the
prompt clause `triageQualityGate` in `app/server/runtimes/operator-run.server.ts` ✓.

**85 — R21-2 (OBS-1): a capability-gap packet names the product's OWN remedy —
grant the capability on an agent profile — and the operator still changes no
configuration itself.** (`:1008`) Live (VIB-1): every deployed specialist had
`use-browser` withheld and the packet offered only workarounds (script it by
hand, capture it yourself, narrow the goal) — teaching the human the product
cannot do a thing it ships as a grant. When the blocker is a withheld
capability, the packet names the capability, says where a human grants it (the
project's Agents surface) and keeps that option beside the workarounds. The
division of labour is untouched: capability/policy edits stay human
(`change-project-policy` is always-human, ruling 2). *Extends 75.*
*Enforced:* packet construction in `app/server/runtimes/operator-run.server.ts` ✓.

**86 — R21-3 (U1): the anti-slop lint plugin is ADOPTED — `npm run lint` is a
required CI gate, and "there is no linter, by decision" is retired.** (`:1023`)
The lint commits had rewritten 387 files while architecture.md still said twice
that there is no linter *by decision*, and the script exited 1 on a clean tree
with 26 findings whose acceptance lived only in a commit message. The owner
ruled adoption: the 26 survivors are **FIXED, not suppressed** (a red script
whose redness is "accepted" somewhere unreadable is not a gate), `npm run lint`
is a required step of the `verify` job, and architecture.md's "no linter"
sentences carry dated amendments. The rewrite's own four regressions
(F21-7/8/9/11 — drifted check-runs payload, one malformed commit emptying the
commit list, the github client's never-throws contract broken, drifted PAT
permissions upgrading to "valid") were fixed in the same pass. **Standing
lesson: a mechanical tree-wide rewrite carries the same review bar as
behavior, because it changes behavior.**
*Enforced:* `.github/workflows/ci.yml` ✓ (Lint is the FIRST verify step,
before typecheck); `npx oxlint` exits 0 at HEAD ✓; zero `vi.mock` anywhere ✓
(the last one became an injection seam, `d5b5e11`).

**87 — R21-4 (OBS-8/OBS-9/G5): task workspaces clone through a per-project
mirror cache, and the pre-run workspace phase is VISIBLE on the task page.**
(`:1049`) Live (VIB-3): a create-triggered run spent 3+ minutes inside a 113MB
`git clone` with an empty timeline — a healthy run indistinguishable from a
wedged one — and every task paid the clone again. Both halves: **(a)** a
per-project git mirror/reference cache backs task clones; **(b)** `onPhase` —
declared on the adapter interface and never once invoked, so FR28's live-progress
rows rendered blank — is actually driven, with a "preparing workspace" phase
covering the clone.
*Enforced:* `projectRepoMirrorDir:98` / `cloneWorkspaceRepo:411` in
`app/server/tasks/repo-mirror.server.ts` ✓ (409-line test file beside it);
`onPhase` `app/server/runtimes/adapter.server.ts:167` ✓ →
`run-service.server.ts`; rendered by `app/features/runtime/runs-panels.tsx` ✓.

**88 — R21-5 (F21-2): an acceptance is valid only WITH the disclosure the human
was shown — a bare POST is refused.** (`:1068`) Ruling 20's ceremony held
**client-architecturally only**: the server took a bare POST and accepted, so
the contract held exactly as long as nobody skipped the dialog (stale tab,
replayed form, console fetch). Now every HUMAN acceptance door — normal and
forced, packet, applied recommendation, stage-move, board — carries an
acknowledgment **echoing the three facts the dialog rendered** (the PR state,
the delivered revision sha, the verdict), the server refuses an acceptance that
arrives without one, and an echo that no longer matches the live task (drift,
out-of-band merge, a verdict landing) is a refusal — re-compared **inside the
write lock**. Operator acceptance keeps its own disclosure contract (40, 77)
and is unchanged. *Extends 20; puts 59's honesty burden behind a check.*
*Enforced:* `app/shared/acceptance-disclosure.ts` ✓ (ONE definition imported by
both sides — `acceptanceDisclosureFields:55`, `parseAcceptanceDisclosure:85`,
`acceptanceDisclosureDrift:137`); the dialog builds the echo from its rendered
props (`accept-confirm.tsx:254`, `onConfirm(disclosure)` prop `:173-177`) ✓;
server checks at every human door in `task-actions.server.ts` (grep
"Ruling 88" — ~8 sites incl. the in-lock re-compare) ✓; e2e pins the gate's own
words and the no-stale-echo path (`e2e/01-home-board.spec.ts:245+`) ✓.

**89 — R21-6 (U5/G4): the triage quality gate stays BEHAVIORAL — no mechanical
transition block on open packets.** (`:1094`) The operator flags underspecified
goals at triage and a manual operator run refuses while a packet is open; that
IS the gate. The owner declined hard-enforcing "no stage transition while an
input packet is open" — a human moving a task past an open packet is a
deliberate act, not an accident to prevent. The New-task placeholder was
reworded to promise only what exists.
*Enforced:* the placeholder copy in `app/features/board/board-page.tsx` ✓.

**90 — R21-7: `FILES.md` is DELETED, not regenerated.** (`:1103`) It claimed to
be generated from git's tracked-file index while trailing reality by ~1,000
files across ten passes. The index is `git ls-files`; the annotated tree lives
in `planning/planning-artifacts/architecture.md`. A doc whose only job a
command does better earns deletion over another unenforced regeneration.
✓ (absent at HEAD).

**91 — R21-8: while an agent actively carries a task, `input_required` YIELDS
to "agent working" — on every surface.** (`:1109`) "Input required" claims a
human is needed RIGHT NOW; an active run makes that false. Supersedes the
C3/F15-09 both-pills arrangement while keeping its requirement (hero and board
card agree mid-run): the hero swaps the readiness pill for the agent pill, the
board card/list-row top slot goes quiet (the foot's WaitTag already says "agent
working"), and the **"Blocked or waiting" filter stops matching** — an
actively-worked task is not stuck (R16-2's name-the-chip rule, mirrored). The
gate is `waiting === "agent"`: raising a packet flips `waiting` to `"human"`
and instantly reasserts "input required" everywhere, even mid-run.
`blocked` / `inconsistency_risk_detected` **never yield** — a run does not
answer those. Stored readiness untouched; the triage gate still clears only on
leaving the entry stage.
*Enforced:* `app/features/board/board-filters.ts` ✓ (+37-line test addition),
hero swap in `app/features/task-detail/task-main-sections.tsx` ✓, card/list-row
in `board-page.tsx` ✓ (PR #181, commit `9317ccc`).

**92 — R21-9: the claude backend's display label is "Claude" (not "Claude
Code"), and the operator run control SHOWS, it does not pick.** (`:1123`) Every
backend label site (the shared `agentBackendName` mapping, actor display names,
run/toast/timeline copy, the profile editor's backend segment, roster chips)
says "Claude"; references to the actual Claude Code PRODUCT (CLI login,
transcript retention, the coding harness) keep their name; stored records are
not rewritten. The operator card's per-run backend/autonomy dropdowns are
GONE — both are configured on the deployed operator profile and the run
resolves the LIVE profile (the same law PR #183 applied to specialist display:
`withLiveAgentBackends` overlays the live deployment's backend over the
engage-time snapshot on every read model). The card states the backend, keeps
Run, and adds an optional **steer** riding the `@operator` mention machinery —
recorded as the human's OWN timeline comment (a directive that reaches an agent
off the record is invisible to supervision) and passed as the run's
`humanComment`, with `humanCommentBy` the DISPLAY name (the email label tagged
`@arda@viberr.dev`, which chips and notifies nobody). F20-9's mirror survives
as a caption (full autonomy announces itself; supervised is the quiet
default); P11-41 survives without a picker (an unconfigured backend disables
Run with the reason rendered).
*Enforced:* `agentBackendName` `app/server/files/actor-ref.server.ts:122` ✓;
`OperatorControl` `app/features/task-detail/execution-profile.tsx:469+` ✓;
`withLiveAgentBackends` `app/shared/mapping/task.server.ts:369` +
`primaryRunBackend`/`deployedSpecialistBackends`
`app/features/agents/agents-query.server.ts:383`, `:408` ✓.

---

## Supersession map (read before implementing anything in these areas)

| Ruling | Status | Replaced / narrowed by |
| --- | --- | --- |
| 2 (roles, FR4 app-wide view/comment) | narrowed | **25** — members-only projects |
| 7 (accept ⇒ real async merge) | amended | **40** — only on the HUMAN path; operator acceptance = merge pending |
| 7 (nine packet kinds) | extended | **77** — `discard_branch` makes it ten |
| 9 (seeded stub projects) | superseded in part | clean-sheet seed — demo fixture only |
| 10 (project-wide waiting) | superseded for the board | **R8-3** — member-scoped chip + home count |
| 15 (workflow presets) | narrowed | Lightweight preset deleted; Standard 5-stage only |
| 20 (verdict gate) | narrowed / extended | **59** (force may jump, must say so), **42** (drift surfaced), **62** (no-change passes it), **68** (human GitHub approval satisfies it), **88** (the ceremony's disclosure is a SERVER invariant — a bare POST refuses) |
| 27 ("maintained" PRD mirror) | tightened | **52** — byte-identical, test-pinned |
| 34 (PR ownership) | extended | **35** — adoption requires open + head-sha identity |
| 37 (terminal GitHub fact) | extended | **59** — the refusal is server-side, not just a hidden button |
| 43 (verdict optional on no-diff) | **SUPERSEDED** | **62** — the no-change path passes the same verdict gate |
| 63 (NFR1–NFR5 numbers) | struck | qualitative requirements; NFR5 kept, re-cast |
| 67 (autonomy ceiling, runtime) | extended | **82** — the display applies the same ceiling; **92** removes the per-run autonomy/backend pickers entirely (the ceiling machinery stays server-side) |
| 69 (git's own words) | extended | **73** (MCP stderr), **78** (provider text) |
| 74 (uvx background warm-up) | extended | **79** — npx/bunx family |
| 75 (browser capability) | extended | **85** (a gap packet names the grant remedy); the 2026-08-20 browser→egress save-layer coupling (PR #176, **un-numbered** — see Pass-22 note) |
| 81 (specialist `recommend`) | reverses prior behavior | the old `recommend → direct` widening is now the named regression |
| C3/F15-09 (both pills side by side) | **SUPERSEDED** | **91** — `input_required` yields to "agent working" while a run is live; the agree-mid-run requirement survives |
| 36 (board attention predicate) | narrowed | **91** — an agent-carried `input_required` task leaves "Blocked or waiting" (it belongs to "Agent working") |
| "no linter, by decision" (architecture.md, pre-ruling) | retired | **86** — lint adopted as a required CI gate |

## Recurring meta-rules the rulings keep re-deriving

- **Honesty over blocking.** Surface the divergence, the refusal reason, the
  bypassed gate, the tool's own words — do not resolve a contradiction silently
  in either direction (20, 37, 42, 59, 62, 68, 69, 73, 78; `repairDeliveryGrants`'
  `withheld` notice; the browser's egress-pair `UnresolvedMcpGrant`).
- **Withdraw, don't disable.** A withdrawn affordance is honest; a disabled one
  invites a support question (37, 65, Q-V1's Danger zone).
- **Fail closed, never silent.** Ghost profiles (26), the human GitHub approval
  (68), a clone failure (55), `off` as a hard refuse (60), a stray specialist
  `recommend` normalizing to `off` (81).
- **One source, rendered and enforced from the same object.** `ACTION_ROLES` (2),
  the capability catalog (7, 39), `absentDeliverReviewPrMode` (28), the six-mode
  acceptance ceremony (14, 20), `capabilitiesToActionLabels` (82), the
  acceptance-disclosure echo shared by dialog and server (88), the live-backend
  overlay shared by display and run path (92 / PR #183).
- **A rule with no red test is a rule that gets reverted in silence.** (44, 54,
  57, 65, 66) — and **a rule that lives only in a code comment gets re-derived
  as a defect** (84's provenance; the un-numbered browser→egress ruling is the
  currently open instance).
