# Intent vs implementation (audit, 2026-07-25)

Base: `main` @ c7abebf, after pass 13. Read-only audit. No product code, test or data was
modified.

## 1. How to read this

Viberr was built from four intent documents: `planning/planning-artifacts/prd.md`,
`architecture.md`, `ux-design-specification.md`, and the HTML design mock under
`design/html-app/`. Thirteen passes have since changed the app, often on purpose. This
report checks the built app against those documents and sorts every divergence into three
buckets.

- **DRIFT** — the app does not do what the intent says, and nobody is on record deciding
  that. No finding-id comment, no ruling in a `planning/discovery-*/FINDINGS.md`, no
  explaining docstring. This is section 2 and it is the part that needs you.
- **DELIBERATE** — a pass changed it on purpose, with evidence. Section 3. These are not
  bugs; they are listed because in most cases the *source document still states the old
  intent*, which will mislead the next implementation subagent that reads it.
- **UNCLEAR** — the evidence does not settle it. Section 4, with what would settle it.

Every claim below survived a second adversarial verification pass against the code.
Anything pass 13 already fixed is excluded. Refuted claims are in section 5 so a later
pass does not re-raise them.

Severity uses the pass-13 ledger scale: **HIGH** correctness / security / data-loss /
feature unusable · **MED** wrong behavior, dishonest UI, degraded UX · **LOW** polish,
noise, dead code.

---

## 2. DRIFT — needs an owner decision

### 2.1 HIGH

#### D-1 · FR6 — workflow transitions cannot be created or deleted

> FR6: "Admin users can define workflow stages, allowed transitions, and approval
> boundaries for a project." (`prd.md:212`)

