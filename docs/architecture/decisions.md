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
    only, never estimates. The stored token columns carry ONE meaning on both backends:
    `input_tokens` is the whole prompt of every call (Claude's cache reads and writes
    folded in at the wire boundary), `cached_input_tokens` its cache-read subset
    ([agents-and-runtime §3.1](../domain/agents-and-runtime.md#31-persistence)).
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
    *(Amended 2026-09-11 by ruling 176: an admin may mark a server's write tools, and those
    are denied on every run whose repo-write grant is withheld. The rest stands: no
    capability denies the `mcp__*` channel, and Viberr makes no claim about a tool the admin
    has not marked.)*
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
    *(Amended by ruling 164, pass 35: the remedy is named in the packet's own words — the body
    and the observations, beside the workarounds — and never as an OPTION. No option kind edits
    an agent profile, so an option that promised the grant resolved to a send-back that changed
    nothing, which is the failure 164 exists for. What the packet must SAY is unchanged.)*
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
    *(Extended 2026-09-04, pass 34, ruling 129: the mirror is also what a REUSED checkout is
    refreshed from before every delivering dispatch — the cache that made cloning cheap is what
    made a stale checkout survive across runs.)*
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
    writable attachments dir. *(Drift note corrected 2026-09-11, Option D PR 6: R22 removed the
    OS sandbox as the confinement model; ruling 101 later restored `read-only` for
    write-withheld Codex runs as a live seam (`resolveCodexSandboxMode` in
    `codex-runtime.server.ts`). Both stand. The modal copy this note called stale has
    matched ruling 101 since ruling 109, and "advisory on Codex" survives only as the label
    of ruling 109's carve-out.)*

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
    existing assignSpecialist machinery. **Confirmed 2026-09-04 (pass 34, Q34-14; the JC-6
    substitution tested it):** the operator may switch the delivering agent however it
    judges best, because a human can redirect it through the operator chat or agent
    allocation; no gate, card or ruling number is added, and after ruling 133 a hand-off
    is a choice about who should build, never a way around a stage. The assign/engage menus, the per-row Run buttons,
    the `assign-specialist`/`run-specialist`/`assign-reviewer`/`run-reviewer` intents and
    the legacy `specialist`/`reviewers`/`consultants` parse absorption are deleted;
    releasing a supporting engagement survives as the ledger's ✕ (`release-agent`).
    **(b) One dispatch verb everywhere.** The operator's `engage_agent`/`run_agent`/
    `prompt_agent` trio collapsed into ONE `run_agent(profileId, prompt?, delivers?)` on
    both backends; the `assign-primary-specialist`+`summon-reviewers` capability pair
    collapsed into `dispatch-agents`; the four slot-shaped recommendation kinds collapsed
    into `run_agent` (profileId + prompt on the card; Apply dispatches exactly what the
    manual control would). The choice itself stays an LLM decision fenced by stage
    eligibility (**narrowed 2026-09-04 by ruling 133:** eligibility fences NEW engagements;
    an engaged deliverer is re-run at any stage), grants and the selection trace — and it now weighs the durable
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
    *(Amended 2026-09-11, Option D PR 5: argument-level denies carry a model-visible reason
    and cover wrapped command shapes; the denylist remains the fence. Measured on the pinned
    CLI against a local remote, the `Bash(<prefix>:*)` rules already refused `cd . && git
    push` and `true; git push` (the CLI checks each part of a chain) but let `git -C . push`
    and `sh -c 'git push'` through, and both refs landed. Every Claude run whose Bash is not
    denied outright and whose denylist names a `Bash(<prefix>:*)` rule now carries a
    PreToolUse hook: it reads the command as a shell would, unwraps `git -C`/`-c`/`--git-dir`,
    `sh -c`/`bash -lc`, `eval`, `env`, `xargs`, `timeout`, `$(…)` and backticks, and refuses a
    command that reaches a denied prefix. The reason names the capability the run withholds,
    derived from the denylist alone, or the supporting-run delivery deny, and it comes back
    as the tool's result. The hook runs before the rules and only ever denies. Its decision
    has no SDK `permission_denied` frame, so the adapter writes one marked as Viberr's
    (`decision_reason_type: "hook"`). Live, all five shapes were refused with the reason
    and nothing landed. A script that pushes still runs: the container and the server-owned
    delivery gate stay the boundary (ruling 93). `app/server/runtimes/bash-policy.server.ts`,
    `bashDenyReason` in `app/server/tasks/specialist-tool-policy.ts`, the hook in
    `claude-runtime.server.ts`.)*

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
    such rather than as a runtime proof. *Re-verified 2026-09-06 on the 0.153.4 pin
    (Codex SDK upgrade): `SandboxPolicy::ReadOnly { .. } => Vec::new()` in
    `protocol.rs`'s `get_writable_roots_with_cwd`, `--add-dir` help text unchanged, the
    SDK's `ThreadOptions` still expose only `sandboxMode` and `additionalDirectories`. The
    CLI has since grown a per-path permission-profile layer (`permissions.rs`) that the
    SDK does not surface; whether a config-level profile could express "read-only plus
    `attachments/`" is a question for a future ruling, not a change this note makes.*
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
    *Watch item (added 2026-09-11, Option D PR 6): the Codex CLI's `permissions.rs`
    per-path profile would express read-only plus a writable attachments dir; revisit when
    the SDK surfaces it.*

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

129. **A reused delivering workspace is refreshed from the project mirror on every dispatch (owner,
    2026-09-03, pass 34 Q34-5).** Live (JC-2 to JC-5): the task workspaces were cloned once, by the
    operators' first triage at 09:00Z, from a repository that was still empty; every later run reused
    them as they stood, agents hold no credential so they could not fetch, and while the operator read
    a bootstrapped `main` through the mirror and told the spec writers so, the spec writers found zero
    commits in their checkouts and committed unrelated root commits on `jc-2` and `jc-5`. Two sources
    of truth in one task, and `update_branch_from_base` could only answer "refusing to merge unrelated
    histories". The rule: before a delivering run starts in an existing checkout, Viberr fetches the
    mirror's heads into the checkout's `origin/*`; a checkout whose HEAD is unborn, or that sits clean
    on the default branch, is fast-forwarded to `origin/<default>`; a task branch that has diverged is
    left exactly as it is, because `update_branch_from_base` (N19-9) owns that move and a conflict
    there is a human decision; a dirty tree and a detached HEAD are never touched; and a branch that
    shares NO history with the default branch is named as such in the run's inputs and in the agent's
    workspace contract rather than silently left alone. The refresh is not defeated by a cold cache:
    the dispatch creates the mirror if it must, and falls back to a server-side credentialed fetch of
    the remote heads if it cannot. The refresh is disclosed in the run's `run·inputs` line and in the
    agent's workspace contract, and a mirror that could not itself be refreshed from GitHub says so
    there. Supporting checkouts keep their fetch-only refresh (pass 32, C32-2), now the same function.
    The operator's read-only view of the same directory is refreshed on the same terms when no
    delivering run is live for the task, because the operator holds `Read`, `Grep` and `Glob` over it;
    its default-branch reads remain mirror-anchored (F21-21). A cache still never blocks a task: a
    failed refresh degrades with a warning and the run proceeds. Extends ruling 87(a), whose mirror
    cache made the stale-checkout window possible by making the first clone cheap enough to keep.
    (`app/server/tasks/workspace-refresh.server.ts`, called from `cloneRepo` in
    `app/server/tasks/specialist-run.server.ts`.)

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

131. **Task dependencies: a task names what it waits on, Viberr holds it without a packet and
    releases it itself (owner, 2026-09-03, pass 34 Q34-11).** Pass 34 ran five controller-built goal
    chains against one repository and three of them stalled behind the first: JC-7 and JC-9 could
    not start until goal-1's links 2 to 4 were on the base branch, and goal-3 and goal-5 queued
    behind the same work. Every operator read the situation correctly, and every one of them had
    only a decision packet to say so with: JC-7's hold ended as `waiting: human` with one comment;
    JC-9's operator ran five paid turns and then wrote "this packet is the standing token … nothing
    will re-check main for JC-9 again"; a person had to answer each hold and would have had to re-
    answer each one by hand when the foundation landed. Nothing in the product watched the thing
    being waited for. **(a) The fact lives on the task.** `task.md` carries `blockedBy: []`, the
    task keys (`JC-6`) and goal links (`goal-1 link 3`) in the same project this task waits on. It
    is planning metadata with one difference from priority, labels and due date: while the list is
    non-empty the derived readiness is floored at `blocked` (`deriveReadiness`, the one derivation
    home), the board card, the list row and the task page say what it waits on and in what state,
    and the task owes nobody anything (`waiting: none` unless a packet or a recommendation is open).
    A goal-link entry resolves to a task key the moment the chain creates that link's task and
    renders as both. States are resolved at read time, never cached. `GOAL` is reserved as a
    task-key prefix for the same grammar: `GOAL-1` reads as a goal reference missing its link, so
    a project keyed that way could never be waited on and every writer of `taskPrefix` (creation,
    project settings, the controller's `update_project_settings`) refuses it by name. **(b) Three writers, one
    gate.** Humans set the list on the task page; the controller sets it through `create_task`,
    `update_task` and per goal link on `create_goal` / `update_goal`, under the asking person's own
    gate; the operator records it with its `set_dependencies` tool (gated like packets, `generate-
    packets`) instead of opening a hold packet. Every write validates against the store: a reference
    must parse, name an existing task or goal link in this project, not be the task itself, not be
    an archived task, and not close a cycle, counting DECLARED goal-link edges as well as created
    tasks; a refusal names the reference and the reason. Every write is a `note` on the timeline and
    `task.dependencies.updated` in the audit log. **(c) Chain-created tasks inherit.** A goal link
    may declare `blockedBy`; when the chain creates that link's task the list is copied onto it and
    validated then, so a link that waits on a sibling chain's link is born held instead of paying a
    triage turn that has to discover the wait. **(d) The operator holds without a packet and is not
    nudged.** While the list is non-empty: the `create`, `transition` and `scheduled` triggers are
    refused at fire time (`refused: "blocked-by"`; no run, no cost; the refusal settles the task's
    waiting flag, and a scheduled occurrence says on the timeline that no run happened); the
    stranded-coordination backstop treats the list as a recorded hold and never nudges; and every
    turn that does run (an agent report, a human's question, a resolved packet, a goal edit, a PR
    change, a manual run) is told what the task waits on, in a doctrine that REPLACES the ordinary
    "never end your turn with nothing done and no packet" tail, and must neither advance it,
    dispatch delivery work, nor open a hold packet about the wait. A human-scheduled AGENT run still
    fires: this ruling refuses operator triggers. **(e) Viberr releases it.** When every entry is
    done (its task reached the terminal stage; its goal link is done or was skipped) the release
    engine clears the list, writes the release note naming what was waited on, lifts a stored
    `blocked` readiness to `ready`, clears a recorded `heldAtStage`, notifies the owner and
    supervisors (notification kind `dependency`, its own routing toggle) and re-invokes the operator
    with the `dependencies-released` trigger, whose doctrine says the base branch has changed since
    the hold and that a hold packet the operator opened itself is now moot. The engine runs from the
    same task-write hooks that advance goal chains (transition, archive and restore, acceptance) and
    from the goal runner's minute tick, and it is convergent: an empty list has nothing to release.
    A human clearing the list is the same release, through the same two halves. A dependency that
    can never complete (its task archived, its link failed) does not release: it is noted once on
    the dependent's timeline, the owner is notified, the task is left `waiting: human` because a
    person owes the list an edit, and the entry renders as "archived" until they make it. **(f) What
    this replaces.** The two live holds convert by setting the list: JC-7 (held as `waiting: human`)
    gains its three entries; JC-9 gains them and its standing-token packet is resolved once, or is
    left for the release turn to withdraw as moot. The operator doctrine no longer offers "open a
    packet asking the human to confirm the hold" for a wait on other work; that exit stays for holds
    a human directed. Ruling 126's price still applies to the turns that run; the turns this ruling
    refuses cost nothing. (`app/shared/dependencies.ts`; `app/server/tasks/dependencies.server.ts`;
    `app/server/projections/dependencies.server.ts`; `deriveReadiness` in
    `app/server/interpretation/readiness-policy.server.ts`; the `blocked-by` refusal, the
    `dependencies-released` trigger and the doctrine in `app/server/runtimes/operator-
    run.server.ts`; `set_dependencies` in `app/server/tasks/operator-toolkit.server.ts` and the
    Codex plan; the controller tools in `app/server/controller/controller-toolkit.server.ts`;
    `task_projections.blocked_by_json`.)

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

133. **An engaged deliverer acts at any stage; stage eligibility gates NEW engagements (owner,
    2026-09-03, pass 34 Q34-13; F34-16).** A profile's eligible stages (`stages:` / `spanAll`,
    resolved per board by R14-1's three steps) decide which profiles may be NEWLY engaged on a task
    at its current stage: `assignSpecialist`, `assignReviewer` and the dispatch's auto-engage keep
    refusing an ineligible profile. Once a profile is the task's delivering engagement it may be
    prompted or resumed on that task at EVERY stage, by the operator, by a human @mention, by the
    Run control, by a schedule and by the built-in packets (`redirect`, `retry_other_backend`, a
    resolved question), for rework, conflict resolution and follow-ups; the admitted reason is
    recorded on the `task.agent.run_started` audit row as `stageEligibility`, which names the
    exemption only when it was needed. Supporting engagements (reviewers and helpers) stay stage-
    scoped, and the rule is the same on every door: an @mention that would resume a supporting agent
    at a stage its profile does not declare records the comment and refuses the run with the
    dispatcher's own sentence, and a profile that is not engaged at all (released, or never engaged)
    is judged by the new-engagement rule even when a provider session survives. Consequences:
    **(a)** rework routing (`reworkStages`, `transition_stage`) is a workflow choice about where the
    board should show the work, never a workaround for a profile's stages, and the operator
    doctrine, toolkit descriptions and seeded persona say so; **(b)** a built-in packet offers only
    options that can execute: the branch-conflict and push-conflict packets recommend "Have the
    delivering agent resolve the conflict" only when the task has a delivering engagement whose
    profile is deployed with a repo-write grant, and otherwise recommend resolving by hand and say
    why, with the offered resolver recorded in the branch-update audit row; **(c)** the Agents
    surface states the rule beside the "N of M stages" count, and states the scoping half only for a
    profile that is actually scoped, while the operator's `get_task` snapshot reports the deliverer
    as eligible for the current stage and the selection trace marks the posture the dispatch will
    actually take. The F1 run-boundary test that asserted the opposite for the deliverer is reversed
    deliberately by this ruling; the reviewer half of F1 stands. Supersedes the "asserted on
    assignment and dispatch" sentence in `agents-and-runtime.md` and ruling 98(b)'s "fenced by stage
    eligibility" as it applied to re-running an engaged deliverer. Ruling 98(a) is NOT touched: who
    may decide a delivery hand-off was put to the owner as Q34-14 and answered on 2026-09-04 — the
    operator may switch the delivering agent however it judges best, because a human can redirect it
    through the operator chat or agent allocation — so 98(a) stands with a dated confirmation note
    and no separate ruling. (`runEligibilityFor` and `assertResumeEligible` in
    `app/server/tasks/specialist-run.server.ts`; the resume gate in `commentToAgent`;
    `stageEligibility` on `task.agent.run_started`.)

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

137. **An acceptance offer is bound to the revision it was made for, and is withdrawn, on the record,
    when that revision or the task's decision state changes (owner-directed fix of F34-15, 2026-09-04).**
    The operator's `accept_completion` card ("the review is clean and the work meets the goal") stood on
    JC-3 after the deliverer committed a new revision with no verdict and after the operator opened a
    blocked conflict packet on top of it; only a non-healthy verdict, archive or acceptance had ever
    dropped it, and a stage move dropped transition cards alone. Every `accept_completion` card now
    carries `forHeadSha`, the work revision it was authored against, on both the authoring and the
    re-authoring path (`addRecommendation`'s push and its in-place update, which re-binds), the
    `task.operator.recommended_completion` row records it, and the card renders "for revision <sha>".
    ONE helper, `withdrawAcceptanceOffers`, living in the leaf task mutation module
    (`app/server/tasks/task-mutation.server.ts`) so every writer can call it without closing a module
    cycle, removes `accept_completion` cards and `transition` cards targeting the terminal stage inside
    the task file's own lock: it runs in the write that mints a new work revision (the delivery
    reconcile, now a locked mutator that keeps its "Reconciled branch" event), in every writer that
    opens a decision packet (the operator's, an agent's question, the completion-envelope question),
    and in a stage move away from the acceptance boundary as the workflow graph defines it (the review
    stage `resolveStageRoles` names, never a positional guess; a move INTO the terminal stage is the
    acceptance itself). A withdrawal is never silent: a `note` event titled "Recommendation withdrawn"
    names the card and the cause, an audit row `task.recommendation.withdrawn` records it (cause,
    removed cards with their bindings, survivors), and the card's "Waiting on you" notification is
    marked read only when no recommendation survives. `run_agent` and `delivery` cards survive all
    three events: more work is compatible with rework. The operator re-recommends acceptance on its
    next turn if the offer still holds. Extends the 2026-07-18 owner decision that a divergence
    withdraws moot cards, and `applyRecommendation`'s F19-3 rule that a terminal transition card is an
    acceptance.

138. **A decided `edit_goal` packet reads as decided everywhere, and the goal draft it opens is an
    explicit, shared field (owner-directed fix of F34-13 and U34-10, 2026-09-04).** Confirming an
    `edit_goal` option stamped `packet.awaiting: goal_edit` and opened the goal editor from the
    in-memory action result only; after a reload the card rendered undecided with every option
    selectable, a second confirm was a 409 shown as a passing toast, the readiness pill said "input
    required", and the goal's Edit button was the undiscoverable way out. The packet now records the
    decision itself, `decided: { optionIndex, at, byUserId }`, beside `awaiting`; both goal writers
    keep clearing the packet when the edited goal lands. The decision-packet card renders a decided
    packet with the chosen option locked, the words "Decision made · save the edited goal to clear
    this packet" and one control, "Edit the goal", which opens the goal editor prefilled exactly as
    the confirm did (a packet stamped `awaiting` with no recorded decision renders nothing special);
    the display readiness is `goal_edit_pending` on the hero, the board card and the review queue
    (the queue row carries `goalEditPending` and its subline says what is owed), derived in
    `deriveDisplayReadiness` like every other display state and ranked below `agent_working` and
    above `input_required` and a stored `blocked`, never over a terminal state; the side rail's
    "Waiting on" says "a goal edit"; the operator's `get_task` sees `packet.awaiting`. The prefill is
    `goalDraftForOption` in `app/shared/packet-goal-draft.ts`, the ONE composition, shared by the
    confirm response and the reload path. An `edit_goal` option carries `goalDraft`, the proposed
    goal text itself (capped at 4000 characters at the one chokepoint, `operatorOpenPacket`), which
    both operator backends are told to write as a goal (deliverable plus acceptance criteria)
    because it is what the editor opens with, which the Codex plan schema REQUIRES as a key (null
    off `edit_goal`, so persisted plans replay), and which is refused by name on any other option
    kind; an option without one prefills the option's title and detail verbatim, and the prompts say
    so, so an operator never phrases them as an instruction to the human. Extends R20-1 (a made
    decision is un-re-confirmable) and F17-L3 (the editor prefills with the chosen deliverable).
    *(Completed 2026-09-07, pass 35, F35-6, not a reversal: the draft was rendered nowhere and
    only the decided card's own control seeded it, so after a reload the hero's Edit under the
    goal, the door a person takes, opened with the ORIGINAL goal and an unchanged save read
    "Goal updated" over a packet still waiting (KNC-4, 14:56Z). The projection's packet render
    now carries `goalDraft`, composed once in `mapPacket`; the decided card prints it as
    "Requested goal (opens in the editor)", its "Edit the goal" opens it, and the hero's Edit
    seeds it while the packet waits. The writer's half, refusing an unchanged save while a
    `goal_edit` packet is open and reporting "Goal unchanged" without one, lands with the task
    actions of the same pass.)*

139. **The controller's catalogued writes read first and refuse by name (owner, 2026-09-04, pass 34
    F34-2 / G34-1).** Every `viberr_controller` write that takes a catalogued identifier (a capability
    id and mode, a stage id, a resource grant key, a model id or effort tier, a project role) validates
    it against the catalogue the runtime resolves by and refuses an unknown or impossible value BY NAME,
    listing what is valid, before anything is written. `[done]` is never answered for a write the store
    did not make: pass 34 watched `update_agent_deployment` answer `[done]` twelve times for capability
    ids that do not exist while every grant stayed off, the same class F33-8 closed for resource grants
    one tool over. The refusal covers the whole vocabulary of that call: an id outside the deployment's
    KIND, a mode the kind does not take, a non-human mode on an always-human id, a mode other than
    direct or off on the explicit-only verdict grant, a matrix-only capability that has no toggle at
    all (refused as such, never as "no such id"), and a stage the project does not declare. For every
    such catalogue there is a read the same person may call first, and the write's description names
    it: `list_capabilities` (any signed-in person) for the capability ids and, per kind, the mode an
    ABSENT grant actually resolves to (`absentGrantMode`, the roster's own rule), not the catalogue's
    create-seed default; `get_project` for a deployment's resolved grants, model, effort and operator
    autonomy, derived by the Agents page's own roster so the controller reads what the roster renders;
    `list_skills`, `list_mcp_servers`, `list_knowledge_bases` for grant keys (F33-8). Effort is
    settable wherever model is: `deploy_agent` takes `model` and `effort`, `update_agent_deployment`
    takes `effort`, and both check the tier against the backend's list at save time rather than
    clamping at run time, because a silent clamp is the same lie as a silent drop; the profile editor
    shares the check for a CHANGED value only, so a deployment that legitimately stores a preserved
    tier stays editable, and the editor stops offering a stale tier it cannot save. The refusal lives
    in the controller tools and the shared validators, not in `grantsFor`: the project editor
    legitimately preserves advisory and retired ids that a strict catalogue check would refuse.
    (`controller-toolkit.server.ts`, `capability-catalog.ts` `capabilityPatchRefusal`,
    `agents-query.server.ts` `absentGrantMode`, `agent-profile-actions.server.ts`,
    `model-catalog.server.ts` `assertEffortForBackend`.)

140. **The owner seat is named at creation, seated before the first run, and every seat change is
    told to the person whose seat it is (owner, 2026-09-04, pass 34 G34-3 / U34-11).** Ruling 127 made
    the owner the credential principal and the acceptance authority; a seat that changes hands without
    telling the person is a bill and a duty they learn about from the first failure packet, which is
    how Omar learned he owned JC-15. **(a)** `createTask` takes an optional `ownerUserId`: a member who
    can own tasks (the hand-off rule of `setOwner`, contributor or above, one shared check
    `requireOwnable`), seated in the same `task.md` write that creates the task and before the
    operator's `create` trigger, so the first triage run already bills the named owner and is refused
    honestly when they have no credential, instead of running once on the creator's account. The
    controller's `create_task` takes `owner` (an email, or `me`; the release word `none` is refused by
    name at creation) and `dueDate` beside priority and labels; `priority: urgent` IS the urgent flag,
    because `urgent` is derived from priority and never a second input (F26-16). The `task.created`
    row records `seat: creator | named | none`. **(b)** A notification kind `ownership`, with its own
    routing category, reaches the new owner on a hand-off or a creation that names them. The row names
    who did it and what the seat means under ruling 127, opens the task page, and never enters
    "Waiting on you" (that panel is fed by pending decisions, not by notification kind); the audit row
    records whether the person was told and, when they were not, WHY (`notified: {userId}` /
    `{skipped: "silenced"}` / `{skipped: "failed"}`), so a silenced preference and a broken store never
    read the same. Nobody is told about their own take or release, and a member removal releases seats
    silently because the person is leaving. Because kinds are a CHECK constraint on `notifications`,
    the boot integrity check now compares that constraint against the kinds the code declares
    (`projectionCheckGaps`), so a data root that predates a new kind is reported rather than silently
    dropping every row of it. The PREVIOUS owner is told on a takeover and the released owner on an
    admin release, through the same notifier: losing the seat takes away the credential principal
    role, the review duty and the acceptance authority, so it is not a smaller fact than gaining it.
    (`task-actions.server.ts` `createTask` / `setOwner` / `releaseOwner`, `task-mutation.server.ts`
    `notifyOwnerSeatChange`, `notification.server.ts`, `notification-prefs.ts`, `notification-meta.ts`,
    `0001_baseline.sql`, `boot.server.ts`, `controller-toolkit.server.ts` `create_task`.)

141. **A scheduled operator re-run is refused while a decision packet is open, and no occurrence is
    recorded as fired when no run happened (2026-09-04, pass 34 F34-8).** Ruling 76 refuses a
    human-pressed "Run operator" while a packet is open because coordination is paused and the turn
    is a paid no-op; the guard was scoped to the `manual` trigger, so the same paid no-op still ran
    when a person scheduled it for five minutes later. It is the same turn with nobody watching, so it
    takes the same refusal. Pass 34 also found the second half: the schedule runner writes "Scheduled
    action starting" at claim time and stamps the occurrence `fired` for every outcome except a
    terminal stage, so on JC-2 the task said a run had started, the trigger was queued behind the
    drive that then opened a packet, and the refusal existed only in the server log. From now on a
    scheduled occurrence that cannot run is retired with a timeline note naming the reason and a final
    audit row (`outcome: "skipped-packet"`, `refusedAtStart: true`) beside the claim-time row, it
    spends no retry, and a trigger that is refused when it reaches the front of the lease queue
    writes the same kind of note AND retires its occurrence the same way, because the occurrence's
    identity travels with the trigger (`RunOperatorInput.scheduleId`; the fire-time row of a run that
    was queued behind a live drive says `outcome: "queued-behind-drive"`, and the drain-time row
    carries `atDrain: true`). A queued human `@operator` turn refused the same way gets its own note.
    The refusal writer settles nothing: an open packet owns `waiting: "human"`, and the
    terminal-stage refusal already settled. Machine reaction triggers (`pr-diverged`, `agent-reply`,
    `transition`, `packet-resolved`) still run with a packet open, exactly as ruling 17 requires.
    Extends ruling 76. (`runOperator`'s open-packet guard, `noteQueuedTriggerRefused` and the two
    lease-drain sites in `app/server/runtimes/operator-run.server.ts`; the finalize block in
    `app/server/tasks/schedule.server.ts`.)

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
    *(Amended 2026-09-11 by ruling 174: one name is added back to every agent run's child
    env on purpose, `VIBERR_RUN_ID=<runId>`, the marker the settle sweep finds a run's
    processes by. It is not configuration, is not in `ENV_KEYS`, and `startRun` sets it
    after the caller's overlay. Stdio MCP children spawned outside a run (the registry
    probe, the warm-up) do not carry it.)*

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

145. **Every standalone page carries the app header (owner, 2026-09-05).** Asked of the four
    Settings tiles on Home: "all of these settings pages should show header when opened as
    well, build it just like settings inside the board page so our UI feels holistic."
    A project surface — the board's own Settings included — sits under the workspace topbar:
    brand, crumb trail, ⌘K search, notifications bell, account menu. The instance surfaces
    behind those tiles sat under nothing. Opening "Users & access" or "Insights" replaced the
    whole app with a bare page whose only navigation was an in-page back button, and a
    notification arriving while you were in settings had nowhere to appear. **(a)** The
    `palette-shell` layout — already the one mount point for the ⌘K shortcut on those routes —
    renders `PageTopbar` above the page: the brand links Home, the crumb reads `Home ›
    <page>` with `aria-current` on the leaf, and the trigger, bell and menu are the SAME
    components the workspace topbar and Home render (the palette trigger was hoisted into
    `palette-trigger.tsx` so the two headers cannot drift). **(b)** The pages drop their
    in-page back buttons ("← Projects", "Home"): the brand and the crumb root are that
    navigation, and the board's settings page has never had one. **(c)** Which routes take
    it is a list, `standalonePageLabel` in `shell/nav.ts` — `/org/settings` and `/insights`
    today. `/profile` and `/notifications` are deliberately excluded: both render their whole
    surface inside a `showModal()` overlay that covers the viewport, so a header behind one
    would be a dimmed sliver. `/controller` is excluded too — it carries its own identity
    header (name, model, scope) and a full-height layout that scrolls inside itself. **(d)**
    The layout's loader reads nothing at all on a route with no header, so the excluded three
    cost exactly what they cost before and their own guards stay the only ones that speak;
    `/org/settings/audit-export` moved OUT of the layout, being a file response with no
    component. Two things the live run taught, both pinned: a revalidation is a single-fetch
    data request (`/org/settings.data?tab=resources`), so the loader normalises that pathname
    before asking whether this route is a page — and the SHAPE of the layout's tree is decided
    by the route alone, never by loader data, because the first version swapped the shell for
    a fragment when a revalidation came back without a header, which unmounted the page and
    closed the file browser an admin had open mid-edit. One thing came free: the standalone
    pages now render inside Home's own page shell (`.home`), which is what makes the body
    scroll — `/insights` had rendered straight into an `overflow: hidden` body, so anything
    below the fold was unreachable.
    (`features/shell/page-topbar.tsx`, `palette-trigger.tsx`, `nav.ts`;
    `routes/palette-shell.tsx`; the 1080px chip tier in `app.css` is scoped to
    `button.top-search .kbd` — the trigger — rather than to one header.)

146. **A per-person backend refusal is not an instance fault (owner, 2026-09-06, pass 35).**
    `/resources/health` reports INSTANCE facts. Since ruling 127 an agent-backend credential
    belongs to a PERSON, so "Claude refused" is a statement about one member's account, not
    about this deployment — and `health-snapshot.server.ts` was still pushing
    `credential:<backend>` and `quota:<backend>` into `degraded`, which made
    `?probe=readiness` answer **503 for the whole instance** because somebody's key expired
    or their window was spent. An orchestrator then drained traffic from an instance that
    was serving everyone else perfectly well. Those two entries are removed. **(a)** The
    readings are NOT lost: they stay in the health response body under `quota`, and they are
    already rendered per person on **Insights** (the account label, the refusing run, the
    provider's own words) and on **Profile**, which is where a fact about somebody's account
    belongs. **(b)** The only instance-level backend fact remains
    `backends.<b>.connectedUsers` — a count, never a verdict, and zero is not degraded
    (R17-5). **(c)** This SUPERSEDES the F32-4/F32-9 decision to treat a refusal as degraded;
    that decision was correct when a credential was deployment-wide and is wrong now. It does
    not touch the watcher, lock or disk entries, which are genuine instance facts.
    (`server/ops/health-snapshot.server.ts`; the contract in `routes/resources.health.ts`.)

147. **A primary that creates or saves stays enabled until the request starts (owner,
    2026-09-06, interface review).** A submit button that was `disabled` while the form was
    incomplete gave a click no feedback at all, dropped out of the tab order, and could not
    explain itself through a `title` no browser opens on a disabled control; the
    dimmed-but-clickable `aria-disabled` variant told readers the button did nothing. Every
    create/save primary now follows one contract. **(a)** Only a request in flight disables
    it (`busy`, painted by the sheet's `aria-busy` rule). **(b)** A submit on an incomplete
    form is REFUSED on the client: the message the surface already carried is inserted as a
    fresh `role="alert"` (a new element each time — readers announce an insertion, not a
    role flip on unchanged text), the first unmet field is marked `aria-invalid` and
    described by that message, and focus moves to it (or to the first empty control where
    the surface has no per-field map). **(c)** A pristine form is never accused: the marks
    appear only after a refused attempt, and a refused attempt never turns into a request.
    **(d)** Two gates are NOT this rule and keep `disabled`: a save with nothing changed
    (`dirty`), and a typed-name confirmation on a destructive action, which is a safety
    interlock, not validation. Ruling 150(e) says where a refusal about a COMPLETE form goes.
    Applies to the
    New task and New project modals, `/login` (whose action returns `{ error, field }`), every
    org-settings `MiniModal`, the repository-repair dialog, the S3 audit target, the task
    page's agent run starter (an empty picker is refused with the combobox marked and
    focused), the project's Add member modal (a `MiniModal` since ruling 148(b)) and the agent
    profile editor.
    (`ui/`-adjacent idiom in `features/org-settings/mini-modal.tsx`; the field rule in
    `app.css` `.field input[aria-invalid="true"]`.)

148. **Profile pass: four owner findings (owner, 2026-09-06).** **(a)** Side-by-side panels end
    on one line. A 2-up settings grid (`.profile-cols`, `.policy-cols`) stretches its rows,
    and the last panel of a stacked column (`.profile-col`) fills to the column's bottom, so
    the two columns of Profile never end at different heights. A feed beside a short panel
    (`.activity-cols`) is exempt: stretching the panel to the feed's height only produces a
    tall empty box. **(b)** Change password is a button that opens a modal, never a form
    served inline: a "Password" row on the Profile card, under the sign-in facts, opening the
    org-settings `MiniModal` under the ruling 147 contract (length and match are refused with
    the field named and focused; a server refusal lands in the same alert). **(c)** The
    in-app "Reduce motion" preference is REMOVED with its `set-motion` intent, the
    `user_prefs.motion` key, `<html data-motion>` and the `[data-motion="reduce"]` kill
    switch. The OS `prefers-reduced-motion` setting is the one reduced-motion signal,
    honoured by the sheet's targeted rules (entrances fade, the live pulse stills). This
    narrows ruling 13's Appearance panel. **(d)** Warning surfaces take GitHub's treatment.
    Light: `--amber-light #fff8c5` (its attention fill; mixed into the surface it is the
    classic pale-yellow flash) with `--amber-dark #735c0f`, the dark olive it prints that
    flash in. Dark: `--amber-light #3a3019`, `--amber-dark #d29922` (its attention
    foreground), and the warning boxes (`.cred-warn`, `.archived-banner`, plus the board's
    attention notices under ruling 150(b)) print their sentence in `--fg` with amber only on
    the icon, border and fill; yellow text on brown is gone everywhere the pair is used.
    Ruling 150(a) puts the error boxes on the same split. Also from the pass: the close × on every modal head and
    the page overlay is one borderless circular control, and the unconnected badge on the
    agent and GitHub cards says "not connected" instead of a "−" that read as a collapse
    control. (`app.css` ruling-148 section, pinned in `app.css.test.ts`;
    `features/profile/profile-page.tsx`.)

149. **Destructive controls take GitHub's danger button (owner, 2026-09-06).** A destructive
    control (delete, remove, revoke, archive, disconnect, sign out, discard, force-accept) is
    a NEUTRAL button whose label is red, and that fills red on hover with a white label: at
    rest the surface fill and `--border`, the label in `--danger` (`#cf222e` light /
    `#f85149` dark, GitHub's danger foreground); on hover `--danger-fill` (`#a40e26` /
    `#da3633`) under `--on-danger`. The tinted pink face it replaces read as a disabled or
    decorative control. The same red carries the ghost danger button, the account menu's
    Sign out, the danger-zone panel border and icon, the KB browser's delete action, the
    danger label and the opt-in destructive row-remove hovers. `--coral-dark` /
    `--coral-light` stay the ERROR pair for text, pills and error boxes: `#cf222e` fails AA on
    the pink error fill and `#600000` reads as brown on a button, so a control colour and an
    error colour are two tokens on purpose. **Ruling 150(a) narrows that last sentence on
    dark**: inside an error BOX the pair carries the icon, border and fill while the sentence
    itself prints in `--fg`. The sweep that applied it across the app also
    re-applied ruling 148's classes repo-wide (equal columns, glyph badges, warning boxes,
    close controls, bare inputs and atomic live regions, ruling 147 primaries) and reported
    the inline-form candidates for a decision. (`app.css` `--danger*` tokens, `.btn.danger`,
    `.btn.ghost.danger`, `.menu-item.danger`, `.danger-panel`, `.fm-act.del`,
    `.flabel.danger`.)

150. **Where each tone lands: error prose on dark, attention on the board, and both ends of a
    stop (owner, 2026-09-06).** Five calls the ruling 148/149 sweep put to the owner, recorded
    together because two of them narrow the rulings above rather than extend them. **(a)** An
    error BOX prints its sentence in `--fg` on dark and keeps `--coral-dark` on the icon, the
    border and the fill: `.login-err`, `.form-err`, the MCP probe's `.rsrc-err`, and the
    acceptance/packet consequence row (`.obs.warn`, whose uppercase kicker is the tone carrier
    because it has no glyph). This NARROWS ruling 149's "`--coral-*` … stay the ERROR pair for
    text, pills and error boxes": a whole paragraph of salmon prose on a red wash was the
    other half of the problem 148(d) named for amber, and the two were decided in the same
    pass. Light is untouched — `#600000` there is already body-weight ink — and error TEXT
    outside a box (`.foot-hint.err`, the refusal lines, the violation counts) keeps the pair
    in both themes. **(b)** 148(d)'s amber treatment is not limited to `.cred-warn` and
    `.archived-banner`: a box that reports ATTENTION rather than a fault takes the amber pair
    too. The board's archived-filter caption and its "no stages yet" empty state
    (`.board-orphans.notice`) are attention; the unstaged-task and repository boxes rendered
    by the same component are faults and stay on the error pair. **(c)** The destructive
    row-action hover (`.stg-x`) is opt-in by NAME where position cannot identify the
    destructive control: org settings' user row ends on Remove, which takes it by
    `:last-child`, but Disable sits before it and signs the person out, so that one says
    `.destructive`. **(d)** A stop is destructive at BOTH ends. Interrupting a run or a
    controller turn discards work in flight, so the shared `LiveRunPanel` trigger wears ruling
    149's red label (`btn ghost sm danger`) and the confirm it opens keeps `ConfirmDialog`'s
    `danger` default. The inverse holds for a confirm that takes nothing away: dismissing an
    operator recommendation is recorded on the timeline and the operator may raise it again,
    so it is the one call site that passes `tone="primary"`. **(e)** A refusal about a
    COMPLETE form is answered inside the surface that refused it, never by a toast:
    `.toast-wrap` is an ordinary fixed element, so over an open `<dialog>` it paints under the
    backdrop and its live region is inert behind the modal. The project's Add member modal
    prints its already-a-member sentence as a `.form-err` alert in the dialog body, with the
    address field marked and described by it (ruling 147(b)'s shape, one fresh element per
    refusal). (`app.css`'s appended ruling-148(d)/149 blocks, pinned in `app.css.test.ts`;
    `features/runtime/runs-panels.tsx`; `features/org-settings/users-panel.tsx`;
    `features/project-settings/settings-page.tsx`.)

151. **Boundary always wins (owner, 2026-09-06, Q35-1; pass 35 F35-2).** A workflow
    boundary the project author declared is the contract every human reads on the
    Policy page and in `project.md`, and an operator grant cannot void it. `auto` is
    the only boundary `stage-transitions: direct` crosses; a declared `approval`
    boundary always routes to a recommendation a human applies, under either autonomy
    and either grant mode; a declared `human` boundary is refused to the operator with
    a sentence, and the terminal stage stays reachable only through acceptance
    (`operatorAcceptCompletion` answers a move into it under either gate). Rework
    moves on a failing task (R7-4) are unchanged. `transitionStage` enforces the same
    rule for any operator-authorized caller, so a `task.transition` row with `by:
    operator` and `boundary: approval` can never be written again. The full-autonomy
    notice, the profile modal hint, the Policy page's own closing note and the
    `transition_stage` tool text say so.
    (`task-actions.server.ts` `transitionStage`, `operator-actions.server.ts`
    `operatorTransitionStage`, `operator-toolkit.server.ts`, `create-profile-modal.tsx`,
    `policy-page.tsx`.)

152. **Coordination cost is a product cost (owner, 2026-09-06, Q35-5 and Q35-15; G35-4,
    G35-5).** **(a)** An operator turn may cross consecutive `auto` boundaries in one turn:
    the transition reply names the next boundary, and a transition made by a live operator
    run queues no fresh operator turn; the stranded-stage backstop covers a chain the model
    abandons. **(b)** Under a concurrency cap, coordination has its own lane: operator and
    controller turns are admitted up to one slot per four of the cap beyond it (minimum
    one) and are promoted ahead of queued delivery runs. The cap itself bounds the
    DELIVERY runs (`primary`, `reviewer`) and the instance holds at most cap plus lane runs
    in all, so a live operator turn never costs a build its slot while an operator turn may
    borrow a cap slot no build is using. The lane's own slots are unconditional; past them
    the borrow lasts only while no build wants the slot back, so a freed slot goes to a
    parked build once coordination already holds its whole lane (without that, coordination's
    bound contains delivery's and a coordination backlog starves the cap's own runs
    outright). The lane is derived from `maxConcurrentRuns` (`coordinationLane`), not a
    second setting, and the org-settings control prints the derived number rather than the
    rule it came from, because the rule names the wrong lane at every cap that is not a
    multiple of four ("Cap N: up to N agent runs at once, plus M slots for operator and
    controller turns so a decision is not stuck behind the builds it is about."). **(c)** No dispatch
    starts on a backend the instance already knows is spent: a dispatch aimed at a backend
    whose exhaustion record has not passed its reset instant (or is younger than 30 minutes
    when the instant is unknown) is held, recorded on the timeline with an audit row, and
    re-scheduled for the reopen time; the provider's wall-clock sentence is read in the
    process's own time zone, the zone the CLI printed it in. A hold is not a decision
    packet and costs no operator turn. As shipped, refined in this pass's own review: the
    hold is scoped to the account the dispatch would bill (ruling 146 — a refusal is a
    statement about ONE person's account, so a record naming another person holds nothing
    here, and a record naming nobody holds every dispatch on that backend); every dispatch
    door reads it through one `assertDispatchNotHeld`, the resume branch of an `@mention`
    included, ahead of the MCP pre-flight and skill re-mount a refused run would pay for; a
    repeat dispatch inside one window reuses the pending `run-agent` occurrence instead of
    minting a second, so a window costs one retry per profile and a newer directive replaces
    its prompt; `operatorDispatchAgent` answers a held dispatch as `noop` rather than
    throwing, because the Codex plan executor abandons the rest of a paid turn on a throw;
    and resolving the quota or auth packet option that states the window has reset (or that
    the account changed) retires that backend's exhaustion record, so the option's own
    promise can be kept. (Pass 35: (b) in `run-service.server.ts`
    `canAdmit`/`drainRunQueue`, `instance-settings.server.ts` `coordinationLane`,
    `org-settings-page.tsx` `RunConcurrencyControl`; (a) and (c) in the operator actions
    and the backend-quota hold of the same pass.)

153. **Controller parity for schedules and template defaults (pass 35, G35-1 and
    G35-2).** The controller schedules and cancels a task's future run with the tier
    the task page needs (`run-agents`): `schedule_task_action` takes the operator or a
    deployed profile id, `delayMinutes` (1 to 40320) or an ISO `dueAt` under the same
    bounds and sentences as the task page's form, and writes the entry to `task.md`
    with the `<email> · via controller` label; `cancel_task_schedule` retires a pending
    entry and answers `[noop]` for one that is not; `get_task` lists the pending
    entries. `save_global_agent` takes a template's default `model` and `effort`,
    checked by name against its backend (ruling 139): omitted keeps the stored value,
    `""` clears it, and a backend switch whose stored model belongs to the other
    backend clears the model and says so. `deploy_agent` and the library deploy take
    the template's effort when no override is given and the backend offers the tier;
    a definition-less deployment resolves it live. Names are stored as the person
    meant them (U35-1): the five XML entities and numeric references are decoded
    once, ids derive from the decoded text, and a name still carrying angle brackets
    or control characters is refused. (`controller-toolkit.server.ts`,
    `gagents.server.ts`, `agent-profile-actions.server.ts`, `shared/names.ts`.)

154. **An org admin may link a GitHub handle (pass 35, G35-3).** On a deployment without
    GitHub sign-in the only writer of `users.github_handle` was OAuth, so ruling 68 was
    unreachable: every GitHub approval landed as `unlinked_handle` and the refusal sent
    people to a profile card that offered nothing to connect. The Edit-user modal under
    Users & access takes a handle for local and Google accounts (`updateOrgUser`, one
    normalizer in `shared/github-handle.ts` shared with the OAuth provisioning); a
    GitHub-signed-in account keeps syncing it from the provider and refuses a typed one.
    The handle is lowered, must be a GitHub username, is unique among enabled accounts
    (a duplicate is refused naming its holder, since the verdict path fails closed on
    one) and the change is audited (`org.user.github_handle.set` / `.cleared` with the
    previous value). Every writer of the column keeps that invariant, not just the admin
    door: a GitHub sign-in is the authoritative claim on a handle, so it takes one an
    admin linked elsewhere and the losing row is cleared and audited with the reason;
    enabling an account whose handle was linked elsewhere while it was disabled is
    refused naming the holder. A person cannot set their own handle, because the verdict path
    counts approvals by it; their profile shows an admin-linked handle as
    `@handle · linked by an org admin`. The `unlinked_handle` refusal names both doors.

155. **An active link's wait is its task's list (pass 35, F35-3; amends 131(c)).** Once a
    goal link has started a task, the task's `blockedBy` is the wait and the goal file's
    `links[].blockedBy` mirrors it on every change (human, controller, operator or engine
    release), so a retried link is born on the wait the record last held. `edit_link` on an
    active link may change `blockedBy` only, forwarded to the task's writer after the
    chain's own order rules have passed (the task's writer does not carry them). Live, a
    controller `update_task {blockedBy: []}` released KNC-3 while `goal-3` link 1 kept its
    declared `goal-2 link 6` and the Goals panel printed "waits on" for a task that was
    running; the controller saw the stale record and `edit_link` refused it as active.
    (`mirrorLinkWait` in `app/server/tasks/dependencies.server.ts`, called by
    `setTaskDependencies` and `releaseTask`, convergent: it writes only while the link is
    `active` and carried by that task and the lists differ, with the goal timeline line
    "Link 1 (Log view) now waits on nothing: KNC-3's list was changed by arda@viberr.dev.";
    the `edit_link` arm in `goal-actions.server.ts` forwards after the goal-file lock and
    refuses a title or goal on an active link by naming the task.)

156. **A template edit says where it did not land (pass 35, F35-7; owner, Q35-7,
    Q35-8, Q35-11).** A project's deployment is its own copy of the template's grants,
    taken at deploy time, and the template's writer does not reach into it. So every
    template save names each non-archived project whose copy no longer carries the
    template's grants and what is missing or extra, and offers the propagation:
    `propagate` on `save_global_agent`, the "copy these grants" box on the org modal,
    or "Use the template's grants" on the project's Agents page. Propagation REPLACES
    the copy's three grant lists (a grant a project added on its own is dropped and
    the reply says so) and never touches its capability policy, model, backend, stages
    or persona; it runs through one writer (`template-propagation.server.ts`) and
    records `project.agent_profile.resources_synced` per project. Only an org admin
    may propagate, from any of the three doors; a project admin sees the divergence
    marker with the exact difference and asks. The roster marks a copy whose grants
    differ from its template (`templateDrift`); the OBS-7 `customized` flag stays an
    identity signal and is not widened. The org modal's save toast composes its
    clauses with middle dots, never a dash.

157. **A hold ends when someone starts work (pass 35, F35-8; owner, Q35-9, Q35-10).**
    A stored `blocked` with no open packet and no dependency list is a hold (the
    `hold_runtime_debug` decision, the refused arm of a collision ceremony), and a hold
    is lifted on the record by a person starting the operator (Run operator, an
    `@operator` comment, the controller, a schedule they set) or by any dispatch that
    starts a run: `readiness: ready`, a "Hold lifted" note naming who or what started
    the work, and `task.hold.lifted`. The lift is not a claim that the cause is fixed:
    the operator re-checks and opens a new packet when the block stands, as
    `block_on_policy` already promises. Machine triggers and boot recovery lift
    nothing; an open packet keeps the withdrawal paths as the only lift; a dependency
    list keeps ruling 131's floor. The display never says blocked and agent working
    together: a packet-less, list-less stored block carried by an agent renders "agent
    working". (The record half is implemented by the operator and task actions of the same
    pass; the display half is `deriveDisplayReadiness`'s fourth argument, `carriedHold`, read
    from the STORED readiness and the dependency list, so a diagnostics floor and a dependency
    hold keep reading blocked.)

158. **No process but the server opens a live root's `projection.sqlite`; every other
    reader copies first (owner, 2026-09-06, Q35-14; pass 35 F35-9).** The writer lock
    decides which case applies. Pass 34 saw the server die with SIGBUS (exit 135) one
    second after a host-side `sqlite3 -readonly` over the bind mount and wrote the rule
    "inside the container, read-only"; on 2026-09-06 at 18:40:29Z the same exit followed
    an in-container `readOnly: true` reader by one second, and boot recovery interrupted
    23 runs and re-fired 23 operator turns. The side of the boundary was never the point:
    a second connection maps the WAL index (`-shm`) the server has memory-mapped, and over
    VirtioFS the open path's lock probe on that file is unreliable, so a reader can
    truncate it under the server. **(a)** `openDatabaseReadOnly` asks `judgeDataRootLock`
    for the PRESENCE of `state/writer.lock`, and nothing else: with a lock file there at
    all, whatever it names, it copies `projection.sqlite` and
    `projection.sqlite-wal` (never the `-shm`) to `state/tmp/reader-<pid>/`, opens the
    COPY read-write so SQLite recovers the copied WAL into it, and removes the directory
    on close; a dead reader's directory is swept by the next reader. Only a root with no
    lock file at all is opened in place, read-only. Deliberately NOT the boot's verdict
    (amended in review, same pass): `classifyLock`'s two staleness tests are both
    pid-namespace-local, and `compose.yml` pins `hostname: viberr` for every container
    built from it, so a reader in a SECOND container over one data root would call a
    genuinely live holder stale and open the live file. The boot survives that ambiguity
    on two backstops a reader has not, its own `bootId` and F18-5's ownership re-check;
    a reader has only the cheap direction, and a copy it did not need costs disk where
    a wrong "stale" costs the server. It returns a `ReadOnlyDatabase`
    handle (`db`, `path`, `snapshot`, `close`), never a bare connection, so the copy
    cannot outlive its reader. `npm run backup` runs its `VACUUM INTO` on that handle,
    the artefact stays one self-contained file, and the manifest's first `contains` line
    says which way the projection was read; `npm run keys -- status` says so on stdout.
    **(b)** The runbook and `deployment.md` state the rule in words ("copy first, never a
    second connection to a live database, on either side of the container boundary"),
    replace the pass-34 in-container `readOnly: true` example with the copy recipe (`cp`
    the file and its `-wal`, open the copy, throw it away), and name `/resources/health`
    and the controller's in-process readers (`viberr_ops`: `instance_health`,
    `read_run_log`, `read_store_doc`; `viberr_controller`: `inspect_audit_log`, `get_task`)
    as the reader to ask before copying anything. `app/shared/docs/runbook-db-read.test.ts`
    pins both pages: no `sqlite3` invocation and no fenced `DatabaseSync(` opens
    `state/projection.sqlite`. Amends D34-1's rule; the writer-lock rulings (B-FD1, F18-5,
    F20-8) are unchanged, their verdicts are now read by readers too. (`judgeDataRootLock`
    in `app/server/db/data-root-lock.server.ts`; `openDatabaseReadOnly` and
    `ReadOnlyDatabase` in `app/server/db/sqlite.server.ts`; `createBackup` in
    `app/server/db/backup.server.ts`; `scripts/secret-keys.ts`.)

    *(Addendum, owner 2026-09-06, Q35-16; pass 35 U35-7: **a restart is a reason, not an
    actor, and the store says which.** The same 18:40:29Z restart's boot recovery wrote
    every orphaned run as `state: error` with the literal `"restart"` in `interrupted_by`,
    so the run projection looked "restart" up as a user, the Agent-logs pill read
    "continuity error", and Insights counted all 23 as failures although 17 were queued
    runs that never executed a turn. A human interrupt already wrote `interrupted`.
    **(a)** `finalizeOrphanedRuns` and the operator drive's own orphan sweep write
    `state: interrupted` with the new nullable `agent_runs.interrupted_reason`
    (`'restart'`, CHECK-constrained; baseline edit, no migration); `interrupted_by` is a
    `users.id` or null and nothing else, and a person who interrupted a run the restart
    then finalized keeps their id beside the reason. **(b)** The run projection carries
    `interruptedReason`; the pill reads "interrupted · by a restart" and the footer
    "interrupted by a restart; the operator was re-invoked" (a controller turn: "the
    conversation carries a note"). **(c)** Insights keeps such runs in `interrupted`, never
    in `error`, and drops an interrupted run that never started (`turns = 0`, no
    `started_at`, a person's stop of a queued run included) from the completion-rate
    denominator; the card's stopped count names how many a restart stopped and how many
    never started, so the five counts still reconcile with the total. **(d)** The
    engaged-agent card on the task page says "queued" for an engagement whose live run is
    still waiting for a slot and "running…" only once it executes; the loader ships
    `liveAgentRuns` (profile id plus lifecycle) instead of bare profile ids.
    (`finalizeOrphanedRuns` in `app/server/runtimes/run-recovery.server.ts`; the
    `restartOrphan` arm of `runOperator` in `operator-run.server.ts`; `interruptedByClause`
    in `app/features/runtime/runs-helpers.ts`; `getInsightsSummary` in
    `app/server/insights/insights-query.server.ts`; `liveAgentRunLabel` in
    `app/features/task-detail/execution-profile.tsx`.)*

159. **Every path Viberr hands an agent is absolute, and a delivery that would publish
    the store's layout is refused (2026-09-06, pass 35 F35-10).** A store-relative path
    (`projects/<slug>/tasks/<key>/attachments`) is a display form for humans, never an
    instruction: the run's cwd is the repository checkout two levels below that folder,
    and an agent told the folder was "reachable from your working directory" created it
    inside the clone, committed it, and the delivery pushed Viberr's store layout into
    the customer's repository (KNC-9, GitHub tree bf52bba). **(a)** The "Posting files
    on the task thread" section, the browser section and the workspace contract's one
    exception print the ABSOLUTE `taskAttachmentsDir` (inside the container `/data/...`
    is real; on bare metal it is the data root's own absolute path) and say it is
    outside the repository checkout and never committed; `SpecialistPersonaInput.browser`
    and `.attachmentsDrop` carry `attachmentsDir`, and `AnalyzePromptInput` carries
    `attachmentsDropDir`. Amends 96's `attachmentsDropRel`. **(b)** `pushWorkspaceBranch`
    reads HEAD's tree under `projects/<slug>/tasks/` after the delivery auto-commit and
    refuses a branch that carries any such path (`push_refused_store_layout`, the paths
    named); `performDelivery` reports it on the task as a delivery refusal in the scope
    refusal's shape (`store_layout`, no PR opened) and the operator's reply names the
    remedy (re-prompt the agent to remove the folder). A branch that published the
    layout under an older prompt is refused too, until a person removes it. The tree is
    read NUL-delimited (`git ls-tree -r -z`): git quotes any path holding a non-ASCII
    byte, and a quoted line matches no prefix, so an accented screenshot inside the
    stray folder read as an EMPTY tree and the push went through. Both push doors run
    the read: `updateWorkspaceBranchFromBase` (the acceptance-time base refresh and the
    operator's `update_branch_from_base`) pushes the whole workspace head, so the folder
    a refused delivery left committed on the local branch would have reached origin on
    the next refresh; it answers `store_layout` before it fetches or merges, and the
    branch is untouched. **(c)** The
    completion pipeline scans the run's workspace for a stray
    `projects/<slug>/tasks/<key>/attachments` folder and posts a `policy` line naming
    it, the files it holds and the real folder, so a person learns why an attachment is
    missing. (`attachmentsDropSection` / `browserPersonaSection` in
    `app/server/tasks/specialist-browser-mcp.server.ts`; `storeLayoutFilesInTree` in
    `app/server/github/push-workspace.server.ts`, called from both push doors; the
    `store_layout` refusal of `updateWorkspaceBranchFromBase` in
    `app/server/github/update-branch.server.ts`; `warnStrayAttachmentsFolder` and the
    `store_layout` arm of `performDelivery` in `app/server/tasks/task-actions.server.ts`;
    `findStrayAttachmentsFolder` in `app/server/files/task-attachments.server.ts`.)

160. **A pull request closed without merging is a human decision about the task
    (owner, 2026-09-06, Q35-12; pass 35 F35-11).** Viberr never opens another PR for that
    branch until a person has answered the recovery packet; only a merged PR clears the
    way for a fresh review PR. Live (KNC-23) the owner closed PR #10 with a rejection
    comment at 19:33:19Z, the operator's base refresh moved the branch, and the delivery
    at 19:33:44Z opened PR #26 over it: `openTaskPr` treated a closed-unmerged PR like a
    merged one (DG-1's "fall through to a fresh PR"), the create path overwrote the
    cache, and the reconciler's R8-6 alarm (which keys on the cache's transition into
    `closed`, and finds a closed PR by branch name only while the branch still stands
    at its head, F26) never fired: no event, notification or packet named the person's
    decision. **(a)** `openTaskPr` splits the terminal cases. MERGED keeps DG-1. A cached
    `closed` PR whose `pr.closure` no person has answered refuses `closed_by_human`
    before GitHub is asked; a cached live PR that GitHub now reports closed and unmerged
    is handed to `reconcileTask`, then refused the same way, naming the PR and the
    closer when GitHub names one (`closed_by` on the issue payload). A cached `closed`
    carrying NO closure record is a close nobody surfaced (the workspace reconcile also
    writes that state, from `gh pr view` in the agent's clone, and knows neither the
    closer nor the surfacing): it is repaired through `reconcileTask` first, then refused
    on what that pass recorded. **(b)** The reconciler stays the one writer of the
    closure record
    (`pr.closure: {at, by, answered}`) and of the R8-6 note, inbox alert and
    `pr-diverged` wake: when the branch listing names nothing and the task's cached PR
    is live (or says `closed` with no closure record), it reads the cached NUMBER directly
    and records a settled answer, so the close a push overtook transitions in the
    delivery's own turn and once. The note, the inbox alert and the wake fire the pass the
    closure RECORD is written, not the pass the state changes: keyed on the state alone
    they were swallowed by the workspace reconcile that ran one step earlier. **(c)** A
    person resolving any packet while the PR stands closed stamps `closure.answered`, and
    creates the record when none exists (`by: null`, never a guess) so the refusal is
    always answerable
    (the operator's withdrawal stamps nothing); a reopen on GitHub drops the closure with
    the closed state. **(d)** `performDelivery` reports `closed_by_human` on the task
    (one sentence, `closedByHumanDeliveryText`, on the operator's reply and the timeline;
    the Deliver control states the same refusal before the click from its own client-side
    `CLOSED_PR_DELIVERY_REFUSAL`, a hand-kept pair with the server's sentence in the shape
    `DIVERGED_PUSH_REFUSAL` already set, since the server's lives in a `.server` module),
    and the `deliver_for_review` description says a closed PR is a person's decision and
    names the packet. (`openTaskPr` in
    `app/server/github/pr-open.server.ts`; `readTerminalPrByNumber` and `readPrCloser`
    in `app/server/github/pr-linker.server.ts`; the closure stamp in
    `app/server/github/github-reconciler.server.ts`; `closedByHumanDeliveryText` and the
    `resolvePacket` stamp in `app/server/tasks/task-actions.server.ts`.)

161. **A revision is delivered once it has left the workspace (owner, 2026-09-06, Q35-13;
    pass 35 G35-6 and U35-8).** Until a pull request tracks the branch, a stranger's pull
    request stands on the branch name, or a delivery push has published the head, the branch
    is the task's local draft and a person may discard it; the discard retires the
    revision. Live (KNC-21) the agent's completion report registered `workRevision`
    (`kind: delivered`, 18:56:57Z) fourteen minutes before the delivery push was refused
    non-fast-forward, and ruling 77's authoring gate (`hasDeliveredWork = workRevision !==
    null`) then refused `discard_branch` on exactly the branch the kind exists for: a
    reported head counted as a delivered one, and the only door left was archiving the
    task with `deleteBranch`. **(a)** The gate keys on `revisionLeftWorkspace`: `pr`
    (live or settled), `github.unownedPr`, or the new `workRevision.pushedAt`, which
    `performDelivery` stamps on the revision whose head the push published (`pushed`, or
    `up_to_date` with that head). `github.commits` is not evidence: the workspace
    reconcile writes it from the local clone. The refusal names the real reason ("PR #n
    tracks `branch`", "an unowned PR #n stands on the branch name", "revision `sha` was
    pushed to origin at …"). **(b)** A confirmed discard retires the revision in the same
    write that clears `branch`: `workRevision.kind: discarded`, verdicts kept as history,
    `validation` re-derived to `none`; the outcome note says "Revision `rev_…` is retired
    with it", and the audit row `task.branch.discarded` carries `retiredRevisionId`.
    Every reader that means "the revision under review" reads through
    `activeWorkRevision` (null for a discarded record): the derived validation, the
    verdict binding (a reviewer's verdict never pins to a retired head), `nextWorkRevision`
    (a re-created head mints a fresh id even for the same tree), the acceptance gates, the
    projection's `work_revision_sha`, the reconciler's provenance and adoption tests, the
    reviewing agent's subject, and the delivery's no-change arm. A `verified` revision
    names the base sha, not the branch, and is never retired by a discard. **(c)** The
    remote holds what it holds (U35-8): the reconciler records `github.foreignHead {sha,
    prNumber}` whenever the branch head is not proven this task's and origin holds
    something (a stranger's PR, or commits ahead of the base with no delivery of this
    task behind them), and drops it the pass the head is proven; "delivery" here is (a)'s
    departure test and not the reported revision the F31-1 commit footprint keys on, or
    KNC-21's own shape (a revision minted on the branch, the push refused) would count as
    proof and disclose nothing; the archive ceremony's
    delete-branch dialog says "origin's `branch` carries commits this task did not author
    (head `sha`, pull request #n stands on it); deleting it removes them too" before the
    button, the operator's `get_task` carries the same fact, and the toolkit tells it to
    name it in the option text. `deleteTaskRemoteBranch` reads the ref's head before its
    DELETE, records it on `github.branch.deleted` (`sha`) and in the timeline ("Its head
    was `sha`"), and the archive's `task.branch.discarded` row records both heads
    (`localSha`, `remoteSha`; a local-only discard records `remoteSha: null`). The
    operator's push-conflict reply and the `discard_branch` description say the same
    rule: a refused push means the revision never left the workspace, so the discard may
    be offered when the person's choice is to throw the draft away, never as the way to
    clear the remote. (`activeWorkRevision`, `revisionLeftWorkspace` and the `foreignHead`
    record in `app/schemas/task-file.schema.ts`; the gate and
    `revisionDepartureSentence` in `app/server/tasks/operator-actions.server.ts`; the
    stamp, the retirement and the two-sha row in `app/server/tasks/task-actions.server.ts`;
    the foreign-head write and the pre-delete read in
    `app/server/github/github-reconciler.server.ts`; the dialog row in
    `app/features/task-detail/decision-packet.tsx`.)

162. **The acceptance gate's verdict is computed once and read everywhere a person or the
    operator is invited to accept (owner, 2026-09-06, Q35-17 and Q35-18; F35-12, G35-5
    addendum (d) and (e)).** No surface offers an acceptance the gate will refuse. The
    GitHub-fact half of the gate (an unpushed delivered revision, ruling 135, then a
    conflicting pull request) is one function, `mergeReadinessRefusal`, and the whole stack
    reaches the operator as `get_task`'s `notAcceptableReason` beside `pr.mergeable`: a PR
    the gate would refuse cannot be recommended for acceptance. The MOVE into the
    acceptance-boundary stage reads the pull-request half ALONE (`mergeStageEntryRefusal`
    over `mergeReadinessRefusal`: a conflicting pull request, or an unpushed delivered
    revision), never `notAcceptableReason` (corrected in this pass's review: that field is
    `acceptanceRefusalFor`, whose third gate is "this task is not at the boundary yet", so
    it stands on every task short of the acceptance stage and its own remedy is that very
    move; the three shipped texts that keyed the move on it told the operator a legal,
    required move would be refused). Merge means mergeable: while the pull request
    conflicts the task stays at the work stage where the conflict packet is the path. The task page
    reads the same verdict: the recommendation card keeps its Apply (ruling 147's shape)
    and prints the refusal as a keyed alert, the accept dialog prints it above a disabled
    confirm, the GitHub card wears the "conflicts" pill, and the reconciler withdraws a
    pending `accept_completion` card when `mergeable` flips to conflicting. A post-gate
    GitHub merge refusal (405) re-reads the pull, records `mergeable: conflicting` and
    prints the gate's own sentence. **The base refresh happens once, at acceptance time**
    (amends 132): the ceremony brings the branch up to date through the same workspace
    merge `update_branch_from_base` performs, re-runs the gate and merges in one step,
    recording the refresh (`baseRefreshes`, `github.branch_update.acceptance`); a conflict
    found there refuses with the gate's sentence and records it. Operators stop refreshing
    at the acceptance boundary: the tool refuses there ("... the branch is brought up to
    date once, at acceptance time, and merged in the same ceremony"), except on a PR
    GitHub already reports conflicting, where its job is to record the conflict list and
    open the packet whose redirect carries that list to the resolver.
    (`mergeReadinessRefusal` and the acceptance ceremony's refresh in
    `app/server/tasks/task-actions.server.ts`; `mergeStageEntryRefusal` and the snapshot's
    `notAcceptableReason` in `app/server/tasks/operator-actions.server.ts`; the tool texts
    in `operator-toolkit.server.ts` and `app/server/seed/assets/operator.definition.md`;
    the refusal alert and the disabled confirm in `app/features/task-detail/`
    `decision-packet.tsx` and `task-detail-page.tsx`; the acceptance-time refusal of
    `update_branch_from_base` in `app/server/github/update-branch-operator.server.ts`.)

163. **A revision that changes after a verdict returns the task to the review stage
    (owner, 2026-09-06, Q35-19; F35-13).** No task waits at Merge for a verdict nobody can
    give there. "The review stage" is where the task's required reviewers can run, and only
    a task standing AT OR PAST the structural review stage is ever moved (`verdictStageFor`,
    narrowed in this pass's review: null before that stage, because the task is still doing
    the work; null at the terminal stage; null when a required reviewer is eligible where
    the task stands; otherwise the nearest EARLIER stage where one is eligible; and when no
    required reviewer is deployed at all, the structural acceptance-boundary stage, and only
    while the task stands past it. Without the floor the backward scan reached from a WORK
    stage: the seeded reviewer declares Implementation and Review, so a delivery at a
    Validation stage between them walked the task back to Implementation, a stage that
    reviews nothing). Three doors return the task automatically, each with
    a `transition` event and a `task.transition` audit row: the operator's backward move
    on `validation: changed` (a rework move it performs itself, offered in
    `reworkStages` beside the `failing` license of R7-4), the resolution of a
    branch-conflict packet's redirect (`rework: true` on the option, the option's detail
    saying so before the person decides), and a delivery that moved the PR's head on a
    changed or failing revision (`via: delivery`). The operator's acceptance refusal on
    such a task names the way back: the rework move, and the person's stage picker on the
    task page. (`verdictStageFor` in `app/shared/workflow/verdict-stage.ts`, read by the
    operator's rework move and acceptance refusal in
    `app/server/tasks/operator-actions.server.ts`, by the delivery arm in
    `app/server/tasks/task-actions.server.ts`, and by the conflict packet's redirect in
    `app/server/github/update-branch-operator.server.ts`.)

164. **An option title is a promise the resolution keeps (pass 35, F35-14).** A packet
    option is resolved by its `kind` and never by its English title (ruling 7), so a title
    naming an act its kind cannot perform is a decision that does nothing. Two live ones:
    KNC-3's `custom` "Force-accept as admin without a fresh verdict" (2026-09-07 06:06:57Z)
    recorded the decision, re-ran the operator into a no-op behind the verdict gate, and
    ended with the operator asking the owner to press the button by hand; KNC-16's
    `redirect` "Move KNC-16 back to Review" (2026-09-06 20:53:26Z) moved nothing. Two new
    kinds make the promise keepable and one guard stops it being written anywhere else.
    `force_accept` runs `forceAcceptCompletion`, the function behind the task page's Force
    accept button: the same admin-only tier (`force-accept-completion`), the same
    disclosure ceremony (the card opens the dialog's force form, naming the skipped stages
    and the bypassed refusal), the same irreducible gate, and the same
    `task.acceptance.forced` record. `move_stage` carries `toStage` and runs
    `transitionStage({ manual: true })`, the stage picker's path: the same
    `approve-transition` tier, the same transition event and `task.transition` row, and the
    operator re-invoked at the stage the task lands on; the terminal stage is refused
    because moving there is an acceptance, not a move. Both perform their act AFTER the
    resolution write, so the packet is answered on the record first and a refusal lands as
    a plain timeline note rather than as an error over a decision that stands. The guard
    sits where options are authored (`operatorOpenPacket`, so both operator backends reach
    it): a send-back option (`custom`, `redirect`, `request_edit`) whose title or detail
    describes a force-accept, a move to one of this board's own stages, or an edit to an
    agent profile is refused, and the refusal names the kind that performs it, or, for a
    profile, the Agents surface a person uses (ruling 85 already says the operator points
    at that configuration and never changes it). The toolkit description and the operator
    definition carry the same sentence. As shipped the guard reads the option's own ACT,
    not its vocabulary, and it runs on both sides of the promise (refined in this pass's
    review): the movement verbs bind to one of THIS project's stage names, so the delivery
    idioms ("send the fix to review", "advance it") pass and a bare "send it back to the
    specialist" is not a move; the ruling-163 rework redirect is exempt, because it really
    does return the task to the verdict stage and says so; `toStage` is refused on any kind
    but `move_stage`, whose resolution reads no stage; a `move_stage` naming the stage the
    task already stands at is refused as a move that would move nothing; a `move_stage`
    whose TITLE names a stage other than its own `toStage` is refused, since the card shows
    the words and the resolution reads the id; and `force_accept` is refused on a task whose
    pull request a person closed without merging, which is decided rather than wedged
    (R16-3) and which no override can undo, the refusal naming `archive_task` and a
    delivering redirect instead. (`misdirectedOptionPromise`, `moveStagePromiseMismatch` and
    `SEND_BACK_OPTION_KINDS` in `app/shared/workflow/packet-options.ts`; the authoring guard
    in `operatorOpenPacket` and the two new kinds' resolution in
    `app/server/tasks/task-actions.server.ts` `resolvePacket`.)

165. **Connecting a different agent account retires the refusal Viberr observed on the old
    one (owner, 2026-09-07).** The Agent-accounts card kept "usage window spent · reopens
    21:30" after the owner signed the same backend into another account: the runs on the new
    account went through, and the notice contradicted them. A quota or credential refusal is
    evidence about the account that was billed (ruling 130(d)), and short of the provider's
    own reset instant a completed run was its only retirement, so a person who did exactly
    what the remedy asked (connect a different account or an API key on Profile → Agent
    accounts) carried the old account's verdict, and the dispatch hold that rests on it
    (ruling 152(c)), onto the new one until something happened to run. Now every write to a
    person's credential slot on a backend retires that backend's exhaustion and
    credential-refusal records when they name that person: a confirmed sign-in
    (`recordBackendLogin`), a pasted key the vendor accepted (`setBackendApiKey`), a
    disconnect (`disconnectBackend`) and an account removal (`retireUserBackends`), through
    one `retireBackendRefusalsFor` called from the store's own writers, so the driver's
    confirmation and an org admin's removal reach it without passing through the Profile
    action. The hold lifts with the record, so the next run on the new credential is the
    real probe rather than a wait for an instant the old account named. A record naming
    another person, or nobody (a row older than ruling 130(d)), is untouched: nothing here
    knows whose account it was about. Signing back into the SAME spent account retires it
    too, because Viberr never stores the vendor identity behind a sign-in (ruling 127) and
    cannot tell; one refused run re-records the window, which is cheaper than a notice that
    lies about a new account. The card and the Insights row name the second retirement
    beside the first. Extends rulings 130(d), 146 and 152(c), which already let a person's
    packet answer "I switched the account" retire the same record.
    (`app/server/runtimes/backend-quota.server.ts`, `backend-credentials.server.ts`; copy in
    `agent-accounts-panel.tsx` and `insights-page.tsx`.)

166. **Headless primitives may enter `app/`; utility classes may not (2026-09-08).** The
    "No Tailwind" prohibition in §UI porting rules stands exactly as written, and this
    ruling narrows rather than softens it. A survey of the whole UI against the ReUI/shadcn
    registry (1,294 elements across all twelve surfaces) found that the value those
    libraries market — listbox and menu semantics, typeahead, roving focus, dismiss layering
    — lives in *unstyled* primitive packages (`@base-ui/react`, `radix-ui`), while ReUI and
    shadcn add only a Tailwind skin on top of them. Of 1,293 mapped elements just 24 were
    worth swapping and 577 were net negative, so adopting the skin was never the trade; the
    behaviour underneath sometimes is. Therefore: a third-party UI package may be imported
    into `app/` **only** when (a) it ships behaviour, not appearance, (b) every element it
    renders is styled with class names `app/app.css` already defines, and (c) it lands
    behind an existing viberr component boundary (`app/ui/*`), so a revert is one file. No
    `tailwindcss`, no `class-variance-authority`, no `tailwind-merge`, no `lucide-react`, no
    `next-themes`, and `npx shadcn add` is not a viberr workflow — a registry component is
    read as a design reference the way `design/html-app` is, never installed. The
    orphan-class gate in `app/app.css.test.ts` is the enforcement and does not move: no
    utility class may enter a `className` in `app/`, and `CLASSLESS_BY_DESIGN` stays capped.
    A companion check fails any file that imports a primitive package and passes a
    Tailwind-shaped class, so the boundary is mechanical rather than remembered. Rulings 16
    (native `<dialog>` + `showModal()` is the only dialog mechanism) and the one-`Icon`
    rule are untouched and are the reason the dialog, toast, calendar and icon families are
    explicitly out of scope. (`app/app.css.test.ts`; the survey and its element-level
    evidence in the ReUI migration plan.)

167. **The task page carries no Permissions panel (owner, 2026-09-08).** The side column
    used to close with a panel that restated the viewer's role grants row by row — comments,
    task ownership, accepting completion, running agents, the review boundary — under a
    "V1 rules" tag, with a link to the project's Policy page. The owner does not want it.
    What a person may do on a task is said where they would do it: Current state carries the
    acceptance button and its refusal sentence, the owner seat carries Assign and Release,
    the run controls carry their own gating; the whole matrix is one click away on Policy,
    and the profile's "Your access" lists the same grants for the person. The panel, its
    `PolicyPanel` component, its `.policy-line` / `.perm-intro` rules and the
    task loader's `acceptanceAuthority` field (A6, pass 23 — read by nothing else on the
    page; the Review queue resolves its own) are removed. The pass findings that shaped the
    panel's copy — P14-GV-04 (the owner's acceptance authority named truthfully), E1
    (comments are members-only), E3 (the release-any grant), UX19-1 (no ruling ids in copy)
    — retire with it; the rules they described still hold and are enforced where they always
    were, server-side and on the Policy page.

168. **The board card states each fact once (owner, 2026-09-09).** A card in the Ready lane
    read `blocked` in its top slot, `Claude · Developer` on its owner line and `awaiting
    verdict` in its foot, above `waiting on you`, and the owner called the three redundant.
    They were: the pill, the verdict chip and the tag all said "a human must act", and the
    glyph and the word both said Claude. Three rules, on the board card and the list row
    only — the task hero is the detail surface and keeps every value:
    (a) *The demand is made once.* F15-09/R21-8 already had the readiness pill yield to the
    foot's "agent working"; it yields to a human wait tag too, for the values that ARE the
    demand or the baseline it supersedes — `input required`, `blocked` (a packet's hold; a
    dependency hold leaves `waiting` at none and keeps its pill, ruling 131), `goal edit
    pending`, `ready`. An inconsistency risk is a problem, not a demand, and accepted/merged
    are statuses: they keep the slot. The rendering choice is `readinessYields`
    (board-page.tsx), shared by the card and the row; the value stays
    `deriveDisplayReadiness`'s.
    (b) *Validation on the card is a problem or nothing.* The quiet tier — `awaiting verdict`,
    `validation healthy`, `no validation` — describes where the evidence stands; the card and
    the row draw only the fill tier (`validation failing`; `gate bypassed` is terminal and
    already withdrawn by C2). The "Blocked or waiting" filter matches `failing` only, so no
    card it selects goes unexplained. The tier is read from the vocabulary
    (`validationQuiet`, pill.tsx), never restated in a component.
    (c) *The agent line is the glyph and the agent's name.* The glyph is the backend, labelled
    for assistive technology and on hover; the text is the deployed profile's name (owner,
    2026-09-08: not its role), the role only for a profile no longer deployed. The backend's
    name as a word is gone from the line.

169. **The task hero's stage and status are labelled fields, and the status is one word
    (owner, 2026-09-09).** The hero read `Ready · blocked · awaiting verdict` and the owner
    asked what "ready" meant: "a task can't be blocked, ready, and awaiting verdict at the
    same time." Ready was the STAGE — the default workflow's second stage — drawn as a bare
    pill beside two status pills, and C5's status glyph on the readiness chip did not keep
    the classes apart. Two rules for the hero (the board card has its own, ruling 168):
    (a) *The stage and the status are fields.* Each wears the key the Current state panel
    already gives it — `Stage`, `Status` — as a small-caps label (`.hero-field-lbl`, the
    house field label). A stage named Ready, Blocked or Done can no longer be read as a
    status word.
    (b) *The status is one word.* Readiness and validation are different questions, but
    drawn as peers they contradicted each other. The readiness value is the status; the one
    quiet validation value that names an obligation — `awaiting verdict` — takes the slot
    only when readiness is `ready` (which said nothing about what for), so a held task says
    `blocked` alone and a task in review says `awaiting verdict` alone. `validation healthy`
    and `no validation` describe and stay off the hero, as on the card; `validation failing`
    is a problem and keeps its own pill. Nothing is re-derived: the status reads
    `deriveDisplayReadiness`'s value and the validation vocabulary's tier (`validationQuiet`).

170. **The GitHub trace sits at the top right of the task page, beside the goal (owner,
    2026-09-09).** The head spanned both grid columns, so the cell to the right of the hero —
    a panel wide and the goal tall — was empty, while the GitHub trace queued in the side column
    under Current state. The owner wants it in that cell, and Current state left where it is.
    So the head opens the main column alone (`grid-column: 1`), and the side column spans all
    three rows (`grid-row: 1 / span 3`) with the GitHub trace first, then Current state, then
    Details. Two facts make the rest of the page hold still: the side column crosses the `1fr`
    row, so its height sizes only that row and never the head's or the packet's (grid items
    spanning a flexible track are excluded from intrinsic row sizing), and the packet and main
    keep their cells. One order everywhere: the right column reads GitHub, Current state,
    Details on desktop, and the DOM — hence the phone stack, the Tab key and a screen reader —
    reads the same, because placement may seat regions but never reorder what a region
    contains (U7/U35-2's rule against `order`). The phone therefore meets the GitHub card one
    card before Current state; the title and the open packet still come first. Current state
    moves only by the difference between the GitHub trace's height and the hero's.

171. **The board card has one anatomy, whatever a task has (owner, 2026-09-09).** Two cards
    side by side read in two grammars: a human-owned task with no agent put its owner at the
    LEFT of the owner row, avatar, first name and "· owner", and left the right end empty; an
    agent-carried task put the agent at the left and the owner at the right as a small avatar.
    And the foot, one wrapping run, sent "waiting on you" onto a line of its own the moment a
    PR chip joined the branch chip. The owner: "whether or not of a task's info situation the
    task's view type shouldn't change." So every ingredient has one seat:
    (a) *The left seat is the carrier.* The engaged agent — the backend's glyph and the
    profile's name — or, when nobody carries the task yet, the seat itself: the agent tile
    dimmed (`.agent-glyph.none`) and "no agent", the way the foot says "no branch".
    (b) *The right seat is the owner, on every card and every list row.* The human owner's
    avatar with the name as its accessible label and title, or the empty seat — a ghost
    avatar labelled "awaiting owner" while an operator is assigned to find one, "unassigned"
    before that (the old left-seat fallback's two words). The owner's name is no longer
    printed on the card; it never was beside an agent.
    (c) *The foot is two cells.* The trace chip and the problem pills fill the left cell and
    wrap there; the status seat — the quiet cue, then the wait tag — is the right cell, the
    card's bottom-right corner regardless of what the left holds. `StateSignals` split into
    `StatePills` and `StatusTags` for it; the list row still runs both inline.
    (d) *One trace chip.* A PR supersedes the branch on the card: it is the stronger trace and
    implies the branch (the task page's GitHub trace shows both), and the narrowest lane
    (218px) cannot hold a branch name, a PR number and "waiting on you" on one line — the
    branch was shrinking to nothing beside them. Without a PR the branch name is the chip and
    yields to an ellipsis before anything wraps; without a branch the chip says "no branch".
    (e) *A narrow card reflows on its own width.* At the board's narrowest lane (218px — every
    lane, at 1440px with five stages) the foot cannot hold a trace chip and "waiting on a human"
    side by side, and a placeholder cut to "no…" is no placeholder. Under 210px of card content
    (`@container`, the sheet's one container query; it measures the content box, so this is a
    card under about 234px — the 218px lane's card has 187px inside) the foot is two rows for
    every card in the lane — the trace, then the status seat right-aligned — decided by the
    card's width, never by what the card holds, so a lane stays uniform; wider cards keep the
    one line ("no branch" and "waiting on a human" need about 208px together).

172. **The board card carries status, not planning metadata or history (owner, 2026-09-09:
    "cleanup other stuff like urgency, goal link, last activity from this board view").** Off
    the card and the list row: the metadata row — the priority flag, the labels and the due
    date (`.card-meta`, its rule removed); the "blocked by …" names a held task printed (ruling
    131(a)'s card chip — the readiness pill still says `blocked`, and the hero's wait chips and
    Details' "Blocked by" name the entries); and the "no activity · 4h" cue (pass 19's Gap-10 on
    the card — the "No activity" filter chip still selects those tasks and Current state dates
    them). What stays is what the card is for: the key, the title, the carrier and owner seats,
    one trace chip, the problem pills and the wait tag. The task page and the review queue keep
    the priority, labels and due date; nothing is lost, it is one click further in.

173. **The Cognipeer Agent SDK was evaluated and not adopted (owner, 2026-09-11).**
    `@cognipeer/agent-sdk` 0.10.2 was assessed against every run subsystem as a replacement
    for `@anthropic-ai/claude-agent-sdk` ^0.3.261 and `@openai/codex-sdk` ^0.153.4, and as a
    third backend beside them, from the library's documentation read page by page and its
    installed typings. The assessment and that documentation were working material and are
    not kept in the tree (owner, 2026-09-11); this ruling records the verdict and the facts
    that decide it, and the plan that follows is `planning/option-d-2026-09-11/PLAN.md`. It
    is not adopted in any of the four adopting shapes the assessment weighed: full
    replacement, a third backend, the operator and controller only, or a separate advisor
    run kind. Four facts decide it, and none is an effort question: it authenticates with
    API keys only, so the per-person vendor sign-in of ruling 127 has no equivalent; its
    Anthropic reasoning mapping sends a `thinking` shape that current models reject, with no
    route to `output_config.effort`; a Zod 4 schema reaches the provider as a bare
    `{"type":"object"}` with no error (verified on a scratch install); and it ships no
    coding harness or sandbox and runs its loop in the server process that holds the writer
    lock (ruling 158). What it demonstrated better
    (spending caps, exact token usage, in-process tools without a ToolSearch hop, per-tool
    MCP gating, cancellation that reaches every child) is reachable through options the
    pinned Claude SDK already has, and is ported onto the pinned SDKs by rulings 174 to 176
    as the Option D plan lands, one PR per gain (`planning/option-d-2026-09-11/PLAN.md`).
    **Reopen** only when all three of these hold: an upstream adaptive-thinking or
    `output_config.effort` route on current Anthropic models; a Zod 4-native schema path, or
    a contractually stable `zod/v3` one; and a 1.x release with a published plugin API and a
    versioned snapshot format. Or when a paying org asks for Bedrock, Vertex or Azure, in
    which case the fallback is a third backend for non-coding runs, never a replacement of
    either vendor SDK. Two corrections are recorded with this ruling. (a) The Codex read-only
    sandbox is a live enforcement seam under ruling 101 despite R22's wording (ruling 93):
    a write-withheld Codex run is confined by it today, less ruling 109's attachments
    carve-out (`resolveCodexSandboxMode`). The "open code drift" note under
    ruling 93 is stale, since the capability-matrix copy already says Codex runs a read-only
    sandbox, and the Option D hygiene PR replaces it. (b) `McpServerToolPolicy` and per-server
    `alwaysLoad` exist on the pinned Claude SDK and were never used; nor were `maxBudgetUsd`,
    `result.modelUsage`, `allowDangerouslySkipPermissions` or `spawnClaudeCodeProcess`, which
    the rulings that follow take up.

174. **A settled run leaves no live process, on either backend (owner, 2026-09-11).** Stop
    used to end the run's row and not always what the run had started. Measured on the
    pinned Claude CLI (0.3.261) with seven small live runs: Claude Code starts every Bash
    command in a session of its own (`detached`), so a `sleep 600 &` left by a finished
    command survived a normal finish, reparented to init; a SIGTERMed CLI does kill the
    command it is running; a SIGKILLed one (the SDK's escalation for a CLI past answering)
    leaves that command alive, and also leaves the stdio MCP servers it started in its own
    process group. A process-group kill, which is what the Option D plan proposed, therefore
    reaches the MCP servers and nothing Bash started, and would have failed the plan's own
    canary. The owner chose among four designs:
    (a) *Every process a run starts carries its id.* `startRun` sets `VIBERR_RUN_ID=<runId>`
    on the run's child env last, after the caller's overlay, and a refused run carries
    none. Claude hands its env to its shells and, merged under each declaration's own `env`,
    to every stdio MCP server, and a child inherits it, so the Chromium a browser MCP
    launches in a group of its own carries it too. The Codex adapter declares it in
    `shell_environment_policy.set` and in each stdio server's `env`, because that CLI passes
    only "core" names to the model's shell and a short default set to a server.
    (b) *Settle sweeps.* On every outcome the adapter reaps: Claude waits up to 5 s for the
    CLI's own exit, then `reapRunProcesses` SIGTERMs every process of this user whose
    environment carries the marker (and, on Claude, the CLI's group), waits 5 s, re-scans
    and SIGKILLs whatever is still there. The re-scan means a pid recycled during the grace
    is never signalled. Linux reads `/proc/<pid>/environ` (the image); a macOS development
    host reads `ps -E`.
    (c) *Boot sweeps the orphans.* `finalizeOrphanedRuns` reaps the run ids it finalizes,
    and the boot workspace reclaim waits for that sweep as it waits for the re-invokes,
    because a CLI a dead server left running could still be writing the tree it deletes.
    (d) *The Claude CLI leads its own group.* Viberr spawns it through
    `spawnClaudeCodeProcess`, detached, so every signal the SDK sends it (its close ladder,
    its kill-all when this server exits) reaches the MCP servers in the group, and the
    forced stop SIGTERMs the group as it aborts. The SDK reads only stdin and stdout from a
    custom spawn, so Viberr drains stderr itself and puts the SDK's 2 KB tail back on its
    exit error, which keeps a vanished resume session classified `session_missing`.
    (e) `allowDangerouslySkipPermissions: true` accompanies `bypassPermissions` on every
    autonomous Claude run, because the SDK declares it required and defaults it to false.
    The pinned CLI does not enforce it yet; one that did would drop every run to `default`
    mode and deny every tool.
    The plan's decision D1 (a wrapper script in the image, pointed at by
    `codexPathOverride`) was replaced by (a) and (b) before it shipped: the sweep reaches
    Codex's descendants from the server, and an override would also have stopped the SDK
    prepending the CLI's helper `PATH` directory. So there is no `VIBERR_CODEX_WRAPPER` and
    no image change. This is cleanup, not containment: a process that clears its own
    environment escapes the sweep, and the container plus the server-owned delivery gate
    remain the boundary (ruling 93). Amends ruling 142 (one name is added back to a run's
    child env on purpose). Extends the stop ladders ruling A8 set.
    (`app/server/runtimes/run-processes.server.ts`, `claude-spawn.server.ts`; the reap in
    `claude-runtime.server.ts` and `codex-runtime.server.ts`; `runMarkerEnv` in
    `run-service.server.ts` `startRun`; `finalizeOrphanedRuns` and boot's
    `reconcileRestartedWork`.)

175. **A Claude run carries the instance's spending cap, and its tokens and cost count every
    call it made (owner, 2026-09-11; extends 130(a)).** Nothing capped what a run could
    spend, and the token columns undercounted any Claude run that delegated. The pinned SDK
    had both levers unused (ruling 173(b)).
    (a) *The cap is an instance ceiling only* (owner decision D4): `maxRunSpendUsd` in
    `instance_settings`, set by an org admin on Org settings ("Max spend per Claude run,
    USD", above zero, at most two decimals, blank for none), none by default, with no
    profile field and no file-format change. Every change is audited as
    `org.run_spend_cap.changed` with the value before and after.
    (b) *Every run carries it.* `startRun`, the funnel every builder goes through
    (specialist, operator, controller, resume, scheduled, recovery), stamps it on the spec
    as `maxSpendUsd`, and the Claude adapter passes it to the SDK as `maxBudgetUsd`. Codex
    has no budget option, so the cap does not bind a Codex run; the run-inputs disclosure and
    the settings row both say so rather than imply a limit that is not there.
    (c) *A run the cap stops is cut off, not failed.* The SDK's `error_max_budget_usd`
    result is the `max_budget` failure kind, a sibling of `max_turns`. Its typed record
    carries the cap (`spendCapUsd`) and the spend at cut-off (`spentUsd`), and every reader
    names both from the record: the adapter's line, the specialist's blocked event (which,
    like the turn cap's, does not claim that no changes were delivered), `describeRunFailure`'s
    reason and remedy (re-run to continue, or raise the cap in Org settings), the
    controller's turn note, and the pill (`cut off · spending cap`). The recovery options
    are a cut-off's, never another backend. The pinned SDK yields the result and then
    throws ("Claude Code returned an error result: Reached maximum budget ($0.01)", measured
    by this ruling's live canary), so a cut-off is classified from the result on the throw
    path too. That also repairs the turn cap, which had been ending `run·error·unknown`
    since the SDK began throwing.
    (d) *Tokens and cost are folded from `modelUsage`,* which covers every call the query
    made (the main loop, subagents, sidechains, compaction), per model. `result.usage`,
    the main loop only, and `total_cost_usd` are the fallback for a result whose
    `modelUsage` is absent, empty or zeroed. The columns keep their meaning (input is the
    whole prompt, cached its cache-read subset). The per-model breakdown rides the result
    line's `stats.models` and no column. Rows written before this ruling folded `usage` and
    stay as stored; Insights sums what the rows hold.
    (`getMaxRunSpendUsd` / `setMaxRunSpendUsd` in
    `app/server/settings/instance-settings.server.ts`; the stamp in `run-service.server.ts`
    `startRun`; `maxBudgetUsd` and the `error_max_budget_usd` arm in
    `claude-runtime.server.ts`; `foldClaudeResultUsage` in `wire-format.server.ts`;
    `max_budget` in `app/shared/run-failure.ts`, `run-failure-remedy.server.ts`,
    `task-actions.server.ts`, `controller-run.server.ts` and `runs-helpers.ts`; the
    `set-run-spend-cap` intent in `app/routes/org.settings.tsx`.)

176. **An admin may mark an org MCP server's write tools, and a run that withholds repo write
    does not get them (owner, 2026-09-11; amends 39).** Ruling 39 kept MCP grants outside the
    capability matrix, so the only guard between a read-only reviewer holding a GitHub MCP
    and the always-human merge was a paragraph in its prompt (P13-KM-04). Both pinned SDKs
    can now remove a named tool on every transport (ruling 173(b)). Owner decisions D2 (the
    probe proposes, the admin decides) and D3 (close P13-KM-04 now).
    (a) *The admin marks them.* `org_mcp_servers.tool_policy_json` holds the marks as
    `{ name, gate: "repo-write" }`, one gate kind for now, named for the grant it rides on.
    It is NULL until an admin first saves the MCP editor's "Write tools" section, and `[]`
    is a reviewed "none". Every successful probe (save, re-test, warm-up) stores the names
    its `tools/list` carried in `tool_names_json`. The editor shows them as chips and
    pre-selects the ones with `create`, `delete`, `merge`, `push`, `update`, `write` or
    `remove` as a word of the name, only for a server nobody has reviewed; nothing is
    stored without a save, and a name the probe cannot list can be typed. Names must fit
    the MCP alphabet (1 to 128 of `A-Za-z0-9_.-`). Each change is audited as
    `org.mcp.tool_policy.changed` {name, before, after}. A save that does not carry the list
    (the controller's `save_mcp_server`) keeps it.
    (b) *A run that withholds repo write does not get them.* When the run's denylist withholds
    `execute-code-or-write-repo` (`repoWriteWithheldFromDenylist`, the predicate the Codex
    sandbox reads), and on every operator run, which never writes, the resolver returns each
    mounted server's marks as `mcpToolDenials`. `startRun` adds `mcp__<server>__<tool>`
    (normalized the way the CLI names tools) to `disallowedTools` after the D4
    auto-approval, which a deny rule outranks even under bypass, and an HTTP config also
    carries the SDK's per-tool `always_deny` policy. Codex has no denylist channel; the
    same denials become each server's `disabled_tools`, which the pinned 0.153.4 CLI reads
    per `mcp_servers.<name>`. The resume path re-derives them, and a server the stdio
    pre-flight drops takes its denials with it.
    (c) *The prompt paragraph retires where the list is enforced.* The P13-KM-04 paragraph
    names only the mounted servers that have no marks on that run. For the others, a short
    section names each server as still mounted and lists the removed tools as tools: live,
    a Codex model read "removed from this run: gh (create_pull_request)" as the whole server
    gone and called nothing. The run-inputs `mcp` row lists the withheld tools, the registry
    row counts them, and the capability matrix's MCP note says which tools this covers.
    (d) *Measured* by this ruling's canary on 2026-09-11: a reviewer with a stdio GitHub-style
    server whose `create_pull_request` is marked, on both backends. Withheld, Claude's
    `system/init` offered `mcp__gh__get_issue` alone and the server never received a
    `create_pull_request` call; Codex listed and called `get_issue` alone (3 of 3 runs after
    the wording in (c)). With the grant, both backends called both tools.
    Viberr still makes no claim about a tool the admin has not marked. The controller's MCP
    mounts are unchanged: it holds no repo-write grant to withhold.
    (`app/shared/mcp-tools.ts`; `checkedWriteTools`, `storedWriteTools` and the probe's
    `toolNames` in `app/server/org/resources.server.ts`; `resolveSpecialistMcpServersDetailed`
    in `specialist-mcp.server.ts`; the fold in `run-service.server.ts` `startRun`;
    `codexMcpServers` in `codex-runtime.server.ts`; `buildSpecialistPersona` and
    `buildOperatorSystemPrompt`; `McpModal` in `app/features/org-settings/resource-modals.tsx`.)

177. **A closed task refuses every coordination door, and closing it ends its live runs
    (owner, 2026-09-11, pass 36; Q36-8).** A task at its terminal stage or archived is
    CLOSED. Before this ruling "closed" had three spellings and several doors read none of
    them: the schedule runner's `mootNow`, the specialist dispatch's archived-only gate, and
    `runOperator`'s terminal-stage refusal scoped to the `scheduled` trigger (FR39 / F19-20:
    "every other trigger on a terminal task is legitimate"). Live (F36-4, F36-5): an
    `@operator` mention started a paid run on an archived task behind a page whose own
    button refused it, and a developer run that outlived a force-accept re-invoked the
    operator on the shipped task, whose plan then opened a decision packet there.
    (a) *One predicate.* `taskClosure(fm, stages)` (`app/server/tasks/task-closure.server.ts`)
    is the only spelling — `archived`, or the stage is the board's last — and
    `closureRefusal` the only sentence ("<KEY> is archived — restore it before <verb>." /
    "<KEY> is closed (<Stage> is the terminal stage) — move it back to an open stage before
    <verb>."). `runOperator` refuses EVERY trigger with `refused: "closed"` and the sentence
    in `refusalReason`, settling `waiting` to `none`; the mention door writes the F35-5
    "Mention not started" note; the specialist dispatch, the packet writer, the schedule
    runner and the reconciler's budgeted queue read it too. A run's completion on a closed
    task records its report with a "Completed after the task closed" note and wakes no
    operator, however it was dispatched. Reopening is a human stage move, and the
    transition that reopens the task is the trigger that coordinates again.
    (b) *Closing ends live runs.* Acceptance, force-accept and archive interrupt the task's
    running and queued runs through `interruptRunOnClosure` (run-service; audited
    `runtime.run.interrupted {reason: "task-closed", cause, closedBy}` under the system
    actor, no RBAC — the person's authority was spent on the closure), write one
    "Interrupted by acceptance" note naming every run and one
    `task.acceptance.interrupted_runs` row. A closed task spends nothing more.
    (c) *A restart says so on the task.* Boot recovery leaves one "Interrupted by a restart"
    note per task whose runs it finalized (U36-8), before the operator it re-invokes.
    (d) N20-17's disclosure ("mentioning @operator still runs it") is gone with the door,
    and the archive dialogs promise what restore does — a human, not a reopened question
    (U36-1). Rulings 131(d) and 141 keep their own refusals beside this one.
178. **A project declares its required reviewers (owner, 2026-09-11, pass 36; Q36-5;
    G36-3).** Required-ness was emergent: the task-level set (`requiredReviewers(fm)` on
    the task file) is the engaged, non-delivering, verdict-capable engagements, so a
    reviewer gated a task only once the operator had engaged it there. Live, a task whose
    operator never engaged the project's Code Reviewer reached the acceptance boundary
    `healthy` on whichever other verdict-capable agent had run, and nothing named the
    reviewer the project meant.
    (a) *The rule.* `project.md` gains `requiredReviewers: [{ stageId, profileId }]` —
    "profile X reviews at stage Y", per review stage, `[]` by default (only the engaged
    reviewers are required). Every stage id must be a non-terminal stage and every profile
    id a deployed agent holding `report-validation-verdict`; a writer refuses anything else
    by name and writes nothing. The task-level emergent set stays: the project rule ADDS
    a reviewer the task must hear from whether or not anyone engaged it.
    (b) *One gate.* `requiredReviewerRefusals` (`required-reviewers.server.ts`) is pure:
    for every rule, the named agent must hold an `approve` verdict bound to the task's
    ACTIVE work revision (an approval of a replaced revision is history, ruling 163);
    otherwise "Required reviewer <Agent> (project rule at <Stage>) has not approved
    revision <sha7>. Run the review at <Stage>, or an admin can force-accept." A task with
    no active revision and no pull request is not held. The acceptance refusal stack (task
    page, `notAcceptableReason`, every writer), the projection's `validation_block_reason`
    (so the review queue lists the task as review work and never offers acceptance; the
    `projects` row carries the resolved rules for the rebuilder's task walk), the operator
    snapshot (`requiredReviewers`, and the turn prompt says to engage each one at its
    stage) and the controller's `get_project` read that one function. Force-accept
    bypasses it and the audit row names the bypassed rule.
    (c) *One writer.* Settings → Required reviewers (stage and agent pickers, the WHOLE
    list saved, `edit-policy` tier) and the controller's `set_required_reviewers` (the
    whole list, `[]` clearing it, `[noop]` when unchanged) go through `setRequiredReviewers`,
    audited as `project.required_reviewers.updated` with the resolved stage and agent
    names ("set the required reviewers to **Reviewer at Review**"); the Policy page reads
    the rules as agent → stage and points a manager at Settings.
179. **Ruling 163 applies to the pull-request head (owner, 2026-09-11, pass 36; Q36-9).**
    Verdicts bind to the WORK revision, and a foreign push moves the review PR's head
    without touching it — so after an observer commit landed on an approved PR at Merge
    Approval, `validation` stayed healthy, the accept card stayed applicable, nothing
    woke or notified, the Commits card (prefix-filtered) hid the commit, and no re-review
    path existed because the reviewer is scoped to the verdict stage (F36-7). The merge is
    what a verdict protects, and the merge takes the head.
    (a) *Authored drift after a verdict voids it.* On the pass that first records a moved
    head carrying authored commits (ruling 132's classification: `authored > 0`, the cached
    drift names a different head) on a task that is not closed and whose current revision
    carries a verdict, the reconciler mints the head as the revision under review
    (`workRevision.kind: "external"`, `sourceProfileId: null`), re-derives `validation`
    (→ `changed`), withdraws the moot accept and transition offers, writes a "Revision
    moved after review" note carrying ruling 132's drift sentence, notifies the watchers
    (`policy`), wakes the operator (`pr-diverged`) and — when the task sits past its
    verdict stage — returns it there through the rework route (`task.transition
    {boundary: "rework", via: "authored-drift"}`, actor the system). The same head on a
    later pass is old news; a delivery that replaces the revision in the window wins.
    (b) *Drift before any verdict is the branch growing.* Nothing is minted or voided; the
    drift record is written as before.
    (c) *The foreign commits are visible.* `github.otherCommits` keeps the branch commits
    without the task's `[KEY]` prefix, and the Commits card lists them apart as "Also on
    the branch · not this task's".
180. **Claude skills mount outside the task checkout (owner, 2026-09-11, pass 36; F36-9).**
    A Claude run's granted skills are handed to the SDK as one LOCAL PLUGIN built for that
    run at `<checkout>/../.viberr-plugins/<runId>/` (`.claude-plugin/plugin.json`, name
    `viberr`, plus `skills/<name>/` copied from the store with normalized frontmatter),
    passed as `plugins: [{ type: "local", path, skipMcpDiscovery: true }]` and filtered as
    `skills: ["viberr:<name>", …]`; `settingSources` is `[]` on every run, so nothing under
    the checkout is ever a settings source and the repository's own `.claude`/CLAUDE.md
    never reach the model at system-prompt tier. Nothing Viberr writes for a run lives
    inside the tree the project's tools scan (live, the mounted `.claude/skills` broke the
    clone's own `npm run check` in the reviewer's workspace three times): the in-checkout
    `.claude/skills` + `settings.json` mount, the `.git/info/exclude` entry, the CLAUDE.md
    excludes and the per-process mount marker are retired. One plugin per run: run-service
    removes it when the run settles, the dispatch removes one a refused run never adopted,
    and a run whose plugin is gone at start enables no skill and corrects its persona.
    Verified in the image on 2026-09-11 (SDK 0.3.261 / CLI 2.1.261): the init lists
    `viberr:<name>` and the model invokes it. Codex is unchanged (skills as prompt text; it
    writes no files). (`mountGrantedSkills`, `removeSkillPlugin` in `skill-mount.server.ts`;
    `RunSpec.skillPlugin`; the adapter in `claude-runtime.server.ts`.)
181. **Every Codex run gets a private `CODEX_HOME` forked from the person's home (owner,
    2026-09-11, pass 36; Q36-11 (a); extends 127).** The Codex CLI extracts its exec
    helpers (`codex-linux-sandbox`, `codex-execve-wrapper`, `apply_patch`) into one
    directory per home, `$CODEX_HOME/tmp/arg0/codex-arg0XXXXXX/`, and every new process of
    the same home replaces it; ruling 127's one `codex-home` per person let concurrent
    sandboxed runs of one person delete each other's helper mid-run (F36-3, live 14:53Z).
    The binary offers no override for that path.
    (a) *The fork.* The Codex adapter hands the CLI `<codex-home>/runs/<runId>/` as
    `CODEX_HOME`: `auth.json` and `config.toml` copied in when present; `sessions/`,
    `skills/` and `memories/` symlinked to the shared home (created first) so rollouts land
    where resume, export and retention look; `CODEX_SQLITE_HOME` set to the shared home so
    the CLI's state database stays the person's; `tmp/` whatever the CLI creates, private
    by construction. `runCredentialFor` still names the shared home; the fork is the
    adapter's, so every path that builds a Codex spec gets it.
    (b) *The settle.* When the run settles — finished, failed, interrupted or crashed, the
    adapter's one `settle`, before the completion callback — the run's `auth.json` is copied
    back only when its bytes changed, under a per-person lockfile (`O_EXCL` with retry; a
    holder older than 30 s is broken; last writer wins), and only while the shared file
    still exists (a disconnect during the run is not undone); the run directory is then
    deleted. A run a restart orphaned never reaches its settle, so boot recovery
    (`finalizeOrphanedRuns`) finishes its home the same way before it re-invokes the
    operator (live 19:48Z: two restart-cut developer runs still owned their `runs/<id>/`
    copies of the sign-in).
    (c) *Hygiene.* `filteredSpawnEnv` strips an ambient `CODEX_SQLITE_HOME` as it strips
    the two vendor homes.
    (d) *Measured* in the image on 2026-09-11: two `codex exec` in fresh homes wrote all
    five state databases into the shared `CODEX_SQLITE_HOME`, each kept its own
    `tmp/arg0`, and rollouts went through the `sessions` link.
    (`prepareCodexRunHome` / `finishCodexRunHome` in `user-homes.server.ts`; the fork and
    settle in `codex-runtime.server.ts`; `RUNTIME_HOME_ENV_RE` in `runtime-registry.server.ts`.)
182. **SUPERSEDED BY RULING 185 (2026-09-12) — only (b)'s version half survives, and the
    sandbox halves (a), (c)'s sandbox field, (d) and the probe itself are GONE. Kept for
    the history of why they existed.** ~~The Codex sandbox is probed once per process,
    reported with the host toolchain, and a confined Codex run is refused with a named
    remedy while the probe fails (owner, 2026-09-11, pass 36; Q36-1 (a); deployment:
    seccomp).~~ Every Codex mode below
    `danger-full-access` confines the agent's commands with bubblewrap, which needs an
    unprivileged user namespace; Docker's builtin seccomp profile refuses
    `unshare(CLONE_NEWUSER)` to the non-root app user, so on the compose deployment every
    reviewer and supporting run failed at its first command and the model reported the
    environment failure as a verdict (F36-1: `request-changes`, "missing evidence", on
    correct deliveries; G36-4: nothing named the sandbox).
    (a) *Deployment.* `compose.yml` runs the app with `security_opt: [seccomp=unconfined]`;
    the container stays non-root, cap-dropped and init-reaped, and the Codex sandbox is
    what then confines the agent. Chromium already needed `--no-sandbox` for the same
    wall; Codex has no such flag.
    (b) *The probe.* `app/server/ops/toolchain.server.ts` resolves once per process the
    versions of node, npm, git, python3 and go (null when absent), the pinned
    `@openai/codex` and `@anthropic-ai/claude-agent-sdk`, and `codexSandbox: { ok, detail }`
    from the CLI's own sandbox helper — `codex sandbox --permission-profile <probe> -C
    <work> -- /bin/echo <nonce>` in a throwaway home under `runtimes/codex-sandbox-probe/`
    (not the OS temp dir, which the CLI refuses for its helpers), a profile that reads `/`
    and writes the workdir, network off, no sign-in; `detail` is the sandbox's own first
    line when it fails.
    (c) *Where it is read.* Boot resolves it on the integrity line and WARNs separately when
    it failed; `healthSnapshot` appends it LAST as `toolchain`, so `/resources/health` and
    `instance_health` carry it; it never sets `degraded` (a host that runs no Codex is a
    correct host).
    (d) *The refusal.* `startRun`, after the credential, ends a Codex spec whose
    `resolveCodexSandboxMode` is below `danger-full-access` as a `run·unavailable` error run
    through `failRunUnavailable` — `Codex sandbox unavailable on this host: <detail>. Fix
    the deployment (see docs/operations/deployment.md, seccomp) or grant the run full
    access. No agent process was started.` — with `failedUnavailable` on the audit row; a
    fully autonomous deliverer with egress is never asked, nor is a Claude run.
    (e) *Tests never probe:* `test-support/toolchain.ts` primes a hermetic reading in
    `setup-env.ts`, the same override-slot shape as the sign-in binaries.
    (`cachedToolchain`, `probeCodexSandbox` in `toolchain.server.ts`;
    `codexSandboxUnavailableMessage`, `codexSandboxRefusal` in `run-service.server.ts`;
    `logBootIntegrity` in `boot.server.ts`; `compose.yml`; `docs/operations/deployment.md`
    "Codex sandbox (seccomp)".)
183. **A SKILL.md body is judged before any writer writes it (owner, 2026-09-11, pass 36;
    F36-2).** Live, the controller sent `body` JSON-escaped twice and two skills landed on
    disk as ONE line of literal `\n`; nothing judged the body, the mount took the escaped
    text as the description and Codex agents read it as-is. `assertSkillBodyWellFormed`
    lives beside the containment reader in `skill-body.server.ts` and runs from EVERY
    writer — `saveSkill` (the org-settings editor and the controller's `save_skill`),
    `writeStoreFiles` in its pre-flight loop (a refusal writes nothing of the batch) and
    `writeStoreDoc` (the store browser). Three shapes are refused BY NAME and never
    rewritten: an empty body ("SKILL.md is empty. Send the skill's markdown body."); a
    body with no real newline but literal `\n` sequences ("The SKILL.md body arrived
    JSON-escaped … Send real newlines." — a writer that unescaped would also unescape a
    one-line body that means `\n` literally); a frontmatter block that does not parse or
    is not a mapping. Plain markdown with no block stays valid: the mount adds the block,
    the editor never wrote one. An empty body refused on every write retires the E4
    `clearBody` flag (writer, org-settings action and modal): an empty SKILL.md is not a
    skill, and an empty submission on an existing skill keeps the file. The mount's
    frontmatter schema (`skillFrontmatterSchema`) moves to the same home so there is ONE
    definition.

184. **SUPERSEDED BY RULING 185 the same day: the owner removed the sandbox itself rather
    than keep disclosing its limits ("I don't like codex sandbox stuff let's remove that").
    Kept because it is the measurement that produced 185.** ~~A sandbox that runs commands
    but denies child processes is disclosed to every AGENT run it confines, never used to
    refuse one (owner Q36-12, 2026-09-12, pass 36; F36-11).~~
    With the network off the Codex CLI installs a seccomp filter that refuses EVERY socket
    syscall, `AF_UNIX` included; libuv's SYNCHRONOUS spawn needs a socketpair, so
    `spawnSync`/`execSync` report `EPERM` inside the sandbox even though the child ran, and
    `npm ci` dies on its first lifecycle script. Async `spawn` is unaffected, which is why
    the host looks healthy from the outside. Live (HLC-18, 2026-09-11): the Codex reviewer
    recorded `request-changes` — "the required `npm ci && npm run check` gate has no green
    result for this revision" — against correct work, F36-1's shape on a host whose sandbox
    starts fine. So ruling 182's probe asks a SECOND question in the same throwaway home and
    network-off profile (`CODEX_SANDBOX_CHILD_CANARY`, a `spawnSync` canary run through
    `process.execPath`): `codexSandbox.childProcesses` is `{ok, detail}`, or `null` when the
    sandbox could not run a command at all and the question was never asked. A false answer
    does NOT refuse the run — a confined run still reads, greps and reviews, and taking the
    backend away from every reviewer over an upstream limit costs more than the limit does.
    It is DISCLOSED three times: a separate boot WARN, `instance_health`/`/resources/health`
    (the `childProcesses` field), and a section in the run's own contract for every AGENT run below
    `danger-full-access` (`codexSandboxChildProcessLimit` + the prompt's "This sandbox will
    not let you run build or test tooling"; the operator is not one — it holds no shell tool
    at all and is told so) that names the limit, orders the agent NOT to
    turn it into a verdict or a failing-gate report, gives it the sentence to write instead,
    and says what still works. One derivation of "which run is confined" serves both the
    disclosure and the limit (`runSandboxSpec`).

185. **Viberr does not confine a Codex run with the CLI's OS sandbox: every Codex run is
    `danger-full-access`, and Viberr's own boundaries are the boundary (owner, 2026-09-12,
    pass 36; Q36-14 (a); supersedes ruling 182, ruling 184 and the Codex half of the
    2026-08-31 parity ruling; restores R22's position).** The owner's words: "I don't like
    codex sandbox stuff let's remove that. So we don't get issues like this."
    (a) *What it cost to keep.* Two whole classes of dead run, both upstream and neither
    expressible as a Viberr rule. **F36-1**: every mode below `danger-full-access` confines
    commands with bubblewrap, which needs an unprivileged user namespace Docker's builtin
    seccomp profile refuses to a non-root user — so on the compose deployment EVERY
    reviewer and supporting run failed at its first shell command, and the models reported
    the environment as a verdict on correct work. The remedy was to run the whole container
    `seccomp=unconfined`. **F36-11**: with the network off the CLI installs a seccomp filter
    that refuses every socket syscall, `AF_UNIX` included; libuv's SYNCHRONOUS spawn needs a
    socketpair, so `spawnSync`/`execSync` report `EPERM` after the child has already run and
    `npm ci` dies on its first lifecycle script — a confined reviewer cannot run any
    `npm`/`npx`/`pnpm` gate. Live (HLC-18, 2026-09-12) that deadlocked the review gate: the
    reviewer reported "environment evidence blocker, not a code finding" and still recorded
    `request-changes`, and the operator sent the deliverer back around.
    (b) *The change.* `codex-runtime.server.ts` starts every thread `sandboxMode:
    "danger-full-access"`. `resolveCodexSandboxMode`, `describeCodexSandbox`, the
    `RunInputs.sandbox` row, the toolchain's `codexSandbox` probe (ruling 182(b)), its boot
    WARNs, its `run·unavailable` refusal (182(d)) and ruling 184's child-process question
    and contract section are all DELETED. `compose.yml` drops `security_opt:
    seccomp=unconfined`, so the container keeps Docker's own profile (chromium keeps
    `--no-sandbox`, which was always its own wall).
    (c) *What that costs, rendered everywhere it matters.* On Codex a withheld
    `execute-code-or-write-repo` is ADVISORY: it moves back into
    `CLAUDE_ONLY_ENFORCED_CAPABILITY_IDS`, `codexRepoWriteAdvisory` is now true for ANY
    Codex profile whose write family is withheld (it was the narrower E32-3 carve-out), and
    the agent editor, the capability matrix and the agent card all tag the row "advisory on
    Codex" with the one shared sentence. The boundary that does bind is Viberr's: the
    prompt omits every delivery step it may not take, the supporting run works in its own
    isolated checkout (P8), agents hold no credential, delivery is server-owned and
    verdicts are revision-bound. The operator's OS-level network is no longer forced off —
    it never had a shell tool anyway.
    (d) *What still binds on Codex.* Web SEARCH (`webSearchMode: "disabled"`) — the CLI's
    own tool, not the OS sandbox — so `use-web-search-fetch` keeps its both-backend
    enforcement; `disabled_tools` for MCP write tools (ruling 176); and every server-side
    gate.
    (`codex-runtime.server.ts`; `run-service.server.ts`; `toolchain.server.ts`;
    `boot.server.ts`; `specialist-run.server.ts`; `specialist-tool-policy.ts`;
    `app/shared/capabilities.ts`; `compose.yml`; `docs/operations/deployment.md`.)

186. **A dependency hold refuses every agent dispatch (owner, 2026-09-13, pass 37; D37-1,
    F37-2).** `blockedBy` held nothing. Ruling 131(d) refused three operator triggers
    (`create`, `transition`, `scheduled`) and then ASKED the model, in the held doctrine's
    prompt paragraph, not to "dispatch delivery work"; `startAgentRun` checked nothing at
    all, so every other door — the operator's `run_agent`, the controller's `run_agent`, the
    task page's Run-an-agent control — started a real, billable run on a held task. Live
    (pass 37, SHOP-2): Viberr wrote "Held until every entry is done; Viberr releases it
    then", started a Codex run **1.9 seconds later**, and let it design and commit the whole
    identity service onto a pushed branch cut from a base that predated the foundation it
    waited on — the exact collision the hold existed to prevent, manufactured by the
    mechanism meant to prevent it. Asked what a hold should gate, the owner chose the hard
    gate, one spelling, with no supporting-run carve-out and no advisory mode: *"the words on
    the board become true"*, at the cost of a held task doing no preparatory work at all.
    **(a)** `holdRefusal` lives in `app/shared/dependencies.ts` beside the vocabulary it
    reads — pure and client-safe, so the server gate and the pre-click control cannot drift.
    **(b)** `startAgentRun` refuses a non-empty `blockedBy` beside ruling 177's closure gate,
    AHEAD of the auto-engage, so no engagement seat lands on a held task either. **(c)** The
    task page's agent control renders that same sentence and disables Run; a SCHEDULED run
    stays offerable, because a hold can clear on its own and the gate refuses again at fire
    time if it has not. **(d)** The held doctrine stops claiming a responsibility the server
    has taken: it now tells the operator that `run_agent` and `deliver_for_review` are
    refused, rather than asking it not to try. **(e)** Operator triggers are deliberately NOT
    narrowed — the reactive ones exist to answer people and react to facts, and with dispatch
    gated they can no longer cause work. **(f)** Ruling 157 is untouched: its subject is a
    packet-less, LIST-less stored hold, and it already deferred to ruling 131's floor for a
    dependency list; the third arm of its test asserted that a dispatch on a
    dependency-held task SUCCEEDED, which was the ambient behaviour of the day and never
    that ruling's subject, and it now asserts the refusal.
    (`app/shared/dependencies.ts`; `specialist-run.server.ts`; `operator-run.server.ts`;
    `app/features/task-detail/execution-profile.tsx`.)

187. **The record never claims a commit the remote does not have, and work that vanished
    with its workspace is announced as lost (owner, 2026-09-13, pass 37; F37-8, F37-9).**
    SHOP-2's `task.md` recorded `3aad6ff` on `shop-2`; origin's `shop-2` held only the
    bootstrap commit, `git cat-file` found the object nowhere, and no workspace under `/data`
    held it. The commit was made inside a run's workspace, never delivered, and disposed with
    the workspace — and the GitHub page rendered "1 commit · synced" for a change that
    existed nowhere. The carve-out that kept it was written for a different case ("agents
    don't always follow the prefix convention, so an EMPTY filtered list must not wipe a
    non-empty cache") and could not tell "our filter missed it" from "it was never pushed".
    **(a)** Every recorded commit carries `pushed` — whether the REMOTE has it — stamped by
    the reconciler from a **complete** compare, and every surface renders it (the GitHub
    page's branch row now reads "1 commit · not pushed" where it read "1 commit"). An absent
    `pushed` means no compare could judge it, which is neither answer and must render as
    neither: a short list (the tolerant reader's `droppedCommits > 0`, or GitHub's own cap)
    judges nothing at all, because stamping a genuinely pushed commit `false` is the same lie
    pointed the other way. **(b)** The first implementation DROPPED an unmatched entry and
    announced it as "**Work lost**". That was wrong and the live system proved it within the
    hour: a reconcile landing in the window between an agent committing in its workspace and
    delivery pushing it announced SHOP-7's `522e640` as lost **seconds before Viberr pushed
    it**. At reconcile time a commit awaiting delivery and one whose workspace is gone are
    indistinguishable — neither is on the remote, neither carries `pushedAt` — so "lost" is a
    claim this code cannot make. "Not pushed" is one it can, it is always true, and it is what
    the reader needs. The carve-out's real case is preserved and pinned: an unprefixed commit
    that IS on the branch survives and is stamped pushed. **(c)** F37-9, the same
    family: the sync pill reads the newest `github.reconcile` provenance row, and `changed`
    compares only the task file's `pr`/`github` blocks, so a pass whose only change was
    "`main` moved" wrote no row and the pill kept the stale verdict — live, SHOP-2 rendered
    **synced** while the same pass's audit row said `behind_main`. A changed verdict now
    writes a row; an unchanged one still writes nothing on a poller tick, so the
    "grow unboundedly" concern the original condition names is untouched.
    (`github-reconciler.server.ts`; `provenance-query.server.ts`.)

188. **A controller read returns what the equivalent human surface renders (owner,
    2026-09-13, pass 37; F37-3, F37-5, F37-6, F37-7).** Four reads handed the model
    less-resolved data than the UI with no marker saying so, and each changed what the
    controller said or did. **(a)** `get_project` returned RAW declared stage ids; ruling
    R14-1 remaps a declared id absent from a board onto the stage filling the same
    structural role, and the Agents page renders the resolved list. The controller read the
    raw ids and told its owner two deployed profiles were "effectively unselectable" while
    the audit trail showed one of them being selected. It now emits the board-resolved list
    through the SAME `resolveDeclaredStages` the Agents page, the task page and the dispatch
    gate share, with `declaredStages` beside it so a remap is visible rather than silent.
    **(b)** `get_task` leaked `validation_block_reason`, whose own docstring says every
    consumer filters on the resolved review stage first — the board does, this read did not,
    so a Design-stage task reported a Review-stage acceptance sentence recommending
    force-accept three stages early. Replaced by `notAcceptableReason` via
    `acceptanceRefusalFor`, the verdict the operator already reads. **(c)**
    `list_mcp_servers` omitted ruling 176's write-tool marking entirely, so the controller
    refused a grant that was in fact safe — reasoning correctly from what it could see: *"if
    Viberr enforces that marking, it does so somewhere I cannot read, and I won't assert that
    it does."* It now reports `writeTools`, `writeToolsReviewed` and what the marking does.
    **(d)** `save_mcp_server` could create a server but never govern one, so both servers the
    controller created landed with a NULL policy; it now takes `writeTools`. **(e)**
    Auto-marking a create from the name heuristic was considered and REFUSED: the marking is
    a review, `writeToolsReviewed` says whether one happened, and pre-marking would make
    Viberr assert a review nobody performed — the same class of lie pointed the other way.
    `saveMcpServer` returns `writeToolsSuggestion` instead, and the reply states plainly that
    nothing is withheld and names the tools that look like writes. **(f)** F37-4, adjacent:
    `WRITE_VERBS` grew from seven words to nineteen, having missed `edit_file` and `move_file`
    on a stock filesystem MCP server.
    (`controller-toolkit.server.ts`; `agents-query.server.ts`; `org/resources.server.ts`;
    `app/shared/mcp-tools.ts`.)

189. **A person's decision joins the task's contract, not just its timeline (owner,
    2026-09-13, pass 37; F37-10).** SHOP-7's goal said "the agent must not select a provider
    … ask Arda to choose". Arda chose, through the packet Viberr opened for exactly that.
    The agent recorded the choice; the required reviewer re-anchored on the canonical file —
    as its prompt tells it to — found the deliverable contradicting the goal and requested
    changes; the operator told the agent to "remove every claim that mock-only was selected";
    the agent "restore[d] a neutral, unresolved comparison"; and a second packet asked the
    same question again. Nobody misbehaved — enforcing the declared contract is precisely
    what a required reviewer is for. The defect is that resolving a packet wrote a timeline
    event and a tagged comment and did not touch the goal, and the goal is what every fresh
    run reads while a timeline entry twenty events back is not. Resolving a packet now
    appends the decision to the goal, in the same locked write that clears the packet, with
    the clause that settles the contradiction it may create: "Where anything above
    contradicts it, the decision wins — it was made by the person the question was put to,
    and it is not an agent overstepping." Doing it in the WRITER rather than asking the
    operator to remember `set_goal` is deliberate: it needs no model judgement and cannot be
    lost to a turn that fails, is interrupted, or resumes into an expired session — all three
    of which happened on this task. Exclusions, all because no future run's WORK is bound: a
    resolution that ENDS the task; `edit_goal`, whose packet stays open because the person is
    about to rewrite the goal themselves; and a RECOVERY choice (`request_edit`, `redirect`,
    `retry_other_backend`, `hold_runtime_debug`, `archive_task`, `discard_branch`,
    `resolve_remote_collision`, `move_stage`), which decides what happens NEXT rather than what
    the work IS — live, SHOP-7's goal collected "Work stalled: pick a recovery path → Redirect
    with sharper guidance" beside the real provider decision before this exclusion existed. A
    typed CUSTOM directive always binds, whatever packet it was typed on, because a person
    wrote it.
    (`task-actions.server.ts`.)

190. **A share whose complement was never observed is not a measurement (owner,
    2026-09-13, pass 37; F37-12).** "Coordination overhead" read **100%** on the live
    instance, under the sub-text "operator and controller runs spent $4.34 of $4.34
    reported by cost-reporting runs". Every word of that is true and the headline is
    worthless: only Claude's result envelope carries a cost, the whole delivery fleet ran
    on Codex, and the instance's four CONTROLLER turns were therefore the entire
    denominator. The quotient was 1 by construction — it could not have been anything
    else — while the question the card exists to answer ("how much of my spend is
    coordination?") had no answer in this data at all. A reader sees a metric pegged at
    its maximum and goes to tune the operator; the truth is that coordination cost $4.34
    and delivery's cost is UNKNOWN, not zero. This is the same defect the card already
    guards at the other end — F31-D6 refuses a fake 0% when nothing has reported a cost —
    so it gets the same answer: when no `primary`/`reviewer` run reported a cost, the
    share is null and the card gives the figure that IS real ("operator and controller
    runs spent $4.34; no delivery run reported a cost, so there is no share to take").
    The rule is SYMMETRIC, which the first draft of it was not: the mirror — a Codex
    operator and controller under a Claude delivery fleet — reads **0%** and claims
    coordination is free when it merely never reported, and it is just as reachable. So a
    side that RAN and reported nothing makes the share null whichever side it is, and the
    card names which one. The test is runs, not dollars, and it separates a side that
    reported nothing from a side that never ran: a delivery run that genuinely reported
    $0.00 was observed (100% is earned there and is shown), and an instance with no delivery
    runs at all really did spend everything it spent on coordination.
    (`insights-query.server.ts`, `insights-page.tsx`.)

291. **The conflict remedy names the operation Viberr actually performs (2026-09-15, pass
    37; F37-126).** A pull request that conflicts with its base blocked acceptance with
    this sentence, on the board card, the accept dialog, the projected column and the
    operator's own `notAcceptableReason`: "Rebase the branch and re-review, or archive the
    task."
    Viberr does not rebase. `update_branch_from_base` "merge[s] the base into the branch
    and push[es] it", and that same tool's text tells the operator to "never ask an agent
    to rebase, merge or force-push". So the product recommended, to the ONE reader holding
    no tool and the most freedom to do it by hand, the single operation it forbids
    everywhere else. It is also the operation that broke a branch on this instance:
    `operator-actions.server.ts` carries the note "Live on SHOP-11: a rebase diverged the
    branch from its own PR #15", and the shopify-clone board's own rulings open with "a
    branch with an open PR is published history — merge main in, never rebase".
    Every sentence now names the merge, and says why the alternative is wrong rather than
    only that it is: rebasing rewrites commits the pull request already published.
    THE CORRECTION THIS RULING NEEDED ITSELF. Its first draft changed the two strings a
    grep for one sentence found, and claimed "one string, shared by both call sites, so
    they cannot drift". Within the hour the review queue was still reading "GitHub can't
    merge it until the branch is rebased" on a live board. SIX more were standing at that
    moment: that one, two short `cause` strings beside the long reason already fixed, the
    GitHub tab's comment, a note handed to the OPERATOR ("delivered work … may need a
    rebase"), the reconciler's own notification, and the decision packet's PLACEHOLDER —
    which is Viberr modelling what a good directive looks like at the exact moment a
    person is writing one, in the operation the product forbids.
    So the rule is a SWEEP, not a string: `rebase-advice.test.ts` walks every source file
    under `app/` and fails on any line recommending one, matching the recommendation
    rather than the word (this ruling has to say it, and so does every comment explaining
    why not). Writing it caught an eighth site the hand-grep had missed. A claim that N
    places are fixed is worth exactly as much as the thing that counts them, which is the
    lesson of the pass applied to the author of the pass.
    Nothing about the MECHANISM changed here. That is the point: the mechanism was right
    and the instructions beside it told a person to do the opposite, which is the cheapest
    kind of defect to ship and among the more expensive to undo — a rewritten branch cannot
    be un-rewritten by the person who followed the advice.
    (`task-file.schema.ts`, `task-actions.server.ts`, `review-helpers.ts`,
    `github-reconciler.server.ts`, `operator-run.server.ts`, `decision-packet.tsx`,
    `github-view.tsx`, and the sweep that counts them.)

292. **Ruling 285 for the controller, and the verdict reason that was cut in silence
    (2026-09-15, pass 37; F37-127, completes 285 and 288).** Ruling 285 gave the OPERATOR
    `read_timeline_entry` so a report its prompt had cut at 4,000 characters could be read
    whole. The controller got nothing — and it is the SHARPER of the two cases: its
    `get_task` cuts every timeline entry at 700 rather than 1,500, and it is the actor a
    PERSON asks about an agent's report. A rule applied to one actor and not its sibling,
    written into the very ruling that exists to end that shape. Found by sweeping every
    remaining `.slice(0, N)` on model-facing text rather than by tripping over it, which is
    the only reason it was found at all.
    The controller now mounts the same reader, over the same implementation. Its `get_task`
    payload already printed `at` — the exact address the reader takes — so nothing needed
    inventing, and a cut entry now carries a `clipped` line naming the tool beside the text
    it cut. It is a read, so it joins the other reads and needs no grant; `read_run_log` is
    the RUN's log, which is a different thing from what an agent chose to report.
    PROVEN THE SAME EVENING, by the tool itself. Asked which claims in SHOP-43's review it
    had verified and which it was relaying, the controller read the verdict whole with
    `read_timeline_entry` and reported: "the clip stopped before every one of the caveats
    below". What the 700 characters cut was the reviewer's own §5 honesty section — that its
    exit-0 test result required `--workspace-concurrency=1`, and that unconstrained, cart's
    suite times out and aborts the run before orders ever executes. Its conclusion is the
    sentence this ruling is for: "if I had relayed 'orders is green on main again' without
    this, I would have handed you a true sentence that implies a false one." A person was
    one confirmation from accepting on that sentence. Working from the clip, in good faith,
    the controller would have supplied it — and nothing afterwards would have looked like a
    failure.
    The same sweep found the WRITE-side twin. A reviewer's verdict `reason` — a stored
    record a person reads on the task page beside approve or request_changes — was a bare
    `.slice(0, 2000)`, so a long justification was stored ending mid-word and read as the
    whole of what the reviewer said. Ruling 288's shape, in a second field. The cut stays
    (a verdict reason is a paragraph, not a report) and it now says it was cut and where
    the whole of it is: the agent's own report, on the same timeline, never truncated.
    (`controller-toolkit.server.ts`, `task-actions.server.ts`.)

293. **The evidence, not only the sentence claiming it (2026-09-15, pass 37; F37-128).**
    A task's attachments are where the proof lives, and every convention on this instance
    tells agents to put it there. On this board the SHOP-37 deliverer attached its mutation
    proof — the mutant diff and both vitest runs, raw; the SHOP-42 reviewer attached "full
    before/after captures and audit table"; the SHOP-28 architect wrote two follow-up task
    specs into one, "including the literal code to land". A timeline entry names them under
    `attachments:` and carries none of their contents.
    So the two actors a PERSON asks "did it actually prove that?" — the controller they
    talk to, and the operator that recommends acceptance on the strength of a review —
    could read the claim and never the file. That is the distinction this whole pass turns
    on, and the controller had already named it about itself: "the citation is inherited,
    not verified. If my paraphrase of §3 had been wrong, nothing in that run would have
    caught it."
    `read_task_attachment` returns one attachment as text, on BOTH toolkits, mounted in one
    change and pinned by one test that asserts both. That pairing is deliberate: ruling 292
    exists because ruling 285 gave one coordinator a reader and not the other, and a test
    holding the two together is what turns doing it twice into a choice rather than an
    oversight.
    Text only, by name, and honest about the rest: a `.png` is named and refused rather
    than handed back as bytes a model will describe as though it had looked at the image; a
    name that climbs out of the task's own folder resolves to nothing (the containment every
    store path uses); a file past the read cap says it was cut. A name this task does not
    hold answers with what it DOES hold, rather than implying a deletion.
    WHAT IT WAS FOR, an hour after it shipped. The controller had written SHOP-50's goal
    from a reviewer's summary, asserting as settled that cart's integration suite times out
    under unconstrained parallelism. Reading the reports and their attachments in full, it
    found a second run on the SAME head, 40 minutes later, with the SAME unconstrained
    command, at exit 0 — and a third failure shape again on a clean workspace. It stopped
    its own dispatch, rewrote the goal to open "the premise of this task is contested, and
    establishing which account is true IS the first deliverable … Do not inherit it", laid
    out the three observations with their times and heads, and said in the goal itself: "I
    have read that report and its attachments in full; this is quoted from them, not from a
    summary." Then it fenced the work — reproduce before you repair, profile before you
    assume, a raised timeout is the same defect with a bigger number, and a cost found in
    production code is a scope question rather than a licence.
    That is the whole argument for this ruling in one turn: the difference between a
    coordinator that relays a claim and one that checks it is whether it can open the file
    the claim was made from. Without it the false premise reaches an agent as settled fact,
    in a goal, which is the one text every future run re-anchors on (ruling 189).
    (`task-attachments.server.ts`, `controller-toolkit.server.ts`,
    `operator-toolkit.server.ts`.)

294. **A usage reading belongs to an account, and the person whose account it is
    (owner, 2026-09-16, pass 37; F37-129, completes 146(a) and 165).** Three things, one
    idea, asked for as a UI change and mostly not one.
    THE READING NOW GOES WITH THE ACCOUNT. Ruling 165's own sentence is "the refusal
    Viberr observed on the slot goes with it", and `retireBackendRefusalsFor` applied it to
    two of the three records this module keeps: the exhaustion, the credential refusal, and
    not the utilization reading. Live, an hour before this was written: the owner connected
    a Claude account with a fresh window and `/insights` went on reading "claude · 95% of
    seven day · resets Sep 17" — a figure about an account no longer connected, on the
    surface a person checks to decide whether there is room to run. The refusal beside it
    retired correctly; only the percentage lied. A reading is never "stale but roughly
    right" after a credential change, because a new account's window has no relationship to
    the old one's, so it is deleted rather than aged. The function is
    `retireBackendRecordsFor` now, because it retires records and no longer only refusals.
    THE READING REACHES THE PERSON'S OWN CARD, which ruling 146(a) said it already did:
    "they are already rendered per person on Insights … and on Profile, which is where a
    fact about somebody's account belongs." Profile never rendered one. So this closes a
    drift rather than opening a disclosure — and "per person" is the binding half. The
    store keeps ONE reading per backend for the whole instance, stamped with whichever run
    reported it, and `/insights` renders that unscoped behind `requireRole("admin")`. The
    Agent accounts card is the first NON-admin surface to carry a utilization figure at
    all, so an unscoped field here would not duplicate an existing disclosure: it would put
    one member's account consumption in front of every member, under their own name. Two
    gates, and the second is not redundant — the principal check cannot catch a person's
    OWN older account, and the panel revalidates the loader the instant a sign-in succeeds,
    which is exactly when a surviving reading from the account just replaced would be
    re-rendered as the new one's.
    It is an observation, never a probe, and the card says so: the age of the reading, and
    that Viberr cannot ask the provider how much of a window is left. A missing utilization
    reads "not reported" and never a fabricated 0% (the rule `wire-format.server` already
    states for the same field); a percentage is clamped, because a provider on overage
    reports above 1 and an unclamped round renders "118% of seven day"; an empty
    `rateLimitType` falls back to "window" rather than composing "62% of " with a dangling
    preposition. Only Claude runs report readings today (`rate_limit_event` has no Codex
    counterpart), so a Codex card shows nothing rather than an empty row that reads as
    broken.
    THE SIGN-IN LINK IS COPYABLE, on both backends, from the step that offers it. Opening
    it in place only works when the browser reading the page is the one holding the vendor
    session, and often it is not: the instance runs on a server, the person is on another
    machine, the sign-in has to finish in a different profile. The only way to move that
    URL was to right-click an anchor whose href is a 300-character OAuth redirect. Same
    fixture as the code button beside it, deliberately — one gesture on this card, learned
    once — and the `copied` flag is keyed by WHICH button copied, because one boolean made
    both read "Copied" at once on the one backend that shows both.

    (`backend-quota.server.ts`, `profile-query.server.ts`, `agent-accounts-panel.tsx`.)

295. **A task's title is a claim, so it can be corrected like one (owner, 2026-09-16,
    pass 37; F37-130).** Viberr wrote a title once, at creation, and then never again by
    anyone: not the controller, not the task page, not an operator. `updateTaskGoal` wrote
    the contract every future run re-anchors on; nothing wrote the one-line summary of it.
    The controller found this about a title it had authored itself and then disproved, and
    ranked it first of five gaps: "What I wanted: change six words in the title I wrote.
    What I did instead: rewrote the entire 6,000-character goal. The title is what every
    person scanning the board reads; the correction lives in a body almost nobody opens. A
    false claim I authored is still on the board an hour after being disproved." It named
    the asymmetry exactly: `update_task` writes the goal, the priority, the labels, the due
    date and the wait, the goal being by far the most consequential of those, and then
    stops at the summary of all of it. There is no safety rationale in that shape. A title
    and a goal are the same claim at two lengths, and the shorter one was the harder to
    correct, which is backwards: it is the one that travels.
    So `updateTaskTitle` exists, behind the GOAL's gate (`update-goal`, maintainer and
    above) rather than `edit-task-meta`, because a title asserts what the work is and a
    label only files it. On the controller it is a field of `update_task` reporting on its
    OWN axis beside goal, metadata and wait: a title that wrote is never hidden behind a
    goal that was refused, and the reverse, which is the rule that tool already followed
    for every other field.
    The rename NOTES BOTH TITLES. A silent rename is the quiet half of this defect: the old
    wording is what every existing reference to the task says, in a comment, in another
    task's goal, in somebody's memory, and after a silent rename each of those looks like a
    reference to something else. The note carries the old title, the new one, and the fact
    that the key did not change. Ruling 288's rule applies one field over: a title longer
    than 200 characters is refused by name with NOTHING written and never cut, because a
    title is the one string the board card, the review-queue row and the goal-chain link
    all render, so a silently truncated one is wrong in more places than a truncated goal.
    Saving the same words is a `[noop]` that says so, not a `[done]` about a write that
    never happened.

296. **An argument Viberr does not know is a refusal, not a silent drop (owner,
    2026-09-16, pass 37; F37-131).** The SDK's `tool()` takes a raw Zod field map and
    builds a plain object from it. A plain Zod object STRIPS keys it does not declare, so
    a caller that invents or misspells an argument has its call run without that argument
    and gets an answer computed from whatever survived; the published JSON Schema carried
    no `additionalProperties: false` either, so the model was never told the key was
    invalid. Measured at the real MCP boundary before this was written, with a live client
    and server: `{ a: "x", status: "failed" }` reached the handler as `{ a: "x" }` and the
    call returned success.
    The controller hit the read half live and ranked it third of five gaps. It asked
    `list_runs` for failed runs; `list_runs` has no `status` argument; it got the LIVE
    listing back as though that were the answer. Its words: "it returned a
    plausible-looking wrong answer rather than refusing." The write half is worse and
    nobody had hit it yet, because the same machinery backs `update_task`,
    `run_agent_on_task` and `accept_completion`: a misspelled `duedate` rides along beside
    a good `goal`, and the tool answers "[done] VIB-1 updated: goal." while the date it was
    also asked for was never written. That is ruling 292's sentence again, a true one that
    implies a false one.
    `strictTool` is now the only way Viberr builds a tool, on all four surfaces (agent,
    operator, controller, controller-ops; 76 tools). The schema is a whole strict object:
    the call is refused, the offending key is named, and the handler is never reached, so
    nothing is half-applied. The refusal is predictable because `additionalProperties:
    false` is published alongside it, which is the difference between a rule and a trap.
    NESTED objects are strict at their own call sites with `z.strictObject`, not rebuilt by
    reflection inside the wrapper: rebuilding drops the `.describe()` text that IS the
    agent's instructions, and a rule you can read in the field map beats one you have to
    know a wrapper applies. Eleven nested objects existed and every one was stripping.
    MEASURED SAFE against live traffic, because a strictness that starts refusing real
    calls is a worse defect than the one it fixes: 191 tool calls across the stored run
    logs used only declared top-level arguments, and 94 nested objects (a packet's
    `observations` and `options`, a goal's `links`) used only declared fields --
    `code`, `goalDraft`, `newTask` and the rest are all in the schemas. Nothing any
    agent does today is refused by this.
    AMENDED the same day, from the controller taking the refusal and calling it "the least
    helpful of the five": it named the rejected key and not the accepted ones, and `status`
    was a near-miss of `state`, which IS a field of that tool's output. A refusal you have
    to guess your way out of is still a guess. The message now names the tool, the key it
    does not have, the arguments it DOES take, and that nothing ran; a tool with no
    arguments says that rather than printing an empty list.
    Three tests, because each one alone passes while the product is broken. A wrapper test
    drives a real MCP client against a real server, since the stripping happens ABOVE the
    handler and Viberr's toolkit tests all call handlers directly. A sweep fails if any
    source imports the SDK's own `tool()`, so a fifth surface cannot quietly opt out. And a
    walk over every schema the live controller servers PUBLISH finds any object at any
    depth that would still strip, which is what caught `save_knowledge_base.doc` after a
    first pass fixed only the one-line spellings of `z.object(`. That walk also broke a
    test that had been reading field descriptions off `inputSchema` as a raw field map; it
    reads the published JSON now, which is the only copy a model ever sees.

297. **A server tells the model what it holds, in a list built from what it mounts
    (owner, 2026-09-16, pass 37; F37-132).** The controller's two servers are mounted
    DEFERRED behind ToolSearch, which is measured and deliberate: `alwaysLoad` on
    44 tools tripled turn 1 and quadrupled a cold turn's cost, so the operator and agent
    toolkits carry it and these do not. What nobody costed is that a deferred toolkit never
    arrives as a LIST. The controller reported it from inside its own prompt, when asked to
    report what it could see rather than reason about what should be there: three tools are
    fully present (`ListAgents`, `ReportFindings`, `ToolSearch`), everything else is names
    only in a `<system-reminder>`, and "the list is incremental, not a manifest. The turn
    that shipped `list_decisions` listed four names, the turn that shipped
    `read_timeline_entry` listed three. So the complete toolkit exists in my context only
    as a union across eleven turns of reminders, never as one list."
    The cost is not a wasted search. Asked to drive a board, it answered "do I have
    `accept_completion`" by searching, finding nothing, and reporting a negative inferred
    from absence, which is the weakest evidence there is and the shape that had already
    burned it once. Four verbs it did not have had been attributed to it and it could not
    check them against anything.
    So each server's `instructions` now carry every tool it mounts: the name, and the first
    sentence of the description as its purpose. Instructions were the right place and that
    was MEASURED, not assumed. The controller confirmed they reach its prompt under
    `# MCP Server Instructions` and quoted both back verbatim; they sit in the system
    prompt, so on a 95.8% cache hit rate the manifest is paid once. Schemas stay deferred,
    because the shape of a call is what ToolSearch is good at; what was missing was knowing
    the verb EXISTS. The list says so in as many words: if a verb is not on it you do not
    have it, and say that rather than reporting a search that found nothing.
    CORRECTED the same day, by the controller looking for the manifest and not finding it.
    It first shipped in the two servers' `instructions`, on the controller's OWN
    measurement that those reach its prompt, which they do. What that measurement could not
    see is that a server's instructions are captured ONCE, when a session starts. Its
    conversation had been running for hours, so the deploy gave it the new TOOLS (the
    deferred-name reminder is regenerated every turn) and not the new instructions: "297 is
    the only one of the five I cannot observe, and the pattern, new tool names arriving
    while instructions stay frozen, suggests the manifest reaches new conversations and not
    running ones." That is exactly backwards for what a manifest is for, because the
    sessions open longest are the ones whose toolkit has changed most. It rides in the
    SYSTEM PROMPT now, which Viberr rebuilds and re-sends on every turn, and the frozen
    channel carries no copy at all so there is nothing beside it that can go stale.
    GENERATED FROM THE REGISTRY, never written, and the proof that this is the binding half
    was already in the controller's prompt. The one hand-written description of a Viberr
    toolkit said "Built-in diagnostics (viberr_ops) are always attached: instance health,
    run logs, store documents" and named three capabilities; `list_runs` shipped after that
    sentence and was never added to it. That sentence stops enumerating, and the tests
    check the list BOTH ways, because a hand-written one fails in the second direction
    first: every mounted tool appears, and nothing appears that is not mounted. A purpose
    longer than 150 characters is cut at a word and SAYS it was cut, naming where the rest
    is, which is ruling 285's rule again on a smaller string.

298. **An agent's answer choices are refused or kept, never quietly deleted (owner,
    2026-09-16, pass 37; F37-133).** `ask_human` told agents to give "2-4 answer choices",
    and nothing enforced it except a `.slice(0, 4)` in the packet builder and a second one
    in the Codex envelope parser. An agent that offered five got a decision card with four.
    Neither the agent nor the person reading the card was told a choice had been removed,
    and the removed one was the least likely to be reconstructed, because the surviving
    four read as a complete set.
    This is the pass's two defect families at once, on the one surface where they cost the
    most. A cap that truncates with no way out: a decision card is where a person picks,
    and an option deleted before it is rendered is a choice they never learn they had. And
    a rule applied to some siblings and not the rest: the OPERATOR authors packet options
    with no cap at all, and the stored packet schema has none either, so four was never a
    storage or rendering limit. It was a guideline, enforced by deletion, against one of
    the two authors.
    The number stays four for a LIVE question and is declared on `ask_human`'s own schema,
    so a fifth is refused by name with nothing written and the agent re-asks inside the
    same run at no cost. That is only possible because of ruling 296: before it, a `.max()`
    on a field the model overshot would have been a validation the caller was never told
    about. The refusal names the remedy too, in the field's own text: keep the ones that
    are really different and put the rest in `body`.
    The envelope path keeps EVERY option instead, and the asymmetry is the point rather
    than an oversight. That parse runs after the run has ENDED: it is the agent's last
    word, there is nobody to hand a refusal to, and refusing would discard the whole
    outcome rather than one field. Ruling 288's rule decides it: refuse where refusing can
    be acted on, and never destroy where it cannot. So the packet builder does no cutting
    at all now, and the only cap that exists is the one an agent is told about before it
    writes.

299. **The controller reads the repository it plans against (owner, 2026-09-16, pass 37;
    F37-134).** `read_default_branch_file` was mounted on the operator and nowhere else.
    The controller is the actor that writes the architecture, the knowledge bases and the
    goals every agent is then measured against, and that reviews the packets those agents
    raise, and it could not open a single file in the repository all of that is about. It
    has `read_pull_request` for a PR's CHANGED files, `read_task_attachment` for evidence,
    `read_knowledge_doc` and `read_store_doc` for the store. None of them reads the tree.
    It found this from inside a live decision rather than in the abstract. A packet on
    SHOP-47 turned entirely on "the goal names four anonymous routes, `origin/main` has
    nine", a fact the operator had verified by reading the file. The controller endorsed an
    option on structural reasoning and flagged that its own central claim was second-hand,
    and named the cost: "verify the claim against the repository yourself is the
    most-repeated rule in this project's own rulings, four worked incidents, and I am
    structurally unable to follow it."
    The checkout was never the source. `resolveReadSource` already prefers the project
    MIRROR and only falls back to a checkout's clone-time ref, so the operator's signature
    takes a workspace for the fallback's sake, not the read's.
    `readProjectDefaultBranchFile` takes the repo and the branch from the PROJECT instead,
    and therefore has nothing to fall back TO, which is the right shape: when the mirror
    cannot be built it says which branch it could not reach and why, rather than answering
    from a tree that is not that branch, which is the error this whole module exists to
    stop (F21-21, where an operator read the deliverer's own uncommitted row and declared
    it had landed out-of-band). It passes `create: true` where the operator's read passes
    false, because a missing mirror would otherwise make the tool permanently unanswerable
    on exactly the project where nothing has run yet, which is when the controller is doing
    the architecture work that most needs to read the repository.
    A project with no GitHub repository at all is answered, not thrown at: it names the
    missing fact and the tab where a person sets it (ruling 246, existence before type). A
    path that is not on the branch is `[absent]`, which is an ANSWER. A file past 60,000
    characters says it clipped and what to do instead (ruling 285).
    The residual is stated rather than papered over: on a project whose repository has
    never been cloned here, that first call BUILDS the mirror inside the tool call, bounded
    by the clone timeout (15 minutes by default), and the tool's own text says so. The
    alternative was a tool that can never answer on exactly the project where the
    architecture work happens. Every call after the first is a fetch.

300. **A decision says what answering it releases (owner, 2026-09-16, pass 37; F37-135).**
    `list_decisions` told the controller what is waiting for a person and what each card
    asks. It did not say what any of them UNBLOCKS. That five tasks sat behind three cards
    (SHOP-46 to SHOP-48; SHOP-41 to SHOP-28; SHOP-49 to SHOP-29 to SHOP-28) the controller
    worked out by reading each task's `blockedBy` and walking the chain by hand, across two
    turns, and it named the cost precisely: "the one number that should order a decision
    queue does not exist, so the ordering depends on whoever happens to have walked the
    graph recently."
    Every entry now carries `releases`: the tasks that come unblocked, down the chain, once
    that one completes. The chain matters as much as the count. A card that frees one task
    which in turn frees three is not a one-task decision, and the direct dependents are
    exactly what a person can see for themselves by opening the task, so stopping there
    would have published the number they already had.
    A wait that can NEVER clear is not counted, and that is the half a naive walk gets
    wrong. A task also blocked on an archived task, a cancelled goal or a reference nothing
    answers to is not waiting on this decision, and counting it inflates the one number a
    person is meant to order their queue by. So does an open goal link with no task yet: it
    is a real wait, no task key completing satisfies it, and dropping unmatched entries
    would quietly clear it. The number argues for a decision only when the decision would
    actually free something.
    AMENDED the same day, from the controller using it: "it orders the BLOCKING queue
    correctly and only that... Sorting by `releases` alone would rank three finished tasks
    that need one click last, behind a design packet. The number answers what does this
    unblock, not what does this finish, and on a queue that has become mostly acceptances
    those diverge. It is the right number and it should not be the sort key by itself."
    Exactly right, and the tool says so in its own description now rather than leaving the
    next reader to rediscover it: `kind` and `notAcceptableReason` carry the other half.

301. **A background tab holds no live connection (owner, 2026-09-16, pass 37; F37-136).**
    Four open Viberr tabs deadlock Viberr, in every tab at once, with no error anywhere.
    An SSE stream is a PERMANENT connection; a browser allows about six per origin on
    HTTP/1.1; the shipped deployment serves HTTP/1.1 (`curl -w %{http_version}` against
    `localhost:5173` answers `1.1`); and a task page holds TWO streams, the layout's
    `useLiveUpdates` and the console's `use-run-log-stream`. Four tabs is eight, the pool is
    gone, and every request from every tab queues forever.
    Measured live on the running instance, while resolving a real decision packet: with one
    tab a `fetch` of `/resources/health` returned in 21ms and with two in 10ms; with four,
    the page's own POST sat pending and a tool call against that tab was still hung after
    300 seconds, while the SAME endpoint answered `curl` from the host in 12ms. Closing
    tabs recovered it. The server was never the problem, which is exactly why this is so
    hard to see from the inside: nothing is slow, nothing errors, the loaders simply never
    resolve and a submitted form's button stays busy forever. It is this pass's worst
    failure shape, a path blocked with no way out, and the way out (close tabs) is
    unguessable.
    A hidden tab now holds no stream. Both hooks close on `visibilitychange` and reopen on
    return, and neither needed new catch-up machinery, which is the sign it was the right
    cut: `useLiveUpdates` already pulls the loaders on any connect that FOLLOWS a previous
    stream, so a returning tab revalidates rather than rendering the snapshot it had when it
    left, and the run-log tail already resumes from its own per-run cursor. A background tab
    never needed a push. It needs to be correct when you come back to it.
    The residual is stated rather than papered over. This bounds the steady state by VISIBLE
    surfaces, not by tabs, so two windows side by side hold four connections and three would
    still reach the cap. Two streams per page is the remaining constant, and merging them is
    the next cut if anyone meets it; the proper fix for the class is one shared stream per
    origin, or a protocol that multiplexes, and neither is this change.

302. **A window says it is a window (owner, 2026-09-16, pass 37; F37-137).** Ruling 285
    fixed the per-ENTRY cut in `operatorSnapshot` and left the cut immediately beside it
    silent. A clipped entry now carries a `clipped` note naming the tool and the
    `occurredAt` that reads it whole, because "an entry that ends mid-sentence with a '…'
    and no way to ask for the rest is how a coordinator states half a report as the whole
    of it, which it did, live, on SHOP-42". The very next expression was
    `file.parsed.timeline.slice(0, 6)`, which said nothing at all: not that there were more
    entries, not how many, not how to reach one.
    Both of this pass's defect families, in one function, one of them already fixed. The
    operator could not know the window was a window, and could not widen it: its `get_task`
    took NO arguments, while the controller's has taken `events` (1..50, default 12) for as
    long as it has existed. So the coordinator with the least context about a task's
    history was the one actor who could not ask for more of it, and a task whose seventh
    newest entry is a human's instruction, a reviewer's verdict or a packet answer is one
    the operator would reason about as though that entry did not exist.
    The snapshot now always carries `timelineTotal`, so a full-looking window is never
    mistaken for the whole history, and `timelineOlder` appears ONLY when something is
    hidden, naming how many were left out and both ways to reach them: `events` to widen,
    `read_timeline_entry` to read one in full. The default stays six, because the size was
    never the defect; the silence was.
    CORRECTED, same day, before this ruling had been standing an hour. It first said the
    prompt-size rationale "did not survive checking" because `operatorSnapshot` had "exactly
    one caller, this tool, so the window was never riding in every prompt". That was wrong,
    and wrong the way this pass keeps finding things wrong: a grep scoped to the two
    directories I was already looking at. `operator-run.server.ts` calls it twice more, to
    build the prompt, exactly as the original comment said. The bound is real and the
    default staying six is what respects it. The disclosure is the better for it: both
    prompt callers take the default, so `timelineTotal` and `timelineOlder` now reach the
    operator in its PROMPT as well as through the tool, which is where it needed them.
    EXTENDED, within the hour, to the sibling it was first written without -- which is the
    defect this ruling is ABOUT, and which ruling 292's own comment had already named
    inside this pass's own fix: "a rule applied to one actor and not its sibling, which is
    this pass's own defect shape inside this pass's own fix." 302 fixed the OPERATOR's
    window and left the controller's `get_task`, where `eventCount` was present and
    nothing prompted anyone to subtract from it. The controller found it on live work the
    same turn the fix shipped: "I read 5 of 121 entries on SHOP-36 and 4 of 111 on
    SHOP-27, and coordinated from them. I can derive the gap from `eventCount` minus what
    I got, but nothing prompts me to, which is exactly the failure you just fixed one
    surface over." Its reply carries `timelineTotal` always now, and `timelineOlder` only
    when something is hidden, naming `events` to widen and `read_timeline_entry` to read
    one whole: the same two ways out, worded the same way, on both actors.
    AND A THIRD SIBLING, found by finally sweeping for the shape instead of waiting to be
    told: `list_runs` clipped at `limit` and said nothing. A caller asking "which runs are
    live right now" got a list that looked complete and could not reconcile it with the
    count `instance_health` reports for the same instant. Its two neighbours on that same
    server were already correct, which is what makes it the family and not an oversight:
    `read_run_log` has carried `olderExist` / `newerExist` and recovery cursors since pass
    32, and `inspect_audit_log` has carried `total` / `shown` / `noMatch` since ruling 279.
    It carries `total` always and `truncated` only when rows were left out, naming the
    count and the `limit` that returns them.


303. **An unexpected failure answers in words, on every surface (owner, 2026-09-16,
    pass 37; F37-138).** Found by reading what the product actually returned rather than by
    asking anyone: a sweep of 1,265 tool results across the last sixty run logs turned up
    22 errors, and four of them were the literal string `database is not open`, answered to
    a live run by `get_task` and `read_board`. Timestamped 19:30:38 through 19:30:43, with
    this container starting at 19:30:46 -- the six seconds in which the old process closed
    its database while a run was still calling tools.
    The shutdown ordering is not the finding. The LEAK is. Every one of the operator's 17
    tools handed its handler to the SDK bare, so any throw inside became the model's answer
    verbatim: a SQLite sentence here, a stack's message elsewhere, whatever it happened to
    be. Both of its siblings convert. The controller's `run`/`runWith` guards answer
    "[error] That action failed unexpectedly. The details are in the server log"; the agent
    toolkit catches per tool and answers "[error] The board could not be read." The
    operator -- the one actor whose job is to relay what it reads onto a human's timeline,
    and which had no `catch` in any of its seventeen -- was the one that did not.
    So the conversion lives in `strictTool`, where ruling 296 already put the rule that
    every Viberr tool on every surface passes through and a new one cannot opt out. An
    `AppError` keeps its own words, because those were written for the caller and are the
    refusals this codebase spends its care on. Anything else is logged with the tool's name
    and answered with the sentence that stops a relay: this call produced no answer, so do
    not report one, because not getting a result is different from getting an empty one.
    It is the OUTERMOST wrapper and never the only one, which is what keeps it from
    swallowing a refusal somebody worded carefully. The controller's own guards sit inside
    it and catch `AppError`, `NotVisibleError` (404-shaped by design, controller-only) and
    everything else first; the operator and agent toolkits throw nothing but `AppError`,
    which keeps its words here. Checked rather than assumed, because a generic "failed
    unexpectedly" over a deliberate refusal would be a worse defect than the leak this
    fixes.

304. **The ceremony that merges says what CI thinks of the head it is merging (owner,
    2026-09-16, pass 37; F37-139).** The acceptance dialog is the last screen before an
    irreversible merge into the default branch, and it is built to state what the click
    does: it names the pull request, the base, the branch it refreshes first, the verdict
    that cleared the gate, any stage it skips, and the decision it withdraws. It did not
    name the CHECKS.
    Checks are deliberately not an acceptance gate on this product; the reviewers' verdicts
    are. That is the reason to show them, not the reason to omit them: the product has
    decided not to decide, which leaves the decision with the person clicking, and it was
    not telling them. The pill existed and was rendered one panel up on the same page
    (`task-side-panels.tsx`), so the dialog's `AcceptConfirmTask` simply never carried the
    field.
    Found by using it. With GitHub Actions quota-blocked on the clone repository, four pull
    requests were accepted and merged carrying three failing checks each, and the ceremony
    named the PR, the branch, the base, the verdict and the skipped stages without once
    mentioning them. Ruling 246's rule decides it: name the door AND say whether it is
    open.
    The row appears ONLY when the checks are not green, because a row that fires on a pass
    is noise on the screen that most needs reading, and it carries the sentence that keeps
    it from reading as a block: checks are not a gate here, so merging anyway is your call.
    Pending says the merge does not wait. Nothing reported stays silent rather than
    rendering as green, which is the same rule `wire-format.server` already states for that
    field.

305. **A whole-document replace names the version it read (owner, 2026-09-16, pass 37;
    F37-140).** Ruling 257's guard asks whether a knowledge-base document EXISTS, and
    refuses a write that would collide unless it is told to replace. It never asked whether
    the document is still the one the writer READ. Between a read and a write, anybody
    else's edit lands, and a whole-document replace deletes it and reports only how many
    bytes it destroyed. That is a lost update, on the one file this instance injects into
    every run on a board.
    Not hypothetical. The controller reported it from inside the work: correcting one
    paragraph of the 26,693-character rulings document, it "re-read the source first
    specifically to avoid clobbering changes someone else had made since (there were
    several -- §9 had grown a whole existence-oracle section I had not written)." The
    product's affordances are what let it avoid the loss: ruling 257's refusal, the byte
    count in the reply, and a reader to carry the text forward. But avoiding it was
    DISCIPLINE, and a shape that only careful writers survive is not safe.
    So `read_knowledge_base_doc` hands back a `version` and a replace must name it.
    `replace: true` alone is no longer enough, because a flag that says "yes, overwrite"
    answers a different question from "yes, overwrite THIS". A write whose base has moved
    is refused whole, with nothing written, naming both versions and saying plainly that
    somebody else's edit is in there and the change should be redone on top of what is
    there now. The version is hashed from the FILE, never from `readStoreDoc`'s text, which
    caps at 256 KB: a version computed from a truncated read would call two different
    documents the same one.

306. **The attachments directory is read as well as written, and it now says so (owner,
    2026-09-16, pass 37; F37-141).** It shipped as a DROP BOX -- "to put a file in front of
    the humans on this task, copy it into ..." -- which is half of what it is. It is a real
    absolute path, and on a task that has run before it already holds every file those runs
    attached: 27 on SHOP-11 of this instance's board, 90 on SHOP-15, 44 on SHOP-16. An
    agent reworking such a task was standing next to the evidence its directive was
    summarising, told only where to put things.
    That is rulings 285, 292 and 293 one actor over. Each of those gave a COORDINATOR the
    thing it was relaying claims about -- a report past its clip, a timeline entry whole, an
    attachment rather than the sentence claiming it -- and 293's own text says "call it
    before you tell a person a thing was proved, and before you repeat a report's claim
    about what its own evidence shows". The agent DOING the work was the one left repeating
    them, and it was the only actor with no tool for it. The capability was already there:
    the path is absolute, outside the checkout, and readable by anything with a filesystem.
    Nothing named it.
    So the section is two-way, and the reading half carries its own bound: list it, and read
    what your directive or the timeline actually CITES, by name, never the whole folder,
    which on this board can be ninety files. A prompt that sends an agent to sweep an
    evidence directory has traded one silent failure for a context it cannot afford. The
    sentence that says why it matters at all is the one worth keeping: a report saying a
    thing was proved and the file proving it are different objects, and only one of them is
    evidence.

307. **A turn opens knowing what is happening, not only what exists (owner, 2026-09-16,
    pass 37; F37-142).** An instance-scoped controller conversation opened each turn with a
    server read listing the person's visible PROJECTS: slug, name, their role. Nothing about
    any of them. A project-BOUND conversation has opened with a board snapshot all along, so
    the actor with the widest scope was the one starting from zero.
    The controller found it by being asked a different question. Every earlier round asked
    where its toolkit ran out; this one asked where a PERSON talking to it gets a worse
    outcome than they should. Its answer: "the turn's context block gives me your visible
    projects, not the board. So every board question starts from zero. On the turn where you
    said 'drive it', you waited through `list_runs`, `list_decisions`, `list_tasks` and three
    `get_task`s before I did one useful thing. For a person who just wants 'what is
    blocked?', that latency is the entire experience of talking to me."
    The numbers were never missing and never cost anything. `listHomeProjectsForUser` already
    computes `total`, `running` and a member-scoped `waiting` for the home page's own cards,
    off the same `indexDecisionInbox` the notifications inbox reads, so the two surfaces
    cannot answer "waiting on you" differently. This read was CALLING that function and
    discarding the fields. One line per project now carries them, with no new query.
    A zero says so in WORDS. "nothing waiting on you" and a blank are the same pixels and
    opposite claims, and the whole point of the line is to be answerable before a tool call.
    The org-admin override keeps its own case rather than being folded into "waiting on
    YOU", which is R8-3's rule on the surface that rule was written for.
    The controller's own framing of the class is worth keeping, because it is the bar for
    everything after this: "The goal is not to let me hedge accurately. It is to stop me
    needing to hedge."

308. **A breakdown says what its window left out, and there is one for the two questions
    people actually ask (owner, 2026-09-16, pass 37; F37-143).** Insights groups runs by
    backend, kind, project and model, keeps the top eight of each (half the slots reserved
    for the busiest groups, so a cost view still shows where the work happens) and dropped
    everything else in silence. Eight of thirty groups, presented as the instance, on the
    one surface a person opens to decide where their money goes. Every breakdown now
    carries `hidden`, `hiddenRuns` and `hiddenCost`, and a dropped-group cost follows
    `CountRow`'s own rule: null means UNKNOWN, never zero, because only the Claude result
    envelope reports one.
    And the two dimensions that were missing are the two a person asks for. The controller
    put it plainly when asked where someone talking to it gets a worse answer than they
    should: "'What did SHOP-27 cost across eleven rework rounds' has no answer. 'Which
    reviewer earns its runs' has no answer. You are running this instance and cannot see
    what it costs you." `byKind` cannot answer the second, because every reviewer is one
    kind. `byProfile` and `byTask` are the same `group()` helper on two columns that were
    already in the table.
    A task key is unique only inside its project, so an unscoped read labels each row
    `project/task` and a scoped one drops the prefix, which is noise once the keys are
    local. Grouping on `task_key` alone would collapse two projects' `A-1` into one row
    belonging to neither, which is the failure this ruling is about wearing a different
    hat: a number presented as an answer to a question it is not the answer to.

309. **The controller is told what the person may do, and what a role means (owner,
    2026-09-16, pass 37; F37-144).** The controller's prompt says "their LIVE permissions
    are the ceiling for everything you do here" and then names their ORG role — which
    decides nothing on a board. The role that decides everything is the PROJECT role, and
    in the two bound scopes, the ones a person is standing in when they ask for something,
    the turn context named it nowhere. Ruling 307 had given it per project to the instance
    scope, where it matters least.
    The second half is worse and was invisible: viberr's authorization map reached the
    model NOWHERE. Not the prompt; not `whoami`, which returns a tier NAME; not
    `list_capabilities`, which is the agent capability catalogue and a different axis
    entirely. So a round trip bought the word "contributor" and the meaning still came out
    of the model's prose memory. Asked on a live task what the person in front of it could
    do, the controller answered correctly and then said how: *"your project role was not in
    anything I had... I bridged that gap with a rule from my playbook. That rule is real,
    so my answer lands correctly — but I reached it by policy reasoning, not by reading
    your role"*, and on the map, *"that is documentation, not the server's live
    authorization table"*. Its summary of the class: **"the task file is over-supplied and
    the actor is under-supplied."**
    The cost is not a wrong sentence. It is an OFFER that cannot be kept, and a fan-out —
    create, invite, deploy, set policy — that stops at step four leaving a half-built
    board. The tier list is GENERATED from `RBAC_DEFINITIONS`, for the reason `rbac.ts`
    already gives for rendering the Policy page from the same object: one source, so
    display and enforcement cannot drift. A hand-written summary in a prompt is that drift.
    Three things the controller argued for, against the version first put to it, and was
    right about each:
    IT IS ADVISORY, NEVER ENFORCING, and the prompt says so in those words. *"A table in my
    prompt creates a second authorization evaluator that can disagree with the first... if
    I start pre-refusing on that basis, I convert a server [denied] — authoritative,
    audited, correct at the instant of the write — into a controller refusal that is none
    of those three."* So: predict the refusal, say why, **make the call anyway**, and let
    the server's answer be the answer.
    THE FACTORS STAY SEPARATE. The obvious alternative was for the server to compute the
    asking person's held and not-held sets and hand over only those — shorter, and
    impossible to mis-apply. It is also the answer with the reasoning deleted: *"when it
    tells me I don't hold `set_file_leases`, I cannot tell you why: whether it's maintainer
    or project admin that's missing, whether promoting someone one tier fixes it or only
    two."* Every question about GRANTING a role is a question about a tier other than the
    asker's, and a set describing only the asker cannot answer one. The static list says
    what a role holds, the live read says which role this is, and the model multiplies.
    THE HAND-WRITTEN HALF SAYS IT IS HAND-WRITTEN. *"Is the exception text also generated,
    or hand-written prose sitting next to a generated table? If it's hand-written, it is
    the new prose summary — same failure mode as today, now with a generated table's
    credibility lending it authority."* The exceptions live in code paths, not in a table,
    so they cannot be generated; the block therefore marks where generation stops, and
    `authorityTiers` throws rather than emit a tier list if `RBAC_DEFINITIONS` ever stops
    being monotonic over the tier — the invariant `rbac.ts` asserts in prose and nothing
    checked.
    What it does NOT close, in the controller's accounting: the fan-out has three causes
    and this addresses one. State-dependent denials (a name already taken, a task key that
    does not exist) are a different gate, and *derived* authority is a different problem
    again — `create_project` makes its creator that project's admin, so step one changes
    the authority steps two through four are judged against, which no turn-start snapshot
    can model. Its own prescription there is not a feature: *"don't check a chain, don't
    undo a chain, don't have a chain"* — make genuinely compound operations single calls
    the server applies as a unit — plus reporting exactly which steps landed when one does
    not. Recorded, not built.
    One amendment it asked for was REFUSED on the facts: moving the org role out of the
    preamble because *"my preamble asserts your org role as prose fixed at conversation
    start"*. It is not. `buildControllerSystemPrompt` runs every turn and
    `resources.controller.ts` passes `auth.user.role` from `requireUser`, which loads the
    canonical `users` row per request. A demotion reaches the next turn already. Its own
    reading of the error is the useful part: *"I inferred it from how chat systems are
    generally built, not from anything I'd observed about viberr, and then asserted it as a
    property of your pipe. That is the same error as the prose-summary one, one level up."*
    A LAST LINE, ADDED AFTER SHIPPING, because the fix creates a hazard of its own. Most
    of the refusals in the hand-written half are not about tier at all — archived, disabled,
    non-member, name taken — and the block hands the model tier VOCABULARY. The controller
    saw it first: *"'you need maintainer, ask a project admin' isn't an incomplete
    explanation, it's a false one, and the table will actively tempt me toward it... the
    thing to watch for isn't 'I hit a denial I couldn't explain in tier terms', it's 'I
    explained a denial in tier terms when tier was never the gate'."* So the block ends by
    saying that a refusal whose own words name no role was not stopped by one, that the
    model must not supply one from the list, and why: a person sent to fix the wrong gate
    is worse off than one told nothing.
    A measurement this leaves available, recorded and not run: the audit log plus the
    generated list is an offline diff — every permitted action against what the list
    predicts. It checks the generated half automatically and cannot touch the exceptions,
    which is exactly where the risk is.

    (`authority-prompt.server.ts`, `controller-context.server.ts`, `controller-run.server.ts`.)

310. **A run is told WHY its granted server did not arrive, and the reason is the one the
    server gave (owner, 2026-09-16, pass 37; F37-145).** Both run prompts answered "your
    profile grants this and it is not here" with a single hardcoded sentence — *"no such
    server is in the org registry"* — for a condition with many causes. Neither prompt had
    checked it. The mount verifier had already produced the real one and
    `UnresolvedMcpGrant.reason` carries it under a comment that says exactly what it is for:
    *"why it produced no usable tools, in words a human can act on"*. Six call sites then
    did `.map((u) => u.name)` and dropped it.
    Found live, and the invented cause was FALSE. On SHOP-55 the Platform Architect reported
    that the `kb-architecture` MCP server *"is not in the org registry"* — faithfully
    relaying what viberr had put in its prompt — and the operator checked and corrected the
    record in its packet: *"That is wrong: it IS registered and IS granted to the Platform
    Architect profile — it simply was not mounted on that run."* So a reader was sent after
    a registration bug that did not exist, and whatever actually went wrong went unreported.
    This is the failure ruling 303 is about, arrived at from the other direction: 303 was an
    error that said nothing, this is an error that said something specific and untrue. A
    manufactured diagnosis is worse than none, because it is actionable.
    THE CODE ALREADY KNEW. Pass 32 (C02-R5) wrote an exclusion into the resolver with this
    comment: the persona's copy *"would be false for a server that IS mounted"*. It saw the
    sentence lying, and fixed the CASE rather than the sentence — while the same loop was
    already producing two other reasons the sentence was equally false for (an unreadable
    credential, a server that fails to start). A known-false sentence with a documented
    exception is a bug with a note attached, and it survived four passes that way.
    `unavailableMcpSection` is one renderer for both surfaces, for the same reason ruling
    296 and 303 live in `strict-tool.server.ts`: two prompts describing one fact in their
    own words is how the sentence came to state a cause at all. It lists each grant with the
    reason its own probe returned, and closes the inference the old sentence invited — do
    not infer a cause, and do not assume the grant or the registration is missing unless the
    reason says so.
    310(b), A FOURTH SITE, found by the controller ninety seconds after 311 deployed and on
    the same timeline. The restart-recovery note says *"the run `X` (agent) was still
    running when the server stopped"* — and the sweep finalizes QUEUED runs as well as
    running ones, so a run that never got a concurrency slot was described as having been
    running. Live: `run_VlR9mwnxyouc`, `startedAt: null`, zero turns, queued 44 minutes. The
    controller put the adjacency better than any argument for the class could: *"At 01:24:19
    the recovery note asserts a run was running that never ran. At 01:25:49 the new 311 line
    says, correctly, 'Queued a Claude run … Nothing is streaming yet.' One writer fixed, its
    neighbour still inventing."* `started_at` was on the row and the query did not select
    it. The note now splits its list: what was running, and what was queued and had not
    started.
    It also showed the 282 historical "Started a Claude run" entries are not lost to doubt:
    `started_at` is kept permanently, so an entry can be classified by joining it to its run
    — null means the entry was false when written, a later `started_at` means it was false
    for exactly that interval.
    THREE SURFACES, not two. The controller found the third by reading its own prompt and
    asking which of its claims say how they know — the habit ruling 309's provenance marker
    taught it: *"other environment assertions in my prompt don't: the shell inventory
    declares itself measured, but the line telling me no org MCP servers are attached to me
    doesn't say how it knows."* Its prompt was the best of the three and still not enough —
    it asserted no cause at all, naming the servers and stopping — but it is the surface a
    person asks WHY on, and the reason was one `.map((u) => u.name)` away there too.
    The run RECORD still keeps names; the reasons ride the prompt, where the agent that has
    to report the gap can read them. (The KB and skill misses have carried name-and-reason
    on that record since C1, which is the asymmetry that made the MCP path's silence easy
    to miss.)
    Canaries: restoring the hardcoded cause, dropping the per-server reason lines, removing
    the do-not-infer instruction, and having the renderer substitute a sentence of its own
    all go red. The last of those is the one that matters — it binds the RESOLVER's words to
    the rendered text, because a test that hands the renderer its own fixture proves only
    that the renderer can print.

    (`specialist-mcp.server.ts`, `specialist-run.server.ts`, `operator-run.server.ts`.)

311. **"Started" only when it started (owner, 2026-09-16, pass 37; F37-146).** `startRun`
    answers `outcome: "started" | "queued"`, and the task timeline's dispatch sentence threw
    it away. A run parked behind the instance's concurrent-run cap wrote *"Started a Claude
    run for the X agent — streaming to the agent logs"* onto the timeline. Both halves were
    false, for as long as the queue held it.
    Live, eleven minutes on SHOP-55, and it propagated exactly as far as a false record
    does: the operator read the timeline and told a person the Backend Engineer's run *"was
    already in flight"*; the controller relayed that to me as fact; I was about to decide a
    dispatch on it. The controller then spent one `list_runs` and found the truth —
    `state: queued, startedAt: null, 0 turns, 1 log line`, with three runs ahead of it — and
    corrected itself unprompted: *"Symptom right, cause wrong, and I carried it. That is
    ruling 310's shape, committed by me, in the turn before you described it."*
    The fact was never missing, and one surface already said it properly: `operator-actions`
    has answered *"the instance is at its concurrent-run cap, so the run is queued and
    starts when a slot frees"* since B10. That is a tool reply — read once, by one agent.
    The timeline is the durable record every person, every later run and the controller read
    instead, and it said the opposite.
    THE CLASS, in the controller's words, which is the most useful sentence of the pass:
    *"a fact the system genuinely had was displaced by a confident hand-written sentence …
    authoritative-sounding text standing in front of available ground truth."* Rulings 309,
    310 and 311 are three instances inside two hours — `RBAC_DEFINITIONS` displaced by
    prose, a stored mount-failure reason displaced by an invented cause, and a live `outcome`
    displaced by the word "Started". Its own prescription is the sweep: **anywhere a string
    literal explains a condition that has a stored reason.** That sweep over the timeline
    writers found no fourth instance — `Pushed`, `Opened PR #n`, `Merged` are all written
    after the call that did the thing, and the operator's `Started` reply sits below an
    explicit `queued` branch.
    `runDispatchLine` is pure and exported, for the reason ruling 307 extracted
    `projectStateLines`: the branch IS the ruling, and testing it through the dispatch path
    needs a live cap, two tasks and a fake runtime that does not finish before the second
    dispatch arrives — which is how the first attempt at this test came out green.

    (`specialist-run.server.ts`.)

202. **Delivery is something the operator DID (owner, 2026-09-13, pass 37; F37-22).** The
    stranded-operator backstop judges a finished drive by whether it moved the stage, and on
    SHOP-10 it met a drive whose entire plan was one `deliver_for_review` — it pushed
    `shop-10` and opened PR #8 — and wrote: "the operator held it twice in a row without
    advancing, dispatching, or opening a packet … **Coordination is paused here: run the
    operator manually**". Both halves were false. The first of the two drives had
    *advanced* (Design → Build) and the second had *delivered*; and coordination was not
    paused — the next operator drive had started **two milliseconds before the note was
    written**, moved the task to Review 23 seconds later and engaged a reviewer, with no
    person involved. Three of the four things a drive can do were already covered: a
    transition by `movedToStageId`, a dispatch by the live-run check in
    `settleWaitingAfterOperator`, a packet or a recommendation by `operatorLeftTaskStranded`.
    Delivery was covered by nothing — and it is the one act whose effect can outlive the run
    row, because the push and the PR call answer after the row is `finished` (live: an
    eight-second window, and the settle ran inside it). So `performDelivery` stamps
    `ctx.operatorRun.delivered` on ENTRY, before its first await, and the backstop counts
    delivery as progress beside a transition. On entry and not on GitHub's answer: a refused
    push is still a drive that acted, and the question the backstop asks is what the operator
    did, not what GitHub allowed. The cost of the old reading was not only a false sentence:
    the note also writes the durable `heldAtStage` marker, which silences the nudge at that
    stage until a human re-litigates it, so a task whose delivery is its last event would sit
    with a manufactured pause and a person told to end it. This is F37-17's mirror, and it
    gets the same answer: the record has to say what happened.
    (`task-actions.server.ts`, `task-mutation.server.ts`, `operator-run.server.ts`.)

203. **A refusal may not promise a delivery viberr has no way to make (owner, 2026-09-13,
    pass 37; F37-23).** An @mention of an agent that already has a live run on the task is
    refused by the single-flight guard — correctly; two processes in one checkout is what it
    exists to prevent. The sentence that followed was not: "it will see the comment when it
    next re-anchors". Re-anchoring is `canonicalTaskAnchor`, built only by a FRESH run, whose
    timeline section is the **five** most recent events, each clamped. So the promise held
    only if that agent ran again on that task before five more events landed, and viberr
    checks neither condition and knows neither. Live on SHOP-6 both failed: an owner's
    correction was eight events back within 75 seconds, and the Platform Architect it named
    never ran on that task again before the task was accepted. Meanwhile the un-refused path
    hands the agent the comment as its DIRECTIVE (`directive`, `directiveFrom`) — the whole
    instruction, verbatim, as the reason the run exists — so the refused path was not a
    degraded delivery but a different thing wearing the same words. This is the bar's two
    halves at once: viberr states a delivery it cannot make, and a person's typed instruction
    is accepted, rendered, addressed to a named agent and then silently dropped, with the note
    reading as reassurance. Viberr had already ruled on this one layer up — the operator lease
    keeps queued human `@operator` comments and drains them oldest-first ahead of the machine
    trigger, "because the question exists NOWHERE else in the run's input" (B-OP2) — and the
    specialists got the refusal without the queue. So: at a specialist run's completion,
    `deliverDeferredMention` finds a human comment addressed to that agent posted after that
    run started (by construction undelivered: the single-flight guard is the only thing that
    could have refused it), and starts the run for it with the person's words as the
    directive, BEFORE the operator's own react trigger — a person's instruction goes first,
    and the operator is re-invoked by that run's completion, so nothing is skipped, only
    ordered. Oldest first, one per completion, which drains a burst in order. **Nothing is
    queued in memory**: the comment is the record and "undelivered" is derived from it, so a
    restart cannot lose it. The refusal copy now states what viberr will do. A redelivery that
    fails writes no second note — the first one already named the agent and the reason.
    (`task-actions.server.ts`.)

204. **A deadlock counter may not be keyed on the thing that stops moving in a deadlock
    (owner, 2026-09-13, pass 37; F37-24). Reverses ruling 193's revision-counting.**
    Ruling 193 escalates when a reviewer's objection survives a rework
    (`consecutiveRequestChanges` ≥ 2), and counted DISTINCT REVISIONS — a deliberate choice,
    with a test defending it, so that a reviewer re-run on the same revision would not
    escalate. Live on SHOP-9 that is exactly backwards. Its Verify charter demanded a
    cold-started stack the task is not allowed to build (another task owns the Makefile and
    the services); the deliverer answered "no legitimate deficiency remains within the owned
    paths" and committed nothing; the operator re-engaged the verifier on the SAME revision and
    it blocked again. Verdicts are last-write-wins per (profileId, revisionId) (F10-15), so the
    second objection REPLACED the first and the counter read **1**. The count can only exceed 1
    when the deliverer minted a new revision — that is, when the work is moving — so it fires
    where a packet is least warranted and is pinned at 1 in the deadlock it was written for.
    (The operator opened the packet anyway, on its own reading. That is a good model, not a
    mechanism; F37-14's ten rework rounds are what the same board looks like without one.)
    The verdict row keeps last-write-wins, which is right — a verdict judges a revision and the
    latest judgement binds. What survives the overwrite now is `rounds` on the verdict:
    incremented when the same reviewer returns the SAME result on the SAME revision, summed
    across the trailing request_changes streak. A re-review that blocks an unchanged revision
    is the second objection it plainly is; a re-DISPATCH that records no verdict still counts
    for nothing, which is the distinction ruling 193 was reaching for and missed by using
    revisions as its proxy. `get_task`'s field description and the turn doctrine were both
    rewritten to teach the new meaning, because a field whose description and behaviour
    disagree is ruling 200(i)'s defect.
    (`task-file.schema.ts`, `task-actions.server.ts`, `operator-actions.server.ts`,
    `operator-toolkit.server.ts`, `operator-run.server.ts`.)

205. **A person's burst is one message, and none of it may be dropped (owner, 2026-09-13,
    pass 37; F37-25 — self-review of ruling 203, one hour old).** Ruling 203 delivers the
    @mention that the single-flight guard refused, at the busy run's completion, and its own
    doc said: "Oldest first, one per completion, which drains a burst in order — the next one
    rides the next completion." It does not. The window is "posted after the busy run started",
    so the instant the oldest comment starts a redelivery run, every other comment in the burst
    is older than THAT run's start and no later completion can ever see it. Two messages typed
    thirty seconds apart, the second silently discarded: ruling 203's own failure mode,
    reintroduced by ruling 203's fix, under a comment claiming the opposite. So every pending
    comment for that agent now goes into ONE directive. One author's consecutive messages read
    as one message — which is what the operator lease already does with a person's burst, "one
    person's three-message burst is one question, not three governed drives" — and several
    authors keep their names inline, because the directive can only tell the agent to tag one
    person back (NEW-4) and the others must at least be visible in what it is answering; the
    person who has waited longest is the one it is told to tag. **The test that found this
    passed against the broken code on its first writing**: it asserted the run's prompt
    contained both comments, and it did, because the canonical anchor quotes the last five
    timeline events — the second comment was in the SUMMARY while never reaching the DIRECTIVE.
    Padding each comment past `ANCHOR_EVENT_MAX_CHARS` with a unique tail token made the clamp
    cut it, so only the directive could carry it, and the test then failed for the real reason.
    (`task-actions.server.ts`.)

206. **Anti-noise compaction folds routine comments wherever they sit, not only where they
    happen to be adjacent (owner, 2026-09-13, pass 37; F37-26).** The guardrail was on,
    configured at 40 events, counted by Insights as managing six tasks — and had never removed
    a single event from any task in the project. `compactTimelineEvents` collapsed each run of
    CONSECUTIVE routine comments, and viberr's own event stream never produces one: a typed
    `agent`, `quality`, `github` or `transition` event lands between every pair of agent
    replies, and the operator's prompt in between is excluded as a `toAgent` governance
    hand-off. Measured live, the longest consecutive run on the six tasks past the threshold was
    **two** (and a two-run folds nothing either, since the newest reply is kept and one event
    replaced by one marker is no saving), while the foldable comments were 29% of SHOP-7's
    timeline bytes and 34% of SHOP-6's. The module's own note says agent replies were brought
    into the foldable set precisely because "an agent-heavy timeline — the flood case anti-noise
    exists for — never compacted at all"; the adjacency requirement cancelled that change on
    exactly that workload. So folding is now position-independent within the older region: every
    typed event stays in place, the newest older agent reply stays verbatim, and ONE marker
    takes the oldest folded event's slot so the file stays newest-first. Running the real
    function over the real files: SHOP-7 200→174 events and 27% fewer text bytes, SHOP-6
    134→118 and 32%, SHOP-15 23%, SHOP-9 19%, SHOP-10 9%, SHOP-1 (at the threshold, not over)
    untouched. Every pre-existing compaction test still passes — all of them place the foldable
    comments next to each other, which is why the defect was invisible for six passes. Also
    corrected: the rule's comment cited `hasReworkSinceLastRejection` as the reason to keep the
    newest reply, and no such function exists; what reads a previous reply today is
    `latestAgentReplyText`, which looks before the CURRENT run — inside the untouched recent
    window.
    (`timeline-compaction.server.ts`.)

207. **Twelve claims viberr makes that its own code refuses (owner, 2026-09-13, pass 37;
    F37-27).** F37-21 to F37-26 all came from one move — read a sentence viberr shows a human,
    then check whether the mechanism behind it can keep the promise — so it was run as a
    14-agent audit over seven claim-emitting surfaces, each candidate handed to a skeptic told
    to refute it. Twenty candidates, thirteen survived (two were one defect found twice), each
    re-verified against the code by hand. They are one ruling because they share a lesson: a
    sentence that names a mechanism is a claim about that mechanism, and the hole is usually in
    the state the sentence is most about.
    (a) **"Run recovery replays the effects on the next restart"** — written by
    `noteCompletionEffectsLost`, in the SAME update that sets `waiting: "human"`, while boot
    recovery selects `t.waiting = 'agent'`. The note's own write made its promise unreachable,
    and the effects include a required reviewer's VERDICT, so the acceptance gate stayed shut on
    a review that happened and is readable in the run log. Recovery now also matches a run
    carrying a `run.completion.effects_lost` audit row — the module's existing idiom, since it
    already keys idempotency and its crash-loop cap on audit rows rather than task state.
    (b) **"writes to it are refused"** — the Codex operator's prompt describing its scratch
    folder. Ruling 185 removed the OS sandbox; every Codex thread starts `danger-full-access`.
    The prompt promised a wall that does not exist, in the one direction that invites a model to
    test it. It now states the rule as a rule and says plainly that nothing will stop the write.
    (c) **"Supervised → ONE recommendation card; full autonomy → runs directly"** — `run_agent`'s
    description. `gate()` returns `direct` for a `direct` GRANT whatever the autonomy, and
    `direct` is `dispatch-agents`' seeded default, so a supervised operator narrated a card it
    had not filed while the agent was already writing.
    (d) **"Branch was already gone on GitHub"** — recorded for every 422 on the ref DELETE.
    GitHub answers 422 "Reference cannot be deleted" for branch protection and rulesets too,
    with the branch still there. Only an explicit "does not exist" is `already_gone` now.
    (e) **tag "@<dispatcher>" so they are notified** — the dispatcher reaches the prompt as
    `TaskActor.label`, documented as "e.g. the email", and the mention ladder matches a local
    part, a full name or a first name, never a whole address. Resolved through the display-name
    lookup that exists for this, extracted to its own module to keep specialist-run out of a
    cycle with task-actions.
    (f) **"Viberr … pushes the branch + opens the review PR when the task enters Review"** — told
    to every delivering agent. R15-2 deleted that hook on 2026-07-28; delivery is an operator
    decision. Corrected in all six places, the seeded developer profile's description included.
    (g) **"The thread stays resumable"** — on every interrupt. `reserveRun` writes a running row
    minutes before a provider process exists, which is the window a person actually presses Stop
    in, and `latestSessionRun` skips a run with no `session_id`. That case now says there is no
    thread to resume.
    (h) **"pick a <other> profile if the work cannot wait"** — after a quota hold. The hold is
    scoped to (backend, task OWNER), because every run bills the owner (ruling 127), so the
    advice only helps when the owner has that backend connected; otherwise it sends the operator
    into a refused dispatch whose failure opens the packet the same sentence forbids. Offered
    only when it exists.
    (i) **"Use Run operator on the task page"** — in the hold-for-runtime-debug resolution.
    `run-agents` is admin/maintainer, so a CONTRIBUTOR who owns the task (and may resolve the
    packet through the owner exception) never sees that control, and the `@operator` door is
    gated on the same role. The sentence now names who holds it.
    (j) **"no longer has a provider transcript … retention sweep or a wiped runtime volume"** —
    written on an OWNER CHANGE, which `resumeRun` decides before any filesystem is consulted.
    The transcript is intact, in the previous owner's home. An admin was sent hunting a storage
    fault for a condition viberr chose; the two causes now read differently.
    (k) **"Deliver the branch to push it"** on `relation: "unknown"` — whose premise ("a behind
    or absent remote reaches the PR by a plain push") `unknown` does not satisfy: it is written
    when the compare could not be READ, so the remote may be diverged. It now names the
    uncertainty instead of promising the push will land.
    (l) **"PR #N is still open on GitHub"** — asserted from `task_projections.pr_json`, a cache.
    The 5-minute reconcile poll kept it honest, and ruling 177 excludes terminal-stage tasks
    from every budgeted pass — an accepted task IS terminal, so the exact rows this nudge
    describes are the rows nothing refreshes. It now reports its own last reading and says why.
    Three of the twelve were pinned by tests that had to be UPDATED rather than written: the
    fixtures encoded the old claim as correct. A test that agrees with the defect is how a
    defect survives.
    (`run-service.server.ts`, `run-recovery.server.ts`, `operator-run.server.ts`,
    `operator-toolkit.server.ts`, `operator-actions.server.ts`, `github-reconciler.server.ts`,
    `reconcile-poller.server.ts`, `specialist-run.server.ts`, `task-actions.server.ts`,
    `task-file.schema.ts`, `user-display-name.server.ts`, `agent-catalog.server.ts`.)

208. **The reviewers who still OWE a verdict decide where a task goes back to (owner,
    2026-09-13, pass 37; F37-29).** `verdictStageFor` names the stage a task whose revision
    changed after a verdict returns to, and it asked whether ANY required reviewer is eligible
    at the current stage — "a verdict can be given here". On a board with required reviewers at
    TWO stages that answers for the wrong reviewer. Live on SHOP-15: `code-reviewer` (declared
    build+review) held no approve on the delivered revision, `integration-verifier` (declared
    review+verify) held one and is eligible at Verify — so the scan returned null,
    `reworkStages` came back empty, and `transitionStage` refused "No allowed transition from
    Verify to Review". The task could not reach the only stage where the reviewer it was
    waiting on may run: not by the operator, not by a human, because the stage control offers
    the same graph. Acceptance was blocked on a gate that was genuinely unmet, and the exits
    were archive or an admin force-accept past it — the board lying to itself to move. Below
    admin there was no exit. Every rule involved was right: ruling 179 staled the older
    approval, ruling 133 refused to run a profile outside its stages, the gate reported the
    truth. The defect was one premise inside the scan. So it now considers only the required
    reviewers whose approve on the CURRENT revision is missing: a reviewer that already
    approved cannot be the reason a re-verdict is needed, and its eligibility must not answer
    for one that has not. It survived this long because every board the codebase had been
    tested on declares its required reviewers at ONE stage, where the two questions coincide —
    the shopify-clone board is the first with two, and the controller designed it that way
    itself.
    (`verdict-stage.ts`.)

209. **A comment that carries evidence is a pointer, not prose (owner, 2026-09-13, pass 37;
    F37-30).** Found by checking ruling 206's first live firing instead of trusting it. The
    `evidence-separation` guardrail takes an agent's raw output OFF the timeline and onto disk,
    leaving a reference behind — and such a comment is agent-authored, untitled and not
    `toAgent`, so it matched every clause of compaction's foldable test. Folding it keeps a
    count and drops the pointer: the attachment stays on disk, unreferenced, and the proof
    behind a verdict becomes a file nobody can reach from the record. Ruling 206 did not create
    this (the old adjacency rule folded agent replies too) but it made it reachable on every
    long task instead of almost never. So a comment with a non-empty `evidence` list is never
    folded, beside the two exclusions that were already there — a person's prose (B-FD9) and a
    to-agent hand-off.
    (`timeline-compaction.server.ts`.)

210. **A request_changes is the complete list, not the first thing found (owner, 2026-09-13,
    pass 37).** Ruling 193 escalates a reviewer whose objection SURVIVES a rework, and ruling
    204 fixed the counter that sees it. Neither addresses the other expensive shape: a reviewer
    whose objection is answered every round and who returns a different, equally valid one next
    time. Live on this board twice — SHOP-6 took **seven** rounds and broke only when the owner
    told the reviewer to name the defect CLASS rather than instances; SHOP-10 took **five**,
    each on a different revision, each finding real issues. Every round is correct on its own
    terms, the work is better for them, and nobody had ever asked the reviewer what ELSE it
    would block on. So the reviewer's own contract now says: a `request_changes` is a COMPLETE
    list — sweep the whole owned surface for this revision, name every change you would block
    on (including ones you have not verified in detail, marked as such), and state in one
    sentence that this is the complete set and that a fix addressing all of it should pass. A
    deliberate escape hatch keeps the rule from pushing a reviewer into hiding a late finding:
    when something is genuinely new (the rework introduced it, or it was unreachable until an
    earlier blocker cleared) it says THAT, and why it could not have been named before. The
    operator's turn doctrine carries the matching arm beside ruling 193's: when the same
    reviewer returns a DIFFERENT objection each round and the earlier findings were actually
    fixed, ask which of the three it is in ONE comment and require "name everything you would
    still block on across your owned surface, now" before sending the deliverer back. Finding
    one defect, returning the work, and finding the next one next round is not review; it is a
    queue, paid for a round at a time. Cost accepted by the owner: reviews get slower per round,
    because the round count is the expensive thing.
    (`specialist-run.server.ts`, `operator-run.server.ts`.)

211. **Nine defects the adversarial self-review found in rulings 201-208 (owner, 2026-09-13,
    pass 37; F37-31).** Five lenses over the pass's own diff, each candidate handed to a
    skeptic told to refute it: 21 candidates, 13 survivors, 9 distinct, every one in code
    written the same day. They are one ruling because they share the pass's central lesson —
    a fix is a change like any other, and the fix for a lie can tell a smaller one.
    (a) **Ruling 203's window opened at the wrong instant.** The single-flight guard that
    refuses a mention keys on `state IN ('running','queued')`, which begins at the run row's
    INSERT; the redelivery scanned from `started_at`, which a run admitted behind a
    concurrency cap does not have for minutes. Every comment refused during that wait was
    filtered out, silently, under a note promising delivery. The window now opens at
    `created_at`.
    (b) **Ruling 203's hop sat after two early returns** — the `error` branch and the
    closed-task branch — so a busy run that ended in error, or a task that closed underneath
    it, dropped the person's instruction. It runs before both now, and when the delivery
    cannot start at all, the promise is WITHDRAWN on the record ("Not delivered: … the
    delivery promised when the comment was refused has not happened"), because silence there
    is the same defect one layer in.
    (c) **Boot recovery is not the live completion.** It replays a finished run's lost effects
    possibly days later, and it handed the redelivery the ORIGINAL run's window — so a comment
    a human had since had answered by its own run was re-delivered as a fresh directive,
    starting a duplicate paid run on a stale instruction. The replay path now skips it.
    (d) **Ruling 202 stamped `delivered` on ENTRY to `performDelivery`**, counting the arms
    where nothing reaches the remote (`grant_withheld`, `no_workspace`, `bootstrap_failed`) as
    operator progress. A nudged drive whose only action was an impossible delivery looked like
    it had moved, so the stranded backstop skipped its durable `heldAtStage` marker and every
    later trigger re-armed the nudge — F31-11's fourteen-drive loop, reached through the fix
    for ruling 202. The stamp moved to after the push is attempted; a refused push still
    counts, a refusal that never reached the remote does not.
    (e) **Ruling 209 was incomplete**: `attachments` is a second, separate pointer list on the
    same event, and 209 excluded only `evidence`. Both are excluded now.
    (f) **Ruling 207(f) overstated itself** — "corrected in all six places" — while a
    specialist prompt branch and a seeded skill doc still said delivery happens on the Review
    transition. (The copy-ban allowlist row that pinned the old sentence went with it.)
    (g) **Ruling 201's suppression sentence** attached a count of the WHOLE cost-silent
    population to a clause naming only delivery. When the other side is partly silent too it
    now says so, and labels the count as the total.
    (h) **Ruling 207(e) was half-done**: the prompt got the resolved display name, and the cc
    line the completion pipeline appends when the model forgets to tag still carried the raw
    email — the fallback that exists precisely because the model forgot.
    (i) **Ruling 204's JSDoc** still stated the rule 204 reversed, and argued for it.
    **A third vacuous test, also mine.** The cross-agent guard test took three versions to
    reach the guard: v1 named nobody (a different branch); v2 named a real agent but posted
    through `appendComment`, which does not set `toAgent` — the flag the scan filters on — so
    the comment was invisible before any profile comparison happened. Only v3, through
    `commentToAgent` with two busy agents, goes red when the guard is relaxed.
    (`task-actions.server.ts`, `run-recovery.server.ts`, `timeline-compaction.server.ts`,
    `specialist-run.server.ts`, `operator-actions.server.ts`, `insights-page.tsx`,
    `developer-expertise.skill.md`, `copy-ban.test.ts`.)

212. **A transport failure is a transport failure, and switching providers is not a fix for
    the path they share (owner, 2026-09-13, pass 37; F37-32).** Two live recovery packets from
    transient host network faults, wrong in two different ways.
    (a) The Codex CLI reported `failed to lookup address information: Name does not resolve`,
    and viberr answered "Codex execution failed. **Review its authentication and runtime
    configuration**", recommending "Redirect with sharper guidance" — a rewritten directive, to
    fix DNS. `LOCAL_NETWORK_FAILURE_RE` was written against Node's error codes and Node's prose;
    the Codex CLI is Rust and says it differently, so this matched nothing and fell to
    `unknown`, whose sentence is the credential one. (Its TLS sibling matched only by accident,
    through `\btls\b` inside a `close_notify` message.) The patterns now carry the CLI's own
    prose: `failed to lookup address information`, `name does not resolve`, `nodename nor
    servname`, `temporary failure in name resolution`, `peer closed connection`, `close_notify`.
    (b) The packet that DID classify the fault correctly then recommended "Retry on the other
    backend now", whose own detail says "Later runs on this task stay on {other} until another
    retry moves them". The fault is this deployment's network path — the other provider is
    reached over the same path — so switching is not a remedy, and it permanently moves the
    task off the model its profile declares (on the live board, off the owner's standing luna
    policy onto `sonnet`, in one recommended click). It stays OFFERED, because the owner may
    want it, and it is no longer RECOMMENDED when the fault was local; the option says why in
    its own words, and the same-backend retry takes the recommendation.
    (`run-failure.ts`, `run-failure-remedy.server.ts`.)

213. **A restart that lands between a run's end and its consequence leaves the board
    claiming an agent nobody can see (owner, 2026-09-13, pass 37; F37-33).** SHOP-4 sat at
    `waiting: agent` for six minutes with no live run. The container had stopped one second
    after the operator's own `Review -> Build` transition: the operator run was already
    `finished`, so every existing boot pass had a reason to skip it. `finalizeOrphanedRuns`
    looks for non-terminal runs, `recoverUnreactedAgentRuns` for a finished run with no
    reply, `recoverStrandedOperatorPlans` for a plan nobody executed - this run had replied,
    had executed, and had died only in the step AFTER all of that, the settle that flips
    `waiting` and backstops a stranded stage. All three passes are keyed on a RUN; the
    damage here is keyed on a TASK, and no pass was looking at tasks. The board's own
    sentence, "waiting on an agent", was false, with no run page to open and no button to
    press: the only way out was for a human to guess that a comment would wake the
    operator. So `reconcileRestartedWork` gains a fourth pass, `settleAbandonedWaits`, that
    asks the question the other three cannot - which live tasks claim an agent while no run
    of theirs is `running` or `queued`? Each one gets a timeline note in its own words
    ("Left waiting on an absent agent") and a fresh operator invocation, which re-reads the
    task and decides. If the operator cannot start - none deployed, a refusal, a throw - the
    task is settled to `waiting: human` instead, because a board that cannot name who it is
    waiting for must not name an agent. It runs after the three run-keyed passes, so a run
    those can still repair is repaired by its owner and never double-handled.
    (`run-recovery.server.ts`, `boot.server.ts`.)

214. **A question put to an agent in a comment is put to nobody, and the doctrine that
    asked for one paused a task five others were waiting behind (owner, 2026-09-13, pass 37;
    F37-34).** Ruling 210 gave the operator its arm for a reviewer that returns a NEW valid
    objection every round: ask it to name everything it would still block on, "in ONE
    comment", and do not rework again until you have the answer. Live on SHOP-10, at round
    six, the operator did exactly that, and wrote a good question: "@Code Reviewer, before
    another rework run, name everything you would still block on across your owned surface
    for the current revision, now." Nothing read it. `post_comment` writes a timeline line
    for the humans and starts no run; an agent only ever reads a directive that comes with
    one. Forty-five seconds later the stranded backstop - which counts a transition, a
    dispatch, a delivery or a packet as progress, and a comment as nothing - recorded a
    deliberate hold, paused coordination and settled the task to `waiting: human`, with
    SHOP-2, SHOP-3, SHOP-11, SHOP-12 and SHOP-13 all declared blocked on it. The turn's own
    text already said it, six bullets above the arm: "a directive comment on the timeline is
    not a running agent." So: ruling 210's arm now names the only action that can get the
    answer, `run_agent` on the reviewer with `delivers: false` and the question as its
    prompt, and says why a comment cannot. The `post_comment` tool and the Codex plan
    schema say the same in their own descriptions. And when an operator comment tags an
    agent anyway, the comment discloses it - "_@X is an agent, and an operator comment
    starts no run; nothing was sent to it. Run the agent to put this to it._" - which is
    S5-G3's rule one audience over: a visible non-delivery beats a silent one.
    (`operator-run.server.ts`, `operator-toolkit.server.ts`, `operator-actions.server.ts`.)

215. **Ruling 213's own deploy wrote both restart notes on the same task, and one of them
    was false (owner, 2026-09-13, pass 37; F37-35).** The deploy that shipped 213 landed on
    two tasks with live runs, and each came back carrying two system notes one second apart:
    "the run `run_JFvmbz...` (reviewer) was still running when the server stopped, it is
    recorded as interrupted by the restart" and, directly beside it, "no run was live when
    the server came back". Both cannot be true, and the second is the wrong one. Step 1 of
    the boot chain, `finalizeOrphanedRuns`, exists to move live runs to `interrupted`; it
    does that synchronously and launches its re-invokes at the END of the chain. So the
    board `settleAbandonedWaits` reads at step 4 has already had exactly the evidence it
    keys on erased by step 1, and every genuinely-orphaned task looks abandoned. The cost is
    two contradictory sentences in the canonical record and a second operator drive for one
    event. The sweep that was written to stop viberr claiming an agent that is not there
    spent its first deploy claiming a restart that did not happen. So step 1 now reports the
    tasks it took - all of them, capped ones included, since a capped task is still one this
    pass decided about - and step 4 withholds them. Its ordering is unchanged and still
    right: a pass that STARTS a run must be seen by the sweep, which is why it runs last;
    what it needed was not a different position but the one fact it could not read off the
    board.
    (`run-recovery.server.ts`, `boot.server.ts`.)
216. **A person's own operator run ends the deliberate stage hold, because that is
    what its note tells them to do (owner, 2026-09-13, pass 37; F37-36).** The stranded
    backstop's durable marker, `heldAtStage`, comes with this sentence: "Coordination is
    paused here: run the operator manually when the hold should end, adjust the goal, or
    loosen the boundary in Policy → Workflow rules." Live on SHOP-10 I did the first one.
    The operator ran, took a real action (`update_branch_from_base`, 8 commits), and the
    marker was still standing afterwards with the board still reading "Coordination is
    paused here" - so of the three remedies the sentence offers, the one it names first was
    the one that did nothing. Every other human re-litigation clears the marker already: a
    goal edit (V18), a stage transition, a packet resolution, acceptance, a dependency
    release. A press of Run operator did not, which also means the drive that person paid
    for got no nudge when it stranded, since the backstop reads the standing hold and
    returns before it. The same branch that already lifts ruling 157's packet-less hold now
    lifts this one, with the same discriminator it already computed: a `manual` trigger
    carrying an `actor` is a person and nothing else is. A SCHEDULE deliberately does not -
    an hourly schedule re-arming the nudge forever is the exact thing V18 stopped.
    (`operator-run.server.ts`, `task-actions.server.ts`.)

217. **An instance whose projection stopped tracking its own files reported itself
    healthy for twelve minutes (owner, 2026-09-13, pass 37; F37-37).** The projection store
    went to `SQLITE_CORRUPT` under a running process. Every rebuild threw
    ("database disk image is malformed"), the watcher's rebuilds threw, an operator's plan
    execution threw halfway through and took its decision with it, `clearWaitingToHuman`
    threw behind it, the task page answered 500 to the human, and a run sat `running` for
    twenty minutes with no process behind it. Throughout, `/resources/health` answered
    `{"ok": true, "status": "ok", "degraded": []}`. It was not lying about anything it
    checked: the row COUNTS still read fine, because the damage was in particular btree
    pages, and a count is not a verdict about whether the mirror still follows the record.
    Viberr knew the whole time - `rebuildPath`'s catch wrote the store's own error to the
    log on every single failure - and had nowhere to put the fact. `boot.server.ts` already
    names this exact shape for the one cause it probes for: "the task stops projecting and
    its row goes stale, with nothing on any surface saying why." So that catch now sets a
    process latch (`store-health.server.ts`) carrying the failing file, the store's own
    sentence and a count, and the next rebuild that WRITES clears it. Health reports it as
    `degraded: ["projections"]` with the reading in `projectionStore`, so readiness answers
    503 and an orchestrator can act. A latch, never a probe: no `PRAGMA integrity_check` on
    an 87MB file every few seconds, and no alarm that outlives its fault - which is the
    same thing ruling 146 refused to let this endpoint do. "Files are truth" is only worth
    anything while SQLite follows them, so a projection that cannot be rebuilt from the
    canonical files is the one fault this product must never report as healthy.
    (`store-health.server.ts`, `rebuilder.server.ts`, `health-snapshot.server.ts`,
    `resources.health.ts`.)

218. **A projection rebuild that fails is retried, and a fault belongs to the file that
    has it (owner, 2026-09-13, pass 37; F37-38).** Ninety seconds after the corrupt store of
    ruling 217 was replaced, a transient `disk I/O error` hit SHOP-4's rebuild - once, during
    `resolvePacket`, and once more a second later from the watcher. The card then read
    "waiting on you" while the file it mirrors said `waiting: agent`, and it stayed that way
    until a human pressed Re-scan. Two things were wrong, and one of them was mine.
    (a) **Nothing retries.** A projection is rebuilt when its file CHANGES; if that one
    rebuild fails, the file does not change again, so the row keeps whatever it held before,
    forever, with no surface saying to press anything. The watcher's own debounce queue now
    re-arms a failed path on a backoff (2s, 5s, 15s, 45s, 120s), resets on the first success
    and gives up after the last step - past that it is not transient, it stands in the latch,
    and health calls the instance degraded, which is a person's problem and not a timer's.
    (b) **Ruling 217's latch held one slot**, so the next file that rebuilt cleared it. That
    is how health was back to `ok` while SHOP-4's row disagreed with its own file: SHOP-16
    had projected fine in between. A fault is a fact about ONE file and is over only when
    THAT file projects again, so the latch is a map, `projectionStore` reports how many files
    are failing alongside the most recent one, and a success clears only its own path.
    (`file-watch.service.server.ts`, `store-health.server.ts`, `rebuilder.server.ts`,
    `health-snapshot.server.ts`.)

219. **A catch that writes to the thing that just failed is not a catch (owner,
    2026-09-13, pass 37; F37-39).** `rebuildPath` wraps every rebuild so one bad file cannot
    take the process down, and inside that catch it wrote a provenance row saying the rebuild
    failed - to the same store that had just failed. So in the one case the catch exists for,
    a broken store, it threw, and `rebuildPath` raised into its caller after all. Live:
    `resolvePacket` wrote SHOP-4's file (the packet resolved, `waiting: agent`), called
    `reprojectTask`, and died at that line with `disk I/O error`. The canonical write had
    already landed - the decision is on the record, correctly - but everything the resolution
    still owed, the operator re-invoke included, went with the throw. SHOP-4 read
    "agent working" with nothing running for eleven minutes, on the board of a task five
    others were waiting behind. A projection is a MIRROR: its failure is reported, never
    raised, because the action that called it has already told the truth in the file. The
    note is now attempted inside its own try, and a store too broken to take even that gets
    one warn line; the return is `{ action: "error" }` on every path.
    (`rebuilder.server.ts`.)

220. **The MCP list states where every server stands on write tools, not only the gated
    ones (owner, 2026-09-13, pass 37; F37-40).** Ruling 176 lets an admin mark a server's
    write tools, and Viberr withholds them from every run that holds no repo write and from
    every operator run. The Org settings row said so - but only when a server WAS gated.
    A server nobody had reviewed rendered nothing at all, so the one state worth seeing was
    the state the list was silent about. Live on this instance: `kb-architecture` and
    `kb-conventions` are stock `server-filesystem` rooted at a knowledge base, 14 tools each,
    granted to three agent templates each, and unmarked - which means those agents can
    rewrite the knowledge bases Viberr injects into every other agent's prompt as trusted
    configuration. The controller reasoned about exactly that hazard for a THIRD such server
    and granted it to nobody; for the two it had already created and granted, the list gave
    it, and the admin, no standing signal. Ruling 188 gave the controller's own read all
    three cases ("Not reviewed yet: nothing is withheld. Viberr makes no claim about the
    tools nobody has marked."); this is the human's half of that sentence. The row now says
    which of the three it is: gated and how many; reviewed with nothing withheld; or N tools
    that look like writes with nothing withheld and nobody having reviewed them. A server
    whose discovered tools contain nothing write-shaped stays quiet, because there is no
    position to state and a row that alarms on everything is a row nobody reads.
    (`resource-rows.tsx`.)

221. **A provider store that cannot be OPENED is a session problem, not a credential one
    (owner, 2026-09-13, pass 37; F37-41).** Ruling 212 taught viberr the Codex CLI's words for
    a network fault. This is the same lesson for the CLI's own disk. After the host corrupted
    a SQLite file under load, the CLI reported `failed to open thread history database ... (code:
    26) file is not a database`. That matched nothing, fell through to `unknown`, and
    `unknown`'s sentence is the credential one - so viberr told the owner to "review its
    authentication and runtime configuration" and RECOMMENDED "Redirect with sharper guidance",
    a rewritten directive, for a corrupt file on its own disk. The credential was fine and no
    prompt could have helped: the file's first page was not a SQLite header at all. What made
    it costly is that fresh runs kept working while every RESUME failed - which is precisely
    the shape `session_missing` already names, and whose remedy, one fresh run re-anchored on
    task.md, is already the right one. So an unreadable store classifies as `session_missing`,
    and the two roads into that class are told apart where it matters to a person: a vanished
    session heals itself on the next run, while a store that cannot be opened keeps failing
    every resume until the file is repaired or removed, and the sentence says so. One shared
    marker constant carries the distinction from the adapter to the remedy layer, so neither
    side re-parses the provider's prose. The pattern is anchored on the STORE's own nouns, not
    on "not a database" alone: an agent building a SQLite-backed service can print that
    sentence out of its own work, and a run is not a session failure because the code it was
    writing hit a bad file.
    (`session-export.server.ts`, `codex-runtime.server.ts`, `run-failure-remedy.server.ts`.)

222. **A question an agent asks reaches the person under that agent's name (owner,
    2026-09-13, pass 37; F37-42).** `notifyTaskWatchers` stamps `OPERATOR_NOTIFY_FROM` on any
    notice that names nobody, and the agent-question path named nobody - so an agent's own
    question arrived in the owner's inbox under the Operator's name and avatar, on the one
    surface whose chip IS "who wants something from you", and whose row renders the packet
    BODY rather than the title that did name the role. Live on SHOP-18 the Frontend Engineer
    asked the owner to publish a catalog facet contract or cut the scope, and the inbox said
    "Operator: SHOP-18 cannot satisfy its required filter/facet sidebar…" - the agent's words
    over another actor's name. The principle was already settled one file over and two calls
    up, for the audit row of the same event: "P11-23: the agent opened this question packet -
    attribute it to the agent." The notification now carries the same actor. The DEFAULT is
    left alone deliberately: it is right for the many notices the operator really does author,
    and narrowing it further is a change to make when a surface is caught getting it wrong,
    not on a hunch.
    (`agent-toolkit.server.ts`.)

223. **The never-pushed guard could not fire, because GitHub answers an unknown commit with
    422 and viberr only knew 404 (owner, 2026-09-13, pass 37; F37-43).** Ruling 135 gave the
    acceptance gate a containment check: if the delivered revision is not on GitHub, the
    compare 404s, one direct commit read confirms it, and the acceptance is REFUSED because
    "it cannot be accepted until the PR carries the reviewed revision." The confirming read
    asked `isMissingRefAnswer`, which knows 404 and the empty-repository 409.
    `GET /repos/{repo}/commits/{sha}` does not 404 a well-formed 40-character SHA it cannot
    find: it answers **422** with `No commit found for SHA: <sha>`. So the probe never
    confirmed anything, the refusal was unreachable on the real API, and a never-pushed
    revision degraded to an `unverifiable` head - which acceptance deliberately lets through
    with a disclosure. Live on SHOP-17 that cost exactly what the gate exists to prevent:
    both required reviewers approved `1f99f68`, that revision was never pushed, and the
    acceptance merged PR #12 whose head was `9104562` - **the revision the Code Reviewer had
    rejected** - then deleted the branch. `1f99f68` exists nowhere on the remote. The
    completion note said only that the head "could not be verified". Ruling 135's own test
    hid it: the fixture stubbed the commit read as a **404 carrying GitHub's 422 sentence**, a
    combination the endpoint never returns, so the canary passed against a fact that was
    wrong. A commit read now has its own predicate, `isMissingCommitAnswer`, which accepts
    404, the empty-repository 409, and a 422 whose message names a missing commit; it is kept
    SEPARATE from `isMissingRefAnswer` because 422 is GitHub's generic validation status and
    widening the shared predicate would make unrelated failures everywhere read as "the ref is
    gone". The real answer is pinned as its own test, not as a fixture's guess.
    (`github-client.server.ts`, `task-actions.server.ts`.)

224. **A spent usage window the provider dated has a remedy that is neither a model change
    nor a false assertion (owner, 2026-09-13, pass 37; F37-44).** At 23:28 the Codex window
    went, and six tasks stalled at once behind the same packet. The provider named its own
    reopening - "try again at Sep 14th, 2026 2:27 AM" - and viberr parsed it, stored it, and
    printed it. Every option it then offered was wrong at the moment it was offered. The
    RECOMMENDED one, "Retry on Claude now", says in its own detail that it moves the task
    permanently off the model its profile declares ("Later runs on this task stay on Claude")
    - on a deployment whose owner had set every specialist to one model on purpose. The
    alternative asks a human to assert "The window has reset", three hours before it would.
    The remaining two freeze coordination or re-prompt an agent that cannot run. And the
    packet cannot simply be left open, because an open packet refuses the operator: the only
    exits were a policy change, a false statement, or being awake at 02:27.
    Viberr already had the machinery for the true answer - a schedule runner that fires an
    unattended run at an instant. So a quota refusal whose reset instant is KNOWN and still
    in the future offers `wait_for_window`, and that option takes the recommendation: the
    packet closes, the board settles to `waiting: human` (no agent is coming for hours, and
    claiming one is F37-33's lie by another road), and a `run-operator` schedule is written
    for one minute past the provider's instant. The OPERATOR, never a blind re-dispatch of
    the same agent: hours pass, the board may have moved, and every other timed resume viberr
    has - the dependency release, the restart recoveries - re-invokes the operator for that
    reason. A schedule that cannot be written says so on the timeline and names the manual
    fallback, and never un-resolves the decision the human made. The OPERATOR's own quota
    packet is a second builder with the same defect and gets the same arm: its recommended
    option asked a human to assert the window had reset, which is the one statement on that
    packet that is false at the moment it is offered. And the instant is read from the QUOTA
    STORE, not only from the run's own failure facts: `RunFailureFacts.resetsAt` is set from a
    machine `rate_limit_event` the provider sends DURING a run, and a Codex refusal at spawn
    time sends none - so on exactly the failure that stalls a board the facts are silent while
    the store holds the date parsed out of the provider's own sentence. Without that read the
    whole ruling is inert on the case it was written for, which the first deploy proved live.
    Finally, the kind joins NO_REQUEUE: the decision IS that nothing runs, so re-invoking the
    operator on resolution spends a run against the very quota the human chose to wait out,
    gets refused, and opens a NEW packet asking the same question - answering the decision
    re-created it. Live on SHOP-18, seven seconds after the decision was recorded.

225. **A task resting on a clock stops claiming it rests on a person (owner, 2026-09-14,
    pass 37; F37-45).** `waiting: human` in a task file means "no agent is working, a human
    is next" - it is simply what `clearWaitingToHuman` writes when the last run ends. Every
    waiting-sensitive surface renders that as the sentence "waiting on a human", which was
    true while a person was the only way forward. Ruling 224 made it false. Four tasks
    resolved their quota packet by scheduling their own resumption for 02:28 UTC, and the
    board then showed "waiting on a human" on all four cards under a header counting "5
    waiting on a human in this project" - while the packet that put them there had promised,
    in viberr's own words, "Nothing runs until then and the board says so." It did not. So
    the projection derives a fourth value, `schedule`, exactly as LV-20 derives the terminal
    `none` and as `validation: bypassed` is derived: nothing authors it, the canonical file
    keeps saying `human`, and one derivation moves every reader at once - the card, the
    board subtitle and its filters, the review row and its subline, the task page's
    "Waiting on" rail, and the controller's own board summary, which now counts clock rests
    apart from human ones and carries the instant on the task line so it neither treats the
    rest as work to unblock nor re-dispatches a task that is already coming back.
    The predicate is about the STATE, not its cause - a quota-only reading would be a second
    lie the day anything else writes a schedule - and its limit is the load-bearing half: a
    human-actionable decision OUTRANKS the clock. An open packet, a live recommendation, or
    a completion a human could accept right now all keep `human`, because the schedule takes
    none of that off anybody's hands, and because `decisionsRequiring` reads this very
    column: getting it backwards would not soften a lie, it would HIDE a decision. The
    "no activity" cue follows the same care. A clock rest is not measured from its last
    timeline event - the gap is hours by design, so the agent threshold would fire the cue
    on the healthiest wait there is - but neither is it exempt, because a schedule that came
    DUE and did not fire is a genuine stall in the runner. The idle clock restarts at the due
    instant: silent until then, quiet on the human threshold after. Finally the store's own
    CHECK constraint was widened to admit the value. It refused it at first, which is worth
    recording: the refusal arrives as "projection rebuild failed" and a stale row, the exact
    silent-staleness failure `boot.server.ts` probes this column for and ruling 217 built the
    health latch for. The canary caught it before the deploy did.
    Amended the same day, from re-reading the predicate rather than from a failing test: it must
    also require `waiting: "human"` exactly, and an EMPTY `blockedBy`. A task that waits on other
    work is held (ruling 131(d)) and the schedule runner refuses its occurrence on precisely
    those grounds - "waits on other work (...) - no operator run was started; Viberr releases the
    task when every entry is done" - so a card reading "resumes Sep 14 · 02:28" over it would be
    this ruling's own lie, reintroduced by this ruling. And `waiting: "none"` renders no wait tag
    at all, so it claims nothing and has nothing to correct; deriving over it would invent a
    promise where the board had made none. Forty-one green tests covered neither case, which is
    the point: a predicate is not verified by the tests that happen to pass.
    Amended twice more, from the same question asked properly the second time: **what states does
    the schedule runner refuse?** It refuses a held task, an archived one, and a closed one, each
    with its own outcome (`skipped-held`, `skipped-archived`, `skipped-done`). A card that names
    a resume time for an occurrence the runner will refuse is a promise nothing intends to keep,
    so the derivation excludes every one of them: the terminal case via LV-20's `none` above,
    and `blockedBy` and `archived` by name. R14-3 archiving removes a task from every view except
    the Archived filter, and that filter still draws the card, so "a consumer filters it out"
    does not hold here. The general rule this ruling ended up standing for: a derived promise is
    bounded by what the mechanism behind it will actually do, and the way to find its edges is to
    read that mechanism's refusals rather than to imagine the cases.
    Amended a third time, and this one was caught on the LIVE BOARD rather than by reading.
    `acceptanceRefusal === null` is not "a human could accept this": the STAGE gate is the one
    acceptance refusal `acceptanceBlockReason` deliberately omits, because it turns on the
    project's workflow graph rather than on anything in the task file. So a task at an early
    stage with nothing delivered reports no refusal - not because it is acceptable, but because
    the only thing refusing it was never consulted. SHOP-21 sat at Build with no revision and no
    PR, a `run-operator` schedule pending for 07:29, and its card and its rail both still read
    "waiting on a human" after this ruling shipped, while the board's own "Waiting on me" tally
    read zero. The predicate now asks `isAtAcceptanceBoundary` as well - the same question
    `TaskSummary.atAcceptanceBoundary` answers for the board, from the same workflow graph, now
    selected into the projector's project row for the purpose.

226. **A head GitHub will not compare is refused, not disclosed (owner, 2026-09-14, pass 37;
    F37-43).** Ruling 135 built the guard for a PR head that is not the reviewed revision and
    ruling 223 made it reachable against GitHub's real 422. What survived was A9's trade: a head
    that could not be VERIFIED still merged, with a note naming the check that did not run. Live
    that merged SHOP-17 at `9104562` - the revision its Code Reviewer had REJECTED - while both
    reviewers' approvals pointed at `1f99f68`, which was never pushed, and the completion note
    said only that the head "could not be verified."
    A9's reasoning was that "the merge's own honesty covers unreachability", and for an
    unreachable GitHub that is true: the merge fails too. It is false in exactly one case, and
    that case is the dangerous one - GitHub ANSWERS the pull request and refuses only the
    comparison. Then the repository is reachable, the merge will succeed, and the only thing
    missing is the knowledge of what is being merged. That case now REFUSES, and the sentence
    names the consequence rather than the procedure: "code no reviewer approved could reach the
    base branch." Every other unverifiable head still passes with A9's disclosure, which is the
    case A9 described.
    A refusal with no exit is its own defect, and this one could strand a task permanently,
    since no amount of re-delivering makes GitHub answer. So the gate does not only throw a
    sentence at the browser: it records the question on the task, with both shas in it, and the
    three real answers - try the check again (recommended, because a refused comparison is
    usually a bad minute), send it back to be re-delivered, or take the merge deliberately. That
    third option is NOT force-accept and must not borrow its door: force-accept bypasses the
    VERDICT gate and has never been able to touch this one. It waives ONE containment check, for
    ONE (PR, delivered revision, live head) triple, re-read live at the moment of the decision,
    with the deciding person's name on it. Pinned, because the whole danger it admits is that
    the head is unknown: a waiver that outlived the head it was granted for would be a standing
    permission to merge whatever that branch later carried. The operator cannot offer the option
    at all - it would be waiving a check over facts it never read - and when the re-read
    succeeds the resolution grants nothing and says so, because a waiver written on a check that
    would now pass is a permission nobody needed.
    Two canaries paid for themselves before the deploy. The first: the waiver had no line in the
    frontmatter key order, so it never reached disk, and the gate that re-reads it would have
    refused forever - an override button that did nothing. The second: A9's own test described
    "GitHub unreachable" while its fixture answered the pull and failed the compare, which is
    this ruling's case, not A9's. The fixture, not the ruling, was what made the old behaviour
    look intended.
    Amended the same day by re-reading the packet I had just written: it offers TWO options, not
    three. A "try the check again" option would have to be a `custom`, and a `custom` resolution
    sends the task back to the agent side and re-queues the operator - which re-runs this very
    gate, refuses again, and opens this very packet again. Answering the decision would re-create
    it, which is ruling 224's fourth half repeating on a different packet. A re-check needs no
    option at all: this packet does not set `readiness: blocked`, so it never refuses the
    acceptance, and pressing Accept again IS the re-check - which the body now says, and which a
    successful acceptance finishes by withdrawing the packet on its own. The remaining two
    options both do exactly what they say.

227. **A refusal a person is waiting on is written on the task, not only in the log (owner,
    2026-09-14, pass 37; F37-46).** Ruling 141 taught the operator's refusals to speak when a
    trigger met them at the front of the LEASE QUEUE, on the reasoning that "the refusal used to
    exist only in the server log while the timeline still said 'Scheduled action starting'". The
    same three refusals AT THE DOOR stayed silent, and the door is where a person's instruction
    arrives. Live on SHOP-2: someone wrote "@operator PR #13 conflicts with main, rebase and
    re-review", the comment landed on the timeline with the mention rendered as routed, the
    composer's own footer promised "@mentions route to agents", `runOperator` refused it at the
    door because a decision packet was open, and nothing on any surface said so. The instruction
    read as accepted and nobody was coming.
    So a `manual` trigger refused at the door gets ruling 141's note, with the sentence about
    how it arrived corrected (it never reached a queue) and the consequence stated plainly:
    "no run was started, so nothing on this task has been acted on." The blocked-by silence —
    a drained transition on a held task IS the ruling-131 hold, already on the record — does not
    apply to a person, who is owed an answer to the thing they just typed.
    Exactly one trigger, and the other two are the interesting part. `scheduled` is NOT added,
    though ruling 141's reasoning covers it: the schedule runner already notes and retires its
    own fire-time refusals, so this would have written the same note twice, and its tests are
    what caught the duplicate. And the machine triggers (`create`, `transition`, `delivered`,
    `agent-reply`) stay silent because they fire constantly and refuse routinely — noting each
    would bury the one that means something, which is R16-2's failure applied to a timeline.

228. **A plan refused in full is a drive that was STOPPED, not one that decided to wait (owner,
    2026-09-14, pass 37; F37-47).** The settle-time stranded backstop (F31-11, ruling 152(a),
    ruling 202) asks whether the stage's outbound boundary is `auto`. That is the right question
    for a drive that CHOSE to do nothing and the wrong one for a drive that chose actions and was
    not allowed to take any of them. SHOP-3 sat at Verify - boundary `human`, so invisible to the
    backstop - after a plan whose only step, an `update_branch_from_base`, was refused by the
    capability policy. The refusal even named the remedy ("Do not refresh it here; recommend or
    accept the completion instead") and no operator ever read it, because the turn had already
    ended. 25 minutes parked, on the very run the Codex window had just been waited three hours
    for.
    So a drive whose plan was refused IN FULL is stranded whatever the boundary, and takes the
    same single nudge. Its turn instruction is its own, because the idle-stage sentence would be
    false twice over here - the stage need not be auto-advance and the run did not end idle by
    choice: it says every action was refused, that the refusals are on the timeline with their
    remedies in them, and that re-planning the same refused action is forbidden. Everything else
    is F31-11's machinery unchanged: one nudge, and a nudged drive that is refused in full again
    records the durable `heldAtStage` hold and settles to a human instead of looping.
    "In full" is exact and load-bearing: `refused` holds one entry per step that did not run, so
    equality with the plan length IS "nothing happened". A step that THREW breaks the loop and
    leaves the counts unequal, which is correct - an abort is narrated on its own terms. An empty
    or unparseable plan never reaches this at all; viberr already opens a packet for that
    ("Operator turn produced no actionable plan"), and the gap was only ever the plan that named
    real work and was refused every bit of it.

229. **The one call viberr tells the operator to make speculatively stops being reported as a
    failure (owner, 2026-09-14, pass 37; F37-49).** `update_branch_from_base`'s own tool
    description says: "It is idempotent and cheap: an already-current branch changes nothing and
    says so, **so call it when you are unsure rather than guessing**", and of `baseBehindBy`:
    "`null` means nothing has compared them yet, **which is not a reason to skip it**." The
    operator complies. The already-current answer then came back as `outcome: "noop"`, which the
    plan executor files under REFUSED, which `narrateRefusedActions` headlines "**The operator's
    plan was not carried out in full.**" On the pass-37 board that note stood 57 times and **51
    of them were this one line** - the product asking for a call and then recording it as an
    incomplete plan.
    The duplication is the sharper half. Ruling 134(c) already writes the same sentence as a
    `github` event, and deliberately SUPPRESSES it when the newest such event says the same
    thing, on the reasoning that "the tool is idempotent by contract, so the record is too". The
    refusal narration then re-added that identical sentence with no suppression and a worse
    headline. So `already_current` returns `done`: it is this tool's success condition, not a
    state conflict. The Claude operator reads `[done] … is already up to date`, the plan executor
    files nothing, and the `github` event remains the one record - which is what 134(c) intended
    before the second writer undid it.
    What this leaves behind is the point of the note in the first place: the six refusals on that
    board that a human should actually read are no longer the twelfth of it. A record that
    reports encouraged, designed behaviour as a failure teaches people to skim it, which is
    R16-2's rule about filters applied to a timeline.

230. **"Hold this until those land" becomes an option that performs it (owner, 2026-09-14, pass
    37; F37-50).** Ruling 131 built the whole dependency mechanism - the board renders `blockedBy`,
    the schedule runner refuses a held occurrence, the dependency release re-triggers the operator
    when the last entry finishes - and none of it was reachable from a decision packet. So an
    operator that wanted a hold reached for the nearest-sounding kind, `block_on_policy`, whose
    resolution is R20-1's "I fixed the credential, carry on": it sets `readiness: ready`,
    `waiting: agent` and re-queues. Live on SHOP-11 at 04:12, an option titled "**Hold** SHOP-11
    while gateway routing, tracing and stack-test work lands" produced the record "SHOP-11 is
    **unblocked** and the operator re-runs to re-check", and the frontmatter agreed. The option
    promised a hold and performed an unblock, and none of the fifteen kinds could have done
    otherwise, because not one of them writes a dependency.
    `block_on_dependencies` takes a `blockedBy` payload and writes it through `setTaskDependencies`
    - the same door the operator's own tool and the task page use, so the canonicalisation, the
    goal-link mirror and the "Dependencies updated" note are the ones every other caller gets
    (ruling 164: an option performs the real action through the real door). It joins `NO_REQUEUE`
    for ruling 224's reason: the decision IS that nothing runs, and re-invoking the operator would
    pay a drive to rediscover the hold it was just told about, which is JC-9's five runs and the
    same thing ruling 131(d) refuses at the door.
    Two refusals at authoring time, by name like every other payload-bearing kind: a
    `block_on_dependencies` naming nothing to wait on is refused (it would resolve into a hold
    that releases on nothing), and a `blockedBy` on any other kind is refused. And the write is
    best-effort with its failure narrated rather than thrown: `setTaskDependencies` validates the
    refs, so a hold on a task that does not exist is correctly refused, and when that happens the
    human's decision must still stand while the record says plainly that nothing releases this
    task and where to set it by hand. That path was found by the canary hitting it first.

231. **A react chain follows the deployed operator, not the one it started on (owner, 2026-09-14,
    pass 37; F37-51).** The reply/react re-invocation carried three things forward: the chain
    depth, the autonomy, and the BACKEND of the drive that prompted the agent - and it passed that
    backend as an OVERRIDE, which beats the live deployment inside
    `resolveOperatorAuthority`. R22 removed exactly that pin from schedules, in exactly these
    words: "A schedule fires unattended, so following the profile that is actually deployed then
    matters MORE than freezing whatever was configured hours earlier." A react is the same shape
    for the same reason - the agent it reacts to may have been running for an hour.
    Measured live. The owner changed the operator from Codex to `opus[1m]` at 04:19:56 UTC; a
    react chain started a CODEX operator run at 04:31:44 against a deployment that read `claude`,
    twelve minutes after the policy changed and with only one operator deployment on the project.
    A model policy that takes effect only once every in-flight chain drains is not the policy the
    owner set.
    Depth still travels, because it is the loop bound and nothing else can carry it. Autonomy
    still travels, because the resolver clamps it to the deployment's configured ceiling (R19-A),
    so a chain cannot hold an autonomy the project has since lowered. Only the backend is dropped,
    and dropping it is safe because the operator re-anchors on `task.md` rather than on a provider
    transcript: a chain whose backend changes between turns loses nothing it was relying on.
    The canary for this passed while the bug was restored, the first time it was written - the
    override lives on `input.operatorRun`, and the test had set it on `ctx`. It was only a test
    of the fix once it could fail without it.
    (`run-failure-remedy.server.ts`, `task-actions.server.ts`, `operator-actions.server.ts`,
    `task-file.schema.ts`.)

232. **A comment whose DECLARED audience is the agent notifies no person (owner, 2026-09-14,
    pass 37; F37-53).** P14-GV-06 added the mention fan-out to `operatorPromptAgent` because a
    human tagged inside an operator directive ("...coordinate with @Arda on the copy") was never
    notified - the tag was decoration. Pass 37 measured what those tags actually are on a live
    instance: of 49 mention notifications sent to the owner, 19 came from directives where the
    handle was the operator SPECIFYING a deliverable to a specialist - "Ensure the document ends
    with an explicit @Arda question naming Stripe, Adyen, and Mock-only" - re-issued verbatim on
    every rework round, and SHOP-7 reworked twelve times. Viberr cannot tell "coordinate with
    @Arda" from "write an @Arda question" by parsing, so the owner ruled on the audience instead:
    a directive handed to an agent is addressed to that agent, and a person named inside it is
    being described TO the agent, not addressed.
    DECLARED, not inferred, and the distinction is load-bearing. `appendComment` DERIVES its
    `toAgent` from the presence of an agent handle, so a blanket rule would silently drop the
    human half of "@dev implement the endpoint, @Bora look at the schema first" - and a human has
    one comment box, not a second human-directed channel to fall back on. The gate is therefore
    for writers that set the audience themselves; today that is `operatorPromptAgent` alone.
    The rule lives at the fan-out seam (`audience: "agent"` on `NotifyMentionsInput`), not at the
    call site, so a future declared-agent writer inherits it. The handles that reached nobody are
    still reported, because they are facts about the text that the author's disclosure is written
    from, and the directive comment itself still lands on the timeline tagged to-agent: the ruling
    changes who hears about the hand-off, not whether it is on the record.
    The OPERATOR had to be told, or the ruling is a trap rather than a rule. Its persona closed
    with "When you answer or address a specific person, tag them by name with an @mention. The
    mention is what notifies them" - no qualification, and now false for the comment the operator
    writes most. An operator that believes a tag in a directive reaches a person keeps putting
    questions there, and they reach nobody. The owner's words for this decision were that the
    operator "already has a separate human-directed comment path and should use it", so the
    persona now says which path is which: the @mention notifies in a COMMENT, and "a directive you
    hand a specialist reaches only that specialist: naming a person inside one notifies nobody, so
    put anything a person must see in a comment of its own."
    The shipped asset changed, and the live store refreshed ITSELF on the next boot
    (`a48b34db` to `b5f35eef`, matching the shipped bytes exactly) through the
    `PRIOR_SHIPPED_HASHES` / `shipped-assets.json` path, which is what that machinery is for and
    is the first time this pass exercised it. No instance file was edited by hand.
    **Amendment, found by reviewing this ruling against what it did not touch.** The dispatch site
    also wraps the directive in `withAmbiguityDisclosure`, which appends "@x matches more than one
    person here, so nobody was notified - mention the full name" or, for a non-member, "add them to
    the project first". Both notes name a REMEDY, and under this ruling neither can work: the
    comment notifies nobody however the handle is spelled and whoever is a member, so the note
    sends a reader to fix something that was not the reason. S5-G3 added the disclosure to tell the
    humans reading the timeline that a tag reached nobody; that is now true of EVERY tag in a
    directive, which makes a per-ambiguity note both noise and misleading. It is therefore skipped
    on a declared-agent comment. The tag itself still stands in the posted text: the ruling changes
    who hears about the hand-off, not what the operator wrote.
    (`mention-notify.server.ts`, `task-actions.server.ts`, `operator.definition.md`,
    `operator-run.server.ts`, `default-assets.server.ts`.)

233. **A mention notification quotes the mention, not the opening of the comment (pass 37;
    F37-53).** The inbox row reads `mentioned you - "<first 240 characters>"`, and the head is the
    right window only when the handle is near the top. It often is not: an operator directive
    opens by naming the AGENT it is dispatching and reaches the person hundreds of characters
    later, and an agent's report reaches them later still. Measured over every mention
    notification this instance had sent the owner, 19 of 49 (39%) quoted a window that EXCLUDED
    the handle they were sent for - the handles sat at characters 274, 316, 414 and 935. The
    header said "mentioned you" above a sentence addressed to somebody else, and the only
    reliable way to find out what was said to you was to open the task and search it for your own
    name, which is the work the notification exists to save.
    The quote is now windowed on the first span that resolved to THIS recipient, which is why
    `resolveMentionTargets` returns the handle-to-user map it always computed and threw away. The
    head window is kept whenever it already covers the mention, so the common case is unchanged
    byte for byte; only a mention past the cap moves the window, and it then carries a leading
    ellipsis. One recipient's quote is theirs alone - two people tagged in different paragraphs
    of the same comment each see their own.
    (`mention-notify.server.ts`, `mention-spans.ts`.)

234. **The in-app audit browse reaches the class it exists for (pass 37; F37-52).** The panel
    shipped as ONE `ORDER BY occurred_at DESC LIMIT 150` with the "Org-scoped" toggle filtering
    those rows client-side, so the toggle could only narrow a window it did not control. Two
    facts then composed badly. `github.reconcile.task` is written UNCONDITIONALLY, once per
    delivered task per poller tick - deliberately and correctly, per F19-22: it is the honest
    answer to "when did we last look" and must exist whether or not the pass changed anything.
    Seven delivered tasks on a five-minute tick is 2,016 rows a day that arrive while nobody
    touches the instance. A heartbeat that must be unconditional, read through a window that is a
    fixed row count: the heartbeat wins, and it wins harder the longer the instance lives.
    Measured live on a board that had not moved in two and a half hours: 91 of the 150 rows (61%)
    were that one action, the window spanned 53 minutes, and clicking "Org-scoped" left TWO rows,
    both `projection.rescan`. Not one sign-in, not one PAT change, not one user-administration
    event - while 96 such events sat on file, including the instance's only `github.pat.created`,
    the most security-relevant row in the table. The feature's own module doc says it exists
    because "nothing let an admin READ org/instance-scoped events inside the app"; it still did
    not.
    So the heartbeat is excluded from the BROWSE and nowhere else - the table, the retention
    sweep, the export and `latestTaskReconcileCheckAt` all still see every row, so F19-22's
    guarantee is intact - and the org-scoped list is its own SQL query. The loader fetches both
    windows so the toggle stays instant and the text filter keeps working over whichever one is
    showing. Excluding a row from an audit browse is a deliberate act, so the hidden actions are
    listed by name and never pattern-matched.
    (`audit-browse.server.ts`, `org.settings.tsx`, `org-settings-page.tsx`.)

235. **A refused acceptance is recorded, and the delivery is handed to the operator (pass 37;
    F37-55).** SHOP-2 reached the acceptance boundary with both required reviewers approving
    revision `ea5f2ffd7493` and the operator recommending "Accept completion and move SHOP-2 to
    Done. The review is clean." Pressing Accept refused, correctly: PR #13's head was `913ce9d`,
    and the reviewed revision had never been pushed. The Integration Verifier had said so inside
    its own approval - it reviewed `ea5f2ffd7493` "with `913ce9d` as its ancestor".
    The refusal went to one browser's toast and nowhere else. No audit row, no timeline event,
    the string "not on GitHub" absent from `task.md`. Two things followed. The RECORD did not
    contain the most consequential human action on the task, which is files-are-truth failing at
    the one place it is least affordable. And the OPERATOR could not learn it: it re-anchors on
    `task.md` every turn, so when the human pressed "Run operator" to get the branch pushed, it
    ran, saw nothing about any refusal, and filed the SAME acceptance recommendation again. It
    holds `deliver-review-pr: direct` and could have pushed in that turn. Accept, refuse, run
    operator, be re-recommended the same accept - and the refusal's own remedy ("Deliver the
    branch to push it") names an action ruling 134 reserves for the operator, so the human cannot
    perform it and no button offers it.
    The mechanism was one missing field. Every refusal funnels through `refuseUnverifiedHead`,
    whose recorder is guarded on `check.liveHeadSha` - and the KNOWN-mismatch branch of
    `evaluateAcceptancePrHead` returned `{refusal, verification}` and no `liveHeadSha`, so the
    guard skipped and nothing was written. The refusal sentence quotes both SHAs; the value was
    in hand and simply not carried.
    Ruling 226 had already fixed this shape one branch away, for the case where GitHub answers the
    pull and refuses the compare: it writes a packet BEFORE it throws, because a refusal that
    leaves no record strands the task. The certain case gets the same durability and a different
    instrument. Not a packet: a known mismatch is not a decision, the reviewed revision must be
    pushed, and only the operator may push it - so there is nothing to ask. It gets a `github`
    timeline event, a `task.acceptance.head_unpushed` audit row (on the Activity feed beside
    `task.acceptance.forced`, for the same reason), and a `head-unpushed` operator hand-off whose
    turn instruction names the delivery and says explicitly NOT to file another acceptance
    recommendation. Idempotent by note text, like `noteDeadDependency`: a button pressed five
    times is one record and one hand-off, never five paid runs. The human keeps the toast.
    (`task-actions.server.ts`, `operator-run.server.ts`, `activity-feed.server.ts`.)

236. **The review queue names which other pull requests a merge will conflict (owner,
    2026-09-14, pass 37).** Accepting SHOP-2 put FOUR of the six open pull requests into
    `CONFLICTING` inside one minute, every one of them on the same two shared files
    (`pnpm-lock.yaml`, `scripts/stack.test.mjs`), and the review queue listed all six as
    independent rows throughout. A person discovered each collision by pressing Accept and
    reading a refusal. The pass carries 71 `github.branch_update.operator` events and 12
    acceptance-time refreshes; the operator does reason about merge order, but in prose on
    individual task timelines, and it reversed its own ordering once.
    Viberr reconciles each pull request's mergeability already and did NOT know what any of them
    changed: `changed_files` was stored as a COUNT. So the queue could see that a PR conflicts,
    only ever after the fact, and never that two PRs are about to.
    `pr.paths` now records the changed paths, pinned to the head they were read at. The pin is
    what makes it nearly free: a file list cannot change without the head moving, so the fetch is
    skipped on every tick where it has not, which on a quiet board is all of them. A failed read
    leaves the key ABSENT, the same "not read this pass" convention as `checks`, `review` and
    `mergeable`, so a GitHub hiccup keeps the cached list instead of erasing every collision chip
    on the board. Capped at `PR_PATHS_MAX` with `truncated` carried through to the surface,
    because a clipped list can only MISS a collision and never invent one: the count shown is a
    floor, and the tooltip says so rather than printing a number that quietly means "at least".
    The intersection is computed server-side over the rows the queue already loaded, and it is
    SYMMETRIC - both rows name each other, or only whoever merged second would ever be warned.
    The chip names the tasks rather than counting them ("collides with SHOP-3, SHOP-11"), because
    a count says there is a problem and nothing about which merge to do first, which is the
    question the queue exists to answer.
    Read-only by the owner's choice: it orders nothing, blocks nothing, and starts nothing. The
    alternatives on the table were a merge lease that serializes acceptances and a decision to
    treat the collisions as the clone's problem; the owner took the one that adds information and
    leaves every decision with the person.
    (`task-file.schema.ts`, `pr-linker.server.ts`, `github-reconciler.server.ts`,
    `review-queue.server.ts`, `review-helpers.ts`, `review-page.tsx`.)

237. **A reviewer that objects twice running is a decision for a person, and Viberr raises
    it itself (owner, 2026-09-14, pass 37; F37-57).** SHOP-5 took three `request_changes`
    verdicts from one reviewer on three revisions, each naming something real the last
    round had not. Every mechanism built for exactly this worked: ruling 204's counter read
    3, and ruling 210's doctrine sat in the operator's turn instruction ending "Do not send
    the deliverer back into another round until the reviewer has answered." The operator
    moved Review to Build 46 seconds after the third verdict and re-dispatched the
    deliverer 16 seconds later, with no question put to the reviewer on any round. SHOP-6
    took seven rounds, SHOP-10 five. It is the construction ruling 186 refused: a request
    in a prompt, with nothing that notices when the model does something else.
    The owner's choice was to ESCALATE rather than gate, and the reasoning is that a fresh
    class of finding on round three is sometimes exactly right, so a gate would refuse
    correct behaviour to stop the incorrect kind. The operator keeps every move it had.
    What changed is that the second consecutive objection from one reviewer now opens a
    decision packet by itself, written inside the verdict's own locked write so the two can
    never land apart. The pause that follows is the one every packet has carried since
    ruling 76, not a new constraint.
    Threshold two, per reviewer, on the owner's call - which is what `consecutiveRequestChanges`
    already computed, since it filters to one `profileId`: another reviewer's objections never
    count toward this one and never keep it alive, and the counter resets on that reviewer's own
    approve.
    Written by the POLICY ENGINE, not through `operatorOpenPacket`, for ruling 226's reason:
    that door checks the OPERATOR's `generate-packets` grant, and this packet is not the
    operator's judgement. A project that told its operator to stop opening packets said nothing
    about whether a person should hear that their reviewer has blocked the same work twice.
    Three options, and each does what it says. `question_reviewer` is the 17th packet kind:
    it carries the reviewer's `profileId` and its resolution STARTS that reviewer with the
    standing question ruling 210 wrote, asking for a comment and forbidding a fresh verdict
    (a verdict here would bind to the same revision and count as another objection, which is
    the loop). Authoring refuses one that names no reviewer or names a non-reviewer, because
    otherwise the card could promise "ask X" and dispatch the deliverer. The other two are
    "let the rework continue" (a `custom`, whose resolution hands the task back unchanged) and
    `force_accept`. Replacing the reviewer is named in the body as prose and is deliberately
    NOT an option: the resolution cannot edit project settings, and ruling 164 already
    established that an option whose title promises what its resolution does not do is worse
    than no option.
    The completion that RAISES the packet does not then hand the task to the operator, and
    that clause is load-bearing. Ruling 195 records that "a packet opened mid-work does NOT
    stop the machine triggers", and the react at the end of an agent completion is one
    (`agent-reply`, deliberately outside `PACKET_REFUSED_TRIGGERS`). Live on SHOP-24 the
    first firing proved it: the `task.review.deadlock` audit row landed at 13:52:53.488Z and
    an operator run started at 13:52:53.585Z, 97 milliseconds later, while the card told a
    person the task was theirs. That turn happened to be benign — it posted evidence for the
    human — but nothing constrained it, and the move it is free to make is the re-dispatch
    this packet exists to interrupt. The other machine triggers keep ruling 195's carve-out;
    a packet is not a lock, and the card's copy now states what HAPPENED ("Nothing was
    dispatched on this objection: the task is on you") instead of promising a future the
    mechanism does not guarantee.
    Writing the packet directly rather than through `operatorOpenPacket` means carrying that
    door's guards too, and an adversarial pass over this ruling's own code found one missing:
    ruling 177 refuses a packet on a CLOSED task, and a reviewer run that finishes after its
    task was accepted or archived still records its verdict (ruling 177's own arm says so —
    evidence is evidence, and no coordination follows). The escalation now checks closure in
    the same locked read. The OTHER guard, ruling 137's acceptance-offer withdrawal, is
    deliberately absent: a `request_changes` always derives `validation: "failing"`, and the
    verdict block's own filter already drops every `accept_completion` card, so calling the
    withdrawal would withdraw nothing and write a second line into the decision log for one
    disappearance. A test pins that coupling, because it is a coupling and not an obvious
    property.
    (`review-deadlock.server.ts`, `task-actions.server.ts`, `operator-actions.server.ts`,
    `task-file.schema.ts`, `operator-toolkit.server.ts`, `operator-run.server.ts`,
    `activity-feed.server.ts`.)

238. **A re-review follows a base refresh, because the defect it blocked on may be in the
    base (owner, 2026-09-14, pass 37; F37-58).** Three correct mechanisms composed into a
    task no rework could unblock. A verdict binds to a work revision. A base refresh mints
    no new revision and `describeRevisionDrift` reports it as not unreviewed, which is
    right: on SHOP-18 the deliverable's own tree sha was identical across the refresh, and
    I checked that with `git rev-parse` before overriding anything. And
    `pinSupportCheckout` detached every re-review at the reviewed revision, so it re-read
    the base it had already objected to.
    The Integration Verifier's two blockers were defects on `main`, outside SHOP-18's owned
    paths. They were routed to SHOP-21, fixed, and merged into the branch by Viberr's own
    `update_branch` (`1 merge commit, 20 base commits, 0 authored`). The verifier objected
    to the same revision a second time, its report asking for a re-run on the merged head,
    and the operator opened a packet saying plainly that no tool of its own could make that
    happen. It was right. The task escaped by an admin force-accept over a gate that wedged
    because a task did exactly what it was asked to do.
    `reviewSubjectSha` now decides what a re-review reads, and the subject moves to the PR
    head when the drift is base-refresh ONLY. One authored commit anywhere in the drift
    keeps the pin: that is unreviewed work, and reading it unasked is the failure ruling 179
    exists to prevent. The drift must also have been measured AT the head being offered, or
    it classifies none of the commits on it.
    The disclosure changes with the subject. A reviewer standing on a different commit from
    the one its verdict binds to is told so in the same sentence, naming both shas and the
    refresh between them, because a reviewer told only "the revision under review" while
    standing elsewhere would report against a tree it never read. The verdict still binds to
    the reviewed revision: the revision is the DELIVERABLE's identity, which the refresh did
    not change, and that is the same fact ruling 132 already asserts.
    The owner's alternatives were an option on ruling 237's packet and minting a revision for
    every base refresh. The second was rejected as the most disruptive: it would stale
    passing approvals too, so a refresh on a task that was ready to accept would cost a full
    re-review round.
    (`revision-drift.ts`, `specialist-run.server.ts`, `operator-toolkit.server.ts`.)

239. **A project names ONE knowledge base as its rulings, and every run it makes reads it
    (owner, 2026-09-14, pass 37).** A knowledge base is granted per profile, which makes it
    a thing you attach to eight profiles and forget on the ninth, and the ninth is the one
    that needed it. Live, the conventions KB carried a section headed "For reviewers"
    stating that a missing lockfile importer "is a KNOWN systemic condition on this
    repository with a stated rule above, not a novel defect to be re-derived from first
    principles on each task", and recording its own past cost: four reviewers each
    re-deriving it, four rework rounds. SHOP-24's Code Reviewer then blocked on exactly that
    rule twice, which raised ruling 237's packet and cost a human a goal amendment.
    That reviewer HAD the KB. Checked twice, because the obvious hypothesis was that it did
    not: the grants were right, its run mounted both knowledge bases, and `kb-conventions`
    was healthy. What was missing is a channel that cannot be got wrong.
    So `project.md` carries `rulingsKb`, and `withProjectRulings` puts it into every KB list
    the project builds: each specialist (after its own grants and R18-1's inherited ones, so
    it never displaces them in the shared injection budget), the operator, and the
    controller while its conversation is scoped to that project. Appended and deduped, so a
    profile that also grants it explicitly is not charged twice against one budget, which is
    the expected shape when an existing KB is promoted into the role. A project that names
    none behaves exactly as before.
    The owner's framing, which this implements verbatim: "per project kb with rulings …
    this kb must be used by every agent in the project, when the controller session also
    using a project it should read the project kb as well. If we already have a kb for this
    we can transform it to this."
    The controller sets it with `set_project_rulings_kb` under the same `edit-policy`
    authority as every other project policy, and a directory no knowledge base occupies is
    refused by name with nothing written: a rulings KB that resolved to nothing would inject
    silently-empty context into every run and read, on every surface, as though the project
    had settled rules it has not. The Agents page says so under each profile's knowledge
    bases, because a card that lists a profile's grants while the runtime injects one more
    is wrong about what that profile reads, which is the pass-27 capability-matrix defect in
    another costume.
    (`project-file.schema.ts`, `project-rulings.server.ts`, `settings-actions.server.ts`,
    `controller-toolkit.server.ts`, `specialist-run.server.ts`, `operator-actions.server.ts`,
    `controller-run.server.ts`, `project.agents.tsx`, `agents-page.tsx`.)

240. **A held task refuses DELIVERY, not just dispatch (owner, 2026-09-14, pass 37; F37-61).**
    Ruling 186 made the hold a gate at the dispatch chokepoint and its comment says "Every
    dispatch door lands here, so every one of them refuses". The operator's turn instruction
    then told it, on every held task, that "`run_agent` and `deliver_for_review` are REFUSED
    by the server while the task is held". Only the first was. `performDelivery` had no
    `blockedBy` check anywhere in it, for a pass and a half, while the prompt asserted one.
    That is ruling 186's own defect inverted: there a prompt ASKED where a gate was needed,
    here a prompt CLAIMED a gate nobody built.
    It matters because of the live case ruling 186 was written on. SHOP-2 was marked "Held
    until every entry is done" and a run "pushed a branch cut from a base that predated the
    foundation it waited on" — and publishing that branch to a review pull request is
    `deliver_for_review`, not `run_agent`. The gated door was not the one the harm went
    through.
    The gate now sits at the top of `performDelivery`, before the branch bootstrap, the push
    and the PR open, and refuses with `holdRefusal`'s own sentence so a person meets one
    wording wherever a hold stops them. The refusal is written to the timeline, not only
    returned.
    The owner's alternatives were to leave it as doctrine with honest copy, and to gate it
    with a packet-based override for the case where a task's own work is finished while it
    waits on something unrelated. The owner took the plain gate: the same shape as ruling
    186, and a task that genuinely should deliver can have its `blockedBy` corrected with
    `set_dependencies`, which is the door ruling 131 already provides.
    (`task-actions.server.ts`, `operator-run.server.ts`.)

241. **A decision a hold refuses is QUEUED, not consumed for nothing (owner, 2026-09-14,
    pass 37; F37-68).** Ruling 237's escalation recommends asking the reviewer to name
    everything it would still block on. Ruling 186 refuses every agent dispatch on a held
    task. Ruling 237 added a dispatch door and checked neither, so live on SHOP-5 a person
    chose the recommended option, the decision was written onto the task contract, the
    packet was cleared, and only THEN did the refusal surface: nothing was asked, the
    packet was gone, and the contract said "no rework until the reviewer has answered"
    about a reviewer nobody would ever ask.
    `force_accept`'s own arm had already written the rule this broke: "Both refusals the
    force path can still make are run HERE, before the resolution write: that write clears
    the packet, and a refusal discovered after it would leave the decision recorded with no
    acceptance behind it."
    The owner's alternatives were to let a question through the hold (it forbids reviewing
    and forbids a verdict, so it builds nothing on a stale base), and to refuse up front on
    the card. The owner took QUEUE: the hold stays absolute and the person's intent
    survives it. The question rides the task as `queuedQuestions` — the profile, the
    directive TEXT (a person was promised those words, and the wait can outlive the
    constant) and who decided — and `announceRelease`, the single release chokepoint, puts
    it BEFORE it re-invokes the operator. That ordering is ruling 203's: an operator
    re-invoked first could dispatch the very rework the decision exists to stop, in the
    window between the release and the question.
    The list is emptied before any run starts, whatever the run then does: a question left
    queued through a failed start would be asked again on the next release, and a reviewer
    asked the same question twice is the loop ruling 237 breaks. A failed start says so on
    the timeline instead.
    Said BEFORE the choice, not discovered after it: the packet is built with the task's
    `blockedBy` in the same locked write that raises it, and the option reads "X waits on Y,
    and Viberr refuses every agent run while it does, so the question is held with the task
    and put the moment the wait clears." The wait panel names it too, because a promise a
    person made and cannot see is the same defect in another place.
    (`task-file.schema.ts`, `review-deadlock.server.ts`, `task-actions.server.ts`,
    `dependencies.server.ts`, `task-side-panels.tsx`.)

242. **A review ROUND is counted by the deliverer having run, not by the reviewer having
    spoken (owner, 2026-09-14, pass 37; F37-69). Amends ruling 204.** Ruling 204 made a
    reviewer's repeat objection on the SAME revision count as a fresh round, because a real
    deadlock mints no new revision: live on SHOP-9 the deliverer ran, reported it had
    nothing in scope it was allowed to change, committed nothing, and the old
    distinct-revision count sat at 1 while the loop ran. That reasoning is right and stands.
    What it could not distinguish is a repeat objection with NO rework behind it at all —
    and ruling 237's own escalation question provokes exactly that. Its directive says "Do
    NOT review again and do NOT return a verdict: nothing has changed since your last one",
    and its rationale says why: "a verdict here would bind to the same revision and count as
    another objection, which is the loop". That enforcement was a sentence in a prompt with
    nothing that notices when the model does otherwise — the construction ruling 186 refused,
    which ruling 237's own comment cites as the reason ruling 237 exists.
    Live on SHOP-25 the Code Reviewer answered the question exactly as asked (a complete,
    bounded list, with the out-of-scope items separated) and attached a `request_changes` to
    the same untouched revision 8 milliseconds later. That took `rounds` on
    `rev_HzViP4JzPI5d` to 2 and the deadlock count from 2 to 3, so the person who had just
    paid for the answer was handed a fresh "requested changes 3 times running" card, and
    every later round would read one too high.
    A DELIVERER RUN is the signal that separates the two. `rounds` now increments only when
    the task's delivering profile has a run row created since the reviewer's previous verdict
    (`profileRanSince`). SHOP-9 still counts: the deliverer ran. A question run counts for
    nothing: nobody reworked. Any run row does, whatever its state, because a rework
    dispatched that crashed is still a round fought; and a task with no deliverer engaged
    counts as before, since there is nothing to read.
    The owner's alternatives were a task-level record of which reviewer owes an answer, and
    leaving the verdict alone while stopping the packet re-raising. The owner took the
    counter, which needs no new state and survives what neither would: the run that verdicted
    on SHOP-25 was not the packet's own dispatch — that one was interrupted by a server
    restart — but an operator re-dispatch by comment, so any mark on the run would have died
    with it.
    NOT fixed by this, deliberately and recorded: a `request_changes` arriving while the
    count already stands at two still raises a fresh packet. The count it names is now true.
    (`run-store.server.ts`, `task-actions.server.ts`.)

243. **A pending goal link can ADOPT a task that already exists (2026-09-15, pass 37;
    F37-72).** A chain makes its link's task when it advances, and nothing could point a
    link at work created ahead of it. `create_task` takes no link, `edit_link` takes title,
    goal and `blockedBy`, and the server's own op list had no binding op either — so a
    person who asked the controller to build out the work for three pending links got three
    real tasks the chain did not know about, and the chain would have created its own
    duplicates on the next advance.
    The only escape was `remove_pending_link`, which destroys the link's authored text. Live
    those three links carried the orders service's port, its whole `orders` /
    `order_lines` / `addresses` / `order_saga_steps` / `outbox` schema, a SIGKILL
    crash-resumption assertion, the cart/checkout token-scoping rules and a diff assertion
    naming an exact line count — and every line had to be hand-copied into the new tasks
    before the links could go. Copying a specification between two records because nothing
    binds them is the absurd thing this removes.
    `adopt_task` binds an existing task to a PENDING link: the link takes the task, goes
    `active`, and the task gains the `goalRef` back-reference, written AFTER the link
    commits because a task claiming a link that does not claim it back is the worse
    half-state. Ruling 155 runs the other way here than on an advance — the task already
    exists and OWNS its wait, so the link mirrors the task's `blockedBy` rather than
    overwriting it.
    Refused: a link that already has a task, an archived task, and a task another chain
    already carries (named, because a task belongs to one chain and its own `goalRef` can
    name only one).
    (`goal-actions.server.ts`, `controller-toolkit.server.ts`.)

244. **A packet option whose premise is false is refused where it is WRITTEN (2026-09-15, pass 37;
    F37-73). Extends the `accept_completion` authoring rule to its sibling.** The
    `accept_completion` arm already refuses an option the acceptance gate would reject, for a
    stated reason: "the human is left confirming a card that cannot succeed."
    `resolve_remote_collision` had no such check. It clears a FOREIGN remote — ruling 122's
    case, an unrelated branch or an unowned PR squatting the task's branch name — and V19 put
    `unownedPr` into the operator's own snapshot precisely so it can tell one exists. With no
    collision recorded, ruling 136(b)'s `own_pr_open` arm answers "No collision to clear: PR
    #N on `branch` is TASK's own review PR" and leaves the block where it was.
    Live on SHOP-11: a rebase diverged the branch from its own PR #15, the operator offered
    this as the RECOMMENDED option, promising in its own description to close PR #15, delete
    the remote branch and re-deliver. A person confirmed it through the destructive-action
    ceremony that names deleting a branch and closing a pull request — and the answer was
    "The block stays." The decision was spent, the packet was gone, the consent had been given
    for a cost never paid, and nothing had happened.
    The server behaved honestly at every step; the defect was upstream, in accepting an option
    whose premise the authoring context already disproves. `operatorOpenPacket` now refuses it
    when `github.unownedPr` is null, names what the branch actually carries, and points at the
    kinds that fit: `custom` naming what a person must do to the history, or `archive_task`
    with `deleteBranch`.
    (`operator-actions.server.ts`.)

245. **Per-file LEASES: which task owns a shared path until it merges (owner, 2026-09-15,
    pass 37; F37-74).** The project's conventions encode at least four rules that all need
    to name a file's current owner — only the branch at the head of the merge queue
    regenerates the lockfile freely, an authorized shared-file edit names its order, the
    approved branch merges first, SERIALISE's "the authorization names the merge order".
    Viberr had nowhere to put that fact. `blockedBy` was the only ordering primitive and it
    means "do not START until done", which is far too strong: the statement actually wanted
    is "both may proceed, this one owns `pnpm-lock.yaml` until it lands". So it lived in
    prose inside task texts, and every agent re-derived it every run.
    The absence cost two decision packets in one evening. SHOP-19 merged the Makefile
    fragment layout while SHOP-5 still carried the pre-refactor monolith — entirely
    predictable, nobody holding it. And SHOP-11 was made to WAIT on two tasks when sequence
    was meant, drifting twelve commits behind, conflicting, refusing a push, and spending a
    human decision that could not take effect.
    The owner's alternatives were an ordered merge queue and doing nothing. The owner took
    LEASES, which answer the sharper question: not "who is next" but "who owns this file
    right now", and that one is checkable at delivery.
    A lease is some path globs, the one task holding them, and why. Two wildcards only —
    `*` within a segment, `**` across them and covering the directory itself — because a
    surprising match on a shared file is worse than a missing feature. Read in three places
    and enforced in one: `get_project` carries them, every run's canonical anchor names what
    the run may NOT touch (high in the block, because a run that learns this after editing
    has already done the thing the lease exists to stop), and the PUSH refuses — ruling 144's
    own seam, the moment the change would become published history and the last at which
    refusing is free. An unmeasurable diff refuses nothing and says so, keeping ruling 144's
    distinction that `null` is "history could not answer", never "nothing changed".
    Refused at authoring: a lease naming a task the project does not have (a refusal nobody
    could act on), and two leases over one glob (list order would decide the owner, which is
    the one question a lease answers).
    (`file-leases.ts`, `project-file.schema.ts`, `settings-actions.server.ts`,
    `push-workspace.server.ts`, `task-actions.server.ts`, `controller-toolkit.server.ts`.)

246. **A refusal names the real limit, and says whether the door it points at is open
    (2026-09-15, pass 37; F37-75).** Found by asking the controller to ATTEMPT four things it
    cannot do and report the refusals verbatim, rather than reason about them from its tool
    list.
    `readStoreDoc` judged TYPE before EXISTENCE, so a path the store had never held was
    refused for its file extension. The controller asked for `make/stack.mk` — a file in the
    git repository, which that reader has no view of — and was told Viberr "only opens text
    documents". It dutifully retried the same path as `.md` and was told the file "no longer
    exists", which claims it once did. Two refusals, two causes that were not the reason, and
    the real limit stated by neither. Existence is judged first now, and the miss says what
    the reader IS: the org knowledge-base and skill store, not a git repository, with GitHub
    and an agent on a task with a checkout named as the ways to read a repo file. The
    editor's own type guard is unchanged for a file that IS there.
    `move_task` into the terminal stage pointed at the task page and stopped, so a person
    sent there on a task still waiting for a reviewer followed a correct pointer to a control
    that would refuse them. It now carries `acceptanceRefusalFor`'s own sentence when one
    stands — the same gate the task page shows — so the reply names the door AND says whether
    it is open.
    Recorded and deliberately NOT fixed: a tool that does not exist emits no refusal at all,
    so asking the controller to resolve a packet or force-accept produces silence rather than
    a pointer. The controller proposed refusing stubs. Leaving it: a stub is a tool that
    exists to deny, and the honest answer to "can you do X" is the model saying no, which it
    did. Revisit if a controller is ever seen improvising around the silence.
    (`store-files.server.ts`, `controller-ops-mcp.server.ts`, `controller-toolkit.server.ts`.)

247. **Ruling 245(b): a lease whose HOLDER is finished holds nothing (2026-09-15, pass 37;
    F37-76).** Ruling 245 shipped with `FileLease.taskKey` documented as "released when it
    reaches a terminal stage" and NOTHING implementing it. The controller read that contract,
    believed it, and wrote it into the first real lease's own reason — "Lease releases when
    SHOP-11 merges". SHOP-11 then merged, and the lease stood: `pnpm-lock.yaml` owned by a
    completed task, refusing SHOP-5's delivery in the name of work that had already landed,
    with two records promising the opposite. A comment claiming a mechanism nobody built is
    the defect this pass has found more often than any other, and ruling 245's own finding
    note had called a stale lease "its own stale-record problem" in the same breath.
    Resolved at READ time (`activeFileLeases`), not swept on completion, for ruling 131(e)'s
    reason: a sweep is a hook some completion path eventually misses, while a resolution
    converges however the holder finished — accepted, force-accepted, archived, or edited on
    disk. A holder that no longer EXISTS is spent too: it can neither deliver the file nor
    release the lease, so binding on it would fence the path off forever in the name of a task
    nobody can open. Every gate reads through the resolver: the push, and the canonical
    anchor that tells a run what it may not touch.
    The stored row stays until someone clears it, which is honest — the declaration was made
    and is now spent — and `staleFileLeases` names exactly those so a surface can offer to
    tidy them rather than leaving a person to notice.
    (`file-leases.server.ts`, `push-workspace.server.ts`, `specialist-run.server.ts`.)

248. **A run that could not read the work judges nothing (2026-09-15, pass 37; F37-77).**
    Live on SHOP-5 the Code Reviewer's checkout failed to provision. Viberr told it so in
    the prompt, in viberr's own words, and ordered it to quote them verbatim: *"The workspace
    has NO checkout, and this is a server-side FAILURE, not something you can fix."* It did
    exactly that, returned an envelope with `verdict: null` and wrote "No content verdict
    recorded" in its summary. Viberr recorded `request_changes` against the revision, because
    the prose fallback matched the word "failure" inside the sentence viberr itself composed.
    Delete that one word and the classifier returns null; it was the entire verdict. The
    fabricated objection was the second in a row from that reviewer, so ruling 237's counter
    raised a review-deadlock packet asking a person to choose between interrogating a reviewer
    that never judged, forcing acceptance past a verdict that did not exist, and another round
    of rework. The operator read the reviewer's own report, said so on the task, and could not
    withdraw a packet the policy engine had raised.
    Two gates, because the incident had two causes. A run whose workspace could not be
    provisioned records NO verdict at all, envelope or prose: the fact is stamped on the run
    row (`no_checkout`) rather than kept in the completion closure, for `outcome_key`'s reason
    — the closure dies with the process, and a recovered run would be re-classified. And the
    prose fallback is a fallback for SILENCE, not an override of an answer: an agent that
    filled the envelope, left the verdict empty and asked a QUESTION has said which of the two
    it was doing. The no-verdict note already read a question as "a legitimate no-verdict
    outcome" (pass 24, C-4); the classifier is its sibling and never learned it, which is this
    pass's most-found shape. The note itself now names the real condition, because "re-run the
    review" is bad advice for something a re-run reproduces.
    (`task-actions.server.ts`, `specialist-run.server.ts`, `run-store.server.ts`,
    `sqlite.server.ts`, `0001_baseline.sql`.)

249. **A checkout failure names the cause it knows, not one it guessed (2026-09-15, pass 37;
    F37-78).** `cloneFailureSentence` had two credential states, and the specialist checkout
    has three cases. A SUPPORTING run is cloned from the delivering checkout ALREADY ON DISK,
    and the project token is fetched only in the arm after it — so a failure in the local arm
    reported `hadCredential: false`, and viberr announced *"No GitHub credential is attached
    to this project, so the clone ran anonymously"* about a project holding a working one
    (`pat_esbY7-6IenWI`, health `connected`). The operator believed it and wrote "anonymous
    clone, no GitHub credential attached to this project" onto SHOP-5.
    That sentence exists, in its own doc comment, "to stop the failure being re-narrated
    downstream as something it was not… by asking for a credential that already exists". It
    did the exact thing it was written to prevent. The third state, `not_involved`, says the
    true thing: this step never reached GitHub, so no credential was involved either way —
    and the prompt's "do not ask for credentials" clause now fires for it too, because that
    guess is a false lead in both directions.
    (`git-clone-auth.server.ts`, `specialist-run.server.ts`, `operator-run.server.ts`.)

250. **A live controller turn says what it is doing (2026-09-15, pass 37; F37-79).** A turn
    measured on this board ran 201 seconds over 11 turns for $4.11, and the conversation
    showed `Controller is working...` and nothing else for all of it. The same page rendered
    `Working` and `mcp__viberr_controller__get_task · {"taskKey":"SHOP-31","events":2}` in the
    live-run panel below. The fact was already computed, already on the run row and already
    streaming to that page; it simply never reached the place the person was waiting. The dock
    is worse: it follows a person onto every page and carries no run panel, so there the step
    had nowhere to appear at all. `ConversationTurnState` carries `phase` and `step`, and both
    surfaces render them on the row that says it is working. `phase` is null while it is the
    generic "Working", because the sentence beside it already says that, and one line only:
    the step is a hint the adapter refreshes several times a minute, and a wrapping tool
    payload would shove the conversation around under the reader.
    (`controller-run.server.ts`, `turn-step.tsx`, `controller-page.tsx`, `controller-dock.tsx`.)

251. **The human-decision boundary stays, and stops being a dead end (2026-09-15, pass 37;
    F37-80; the owner's call).** Ruling 88 keeps merge, acceptance, force-accept, packet
    resolution and the terminal move off the controller's tool surface. That line is right and
    it was unnavigable. Live, a person told the controller "I want to lean on you to finish
    this clone rather than clicking through task pages myself" and got, twice: "Resolving it is
    yours on the task page - I have no tool for packet resolution", and "I tried to withdraw
    it; it was raised by the policy engine, so only you can close it." Both true, neither
    actionable. Nothing let the controller even SEE what was waiting: `get_task` shows one
    task's packet, and only to someone who already suspected that task.
    Asked whether to let the controller answer packets, the owner said no, and said to make it
    navigable instead: a model between a person and the product's one explicit request to them
    defeats the point of asking. So `list_decisions` reads the whole inbox - open packets with
    every option spelled out and numbered, pending recommendations, completions ready to
    accept - and hands over `answerAt`, the link that opens the control. It decides nothing,
    and `list_` is the only verb it is allowed.
    It reads through `decisionsRequiring`, the same source the home page's "N decisions waiting
    on you" counts, so the controller and the page can never answer this question differently -
    which is the entire reason to read rather than re-derive. Org-admin reach is reported
    separately and never folded into the count: reach is not a personal inbox, and telling
    someone it is would be false. The open-packet refusal on `run_agent_on_task` now names the
    tool and the page, because a refusal that names no way out is the defect this pass keeps
    finding.
    (`controller-toolkit.server.ts`, `decisions.server.ts`.)

252. **A comment that tags an agent says so, whoever wrote it (2026-09-15, pass 37; F37-81).**
    Ruling 214 gave the operator this sentence after it put a completeness question to
    "@Code Reviewer" in a comment, no reviewer ever read it, and the stranded backstop then
    paused a task five others were waiting behind. The reasoning was never operator-specific:
    a comment writes a timeline line and starts nothing, whoever writes it. It was applied to
    one writer.
    The CONTROLLER had the same hazard, none of the disclosure, and the worst blast radius,
    because it is the surface a person drives a board from. Live on SHOP-26 it wrote
    "@operator @platform-architect The funded amendment now exists as a task", then "Two
    standing facts for the implementation run when this task is released", and closed with
    nothing but "Posted by the controller for Arda". Its own tool text promised "@mentions
    notify people" - true of people, silent for agents. And the asymmetry is sharp: the SAME
    words typed by that person on the task page DO reach the agent, because `commentToAgent`
    resolves the mention and starts a run. Typed by the controller on their behalf they reach
    nobody. A mid-run agent tagging another agent had it too, at the same seam.
    The disclosure now lives beside the resolver and both writers call it, so the wording
    cannot drift; `postAgentComment` stamps it, which covers the controller and every agent at
    once. `@operator` stays excluded exactly as in ruling 214: several writes in a controller
    turn wake the operator on their own, so claiming nothing was sent to it could be the false
    half of an honest sentence. The controller's tool text now says plainly that an agent
    mention reaches nobody and names `run_agent_on_task`.
    (`agent-reply.server.ts`, `agent-toolkit.server.ts`, `operator-actions.server.ts`,
    `controller-toolkit.server.ts`.)

253. **A knowledge base that arrived HALF says so, on the same channel as one that arrived
    not at all (2026-09-15, pass 37; F37-82).** Measured on the live board: the controller
    wrote three standing corrections into the project's rulings knowledge base, and the very
    next operator run received the document clipped MID-SENTENCE — "Every workflow run on
    every open pull request fails in about thr" — losing the other two rules entirely. The
    marker said "this doc was clipped" and named nothing, and because the KB had delivered
    SOME text it returned no `unresolved` row at all, so the run-input disclosure a human
    reads (P19-G11) reported every grant as arrived.
    Two halves of one rule, applied to one case each. `unresolved` existed so "the run's own
    prompt names what it did not get", and it fired only from the delivered-NOTHING branch;
    the marker counted docs and never named them, and chose ONE sentence, so a run that got
    half a rule and lost two more docs was told about the two and never that the rule it did
    read stops mid-sentence. Both now name the documents, both halves are said together, and
    a partial delivery returns the same structured row a total miss does.
    The exposure is structural rather than accidental: ruling 239 appends the project's
    rulings KB LAST so it never displaces a profile's own grants, which makes it the first
    thing starved on exactly the agents that hold the most grants — the operator among them.
    The budget stays where it is; what changes is that nobody has to guess what fell out of
    it. "Attached resources that did NOT reach this run" became "did NOT FULLY reach", because
    a heading that is true of every row is worth more than a heading that was true when only
    total misses could appear under it.
    (`kb-injection.server.ts`, `specialist-run.server.ts`, `operator-run.server.ts`.)

254. **A packet option that names a model says WHEN that was true (2026-09-15, pass 37;
    F37-83).** F36-8 put the model into the `retry_other_backend` option because the old text
    said only "re-run the same agent there and continue", the retry ran on `sonnet`, and
    nothing on the task named it. The sentence is composed when the option is AUTHORED and
    frozen into the packet, and a packet can sit open for hours.
    Live: four of these packets were open on SHOP-5, SHOP-13, SHOP-27 and SHOP-32 because
    Codex refused every run on a spent usage window. The owner then moved all eight specialist
    deployments from `gpt-5.6-luna` to `opus`, and each packet went on offering "re-run the
    same agent there on `sonnet` (Claude's default: the profile's `gpt-5.6-luna` is a Codex
    model)" — two claims, both false by then — to the person choosing between the options. The
    controller caught it while briefing, said it could not verify the resolution rule from
    where it sat, and asked for the first run's record to be checked. The record says `claude`
    and `opus` on all four: the behaviour was right and only the promise was wrong.
    The option pins a BACKEND, never a model, so the sentence now names today's model as
    today's ("on `opus` as deployed right now") and states the rule that survives any edit:
    if the deployment changes before you answer, the run follows the deployment. Re-deriving
    it at render time was the alternative and was rejected — `mapPacket` is a pure mapping with
    no project read, and plumbing one in to restate a fact the run already resolves correctly
    buys less than a sentence that is true whenever it is read.
    (`run-failure-remedy.server.ts`.)

255. **One creation is one instant (2026-09-15, pass 37; F37-84).** A task created with a
    `blockedBy` list writes two timeline events: the wait note, stamped with the frontmatter's
    own `now`, and the ownership `assign`, which read the clock again. In a newest-first file
    the note is unshifted above the assign, so when the second clock read landed a millisecond
    later the file claimed an order its own stamps contradicted. Measured on SHOP-27: note at
    `19:27:52.529Z` above assign at `19:27:52.530Z`. Small, and viberr ships a diagnostic that
    scans every timeline for exactly this and duly reported the board as carrying an inversion,
    so the cost is a person investigating an instrument that is working.
    Every event one write puts on a timeline now carries that write's instant. Equal stamps are
    the honest relation between two events of one act, and they leave the file's order as the
    deliberate arrangement rather than a race between two `new Date()` calls.
    The first version of the canary PASSED with the defect restored, because both clock reads
    landed in the same millisecond on a fast machine — a test that could only fail on a slow
    one. `CreateTaskInput.now` is a test seam for that reason, in the shape the reset-label
    clock already uses.
    (`task-actions.server.ts`.)

256. **The controller reads what the gates read, and an anchor belongs to the project it was
    anchored in (2026-09-15, pass 37; F37-85, F37-86).** Two defects in tools this pass shipped
    the same day, both found by an adversarial audit of the controller and both the shape the
    pass keeps confirming.
    (a) Ruling 247 made a lease whose holder has finished bind nobody, and wired that into the
    push and the canonical anchor — not into `get_project`, the read the CONTROLLER uses, which
    kept handing back `fm.fileLeases` raw while its own description promised "which task owns
    which shared paths **until it merges**". The controller said the consequence out loud
    before anyone looked for it: *"I cannot tell you from a direct read whether SHOP-11's lease
    had already self-released when it merged. I should have read `fileLeases` first."* It had;
    the read was lying. `get_project` now resolves them, and names the spent rows separately so
    they can be cleared rather than silently dropped.
    (b) `list_decisions` took the conversation's anchored task and applied it to whatever
    project it was asked about. Anchored to a task in one project and asked about another, it
    filtered that other project's decisions by a key it does not contain and answered "Nothing
    is waiting on a person here" — a false all-clear from the one tool whose entire job is to
    say what is waiting, and a worse failure than the silence ruling 251 was written to end.
    The anchor now applies only when the project asked about IS the project it was anchored in.
    (`controller-toolkit.server.ts`.)

257. **The controller writes on a person's behalf, and nothing may delete what a person wrote
    (2026-09-15, pass 37; F37-87, F37-88).** Two ways the product destroyed the owner's own
    words, found by an adversarial audit of the controller and both verified against the live
    board.
    (a) Timeline compaction folds any comment whose actor is not `human`. Ruling 99(b)
    deliberately made a controller write a DIFFERENT actor kind — the person is the authority,
    the controller is the instrument — and every other seam honours that: the audit row reads
    "arda@viberr.dev · via controller", the comment is signed "Posted by the controller for
    Arda", `auditActorDisplay` renders "Arda (via the controller)". Compaction was the one place
    that read `kind` as a proxy for AUTHORSHIP, so the instrument disclosure turned a person's
    publication into machine noise. Measured before the fix: **19 controller comments in the
    audit log, 8 left in the files.** Eleven of the owner's own comments gone from canonical
    `task.md`, from `task_events`, and from the audit payload — including the two on SHOP-5 that
    explained a `pnpm-lock.yaml` lease the board was still enforcing. And the line that replaced
    them reads "human comments are never compacted", so a reader who noticed the gap would not
    look. A controller comment is now never folded, and the marker's promise is true of
    everything it covers.
    (b) `save_knowledge_base`'s `doc` passed `overwrite: true` unconditionally, so
    `writeStoreDoc`'s own collision guard could never fire and its `replaced` flag was thrown
    away: the reply read "Document conventions.md written" whether it created a file or
    destroyed one. The HUMAN door for the same write refuses the collision unless a replace
    confirmation says otherwise, and its toast says "replaced" or "saved" from that same flag
    (P14-UI-59, which exists because this exact bug was fixed on the UI). It is also the ONLY
    way into an existing KB, since a no-id create is refused once the folder has a metadata row
    — so the project's rulings KB, injected into every run on the project, was one call away
    from erasure by a model writing the obvious filename, which the tool's own example gives as
    `conventions.md`. A collision is now refused without `replace: true`, the reply says which
    happened and how many bytes a replace destroyed, `list_knowledge_bases` names the documents
    rather than counting them, and `read_knowledge_base_doc` lets a write carry the text forward
    instead of guessing at it. A tool that can only destroy blind is not a tool a model should
    be handed.
    (`timeline-compaction.server.ts`, `controller-toolkit.server.ts`.)

258. **A chain that stopped because the work is FINISHED did not get stuck (2026-09-15, pass 37;
    F37-89).** The operator react loop opens a "Work stalled: pick a recovery path" packet when
    it hits the depth cap or sees a verbatim repeat. It never asked whether the task had
    arrived. Live on SHOP-32: the Integration Verifier approved `f5470f05` at 05:14:33, both
    required verdicts sat on the current head and validation read `healthy` — and two seconds
    later the cap opened that packet, offering redirect the specialist, send it back for another
    attempt, or hold for runtime debugging. Every option re-dispatches work that had passed.
    Then the packet blocked the acceptance it should have been waiting for: the task page read
    "Not acceptable yet. This task has an open blocked decision. Resolve the operator's packet
    before accepting it." The doors left to a person were to redo finished work, or to
    force-accept past a review gate that had PASSED — recording a bypass of a review that
    happened and succeeded.
    The packet's own sentence already claimed the test this adds: "hit its depth cap WITHOUT
    REACHING A BOUNDARY". Acceptable at the review boundary IS reaching one. The gate is asked
    before any packet exists, so it answers about the work rather than about the packet the
    branch is deciding not to open, and the skip is logged so a quiet chain is still traceable.
    (`task-actions.server.ts`.)

259. **A composer keeps the words until the server takes them (2026-09-15, pass 37; F37-90).**
    Both controller composers called `setText("")` synchronously after `fetcher.submit`, as if
    the POST always succeeds, and nothing anywhere held the string — the fetcher's `formData` is
    never read back, and neither result handler restored it. So an expired CSRF token, which is
    refused BEFORE the controller engine runs and therefore leaves the text in no transcript at
    all, destroyed what the person had written. So did a 404 on a scope not open to them, and
    any transport failure. The only account of it was a toast that unmounts itself after
    2,600 ms. Four of the five longest messages on the live board are 1,800 to 2,200 characters,
    typed into a two-row textarea.
    Cleared on SUCCESS now, and only when the box still holds exactly what went out, so somebody
    who started typing the next message while this one was in flight keeps it. On a failure the
    text and the Send button both stay, which is the difference between a retry and a rewrite.
    (`controller-dock.tsx`, `controller-page.tsx`.)

260. **A chain's own creator gets its controls (2026-09-15, pass 37; F37-91).** The goal-redirect
    gate is a DISJUNCTION — `requireGoalAuthority` allows the creator, or anyone with
    `run-agents`. The Goals panel computed ONE boolean from the viewer's project role and handed
    it to every card, so the creator arm was never evaluated. A contributor may create a chain
    (`create-task` is admin/maintainer/contributor) and is not `run-agents`
    (admin/maintainer), so the person who started a chain was shown it with no Pause, Resume,
    Cancel, Retry or Skip — and this panel is the only goal-redirect UI in the product. The
    repository's own toolkit test already proved the server says yes: a contributor creates
    goal-1 and then pauses it, both `[done]`. `createdBy` was on every row the loader already
    handed the component. The server stays the authority; the page has stopped refusing on its
    behalf.
    (`controller-page.tsx`, `controller-query.server.ts`.)

261. **A project's rulings are never the thing that gets starved (2026-09-15, pass 37; the
    owner's call on F37-82's residue).** Ruling 239 appends the project's rulings knowledge base
    AFTER a profile's own grants so it never displaces them. The cost of that ordering is that
    the rules a project made binding on every run are structurally the FIRST thing trimmed, on
    exactly the agents carrying the most grants — the operator, which writes the packets and
    scoping notes every specialist works from, and the controller. It bit live: two project KBs
    totalling 27,928 characters against a 24,000 budget, and the operator received
    `standing-corrections.md` cut off mid-word at "fails in about thr", losing two of its three
    rules. Ruling 253 made that visible; visible was not enough, because the controller kept
    writing settled rules there, which is what it was asked to do, and was back at ~23,350
    within hours.
    Asked which side should give, the owner reserved a floor. `RULINGS_KB_FLOOR` (8,000) is a
    CEILING ON WHAT THE OTHERS MAY TAKE, not an allocation the rulings must spend: the reserve
    is the smaller of the floor and what the rulings actually need, so a short rulings KB costs
    a profile's grants nothing, and a long one still takes everything the grants left over.
    One read each; ruling 239's emission order is unchanged, so the rules are read after the
    craft they qualify. What trims on a heavily-granted agent is now the optional craft rather
    than the binding rules, and ruling 253 still names whatever fell out.
    (`kb-injection.server.ts`, `specialist-run.server.ts`, `operator-run.server.ts`,
    `controller-run.server.ts`, `operator-actions.server.ts`.)

    *(Corrected the same day by self-review, before any of it ran in anger: ruling 241's drain
    lived only in `announceRelease`, and `setTaskDependencies` computes `releasing` as
    `next.length === 0 && previous.length > 0 && !ctx.operatorAuthorized`. The operator is
    excluded on purpose — `announceRelease` re-invokes the operator and a write from inside
    its own turn would loop — so the operator correcting a wait with `set_dependencies`, which
    is the door ruling 240 names as the remedy for a wrong hold, cleared the hold without
    draining. The question would have sat on the task forever under a wait panel still
    promising it would be put when the wait cleared, on a task with nothing left to clear:
    F37-68's own shape inside F37-68's own fix. The drain now runs wherever the hold GOES
    AWAY, not only where a release is ANNOUNCED. The dispatch guard was corrected in the same
    pass: it asked whether a queue entry EXISTS, which answers yes for one somebody else left
    behind, and now carries the flag saying whether THIS resolution queued.)*

262. **A disclosure names everyone it left out, not the one a run would have gone to
    (2026-09-15, pass 37; F37-92).** Ruling 252 stamped a comment that tagged an agent with the
    sentence saying nothing was sent to it, and computed that stamp with
    `resolveMentionedAgent` — a resolver written to pick exactly ONE target, because
    `commentToAgent` needs one agent to start. Answering the dispatch question does not answer
    the disclosure question, and reused as a completeness report it under-reported four ways.
    The first one is ruling 252's own motivating example. Live on SHOP-26 the controller wrote
    `@operator @platform-architect The funded amendment now exists as a task`; `@operator` is
    precedence 1, the resolver returned the operator, the stamp was skipped for being the
    operator (ruling 214, correctly — a controller turn's other writes wake the operator on
    their own), and @platform-architect was never mentioned. Ruling 252 shipped without fixing
    the comment it was written for. The other three: a second specialist tagged beside the
    first is dropped by `specialists.find`; `@claude` on a board running two claude profiles
    resolves to null (B-AG2) and so is silent; and `@agent` on a task with no delivering
    engagement resolves to null and is silent. The last two are exactly the cases a HUMAN
    writing the same words gets a policy-engine note for, so the person was told and the
    controller doing it on their behalf was not.
    `unreachedAgents` asks the disclosure question instead: which handles are in this text, and
    which of them will read nothing. It needs no backend, session or model, so it is a pure
    read of the project file and the task frontmatter, and it returns all of them — every named
    specialist in the order the TEXT tags them, the ambiguous backend handle with the profiles
    it covers, and `@agent` with no deliverer. `unreachedAgentNote` takes that report and
    returns null when there is nothing to say, so the ordinary status comment that tagged only
    people still grows no paragraph. Handles are stamped through `agentMentionHandle`
    (P14-RT-12), so the sentence telling somebody to run an agent names a handle that routes.
    (`agent-reply.server.ts`, `agent-toolkit.server.ts`, `operator-actions.server.ts`.)

263. **A dispatch that returns is not a run that started (2026-09-15, pass 37; F37-93).**
    `startRun` has three endings — launched, parked behind the concurrent-run cap, or refused
    before any process could exist — and returned the same `{ runId }` for all three. So every
    door that reports a dispatch to a person either guessed or said "started" and was wrong
    twice. Measured in the repository's own fixture: `run_agent_on_task` on a task whose owner
    has no Codex account answered `[done] Developer run started on VIB-142 (codex)`, under a
    tool description promising it "reports honestly whether a run started", for a dispatch that
    ruling 127 had already turned into a run ROW recording the refusal and nothing else. The
    person reading the controller was told work had begun; the board showed an errored run.
    The task page's toast said the same thing, and promised a stream of agent logs a refused
    run never produces; the operator's own `run_agent` reply said "and started its run", which
    is what the operator then plans its next move on.
    `startRun` now returns `{ runId, outcome, refusal }`, `admitRun` returns whether it
    launched or parked, and `StartAgentRunResult` carries both up. The three doors each say
    which of the three happened, in their own voice, and a refusal quotes the run's OWN
    sentence rather than restating it.
    The same tool skipped R21-9's law on the way in. Every sibling dispatch door records the
    human's directive on the timeline — the task page appends `@<agent> <prompt>` as the
    dispatcher's own comment after the start, the operator writes one before it — so a
    directive that reaches an agent is something supervision can read. Through the controller
    the directive went into the agent's prompt and NOWHERE else: a run appeared on the task for
    no stated reason, and the person who asked for it could not see what they had asked for.
    It now writes the same comment, authored by the PERSON whose words they are (the controller
    relayed them, it did not write them) and addressed to the agent, after the start so a
    dispatch that throws leaves no orphan hand-off.
    (`run-service.server.ts`, `specialist-run.server.ts`, `controller-toolkit.server.ts`,
    `operator-actions.server.ts`, `task-actions.server.ts`, `project.task.tsx`.)

264. **A deploy reports the delivery posture it stored, not the one it used to store
    (2026-09-15, pass 37; F37-94).** `deploy_agent` ended every successful reply with
    "Delivery starts withheld; open it up with update_agent_deployment when the profile should
    write the repo", and its own description promised the same. That was true when a library
    deploy wrote the conservative grant set. Ruling 156 made the deploy COPY the template's own
    grants, and the shipped `developer` template carries `execute-code-or-write-repo: direct` —
    so on this instance a deploy of it produced a profile that can push to the repo the moment
    it is engaged, under a sentence saying the opposite, read by the one person whose next
    decision (engage it as the deliverer, or not) turns on the answer.
    The reply is now read off the grants that were actually written, through `deliveryWithheld`
    — the same predicate `codexRepoWriteAdvisory` and the run's own gate use, so the sentence
    cannot drift from what the run is held to. One derivation, one answer.
    (`agent-profile-actions.server.ts`, `specialist-tool-policy.ts`,
    `controller-toolkit.server.ts`.)

265. **A tool whose only argument nothing can produce is not a tool (2026-09-15, pass 37;
    F37-95).** `read_run_log` takes a `runId`, and its description could only say where to find
    one: "e.g. from a task's console" — a screen. Neither the controller's toolkit nor
    `viberr_ops` enumerated a run id anywhere, so the one tool for reading why a run failed
    was reachable only by a person reading an id off a page and typing it into a conversation.
    `instance_health` makes the gap visible without closing it: it reports `runs: {cap, lane,
    live, queued}` — four integers, correctly carrying no name, because that reading is what
    the UNAUTHENTICATED health probe already serves. Live, the controller read `live: 5`, could
    not learn which five, and reconstructed them by reading every task on the board and
    matching `waiting: "agent"` against timeline events.
    `list_runs` closes it in `viberr_ops`, beside the tool that needed it. With no arguments it
    answers every LIVE run (running, or queued behind the cap) the asker can see, newest first;
    with `projectSlug` + `taskKey` it answers that task's runs with the finished ones included,
    which is how the log of a run that already failed is reached. The live listing DROPS a row
    in a project the asker cannot see rather than refusing — a refusal would disclose that the
    run exists — while the task arm refuses out loud, because that listing was asked for a
    named project. It stays read-only, and it audits like every other diagnostics read.
    (`controller-ops-mcp.server.ts`, `run-store.server.ts`.)

266. **A controller asked to judge a delivery can read it (owner, 2026-09-15, pass 37;
    F37-96).** Asked to say, per PR, whether it would merge or send back three open pull
    requests, the controller had `get_task`'s `pr.paths.changed` — a filename list — the commit
    subjects, and `changed: {files: 4, add: 1528, del: 67}`. No tool in either of its servers
    returned a diff, a hunk, or a file at a revision. It answered honestly and the answer was
    the finding: "my judgement on PR #32 rests on a four-line filename list and a reviewer
    verdict that had not arrived. I can commission a review; I cannot check one." A +1528/-67
    rewrite of a process supervisor is a lot of surface for a false-green to hide in.
    `read_pull_request` reads one task's PR: every changed file with its status, its counts and
    its hunks. Membership gated, read-only, one endpoint.
    Asked which shape it should take, the owner chose the NARROW one. Specialists already hold
    `read-github-api`, a GET-only passthrough scoped to their task's repo, and mounting that
    would have been fewer lines — but the controller runs with an END USER's permissions across
    every project they can see, so it gets one named question with no caller-supplied path to
    scope rather than an API surface to reason about. It is also the only controller tool that
    reads outside the instance on somebody's behalf (the request is made by the server with the
    project's sealed credential), so it audits, like the diagnostics reads E32-5 covered.
    Bounded in the two ways a model cannot see: a patch withheld for the byte budget still
    LISTS its file, flagged, because dropping the row reads as a PR that does not touch it; and
    a file GitHub sent no patch for (binary, or too large for it to diff) is distinguished from
    a budget cut, because those two call for different next moves. `path` reads one file's
    hunks in full, including by its pre-rename name.
    (`pr-diff.server.ts`, `controller-toolkit.server.ts`.)

267. **A settled chain's name can still be corrected (2026-09-15, pass 37; F37-97, amends
    ruling 192).** Ruling 192 gave `update_goal` a `rename` op "while it is not terminal",
    matching every other op in that switch. Every other op there changes what the chain will
    DO, and a completed or cancelled chain will do nothing, so the guard is right for all of
    them; `rename` changes only what the chain is CALLED. And a chain is named before the work
    is understood, which is the whole reason ruling 192 added the op.
    So the guard closed the window on ruling 192's own motivating example. `goal-2` still read
    "Identity and Catalog services" after catalog moved to goal-6, and `goal-4` read
    "Storefront and Admin surfaces" after admin moved to goal-7; both completed while the
    controller believed, wrongly, that goals could not be renamed at all. By the time it tried,
    the answer was `[error] Goal goal-2 is completed`, and those two titles are now permanently
    wrong on a record people read to learn what was built. Refusing an edit that changes no
    state, starts nothing and loses no history bought nothing.
    `rename` is now the one op a settled chain takes. It lands in the chain's history like any
    other, so nothing is rewritten silently, and on a settled chain it says the whole truth
    about its reach: every link task keeps the old name in its header, and nothing new will
    ever carry the new one.
    (`goal-actions.server.ts`, `controller-toolkit.server.ts`.)

268. **A guard calibrated to the wrong quantity is not a guard (2026-09-15, pass 37; F37-98
    and F37-100, both raised by the controller against rulings 265 and 266 on the day they
    shipped).** Ruling 266 bounded `read_pull_request` at 120,000 characters of patch, counted
    RAW. The reply is JSON: every newline in a diff becomes `\n` and every quote `\"`, so a
    hunk roughly doubles on the way out. The controller called it on PR #32 — four files — and
    the guard never fired: `patchesWithheldForSize` false, every `patchOmitted` null, and an
    83,196-byte reply. What caught it was the Agent SDK's own offload, which wrote the result
    to a file under the run's home and instructed the model to read it in chunks. The
    controller has no filesystem tool: "the safety net handed me a path I cannot open, and the
    instructions attached to it are addressed to an agent with a Read tool that I am not."
    The budget is now spent in ENCODED characters — the quantity that actually reaches the
    ceiling — and the default is 40,000, set UNDER the measured trip point rather than above
    it, because the caller cannot recover from the other side's truncation and can always ask
    for another page.
    The same report named the loop that made the failure unavoidable: `path` reads one file,
    and the only way to learn the file names from this tool was to ask for every patch — the
    call most likely to be too big. `patches: false` now lists every changed file with its
    counts and no hunks, so the first call on a PR of unknown size is always safe, and it is
    flagged `not-requested` rather than `budget`, because a caller who asked for no patches
    had nothing cut from under them.
    And `list_runs` reported a controller turn as `projectSlug: ""` with
    `taskKey: "cnv_…"`. Ruling 99 stores a conversation id in the runs table's `task_key`
    because that table has one identity column; a storage shape is not a reply shape, and
    "anything filtering by task has to know to discard that row". A controller row now names
    its `conversationId` and carries no task.
    (`pr-diff.server.ts`, `controller-toolkit.server.ts`, `controller-ops-mcp.server.ts`.)

269. **An option that instructs the reader is not a decision they can take (2026-09-15, pass
    37; F37-101).** Rulings 164, 224, 230 and 237 each found the same defect in a different
    verb: an operator writes a `custom` option describing an action, the person confirms it,
    and the resolution does nothing but re-run the operator. The verb missing this time is the
    most common structural remedy a multi-service board has — "this belongs in its own task".
    Live on SHOP-26 the operator found `stockBatchResponseSchema` published on main with no
    producer, and the project's own conventions say a reported gap has to end up owned by a
    live task rather than sitting as a footnote. Its recommended option's text ends, verbatim:
    "You create the task — no option here can." It was right: sixteen kinds, and not one makes
    a task.
    `create_task` carries `newTask` (title, goal, and optionally what the NEW task waits on and
    its labels) and creates it through `createTask` — the same door the board and both toolkits
    use — under the RESOLVING person's own authority. Every possible resolver already holds
    `create-task` (packet resolution is admin, maintainer, or the task's human owner, and
    owning a task is itself contributor-and-above), so the kind needs no new tier.
    Three things it deliberately does NOT do. It does not amend this task's goal: ruling 189
    binds a decision to the contract, and this decision is about work that is not this task —
    the exclusion list gets its fifth entry for the reason the other four are there. It does
    not touch this task's state at all (the one case in the switch whose mutation is a
    deliberate no-op) and its event is a note rather than a transition, because nothing here
    moved. And the join between the two is written on both records: the new key lands on this
    task's timeline the moment it exists, so "which task came out of that decision" is
    answerable without reading a goal chain.
    The card shows what is about to be created — the new task's title and goal, on the selected
    option — so the person confirms the task rather than the sentence describing it.
    (`task-file.schema.ts`, `operator-actions.server.ts`, `operator-toolkit.server.ts`,
    `task-actions.server.ts`, `decision-packet.tsx`.)

270. **A kind whose payload the authoring tool does not carry is not offerable (2026-09-15,
    pass 37; F37-102, amends rulings 224 and 230).** Ruling 230 gave `block_on_dependencies` a
    `blockedBy` payload and two authoring refusals — one for an option that names nothing to
    wait on, one for the field on any other kind. Ruling 224 did the same for
    `wait_for_window` and `dueAt`. Neither added the field to `open_decision_packet`, the tool
    that AUTHORS options. So an operator could name `block_on_dependencies`, receive "A
    block_on_dependencies option needs the work it waits on", and have no way to say it — and
    nothing else in the product writes that kind either, so ruling 230's whole mechanism was
    unreachable from the moment it shipped. Its own words were that the mechanism "simply could
    not be reached from the surface where the decision is actually made"; it stayed that way.
    Both rulings' tests called `operatorOpenPacket` directly, which accepts both fields. The
    writer was proven and the DOOR was never opened. The canary for this one goes through the
    tool handler, which is the surface an operator actually authors from.
    The lesson is the pass's third sighting of one shape: ruling 252's stamp skipped the live
    comment that motivated it (262), ruling 192's terminal guard closed the window on the goal
    it was written for (267), and here two rulings shipped payloads their only author could not
    send. A ruling is not finished when the mechanism works; it is finished when the surface
    that needs it can reach it.
    (`operator-toolkit.server.ts`.)

271. **The briefing includes the answer the card always offers (2026-09-15, pass 37;
    F37-103).** A decision card offers one more choice than the packet stores: a free-text
    directive in the person's own words, composed with the fixed options as their last choice
    (`customOffered = canResolve`). It is not a stored option, so `list_decisions` — whose
    whole stated purpose is "so you can brief the person fully" — listed the fixed choices and
    nothing else, and the one answer that is ALWAYS available was the one it never mentioned.
    What that cost, live: the controller was asked to have SHOP-26's decision re-raised,
    because its recommended option's text was "You create the task — no option here can" and
    ruling 269 had since made that possible. It found, correctly, that only the operator can
    open a packet, that a manual operator run is refused while one is open (ruling 76/141), and
    that it holds no withdraw of its own. From those three true facts it concluded a deadlock
    and reported it in exactly these words: "there is no way to say 'these options are wrong'
    except to pick one of them." There was, and it is the choice sitting directly under the
    ones it could read: the free-text answer resolves the packet with the person's directive
    and puts that directive to the operator, which is precisely "these options are wrong, put
    the decision again". Three facts, each true, and a false conclusion — because the briefing
    tool omitted the fourth.
    `list_decisions` now carries `ownWords` on every packet, numbered where the card puts it
    (`options.length + 1`, so a person reading the briefing finds the same choice), named apart
    from `options` because it is not a `PacketOptionKind` and must never be relayed as one, and
    the card's own test pins that position from the other side.
    The refusals themselves are not loosened. An open packet SHOULD freeze its options — the
    person answering must not have the question changed under them — and a manual operator run
    with a packet open is the paid no-op ruling 76 refused for good reason. Nothing was
    deadlocked; the map was incomplete.
    (`controller-toolkit.server.ts`, `task-detail-components.test.tsx`.)

272. **Two sentences that were wrong about what survives (2026-09-15, pass 37; F37-104 and
    F37-105).** The Interrupt dialog on the task page said: "The agent stops where it is.
    Anything it has not already committed or delivered is lost." Nothing is lost. An interrupt
    kills the PROCESS and never touches the task's workspace — `cloneRepo`'s reuse path hands
    the next run that same checkout and fast-forwards only a tree that is clean on the default
    branch, so a dirty one is left exactly as the interrupted agent left it. The sentence was
    wrong in the direction that costs most: it tells a person that stopping a stuck run
    destroys work, discouraging the one action the product wants them to be able to take, and
    it tells whoever runs next that the tree is clean when a half-written edit is sitting in
    it. It now says what actually happens — the turn is lost, the edits are not, and the next
    run continues from that tree rather than a fresh one. (The controller's own Interrupt
    dialog was already right: a controller turn has no workspace, and it says so.)
    And ruling 263 put R21-9's law — a directive that reaches an agent goes on the record — on
    `run_agent_on_task`'s SPECIALIST arm, and returned above it for the operator. So the one
    dispatch door still sending a human's words off the record was the operator half of the
    door ruling 263 had just fixed. The controller caught it three minutes after the deploy, by
    counting the task's own comments across two reads: "the three new events are the PR push,
    the operator's own comment to the Backend Engineer, and the run start. My directive is
    nowhere in the +1." The task page's Run-operator control has written that comment since
    2026-08-21 for exactly the stated reason; the controller's arm now writes the same one,
    only when the run was not refused, so a refused dispatch strands no hand-off. Every other
    refusal value is named rather than falling through to "[done] Operator run started" —
    the sentence ruling 263 exists to stop.
    (`task-detail-page.tsx`, `controller-toolkit.server.ts`.)

273. **A recovery option is not offered onto a backend already known to be spent (2026-09-15,
    pass 37; F37-106).** `operatorOpenPacket` refuses to author an `accept_completion` away
    from the acceptance boundary, a `resolve_remote_collision` with no collision recorded, and
    a `discard_branch` on a revision that has left the workspace — all for one reason, in the
    first guard's own words: "the human is left confirming a card that cannot succeed". The
    kind whose entire job is RECOVERY had no such guard.
    Live on SHOP-37: Codex was recorded exhausted for the task owner's credential at 03:26
    ("try again at Sep 19th, 2026 9:36 AM"); the operator recommended "Re-run the Integration
    Verifier on the Codex backend" six hours later; a person confirmed it; and the answer was
    "The retry could not start: Held: Codex is out of quota until Sep 19 · 09:36 UTC;
    Integration Verifier's run is scheduled for then." Nothing lied and nothing was lost — that
    hold is ruling 152(c) working exactly as designed — but a decision was spent on a four-day
    park that was knowable at the moment the option was written, and the task sat behind it.
    Authoring now reads `backendDispatchHold` for the credential the run would bill (the task's
    owner, ruling 127) and refuses a `retry_other_backend` onto a held backend, naming the hold
    and the two kinds that fit instead: the other backend, or `wait_for_window` with the reopen
    instant — which ruling 224 built for precisely this fact and which resumes by itself. The
    hold is per (backend, credential), so a retry onto the backend that CAN run is untouched.
    (`operator-actions.server.ts`.)

274. **A deleted project releases its conversations (2026-09-15, pass 37; F37-107).**
    `deleteProject` already clears three app-owned tables that no foreign key cascades and no
    rebuild touches — notifications, the credential binding, the cached repo probe — each for a
    named consequence. `controller_conversations` is the fourth, and it kept its binding.
    The orphan is not merely stale. A conversation's `project_slug` is what the controller
    toolkit's `slugOf()` DEFAULTS to, so a conversation bound to a deleted slug acts on
    whatever comes back under it — and a slug comes back the ordinary way, because slugs are
    derived from names: create a project called the same thing and the old conversation
    silently becomes a conversation about the NEW board. Its transcript, about work that has
    nothing to do with that project, is now listed under it, and every unqualified board tool
    in it aims at a project its author never chose. The repo-health row had the same shape and
    the same fix note already on it ("a new project reusing the slug inherited the dead one's
    probe verdict"); the conversation was the one nobody came back for.
    RELEASED, not deleted. The transcript is the record of what somebody asked and what the
    controller did, and this product does not destroy records. The conversation becomes
    instance-scoped — a real scope, with both columns cleared because a task key without a
    project is not one — and carries a message naming the deleted project, so its author is not
    left wondering where the board went.
    (`controller-conversations.server.ts`, `settings-actions.server.ts`.)

275. **A prompt does not contradict itself in silence (2026-09-15, pass 37; F37-108, extends
    ruling 191).** Ruling 191 put the measured shell inventory into every specialist run,
    operator run and controller turn, unasked, because "an inventory you must know to ask for
    is not a fact the planner has". It says what the host lacks. It did not say "and the role
    description above plans around three of them".
    Found by the controller, reading personas it had twice reported it could not read. Four of
    this instance's own agent templates carry a map of a machine that does not exist. The
    Infrastructure Engineer — running two tasks at that moment — is told "you own the shared
    surfaces: the workspace scaffolding, the Docker Compose stack", that "`make up` is your
    headline deliverable and it must be honest: from a clean checkout it builds, starts
    Postgres and Redis", and to "cache the pnpm store and Turborepo outputs". The Frontend
    Engineer reports "the results of your component and Playwright runs". A persona is the
    system prompt: read first, weighted heaviest, and written with more authority than a
    measurement further down. A contradiction inside one prompt is resolved by the MODEL, and
    the product had no opinion about which half was true.
    The inventory now names them: "Your own role description above mentions `make`, `docker` —
    not on this host. Where it plans around those, this measurement is the one that is true
    today." Derived, never asserted — the scan runs over the labels the probe actually
    measured, so it can only ever name a tool that was measured and found absent, and it says
    nothing when the prose is clean. Word boundaries, because "curly braces" is not a plan
    against `curl`; and `go` is excluded outright, because it is an ordinary English word and
    "go and read the tests" is not a Go toolchain.
    This does not rewrite anyone's persona. Whoever wrote it owns it; the product's job is to
    stop a run acting on the wrong half of its own prompt without noticing.
    (`toolchain.server.ts`, `specialist-run.server.ts`.)

276. **A null that means two things says which (2026-09-15, pass 37; F37-109).** `prRefSchema`
    keeps "never read" (the `checks` key is absent) apart from "read, and GitHub reported no
    check runs" (`total: 0`), and its own comment says so: "an absent key is 'never read',
    which is not the same as 'no checks'". `mapPrChecks` collapses both to null — correctly, a
    display has nothing to draw either way — and every reader inherited that collapse,
    including the one for whom the difference IS the answer. Live, the controller read
    `checks: null` on all thirty pull requests, could not tell which, reconstructed review
    state from task timelines instead, and learned only from prose an operator had written into
    a task goal that this account's GitHub Actions are billing-blocked. "No CI is configured"
    and "we have not looked" ask for opposite next moves.
    `prChecksRead` is the one derivation, carried beside the render rather than folded into it,
    so the GitHub page's "no pill for zero checks" is byte-for-byte unchanged and
    `get_github_state` gains `checksRead`. Its description now also says what `review` is: it
    is GITHUB's review verdict, null on a repository where humans do not review there, and
    Viberr's own reviewer verdicts live on the task — which is the second thing the controller
    had to work out for itself.
    (`task.server.ts`, `github-query.server.ts`, `controller-toolkit.server.ts`.)

277. **A drift report that compares one field answers about one field (2026-09-15, pass 37;
    F37-110).** Ruling 156 built copy-drift detection for GRANTS, because that was the finding
    it was written for. The same deployment record also snapshots the PERSONA — the run's whole
    system prompt — and the `desc` the operator selects agents by, and nothing compared either.
    P13-AP-07 had already settled the snapshot model and warned a human editing a copy that "a
    later org-level rename, stage change, resource change or persona fix never reaches it";
    what was missing was anyone saying so at the moment of the fix.
    The cost, measured within the hour it shipped: the controller found four agent templates
    whose personas describe a machine this host is not — the Infrastructure Engineer, running
    two tasks at that moment, was told it owns "the Docker Compose stack" — rewrote all four,
    checked the drift report afterwards, read `copiesDiffering: []`, and reported the job done.
    Every one of those four runs still mounted the old text. A report that answers "no copy
    differs" about a copy that differs is worse than no report, because it is believed.
    `listTemplateTextDrift` is the second comparison, kept apart from the first because the two
    facts are independent and the case that misled is exactly "grants in step, text behind":
    `list_global_agents` gains `copiesWithOlderText` naming the project AND the field, and every
    arm of `save_global_agent`'s reply carries the sentence — including the "every project copy
    carries the template's grants" arm, which is the one that was read as all-clear. An ABSENT
    key on a copy is not drift: it means the copy snapshotted nothing and resolves the template
    live. The remedy named is the true one (P13-AP-07's): propagate rewrites grants only, so a
    copy's text is fixed on that project's own Agents page.
    (`template-propagation.server.ts`, `gagents.server.ts`, `controller-toolkit.server.ts`.)

278. **An MCP pointed inside Viberr's own store is named as what it is (owner, 2026-09-15,
    pass 37; F37-111).** Found by the controller, asked to use the instance tools nobody had
    used. `kb-conventions` spawned `@modelcontextprotocol/server-filesystem` pointed at
    `/data/kb/shopify-clone-conventions` — the project's rulings knowledge base, which
    `set_project_rulings_kb` injects into every run on that board. Fourteen tools, nothing
    withheld, granted to three profiles, two of them reviewers. A reviewer could rewrite the
    rules it is judged against, and the operator reads those rules on every turn.
    The sharp half is that ruling 176's marking would NOT have closed it. Marked write tools
    are withheld only from a run that WITHHOLDS `execute-code-or-write-repo`, and every
    realistic holder of a filesystem MCP has it — a reviewer needs it to run a test suite. The
    guard is shaped for a read-only profile that barely exists on a working board, so the
    protection existed and did not reach the case.
    Asked what the product should do, the owner chose the warning over a new gate kind. Viberr
    owns that directory, so it can see the overlap and say so, wherever a person configures or
    reads the server: `save_mcp_server`'s reply at the moment the path is chosen, and every
    `list_mcp_servers` row. The sentence names the path, what an agent can do with it, and
    that the write-tool marking is not the answer — because an admin who thinks it is will
    mark the tools and stop looking. It withholds nothing on its own; the decision stays a
    person's.
    Two corrections rode along, from the same report. `list_mcp_servers` reported `up` — a
    CACHED verdict — without `lastCheckedAt` or `warmingSince`, so a server the controller
    probed and found healthy in 10.3s was listed red with no way to judge the reading's age
    (R19-18's whole point is that a first-run install is not a broken server). Both are now on
    the row, and the description says to probe rather than relay a stale red.
    (`resources.server.ts`, `controller-toolkit.server.ts`.)

279. **A filter that matches nothing does not look like a quiet period (2026-09-15, pass 37;
    F37-112).** `inspect_audit_log`'s headline said "filters (project, action PREFIX, actor,
    time range)" and its `action` parameter said "Exact action id, e.g. task.created" — two
    descriptions of one field, contradicting each other inside the same tool, and the behaviour
    followed the stricter one. Live, the controller filtered `action: "task."` across 8,282
    rows, received `total: 0` with no error, and wrote the finding itself: "a wrong filter is
    indistinguishable from a quiet period."
    The prefix is the useful reading and now the real one, through a separate `actionPrefix`
    on the export filters so the CSV/JSON export's exact-match contract is untouched. The
    wildcard is anchored at the end and the caller's own `%` and `_` are escaped, so a prefix
    cannot become a pattern that matches the whole log.
    Two more from the same report, both about an answer you cannot act on. An empty result
    under an action filter now SAYS it matched nothing and points at the list; and every reply
    carries `actions` — the vocabulary in that window with a count each. That was the other
    half of the complaint: with no facets, "how many decisions happened" meant paging 8,282
    rows at 200 a call, and the action ids were reachable only by already knowing them.
    (`audit-export.server.ts`, `controller-toolkit.server.ts`.)

280. **A toolkit sentence is not a product statement (2026-09-15, pass 37; F37-113).**
    `deploy_agent`'s description said "No removal exists here." True of that toolkit and false
    of the product: `deleteAgentProfile` removes a deployment from the project's Agents page,
    and has since the agents surface existed. A sentence in a tool's own description is read as
    a statement about what CAN be done, not about which door offers it — and it was believed.
    Auditing this instance, the controller found two deployed profiles used by nothing, scoped
    to stages this board does not have, and wrote: "deploy_agent has no inverse — its own
    description says 'No removal exists here.' I cannot un-deploy them. The only lever is
    neutering a live deployment, which is a workaround, not a fix." It was about to do the
    workaround.
    Ruling 85's rule, on a new surface: a refusal that lists only workarounds hides the fix.
    The sentence now says which door removes a deployment, names the one profile that is never
    removable, and says outright not to offer the neutering instead.
    (`controller-toolkit.server.ts`.)

    *(And one flake, in this repository's own suite, of exactly the kind SHOP-35 is fixing in
    the clone: `controller-page.test.tsx` asserts an elapsed cell to the second against a
    `startedAt` stamped once when the describe body evaluates — so every test that ran before
    it spent part of that assertion's budget, and under a full suite the clock read 01:07
    against a window written for 01:05. Stamped per render instead. A gate that cries wolf
    trains everyone to discount red, which is SHOP-35's own premise.)*

281. **An agent can check a task it is told about (owner, 2026-09-15, pass 37; F37-114).** A
    specialist could read its REPOSITORY — `github_read` returns pull requests, reviews, checks
    and file contents — and not the BOARD it works on. Its whole Viberr toolkit was
    `post_comment`, `ask_human` and `report_outcome`. So a task key it was told about, in a
    document or a directive or another agent's report, could not be checked.
    The cost, measured on SHOP-26. `services/cart/DESIGN.md:458` claimed "SHOP-39 was created
    for this gap on 2026-09-15". Two agents read it, correctly refused to trust a document's
    claim about the board — "a task named in a document is not a task until someone checks",
    which is precisely the discipline the project's conventions ask for — and had no way to
    check. So the mismatch was reported as open, the operator re-raised a decision that had
    already been answered, and its recommended option carried a `create_task` whose title was
    SHOP-39's word for word. Nothing on the card could have told the person confirming it.
    `read_board` answers one key or lists the project: title, stage, readiness, what it waits
    on, whether it is archived, and (for one task) its goal. THIS project only, read-only, and
    no field a member could not read on the task page. Archived tasks are included, because
    "SHOP-8 was archived" is a real answer to "does SHOP-8 exist" and an agent told about a
    retired key must be able to learn that rather than read it as never having existed. A key
    that is not on the board answers plainly that the claim was wrong.
    It carries no capability grant — every one of these facts is already in the agent's own
    prompt for its OWN task, so the gap was never permission, only the tasks beside it. It is
    mounted only where a Viberr server is mounted anyway: a profile holding no collaboration
    grant at all still gets nothing, which is the gate U11 pinned.
    (`agent-toolkit.server.ts`, `board-read.server.ts`.)

282. **The actor that plans across the board can read it (2026-09-15, pass 37; F37-115,
    extends 281).** The operator's `get_task` takes NO arguments: it answers the task it is
    coordinating and only that one. Nothing else in its toolkit listed a task. So the one actor
    that writes `blockedBy` through `set_dependencies`, that decides ordering, and that is the
    ONLY author of a `create_task` option (ruling 269) planned across a board it could not read.
    Two duplicates in one hour, from that single cause. On SHOP-26 it proposed creating
    "Inventory: serve the published stock batch contract on GET /stock" — SHOP-39's title, word
    for word, created by its OWN earlier packet on the same task. On SHOP-27 it proposed
    "Gateway routes for orders, cart and inventory" while SHOP-29, "Gateway routes for
    inventory, cart and checkout", already stood and already waited on SHOP-27. Both times a
    person was one confirm away from a second task for work that had an owner, and nothing on
    either card could have said so. Ruling 269 handed a new verb to the actor least able to
    check whether it was needed.
    `read_board` is the same tool ruling 281 gave a specialist, on the same implementation, so
    "is SHOP-39 real" has one answer whoever asks. `get_task` stays the deep read of the task
    being coordinated; this is the shallow read of everything beside it.
    It joins the read-only FLOOR an undeployed operator keeps (A4): seeing a board it holds no
    authority over takes nothing away, and reading has never been the thing withheld there. It
    is a read, so it is not part of the governed vocabulary the Claude toolkit and the Codex
    plan enum must agree on — like `get_task` and `read_default_branch_file` before it.
    (`board-read.server.ts`, `operator-toolkit.server.ts`.)

283. **A knowledge base arrives as an INDEX, and the run reads the documents it wants
    (owner, 2026-09-15, pass 37; F37-118, supersedes 261).** Injecting the text was an
    allocation problem with no good answer. A KB's documents were served in ALPHABETICAL
    order out of a shared 24,000-character budget, first-come-first-served, so whichever
    document sorted first took everything it could and every document behind it got
    nothing. Measured live against this instance's store with the production reader:
    `conventions.md` (20,632 chars) took all 15,817 chars the budget had left, cut itself
    off mid-sentence inside its own §9 — "The gateway is a stronger boundary than a
    service, no" — and left ZERO for `published-history.md` (185 chars) and
    `standing-corrections.md` (281 chars). SHOP-27's own goal says "See
    published-history.md in the project's rulings knowledge base"; no run on that board
    could ever receive it, and the deliverer on SHOP-37 reported exactly that from inside
    the run.
    THE COST, corrected by the controller the hour this shipped, because the first account
    of it — the two small documents — was the visible half and the cheap half. Both of
    them turned out to be tombstones: "Merged into conventions.md §2 on 2026-09-15 to fit
    the shared KB budget. Nothing was lost." They held no rules, and SHOP-27's dangling
    pointer was harmless because §2 sits near the top and arrived by the surviving route.
    What was actually lost was the OTHER end — the tail of the document that won. Past the
    cut sat the project's definition of DONE ("deliverable at the declared paths and
    nothing outside them; lint, typecheck and tests pass for the touched workspaces; new
    behaviour has tests that fail without it"), "close a finding by mutation, not by the
    deliverer's summary", and the whole of §10: one task = one branch = one PR, keep the
    diff inside the declared path set, raise conflicts at DESIGN. No run on this board had
    ever read any of it. SHOP-42 sat blocked that same afternoon because a delivery left
    the suite red — the first clause of a definition of Done no deliverer could read. A
    budget does not drop the least important thing; it drops whatever is last, and rules
    accrete at the end of a document.
    Ruling 261 had already raised a floor for this, because `standing-corrections.md` was
    arriving cut off mid-word — and the floor was then eaten by the alphabetically-first
    document inside the very knowledge base it was protecting. It is the pass's own pattern
    a third time: a rule applied at one level and not the one below it. A second allocation
    rule would have had the same shape, so there is no allocation now.
    The prompt carries each KB's index — every document, its size, its heading outline and
    the folder's path on disk — which costs a few hundred characters whatever the folder
    weighs. `read_knowledge_doc` returns one document whole, and is mounted for the
    specialist, the operator and the controller alike; a run may read the knowledge bases
    attached to IT and no others, because the index it was given names those and only those.
    The specialist toolkit mounts it on its OWN gate, not U11's collaboration gate: an agent
    granted a knowledge base and nothing else still has to be able to read it. A Codex run
    mounts no in-process Viberr tools at all, which is why the index prints the folder path
    and the note names both channels.
    Three things follow. The org-settings row that has always read "N docs · agents read the
    live folder" is true again — it was counting documents a run could not receive. A rulings
    knowledge base can grow without silently pushing its own rules out of every prompt. And
    a run that ignores its index is visibly choosing not to read, where a run starved by a
    budget could not tell it had been.
    (`kb-injection.server.ts`, `specialist-run.server.ts`, `operator-run.server.ts`,
    `controller-run.server.ts`, and the three toolkits.)

284. **A typed directive answers the packet; it does not amend the contract (owner,
    2026-09-15, pass 37; F37-119, amends 189).** Ruling 189 welded a free-text answer into
    the task's goal "because a person wrote it". One text box takes two different things,
    though: a decision about the work, and a word to the operator about how it should work.
    Live within the hour the rule was re-read: SHOP-27's packet was answered with a directive
    that was mostly "you now have `read_board` — call it before you offer a create_task
    option", and that sentence is now part of the contract of the orders service, where every
    future run on it re-anchors. The very accumulation ruling 189 exists to stop, arriving
    through the one door it held open.
    The line is drawn by CHANNEL now. Choosing a structured option is a decision and amends
    the goal, with `PROCESS_ONLY_OPTION_KINDS` still excluding the recovery choices. Typing
    free text is conversation and never does. Nothing is lost: the directive is written to the
    timeline verbatim, where the person and the operator both read it, and it reaches the
    operator's next turn in its own `note` field on the re-queue — which is the channel it was
    always actually for. A free-text answer that IS meant to bind the work is an edit to the
    goal, which is its own action and says so. (`task-actions.server.ts`.)

285. **The coordinator can read a report it was handed half of (2026-09-15, pass 37;
    F37-120, same shape as 283).** An agent's report reaches the operator's prompt cut at
    4,000 characters and `get_task`'s `recentTimeline` cuts every entry at 1,500, and no
    tool in the operator's toolkit returned one whole. Both cuts were HONEST — the prompt
    header said "first 4,000 chars" — and honesty about a dead end is still a dead end.
    Live on SHOP-42 the operator raised a decision packet to a person carrying its own
    disclosure: "The reviewer's report reached me truncated at `### Item 3 —`, so I have
    not read its cross-service audit conclusion; the full text is on the timeline." Every
    part of that was true, including that the text was somewhere it could not go. What it
    could not read was the half where that reviewer put the work nobody asked it for — two
    unowned defects on `main`, a red `services/orders` suite and a stale `.env.example` —
    and neither would have reached a person if the reviewer had not also written them into
    the summary that did fit.
    The cut stays: a prompt carrying every 20,000-character report in full is the problem
    the cut exists to prevent. What is new is somewhere to go. `recentTimeline` rows now
    carry the `occurredAt` stamp and, when cut, a line naming the tool; `read_timeline_entry`
    takes that stamp and returns the entry whole. The clipped prompt block says the same in
    its own words, and says WHEN it matters: before summarising a report for a person,
    before raising a packet about one, and before concluding a report did not mention
    something.
    It joins the read-only FLOOR an undeployed operator keeps (A4), more plainly than
    `read_board` did: the task page already shows any member the whole comment this
    returns, so withholding it from the coordinator withheld it from nobody else. Like the
    other reads it is not part of the governed vocabulary the Claude toolkit and the Codex
    plan enum must agree on.
    This is ruling 283's shape one level over — a budget with no pull channel — found the
    same afternoon, in the operator's own words, in a packet raised for a different reason.
    (`board-read.server.ts`, `operator-toolkit.server.ts`, `operator-actions.server.ts`,
    `operator-run.server.ts`.)

286. **An index needs teeth when the documents behind it BIND (owner, 2026-09-15, pass 37;
    F37-121, completes 283).** Ruling 283 made every knowledge base a pull, and the
    controller named the regression that creates within the hour, with evidence from the
    board it coordinates: "Under injection, reading is not a decision. Under
    index-and-fetch it becomes one, and it competes with the agent's own turns — which on
    this board are scarce and frequently interrupted." And the structural half, which is
    the part that decided it: "An optional craft KB is consulted when an agent recognises
    a need. A rulings KB binds decisions the agent does not know it is making. Nobody
    fetches the never-rebase rule while about to rebase — at that moment they feel
    certain, not uncertain. The failure mode is not laziness, it is the absence of a
    trigger." Its evidence that these rules are load-bearing rather than decorative:
    SHOP-42's Code Reviewer cited §1, §4 and §7 by number in its verdict, and the operator
    cited §3 as its reason for raising two defects as TASKS rather than footnotes — and
    every one of those citations came from a run where the text was still injected.
    So a project's RULINGS knowledge base (ruling 239) gets three things a profile's
    optional craft knowledge base does not. Its index says **BINDING on this run**, as an
    obligation rather than an invitation, on the index itself where it is read with the
    document list. A note names the TRIGGERS rather than only the contents — before
    choosing a branch or merge strategy, before widening a path set, before reporting a
    check as passed, before calling work done or judging someone else's — because the
    index says what exists and never says when a rule applies. And the run is asked to
    state in its report which rulings sections it relied on, and to say plainly if it
    opened none: a delivery contradicting a rule its author never read should be something
    a reviewer can SEE rather than rediscover.
    Machinery, not a directive — also the controller's call, and its reason is the pass's
    own lesson: a rule living in the coordinator's directive covers only the tasks whose
    directives it writes, and misses reviewer engagements, verifier runs, chain-created
    tasks and every project it is not in, which makes it "a deferral recorded in a
    document with no mechanism behind it".
    What this deliberately is NOT is a gate refusing delivery until the document is
    fetched. The controller ruled that out and was right: "that is the serialisation
    answer — it works today and rots, and it taxes every run that legitimately did not
    need it."
    The obligation ships only when a rulings KB actually RESOLVED. A run told its project's
    rules bind it, on a project that names none or whose folder is gone, is handed an
    obligation it cannot discharge and sent looking for a document that reached it in no
    form at all. (`kb-injection.server.ts` and the three runtimes.)

287. **A created task can be connected in the direction the work runs (2026-09-15, pass 37;
    F37-122, completes 269).** Ruling 269 let a decision CREATE a task and say what the NEW
    task waits on. But a task is normally created to UNBLOCK something, so the dependency
    points the other way — from the existing work to the new task — and that direction could
    not be expressed by anything in the product except a person editing the other task's
    page, or the controller, which the operator cannot call.
    Live on SHOP-28, in the operator's own packet prose: "Two things it asks for are edits to
    OTHER tasks, which no packet option can perform — they need you on those task pages: add
    the new amendment key to SHOP-41's waits… I will set SHOP-28's own wait myself as soon as
    the amendment task has a key." Every part of that was right. A person had routed three
    frozen contract shapes to a narrow amendment task; the operator created it and then
    handed back a chore. Nothing on SHOP-41 said an edit was owed, so a forgotten one would
    have left SHOP-41 free to start building against contracts that did not exist — the exact
    divergence the amendment task was created to prevent. The ordering was settled, recorded,
    and delivered into a human's memory.
    `newTask.blocks` is the reverse edge: existing task keys that get the new key written into
    their OWN `blockedBy` when the person confirms. It goes through `setTaskDependencies`, so
    the cycle check, the archived-task refusal, the projection and the release engine are the
    ones every other caller gets; it is authored by the operator and written only because a
    person confirmed the option, which is the same authority `create_task` already runs under.
    Three honesty properties, each of which had to be built rather than assumed. The
    provenance note lands on the task whose wait GREW — a wait appearing with no reason on a
    task nobody was looking at reads as Viberr deciding something on its own. A key that
    cannot be written (missing, archived, cyclic) is reported on the deciding task WITH the
    remedy, and never undoes the decision or the task it already produced: one unwritable
    edge is not a reason to discard work a person confirmed. And the option card names the
    tasks that will start waiting, BEFORE the confirm — it is the one consequence of a
    `create_task` decision a person cannot see anywhere else on the page they are confirming
    from. (`task-file.schema.ts`, `task-actions.server.ts`, `operator-toolkit.server.ts`,
    `operator-actions.server.ts`, `decision-packet.tsx`.)

288. **A goal too long to carry is refused, never cut (2026-09-15, pass 37; F37-123,
    amends 138).** `goalDraft` and `newTask.goal` are the two texts a packet option can
    turn into a task's GOAL, and a goal is the contract every future run on that task
    re-anchors on (ruling 189). Both were a bare `.slice(0, GOAL_DRAFT_MAX_CHARS)`, and
    the test that pinned it said so in its own title: "caps an over-long goalDraft …
    instead of refusing it".
    Live on SHOP-29 this afternoon. A person's decision asked the operator to correct an
    acceptance criterion and to write the REASONING into it — explicitly so that a later
    reader would not read the bare rule as sloppiness and undo it. The draft came back
    4,000 characters long to the character, ending "…a 403 there would be", and the
    sentence carrying the reason was gone. The editor rendered it as ordinary text with
    nothing marking a cut; only counting the characters revealed it. By then the
    operator's own words were unrecoverable, because the slice ran at WRITE time and what
    it removed was never stored anywhere. A person had to finish the sentence by hand,
    guessing at what had been meant.
    This is the write-side member of the family ruling 283 and ruling 285 close on the
    read side, and it is the worst of the three: those clipped what a run could SEE, this
    one clipped what a task permanently SAYS. So it is refused at authoring time instead —
    ruling 139's rule applied to prose. The refusal names the field, both numbers, and
    that nothing was written, and it says what to cut first: narrative and worked examples
    before a deliverable or an acceptance criterion, with the overflow belonging in the
    packet's own text or a comment, neither of which has a limit. The operator can shorten
    and re-offer inside the same turn; a truncated contract cannot be repaired by anyone
    who does not already know what it said.
    Ruling 138's cap itself stands — an unbounded goal is its own problem. What changes is
    what happens at the boundary, and a goal exactly AT the limit is accepted whole.
    (`operator-actions.server.ts`.)

289. **`read_board`'s excerpt says it is one (2026-09-15, pass 37; F37-124, completes 281).**
    The board read handed back another task's goal as a bare `.slice(0,
    BOARD_READ_GOAL_CHARS)`, so a long contract came back ending mid-word and read as the
    whole of it. Found by the controller, which reported a goal arriving "cut off mid-word"
    and — correctly — said it could not tell from where it sat whether the READ was
    truncating or the stored text was damaged. The stored text was intact; the reader was
    the one clipping, and it said nothing.
    Worth recording plainly because of where it was: in the reader ruling 281 shipped
    THIS MORNING, written by the same author who spent the afternoon closing exactly this
    shape on a knowledge base (283), an agent report (285) and a goal draft (288). The
    habit of capping a field and moving on is not a thing other people do.
    The cap stays — this is the SHALLOW read of the tasks beside your own, and a second
    task's whole contract competing with the reader's own prompt is what it prevents. What
    it now says is how long the goal really is, that what was returned is its opening, and
    where the whole of it lives: the task's own page. No "read the rest" tool is named,
    because there deliberately is not one. A goal that FITS carries no marker at all — a
    whole contract claiming to be an excerpt sends a reader looking for text that does not
    exist. (`board-read.server.ts`.)

290. **A card that counts exceptions names them (2026-09-15, pass 37; F37-125, ruling 253
    for a dashboard).** Three cards on `/insights` report a count of EXCEPTIONS —
    delivered work that cannot be traced, active work with no definite next actor, records
    past their project's readability guardrail — and each named none of them. Live this
    pass, on a real board: "98% · Branch & PR traceability · 41 of 42 delivered tasks carry
    branch + PR". The whole point of that number is to find work nobody can trace, and it
    would not say which task. The query already had the rows; it counted them and threw the
    identities away.
    Ruling 253 settled this exact shape for a knowledge base — "the NAMES, not just the
    counts. An agent cannot ask for a rule it cannot name, and a human debugging 'why did
    the run ignore the standing correction' had nothing to read." A dashboard is that rule
    with a person reading it, and a metric a person cannot act on is a metric that only
    grades them.
    Each of the three now carries its exceptions by key, linked to the task page, capped at
    {@link INSIGHTS_NAMED_EXCEPTIONS} so one card cannot become a wall on a drifted
    instance — and past the cap the card says how many more, so a capped list never reads
    as the whole set. A card that names everything it counts shows no remainder.
    (`insights-query.server.ts`, `insights-page.tsx`.)


191. **Everyone who plans against the shell is told what the shell contains (owner,
    2026-09-13, pass 37; F37-13).** Pass 37's host had `node`, `npm` and `git` and
    nothing else. The controller chose a pnpm + turbo monorepo with a root `Makefile`
    and a Docker Compose stack, wrote that into the project's architecture knowledge
    base ("`make up` must: build the workspace, start Postgres + Redis, run every
    service's migrations…"), and chartered a REQUIRED reviewer whose pass opens "Cold
    start. Clean checkout of the task branch, `make up`, everything healthy" and ends
    "Report `approve` only when the stack came up cold". On that host the reviewer could
    not return anything but `request_changes` — and it did, twice, on a document-only
    task the Code Reviewer had already approved, after which the coordinator sent the
    DELIVERER back to edit a document that was never the problem. Agents rediscovered the
    same absences one at a time: 75 `command not found` lines in a single pass
    (`pnpm`, `corepack`, `make`, `curl`). Viberr had measured the inventory since ruling
    182 — G36-2 asked it for exactly this, "what an agent's shell would actually find
    here" — but the reading covered five tools (node, npm, git, python3, go), omitted
    every one the build contract was written around, and was reachable ONLY through the
    controller's opt-in `instance_health`, which it never called. The agents whose shell
    it is could not see it at all, and neither could the operator. So: the probe grows
    `make`, `docker`, `pnpm`, `yarn` and `curl` — the ones a run reaches for first and
    cannot install — and the reading goes into the system prompt of every specialist run,
    every operator run and every controller turn, unasked. The advice half is not
    decoration: `npx` genuinely rescues an npm-published tool and nothing rescues one the
    operating system was meant to provide, so the two must not read alike, and the
    paragraph closes by telling a reviewer that an unrun check is not a pass and is not
    the deliverable's fault. BOTH halves of that advice are derived from the reading rather
    than written down — a hardcoded pair of sentences lies twice over, once by promising
    `npx` on a host with no npm, and once by naming an installed tool as its example of
    something uninstallable, which is exactly what ruling 196 made of `make` and `curl` the
    same day. An inventory you must know to ask for is not a fact the planner has.
    (`toolchain.server.ts`, `specialist-run.server.ts`, `operator-run.server.ts`,
    `controller-run.server.ts`.)

192. **A retry rebuilds the work from the task that failed, not from the link's frozen
    copy (owner, 2026-09-13, pass 37; F37-15, amends ruling 155).** Ruling 155 settles an
    ACTIVE link's title and goal in the goal file the moment work starts — correctly: a
    goal edit must not redirect work in flight. The TASK's title and goal are not settled
    by anything: a decision packet (ruling 189), an operator's `set_goal`, or a person
    rewrites them whenever the contract moves. So the two copies drift, and pass 37's
    board drifted far: `goal-2` link 1 still said SHOP-2 owns `packages/contracts` and
    publishes the identity schemas there, while SHOP-2's own goal — rewritten when the
    controller gave that ownership to SHOP-9 — said it must not edit `packages/contracts`
    at all. `retry_link` then rebuilt the task from the link, so the correction everyone
    had been working to was dropped, silently, at the worst possible moment. A retry now
    carries the failed task's own title and goal, with the chain header rebuilt rather
    than stacked (the link count and the previous link's carrier have both moved on), and
    the goal's timeline says when it did: a silent substitution is the defect in either
    direction. A FIRST start is unchanged — there is nothing to carry. Two more arms on the
    same drift: `getGoalView` — the DETAIL read a planner acts on, and `get_goal`'s payload —
    carries `liveGoal`, the task's current goal, whenever it has moved past the declared text
    (the declared text stays: it is what the chain declared and what the history means; only
    the goal, because a task's TITLE is immutable and a `title` half would be a field nothing
    can set). And a chain can now be RENAMED, title and description, while it is not terminal:
    pass 37's `goal-2` still read "Identity and Catalog services" hours after catalog moved to
    its own chain, and the only correction on offer was to cancel the chain and rebuild every
    link. The rename says what it does not reach — link tasks created before it keep the old
    name in their chain header, written at create time and never re-read.
    (`goal-actions.server.ts`, `controller-toolkit.server.ts`.)

    *(Corrected 2026-09-15 by ruling 267: "while it is not terminal" was symmetry with the
    other ops, not a reason, and it left this ruling's own motivating example unfixable —
    see 267.)*

193. **A reviewer that cannot pass is a decision, not a defect (owner, 2026-09-13, pass 37;
    F37-14).** The turn doctrine had exactly one answer to a request-changes: "the deliverer
    owes NEW work — `run_agent` the delivering profile with that steer as its prompt." A
    reviewer can request changes for a reason no revision can satisfy, and pass 37's did:
    a required Integration Verifier chartered to bring a Docker stack up, on a host with
    neither `make` nor Docker, reporting in its own words "an environment/repository-baseline
    blocker, not a discovered document-scope defect". The coordinator followed the doctrine
    and sent the deliverer back to rework a one-file document, round after round, past the
    point where a second reviewer had already approved the same revision. Two things were
    missing. The operator's snapshot showed only the CURRENT revision's verdicts, so every
    round looked like the first — it now carries `consecutiveRequestChanges` per reviewer,
    counting REVISIONS and not verdict rows (a reviewer re-run on the same revision has
    objected once, and inflating that would read a retry as an escalation), reset by that
    reviewer's first `approve`. And the doctrine gains the arm it lacked: at two or more,
    ask whether the deliverable can satisfy the objection AT ALL, and when the reviewer
    names something outside the work — a tool the shell inventory says is absent (ruling
    191), a baseline the repository does not have, a decision nobody has made — say so in
    one comment and `open_packet`, naming the three real exits: drop or replace the
    required reviewer, accept past the gate, or fund the missing baseline as its own task.
    (`operator-actions.server.ts`, `operator-run.server.ts`.)

194. **A retry that starts nothing says so (owner, 2026-09-13, pass 37; F37-16).**
    `startLinkTask` declines silently when the chain is no longer active, and the reconcile
    fired by the very archive that failed the link is fire-and-forget — so it lands in that
    window as a matter of course. The redirect had already committed "Link N retried by X"
    to the goal's timeline. The result was a record of a retry that created no task, over a
    link still marked failed, with the creator never told; the sibling THROW arm had carried
    exactly that correction since it was written, and the decline had no arm at all. A
    declined retry now re-parks the chain to `attention`, notes the link ("The retry did not
    start: the chain was redirected while it ran."), records the decline in the goal's
    timeline naming what to do (retry it again), and notifies the creator. Found while
    proving ruling 192, not by reading the code: the ruling-192 test could not get a retry to
    produce a task until the archive hook was allowed to settle first.
    (`goal-actions.server.ts`.)

195. **A refusal always leaves `waiting` honest — the packet arm included (owner,
    2026-09-13, pass 37; F37-17).** The open-packet refusal skipped its settle on a stated
    invariant: "The packet already owns `waiting: "human"`, so there is no settle to do
    here." It is not an invariant. A packet opened MID-WORK does not stop the machine
    triggers — by design, ruling 17 and the `agent-reply` arm depend on that — so on SHOP-6
    the operator kept coordinating after its architect asked "Lockfile ownership", moved the
    task through review and back, and dispatched the deliverer again: `waiting: agent`. Then
    the server restarted. Boot finalized that orphaned run and re-invoked the operator with
    the `manual` trigger, straight into this refusal, which returned without settling. The
    result was a task at `waiting: agent` with no run alive, every trigger refused ("Operator
    not started · resolve the open decision to continue"), a decision nobody had been told
    about, and ten downstream tasks held behind it — for 75 minutes, while the board said an
    agent was working. The closed and blocked-by arms have always settled for exactly this
    reason; this one does too. The call is a no-op unless the flag is `agent` with nothing
    live, and with a packet open `clearWaitingToHuman` settles to `human`, which is the
    packet's own owner.
    (`operator-run.server.ts`.)

196. **The image ships `make`, `curl` and a pinned `pnpm`; Docker stays out (owner,
    2026-09-13, pass 37; answers F37-13's other half).** Ruling 191 stopped agents
    rediscovering the toolchain one exit-127 at a time. This closes the part of the gap
    that is cheap to close: the three a run reaches for first and cannot install for
    itself. `pnpm` comes from npm, not corepack — Node unbundled corepack and pass 37
    logged `corepack: command not found` beside the pnpm one — and it is ONE pinned
    version; a repository pinning a different one in `packageManager` reaches it through
    `npx pnpm@<version>`. Docker is deliberately absent and this ruling does not open that
    door: an agent holding the daemon socket controls every container on the host, and
    docker-in-docker is a posture change that needs its own pass with its own ruling. So a
    Compose stack still cannot come up in this image, every run is told so by the shell
    inventory, and a reviewer chartered to bring one up is a charter that needs rewriting
    (ruling 193's arm is what surfaces that to a human rather than looping the deliverer).
    The owner chose this over re-platforming the pass-37 clone onto npm workspaces.
    (`Dockerfile`, pinned by `toolchain.server.test.ts`.)

197. **A template's persona is readable, and the tool says which fields an omission keeps
    (owner, 2026-09-13, pass 37; F37-18, completes F33-7).** F33-7 put the resource GRANTS
    into `list_global_agents` for a stated reason — "`save_global_agent` rewrites every field
    it is given and this was the only read of a template; the model had no way to see what an
    edit was about to replace, and the controller (rightly) refused to edit blind" — and left
    out the largest field of all. Two rulings later the same thing happened for the same
    reason: the controller needed to correct three template summaries that advertised
    Testcontainers, a Docker Compose stack and Playwright journeys on a host with none of
    them — text the OPERATOR selects agents by — and refused, saying "`save_global_agent`
    gives me no way to edit a summary without also supplying a persona, and I cannot read the
    personas I'd be replacing." The writer was innocent: a blank persona has always kept the
    stored one (`description: persona || existing.description`). The tool never said so, while
    the same paragraph spelled the merge rule out for skills, mcps and kbs — so the one field
    whose loss destroys an agent's whole system prompt was the one field left to inference, and
    a careful caller correctly refused to guess. `list_global_agents` now returns the persona,
    and both descriptions state the rule. Silence about a destructive default is not a neutral
    omission: it is the difference between an edit and a refusal.
    (`controller-toolkit.server.ts`.)

198. **Boot recovery does not promise a turn it has already decided not to take (owner,
    2026-09-13, pass 37; F37-19, the other door into ruling 195's defect).** The restart note
    was written for every orphaned task and ended "and the operator is re-invoked to decide
    what to do next" — written BEFORE the crash-loop cap (F7-BOOT1) had even been evaluated.
    So a capped task carried a promise Viberr had structurally decided not to keep, kept
    `waiting: "agent"` with no agent alive, and nothing ever revisited it: the cap logged a
    warning to the server's own log and stopped. Live, SHOP-7 sat exactly there for **two
    hours** — `readiness: ready`, `waiting: agent`, zero runs — while the board card and the
    review queue both said "agent working" and the timeline said a turn was coming. The cap
    itself is right; it exists so a boot→orphan→crash loop cannot re-run paid coordination on
    every restart. What was wrong is that firing it was invisible. The decision is now taken
    first, and a capped task gets the honest half of the sentence (what Viberr decided, why,
    and that running the operator from the page is the way on), a `waiting` flag settled off
    `agent` by the same `clearWaitingToHuman` ruling 195 uses, and a notification to its owner.
    A guard that fires in silence is indistinguishable from a system that forgot.
    (`run-recovery.server.ts`.)

199. **A settled run's transcripts stay findable: Viberr re-points the index it invalidated
    (owner, 2026-09-13, pass 37; F37-20, amends ruling 181).** The Codex CLI writes each
    rollout THROUGH the run home's `sessions` symlink, so the bytes land in the person's
    shared home and survive the run — exactly as ruling 181 intended. But the CLI records in
    its own thread index the path it SAW, `…/codex-home/runs/<runId>/sessions/…`, and ruling
    181 removes that directory when the run settles. So every later `thread/resume` answers
    `no rollout found for thread id … (code -32600)`, and Viberr passed that to a human as
    "**the agent's stored Codex session no longer exists**" — about a transcript sitting one
    path segment away, in a directory Viberr had deliberately preserved. Measured on the live
    instance: **137 of 137** threads recorded under a per-run home, **135** of those paths
    gone, and **135 of 135** of their files present at the shared path. Every Codex
    conversation the instance had ever held was unresumable; all three of the pass's run
    errors were resume attempts, each costing a run, an error state, an operator turn, and
    twice a decision packet put to a person. Viberr's OWN graceful recovery never fired, and
    the reason is the finding in miniature: `resumeRun` probes the stored id with
    `probeSessionContinuity` first and, on `missing`, starts fresh with a canonical anchor and
    tells nobody — but the probe looks in the SHARED `sessions/` tree, where the bytes really
    are, so it answers `present` every time. Two halves of Viberr disagreed about where a Codex
    transcript lives: the probe and the exporter were right, and the CLI's index was pointing at
    a path Viberr had deleted. The repair belongs in the path that broke the agreement. Ruling 181 fixed a real race (F36-3) and broke
    conversation continuity for every Codex agent on the way past, invisibly, because the
    failure wore the provider's name. The settle now re-points that run's threads at the
    shared path before the directory goes, and a boot pass repairs the ones already stranded.
    Both are fail-soft against a vendor artefact whose file name carries a schema version
    (`state_5.sqlite`): the shape is PARSED, never asserted, an unrecognised one is skipped
    whole, a path is only ever moved onto a file that is really there, and a run still in
    flight owns its own path until it settles.
    (`user-homes.server.ts`, `boot.server.ts`.)

200. **Seven corrections the pass's own adversarial self-review found in rulings 186–199
    (owner, 2026-09-13, pass 37).** A 12-cluster, 136-agent review of this pass's diff, each
    finding put to three diverse skeptics prompted to REFUTE it, produced seven that survived
    — all in the fixes, none in the original findings. They are recorded as one numbered
    ruling because they share a lesson: a fix written to stop a lie can tell a smaller one.
    (a) **Ruling 187(b)** — `compare` is an AHEAD-only list, so a MERGED branch answers with
    an empty one and `droppedCommits: 0`, and the carve-out then stamped every cached commit
    `pushed: false`: the record announcing that origin lacks commits sitting in `main`, this
    ruling's own prohibited lie inverted. It never fired live only because Viberr deletes the
    branch after merging, and that delete is best-effort. A landing now ends judgement —
    stamps already written stand, nothing new is claimed — and the file's own `pr.state`
    counts, because a failed API read knows less than the record does.
    (b) **Ruling 192(b)** — `edit_link` explicitly accepts a FAILED link, and ruling 192's
    retry carried the failed task's text straight over that edit, so the edit-then-retry
    sequence `update_goal` advertises in one breath silently discarded the correction. A
    `redeclared` flag makes the explicit re-declaration win, and the timeline says which
    source a retry used in BOTH directions.
    (c) **Ruling 194 was dead code.** A failed link keeps its task key — `reconcileGoal` names
    that task in its own note — so the `taskKey !== null` guard returned before doing anything
    on every real path, and the test that "proved" it built a null-key failed link the product
    cannot produce. The arm now compares against the key the link had BEFORE the retry, and
    its test uses the state the product actually reaches.
    (d) `liveGoal` compared against `link.goal` while the task was built from
    `link.goal || link.title`, so a title-only link read as permanently drifted.
    (e) The rename clause fired whenever a caller RESENT the current title, claiming a rename
    that never happened — the same defect its own earlier fix had half-closed.
    (f) Ruling 198's note said "Nothing further happens on its own", which is not this loop's
    to promise: `recoverUnreactedAgentRuns` can still run an `agent-reply` turn on that task
    later in the same boot, under its own cap.
    (g) Ruling 199's comment promised a log line for an unrecognised vendor schema and emitted
    none, and its test passed with the guard deleted. Both skips now say so, and the test
    asserts the sentence rather than the return value.
    Two of the seven were VACUOUS TESTS that had "gone red" on demand — (c) and (g) — which is
    the sharper lesson: a canary is only evidence when the state it constructs is one the
    product can actually reach.
    Three more came from findings the panel REFUTED **on scope** — the review's base commit sat
    after rulings 186–189, so day-one code read as "not in the diff" even where the correctness
    lens upheld the claim. A vote is not a verdict, and re-checking them by hand found two real:
    (h) ruling 189's stated exclusion is "a resolution that ENDS the task", and `acceptsInto`
    catches only ONE of the two doors that do — `force_accept` closes the task through
    `forceAcceptCompletion` and never assigns it, so a task being closed in the same breath
    still collected a contract amendment binding work it will never have; and `block_on_policy`
    ("the label promises an UNBLOCK … 'I fixed the credential, carry on'") is a recovery choice
    that belongs beside `redirect` in the process-only set and was missed when that set was
    written. (i) The ruling-193 arm named `open_packet` — the CODEX plan action — while the
    SHARED doctrine says `open_decision_packet` in every one of its four other places, so a
    Claude operator was told to call a tool it does not have. The third, "the @mention resume
    door bypasses the hold gate", was correctly refuted: `commentToAgent`'s resume arm already
    carries `assertDispatchNotHeld`, added with ruling 186 for exactly that reason.
    (`github-reconciler.server.ts`, `goal-actions.server.ts`, `goal-file.schema.ts`,
    `run-recovery.server.ts`, `user-homes.server.ts`, `task-actions.server.ts`,
    `operator-run.server.ts`, `runbook.md`, `deployment.md`.)

201. **A share is a measurement only when every run it claims to describe reported one;
    short of that, the card says so and offers the unit both backends DO report (owner,
    2026-09-13, pass 37; F37-21).** Ruling 190 guards the EMPTY case — a side that ran and
    reported nothing — and its test is satisfied the moment ONE run on each side reports.
    The partial case is the same defect and it is the ORDINARY one, because cost is a
    Claude-only observation: `costUsd` is assigned off the Claude result envelope, and the
    Codex envelope carries token counts with no price. On the live instance when this was
    written, 209 of 215 runs and 94% of the tokens reported no dollar figure; the card was
    honest only because the delivery fleet happened to be silent *entirely*. Put one Claude
    deliverer on that instance — an ordinary act — and the card divides 6 costed
    coordination runs by a denominator the other 137 never entered and prints a confident
    **27%** where the truth is likely north of 90%. That is worse than ruling 190's 100% in
    one specific way: a degenerate quotient can be spotted by noticing it is degenerate,
    and this one varies with the data and is wrong anyway. It is not even a bound —
    unreported delivery spend pushes the ratio down, unreported coordination spend pushes
    it up. So the dollar share is null unless EVERY run on both sides reported a cost, and
    the suppressed card gives the dollars that are real plus the count and the BACKEND of
    the runs that are not ("169 of 215 runs report no cost (169 on Codex)") — F35-1 already
    counts the rows its token sums leave out so the card can name them, and `agent_runs.backend`
    makes the same disclosure specific here. The hedge it replaces, "reported by
    cost-reporting runs", names no quantity and reads as "all". Suppression alone would
    leave an ordinary instance with a permanently blank card, so the owner's call pairs it
    with a second card: **coordination's share of TOKENS**, the unit both backends report,
    labelled as tokens on its face because a luna-max token and an opus token are not the
    same money. The token share carries ruling 190's test at its own level — a side that
    ran and landed no final provider figure at all has no token share either — and it
    discloses F35-1's excluded rows rather than suppressing on them, because that gap is
    incidental (an interrupted run) rather than systematic to one backend.
    **Ruling 190 is amended, not reversed:** its distinction between *reported nothing* and
    *never ran* still decides both cards, and a side that never ran still contributes a real
    zero. What goes is its `unobserved` enum, which could not express "partly"; the card now
    reads per-side run and uncosted counts and writes the sentence from them.
    (`insights-query.server.ts`, `insights-page.tsx`.)

F36-6 (pass 36, amends F19-1): Viberr's own delivery next-step card is written only for
a verdict-clean revision (`healthy`, or a project with no verdict-capable specialist); a
`failing` or pending verdict withholds it with a `github.delivery.next_step {withheld}`
audit row, and a request-changes verdict drops any pending transition card the same way
it already dropped the accept offer. "Review stage" in that writer is the stage with an
edge into the terminal one, so a task AT its verdict stage was "strictly before" it.

*(Documentation drift closed by pass 35, recorded 2026-09-07. The pass-35 discovery read
found five places where a page or a sentence said something the code did not. Each is
corrected on the page named; the note stays here so a reader who meets the old wording, in
a ledger or in an older branch, can see when it stopped being true. Drift ids are the
discovery index's, `planning/discovery-2026-09-06-pass35-k9s-clone/reference/INDEX.md`.)*

- **D14** — `docs/README.md` said the controller had "38 tools" while 39 were registered
  and `controller-and-goals.md` said 39. Ruling 153 adds `schedule_task_action` and
  `cancel_task_schedule`, so the number is now **41** and both pages say it; the count is
  `grep -c "^  add(" app/server/controller/controller-toolkit.server.ts`.
- **D22** — `docs/architecture/data-model.md`'s `instance_settings` row named quota keys the
  writer never used. It now names the three live keys as `backend-quota.server.ts` writes
  them (`backendRateLimit.<backend>`, `backendQuotaExhausted.<backend>` with `resetsAt` and
  its `resetsAtPrecision`, and `backendCredentialRefused.<backend>`), each carrying the
  account it billed since ruling 130(d).
- **D40** — no page said `users.github_handle` had exactly ONE writer, GitHub OAuth
  sign-in, so ruling 68's human-approval verdict was unreachable on a deployment that signs
  in locally. Ruling 154 gives the column its second writer and the org admin's door;
  `github-delivery.md` §10 records the correction, and §5 now lists every writer.
- **D88** — the `unlinked_handle` refusal told people to "link it on their profile", while
  the profile card on an OAuth-less deployment offered nothing to connect. Ruling 154's
  sentence names both doors: Org settings, Users & access, and the profile where GitHub
  sign-in is configured.
- **D97** — the stage-eligibility refusal printed the raw stage id (`impl`) where a person
  reads a name. `stageRefusalSentence` (`app/server/tasks/specialist-run.server.ts`) resolves
  both the task's stage and the profile's declared stages through the board, which is also
  what makes F35-5's "Mention not started" timeline note readable.

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
