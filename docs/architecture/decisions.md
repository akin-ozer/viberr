# Binding decisions & conventions

This is the normative contract that code comments across the tree cite as **CONVENTIONS**
and as **"orchestrator ruling N"**. It condenses
[`planning/planning-artifacts/architecture.md`](../../planning/planning-artifacts/architecture.md),
which wins on conflict.

**Provenance.** The content below was recovered from `docs/build/CONVENTIONS.md`, which was
deleted in commit c1acf2c ("Remove obsolete code and simplify project structure") along
with the rest of `docs/build/`. Sixteen comments in fifteen files still cited it by name
and another ten cited its numbered rulings, so the deletion left binding decisions
readable nowhere — the exact failure mode that produced the six regressions commit cbcfe77
had to repair. The ruling **numbers are preserved verbatim** so every existing `ruling N`
citation resolves here.

**How to read a superseded ruling.** Several rulings have been narrowed or reversed by a
later owner decision. Those are marked **SUPERSEDED** inline, with what replaced them and
when. A superseded ruling is kept, not deleted: its number is still cited in code, and
knowing what the old rule *was* is how you avoid re-implementing it. Never restore a
superseded rule because you found the ruling text.

---

## Layout

```
app/
  root.tsx, routes.ts, app.css, entry.client.tsx, entry.server.tsx
  routes/          # thin route modules only; delegate to features/server
  ui/              # reusable primitives — MUST NOT import from features/
  lib/             # better-auth instance + its Viberr bridge
  features/        # per-surface UI + loaders/actions glue
  schemas/         # shared Zod schemas (task-file, project-file, sse-event, github-pat)
  server/          # server-only modules
  shared/          # narrow cross-surface helpers
db/migrations/*.sql   scripts/*.ts   e2e/   test-support/
```