Two of three clauses ship. Stages: `addStage` / `renameStage` / `removeStage` /
`reorderStages` are real. Boundaries: `setTransitionBoundary` flips an existing rule.
**Transitions: there is no create or delete path anywhere** — no server function, no route
intent, no UI. The only writer that grows `frontmatter.workflow` is project creation
(`presetWorkflow`, re-mapping the template's 4 fixed rules); the only other writer deletes.

- `app/features/project-settings/settings-actions.server.ts:173-206` — `addStage` mutates
  `frontmatter.stages` only (splice at :193); never touches `frontmatter.workflow`.
- `app/features/project-settings/settings-actions.server.ts:246` — the sole shrink path.
- `app/features/policy/policy-actions.server.ts:191-207` — `workflow.find`, then throws
  `No transition rule from X to Y.` at :195.
- `app/features/home/project-create.server.ts:41` — `presetWorkflow`, the only growth path.

Hurts: an admin who adds a 6th stage gets a column no governed flow can reach.
`transitionStage` refuses it except as a manual admin/maintainer move
(`app/server/tasks/task-actions.server.ts:2519-2523`), and the operator's `nextStages` is
built purely from `workflow` (`app/server/tasks/operator-actions.server.ts:753-757`), so it
is empty — no agent can enter or leave that column. The UI actively lies about it: Settings
says "Who may move tasks between stages is set in Policy → Workflow rules"
(`settings-page.tsx:314-319`) and Policy draws an arrow between every consecutive stage
pair from stage *position* (`policy-page.tsx:355-367`) while the rule list below stays at 4.

Recommend: **owner decision**. Either build add/remove-transition (Policy page), or narrow
FR6 to "stages + boundaries", delete the Settings pointer, and derive the Policy flow map
from `workflow` rather than stage order so it stops depicting a path governance lacks.

#### D-2 · PRD-1 / FR22 / UX-1 — runtime continuity recovery does not exist

> "If provider-side history is unavailable or corrupted, the system degrades gracefully
> from the canonical task file and current execution context." (`prd.md:120`)
> NFR17: "…or fail explicitly when continuity cannot be maintained." (`prd.md:288`)
> FR22 (`prd.md:236`), Journey 4 "Murat Investigates Runtime Continuity Failure"
> (`prd.md:87`), and the UX spec's Continuity Recovery Panel
> (`ux-design-specification.md:649-658`, states + anatomy) and `degraded continuity` state
> (`:722`, filter at `:841`).

Nothing implements it, on any layer.

- **No probe.** `resumeRun` passes the stored session id straight to the SDK —
  `app/server/runtimes/run-service.server.ts:506` (`resumeSessionId: prev.session_id`).
  The repo has a cheap probe, `transcriptExists`
  (`app/server/runtimes/session-export.server.ts:171`), whose only caller decides whether
  the *Export button* renders (`app/server/runtimes/run-projection.server.ts:148-156`).
- **No explicit failure.** Failure kinds are `quota | auth | unavailable | max_turns |
  idle_timeout | unknown` (`app/server/tasks/agent-reply.server.ts:398-406`);
  Codex's are `quota | auth | idle_timeout | unknown`
  (`app/server/runtimes/codex-runtime.server.ts:296`). A dead session id lands as
  `unknown` → generic "Codex execution failed. Review its authentication and runtime
  configuration." (`:340-344`) → a blocked packet with **no recovery option**, since
  `backendFailure` covers only quota/auth/unavailable.
- **No fallback.** Nothing retries the turn as a fresh canonical-anchored run.
- **Permanently stranded.** The failed run row persists the dead session id
  (`run-service.server.ts:296`, `run-sink.server.ts:126-142`) and `latestSessionRun`
  filters on profile/kind/backend with no state filter
  (`app/server/tasks/agent-reply.server.ts:138-157`), so every later @mention re-selects
  the same dead id.
- **No UI.** Three "continuity" hits in the whole UI: a red pill label
  (`app/features/runtime/runs-helpers.ts:20`), a logs footer string
  (`runs-panels.tsx:415`), and a hardcoded static cell "Continuity — Re-anchors on
  task.md" (`app/features/agents/agents-page.tsx:552-560`). No panel, no
  `degraded continuity` readiness value (`app/schemas/task-file.schema.ts:25-30`), no board
  filter (`app/features/board/board-filters.ts:7`), no row on the Execution Truth Strip
  (`task-detail-page.tsx:148-250`).

Hurts: Journey 4 is unimplemented end to end. When a provider transcript is gone (Claude
Code's ~30-day retention, or a `docker-data` wipe taking `$CODEX_HOME/sessions` with it),
the user gets a misleading auth error, no continuity warning, and no way to resume that
agent on that task ever again. The product asserts the opposite guarantee to the user at
`agents-page.tsx:553-559`.

Mitigation to weigh: the UX spec puts the Continuity Recovery *Panel* in its own Phase 3
(`ux-design-specification.md:701-706`), so the missing panel is sanctioned sequencing. The
missing **mechanism** (FR22/NFR17) is not.

Recommend: **fix the code** (minimum: probe before resume, a `session_missing` failure
class, and a fresh canonical-anchored retry), then decide separately whether the Phase-3
panel ships in V1.

#### D-3 · PRD-2 — a resumed specialist never re-anchors on task.md

> "Persistent agent histories are useful but never the sole source of truth. / Any
> reactivated agent re-anchors on the canonical task artifact before acting."
> (`prd.md:118-119`; risk mitigation "canonical re-anchor rule", `:134`)

`specialistReplyDirective` is the entire prompt a resumed specialist receives on an
@mention: commenter name, task key, title, the raw comment text, a trust-boundary
paragraph and a delivery rule (`app/server/tasks/task-actions.server.ts:744-772`, built at
:859, passed as `prompt: followUp` at :898). `resolveResumeConfinement`
(`specialist-run.server.ts:1153-1243`) rebuilds denylist, env, MCP set, persona and
outcome envelope — confinement only, zero task state. Only the *fresh*-run prompt
`buildAnalyzePrompt` (`specialist-run.server.ts:1012+`) carries goal/branch. The Claude
toolkit exposes `post_comment`, `ask_human`, `report_outcome`
(`agent-toolkit.server.ts:200-330`) — no read-the-task tool, so the agent cannot fetch
canonical state on demand either. The operator, by contrast, gets a fresh
`operatorSnapshot` every turn (`operator-run.server.ts:617`, `:974`).

Hurts: edit a goal, then comment "@dev continue" — the resumed dev works the stale goal.
The product states the guarantee three times while breaking it: the per-profile
"Continuity: Re-anchors on task.md" row (`agents-page.tsx:553-558`), the goal-edit event
"downstream agents re-anchor on the new goal" (`task-actions.server.ts:541`), and the
`set_goal` tool description (`operator-toolkit.server.ts:114`). The shipped reviewer
persona is literally instructed to "Re-anchor on the canonical task goal before you judge
anything" (`app/server/seed/assets/reviewer.definition.md:15`) with no channel to do so.
Pass 13's own live case UC-30 observed this empirically
(`planning/discovery-2026-07-24-pass13/USECASES.md:156-159`).

Blast radius is direct human @mention resumes; the operator's own summon path
(`operatorPromptSpecialist` → `startAgentRun`) is a fresh run and is unaffected.

Recommend: **fix the code** — append a compact canonical block (goal, stage, readiness,
open packet, last N events) to `specialistReplyDirective`, or reuse `buildAnalyzePrompt`'s
context sections on the resume path.

### 2.2 MED

#### D-4 · FR27-b — the closed-PR guard covers 1 of 3 paths to Done

Pass-12 NEW-1 added: `acceptCompletion` refuses a closed-unmerged-PR task
(`app/server/tasks/task-actions.server.ts:3471-3480`). Two other paths write
`stage = done` **and** stamp `pr.state`, and neither checks it:

- `resolvePacket` `case "accept_completion"` inlines its own ~50-line accept
  (`task-actions.server.ts:3156-3213`); checks `acceptanceBlockedReason` at :3171, never
  `pr.state`; writes `fm.pr = { ...fm.pr, state: reallyMerged ? "merged" : "accepted" }`
  at :3210.
- `operatorAcceptCompletion`'s full-autonomy branch writes the file directly
  (`operator-actions.server.ts:1666-1689`), `pr.state = "accepted"` at :1675.
  `grep -c closed operator-actions.server.ts` = 0; `operatorSnapshot` exposes no `pr`
  field at all (`:764-818`), so the operator is structurally blind to PR state.

Hurts: a PR a human closed on GitHub (out-of-band rejection) is overwritten to `accepted`
and the task lands in Done. The `pr.state` overwrite self-heals on the next poll
(`github-reconciler.server.ts:237-241`), but `stage = done` is durable and the reconciler
never reverses it. In-product rejection (a reviewer `request_changes` verdict) *is* caught
on all three paths via `acceptanceBlockedReason`; the gap is exactly the `gh pr close`
rejection the owner hit live in pass 12.

Recommend: **fix the code** — hoist the `pr?.state === "closed"` check into a shared
guard used by all three writers, and add `pr` to `operatorSnapshot`.

#### D-5 · FR7 / FR30 / MOCK-1 — task-level repo override: no writer, inert toggle, false copy

> FR7: "Admin users can define a default GitHub repository for a project and allow
> task-level overrides." FR30: "…inheriting the project default unless overridden."
> Mock: `design/html-app/app/settings.jsx:211-217` ships a real "Task-level override" switch.

The read side is fully wired — `getProjectGithubContext` honors `repoOverride`
(`app/server/github/github-context.server.ts:56`) and 8 call sites pass `fm.repo`. Three
things are broken around it:

1. **Nothing ever writes `task.repo`.** `createTask` hardcodes `repo: null`
   (`app/server/tasks/task-actions.server.ts:451`); a repo-wide grep finds 8 reads and 0
   writes. None of the 20 task-route intents (`app/routes/project.task.tsx:249-628`)
   touches it. Task detail renders it read-only (`task-detail-page.tsx:971`).
2. **The admin toggle gates nothing.** `setRepoOverride` persists `taskRepoOverride` and
   audits `project.repo_override.changed`
   (`app/features/project-settings/settings-actions.server.ts:449-475`). Its only other
   references in the entire tree are the display read (`settings-query.server.ts:56,76`)
   and one test. No enforcement path consults it, so a hand-edited `repo:` wins in either
   position.
3. **Three surfaces assert the capability.** Settings: "tasks may attach a different repo"
   (`settings-page.tsx:539,550`). GitHub view, hardcoded regardless of the toggle:
   "project default · task-level override allowed" (`github-view.tsx:110-120`). Create
   modal: "task-level override later" (`home-page.tsx:479`) — the product contradicts
   itself. The schema restates the intent too (`task-file.schema.ts:391-392`).

Hurts: an admin flips a governance switch, gets a success toast and an audit row, and
nothing changes in either direction. The feature the PRD names is reachable only by hand-
editing `task.md` outside the app — and such a task authenticates with the *project's* PAT
(`github-context.server.ts:59`), so a cross-owner override fails auth with no diagnosis.

Recommend: **owner decision**, then one of: (a) build the task-level repo picker and
enforce the toggle; or (b) delete the toggle, fix the GitHub-view copy, and drop FR7's
override clause + FR30's "unless overridden". Do not leave it half-built.

#### D-6 · FR24 / UX-2 — the board card omits validation status

> FR24: "…each card showing current stage, assigned agent, waiting state (human vs agent),
> and **validation status**." (`prd.md:241`; repeated `prd.md:91`, `:184`;
> `ux-design-specification.md:85`, `:304`)

`grep -c validation app/features/board/board-page.tsx` = **0**. The card renders key,
`ReadinessPill`, title, owner/reviewer, branch chip, PR chip, wait tag
(`board-page.tsx:120-224`); the list row is the same set (`:378-411`). The pill cannot
stand in: `displayReadiness` only adds accepted/merged (`app/shared/mapping/task.server.ts:233-237`)
and `deriveReadiness` folds only parse diagnostics (`readiness-policy.server.ts:36-48`).
The data is already on the card (`task.server.ts:110,240`) and `ValidationPill` already
exists (`app/ui/pill.tsx:98`, used on task detail `:463` and the review queue
`review-page.tsx:55`). Its only board consumer is the *filter* predicate
(`board-filters.ts:32`).

Hurts: a reviewer's `request_changes` sets `validation: "failing"`
(`task-actions.server.ts:1524-1531`) and touches nothing the card draws — so a rejected
revision is visually identical to a healthy one. Click "Needs attention" and cards appear
wearing a green `ready` pill with no indication of why they matched. The board hides the
signal and filters on it.

Origin worth knowing: the HTML mock's card omits it too
(`design/html-app/app/board.jsx:47-72`), so the port inherited the gap — but this team
records mock departures when it makes them (e.g. `branch-sync.server.ts:12-14`), and
nobody adjudicated this one.

Recommend: **fix the code** (add `ValidationPill` to card + list row when
`validation !== "none"`), or amend FR24 and the UX spec to drop the field.

#### D-7 · FR33-a — two governance audit actions surface nowhere in the app

`AUDIT_ACTION_KINDS` is a 25-entry whitelist
(`app/server/projections/activity-feed.server.ts:113-139`) driving both the list
(`:326-334`) and the count (`:277-284`). Two recorded, project-scoped governance rows are
not in it:

- `task.acceptance.forced` — the admin override that bypasses the review gate, written
  with `details: { bypassed }` at `app/server/tasks/task-actions.server.ts:3584-3592`.
- `project.org_admin.override` — carries a `projectSlug`
  (`app/server/auth/project-authority.server.ts:129-141`).

`audit_events` has no other product reader (policy-query's last-change lookup and
run-recovery's crash counter aside), so both are invisible in the product. The module's own
docstring claims the whitelist covers "every project-scoped governance action family"
(`:22-24`). `git log -S AUDIT_ACTION_KINDS` shows nobody revisited the panel when
`task.acceptance.forced` landed in pass 12 (35744ca).

Hurts: reconstructing "who bypassed the required reviewer, and why" needs direct SQLite
access — the thing the audit view exists to make unnecessary.

Recommend: **fix the code** — add both actions (and a default label) to
`AUDIT_ACTION_KINDS`.

#### D-8 · FR33-b / PRD-4 — denied actions leave no audit trace

> NFR10: "Security-relevant actions (policy changes, credential failures, **unauthorized
> action attempts**, and human approval actions) must be recorded in audit records."
> (`prd.md:275`)

Three of four categories are covered. Unauthorized attempts are not.
`resolveProjectAuthority` audits the org-admin **grant** (`project-authority.server.ts:128-142`)
but the deny branch is a bare `return { allowed: false, memberRole }` (`:145`);
`requireProjectAuthority` throws at `:164-169` and `assertProjectAction` at `:273`, both
silent. There is no central hook: `appErrorResponse` (`form-action.server.ts:21-27`) and
the route gate (`require-project.server.ts:38-44`) convert `AppError` straight to a
response. Across all 158 non-test `recordAudit` sites there is no `*.denied` /
`*.forbidden` / `*.unauthorized` action name. Because `requireAction`
(`task-actions.server.ts:290-305`) and `requireRunAgents` delegate here, every denied task
mutation, runtime start, policy edit and merge is silent.

Adjacent classes *are* covered (`auth.login.failure`, `auth.login.rate_limited`,
`github.scope_violation.opened`, `github.pr.merge_refused`) — the uncovered class is
precisely this app's own RBAC/membership denial.

Hurts: a user or compromised session probing above its role produces a clean audit log.

Recommend: **fix the code** — one `recordAudit` in the deny branch of
`resolveProjectAuthority` plus the `assertProjectAction` throw, with the attempted action
and role in `details`.

#### D-9 · MOCK-3 — the Review queue still promises human-only Done

> Mock: header chip "Review → Done · human only" and footer "Accepting a completion merges
> the review PR and moves the task to Done — **always a human action**"
> (`design/html-app/app/review.jsx:42,57`).

Both strings ship **unconditionally**: `app/features/review/review-page.tsx:113-123` and
`:151-161`; the loader passes only `stageNames` (`app/routes/project.review.tsx:41-48`),
so no policy or autonomy signal reaches the page. Under the `auto` preset an operator
closes tasks itself (see §3, D-3/PRD-3). Two surfaces were updated to disclose the
exception — the create modal (`home-page.tsx:558-568`) and the Policy note
(`policy-page.tsx:422-437`, commit 127721d "honest Policy copy for the Done boundary") —
the Review queue was not. Same absolute claim at `task-detail-page.tsx:298-302` ("Human
decision, locked at the review boundary") and
`app/features/org-settings/resources-panel.tsx:606` ("Done is human-only, always").

Hurts: the Review queue is the screen where a maintainer forms the acceptance belief. On
an Autonomous-preset project, tasks arrive in Done without them.

Recommend: **fix the copy** — pass the project's operator autonomy/grant into the review
loader and qualify the chip/footer, or state the exception inline as Policy does.

#### D-10 · UX-5 — failure toasts render the success tick

> "Error feedback must explain what failed, what remains true, and what the user can do
> next." · "Prefer inline state feedback over detached notifications."
> (`ux-design-specification.md:772-777`)

Pass 13 added `ToastKind` with the comment "a failure toast must not render a success
tick" (`app/ui/toast.tsx:24`; icon switch `:127`; default kind `"success"` at `:47`). The
fix reached 8 call sites. Both **shared helpers** were missed:

- `app/ui/use-action-toast.ts:18-19` — `const message = data.ok ? data.toast : data.error;
  push(message)`. 11 fetchers: project settings (`settings-page.tsx:774-779`), GitHub view
  (`github-view.tsx:322-324`), Policy (`policy-page.tsx:456-457`).
- `app/features/org-settings/use-org-action.ts:48-50` — `else if (d.error) push(d.error)`.

Plus four hand-rolled handlers: `board-page.tsx:957` (a **rejected stage transition**),
`task-detail-page.tsx:61`, `agents-page.tsx:823`, `store-browser.tsx:491`, and two missed
singles (`app/routes/notifications.tsx:65-69`, `users-panel.tsx:340`).

For settings/GitHub/Policy there is no inline surface at all (`grep .error` → 0 hits), so
the 2600 ms toast (`toast.tsx:30`) is the entire failure record. Colour is not the
differentiator (both kinds use `background: var(--fg)`, `app.css:1083-1092`) — the glyph
is, which is why the wrong glyph is the whole defect.

Recommend: **fix the code** — pass `data.ok ? "success" : "error"` in both shared helpers
and the four handlers; add inline error text to the settings/policy/GitHub forms.

#### D-11 · PRD-6 — the task page ships every run log line, uncapped

> NFR5: "Timeline rendering for long-lived tasks should remain usable **without requiring
> the client to load the full raw execution history at once**." (`prd.md:269`)

The *event* timeline is bounded — 30 newest with a `?events=` step-up
(`app/routes/project.task.tsx:96-99`, `app/features/task-detail/timeline-slice.ts:8-43`,
whose docstring cites the NFR). The same loader then ships every run log line and every
raw wire envelope with no cap: `listRunsForTask` (`project.task.tsx:124`) →
`projectRunsForTask`, which loops `listRunLines(db, row.id)` over **every** run in each
agent group (`app/server/runtimes/run-projection.server.ts:214-262`, loop at :256);
`listRunLines` has no `LIMIT` (`app/server/runtimes/run-store.server.ts:229-251`). The
only bound is the 30-day retention sweep. The incremental tail endpoint exists
(`resources.run-log.ts`, `?since=`) but seeds nothing — the console seeds from the loader
(`task-detail-page.tsx:1246`).

Measured: `pass13-selftest/PST-1` already carries 420 lines ≈ 928 KB of
`raw_json + display_json` after one day (PST-4 ≈ 612 KB, PST-6 ≈ 606 KB) — and
`project.task.tsx:157` revalidates on every SSE task change, so it re-ships each time.

Note: a fix must **paginate, not truncate** — pass 13's UI-53 deliberately widened the
console to the agent's whole history on the task (`run-projection.server.ts:239-243`).

Recommend: **fix the code** — cap the loader payload (newest N lines per group) and let
`/resources/run-log?since=` page backwards.

#### D-12 · PRD-14 — the light theme fails WCAG AA contrast in core workflows

> "Core workflows meet a **WCAG 2.2 AA baseline in V1**, with light and dark mode."
> (`prd.md:163`). The UX spec also requires "automated audits for semantic structure,
> contrast, focus, and ARIA issues" (`ux-design-specification.md:923`).

There is no axe-core, pa11y or Lighthouse dependency, no accessibility test file, and no
conformance record in `docs/`. Computing contrast on the shipped tokens resolves the
question against the app:

- `--faint: #828798` (`app/app.css:13`) = **3.58:1** on `#ffffff`.
- `--placeholder: #a5a8b5` (`:14`) = **2.37:1**.

Both are used for small text on `--surface` (`#ffffff`) in core surfaces:
`.opt .od` at .78rem (`app.css:820`) — the decision-packet option descriptions, the app's
highest-stakes control; `.obs .k` .7rem (`:801`); `.card-top .key` .72rem (`:668`), the
board task keys; `.tl-time` .72rem (`:941`). Dark theme passes everywhere measured.

The product asserts the opposite to the user: "Light and dark both hold the WCAG AA
baseline" (`app/features/profile/profile-page.tsx:386`).

Pass 13 found and fixed four AA defects by manual reading (landmark + skip link, five
toggle groups, a radiogroup roving tabindex, popover focus order) — evidence the baseline
has never been checked systematically.

Recommend: **fix the code** (darken `--faint`/`--placeholder` to ≥4.5:1 in light) and
**add a gate** — one axe-core run over login/board/task/review/policy in both themes,
recorded in `docs/`. Until then, remove the AA claim from the profile page.

#### D-13 · PRD-5 — cleartext-only transport, and no TLS instruction anywhere

> NFR6: "All authenticated application traffic and external service traffic must be
> encrypted in transit." (`prd.md:271`)

External calls are HTTPS. The app itself is HTTP-only: `Dockerfile:66` `EXPOSE 3000`,
`compose.yml:29-32` maps the port straight through, `react-router-serve` terminates
nothing, and no proxy config ships in the repo. `app/lib/auth.server.ts:143` says it
outright: "Viberr ships without a reverse proxy (Dockerfile + compose.yml run
react-router-serve directly)". `useSecureCookies` is never set (`:280` sets only
`cookiePrefix`), no HSTS header is emitted anywhere, and `docs/operations/deployment.md`
(all 152 lines) never mentions TLS, a proxy, HTTPS or `BETTER_AUTH_URL`.

