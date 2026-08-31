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

- **SQLite:** plural snake_case tables (`users`, `task_projections`, `audit_events`,
  `notifications`), snake_case columns, `<entity>_id` FKs, `idx_<table>__<cols>` indexes. DB
  rows map to camelCase through the centralized mapping modules in `app/shared/mapping/` —
  never ad hoc at a call site.
  **Exception, and it is not ours to rename:** better-auth owns four tables and names them
  in the SINGULAR with camelCase columns — `user`, `session`, `account`, `verification`
  (`db/migrations/0001_baseline.sql`). Its adapter generates the SQL, so the convention
  above applies to Viberr's own tables only. *(Corrected 2026-08-06, pass 19 — the example
  list here said `sessions`, a table that does not exist. That invented name had already
  propagated into `docs/operations/runbook.md`, which described a sweep of it; F19-17.)*
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
  *(Clarified 2026-08-06, pass 19 — N19-4.)* "Exactly" bound the class names and the naming
  convention (flat, unprefixed), and those held. It does **not** make the mock's VALUES
  authoritative, and several have deliberately diverged: shipped `--radius-card` is 16px and
  `--radius-panel` 22px against the mock's 18/28, there is no canvas/large radius token, the
  display face is Manrope not Roobert PRO, and `--pink` / `--dark-red` / `--radius-large`
  exist in `design/*.html` and nowhere in the app. `app/app.css`'s `:root` is the ONLY token
  source; read a value there, never out of the mock.
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
   **Extended** — the kind set is now TEN: `accept_completion`, `request_edit`,
   `block_on_policy`, `hold_runtime_debug`, `redirect`, `retry_other_backend`, `edit_goal`,
   `archive_task`, `discard_branch`, `custom`. (`archive_task` arrived with R14-3 — the task
   archive — and the count here was never updated; corrected 2026-08-05 against
   `PACKET_OPTION_KINDS` in `app/schemas/task-file.schema.ts`, which is the source of
   truth. `discard_branch` arrived 2026-08-15, pass 20 — ruling 77 / R20-2 / F20-6 — as the
   executable option that deletes a never-pushed local task branch; count nine→ten.) The same
   ruling governs the capability catalog: agent policy is id-based
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
    *(Re-affirmed 2026-08-05, pass 18 — owner ruling.)* The rule had failed a SECOND time:
    pass-17's FR14/FR20/FR27 amendments landed only in `planning/planning-artifacts/prd.md`,
    so the two files diverged again (`d3911299…` vs `783177bc…`) and a reader of
    `design/prd.md` got the pre-generic-agents vocabulary as though it were current. The
    owner chose re-sync over retiring the dual copy, so the requirement stands — but
    "maintained" now means **byte-identical**, and the two files are pinned as such by
    `prd-sync.test.ts` rather than by anyone's memory. The canon copy is the one to edit;
    the design copy is a mirror.
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
    (`prAdoptionRefusalNote`; refusals `merged | closed | no_revision | head_unknown |
    head_mismatch`) and blocking delivery — never silently bound, never silently dropped.
    Extends ruling 34 (R15-15). `app/server/github/pr-adoption.server.ts`.
    *(Refusal set corrected 2026-08-31, pass 31: this line read `not_open | no_revision |
    head_unknown | head_mismatch`. F17-L4 (pass 17) split `not_open` into **`merged`** and
    **`closed`**, because the two carry opposite delivery hazards and must not share one
    sentence: a merged stranger PR's tip is already an ancestor of the base, so a fresh
    delivery fast-forwards and the collision is only the stale branch NAME; a closed-unmerged
    one carries commits that are not on the base, so a fresh push risks a non-fast-forward —
    a real history hazard. Neither the rule nor its scope changed, only the reason names.
    Corrected against `PrAdoptionRefusal` in `app/server/github/pr-adoption.server.ts`, which
    is the source of truth, per ruling 44 (R17-3).)*
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
    pass 17; on this pass's implementation backlog.) **Amended 2026-08-08 by ruling 62 — the
    "reviewer verdict optional" clause is SUPERSEDED: a no-change completion now passes the
    same verdict gate as every other acceptance.** Implemented pass 19 (F19-21).
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
    (`app/server/tasks/specialist-run.server.ts` — `deliveringContextGrants`/`withDeliveringGrants`;
    the pair was renamed from `deliveringKbGrants`/`withDeliveringKb` after this ruling. Names
    corrected 2026-08-06, pass 19.)
    *(Re-affirmed 2026-08-06, pass 19 — owner ruling; see ruling 57 / R19-3. The
    inheritance is KBs and ONLY KBs: the docstring claiming it had been "widened to
    skills by LV-F3" described a widening that never shipped.)*

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

51. **R18-5 (2026-08-05): granted skills reach a Claude run through the SDK's NATIVE skills
    mechanism, not as injected prompt text.** Viberr used to read every granted skill's full
    body and paste it into the system prompt on every run, and deny the `Skill` tool outright.
    That worked, and a live decoy test proved the model still applied only the relevant skill —
    but it has no progressive disclosure: context cost grows linearly with grants, and
    relevance is left entirely to the model. The owner's ruling is to use the documented SDK
    option instead — `skills: ["<granted>", …]` — which discovers skills as filesystem
    artifacts (`.claude/skills/<name>/SKILL.md`) through `settingSources`, loads only NAME +
    DESCRIPTION at startup, and pulls a body only when the model invokes that skill. The
    allow-list is also what finally contains the SDK's ~16 compiled-in skills: they are
    "hidden from the model and rejected by the Skill tool", which the old `skills: []` could
    not achieve (the HONEST LIMIT recorded in `claude-runtime.server.ts`). Isolation is
    preserved by mounting ONLY Viberr-granted skills into the workspace — after R18-3 has
    stripped the clone's own `.claude` — with `plugins: []` and no `'user'` setting source, and
    by excluding `.claude/` from git so delivery can never ship it. **Codex keeps prompt-text
    injection**: its CLI has no equivalent and LV-13 deliberately severs its skills channel.
    That asymmetry is disclosed, not silent.

52. **R18-6 (2026-08-05): `design/prd.md` is re-synced to canon and pinned by a test.** See the
    re-affirmation under ruling 27 — the dual-copy rule had failed a second time, and the owner
    chose re-sync over retiring the mirror. "Maintained" now means byte-identical, enforced by
    `app/shared/docs/prd-sync.test.ts`, which names the diverging lines.

53. **R18-7 (2026-08-05): accepting from the BOARD asks first.** Dragging a card into the final
    stage runs the full acceptance contract — a real PR merge — so the board drag and the
    keyboard Move menu now raise a confirmation that states the consequence and that merging is
    one-way, matching the task-detail dialog. The drag stays possible; only the silence goes.
    (Ruling 20 / FR27 promise the dialog at every acceptance path; three of five lacked it.)

54. **R18-8 (2026-08-05): F18-9 is closed as NOT REPRODUCIBLE.** The recorded claim that the
    agent-profile modal defaults every org skill to ON could not be reproduced: both modals
    initialise a new profile with empty grants (`create-profile-modal.tsx:806-812`,
    `agent-template-modal.tsx:123-131`). No default was changed — acting on the note would have
    introduced the over-granting it warned about. Recorded as a class: a finding taken from a UI
    impression and never re-verified in code can survive several passes as fact.

55. **R19-1 (2026-08-06): the operator gets a FULL read-only clone of the project repo
    before it triages.** Live (F19-4): at triage the operator's cwd is the task's canonical
    folder, which holds exactly `task.md` — and the model wrote a decision packet reporting
    "Repo contents visible to operator: only task.md — no docs/ or README found" about a
    repository that has both, then invented scoping options from that emptiness ("add a
    README" for a repo that has one). A packet must be grounded in the REAL repository. The
    owner ruled for a full clone over the two cheaper fixes that were offered and rejected: a
    summary-only view (a file listing the model would still have to guess from) and a
    persona-only fix (telling the model not to claim things it cannot see, which leaves it
    blind and merely quieter). The clone is the SAME per-task checkout a specialist run uses,
    so the delivering agent that runs later reuses it rather than paying for a second one, and
    an EXISTING checkout is returned untouched (re-sanitizing or re-stripping it mid-run is
    the F19-15 hazard). Read-only is the operator's posture, not a filesystem mode: the
    operator has no delivery capability, and R18-3's `.claude` strip still applies to the
    clone. A clone failure is a FIRST-CLASS `unavailable` arm carrying git's own redacted
    complaint — never an error that strands the drive, and never silence, because a run that
    does not KNOW it is blind falls straight back into describing the task folder. Closes
    Q19-1, extends F19-4. (`operatorWorkspaceView` in
    `app/server/runtimes/operator-run.server.ts`)
    *(History, pass 19 — a cheaper READ-ONLY VIEW was offered as the alternative: let the
    operator list and read the default branch at triage without a working clone. The owner
    rejected it along with the summary-only file listing, ruling for the full clone above; the
    view-only option is recorded here only so a reader knows it was weighed and declined.)*

56. **R19-2 (2026-08-06): repo-documented conventions OUTRANK knowledge bases; the KB
    supplements.** Live (Q19-2): a KB-granted Codex developer followed its KB's pass-note
    format while a KB-less Claude doc writer followed the repo's own `qa/smoke/README.md` and
    flagged the KB-shaped files as non-conforming. Both behaved reasonably — nothing had ever
    told either run which source wins, so one repo grew two house styles. The rule: where a
    repo file states a convention (README, CONTRIBUTING, `docs/`, a linter/formatter config,
    or the established pattern of the files being edited) the repository wins; KB guidance
    applies where the repo is silent; a genuine conflict is followed *repo-first and reported
    by name* — surfaced as a typed context-conflict event and never silently resolved in either
    direction — so a human can reconcile it; and an existing file family is never rewritten into
    a KB's style just because the KB describes one. It ships as ONE constant emitted
    immediately before the KB bodies it ranks, imported by both runtimes so it cannot drift
    between them, and emitted only when real KB text is present — a run with no knowledge base
    never carries a rule about a resource it does not have. Closes Q19-2.
    (`KB_PRECEDENCE_NOTE` in `app/server/files/kb-injection.server.ts`)

57. **R19-3 (2026-08-06): reviewer inheritance stays KBs only — ruling 47 (R18-1) stands.**
    F19-2 found `specialist-run.server.ts` documenting that the inheritance had been "widened
    to SKILLS by LV-F3". It never was: both call sites union `kb` only, the fresh and resume
    paths each mount the reviewer's OWN skills, and the string "LV-F3" existed nowhere in the
    repo except that one sentence. Offered the widening as a real option, the owner declined
    it — a reviewer's craft is its own profile's grant; what deliverer and reviewer must share
    is the CONVENTIONS they judge against, which is exactly what R18-1's KB union gives them.
    So skills are DELIBERATELY not inherited, the absence is pinned by a test, and the false
    docstring is corrected. Recorded as the same class as ruling 54: a claim that lives only
    in a comment is a claim nobody re-derives. Closes F19-2.
    (`deliveringContextGrants` in `app/server/tasks/specialist-run.server.ts`)

58. **R19-4 (2026-08-06): a SUPERVISED delivery must leave an actionable next step, and the
    SERVER guarantees it.** Live (F19-1, VC-1): a supervised operator delivered, narrated "the
    task will move to Review; no further action needed", and recorded nothing — the task
    settled `waiting: human` with no recommendation, no packet and no chip, so the human had
    nothing to act on anywhere in the product. Delivery is not a stage transition (R15-2), so
    neither the every-transition operator re-trigger nor the auto-boundary stranded backstop
    covers this moment, and ruling 48 (R18-2) deliberately skips the re-queue at supervised
    autonomy because the human is the driver. The invariant therefore rested entirely on the
    model remembering. `performDelivery` now ensures a "Move to \<review\>" recommendation (or
    equivalent packet) exists whenever an operator-authorized supervised delivery recorded
    none. Deliberately conservative — it adds nothing when an open packet already IS the next
    step, when the task is already at or past the review stage, or when the workflow declares
    no edge from here to review — and idempotent: `addRecommendation` dedupes per
    (kind, profileId, target), any stage move prunes pending transition cards, and acceptance
    consumes every card, so the synthesized card can neither double up with the operator's own
    nor outlive its moment. Ruling 48's full-autonomy re-queue is unchanged. Closes F19-1.
    (`ensureDeliveredNextStep` in `app/server/tasks/operator-actions.server.ts`, called from
    `performDelivery` in `app/server/tasks/task-actions.server.ts`)

59. **R19-5 (2026-08-06): force-accept MAY skip the remaining stages AND the review gate — but
    it must SAY so.** A pass-19 implementer read F19-25 as "force-accept must not jump the
    workflow graph" and added a server 409 refusing an off-boundary force ("move the task to
    the boundary first"); the owner REVERTED it. Force-accept exists precisely to get a wedged
    board unstuck, and a server refusal would have turned the one escape hatch into another
    wall. The burden the override carries is HONESTY, not refusal: the affordance is labeled
    with what it does ("skips the remaining stages and the review gate") and its confirm dialog
    ENUMERATES the stages being skipped, alongside ruling 42's merge-head/divergence
    disclosure. What force does NOT bypass is unchanged and non-negotiable: the ruling-37
    terminal GitHub fact (F19-25's real defect — a closed, unmerged PR still refuses, now
    server-side and not only by hiding the button client-side) and ruling 20's PR-head
    containment check. Narrows ruling 20, extends rulings 37 and 42.
    (`forceIrreducibleRefusal` in `app/server/tasks/task-actions.server.ts`;
    `app/features/task-detail/accept-confirm.tsx`)

60. **R19-6 (2026-08-06): a capability set to `off` is a HARD REFUSE by every route — no card,
    no audit row.** The leak: with `completion-for-acceptance: off`, an operator that could not
    recommend accepting a completion still produced an `accept_completion` card and a
    `task.operator.recommended_completion` audit row by rerouting through a plain terminal-stage
    transition (F19-26's target-not-kind hole). `off` is a withheld capability, not a routing
    hint — so the gate is checked FIRST, before any read, card or audit row, on every path that
    reaches the action including the terminal-target reroute, and `human` refuses the same way
    while saying the decision is reserved for a human. The operator refuses OUT LOUD and
    narrates the refusal rather than silently finding another door: a silent reroute is worse
    than a refusal because the human sees a card whose authority does not exist. Extends
    ruling 2's capability model and ruling 39's honesty posture.
    (`app/server/tasks/operator-actions.server.ts`)

61. **R19-7 (2026-08-06): the Activity audit column compacts consecutive
    runtime-session-open rows.** Live (UX19-5), 8 of the 9 rows a 1440px viewport had room for
    in the "policy & access · all actors" column read "operator opened the \<role\> runtime
    session" — routine agent bookkeeping burying the events the column exists for (credential
    assigned, scopes re-checked, role changed, project created). Audit policy requires the
    event, so it is not dropped: consecutive runs of it fold into ONE expandable "N runtime
    sessions opened" row, reusing the timeline's existing compaction shape (a pure walk over a
    newest-first list, including its "a run too short to be worth a marker stays verbatim"
    rule). The one deliberate difference from the timeline's version is that nothing is
    deleted — the entries are kept and handed back on expand, with their real per-row
    timestamps. **The recognizer is anchored at the END of the projection's sentence, and that
    anchoring is load-bearing (F19-40):** `entry.text` OPENS with the actor's display name,
    which any member sets for themselves, so an unanchored matcher let a member named
    `Mallory (opened the dev runtime session)` fold their own `task.acceptance.forced` and
    `project.org_admin.override` rows behind the summary — a fold the actor picks is a fold
    that hides the row from the reader who never expands it. Closes UX19-5 and F19-40.
    (`app/features/activity/activity-page.tsx`)

62. **R19-8 (2026-08-08): a "Completed — no changes required" task passes the SAME verdict gate
    as every other acceptance — ruling 43's "reviewer verdict optional" clause is superseded.**
    Making the outcome reachable (F19-21) meant minting a `workRevision` anchored to the real
    default-branch head, because a verdict has nothing to bind to without one — that missing
    subject was the actual wedge that left VC-5 unable to close ("No reviewed revision yet —
    nothing for the required reviewers to approve"). With a subject in hand the question became
    whether the required reviewers must approve it. They must: "nothing needed changing" is a
    CLAIM about the repository, and it is exactly the claim worth a second pair of eyes —
    a wrong one closes a task that still needed work, silently and with no diff to review later.
    So the no-change path keeps the ceremony and only loses the PR: no branch, no merge, its own
    timeline event, still operator-recommendable. Consistent with ruling 20 (R15-1) rather than
    an exception to it. **The counterpart honesty rule:** "verified" must mean the server
    actually looked — a no-change outcome requires `defaultBranchEvidence.verified` from
    push-workspace on BOTH doors (`no_branch` and `no_commits`), so a dirty tree, local commits
    on the default branch, an abandoned task branch, a history git could not compare, or a
    swallowed auto-commit failure all stay a genuine delivery failure. A developer who edits
    files and forgets `git checkout -B` leaves exactly the frontmatter of a verify-only task,
    and frontmatter cannot see a checkout.
    (`app/server/tasks/task-actions.server.ts`, `app/server/github/push-workspace.server.ts`)
    *(Provenance, pass 19 — VC-5 live evidence: a reviewer approved on `main`, no branch was ever
    created, and `accept_completion` returned `[noop] No reviewed revision yet — nothing for the
    required reviewers to approve`, forcing the operator to open a packet asking a human how to
    close the task out — the exact wedge this ruling removes. The consuming machinery — the live
    fail-closed no-change probe at every writer to Done, the in-lock re-proof, and the shared
    "Completed — no changes" timeline-event builder — lives in
    `app/server/tasks/no-change-completion.server.ts`.)*

63. **R19-9 (2026-08-08): the numeric NFR1–NFR5 performance targets are DROPPED from canon —
    a target nobody measures is a claim, not a requirement.** *(NFR5's slot survives; what it
    loses is the timing framing, not the constraint — see below.)* The PRD asserted a 200-card board
    in ≤2 s, task detail ≤2 s p95, a state-changing action reflected ≤3 s p95, and cross-user
    propagation ≤5 s. None of the four was ever measured, in any pass: there is no performance
    harness, nothing records a p95, and no test goes red when a figure is missed — which is why
    the gap kept resurfacing verbatim (D17, "asserted, not verified", carried since pass 17;
    pass 19 filed it as G19-g, the one gap whose own table offered two branches and took
    neither). The damage is not the missing milliseconds, it is the precision: a requirements
    document that prints an unenforced number teaches its reader that the enforced ones — NFR7,
    NFR10, NFR15, NFR16 and NFR17 each have real guards in the tree — might be decorative too.
    (NFR6, TLS in transit, is honestly the deployment's job and says so.) So the figures are struck
    and replaced by qualitative requirements the product can honestly be held to — the board
    hides nothing to save render time and names its unbounded-query scaling limit out loud,
    a task surfaces decision-relevant truth ahead of its depth, every state-changing action
    acknowledges itself rather than completing or failing in silence, and shared state reaches
    other connected users without a manual refresh. **NFR5 is kept**, re-cast from a timing
    requirement into a behavioural one, because unlike the other four it is real and enforced:
    the loader ships a bounded newest-first timeline slice and a bounded run-log window and the
    console pages backwards on demand. The standing rule for anyone tempted to restore a
    number: a latency budget lands in the SAME change as the harness that measures it, never
    before it. Applies ruling 44 to the non-functional half of the PRD.
    (`planning/planning-artifacts/prd.md` §Responsiveness + its mirror `design/prd.md`;
    the NFR5 machinery at `app/features/task-detail/timeline-slice.ts`,
    `app/routes/project.task.tsx`, `app/routes/resources.run-log.ts`)

64. **R19-10 (2026-08-08): the two unshipped spec'd components — the Continuity Recovery Panel
    (D18) and board arrow-key traversal (D19) — get BUILT; they stop being debt.** Both were
    named in the UX specification (the Panel is a Phase-3 workflow component and the named
    home of the Murat continuity journey; traversal is the Task Status Card's "support keyboard
    navigation across board lanes"), both had been carried as open questions for several passes,
    and pass 19's audit found them at zero and near-zero: the Panel did not exist in the tree
    at all — pass 18's warning-toned `continuity` typed event was its only partial — and the
    board's only `onKeyDown` belonged to the new-task dialog. The choice was ship or convert them
    into deliberate divergences, and the owner ruled ship, on the grounds that both sit on the
    product's trust story rather than its feature list: continuity degradation is precisely the
    moment the product must explain itself instead of going quiet, and a supervision board a
    keyboard cannot cross is a board that only half-honours the accessibility posture the spec
    calls baseline. Recorded here alongside the build rather than after it, so the ruling
    survives independently of whether any single implementation attempt does — a rule this
    document knows only as an unbuilt spec line is a rule the next pass re-files as a gap.
    Closes D18 and D19 as open questions; the UX spec's descriptions of both components stand
    unchanged as the build target. Extends ruling 44 (a ruling no canon file records is a
    ruling that gets reversed).
    (`app/features/task-detail/continuity-recovery.tsx` for D18;
    `app/features/board/board-page.tsx` for D19's roving tab stop)

65. **R19-11 (2026-08-08): a read-only Viewer does not see the project credential card — the
    PAT half of Q-V1 is implemented, not deferred.** Q-V1 had two halves. The Danger-zone half
    shipped and was listed as closed; the PAT half was recorded only in a pass-19 reference doc
    and quietly never built, so the question read "ruled + shipped" while half of it was
    neither. The principle is the one that decided the first half: a surface shows a role what
    it may act on, and the credential card is not a status readout — it advertises a secret's
    existence, its token fingerprint, its scope verdicts and its rotate/remove controls to
    someone whose role cannot touch any of it. A Viewer reading it learns only that the project
    holds a credential they are not trusted with, which is disclosure without capability. Three
    consequences the ruling carries: the card is **withdrawn, not disabled** (ruling 37's
    precedent — a withdrawn affordance is honest, a disabled one invites a support question);
    the predicate is the SAME `ACTION_ROLES` entry the route's action guard already enforces
    (`grant-github-scope`, covering grant-scope, set-credential and clear-credential alike), so
    a role can never be shown a control it may not use nor hidden from one it may; and the
    **loader redacts on that same rule**, because a client-only gate leaves the token tail
    sitting in the HTML. Because pass 19's audit caught the Danger-zone half sitting on an owner
    ruling with **no test that could fail** (the suite rendered the section component directly
    and its only full-page render hardcoded an admin), this ruling also requires a full-page
    render at Viewer asserting the card is ABSENT, canaried by removing the gate: an owner
    ruling whose guard cannot go red is a ruling that gets reverted in silence. Completes Q-V1;
    extends ruling 25's members-only posture from "may you open it" to "may you see what is
    inside it".
    (`app/features/github/github-view.tsx`, `app/routes/project.github.tsx`; the already-shipped
    Danger-zone half at `app/features/project-settings/settings-page.tsx`)

66. **R19-12 (2026-08-08): both accessibility gates get built — a systematic both-theme WCAG AA
    contrast sweep, and a check that enforces the spec's "no control is hidden or disabled at
    any width" contract.** Today's coverage is enumerated, not systematic: `app.css.test.ts`
    pins contrast for a hand-listed set of pairs and breakpoint discipline for a hand-listed set
    of patterns, which verifies exactly the cases someone already thought of and says nothing
    about the next token pair or the next media query. Both contracts are load-bearing rather
    than cosmetic. Contrast is: the spec makes WCAG 2.2 AA the baseline in **both** themes, and
    a single stylesheet serving light and dark from one token block is the exact shape where a
    value tuned for one theme is legible and its counterpart is not — the failure is invisible
    to whoever is not looking at that theme. The width contract is stronger still, and is a
    correctness rule wearing accessibility clothing: hiding a control below a breakpoint makes
    the surface **dishonest about what the user may do**, so a narrow window must reflow the
    same interface rather than switch into a reduced one, and nothing may be gated on
    `matchMedia`. Neither contract survives as prose alone — the responsive amendment has said
    "nothing is gated on viewport size, and nothing should be" since 2026-07-25 with no check
    behind it, which is exactly how long it could have been broken unnoticed. So both
    become gates that fail the suite, on the same footing as the no-undeclared-token rule the
    stylesheet already enforces with no allowlist. Extends §UI porting rules' "a `var(--x)` that
    is not defined in `:root` is a bug, not a style choice" — the one styling contract this
    project already enforces mechanically — to the two the spec calls baseline.
    (`app/app.css`, `app/app.css.test.ts`; the spec contract at
    `planning/planning-artifacts/ux-design-specification.md` §Breakpoint Strategy)
67. **R19-A (2026-08-06): a run may never exceed the project's configured operator autonomy —
    the per-run level is a CEILING, not a pin.** `resolveOperatorAuthority` used to return
    `overrides.autonomy ?? configured` verbatim, so any `run-agents` role (maintainer+) could
    launch ONE turn at `full` on a project whose operator is deployed `supervised` — promoting
    every `recommend` capability (stage transitions, packets, typed events, `deliver-review-pr`)
    to direct execution with no confirm, no distinct audit row, only a toast. The Policy page
    presents operator autonomy as PROJECT configuration (ruling 2); a per-run dropdown that
    silently outranks it makes that page a lie. So the configured autonomy is a ceiling the run
    is clamped to. Choosing LESS autonomy for a single run stays allowed and is not a clamp (a
    maintainer may always ask for more supervision than the project demands); omitting the
    override means "run at the configured level", also not a clamp. The clamp is audited only
    WHEN IT ACTUALLY BITES — a silently-reduced run is made visible with the typed
    `task.operator.autonomy_clamped` fact rather than left mysterious — and the selector and the
    schedule surface offer exactly the options that will really run. Extends ruling 2's
    capability model. (`clampAutonomy` / `auditAutonomyClamp` / `operatorAutonomyFor` in
    `app/server/tasks/operator-actions.server.ts`)

68. **R19-B (2026-08-06): a project member's GitHub approval on the PR counts as the approving
    verdict.** The asymmetry this closes: a human's DISAPPROVAL already binds the gate (closing
    the PR unmerged is a terminal fact that outranks every process gate — ruling 37 / R16-3),
    while their APPROVAL was inert — the review state was "a status pill, not the merge gate". So
    on a project running no verdict-capable agent, EVERY acceptance had to be an admin
    force-accept, permanently audited as bypassing a gate nobody could satisfy, even though FR37
    names the task owner "reviewer + acceptance authority". Four things make the approval evidence
    rather than a rubber stamp: (1) it is BOUND TO THE DELIVERED REVISION — the approval's
    `commit_id` must equal the delivered head, checked when recorded AND on every read, so a
    re-delivery invalidates it instantly (the same contract an agent verdict has with
    `workRevision.id`); (2) the approver must be a PROJECT MEMBER, resolved from the GitHub login
    through `users.github_handle`; (3) it FAILS CLOSED — an approval that cannot be confidently
    mapped (no linked handle, two claimants, a non-member) does not count and the reason is
    recorded; (4) it is NEVER SILENT — a gate satisfied this way names the human, their handle
    and the commit. **Composes with, and is no exception to, rulings 20 and 62:** because it
    binds to a *delivered* revision it cannot fire on a no-change verification revision (which
    has no delivery to approve), and ruling 62's no-change path is not an exception to the
    verdict gate either — neither reads as a carve-out of the other. Extends ruling 20 (R15-1) and
    FR37. (`humanVerdictApproval` in `app/server/github/pr-human-approval.server.ts`; threaded
    through `verdictGateReason` and the rebuilder's acceptance-block derivation)

69. **R19-13 (2026-08-08): git's own failure text is SURFACED to the human,
    redacted, where it used to be dropped whole.** Clone and push failures used to scrub git's
    `stderr`/`message` entirely for credential safety (`cloneFailureLogDetails` dropped both), so
    a failed delivery or checkout recorded its reason NOWHERE (F19-6, F19-18): the operator opened
    an honest blocked packet, but no human — and no agent — could act on it, because nothing said
    why. The reversal: the credential lives in the askpass env, never in argv or the URL, so a
    token-SHAPE backstop redaction plus ANSI/C0 control-character stripping is sufficient to make
    the text safe, and git's redacted complaint (e.g. `fatal: could not read Username…`) is now
    surfaced in the run log, in fenced "What the checkout/push reported:" timeline blocks, and in
    a ≤240-char one-line delivery reason. One redactor module owns the scrub, at one choke point.
    Owner-confirmed 2026-08-08 as ruling 69 / R19-13. (B's `spec-failure-diagnostics.md` instruction
    to record it as "ruling 59" is VOID — 59 is taken by R19-5.)
    (`app/server/secrets/git-output-redact.server.ts`; the timeline rendering in
    `specialist-run.server.ts` / `operator-run.server.ts` / `push-workspace.server.ts`)

70. **R19-14 (2026-08-10): new tasks are created at the ENTRY stage only.** Every non-terminal
    lane used to carry its own "New task in this stage" button, so a human could drop a
    brand-new task straight into Review — a stage whose semantics (something delivered, something
    to judge) presuppose work that does not exist yet — and skip the triage quality gate (FR15)
    entirely. The owner ruled the flexibility out: `createTask` refuses any non-entry `stageId`
    (naming the entry stage in the refusal), the board offers the per-lane button on the entry
    lane alone, and the "operator assigned unless the task starts in triage" special case
    collapses — a task can no longer start anywhere else. Existing tasks are unaffected;
    file-level fixtures (`createTaskFile`) that seed mid-stage tasks are the projection/test
    surface, not the human create path, and stay as they are. (`createTask` in
    `app/server/tasks/task-actions.server.ts`; the `Column` header in
    `app/features/board/board-page.tsx`)

71. **R19-15 (2026-08-10): notifications are auto-read on VIEWING their target.** A notification
    only became read when clicked in the bell popover or the `/notifications` inbox — a user who
    reached the task from the board left that task's notifications unread forever, so the badge
    grew into steady-state noise (27 unread against 5 live decisions) and stopped meaning
    "something you have not seen". The owner ruled for view-marking: loading a task page marks
    ALL of that user's unread notifications for that task read (every kind — the per-user view
    event, distinct from `markTaskPacketApprovalRead`'s all-user resolution side-effect). The
    write lives in the task route's loader deliberately: the app uses no link prefetch, the
    update is idempotent and monotonic (`read_at IS NULL` guard), the emitted
    `notification.read` event converges (a second pass marks nothing and emits nothing), and it
    runs only after authorization so the members-only 404 path (ruling 22 / R15-4) stays pure.
    (`markTaskNotificationsSeen` in `app/server/projections/notifications.server.ts`; called from
    `app/routes/project.task.tsx`)

72. **R19-16 (2026-08-10): OAuth sign-in is configured IN THE APP.** The Allow-access modal
    offered "GitHub · off / Google · off" with a tooltip naming an env var no admin could set
    from the app — a dead end. Owner ruled (three answers): a new org-settings **Sign-in & SSO**
    tab; credentials saved there **override** the deployment env; and enabling a method
    **requires a passing credential test** against the provider first. The mechanism keeps three
    honesty rules: saving never enables; changing either half of the pair clears the verdict AND
    switches the method off; a passing test says what it proved (the pair) and what it did not
    (the callback registration, which is shown with a copy button because a provider app without
    it fails at real sign-in regardless). Secrets are sealed (registered in `SEALED_STORES`, which
    grew per-store `idColumn` for it), and the running auth handler picks changes up per-request
    via `oauthConfigFingerprint` — no restart. (`app/server/auth/oauth-providers.server.ts`,
    `oauth-credential-test.server.ts`, `app/features/org-settings/sso-panel.tsx`,
    `app/shared/auth/auth-paths.ts`)

73. **R19-17 (2026-08-13): a failed MCP command's OWN WORDS are surfaced — and kept.** A
    registered stdio server that failed showed a bare red dot; the command's complaint went to
    `stdio: "ignore"` at the OS level, so `uvx` printing exactly what was wrong was thrown away
    unread. Now stderr is captured (piped, 8KB cap), scrubbed by value + token-shape through the
    shared `redactGitOutput` (the child holds `MCP_CREDENTIAL`, so this is the same
    credential-safety bar as ruling 69), appended to the probe verdict, **persisted** on the row
    as `last_error` (17b — the reason used to evaporate on page reload), and rendered under the
    row. 17c distinguishes a first-run INSTALL from a hung command (`INSTALLING_RE` against the
    live stderr) so "downloading cpython" is not reported as "unreachable".
    (`discoverStdioMcpTools` in `app/server/org/resources.server.ts`;
    `app/features/org-settings/resource-rows.tsx`)

74. **R19-18 (2026-08-14): first-run MCP installs FINISH IN THE BACKGROUND.** A `uvx`/`npx`
    server that installs on first use could never go green: the probe killed it at the deadline,
    and uv only commits its cache on completion, so every retest restarted the download from
    zero — an unwinnable loop (measured: 556s in and still fetching). Owner ruled: start the
    warm-up **automatically** when a probe gives up on a visibly-installing command, cap it at
    **15 minutes**, and let the page re-check (~20s revalidation while any row warms) until the
    row turns into a real verdict on its own. The warm-up is the SAME `discoverStdioMcpTools`
    handshake with a bigger deadline — not a second code path — tracked by `warming_since` on the
    row plus an in-process registry; a boot reaper clears flags orphaned by a restart so no row
    claims to be installing with no installer. Proven live: uv cache 8.2MB → 963MB → 2.1GB
    across rounds, where before each round reset to zero.
    (`app/server/org/mcp-warmup.server.ts`; reaper wired in `app/server/boot.server.ts`;
    polling in `app/features/org-settings/resources-panel.tsx`)

75. **R19-19 (2026-08-14): agents get a REAL BROWSER — as a first-class capability.** Agents
    could read the web (`use-web-search-fetch`) but never drive it: no screenshots, no console,
    no "does my change actually render". Owner ruled for browser capabilities on four explicit
    decisions. **(a) Governance**: a new `use-browser` agent capability (default **off** — a
    casually created profile must not silently acquire a browser), enforced on BOTH backends by
    mounting or withholding a viberr-owned Playwright MCP server per run — deliberately NOT a
    bare org-registry mount riding the P13-KM-04 instruction-only gap. The mount additionally
    requires effective web egress: a profile whose `use-web-search-fetch` is withheld cannot
    re-acquire egress through the browser (the polarity hole that motivated first-class
    governance). **(b) Injection stance**: prompt-level guardrails, same posture as MCP
    governance — page content is data, never instructions; never enter credentials; the browser
    widens no authority. **(c) Deployment**: the chromium binary ships IN the app image (Debian
    `chromium` on node:26-slim, ~700MB installed — owner accepted the weight over a sidecar or
    repo-supplied browsers). **(d) Output**: what the browser produces lands in the task's
    canonical `attachments/` directory (the long-standing file-store placeholder made real) —
    member-only serving, rendered on the task page, citable in evidence references that carry
    into the review PR body. (`app/shared/capabilities.ts`,
    `app/server/tasks/specialist-browser-mcp.server.ts`, `Dockerfile`,
    `app/server/files/file-store-root.server.ts`, `app/routes/task-attachment.ts`)
    *(Amended 2026-08-21, pass 22 — two of the four decisions moved. **(a) egress**: the
    posture is reversed by ruling 95 (#176) — granting the browser now FORCES
    `use-web-search-fetch` to `direct` at every profile save path, because the browser IS
    egress; the mount-refusal this clause describes survives only as the runtime backstop
    for hand-edited files, and the "cannot re-acquire egress" polarity hole is closed from
    the grant side rather than the refusal side. **(d) output**: the attachments drop
    generalized — ruling 96 (#179) lets ANY `attach-evidence-references` run post files
    into `attachments/`, browser screenshots now being the special case, and attachments
    render as timeline thumbnails with an in-app lightbox (#177/#184). (b) the injection
    stance and (c) chromium-in-image stand unchanged.)*

76. **R20-1 (2026-08-14, F20-5): confirming a recovery option on a failure packet RESOLVES it and
    RE-QUEUES the operator — no repeat confirms, and the label says exactly what happens.** Live: the
    "Operator run failed" packet offered "Update the policy / credential and unblock" whose recorded
    effect was a HOLD (the label said UNBLOCK, the packet stayed open); the open packet then accepted
    "Confirm decision" three times, writing three identical decision entries onto the canonical
    timeline; and a human-pressed "Run operator" while it stayed open burned a paid no-op the
    coordination pause could take no action on. The ruling: confirming ANY recovery option resolves
    the packet (a settled decision refuses the next confirm), option labels must state their real
    effect, a settled decision re-queues the operator automatically (except the documented
    NO_REQUEUE set), and a repeat failure opens a NEW packet with a fresh decision record. A manual
    "Run operator" is refused while a packet is open (`refused: "open-packet"`) rather than paid for.
    Extends ruling 7's stable-kind dispatch and ruling 17's recovery-packet model.
    (`resolvePacket` in `app/server/tasks/task-actions.server.ts`; the `packet-resolved` trigger in
    `app/server/runtimes/operator-run.server.ts`)

77. **R20-2 (2026-08-14, F20-6): `accept_completion` re-verifies the ACTUAL branch state, and the
    packet's discard option actually deletes the never-pushed branch.** Live (VIB-2): a
    verification-only task whose workspace branch stayed byte-identical to main and was never pushed;
    the completion did not set `noChanges`, so `accept_completion` refused with advice that would have
    opened an EMPTY PR, and the operator's chosen "delete the branch, complete with no changes" option
    was UNEXECUTABLE — no one in-app could delete a task branch short of `archive_task(+deleteBranch)`.
    The ruling: the accept path re-verifies branch state — empty or missing routes into the
    no-change-acceptance path, with disclosure, regardless of the agent's `noChanges` flag — and a new
    `discard_branch` packet kind (ruling 7's tenth) deletes the never-pushed local branch on confirm.
    Consistent with ruling 62 (R19-8) — the no-change path keeps the full verdict gate — and ruling 17:
    `discardLocalTaskBranch` refuses an on-remote branch, as remote deletion has always been
    packet-only. (`no-change-completion.server.ts`, `push-workspace.server.ts`,
    `app/server/tasks/task-actions.server.ts`, `app/schemas/task-file.schema.ts`)

78. **R20-3 (2026-08-14, F20-4): the provider's OWN WORDS reach the packet and timeline (redacted),
    and model availability is validated against the account.** Live: a seeded Developer shipping
    `gpt-5.6-sol` on a ChatGPT-account Codex that rejects it (400 — "not supported when using Codex
    with a ChatGPT account"), while the blocked packet said only the double-generic "Codex execution
    failed. Review its authentication and runtime configuration." Both halves ship. Ruling 69's
    surface-the-tool's-own-words rule (R19-13) extends to the Codex/Claude spawn/run error pipe: a
    redacted `providerText` from `classifyCodexFailure` / `classifyClaudeError` reaches the persisted
    `err` line, the packet observation, the escalation and the timeline (`redactProviderText`, its own
    240-char clamp beside ruling 69's git redactor). AND model availability is marked from a REAL 400
    and cleared on a real success — no synthetic probe, ruling 19's proven-verdicts-only posture — in a
    new `model_availability` table, surfaced on the catalog and the profile modal so a marked model is
    disabled with a reason. Extends ruling 69 (R19-13). (`app/server/secrets/git-output-redact.server.ts`,
    `codex-runtime.server.ts`, `claude-runtime.server.ts`,
    `app/server/runtimes/model-availability.server.ts`, `model-catalog.server.ts`)

79. **R20-4 (2026-08-14, N20-2): a first-ever probe of an npx/bunx-style stdio command that times out
    is treated as visibly-installing.** The uvx path already warmed a first-run install in the
    background (ruling 74 / R19-18), but a cold `npx -y @modelcontextprotocol/server-everything`
    exceeding the 20s probe showed a bare "timed out after 20s" and no warm-up, because npx's progress
    output did not match the visibly-installing heuristic. The ruling extends R19-18's treatment to the
    npx/bunx family: a first-ever timing-out probe of such a command auto-warms in the background under
    the same 15-minute cap and the same polling row as uvx. Backed by `first_success_at` +
    `heuristic_warmups` columns so the warm-up is armed at most once per command and rolled back if it
    fails. Directly related to F20-10 — the same cold-install race that surfaces silently at run time.
    Extends ruling 74 (R19-18). (`app/server/org/resources.server.ts`,
    `app/server/org/mcp-warmup.server.ts`, `db/migrations/0001_baseline.sql`)

80. **R20-5 (2026-08-15, scope): pass 20 fixes EVERY defect and every UX-coherence/drift item that is
    a defect or inconsistency — only pure never-built PRD features are HELD.** The whole ledger
    (F20-1..30, N20-1..14) plus the coherence/drift items C1..C14 and D2..D13 are committed todos for
    this pass: no deferral, each validated. The only items held out of scope are features the product
    never built and that would be net-new work rather than corrections: **D7** (the three dropped
    Decision-Packet anatomy fields — impact / confidence / severity), **D10/D11** (the missing
    Continuity-Recovery-Panel escalated / paused states and the Execution-truth-strip
    runtime-continuity fact), and **D12** (skeleton loaders). Each held item stays noted as a
    spec-vs-app gap, not silently dropped. Extends ruling 38 (R16-4) — correctness first, then the
    full UI/a11y list, nothing deferred out of the pass.

81. **R20-6 (2026-08-14, F20-21): specialists act DIRECTLY or are WITHHELD — `recommend` is dropped
    for the specialist kind.** `coerceSpecialistCapabilityMode` silently widened a specialist's
    `recommend` grant to `direct` (`capabilities.ts:316-318`) while the seeded canonical project.md
    shipped `recommend` for the Developer's `move-task-to-review` and the Reviewer's
    `approve-review` / `request-changes` — so the file said one thing (7 direct + 1 recommend, 8 + 2)
    and every rendered surface said another ("Acts directly", "8 direct · 0 recommend"), with the
    dangerous polarity (recommend→direct) as the silent one. The ruling makes file = enforcement =
    display: remove the silent widening AND make the seed honest (write `direct`, not `recommend`, for
    the specialist grants). The operator keeps its real `recommend`. Extends ruling 2's capability
    model. (`app/shared/capabilities.ts`, `app/server/seed/agent-catalog.server.ts`)

82. **R20-7 (2026-08-14, F20-9 / D1): the capability display MIRRORS the runtime gate — the Agents
    card and the Capability matrix bucket grants autonomy-aware.** An operator profile holding
    `completion-for-acceptance: direct` on a project deployed SUPERVISED rendered "Accept completion
    into Done" under ACTS DIRECTLY, authority the server refuses: the display applied only
    `applyVerdictOutcomeGate` (`capabilitiesToActionLabels`) while the runtime also gates on
    `authority.autonomy !== "full"` (`operator-actions.server.ts:2580`) — the F15-06 defect class left
    unfixed one axis over, with an admin reading the card as policy truth. The ruling: the display gate
    applies the autonomy ceiling the same way it already applies the verdict gate, so under a supervised
    project the row renders gated/conditional, not "Acts directly"; and the Agents card carries the
    Policy page's reconciling note for the always-human "Transition a task to Done" row it prints
    beside it. Extends ruling 67 (R19-A) — autonomy is a ceiling on every run — and ruling 2.
    (`capabilitiesToActionLabels` in `app/features/agents/agents-query.server.ts`;
    `app/features/agents/agents-page.tsx`; the runtime gate at
    `app/server/tasks/operator-actions.server.ts` is the read-only mirror)

83. **R20-8 (2026-08-14, F20-4 seed half): the seeded Developer's default Codex model becomes
    `gpt-5.6-terra`.** The seed shipped `gpt-5.6-sol`, which this deployment's ChatGPT-account Codex
    cannot run; the CLI default `gpt-5.6-terra` is the model the account actually runs, so the seed now
    writes it. Ruling 78 (R20-3) still ships — a future mismatch is surfaced with the provider's own
    words and marked unavailable, honest rather than generic — so this changes the default, not the
    honesty machinery behind it. (`app/server/seed/agent-catalog.server.ts`)

84. **R20-9 (2026-08-15, F20-31): the operator MAY gather a delegated ask itself, and the packet must
    SAY it is standing in for the delivering agent.** A goal can delegate a clarifying question to the
    agent that will do the work ("first ask the human, via your ask-human capability, whether…"), and
    holding scope hostage until that agent spins up stalls the task for no gain. So the operator may
    collect the answer at triage with its own `open_decision_packet` (type `"input"`) — but the packet
    body must state that it is gathering the answer **on the delivering agent's behalf**, or the
    timeline reads as though the agent never held the ask and the delegation disappears without a
    trace. Enforcement is MECHANICAL, not advisory: the run remembers which agents it prompted this
    turn, and the packet-open path APPENDS the disclosure to the body it writes — so a packet raised
    after a consultation cannot reach a human without saying so, even when the model wrote no body at
    all. Omission is impossible on packet-open rather than discouraged. The prompt clause stays (it is
    the closing clause of the triage quality gate both operator backends share, and it asks the model
    to say WHY in its own words), but it is now guidance layered over a guarantee instead of being the
    only thing standing between the timeline and a lie. Sits beside the standing rule that the
    operator may not WITHDRAW an agent's ask (`operatorResolvePacket` refuses a packet carrying
    `askedBy`). *(Ruled 2026-08-15 in pass 20's own ledger —
    `planning/discovery-2026-08-14-pass20/FINDINGS.md:754-757` — and promoted here 2026-08-19, pass 21
    (U4). The id `R20-9` was cited by name in a shipped prompt and its test while no canon file
    recorded it: exactly the failure ruling 44 (R17-3) exists to stop, reproducing one pass later.
    Pass 21's other id, `R21-1` — re-authenticating Codex on the host mid-pass and copying the fresh
    `auth.json` into the container so the Codex parity legs could run — is deliberately NOT promoted:
    it is an operational step taken during the pass, not a rule that binds the product, and canon that
    absorbs run-log entries stops being readable as law.)*
    (`consultationDisclosure` + the `open_decision_packet` handler in
    `app/server/tasks/operator-toolkit.server.ts`, pinned by
    `app/server/tasks/operator-actions.server.test.ts`; the prompt clause is `triageQualityGate` in
    `app/server/runtimes/operator-run.server.ts`, pinned by
    `app/server/runtimes/operator-prompt-mention.server.test.ts`)

85. **R21-2 (2026-08-19, OBS-1): a capability-gap packet names the product's OWN remedy — grant the
    capability on an agent profile — and the operator still changes no configuration itself.** Live
    (VIB-1, "take a screenshot of the login page"): the operator correctly found that every deployed
    specialist has `use-browser` withheld and opened an input packet offering three scopes — write a
    Playwright script, capture it by hand, or narrow the goal. All three are workarounds for a
    capability this product SHIPS as a grant (ruling 75 / R19-19), and a packet that lists only
    workarounds teaches the human the product cannot do a thing it can do. The ruling: when the
    blocker is a withheld capability, the packet names the capability, says where a human grants it
    (the project's Agents surface, where a profile's capability grants are edited) and keeps that
    option beside the workarounds. The division of labour is untouched — capability and policy edits
    are a human action (`change-project-policy` sits on the always-human list, ruling 2), so the
    operator points at the remedy and never applies it. Extends ruling 75 (R19-19).
    (packet construction in `app/server/runtimes/operator-run.server.ts`; `app/shared/capabilities.ts`;
    the surface is `app/features/agents/agents-page.tsx`)

86. **R21-3 (2026-08-19, U1): the anti-slop lint plugin is ADOPTED — `npm run lint` becomes a required
    CI gate, and "there is no linter, by decision" is retired.** Commits `54ffab8` and `ce2bc9e`
    (2026-08-19) installed oxlint with a vendored 15-rule `anti-slop` plugin (`.oxlintrc.json`,
    `tools/oxlint/anti-slop/`, `npm run lint`) and rewrote 387 files to satisfy it — while
    `architecture.md`, the document this file names as winning on conflict, still said TWICE that
    there is no linter *by decision*; no ruling recorded the reversal; the script exited 1 on a clean
    tree with 26 findings whose acceptance lived only in a commit message; and no gate ran it. The
    owner ruled adoption, not reversal. The plugin stays; the 26 remaining findings are FIXED rather
    than suppressed — a red script whose redness is "accepted" somewhere unreadable is not a gate,
    because nobody running it can tell an accepted finding from a new one; `npm run lint` becomes a
    required step of the `verify` job; and architecture.md's two "no linter" sentences plus its CI/CD
    note carry dated amendments pointing here. **Landing state:** the ruling is the decision, and the
    two mechanical halves it requires — the CI step in `.github/workflows/ci.yml` and a zero-finding
    `npm run lint` on a clean tree — land in this same pass, in the band that owns them. Read this as
    what the gate IS once pass 21 closes, not as a claim that the workflow file already carried the
    step the moment this ruling was written; a canon entry that describes its own in-flight work has
    to say which half is which (ruling 63 / R19-9 — an unmeasured claim is decoration).
    The rewrite's own cost is paid in the same pass: four
    regressions it introduced — F21-7 (a drifted check-runs payload persisting a false green "N checks
    passing"), F21-8 (one malformed commit emptying the whole commit list), F21-9 (the github client's
    "never throws" contract broken) and F21-11 (drifted PAT permissions silently upgrading to "valid")
    — are fixed here. That is the standing lesson: a mechanical tree-wide rewrite carries the same
    review bar as behavior, because it changes behavior. (`.oxlintrc.json`, `tools/oxlint/anti-slop/`,
    `package.json`, `.github/workflows/ci.yml`; amended in `planning/planning-artifacts/architecture.md`
    §Infrastructure & Deployment, §Enforcement Guidelines, §Development Workflow Integration)

87. **R21-4 (2026-08-19, OBS-8 / OBS-9 / G5): task workspaces clone through a per-project mirror
    cache, and the pre-run workspace phase is VISIBLE on the task page.** Live (VIB-3): a
    create-triggered operator run spent 3+ minutes inside `git clone --depth 1` of a 113MB repository
    before "operator run started" ever appeared, and for that whole window the task showed an empty
    timeline, "hasn't started its operator loop" and no live-run panel — a healthy run was
    indistinguishable from a wedged one. Every task also paid the cost again: VIB-1/2/3 each held
    their own ~113MB clone under `tasks/<KEY>/workspace`. The owner ruled BOTH halves. **(a)** A
    per-project git mirror/reference cache backs task clones, so the second and later clones of a
    repository are local work rather than a fresh network fetch. **(b)** The pre-run phase is
    surfaced live: `onPhase` — declared on the adapter interface and wired into the run sink, and
    never once invoked by any adapter, so FR28's two live-progress rows rendered blank the whole
    time a run was working — is actually driven, with a "preparing workspace" phase covering the
    clone. Closes G5 (FR28:
    current progress without opening the raw provider console) together with OBS-8/OBS-9.
    (the mirror cache is `cloneWorkspaceRepo` + `projectRepoMirrorDir` in
    `app/server/tasks/repo-mirror.server.ts`, called by the private `cloneRepo` in
    `app/server/tasks/specialist-run.server.ts`; `onPhase` in `app/server/runtimes/adapter.server.ts`
    → `app/server/runtimes/run-service.server.ts`; rendered by `app/features/runtime/runs-panels.tsx`)

88. **R21-5 (2026-08-19, F21-2): an acceptance is valid only WITH the disclosure the human was shown —
    a bare POST is refused.** Ruling 20 (R15-1) requires every acceptance, force included, to pass a
    confirm dialog stating what merges and which signals are missing. Pass 21 found that requirement
    held CLIENT-architecturally only — one dialog component, one pending state, every acceptance
    fetcher hoisted to the page so a child cannot submit around it — while the server accepted the
    request on its own, so a direct POST (a double-submit, a script, a future surface that forgets the
    ceremony) completed the acceptance with no disclosure at all. The ruling makes the ceremony a
    SERVER invariant: an acceptance — normal or forced — carries an explicit acknowledgment echoing
    the facts the client displayed (the merge state, the revision being accepted, the verdict that
    stands), the server refuses an acceptance that arrives without one, and an echo that no longer
    matches the task's state is a refusal rather than a silent write. Deliberately
    implementation-neutral: what binds is that the disclosure the human saw reaches the server with
    the acceptance, not any particular payload shape. Extends ruling 20 (R15-1) and puts ruling 59's
    (R19-5) honesty burden behind a check instead of a convention.
    Scope is the HUMAN acceptance paths — the ones the ceremony fronts; an operator acceptance
    carries its own disclosure contract (ruling 40 — an operator acceptance records **merge pending**
    and the difference must be visible where the task lives; ruling 77 — the accept path re-verifies
    the real branch state and routes an empty branch into the no-change path *with disclosure*) and is
    unchanged here. *(Citation corrected 2026-08-19: this read "rulings 40, 77, 82". Ruling 82 (R20-7)
    is the Agents-card display gate — it keeps the operator honest about whether it holds the
    `completion-for-acceptance` grant at all, which is a neighbouring guarantee, not a disclosure
    carried with an acceptance.)*
    (the ceremony is `app/features/task-detail/accept-confirm.tsx`, hoisted at
    `app/features/task-detail/task-detail-page.tsx` and `app/features/board/board-page.tsx`; the
    server entries it must now reach are in `app/server/tasks/task-actions.server.ts`)

89. **R21-6 (2026-08-20, U5/G4): the triage quality gate stays BEHAVIORAL — no mechanical
    transition block on open packets.** The operator flags underspecified goals at triage (its
    prompt's gate section) and a manual operator run refuses while a packet is open; that is the
    gate. The owner declined hard-enforcing "no stage transition while an input-required packet is
    open" — a human moving a task past an open packet is a deliberate act, not an accident to
    prevent. The New-task placeholder was reworded to promise only what exists ("Underspecified
    goals get flagged by the operator at triage" — `app/features/board/board-page.tsx`), closing
    the U5 copy-vs-behavior gap from the honest side.

90. **R21-7 (2026-08-20): `FILES.md` is DELETED, not regenerated.** It claimed to be "generated
    from Git's tracked-file index" while trailing reality by ~1,000 files across ten passes — a
    completeness promise nothing enforced. The tracked-file index is `git ls-files`; the annotated
    tree lives in `planning/planning-artifacts/architecture.md`. A doc whose only job a command
    does better earns deletion over another unenforced regeneration.

91. **R21-8 (2026-08-21): while an agent actively carries a task, `input_required` YIELDS to
    "agent working" — on every surface.** Owner-reported live: a fresh triage task with a live run
    read "input required · agent working" side by side, and "there is no human action needed."
    The pill claims a human is needed RIGHT NOW; an active run makes that false. Supersedes the
    C3/F15-09 both-pills arrangement while keeping its actual requirement (the hero and the board
    card must agree mid-run): the hero swaps the readiness pill for the agent pill, the board
    card/list-row top slot goes quiet (the foot's WaitTag already says "agent working"), and the
    "Blocked or waiting" filter stops matching — an actively-worked task is not stuck (R16-2's
    name-the-chip rule, mirrored). The gate is `waiting === "agent"`: raising a packet flips
    `waiting` to `"human"`, so the human's turn instantly reasserts "input required" everywhere,
    even if a run is still winding down. `blocked` / `inconsistency_risk_detected` never yield —
    a run does not answer those. Stored readiness is untouched; the triage gate itself still
    clears only on leaving the entry stage (task-actions.server.ts).

    **Completed 2026-08-27 (owner-reported again, on `ready`).** The ruling shipped as a UI
    special case for the one value the report showed, re-derived on three surfaces with two
    different gates — so `ready` kept the app's GREEN ALL-CLEAR while an agent worked, which is
    the same defect with a worse tell. `ready` is also the state that dominates: the triage gate
    clears `input_required` on leaving the entry stage, exactly when agents start working, and
    `fm.waiting = "agent"` + `fm.readiness = "ready"` are written together by
    retry-on-other-backend, re-engage-specialist and unblock-on-policy. The yield now covers
    `ready` too and lives in ONE server-side derivation, `deriveDisplayReadiness`
    (app/shared/mapping/task.server.ts), beside the packet lift it composes with; surfaces render
    the derived `agent_working` value and no longer re-decide it (rulings 12/14). The gate is the
    ruling's own `waiting === "agent"` — the hero's extra live-runtime check is gone, so the hero
    and the board card cannot disagree mid-run by construction, which was C3's actual complaint.

92. **R21-9 (2026-08-21): the claude backend's display label is "Claude" (not "Claude Code"),
    and the operator run control SHOWS, it does not pick.** Two owner instructions, one surface.
    The label: every backend label site (mapping `agentBackendName`, actor-ref display names,
    run/toast/timeline copy, pickers, roster chips) says "Claude"; references to the actual
    Claude Code product (the CLI login, transcript retention, the coding harness) keep their
    name. Stored records are not rewritten. The card: the per-run backend/autonomy dropdowns are
    gone — both are configured on the deployed operator profile and the run resolves the LIVE
    profile (the R21-8/#183 law), so the card states the backend, keeps Run, and adds an optional
    steer. The steer rides the `@operator` mention machinery: recorded as the human's own timeline
    comment (a directive that reaches an agent off the record is invisible to supervision) and
    passed as the run's `humanComment`, with `humanCommentBy` the DISPLAY name (live-caught: the
    email label tagged "@arda@viberr.dev", which chips and notifies nobody). F20-9's mirror
    survives as a caption: full autonomy announces itself on the run surface; supervised is the
    quiet default. P11-41 survives without a picker: an unconfigured profile backend disables Run
    with the reason rendered.

93. **R22 (2026-08-21, pass 22): the Codex OS process sandbox is REMOVED — "viberr itself
    is the sandbox."** `resolveCodexSandboxMode` returns `read-only` for NO run anymore:
    only a fully-autonomous DELIVERING run that also holds web egress gets
    `danger-full-access`; every other run — operators, reviewers, supervised runs, and any
    run whose `use-web-search-fetch` is withheld — is `workspace-write`, writable and
    shell-capable with the network gated by the egress capability (`networkAccessEnabled` /
    `webSearchMode`). The owner's scope is precise, confirmed on the boundary question:
    remove ONLY the OS process sandbox — the container plus the server-owned delivery gate
    (push / open-PR / merge / close / Done are server actions no agent tool reaches) are
    the real boundary, and read-only mode only crippled agents doing legitimate local
    work. KEPT unchanged: Claude's capability tool-denylist enforcement (operators and
    reviewers stay read-only on Claude via denylist; a withheld `execute-code-or-write-repo`
    still removes the write tools on Claude), and EGRESS as an enforced capability on both
    backends. The two directives conflict at the extreme — `danger-full-access` turns the
    network on unconditionally, defeating egress gating — so egress-gated runs use
    `workspace-write`, the least-confining mode whose network toggle Codex respects.
    Consequences recorded in code: `execute-code-or-write-repo` REJOINED
    `CLAUDE_ONLY_ENFORCED_CAPABILITY_IDS` (on Codex it is advisory plus the delivery
    gate), while `use-web-search-fetch` stays in the both-backend enforced set; the
    capability-matrix copy now says the Codex file/command limits are advisory, the
    server-side delivery gate is the real constraint, and egress is gated on both.
    Supersedes P13-RT-02 (write-withheld Codex ⇒ read-only sandbox) and P14-RT-03 (which
    moved `execute-code-or-write-repo` into the both-backend set on the strength of that
    sandbox). Also resolves AD-1/F22-03: a workspace-write reviewer with
    `attach-evidence-references` granted can actually write `attachments/`, so the
    "Posting files" persona no longer promises a write the sandbox blocked.
    (`resolveCodexSandboxMode` in `app/server/runtimes/codex-runtime.server.ts:368`;
    `CLAUDE_ONLY_ENFORCED_CAPABILITY_IDS` in `app/shared/capabilities.ts:253`; the modal
    copy in `app/features/agents/capability-matrix-modal.tsx:85-93`)

94. **R22-schedule (2026-08-21, F22-02): a scheduled operator re-run resolves the LIVE
    deployed profile at fire time — FR39's per-schedule backend/autonomy pin is
    superseded.** The schedule form offers no backend/autonomy pickers, the stored entry
    pins neither, and `runOperator` fills both from the deployed operator profile when
    omitted (`resolveOperatorAuthority`: `overrides.backend ?? declaredBackend`). This is
    ruling 92's (R21-9) "the card shows, doesn't pick" applied to the unattended case,
    where it matters more: for a run set hours ahead, following the profile actually
    deployed at fire time beats freezing what was configured earlier — the frozen pin was
    the temporal twin of the #183 stale-backend-display bug (ruling 97). No schedule-time
    clamp is needed because nothing is stored to clamp; the fired run resolves and clamps
    (ruling 67 / R19-A) against whatever is deployed when it fires. FR39 is amended in the
    PRD accordingly. (`app/server/tasks/schedule.server.ts:141-149,468-471`;
    `resolveOperatorAuthority` in `app/server/tasks/operator-actions.server.ts`; the
    pickerless form in `app/features/task-detail/task-main-sections.tsx:299,353,390`)

95. **Browser implies egress (#176; owner ruling 2026-08-20, promoted 2026-08-21).**
    Granting `use-browser` (`direct`) forces `use-web-search-fetch` to `direct` at every
    profile save path — `repairBrowserEgressGrants`, folded with the delivery repair by
    `applyGrantCouplings`, with the capability editor pinning the egress row to Allowed
    while the browser is Allowed. The browser IS network egress, so a browser-granted /
    egress-withheld profile expresses no policy at all: `resolveBrowserMcp` fails the
    mount closed either way, and the live failure shape was an admin granting "Drive a
    live web browser", leaving "Search & fetch from the web" off, and getting run after
    run that honestly reported "browser not mounted" against a matrix that said Allowed.
    This deliberately diverges from B-AG1's respect-the-explicit-off posture — the
    browser rule has NO "withheld" arm. There the contradictory state is a real,
    enforceable withholding (the scoped delivery steps stay dead until the admin resolves
    it); here respecting the `off` preserves nothing but the trap. The runtime
    mount-refusal stays as the backstop for hand-edited files. Amends ruling 75(a).
    (`repairBrowserEgressGrants` / `applyGrantCouplings` in
    `app/shared/capabilities.ts:479,514`; the editor pin in
    `app/features/agents/create-profile-modal.tsx:697-749`)

96. **The attachments drop (#179; owner ask 2026-08-20, promoted 2026-08-21): any run
    granted `attach-evidence-references` may POST FILES on the task thread.** Files the
    run copies into the task's canonical `attachments/` directory are posted on the
    agent's reply, images rendering inline as timeline thumbnails. The persona section
    ("Posting files on the task thread") is emitted for ANY evidence-granted profile,
    browser or not — every backend that can write files can use a plain directory — so
    the browser's default-named screenshots (ruling 75(d)) become a special case of this
    general mechanic rather than the mechanic itself. Live provenance, both directions:
    an agent committed its screenshot into the review PR because nothing told it the
    thread could carry files; and once told, a run (VIB-2) correctly REFUSED the copy
    twice because the workspace contract's "never touch anything outside the working
    directory" outranked the persona — so the contract now names the drop as its one
    exception (`attachmentsDropRel`), and on Codex the attachments dir joins the
    writable set (ruling 93's `attachmentsWritableDir`). Extends ruling 75(d).
    (`attachmentsDropSection` in `app/server/tasks/specialist-browser-mcp.server.ts:167`;
    the persona gate, workspace-contract exception and sandbox widening in
    `app/server/tasks/specialist-run.server.ts:1403,1653,2014`)

97. **The live-backend display law (#183; promoted 2026-08-21): every surface displays
    the backend a run would ACTUALLY use.** Engagement rows in `task.md` snapshot the
    backend at engage time, and the run start heals them only when the next run actually
    happens — so between a profile edit and that run the snapshot lies about what Run
    does (owner-reported live: the exec profile said "Codex" after the Developer profile
    was switched to Claude; Run would have started a Claude run under a card labeled
    Codex). The rule: the server query layer overlays the live deployed
    `profileId → backend` map onto the task snapshot — `withLiveAgentBackends`, fed by
    `deployedSpecialistBackends` / `primaryRunBackend`, the same primary-backend rule the
    run resolves with — so board, review queue, task detail and the Agents page all
    inherit one answer. A profile absent from the map (undeployed since engagement) keeps
    its snapshot, exactly the run path's own fallback; stored records are not rewritten.
    Rulings 92 (R21-9) and 94 are this law's other two faces: the run control and the
    schedule both SHOW what the live profile resolves; neither pins.
    Layering (#183, 2026-08-21): the overlay rule is a SERVER concern the hottest read
    loaders need on every render, so it lives in the server layer —
    `app/server/agents/deployment-view.server.ts` owns `primaryRunBackend`,
    `deploymentRuntimeIdentity` (the single `override ?? template ?? default` resolution)
    and `deployedSpecialistBackends`. The `features/agents` display code imports them back
    (features → server, the allowed direction); `effectiveProfileView` delegates the
    kind/backends resolution to the same `deploymentRuntimeIdentity`, so the map that
    DISPLAYS a backend and the value a run RESOLVES are one computation. The prior form
    had `server/projections/*` importing the rule up from `features/agents` — the inversion
    this removes.
    (`withLiveAgentBackends` in `app/shared/mapping/task.server.ts:369`;
    `primaryRunBackend` / `deployedSpecialistBackends` / `deploymentRuntimeIdentity` in
    `app/server/agents/deployment-view.server.ts`; overlay call sites
    `app/server/projections/board-query.server.ts`,
    `app/server/projections/task-query.server.ts`)

98. **Dynamic agent dispatch (owner directive 2026-08-29): the static delivering/reviewer
    slots are GONE — the operator decides which agent runs at each stage, humans dispatch
    through ONE selector+prompt control, dispatched runs always report back to their
    triggerer AND the operator, and scheduling lives inside the run controls.** Preprod,
    explicitly no backwards compatibility. The pieces, and what each replaced:
    **(a) Engagements are run-created, not human-assigned.** The `engagements[]` ledger
    stays (verdict snapshots, KB union, per-engagement workspaces, single-flight and the
    required-reviewer gate all key off it) but is written by the dispatch: running an
    unengaged deployed profile engages it, delivering iff the task has no deliverer AND
    the profile holds repo-write, supporting otherwise — a verdict-only profile dispatched
    first can no longer become a deliverer that ships nothing (UI-39's dead-end class,
    closed structurally). An explicit `delivers: true` is a delivery hand-off through the
    existing assignSpecialist machinery. The assign/engage menus, the per-row Run buttons,
    the `assign-specialist`/`run-specialist`/`assign-reviewer`/`run-reviewer` intents and
    the legacy `specialist`/`reviewers`/`consultants` parse absorption are deleted;
    releasing a supporting engagement survives as the ledger's ✕ (`release-agent`).
    **(b) One dispatch verb everywhere.** The operator's `engage_agent`/`run_agent`/
    `prompt_agent` trio collapsed into ONE `run_agent(profileId, prompt?, delivers?)` on
    both backends; the `assign-primary-specialist`+`summon-reviewers` capability pair
    collapsed into `dispatch-agents`; the four slot-shaped recommendation kinds collapsed
    into `run_agent` (profileId + prompt on the card; Apply dispatches exactly what the
    manual control would). The choice itself stays an LLM decision fenced by stage
    eligibility, grants and the selection trace — and it now weighs the durable
    **`previousStageId`** frontmatter fact (written on every transition; surfaced in the
    snapshot and turn doctrine), so "back from Review" reads as rework rather than a
    fresh build even across turns.
    **(c) The dispatch-completion contract.** A manually- or schedule-dispatched run's
    final report always tags the dispatching human (the tag is what notifies, NEW-4) and
    `@operator`, and its completion ALWAYS re-invokes the operator (heuristic bypassed;
    the react depth cap still binds, and only the dispatched hop is forced). Mechanical
    in the completion pipeline with the prompt clause as guidance — R20-9's
    guarantee-over-guidance shape; a crash-recovered completion degrades to the
    heuristic, the same documented loss class as `fromHumanDirective`. The @mention
    comment path is the same machinery and carries the same contract — mentioning any
    deployed agent now auto-engages it instead of refusing "not engaged".
    **(d) Scheduling is baked into the run controls.** No separate panel or button: each
    run control carries a when-picker (now / 5m / 1h / 6h / 24h) that turns Run into
    Schedule, and pending entries list under the control that scheduled them. Schedules
    generalized to `run-operator | run-agent` — the agent arm pins ONLY the profile id
    (identity is the scheduled decision; backend/model/capabilities resolve live at fire
    time — ruling 94's R22 law unchanged), requires the profile deployed at create time,
    and a fire-time validation refusal (undeployed, stage-ineligible) is a terminal
    `failed` with the reason on the timeline, never a silent retry loop.
    Extends rulings 21 (R15-2 — delivery stays the operator's decision), 67 (R19-A),
    92 (R21-9 — both controls still show, never pick), 94 and 97; amends FR14 and FR39
    in the PRD; supersedes FR14's static-slot reading and ruling 92's steer-only run
    control. (`app/server/tasks/operator-actions.server.ts` `operatorDispatchAgent`;
    `app/server/tasks/specialist-run.server.ts` auto-engage in `dispatchAgentRun`;
    `app/server/tasks/task-actions.server.ts` completion contract + `previousStageId`;
    `app/server/tasks/schedule.server.ts`; `app/features/task-detail/execution-profile.tsx`,
    `agent-select.tsx`)

99. **The CONTROLLER (owner directive 2026-08-30): one instance-level conversational
    agent, machinery like the operator but above it, whose every action runs under the
    ASKING USER's own authority — and chained goals as a first-class product concept.**
    Preprod, explicitly no backwards compatibility. The pieces:
    **(a) Identity.** A third profile kind, `kind: controller`, exactly one per instance:
    `agents/profiles/controller.md` + its doctrine at `agents/definitions/controller.md`,
    its own skill (`controller-guide`), its own knowledge base (`kb/controller-handbook`),
    and org-registry MCP grants through `resources.mcps` — all shipped by the boot
    backfill (`seedDefaultAgentAssets`), never via `SEED_AGENT_PROFILES` (that array
    feeds project deployments, and the controller is not deployable; `readTemplate`
    resolves a controller-kind template as absent so the two-kind deployment world stays
    closed). ONLY org admins modify the controller itself — the org-settings Controller
    tab (model, resource grants, instructions); the gagents CRUD panel never lists or
    edits it. It carries NO capability matrix: its runtime authority is the asking
    user's, so a stored grant row would be a toggle with no effect (the P14-KM-14 class).
    **(b) Authority.** Talking to it is separate from configuring it: every signed-in
    user converses (`/controller`, and `/projects/:slug/controller` inside a project),
    and every TOOL CALL resolves the asking user's LIVE authority — org role for
    instance tools (users, KBs, skills, MCP connections, global agent templates, audit,
    run analytics: org admin, the /org/settings parity; project creation: any signed-in
    user, the FR5 parity, creator seeded admin), the project-role matrix for board tools
    (the SAME `assertProjectAction`/`requireAction` guards humans use, so the D2
    org-admin override, denial audit rows and R15-4's members-only 404 posture apply
    identically — a probe cannot learn a project exists). The authority actor is
    `{userId: asker, label: "<email> · via controller"}`: guards bind to the human, the
    audit trail discloses the instrument. Refusals are OUT LOUD: a denied tool answers
    `[denied] <the guard's own sentence>` and the doctrine requires relaying it; an
    instance-scope denial writes `controller.authority.denied` (P13-D-8 parity).
    **(c) Always-human stays human.** The toolkit has NO tool for merge, acceptance,
    force-accept, packet resolution, or a move into the terminal stage — the move tool
    refuses a Done target and points at the task page, because ruling 88's disclosure
    ceremony is the load-bearing thing chat cannot impersonate. Policy edits ARE offered
    (gated on the asker's `edit-policy`): the ALWAYS_HUMAN `change-project-policy` entry
    bounds AGENT-initiated change, and the controller never initiates — it executes an
    explicit human directive, the same authorization a settings form click carries. No
    tool deletes anything, in either scope. Secrets never travel through chat
    (`save_mcp_server` takes no credential; the one exception is relaying a just-minted
    single-use temp password, which `pwreset_required` bounds).
    **(d) Conversations.** App-owned SQLite (`controller_conversations` /
    `controller_messages` — the notifications/sessions family; file-formats §5), owned by
    the asking user, readable by that user and org admins (a transcript is scoped to
    what ITS user was entitled to hear — project members do not read each other's).
    Each user message is one RUN through the existing machinery (`agent_runs.kind =
    'controller'`, `project_slug = ''`, `task_key = <conversation id>` — a scope no
    task query matches): NDJSON, redaction, token accounting, run-log console (owner-or-
    admin gated at the route) and boot orphan finalization all inherited. Turns resume
    the provider session with a per-turn recent-exchange digest as the re-anchor (the
    controller has no task.md); single-flight per conversation with a FIFO of queued
    messages; a restart-orphaned turn gets an honest "interrupted" note at boot.
    Enforcement is CLAUDE-ONLY by the same security decision as `read-github-api`: the
    toolkit is in-process, so DB handles and sealed credentials never cross a process
    boundary, and Codex's single-shot plan executor cannot serve a conversation that
    must read mid-turn. An unavailable Claude backend refuses honestly in-transcript.
    **(e) Chained goals.** A goal decomposes ONE outcome into an ordered chain of tasks
    inside a project — canonical at `projects/<slug>/goals/<goal-id>.md` (frontmatter:
    status `active|paused|attention|completed|cancelled`, `onFailure: pause|continue`,
    `links[{index,title,goal,taskKey,status,note}]`, `createdBy`; body: description +
    history bullets), projected to `goal_projections` with link statuses RECONCILED
    against live task rows, back-referenced from each task's `goalRef` frontmatter (the
    project→task shape: the chain file owns the list, the task carries its position).
    Tasks are created LAZILY: link 1 with the goal, each next link when the previous
    completes — by the convergent `reconcileGoal` engine (hooked into transition,
    acceptance and archive writes, plus a one-minute runner for out-of-band edits),
    creating under the goal CREATOR's re-proven live `create-task` (FR39's precedent:
    unattended action stays visible, cancellable, audited; lost authority parks the
    chain in `attention` instead of escalating). A link's task failing (archived) pauses
    the chain (`attention`) or rides past it per `onFailure`; humans redirect — retry,
    skip, edit pending links, add, pause/resume, cancel — through the controller or the
    Goals panel on the project Controller surface (gate: the creator, or `run-agents`).
    Nothing deletes a goal; terminal chains stay readable. Every link's task gets its
    own operator through `createTask`'s existing auto-invoke — the controller sits above
    operators (brief, trigger, steer via `run_agent_on_task`/`comment_on_task`, the
    dispatch-completion contract of ruling 98 riding along) and never duplicates them.
    **(f) FR11 amended.** "Agents cannot create tasks" bars agents INVENTING tasks; the
    controller creates them as the instrument of an authorized asking user, and chain
    advancement creates them under the recorded creator's re-proven authority.
    (`app/server/controller/*`, `app/server/tasks/goal-actions.server.ts`,
    `app/server/files/goal-writer.server.ts`, `app/schemas/goal-file.schema.ts`,
    `app/features/controller/*`, `app/routes/controller.tsx`,
    `app/routes/project.controller.tsx`; the custom project shape in
    `app/features/home/project-create.server.ts` `CustomProjectShape`)

*(UI-preference notes, 2026-08-21, pass 22 — owner decisions on presentation, recorded as
preferences rather than law: **#180** the decision packet takes the questionnaire's
density; **#182** the packet's minimal redesign — it reads as one quiet column; **#186**
an owned task's owner cell is just the owner, with no manage affordance. Styling-only —
no capability, gate or copy contract changed — noted here so a later pass does not read
the quieter packet or the bare owner cell as drift.)*

100. **Ruling 99's two review-flagged asymmetries are INTENDED (owner, 2026-08-31).**
    (a) The controller applies policy/workflow edits with no confirm ceremony while
    most governed actions have one — the controller is an admin-tier instrument
    executing an explicit human directive, so "has a ceremony" staying the practical
    always-human test is accepted, not drift. (b) Org admins read project-scoped
    controller transcripts for projects they are not members of, a deliberate step
    outside R15-4's members-only posture: the transcript belongs to the ASKING user's
    scope, and org admins administer the instrument. Both were raised as questions in
    pass 31's discovery (E1) and confirmed as designed.

101. **Repo-write parity (owner, 2026-08-31 — partially supersedes R22): write posture
    is GRANTS-derived and binds the SAME on both backends.** "Reviewer is just a type
    of an agent; some agents should be able to write, some don't, related to their
    work/assignment — but parity between Claude and Codex is essential." Concretely:
    (a) a run whose effective `execute-code-or-write-repo` is withheld cannot write on
    EITHER leg — Claude via the tool denylist (unchanged), Codex via the read-only
    sandbox restored to `resolveCodexSandboxMode` (the P13-RT-02 shape R22 removed);
    the capability moves back to `ENFORCED_CAPABILITY_IDS` (both-backend). (b) What
    R22 got right survives: a write-GRANTED run is never confined for its role's name
    — a supporting agent granted the family may edit its own isolated checkout (P8
    isolation + sha-bound verdicts contain it), so Claude's kind-based supporting
    denylist narrowed to the DELIVERY commands only (`git push`, `gh pr create`,
    `gh pr merge` — the VIB-30 class stays closed; local-write denies now ride the
    grant-derived `disallowedTools`). (c) The one disclosed carve-out: a write-
    withheld Codex run that is EVIDENCE-granted (attachments dir mounted) keeps
    `workspace-write`, capped below full access — the sandbox cannot express
    "read-only except attachments/", and blocking the file-posting assignment was the
    F22-03 defect. (d) The operator is coordination machinery, not an agent with a
    write assignment: read-only on Codex again, matching Claude's operator denylist.
    (e) Scoped delivery commands stay claude-only at the tool layer (the sandbox is
    all-or-nothing); their Codex boundary remains credential-less agents + the
    server-owned delivery gate. Shipped without live Codex validation (provider quota
    blocked until Sep 18 2026) — envelope/unit tests pin the contract.

102. **FR33 audit purge exports before it deletes (owner, 2026-08-31).** The 90-day
    hard-delete of `audit_events` first appends the expiring rows, verbatim, to a
    JSONL export under the data root (`audit-exports/`); an export failure SKIPS that
    pass's purge (fail closed — losing a purge tick is recoverable, losing the rows
    is not). This gives FR33's purge a durable long-term record beyond whatever the
    S3 schedule happens to capture.

103. **The declared browser matrix is Chromium-only (owner, 2026-08-31).** Safari and
    Firefox were declared intent that no pass ever exercised (recorded 2026-08-19);
    struck from the PRD (canon + mirror) rather than left implied. Re-adding an
    engine requires a Playwright project that actually runs it.

104. **Operator narration is stored verbatim; no write-time length cap (owner,
    2026-08-31).** The `operator-brevity` guardrail hard-truncated operator comments
    in the canonical record at 1000 chars, so an acceptance caveat's tail existed
    only in the agent logs while agent replies of any length survived behind the
    timeline's Show more clamp. The owner ruled the trim out: the record keeps the
    full narration, `CollapsibleComment` clamps it view-side exactly like long agent
    replies, and brevity survives as a style instruction on the operator's
    `post_comment` tool. The guardrail row is gone from `DEFAULT_GUARDRAILS`
    (a row with no enforcement would be decorative — the ruling-Q3 failure mode);
    stale rows in existing `project.md` files are inert and tolerated. The other
    anti-noise guardrails (meaningful-comment, evidence-separation,
    no-duplicate-summary, compression-threshold) are unchanged.

## Route map

```
/login  /logout  /api/auth/*            (better-auth, incl. OAuth callbacks)
/                                       → home (project list)
/projects                               → home (bare /projects is not a 404 — N5)
/projects/:slug                         → redirect to board
/projects/:slug/board  /review  /controller  /agents  /policy  /github  /activity  /settings
/projects/:slug/tasks/:key
/projects/:slug/tasks/:key/attachments/:file   (R19-19 — member-only, raw bytes)
/org/settings                           (org admin, tabbed — incl. the Controller tab)
/controller                             (ruling 99 — every signed-in user)
/profile   /notifications   /notifications/read   /prefs/theme
/resources/events  (SSE)   /resources/health   /resources/run-log
/resources/search   /resources/session-export   /resources/model-catalog
```

*(Corrected 2026-08-06, pass 19, against `app/routes.ts`: `/projects`, `/notifications/read`,
`/prefs/theme` and `/resources/search` — the ⌘K palette query from ruling 23 / R15-5 — ship but
were never added here.)*