The live folder inventory is in
[`architecture.md`'s directory structure](../../planning/planning-artifacts/architecture.md#complete-project-directory-structure);
it is regenerated from the filesystem rather than restated here.

- Server-only files: `*.server.ts` suffix. Never import server modules into client
  components.
- Tests co-located: `foo.server.test.ts`. No `utils.ts` / `helpers.ts` dumping grounds.
- Files/dirs kebab-case; components/types PascalCase; vars/functions camelCase; constants
  UPPER_SNAKE_CASE.

## Data & naming

- **SQLite:** plural snake_case tables (`users`, `sessions`, `task_projections`,
  `audit_events`), snake_case columns, `<entity>_id` FKs, `idx_<table>__<cols>` indexes. DB
  rows map to camelCase through the centralized mapping modules in `app/shared/mapping/` —
  never ad hoc at a call site.
- **TS/JSON:** camelCase. Timestamps are UTC ISO 8601 strings at all boundaries and in
  files. Booleans stay booleans; null stays null.
- **Readiness values** are exactly `ready` | `input_required` |
  `inconsistency_risk_detected` | `blocked`. Derivation lives ONLY in
  `app/server/interpretation/readiness-policy.server.ts`.
- **JSON endpoints** (rare, only for automation): success `{ data, meta? }`, error
  `{ error: { code, message, details? } }`, real HTTP status codes. Loaders return
  route-shaped data directly; route *actions* are exempt and return their own result
  shapes.
- **SSE:** event names are lowercase dot-separated facts (`task.updated`,
  `task.readiness-changed`, `projection.rebuilt`, `run.log-appended`,
  `auth.session-expired`); payload is `{ type, entityId, occurredAt, data }` — compact
  facts and references, never fat objects. The wire shape is parsed before publish because
  it is a contract.
- **Errors:** typed `AppError` with stable machine codes (`app/server/errors/`). Never leak
  stack traces or secrets to users. Distinguish user-correctable / inconsistency-diagnostic
  / infrastructure.

## Behavior rules

- Files are the only canonical business truth. The app writes files through dedicated
  writer modules (frontmatter-preserving), then re-parses → re-projects → publishes SSE.
  Never write projections without file backing for task/project state.
- Tolerant parsing: malformed input produces diagnostics plus a readiness downgrade
  (`input_required` / `inconsistency_risk_detected` / `blocked`), never a crash, never a
  silent drop.
- No optimistic UI for governed state. Revalidate after the action and on SSE.
- Mutating actions must be idempotent-safe (idempotency keys or existence checks) — a
  retry must not duplicate transitions, branches, PRs or events.
- Every governed action (approval, transition, ownership change, policy change, PAT change,
  run start/interrupt) writes an audit event and, where user-visible, a typed timeline
  event in `task.md`.
- Secrets come only from env; PATs are AES-256-GCM encrypted in SQLite; secrets never
  appear in files under `projects/`, in logs, in SSE payloads, or in error messages.
- RBAC applies to actions, not to file existence. Agents get a per-project capability
  policy, enforced server-side on agent-triggered actions.
- Human-only, enforced server-side: transition to Done, and completion acceptance.
  **Narrowed** — see ruling 2 and the note under FR27 in the PRD: under the `auto` preset,
  a full-autonomy operator holding an explicit `completion-for-acceptance: direct` grant
  may accept and move a task to Done itself. That is the one deliberate exception, and it
  is disclosed in the UI. Every other path to Done stays human.

## UI porting rules

- The mock (`design/html-app/app/*.jsx`) is the design source of truth: reproduce
  structure, class names and behavior 1:1, unless the mock is prototype-only (localStorage
  session, `location.href` page hops, `window.VIBERR` globals) — replace those with real
  routes/loaders/actions/SSE. Record deliberate departures from the mock in a comment at
  the departure site.
- Keep `viberr.css` classes and CSS variables exactly; add new CSS only in clearly-marked
  appended sections of `app/app.css`. No Tailwind, no inline hex colors — use the existing
  tokens. A `var(--x)` that is not defined in `:root` is a bug, not a style choice.
- Icons: one ported `Icon` component in `app/ui/icon.tsx`, reused everywhere.
- Theme: light/dark/system, persisted per user (profile) plus a cookie for SSR-safe first
  paint.
- Toasts for action feedback; packet-styled confirm dialogs. A failure toast must not
  render the success tick — pass the toast kind explicitly.
- Loading states: React Router pending state. No spinners-forever; long operations report
  server-derived progress.
- Accessibility: keep the mock's `aria-*` usage, visible focus, keyboard menus and dialogs
  (Escape closes, scrim click closes). The WCAG 2.2 AA baseline in
  [the PRD](../../planning/planning-artifacts/prd.md) applies to core workflows in both
  themes.

## ORCHESTRATOR RULINGS (binding)

1. **Readiness.** Canonical 4-value enum in files, Zod and SQLite; ONE mapping module maps
   it to the mock's pill CSS kinds/labels (`input`, `risk`, …). "Accepted" is a derived
   display state (stage done + accepted), never a stored readiness.
2. **Roles: three separate systems, kept separate.** Org roles `admin|member` (the schema
   tolerates `viewer`; the UI uses admin|member). Project membership roles stored in
   `project.md` and enforced server-side. Agent capability policy per profile
   (`direct|recommend|human`), id-based against a shared capability catalog
   (`{capabilityId, mode}` plus display-only extras), with an always-human server invariant
   list: merge PR, transition to done, change project policy.
   **Amended** — the project roles are now `admin | maintainer | contributor | viewer`
   (`reviewer` was renamed `contributor`), they form a strict tier, and the grant table
   lives in one place, `app/shared/rbac.ts`, which both the guards and the Policy page
   render from. `view` and `comment` are app-wide by FR4: any authenticated user holds
   them, member or not.
   **Superseded in part** (ruling 25, 2026-07-28) — projects are members-only: `view` and
   `comment` apply within projects the user is a member of; non-members get a
   404-equivalent. The FR4 sentence above is kept for history.
3. **Task-file store** at `$VIBERR_DATA_ROOT/projects/<slug>/tasks/<KEY>/task.md`. The UI
   renders the REAL store-relative path wherever the mock showed `.viberr/...`.
4. **Timestamps.** UTC ISO at all boundaries; one shared formatter in `app/shared/dates/`
   reproducing the mock's display forms (today → `H:MM`, else `{day} · {t}`, relative forms
   for home/store).
5. **PAT scope violations.** Server-derived per-scope validator results plus per-violation
   open/resolved records; the rail badge is the open-violation count; granting or
   re-validating writes a typed timeline event to the violation's OWN task, plus audit and
   SSE. No global boolean.
6. **Identity.** Compare by user id everywhere; display names are render-only. The session
   user id is authoritative.