Secondary trap: with `NODE_ENV=production` (`Dockerfile:33`) and `BETTER_AUTH_URL`
optional (`env.server.ts:44`), better-auth falls through to `isProduction` and mints
`__Secure-`-prefixed cookies with `secure: true`. That fails **closed** — correct
behaviour — but on a LAN/remote http host it produces a silent, unexplained login loop.

The repo also contradicts itself on topology: `auth.server.ts:143` says no reverse proxy,
while `env.server.ts:38-43`, `.env.example:31-32` and `boot.server.ts:80-91` all treat
"behind a reverse proxy" as the production deployment. `README.md:201-217` is an explicit
"Known gaps — deliberate scope boundaries" list and cleartext transport is *not* on it.

Recommend: **update the doc** — `deployment.md` must state that the app must be fronted by
a TLS-terminating proxy with `BETTER_AUTH_URL` set to the https origin, and name the
`__Secure-` cookie consequence of not doing so. Optionally add HSTS. Do not build TLS into
the Node process.

#### D-14 · PRD-0 — the PRD nominated as canon is the one that does not describe the app

`planning/README.md:3` declares `planning-artifacts/prd.md` "the current product planning
canon". Both PRD copies were committed together in 80ed201 (2026-07-04) **already
divergent**, and each is byte-identical to its import today. `design/prd.md` carries a
later revision line ("reviewer & commenting amendments 2026-07-04") and four substantive
changes the canon copy lacks: the FR4 amendment (app-wide commenting by non-members),
FR37 (per-task human owner), FR38 (self-service take/release), and the FR14 rewrite
splitting "primary specialist" from "human owner".

**The app implements the `design/` version.** `ownerUserId` is a first-class task field
(`app/schemas/task-file.schema.ts:373`), sitting directly above `engagements` (`:375`);
owner-take / owner-assign / owner-release are task-detail intents
(`app/routes/project.task.tsx:82`, handlers `:359/:371/:388`); `view`/`comment` carry
`appWide: true` (`app/shared/rbac.ts:48-49`) with the enforcement comment citing **FR4** —
an FR number whose amended text exists only in `design/prd.md`.

Worse, the canon copy states the *opposite*: `planning-artifacts/prd.md:178` "Primary
specialist owner plus persistent consultant specialists" and `:223` FR14 "one primary
specialist owner".

Hurts: any future audit, agent brief, or onboarding anchored on the declared canon will
read the human `ownerUserId` model as unplanned scope creep and may "correct" it back.

Caveat: FR37's *reviewer/acceptance authority* clause did not ship — `accept-completion`
is RBAC-gated to admin/maintainer (`rbac.ts:54`), not bound to the task owner.

Recommend: **update the doc** — fold the 2026-07-04 amendments into
`planning-artifacts/prd.md` (FR4, FR37, FR38, FR14), or declare `design/prd.md`
authoritative in `planning/README.md`. Note FR37's acceptance clause as not-implemented.

#### D-15 · ARCH-7 — the "Complete Project Directory Structure" omits six server modules

> `architecture.md:611` "### Complete Project Directory Structure"; `:1067-1076` "The
> structure is specific enough for implementation — server module boundaries defined".

Absent from the tree: `app/server/tasks/` (37 files, incl.
`task-actions.server.ts` at **3818 lines / 41 exports** — the app's largest server
module), `app/server/org/` (16 files), `app/server/audit/`, `app/server/seed/`,
`app/server/prefs/`, `app/server/theme/`, plus `app/server/boot.server.ts` loose at the
module root and the whole top-level `app/lib/` (better-auth wiring). The doc lists 6
feature folders; there are 16. `app/features/auth/` is prescribed with three components
and was never created — login lives in a 542-line route (`app/routes/login.tsx`).
`grep -c -i packet architecture.md` = 0, and "operator" appears once (`:1023`), though the
PRD mandates both.

`README.md:174-183` repeats the error independently, claiming `features/auth`,
`project-admin` and `org-admin` exist (the real folders are `org-settings` /
`project-settings`) — see D-40.

Not a frozen snapshot: commit c1acf2c (2026-07-22) edited this very tree's `scripts/`
block, so it is a live document that was partially resynced and the `app/` subtree was not.

Recommend: **update the doc** — regenerate the `app/` subtree from the filesystem, add the
packets/operator/KB/skills/MCP subsystems to the FR-to-structure map, and drop the
self-certification at `:1067-1076` or make it true.

#### D-16 · ARCH-2 — `app/server/provenance/` was never built

> `architecture.md:765-768` prescribes `provenance-recorder.server.ts` /
> `provenance-query.server.ts` / a test; `:902` and `:905` map two FR categories ("Agent
> orchestration & continuity", "Integrity, audit & recovery") onto `app/server/provenance`;
> `:135` "The system should preserve observational provenance so users can understand how
> file changes affected interpreted state over time"; `:430` "provenance views".

The directory does not exist. The `provenance` table does
(`db/migrations/0001_baseline.sql:154-162`), written by two local helpers
(`app/server/projections/rebuilder.server.ts:91-111`,
`app/server/github/github-reconciler.server.ts:91-111`). Reads are raw SQL in the wrong
layers: `app/features/github/github-query.server.ts:95` (behindBy) and `:226` (freshness),
plus a hand-written query **inside a route loader**
(`app/routes/project.task.tsx:194-203`) — the only page route in `app/routes/` containing a
raw `.prepare(`, against `architecture.md:865,870,882`. Every production read filters
`action = 'github.reconcile'`, so the rebuilder's `projected/removed/error/rescan` rows and
the reconciler's `github.merge` row are **write-only**. No user-facing provenance surface
exists.

Hurts: a subagent told to extend audit/recovery has no module to extend and will add a
fourth ad-hoc SQL site. The stated capability never shipped.

Recommend: **owner decision** — either build `app/server/provenance/` (recorder + query,
move the three read sites into it) and a minimal provenance view, or delete the module
from `architecture.md:765-768,902,905` and stop writing the four unread action kinds.

#### D-17 · ARCH-14 — 26 code comments cite a normative document that was deleted

`docs/build/CONVENTIONS.md` was deleted in commit c1acf2c ("Remove obsolete code and
simplify project structure"), together with all of `docs/build/` (BUILD-PLAN, STATE, 20
phase reports, 20 specs), leaving `docs/build/{reports,research,specs}/` as empty
directories.

16 comments in 15 files still cite it as the binding contract — e.g.
`app/schemas/sse-event.schema.ts:5` ("SSE wire contract (CONVENTIONS \"SSE\" rules)"),
`app/server/interpretation/readiness-policy.server.ts:10`,
`app/shared/mapping/project.server.ts:12`,
`app/features/live-updates/use-live-updates.ts:13`, `app/routes/resources.health.ts:9`.
Ten more cite **"orchestrator ruling N"** by number — `app/ui/use-dialog.ts:4` (16),
`app/ui/rich-text.tsx:4` (14), `app/features/runtime/runtime-types.ts:14` (11),
`app/server/projections/policy-violations.server.ts:12` (5),
`app/server/projections/notifications.server.ts:18` (9),
`app/server/files/file-store-root.server.ts:19` (3),
`app/server/github/pr-linker.server.ts:7` (12), `app/root.tsx:47` (13). Those numbered
rulings existed only in the deleted file's "ORCHESTRATOR RULINGS (binding)" section and are
reproduced nowhere in the surviving canon.

Separately, the prescribed `docs/architecture/decisions.md` and
`docs/operations/pat-management.md` (`architecture.md:631-636`) were never written.

Hurts: in an AI-maintained repo on its 13th pass, a future pass can silently reverse a
binding ruling it cannot read. Same failure mode as the Simplify wave already on record
(cbcfe77 "repair six regressions from the structural simplification").

Recommend: **update the docs** — recover the rulings from `git show c1acf2c^:docs/build/CONVENTIONS.md`,
fold them into `architecture.md` (or a restored `docs/architecture/decisions.md`), and
re-point the 26 comments. Then either write the two prescribed docs or remove them from the
tree.

#### D-18 · MOCK-4 — 11 undefined CSS custom properties, 7 with no fallback

`app/app.css` is the app's only stylesheet. Diffing every `var(--x)` against `:root`
(`:7-55`) and `:root[data-theme="dark"]` (`:1956-1986`) yields 11 tokens defined nowhere:
`--accent --coral --font-sans --ink --line --link --mono --panel --panel-2 --surface-2
--teal`. Seven have no fallback, so the whole declaration is dropped:

- `--mono` `:508` — `.board-orphan-key` is not monospace (the token is `--font-mono`).
- `--coral` `:862` — `.rev-x:hover` background never renders.
- `--line` `:1027,1032,1035,1036` and `--panel` `:1035,1036` — the **entire Scheduled
  re-runs panel** (rows, form divider, 3 selects, note input) renders with no border and
  no background, in both themes.
- `--font-sans` `:1232` — `.model-sub`.
- `--ink` `:2327,2337` / `--teal` `:2331,2346` — the Agent-logs session-id control has no
  working hover treatment.

Four more survive only on a fallback: `--link` `:1740`, `--panel-2` `:2337`, `--accent`
`:2481,2488`, `--surface-2` `:3033`. Each entered in an unrelated feature commit (O-3 for
the schedule panel, 1714243 for session-id) with no ruling.

Recommend: **fix the code** — map each to its real token (`--font-mono`, `--coral-dark`,
`--hairline`, `--surface`, `--font-body`, `--fg`, `--teal-dark`) or define them.

#### D-19 · MOCK-5 — four undefined class names, on two primary CTAs

The mock's vocabulary is `btn primary` / `btn ghost`, and `app/app.css:320-323` ships
exactly `.btn.primary` / `.btn.ghost`. Post-mock code introduced classes that exist in no
stylesheet (verified against the built `build/client/assets/root-*.css` too):

- `btn btn-primary` — `app/features/task-detail/task-detail-page.tsx:489` (**Save goal**)
  and `:691` (**Schedule operator re-run**). Both fall back to the plain grey `.btn`. At
  `:487-503` "Save goal" and "Cancel" now resolve to identical rules and render
  indistinguishably.
- `btn btn-ghost sched-cancel` — `:631`.
- `muted` — `:607` (`right muted`) and `app/features/home/home-page.tsx:1288`; only
  `--muted` the *variable* exists, so both render at full weight.
- `hint` — `:99`, the DG-2 "Acceptance is blocked: …" line; `.hint` exists only as
  `.pj-new .hint` (`app.css:2729`), so it is an unstyled `<p>`.

Recommend: **fix the code** — `btn primary` / `btn ghost`, and add `.muted` / `.hint`
utility rules or use existing ones.

#### D-20 · DOC-2 — the docs say there is no retention policy; retention deletes audit rows

> `README.md:212`: "**Provenance/audit tables grow unboundedly** — no retention policy
> yet". `docs/operations/runbook.md:78-82`: "`audit_events`, `provenance`, and
> `run_log_lines` grow without an automated retention policy in V1 … audit rows are the
> compliance record, so prune those conservatively."

`app/server/boot.server.ts:164` runs `applyRetention(db)` on **every boot**. It deletes
`run_log_lines` > 30 days (`retention.server.ts:21,42-44`), `audit_events` > 90 days
(`:23,47-50`), and all but the newest 500 notifications per user (`:25,55-67`). Only
`provenance` genuinely grows unbounded. None of the three windows is documented in
`README`, `docs/`, or `.env.example`, and none is env-configurable.

Both passages date to 950550f (2026-07-05); retention landed in 4eeca1c (2026-07-20).

Hurts: the error runs in the unsafe direction — the ops runbook tells an operator that
audit rows persist until manually pruned while the app silently deletes them.

Recommend: **update the docs** — state the three windows, name `provenance` as the one
unbounded table, and drop the "prune audit conservatively by hand" instruction.

#### D-21 · DOC-7 — the restore procedure says the DB is a cache; it holds unrecoverable state

> `docs/operations/deployment.md:136-139`: "If only `state/projection.sqlite` is lost but
> `projects/` survives, you do **not** need a DB backup: the projections are derived …
> Files are canonical; the DB is a cache."

Eight lines earlier the same doc lists `state/` as "projection.sqlite (users, sessions,
projections, audit, PATs, notifications)" (`:128`). Only the projection tables are derived
(`rebuild.server.ts:41-44` rebuilds `task_events`, `diagnostics`, `task_projections`,
`projects`). Losing that file destroys every user row and better-auth credential
(`0001_baseline.sql:23,299-301`), every AES-sealed PAT (`:185-189`), all audit
(`:37`) and notifications (`:163`) — none rebuildable from `projects/`.

