# Binding decisions & conventions

This is the normative contract that code comments across the tree cite as **CONVENTIONS**
and as **"orchestrator ruling N"**. It condenses
[`planning/planning-artifacts/architecture.md`](../../planning/planning-artifacts/architecture.md),
which wins on conflict. *(Noted 2026-09-01 — that planning document has not been re-validated
against the tree for several passes and is stale in places; the code-verified reference set is
[`../README.md`](../README.md) and the disagreements are listed in
[`../validation/2026-09-01-doc-validation.md`](../validation/2026-09-01-doc-validation.md).
Where `architecture.md` and the code disagree, the code wins.)*

*Updated 2026-09-02 for ruling 127 (branch `claude/per-user-codex-auth-difdnn`): ruling 127 is
recorded below, the route map gains `/resources/backend-login`, and rulings 49, 84 and 107 carry
dated correction notes where their text described the deployment-wide backend credentials or the
shared runtime homes as current.*

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
  schemas/         # shared Zod schemas (task-file, project-file, goal-file, sse-event, github-pat, file-diagnostics)
  server/          # server-only modules
  shared/          # narrow cross-surface helpers
db/migrations/*.sql   scripts/*.ts   e2e/   test-support/
```

The live folder inventory is in
[`architecture.md`'s directory structure](../../planning/planning-artifacts/architecture.md#complete-project-directory-structure);
it is regenerated from the filesystem rather than restated here. *(Noted 2026-09-01 — that
inventory is not regenerated automatically and has drifted; the verified module map is
[`codebase-map.md`](codebase-map.md).)*

- Server-only files: `*.server.ts` suffix. Never import server modules into client
  components. *(Clarified 2026-09-01 — a client component may import a `.server` module as
  `import type` only; server code may import `features/*.server.ts` modules and pure catalog
  helpers, never components. See [`overview.md`](overview.md#3-layers-and-the-rules-between-them).)*
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
- **SSE:** event names are lowercase dot-separated facts (`task.updated`, `task.removed`,
  `project.updated`, `projection.rebuilt`, `run.log-appended`, `run.state-changed`,
  `notification.created`, `goal.updated`, …); the complete list is `SSE_EVENT_NAMES` in
  `app/schemas/sse-event.schema.ts`. *(Corrected 2026-09-01 — this bullet listed
  `task.readiness-changed`, removed in E9, and `auth.session-expired`, which never existed.)*
  Payload is `{ type, entityId, occurredAt, data }` — compact
  facts and references, never fat objects. The wire shape is parsed before publish because
  it is a contract.
- **Errors:** typed `AppError` with stable machine codes (`app/server/errors/`). Never leak
  stack traces or secrets to users. *(Corrected 2026-09-01 — the "user-correctable /
  inconsistency-diagnostic / infrastructure" three-way taxonomy this bullet used to ask for
  was never modelled on `AppError`, which carries `code`, `status`, `userMessage` and
  `details` only; the nearest real thing is the file-diagnostic severity `info | warning |
  error` plus `hardStop`, which floors readiness.)*

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
  **Narrowed** — see ruling 40 and the note under FR27 in the PRD: an operator whose
  project autonomy is `full` **and** whose grant is literally `completion-for-acceptance:
  direct` may accept and move a task to Done itself, recording the PR as `accepted` (merge
  pending). That is the one deliberate exception, and it is disclosed in the UI. Every other
  path to Done stays human. *(Corrected 2026-09-01 — this used to say "under the `auto`
  preset"; `auto` is a transition-boundary value, not a preset, and the capability is
  `promotable: false`, so autonomy alone never raises it — `operatorAcceptCompletion` in
  `app/server/tasks/operator-actions.server.ts`.)*

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
   **Corrected 2026-09-01** — two clauses above are stale: (a) the schema does **not**
   tolerate an org role `viewer` — `users.role CHECK (role IN ('admin','member'))` and
   `USER_ROLES = ["admin","member"]`; (b) capability modes are four,
   `direct | recommend | human | off` (`CAPABILITY_MODES`), and ruling 81 removed the
   `recommend` lane for specialists (a stored `recommend` reads as `off`); only the operator
   holds a real `recommend`.
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
   **Extended** — the kind set is now ELEVEN: `accept_completion`, `request_edit`,
   `block_on_policy`, `hold_runtime_debug`, `redirect`, `retry_other_backend`, `edit_goal`,
   `archive_task`, `discard_branch`, `resolve_remote_collision`, `custom`. **Note 2026-09-04
   (ruling 130, pass 34)** — the set is unchanged: `block_on_policy` stays the re-run kind; only
   its labels and its recorded decision changed (they now state what the human asserted). (`archive_task` arrived with R14-3 — the task
   archive — and the count here was never updated; corrected 2026-08-05 against
   `PACKET_OPTION_KINDS` in `app/schemas/task-file.schema.ts`, which is the source of
   truth. `discard_branch` arrived 2026-08-15, pass 20 — ruling 77 / R20-2 / F20-6 — as the
   executable option that deletes a never-pushed local task branch; count nine→ten.
   `resolve_remote_collision` arrived 2026-08-31, pass 31 — F31-6 — as the branch-collision
   remedy: close the unowned PR, delete the stale remote branch, re-deliver the local work;
   count ten→eleven, corrected here 2026-09-01. `PACKET_OPTION_KINDS` is the source of truth
   and `file-formats-sync.test.ts` pins the sibling list in `file-formats.md`; this prose is
   not pinned, so trust the schema over any number here.) The same
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
    **Corrected 2026-09-01** — R8-3 reached the queue too: the row set is project-wide, but
    `review-queue.server.ts` splits it per viewer into "Waiting on your acceptance" (tasks this
    viewer may accept) and "Still in review", and the board chip reads "Waiting on me".
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
    **Superseded in part** (ruling 24 and pass 31, noted 2026-09-01) — remote deletion is no
    longer packet-only: `deleteTaskRemoteBranch` is one function with the same two refusals and
    three callers — this recovery packet, the post-merge cleanup under the per-project
    `delete-branch-after-merge` guardrail (ruling 24), and the `resolve_remote_collision` packet
    option (F31-6).
18. **Minimum GitHub scopes are exactly `repo` + `pull_request:write`** (2026-07-25,
    recorded 2026-07-28). `workflow` and `read:org` were dropped; a refused workflow-file
    push surfaces as a scope violation when it matters. Fine-grained tokens prove write
    permissions via empty-payload dry-run probes (422 = authorized, 403 = refused).
    **Amended** (A8 / pass 16, noted here 2026-09-01) — the dry-run is now **opt-in**
    (`VIBERR_GITHUB_WRITE_PROBE=1`, or `writeProbe: true`); default validation never writes to
    a user repository. Repository write is proven read-only from `GET /repos/{r}`
    `permissions.push`; without the probe, `pull_request:write` is reported `assumed` until
    first use. `read:org` is still honoured when a project requires it but is not a default.
    *(Amended 2026-09-04, pass 34, ruling 144: the promise that "a refused workflow-file push
    surfaces as a scope violation" is now implemented, with a classic-token advisory at attach
    time and a refusal before the push when the token is known to lack `workflow`; the scope is
    still not required.)*
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
    *(Noted 2026-09-01 — `planning/README.md` no longer makes a "kept in sync" claim; it
    narrates the drift history and names canon as the winner. The pin is the test, not a
    README sentence.)*
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
    **Narrowed by ruling 35** (noted 2026-09-01): the one adoption case — an OPEN PR whose head
    sha IS the delivered revision — is adopted; every other name match stays a collision.
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
    **Amended by ruling 91** (noted 2026-09-01): `input_required` matches only while
    `waiting !== "agent"`; the chip label is unchanged.
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
    *(Noted 2026-09-01 — both quickstarts were folded into `docs/development/` (`testing.md`,
    `contributing.md`) on that date; the premise correction above is history.)*
42. **R17-1 (2026-08-04): acceptance may accept a head AHEAD of the reviewed revision, but
    MUST surface the divergence.** The accept gate stays containment-based — it accepts a PR
    head that CONTAINS (is ahead of) the delivered/reviewed revision, because a legitimate
    auto-commit on top of the delivery is fine there. Honesty over blocking: the accept dialog
    AND the admin force-accept dialog must show the ACTUAL merge head and a divergence warning
    ("N commits added since review"), and the refusal/subline chain must name the divergence;
    the audit log names the real merge head, not the reviewed SHA. A head that has DIVERGED
    (no longer contains the delivered commit) still refuses, unchanged. (Owner ruling gathered
    pass 17.) *(Corrected 2026-09-01 — the parenthetical that used to end this entry, "the
    surfacing is on this pass's implementation backlog — the gate today pins only the delivered
    SHA", is stale: the divergence surfacing shipped (F17-L12) and the gate is containment-based
    — `accept-confirm.tsx` "N commits added since review", `task-actions.server.ts`.)*
    *(Amended 2026-09-04, pass 34, ruling 132: the drift R17-1 discloses is now the number of
    AUTHORED commits since the reviewed revision, with a base refresh reported apart; "N commits
    added since review" became the classified sentence `describeRevisionDrift` prints, and only
    authored commits are called unreviewed.)*
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
    is itself a required closing phase, alongside the disposition audit. *(Noted 2026-09-01 —
    `docs/testing.md` became `docs/development/testing.md`, and the re-read now covers the whole
    `docs/` set indexed by `docs/README.md`.)*

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
    *(Amended 2026-09-04, pass 34, ruling 134(b): "only a NEWLY opened PR fires it" became "a newly
    opened PR, or a head the push moved", and the deliver tool no longer no-ops on a live PR; a
    reuse whose push moved nothing (`up_to_date`) still re-queues nothing, which is what keeps the
    loop this ruling guarded against from starting.)*

49. **R18-3 (2026-08-05): the SDK-native skill/command catalog is governed OUT of runs.** A
    spawned agent run loads ONLY Viberr's granted skills. The per-task workspace clone's own
    `.claude` catalog is stripped before the run (git-invisibly, via `--skip-worktree` so the
    delivery's `git add -A` never ships a `.claude` deletion into the review PR), and the Claude
    launch carries `strictMcpConfig: true` so only Viberr-passed MCP servers reach the run. The
    user-level catalog is already isolated in production by the app-owned `CLAUDE_CONFIG_DIR`;
    Codex was already governed by `CODEX_HOME` + its skills/plugins/AGENTS.md flags. Known,
    accepted limitation: a run whose task is to edit the repo's OWN `.claude` cannot deliver those
    edits — that is the governance posture, not a bug.
    (`stripUngovernedRepoCatalog` in `app/server/runtimes/skill-mount.server.ts` — moved there
    from `specialist-run.server.ts`, path corrected 2026-09-01;
    `app/server/runtimes/claude-runtime.server.ts`)
    *(Corrected 2026-09-02, ruling 127 — the isolation stands but its owner changed. There is
    no app-owned deployment-wide `CLAUDE_CONFIG_DIR` or `CODEX_HOME` any more: a run's child
    gets the CREDENTIAL PRINCIPAL's own home,
    `<dataRoot>/runtimes/users/<userId>/{claude-home,codex-home}`, from `runCredentialFor`
    (`backend-credentials.server.ts`). The user-level catalog the host account carries is still
    never reachable, and the Codex flags are unchanged; what the catalog is isolated from is now
    one person's runtime home rather than one instance's.)*

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
    initialise a new profile with empty grants (`create-profile-modal.tsx`, the
    `{ skills: [], mcps: [], kb: [] }` initial state; `agent-template-modal.tsx`, `initial ? … : []`
    — line numbers dropped 2026-09-01, they had moved). No default was changed — acting on the note would have
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
    Q19-1, extends F19-4. (the `OperatorWorkspaceView` type and its resolver in
    `app/server/runtimes/operator-run.server.ts` — identifier corrected 2026-09-01)
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
    by name* — never silently resolved in either direction — so a human can reconcile it; and an existing file family is never rewritten into
    a KB's style just because the KB describes one. It ships as ONE constant emitted
    immediately before the KB bodies it ranks, imported by both runtimes so it cannot drift
    between them, and emitted only when real KB text is present — a run with no knowledge base
    never carries a rule about a resource it does not have. Closes Q19-2.
    (`KB_PRECEDENCE_NOTE` in `app/server/files/kb-injection.server.ts`)
    *(Corrected 2026-09-01 — "surfaced as a typed context-conflict event" was removed above:
    there is no dedicated event type. A specialist reports the conflict in its report; the
    operator has a `flag_context_conflict` tool that writes a `quality` timeline event (audit
    `task.operator.context_conflict`). Three runtimes import the constant now, not two.)*

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
    (`recordDeliveredNextStep` in `app/server/tasks/task-actions.server.ts`, called from
    `performDelivery` in the same file — corrected 2026-09-01: `ensureDeliveredNextStep` in
    `operator-actions.server.ts` was deleted because two order-dependent writers after a
    delivery were the hazard; the single writer of the card carries the guarantee now)

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
    **Extended 2026-09-04 (ruling 130(c), pass 34 F34-12)** — the stock re-run option is titled
    "Re-run the operator now" and records "re-run the operator. No policy or credential was
    changed."; a FAILED run's packet takes its options from `describeRunFailure` (the recommended
    one asserts only what the human says: the window has reset or the account was switched, a
    different account or an API key was connected); the recorded decision is the option's `ev` or
    its own title, never a fixed "policy / credential updated"; the toast says "Unblocked".
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
    **Amended** (pass 28 F28-L1 and pass 31 F31-6, noted 2026-09-01) — the auto-detect became
    reachable in F28-L1; `discard_branch` is now REFUSED for authoring when work already stands
    on the branch; the eleventh kind `resolve_remote_collision` handles the remote side (see
    rulings 7 and 17). "Ruling 7's tenth" is historical.

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
    **Superseded in part** (owner, 2026-08-21, pass 22 — noted here 2026-09-01): the seeded
    Developer now defaults to **Claude** (`backends: ["claude", "codex"]`, `model: sonnet`);
    `gpt-5.6-terra` survives only as the Codex catalog default a profile falls to when flipped
    to Codex. The demo fixture (`seed:demo`) still forces its Developer to Codex
    `gpt-5.6-terra`.

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
    *(Corrected 2026-09-02, ruling 127 — that R21-1 step is now HISTORY, not a fallback anybody
    can repeat: there is no shared `runtimes/codex-home` to copy an `auth.json` into, no
    `/host-codex` mount and no entrypoint that seeds one. A person signs Codex in for themselves
    on Profile → Agent accounts and the vendor binary writes the credential into
    `runtimes/users/<userId>/codex-home/`. Left in place because the paragraph is about why an
    operational step was never promoted to a ruling, which is still the point it makes.)*
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
    **Superseded in part by ruling 98** (noted 2026-09-01): dynamic dispatch replaced the
    steer-only run control with the when-picker and schedule controls; the label rule stands.

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
    **SUPERSEDED IN PART by ruling 101** (repo-write parity, 2026-08-31 — marked here
    2026-09-01). The headline no longer holds: `resolveCodexSandboxMode` returns `read-only`
    for the operator and for any run whose repo write is withheld (`workspace-write` when it
    has an attachments dir to write), and `execute-code-or-write-repo` is back in the
    both-backend `ENFORCED_CAPABILITY_IDS`. Surviving from this ruling: the `danger-full-access`
    rule for an autonomous deliverer with egress, egress gated on both backends, and the
    writable attachments dir. **Open code drift:** the capability-matrix modal copy
    (`capability-matrix-modal.tsx`, "On Codex the file and command limits are advisory",
    "advisory on Codex") still describes the R22 posture and should be rewritten to match 101.

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
    no-duplicate-summary, compression-threshold) keep their code and defaults.
    One accepted interaction: the no-duplicate check compares stored text
    byte-for-byte, and without the cap two long near-identical narrations no
    longer collapse to an identical trimmed prefix — the one-nudge stranded
    hold (`heldAtStage`, pass 31) is the guard against repeat-narration loops.
    The @mention fan-out now scans the PRE-trim text on the operator and
    agent-reply paths (B-FD8b, made true by this ruling's review), and the
    ambiguity-disclosure append balances an unclosed ``` fence — the one job
    the old truncation did that had to survive it.

105. **Browser working artifacts are not deliverables; text attachments get an
    in-app viewer (owner, 2026-08-31).** The browser MCP's `--output-dir` IS the
    task attachments store, so its machine-stamped working files — `page-*.yml`
    aria snapshots, `console-*.log` dumps — were posted to humans next to the
    screenshots and drowned the panel (VIB-1: ~20 artifacts around 2 deliberate
    captures). At run completion the machine-stamped non-visual artifacts the run
    produced are DELETED unless the exact filename is cited in the reply, the
    evidence rows, or the timeline since run start (the persona's cite-the-exact-
    filename contract is how an agent marks a file for humans); screenshots, PDFs,
    and deliberately named files always stay, and the persona discloses the
    cleanup. Posted text files (txt/log/md/json/yml/yaml/csv) open in the same
    in-app popup as images — a read-only monospace viewer with a Download button
    (`?download=1` forces the save dialog). Pre-existing artifacts in old tasks
    are left in place.
    **Addendum (owner, same day): the Download button is universal.** Every
    attachment kind opens the card and carries Download — images show the
    picture (previously the lightbox offered only "Open original"), text files
    the reader, and any other kind (archives, binaries, PDFs) a no-preview
    note; "no in-app preview" is the honest phrasing, since the route serves
    PDFs inline and "Open original" may still render one. The lightbox factory
    therefore intercepts every plain click; modified clicks and provider-less
    renders still fall through to the real anchor, and the markdown renderer
    intercepts only clean single-segment names under the attachments base
    (an author-written URL with a query/fragment/nested path stays a plain
    anchor). The no-preview card probes the file once, and any body whose
    fetch PROVED the file unservable (404 after the prune, 413 over the 50 MB
    cap, auth redirect) reports the failure and drops Download — some browsers
    save a failed download's error body as a file bearing the real name.

106. **Controller settings speak the agent-editor language, and stay admin-only
    (owner, 2026-09-01).** The org-settings Controller tab had grown its own
    dialect: a free-text model field (any typo silently ran the default via
    `resolveRunModel`), checkbox `<ul>` grant lists, no effort control at all
    (the run honored `config.effort`, but nothing in the app could set it),
    and bespoke `ctladm-*` styling. The owner ruled it must match agent
    settings both visually and functionally. It now uses the profile modal's
    own model/effort catalog pickers (`ModelEffortFields` plus the
    `useModelCatalog` hook extracted from it — one mechanism, both editors),
    with the backend fixed to Claude because that is what controller runs
    resolve; a stored model seeds to the catalog default ONLY when a run
    would itself substitute it — a dated `claude-*` id or family alias the
    served catalog does not list runs verbatim (`isKnownModel`'s static
    half, now shared as `~/shared/model-ids`), so the picker preserves it
    instead of silently repinning the model on the next save (this review's
    D1, which also fixed the same latent rewrite in the profile modal).
    Grants are pick-chip toggles like the global-profile editor's: KBs
    displayed by name and stored by dir, with the editor's own
    `kbDirsOf` display-name repair on open (P13-KM-01), and a grant the
    store lost renders through the shared `MissingChips` — a removable red
    chip instead of an unremovable "not in the store" row (P14-KM-10).
    `effort` parses tolerantly (a hand-edited non-string value reads as
    absent, never failing the whole profile — this review's D2, which
    otherwise bricked the config as "profile missing from the store" with
    no in-app repair). `effort` became a schema-level agent-profile
    frontmatter key (carrying it is no longer drift); `controller-save`
    persists it, and blank removes the key. Access was re-verified admin-only
    end to end — `/org/settings` loader and action `requireRole(admin)`
    (members 403, route-tested), and every nav entry into the tab is
    admin-gated — matching the panel's own copy. One deliberate consequence:
    opening the panel now shows the default model/effort where the stored
    value was blank, so the first save makes them explicit.

107. **The controller has a built-in diagnostics MCP, and no one can take it
    away (owner, 2026-09-01).** The `viberr_controller` toolkit (ruling 99)
    reads and changes the PRODUCT, and had zero reach into the ops layer that
    already sits behind routes: per-run logs, subsystem health, backend
    credential state, the run concurrency queue, store documents. Asked "why
    did that run fail" or "is this instance healthy" the controller could only
    guess or point at a page. `viberr_ops` is an in-process, READ-ONLY server
    with three tools, each resolving the ASKING PERSON's authority live, per
    call, and refusing in the toolkit's own voice:
    `instance_health` (the READING is open to anyone: what `/resources/health`
    serves unauthenticated, availability per backend, and the cap/live/queued
    concurrency snapshot, three load integers carrying no name or project. The
    credential DETAIL is org-admin only, because `backendCredentialHealth`
    explains an unusable credential by naming the config directory it looked in
    and what to set instead: that is deployment configuration, and this review
    found a member of no project reading a host path through an ungated tool),
    *(Corrected 2026-09-02, ruling 127 — the org-admin credential-detail arm is
    DELETED, not narrowed. `backendCredentialHealth` is gone with the
    instance-level credential it described, so there is no host path left for a
    tool to leak: `instance_health` now reports, per backend, `connectedUsers`
    (how many people have connected it) and `askerConnected` (whether the person
    asking has), both open to anyone, because a count of colleagues and a fact
    about yourself name no deployment configuration. A person who is not
    connected is told to connect it on their own Profile → Agent accounts, which
    is an in-app remedy rather than a config directory.)*
    `read_run_log` (a member of the run's project; a controller turn's log
    follows conversation ownership with org-admin supervision, via
    `canReadControllerRunLog` — the exact gate `/resources/run-log` applies,
    and a missing run, a forbidden project and a forbidden conversation all
    answer one not-visible sentence so a probe cannot walk run ids), and
    `read_store_doc` (org admins only, like the store browser it comes from,
    reporting `truncated` honestly). Nothing here writes, deletes or starts
    anything: diagnostics that could change the instance would be a second
    authority surface beside the toolkit, which is where changes are audited.
    **Every page is bounded and says where it sits.** `read_run_log` defaults to
    the NEWEST 200 lines (500 max) on BOTH directions, refuses `since` together
    with `before` instead of silently letting one win, and reports
    `page.{firstSeq,lastSeq,olderExist,newerExist,next}` computed against the
    run's real bounds plus `run.logLines` — never `getRunLog`'s headSeq /
    oldestSeq / hasMore, which are page-local cursors for a stateful console
    that a model with no second source reads as facts about the run. The route
    can afford an unbounded `since=-1` default because its caller holds a live
    cursor; a model holds none, and the measured cost of that default was a
    2.5 MB reply on a 1,500-line run.
    NOT REMOVABLE BY CONSTRUCTION, not by a guard: `buildControllerMounts`
    attaches it on every turn with no config read and no grant row, so there is
    nothing to clear and no toggle that could do nothing (P14-KM-14). The
    reserved names live in ONE list (`~/shared/mcp-reserved`) that the writer,
    the picker AND the run-time resolver all read: the resolver kept a private
    copy that never learned the controller's servers, so a row reaching the
    registry any way but `saveMcpServer` (hand-written, restored backup, created
    before the name was reserved) resolved and, because org servers mount LAST,
    replaced the built-in diagnostics under their own key. The Controller
    settings MCP group discloses it
    as a pinned chip that is deliberately NOT a control (a disabled button
    would be the toggle-with-no-effect this ruling avoids, and its `title`
    would never open), and it never enters the save payload or `mountedMcps`.
    Scope is CONTROLLER-ONLY: agents and the operator are untouched. The health
    body assembly moved to `~/server/ops/health-snapshot.server` and the
    controller's refusal machinery to `~/server/controller/controller-tool-guards.server`,
    so route and tool read one derivation and both in-process servers refuse in
    one voice.

108. **The controller's configuration is deployment-locked by default (owner,
    2026-09-01).** Which skills, knowledge bases and org MCP servers the
    controller loads, and its instructions, are locked out of in-app editing
    for EVERYONE, org admins included: they are a deployment decision. Four
    environment variables unlock one section each at deploy time
    (`VIBERR_UNLOCK_CONTROLLER_SKILLS` / `_KB` / `_MCPS` / `_INSTRUCTIONS`,
    set to `enabled` to unlock; `disabled`, any other value, or unset keeps it
    locked; restart to apply; documented in `.env.example`, `compose.yml` and
    the env schema); the default is locked, and there is no in-app override
    anywhere — that is
    the point. Enforcement is server-side in `saveControllerConfig`
    (`controllerSectionLocks` reads the env; a change to a locked section is
    refused with the section and its unlock variable named, while an
    identical round-trip passes so model and effort stay editable — those two
    are deliberately not sections: picking the tier is day-to-day admin work,
    rewriting what the controller IS operates above the org). The settings
    panel renders locked sections read-only (span chips, read-only doctrine,
    one note listing the locked sections and their variables), and under a
    lock it posts BLANK for the locked sections so the server keeps the stored
    grants byte-for-byte *(wording corrected 2026-09-01 — the P13-KM-01
    display-name repair still runs for display; the byte-stable round-trip
    comes from not posting the locked lists, not from skipping the repair)*. The `viberr_ops` mount is
    unaffected: it is not a section and stays non-removable under every flag
    combination (ruling 107). A dangling grant under a lock is still
    disclosed, just not removable in-app.
    **Scope (owner, narrow reading, 2026-09-01):** the lock covers the
    controller SETTINGS tab — the grant lists and the doctrine file edited
    there. It is deliberately NOT airtight: deleting or renaming a resource on
    the Agent resources tab still prunes the controller's grant (the shared
    `resource-references` rewrite), and editing a granted skill's or KB's file
    contents still changes what the controller loads as trusted context. Those
    side doors were left open by owner decision, in favor of not freezing
    org-resource management around whatever the controller happens to grant;
    the panel note and this entry state the boundary rather than imply a
    containment the ruling does not provide.

109. **Codex parity is a read-only workspace plus a writable attachments dir — and the
    pinned SDK cannot express it (owner, 2026-09-01; verified and shipped 2026-09-02).
    Amends ruling 101(c).** The owner ruled the disclosed carve-out closed with a real
    sandbox rather than a disclosure: a write-withheld Codex run gets
    `sandboxMode: read-only` with ONLY the task's `attachments/` writable — conditional
    on the Codex SDK supporting read-only together with additional writable
    directories, and falling back to honest "advisory on Codex" labeling on every
    surface if it cannot. **It cannot.** Verified against the pinned Codex 0.146
    sources: `SandboxPolicy::ReadOnly`'s `get_writable_roots_with_cwd()` returns an
    empty list, and `--add-dir` ("Additional directories that should be writable
    alongside the primary workspace") only widens `workspace-write` —
    `additional_writable_roots` is folded into `workspace_roots`, the legacy read-only
    profile carries no write entries, and the `codex sandbox` subcommand takes no
    `--add-dir` at all. The SDK's `additionalDirectories` maps 1:1 to `--add-dir`. A
    live `codex exec` probe was impossible (provider quota blocked until Sep 18 2026),
    so the verification is source-level on the exact pinned version and is recorded as
    such rather than as a runtime proof.
    The ruling's stated fallback therefore shipped. The carve-out stays in
    `resolveCodexSandboxMode`, and `codexRepoWriteAdvisory(grants)`
    (`app/server/tasks/specialist-tool-policy.ts`) names exactly its shape — the
    headline write family withheld AND `attach-evidence-references` granted; an EMPTY
    grant list runs fully withheld and is deliberately NOT tagged, matching
    `withheldAgentGrants()` — so every surface that renders the enforcement says
    "advisory on Codex": the profile editor row, the capability-matrix row (naming the
    profiles it applies to), the agent card's withheld bucket, and the run console's
    `sandbox` inputs row (`RunInputs.sandbox`, filled by `describeCodexSandbox`).
    Claude binds regardless through the tool denylist, so the label is a Codex-only
    statement, not a weakening of ruling 101(a).

110. **`resolve_remote_collision` is a full ceremony in a fixed order, and a resolved
    collision never strands (owner, 2026-09-01).** The remedy has three steps and the
    order is load-bearing: **delete the stale remote ref FIRST**, then close the
    unowned PR, then re-deliver. The old order closed someone else's PR and, when the
    ref delete then refused (default branch, own PR open on it, a non-422 answer),
    reported "the branch collision was not cleared … nothing was re-delivered" — true
    words about an operation that had already closed a PR. Deleting the head ref first
    means a refusal leaves GitHub exactly as it was, and a deleted head branch closes
    its PR on GitHub's side anyway, so the explicit close is the audited record of an
    outcome the delete already produced (`github.pr.closed_unowned`). A **403** on that
    close is the same fact `openTaskPr` and `mergeTaskPr` flag — the credential lacks
    `pull_request:write` — so it opens a scope violation instead of vanishing into
    best-effort silence. The whole remedy refuses without an acting user rather than
    asserting one: closing a third party's PR is a human decision.
    **And it never strands.** `resolve_remote_collision` stays in `NO_REQUEUE`, but the
    re-delivery it owns now actually records the follow-up: under **full** autonomy
    `performDelivery` re-queues the operator for the newly opened PR, and under
    **supervised** autonomy the server-attributed "Move to \<review\>" card is recorded
    here, exactly the one an operator-authorized delivery would have written (R18-2 /
    R19-4 left that half owned by nobody; live on VIB-1 the task sat at In Progress,
    `waiting: human`, with an open PR and nothing to click). Housekeeping recorded with
    the ruling: the stale task-key branches earlier instances left on the origin were
    deleted during pass 32; **`vib-5` is kept deliberately as the collision fixture.**
    *(Amended 2026-09-04, pass 34, ruling 136: "it never strands" is now carried by the ceremony's
    own single hand-off rather than by the re-delivery's follow-up alone; a refusal whose PR is the
    task's own open review PR performs the push instead of keeping the block; and the delete
    re-confirms a cached open PR against GitHub before refusing.)*

111. **Every `viberr_ops` read is audited (owner, 2026-09-02).** The three read-only
    diagnostics tools of ruling 107 (`instance_health`, `read_run_log`,
    `read_store_doc`) previously audited only their refusals, which made them the first
    tools that let a MODEL enumerate store documents and run logs on a person's behalf
    with no record of a successful read. Each successful call now writes exactly ONE
    `controller.ops.read` audit row naming the tool, the target id and the asking user
    (the same `"<email> · via controller"` binding every other controller mutation
    carries). One row per call — the cost is a row, and the record is the only trace
    that a model read a document for someone.

112. **The anti-noise guardrails get a surface (owner, 2026-09-02).** The four
    surviving guardrails (`meaningful-comment`, `evidence-separation`,
    `no-duplicate-summary`, `compression-threshold`) are framed by the PRD and by
    ruling 15's project model as per-project knobs, but the only way to change one was
    a hand edit of `project.md`. They get a **Guardrails card under Policy**: a toggle
    per guardrail, a number field for the compression threshold, an audit row on every
    change, and retired or unknown rows (the inert pre-104 `operator-brevity` row, for
    instance) shown inert and removable rather than hidden. Ruled 2026-09-02; landed
    in pass 32 cluster E: one row per `guardrails` entry — a toggle for an enforced row,
    a number field for the one carrying a `unit`, inert rows for what the card does not
    own (the `delete-branch-after-merge` row stays on Settings → GitHub and is refused
    here, one fact one editor; a retired/unknown id reads "nothing reads this" and is
    removable). An enforced row the file lacks renders OFF with "not in project.md" and
    turning it on writes the shipped row. `edit-policy` tier, audited as
    `project.policy.guardrail_changed` (before/after in the details), reprojected, and
    rendered as a sentence in the Activity audit panel. A number written onto a row the
    file lacks keeps that row OFF and the toast says so — a value never toggles a
    guardrail (owner, 2026-09-02). (`setGuardrail` in
    `app/features/policy/policy-actions.server.ts`, `Guardrails` in `policy-page.tsx`.)

113. **ONE UI vocabulary for capability modes (owner, 2026-09-02).** The same stored
    mode was rendered three ways — "Allowed" on the project profile editor's radios,
    "ACTS DIRECTLY" on the agent card, "direct" in the policy summary counts — so a
    reader could not tell whether they were looking at one concept or three. Every
    surface renders the four modes as **"Acts directly · Recommends only · Human-only ·
    Off"**; the file and schema ids (`direct | recommend | human | off`) are unchanged,
    because they are cited by code and stored in `project.md`. Ruled 2026-09-02;
    implementation lands in the pass-32 cluster E work.

114. **The board owner cell keeps its two labels (owner, 2026-09-02).** An unowned task
    reads "unassigned" at the entry stage and "awaiting owner" once work has started.
    Raised as a copy inconsistency (one unowned state, two words); the owner ruled the
    two labels intended — the second says something the first does not, namely that
    work is moving with nobody accountable for it. DECIDED-NO-CHANGE, recorded so the
    next pass does not re-file it.

115. **`accept_completion` is refused at packet AUTHORING off the acceptance boundary
    (owner, 2026-09-02).** An operator could author a decision packet offering
    "accept completion" on a task nowhere near the acceptance boundary, and the option
    then failed at resolution time in front of the human who chose it. Authoring now
    refuses the option unless the task sits AT the acceptance boundary with a healthy
    validation — the same shape as ruling 77's `discard_branch` authoring refusal — and
    the refusal tells the operator to offer archive or edit-goal instead. Humans keep
    force-accept, which is the deliberate, audited bypass and is unaffected.
    (`operatorOpenPacket` in `app/server/tasks/operator-actions.server.ts`.)

116. **No per-run HOME/XDG cache for Claude runs; the sharing is a disclosed residual
    (owner, 2026-09-02, C32-1).** Runs share the container user's
    `~/.cache/claude-cli-nodejs`, so a reviewer run located and read the deliverer
    run's `mcp-logs-<server>/*.jsonl` through a plain `find /`. The owner ruled against
    a per-run HOME: the cache is shared across the runs of ONE instance, that is the
    isolation boundary the product already claims (P8 isolates workspaces, not the
    provider CLI's cache), and the real requirement is upstream — **MCP servers must
    not log secrets**, the same rule the credential-less Codex MCP mount already applies
    to their argv. Recorded as a residual so it is not re-discovered as a defect.

117. **The number 117 was never used (recorded 2026-09-03).** Pass 33's canon re-read found
    this file running 1–116 and then resuming at 118, with no `ruling 117` cited anywhere in
    the tree — no dangling code comment, and nothing lost. The pass-32 promotion simply
    skipped a number. Ruling numbers are stable and never reused, so the hole is recorded
    here rather than closed by renumbering 118–121, which code comments cite by number
    (owner, 2026-09-03: "record the gap as intentional"). If you are looking for ruling 117,
    stop: there is nothing to find.

## Owner decisions recorded outside this file (2026-08-20 → 2026-09-01)

*(Added 2026-09-01 by the documentation validation pass. Each item below is an owner decision
that code comments or pass ledgers cite and that this file never received. They are listed
here so a reader can find them; promoting each to a numbered ruling is the owner's call —
ruling 44 says every one should be. Where recorded today is named per item.)*

1. **Web egress is ON by default** (2026-08-22, pass 23). `GRANT_REQUIRED_CAPABILITY_IDS` is
   the single source of "withheld when absent"; `use-web-search-fetch` is not in it, so an
   absent grant leaves egress on. `app/shared/capabilities.ts`; pass-23 FINDINGS.
2. **Codex operator: scratch-dir cwd and egress honoured** (2026-08-22, pass 24 Q1/Q2). The
   Codex operator's writable root is an empty `.operator-scratch` beside `task.md`; its web
   search follows `use-web-search-fetch`. `operator-run.server.ts`; pass-24 QUESTIONS.
3. **`read-github-api` capability** (owner ruling "F4", 2026-08-21). A read-only,
   authenticated GitHub read for Claude specialists, default off, server-made requests so the
   PAT never reaches the agent. `app/server/github/agent-github-read.server.ts`. Mentioned
   here only as a precedent inside ruling 99(d).
4. **Seeded Developer defaults to Claude** (2026-08-21). `agent-catalog.server.ts`; see the
   note under ruling 83.
5. **Model unavailability is shown at the run control before a run is spent** (2026-08-21).
   `specialist-run.server.ts` `listDeployedSpecialists`. Extension of ruling 78.
6. **P8 full per-engagement workspace isolation; B2 backend-quota pre-run signal left as-is**
   (2026-08-23, pass 25). Ruling 101(b) leans on "P8 isolation" as if recorded.
7. **Pass 26** (2026-08-24): R26-1 task metadata (priority, labels, due date) reaches the
   operator only, advisory, never the specialist prompt; R26-2 labels searchable on the board
   and in ⌘K plus a board label filter; R26-3 "Completion rate" label; same change: the
   run-concurrency cap (`maxConcurrentRuns`), S3 audit push, the org audit browse and
   `/org/settings/audit-export`.
8. **Pass 27** (2026-08-24): task keys stay letters-only (2–4); metadata nudges stay advisory;
   **F27-B1 a retry-on-other-backend switch STICKS** (`engagements[].pinnedBackend` — an
   exception to ruling 97's live-backend law); F27-U1 clone progress indicator; capability-
   matrix repo-write honesty.
9. **F28-A1** (2026-08-26): implicit OAuth account linking no longer trusts github/google for
   unverified emails (`trustedProviders`); closes an account-takeover hole once OAuth is on.
   Security-relevant amendment to ruling 72. Same pass: F28-L1 made ruling 77's auto-detect
   reachable.
10. **Pass 29** (2026-08-27): R29-1 operator proactivity is intended (no throttle on the
    multi-run cascade); **R29-2 the seeded Developer ships `use-browser: direct` with an
    explicit `use-web-search-fetch: direct`** (amends the "default off" story of rulings 75
    and 95 for the built-in profile); R29-3 Codex disclosures key on backend, not identity;
    R29-4 keep the matrix "Reserved for humans" label; `/insights` shipped.
11. **R7-4 rework routing** (made visible 2026-08-27): the operator may move failing work
    BACKWARD directly (`rework: true` when validation is failing); the snapshot lists
    `reworkTargets`. Cited in code and pass-14/17 planning; no entry here.
12. **Pass 31** (2026-08-31): F31-6 `resolve_remote_collision` packet kind and the
    `discard_branch` authoring refusal (amends 17, 50, 77); F31-11 the stranded-resume backstop
    is ONE nudge, then a deliberate `heldAtStage` hold (referenced in passing inside ruling
    104); C5 per-row tolerant packet-option parsing (supersedes the F20-6 whole-packet arm).
13. **Owner ruling "A8"**: the Codex idle timeout is an inactivity timeout, default 15 min
    (`VIBERR_CODEX_IDLE_TIMEOUT_MS`); cited as an owner ruling in `codex-runtime.server.ts` and
    `task-activity.server.ts`.

118. **A closed task's owner seat is frozen for contributors and maintainers; a project
    admin may reassign it for the record (owner, 2026-09-02, E32-9).** A task at the
    terminal stage is closed — every runtime control on its page says so (G9) — and the
    owner's authority (review, acceptance, packet resolution) has nothing left to act on.
    Live, a Done + merged task still offered "Assign me" in both owner cells and the server
    accepted the take. `setOwner` now refuses at the terminal stage unless the actor holds
    `release-any-ownership` (the admin tier that already releases any owner); both panels
    withhold the affordance below that tier. Archived seats stay frozen for everyone
    (D32-16); a task moved back to an open stage takes owners again.

119. **Stream actor refs are keyed by profile, and a projection derivation-version stamp
    self-applies rule changes (owner, 2026-09-02, D32-14).** `task_events.actor_ref` for an
    agent is `agent/<profileId>` — a profile that ran a Codex leg and a Claude leg is ONE
    actor in the Activity filter. Because the boot rescan is a content-hash short-circuit
    and the store has no migrations, `instance_settings.projection.derivationVersion`
    records the rule set the projections were derived under; a stamp behind
    `PROJECTION_DERIVATION_VERSION` forces one full rebuild at boot (withheld when a file
    fails to project, so the next boot retries). Bump the constant for every future change
    to how a projected column is derived.

120. **Global templates carry a required Role; legacy templates explain the empty prefill
    (owner, 2026-09-02, D32-7).** The instance template editor stored the name as the role,
    so every template saved there read as the generic "Agent profile". Role is required, as
    in the project editor; a template whose stored role repeats its name prefills empty
    with an inline hint, so the one-time cost is a typed role, never a mystery grey Save.

121. **The controller dock: the controller is available on every signed-in surface, with
    the context of where the person is standing (owner, 2026-09-02).** Owner ask: "make
    controller available as a helper hover icon across the app; controller gets context
    wherever it is; on a board it does the work on that board; on a task it gathers the
    task.md into context and does the work." Four owner answers (all the recommendations):
    a floating bottom-right button opening a docked, NON-MODAL panel (not a topbar popover,
    not a drawer); the panel reopens the newest thread of the current scope; the toolkit
    gains `update_task`; every user message records the page it was sent from. The pieces:
    **(a) Scope.** A conversation is bound, at creation and forever, to one of three places:
    the instance (`project_slug` and `task_key` null), one board (slug alone) or one task
    (slug + key; `CHECK (task_key IS NULL OR project_slug IS NOT NULL)`). The dock derives
    the scope from the matched routes (`controller-dock-context.ts`): a task page anchors to
    that task, any workspace view binds to that board, everything else is instance scope;
    the two full controller pages and `/login` carry no dock. The dock lists ONE scope's
    threads at a time (a board scope excludes its tasks' threads); the project Controller
    page lists both with a task chip.
    **(b) The context read.** "The controller gets context" is a SERVER read
    (`controller-context.server.ts`), gathered at the start of every turn and labelled as a
    read taken at that instant, placed above the transcript digest and the message: for a
    task, a derived header (stage, next stages with their boundaries, owner, engaged agents,
    PR, open packet) plus the canonical `task.md` VERBATIM, fenced, bounded by
    `TASK_FILE_CONTEXT_CHARS` (24 000) — over budget the head stays whole and the NEWEST
    timeline entries are kept with a marker naming the omitted count; for a board, stages
    with counts, boundaries, members, the open-task table (40 rows / 12 000 chars) and the
    goal chains; for the instance, the projects the person can see. The block never exceeds
    `CONTEXT_BLOCK_CHARS` (32 000). It is a same-turn read, so the doctrine's rule holds by
    construction; every action still runs through a tool, gated live. The doctrine and the
    `controller-guide` skill say so, and were hash-upgraded in place (their outgoing hashes
    are in `PRIOR_SHIPPED_HASHES`); the same rewrite removed the two recorded drifts (the
    non-existent `list_projects`; "a comment mention can start a run").
    **(c) Tool defaults and `update_task`.** On a task-anchored conversation every task
    tool's `taskKey` defaults to the anchored task (`keyOf`, the `slugOf` twin); `whoami`
    reports both bindings. `update_task` edits the goal (`updateTaskGoal`, gated
    `update-goal`) and/or priority, labels, due date (`setTaskMetadata`, gated
    `edit-task-meta`, full replace as the page editor submits) — the same two writers and
    gates the task page uses, each reporting on its own so a metadata write is never hidden
    behind a goal refusal. No title edit (no writer exists); the no-delete and always-human
    invariants are untouched.
    **(d) The surface.** `controller_messages.surface` records the pathname + query the
    person was looking at when they sent a USER message (normalized: an in-app path only,
    400 chars, no control characters); the turn prompt carries it as "They are looking at:
    …" and the full page renders it as a "from Board" chip. Controller rows never carry one.
    **(e) The dock itself** (`controller-dock.tsx`, mounted once in `root.tsx` when the root
    payload carries a csrf token): a 44 px trigger named `Controller · <scope>` with the
    `.live-dot` while a turn works; a `role="dialog" aria-modal="false"` panel
    (`data-screen-label="Controller dock"`) that grows from its trigger
    (`transform-origin: bottom right`, .18s in, .12s out, Escape instant, reduced motion
    fades), no scrim, no focus trap, no scroll lock; the composer takes focus on open and
    the trigger gets it back on close; an outside press does NOT close it; one context line
    says what the controller knows here; Threads / New / Open page / Close in the header;
    open state and the per-scope thread selection survive a reload (`sessionStorage`,
    per tab). Data is a root-owned `fetcher.load` of `/resources/controller` (GET the
    scope's view, POST `send`), which React Router re-runs on every revalidation, so every
    surface streaming the `user` scope refreshes the dock for free; while open the dock
    holds its own `user` stream for the surfaces without one and polls every 5 s while a
    turn works. Under 720 px it is a bottom sheet entering and leaving along the bottom
    edge; the trigger stays on screen (R19-12) above the sheet.
    **(f) Authority.** Unchanged: the asking user's live permissions per tool call, the
    same actor label, the same conversation ownership; the resource route applies the
    members-only 404 (byte-identical to the layout's) and the task route's own 404, and a
    thread from another scope is not found. CSRF failures on the dock AND on both full pages
    now answer the toast-shaped `{ ok:false, error }` (UI-32) instead of a thrown 403 that
    replaced the page with the root boundary.
    (`app/server/controller/controller-context.server.ts`, `controller-conversations.server.ts`,
    `controller-run.server.ts`, `controller-toolkit.server.ts`, `app/routes/resources.controller.ts`,
    `app/features/controller/controller-dock*.ts(x)`, `controller-dock-query.server.ts`,
    `app/root.tsx`, `db/migrations/0001_baseline.sql`; discovery ledger in
    `planning/discovery-2026-09-02-controller-dock/`.)

*(Corrected 2026-09-03, after an adversarial review of the ruling-121 change set — 8
lensed reviewers, every finding refuted by 3 independent skeptics, then a synthesis and a
completeness critic. 36 findings were confirmed and fixed in the same change; four of
them adjust what (a), (e) and (f) above describe, so they are recorded here rather than
by rewriting those paragraphs:*
    *(i) **The dock is off `/profile` and `/notifications`** as well as the two
    controller pages and login. Both render their whole page inside a `showModal()`
    `PageOverlay`, which makes everything outside the dialog inert: the dock painted
    there as a dimmed button that could not be clicked or focused, and a click on it
    reached the overlay's backdrop and closed the page. (a)'s "every signed-in surface"
    now means every surface that is not itself a modal.*
    *(ii) **The dock's data route never throws.** (f) says the route applies the
    members-only 404; it still authorizes exactly the same way, but it ANSWERS with a
    benign empty view (`unavailable`) for a scope the person cannot reach and with this
    scope's newest thread plus `staleSelection` for a selection it cannot honour. The
    view feeds a root-owned fetcher, and React Router routes such a throw to the ROOT
    boundary — replacing the whole page, which is the hazard (f) already names for CSRF.
    Three ordinary paths reached it (a send answered after navigating away, a
    revalidation after a project was deleted, a stale per-tab selection after an account
    switch). The full pages keep their own 404s.*
    *(iii) **A task anchor binds only inside its own project.** (c) says every task
    tool's `taskKey` defaults to the anchored task; a call that overrides `projectSlug`
    now has to name its task, because the default silently acted on a same-named task in
    the other project. `update_task` also answers `[noop]` where a writer short-circuits
    on an unchanged value, instead of reporting a write that never happened.*
    *(iv) **The per-turn context read is gated.** (b) describes what it gathers; it now
    re-proves the asking person's LIVE visibility of the bound project first, through the
    same `assertProjectAction` chokepoint the board tools use. Without it, an ex-member
    driving an old thread from either full page received that project's canonical
    `task.md` in the prompt while every tool call in the same turn refused. The fence
    around the file is also computed from its content (a five-backtick line inside a
    comment could close a fixed five-backtick fence).*
    *Two more fixes are behaviour the ruling never claimed and are noted for the record:
    the store's conversation list gained a `rowid DESC` tie-break, without which
    same-millisecond threads came back oldest-first and the route test failed most runs;
    and `openDb` gained an additive backstop for `controller_conversations.task_key`,
    `controller_messages.surface` and the scope index, without which every existing data
    root — which never re-runs the squashed baseline — would have answered a 500 on the
    dock's loader and shown the root error page on every signed-in surface.)*

122. **A task's branch NAME is allocated, not derived — a name already spoken for gets a
    suffix (owner, 2026-09-03).** Ruling 34 says a task-key branch is not an identifier
    ("keys restart at 1 on a new data root"), and rulings 35 and 50 built a human-gated
    collision packet around that fact. Pass 33 found what the packet costs on the very first
    task of a fresh store: the Developer committed, the workspace reconcile found merged PR
    #265 still pointing at `vib-1`, the policy engine wrote the collision note and the
    operator opened a decision packet saying the collision "would block a clean push/PR" —
    and pressing **Deliver** with that packet still open pushed and opened PR #270 on the
    first try, no conflict, no remediation. Reproduced immediately on VIB-2 (PR #266 →
    PR #271). Two code paths were asking GitHub different questions about the same branch:
    `openTaskPr` lists `state: "open"` and cannot see a merged PR at all, while
    `findPrForBranch` lists `state: "all"` and treats the newest match as a collision. The
    refusal sentence conceded there was no hazard in the same breath — "already merged and
    its work is on the base branch, so a fresh delivery fast-forwards cleanly" — and pass 17
    (F17-L4) had already split `merged` from `closed` precisely because "the two carry
    opposite delivery hazards"; the SENTENCES were split, the CONSEQUENCE was not.
    The owner did not pick from the options offered (proceed-and-note, or keep the gate and
    fix the copy) and ruled a third way: **"if branch previously exists, viberr creates a new
    one with a unique suffix."** So the collision stops being a decision a human resolves and
    becomes a name Viberr picks.
    **(a) Taken means a ref OR any past pull request** (owner, asked directly, because in the
    live case no ref existed — Viberr had created `vib-1` itself from `main` 35 seconds
    earlier — and it was the merged PR alone that raised the collision). A name is free only
    when `GET git/ref/heads/<name>` 404s AND `GET pulls?head=<owner>:<name>&state=all` is
    empty.
    **(b) Allocated once, at first branch creation, with a short-hash suffix** (owner):
    `<key>-<4 hex>` off `randomBytes`, not a counter — a counter has to read the neighbours
    to know it is next, and the thing being avoided is exactly a name whose history this data
    root cannot see. The choice is persisted to `task.md` `branch:`, the field every reader
    already prefers over the derived name, so delivery, reconcile and cleanup inherit it
    unchanged and nothing in flight is ever renamed.
    **(c) The delivery spine covers both dispatch paths.** The hook that allocates
    (`ensureTaskBranchBestEffort`) ran only on the OPERATOR's dispatch; a human-dispatched
    delivering run reached the agent prompt with no branch recorded and fell back to the
    canonical key. It now runs on both, from one shared home in `branch-sync.server.ts`.
    **(d) The collision packet survives** as the backstop ruling 50 wants — for a genuinely
    unowned OPEN pull request, and for tasks whose branch was recorded before this ruling.
    What goes away is the common path reaching it. The `prAdoptionRefusalNote` clause telling
    a human to "give this task a different branch" is deleted with it: there was never an
    in-app way to do that (pass 33, F33-5 — the operator dutifully built a packet option out
    of it, twice), and now the product does it itself.
    (`allocateTaskBranchName` / `ensureTaskBranchBestEffort` in
    `app/server/github/branch-sync.server.ts`; the second call site in
    `app/server/tasks/specialist-run.server.ts`.)

123. **The archive is the second thing force-accept may not jump (owner, 2026-09-03).**
    Ruling 59 enumerates what force may NOT bypass — ruling 37's terminal GitHub fact and
    ruling 20's PR-head containment — and archive is not on that list. It should have been:
    `acceptCompletion`'s own comment names the gates its shared helper holds ("graph position,
    required reviewers, the R15-1 verdict gate, blocked packet, closed/conflicting PR,
    **archived task**"), `force` skips that helper wholesale, and `forceIrreducibleRefusal`
    covered only the closed PR. Pass 33 proved it live: an archived task was force-accepted
    straight to Done, leaving `stage: done` + `archived: true` + `acceptance: forced` — a
    combination every other path forbids (`transitionStage` refuses an archived task with a
    409, and task-lifecycle §12 says "an archived task cannot be moved"). The disclosure was
    exemplary — the dialog printed "BYPASSING: SBX-1 is archived. Restore it before accepting
    the completion." — which is precisely why the bypass had to go: the product was giving
    correct advice and then letting the admin ignore it. Force-accept now refuses an archived
    task with that same sentence, and the affordance is WITHDRAWN rather than disabled
    (ruling 37's precedent). Restore, then accept: both steps are audited.
    (`forceIrreducibleRefusal` and `resolveAcceptanceAffordance` in
    `app/server/tasks/task-actions.server.ts`.)

124. **Force-accept is an escape hatch, not a standing offer (owner, 2026-09-03).**
    Ruling 59 deliberately kept force-accept visible off-boundary — "a pre-work wedge must be
    escapable; there is no off-boundary hiding" — and that produced an offer on EVERY
    non-terminal task: an org admin opening a task created ten seconds ago saw "Force accept
    (skips the remaining stages and the review gate)" in its GitHub card, directly above "No
    branch yet" and directly under "Not acceptable yet … Move the task through the workflow
    first." A task where nothing has happened cannot be wedged. The offer now appears once
    there is something to accept — a branch, a pull request or a delivered revision — or once
    the task is demonstrably wedged, which an open **blocked** packet proves (that case is
    ruling 59's own, and it keeps working with no branch at all). Narrows ruling 59's
    visibility rule; changes nothing about what force does once offered.
    (`app/features/task-detail/task-side-panels.tsx`.)

125. **The Policy page shows values to roles that cannot edit, not dead controls (owner,
    2026-09-03).** Ruling 65 settled the pattern for the credential card — "withdrawn, not
    disabled … a withdrawn affordance is honest, a disabled one invites a support question"
    — and that same viewer correctly does not see it. The Policy page did the opposite: a
    viewer met sixteen disabled member-role buttons and five disabled guardrail controls. The
    page's other job is being the readable explanation of the policy, so the VALUE stays: a
    role that cannot act reads the member's role and each guardrail's state as plain text, and
    the controls render only for a role that can act. The predicate is the same `ACTION_ROLES`
    entry the route's action guard enforces (`manage-members`, `edit-policy`), never a second
    rule — ruling 65's third consequence, applied to the page it was not applied to.

126. **Coordination overhead is the price, not a defect (owner, 2026-09-03).** Pass 33
    measured what R29-1's "operator proactivity is intended (no throttle on the multi-run
    cascade)" costs now that `/insights` can see it: two small single-file tasks produced 16
    operator runs against 2 delivering and 2 reviewer runs, and Insights reported
    **coordination overhead 69%** — operator and controller runs spent $2.27 of $3.30 (VIB-1:
    7 operator runs at $0.78 against one $0.28 Developer run and one $0.25 Reviewer run;
    VIB-2: 9 at $1.49 against $0.21 + $0.29). Offered a measurement-and-reduction pass or a
    cheaper operator model, the owner ruled to accept it: the coordinator costing two to three
    times the work it coordinates is what this governance model buys. R29-1 stands unchanged.
    Recorded as DECIDED-NO-CHANGE (ruling 114's shape) so a later pass does not re-file the
    number as a finding.

127. **Agent backends authenticate per person, never per instance (owner, 2026-09-02).** The
    deployment-wide `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` / `VIBERR_CLAUDE_USE_CLI_AUTH`
    / `CLAUDE_CONFIG_DIR` / `CODEX_ACCESS_TOKEN` / `CODEX_API_KEY` / `OPENAI_API_KEY` /
    `CODEX_HOME` / `VIBERR_CODEX_USE_CLI_AUTH` credentials, the shared `runtimes/claude-home`
    and `runtimes/codex-home`, the compose `/host-codex` mount and the entrypoint's auth seeding
    are removed. Each person connects Claude and Codex on Profile → Agent accounts: a hosted
    sign-in driven through the UNMODIFIED bundled vendor binary (`claude auth login`,
    `codex login --device-auth`) whose credential lives only in that person's runtime home
    (`<dataRoot>/runtimes/users/<userId>/{claude-home,codex-home}`), or a pasted API key /
    workspace access token sealed in `user_backend_credentials`. Viberr never implements the
    vendors' OAuth, never reads, copies or stores a Claude.ai or ChatGPT **session** token, and
    never offers a setup-token field (Anthropic's Claude Code legal page: hosted platforms must
    have each end user authenticate with their own credentials, billed to them; apps may not
    collect or store Claude.ai session tokens); the only vendor-issued token it ever holds is
    the ChatGPT workspace access token a person deliberately pastes, sealed like any API key.
    **Every run has a credential principal**, persisted as `agent_runs.credential_user_id`:
    task runs — operator, specialist, resume, scheduled, boot recovery, retry — use the **task
    owner's** accounts; controller turns use the asker's Claude account. A task without an
    owner cannot run agents (an honest `run·unavailable` error run and the usual blocked
    packet, no process started), which is why **creation now seats the creator as owner**.
    Spawn env hygiene is unchanged: the child sees only the selected principal's credential,
    and the run sink redacts that value from every persisted line. Instance-level "backend
    configured" surfaces are gone: the task page, packets and the Agents page answer for the
    task owner, the controller for the asker, health for a connected-user count.
    (`app/server/runtimes/user-homes.server.ts`, `backend-credentials.server.ts`,
    `run-principal.server.ts`, `backend-login.server.ts`; the surface is Profile → Agent accounts
    with the poll route `/resources/backend-login`.)

128. **Viberr bootstraps the default branch of an empty repository itself (owner, 2026-09-03, pass 34
    Q34-2).** Live (JC-1 on `akin-ozer/jira-clone`): the pre-dispatch branch hook found no `main`
    ref and said nothing; the delivery push then created `jc-1` as the repository's FIRST ref,
    GitHub made it the default branch, `POST /pulls` failed 422 `base: invalid`, and every surface,
    the tool result, the timeline, the audit row and the operator's packet reported "GitHub was
    unreachable (network error). Fix the repository/credential settings" while GitHub answered
    every call. Three lies (cause, remedy, state) and no way out: nothing in the product could
    create `main`, and the one thing the exercise forbids is a person pushing by hand. The rule:
    when the project's default branch has no ref, Viberr creates it BEFORE the task's first
    branch. On a repository with no refs at all it authors an initial commit (`README.md` naming
    the project) through the Contents API, which GitHub accepts on an empty repository where the
    Git Data ref and commit endpoints answer 409, and the branch that commit lands on is the
    default. On a repository whose only refs are task branches pushed before this ruling it
    creates the default branch at the first commit of GitHub's current default branch and
    restores the configured name as the repository default, the repair the owner approved live
    (Q34-3). Both are disclosed on the task timeline and audited as `github.repo.bootstrapped`.
    The bootstrap runs from `ensureTaskBranch` (both dispatch paths, ruling 122(c)) and again
    from `performDelivery` before the push; a delivery whose base cannot be CREATED does not push
    at all, so a task branch is never the first ref of a repository, while a probe that merely
    could not be READ (a transient network or auth failure) does not block the push and does not
    claim the base is missing. A 422 `base: invalid` on `POST /pulls` is `base_branch_missing`
    and says so; any other unmapped 422, decode failure or unmapped HTTP status is `refused` and
    quotes GitHub; neither is ever reported as a network failure, and a 409 "Git Repository is
    empty" on a ref read is a missing ref, not a network failure. (`app/server/github/repo-bootstrap.server.ts`;
    `ensureTaskBranch` in `branch-sync.server.ts`; `isMissingRefAnswer` in `github-client.server.ts`;
    the 422 arms in `pr-open.server.ts`; the pre-push gate and the rendering in
    `task-actions.server.ts`.)

130. **A refused run's packet names the cause Viberr classified and the remedy the person actually
    has (owner, 2026-09-03, pass 34 Q34-7; F34-1, F34-12).** Live: a five-hour session limit and a
    403 `oauth_org_not_allowed` were both `run·error·unknown` ("Review the runtime configuration"),
    the controller answered "Say it again to retry", the operator's recovery packet recommended
    "I've updated the policy / credential - unblock and re-run", the resolved decision was recorded
    as "policy / credential updated", and an operator acting on that record told a specialist a
    GitHub-scope block had been lifted (JC-6), undoing the owner's Q34-10 decision. The ruling:
    **(a)** provider refusals are classified from the STRUCTURED envelope first (the result's
    `api_error_status`, the assistant envelope's `error` code, a `rate_limit_event` whose `status`
    is `rejected`) and from prose second; the classified terminal line carries the machine facts
    (kind, the reset instant, the window, the API status and code) beside its tag suffix, and every
    reader of a failure (packet builders, the controller's note, the Agent-logs footer for every run
    kind, the quota store) consumes that class, never a second regex over the raw stream; the API
    error banner the provider streams as an assistant message is an error line, never the agent's
    reply. **(b)** Under ruling 127 the remedy for `quota` and `auth` belongs to the credential
    principal, so the packet body, the blocked timeline event and the controller's note name that
    person and their own move: wait until the reset instant Viberr quotes, or connect a different
    account or an API key on Profile → Agent accounts. Generic advice ("fix the credential", "retry
    on the other backend", "review the runtime configuration") is never written for a classified
    refusal; `retry_other_backend` stays offered only when the owner has the other backend
    connected. **(c)** A recovery option's label states what the human asserts and what will happen;
    its recorded decision is that label or a pre-authored `ev`; the toast and the operator's re-run
    instruction state the EFFECT (unblocked, re-run) and restate no claim; "policy / credential
    updated" is reserved for the stock policy-block option the operator authors itself and is never
    the default for a failed run. One module (`run-failure-remedy.server.ts`) owns the failure-to-
    words mapping for operator and specialist runs alike. **(d)** A quota or credential refusal is
    recorded as evidence about the account it billed: the observation store, Insights,
    `instance_health` and the person's own Agent-accounts card say whose account, from which run,
    and when the window reopens, so an instance-wide "usage limit reached" is never claimed on
    behalf of accounts that were not refused; the unauthenticated `/resources/health` body keeps its
    contract and carries no principal, and the card states that the pill is the last refusal Viberr
    OBSERVED, which any completed run on that backend retires. Extends rulings 76 (R20-1), 78
    (R20-3) and 127; `PACKET_OPTION_KINDS` (ruling 7) is unchanged. (`app/server/runtimes/claude-
    runtime.server.ts`, `wire-format.server.ts`, `backend-quota.server.ts`, `run-sink.server.ts`,
    `app/server/tasks/run-failure-remedy.server.ts`, `task-actions.server.ts`, `operator-
    run.server.ts`, `app/server/controller/controller-run.server.ts`.)

132. **Revision drift counts authored commits only; a base refresh is reported as what it is (owner,
    2026-09-03, pass 34 Q34-12).** R17-1 measured drift as GitHub's `compare(reviewedSha...head).ahead_by`,
    which counts every commit reachable from the PR head and not from the reviewed revision, so an
    operator's `update_branch_from_base` (four commits from `main` plus the merge commit) made the
    accept dialog, the review-queue subline and JC-8's permanent completion record say "5 commits
    added since review; they merge unreviewed" while the operator's own read of the same task said
    no drift at all. Drift is now the number of AUTHORED commits since the reviewed revision: the
    commits in `reviewedSha...head` that are not reachable from the base branch and are not clean
    merge commits. A clean merge commit is one the product itself made through
    `update_branch_from_base` and recorded on the task as `baseRefreshes[]` the moment the merge
    landed (that path merges with `--no-ff` and aborts on any conflict, so every recorded merge is a
    real, clean merge by construction); a merge commit from anywhere else, a conflict-resolving
    merge included, is an out-of-band write to the branch and counts. A base refresh is reported
    separately and never as unreviewed work: `pr.revisionDrift` is `{ headSha, authored,
    baseRefresh: { merges, commits } | null }`, and ONE function, `describeRevisionDrift` in
    `app/shared/revision-drift.ts`, turns it into the sentence every surface prints verbatim. Its
    consumers are the reconciler (which writes the fact), the operator's `get_task` read and turn
    doctrine, the accept and force dialogs and "Complete merge", the review-queue subline (whose row
    carries the whole record) and the completion record. A pass that cannot classify (either compare
    unavailable, truncated or partly undecodable; the classification assumes the PR's base is the
    project's default branch, the only base Viberr delivers to) carries the last measurement
    forward, or, with no measurement to carry, records every commit since the reviewed revision as
    authored; it never writes "no drift" from silence, and a commit it cannot classify counts as
    authored. The operator's branch update records its merge commit and the base tip it merged,
    re-measures drift in the same call and returns the sentence, so the operator and the ceremony
    can no longer read two different facts about one head. Extends R17-1 and the F21-17 residual;
    acceptance still merges an ahead head, honestly. (`classifyRevisionDrift`,
    `describeRevisionDrift` in `app/shared/revision-drift.ts`; the compare reader in
    `branch-sync.server.ts`; the drift block in `github-reconciler.server.ts`;
    `update-branch-operator.server.ts`.)

134. **Rework reaches its own open pull request: a delivery pushes whatever origin does not carry,
    reuses the PR, and says what moved (owner, 2026-09-04, pass 34 F34-11).**
    `operatorDeliverForReview` answered "PR #N is already open for review; there is nothing to
    deliver" for any cached non-terminal `pr.state`, before `performDelivery` ran, so every commit
    an agent made after the first delivery (a reviewer-requested rework, a resolved base conflict,
    the whole JC-6 scaffold) stayed in the workspace: the operator reported nothing pending, the
    reviewer approved the local revision, the accept dialog bound to a sha GitHub had never seen,
    `update_branch_from_base` said "already up to date", and the task page hid the Deliver control
    because a PR existed. Three rules. **(a) Delivery is defined by the remote, not by the
    cache.** `pushWorkspaceBranch` reads origin's head for the task branch before pushing (under
    the same credential channel as the push), pushes when it differs, answers `up_to_date` when
    it does not, and the delivered outcome carries the head sha and the previous remote head; the
    operator's cached-state short-circuit is deleted, and the only honest noop is "PR #N already
    carries `<sha>`". A head the push moved on a reused PR is recorded on the timeline ("Pushed
    `<sha>` to **PR #N** for review (was `<old>`)", the same author rule as "Opened PR") and in
    the delivery audit row (`headSha`, `moved`), and every human door that performs a delivery
    (the task page's control and an applied operator recommendation) says what moved through one
    shared toast. An unreadable `ls-remote` never blocks the push. **(b) A head the push moved is
    a new review subject.** Ruling 48's "only a NEWLY opened PR re-queues" becomes "a newly opened
    PR, or a head the push moved"; a reuse that pushed nothing still re-queues nothing, so the
    loop ruling 48 guarded against cannot start. **(c) A person may always perform that push, and
    the operator is told to.** The task page offers the control whenever the delivered revision
    is not on the open PR ("Push `<sha>` to PR #N", ruling 135's record) and not only when no live
    PR stands, while a DIVERGED branch gets the fact and a disabled control naming the refusal
    the server would give rather than a button that then fails; `update_branch_from_base` reports
    the remote copy of the branch beside its base answer (current, behind by N, diverged, absent)
    and points at `deliver_for_review` instead of pronouncing a lagging branch "already up to
    date"; the operator's tool description, its doctrine and the seeded persona say that pushing
    an unpushed revision is this tool's job and never a person's or an agent's. Pushing remains
    the server's act on the operator's or a person's decision (ruling 21 unchanged).
    (`pushWorkspaceBranch` in `app/server/github/push-workspace.server.ts`; `performDelivery`,
    `recordPushedHead` in `app/server/tasks/task-actions.server.ts`; `operatorDeliverForReview` in
    `operator-actions.server.ts`; `deliveryToast` in `app/features/task-detail/delivery-toast.ts`;
    `updateWorkspaceBranchFromBase`; the push control in `task-side-panels.tsx`.)

135. **An unpushed delivered revision is its own acceptance gate, ranked above a conflicting PR, and
    the PR head is recorded in `task.md` (owner, 2026-09-04, pass 34 F34-11).** The accept dialog on
    JC-3 read "PR #10 conflicts with the base branch … Rebase the branch and re-review, or archive
    the task" for a branch that was merged, resolved and merely unpushed: `mergeable: conflicting`
    described the OLD head, the reviewer's verdict was bound to the workspace revision, and nothing
    in the file could say that the delivered revision was not on the pull request. The reconciler
    now records `pr.headSha` and, when the delivered revision is not reachable from that head,
    `pr.unpushedRevision` (`behind`: a plain push fast-forwards; `diverged`: a push will be refused
    as non-fast-forward; `unknown`: the two heads could not be related, which is what a
    never-pushed sha actually looks like: the compare answers `missing_ref` and a direct commit
    read answers 404). The workspace reconcile records the same fact the moment a delivering run
    mints a new revision on a branch whose PR is open, relating the heads from the workspace's own
    history, so the gate does not wait for the five-minute poll; a delivery that pushes clears it;
    a verification revision never qualifies; a record for a revision that is no longer current
    reads as nothing. `unpushedRevisionBlockedReason` is ONE helper, taking the PR ref and the
    current revision sha so every caller can ask it from the shape it holds, consulted by every
    writer and every surface that consults `conflictingPrBlockedReason`: the acceptance refusal
    stack, the projection's block reason, the review queue (whose row carries the two new fields,
    or the branch could never fire), the board ceremony, the accept-time merge sentence and the
    forced acceptance's recorded cause, the review row subline, the operator's `get_task`. It
    outranks the conflict sentence because it names the fact the person can act on: "deliver the
    branch to push it", never "rebase". The live accept-time head check refuses on the same
    evidence instead of answering "unverifiable". Ruling 42's "ahead" (`revisionDrift`) is the
    mirror case and is unchanged. (`prRefSchema`, `unpushedRevisionOf`,
    `unpushedRevisionBlockedReason` in `app/schemas/task-file.schema.ts`; `reconcileTaskUnlocked`
    in `github-reconciler.server.ts`; `classifyUnpushedRevision` in
    `workspace-delivery.server.ts`; `writePrToTask` in `pr-open.server.ts`;
    `evaluateAcceptancePrHead` and `attemptAcceptanceMerge` in `task-actions.server.ts`.)

136. **`resolve_remote_collision` never strands on either arm, and the ceremony reads GitHub before it
    refuses (owner, 2026-09-04, pass 34 F34-10 / F34-11).** Ruling 110's "it never strands" was
    carried by the re-delivery's own follow-up, which had two silent exits: `recordDeliveredNextStep`
    records the "Move to <review>" card only when the board declares a `stage → review` edge (a
    Backlog → Spec/Design → Implementation → QA → Review → Done board declares none from
    Implementation), and ruling 48's re-queue fires only on a newly opened PR under full autonomy.
    Live (JC-8) a fully successful ceremony, branch deleted, unowned PR closed, PR #9 opened, ended
    `waiting: human` with no packet, no card and no run; the refusal arm (JC-6, JC-5) ended
    `readiness: blocked · waiting: human` for a "collision" that was the task's own open review PR;
    and (JC-3) a human who had closed the PR on GitHub seventy seconds earlier was refused because
    `task.md` still said `review`. Three rules. **(a) The ceremony ends with exactly one hand-off.**
    The kind stays out of the generic `packet-resolved` re-queue (that hand-off runs before the
    ceremony and could not carry its outcome) and the ceremony fires its own at its end: the
    ruling-48 `delivered` re-queue when the re-delivery fired it, otherwise a `packet-resolved`
    re-queue whose payload carries the ceremony's outcome in its OWN field (`serverOutcome`),
    rendered to the operator as Viberr's sentence and never inside the human's quoted note, so the
    operator's next turn states what happened instead of re-deriving it and never reads a
    server-composed fact as the person's own words. The in-ceremony reconcile of (c) runs with the
    operator wake and the member divergence notice suppressed, so "exactly one hand-off" is
    literally true. The server-recorded card stays where the board lets it apply, and one audit row
    per ceremony (`github.collision.resolved`) carries the typed outcome. **(b) A refusal that finds
    no collision does what the person asked for.** When the ref delete refuses because the PR on the
    branch is this task's own open review PR, the packet's premise was false: a self-referencing
    `github.unownedPr` is cleared, and for a remote the file does not record as diverged the
    ceremony performs the delivery that pushes the work (the delivery is the authority on the
    relation, so a diverged remote it meets refuses as `push_conflict` and the block stays); for a
    remote recorded as diverged the block stays and the note says that the remote branch holds
    commits this workspace does not and who resolves the history. Every other refusal keeps the
    block and hands its typed reason to the operator. **(c) A cached open PR is re-confirmed before
    it can refuse.** `deleteTaskRemoteBranch` runs a reconcile pass when `task.md` says the PR is
    open, refuses only a PR GitHub still reports open (`own_pr_open`), proceeds on the refreshed
    file when GitHub reports it closed or merged, and fails closed, "GitHub could not confirm", for
    every degraded or unexpected reconcile status (the switch is exhaustive, so a later status can
    never become a silent proceed); nothing is ever deleted on an unconfirmed state, and the
    archive and empty-branch cleanup doors inherit the same live check and the same sentence.
    Ruling 110's delete-first order, the human-only gate and the scope-violation on a refused close
    are unchanged. (`resolvePacket`'s collision arm in `app/server/tasks/task-actions.server.ts`;
    `resolveRemoteBranchCollision` and `deleteTaskRemoteBranch` in
    `app/server/github/github-reconciler.server.ts`; `app/shared/packet-server-outcome.ts`; the
    `packet-resolved` doctrine in `operator-run.server.ts`.)

142. **A run's shell carries none of Viberr's own configuration (2026-09-04, pass 34 U34-7).**
    Ruling 127 built the spawn base around what a child must not learn about OTHER people's
    credentials. Pass 34 found the other half: the base still handed every child this server's
    own runtime settings. The JC-6 Developer run saw `NODE_ENV=production` and `PORT=5173`,
    which broke `vitest` and `next start` inside a repository whose tooling reads exactly those
    names, and the agent had to unset them by hand. An agent works in the project's repository,
    not in Viberr's process, and a registered stdio MCP server is somebody else's program, so
    `filteredSpawnEnv` now also strips **every name the env schema declares** (`ENV_KEYS`:
    `NODE_ENV`, `PORT`, `VIBERR_DATA_ROOT`, `BETTER_AUTH_URL`, the OAuth client ids,
    `VIBERR_TRUST_PROXY`, the unlock flags and every other `VIBERR_*` knob), keyed on the schema
    rather than a hand-written list so a knob declared tomorrow is stripped tomorrow. The rule is
    the mechanism, not a list: a declared name is stripped whatever its value (an empty string
    included); a name the schema does NOT declare still passes, which is safe precisely because
    the "no undeclared env reads" gate (`env.server.test.ts`) keeps the schema complete, and the
    few undeclared reads it allows are either credential-shaped and stripped by the regex
    (`VIBERR_SECRET_ENCRYPTION_KEY_PREVIOUS`) or harmless in a child (`LOG_LEVEL`,
    `VIBERR_E2E_*`, the test markers). Ordinary host settings (PATH, HOME, locale, proxies) and
    the image's deliberate agent-facing `UV_CACHE_DIR` / `UV_PYTHON_INSTALL_DIR` survive.
    Nothing a child needs comes from a declared name: `VIBERR_BROWSER_EXECUTABLE` is read by the
    server and handed to the browser MCP as `--executable-path`, and the agent toolkit and the
    controller's `viberr_ops` mount are in-process SDK servers. The same base serves every
    spawned stdio MCP child (`mcpSpawnEnv`), the hosted sign-in driver and the vendor logout, so
    all of them lose the server's configuration in the same change. The
    `docs/operations/configuration.md` sentence claiming the runtime "never inherits its own
    environment" becomes true instead of aspirational, with a dated correction. The three
    existing exclusions (`CREDENTIAL_ENV_RE`, the private-runtime names, both vendor homes) are
    unchanged. Extends ruling 127. (`APP_CONFIG_ENV` / `filteredSpawnEnv` in
    `app/server/runtimes/runtime-registry.server.ts`; `ENV_KEYS` in
    `app/server/config/env.server.ts`.)

143. **An allocated branch is not a delivery (2026-09-04, pass 34 U34-9).** Ruling 122
    moved branch naming to allocation time, at first dispatch, before an agent has
    written anything. The Insights traceability metric had been counting "has a branch"
    as delivery footprint since before that ruling, so its denominator quietly grew to
    include every task that ever engaged a deliverer: live in pass 34 the card read
    "7 of 8 delivered tasks carry branch + PR" while one of the eight, JC-7, had
    delivered nothing at all. The PRD's outcome is about executed tasks. The denominator
    is therefore tasks carrying a delivered work revision or a recorded pull request; a
    delivered revision with no pull request stays in it on purpose, because an unpushed
    delivery is exactly an untraceable one. The numerator stays branch AND pull request,
    which is what makes an untraceable delivery visible. A task whose only footprint is
    the allocated branch is out of both, and the test pins that fixture explicitly
    (`VIB-4` in `insights-query.server.test.ts`: branch only, must not count). The card's
    own subline, "N of M delivered tasks carry branch + PR", does not change: with this
    denominator it is finally true. This is a consequence of ruling 122 recorded where
    a number a person reads changed. (`getInsightsSummary` and the
    `OversightSummary.traceability` comment in
    `app/server/insights/insights-query.server.ts`; the prose definition in
    `docs/domain/auth-and-rbac.md` §6.)


144. **The `workflow` scope stays optional, is disclosed on classic tokens, and a workflow-file push
    is refused before it reaches GitHub when the token is known to lack it (2026-09-04, pass 34
    G34-2, under Q34-10's direction to close the gap in the fix phase; confirmed by the owner as
    Q34-15 on 2026-09-04; amends ruling 18).** Ruling 18 dropped `workflow` from the required set
    and promised that "a refused workflow-file push surfaces as a scope violation when it
    matters". Live (JC-6): GitHub rejected the push of `.github/workflows/ci.yml` with "refusing
    to allow a Personal Access Token to create or update workflow … without `workflow` scope",
    and the rejection reached the person only as the operator's packet 25 minutes later; no scope
    violation, no chip, nothing at attach time, because git push rejections never went through
    the violation path at all. Three parts. **(a)** The validator records a classic token's full
    `x-oauth-scopes` list; the project credential card and the connection row say, as an
    advisory that never fails validation, that a classic token without `workflow` cannot push
    `.github/workflows/*`. Fine-grained tokens expose nothing to read, so they get no advisory.
    **(b)** Before pushing, delivery lists the workflow files the branch changes AS GITHUB
    MEASURES THEM (the ref update from the remote branch head, falling back to the base branch
    only for a first push) and refuses with a named remedy before GitHub is asked when the bound
    credential is a classic token without `workflow`; a branch whose workflow file already
    reached the remote is never refused for a push that does not touch it. **(c)** A push GitHub
    refuses for that reason, on any token kind, opens a `workflow` scope violation on the task
    (the `policy` event, the inbox notification, the credential-card flag, the rail count),
    resolved by a re-check whose header now lists `workflow` (header scopes are evidence for
    every scope they name), or by the next successful push of workflow files; the remedy names
    the Grant / Re-check control by name, and the operator is told the remedy is a human's.
    `workflow` is still not required: a project that never ships CI never sees any of this.
    (`credentialAdvisories` in `pat-store.server.ts`; `headerScopes` and the re-check sweep in
    `pat-validator.server.ts`; `changedWorkflowFiles`, `isWorkflowScopeRejection` and the
    `push_refused_scope` result in `push-workspace.server.ts`; the `scope_violation` outcome in
    `task-actions.server.ts`; `credential-card.tsx`; `connections.server.ts`.)

*(Added 2026-09-02, pass 32 — the pass-32 owner decisions were promoted rather than left
on this list: they are **rulings 109–120** above. Everything still listed here predates
that pass and remains unnumbered.)*

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
/org/settings/audit-export              (org admin — CSV/JSON audit download, pass 26)
/controller                             (ruling 99 — every signed-in user)
/insights                               (org admin — run analytics, pass 29)
/profile   /notifications   /notifications/read   /prefs/theme
/resources/events  (SSE)   /resources/health   /resources/run-log
/resources/search   /resources/session-export   /resources/model-catalog
/resources/controller                   (ruling 121 — the dock's GET view + POST send)
/resources/backend-login                (ruling 127 — the signed-in viewer's own sign-in session)
```

*(Corrected 2026-08-06, pass 19, against `app/routes.ts`: `/projects`, `/notifications/read`,
`/prefs/theme` and `/resources/search` — the ⌘K palette query from ruling 23 / R15-5 — ship but
were never added here.)*

*(Corrected 2026-09-01: `/org/settings/audit-export` and `/insights` ship and were missing. The
per-route guard and form-intent inventory is in [`../ui/surfaces.md`](../ui/surfaces.md).)*

*(Updated 2026-09-02 for ruling 127, branch `claude/per-user-codex-auth-difdnn`:
`/resources/backend-login` — `GET ?backend=claude|codex` behind `requireUser`, answering the
CALLER's own live sign-in session plus the public half of their `userBackendHealth` (no
`verification` verdict, no ids), so the Profile poller stops when the backend flips to
available. It reads nobody else's session.)*