7. **Packet options carry a stable `kind`** — never dispatch on English titles.
   Accept-completion on the HUMAN path triggers a real async PR merge with an explicit
   failure state. **Amended 2026-08-04 (ruling 40 / R16-6)** — that is true only of a human
   acceptance; a full-autonomy operator acceptance records the PR `accepted` (merge pending)
   and a human completes the merge later, because `merge-pull-request` is `ALWAYS_HUMAN`.
   **Extended** — the kind set is now eight: `accept_completion`, `request_edit`,
   `block_on_policy`, `hold_runtime_debug`, `redirect`, `retry_other_backend`, `edit_goal`,
   `custom`. The same ruling governs the capability catalog: agent policy is id-based
   against the shared catalog, and advisory ids with no runtime consumer get no toggle.
8. **`tweaks-panel.jsx` is not ported** (dev harness, dead code). Review-queue packet and
   acceptance mechanics ship before the queue surface; the queue lives in
   `app/features/review/`.
9. **Notifications** are per-user rows in SQLite sorted by real timestamp DESC;
   task/project references are soft refs.
   **SUPERSEDED in part** (clean-sheet seed ruling, 2026-07-24) — the two stub projects
   this ruling seeded so cross-project rows would navigate are demo data. They live in the
   demo fixture (`npm run seed:demo`) only; the product seed ships no board data.
10. **"Waiting on you" / the review queue stay project-wide in V1** — do not scope per-user,
    do not change the labels.
    **SUPERSEDED for the board** (R8-3): the board's "Waiting on me" chip and the home
    card's waiting count are **member-scoped** — a decision the viewer can actually act on,
    not the project-wide `waiting === "human"` enum. The review queue itself stays
    project-wide.
11. **Run lifecycle** is stored as `queued|running|finished|error|interrupted` and maps to
    the mock pills (queued → neutral "queued"; interrupted → neutral
    "interrupted · by \<actor\>" footer). Raw NDJSON/JSONL is truth; the log line display is
    a projection. Elapsed derives from `startedAt`; tokens come from real usage envelopes
    only, never estimates.
12. **PR states.** merged → done pill; open/draft → "in review"; closed-unmerged → risk
    pill "closed". Sync pill precedence is merged > behind > synced, derived from real
    compare data.
13. **Prefs.** Drop `ghConnected` (derive it from the user row); mount the Appearance
    panel; map plural pref ids ↔ singular notification kinds explicitly, once.
    **Narrowed** — there is no mailer in V1, so the email and nudge preference shapes were
    removed rather than kept schema-only. Each category carries a single in-app `app`
    toggle.
14. **Shared single implementations** for: notification meta, the markdown-ish stripper and
    rich-text renderer, the credential card, and the bell popover (parameterized). Never
    fork these per surface. Toast, empty-state and boundary copy in the specs is a verbatim
    contract, including intentionally divergent board vs review wording.
15. **Stages** are a per-project list in `project.md` (hex or `var(--*)` colors both
    accepted), created from an instance-default workflow template.
    **Narrowed** (P13-AP-04 / owner ruling 2, 2026-07-24) — the "Lightweight · 3 stages"
    preset was **deleted**. The Standard 5-stage board is the only creation template. Custom
    stage lists still exist and are edited per project after creation.
16. **Deliberate keeps:** the board rail count includes Done; `.card.urgent` stays visually
    untreated; `data-screen-label` attributes are kept app-wide. **Additions:** a minimal
    list-view empty state; Escape-close, focus-trap and scrim-click on every dialog (markup
    unchanged); `operator` stores the stage id and the UI renders "stage \<1-based index\>";
    login keeps the mock's copy but the password minimum is 8 characters.

17. **PR divergence recovery** (2026-07-25, recorded 2026-07-28 — previously commit-only).
    Out-of-band PR transitions are coordination events: the reconciler fires a
    `pr-diverged` operator trigger (closed / merged / reopened). On a closed PR the
    operator opens ONE recovery packet: rework (custom + note), `archive_task`, or
    `archive_task` + `deleteBranch`. Remote-branch deletion exists only as that packet
    resolution (refuses open PRs and the default branch).
18. **Minimum GitHub scopes are exactly `repo` + `pull_request:write`** (2026-07-25,
    recorded 2026-07-28). `workflow` and `read:org` were dropped; a refused workflow-file
    push surfaces as a scope violation when it matters. Fine-grained tokens prove write
    permissions via empty-payload dry-run probes (422 = authorized, 403 = refused).
19. **Scope chips render proven verdicts only** (2026-07-25, recorded 2026-07-28). A chip
    is evidence: scope header, live probe, or open violation. `assumed`/`unchecked` render
    as an honest "unproven" line, never as a pseudo-check.