The cascade is worse than data loss. On next boot `seedInitialAdmin`
(`boot.server.ts:102` → `seed-admin.server.ts:41,49`) sees an empty users table and mints
an admin with a fresh `newId("u")`, while the surviving canonical files still carry the old
ids (`members[].userId`, `ownerUserId`) and `rebuilder.server.ts:237` re-inserts them into
a table with no FK — every membership and task owner becomes a ghost id, the state pass 13
filed as LV-04.

`runbook.md:14-18` states the carve-out correctly, so the defect is localized to
`deployment.md:136-139`.

Recommend: **update the doc** — delete "you do not need a DB backup", and say plainly that
`state/projection.sqlite` is primary storage for users, sessions, PATs, audit and
notifications, and that restoring `projects/` without it produces unresolvable member/owner
ids.

#### D-22 · DOC-8 — the domain allowlist admits GitHub sign-ins; the docs and UI say Google

> `README.md:138-141`: "…plus, **for Google**, domains added to the org allowlist (those
> provision on first login)." In-app: "any Google account with this domain · joins as
> {role}" (`app/features/org-settings/users-panel.tsx:588`, next to a "G" glyph).

`isOAuthWhitelisted` takes no provider argument, and the domain check runs **first and
unconditionally**: `app/server/auth/oauth-provision.server.ts:56`
(`if (findDomainAllowlistRole(db, email)) return true;`), before the GitHub-placeholder
check (`:57-60`) and the existing-user check (`:62-63`). `findDomainAllowlistRole`
(`org-users.server.ts:537-548`) is a plain domain `SELECT`. The gate is reached for GitHub
because `app/lib/auth.server.ts:246-258` forwards only `{id, email, name, githubHandle}` —
the provider id is never passed.

Before the better-auth migration the two providers had strictly separate paths, and the
old docstring said so explicitly; commit 745e19d collapsed them into one predicate and
described the change only as "the whitelist". Side effect: a GitHub sign-in carrying a
handle falls through the role branch (`:78-96`) and lands as `member`, never the domain's
mapped role.

Hurts: adding `@acme.com` silently also admits any GitHub account whose profile email is
`@acme.com` — an identity the org's Workspace admin cannot offboard.

Recommend: **owner decision** — make `isOAuthWhitelisted` provider-aware (Google-only
domain admission, matching the docs and the UI), or widen the UI copy and README and fix
the role branch. Do not leave the label narrower than the gate.

#### D-23 · DOC-4 — the canonical format doc teaches KB grants that resolve to nothing

> `docs/architecture/file-formats.md:260-263` documents
> `resources:` → `kb: [Viberr Core architecture, Coding standards]` — display names.
> `README.md:198-200` calls that file the canonical spec.