20. **R15-1 (2026-07-28): acceptance requires a verdict.** Human acceptance of a
    completion requires a healthy reviewer verdict on the delivered revision; the audited
    admin Force-accept is the only bypass (it never bypasses the PR-head-must-contain-the-
    delivered-commit check). Every accept — including force — shows a confirm dialog
    stating what merges and any missing signals.
21. **R15-2 (2026-07-28): delivery is an operator decision.** Push + review-PR opening is
    no longer a stage side-effect. The operator holds a `deliver-review-pr` capability and
    decides when delivery is plausible, weighing the task's remaining stages; it opens a
    decision packet when unsure and may offer early delivery when later stages don't gate
    this task. The server still executes the mechanics; specialists still never push or
    open PRs. Entering the review-role stage with no PR writes a typed event — never
    silence. A human delivery button (maintainer+ / task owner) is the escape hatch.
22. **R15-3 (2026-07-28): owner authority covers recommendations.** A task's owner may
    apply or dismiss ANY operator recommendation on their own task, including stage
    transitions — the click is the authorization (FR37 spirit; extends R14-2/R6-2).
23. **R15-5 (2026-07-28): global ⌘K palette.** Real workspace-wide search (tasks,
    branches, agents, projects), scoped to projects the user can see.
24. **R15-6 (2026-07-28): per-project delete-branch-on-merge setting** (default on): a
    successful accept-merge deletes the remote task branch.
25. **R15-4 (2026-07-28): projects are members-only.** Non-members cannot open a project's
    board, tasks, or any project surface (404-style; WI-13 secrecy generalized). FR4's
    app-wide commenting applies within visible projects.
26. **R15-7 (2026-07-28): ghost profiles are fully conservative.** A run whose profile can
    no longer be resolved gets nothing permissive — no delivery, no comments, no
    ask-human, no evidence.
27. **R15-8 (2026-07-28): `design/prd.md` is re-synced** with the canon PRD and both are
    maintained; `planning/README.md`'s sync claim must stay true.
28. **R15-9 (2026-07-29): an absent `deliver-review-pr` grant resolves from the project's
    own governance, not from a constant.** The capability postdates R15-2, so "absent" is
    the normal state on every pre-existing project. Resolving it to a flat `direct` meant
    two projects with identical governance behaved differently by creation date alone.
    The preset is not stored anywhere — it is a creation-time shaping input — so the rule
    reads its EFFECT off the workflow graph (`humanGatesPreWorkAdvance`: no pre-terminal
    boundary advances automatically ⇒ `recommend`). Deriving beats a stored field here
    precisely because it is already true of projects that predate the capability. The gate
    and the policy surface share one function (`absentDeliverReviewPrMode`) so they cannot
    drift — that drift was F15-20. An explicit grant always wins.
29. **R15-10 (2026-07-29): the first empty board teaches, once.** A project with zero
    tasks shows one teaching line in the entry column; every other column stays bare, and
    the moment any task exists every column is bare again. This narrows P13-D-34 rather
    than reversing it: that ruling protected against repeating an explanation five times
    beside real work, which this does not do.
30. **R15-11 (2026-07-29): the Review queue stays a triage list, but its rows name their
    action.** Decisions belong with their evidence (diff, verdict, packet), so acceptance
    stays on the task page — the queue was simply an unlabeled clickable region. The row
    says "Review", deliberately not "Accept": acceptance is verdict-gated (R15-1) and may
    refuse, and a control must not name an outcome its surface cannot promise.
31. **R15-12 (2026-07-29): unenforced capability lines are collapsed, never hidden.**
    They render in a `<details>` labelled with their count. Hiding "unenforced and
    role-irrelevant" capabilities was the alternative and was rejected: an omission the
    reader cannot see is worse than an awkward truth, and "role-irrelevant" is a judgment
    the code should not be making about policy.
32. **R15-13 (2026-07-29): settings headings name their own scope.** Instance settings are
    titled "Instance settings" (was "Viberr settings", which collided with a project named
    Viberr) and a project's are "<name> · settings" (was bare "Settings"). Every wayfinding
    string that pointed at the old title was updated with it.
33. **R15-14 (2026-07-29): a resolved agent question goes back to the AGENT THAT ASKED,
    by resuming its own session.** `ask_human` still ends the run — nothing is held open
    while a human thinks, so a restart between question and answer costs nothing. What
    changed is where the answer goes: it used to travel only through the operator, which
    decides for itself whether to resume the specialist or start it cold, and a cold start
    discards the reasoning that produced the question. The packet now records `askedBy`
    (the profile id, not the display label), and resolution routes the decision through the
    same path an @mention reply takes — resume the session, re-apply confinement,
    re-anchor on task.md. The operator hand-off remains the fallback for operator packets
    and for an asker whose session or profile is gone, so no decision is ever swallowed.
34. **R15-15 (2026-07-29): a task owns a PR only if that task opened it.** `openTaskPr`
    is the sole writer that establishes the link; the reconciler's job is to keep an owned
    link honest, never to mint one. A PR discovered on the task's branch that the task does
    not already reference is a branch-name COLLISION and is reported as one — never adopted.
    The reason is that a task-key branch is not a unique identifier: a new data root
    restarts keys at 1, so a brand-new `VIB-1` gets branch `vib-1`, which on GitHub may
    still carry a previous `VIB-1`'s PR. Five-minute polling is unchanged and still tracks
    state, checks, review and mergeability — for PRs the task actually owns.
35. **R16-1 (2026-08-04): a pre-existing PR is adopted ONLY IF it is open AND its head sha
    is the task's delivered revision.** Adoption exists for one case — Viberr lost track of a
    PR it had opened (a crashed delivery, a hand-wiped `pr:` field). Every earlier
    implementation matched on the head BRANCH NAME, and a task-key branch is not an
    identifier: keys restart at 1 on a new data root, so `vib-4` on GitHub may still carry a
    wiped instance's VIB-4 work. (Live H8: a brand-new VIB-4 adopted a week-old merged PR and
    wore a green "merged" badge and "checks 2/2" for work that was never pushed.) The rule:
    adopt ONLY a PR that is OPEN **and** whose head sha IS the delivered revision — identity,
    not containment (the acceptance gate accepts a head that merely *contains* the delivered
    commit; adoption is the stronger claim), and a task that has delivered nothing adopts
    nothing. A name-matched PR that fails the rule is a branch COLLISION, reported as one
    (`prAdoptionRefusalNote`; refusals `not_open | no_revision | head_unknown | head_mismatch`)
    and blocking delivery — never silently bound, never silently dropped. Extends ruling 34
    (R15-15). `app/server/github/pr-adoption.server.ts`.
36. **R16-2 (2026-08-04): `input_required` joins the board's attention predicate.** The
    board's "risk"/attention filter selected only `blocked` and
    `inconsistency_risk_detected`, so it matched 0 of 4 tasks on a board full of
    input-required work — the exact state a human most needs to see. `input_required` now
    joins the predicate, and the chip is renamed from "Needs attention" to **"Blocked or
    waiting"** so its label names what it selects. `app/features/board/board-filters.ts`,
    `board-page.tsx`.
37. **R16-3 (2026-08-04): terminal GitHub facts outrank process gates in refusal copy.**
    When acceptance is blocked, a TERMINAL GitHub fact — a closed, unmerged PR — is named
    FIRST, ahead of any process gate (missing verdict, head mismatch), because it is the fact
    the human must act on and the recovery packet is the only way forward. While the PR is
    closed, admin **Force-accept is WITHDRAWN** (hidden), not merely disabled: force-accept
    exists to bypass a wedged *process* gate, not a settled GitHub state it cannot change.
    Extends ruling 20 (R15-1). `task-actions.server.ts`, `app/features/review/review-helpers.ts`,
    `rebuilder.server.ts`.
38. **R16-4 (2026-08-04): correctness first with tests, then the full UI/a11y list — nothing
    deferred out of the pass.** A pass fixes governance/correctness defects first, each with a
    test, then completes the UI and accessibility list in the same pass rather than punting
    items to a later one. The disposition audit — every backlog item's state re-derived from
    the tree after the fix waves — is what proves "done" is not "partial".
39. **R16-5 (2026-08-04): MCP grants stay OUTSIDE the capability matrix — granting a server
    IS the grant.** An MCP server's tools are not enumerated as capabilities and are not gated
    by the `direct | recommend | human | off` matrix. Granting a profile a server is itself the
    authorization to use that server's tools, whatever they do; Viberr will not pretend to
    bound a third-party tool it does not define. Consequence, stated plainly: a withheld
    `execute-code-or-write-repo` does NOT bound a granted server's tools — an org MCP server
    with write powers is reachable by an agent whose code-write capability is `off`. This is a
    deliberate honesty boundary, not a gap. Pinned by the ABSENCE of any `mcp__*` deny rule
    (`app/server/tasks/specialist-tool-policy.test.ts`) and disclosed in the capability-matrix
    UI (`capability-matrix-modal.tsx`). See the PRD/NFR8 amendment note.