A KB grant is resolved by store **directory**: `readKbBody(name)`
(`app/server/files/kb-injection.server.ts:126`) → `kbDirPath(name)` (`:132` →
`app/server/files/file-store-root.server.ts:135`) → `${DATA_ROOT}/kb/<dir>`; a
non-directory returns `""` with only a `logger.warn` (`:140-143`). Name and dir are
distinct columns (`0001_baseline.sql:228-237`). Shipped grants use slugs
(`app/server/seed/agent-catalog.server.ts:114`, commented "Real KB folders on disk … so
they inject into runs"). Pass 13 fixed the org picker to write `dir` for exactly this
reason (`resources-panel.tsx:430-434`, P13-KM-01) — the doc still teaches the shape that
bug produced.

Scope correction: this applies to `kb:` only. `skills:` and `mcps:` use the slug as the
folder name (`0001_baseline.sql:240,252`), so the doc's examples there are format-correct.

Recommend: **update the doc** — change the `kb:` example to folder slugs and say the value
is the store directory, not the display name.

### 2.3 LOW

#### D-24 · FR11 — agents cannot create tasks

> FR11: "Users and **authorized agents** can create tasks within a project."
> (`prd.md:222`)

Humans: yes (`task-actions.server.ts:408`, `rbac.ts:50`). Agents: no, on every layer.
There is no task-creation capability in `UNIFIED_CAP_CATALOG`
(`app/shared/capabilities.ts:33-82` — `create-task-branch` at `:45` is a git branch). The
operator toolkit's 10 tools (`operator-toolkit.server.ts:88-351`) and the agent toolkit's
3 (`agent-toolkit.server.ts:210,237,292`) include none. And there is no operator bypass:
`requireAction` never reads `ctx.operatorAuthorized` (contrast the transition path at
`task-actions.server.ts:2515/2534/2547`). Notably absent even from the catalog's explicit
"Reserved for humans" group (`capabilities.ts:79-81`), which is where such a decision would
have been recorded. Post-MVP "task-graph and subtask orchestration" (`prd.md:75,190`) does
not dispose of FR11's in-scope clause.

No runtime symptom today — the operator routes the need to a human via
`open_decision_packet`.

Recommend: **owner decision** — add a gated `create-task` capability + toolkit tool, or
strike "and authorized agents" from FR11.

#### D-25 · FR12 / DOC-5 — `docs/architecture/file-formats.md` is stale in five places

The canonical record itself is complete and correct. The doc that specifies it is not, and
it bills itself as the "append contract for agents" with MUST language (`:224`):

- `:126-130` documents `specialist:` + `consultants: []`; the schema writes `engagements`
  (`task-file.schema.ts:372`) and the parser labels the old shape legacy (`:586-590`).
- `:201-203` says "the 9 contract types"; there are 10 since the pass-13 `note` split
  (`task-file.schema.ts:47-58`, 6 production emitters). That code change **is deliberate**
  (comment cites P13-LV-03 at `:42-46`; ledger `FINDINGS.md:52-63`) — only the doc lagged.
- `:165-168` lists 6 packet option kinds; `PACKET_OPTION_KINDS` has 8
  (`task-file.schema.ts:60-77`, adds `retry_other_backend`, `edit_goal`).
- The example frontmatter omits `recommendations`, `schedules`, `workRevision`,
  `verdicts`, `boardRank`.
- `:248` still shows `kind: specialist` for agent profiles.

`git log` shows two commits on the file, the newest predating the 2026-07-19
generic-agents pass. Degrades gracefully (legacy absorption, unknown types render as
comments), with one real consequence: a hand-written `consultants:` reviewer migrates with
`verdictCapable: false` (`:629-631`) and silently never becomes a required reviewer.

Recommend: **update the doc** (5 edits above).

#### D-26 · FR21 / FR17 — the `evidence:` block has no producer anywhere

> FR21: "Specialist agents can execute stage work and append outcomes, blockers, and
> **evidence** to the task record." FR17 adds "linked evidence references".

Outcomes and blockers land. Evidence does not. The block is fully built: parsed
(`app/server/files/task-file.server.ts:180-207`), serialized (`:254-260`), escape-protected
(`:61`), schema'd (`task-file.schema.ts:993`), persisted to `evidence_json`
(`rebuilder.server.ts:472,508`), decoded (`task-event.server.ts:39,51`), rendered
(`app/features/task-detail/timeline.tsx:219-231`), and documented as a live format feature
(`docs/architecture/file-formats.md:228-230`). Producers: **42 `evidence: null` literals
across 11 non-test files, and zero non-null writes.** The only non-null instance in the
tree is the demo fixture (`test-support/demo-data.ts:387-390`). `composePrBody`'s
`evidence?: string[]` param (`app/server/github/pr-open.server.ts:34,46-49`) is likewise
never passed by its one caller (`:206-213`). Agents have no channel either — the toolkit
is `post_comment` / `ask_human` / `report_outcome`.

The seeded reviewer advertises "Attach evidence references" and "Keeps raw validation
output in evidence, not the timeline"
(`app/server/seed/agent-catalog.server.ts:143,150`).

The *replacement* is decided and documented — `separateEvidence` trims raw output to a
prose marker and points at the run logs (`comment-guardrails.server.ts:17-19,63-81`;
`runs-panels.tsx:400`), and `attach-evidence-references` sits in the catalog's explicitly
"no runtime consumer — matrix-only" group (`capabilities.ts:66-75`). What is **not**
decided is the leftover machinery: parser + serializer + escape rule + `evidence_json`
column + renderer + PR-body param, all with zero producers, while the architecture doc
still presents the block as live.

Recommend: **owner decision** — wire it (a completion report emits per-suite
`label · add · del` rows, the demo fixture's shape) or delete it (block, column, renderer
branch, `composePrBody` param) the way pass 13 proposed for F13-17.

#### D-27 · FR30-b — repo-override tasks are never reconciled (re-report of pass-12 FC-6)

`reconcileProject` resolves the **project** GitHub context with no override and returns
early when it is not ok (`app/server/github/github-reconciler.server.ts:453-458`) before
enumerating tasks (`:460-466`). `reconcileTask` *does* honor `repoOverride: fm.repo`
(`:167`) but is unreachable except through `reconcileProject`. So in a project with no
default repo, a task carrying an override gets a branch, a PR and a merge (those paths all
honor it — `branch-sync.server.ts:195`, `pr-open.server.ts:133`, `:556`) but never a
divergence reconcile.

Recorded as pass-12 FC-6 and dispositioned "FC-6 left (task-level repo override — larger)"
(`planning/discovery-2026-07-24-pass12/FINDINGS.md:152`) — a **deferral, not a ruling**.
Currently moot only because D-5 means `fm.repo` can never be set from the UI.

Note: the manual path is not silent (it toasts "No repository configured for this
project.", `github-copy.ts:29-31`); the poller path is (`reconciled`/`changed` stay 0).
Stale citations in the original write-up: the poller's branched-task selection is
`reconcile-poller.server.ts:88-100`, not `:24-36` (that range is now the F12-05 nudge).

Recommend: **fix with D-5** — resolve context per task when `fm.repo` is set, or drop the
override feature entirely.

#### D-28 · PRD-9 — GitHub review state is never read; CI health is fetched and discarded

> "Authenticated access to repositories, branch creation, commit association, PR creation,
> and **review-state awareness**." (`prd.md:124`); "Branch and PR status stay visible
> alongside task state." (`:127`)

The complete endpoint inventory of `app/server/github/` contains no `/pulls/{n}/reviews`
and no GraphQL `reviewDecision` (the one GraphQL POST at `github-reconciler.server.ts:578`
is the ready-for-review *mutation*). `PrFacts` is number/title/state/draft/headSha/changed/
checks (`pr-linker.server.ts:45-56`) and `pr.state` is `review | merged | closed | accepted`
(`task-file.schema.ts:233`).

Separately, the one GitHub quality signal that *is* fetched is dead: `findPrForBranch`
makes an extra `/commits/{sha}/check-runs` call and builds a passing/failing/pending
summary (`pr-linker.server.ts:160-172`), the reconciler writes it into the PR ref
(`github-reconciler.server.ts:242`), `pr-open.server.ts:296` deliberately preserves it —
and **nothing reads `.checks`** anywhere (every consumer narrows to number/state/title).

Hurts: a teammate approving or requesting changes in GitHub's UI changes nothing Viberr can
see. A merge blocked by required reviews does fail cleanly (405 → `not_mergeable` carrying
GitHub's message, `:652-654`), so the failure mode is a late surprise. Meanwhile one API
call per reconcile pass is spent for zero output.

Recommend: **owner decision** — either consume `.checks` (a CI pill next to the PR pill)
and add `reviewDecision`, or stop fetching check-runs and strike "review-state awareness"
from `prd.md:124`.

#### D-29 · PRD-10 / UX-13 — no review-first mode; breakpoints do not match the spec

> "Tablet/narrow screens get **review-first access** (current state, latest packet,
> ownership/waiting status, safe lightweight actions), **not full supervision**."
> (`prd.md:161`); breakpoints 768 / 1024 / 1440 and "below 768px: review-first mode"
> (`ux-design-specification.md:879-890`).

`app/app.css` has 19 `@media` blocks; 16 are width breakpoints at 1400/1300/1100/1080/
1000/900/760 — none of the spec's boundaries. Every one is reflow or minor chrome hiding:
`.board` narrows columns (`:492`), `.detail` collapses to `1fr` (`:1499`), the
settings/policy/activity/profile grids go single-column, the topbar drops a crumb and the
search box (`:2307-2320`). `.app` is `grid-template-columns: var(--rail-w) minmax(0,1fr)`
with `--rail-w: 232px` (`:100-104`, `:54`) and is never overridden, so the nav rail keeps
232px at every width. No `matchMedia`/`useMediaQuery` gating exists. Destructive and
governance controls render at every viewport.

Origin: the mock has the identical reflow-only breakpoints
(`design/html-app/app/viberr.css`), so the gap was inherited from one build input and never
reconciled with the other.

Recommend: **update the doc** — desktop-first is the declared context (`prd.md:50`,
`architecture.md:143`), so amend `prd.md:161` and the UX spec's Responsive section to say
narrow screens get the same surface reflowed. Only build review-first if you actually want
it.

#### D-30 · ARCH-4 — structured logs carry no correlation identifier

> "Logging is structured JSON with correlation identifiers" (`architecture.md:245`);
> "Structured JSON logs with request/job correlation identifiers" (`:409`); prescribed
> `logging/{logger,request-context}.server.ts` + test (`:801-804`).

`app/server/logging/` is one file. The record shape is `{ level, time, msg, ...fields }`
(`logger.server.ts:29-38`) with no context propagation, no `AsyncLocalStorage`, no
middleware. `grep requestId|correlationId|traceId` over `app/**` returns one hit and it is
GitHub's `pullRequestId` in a GraphQL string. Of 146 `logger.*` call sites under
`app/server`, 75 hand-carry a domain id (`{ runId }` at `run-service.server.ts:672`) and 71
carry none; `app/entry.server.tsx:29-35` has `request` in scope and logs neither URL nor id.

The affordance shipped originally — `logger.child({ requestId })` in c2ba346 — and was
removed by cf49bd1 ("Simplify application architecture"). `git log -S'logger.child'` shows
no call site ever used it, so correlation was never actually implemented.

Single-process app with no horizontal-scaling target, so the practical cost is low.

Recommend: **fix the code** (small: an `AsyncLocalStorage` request id bound in
`entry.server.tsx` plus `runId` on run paths) **or update `architecture.md:245,409`** to
say per-call domain ids only.

#### D-31 · ARCH-5 — no linter, no formatter, no lint step in CI

> "CI should cover typecheck, lint, tests, migration checks, and build integrity"
> (`architecture.md:400`); "Enforce through linting, typechecking, tests, and review
> against this architecture document" (`:582`); root `eslint.config.js` /
> `prettier.config.cjs` in the prescribed structure (`:622-623`); repeated at `:977`.

`package.json` has no `lint`/`format` script and no eslint/prettier/biome/oxlint
dependency; no config file exists at any depth outside `node_modules`;
`git log --all --diff-filter=A -- '*eslint*' '*prettier*'` is **empty**, so none ever
existed. `.github/workflows/ci.yml:21-31` runs `npm ci → typecheck → test → build` plus a
separate Playwright job. `doctor.config.ts` is a manually-invoked react-doctor ignore list,
not a gate.

Correction to the original claim: migration integrity **is** gated transitively —
`app/server/db/migration-runner.server.test.ts:58-90` applies the real baseline and asserts
idempotency and constraints, and `npm test` runs in CI.

Hurts: the document names linting as the mechanism for enforcing its own anti-drift rules
(naming, module boundaries, no dumping-ground modules). None of those rules is machine-
checked.

Recommend: **owner decision** — add a linter + CI step, or strike lint from
`architecture.md:400,582,977` and drop the two config files from the prescribed structure
(which also still lists `tailwind.config.ts` and `postcss.config.mjs`, neither of which
exists).

#### D-32 · ARCH-11 — the projection-freshness policy module was never built

> `architecture.md:751-757` prescribes `readiness-policy`, `diagnostics-policy`,
> `pat-diagnostics-policy`, `projection-freshness-policy`; `:881` "server/interpretation/
> owns shared policy logic for readiness, diagnostics, PAT validity, and freshness";
> `:542-543` "Do not duplicate interpretation logic in multiple UI components or feature
> modules".

`app/server/interpretation/` holds `readiness-policy.server.ts` (+test) and
`diagnostics-policy.server.ts` (no test). No projection-freshness module, and the concept
named at `:436`/`:935` was never implemented — `grep fresh` over
`app/server/projections/` and `app/server/files/` returns zero staleness logic.

Two live staleness rules sit outside the policy layer, each with its own 1-hour constant:
`app/features/github/github-query.server.ts:236-242` and — inside a **UI component**, the
thing `:542-543` forbids — `app/features/org-settings/resources-panel.tsx:37-39`
(`MCP_HEALTH_STALE_MS`).

Scope correction: the `pat-diagnostics-policy` half does **not** stand. The same doc's
cross-cutting map sends PAT validation to `app/server/secrets/pat-validator.server.ts`
(`:911`), that file exists, and health is single-sourced in
`pat-store.server.ts:354` — the doc contradicts itself and the build followed the map.

Recommend: **update the doc** (drop `projection-freshness-policy.server.ts` and the
"freshness" clause at `:881`, or build it) and **fix the code** by hoisting the two 1-hour
constants into one shared module.

#### D-33 · ARCH-13 — rate limits cover only auth

> "Apply targeted limits to auth flows, PAT validation, and expensive sync/projection
> rebuild operations" (`architecture.md:353-356`).

`app/server/auth/rate-limit.server.ts` exports two limiters (`:118`, `:123`), consumed only
by `login.server.ts:73,100` and `app/lib/auth.server.ts`. PAT validation is unthrottled
(`app/server/secrets/pat-validator.server.ts:94` from
`app/server/org/connections.server.ts:213` and `:326`) — `last_validated_at` records the
result but never suppresses a repeat network call. `rescanProjections`
(`app/routes/_index.tsx:95`), `rebuildProjections` (`:110`) and `rebuildAll`
(`settings-actions.server.ts:551`) have no limiter, lock, single-flight or min-interval.

Every one sits behind auth plus a role gate (org admin for rescan/rebuild/connections;
`edit-policy` for delete-project), so no unauthenticated party can burn GitHub quota or
CPU, and `architecture.md:356` allows minimal limiting in MVP.

Recommend: **fix cheaply** (a single-flight guard on rescan/rebuild, a cooldown on PAT
revalidation) or narrow `architecture.md:353-356` to auth.

#### D-34 · UX-4 — the board empty state never mentions the active filter

> "Empty states should orient users toward the next meaningful action. They should explain
> what is absent, why it matters, and what the user can do next."
> (`ux-design-specification.md:846-847`)

Every column renders the bare string "No tasks" for the filter+search result
(`app/features/board/board-page.tsx:309-310`; list view `:371`), where `visible` =
`matchesBoardFilter && matchesSearch` (`:984-987`). The page header count is the
**unfiltered** total (`taskCount={allTasks.length}`, `:1027`) while the column headers are
filtered (`:782`) — so the page can read "12 tasks · 3 waiting on a human decision" above
five columns that all say "No tasks".

Pass 13 fixed exactly this class on the home grid (`home-page.tsx:1131-1139`, UI-21) and in
the timeline (`timeline.tsx:459-471`, UI-40) but not on the board.

Recovery is one click (the active chip carries `aria-pressed`), which is why this is LOW.

Recommend: **fix the code** — three-way copy: no tasks at all / no match for this filter /
no match for this search, with a clear-filter affordance.

#### D-35 · UX-7 — every in-app path back to the board drops the filter and search

> "When users move from board to task and back… Filters, queue position, and recent focus
> should not reset unnecessarily." (`ux-design-specification.md:824-825`)

Board state lives only in URL params (`board-page.tsx:829-832`, written with
`{ replace: true }` at `:989-999`); there is no sessionStorage anywhere. Every in-app
return path is a bare path: `const boardPath = "/projects/" + projectSlug + "/board"`
(`app/features/shell/topbar.tsx:60`), used for both the project crumb (`:112`) and the
task-page "Board" crumb (`:118-121`); the rail's item
(`app/features/shell/rail.tsx:46-51`); and the ErrorBoundary link
(`app/routes/project.task.tsx:729`). React Router resets `search` for an absolute path
string, so all four land on `filter=all, view=stage, q=""`.

Browser Back does restore it (the filtered URL is the live history entry), which caps this
at LOW.

Recommend: **fix the code** — carry `location.search` into `boardPath` and the rail's
board item.

#### D-36 · UX-8 — no route-level pending indicator anywhere

> "Loading patterns should preserve layout stability… Refresh actions should make updated
> state visible without disorienting the user." (`ux-design-specification.md:849-850`);
> `architecture.md:559` "Use React Router navigation/fetcher pending state as the default
> loading mechanism".

`useNavigation` appears in exactly two lines of the tree, both in `app/routes/login.tsx`
(`:2`, `:258`). No `HydrateFallback`, no skeleton component, no `.skeleton` class
(`grep skeleton|shimmer` over `app/` and `design/` = 0). The one global busy affordance is
`.ico.spin` (`app.css:2532-2534`), used only for *fetcher* states.

Blast radius is one route: of every `loader` in `app/routes/*.tsx`, only
`app/routes/project.github.tsx:33` awaits the network (`checkRepoAccessCached` → live
`GET /repos/:repo`). Clicking "GitHub" in the rail on a slow network looks like a dead
click for up to the 20 s client timeout — which is the half of pass-13's F13-04 that *did*
land (`github-client.server.ts:108-137`); the prescribed pending bar
(`routes-ui-audit.md:241`) did not.

Correction to the original claim: React Router keeps the current page painted during a
client navigation, so nothing goes blank.

Recommend: **fix the code** — the top-level pending bar F13-04 already prescribed, driven
by `useNavigation().state !== "idle"`.

#### D-37 · UX-10 — the rail's current item has no programmatic current-location signal

> "Current location should be visible without relying on color alone" (`:836`); "semantic
> HTML and ARIA support for navigation…" (`:901`); WCAG 2.2 AA baseline (`:896`).

The rail marks the active item with a hand-computed class
(`app/features/shell/rail.tsx:30,47-51`) derived from `workspaceViewFromPathname`, which
maps the `tasks` segment to "board" (`nav.ts:36-40`). `NavLink`'s own `aria-current="page"`
only fires on a `to` match, and `/projects/x/tasks/VIB-1` does not match
`to="/projects/x/board"`. So on **every task-detail page** — the product's deepest surface
— the Board item is visually highlighted with no ARIA signal. The whole app has one
`aria-current` (`org-settings-page.tsx:66`); the breadcrumb is a plain `<div>` with a
`<span className="cur">` (`topbar.tsx:111,123-126`).

The visual treatment itself is fine (background + border + weight + shadow,
`app.css:174-180`) — the quoted "color alone" rule is not what breaks; the visual/
programmatic mismatch (WCAG 1.3.1) is.

Pass 13 fixed the sibling defects (landmark + skip link UI-12; `aria-pressed` UI-13/58) and
rated the `aria-pressed` one MED.

Recommend: **fix the code** — one line:
`aria-current={activeView === n.id ? "page" : undefined}`.

#### D-38 · MOCK-6 — one panel head nests its icon inside the heading

The contract is `<div className="panel-head"><Icon/><h2>Title</h2>…</div>`, styled as a
flex row (`app.css:735-741`: `gap:.6rem`, `.panel-head h2 { flex:1 }`). Of ~48 panel-head
blocks in `app/`, exactly one nests:
`app/features/task-detail/task-detail-page.tsx:602-605` —
`<h2><Icon name="clock" /> Scheduled re-runs</h2>`. Four other heads in the same file use
the sibling form (`:881-882` is the direct counterexample). The `.6rem` gap collapses to a
JSX space and the inline SVG baseline-aligns instead of centring. Introduced in 825e131 in
this shape and never revised.

Recommend: **fix the code** — move the `<Icon>` out of the `<h2>`.

#### D-39 · MOCK-7 — the comment composer shows a Mac-only shortcut

Pass 13's UI-55 established the rule and the helper for exactly this: "every non-Mac user
was shown a shortcut their keyboard does not have"
(`app/ui/use-shortcut-hint.ts:4-18`), applied at `topbar.tsx:168` and
`home-page.tsx:899`. The timeline composer still renders the literal `⌘↵ to send`
(`app/features/task-detail/timeline.tsx:443`) while its own handler accepts either modifier
(`:411`, `use-mention-autocomplete.ts:125`). `useModifierHint` is not imported there. It is
now the only user-visible `⌘` literal left in `app/`.

Note: `useModifierHint()` returns `"⌘K"`/`"Ctrl K"` with the key baked in, so it must be
generalized to return the modifier alone (and needs `suppressHydrationWarning` per its SSR
contract).

Recommend: **fix the code**.

#### D-40 · DOC-14 — the README project layout names directories that do not exist

`README.md:178-180` lists features as "auth, home, board, task-detail, review, runtime,
github, agents, policy, **project-admin**, **org-admin**, activity, notifications, profile,
kb-browser, live-updates". Actual: activity, agents, board, github, home, kb-browser,
live-updates, notifications, **org-settings**, policy, profile, **project-settings**,
review, runtime, **shell**, task-detail. `git log --all --name-only` proves
`app/features/org-admin` and `app/features/project-admin` **never existed**; there is no
`app/features/auth` (auth is `app/server/auth/` + `app/lib/auth.server.ts` + a 542-line
route); `shell/` and the whole `app/lib/` are undocumented. The same block's `data/` line
ends with `logs/` (never created) and omits `skills/` (created).

The features line is byte-identical to its Phase-11 original even though c1acf2c edited
sibling lines in the same block.

Recommend: **update the doc**, together with D-15 (`architecture.md`) and D-41.

#### D-41 · DOC-6 — three docs publish a data-root inventory that no longer matches

`DATA_ROOT_SUBDIRS` (`app/server/files/file-store-root.server.ts:23-37`) is exactly:
`projects, agents, agents/profiles, runtimes, runtimes/claude-home, runtimes/codex-home,
kb, skills, state`. `auth/`, `cache/` and `logs/` are never created — pass-11 P11-56
removed them on purpose (commit efca1a2), but the "document" half of that item was never
done:

- `docs/architecture/file-formats.md:13-20` — still ends `cache/ auth/ logs/`, under a
  line that names the source file, and also omits `kb/` and `skills/`.
- `docs/operations/deployment.md:125-129` — lists `auth/ cache/ logs/` **and omits
  `agents/`**, which holds `agents/profiles/*.md` (seed + every org profile edit) and
  `agents/definitions/`.
- `README.md:191` — omits `skills/`, carries a phantom `logs/`.

Only the `agents/` omission has a consequence, and it is indirect: `deployment.md:132`
says "snapshot the whole `./docker-data` directory", so anyone following the actual
instruction is fine; only a hand-written selective backup misses org agent profiles.

Recommend: **update the three docs** (code needs no change).

#### D-42 · DOC-3 — the deployment guide promises a degraded engine that no longer exists

> `docs/operations/deployment.md:75-79`: "…Viberr reports Codex **unavailable** and
> **routes Codex-assigned work to its degraded engine** instead of starting a run that
> would fail with a redacted error."

There is no degraded engine. `selectRuntime` returns `{ kind: "unavailable" }`
(`runtime-registry.server.ts:315-325`, docstring "the caller must fail the run honestly")
and the sole consumer fails fast (`run-service.server.ts:375-378`, `failRunUnavailable`
`:382-405`, audit marker "R7-2 fail-fast" at `:333`). Removal was the pass-7 R7-2 ruling;
`playwright.config.ts:40-43` says "That engine is gone".

Provenance makes it a clear miss: commit 4f4f529 (the R7-2 cut) rewrote the paragraph 11
lines *below* this one from "falls back to the built-in **simulated** backend" to the
correct "there is no simulated fallback" — and left this sentence behind. The same page
self-corrects at `:95-96` and `:100`.

Doc-only: the app behaves honestly and hands the operator the exact
`docker compose cp ~/.codex/auth.json` remedy at failure time
(`run-service.server.ts:425`).

Recommend: **update the doc** — one sentence.

#### D-43 · DOC-9 — the database is never closed on shutdown; the WAL guidance misleads

> `docs/operations/deployment.md:132-135`: "Stop the container (or accept a
> crash-consistent copy — SQLite is WAL, so also copy `*-wal`/`*-shm`) and archive it." —
> stopping is offered as the clean alternative to needing the sidecars.

Nothing closes the DB. `closeDb()` (`app/server/db/sqlite.server.ts:56`, docstring "tests /
graceful shutdown") has no non-test caller. The only SIGINT/SIGTERM handler in the app
closes SSE connections and re-raises (`app/server/events/sse-broker.server.ts:150-155`); no
`wal_checkpoint` call exists anywhere. Observed: `viberr-app-1` "Exited (1)", with
`docker-data/state/projection.sqlite-wal` (4.1 MB) and `-shm` still present beside a stale
`projection.sqlite` — SQLite unlinks both on a clean close, so their survival proves it.

Harm requires the operator to infer "stopped ⇒ sidecars unnecessary" and archive
`projection.sqlite` alone, contradicting the first sentence of the same bullet — but the
WAL-resident rows include users/sessions/PATs, which are not rebuildable (see D-21).

Recommend: **fix the code** (wire `closeDb()` + a checkpoint into the existing signal
handler — three lines) **and** drop the "or" from the doc.

#### D-44 · DOC-15 — the runbook's runtime triage names two of six credentials

> `docs/operations/runbook.md:61-64`: "With no `ANTHROPIC_API_KEY` / `CODEX_API_KEY`, the
> backend is **unavailable** … Add a key and restart."

`hasCredential` (`app/server/runtimes/runtime-registry.server.ts:118-132`) accepts, for
Claude: `ANTHROPIC_API_KEY` | `CLAUDE_CODE_OAUTH_TOKEN` | `VIBERR_CLAUDE_USE_CLI_AUTH=1`;
for Codex: `CODEX_ACCESS_TOKEN` | `CODEX_API_KEY` | `OPENAI_API_KEY` | (`VIBERR_CODEX_USE_CLI_AUTH=1`
**and** `$CODEX_HOME/auth.json` actually existing, `codexCliAuthUsable` `:79-81`). The
runbook — the day-2 triage doc — never mentions the CLI-auth opt-ins or the auth.json
condition, i.e. the F-DOCKER1 trap the code itself calls "the docker-compose recurring
trap" (`:83-90`): a wiped `./docker-data` drops `auth.json` while the flag stays set.

`deployment.md:44-79`, `README:84-110` and `.env.example:60-95` document the full matrix,
so the runbook was simply missed in that sweep. The in-product error message is already
correct and actionable (`run-service.server.ts:419-427`).

Recommend: **update the doc**.

#### D-45 · DOC-10 — CONTRIBUTING still promises demo data and demo accounts

`CONTRIBUTING.md:22` labels step 3 "**Demo data**" over `npm run seed`, and `:29` points at
the README for "demo accounts". Neither is true: the seed is a clean sheet by owner ruling
(`app/server/seed/seed.server.ts:29-44`; `scripts/seed.ts:40` prints "clean sheet — no demo
board data"), the README has no demo-accounts section (only the bootstrap admin,
`README.md:53-56`), and the mock board is `npm run seed:demo` (`package.json:16`). The
ruling commit e306248 updated `README.md` and `deployment.md` only; `CONTRIBUTING.md` was
last touched two days earlier.

Recommend: **update the doc** — rename the step "Baseline data" and point at
`npm run seed:demo`.

#### D-46 · DOC-11 — the e2e CI job is invisible to contributors

`README.md:72` heads the table "### **All** npm scripts" and lists 7 scripts without `e2e`
(`:74-82`), while `:81` refers to "the e2e + route suites". `CONTRIBUTING.md:37-38`
describes CI as "typecheck, unit/integration tests, and build" and `:46-50` lists exactly
those three as the pre-PR commands. But `package.json:14` defines `"e2e": "playwright
test"` and `.github/workflows/ci.yml:32-49` runs it as a second job on every PR.
`docs/testing.md:14-24` documents it, so the repo contradicts itself.

Provenance: both entries existed and were removed by c1acf2c in the same hunks that dropped
the obsolete `npm run migrate`; commit 892e75f restored the job, the script and the specs
(calling the deletion a regression) but touched neither `README.md` nor `CONTRIBUTING.md`.

Hurts concretely: `default-assets.server.ts:11-19` records that the pass-13 install
regression passed typecheck, 1663 unit tests and the build, and "the e2e job was the only
gate that ran a real CLI entrypoint".

Recommend: **update both docs**.

#### D-47 · DOC-12 — `docs/testing.md` claims coverage of `scripts/`

> `docs/testing.md:11`: "Runs Vitest over `app/`, `db/`, and **`scripts/`**."

`vitest.config.ts:16-19` includes only `app/**/*.test.{ts,tsx}` and `db/**/*.test.ts`, and
`scripts/` contains no test file. No workspace file or second config could re-add it.

Important: the config side is **deliberate** — commit 434722c removed the "dead vitest
glob" per pass-12 discovery. The doc edit (13:37) predates the glob removal (16:50). So
the fix is the doc, not the config; re-adding the glob would undo an intentional cleanup.

Hurts: a contributor adds `scripts/foo.test.ts` on the doc's authority and it is silently
never collected — in the one directory whose lack of coverage broke in pass 13.

Recommend: **update the doc** (drop "and `scripts/`").

#### D-48 · DOC-16 — `.env.example` mis-describes `VIBERR_CLAUDE_MAX_TURNS`

> `.env.example:107-111`: "Read directly off the environment (**NOT validated by
> env.server.ts**)."

It **is** declared in the validated schema (`app/server/config/env.server.ts:128`) and read
through the cached `getEnv()` (`app/server/runtimes/claude-runtime.server.ts:322`),
contradicting the schema's own comment at `env.server.ts:119-121`. Pass 12 moved it into
the schema; the doc line dates to 2026-07-17 and went stale.

Scope corrections: the sibling knob `VIBERR_CLAUDE_IDLE_TIMEOUT_MS` genuinely does read
raw `process.env` and carries its own explaining docstring
(`claude-runtime.server.ts:147-149`) — deliberate, not a defect. `LOG_LEVEL`'s
"NOT validated" note (`.env.example:41`) is accurate. And `CODEX_CLI_HOME` (`compose.yml:44`)
is a compose-interpolation variable with a working default and an inline explanation, not
a schema variable.

Recommend: **update the doc** (one line).

---

## 3. DELIBERATE — intent superseded

These are not defects. They are listed because a future implementation subagent reading the
source document will "fix" them back. **Bolded rows need a doc edit.**

### 3.1 Decisions whose source document still states the old intent

| id | decision | evidence | doc edit needed |
| --- | --- | --- | --- |
| **PRD-3 / FR27-a** | Under the `auto` preset, a full-autonomy operator with an explicit `completion-for-acceptance: direct` grant moves a task to Done itself (`operator-actions.server.ts:1632`, write at `:1666-1689`). | Docstring `operator-actions.server.ts:1571-1577` "the ONE deliberate exception to the human-only-Done invariant"; owner ruling Q1 cited at `:224-229`, `project-create.server.ts:60-65`, `operator-toolkit.server.ts:335-338`; recorded in pass-11 and pass-12 subsystem docs; tests `operator-actions.server.test.ts:892,954`. | **Yes.** `prd.md:114`, `:183`, `:242` still assert human-only Done. `app/shared/capabilities.ts:41-42` still says "Never autonomy-promoted to direct: acceptance stays human even under `full` autonomy" and labels it "Completion **for human acceptance**" — both false in `direct` mode; rename it. `policy-page.tsx:297-310` still lists "Transition a task to Done" under "Always reserved for humans · all profiles" 120 lines above its own disclosure note. (The Review-queue copy is a separate DRIFT item, D-9.) |
| **ARCH-1** | `state/projection.sqlite` is the only home of non-rebuildable state (users, better-auth tables, audit, notifications, encrypted PATs, org resources, agent runs, staged outcomes). The prescribed `auth/` secret directory does not exist. | Owner ruling in-code at `db/migrations/0001_baseline.sql:10-19` (accepts that a wipe regenerates user ids, "revisit at the first real deployment"); `planning/discovery-2026-07-24-pass12/docs/data-model-store.md:14-16`; the `auth/` dir was removed on purpose by P11-56 (commit efca1a2). `docs/operations/deployment.md:128` and `runbook.md:14-20` describe the real split correctly. | **Yes.** `architecture.md:836-843` (tree), `:853` ("must never be treated as canonical truth"), `:892` ("PATs and encrypted secrets remain in `/var/lib/viberr/auth`"). The security substance of `:892` — never in task files or logs — *is* honored (AES-256-GCM via `secret-box.server.ts`, key in env). |
| **ARCH-10** | Email + password is the shipped default; OAuth is optional and off by default; sessions are server-side rows with an opaque `viberr.session_token` cookie. | Decision id `D12` at `app/routes/login.tsx:359-361`; ORCHESTRATOR RULING 16 at `app/shared/auth/password-policy.ts:3-5`; `design/better-auth-migration.md:4`; the HTML mock **is** this login page (`design/html-app/app/login.jsx:117-145`, OAuth buttons above the credentials form). | **Yes.** `architecture.md:229-230` ("Critical Decisions (Block Implementation)": OAuth-first, cookie-only sessions) and `:297-306`. Record local credentials as a first-class path. Note the session half is *not* a divergence — `:267` and `:273` already contemplate a session table, and an opaque cookie best satisfies `:305`. |
| **ARCH-6** | Every task that has run an agent holds a full git clone at `<taskDir>/workspace/<repo>` (`specialist-run.server.ts:1143-1150`, `:1315-1320`) — 7 clones at 11-16 MB on disk today. | Docstring `specialist-run.server.ts:692-694`; `workspaceRunEnv` `:1252-1268` cites "adversarial-review HIGH #2" and its GIT_CEILING argument *depends* on this placement; watcher exclusion documented at `file-watch.service.server.ts:139-142`; pass-12 `data-model-store.md:72` "← agent working clone (NOT projected/watched)". | **Yes.** `architecture.md:824-831` (tree has no `workspace/`) and `:851` ("`projects/` is the only authoritative shared business state"). Also note `attachments/` was never implemented. **Separate un-ruled item:** task workspaces are never garbage-collected — no `rmSync` path removes them. |
| **PRD-12** | Governed time-triggered agent execution ships: a maintainer schedules a future operator re-run (5m/1h/6h/24h), fired by a 60 s server-side runner (`app/server/tasks/schedule.server.ts:36,417-436`, wired at `boot.server.ts:181-186`). | Docstring `schedule.server.ts:21-34` explains the backend-parity rationale; O-3 finding-id comments in 5 files; commit daca7c1 rewrote the pass-8 doc from "O-3 (product Q, open)" to "O-3 — BUILT … greenlit-then-built, not built blind". | **Yes.** Neither PRD mentions scheduling and no FR covers it; the nearest scoped item is Phase 2's "refined runtime management". Add an FR — this is the one capability that lets an agent act with no human present at the moment of action. (Caveat: the pass-8 doc that held the ruling is no longer in the tree; the ruling now lives only in code comments + git history.) |
| **PRD-11 / FR33-c** | `applyRetention` hard-deletes audit rows past 90 days on every boot (`retention.server.ts:23,47-51`, `boot.server.ts:164`), with no export path. | Docstring `retention.server.ts:4-18` cites F10-29 and reasons about exactly this ("a full audit trail is a governance requirement, so audit events are kept far longer than raw logs"); re-cited at `boot.server.ts:160-162`; test-locked at `retention.server.test.ts:16,46`. NFR18's *named* conditions (restarts, resync, runtime failures) are all met — `rebuild.server.ts:26` deliberately preserves `audit_events`. | **Yes,** small. State the 90-day window in the PRD/README. The real residual: org/auth-scoped rows with no Markdown counterpart (`auth.login.*`, `org.user.*`, `org.connection.token_replaced`, `github.pat.*`) vanish at 90 days with no export. Task-scoped history survives indefinitely in `task.md`. See also D-20 — the docs currently claim the opposite. |
| **UX-12** | Typography, palette, gradients and spacing follow the HTML design system, not the UX spec: `--font-display: Roobert PRO Medium` / `--font-body: Noto Sans` / `--font-mono: JetBrains Mono` (`app.css:37-39`), `--blue #5b76fe` + pastel semantic surfaces (`:19-33`), two radial gradients on `body` (`:68-71`), no spacing tokens, no 12-column grid. | `app.css:2-4` "Extends the Viberr design system (Miro-inspired bright canvas)"; `design/html-app/app/viberr.css:19-38,61-71,103-107` is byte-identical and entered in the Phase-0 design import (80ed201). The spec text is itself advisory ("A strong typographic direction **would** use IBM Plex Sans", `:352`; "A practical palette direction is", `:340`). | **Yes,** one line. Mark `ux-design-specification.md:340-352,375,378` superseded by `design/design-system.html`. The one rule with teeth — `:346` avoid decorative gradients in core workflow views — is arguably breached by the body wash, but the gradients are 60-62% transparent pastels behind opaque surfaces. |
| **DOC-1** | A background GitHub reconcile poller runs every 5 minutes on every boot (`reconcile-poller.server.ts:21`, `boot.server.ts:192`), emitting divergence events, notifications, recommendation withdrawals and merge-pending nudges with no human action. | Docstring `reconcile-poller.server.ts:10` "(P11-14, owner ruling 2026-07-24)"; raised at pass-11 `FINDINGS.md:61`, resolution recorded in pass-12 `delivery-github-review.md:548` (commit 582fd63). The live UI is honest: "auto-refreshes every 5 minutes" (`github-view.tsx:436,442`). | **Yes.** `README.md:218-219` "**No scheduled GitHub reconcile**" and `docs/operations/runbook.md:57` "no scheduled poll in V1" — both authored 19 days *before* the poller. Both also still name the button "Reconcile"; P11-14 renamed it "Update status". |
| **FR35 (partial)** | The `quality` typed event has one producer — a reviewer's approve/request_changes verdict (`task-actions.server.ts:1561`). The capabilities that would produce the other kind (`post-quality-flags`, `flag-underspecified-tasks`) are advisory-only. | `app/shared/capabilities.ts:66` "// Advisory persona guidance (no runtime consumer — matrix-only, no toggle)"; pass-4 ruling 7 cited at `capability-catalog.ts:19`; test-locked at `capability-catalog.test.ts:26` and `capabilities.test.ts:56`; pass-12 UC-03 defines the flag-underspecified outcome as a packet, not a quality event. | No — FR35's guarantee is met (`quality` is a real typed event: rendered, notified, audited). Optional: rename the two catalog rows so they do not read as enforcement. |
| **UX-11** | The board ships four filter chips (All / Waiting on me / Agent working / Needs attention) and "Waiting on me" is viewer-scoped, not the spec's project-wide "waiting on human". | Docstring `board-filters.ts:18-21` explains both ("member-scoped (R8-3): a decision the viewer can actually act on"); R8-3 is cited in 6 other modules; the chip set is verbatim from `design/html-app/app/board.jsx:157-159`. The missing "degraded continuity" chip rolls into D-2. | No, optional. `ux-design-specification.md:841` says "states **such as**" — illustrative. Cost: a supervisor cannot isolate `blocked` alone, or other people's human-waiting tasks. |
| **FR5** | Project creation is self-serve for any signed-in org member; the creator is seeded as that project's admin. Configuration (`edit-policy` / `manage-members` / `manage-agents`) *is* admin-only. | Comment `app/routes/_index.tsx:113-118` "RBAC decision (deliberate, pinned by test) … Org role is intentionally NOT consulted here"; the two adjacent intents (`:85-110`) *do* gate on org admin; pinned by `workspace-routes.server.test.ts:490`. | No. `prd.md:211` grants admins the ability; it does not say *only* admins, and since the creator becomes that project's admin the sentence stays true of every project. Worth one clarifying clause if you want it airtight. |

---

## 4. Unclear

#### U-1 · PRD-8 — no output-side secret redaction, and no ruling either way

> "Agent execution must not expose repository, provider, or other secrets in task
> timelines, comments, **logs**, or generated evidence." (`prd.md:106`); NFR7 extends this
> to "general application logs" (`prd.md:272`); `prd.md:132` names "sanitized logging" as a
> required mitigation.

**Input-side isolation is enforced in code**, not by convention: `filteredSpawnEnv` strips
every credential-shaped var from both spawn envs (`runtime-registry.server.ts:191-206`,
citing F10-02), Codex runs with `allow_login_shell: false` +
`shell_environment_policy.inherit: "core"` (`codex-runtime.server.ts:139-168,197-199`), and
the PAT never enters argv or `remote.origin.url` (`git-clone-auth.server.ts:43-101`).

**Output side has no filter at all.** `createRunSink` appends the emitted line verbatim to
the `.jsonl` and inserts it into `run_log_lines` (`run-sink.server.ts:84,89-95`); the
logger copies every caller field and full stacks with no key/value filter
(`logger.server.ts:20-38`). Two route docstrings concede the risk and name access scoping
as the chosen mitigation — `resources.run-log.ts:15-20` ("they carry tool output, agent
prompts, repository metadata, **and possibly secrets**", cites F10-06/F10-33) and
`resources.session-export.ts:25-29`.

Why unclear: the docstrings decide the *run-log* stance ("isolate at the source, scope the
audience") but nothing covers the bare stdout logger, which NFR7 explicitly names. One
concrete path remains: the selected provider credential is deliberately re-added to the
agent child env after filtering (`runtime-registry.server.ts:220-222,255-257`), and Claude
has no counterpart to Codex's shell-env policy — so a Claude tool call that prints its
environment lands verbatim in a member-visible console and in the downloadable session
export.

Would settle it: an owner ruling (or a docstring on `run-sink.server.ts` /
`logger.server.ts`) stating whether source-side isolation + membership scoping satisfies
NFR7 and `prd.md:132`, or whether an output scrub is still owed.

#### U-2 · MOCK-9 — the guardrails have no surface, and the mock never rendered one either

`DEFAULT_GUARDRAILS` (`app/shared/workflow/templates.ts:76-82`) is written into every new
project (`project-create.server.ts:274-276`), enforced for real
(`comment-guardrails.server.ts:93,109` with 8 call sites) and projected
(`rebuilder.server.ts:205,229`). `grep -rni guardrail app/features app/routes app/ui`
returns three hits, all in project creation. `app/app.css:1715` is an orphan
`/* guardrails */` section header with no rules under it — c1acf2c pruned the mock's
`.guard-row`/`.stepper` rules as unused and left the comment.

Why unclear: the mock shipped the CSS and the data (`design/html-app/app/data.js:659-665`,
copied character-for-character into `templates.ts`) but **never rendered the panel** — no
`.jsx` under `design/html-app` uses those classes, and `policy.jsx:180-210` has only three
panels. So the built app matches the mock's rendered state, and the "control pattern" is
aspirational rather than a designed screen the port dropped. `prd.md:188` lists the five
guardrails as MVP *behavior*, and that behavior is delivered.

Impact if left: five governance rules silently drop and rewrite agent output — including a
40-event compression threshold — with no screen that shows they exist or that they can be
tuned.

Would settle it: an owner ruling on whether Policy gains a fourth "Anti-noise guardrails"
panel (per-guardrail toggles + threshold stepper), or whether always-on-and-enforced is the
intended MVP shape — in which case the only fix is deleting the dead comment at
`app/app.css:1715`.

#### U-3 · pointer — the `evidence:` block

Reported as **D-26** (LOW drift, no producer). The verification split on the verdict: one
pass rated it UNCLEAR because the *replacement* mechanism (evidence-separation → run logs)
is documented; both agree the leftover machinery is un-ruled. The settling question is in
D-26's recommendation: wire it or delete it.

---

## 5. Appendix — refuted claims (do not re-raise)

| id | one-line reason it does not stand |
| --- | --- |
| FR15 | The operator *is* the underspecified-task gate (`operator-toolkit.server.ts:90`, `operator-run.server.ts:1244`, `templates.ts:43`), and it passed live in pass-12 UC-03 and pass-13 UC-20; the advisory capability rows are ruling-7 and test-locked. |
| FR9 | The 11 advisory `group: null` capabilities are excluded from the profile editor entirely (`capability-catalog.ts:42`), so an admin cannot define them; deliberate per ruling 7 with a regression test. |
| FR8 | `set_goal` *does* append a typed event — `type: "note"` (`operator-actions.server.ts:891-903`), a first-class member of `TIMELINE_EVENT_TYPES`; so `append-typed-events` is not a mislabel. |
| FR18 | `operator: null` in triage is documented twice (`task-actions.server.ts:441` "contracts §1.1"; `file-formats.md:131` "ruling 16") and the field has only two readers, neither a gate. |
| FR31 | Per-file changed paths ARE surfaced — `summarizeChanges` (`wire-format.server.ts:277-281`), `summarizeToolInput` (`:172-181`), and delivery's `git status --porcelain` list (`push-workspace.server.ts:209-256`). |
| FR34 | No call site passes a credential to the logger; call-site redaction is deliberate with a dedicated helper (`safeCodexError`, `codex-runtime.server.ts:282-288`) and no leak path exists (the PAT never enters argv or the remote URL). |
| PRD-7 | The PRD defines operator persistence as canonical re-anchor, which `operatorSnapshot` + `get_task` implement; per-turn thread ids are not a divergence. (Residual: the "resumed" run-console boundary label is inaccurate for operator groups.) |
| PRD-13 | The KB/skills/MCP hosting surface is specified by the design mock (`design/CONVERSATION-SUMMARY.md:165-167`, `kb-browser.jsx:1-5`), and in-app doc authoring is pass-13 owner ruling 3. |
| ARCH-3 | `architecture.md` states only one directional ban (`:872`, ui↛features); every server→feature import targets a documented client-safe type/pure module, and 10 of 15 are `import type`. |
| ARCH-8 | `:252` defers an *external* queue and a *separate worker*; the app has neither, and every in-process job carries a finding-id docstring (P11-14, F10-29, O-3, R-D, B9). |
| ARCH-9 | Audit retention is F10-29 with an explaining docstring, a regression test, and a Phase-2 deferral of exports; residual is a one-clause docstring inaccuracy. |
| ARCH-12 | The cited JSON routes already return `{ data }` / `{ error: { code, message } }`; `error-response.server.ts` was deleted with "zero importers"; route actions are exempt per `:505`. |
| UX-3 | The "agent working" pill replacing a triage `input_required` is deliberate (commit e39c758 "Task state honesty" + `task-detail-page.tsx:1234` + `task-actions.server.ts:2603-2610`). |
| UX-6 | The packet and next-action panels stay above the timeline at ≤1100px; the side-rail variant is spec-sanctioned (`:633`) and the collapse order is verbatim from the mock. |
| UX-9 | All four readiness states keep distinct pills; "continuity error" names the one spec state the four run-failure classes share, and the cause is in the footer beside a Retry button. |
| MOCK-2 | The mock's GitHub-page string is itself an unconditional literal (`github.jsx:38`), not derived from the toggle — the app is a faithful port. (The inert toggle is reported as D-5.) |
| MOCK-8 | The mock keeps the project description as an independently editable textarea and never regenerates it after stage edits; the app matches, and the field is user-editable. |
| MOCK-10 | `data-comment-anchor` is consumed by nothing in the mock tooling either; the app is a faithful port and the three anchors are mutually exclusive at runtime. |
| MOCK-11 | `#e8a800` IS a token (`--pin-star`), the accent is painted on a `var(--fg)` mark so it *does* invert, and the design system reserves semantic tokens for state, not identity marks. |
| DOC-13 | The `.env.example` placeholders satisfy the schema the same file documents; "fill in the two secrets" is an instruction to the operator, not an app-side guarantee. |