40. **R16-6 (2026-08-04): merge stays human-only — "Done" has two meanings.**
    `merge-pull-request` is and stays `ALWAYS_HUMAN`. So a full-autonomy operator that accepts
    completion CANNOT merge: it records the PR `pr.state: "accepted"` — **merge pending** —
    moves the task to Done, and a human completes the actual merge later. A *human* acceptance
    triggers a real async merge. Both paths reach Done; they mean different things, and the
    difference must be visible where the task lives (board card **and** review queue), not only
    on the detail page. This is the correction to ruling 7's flat "accept-completion triggers a
    real async PR merge", which holds only on the human path.
    `app/server/tasks/operator-actions.server.ts`, `app/shared/capabilities.ts`.
41. **R16-7 (2026-08-04): the stale `codex/gpt-5-6-sol-agents` branch was deleted.** An
    abandoned harness branch was removed from local and `origin` (tip `461d34ab` if ever
    wanted). **Premise correction:** the deletion stands, but the pass-16 rationale that
    certain contributor/testing docs "no longer exist" was wrong — `docs/contributing-quickstart.md`
    and `docs/testing-quickstart.md` both exist in the tree today. Record the branch deletion
    as done; discard the missing-docs premise.
42. **R17-1 (2026-08-04): acceptance may accept a head AHEAD of the reviewed revision, but
    MUST surface the divergence.** The accept gate stays containment-based — it accepts a PR
    head that CONTAINS (is ahead of) the delivered/reviewed revision, because a legitimate
    auto-commit on top of the delivery is fine there. Honesty over blocking: the accept dialog
    AND the admin force-accept dialog must show the ACTUAL merge head and a divergence warning
    ("N commits added since review"), and the refusal/subline chain must name the divergence;
    the audit log names the real merge head, not the reviewed SHA. A head that has DIVERGED
    (no longer contains the delivered commit) still refuses, unchanged. (Owner ruling gathered
    pass 17; the surfacing is on this pass's implementation backlog — the gate today pins only
    the delivered SHA.)
43. **R17-2 (2026-08-04): a verified no-diff task is a first-class "Completed — no changes"
    outcome.** A task whose branch carries no diff against the base (or has no branch at all)
    may close to Done WITHOUT a PR or merge, through a distinct "Completed — no changes
    required" acceptance path recorded as its own timeline event and operator-recommendable.
    Force-accept and Archive are no longer the only exits for a zero-diff task, and refusal
    copy stops claiming "delivered work" for a 0-diff. Gated on: task at the review boundary,
    verified empty diff, reviewer verdict optional; it merges nothing. (Owner ruling gathered
    pass 17; on this pass's implementation backlog.)
44. **R17-3 (2026-08-04): rulings live in `decisions.md`; a docs-canon re-read is a required
    closing step of every pass.** A ruling a code comment cites but no canon file records is a
    ruling that gets reversed — D-17's failure mode, and pass-15's unanswered Q9. Every owner
    ruling a pass produces is promoted into this file, in this numbering, before the pass
    closes; rulings 35–43 above are pass 16's and pass 17's, promoted here under this ruling.
    And re-reading the operational docs against the tree (`file-formats.md`, `deployment.md`,
    `runbook.md`, `testing.md`) to catch statements that a correct change elsewhere left stale
    is itself a required closing phase, alongside the disposition audit.

45. **R17-4 (2026-08-04): the local sign-in form leads when NO OAuth provider is configured.**
    On a local-only deployment the card used to lead with two DISABLED "not configured"
    provider buttons — its most prominent elements were things that cannot work. When neither
    GitHub nor Google OAuth is configured, the buttons are not rendered at all: the local form
    comes first and SSO shrinks to a one-line footnote ("an admin can enable OAuth"). With at
    least one provider configured, SSO-first stands, including the D12 disabled button for the
    other provider. (`app/routes/login.tsx`)

46. **R17-5 (2026-08-04): "never synced" is neutral; only a genuinely stale cache warns.**
    The GitHub page's freshness chip rendered the coral alert tone both for a cache older than
    an hour AND for a surface that had never reconciled — so a brand-new project's first
    impression was a warning about nothing being wrong. The payload already distinguishes the
    two (`reconcile.at: null` vs an old timestamp); the view now does too: never-synced reads
    neutral ("Not synced yet", clock icon, title nudging that Update status runs the first
    sync), and only `stale && at !== null` keeps the alert icon + `.stale` tone. This matches
    the MCP-health precedent, where "never checked" was already "unknown", not "stale"
    (`isMcpHealthStale`). (`app/features/github/github-view.tsx`)

47. **R18-1 (2026-08-05): a reviewer inherits the delivering engagement's KBs.** When a
    specialist is engaged as a REVIEWER on a task, its knowledge-base context is the UNION of
    its own profile grants and the KB grants the DELIVERING engagement used for that task —
    so the deliverer and the reviewer judge against the same conventions. Grants are otherwise
    strictly per-profile, and that produced a false `request_changes` live: a Developer with a
    "conventions" KB wrote the required footer, and a Reviewer with `kb: []` flagged that footer
    as unsubstantiated because it never saw the KB. The union is deduped (a KB both grant never
    double-charges the shared injection budget), applies only to non-delivering runs, and is
    tolerant of an undeployed deliverer. Same on the resumed/@mention review path.
    (`app/server/tasks/specialist-run.server.ts` — `deliveringKbGrants`/`withDeliveringKb`)

48. **R18-2 (2026-08-05): a full-autonomy delivery re-queues the operator.** Opening the review
    PR is delivery, NOT a stage transition, so the P11-70 every-transition re-trigger (and the
    auto-boundary stranded backstop) never fired after it — an AUTONOMOUS task sat `waiting:human`
    with no packet, recommendation, or card (an invisible dead-end). Under FULL autonomy the
    server now re-queues the operator with a `delivered` trigger so it proceeds on its own (engage
    the reviewer / recommend the next step). SUPERVISED deliberately does NOT re-trigger — the
    human is the driver and the "Opened PR" event on the timeline is the cue. Only a NEWLY opened
    PR fires it; the re-triggered run can never re-deliver (the deliver tool no-ops on a live PR),
    and the chain shares `OPERATOR_TRANSITION_CHAIN_CAP`. (`performDelivery` in
    `app/server/tasks/task-actions.server.ts`; the `delivered` trigger in `operator-run.server.ts`)

49. **R18-3 (2026-08-05): the SDK-native skill/command catalog is governed OUT of runs.** A
    spawned agent run loads ONLY Viberr's granted skills. The per-task workspace clone's own
    `.claude` catalog is stripped before the run (git-invisibly, via `--skip-worktree` so the
    delivery's `git add -A` never ships a `.claude` deletion into the review PR), and the Claude
    launch carries `strictMcpConfig: true` so only Viberr-passed MCP servers reach the run. The
    user-level catalog is already isolated in production by the app-owned `CLAUDE_CONFIG_DIR`;
    Codex was already governed by `CODEX_HOME` + its skills/plugins/AGENTS.md flags. Known,
    accepted limitation: a run whose task is to edit the repo's OWN `.claude` cannot deliver those
    edits — that is the governance posture, not a bug.
    (`stripUngovernedRepoCatalog` in `app/server/tasks/specialist-run.server.ts`;
    `app/server/runtimes/claude-runtime.server.ts`)

50. **R18-4 (2026-08-05): branch-collision stays a human-gated packet — do NOT auto-reset.** A
    stale remote task branch (a reused task key whose old branch still exists on GitHub) forces
    a collision packet before delivery. The rejected fix was "always force-reset the remote task
    branch to base at execution start"; the ruling KEEPS the collision packet + human resolve as
    an intentional safety checkpoint against clobbering unrelated remote history. (Resolves the
    carried F17-L4 behavior question; the pass-17 merged-vs-closed copy split stands.)

## Route map

```
/login  /logout  /api/auth/*            (better-auth, incl. OAuth callbacks)
/                                       → home (project list)
/projects/:slug                         → redirect to board
/projects/:slug/board  /review  /agents  /policy  /github  /activity  /settings
/projects/:slug/tasks/:key
/org/settings                           (org admin, tabbed)
/profile   /notifications
/resources/events  (SSE)   /resources/health   /resources/run-log
/resources/session-export   /resources/model-catalog
```
